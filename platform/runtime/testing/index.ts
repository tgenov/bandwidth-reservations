/**
 * @share/owner-runtime/testing — an in-memory runtime double (S-PLAT plan §3, C01 §10.2 CC-1 … CC-8).
 *
 * It implements OwnerRuntime. By default `append` commits against an in-memory log/head/rows store per
 * partition and runs `decide(ctx)`. Tests script any AppendResult (unknown ones too), restarts (decide
 * re-runs), lease validity, stops, moves, takeovers, feed deliveries and routing refusals.
 */
import type {
  AcquisitionKind, AppendCall, AppendOptions, AppendResult, BatchContext, CommandEnvelope, DecideResult,
  Epoch, EntryInput, FeedCheckpoint, FeedEvent, FeedHeaders, Generation, HeadRow, HlcTs, InboundNotification,
  MonotonicNs, NotificationOut, OwnerDeclaration, OwnerHooks, OwnerKind, OwnerRuntime, PartitionKey,
  ProjectionWrite, ReadTx, ReportMarker, RouteInfo, RoutingRefusal, RowRef, Seq, SlotNo, SlotOfAnswer,
  StreamSeq, TimingSnapshot, WriterFence,
} from '../src/api.ts';
import { encodeJson, hex, utf8 } from '../src/bytes.ts';
import { chainGenesis, chainNext } from '../src/chain.ts';
import { NotClosed, type StatusReaderRuntime } from '../src/api.ts';
import { memoryQuery } from '../src/store/memory.ts';
import { compareHlc, hlcFromWallMs, hlcParts, hlc } from '../src/hlc.ts';
import { slotOfPartition } from '../src/home.ts';
import { rowId } from '../src/rowref.ts';

/** A result C01 v1 does not define, for CC-1 "an unknown one" (C01 §8: treat as Retry and alert). */
export const UNKNOWN_RESULT = { r: 'FutureResult' } as unknown as AppendResult;
/** A refusal code C01 v1 does not define (C01 §8: treat as UNAVAILABLE). */
export const UNKNOWN_REFUSAL = { code: 'FUTURE_REFUSAL' } as unknown as RoutingRefusal;

/** Every AppendResult with representative fields. */
export const RESULTS = {
  Committed: (seq = 1n, ts = hlc('1000000000.0000000000')): AppendResult =>
    ({ r: 'Committed', seqFrom: seq, seqTo: seq, ts, streamSeqs: {} }),
  ConditionFailed: (which = 'cond'): AppendResult => ({ r: 'ConditionFailed', which }),
  Retry: (): AppendResult => ({ r: 'Retry' }),
  StaleEpoch: (): AppendResult => ({ r: 'StaleEpoch' }),
  Moved: (slot = 1, generation = 1): AppendResult => ({ r: 'Moved', slot, generation }),
  Moving: (): AppendResult => ({ r: 'Moving' }),
  Stopped: (detectionRef = new Uint8Array([1])): AppendResult => ({ r: 'Stopped', detectionRef }),
  Ambiguous: (): AppendResult => ({ r: 'Ambiguous' }),
  Overloaded: (retryAfterMs = 100): AppendResult => ({ r: 'Overloaded', retryAfterMs }),
  Unknown: (): AppendResult => UNKNOWN_RESULT,
} as const;

/** Every RoutingRefusal with representative fields. */
export const REFUSALS = {
  STALE_EPOCH: (current: Epoch = 2n): RoutingRefusal => ({ code: 'STALE_EPOCH', current }),
  NOT_OWNER: (): RoutingRefusal => ({ code: 'NOT_OWNER' }),
  MOVED: (slot = 1, generation = 1): RoutingRefusal => ({ code: 'MOVED', slot, generation }),
  MOVING: (retryAfterMs = 100): RoutingRefusal => ({ code: 'MOVING', retryAfterMs }),
  STOPPED: (): RoutingRefusal => ({ code: 'STOPPED' }),
  STALE_SENDER: (recorded: WriterFence = { generation: 0, epoch: 2n }): RoutingRefusal => ({ code: 'STALE_SENDER', recorded }),
  OVERLOADED: (retryAfterMs = 100): RoutingRefusal => ({ code: 'OVERLOADED', retryAfterMs }),
  UNAVAILABLE: (): RoutingRefusal => ({ code: 'UNAVAILABLE' }),
  Unknown: (): RoutingRefusal => UNKNOWN_REFUSAL,
} as const;

export interface DoubleLogEntry {
  seq: Seq; ts: HlcTs; epoch: Epoch; generation: Generation; entry: EntryInput;
  streamSeqs: Array<{ stream: string; streamSeq: StreamSeq }>;
  /** C08 §J chain over the double's plaintext row (the real runtime chains the sealed row). */
  chain: Uint8Array;
}

