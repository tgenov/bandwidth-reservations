/**
 * S-PLAT-I3 work items 6 (holder side), 10: integrity stops in the runtime (C01 §3.2, CP-6, DT-45: `Stopped` from a
 * changed stops_version, after a takeover with placement down, across a move; the local hold and `integrity_report`
 * on a head-chain mismatch) and the holder side of splitting (C01 §3.8, CP-10: creation rules, ackSplitting,
 * listPartitions).
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppendResult, HlcTs, OwnerDeclaration, OwnerHooks, PartitionKey, SlotMapVersion, SlotNo } from '../src/index.ts';
import {
  CockroachOwnerRuntime, ManualLoad, SlotMapCache, compareHlc, hex, home, hlc, slotOfPartition, utf8, type AckSplittingRequest, type IntegrityReport,
} from '../src/index.ts';
import { MemoryStore } from '../testing/index.ts';
import { Closers, until } from './support.ts';

const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const entry = (id: string) => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id } });
const FAST = { sessionTtlMs: 300, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 280, maxLoopDelayMs: 20 };
const closers = new Closers();
const T = { timeout: 20_000 };
afterEach(() => closers.closeAll());

function hooks(): OwnerHooks {
  return { async onAcquire() {}, onRelease() {}, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {} };
}
function committed(r: AppendResult): Extract<AppendResult, { r: 'Committed' }> {
  assert.equal(r.r, 'Committed', `expected Committed, got ${JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`);
  return r as Extract<AppendResult, { r: 'Committed' }>;
}

// ---------------- integrity stops (C01 §3.2, CP-6) ----------------

const STOPK: OwnerDeclaration = { kind: 'skind', slotCount: 4, entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }], projections: [], streams: [] };
const X = utf8('stop-x');
const SX = slotOfPartition(X, 4);
const REF = utf8('det-1');

async function stopRuntime(store: MemoryStore, slots: SlotNo[], extra: Partial<ConstructorParameters<typeof CockroachOwnerRuntime>[0]> = {}): Promise<CockroachOwnerRuntime> {
  const rt = new CockroachOwnerRuntime({ declaration: STOPK, store, slots, load: new ManualLoad(),
    testing: { sessionTimings: FAST, commitBackstopMs: 1_000, postAcquisitionWaitMs: 10 }, ...extra });
  closers.add(() => rt.stop());
  await rt.start(hooks());
  await until(() => slots.every((s) => rt.heldSlots().includes(s)), 5_000, 'slots held');
  return rt;
}

test('C01 CP-6 a Stop that lands while a batch is in flight: the batch restarts, answers Stopped, and no entry commits with ts > enforced_at', T, async () => {
  const store = new MemoryStore();
  store.seedSlots(STOPK.kind, 4);
  const rt = await stopRuntime(store, [0, 1, 2, 3]);
  committed(await rt.append({ partition: X, entries: [entry('before')] }));
  let enforcedAt: HlcTs | undefined;
  store.faults.beforeCommit = () => {
    if (enforcedAt === undefined) enforcedAt = store.stopPartition(STOPK.kind, SX, X, REF);
  };
  const r = await rt.append({ partition: X, entries: [entry('racing')] });
  store.faults.beforeCommit = undefined;
  assert.deepEqual(r, { r: 'Stopped', detectionRef: REF });
  assert.ok(enforcedAt);
  const rows = store.log.filter((l) => hex(l.partition) === hex(X));
  assert.deepEqual(rows.map((l) => Buffer.from(l.identity).toString()), ['before']);
  for (const l of rows) assert.ok(compareHlc(l.ts, enforcedAt) < 0, `entry at ${l.ts} is below enforced_at ${enforcedAt}`);
  assert.deepEqual(await rt.append({ partition: X, entries: [entry('after')] }), { r: 'Stopped', detectionRef: REF });
});

test('C01 CP-6 Stopped after a takeover with placement down: the new holder reads the stops from the table on acquisition', T, async () => {
  const store = new MemoryStore();
  store.seedSlots(STOPK.kind, 4);
  const a = await stopRuntime(store, [SX]);
  committed(await a.append({ partition: X, entries: [entry('a1')] }));
  store.stopPartition(STOPK.kind, SX, X, REF);
  a.pauseRenewalsForTest();
  const b = await stopRuntime(store, [SX]);
  assert.deepEqual(await b.append({ partition: X, entries: [entry('b1')] }), { r: 'Stopped', detectionRef: REF });
  store.resumePartition(STOPK.kind, SX, X);
  committed(await b.append({ partition: X, entries: [entry('b2')] }));
});

test('C01 CP-6 across a move: a stop between moved and done fences both slots, so adopt answers Stopped and B commits nothing of X', T, async () => {
  const store = new MemoryStore();
  store.seedSlots(STOPK.kind, 5);
  const a = await stopRuntime(store, [0, 1, 2, 3]);
  const b = await stopRuntime(store, [4]);
  committed(await a.append({ partition: X, entries: [entry('a1')] }));
  await b.prepareAdopt({ partition: X, from: SX, to: 4, generation: 1 });
  committed(await a.moveOut(X, 4, 1));
  const before = [store.slotRow(STOPK.kind, SX)?.stopsVersion, store.slotRow(STOPK.kind, 4)?.stopsVersion];
  store.stopPartition(STOPK.kind, [SX, 4], X, REF);
  assert.deepEqual([store.slotRow(STOPK.kind, SX)?.stopsVersion, store.slotRow(STOPK.kind, 4)?.stopsVersion], before.map((v) => (v ?? 0n) + 1n));
  assert.deepEqual(await b.adopt(X), { r: 'Stopped', detectionRef: REF });
  assert.equal(store.heads.get(`${STOPK.kind}|${hex(X)}`)?.adopted, false);
  store.resumePartition(STOPK.kind, [SX, 4], X);
  committed(await b.adopt(X));
  committed(await b.append({ partition: X, entries: [entry('b1')] }));
});

test('C01 CP-6 adopt re-reads the stops of X: a stop seen only at A\'s slot after moved makes adopt answer Stopped', T, async () => {
  const store = new MemoryStore();
  store.seedSlots(STOPK.kind, 5);
  const a = await stopRuntime(store, [0, 1, 2, 3]);
  const b = await stopRuntime(store, [4]);
  committed(await a.append({ partition: X, entries: [entry('a1')] }));
  await b.prepareAdopt({ partition: X, from: SX, to: 4, generation: 1 });
  committed(await a.moveOut(X, 4, 1));
  assert.deepEqual(await b.append({ partition: X, entries: [entry('b0')] }), { r: 'Moving' }, 'B now knows X as not stopped at its stops_version');
  const bVersion = store.slotRow(STOPK.kind, 4)?.stopsVersion;
  store.stopPartition(STOPK.kind, SX, X, REF);
  assert.equal(store.slotRow(STOPK.kind, 4)?.stopsVersion, bVersion, 'B\'s stops_version does not change');
  assert.deepEqual(await b.adopt(X), { r: 'Stopped', detectionRef: REF });
  assert.equal(store.heads.get(`${STOPK.kind}|${hex(X)}`)?.adopted, false);
  assert.deepEqual(store.log.filter((l) => hex(l.partition) === hex(X)).map((l) => l.kind), [1, -1]);
});

test('C01 CP-6 a head-chain mismatch holds the partition locally, sends integrity_report once, and only audit\'s stop and resume lift the hold', T, async () => {
  const store = new MemoryStore();
  store.seedSlots(STOPK.kind, 4);
  const reports: IntegrityReport[] = [];
  const rt = await stopRuntime(store, [0, 1, 2, 3], { integrityReport: async (r) => { reports.push(r); return { detectionRef: REF }; } });
  committed(await rt.append({ partition: X, entries: [entry('a1')] }));
  const head = store.heads.get(`${STOPK.kind}|${hex(X)}`);
  assert.ok(head);
  const forged = new Uint8Array(32).fill(7);
  store.heads.set(`${STOPK.kind}|${hex(X)}`, { ...head, chain: forged });
  assert.deepEqual(await rt.append({ partition: X, entries: [entry('a2')] }), { r: 'Stopped', detectionRef: new Uint8Array() });
  await until(() => reports.length === 1, 5_000, 'integrity_report sent');
  assert.deepEqual(reports, [{ kind: STOPK.kind, partition: X, seq: 1n, observedChain: forged }]);
  assert.deepEqual(await rt.append({ partition: X, entries: [entry('a3')] }), { r: 'Stopped', detectionRef: REF });
  assert.equal(reports.length, 1, 'one report per hold');
  // audit's stop and the restore: the stop is seen open, then resumed.
  store.stopPartition(STOPK.kind, SX, X, REF);
  store.heads.set(`${STOPK.kind}|${hex(X)}`, head);
  assert.deepEqual(await rt.append({ partition: X, entries: [entry('a4')] }), { r: 'Stopped', detectionRef: REF });
  store.resumePartition(STOPK.kind, SX, X);
  committed(await rt.append({ partition: X, entries: [entry('a5')] }));
  assert.deepEqual(store.log.filter((l) => hex(l.partition) === hex(X)).map((l) => Buffer.from(l.identity).toString()), ['a1', 'a5']);
});

test('should keep the local hold when the stops change but audit has not stopped the partition (no stop of its own)', T, async () => {
  const store = new MemoryStore();
  store.seedSlots(STOPK.kind, 4);
  let accepted = 0;
  const rt = await stopRuntime(store, [0, 1, 2, 3], { integrityReport: async () => { accepted += 1; return { detectionRef: REF }; } });
  committed(await rt.append({ partition: X, entries: [entry('a1')] }));
  const head = store.heads.get(`${STOPK.kind}|${hex(X)}`);
  assert.ok(head);
  store.heads.set(`${STOPK.kind}|${hex(X)}`, { ...head, chain: new Uint8Array(32) });
  assert.deepEqual(await rt.append({ partition: X, entries: [entry('a2')] }), { r: 'Stopped', detectionRef: new Uint8Array() });
  await until(() => accepted === 1, 5_000, 'integrity_report accepted');
  store.stopPartition(STOPK.kind, SX, utf8('another'), utf8('det-2'));     // a stops_version change for another partition
  store.heads.set(`${STOPK.kind}|${hex(X)}`, head);
  assert.deepEqual(await rt.append({ partition: X, entries: [entry('a3')] }), { r: 'Stopped', detectionRef: REF });
});

test('should keep the local hold when another stop of the partition (another detection_ref) opens and resumes (C08 §J, R46-12)', T, async () => {
  const store = new MemoryStore();
  store.seedSlots(STOPK.kind, 4);
  let accepted = 0;
  const rt = await stopRuntime(store, [0, 1, 2, 3], { integrityReport: async () => { accepted += 1; return { detectionRef: REF }; } });
  committed(await rt.append({ partition: X, entries: [entry('a1')] }));
  const head = store.heads.get(`${STOPK.kind}|${hex(X)}`);
  assert.ok(head);
  store.heads.set(`${STOPK.kind}|${hex(X)}`, { ...head, chain: new Uint8Array(32) });
  assert.deepEqual(await rt.append({ partition: X, entries: [entry('a2')] }), { r: 'Stopped', detectionRef: new Uint8Array() });
  await until(() => accepted === 1, 5_000, 'integrity_report accepted');
  const OTHER = utf8('det-other');
  store.stopPartition(STOPK.kind, SX, X, OTHER);
  assert.deepEqual(await rt.append({ partition: X, entries: [entry('a3')] }), { r: 'Stopped', detectionRef: OTHER });
  store.resumePartition(STOPK.kind, SX, X);
  store.heads.set(`${STOPK.kind}|${hex(X)}`, head);
  assert.deepEqual(await rt.append({ partition: X, entries: [entry('a4')] }), { r: 'Stopped', detectionRef: REF });
  assert.deepEqual(store.log.filter((l) => hex(l.partition) === hex(X)).map((l) => Buffer.from(l.identity).toString()), ['a1']);
});

// ---------------- splitting, holder side (C01 §3.8, CP-10) ----------------

const ACCT: OwnerDeclaration = { kind: 'account', slotCount: 2, entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }], projections: [], streams: [] };
const TS0 = hlc('1.0000000000');
const V1: SlotMapVersion = { version: 1n, slotCount: 2, splitState: {}, overrides: [], probeAccounts: [], publishedAt: TS0 };
/** The 2n version, slot 0 splitting (slots 2, 3 exist and are held). */
const V3: SlotMapVersion = { version: 3n, slotCount: 4, previousCount: 2, splitState: { 0: 'splitting', 1: 'unsplit' }, overrides: [], probeAccounts: [], publishedAt: TS0 };

