import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { PARAMS } from './params.ts';

/** Event-loop shedding (RFC-006 §4.7 rule 1): Overloaded only from admission control or shedding (R47-12). */
export interface LoadMonitor {
  shedding(): boolean;
  stop(): void;
}

export class EventLoopMonitor implements LoadMonitor {
  private readonly h: IntervalHistogram;
  private readonly timer: NodeJS.Timeout;
  private shed = false;

  constructor(thresholdMs: number = PARAMS.loopDelayShedP99Ms) {
    this.h = monitorEventLoopDelay({ resolution: 10 });
    this.h.enable();
    this.timer = setInterval(() => {
      this.shed = this.h.percentile(99) / 1e6 > thresholdMs;   // p99 over the last second, ns → ms
      this.h.reset();
    }, 1_000);
    this.timer.unref();
  }

  shedding(): boolean {
    return this.shed;
  }

  stop(): void {
    clearInterval(this.timer);
    this.h.disable();
  }
}

export class ManualLoad implements LoadMonitor {
  value = false;
  shedding(): boolean { return this.value; }
  stop(): void {}
}
