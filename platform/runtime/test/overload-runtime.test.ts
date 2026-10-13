/**
 * RFC-006 §4.7 rule 5 in the runtime: the admission check before queueing (DT-50 (5)), the calls that are not shed,
 * the burst cap, the release at a batch end, which batches are rule 5b samples, and an abandon at a lower budget.
 * A scripted store sets each write's database time on a stepped clock; no real time passes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppendOptions, AppendResult, OwnerDeclaration, OwnerHooks } from '../src/index.ts';
import { CockroachOwnerRuntime, ManualLoad, MemoryPublisher, TierTimeout, utf8 } from '../src/index.ts';
import type { BatchTxn, BatchWrites } from '../src/store/types.ts';
import { MemoryStore } from '../testing/index.ts';
import { seeded } from './support.ts';

const DECL: OwnerDeclaration = {
  kind: 'canary', slotCount: 1,
  entryKinds: [{ kind: 1, name: 'incremented', schemaVersions: [1], retention: 'ops' }],
  projections: [], streams: [],
};
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'internal_service', kind: 'service', tenant: 'share' },
  decided_at: 'commit', policy_version: 1 } as const;
const HOOKS: OwnerHooks = {
  async onAcquire() {}, onRelease() {}, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {},
};

/**
 * Database time of write k (in order); a function that throws makes that write fail; a promise holds the write until
 * the test resolves it with the time. After the script: 10 ms.
 */
type Step = number | (() => never) | Promise<number>;

class ScriptedStore extends MemoryStore {
  now = 0;
  readonly written: string[][] = [];
  private k = 0;
  private readonly script: Step[];
  constructor(script: Step[]) { super(); this.script = script; }
  override async beginBatch(): Promise<BatchTxn> {
    const tx = await super.beginBatch();
    const write = tx.write.bind(tx);
    tx.write = async (kind: string, w: BatchWrites): Promise<void> => {
      const step = this.script[this.k++] ?? 10;
      if (typeof step === 'function') step();
      await write(kind, w);
      this.written.push(w.log.map((l) => new TextDecoder().decode(l.identity)));
      this.now += typeof step === 'number' ? step : typeof step === 'function' ? step() : await step;
    };
    return tx;
  }
}

async function setup(script: Step[]): Promise<{ rt: CockroachOwnerRuntime; store: ScriptedStore }> {
  const store = new ScriptedStore(script);
  store.seedSlots(DECL.kind, DECL.slotCount);
  const rt = new CockroachOwnerRuntime({
    declaration: DECL, store, slots: [0], publisher: new MemoryPublisher(), load: new ManualLoad(),
    testing: { batchNowMs: () => store.now, random: seeded(7) },
  });
  await rt.start(HOOKS);
  return { rt, store };
}

const call = (rt: CockroachOwnerRuntime, id: string, opts: AppendOptions = {}): Promise<AppendResult> =>
  rt.append({ partition: utf8(`p-${id}`), entries: [{ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id } }] }, opts);

