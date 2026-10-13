/**
 * C06 provider suite, settlement and ledger side: §7 posting acknowledgement and §8 ledger posting port,
 * the subset that rating's I1 output reaches (usage originals, mapping row M5, usage batches). Tests come
 * from C06 "Conformance tests", provider side RFC-004 (CT-L1, CT-L4, CT-L5, CT-L6).
 *
 * `runC06ProviderSuite` (usage batches) runs against the settlement double of the rate slice and against the
 * real ledger and settlement (S-MONEY MONEY-I3). `runC06ReservationSuite` (reservation batches: CT-L1
 * reservation rows, CT-L3, CT-L4 (1), CT-L5, CT-L6; and usage lines on the same multi-party weights: the M5 and
 * M6 templates by the Webster split, the weights of the original) runs against the real ledger and settlement
 * (MONEY-I2) and against the settlement double of the rate slice (S-RATE-I4).
 *
 * The types are copied from C06 "Schema" (the subset that the tests use).
 */
import assert from 'node:assert/strict';
import { subjectTest, type Closable, type SubjectFactory } from './support.ts';

// ---------- C06 "Schema" (subset) ----------

export interface C06LedgerPosition { ledgerPartition: string; sequence: string; commitTs: string }
export type C06SourceRef =
  | { kind: 'reservation'; reservation: string; minute: string; seq: number }
  | { kind: 'usage'; account: string; product: string; route: string; minute: string; seq: number }
  | { kind: 'fee'; reservation: string; feeId: string }
  | { kind: 'residue_fee'; request: string; partnerLink: string; feeId: string }
  | { kind: 'carried_excess'; account: string; product: string; route: string; minute: string; seq: number }
  | { kind: 'dearer_path'; reservation: string; minute: string; seq: number };
type UsageRef = Extract<C06SourceRef, { kind: 'usage' }>;
export type C06LineKind = 'reservation' | 'usage' | 'fee' | 'share_borne_fee' | 'carried_excess' | 'dearer_path';
export type C06Reason = 'original' | 'late_traffic' | 'price_correction' | 'quarantine_attribution'
  | 'attribution_reversed' | 'late_pol07_cut' | 'corrected_record' | 'superseding_record' | 're_rate';
export type C06MovementKind = 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'M8' | 'M9' | 'M10' | 'M11' | 'M12'
  | 'M13' | 'M14' | 'M15' | 'M16' | 'M17' | 'M18' | 'M19' | 'M20' | 'M21' | 'M22' | 'M23';

export interface C06ChargeLine {
  sourceRef: C06SourceRef; lineKind: C06LineKind; account: string; product?: string; route?: string; weightsVersion?: string;
  minute?: string; payer: 'account' | 'share'; amount: string; newTotal: string; priorTotal: string;
  reason: C06Reason; priceCatalogue: { resolvedTs: string };
}
export interface C06ChargeLineBatch {
  type: 'ChargeLineBatch'; schemaVersion: 1;
  eventId: { partition: string; stream: string; streamSeq: string; generation: number; epoch: number };
  batch: { id: string; kind: 'reservation' | 'usage'; account: string; minute?: string; gated: boolean; lineCount: number };
  lines: C06ChargeLine[]; emittedAt: string;
}

export type C06LineAck =
  | { sourceRef: C06SourceRef; outcome: 'posted'; duplicate: boolean; position: C06LedgerPosition; movementId: string;
      postedAmount: string; postedTotal: string }
  | { sourceRef: C06SourceRef; outcome: 'excluded';
      reason: 'content_conflict' | 'prior_total_mismatch' | 'out_of_sequence' | 'invalid' | 'batch_refused' | 'batch_over_limit';
      conflictOf?: string; ledgerPostedTotal?: string; ledgerLastSeq?: number; ledgerPosition?: C06LedgerPosition };

