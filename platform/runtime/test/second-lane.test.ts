/**
 * S-PLAT-I2 work item 1: the second lane per slot (C01 §3.2 R47-31; RFC-006 §4.3, §6.4). Exit criterion (5):
 * a second-lane batch never carries a partition of the first lane's batch; per-partition seq stays contiguous
 * (CP-1 re-run with the second lane on).
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppendResult, HlcTs, OwnerDeclaration, OwnerHooks } from '../src/index.ts';
import { CockroachOwnerRuntime, ManualLoad, compareHlc, hex, slotOfPartition, utf8 } from '../src/index.ts';
import { MemoryStore } from '../testing/index.ts';
import type { TimingRow } from '../src/store/types.ts';
import { Closers, rng, steppedClock, until, yieldTurns } from './support.ts';

const DECL: OwnerDeclaration = {
  kind: 'account', slotCount: 4,
  entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }],
  projections: [], streams: [],
};
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const entry = (id: string) => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id } });
const FAST = { sessionTtlMs: 300, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 280, maxLoopDelayMs: 20 };
const hooks = (): OwnerHooks => ({ async onAcquire() {}, onRelease() {}, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {} });

const closers = new Closers();
afterEach(() => closers.closeAll());
const T = { timeout: 30_000 };

/** Partitions that all live in one slot, so both lanes of that slot are used. */
function partitionsOfSlot(slot: number, n: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; out.length < n; i++) { const p = utf8(`acct-${i}`); if (slotOfPartition(p, 4) === slot) out.push(p); }
  return out;
}

/** A store on a stepped clock (sessions expire only when the test steps it), with `secondLane` in platform_timing. */
function laneStore(secondLane?: NonNullable<TimingRow['secondLane']>[string]) {
  const clock = steppedClock();
  const store = new MemoryStore({ wallMs: clock.now });
  if (secondLane) store.timing = { ...store.timing, version: 2n, secondLane: { account: secondLane } };
  return { store, clock };
}

/**
 * `commitBackstopMs`: a short backstop makes a test whose assertion fails while a batch is in flight end in about that
 * time, not at the 15 s default (the runtime stops only when each lane is idle).
 */
async function boot(store: MemoryStore, slots = [0, 1, 2, 3], o: { commitBackstopMs?: number } = {}) {
  store.seedSlots(DECL.kind, 4);
  const rt = new CockroachOwnerRuntime({ declaration: DECL, store, slots, load: new ManualLoad(),
    testing: { sessionTimings: FAST, ...(o.commitBackstopMs !== undefined ? { commitBackstopMs: o.commitBackstopMs } : {}) } });
  closers.add(() => rt.stop());
  await rt.start(hooks());
  return rt;
}

/** The first COMMIT waits until `release` (the first lane's batch stays in flight). */
function gateFirstCommit(store: MemoryStore): { release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let first = true;
  store.faults.beforeCommit = async () => { if (first) { first = false; await gate; } };
  closers.add(async () => release());              // runs before the runtime stops, also when the test fails
  return { release: () => release() };
}

const lanes = (rt: CockroachOwnerRuntime): string[] => rt.batchesStarted.map((b) => b.lane);
const seqFrom = (r: AppendResult | undefined): bigint | undefined => (r?.r === 'Committed' ? r.seqFrom : undefined);

/** Records each committed batch's ts and partitions, in commit order. */
function commitsOf(store: MemoryStore): Array<{ ts: HlcTs; partitions: string[] }> {
  const out: Array<{ ts: HlcTs; partitions: string[] }> = [];
  store.commitListeners.push((_kind, w) => { if (w.log.length > 0) out.push({ ts: w.ts, partitions: [...new Set(w.log.map((l) => hex(l.partition)))] }); });
  return out;
}

