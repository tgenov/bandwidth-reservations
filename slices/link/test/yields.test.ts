/**
 * S-LINK I5 tests at the C02 boundary, with the recorded account-owner stub (S-LINK plan, S-LINK-I5):
 * - T-08: priority and yields (crossings, three-cycles, a holder without the waiting mark is not asked, the commit
 *   fence, review 17's loop, attempts, claims, a holder that starts to wait later yields) (exit criterion 1);
 * - the link parts of P2-S15, S19, S58, S59, S60, S87, S88, S97 and S118 (S-LINK plan §8);
 * - C02 provider tests 4 (yield parts) and 5 at the owner (exit criterion 2). The C02 suite runs them too
 *   (`contract.c02.test.ts`);
 * - the C02 joint traces P2-S19 and P2-S87, in the orders "refusal, then mark" and "mark, then refusal", against the
 *   stub (exit criterion 3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hlcToWallMs, utf8, type HlcTs } from '@share/owner-runtime';
import {
  ENTRY, LINK_KIND, LinkOwner, requestKey, type HoldCmd, type RequestId, type WaitingNotification, type YieldAnswerCmd,
} from '../src/index.ts';
import { AccountStub, doubleLogReader, harness, M, resultOf, type Harness } from './support.ts';

const W = { start: M(10), end: M(11) };

/** The decision part of a reply, without the link stamp. */
function body(r: unknown): Record<string, unknown> {
  const { linkFence: _f, linkSeq: _s, ...rest } = r as Record<string, unknown>;
  return rest;
}

function seqOf(r: unknown): bigint {
  return (r as { linkSeq: bigint }).linkSeq;
}

/** A hold command with a set request age (the HLC of `ms`), so a test fixes the priority order. */
function aged(cmd: HoldCmd, ms: number): HoldCmd {
  return { ...cmd, requestAge: `${BigInt(ms) * 1_000_000n}.0000000000` as HlcTs };
}

const nowMs = (h: Harness): number => hlcToWallMs(h.rt.now().ts);

/** The account stub of one more link on the same owner and runtime (capacity 10). */
async function addLink(h: Harness, link: string): Promise<AccountStub> {
  const r = await h.owner.register(link, 10);
  assert.equal(resultOf(r), 'INITIALISED');
  return new AccountStub(h.rt, h.owner, link);
}

function markCmd(s: AccountStub, request: RequestId, waiting: boolean, position: bigint) {
  return { link: s.link, receiverPartition: s.link, request, waiting, position };
}

async function mark(s: AccountStub, request: RequestId, waiting: boolean, position: bigint): Promise<unknown> {
  return s.owner.markWaiting(s.envelope(request.partition), markCmd(s, request, waiting, position));
}

async function answer(s: AccountStub, request: RequestId, attempt: number, claim: bigint, a: YieldAnswerCmd['answer']): Promise<unknown> {
  return s.owner.yieldAnswer(s.envelope(request.partition), { link: s.link, receiverPartition: s.link, request, attempt, claim, answer: a });
}

async function query(s: AccountStub, request: RequestId): Promise<Record<string, unknown>> {
  return body(await s.owner.query(s.envelope(request.partition), { link: s.link, receiverPartition: s.link, request }));
}

/** The relayed notifications (outbox rows) as C02 bodies, in order. */
function relayed(h: Harness): WaitingNotification[] {
  return h.rt.notificationsSent.map((n) => n.body as WaitingNotification);
}

/** The identity and the content of a notification, without the fence. */
function notice(n: WaitingNotification): Record<string, unknown> {
  const { linkFence: _f, ...rest } = n;
  return { ...rest, request: requestKey(n.request), ...('olderRequest' in n ? { olderRequest: requestKey(n.olderRequest) } : {}) };
}

/** The relayed notifications of one link from one entry on. */
function notesOf(h: Harness, link: string, fromSeq = 0n): Record<string, unknown>[] {
  return relayed(h).filter((n) => n.link === link && n.linkSeq >= fromSeq).map(notice);
}

function yieldRequests(h: Harness, link?: string): Array<Extract<WaitingNotification, { kind: 'YIELD_REQUEST' }>> {
  return relayed(h).filter((n): n is Extract<WaitingNotification, { kind: 'YIELD_REQUEST' }> => n.kind === 'YIELD_REQUEST' && (link === undefined || n.link === link));
}

function kinds(h: Harness, link = h.link): number[] {
  return h.rt.log(utf8(link)).map((e) => e.entry.kind);
}

function yr(link: string, seq: bigint, holder: HoldCmd, attempt: number, claim: bigint, older: HoldCmd): Record<string, unknown> {
  return { linkSeq: seq, link, request: requestKey(holder.request), attempt, kind: 'YIELD_REQUEST', claim, olderRequest: requestKey(older.request) };
}

const granted = (link: string, seq: bigint, c: HoldCmd, attempt = 1): Record<string, unknown> =>
  ({ linkSeq: seq, link, request: requestKey(c.request), attempt, kind: 'GRANTED' });

/** One link: Y (younger) holds 8 Mbps; O (older) waits for 8 Mbps on the same window. */
async function oneCrossing(): Promise<{ h: Harness; y: HoldCmd; o: HoldCmd }> {
  const h = await harness();
  const t0 = nowMs(h);
  const y = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'y', deadlineInMs: 20_000 }), t0 - 1);
  const o = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'o', wait: true, deadlineInMs: 25_000 }), t0 - 5);
  assert.deepEqual(body(await h.stub.hold(y)), { result: 'HELD', attempt: 1 });
  assert.deepEqual(body(await h.stub.hold(o)), { result: 'WAITING', attempt: 1, aheadDeadline: y.deadline });
  return { h, y, o };
}

// ---------------- link parts of the P2 scenarios ----------------

test('P2-S58 link part: a holder without the waiting mark is never asked to yield; the older request waits and the younger keeps its hold', async () => {
  const { h, y, o } = await oneCrossing();
  assert.deepEqual(yieldRequests(h), [], 'no yield request');
  assert.deepEqual(await query(h.stub, y.request), { state: 'HELD', attempt: 1 }, 'no open yield claim');
  assert.deepEqual(await query(h.stub, o.request), { state: 'WAITING', attempt: 1, aheadDeadline: y.deadline });
  assert.equal(h.owner.stateOf(h.link)?.occAll.peak(W.start, W.end), 8);
  assert.deepEqual(body(await mark(h.stub, y.request, false, 1n)), { result: 'APPLIED' });
  assert.deepEqual(yieldRequests(h), [], 'a cleared mark asks nothing');
});

