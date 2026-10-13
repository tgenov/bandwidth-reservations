/**
 * S-LINK I2 tests at the C02 boundary (exit criteria 1, 2 and 3), with the recorded account-owner stub:
 * - the scenarios P1-S12, P1-S15, P1-S16, P1-S17, P1-S38, P1-S39, P1-S70 and P1-S73;
 * - T-04 cases that need the owner: the per-batch cache, a retry after a takeover and after 24 h less 1 min;
 * - C02 provider test 3, last case (`link_request` answers a repeat when the record in memory is gone). The
 *   query after each refusal (provider test 1) is in the C02 suite (`contract.c02.test.ts`);
 * - `query`, `availability` and `fit_ranges`, and the owner error paths of the reads (review 67).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hlcToWallMs, utf8 } from '@share/owner-runtime';
import type { RuntimeDouble } from '@share/owner-runtime/testing';
import {
  DEFAULT_POLICY, ENTRY, horizonMinute, LINK_KIND, LinkOwner, requestKey, type AvailabilityQuery, type FitRangesQuery, type HoldCmd, type QueryCmd,
  type RequestId,
} from '../src/index.ts';
import { AccountStub, doubleLogReader, harness, M, resultOf, type Harness } from './support.ts';

const H = (hh: number, mm = 0) => M(hh, mm);
const HOUR_MS = 3_600_000;

/** The decision part of a reply, without the link stamp. */
function body(r: unknown): Record<string, unknown> {
  const { linkFence: _f, linkSeq: _s, ...rest } = r as Record<string, unknown>;
  return rest;
}

async function confirmed(h: Harness, rate: number, start: number, end: number | null, account = 'seller-view'): Promise<void> {
  const b = await h.stub.book({ rate, window: { start, end }, account });
  assert.equal(resultOf(b.convert), 'CONVERTED');
}

/** The P1 background of "A rejection tells the buyer what they can get instead": 10 Mbps, 10:00, 8 Mbps confirmed for [10:00, 12:00). */
async function rejectionBackground(): Promise<Harness> {
  const h = await harness();
  h.rt.advance(HOUR_MS);
  await confirmed(h, 8, H(10), H(12));
  return h;
}

function queryCmd(h: Harness, request: RequestId): QueryCmd {
  return { link: h.link, receiverPartition: h.link, request };
}

// ---------------- scenarios ----------------

test('P1-S12 a booking that asks not to wait is rejected at once with retry_after and the counter-offer beside the capacity in flight', async () => {
  const h = await harness();
  const route = h.stub.holdCmd({ rate: 6, window: { start: H(10), end: H(11) }, account: 'route-acct', deadlineInMs: 20_000 });
  assert.equal(resultOf(await h.stub.hold(route)), 'HELD');
  const r = await h.stub.hold(h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) }, wait: false }));
  assert.deepEqual(body(r), {
    result: 'REFUSED', reason: 'IN_FLIGHT',
    counterOffer: { largestRateMbps: 4, earliest: { window: { start: H(11), end: H(12) } } },
    retryAfterMs: 20_000,
  });
});

test('P1-S70 a booking blocked by several requests in flight gets the latest remaining deadline and 2 Mbps as the largest rate', async () => {
  const h = await harness();
  await h.stub.hold(h.stub.holdCmd({ rate: 4, window: { start: H(10), end: H(11) }, account: 'r1', deadlineInMs: 10_000 }));
  await h.stub.hold(h.stub.holdCmd({ rate: 4, window: { start: H(10), end: H(11) }, account: 'r2', deadlineInMs: 25_000 }));
  const r = body(await h.stub.hold(h.stub.holdCmd({ rate: 10, window: { start: H(10), end: H(11) }, wait: false })));
  assert.deepEqual([r['result'], r['reason'], r['retryAfterMs']], ['REFUSED', 'IN_FLIGHT', 25_000]);
  assert.equal((r['counterOffer'] as { largestRateMbps: number }).largestRateMbps, 2);
});

test('P1-S15 a rejection states the largest rate that fits the requested window', async () => {
  const h = await rejectionBackground();
  const r = body(await h.stub.hold(h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) } })));
  assert.deepEqual([r['result'], r['reason']], ['REFUSED', 'NO_FIT']);
  assert.equal((r['counterOffer'] as { largestRateMbps: number }).largestRateMbps, 2);
});

