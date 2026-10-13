/**
 * The closure emitter of one relayed owner kind (C01 §3.6; plan S-PLAT-I1 item 7).
 *
 * R_min is the minimum, over every partition of `cdc.<kind>` that the topic metadata lists, of the relay's
 * acknowledged progress. A partition with no progress record holds R_min back (R47-20). R_min never goes
 * back. For each stream declared with closure, the emitter reads each data partition's end offset AFTER it
 * has R_min (dataHighWater), then writes one marker per destination partition on `<topic>.closure`:
 * ResolvedMarker, or for `closedPerLink` a ClosedMarker(link, t = R_min, feedSeq) for each link whose feed
 * sequence changed, for every link as a heartbeat (10 s), and for every link once after it takes the lease.
 * Only the holder of the emitter slot (`closure_<kind>`, slot 0) emits; its epoch is `emitterEpoch`.
 */
import type { Epoch, HlcTs, OwnerDeclaration, StreamSeq } from '../api.ts';
import { hex } from '../bytes.ts';
import { compareHlc, hlc } from '../hlc.ts';
import { DEFAULT_SESSION_TIMINGS, type SessionTimings } from '../params.ts';
import { Session, sessionShard } from '../session.ts';
import type { OwnerStore } from '../store/types.ts';
import { partitionForKey, type BusSubscription, type FeedBus } from '../feed/bus.ts';
import { cdcTopic, closureTopic, decodeRelayProgress, encodeClosure, relayProgressTopic } from '../feed/wire.ts';
import { systemClock, type WallClock } from '../clock.ts';

/** Feed sequence of each link as of `at` (the `closure_emitter` role's follower read of `<kind>_head.streams`). */
export interface FeedSeqReader {
  feedSeqs(kind: string, stream: string, at: HlcTs, changedAfter: HlcTs | null): Promise<Array<{ link: Uint8Array; feedSeq: StreamSeq }>>;
}

export interface ClosureEmitterOptions {
  bus: FeedBus;
  declaration: OwnerDeclaration;
  /** For the emitter's slot lease (kind `closure_<kind>`, slot 0). */
  store: OwnerStore;
  feedSeqs?: FeedSeqReader;
  heartbeatMs?: number;
  /** The wall clock of the heartbeat (default: the system clock). */
  wallMs?: WallClock;
  pollMs?: number;
  sessionTimings?: Partial<SessionTimings>;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export const emitterSlotKind = (kind: string): string => `closure_${kind}`;

export class ClosureEmitter {
  private readonly o: ClosureEmitterOptions;
  private readonly wallMs: WallClock;
  private readonly kind: string;
  private readonly progress = new Map<number, HlcTs>();
  private sub: BusSubscription | undefined;
  private session: Session;
  private epoch: Epoch | undefined;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private stopped = false;
  private lastR: HlcTs | undefined;
  private lastFull = 0;
  /** Every marker written, for tests. */
  readonly emitted: Array<{ topic: string; partition: number; resolved: HlcTs; dataHighWater: bigint; link?: string; feedSeq?: bigint }> = [];

  constructor(o: ClosureEmitterOptions) {
    this.o = o;
    this.wallMs = o.wallMs ?? systemClock;
    this.kind = o.declaration.kind;
    this.session = new Session(o.store, { ...DEFAULT_SESSION_TIMINGS, ...o.sessionTimings },
      { host: 'closure-emitter', region: 'r1', facility: 'r1a', kind: emitterSlotKind(this.kind) },
      { onRevoked: async () => { this.epoch = undefined; }, onResume: async () => {}, onTick: async () => { await this.acquire(); } });
  }

  /** R_min as last computed (undefined while a partition has no progress). */
  rMin(): HlcTs | undefined {
    return this.lastR;
  }

  emitterEpoch(): Epoch | undefined {
    return this.epoch;
  }

  async start(): Promise<void> {
    await this.session.open();
    this.session.start();
    await this.acquire();
    // Read the compacted progress topic from its beginning, with no committed position.
    this.sub = await this.o.bus.subscribe({
      groupId: `closure-emitter-${this.kind}-${this.session.sessionId}`, topics: [relayProgressTopic(this.kind)], fromBeginning: true,
      onRecord: async (r) => {
        if (!r.value) return;
        const p = decodeRelayProgress(r.value);
        const cur = this.progress.get(p.cdcPartition);
        if (cur === undefined || compareHlc(p.resolved, cur) > 0) this.progress.set(p.cdcPartition, hlc(p.resolved));
      },
    });
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.session.stop();
    await this.sub?.stop();
    while (this.busy) await new Promise((r) => setTimeout(r, 5));
  }

