/** Placement's account slot map service (C01 §2.7, §3.8, §3.10, §5, CP-10; RFC-006 §7.1; S-PLAT-I3 work items 6, 7, 8). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HlcTs, MapVersion, SlotMapVersion, SlotNo } from '../src/api.ts';
import { hex, utf8 } from '../src/bytes.ts';
import { hlc } from '../src/hlc.ts';
import { home } from '../src/home.ts';
import { slotOfInMap } from '../src/placement/slot-map.ts';
import { DevSummarySigner, probeSetDigest, verifyProbeSetSummary, type ProbeMember } from '../src/placement/probe-set.ts';
import {
  MemorySlotMapStore, SlotMapError, SlotMapService, accountTopicPartitions, type HolderPartitionLister, type SlotMapStore,
} from '../src/placement/slot-map-service.ts';

const T = { timeout: 10_000 };
const SEED = new Uint8Array(32).fill(7);

/** The first account named `${prefix}-<i>` whose home mod n is `slot`. */
function homeAccount(prefix: string, slot: SlotNo, n: number): Uint8Array {
  for (let i = 0; ; i++) {
    const a = utf8(`${prefix}-${i}`);
    if (home(a) % n === slot) return a;
  }
}
const probeOf = (slot: SlotNo, n: number): Uint8Array => homeAccount(`probe-${slot}`, slot, n);
const ordinary = (count: number): Uint8Array[] => Array.from({ length: count }, (_, i) => utf8(`acct-${i}`));
const isProbeErr = (code: string) => (e: unknown): boolean => e instanceof SlotMapError && e.code === code;

interface Harness {
  svc: SlotMapService; store: SlotMapStore; log: string[]; published: SlotMapVersion[]; signer: DevSummarySigner;
  f9: (a: Uint8Array, v: MapVersion) => boolean;
  limit: (a: Uint8Array) => boolean;
  holders: HolderPartitionLister['listPartitions'];
  moved: string[];
}

async function harness(o: { n?: number; store?: SlotMapStore; parallelism?: number; groups?: Array<Array<{ kind: string; slot: SlotNo }>> } = {}): Promise<Harness> {
  const n = o.n ?? 4;
  let tick = 1_000;
  const h = {
    log: [] as string[], published: [] as SlotMapVersion[], moved: [] as string[], signer: new DevSummarySigner({ seed: SEED, keyId: 'k1' }),
    f9: () => true, limit: () => true,
    holders: async () => { throw new Error('holders.listPartitions is not set up'); },
  } as Omit<Harness, 'svc' | 'store'>;
  const store = o.store ?? new MemorySlotMapStore();
  const svc = await SlotMapService.open({
    store,
    publish: async (v) => { h.published.push(v); h.log.push(`publish v${v.version} n=${v.slotCount}`); },
    leaseNewSlots: async (kind, slots) => { h.log.push(`lease ${kind} ${slots.join(',')}`); },
    identity: { provisionProbeAccount: async (slot) => { h.log.push(`provision ${slot}`); return utf8(`probe-new-${slot}`); } },
    accountOwner: { f9Applied: async (a, v) => { h.log.push(`f9 ${Buffer.from(a).toString()} v${v}`); return h.f9(a, v); } },
    finance: {
      applySetScopedLimit: async (v, set) => {
        h.log.push(`limit v${v} size=${set.length}`);
        return set.map((m) => ({ account: m.account, applied: h.limit(m.account) }));
      },
    },
    moves: {
      move: async (r) => {
        h.log.push(`move ${Buffer.from(r.partition).toString()} ${r.from}->${r.to}`);
        h.moved.push(hex(r.partition));
        return { generation: 2 };
      },
    },
    holders: { listPartitions: (r) => h.holders(r) },
    growTopics: async (c) => { h.log.push(`grow ${c}`); },
    signer: h.signer,
    clock: (): HlcTs => hlc(BigInt(tick++)),
    ...(o.groups ? { slotGroups: o.groups } : {}),
    ...(o.parallelism ? { splitParallelism: o.parallelism } : {}),
  });
  if (!o.store) await svc.bootstrap({ slotCount: n, probeAccounts: Array.from({ length: n }, (_, s) => ({ slot: s, account: probeOf(s, n) })) });
  return Object.assign(h, { svc, store });
}

/** Runs the doubling to the 2n version and the first splitting version. */
async function toSplitting(h: Harness): Promise<SlotMapVersion> {
  assert.deepEqual(await h.svc.runDoubling(), ['leased', 'override-published', 'f9-applied', 'limit-applied', 'count-published', 'splitting-published', 'waiting']);
  return h.svc.latest();
}