test('P1-S16 a rejection states the earliest window of the requested length that fits the requested rate', async () => {
  const h = await rejectionBackground();
  const r = body(await h.stub.hold(h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) } })));
  assert.deepEqual((r['counterOffer'] as { earliest: unknown }).earliest, { window: { start: H(12), end: H(13) } });
});

/** Every key that a refusal or an availability answer may carry: rates, windows, minutes and the link's stamp. */
const DISCLOSABLE = new Set(['result', 'reason', 'counterOffer', 'largestRateMbps', 'earliest', 'window', 'start', 'end', 'none',
  'notFoundBefore', 'retryAfterMs', 'invalid', 'linkFence', 'generation', 'epoch', 'linkSeq', 'asOfSeq', 'offer', 'ranges', 'continueFrom']);

/** The schema check of P1-S17: the reply has only disclosable keys, and no bytes and no text other than a code. */
function assertDisclosesNothing(reply: unknown, where: string): void {
  const walk = (v: unknown, path: string): void => {
    assert.ok(!(v instanceof Uint8Array), `${where}: bytes at ${path}`);
    if (typeof v === 'string') assert.match(v, /^[A-Z_0-9]+$/, `${where}: text at ${path}`);
    if (v === null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (!Array.isArray(v)) assert.ok(DISCLOSABLE.has(k), `${where}: key ${path}.${k} is not a rate, a window or the link stamp`);
      walk(x, `${path}.${k}`);
    }
  };
  walk(reply, 'reply');
}

test('P1-S17 a rejection and an availability answer disclose nothing about other buyers (schema check)', async () => {
  const h = await rejectionBackground();
  await h.stub.hold(h.stub.holdCmd({ rate: 1, window: { start: H(10), end: H(11) }, account: 'other-buyer', leg: 'secret-leg' }));
  const replies: Array<[string, unknown]> = [
    ['NO_FIT', await h.stub.hold(h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) } }))],
    ['IN_FLIGHT', await h.stub.hold(h.stub.holdCmd({ rate: 2, window: { start: H(10), end: H(11) } }))],
    ['availability', await h.owner.availability(h.stub.envelope('b1'), { link: h.link, receiverPartition: h.link, window: { start: H(10), end: H(11) }, rateMbps: 5 })],
    ['fit_ranges', await h.owner.fitRanges(h.stub.envelope('b1'), { link: h.link, receiverPartition: h.link, rateMbps: 1, from: H(9), until: H(14), k: 4 })],
  ];
  assert.deepEqual(replies.map(([, r]) => 'code' in (r as object)), [false, false, false, false]);
  for (const [where, r] of replies) assertDisclosesNothing(r, where);
  assert.throws(() => assertDisclosesNothing({ result: 'REFUSED', account: utf8('b9') }, 'probe'));
  assert.throws(() => assertDisclosesNothing({ result: 'REFUSED', counterOffer: { reservation: 'r-1' } }, 'probe'));
});

test('P1-S38 when nothing fits, the rejection says 0 Mbps and no one-hour window within the selling horizon', async () => {
  const h = await rejectionBackground();
  await confirmed(h, 2, H(10), null);
  const r = body(await h.stub.hold(h.stub.holdCmd({ rate: 9, window: { start: H(10), end: H(11) } })));
  assert.deepEqual(r, { result: 'REFUSED', reason: 'NO_FIT', counterOffer: { largestRateMbps: 0, earliest: { none: true } } });
});

test('P1-S39 a rate above the link capacity is refused with a counter-offer of 10 Mbps, not INVALID', async () => {
  const h = await harness();
  const now = Math.floor(hlcToWallMs(h.rt.now().ts) / 60_000);
  const r = body(await h.stub.hold(h.stub.holdCmd({ rate: 11, window: { start: now + 60, end: now + 120 } })));
  assert.deepEqual(r, { result: 'REFUSED', reason: 'NO_FIT', counterOffer: { largestRateMbps: 10, earliest: { none: true } } });
});

test('P1-S73 a rejection for no fit offers what fits beside the capacity held for requests in flight', async () => {
  const h = await rejectionBackground();
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 1, window: { start: H(10), end: H(11) }, account: 'pending' }))), 'HELD');
  const r = body(await h.stub.hold(h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) }, wait: true })));
  assert.deepEqual(r, {
    result: 'REFUSED', reason: 'NO_FIT', counterOffer: { largestRateMbps: 1, earliest: { window: { start: H(12), end: H(13) } } },
  });
});

// ---------------- T-04 at the owner ----------------

