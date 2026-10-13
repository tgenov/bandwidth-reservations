/**
 * S-PLAT-I3 work items 1 to 4: the move protocol of C01 §3.3 in the runtime (steps 2 to 6), the successor of A
 * after `moved` (V59-7) and the generation fence (DT-12). Placement's steps 1 and 7 are in placement-moves.test.ts.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppendResult, HlcTs, OpenedLogRow, OwnerDeclaration, OwnerHooks, PartitionKey, SlotNo } from '../src/index.ts';
import {
  CockroachOwnerRuntime, ManualLoad, PLATFORM_ENTRY, chainGenesis, chainNext, compareHlc, hex, slotOfPartition, utf8, type MoveInbox,
} from '../src/index.ts';
import { MemoryStore } from '../testing/index.ts';
import { Closers, until } from './support.ts';

/** A kind with markers (a reportWanted entry kind), so the report fence of step 4 applies. */
const DECL: OwnerDeclaration = {
  kind: 'mlink', slotCount: 4,
  entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops', reportWanted: true }],
  projections: [{ name: 'mark', ddl: 'partition BYTES NOT NULL, id STRING NOT NULL, PRIMARY KEY (partition, id)', clearColumns: ['partition', 'id'] }],
  streams: [{ name: 'ev', topic: 'mlink.ev.v1', key: 'partition', emitFn: { version: 1 }, closure: 'none', consumers: [] }],
};
/** The same kind without markers: no report fence (C01 §3.3 "Kinds without status readers skip step 4's fence wait"). */
const PLAIN: OwnerDeclaration = { ...DECL, kind: 'mplain', entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }],
  projections: [{ ...DECL.projections[0] as OwnerDeclaration['projections'][number] }],
  streams: [{ ...DECL.streams[0] as OwnerDeclaration['streams'][number], topic: 'mplain.ev.v1' }] };
const MARK = (d: OwnerDeclaration): string => `${d.kind}_mark`;
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const entry = (id: string) => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id }, emits: [{ stream: 'ev', event: { id } }] });
const FAST = { sessionTtlMs: 300, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 280, maxLoopDelayMs: 20 };
const B: SlotNo = 4;          // a dedicated slot above the slot count
const X = utf8('hot-link-x');
const SA = slotOfPartition(X, 4);
const closers = new Closers();
const T = { timeout: 20_000 };
afterEach(() => closers.closeAll());

interface Events { list: string[]; hooks: OwnerHooks }
function events(name: string): Events {
  const list: string[] = [];
  return {
    list,
    hooks: {
      async onAcquire(slot, _e, how) { list.push(`${name}:acquire:${slot}:${how}`); },
      onRelease(slot, why) { list.push(`${name}:release:${slot}:${why}`); },
      onReportable() {},
      onMovedOut(p) { list.push(`${name}:movedOut:${Buffer.from(p).toString()}`); },
      async onAdopt(p, g) { list.push(`${name}:adopt:${Buffer.from(p).toString()}:${g}`); },
      async onNotification() {},
    },
  };
}

interface World { store: MemoryStore; inbox: Map<SlotNo, MoveInbox> }
function world(decl: OwnerDeclaration): World {
  const store = new MemoryStore();
  store.seedSlots(decl.kind, 5);
  return { store, inbox: new Map() };
}

async function runtime(w: World, decl: OwnerDeclaration, slots: SlotNo[], ev: Events, extra: {
  postAcquisitionWaitMs?: number; adoptReportWaitMs?: number; fenceReadAfterMs?: number; prewarm?: (p: PartitionKey, rows: OpenedLogRow[]) => void;
} = {}): Promise<CockroachOwnerRuntime> {
  const rt = new CockroachOwnerRuntime({
    declaration: decl, store: w.store, slots, load: new ManualLoad(),
    moves: {
      peer: (_kind, slot) => w.inbox.get(slot),
      ...(extra.prewarm ? { prewarm: extra.prewarm } : {}),
      fenceReadAfterMs: extra.fenceReadAfterMs ?? 60_000,
    },
    testing: { sessionTimings: FAST, commitBackstopMs: 1_000, postAcquisitionWaitMs: extra.postAcquisitionWaitMs ?? 10,
      adoptReportWaitMs: extra.adoptReportWaitMs ?? 10 },
  });
  closers.add(() => rt.stop());
  await rt.start(ev.hooks);
  for (const s of slots) w.inbox.set(s, rt.moveInbox());
  await until(() => slots.every((s) => rt.heldSlots().includes(s)), 5_000, `slots ${slots.join(',')} held`);
  return rt;
}

