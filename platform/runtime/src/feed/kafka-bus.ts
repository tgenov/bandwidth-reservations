/**
 * FeedBus on Kafka through @platformatic/kafka: idempotent producer with acks=all (C01 §3.5), manual offset
 * commits. This is the only place that uses the Kafka client for the bus (E-001).
 */
import { Admin, Consumer, Producer, ProduceAcks, UserError, compatibilityPartitioner, findErrorBy, type MessagesStream } from '@platformatic/kafka';
import { targetPartition, type BusProduceRecord, type BusRecord, type BusSubscribeOptions, type BusSubscription, type FeedBus } from './bus.ts';
import { systemClock, type WallClock } from '../clock.ts';
import { waitForTopicLeaders, type TopicMetadataFetch } from './topic-leaders.ts';

export interface KafkaBusOptions {
  brokers: string[];
  /** The producing principal's client id, e.g. `<kind>-relay` (C01 §2.5). */
  clientId: string;
  /** How old cached topic metadata can be (a partition-count increase is seen within this time). */
  metadataMaxAgeMs?: number;
  /** The wall clock of the wait for topic leaders (default: the system clock). */
  wallMs?: WallClock;
}

/** Records keep a null key or value as null (a tombstone), not as an empty buffer. */
type Bytes = Buffer | null;

/** The delay before a subscription consumes again after onRecord or the fetch failed. */
const RESTART_DELAY_MS = 300;

/** True when the client reports that the topic is not in the broker metadata (yet). */
function isUnknownTopic(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  // The client gives UNKNOWN_TOPIC_OR_PARTITION in a metadata answer as a UserError without the protocol code.
  if (e instanceof UserError && e.message.startsWith('Unknown topic ')) return true;
  return findErrorBy(e, 'apiId', 'UNKNOWN_TOPIC_OR_PARTITION') !== null;
}

/** Header values to the client's form: a map of UTF-8 names to bytes. */
function clientHeaders(h: Record<string, string | Uint8Array> | undefined): Map<Buffer, Buffer> {
  return new Map(Object.entries(h ?? {}).map(([k, v]) => [Buffer.from(k, 'utf8'), typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v)]));
}

export class KafkaBus implements FeedBus {
  private readonly o: KafkaBusOptions;
  private readonly wallMs: WallClock;
  private producer: Producer<Bytes, Bytes, Buffer, Buffer> | undefined;
  private admin: Admin | undefined;
  private readonly subs = new Set<BusSubscription>();

  constructor(o: KafkaBusOptions) {
    this.o = o;
    this.wallMs = o.wallMs ?? systemClock;
  }

  private base(): { clientId: string; bootstrapBrokers: string[]; metadataMaxAge: number } {
    return { clientId: this.o.clientId, bootstrapBrokers: this.o.brokers, metadataMaxAge: this.o.metadataMaxAgeMs ?? 5_000 };
  }

  private getAdmin(): Admin {
    this.admin ??= new Admin({ ...this.base(), autocreateTopics: false });
    return this.admin;
  }

  private getProducer(): Producer<Bytes, Bytes, Buffer, Buffer> {
    // The Java-compatible partitioner (E-001 §9). The client's default partitioner is not Java-compatible.
    this.producer ??= new Producer<Bytes, Bytes, Buffer, Buffer>({
      ...this.base(), idempotent: true, acks: ProduceAcks.ALL, autocreateTopics: false, maxInflights: 1,
      partitioner: compatibilityPartitioner,
    });
    return this.producer;
  }

  private readonly fetchLeaders: TopicMetadataFetch = async (topic) => {
    try {
      const m = await this.getAdmin().metadata({ topics: [topic], forceUpdate: true, retries: 0 });
      const t = m.topics.get(topic);
      return { topics: t ? [{ name: topic, partitions: t.partitions.map((p, i) => ({ partitionId: i, leader: p.leader })) }] : [] };
    } catch (e) {
      if (isUnknownTopic(e)) throw Object.assign(new Error(`topic ${topic} is not in the metadata`), { type: 'UNKNOWN_TOPIC_OR_PARTITION' });
      if (e instanceof Error && findErrorBy(e, 'apiId', 'LEADER_NOT_AVAILABLE')) throw Object.assign(new Error(`topic ${topic} has no leader`), { type: 'LEADER_NOT_AVAILABLE' });
      throw e;
    }
  };

  async ensureTopic(topic: string, partitions: number, opts: { compacted?: boolean } = {}): Promise<void> {
    const configs = opts.compacted ? [{ name: 'cleanup.policy', value: 'compact' }] : [];
    let created = true;
    try {
      await this.getAdmin().createTopics({ topics: [topic], partitions, replicas: -1, configs });
    } catch (e) {
      if (!(e instanceof Error) || !findErrorBy(e, 'apiId', 'TOPIC_ALREADY_EXISTS')) throw e;
      created = false;
    }
    // A topic that existed keeps its own partition count; wait for the leaders of what it has.
    await waitForTopicLeaders(this.fetchLeaders, topic, created ? partitions : 1, { wallMs: this.wallMs });
  }

  /** Increase the partition count of a topic (never decrease; C01 §2.5, R47-30). */
  async addPartitions(topic: string, count: number): Promise<void> {
    await this.getAdmin().createPartitions({ topics: [{ name: topic, count }] });
    // The broker answers before its metadata shows the new partitions. Wait, so that the next
    // partitionCount or produce sees them.
    await waitForTopicLeaders(this.fetchLeaders, topic, count, { wallMs: this.wallMs });
  }

