/**
 * S-PLAT-I2 work items 7 and 8: gateway tier breakers (RFC-006 §4.7, C01 §7) and the owner-host offset ladder
 * (RFC-006 §6.2, §6.3; DT-09 owner-host part, at the unit level).
 */
import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { HlcTs, OwnerDeclaration, OwnerHooks, SlotNo } from '../src/index.ts';
import { CockroachOwnerRuntime, GatewayTiers, ManualLoad, OFFSET, OffsetMonitor, TierTimeout, hlcFromWallMs, slotOfPartition, utf8, withTierTimeout } from '../src/index.ts';
import type { OffsetLevel } from '../src/index.ts';
import { MemoryStore } from '../testing/index.ts';
import { Closers, countCalls, steppedClock, until, yieldTurns } from './support.ts';

const closers = new Closers();
afterEach(() => closers.closeAll());
const T = { timeout: 15_000 };

// ---------------- gateway tiers ----------------

test('should open a tier\'s breaker after 3 consecutive timeouts, start at the next live tier, and half-open after openMs', () => {
  let now = 1_000;
  const t = new GatewayTiers(3, { wallMs: () => now, openMs: 10_000 });
  assert.deepEqual(t.order(), [0, 1, 2]);
  t.timeout(0); t.timeout(0);
  assert.deepEqual(t.order(), [0, 1, 2], 'two timeouts do not open it');
  t.success(0);
  t.timeout(0); t.timeout(0);
  assert.deepEqual(t.order(), [0, 1, 2], 'a success resets the count');
  t.timeout(0);
  assert.equal(t.isOpen(0), true);
  assert.deepEqual(t.order(), [1, 2, 0]);
  now += 9_999;
  assert.equal(t.isOpen(0), true);
  now += 1;
  assert.deepEqual(t.order(), [0, 1, 2], 'half-open after openMs');
  t.timeout(0);
  assert.equal(t.isOpen(0), true, 'one timeout opens a half-open tier again');
  t.open(1);                                         // an outside signal: BFD loss or placement's metro split
  assert.deepEqual(t.order(), [2, 0, 1]);
});

test('should reject with TierTimeout after the per-tier timeout and hand a late value to onLate', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  let late: string | undefined;
  const slow = new Promise<string>((r) => setTimeout(() => r('late'), 40));
  const refused = assert.rejects(withTierTimeout(slow, 2, 10, (v) => { late = v; }), (e: unknown) => e instanceof TierTimeout && e.tier === 2);
  mock.timers.tick(10);
  await refused;
  assert.equal(late, undefined);
  mock.timers.tick(30);
  await yieldTurns(2);
  assert.equal(late, 'late');
  assert.equal(await withTierTimeout(Promise.resolve(7), 0, 10), 7);
  await assert.rejects(withTierTimeout(Promise.reject(new Error('refused')), 0, 10), /refused/);
});

// ---------------- offset ladder ----------------

/** A monitor whose database answers `skewMs` ahead of the wall clock after `rttMs` of monotonic time. */
function monitor(skewMs: () => number, rttMs = 2) {
  let wall = 1_800_000_000_000;
  let mono = 0n;
  const levels: OffsetLevel[] = [];
  const m = new OffsetMonitor({
    wallMs: () => wall, monoNs: () => mono, onLevel: (l) => levels.push(l),
    dbTime: async () => { mono += BigInt(rttMs * 1e6); return hlcFromWallMs(wall + rttMs / 2 + skewMs()) as HlcTs; },
  });
  return { m, levels, tick: (ms: number) => { wall += ms; } };
}

test('should compute offset = db − (t_send + rtt/2) and bound = |offset| + rtt/2 when a sample is taken', async () => {
  const { m } = monitor(() => -30, 4);
  const s = await m.sampleOnce();
  assert.equal(s.rttMs, 4);
  assert.equal(s.offsetMs, -30);
  assert.equal(s.boundMs, 32);
  assert.equal(s.level, 'normal');
});

test('should reach level A above 40 ms at once, and level D only on the third consecutive sample above 50 ms', async () => {
  let skew = 38;                                     // bound 38 + 1 = 39: below 40
  const { m, levels, tick } = monitor(() => skew);
  await m.sampleOnce();
  assert.deepEqual(levels, []);
  skew = 40;                                         // bound 41
  await m.sampleOnce();
  assert.deepEqual(levels, ['A']);
  skew = 55;
  await m.sampleOnce(); tick(1_000); await m.sampleOnce();
  assert.equal(m.currentLevel(), 'A', 'two samples above 50 ms are not enough');
  skew = 45;
  tick(1_000); await m.sampleOnce();
  skew = 55;
  tick(1_000); await m.sampleOnce(); tick(1_000); await m.sampleOnce();
  assert.equal(m.currentLevel(), 'A', 'the count restarts after a sample at or below 50 ms');
  tick(1_000); await m.sampleOnce();
  assert.deepEqual(levels, ['A', 'D']);
});

