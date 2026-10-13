/**
 * The funds-and-standing module (RFC-004 Part A) behind the C05 v1 in-process interface.
 *
 * AM-I1 scope (S-ACCT-S-MONEY plan): `admit` for `New` with check 1 and check 4 only;
 * `apply(Intake)`, `apply(Decided)`; `standing`; F1 for a balance from a movement; F4 snapshot
 * for an active key; F10. Other inputs throw `NotInThisIncrement`.
 *
 * Rules of this file (C05 "Calls of the module", RFC-004 §A10):
 * - No I/O, no clock, no randomness. Time comes only from `ctx.ts`.
 * - Integer arithmetic only (`bigint`). Each charge line is rounded down once (POL-11).
 * - Reservations are iterated in (start, id) order, keys in id order.
 */
import type {
  ApplyResult, Ask, Checked, Ctx, DueTick, F1, F4, FundsModule, FundsState, HeadroomAnswer, HlcTimestamp, Input,
  KeyId, LedgerPosition, Micros, Outcomes, PrincipalCtx, RateCheckResult, RateWindows, ResumeQuote, RulesVersion,
  Schedule, Standing, Verdict,
} from '../contracts/c05.ts';

export class NotInThisIncrement extends Error {}

/** Parameters of one rules version (F10). A new version never changes an older one (C05 "Versioning"). */
interface Rules { coverageWindowMin: bigint; lowBalanceWarningFloor: Micros }
const RULES: Record<RulesVersion, Rules> = {
  'funds-rules-1': { coverageWindowMin: 1_440n, lowBalanceWarningFloor: 1_000_000n },
};
export const DEFAULT_RULES: RulesVersion = 'funds-rules-1';

interface ResRow {
  id: string;
  schedule: Schedule;
  start: bigint;
  end: bigint | null;
  p: bigint;              // first unposted minute
  H: Micros;              // actual hold
  holdKind: 'Funds' | 'Credit';
  key?: KeyId;
}
interface PendRow { h: Micros; mbps: bigint; key?: KeyId; holdKind: 'Funds' | 'Credit' }
interface KeyRow { status: 'active' | 'revoked'; version: bigint; spendLimit?: Micros; inflightLimit?: bigint; rateLimit?: bigint }

interface State {
  rules: RulesVersion | null;
  bal: Micros;
  w: Micros;
  ledgerPos: LedgerPosition | null;
  feedSeen: string[];
  cl: Micros;
  mode: 'prepaid' | 'credit';
  reservations: Record<string, ResRow>;
  pending: Record<string, PendRow>;
  keys: Record<string, KeyRow>;
  kyb: { status: 'passed' | 'failed' | 'withdrawn' | 'none'; version: bigint };
  standing: Standing;
  since: HlcTimestamp | null;
  stdSeq: bigint;
  od: { invoice: string; unpaid: Micros }[];
}

const asState = (s: FundsState): State => s as unknown as State;
const asFunds = (s: State): FundsState => s as unknown as FundsState;

/** The state of an account that has no entry yet. */
export function emptyFundsState(): FundsState {
  const s: State = {
    rules: null, bal: 0n, w: 0n, ledgerPos: null, feedSeen: [], cl: 0n, mode: 'prepaid',
    reservations: {}, pending: {}, keys: {}, kyb: { status: 'none', version: 0n },
    standing: 'active', since: null, stdSeq: 0n, od: [],
  };
  return asFunds(s);
}

function rulesOf(ctx: Ctx): Rules {
  const r = RULES[ctx.rules];
  if (!r) throw new Error(`unknown funds rules version ${ctx.rules}`);
  return r;
}

const requestKey = (r: { partition: string; sequence: bigint }): string => `${r.partition}:${r.sequence}`;
const MICRO_PER_PICO_DIVISOR = 1_000_000n;

// ---------- Coverage (RFC-004 §A3) ----------

function scheduleStart(sc: Schedule): bigint {
  let s: bigint | null = null;
  for (const p of sc.parts) if (s === null || p.interval.start < s) s = p.interval.start;
  if (s === null) throw new Error('schedule has no part');
  return s;
}

function scheduleEnd(sc: Schedule): bigint | null {
  if (sc.end !== undefined) return sc.end;
  let e: bigint | null = -1n;
  for (const p of sc.parts) {
    if (p.interval.end === null) return null;
    if (e === null || p.interval.end > e) e = p.interval.end;
  }
  return e;
}

/** Price of a part at minute m: the latest recorded step in force at m, else the locked price. */
function priceAt(sc: Schedule, lockedPrice: bigint, m: bigint): bigint {
  let price = lockedPrice;
  let best: bigint | null = null;
  for (const st of sc.priceSteps) {
    if (st.effectiveMinute <= m && (best === null || st.effectiveMinute >= best)) { best = st.effectiveMinute; price = st.price; }
  }
  return price;
}

