/**
 * S-PLAT-I3 work items 1, 4, 5: placement's move coordinator (C01 §3.3 steps 1 and 7, MOVE_CUTOVER), end to end with
 * two runtimes on one in-memory store; the hot-link trigger; the sender's STALE_SENDER rule (D4).
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppendResult, OwnerDeclaration, OwnerHooks, SlotNo } from '../src/index.ts';
import {
  CockroachOwnerRuntime, HotPartitionDetector, ManualLoad, MemoryMoveStore, MoveCoordinator, MoveError, hex, slotOfPartition, staleSenderAction, utf8,
  type MoveCutoverAlert, type MoveHolders, type Scheduler,
} from '../src/index.ts';
import { MemoryStore } from '../testing/index.ts';
import { Closers, until } from './support.ts';

const DECL: OwnerDeclaration = {
  kind: 'plink', slotCount: 4, statusReaders: true,
  entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }], projections: [], streams: [],
};
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const entry = (id: string) => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id } });
const FAST = { sessionTtlMs: 300, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 280, maxLoopDelayMs: 20 };
const X = utf8('link-hot');
const SA = slotOfPartition(X, 4);
const closers = new Closers();
const T = { timeout: 20_000 };
afterEach(() => closers.closeAll());

function hooks(): OwnerHooks {
  return { async onAcquire() {}, onRelease() {}, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {} };
}

/** A scheduler on a stepped clock: `advance(ms)` runs the jobs that are due; `delays()` gives each job's delay. */
function manualScheduler(): Scheduler & { advance(ms: number): void; pending(): number; delays(): number[] } {
  let now = 0;
  const delays: number[] = [];
  let jobs: Array<{ fn: () => void; live: boolean; at: number }> = [];
  return {
    schedule(ms, fn) { delays.push(ms); const j = { fn, live: true, at: now + ms }; jobs.push(j); return { cancel: () => { j.live = false; } }; },
    advance(ms) {
      now += ms;
      for (const j of jobs) if (j.live && j.at <= now) { j.live = false; j.fn(); }
      jobs = jobs.filter((j) => j.live);
    },
    pending() { return jobs.filter((j) => j.live).length; },
    delays() { return [...delays]; },
  };
}

async function setup() {
  const store = new MemoryStore();
  store.seedSlots(DECL.kind, 6);
  const inbox = new Map<SlotNo, CockroachOwnerRuntime>();
  const make = async (slots: SlotNo[]): Promise<CockroachOwnerRuntime> => {
    const rt = new CockroachOwnerRuntime({ declaration: DECL, store, slots, load: new ManualLoad(),
      moves: { peer: (_k, s) => inbox.get(s)?.moveInbox() },
      testing: { sessionTimings: FAST, commitBackstopMs: 1_000, postAcquisitionWaitMs: 10, adoptReportWaitMs: 10 } });
    closers.add(() => rt.stop());
    await rt.start(hooks());
    await until(() => slots.every((s) => rt.heldSlots().includes(s)), 5_000, 'slots held');
    for (const s of slots) inbox.set(s, rt);
    return rt;
  };
  const a = await make([0, 1, 2, 3]);
  const b = await make([4]);
  const c = await make([5]);
  const holders: MoveHolders = {
    prepare: (m) => (inbox.get(m.to) as CockroachOwnerRuntime).prepareAdopt(m),
    moveOut: (m) => (inbox.get(m.from) as CockroachOwnerRuntime).moveOut(m.partition, m.to, m.generation),
    adopt: (m) => (inbox.get(m.to) as CockroachOwnerRuntime).adopt(m.partition),
  };
  return { store, a, b, c, holders };
}