/** The upper-half accounts of old slot s among `accounts`, as a holder lists them (n old slots). */
const upperHalf = (accounts: Uint8Array[], s: SlotNo, n: number): Uint8Array[] => accounts.filter((a) => home(a) % (2 * n) === s + n);

test('should answer slotOf from the latest published version when the map is bootstrapped', T, async () => {
  const h = await harness();
  for (const a of ordinary(50)) assert.deepEqual(h.svc.slotOf(a), { slot: home(a) % 4, mapVersion: 1n, headDecides: false });
  assert.deepEqual(h.log, ['publish v1 n=4']);
  assert.deepEqual((await h.svc.probeAccountSet(1n)).map((m) => m.slot), [0, 1, 2, 3]);
});

test('should refuse slotOf before a bootstrap and a bootstrap without one home-placed probe account per slot', T, async () => {
  const store = new MemorySlotMapStore();
  const h = await harness({ store });
  assert.throws(() => h.svc.slotOf(utf8('a')), isProbeErr('NOT_BOOTSTRAPPED'));
  const good = Array.from({ length: 4 }, (_, s) => ({ slot: s, account: probeOf(s, 4) }));
  await assert.rejects(h.svc.bootstrap({ slotCount: 3, probeAccounts: good.slice(0, 3) }), isProbeErr('BAD_BOOTSTRAP'));
  await assert.rejects(h.svc.bootstrap({ slotCount: 4, probeAccounts: good.slice(0, 3) }), isProbeErr('BAD_BOOTSTRAP'));
  await assert.rejects(h.svc.bootstrap({ slotCount: 4, probeAccounts: [...good.slice(0, 3), { slot: 3, account: probeOf(2, 4) }] }), isProbeErr('BAD_BOOTSTRAP'));
  await assert.rejects(h.svc.bootstrap({ slotCount: 4, probeAccounts: [...good, { slot: 3, account: probeOf(3, 4) }] }), isProbeErr('BAD_BOOTSTRAP'));
  assert.deepEqual(h.published, []);
  await h.svc.bootstrap({ slotCount: 4, probeAccounts: good });
  await assert.rejects(h.svc.bootstrap({ slotCount: 4, probeAccounts: good }), isProbeErr('ALREADY_BOOTSTRAPPED'));
  assert.equal(h.published.length, 1);
});

test('C01 CP-10 the doubling runs in the §3.8 order 1 to 7', T, async () => {
  const h = await harness();
  assert.deepEqual(await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} }), { targetCount: 8 });
  assert.deepEqual(h.log, ['publish v1 n=4'], 'the request only records the doubling');
  await toSplitting(h);
  assert.deepEqual(h.log, [
    'publish v1 n=4',
    'lease account 4,5,6,7',
    'provision 4', 'provision 5', 'provision 6', 'provision 7',
    'publish v2 n=4',
    'f9 probe-new-4 v2', 'f9 probe-new-5 v2', 'f9 probe-new-6 v2', 'f9 probe-new-7 v2',
    'limit v3 size=8',
    'publish v3 n=8',
    'grow 2',
    'publish v4 n=8',
  ]);
  const [v3, v4] = [h.published[2], h.published[3]];
  assert.deepEqual(v3 && { prev: v3.previousCount, split: v3.splitState }, { prev: 4, split: { 0: 'unsplit', 1: 'unsplit', 2: 'unsplit', 3: 'unsplit' } });
  assert.deepEqual(v4?.splitState, { 0: 'splitting', 1: 'splitting', 2: 'splitting', 3: 'splitting' });
  const accounts = ordinary(120);
  for (let s = 0; s < 4; s++) {
    await h.svc.ackSplitting({ kind: 'account', slot: s, mapVersion: 4n, epoch: 1n, upperHalf: upperHalf(accounts, s, 4), asOf: hlc(5n) });
  }
  const rest = await h.svc.runDoubling();
  assert.equal(rest.at(-1), 'done');
  assert.equal(rest.filter((x) => x === 'split-published').length, 4);
  assert.deepEqual(h.svc.latest().splitState, { 0: 'split', 1: 'split', 2: 'split', 3: 'split' });
  for (const a of accounts) assert.equal(h.svc.slotOf(a).slot, home(a) % 8);
  assert.equal(await h.svc.advanceDoubling(), 'idle');
});