export interface C06PostLine {
  kind: C06MovementKind; lineRef?: C06SourceRef | string; lineKind?: C06LineKind; payer?: 'account' | 'share'; reason?: C06Reason;
  amendmentSeq?: number; priorTotal?: string; newTotal?: string;
  split?: { route: string; weightsVersion: string; mode: 'normal' | 'own' };
  entries: Array<{ ledgerAccount: string; amount: string }>;
}
export interface C06PostMovementRequest {
  movementRef: string; cause: string; currency: 'USD';
  batch?: { id: string; kind: 'reservation' | 'usage'; lineCount: number };
  lines: C06PostLine[];
}
export type C06LineProblem = 'conflict' | 'prior_total_mismatch' | 'out_of_sequence' | 'invalid';
export type C06PostMovementResponse =
  | { result: 'committed'; movementId: string; postingTime: string; position: C06LedgerPosition;
      lines: Array<{ lineRef?: C06SourceRef | string; outcome: 'posted' | 'duplicate' | 'excluded'; problem?: C06LineProblem;
                     of?: string; ledgerPostedTotal?: string; ledgerLastSeq?: number; ledgerPosition?: C06LedgerPosition }>;
      whole?: boolean; integrityAlert?: boolean }
  | { result: 'refused'; reason: 'invalid' | 'wrong_home' | 'principal' | 'stale' | 'over_limit'; detail: string; integrityAlert?: boolean }
  | { result: 'refused_batch';
      lines: Array<{ lineRef: C06SourceRef; problem: C06LineProblem; of?: string; ledgerPostedTotal?: string; ledgerLastSeq?: number;
                     ledgerPosition?: C06LedgerPosition }>;
      integrityAlert?: boolean }
  | { result: 'unavailable'; why: 'not_owner' | 'moving' | 'stopped' | 'overloaded' };

export interface C06Subject extends Closable {
  /** Give one charge-line batch to settlement (`charges.v1`); answer every PostingAck line published for it. */
  settle(batch: C06ChargeLineBatch): Promise<C06LineAck[]>;
  /** C06 §8 `post` to the home partition of the account. */
  post(req: C06PostMovementRequest, account: string): Promise<C06PostMovementResponse>;
  /** A catalogue route with one leg of `supplier`, and the weights version of that route. */
  route: string; weightsVersion: string; supplier: string;
  /** How many integrity alerts the ledger has sent. */
  integrityAlerts(): number;
}

// ---------- builders ----------

const PRODUCT = 'best-effort';
const MINUTE = '2026-10-12T09:00:00Z';

function usageRef(account: string, route: string, minute = MINUTE, seq = 0): UsageRef {
  return { kind: 'usage', account, product: PRODUCT, route, minute, seq };
}

function original(s: C06Subject, account: string, minute: string, amount: string, over: Partial<C06ChargeLine> = {}): C06ChargeLine {
  return {
    sourceRef: usageRef(account, s.route, minute), lineKind: 'usage', account, product: PRODUCT, route: s.route,
    weightsVersion: s.weightsVersion, minute, payer: 'account', amount, newTotal: amount, priorTotal: '0', reason: 'original',
    priceCatalogue: { resolvedTs: '0.0000000000' }, ...over,
  };
}

let batchNo = 0;
function usageBatch(account: string, lines: C06ChargeLine[]): C06ChargeLineBatch {
  batchNo += 1;
  return {
    type: 'ChargeLineBatch', schemaVersion: 1,
    eventId: { partition: 'rating-1', stream: 'charges', streamSeq: String(batchNo), generation: 0, epoch: 1 },
    batch: { id: `rating-1:0:${batchNo}:0`, kind: 'usage', account, gated: true, lineCount: lines.length },
    lines, emittedAt: `${batchNo}.0000000000`,
  };
}

/** A posting-port line of mapping row M5 (or an amendment kind) that debits the buyer and credits the supplier. */
function postLine(s: C06Subject, ref: UsageRef, kind: C06MovementKind, amount: bigint, priorTotal: bigint, newTotal: bigint): C06PostLine {
  return {
    kind, lineRef: ref, lineKind: 'usage', payer: 'account', reason: ref.seq === 0 ? 'original' : 'late_traffic', amendmentSeq: ref.seq,
    priorTotal: priorTotal.toString(), newTotal: newTotal.toString(),
    split: { route: s.route, weightsVersion: s.weightsVersion, mode: 'normal' },
    entries: [{ ledgerAccount: `B:${ref.account}`, amount: (-amount).toString() }, { ledgerAccount: `S:${s.supplier}:earn`, amount: amount.toString() }],
  };
}

function postReq(ref: string, lines: C06PostLine[], lineCount = lines.length): C06PostMovementRequest {
  return { movementRef: ref, cause: `charge batch ${ref}`, currency: 'USD', batch: { id: ref, kind: 'usage', lineCount }, lines };
}

function key(r: C06SourceRef): string {
  return JSON.stringify(r, Object.keys(r).sort());
}

/** The acknowledgement of each line, keyed by its SourceRef; each line is answered exactly once (C06 §7, m1). */
function byLine(batch: C06ChargeLineBatch, acks: C06LineAck[]): Map<string, C06LineAck> {
  const m = new Map<string, C06LineAck>();
  for (const a of acks) {
    assert.ok(!m.has(key(a.sourceRef)), `line ${key(a.sourceRef)} answered twice`);
    m.set(key(a.sourceRef), a);
  }
  assert.deepEqual([...m.keys()].sort(), batch.lines.map((l) => key(l.sourceRef)).sort(), 'every line is answered');
  return m;
}