function committed(r: AppendResult): Extract<AppendResult, { r: 'Committed' }> {
  assert.equal(r.r, 'Committed', `expected Committed, got ${JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`);
  return r as Extract<AppendResult, { r: 'Committed' }>;
}

function headOf(w: World, decl: OwnerDeclaration, p: PartitionKey) {
  const h = w.store.heads.get(`${decl.kind}|${hex(p)}`);
  assert.ok(h, 'head row exists');
  return h;
}

function logOf(w: World, p: PartitionKey) {
  return w.store.log.filter((l) => hex(l.partition) === hex(p)).sort((a, b) => (a.seq < b.seq ? -1 : 1));
}

/** A and B on one store; X has two entries in A and is prepared for a move to B (steps 1 and 2 done). */
async function prepared(decl = DECL, extraA: Parameters<typeof runtime>[4] = {}, extraB: Parameters<typeof runtime>[4] = {}) {
  const w = world(decl);
  const evA = events('A'); const evB = events('B');
  const a = await runtime(w, decl, [0, 1, 2, 3], evA, extraA);
  const b = await runtime(w, decl, [B], evB, extraB);
  committed(await a.append({ partition: X, entries: [entry('a1'), entry('a2')] }));
  await b.prepareAdopt({ partition: X, from: SA, to: B, generation: 1 });
  return { w, a, b, evA, evB };
}

test('C01 CP-5 MOVING in A between moved and adopt, MOVED(B, g+1) once adopted; no entry of X commits in B before adopt; onMovedOut after the moved commit, onAdopt after the adopt commit', T, async () => {
  const { w, a, b, evA, evB } = await prepared();
  assert.deepEqual(await b.append({ partition: X, entries: [entry('early')] }), { r: 'Moved', slot: SA, generation: 0 },
    'before moved, B sends X back to A');
  const moved = committed(await a.moveOut(X, B, 1));
  assert.deepEqual(evA.list.filter((e) => e.includes('movedOut')), ['A:movedOut:hot-link-x']);
  const h = headOf(w, DECL, X);
  assert.deepEqual([h.slot, h.generation, h.adopted, h.ts], [B, 1, false, moved.ts]);
  assert.deepEqual(await a.append({ partition: X, entries: [entry('a3')] }), { r: 'Moving' });
  assert.deepEqual(await b.append({ partition: X, entries: [entry('b0')] }), { r: 'Moving' });
  assert.equal(evB.list.some((e) => e.includes('adopt:')), false, 'onAdopt only after the adopt commit');
  const adopt = committed(await b.adopt(X));
  assert.deepEqual(evB.list.filter((e) => e.includes('adopt:')), ['B:adopt:hot-link-x:1']);
  assert.equal(headOf(w, DECL, X).adopted, true);
  assert.deepEqual(await a.append({ partition: X, entries: [entry('a4')] }), { r: 'Moved', slot: B, generation: 1 });
  const after = committed(await b.append({ partition: X, entries: [entry('b1')] }));
  assert.equal(compareHlc(moved.ts, adopt.ts), -1);
  assert.equal(compareHlc(adopt.ts, after.ts), -1);
  const log = logOf(w, X);
  assert.deepEqual(log.map((l) => [l.seq, l.slot, l.generation, l.kind]), [
    [1n, SA, 0, 1], [2n, SA, 0, 1], [3n, SA, 0, PLATFORM_ENTRY.moved], [4n, B, 1, PLATFORM_ENTRY.adopt], [5n, B, 1, 1],
  ]);
  assert.deepEqual(after.streamSeqs, { ev: [3n, 3n] }, 'stream_seq continues from the head row');
  assert.equal(b.generation(X), 1);
});