/** Waits for a condition of the runtime, a bounded number of event-loop turns. */
async function until(what: string, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 10_000; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Drives slot 0 into the overloaded state: the first batch is abandoned at the default budget, so `ĉ` = 2,000 ms
 * and `n_cap` = 1 call; the queue then stands, and the take at 3,011 ms has stood above 500 ms for 1 s.
 */
async function overloaded(): Promise<{
  rt: CockroachOwnerRuntime; store: ScriptedStore; queued: Array<Promise<AppendResult>>; drain: () => void;
}> {
  let open: (ms: number) => void = () => {};
  const gate = new Promise<number>((r) => { open = r; });
  const { rt, store } = await setup([2_001, 10, 1_000, gate]);
  const queued = ['a', 'b', 'c', 'd', 'e'].map((id) => call(rt, id));
  await until('the overloaded state', () => rt.overloadStats(0)?.state === 'overloaded').catch((e: unknown) => {
    throw new Error(`${String(e)}: now ${store.now}, writes ${JSON.stringify(store.written)}, ${JSON.stringify(rt.overloadStats(0))}`);
  });
  assert.equal(store.now, 3_011);
  return { rt, store, queued, drain: () => open(10) };
}

test('DT-50 (5) should answer a new call Overloaded before it is queued when the slot is overloaded', async () => {
  const { rt, store, queued, drain } = await overloaded();
  try {
    const before = rt.overloadStats(0);
    const r = await call(rt, 'shed');
    assert.equal(r.r, 'Overloaded');
    assert.ok(r.r === 'Overloaded' && r.retryAfterMs >= 250 && r.retryAfterMs <= 5_000, JSON.stringify(r));
    const after = rt.overloadStats(0);
    assert.equal(after?.admitted, before?.admitted);
    assert.equal(after?.shedAtOnce, 1);
    drain();
    await Promise.all(queued);
    assert.equal(store.written.flat().includes('shed'), false, 'the shed call was never in a batch');
  } finally {
    drain();
    await rt.stop();
  }
});

test('should queue an exclusive call when the slot is overloaded', async () => {
  const { rt, queued, drain } = await overloaded();
  try {
    const r = call(rt, 'x', { exclusive: true });
    drain();
    assert.equal((await r).r, 'Committed');
    await Promise.all(queued);
  } finally {
    drain();
    await rt.stop();
  }
});

test('should not shed a moved call when the slot is overloaded', async () => {
  const { rt, queued, drain } = await overloaded();
  try {
    const moved = rt.moveOut(utf8('p-none'), 1, 1);
    drain();
    assert.deepEqual(await moved, { r: 'ConditionFailed', which: 'noHead' });
    await Promise.all(queued);
  } finally {
    drain();
    await rt.stop();
  }
});

test('DT-50 (5) should answer at most 500 shed calls at once in 100 ms and the others at the next tick', async () => {
  const { rt, store, queued, drain } = await overloaded();
  try {
    const answered: boolean[] = [];
    const sheds = Array.from({ length: 501 }, (_, i) => call(rt, `s${i}`).then((r) => { answered[i] = true; return r; }));
    await Promise.all(sheds.slice(0, 500));
    await new Promise((r) => setImmediate(r));
    assert.equal(answered[500], undefined, 'the 501st answer waits for the next tick');
    assert.equal(rt.overloadStats(0)?.shedDeferred, 1);
    store.now += 100;
    const next = call(rt, 'tick');
    assert.equal((await sheds[500])?.r, 'Overloaded');
    assert.equal((await next).r, 'Overloaded');
    drain();
    await Promise.all(queued);
  } finally {
    drain();
    await rt.stop();
  }
});

test('should release at a batch end when the expected sojourn falls to the target, before the slot is idle', async () => {
  const { rt, queued, drain } = await overloaded();
  try {
    drain();
    await Promise.all(queued);
    const s = rt.overloadStats(0);
    assert.equal(s?.state, 'admitting');
    assert.equal(s?.stateChanges, 2);
    assert.equal((await call(rt, 'after')).r, 'Committed');
  } finally {
    drain();
    await rt.stop();
  }
});

test('should not enter the overloaded state at an abandon at the default budget by itself', async () => {
  const { rt } = await setup([2_001, 10]);
  try {
    assert.equal((await call(rt, 'a')).r, 'Committed');
    const s = rt.overloadStats(0);
    assert.equal(s?.abandons, 1);
    assert.equal(s?.freshAfterAbandon, 1);
    assert.equal(s?.stateChanges, 0);
    assert.equal(s?.lanes[0]?.regimeResets, 1, 'a default-budget abandon is a regime reset');
    assert.equal(s?.lanes[0]?.cHatMs, 2_000, 'the censored sample: 2,000 / n');
  } finally {
    await rt.stop();
  }
});

test('should make a fresh attempt with the whole batch and take no sample when a lower budget is abandoned', async () => {
  const { rt, store } = await setup([251, 10]);
  try {
    assert.equal((await call(rt, 'x', { exclusive: true, abandonBeforeCommitMs: 250 })).r, 'Committed');
    assert.deepEqual(store.written, [['x'], ['x']]);
    const s = rt.overloadStats(0);
    assert.equal(s?.abandons, 1);
    assert.equal(s?.freshAfterAbandon, 1);
    assert.equal(s?.stateChanges, 0);
    assert.equal(s?.lanes[0]?.regimeResets, 0);
    assert.equal(s?.lanes[0]?.cHatMs, undefined);
    assert.equal(s?.lanes[0]?.samples, 0);
  } finally {
    await rt.stop();
  }
});

test('should take a committed batch as a sample of its lane', async () => {
  const { rt } = await setup([30]);
  try {
    assert.equal((await call(rt, 'a')).r, 'Committed');
    assert.equal(rt.overloadStats(0)?.lanes[0]?.samples, 1);
  } finally {
    await rt.stop();
  }
});

test('should not take an exclusive batch as a sample', async () => {
  const { rt } = await setup([30]);
  try {
    assert.equal((await call(rt, 'x', { exclusive: true })).r, 'Committed');
    assert.equal(rt.overloadStats(0)?.lanes[0]?.samples, 0);
  } finally {
    await rt.stop();
  }
});

test('should not take a batch with a lower abandon budget as a sample', async () => {
  const { rt } = await setup([30]);
  try {
    assert.equal((await call(rt, 'l', { abandonBeforeCommitMs: 250 })).r, 'Committed');
    assert.equal(rt.overloadStats(0)?.lanes[0]?.samples, 0);
  } finally {
    await rt.stop();
  }
});

test('should not take a batch that had a per-tier timeout as a sample', async () => {
  const { rt, store } = await setup([() => { throw new TierTimeout(0, 400); }, 30]);
  try {
    assert.equal((await call(rt, 't')).r, 'Committed');
    assert.deepEqual(store.written, [['t']]);
    assert.equal(rt.overloadStats(0)?.lanes[0]?.samples, 0);
  } finally {
    await rt.stop();
  }
});