function rateAt(pieces: { from: bigint; mbps: bigint }[], m: bigint): bigint {
  let r = 0n;
  for (const pc of pieces) if (pc.from <= m) r = pc.mbps;
  return r;
}

/** a_r(m): the exact sum of rate × price over the parts active at m, rounded down once to the µ (POL-11). */
function chargeAt(sc: Schedule, m: bigint): Micros {
  let pico = 0n;
  for (const p of sc.parts) {
    if (m < p.interval.start || (p.interval.end !== null && m >= p.interval.end)) continue;
    pico += rateAt(p.rate, m) * priceAt(sc, p.lockedPrice, m);
  }
  return pico / MICRO_PER_PICO_DIVISOR;
}

/** cov(x, y) = Σ a_r(m) over m in [x, y) ∩ [start, end). Evaluated piecewise between change points. */
export function coverage(sc: Schedule, x: bigint, y: bigint): Micros {
  const start = scheduleStart(sc);
  const end = scheduleEnd(sc);
  const lo = x > start ? x : start;
  const hi = end === null ? y : (y < end ? y : end);
  if (hi <= lo) return 0n;
  const points = new Set<bigint>([lo, hi]);
  const add = (m: bigint): void => { if (m > lo && m < hi) points.add(m); };
  for (const p of sc.parts) {
    add(p.interval.start);
    if (p.interval.end !== null) add(p.interval.end);
    for (const pc of p.rate) add(pc.from);
  }
  for (const st of sc.priceSteps) add(st.effectiveMinute);
  const sorted = [...points].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let sum = 0n;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i] as bigint;
    const b = sorted[i + 1] as bigint;
    sum += chargeAt(sc, a) * (b - a);
  }
  return sum;
}

/** R_r = max(C_r, fee part), with C_r = cov(p_r, p_r + CW). AM-I1 has no partner fee: the fee part is 0. */
function requiredHold(sc: Schedule, p: bigint, rules: Rules): Micros {
  return coverage(sc, p, p + rules.coverageWindowMin);
}

// ---------- Quantities (RFC-004 §A3) ----------

