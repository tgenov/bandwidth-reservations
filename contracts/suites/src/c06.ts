/**
 * C06 provider suite, settlement and ledger side: §7 posting acknowledgement and §8 ledger posting port,
 * the subset that rating's I1 output reaches (usage originals, mapping row M5, usage batches). Tests come
 * from C06 "Conformance tests", provider side RFC-004 (CT-L1, CT-L4, CT-L5, CT-L6).
 *
 * There is no real ledger yet (S-MONEY MONEY-I2). The suite runs against the settlement double of the rate
 * slice, and the real provider has a registered PENDING entry.
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
