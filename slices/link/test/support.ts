/**
 * Test harness of S-LINK I1 (S-LINK plan §2 "Test harness"):
 * - a seeded random generator (mulberry32, as the prior `test/helpers.ts`);
 * - the runtime double with the link owner attached;
 * - the recorded account-owner stub, which sends C02 commands with C01 envelopes;
 * - the per-minute oracle (T-01), one cell per minute, for hold, convert and release, extended with POL-05
 *   waiting (I3): waiters in priority order, and the scan of each release and conversion.
 */
import type { CommandEnvelope, HlcTs, NotificationOut, OwnerRuntime, PartitionKey } from '@share/owner-runtime';
import { hlcToWallMs, utf8 } from '@share/owner-runtime';
import { RuntimeDouble } from '@share/owner-runtime/testing';
import type {
  ConvertCmd, ConvertReply, CounterOffer, HoldCmd, HoldReply, LinkCommand, LinkPolicy, Outcome, ReleaseCmd, ReleaseReply, RequestId, Window,
} from '../src/index.ts';
import { declaration, DEFAULT_POLICY, digest, LINK_KIND, LinkOwner, requestKey, wallNs, type DecidedRecord, type LinkOwnerOptions, type LogReader } from '../src/index.ts';

// ---------------- random ----------------

export function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

// ---------------- time ----------------

/** The scenarios say "it is 09:00" on one UTC day. The double's clock starts there. */
export const DAY_MS = Date.UTC(2026, 2, 2);
export const START_MS = DAY_MS + 9 * 3_600_000;
export const DAY_MIN = DAY_MS / 60_000;
/** The minute index of hh:mm on the scenario day. */
export const M = (hh: number, mm = 0): number => DAY_MIN + hh * 60 + mm;

// ---------------- harness on the runtime double ----------------

export interface Harness {
  rt: RuntimeDouble;
  owner: LinkOwner;
  decided: DecidedRecord[];
  link: string;
  stub: AccountStub;
  /** The waiting-port notifications that the owner pushed after each commit (`onNotify`), in order. */
  pushed: NotificationOut[];
}

export function doubleLogReader(rt: RuntimeDouble): LogReader {
  return async (partition, after) => rt.log(partition)
    .filter((e) => e.seq > after)
    .map((e) => ({ seq: e.seq, ts: e.ts, epoch: e.epoch, kind: e.entry.kind, payload: e.entry.payload }));
}

export async function harness(opts: { link?: string; capacity?: number; policy?: LinkPolicy; owner?: Partial<LinkOwnerOptions> } = {}): Promise<Harness> {
  const link = opts.link ?? 'L1';
  const rt = new RuntimeDouble({ declaration, startMs: START_MS });
  const decided: DecidedRecord[] = [];
  const pushed: NotificationOut[] = [];
  const owner = new LinkOwner(rt, {
    readLog: doubleLogReader(rt),
    onReply: (l) => rt.recordReply(l),
    onDecided: (d) => decided.push(d),
    onNotify: (n) => pushed.push(n),
    ...opts.owner,
  });
  rt.attach(owner);
  const r = await owner.register(link, opts.capacity ?? 10, opts.policy ?? DEFAULT_POLICY);
  if (!('result' in r) || r.result !== 'INITIALISED') throw new Error(`register failed: ${JSON.stringify(r)}`);
  return { rt, owner, decided, link, stub: new AccountStub(rt, owner, link), pushed };
}

// ---------------- recorded account-owner stub ----------------

let seqCounter = 1n;

export interface HoldArgs {
  rate: number; window: Window; wait?: boolean;
  /** Remaining deadline in ms from the runtime's present time. Default 20 s. */
  deadlineInMs?: number;
  account?: string; request?: RequestId; leg?: string;
}

/**
 * The C02 consumer side, as the account owner would send it (S-LINK plan §1 rule 4). Each command has
 * a C01 envelope routed by `route()`. The stub keeps the commands it sent, so a test can send one again.
 */
export class AccountStub {
  readonly rt: OwnerRuntime;
  readonly owner: LinkOwner;
  readonly link: string;
  generation = 0;
  epoch = 1n;

  constructor(rt: OwnerRuntime, owner: LinkOwner, link: string) {
    this.rt = rt; this.owner = owner; this.link = link;
  }

