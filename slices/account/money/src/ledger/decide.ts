/**
 * The decision of one `post` (C06 §8, RFC-004 §B1.2, §B1.4, §B2) inside the posting transaction. It is a pure
 * function of the request, the caller's principal and the rows it reads. It returns the answer, the log
 * entry, the projection rows and the feed events. The owner (owner.ts) runs it in `append`'s `decide`.
 */
import {
  MOVEMENT_KINDS, MOVEMENT_LINE_LIMIT,
  type Cause, type CommittedLine, type LedgerPosition, type LineAck, type LineProblem, type MovementKind, type MovementLine,
  type MovementPosted, type PostLine, type PostMovementRequest, type PostMovementResponse, type PostingAck, type SourceRef,
  type SplitWeights,
} from '../contracts/c06.ts';
import { digestOf, isSourceRef, lineKeyDigest, micro, parseMicro, sourceRefDigest } from '../money.ts';
import { COMMISSION_PARTY, WeightsError, partiesOf, websterSplit } from '../webster.ts';
import {
  KINDS_IN_THIS_INCREMENT, buyerAccount, classAllowed, ledgerPartitionOfBuyer, mayPost, parseLedgerAccount, shareAccount,
  supplierEarn, type LedgerAccount,
} from './accounts.ts';

// ---------- rows (the `record` column of each projection) ----------

/** `ledger_movement_ref`: the movement digest with its recorded answer (C06 M4, V63-2). */
export interface MovementRefRecord { movementRef: string; principal: string; digest: string; committed: boolean; answer: PostMovementResponse }
/** `ledger_chain`: the digest of the last movement of the partition. */
export interface ChainRecord { lastDigest: string; movements: string }
/** One posting of a line (one amendment sequence). */
export interface LinePosting {
  ref: string; seq: number; content: string; position: LedgerPosition; movementId: string; postedAmount: string; postedTotal: string;
}
/** `ledger_line`: the state of one line key (RFC-004 §B1.4). */
export interface LineRecord {
  lastSeq: number; postedTotal: string; position: LedgerPosition; movementId: string;
  route?: string; weightsVersion?: string; mode: 'normal' | 'own'; postings: LinePosting[];
}
/** `ledger_balance`: the balance of one ledger account; `writtenOff` is `W` of a buyer (RFC-004 §B2). */
export interface BalanceRecord { balance: string; writtenOff: string }

/** The rows that one decision reads. */
export interface LedgerReads {
  movementRef: MovementRefRecord | undefined;
  chain: ChainRecord | undefined;
  line(lineKey: string): LineRecord | undefined;
  balance(ledgerAccount: string): BalanceRecord | undefined;
}

/** The split weights the ledger knows (its catalogue replica), by (route, weights version). */
export interface WeightsSource {
  find(route: string, weightsVersion: string): SplitWeights | undefined;
}

export interface DecideInput {
  partition: string;
  principal: string;
  request: PostMovementRequest;
  /** Commit timestamp of the posting transaction (C01 §2.4 `ctx.ts`). */
  ts: string;
  /** The log sequence that the entry of this call gets. */
  seq: bigint;
  /** Stream sequences of the partition before this call. */
  streams: Record<string, bigint>;
  generation: number;
  epoch: number;
  weights: WeightsSource;
  partitionCount: number;
}

export type LedgerAlertCode =
  | 'INTEGRITY_LINE_CONFLICT' | 'INTEGRITY_MOVEMENT_DIGEST' | 'KIND_NOT_IN_MONEY_I2' | 'WEIGHTS_UNKNOWN' | 'MOVEMENT_REFUSED';
export interface LedgerAlert { code: LedgerAlertCode; partition: string; movementRef: string; detail: string }

/** The stored movement (RFC-004 §B1.2), the payload of a movement entry. Every entry carries its currency (P4-S31). */
export interface StoredMovement {
  movementId: string; kinds: MovementKind[]; movementRef: string; principal: string; cause: string; currency: 'USD';
  batch?: { id: string; kind: 'reservation' | 'usage'; lineCount: number };
  lines: Array<Omit<PostLine, 'entries'> & { outcome: CommittedLine['outcome']; problem?: LineProblem;
    entries: Array<{ ledgerAccount: string; amount: string; currency: 'USD' }> }>;
  partyTotals: Array<{ ledgerAccount: string; amount: string }>;
  postingTime: string; requestDigest: string; prev: string; digest: string;
}

