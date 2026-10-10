import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageTree } from '../src/tree.ts';

const DAY = 24 * 60;
const hm = (h: number, m = 0) => h * 60 + m;

test('touching intervals [a, b) and [b, c) do not overlap', () => {
  const t = new UsageTree(DAY);
  assert.deepEqual(t.admit(hm(10), hm(11), 10, 10), { ok: true });
  assert.deepEqual(t.admit(hm(11), hm(12), 10, 10), { ok: true });
  assert.equal(t.usageAt(hm(11) - 1), 10);
  assert.equal(t.usageAt(hm(11)), 10);
  assert.equal(t.usageAt(hm(12)), 0);
});

test('exact fit to capacity is admitted, one more Mbps is not', () => {
  const t = new UsageTree(DAY);
  assert.ok(t.admit(0, 60, 7, 10).ok);
  assert.ok(t.admit(30, 90, 3, 10).ok);
  const d = t.admit(59, 61, 1, 10);
  assert.deepEqual(d, { ok: false, peak: 10, conflicts: [[59, 60]] });
});

test('open-ended reservation blocks the rest of the horizon', () => {
  const t = new UsageTree(DAY);
  assert.ok(t.admit(hm(20), null, 6, 10).ok);
  assert.equal(t.usageAt(DAY - 1), 6);
  assert.ok(t.admit(0, hm(20), 10, 10).ok); // ends exactly where it starts
  const d = t.admit(hm(23), hm(23, 30), 5, 10);
  assert.equal(d.ok, false);
  assert.ok(!t.admit(0, null, 1, 10).ok);
});

test('A/B: summing overlaps would reject, the peak admits', () => {
  const t = new UsageTree(DAY);
  assert.ok(t.admit(hm(14), hm(14, 30), 8, 10).ok); // A
  assert.ok(t.admit(hm(15), hm(16), 8, 10).ok); // B
  assert.equal(t.peak(hm(14), hm(16)), 8);
  assert.ok(t.admit(hm(14), hm(16), 2, 10).ok);
  assert.equal(t.usageAt(hm(14, 45)), 2);
});

test('rejection names every conflicting sub-range', () => {
  const t = new UsageTree(DAY);
  t.admit(100, 110, 9, 10);
  t.admit(200, 205, 9, 10);
  const d = t.admit(50, 300, 2, 10);
  assert.deepEqual(d, { ok: false, peak: 9, conflicts: [[100, 110], [200, 205]] });
});

test('a year-long booking is two point updates', () => {
  const YEAR = 365 * DAY;
  const t = new UsageTree(YEAR);
  assert.ok(t.admit(0, YEAR, 4, 10).ok);
  assert.ok(t.admit(YEAR / 2, YEAR / 2 + 60, 6, 10).ok);
  assert.ok(!t.admit(10, YEAR - 10, 1, 10).ok);
  assert.equal(t.peak(0, YEAR), 10);
});
