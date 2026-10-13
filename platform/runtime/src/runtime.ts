import { hostname } from 'node:os';
import type {
  AppendCall, AppendOptions, AppendResult, Epoch, FeedCheckpoint, FeedEvent, Generation, HlcTs, MapVersion, MonotonicNs,
  OpenedLogRow, OwnerDeclaration, OwnerHooks, OwnerKind, OwnerRuntime, PartitionKey, ReadTx, ReportMarker, RouteInfo, Seq, SlotNo,
  SlotMapVersion, SlotOfAnswer, StreamSeq, TimingSnapshot, WriterFence,
} from './api.ts';
import { isPlatformEntry, type AttemptPlan, type OutboxMessage, type PendingCall, type PlatformOp, type SlotHolding } from './batch/attempt.ts';
import { executeBatch, type BatchOutcome } from './batch/execute.ts';
import { bytesEqual, decodeJson, encodeJson, hex } from './bytes.ts';
import { FENCE_KEY, PAYLOAD_KEY } from './batch/attempt.ts';
import { tableNames } from './declaration.ts';
import { assertDeclaration } from './declaration.ts';
import { compareHlc, hlcBefore, hlcFromWallMs, hlcToWallMs } from './hlc.ts';
import { systemClock, type WallClock } from './clock.ts';
import { home, slotOfPartition } from './home.ts';
import { EventLoopMonitor, type LoadMonitor } from './load.ts';
import { DEFAULT_SESSION_TIMINGS, OVERLOAD, PARAMS, type SessionTimings } from './params.ts';
import { LaneCostModel, SlotAdmission, expectedSojournMs, type AdmissionState, type Random } from './overload.ts';
import { MemoryPublisher, type Publisher } from './publisher.ts';
import { DevSealer, type Sealer } from './sealer.ts';
import { Session, sessionShard } from './session.ts';
import type { OwnerStore, ResolutionRead, TimingRow } from './store/types.ts';
import type { FeedBus } from './feed/bus.ts';
import { encodeMarker, markerSealContext } from './feed/wire.ts';
import { FeedConsumerRuntime, type ConsumerAlert } from './consumer/consumer.ts';
import type { GapFillSource } from './consumer/gapfill.ts';
import { REPORT, SlotReport, markerChunks, outcomeStream, reportsMarkers, type LeaseAnswer, type ReaderChannel } from './report/report.ts';
import { slotOfInMap, type SlotMapCache } from './placement/slot-map.ts';
import { isRetryable } from './errors.ts';
import { SelfOutboxedError, emitFunctionErrors, openLogRow, type EmitFunctions } from './selfout/derive.ts';
import { CheckpointError, type CheckpointStore } from './checkpoint/store.ts';
import { OffsetMonitor, type OffsetLevel, type OffsetSample } from './offset.ts';
import { StandbyTail, type StandbyChannel, type StandbyPush, type StandbyStats } from './standby/tail.ts';

export class NotInThisIncrement extends Error {
  constructor(what: string) {
    super(`${what} is not in this @share/owner-runtime increment (S-PLAT I1)`);
    this.name = 'NotInThisIncrement';
  }
}

/** The refusal codes of a slot group's configuration (RFC-006 §7.1; C01 §2.2 `slotGroupWith`). */
export type SlotGroupErrorCode = 'GROUP_MEMBER_FLAG' | 'GROUP_SLOT_COUNT' | 'GROUP_PARTNER' | 'GROUP_START_ORDER';