function posted(a: C06LineAck | undefined): Extract<C06LineAck, { outcome: 'posted' }> {
  assert.equal(a?.outcome, 'posted', `expected posted, got ${JSON.stringify(a)}`);
  return a as Extract<C06LineAck, { outcome: 'posted' }>;
}

function excluded(a: C06LineAck | undefined): Extract<C06LineAck, { outcome: 'excluded' }> {
  assert.equal(a?.outcome, 'excluded', `expected excluded, got ${JSON.stringify(a)}`);
  return a as Extract<C06LineAck, { outcome: 'excluded' }>;
}

/** Register the C06 settlement and ledger suite against the subjects that `make` creates. */
export function runC06ProviderSuite(name: string, make: SubjectFactory<C06Subject>): void {
  const t = (id: string, behaviour: string, body: (s: C06Subject) => Promise<void>): void =>
    subjectTest('C06', id, name, behaviour, make, body);

  t('CT-L1', 'mapping M5: each usage original is posted once, with its amount, its total and the ledger position', async (s) => {
    const b = usageBatch('b1', [original(s, 'b1', '2026-10-12T09:00:00Z', '1500'), original(s, 'b1', '2026-10-12T09:01:00Z', '700')]);
    const acks = byLine(b, await s.settle(b));
    const p1 = posted(acks.get(key(usageRef('b1', s.route, '2026-10-12T09:00:00Z'))));
    const p2 = posted(acks.get(key(usageRef('b1', s.route, '2026-10-12T09:01:00Z'))));
    assert.deepEqual([p1.duplicate, p1.postedAmount, p1.postedTotal], [false, '1500', '1500']);
    assert.deepEqual([p2.duplicate, p2.postedAmount, p2.postedTotal], [false, '700', '700']);
    assert.equal(p1.movementId, p2.movementId, 'one batch is one movement');
    assert.deepEqual(p1.position, p2.position);
    assert.equal(p1.position.sequence, '1');
  });

  t('CT-L1', 'an invalid combination in a usage batch refuses it whole: the line is invalid, the others batch_refused, nothing posts', async (s) => {
    const bad = original(s, 'b1', '2026-10-12T09:00:00Z', '10', { reason: 'late_traffic' });
    const good = original(s, 'b1', '2026-10-12T09:01:00Z', '20');
    const b = usageBatch('b1', [bad, good]);
    const acks = byLine(b, await s.settle(b));
    assert.equal(excluded(acks.get(key(bad.sourceRef))).reason, 'invalid');
    assert.equal(excluded(acks.get(key(good.sourceRef))).reason, 'batch_refused');
    const again = usageBatch('b1', [good]);
    assert.equal(posted(byLine(again, await s.settle(again)).get(key(good.sourceRef))).position.sequence, '1', 'nothing posted before');
  });

  t('CT-L4', '(1) a line posted before with the same content is a duplicate in a new batch: posted, duplicate, at the first position', async (s) => {
    const x = original(s, 'b1', '2026-10-12T09:00:00Z', '100');
    const b1 = usageBatch('b1', [x]);
    const first = posted(byLine(b1, await s.settle(b1)).get(key(x.sourceRef)));
    const y = original(s, 'b1', '2026-10-12T09:01:00Z', '50');
    const b2 = usageBatch('b1', [x, y]);
    const acks = byLine(b2, await s.settle(b2));
    const dup = posted(acks.get(key(x.sourceRef)));
    assert.deepEqual([dup.duplicate, dup.movementId, dup.position, dup.postedTotal], [true, first.movementId, first.position, '100']);
    const fresh = posted(acks.get(key(y.sourceRef)));
    assert.deepEqual([fresh.duplicate, fresh.position.sequence], [false, '2']);
  });

  t('CT-L4', '(2) the same SourceRef with other content refuses the usage batch whole: content_conflict with the ledger total, last seq and position', async (s) => {
    const x = original(s, 'b1', '2026-10-12T09:00:00Z', '100');
    const b1 = usageBatch('b1', [x]);
    const first = posted(byLine(b1, await s.settle(b1)).get(key(x.sourceRef)));
    const alerts = s.integrityAlerts();
    const changed = { ...x, amount: '120', newTotal: '120' };
    const y = original(s, 'b1', '2026-10-12T09:01:00Z', '50');
    const b2 = usageBatch('b1', [changed, y]);
    const acks = byLine(b2, await s.settle(b2));
    const c = excluded(acks.get(key(x.sourceRef)));
    assert.deepEqual([c.reason, c.ledgerPostedTotal, c.ledgerLastSeq, c.ledgerPosition], ['content_conflict', '100', 0, first.position]);
    assert.equal(excluded(acks.get(key(y.sourceRef))).reason, 'batch_refused');
    assert.ok(s.integrityAlerts() > alerts, 'a content conflict sends an integrity alert');
    const b3 = usageBatch('b1', [y]);
    assert.equal(posted(byLine(b3, await s.settle(b3)).get(key(y.sourceRef))).position.sequence, '2', 'the refused batch posted nothing');
  });

  t('CT-L4', '(4) a request with lines.length ≠ lineCount is refused invalid', async (s) => {
    const ref = usageRef('b1', s.route);
    const r = await s.post(postReq('m-count', [postLine(s, ref, 'M5', 10n, 0n, 10n)], 2), 'b1');
    assert.equal(r.result, 'refused');
    assert.equal(r.result === 'refused' ? r.reason : undefined, 'invalid');
  });

  t('CT-L5', 'a request sent again gets the recorded answer; the same movementRef with another digest after a commit gets the committed answer with integrityAlert', async (s) => {
    const ref = usageRef('b1', s.route);
    const req = postReq('m-dedup', [postLine(s, ref, 'M5', 10n, 0n, 10n)]);
    const a1 = await s.post(req, 'b1');
    assert.equal(a1.result, 'committed');
    assert.deepEqual(await s.post(req, 'b1'), a1);
    const alerts = s.integrityAlerts();
    const other = postReq('m-dedup', [postLine(s, usageRef('b1', s.route, '2026-10-12T09:05:00Z'), 'M5', 11n, 0n, 11n)]);
    assert.deepEqual(await s.post(other, 'b1'), { ...a1, integrityAlert: true });
    assert.ok(s.integrityAlerts() > alerts);
  });

  t('CT-L5', 'before a commit, the same movementRef with another digest gets the recorded refused_batch with integrityAlert', async (s) => {
    const ref = usageRef('b1', s.route);
    const req = postReq('m-refused', [postLine(s, ref, 'M5', 10n, 5n, 15n)]);
    const a1 = await s.post(req, 'b1');
    assert.equal(a1.result, 'refused_batch');
    const other = postReq('m-refused', [postLine(s, ref, 'M5', 10n, 0n, 10n)]);
    assert.deepEqual(await s.post(other, 'b1'), { ...a1, integrityAlert: true });
  });

  t('CT-L6', 'a new reference with a wrong priorTotal is prior_total_mismatch; an amendment past the next sequence is out_of_sequence; each refuses the usage batch', async (s) => {
    const ref = usageRef('b1', s.route);
    const orig = await s.post(postReq('m-orig', [postLine(s, ref, 'M5', 100n, 0n, 100n)]), 'b1');
    assert.equal(orig.result, 'committed');
    const wrongPrior = await s.post(postReq('m-a1', [postLine(s, { ...ref, seq: 1 }, 'M6', 20n, 90n, 120n)]), 'b1');
    assert.equal(wrongPrior.result, 'refused_batch');
    if (wrongPrior.result === 'refused_batch' && orig.result === 'committed') {
      // C06 §7: rating re-bases E on ledgerPostedTotal and puts that posting at ledgerPosition for P_X.
      assert.deepEqual(wrongPrior.lines.map((l) => [l.problem, l.ledgerPostedTotal, l.ledgerLastSeq, l.ledgerPosition]),
        [['prior_total_mismatch', '100', 0, orig.position]]);
    }
    const skip = await s.post(postReq('m-a2', [postLine(s, { ...ref, seq: 2 }, 'M6', 20n, 100n, 120n)]), 'b1');
    assert.equal(skip.result, 'refused_batch');
    if (skip.result === 'refused_batch') assert.deepEqual(skip.lines.map((l) => l.problem), ['out_of_sequence']);
    const next = await s.post(postReq('m-a3', [postLine(s, { ...ref, seq: 1 }, 'M6', 20n, 100n, 120n)]), 'b1');
    assert.equal(next.result, 'committed', 'the right amendment still posts: the refusals posted nothing');
  });
}

