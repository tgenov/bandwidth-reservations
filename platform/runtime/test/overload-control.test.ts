/**
 * RFC-006 §4.7 rule 5a (admission control on the standing queue) and rule 5b (the per-entry batch cap), one rule
 * and one boundary per test. Expected estimator values are those of the fit in `tools/overload_model.py`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LaneCostModel, SlotAdmission, expectedSojournMs } from '../src/overload.ts';

const assertClose = (actual: number | undefined, expected: number, what: string): void => {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${what}: ${actual} ≠ ${expected}`);
};

const fixed = (u: number) => (): number => u;

const fitted = (points: Array<[number, number]>, at = 0): LaneCostModel => {
  const m = new LaneCostModel();
  for (const [n, d] of points) m.observe(n, d, at);
  return m;
};

// ---------------- 5a: entry, release, hysteresis ----------------

test('should enter the overloaded state when every sample stays above the target for overload_interval', () => {
  const a = new SlotAdmission(fixed(0));
  assert.equal(a.sample(0, 501), false);
  assert.equal(a.sample(999, 2_000), false);
  assert.equal(a.state, 'admitting');
  assert.equal(a.sample(1_000, 501), true);
  assert.equal(a.state, 'overloaded');
  assert.equal(a.overloadedSinceMs, 1_000);
  assert.equal(a.stateChanges, 1);
});

test('should end the run when a sample is at the target exactly', () => {
  const a = new SlotAdmission(fixed(0));
  a.sample(0, 600);
  assert.equal(a.sample(500, 500), false);
  assert.equal(a.sample(1_200, 600), false);
  assert.equal(a.sample(2_199, 600), false);
  assert.equal(a.state, 'admitting');
  assert.equal(a.sample(2_200, 600), true);
});

test('should end the run when the take empties the queue (a sample of 0)', () => {
  const a = new SlotAdmission(fixed(0));
  a.sample(0, 900);
  a.sample(800, 0);
  assert.equal(a.sample(1_000, 900), false);
  assert.equal(a.state, 'admitting');
});

test('should release when the expected sojourn is at the target and not when it is 1 ms above', () => {
  const a = new SlotAdmission(fixed(0));
  a.sample(0, 900);
  a.sample(1_000, 900);
  assert.equal(a.release(501, 0), false);
  assert.equal(a.state, 'overloaded');
  assert.equal(a.release(500, 1_700), true);
  assert.equal(a.state, 'admitting');
  assert.equal(a.lastChangeMs, 1_700);
  assert.equal(a.overloadedSinceMs, undefined);
  assert.equal(a.stateChanges, 2);
});

test('should not release when the slot is not overloaded', () => {
  const a = new SlotAdmission(fixed(0));
  assert.equal(a.release(0, 0), false);
  assert.equal(a.stateChanges, 0);
});

test('should need a full new interval above the target to enter again after a release', () => {
  const a = new SlotAdmission(fixed(0));
  a.sample(0, 900);
  a.sample(1_000, 900);
  a.release(100, 0);
  assert.equal(a.sample(1_100, 900), false);
  assert.equal(a.sample(2_099, 900), false);
  assert.equal(a.state, 'admitting');
  assert.equal(a.sample(2_100, 900), true);
  assert.equal(a.stateChanges, 3);
});

test('should change nothing on samples taken while overloaded', () => {
  const a = new SlotAdmission(fixed(0));
  a.sample(0, 900);
  a.sample(1_000, 900);
  assert.equal(a.sample(1_500, 0), false);
  assert.equal(a.sample(3_000, 5_000), false);
  assert.equal(a.state, 'overloaded');
  assert.equal(a.stateChanges, 1);
});

// ---------------- 5a: retryAfterMs ----------------

test('should answer retry_floor when the random value is 0', () => {
  const a = new SlotAdmission(fixed(0));
  assert.equal(a.retryAfterMs(10, () => 1_000), 250);
});

test('should answer 250 ms plus the random share of the expected drain of the queued and shed calls', () => {
  const qs: number[] = [];
  const a = new SlotAdmission(fixed(0.5));
  const drain = (q: number): number => { qs.push(q); return q * 2; };
  assert.equal(a.retryAfterMs(100, drain), 250 + 0.5 * 202);
  assert.equal(a.retryAfterMs(100, drain), 250 + 0.5 * 204);
  assert.deepEqual(qs, [101, 102]);
});

test('should use a drain of 500 ms when the lane has no estimate', () => {
  assert.equal(new SlotAdmission(fixed(0.999_999)).retryAfterMs(10, () => undefined), 750);
  assert.equal(new SlotAdmission(fixed(0.5)).retryAfterMs(10, () => undefined), 500);
});

test('should clamp retryAfterMs to 5,000 ms after the base is added', () => {
  assert.equal(new SlotAdmission(fixed(0.999_999)).retryAfterMs(1, () => 60_000), 5_000);
  assert.equal(new SlotAdmission(fixed(0.95)).retryAfterMs(1, () => 60_000), 5_000);
  assert.equal(new SlotAdmission(fixed(0.9)).retryAfterMs(1, () => 60_000), 4_750);
});

test('should keep every retryAfterMs in [250, 5,000] ms over many random values', () => {
  let x = 12_345;
  const lcg = (): number => { x = (x * 1_103_515_245 + 12_345) % 2_147_483_648; return x / 2_147_483_648; };
  const a = new SlotAdmission(lcg);
  for (let i = 0; i < 5_000; i++) {
    const r = a.retryAfterMs(i, (q) => q * 3);
    assert.ok(r >= 250 && r <= 5_000, `seed 12345, call ${i}: ${r}`);
  }
});

test('should count the shed calls of the episode from 0 again at the next entry', () => {
  const qs: number[] = [];
  const a = new SlotAdmission(fixed(0));
  const drain = (q: number): number => { qs.push(q); return 0; };
  a.sample(0, 900); a.sample(1_000, 900);
  a.retryAfterMs(0, drain); a.retryAfterMs(0, drain);
  a.release(0, 0);
  a.sample(2_000, 900); a.sample(3_000, 900);
  a.retryAfterMs(0, drain);
  assert.deepEqual(qs, [1, 2, 1]);
});

// ---------------- 5a: the burst cap ----------------

test('should answer at most 500 shed calls at once in one 100 ms tick and the next at the next tick', () => {
  const a = new SlotAdmission(fixed(0));
  for (let i = 0; i < 500; i++) assert.equal(a.answerNow(i % 100), true);
  assert.equal(a.answerNow(99), false);
  assert.equal(a.answerNow(99), false);
  assert.equal(a.answerNow(100), true);
  assert.equal(a.shedAtOnce, 501);
  assert.equal(a.shedDeferred, 2);
});

// ---------------- 5a: expected sojourn ----------------

test('should take the expected sojourn from the drain estimate when there is one', () => {
  assert.equal(expectedSojournMs(1_050, 0, 5_000), 1_050);
});

test('should take the age of the oldest queued call as the expected sojourn when there is no estimate', () => {
  assert.equal(expectedSojournMs(undefined, 1_200, 2_000), 800);
  assert.equal(expectedSojournMs(undefined, undefined, 2_000), 0);
});

// ---------------- 5b: the estimator ----------------

test('should give the hard cap and no drain estimate when the lane has no sample', () => {
  const m = new LaneCostModel();
  assert.equal(m.nCap(0), 2_000);
  assert.equal(m.expectedDrainMs(100, 0), undefined);
  assert.equal(m.cHatMs(0), undefined);
});

test('should fit the fixed cost and the cost per entry by least squares when the sizes are 2 times apart', () => {
  const m = fitted([[10, 70], [20, 90], [40, 130]]);
  assertClose(m.fHatMs(0), 50, 'F̂');
  assertClose(m.cHatMs(0), 2, 'ĉ');
  assert.equal(m.nCap(0), 200);
  assertClose(m.expectedDrainMs(450, 0), 450 * 2 + 3 * 50, 'drain of 450 entries');
});

test('should not fit by least squares with fewer than 3 samples', () => {
  const m = fitted([[10, 70], [40, 130]]);
  assertClose(m.fHatMs(0), 70, 'F̂ (the smallest d)');
  assertClose(m.cHatMs(0), (130 - 70) / 40, 'ĉ over the samples of at least 16 entries');
});

test('should give no estimate from samples of fewer than 16 entries with no spread', () => {
  const m = fitted([[10, 70], [12, 74]]);
  assert.equal(m.cHatMs(0), undefined);
  assert.equal(m.nCap(0), 2_000);
});

test('should keep the hard cap when the fixed cost is large and the cost per entry small', () => {
  const m = fitted(Array.from({ length: 4 }, () => [[144, 478.8], [143, 478.6], [145, 479]] as Array<[number, number]>).flat());
  assertClose(m.fHatMs(0), 478.8, 'F̂');
  assertClose(m.cHatMs(0), 0.0013793103448275078, 'ĉ');
  assert.equal(m.nCap(0), 2_000);
  assert.equal(m.regimeResets, 0);
});

test('should cap the per-entry part only, so a large fixed cost does not shrink the batch', () => {
  const m = fitted([[100, 470], [200, 490], [400, 530]]);
  assertClose(m.fHatMs(0), 450, 'F̂');
  assertClose(m.cHatMs(0), 0.2, 'ĉ');
  assert.equal(m.nCap(0), 2_000);
});

test('should floor n_cap at 1 call when the cost per entry is above the budget', () => {
  const m = new LaneCostModel();
  m.censored(1, 2_000, 0);
  assert.equal(m.nCap(0), 1);
});

test('should reset the regime when a sample of at least 16 entries is above 2 times the prediction', () => {
  const m = fitted([[10, 70], [20, 90], [40, 130], [20, 181]]);
  assert.equal(m.regimeResets, 1);
  assert.equal(m.sampleCount(0), 1);
  assertClose(m.fHatMs(0), 50, 'F̂ kept');
  assertClose(m.cHatMs(0), 6.55, 'ĉ from the latest sample');
  assert.equal(m.nCap(0), 61);
});

test('should not reset the regime when a sample is at most 2 times the prediction', () => {
  const m = fitted([[10, 70], [20, 90], [40, 130], [20, 170]]);
  assert.equal(m.regimeResets, 0);
  assert.equal(m.sampleCount(0), 4);
  assertClose(m.fHatMs(0), 70, 'F̂');
  assertClose(m.cHatMs(0), 5, 'ĉ');
});

test('should not reset the regime on a slow sample of fewer than 16 entries', () => {
  const m = fitted([[10, 70], [20, 90], [40, 130], [10, 1_000]]);
  assert.equal(m.regimeResets, 0);
  assertClose(m.cHatMs(0), 93, 'ĉ');
});

test('should raise ĉ to the latest batch alone when the fitted slope is less than half of it', () => {
  const m = fitted([[10, 110], [20, 120], [40, 140], [40, 200]]);
  assert.equal(m.regimeResets, 0);
  assertClose(m.fHatMs(0), 84.44444444444444, 'F̂');
  assertClose(m.cHatMs(0), 2.111111111111111, 'ĉ = (d − F̂) / n of the latest batch');
  assert.equal(m.nCap(0), 189);
});

test('should use the latest batch alone when the fitted slope is not positive', () => {
  const m = fitted([[10, 200], [20, 150], [40, 100]]);
  assertClose(m.fHatMs(0), 100, 'F̂');
  assertClose(m.cHatMs(0), 0.001, 'ĉ');
});

test('should set ĉ to 2,000 / n at an abandon when no batch of the lane completed', () => {
  const m = new LaneCostModel();
  m.censored(1_000, 2_000, 0);
  assertClose(m.fHatMs(0), 0, 'F̂');
  assertClose(m.cHatMs(0), 2, 'ĉ');
  assert.equal(m.nCap(0), 200);
  assert.equal(m.regimeResets, 1);
});

test('should raise ĉ to (2,000 − F̂) / n at an abandon and discard the older samples', () => {
  const m = fitted([[10, 70], [20, 90], [40, 130]]);
  m.censored(500, 2_000, 0);
  assertClose(m.cHatMs(0), 3.9, 'ĉ');
  assert.equal(m.nCap(0), 102);
  assert.equal(m.sampleCount(0), 0);
  assert.equal(m.regimeResets, 1);
});

test('should keep ĉ at an abandon when it already predicts the abandon', () => {
  const m = fitted([[10, 70], [20, 90], [40, 130]]);
  m.censored(1_000, 2_000, 0);
  assertClose(m.cHatMs(0), 2, 'ĉ');
});

test('should probe with max(n_cap + 16, 1.5 n_cap) after 8 capped takes in a row', () => {
  const m = fitted([[10, 70], [20, 90], [40, 130]]);
  for (let i = 0; i < 7; i++) { assert.equal(m.takeCap(0), 200); m.noteTake(true); }
  assert.equal(m.takeCap(0), 200);
  m.noteTake(true);
  assert.equal(m.takeCap(0), 300);
  assert.equal(m.probeTakes, 1);
  m.noteTake(true);
  assert.equal(m.takeCap(0), 200);
});

test('should not probe when a take in the run was not capped', () => {
  const m = fitted([[10, 70], [20, 90], [40, 130]]);
  for (let i = 0; i < 7; i++) m.noteTake(true);
  m.noteTake(false);
  m.noteTake(true);
  assert.equal(m.takeCap(0), 200);
  assert.equal(m.probeTakes, 0);
});

test('should size a lower abandon budget with its own per-entry budget', () => {
  const m = fitted([[10, 70], [20, 90], [40, 130]]);
  assert.equal(m.nCap(0, 250 / 5), 25);
});

test('should drop samples older than 60 s and have no estimate when none is left', () => {
  const m = fitted([[10, 70], [20, 90], [40, 130]], 0);
  assert.equal(m.nCap(60_000), 200);
  assert.equal(m.nCap(60_001), 2_000);
  assert.equal(m.cHatMs(60_001), undefined);
  assert.equal(m.expectedDrainMs(10, 60_001), undefined);
});
