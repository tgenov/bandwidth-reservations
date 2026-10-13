/**
 * S-PLAT-I2 work item 4: slot groups (RFC-006 §4.2, §7.1; C01 §2.2 `slotGroupWith`, §3.1). Slot i of
 * attr_b and slot i of rating are taken, taken over and re-homed in one transaction, or not at all.
 * Exit criterion (3) at the unit level, with fault injection on the in-memory store.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Epoch, OwnerDeclaration, OwnerHooks, SlotNo } from '../src/index.ts';
import { CockroachOwnerRuntime, ManualLoad, SlotGroupError, slotOfPartition, utf8 } from '../src/index.ts';
import { MemoryStore } from '../testing/index.ts';
import { Closers, countCalls, rng, steppedClock, until, yieldTurns } from './support.ts';

const base = (kind: string, partner: string): OwnerDeclaration => ({
  kind, slotCount: 4, slotGroupWith: partner,
  entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }],
  projections: [], streams: [],
});
const ATTR = base('attr_b', 'rating');
const RATING = base('rating', 'attr_b');
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const entry = (id: string) => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id } });
const FAST = { sessionTtlMs: 300, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 280, maxLoopDelayMs: 20 };
const closers = new Closers();
afterEach(() => closers.closeAll());
const T = { timeout: 15_000 };

/** An assertion that the error is a SlotGroupError with this code. */
const groupCode = (code: string) => (e: unknown): boolean => e instanceof SlotGroupError && e.code === code;

interface Calls { events: string[] }
function hooks(kind: string, calls: Calls): OwnerHooks {
  return {
    async onAcquire(slot: SlotNo, epoch: Epoch, how) { calls.events.push(`acquire ${kind} ${slot} ${epoch} ${how}`); },
    onRelease(slot, reason) { calls.events.push(`release ${kind} ${slot} ${reason}`); },
    onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {},
  };
}

/** The stepped clock of each store: a session expires only when the test steps the clock past session_ttl. */
const clocks = new Map<MemoryStore, ReturnType<typeof steppedClock>>();
const clockOf = (store: MemoryStore): ReturnType<typeof steppedClock> => clocks.get(store) as ReturnType<typeof steppedClock>;

function seed(): MemoryStore {
  const clock = steppedClock();
  const store = new MemoryStore({ wallMs: clock.now });
  clocks.set(store, clock);
  store.seedSlots('attr_b', 4);
  store.seedSlots('rating', 4);
  return store;
}

async function group(store: MemoryStore, slots: SlotNo[], calls: Calls = { events: [] }) {
  const member = new CockroachOwnerRuntime({ declaration: RATING, store, slots, load: new ManualLoad(), slotGroupMember: true, testing: { sessionTimings: FAST } });
  const leader = new CockroachOwnerRuntime({ declaration: ATTR, store, slots, load: new ManualLoad(), slotGroup: { members: [member] }, testing: { sessionTimings: FAST } });
  closers.add(() => leader.stop());
  await member.start(hooks('rating', calls));
  await leader.start(hooks('attr_b', calls));
  return { leader, member, calls, stop: async () => { await leader.stop(); } };
}

/** For every slot, the two members' rows name the same session (or both none) and have the same epoch. */
function groupWhole(store: MemoryStore): string | undefined {
  for (let s = 0; s < 4; s++) {
    const a = store.slotRow('attr_b', s);
    const b = store.slotRow('rating', s);
    if (a?.sessionId !== b?.sessionId || a?.epoch !== b?.epoch) return `slot ${s}: attr_b ${a?.sessionId}/${a?.epoch}, rating ${b?.sessionId}/${b?.epoch}`;
  }
  return undefined;
}