// ---------- reservation batches (MONEY-I2) ----------

/**
 * The split weights that a subject of the reservation suite loads into its catalogue: the route of the P4 rule
 * "Each charge is split exactly" (weights 3000/3333/2167/1500). The suite computes the M4 entries from them.
 */
export const C06_SUITE_WEIGHTS = {
  entityType: 'split_weights' as const, route: 'route-r', weightsVersion: 'w-r', effectiveFrom: '2026-01-01T00:00:00Z', announcedAt: '0.0000000000',
  legs: [{ link: 'L1', supplier: 'sup-a', weight: 3000 }, { link: 'L2', supplier: 'sup-b', weight: 3333 }, { link: 'L3', supplier: 'sup-c', weight: 2167 }],
  commissionWeight: 1500,
};

/** A subject of the reservation suite: settlement and the ledger with C06_SUITE_WEIGHTS in their catalogue. */
export type C06ReservationSubject = Omit<C06Subject, 'route' | 'weightsVersion' | 'supplier'>;

type ReservationRef = Extract<C06SourceRef, { kind: 'reservation' }>;

function resRef(reservation: string, minute = MINUTE): ReservationRef {
  return { kind: 'reservation', reservation, minute, seq: 0 };
}

function resLine(account: string, reservation: string, amount: string, minute = MINUTE): C06ChargeLine {
  return {
    sourceRef: resRef(reservation, minute), lineKind: 'reservation', account, route: C06_SUITE_WEIGHTS.route,
    weightsVersion: C06_SUITE_WEIGHTS.weightsVersion, minute, payer: 'account', amount, newTotal: amount, priorTotal: '0',
    reason: 'original', priceCatalogue: { resolvedTs: '0.0000000000' },
  };
}