/** Accounts by home: lower half of slot 0 (h mod 4 = 0) and upper half (h mod 4 = 2). */
function accounts(): { lower: PartitionKey[]; upper: PartitionKey[] } {
  const lower: PartitionKey[] = []; const upper: PartitionKey[] = [];
  for (let i = 0; lower.length < 3 || upper.length < 3; i++) {
    const a = utf8(`acct-${i}`);
    const h = home(a) % 4;
    if (h === 0 && lower.length < 3) lower.push(a);
    if (h === 2 && upper.length < 3) upper.push(a);
  }
  return { lower, upper };
}

async function acctRuntime(store: MemoryStore, map: SlotMapCache, slots: SlotNo[], acks: AckSplittingRequest[]): Promise<CockroachOwnerRuntime> {
  const rt = new CockroachOwnerRuntime({ declaration: ACCT, store, slots, load: new ManualLoad(), slotMap: map,
    placement: { ackSplitting: async (req) => { acks.push(req); return { recorded: true }; } },
    testing: { sessionTimings: FAST, commitBackstopMs: 1_000, postAcquisitionWaitMs: 10 } });
  closers.add(() => rt.stop());
  await rt.start(hooks());
  await until(() => slots.every((s) => rt.heldSlots().includes(s)), 5_000, 'slots held');
  return rt;
}