test('P2-S118 link part: a holder that starts to wait later yields: its mark raises the older waiter\'s claim, it accepts, and the older is granted in the same entry', async () => {
  const { h, y, o } = await oneCrossing();
  const m = await mark(h.stub, y.request, true, 7n);
  assert.deepEqual(body(m), { result: 'APPLIED' });
  const c = seqOf(m);
  assert.deepEqual(notesOf(h, h.link), [yr(h.link, c, y, 1, c, o)], 'the claim is the sequence of the mark entry');
  assert.deepEqual(await query(h.stub, y.request), { state: 'HELD', attempt: 1, openYieldClaims: [{ claim: c, olderRequest: o.request }] });
  const acc = await answer(h.stub, y.request, 1, c, 'yield_accept');
  assert.deepEqual(body(acc), { result: 'ACCEPTED', newWaiterAttempt: 2 });
  assert.deepEqual(notesOf(h, h.link, seqOf(acc)), [
    granted(h.link, seqOf(acc), o),
    { linkSeq: seqOf(acc), link: h.link, request: requestKey(y.request), attempt: 2, kind: 'WAITING_NOTICE', aheadDeadline: o.deadline },
  ]);
  assert.deepEqual(await query(h.stub, o.request), { state: 'HELD', attempt: 1 });
  assert.deepEqual(await query(h.stub, y.request), { state: 'WAITING', attempt: 2, aheadDeadline: o.deadline });
  assert.equal(h.owner.stateOf(h.link)?.occAll.peak(W.start, W.end), 8);
  assert.deepEqual(kinds(h).slice(-2), [ENTRY.MarkWaiting, ENTRY.YieldAccept]);
});

test('P2-S15 link part: yields break contention among waiting requests; the oldest is granted, then confirmed, and the others are refused for no fit', async () => {
  const h = await harness();
  const t0 = nowMs(h);
  const [r1, r2, r3] = [3, 2, 1].map((i) => aged(h.stub.holdCmd({ rate: 8, window: W, account: `r${i}`, wait: true }), t0 - i)) as [HoldCmd, HoldCmd, HoldCmd];
  assert.equal(resultOf(await h.stub.hold(r3)), 'HELD', 'the youngest arrives first and holds');
  assert.equal(resultOf(await h.stub.hold(r2)), 'WAITING');
  assert.equal(resultOf(await h.stub.hold(r1)), 'WAITING');
  const m = await mark(h.stub, r3.request, true, 1n);
  assert.deepEqual(yieldRequests(h).map((n) => [requestKey(n.olderRequest), n.claim]), [[requestKey(r1.request), seqOf(m)]],
    'one request on the holder attempt: for the oldest waiter, the first that the entry checks (DI-21)');
  const acc = await answer(h.stub, r3.request, 1, seqOf(m), 'yield_accept');
  assert.deepEqual(notesOf(h, h.link, seqOf(acc)).filter((n) => n['kind'] === 'GRANTED'), [granted(h.link, seqOf(acc), r1)]);
  assert.equal(resultOf(await h.stub.convert(h.stub.convertCmd(r1))), 'CONVERTED');
  assert.deepEqual(relayed(h).filter((n) => n.kind === 'WAITER_REFUSED').map((n) => [requestKey(n.request), n.attempt]),
    [[requestKey(r2.request), 1], [requestKey(r3.request), 2]], 'exactly one is confirmed; the others are refused for no fit');
});

test('P2-S59 link part: wait = false registers no waiter and raises no yield request, also when the holder carries the mark; it stays refused', async () => {
  const h = await harness();
  const t0 = nowMs(h);
  const y = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'y' }), t0 - 1);
  await h.stub.hold(y);
  assert.deepEqual(body(await mark(h.stub, y.request, true, 1n)), { result: 'APPLIED' });
  const b = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'b', wait: false }), t0 - 5);
  assert.deepEqual(body(await h.stub.hold(b))['reason'], 'IN_FLIGHT');
  assert.deepEqual(yieldRequests(h), []);
  assert.equal(h.owner.stateOf(h.link)?.waitersInOrder().length, 0);
  await h.stub.release(h.stub.releaseCmd(y.request, y.deadline, 'FAILED'));
  assert.deepEqual(relayed(h), [], 'no grant for the refused request');
  assert.deepEqual((await query(h.stub, b.request))['state'], 'REFUSED');
  assert.equal(h.owner.stateOf(h.link)?.occAll.peak(W.start, W.end), 0, 'nothing is held for A or B');
});

test('P2-S97 link part: a yielder keeps its place (same request_age and window, attempt + 1): it is granted before a younger waiter, and converts only at attempt 2', async () => {
  const { h, y, o } = await oneCrossing();
  const t0 = nowMs(h);
  const d = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'd', wait: true, deadlineInMs: 30_000 }), t0);
  assert.equal(resultOf(await h.stub.hold(d)), 'WAITING');
  const c = seqOf(await mark(h.stub, y.request, true, 1n));
  await answer(h.stub, y.request, 1, c, 'yield_accept');
  const st = h.owner.stateOf(h.link);
  assert.deepEqual(st?.waitersInOrder().map((w) => [requestKey(w.cmd.request), w.attempt, w.cmd.requestAge, w.cmd.window]),
    [[requestKey(y.request), 2, y.requestAge, W], [requestKey(d.request), 1, d.requestAge, W]], 'the yielder is ahead of the younger waiter');
  const rel = await h.stub.release(h.stub.releaseCmd(o.request, o.deadline, 'FAILED'));
  assert.deepEqual(notesOf(h, h.link, seqOf(rel)), [
    granted(h.link, seqOf(rel), y, 2),
    { linkSeq: seqOf(rel), link: h.link, request: requestKey(d.request), attempt: 1, kind: 'WAITING_NOTICE', aheadDeadline: y.deadline },
  ]);
  assert.deepEqual(await h.stub.convert(h.stub.convertCmd(y, 1)), { code: 'MISMATCH' }, 'convert with the old attempt');
  assert.equal(resultOf(await h.stub.convert(h.stub.convertCmd(y, 2))), 'CONVERTED');
  assert.deepEqual(relayed(h).at(-1)?.kind, 'WAITER_REFUSED', 'D is refused for no fit');
  assert.deepEqual(notice(relayed(h).at(-1) as WaitingNotification)['request'], requestKey(d.request));
});

test('P2-S60 link part: the younger of a crossing is granted at attempt + 1 when the older ends without confirmation', async () => {
  const { h, y, o } = await oneCrossing();
  const c = seqOf(await mark(h.stub, y.request, true, 1n));
  assert.deepEqual(body(await answer(h.stub, y.request, 1, c, 'yield_accept')), { result: 'ACCEPTED', newWaiterAttempt: 2 });
  const rel = await h.stub.release(h.stub.releaseCmd(o.request, o.deadline, 'FAILED'));
  assert.deepEqual(notesOf(h, h.link, seqOf(rel)), [granted(h.link, seqOf(rel), y, 2)]);
  assert.deepEqual(await query(h.stub, y.request), { state: 'HELD', attempt: 2 });
  assert.deepEqual(body(await h.stub.hold(y)), { result: 'HELD', attempt: 2 }, 'a repeat of the hold gets the present state');
  assert.equal(resultOf(await h.stub.convert(h.stub.convertCmd(y, 2))), 'CONVERTED');
});

// ---------------- T-08 ----------------

test('T-08 a holder that is older than the waiter is never asked, even with the mark', async () => {
  const h = await harness();
  const t0 = nowMs(h);
  const old = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'old' }), t0 - 9);
  await h.stub.hold(old);
  await mark(h.stub, old.request, true, 1n);
  const young = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'young', wait: true }), t0 - 1);
  assert.equal(resultOf(await h.stub.hold(young)), 'WAITING');
  assert.deepEqual(yieldRequests(h), []);
});

