// Minute m on the discrete domain maps to BASE + m minutes.
export const BASE = Date.UTC(2026, 0, 1);
export const at = (minute: number) => new Date(BASE + minute * 60_000);

// Seeded PRNG (mulberry32): reproducible random sequences without dependencies.
export function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Brute-force oracle: one cell per minute.
export class ArrayOracle {
  readonly n: number;
  private usage: number[];
  constructor(n: number) {
    this.n = n;
    this.usage = new Array(n).fill(0);
  }
  admit(s: number, e: number | null, b: number, capacity: number): boolean {
    const end = e ?? this.n;
    for (let t = s; t < end; t++) if (this.usage[t] + b > capacity) return false;
    for (let t = s; t < end; t++) this.usage[t] += b;
    return true;
  }
}

export function percentile(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
