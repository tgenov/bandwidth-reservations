import { hostname } from 'node:os';
import type {
  AppendCall, AppendOptions, AppendResult, Epoch, FeedCheckpoint, FeedEvent, Generation, HlcTs, MonotonicNs,
  OpenedLogRow, OwnerDeclaration, OwnerHooks, OwnerKind, OwnerRuntime, PartitionKey, ReadTx, ReportMarker, RouteInfo, Seq, SlotNo,
  SlotOfAnswer, StreamSeq, TimingSnapshot, WriterFence,
} from './api.ts';
import type { AttemptPlan, OutboxMessage, PendingCall, SlotHolding } from './batch/attempt.ts';
import { executeBatch, type BatchOutcome } from './batch/execute.ts';
import { bytesEqual, decodeJson, encodeJson, hex } from './bytes.ts';
import { FENCE_KEY, PAYLOAD_KEY } from './batch/attempt.ts';
import { tableNames } from './declaration.ts';
import { assertDeclaration } from './declaration.ts';
import { compareHlc, hlcFromWallMs, hlcToWallMs } from './hlc.ts';
import { slotOfPartition } from './home.ts';
import { EventLoopMonitor, type LoadMonitor } from './load.ts';
import { DEFAULT_SESSION_TIMINGS, PARAMS, type SessionTimings } from './params.ts';
import { MemoryPublisher, type Publisher } from './publisher.ts';
import { DevSealer, type Sealer } from './sealer.ts';
import { Session, sessionShard } from './session.ts';
import type { OwnerStore } from './store/types.ts';
import type { FeedBus } from './feed/bus.ts';
import { encodeMarker, markerSealContext } from './feed/wire.ts';
import { FeedConsumerRuntime, type ConsumerAlert } from './consumer/consumer.ts';
import type { GapFillSource } from './consumer/gapfill.ts';
import { REPORT, SlotReport, markerChunks, outcomeStream, reportsMarkers, type LeaseAnswer, type ReaderChannel } from './report/report.ts';
import type { SlotMapCache } from './placement/slot-map.ts';
import { isRetryable } from './errors.ts';

export class NotInThisIncrement extends Error {
  constructor(what: string) {
    super(`${what} is not in this @share/owner-runtime increment (S-PLAT I1)`);
    this.name = 'NotInThisIncrement';
  }
}

export interface OwnerRuntimeOptions {
  declaration: OwnerDeclaration;
  store: OwnerStore;
  /** Slots this process tries to hold (free slots, or slots of expired sessions). */
  slots: SlotNo[];
  publisher?: Publisher;
  sealer?: Sealer;
  load?: LoadMonitor;
  host?: string; region?: string; facility?: string;
  /** Timer firing callback (C01 §3.7: firing only makes the owner append). C01 names no hook for it. */
  onTimer?: (partition: PartitionKey, key: string) => void;
  /** Slot counts of other kinds for `route` on the fixed map (C01 §3.8; the account kind uses `slotMap`). */
  routeSlotCounts?: Record<OwnerKind, number>;
  /** The placement feed cache (`placement.slot_map.v1`, C01 §3.8): `slotOf` and `route('account', …)` use it. */
  slotMap?: SlotMapCache;
  /** The consumer runtime (C01 §3.5): `subscribe`, `onResolved`, `onClosed`, `onMarker` need it. */
  feeds?: {
    bus: FeedBus;
    /** Consumer group prefix (default `<kind>`). */
    groupId?: string;
    gapFill?: GapFillSource;
    gapTimeoutMs?: number;
    alert?: (a: ConsumerAlert) => void;
    /** Producer kind of a topic, for gap fill (needed for contract topics such as `catalogue.v1`). */
    producerOf?: (topic: string) => string;
  };
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Test-only overrides of C01 §7 values. */
  testing?: {
    sessionTimings?: Partial<SessionTimings>;
    commitBackstopMs?: number;
    abandonBeforeCommitMs?: number;
    onDecide?: () => void;
    /** read_lease + ε after an acquisition (C01 §3.1); default 500 ms. */
    postAcquisitionWaitMs?: number;
    /** Ids per report marker (C01 §3.4 rule 5); default 5,000. */
    markerChunkMax?: number;
  };
}

interface Queued extends PendingCall {
  resolve(r: AppendResult): void;
  reject(e: Error): void;
}

interface Lane {
  holding: SlotHolding;
  queue: Queued[];
  running: boolean;
  /** Set while Ambiguous resolution or a re-home runs: no batch starts (C01 §3.2). */
  gate: Promise<void> | null;
  released: boolean;
  /** Report position, read leases and marker state (C01 §3.4). */
  report: SlotReport;
  /** A marker-only transaction waits for the lane (C01 §3.4 rule 1). */
  markerWanted: boolean;
  reportableTimer: NodeJS.Timeout | undefined;
}

function slotKeyBytes(slot: SlotNo): Uint8Array {
  const b = Buffer.alloc(4); b.writeInt32BE(slot, 0);
  return new Uint8Array(b);
}

const noop = (): void => {};