test('T-04 the batch cache is made invalid by a hold between two refusals of the same question', async () => {
  const h = await rejectionBackground();
  const ask = (account: string): HoldCmd => h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) }, account });
  const fill = h.stub.holdCmd({ rate: 6, window: { start: H(12), end: H(13) }, account: 'filler' });
  const appendsBefore = h.rt.appends.length;
  const [a, held, b, c] = await Promise.all([h.stub.hold(ask('a')), h.stub.hold(fill), h.stub.hold(ask('b')), h.stub.hold(ask('c'))]);
  assert.equal(h.rt.appends.length, appendsBefore + 1, 'the four commands are one batch');
  assert.equal(resultOf(held), 'HELD');
  const earliestOf = (r: unknown) => (body(r)['counterOffer'] as { earliest: unknown }).earliest;
  assert.deepEqual(earliestOf(a), { window: { start: H(12), end: H(13) } });
  assert.deepEqual(earliestOf(b), { window: { start: H(13), end: H(14) } }, 'the hold changed occ_all, so the cached answer is not used');
  assert.deepEqual(earliestOf(c), earliestOf(b));
});

test('T-04 a retry after a takeover returns the recorded counter-offer, not one computed again', async () => {
  const h = await rejectionBackground();
  const r = h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) } });
  const first = await h.stub.hold(r);
  await confirmed(h, 6, H(12), H(13), 'later');
  const slot = h.rt.route(LINK_KIND, utf8(h.link)).slot;
  const rt = h.rt as RuntimeDouble;
  rt.release(slot, 'taken');
  const owner2 = new LinkOwner(rt, { readLog: doubleLogReader(rt), links: [h.link] });
  rt.attach(owner2);
  await rt.acquire(slot);
  assert.deepEqual(owner2.alerts, [], 'the replay finds no outcome difference');
  const again = await new AccountStub(rt, owner2, h.link).hold(r);
  assert.deepEqual(body(again), body(first));
  assert.equal((again as { linkSeq: bigint }).linkSeq, (first as { linkSeq: bigint }).linkSeq, 'the reply names the entry that recorded it');
});

test('T-04 a retry 24 h less 1 min after D returns the recorded counter-offer from link_request', async () => {
  const h = await rejectionBackground();
  const r = h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) }, deadlineInMs: 20_000 });
  const first = await h.stub.hold(r);
  h.rt.advance(20_000 + 24 * HOUR_MS - 60_000);
  await h.stub.hold(h.stub.holdCmd({ rate: 1, window: { start: H(40), end: H(41) }, account: 'other' }));
  assert.equal(h.owner.stateOf(h.link)?.recordState(r.request), undefined, 'the memory record is gone');
  const logBefore = h.rt.log(utf8(h.link)).length;
  const again = await h.stub.hold(r);
  assert.deepEqual(body(again), body(first));
  assert.equal(h.owner.recalledRecords, 1);
  assert.equal(h.rt.log(utf8(h.link)).length, logBefore, 'the repeat writes nothing');
});

test('should refuse a repeat DEADLINE_PASSED when it comes after D + 24 h and the record has expired', async () => {
  const h = await rejectionBackground();
  const r = h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) }, deadlineInMs: 20_000 });
  await h.stub.hold(r);
  h.rt.advance(20_000 + 24 * HOUR_MS);
  assert.deepEqual(body(await h.stub.hold(r)), { result: 'REFUSED', reason: 'DEADLINE_PASSED' });
});

test('should report 0 Mbps as the largest rate when the rate that fits is below rate_min', async () => {
  const h = await harness({ policy: { ...DEFAULT_POLICY, rateMinMbps: 2 } });
  await confirmed(h, 9, H(10), H(11));
  const r = body(await h.stub.hold(h.stub.holdCmd({ rate: 3, window: { start: H(10), end: H(11) } })));
  assert.equal((r['counterOffer'] as { largestRateMbps: number }).largestRateMbps, 0);
  const one = body(await h.stub.hold(h.stub.holdCmd({ rate: 3, window: { start: H(10, 30), end: H(11, 30) } })));
  assert.equal((one['counterOffer'] as { largestRateMbps: number }).largestRateMbps, 0);
  await confirmed(h, 8, H(20), H(21));
  const two = body(await h.stub.hold(h.stub.holdCmd({ rate: 3, window: { start: H(20), end: H(21) } })));
  assert.deepEqual(two['counterOffer'], { largestRateMbps: 2, earliest: { window: { start: H(21), end: H(22) } } }, 'rate_min itself is reported');
});

