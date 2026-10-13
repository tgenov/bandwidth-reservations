/**
 * MONEY-I2 settlement of reservation batches (RFC-004 §B3.1; C06 "Charge-line batches", "Ledger posting port"):
 * the CT-R fixtures against the golden ledger (CT-C1), isolation for each account (CT-L9), the in-flight limit,
 * the retry rules, the low-water mark, restarts and the batches that MONEY-I2 does not post.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOLD_RETRY_MS, REROUTE_WAIT_MS, TOPIC,
  type ChargeLineBatch, type LedgerAnswer, type LedgerPort, type MovementPosted, type PostCall,
} from '../src/index.ts';
import {
  MINUTE_0, chargeLine, ctrReservationBatches, moneyWorld, reservationBatch, reservationLine, usageBatch, usageRef, type MoneyWorld,
} from '../testing/index.ts';

const golden = (w: MoneyWorld): Record<string, string> =>
  Object.fromEntries([...w.balances()].filter(([, v]) => v !== 0n).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v.toString()]));
const sortedGolden = (g: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(g).sort(([a], [b]) => (a < b ? -1 : 1)));

/** A posting port that answers from a script for chosen accounts and passes the rest to the ledger. */
class ScriptedPort implements LedgerPort {
  readonly calls: PostCall[] = [];
  private readonly next: LedgerPort;
  readonly script = new Map<string, Array<LedgerAnswer | Error>>();
  constructor(next: LedgerPort) { this.next = next; }
  answer(account: string, ...answers: Array<LedgerAnswer | Error>): void { this.script.set(account, answers); }
  async post(call: PostCall): Promise<LedgerAnswer> {
    this.calls.push(call);
    const account = call.request.lines[0]!.entries[0]!.ledgerAccount.slice(2);
    const s = this.script.get(account);
    const a = s?.shift();
    if (a instanceof Error) throw a;
    if (a) return a;
    return this.next.post(call);
  }
}

/** A posting port that keeps every call open until the test releases it. */
class GatePort implements LedgerPort {
  readonly open: Array<{ call: PostCall; release: () => void }> = [];
  private readonly next: LedgerPort;
  /** After `openAll`, calls pass at once. */
  private passing = false;
  constructor(next: LedgerPort) { this.next = next; }
  openAll(): void {
    this.passing = true;
    for (const o of this.open) o.release();
  }
  async post(call: PostCall): Promise<LedgerAnswer> {
    if (!this.passing) await new Promise<void>((resolve) => this.open.push({ call, release: resolve }));
    return this.next.post(call);
  }
}

const one = (id: string, account: string, res: string, amount = 10n, minute = MINUTE_0): ChargeLineBatch =>
  reservationBatch(id, account, minute, [reservationLine(account, res, minute, amount)]);

test('C06 CT-C1 settlement consumes the CT-R reservation fixtures and the posted amounts equal the golden ledger, also when each batch comes three times', async () => {
  const { batches, golden: expected } = ctrReservationBatches();
  const w = await moneyWorld();
  for (const b of batches) await w.settle(b);
  assert.deepEqual(golden(w), sortedGolden(expected));
  for (const b of batches) for (let i = 0; i < 3; i++) await w.settle(structuredClone(b));
  assert.deepEqual(golden(w), sortedGolden(expected), 'a batch sent again moves nothing again (C06 CT-R8)');
  assert.equal(w.events(TOPIC.movements).length, batches.length);
  for (const b of batches) {
    const acks = w.acksFor(b.batch.id);
    assert.equal(acks.length, b.lines.length, 'each line is answered once, from the outbox of its posting transaction');
    assert.ok(acks.every((a) => a.outcome === 'posted'));
  }
});

