/**
 * A test bus that joins runtime doubles (one for each owner kind) and the provider doubles.
 *
 * - Direct publish: the events that each double published after `Committed`.
 * - Relay: the changefeed relay, which derives events from the committed log rows only
 *   (RFC-006 §3.5). The runtime double has no relay, so the bus is the relay in tests.
 * - Resolved markers: after the bus has delivered every committed row, it gives each topic a
 *   marker at the virtual "now" (the closure emitter of C01 §3.6, one destination partition).
 */
import type { FeedEvent, PartitionKey, StreamSeq } from '@share/owner-runtime';
import { hlc, hlcFromWallMs, utf8 } from '@share/owner-runtime';
import { feedEvent, type DoubleLogEntry, type RuntimeDouble } from '@share/owner-runtime/testing';

type Listener = (event: unknown, fe: FeedEvent) => Promise<void> | void;

interface Registered { name: string; rt: RuntimeDouble; publishedIdx: number }

interface Relay {
  rt: RuntimeDouble;
  topic: string;
  stream: string;
  /** Derive the event of a log row; default: the row's committed outbox rows (its emits). */
  derive?: (row: DoubleLogEntry, streamSeq: StreamSeq) => unknown;
  last: Map<string, bigint>;
}

export class Bus {
  nowMs: number;
  private logical = 0;
  private readonly doubles: Registered[] = [];
  private readonly idles: Array<() => Promise<void>> = [];
  private readonly listeners = new Map<string, Listener[]>();
  private readonly relays: Relay[] = [];
  private readonly extSeq = new Map<string, bigint>();
  private readonly topics = new Set<string>();
  /** Topics whose direct publish is stopped (C11 test 12; plan I1 exit criterion 2). */
  readonly directOff = new Set<string>();
  /** Every delivery, in order: (topic, event, path). */
  readonly deliveries: Array<{ topic: string; event: unknown; path: 'direct' | 'relay' | 'external' }> = [];

  constructor(startMs: number) {
    this.nowMs = startMs;
  }

  register(name: string, rt: RuntimeDouble, idle?: () => Promise<void>): void {
    this.doubles.push({ name, rt, publishedIdx: 0 });
    if (idle) this.idles.push(idle);
  }

  addIdle(idle: () => Promise<void>): void {
    this.idles.push(idle);
  }

  on(topic: string, l: Listener): void {
    this.topics.add(topic);
    const list = this.listeners.get(topic) ?? [];
    list.push(l);
    this.listeners.set(topic, list);
  }

  /** Add the changefeed relay of a stream of a double. */
  relay(rt: RuntimeDouble, topic: string, stream: string, derive?: Relay['derive']): void {
    this.relays.push(derive ? { rt, topic, stream, derive, last: new Map() } : { rt, topic, stream, last: new Map() });
  }

  /** An external producer (provisioning, the account owner, settlement) publishes one event. */
  async publish(topic: string, key: string, stream: string, event: unknown): Promise<void> {
    const k = `${topic}|${key}`;
    const seq = (this.extSeq.get(k) ?? 0n) + 1n;
    this.extSeq.set(k, seq);
    this.logical += 1;
    const ts = hlc(`${BigInt(this.nowMs) * 1_000_000n}.${String(this.logical).padStart(10, '0')}`);
    await this.deliver(topic, feedEvent({ partition: utf8(key), stream, streamSeq: seq, event, ts }), event, 'external');
  }

  private async deliver(topic: string, fe: FeedEvent, event: unknown, path: 'direct' | 'relay' | 'external'): Promise<void> {
    this.topics.add(topic);
    this.deliveries.push({ topic, event, path });
    for (const d of this.doubles) await d.rt.deliver(topic, fe);
    for (const l of this.listeners.get(topic) ?? []) await l(event, fe);
  }

  private feedOf(rt: RuntimeDouble, partition: PartitionKey, stream: string, streamSeq: StreamSeq, event: unknown): FeedEvent {
    const row = rt.log(partition).find((e) => e.streamSeqs.some((s) => s.stream === stream && s.streamSeq === streamSeq));
    return feedEvent({ partition, stream, streamSeq, event, ...(row ? { ts: row.ts, generation: row.generation, epoch: row.epoch } : {}) });
  }

  /** Deliver what is new. Returns true if anything moved. */
  async pump(): Promise<boolean> {
    let moved = false;
    for (const d of this.doubles) {
      while (d.publishedIdx < d.rt.published.length) {
        const p = d.rt.published[d.publishedIdx++];
        if (!p) continue;
        moved = true;
        if (this.directOff.has(p.topic)) continue;
        await this.deliver(p.topic, this.feedOf(d.rt, p.partition, p.stream, p.streamSeq, p.event), p.event, 'direct');
      }
    }
    for (const r of this.relays) {
      const partitions = new Map<string, PartitionKey>();
      for (const a of r.rt.appends) partitions.set(Buffer.from(a.call.partition).toString('hex'), a.call.partition);
      for (const [hx, partition] of partitions) {
        for (const row of r.rt.log(partition)) {
          for (const s of row.streamSeqs) {
            if (s.stream !== r.stream || s.streamSeq <= (r.last.get(hx) ?? 0n)) continue;
            r.last.set(hx, s.streamSeq);
            const idx = row.streamSeqs.indexOf(s);
            const event = r.derive ? r.derive(row, s.streamSeq) : row.entry.emits?.[idx]?.event;
            moved = true;
            await this.deliver(r.topic, this.feedOf(r.rt, partition, r.stream, s.streamSeq, event), event, 'relay');
          }
        }
      }
    }
    return moved;
  }

  private async drain(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      for (const idle of this.idles) await idle();
      const moved = await this.pump();
      for (const idle of this.idles) await idle();
      if (!moved) return;
    }
    throw new Error('the bus did not settle');
  }

  /** Deliver until nothing moves, then give resolved markers at "now" on every topic, and deliver again. */
  async settle(): Promise<void> {
    await this.drain();
    const R = hlcFromWallMs(this.nowMs);
    for (const topic of this.topics) for (const d of this.doubles) d.rt.resolve(topic, 0, R);
    await this.drain();
  }

  /** Move the virtual clock of every double (timers fire) and settle at each step. */
  async advance(ms: number, stepMs = 1_000, each?: () => Promise<void>): Promise<void> {
    let left = ms;
    while (left > 0) {
      const step = Math.min(stepMs, left);
      this.nowMs += step;
      for (const d of this.doubles) d.rt.advance(step);
      left -= step;
      if (each) await each();
      await this.settle();
    }
  }

  /** Move the clock without settling at each step (a long idle time with no timers due). */
  async jump(ms: number): Promise<void> {
    this.nowMs += ms;
    for (const d of this.doubles) d.rt.advance(ms);
    await this.settle();
  }

  /** The events delivered on a topic (all paths), in order. */
  eventsOn<T>(topic: string): T[] {
    return this.deliveries.filter((d) => d.topic === topic).map((d) => d.event as T);
  }
}
