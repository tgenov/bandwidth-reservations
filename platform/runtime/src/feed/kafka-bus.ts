/** FeedBus on Kafka through kafkajs: idempotent producer with acks=all (C01 §3.5), manual offset commits. */
import { Kafka, logLevel, type Admin, type Consumer, type Producer } from 'kafkajs';
import { partitionForKey, type BusProduceRecord, type BusRecord, type BusSubscribeOptions, type BusSubscription, type FeedBus } from './bus.ts';
import { systemClock, type WallClock } from '../clock.ts';

export interface KafkaBusOptions {
  brokers: string[];
  /** The producing principal's client id, e.g. `<kind>-relay` (C01 §2.5). */
  clientId: string;
  /** How old cached topic metadata can be (a partition-count increase is seen within this time). */
  metadataMaxAgeMs?: number;
  /** The wall clock of the metadata cache (default: the system clock). */
  wallMs?: WallClock;
}

export class KafkaBus implements FeedBus {
  private readonly kafka: Kafka;
  private readonly o: KafkaBusOptions;
  private readonly wallMs: WallClock;
  private producer: Producer | undefined;
  private producerReady: Promise<void> | undefined;
  private admin: Admin | undefined;
  private adminReady: Promise<void> | undefined;
  private readonly counts = new Map<string, { n: number; at: number }>();
  private readonly consumers = new Set<Consumer>();

  constructor(o: KafkaBusOptions) {
    this.o = o;
    this.wallMs = o.wallMs ?? systemClock;
    this.kafka = new Kafka({ clientId: o.clientId, brokers: o.brokers, logLevel: logLevel.NOTHING });
  }

  private async getAdmin(): Promise<Admin> {
    if (!this.admin) {
      this.admin = this.kafka.admin();
      this.adminReady = this.admin.connect();
    }
    await this.adminReady;
    return this.admin;
  }

  private async getProducer(): Promise<Producer> {
    if (!this.producer) {
      this.producer = this.kafka.producer({ idempotent: true, maxInFlightRequests: 1, allowAutoTopicCreation: false });
      this.producerReady = this.producer.connect();
    }
    await this.producerReady;
    return this.producer;
  }

  async ensureTopic(topic: string, partitions: number, opts: { compacted?: boolean } = {}): Promise<void> {
    const admin = await this.getAdmin();
    const configEntries = opts.compacted ? [{ name: 'cleanup.policy', value: 'compact' }] : [];
    await admin.createTopics({ waitForLeaders: true, topics: [{ topic, numPartitions: partitions, configEntries }] });
    this.counts.delete(topic);
  }

  /** Increase the partition count of a topic (never decrease; C01 §2.5, R47-30). */
  async addPartitions(topic: string, count: number): Promise<void> {
    const admin = await this.getAdmin();
    await admin.createPartitions({ topicPartitions: [{ topic, count }] });
    this.counts.delete(topic);
  }

  async ensurePartitions(topic: string, count: number): Promise<void> {
    const n = await this.partitionCount(topic);
    if (n === 0) await this.ensureTopic(topic, count);
    else if (n < count) await this.addPartitions(topic, count);
  }

  async partitionCount(topic: string): Promise<number> {
    const admin = await this.getAdmin();
    try {
      const m = await admin.fetchTopicMetadata({ topics: [topic] });
      const n = m.topics[0]?.partitions.length ?? 0;
      this.counts.set(topic, { n, at: this.wallMs() });
      return n;
    } catch {
      return 0;
    }
  }

  private async cachedCount(topic: string): Promise<number> {
    const c = this.counts.get(topic);
    if (c && this.wallMs() - c.at < (this.o.metadataMaxAgeMs ?? 5_000)) return c.n;
    return this.partitionCount(topic);
  }

  async endOffsets(topic: string): Promise<bigint[]> {
    const admin = await this.getAdmin();
    const offs = await admin.fetchTopicOffsets(topic);
    const out: bigint[] = [];
    for (const o of offs) out[o.partition] = BigInt(o.high);
    return out.map((x) => x ?? 0n);
  }

  async produce(topic: string, records: BusProduceRecord[]): Promise<void> {
    if (records.length === 0) return;
    const producer = await this.getProducer();
    const n = await this.cachedCount(topic);
    if (n === 0) throw new Error(`topic ${topic} does not exist`);
    await producer.send({
      topic, acks: -1,
      messages: records.map((r) => ({
        key: r.key ? Buffer.from(r.key) : null,
        value: r.value ? Buffer.from(r.value) : null,
        headers: Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : Buffer.from(v)])),
        partition: r.partition ?? (r.key ? partitionForKey(r.key, n) : 0),
      })),
    });
  }

  async subscribe(o: BusSubscribeOptions): Promise<BusSubscription> {
    const consumer = this.kafka.consumer({
      groupId: o.groupId, metadataMaxAge: this.o.metadataMaxAgeMs ?? 5_000, allowAutoTopicCreation: false,
      sessionTimeout: 10_000, heartbeatInterval: 1_000, rebalanceTimeout: 10_000,
    });
    await consumer.connect();
    this.consumers.add(consumer);
    for (const topic of o.topics) await consumer.subscribe({ topic, fromBeginning: o.fromBeginning });
    await consumer.run({
      autoCommit: false,
      partitionsConsumedConcurrently: 1,
      eachMessage: async ({ topic, partition, message }) => {
        const headers: Record<string, Uint8Array> = {};
        for (const [k, v] of Object.entries(message.headers ?? {})) {
          if (v === undefined) continue;
          const b = Array.isArray(v) ? v[0] : v;
          if (b !== undefined) headers[k] = new Uint8Array(typeof b === 'string' ? Buffer.from(b, 'utf8') : b);
        }
        const r: BusRecord = {
          topic, partition, offset: BigInt(message.offset),
          key: message.key ? new Uint8Array(message.key) : null,
          value: message.value ? new Uint8Array(message.value) : null,
          headers,
        };
        await o.onRecord(r);
      },
    });
    return {
      commit: async (topic, partition, next) => {
        await consumer.commitOffsets([{ topic, partition, offset: next.toString() }]);
      },
      stop: async () => {
        this.consumers.delete(consumer);
        await consumer.disconnect();
      },
    };
  }

  async committedOffsets(groupId: string, topic: string): Promise<Map<number, bigint>> {
    const admin = await this.getAdmin();
    const out = new Map<number, bigint>();
    const r = await admin.fetchOffsets({ groupId, topics: [topic] });
    for (const t of r) for (const p of t.partitions) if (Number(p.offset) >= 0) out.set(p.partition, BigInt(p.offset));
    return out;
  }

  async close(): Promise<void> {
    for (const c of this.consumers) await c.disconnect().catch(() => {});
    this.consumers.clear();
    if (this.producer) await this.producer.disconnect().catch(() => {});
    if (this.admin) await this.admin.disconnect().catch(() => {});
  }
}
