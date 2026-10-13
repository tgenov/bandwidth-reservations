/**
 * S-PLAT-I2 work item 2: hot standbys fed by push (RFC-006 §4.4). The holder pushes every Committed batch;
 * the standby applies a push only when its seq continues, else waits for its follower-read tail. On the
 * holder's expiry the standby takes the slots and reads only the rows above its tail (DT-28, in-region part,
 * at the unit level; the dev-cell test is in test/integration/i2.test.ts).
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { HlcTs, OpenedLogRow, OwnerDeclaration, OwnerHooks, SlotNo } from '../src/index.ts';
import {
  CockroachOwnerRuntime, ManualLoad, STANDBY_BUFFER_MAX, StandbyTail, hex, hlc, slotOfPartition, utf8, type StandbyChannel, type StandbyPush,
} from '../src/index.ts';
import type { LogRowWrite, TimingRow } from '../src/store/types.ts';
import { MemoryStore } from '../testing/index.ts';
import { Closers, countCalls, steppedClock, until } from './support.ts';

const DECL: OwnerDeclaration = {
  kind: 'hlink', slotCount: 4,
  entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }],
  projections: [], streams: [],
};
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const entry = (id: string) => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id } });
const FAST = { sessionTtlMs: 300, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 280, maxLoopDelayMs: 20 };
const closers = new Closers();
const T = { timeout: 15_000 };
afterEach(() => closers.closeAll());
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

test('should buffer at most STANDBY_BUFFER_MAX pushes per slot and drop the oldest above it', () => {
  assert.equal(STANDBY_BUFFER_MAX, 10_000);
  const t = new StandbyTail(() => {});
  t.tail([0], [], ts(10));
  // Each push starts at seq 2 of its own partition: none continues, so each waits for the tail.
  for (let i = 0; i < STANDBY_BUFFER_MAX; i++) t.push(push(11 + i, 10 + i, [row(`P${i}`, 2)]));
  assert.equal(t.stats.pushesBuffered, STANDBY_BUFFER_MAX);
  assert.equal(t.stats.pushesDropped, 0);
  t.push(push(11 + STANDBY_BUFFER_MAX, 10 + STANDBY_BUFFER_MAX, [row('Q', 2)]));
  assert.equal(t.stats.pushesDropped, 1);
});

// ---------------- runtime: holder and hot standby ----------------

const TTL = FAST.sessionTtlMs;

/**
 * A holder and a hot standby on one store with a stepped clock: the holder's session expires only when the test
 * steps the clock past session_ttl. `tails()` counts the standby's follower-read tails (one each standby_poll).
 */
async function pair(o: { channel?: (inner: StandbyChannel) => StandbyChannel; followerLagRows?: number; secondLane?: NonNullable<TimingRow['secondLane']>[string] } = {}) {
  const clock = steppedClock();
  const store = new MemoryStore({ wallMs: clock.now });
  store.followerLagRows = o.followerLagRows ?? 0;
  if (o.secondLane) store.timing = { ...store.timing, version: 2n, secondLane: { [DECL.kind]: o.secondLane } };
  store.seedSlots(DECL.kind, 4);
  const tails = countCalls(store, 'tailLog');
  const holder = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], load: new ManualLoad(), testing: { sessionTimings: FAST } });
  closers.add(() => holder.stop());
  await holder.start(hooks());
  const mem = memory();
  const acquired: Array<[SlotNo, string]> = [];
  const standby = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], load: new ManualLoad(),
    standby: { apply: (rows) => mem.apply(rows), pollMs: 20 }, testing: { sessionTimings: FAST, postAcquisitionWaitMs: 10 } });
  closers.add(() => standby.stop());
  await standby.start(hooks(acquired));
  const ch = standby.standbyChannel();
  const recorded: StandbyPush[] = [];
  const inner: StandbyChannel = { push: (p) => { recorded.push(p); ch.push(p); } };
  holder.attachStandby('s1', o.channel ? o.channel(inner) : inner);
  /** Waits for `n` more follower-read tails of the standby (n standby_poll ticks). */
  const polls = async (n: number) => { const at = tails.count(); await until(() => tails.count() >= at + n, 5_000, `${n} standby polls`); };
  /** The holder dies (no renewal, no release) and its session expires: the clock passes session_ttl. */
  const kill = () => { holder.pauseRenewalsForTest(); clock.step(TTL + 1); };
  return { store, clock, holder, standby, mem, acquired, recorded, polls, kill };
}