test('C01 CP-10 the override version pins every existing probe account and routes each new one to s + n with the count still n', T, async () => {
  const h = await harness();
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  assert.equal(await h.svc.advanceDoubling(), 'leased');
  assert.equal(await h.svc.advanceDoubling(), 'override-published');
  const v2 = h.svc.latest();
  assert.equal(v2.slotCount, 4);
  assert.equal(v2.previousCount, undefined);
  const want = [
    ...Array.from({ length: 4 }, (_, s) => ({ account: hex(probeOf(s, 4)), slot: s, reason: 'probe_pin' })),
    ...[4, 5, 6, 7].map((s) => ({ account: hex(utf8(`probe-new-${s}`)), slot: s, reason: 'probe_new' })),
  ].sort((a, b) => (a.account < b.account ? -1 : 1));
  assert.deepEqual(v2.overrides.map((o) => ({ account: hex(o.account), slot: o.slot, reason: o.reason })), want);
  assert.deepEqual(v2.probeAccounts.map((p) => [p.slot, Buffer.from(p.account).toString()]),
    [[4, 'probe-new-4'], [5, 'probe-new-5'], [6, 'probe-new-6'], [7, 'probe-new-7']]);
  for (let s = 4; s < 8; s++) assert.deepEqual(slotOfInMap(v2, utf8(`probe-new-${s}`)), { slot: s, mapVersion: 2n, headDecides: false });
});

test('C01 CP-10 F9 is applied for every new probe account before the set-scoped limit call', T, async () => {
  const h = await harness();
  let refusals = 2;
  h.f9 = (a) => !(Buffer.from(a).toString() === 'probe-new-6' && refusals-- > 0);
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  assert.deepEqual(await h.svc.runDoubling(), ['leased', 'override-published', 'f9-waiting']);
  assert.equal(await h.svc.advanceDoubling(), 'f9-waiting');
  assert.ok(!h.log.some((l) => l.startsWith('limit')), 'no limit call before F9 of every new probe account');
  assert.equal(await h.svc.advanceDoubling(), 'f9-applied');
  assert.deepEqual(h.log.filter((l) => l.startsWith('f9')), [
    'f9 probe-new-4 v2', 'f9 probe-new-5 v2', 'f9 probe-new-6 v2', 'f9 probe-new-7 v2', 'f9 probe-new-6 v2', 'f9 probe-new-6 v2',
  ], 'an account with F9 applied is not asked again');
  assert.equal(await h.svc.advanceDoubling(), 'limit-applied');
});

test('C01 CP-10 a not-applied limit answer blocks the 2n publication until applied', T, async () => {
  const h = await harness();
  let blocked = true;
  h.limit = (a) => !(blocked && Buffer.from(a).toString() === 'probe-new-5');
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  assert.deepEqual(await h.svc.runDoubling(), ['leased', 'override-published', 'f9-applied', 'limit-waiting']);
  assert.equal(await h.svc.advanceDoubling(), 'limit-waiting');
  assert.equal(h.svc.latest().slotCount, 4, 'no 2n version');
  assert.ok(!h.published.some((v) => v.slotCount === 8));
  blocked = false;
  assert.equal(await h.svc.advanceDoubling(), 'limit-applied');
  assert.equal(await h.svc.advanceDoubling(), 'count-published');
  assert.equal(h.svc.latest().slotCount, 8);
  assert.deepEqual((await h.store.probeAccounts()).map((p) => p.limitState), Array(8).fill('applied'));
});

test('C01 CP-10 a version published after the limit makes the limit run again for the version that is published', T, async () => {
  const h = await harness();
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  await h.svc.advanceDoubling(); await h.svc.advanceDoubling(); await h.svc.advanceDoubling();
  assert.equal(await h.svc.advanceDoubling(), 'limit-applied');
  const a = ordinary(10).find((x) => home(x) % 4 === 0) ?? assert.fail('no account');
  assert.deepEqual(await h.svc.reslot({ accounts: [a], toSlot: 1, reason: 'r', requestId: utf8('r1'), envelope: {} }), { accepted: true, versionWhenDone: 3n });
  assert.equal(await h.svc.advanceDoubling(), 'limit-stale');
  assert.equal(await h.svc.advanceDoubling(), 'limit-applied');
  assert.equal(await h.svc.advanceDoubling(), 'count-published');
  assert.deepEqual(h.log.filter((l) => l.startsWith('limit') || l.startsWith('publish v4')), ['limit v3 size=8', 'limit v4 size=8', 'publish v4 n=8']);
});

test('C01 CP-10 no ordinary account routes to s + n before the 2n version is published', T, async () => {
  const h = await harness();
  const accounts = ordinary(300);
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  await toSplitting(h);
  const before = h.published.filter((v) => v.slotCount === 4);
  assert.equal(before.length, 2);
  for (const v of before) for (const a of accounts) assert.equal(slotOfInMap(v, a).slot, home(a) % 4, `${hex(a)} in v${v.version}`);
  const v3 = h.published.find((v) => v.slotCount === 8) ?? assert.fail('no 2n version');
  for (const a of accounts) assert.deepEqual(slotOfInMap(v3, a), { slot: home(a) % 4, mapVersion: 3n, headDecides: false });
});

