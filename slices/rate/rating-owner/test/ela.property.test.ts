/**
 * The ELA property test of RFC-003 §9 (S-RATE-I3 exit criterion 2). Random records, their
 * spreads and negated parts go into the exact line accumulator in a random order. An
 * independent exact-rational reference computes the same lines. Every floor must be equal,
 * also for crafted sums within 10^-18 of an integer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEla, addFraction, elaFraction, emptyEla, usageCharge, type Ela } from '@share/rate-common';
import { spread } from '../src/index.ts';

// ---------- the reference: exact rationals with bigint numerator and denominator ----------

interface Q { n: bigint; d: bigint }

function refGcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b > 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

function q(n: bigint, d: bigint): Q {
  if (d < 0n) { n = -n; d = -d; }
  const g = refGcd(n, d);
  return g > 1n ? { n: n / g, d: d / g } : { n, d };
}

const qAdd = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);

/** ⌊a / b⌋ for b > 0, toward minus infinity, by repeated correction of the truncated quotient. */
function refFloor(a: bigint, b: bigint): bigint {
  let t = a / b;
  while (t * b > a) t -= 1n;
  while ((t + 1n) * b <= a) t += 1n;
  return t;
}

/** The reference line charge: ⌊price × X / 10^15⌋ (POL-11, RFC-003 §2). */
const refCharge = (x: Q, price: bigint): bigint => refFloor(price * x.n, x.d * 10n ** 15n);

/** The reference spread (POL-13): bytes × overlap / duration for each minute, all bytes in the start minute when e = s. */
function refSpread(s: number, e: number, bytes: bigint): Map<number, Q> {
  const out = new Map<number, Q>();
  if (e === s) {
    out.set(s - (s % 60_000), q(bytes, 1n));
    return out;
  }
  const first = Math.floor(s / 60_000);
  const last = Math.floor((e - 1) / 60_000);
  for (let k = first; k <= last; k++) {
    const lo = Math.max(s, k * 60_000);
    const hi = Math.min(e, (k + 1) * 60_000);
    out.set(k * 60_000, q(bytes * BigInt(hi - lo), BigInt(e - s)));
  }
  return out;
}

// ---------- a seeded generator ----------

/** xorshift128+ on bigint. The same seed gives the same sequence. */
class Rng {
  private s0: bigint;
  private s1: bigint;
  constructor(seed: number) {
    const mask = (1n << 64n) - 1n;
    this.s0 = (BigInt(seed) * 0x9E3779B97F4A7C15n + 1n) & mask;
    this.s1 = (this.s0 * 0xBF58476D1CE4E5B9n + 7n) & mask;
    for (let i = 0; i < 8; i++) this.next();
  }
  next(): bigint {
    const mask = (1n << 64n) - 1n;
    let x = this.s0;
    const y = this.s1;
    this.s0 = y;
    x ^= (x << 23n) & mask;
    this.s1 = x ^ y ^ (x >> 17n) ^ (y >> 26n);
    return (this.s1 + y) & mask;
  }
  /** An integer in [0, n). */
  int(n: number): number {
    return Number(this.next() % BigInt(n));
  }
  big(bits: number): bigint {
    return this.next() & ((1n << BigInt(bits)) - 1n);
  }
  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [xs[i], xs[j]] = [xs[j] as T, xs[i] as T];
    }
    return xs;
  }
}

const SEEDS = process.env['RATE_ELA_SEED'] ? [Number(process.env['RATE_ELA_SEED'])] : [1, 2, 3, 20261012, 0x5eed];
const BASE = Date.parse('2026-10-12T12:00:00Z');
const PRICES = [10_000_000_000n, 13_000_000_000n, 1n, 10n ** 15n, 999_999_999_999n];

interface Add { minute: number; num: bigint; den: bigint }

/** The ELA invariants of RFC-003 §2: each key a reduced denominator d > 1, and 0 < r_d < d. */
function checkShape(e: Ela, why: string): void {
  for (const [k, r] of Object.entries(e.r)) {
    const d = BigInt(k);
    assert.ok(d > 1n && r > 0n && r < d, `${why}: entry ${k} → ${r}`);
  }
}

function checkLine(e: Ela, x: Q, prices: bigint[], why: string): void {
  checkShape(e, why);
  const f = elaFraction(e);
  assert.equal(f.num * x.d, x.n * f.den, `${why}: X differs from the reference`);
  for (const p of prices) assert.equal(usageCharge(e, p), refCharge(x, p), `${why}: floor at price ${p}`);
}

