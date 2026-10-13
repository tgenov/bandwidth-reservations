/**
 * The consumer runtime (C01 §3.4 rules 8–11, §3.5, §3.6; plan S-PLAT-I1 item 8).
 *
 * - `subscribe` gives feed events in stream_seq order per (producer partition, stream). It buffers later
 *   events, drops lower ones (duplicates of the direct, relay and republish paths) and, if the next event
 *   does not arrive in gap_timeout (5 s), reads it from the producer's outbox (gap fill).
 * - Content conflict (D3): a second copy of one (partition, stream, stream_seq) with other bytes blocks the
 *   stream at that stream_seq and raises FEED_CONTENT_CONFLICT; the database copy is read and wins. A late
 *   conflicting copy is compared with the database copy: if the applied copy was the database's, the stream
 *   continues; if not, it stays blocked (the owner's correction path applies).
 * - Gate `reported`: an event with a `slot` header waits for a report marker of that slot with
 *   epoch ≥ the event's epoch and reportPosition ≥ its ts. For the gate only, a marker at or below the last
 *   one seen is ignored.
 * - `onMarker` gets every report marker, kept by (slot, epoch, reportPosition, chunk.part); only an exact
 *   copy is dropped (N-01).
 * - `onResolved` / `onClosed` fire once the position on the destination data partition has passed the
 *   marker's dataHighWater and every buffered event of that partition with ts ≤ R has been delivered.
 * - Kafka offsets are committed only below the first record not yet delivered, dropped or replaced, so a
 *   consumer that stops and restarts loses nothing (X2-S02).
 */
import type { FeedCheckpoint, FeedEvent, HlcTs, PartitionKey, ReportMarker, SlotNo, StreamSeq } from '../api.ts';
import { hex } from '../bytes.ts';
import { compareHlc, hlc } from '../hlc.ts';
import type { Sealer } from '../sealer.ts';
import type { BusRecord, BusSubscription, FeedBus } from '../feed/bus.ts';
import {
  closureTopic, decodeClosure, decodeMarker, feedEventDigest, isMarkerEvent, markerKey, markerSealContext, outboxHeadersToFeed,
  recordToFeedEvent, topicKind,
} from '../feed/wire.ts';
import type { GapFillRow, GapFillSource } from './gapfill.ts';

export interface ConsumerAlert {
  alertKind: 'FEED_CONTENT_CONFLICT';
  topic: string;
  partition: string;
  stream: string;
  streamSeq: bigint;
  paths: string[];
}

export interface FeedConsumerOptions {
  bus: FeedBus;
  /** Consumer group prefix; each subscription uses `<groupId>.<topic>`. */
  groupId: string;
  sealer: Sealer;
  gapFill?: GapFillSource;
  gapTimeoutMs?: number;
  /** Delay before a failed handler or gap-fill read runs again. */
  retryMs?: number;
  alert?: (a: ConsumerAlert) => void;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Producer kind of a topic, for gap fill (default: the topic's first segment; set it for contract topics). */
  producerOf?: (topic: string) => string;
}

interface Src { partition: number; offset: bigint }

interface Pending {
  e: FeedEvent;
  digest: string;
  ts: HlcTs;
  epoch: bigint;
  slot: SlotNo | undefined;
  /** Kafka copies of this event that wait for it (their offsets are committed when it is delivered). */
  srcs: Src[];
  fromDb: boolean;
}

interface StreamState {
  partition: Uint8Array;
  stream: string;
  next: bigint;
  buffer: Map<bigint, Pending>;
  /** stream_seq → digest of the applied copy (recent ones and the checkpoint's). */
  applied: Map<bigint, string>;
  /** Blocked at this stream_seq: until the conflict read answers, or for good (`permanent`). */
  blocked: { seq: bigint; permanent: boolean } | null;
  gapTimer: NodeJS.Timeout | undefined;
}

const APPLIED_KEEP = 4_096;

class TopicSubscription {
  readonly topic: string;
  private readonly c: FeedConsumerOptions;
  private readonly gate: 'committed' | 'reported';
  private readonly handler: (e: FeedEvent) => Promise<void>;
  private readonly streams = new Map<string, StreamState>();
  private readonly checkpoint = new Map<string, { seq: bigint; digest?: string }>();
  private readonly gateMarkers = new Map<SlotNo, { epoch: bigint; position: HlcTs }>();
  private readonly outstanding = new Map<number, Set<bigint>>();
  private readonly consumedNext = new Map<number, bigint>();
  private readonly lastCommitted = new Map<number, bigint>();
  private readonly resolvedPending = new Map<number, { R: HlcTs; hw: bigint }>();
  private readonly resolvedFired = new Map<number, HlcTs>();
  private readonly closedPending = new Map<string, { link: Uint8Array; t: HlcTs; feedSeq: StreamSeq; d: number; hw: bigint }>();
  private readonly closedFired = new Map<string, HlcTs>();
  readonly resolvedHandlers: Array<(d: number, R: HlcTs) => void> = [];
  readonly closedHandlers: Array<(link: PartitionKey, t: HlcTs, feedSeq: StreamSeq) => void> = [];
  private sub: BusSubscription | undefined;
  private closureSub: BusSubscription | undefined;
  private chain: Promise<void> = Promise.resolve();
  private commitTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  /** Delivered events in order (tests). */
  delivered = 0;

