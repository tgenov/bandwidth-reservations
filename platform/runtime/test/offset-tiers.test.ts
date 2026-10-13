/**
 * S-PLAT-I2 work items 7 and 8: gateway tier breakers (RFC-006 §4.7, C01 §7) and the owner-host offset ladder
 * (RFC-006 §6.2, §6.3; DT-09 owner-host part, at the unit level).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HlcTs, OwnerDeclaration, OwnerHooks, SlotNo } from '../src/index.ts';
import { CockroachOwnerRuntime, GatewayTiers, ManualLoad, OffsetMonitor, TierTimeout, hlcFromWallMs, withTierTimeout } from '../src/index.ts';
import type { OffsetLevel } from '../src/index.ts';
import { MemoryStore } from '../testing/index.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

test('should reject with TierTimeout after the per-tier timeout and hand a late value to onLate', async () => {
  let late: string | undefined;
  const slow = new Promise<string>((r) => setTimeout(() => r('late'), 40));
  await assert.rejects(withTierTimeout(slow, 2, 10, (v) => { late = v; }), (e: unknown) => e instanceof TierTimeout && e.tier === 2);
  await sleep(50);
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

test('should reach level W only after 1 min above 20 ms', async () => {
  const { m, levels, tick } = monitor(() => 25);
  await m.sampleOnce();
  tick(59_999); await m.sampleOnce();
  assert.deepEqual(levels, []);
  tick(1); await m.sampleOnce();
  assert.deepEqual(levels, ['W']);
});

const DECL: OwnerDeclaration = { kind: 'skew', slotCount: 4, entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }], projections: [], streams: [] };
const FAST = { sessionTtlMs: 3_000, sessionRenewMs: 500, renewRetryMs: 100, holderViewMs: 2_900, maxLoopDelayMs: 200 };
function hooks(released: Array<[SlotNo, string]>): OwnerHooks {
  return { async onAcquire() {}, onRelease(s, r) { released.push([s, r]); }, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {} };
}

test('DT-09 an owner host whose offset bound exceeds 50 ms gives up its session within 3 s (in-memory database clock)', async () => {
  const store = new MemoryStore();
  store.seedSlots(DECL.kind, 4);
  const released: Array<[SlotNo, string]> = [];
  let gaveUp = 0;
  let skewMs = 0;
  let measured: number | undefined;
  const rt = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], load: new ManualLoad(),
    wallMs: () => Date.now() - skewMs, offsetCheck: { onGiveUp: () => { gaveUp += 1; }, onSample: (smp) => { if (skewMs > 0 && smp.boundMs > 50) measured ??= Date.now(); } },
    testing: { sessionTimings: FAST } });
  await rt.start(hooks(released));
  assert.deepEqual(rt.heldSlots(), [0, 1, 2, 3]);
  await sleep(1_100);
  assert.equal(store.sessions.get(rt.sessionId())?.revoked, false, 'within bound: nothing happens');
  skewMs = 60;                                       // the host's clock falls 60 ms behind the database's
  const start = Date.now();
  while (store.sessions.get(rt.sessionId())?.revoked !== true && Date.now() - start < 4_000) await sleep(10);
  assert.equal(store.sessions.get(rt.sessionId())?.revoked, true);
  assert.ok(measured !== undefined && start <= measured);
  while (gaveUp === 0 && Date.now() - start < 4_000) await sleep(10);
  const took = Date.now() - measured;
  assert.ok(took <= 3_000, `gave up the session ${took} ms after the first sample above 50 ms`);
  assert.deepEqual(rt.heldSlots(), []);
  // The first sample above 50 ms is above 40 ms too (level A): the slots are handed off before level D.
  assert.deepEqual(released.map(([, r]) => r), ['handedOff', 'handedOff', 'handedOff', 'handedOff']);
  assert.equal(gaveUp, 1);
  assert.equal((await rt.append({ partition: new Uint8Array([1]), entries: [] })).r, 'StaleEpoch', 'it serves nothing after it gave up');
  await rt.stop();
});

test('should stop taking slots and hand every slot off, keeping the session, when the offset bound is above 40 ms', async () => {
  const store = new MemoryStore();
  store.seedSlots(DECL.kind, 4);
  const released: Array<[SlotNo, string]> = [];
  let skewMs = 0;
  const levels: OffsetLevel[] = [];
  const rt = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], load: new ManualLoad(),
    wallMs: () => Date.now() - skewMs, offsetCheck: { intervalMs: 50, onLevel: (l) => levels.push(l) }, testing: { sessionTimings: FAST } });
  await rt.start(hooks(released));
  skewMs = 45;
  const end = Date.now() + 2_000;
  while (rt.heldSlots().length > 0 && Date.now() < end) await sleep(10);
  assert.deepEqual(rt.heldSlots(), []);
  assert.deepEqual(released.map(([, r]) => r), ['handedOff', 'handedOff', 'handedOff', 'handedOff']);
  assert.equal(store.slotRow('skew', 0)?.sessionId, null, 'the slot is free for another process');
  assert.equal(store.sessions.get(rt.sessionId())?.revoked, false, 'the session is kept');
  await sleep(700);                                  // more renewal ticks: still above 40 ms, no slot taken back
  assert.deepEqual(rt.heldSlots(), []);
  assert.equal(levels[0], 'A');
  await rt.stop();
});