  newRequest(account = 'b1'): RequestId {
    seqCounter += 1n;
    return { partition: utf8(account), seq: seqCounter };
  }

  envelope(account: string | PartitionKey, overrides: Partial<CommandEnvelope['routedTo']> = {}): CommandEnvelope {
    const partition = utf8(this.link);
    const route = this.rt.route(LINK_KIND, partition);
    const acct = typeof account === 'string' ? utf8(account) : account;
    return {
      routedTo: { kind: LINK_KIND, slot: route.slot, generation: route.generation, epoch: route.epoch, ...overrides },
      sender: { kind: 'account', partition: acct, generation: this.generation, epoch: this.epoch },
      identity: utf8(`env:${Math.random()}`),
    };
  }

  holdCmd(a: HoldArgs): HoldCmd {
    const account = a.account ?? 'b1';
    const request = a.request ?? this.newRequest(account);
    const now = hlcToWallMs(this.rt.now().ts);
    const deadline = now + (a.deadlineInMs ?? 20_000);
    return {
      link: this.link, receiverPartition: this.link, request, account: utf8(account), leg: a.leg ?? 'leg-1',
      holdKind: { kind: 'booking' }, rateMbps: a.rate, window: a.window, deadline, commitFence: deadline - 420,
      requestAge: this.rt.now().ts, wait: a.wait ?? false, receiptMinute: Math.floor(now / 60_000), policyVersion: 1n,
    };
  }

  hold(cmd: HoldCmd, env?: CommandEnvelope): Promise<HoldReply> {
    return this.owner.hold(env ?? this.envelope(cmd.account), cmd);
  }

  convertCmd(hold: HoldCmd, attempt = 1, part = `p-${requestKey(hold.request)}`): ConvertCmd {
    return {
      link: this.link, receiverPartition: this.link, request: hold.request, attempt,
      reservation: `r-${requestKey(hold.request)}`, leg: hold.leg, part,
      createdBy: { partition: hold.account, seq: hold.request.seq + 1000n }, decisionTime: this.rt.now().ts,
    };
  }

  convert(cmd: ConvertCmd, env?: CommandEnvelope): Promise<ConvertReply> {
    return this.owner.convert(env ?? this.envelope(cmd.request.partition), cmd);
  }

  releaseCmd(request: RequestId, deadline: number, reason: ReleaseCmd['reason'] = 'REJECTED'): ReleaseCmd {
    return { link: this.link, receiverPartition: this.link, request, deadline, reason, decisionTime: this.rt.now().ts };
  }

  release(cmd: ReleaseCmd, env?: CommandEnvelope): Promise<ReleaseReply> {
    return this.owner.release(env ?? this.envelope(cmd.request.partition), cmd);
  }

  /** Book and confirm: hold, then convert. Returns the hold reply and the convert reply. */
  async book(a: HoldArgs): Promise<{ hold: HoldReply; convert?: ConvertReply; cmd: HoldCmd }> {
    const cmd = this.holdCmd(a);
    const hold = await this.hold(cmd);
    if ('result' in hold && hold.result === 'HELD') return { hold, convert: await this.convert(this.convertCmd(cmd)), cmd };
    return { hold, cmd };
  }
}

export function resultOf(r: unknown): string {
  if (typeof r === 'object' && r !== null) {
    const o = r as Record<string, unknown>;
    if ('result' in o) return o['result'] === 'REFUSED' ? `REFUSED:${JSON.stringify(o['reason'])}` : String(o['result']);
    if ('code' in o) return String(o['code']);
  }
  return JSON.stringify(r);
}

// ---------------- per-minute oracle (T-01) ----------------

interface OracleRequest {
  madeBy: 'hold' | 'release';
  state: 'HELD' | 'WAITING' | 'REFUSED' | 'RELEASED' | 'CONVERTED';
  holdDigest?: string; holdOutcome?: Outcome; convertDigest?: string; convertAttempt?: number; convertOutcome?: Outcome;
  rate?: number; window?: Window; deadline?: number; tombstoneUntil?: number;
}

/** A waiting-port notice as the oracle expects it: request key, kind, attempt and content. */
export interface OracleNotice { request: string; kind: string; attempt: number; aheadDeadline?: number; counterOffer?: CounterOffer }

