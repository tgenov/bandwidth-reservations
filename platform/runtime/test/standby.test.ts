/**
 * S-PLAT-I2 work item 2: hot standbys fed by push (RFC-006 §4.4). The holder pushes every Committed batch;
 * the standby applies a push only when its seq continues, else waits for its follower-read tail. On the
 * holder's expiry the standby takes the slots and reads only the rows above its tail (DT-28, in-region part,
 * at the unit level; the dev-cell test is in test/integration/i2.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HlcTs, OpenedLogRow, OwnerDeclaration, OwnerHooks, SlotNo } from '../src/index.ts';
import { CockroachOwnerRuntime, ManualLoad, StandbyTail, hex, hlc, slotOfPartition, utf8, type StandbyChannel, type StandbyPush } from '../src/index.ts';
import type { LogRowWrite } from '../src/store/types.ts';
import { MemoryStore } from '../testing/index.ts';

const DECL: OwnerDeclaration = {
  kind: 'hlink', slotCount: 4,
  entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }],
  projections: [], streams: [],
};
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const entry = (id: string) => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id } });
const FAST = { sessionTtlMs: 300, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 280, maxLoopDelayMs: 20 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 3_000, what = f.toString()): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(5); }
}
function hooks(acquired: Array<[SlotNo, string]> = []): OwnerHooks {
  return { async onAcquire(slot, _e, how) { acquired.push([slot, how]); }, onRelease() {}, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {} };
}

/** The owner's memory: partition → applied ids in seq order. */
function memory() {
  const m = new Map<string, string[]>();
  return {
    m,
    apply(rows: OpenedLogRow[]) { for (const r of rows) m.set(hex(r.partition), [...(m.get(hex(r.partition)) ?? []), (r.payload as { id: string }).id]); },
  };
}

// ---------------- StandbyTail rules ----------------

const ts = (n: number): HlcTs => hlc(`${n}.0000000000`);
function row(p: string, seq: number): LogRowWrite {
  const b = new Uint8Array();
  return { slot: 0, partition: utf8(p), seq: BigInt(seq), generation: 0, epoch: 1n, kind: 1, schemaV: 1, identity: utf8(`${p}${seq}`), emits: b, audit: b,
    retention: 1, keyId: b, payload: utf8(`${p}${seq}`), chain: b };
}
const push = (t: number, prev: number, rows: LogRowWrite[], advances = true): StandbyPush => ({ kind: 'hlink', slot: 0, epoch: 1n, ts: ts(t), prevTs: ts(prev), advances, rows });

test('should apply a push whose seq continues, buffer one that does not, and apply it after the tail fills the gap, never twice', () => {
  const applied: string[] = [];
  const t = new StandbyTail((rows) => { for (const r of rows) applied.push(`${Buffer.from(r.partition).toString()}${r.seq}`); });
  t.tail([0], [], ts(10));
  t.push(push(11, 10, [row('A', 1)]));
  // The push of ts 12 (A2) is lost; ts 13 (A3) does not continue A.
  t.push(push(13, 12, [row('A', 3), row('B', 1)]));
  assert.deepEqual(applied, ['A1']);
  assert.equal(t.stats.pushesBuffered, 1);
  assert.equal(t.completeThrough(0), ts(11), 'the chain 10 → 11 is complete; 13 is not (12 is missing)');
  // The tail reads through 12 and gives A2; the buffered push then applies; A1 is not applied again.
  t.tail([0], [{ ...row('A', 1), ts: ts(11) }, { ...row('A', 2), ts: ts(12) }], ts(12));
  assert.deepEqual(applied, ['A1', 'A2', 'A3', 'B1']);
  assert.equal(t.completeThrough(0), ts(13));
  assert.equal(t.appliedSeq(utf8('A')), 3n);
  t.push(push(13, 12, [row('A', 3), row('B', 1)]));
  assert.deepEqual(applied, ['A1', 'A2', 'A3', 'B1'], 'a duplicate push is not applied again');
});

test('should not advance the complete position by a push that does not advance (another lane in flight) or whose chain has a gap', () => {
  const t = new StandbyTail(() => {});
  t.tail([0], [], ts(10));
  t.push(push(12, 10, [row('A', 1)], false));
  assert.equal(t.completeThrough(0), ts(10), 'a batch of the other lane may lie below ts 12');
  t.push(push(15, 14, [row('B', 1)]));
  assert.equal(t.completeThrough(0), ts(10), 'prevTs 14 is above the complete position');
  t.tail([0], [], ts(14));
  assert.equal(t.completeThrough(0), ts(15), 'the tail reached prevTs: the chain folds to 15');
});

// ---------------- runtime: holder and hot standby ----------------