let resBatchNo = 0;
function resBatch(account: string, lines: C06ChargeLine[], minute = MINUTE): C06ChargeLineBatch {
  resBatchNo += 1;
  return {
    type: 'ChargeLineBatch', schemaVersion: 1,
    eventId: { partition: 'rating-2', stream: 'charges', streamSeq: String(resBatchNo), generation: 0, epoch: 1 },
    batch: { id: `rating-2:0:${resBatchNo}:0`, kind: 'reservation', account, minute, gated: false, lineCount: lines.length },
    lines, emittedAt: `${resBatchNo}.0000000000`,
  };
}

/**
 * RFC-004 §B2 M4 entries of one line for C06_SUITE_WEIGHTS: `B −a`, the suppliers, then the commission. The
 * shares come from the one-unit-at-a-time Webster rule (RFC-004 §B3.2), not from a provider's code.
 */
export function suiteM4Entries(account: string, a: bigint): Array<{ ledgerAccount: string; amount: string }> {
  return suiteSplitEntries(account, 0n, a);
}

const SUITE_PARTIES = [...C06_SUITE_WEIGHTS.legs.map((l) => ({ name: `S:${l.supplier}:earn`, w: BigInt(l.weight) })),
  { name: 'SH:commission', w: BigInt(C06_SUITE_WEIGHTS.commissionWeight) }];

/** The Webster shares of `a` for C06_SUITE_WEIGHTS, one unit at a time (RFC-004 §B3.2). */
function suiteSplit(a: bigint): bigint[] {
  const s = SUITE_PARTIES.map(() => 0n);
  for (let u = 0n; u < a; u++) {
    let best = 0;
    for (let i = 1; i < SUITE_PARTIES.length; i++) if (SUITE_PARTIES[i]!.w * (2n * s[best]! + 1n) > SUITE_PARTIES[best]!.w * (2n * s[i]! + 1n)) best = i;
    s[best] = s[best]! + 1n;
  }
  return s;
}

/** `B −(n − p)`, then each party's `split(n) − split(p)` that is not 0 (M4, M5: p = 0; M6). */
function suiteSplitEntries(account: string, p: bigint, n: bigint): Array<{ ledgerAccount: string; amount: string }> {
  const before = suiteSplit(p);
  const after = suiteSplit(n);
  return [{ ledgerAccount: `B:${account}`, amount: (p - n).toString() },
    ...SUITE_PARTIES.flatMap((x, i) => (after[i]! === before[i]! ? [] : [{ ledgerAccount: x.name, amount: (after[i]! - before[i]!).toString() }]))];
}

const SUITE_PRODUCT = 'best-effort';

function suiteUsageRef(account: string, seq: number, minute = MINUTE): UsageRef {
  return { kind: 'usage', account, product: SUITE_PRODUCT, route: C06_SUITE_WEIGHTS.route, minute, seq };
}

/** A usage charge line on C06_SUITE_WEIGHTS: the original (seq 0) or a late-traffic amendment. */
function suiteUsageLine(account: string, seq: number, priorTotal: bigint, newTotal: bigint, weightsVersion: string = C06_SUITE_WEIGHTS.weightsVersion): C06ChargeLine {
  return {
    sourceRef: suiteUsageRef(account, seq), lineKind: 'usage', account, product: SUITE_PRODUCT, route: C06_SUITE_WEIGHTS.route,
    weightsVersion, minute: MINUTE, payer: 'account', amount: (newTotal - priorTotal).toString(), newTotal: newTotal.toString(),
    priorTotal: priorTotal.toString(), reason: seq === 0 ? 'original' : 'late_traffic', priceCatalogue: { resolvedTs: '0.0000000000' },
  };
}

