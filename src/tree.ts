// Usage on a link is a superposition of rectangular pulses. Differentiate:
// each reservation [s, e) of b becomes two impulses, +b at s and -b at e
// (open-ended: only +b at s). Usage is the prefix sum of the impulses:
//
//   usage(t) = delta[0] + ... + delta[t]
//
// A segment tree over delta where each node keeps {sum, maxpref} answers
// "peak usage over [s, e)" in O(log N), and a booking is two point updates.

type Node = { sum: number; maxpref: number };

const EMPTY: Node = { sum: 0, maxpref: -Infinity };

function combine(l: Node, r: Node): Node {
  return { sum: l.sum + r.sum, maxpref: Math.max(l.maxpref, l.sum + r.maxpref) };
}

export type Decision =
  | { ok: true }
  | { ok: false; peak: number; conflicts: Array<[number, number]> };

// The tree covers a fixed horizon [0, n). A window must start inside it and end
// at or before n; e = null means "for the rest of the horizon". Anything else is
// a caller error, not a capacity answer: the tree cannot record impulses beyond n,
// so admitting such a request would accept a booking that is never checked or
// stored. Validate at the API edge and refuse it there.
export function checkWindow(s: number, e: number | null, n: number): void {
  if (!Number.isInteger(s) || s < 0 || s >= n) throw new RangeError(`start ${s} outside horizon [0, ${n})`);
  if (e !== null && (!Number.isInteger(e) || e <= s || e > n)) {
    throw new RangeError(`end ${e} must be after start ${s} and at most ${n}`);
  }
}

export class UsageTree {
  readonly n: number;
  private size: number;
  private sum: Float64Array;
  private maxpref: Float64Array;

  constructor(n: number) {
    this.n = n;
    this.size = 1;
    while (this.size < n) this.size *= 2;
    this.sum = new Float64Array(2 * this.size);
    this.maxpref = new Float64Array(2 * this.size); // leaves: maxpref = delta (0 initially)
  }

  // delta[t] += v, for 0 <= t < n. Impulses at or beyond the horizon are dropped:
  // they cannot affect usage inside [0, n).
  addImpulse(t: number, v: number): void {
    if (t >= this.n) return;
    let i = this.size + t;
    this.sum[i] += v;
    this.maxpref[i] = this.sum[i];
    for (i >>= 1; i >= 1; i >>= 1) {
      const l = 2 * i, r = l + 1;
      this.sum[i] = this.sum[l] + this.sum[r];
      this.maxpref[i] = Math.max(this.maxpref[l], this.sum[l] + this.maxpref[r]);
    }
  }

  // Aggregate {sum, maxpref} over delta[lo, hi).
  private range(lo: number, hi: number, i = 1, nlo = 0, nhi = this.size): Node {
    if (hi <= nlo || nhi <= lo) return EMPTY;
    if (lo <= nlo && nhi <= hi) return { sum: this.sum[i], maxpref: this.maxpref[i] };
    const mid = (nlo + nhi) >> 1;
    return combine(this.range(lo, hi, 2 * i, nlo, mid), this.range(lo, hi, 2 * i + 1, mid, nhi));
  }

  usageAt(t: number): number {
    return this.range(0, t + 1).sum;
  }

  // max over t in [s, e) of usage(t) = prefix(0..s-1) + maxpref(delta[s..e-1]).
  peak(s: number, e: number): number {
    return this.range(0, s).sum + this.range(s, Math.min(e, this.n)).maxpref;
  }

  // Add (b > 0) or remove (b < 0) a pulse [s, e); e = null is open-ended.
  add(s: number, e: number | null, b: number): void {
    this.addImpulse(s, b);
    if (e !== null) this.addImpulse(e, -b);
  }

  // Minutes in [s, e) where usage(t) > limit, merged into half-open ranges.
  conflicts(s: number, e: number, limit: number): Array<[number, number]> {
    const hits: number[] = [];
    const walk = (i: number, nlo: number, nhi: number, offset: number): void => {
      // offset = usage just before nlo
      if (nhi <= s || e <= nlo || offset + this.maxpref[i] <= limit) return;
      if (nhi - nlo === 1) { hits.push(nlo); return; }
      const mid = (nlo + nhi) >> 1;
      walk(2 * i, nlo, mid, offset);
      walk(2 * i + 1, mid, nhi, offset + this.sum[2 * i]);
    };
    walk(1, 0, this.size, 0);
    const out: Array<[number, number]> = [];
    for (const t of hits) {
      const last = out[out.length - 1];
      if (last && last[1] === t) last[1] = t + 1;
      else out.push([t, t + 1]);
    }
    return out;
  }

  // e = null means open-ended: the request must fit for the rest of the horizon.
  admit(s: number, e: number | null, b: number, capacity: number): Decision {
    checkWindow(s, e, this.n);
    const end = e ?? this.n;
    const peak = this.peak(s, end);
    if (peak + b > capacity) {
      return { ok: false, peak, conflicts: this.conflicts(s, end, capacity - b) };
    }
    this.add(s, e, b);
    return { ok: true };
  }
}