test('C01 CP-10 a splitting slot answers slot s with headDecides for its upper half and without for its lower half', T, async () => {
  const h = await harness();
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  const v4 = await toSplitting(h);
  let upper = 0;
  for (const a of ordinary(200)) {
    const s = home(a) % 4;
    const up = home(a) % 8 === s + 4;
    if (up) upper++;
    assert.deepEqual(h.svc.slotOf(a), { slot: s, mapVersion: v4.version, headDecides: up });
  }
  assert.ok(upper > 50 && upper < 150, `upper half ${upper}`);
});

test('C01 CP-10 every old and new slot has exactly one probe account in every published version of a doubling', T, async () => {
  const h = await harness();
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  await toSplitting(h);
  const accounts = ordinary(100);
  for (let s = 0; s < 4; s++) {
    // The holder lists every upper-half account it holds, the pinned probe account too when its home is upper half.
    await h.svc.ackSplitting({ kind: 'account', slot: s, mapVersion: 4n, epoch: 1n, upperHalf: upperHalf([...accounts, probeOf(s, 4)], s, 4), asOf: hlc(5n) });
  }
  assert.equal((await h.svc.runDoubling()).at(-1), 'done');
  for (const v of h.published.slice(1)) {
    const set = await h.svc.probeAccountSet(v.version);
    const bySlot = set.map((m) => slotOfInMap(v, m.account).slot).sort((a, b) => a - b);
    assert.deepEqual(bySlot, [0, 1, 2, 3, 4, 5, 6, 7], `v${v.version}`);
    assert.deepEqual(set.map((m) => m.slot), [0, 1, 2, 3, 4, 5, 6, 7], `v${v.version}`);
  }
  assert.ok([0, 1, 2, 3].some((s) => home(probeOf(s, 4)) % 8 === s + 4), 'at least one probe account is in an upper half');
  assert.ok(!h.log.some((l) => l.startsWith('move probe-')), 'no probe account moves');
});

test('should move exactly the listed upper-half accounts after ackSplitting and publish the slot split after the last move returns', T, async () => {
  const h = await harness();
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  await toSplitting(h);
  const listed = upperHalf(ordinary(60), 2, 4).slice(0, 3);
  assert.equal(listed.length, 3);
  const r = await h.svc.ackSplitting({ kind: 'account', slot: 2, mapVersion: 4n, epoch: 1n, upperHalf: listed, asOf: hlc(9n) });
  assert.deepEqual(r, { recorded: true });
  const ack = await h.store.splitAck(2, 4n);
  assert.deepEqual(ack && { epoch: ack.epoch, ackedAt: ack.ackedAt, upper: ack.upperHalf.map(hex) }, { epoch: 1n, ackedAt: hlc(9n), upper: listed.map(hex) });
  const mark = h.log.length;
  assert.deepEqual(await h.svc.runDoubling(), ['moved', 'moved', 'moved', 'split-published', 'waiting']);
  assert.deepEqual(h.log.slice(mark), [
    ...listed.map((a) => `move ${Buffer.from(a).toString()} 2->6`),
    'publish v5 n=8',
  ]);
  assert.deepEqual(h.svc.latest().splitState, { 0: 'splitting', 1: 'splitting', 2: 'split', 3: 'splitting' });
  for (const a of listed) assert.deepEqual(h.svc.slotOf(a), { slot: 6, mapVersion: 5n, headDecides: false });
});

test('should not move a listed account that has an override row or is not in the upper half', T, async () => {
  const h = await harness();
  const lower = ordinary(40).find((a) => home(a) % 8 === 0) ?? assert.fail('no lower-half account');
  const [up, pinned] = ordinary(40).filter((a) => home(a) % 8 === 4);
  assert.ok(up && pinned);
  assert.deepEqual(await h.svc.reslot({ accounts: [pinned], toSlot: 0, reason: 'keep', requestId: utf8('r1'), envelope: {} }), { accepted: true, versionWhenDone: 2n });
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  await toSplitting(h);
  const v = h.svc.latest().version;
  await h.svc.ackSplitting({ kind: 'account', slot: 0, mapVersion: v, epoch: 1n, upperHalf: [pinned, lower, up, up], asOf: hlc(9n) });
  assert.deepEqual(await h.svc.runDoubling(), ['moved', 'split-published', 'waiting']);
  assert.deepEqual(h.moved, [hex(up)]);
  assert.equal(h.svc.slotOf(pinned).slot, 0);
  assert.equal(h.svc.slotOf(lower).slot, 0);
  assert.equal(h.svc.slotOf(up).slot, 4);
});