test('should not give a counter-offer when the refusal is DEADLINE_PASSED, INVALID or TOMBSTONED', async () => {
  const h = await rejectionBackground();
  const late = h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) }, deadlineInMs: 100 });
  assert.deepEqual(body(await h.stub.hold(late)), { result: 'REFUSED', reason: 'DEADLINE_PASSED' });
  assert.deepEqual(body(await h.stub.hold(h.stub.holdCmd({ rate: 0, window: { start: H(10), end: H(11) } }))), { result: 'REFUSED', reason: { invalid: 'V1' } });
  const t = h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) } });
  await h.stub.release(h.stub.releaseCmd(t.request, t.deadline));
  assert.deepEqual(body(await h.stub.hold(t)), { result: 'REFUSED', reason: 'TOMBSTONED' });
});

// ---------------- C02 provider tests ----------------

test('C02 provider test 3: when the record in memory is gone, link_request answers a repeat of each operation', async () => {
  const h = await rejectionBackground();
  const refused = h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) } });
  const kept = h.stub.holdCmd({ rate: 1, window: { start: H(10), end: H(11) } });
  const releasedFirst = h.stub.holdCmd({ rate: 1, window: { start: H(10), end: H(11) } });
  const refusedReply = await h.stub.hold(refused);
  await h.stub.hold(kept);
  const conv = h.stub.convertCmd(kept);
  const convReply = await h.stub.convert(conv);
  const rel = h.stub.releaseCmd(releasedFirst.request, releasedFirst.deadline);
  const relReply = await h.stub.release(rel);
  h.rt.advance(10 * 60_000);
  await h.stub.hold(h.stub.holdCmd({ rate: 1, window: { start: H(40), end: H(41) }, account: 'other' }));
  for (const c of [refused, kept, releasedFirst]) assert.equal(h.owner.stateOf(h.link)?.recordState(c.request), undefined, 'memory has no record');
  const rows = await h.rt.consistentRead((tx) => tx.query('SELECT seq FROM link_request WHERE link_id = $1', [h.link]), 'present');
  assert.ok(rows.length >= 3, 'each final record has a link_request row');
  const n = h.rt.log(utf8(h.link)).length;
  assert.deepEqual(body(await h.stub.hold(refused)), body(refusedReply));
  assert.deepEqual(body(await h.stub.hold(kept)), { result: 'CONVERTED', part: conv.part });
  assert.deepEqual(body(await h.stub.convert(conv)), body(convReply));
  assert.deepEqual(await h.stub.convert({ ...conv, part: 'another' }), { code: 'MISMATCH' });
  assert.deepEqual(body(await h.stub.hold(releasedFirst)), { result: 'REFUSED', reason: 'TOMBSTONED' });
  assert.deepEqual(body(await h.stub.release(rel)), body(relReply));
  assert.deepEqual(await h.stub.hold({ ...refused, rateMbps: 4 }), { code: 'MISMATCH' });
  assert.equal(h.rt.log(utf8(h.link)).length, n, 'no repeat writes an entry');
  assert.equal(h.owner.recalledRecords, 7);
});

test('should extend the tombstone and keep the recorded refusal when a release with a later D comes after the memory record is gone', async () => {
  const h = await rejectionBackground();
  const refused = h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) } });
  const first = await h.stub.hold(refused);
  h.rt.advance(10 * 60_000);
  await h.stub.hold(h.stub.holdCmd({ rate: 1, window: { start: H(40), end: H(41) }, account: 'other' }));
  const later = refused.deadline + 5_000;
  assert.deepEqual(body(await h.stub.release(h.stub.releaseCmd(refused.request, later))), { result: 'RELEASED', tombstoneUntil: later + 60_000 });
  assert.deepEqual(body(await h.stub.hold(refused)), body(first), 'the hold made the record, so a repeat is the refusal, not TOMBSTONED');
  const rows = await h.rt.consistentRead((tx) => tx.query<{ deadline_at: string }>(
    'SELECT deadline_at FROM link_request WHERE link_id = $1 AND request_part = $2 AND request_seq = $3',
    [h.link, refused.request.partition, refused.request.seq]), 'present');
  assert.deepEqual(rows.map((r) => r.deadline_at), [new Date(later).toISOString()], 'the row TTL counts from the later D');
  const slot = h.rt.route(LINK_KIND, utf8(h.link)).slot;
  const rt = h.rt as RuntimeDouble;
  rt.release(slot, 'taken');
  const owner2 = new LinkOwner(rt, { readLog: doubleLogReader(rt), links: [h.link] });
  rt.attach(owner2);
  await rt.acquire(slot);
  assert.deepEqual(owner2.alerts, []);
  assert.deepEqual(owner2.stateOf(h.link)?.recordState(refused.request), { state: 'REFUSED', madeBy: 'hold', tombstoneUntil: later + 60_000 });
  assert.deepEqual(body(await new AccountStub(rt, owner2, h.link).hold(refused)), body(first));
});