test('should take slot i of both kinds in one transaction and call onAcquire for every member before either serves when a slot group starts', T, async () => {
  const store = seed();
  const g = await group(store, [0, 1, 2, 3]);
  assert.deepEqual(g.leader.heldSlots(), [0, 1, 2, 3]);
  assert.deepEqual(g.member.heldSlots(), [0, 1, 2, 3]);
  assert.equal(groupWhole(store), undefined);
  assert.equal(store.slotRow('rating', 2)?.sessionId, g.leader.sessionId());
  assert.equal(store.slotGroups.get('attr_b|2'), 'attr_b+rating:2');
  assert.equal(store.slotGroups.get('rating|2'), 'attr_b+rating:2');
  assert.deepEqual(g.calls.events.filter((e) => e.startsWith('acquire')).sort(),
    [0, 1, 2, 3].flatMap((s) => [`acquire attr_b ${s} 1 expiry`, `acquire rating ${s} 1 expiry`]).sort());
  const p = utf8('buyer-7');
  assert.equal((await g.leader.append({ partition: p, entries: [entry('a1')] })).r, 'Committed');
  assert.equal((await g.member.append({ partition: p, entries: [entry('r1')] })).r, 'Committed');
  await g.stop();
  assert.equal(store.slotRow('attr_b', 0)?.sessionId, null);
  assert.equal(store.slotRow('rating', 0)?.sessionId, null, 'the leader releases the member\'s slots too');
});

test('should take neither member of a slot when the other member\'s row is held by another live session', T, async () => {
  const store = seed();
  await store.insertSession({ shard: 0, sessionId: 'foreign', host: 'h', region: 'r1', facility: 'r1a', kind: 'rating', ttlMs: 60_000 });
  await store.acquireFree('rating', 1, 'foreign');
  const polls = countCalls(store, 'listSlots');
  const g = await group(store, [0, 1]);
  const at = polls.count();
  await until(() => polls.count() >= at + 6, 5_000, 'three more acquisition ticks');
  assert.deepEqual(g.leader.heldSlots(), [0]);
  assert.deepEqual(g.member.heldSlots(), [0]);
  assert.equal(store.slotRow('attr_b', 1)?.sessionId, null, 'attr_b slot 1 stays free: no part of a group is taken');
  assert.equal(store.slotRow('attr_b', 1)?.epoch, 0n);
  await g.stop();
});

test('should change neither row when the group transaction fails after its first member update, and take both on the next tick', T, async () => {
  const store = seed();
  // A foreign session holds slot 3 of both kinds and expires at once.
  await store.insertSession({ shard: 0, sessionId: 'old', host: 'h', region: 'r1', facility: 'r1a', kind: 'attr_b', ttlMs: 0 });
  await store.acquireFree('attr_b', 3, 'old');
  await store.acquireFree('rating', 3, 'old');
  store.groupFailAfter = 1;
  let atFault: string | undefined;
  const real = store.acquireGroup.bind(store);
  store.acquireGroup = async (...args) => {
    try { return await real(...args); } catch (e) {
      atFault = [store.slotRow('attr_b', 3), store.slotRow('rating', 3)].map((r) => `${r?.sessionId}/${r?.epoch}`).join(' ')
        + ` revoked=${String(store.sessions.get('old')?.revoked)}`;
      throw e;
    }
  };
  const g = await group(store, [3]).catch((e: unknown) => e);
  assert.ok(g instanceof Error && /injected: group transaction failed/.test(g.message), 'the first acquisition failed');
  assert.equal(atFault, 'old/1 old/1 revoked=false', 'nothing of the failed transaction was applied');
  const h = await group(store, [3]);
  assert.deepEqual([h.leader.heldSlots(), h.member.heldSlots()], [[3], [3]]);
  assert.equal(store.slotRow('attr_b', 3)?.epoch, 2n);
  assert.equal(store.slotRow('rating', 3)?.epoch, 2n);
  assert.equal(groupWhole(store), undefined);
  await h.stop();
});