/** A slot group that cannot be built or started. `code` is the refusal. */
export class SlotGroupError extends Error {
  readonly code: SlotGroupErrorCode;
  constructor(code: SlotGroupErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'SlotGroupError';
    this.code = code;
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
  /** The wall clock of `now()` and of timers (default: the system clock). */
  wallMs?: WallClock;
  /** Emit functions of a self-outboxed kind (RFC-006 §3.5): required when the declaration is selfOutboxed. */
  emitFns?: EmitFunctions;
  /**
   * Slot groups (RFC-006 §4.2, §7.1; C01 §2.2 `slotGroupWith`): this runtime leads the group. Its session is
   * the session of every member; slot i of every member is taken, handed off, taken over and re-homed in one
   * transaction with slot i of this kind. Each member is constructed before, with `slotGroupMember: true`.
   */
  slotGroup?: { members: CockroachOwnerRuntime[] };
  /** This runtime is a member of a slot group; the group's leader holds its slots (see `slotGroup`). */
  slotGroupMember?: boolean;
  /**
   * A hot standby (RFC-006 §4.4): it holds no slot until its holder's session expires or is revoked, or its holder
   * frees the slot (a hand-off at offset level A, a stop). It applies
   * the holder's pushed batches and its own follower-read tail (every `pollMs`, default 250) to the owner's
   * memory through `apply`, polls the holder's session at the present time every `pollMs`, and on expiry takes
   * the slots, reads only the rows above its tail at the present time, then calls `onAcquire`.
   */
  standby?: { apply(rows: OpenedLogRow[]): void; pollMs?: number };
  /**
   * The owner-host offset check (RFC-006 §6.2): every `intervalMs` (1 s) against the database's time. Above
   * 40 ms the process stops taking slots and hands its slots off; above 50 ms on three samples it gives up its
   * session at once and calls `onGiveUp` (the supervisor then exits and restarts the process).
   */
  offsetCheck?: { intervalMs?: number; onGiveUp?: () => void; onLevel?: (level: OffsetLevel, s: OffsetSample) => void; onSample?: (s: OffsetSample) => void };
  /** The checkpoint store of the process's own region (RFC-006 §12.11): `putCheckpoint`, `getCheckpoint`. */
  checkpoints?: CheckpointStore;
  /** The move protocol (C01 §3.3): the holders of other slots, the pre-warm of a partition, the fence wait. */
  moves?: MoveOptions;
  /**
   * C08 §J `integrity_report` to audit (R46-12): sent once for each local hold after a head-chain mismatch, retried
   * until audit accepts it; the answer's detection_ref is then the `Stopped` result's.
   */
  integrityReport?: (r: IntegrityReport) => Promise<{ detectionRef: Uint8Array }>;
  /** Placement's `ackSplitting` (C01 §2.7, R47-05): the account kind's holder calls it for each splitting slot. */
  placement?: { ackSplitting(req: AckSplittingRequest): Promise<{ recorded: true }> };
  /** Test-only overrides of C01 §7 values. */
  testing?: {
    sessionTimings?: Partial<SessionTimings>;
    commitBackstopMs?: number;
    abandonBeforeCommitMs?: number;
    /**
     * The monotonic clock (ms) of the abandon budget of each batch (C01 §7) and of overload control (RFC-006 §4.7
     * rule 5: sojourn, fit window, shed ticks); default `performance.now`.
     */
    batchNowMs?: () => number;
    /** The uniform random source of `retryAfterMs` (RFC-006 §4.7 rule 5a); default `Math.random`. A test seeds it. */
    random?: Random;
    /** False turns rule 5 (5a, 5b, 5c) off: the runtime as before erratum 7.1, the control of §22.1. Default on. */
    overloadControl?: boolean;
    onDecide?: () => void;
    /** read_lease + ε after an acquisition (C01 §3.1); default 500 ms. */
    postAcquisitionWaitMs?: number;
    /** Ids per report marker (C01 §3.4 rule 5); default 5,000. */
    markerChunkMax?: number;
    /** read_lease + ε after an adopt commit (C01 §3.3 step 6); default 500 ms. */
    adoptReportWaitMs?: number;
    /**
     * The monotonic clock of the report position: the step-6 hold and the read lease ends (engineering.md §5: a test
     * steps it). Default `process.hrtime.bigint`.
     */
    reportMonotonic?: () => MonotonicNs;
  };
}

/** A holder's report fence for a move (C01 §3.3 step 4): `owner_slot(kind, slot).report_through`. */
export interface ReportFence { kind: OwnerKind; slot: SlotNo; reportThrough: HlcTs }

/** The channel to the holder of a move's target slot (C01 §3.3 step 4, V59-7): it receives the source's fence. */
export interface MoveInbox { fence(f: ReportFence): void }

/** Move options of a runtime (C01 §3.3). */
export interface MoveOptions {
  /** The inbox of the holder of `slot` (step 4 push; V59-7), or undefined when it is not known. */
  peer?: (kind: OwnerKind, slot: SlotNo) => MoveInbox | undefined;
  /**
   * Step 2 pre-warm: the owner loads the partition from these rows (by (partition, seq), platform entries left out):
   * at `prepareAdopt` every row, at `adopt` only the rows above the ones it got. It may load a checkpoint first.
   */
  prewarm?: (partition: PartitionKey, rows: OpenedLogRow[]) => void | Promise<void>;
  /** Step 5: with no fence push in this time, read `owner_slot(kind, A)` by a bounded read (default 100 ms). */
  fenceReadAfterMs?: number;
  /** Step 5: the interval of those reads (default 100 ms). */
  fencePollMs?: number;
}

/** C08 §J `integrity_report` (kind, partition, seq, observed_chain). */
export interface IntegrityReport { kind: OwnerKind; partition: PartitionKey; seq: Seq; observedChain: Uint8Array }

/** C01 §2.7 `ackSplitting` request. */
export interface AckSplittingRequest {
  kind: 'account'; slot: SlotNo; mapVersion: MapVersion; epoch: Epoch; upperHalf: Uint8Array[]; asOf: HlcTs;
}

/** C01 §2.7 `HolderPlacementApi.listPartitions` answer. */
export type ListPartitionsAnswer =
  | { partitions: Uint8Array[]; asOf: HlcTs; epoch: Epoch }
  | { refused: 'NOT_ACKED' | 'NOT_OWNER' };

interface Queued extends PendingCall {
  /** Monotonic ms when the call was queued; a call put back after an abandon keeps it (RFC-006 §4.7 rule 5c). */
  enqueuedAt: number;
  /** Entries as counted for slot_batch_max_entries (a decide call counts 1). */
  entries: number;
  resolve(r: AppendResult): void;
  reject(e: Error): void;
}

interface Lane {
  holding: SlotHolding;
  queue: Queued[];
  running: boolean;
  /** The second lane's batch is in flight (C01 §3.2, R47-31). */
  secondRunning: boolean;
  /** hex(partition) of the batch in flight on each lane: [first, second]. */
  inFlight: [Set<string>, Set<string>];
  /** Set while Ambiguous resolution or a re-home runs: no batch starts (C01 §3.2). */
  gate: Promise<void> | null;
  released: boolean;
  /** Report position, read leases and marker state (C01 §3.4). */
  report: SlotReport;
  /** A marker-only transaction waits for the lane (C01 §3.4 rule 1). */
  markerWanted: boolean;
  reportableTimer: NodeJS.Timeout | undefined;
  /** ts of the last batch pushed to the standbys, or the acquisition's catch-up read (RFC-006 §4.4). */
  pushedThrough: HlcTs;
  /** Ambiguous batches of the slot not yet resolved: one may be committed below a later ts and not pushed yet. */
  unresolved: number;
  /** C01 §3.3 step 4, V59-7: fences owed to the targets of moves out of this slot, pushed once a marker covers `ts`. */
  pendingFences: Array<{ to: SlotNo; ts: HlcTs }>;
  /** C01 §3.8: the map version whose splitting state of this slot the holder applied and acknowledged. */
  splitAcked?: MapVersion;
  /** RFC-006 §4.7 rule 5a: admission control of the slot's one queue. */
  admission: SlotAdmission;
  /** RFC-006 §4.7 rule 5b: the cost model of each lane, [first, second]. */
  cost: [LaneCostModel, LaneCostModel];
  /** The entries in `queue` (5a `q`). */
  queuedEntries: number;
  /** Abandons, and fresh attempts after an abandon (RFC-006 §4.7 monitoring). */
  abandons: number;
  freshAfterAbandon: number;
}

/** Overload control of one slot (RFC-006 §4.7 rule 5 "Monitoring"; the §16 alarms and DT-50 read it). */
export interface OverloadStats {
  state: AdmissionState;
  /** Monotonic ms of the entry while overloaded (the "slot overloaded" alarm: more than 60 s, 5 min). */
  overloadedSinceMs: number | undefined;
  /** Entries plus releases, and the monotonic time of the latest. */
  stateChanges: number;
  lastChangeMs: number | undefined;
  /** `Overloaded` answers of rule 5a at once and deferred to the next tick, and calls queued ("owner ignores retryAfterMs"). */
  shedAtOnce: number;
  shedDeferred: number;
  admitted: number;
  /** The latest sojourn sample and the expected sojourn now. */
  lastSojournMs: number;
  expectedSojournMs: number;
  abandons: number;
  freshAfterAbandon: number;
  /** Per lane [first, second]: `F̂`, `ĉ`, `n_cap`, the samples in the window, regime resets and probe takes. */
  lanes: Array<{ fHatMs: number | undefined; cHatMs: number | undefined; nCap: number; samples: number; regimeResets: number; probeTakes: number }>;
}

/** Entries of one call as slot_batch_max_entries counts them. */
function entriesOf(call: AppendCall): number {
  return call.decide ? 1 : Math.max(1, call.entries?.length ?? 0);
}

function slotKeyBytes(slot: SlotNo): Uint8Array {
  const b = Buffer.alloc(4); b.writeInt32BE(slot, 0);
  return new Uint8Array(b);
}

const noop = (): void => {};

/** Within bound this long after level A before the process takes slots again (RFC-006 §6.3, the database node's rule). */
const OFFSET_REJOIN_MS = 10 * 60_000;

/** The lowest of these positions; null when any is unknown (read from the start). */
function minTs(xs: Array<HlcTs | undefined>): HlcTs | null {
  let m: HlcTs | null = null;
  for (const x of xs) {
    if (x === undefined) return null;
    if (m === null || compareHlc(x, m) < 0) m = x;
  }
  return m;
}

export class CockroachOwnerRuntime implements OwnerRuntime {
  private readonly o: OwnerRuntimeOptions;
  private readonly wallMs: WallClock;
  private readonly decl: OwnerDeclaration;
  private readonly store: OwnerStore;
  private readonly publisher: Publisher;
  private readonly sealer: Sealer;
  private readonly load: LoadMonitor;
  private session: Session;
  /** Slot groups (RFC-006 §7.1): the other runtimes of this process's group (leader), or the leader (member). */
  private groupMembers: CockroachOwnerRuntime[] = [];
  private groupLeader: CockroachOwnerRuntime | undefined;
  private readonly lanes = new Map<SlotNo, Lane>();
  private readonly generations = new Map<string, Generation>();
  /** C01 §3.3: partitions placed in a slot other than their home slot (a prepared or adopted move). */
  private readonly placed = new Map<string, SlotNo>();
  /** Moves this process prepared as the target (step 2) and not yet adopted. */
  private readonly prepared = new Map<string, { partition: PartitionKey; from: SlotNo; to: SlotNo; generation: Generation; seq: Seq }>();
  /** Fences pushed to this process (step 4), by `${kind}|${slot}`, and the adopts that wait for one. */
  private readonly fencesIn = new Map<string, HlcTs>();
  private readonly fenceWaiters = new Set<() => void>();
  /** Counts of the fence checks of step 5: by push, and by bounded reads of owner_slot. */
  readonly moveStats = { fencesPushed: 0, fencesRead: 0 };
  /** The account map version this process applied for the splitting rules (C01 §3.8). */
  private appliedMap: SlotMapVersion | undefined;
  private readonly fences = new Map<string, WriterFence>();
  private readonly timers = new Map<string, { partition: PartitionKey; timeout: NodeJS.Timeout }>();
  private readonly reportHandlers: Array<(slot: SlotNo, p: HlcTs) => void> = [];
  private hooks: OwnerHooks | undefined;
  private lastTiming: TimingRow = { version: 0n, epsilonMs: PARAMS.epsilonMs, deltaXMs: 320, tauMs: 420 };
  private control: Promise<void> = Promise.resolve();
  private started = false;
  private readonly consumer: FeedConsumerRuntime | undefined;
  private readonly readers = new Map<string, ReaderChannel>();
  private readonly standbys = new Map<string, StandbyChannel>();
  private readonly standbyTail: StandbyTail | undefined;
  private standbyTimer: NodeJS.Timeout | undefined;
  private tailBusy = false;
  private offset: OffsetMonitor | undefined;
  /** False from offset level A (RFC-006 §6.2): the process takes no new slot. */
  private takingSlots = true;
  private gaveUp = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly log: (msg: string, fields?: Record<string, unknown>) => void;
  /** The monotonic clock of overload control and the abandon budget (ms). */
  private readonly monoMs: () => number;
  private readonly random: Random;
  /** RFC-006 §4.7 rule 5 on (default). */
  private readonly rule5: boolean;
  /** `Overloaded` answers above shed_answer_burst, delivered together at the next 100 ms tick (§4.7 rule 5a). */
  private deferredSheds: Array<{ tick: number; deliver: () => void }> = [];

  constructor(o: OwnerRuntimeOptions) {
    assertDeclaration(o.declaration);
    const emitErrors = emitFunctionErrors(o.declaration, o.emitFns);
    if (emitErrors.length > 0) throw new SelfOutboxedError('INVALID_DECLARATION', `invalid self-outboxed kind ${o.declaration.kind}:\n  ${emitErrors.join('\n  ')}`, emitErrors);
    this.o = o;
    this.wallMs = o.wallMs ?? systemClock;
    this.decl = o.declaration;
    this.store = o.store;
    this.publisher = o.publisher ?? new MemoryPublisher();
    this.sealer = o.sealer ?? new DevSealer();
    this.load = o.load ?? new EventLoopMonitor();
    this.log = o.log ?? noop;
    this.monoMs = o.testing?.batchNowMs ?? (() => performance.now());
    this.random = o.testing?.random ?? Math.random;
    this.rule5 = o.testing?.overloadControl !== false;
    const timings = { ...DEFAULT_SESSION_TIMINGS, ...o.testing?.sessionTimings };
    this.session = new Session(this.store, timings,
      { host: o.host ?? hostname(), region: o.region ?? 'r1', facility: o.facility ?? 'r1a', kind: this.decl.kind },
      {
        onRevoked: () => { const revoked = this.session.sessionId; return this.serialised(() => this.rehome(revoked)); },
        onResume: () => this.serialised(() => this.resume()),
        onTick: () => this.serialised(async () => { await this.refreshTiming(); await this.acquireWanted(); }),
      });
    if (o.standby) {
      const apply = o.standby.apply;
      // The platform's own entries (moved, adopt) are not the owner's: the owner's memory never sees them.
      this.standbyTail = new StandbyTail((rows) => apply(rows.filter((r) => !isPlatformEntry(r.kind)).map((r) => openLogRow(this.decl, this.sealer, r))));
    }
    if (o.slotGroup) {
      for (const m of o.slotGroup.members) {
        const md = m.decl;
        if (!m.o.slotGroupMember) throw new SlotGroupError('GROUP_MEMBER_FLAG', `slot group member ${md.kind} needs slotGroupMember: true`);
        if (md.slotCount !== this.decl.slotCount) throw new SlotGroupError('GROUP_SLOT_COUNT', `slot group ${this.decl.kind}+${md.kind}: slot counts differ`);
        if (md.slotGroupWith !== this.decl.kind && this.decl.slotGroupWith !== md.kind) {
          throw new SlotGroupError('GROUP_PARTNER', `slot group ${this.decl.kind}+${md.kind}: neither declaration names the other in slotGroupWith`);
        }
        m.session = this.session;
        m.groupLeader = this;
      }
      this.groupMembers = [...o.slotGroup.members];
    }
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
    if (this.o.slotGroupMember) {
      // The group's leader opens the shared session and takes this kind's slots (RFC-006 §7.1).
      this.started = true;
      this.startHeartbeat();
      return;
    }
    for (const m of this.groupMembers) if (!m.started) throw new SlotGroupError('GROUP_START_ORDER', `start slot group member ${m.decl.kind} before its leader ${this.decl.kind}`);
    await this.store.warm?.();
    await this.session.open();
    this.started = true;
    if (this.standbyTail) await this.tailStandby();
    if (this.o.slotMap && this.decl.kind === 'account') {
      const cur = this.o.slotMap.current();
      if (cur) this.applyMap(cur);
      this.o.slotMap.onVersion((v) => this.applyMap(v));
    }
    await this.serialised(() => this.acquireWanted());
    this.session.start();
    this.startHeartbeat();
    if (this.o.offsetCheck && this.store.clusterTime) {
      const store = this.store;
      const clusterTime = store.clusterTime as () => Promise<HlcTs>;
      const onSample = this.o.offsetCheck.onSample;
      this.offset = new OffsetMonitor({ dbTime: () => clusterTime.call(store), wallMs: this.wallMs, onLevel: (level, sample) => this.onOffsetLevel(level, sample),
        ...(onSample ? { onSample } : {}) });
      this.offset.start(this.o.offsetCheck.intervalMs);
    }
    if (this.standbyTail) {
      // RFC-006 §4.4: every standby_poll (250 ms), the follower-read tail and the present-time session poll.
      this.standbyTimer = setInterval(() => {
        this.tailStandby().catch((e: unknown) => this.log('standby tail failed', { error: String(e) }));
        this.serialised(() => this.acquireWanted()).catch(() => { /* serialised() logged it */ });
      }, this.o.standby?.pollMs ?? 250);
      this.standbyTimer.unref();
    }
  }