test('C01 CP-5 placement records the move prewarm → moved → adopted → done, publishes routing after adopt, and a second move takes generation 2', T, async () => {
  const { store, a, b, c, holders } = await setup();
  const moves = new MemoryMoveStore();
  const states: string[] = [];
  const published: string[] = [];
  const track = new Proxy(moves, { get: (t, p) => {
    if (p === 'setState') return async (k: string, part: Uint8Array, g: number, s: string) => { states.push(`${g}:${s}`); await t.setState(k, part, g, s as 'done'); };
    return Reflect.get(t, p) as unknown;
  } });
  const coord = new MoveCoordinator({ store: track, holders, publishRouting: async () => { published.push(states.at(-1) ?? 'none'); } });
  const r0 = await a.append({ partition: X, entries: [entry('a1')] });
  assert.equal(r0.r, 'Committed');
  assert.deepEqual(await coord.move({ kind: DECL.kind, partition: X, from: SA, to: 4 }), { generation: 1 });
  assert.deepEqual(await coord.move({ kind: DECL.kind, partition: X, from: 4, to: 5 }), { generation: 2 });
  assert.deepEqual(states, ['1:moved', '1:adopted', '1:done', '2:moved', '2:adopted', '2:done']);
  assert.deepEqual(published, ['1:adopted', '2:adopted'], 'routing is published after adopt and before done');
  assert.deepEqual((await moves.movesOf(DECL.kind, X)).map((m) => [m.fromSlot, m.toSlot, m.generation, m.state]), [[SA, 4, 1, 'done'], [4, 5, 2, 'done']]);
  assert.deepEqual(await b.append({ partition: X, entries: [entry('b')] }), { r: 'Moved', slot: 5, generation: 2 });
  assert.equal((await c.append({ partition: X, entries: [entry('c1')] })).r, 'Committed');
  assert.deepEqual(store.log.filter((l) => hex(l.partition) === hex(X)).map((l) => [l.seq, l.generation]),
    [[1n, 0], [2n, 0], [3n, 1], [4n, 1], [5n, 2], [6n, 2]]);
});

test('should refuse a second move while one is open (OPEN_MOVE), and keep the row moved when B refuses adopt (a stop), then resume it', T, async () => {
  const { store, a, holders } = await setup();
  await a.append({ partition: X, entries: [entry('a1')] });
  const moves = new MemoryMoveStore();
  const coord = new MoveCoordinator({ store: moves, holders });
  const real = holders.moveOut;
  holders.moveOut = async (m) => { store.stopPartition(DECL.kind, [m.from, m.to], m.partition, utf8('det')); return real(m); };
  await assert.rejects(coord.move({ kind: DECL.kind, partition: X, from: SA, to: 4 }),
    (e: unknown) => e instanceof MoveError && e.code === 'MOVED_REFUSED' && e.result?.r === 'Stopped');
  assert.deepEqual((await moves.movesOf(DECL.kind, X)).map((m) => m.state), ['prewarm']);
  await assert.rejects(coord.move({ kind: DECL.kind, partition: X, from: SA, to: 4 }), (e: unknown) => e instanceof MoveError && e.code === 'OPEN_MOVE');
  store.resumePartition(DECL.kind, [SA, 4], X);
  holders.moveOut = real;
  // A second partition: stop lands after moved, so adopt is refused and the row stays moved.
  const Y = utf8('link-y');
  const SY = slotOfPartition(Y, 4);
  await a.append({ partition: Y, entries: [entry('y1')] });
  const realAdopt = holders.adopt;
  holders.adopt = async (m) => { store.stopPartition(DECL.kind, [m.from, m.to], m.partition, utf8('det-y')); return realAdopt(m); };
  await assert.rejects(coord.move({ kind: DECL.kind, partition: Y, from: SY, to: 4 }),
    (e: unknown) => e instanceof MoveError && e.code === 'ADOPT_REFUSED' && e.result?.r === 'Stopped');
  assert.deepEqual((await moves.movesOf(DECL.kind, Y)).map((m) => m.state), ['moved']);
  holders.adopt = realAdopt;
  store.resumePartition(DECL.kind, [SY, 4], Y);
  assert.deepEqual(await coord.resume(DECL.kind, Y), { generation: 1 });
  assert.deepEqual((await moves.movesOf(DECL.kind, Y)).map((m) => m.state), ['done']);
  await assert.rejects(coord.resume(DECL.kind, Y), (e: unknown) => e instanceof MoveError && e.code === 'NO_MOVE');
});