/** The first COMMIT waits until `release`; `reached` resolves when it waits. */
function gateFirstCommit(store: MemoryStore): { reached: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  let reachedNow: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const reached = new Promise<void>((r) => { reachedNow = r; });
  let first = true;
  store.faults.beforeCommit = async () => { if (first) { first = false; reachedNow(); await gate; } };
  closers.add(async () => release());              // runs before the runtimes stop, also when the test fails
  return { reached, release: () => release() };
}

/** Partitions of one slot (both lanes of that slot are used). */
function partitionsOfSlot(slot: number, n: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; out.length < n; i++) { const p = utf8(`L-${i}`); if (slotOfPartition(p, 4) === slot) out.push(p); }
  return out;
}

test('should take no slot while the holder lives, keep the owner memory current from pushes alone, and take over at the expiry with no catch-up row when the holder dies (DT-28 at the unit level)', T, async () => {
  const { holder, standby, mem, acquired, polls, clock } = await pair({ followerLagRows: 1_000_000 });   // the tail sees nothing: only pushes feed the standby
  const parts = ['L1', 'L2', 'L3'].map(utf8);
  for (let i = 0; i < 5; i++) for (const p of parts) assert.equal((await holder.append({ partition: p, entries: [entry(`${hex(p)}-${i}`)] })).r, 'Committed');
  for (const p of parts) assert.deepEqual(mem.m.get(hex(p)), Array.from({ length: 5 }, (_, i) => `${hex(p)}-${i}`));
  assert.equal(standby.standbyStats()?.tailRows, 0);
  assert.equal(standby.standbyStats()?.pushedRows, 15);
  await polls(3);
  assert.deepEqual(standby.heldSlots(), [], 'a standby holds no slot while its holder lives');
  holder.pauseRenewalsForTest();                // the holder dies: no renewal, no release
  clock.step(TTL - 1);
  await polls(3);
  assert.deepEqual(standby.heldSlots(), [], 'no takeover before session_ttl');
  clock.step(1);                                // session_ttl after the last renewal: the session has expired
  await until(() => standby.heldSlots().length === 4, 5_000, 'takeover at the first standby_poll after the expiry');
  assert.equal(standby.standbyStats()?.catchUpRows, 0, 'no reload from the log beyond the last pushed batch');
  assert.deepEqual(acquired.map(([s]) => s).sort(), [0, 1, 2, 3]);
  const r = await standby.append({ partition: parts[0] as Uint8Array, entries: [entry('after')] });
  assert.equal(r.r === 'Committed' && r.seqFrom, 6n, 'the new holder continues seq');
});

test('should fill a lost push from the follower-read tail, and read at takeover only the rows above the tail', T, async () => {
  let dropped = 0;
  const lossy = (inner: StandbyChannel): StandbyChannel => ({ push: (p) => { if (dropped === 0 && p.rows.some((r) => r.seq === 2n)) { dropped += 1; return; } inner.push(p); } });
  const { store, holder, standby, mem, kill } = await pair({ channel: lossy, followerLagRows: 1_000_000 });
  const P = utf8('L9');
  const slot = slotOfPartition(P, 4);
  for (let i = 0; i < 4; i++) assert.equal((await holder.append({ partition: P, entries: [entry(`x${i}`)] })).r, 'Committed');
  assert.equal(dropped, 1);
  assert.deepEqual(mem.m.get(hex(P)), ['x0'], 'x2 and x3 wait for the lost x1');
  store.followerLagRows = 2;                    // the tail now sees x0 and x1, not x2 and x3
  await until(() => (mem.m.get(hex(P)) ?? []).length === 4);
  assert.deepEqual(mem.m.get(hex(P)), ['x0', 'x1', 'x2', 'x3'], 'in seq order, each once');
  assert.equal(standby.standbyStats()?.tailRows, 1, 'the tail gave the lost row only; the buffered pushes gave the rest');
  // Two more rows the tail cannot see yet and the standby gets by push; then the holder dies.
  for (let i = 4; i < 6; i++) await holder.append({ partition: P, entries: [entry(`x${i}`)] });
  kill();
  await until(() => standby.heldSlots().includes(slot));
  assert.deepEqual(mem.m.get(hex(P)), ['x0', 'x1', 'x2', 'x3', 'x4', 'x5']);
  assert.equal(standby.standbyStats()?.catchUpRows, 0);
});