test('T-08 a waiter registered beside a marked younger holder raises its claim in its own hold entry', async () => {
  const h = await harness();
  const t0 = nowMs(h);
  const y = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'y' }), t0 - 1);
  await h.stub.hold(y);
  await mark(h.stub, y.request, true, 1n);
  const o = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'o', wait: true }), t0 - 5);
  const r = await h.stub.hold(o);
  assert.deepEqual(body(r), { result: 'WAITING', attempt: 1, aheadDeadline: y.deadline });
  assert.deepEqual(notesOf(h, h.link), [yr(h.link, seqOf(r), y, 1, seqOf(r), o)]);
});

test('T-08 review 17 loop: O needs 6, Y holds 3 and 1 is free: Y is not asked, because its yield would be in vain', async () => {
  const h = await harness();
  const t0 = nowMs(h);
  const x = aged(h.stub.holdCmd({ rate: 6, window: W, account: 'x' }), t0 - 1);
  const y = aged(h.stub.holdCmd({ rate: 3, window: W, account: 'y' }), t0 - 1);
  await h.stub.hold(x);
  await h.stub.hold(y);
  await mark(h.stub, y.request, true, 1n);
  const o = aged(h.stub.holdCmd({ rate: 6, window: W, account: 'o', wait: true }), t0 - 5);
  assert.equal(resultOf(await h.stub.hold(o)), 'WAITING');
  assert.deepEqual(yieldRequests(h), []);
  await mark(h.stub, x.request, true, 1n);
  assert.deepEqual(yieldRequests(h).map((n) => requestKey(n.request)), [requestKey(x.request), requestKey(y.request)],
    'with X marked too, X and Y suffice, and both are asked in one claim');
  assert.equal(new Set(yieldRequests(h).map((n) => n.claim)).size, 1);
});

test('T-08 review 17 loop: with yields sufficient, a yielder is not granted again inside the live claim, though its rate fits; the older is granted when the claim is met', async () => {
  const h = await harness();
  const t0 = nowMs(h);
  const x = aged(h.stub.holdCmd({ rate: 4, window: W, account: 'x' }), t0 - 9);
  const y1 = aged(h.stub.holdCmd({ rate: 3, window: W, account: 'y1' }), t0 - 2);
  const y2 = aged(h.stub.holdCmd({ rate: 3, window: W, account: 'y2' }), t0 - 1);
  for (const c of [x, y1, y2]) await h.stub.hold(c);
  await mark(h.stub, y1.request, true, 1n);
  await mark(h.stub, y2.request, true, 1n);
  const o = aged(h.stub.holdCmd({ rate: 6, window: W, account: 'o', wait: true, deadlineInMs: 25_000 }), t0 - 5);
  const r = await h.stub.hold(o);
  const c = seqOf(r);
  assert.deepEqual(notesOf(h, h.link), [yr(h.link, c, y1, 1, c, o), yr(h.link, c, y2, 1, c, o)], 'one claim, a request to each holder');
  const a1 = await answer(h.stub, y1.request, 1, c, 'yield_accept');
  assert.deepEqual(body(a1), { result: 'ACCEPTED', newWaiterAttempt: 2 });
  assert.deepEqual(notesOf(h, h.link, seqOf(a1)), [], 'Y1 is not granted again, and O is not granted yet');
  const st = h.owner.stateOf(h.link);
  assert.equal(st?.occAll.peak(W.start, W.end), 7, '3 Mbps is free, and Y1 needs 3');
  assert.deepEqual(st?.waitersInOrder().map((w) => requestKey(w.cmd.request)), [requestKey(o.request), requestKey(y1.request)]);
  const later = h.stub.holdCmd({ rate: 3, window: { start: M(12), end: M(13) }, account: 'z' });
  assert.equal(resultOf(await h.stub.hold(later)), 'HELD', 'outside the claimed ranges nothing changes');
  const a2 = await answer(h.stub, y2.request, 1, c, 'yield_accept');
  assert.deepEqual(notesOf(h, h.link, seqOf(a2)).map((n) => [n['request'], n['kind']]), [
    [requestKey(o.request), 'GRANTED'],
    [requestKey(y1.request), 'WAITING_NOTICE'],
    [requestKey(y2.request), 'WAITING_NOTICE'],
  ]);
  assert.equal(st?.occAll.peak(W.start, W.end), 10);
});

test('T-08 a younger waiter outside the claimed ranges is granted while the claim is live', async () => {
  const h = await harness();
  const t0 = nowMs(h);
  const y = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'y' }), t0 - 1);
  const w2 = { start: M(12), end: M(13) };
  const b = aged(h.stub.holdCmd({ rate: 8, window: w2, account: 'b' }), t0 - 1);
  await h.stub.hold(y);
  await h.stub.hold(b);
  await mark(h.stub, y.request, true, 1n);
  const o = aged(h.stub.holdCmd({ rate: 8, window: { start: M(10), end: M(13) }, account: 'o', wait: true }), t0 - 9);
  await h.stub.hold(o);
  assert.deepEqual(yieldRequests(h), [], 'B has no mark, so the yield of Y alone is in vain');
  await mark(h.stub, b.request, true, 1n);
  assert.equal(yieldRequests(h).length, 2, 'O claims [10:00, 11:00) and [12:00, 13:00)');
  const z = aged(h.stub.holdCmd({ rate: 3, window: { start: M(11), end: M(12) }, account: 'z', wait: true }), t0 - 2);
  const late = aged(h.stub.holdCmd({ rate: 9, window: { start: M(11), end: M(12) }, account: 'late' }), t0 - 1);
  assert.equal(resultOf(await h.stub.hold(late)), 'HELD');
  assert.equal(resultOf(await h.stub.hold(z)), 'WAITING');
  const rel = await h.stub.release(h.stub.releaseCmd(late.request, late.deadline));
  assert.deepEqual(notesOf(h, h.link, seqOf(rel)), [granted(h.link, seqOf(rel), z)], 'Z is younger than O but outside its claimed ranges');
});

test('T-08 a claim reserves nothing against arrivals: a new hold that fits beside held capacity is held while the claim is live', async () => {
  const h = await harness();
  const t0 = nowMs(h);
  const y = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'y' }), t0 - 1);
  await h.stub.hold(y);
  await mark(h.stub, y.request, true, 1n);
  const o = aged(h.stub.holdCmd({ rate: 6, window: W, account: 'o', wait: true }), t0 - 5);
  const c = seqOf(await h.stub.hold(o));
  assert.equal(yieldRequests(h).length, 1);
  const z = h.stub.holdCmd({ rate: 2, window: W, account: 'z' });
  assert.deepEqual(body(await h.stub.hold(z)), { result: 'HELD', attempt: 1 });
  const acc = await answer(h.stub, y.request, 1, c, 'yield_accept');
  assert.deepEqual(notesOf(h, h.link, seqOf(acc)).filter((n) => n['kind'] === 'GRANTED'), [granted(h.link, seqOf(acc), o)]);
  assert.equal(h.owner.stateOf(h.link)?.occAll.peak(W.start, W.end), 8);
});