export type Decision =
  | { kind: 'answer'; response: PostMovementResponse; alerts: LedgerAlert[] }
  | { kind: 'refuse'; response: PostMovementResponse; record: MovementRefRecord | undefined; alerts: LedgerAlert[];
      refusal: { movementRef: string; requestDigest: string; principal: string; reason: string; detail: string } }
  | { kind: 'commit'; response: Extract<PostMovementResponse, { result: 'committed' }>; alerts: LedgerAlert[];
      movement: StoredMovement; event: MovementPosted; buyers: string[]; suppliers: string[]; externals: string[];
      ack: PostingAck | undefined; lines: Map<string, LineRecord>; balances: Map<string, BalanceRecord>;
      chain: ChainRecord; record: MovementRefRecord };

/** The rows that a decision for this request reads (C01 §2.4: declared `reads`). */
export function readsOf(request: PostMovementRequest): { lineKeys: string[]; accounts: string[] } {
  const lineKeys = new Set<string>();
  const accounts = new Set<string>();
  for (const l of Array.isArray(request.lines) ? request.lines : []) {
    if (isSourceRef(l.lineRef)) lineKeys.add(lineKeyDigest(l.lineRef));
    for (const e of Array.isArray(l.entries) ? l.entries : []) {
      const a = parseLedgerAccount(e.ledgerAccount);
      if (a) accounts.add(e.ledgerAccount);
      if (a?.cls === 'buyer') accounts.add(shareAccount('repayments'));
    }
  }
  return { lineKeys: [...lineKeys], accounts: [...accounts] };
}

/** The digest of a request (C06 M4): the same request in any key order has the same digest. */
export function requestDigest(request: PostMovementRequest): string {
  return digestOf(request);
}

/** The fields that the ledger compares for a repeated SourceRef (C06 M2), from a posting-port line. */
function lineContent(l: PostLine): string {
  const prior = parseMicro(l.priorTotal);
  const next = parseMicro(l.newTotal);
  return digestOf({
    lineKind: l.lineKind, amount: prior !== undefined && next !== undefined ? micro(next - prior) : undefined,
    newTotal: l.newTotal, priorTotal: l.priorTotal, payer: l.payer, payee: l.payee, route: l.split?.route,
    weightsVersion: l.split?.weightsVersion, reason: l.reason, cause: l.cause, lateCut: l.lateCut, triggerRef: l.triggerRef,
  });
}

class Refusal extends Error {
  readonly reason: 'invalid' | 'wrong_home' | 'principal' | 'over_limit';
  constructor(reason: Refusal['reason'], detail: string) {
    super(detail);
    this.reason = reason;
  }
}

const ZERO = '0';
const bal = (r: BalanceRecord | undefined): bigint => parseMicro(r?.balance ?? ZERO) ?? 0n;
const wo = (r: BalanceRecord | undefined): bigint => parseMicro(r?.writtenOff ?? ZERO) ?? 0n;