test('should keep a held request record in memory for the life of its hold, also after D + release_grace', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 3, window: { start: H(10), end: H(11) }, deadlineInMs: 1_000 });
  await h.stub.hold(r);
  h.rt.advance(25 * HOUR_MS);
  await h.stub.hold(h.stub.holdCmd({ rate: 1, window: { start: H(40), end: H(41) }, account: 'other', deadlineInMs: 30_000 }));
  assert.equal(h.owner.stateOf(h.link)?.recordState(r.request)?.state, 'HELD');
  const c = h.stub.convertCmd(r);
  assert.deepEqual(body(await h.stub.convert(c)), { result: 'CONVERTED', part: c.part });
});

// ---------------- query ----------------

test('should answer query with UNSEEN, HELD with its attempt, CONVERTED and RELEASED, and write nothing, when the request is in each state', async () => {
  const h = await harness();
  const W = { start: H(10), end: H(11) };
  const unseen = h.stub.newRequest();
  assert.deepEqual(body(await h.owner.query(h.stub.envelope('b1'), queryCmd(h, unseen))), { state: 'UNSEEN' });
  const held = h.stub.holdCmd({ rate: 2, window: W });
  await h.stub.hold(held);
  const n = h.rt.log(utf8(h.link)).length;
  const q = await h.owner.query(h.stub.envelope('b1'), queryCmd(h, held.request));
  assert.deepEqual(body(q), { state: 'HELD', attempt: 1 });
  assert.equal((q as { linkSeq: bigint }).linkSeq, h.owner.stateOf(h.link)?.appliedSeq);
  assert.equal(h.rt.log(utf8(h.link)).length, n, 'a query writes no entry');
  await h.stub.convert(h.stub.convertCmd(held));
  assert.deepEqual(body(await h.owner.query(h.stub.envelope('b1'), queryCmd(h, held.request))), { state: 'CONVERTED' });
  const rel = h.stub.holdCmd({ rate: 2, window: W });
  await h.stub.hold(rel);
  await h.stub.release(h.stub.releaseCmd(rel.request, rel.deadline));
  assert.deepEqual(body(await h.owner.query(h.stub.envelope('b1'), queryCmd(h, rel.request))), { state: 'RELEASED', tombstoneUntil: rel.deadline + 60_000 });
  const unseenRelease = h.stub.newRequest();
  await h.stub.release(h.stub.releaseCmd(unseenRelease, rel.deadline));
  assert.deepEqual(body(await h.owner.query(h.stub.envelope('b1'), queryCmd(h, unseenRelease))), { state: 'RELEASED', tombstoneUntil: rel.deadline + 60_000 });
  assert.deepEqual(h.rt.unleasedActions(), []);
});

test('should answer query from link_request when the record is gone from memory, and UNSEEN after D + 24 h', async () => {
  const h = await rejectionBackground();
  const r = h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) }, deadlineInMs: 20_000 });
  const reply = body(await h.stub.hold(r));
  h.rt.advance(5 * 60_000);
  await h.stub.hold(h.stub.holdCmd({ rate: 1, window: { start: H(40), end: H(41) }, account: 'other' }));
  const { result: _r, ...refusal } = reply;
  assert.deepEqual(body(await h.owner.query(h.stub.envelope('b1'), queryCmd(h, r.request))),
    { state: 'REFUSED', refusal, tombstoneUntil: r.deadline + 60_000 });
  h.rt.advance(24 * HOUR_MS);
  assert.deepEqual(body(await h.owner.query(h.stub.envelope('b1'), queryCmd(h, r.request))), { state: 'UNSEEN' });
});

test('should refuse a query that is not routed to the lease holder, and answer NOT_OWNER without a lease', async () => {
  const h = await harness();
  const q = queryCmd(h, h.stub.newRequest());
  const slot = h.rt.route(LINK_KIND, utf8(h.link)).slot;
  assert.equal(resultOf(await h.owner.query(h.stub.envelope('b1', { slot: (slot + 1) % 256 }), q)), 'NOT_OWNER');
  assert.equal(resultOf(await h.owner.query(h.stub.envelope('b1', { epoch: 9n }), q)), 'STALE_EPOCH');
  assert.equal(resultOf(await h.owner.query(h.stub.envelope('b1'), { ...q, receiverPartition: 'other' })), 'UNKNOWN_LINK');
  h.rt.setLease(slot, false);
  assert.equal(resultOf(await h.owner.query(h.stub.envelope('b1'), q)), 'NOT_OWNER');
});