export class CockroachOwnerRuntime implements OwnerRuntime {
  private readonly o: OwnerRuntimeOptions;
  private readonly decl: OwnerDeclaration;
  private readonly store: OwnerStore;
  private readonly publisher: Publisher;
  private readonly sealer: Sealer;
  private readonly load: LoadMonitor;
  private readonly session: Session;
  private readonly lanes = new Map<SlotNo, Lane>();
  private readonly generations = new Map<string, Generation>();
  private readonly fences = new Map<string, WriterFence>();
  private readonly timers = new Map<string, { partition: PartitionKey; timeout: NodeJS.Timeout }>();
  private readonly reportHandlers: Array<(slot: SlotNo, p: HlcTs) => void> = [];
  private hooks: OwnerHooks | undefined;
  private lastTiming: TimingSnapshot = { version: 0n, epsilonMs: PARAMS.epsilonMs, deltaXMs: 320, tauMs: 420 };
  private control: Promise<void> = Promise.resolve();
  private started = false;
  private readonly consumer: FeedConsumerRuntime | undefined;
  private readonly readers = new Map<string, ReaderChannel>();
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly log: (msg: string, fields?: Record<string, unknown>) => void;

  constructor(o: OwnerRuntimeOptions) {
    assertDeclaration(o.declaration);
    this.o = o;
    this.decl = o.declaration;
    this.store = o.store;
    this.publisher = o.publisher ?? new MemoryPublisher();
    this.sealer = o.sealer ?? new DevSealer();
    this.load = o.load ?? new EventLoopMonitor();
    this.log = o.log ?? noop;
    const timings = { ...DEFAULT_SESSION_TIMINGS, ...o.testing?.sessionTimings };
    this.session = new Session(this.store, timings,
      { host: o.host ?? hostname(), region: o.region ?? 'r1', facility: o.facility ?? 'r1a', kind: this.decl.kind },
      {
        onRevoked: () => this.serialised(() => this.rehome()),
        onResume: () => this.serialised(() => this.resume()),
        onTick: () => this.serialised(() => this.acquireWanted()),
      });
    if (o.feeds) {
      this.consumer = new FeedConsumerRuntime({
        bus: o.feeds.bus, groupId: o.feeds.groupId ?? this.decl.kind, sealer: this.sealer,
        ...(o.feeds.gapFill ? { gapFill: o.feeds.gapFill } : {}),
        ...(o.feeds.gapTimeoutMs !== undefined ? { gapTimeoutMs: o.feeds.gapTimeoutMs } : {}),
        ...(o.feeds.alert ? { alert: o.feeds.alert } : {}),
        ...(o.feeds.producerOf ? { producerOf: o.feeds.producerOf } : {}),
        log: this.log,
      });
    }
  }

  // ---------------- lifecycle (not part of OwnerRuntime) ----------------

  async start(hooks: OwnerHooks): Promise<void> {
    this.hooks = hooks;
    this.lastTiming = await this.store.readTiming(0);
    await this.session.open();
    this.started = true;
    await this.serialised(() => this.acquireWanted());
    this.session.start();
    // C01 §3.4: push to readers and advance the report position every heartbeat_interval (100 ms).
    this.heartbeat = setInterval(() => { for (const l of this.lanes.values()) void this.advance(l); }, REPORT.heartbeatMs);
    this.heartbeat.unref();
  }

  /** The consumer runtime of this process (undefined without `feeds`). */
  feedConsumer(): FeedConsumerRuntime | undefined {
    return this.consumer;
  }

  /** Drain lanes, release slots (onRelease 'shutdown'), stop renewals. */
  async stop(): Promise<void> {
    this.session.stop();
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.consumer?.stop();
    await this.serialised(async () => {
      await this.waitIdle([...this.lanes.values()]);
      const held = [...this.lanes.values()].map((l) => ({ slot: l.holding.slot, epoch: l.holding.epoch }));
      try { await this.store.release(this.decl.kind, held, this.session.sessionId); } catch (e) { this.log('release failed', { e: String(e) }); }
      for (const h of held) this.loseSlot(h.slot, 'shutdown');
    });
    for (const t of this.timers.values()) clearTimeout(t.timeout);
    this.timers.clear();
    this.load.stop();
    await this.publisher.close();
  }

  heldSlots(): SlotNo[] {
    return [...this.lanes.keys()].sort((a, b) => a - b);
  }

  sessionId(): string {
    return this.session.sessionId;
  }

  /** Test hook: stop renewing (a paused or partitioned process); the slots stay held in memory. */
  pauseRenewalsForTest(): void {
    this.session.stop();
  }

  /** Test hook: the paused process wakes and renews again. */
  resumeRenewalsForTest(): void {
    this.session.start();
  }

  /** Test hook: behave as if no renewal succeeded inside the view (a lapse). */
  lapseForTest(): void {
    this.session.expireViewForTest();
  }

  // ---------------- appending (C01 §2.4, §3.2) ----------------

  append(call: AppendCall, opts: AppendOptions = {}): Promise<AppendResult> {
    const slot = slotOfPartition(call.partition, this.decl.slotCount);
    const lane = this.lanes.get(slot);
    // Precondition (C01 §3.2): the caller holds the slot; a slot not held by this process is lost to it.
    if (!lane || lane.released) return Promise.resolve({ r: 'StaleEpoch' });
    if (this.load.shedding() || lane.queue.length >= PARAMS.maxQueuedCallsPerSlot) {
      return Promise.resolve({ r: 'Overloaded', retryAfterMs: PARAMS.overloadedRetryAfterMs });
    }
    // TODO(I2, C01 §3.2 Lanes): opts.lane === 'second' runs on the primary lane until platform_timing enables it.
    return new Promise<AppendResult>((resolve, reject) => {
      lane.queue.push({ call, opts, resolve, reject });
      this.pump(lane);
    });
  }

