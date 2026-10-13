/**
 * MONEY-I2 ledger (RFC-004 §B1, §B2; C06 §7 … §9) on the C01 runtime double: validation at append, the M4 and
 * M1 templates, per-line dedup, the movement digest, the feed and its views, and the posting principals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8 } from '@share/owner-runtime';
import { expectedPrivileges } from '@share/owner-migrate';
import {
  LEDGER_ENTRY, LedgerOwner, TOPIC, ledgerDeclaration, ledgerPartitionOfBuyer, ledgerRows, m4Entries, recordOf,
  type BalanceRecord, type MovementPosted, type PostLine, type PostMovementRequest, type PostingAck, type SourceRef, type StoredMovement,
} from '../src/index.ts';
import { MINUTE_0, moneyWorld, reservationBatch, reservationLine, weightsFixture, type MoneyWorld } from '../testing/index.ts';

const W = weightsFixture();

type LineSpec = { res: string; minute?: string; amount: bigint; route?: string; wv?: string; over?: Partial<PostLine> };

function ref(res: string, minute = MINUTE_0, seq = 0): Extract<SourceRef, { kind: 'reservation' }> {
  return { kind: 'reservation', reservation: res, minute, seq };
}

function m4Line(account: string, s: LineSpec): PostLine {
  const route = s.route ?? 'R1';
  const wv = s.wv ?? 'w1';
  return {
    kind: 'M4', lineRef: ref(s.res, s.minute), lineKind: 'reservation', payer: 'account', reason: 'original', amendmentSeq: 0,
    priorTotal: '0', newTotal: s.amount.toString(), split: { route, weightsVersion: wv, mode: 'normal' },
    entries: m4Entries(account, s.amount, W.find(route, wv)!), ...s.over,
  };
}

function m4(id: string, account: string, specs: LineSpec[], over: Partial<PostMovementRequest> = {}): PostMovementRequest {
  return {
    movementRef: id, cause: `charge-line batch ${id}`, currency: 'USD', batch: { id, kind: 'reservation', lineCount: specs.length },
    lines: specs.map((s) => m4Line(account, s)), ...over,
  };
}

function m1(id: string, account: string, x: bigint): PostMovementRequest {
  return {
    movementRef: id, cause: `payment notification ${id}`, currency: 'USD',
    lines: [{ kind: 'M1', entries: [{ ledgerAccount: 'X:partner:prov', amount: (-x).toString() }, { ledgerAccount: `B:${account}`, amount: x.toString() }] }],
  };
}

const pk = (account: string): Uint8Array => utf8(ledgerPartitionOfBuyer(account));
const movements = (w: MoneyWorld, account: string): StoredMovement[] =>
  w.rt.log(pk(account)).filter((e) => e.entry.kind === LEDGER_ENTRY.movement).map((e) => (e.entry.payload as { movement: StoredMovement }).movement);
const refusals = (w: MoneyWorld, account: string) =>
  w.rt.log(pk(account)).filter((e) => e.entry.kind === LEDGER_ENTRY.refusal).map((e) => (e.entry.payload as { refusal: { reason: string } }).refusal);
const balances = (w: MoneyWorld): Record<string, string> =>
  Object.fromEntries([...w.balances()].filter(([, v]) => v !== 0n).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v.toString()]));

async function assertMovesNothing(w: MoneyWorld, account: string): Promise<void> {
  assert.deepEqual(movements(w, account), [], 'no movement');
  assert.deepEqual(balances(w), {}, 'no balance changed');
  assert.deepEqual(w.events(TOPIC.movements), [], 'no movement event');
}

// ---------------- P4-S28, P4-S31, P4-S71: validation at append ----------------

test('P4-S28 a movement with a line that does not sum to zero is refused invalid, recorded, and moves nothing', async () => {
  const w = await moneyWorld();
  const req = m4('m-unbalanced', 'b1', [{ res: 'r-1', amount: 1_500n }]);
  req.lines[0]!.entries[0] = { ledgerAccount: 'B:b1', amount: '-1499' };
  const a = await w.post('b1', req);
  assert.deepEqual(a.result === 'refused' ? [a.result, a.reason] : a, ['refused', 'invalid']);
  assert.match(a.result === 'refused' ? a.detail : '', /sums to 1, not zero/);
  await assertMovesNothing(w, 'b1');
  assert.deepEqual(refusals(w, 'b1').map((r) => r.reason), ['invalid'], 'the refusal is recorded in the partition log');
});

test('P4-S28 a movement with a zero amount is refused invalid and moves nothing', async () => {
  const w = await moneyWorld();
  const req = m4('m-zero', 'b1', [{ res: 'r-1', amount: 1_500n }]);
  req.lines[0]!.entries.push({ ledgerAccount: 'S:A:earn', amount: '0' });
  const a = await w.post('b1', req);
  assert.deepEqual(a.result === 'refused' ? [a.reason, a.detail] : a, ['invalid', 'line 0: a zero amount on S:A:earn']);
  await assertMovesNothing(w, 'b1');
});

test('P4-S31 a movement in a currency other than USD, or with an entry in a second currency, is refused invalid and moves nothing', async () => {
  const w = await moneyWorld();
  const eur = { ...m4('m-eur', 'b1', [{ res: 'r-1', amount: 1_500n }]), currency: 'EUR' } as unknown as PostMovementRequest;
  const a = await w.post('b1', eur);
  assert.deepEqual(a.result === 'refused' ? [a.reason, a.detail] : a, ['invalid', 'currency EUR is not USD']);
  const two = m4('m-two', 'b1', [{ res: 'r-1', amount: 1_500n }]);
  two.lines[0]!.entries[1] = { ...two.lines[0]!.entries[1]!, currency: 'EUR' };
  const b = await w.post('b1', two);
  assert.deepEqual(b.result === 'refused' ? [b.reason, b.detail] : b, ['invalid', 'line 0: an entry in EUR in a USD movement']);
  await assertMovesNothing(w, 'b1');
});

test('P4-S31 every entry of a posted movement carries the movement\'s one currency', async () => {
  const w = await moneyWorld();
  const a = await w.post('b1', m4('m-usd', 'b1', [{ res: 'r-1', amount: 1_500n }, { res: 'r-2', amount: 7n, route: 'R2', wv: 'w2' }]));
  assert.equal(a.result, 'committed');
  const [mv] = movements(w, 'b1');
  assert.equal(mv!.currency, 'USD');
  const entries = mv!.lines.flatMap((l) => l.entries);
  assert.equal(entries.length, 9);
  assert.ok(entries.every((e) => e.currency === 'USD'));
});

test('P4-S71 every movement refers to the fact that caused it: the M4 names its charge-line batch and each line its SourceRef; no cause is refused', async () => {
  const w = await moneyWorld();
  await w.settle(reservationBatch('rating-1:0:7:0', 'b1', MINUTE_0, [reservationLine('b1', 'r-1', MINUTE_0, 1_500n)]));
  const [mv] = movements(w, 'b1');
  assert.deepEqual([mv!.movementRef, mv!.cause], ['rating-1:0:7:0', 'charge-line batch rating-1:0:7:0']);
  assert.deepEqual(mv!.lines.map((l) => l.lineRef), [ref('r-1')]);
  const [e] = w.events<MovementPosted>(TOPIC.movements);
  assert.deepEqual([e!.event.movementRef, e!.event.cause, e!.event.lines[0]!.lineRef], ['rating-1:0:7:0', 'charge-line batch rating-1:0:7:0', ref('r-1')]);
  const none = await w.post('b2', m4('m-nocause', 'b2', [{ res: 'r-9', amount: 10n }], { cause: '' }));
  assert.deepEqual(none.result === 'refused' ? [none.reason, none.detail] : none, ['invalid', 'no cause']);
});

test('should refuse a movement that touches two buyers, a class the kind may not touch, or a ledger account it cannot read', async () => {
  const w = await moneyWorld();
  const two = m4('m-2b', 'b1', [{ res: 'r-1', amount: 10n }]);
  two.lines.push(m4Line('b2', { res: 'r-2', amount: 10n }));
  two.batch!.lineCount = 2;
  const a = await w.post('b1', two);
  assert.deepEqual(a.result === 'refused' ? [a.reason, a.detail] : a, ['invalid', 'a movement touches 2 buyers; it must touch one']);
  const costs = m4('m-costs', 'b1', [{ res: 'r-1', amount: 10n }]);
  costs.lines[0]!.entries = [{ ledgerAccount: 'B:b1', amount: '-10' }, { ledgerAccount: 'SH:costs', amount: '10' }];
  const b = await w.post('b1', costs);
  assert.deepEqual(b.result === 'refused' ? [b.reason, b.detail] : b, ['invalid', 'line 0: M4 may not touch SH:costs']);
  const bad = m4('m-bad', 'b1', [{ res: 'r-1', amount: 10n }]);
  bad.lines[0]!.entries[1] = { ledgerAccount: 'Q:x', amount: bad.lines[0]!.entries[1]!.amount };
  const c = await w.post('b1', bad);
  assert.deepEqual(c.result === 'refused' ? [c.reason, c.detail] : c, ['invalid', 'line 0: Q:x is not a ledger account']);
  const text = m4('m-text', 'b1', [{ res: 'r-1', amount: 10n }]);
  text.lines[0]!.entries[0] = { ledgerAccount: 'B:b1', amount: '-10.0' };
  const d = await w.post('b1', text);
  assert.deepEqual(d.result === 'refused' ? [d.reason, d.detail] : d, ['invalid', 'line 0: amount -10.0 is not an integer']);
  await assertMovesNothing(w, 'b1');
});

test('should refuse wrong_home when a movement is posted to a partition that is not the home of its buyer', async () => {
  const w = await moneyWorld();
  const home = ledgerPartitionOfBuyer('b1');
  const other = home === '1' ? '2' : '1';
  const a = await w.ledger.post({ partition: other, principal: 'settlement', request: m4('m-home', 'b1', [{ res: 'r-1', amount: 10n }]) });
  assert.deepEqual(a.result === 'refused' ? [a.reason, a.detail] : a, ['wrong_home', `the home of B:b1 is partition ${home}, not ${other}`]);
  assert.deepEqual(w.rt.log(utf8(other)).map((e) => e.entry.kind), [LEDGER_ENTRY.refusal]);
  await assertMovesNothing(w, 'b1');
});

test('C06 CT-L4 (4) a request with lines.length ≠ batch.lineCount is refused invalid and moves nothing', async () => {
  const w = await moneyWorld();
  const a = await w.post('b1', m4('m-count', 'b1', [{ res: 'r-1', amount: 10n }], { batch: { id: 'm-count', kind: 'reservation', lineCount: 2 } }));
  assert.deepEqual(a.result === 'refused' ? [a.reason, a.detail] : a, ['invalid', 'lines.length 1 ≠ batch.lineCount 2']);
  await assertMovesNothing(w, 'b1');
});

test('should refuse invalid, with an alert and no record, a kind that this ledger version does not post (MONEY-I12 and later)', async () => {
  const w = await moneyWorld();
  const req: PostMovementRequest = {
    movementRef: 'prov:txn-9:completed', cause: 'invoice payment', currency: 'USD',
    lines: [{ kind: 'M2', entries: [{ ledgerAccount: 'X:partner:prov', amount: '-10' }, { ledgerAccount: 'B:b1', amount: '10' }] }],
  };
  const a = await w.post('b1', req, 'payments');
  assert.deepEqual(a.result === 'refused' ? [a.reason, a.detail] : a, ['invalid', 'kind M2 is not posted by this ledger version (MONEY-I3)']);
  assert.ok(w.ledger.alerts.some((x) => x.code === 'KIND_NOT_IN_THIS_VERSION'));
  assert.equal(w.rt.row(ledgerRows.movementRef(pk('b1'), 'prov:txn-9:completed')), undefined, 'the refusal is not the recorded answer of the movementRef');
  const unknown = { ...req, lines: [{ ...req.lines[0]!, kind: 'M99' }] } as unknown as PostMovementRequest;
  const b = await w.post('b1', unknown, 'payments');
  assert.deepEqual(b.result === 'refused' ? [b.reason, b.detail] : b, ['invalid', 'kind M99 is not a movement kind']);
  const m5 = m4('m-m5', 'b1', [{ res: 'r-1', amount: 10n }]);
  m5.lines[0]!.kind = 'M5';
  const c = await w.post('b1', m5);
  assert.deepEqual(c.result === 'refused' ? [c.reason, c.detail] : c, ['invalid', 'M5 in a reservation batch']);
  await assertMovesNothing(w, 'b1');
});

// ---------------- C06 CT-L1, CT-L3, CT-L5 (reservation batches) ----------------

test('C06 CT-L1 mapping reservation, 0, original → M4: one movement for the batch; each line debits B by a and credits each party its Webster share', async () => {
  const w = await moneyWorld();
  const batch = reservationBatch('rating-1:0:1:0', 'b1', MINUTE_0, [
    reservationLine('b1', 'r-1', MINUTE_0, 1_500n), reservationLine('b1', 'r-2', MINUTE_0, 7n, { route: 'R2', weightsVersion: 'w2' }),
  ]);
  const acks = await w.settle(batch);
  const [mv, ...more] = movements(w, 'b1');
  assert.equal(more.length, 0, 'one batch is one movement');
  assert.deepEqual(mv!.kinds, ['M4']);
  assert.deepEqual(mv!.lines.map((l) => [l.outcome, l.entries.map((e) => `${e.ledgerAccount} ${e.amount}`)]), [
    ['posted', ['B:b1 -1500', 'S:A:earn 450', 'S:B:earn 500', 'S:C:earn 325', 'SH:commission 225']],
    ['posted', ['B:b1 -7', 'S:A:earn 3', 'S:D:earn 2', 'SH:commission 2']],
  ]);
  assert.deepEqual(balances(w), { 'B:b1': '-1507', 'S:A:earn': '453', 'S:B:earn': '500', 'S:C:earn': '325', 'S:D:earn': '2', 'SH:commission': '227' });
  const position = { ledgerPartition: ledgerPartitionOfBuyer('b1'), sequence: '1', commitTs: w.events<MovementPosted>(TOPIC.movements)[0]!.event.postingTime };
  assert.deepEqual(acks, [
    { sourceRef: ref('r-1'), outcome: 'posted', duplicate: false, position, movementId: `${position.ledgerPartition}:1`, postedAmount: '1500', postedTotal: '1500' },
    { sourceRef: ref('r-2'), outcome: 'posted', duplicate: false, position, movementId: `${position.ledgerPartition}:1`, postedAmount: '7', postedTotal: '7' },
  ]);
});

test('C06 CT-L1 in a reservation batch settlement removes only the invalid line, acknowledges it invalid directly with an alert, and lineCount counts the lines it sends', async () => {
  const w = await moneyWorld();
  const bad = reservationLine('b1', 'r-2', MINUTE_0, 30n, { reason: 'late_traffic' });
  const batch = reservationBatch('rating-1:0:2:0', 'b1', MINUTE_0, [reservationLine('b1', 'r-1', MINUTE_0, 1_500n), bad, reservationLine('b1', 'r-3', MINUTE_0, 300n)]);
  const acks = await w.settle(batch);
  assert.deepEqual(w.directAcks.flatMap((a) => a.lines), [{ sourceRef: ref('r-2'), outcome: 'excluded', reason: 'invalid' }]);
  assert.deepEqual(acks.map((a) => [(a.sourceRef as { reservation: string }).reservation, a.outcome]), [['r-2', 'excluded'], ['r-1', 'posted'], ['r-3', 'posted']]);
  assert.deepEqual(movements(w, 'b1')[0]!.batch, { id: 'rating-1:0:2:0', kind: 'reservation', lineCount: 2 });
  assert.equal(w.settlement.alerts.filter((a) => a.code === 'LINE_INVALID').length, 1);
  assert.equal(w.balances().get('B:b1'), -1_800n, 'the invalid line moved nothing');
});

test('C06 CT-L3 a reservation batch of 5,001 lines posts nothing: settlement acknowledges each line batch_over_limit directly and alerts', async () => {
  const w = await moneyWorld();
  const lines = Array.from({ length: 5_001 }, (_, i) => reservationLine('b1', `r-${i}`, MINUTE_0, 10n));
  const acks = await w.settle(reservationBatch('rating-1:0:3:0', 'b1', MINUTE_0, lines));
  assert.equal(acks.length, 5_001);
  assert.ok(acks.every((a) => a.outcome === 'excluded' && a.reason === 'batch_over_limit'));
  assert.equal(w.directAcks.length, 1);
  assert.deepEqual(w.settlement.alerts.map((a) => a.code), ['BATCH_OVER_LIMIT']);
  assert.deepEqual(w.rt.appends.length, 0, 'nothing reached the ledger');
  await assertMovesNothing(w, 'b1');
  assert.deepEqual(w.commits, [{ partition: 0, next: 1n }], 'the batch is answered');
});

test('C06 CT-L3 the ledger refuses a movement of 5,001 lines over_limit, records the answer, and returns it on a repeat', async () => {
  const w = await moneyWorld();
  const req = m4('m-big', 'b1', Array.from({ length: 5_001 }, (_, i) => ({ res: `r-${i}`, amount: 10n })));
  const a = await w.post('b1', req);
  assert.deepEqual(a, { result: 'refused', reason: 'over_limit', detail: '5001 lines; the limit is 5000' });
  assert.deepEqual(await w.post('b1', req), a);
  const rec = recordOf<{ committed: boolean }>(w.rt.row(ledgerRows.movementRef(pk('b1'), 'm-big')));
  assert.equal(rec?.committed, false);
  await assertMovesNothing(w, 'b1');
});

test('C06 CT-L5 a batch sent again returns the recorded answer and posts nothing again', async () => {
  const w = await moneyWorld();
  const req = m4('m-again', 'b1', [{ res: 'r-1', amount: 1_500n }]);
  const a1 = await w.post('b1', req);
  assert.equal(a1.result, 'committed');
  const a2 = await w.post('b1', structuredClone(req));
  assert.deepEqual(a2, a1);
  assert.equal(movements(w, 'b1').length, 1);
  assert.equal(w.balances().get('B:b1'), -1_500n);
  assert.equal(w.ledger.alerts.length, 0);
});

test('C06 CT-L5 after a commit, the same movementRef with another digest returns the committed answer with integrityAlert and an integrity alert, never a refusal', async () => {
  const w = await moneyWorld();
  const a1 = await w.post('b1', m4('m-dig', 'b1', [{ res: 'r-1', amount: 1_500n }]));
  const changed = m4('m-dig', 'b1', [{ res: 'r-1', amount: 1_600n }]);
  assert.deepEqual(await w.post('b1', changed), { ...a1, integrityAlert: true });
  assert.deepEqual(w.ledger.alerts.map((x) => x.code), ['INTEGRITY_MOVEMENT_DIGEST']);
  assert.equal(movements(w, 'b1').length, 1, 'nothing moved twice');
  assert.equal(w.balances().get('B:b1'), -1_500n);
});

test('C06 CT-L5 before a commit, the same movementRef with another digest returns the recorded over_limit answer with integrityAlert', async () => {
  const w = await moneyWorld();
  const big = m4('m-big2', 'b1', Array.from({ length: 5_001 }, (_, i) => ({ res: `r-${i}`, amount: 10n })));
  const a1 = await w.post('b1', big);
  const small = m4('m-big2', 'b1', [{ res: 'r-1', amount: 10n }]);
  assert.deepEqual(await w.post('b1', small), { ...a1, integrityAlert: true });
  assert.ok(w.ledger.alerts.some((x) => x.code === 'INTEGRITY_MOVEMENT_DIGEST'));
  await assertMovesNothing(w, 'b1');
});

test('C06 CT-L5 a changed line in a reservation batch is excluded content_conflict with ledgerPostedTotal, ledgerLastSeq and ledgerPosition; the other lines post', async () => {
  const w = await moneyWorld();
  await w.settle(reservationBatch('rating-1:0:10:0', 'b1', MINUTE_0, [reservationLine('b1', 'r-1', MINUTE_0, 1_500n)]));
  const first = w.events<MovementPosted>(TOPIC.movements)[0]!.event;
  const acks = await w.settle(reservationBatch('rating-1:0:11:0', 'b1', MINUTE_0, [
    reservationLine('b1', 'r-1', MINUTE_0, 1_600n), reservationLine('b1', 'r-2', MINUTE_0, 300n),
  ]));
  assert.deepEqual(acks[0], {
    sourceRef: ref('r-1'), outcome: 'excluded', reason: 'content_conflict', conflictOf: first.movementId,
    ledgerPostedTotal: '1500', ledgerLastSeq: 0, ledgerPosition: first.position,
  });
  assert.deepEqual([acks[1]!.outcome, acks[1]!.outcome === 'posted' && acks[1]!.position.sequence], ['posted', '2']);
  assert.deepEqual(w.ledger.alerts.map((x) => x.code), ['INTEGRITY_LINE_CONFLICT']);
  assert.equal(w.balances().get('B:b1'), -1_800n, 'the conflicting line moved nothing');
  assert.deepEqual(w.events<MovementPosted>(TOPIC.movements)[1]!.event.lines.map((l) => l.outcome), ['excluded', 'posted']);
});

test('C06 CT-L5 two lines that differ only in cause are a conflict, not a duplicate', async () => {
  const w = await moneyWorld();
  await w.post('b1', m4('m-c1', 'b1', [{ res: 'r-1', amount: 100n }]));
  const a = await w.post('b1', m4('m-c2', 'b1', [{ res: 'r-1', amount: 100n, over: { cause: { kind: 'share' } } }]));
  assert.equal(a.result, 'committed');
  assert.deepEqual(a.result === 'committed' ? a.lines.map((l) => [l.outcome, l.problem, l.of]) : a, [['excluded', 'conflict', `${ledgerPartitionOfBuyer('b1')}:1`]]);
});

test('C06 CT-L4 (1) a line posted before with the same content is a duplicate in a new batch: posted, duplicate, at the first position; it moves nothing again', async () => {
  const w = await moneyWorld();
  const first = await w.settle(reservationBatch('rating-1:0:20:0', 'b1', MINUTE_0, [reservationLine('b1', 'r-1', MINUTE_0, 1_500n)]));
  const acks = await w.settle(reservationBatch('rating-1:0:21:0', 'b1', MINUTE_0, [
    reservationLine('b1', 'r-1', MINUTE_0, 1_500n), reservationLine('b1', 'r-2', MINUTE_0, 300n),
  ]));
  assert.deepEqual(acks[0], { ...first[0], duplicate: true });
  assert.equal(w.balances().get('B:b1'), -1_800n);
  assert.deepEqual(w.ledger.alerts, []);
});

test('should exclude a line invalid when its entries do not equal the M4 template of its route and weights (C06 M2 check 2)', async () => {
  const w = await moneyWorld();
  const req = m4('m-tpl', 'b1', [{ res: 'r-1', amount: 1_500n }, { res: 'r-2', amount: 300n }]);
  req.lines[0]!.entries = [{ ledgerAccount: 'B:b1', amount: '-1500' }, { ledgerAccount: 'S:A:earn', amount: '1500' }];
  const a = await w.post('b1', req);
  assert.deepEqual(a.result === 'committed' ? a.lines.map((l) => [l.outcome, l.problem]) : a, [['excluded', 'invalid'], ['posted', undefined]]);
  assert.equal(w.balances().get('S:A:earn'), 90n);
});

test('should exclude a reservation line out_of_sequence or prior_total_mismatch when it is not a valid original (C06 M2 check 2)', async () => {
  const w = await moneyWorld();
  const req = m4('m-seq', 'b1', [
    { res: 'r-1', amount: 100n, over: { lineRef: ref('r-1', MINUTE_0, 1), amendmentSeq: 1 } },
    { res: 'r-2', amount: 100n, over: { priorTotal: '5' } },
  ]);
  const a = await w.post('b1', req);
  assert.deepEqual(a.result === 'committed' ? a.lines.map((l) => [l.outcome, l.problem]) : a,
    [['excluded', 'out_of_sequence'], ['excluded', 'prior_total_mismatch']]);
  await assert.equal(w.balances().size, 0);
});

test('should refuse invalid, not recorded, when the ledger has no split weights for a line, and post the same request when the weights arrive', async () => {
  const w = await moneyWorld();
  const req = m4('m-w9', 'b1', [{ res: 'r-1', amount: 9n, route: 'R1', wv: 'w1' }]);
  req.lines[0]!.split = { route: 'R9', weightsVersion: 'w9', mode: 'normal' };
  const a = await w.post('b1', req);
  assert.deepEqual(a.result === 'refused' ? [a.reason, a.detail] : a, ['invalid', 'the ledger has no split weights R9/w9']);
  assert.ok(w.ledger.alerts.some((x) => x.code === 'WEIGHTS_UNKNOWN'));
  w.weights.apply({ ...W.find('R1', 'w1')!, route: 'R9', weightsVersion: 'w9' });
  const b = await w.post('b1', req);
  assert.deepEqual(b.result === 'committed' ? b.lines.map((l) => l.outcome) : b, ['posted']);
});

test('should chain each movement to the digest of the previous movement of its partition (RFC-004 §B1.2 prev)', async () => {
  const w = await moneyWorld();
  for (const i of [1, 2, 3]) await w.post('b1', m4(`m-ch${i}`, 'b1', [{ res: `r-${i}`, amount: 10n }]));
  const mvs = movements(w, 'b1');
  assert.deepEqual(mvs.map((m) => m.prev), ['', mvs[0]!.digest, mvs[1]!.digest]);
  assert.equal(new Set(mvs.map((m) => m.digest)).size, 3);
});

// ---------------- M1 ----------------

test('should post an M1 top-up from the payments principal as X −x and B +x when W is 0, and give the balance after it on the feed', async () => {
  const w = await moneyWorld();
  const a = await w.post('b1', m1('prov:txn-1:completed', 'b1', 5_000_000n), 'payments');
  assert.equal(a.result, 'committed');
  assert.deepEqual(balances(w), { 'B:b1': '5000000', 'X:partner:prov': '-5000000' });
  const e = w.events<MovementPosted>(TOPIC.byBuyer)[0]!.event;
  assert.deepEqual([e.kinds, e.buyer, e.lines[0]!.amount], [['M1'], { account: 'b1', balanceAfter: '5000000', writtenOffOwedAfter: '0' }, '5000000']);
  assert.deepEqual(w.events(TOPIC.postingAcks), [], 'an M1 has no posting acknowledgement');
});

test('should repay the written-off amount first when an M1 is posted to a buyer whose W is above 0 (RFC-004 §B2 M1, with W = 4,700,000 µ)', async () => {
  for (const [x, entries, after] of [
    [4_000_000n, ['X:partner:prov -4000000', 'SH:repayments 4000000'], { balance: '0', writtenOff: '700000' }],
    [5_700_000n, ['X:partner:prov -5700000', 'B:b1 1000000', 'SH:repayments 4700000'], { balance: '1000000', writtenOff: '0' }],
  ] as const) {
    const w = await moneyWorld();
    const row = ledgerRows.balance(pk('b1'), 'B:b1');
    const seed: BalanceRecord = { balance: '0', writtenOff: '4700000' };
    w.rt.putRow(row, { ...(row.key as object), balance: 0n, record: new TextEncoder().encode(JSON.stringify(seed)) });
    await w.post('b1', m1('prov:t1:completed', 'b1', x), 'payments');
    assert.deepEqual(movements(w, 'b1')[0]!.lines[0]!.entries.map((e) => `${e.ledgerAccount} ${e.amount}`), entries);
    assert.deepEqual(recordOf<BalanceRecord>(w.rt.row(row)), after);
  }
});

// ---------------- C06 CT-L7 feed and views ----------------

test('C06 CT-L7 each committed movement shows once on ledger.movements.v1, in sequence order, with batch and the per-line amount, postedTotal, reason and split', async () => {
  const w = await moneyWorld();
  await w.settle(reservationBatch('rating-1:0:30:0', 'b1', MINUTE_0, [reservationLine('b1', 'r-1', MINUTE_0, 1_500n)]));
  await w.settle(reservationBatch('rating-1:0:31:0', 'b1', '2026-10-12T09:01:00Z', [reservationLine('b1', 'r-1', '2026-10-12T09:01:00Z', 1_500n)]));
  await w.settle(reservationBatch('rating-1:0:31:0', 'b1', '2026-10-12T09:01:00Z', [reservationLine('b1', 'r-1', '2026-10-12T09:01:00Z', 1_500n)]));
  const feed = w.events<MovementPosted>(TOPIC.movements);
  assert.deepEqual(feed.map((f) => [f.streamSeq, f.event.eventId.streamSeq, f.event.position.sequence, f.event.batch?.id]),
    [[1n, '1', '1', 'rating-1:0:30:0'], [2n, '2', '2', 'rating-1:0:31:0']], 'a batch sent again shows no second time');
  const e = feed[0]!.event;
  assert.deepEqual(e.lines, [{
    lineRef: ref('r-1'), kind: 'M4', amendmentSeq: 0, outcome: 'posted', nil: false, lineKind: 'reservation', payer: 'account',
    reason: 'original', split: { route: 'R1', weightsVersion: 'w1', mode: 'normal' }, amount: '1500', postedTotal: '1500',
  }]);
  assert.deepEqual([e.home, e.kinds, e.currency, e.postedThrough, e.buyer], [
    { account: 'b1' }, ['M4'], 'USD', [{ reservation: 'r-1', minute: MINUTE_0 }], { account: 'b1', balanceAfter: '-1500', writtenOffOwedAfter: '0' },
  ]);
  assert.deepEqual(e.partyTotals, [
    { ledgerAccount: 'B:b1', amount: '-1500' }, { ledgerAccount: 'S:A:earn', amount: '450' }, { ledgerAccount: 'S:B:earn', amount: '500' },
    { ledgerAccount: 'S:C:earn', amount: '325' }, { ledgerAccount: 'SH:commission', amount: '225' },
  ]);
  assert.equal(e.postingTime, e.position.commitTs);
});

test('C06 CT-L7 the by-buyer view equals the full feed filtered by home; the supplier and external views equal their filters; two suppliers give two copies of one EventId', async () => {
  const w = await moneyWorld();
  await w.settle(reservationBatch('rating-1:0:40:0', 'b1', MINUTE_0, [reservationLine('b1', 'r-1', MINUTE_0, 7n, { route: 'R2', weightsVersion: 'w2' })]));
  await w.post('b2', m1('prov:t9:completed', 'b2', 1_000n), 'payments');
  await w.settle(reservationBatch('rating-1:0:41:0', 'b2', MINUTE_0, [reservationLine('b2', 'r-9', MINUTE_0, 4n, { route: 'R3', weightsVersion: 'w3' })]));
  const full = w.events<MovementPosted>(TOPIC.movements).map((f) => f.event);
  const strip = (e: MovementPosted & { view_key?: string }): MovementPosted => { const { view_key: _k, ...rest } = e; return rest; };
  const view = (topic: string) => w.events<MovementPosted & { view_key: string }>(topic).map((f) => f.event);
  const id = (e: MovementPosted) => JSON.stringify(e.eventId);
  for (const buyer of ['b1', 'b2']) {
    assert.deepEqual(view(TOPIC.byBuyer).filter((e) => e.view_key === buyer).map(strip), full.filter((e) => e.home.account === buyer));
  }
  const touches = (e: MovementPosted, prefix: string) => e.partyTotals.some((p) => p.ledgerAccount.startsWith(prefix));
  for (const s of ['A', 'D', 's', 't']) {
    assert.deepEqual(view(TOPIC.bySupplier).filter((e) => e.view_key === s).map(strip), full.filter((e) => touches(e, `S:${s}:`)), s);
  }
  assert.deepEqual(view(TOPIC.byExternal).map((e) => [e.view_key, e.movementRef]), [['X:partner:prov', 'prov:t9:completed']]);
  const r2 = view(TOPIC.bySupplier).filter((e) => e.movementRef === 'rating-1:0:40:0');
  assert.deepEqual(r2.map((e) => e.view_key), ['A', 'D'], 'one movement of two suppliers is in both supplier views');
  assert.equal(new Set(r2.map(id)).size, 1, 'both copies carry the EventId of the full feed');
  const dedup = new Set(r2.map((e) => `${e.view_key}|${id(e)}`));
  assert.equal(dedup.size, 2, 'dedup by (view key, EventId) keeps both copies');
});

test('should publish the ledger\'s posting acknowledgement from the outbox of the posting transaction, keyed by the buyer, with every line once', async () => {
  const w = await moneyWorld();
  await w.settle(reservationBatch('rating-1:0:50:0', 'b1', MINUTE_0, [reservationLine('b1', 'r-1', MINUTE_0, 15n), reservationLine('b1', 'r-2', MINUTE_0, 16n)]));
  const acks = w.events<PostingAck>(TOPIC.postingAcks);
  assert.equal(acks.length, 1);
  assert.deepEqual([acks[0]!.event.account, acks[0]!.event.batchId, acks[0]!.event.lines.length], ['b1', 'rating-1:0:50:0', 2]);
  const log = w.rt.log(pk('b1'));
  assert.deepEqual(log.map((e) => e.streamSeqs.map((s) => s.stream)), [['movements', 'by_buyer', 'by_supplier', 'by_supplier', 'by_supplier', 'posting_acks']],
    'the movement, its views and its answer are written in one entry');
});

// ---------------- C06 CT-L8, P4-S29 ----------------

test('C06 CT-L8 a caller that is not a posting principal, or a principal that posts a kind it may not post, is refused principal and moves nothing', async () => {
  const w = await moneyWorld();
  const req = m4('m-p', 'b1', [{ res: 'r-1', amount: 10n }]);
  for (const [principal, request] of [['rating', req], ['payments', req], ['settlement', m1('prov:t:completed', 'b1', 10n)], ['operator', req]] as const) {
    const a = await w.post('b1', request, principal);
    assert.deepEqual(a.result === 'refused' ? a.reason : a, 'principal', principal);
  }
  assert.deepEqual(refusals(w, 'b1').map((r) => r.reason), ['principal', 'principal', 'principal', 'principal']);
  await assertMovesNothing(w, 'b1');
  const ok = await w.post('b1', req);
  assert.equal(ok.result, 'committed');
  const other = await w.post('b1', req, 'payouts');
  assert.deepEqual(other.result === 'refused' ? other.reason : other, 'principal', 'a repeat from another principal is refused');
});

test('C06 CT-L8 settlement holds the account after a principal refusal, tries again every 30 s, and parks no line', async () => {
  const w = await moneyWorld({ settlement: { principal: 'rating' } });
  const b = reservationBatch('rating-1:0:60:0', 'b1', MINUTE_0, [reservationLine('b1', 'r-1', MINUTE_0, 10n)]);
  await w.settle(b);
  assert.equal(w.settlement.isHeld('b1'), true);
  assert.deepEqual(w.acksFor(b.batch.id), [], 'no line is acknowledged, so rating parks none');
  for (const step of [29_999, 1, 30_000]) {
    w.scheduler.advance(step);
    await w.settlement.idle();
  }
  assert.equal(refusals(w, 'b1').length, 3, 'one try and two tries again, 30 s apart');
  assert.deepEqual(w.commits, [], 'the offset stays below the held batch');
});

test('P4-S29 no role is granted UPDATE or DELETE on the movement log, and the ledger has no operation that alters or removes a movement', async () => {
  const privileges = expectedPrivileges([ledgerDeclaration()]);
  for (const [role, tables] of privileges) {
    const p = tables.get('ledger_log');
    if (p) assert.ok(!p.has('UPDATE') && !p.has('DELETE'), `${role} has ${[...p].join(', ')} on ledger_log`);
  }
  assert.deepEqual([...(privileges.get('ledger')?.get('ledger_log') ?? [])].sort(), ['INSERT', 'SELECT']);
  const operations = Object.getOwnPropertyNames(LedgerOwner.prototype).filter((n) => n !== 'constructor' && !n.startsWith('on'));
  assert.deepEqual(operations.sort(), ['alert', 'append', 'enter', 'leave', 'lineState', 'partitionOf', 'post', 'row', 'writes'], 'post is the only command; lineState is a read; the others are private steps of post');
  const w = await moneyWorld();
  await w.post('b1', m4('m-imm', 'b1', [{ res: 'r-1', amount: 1_500n }]));
  const before = structuredClone(w.rt.log(pk('b1')));
  await w.post('b1', m4('m-imm', 'b1', [{ res: 'r-1', amount: 1n }]));
  await w.post('b1', m4('m-imm2', 'b1', [{ res: 'r-1', amount: 1n }]));
  assert.deepEqual(w.rt.log(pk('b1')).slice(0, before.length), before, 'a changed repeat leaves the movement unchanged');
});

test('should keep at most maxAppendsPerSlot appends of one slot in flight, so that one batch transaction carries a bounded number of movements', async () => {
  const w = await moneyWorld();
  let inFlight = 0;
  let most = 0;
  const gates: Array<() => void> = [];
  const slow = Object.assign(Object.create(w.rt) as typeof w.rt, {
    append: async (...args: Parameters<typeof w.rt.append>) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise<void>((r) => gates.push(r));
      inFlight -= 1;
      return w.rt.append(...args);
    },
  });
  const ledger = new LedgerOwner(slow, { weights: W, maxAppendsPerSlot: 2 });
  const posts = Array.from({ length: 5 }, (_, i) =>
    ledger.post({ partition: ledgerPartitionOfBuyer('b1'), principal: 'settlement', request: m4(`m-g${i}`, 'b1', [{ res: `r-${i}`, amount: 10n }]) }));
  for (let i = 0; i < 20 && gates.length < 5; i++) {
    await new Promise<void>((r) => setImmediate(r));
    gates.splice(0).forEach((g) => g());
  }
  const answers = await Promise.all(posts);
  assert.deepEqual(answers.map((a) => a.result), ['committed', 'committed', 'committed', 'committed', 'committed']);
  assert.equal(most, 2);
});