test('T-08 commit fence: a waiter at or after its D_c raises no yield request when the holder sets its mark', async () => {
  const h = await harness();
  const t0 = nowMs(h);
  const y = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'y', deadlineInMs: 60_000 }), t0 - 1);
  await h.stub.hold(y);
  const o = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'o', wait: true, deadlineInMs: 5_000 }), t0 - 5);
  await h.stub.hold(o);
  h.rt.advance(5_000 - 420);
  assert.deepEqual(body(await mark(h.stub, y.request, true, 1n)), { result: 'APPLIED' });
  assert.deepEqual(yieldRequests(h), []);
});

test('T-08 a waiter one millisecond before its D_c raises its claim when the holder sets its mark', async () => {
  const h = await harness();
  const t0 = nowMs(h);
  const y = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'y', deadlineInMs: 60_000 }), t0 - 1);
  await h.stub.hold(y);
  const o = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'o', wait: true, deadlineInMs: 5_000 }), t0 - 5);
  await h.stub.hold(o);
  h.rt.advance(5_000 - 420 - 1);
  await mark(h.stub, y.request, true, 1n);
  assert.equal(yieldRequests(h).length, 1);
});

test('T-08 claims: two older waiters have open claims on one holder attempt; a refusal ends only its claim', async () => {
  const h = await harness();
  const t0 = nowMs(h);
  const y = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'y' }), t0 - 1);
  await h.stub.hold(y);
  await mark(h.stub, y.request, true, 1n);
  const o1 = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'o1', wait: true, deadlineInMs: 25_000 }), t0 - 9);
  const o2 = aged(h.stub.holdCmd({ rate: 5, window: W, account: 'o2', wait: true }), t0 - 5);
  const c1 = seqOf(await h.stub.hold(o1));
  const c2 = seqOf(await h.stub.hold(o2));
  assert.deepEqual((await query(h.stub, y.request))['openYieldClaims'], [{ claim: c1, olderRequest: o1.request }, { claim: c2, olderRequest: o2.request }]);
  await mark(h.stub, y.request, false, 2n);
  const ref = await answer(h.stub, y.request, 1, c1, 'yield_refuse');
  assert.deepEqual(body(ref), { result: 'REFUSED_RECORDED' });
  assert.deepEqual(notesOf(h, h.link, seqOf(ref)), [], 'the mark is clear: no new claim');
  assert.deepEqual((await query(h.stub, y.request))['openYieldClaims'], [{ claim: c2, olderRequest: o2.request }]);
  assert.deepEqual(kinds(h).at(-1), ENTRY.YieldRefuse);
  const acc = await answer(h.stub, y.request, 1, c2, 'yield_accept');
  assert.deepEqual(body(acc), { result: 'ACCEPTED', newWaiterAttempt: 2 });
  assert.deepEqual(notesOf(h, h.link, seqOf(acc)).map((n) => [n['request'], n['kind']]),
    [[requestKey(o1.request), 'GRANTED'], [requestKey(o2.request), 'WAITING_NOTICE']],
    'the freed capacity goes to the oldest waiter that it fits; the yielder is inside the live claim of O2, so the scan skips it');
});

test('C02 provider test 5 / T-08 mark, then refusal: a refusal recorded while the mark is set raises a new claim at once, which is accepted', async () => {
  const { h, y, o } = await oneCrossing();
  const c1 = seqOf(await mark(h.stub, y.request, true, 1n));
  const ref = await answer(h.stub, y.request, 1, c1, 'yield_refuse');
  assert.deepEqual(body(ref), { result: 'REFUSED_RECORDED' });
  const c2 = seqOf(ref);
  assert.deepEqual(notesOf(h, h.link, c2), [yr(h.link, c2, y, 1, c2, o)], 'c2 is the sequence of the refusal entry');
  assert.deepEqual((await query(h.stub, y.request))['openYieldClaims'], [{ claim: c2, olderRequest: o.request }], 'c1 is ended');
  assert.deepEqual(body(await answer(h.stub, y.request, 1, c1, 'yield_accept')), { result: 'STALE_ATTEMPT' }, 'c1 cannot be accepted');
  const acc = await answer(h.stub, y.request, 1, c2, 'yield_accept');
  assert.deepEqual(body(acc), { result: 'ACCEPTED', newWaiterAttempt: 2 });
  assert.deepEqual(notesOf(h, h.link, seqOf(acc))[0], granted(h.link, seqOf(acc), o));
});

test('C02 provider test 5 / T-08 refusal, then mark: a refusal while the mark is clear raises nothing; the next mark raises a new claim, which is accepted', async () => {
  const { h, y, o } = await oneCrossing();
  const c1 = seqOf(await mark(h.stub, y.request, true, 1n));
  assert.deepEqual(body(await mark(h.stub, y.request, false, 2n)), { result: 'APPLIED' });
  assert.deepEqual((await query(h.stub, y.request))['openYieldClaims'], [{ claim: c1, olderRequest: o.request }], 'a cleared mark ends no claim');
  const ref = await answer(h.stub, y.request, 1, c1, 'yield_refuse');
  assert.deepEqual(body(ref), { result: 'REFUSED_RECORDED' });
  assert.deepEqual(notesOf(h, h.link, seqOf(ref)), []);
  assert.deepEqual(await query(h.stub, y.request), { state: 'HELD', attempt: 1 });
  const m3 = await mark(h.stub, y.request, true, 3n);
  const c2 = seqOf(m3);
  assert.deepEqual(notesOf(h, h.link, c2), [yr(h.link, c2, y, 1, c2, o)]);
  assert.deepEqual(body(await answer(h.stub, y.request, 1, c2, 'yield_accept')), { result: 'ACCEPTED', newWaiterAttempt: 2 });
  assert.deepEqual(await query(h.stub, o.request), { state: 'HELD', attempt: 1 });
});

test('C02 provider test 4 yield_accept replies with attempt + 1; a repeat gets the recorded reply and writes nothing; a stale attempt or claim gets STALE_ATTEMPT and changes nothing', async () => {
  const { h, y, o } = await oneCrossing();
  const c = seqOf(await mark(h.stub, y.request, true, 1n));
  assert.deepEqual(body(await answer(h.stub, y.request, 1, c + 1n, 'yield_accept')), { result: 'STALE_ATTEMPT' }, 'a claim that is not open');
  assert.deepEqual(body(await answer(h.stub, y.request, 2, c, 'yield_accept')), { result: 'STALE_ATTEMPT' }, 'an attempt that is not the hold\'s');
  assert.deepEqual(body(await answer(h.stub, o.request, 1, c, 'yield_accept')), { result: 'STALE_ATTEMPT' }, 'a request that holds nothing');
  const other = h.stub.holdCmd({ rate: 1, window: W, account: 'n' });
  assert.deepEqual(body(await answer(h.stub, other.request, 1, c, 'yield_refuse')), { result: 'STALE_ATTEMPT' }, 'a request that the link has not seen');
  assert.equal(h.owner.stateOf(h.link)?.occAll.peak(W.start, W.end), 8, 'nothing changed');
  const logLen = h.rt.log(utf8(h.link)).length;
  assert.equal(kinds(h).at(-1), ENTRY.MarkWaiting, 'a STALE_ATTEMPT writes no entry');
  const acc = await answer(h.stub, y.request, 1, c, 'yield_accept');
  assert.deepEqual(body(acc), { result: 'ACCEPTED', newWaiterAttempt: 2 });
  const again = await answer(h.stub, y.request, 1, c, 'yield_accept');
  assert.deepEqual([body(again), seqOf(again)], [body(acc), seqOf(acc)], 'the recorded reply, with its link sequence');
  assert.deepEqual(body(await answer(h.stub, y.request, 1, c, 'yield_refuse')), { result: 'STALE_ATTEMPT' }, 'a refusal after the accept is stale');
  assert.equal(h.rt.log(utf8(h.link)).length, logLen + 1, 'only the accept wrote an entry');
});