  private pump(lane: Lane): void {
    if (lane.running || lane.gate || lane.released) return;
    if (lane.markerWanted && this.session.leaseLive()) {
      lane.markerWanted = false;
      lane.running = true;
      void this.runMarker(lane).finally(() => {
        lane.running = false;
        this.pump(lane);
      });
      return;
    }
    if (lane.queue.length === 0) return;
    if (!this.session.leaseLive()) {
      // From the end of the holder's view the holder proposes nothing (C01 §3.1).
      setTimeout(() => this.pump(lane), 50).unref();
      return;
    }
    lane.running = true;
    const calls = this.take(lane);
    void this.runBatch(lane, calls).finally(() => {
      lane.running = false;
      this.pump(lane);
    });
  }

  /** One batch: every pending call up to the size limits; an exclusive call alone (C01 §3.2). */
  private take(lane: Lane): Queued[] {
    const first = lane.queue[0];
    if (!first) return [];
    if (first.opts.exclusive || first.opts.firstStatement) return [lane.queue.shift() as Queued];
    const out: Queued[] = [];
    let entries = 0;
    let bytes = 0;
    while (lane.queue.length > 0) {
      const next = lane.queue[0] as Queued;
      if (next.opts.exclusive || next.opts.firstStatement) break;
      const n = next.call.decide ? 1 : Math.max(1, next.call.entries?.length ?? 0);
      const b = next.call.entries ? encodeJson(next.call.entries.map((e) => e.payload)).byteLength : 0;
      if (out.length > 0 && (entries + n > PARAMS.slotBatchMaxEntries || bytes + b > PARAMS.slotBatchMaxBytes)) break;
      entries += n; bytes += b;
      out.push(lane.queue.shift() as Queued);
    }
    return out;
  }

  private async runBatch(lane: Lane, calls: Queued[]): Promise<void> {
    let outcome: BatchOutcome;
    try {
      outcome = await executeBatch(this.store, { decl: this.decl, sealer: this.sealer, holding: lane.holding, onDecide: this.o.testing?.onDecide }, calls, {
        batchRetries: PARAMS.batchRetries,
        abandonBeforeCommitMs: this.o.testing?.abandonBeforeCommitMs ?? PARAMS.abandonBeforeCommitMs,
        commitBackstopMs: this.o.testing?.commitBackstopMs ?? PARAMS.commitBackstopMs,
      });
    } catch (e) {
      outcome = { kind: 'failed', error: e instanceof Error ? e : new Error(String(e)) };
    }
    switch (outcome.kind) {
      case 'answered':
        this.lastTiming = outcome.plan.timing;
        this.applyCommitted(lane, outcome.plan);
        outcome.plan.verdicts.forEach((v, i) => {
          const q = calls[i] as Queued;
          if (v.kind === 'error') q.reject(v.error);
          else q.resolve(v.result);
        });
        return;
      case 'retry':
        this.forget(lane, calls);
        for (const q of calls) q.resolve({ r: 'Retry' });
        return;
      case 'failed':
        this.log('batch failed; answered Retry', { error: outcome.error.message });
        this.forget(lane, calls);
        for (const q of calls) q.resolve({ r: 'Retry' });
        return;
      case 'staleEpoch':
        for (const q of calls) q.resolve({ r: 'StaleEpoch' });
        this.loseSlot(lane.holding.slot, 'staleEpoch');
        return;
      case 'ambiguous': {
        this.log('COMMIT outcome unknown; resolving', { slot: lane.holding.slot, reason: outcome.reason });
        for (const q of calls) q.resolve({ r: 'Ambiguous' });
        // C01 §3.2 (M1): no batch of the slot starts until resolution steps 1–3 complete.
        const plan = outcome.plan;
        // Not awaited here: a re-home inside the resolution waits for this batch to finish.
        lane.gate = this.serialised(() => this.resolveAmbiguous(lane, plan)).finally(() => {
          lane.gate = null;
          this.pump(lane);
        });
        return;
      }
    }
  }

  private applyCommitted(lane: Lane, plan: AttemptPlan): void {
    for (const h of plan.writes.heads) {
      lane.holding.chains.set(hex(h.partition), h.chain);
      this.generations.set(hex(h.partition), h.generation);
    }
    for (const f of plan.senderFences) this.recordFence(f, f);
    this.directPublish(plan.publish);
    const r = lane.report;
    if (compareHlc(plan.ts, r.committedThrough) > 0) r.committedThrough = plan.ts;
    for (const d of plan.reportDue) r.due.push({ ts: plan.ts, ...(d.pending ? { pending: d.pending } : {}) });
    void this.advance(lane);
  }

  /** Not known to be committed ⇒ memory of those partitions is rebuilt from the head (C01 §3.2). */
  private forget(lane: Lane, calls: Queued[]): void {
    for (const q of calls) lane.holding.chains.delete(hex(q.call.partition));
  }

  private directPublish(messages: OutboxMessage[]): void {
    if (messages.length === 0) return;
    // C01 §3.5: direct publish after Committed; a failure is covered by the relay (TODO I1b, C01 §3.5 relay).
    this.publisher.publish(messages).catch((e: unknown) => this.log('direct publish failed', { error: String(e) }));
  }