test('C06 CT-L9 one account stopped for 10 min: other accounts on the same Kafka partition post at once, the offset stays at the low-water mark, and after a restart nothing posts twice', async () => {
  let port: ScriptedPort | undefined;
  const w = await moneyWorld({ port: (l) => (port = new ScriptedPort(l)) });
  port!.answer('b1', ...Array.from({ length: 20 }, () => ({ result: 'unavailable', why: 'stopped' }) as LedgerAnswer));
  await w.settle(one('rating-1:0:1:0', 'b1', 'r-1'), { partition: 0, offset: 100n });
  await w.settle(one('rating-1:0:2:0', 'b2', 'r-2'), { partition: 0, offset: 101n });
  await w.settle(one('rating-1:0:3:0', 'b3', 'r-3'), { partition: 0, offset: 102n });
  await w.settle(one('rating-1:0:4:0', 'b1', 'r-1', 10n, '2026-10-12T09:01:00Z'), { partition: 0, offset: 103n });
  assert.equal(w.settlement.isHeld('b1'), true);
  assert.deepEqual([...w.balances().keys()].filter((k) => k.startsWith('B:')).sort(), ['B:b2', 'B:b3'], 'other accounts posted');
  assert.deepEqual(w.commits, [], 'the committed offset stays at the first unanswered batch (100)');
  assert.deepEqual(w.settlement.alerts.filter((a) => a.code === 'LEDGER_STOPPED').length, 1);
  const tries = (): number => port!.calls.filter((c) => c.request.movementRef === 'rating-1:0:1:0').length;
  for (let s = 0; s < 19; s++) { w.scheduler.advance(HOLD_RETRY_MS); await w.settlement.idle(); }
  assert.equal(tries(), 20, 'one try every 30 s for 10 min, never a tight loop');
  assert.equal(port!.calls.filter((c) => c.request.movementRef === 'rating-1:0:4:0').length, 0, 'the account\'s later batch waits in its queue');
  // Restart before the stop is lifted: the new instance reads again from the committed offset.
  const s2 = w.restartSettlement(port);
  for (const [off, b] of [[100n, one('rating-1:0:1:0', 'b1', 'r-1')], [101n, one('rating-1:0:2:0', 'b2', 'r-2')],
    [102n, one('rating-1:0:3:0', 'b3', 'r-3')], [103n, one('rating-1:0:4:0', 'b1', 'r-1', 10n, '2026-10-12T09:01:00Z')]] as const) {
    s2.receive({ partition: 0, offset: off }, b);
  }
  await s2.idle();
  w.scheduler.advance(HOLD_RETRY_MS);
  await s2.idle();
  w.scheduler.advance(HOLD_RETRY_MS);
  await s2.idle();
  assert.equal(w.events(TOPIC.movements).length, 4, 'each batch is one movement: nothing posted twice');
  assert.equal(w.balances().get('B:b2'), -10n);
  assert.equal(w.balances().get('B:b1'), -20n);
  assert.deepEqual(s2.committed.get(0), 104n);
});

test('should keep at most 8 reservation batches of one account in flight, and start the next when one is answered', async () => {
  let gate: GatePort | undefined;
  const w = await moneyWorld({ port: (l) => (gate = new GatePort(l)) });
  for (let i = 0; i < 10; i++) w.settlement.receive({ partition: 0, offset: BigInt(i) }, one(`rating-1:0:${i}:0`, 'b1', `r-${i}`));
  w.settlement.receive({ partition: 0, offset: 10n }, one('rating-1:0:10:0', 'b2', 'r-x'));
  await new Promise<void>((r) => setImmediate(r));
  const forB1 = () => gate!.open.filter((o) => o.call.request.lines[0]!.entries[0]!.ledgerAccount === 'B:b1').length;
  assert.equal(forB1(), 8);
  assert.equal(gate!.open.length, 9, 'another account is not limited by b1');
  gate!.open[0]!.release();
  for (let i = 0; i < 5 && forB1() < 9; i++) await new Promise<void>((r) => setImmediate(r));
  assert.equal(forB1(), 9);
  gate!.openAll();
  await w.settlement.idle();
  assert.equal(w.events(TOPIC.movements).length, 11);
  assert.deepEqual(w.settlement.committed.get(0), 11n);
});

test('should commit the offset only up to the lowest unanswered batch when batches are answered out of order', async () => {
  let gate: GatePort | undefined;
  const w = await moneyWorld({ port: (l) => (gate = new GatePort(l)) });
  for (let i = 0; i < 3; i++) w.settlement.receive({ partition: 0, offset: BigInt(10 + i) }, one(`rating-1:0:${i}:0`, `b${i}`, 'r-1'));
  await new Promise<void>((r) => setImmediate(r));
  gate!.open[2]!.release();
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setTimeout(r, 0));
  assert.equal(w.commits.length, 0, 'offset 12 is answered, 10 is not');
  gate!.open[0]!.release();
  await new Promise<void>((r) => setTimeout(r, 0));
  assert.deepEqual(w.commits.map((c) => c.next), [11n], 'the low-water mark is now 11');
  gate!.open[1]!.release();
  await w.settlement.idle();
  assert.deepEqual(w.commits.map((c) => c.next), [11n, 13n]);
});