  /** The follower-read tail of a standby, for the slots it does not hold. */
  private async tailStandby(): Promise<void> {
    const t = this.standbyTail;
    if (!t || this.tailBusy || !this.store.tailLog) return;
    const slots = this.o.slots.filter((s) => !this.lanes.has(s));
    if (slots.length === 0) return;
    this.tailBusy = true;
    try {
      const after = minTs(slots.map((s) => t.completeThrough(s)));
      const { rows, through } = await this.store.tailLog(this.decl.kind, slots, after, 'follower');
      t.tail(slots, rows, through);
    } finally {
      this.tailBusy = false;
    }
  }

  /** The push channel of this standby, to give to its holder (`attachStandby`). */
  standbyChannel(): StandbyChannel {
    return { push: (p) => { if (p.kind === this.decl.kind && !this.lanes.has(p.slot)) this.standbyTail?.push(p); } };
  }

  /** The standby's counts (pushed, tailed and catch-up rows). */
  standbyStats(): StandbyStats | undefined {
    return this.standbyTail?.stats;
  }

  /** Holder side: push every Committed batch to this standby (RFC-006 §4.4). */
  attachStandby(id: string, channel: StandbyChannel): void {
    this.standbys.set(id, channel);
  }

  detachStandby(id: string): void {
    this.standbys.delete(id);
  }

  private startHeartbeat(): void {
    // C01 §3.4: push to readers and advance the report position every heartbeat_interval (100 ms).
    this.heartbeat = setInterval(() => {
      for (const l of this.lanes.values()) this.advanceSoon(l);
      this.flushSheds(this.monoMs());
    }, REPORT.heartbeatMs);
    this.heartbeat.unref();
  }

  /** The runtimes whose slots this process takes together: itself and its slot-group members. */
  private group(): CockroachOwnerRuntime[] {
    return [this, ...this.groupMembers];
  }

  /** The group's name in `owner_slot.slot_group`. */
  private groupName(slot: SlotNo): string {
    return `${this.group().map((r) => r.decl.kind).sort().join('+')}:${slot}`;
  }

  /** The consumer runtime of this process (undefined without `feeds`). */
  feedConsumer(): FeedConsumerRuntime | undefined {
    return this.consumer;
  }

  /** Drain lanes, release slots (onRelease 'shutdown'), stop renewals. */
  async stop(): Promise<void> {
    if (this.o.slotGroupMember) {
      if (this.localStopped) return;
      // The leader releases this kind's slots with its own (one session for the group).
      if (this.heartbeat) clearInterval(this.heartbeat);
      await this.consumer?.stop();
      if (this.groupLeader && !this.groupLeader.stopping) await this.groupLeader.stop();
      await this.stopLocal();
      return;
    }
    this.stopping = true;
    this.offset?.stop();
    if (this.standbyTimer) clearInterval(this.standbyTimer);
    this.session.stop();
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.consumer?.stop();
    await this.serialised(async () => {
      for (const r of this.group()) {
        await r.waitIdle([...r.lanes.values()]);
        const held = [...r.lanes.values()].map((l) => ({ slot: l.holding.slot, epoch: l.holding.epoch }));
        try { await r.store.release(r.decl.kind, held, this.session.sessionId); } catch (e) { this.log('release failed', { e: String(e) }); }
        for (const h of held) r.loseSlot(h.slot, 'shutdown');
      }
    });
    for (const m of this.groupMembers) await m.stop();
    await this.stopLocal();
  }

  private stopping = false;
  private localStopped = false;

  private async stopLocal(): Promise<void> {
    if (this.localStopped) return;
    this.localStopped = true;
    for (const t of this.timers.values()) clearTimeout(t.timeout);
    this.timers.clear();
    this.flushSheds(Infinity);
    this.load.stop();
    await this.publisher.close();
  }

  /** True while the holder's view of its session lasts (C01 §3.1), whatever the state of each slot. */
  sessionViewLive(): boolean {
    return this.session.leaseLive();
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
    return this.enqueue(call, opts, undefined);
  }

  /**
   * The slot of a partition in this process (C01 §3.3, §3.8): the slot the command was routed to (`opts.slot`), else a
   * move this process prepared or adopted, else the account slot map (a splitting upper half: s + n when this process
   * holds it, V59-2), else the home slot on the kind's fixed map.
   */
  slotFor(partition: PartitionKey, routed?: SlotNo): SlotNo {
    if (routed !== undefined) return routed;
    const placed = this.placed.get(hex(partition));
    if (placed !== undefined) return placed;
    const v = this.appliedMap;
    if (v) {
      const a = slotOfInMap(v, partition);
      if (a.headDecides) {
        const upper = a.slot + (v.previousCount ?? v.slotCount);
        return this.lanes.has(upper) && !this.lanes.has(a.slot) ? upper : a.slot;
      }
      return a.slot;
    }
    return slotOfPartition(partition, this.decl.slotCount);
  }

  private enqueue(call: AppendCall, opts: AppendOptions, platform: PlatformOp | undefined, slotOverride?: SlotNo): Promise<AppendResult> {
    const slot = slotOverride ?? this.slotFor(call.partition, opts.slot);
    const lane = this.lanes.get(slot);
    // Precondition (C01 §3.2): the caller holds the slot; a slot not held by this process is lost to it.
    if (!lane || lane.released) return Promise.resolve({ r: 'StaleEpoch' });
    if (this.load.shedding()) return Promise.resolve({ r: 'Overloaded', retryAfterMs: PARAMS.overloadedRetryAfterMs });
    // RFC-006 §4.7 rule 5a: the admission check is the first step, before any queueing. The move protocol's calls
    // and exclusive calls are not shed (R77-20). slot_queue_max is the memory backstop (R77-11).
    const now = this.monoMs();
    this.flushSheds(now);
    const exempt = platform !== undefined || opts.exclusive === true;
    if (!exempt && ((this.rule5 && lane.admission.overloaded) || lane.queue.length >= PARAMS.slotQueueMax)) return this.shed(lane, now);
    return new Promise<AppendResult>((resolve, reject) => {
      const q: Queued = { call, opts, ...(platform ? { platform } : {}), enqueuedAt: now, entries: entriesOf(call), resolve, reject };
      if (this.rule5 && platform !== undefined) {
        // `moved` and `adopt` go to the head of the queue, after the move calls already there (§4.3, §4.7 rule 5a).
        const at = lane.queue.findIndex((x) => x.platform === undefined);
        lane.queue.splice(at < 0 ? lane.queue.length : at, 0, q);
      } else {
        lane.queue.push(q);
      }
      lane.queuedEntries += q.entries;
      lane.admission.admitted += 1;
      this.pump(lane);
    });
  }

  /** An `Overloaded(retryAfterMs)` answer of rule 5a: at once, or at the next 100 ms tick above shed_answer_burst. */
  private shed(lane: Lane, now: number): Promise<AppendResult> {
    const cost = lane.cost[0];
    const r: AppendResult = { r: 'Overloaded', retryAfterMs: lane.admission.retryAfterMs(lane.queuedEntries, (q) => cost.expectedDrainMs(q, now)) };
    if (lane.admission.answerNow(now)) return Promise.resolve(r);
    const tick = Math.floor(now / OVERLOAD.shedTickMs);
    return new Promise<AppendResult>((resolve) => { this.deferredSheds.push({ tick, deliver: () => resolve(r) }); });
  }

  /** Delivers the deferred `Overloaded` answers of every earlier tick, together. */
  private flushSheds(now: number): void {
    if (this.deferredSheds.length === 0) return;
    const tick = Math.floor(now / OVERLOAD.shedTickMs);
    const due = this.deferredSheds.filter((d) => d.tick < tick);
    if (due.length === 0) return;
    this.deferredSheds = this.deferredSheds.filter((d) => d.tick >= tick);
    for (const d of due) d.deliver();
  }

  /** Rule 5a "Expected sojourn" of the slot's queue now. */
  private expectedSojourn(lane: Lane, now: number): number {
    let oldest: number | undefined;
    const drain = lane.cost[0].expectedDrainMs(lane.queuedEntries, now);
    if (drain === undefined) for (const q of lane.queue) if (oldest === undefined || q.enqueuedAt < oldest) oldest = q.enqueuedAt;
    return expectedSojournMs(drain, oldest, now);
  }

  /** Rule 5a release test at a batch end. */
  private batchEnd(lane: Lane): void {
    if (this.rule5) { const now = this.monoMs(); lane.admission.release(this.expectedSojourn(lane, now), now); }
  }