test('should record ackSplitting once per (slot, mapVersion, epoch) and let a later epoch replace the list', T, async () => {
  const h = await harness();
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  await toSplitting(h);
  const [a, b, c] = upperHalf(ordinary(80), 1, 4);
  assert.ok(a && b && c);
  await h.svc.ackSplitting({ kind: 'account', slot: 1, mapVersion: 4n, epoch: 3n, upperHalf: [a, b], asOf: hlc(10n) });
  await h.svc.ackSplitting({ kind: 'account', slot: 1, mapVersion: 4n, epoch: 3n, upperHalf: [c], asOf: hlc(11n) });
  await h.svc.ackSplitting({ kind: 'account', slot: 1, mapVersion: 4n, epoch: 2n, upperHalf: [c], asOf: hlc(12n) });
  const kept = await h.store.splitAck(1, 4n);
  assert.deepEqual(kept && { epoch: kept.epoch, ackedAt: kept.ackedAt, upper: kept.upperHalf.map(hex) }, { epoch: 3n, ackedAt: hlc(10n), upper: [hex(a), hex(b)] });
  assert.equal(await h.svc.advanceDoubling(), 'moved');
  await h.svc.ackSplitting({ kind: 'account', slot: 1, mapVersion: 4n, epoch: 4n, upperHalf: [a, c], asOf: hlc(13n) });
  assert.deepEqual(await h.svc.runDoubling(), ['moved', 'split-published', 'waiting']);
  assert.deepEqual(h.moved, [hex(a), hex(c)]);
  assert.deepEqual(await h.svc.ackSplitting({ kind: 'account', slot: 1, mapVersion: 4n, epoch: 5n, upperHalf: [b], asOf: hlc(14n) }), { recorded: true });
  assert.equal((await h.store.splitAck(1, 4n))?.epoch, 4n, 'an ack after the split changes nothing');
});

test('should refuse ackSplitting for a slot that is not splitting at that version or for another kind', T, async () => {
  const h = await harness();
  await assert.rejects(h.svc.ackSplitting({ kind: 'account', slot: 0, mapVersion: 1n, epoch: 1n, upperHalf: [], asOf: hlc(1n) }), isProbeErr('NOT_SPLITTING'));
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  await toSplitting(h);
  await assert.rejects(h.svc.ackSplitting({ kind: 'account', slot: 0, mapVersion: 3n, epoch: 1n, upperHalf: [], asOf: hlc(1n) }), isProbeErr('NOT_SPLITTING'));
  await assert.rejects(h.svc.ackSplitting({ kind: 'account', slot: 4, mapVersion: 4n, epoch: 1n, upperHalf: [], asOf: hlc(1n) }), isProbeErr('NOT_SPLITTING'));
  const other = { kind: 'link', slot: 0, mapVersion: 4n, epoch: 1n, upperHalf: [], asOf: hlc(1n) } as unknown as Parameters<SlotMapService['ackSplitting']>[0];
  await assert.rejects(h.svc.ackSplitting(other), isProbeErr('NOT_ACCOUNT_KIND'));
  assert.equal(await h.store.splitAck(0, 4n), undefined);
});

test('should ask the new holder with listPartitions after a takeover until it answers, then move its list', T, async () => {
  const h = await harness();
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  await toSplitting(h);
  const [a, b] = upperHalf(ordinary(80), 3, 4);
  assert.ok(a && b);
  await h.svc.ackSplitting({ kind: 'account', slot: 3, mapVersion: 4n, epoch: 1n, upperHalf: [a], asOf: hlc(10n) });
  await h.svc.holderChanged(3);
  await h.svc.holderChanged(9);
  const answers = [{ refused: 'NOT_ACKED' as const }, { refused: 'NOT_OWNER' as const }, { partitions: [a, b], asOf: hlc(20n), epoch: 2n }];
  const asked: unknown[] = [];
  h.holders = async (r) => { asked.push(r); return answers.shift() ?? assert.fail('asked too often'); };
  assert.equal(await h.svc.advanceDoubling(), 'listing-refused');
  assert.equal(await h.svc.advanceDoubling(), 'listing-refused');
  assert.deepEqual(h.moved, [], 'no move while the new holder has not answered');
  assert.equal(await h.svc.advanceDoubling(), 'listed');
  assert.deepEqual(asked, Array(3).fill({ kind: 'account', slot: 3, mapVersion: 4n, home: { mod: 8, eq: 7 } }));
  const ack = await h.store.splitAck(3, 4n);
  assert.deepEqual(ack && { epoch: ack.epoch, ackedAt: ack.ackedAt, upper: ack.upperHalf.map(hex) }, { epoch: 2n, ackedAt: hlc(20n), upper: [hex(a), hex(b)] });
  assert.deepEqual(await h.svc.runDoubling(), ['moved', 'moved', 'split-published', 'waiting']);
  assert.deepEqual(h.moved, [hex(a), hex(b)]);
});