test('C01 CP-5 seq, chain and stream_seq continue across the move: the head chain is the recomputed chain over every row of X', T, async () => {
  const { w, a, b } = await prepared();
  committed(await a.moveOut(X, B, 1));
  committed(await b.adopt(X));
  committed(await b.append({ partition: X, entries: [entry('b1'), entry('b2')] }));
  let chain = chainGenesis(DECL.kind, X);
  for (const r of logOf(w, X)) {
    chain = chainNext(chain, { kindName: DECL.kind, partition: X, seq: r.seq, slot: r.slot, generation: r.generation, epoch: r.epoch,
      entryKind: r.kind, schemaV: r.schemaV, identity: r.identity, emits: r.emits, retention: r.retention, keyId: r.keyId, audit: r.audit, payload: r.payload });
    assert.equal(hex(r.chain), hex(chain), `chain of seq ${r.seq}`);
  }
  assert.equal(hex(headOf(w, DECL, X).chain), hex(chain));
  assert.deepEqual(Object.entries(headOf(w, DECL, X).streams), [['ev', 4n]]);
});

test('C01 CP-5 adopt never commits before owner_slot(kind, A).report_through ≥ ts(moved), also when A reports late', T, async () => {
  const { w, a, b } = await prepared(DECL, { postAcquisitionWaitMs: 300 });
  const checked: Array<[HlcTs | null, HlcTs]> = [];
  w.store.commitListeners.push((kind, wr) => {
    if (kind === DECL.kind && wr.log.some((l) => l.kind === PLATFORM_ENTRY.adopt)) {
      checked.push([w.store.slotRow(DECL.kind, SA)?.reportThrough ?? null, headOf(w, DECL, X).ts]);
    }
  });
  const moved = committed(await a.moveOut(X, B, 1));
  const adopting = b.adopt(X);
  committed(await adopting);
  assert.equal(checked.length, 1);
  const [through] = checked[0] as [HlcTs | null, HlcTs];
  assert.ok(through !== null && compareHlc(through, moved.ts) >= 0, `report_through ${through} ≥ ts(moved) ${moved.ts}`);
  assert.equal(b.moveStats.fencesPushed, 1);
  assert.equal(b.moveStats.fencesRead, 0);
});

test('C01 CP-5 adopt reads owner_slot(kind, A) by a bounded read when no fence push arrives', T, async () => {
  const { w, a, b } = await prepared(DECL, {}, { fenceReadAfterMs: 0 });
  w.inbox.delete(B);                               // A cannot push to B
  const moved = committed(await a.moveOut(X, B, 1));
  committed(await b.adopt(X));
  assert.equal(b.moveStats.fencesPushed, 0);
  assert.ok(b.moveStats.fencesRead >= 1);
  const through = w.store.slotRow(DECL.kind, SA)?.reportThrough ?? null;
  assert.ok(through !== null && compareHlc(through, moved.ts) >= 0);
});

test('should adopt at once with no fence when the kind has no markers (no status readers, no reportWanted entry)', T, async () => {
  const { w, a, b } = await prepared(PLAIN);
  committed(await a.moveOut(X, B, 1));
  committed(await b.adopt(X));
  assert.equal(w.store.slotRow(PLAIN.kind, SA)?.reportThrough ?? null, null, 'no marker was written');
  assert.deepEqual([b.moveStats.fencesPushed, b.moveStats.fencesRead], [0, 0]);
});

