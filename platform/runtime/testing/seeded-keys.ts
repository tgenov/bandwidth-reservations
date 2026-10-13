/** Seeded random record keys for the partitioner tests (unit and integration). */

/** mulberry32: a small seeded generator of numbers in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** `n` keys of 0 … 40 random bytes. */
export function seededKeys(seed: number, n = 1_000): Uint8Array[] {
  const next = rng(seed);
  return Array.from({ length: n }, () => Uint8Array.from({ length: Math.floor(next() * 41) }, () => Math.floor(next() * 256)));
}
