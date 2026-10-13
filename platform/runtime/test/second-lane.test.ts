/**
 * S-PLAT-I2 work item 1: the second lane per slot (C01 §3.2 R47-31; RFC-006 §4.3, §6.4). Exit criterion (5):
 * a second-lane batch never carries a partition of the first lane's batch; per-partition seq stays contiguous
 * (CP-1 re-run with the second lane on).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppendResult, OwnerDeclaration, OwnerHooks } from '../src/index.ts';
import { CockroachOwnerRuntime, ManualLoad, compareHlc, hex, slotOfPartition, utf8 } from '../src/index.ts';
import { MemoryStore } from '../testing/index.ts';

const DECL: OwnerDeclaration = {
  kind: 'account', slotCount: 4,
  entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }],
  projections: [], streams: [],
};
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const entry = (id: string) => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id } });
const FAST = { sessionTtlMs: 300, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 280, maxLoopDelayMs: 20 };
const hooks = (): OwnerHooks => ({ async onAcquire() {}, onRelease() {}, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {} });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error('timed out'); await sleep(5); }
}

/** Seeded generator (engineering standard §5): the seed is in every failure message. */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; };
}

/** Partitions that all live in one slot, so both lanes of that slot are used. */
function partitionsOfSlot(slot: number, n: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; out.length < n; i++) { const p = utf8(`acct-${i}`); if (slotOfPartition(p, 4) === slot) out.push(p); }
  return out;
}

async function boot(store: MemoryStore, slots = [0, 1, 2, 3]) {
  store.seedSlots(DECL.kind, 4);
  const rt = new CockroachOwnerRuntime({ declaration: DECL, store, slots, load: new ManualLoad(), testing: { sessionTimings: FAST } });
  await rt.start(hooks());
  return rt;
}

function checkLog(store: MemoryStore, seed: number): void {
  const by = new Map<string, typeof store.log>();
  for (const l of store.log) by.set(hex(l.partition), [...(by.get(hex(l.partition)) ?? []), l]);
  for (const [p, rows] of by) {
    const sorted = [...rows].sort((a, b) => (a.seq < b.seq ? -1 : 1));
    sorted.forEach((r, i) => assert.equal(r.seq, BigInt(i + 1), `seed ${seed}: ${p} seq contiguous`));
    for (let i = 1; i < sorted.length; i++) {
      // ts is shared by every entry of one batch and increases from batch to batch (C01 §3.2).
      assert.ok(compareHlc(sorted[i - 1]?.ts as never, sorted[i]?.ts as never) <= 0, `seed ${seed}: ${p} ts never goes back at seq ${sorted[i]?.seq}`);
      assert.ok((sorted[i - 1]?.epoch ?? 0n) <= (sorted[i]?.epoch ?? 0n), `seed ${seed}: ${p} epochs never go back`);
    }
  }
}

test('should run calls marked lane second on the first lane, one batch at a time, when platform_timing does not enable a second lane', async () => {
  const store = new MemoryStore();
  store.faults.beforeCommit = () => sleep(5);
  const rt = await boot(store);
  const ps = partitionsOfSlot(1, 4);
  const rs = await Promise.all(ps.map((p, i) => rt.append({ partition: p, entries: [entry(`d${i}`)] }, { lane: 'second' })));
  assert.ok(rs.every((r) => r.r === 'Committed'));
  assert.ok(rt.batchesStarted.every((b) => b.lane === 'primary'));
  await rt.stop();
});

test('should carry only calls marked lane second on the second lane when the deadline lane is on', async () => {
  const store = new MemoryStore();
  store.timing = { ...store.timing, version: 2n, secondLane: { account: { deadline: true } } };
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let first = true;
  store.faults.beforeCommit = async () => { if (first) { first = false; await gate; } };
  const rt = await boot(store);
  await sleep(60);                                   // one renewal tick reads the new platform_timing version
  const [a, b, c] = partitionsOfSlot(2, 3) as [Uint8Array, Uint8Array, Uint8Array];
  const pa = rt.append({ partition: a, entries: [entry('a')] });
  await until(() => rt.batchesStarted.length === 1);
  const pb = rt.append({ partition: b, entries: [entry('b')] });                       // ordinary: waits for the first lane
  const pc = rt.append({ partition: c, entries: [entry('c')] }, { lane: 'second' });   // a deadline entry: second lane
  await until(() => rt.batchesStarted.length === 2);
  const second = rt.batchesStarted[1];
  assert.equal(second?.lane, 'second');
  assert.deepEqual(second?.partitions, [hex(c)]);
  release();
  assert.deepEqual((await Promise.all([pa, pb, pc])).map((r) => r.r), ['Committed', 'Committed', 'Committed']);
  assert.ok(rt.batchesStarted.filter((x) => x.lane === 'second').every((x) => x.partitions.includes(hex(c))), 'b never rode the deadline lane');
  await rt.stop();
});