test('should take over every slot of a paused group by expiry in one transaction; the old holder commits nothing in either kind', T, async () => {
  const store = seed();
  const a = await group(store, [0, 1, 2, 3]);
  const p = utf8('buyer-1');
  const slot = slotOfPartition(p, 4);
  assert.equal((await a.member.append({ partition: p, entries: [entry('a-r1')] })).r, 'Committed');
  a.leader.pauseRenewalsForTest();
  a.leader.lapseForTest();                         // the paused holder's view of its session has ended
  clockOf(store).step(FAST.sessionTtlMs + 1);
  const bCalls: Calls = { events: [] };
  const b = await group(store, [0, 1, 2, 3], bCalls);
  assert.deepEqual([b.leader.heldSlots(), b.member.heldSlots()], [[0, 1, 2, 3], [0, 1, 2, 3]], 'taken at start, by expiry');
  assert.equal(groupWhole(store), undefined);
  assert.equal(store.slotRow('rating', slot)?.epoch, 2n);
  assert.equal(store.slotRow('attr_b', slot)?.epoch, 2n);
  const late = a.member.append({ partition: p, entries: [entry('a-r2')] });
  a.leader.resumeRenewalsForTest();
  assert.equal((await late).r, 'StaleEpoch');
  await until(() => a.member.heldSlots().length === 0 && a.leader.heldSlots().length === 0);
  assert.ok(a.calls.events.includes(`release rating ${slot} taken`));
  assert.ok(a.calls.events.includes(`release attr_b ${slot} taken`));
  assert.equal((await b.member.append({ partition: p, entries: [entry('b-r1')] })).r, 'Committed');
  assert.ok(!store.log.some((l) => Buffer.from(l.identity).toString() === 'a-r2'), 'nothing of the deposed holder commits');
  await a.stop(); await b.stop();
});

test('should re-home both members of each slot in one transaction to a new session when the session is revoked', T, async () => {
  const store = seed();
  const g = await group(store, [0, 1]);
  const old = g.leader.sessionId();
  const s = store.sessions.get(old);
  assert.ok(s);
  s.revoked = true;
  await until(() => g.leader.sessionId() !== old && g.calls.events.filter((e) => e.endsWith('rehome')).length === 4);
  assert.equal(store.slotRow('attr_b', 0)?.sessionId, g.leader.sessionId());
  assert.equal(store.slotRow('rating', 0)?.sessionId, g.leader.sessionId());
  assert.equal(store.slotRow('rating', 1)?.epoch, 2n);
  assert.equal(groupWhole(store), undefined);
  assert.equal((await g.member.append({ partition: utf8('buyer-x'), entries: [entry('after-rehome')] })).r, 'Committed');
  await g.stop();
});

test('should hand off slot i of every member in one transaction or not at all when the offset bound is above 40 ms', T, async () => {
  const clock = steppedClock();
  const store = new MemoryStore({ wallMs: clock.now });
  store.seedSlots('attr_b', 4);
  store.seedSlots('rating', 4);
  let skewMs = 0;
  const calls: Calls = { events: [] };
  const member = new CockroachOwnerRuntime({ declaration: RATING, store, slots: [0, 1], load: new ManualLoad(), slotGroupMember: true, testing: { sessionTimings: FAST } });
  const leader = new CockroachOwnerRuntime({ declaration: ATTR, store, slots: [0, 1], load: new ManualLoad(), slotGroup: { members: [member] },
    wallMs: () => clock.now() - skewMs, offsetCheck: { intervalMs: 10 }, testing: { sessionTimings: FAST } });
  closers.add(() => leader.stop());
  await member.start(hooks('rating', calls));
  await leader.start(hooks('attr_b', calls));
  assert.deepEqual([leader.heldSlots(), member.heldSlots()], [[0, 1], [0, 1]]);
  // The first hand-off fails after its first member update: the second release call (a split group) or the group
  // transaction after one member (nothing applied).
  let tried = 0;
  const release = store.release.bind(store);
  store.release = async (...a) => { tried += 1; if (tried === 2) throw new Error('injected: hand-off failed'); return release(...a); };
  store.groupFailAfter = 1;
  const releaseGroup = store.releaseGroup?.bind(store);
  if (releaseGroup) store.releaseGroup = async (...a) => { tried += 1; return releaseGroup(...a); };
  skewMs = 45;
  await until(() => tried >= 1 && store.groupFailAfter === undefined || tried >= 2, 5_000, 'the first hand-off was tried');
  assert.equal(groupWhole(store), undefined, 'no member of a slot was handed off without the other');
  await until(() => leader.heldSlots().length === 0 && member.heldSlots().length === 0, 5_000, 'the next tick hands the group off');
  for (const s of [0, 1]) assert.deepEqual([store.slotRow('attr_b', s)?.sessionId, store.slotRow('rating', s)?.sessionId], [null, null]);
  assert.equal(groupWhole(store), undefined);
  assert.deepEqual(calls.events.filter((e) => e.startsWith('release')).sort(),
    ['release attr_b 0 handedOff', 'release attr_b 1 handedOff', 'release rating 0 handedOff', 'release rating 1 handedOff']);
});

