/** A wall clock: milliseconds since the Unix epoch. Code takes one as an option; tests pass a fixed or a stepped clock. */
export type WallClock = () => number;

/** The system wall clock: the one place that reads `Date.now()` (engineering.md §5). The default of each clock option. */
export const systemClock: WallClock = () => Date.now();