test('should keep a partition in the first lane\'s batch out of the second lane, and every later call of it too, so its order holds', async () => {
  const store = new MemoryStore();
  store.timing = { ...store.timing, version: 2n, secondLane: { account: { account: true } } };
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let first = true;
  store.faults.beforeCommit = async () => { if (first) { first = false; await gate; } };
  const rt = await boot(store);
  await sleep(60);
  const [x, y] = partitionsOfSlot(3, 2) as [Uint8Array, Uint8Array];
  const p1 = rt.append({ partition: x, entries: [entry('x1')] });
  await until(() => rt.batchesStarted.length === 1);
  const p2 = rt.append({ partition: x, entries: [entry('x2')] });
  const p3 = rt.append({ partition: y, entries: [entry('y1')] });
  await until(() => rt.batchesStarted.length === 2);
  assert.deepEqual(rt.batchesStarted[1], { slot: 3, lane: 'second', partitions: [hex(y)], otherInFlight: [hex(x)] });
  release();
  const [r1, r2] = await Promise.all([p1, p2, p3]);
  assert.equal(r1?.r === 'Committed' && r1.seqFrom, 1n);
  assert.equal(r2?.r === 'Committed' && r2.seqFrom, 2n, 'x2 after x1');
  await rt.stop();
});

test('C01 CP-1 with the second lane on: across seeded load, a pause and a takeover, no batch carries a partition of the other lane\'s batch; seq contiguous and ts never back per partition', async () => {
  for (const seed of [11, 2026, 90210]) {
    const rnd = rng(seed);
    const store = new MemoryStore();
    store.timing = { ...store.timing, version: 2n, secondLane: { account: { account: true } } };
    store.faults.beforeCommit = () => sleep(Math.floor(rnd() * 6));
    const a = await boot(store);
    await sleep(60);
    const ps = partitionsOfSlot(0, 6);
    const results: Array<Promise<AppendResult>> = [];
    for (let i = 0; i < 120; i++) {
      const p = ps[Math.floor(rnd() * ps.length)] as Uint8Array;
      results.push(a.append({ partition: p, entries: [entry(`a-${i}`)] }));
      if (rnd() < 0.3) await sleep(1);
    }
    await Promise.all(results);
    // A pause past session_ttl: B takes the slot; A's late calls never commit.
    a.pauseRenewalsForTest();
    const b = await boot(store, [0]);
    await until(() => b.heldSlots().includes(0));
    const late = a.append({ partition: ps[0] as Uint8Array, entries: [entry('a-late')] });
    a.resumeRenewalsForTest();
    assert.equal((await late).r, 'StaleEpoch', `seed ${seed}`);
    const more: Array<Promise<AppendResult>> = [];
    for (let i = 0; i < 60; i++) more.push(b.append({ partition: ps[Math.floor(rnd() * ps.length)] as Uint8Array, entries: [entry(`b-${i}`)] }));
    assert.ok((await Promise.all(more)).every((r) => r.r === 'Committed'), `seed ${seed}`);
    for (const rt of [a, b]) {
      for (const s of rt.batchesStarted) {
        assert.deepEqual(s.partitions.filter((p) => s.otherInFlight.includes(p)), [], `seed ${seed}: a ${s.lane} batch carried a partition of the other lane`);
      }
    }
    assert.ok([...a.batchesStarted, ...b.batchesStarted].filter((s) => s.lane === 'second').length > 0, `seed ${seed}: the second lane ran`);
    assert.ok(!store.log.some((l) => Buffer.from(l.identity).toString() === 'a-late'), `seed ${seed}`);
    checkLog(store, seed);
    await a.stop(); await b.stop();
  }
});