test('should split at most split_parallelism (16) old slots at a time', T, async () => {
  const h = await harness({ n: 32 });
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  await toSplitting(h);
  const v = h.svc.latest();
  const splitting = Object.entries(v.splitState).filter(([, s]) => s === 'splitting').map(([k]) => Number(k));
  assert.deepEqual(splitting, Array.from({ length: 16 }, (_, i) => i));
  assert.equal(await h.svc.advanceDoubling(), 'waiting');
  await h.svc.ackSplitting({ kind: 'account', slot: 5, mapVersion: v.version, epoch: 1n, upperHalf: [], asOf: hlc(30n) });
  assert.equal(await h.svc.advanceDoubling(), 'split-published');
  assert.equal(await h.svc.advanceDoubling(), 'splitting-published');
  const w = h.svc.latest();
  assert.equal(w.splitState[5], 'split');
  assert.equal(w.splitState[16], 'splitting');
  assert.equal(w.splitState[17], 'unsplit');
  assert.equal(Object.values(w.splitState).filter((s) => s === 'splitting').length, 16);
});

test('should reslot by moving one account at a time and then publish a version with the reslot override rows', T, async () => {
  const h = await harness();
  const [a, b] = ordinary(40).filter((x) => home(x) % 4 !== 2);
  assert.ok(a && b);
  const c = ordinary(40).find((x) => home(x) % 4 === 2) ?? assert.fail('no account in slot 2');
  const ans = await h.svc.reslot({ accounts: [a, b, c], toSlot: 2, reason: 'hot', requestId: utf8('r1'), envelope: { op: 'x' } });
  assert.deepEqual(ans, { accepted: true, versionWhenDone: 2n });
  assert.deepEqual(h.log.slice(1), [
    `move ${Buffer.from(a).toString()} ${home(a) % 4}->2`, `move ${Buffer.from(b).toString()} ${home(b) % 4}->2`, 'publish v2 n=4',
  ]);
  const v2 = h.svc.latest();
  assert.deepEqual(v2.overrides.map((o) => [hex(o.account), o.slot, o.reason]),
    [a, b, c].map((x) => [hex(x), 2, 'reslot']).sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1)));
  for (const x of [a, b, c]) assert.deepEqual(h.svc.slotOf(x), { slot: 2, mapVersion: 2n, headDecides: false });
});

test('should answer a repeated reslot with the same answer and the same id with other content with CONFLICT', T, async () => {
  const h = await harness();
  const a = ordinary(10).find((x) => home(x) % 4 !== 1) ?? assert.fail('no account');
  const req = { accounts: [a], toSlot: 1, reason: 'hot', requestId: utf8('r1'), envelope: {} };
  const first = await h.svc.reslot(req);
  const log = [...h.log];
  assert.deepEqual(await h.svc.reslot(req), first);
  assert.deepEqual(await h.svc.reslot({ ...req, toSlot: 3 }), { accepted: false, refusal: 'CONFLICT' });
  assert.deepEqual(await h.svc.reslot({ ...req, reason: 'other' }), { accepted: false, refusal: 'CONFLICT' });
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  assert.deepEqual(await h.svc.reslot({ ...req, requestId: utf8('d1') }), { accepted: false, refusal: 'CONFLICT' });
  assert.deepEqual(h.log, log, 'no second move and no second version');
});