test('should try again at once on not_owner and moving, then after a short wait; after a backoff on overloaded; and after 30 s on a movement-level refusal', async () => {
  let port: ScriptedPort | undefined;
  const w = await moneyWorld({ port: (l) => (port = new ScriptedPort(l)) });
  const un = (why: 'not_owner' | 'moving' | 'overloaded'): LedgerAnswer => ({ result: 'unavailable', why });
  port!.answer('b1', un('not_owner'), un('moving'), un('moving'), un('not_owner'));
  await w.settle(one('rating-1:0:1:0', 'b1', 'r-1'));
  assert.equal(port!.calls.length, 4, 'three tries at once');
  assert.equal(w.settlement.isHeld('b1'), true);
  w.scheduler.advance(REROUTE_WAIT_MS - 1);
  await w.settlement.idle();
  assert.equal(port!.calls.length, 4);
  w.scheduler.advance(1);
  await w.settlement.idle();
  assert.equal(port!.calls.length, 5);
  assert.equal(w.balances().get('B:b1'), -10n);

  port!.answer('b2', un('overloaded'), un('overloaded'));
  await w.settle(one('rating-1:0:2:0', 'b2', 'r-2'));
  w.scheduler.advance(99);
  await w.settlement.idle();
  assert.equal(port!.calls.filter((c) => c.request.movementRef === 'rating-1:0:2:0').length, 1);
  w.scheduler.advance(1);
  await w.settlement.idle();
  assert.equal(port!.calls.filter((c) => c.request.movementRef === 'rating-1:0:2:0').length, 2);
  w.scheduler.advance(200);
  await w.settlement.idle();
  assert.equal(w.balances().get('B:b2'), -10n, 'the second backoff is 200 ms');

  port!.answer('b3', { result: 'refused', reason: 'wrong_home', detail: 'x' }, new Error('connection reset'));
  await w.settle(one('rating-1:0:3:0', 'b3', 'r-3'));
  w.scheduler.advance(HOLD_RETRY_MS - 1);
  await w.settlement.idle();
  assert.equal(port!.calls.filter((c) => c.request.movementRef === 'rating-1:0:3:0').length, 1);
  w.scheduler.advance(1);
  await w.settlement.idle();
  w.scheduler.advance(100);
  await w.settlement.idle();
  assert.equal(w.balances().get('B:b3'), -10n);
  assert.deepEqual(w.settlement.alerts.map((a) => a.code), ['MOVEMENT_REFUSED', 'POST_FAILED']);
});

test('should hold the account and try again after 30 s when settlement has no split weights for a line, then post with the weights', async () => {
  const w = await moneyWorld();
  const b = reservationBatch('rating-1:0:5:0', 'b1', MINUTE_0, [reservationLine('b1', 'r-1', MINUTE_0, 9n, { route: 'R7', weightsVersion: 'w7' })]);
  await w.settle(b);
  assert.deepEqual(w.settlement.alerts.map((a) => a.code), ['WEIGHTS_UNKNOWN']);
  assert.deepEqual(w.acksFor(b.batch.id), []);
  w.weights.apply({ entityType: 'split_weights', route: 'R7', weightsVersion: 'w7', effectiveFrom: MINUTE_0, announcedAt: '0.0000000000',
    legs: [{ link: 'L9', supplier: 'E', weight: 1 }], commissionWeight: 1 });
  w.scheduler.advance(HOLD_RETRY_MS);
  await w.settlement.idle();
  assert.deepEqual(golden(w), { 'B:b1': '-9', 'S:E:earn': '5', 'SH:commission': '4' });
});