test('should stay normal at a bound of exactly 40 ms and not count a bound of exactly 50 ms toward level D', async () => {
  let skew = 39;                                     // bound 39 + 1 = 40: not above 40
  const { m, levels, tick } = monitor(() => skew);
  assert.equal((await m.sampleOnce()).boundMs, 40);
  assert.deepEqual(levels, []);
  skew = 49;                                         // bound exactly 50: level A, but not above 50
  for (let i = 0; i < 3; i++) { tick(1_000); assert.equal((await m.sampleOnce()).boundMs, 50); }
  assert.equal(m.currentLevel(), 'A');
  assert.deepEqual(levels, ['A']);
});

test('should reach level W only after 1 min above 20 ms', async () => {
  const { m, levels, tick } = monitor(() => 25);
  await m.sampleOnce();
  tick(59_999); await m.sampleOnce();
  assert.deepEqual(levels, []);
  tick(1); await m.sampleOnce();
  assert.deepEqual(levels, ['W']);
});

const DECL: OwnerDeclaration = { kind: 'skew', slotCount: 4, entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }], projections: [], streams: [] };
const FAST = { sessionTtlMs: 3_000, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 2_900, maxLoopDelayMs: 200 };
function hooks(released: Array<[SlotNo, string]>): OwnerHooks {
  return { async onAcquire() {}, onRelease(s, r) { released.push([s, r]); }, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {} };
}

/**
 * A runtime with the offset check on a stepped clock: the database's time is the clock, the host's wall clock is
 * the clock minus `skew()` (so every sample's bound is the skew). The samples are taken every 10 ms; DT-09 counts
 * samples, at OFFSET.intervalMs (1 s) each in production.
 */
async function skewed(o: { slots?: SlotNo[]; onLevel?: (l: OffsetLevel) => void; onGiveUp?: () => void } = {}) {
  const clock = steppedClock();
  const store = new MemoryStore({ wallMs: clock.now });
  store.seedSlots(DECL.kind, 4);
  let skewMs = 0;
  const released: Array<[SlotNo, string]> = [];
  const samples: number[] = [];
  const renewals = countCalls(store, 'renewSession');
  const rt = new CockroachOwnerRuntime({ declaration: DECL, store, slots: o.slots ?? [0, 1, 2, 3], load: new ManualLoad(), wallMs: () => clock.now() - skewMs,
    offsetCheck: { intervalMs: 10, onSample: (s) => samples.push(s.boundMs), ...(o.onLevel ? { onLevel: o.onLevel } : {}), ...(o.onGiveUp ? { onGiveUp: o.onGiveUp } : {}) },
    testing: { sessionTimings: FAST } });
  closers.add(() => rt.stop());
  await rt.start(hooks(released));
  /** Waits for `n` more offset samples. */
  const sampled = async (n: number) => { const at = samples.length; await until(() => samples.length >= at + n, 5_000, `${n} offset samples`); };
  /** Waits for `n` more renewal ticks (each tick also tries to take slots). */
  const ticks = async (n: number) => { const at = renewals.count(); await until(() => renewals.count() >= at + n + 1, 5_000, `${n} renewal ticks`); };
  return { store, clock, rt, released, samples, sampled, ticks, skew: (ms: number) => { skewMs = ms; } };
}

test('DT-09 an owner host whose offset bound exceeds 50 ms gives up its session within 3 s (in-memory database clock)', T, async () => {
  assert.equal(OFFSET.intervalMs, 1_000);
  let gaveUp = 0;
  let above50AtD: number | undefined;
  const h = await skewed({
    onLevel: (l) => { if (l === 'D') above50AtD = h.samples.filter((b) => b > 50).length; },
    onGiveUp: () => { gaveUp += 1; },
  });
  assert.deepEqual(h.rt.heldSlots(), [0, 1, 2, 3]);
  await h.sampled(3);
  assert.equal(h.store.sessions.get(h.rt.sessionId())?.revoked, false, 'within bound: nothing happens');
  assert.ok(h.samples.every((b) => b < OFFSET.handOffMs), 'bound: the round trip only');
  h.skew(60);                                        // the host's clock falls 60 ms behind the database's
  await until(() => gaveUp === 1, 5_000, 'gave up');
  // Level D comes on the third consecutive sample above 50 ms: 2 intervals of 1 s after the first one, within 3 s.
  assert.equal(above50AtD, 3);
  assert.ok((3 - 1) * OFFSET.intervalMs <= 3_000);
  assert.equal(h.store.sessions.get(h.rt.sessionId())?.revoked, true, 'the session is given up at level D');
  assert.deepEqual(h.rt.heldSlots(), []);
  // The first sample above 50 ms is above 40 ms too (level A): the slots are handed off before level D.
  assert.deepEqual(h.released.map(([, r]) => r), ['handedOff', 'handedOff', 'handedOff', 'handedOff']);
  assert.equal((await h.rt.append({ partition: new Uint8Array([1]), entries: [] })).r, 'StaleEpoch', 'it serves nothing after it gave up');
});