/** The same form for a notice that the link logged (`LoggedPayload.notices`), so that the two compare. */
export function noticeForm(n: { request: RequestId; kind: string; attempt: number; aheadDeadline?: number; counterOffer?: CounterOffer }): OracleNotice {
  return {
    request: requestKey(n.request), kind: n.kind, attempt: n.attempt,
    ...(n.aheadDeadline === undefined ? {} : { aheadDeadline: n.aheadDeadline }),
    ...(n.counterOffer === undefined ? {} : { counterOffer: n.counterOffer }),
  };
}

/**
 * POL-02 priority, written apart from the link's code: the older `request_age` first (the HLC as a wall part
 * and a logical part), ties by the account partition in hex, then the request sequence.
 */
export function oraclePriority(a: HoldCmd, b: HoldCmd): number {
  const [aw = '0', al = '0'] = a.requestAge.split('.');
  const [bw = '0', bl = '0'] = b.requestAge.split('.');
  const cmp = (x: bigint, y: bigint): number => (x < y ? -1 : x > y ? 1 : 0);
  const age = cmp(BigInt(aw), BigInt(bw)) || cmp(BigInt(al), BigInt(bl));
  if (age !== 0) return age;
  const ap = Buffer.from(a.request.partition).toString('hex');
  const bp = Buffer.from(b.request.partition).toString('hex');
  if (ap !== bp) return ap < bp ? -1 : 1;
  return cmp(a.request.seq, b.request.seq);
}

/**
 * One cell per minute over [0, n) minutes from `base`. Open-ended windows end at n. Every finite window of a
 * test lies in [base, base + n). After n, `occ_all` has the value `allTail`: the sum of the open-ended holds.
 *
 * Counter-offers (T-04). The largest rate is C − the largest cell over the window. The earliest window is
 * found twice: by brute force (the first start t ≥ s at which every cell of [t, t + L) fits), and by the
 * jump search of RFC-001 §4.2 over the cells, which also counts the steps. The oracle throws if the two
 * differ. The step count decides "not found before t" against the per-refusal and per-batch budgets, with
 * the per-batch cache of the RFC. A new `ts` starts a new batch.
 *
 * Waiting (POL-05, RFC-001 §4.3). A hold with `wait = true` that fits committed but not held capacity waits,
 * with the latest blocker deadline. A release of a hold and a conversion scan the waiters that overlap the
 * window, in priority order, with no step budget: the link's `Tick` continuations are in the same batch, before
 * the next command, so they give the same result. Each notice goes to `notices`, in order.
 */
export class MinuteOracle {
  readonly firm: Int32Array;
  readonly all: Int32Array;
  private readonly req = new Map<string, OracleRequest>();
  readonly base: number;
  readonly n: number;
  readonly capacity: number;
  readonly releaseGraceMs: number;
  readonly policy: LinkPolicy;
  private allTail = 0;
  /** Changes on each change of `all` (the cache key of a counter-offer). */
  private allVersion = 0;
  private batchTs: HlcTs | undefined;
  private batchLeft = 0;
  private readonly cache = new Map<string, { version: number; earliest: CounterOffer['earliest'] }>();
  /** The waiters in priority order. */
  private waiters: Array<{ key: string; b: HoldCmd; ahead: number }> = [];
  /** The waiting-port notices, in the order that the link must send them. */
  readonly notices: OracleNotice[] = [];

  constructor(base: number, n: number, capacity: number, policy: LinkPolicy = DEFAULT_POLICY) {
    this.base = base; this.n = n; this.capacity = capacity; this.policy = policy; this.releaseGraceMs = policy.releaseGraceMs;
    this.firm = new Int32Array(n);
    this.all = new Int32Array(n);
  }

  /** The value of `occ_all` at minute m. */
  allAt(m: number): number {
    const i = m - this.base;
    if (i < 0) return 0;
    return i >= this.n ? this.allTail : this.all[i] as number;
  }

