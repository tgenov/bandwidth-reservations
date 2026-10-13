/**
 * S-PLAT-I2 work item 4: slot groups (RFC-006 §4.2, §7.1; C01 §2.2 `slotGroupWith`, §3.1). Slot i of
 * attr_b and slot i of rating are taken, taken over and re-homed in one transaction, or not at all.
 * Exit criterion (3) at the unit level, with fault injection on the in-memory store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Epoch, OwnerDeclaration, OwnerHooks, SlotNo } from '../src/index.ts';
import { CockroachOwnerRuntime, ManualLoad, slotOfPartition, utf8 } from '../src/index.ts';
import { MemoryStore } from '../testing/index.ts';

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 3_000, what = f.toString()): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(5); }
}

interface Calls { events: string[] }
function hooks(kind: string, calls: Calls): OwnerHooks {
  return {
    async onAcquire(slot: SlotNo, epoch: Epoch, how) { calls.events.push(`acquire ${kind} ${slot} ${epoch} ${how}`); },
    onRelease(slot, reason) { calls.events.push(`release ${kind} ${slot} ${reason}`); },
    onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {},
  };
}

function seed(): MemoryStore {
  const store = new MemoryStore();
  store.seedSlots('attr_b', 4);
  store.seedSlots('rating', 4);
  return store;
}

async function group(store: MemoryStore, slots: SlotNo[], calls: Calls = { events: [] }) {
  const member = new CockroachOwnerRuntime({ declaration: RATING, store, slots, load: new ManualLoad(), slotGroupMember: true, testing: { sessionTimings: FAST } });
  const leader = new CockroachOwnerRuntime({ declaration: ATTR, store, slots, load: new ManualLoad(), slotGroup: { members: [member] }, testing: { sessionTimings: FAST } });
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

test('should take slot i of both kinds in one transaction and call onAcquire for every member before either serves when a slot group starts', async () => {
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

test('should take neither member of a slot when the other member\'s row is held by another live session', async () => {
  const store = seed();
  await store.insertSession({ shard: 0, sessionId: 'foreign', host: 'h', region: 'r1', facility: 'r1a', kind: 'rating', ttlMs: 60_000 });
  await store.acquireFree('rating', 1, 'foreign');
  const g = await group(store, [0, 1]);
  await sleep(150);
  assert.deepEqual(g.leader.heldSlots(), [0]);
  assert.deepEqual(g.member.heldSlots(), [0]);
  assert.equal(store.slotRow('attr_b', 1)?.sessionId, null, 'attr_b slot 1 stays free: no part of a group is taken');
  assert.equal(store.slotRow('attr_b', 1)?.epoch, 0n);
  await g.stop();
});

test('should change neither row when the group transaction fails after its first member update, and take both on the next tick', async () => {
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

test('should take over every slot of a paused group by expiry in one transaction; the old holder commits nothing in either kind', async () => {
  const store = seed();
  const a = await group(store, [0, 1, 2, 3]);
  const p = utf8('buyer-1');
  const slot = slotOfPartition(p, 4);
  assert.equal((await a.member.append({ partition: p, entries: [entry('a-r1')] })).r, 'Committed');
  a.leader.pauseRenewalsForTest();
  const bCalls: Calls = { events: [] };
  const b = await group(store, [0, 1, 2, 3], bCalls);
  await until(() => b.leader.heldSlots().length === 4 && b.member.heldSlots().length === 4);
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

test('should re-home both members of each slot in one transaction to a new session when the session is revoked', async () => {
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

test('should refuse a slot group whose declarations do not name each other, have different slot counts, or start the leader first', async () => {
  const store = seed();
  const other = new CockroachOwnerRuntime({ declaration: { ...RATING, kind: 'other', slotGroupWith: undefined }, store, slots: [0], load: new ManualLoad(), slotGroupMember: true });
  assert.throws(() => new CockroachOwnerRuntime({ declaration: { ...ATTR, slotGroupWith: undefined }, store, slots: [0], load: new ManualLoad(), slotGroup: { members: [other] } }),
    /neither declaration names the other/);
  const wide = new CockroachOwnerRuntime({ declaration: { ...RATING, slotCount: 8 }, store, slots: [0], load: new ManualLoad(), slotGroupMember: true });
  assert.throws(() => new CockroachOwnerRuntime({ declaration: ATTR, store, slots: [0], load: new ManualLoad(), slotGroup: { members: [wide] } }), /slot counts differ/);
  const plain = new CockroachOwnerRuntime({ declaration: RATING, store, slots: [0], load: new ManualLoad() });
  assert.throws(() => new CockroachOwnerRuntime({ declaration: ATTR, store, slots: [0], load: new ManualLoad(), slotGroup: { members: [plain] } }), /slotGroupMember: true/);
  const m = new CockroachOwnerRuntime({ declaration: RATING, store, slots: [0], load: new ManualLoad(), slotGroupMember: true });
  const l = new CockroachOwnerRuntime({ declaration: ATTR, store, slots: [0], load: new ManualLoad(), slotGroup: { members: [m] } });
  await assert.rejects(l.start(hooks('attr_b', { events: [] })), /start slot group member rating before its leader attr_b/);
  assert.equal(store.slotRow('attr_b', 0)?.sessionId, null);
});

test('should keep both members of every slot under one session at every observation when two group processes contend across seeded pauses', async () => {
  const seedValue = 20261013;
  let x = seedValue;
  const rnd = (): number => { x = (x * 1103515245 + 12345) % 2 ** 31; return x / 2 ** 31; };
  const store = seed();
  const a = await group(store, [0, 1, 2, 3]);
  const b = await group(store, [0, 1, 2, 3]);
  const procs = [a, b];
  const paused = [false, false];
  const end = Date.now() + 2_500;
  let observations = 0;
  while (Date.now() < end) {
    const i = rnd() < 0.5 ? 0 : 1;
    const p = procs[i];
    if (p && rnd() < 0.3) {
      if (paused[i]) p.leader.resumeRenewalsForTest(); else p.leader.pauseRenewalsForTest();
      paused[i] = !paused[i];
    }
    const broken = groupWhole(store);
    assert.equal(broken, undefined, `seed ${seedValue}: ${broken}`);
    observations += 1;
    await sleep(Math.floor(rnd() * 40));
  }
  for (const [i, p] of procs.entries()) if (paused[i]) p.leader.resumeRenewalsForTest();
  assert.ok(observations > 20);
  const takeovers = store.slotRow('attr_b', 0)?.epoch ?? 0n;
  assert.ok(takeovers >= 1n);
  await a.stop(); await b.stop();
  assert.equal(groupWhole(store), undefined);
});