  /** RFC-006 §4.7 rule 5 counters of one held slot; undefined for a slot not held. */
  overloadStats(slot: SlotNo): OverloadStats | undefined {
    const lane = this.lanes.get(slot);
    if (!lane) return undefined;
    const now = this.monoMs();
    const a = lane.admission;
    return {
      state: a.state, overloadedSinceMs: a.overloadedSinceMs, stateChanges: a.stateChanges, lastChangeMs: a.lastChangeMs,
      shedAtOnce: a.shedAtOnce, shedDeferred: a.shedDeferred, admitted: a.admitted,
      lastSojournMs: a.lastSojournMs, expectedSojournMs: this.expectedSojourn(lane, now),
      abandons: lane.abandons, freshAfterAbandon: lane.freshAfterAbandon,
      lanes: lane.cost.map((c) => ({ fHatMs: c.fHatMs(now), cHatMs: c.cHatMs(now), nCap: c.nCap(now), samples: c.sampleCount(now),
        regimeResets: c.regimeResets, probeTakes: c.probeTakes })),
    };
  }

  private pump(lane: Lane): void {
    if (lane.gate || lane.released) return;
    if (!lane.running && !lane.secondRunning && lane.markerWanted && this.session.leaseLive()) {
      lane.markerWanted = false;
      lane.running = true;
      this.runMarker(lane).finally(() => {
        lane.running = false;
        this.pump(lane);
      }).catch((e: unknown) => this.log('marker step failed', { slot: lane.holding.slot, error: String(e) }));
      return;
    }
    if (lane.queue.length === 0) return;
    if (!this.session.leaseLive()) {
      // From the end of the holder's view the holder proposes nothing (C01 §3.1).
      if (!lane.running && !lane.secondRunning) setTimeout(() => this.pump(lane), 50).unref();
      return;
    }
    if (!lane.running) this.startBatch(lane, 'primary', this.take(lane, 'primary'));
    // C01 §3.2 (R47-31): a second batch only while the first is in flight, only of partitions not in it.
    const mode = this.secondLaneMode();
    if (mode && lane.running && !lane.secondRunning) this.startBatch(lane, 'second', this.take(lane, 'second', mode));
  }

  /**
   * The second lane of this kind as `platform_timing.second_lane` sets it (RFC-006 §4.3, §6.4): 'account' carries
   * any call, 'deadline' only calls with `lane: 'second'`. Lane (c), a second batch of the same partition, does
   * not exist (C01 v1): a partition in one lane's batch never goes in the other's.
   */
  private secondLaneMode(): 'account' | 'deadline' | undefined {
    return this.secondLaneOf();
  }

  /**
   * Re-reads `platform_timing` (shard 0) on each renewal tick, so a lane that placement turns on in a new version
   * is used within one tick (C01 §2.3; RFC-006 §4.3 "turning it on needs no release"). A batch still reads its own
   * shard's row in the transaction for τ (C01 §8).
   */
  private async refreshTiming(): Promise<void> {
    try {
      const t = await this.store.readTiming(0);
      if (t.version >= this.lastTiming.version) this.lastTiming = t;
    } catch (e) { this.log('timing read failed', { error: String(e) }); }
    for (const m of this.groupMembers) await m.refreshTiming();
  }

  private secondLaneOf(): 'account' | 'deadline' | undefined {
    const s = this.lastTiming.secondLane?.[this.decl.kind];
    return s?.account === true ? 'account' : s?.deadline === true ? 'deadline' : undefined;
  }

  private startBatch(lane: Lane, which: 'primary' | 'second', calls: Queued[]): void {
    if (calls.length === 0) return;
    const flight = new Set(calls.map((q) => hex(q.call.partition)));
    if (which === 'primary') { lane.running = true; lane.inFlight[0] = flight; } else { lane.secondRunning = true; lane.inFlight[1] = flight; }
    this.batchesStarted.push({ slot: lane.holding.slot, lane: which, partitions: [...flight], otherInFlight: [...lane.inFlight[which === 'primary' ? 1 : 0]] });
    this.runBatch(lane, calls, which).finally(() => {
      if (which === 'primary') { lane.running = false; lane.inFlight[0] = new Set(); } else { lane.secondRunning = false; lane.inFlight[1] = new Set(); }
      this.pump(lane);
    }).catch((e: unknown) => this.log('batch step failed', { slot: lane.holding.slot, error: String(e) }));
  }

  /** Every fresh attempt after an abandon and the calls it carried (RFC-006 §4.7 rule 5c; DT-50 (3)). */
  readonly freshAttempts: Array<{ slot: SlotNo; calls: number }> = [];

  /** Every batch started, with the other lane's in-flight partitions at that moment (tests check R47-31). */
  readonly batchesStarted: Array<{ slot: SlotNo; lane: 'primary' | 'second'; partitions: string[]; otherInFlight: string[] }> = [];

  /**
   * One batch: pending calls in queue order up to the size limits; an exclusive call alone, on the first lane
   * only (C01 §3.2). A call of a partition in the other lane's batch is skipped, and so is every later call of
   * that partition, so each partition keeps its order and has at most one transaction in flight.
   */
  private take(lane: Lane, which: 'primary' | 'second', mode?: 'account' | 'deadline'): Queued[] {
    const skip = new Set(lane.inFlight[which === 'primary' ? 1 : 0]);
    const out: Queued[] = [];
    const rest: Queued[] = [];
    let entries = 0;
    let bytes = 0;
    let closed = false;
    // RFC-006 §4.7 rule 5b: at most n_cap entries (the probe now and then); a call with a lower abandon budget sizes
    // the batch with one fifth of it. Never fewer than 1 call (the floor), never a split call.
    const now = this.monoMs();
    const cost = lane.cost[which === 'primary' ? 0 : 1];
    const defaultBudget = this.o.testing?.abandonBeforeCommitMs ?? PARAMS.abandonBeforeCommitMs;
    let cap = this.rule5 ? cost.takeCap(now) : PARAMS.slotBatchMaxEntries;
    let capBound = false;
    for (const q of lane.queue) {
      const k = hex(q.call.partition);
      const special = q.opts.exclusive === true || q.opts.firstStatement !== undefined;
      const eligible = which === 'primary' || (!special && (mode === 'account' || q.opts.lane === 'second'));
      if (closed || skip.has(k) || !eligible) { rest.push(q); skip.add(k); continue; }
      if (special) {
        if (out.length === 0) { out.push(q); closed = true; } else { rest.push(q); skip.add(k); closed = true; }
        continue;
      }
      const n = q.entries;
      const b = q.call.entries ? encodeJson(q.call.entries.map((e) => e.payload)).byteLength : 0;
      const budget = q.opts.abandonBeforeCommitMs;
      const qCap = this.rule5 && budget !== undefined && budget < defaultBudget ? Math.min(cap, cost.nCap(now, budget / OVERLOAD.lowBudgetDivisor)) : cap;
      if (out.length > 0 && (entries + n > Math.min(PARAMS.slotBatchMaxEntries, qCap) || bytes + b > PARAMS.slotBatchMaxBytes)) {
        rest.push(q); closed = true; capBound = true; continue;
      }
      cap = qCap;
      entries += n; bytes += b;
      out.push(q);
    }
    lane.queue = rest;
    lane.queuedEntries = rest.reduce((a, q) => a + q.entries, 0);
    if (this.rule5 && out.length > 0) {
      cost.noteTake(capBound);
      // Rule 5a: the sojourn sample of this take (the youngest call taken; 0 when the take empties the queue), then
      // the release test, but not at the take that entered.
      const youngest = Math.max(...out.map((q) => q.enqueuedAt));
      if (!lane.admission.sample(now, rest.length === 0 ? 0 : now - youngest)) lane.admission.release(this.expectedSojourn(lane, now), now);
    }
    return out;
  }

  private async execute(lane: Lane, calls: Queued[], fresh: boolean): Promise<BatchOutcome> {
    try {
      return await executeBatch(this.store, { decl: this.decl, sealer: this.sealer, holding: lane.holding, onDecide: this.o.testing?.onDecide, ...(this.o.emitFns ? { emitFns: this.o.emitFns } : {}) }, calls, {
        batchRetries: PARAMS.batchRetries,
        abandonBeforeCommitMs: this.defaultAbandonMs(),
        commitBackstopMs: this.o.testing?.commitBackstopMs ?? PARAMS.commitBackstopMs,
        nowMs: this.monoMs,
        abandonToCaller: this.rule5,
        freshAttempt: fresh,
      });
    } catch (e) {
      return { kind: 'failed', error: e instanceof Error ? e : new Error(String(e)) };
    }
  }

  private defaultAbandonMs(): number {
    return this.o.testing?.abandonBeforeCommitMs ?? PARAMS.abandonBeforeCommitMs;
  }

  /** The batch carries a call with a lower abandon budget than the default (RFC-001's 250 ms). */
  private loweredBudget(calls: Queued[]): boolean {
    const d = this.defaultAbandonMs();
    return calls.some((q) => q.opts.abandonBeforeCommitMs !== undefined && q.opts.abandonBeforeCommitMs < d);
  }

  /**
   * RFC-006 §4.7 rule 5b: a batch that reached the COMMIT answer is a sample of its lane, except a batch with an
   * `exclusive` call or a lower abandon budget, a batch that had a per-tier timeout, and a second-lane deadline batch.
   * An abandon at the default budget with no per-tier timeout is a censored sample.
   */
  private observe(lane: Lane, which: 'primary' | 'second', calls: Queued[], outcome: BatchOutcome): void {
    if (!this.rule5) return;
    if (outcome.kind !== 'answered' && !(outcome.kind === 'retry' && outcome.abandoned) && outcome.kind !== 'abandoned') return;
    if ((outcome.kind === 'answered' || outcome.kind === 'retry') && outcome.tierRetried) return;
    if (calls.some((q) => q.opts.exclusive === true) || this.loweredBudget(calls)) return;
    if (which === 'second' && this.secondLaneMode() === 'deadline') return;
    const n = calls.reduce((a, q) => a + q.entries, 0);
    const cost = lane.cost[which === 'primary' ? 0 : 1];
    if (outcome.kind === 'answered') {
      if (outcome.committedMs !== undefined) cost.observe(n, outcome.committedMs, this.monoMs());
    } else {
      cost.censored(n, this.defaultAbandonMs(), this.monoMs());
    }
  }