function sortedReservations(s: State): ResRow[] {
  return Object.values(s.reservations).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function fundsHeld(s: State): Micros {
  let f = 0n;
  for (const r of sortedReservations(s)) f += r.H;
  for (const k of Object.keys(s.pending).sort()) f += (s.pending[k] as PendRow).h;
  return f;
}

function creditHolds(s: State): Micros {
  let f = 0n;
  for (const r of sortedReservations(s)) if (r.holdKind === 'Credit') f += r.H;
  for (const k of Object.keys(s.pending).sort()) { const q = s.pending[k] as PendRow; if (q.holdKind === 'Credit') f += q.h; }
  return f;
}

/** Usage exposure X. F2 and F3 come in later increments, so X is 0 in AM-I1. */
function usageExposure(_s: State): Micros {
  return 0n;
}

function headroom(s: State): Micros {
  return s.bal - fundsHeld(s) - usageExposure(s) + s.cl;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return a >= 0n ? (a + b - 1n) / b : a / b;
}

function oneWindowCharges(s: State, rules: Rules): Micros {
  let c = 0n;
  for (const r of sortedReservations(s)) c += coverage(r.schedule, r.p, r.p + rules.coverageWindowMin);
  return c;
}

function lowBalanceWarning(s: State, rules: Rules): Micros {
  const q = ceilDiv(oneWindowCharges(s, rules), 4n);
  return q > rules.lowBalanceWarningFloor ? q : rules.lowBalanceWarningFloor;
}

function resumeQuote(s: State, rules: Rules): ResumeQuote {
  let full = 0n;
  for (const r of sortedReservations(s)) full += requiredHold(r.schedule, r.p, rules);
  let pend = 0n;
  for (const k of Object.keys(s.pending).sort()) pend += (s.pending[k] as PendRow).h;
  const hFull = s.bal - full - pend - usageExposure(s) + s.cl;
  let od = 0n;
  for (const o of s.od) od += o.unpaid;
  const gap = lowBalanceWarning(s, rules) - (hFull + od);
  const rh = gap > 0n ? gap : 0n;
  const total = s.w + od + rh;
  return {
    total, writtenOff: s.w, overdue: s.od.map((o) => ({ invoice: o.invoice, unpaid: o.unpaid })),
    headroomPart: rh, headroomAfter: hFull + total - s.w,
  };
}

function noOutcomes(): Outcomes {
  return { holdChanges: [], notices: [], alerts: [], outbox: [] };
}

function clone(s: State): State {
  return structuredClone(s);
}

// ---------- The module ----------

export const fundsModule: FundsModule & { keyStatus(s: FundsState, key: KeyId): 'active' | 'revoked' | 'absent' } = {
  /** AM-I1: the revocation read only. The rate windows come in ACCT-I7. See `keyStatus` (contract issue). */
  rateCheck(_soft: RateWindows, _nowMs: bigint, _who: PrincipalCtx): RateCheckResult {
    return { kind: 'Accept' };
  },

  /**
   * Key status as applied by F4. C05 `rateCheck` has no FundsState parameter, so it cannot read the
   * applied key status that JR-1 tells it to read. The booking module calls this read instead.
   */
  keyStatus(s: FundsState, key: KeyId): 'active' | 'revoked' | 'absent' {
    const k = asState(s).keys[key];
    return k ? k.status : 'absent';
  },

  admit(fs: FundsState, ctx: Ctx, ask: Ask): Verdict {
    const s = asState(fs);
    const rules = rulesOf(ctx);
    if (ask.kind !== 'New') throw new NotInThisIncrement(`admit(${ask.kind}) is in AM-I14`);
    const h = headroom(s);
    const checked: Checked = { headroom: h };
    // Check 1: the request adds something and the account is suspended.
    if (s.standing === 'suspended') return { kind: 'Refuse', checked, reason: { kind: 'Suspended', ra: resumeQuote(s, rules) } };
    // Checks 2, 3 and 5 come in AM-I9.
    // Check 4: h < x, with x = R_r of the requested reservation as if confirmed now (§A5.2).
    const x = requiredHold(ask.scheduleAfter, scheduleStart(ask.scheduleAfter), rules);
    if (h < x) {
      const min = x - h;
      return { kind: 'Refuse', checked, reason: { kind: 'InsufficientFunds', min, minPlusLbw: min + lowBalanceWarning(s, rules) } };
    }
    return { kind: 'Admit', hold: x, holdKind: s.mode === 'credit' ? 'Credit' : 'Funds', mbps: ask.mbps, checked };
  },

  apply(fs: FundsState, ctx: Ctx, input: Input): ApplyResult {
    const rules = rulesOf(ctx);
    const s = clone(asState(fs));
    const out = noOutcomes();
    switch (input.kind) {
      case 'Intake': {
        if (input.verdict.kind === 'Admit') {
          const v = input.verdict;
          const row: PendRow = { h: v.hold, mbps: v.mbps, holdKind: v.holdKind };
          if (input.ask.key !== undefined) row.key = input.ask.key;
          s.pending[requestKey(input.request)] = row;
          out.holdChanges.push({ target: { request: input.request }, from: 0n, to: v.hold, holdKind: v.holdKind, state: 'Requested' });
        }
        break;
      }
      case 'Decided': {
        const k = requestKey(input.request);
        const q = s.pending[k];
        if (!q) throw new Error(`Decided for request ${k} that holds nothing`);
        delete s.pending[k];
        out.holdChanges.push({ target: { request: input.request }, from: q.h, to: 0n, holdKind: q.holdKind, state: 'Released' });
        if (input.outcome.kind === 'Confirmed') {
          const sc = input.outcome.schedule;
          const start = scheduleStart(sc);
          const H = requiredHold(sc, start, rules);
          const row: ResRow = { id: input.outcome.reservation, schedule: sc, start, end: scheduleEnd(sc), p: start, H, holdKind: q.holdKind };
          if (q.key !== undefined) row.key = q.key;
          s.reservations[row.id] = row;
          out.holdChanges.push({ target: { reservation: row.id }, from: 0n, to: H, holdKind: q.holdKind, state: 'Rolling' });
        }
        break;
      }
      case 'F1':
        applyF1(s, input);
        break;
      case 'F4':
        applyF4(s, input, out);
        break;
      case 'F10':
        s.rules = input.rules;
        break;
      default:
        throw new NotInThisIncrement(`apply(${input.kind}) is not in AM-I1`);
    }
    void rules;
    return { kind: 'Applied', state: asFunds(s), outcomes: out };
  },

  due(_fs: FundsState): DueTick[] {
    return [];
  },

  answer(fs: FundsState, ctx: Ctx, who: PrincipalCtx): HeadroomAnswer {
    const s = asState(fs);
    const rules = rulesOf(ctx);
    const h = headroom(s);
    const ledger: LedgerPosition = s.ledgerPos ?? { ledgerPartition: '', sequence: 0n, commitTs: { wallNanos: 0n, logical: 0 } };
    const m = ctx.ts.wallNanos / 60_000_000_000n;
    let accrued = 0n;
    for (const r of sortedReservations(s)) if (m > r.p) accrued += coverage(r.schedule, r.p, m);
    const ans: HeadroomAnswer = {
      position: { log: ctx.pos, ts: ctx.ts, ledger },
      evaluatedAt: ctx.ts,
      headline: h,
      headlineKind: 'account',
      items: {
        balance: s.bal, fundsHeld: fundsHeld(s), creditHolds: creditHolds(s), usageExposure: [],
        accruedNotPosted: accrued, creditLimit: s.cl, headroom: h,
      },
      standing: { standing: s.standing, causes: [] },
      lowBalanceThreshold: lowBalanceWarning(s, rules),
    };
    void who;
    return ans;
  },

  standing(fs: FundsState): { standing: Standing; since: HlcTimestamp | null; stdSeq: bigint } {
    const s = asState(fs);
    return { standing: s.standing, since: s.since, stdSeq: s.stdSeq };
  },
};

function feedId(f: { source: string; partition: string; seq: bigint }): string {
  return `${f.source}|${f.partition}|${f.seq}`;
}

/** F1: Bal, W and the ledger position. An event already applied by its feed identity is a no-op. */
function applyF1(s: State, f: F1): void {
  const fresh = f.feed.filter((p) => !s.feedSeen.includes(feedId(p)));
  if (fresh.length === 0) return;
  for (const p of fresh) s.feedSeen.push(feedId(p));
  s.feedSeen.sort();
  // Bal and W are absolute values at the ledger position. A lower position never moves them back.
  if (s.ledgerPos === null || f.ledgerPos.sequence > s.ledgerPos.sequence) {
    s.ledgerPos = f.ledgerPos;
    s.bal = f.balance;
    s.w = f.writtenOffOwed;
  }
}

/** F4: key status and KYB as applied. AM-I1 applies the snapshot source; push and catch-up are AM-I9. */
function applyF4(s: State, f: F4, out: Outcomes): void {
  if (f.source !== 'snapshot') throw new NotInThisIncrement('F4 push and catch-up are AM-I9');
  const revoked: KeyId[] = [];
  const inSnapshot = new Set<string>();
  for (const k of [...f.keys].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    inSnapshot.add(k.key);
    const cur = s.keys[k.key];
    if (cur && k.version <= cur.version) continue;
    if (cur?.status === 'revoked') continue;           // revoked is terminal
    const row: KeyRow = { status: k.status, version: k.version };
    if (k.keySpendLimit !== undefined) row.spendLimit = k.keySpendLimit;
    if (k.keyInflightLimit !== undefined) row.inflightLimit = k.keyInflightLimit;
    if (k.keyRateLimit !== undefined) row.rateLimit = k.keyRateLimit;
    s.keys[k.key] = row;
    if (k.status === 'revoked') revoked.push(k.key);
  }
  for (const key of Object.keys(s.keys).sort()) {
    const cur = s.keys[key] as KeyRow;
    if (!inSnapshot.has(key) && cur.status === 'active') {
      cur.status = 'revoked';
      revoked.push(key);
      out.alerts.push({ code: 'KEY_ABSENT_FROM_SNAPSHOT', key });
    }
  }
  const kybVersion = f.kyb.version ?? 0n;
  if (kybVersion >= s.kyb.version) s.kyb = { status: f.kyb.status, version: kybVersion };
  if (revoked.length > 0) out.revokedKeys = revoked.sort();
}

/** Headroom of the account, for tests and the status reader. */
export function headroomOf(fs: FundsState): Micros {
  return headroom(asState(fs));
}

/** The hold of one reservation (H_r), for tests and the status reader. */
export function reservationHold(fs: FundsState, reservation: string): Micros | undefined {
  return asState(fs).reservations[reservation]?.H;
}

export function balanceOf(fs: FundsState): Micros {
  return asState(fs).bal;
}

export function pendingHold(fs: FundsState, request: { partition: string; sequence: bigint }): Micros | undefined {
  return asState(fs).pending[requestKey(request)]?.h;
}

/** Whether the module would see this F4 snapshot as a change of the account's applied identity state. */
export function snapshotDiffers(fs: FundsState, f: Extract<F4, { source: 'snapshot' }>): boolean {
  const s = asState(fs);
  const keys = new Set(f.keys.map((k) => k.key));
  for (const k of f.keys) {
    const cur = s.keys[k.key];
    if (!cur || (k.version > cur.version && cur.status !== 'revoked')) return true;
  }
  for (const [key, cur] of Object.entries(s.keys)) if (!keys.has(key) && cur.status === 'active') return true;
  return (f.kyb.version ?? 0n) > s.kyb.version || ((f.kyb.version ?? 0n) === s.kyb.version && f.kyb.status !== s.kyb.status);
}

export function rulesVersionOf(fs: FundsState): RulesVersion | null {
  return asState(fs).rules;
}