test('should stop taking slots and hand every slot off, keeping the session, when the offset bound is above 40 ms', T, async () => {
  const levels: OffsetLevel[] = [];
  const h = await skewed({ onLevel: (l) => levels.push(l) });
  h.skew(45);
  await until(() => h.rt.heldSlots().length === 0, 5_000, 'handed off');
  assert.deepEqual(h.released.map(([, r]) => r), ['handedOff', 'handedOff', 'handedOff', 'handedOff']);
  assert.equal(h.store.slotRow('skew', 0)?.sessionId, null, 'the slot is free for another process');
  assert.equal(h.store.sessions.get(h.rt.sessionId())?.revoked, false, 'the session is kept');
  await h.ticks(3);
  await h.sampled(3);
  assert.deepEqual(h.rt.heldSlots(), [], 'still above 40 ms: no slot taken back');
  assert.deepEqual(levels, ['A']);
});

test('should take no slot for 10 min after the bound returns within 40 ms, and take slots again after that', T, async () => {
  const levels: OffsetLevel[] = [];
  const h = await skewed({ onLevel: (l) => levels.push(l) });
  h.skew(45);
  await until(() => h.rt.heldSlots().length === 0, 5_000, 'handed off');
  h.skew(0);
  await until(() => levels.at(-1) === 'normal', 5_000, 'back within bound');
  await h.ticks(3);
  assert.deepEqual(h.rt.heldSlots(), [], 'just back within bound');
  h.clock.step(10 * 60_000 - 1);
  await h.ticks(3);
  assert.deepEqual(h.rt.heldSlots(), [], '1 ms before 10 min within bound');
  h.clock.step(1);
  await until(() => h.rt.heldSlots().length === 4, 5_000, 'slots taken again after 10 min within bound');
  assert.deepEqual(h.rt.heldSlots(), [0, 1, 2, 3]);
  assert.deepEqual(levels, ['A', 'normal']);
});

test('should serve a slot whose acquisition committed but whose answer was lost on a cut gateway tier', T, async () => {
  const clock = steppedClock();
  const store = new MemoryStore({ wallMs: clock.now });
  store.seedSlots(DECL.kind, 4);
  await store.insertSession({ shard: 0, sessionId: 'foreign', host: 'h', region: 'r1', facility: 'r1a', kind: DECL.kind, ttlMs: 60_000 });
  await store.acquireFree(DECL.kind, 2, 'foreign');
  const rt = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], load: new ManualLoad(), wallMs: clock.now, testing: { sessionTimings: FAST } });
  closers.add(() => rt.stop());
  await rt.start(hooks([]));
  assert.deepEqual(rt.heldSlots(), [0, 1, 3]);
  // Slot 2 becomes free; this process's acquisition of it commits, but its answer is lost (the tier times out).
  const acquireFree = store.acquireFree.bind(store);
  let lost = 0;
  store.acquireFree = async (kind, slot, sessionId) => {
    const got = await acquireFree(kind, slot, sessionId);
    if (slot === 2 && lost === 0) { lost += 1; throw new TierTimeout(0, 400); }
    return got;
  };
  await store.release(DECL.kind, [{ slot: 2, epoch: 1n }], 'foreign', true);
  await until(() => rt.heldSlots().includes(2), 5_000, 'slot 2 adopted');
  assert.equal(lost, 1);
  assert.equal(store.slotRow(DECL.kind, 2)?.sessionId, rt.sessionId());
  assert.equal(store.slotRow(DECL.kind, 2)?.epoch, 2n, 'adopted at the epoch of the lost acquisition, not taken again');
  assert.equal(rt.epoch(2), 2n);
  const p = (() => { for (let i = 0; ; i++) { const x = utf8(`p-${i}`); if (slotOfPartition(x, 4) === 2) return x; } })();
  assert.equal((await rt.append({ partition: p, entries: [{ kind: 1, schemaV: 1, identity: utf8('i'), audit: { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 }, payload: {} }] })).r, 'Committed');
});