/** C01 CP-1: per partition, seq contiguous from 1 in commit order, and ts strictly increasing from batch to batch. */
function checkLog(store: MemoryStore, commits: Array<{ ts: HlcTs; partitions: string[] }>, seed: number): void {
  const by = new Map<string, typeof store.log>();
  for (const l of store.log) by.set(hex(l.partition), [...(by.get(hex(l.partition)) ?? []), l]);
  for (const [p, rows] of by) {
    rows.forEach((r, i) => assert.equal(r.seq, BigInt(i + 1), `seed ${seed}: ${p} seq contiguous in commit order`));
    for (let i = 1; i < rows.length; i++) {
      assert.ok((rows[i - 1]?.epoch ?? 0n) <= (rows[i]?.epoch ?? 0n), `seed ${seed}: ${p} epochs never go back`);
    }
  }
  const last = new Map<string, HlcTs>();
  for (const c of commits) {
    for (const p of c.partitions) {
      const prev = last.get(p);
      assert.ok(prev === undefined || compareHlc(prev, c.ts) < 0, `seed ${seed}: ${p} batch at ts ${c.ts} is not after the batch before it at ${prev}`);
      last.set(p, c.ts);
    }
  }
}

test('should run calls marked lane second on the first lane, one batch at a time, when platform_timing does not enable a second lane', T, async () => {
  const { store } = laneStore();
  store.faults.beforeCommit = () => yieldTurns(3);
  const rt = await boot(store);
  const ps = partitionsOfSlot(1, 4);
  const rs = await Promise.all(ps.map((p, i) => rt.append({ partition: p, entries: [entry(`d${i}`)] }, { lane: 'second' })));
  assert.deepEqual(rs.map((r) => r.r), ['Committed', 'Committed', 'Committed', 'Committed']);
  assert.ok(rt.batchesStarted.length >= 2, 'the calls did not all fit one batch');
  assert.ok(lanes(rt).every((l) => l === 'primary'));
});

test('should carry only calls marked lane second on the second lane when the deadline lane is on', T, async () => {
  const { store } = laneStore({ deadline: true });
  const gate = gateFirstCommit(store);
  const rt = await boot(store);
  assert.equal(rt.timing().version, 2n);
  const [a, b, c] = partitionsOfSlot(2, 3) as [Uint8Array, Uint8Array, Uint8Array];
  const pa = rt.append({ partition: a, entries: [entry('a')] });
  const pb = rt.append({ partition: b, entries: [entry('b')] });                       // ordinary: waits for the first lane
  const pc = rt.append({ partition: c, entries: [entry('c')] }, { lane: 'second' });   // a deadline entry: second lane
  assert.deepEqual(rt.batchesStarted.map((x) => [x.lane, x.partitions]), [['primary', [hex(a)]], ['second', [hex(c)]]]);
  gate.release();
  assert.deepEqual((await Promise.all([pa, pb, pc])).map((r) => r.r), ['Committed', 'Committed', 'Committed']);
  assert.ok(rt.batchesStarted.filter((x) => x.lane === 'second').every((x) => !x.partitions.includes(hex(b))), 'b never rode the deadline lane');
});

test('should keep a partition in the first lane\'s batch out of the second lane, and every later call of it too, so its order holds', T, async () => {
  const { store } = laneStore({ account: true });
  const gate = gateFirstCommit(store);
  const rt = await boot(store);
  const [x, y] = partitionsOfSlot(3, 2) as [Uint8Array, Uint8Array];
  const p1 = rt.append({ partition: x, entries: [entry('x1')] });
  const p2 = rt.append({ partition: x, entries: [entry('x2')] });
  const p3 = rt.append({ partition: y, entries: [entry('y1')] });
  assert.equal(rt.batchesStarted.length, 2);
  assert.deepEqual(rt.batchesStarted[1], { slot: 3, lane: 'second', partitions: [hex(y)], otherInFlight: [hex(x)] });
  gate.release();
  const [r1, r2] = await Promise.all([p1, p2, p3]);
  assert.equal(seqFrom(r1), 1n);
  assert.equal(seqFrom(r2), 2n, 'x2 after x1');
});

