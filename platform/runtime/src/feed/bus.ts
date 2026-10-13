/**
 * The message bus that the relay, the closure emitter, the placement feed and the consumer runtime use
 * (C01 §2.5, §3.5, §3.6, §3.8). KafkaBus is the real bus; MemoryBus is for unit tests. Both put a keyed
 * record on the partition that the Kafka default partitioner selects, so the two agree.
 */
import { murmur2 } from '@platformatic/kafka';

/** One record as a consumer gets it. Header values are raw bytes, as Kafka gives them. */
export interface BusRecord {
  topic: string;
  partition: number;
  offset: bigint;
  key: Uint8Array | null;
  value: Uint8Array | null;
  headers: Record<string, Uint8Array>;
}

/** One record to produce. Without `partition`, the key selects the partition (murmur2, as Kafka). */
export interface BusProduceRecord {
  key: Uint8Array | null;
  value: Uint8Array | null;
  headers?: Record<string, string | Uint8Array>;
  partition?: number;
}

export interface BusSubscription {
  /** Commit the next offset to read of one partition for the subscription's group. */
  commit(topic: string, partition: number, nextOffset: bigint): Promise<void>;
  stop(): Promise<void>;
}

export interface BusSubscribeOptions {
  groupId: string;
  topics: string[];
  /** Where a group with no committed offset starts. */
  fromBeginning: boolean;
  /** Called once per record, in offset order per partition; the next record waits for the promise. */
  onRecord(r: BusRecord): Promise<void>;
}

export interface FeedBus {
  ensureTopic(topic: string, partitions: number, opts?: { compacted?: boolean }): Promise<void>;
  /** Create the topic, or grow it to at least `count` partitions (never shrink). */
  ensurePartitions(topic: string, count: number): Promise<void>;
  /** Partition count from the topic metadata (0 if the topic does not exist). */
  partitionCount(topic: string): Promise<number>;
  /** End offset (the next offset to be written) of each partition. */
  endOffsets(topic: string): Promise<bigint[]>;
  /** Produce with acks=all; resolves after every record is acknowledged. */
  produce(topic: string, records: BusProduceRecord[]): Promise<void>;
  subscribe(o: BusSubscribeOptions): Promise<BusSubscription>;
  /** The group's committed next offset per partition (partitions without a commit are absent). */
  committedOffsets(groupId: string, topic: string): Promise<Map<number, bigint>>;
  close(): Promise<void>;
}

/**
 * The Kafka default partitioner for a keyed record: toPositive(murmur2(key)) mod count, as the Java client.
 * The library's murmur2 gives the signed Java hash; `& 0x7fffffff` is Java `Utils.toPositive`.
 */
export function partitionForKey(key: Uint8Array, count: number): number {
  if (count <= 0) throw new Error('partition count must be positive');
  return (murmur2(Buffer.from(key.buffer, key.byteOffset, key.byteLength)) & 0x7fffffff) % count;
}

/**
 * The partition of one record on a topic with `count` partitions: the record's own partition, else the
 * key's partition, else 0. A partition that is not in [0, count) is an error. Do not let a client use it
 * modulo the count, because then the record goes to a different partition with no error.
 */
export function targetPartition(topic: string, r: BusProduceRecord, count: number): number {
  const p = r.partition ?? (r.key ? partitionForKey(r.key, count) : 0);
  if (!Number.isInteger(p) || p < 0 || p >= count) throw new Error(`${topic} has no partition ${p}`);
  return p;
}

/** Header values to bytes (strings as UTF-8). */
export function headerBytes(h: Record<string, string | Uint8Array> | undefined): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k] = typeof v === 'string' ? new Uint8Array(Buffer.from(v, 'utf8')) : v;
  return out;
}