/** Movement-level validation (C06 §8, RFC-004 §B1.2). Returns the home buyer. Throws a Refusal. */
function validateMovement(req: PostMovementRequest, partition: string, partitionCount: number): string {
  if (typeof req.movementRef !== 'string' || req.movementRef.length === 0) throw new Refusal('invalid', 'no movementRef');
  // P4-S71: every movement refers to the fact that caused it.
  if (typeof req.cause !== 'string' || req.cause.length === 0) throw new Refusal('invalid', 'no cause');
  if (req.currency !== 'USD') throw new Refusal('invalid', `currency ${String(req.currency)} is not USD`);
  if (!Array.isArray(req.lines) || req.lines.length === 0) throw new Refusal('invalid', 'no line');
  const kinds = new Set(req.lines.map((l) => l.kind));
  if (kinds.size !== 1) throw new Refusal('invalid', `a movement of kinds ${[...kinds].join(', ')}`);
  const kind = req.lines[0]!.kind;
  const buyers = new Set<string>();
  req.lines.forEach((l, i) => {
    if (!Array.isArray(l.entries) || l.entries.length === 0) throw new Refusal('invalid', `line ${i}: no entry (a nil line is M23 only)`);
    let sum = 0n;
    for (const e of l.entries) {
      // P4-S31: one currency; an entry that names another currency is a movement in two currencies.
      if (e.currency !== undefined && e.currency !== req.currency) throw new Refusal('invalid', `line ${i}: an entry in ${String(e.currency)} in a ${req.currency} movement`);
      const amount = parseMicro(e.amount);
      if (amount === undefined) throw new Refusal('invalid', `line ${i}: amount ${String(e.amount)} is not an integer`);
      if (amount === 0n) throw new Refusal('invalid', `line ${i}: a zero amount on ${e.ledgerAccount}`);
      const a = parseLedgerAccount(e.ledgerAccount);
      if (!a) throw new Refusal('invalid', `line ${i}: ${String(e.ledgerAccount)} is not a ledger account`);
      if (!classAllowed(kind, a)) throw new Refusal('invalid', `line ${i}: ${kind} may not touch ${e.ledgerAccount}`);
      if (a.cls === 'buyer') buyers.add(a.account);
      sum += amount;
    }
    if (sum !== 0n) throw new Refusal('invalid', `line ${i} sums to ${sum}, not zero`);
  });
  if (buyers.size !== 1) throw new Refusal('invalid', `a movement touches ${buyers.size} buyers; it must touch one`);
  const buyer = [...buyers][0]!;
  if (kind === 'M4') {
    const b = req.batch;
    if (!b || b.kind !== 'reservation' || b.id !== req.movementRef) throw new Refusal('invalid', 'an M4 carries one reservation batch, with movementRef = batch id');
  } else if (req.batch !== undefined || req.lines.length !== 1) {
    throw new Refusal('invalid', `${kind} is one line and no batch`);
  }
  if (ledgerPartitionOfBuyer(buyer, partitionCount) !== partition) {
    throw new Refusal('wrong_home', `the home of ${buyerAccount(buyer)} is partition ${ledgerPartitionOfBuyer(buyer, partitionCount)}, not ${partition}`);
  }
  if (req.batch && req.batch.lineCount !== req.lines.length) {
    throw new Refusal('invalid', `lines.length ${req.lines.length} ≠ batch.lineCount ${req.batch.lineCount}`);
  }
  return buyer;
}

/** The M4 template for one line (RFC-004 §B2): `B −a`, each supplier `S:earn +s_i`, `SH:commission +s_c`. */
export function m4Entries(buyer: string, amount: bigint, weights: SplitWeights): Array<{ ledgerAccount: string; amount: string }> {
  const parties = partiesOf(weights);
  const shares = websterSplit(amount, parties);
  const out = [{ ledgerAccount: buyerAccount(buyer), amount: micro(-amount) }];
  parties.forEach((p, i) => {
    const s = shares[i]!;
    if (s === 0n) return;
    out.push({ ledgerAccount: p.party === COMMISSION_PARTY ? shareAccount('commission') : supplierEarn(p.party), amount: micro(s) });
  });
  return out;
}

const entriesKey = (es: Array<{ ledgerAccount: string; amount: string }>): string =>
  JSON.stringify(es.map((e) => [e.ledgerAccount, e.amount]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)));

type LineVerdict =
  | { outcome: 'posted'; ref: Extract<SourceRef, { kind: 'reservation' }> | undefined; content: string; amount: bigint; newTotal: bigint; entries: Array<{ ledgerAccount: string; amount: string }> }
  | { outcome: 'duplicate'; posting: LinePosting }
  | { outcome: 'excluded'; problem: LineProblem; of?: string; record?: LineRecord };

