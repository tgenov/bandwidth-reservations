/**
 * A log-linear histogram of non-negative integers (HDR style). Values below 2^subBits have their own bucket
 * (exact). Above that, each power of two has 2^(subBits-1) buckets, so a bucket is at most 2^-(subBits-1) of
 * its lowest value wide (0.8 % for subBits 8). Percentiles use the nearest rank and answer the highest value
 * of the bucket, capped at the maximum. The JSON form merges across processes.
 */
export interface HistogramJson {
  subBits: number;
  count: number;
  min: number;
  max: number;
  sum: number;
  /** [bucket index, count], ascending, no zero counts. */
  buckets: Array<[number, number]>;
}

/** The bucket of value `v`. */
export function bucketIndex(v: number, subBits: number): number {
  const linear = 2 ** subBits;
  if (v < linear) return v;
  const k = Math.floor(Math.log2(v));
  // Math.log2 can be off by one near a power of two; correct it.
  const top = 2 ** k > v ? k - 1 : 2 ** (k + 1) <= v ? k + 1 : k;
  const shift = top - subBits + 1;
  const mantissa = Math.floor(v / 2 ** shift);
  const half = 2 ** (subBits - 1);
  return linear + (shift - 1) * half + (mantissa - half);
}

/** The lowest value of bucket `idx`. */
export function bucketLow(idx: number, subBits: number): number {
  const linear = 2 ** subBits;
  if (idx < linear) return idx;
  const half = 2 ** (subBits - 1);
  const shift = Math.floor((idx - linear) / half) + 1;
  const mantissa = half + ((idx - linear) % half);
  return mantissa * 2 ** shift;
}

/** The highest value of bucket `idx`. */
export function bucketHigh(idx: number, subBits: number): number {
  const linear = 2 ** subBits;
  if (idx < linear) return idx;
  const half = 2 ** (subBits - 1);
  const shift = Math.floor((idx - linear) / half) + 1;
  return bucketLow(idx, subBits) + 2 ** shift - 1;
}

/** See the module comment. */
export class Histogram {
  readonly subBits: number;
  private readonly counts = new Map<number, number>();
  private n = 0;
  private lo = Number.POSITIVE_INFINITY;
  private hi = 0;
  private total = 0;

  constructor(subBits = 8) {
    this.subBits = subBits;
  }

  /** Records one value, rounded to an integer. A negative or non-finite value is a RangeError. */
  record(value: number): void {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`histogram value must be finite and not negative (got ${value})`);
    const v = Math.round(value);
    const idx = bucketIndex(v, this.subBits);
    this.counts.set(idx, (this.counts.get(idx) ?? 0) + 1);
    this.n += 1;
    this.total += v;
    if (v < this.lo) this.lo = v;
    if (v > this.hi) this.hi = v;
  }

  get count(): number { return this.n; }
  get min(): number { return this.n === 0 ? 0 : this.lo; }
  get max(): number { return this.hi; }
  get sum(): number { return this.total; }

  /** The nearest-rank percentile `p` (0 < p ≤ 100); 0 when empty. */
  percentile(p: number): number {
    if (this.n === 0) return 0;
    const rank = Math.max(1, Math.ceil((p / 100) * this.n));
    let seen = 0;
    for (const idx of [...this.counts.keys()].sort((a, b) => a - b)) {
      seen += this.counts.get(idx) ?? 0;
      if (seen >= rank) return Math.min(bucketHigh(idx, this.subBits), this.hi);
    }
    return this.hi;
  }

  /** Adds every value of `o`. Both must have the same precision. */
  merge(o: Histogram): void {
    if (o.subBits !== this.subBits) throw new RangeError(`cannot merge histograms of subBits ${this.subBits} and ${o.subBits}`);
    for (const [idx, c] of o.counts) this.counts.set(idx, (this.counts.get(idx) ?? 0) + c);
    if (o.n > 0) {
      this.lo = Math.min(this.lo, o.lo);
      this.hi = Math.max(this.hi, o.hi);
    }
    this.n += o.n;
    this.total += o.total;
  }

  toJSON(): HistogramJson {
    return {
      subBits: this.subBits, count: this.n, min: this.min, max: this.hi, sum: this.total,
      buckets: [...this.counts.entries()].sort((a, b) => a[0] - b[0]),
    };
  }

  static fromJSON(j: HistogramJson): Histogram {
    const h = new Histogram(j.subBits);
    for (const [idx, c] of j.buckets) h.counts.set(idx, c);
    h.n = j.count;
    h.total = j.sum;
    h.hi = j.max;
    h.lo = j.count === 0 ? Number.POSITIVE_INFINITY : j.min;
    return h;
  }
}
