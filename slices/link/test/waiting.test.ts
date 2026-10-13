/**
 * S-LINK I3 tests at the C02 boundary, with the recorded account-owner stub (S-LINK plan, S-LINK-I3):
 * - the scenarios P1-S07, P1-S11 and P1-S34;
 * - T-07 (no yield parts): hold, wait, grant in priority order, `wait = false` refused at the link, a waiter
 *   refused when the request ahead converts, a waiter past D_c skipped, the scan budget and its `Tick`
 *   continuations (exit criterion 1);
 * - T-08b: notifications as state messages, applied by a consumer stub with the C02 rules (exit criterion 2);
 * - C02 provider tests 1 (`WAITING`), 4 (a grant keeps the attempt) and 13 (first two items) at the owner
 *   (exit criterion 3). The C02 suite runs them too (`contract.c02.test.ts`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hlcToWallMs, utf8, type HlcTs, type NotificationOut } from '@share/owner-runtime';
import {
  DEFAULT_POLICY, ENTRY, LINK_KIND, LinkOwner, requestKey, type HoldCmd, type QueryCmd, type RequestId, type WaitingNotification,
} from '../src/index.ts';
import { doubleLogReader, harness, M, resultOf, type Harness } from './support.ts';

const H = (hh: number, mm = 0) => M(hh, mm);
const W = { start: H(10), end: H(11) };

/** The decision part of a reply, without the link stamp. */
function body(r: unknown): Record<string, unknown> {
  const { linkFence: _f, linkSeq: _s, ...rest } = r as Record<string, unknown>;
  return rest;
}

function seqOf(r: unknown): bigint {
  return (r as { linkSeq: bigint }).linkSeq;
}

function queryCmd(h: Harness, request: RequestId): QueryCmd {
  return { link: h.link, receiverPartition: h.link, request };
}

async function query(h: Harness, request: RequestId): Promise<Record<string, unknown>> {
  return body(await h.owner.query(h.stub.envelope(request.partition), queryCmd(h, request)));
}

/** The relayed notifications (outbox rows) as C02 bodies, in order. */
function relayed(h: Harness): WaitingNotification[] {
  return h.rt.notificationsSent.map((n) => n.body as WaitingNotification);
}

/** The identity and the content of a notification, without the fence. */
function notice(n: WaitingNotification): Record<string, unknown> {
  const { linkFence: _f, ...rest } = n;
  return { ...rest, request: requestKey(n.request) };
}

function kinds(h: Harness): number[] {
  return h.rt.log(utf8(h.link)).map((e) => e.entry.kind);
}

/** A hold command with a set request age (the HLC of `ms`), so a test fixes the priority order. */
function aged(cmd: HoldCmd, ms: number, logical = 0): HoldCmd {
  return { ...cmd, requestAge: `${BigInt(ms) * 1_000_000n}.${String(logical).padStart(10, '0')}` as HlcTs };
}

const nowMs = (h: Harness): number => hlcToWallMs(h.rt.now().ts);

// ---------------- scenarios ----------------

test('P1-S07 capacity held for a pending request is not sold; the next booking waits, neither confirmed nor rejected', async () => {
  const h = await harness();
  const pending = h.stub.holdCmd({ rate: 6, window: W, account: 'pending', deadlineInMs: 20_000 });
  assert.equal(resultOf(await h.stub.hold(pending)), 'HELD');
  const next = h.stub.holdCmd({ rate: 5, window: W, wait: true });
  assert.deepEqual(body(await h.stub.hold(next)), { result: 'WAITING', attempt: 1, aheadDeadline: pending.deadline });
  assert.deepEqual(await query(h, next.request), { state: 'WAITING', attempt: 1, aheadDeadline: pending.deadline });
  const st = h.owner.stateOf(h.link);
  assert.equal(st?.occAll.peak(W.start, W.end), 6, 'the waiter holds nothing');
  assert.equal(st?.occFirm.peak(W.start, W.end), 0);
  assert.deepEqual(h.rt.notificationsSent, [], 'registration is the WAITING answer, not a notification');
  assert.equal(st?.recordState(next.request)?.tombstoneUntil, undefined, 'a waiter is not refused and has no tombstone');
});