/** The per-line checks of one M4 line, in the order of C06 M2. Throws WeightsError when the ledger has no weights. */
function checkM4Line(l: PostLine, buyer: string, lines: Map<string, LineRecord | undefined>, read: LedgerReads, weights: WeightsSource,
  alerts: LedgerAlert[], at: { partition: string; movementRef: string }): LineVerdict {
  if (!isSourceRef(l.lineRef) || l.lineRef.kind !== 'reservation') return { outcome: 'excluded', problem: 'invalid' };
  const ref = l.lineRef;
  const key = lineKeyDigest(ref);
  if (!lines.has(key)) lines.set(key, read.line(key));
  const record = lines.get(key);
  const refDigest = sourceRefDigest(ref);
  const content = lineContent(l);
  // (1) The canonical SourceRef first: a duplicate or a conflict, and no other check (C06 M2).
  const posting = record?.postings.find((p) => p.ref === refDigest);
  if (posting) {
    if (posting.content === content) return { outcome: 'duplicate', posting };
    alerts.push({ code: 'INTEGRITY_LINE_CONFLICT', ...at, detail: `${JSON.stringify(ref)} differs from ${posting.movementId}` });
    return { outcome: 'excluded', problem: 'conflict', of: posting.movementId, ...(record ? { record } : {}) };
  }
  // (2) A new reference: total, sequence, weights version, template.
  const prior = parseMicro(l.priorTotal);
  const next = parseMicro(l.newTotal);
  const seq = l.amendmentSeq ?? ref.seq;
  const posted = parseMicro(record?.postedTotal ?? ZERO) ?? 0n;
  if (prior === undefined || next === undefined) return { outcome: 'excluded', problem: 'invalid' };
  if (prior !== posted) return { outcome: 'excluded', problem: 'prior_total_mismatch', ...(record ? { record } : {}) };
  if (seq !== ref.seq || seq !== (record ? record.lastSeq + 1 : 0)) return { outcome: 'excluded', problem: 'out_of_sequence', ...(record ? { record } : {}) };
  // C06 mapping row "reservation, 0, original → M4"; every other combination is invalid.
  const amount = next - prior;
  const mapped = l.lineKind === 'reservation' && l.payer === 'account' && l.reason === 'original' && l.cause === undefined
    && l.lateCut === undefined && l.abandon === undefined && l.payee === undefined && seq === 0 && amount > 0n
    && l.split !== undefined && l.split.mode === 'normal' && l.split.explicitShares === undefined;
  if (!mapped || !l.split) return { outcome: 'excluded', problem: 'invalid' };
  const w = weights.find(l.split.route, l.split.weightsVersion);
  if (!w) throw new WeightsError(`the ledger has no split weights ${l.split.route}/${l.split.weightsVersion}`);
  const expected = m4Entries(buyer, amount, w);
  if (entriesKey(l.entries) !== entriesKey(expected)) return { outcome: 'excluded', problem: 'invalid' };
  return { outcome: 'posted', ref, content, amount, newTotal: next, entries: expected };
}