  async ensurePartitions(topic: string, count: number): Promise<void> {
    const n = await this.partitionCount(topic);
    if (n === 0) await this.ensureTopic(topic, count);
    else if (n < count) await this.addPartitions(topic, count);
  }

  async partitionCount(topic: string): Promise<number> {
    const admin = this.getAdmin();
    try {
      // The client retries an unknown topic (3 times, 1 s apart). For this question it is an answer: 0.
      const m = await admin.metadata({ topics: [topic], forceUpdate: true, retries: 0 }).catch((e: unknown) => {
        if (isUnknownTopic(e)) throw e;
        return admin.metadata({ topics: [topic], forceUpdate: true });
      });
      return m.topics.get(topic)?.partitionsCount ?? 0;
    } catch {
      return 0;
    }
  }

  /** The partition count in the producer's own metadata, which the producer uses when it sends. */
  private async producerCount(topic: string, forceUpdate: boolean): Promise<number> {
    try {
      const m = await this.getProducer().metadata({ topics: [topic], forceUpdate });
      return m.topics.get(topic)?.partitionsCount ?? 0;
    } catch (e) {
      if (isUnknownTopic(e)) return 0;
      throw e;
    }
  }

  async endOffsets(topic: string): Promise<bigint[]> {
    const n = await this.partitionCount(topic);
    if (n === 0) throw new Error(`topic ${topic} does not exist`);
    const partitions = Array.from({ length: n }, (_, partitionIndex) => ({ partitionIndex, timestamp: -1n }));
    const r = await this.getAdmin().listOffsets({ topics: [{ name: topic, partitions }] });
    const out: bigint[] = new Array<bigint>(n).fill(0n);
    for (const t of r) for (const p of t.partitions) out[p.partitionIndex] = p.offset;
    return out;
  }

  async produce(topic: string, records: BusProduceRecord[]): Promise<void> {
    if (records.length === 0) return;
    // Select the partitions with the partition count that the producer sends with. The client uses a
    // partition modulo its own count, so a count from a different metadata cache can move a record.
    let n = await this.producerCount(topic, false);
    if (records.some((r) => r.partition !== undefined && r.partition >= n)) n = await this.producerCount(topic, true);
    if (n === 0) throw new Error(`topic ${topic} does not exist`);
    const messages = records.map((r) => ({
      topic, partition: targetPartition(topic, r, n),
      key: r.key ? Buffer.from(r.key) : null,
      value: r.value ? Buffer.from(r.value) : null,
      headers: clientHeaders(r.headers),
    }));
    await this.getProducer().send({ messages });
  }

  async subscribe(o: BusSubscribeOptions): Promise<BusSubscription> {
    const consumer = new Consumer<Bytes, Bytes, Buffer, Buffer>({
      ...this.base(), groupId: o.groupId, autocommit: false, autocreateTopics: false,
      sessionTimeout: 10_000, heartbeatInterval: 1_000, rebalanceTimeout: 10_000,
    });
    let stopped = false;
    const open = (): Promise<MessagesStream<Bytes, Bytes, Buffer, Buffer>> => consumer.consume({
      topics: o.topics, mode: 'committed', fallbackMode: o.fromBeginning ? 'earliest' : 'latest', autocommit: false,
    });
    let stream: MessagesStream<Bytes, Bytes, Buffer, Buffer> | undefined;
    try {
      stream = await open();
    } catch (e) {
      await consumer.close().catch(() => {});
      throw e;
    }
    // One record at a time over all assigned partitions, so the order per partition is the offset order.
    // After a failure, consume again from the committed offsets (at least once).
    const loop = (async () => {
      while (!stopped) {
        try {
          stream ??= await open();
          for await (const m of stream) {
            if (stopped) break;
            const headers: Record<string, Uint8Array> = {};
            for (const [k, v] of m.headers) headers[k.toString('utf8')] = new Uint8Array(v);
            const r: BusRecord = {
              topic: m.topic, partition: m.partition, offset: m.offset,
              key: m.key ? new Uint8Array(m.key) : null,
              value: m.value ? new Uint8Array(m.value) : null,
              headers,
            };
            await o.onRecord(r);
          }
          stream = undefined;
        } catch {
          if (stopped) break;
          await stream?.close().catch(() => {});
          stream = undefined;
          await new Promise((res) => setTimeout(res, RESTART_DELAY_MS));
        }
      }
    })();
    const sub: BusSubscription = {
      commit: async (topic, partition, next) => {
        await consumer.commit({ offsets: [{ topic, partition, offset: next, leaderEpoch: -1 }] });
      },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        this.subs.delete(sub);
        await stream?.close().catch(() => {});
        await loop;
        await consumer.close().catch(() => {});
      },
    };
    this.subs.add(sub);
    return sub;
  }

  async committedOffsets(groupId: string, topic: string): Promise<Map<number, bigint>> {
    const out = new Map<number, bigint>();
    const r = await this.getAdmin().listConsumerGroupOffsets({ groups: [groupId] });
    for (const g of r) for (const t of g.topics) if (t.name === topic) {
      for (const p of t.partitions) if (p.committedOffset >= 0n) out.set(p.partitionIndex, p.committedOffset);
    }
    return out;
  }

  async close(): Promise<void> {
    for (const s of [...this.subs]) await s.stop().catch(() => {});
    if (this.producer) await this.producer.close().catch(() => {});
    if (this.admin) await this.admin.close().catch(() => {});
  }
}
