/**
 * One slot's lane (RFC-006 §4.3; C01 §3.2): a queue of pending calls and at most one batch transaction in flight.
 * When no batch is in flight, the lane takes every pending call (up to the size limits) into one batch; calls that
 * arrive while it commits form the next batch. The second lane (§4.3 (a), (b)) is not modelled.
 */
import type { Clock } from './clock.ts';
import type { ProtocolReport } from './protocol.ts';
import { takeBatch } from './schedule.ts';

/** One `append` call: one partition of the slot, `entries` log entries. */
export interface Call {
  /** The open-loop arrival time (clock ms). Latency is measured from here. */
  intendedMs: number;
  /** Index of the partition in the slot (0 … partitionsPerSlot − 1). */
  partition: number;
  entries: number;
  bytes: number;
  /** Makes the call's request id (the projection key) unique. */
  requestSeq: bigint;
}

/** A finished batch. */
export interface BatchDone {
  calls: Call[];
  /** When the lane took the calls from the queue (before the pool gave a connection). */
  startMs: number;
  report: ProtocolReport;
}

export interface SlotLaneOptions {
  slot: number;
  clock: Clock;
  maxEntries: number;
  maxBytes: number;
  run: (calls: Call[]) => Promise<ProtocolReport>;
  onBatch: (done: BatchDone) => void;
}

/** See the module comment. */
export class SlotLane {
  private readonly o: SlotLaneOptions;
  private readonly queue: Call[] = [];
  private busy = false;
  private halted = false;
  private waiters: Array<() => void> = [];

  constructor(o: SlotLaneOptions) {
    this.o = o;
  }

  get queued(): number { return this.queue.length; }
  get inFlight(): boolean { return this.busy; }
  /** True after a stale epoch: the lane takes no more batches. */
  get stopped(): boolean { return this.halted; }

  /** The calls still queued (unanswered at the end of a run). */
  pending(): readonly Call[] {
    return this.queue;
  }

  enqueue(call: Call): void {
    this.queue.push(call);
    this.pump();
  }

  /** Resolves when no batch is in flight and the queue is empty (or the lane stopped). */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((r) => { this.waiters.push(r); });
  }

  private isIdle(): boolean {
    return !this.busy && (this.queue.length === 0 || this.halted);
  }

  private pump(): void {
    if (this.busy || this.halted || this.queue.length === 0) return;
    this.busy = true;
    const calls = takeBatch(this.queue, this.o.maxEntries, this.o.maxBytes);
    const startMs = this.o.clock.now();
    void this.o.run(calls)
      .catch((): ProtocolReport => {
        const t = this.o.clock.now();
        return { outcome: { kind: 'failed', code: 'runner' }, restarts: [], aborts: [], freshAttempts: 0, abandons: 0, beganMs: t, commitStartMs: t, endMs: t };
      })
      .then((report) => {
        this.busy = false;
        if (report.outcome.kind === 'staleEpoch') this.halted = true;
        this.o.onBatch({ calls, startMs, report });
        this.pump();
        if (this.isIdle()) {
          const w = this.waiters;
          this.waiters = [];
          for (const r of w) r();
        }
      });
  }
}