test('P1-S11 a booking blocked only by capacity in flight waits and is confirmed when that capacity is released within its deadline', async () => {
  const h = await harness();
  const route = h.stub.holdCmd({ rate: 6, window: W, account: 'route', deadlineInMs: 20_000 });
  assert.equal(resultOf(await h.stub.hold(route)), 'HELD');
  const single = h.stub.holdCmd({ rate: 5, window: W, wait: true, deadlineInMs: 30_000 });
  assert.equal(resultOf(await h.stub.hold(single)), 'WAITING');
  h.rt.advance(5_000);
  const rel = await h.stub.release(h.stub.releaseCmd(route.request, route.deadline));
  assert.equal(resultOf(rel), 'RELEASED');
  assert.deepEqual(relayed(h).map(notice), [{ linkSeq: seqOf(rel), link: h.link, request: requestKey(single.request), attempt: 1, kind: 'GRANTED' }],
    'the grant is in the entry that frees the capacity');
  assert.deepEqual(await query(h, single.request), { state: 'HELD', attempt: 1 });
  assert.equal(h.owner.stateOf(h.link)?.occAll.peak(W.start, W.end), 5);
  assert.deepEqual(body(await h.stub.convert(h.stub.convertCmd(single, 1))), { result: 'CONVERTED', part: `p-${requestKey(single.request)}` });
  assert.ok(!kinds(h).includes(ENTRY.Tick), 'one waiter needs no continuation');
});

test('P1-S34 a booking that must wait is answered WAITING (pending) once its entry commits, while the blocker still holds', async () => {
  const h = await harness();
  const route = h.stub.holdCmd({ rate: 6, window: W, account: 'route', deadlineInMs: 20_000 });
  await h.stub.hold(route);
  const appends = h.rt.appends.length;
  const r = await h.stub.hold(h.stub.holdCmd({ rate: 5, window: W, wait: true }));
  assert.deepEqual(body(r), { result: 'WAITING', attempt: 1, aheadDeadline: route.deadline });
  assert.equal(h.rt.appends.length, appends + 1, 'answered after one batch: the answer does not wait for a grant');
  assert.equal(seqOf(r), h.rt.headOf(utf8(h.link)).seq);
  assert.deepEqual(await query(h, route.request), { state: 'HELD', attempt: 1 });
});

// ---------------- T-07 ----------------

test('T-07 released capacity goes to the oldest waiter that it fits, whatever the arrival order; the other gets a new waiting notice', async () => {
  const h = await harness();
  const t0 = nowMs(h);
  const blocker = h.stub.holdCmd({ rate: 10, window: W, account: 'blk', deadlineInMs: 10_000 });
  await h.stub.hold(blocker);
  const older = aged(h.stub.holdCmd({ rate: 6, window: W, wait: true, account: 'old', deadlineInMs: 20_000 }), t0 - 2);
  const younger = aged(h.stub.holdCmd({ rate: 6, window: W, wait: true, account: 'young', deadlineInMs: 30_000 }), t0 - 1);
  assert.equal(resultOf(await h.stub.hold(younger)), 'WAITING');
  assert.equal(resultOf(await h.stub.hold(older)), 'WAITING');
  const rel = await h.stub.release(h.stub.releaseCmd(blocker.request, blocker.deadline));
  assert.deepEqual(relayed(h).map(notice), [
    { linkSeq: seqOf(rel), link: h.link, request: requestKey(older.request), attempt: 1, kind: 'GRANTED' },
    { linkSeq: seqOf(rel), link: h.link, request: requestKey(younger.request), attempt: 1, kind: 'WAITING_NOTICE', aheadDeadline: older.deadline },
  ]);
  assert.deepEqual(await query(h, younger.request), { state: 'WAITING', attempt: 1, aheadDeadline: older.deadline });
});

test('T-07 waiters with the same request_age are granted in the order of their request identity', async () => {
  const h = await harness();
  const t0 = nowMs(h);
  const blocker = h.stub.holdCmd({ rate: 10, window: W, account: 'blk' });
  await h.stub.hold(blocker);
  const b2 = aged(h.stub.holdCmd({ rate: 6, window: W, wait: true, account: 'b2' }), t0);
  const a9 = aged(h.stub.holdCmd({ rate: 6, window: W, wait: true, account: 'a9' }), t0);
  await h.stub.hold(b2);
  await h.stub.hold(a9);
  await h.stub.release(h.stub.releaseCmd(blocker.request, blocker.deadline));
  assert.deepEqual(relayed(h).filter((n) => n.kind === 'GRANTED').map((n) => requestKey(n.request)), [requestKey(a9.request)]);
  assert.equal((await query(h, b2.request))['state'], 'WAITING');
});