test('C01 CP-10 during splitting, a new upper-half account is created in s + n and does not loop between the slots (V59-2)', T, async () => {
  const store = new MemoryStore();
  store.seedSlots(ACCT.kind, 4);
  const map = new SlotMapCache();
  map.apply(V1);
  const acks: AckSplittingRequest[] = [];
  const s = await acctRuntime(store, map, [0], acks);
  const n = await acctRuntime(store, map, [2], []);
  map.apply({ ...V1, version: 2n });
  map.apply(V3);
  const { lower, upper } = accounts();
  const u = upper[0] as PartitionKey;
  assert.deepEqual(await s.append({ partition: u, entries: [entry('u')] }, { slot: 0 }), { r: 'Moved', slot: 2, generation: 0 },
    'slot s creates no upper-half account once it applied the splitting version');
  committed(await n.append({ partition: u, entries: [entry('u')] }, { slot: 2 }));
  assert.deepEqual(await s.append({ partition: u, entries: [entry('u2')] }, { slot: 0 }), { r: 'Moved', slot: 2, generation: 0 },
    'the head names s + n, adopted: MOVED(s + n), never back');
  committed(await n.append({ partition: u, entries: [entry('u2')] }, { slot: 2 }));
  const l = lower[0] as PartitionKey;
  assert.deepEqual(await n.append({ partition: l, entries: [entry('l')] }, { slot: 2 }), { r: 'Moved', slot: 0, generation: 0 });
  committed(await s.append({ partition: l, entries: [entry('l')] }, { slot: 0 }));
  assert.deepEqual(n.slotOf(u), { slot: 0, mapVersion: 3n, headDecides: true });
});