/** Decide one `post`. Deterministic: the same request and rows give the same decision. */
export function decidePost(input: DecideInput, read: LedgerReads): Decision {
  const { request: req, principal, partition } = input;
  const alerts: LedgerAlert[] = [];
  const digest = requestDigest(req);
  const at = { partition, movementRef: String(req.movementRef) };
  const refuse = (reason: Refusal['reason'], detail: string, record?: MovementRefRecord): Decision => {
    const response: PostMovementResponse = { result: 'refused', reason, detail };
    alerts.push({ code: 'MOVEMENT_REFUSED', ...at, detail: `${reason}: ${detail}` });
    return { kind: 'refuse', response, record: record ? { ...record, answer: response } : undefined, alerts,
      refusal: { movementRef: String(req.movementRef), requestDigest: digest, principal, reason, detail } };
  };

  const lines = Array.isArray(req.lines) ? req.lines : [];
  const unknown = lines.find((l) => !(MOVEMENT_KINDS as readonly string[]).includes(l.kind));
  if (unknown) return refuse('invalid', `kind ${String(unknown.kind)} is not a movement kind`);
  const notPermitted = lines.find((l) => !mayPost(principal, l.kind));
  if (notPermitted) return refuse('principal', `${principal} may not post ${notPermitted.kind}`);

  // C06 M4, V63-2: a recorded movementRef answers from its record; another digest adds integrityAlert.
  const recorded = read.movementRef;
  if (recorded) {
    if (recorded.principal !== principal) return refuse('principal', `movementRef ${req.movementRef} was posted by another principal`);
    if (recorded.digest === digest) return { kind: 'answer', response: recorded.answer, alerts };
    alerts.push({ code: 'INTEGRITY_MOVEMENT_DIGEST', ...at, detail: `digest ${digest} ≠ recorded ${recorded.digest}` });
    return { kind: 'answer', response: recorded.answer.result === 'unavailable' ? recorded.answer : { ...recorded.answer, integrityAlert: true }, alerts };
  }

  const unsupported = lines.find((l) => !KINDS_IN_THIS_INCREMENT.includes(l.kind));
  if (unsupported) {
    alerts.push({ code: 'KIND_NOT_IN_MONEY_I2', ...at, detail: unsupported.kind });
    return refuse('invalid', `kind ${unsupported.kind} is not posted by this ledger version (MONEY-I2)`);
  }
  const base = { movementRef: req.movementRef, principal, digest, committed: false };
  if (lines.length > MOVEMENT_LINE_LIMIT) {
    return refuse('over_limit', `${lines.length} lines; the limit is ${MOVEMENT_LINE_LIMIT}`, { ...base, answer: { result: 'refused', reason: 'over_limit', detail: '' } });
  }
  let buyer: string;
  try {
    buyer = validateMovement(req, partition, input.partitionCount);
  } catch (e) {
    if (e instanceof Refusal) return refuse(e.reason, e.message);
    throw e;
  }
  const kind = lines[0]!.kind;
  const movementId = `${partition}:${input.seq}`;
  const position: LedgerPosition = { ledgerPartition: partition, sequence: input.seq.toString(), commitTs: input.ts };

  const lineState = new Map<string, LineRecord | undefined>();
  const balances = new Map<string, BalanceRecord>();
  const balanceOf = (a: string): BalanceRecord => balances.get(a) ?? read.balance(a) ?? { balance: ZERO, writtenOff: ZERO };
  const add = (a: string, amount: bigint): void => {
    const r = balanceOf(a);
    balances.set(a, { ...r, balance: micro(bal(r) + amount) });
  };

  const verdicts: LineVerdict[] = [];
  const storedLines: StoredMovement['lines'] = [];
  const postedEntries: Array<{ ledgerAccount: string; amount: string }> = [];
  try {
    for (const l of lines) {
      let v: LineVerdict;
      let entries: Array<{ ledgerAccount: string; amount: string }>;
      if (kind === 'M4') {
        v = checkM4Line(l, buyer, lineState, read, input.weights, alerts, at);
        entries = v.outcome === 'posted' ? v.entries : [];
      } else {
        // M1 (RFC-004 §B2): `X −x`; `B +(x − r)`; `SH:repayments +r`, r = min(x, W) at append (AI4-8).
        const ext = l.entries.find((e) => parseLedgerAccount(e.ledgerAccount)?.cls === 'external');
        const b = l.entries.find((e) => parseLedgerAccount(e.ledgerAccount)?.cls === 'buyer');
        const x = parseMicro(b?.amount) ?? 0n;
        if (l.entries.length !== 2 || !ext || !b || x <= 0n) {
          return refuse('invalid', 'an M1 is `X:<partner>:<provider> −x` and `B:<account> +x`, x > 0');
        }
        const w = wo(balanceOf(b.ledgerAccount));
        const r = x < w ? x : w;
        entries = [{ ledgerAccount: ext.ledgerAccount, amount: micro(-x) }];
        if (x - r !== 0n) entries.push({ ledgerAccount: b.ledgerAccount, amount: micro(x - r) });
        if (r !== 0n) entries.push({ ledgerAccount: shareAccount('repayments'), amount: micro(r) });
        const br = balanceOf(b.ledgerAccount);
        balances.set(b.ledgerAccount, { ...br, writtenOff: micro(w - r) });
        v = { outcome: 'posted', ref: undefined, content: '', amount: x, newTotal: x, entries };
      }
      verdicts.push(v);
      for (const e of entries) { add(e.ledgerAccount, parseMicro(e.amount)!); postedEntries.push(e); }
      if (v.outcome === 'posted' && v.ref) {
        const key = lineKeyDigest(v.ref);
        const posting: LinePosting = { ref: sourceRefDigest(v.ref), seq: v.ref.seq, content: v.content, position, movementId,
          postedAmount: micro(v.amount), postedTotal: micro(v.newTotal) };
        const prev = lineState.get(key);
        lineState.set(key, {
          lastSeq: v.ref.seq, postedTotal: micro(v.newTotal), position, movementId, mode: prev?.mode ?? 'normal',
          ...(l.split ? { route: l.split.route, weightsVersion: l.split.weightsVersion } : {}),
          postings: [...(prev?.postings ?? []), posting],
        });
      }
      const { entries: _requested, ...rest } = l;
      storedLines.push({ ...rest, outcome: v.outcome, ...(v.outcome === 'excluded' ? { problem: v.problem } : {}),
        entries: entries.map((e) => ({ ...e, currency: 'USD' as const })) });
    }
  } catch (e) {
    if (e instanceof WeightsError) {
      alerts.push({ code: 'WEIGHTS_UNKNOWN', ...at, detail: e.message });
      return refuse('invalid', e.message);
    }
    throw e;
  }

  const totals = new Map<string, bigint>();
  for (const e of postedEntries) totals.set(e.ledgerAccount, (totals.get(e.ledgerAccount) ?? 0n) + parseMicro(e.amount)!);
  const partyTotals = [...totals].filter(([, v]) => v !== 0n).sort(([a], [b]) => (a < b ? -1 : 1)).map(([ledgerAccount, v]) => ({ ledgerAccount, amount: micro(v) }));
  const touched = [...totals.keys()].map((a) => [a, parseLedgerAccount(a)] as [string, LedgerAccount | undefined]);
  const suppliers = [...new Set(touched.flatMap(([, a]) => (a?.cls === 'supplier' ? [a.supplier] : [])))].sort();
  const externals = [...new Set(touched.flatMap(([n, a]) => (a?.cls === 'external' ? [n] : [])))].sort();

  const committedLines: CommittedLine[] = verdicts.map((v, i) => {
    const lineRef = lines[i]!.lineRef ?? (kind === 'M1' ? req.movementRef : undefined);
    const ref = lineRef === undefined ? {} : { lineRef };
    if (v.outcome === 'posted') return { ...ref, outcome: 'posted' };
    if (v.outcome === 'duplicate') return { ...ref, outcome: 'duplicate', of: v.posting.movementId };
    return { ...ref, outcome: 'excluded', problem: v.problem, ...(v.of ? { of: v.of } : {}), ...problemFields(v.record) };
  });
  const response: Extract<PostMovementResponse, { result: 'committed' }> = { result: 'committed', movementId, postingTime: input.ts, position, lines: committedLines };

  const chain = read.chain;
  const unsigned: Omit<StoredMovement, 'digest'> = {
    movementId, kinds: [kind], movementRef: req.movementRef, principal, cause: req.cause, currency: 'USD',
    ...(req.batch ? { batch: req.batch } : {}), lines: storedLines, partyTotals, postingTime: input.ts, requestDigest: digest,
    prev: chain?.lastDigest ?? '',
  };
  const movement: StoredMovement = { ...unsigned, digest: digestOf(unsigned) };

  const eventId = (stream: string, n = 1n) => ({
    partition, stream, streamSeq: ((input.streams[stream] ?? 0n) + n).toString(), generation: input.generation, epoch: input.epoch,
  });
  const buyerRow = balanceOf(buyerAccount(buyer));
  const event: MovementPosted = {
    type: 'MovementPosted', schemaVersion: 1, eventId: eventId('movements'), movementId, position, postingTime: input.ts,
    movementRef: req.movementRef, home: { account: buyer }, kinds: [kind], cause: req.cause, currency: 'USD', partyTotals,
    lines: verdicts.map((v, i) => movementLine(lines[i]!, v)),
    ...postedThrough(verdicts),
    ...(req.batch ? { batch: { id: req.batch.id, kind: req.batch.kind } } : {}),
    buyer: { account: buyer, balanceAfter: buyerRow.balance, writtenOffOwedAfter: buyerRow.writtenOff },
  };
  const ack: PostingAck | undefined = req.batch ? {
    type: 'PostingAck', schemaVersion: 1, eventId: eventId('posting_acks'), account: buyer, batchId: req.batch.id,
    lines: verdicts.flatMap((v, i): LineAck[] => {
      const ref = lines[i]!.lineRef;
      if (!isSourceRef(ref)) return [];
      if (v.outcome === 'posted') {
        return [{ sourceRef: ref, outcome: 'posted', duplicate: false, position, movementId, postedAmount: micro(v.amount), postedTotal: micro(v.newTotal) }];
      }
      if (v.outcome === 'duplicate') {
        const p = v.posting;
        return [{ sourceRef: ref, outcome: 'posted', duplicate: true, position: p.position, movementId: p.movementId, postedAmount: p.postedAmount, postedTotal: p.postedTotal }];
      }
      return [{ sourceRef: ref, outcome: 'excluded', reason: v.problem === 'conflict' ? 'content_conflict' : v.problem,
        ...(v.of ? { conflictOf: v.of } : {}), ...problemFields(v.record) }];
    }),
  } : undefined;

  const changedLines = new Map<string, LineRecord>();
  for (const [k, r] of lineState) if (r && r.movementId === movementId) changedLines.set(k, r);
  return {
    kind: 'commit', response, alerts, movement, event, buyers: [buyer], suppliers, externals, ack,
    lines: changedLines, balances,
    chain: { lastDigest: movement.digest, movements: ((parseMicro(chain?.movements ?? ZERO) ?? 0n) + 1n).toString() },
    record: { ...base, committed: true, answer: response },
  };
}