  /** The counter-offer that the link must give to the refused hold `b` in the batch at `ts`. */
  counterOffer(b: HoldCmd, ts: HlcTs): CounterOffer {
    if (ts !== this.batchTs) {
      this.batchTs = ts;
      this.batchLeft = this.policy.counterofferBatchSteps;
      this.cache.clear();
    }
    const free = this.capacity - this.peak(this.all, b.window);
    const largestRateMbps = free < this.policy.rateMinMbps ? 0 : free;
    const length = b.window.end === null ? null : b.window.end - b.window.start;
    const h = oracleHorizon(b.receiptMinute, this.policy.sellingHorizonMonths);
    const key = `${b.window.start}|${length}|${b.rateMbps}|${h}`;
    const hit = this.cache.get(key);
    if (hit && hit.version === this.allVersion) return { largestRateMbps, earliest: hit.earliest };
    const limit = Math.min(this.policy.counterofferSteps, this.batchLeft);
    const r = this.earliest(b.window.start, length, b.rateMbps, h, limit);
    this.batchLeft -= r.steps;
    this.cache.set(key, { version: this.allVersion, earliest: r.value });
    return { largestRateMbps, earliest: r.value };
  }

  /** The earliest window by the jump search over the cells, checked against brute force. */
  earliest(s: number, length: number | null, b: number, h: number, limit: number): { value: CounterOffer['earliest']; steps: number } {
    const theta = this.capacity - b;
    const above = (m: number): boolean => this.allAt(m) > theta;
    const end = this.base + this.n;   // from here on, every minute has the value allTail
    let r: { value: CounterOffer['earliest']; steps: number };
    if (limit < 1) return { value: { notFoundBefore: s }, steps: 0 };
    if (length === null) {
      let last: number | null = null;
      if (above(end)) r = { value: { none: true }, steps: 1 };
      else {
        for (let m = end - 1; m >= this.base; m--) if (above(m)) { last = m; break; }
        const t = last === null || last + 1 < s ? s : last + 1;
        r = { value: t < h ? { window: { start: t, end: null } } : { none: true }, steps: 1 };
      }
    } else {
      const firstWhere = (from: number, want: boolean): number | null => {
        for (let m = from; m < end; m++) if (above(m) === want) return m;
        return above(end) === want ? Math.max(from, end) : null;
      };
      let t = s;
      let steps = 0;
      r = { value: { notFoundBefore: t }, steps: 0 };
      for (;;) {
        if (steps >= limit) { r = { value: { notFoundBefore: t }, steps }; break; }
        steps += 1;
        if (t + length > h) { r = { value: { none: true }, steps }; break; }
        const x = firstWhere(t, true);
        if (x === null || x >= t + length) { r = { value: { window: { start: t, end: t + length } }, steps }; break; }
        const next = firstWhere(x, false);
        if (next === null) { r = { value: { none: true }, steps }; break; }
        t = next;
      }
    }
    if (!('notFoundBefore' in r.value)) {
      const brute = this.bruteEarliest(s, length, b, h);
      if (JSON.stringify(brute) !== JSON.stringify(r.value)) {
        throw new Error(`oracle self-check: jump ${JSON.stringify(r.value)} brute ${JSON.stringify(brute)} (s ${s}, L ${length}, b ${b})`);
      }
    }
    return r;
  }

  /** The first start t ≥ s whose window of the length fits at every minute, within the horizon h. */
  bruteEarliest(s: number, length: number | null, b: number, h: number): CounterOffer['earliest'] {
    const end = this.base + this.n;
    const fits = (m: number): boolean => this.allAt(m) + b <= this.capacity;
    if (length === null) {
      if (!fits(end)) return { none: true };
      let t = s;
      for (let m = Math.max(s, this.base); m < end; m++) if (!fits(m)) t = m + 1;
      return t < h ? { window: { start: t, end: null } } : { none: true };
    }
    // badBefore[i]: the number of minutes in [base, base + i) that do not fit.
    const badBefore = new Int32Array(this.n + 1);
    for (let i = 0; i < this.n; i++) badBefore[i + 1] = (badBefore[i] as number) + (fits(this.base + i) ? 0 : 1);
    const clamp = (m: number): number => Math.min(Math.max(m, this.base), end) - this.base;
    const badIn = (a: number, z: number): number => (badBefore[clamp(z)] as number) - (badBefore[clamp(a)] as number);
    for (let t = s; t + length <= h; t++) {
      if (t >= end) return fits(end) ? { window: { start: t, end: t + length } } : { none: true };
      if (badIn(t, t + length) === 0 && (t + length <= end || fits(end))) return { window: { start: t, end: t + length } };
    }
    return { none: true };
  }

  private span(w: Window): [number, number] {
    return [w.start - this.base, (w.end ?? this.base + this.n) - this.base];
  }