test('C01 CP-10 ackSplitting: after the holder applies the splitting version and its batches in flight end, it lists exactly the upper-half accounts of s', T, async () => {
  const store = new MemoryStore();
  store.seedSlots(ACCT.kind, 4);
  const map = new SlotMapCache();
  map.apply(V1);
  const acks: AckSplittingRequest[] = [];
  const s = await acctRuntime(store, map, [0], acks);
  const { lower, upper } = accounts();
  committed(await s.append({ partition: upper[0] as PartitionKey, entries: [entry('u0')] }));
  committed(await s.append({ partition: lower[0] as PartitionKey, entries: [entry('l0')] }));
  // A creation in flight at the acknowledgement: committed before it (and listed).
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let atCommit = false;
  store.faults.beforeCommit = () => { atCommit = true; return gate; };
  const inFlight = s.append({ partition: upper[1] as PartitionKey, entries: [entry('u1')] });
  await until(() => atCommit, 5_000, 'the batch is at COMMIT');
  map.apply(V3);
  assert.deepEqual(await s.listPartitionsFor({ kind: 'account', slot: 0, mapVersion: 3n, home: { mod: 4, eq: 2 } }), { refused: 'NOT_ACKED' });
  assert.equal(acks.length, 0, 'no ack while a batch that started before the version is in flight');
  store.faults.beforeCommit = undefined;
  release();
  committed(await inFlight);
  await until(() => acks.length === 1, 5_000, 'ackSplitting');
  const ack = acks[0] as AckSplittingRequest;
  assert.deepEqual([ack.kind, ack.slot, ack.mapVersion, ack.epoch], ['account', 0, 3n, s.epoch(0)]);
  assert.deepEqual(ack.upperHalf.map(hex).sort(), [upper[0], upper[1]].map((p) => hex(p as PartitionKey)).sort());
  assert.deepEqual(await s.append({ partition: upper[2] as PartitionKey, entries: [entry('u2')] }), { r: 'Moved', slot: 2, generation: 0 },
    'a creation after the ack is refused MOVED(s + n)');
  const listed = await s.listPartitionsFor({ kind: 'account', slot: 0, mapVersion: 3n, home: { mod: 4, eq: 2 } });
  assert.ok('partitions' in listed);
  assert.deepEqual(listed.partitions.map(hex).sort(), ack.upperHalf.map(hex).sort());
  assert.deepEqual(await s.listPartitionsFor({ kind: 'account', slot: 1, mapVersion: 3n, home: { mod: 4, eq: 3 } }), { refused: 'NOT_OWNER' });
});