test('should refuse a slot group whose declarations do not name each other, have different slot counts, or start the leader first', T, async () => {
  const store = seed();
  const other = new CockroachOwnerRuntime({ declaration: { ...RATING, kind: 'other', slotGroupWith: undefined }, store, slots: [0], load: new ManualLoad(), slotGroupMember: true });
  assert.throws(() => new CockroachOwnerRuntime({ declaration: { ...ATTR, slotGroupWith: undefined }, store, slots: [0], load: new ManualLoad(), slotGroup: { members: [other] } }),
    groupCode('GROUP_PARTNER'));
  const wide = new CockroachOwnerRuntime({ declaration: { ...RATING, slotCount: 8 }, store, slots: [0], load: new ManualLoad(), slotGroupMember: true });
  assert.throws(() => new CockroachOwnerRuntime({ declaration: ATTR, store, slots: [0], load: new ManualLoad(), slotGroup: { members: [wide] } }), groupCode('GROUP_SLOT_COUNT'));
  const plain = new CockroachOwnerRuntime({ declaration: RATING, store, slots: [0], load: new ManualLoad() });
  assert.throws(() => new CockroachOwnerRuntime({ declaration: ATTR, store, slots: [0], load: new ManualLoad(), slotGroup: { members: [plain] } }), groupCode('GROUP_MEMBER_FLAG'));
  const m = new CockroachOwnerRuntime({ declaration: RATING, store, slots: [0], load: new ManualLoad(), slotGroupMember: true });
  const l = new CockroachOwnerRuntime({ declaration: ATTR, store, slots: [0], load: new ManualLoad(), slotGroup: { members: [m] } });
  await assert.rejects(l.start(hooks('attr_b', { events: [] })), groupCode('GROUP_START_ORDER'));
  assert.equal(store.slotRow('attr_b', 0)?.sessionId, null);
});

test('should keep both members of every slot under one session at every observation when two group processes contend across seeded pauses', T, async () => {
  for (const seedValue of [20261013, 7, 4242]) {
    const rnd = rng(seedValue);
    const store = seed();
    const clock = clockOf(store);
    let observations = 0;
    const observe = (when: string): boolean => {
      const broken = groupWhole(store);
      assert.equal(broken, undefined, `seed ${seedValue} ${when}: ${broken}`);
      observations += 1;
      return true;
    };
    const a = await group(store, [0, 1, 2, 3]);
    const b = await group(store, [0, 1, 2, 3]);
    observe('start');
    const rounds = 3 + Math.floor(rnd() * 3);
    let holder = a;
    let other = b;
    for (let r = 0; r < rounds; r++) {
      // Seeded noise: event-loop turns and a clock step below session_ttl (no session expires).
      await yieldTurns(Math.floor(rnd() * 5));
      clock.step(Math.floor(rnd() * (FAST.sessionTtlMs - 1)));
      observe(`round ${r} before the pause`);
      // The holder pauses past session_ttl: the other group takes every slot of both members by expiry.
      holder.leader.pauseRenewalsForTest();
      await yieldTurns(Math.floor(rnd() * 5));
      clock.step(FAST.sessionTtlMs + 1);
      const h = holder;
      const o = other;
      await until(() => observe(`round ${r} takeover`) && o.leader.heldSlots().length === 4 && o.member.heldSlots().length === 4, 5_000, `seed ${seedValue} round ${r}: takeover`);
      // The paused holder wakes: its session was revoked; its re-home finds the slots taken and releases them.
      h.leader.resumeRenewalsForTest();
      await until(() => observe(`round ${r} wake`) && h.leader.heldSlots().length === 0 && h.member.heldSlots().length === 0, 5_000, `seed ${seedValue} round ${r}: deposed`);
      holder = o;
      other = h;
    }
    assert.ok(observations >= 2 + 3 * rounds, `seed ${seedValue}`);
    for (const s of [0, 1, 2, 3]) {
      assert.equal(store.slotRow('attr_b', s)?.epoch, BigInt(1 + rounds), `seed ${seedValue}: one acquisition and one takeover per round`);
      assert.equal(store.slotRow('attr_b', s)?.sessionId, holder.leader.sessionId(), `seed ${seedValue}`);
    }
    await a.stop(); await b.stop();
    assert.equal(groupWhole(store), undefined);
  }
});
