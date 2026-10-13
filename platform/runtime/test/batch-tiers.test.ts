/**
 * S-PLAT-I2 work item 7: a batch whose epoch read times out on its gateway tier (RFC-006 §4.7). The batch is
 * abandoned, its connection is discarded without a ROLLBACK, and it starts once more on the next tier; a second
 * timeout answers Retry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OwnerDeclaration } from '../src/index.ts';
import { DevSealer, TierTimeout, utf8 } from '../src/index.ts';
import { executeBatch } from '../src/batch/execute.ts';
import type { PendingCall, SlotHolding } from '../src/batch/attempt.ts';
import type { BatchTxn } from '../src/store/types.ts';
import { MemoryStore } from '../testing/index.ts';

const DECL: OwnerDeclaration = { kind: 'tierk', slotCount: 1, entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }], projections: [], streams: [] };
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const OPTS = { batchRetries: 5, abandonBeforeCommitMs: 60_000, commitBackstopMs: 15_000 };

/** A MemoryStore whose first `timeouts` transactions time out at the epoch read; it records each close and rollback. */
async function setup(timeouts: number) {
  const store = new MemoryStore({ wallMs: () => 1_800_000_000_000 });
  store.seedSlots(DECL.kind, 1);
  await store.insertSession({ shard: 0, sessionId: 'sess-1', host: 'h', region: 'r1', facility: 'r1a', kind: DECL.kind, ttlMs: 60_000 });
  const got = await store.acquireFree(DECL.kind, 0, 'sess-1');
  assert.ok(got);
  const log: string[] = [];
  let begun = 0;
  const begin = store.beginBatch.bind(store);
  store.beginBatch = async (): Promise<BatchTxn> => {
    const tx = await begin();
    const n = ++begun;
    const close = tx.close.bind(tx);
    const rollback = tx.rollback.bind(tx);
    tx.close = (broken: boolean) => { log.push(`close ${n} ${broken}`); close(broken); };
    tx.rollback = async () => { log.push(`rollback ${n}`); await rollback(); };
    if (n <= timeouts) tx.readFence = () => Promise.reject(new TierTimeout(n - 1, 400));
    return tx;
  };
  const holding: SlotHolding = { slot: 0, epoch: got.epoch, sessionId: 'sess-1', stopsVersion: null, stops: new Map(), chains: new Map(), integrityHolds: new Set() };
  const calls: PendingCall[] = [{ call: { partition: utf8('p1'), entries: [{ kind: 1, schemaV: 1, identity: utf8('i1'), audit: AUDIT, payload: { a: 1 } }] }, opts: {} }];
  return { store, log, holding, calls, begun: () => begun };
}

test('should start the batch again on the next tier and commit when the epoch read times out on the first tier', async () => {
  const s = await setup(1);
  const outcome = await executeBatch(s.store, { decl: DECL, sealer: new DevSealer(), holding: s.holding }, s.calls, OPTS);
  assert.equal(outcome.kind, 'answered');
  assert.equal(s.begun(), 2);
  assert.deepEqual(s.log, ['close 1 true', 'close 2 false'], 'the first transaction is discarded with no ROLLBACK');
  assert.equal(s.store.log.length, 1);
});

test('should answer retry and write nothing when the epoch read times out on two tiers', async () => {
  const s = await setup(2);
  const outcome = await executeBatch(s.store, { decl: DECL, sealer: new DevSealer(), holding: s.holding }, s.calls, OPTS);
  assert.deepEqual(outcome, { kind: 'retry', restarts: 0, freshAttempts: 1 });
  assert.equal(s.begun(), 2);
  assert.deepEqual(s.log, ['close 1 true', 'close 2 true']);
  assert.equal(s.store.log.length, 0);
});