  constructor(topic: string, from: FeedCheckpoint, gate: 'committed' | 'reported', handler: (e: FeedEvent) => Promise<void>, c: FeedConsumerOptions) {
    this.topic = topic;
    this.gate = gate;
    this.handler = handler;
    this.c = c;
    for (const p of from.positions) {
      this.checkpoint.set(`${hex(p.partition)}|${p.stream}`, { seq: p.streamSeq, ...(p.digest ? { digest: hex(p.digest) } : {}) });
    }
  }

  get groupId(): string {
    return `${this.c.groupId}.${this.topic}`;
  }

  async start(): Promise<void> {
    const committed = await this.c.bus.committedOffsets(this.groupId, this.topic);
    for (const [p, o] of committed) { this.consumedNext.set(p, o); this.lastCommitted.set(p, o); }
    this.sub = await this.c.bus.subscribe({
      groupId: this.groupId, topics: [this.topic], fromBeginning: true,
      onRecord: (r) => this.serial(() => this.onRecord(r)),
    });
  }

  /** Subscribe to `<topic>.closure` (once) for onResolved and onClosed. */
  private closureStarting: Promise<void> | undefined;

  startClosure(): Promise<void> {
    this.closureStarting ??= this.openClosure();
    return this.closureStarting;
  }

  private async openClosure(): Promise<void> {
    if (this.stopped) return;
    this.closureSub = await this.c.bus.subscribe({
      groupId: `${this.groupId}.closure`, topics: [closureTopic(this.topic)], fromBeginning: false,
      onRecord: (r) => this.serial(async () => this.onClosure(r)),
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const st of this.streams.values()) if (st.gapTimer) clearTimeout(st.gapTimer);
    if (this.commitTimer) clearTimeout(this.commitTimer);
    await this.sub?.stop();
    await this.closureSub?.stop();
    await this.chain;
    await this.commitNow();
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch((e: unknown) => this.c.log?.('consumer step failed', { topic: this.topic, error: String(e) }));
    return next;
  }

  // ---------------- records ----------------

  private async onRecord(r: BusRecord): Promise<void> {
    if (this.stopped) return;
    const next = r.offset + 1n;
    if ((this.consumedNext.get(r.partition) ?? -1n) < next) this.consumedNext.set(r.partition, next);
    let set = this.outstanding.get(r.partition);
    if (!set) { set = new Set(); this.outstanding.set(r.partition, set); }
    set.add(r.offset);
    const src: Src = { partition: r.partition, offset: r.offset };
    const e = recordToFeedEvent(r);
    if (isMarkerEvent(e)) {
      this.onGateMarker(e);
      this.finish([src]);
      await this.drainAll();
    } else if (e.headers.stream === undefined || e.headers.stream_seq === undefined) {
      this.finish([src]);                       // a notification: delivered by onNotification, not here
    } else {
      await this.onEvent(e, src);
    }
    this.evaluateClosure();
    this.scheduleCommit();
  }

  private streamOf(partition: Uint8Array, stream: string): StreamState {
    const k = `${hex(partition)}|${stream}`;
    let st = this.streams.get(k);
    if (!st) {
      const cp = this.checkpoint.get(k);
      st = { partition, stream, next: (cp?.seq ?? 0n) + 1n, buffer: new Map(), applied: new Map(), blocked: null, gapTimer: undefined };
      if (cp?.digest) st.applied.set(cp.seq, cp.digest);
      this.streams.set(k, st);
    }
    return st;
  }

  private pending(e: FeedEvent, srcs: Src[], fromDb: boolean): Pending {
    const slot = e.headers.slot === undefined ? undefined : Number(e.headers.slot);
    return { e, digest: feedEventDigest(e), ts: hlc(e.headers.ts), epoch: BigInt(e.headers.epoch), slot, srcs, fromDb };
  }

  private async onEvent(e: FeedEvent, src: Src): Promise<void> {
    const st = this.streamOf(e.headers.partition, e.headers.stream as string);
    const seq = BigInt(e.headers.stream_seq as string);
    const p = this.pending(e, [src], false);
    if (seq < st.next) {
      // Lower than the next expected: a duplicate copy of an applied event.
      this.finish([src]);
      const applied = st.applied.get(seq);
      if (applied !== undefined && applied !== p.digest) await this.lateConflict(st, seq, applied);
      return;
    }
    const have = st.buffer.get(seq);
    if (have) {
      if (have.digest === p.digest) { have.srcs.push(src); return; }   // a byte-identical copy
      if (have.fromDb) { this.finish([src]); this.raise(st, seq, ['database', 'feed']); return; }
      have.srcs.push(src);
      await this.conflict(st, seq);
      return;
    }
    st.buffer.set(seq, p);
    await this.drain(st);
  }

  // ---------------- ordered delivery ----------------

  private covered(p: Pending): boolean {
    if (this.gate !== 'reported' || p.slot === undefined) return true;
    const m = this.gateMarkers.get(p.slot);
    return m !== undefined && m.epoch >= p.epoch && compareHlc(m.position, p.ts) >= 0;
  }

  private async drain(st: StreamState): Promise<void> {
    while (!this.stopped) {
      if (st.blocked && st.blocked.seq <= st.next) break;
      const p = st.buffer.get(st.next);
      if (!p || !this.covered(p)) break;
      try {
        await this.handler(p.e);
      } catch (err) {
        this.c.log?.('feed handler failed; retrying', { topic: this.topic, error: String(err) });
        // Fire and forget: serial() logs a failed step (C01 §3.5 consumer retry).
        setTimeout(() => void this.serial(() => this.drain(st)), this.c.retryMs ?? 1_000).unref();
        return;
      }
      this.delivered += 1;
      st.applied.set(st.next, p.digest);
      if (st.applied.size > APPLIED_KEEP) st.applied.delete(st.applied.keys().next().value as bigint);
      st.buffer.delete(st.next);
      this.finish(p.srcs);
      st.next += 1n;
    }
    if (st.buffer.size === 0 || st.buffer.has(st.next)) {
      if (st.gapTimer) { clearTimeout(st.gapTimer); st.gapTimer = undefined; }
    } else {
      this.armGap(st);
    }
  }

  private async drainAll(): Promise<void> {
    for (const st of this.streams.values()) await this.drain(st);
  }

  // ---------------- gap fill ----------------

  private armGap(st: StreamState): void {
    if (st.gapTimer || !this.c.gapFill || this.stopped) return;
    st.gapTimer = setTimeout(() => {
      st.gapTimer = undefined;
      void this.serial(() => this.fillGap(st));   // fire and forget: serial() logs a failed step (C01 §3.5 gap fill)
    }, this.c.gapTimeoutMs ?? 5_000);
    st.gapTimer.unref();
  }

  private async fillGap(st: StreamState): Promise<void> {
    if (this.stopped || st.buffer.size === 0 || st.buffer.has(st.next) || !this.c.gapFill) return;
    const top = [...st.buffer.keys()].reduce((a, b) => (a > b ? a : b));
    let rows: GapFillRow[];
    try {
      rows = await this.c.gapFill.read((this.c.producerOf ?? topicKind)(this.topic), st.partition, st.stream, st.next, top);
    } catch (e) {
      this.c.log?.('gap fill read failed', { topic: this.topic, error: String(e) });
      rows = [];
    }
    for (const row of rows) {
      if (row.streamSeq < st.next) continue;
      const p = this.pending({ headers: outboxHeadersToFeed(row.headers), value: row.payload }, [], true);
      const have = st.buffer.get(row.streamSeq);
      if (have && have.digest !== p.digest) {
        // The database copy wins over a buffered copy (D3).
        this.raise(st, row.streamSeq, ['feed', 'database']);
        p.srcs = have.srcs;
        st.buffer.set(row.streamSeq, p);
      } else if (!have) {
        st.buffer.set(row.streamSeq, p);
      }
    }
    await this.drain(st);
    this.evaluateClosure();
    this.scheduleCommit();
  }

  // ---------------- content conflict (D3) ----------------

  private raise(st: StreamState, seq: bigint, paths: string[]): void {
    this.c.alert?.({ alertKind: 'FEED_CONTENT_CONFLICT', topic: this.topic, partition: hex(st.partition), stream: st.stream, streamSeq: seq, paths });
    this.c.log?.('FEED_CONTENT_CONFLICT', { topic: this.topic, partition: hex(st.partition), stream: st.stream, seq: seq.toString() });
  }

  private async readDb(st: StreamState, seq: bigint): Promise<Pending | undefined> {
    if (!this.c.gapFill) return undefined;
    for (let attempt = 0; attempt < 50 && !this.stopped; attempt++) {
      try {
        const rows = await this.c.gapFill.read((this.c.producerOf ?? topicKind)(this.topic), st.partition, st.stream, seq, seq);
        const row = rows[0];
        if (row) return this.pending({ headers: outboxHeadersToFeed(row.headers), value: row.payload }, [], true);
      } catch (e) {
        this.c.log?.('conflict read failed', { error: String(e) });
      }
      await new Promise((r) => setTimeout(r, this.c.retryMs ?? 1_000));
    }
    return undefined;
  }

  /** Two buffered copies differ: block at seq, read the database copy, apply only it. */
  private async conflict(st: StreamState, seq: bigint): Promise<void> {
    st.blocked = { seq, permanent: false };
    const srcs = st.buffer.get(seq)?.srcs ?? [];
    this.raise(st, seq, ['direct', 'relay']);
    const db = await this.readDb(st, seq);
    if (!db) { st.blocked = { seq, permanent: true }; return; }
    db.srcs = srcs;
    st.buffer.set(seq, db);
    st.blocked = null;
    await this.drain(st);
  }

  /** A copy that differs from the applied one arrives late: continue only if the applied copy was the database's. */
  private async lateConflict(st: StreamState, seq: bigint, appliedDigest: string): Promise<void> {
    this.raise(st, seq, ['applied', 'late copy']);
    const db = await this.readDb(st, seq);
    if (db && db.digest === appliedDigest) return;
    st.blocked = { seq: st.next, permanent: true };
    this.c.log?.('stream blocked: the applied copy is not the database copy', { topic: this.topic, seq: seq.toString() });
  }

  /** True when a stream is blocked (tests). */
  isBlocked(partition: Uint8Array, stream: string): boolean {
    const st = this.streams.get(`${hex(partition)}|${stream}`);
    return st !== undefined && st.blocked !== null;
  }

  // ---------------- gate markers ----------------

  private onGateMarker(e: FeedEvent): void {
    const slot = Number(e.headers.slot);
    const position = hlc(e.headers.report_through as string);
    const epoch = BigInt(e.headers.epoch);
    const last = this.gateMarkers.get(slot);
    if (last && compareHlc(position, last.position) <= 0) return;      // the monotone drop (gate only)
    this.gateMarkers.set(slot, { epoch: last && last.epoch > epoch ? last.epoch : epoch, position });
  }

  // ---------------- closure ----------------

  private onClosure(r: BusRecord): void {
    if (!r.value) return;
    const c = decodeClosure(r.value);
    if (c.type === 'resolved') {
      const d = c.m.destinationPartition;
      const fired = this.resolvedFired.get(d);
      const pend = this.resolvedPending.get(d);
      const R = hlc(c.m.resolved);
      if ((fired && compareHlc(R, fired) <= 0) || (pend && compareHlc(R, pend.R) <= 0)) return;
      this.resolvedPending.set(d, { R, hw: BigInt(c.m.dataHighWater) });
    } else {
      const k = hex(c.m.link);
      const t = hlc(c.m.t);
      const fired = this.closedFired.get(k);
      const pend = this.closedPending.get(k);
      if ((fired && compareHlc(t, fired) <= 0) || (pend && compareHlc(t, pend.t) <= 0)) return;
      this.closedPending.set(k, { link: c.m.link, t, feedSeq: BigInt(c.m.feedSeq), d: c.m.destinationPartition, hw: BigInt(c.m.dataHighWater) });
    }
    this.evaluateClosure();
  }

  /** Every buffered (undelivered) event at or below R that may sit on partition d has been delivered. */
  private clear(d: number, R: HlcTs, hw: bigint): boolean {
    if ((this.consumedNext.get(d) ?? 0n) < hw) return false;
    for (const st of this.streams.values()) {
      for (const p of st.buffer.values()) {
        if (compareHlc(p.ts, R) > 0) continue;
        if (p.srcs.length === 0 || p.srcs.some((s) => s.partition === d)) return false;
      }
    }
    return true;
  }

  private evaluateClosure(): void {
    for (const [d, p] of this.resolvedPending) {
      if (!this.clear(d, p.R, p.hw)) continue;
      this.resolvedPending.delete(d);
      this.resolvedFired.set(d, p.R);
      for (const h of this.resolvedHandlers) h(d, p.R);
    }
    for (const [k, p] of this.closedPending) {
      if (!this.clear(p.d, p.t, p.hw)) continue;
      this.closedPending.delete(k);
      this.closedFired.set(k, p.t);
      for (const h of this.closedHandlers) h(p.link, p.t, p.feedSeq);
    }
  }

  // ---------------- offsets ----------------

  private finish(srcs: Src[]): void {
    for (const s of srcs) this.outstanding.get(s.partition)?.delete(s.offset);
  }

  private scheduleCommit(): void {
    if (this.commitTimer || this.stopped) return;
    // Fire and forget: commitNow() logs a failed offset commit; the next commit covers it (C01 §3.5).
    this.commitTimer = setTimeout(() => { this.commitTimer = undefined; void this.commitNow(); }, 50);
    this.commitTimer.unref();
  }

  private async commitNow(): Promise<void> {
    for (const [p, consumed] of this.consumedNext) {
      const set = this.outstanding.get(p);
      let next = consumed;
      for (const o of set ?? []) if (o < next) next = o;
      if ((this.lastCommitted.get(p) ?? -1n) >= next) continue;
      try {
        await this.sub?.commit(this.topic, p, next);
        this.lastCommitted.set(p, next);
      } catch (e) {
        this.c.log?.('offset commit failed', { error: String(e) });
      }
    }
  }
}

/** Subscription of onMarker: every marker of the outcome feed, de-duplicated by its key only (N-01). */
class MarkerSubscription {
  private readonly topic: string;
  private readonly c: FeedConsumerOptions;
  readonly handlers: Array<(m: ReportMarker) => Promise<void>> = [];
  private readonly seen = new Set<string>();
  private sub: BusSubscription | undefined;

