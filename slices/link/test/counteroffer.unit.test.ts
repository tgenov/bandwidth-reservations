/**
 * Unit tests of the counter-offer functions and of the request-record parts of the state machine
 * (review 67: TR-2, TR-3, TR-4, TR-6, TR-8, TR-10, TR-11).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8, type HlcTs } from '@share/owner-runtime';
import {
  DEFAULT_POLICY, earliest, fitRanges, horizonMinute, LinkState, OccupancyTree, requestKey, type HoldCmd,
} from '../src/index.ts';

const minuteOf = (y: number, mo: number, d: number, hh = 0, mm = 0): number => Date.UTC(y, mo, d, hh, mm) / 60_000;
const tsAt = (ms: number): HlcTs => `${BigInt(ms) * 1_000_000n}.0000000000` as HlcTs;
const T0 = Date.UTC(2026, 2, 2, 9);

function blocked(): OccupancyTree {
  const t = new OccupancyTree();
  t.add(100, 200, 10);
  return t;
}

// ---------------- TR-2: the selling horizon ----------------

test('should limit the earliest window to the selling horizon when the free capacity starts near it', () => {
  assert.deepEqual(earliest(blocked(), 10, 100, 50, 5, 250, 512).value, { window: { start: 200, end: 250 } });
  assert.deepEqual(earliest(blocked(), 10, 100, 50, 5, 249, 512).value, { none: true });
  assert.deepEqual(earliest(blocked(), 10, 100, null, 5, 201, 512).value, { window: { start: 200, end: null } });
  assert.deepEqual(earliest(blocked(), 10, 100, null, 5, 200, 512).value, { none: true });
  assert.deepEqual(earliest(new OccupancyTree(), 10, 100, 50, 5, 150, 512).value, { window: { start: 100, end: 150 } }, 'a window that ends at H is valid');
});

test('should clamp the horizon to the last day of the month when the date does not exist in that month', () => {
  assert.equal(horizonMinute(minuteOf(2026, 2, 31, 10, 0), 1), minuteOf(2026, 3, 30, 10, 0));
  assert.equal(horizonMinute(minuteOf(2027, 0, 31), 1), minuteOf(2027, 1, 28));
  assert.equal(horizonMinute(minuteOf(2028, 0, 31), 1), minuteOf(2028, 1, 29));
  assert.equal(horizonMinute(minuteOf(2026, 2, 31, 10, 0), 12), minuteOf(2027, 2, 31, 10, 0), 'P1-S74: 31 March 2026 → 31 March 2027');
  assert.equal(horizonMinute(minuteOf(2028, 1, 29, 10, 0), 12), minuteOf(2029, 1, 28, 10, 0), 'P1-S74: 29 February 2028 → 28 February 2029');
  assert.equal(horizonMinute(minuteOf(2026, 2, 2, 9, 17), 12), minuteOf(2027, 2, 2, 9, 17));
});

test('should not reuse a cached earliest window when two refusals have other horizons', () => {
  const st = new LinkState();
  st.init({ link: 'P', capacityMbps: 10, policy: DEFAULT_POLICY });
  // Full until 10 min before the horizon of the first request: an hour fits only after it, so it gets none.
  const m0 = minuteOf(2026, 2, 2, 9);
  const h0 = horizonMinute(m0, 12);
  st.occAll.add(m0 + 60, h0 - 10, 10);
  st.occFirm.add(m0 + 60, h0 - 10, 10);
  st.commit();
  const ts = tsAt(T0);
  st.beginBatch(ts);
  const hold = (seq: bigint, receiptMinute: number): HoldCmd => ({
    link: 'P', receiverPartition: 'P', request: { partition: utf8('a'), seq }, account: utf8('a'), leg: 'l', holdKind: { kind: 'booking' },
    rateMbps: 5, window: { start: m0 + 60, end: m0 + 120 }, deadline: T0 + 20_000, commitFence: T0 + 19_580, requestAge: ts, wait: false,
    receiptMinute, policyVersion: 1n,
  });
  const a = st.decide({ op: 'hold', body: hold(1n, m0) }, ts, 1n);
  const b = st.decide({ op: 'hold', body: hold(2n, m0 + 60) }, ts, 2n);
  assert.deepEqual((a.outcome as { counterOffer?: unknown }).counterOffer, { largestRateMbps: 0, earliest: { none: true } });
  assert.deepEqual((b.outcome as { counterOffer?: unknown }).counterOffer,
    { largestRateMbps: 0, earliest: { window: { start: h0 - 10, end: h0 + 50 } } }, 'a later receipt minute has a later horizon');
});

// ---------------- TR-3: fit_ranges bounds ----------------

function comb(): OccupancyTree {
  const t = new OccupancyTree();
  for (let i = 0; i < 4; i++) t.add(10 * i, 10 * i + 5, 10);
  return t;
}

test('should stop fit_ranges at the step bound and give where to continue when the bound is reached', () => {
  assert.deepEqual(fitRanges(comb(), 10, 5, 0, 100, 10, 2), { ranges: [{ start: 5, end: 10 }, { start: 15, end: 20 }], continueFrom: 20 });
  assert.deepEqual(fitRanges(comb(), 10, 5, 0, 100, 10, 0), { ranges: [], continueFrom: 0 });
  assert.deepEqual(fitRanges(comb(), 10, 5, 0, 100, 10, 5), {
    ranges: [{ start: 5, end: 10 }, { start: 15, end: 20 }, { start: 25, end: 30 }, { start: 35, end: 100 }], continueFrom: null,
  });
});

test('should cut a range at until and end the search when the next fit is after until', () => {
  assert.deepEqual(fitRanges(comb(), 10, 5, 0, 12, 10, 9), { ranges: [{ start: 5, end: 10 }], continueFrom: null });
  assert.deepEqual(fitRanges(comb(), 10, 5, 5, 8, 10, 9), { ranges: [{ start: 5, end: 8 }], continueFrom: null });
});

test('should give no range when the schedule is full for ever from the start', () => {
  const t = new OccupancyTree();
  t.add(0, null, 10);
  assert.deepEqual(fitRanges(t, 10, 5, 0, 100, 10, 9), { ranges: [], continueFrom: null });
});

// ---------------- TR-4: open-ended availability ----------------

test('should answer open-ended availability from the requested start when the last conflict is before it', () => {
  assert.deepEqual(earliest(blocked(), 10, 300, null, 5, 10 ** 9, 512).value, { window: { start: 300, end: null } });
  assert.deepEqual(earliest(blocked(), 10, 199, null, 5, 10 ** 9, 512).value, { window: { start: 200, end: null } });
  assert.deepEqual(earliest(blocked(), 10, 200, null, 5, 10 ** 9, 512).value, { window: { start: 200, end: null } });
  assert.deepEqual(earliest(new OccupancyTree(), 10, 77, null, 5, 10 ** 9, 512).value, { window: { start: 77, end: null } });
});

// ---------------- request records and the state machine ----------------

function holdAt(seq: bigint, deadline: number, rate = 1): HoldCmd {
  return {
    link: 'P', receiverPartition: 'P', request: { partition: utf8('a'), seq }, account: utf8('a'), leg: 'l', holdKind: { kind: 'booking' },
    rateMbps: rate, window: { start: 1000, end: 1060 }, deadline, commitFence: deadline - 420, requestAge: tsAt(T0), wait: false,
    receiptMinute: Math.floor(T0 / 60_000), policyVersion: 1n,
  };
}

function freshState(): LinkState {
  const st = new LinkState();
  st.init({ link: 'P', capacityMbps: 10, policy: DEFAULT_POLICY });
  st.commit();
  return st;
}

test('should remove each final record at its own D + release_grace when two records are due at other times', () => {
  const st = freshState();
  const a = holdAt(1n, T0 + 60_000, 0);
  const b = holdAt(2n, T0 + 300_000, 0);
  st.beginBatch(tsAt(T0));
  st.decide({ op: 'hold', body: a }, tsAt(T0), 1n);
  st.decide({ op: 'hold', body: b }, tsAt(T0), 2n);
  st.commit();
  assert.equal(st.nextPruneAt, a.deadline + 60_000);
  st.beginBatch(tsAt(a.deadline + 60_000));
  st.commit();
  assert.equal(st.recordState(a.request), undefined);
  assert.equal(st.recordState(b.request)?.state, 'REFUSED');
  assert.equal(st.nextPruneAt, b.deadline + 60_000);
  st.beginBatch(tsAt(b.deadline + 60_000));
  st.commit();
  assert.equal(st.recordState(b.request), undefined);
  assert.equal(st.nextPruneAt, Infinity);
});

test('should read link_request for a hold only when it is at or after its D_c, and for a convert whenever memory has no record', () => {
  const st = freshState();
  const h = holdAt(1n, T0 + 120_000);
  assert.equal(st.needsRecall({ op: 'hold', body: h }, T0, 60_000), false, 'a new hold before D_c reads nothing');
  assert.equal(st.needsRecall({ op: 'hold', body: h }, h.commitFence, 60_000), true);
  assert.equal(st.needsRecall({ op: 'hold', body: h }, h.commitFence - 1, 60_000), false, 'the margin does not apply to a new hold');
  const conv = { link: 'P', receiverPartition: 'P', request: h.request, attempt: 1, reservation: 'r', leg: 'l', part: 'p', createdBy: h.request, decisionTime: tsAt(T0) };
  assert.equal(st.needsRecall({ op: 'convert', body: conv }, T0, 60_000), true);
  st.beginBatch(tsAt(T0));
  st.decide({ op: 'hold', body: h }, tsAt(T0), 1n);
  st.commit();
  assert.equal(st.needsRecall({ op: 'convert', body: conv }, T0 + 10 * 3_600_000, 60_000), false, 'a held record stays in memory');
});

test('should not write a second Init entry when the link is registered again, and answer UNKNOWN_LINK for another link', () => {
  const st = freshState();
  assert.deepEqual(st.init({ link: 'P', capacityMbps: 5, policy: DEFAULT_POLICY }), { outcome: { result: 'INITIALISED' }, entry: false });
  assert.equal(st.cRef, 10);
  const other = { ...holdAt(1n, T0 + 60_000), link: 'Q', receiverPartition: 'Q' };
  assert.deepEqual(st.decide({ op: 'hold', body: other }, tsAt(T0), 1n), { outcome: { code: 'UNKNOWN_LINK' }, entry: false });
});

test('should record the leg part with its rate, window, request and age when a hold converts', () => {
  const st = freshState();
  const h = holdAt(1n, T0 + 60_000, 3);
  st.beginBatch(tsAt(T0));
  st.decide({ op: 'hold', body: h }, tsAt(T0), 1n);
  const decisionTime = tsAt(T0 + 5);
  st.decide({ op: 'convert', body: { link: 'P', receiverPartition: 'P', request: h.request, attempt: 1, reservation: 'r1', leg: 'l', part: 'p1', createdBy: h.request, decisionTime } }, tsAt(T0), 2n);
  assert.deepEqual(st.partsInOrder(), [{
    reservation: 'r1', leg: 'l', part: 'p1', request: requestKey(h.request), rateMbps: 3, window: { start: 1000, end: 1060 }, age: decisionTime,
  }]);
});

test('should charge the batch budget with the steps of each refusal and nothing for a cached answer', () => {
  const st = freshState();
  st.occAll.add(1000, 1060, 8);
  st.occFirm.add(1000, 1060, 8);
  st.occAll.add(1070, 1080, 8);
  st.commit();
  st.beginBatch(tsAt(T0));
  assert.equal(st.counterofferStepsLeft, 4_096);
  st.decide({ op: 'hold', body: holdAt(1n, T0 + 60_000, 5) }, tsAt(T0), 1n);
  assert.equal(st.counterofferStepsLeft, 4_093, 'three steps: [1000, 1060) and [1060, 1120) are blocked, [1080, 1140) fits');
  st.decide({ op: 'hold', body: holdAt(2n, T0 + 60_000, 5) }, tsAt(T0), 2n);
  assert.equal(st.counterofferStepsLeft, 4_093, 'the same question again uses the cache');
  st.beginBatch(tsAt(T0 + 1));
  assert.equal(st.counterofferStepsLeft, 4_096, 'a new batch has the whole budget');
});