test('should never start an exclusive or firstStatement call on the second lane when the account lane is on', T, async () => {
  const { store } = laneStore({ account: true });
  const gate = gateFirstCommit(store);
  const rt = await boot(store, [0, 1, 2, 3], { commitBackstopMs: 1_000 });
  const [a, x, y] = partitionsOfSlot(1, 3) as [Uint8Array, Uint8Array, Uint8Array];
  const pa = rt.append({ partition: a, entries: [entry('a')] });
  const px = rt.append({ partition: x, entries: [entry('x')] }, { exclusive: true });
  const py = rt.append({ partition: y, entries: [entry('y')] }, { firstStatement: [] });
  assert.deepEqual(lanes(rt), ['primary'], 'neither call started on the second lane while the first lane is in flight');
  gate.release();
  assert.deepEqual((await Promise.all([pa, px, py])).map((r) => r.r), ['Committed', 'Committed', 'Committed']);
  assert.deepEqual(lanes(rt), ['primary', 'primary', 'primary'], 'each special call alone, on the first lane');
  assert.deepEqual(rt.batchesStarted.slice(1).map((b) => b.partitions), [[hex(x)], [hex(y)]]);
});

test('should keep queue order of one partition when an ordinary call of it waits and a later call of it is marked lane second', T, async () => {
  const { store } = laneStore({ deadline: true });
  const gate = gateFirstCommit(store);
  const rt = await boot(store, [0, 1, 2, 3], { commitBackstopMs: 1_000 });
  const [a, p] = partitionsOfSlot(2, 2) as [Uint8Array, Uint8Array];
  const pa = rt.append({ partition: a, entries: [entry('a')] });
  const p1 = rt.append({ partition: p, entries: [entry('p1')] });
  const p2 = rt.append({ partition: p, entries: [entry('p2')] }, { lane: 'second' });
  assert.deepEqual(lanes(rt), ['primary'], 'p2 waits behind p1, which may not ride the deadline lane');
  gate.release();
  const [, r1, r2] = await Promise.all([pa, p1, p2]);
  assert.equal(seqFrom(r1), 1n);
  assert.equal(seqFrom(r2), 2n);
});

test('C01 CP-1 with the second lane on: across seeded load, lost COMMIT answers, a revocation, a pause and a takeover, no batch carries a partition of the other lane\'s batch; seq contiguous and ts strictly increasing per partition', T, async () => {
  for (const seed of [11, 2026, 90210]) {
    const rnd = rng(seed);
    const { store, clock } = laneStore({ account: true });
    const commits = commitsOf(store);
    store.faults.beforeCommit = () => yieldTurns(Math.floor(rnd() * 6));
    const a = await boot(store);
    const ps = partitionsOfSlot(0, 6);
    const results: Array<Promise<AppendResult>> = [];
    const revokeAt = 40 + Math.floor(rnd() * 60);
    for (let i = 0; i < 120; i++) {
      const p = ps[Math.floor(rnd() * ps.length)] as Uint8Array;
      const fault = rnd();
      if (fault < 0.04) store.faults.commits.push('ambiguousCommitted');
      else if (fault < 0.08) store.faults.commits.push('ambiguousNotCommitted');
      if (i === revokeAt) {
        const s = store.sessions.get(a.sessionId());
        assert.ok(s, `seed ${seed}`);
        s.revoked = true;
      }
      results.push(a.append({ partition: p, entries: [entry(`a-${i}`)] }));
      await yieldTurns(Math.floor(rnd() * 3));
    }
    const answers = await Promise.all(results);
    assert.ok(answers.every((r) => ['Committed', 'Ambiguous', 'Retry', 'StaleEpoch'].includes(r.r)), `seed ${seed}: ${answers.map((r) => r.r).join(',')}`);
    assert.ok(answers.some((r) => r.r === 'Ambiguous'), `seed ${seed}: a lost COMMIT answer was injected`);
    await until(() => a.heldSlots().length === 4 && store.slotRow(DECL.kind, 0)?.sessionId === a.sessionId(), 5_000, `seed ${seed}: re-homed after the revocation`);
    assert.ok([0, 1, 2, 3].every((s) => (store.slotRow(DECL.kind, s)?.epoch ?? 0n) === 2n), `seed ${seed}: each slot re-homed once`);
    store.faults.commits.splice(0);
    // A pause past session_ttl: B takes the slot; A's late calls never commit.
    a.pauseRenewalsForTest();
    clock.step(FAST.sessionTtlMs + 1);
    const b = await boot(store, [0]);
    assert.deepEqual(b.heldSlots(), [0], `seed ${seed}`);
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
    checkLog(store, commits, seed);
    await a.stop(); await b.stop();
  }
});
