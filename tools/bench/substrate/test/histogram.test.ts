import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Histogram, bucketHigh, bucketIndex, bucketLow } from '../src/histogram.ts';
import { seededRng } from '../src/schedule.ts';

describe('histogram', () => {
  it('should give exact nearest-rank percentiles for values in the linear range', () => {
    const h = new Histogram();
    for (let v = 1; v <= 100; v++) h.record(v);
    assert.equal(h.count, 100);
    assert.equal(h.min, 1);
    assert.equal(h.max, 100);
    assert.equal(h.sum, 5050);
    assert.equal(h.percentile(50), 50);
    assert.equal(h.percentile(99), 99);
    assert.equal(h.percentile(99.9), 100);
    assert.equal(h.percentile(100), 100);
  });

  it('should take rank ceil(p × count), not the next value', () => {
    const h = new Histogram();
    for (let v = 1; v <= 1000; v++) h.record(v % 200 === 0 ? 200 : v % 200);
    // 1000 values: 5 of each of 1 … 200. Rank 990 is the 990th: value 198.
    assert.equal(h.percentile(99), 198);
    assert.equal(h.percentile(99.9), 200);
  });

  it('should keep every value inside its bucket bounds with relative width at most 2^-(subBits-1)', () => {
    const rng = seededRng(7);
    for (let i = 0; i < 20_000; i++) {
      const v = Math.floor(rng() * 2 ** (1 + Math.floor(rng() * 34)));
      const idx = bucketIndex(v, 8);
      const lo = bucketLow(idx, 8);
      const hi = bucketHigh(idx, 8);
      assert.ok(lo <= v && v <= hi, `seed 7 sample ${i}: ${v} not in [${lo}, ${hi}]`);
      if (v >= 256) assert.ok((hi - lo + 1) / lo <= 2 ** -7, `seed 7 sample ${i}: bucket of ${v} too wide`);
    }
  });

  it('should answer a large value within its bucket and never above the maximum', () => {
    const h = new Histogram();
    h.record(1_234_567);
    h.record(2_469_134);
    const p50 = h.percentile(50);
    assert.ok(p50 >= 1_234_567 && p50 <= 1_234_567 * (1 + 2 ** -7), `p50 ${p50}`);
    assert.equal(h.percentile(100), 2_469_134);
  });

  it('should round a fractional value and refuse a negative or non-finite one', () => {
    const h = new Histogram();
    h.record(2.6);
    assert.equal(h.max, 3);
    assert.throws(() => h.record(-1), RangeError);
    assert.throws(() => h.record(Number.NaN), RangeError);
    assert.equal(h.count, 1);
  });

  it('should answer 0 for a percentile of an empty histogram', () => {
    const h = new Histogram();
    assert.equal(h.percentile(99), 0);
    assert.equal(h.min, 0);
  });

  it('should merge to the same histogram as recording every value in one', () => {
    const all = new Histogram();
    const a = new Histogram();
    const b = new Histogram();
    const rng = seededRng(3);
    for (let i = 0; i < 5_000; i++) {
      const v = Math.floor(rng() * 5_000_000);
      all.record(v);
      (i % 2 === 0 ? a : b).record(v);
    }
    a.merge(b);
    assert.deepEqual(a.toJSON(), all.toJSON());
  });

  it('should refuse to merge histograms of different precision', () => {
    assert.throws(() => new Histogram(8).merge(new Histogram(6)), RangeError);
  });

  it('should round-trip through JSON', () => {
    const h = new Histogram();
    for (const v of [0, 5, 300, 70_000, 9_999_999]) h.record(v);
    const back = Histogram.fromJSON(JSON.parse(JSON.stringify(h.toJSON())));
    assert.deepEqual(back.toJSON(), h.toJSON());
    assert.equal(back.percentile(60), h.percentile(60));
  });
});