test('C01 CP-10 reslot refuses with the §3.8 reason and moves nothing', T, async () => {
  const h = await harness();
  const a = ordinary(10).find((x) => home(x) % 4 === 0) ?? assert.fail('no account');
  let id = 0;
  const reslot = (accounts: Uint8Array[], toSlot: SlotNo) => h.svc.reslot({ accounts, toSlot, reason: 'r', requestId: utf8(`r${id++}`), envelope: {} });
  assert.deepEqual(await reslot([a], 4), { accepted: false, refusal: 'NOT_DOUBLING' });
  assert.deepEqual(await reslot([a], -1), { accepted: false, refusal: 'NOT_DOUBLING' });
  assert.deepEqual(await reslot([a], 1.5), { accepted: false, refusal: 'NOT_DOUBLING' });
  assert.deepEqual(await reslot([a, probeOf(0, 4)], 1), { accepted: false, refusal: 'SECOND_PROBE' });
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  assert.equal(await h.svc.advanceDoubling(), 'leased');
  assert.deepEqual(await reslot([probeOf(1, 4)], 5), { accepted: false, refusal: 'PROBE_LEFT_WITHOUT' });
  assert.deepEqual(await reslot([a], 5), { accepted: false, refusal: 'TARGET_WITHOUT_PROBE' });
  assert.deepEqual(await reslot([a], 8), { accepted: false, refusal: 'NOT_DOUBLING' });
  assert.equal(await h.svc.advanceDoubling(), 'override-published');
  assert.deepEqual(await reslot([a], 5), { accepted: false, refusal: 'NOT_DOUBLING' }, 'a new slot is not in the count before step 6');
  assert.deepEqual(await reslot([probeOf(1, 4)], 5), { accepted: false, refusal: 'SECOND_PROBE' });
  assert.ok(!h.log.some((l) => l.startsWith('move')));
  assert.deepEqual(h.published.map((v) => v.version), [1n, 2n]);
  const again = await h.svc.reslot({ accounts: [a], toSlot: 4, reason: 'r', requestId: utf8('r0'), envelope: {} });
  assert.deepEqual(again, { accepted: false, refusal: 'NOT_DOUBLING' }, 'a refusal is recorded and answered again');
  assert.deepEqual(await reslot([probeOf(1, 4)], 1), { accepted: true, versionWhenDone: 3n }, 'a probe account kept in its slot is no move');
  assert.ok(!h.log.some((l) => l.startsWith('move')));
});

test('should record doubleSlotCount once by requestId and refuse a second doubling, a reused id and another kind', T, async () => {
  const h = await harness();
  const req = { kind: 'account' as const, requestId: utf8('d1'), envelope: {} };
  assert.deepEqual(await h.svc.doubleSlotCount(req), { targetCount: 8 });
  assert.deepEqual(await h.svc.doubleSlotCount(req), { targetCount: 8 });
  assert.equal(h.svc.doublingState()?.phase, 'lease');
  await assert.rejects(h.svc.doubleSlotCount({ ...req, requestId: utf8('d2') }), isProbeErr('DOUBLING_IN_PROGRESS'));
  await h.svc.reslot({ accounts: [], toSlot: 0, reason: 'r', requestId: utf8('r1'), envelope: {} });
  await assert.rejects(h.svc.doubleSlotCount({ ...req, requestId: utf8('r1') }), isProbeErr('CONFLICT'));
  const link = { ...req, kind: 'link' } as unknown as Parameters<SlotMapService['doubleSlotCount']>[0];
  await assert.rejects(h.svc.doubleSlotCount(link), isProbeErr('NOT_ACCOUNT_KIND'));
  assert.equal(h.svc.doublingState()?.requestId, hex(utf8('d1')));
});

