/**
 * KafkaBus and KafkaPublisher on the dev cell: partitioner parity with partitionForKey (MemoryBus), partition
 * growth, the partition guard after growth, end offsets and commits. Each test deletes the topics it creates.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Admin } from '@platformatic/kafka';
import { KafkaBus, KafkaPublisher, partitionForKey, type BusRecord, type BusSubscription } from '../../src/index.ts';
import { devCellSkip } from '../../testing/dev-cell.ts';
import { seededKeys } from '../../testing/seeded-keys.ts';

const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
const SEED = 0x5eed_0002;
const COUNTS = [1, 3, 6, 7, 16];

function tcp(hostPort: string): Promise<boolean> {
  const [host = 'localhost', port = '9092'] = hostPort.split(':');
  return new Promise((resolve) => {
    const s = connect({ host, port: Number(port), timeout: 1_000 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}
const SKIP = devCellSkip((await tcp(BROKERS[0] ?? 'localhost:9092')) ? undefined : `Kafka at ${BROKERS[0]}`);

const open: Array<() => Promise<void>> = [];
const topics: string[] = [];
afterEach(async () => {
  for (const c of open.splice(0).reverse()) await c().catch(() => {});
  const names = topics.splice(0);
  if (names.length === 0) return;
  const admin = new Admin({ clientId: 'itest-cleanup', bootstrapBrokers: BROKERS });
  try { await admin.deleteTopics({ topics: names }); } catch { /* a topic that a failed test did not create */ } finally { await admin.close(); }
});

function newBus(clientId: string): KafkaBus {
  const bus = new KafkaBus({ brokers: BROKERS, clientId });
  open.push(() => bus.close());
  return bus;
}

function topicName(prefix: string): string {
  const t = `${prefix}_${randomBytes(3).toString('hex')}`;
  topics.push(t);
  return t;
}

/** Collect the records of a subscription until `count` arrive; fail after `ms`. `each` gets the subscription. */
async function collect(bus: KafkaBus, groupId: string, topic: string, count: number, ms: number,
  each: (r: BusRecord, sub: Promise<BusSubscription>) => Promise<void> = async () => {}): Promise<BusRecord[]> {
  const got: BusRecord[] = [];
  let ready!: (s: BusSubscription) => void;
  const subscribed = new Promise<BusSubscription>((res) => { ready = res; });
  let done!: () => void;
  const all = new Promise<void>((res) => { done = res; });
  const sub = await bus.subscribe({ groupId, topics: [topic], fromBeginning: true, onRecord: async (r) => {
    got.push(r);
    await each(r, subscribed);
    if (got.length >= count) done();
  } });
  ready(sub);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${ms} ms: ${got.length} of ${count} records of ${topic}`)), ms); });
  try { await Promise.race([all, late]); } finally { clearTimeout(timer); await sub.stop(); }
  return got;
}

test('should place each of 1,000 seeded keys on the partitionForKey partition when the publisher partitioner places it', { timeout: 120_000, skip: SKIP }, async () => {
  const bus = newBus('itest-parity');
  const publisher = new KafkaPublisher({ brokers: BROKERS, clientId: 'itest-parity-holder' });
  open.push(() => publisher.close());
  const keys = seededKeys(SEED);
  for (const n of COUNTS) {
    const topic = topicName(`parity_${n}`);
    await bus.ensureTopic(topic, n);
    await publisher.publish(keys.map((k, i) => ({ topic, key: k, value: new Uint8Array(Buffer.from(String(i))), headers: { i: String(i) } })));
    const got = await collect(bus, `${topic}-reader`, topic, keys.length, 60_000);
    const wrong = got.filter((r) => r.partition !== partitionForKey(r.key ?? new Uint8Array(), n));
    assert.equal(got.length, keys.length, `${n} partitions`);
    assert.deepEqual(wrong.map((r) => Buffer.from(r.headers['i'] ?? []).toString()), [], `seed ${SEED}, ${n} partitions: keys on another partition`);
  }
});

test('should grow a topic and never shrink it when ensurePartitions asks for more or fewer partitions', { timeout: 60_000, skip: SKIP }, async () => {
  const bus = newBus('itest-grow');
  const topic = topicName('grow');
  assert.equal(await bus.partitionCount(topic), 0);
  await bus.ensurePartitions(topic, 2);
  assert.equal(await bus.partitionCount(topic), 2);
  await bus.ensurePartitions(topic, 5);
  assert.equal(await bus.partitionCount(topic), 5);
  await bus.ensurePartitions(topic, 3);
  assert.equal(await bus.partitionCount(topic), 5);
});

test('should write to a new partition and refuse a partition out of range when the topic grows after a produce', { timeout: 60_000, skip: SKIP }, async () => {
  const bus = newBus('itest-grow-produce');
  const topic = topicName('grow_produce');
  await bus.ensureTopic(topic, 2);
  await bus.produce(topic, [{ key: null, value: new Uint8Array([0]), partition: 0 }]);
  await bus.addPartitions(topic, 5);
  await bus.produce(topic, [{ key: null, value: new Uint8Array([4]), partition: 4 }]);
  await assert.rejects(bus.produce(topic, [{ key: null, value: new Uint8Array([5]), partition: 5 }]), { message: `${topic} has no partition 5` });
  assert.deepEqual(await bus.endOffsets(topic), [1n, 0n, 0n, 0n, 1n]);
});

test('should give the end offsets and the committed next offsets when a group commits inside onRecord', { timeout: 60_000, skip: SKIP }, async () => {
  const bus = newBus('itest-commit');
  const topic = topicName('commit');
  const groupId = `${topic}-group`;
  await bus.ensureTopic(topic, 2);
  await bus.produce(topic, [0, 1, 2].map((i) => ({ key: null, value: new Uint8Array([i]), partition: 1, headers: { h: new Uint8Array([0, 255]) } })));
  assert.deepEqual(await bus.endOffsets(topic), [0n, 3n]);
  assert.deepEqual(await bus.committedOffsets(groupId, topic), new Map());
  const got = await collect(bus, groupId, topic, 3, 30_000, async (r, sub) => {
    if (r.offset === 1n) await (await sub).commit(r.topic, r.partition, r.offset + 1n);
  });
  assert.deepEqual(got.map((r) => [r.partition, r.offset, [...(r.value ?? [])], [...(r.headers['h'] ?? [])]]),
    [[1, 0n, [0], [0, 255]], [1, 1n, [1], [0, 255]], [1, 2n, [2], [0, 255]]]);
  assert.deepEqual(await bus.committedOffsets(groupId, topic), new Map([[1, 2n]]));
});