test('T-07 a younger waiter that fits where an older one does not is granted; the older is told its latest blocker as it is examined', async () => {
  const h = await harness();
  const t0 = nowMs(h);
  const a = h.stub.holdCmd({ rate: 5, window: W, account: 'a', deadlineInMs: 10_000 });
  const b = h.stub.holdCmd({ rate: 4, window: W, account: 'b', deadlineInMs: 25_000 });
  await h.stub.hold(a);
  await h.stub.hold(b);
  const older = aged(h.stub.holdCmd({ rate: 6, window: W, wait: true, account: 'old', deadlineInMs: 30_000 }), t0 - 2);
  const younger = aged(h.stub.holdCmd({ rate: 3, window: W, wait: true, account: 'young', deadlineInMs: 40_000 }), t0 - 1);
  assert.deepEqual(body(await h.stub.hold(older)), { result: 'WAITING', attempt: 1, aheadDeadline: b.deadline });
  assert.deepEqual(body(await h.stub.hold(younger)), { result: 'WAITING', attempt: 1, aheadDeadline: b.deadline });
  await h.stub.release(h.stub.releaseCmd(b.request, b.deadline));
  // RFC-001 §4.3: the scan examines the older waiter first (blocker a only), then grants the younger one.
  assert.deepEqual(relayed(h).map((n) => [requestKey(n.request), n.kind, 'aheadDeadline' in n ? n.aheadDeadline : null]), [
    [requestKey(older.request), 'WAITING_NOTICE', a.deadline],
    [requestKey(younger.request), 'GRANTED', null],
  ]);
  assert.equal(h.owner.stateOf(h.link)?.occAll.peak(W.start, W.end), 8);
});

test('T-07 wait = false is refused IN_FLIGHT at the link with a tombstone, registers no waiter, and a later release grants it nothing', async () => {
  const h = await harness();
  const route = h.stub.holdCmd({ rate: 6, window: W, account: 'route', deadlineInMs: 20_000 });
  await h.stub.hold(route);
  const nw = h.stub.holdCmd({ rate: 5, window: W, wait: false });
  const r = body(await h.stub.hold(nw));
  assert.deepEqual([r['result'], r['reason'], r['retryAfterMs']], ['REFUSED', 'IN_FLIGHT', 20_000]);
  assert.deepEqual(h.owner.stateOf(h.link)?.waitersInOrder(), []);
  await h.stub.release(h.stub.releaseCmd(route.request, route.deadline));
  assert.deepEqual(h.rt.notificationsSent, []);
  assert.equal((await query(h, nw.request))['state'], 'REFUSED');
  assert.equal(h.owner.stateOf(h.link)?.occAll.peak(W.start, W.end), 0);
});