test('should accept a second doubling after the first is done and double again from 2n', T, async () => {
  const h = await harness({ n: 2 });
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  await toSplitting(h);
  for (let s = 0; s < 2; s++) await h.svc.ackSplitting({ kind: 'account', slot: s, mapVersion: h.svc.latest().version, epoch: 1n, upperHalf: [], asOf: hlc(1n) });
  assert.equal((await h.svc.runDoubling()).at(-1), 'done');
  assert.deepEqual(await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d2'), envelope: {} }), { targetCount: 8 });
  await h.svc.advanceDoubling();
  assert.equal(await h.svc.advanceDoubling(), 'override-published');
  const v = h.svc.latest();
  assert.deepEqual({ n: v.slotCount, prev: v.previousCount, split: v.splitState }, { n: 4, prev: undefined, split: {} });
  assert.deepEqual(v.overrides.filter((o) => o.reason === 'probe_pin').map((o) => o.slot).sort((a, b) => a - b), [0, 1]);
  assert.deepEqual(v.overrides.map((o) => o.slot).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  for (const a of ordinary(100)) assert.equal(slotOfInMap(v, a).slot, home(a) % 4);
});

test('should give probeAccountSet the exact set of a version, also of the next unpublished version', T, async () => {
  const h = await harness();
  const four: ProbeMember[] = Array.from({ length: 4 }, (_, s) => ({ slot: s, account: probeOf(s, 4) }));
  const eight = [...four, ...[4, 5, 6, 7].map((s) => ({ slot: s, account: utf8(`probe-new-${s}`) }))];
  assert.deepEqual(await h.svc.probeAccountSet(1n), four);
  assert.deepEqual(await h.svc.probeAccountSet(2n), four, 'the next version without a doubling');
  await assert.rejects(h.svc.probeAccountSet(3n), isProbeErr('UNKNOWN_VERSION'));
  await assert.rejects(h.svc.probeAccountSet(0n), isProbeErr('UNKNOWN_VERSION'));
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  await h.svc.advanceDoubling(); await h.svc.advanceDoubling(); await h.svc.advanceDoubling();
  assert.deepEqual(await h.svc.probeAccountSet(1n), four);
  assert.deepEqual(await h.svc.probeAccountSet(2n), eight);
  assert.deepEqual(await h.svc.probeAccountSet(3n), eight, 'C07 S1: the pending 2n version');
  const pending = await h.svc.probeSetSummary(3n);
  assert.deepEqual({ v: pending.mapVersion, n: pending.slotCount, c: pending.probeAccountCount }, { v: 3n, n: 8, c: 8 });
  assert.deepEqual(pending.setDigest, probeSetDigest(eight));
  const v1 = await h.svc.probeSetSummary(1n);
  assert.deepEqual({ v: v1.mapVersion, n: v1.slotCount, c: v1.probeAccountCount }, { v: 1n, n: 4, c: 4 });
});

test('C01 CP-10 probeSetSummary verifies with the public key and fails after one changed byte', T, async () => {
  const h = await harness();
  const s = await h.svc.probeSetSummary(1n);
  const pub = h.signer.publicKey();
  assert.equal(s.keyId, 'k1');
  assert.equal(verifyProbeSetSummary(s, pub), true);
  const flip = (b: Uint8Array, i: number): Uint8Array => { const c = new Uint8Array(b); c[i] = (c[i] ?? 0) ^ 1; return c; };
  assert.equal(verifyProbeSetSummary({ ...s, setDigest: flip(s.setDigest, 31) }, pub), false);
  assert.equal(verifyProbeSetSummary({ ...s, signature: flip(s.signature, 0) }, pub), false);
  assert.equal(verifyProbeSetSummary({ ...s, mapVersion: 2n }, pub), false);
  assert.equal(verifyProbeSetSummary({ ...s, slotCount: 8 }, pub), false);
  assert.equal(verifyProbeSetSummary({ ...s, probeAccountCount: 5 }, pub), false);
  assert.equal(verifyProbeSetSummary(s, flip(pub, 3)), false);
});

test('should size account topics to the least power of two at least slotCount / 4 and grow them after the 2n version', T, async () => {
  assert.deepEqual([1, 2, 4, 5, 8, 9, 64, 128, 16_384, 32_768].map(accountTopicPartitions), [1, 1, 1, 2, 2, 4, 16, 32, 4_096, 8_192]);
  const h = await harness({ n: 16 });
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  await toSplitting(h);
  const i = h.log.indexOf('grow 8');
  assert.ok(i > 0 && h.log[i - 1] === 'publish v3 n=32', h.log.join('|'));
});

test('should answer slotGroup from the configured groups and the single member otherwise', T, async () => {
  const h = await harness({ groups: [[{ kind: 'attribution', slot: 3 }, { kind: 'rating', slot: 3 }]] });
  assert.deepEqual(h.svc.slotGroup('rating', 3), [{ kind: 'attribution', slot: 3 }, { kind: 'rating', slot: 3 }]);
  assert.deepEqual(h.svc.slotGroup('rating', 2), [{ kind: 'rating', slot: 2 }]);
  assert.deepEqual(h.svc.slotGroup('account', 3), [{ kind: 'account', slot: 3 }]);
});

test('should refuse a recorded version with other content and accept the same content again', T, async () => {
  const store = new MemorySlotMapStore();
  const v: SlotMapVersion = { version: 1n, slotCount: 4, splitState: {}, overrides: [], probeAccounts: [], publishedAt: hlc(1n) };
  await store.insertVersion(v);
  await store.insertVersion({ ...v });
  await assert.rejects(store.insertVersion({ ...v, slotCount: 8 }), isProbeErr('VERSION_CONFLICT'));
  assert.deepEqual(await store.versions(), [v]);
});

test('should continue a doubling after the service is opened again on the same store', T, async () => {
  const h = await harness();
  await h.svc.doubleSlotCount({ kind: 'account', requestId: utf8('d1'), envelope: {} });
  await h.svc.advanceDoubling(); await h.svc.advanceDoubling();
  const h2 = await harness({ store: h.store });
  assert.equal(h2.svc.latest().version, 2n);
  assert.deepEqual(await h2.svc.runDoubling(), ['f9-applied', 'limit-applied', 'count-published', 'splitting-published', 'waiting']);
  assert.deepEqual(h2.log, [
    'f9 probe-new-4 v2', 'f9 probe-new-5 v2', 'f9 probe-new-6 v2', 'f9 probe-new-7 v2', 'limit v3 size=8', 'publish v3 n=8', 'grow 2', 'publish v4 n=8',
  ]);
  assert.ok(!h2.log.some((l) => l.startsWith('provision')), 'no second probe account');
});