  /** Resolution steps 1–3 for an Ambiguous batch (C01 §3.1, §3.2; R47-14). */
  private async resolveAmbiguous(lane: Lane, plan: AttemptPlan): Promise<void> {
    const read = await this.retryUntilAnswered(() => this.store.resolutionRead(
      this.decl.kind, this.session.shard, this.session.sessionId, [lane.holding.slot], plan.partitions));
    const committed = [...read.heads.values()].some((h) => bytesEqual(h.batchId, plan.batchId));
    this.log('Ambiguous resolved', { slot: lane.holding.slot, committed, tRes: read.tRes });
    if (committed) this.applyCommitted(lane, plan);
    else for (const p of plan.partitions) lane.holding.chains.delete(hex(p));
    const row = read.slots.get(lane.holding.slot);
    if (!row || row.epoch !== lane.holding.epoch || row.sessionId !== this.session.sessionId) {
      this.loseSlot(lane.holding.slot, 'staleEpoch');
      return;
    }
    if (read.sessionRevoked) { await this.rehome(); return; }
    // Step 4 (C01 §3.1): the slot's report position is set to T_res (never back).
    const r = lane.report;
    if (compareHlc(read.tRes, r.committedThrough) > 0) r.committedThrough = read.tRes;
    if (r.reportable && compareHlc(read.tRes, r.position) > 0) this.setPosition(lane, read.tRes);
  }