  private async runBatch(lane: Lane, first: Queued[], which: 'primary' | 'second' = 'primary'): Promise<void> {
    let calls = first;
    let outcome = await this.execute(lane, calls, false);
    if (outcome.kind === 'abandoned') {
      // RFC-006 §4.7 rule 5c (C01 v1): (1) the censored sample updates ĉ; (2) one fresh attempt with only the first
      // n_cap calls, the others back at the head of the queue in their order with their enqueue times; (3) then answers.
      lane.abandons += 1;
      this.observe(lane, which, calls, outcome);
      if (!this.loweredBudget(calls)) {
        const cap = lane.cost[which === 'primary' ? 0 : 1].nCap(this.monoMs());
        let entries = 0;
        let k = 0;
        while (k < calls.length && (k === 0 || entries + (calls[k] as Queued).entries <= cap)) { entries += (calls[k] as Queued).entries; k += 1; }
        const back = calls.slice(k);
        calls = calls.slice(0, k);
        lane.queue.unshift(...back);
        lane.queuedEntries += back.reduce((a, q) => a + q.entries, 0);
        lane.inFlight[which === 'primary' ? 0 : 1] = new Set(calls.map((q) => hex(q.call.partition)));
      }
      lane.freshAfterAbandon += 1;
      this.freshAttempts.push({ slot: lane.holding.slot, calls: calls.length });
      outcome = await this.execute(lane, calls, true);
    }
    if (outcome.kind === 'retry' && outcome.abandoned) lane.abandons += 1;
    this.observe(lane, which, calls, outcome);
    this.reportIntegrity(lane);
    // Rule 5a's release test at the batch end, before any answer of this step (§4.7 rule 5c order).
    this.batchEnd(lane);
    switch (outcome.kind) {
      case 'abandoned':
        // Not reached: a fresh attempt never hands its abandon back.
        for (const q of calls) q.resolve({ r: 'Retry' });
        return;
      case 'answered':
        this.lastTiming = outcome.plan.timing;
        this.applyCommitted(lane, outcome.plan, which === 'primary' ? lane.secondRunning : lane.running);
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
        lane.unresolved += 1;
        // Not awaited here: a re-home inside the resolution waits for this batch to finish.
        lane.gate = this.serialised(() => this.resolveAmbiguous(lane, plan)).finally(() => {
          lane.gate = null;
          this.pump(lane);
        }).catch(() => { /* serialised() logged the failure; the gate opens */ });
        return;
      }
    }
  }

  private applyCommitted(lane: Lane, plan: AttemptPlan, otherLaneBusy = false): void {
    for (const h of plan.writes.heads) {
      lane.holding.chains.set(hex(h.partition), h.chain);
      this.generations.set(hex(h.partition), h.generation);
    }
    for (const m of plan.moves) {
      if (m.op === 'moved') {
        // C01 §3.3 step 3: from this commit A answers MOVING for X; the owner cancels X's timers and decides nothing.
        this.cancelTimersOf(m.partition);
        // Step 4: kinds with markers owe B the report fence; kinds without status readers skip it.
        if (reportsMarkers(this.decl)) lane.pendingFences.push({ to: m.to, ts: plan.ts });
        for (const [id, ch] of this.readers) {
          try { ch.movedOut?.(lane.holding.slot, m.partition, plan.ts); } catch (e) { this.log('reader moved push failed', { reader: id, error: String(e) }); }
        }
        try { this.hooks?.onMovedOut(m.partition); } catch (e) { this.log('onMovedOut failed', { error: String(e) }); }
      } else {
        // C01 §3.3 step 6 (R47-16): no report of an entry of X until read_lease + ε after the adopt commit.
        const waitMs = this.o.testing?.adoptReportWaitMs ?? REPORT.postAcquisitionWaitMs;
        lane.report.holds.push({ cap: hlcBefore(plan.ts), untilMonotonic: this.reportNow() + BigInt(Math.round(waitMs * 1e6)) });
        this.placed.set(hex(m.partition), lane.holding.slot);
        for (const [id, ch] of this.readers) {
          try { ch.adopted?.(lane.holding.slot, m.partition, plan.ts); } catch (e) { this.log('reader adopt push failed', { reader: id, error: String(e) }); }
        }
      }
    }
    for (const f of plan.senderFences) this.recordFence(f, f);
    this.directPublish(plan.publish);
    // RFC-006 §4.4: a push advances the standby's complete position only when no other batch of the slot can be
    // committed below its ts and not pushed yet: none in flight on the other lane, none Ambiguous and unresolved.
    this.pushToStandbys(lane, plan, !otherLaneBusy && lane.unresolved === 0);
    const r = lane.report;
    if (compareHlc(plan.ts, r.committedThrough) > 0) r.committedThrough = plan.ts;
    for (const d of plan.reportDue) r.due.push({ ts: plan.ts, ...(d.pending ? { pending: d.pending } : {}) });
    this.advanceSoon(lane);
  }

