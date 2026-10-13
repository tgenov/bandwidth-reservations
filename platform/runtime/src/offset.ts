/**
 * The owner host's offset check and its ladder actions (RFC-006 §6.2, §6.3; plan S-PLAT-I2 work item 8).
 *
 * Every second the process reads the database's time (`SELECT cluster_logical_timestamp()`) and measures the
 * round trip `rtt` with the monotonic clock. offset = db_ts − (t_send_wall + rtt / 2); the wall clock is read
 * only for t_send_wall (R6-31). The owner offset bound is |offset| + rtt / 2.
 *
 * - Above 50 ms on three consecutive samples (level D): give up the session at once.
 * - Above 40 ms (level A): stop taking slots and hand the slots off.
 * - Above 20 ms for 1 min (level W): a warning only.
 */
import type { HlcTs } from './api.ts';
import { systemClock, type WallClock } from './clock.ts';
import { hlcToWallMs } from './hlc.ts';

export const OFFSET = { warnMs: 20, warnHoldMs: 60_000, handOffMs: 40, giveUpMs: 50, giveUpSamples: 3, intervalMs: 1_000 } as const;

export type OffsetLevel = 'normal' | 'W' | 'A' | 'D';

/** One sample of the owner offset bound. */
export interface OffsetSample { offsetMs: number; rttMs: number; boundMs: number; level: OffsetLevel }

export interface OffsetMonitorOptions {
  /** Reads the database's time (cluster_logical_timestamp()). */
  dbTime: () => Promise<HlcTs>;
  wallMs?: WallClock;
  /** Monotonic nanoseconds (default process.hrtime.bigint). */
  monoNs?: () => bigint;
  /** Called once when the level changes; the runtime acts on 'A' and 'D'. */
  onLevel: (level: OffsetLevel, s: OffsetSample) => void;
  /** Called with every sample (metrics; the W level alarm). */
  onSample?: (s: OffsetSample) => void;
}

export class OffsetMonitor {
  private readonly o: OffsetMonitorOptions;
  private readonly wallMs: WallClock;
  private readonly monoNs: () => bigint;
  private above50 = 0;
  private above20Since: number | undefined;
  private level: OffsetLevel = 'normal';
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  /** The samples taken, for tests and metrics. */
  readonly samples: OffsetSample[] = [];

  constructor(o: OffsetMonitorOptions) {
    this.o = o;
    this.wallMs = o.wallMs ?? systemClock;
    this.monoNs = o.monoNs ?? (() => process.hrtime.bigint());
  }

  currentLevel(): OffsetLevel {
    return this.level;
  }

  /** Takes one sample and moves the ladder (RFC-006 §6.2, §6.3). */
  async sampleOnce(): Promise<OffsetSample> {
    const tSendWall = this.wallMs();
    const t0 = this.monoNs();
    const db = await this.o.dbTime();
    const rttMs = Number(this.monoNs() - t0) / 1e6;
    const offsetMs = hlcToWallMs(db) - (tSendWall + rttMs / 2);
    const boundMs = Math.abs(offsetMs) + rttMs / 2;
    this.above50 = boundMs > OFFSET.giveUpMs ? this.above50 + 1 : 0;
    const now = this.wallMs();
    if (boundMs > OFFSET.warnMs) this.above20Since ??= now; else this.above20Since = undefined;
    let level: OffsetLevel = 'normal';
    if (this.above50 >= OFFSET.giveUpSamples) level = 'D';
    else if (boundMs > OFFSET.handOffMs) level = 'A';
    else if (this.above20Since !== undefined && now - this.above20Since >= OFFSET.warnHoldMs) level = 'W';
    const s: OffsetSample = { offsetMs, rttMs, boundMs, level };
    this.samples.push(s);
    if (this.samples.length > 600) this.samples.shift();
    this.o.onSample?.(s);
    if (level !== this.level) { this.level = level; this.o.onLevel(level, s); }
    return s;
  }

  start(intervalMs: number = OFFSET.intervalMs): void {
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      // A failed read is not a sample; the next interval tries again.
      this.sampleOnce().catch(() => {}).finally(() => { this.busy = false; });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