test('T-07 a waiter is refused NO_FIT with a counter-offer and a tombstone when the request ahead converts', async () => {
  const h = await harness();
  const ahead = h.stub.holdCmd({ rate: 6, window: W, account: 'ahead' });
  await h.stub.hold(ahead);
  const waiter = h.stub.holdCmd({ rate: 5, window: W, wait: true, deadlineInMs: 30_000 });
  assert.equal(resultOf(await h.stub.hold(waiter)), 'WAITING');
  const conv = await h.stub.convert(h.stub.convertCmd(ahead));
  assert.equal(resultOf(conv), 'CONVERTED');
  const counterOffer = { largestRateMbps: 4, earliest: { window: { start: H(11), end: H(12) } } };
  assert.deepEqual(relayed(h).map(notice), [
    { linkSeq: seqOf(conv), link: h.link, request: requestKey(waiter.request), attempt: 1, kind: 'WAITER_REFUSED', reason: 'NO_FIT', counterOffer },
  ]);
  const refusal = { reason: 'NO_FIT', counterOffer };
  assert.deepEqual(await query(h, waiter.request), { state: 'REFUSED', refusal, tombstoneUntil: waiter.deadline + 60_000 });
  assert.deepEqual(body(await h.stub.hold(waiter)), { result: 'REFUSED', ...refusal }, 'a repeat gets the recorded refusal');
  assert.deepEqual(h.owner.stateOf(h.link)?.waitersInOrder(), []);
  const rows = await h.rt.consistentRead((tx) => tx.query<{ seq: unknown }>(
    'SELECT seq FROM link_request WHERE link_id = $1 AND request_part = $2 AND request_seq = $3',
    [h.link, waiter.request.partition, waiter.request.seq]), 'present');
  assert.deepEqual(rows.map((r) => BigInt(String(r.seq))), [seqOf(conv)], 'the converting entry writes the waiter refusal row');
  // After the memory record has gone, link_request and the converting entry give the refusal again.
  h.rt.advance(31_000 + 60_000);
  await h.stub.hold(h.stub.holdCmd({ rate: 1, window: { start: H(40), end: H(41) }, account: 'other' }));
  assert.equal(h.owner.stateOf(h.link)?.recordState(waiter.request), undefined, 'memory has no record');
  const recalled = h.owner.recalledRecords;
  assert.deepEqual(body(await h.stub.hold(waiter)), { result: 'REFUSED', ...refusal });
  assert.equal(h.owner.recalledRecords, recalled + 1);
});

test('T-07 a waiter at or after its D_c is skipped by the scan: it keeps waiting and gets nothing', async () => {
  const h = await harness();
  const blocker = h.stub.holdCmd({ rate: 6, window: W, account: 'blk', deadlineInMs: 60_000 });
  await h.stub.hold(blocker);
  const late = h.stub.holdCmd({ rate: 5, window: W, wait: true, deadlineInMs: 1_000 });
  assert.equal(resultOf(await h.stub.hold(late)), 'WAITING');
  h.rt.advance(1_000 - 420);   // ts = D_c exactly
  await h.stub.release(h.stub.releaseCmd(blocker.request, blocker.deadline));
  assert.deepEqual(h.rt.notificationsSent, []);
  assert.deepEqual(await query(h, late.request), { state: 'WAITING', attempt: 1, aheadDeadline: blocker.deadline });
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 10, window: W, account: 'next' }))), 'HELD');
});

test('T-07 a waiter one millisecond before its D_c is granted', async () => {
  const h = await harness();
  const blocker = h.stub.holdCmd({ rate: 6, window: W, account: 'blk', deadlineInMs: 60_000 });
  await h.stub.hold(blocker);
  const w = h.stub.holdCmd({ rate: 5, window: W, wait: true, deadlineInMs: 1_000 });
  await h.stub.hold(w);
  h.rt.advance(1_000 - 421);
  await h.stub.release(h.stub.releaseCmd(blocker.request, blocker.deadline));
  assert.deepEqual(relayed(h).map((n) => n.kind), ['GRANTED']);
});

test('T-07 scan budget: Tick continuations complete the scan before the next command of the batch, and a later hold that fits is held', async () => {
  const h = await harness({ policy: { ...DEFAULT_POLICY, scanSteps: 2 } });
  const t0 = nowMs(h);
  const blocker = h.stub.holdCmd({ rate: 10, window: W, account: 'blk' });
  await h.stub.hold(blocker);
  const waiters = [0, 1, 2, 3, 4].map((i) => aged(h.stub.holdCmd({ rate: 1, window: W, wait: true, account: `w${i}` }), t0 - 10 + i));
  for (const w of [...waiters].reverse()) assert.equal(resultOf(await h.stub.hold(w)), 'WAITING');
  const before = h.rt.log(utf8(h.link)).length;
  const appends = h.rt.appends.length;
  const later = h.stub.holdCmd({ rate: 5, window: W, account: 'later' });
  const notFit = h.stub.holdCmd({ rate: 1, window: W, account: 'nf' });
  const [rel, held, refused] = await Promise.all([
    h.stub.release(h.stub.releaseCmd(blocker.request, blocker.deadline)), h.stub.hold(later), h.stub.hold(notFit),
  ]);
  assert.equal(h.rt.appends.length, appends + 1, 'one batch');
  assert.deepEqual(kinds(h).slice(before), [ENTRY.Release, ENTRY.Tick, ENTRY.Tick, ENTRY.Hold, ENTRY.Hold]);
  const s = seqOf(rel);
  assert.deepEqual(relayed(h).map((n) => [requestKey(n.request), n.kind, n.linkSeq]),
    waiters.map((w, i) => [requestKey(w.request), 'GRANTED', s + BigInt(Math.floor(i / 2))]), 'two waiters for each entry, in priority order');
  assert.deepEqual([body(held), seqOf(held)], [{ result: 'HELD', attempt: 1 }, s + 3n]);
  assert.equal(resultOf(refused), 'REFUSED:"IN_FLIGHT"', 'decided after every grant');
  assert.equal(h.owner.stateOf(h.link)?.scanPending, false);
});

