/**
 * Exact line accumulator (ELA), RFC-003 §2.
 *
 * X = S + Σ_d r_d / d exactly. S is an unbounded integer. For each reduced denominator d,
 * 0 ≤ r_d < d. An add of a fraction of either sign is O(1). The result does not change with
 * the order of the adds (P3-N3). No floating point is used.
 */

export interface Ela {
  S: bigint;
  /** Reduced denominator (as a decimal string) to remainder numerator. */
  r: Record<string, bigint>;
}

export function emptyEla(): Ela {
  return { S: 0n, r: {} };
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** Floor division (rounds toward minus infinity). */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('floorDiv: the divisor must be positive');
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

/** Add num/den (den > 0) to the accumulator. Returns a new accumulator; the input does not change. */
export function addFraction(ela: Ela, num: bigint, den: bigint): Ela {
  if (den <= 0n) throw new Error('ELA: the denominator must be positive');
  const g = gcd(num, den) || 1n;
  const n = num / g;
  const d = den / g;
  const out: Ela = { S: ela.S, r: { ...ela.r } };
  if (d === 1n) {
    out.S += n;
    return out;
  }
  const key = d.toString();
  const cur = (out.r[key] ?? 0n) + n;
  const q = floorDiv(cur, d);
  out.S += q;
  const rem = cur - q * d;
  if (rem === 0n) delete out.r[key];
  else out.r[key] = rem;
  return out;
}

export function addEla(a: Ela, b: Ela): Ela {
  let out: Ela = { S: a.S + b.S, r: { ...a.r } };
  for (const [d, n] of Object.entries(b.r)) out = addFraction(out, n, BigInt(d));
  return out;
}

/** X as one exact fraction { num, den }, den the lcm of the denominators. */
export function elaFraction(ela: Ela): { num: bigint; den: bigint } {
  let den = 1n;
  for (const d of Object.keys(ela.r)) {
    const db = BigInt(d);
    den = (den / gcd(den, db)) * db;
  }
  let num = ela.S * den;
  for (const [d, n] of Object.entries(ela.r)) num += n * (den / BigInt(d));
  return { num, den };
}

/** ⌊price × X / divisor⌋, exact (RFC-003 §2: the usage line charge with divisor 10^15). */
export function floorPriceTimes(ela: Ela, price: bigint, divisor: bigint): bigint {
  const { num, den } = elaFraction(ela);
  return floorDiv(price * num, divisor * den);
}

/** The usage line charge in micro-USD: ⌊usage_price[pico-USD per GB] × X[bytes] / 10^15⌋ (POL-11). */
export function usageCharge(ela: Ela, usagePricePico: bigint): bigint {
  return floorPriceTimes(ela, usagePricePico, 1_000_000_000_000_000n);
}

/** A plain JSON form for log entries: { S, r } with decimal strings. */
export function elaToJson(ela: Ela): { S: string; r: Record<string, string> } {
  const r: Record<string, string> = {};
  for (const k of Object.keys(ela.r).sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1))) r[k] = String(ela.r[k]);
  return { S: ela.S.toString(), r };
}

export function elaFromJson(j: { S: string; r: Record<string, string> }): Ela {
  const r: Record<string, bigint> = {};
  for (const [k, v] of Object.entries(j.r)) r[k] = BigInt(v);
  return { S: BigInt(j.S), r };
}
