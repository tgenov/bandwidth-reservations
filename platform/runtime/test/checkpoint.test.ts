/**
 * Checkpoint store (RFC-006 §12.11; C01 putCheckpoint/getCheckpoint, §3.12 last line, §5 row putCheckpoint).
 * The same object-store suite runs against MemoryObjectStore and FileObjectStore.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevSealer } from '../src/sealer.ts';
import { fromHex, utf8 } from '../src/bytes.ts';
import {
  CHECKPOINT, CheckpointError, CheckpointStore, FileObjectStore, MemoryObjectStore, type ObjectStore,
} from '../src/checkpoint/store.ts';

const T0 = 1_760_000_000_000;
const HOUR = 3_600_000;
const KIND = 'link';
const PART = fromHex('0a0b0c');
const PART_HEX = '0a0b0c';
const OTHER_PART = fromHex('ff');

type Alert = { alertKind: 'DIGEST_MISMATCH'; reference: string; detail: string };

function steppedClock(start = T0): { now: () => number; set: (ms: number) => void } {
  let t = start;
  return { now: () => t, set: (ms) => { t = ms; } };
}

const sha256 = (b: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(b).digest());

function body(n: number, size = 4_096): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 7 + n) % 251;
  return out;
}

/** Counts the calls to an object store; passes every call through. */
class CountingObjectStore implements ObjectStore {
  puts = 0; gets = 0; lists = 0; deletes = 0;
  private readonly inner: ObjectStore;
  constructor(inner: ObjectStore) { this.inner = inner; }
  async put(key: string, b: Uint8Array): Promise<void> { this.puts++; await this.inner.put(key, b); }
  async get(key: string): Promise<Uint8Array | undefined> { this.gets++; return this.inner.get(key); }
  async list(prefix: string): Promise<Array<{ key: string; writtenAtMs: number }>> { this.lists++; return this.inner.list(prefix); }
  async delete(key: string): Promise<void> { this.deletes++; await this.inner.delete(key); }
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CheckpointError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

type MakeObjects = (clock: () => number) => Promise<ObjectStore>;
const STORES: Array<[string, MakeObjects]> = [
  ['MemoryObjectStore', async (clock) => new MemoryObjectStore({ wallMs: clock })],
  ['FileObjectStore', async (clock) => {
    const dir = await mkdtemp(join(tmpdir(), 'ckpt-test-'));
    dirs.push(dir);
    return new FileObjectStore({ dir, wallMs: clock });
  }],
];

for (const [name, make] of STORES) {
  describe(`object store: ${name}`, () => {
    test('should return the same bytes when an object is read after put', async () => {
      const objects = await make(() => T0);
      await objects.put('a/b:c/1', utf8('one'));
      assert.deepEqual(await objects.get('a/b:c/1'), utf8('one'));
    });

    test('should return undefined when the object does not exist', async () => {
      const objects = await make(() => T0);
      assert.equal(await objects.get('none/1'), undefined);
    });

    test('should list only the keys with the prefix with the clock time of the write when objects are listed', async () => {
      const clock = steppedClock();
      const objects = await make(clock.now);
      await objects.put('p/x:1/1', utf8('1'));
      clock.set(T0 + 5);
      await objects.put('p/x:1/2', utf8('2'));
      await objects.put('p/x:2/1', utf8('3'));
      await objects.put('q/x:1/1', utf8('4'));
      const listed = (await objects.list('p/x:1/')).sort((a, b) => a.key.localeCompare(b.key));
      assert.deepEqual(listed, [{ key: 'p/x:1/1', writtenAtMs: T0 }, { key: 'p/x:1/2', writtenAtMs: T0 + 5 }]);
    });

    test('should keep keys with slash, colon, percent and dots apart when they differ only in those characters', async () => {
      const objects = await make(() => T0);
      const keys = ['a/b', 'a:b', 'a%2Fb', 'a%3Ab', '..', '.', 'a/../b'];
      for (const [i, k] of keys.entries()) await objects.put(k, utf8(String(i)));
      for (const [i, k] of keys.entries()) assert.deepEqual(await objects.get(k), utf8(String(i)));
      assert.equal((await objects.list('')).length, keys.length);
    });

    test('should remove the object and its listing entry when the object is deleted', async () => {
      const objects = await make(() => T0);
      await objects.put('d/1', utf8('1'));
      await objects.put('d/2', utf8('2'));
      await objects.delete('d/1');
      assert.equal(await objects.get('d/1'), undefined);
      assert.deepEqual(await objects.get('d/2'), utf8('2'));
      assert.deepEqual((await objects.list('d/')).map((o) => o.key), ['d/2']);
    });

    test('should not throw when a missing object is deleted', async () => {
      const objects = await make(() => T0);
      await objects.delete('missing');
      assert.deepEqual(await objects.list(''), []);
    });
  });

  describe(`checkpoint store on ${name}`, () => {
    async function setup(region = 'R1', clock = steppedClock()) {
      const inner = await make(clock.now);
      const objects = new CountingObjectStore(inner);
      const alerts: Alert[] = [];
      const sealer = new DevSealer();
      const store = new CheckpointStore({ region, objects, sealer, wallMs: clock.now, alert: (a) => alerts.push(a) });
      return { store, objects, inner, alerts, clock, sealer };
    }

    test('should return the plain bytes and the sha-256 digest when a checkpoint is put and then read', async () => {
      const { store, alerts } = await setup();
      const bytes = body(1);
      const put = await store.put(KIND, PART, 42n, bytes);
      assert.equal(put.reference, `ckpt:R1:link:${PART_HEX}:42`);
      assert.deepEqual(put.digest, sha256(bytes));
      assert.deepEqual(await store.get(put.reference), bytes);
      assert.deepEqual(alerts, []);
    });

    test('should seal the stored object under the partition log key when a checkpoint is put', async () => {
      const { store, inner, sealer } = await setup();
      const bytes = utf8('plain-checkpoint-marker-'.repeat(50));
      await store.put(KIND, PART, 7n, bytes);
      const [obj] = await inner.list('');
      assert.ok(obj);
      const stored = await inner.get(obj.key);
      assert.ok(stored);
      assert.equal(Buffer.from(stored).includes(Buffer.from('plain-checkpoint-marker-')), false);
      const sealed = stored.subarray(32);
      const ctx = { ownerKind: KIND, table: 'link_log', primaryKey: { partition: PART_HEX, seq: '7', object: 'checkpoint' }, seqOrVersion: 7n, epoch: 0n, rowKind: 'checkpoint' };
      assert.deepEqual(sealer.open(sealed, ctx), bytes);
      assert.throws(() => sealer.open(sealed, { ...ctx, seqOrVersion: 8n }));
    });

    test('should return the same reference and digest and write nothing when the same checkpoint is put again', async () => {
      const { store, objects, inner, alerts, clock } = await setup();
      const bytes = body(2);
      const first = await store.put(KIND, PART, 5n, bytes);
      const before = await inner.list('');
      clock.set(T0 + HOUR);
      const second = await store.put(KIND, PART, 5n, bytes);
      assert.deepEqual(second, first);
      assert.equal(objects.puts, 1);
      assert.deepEqual(await inner.list(''), before);
      assert.deepEqual(alerts, []);
    });

    test('should throw DIGEST_MISMATCH and alert once and keep the object when other bytes are put for the same seq', async () => {
      const { store, objects, inner, alerts } = await setup();
      const first = await store.put(KIND, PART, 5n, body(3));
      const [obj] = await inner.list('');
      assert.ok(obj);
      const storedBefore = await inner.get(obj.key);
      assert.equal(await codeOf(store.put(KIND, PART, 5n, body(4))), 'DIGEST_MISMATCH');
      assert.equal(objects.puts, 1);
      assert.deepEqual(await inner.get(obj.key), storedBefore);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0]?.alertKind, 'DIGEST_MISMATCH');
      assert.equal(alerts[0]?.reference, first.reference);
      assert.deepEqual(await store.get(first.reference), body(3));
    });

    test('should throw DIGEST_MISMATCH and alert when the sealed part of the stored object is changed', async () => {
      const { store, inner, alerts } = await setup();
      const { reference } = await store.put(KIND, PART, 9n, body(5));
      const [obj] = await inner.list('');
      assert.ok(obj);
      const stored = await inner.get(obj.key);
      assert.ok(stored);
      const bad = new Uint8Array(stored);
      bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0x01;
      await inner.put(obj.key, bad);
      assert.equal(await codeOf(store.get(reference)), 'DIGEST_MISMATCH');
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0]?.reference, reference);
    });

    test('should throw DIGEST_MISMATCH and alert when the stored digest does not match the opened bytes', async () => {
      const { store, inner, alerts } = await setup();
      const { reference } = await store.put(KIND, PART, 9n, body(6));
      const [obj] = await inner.list('');
      assert.ok(obj);
      const stored = await inner.get(obj.key);
      assert.ok(stored);
      const bad = new Uint8Array(stored);
      bad[0] = (bad[0] ?? 0) ^ 0x01;
      await inner.put(obj.key, bad);
      assert.equal(await codeOf(store.get(reference)), 'DIGEST_MISMATCH');
      assert.equal(alerts.length, 1);
    });

    test('should throw DIGEST_MISMATCH and alert when the stored object is shorter than a digest and a seal', async () => {
      const { store, inner, alerts } = await setup();
      const { reference } = await store.put(KIND, PART, 9n, body(6));
      const [obj] = await inner.list('');
      assert.ok(obj);
      await inner.put(obj.key, new Uint8Array(10));
      assert.equal(await codeOf(store.get(reference)), 'DIGEST_MISMATCH');
      assert.equal(alerts.length, 1);
    });

    test('should throw OTHER_REGION and read no object when the reference names another region', async () => {
      const { store, objects, alerts } = await setup('R1');
      await store.put(KIND, PART, 1n, body(1));
      const getsBefore = objects.gets;
      assert.equal(await codeOf(store.get(`ckpt:R2:link:${PART_HEX}:1`)), 'OTHER_REGION');
      assert.equal(objects.gets, getsBefore);
      assert.deepEqual(alerts, []);
    });

    test('should throw NOT_FOUND when no object exists for the reference', async () => {
      const { store, alerts } = await setup();
      assert.equal(await codeOf(store.get(`ckpt:R1:link:${PART_HEX}:1`)), 'NOT_FOUND');
      assert.deepEqual(alerts, []);
    });

    test('should throw BAD_REFERENCE and read no object when the reference is malformed', async () => {
      const { store, objects } = await setup();
      for (const ref of ['', 'ckpt:R1:link:0a0b0c', 'ckpt:R1:link:0a0b0c:1:x', 'chk:R1:link:0a0b0c:1', 'ckpt::link:0a0b0c:1',
        'ckpt:R1::0a0b0c:1', 'ckpt:R1:link::1', 'ckpt:R1:link:0a0:1', 'ckpt:R1:link:0A0B:1', 'ckpt:R1:link:0a0b0c:-1',
        'ckpt:R1:link:0a0b0c:01', 'ckpt:R1:link:0a0b0c:1.5', 'ckpt:R1:link:0a0b0c:']) {
        assert.equal(await codeOf(store.get(ref)), 'BAD_REFERENCE', ref);
      }
      assert.equal(objects.gets, 0);
    });

    test('should throw BAD_REFERENCE and write nothing when the put arguments cannot form a reference', async () => {
      const { store, objects } = await setup();
      assert.equal(await codeOf(store.put('a:b', PART, 1n, body(1))), 'BAD_REFERENCE');
      assert.equal(await codeOf(store.put('', PART, 1n, body(1))), 'BAD_REFERENCE');
      assert.equal(await codeOf(store.put(KIND, new Uint8Array(0), 1n, body(1))), 'BAD_REFERENCE');
      assert.equal(await codeOf(store.put(KIND, PART, -1n, body(1))), 'BAD_REFERENCE');
      assert.equal(objects.puts, 0);
    });

    test('should keep the last 3 checkpoints and all younger than 48 h and delete the rest when a partition is pruned', async () => {
      const { store, inner, clock } = await setup();
      for (let s = 1n; s <= 6n; s++) {
        clock.set(T0 + Number(s) * HOUR);
        await store.put(KIND, PART, s, body(Number(s)));
      }
      clock.set(T0);
      await store.put(KIND, OTHER_PART, 1n, body(9));
      clock.set(T0 + 4 * HOUR + CHECKPOINT.keepMs);
      const deleted = await store.prune(KIND, PART);
      assert.deepEqual(deleted.sort(), [`ckpt:R1:link:${PART_HEX}:1`, `ckpt:R1:link:${PART_HEX}:2`, `ckpt:R1:link:${PART_HEX}:3`]);
      assert.equal(await codeOf(store.get(`ckpt:R1:link:${PART_HEX}:3`)), 'NOT_FOUND');
      for (const s of [4, 5, 6]) assert.deepEqual(await store.get(`ckpt:R1:link:${PART_HEX}:${s}`), body(s));
      assert.deepEqual(await store.get('ckpt:R1:link:ff:1'), body(9));
      assert.equal((await inner.list('')).length, 4);
    });

    test('should keep a checkpoint 1 ms younger than 48 h and delete one exactly 48 h old when it is not in the last 3', async () => {
      const { store, clock } = await setup();
      clock.set(T0);
      await store.put(KIND, PART, 1n, body(1));
      clock.set(T0 + 1);
      await store.put(KIND, PART, 2n, body(2));
      clock.set(T0 + 2 * HOUR);
      for (const s of [3n, 4n, 5n]) await store.put(KIND, PART, s, body(Number(s)));
      clock.set(T0 + CHECKPOINT.keepMs);
      assert.deepEqual(await store.prune(KIND, PART), [`ckpt:R1:link:${PART_HEX}:1`]);
      assert.deepEqual(await store.get(`ckpt:R1:link:${PART_HEX}:2`), body(2));
    });

    test('should order by seq as a number and not as text when the last 3 are chosen', async () => {
      const { store, clock } = await setup();
      for (const s of [2n, 9n, 10n, 11n]) await store.put(KIND, PART, s, body(Number(s)));
      clock.set(T0 + CHECKPOINT.keepMs);
      assert.deepEqual(await store.prune(KIND, PART), [`ckpt:R1:link:${PART_HEX}:2`]);
    });

    test('should delete nothing when the partition has 3 checkpoints or fewer', async () => {
      const { store, objects, clock } = await setup();
      for (const s of [1n, 2n, 3n]) await store.put(KIND, PART, s, body(Number(s)));
      clock.set(T0 + 10 * CHECKPOINT.keepMs);
      assert.deepEqual(await store.prune(KIND, PART), []);
      assert.equal(objects.deletes, 0);
    });
  });
}

test('should keep the last 3 checkpoints and 48 h when the retention constant is read', () => {
  assert.deepEqual(CHECKPOINT, { keepLast: 3, keepMs: 48 * 3_600_000 });
});