export type ScriptedAppend = AppendResult | ((call: AppendCall, opts: AppendOptions | undefined) => AppendResult);

export type TraceItem =
  | { t: 'leaseValid'; slot: SlotNo; valid: boolean }
  | { t: 'append'; partition: string; result: string }
  | { t: 'command'; to: OwnerKind; partition: string }
  | { t: 'reply'; label: string }
  | { t: 'timerFired'; partition: string; key: string };

interface PartitionState {
  partition: PartitionKey; seq: Seq; ts: HlcTs | null; epoch: Epoch; generation: Generation; adopted: boolean;
  slot: SlotNo; streams: Record<string, StreamSeq>; log: DoubleLogEntry[]; chain: Uint8Array;
}

/** State that the doubles of one process (or test) share: clock, rows, slot counts, displacement markers. */
export class DoubleWorld {
  nowMs: number;
  logical = 0;
  readonly rows = new Map<string, unknown>();
  /** table → rows with their key columns (for consistentRead / followerRead queries). */
  readonly tableRows = new Map<string, Map<string, { key: Record<string, unknown>; row: unknown }>>();
  readonly slotCounts = new Map<OwnerKind, number>();
  /** hex(link)|hex(request) → displacement marker row (C02 link_displacement). */
  readonly displacement = new Map<string, { attempt: number; row: unknown }>();
  readonly members: RuntimeDouble[] = [];
  constructor(startMs = 1_700_000_000_000) {
    this.nowMs = startMs;
  }
}

export interface RuntimeDoubleOptions {
  declaration?: OwnerDeclaration;
  /** Slot count used by route/slotOf when no declaration is given. Default 16. */
  slotCount?: number;
  /** Slots this process holds at start (epoch 1). Default: every slot. */
  slots?: SlotNo[];
  timing?: TimingSnapshot;
  /** Wall clock (ms) of the double's virtual time. Default 1,700,000,000,000. */
  startMs?: number;
  /** Called when a timer fires (C01 §3.7: the owner then appends an entry). */
  onTimer?: (partition: PartitionKey, key: string) => void;
  /** Slot counts of other kinds, for `route` (default: the target kind's own count if known, else this one's). */
  slotCounts?: Record<OwnerKind, number>;
  /** Advance the report position on each commit and call onReportable on start/acquire (default true). */
  autoReport?: boolean;
  /** Share clock, rows and markers with other doubles (see RuntimeDouble.group). */
  world?: DoubleWorld;
}

export class RuntimeDouble implements OwnerRuntime {
  readonly kind: OwnerKind;
  readonly slotCount: number;
  readonly trace: TraceItem[] = [];
  /** Every append call with its answer, in order. */
  readonly appends: Array<{ call: AppendCall; opts: AppendOptions | undefined; result: AppendResult }> = [];
  /** Feed events and notifications produced by Committed appends, in order. */
  readonly published: Array<{ topic: string; partition: PartitionKey; stream: string; streamSeq: StreamSeq; event: unknown }> = [];
  readonly notificationsSent: NotificationOut[] = [];
  /** Number of decide() runs per append call index. */
  readonly decideRuns: number[] = [];

  private hooks: OwnerHooks | undefined;
  private onTimer: ((partition: PartitionKey, key: string) => void) | undefined;
  private readonly script: ScriptedAppend[] = [];
  private restartsNext = 0;
  private readonly partitions = new Map<string, PartitionState>();
  private get rows(): Map<string, unknown> { return this.world.rows; }
  private readonly held = new Map<SlotNo, { epoch: Epoch; lease: boolean }>();
  private readonly lastEpoch = new Map<SlotNo, Epoch>();
  private readonly stops = new Map<string, Uint8Array>();
  private readonly movedOut = new Map<string, { slot: SlotNo; generation: Generation; adopted: boolean }>();
  private readonly fences = new Map<string, WriterFence>();
  private readonly timers = new Map<string, { partition: PartitionKey; key: string; atTs: HlcTs }>();
  private readonly subscriptions = new Map<string, Array<{ gate: 'committed' | 'reported'; handler: (e: FeedEvent) => Promise<void> }>>();
  private readonly resolvedHandlers = new Map<string, Array<(p: number, R: HlcTs) => void>>();
  private readonly closedHandlers: Array<(link: PartitionKey, t: HlcTs, feedSeq: StreamSeq) => void> = [];
  private readonly markerHandlers: Array<(m: ReportMarker) => Promise<void>> = [];
  private readonly reportHandlers: Array<(slot: SlotNo, p: HlcTs) => void> = [];
  private readonly reportPositions = new Map<SlotNo, HlcTs>();
  private readonly checkpoints = new Map<string, Uint8Array>();
  private readonly routes = new Map<string, RouteInfo>();
  private readonly declaration: OwnerDeclaration | undefined;
  private timingSnapshot: TimingSnapshot;
  readonly world: DoubleWorld;
  private readonly autoReport: boolean;
  private get nowMs(): number { return this.world.nowMs; }
  private set nowMs(v: number) { this.world.nowMs = v; }