  private peak(arr: Int32Array, w: Window): number {
    const [s, e] = this.span(w);
    let p = -Infinity;
    for (let t = s; t < e; t++) if ((arr[t] as number) > p) p = arr[t] as number;
    return p;
  }

  private addTo(arr: Int32Array, w: Window, b: number): void {
    const [s, e] = this.span(w);
    for (let t = s; t < e; t++) arr[t] = (arr[t] as number) + b;
    if (arr === this.all) {
      this.allVersion += 1;
      if (w.end === null) this.allTail += b;
    }
  }

  /** The outcome that the link must give for `cmd` at `ts`. */
  apply(cmd: LinkCommand, ts: HlcTs): Outcome {
    const key = requestKey(cmd.body.request);
    const rec = this.req.get(key);
    const tsNs = wallNs(ts);
    if (cmd.op === 'hold') {
      const b = cmd.body;
      if (rec?.madeBy === 'release') return { result: 'REFUSED', reason: 'TOMBSTONED' };
      if (rec) return rec.holdDigest === digest(b) ? rec.holdOutcome as Outcome : { code: 'MISMATCH' };
      const refuse = (o: Outcome): Outcome => {
        this.req.set(key, { madeBy: 'hold', state: 'REFUSED', holdDigest: digest(b), holdOutcome: o, tombstoneUntil: b.deadline + this.releaseGraceMs });
        return o;
      };
      if (tsNs >= BigInt(b.commitFence) * 1_000_000n) return refuse({ result: 'REFUSED', reason: 'DEADLINE_PASSED' });
      if (!Number.isSafeInteger(b.rateMbps) || b.rateMbps < 1) return refuse({ result: 'REFUSED', reason: { invalid: 'V1' } });
      if (b.window.end !== null && b.window.end <= b.window.start) return refuse({ result: 'REFUSED', reason: { invalid: 'V3' } });
      if (this.peak(this.firm, b.window) + b.rateMbps > this.capacity) return refuse({ result: 'REFUSED', reason: 'NO_FIT', counterOffer: this.counterOffer(b, ts) });
      if (this.peak(this.all, b.window) + b.rateMbps <= this.capacity) {
        this.addTo(this.all, b.window, b.rateMbps);
        const o: Outcome = { result: 'HELD', attempt: 1 };
        this.req.set(key, { madeBy: 'hold', state: 'HELD', holdDigest: digest(b), holdOutcome: o, rate: b.rateMbps, window: b.window, deadline: b.deadline });
        return o;
      }
      const latest = this.latestBlocker(b.window, b.rateMbps);
      if (b.wait) {
        const o: Outcome = { result: 'WAITING', attempt: 1, aheadDeadline: Math.max(latest, 0) };
        this.req.set(key, { madeBy: 'hold', state: 'WAITING', holdDigest: digest(b), holdOutcome: o, rate: b.rateMbps, window: b.window, deadline: b.deadline });
        this.waiters.push({ key, b, ahead: Math.max(latest, 0) });
        this.waiters.sort((x, y) => oraclePriority(x.b, y.b));
        return o;
      }
      const counterOffer = this.counterOffer(b, ts);
      let retryAfterMs = 0;
      if (latest >= 0) {
        const ns = BigInt(latest) * 1_000_000n - tsNs;
        retryAfterMs = ns <= 0n ? 0 : Number((ns + 999_999n) / 1_000_000n);
      }
      return refuse({ result: 'REFUSED', reason: 'IN_FLIGHT', counterOffer, retryAfterMs });
    }
    if (cmd.op === 'convert') {
      const b = cmd.body;
      if (!rec) return { code: 'NO_HOLD' };
      if (rec.state === 'CONVERTED') {
        return rec.convertAttempt === b.attempt && rec.convertDigest === digest(b) ? rec.convertOutcome as Outcome : { code: 'MISMATCH' };
      }
      if (rec.state === 'WAITING') return { code: 'NO_HOLD' };
      if (rec.state !== 'HELD') return { code: 'TOMBSTONED' };
      if (b.attempt !== 1) return { code: 'MISMATCH' };
      this.addTo(this.firm, rec.window as Window, rec.rate as number);
      const o: Outcome = { result: 'CONVERTED', part: b.part };
      Object.assign(rec, { state: 'CONVERTED', holdOutcome: { result: 'CONVERTED', part: b.part }, convertDigest: digest(b), convertAttempt: b.attempt, convertOutcome: o });
      this.scan(rec.window as Window, ts);
      return o;
    }
    const b = cmd.body;
    const until = b.deadline + this.releaseGraceMs;
    if (!rec) {
      this.req.set(key, { madeBy: 'release', state: 'RELEASED', tombstoneUntil: until });
      return { result: 'RELEASED', tombstoneUntil: until };
    }
    const newUntil = Math.max(rec.tombstoneUntil ?? 0, until);
    const wasHeld = rec.state === 'HELD';
    if (wasHeld) this.addTo(this.all, rec.window as Window, -(rec.rate as number));
    if (rec.state === 'WAITING') this.waiters = this.waiters.filter((w) => w.key !== key);
    if (wasHeld || rec.state === 'WAITING') Object.assign(rec, { state: 'RELEASED', holdOutcome: { result: 'RELEASED' } });
    rec.tombstoneUntil = newUntil;
    if (wasHeld) this.scan(rec.window as Window, ts);
    return { result: 'RELEASED', tombstoneUntil: newUntil };
  }