test('should catch up at the present the rows no push gave when the holder dies after a lost push', T, async () => {
  const { holder, standby, mem, kill } = await pair({ channel: (inner) => ({ push: (p) => { if (!p.rows.some((r) => r.seq === 3n)) inner.push(p); } }), followerLagRows: 1_000_000 });
  const P = utf8('L5');
  for (let i = 0; i < 3; i++) await holder.append({ partition: P, entries: [entry(`y${i}`)] });
  assert.deepEqual(mem.m.get(hex(P)), ['y0', 'y1']);
  kill();
  await until(() => standby.heldSlots().length === 4);
  assert.deepEqual(mem.m.get(hex(P)), ['y0', 'y1', 'y2']);
  assert.equal(standby.standbyStats()?.catchUpRows, 1, 'exactly the row that no push gave');
});

// ---------------- hot standby with the second lane on (TR-1, review 68) ----------------

test('should keep every committed row in the standby memory and send advances false when the other lane has a batch in flight, also after takeover', T, async () => {
  const { store, holder, standby, mem, recorded, kill } = await pair({ followerLagRows: 1_000_000, secondLane: { account: true } });
  const [a, b] = partitionsOfSlot(1, 2) as [Uint8Array, Uint8Array];
  const gate = gateFirstCommit(store);
  const pa = holder.append({ partition: a, entries: [entry('a1')] });
  await gate.reached;
  const rb = await holder.append({ partition: b, entries: [entry('b1')] });
  assert.equal(rb.r, 'Committed', 'b commits on the second lane while a is in flight');
  assert.deepEqual(holder.batchesStarted.map((x) => x.lane), ['primary', 'second']);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.advances, false, 'the first lane has a batch in flight with a lower ts');
  gate.release();
  assert.equal((await pa).r, 'Committed');
  assert.equal(recorded.length, 2);
  assert.equal(recorded[1]?.advances, true, 'no batch of the slot is in flight');
  assert.deepEqual([mem.m.get(hex(a)), mem.m.get(hex(b))], [['a1'], ['b1']]);
  kill();
  await until(() => standby.heldSlots().length === 4);
  assert.deepEqual([mem.m.get(hex(a)), mem.m.get(hex(b))], [['a1'], ['b1']], 'every committed row once, after takeover too');
  assert.equal(standby.standbyStats()?.catchUpRows, 0);
});

test('should push an Ambiguous batch resolved as committed with advances false while the other lane has a batch in flight', T, async () => {
  const { store, holder, standby, mem, recorded, kill } = await pair({ followerLagRows: 1_000_000, secondLane: { account: true } });
  const [a, b] = partitionsOfSlot(1, 2) as [Uint8Array, Uint8Array];
  const gate = gateFirstCommit(store);
  const pa = holder.append({ partition: a, entries: [entry('a1')] });   // first lane, lower ts, in flight
  await gate.reached;
  store.faults.commits.push('ambiguousCommitted');
  assert.equal((await holder.append({ partition: b, entries: [entry('b1')] })).r, 'Ambiguous');
  await until(() => recorded.length === 1, 5_000, 'the resolution pushes b1');
  assert.equal(recorded[0]?.advances, false, 'a1 is still in flight below b1');
  gate.release();
  assert.equal((await pa).r, 'Committed');
  kill();
  await until(() => standby.heldSlots().length === 4);
  assert.deepEqual([mem.m.get(hex(a)), mem.m.get(hex(b))], [['a1'], ['b1']], 'a1 is not lost behind the resolved b1');
});