  /** Doubles of several owner kinds that share one world (clock, rows, slot counts, displacement markers). */
  static group(decls: OwnerDeclaration[], opts: Omit<RuntimeDoubleOptions, 'declaration' | 'world'> = {}): Record<OwnerKind, RuntimeDouble> {
    const world = new DoubleWorld(opts.startMs);
    const out: Record<OwnerKind, RuntimeDouble> = {};
    for (const d of decls) out[d.kind] = new RuntimeDouble({ ...opts, declaration: d, world });
    return out;
  }

  constructor(opts: RuntimeDoubleOptions = {}) {
    this.declaration = opts.declaration;
    this.kind = opts.declaration?.kind ?? 'test';
    this.slotCount = opts.declaration?.slotCount ?? opts.slotCount ?? 16;
    this.timingSnapshot = opts.timing ?? { version: 1n, epsilonMs: 100, deltaXMs: 320, tauMs: 420 };
    this.world = opts.world ?? new DoubleWorld(opts.startMs);
    this.world.members.push(this);
    this.world.slotCounts.set(this.kind, this.slotCount);
    for (const [k, n] of Object.entries(opts.slotCounts ?? {})) this.world.slotCounts.set(k, n);
    this.autoReport = opts.autoReport ?? true;
    this.onTimer = opts.onTimer;
    const slots = opts.slots ?? Array.from({ length: this.slotCount }, (_, i) => i);
    for (const s of slots) this.held.set(s, { epoch: 1n, lease: true });
  }

  // ---------------- scripting ----------------

  /**
   * Start like the real runtime: onAcquire('expiry') for every start slot, then (with autoReport) the report
   * position and onReportable. `attach` alone calls no hook.
   */
  async start(hooks?: OwnerHooks): Promise<this> {
    if (hooks) this.hooks = hooks;
    for (const [slot, h] of [...this.held]) {
      await this.hooks?.onAcquire(slot, h.epoch, 'expiry');
      this.reportable(slot);
    }
    return this;
  }

  private reportable(slot: SlotNo): void {
    if (!this.autoReport) return;
    this.setReportPosition(slot, this.now().ts);
    this.hooks?.onReportable(slot);
  }

  /** A displacement marker for (link, request) (C02): displacementRead fails for any attempt. */
  putDisplacementMarker(link: PartitionKey, request: Uint8Array, attempt: number, row: unknown = { attempt }): void {
    this.world.displacement.set(`${hex(link)}|${hex(request)}`, { attempt, row });
  }

  removeDisplacementMarker(link: PartitionKey, request: Uint8Array): void {
    this.world.displacement.delete(`${hex(link)}|${hex(request)}`);
  }

  /** Attach the owner's hooks (the double calls them from acquire/release/moveOut/adopt/notify). */
  attach(hooks: OwnerHooks, onTimer?: (partition: PartitionKey, key: string) => void): this {
    this.hooks = hooks;
    if (onTimer) this.onTimer = onTimer;
    return this;
  }

  /** The next appends answer these, in order (a function computes the answer). Then default behaviour resumes. */
  scriptAppend(...results: ScriptedAppend[]): this {
    this.script.push(...results);
    return this;
  }

  /** The next default-path append restarts n times before it commits: decide runs n + 1 times (C01 CP-3, M2). */
  scriptRestarts(n: number): this {
    this.restartsNext = n;
    return this;
  }

  setLease(slot: SlotNo, valid: boolean): this {
    const h = this.held.get(slot);
    if (h) h.lease = valid;
    return this;
  }

  setTiming(t: TimingSnapshot): this {
    this.timingSnapshot = t;
    return this;
  }

  advance(ms: number): void {
    this.nowMs += ms;
    for (const d of this.world.members) d.fireDueTimers();
  }

  /** Open an integrity stop: appends for the partition answer Stopped (CC-4). */
  stop(partition: PartitionKey, detectionRef = new Uint8Array([1])): void {
    this.stops.set(hex(partition), detectionRef);
  }

  resume(partition: PartitionKey): void {
    this.stops.delete(hex(partition));
  }

  /** Simulate `moved(to, g+1)` committing in this slot: Moving until adopted, then Moved; calls onMovedOut (CC-2). */
  moveOut(partition: PartitionKey, toSlot: SlotNo): void {
    const st = this.state(partition);
    this.movedOut.set(hex(partition), { slot: toSlot, generation: st.generation + 1, adopted: false });
    this.hooks?.onMovedOut(partition);
  }

