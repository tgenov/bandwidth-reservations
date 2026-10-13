/**
 * The occupancy tree (RFC-001 §3.2): a sparse ordered map from minute to impulse, augmented with the
 * monoid (sum, maxpref, minpref) of D11.
 *
 * Shape. I1 uses a treap with a priority that is a hash of the key. Thus no random number is used,
 * and the query results are a function of the impulses only. All node fields are in typed-array arenas
 * (R1-10). The interface is the one of RFC-001 §3.2. Spike S-LINK-SP1 can replace the shape (B+tree,
 * fanout 32, or the dense ring tree) behind this interface.
 *
 * Undo. A batch decides on the committed state. If the batch does not commit, the owner must drop its
 * effects (RFC-001 §7.2 step 5). I1 records each impulse in a journal and undoes it in reverse order.
 * This replaces the copy-on-write generations of §3.2 until SP1 decides the arena layout.
 *
 * Arithmetic. Every value is an integer number of Mbps. Float64 holds integers exactly below 2^53.
 * No rounding and no division occur.
 */

const NIL = 0;
const NEG = -Infinity;
const POS = Infinity;

export interface Aggregate { sum: number; maxpref: number; minpref: number }

/** A maximal minute range [start, end) in which the value is above the threshold. `end` null is "for ever". */
export interface MinuteRange { start: number; end: number | null }

export class OccupancyTree {
  private key: Float64Array = new Float64Array(1024);
  private val: Float64Array = new Float64Array(1024);
  private sum: Float64Array = new Float64Array(1024);
  private maxp: Float64Array = new Float64Array(1024);
  private minp: Float64Array = new Float64Array(1024);
  private left: Int32Array = new Int32Array(1024);
  private right: Int32Array = new Int32Array(1024);
  private prio: Uint32Array = new Uint32Array(1024);
  private used = 1;           // index 0 is NIL
  private free: number[] = [];
  private root = NIL;
  private count = 0;
  /** Sum of the impulses that compaction folded away (§7.6). I1 does not compact; it stays 0. */
  carry = 0;
  /** Increments on each update. It keys the counter-offer cache of I2 (§3.2). */
  changeCounter = 0;
  /** The impulses since the last `commit()`, as (minute, delta) pairs. */
  private journal: number[] = [];

  constructor() {
    this.setNil();
  }

  /** The number of keys (minutes with a non-zero impulse). */
  get size(): number {
    return this.count;
  }

  // ---------------- updates ----------------

  /** Add the pulse `b` over [s, e): `+b` at `s` and, if `e` is finite, `-b` at `e`. */
  add(s: number, e: number | null, b: number): void {
    if (b === 0) return;
    this.impulse(s, b);
    if (e !== null) this.impulse(e, -b);
  }

  /** Add `delta` at minute `t`. A key whose impulse becomes 0 is deleted. */
  impulse(t: number, delta: number): void {
    if (delta === 0) return;
    this.journal.push(t, delta);
    this.changeCounter += 1;
    this.root = this.insert(this.root, t, delta);
  }

  /** Make the impulses since the last commit permanent. */
  commit(): void {
    this.journal.length = 0;
  }

  /** Undo the impulses since the last commit, in reverse order. */
  rollback(): void {
    const j = this.journal;
    for (let i = j.length - 2; i >= 0; i -= 2) {
      this.root = this.insert(this.root, j[i] as number, -(j[i + 1] as number));
      this.changeCounter += 1;
    }
    j.length = 0;
  }

  // ---------------- queries ----------------

  /** `carry` + the sum of the impulses at keys < t. */
  prefix(t: number): number {
    let acc = this.carry;
    let n = this.root;
    while (n !== NIL) {
      if ((this.key[n] as number) < t) {
        acc += (this.sum[this.left[n] as number] as number) + (this.val[n] as number);
        n = this.right[n] as number;
      } else {
        n = this.left[n] as number;
      }
    }
    return acc;
  }

  /** The occupancy at minute t. */
  value(t: number): number {
    return this.prefix(t + 1);
  }

  hasKey(t: number): boolean {
    let n = this.root;
    while (n !== NIL) {
      const k = this.key[n] as number;
      if (k === t) return true;
      n = (t < k ? this.left[n] : this.right[n]) as number;
    }
    return false;
  }

