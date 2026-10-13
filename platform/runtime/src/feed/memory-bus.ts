/**
 * An in-memory bus with Kafka's partition, offset and consumer-group behaviour, for unit tests.
 * Tests can add partitions (a partition-count increase), fail produces and look at every record.
 */
import { headerBytes, targetPartition, type BusProduceRecord, type BusRecord, type BusSubscribeOptions, type BusSubscription, type FeedBus } from './bus.ts';

interface MemTopic { partitions: BusRecord[][]; compacted: boolean }

export class MemoryBus implements FeedBus {
  readonly topics = new Map<string, MemTopic>();
  /** group → "topic|partition" → next offset. */
  readonly committed = new Map<string, Map<string, bigint>>();
  /** Fail the next N produce calls (the records are not written). */
  failProduce = 0;
  /** Create a topic with this many partitions on the first produce to an unknown topic. */
  autoCreatePartitions = 1;
  private readonly subs = new Set<MemSub>();

  async ensureTopic(topic: string, partitions: number, opts: { compacted?: boolean } = {}): Promise<void> {
    const t = this.topics.get(topic);
    if (!t) this.topics.set(topic, { partitions: Array.from({ length: partitions }, () => []), compacted: opts.compacted ?? false });
  }

  async ensurePartitions(topic: string, count: number): Promise<void> {
    if (!this.topics.has(topic)) await this.ensureTopic(topic, count);
    else this.addPartitions(topic, count);
  }

  /** Increase the partition count (never decrease), as an operator can in Kafka (C01 §2.5, R47-30). */
  addPartitions(topic: string, count: number): void {
    const t = this.topics.get(topic);
    if (!t) throw new Error(`no topic ${topic}`);
    while (t.partitions.length < count) t.partitions.push([]);
    this.wake();
  }

  async partitionCount(topic: string): Promise<number> {
    return this.topics.get(topic)?.partitions.length ?? 0;
  }

  async endOffsets(topic: string): Promise<bigint[]> {
    return (this.topics.get(topic)?.partitions ?? []).map((p) => BigInt(p.length));
  }

  records(topic: string, partition?: number): BusRecord[] {
    const t = this.topics.get(topic);
    if (!t) return [];
    return partition === undefined ? t.partitions.flat() : (t.partitions[partition] ?? []);
  }

  async produce(topic: string, records: BusProduceRecord[]): Promise<void> {
    if (this.failProduce > 0) { this.failProduce -= 1; throw new Error('injected produce failure'); }
    if (!this.topics.has(topic)) await this.ensureTopic(topic, this.autoCreatePartitions);
    const t = this.topics.get(topic) as MemTopic;
    for (const r of records) {
      const p = targetPartition(topic, r, t.partitions.length);
      const part = t.partitions[p];
      if (!part) throw new Error(`${topic} has no partition ${p}`);
      part.push({ topic, partition: p, offset: BigInt(part.length), key: r.key, value: r.value, headers: headerBytes(r.headers) });
    }
    this.wake();
  }

  async subscribe(o: BusSubscribeOptions): Promise<BusSubscription> {
    const s = new MemSub(this, o);
    this.subs.add(s);
    s.kick();
    return {
      commit: async (topic, partition, next) => { this.commit(o.groupId, topic, partition, next); },
      stop: async () => { this.subs.delete(s); await s.stop(); },
    };
  }

  commit(group: string, topic: string, partition: number, next: bigint): void {
    let g = this.committed.get(group);
    if (!g) { g = new Map(); this.committed.set(group, g); }
    const k = `${topic}|${partition}`;
    if ((g.get(k) ?? -1n) < next) g.set(k, next);
  }

  async committedOffsets(group: string, topic: string): Promise<Map<number, bigint>> {
    const out = new Map<number, bigint>();
    for (const [k, v] of this.committed.get(group) ?? []) {
      const [t, p] = k.split('|');
      if (t === topic) out.set(Number(p), v);
    }
    return out;
  }

  committedOffset(group: string, topic: string, partition: number): bigint | undefined {
    return this.committed.get(group)?.get(`${topic}|${partition}`);
  }

  async close(): Promise<void> {
    for (const s of this.subs) await s.stop();
    this.subs.clear();
  }

  private wake(): void {
    for (const s of this.subs) s.kick();
  }
}

class MemSub {
  private readonly bus: MemoryBus;
  private readonly o: BusSubscribeOptions;
  /** "topic|partition" → next offset to deliver. */
  private readonly pos = new Map<string, bigint>();
  /** Partition count of each topic at subscribe time; a partition added later starts at offset 0. */
  private readonly initialCount = new Map<string, number>();
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(bus: MemoryBus, o: BusSubscribeOptions) {
    this.bus = bus;
    this.o = o;
    for (const t of o.topics) {
      const n = bus.topics.get(t)?.partitions.length ?? 0;
      this.initialCount.set(t, n);
      // Fix the start positions now, as Kafka does at assignment, not at the first delivery.
      for (let p = 0; p < n; p++) this.start(t, p);
    }
  }

  kick(): void {
    if (this.stopped) return;
    if (this.running) { this.again = true; return; }
    this.running = (async () => {
      do {
        this.again = false;
        await new Promise((r) => setImmediate(r));
        await this.deliverAll();
      } while (this.again && !this.stopped);
      this.running = null;
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  private start(topic: string, partition: number): bigint {
    const k = `${topic}|${partition}`;
    let p = this.pos.get(k);
    if (p === undefined) {
      const c = this.bus.committedOffset(this.o.groupId, topic, partition);
      const added = partition >= (this.initialCount.get(topic) ?? 0);
      p = c ?? (this.o.fromBeginning || added ? 0n : BigInt(this.bus.records(topic, partition).length));
      this.pos.set(k, p);
    }
    return p;
  }

  private async deliverAll(): Promise<void> {
    let progressed = true;
    while (progressed && !this.stopped) {
      progressed = false;
      for (const topic of this.o.topics) {
        const t = this.bus.topics.get(topic);
        if (!t) continue;
        for (let p = 0; p < t.partitions.length; p++) {
          const at = this.start(topic, p);
          const rec = t.partitions[p]?.[Number(at)];
          if (!rec || this.stopped) continue;
          this.pos.set(`${topic}|${p}`, at + 1n);
          await this.o.onRecord(rec);
          progressed = true;
        }
      }
    }
  }
}