test('T-07 the scan counts only the waiters that overlap the freed range', async () => {
  const h = await harness({ policy: { ...DEFAULT_POLICY, scanSteps: 1 } });
  const t0 = nowMs(h);
  const elsewhere = h.stub.holdCmd({ rate: 10, window: { start: H(12), end: H(13) }, account: 'blk2' });
  const blocker = h.stub.holdCmd({ rate: 10, window: W, account: 'blk' });
  await h.stub.hold(elsewhere);
  await h.stub.hold(blocker);
  await h.stub.hold(aged(h.stub.holdCmd({ rate: 1, window: { start: H(12), end: H(13) }, wait: true, account: 'o' }), t0 - 5));
  const w = aged(h.stub.holdCmd({ rate: 1, window: W, wait: true, account: 'y' }), t0 - 1);
  await h.stub.hold(w);
  await h.stub.release(h.stub.releaseCmd(blocker.request, blocker.deadline));
  assert.ok(!kinds(h).includes(ENTRY.Tick));
  assert.deepEqual(relayed(h).map((n) => [requestKey(n.request), n.kind]), [[requestKey(w.request), 'GRANTED']]);
});

test('T-07 a release of a waiter ends it, and a later release of its blocker grants it nothing', async () => {
  const h = await harness();
  const blocker = h.stub.holdCmd({ rate: 6, window: W, account: 'blk' });
  await h.stub.hold(blocker);
  const w = h.stub.holdCmd({ rate: 5, window: W, wait: true });
  await h.stub.hold(w);
  assert.deepEqual(body(await h.stub.release(h.stub.releaseCmd(w.request, w.deadline))), { result: 'RELEASED', tombstoneUntil: w.deadline + 60_000 });
  assert.deepEqual(h.owner.stateOf(h.link)?.waitersInOrder(), []);
  await h.stub.release(h.stub.releaseCmd(blocker.request, blocker.deadline));
  assert.deepEqual(h.rt.notificationsSent, []);
  assert.deepEqual(body(await h.stub.hold(w)), { result: 'RELEASED' });
  assert.deepEqual(await query(h, w.request), { state: 'RELEASED', tombstoneUntil: w.deadline + 60_000 });
  assert.equal(h.owner.stateOf(h.link)?.occAll.peak(W.start, W.end), 0);
});

test('T-07 a repeat of a waiting hold gets the recorded WAITING with no entry, then HELD(1) after the grant; a convert of a waiter gets NO_HOLD', async () => {
  const h = await harness();
  const blocker = h.stub.holdCmd({ rate: 6, window: W, account: 'blk' });
  await h.stub.hold(blocker);
  const w = h.stub.holdCmd({ rate: 5, window: W, wait: true });
  const first = await h.stub.hold(w);
  const n = h.rt.log(utf8(h.link)).length;
  const again = await h.stub.hold(w);
  assert.deepEqual([body(again), seqOf(again)], [body(first), seqOf(first)]);
  assert.deepEqual(await h.stub.hold({ ...w, rateMbps: 4 }), { code: 'MISMATCH' });
  assert.deepEqual(await h.stub.convert(h.stub.convertCmd(w)), { code: 'NO_HOLD' });
  assert.ok(h.owner.alerts.some((a) => a.kind === 'NO_HOLD' && a.request === requestKey(w.request)));
  assert.equal(h.rt.log(utf8(h.link)).length, n, 'no repeat writes an entry');
  await h.stub.release(h.stub.releaseCmd(blocker.request, blocker.deadline));
  assert.deepEqual(body(await h.stub.hold(w)), { result: 'HELD', attempt: 1 });
});