  /** The target adopted the partition: this slot now answers Moved(slot, g+1). */
  markAdoptedElsewhere(partition: PartitionKey): void {
    const m = this.movedOut.get(hex(partition));
    if (m) m.adopted = true;
  }

  /** Simulate `adopt(g)` committing here: the partition is served with generation g; calls onAdopt (CC-3). */
  async adopt(partition: PartitionKey, generation: Generation): Promise<void> {
    const st = this.state(partition);
    st.generation = generation; st.adopted = true; st.slot = slotOfPartition(partition, this.slotCount);
    this.movedOut.delete(hex(partition));
    await this.hooks?.onAdopt(partition, generation);
  }

  /** Acquire (or re-acquire) a slot: epoch + 1, onAcquire. Log, heads and rows survive (they are the database). */
  async acquire(slot: SlotNo, kind: AcquisitionKind = 'expiry'): Promise<Epoch> {
    const prev = this.held.get(slot)?.epoch ?? this.lastEpoch.get(slot) ?? 0n;
    const epoch = prev + 1n;
    this.held.set(slot, { epoch, lease: true });
    await this.hooks?.onAcquire(slot, epoch, kind);
    this.reportable(slot);
    return epoch;
  }

  /** Lose a slot: onRelease; later appends in it answer StaleEpoch; its timers are dropped. */
  release(slot: SlotNo, reason: 'staleEpoch' | 'handedOff' | 'taken' | 'shutdown' = 'taken'): void {
    const h = this.held.get(slot);
    if (h) this.lastEpoch.set(slot, h.epoch);
    this.held.delete(slot);
    for (const [k, t] of this.timers) if (slotOfPartition(t.partition, this.slotCount) === slot) this.timers.delete(k);
    this.hooks?.onRelease(slot, reason);
  }
  /** Takeover: release then acquire in a new epoch, as another process would (CC-3 second clause). */
  async takeover(slot: SlotNo): Promise<Epoch> {
    this.release(slot, 'taken');
    return this.acquire(slot, 'expiry');
  }

  async notify(n: InboundNotification): Promise<void> {
    await this.hooks?.onNotification(n);
  }

  /** Deliver a feed event to subscribers of `topic` as the consumer runtime would (CC-6: duplicates, any order). */
  async deliver(topic: string, e: FeedEvent): Promise<void> {
    for (const s of this.subscriptions.get(topic) ?? []) await s.handler(e);
  }

  async deliverMarker(m: ReportMarker): Promise<void> {
    for (const h of this.markerHandlers) await h(m);
  }

  resolve(topic: string, destinationPartition: number, R: HlcTs): void {
    for (const h of this.resolvedHandlers.get(topic) ?? []) h(destinationPartition, R);
  }

  close(link: PartitionKey, t: HlcTs, feedSeq: StreamSeq): void {
    for (const h of this.closedHandlers) h(link, t, feedSeq);
  }

  setReportPosition(slot: SlotNo, p: HlcTs): void {
    this.reportPositions.set(slot, p);
    for (const h of this.reportHandlers) h(slot, p);
  }

  /** Record a sender fence as an applied entry would (admitCommand high-water, R47-24). */
  recordFence(sender: { kind: OwnerKind; partition: PartitionKey }, fence: WriterFence): void {
    const k = `${sender.kind}|${hex(sender.partition)}`;
    const cur = this.fences.get(k);
    if (!cur || fenceLess(cur, fence)) this.fences.set(k, fence);
  }

  setRoute(kind: OwnerKind, partition: PartitionKey, info: RouteInfo): void {
    this.routes.set(`${kind}|${hex(partition)}`, info);
  }

  /** Record an outbound reply sent from memory (CC-7 instrumentation). */
  recordReply(label: string): void {
    this.trace.push({ t: 'reply', label });
  }

  /** CC-7: every reply or command is immediately preceded by a valid leaseValid check (no append/other action between). */
  unleasedActions(): TraceItem[] {
    const bad: TraceItem[] = [];
    for (let i = 0; i < this.trace.length; i++) {
      const it = this.trace[i];
      if (!it || (it.t !== 'reply' && it.t !== 'command')) continue;
      const prev = this.trace[i - 1];
      if (!prev || prev.t !== 'leaseValid' || !prev.valid) bad.push(it);
    }
    return bad;
  }

  // ---------------- inspection ----------------

  log(partition: PartitionKey): DoubleLogEntry[] {
    return this.partitions.get(hex(partition))?.log ?? [];
  }

  headOf(partition: PartitionKey): HeadRow {
    return this.headRow(hex(partition), partition);
  }