test('C02 provider test 4 the end of a hold attempt (convert) closes every claim on it, and its re-sends stop', async () => {
  const h = await harness();
  const t0 = nowMs(h);
  const y = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'y' }), t0 - 1);
  await h.stub.hold(y);
  await mark(h.stub, y.request, true, 1n);
  const o1 = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'o1', wait: true }), t0 - 9);
  const o2 = aged(h.stub.holdCmd({ rate: 5, window: W, account: 'o2', wait: true }), t0 - 5);
  const c1 = seqOf(await h.stub.hold(o1));
  const c2 = seqOf(await h.stub.hold(o2));
  const pushed = h.pushed.length;
  h.rt.advance(1_000);
  await h.owner.idle();
  assert.deepEqual(h.pushed.slice(pushed), h.pushed.filter((n) => n.id.kind === 'YIELD_REQUEST').slice(0, 2), 'each open request is sent again, the same');
  assert.deepEqual(h.pushed.slice(pushed).map((n) => (n.body as { claim: bigint }).claim), [c1, c2]);
  assert.equal(resultOf(await h.stub.convert(h.stub.convertCmd(y, 1))), 'CONVERTED');
  assert.equal((await query(h.stub, y.request))['openYieldClaims'], undefined);
  assert.deepEqual(body(await answer(h.stub, y.request, 1, c1, 'yield_accept')), { result: 'STALE_ATTEMPT' });
  assert.deepEqual(body(await answer(h.stub, y.request, 1, c2, 'yield_refuse')), { result: 'STALE_ATTEMPT' });
  const after = h.pushed.length;
  h.rt.advance(5_000);
  await h.owner.idle();
  assert.equal(h.pushed.length, after, 'no re-send after the end of the attempt');
  assert.deepEqual(h.owner.stateOf(h.link)?.openYieldRequests(), []);
});

test('C02 provider test 4 the end of a hold attempt (release) closes every claim on it, and the older waiter is granted', async () => {
  const { h, y, o } = await oneCrossing();
  const c = seqOf(await mark(h.stub, y.request, true, 1n));
  const rel = await h.stub.release(h.stub.releaseCmd(y.request, y.deadline, 'FAILED'));
  assert.deepEqual(notesOf(h, h.link, seqOf(rel)), [granted(h.link, seqOf(rel), o)]);
  assert.deepEqual(body(await answer(h.stub, y.request, 1, c, 'yield_accept')), { result: 'STALE_ATTEMPT' });
  assert.deepEqual(h.owner.stateOf(h.link)?.openYieldRequests(), []);
});

/** X (older, no mark) holds 4 Mbps; Y1 and Y2 (younger, marked) hold 3 Mbps each; O needs 6 Mbps: one claim on Y1 and Y2. */
async function twoHolders(): Promise<{ h: Harness; x: HoldCmd; y1: HoldCmd; y2: HoldCmd; o: HoldCmd; c: bigint }> {
  const h = await harness();
  const t0 = nowMs(h);
  const x = aged(h.stub.holdCmd({ rate: 4, window: W, account: 'x' }), t0 - 9);
  const y1 = aged(h.stub.holdCmd({ rate: 3, window: W, account: 'y1' }), t0 - 2);
  const y2 = aged(h.stub.holdCmd({ rate: 3, window: W, account: 'y2' }), t0 - 1);
  for (const v of [x, y1, y2]) await h.stub.hold(v);
  await mark(h.stub, y1.request, true, 1n);
  await mark(h.stub, y2.request, true, 1n);
  const o = aged(h.stub.holdCmd({ rate: 6, window: W, account: 'o', wait: true, deadlineInMs: 25_000 }), t0 - 5);
  const c = seqOf(await h.stub.hold(o));
  assert.deepEqual(notesOf(h, h.link), [yr(h.link, c, y1, 1, c, o), yr(h.link, c, y2, 1, c, o)]);
  return { h, x, y1, y2, o, c };
}

test('C02 provider test 4 the release of one holder ends the whole claim; the scan then raises a new claim on the other holder', async () => {
  const { h, y1, y2, o, c } = await twoHolders();
  const rel = await h.stub.release(h.stub.releaseCmd(y1.request, y1.deadline, 'FAILED'));
  assert.deepEqual(notesOf(h, h.link, seqOf(rel)), [yr(h.link, seqOf(rel), y2, 1, seqOf(rel), o)], 'O is checked again from the start');
  assert.deepEqual(body(await answer(h.stub, y2.request, 1, c, 'yield_accept')), { result: 'STALE_ATTEMPT' }, 'the old claim is ended on Y2 too');
  assert.deepEqual(body(await answer(h.stub, y2.request, 1, seqOf(rel), 'yield_accept')), { result: 'ACCEPTED', newWaiterAttempt: 2 });
  assert.deepEqual(await query(h.stub, o.request), { state: 'HELD', attempt: 1 });
});

test('T-08 a waiter that is granted ends its claim: its open request on the other holder ends; a younger waiter can then claim that holder', async () => {
  const { h, x, y1, y2, o, c } = await twoHolders();
  await answer(h.stub, y1.request, 1, c, 'yield_accept');
  assert.deepEqual(h.owner.stateOf(h.link)?.openYieldRequests().map((v) => v.request), [y2.request]);
  const rel = await h.stub.release(h.stub.releaseCmd(x.request, x.deadline, 'FAILED'));
  const s = seqOf(rel);
  assert.deepEqual(notesOf(h, h.link, s).slice(0, 2), [granted(h.link, s, o), yr(h.link, s, y2, 1, s, y1)],
    'O is granted; Y1, which waits at attempt 2 and is older than Y2, asks Y2 in the same entry');
  assert.deepEqual(h.owner.stateOf(h.link)?.openYieldRequests().map((v) => [requestKey(v.olderRequest), v.claim]), [[requestKey(y1.request), s]]);
  assert.deepEqual(body(await answer(h.stub, y2.request, 1, c, 'yield_accept')), { result: 'STALE_ATTEMPT' }, 'the claim of O is ended');
  assert.deepEqual(await query(h.stub, y2.request), { state: 'HELD', attempt: 1, openYieldClaims: [{ claim: s, olderRequest: y1.request }] });
});

