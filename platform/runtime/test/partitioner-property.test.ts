/**
 * Partitioner parity: partitionForKey (MemoryBus, KafkaBus) and the client's compatibilityPartitioner
 * (KafkaPublisher) select the Java default partition, toPositive(murmur2(key)) mod count. The oracles are
 * the Kafka UtilsTest vectors and the kafkajs port of Java Utils.murmur2 (a dev dependency only).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { compatibilityPartitioner, defaultPartitioner, murmur2 } from '@platformatic/kafka';
import { partitionForKey } from '../src/index.ts';
import { seededKeys } from '../testing/seeded-keys.ts';

const require = createRequire(import.meta.url);
const javaMurmur2 = require('kafkajs/src/producer/partitioners/default/murmur2.js') as (key: Buffer) => number;
const javaPartition = (key: Buffer, n: number): number => (javaMurmur2(key) & 0x7fffffff) % n;

const SEED = 0x5eed_2026;
const COUNTS = [1, 2, 3, 4, 5, 6, 7, 12, 16, 31, 64, 100];
const keys = seededKeys(SEED).map((k) => Buffer.from(k));

test('should give the hash of Kafka Utils.murmur2 when the key is a Kafka UtilsTest vector', () => {
  const vectors: Array<[string, number]> = [
    ['21', -973932308], ['foobar', -790332482], ['a-little-bit-long-string', -985981536],
    ['a-little-bit-longer-string', -1486304829], ['lkjh234lh9fiuh90y23oiuhsafujhadof229phr9h19h89h8', -58897971], ['abc', 479470107],
  ];
  assert.deepEqual(vectors.map(([k]) => murmur2(Buffer.from(k))), vectors.map(([, h]) => h));
  assert.deepEqual(vectors.map(([k]) => javaMurmur2(Buffer.from(k))), vectors.map(([, h]) => h));
});

test('should select the java default partition for every seeded key and partition count when partitionForKey hashes a key', () => {
  assert.equal(keys.length, 1_000);
  for (const n of COUNTS) for (const [i, k] of keys.entries()) {
    assert.equal(partitionForKey(new Uint8Array(k), n), javaPartition(k, n), `seed ${SEED}, key #${i} ${k.toString('hex')}, ${n} partitions`);
  }
});

test('should select the java default partition for every seeded key and partition count when the client uses compatibilityPartitioner', () => {
  for (const n of COUNTS) for (const [i, k] of keys.entries()) {
    // The producer uses the partitioner's result modulo the partition count.
    assert.equal(compatibilityPartitioner({ topic: 't', value: k }, k) % n, javaPartition(k, n), `seed ${SEED}, key #${i} ${k.toString('hex')}, ${n} partitions`);
  }
});

test('should select a different partition than java for some keys when the client uses its default partitioner', () => {
  // The default is murmur2 >>> 0 (unsigned), not toPositive: a negative hash maps elsewhere unless n divides 2^31.
  for (const n of [3, 6, 7, 12, 100]) {
    const differ = keys.filter((k) => defaultPartitioner({ topic: 't', value: k }, k) % n !== javaPartition(k, n)).length;
    assert.ok(differ > 0, `seed ${SEED}: the default partitioner agrees with java on all ${keys.length} keys for ${n} partitions`);
  }
  for (const n of [1, 2, 4, 16, 64]) {
    const differ = keys.filter((k) => defaultPartitioner({ topic: 't', value: k }, k) % n !== javaPartition(k, n)).length;
    assert.equal(differ, 0, `seed ${SEED}: with ${n} partitions (a power of two) the two partitioners agree`);
  }
});
