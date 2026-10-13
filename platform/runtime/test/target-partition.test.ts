/** The partition guard of KafkaBus and MemoryBus: a record never goes to a partition that is not in [0, count). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBus, partitionForKey, targetPartition } from '../src/index.ts';

const KEY = new Uint8Array(Buffer.from('link-7'));

test('should use the record partition when the record names a partition in range', () => {
  assert.equal(targetPartition('t', { key: KEY, value: null, partition: 0 }, 4), 0);
  assert.equal(targetPartition('t', { key: KEY, value: null, partition: 3 }, 4), 3);
});

test('should use the key partition when the record names no partition', () => {
  assert.equal(targetPartition('t', { key: KEY, value: null }, 7), partitionForKey(KEY, 7));
});

test('should use partition 0 when the record has no key and no partition', () => {
  assert.equal(targetPartition('t', { key: null, value: null }, 4), 0);
});

test('should refuse the record when its partition is the partition count or more', () => {
  assert.throws(() => targetPartition('t', { key: null, value: null, partition: 4 }, 4), { message: 't has no partition 4' });
  assert.throws(() => targetPartition('t', { key: KEY, value: null, partition: 9 }, 4), { message: 't has no partition 9' });
});

test('should refuse the record when its partition is negative or not an integer', () => {
  assert.throws(() => targetPartition('t', { key: null, value: null, partition: -1 }, 4), { message: 't has no partition -1' });
  assert.throws(() => targetPartition('t', { key: null, value: null, partition: 1.5 }, 4), { message: 't has no partition 1.5' });
});

test('should write no record when MemoryBus gets a partition out of range', async () => {
  const bus = new MemoryBus();
  await bus.ensureTopic('t', 2);
  await assert.rejects(bus.produce('t', [{ key: null, value: null, partition: 2 }]), { message: 't has no partition 2' });
  assert.deepEqual(await bus.endOffsets('t'), [0n, 0n]);
});