/** `ledgerPostedTotal`, `ledgerLastSeq` and `ledgerPosition` of a line the ledger has posted (C06-M2). */
function problemFields(r: LineRecord | undefined): { ledgerPostedTotal?: string; ledgerLastSeq?: number; ledgerPosition?: LedgerPosition } {
  return r ? { ledgerPostedTotal: r.postedTotal, ledgerLastSeq: r.lastSeq, ledgerPosition: r.position } : {};
}

/** One line of MovementPosted (C06 §9). `amount` is the charge of the line (`newTotal − priorTotal`); for M1, the buyer credit. */
function movementLine(l: PostLine, v: LineVerdict): MovementLine {
  const out: MovementLine = { kind: l.kind, outcome: v.outcome, nil: false };
  if (l.lineRef !== undefined) out.lineRef = l.lineRef;
  if (l.amendmentSeq !== undefined) out.amendmentSeq = l.amendmentSeq;
  if (l.lineKind !== undefined) out.lineKind = l.lineKind;
  if (l.payer !== undefined) out.payer = l.payer;
  if (l.reason !== undefined) out.reason = l.reason;
  if (l.cause !== undefined) out.cause = l.cause as Cause;
  if (l.triggerRef !== undefined) out.triggerRef = l.triggerRef;
  if (l.lateCut !== undefined) out.lateCut = l.lateCut;
  if (l.payee !== undefined) out.payee = l.payee;
  if (l.abandon !== undefined) out.abandon = l.abandon;
  if (l.split !== undefined) out.split = { route: l.split.route, weightsVersion: l.split.weightsVersion, mode: l.split.mode };
  if (v.outcome === 'posted') {
    if (l.kind === 'M1') {
      const b = v.entries.find((e) => parseLedgerAccount(e.ledgerAccount)?.cls === 'buyer');
      out.amount = b?.amount ?? ZERO;
    } else {
      out.amount = micro(v.amount);
      out.postedTotal = micro(v.newTotal);
    }
  } else if (v.outcome === 'duplicate') {
    out.postedTotal = v.posting.postedTotal;
  }
  return out;
}

/** The last posted minute of each reservation in the movement (C06 §9 `postedThrough`). */
function postedThrough(verdicts: LineVerdict[]): { postedThrough?: Array<{ reservation: string; minute: string }> } {
  const m = new Map<string, string>();
  for (const v of verdicts) {
    if (v.outcome !== 'posted' || v.ref?.kind !== 'reservation') continue;
    const cur = m.get(v.ref.reservation);
    if (cur === undefined || v.ref.minute > cur) m.set(v.ref.reservation, v.ref.minute);
  }
  if (m.size === 0) return {};
  return { postedThrough: [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([reservation, minute]) => ({ reservation, minute })) };
}
