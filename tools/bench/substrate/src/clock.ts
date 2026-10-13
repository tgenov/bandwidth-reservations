/** A monotonic clock in milliseconds. The generator takes one; tests give a manual clock (engineering.md §5). */
export interface Clock {
  now(): number;
  /** Resolves at or after `atMs`. */
  sleepUntil(atMs: number): Promise<void>;
}

/** The process monotonic clock: the one place in the generator that reads the time. */
export const monotonicClock: Clock = {
  now: () => performance.now(),
  sleepUntil: (atMs) => {
    const wait = atMs - performance.now();
    return wait <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, wait));
  },
};