test('should give every usage-line floor equal to an exact rational reference when random records, spreads and negated parts are added in any order (RFC-003 §9 ELA)', () => {
  for (const seed of SEEDS) {
    const rng = new Rng(seed);
    for (let round = 0; round < 200; round++) {
      const why = `seed ${seed} round ${round} (run again with RATE_ELA_SEED=${seed})`;
      const adds: Add[] = [];
      const ref = new Map<number, Q>();
      const records = 1 + rng.int(40);
      for (let i = 0; i < records; i++) {
        const s = BASE + rng.int(10 * 60_000);
        // Durations up to 150 s: some records break POL-13 and are still spread; some have e = s.
        const dur = rng.int(5) === 0 ? 0 : rng.int(150_001);
        const bytes = rng.int(4) === 0 ? rng.big(62) : rng.big(1 + rng.int(36));
        // Some records are superseded or reversed: their parts come again, negated (RFC-003 §2).
        const copies = rng.int(4) === 0 ? [1n, -1n] : [1n];
        for (const sign of copies) {
          for (const p of spread(s, s + dur, bytes)) adds.push({ minute: p.minuteMs, num: sign * BigInt(p.bytes.num), den: BigInt(p.bytes.den) });
          for (const [m, x] of refSpread(s, s + dur, bytes)) ref.set(m, qAdd(ref.get(m) ?? q(0n, 1n), q(sign * x.n, x.d)));
        }
      }
      // A negated part may also come before its positive part.
      rng.shuffle(adds);
      const lines = new Map<number, Ela>();
      for (const a of adds) lines.set(a.minute, addFraction(lines.get(a.minute) ?? emptyEla(), a.num, a.den));
      assert.deepEqual([...lines.keys()].sort(), [...ref.keys()].sort(), `${why}: minutes`);
      for (const [m, e] of lines) checkLine(e, ref.get(m) as Q, PRICES, `${why} minute ${new Date(m).toISOString()}`);
      // The same parts in another order, and merged from two halves, give the same accumulator.
      const half = Math.floor(adds.length / 2);
      for (const m of lines.keys()) {
        const mine = adds.filter((a) => a.minute === m);
        const sum = (xs: Add[]): Ela => xs.reduce((e, a) => addFraction(e, a.num, a.den), emptyEla());
        assert.deepEqual(sum([...mine].reverse()), lines.get(m), `${why}: order`);
        assert.deepEqual(addEla(sum(adds.slice(0, half).filter((a) => a.minute === m)), sum(adds.slice(half).filter((a) => a.minute === m))),
          lines.get(m), `${why}: merge`);
      }
    }
  }
});

// ---------- crafted sums within 10^-18 of an integer ----------

/** The largest primes at or below the bound: pairwise coprime durations of at most 120,000 ms. */
function primesBelow(bound: number, count: number): bigint[] {
  const out: bigint[] = [];
  for (let n = bound; out.length < count; n--) {
    let prime = n > 1;
    for (let k = 2; k * k <= n; k++) if (n % k === 0) { prime = false; break; }
    if (prime) out.push(BigInt(n));
  }
  return out;
}

/** a⁻¹ mod m (extended Euclid). */
function inverse(a: bigint, m: bigint): bigint {
  let [r0, r1, s0, s1] = [((a % m) + m) % m, m, 1n, 0n];
  while (r1 !== 0n) {
    const k = r0 / r1;
    [r0, r1] = [r1, r0 - k * r1];
    [s0, s1] = [s1, s0 - k * s1];
  }
  return ((s0 % m) + m) % m;
}

test('should floor exactly when the line is within 10^-18 of an integer, above and below, in any order (RFC-003 §9 ELA crafted sums)', () => {
  const ds = primesBelow(120_000, 4);
  const P = ds.reduce((a, b) => a * b, 1n);
  assert.ok(P > 10n ** 18n, 'the distance 1/P is below 10^-18');
  // Partial fractions: Σ a_i / d_i = 1/P + K, with K an integer.
  const parts = ds.map((d) => ({ num: inverse(P / d, d), den: d }));
  const sum = parts.reduce((x, p) => qAdd(x, q(p.num, p.den)), q(0n, 1n));
  const K = refFloor(sum.n, sum.d);
  assert.deepEqual(qAdd(sum, q(-K, 1n)), q(1n, P));
  for (const seed of SEEDS) {
    const rng = new Rng(seed);
    for (let round = 0; round < 40; round++) {
      const why = `seed ${seed} round ${round} (run again with RATE_ELA_SEED=${seed})`;
      // The target charge c, at the price p: X = c × 10^15 / p ± 1/P, and a noise record added and then negated.
      const p = rng.int(2) === 0 ? 10n ** 15n : 10_000_000_000n;
      const c = BigInt(rng.int(1_000_000));
      const base = q(c * 10n ** 15n, p);
      for (const sign of [1n, -1n]) {
        const adds: Array<[bigint, bigint]> = parts.map((x) => [sign * x.num, x.den]);
        adds.push([base.n, base.d], [-sign * K, 1n]);
        const s = BASE + rng.int(60_000);
        for (const x of spread(s, s + 1 + rng.int(119_999), rng.big(40))) {
          adds.push([BigInt(x.bytes.num), BigInt(x.bytes.den)], [-BigInt(x.bytes.num), BigInt(x.bytes.den)]);
        }
        rng.shuffle(adds);
        const e = adds.reduce((acc, [n, d]) => addFraction(acc, n, d), emptyEla());
        const x = qAdd(base, q(sign, P));
        checkLine(e, x, [p, ...PRICES], `${why} sign ${sign}`);
        assert.equal(usageCharge(e, p), sign > 0n ? c : c - 1n, `${why} sign ${sign}: the charge`);
      }
    }
  }
});
