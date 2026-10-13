/** The scheduler of settlement in production: real timers on an injected wall clock. */
import { systemClock, type WallClock } from '@share/owner-runtime';
import type { Scheduler } from './settlement.ts';

/** Real timers. The clock is injected (engineering.md §5). `close` cancels every timer that has not fired. */
export class TimerScheduler implements Scheduler {
  private readonly clock: WallClock;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(clock: WallClock = systemClock) {
    this.clock = clock;
  }

  nowMs(): number {
    return this.clock();
  }

  after(ms: number, fn: () => void): void {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