  row(ref: RowRef): unknown | undefined {
    return this.rows.get(rowId(ref));
  }

  timersOf(partition: PartitionKey): Array<{ key: string; atTs: HlcTs }> {
    return [...this.timers.values()].filter((t) => hex(t.partition) === hex(partition)).map(({ key, atTs }) => ({ key, atTs }));
  }

  // ---------------- OwnerRuntime ----------------

  async append(call: AppendCall, opts?: AppendOptions): Promise<AppendResult> {
    const idx = this.appends.length;
    this.decideRuns[idx] = 0;
    const scripted = this.script.shift();
    const result = scripted === undefined
      ? this.commitDefault(call, idx)
      : typeof scripted === 'function' ? scripted(call, opts) : scripted;
    this.appends.push({ call, opts, result });
    this.trace.push({ t: 'append', partition: hex(call.partition), result: result.r });
    return result;
  }

  leaseValid(slot: SlotNo): { valid: boolean; untilMonotonic: MonotonicNs } {
    const h = this.held.get(slot);
    const valid = h?.lease === true;
    this.trace.push({ t: 'leaseValid', slot, valid });
    return { valid, untilMonotonic: process.hrtime.bigint() + (valid ? 2_700_000_000n : 0n) };
  }

  epoch(slot: SlotNo): Epoch {
    return this.held.get(slot)?.epoch ?? 0n;
  }

  generation(partition: PartitionKey): Generation {
    return this.partitions.get(hex(partition))?.generation ?? 0;
  }

  admitCommand(sender: { kind: OwnerKind; partition: PartitionKey }, fence: WriterFence):
    { admit: true } | { admit: false; recorded: WriterFence } {
    const recorded = this.fences.get(`${sender.kind}|${hex(sender.partition)}`);
    if (recorded && fenceLess(fence, recorded)) return { admit: false, recorded };
    return { admit: true };
  }

  timing(): TimingSnapshot {
    return this.timingSnapshot;
  }

  now(): { ts: HlcTs; boundMs: number } {
    return { ts: hlcFromWallMs(this.nowMs), boundMs: this.timingSnapshot.epsilonMs };
  }

  reportPosition(slot: SlotNo): HlcTs | undefined {
    return this.reportPositions.get(slot);
  }

  onReport(handler: (slot: SlotNo, p: HlcTs) => void): void {
    this.reportHandlers.push(handler);
  }

  async consistentRead<T>(fn: (tx: ReadTx) => Promise<T>, _at: 'present' | HlcTs): Promise<T> {
    return fn(this.readTx());
  }

  async followerRead<T>(fn: (tx: ReadTx) => Promise<T>): Promise<{ value: T; servedAt: HlcTs }> {
    return { value: await fn(this.readTx()), servedAt: hlcFromWallMs(this.nowMs - 4_800) };
  }

  async closedTimestamp(): Promise<HlcTs> {
    return hlcFromWallMs(this.nowMs - 3_000);
  }

  subscribe(topic: string, _from: FeedCheckpoint, gate: 'committed' | 'reported', handler: (e: FeedEvent) => Promise<void>): void {
    const list = this.subscriptions.get(topic) ?? [];
    list.push({ gate, handler });
    this.subscriptions.set(topic, list);
  }

  onResolved(topic: string, handler: (destinationPartition: number, R: HlcTs) => void): void {
    const list = this.resolvedHandlers.get(topic) ?? [];
    list.push(handler);
    this.resolvedHandlers.set(topic, list);
  }

  onClosed(handler: (link: PartitionKey, t: HlcTs, feedSeq: StreamSeq) => void): void {
    this.closedHandlers.push(handler);
  }

  onMarker(_topic: 'account.outcome.v1', handler: (m: ReportMarker) => Promise<void>): void {
    this.markerHandlers.push(handler);
  }

  timer(partition: PartitionKey, key: string, atTs: HlcTs): void {
    this.timers.set(`${hex(partition)}|${key}`, { partition, key, atTs });
  }

  cancelTimer(partition: PartitionKey, key: string): void {
    this.timers.delete(`${hex(partition)}|${key}`);
  }

  route(kind: OwnerKind, partition: PartitionKey): RouteInfo {
    const r = this.routes.get(`${kind}|${hex(partition)}`);
    if (r) return r;
    const slot = slotOfPartition(partition, this.world.slotCounts.get(kind) ?? this.slotCount);
    return { slot, generation: kind === this.kind ? this.generation(partition) : 0, epoch: kind === this.kind ? this.epoch(slot) : 1n, readers: [] };
  }

  slotOf(account: PartitionKey): SlotOfAnswer {
    return { slot: slotOfPartition(account, this.world.slotCounts.get('account') ?? this.slotCount), mapVersion: 1n, headDecides: false };
  }