test('should answer UNKNOWN_LINK to a query when the link is not registered', async () => {
  const h = await harness();
  const other = new AccountStub(h.rt, h.owner, 'L-unknown');
  const r = await h.owner.query(other.envelope('b1'), { link: 'L-unknown', receiverPartition: 'L-unknown', request: other.newRequest() });
  assert.deepEqual(r, { code: 'UNKNOWN_LINK' });
});

// ---------------- availability and fit_ranges ----------------

function availability(h: Harness, window: { start: number; end: number | null }, rateMbps: number): AvailabilityQuery {
  return { link: h.link, receiverPartition: h.link, window, rateMbps };
}

function fitQuery(h: Harness, rateMbps: number, from: number, until: number, k: number): FitRangesQuery {
  return { link: h.link, receiverPartition: h.link, rateMbps, from, until, k };
}

test('should answer availability beside held capacity, as of the applied sequence, and write nothing, when a request is in flight', async () => {
  const h = await rejectionBackground();
  await h.stub.hold(h.stub.holdCmd({ rate: 1, window: { start: H(10), end: H(11) }, account: 'pending' }));
  const n = h.rt.log(utf8(h.link)).length;
  const a = await h.owner.availability(h.stub.envelope('b1'), availability(h, { start: H(10), end: H(11) }, 5));
  assert.deepEqual(body(a), {
    asOfSeq: h.owner.stateOf(h.link)?.appliedSeq,
    offer: { largestRateMbps: 1, earliest: { window: { start: H(12), end: H(13) } } },
  });
  const open = await h.owner.availability(h.stub.envelope('b1'), availability(h, { start: H(10), end: null }, 5));
  assert.deepEqual(body(open)['offer'], { largestRateMbps: 1, earliest: { window: { start: H(12), end: null } } });
  assert.equal(h.rt.log(utf8(h.link)).length, n);
  assert.deepEqual(h.rt.unleasedActions(), []);
});

test('should answer fit_ranges with at most k maximal ranges and where to continue when k is smaller than the ranges found', async () => {
  const h = await harness();
  await confirmed(h, 8, H(10), H(11));
  await confirmed(h, 8, H(12), H(13));
  await h.stub.hold(h.stub.holdCmd({ rate: 8, window: { start: H(14), end: H(15) }, account: 'pending' }));
  const all = body(await h.owner.fitRanges(h.stub.envelope('b1'), fitQuery(h, 5, H(9), H(16), 10)));
  assert.deepEqual(all['ranges'], [
    { start: H(9), end: H(10) }, { start: H(11), end: H(12) }, { start: H(13), end: H(14) }, { start: H(15), end: H(16) },
  ]);
  assert.equal(all['continueFrom'], null);
  const two = body(await h.owner.fitRanges(h.stub.envelope('b1'), fitQuery(h, 5, H(9), H(16), 2)));
  assert.deepEqual(two['ranges'], [{ start: H(9), end: H(10) }, { start: H(11), end: H(12) }]);
  assert.equal(two['continueFrom'], H(12));
  const next = body(await h.owner.fitRanges(h.stub.envelope('b1'), fitQuery(h, 5, H(12), H(16), 2)));
  assert.deepEqual(next['ranges'], [{ start: H(13), end: H(14) }, { start: H(15), end: H(16) }]);
  assert.equal(next['continueFrom'], null);
  const small = body(await h.owner.fitRanges(h.stub.envelope('b1'), fitQuery(h, 2, H(9), H(16), 10)));
  assert.deepEqual(small['ranges'], [{ start: H(9), end: H(16) }], 'a rate that fits everywhere gives one range');
  const none = body(await h.owner.fitRanges(h.stub.envelope('b1'), fitQuery(h, 5, H(10), H(11), 3)));
  assert.deepEqual([none['ranges'], none['continueFrom']], [[], null]);
});