test('C02 provider test 4 yield_accept ends every other claim on the old attempt', async () => {
  const h = await harness();
  const t0 = nowMs(h);
  const y = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'y' }), t0 - 1);
  await h.stub.hold(y);
  await mark(h.stub, y.request, true, 1n);
  const o1 = aged(h.stub.holdCmd({ rate: 8, window: { start: M(10), end: M(12) }, account: 'o1', wait: true }), t0 - 9);
  const o2 = aged(h.stub.holdCmd({ rate: 5, window: W, account: 'o2', wait: true }), t0 - 5);
  const c1 = seqOf(await h.stub.hold(o1));
  const c2 = seqOf(await h.stub.hold(o2));
  const z = h.stub.holdCmd({ rate: 3, window: { start: M(11), end: M(12) }, account: 'z' });
  assert.equal(resultOf(await h.stub.hold(z)), 'HELD', 'a claim reserves nothing against arrivals');
  const acc = await answer(h.stub, y.request, 1, c2, 'yield_accept');
  assert.deepEqual(notesOf(h, h.link, seqOf(acc)).filter((n) => n['kind'] === 'GRANTED'), [granted(h.link, seqOf(acc), o2)],
    'O1 does not fit beside Z; its claim c1 ended with the attempt, so it does not keep O2 from the grant');
  assert.deepEqual(body(await answer(h.stub, y.request, 1, c1, 'yield_refuse')), { result: 'STALE_ATTEMPT' });
  assert.deepEqual(body(await answer(h.stub, y.request, 2, c1, 'yield_refuse')), { result: 'STALE_ATTEMPT' }, 'a waiter has no claim on it');
  assert.deepEqual(h.owner.stateOf(h.link)?.openYieldRequests(), []);
});

test('T-08 the release of a waiter ends its claim; the holder is asked nothing more', async () => {
  const { h, y, o } = await oneCrossing();
  const c = seqOf(await mark(h.stub, y.request, true, 1n));
  await h.stub.release(h.stub.releaseCmd(o.request, o.deadline, 'WITHDRAWN'));
  assert.deepEqual(await query(h.stub, y.request), { state: 'HELD', attempt: 1 });
  assert.deepEqual(body(await answer(h.stub, y.request, 1, c, 'yield_accept')), { result: 'STALE_ATTEMPT' });
});

test('should apply mark_waiting only above the last applied position; an older or equal position gets IGNORED_OLDER and writes no entry', async () => {
  const { h, y, o } = await oneCrossing();
  const first = await mark(h.stub, y.request, false, 5n);
  assert.deepEqual(body(first), { result: 'APPLIED' });
  const logLen = h.rt.log(utf8(h.link)).length;
  assert.deepEqual(body(await mark(h.stub, y.request, true, 5n)), { result: 'IGNORED_OLDER' }, 'the same position');
  assert.deepEqual(body(await mark(h.stub, y.request, true, 4n)), { result: 'IGNORED_OLDER' }, 'an older position');
  assert.equal(h.rt.log(utf8(h.link)).length, logLen);
  assert.deepEqual(yieldRequests(h), [], 'an ignored mark sets nothing');
  const m = await mark(h.stub, y.request, true, 6n);
  assert.deepEqual(body(m), { result: 'APPLIED' });
  assert.deepEqual(notesOf(h, h.link), [yr(h.link, seqOf(m), y, 1, seqOf(m), o)]);
  assert.deepEqual(body(await mark(h.stub, o.request, true, 1n)), { result: 'APPLIED' }, 'a waiter can carry the mark');
});

test('should answer IGNORED_OLDER to a mark for a request that the link has not seen (alert MARK_WITHOUT_REQUEST) or whose state is final, and write nothing', async () => {
  const h = await harness();
  const unseen = h.stub.holdCmd({ rate: 1, window: W, account: 'u' });
  const logLen = h.rt.log(utf8(h.link)).length;
  assert.deepEqual(body(await mark(h.stub, unseen.request, true, 1n)), { result: 'IGNORED_OLDER' });
  assert.deepEqual(h.owner.alerts.map((a) => a.kind), ['MARK_WITHOUT_REQUEST']);
  const done = h.stub.holdCmd({ rate: 1, window: W, account: 'f' });
  await h.stub.book({ rate: 1, window: W, account: 'f', request: done.request });
  const len2 = h.rt.log(utf8(h.link)).length;
  assert.deepEqual(body(await mark(h.stub, done.request, true, 1n)), { result: 'IGNORED_OLDER' });
  assert.equal(h.rt.log(utf8(h.link)).length, len2);
  assert.equal(len2, logLen + 2);
  assert.equal(h.owner.alerts.length, 1);
});

test('should replay marks, claims and yield answers to the same state and notices after a takeover, and re-arm the open yield requests', async () => {
  const h = await harness();
  const t0 = nowMs(h);
  const y = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'y' }), t0 - 1);
  const x = aged(h.stub.holdCmd({ rate: 2, window: W, account: 'x' }), t0 - 1);
  await h.stub.hold(y);
  await h.stub.hold(x);
  await mark(h.stub, y.request, true, 1n);
  await mark(h.stub, x.request, true, 1n);
  const o1 = aged(h.stub.holdCmd({ rate: 8, window: W, account: 'o1', wait: true }), t0 - 9);
  const c1 = seqOf(await h.stub.hold(o1));
  await answer(h.stub, y.request, 1, c1, 'yield_refuse');
  const before = h.owner.stateOf(h.link);
  const snapshot = (st: typeof before): unknown => ({
    holds: st?.holdsInOrder().map((v) => [requestKey(v.request), v.attempt]).sort(),
    waiters: st?.waitersInOrder().map((v) => [requestKey(v.cmd.request), v.attempt, v.aheadDeadline]),
    open: st?.openYieldRequests().map((v) => [v.holder, v.attempt, v.claim, v.waiter]),
  });
  const want = snapshot(before);
  assert.equal(before?.openYieldRequests().length, 2, 'the new claim after the refusal, on Y and X');
  const slot = h.rt.route(LINK_KIND, utf8(h.link)).slot;
  h.rt.release(slot, 'taken');
  const pushed2: unknown[] = [];
  const owner2 = new LinkOwner(h.rt, { readLog: doubleLogReader(h.rt), links: [h.link], onNotify: (n) => pushed2.push(n) });
  h.rt.attach(owner2, (p, k) => void owner2.onTimer(p, k));
  await h.rt.acquire(slot);
  assert.deepEqual(snapshot(owner2.stateOf(h.link)), want);
  assert.deepEqual(owner2.alerts, [], 'every replayed outcome and notice is equal');
  h.rt.advance(1_000);
  await owner2.idle();
  assert.deepEqual(pushed2.map((n) => (n as { id: { kind: string } }).id.kind), ['YIELD_REQUEST', 'YIELD_REQUEST'], 'the new holder sends the open requests again');
  const stub2 = new AccountStub(h.rt, owner2, h.link);
  const claim = (pushed2[0] as { body: { claim: bigint } }).body.claim;
  assert.deepEqual(body(await answer(stub2, y.request, 1, c1, 'yield_refuse')), { result: 'REFUSED_RECORDED' }, 'the recorded reply after the takeover');
  assert.deepEqual(body(await answer(stub2, y.request, 1, claim, 'yield_accept')), { result: 'ACCEPTED', newWaiterAttempt: 2 });
});

// ---------------- joint traces (exit criterion 3) ----------------

/**
 * The account-owner side of a trace on several links of one owner. Each request has its own account partition, so
 * its positions (the account-log sequence of its E2 and of the entries that leave Waiting) grow in its own order.
 */