test('should push with advances false while an Ambiguous batch of the slot is not resolved', T, async () => {
  const { store, holder, standby, mem, recorded, kill } = await pair({ followerLagRows: 1_000_000, secondLane: { account: true } });
  const [x, b] = partitionsOfSlot(2, 2) as [Uint8Array, Uint8Array];
  // The first lane's batch reads its ts only after the second lane's batch: x1 gets the higher ts.
  let releaseTs: () => void = () => {};
  const tsGate = new Promise<void>((r) => { releaseTs = r; });
  let reachedTs: () => void = () => {};
  const atTs = new Promise<void>((r) => { reachedTs = r; });
  const begin = store.beginBatch.bind(store);
  let first = true;
  store.beginBatch = async () => {
    const tx = await begin();
    if (first) {
      first = false;
      const readTs = tx.readTs.bind(tx);
      tx.readTs = async () => { reachedTs(); await tsGate; return readTs(); };
    }
    return tx;
  };
  // The resolution of the Ambiguous batch waits until the test lets it read.
  let releaseRes: () => void = () => {};
  const resGate = new Promise<void>((r) => { releaseRes = r; });
  const resolutionRead = store.resolutionRead.bind(store);
  store.resolutionRead = async (kind, shard, session, slots, partitions) => {
    if (partitions.length > 0) await resGate;
    return resolutionRead(kind, shard, session, slots, partitions);
  };
  closers.add(async () => { releaseTs(); releaseRes(); });
  const px = holder.append({ partition: x, entries: [entry('x1')] });
  await atTs;
  store.faults.commits.push('ambiguousCommitted');
  assert.equal((await holder.append({ partition: b, entries: [entry('b1')] })).r, 'Ambiguous');
  releaseTs();
  assert.equal((await px).r, 'Committed');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.advances, false, 'b1 is committed below x1 but not pushed yet');
  releaseRes();
  await until(() => recorded.length === 2, 5_000, 'the resolution pushes b1');
  // Review 72 N-1: the resolution ends the gate; the next push of the slot advances again (RFC-006 §4.4).
  assert.equal((await holder.append({ partition: x, entries: [entry('x2')] })).r, 'Committed');
  assert.equal(recorded.length, 3);
  assert.equal(recorded[2]?.advances, true, 'no Ambiguous batch of the slot is unresolved and no other batch is in flight');
  kill();
  await until(() => standby.heldSlots().length === 4);
  assert.deepEqual([mem.m.get(hex(x)), mem.m.get(hex(b))], [['x1', 'x2'], ['b1']], 'b1 is not lost behind x1');
});

test('should take no free slot that nobody has held when the standby starts before its holder (RFC-006 §4.7 rule 1)', T, async () => {
  const store = new MemoryStore({ wallMs: steppedClock().now });
  store.seedSlots(DECL.kind, 4);                     // fresh slots: free, epoch 0
  const lists = countCalls(store, 'listSlots');
  const frees = countCalls(store, 'acquireFree');
  const standby = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], load: new ManualLoad(),
    standby: { apply: () => {}, pollMs: 20 }, testing: { sessionTimings: FAST, postAcquisitionWaitMs: 10 } });
  closers.add(() => standby.stop());
  await standby.start(hooks());
  const at = lists.count();
  // Ends early when the standby takes a slot (then it lists no more): the assertions below fail at once.
  await until(() => lists.count() >= at + 3 || standby.heldSlots().length > 0, 5_000, 'three acquisition ticks of the standby');
  assert.deepEqual(standby.heldSlots(), []);
  assert.equal(frees.count(), 0, 'the standby tries no free acquisition of a never-held slot');
  for (let s = 0; s < 4; s++) assert.deepEqual([store.slotRow(DECL.kind, s)?.sessionId, store.slotRow(DECL.kind, s)?.epoch], [null, 0n]);
});

test('should let the hot standby take the slots that its holder handed off at offset level A, with no catch-up row', T, async () => {
  const clock = steppedClock();
  const store = new MemoryStore({ wallMs: clock.now });
  store.followerLagRows = 1_000_000;
  store.seedSlots(DECL.kind, 4);
  let skewMs = 0;
  const holder = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], load: new ManualLoad(), wallMs: () => clock.now() - skewMs,
    offsetCheck: { intervalMs: 10 }, testing: { sessionTimings: FAST } });
  closers.add(() => holder.stop());
  await holder.start(hooks());
  const mem = memory();
  const standby = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], load: new ManualLoad(),
    standby: { apply: (rows) => mem.apply(rows), pollMs: 20 }, testing: { sessionTimings: FAST, postAcquisitionWaitMs: 10 } });
  closers.add(() => standby.stop());
  await standby.start(hooks());
  holder.attachStandby('s1', standby.standbyChannel());
  const P = utf8('L7');
  for (let i = 0; i < 3; i++) assert.equal((await holder.append({ partition: P, entries: [entry(`z${i}`)] })).r, 'Committed');
  skewMs = 45;                                       // the holder's offset bound goes above 40 ms: level A
  await until(() => standby.heldSlots().length === 4, 5_000, 'the standby takes the handed-off slots');
  assert.deepEqual(holder.heldSlots(), []);
  assert.deepEqual(standby.heldSlots(), [0, 1, 2, 3]);
  assert.equal(store.sessions.get(holder.sessionId())?.revoked, false, 'a hand-off keeps the holder\'s session');
  assert.equal(standby.standbyStats()?.catchUpRows, 0, 'the standby was current from the pushes');
  assert.deepEqual(mem.m.get(hex(P)), ['z0', 'z1', 'z2']);
  const r = await standby.append({ partition: P, entries: [entry('z3')] });
  assert.equal(r.r === 'Committed' && r.seqFrom, 4n);
});