  /** The largest D of the held requests that overlap a minute where all + rate > capacity; −1 if none. */
  private latestBlocker(w: Window, rate: number): number {
    const [s, e] = this.span(w);
    let latest = -1;
    for (const r of this.req.values()) {
      if (r.state !== 'HELD' || !r.window || r.deadline === undefined || r.deadline <= latest) continue;
      const [hs, he] = this.span(r.window);
      for (let t = Math.max(s, hs); t < Math.min(e, he); t++) {
        if ((this.all[t] as number) + rate > this.capacity) { latest = r.deadline; break; }
      }
    }
    return latest;
  }

  /** POL-05: the waiters that overlap `w`, in priority order: skip after D_c, refuse for no fit, grant, or notify. */
  private scan(w: Window, ts: HlcTs): void {
    const [s, e] = this.span(w);
    const tsNs = wallNs(ts);
    for (const x of [...this.waiters]) {
      const [xs, xe] = this.span(x.b.window);
      if (Math.max(s, xs) >= Math.min(e, xe)) continue;
      if (tsNs >= BigInt(x.b.commitFence) * 1_000_000n) continue;
      const rec = this.req.get(x.key) as OracleRequest;
      const rate = x.b.rateMbps;
      if (this.peak(this.firm, x.b.window) + rate > this.capacity) {
        this.waiters = this.waiters.filter((y) => y.key !== x.key);
        const counterOffer = this.counterOffer(x.b, ts);
        Object.assign(rec, { state: 'REFUSED', holdOutcome: { result: 'REFUSED', reason: 'NO_FIT', counterOffer }, tombstoneUntil: x.b.deadline + this.releaseGraceMs });
        this.notices.push({ request: x.key, kind: 'WAITER_REFUSED', attempt: 1, counterOffer });
        continue;
      }
      if (this.peak(this.all, x.b.window) + rate <= this.capacity) {
        this.addTo(this.all, x.b.window, rate);
        this.waiters = this.waiters.filter((y) => y.key !== x.key);
        Object.assign(rec, { state: 'HELD', holdOutcome: { result: 'HELD', attempt: 1 } });
        this.notices.push({ request: x.key, kind: 'GRANTED', attempt: 1 });
        continue;
      }
      const ahead = Math.max(this.latestBlocker(x.b.window, rate), 0);
      if (ahead === x.ahead) continue;
      x.ahead = ahead;
      rec.holdOutcome = { result: 'WAITING', attempt: 1, aheadDeadline: ahead };
      this.notices.push({ request: x.key, kind: 'WAITING_NOTICE', attempt: 1, aheadDeadline: ahead });
    }
  }

  maxAll(): number {
    let m = 0;
    for (const v of this.all) if (v > m) m = v;
    return m;
  }
}

/**
 * The selling horizon of a request received at minute m0 (POL-09): the same UTC date and time `months` later,
 * or the last day of that month if it has no such date. Written apart from the link's code, for the oracle.
 */
export function oracleHorizon(m0: number, months: number): number {
  const d = new Date(m0 * 60_000);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes()));
  const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), daysInTarget));
  return target.getTime() / 60_000;
}