test('should answer UNAVAILABLE and alert INVALID_QUERY when an availability question is malformed', async () => {
  const h = await harness();
  const env = h.stub.envelope('b1');
  assert.deepEqual(await h.owner.availability(env, availability(h, { start: H(10), end: H(10) }, 5)), { code: 'UNAVAILABLE' });
  assert.deepEqual(await h.owner.availability(env, availability(h, { start: H(10), end: H(11) }, 1.5)), { code: 'UNAVAILABLE' });
  assert.deepEqual(await h.owner.availability(env, availability(h, { start: H(10), end: H(11) }, -1)), { code: 'UNAVAILABLE' });
  assert.deepEqual(await h.owner.availability(env, availability(h, { start: 0.5, end: null }, 1)), { code: 'UNAVAILABLE' });
  assert.deepEqual(await h.owner.fitRanges(env, fitQuery(h, 5, H(9), H(16), 0)), { code: 'UNAVAILABLE' });
  assert.deepEqual(await h.owner.fitRanges(env, fitQuery(h, 5, H(9), 1.5, 1)), { code: 'UNAVAILABLE' });
  assert.deepEqual(await h.owner.fitRanges(env, fitQuery(h, 5, 0.5, H(9), 1)), { code: 'UNAVAILABLE' });
  assert.deepEqual(await h.owner.fitRanges(env, fitQuery(h, -2, H(9), H(16), 1)), { code: 'UNAVAILABLE' });
  assert.deepEqual(await h.owner.availability(env, availability(h, { start: H(10), end: H(10) + 0.5 }, 5)), { code: 'UNAVAILABLE' });
  assert.deepEqual(await h.owner.availability(env, availability(h, { start: H(11), end: H(10) }, 5)), { code: 'UNAVAILABLE' });
  assert.deepEqual(await h.owner.fitRanges(env, fitQuery(h, 5, H(9), H(16), 1.5)), { code: 'UNAVAILABLE' });
  assert.equal(h.owner.alerts.filter((a) => a.kind === 'INVALID_QUERY').length, 11);
  assert.ok(!('code' in await h.owner.availability(env, availability(h, { start: H(10), end: H(11) }, 0))));
});

test('should record the counter-offer in the log entry when a hold is refused', async () => {
  const h = await rejectionBackground();
  const r = await h.stub.hold(h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) } }));
  const entry = h.rt.log(utf8(h.link)).at(-1);
  assert.equal(entry?.entry.kind, ENTRY.Hold);
  assert.deepEqual((entry?.entry.payload as { outcome: unknown }).outcome, body(r));
});

// ---------------- review 67 ----------------

async function takeover(h: Harness): Promise<LinkOwner> {
  const slot = h.rt.route(LINK_KIND, utf8(h.link)).slot;
  const rt = h.rt as RuntimeDouble;
  rt.release(slot, 'taken');
  const owner2 = new LinkOwner(rt, { readLog: doubleLogReader(rt), links: [h.link] });
  rt.attach(owner2);
  await rt.acquire(slot);
  return owner2;
}

test('T-04 a replay after a takeover decides as the live batch when the batch budget binds', async () => {
  const h = await harness({ policy: { ...DEFAULT_POLICY, counterofferSteps: 2, counterofferBatchSteps: 3 } });
  for (const [s, e] of [[H(10), H(10, 30)], [H(10, 40), H(11, 10)], [H(11, 20), H(11, 50)], [H(12), H(12, 30)]] as const) {
    await confirmed(h, 8, s, e);
  }
  const a = h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) }, account: 'a' });
  const b = h.stub.holdCmd({ rate: 5, window: { start: H(10, 5), end: H(11, 5) }, account: 'b' });
  const n = h.rt.appends.length;
  const [liveA, liveB] = await Promise.all([h.stub.hold(a), h.stub.hold(b)]);
  assert.equal(h.rt.appends.length, n + 1, 'one batch');
  assert.deepEqual((body(liveA)['counterOffer'] as { earliest: unknown }).earliest, { notFoundBefore: H(11, 10) });
  assert.deepEqual((body(liveB)['counterOffer'] as { earliest: unknown }).earliest, { notFoundBefore: H(10, 30) }, 'one step was left for b');
  const c = h.stub.holdCmd({ rate: 5, window: { start: H(10, 1), end: H(11, 1) }, account: 'c' });
  const liveC = await h.stub.hold(c);
  assert.deepEqual((body(liveC)['counterOffer'] as { earliest: unknown }).earliest, { notFoundBefore: H(11, 10) }, 'the next batch has the whole budget');
  const owner2 = await takeover(h);
  assert.deepEqual(owner2.alerts, [], 'the replay starts the batch budget at the same entry as the live batch');
  const stub2 = new AccountStub(h.rt, owner2, h.link);
  assert.deepEqual(body(await stub2.hold(b)), body(liveB));
  assert.deepEqual(body(await stub2.hold(a)), body(liveA));
  assert.deepEqual(body(await stub2.hold(c)), body(liveC));
});