  private async acquire(): Promise<void> {
    if (this.epoch !== undefined) return;
    const k = emitterSlotKind(this.kind);
    const rows = await this.o.store.listSlots(k, [0]);
    const row = rows[0];
    if (!row) return;
    let got: { slot: number; epoch: bigint } | undefined;
    if (row.sessionId === null) got = await this.o.store.acquireFree(k, 0, this.session.sessionId);
    else if (row.sessionId !== this.session.sessionId && (row.sessionExpired || row.sessionRevoked)) {
      got = (await this.o.store.acquireExpired(k, sessionShard(row.sessionId), row.sessionId, [0], this.session.sessionId))[0];
    }
    if (got) {
      this.epoch = got.epoch;
      this.lastFull = 0;            // a new holder writes every link once
      this.o.log?.('closure emitter acquired', { kind: this.kind, epoch: got.epoch.toString() });
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    // Fire and forget: C01 §3.6 closure poll loop. tick() catches and logs every error.
    this.timer = setTimeout(() => void this.tick().finally(() => this.schedule()), this.o.pollMs ?? 200);
    this.timer.unref();
  }

  /** One pass: compute R_min and write the closure markers. Public for tests. */
  async tick(): Promise<void> {
    if (this.busy || this.epoch === undefined || !this.session.leaseLive()) return;
    this.busy = true;
    try {
      const R = await this.computeRMin();
      if (R === undefined) return;
      const advanced = this.lastR === undefined || compareHlc(R, this.lastR) > 0;
      const full = this.wallMs() - this.lastFull >= (this.o.heartbeatMs ?? 10_000);
      if (!advanced && !full) return;
      await this.emit(R, full ? null : (this.lastR ?? null));
      this.lastR = R;
      if (full) this.lastFull = this.wallMs();
    } catch (e) {
      this.o.log?.('closure emitter pass failed', { error: String(e) });
    } finally {
      this.busy = false;
    }
  }

  private async computeRMin(): Promise<HlcTs | undefined> {
    const n = await this.o.bus.partitionCount(cdcTopic(this.kind));
    if (n === 0) return undefined;
    let R: HlcTs | undefined;
    for (let k = 0; k < n; k++) {
      const p = this.progress.get(k);
      if (p === undefined) return undefined;       // R47-20: no progress record ⇒ hold R_min back
      if (R === undefined || compareHlc(p, R) < 0) R = p;
    }
    // R_min never goes back.
    if (R !== undefined && this.lastR !== undefined && compareHlc(R, this.lastR) < 0) return this.lastR;
    return R;
  }

  private async emit(R: HlcTs, changedAfter: HlcTs | null): Promise<void> {
    const epoch = this.epoch as Epoch;
    for (const s of this.o.declaration.streams) {
      if (s.closure === 'none') continue;
      const n = await this.o.bus.partitionCount(s.topic);
      if (n === 0) continue;
      const ct = closureTopic(s.topic);
      if ((await this.o.bus.partitionCount(ct)) < n) await this.o.bus.ensurePartitions(ct, n);
      // Read after R is fixed: every row with ts ≤ R was acknowledged before, so it lies below these offsets.
      const hw = await this.o.bus.endOffsets(s.topic);
      if (s.closure === 'resolved') {
        await this.o.bus.produce(ct, Array.from({ length: n }, (_, d) => ({
          key: null, partition: d,
          value: encodeClosure({ type: 'resolved', m: { dataTopic: s.topic, partitionCount: n, destinationPartition: d, resolved: R, dataHighWater: hw[d] ?? 0n, emitterEpoch: epoch } }),
        })));
        for (let d = 0; d < n; d++) this.emitted.push({ topic: ct, partition: d, resolved: R, dataHighWater: hw[d] ?? 0n });
        continue;
      }
      if (!this.o.feedSeqs) throw new Error(`closedPerLink stream ${s.name} needs a FeedSeqReader`);
      const links = await this.o.feedSeqs.feedSeqs(this.kind, s.name, R, changedAfter);
      if (links.length === 0) continue;
      await this.o.bus.produce(ct, links.map(({ link, feedSeq }) => {
        const d = partitionForKey(link, n);
        this.emitted.push({ topic: ct, partition: d, resolved: R, dataHighWater: hw[d] ?? 0n, link: hex(link), feedSeq });
        return {
          key: link, partition: d,
          value: encodeClosure({ type: 'closed', m: { link, t: R, feedSeq, partitionCount: n, destinationPartition: d, dataHighWater: hw[d] ?? 0n, emitterEpoch: epoch } }),
        };
      }));
    }
  }
}
