/**
 * C01 §10.2 consumer contract tests CC-1 … CC-8 for the ledger owner kind (MONEY-I2 exit criterion 4), on the
 * C01 runtime double.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotOfPartition, utf8, validateDeclaration, type AppendResult } from '@share/owner-runtime';
import { RESULTS } from '@share/owner-runtime/testing';
import { kindMigration } from '@share/owner-migrate';
import {
  LEDGER_DEV_SLOT_COUNT, TOPIC, ledgerDeclaration, ledgerPartitionOfBuyer, m4Entries,
  type MovementPosted, type PostMovementRequest,
} from '../src/index.ts';
import { MINUTE_0, moneyWorld, weightsFixture, type MoneyWorld } from '../testing/index.ts';
import { rng } from './support.ts';

const W = weightsFixture();

function m4(id: string, account: string, res: string, amount: bigint, minute = MINUTE_0): PostMovementRequest {
  return {
    movementRef: id, cause: `charge-line batch ${id}`, currency: 'USD', batch: { id, kind: 'reservation', lineCount: 1 },
    lines: [{
      kind: 'M4', lineRef: { kind: 'reservation', reservation: res, minute, seq: 0 }, lineKind: 'reservation', payer: 'account',
      reason: 'original', amendmentSeq: 0, priorTotal: '0', newTotal: amount.toString(), split: { route: 'R1', weightsVersion: 'w1', mode: 'normal' },
      entries: m4Entries(account, amount, W.find('R1', 'w1')!),
    }],
  };
}

const pk = (account: string): Uint8Array => utf8(ledgerPartitionOfBuyer(account));
const slot = (account: string): number => slotOfPartition(pk(account), LEDGER_DEV_SLOT_COUNT);
const sorted = (w: MoneyWorld): Array<[string, bigint]> => [...w.balances()].sort(([a], [b]) => (a < b ? -1 : 1));

test('C01 CC-1: every AppendResult of a post gives the C01 §3.2 action; nothing is answered or published before Committed; reruns keep the identities', async () => {
  const cases: Array<[string, () => AppendResult, string]> = [
    ['Retry', RESULTS.Retry, 'committed'],
    ['Ambiguous', RESULTS.Ambiguous, 'committed'],
    ['ConditionFailed', () => RESULTS.ConditionFailed('decide'), 'committed'],
    ['unknown', RESULTS.Unknown, 'committed'],
    ['Moving', RESULTS.Moving, 'unavailable:moving'],
    ['Moved', () => RESULTS.Moved(3, 1), 'unavailable:not_owner'],
    ['StaleEpoch', RESULTS.StaleEpoch, 'unavailable:not_owner'],
    ['Stopped', RESULTS.Stopped, 'unavailable:stopped'],
    ['Overloaded', () => RESULTS.Overloaded(50), 'unavailable:overloaded'],
  ];
  for (const [name, res, expect] of cases) {
    const w = await moneyWorld();
    w.rt.scriptAppend(res());
    const a = await w.post('b1', m4('m-cc1', 'b1', 'r-1', 1_500n));
    const got = a.result === 'unavailable' ? `unavailable:${a.why}` : a.result;
    assert.equal(got, expect, name);
    const calls = w.rt.appends;
    if (expect === 'committed') {
      assert.equal(calls.length, 2, `${name}: one rerun`);
      assert.deepEqual(calls[1]!.call.reads, calls[0]!.call.reads, `${name}: the rerun reads the same rows`);
      assert.equal(w.events(TOPIC.movements).length, 1, `${name}: one movement`);
      assert.equal(w.rt.log(pk('b1'))[0]!.entry.identity.toString(), utf8('movement|m-cc1').toString());
    } else {
      assert.equal(calls.length, 1, `${name}: no rerun`);
      assert.deepEqual(w.rt.published, [], `${name}: no event and no acknowledgement`);
      assert.deepEqual(w.rt.log(pk('b1')), [], `${name}: nothing appended`);
    }
    assert.equal(w.ledger.alerts.some((x) => /UNKNOWN_APPEND_RESULT/.test(x.detail)), name === 'unknown', `${name}: alert only for an unknown result`);
  }
  const w = await moneyWorld();
  w.rt.scriptAppend(RESULTS.Retry(), RESULTS.Ambiguous(), RESULTS.Retry(), RESULTS.Retry());
  const a = await w.post('b1', m4('m-cc1b', 'b1', 'r-1', 1_500n));
  assert.deepEqual(a, { result: 'unavailable', why: 'overloaded' }, 'after 3 reruns the caller backs off');
  assert.deepEqual(w.rt.published, []);
});

test('C01 CC-2: after onMovedOut a post for the partition is answered moving; nothing is appended for it', async () => {
  const w = await moneyWorld();
  w.rt.moveOut(pk('b1'), 3);
  const n = w.rt.appends.length;
  assert.deepEqual(await w.post('b1', m4('m-cc2', 'b1', 'r-1', 10n)), { result: 'unavailable', why: 'moving' });
  assert.equal(w.rt.appends.length, n);
  assert.deepEqual(w.rt.log(pk('b1')), []);
  assert.equal((await w.post('b2', m4('m-cc2b', 'b2', 'r-2', 10n))).result, 'committed', 'other partitions continue');
});

test('C01 CC-3: after onAdopt the partition posts in the new generation from its rows; a movement posted before the move is a duplicate after it', async () => {
  const w = await moneyWorld();
  const before = await w.post('b1', m4('m-cc3', 'b1', 'r-1', 1_500n));
  w.rt.moveOut(pk('b1'), slot('b1'));
  await w.rt.adopt(pk('b1'), 1);
  await w.rt.takeover(slot('b1'));
  assert.deepEqual(await w.post('b1', m4('m-cc3', 'b1', 'r-1', 1_500n)), before, 'the recorded answer');
  const after = await w.post('b1', m4('m-cc3b', 'b1', 'r-1', 1_500n, '2026-10-12T09:01:00Z'));
  assert.equal(after.result, 'committed');
  const events = w.events<MovementPosted>(TOPIC.movements).map((e) => e.event.eventId);
  assert.deepEqual(events.map((e) => [e.streamSeq, e.generation, e.epoch]), [['1', 0, 1], ['2', 1, 2]]);
  assert.equal(w.balances().get('B:b1'), -3_000n);
});

test('C01 CC-4: while a stop is open the ledger decides nothing for the partition and answers stopped; it posts again after the stop is lifted', async () => {
  const w = await moneyWorld();
  w.rt.stop(pk('b1'));
  assert.deepEqual(await w.post('b1', m4('m-cc4', 'b1', 'r-1', 10n)), { result: 'unavailable', why: 'stopped' });
  assert.equal(w.rt.decideRuns.reduce((a, b) => a + b, 0), 0, 'no decision');
  assert.deepEqual(w.rt.log(pk('b1')), []);
  w.rt.resume(pk('b1'));
  assert.equal((await w.post('b1', m4('m-cc4', 'b1', 'r-1', 10n))).result, 'committed');
});

test('C01 CC-5: as a receiver the ledger refuses a posting command below the fence it recorded, also after its own takeover; a higher generation is admitted', async () => {
  const w = await moneyWorld();
  const sender = (generation: number, epoch: bigint) => ({
    routedTo: { kind: 'ledger', slot: slot('b1'), generation: 0, epoch: 1n },
    sender: { kind: 'payments', partition: utf8('pay-7'), generation, epoch }, identity: utf8('cmd'),
  });
  const top = (id: string): PostMovementRequest => ({
    movementRef: id, cause: `payment ${id}`, currency: 'USD',
    lines: [{ kind: 'M1', entries: [{ ledgerAccount: 'X:p:prov', amount: '-10' }, { ledgerAccount: 'B:b1', amount: '10' }] }],
  });
  const post = (id: string, g: number, e: bigint) =>
    w.ledger.post({ partition: ledgerPartitionOfBuyer('b1'), principal: 'payments', request: top(id), envelope: sender(g, e) });
  assert.equal((await post('t-1', 0, 5n)).result, 'committed');
  assert.deepEqual(await post('t-2', 0, 4n), { result: 'routing', refusal: { code: 'STALE_SENDER', recorded: { generation: 0, epoch: 5n } } });
  await w.rt.takeover(slot('b1'));
  assert.deepEqual((await post('t-2', 0, 4n)).result, 'routing', 'the fence survives the takeover (it is in the log)');
  assert.equal((await post('t-3', 1, 1n)).result, 'committed');
  assert.equal(w.balances().get('B:b1'), 20n);
  assert.deepEqual(w.rt.log(pk('b1')).map((e) => e.entry.senderFence?.epoch), [5n, 1n], 'the fence is recorded in the applying entry');
});

test('C01 CC-6: posts replayed twice and out of order give the same ledger state', async () => {
  const reqs = [
    m4('m-a', 'b1', 'r-1', 1_500n), m4('m-b', 'b1', 'r-2', 300n), m4('m-c', 'b2', 'r-9', 7n),
    m4('m-d', 'b1', 'r-1', 1_500n, '2026-10-12T09:01:00Z'), m4('m-e', 'b2', 'r-9', 7n, '2026-10-12T09:01:00Z'),
  ];
  const once = await moneyWorld();
  for (const r of reqs) await once.post(r.lines[0]!.entries[0]!.ledgerAccount.slice(2), r);
  for (const seed of [1, 2, 3]) {
    const r = rng(seed);
    const twice = await moneyWorld();
    const order = [...reqs, ...reqs].map((x) => ({ x, k: r() })).sort((a, b) => a.k - b.k).map((o) => o.x);
    for (const q of order) await twice.post(q.lines[0]!.entries[0]!.ledgerAccount.slice(2), structuredClone(q));
    assert.deepEqual(sorted(twice), sorted(once), `seed ${seed}`);
    assert.equal(twice.events(TOPIC.movements).length, reqs.length, `seed ${seed}: one movement for each request`);
  }
});

test('C01 CC-7: every post checks leaseValid before it decides or answers; without a lease it answers not_owner and appends nothing', async () => {
  const w = await moneyWorld();
  await w.post('b1', m4('m-cc7', 'b1', 'r-1', 10n));
  const i = w.rt.trace.findIndex((t) => t.t === 'append');
  assert.deepEqual(w.rt.trace[i - 1], { t: 'leaseValid', slot: slot('b1'), valid: true });
  w.rt.setLease(slot('b1'), false);
  const n = w.rt.appends.length;
  assert.deepEqual(await w.post('b1', m4('m-cc7b', 'b1', 'r-2', 10n)), { result: 'unavailable', why: 'not_owner' });
  assert.equal(w.rt.appends.length, n);
});

test('C01 CC-8: the ledger declaration validates, generates its tables, and matches RFC-004 §B1.3 and the C06 topics', () => {
  const d = ledgerDeclaration();
  assert.deepEqual(validateDeclaration(d), []);
  const sql = kindMigration(d).statements.join('\n');
  for (const t of ['ledger_log', 'ledger_head', 'ledger_outbox', 'ledger_balance', 'ledger_line', 'ledger_movement_ref', 'ledger_chain']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${t} `), t);
  }
  assert.deepEqual(d.entryKinds.map((k) => [k.kind, k.name, k.retention]), [[1, 'movement', '7y'], [2, 'refusal', '7y']]);
  for (const p of d.projections) assert.match(p.ddl, /PRIMARY KEY \(partition[,)]/, `${p.name} is keyed by the partition first`);
  assert.ok(d.projections.every((p) => p.deletable !== true), 'no ledger row is deletable');
  assert.deepEqual(d.streams.map((s) => [s.topic, s.closure]), [
    ['ledger.movements.v1', 'resolved'], ['ledger.movements.by-buyer.v1', 'resolved'], ['ledger.movements.by-supplier.v1', 'resolved'],
    ['ledger.movements.by-external.v1', 'resolved'], ['settlement.posting-acks.v1', 'none'],
  ]);
  assert.deepEqual(d.streams.map((s) => s.key), ['partition', { field: 'view_key' }, { field: 'view_key' }, { field: 'view_key' }, { field: 'account' }]);
});