test('T-07 a waiter whose latest blocker changes gets a new WAITING_NOTICE each time; each copy is a new outbox row', async () => {
  const h = await harness();
  const b1 = h.stub.holdCmd({ rate: 4, window: W, account: 'b1x', deadlineInMs: 10_000 });
  const b2 = h.stub.holdCmd({ rate: 2, window: W, account: 'b2x', deadlineInMs: 25_000 });
  const b3 = h.stub.holdCmd({ rate: 2, window: W, account: 'b3x', deadlineInMs: 40_000 });
  for (const b of [b1, b2, b3]) await h.stub.hold(b);
  const w = h.stub.holdCmd({ rate: 7, window: W, wait: true, deadlineInMs: 50_000 });
  assert.deepEqual(body(await h.stub.hold(w)), { result: 'WAITING', attempt: 1, aheadDeadline: b3.deadline });
  const r3 = await h.stub.release(h.stub.releaseCmd(b3.request, b3.deadline));
  const r2 = await h.stub.release(h.stub.releaseCmd(b2.request, b2.deadline));
  assert.deepEqual(await query(h, w.request), { state: 'WAITING', attempt: 1, aheadDeadline: b1.deadline });
  const repeat = await h.stub.hold(w);
  assert.deepEqual([body(repeat), seqOf(repeat)], [{ result: 'WAITING', attempt: 1, aheadDeadline: b1.deadline }, seqOf(r2)]);
  const r1 = await h.stub.release(h.stub.releaseCmd(b1.request, b1.deadline));
  assert.deepEqual(relayed(h).map((n) => [n.kind, n.linkSeq, 'aheadDeadline' in n ? n.aheadDeadline : null]), [
    ['WAITING_NOTICE', seqOf(r3), b2.deadline], ['WAITING_NOTICE', seqOf(r2), b1.deadline], ['GRANTED', seqOf(r1), null],
  ]);
  const ids = h.rt.notificationsSent.map((n) => `${Buffer.from(n.id.subject).toString()}|${n.id.attempt}|${n.id.kind}`);
  assert.equal(new Set(ids).size, 3, 'each WAITING_NOTICE copy has its own C01 notification id');
  assert.ok(h.rt.notificationsSent.every((n) => n.to.kind === 'account' && Buffer.from(n.to.partition).equals(Buffer.from(w.account))));
});

test('T-07 a waiter with an open-ended window is granted when an open-ended hold is released', async () => {
  const h = await harness();
  const blocker = h.stub.holdCmd({ rate: 8, window: { start: H(10), end: null }, account: 'blk' });
  await h.stub.hold(blocker);
  const w = h.stub.holdCmd({ rate: 3, window: { start: H(20), end: null }, wait: true });
  assert.deepEqual(body(await h.stub.hold(w)), { result: 'WAITING', attempt: 1, aheadDeadline: blocker.deadline });
  await h.stub.release(h.stub.releaseCmd(blocker.request, blocker.deadline));
  assert.deepEqual(relayed(h).map((n) => n.kind), ['GRANTED']);
  assert.equal(h.owner.stateOf(h.link)?.occAll.peak(H(0), null), 3);
});