  topology(): { state: string; preferredRegion: 'R1' | 'R2'; disaster: null | { region: string; since: HlcTs } } {
    return { state: 'steady', preferredRegion: 'R1', disaster: null };
  }

  async putCheckpoint(kind: OwnerKind, partition: PartitionKey, seq: Seq, bytes: Uint8Array): Promise<{ reference: string; digest: Uint8Array }> {
    const reference = `${kind}/${hex(partition)}/${seq}`;
    this.checkpoints.set(reference, bytes);
    const { createHash } = await import('node:crypto');
    return { reference, digest: new Uint8Array(createHash('sha256').update(bytes).digest()) };
  }

  async getCheckpoint(reference: string): Promise<Uint8Array> {
    const b = this.checkpoints.get(reference);
    if (!b) throw new Error(`no checkpoint ${reference}`);
    return b;
  }

  // ---------------- default append path ----------------

  private commitDefault(call: AppendCall, idx: number): AppendResult {
    const key = hex(call.partition);
    const slot = slotOfPartition(call.partition, this.slotCount);
    if (!this.held.has(slot)) return { r: 'StaleEpoch' };
    const stop = this.stops.get(key);
    if (stop) return { r: 'Stopped', detectionRef: stop };
    const moved = this.movedOut.get(key);
    if (moved) return moved.adopted ? { r: 'Moved', slot: moved.slot, generation: moved.generation } : { r: 'Moving' };

    let decided: DecideResult | null = null;
    let ts = this.nextTs(key);
    const restarts = this.restartsNext;
    this.restartsNext = 0;
    for (let attempt = 0; attempt <= restarts; attempt++) {
      ts = this.nextTs(key); // a restart re-reads ts (C01 CP-3)
      const conditionResults: Record<string, boolean | 'lockTimeout'> = {};
      for (const c of call.conditions ?? []) {
        let ok: boolean;
        if (c.kind === 'rowAbsent') ok = !this.rows.has(rowId(c.row));
        else if (c.kind === 'rowPresent') ok = this.rows.has(rowId(c.row));
        else if (c.kind === 'tsBefore') ok = compareHlc(ts, c.bound(this.timingSnapshot)) < 0;
        else if (c.kind === 'displacementRead') {
          // C02 / P1-S78: a marker for (link, request) with ANY attempt fails the condition.
          const m = this.world.displacement.get(`${hex(c.link)}|${hex(c.request)}`);
          if (m) return { r: 'ConditionFailed', which: c.label, displacement: { attempt: m.attempt, row: m.row } };
          ok = true;
        } else ok = true;
        conditionResults[c.label] = ok;
        if (!ok) return { r: 'ConditionFailed', which: c.label };
      }
      if (call.decide) {
        const allowed = new Set([...(call.reads ?? []), ...(call.conditions ?? []).flatMap((c) => 'row' in c ? [c.row] : [])].map(rowId));
        const ctx: BatchContext = {
          ts, timing: this.timingSnapshot, conditionResults,
          head: (p) => this.headRow(hex(p), p),
          read: (ref) => {
            if (!allowed.has(rowId(ref))) throw new Error(`ctx.read of an undeclared row ${rowId(ref)} (C01 R47-11)`);
            return this.rows.get(rowId(ref));
          },
        };
        this.decideRuns[idx] = (this.decideRuns[idx] ?? 0) + 1;
        decided = call.decide(ctx);
        if (decided === null) return { r: 'ConditionFailed', which: 'decide' };
      } else {
        decided = { entries: call.entries ?? [], projections: call.projections ?? [], notifications: call.notifications ?? [] };
      }
    }
    if (!decided) return { r: 'Retry' };
    return this.apply(call.partition, slot, ts, decided);
  }