  private async retryUntilAnswered<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        this.log('resolution read failed; retrying', { error: String(e), attempt });
        await new Promise((r) => setTimeout(r, Math.min(1_000, 50 * 2 ** Math.min(attempt, 4))));
      }
    }
  }

  // ---------------- sessions and acquisition (C01 §3.1) ----------------

  private serialised(fn: () => Promise<void>): Promise<void> {
    const next = this.control.then(fn, fn);
    this.control = next.catch((e: unknown) => this.log('control step failed', { error: String(e) }));
    return next;
  }

  private newLane(slot: SlotNo, epoch: Epoch, initial: HlcTs): Lane {
    const lane: Lane = {
      holding: { slot, epoch, sessionId: this.session.sessionId, stopsVersion: null, stops: new Map(), chains: new Map(), integrityHolds: new Set() },
      queue: [], running: false, gate: null, released: false,
      report: new SlotReport(initial), markerWanted: false, reportableTimer: undefined,
    };
    this.lanes.set(slot, lane);
    return lane;
  }

  // ---------------- report position, read leases, markers (C01 §3.4) ----------------

  /** After an acquisition commit: report nothing until read_lease + ε; then onReportable (C01 §3.1). */
  private startReporting(lane: Lane, initial: HlcTs, wait: boolean): void {
    if (lane.reportableTimer) clearTimeout(lane.reportableTimer);
    lane.report = new SlotReport(initial);
    const enable = (): void => {
      lane.reportableTimer = undefined;
      if (lane.released) return;
      lane.report.reportable = true;
      this.hooks?.onReportable(lane.holding.slot);
      for (const h of this.reportHandlers) h(lane.holding.slot, lane.report.position);
      void this.advance(lane);
    };
    if (!wait) { enable(); return; }
    lane.reportableTimer = setTimeout(enable, this.o.testing?.postAcquisitionWaitMs ?? REPORT.postAcquisitionWaitMs);
    lane.reportableTimer.unref();
  }

  private setPosition(lane: Lane, p: HlcTs): void {
    lane.report.position = p;
    for (const h of this.reportHandlers) h(lane.holding.slot, p);
    if (reportsMarkers(this.decl) && lane.report.markerDue()) this.scheduleMarker(lane);
  }

  /** Push "committed through" to the readers, then move P to what every live lease allows. */
  private async advance(lane: Lane): Promise<void> {
    const r = lane.report;
    if (!r.reportable || lane.released || !this.session.leaseLive()) return;
    const target = r.committedThrough;
    await Promise.all([...this.readers].map(async ([id, ch]) => {
      try {
        const a = await ch.apply(lane.holding.slot, target);
        const cur = r.applied.get(id);
        if (cur === undefined || compareHlc(a, cur) > 0) r.applied.set(id, a);
      } catch { /* that reader's lease holds P back until it ends */ }
    }));
    if (lane.released || lane.report !== r || !this.session.leaseLive()) return;
    const p = r.target(process.hrtime.bigint());
    if (compareHlc(p, r.position) > 0) this.setPosition(lane, p);
    else if (reportsMarkers(this.decl) && r.markerDue()) this.scheduleMarker(lane);
  }

  private scheduleMarker(lane: Lane): void {
    const r = lane.report;
    if (r.markerScheduled) return;
    r.markerScheduled = true;
    // Rule 1: a marker-only transaction within marker_max_wait (20 ms) of P passing an unmarked entry.
    setTimeout(() => {
      r.markerScheduled = false;
      if (lane.released || lane.report !== r) return;
      lane.markerWanted = true;
      this.pump(lane);
    }, REPORT.markerMaxWaitMs).unref();
  }

  /** A marker-only transaction (C01 §3.4): owner_slot.report_through and marker_seq, and the marker rows. */
  private async runMarker(lane: Lane): Promise<void> {
    const r = lane.report;
    if (!reportsMarkers(this.decl) || !r.reportable || !r.markerDue()) return;
    const slot = lane.holding.slot;
    const epoch = lane.holding.epoch;
    const P = r.position;
    const stream = outcomeStream(this.decl);
    let tx;
    try { tx = await this.store.beginBatch(); } catch (e) { this.log('marker begin failed', { error: String(e) }); this.scheduleMarker(lane); return; }
    try {
      const fence = await tx.readFence(this.decl.kind, slot);
      if (!fence || fence.epoch !== epoch || fence.sessionId !== lane.holding.sessionId) {
        await tx.rollback().catch(() => {}); tx.close(false);
        this.loseSlot(slot, 'staleEpoch');                 // a marker is never written by a stale epoch
        return;
      }
      const prev = fence.reportThrough;
      if (prev !== null && compareHlc(P, prev) <= 0) {
        await tx.rollback().catch(() => {}); tx.close(false);
        r.firstMarkerPending = false;
        r.due = r.due.filter((d) => compareHlc(d.ts, prev) > 0);
        return;
      }
      const ts = await tx.readTs();
      const ids = new Map<string, Uint8Array>();
      if (r.firstMarkerPending && stream && tx.readOutcomeIds) {
        // Rule 7: the first marker after an acquisition lists every covered outcome above prevReportPosition.
        for (const id of await tx.readOutcomeIds(this.decl.kind, slot, stream.name, prev, P)) ids.set(hex(id), id);
      }
      for (const d of r.due) {
        if (d.pending && compareHlc(d.ts, P) <= 0 && (prev === null || compareHlc(d.ts, prev) > 0)) ids.set(hex(d.pending), d.pending);
      }
      const markers = markerChunks({ slot, generation: 0, epoch, reportPosition: P, prevReportPosition: prev }, [...ids.values()],
        this.o.testing?.markerChunkMax ?? REPORT.markerChunkMax);
      const outbox: import('./store/types.ts').OutboxRowWrite[] = [];
      const publish: OutboxMessage[] = [];
      let seq = fence.markerSeq;
      if (stream) {
        for (const m of markers) {
          seq += 1n;
          const headers: Record<string, string> = {
            partition: '', stream: stream.name, stream_seq: seq.toString(), generation: '0', epoch: epoch.toString(), ts,
            kind: '0', schema_v: '1', key_id: hex(this.sealer.keyId(stream.topic)), slot: String(slot), report_through: P,
          };
          const value = this.sealer.seal(encodeMarker(m), markerSealContext(this.decl.kind, slot, stream.name, seq, epoch));
          const key = slotKeyBytes(slot);
          outbox.push({ slot, partition: new Uint8Array(), stream: stream.name, streamSeq: seq, n: 0, topic: stream.topic, msgKey: key,
            headers: encodeJson(headers), payload: value, generation: 0, epoch, ifAbsent: false });
          publish.push({ topic: stream.topic, key, headers: { ...headers, partition: Buffer.alloc(0) }, value });
        }
      }
      await tx.write(this.decl.kind, { ts, log: [], outbox, heads: [], projections: [], slotUpdate: { slot, reportThrough: P, markerSeq: seq } });
      await tx.commit(this.o.testing?.commitBackstopMs ?? PARAMS.commitBackstopMs);
      tx.close(false);
      r.firstMarkerPending = false;
      r.due = r.due.filter((d) => compareHlc(d.ts, P) > 0);
      this.markersWritten.push(...markers);
      this.directPublish(publish);
    } catch (e) {
      // Not known to be written: the next marker re-reads report_through, so the chain stays whole.
      if (isRetryable(e)) await tx.rollback().catch(() => {});
      tx.close(!isRetryable(e));
      this.log('marker transaction failed; retrying', { slot, error: String(e) });
      this.scheduleMarker(lane);
    }
  }

  /** Markers this process wrote, in order (tests). */
  readonly markersWritten: import('./api.ts').ReportMarker[] = [];

  /**
   * Holder side of a read lease (C01 §3.4). A status reader asks with its applied-through position and its
   * send time; the lease ends 400 ms after the send and must end inside the holder's view.
   */
  grantReadLease(req: { slot: SlotNo; readerId: string; appliedThrough: HlcTs; sendMonotonic: MonotonicNs }): LeaseAnswer {
    const lane = this.lanes.get(req.slot);
    if (!lane || lane.released) return { granted: false, reason: 'notHolder' };
    return lane.report.grant(req.slot, req, this.session.viewEndsAt(), this.leaseValid(req.slot).valid);
  }

  /** A status reader's push channel (heartbeat every 100 ms). */
  attachReader(readerId: string, channel: ReaderChannel): void {
    this.readers.set(readerId, channel);
  }

  detachReader(readerId: string): void {
    this.readers.delete(readerId);
    for (const l of this.lanes.values()) { l.report.applied.delete(readerId); l.report.leases.delete(readerId); }
  }

  /** Free-slot acquisition and acquisition by expiry (RFC-006 §4.2), then catch-up and onAcquire. */
  private async acquireWanted(): Promise<void> {
    if (!this.started) return;
    const wanted = this.o.slots.filter((s) => !this.lanes.has(s));
    if (wanted.length === 0) return;
    const rows = await this.store.listSlots(this.decl.kind, wanted);
    const acquired: Array<{ slot: SlotNo; epoch: Epoch }> = [];
    const byOld = new Map<string, SlotNo[]>();
    for (const r of rows) {
      if (r.sessionId === null) {
        const a = await this.store.acquireFree(this.decl.kind, r.slot, this.session.sessionId);
        if (a) acquired.push(a);
      } else if (r.sessionId !== this.session.sessionId && (r.sessionExpired || r.sessionRevoked)) {
        byOld.set(r.sessionId, [...(byOld.get(r.sessionId) ?? []), r.slot]);
      }
    }
    for (const [old, slots] of byOld) {
      acquired.push(...await this.store.acquireExpired(this.decl.kind, sessionShard(old), old, slots, this.session.sessionId));
    }
    if (acquired.length === 0) return;
    // Catch-up: a high-priority present-time read; it pushes any open transaction of the old holder.
    // Its timestamp is the initial report position (C01 §3.1, AI-33-2).
    const catchUp = await this.retryUntilAnswered(() => this.store.resolutionRead(
      this.decl.kind, this.session.shard, this.session.sessionId, acquired.map((a) => a.slot), []));
    for (const a of acquired) this.newLane(a.slot, a.epoch, catchUp.tRes);
    for (const a of acquired) {
      this.log('acquired', { slot: a.slot, epoch: a.epoch.toString(), catchUp: catchUp.tRes });
      try { await this.rebuildFences(a.slot); } catch (e) { this.log('fence rebuild failed', { slot: a.slot, error: String(e) }); }
      await this.hooks?.onAcquire(a.slot, a.epoch, 'expiry');
      const lane = this.lanes.get(a.slot);
      if (lane) { this.startReporting(lane, catchUp.tRes, true); this.pump(lane); }
    }
  }

  /** Re-home (C01 §3.1): new session, conditional transfer of each slot at its own epoch, steps 1–4, onAcquire('rehome'). */
  private async rehome(): Promise<void> {
    const lanes = [...this.lanes.values()];
    let release: () => void = noop;
    const gate = new Promise<void>((r) => { release = r; });
    for (const l of lanes) l.gate ??= gate;
    try {
      await this.waitIdle(lanes);
      const old = this.session.sessionId;
      const held = lanes.map((l) => ({ slot: l.holding.slot, epoch: l.holding.epoch }));
      await this.session.open();
      const kept = await this.store.rehome(this.decl.kind, held, old, this.session.sessionId);
      const keptSlots = new Map(kept.map((k) => [k.slot, k.epoch]));
      for (const l of lanes) {
        const epoch = keptSlots.get(l.holding.slot);
        if (epoch === undefined) { this.loseSlot(l.holding.slot, 'taken'); continue; }
        l.holding.epoch = epoch;
        l.holding.sessionId = this.session.sessionId;
        l.holding.stopsVersion = null;
      }
      const read = await this.retryUntilAnswered(() => this.store.resolutionRead(this.decl.kind, this.session.shard, this.session.sessionId, [...keptSlots.keys()], []));
      // Step 4: report position = T_res, then the read_lease + ε reporting wait (C01 §3.1).
      for (const l of lanes) if (keptSlots.has(l.holding.slot)) this.startReporting(l, read.tRes, true);
      for (const [slot, epoch] of keptSlots) await this.hooks?.onAcquire(slot, epoch, 'rehome');
    } finally {
      for (const l of lanes) if (l.gate === gate) l.gate = null;
      release();
      for (const l of lanes) this.pump(l);
    }
  }

  /** Resume (C01 §3.1): steps 1–4; slots taken meanwhile are released; a revoked session re-homes. */
  private async resume(): Promise<void> {
    const lanes = [...this.lanes.values()];
    await this.waitIdle(lanes);
    const read = await this.retryUntilAnswered(() => this.store.resolutionRead(
      this.decl.kind, this.session.shard, this.session.sessionId, lanes.map((l) => l.holding.slot), []));
    for (const l of lanes) {
      const row = read.slots.get(l.holding.slot);
      if (!row || row.epoch !== l.holding.epoch || row.sessionId !== this.session.sessionId) this.loseSlot(l.holding.slot, 'taken');
    }
    if (read.sessionRevoked) { await this.rehome(); return; }
    // Step 4: report position = T_res, then onReportable without a further wait (C01 §3.1).
    for (const l of lanes) if (!l.released) this.startReporting(l, read.tRes, false);
  }

  private async waitIdle(lanes: Lane[]): Promise<void> {
    while (lanes.some((l) => l.running)) await new Promise((r) => setTimeout(r, 5));
  }

  private loseSlot(slot: SlotNo, reason: 'staleEpoch' | 'handedOff' | 'taken' | 'shutdown'): void {
    const lane = this.lanes.get(slot);
    if (!lane || lane.released) return;
    lane.released = true;
    if (lane.reportableTimer) clearTimeout(lane.reportableTimer);
    this.lanes.delete(slot);
    for (const q of lane.queue.splice(0)) q.resolve({ r: 'StaleEpoch' });
    for (const [k, t] of this.timers) {
      if (slotOfPartition(t.partition, this.decl.slotCount) === slot) { clearTimeout(t.timeout); this.timers.delete(k); }
    }
    this.log('slot released', { slot, reason });
    this.hooks?.onRelease(slot, reason);
  }

  // ---------------- rebuild support (C01 §3.1, R47-24) ----------------

  /**
   * A partition's log rows from `fromSeq`, by (partition, seq) across the slots it lived in, with payload and
   * audit opened (C01 §3.1 "Rebuilding a partition"). For replay on takeover, Ambiguous reload and adopt.
   */
  async readLog(partition: PartitionKey, fromSeq: Seq = 1n): Promise<OpenedLogRow[]> {
    if (!this.store.readLogRows) throw new Error('the store cannot read log rows');
    const t = tableNames(this.decl.kind);
    const rows = await this.store.readLogRows(this.decl.kind, partition, fromSeq);
    return rows.map((r) => {
      const ctx = { ownerKind: this.decl.kind, table: t.log, primaryKey: { slot: r.slot, partition: r.partition, seq: r.seq }, seqOrVersion: r.seq, epoch: r.epoch };
      let payload = decodeJson(this.sealer.open(r.payload, { ...ctx, rowKind: `entry:${r.kind}` }));
      let senderFence: OpenedLogRow['senderFence'];
      if (payload !== null && typeof payload === 'object' && PAYLOAD_KEY in (payload as Record<string, unknown>)) {
        const env = payload as Record<string, unknown>;
        senderFence = env[FENCE_KEY] as OpenedLogRow['senderFence'];
        payload = env[PAYLOAD_KEY];
      }
      const audit = decodeJson(this.sealer.open(r.audit, { ...ctx, rowKind: 'audit' }));
      const emits = (decodeJson(r.emits) as Array<[string, string]>).map(([s, n]) => [s, BigInt(n)] as [string, StreamSeq]);
      return {
        slot: r.slot, partition: r.partition, seq: r.seq, generation: r.generation, epoch: r.epoch, kind: r.kind, schemaV: r.schemaV,
        ts: r.ts, identity: r.identity, emits, retention: r.retention, payload, audit, chain: r.chain, ...(senderFence ? { senderFence } : {}),
      };
    });
  }

  /** The partitions the slot serves: heads that name it and are adopted (C01 §3.2). For onAcquire rebuilds. */
  async listPartitions(slot: SlotNo): Promise<PartitionKey[]> {
    if (!this.store.listPartitions) throw new Error('the store cannot list partitions');
    return this.store.listPartitions(this.decl.kind, slot);
  }

  /** R47-24: rebuild the admitCommand high-water marks from the log of the slot's partitions. */
  private async rebuildFences(slot: SlotNo): Promise<void> {
    if (!this.store.listPartitions || !this.store.readLogRows) return;
    for (const p of await this.store.listPartitions(this.decl.kind, slot)) {
      for (const row of await this.readLog(p)) if (row.senderFence) this.recordFence(row.senderFence, row.senderFence);
    }
  }

  /**
   * Publish a declared non-log message (e.g. a watermark) on its topic with the holder's producer (the
   * stream ACL of C01 §2.5). The caller must hold the partition's slot with a valid lease. Key = partition.
   */
  async publishMessage(name: string, partition: PartitionKey, value: Uint8Array, headers: Record<string, string> = {}): Promise<void> {
    const m = this.decl.messages?.find((x) => x.name === name);
    if (!m) throw new Error(`message ${name} is not declared by ${this.decl.kind}`);
    const slot = slotOfPartition(partition, this.decl.slotCount);
    if (!this.leaseValid(slot).valid) throw new Error(`slot ${slot} is not held with a valid lease`);
    await this.publisher.publish([{ topic: m.topic, key: partition, value,
      headers: { ...headers, partition: Buffer.from(partition), kind: 'message', epoch: this.epoch(slot).toString() } }]);
  }

  // ---------------- leases, fences, time ----------------

  leaseValid(slot: SlotNo): { valid: boolean; untilMonotonic: MonotonicNs } {
    const lane = this.lanes.get(slot);
    const valid = lane !== undefined && !lane.released && lane.gate === null && this.session.leaseLive();
    return { valid, untilMonotonic: this.session.viewEndsAt() - BigInt(PARAMS.maxLoopDelayMs) * 1_000_000n };
  }

  epoch(slot: SlotNo): Epoch {
    return this.lanes.get(slot)?.holding.epoch ?? 0n;
  }

  generation(partition: PartitionKey): Generation {
    return this.generations.get(hex(partition)) ?? 0;
  }

  /** C01 §3.8, R47-24: the high-water marks are rebuilt from the log before onAcquire (rebuildFences).
   *  TODO(I3, R47-24): the same on onAdopt. */
  admitCommand(sender: { kind: OwnerKind; partition: PartitionKey }, fence: WriterFence):
    { admit: true } | { admit: false; recorded: WriterFence } {
    const recorded = this.fences.get(`${sender.kind}|${hex(sender.partition)}`);
    if (recorded && (fence.generation < recorded.generation || (fence.generation === recorded.generation && fence.epoch < recorded.epoch))) {
      return { admit: false, recorded };
    }
    return { admit: true };
  }

  private recordFence(sender: { kind: OwnerKind; partition: PartitionKey }, f: WriterFence): void {
    const k = `${sender.kind}|${hex(sender.partition)}`;
    const cur = this.fences.get(k);
    if (!cur || cur.generation < f.generation || (cur.generation === f.generation && cur.epoch < f.epoch)) {
      this.fences.set(k, { generation: f.generation, epoch: f.epoch });
    }
  }

  timing(): TimingSnapshot {
    return this.lastTiming;
  }

  /** Liveness only, never decides an outcome (A8). TODO(S-PLAT-I1 rest, RFC-006 §6.2): owner-host offset check. */
  now(): { ts: HlcTs; boundMs: number } {
    return { ts: hlcFromWallMs(Date.now()), boundMs: PARAMS.epsilonMs };
  }

  // ---------------- positions (TODO I1b) ----------------

  /** C01 §3.4: undefined until onReportable. */
  reportPosition(slot: SlotNo): HlcTs | undefined {
    const lane = this.lanes.get(slot);
    return lane && lane.report.reportable ? lane.report.position : undefined;
  }

  onReport(handler: (slot: SlotNo, p: HlcTs) => void): void {
    this.reportHandlers.push(handler);
  }

  // ---------------- reads ----------------

  consistentRead<T>(fn: (tx: ReadTx) => Promise<T>, at: 'present' | HlcTs): Promise<T> {
    return this.store.withReadTx(at, fn);
  }

  followerRead<T>(fn: (tx: ReadTx) => Promise<T>): Promise<{ value: T; servedAt: HlcTs }> {
    return this.store.followerRead(fn);
  }

  /** Approximated by follower_read_timestamp(). TODO(S-PLAT-I1 rest, C01 §2.4): the closed timestamp proper. */
  async closedTimestamp(): Promise<HlcTs> {
    return (await this.store.followerRead(async () => undefined)).servedAt;
  }

  // ---------------- feeds (TODO I1b) ----------------

  private feeds(what: string): FeedConsumerRuntime {
    if (!this.consumer) throw new Error(`${what} needs OwnerRuntimeOptions.feeds (the consumer runtime's bus)`);
    return this.consumer;
  }

  subscribe(topic: string, from: FeedCheckpoint, gate: 'committed' | 'reported', handler: (e: FeedEvent) => Promise<void>): void {
    this.feeds('subscribe').subscribe(topic, from, gate, handler);
  }

  onResolved(topic: string, handler: (destinationPartition: number, R: HlcTs) => void): void {
    this.feeds('onResolved').onResolved(topic, handler);
  }

  onClosed(handler: (link: PartitionKey, t: HlcTs, feedSeq: StreamSeq) => void): void {
    this.feeds('onClosed').onClosed(handler);
  }

  onMarker(topic: 'account.outcome.v1', handler: (m: ReportMarker) => Promise<void>): void {
    this.feeds('onMarker').onMarker(topic, handler);
  }

  // ---------------- timers (C01 §3.7) ----------------

  timer(partition: PartitionKey, key: string, atTs: HlcTs): void {
    const k = `${hex(partition)}|${key}`;
    const prev = this.timers.get(k);
    if (prev) clearTimeout(prev.timeout);
    const arm = (): void => {
      const wait = hlcToWallMs(atTs) - Date.now();
      const timeout = setTimeout(() => {
        if (compareHlc(this.now().ts, atTs) < 0) { arm(); return; }   // long waits are re-armed in steps
        this.timers.delete(k);
        this.o.onTimer?.(partition, key);
      }, Math.max(0, Math.min(wait, 2 ** 31 - 1)));
      this.timers.set(k, { partition, timeout });
    };
    arm();
  }

  cancelTimer(partition: PartitionKey, key: string): void {
    const k = `${hex(partition)}|${key}`;
    const t = this.timers.get(k);
    if (t) { clearTimeout(t.timeout); this.timers.delete(k); }
  }

  // ---------------- routing (fixed map, C01 §3.8) ----------------

  /** C01 §3.8: the account kind routes by the slot-map feed; other kinds by their fixed slot count.
   *  TODO(I3, C01 §3.8): cache refresh by STALE_EPOCH, MOVED and MOVING answers; holderHint and readers. */
  route(kind: OwnerKind, partition: PartitionKey): RouteInfo {
    if (kind === 'account' && this.o.slotMap?.current()) {
      const a = this.slotOf(partition);
      return { slot: a.slot, generation: kind === this.decl.kind ? this.generation(partition) : 0,
        epoch: kind === this.decl.kind ? this.epoch(a.slot) : 0n, readers: [], mapVersion: a.mapVersion };
    }
    const count = kind === this.decl.kind ? this.decl.slotCount : this.o.routeSlotCounts?.[kind];
    if (count === undefined) throw new Error(`no slot count for kind ${kind} (fixed map of I1a)`);
    const slot = slotOfPartition(partition, count);
    return { slot, generation: kind === this.decl.kind ? this.generation(partition) : 0, epoch: kind === this.decl.kind ? this.epoch(slot) : 0n, readers: [] };
  }

  /** Fixed map: headDecides always false in I1 (plan §3). */
  slotOf(account: PartitionKey): SlotOfAnswer {
    const fromFeed = this.o.slotMap?.slotOf(account);
    if (fromFeed) return fromFeed;
    const count = this.decl.kind === 'account' ? this.decl.slotCount : this.o.routeSlotCounts?.['account'];
    if (count === undefined) throw new Error('no account slot count (fixed map of I1a)');
    return { slot: slotOfPartition(account, count), mapVersion: 1n, headDecides: false };
  }

  /** TODO(I4, C01 §2.4): real topology states. */
  topology(): { state: string; preferredRegion: 'R1' | 'R2'; disaster: null | { region: string; since: HlcTs } } {
    return { state: 'steady', preferredRegion: 'R1', disaster: null };
  }

  // ---------------- checkpoints (TODO I2) ----------------

  putCheckpoint(_kind: OwnerKind, _partition: PartitionKey, _seq: Seq, _bytes: Uint8Array): Promise<{ reference: string; digest: Uint8Array }> {
    return Promise.reject(new NotInThisIncrement('putCheckpoint — TODO(I2, RFC-006 §12.11)'));
  }

  getCheckpoint(_reference: string): Promise<Uint8Array> {
    return Promise.reject(new NotInThisIncrement('getCheckpoint — TODO(I2, RFC-006 §12.11)'));
  }
}
