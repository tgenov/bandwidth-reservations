/**
 * Placement's timing loop (RFC-006 §6.4, §6.5; plan S-PLAT-I2 work item 6): it evaluates the timing alarms,
 * raises each alarm as an OperationalAlert episode on the alert stream, and writes a new `platform_timing`
 * version when A-T2 or A-T3 asks for one (fast attack). The placement owner kind does not exist yet, so the
 * episode position is a counter of this controller, not a log seq (see STATUS-I2.md).
 */
import type { HlcTs, OperationalAlert } from '../api.ts';
import { encodeJson, utf8 } from '../bytes.ts';
import { systemClock, type WallClock } from '../clock.ts';
import type { FeedBus } from '../feed/bus.ts';
import { hlcFromWallMs } from '../hlc.ts';
import { toOperationalAlert, type TimingAlarms, type TimingVersion } from './timing.ts';

export interface TimingControllerOptions {
  alarms: TimingAlarms;
  /** The version in force (placement reads it from `platform_timing`). */
  current: () => Promise<TimingVersion>;
  /** Writes a new version to all 64 shards in one transaction (`writeTimingVersion`). */
  write: (v: TimingVersion) => Promise<bigint>;
  /** Raises one alert episode on the alert stream. */
  raise: (a: OperationalAlert) => Promise<void>;
  /** The raising partition (default 'placement'). */
  partition?: Uint8Array;
  wallMs?: WallClock;
}

export class TimingController {
  private readonly o: TimingControllerOptions;
  private readonly wallMs: WallClock;
  private readonly partition: Uint8Array;
  private seq = 0n;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  /** Versions written, for tests and metrics. */
  readonly written: bigint[] = [];

  constructor(o: TimingControllerOptions) {
    this.o = o;
    this.wallMs = o.wallMs ?? systemClock;
    this.partition = o.partition ?? utf8('placement');
  }

  /** One evaluation: raise the new episodes, then write the new version if one is due. */
  async evaluateOnce(): Promise<{ raised: OperationalAlert[]; version?: bigint }> {
    const r = this.o.alarms.evaluate(await this.o.current());
    const raised: OperationalAlert[] = [];
    const at: HlcTs = hlcFromWallMs(this.wallMs());
    for (const a of r.alerts) {
      this.seq += 1n;
      const op = toOperationalAlert(a, { partition: this.partition, seq: this.seq, raisedAt: at });
      await this.o.raise(op);
      raised.push(op);
    }
    if (!r.newVersion) return { raised };
    const version = await this.o.write(r.newVersion);
    this.written.push(version);
    return { raised, version };
  }

  start(intervalMs = 1_000): void {
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      // A failed step is tried again at the next interval (newVersion is level-triggered).
      this.evaluateOnce().catch(() => {}).finally(() => { this.busy = false; });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/** An alert sink on a FeedBus: the episode as JSON on `topic` (default `placement.alert.v1`), keyed by the raising partition. */
export function busAlertSink(bus: FeedBus, topic = 'placement.alert.v1'): (a: OperationalAlert) => Promise<void> {
  return async (a) => {
    await bus.produce(topic, [{ key: a.alertId.partition, value: encodeJson(a), headers: { alert_kind: a.alertKind, op: a.op, severity: a.severity } }]);
  };
}