  private apply(partition: PartitionKey, slot: SlotNo, ts: HlcTs, d: DecideResult): AppendResult {
    const st = this.state(partition);
    const epoch = this.held.get(slot)?.epoch ?? 1n;
    const seqFrom = st.seq + 1n;
    const streamSeqs: Record<string, [StreamSeq, StreamSeq]> = {};
    for (const entry of d.entries) {
      st.seq += 1n;
      const assigned: Array<{ stream: string; streamSeq: StreamSeq }> = [];
      for (const em of entry.emits ?? []) {
        const next = (st.streams[em.stream] ?? 0n) + 1n;
        st.streams[em.stream] = next;
        assigned.push({ stream: em.stream, streamSeq: next });
        const range = streamSeqs[em.stream];
        streamSeqs[em.stream] = range ? [range[0], next] : [next, next];
        const topic = this.declaration?.streams.find((s) => s.name === em.stream)?.topic ?? `${this.kind}.${em.stream}.v1`;
        this.published.push({ topic, partition, stream: em.stream, streamSeq: next, event: em.event });
      }
      if (entry.senderFence) this.recordFence(entry.senderFence, entry.senderFence);
      st.chain = chainNext(st.chain, {
        kindName: this.kind, partition, seq: st.seq, slot, generation: st.generation, epoch, entryKind: entry.kind, schemaV: entry.schemaV,
        identity: entry.identity, emits: encodeJson(assigned.map((a) => [a.stream, a.streamSeq.toString()])), retention: 0,
        keyId: utf8('double'), audit: encodeJson(entry.audit), payload: encodeJson(entry.payload),
      });
      st.log.push({ seq: st.seq, ts, epoch, generation: st.generation, entry, streamSeqs: assigned, chain: st.chain });
    }
    for (const w of d.projections ?? []) this.applyProjection(w);
    for (const n of d.notifications ?? []) this.notificationsSent.push(n);
    st.ts = ts; st.epoch = epoch; st.slot = slot;
    if (this.autoReport && this.reportPositions.has(slot)) this.setReportPosition(slot, ts);
    return { r: 'Committed', seqFrom, seqTo: st.seq, ts, streamSeqs };
  }

  private applyProjection(w: ProjectionWrite): void {
    const id = rowId({ table: w.table, key: w.key });
    if (w.op === 'delete') { this.rows.delete(id); this.world.tableRows.get(w.table)?.delete(id); }
    else this.putRow({ table: w.table, key: w.key }, w.row);
  }

  /** Test helper: set a row directly (e.g. a pre-existing projection row). */
  putRow(ref: RowRef, row: unknown): void {
    const id = rowId(ref);
    this.rows.set(id, row);
    let t = this.world.tableRows.get(ref.table);
    if (!t) { t = new Map(); this.world.tableRows.set(ref.table, t); }
    if (ref.key !== null && typeof ref.key === 'object') t.set(id, { key: ref.key as Record<string, unknown>, row });
  }

  private state(partition: PartitionKey): PartitionState {
    const k = hex(partition);
    let st = this.partitions.get(k);
    if (!st) {
      st = { partition, seq: 0n, ts: null, epoch: 0n, generation: 0, adopted: true,
        slot: slotOfPartition(partition, this.slotCount), streams: {}, log: [], chain: chainGenesis(this.kind, partition) };
      this.partitions.set(k, st);
    }
    return st;
  }

  private headRow(k: string, partition: PartitionKey): HeadRow {
    const st = this.partitions.get(k);
    if (!st || st.ts === null) {
      return { exists: false, partition, slot: slotOfPartition(partition, this.slotCount), generation: 0, adopted: true,
        seq: 0n, ts: null, epoch: 0n, streams: {}, chain: new Uint8Array(32) };
    }
    return { exists: true, partition, slot: st.slot, generation: st.generation, adopted: st.adopted,
      seq: st.seq, ts: st.ts, epoch: st.epoch, streams: { ...st.streams }, chain: st.chain };
  }

  /** Strictly increasing per partition (C01 §3.2), from the virtual clock. */
  private nextTs(k: string): HlcTs {
    this.world.logical += 1;
    let t = hlc(`${BigInt(this.nowMs) * 1_000_000n}.${String(this.world.logical).padStart(10, '0')}`);
    const last = this.partitions.get(k)?.ts;
    if (last && compareHlc(t, last) <= 0) {
      const p = hlcParts(last);
      t = hlc(`${p.wallNs}.${String(p.logical + 1n).padStart(10, '0')}`);
    }
    return t;
  }

  /** Fire the timers that are due at the world's clock. */
  fireDueTimers(): void {
    const now = hlcFromWallMs(this.nowMs);
    for (const [k, t] of [...this.timers]) {
      if (compareHlc(t.atTs, now) <= 0) {
        this.timers.delete(k);
        this.trace.push({ t: 'timerFired', partition: hex(t.partition), key: t.key });
        this.onTimer?.(t.partition, t.key);
      }
    }
  }

  /** `SELECT … FROM <table> [WHERE c = $n AND …]` over the world's projection rows and this kind's heads. */
  private readTx(): ReadTx {
    return {
      query: async (sql, params) => memoryQuery(sql, params ?? [], (table) => {
        if (table === `${this.kind}_head`) {
          return [...this.partitions.values()].filter((p) => p.ts !== null).map((p) => ({ ...this.headRow(hex(p.partition), p.partition) }));
        }
        return [...(this.world.tableRows.get(table)?.values() ?? [])].map((r) => ({ ...r.key, ...(r.row as Record<string, unknown>) }));
      }) as never,
    };
  }

  /** Is the partition moved out of this double (for the status reader double)? */
  isMovedOut(partition: PartitionKey): boolean {
    return this.movedOut.has(hex(partition));
  }
}