  /** The aggregate of the impulses at keys in [s, e). `e` null is "for ever". */
  range(s: number, e: number | null): Aggregate {
    this.fold = { sum: 0, maxpref: NEG, minpref: POS };
    this.foldRange(this.root, s, e === null ? POS : e, false, false);
    return this.fold;
  }

  /** The largest occupancy at a minute of [s, e) (RFC-001 §3.2). The window must not be empty. */
  peak(s: number, e: number | null): number {
    const p = this.prefix(s);
    const q = this.range(s, e);
    if (this.hasKey(s)) return p + q.maxpref;
    return p + (q.maxpref > 0 ? q.maxpref : 0);
  }

  /** The least minute x ≥ t with value(x) > θ, or null if there is none. */
  firstAbove(t: number, theta: number): number | null {
    const v = this.value(t);
    if (v > theta) return t;
    this.run = v;
    const k = this.findFirst(this.root, t + 1, false, theta, true);
    return Number.isNaN(k) ? null : k;
  }

  /** The least minute x ≥ t with value(x) ≤ θ, or null if there is none. */
  firstAtOrBelow(t: number, theta: number): number | null {
    const v = this.value(t);
    if (v <= theta) return t;
    this.run = v;
    const k = this.findFirst(this.root, t + 1, false, theta, false);
    return Number.isNaN(k) ? null : k;
  }

  /** The maximal minute ranges in [s, e) with value > θ (RFC-001 §3.2). */
  conflicts(s: number, e: number | null, theta: number): MinuteRange[] {
    const out: MinuteRange[] = [];
    const end = e === null ? POS : e;
    let x = this.firstAbove(s, theta);
    while (x !== null && x < end) {
      const y = this.firstAtOrBelow(x, theta);
      if (y === null || y >= end) {
        out.push({ start: x, end: e });
        break;
      }
      out.push({ start: x, end: y });
      x = this.firstAbove(y, theta);
    }
    return out;
  }

