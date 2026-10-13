import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CockroachOwnerRuntime, ManualLoad, MemoryPublisher, utf8, validateDeclaration } from '@share/owner-runtime';
import { MemoryStore, RuntimeDouble, RESULTS } from '@share/owner-runtime/testing';
import { kindMigration } from '@share/owner-migrate';
import { CanaryOwner, declaration } from '../src/index.ts';

test('CC-8: the canary declaration validates and generates its tables', () => {
  assert.deepEqual(validateDeclaration(declaration), []);
  const sql = kindMigration(declaration).statements.join('\n');
  assert.match(sql, /canary_counter/);
  assert.match(sql, /canary_applied/);
});

test('canary on the runtime double: counts once per id; Retry/Ambiguous are retried with the same identity', async () => {
  const rt = new RuntimeDouble({ declaration });
  const owner = new CanaryOwner(rt);
  rt.attach(owner);
  const p = utf8('c1');
  rt.scriptAppend(RESULTS.Ambiguous(), RESULTS.Retry());
  await owner.increment(p, 'a');
  assert.equal(rt.appends.length, 3);
  assert.equal(rt.log(p).length, 1);
  rt.scriptAppend(RESULTS.Stopped());
  assert.deepEqual(await owner.increment(p, 'b'), { ok: false, reason: 'unavailable' });
});

test('canary on the real runtime core (memory store): counter and idempotency', async () => {
  const store = new MemoryStore();
  store.seedSlots('canary', declaration.slotCount);
  const publisher = new MemoryPublisher();
  const rt = new CockroachOwnerRuntime({ declaration, store, publisher, load: new ManualLoad(),
    slots: Array.from({ length: 16 }, (_, i) => i) });
  const owner = new CanaryOwner(rt);
  await rt.start(owner);
  const p = utf8('c1');
  // The memory store's consistentRead returns no rows, so check the committed log and projection directly.
  for (const id of ['a', 'b', 'a']) await owner.increment(p, id);
  const logRows = store.log.filter((l) => Buffer.from(l.partition).toString() === 'c1');
  assert.equal(logRows.length, 2, 'the repeated id is not counted twice');
  const counter = [...store.rows.entries()].find(([k]) => k.startsWith('canary_counter|'));
  assert.equal((counter?.[1] as { value: bigint }).value, 2n);
  await rt.stop();
});