  constructor(topic: string, c: FeedConsumerOptions) {
    this.topic = topic;
    this.c = c;
  }

  async start(): Promise<void> {
    this.sub = await this.c.bus.subscribe({
      groupId: `${this.c.groupId}.${this.topic}.markers`, topics: [this.topic], fromBeginning: true,
      onRecord: async (r) => {
        const e = recordToFeedEvent(r);
        if (isMarkerEvent(e)) {
          const m = this.open(e);
          const k = markerKey(m);
          if (!this.seen.has(k)) {
            for (const h of this.handlers) await h(m);
            this.seen.add(k);
          }
        }
        await this.sub?.commit(r.topic, r.partition, r.offset + 1n);
      },
    });
  }

  private open(e: FeedEvent): ReportMarker {
    const ctx = markerSealContext(topicKind(this.topic), Number(e.headers.slot), e.headers.stream ?? '', BigInt(e.headers.stream_seq ?? '0'), BigInt(e.headers.epoch));
    return decodeMarker(this.c.sealer.open(e.value, ctx));
  }

  async stop(): Promise<void> {
    await this.sub?.stop();
  }
}

/** The consumer side of OwnerRuntime: subscribe, onResolved, onClosed, onMarker. */
export class FeedConsumerRuntime {
  private readonly c: FeedConsumerOptions;
  private readonly topics = new Map<string, TopicSubscription>();
  private readonly markerSubs = new Map<string, MarkerSubscription>();
  private readonly resolved = new Map<string, Array<(d: number, R: HlcTs) => void>>();
  private readonly closed: Array<(link: PartitionKey, t: HlcTs, feedSeq: StreamSeq) => void> = [];
  private readonly starts: Array<Promise<void>> = [];