test('should replay waiters, grants and Tick continuations to the same state and notices after a takeover', async () => {
  const h = await harness({ policy: { ...DEFAULT_POLICY, scanSteps: 1 } });
  const blocker = h.stub.holdCmd({ rate: 10, window: W, account: 'blk' });
  await h.stub.hold(blocker);
  const ws = [0, 1, 2].map((i) => h.stub.holdCmd({ rate: 4, window: W, wait: true, account: `w${i}` }));
  for (const w of ws) await h.stub.hold(w);
  await h.stub.release(h.stub.releaseCmd(blocker.request, blocker.deadline));
  const before = h.owner.stateOf(h.link);
  const want = { holds: before?.holdsInOrder().map((x) => requestKey(x.request)), waiters: before?.waitersInOrder().map((x) => requestKey(x.cmd.request)) };
  assert.deepEqual(want, { holds: ws.slice(0, 2).map((w) => requestKey(w.request)), waiters: [requestKey((ws[2] as HoldCmd).request)] });
  const slot = h.rt.route(LINK_KIND, utf8(h.link)).slot;
  h.rt.release(slot, 'taken');
  const owner2 = new LinkOwner(h.rt, { readLog: doubleLogReader(h.rt), links: [h.link] });
  h.rt.attach(owner2);
  await h.rt.acquire(slot);
  const after = owner2.stateOf(h.link);
  assert.deepEqual({ holds: after?.holdsInOrder().map((x) => requestKey(x.request)), waiters: after?.waitersInOrder().map((x) => requestKey(x.cmd.request)) }, want);
  assert.deepEqual(owner2.alerts, [], 'every replayed outcome and notice is equal');
  const env = h.stub.envelope((ws[2] as HoldCmd).account);
  assert.deepEqual(body(await owner2.query(env, queryCmd(h, (ws[2] as HoldCmd).request))), { state: 'WAITING', attempt: 1, aheadDeadline: (ws[1] as HoldCmd).deadline });
});

// ---------------- T-08b ----------------

/**
 * The C02 consumer rules for waiting-port notifications ("Link waiting port", "Idempotency"): apply each identity
 * (link, request, attempt, kind) that is new, however late, with no high-water rule across identities; within one
 * identity, only a `WAITING_NOTICE` with a higher `linkSeq` replaces the copy.
 */
class NoticeInbox {
  readonly applied = new Map<string, WaitingNotification>();
  changes = 0;

  deliver(n: NotificationOut): void {
    const b = n.body as WaitingNotification;
    const id = `${b.link}|${requestKey(b.request)}|${b.attempt}|${b.kind}`;
    const cur = this.applied.get(id);
    if (cur && !(b.kind === 'WAITING_NOTICE' && b.linkSeq > cur.linkSeq)) return;
    this.applied.set(id, b);
    this.changes += 1;
  }

  of(request: RequestId): string[] {
    return [...this.applied.values()].filter((n) => requestKey(n.request) === requestKey(request))
      .map((n) => ('aheadDeadline' in n ? `${n.kind}:${n.aheadDeadline}` : n.kind));
  }
}

/** Two windows: X waits on W1 and is granted (entry s1); later Y on W2 gets a newer WAITING_NOTICE (entry s2). */
async function twoWindows(): Promise<{ h: Harness; x: HoldCmd; y: HoldCmd; y1: HoldCmd }> {
  const h = await harness();
  const W2 = { start: H(12), end: H(13) };
  const b1 = h.stub.holdCmd({ rate: 10, window: W, account: 'b1x' });
  const y1 = h.stub.holdCmd({ rate: 5, window: W2, account: 'y1', deadlineInMs: 10_000 });
  const y2 = h.stub.holdCmd({ rate: 5, window: W2, account: 'y2', deadlineInMs: 25_000 });
  for (const b of [b1, y1, y2]) await h.stub.hold(b);
  const x = h.stub.holdCmd({ rate: 5, window: W, wait: true, account: 'x' });
  const y = h.stub.holdCmd({ rate: 6, window: W2, wait: true, account: 'y' });
  await h.stub.hold(x);
  await h.stub.hold(y);
  await h.stub.release(h.stub.releaseCmd(b1.request, b1.deadline));
  await h.stub.release(h.stub.releaseCmd(y2.request, y2.deadline));
  return { h, x, y, y1 };
}

test('T-08b a GRANTED lost on the push and relayed after a newer WAITING_NOTICE of another request is applied; duplicates have no effect', async () => {
  const { h, x, y, y1 } = await twoWindows();
  assert.deepEqual(relayed(h).map((n) => n.kind), ['GRANTED', 'WAITING_NOTICE']);
  const [granted, newer] = h.rt.notificationsSent as [NotificationOut, NotificationOut];
  assert.ok((newer.body as WaitingNotification).linkSeq > (granted.body as WaitingNotification).linkSeq);
  const inbox = new NoticeInbox();
  for (const n of h.pushed) if (n.id.kind !== 'GRANTED') inbox.deliver(n);   // the push of GRANTED is lost
  assert.deepEqual(inbox.of(x.request), []);
  inbox.deliver(newer);
  inbox.deliver(granted);   // the relay, late, after the newer notice
  assert.deepEqual(inbox.of(x.request), ['GRANTED']);
  assert.deepEqual(inbox.of(y.request), [`WAITING_NOTICE:${y1.deadline}`]);
  const changes = inbox.changes;
  for (const n of [...h.pushed, ...h.rt.notificationsSent, granted]) inbox.deliver(n);
  assert.equal(inbox.changes, changes, 'a duplicate by (request, attempt, kind) has no effect');
});

