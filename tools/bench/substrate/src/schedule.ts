import type { Clock } from './clock.ts';

/** A generator of numbers in [0, 1). */
export type Rng = () => number;

/** A seeded generator (mulberry32): the same seed gives the same run (engineering.md §5). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exponential gaps in ms of a Poisson process at `ratePerS` arrivals a second. */
export function poissonGaps(rng: Rng, ratePerS: number): () => number {
  if (!(ratePerS > 0)) throw new RangeError(`rate must be positive (got ${ratePerS})`);
  return () => (-Math.log(1 - rng()) * 1000) / ratePerS;
}

/** The intended times of an open-loop arrival process: each time is fixed in advance, not by the answer to the last. */
export class ArrivalSchedule {
  private nextMs: number;
  private readonly gap: () => number;

  constructor(startMs: number, gap: () => number) {
    this.gap = gap;
    this.nextMs = startMs + gap();
  }

  peek(): number {
    return this.nextMs;
  }

  take(): number {
    const t = this.nextMs;
    this.nextMs += this.gap();
    return t;
  }
}

/**
 * Delivers every arrival of `schedule` before `endMs` to `onArrival` with its intended time. When the loop wakes
 * late, it delivers all arrivals that are due, each with its own intended time, so latency measured from that time
 * includes the delay (no coordinated omission). Resolves with the number of arrivals.
 */
export async function driveArrivals(o: { schedule: ArrivalSchedule; clock: Clock; endMs: number; onArrival: (intendedMs: number) => void }): Promise<number> {
  let n = 0;
  for (;;) {
    const next = o.schedule.peek();
    if (next >= o.endMs) return n;
    if (o.clock.now() < next) await o.clock.sleepUntil(next);
    const now = o.clock.now();
    while (o.schedule.peek() <= now && o.schedule.peek() < o.endMs) {
      o.onArrival(o.schedule.take());
      n += 1;
    }
  }
}

/**
 * Takes calls from the front of `queue` into one batch: at most `maxEntries` entries and `maxBytes` bytes
 * (RFC-006 §4.3 size limits), but always the first call. The rest stay in order for the next batch.
 */
export function takeBatch<T extends { entries: number; bytes: number }>(queue: T[], maxEntries: number, maxBytes: number): T[] {
  let entries = 0;
  let bytes = 0;
  let n = 0;
  for (const c of queue) {
    if (n > 0 && (entries + c.entries > maxEntries || bytes + c.bytes > maxBytes)) break;
    entries += c.entries;
    bytes += c.bytes;
    n += 1;
  }
  return queue.splice(0, n);
}