test('C01 CP-5 B\'s report position does not pass an entry of X before read_lease + ε after adopt', T, async () => {
  const WAIT = 400;
  const { a, b } = await prepared(DECL, {}, { adoptReportWaitMs: WAIT });
  committed(await a.moveOut(X, B, 1));
  const seen: Array<{ p: HlcTs; at: number }> = [];
  b.onReport((slot, p) => { if (slot === B) seen.push({ p, at: performance.now() }); });
  const adopt = committed(await b.adopt(X));
  const adoptedAt = performance.now();
  const e = committed(await b.append({ partition: X, entries: [entry('b1')] }));
  await until(() => { const p = b.reportPosition(B); return p !== undefined && compareHlc(p, e.ts) >= 0; }, 5_000, 'B reports b1');
  for (const s of seen) {
    if (compareHlc(s.p, adopt.ts) >= 0) assert.ok(s.at - adoptedAt >= WAIT - 5, `P ${s.p} passed adopt ${s.at - adoptedAt} ms after the adopt commit`);
  }
});

test('C01 CP-5 after a move and a takeover of the new slot, a decision committed before the move still fails rowAbsent', T, async () => {
  const { w, a, b } = await prepared();
  const decision = { table: MARK(DECL), key: { partition: X, id: 'decided' } };
  committed(await a.append({ partition: X, entries: [entry('decide')], projections: [{ table: decision.table, op: 'upsert', key: decision.key, row: { v: 1 } }] }));
  committed(await a.moveOut(X, B, 1));
  committed(await b.adopt(X));
  await b.stop();
  const c = await runtime(w, DECL, [B], events('C'));
  assert.deepEqual(await c.append({ partition: X, conditions: [{ kind: 'rowAbsent', row: decision, label: 'undecided' }], entries: [entry('twice')] }),
    { r: 'ConditionFailed', which: 'undecided' });
  committed(await c.append({ partition: X, entries: [entry('c1')] }));
  assert.equal(c.generation(X), 1);
});

test('C01 CP-5 A\'s holder killed after moved: the successor pushes its first marker to B, and B adopts', T, async () => {
  // A never becomes reportable, so it writes no marker before it dies.
  const { w, a, b } = await prepared(DECL, { postAcquisitionWaitMs: 60_000 });
  const moved = committed(await a.moveOut(X, B, 1));
  const adopting = b.adopt(X);
  a.pauseRenewalsForTest();                         // killed: no renewal, no marker
  const evA2 = events('A2');
  const a2 = await runtime(w, DECL, [SA], evA2);
  committed(await adopting);
  assert.equal(b.moveStats.fencesPushed, 1, 'the successor pushed its first marker');
  assert.equal(b.moveStats.fencesRead, 0);
  const through = w.store.slotRow(DECL.kind, SA)?.reportThrough ?? null;
  assert.ok(through !== null && compareHlc(through, moved.ts) >= 0);
  assert.deepEqual(await a2.append({ partition: X, entries: [entry('late')] }), { r: 'Moved', slot: B, generation: 1 });
});

test('C01 CP-5 two slots\' markers never touch each other\'s report_through', T, async () => {
  const { w, a, b } = await prepared();
  const updates: Array<[SlotNo, SlotNo[]]> = [];
  w.store.commitListeners.push((kind, wr) => {
    if (kind === DECL.kind && wr.slotUpdate) updates.push([wr.slotUpdate.slot, [...new Set(wr.log.map((l) => l.slot))]]);
  });
  committed(await a.moveOut(X, B, 1));
  committed(await b.adopt(X));
  const e = committed(await b.append({ partition: X, entries: [entry('b1')] }));
  await until(() => { const r = w.store.slotRow(DECL.kind, B)?.reportThrough; return r !== null && r !== undefined && compareHlc(r, e.ts) >= 0; }, 5_000, 'B marker');
  const aThrough = w.store.slotRow(DECL.kind, SA)?.reportThrough;
  const bThrough = w.store.slotRow(DECL.kind, B)?.reportThrough;
  assert.ok(aThrough && bThrough && compareHlc(aThrough, e.ts) < 0, 'A\'s report_through stays below B\'s entry');
  for (const [slot, logSlots] of updates) for (const s of logSlots) assert.equal(s, slot, 'a marker rides only its own slot\'s batch');
});