test('P1-S38 a window that fits only after the selling horizon of the receipt minute is not offered', async () => {
  const h = await harness();
  const m0 = Math.floor(hlcToWallMs(h.rt.now().ts) / 60_000);
  const hz = horizonMinute(m0, 12);
  await confirmed(h, 10, H(10), hz - 30);
  const none = body(await h.stub.hold(h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) } })));
  assert.deepEqual(none['counterOffer'], { largestRateMbps: 0, earliest: { none: true } });
  const h2 = await harness({ link: 'L2' });
  await confirmed(h2, 10, H(10), hz - 60);
  const last = body(await h2.stub.hold(h2.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) } })));
  assert.deepEqual(last['counterOffer'], { largestRateMbps: 0, earliest: { window: { start: hz - 60, end: hz } } });
});

test('should answer STOPPED to query, availability and fit_ranges when the link stopped on replay', async () => {
  const h = await harness();
  const a = h.stub.holdCmd({ rate: 4, window: { start: H(10), end: H(11) } });
  await h.stub.hold(a);
  (h.rt.log(utf8(h.link)).at(-1)?.entry.payload as { outcome: unknown }).outcome = { result: 'REFUSED', reason: 'NO_FIT' };
  const owner2 = await takeover(h);
  assert.ok(owner2.alerts.some((x) => x.kind === 'OUTCOME_MISMATCH_ON_REPLAY'));
  const env = new AccountStub(h.rt, owner2, h.link).envelope('b1');
  assert.deepEqual(await owner2.query(env, queryCmd(h, a.request)), { code: 'STOPPED' });
  assert.deepEqual(await owner2.availability(env, availability(h, { start: H(10), end: H(11) }, 1)), { code: 'STOPPED' });
  assert.deepEqual(await owner2.fitRanges(env, fitQuery(h, 1, H(9), H(12), 2)), { code: 'STOPPED' });
});

test('should answer UNAVAILABLE and alert READ_FAILED once when the link_request read fails', async () => {
  const h = await harness();
  const rt = h.rt as RuntimeDouble;
  rt.consistentRead = async () => { throw new Error('database unreachable'); };
  const reply = await h.owner.query(h.stub.envelope('b1'), queryCmd(h, h.stub.newRequest()));
  assert.deepEqual(reply, { code: 'UNAVAILABLE' });
  assert.deepEqual(h.owner.alerts.map((a) => a.kind), ['READ_FAILED']);
  assert.deepEqual(h.owner.alerts[0]?.detail, 'Error: database unreachable');
});

test('should alert REQUEST_ROW_WITHOUT_RECORD when the log row that link_request names has no record', async () => {
  const h = await rejectionBackground();
  const r = h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) } });
  const first = await h.stub.hold(r);
  const seq = (first as { linkSeq: bigint }).linkSeq;
  delete (h.rt.log(utf8(h.link)).find((e) => e.seq === seq)?.entry.payload as { record?: unknown }).record;
  h.rt.advance(10 * 60_000);
  await h.stub.hold(h.stub.holdCmd({ rate: 1, window: { start: H(40), end: H(41) }, account: 'other' }));
  await h.owner.query(h.stub.envelope('b1'), queryCmd(h, r.request));
  assert.deepEqual(h.owner.alerts.at(-1), { kind: 'REQUEST_ROW_WITHOUT_RECORD', link: h.link, request: requestKey(r.request), detail: `seq ${seq}` });
  assert.equal(h.owner.recalledRecords, 0);
});

test('should not read link_request when new holds arrive before their D_c', async () => {
  const h = await rejectionBackground();
  const rt = h.rt as RuntimeDouble;
  let reads = 0;
  const read = rt.consistentRead.bind(rt);
  rt.consistentRead = async (fn, at) => { reads += 1; return read(fn, at); };
  for (let i = 0; i < 10; i++) await h.stub.hold(h.stub.holdCmd({ rate: 1 + (i % 6), window: { start: H(10, i), end: H(11, i) }, account: `n${i}` }));
  assert.equal(reads, 0);
  const late = h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) }, deadlineInMs: 30_000 });
  await h.stub.hold(late);
  h.rt.advance(10 * 60_000);
  await h.stub.hold(late);
  assert.equal(reads, 1, 'a repeat after its D_c reads the row');
});