/** A posting-port usage line on C06_SUITE_WEIGHTS (M5 for seq 0, M6 above) with the given entries. */
function suiteUsagePost(account: string, seq: number, priorTotal: bigint, newTotal: bigint,
  entries: Array<{ ledgerAccount: string; amount: string }>, weightsVersion: string = C06_SUITE_WEIGHTS.weightsVersion): C06PostLine {
  return {
    kind: seq === 0 ? 'M5' : 'M6', lineRef: suiteUsageRef(account, seq), lineKind: 'usage', payer: 'account',
    reason: seq === 0 ? 'original' : 'late_traffic', amendmentSeq: seq, priorTotal: priorTotal.toString(), newTotal: newTotal.toString(),
    split: { route: C06_SUITE_WEIGHTS.route, weightsVersion, mode: 'normal' }, entries,
  };
}

function m4Req(id: string, account: string, lines: Array<[string, bigint]>): C06PostMovementRequest {
  return {
    movementRef: id, cause: `charge-line batch ${id}`, currency: 'USD', batch: { id, kind: 'reservation', lineCount: lines.length },
    lines: lines.map(([reservation, a]) => ({
      kind: 'M4', lineRef: resRef(reservation), lineKind: 'reservation', payer: 'account', reason: 'original', amendmentSeq: 0,
      priorTotal: '0', newTotal: a.toString(),
      split: { route: C06_SUITE_WEIGHTS.route, weightsVersion: C06_SUITE_WEIGHTS.weightsVersion, mode: 'normal' },
      entries: suiteM4Entries(account, a),
    })),
  };
}