test('should give the pre-warm hook X\'s rows by (partition, seq) at prepare, and the rows above them before onAdopt (no cold rebuild)', T, async () => {
  const got: string[] = [];
  const order: string[] = [];
  const { a, b, evB } = await prepared(DECL, {}, { prewarm: (_p, rows) => { for (const r of rows) got.push(`${r.seq}`); order.push('prewarm'); } });
  committed(await a.append({ partition: X, entries: [entry('a3')] }));
  committed(await a.moveOut(X, B, 1));
  committed(await b.adopt(X));
  assert.deepEqual(got, ['1', '2', '3'], 'platform entries are not given to the owner; each owner row once');
  assert.deepEqual(order, ['prewarm', 'prewarm'], 'at prepare, then the rows above them at adopt');
  assert.deepEqual(evB.list.filter((e) => e.includes('adopt:')), ['B:adopt:hot-link-x:1']);
});

test('should refuse moved with ConditionFailed generation when the generation is not head + 1, and write nothing', T, async () => {
  const { w, a } = await prepared();
  assert.deepEqual(await a.moveOut(X, B, 2), { r: 'ConditionFailed', which: 'generation' });
  assert.deepEqual(logOf(w, X).map((l) => l.seq), [1n, 2n]);
  assert.deepEqual(await a.moveOut(utf8('never-written'), B, 1), { r: 'ConditionFailed', which: 'noHead' });
});

test('should refuse adopt with ConditionFailed adopt when the head does not name B unadopted at the generation', T, async () => {
  const { b } = await prepared();
  assert.deepEqual(await b.adopt(X), { r: 'ConditionFailed', which: 'adopt' }, 'no moved yet');
  assert.deepEqual(await b.adopt(utf8('unknown')), { r: 'ConditionFailed', which: 'notPrepared' });
});

test('DT-12 a receiver that has seen (g, 57) accepts (g + 1, 3) and refuses (g, 56)', T, async () => {
  const w = world(PLAIN);
  const rt = await runtime(w, PLAIN, [0, 1, 2, 3], events('R'));
  const sender = { kind: 'link', partition: utf8('L') };
  committed(await rt.append({ partition: X, entries: [{ ...entry('cmd'), senderFence: { ...sender, generation: 0, epoch: 57n } }] }));
  assert.deepEqual(rt.admitCommand(sender, { generation: 1, epoch: 3n }), { admit: true });
  assert.deepEqual(rt.admitCommand(sender, { generation: 0, epoch: 56n }), { admit: false, recorded: { generation: 0, epoch: 57n } });
});

test('should rebuild the admitCommand high-water marks of X on adopt from X\'s log (R47-24)', T, async () => {
  const { a, b } = await prepared();
  const sender = { kind: 'account', partition: utf8('acct') };
  committed(await a.append({ partition: X, entries: [{ ...entry('cmd'), senderFence: { ...sender, generation: 2, epoch: 9n } }] }));
  committed(await a.moveOut(X, B, 1));
  assert.deepEqual(b.admitCommand(sender, { generation: 2, epoch: 8n }), { admit: true }, 'B has not adopted X yet');
  committed(await b.adopt(X));
  assert.deepEqual(b.admitCommand(sender, { generation: 2, epoch: 8n }), { admit: false, recorded: { generation: 2, epoch: 9n } });
});

test('should cancel the timers of X when moved commits in A (C01 §3.7)', T, async () => {
  const w = world(PLAIN);
  const fired: string[] = [];
  const a = new CockroachOwnerRuntime({ declaration: PLAIN, store: w.store, slots: [0, 1, 2, 3], load: new ManualLoad(),
    onTimer: (_p, k) => fired.push(k), testing: { sessionTimings: FAST, postAcquisitionWaitMs: 10 } });
  closers.add(() => a.stop());
  await a.start(events('A').hooks);
  await until(() => a.heldSlots().length === 4, 5_000, 'A holds its slots');
  committed(await a.append({ partition: X, entries: [entry('a1')] }));
  a.timer(X, 'deadline', '99999999999999999999.0000000000' as HlcTs);
  assert.equal(a.timerKeys(X).length, 1);
  committed(await a.moveOut(X, B, 1));
  assert.deepEqual(a.timerKeys(X), []);
  assert.deepEqual(fired, []);
});