class Account {
  private position = 0n;
  readonly name: string;
  readonly age: number;
  constructor(name: string, age: number) {
    this.name = name;
    this.age = age;
  }
  next(): bigint {
    this.position += 1n;
    return this.position;
  }
}

/** The YIELD_REQUEST that one link sent last to `holder` for the claim of `older`. */
function lastClaim(h: Harness, link: string, holder: HoldCmd, older: HoldCmd): bigint {
  const n = yieldRequests(h, link).filter((x) => requestKey(x.request) === requestKey(holder.request) && requestKey(x.olderRequest) === requestKey(older.request)).at(-1);
  assert.ok(n, `a YIELD_REQUEST on ${link} for ${requestKey(holder.request)}`);
  return n.claim;
}

/** P2-S19: A (older) holds L1 and waits on L2; B holds L2 and waits on L1. */
async function crossing(): Promise<{ h: Harness; l1: AccountStub; l2: AccountStub; a1: HoldCmd; a2: HoldCmd; b1: HoldCmd; b2: HoldCmd; A: Account; B: Account }> {
  const h = await harness({ link: 'L1' });
  const l1 = h.stub;
  const l2 = await addLink(h, 'L2');
  const t0 = nowMs(h);
  const A = new Account('A', t0 - 2);
  const B = new Account('B', t0 - 1);
  const rA = l1.newRequest('A');
  const rB = l1.newRequest('B');
  const leg = (s: AccountStub, acc: Account, request: RequestId, legId: string): HoldCmd =>
    aged(s.holdCmd({ rate: 8, window: W, account: acc.name, request, leg: legId, wait: true, deadlineInMs: 20_000 }), acc.age);
  const a1 = leg(l1, A, rA, 'A-L1'); const a2 = leg(l2, A, rA, 'A-L2');
  const b2 = leg(l2, B, rB, 'B-L2'); const b1 = leg(l1, B, rB, 'B-L1');
  assert.equal(resultOf(await l1.hold(a1)), 'HELD');
  assert.equal(resultOf(await l2.hold(b2)), 'HELD');
  assert.deepEqual(body(await l2.hold(a2)), { result: 'WAITING', attempt: 1, aheadDeadline: b2.deadline });
  assert.deepEqual(body(await l1.hold(b1)), { result: 'WAITING', attempt: 1, aheadDeadline: a1.deadline });
  assert.deepEqual(yieldRequests(h), [], 'no holder has the mark yet');
  return { h, l1, l2, a1, a2, b1, b2, A, B };
}

/** The end of P2-S19: A is held on both links and confirmed; B is refused for no fit on both and releases. */
async function crossingEnds(c: Awaited<ReturnType<typeof crossing>>): Promise<void> {
  const { h, l1, l2, a1, a2, b1 } = c;
  assert.deepEqual(await query(l2, a2.request), { state: 'HELD', attempt: 1 });
  assert.equal(resultOf(await l1.convert(l1.convertCmd(a1, 1, 'A-p1'))), 'CONVERTED');
  assert.equal(resultOf(await l2.convert(l2.convertCmd(a2, 1, 'A-p2'))), 'CONVERTED');
  const refused = relayed(h).filter((n) => n.kind === 'WAITER_REFUSED' && requestKey(n.request) === requestKey(b1.request));
  assert.deepEqual(refused.map((n) => [n.link, n.attempt]), [['L1', 1], ['L2', 2]], 'B is refused for no fit on both links');
  for (const n of refused) assert.deepEqual((n as { counterOffer: unknown }).counterOffer, { largestRateMbps: 2, earliest: { window: { start: M(11), end: M(12) } } });
  for (const s of [l1, l2]) assert.equal(resultOf(await s.release(s.releaseCmd(b1.request, b1.deadline, 'REJECTED'))), 'RELEASED');
  for (const s of [l1, l2]) {
    const st = h.owner.stateOf(s.link);
    assert.equal(st?.occAll.peak(W.start, W.end), 8);
    assert.equal(st?.occFirm.peak(W.start, W.end), 8);
    assert.deepEqual(st?.waitersInOrder(), []);
    assert.deepEqual(st?.openYieldRequests(), []);
  }
}

test('P2-S19 joint trace (mark, then refusal): B is asked to yield on L2, refuses, the link asks again at once, B yields and waits, and A is confirmed', async () => {
  const c = await crossing();
  const { h, l1, l2, a2, b2, A, B } = c;
  assert.deepEqual(body(await mark(l1, c.a1.request, true, A.next())), { result: 'APPLIED' });
  assert.deepEqual(yieldRequests(h), [], 'on L1 the waiter B is younger than A');
  await mark(l2, b2.request, true, B.next());
  const c1 = lastClaim(h, 'L2', b2, a2);
  const ref = await answer(l2, b2.request, 1, c1, 'yield_refuse');
  assert.deepEqual(body(ref), { result: 'REFUSED_RECORDED' });
  const c2 = lastClaim(h, 'L2', b2, a2);
  assert.equal(c2, seqOf(ref));
  const acc = await answer(l2, b2.request, 1, c2, 'yield_accept');
  assert.deepEqual(body(acc), { result: 'ACCEPTED', newWaiterAttempt: 2 });
  assert.deepEqual(notesOf(h, 'L2', seqOf(acc))[0], granted('L2', seqOf(acc), a2));
  await crossingEnds(c);
});

test('P2-S19 joint trace (refusal, then mark): B refuses while it is not Waiting, the link asks nothing more until B\'s mark, then B yields and A is confirmed', async () => {
  const c = await crossing();
  const { h, l2, a2, b2, B } = c;
  await mark(l2, b2.request, true, B.next());
  const c1 = lastClaim(h, 'L2', b2, a2);
  await mark(l2, b2.request, false, B.next());
  assert.deepEqual(body(await answer(l2, b2.request, 1, c1, 'yield_refuse')), { result: 'REFUSED_RECORDED' });
  assert.equal(yieldRequests(h).length, 1, 'no new claim while the mark is clear');
  const m = await mark(l2, b2.request, true, B.next());
  const c2 = lastClaim(h, 'L2', b2, a2);
  assert.equal(c2, seqOf(m));
  const acc = await answer(l2, b2.request, 1, c2, 'yield_accept');
  assert.deepEqual(body(acc), { result: 'ACCEPTED', newWaiterAttempt: 2 });
  assert.deepEqual(notesOf(h, 'L2', seqOf(acc))[0], granted('L2', seqOf(acc), a2));
  await crossingEnds(c);
});