  /** RFC-006 §4.4: push the batch to the hot standbys without waiting for an answer. */
  private pushToStandbys(lane: Lane, plan: AttemptPlan, advances: boolean): void {
    if (plan.writes.log.length === 0 || this.standbys.size === 0) {
      if (compareHlc(plan.ts, lane.pushedThrough) > 0 && plan.writes.log.length > 0) lane.pushedThrough = plan.ts;
      return;
    }
    const push: StandbyPush = { kind: this.decl.kind, slot: lane.holding.slot, epoch: lane.holding.epoch, ts: plan.ts,
      prevTs: lane.pushedThrough, advances, rows: plan.writes.log };
    if (compareHlc(plan.ts, lane.pushedThrough) > 0) lane.pushedThrough = plan.ts;
    for (const [id, ch] of this.standbys) {
      try { ch.push(push); } catch (e) { this.log('standby push failed', { standby: id, error: String(e) }); }
    }
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
    let read: ResolutionRead;
    const sessionId = this.session.sessionId;
    try {
      read = await this.retryUntilAnswered(() => this.store.resolutionRead(
        this.decl.kind, this.session.shard, sessionId, [lane.holding.slot], plan.partitions));
    } finally {
      lane.unresolved -= 1;
    }
    const committed = [...read.heads.values()].some((h) => bytesEqual(h.batchId, plan.batchId));
    this.log('Ambiguous resolved', { slot: lane.holding.slot, committed, tRes: read.tRes });
    // The gate stops new batches, but a batch of the other lane can still be in flight (C01 §3.2).
    if (committed) this.applyCommitted(lane, plan, lane.running || lane.secondRunning);
    else for (const p of plan.partitions) lane.holding.chains.delete(hex(p));
    const row = read.slots.get(lane.holding.slot);
    if (!row || row.epoch !== lane.holding.epoch || row.sessionId !== this.session.sessionId) {
      this.loseSlot(lane.holding.slot, 'staleEpoch');
      return;
    }
    if (read.sessionRevoked) { await this.rehome(sessionId); return; }
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
      holding: { slot, epoch, sessionId: this.session.sessionId, stopsVersion: null, stops: new Map(), chains: new Map(), integrityHolds: new Map(),
        creationSlot: (p) => this.creationSlot(p) },
      queue: [], running: false, secondRunning: false, inFlight: [new Set(), new Set()], gate: null, released: false,
      report: new SlotReport(initial), markerWanted: false, reportableTimer: undefined, pushedThrough: initial, unresolved: 0,
      pendingFences: [],
      admission: new SlotAdmission(this.random), cost: [new LaneCostModel(), new LaneCostModel()], queuedEntries: 0,
      abandons: 0, freshAfterAbandon: 0,
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
      this.advanceSoon(lane);
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

  /** The monotonic time of the report position (C01 §3.3 step 6, §3.4). */
  private reportNow(): MonotonicNs {
    return this.o.testing?.reportMonotonic?.() ?? process.hrtime.bigint();
  }

  /** advance() without waiting for it: a failure is logged, and the next heartbeat tries again (C01 §3.4). */
  private advanceSoon(lane: Lane): void {
    this.advance(lane).catch((e: unknown) => this.log('report advance failed', { slot: lane.holding.slot, error: String(e) }));
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
    const p = r.target(this.reportNow());
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
        this.pushFences(lane, prev);
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
      this.pushFences(lane, P);
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
    if (!this.takingSlots && this.resumeTakingAt !== undefined && this.wallMs() >= this.resumeTakingAt) this.takingSlots = true;
    // Level A: a hand-off that failed is tried again on each tick while the bound stays above 40 ms (RFC-006 §6.2).
    if (this.started && !this.gaveUp && this.offset?.currentLevel() === 'A' && this.group().some((r) => r.lanes.size > 0)) { await this.handOffAll(); return; }
    if (!this.started || !this.takingSlots || this.gaveUp) return;
    if (this.groupMembers.length > 0) { await this.acquireWantedGroup(); return; }
    const wanted = this.o.slots.filter((s) => !this.lanes.has(s));
    if (wanted.length === 0) return;
    const rows = await this.store.listSlots(this.decl.kind, wanted);
    const acquired: Array<{ slot: SlotNo; epoch: Epoch }> = [];
    const byOld = new Map<string, SlotNo[]>();
    for (const r of rows) {
      if (r.sessionId === null) {
        // A standby takes the slots of its holder's expired session (RFC-006 §4.7 rule 1) and the slots its holder
        // handed off or released (epoch above 0, RFC-006 §6.2 level A). It never takes a slot nobody has held yet.
        if (this.standbyTail && r.epoch === 0n) continue;
        const a = await this.store.acquireFree(this.decl.kind, r.slot, this.session.sessionId);
        if (a) acquired.push(a);
      } else if (r.sessionId === this.session.sessionId) {
        // An acquisition whose answer was lost (a gateway tier timed out) but which committed: the slot is ours.
        acquired.push({ slot: r.slot, epoch: r.epoch });
      } else if (r.sessionExpired || r.sessionRevoked) {
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
    const t = this.standbyTail;
    if (t && this.store.tailLog) {
      // RFC-006 §4.4: a taking-over standby reads, at the present time, only the rows above its tail.
      const slots = acquired.map((a) => a.slot);
      const tail = this.store.tailLog;
      const { rows: fresh, through } = await this.retryUntilAnswered(() => tail.call(this.store, this.decl.kind, slots, minTs(slots.map((s) => t.completeThrough(s))), 'present'));
      t.tail(slots, fresh, through, true);
      this.log('standby catch-up', { slots, rowsRead: fresh.length, catchUpRows: t.stats.catchUpRows });
    }
    for (const a of acquired) this.newLane(a.slot, a.epoch, catchUp.tRes);
    for (const a of acquired) await this.findPendingMoves(a.slot);
    for (const a of acquired) {
      this.log('acquired', { slot: a.slot, epoch: a.epoch.toString(), catchUp: catchUp.tRes });
      try { await this.rebuildFences(a.slot); } catch (e) { this.log('fence rebuild failed', { slot: a.slot, error: String(e) }); }
      await this.hooks?.onAcquire(a.slot, a.epoch, 'expiry');
      const lane = this.lanes.get(a.slot);
      if (lane) { this.startReporting(lane, catchUp.tRes, true); this.pump(lane); }
    }
  }

  /** Re-home (C01 §3.1): new session, conditional transfer of each slot at its own epoch, steps 1–4, onAcquire('rehome'). */
  private async rehome(revoked?: string): Promise<void> {
    // One re-home per revoked session: the renewal and a resolution read can both report the same revocation.
    if (revoked !== undefined && revoked !== this.session.sessionId) return;
    if (this.groupLeader) { const l = this.groupLeader; await l.serialised(() => l.rehome(revoked)); return; }
    if (this.groupMembers.length > 0) { await this.rehomeGroup(); return; }
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
    if (this.groupMembers.length > 0) { await this.resumeGroup(); return; }
    const lanes = [...this.lanes.values()];
    await this.waitIdle(lanes);
    const sessionId = this.session.sessionId;
    const read = await this.retryUntilAnswered(() => this.store.resolutionRead(
      this.decl.kind, this.session.shard, sessionId, lanes.map((l) => l.holding.slot), []));
    for (const l of lanes) {
      const row = read.slots.get(l.holding.slot);
      if (!row || row.epoch !== l.holding.epoch || row.sessionId !== this.session.sessionId) this.loseSlot(l.holding.slot, 'taken');
    }
    if (read.sessionRevoked) { await this.rehome(sessionId); return; }
    // Step 4: report position = T_res, then onReportable without a further wait (C01 §3.1).
    for (const l of lanes) if (!l.released) this.startReporting(l, read.tRes, false);
  }

  // ---------------- owner-host offset ladder (RFC-006 §6.2, §6.3) ----------------

  private onOffsetLevel(level: OffsetLevel, sample: OffsetSample): void {
    this.log('offset level', { level, boundMs: sample.boundMs });
    this.o.offsetCheck?.onLevel?.(level, sample);
    if (level === 'D') { this.serialised(() => this.giveUpSession()).catch(() => {}); return; }
    if (level === 'A') { this.takingSlots = false; this.resumeTakingAt = undefined; this.serialised(() => this.handOffAll()).catch(() => {}); return; }
    // RFC-006 §6.3 gives the database node's rule only (rejoins once within bound for 10 min); the owner host uses it too.
    if (!this.takingSlots) this.resumeTakingAt = this.wallMs() + OFFSET_REJOIN_MS;
  }

  private resumeTakingAt: number | undefined;

  /**
   * Level A: hand every slot off (RFC-006 §6.2). No successor is named here: the slots are freed at their own
   * epoch, so a standby or another process takes them by free-slot acquisition (see STATUS-I2.md). The slots of a
   * group are freed in one transaction (RFC-006 §7.1). When the hand-off fails, the slots stay held and the next
   * renewal tick tries again.
   */
  private async handOffAll(): Promise<void> {
    const group = this.group();
    const all = group.flatMap((r) => [...r.lanes.values()].map((l) => ({ r, l })));
    if (all.length === 0) return;
    let release: () => void = noop;
    const gate = new Promise<void>((res) => { release = res; });
    for (const { l } of all) l.gate ??= gate;     // stop proposing; wait for the batches in flight
    try {
      for (const r of group) await r.waitIdle([...r.lanes.values()]);
      const held = all.map(({ r, l }) => ({ r, kind: r.decl.kind, slot: l.holding.slot, epoch: l.holding.epoch }));
      if (group.length > 1) {
        if (!this.store.releaseGroup) throw new Error('slot groups need a store with releaseGroup');
        await this.store.releaseGroup(held.map(({ kind, slot, epoch }) => ({ kind, slot, epoch })), this.session.sessionId, true);
      } else {
        await this.store.release(this.decl.kind, held.map(({ slot, epoch }) => ({ slot, epoch })), this.session.sessionId, true);
      }
      for (const h of held) h.r.loseSlot(h.slot, 'handedOff');
    } finally {
      for (const { l } of all) if (l.gate === gate) l.gate = null;
      release();
      for (const { r, l } of all) if (!l.released) r.pump(l);
    }
  }

  /** Level D: give up the session at once; stop serving every slot; the supervisor restarts the process (RFC-006 §4.4). */
  private async giveUpSession(): Promise<void> {
    this.gaveUp = true;
    this.session.stop();
    if (this.standbyTimer) clearInterval(this.standbyTimer);
    try {
      await this.store.revokeSession?.(this.session.shard, this.session.sessionId);
    } catch (e) { this.log('session give-up write failed; the session expires by itself', { error: String(e) }); }
    for (const r of this.group()) for (const slot of [...r.lanes.keys()]) r.loseSlot(slot, 'shutdown');
    this.o.offsetCheck?.onGiveUp?.();
  }

  // ---------------- slot groups (RFC-006 §4.2, §7.1; C01 §3.1) ----------------

  /** Every slot of a group in one acquisition transaction, or none; then catch-up and onAcquire for each member. */
  private async acquireWantedGroup(): Promise<void> {
    if (!this.store.acquireGroup) throw new Error('slot groups need a store with acquireGroup');
    const group = this.group();
    const wanted = this.o.slots.filter((s) => group.every((r) => !r.lanes.has(s)));
    if (wanted.length === 0) return;
    const rows = new Map<string, import('./store/types.ts').SlotLeaseRow>();
    for (const r of group) for (const x of await r.store.listSlots(r.decl.kind, wanted)) rows.set(`${r.decl.kind}|${x.slot}`, x);
    const taken: Array<{ slot: SlotNo; epochs: Map<CockroachOwnerRuntime, Epoch> }> = [];
    for (const slot of wanted) {
      const members = group.map((r) => rows.get(`${r.decl.kind}|${slot}`));
      if (members.some((m) => m === undefined)) continue;
      const sessions = new Set(members.map((m) => m?.sessionId ?? null));
      let old: { shard: number; sessionId: string } | null;
      if (sessions.size === 1 && sessions.has(null)) old = null;
      else if (sessions.size === 1 && members.every((m) => m && m.sessionId !== this.session.sessionId && (m.sessionExpired || m.sessionRevoked))) {
        const id = members[0]?.sessionId as string;
        old = { shard: sessionShard(id), sessionId: id };
      } else continue;   // held, or members under different sessions: never take part of a group
      const got = await this.store.acquireGroup(group.map((r) => ({ kind: r.decl.kind, slot })), this.session.sessionId, this.groupName(slot), old);
      if (!got) continue;
      const epochs = new Map<CockroachOwnerRuntime, Epoch>();
      for (const r of group) {
        const e = got.find((g) => g.kind === r.decl.kind)?.epoch;
        if (e !== undefined) epochs.set(r, e);
      }
      taken.push({ slot, epochs });
    }
    if (taken.length === 0) return;
    const slots = taken.map((t) => t.slot);
    const catchUp = new Map<CockroachOwnerRuntime, HlcTs>();
    for (const r of group) {
      const read = await this.retryUntilAnswered(() => r.store.resolutionRead(r.decl.kind, this.session.shard, this.session.sessionId, slots, []));
      catchUp.set(r, read.tRes);
    }
    for (const t of taken) for (const [r, e] of t.epochs) r.newLane(t.slot, e, catchUp.get(r) as HlcTs);
    // C01 §2.4: onAcquire once per slot of a group, all before the group serves.
    for (const t of taken) {
      for (const [r, e] of t.epochs) {
        r.log('acquired (slot group)', { slot: t.slot, epoch: e.toString(), group: this.groupName(t.slot) });
        try { await r.rebuildFences(t.slot); } catch (err) { r.log('fence rebuild failed', { slot: t.slot, error: String(err) }); }
        await r.hooks?.onAcquire(t.slot, e, 'expiry');
      }
    }
    for (const t of taken) {
      for (const r of t.epochs.keys()) {
        const lane = r.lanes.get(t.slot);
        if (lane) { r.startReporting(lane, catchUp.get(r) as HlcTs, true); r.pump(lane); }
      }
    }
  }

  /** Re-home of a group's slots: each group in one transaction, every member at its own epoch, or none (C01 §3.1). */
  private async rehomeGroup(): Promise<void> {
    if (!this.store.rehomeGroup) throw new Error('slot groups need a store with rehomeGroup');
    const group = this.group();
    const all = group.flatMap((r) => [...r.lanes.values()].map((l) => ({ r, l })));
    let release: () => void = noop;
    const gate = new Promise<void>((res) => { release = res; });
    for (const { l } of all) l.gate ??= gate;
    try {
      for (const r of group) await r.waitIdle([...r.lanes.values()]);
      const old = this.session.sessionId;
      await this.session.open();
      const kept: SlotNo[] = [];
      for (const slot of [...new Set(all.map((x) => x.l.holding.slot))]) {
        const held = all.filter((x) => x.l.holding.slot === slot).map((x) => ({ kind: x.r.decl.kind, slot, epoch: x.l.holding.epoch }));
        const got = held.length === group.length ? await this.store.rehomeGroup(held, old, this.session.sessionId) : undefined;
        for (const x of all.filter((y) => y.l.holding.slot === slot)) {
          const e = got?.find((g) => g.kind === x.r.decl.kind)?.epoch;
          if (e === undefined) { x.r.loseSlot(slot, 'taken'); continue; }
          x.l.holding.epoch = e;
          x.l.holding.sessionId = this.session.sessionId;
          x.l.holding.stopsVersion = null;
        }
        if (got) kept.push(slot);
      }
      for (const r of group) {
        const read = await this.retryUntilAnswered(() => r.store.resolutionRead(r.decl.kind, this.session.shard, this.session.sessionId, kept, []));
        for (const slot of kept) { const l = r.lanes.get(slot); if (l) r.startReporting(l, read.tRes, true); }
      }
      for (const slot of kept) for (const r of group) { const l = r.lanes.get(slot); if (l) await r.hooks?.onAcquire(slot, l.holding.epoch, 'rehome'); }
    } finally {
      for (const { l } of all) if (l.gate === gate) l.gate = null;
      release();
      for (const { r, l } of all) r.pump(l);
    }
  }

  /** Resume of a group (C01 §3.1 steps 1–4): a slot taken from any member is released from every member. */
  private async resumeGroup(): Promise<void> {
    const group = this.group();
    for (const r of group) await r.waitIdle([...r.lanes.values()]);
    let revoked = false;
    const lost = new Set<SlotNo>();
    const tRes = new Map<CockroachOwnerRuntime, HlcTs>();
    for (const r of group) {
      const read = await this.retryUntilAnswered(() => r.store.resolutionRead(
        r.decl.kind, this.session.shard, this.session.sessionId, [...r.lanes.keys()], []));
      revoked ||= read.sessionRevoked;
      tRes.set(r, read.tRes);
      for (const l of r.lanes.values()) {
        const row = read.slots.get(l.holding.slot);
        if (!row || row.epoch !== l.holding.epoch || row.sessionId !== this.session.sessionId) lost.add(l.holding.slot);
      }
    }
    for (const slot of lost) for (const r of group) r.loseSlot(slot, 'taken');
    if (revoked) { await this.rehomeGroup(); return; }
    for (const r of group) for (const l of r.lanes.values()) if (!l.released) r.startReporting(l, tRes.get(r) as HlcTs, false);
  }

  private async waitIdle(lanes: Lane[]): Promise<void> {
    while (lanes.some((l) => l.running || l.secondRunning)) await new Promise((r) => setTimeout(r, 5));
  }

  private loseSlot(slot: SlotNo, reason: 'staleEpoch' | 'handedOff' | 'taken' | 'shutdown'): void {
    const lane = this.lanes.get(slot);
    if (!lane || lane.released) return;
    lane.released = true;
    if (lane.reportableTimer) clearTimeout(lane.reportableTimer);
    this.lanes.delete(slot);
    for (const q of lane.queue.splice(0)) q.resolve({ r: 'StaleEpoch' });
    lane.queuedEntries = 0;
    for (const [k, t] of this.timers) {
      if (this.slotFor(t.partition) === slot) { clearTimeout(t.timeout); this.timers.delete(k); }
    }
    this.log('slot released', { slot, reason });
    this.hooks?.onRelease(slot, reason);
  }

  // ---------------- rebuild support (C01 §3.1, R47-24) ----------------

  /**
   * A partition's log rows from `fromSeq`, by (partition, seq) across the slots it lived in, with payload and
   * audit opened (C01 §3.1 "Rebuilding a partition"). For replay on takeover, Ambiguous reload and adopt.
   */
  async readLog(partition: PartitionKey, fromSeq: Seq = 1n, o: { platform?: boolean } = {}): Promise<OpenedLogRow[]> {
    if (!this.store.readLogRows) throw new Error('the store cannot read log rows');
    const rows = await this.store.readLogRows(this.decl.kind, partition, fromSeq);
    // The platform's `moved` and `adopt` entries take a seq but are not the owner's (C01 §3.3); `platform: true` keeps them.
    return rows.filter((r) => o.platform === true || !isPlatformEntry(r.kind)).map((r) => openLogRow(this.decl, this.sealer, r));
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
      // C01 §3.3: a partition adopted into this slot is routed here by every later holder of the slot.
      if (slotOfPartition(p, this.decl.slotCount) !== slot) this.placed.set(hex(p), slot);
      await this.rebuildPartitionFences(p);
    }
  }

  /** R47-24: the high-water marks that one partition's entries record (on onAdopt, C01 §3.3 step 5). */
  private async rebuildPartitionFences(partition: PartitionKey): Promise<void> {
    if (!this.store.readLogRows) return;
    for (const row of await this.readLog(partition)) if (row.senderFence) this.recordFence(row.senderFence, row.senderFence);
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

  // ---------------- moves (C01 §3.3) and splitting (C01 §3.8) ----------------

  /**
   * Step 3, in the holder of A: append `moved(to, generation)` in the slot's next batch. The head row then names `to`
   * with `generation` (= g + 1) and `adopted = false`; from the commit A answers MOVING for the partition, cancels its
   * timers and calls `onMovedOut`. `ConditionFailed('generation')` when `generation` is not the head's + 1,
   * `ConditionFailed('noHead')` for a partition with no head row; the other results as for `append`.
   */
  moveOut(partition: PartitionKey, to: SlotNo, generation: Generation): Promise<AppendResult> {
    return this.enqueue({ partition }, {}, { op: 'moved', to, generation });
  }

  /**
   * Step 2, in the holder of B: this process routes the partition to `to` from now on (a call answers MOVING until
   * `adopt`), and the owner pre-warms it from its log by (partition, seq) (`moves.prewarm`).
   */
  async prepareAdopt(m: { partition: PartitionKey; from: SlotNo; to: SlotNo; generation: Generation }): Promise<void> {
    const key = hex(m.partition);
    this.placed.set(key, m.to);
    let seq = 0n;
    if (this.store.readLogRows) {
      const rows = await this.store.readLogRows(this.decl.kind, m.partition, 1n);
      seq = rows.at(-1)?.seq ?? 0n;
      const own = rows.filter((r) => !isPlatformEntry(r.kind)).map((r) => openLogRow(this.decl, this.sealer, r));
      await this.o.moves?.prewarm?.(m.partition, own);
    }
    this.prepared.set(key, { ...m, seq });
  }

  /** The inbox of this process for the report fences of moves into its slots (step 4 push, V59-7). */
  moveInbox(): MoveInbox {
    return {
      fence: (f) => {
        if (f.kind !== this.decl.kind) return;
        const k = `${f.kind}|${f.slot}`;
        const cur = this.fencesIn.get(k);
        if (cur === undefined || compareHlc(f.reportThrough, cur) > 0) this.fencesIn.set(k, f.reportThrough);
        for (const w of [...this.fenceWaiters]) w();
      },
    };
  }

  /**
   * Steps 5 and 6, in the holder of B: wait for A's report fence (`owner_slot(kind, A).report_through` ≥ ts(moved), by
   * the pushed marker or, after `fenceReadAfterMs`, by bounded reads; kinds without markers do not wait), give the
   * owner the rows above its pre-warm, append `adopt(g + 1)` conditional on the head naming B unadopted at g + 1, then
   * rebuild the partition's admitCommand marks and call `onAdopt`. B reports no entry of the partition until read_lease
   * + ε after the commit. `ConditionFailed('notPrepared')` without `prepareAdopt`; `ConditionFailed('adopt')` when
   * the head does not name B unadopted at the generation.
   */
  async adopt(partition: PartitionKey): Promise<AppendResult> {
    const key = hex(partition);
    const m = this.prepared.get(key);
    if (!m) return { r: 'ConditionFailed', which: 'notPrepared' };
    const lane = this.lanes.get(m.to);
    if (!lane || lane.released) return { r: 'StaleEpoch' };
    const head = (await this.retryUntilAnswered(() => this.store.resolutionRead(
      this.decl.kind, this.session.shard, this.session.sessionId, [], [partition]))).heads.get(key);
    if (!head || head.slot !== m.to || head.adopted || head.generation !== m.generation) return { r: 'ConditionFailed', which: 'adopt' };
    const fence = reportsMarkers(this.decl) ? await this.waitFence(m.from, head.ts) : null;
    if (this.store.readLogRows && this.o.moves?.prewarm) {
      const rows = (await this.store.readLogRows(this.decl.kind, partition, m.seq + 1n)).filter((r) => !isPlatformEntry(r.kind));
      if (rows.length > 0) await this.o.moves.prewarm(partition, rows.map((r) => openLogRow(this.decl, this.sealer, r)));
    }
    let r = await this.enqueue({ partition }, {}, { op: 'adopt', from: m.from, generation: m.generation, fence: { reportThrough: fence } }, m.to);
    if (r.r === 'Ambiguous') {
      // M1: the slot decides nothing until resolution completes; then the head row tells if the adopt committed.
      while (lane.gate) await lane.gate.catch(() => {});
      const h = (await this.retryUntilAnswered(() => this.store.resolutionRead(
        this.decl.kind, this.session.shard, this.session.sessionId, [], [partition]))).heads.get(key);
      if (h && h.slot === m.to && h.adopted && h.generation === m.generation) r = { r: 'Committed', seqFrom: h.seq, seqTo: h.seq, ts: h.ts, streamSeqs: {} };
    }
    if (r.r !== 'Committed') return r;
    this.prepared.delete(key);
    await this.rebuildPartitionFences(partition);
    await this.hooks?.onAdopt(partition, m.generation);
    return r;
  }

  /** Step 5 fence check: A's report_through at or above ts(moved), pushed or read (C01 §3.3). */
  private waitFence(from: SlotNo, tsMoved: HlcTs): Promise<HlcTs> {
    const key = `${this.decl.kind}|${from}`;
    const ok = (t: HlcTs | null | undefined): t is HlcTs => t !== undefined && t !== null && compareHlc(t, tsMoved) >= 0;
    const pushed = this.fencesIn.get(key);
    if (ok(pushed)) { this.moveStats.fencesPushed += 1; return Promise.resolve(pushed); }
    const afterMs = this.o.moves?.fenceReadAfterMs ?? 100;
    const pollMs = this.o.moves?.fencePollMs ?? 100;
    return new Promise<HlcTs>((resolve, reject) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (t: HlcTs, how: 'fencesPushed' | 'fencesRead'): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        this.fenceWaiters.delete(waiter);
        this.moveStats[how] += 1;
        resolve(t);
      };
      const waiter = (): void => { const p = this.fencesIn.get(key); if (ok(p)) finish(p, 'fencesPushed'); };
      this.fenceWaiters.add(waiter);
      const read = async (): Promise<void> => {
        if (done) return;
        if (this.localStopped || this.stopping) { done = true; this.fenceWaiters.delete(waiter); reject(new Error('runtime stopped while waiting for a move fence')); return; }
        try {
          const t = await this.store.readReportThrough?.(this.decl.kind, from, tsMoved);
          if (ok(t)) { finish(t, 'fencesRead'); return; }
        } catch (e) { this.log('fence read failed', { from, error: String(e) }); }
        if (!done) { timer = setTimeout(() => { void read(); }, pollMs); timer.unref(); }
      };
      timer = setTimeout(() => { void read(); }, afterMs);
      timer.unref();
    });
  }

  /** Push the report fence to the target of each move out of this slot that the marker at `through` covers. */
  private pushFences(lane: Lane, through: HlcTs): void {
    const due = lane.pendingFences.filter((f) => compareHlc(f.ts, through) <= 0);
    if (due.length === 0) return;
    lane.pendingFences = lane.pendingFences.filter((f) => compareHlc(f.ts, through) > 0);
    for (const f of due) {
      const inbox = this.o.moves?.peer?.(this.decl.kind, f.to);
      if (!inbox) { this.log('no inbox for a move fence; the target reads owner_slot', { to: f.to }); continue; }
      try { inbox.fence({ kind: this.decl.kind, slot: lane.holding.slot, reportThrough: through }); }
      catch (e) { this.log('move fence push failed', { to: f.to, error: String(e) }); }
    }
  }

  /** V59-7: the successor of A finds the moves out of A not adopted yet; its first marker is pushed to each target. */
  private async findPendingMoves(slot: SlotNo): Promise<void> {
    const lane = this.lanes.get(slot);
    if (!lane || !reportsMarkers(this.decl) || !this.store.pendingMovesFrom) return;
    try {
      for (const m of await this.store.pendingMovesFrom(this.decl.kind, slot)) lane.pendingFences.push({ to: m.to, ts: m.ts });
    } catch (e) { this.log('pending moves read failed', { slot, error: String(e) }); }
  }

  /** The slot where a creation of the partition may commit (C01 §3.8; V59-2), from the applied account map. */
  private creationSlot(partition: PartitionKey): SlotNo | undefined {
    const v = this.appliedMap;
    if (!v) return undefined;
    const a = slotOfInMap(v, partition);
    return a.headDecides ? a.slot + (v.previousCount ?? v.slotCount) : a.slot;
  }

  /** A new account map version (C01 §3.8): its creation rules apply at once; each held splitting slot is acknowledged. */
  private applyMap(v: SlotMapVersion): void {
    this.appliedMap = v;
    const n = v.previousCount;
    if (n === undefined || !this.o.placement) return;
    for (const [slot, lane] of this.lanes) {
      if (slot < n && v.splitState[slot] === 'splitting' && lane.splitAcked !== v.version) {
        this.ackSplit(lane, v).catch((e: unknown) => this.log('ackSplitting failed', { slot, error: String(e) }));
      }
    }
  }

  /**
   * R47-05: once no batch of the slot that started before the version was applied is in flight or unresolved, list
   * the slot's upper-half accounts as of then and call placement's `ackSplitting`.
   */
  private async ackSplit(lane: Lane, v: SlotMapVersion): Promise<void> {
    const n = v.previousCount;
    const placement = this.o.placement;
    if (n === undefined || !placement || !this.store.listPartitions) return;
    await this.waitIdle([lane]);
    while (lane.gate) await lane.gate.catch(() => {});
    if (lane.released) return;
    const s = lane.holding.slot;
    const asOf = this.store.clusterTime ? await this.store.clusterTime() : hlcFromWallMs(this.wallMs());
    const upperHalf = (await this.store.listPartitions(this.decl.kind, s)).filter((p) => home(p) % (2 * n) === s + n);
    await placement.ackSplitting({ kind: 'account', slot: s, mapVersion: v.version, epoch: lane.holding.epoch, upperHalf, asOf });
    lane.splitAcked = v.version;
  }

  /**
   * C01 §2.7 `HolderPlacementApi.listPartitions` (R47-05), answered by the slot's holder: NOT_OWNER without the slot;
   * NOT_ACKED before this process applied the version and resolved the slot's batches in flight; else the served
   * partitions with home mod `home.mod` = `home.eq`.
   */
  async listPartitionsFor(req: { kind: 'account'; slot: SlotNo; mapVersion: MapVersion; home: { mod: number; eq: number } }): Promise<ListPartitionsAnswer> {
    const lane = this.lanes.get(req.slot);
    if (req.kind !== this.decl.kind || !lane || lane.released) return { refused: 'NOT_OWNER' };
    const applied = this.appliedMap !== undefined && this.appliedMap.version >= req.mapVersion;
    // Acknowledged: no batch that started before the version is open. Else the slot must be idle with nothing unresolved.
    const acked = lane.splitAcked !== undefined && lane.splitAcked >= req.mapVersion;
    if (!applied || (!acked && (lane.running || lane.secondRunning || lane.gate !== null || lane.unresolved > 0))) return { refused: 'NOT_ACKED' };
    if (!this.store.listPartitions) throw new Error('the store cannot list partitions');
    const asOf = this.store.clusterTime ? await this.store.clusterTime() : hlcFromWallMs(this.wallMs());
    const partitions = (await this.store.listPartitions(this.decl.kind, req.slot)).filter((p) => home(p) % req.home.mod === req.home.eq);
    return { partitions, asOf, epoch: lane.holding.epoch };
  }

  /** C08 §J (R46-12): send `integrity_report` once for each new local hold; retried until audit accepts it. */
  private reportIntegrity(lane: Lane): void {
    const send = this.o.integrityReport;
    if (!send) return;
    for (const hold of lane.holding.integrityHolds.values()) {
      if (hold.reporting) continue;
      hold.reporting = true;
      const report: IntegrityReport = { kind: this.decl.kind, partition: hold.partition, seq: hold.seq, observedChain: hold.observedChain };
      const run = async (): Promise<void> => {
        for (let attempt = 0; !this.localStopped && !lane.released; attempt++) {
          try { hold.detectionRef = (await send(report)).detectionRef; return; }
          catch (e) {
            this.log('integrity_report failed; retrying', { error: String(e), attempt });
            await new Promise((r) => { const t = setTimeout(r, Math.min(5_000, 100 * 2 ** Math.min(attempt, 6))); t.unref(); });
          }
        }
      };
      run().catch(() => { /* logged */ });
    }
  }

  /** The keys of the partition's armed timers (tests; CC-2). */
  timerKeys(partition: PartitionKey): string[] {
    const prefix = `${hex(partition)}|`;
    return [...this.timers.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }

  private cancelTimersOf(partition: PartitionKey): void {
    for (const key of this.timerKeys(partition)) this.cancelTimer(partition, key);
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

  /** C01 §3.8, R47-24: the high-water marks are rebuilt from the log before onAcquire and before onAdopt. */
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

  /** Liveness only, never decides an outcome (A8). The bound is the last owner offset bound (RFC-006 §6.2), else ε. */
  now(): { ts: HlcTs; boundMs: number } {
    const last = this.offset?.samples.at(-1);
    return { ts: hlcFromWallMs(this.wallMs()), boundMs: last ? Math.ceil(last.boundMs) : PARAMS.epsilonMs };
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
      const wait = hlcToWallMs(atTs) - this.wallMs();
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

  /** C01 §3.8: the account kind routes by the slot-map feed; other kinds by their fixed slot count and this process's
   *  moves. A sender follows MOVED and MOVING answers itself (`routeAfterRefusal`). */
  route(kind: OwnerKind, partition: PartitionKey): RouteInfo {
    if (kind === 'account' && this.o.slotMap?.current()) {
      const a = this.slotOf(partition);
      return { slot: a.slot, generation: kind === this.decl.kind ? this.generation(partition) : 0,
        epoch: kind === this.decl.kind ? this.epoch(a.slot) : 0n, readers: [], mapVersion: a.mapVersion };
    }
    const count = kind === this.decl.kind ? this.decl.slotCount : this.o.routeSlotCounts?.[kind];
    if (count === undefined) throw new Error(`no slot count for kind ${kind} (fixed map of I1a)`);
    const slot = kind === this.decl.kind ? this.slotFor(partition) : slotOfPartition(partition, count);
    return { slot, generation: kind === this.decl.kind ? this.generation(partition) : 0, epoch: kind === this.decl.kind ? this.epoch(slot) : 0n, readers: [] };
  }

  /** The placement feed's answer (headDecides during a split, C01 §3.8), else the fixed map (headDecides false). */
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

  // ---------------- checkpoints (RFC-006 §12.11) ----------------

  /** Seals and writes a state checkpoint to the process's own region (C01 §2.4; idempotent by (kind, partition, seq), §5). */
  putCheckpoint(kind: OwnerKind, partition: PartitionKey, seq: Seq, bytes: Uint8Array): Promise<{ reference: string; digest: Uint8Array }> {
    if (!this.o.checkpoints) return Promise.reject(new CheckpointError('NO_CHECKPOINT_STORE', 'putCheckpoint needs OwnerRuntimeOptions.checkpoints (the region\'s checkpoint store)'));
    return this.o.checkpoints.put(kind, partition, seq, bytes);
  }

  /** Reads a checkpoint of the process's own region and verifies its digest (CheckpointError DIGEST_MISMATCH, OTHER_REGION, NOT_FOUND). */
  getCheckpoint(reference: string): Promise<Uint8Array> {
    if (!this.o.checkpoints) return Promise.reject(new CheckpointError('NO_CHECKPOINT_STORE', 'getCheckpoint needs OwnerRuntimeOptions.checkpoints (the region\'s checkpoint store)'));
    return this.o.checkpoints.get(reference);
  }
}