test('should raise MOVE_CUTOVER (a page) when the partition is Moving longer than move_cutover_max, and not when adopt is in time', T, async () => {
  const sched = manualScheduler();
  const alerts: MoveCutoverAlert[] = [];
  let adoptAnswer: ((r: AppendResult) => void) | undefined;
  const holders: MoveHolders = {
    prepare: async () => {},
    moveOut: async () => ({ r: 'Committed', seqFrom: 2n, seqTo: 2n, ts: '1.0000000000' as never, streamSeqs: {} }),
    adopt: () => new Promise((r) => { adoptAnswer = r; }),
  };
  const coord = new MoveCoordinator({ store: new MemoryMoveStore(), holders, scheduler: sched, alert: (a) => alerts.push(a) });
  const moving = coord.move({ kind: 'link', partition: X, from: 1, to: 9 });
  await until(() => adoptAnswer !== undefined, 5_000, 'adopt asked');
  assert.equal(sched.pending(), 1);
  assert.deepEqual(sched.delays(), [1_000]);
  sched.advance(999);
  assert.equal(alerts.length, 0, 'no page before move_cutover_max');
  sched.advance(1);
  assert.deepEqual(alerts, [{ alertKind: 'MOVE_CUTOVER', severity: 'page', reasonCode: 'MOVING_OVER_MAX', entities: [{ type: 'link', id: X }],
    detail: { kind: 'link', from: 1, to: 9, generation: 1, maxMs: 1_000 } }]);
  adoptAnswer?.({ r: 'Committed', seqFrom: 3n, seqTo: 3n, ts: '2.0000000000' as never, streamSeqs: {} });
  assert.deepEqual(await moving, { generation: 1 });
  const quick = new MoveCoordinator({ store: new MemoryMoveStore(), scheduler: sched, alert: (a) => alerts.push(a),
    holders: { ...holders, adopt: async () => ({ r: 'Committed', seqFrom: 3n, seqTo: 3n, ts: '2.0000000000' as never, streamSeqs: {} }) } });
  await quick.move({ kind: 'link', partition: X, from: 1, to: 9 });
  assert.deepEqual(sched.delays(), [1_000, 1_000]);
  assert.equal(sched.pending(), 0, 'the watchdog is cancelled when adopt commits in time');
  sched.advance(1_000);
  assert.equal(alerts.length, 1);
});

test('should report a partition as hot only after a full 10 min window above 200 requests a second, once, and again after it cooled', T, () => {
  const d = new HotPartitionDetector();
  const P = utf8('L');
  const Q = utf8('Q');
  const t0 = 1_800_000_000_000;
  for (let s = 0; s < 600; s++) { d.record(P, t0 + s * 1_000, 201); d.record(Q, t0 + s * 1_000, 200); }
  assert.deepEqual(d.due(t0 + 599_999), [], 'the window is not full yet');
  assert.deepEqual(d.due(t0 + 600_000), [hex(P)], 'exactly 200 a second is not above the limit');
  assert.deepEqual(d.due(t0 + 600_500), [], 'reported once');
  assert.deepEqual(d.due(t0 + 1_300_000), [], 'cooled: no requests in the last window');
  for (let s = 1_300; s < 1_900; s++) d.record(P, t0 + s * 1_000, 300);
  assert.deepEqual(d.due(t0 + 1_900_000), [hex(P)], 'hot again after it cooled');
});

test('C01 CC-5 STALE_SENDER (D4): equal generation and higher epoch ⇒ slot lost; higher generation ⇒ drop, keep the slot, alert only if moved is not applied', T, () => {
  const own = { generation: 1, epoch: 5n };
  assert.deepEqual(staleSenderAction(own, { generation: 1, epoch: 6n }, false), { action: 'slotLost' });
  assert.deepEqual(staleSenderAction(own, { generation: 2, epoch: 1n }, true), { action: 'dropKeepSlot', alertUnmoved: false });
  assert.deepEqual(staleSenderAction(own, { generation: 2, epoch: 1n }, false), { action: 'dropKeepSlot', alertUnmoved: true });
  assert.deepEqual(staleSenderAction(own, { generation: 1, epoch: 5n }, false), { action: 'defect' });
  assert.deepEqual(staleSenderAction(own, { generation: 0, epoch: 9n }, false), { action: 'defect' });
});