  constructor(c: FeedConsumerOptions) {
    this.c = c;
  }

  private track(p: Promise<void>, what: string): void {
    this.starts.push(p.catch((e: unknown) => this.c.log?.(`${what} failed to start`, { error: String(e) })));
  }

  subscribe(topic: string, from: FeedCheckpoint, gate: 'committed' | 'reported', handler: (e: FeedEvent) => Promise<void>): void {
    if (this.topics.has(topic)) throw new Error(`already subscribed to ${topic}`);
    const s = new TopicSubscription(topic, from, gate, handler, this.c);
    this.topics.set(topic, s);
    s.resolvedHandlers.push(...(this.resolved.get(topic) ?? []));
    s.closedHandlers.push(...this.closed);
    this.track(s.start().then(() => (s.resolvedHandlers.length + s.closedHandlers.length > 0 ? s.startClosure() : undefined)), `subscribe ${topic}`);
  }

  onResolved(topic: string, handler: (d: number, R: HlcTs) => void): void {
    this.resolved.set(topic, [...(this.resolved.get(topic) ?? []), handler]);
    const s = this.topics.get(topic);
    if (s) { s.resolvedHandlers.push(handler); this.track(s.startClosure(), `closure ${topic}`); }
  }

  onClosed(handler: (link: PartitionKey, t: HlcTs, feedSeq: StreamSeq) => void): void {
    this.closed.push(handler);
    for (const s of this.topics.values()) { s.closedHandlers.push(handler); this.track(s.startClosure(), `closure ${s.topic}`); }
  }

  onMarker(topic: string, handler: (m: ReportMarker) => Promise<void>): void {
    let m = this.markerSubs.get(topic);
    if (!m) {
      m = new MarkerSubscription(topic, this.c);
      this.markerSubs.set(topic, m);
      this.track(m.start(), `onMarker ${topic}`);
    }
    m.handlers.push(handler);
  }

  /** Resolves when every subscription made so far has started. */
  async ready(): Promise<void> {
    await Promise.all(this.starts);
  }

  subscription(topic: string): TopicSubscription | undefined {
    return this.topics.get(topic);
  }

  async stop(): Promise<void> {
    await this.ready();
    for (const s of this.topics.values()) await s.stop();
    for (const m of this.markerSubs.values()) await m.stop();
  }
}