test('T-08b query restores a lost notice: HELD(1) for a lost GRANTED, WAITING with the latest blocker for a lost WAITING_NOTICE', async () => {
  const { h, x, y, y1 } = await twoWindows();
  assert.deepEqual(await query(h, x.request), { state: 'HELD', attempt: 1 });
  assert.deepEqual(await query(h, y.request), { state: 'WAITING', attempt: 1, aheadDeadline: y1.deadline });
});

test('C02 provider test 13 the identity and the content are the same on the relay and on the push', async () => {
  const { h } = await twoWindows();
  assert.equal(h.pushed.length, 2);
  assert.deepEqual(h.pushed, h.rt.notificationsSent);
  for (const n of h.pushed) {
    const b = n.body as WaitingNotification;
    assert.deepEqual([n.id.attempt, n.id.kind], [b.attempt, b.kind]);
    assert.equal(b.link, h.link);
    assert.deepEqual(b.linkFence, { generation: h.rt.generation(utf8(h.link)), epoch: h.rt.epoch(h.rt.route(LINK_KIND, utf8(h.link)).slot) });
  }
});

test('should push no notification when the lease is not valid after the commit; the relay row stays', async () => {
  const h = await harness();
  const blocker = h.stub.holdCmd({ rate: 6, window: W, account: 'blk' });
  await h.stub.hold(blocker);
  const w = h.stub.holdCmd({ rate: 5, window: W, wait: true });
  await h.stub.hold(w);
  const pushedBefore = h.pushed.length;
  let checks = 0;
  const leaseValid = h.rt.leaseValid.bind(h.rt);
  h.rt.leaseValid = (s) => {
    checks += 1;
    // Valid for the routing check and the reply, then lost before the push.
    return checks <= 2 ? leaseValid(s) : { valid: false } as ReturnType<typeof leaseValid>;
  };
  const rel = await h.stub.release(h.stub.releaseCmd(blocker.request, blocker.deadline));
  h.rt.leaseValid = leaseValid;
  assert.equal(resultOf(rel), 'RELEASED');
  assert.equal(checks, 3, 'the routing check, the reply and the push each call leaseValid');
  assert.equal(h.pushed.length, pushedBefore);
  assert.deepEqual(relayed(h).map((n) => n.kind), ['GRANTED']);
});

// ---------------- exit criterion 5, step count part ----------------

test('should complete the scan of a flash crowd of 7,500 waiters in the release entry and 7 Tick continuations, in one batch', async () => {
  const h = await harness();
  const blocker = h.stub.holdCmd({ rate: 10, window: W, account: 'blk', deadlineInMs: 10_000 });
  await h.stub.hold(blocker);
  const crowd = Array.from({ length: 7_500 }, (_, i) => h.stub.holdCmd({ rate: 1, window: W, wait: true, account: `c${i % 50}`, deadlineInMs: 20_000 }));
  const replies = await Promise.all(crowd.map((c) => h.stub.hold(c)));
  assert.ok(replies.every((r) => resultOf(r) === 'WAITING'));
  const before = h.rt.log(utf8(h.link)).length;
  const appends = h.rt.appends.length;
  await h.stub.release(h.stub.releaseCmd(blocker.request, blocker.deadline));
  assert.equal(h.rt.appends.length, appends + 1);
  assert.deepEqual(kinds(h).slice(before), [ENTRY.Release, ...Array.from({ length: 7 }, () => ENTRY.Tick)]);
  const n = relayed(h);
  assert.equal(n.filter((x) => x.kind === 'GRANTED').length, 10);
  assert.equal(n.filter((x) => x.kind === 'WAITING_NOTICE').length, 7_490, 'every waiter of the range is examined');
  assert.equal(h.owner.stateOf(h.link)?.waitersInOrder().length, 7_490);
});
