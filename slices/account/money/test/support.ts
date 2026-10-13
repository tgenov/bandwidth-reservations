/** Test helpers of the money package: a seeded generator and the failure message that names the seed. */

/** Mulberry32: a small seeded generator. The same seed gives the same sequence. */
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

/** An integer in [lo, hi], from the generator. */
export function int(r: () => number, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

/** The seeds of a property run. PROPERTY_SEED=<n> runs one seed again. */
export function seeds(count: number, base = 1): number[] {
  const one = process.env['PROPERTY_SEED'];
  if (one !== undefined) return [Number(one)];
  return Array.from({ length: count }, (_, i) => base + i);
}

/** The prefix of a property failure message: run it again with PROPERTY_SEED. */
export function seedNote(seed: number): string {
  return `seed ${seed} (run again with PROPERTY_SEED=${seed})`;
}