/** P2-S87: A over L1 and L2, B over L2 and L3, C over L3 and L1; each holds its first link and waits for its second. */
async function cycle(): Promise<{ h: Harness; s: Record<'L1' | 'L2' | 'L3', AccountStub>; legs: Record<string, HoldCmd>; acc: Record<'A' | 'B' | 'C', Account> }> {
  const h = await harness({ link: 'L1' });
  const s = { L1: h.stub, L2: await addLink(h, 'L2'), L3: await addLink(h, 'L3') };
  const t0 = nowMs(h);
  const acc = { A: new Account('A', t0 - 3), B: new Account('B', t0 - 2), C: new Account('C', t0 - 1) };
  const legs: Record<string, HoldCmd> = {};
  const route: Array<['A' | 'B' | 'C', 'L1' | 'L2' | 'L3', 'L1' | 'L2' | 'L3']> = [['A', 'L1', 'L2'], ['B', 'L2', 'L3'], ['C', 'L3', 'L1']];
  for (const [r, first, second] of route) {
    const request = h.stub.newRequest(r);
    for (const l of [first, second]) {
      legs[`${r}${l}`] = aged(s[l].holdCmd({ rate: 8, window: W, account: r, request, leg: `${r}-${l}`, wait: true, deadlineInMs: 20_000 }), acc[r].age);
    }
  }
  for (const [r, first] of route) assert.equal(resultOf(await s[first].hold(legs[`${r}${first}`] as HoldCmd)), 'HELD');
  for (const [r, , second] of route) assert.equal(resultOf(await s[second].hold(legs[`${r}${second}`] as HoldCmd)), 'WAITING');
  assert.deepEqual(yieldRequests(h), []);
  return { h, s, legs, acc };
}

/** Each request waits now: its account owner marks the link where it holds. */
async function markAll(c: Awaited<ReturnType<typeof cycle>>): Promise<void> {
  for (const [r, l] of [['A', 'L1'], ['B', 'L2'], ['C', 'L3']] as const) {
    assert.deepEqual(body(await mark(c.s[l], (c.legs[`${r}${l}`] as HoldCmd).request, true, c.acc[r].next())), { result: 'APPLIED' });
  }
  assert.deepEqual(yieldRequests(c.h).map((n) => [n.link, requestKey(n.request), requestKey(n.olderRequest)]), [
    ['L2', requestKey((c.legs['BL2'] as HoldCmd).request), requestKey((c.legs['AL2'] as HoldCmd).request)],
    ['L3', requestKey((c.legs['CL3'] as HoldCmd).request), requestKey((c.legs['BL3'] as HoldCmd).request)],
  ], 'B is asked on L2 for A, and C on L3 for B; A is not asked on L1 (C is younger)');
}

/** The younger holder `r` on `link` answers its open claim: refuse first if `refuseFirst`, then accept the next claim. */
async function yieldIn(c: Awaited<ReturnType<typeof cycle>>, r: 'B' | 'C', link: 'L2' | 'L3', older: 'A' | 'B', order: 'mark-refuse' | 'refuse-mark'): Promise<bigint> {
  const holder = c.legs[`${r}${link}`] as HoldCmd;
  const o = c.legs[`${older}${link}`] as HoldCmd;
  const c1 = lastClaim(c.h, link, holder, o);
  if (order === 'refuse-mark') await mark(c.s[link], holder.request, false, c.acc[r].next());
  assert.deepEqual(body(await answer(c.s[link], holder.request, 1, c1, 'yield_refuse')), { result: 'REFUSED_RECORDED' });
  if (order === 'refuse-mark') {
    assert.equal(lastClaim(c.h, link, holder, o), c1, 'no new claim while the mark is clear');
    await mark(c.s[link], holder.request, true, c.acc[r].next());
  }
  const c2 = lastClaim(c.h, link, holder, o);
  assert.ok(c2 > c1);
  const acc = await answer(c.s[link], holder.request, 1, c2, 'yield_accept');
  assert.deepEqual(body(acc), { result: 'ACCEPTED', newWaiterAttempt: 2 });
  assert.deepEqual(notesOf(c.h, link, seqOf(acc))[0], granted(link, seqOf(acc), o), `${older} is granted on ${link} in the entry of the yield`);
  return seqOf(acc);
}

for (const order of ['mark-refuse', 'refuse-mark'] as const) {
  const name = order === 'mark-refuse' ? 'mark, then refusal' : 'refusal, then mark';
  test(`P2-S87 joint trace (${name}): B and C yield, A is confirmed, and B and C are refused for no fit with the POL-10 counter-offer`, async () => {
    const c = await cycle();
    await markAll(c);
    await yieldIn(c, 'B', 'L2', 'A', order);
    await yieldIn(c, 'C', 'L3', 'B', order);
    const { h, s, legs } = c;
    assert.equal(resultOf(await s.L1.convert(s.L1.convertCmd(legs['AL1'] as HoldCmd, 1, 'A-p1'))), 'CONVERTED');
    assert.equal(resultOf(await s.L2.convert(s.L2.convertCmd(legs['AL2'] as HoldCmd, 1, 'A-p2'))), 'CONVERTED');
    const refused = relayed(h).filter((n) => n.kind === 'WAITER_REFUSED').map((n) => [n.link, requestKey(n.request), n.attempt]);
    assert.deepEqual(refused, [['L1', requestKey((legs['CL1'] as HoldCmd).request), 1], ['L2', requestKey((legs['BL2'] as HoldCmd).request), 2]]);
    for (const n of relayed(h).filter((x) => x.kind === 'WAITER_REFUSED')) {
      assert.deepEqual((n as { counterOffer: unknown }).counterOffer, { largestRateMbps: 2, earliest: { window: { start: M(11), end: M(12) } } });
    }
    for (const [r, links] of [['B', ['L2', 'L3']], ['C', ['L3', 'L1']]] as const) {
      for (const l of links) {
        const leg = legs[`${r}${l}`] as HoldCmd;
        assert.equal(resultOf(await s[l].release(s[l].releaseCmd(leg.request, leg.deadline, 'REJECTED'))), 'RELEASED');
      }
    }
    for (const l of ['L1', 'L2', 'L3'] as const) {
      const st = h.owner.stateOf(l);
      assert.equal(st?.occAll.peak(W.start, W.end), l === 'L3' ? 0 : 8);
      assert.deepEqual([st?.waitersInOrder().length, st?.openYieldRequests().length], [0, 0]);
    }
  });
}

test('P2-S88 link part: in a broken cycle, when the oldest ends without confirmation, the next oldest is granted at attempt + 1 and confirmed, and the youngest is refused for no fit', async () => {
  const c = await cycle();
  await markAll(c);
  await yieldIn(c, 'B', 'L2', 'A', 'mark-refuse');
  await yieldIn(c, 'C', 'L3', 'B', 'mark-refuse');
  const { h, s, legs } = c;
  const a = legs['AL1'] as HoldCmd;
  for (const l of ['L1', 'L2'] as const) await s[l].release(s[l].releaseCmd(a.request, a.deadline, 'FAILED'));
  assert.deepEqual(await query(s.L2, (legs['BL2'] as HoldCmd).request), { state: 'HELD', attempt: 2 }, 'B is granted on L2 at attempt 2');
  assert.deepEqual(await query(s.L3, (legs['BL3'] as HoldCmd).request), { state: 'HELD', attempt: 1 });
  assert.equal(resultOf(await s.L2.convert(s.L2.convertCmd(legs['BL2'] as HoldCmd, 2, 'B-p2'))), 'CONVERTED');
  assert.equal(resultOf(await s.L3.convert(s.L3.convertCmd(legs['BL3'] as HoldCmd, 1, 'B-p3'))), 'CONVERTED');
  const last = relayed(h).filter((n) => n.kind === 'WAITER_REFUSED').map((n) => [n.link, requestKey(n.request), n.attempt]);
  assert.deepEqual(last, [['L3', requestKey((legs['CL3'] as HoldCmd).request), 2]], 'C is refused for no fit on L3');
});