function fenceLess(a: WriterFence, b: WriterFence): boolean {
  return a.generation < b.generation || (a.generation === b.generation && a.epoch < b.epoch);
}

// ---------------- routed commands (CC-5) ----------------

/** A scriptable peer: `send` answers the next scripted refusal (or `ok`) and records every envelope. */
export class CommandPeerDouble {
  readonly sent: Array<{ envelope: CommandEnvelope; body: unknown }> = [];
  private readonly script: Array<RoutingRefusal | 'ok'> = [];
  private readonly runtime: RuntimeDouble | undefined;
  constructor(runtime?: RuntimeDouble) {
    this.runtime = runtime;
  }

  scriptRefusal(...answers: Array<RoutingRefusal | 'ok'>): this {
    this.script.push(...answers);
    return this;
  }

  async send(envelope: CommandEnvelope, body: unknown): Promise<{ ok: true } | { ok: false; refusal: RoutingRefusal }> {
    this.sent.push({ envelope, body });
    this.runtime?.trace.push({ t: 'command', to: envelope.routedTo.kind, partition: hex(envelope.sender.partition) });
    const next = this.script.shift() ?? 'ok';
    return next === 'ok' ? { ok: true } : { ok: false, refusal: next };
  }
}

// ---------------- feed helpers (CC-6) ----------------

export function feedEvent(args: {
  partition: PartitionKey; stream: string; streamSeq: StreamSeq; event: unknown; ts?: HlcTs;
  generation?: Generation; epoch?: Epoch; kind?: string; slot?: SlotNo;
}): FeedEvent {
  const headers: FeedHeaders = {
    partition: args.partition, stream: args.stream, stream_seq: args.streamSeq.toString(),
    generation: String(args.generation ?? 0), epoch: String(args.epoch ?? 1n),
    ts: args.ts ?? hlc('1700000000000000000.0000000000'), kind: args.kind ?? '1', schema_v: '1', key_id: 'dev',
    ...(args.slot === undefined ? {} : { slot: String(args.slot) }),
  };
  return { headers, value: encodeJson(args.event) };
}

/** The in-memory store behind CockroachOwnerRuntime, with fault injection (for runtime-level tests). */
export { MemoryStore, memoryFeedSeqReader, type MemoryFaults, type CommitFault } from '../src/store/memory.ts';
export { MemoryBus } from '../src/feed/memory-bus.ts';
export { MemoryChangefeed } from '../src/relay/memory-changefeed.ts';
export { MemoryGapFill } from '../src/consumer/gapfill.ts';

// ---------------- status readers (C01 §2.4 StatusReaderRuntime) ----------------

/**
 * A StatusReaderRuntime double over a RuntimeDouble: a lease per slot (valid unless set otherwise, P_grant =
 * the double's report position), leasedRead of the double's rows (NotClosed without a valid lease),
 * isMovedOut from the double's moves, and a scriptable rule-3 answer.
 */
export class StatusReaderDouble implements StatusReaderRuntime {
  private readonly rt: RuntimeDouble;
  private readonly invalid = new Set<SlotNo>();
  holderLive = true;
  rule3Rows: unknown = undefined;
  constructor(rt: RuntimeDouble) {
    this.rt = rt;
  }

  setLease(slot: SlotNo, valid: boolean): this {
    if (valid) this.invalid.delete(slot); else this.invalid.add(slot);
    return this;
  }

  readLease(slot: SlotNo): { valid: boolean; untilMonotonic: MonotonicNs; appliedThrough: HlcTs; reportPosition: HlcTs; pGrant: HlcTs } {
    const p = this.rt.reportPosition(slot);
    const valid = p !== undefined && !this.invalid.has(slot) && this.rt.epoch(slot) > 0n;
    const zero = hlc('0');
    return { valid, untilMonotonic: process.hrtime.bigint() + (valid ? 300_000_000n : 0n), appliedThrough: p ?? zero, reportPosition: p ?? zero, pGrant: p ?? zero };
  }

  async leasedRead(partition: PartitionKey, points: RowRef[]): Promise<Array<unknown | undefined>> {
    if (!this.readLease(this.rt.route(this.rt.kind, partition).slot).valid) throw new NotClosed('no valid read lease (double)');
    return points.map((p) => this.rt.row(p));
  }

  isMovedOut(partition: PartitionKey): boolean {
    return this.rt.isMovedOut(partition);
  }

  async replicaRule3Check(_accountSlot: SlotNo, _requestKey: Uint8Array): Promise<{ holderLive: boolean; rows?: unknown }> {
    return { holderLive: this.holderLive, ...(this.rule3Rows !== undefined ? { rows: this.rule3Rows } : {}) };
  }
}
