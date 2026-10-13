/**
 * Port and runtime tests of S-LINK I1:
 * - T-09 port invariants (exit criterion 3);
 * - C02 provider tests 1 (I1 cases), 2, 3 (I1 cases) and 4 (convert attempt) (exit criterion 4);
 * - C01 consumer tests CC-1, CC-5 receiver side, CC-7, CC-8 (exit criterion 5);
 * - rebuild by replay after a stop of the owner (exit criterion 6).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8, validateDeclaration } from '@share/owner-runtime';
import { RESULTS, RuntimeDouble } from '@share/owner-runtime/testing';
import { kindMigration } from '@share/owner-migrate';
import { declaration, ENTRY, LinkOwner } from '../src/index.ts';
import { AccountStub, doubleLogReader, harness, M, resultOf, START_MS } from './support.ts';

const W = { start: M(10), end: M(11) };

// ---------------- T-09 ----------------

test('T-09 release before hold: TOMBSTONED with no digest check (R26-10)', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 2, window: W });
  await h.stub.release(h.stub.releaseCmd(r.request, r.deadline));
  assert.equal(resultOf(await h.stub.hold(r)), 'REFUSED:"TOMBSTONED"');
  // Another body with the same identity is also TOMBSTONED, never MISMATCH.
  assert.equal(resultOf(await h.stub.hold({ ...r, rateMbps: 9 })), 'REFUSED:"TOMBSTONED"');
});

test('T-09 duplicate commands get the recorded reply and write nothing', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 2, window: W });
  const first = await h.stub.hold(r);
  const entries = h.rt.log(utf8(h.link)).length;
  assert.deepEqual(await h.stub.hold(r), first);
  const c = h.stub.convertCmd(r);
  const conv = await h.stub.convert(c);
  assert.deepEqual(await h.stub.convert(c), conv);
  const rel = h.stub.releaseCmd(h.stub.newRequest(), r.deadline);
  const relReply = await h.stub.release(rel);
  assert.deepEqual(await h.stub.release(rel), relReply);
  assert.equal(h.rt.log(utf8(h.link)).length, entries + 2, 'only the first convert and the first release write entries');
});

test('T-09 convert without a hold answers NO_HOLD and alerts', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 2, window: W });
  assert.equal(resultOf(await h.stub.convert(h.stub.convertCmd(r))), 'NO_HOLD');
  assert.ok(h.owner.alerts.some((a) => a.kind === 'NO_HOLD'));
});

test('T-09 hold at D_c is refused DEADLINE_PASSED', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 2, window: W, deadlineInMs: 10_000 });
  r.commitFence = START_MS + 5;
  h.rt.advance(5);   // ts = D_c exactly (wall part)
  assert.equal(resultOf(await h.stub.hold(r)), 'REFUSED:"DEADLINE_PASSED"');
});

// ---------------- C02 provider test 1 (I1 cases) ----------------

test('C02 provider test 1: hold decision table (TOMBSTONED, repeat after release, ts ≥ D_c, NO_FIT, IN_FLIGHT); tombstone after each refusal', async () => {
  const h = await harness();
  // TOMBSTONED (record made by a release).
  const t = h.stub.holdCmd({ rate: 1, window: W });
  await h.stub.release(h.stub.releaseCmd(t.request, t.deadline));
  assert.equal(resultOf(await h.stub.hold(t)), 'REFUSED:"TOMBSTONED"');
  // A held, then released request returns RELEASED.
  const r = h.stub.holdCmd({ rate: 1, window: W });
  await h.stub.hold(r);
  await h.stub.release(h.stub.releaseCmd(r.request, r.deadline));
  assert.equal(resultOf(await h.stub.hold(r)), 'RELEASED');
  // ts ≥ D_c.
  const d = h.stub.holdCmd({ rate: 1, window: W, deadlineInMs: 100 });
  assert.equal(resultOf(await h.stub.hold(d)), 'REFUSED:"DEADLINE_PASSED"');
  // NO_FIT and IN_FLIGHT.
  const big = await h.stub.book({ rate: 7, window: W });
  assert.equal(resultOf(big.convert), 'CONVERTED');
  const nf = h.stub.holdCmd({ rate: 4, window: W });
  assert.equal(resultOf(await h.stub.hold(nf)), 'REFUSED:"NO_FIT"');
  await h.stub.hold(h.stub.holdCmd({ rate: 2, window: W }));
  const inf = h.stub.holdCmd({ rate: 2, window: W });
  assert.equal(resultOf(await h.stub.hold(inf)), 'REFUSED:"IN_FLIGHT"');
  for (const x of [d, nf, inf]) {
    const rec = h.owner.stateOf(h.link)?.recordState(x.request);
    assert.equal(rec?.tombstoneUntil, x.deadline + 60_000, 'each refusal records a tombstone');
  }
});

test('C02 provider test 1: wait = true where it would wait answers WAITING(1) and writes one Hold entry (I3 replaces the I1 UNAVAILABLE)', async () => {
  const h = await harness();
  const blocker = h.stub.holdCmd({ rate: 6, window: W });
  await h.stub.hold(blocker);
  const n = h.rt.log(utf8(h.link)).length;
  const r = await h.stub.hold(h.stub.holdCmd({ rate: 5, window: W, wait: true }));
  assert.equal(resultOf(r), 'WAITING');
  assert.deepEqual([(r as { attempt: number }).attempt, (r as { aheadDeadline: number }).aheadDeadline], [1, blocker.deadline]);
  assert.equal(h.rt.log(utf8(h.link)).length, n + 1);
  assert.equal(h.rt.log(utf8(h.link)).at(-1)?.entry.kind, ENTRY.Hold);
  // wait = true that fits is HELD as usual.
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 4, window: W, wait: true }))), 'HELD');
});

// ---------------- C02 provider test 2 ----------------

test('C02 provider test 2: arrival order (P1-S77); a hold sent again gets its first verdict', async () => {
  const h = await harness();
  await h.stub.book({ rate: 8, window: W });
  const x = h.stub.holdCmd({ rate: 2, window: W, account: 'b1' });   // received first by its account
  const y = h.stub.holdCmd({ rate: 2, window: W, account: 'b2' });
  const ry = await h.stub.hold(y);
  const rx = await h.stub.hold(x);
  assert.deepEqual([resultOf(ry), resultOf(rx)], ['HELD', 'REFUSED:"IN_FLIGHT"']);
  await h.stub.release(h.stub.releaseCmd(y.request, y.deadline));
  assert.deepEqual(await h.stub.hold(x), rx);
  assert.deepEqual(resultOf(await h.stub.hold(y)), 'RELEASED');
});

// ---------------- C02 provider test 3 ----------------

test('C02 provider test 3: duplicate, MISMATCH (nothing changes), changed envelope is a duplicate', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 3, window: W });
  const first = await h.stub.hold(r);
  const occ = h.owner.stateOf(h.link)?.occAll.entries();
  const n = h.rt.log(utf8(h.link)).length;
  assert.equal(resultOf(await h.stub.hold({ ...r, rateMbps: 4 })), 'MISMATCH');
  assert.deepEqual(h.owner.stateOf(h.link)?.occAll.entries(), occ);
  assert.equal(h.rt.log(utf8(h.link)).length, n);
  assert.ok(h.owner.alerts.some((a) => a.kind === 'MISMATCH'));
  // Same body, a new envelope (new identity, higher sender epoch): a duplicate.
  h.stub.epoch = 2n;
  const env = h.stub.envelope('b1');
  assert.deepEqual(await h.stub.hold(r, env), first);
});

// ---------------- C02 provider test 4 (I1 case) ----------------

test('C02 provider test 4: convert with another attempt gets MISMATCH', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 3, window: W });
  await h.stub.hold(r);
  assert.equal(resultOf(await h.stub.convert(h.stub.convertCmd(r, 2))), 'MISMATCH');
  assert.equal(resultOf(await h.stub.convert(h.stub.convertCmd(r, 1))), 'CONVERTED');
  assert.equal(resultOf(await h.stub.convert(h.stub.convertCmd(r, 2))), 'MISMATCH');
});

// ---------------- C01 CC-1 ----------------

test('CC-1: every AppendResult (and an unknown one) gets the C01 §3.2 action; no answer before Committed', async () => {
  const h = await harness();
  const send = (rate: number) => h.stub.hold(h.stub.holdCmd({ rate, window: W }));
  // Retry, Ambiguous and an unknown result: proposed again with the same commands, then Committed.
  h.rt.scriptAppend(RESULTS.Retry(), RESULTS.Ambiguous(), RESULTS.Unknown());
  assert.equal(resultOf(await send(1)), 'HELD');
  assert.ok(h.owner.alerts.some((a) => a.kind === 'UNKNOWN_APPEND_RESULT'));
  // Retry every time: not known to be committed, so UNAVAILABLE (the sender sends again).
  h.rt.scriptAppend(RESULTS.Retry(), RESULTS.Retry(), RESULTS.Retry(), RESULTS.Retry());
  const again = h.stub.holdCmd({ rate: 1, window: W });
  assert.equal(resultOf(await h.stub.hold(again)), 'UNAVAILABLE');
  assert.equal(resultOf(await h.stub.hold(again)), 'HELD', 'sent again with the same identity');
  const cases: Array<[ReturnType<typeof RESULTS[keyof typeof RESULTS]>, string]> = [
    [RESULTS.Moving(), 'MOVING'], [RESULTS.Moved(3, 1), 'MOVED'], [RESULTS.StaleEpoch(), 'STALE_EPOCH'],
    [RESULTS.Stopped(), 'STOPPED'], [RESULTS.Overloaded(50), 'OVERLOADED'], [RESULTS.ConditionFailed('x'), 'HELD'],
  ];
  for (const [res, want] of cases) {
    const before = h.owner.stateOf(h.link)?.occAll.entries();
    h.rt.scriptAppend(res);
    const r = await send(1);
    if (want !== 'HELD') {
      assert.equal(resultOf(r), want, `result ${res.r}`);
      await h.owner.idle();
      assert.deepEqual(h.owner.stateOf(h.link)?.occAll.entries(), before, `${res.r}: no effect in memory`);
    } else {
      assert.equal(resultOf(r), 'HELD', 'ConditionFailed of a call with entries is proposed again');
    }
  }
});

test('CC-1: decide re-runs on restart and the state is decided again from the committed state', async () => {
  const h = await harness();
  h.rt.scriptRestarts(3);
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 10, window: W }))), 'HELD');
  assert.equal(h.owner.stateOf(h.link)?.occAll.peak(W.start, W.end), 10);
});

// ---------------- C01 CC-5 (receiver side) ----------------

test('CC-5 receiver: routing refusals and admitCommand below the recorded fence, also after a takeover', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 1, window: W });
  const slot = h.rt.route('link', utf8(h.link)).slot;
  assert.equal(resultOf(await h.stub.hold(r, h.stub.envelope('b1', { slot: (slot + 1) % 256 }))), 'NOT_OWNER');
  assert.equal(resultOf(await h.stub.hold(r, h.stub.envelope('b1', { epoch: 9n }))), 'STALE_EPOCH');
  assert.equal(resultOf(await h.stub.hold(r, h.stub.envelope('b1', { generation: 4 }))), 'MOVED');
  h.stub.epoch = 3n;
  assert.equal(resultOf(await h.stub.hold(r)), 'HELD');
  h.stub.epoch = 2n;   // a deposed account holder
  const stale = await h.stub.hold(h.stub.holdCmd({ rate: 1, window: W }));
  assert.equal(resultOf(stale), 'STALE_SENDER');
  // After the link's own takeover the fence still holds (the owner rebuilds it from the log).
  await h.rt.takeover(slot);
  const after = await h.stub.hold(h.stub.holdCmd({ rate: 1, window: W }));
  assert.equal(resultOf(after), 'STALE_SENDER');
  // A fresh owner process with no runtime high-water: the fence comes from the replayed log.
  const owner2 = new LinkOwner(h.rt, { readLog: doubleLogReader(h.rt) });
  const stub2 = new AccountStub(h.rt, owner2, h.link);
  stub2.epoch = 3n;
  await stub2.hold(stub2.holdCmd({ rate: 1, window: W }));   // loads the link
  stub2.epoch = 2n;
  assert.equal(resultOf(await stub2.hold(stub2.holdCmd({ rate: 1, window: W }))), 'STALE_SENDER');
});

// ---------------- C01 CC-7 ----------------

test('CC-7: every reply from memory comes immediately after a valid leaseValid; no lease, no answer', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 1, window: W });
  await Promise.all([h.stub.hold(r), h.stub.hold(h.stub.holdCmd({ rate: 2, window: W })), h.stub.hold(r)]);
  await h.stub.convert(h.stub.convertCmd(r));
  assert.ok(h.rt.trace.some((t) => t.t === 'reply'));
  assert.deepEqual(h.rt.unleasedActions(), []);
  const slot = h.rt.route('link', utf8(h.link)).slot;
  h.rt.setLease(slot, false);
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 1, window: W }))), 'NOT_OWNER');
});

// ---------------- C01 CC-8 ----------------

test('CC-8: the declaration matches RFC-001 §7.1, §7.3 and §11.1, and generates its tables', () => {
  assert.deepEqual(validateDeclaration(declaration), []);
  assert.equal(declaration.kind, 'link');
  const names = declaration.entryKinds.map((e) => e.name);
  for (const n of ['Init', 'Takeover', 'Policy', 'Registry', 'Tick', 'Hold', 'Convert', 'Release', 'MarkWaiting', 'YieldAccept',
    'YieldRefuse', 'DisplaceAccept', 'EndLeg', 'ReduceParts', 'CutAnswer', 'OfferHold', 'OfferAccept', 'OfferMoveAt', 'OfferRelease',
    'Outage', 'Restoration', 'Maintenance', 'MaintenanceCancel', 'ReductionAnnounce', 'ReductionEffective', 'ReductionStep',
    'Increase', 'Checkpoint', 'Compact', 'Alert']) assert.ok(names.includes(n), `entry kind ${n}`);
  const p = Object.fromEntries(declaration.projections.map((x) => [x.name, x]));
  assert.ok(p['request']?.rowTtl && !p['request'].deletable, 'link_request: row TTL, not deletable');
  assert.ok(p['displacement']?.deletable && p['displacement'].readableBy?.length === 1, 'link_displacement: deletable, read by the account owner');
  assert.ok(p['reduction_cut']?.deletable);
  assert.ok(!p['projection']?.deletable);
  for (const x of declaration.projections) assert.match(x.ddl, /PRIMARY KEY \(link_id/, `${x.name} is keyed led by the link`);
  const s = Object.fromEntries(declaration.streams.map((x) => [x.name, x]));
  assert.equal(s['schedule']?.topic, 'link.schedule.v1');
  assert.equal(s['schedule']?.closure, 'closedPerLink');
  assert.equal(s['alert']?.topic, 'link.alert.v1');
  const sql = kindMigration(declaration).statements.join('\n');
  for (const t of ['link_log', 'link_head', 'link_outbox', 'link_request', 'link_displacement']) assert.match(sql, new RegExp(t));
});

// ---------------- exit criterion 6: rebuild by replay ----------------

test('should rebuild by replay, find no outcome difference and answer a repeat with its recorded reply when a new holder rebuilds', async () => {
  const h = await harness();
  const a = h.stub.holdCmd({ rate: 4, window: W });
  const b = h.stub.holdCmd({ rate: 6, window: W });
  const c = h.stub.holdCmd({ rate: 1, window: W });
  const ra = await h.stub.hold(a);
  await h.stub.hold(b);
  const rc = await h.stub.hold(c);
  await h.stub.convert(h.stub.convertCmd(a));
  await h.stub.release(h.stub.releaseCmd(b.request, b.deadline));
  const occ = h.owner.stateOf(h.link)?.occAll.entries();

  // Stop the owner process. A new process takes the slot over (new epoch) and rebuilds from the log.
  const slot = h.rt.route('link', utf8(h.link)).slot;
  const rt = h.rt as RuntimeDouble;
  rt.release(slot, 'taken');
  const owner2 = new LinkOwner(rt, { readLog: doubleLogReader(rt), links: [h.link], onReply: (l) => rt.recordReply(l) });
  rt.attach(owner2);
  await rt.acquire(slot);
  assert.deepEqual(owner2.alerts, [], 'no outcome difference');
  assert.deepEqual(owner2.stateOf(h.link)?.occAll.entries(), occ);
  const stub2 = new AccountStub(rt, owner2, h.link);
  const again = await stub2.hold(a);
  assert.equal(resultOf(again), 'CONVERTED');
  assert.deepEqual(resultOf(await stub2.hold(c)), resultOf(rc));
  assert.equal(resultOf(ra), 'HELD');
  // The first batch of the new epoch is Takeover; the repeats wrote nothing more.
  await stub2.hold(stub2.holdCmd({ rate: 1, window: W }));
  const log = rt.log(utf8(h.link));
  const kinds = log.map((e) => e.entry.kind);
  assert.equal(kinds.filter((k) => k === ENTRY.Takeover).length, 1);
  assert.equal(log.at(-2)?.entry.kind, ENTRY.Takeover);
  assert.deepEqual(rt.unleasedActions(), []);
});

test('should stop the link (OUTCOME_MISMATCH_ON_REPLAY) when a recorded outcome changed on rebuild', async () => {
  const h = await harness();
  const a = h.stub.holdCmd({ rate: 4, window: W });
  await h.stub.hold(a);
  const entry = h.rt.log(utf8(h.link)).at(-1);
  (entry?.entry.payload as { outcome: unknown }).outcome = { result: 'REFUSED', reason: 'NO_FIT' };
  const slot = h.rt.route('link', utf8(h.link)).slot;
  const owner2 = new LinkOwner(h.rt, { readLog: doubleLogReader(h.rt), links: [h.link] });
  h.rt.attach(owner2);
  await h.rt.takeover(slot);
  assert.ok(owner2.alerts.some((x) => x.kind === 'OUTCOME_MISMATCH_ON_REPLAY'));
  const stub2 = new AccountStub(h.rt, owner2, h.link);
  assert.equal(resultOf(await stub2.hold(a)), 'STOPPED');
});