  /** Every key and its impulse, in minute order. For tests and checks only. */
  entries(): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    const walk = (n: number): void => {
      if (n === NIL) return;
      walk(this.left[n] as number);
      out.push([this.key[n] as number, this.val[n] as number]);
      walk(this.right[n] as number);
    };
    walk(this.root);
    return out;
  }

  // ---------------- internals ----------------

  private fold: Aggregate = { sum: 0, maxpref: NEG, minpref: POS };
  private run = 0;

  private setNil(): void {
    this.sum[NIL] = 0; this.maxp[NIL] = NEG; this.minp[NIL] = POS;
    this.left[NIL] = NIL; this.right[NIL] = NIL;
  }

  /** Append the aggregate (s, mx, mn) to the right of the running fold. */
  private append(s: number, mx: number, mn: number): void {
    const f = this.fold;
    const a = f.sum + mx;
    const b = f.sum + mn;
    if (a > f.maxpref) f.maxpref = a;
    if (b < f.minpref) f.minpref = b;
    f.sum += s;
  }

  private foldRange(n: number, s: number, e: number, coverLo: boolean, coverHi: boolean): void {
    while (n !== NIL) {
      if (coverLo && coverHi) {
        this.append(this.sum[n] as number, this.maxp[n] as number, this.minp[n] as number);
        return;
      }
      const k = this.key[n] as number;
      if (!coverLo && k < s) { n = this.right[n] as number; continue; }
      if (!coverHi && k >= e) { n = this.left[n] as number; continue; }
      this.foldRange(this.left[n] as number, s, e, coverLo, true);
      const v = this.val[n] as number;
      this.append(v, v, v);
      n = this.right[n] as number;
      coverLo = true;
    }
  }

  /**
   * In key order over keys ≥ lo, add each impulse to `run`. Return the first key at which `run` is
   * above θ (above = true) or at or below θ (above = false). Skip a whole subtree by its aggregate.
   */
  private findFirst(n: number, lo: number, coverLo: boolean, theta: number, above: boolean): number {
    if (n === NIL) return NaN;
    if (coverLo) {
      const skip = above ? this.run + (this.maxp[n] as number) <= theta : this.run + (this.minp[n] as number) > theta;
      if (skip) { this.run += this.sum[n] as number; return NaN; }
    } else if ((this.key[n] as number) < lo) {
      return this.findFirst(this.right[n] as number, lo, false, theta, above);
    }
    const l = this.findFirst(this.left[n] as number, lo, coverLo, theta, above);
    if (!Number.isNaN(l)) return l;
    this.run += this.val[n] as number;
    if (above ? this.run > theta : this.run <= theta) return this.key[n] as number;
    return this.findFirst(this.right[n] as number, lo, true, theta, above);
  }

  private pull(n: number): void {
    const l = this.left[n] as number;
    const r = this.right[n] as number;
    const s1 = (this.sum[l] as number) + (this.val[n] as number);
    let mx = this.maxp[l] as number;
    let mn = this.minp[l] as number;
    if (s1 > mx) mx = s1;
    if (s1 < mn) mn = s1;
    const rx = s1 + (this.maxp[r] as number);
    const rn = s1 + (this.minp[r] as number);
    if (rx > mx) mx = rx;
    if (rn < mn) mn = rn;
    this.sum[n] = s1 + (this.sum[r] as number);
    this.maxp[n] = mx;
    this.minp[n] = mn;
  }

  private insert(n: number, t: number, delta: number): number {
    if (n === NIL) return this.newNode(t, delta);
    const k = this.key[n] as number;
    if (t === k) {
      const v = (this.val[n] as number) + delta;
      if (v === 0) {
        const m = this.merge(this.left[n] as number, this.right[n] as number);
        this.freeNode(n);
        return m;
      }
      this.val[n] = v;
      this.pull(n);
      return n;
    }
    if (t < k) {
      const c = this.insert(this.left[n] as number, t, delta);
      this.left[n] = c;
      if (c !== NIL && (this.prio[c] as number) > (this.prio[n] as number)) {
        this.left[n] = this.right[c] as number;
        this.right[c] = n;
        this.pull(n);
        this.pull(c);
        return c;
      }
    } else {
      const c = this.insert(this.right[n] as number, t, delta);
      this.right[n] = c;
      if (c !== NIL && (this.prio[c] as number) > (this.prio[n] as number)) {
        this.right[n] = this.left[c] as number;
        this.left[c] = n;
        this.pull(n);
        this.pull(c);
        return c;
      }
    }
    this.pull(n);
    return n;
  }

  private merge(a: number, b: number): number {
    if (a === NIL) return b;
    if (b === NIL) return a;
    if ((this.prio[a] as number) > (this.prio[b] as number)) {
      this.right[a] = this.merge(this.right[a] as number, b);
      this.pull(a);
      return a;
    }
    this.left[b] = this.merge(a, this.left[b] as number);
    this.pull(b);
    return b;
  }

  private newNode(t: number, delta: number): number {
    let n = this.free.pop();
    if (n === undefined) {
      if (this.used === this.key.length) this.grow();
      n = this.used++;
    }
    this.key[n] = t;
    this.val[n] = delta;
    this.sum[n] = delta;
    this.maxp[n] = delta;
    this.minp[n] = delta;
    this.left[n] = NIL;
    this.right[n] = NIL;
    this.prio[n] = priorityOf(t);
    this.count += 1;
    return n;
  }

  private freeNode(n: number): void {
    this.free.push(n);
    this.count -= 1;
  }

  private grow(): void {
    const cap = this.key.length * 2;
    const f64 = (a: Float64Array): Float64Array => { const b = new Float64Array(cap); b.set(a); return b; };
    const i32 = (a: Int32Array): Int32Array => { const b = new Int32Array(cap); b.set(a); return b; };
    this.key = f64(this.key); this.val = f64(this.val); this.sum = f64(this.sum);
    this.maxp = f64(this.maxp); this.minp = f64(this.minp);
    this.left = i32(this.left); this.right = i32(this.right);
    const p = new Uint32Array(cap); p.set(this.prio); this.prio = p;
  }
}

/** A fixed hash of the minute (a murmur3 finaliser). It gives the treap priority with no random number. */
function priorityOf(t: number): number {
  let x = (t % 4294967296) >>> 0;
  x ^= Math.floor(t / 4294967296) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