// ---------------- one re-home per revocation (defect found in this increment) ----------------

test('should re-home each slot once when the renewal and an Ambiguous resolution both see the same revoked session', T, async () => {
  const store = new MemoryStore();
  store.seedSlots(STOPK.kind, 4);
  const rt = await stopRuntime(store, [0, 1, 2, 3]);
  committed(await rt.append({ partition: X, entries: [entry('a1')] }));
  // The resolution read of the Ambiguous batch waits until the renewal has also seen the revocation.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const realRead = store.resolutionRead.bind(store);
  let gated = true;
  store.resolutionRead = async (...a) => { if (gated) { gated = false; await gate; } return realRead(...a); };
  let failedRenewals = 0;
  const realRenew = store.renewSession.bind(store);
  store.renewSession = async (...a) => { const ok = await realRenew(...a); if (!ok) failedRenewals += 1; return ok; };
  store.faults.commits.push('ambiguousCommitted');
  const old = rt.sessionId();
  const s = store.sessions.get(old);
  assert.ok(s);
  store.faults.beforeCommit = () => { s.revoked = true; };
  assert.deepEqual(await rt.append({ partition: X, entries: [entry('a2')] }), { r: 'Ambiguous' });
  store.faults.beforeCommit = undefined;
  await until(() => failedRenewals >= 1, 5_000, 'the renewal saw the revocation');
  release();
  await until(() => rt.sessionId() !== old && rt.heldSlots().length === 4, 5_000, 're-homed');
  await until(() => [0, 1, 2, 3].every((sl) => store.slotRow(STOPK.kind, sl)?.sessionId === rt.sessionId()), 5_000, 'slots under the new session');
  committed(await rt.append({ partition: X, entries: [entry('a3')] }));
  assert.deepEqual([0, 1, 2, 3].map((sl) => store.slotRow(STOPK.kind, sl)?.epoch), [2n, 2n, 2n, 2n], 'one re-home: epoch 1 → 2');
});