async function pair(store: MemoryStore, channel?: (inner: StandbyChannel) => StandbyChannel) {
  store.seedSlots(DECL.kind, 4);
  const holder = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], load: new ManualLoad(), testing: { sessionTimings: FAST } });
  await holder.start(hooks());
  const mem = memory();
  const acquired: Array<[SlotNo, string]> = [];
  const standby = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], load: new ManualLoad(),
    standby: { apply: (rows) => mem.apply(rows), pollMs: 20 }, testing: { sessionTimings: FAST, postAcquisitionWaitMs: 10 } });
  await standby.start(hooks(acquired));
  const ch = standby.standbyChannel();
  holder.attachStandby('s1', channel ? channel(ch) : ch);
  return { holder, standby, mem, acquired };
}

test('should take no slot while the holder lives, keep the owner memory current from pushes alone, and take over with no catch-up row when the holder dies (DT-28 at the unit level)', async () => {
  const store = new MemoryStore();
  store.followerLagRows = 1_000_000;          // the follower-read tail sees nothing: only pushes feed the standby
  const { holder, standby, mem, acquired } = await pair(store);
  const parts = ['L1', 'L2', 'L3'].map(utf8);
  for (let i = 0; i < 5; i++) for (const p of parts) assert.equal((await holder.append({ partition: p, entries: [entry(`${hex(p)}-${i}`)] })).r, 'Committed');
  await sleep(60);
  assert.deepEqual(standby.heldSlots(), [], 'a standby holds no slot while its holder lives');
  for (const p of parts) assert.deepEqual(mem.m.get(hex(p)), Array.from({ length: 5 }, (_, i) => `${hex(p)}-${i}`));
  assert.equal(standby.standbyStats()?.tailRows, 0);
  assert.equal(standby.standbyStats()?.pushedRows, 15);
  holder.pauseRenewalsForTest();                // the holder dies: no renewal, no release
  const killed = Date.now();
  await until(() => standby.heldSlots().length === 4, 3_000);
  const tookMs = Date.now() - killed;
  assert.equal(standby.standbyStats()?.catchUpRows, 0, 'no reload from the log beyond the last pushed batch');
  assert.ok(tookMs < 300 + 200, `took over ${tookMs} ms after the kill (session_ttl 300 ms in this test)`);
  assert.deepEqual(acquired.map(([s]) => s).sort(), [0, 1, 2, 3]);
  const p = parts[0] as Uint8Array;
  const r = await standby.append({ partition: p, entries: [entry('after')] });
  assert.equal(r.r === 'Committed' && r.seqFrom, 6n, 'the new holder continues seq');
  await holder.stop(); await standby.stop();
});

test('should fill a lost push from the follower-read tail, and read at takeover only the rows above the tail', async () => {
  const store = new MemoryStore();
  let dropped = 0;
  const lossy = (inner: StandbyChannel): StandbyChannel => ({ push: (p) => { if (dropped === 0 && p.rows.some((r) => r.seq === 2n)) { dropped += 1; return; } inner.push(p); } });
  const { holder, standby, mem } = await pair(store, lossy);
  const P = utf8('L9');
  const slot = slotOfPartition(P, 4);
  for (let i = 0; i < 4; i++) assert.equal((await holder.append({ partition: P, entries: [entry(`x${i}`)] })).r, 'Committed');
  assert.equal(dropped, 1);
  await until(() => (mem.m.get(hex(P)) ?? []).length === 4);
  assert.deepEqual(mem.m.get(hex(P)), ['x0', 'x1', 'x2', 'x3'], 'in seq order, each once');
  assert.ok((standby.standbyStats()?.tailRows ?? 0) >= 1, 'the tail gave the lost row');
  // Two more rows the tail cannot see yet and the standby gets by push; then the holder dies.
  store.followerLagRows = 2;
  for (let i = 4; i < 6; i++) await holder.append({ partition: P, entries: [entry(`x${i}`)] });
  holder.pauseRenewalsForTest();
  await until(() => standby.heldSlots().includes(slot));
  assert.deepEqual(mem.m.get(hex(P)), ['x0', 'x1', 'x2', 'x3', 'x4', 'x5']);
  assert.equal(standby.standbyStats()?.catchUpRows, 0);
  await holder.stop(); await standby.stop();
});

test('should catch up at the present the rows no push gave when the holder dies after a lost push', async () => {
  const store = new MemoryStore();
  store.followerLagRows = 1_000_000;
  const { holder, standby, mem } = await pair(store, (inner) => ({ push: (p) => { if (!p.rows.some((r) => r.seq === 3n)) inner.push(p); } }));
  const P = utf8('L5');
  for (let i = 0; i < 3; i++) await holder.append({ partition: P, entries: [entry(`y${i}`)] });
  assert.deepEqual(mem.m.get(hex(P)), ['y0', 'y1']);
  holder.pauseRenewalsForTest();
  await until(() => standby.heldSlots().length === 4);
  assert.deepEqual(mem.m.get(hex(P)), ['y0', 'y1', 'y2']);
  assert.equal(standby.standbyStats()?.catchUpRows, 1, 'exactly the row that no push gave');
  await holder.stop(); await standby.stop();
});