/** Register the C06 reservation-batch suite (CT-L1 reservation rows, CT-L3, CT-L4 (1), CT-L5, CT-L6) against the subjects of `make`. */
export function runC06ReservationSuite(name: string, make: SubjectFactory<C06ReservationSubject>): void {
  const t = (id: string, behaviour: string, body: (s: C06ReservationSubject) => Promise<void>): void =>
    subjectTest('C06', id, name, behaviour, make, body);

  t('CT-L1', 'mapping M4: each reservation original of a batch is posted once in one movement, with its amount and total', async (s) => {
    const b = resBatch('b1', [resLine('b1', 'r-1', '1500'), resLine('b1', 'r-2', '7')]);
    const acks = byLine(b, await s.settle(b));
    const p1 = posted(acks.get(key(resRef('r-1'))));
    const p2 = posted(acks.get(key(resRef('r-2'))));
    assert.deepEqual([p1.duplicate, p1.postedAmount, p1.postedTotal], [false, '1500', '1500']);
    assert.deepEqual([p2.duplicate, p2.postedAmount, p2.postedTotal], [false, '7', '7']);
    assert.equal(p1.movementId, p2.movementId, 'one batch is one movement');
    assert.deepEqual(p1.position, p2.position);
  });

  t('CT-L1', 'in a reservation batch only the invalid line is excluded invalid; the other lines post', async (s) => {
    const bad = { ...resLine('b1', 'r-2', '30'), reason: 'late_traffic' as const };
    const b = resBatch('b1', [resLine('b1', 'r-1', '15'), bad]);
    const acks = byLine(b, await s.settle(b));
    assert.equal(excluded(acks.get(key(bad.sourceRef))).reason, 'invalid');
    posted(acks.get(key(resRef('r-1'))));
  });

  t('CT-L3', 'a reservation batch of 5,001 lines posts nothing: each line is acknowledged batch_over_limit', async (s) => {
    const b = resBatch('b1', Array.from({ length: 5_001 }, (_, i) => resLine('b1', `r-${i}`, '10')));
    const acks = byLine(b, await s.settle(b));
    assert.ok([...acks.values()].every((a) => a.outcome === 'excluded' && a.reason === 'batch_over_limit'));
    const again = resBatch('b1', [resLine('b1', 'r-0', '10')]);
    assert.equal(posted(byLine(again, await s.settle(again)).get(key(resRef('r-0')))).duplicate, false, 'nothing was posted before');
  });

  t('CT-L4', '(1) in a reservation batch, a line posted before with the same content is posted, duplicate, at the first position', async (s) => {
    const b1 = resBatch('b1', [resLine('b1', 'r-1', '100')]);
    const first = posted(byLine(b1, await s.settle(b1)).get(key(resRef('r-1'))));
    const b2 = resBatch('b1', [resLine('b1', 'r-1', '100'), resLine('b1', 'r-2', '50')]);
    const acks = byLine(b2, await s.settle(b2));
    const dup = posted(acks.get(key(resRef('r-1'))));
    assert.deepEqual([dup.duplicate, dup.movementId, dup.position, dup.postedTotal], [true, first.movementId, first.position, '100']);
    assert.equal(posted(acks.get(key(resRef('r-2')))).duplicate, false);
  });

  t('CT-L5', 'a changed line in a reservation batch is excluded content_conflict with the ledger total, last seq and position; the other lines post', async (s) => {
    const b1 = resBatch('b1', [resLine('b1', 'r-1', '100')]);
    const first = posted(byLine(b1, await s.settle(b1)).get(key(resRef('r-1'))));
    const alerts = s.integrityAlerts();
    const b2 = resBatch('b1', [resLine('b1', 'r-1', '120'), resLine('b1', 'r-2', '50')]);
    const acks = byLine(b2, await s.settle(b2));
    const c = excluded(acks.get(key(resRef('r-1'))));
    assert.deepEqual([c.reason, c.conflictOf, c.ledgerPostedTotal, c.ledgerLastSeq, c.ledgerPosition],
      ['content_conflict', first.movementId, '100', 0, first.position]);
    posted(acks.get(key(resRef('r-2'))));
    assert.ok(s.integrityAlerts() > alerts, 'a content conflict sends an integrity alert');
  });

  t('CT-L5', 'an M4 sent again gets the recorded answer; the same movementRef with another digest after a commit gets the committed answer with integrityAlert', async (s) => {
    const req = m4Req('m-res-dedup', 'b1', [['r-1', 1500n]]);
    const a1 = await s.post(req, 'b1');
    assert.equal(a1.result, 'committed');
    assert.deepEqual(await s.post(structuredClone(req), 'b1'), a1);
    const alerts = s.integrityAlerts();
    assert.deepEqual(await s.post(m4Req('m-res-dedup', 'b1', [['r-1', 1600n]]), 'b1'), { ...a1, integrityAlert: true });
    assert.ok(s.integrityAlerts() > alerts);
  });

  t('CT-L5', 'before a commit, the same movementRef with another digest gets the recorded over_limit answer with integrityAlert', async (s) => {
    const big = m4Req('m-res-big', 'b1', Array.from({ length: 5_001 }, (_, i): [string, bigint] => [`r-${i}`, 10n]));
    const a1 = await s.post(big, 'b1');
    assert.equal(a1.result === 'refused' ? a1.reason : a1.result, 'over_limit');
    assert.deepEqual(await s.post(m4Req('m-res-big', 'b1', [['r-1', 10n]]), 'b1'), { ...a1, integrityAlert: true });
  });

  t('CT-L6', 'an M4 line whose entries are not the template of its weights is excluded invalid; the other lines post', async (s) => {
    const req = m4Req('m-res-tpl', 'b1', [['r-1', 1500n], ['r-2', 300n]]);
    req.lines[0]!.entries = [{ ledgerAccount: 'B:b1', amount: '-1500' }, { ledgerAccount: 'S:sup-a:earn', amount: '1500' }];
    const a = await s.post(req, 'b1');
    assert.equal(a.result, 'committed');
    if (a.result === 'committed') assert.deepEqual(a.lines.map((l) => [l.outcome, l.problem]), [['excluded', 'invalid'], ['posted', undefined]]);
  });

  // Usage lines on the multi-party weights 3000/3333/2167/1500 (RFC-004 §B2 M5, M6; §B3.2 the Webster split; C06 §8 check 2).
  // split(1,500) = 450 / 500 / 325 / 225 (P4-S117); split(4,285) = 1,285 / 1,428 / 929 / 643. A floor split with the
  // remainder to the commission gives 450 / 499 / 325 / 226 and, for the amendment, 835 / 929 / 603 / 418.
  const M5_1500 = [{ ledgerAccount: 'B:b1', amount: '-1500' }, { ledgerAccount: 'S:sup-a:earn', amount: '450' },
    { ledgerAccount: 'S:sup-b:earn', amount: '500' }, { ledgerAccount: 'S:sup-c:earn', amount: '325' }, { ledgerAccount: 'SH:commission', amount: '225' }];
  const M6_1500_4285 = [{ ledgerAccount: 'B:b1', amount: '-2785' }, { ledgerAccount: 'S:sup-a:earn', amount: '835' },
    { ledgerAccount: 'S:sup-b:earn', amount: '928' }, { ledgerAccount: 'S:sup-c:earn', amount: '604' }, { ledgerAccount: 'SH:commission', amount: '418' }];

  t('CT-L1', 'mapping M5 and M6 on weights 3000/3333/2167/1500: the template of a usage original of 1,500 and of its late-traffic amendment to 4,285 is the Webster split', async (s) => {
    assert.deepEqual(suiteSplitEntries('b1', 0n, 1500n), M5_1500, 'the suite table is the one-unit-at-a-time rule');
    assert.deepEqual(suiteSplitEntries('b1', 1500n, 4285n), M6_1500_4285);
    const o = await s.post(postReq('m-u5', [suiteUsagePost('b1', 0, 0n, 1500n, M5_1500)]), 'b1');
    assert.equal(o.result, 'committed', JSON.stringify(o));
    if (o.result === 'committed') assert.deepEqual(o.lines.map((l) => l.outcome), ['posted']);
    const a = await s.post(postReq('m-u6', [suiteUsagePost('b1', 1, 1500n, 4285n, M6_1500_4285)]), 'b1');
    assert.equal(a.result, 'committed', JSON.stringify(a));
    if (a.result === 'committed') assert.deepEqual(a.lines.map((l) => l.outcome), ['posted']);
  });

  t('CT-L1', 'settlement maps a usage original of 1,500 to M5 and its late-traffic amendment to 4,285 to M6 on the line\'s weights, and both post', async (s) => {
    const b1 = usageBatch('b1', [suiteUsageLine('b1', 0, 0n, 1500n)]);
    const p1 = posted(byLine(b1, await s.settle(b1)).get(key(suiteUsageRef('b1', 0))));
    assert.deepEqual([p1.duplicate, p1.postedAmount, p1.postedTotal], [false, '1500', '1500']);
    const b2 = usageBatch('b1', [suiteUsageLine('b1', 1, 1500n, 4285n)]);
    const p2 = posted(byLine(b2, await s.settle(b2)).get(key(suiteUsageRef('b1', 1))));
    assert.deepEqual([p2.duplicate, p2.postedAmount, p2.postedTotal], [false, '2785', '4285']);
  });

  t('CT-L6', 'an M5 or M6 line whose entries are not the Webster template of its weights is invalid and refuses the usage batch', async (s) => {
    const floorM5 = [{ ledgerAccount: 'B:b1', amount: '-1500' }, { ledgerAccount: 'S:sup-a:earn', amount: '450' },
      { ledgerAccount: 'S:sup-b:earn', amount: '499' }, { ledgerAccount: 'S:sup-c:earn', amount: '325' }, { ledgerAccount: 'SH:commission', amount: '226' }];
    const r5 = await s.post(postReq('m-u5-floor', [suiteUsagePost('b1', 0, 0n, 1500n, floorM5)]), 'b1');
    assert.equal(r5.result, 'refused_batch', JSON.stringify(r5));
    if (r5.result === 'refused_batch') assert.deepEqual(r5.lines.map((l) => l.problem), ['invalid']);
    const o = await s.post(postReq('m-u5-ok', [suiteUsagePost('b1', 0, 0n, 1500n, M5_1500)]), 'b1');
    assert.equal(o.result, 'committed', 'the refusal posted nothing');
    const floorM6 = [{ ledgerAccount: 'B:b1', amount: '-2785' }, { ledgerAccount: 'S:sup-a:earn', amount: '835' },
      { ledgerAccount: 'S:sup-b:earn', amount: '929' }, { ledgerAccount: 'S:sup-c:earn', amount: '603' }, { ledgerAccount: 'SH:commission', amount: '418' }];
    const r6 = await s.post(postReq('m-u6-floor', [suiteUsagePost('b1', 1, 1500n, 4285n, floorM6)]), 'b1');
    assert.equal(r6.result, 'refused_batch', JSON.stringify(r6));
    if (r6.result === 'refused_batch') assert.deepEqual(r6.lines.map((l) => l.problem), ['invalid']);
    const a = await s.post(postReq('m-u6-ok', [suiteUsagePost('b1', 1, 1500n, 4285n, M6_1500_4285)]), 'b1');
    assert.equal(a.result, 'committed', 'the refusal posted nothing');
  });

  t('CT-L6', 'an amendment whose weightsVersion is not the one its original was posted with is invalid and refuses the usage batch', async (s) => {
    const o = await s.post(postReq('m-u5-w', [suiteUsagePost('b1', 0, 0n, 1500n, M5_1500)]), 'b1');
    assert.equal(o.result, 'committed');
    // Entries of the original's weights; only the weights version differs (ISSUES.md CS-11: the subject knows one version).
    const r = await s.post(postReq('m-u6-w', [suiteUsagePost('b1', 1, 1500n, 4285n, M6_1500_4285, 'w-other')]), 'b1');
    assert.equal(r.result, 'refused_batch', JSON.stringify(r));
    if (r.result === 'refused_batch') assert.deepEqual(r.lines.map((l) => l.problem), ['invalid']);
    const a = await s.post(postReq('m-u6-w2', [suiteUsagePost('b1', 1, 1500n, 4285n, M6_1500_4285)]), 'b1');
    assert.equal(a.result, 'committed', 'the refusal posted nothing');
  });
}