test('should exclude invalid a zero-amount original, an amendment, a cost line, a line of another account or minute, and a SourceRef twice in one batch', async () => {
  const w = await moneyWorld();
  const lines = [
    reservationLine('b1', 'r-0', MINUTE_0, 0n),
    reservationLine('b1', 'r-1', MINUTE_0, 10n, { sourceRef: { kind: 'reservation', reservation: 'r-1', minute: MINUTE_0, seq: 1 } }),
    reservationLine('b1', 'r-2', MINUTE_0, 10n, { lineKind: 'dearer_path', payer: 'share' }),
    reservationLine('b2', 'r-3', MINUTE_0, 10n),
    reservationLine('b1', 'r-4', '2026-10-12T09:01:00Z', 10n),
    reservationLine('b1', 'r-5', MINUTE_0, 10n, { cause: { kind: 'share' } }),
    reservationLine('b1', 'r-6', MINUTE_0, 10n, { priorTotal: '5' }),
    reservationLine('b1', 'r-7', MINUTE_0, 10n),
    reservationLine('b1', 'r-7', MINUTE_0, 10n),
  ];
  const b = reservationBatch('rating-1:0:6:0', 'b1', MINUTE_0, lines);
  await w.settle(b);
  const direct = w.directAcks.flatMap((a) => a.lines);
  assert.deepEqual(direct.map((a) => (a.sourceRef as { reservation: string }).reservation), ['r-0', 'r-1', 'r-2', 'r-3', 'r-4', 'r-5', 'r-6', 'r-7']);
  assert.ok(direct.every((a) => a.outcome === 'excluded' && a.reason === 'invalid'));
  assert.equal(w.balances().get('B:b1'), -10n, 'only the first r-7 posts');
});

test('should keep one usage batch of an account in flight and start the next when it is answered, while reservation batches go on', async () => {
  let gate: GatePort | undefined;
  const w = await moneyWorld({ port: (l) => (gate = new GatePort(l)) });
  const u = (id: string, minute: string) => usageBatch(id, 'b1', [chargeLine('b1', usageRef('b1', 'R1', minute), 'usage', 0n, 100n)]);
  w.settlement.receive({ partition: 0, offset: 0n }, u('rating-1:0:7:0', MINUTE_0));
  w.settlement.receive({ partition: 0, offset: 1n }, u('rating-1:0:8:0', '2026-10-12T09:01:00Z'));
  w.settlement.receive({ partition: 0, offset: 2n }, one('rating-1:0:9:0', 'b1', 'r-3'));
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
  assert.deepEqual(gate!.open.map((o) => o.call.request.movementRef), ['rating-1:0:7:0'], 'the second usage batch and the batches behind it wait');
  gate!.open[0]!.release();
  for (let i = 0; i < 5 && gate!.open.length < 3; i++) await new Promise<void>((r) => setImmediate(r));
  assert.deepEqual(gate!.open.map((o) => o.call.request.movementRef).sort(), ['rating-1:0:7:0', 'rating-1:0:8:0', 'rating-1:0:9:0']);
  gate!.openAll();
  await w.settlement.idle();
  assert.deepEqual(w.events<MovementPosted>(TOPIC.movements).map((e) => [e.event.movementRef, e.event.batch]).sort(), [
    ['rating-1:0:7:0', { id: 'rating-1:0:7:0', kind: 'usage', whole: true }],
    ['rating-1:0:8:0', { id: 'rating-1:0:8:0', kind: 'usage', whole: true }],
    ['rating-1:0:9:0', { id: 'rating-1:0:9:0', kind: 'reservation' }],
  ]);
  assert.equal(w.balances().get('B:b1'), -210n);
  assert.deepEqual(w.settlement.committed.get(0), 3n);
});

test('should commit past a record that is not a batch (a resolved marker) when nothing before it is unanswered', async () => {
  const w = await moneyWorld();
  await w.settle(one('rating-1:0:1:0', 'b1', 'r-1'), { partition: 2, offset: 7n });
  w.settlement.skip({ partition: 2, offset: 8n });
  assert.deepEqual(w.commits, [{ partition: 2, next: 8n }, { partition: 2, next: 9n }]);
});

test('should publish settlement\'s own exclusions before the batch offset is committed, and once only when the post is tried again', async () => {
  let port: ScriptedPort | undefined;
  const w = await moneyWorld({ port: (l) => (port = new ScriptedPort(l)) });
  port!.answer('b1', { result: 'unavailable', why: 'stopped' });
  const b = reservationBatch('rating-1:0:3:0', 'b1', MINUTE_0, [reservationLine('b1', 'r-1', MINUTE_0, 10n), reservationLine('b1', 'r-2', MINUTE_0, 0n)]);
  await w.settle(b);
  assert.equal(w.directAcks.length, 1);
  assert.deepEqual(w.commits, []);
  w.scheduler.advance(HOLD_RETRY_MS);
  await w.settlement.idle();
  assert.equal(w.directAcks.length, 1);
  assert.deepEqual(w.commits, [{ partition: 0, next: 1n }]);
  const [mv] = w.events<MovementPosted>(TOPIC.movements);
  assert.deepEqual(mv!.event.batch, { id: 'rating-1:0:3:0', kind: 'reservation' });
});
