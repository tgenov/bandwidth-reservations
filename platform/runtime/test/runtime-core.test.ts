/**
 * The real runtime core (CockroachOwnerRuntime) over the in-memory store with fault injection:
 * CP-1, CP-2 (six results), CP-2a (subset), CP-3, CP-4, "decide re-runs on restart", "a stale epoch never commits".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppendResult, EntryInput, Epoch, OwnerDeclaration, OwnerHooks, SlotNo } from '../src/index.ts';
import {
  CockroachOwnerRuntime, DevSealer, ManualLoad, MemoryPublisher, chainGenesis, chainNext, compareHlc, decodeJson, hex,
  slotOfPartition, utf8,
} from '../src/index.ts';
import { MemoryStore } from '../testing/index.ts';

const DECL: OwnerDeclaration = {
  kind: 'canary', slotCount: 4,
  entryKinds: [{ kind: 1, name: 'incremented', schemaVersions: [1], retention: 'ops' }],
  projections: [
    { name: 'mark', ddl: 'partition BYTES NOT NULL, id STRING NOT NULL, PRIMARY KEY (partition, id)', clearColumns: ['partition', 'id'], deletable: true },
  ],
  streams: [{ name: 'counter', topic: 'canary.counter.v1', key: 'partition', emitFn: { version: 1 }, closure: 'none', consumers: [] }],
};

const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'internal_service', kind: 'service', tenant: 'share' },
  decided_at: 'commit', policy_version: 1 } as const;
const entry = (id: string, emit = true): EntryInput => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id },
  ...(emit ? { emits: [{ stream: 'counter', event: { id } }] } : {}) });

const FAST = { sessionTtlMs: 300, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 280, maxLoopDelayMs: 20 };

interface Recorder extends OwnerHooks { acquired: Array<[SlotNo, Epoch, string]>; released: Array<[SlotNo, string]> }
function recorder(): Recorder {
  const r: Recorder = {
    acquired: [], released: [],
    async onAcquire(slot, epoch, kind) { r.acquired.push([slot, epoch, kind]); },
    onRelease(slot, reason) { r.released.push([slot, reason]); },
    onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {},
  };
  return r;
}

async function boot(store = new MemoryStore(), extra: Partial<ConstructorParameters<typeof CockroachOwnerRuntime>[0]> = {}) {
  store.seedSlots(DECL.kind, DECL.slotCount);
  const publisher = new MemoryPublisher();
  const load = new ManualLoad();
  const hooks = recorder();
  const rt = new CockroachOwnerRuntime({
    declaration: DECL, store, slots: [0, 1, 2, 3], publisher, load,
    testing: { sessionTimings: FAST, commitBackstopMs: 60 }, ...extra,
  });
  await rt.start(hooks);
  return { rt, store, publisher, load, hooks };
}

const P = utf8('link-1');
const SLOT = slotOfPartition(P, DECL.slotCount);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Committed: contiguous seq, increasing ts, log + head + outbox in one commit, chain per C08 §J, direct publish', async () => {
  const { rt, store, publisher } = await boot();
  const r1 = await rt.append({ partition: P, entries: [entry('a'), entry('b')] });
  const r2 = await rt.append({ partition: P, entries: [entry('c')] });
  assert.equal(r1.r, 'Committed'); assert.equal(r2.r, 'Committed');
  if (r1.r !== 'Committed' || r2.r !== 'Committed') return;
  assert.deepEqual([r1.seqFrom, r1.seqTo, r2.seqFrom, r2.seqTo], [1n, 2n, 3n, 3n]);
  assert.deepEqual(r1.streamSeqs['counter'], [1n, 2n]);
  assert.equal(compareHlc(r1.ts, r2.ts), -1);
  assert.equal(store.commitCount, 2);
  const rows = store.log.filter((l) => hex(l.partition) === hex(P));
  assert.deepEqual(rows.map((l) => l.seq), [1n, 2n, 3n]);
  let chain = chainGenesis('canary', P);
  for (const l of rows) {
    chain = chainNext(chain, { kindName: 'canary', partition: P, seq: l.seq, slot: l.slot, generation: l.generation, epoch: l.epoch,
      entryKind: l.kind, schemaV: l.schemaV, identity: l.identity, emits: l.emits, retention: l.retention, keyId: l.keyId, audit: l.audit, payload: l.payload });
    assert.equal(hex(chain), hex(l.chain));
  }
  const head = store.heads.get(`canary|${hex(P)}`);
  assert.equal(head?.seq, 3n);
  assert.equal(hex(head?.chain ?? new Uint8Array()), hex(chain));
  assert.equal(store.outbox.length, 3);
  const opened = new DevSealer().open(rows[0]?.payload ?? new Uint8Array(), {
    ownerKind: 'canary', table: 'canary_log', primaryKey: { slot: SLOT, partition: P, seq: 1n }, seqOrVersion: 1n, epoch: rows[0]?.epoch ?? 0n, rowKind: 'entry:1' });
  assert.deepEqual(decodeJson(opened), { id: 'a' });
  await sleep(5);
  assert.equal(publisher.sent.length, 3);
  assert.equal(publisher.sent[0]?.topic, 'canary.counter.v1');
  assert.equal(publisher.sent[0]?.headers['stream_seq'], '1');
  await rt.stop();
});

test('CP-2 ConditionFailed: the failed call writes nothing; the rest of the batch commits', async () => {
  const { rt, store } = await boot();
  const mark = { table: 'canary_mark', key: { partition: P, id: 'm' } };
  const first = rt.append({ partition: P, entries: [entry('x')], projections: [{ table: 'canary_mark', op: 'upsert', key: mark.key, row: {} }] });
  // These two queue behind the first and travel in one batch.
  const second = rt.append({ partition: P, conditions: [{ kind: 'rowAbsent', row: mark, label: 'unmarked' }], entries: [entry('y')] });
  const third = rt.append({ partition: utf8('other'), entries: [entry('z')] });
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.equal(a.r, 'Committed');
  assert.deepEqual(b, { r: 'ConditionFailed', which: 'unmarked' });
  assert.equal(c.r, slotOfPartition(utf8('other'), 4) === SLOT ? 'Committed' : 'Committed');
  assert.ok(!store.log.some((l) => hex(l.identity) === hex(utf8('y'))));
  await rt.stop();
});

test('CP-2 ConditionFailed inside one batch: a later call sees an earlier call\'s projection write (no double decision)', async () => {
  const { rt } = await boot();
  const mark = { table: 'canary_mark', key: { partition: P, id: 'once' } };
  const call = () => rt.append({ partition: P, conditions: [{ kind: 'rowAbsent', row: mark, label: 'undecided' }],
    entries: [entry('decide')], projections: [{ table: 'canary_mark', op: 'upsert', key: mark.key, row: {} }] });
  void rt.append({ partition: P, entries: [entry('warm')] });
  const [x, y] = await Promise.all([call(), call()]);
  assert.deepEqual([x.r, y.r], ['Committed', 'ConditionFailed']);
  await rt.stop();
});

test('CP-2 Retry: exactly 5 restarts + 1 fresh attempt, then Retry; decide re-runs each time; nothing commits', async () => {
  let decides = 0;
  const { rt, store } = await boot(undefined, { testing: { sessionTimings: FAST, commitBackstopMs: 60, onDecide: () => { decides += 1; } } });
  store.faults.commits = Array.from({ length: 7 }, () => 'retry' as const);
  const r = await rt.append({ partition: P, decide: () => ({ entries: [entry('r')] }) });
  assert.deepEqual(r, { r: 'Retry' });
  assert.equal(decides, 7);
  assert.equal(store.statements.filter((s) => s === 'restart').length, 5);
  assert.equal(store.commitCount, 0);
  // Six failures: the fresh attempt commits.
  store.faults.commits = Array.from({ length: 6 }, () => 'retry' as const);
  decides = 0;
  assert.equal((await rt.append({ partition: P, decide: () => ({ entries: [entry('r')] }) })).r, 'Committed');
  assert.equal(decides, 7);
  await rt.stop();
});

test('CP-3: decide is re-run on every restart with a new ts; only the last attempt commits; ctx.read serves declared reads only', async () => {
  const { rt, store } = await boot();
  store.faults.commits = ['retry', 'retry'];
  const seen: string[] = [];
  const r = await rt.append({ partition: P, decide: (ctx) => { seen.push(ctx.ts); return { entries: [entry(`at-${seen.length}`, false)] }; } });
  assert.equal(r.r, 'Committed');
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen).size, 3);
  assert.ok(seen.every((t, i) => i === 0 || compareHlc(seen[i - 1] as never, t as never) < 0));
  assert.deepEqual(store.log.filter((l) => hex(l.partition) === hex(P)).map((l) => Buffer.from(l.identity).toString()), ['at-3']);
  if (r.r === 'Committed') assert.equal(r.ts, seen[2]);
  const declared = { table: 'canary_mark', key: { partition: P, id: 'd' } };
  assert.equal((await rt.append({ partition: P, reads: [declared], decide: (ctx) => { assert.equal(ctx.read(declared), undefined); return { entries: [] }; } })).r, 'Committed');
  await assert.rejects(rt.append({ partition: P, decide: (ctx) => { ctx.read(declared); return null; } }), /undeclared/);
  await rt.stop();
});

test('CP-2 StaleEpoch / a stale epoch never commits: an acquisition between the fence read and COMMIT', async () => {
  const { rt, store, hooks } = await boot();
  store.faults.beforeCommit = () => {
    const row = store.slotRow('canary', SLOT);
    if (row) { row.epoch += 1n; row.sessionId = 'successor'; }   // a successor's acquisition commits
    store.faults.beforeCommit = undefined;
  };
  const r = await rt.append({ partition: P, entries: [entry('late')] });
  assert.deepEqual(r, { r: 'StaleEpoch' });
  assert.equal(store.commitCount, 0);
  assert.equal(store.log.length, 0);
  assert.deepEqual(hooks.released, [[SLOT, 'staleEpoch']]);
  assert.deepEqual(await rt.append({ partition: P, entries: [entry('after')] }), { r: 'StaleEpoch' });
  assert.equal(rt.leaseValid(SLOT).valid, false);
  await rt.stop();
});

test('CP-2a Ambiguous, committed: the slot decides nothing until resolution; head batch_id classifies it; seq continues', async () => {
  const { rt, store } = await boot();
  store.faults.commits = ['ambiguousCommitted'];
  assert.deepEqual(await rt.append({ partition: P, entries: [entry('amb')] }), { r: 'Ambiguous' });
  assert.equal(rt.leaseValid(SLOT).valid, false, 'no decision from memory before resolution');
  const next = await rt.append({ partition: P, entries: [entry('next')] });
  assert.equal(next.r, 'Committed');
  if (next.r === 'Committed') assert.equal(next.seqFrom, 2n);
  assert.equal(rt.leaseValid(SLOT).valid, true);
  await rt.stop();
});

test('CP-2a Ambiguous, not committed; and the 15 s backstop (shortened) expiring', async () => {
  const { rt, store } = await boot();
  store.faults.commits = ['ambiguousNotCommitted'];
  assert.deepEqual(await rt.append({ partition: P, entries: [entry('lost')] }), { r: 'Ambiguous' });
  const next = await rt.append({ partition: P, entries: [entry('again')] });
  if (next.r === 'Committed') assert.equal(next.seqFrom, 1n); else assert.fail(next.r);
  store.faults.commits = ['hang'];
  const t0 = Date.now();
  assert.deepEqual(await rt.append({ partition: P, entries: [entry('hang')] }), { r: 'Ambiguous' });
  assert.ok(Date.now() - t0 >= 60);
  assert.equal((await rt.append({ partition: P, entries: [entry('after-hang')] })).r, 'Committed');
  await rt.stop();
});

test('CP-2a Ambiguous with the epoch moved meanwhile ⇒ StaleEpoch; with the session revoked ⇒ re-home', async () => {
  {
    const { rt, store, hooks } = await boot();
    store.faults.commits = ['ambiguousNotCommitted'];
    store.faults.beforeCommit = () => { store.faults.beforeCommit = undefined; };
    const pending = rt.append({ partition: P, entries: [entry('x')] });
    assert.deepEqual(await pending, { r: 'Ambiguous' });
    const row = store.slotRow('canary', SLOT);
    if (row) row.epoch += 1n;
    assert.deepEqual(await rt.append({ partition: P, entries: [entry('y')] }), { r: 'StaleEpoch' });
    assert.ok(hooks.released.some(([s, r]) => s === SLOT && r === 'staleEpoch'));
    await rt.stop();
  }
  {
    const { rt, store, hooks } = await boot();
    store.faults.commits = ['ambiguousCommitted'];
    const old = rt.sessionId();
    store.faults.beforeCommit = () => { const s = store.sessions.get(old); if (s) s.revoked = true; store.faults.beforeCommit = undefined; };
    assert.deepEqual(await rt.append({ partition: P, entries: [entry('x')] }), { r: 'Ambiguous' });
    const next = await rt.append({ partition: P, entries: [entry('y')] });
    assert.equal(next.r, 'Committed');
    assert.notEqual(rt.sessionId(), old);
    assert.ok(hooks.acquired.some(([s, e, k]) => s === SLOT && k === 'rehome' && e === 2n));
    await rt.stop();
  }
});

test('CP-2 Overloaded only from shedding (event-loop monitor) or admission control', async () => {
  const { rt, load } = await boot();
  load.value = true;
  assert.deepEqual(await rt.append({ partition: P, entries: [entry('o')] }), { r: 'Overloaded', retryAfterMs: 100 });
  load.value = false;
  assert.equal((await rt.append({ partition: P, entries: [entry('o')] })).r, 'Committed');
  await rt.stop();
});

test('Stopped, Moving, Moved and lockTimeout per call', async () => {
  const { rt, store } = await boot();
  assert.equal((await rt.append({ partition: P, entries: [entry('s0')] })).r, 'Committed');
  store.stopPartition('canary', SLOT, P, utf8('det-1'));
  const s = await rt.append({ partition: P, entries: [entry('s1')] });
  assert.equal(s.r, 'Stopped');
  if (s.r === 'Stopped') assert.equal(Buffer.from(s.detectionRef).toString(), 'det-1');
  const Q = utf8('moved-one');
  const qSlot = slotOfPartition(Q, 4);
  assert.equal((await rt.append({ partition: Q, entries: [entry('q0')] })).r, 'Committed');
  const h = store.heads.get(`canary|${hex(Q)}`);
  if (!h) assert.fail('no head');
  store.heads.set(`canary|${hex(Q)}`, { ...h, slot: (qSlot + 1) % 4, generation: 1, adopted: false });
  assert.deepEqual(await rt.append({ partition: Q, entries: [entry('q1')] }), { r: 'Moving' });
  store.heads.set(`canary|${hex(Q)}`, { ...h, slot: (qSlot + 1) % 4, generation: 1, adopted: true });
  assert.deepEqual(await rt.append({ partition: Q, entries: [entry('q2')] }), { r: 'Moved', slot: (qSlot + 1) % 4, generation: 1 });
  store.faults.displacementLockTimeout = true;
  const R = utf8('acct');
  assert.deepEqual(await rt.append({ partition: R, conditions: [{ kind: 'displacementRead', link: utf8('L'), request: new Uint8Array(12), attempt: 1, lockTimeoutMs: 10, label: 'disp' }], entries: [entry('r')] }),
    { r: 'ConditionFailed', which: 'lockTimeout' });
  await rt.stop();
});

test('CP-4: exclusive + firstStatement — placeholders written first with the ts read, then the fence; the call goes alone', async () => {
  const { rt, store } = await boot();
  const mark = { table: 'canary_mark', key: { partition: P, id: 'placeholder' } };
  store.statements.length = 0;
  const r = await rt.append({ partition: P, entries: [entry('cut')] },
    { exclusive: true, firstStatement: [{ table: 'canary_mark', op: 'upsert', key: mark.key, row: { } }], abandonBeforeCommitMs: 250 });
  assert.equal(r.r, 'Committed');
  assert.deepEqual(store.statements.slice(0, 2), ['firstStatement', 'readFence']);
  assert.ok(!store.statements.includes('readTs'), 'ts comes from the first statement');
  assert.ok(store.rows.has(`canary_mark|${JSON.stringify({ id: 'placeholder', partition: { $b: hex(P) } })}`));
  await rt.stop();
});

test('CP-1: two processes contend for a slot across a pause; no two committed writers; seq contiguous, ts increasing', async () => {
  const store = new MemoryStore();
  const a = await boot(store);
  const results: AppendResult[] = [];
  for (let i = 0; i < 5; i++) results.push(await a.rt.append({ partition: P, entries: [entry(`a${i}`)] }));
  a.rt.pauseRenewalsForTest();                        // A is paused: no renewals reach the database
  const b = await boot(store, { slots: [SLOT] });      // B starts; its tick takes the slot after expiry
  for (let i = 0; i < 40 && !b.rt.heldSlots().includes(SLOT); i++) await sleep(25);
  assert.ok(b.rt.heldSlots().includes(SLOT), 'B acquired the slot by expiry');
  // A's view has ended, so it proposes nothing; when it wakes, its renewal finds the session revoked,
  // the re-home's conditional transfer fails (the epoch moved), and the queued call is answered StaleEpoch.
  assert.equal(a.rt.leaseValid(SLOT).valid, false);
  const late = a.rt.append({ partition: P, entries: [entry('a-late')] });
  a.rt.resumeRenewalsForTest();
  assert.equal((await late).r, 'StaleEpoch');
  assert.ok(a.hooks.released.some(([s, r]) => s === SLOT && r === 'taken'));
  for (let i = 0; i < 5; i++) assert.equal((await b.rt.append({ partition: P, entries: [entry(`b${i}`)] })).r, 'Committed');
  const rows = store.log.filter((l) => hex(l.partition) === hex(P));
  assert.deepEqual(rows.map((l) => l.seq), Array.from({ length: 10 }, (_, i) => BigInt(i + 1)));
  for (let i = 1; i < rows.length; i++) {
    assert.ok(compareHlc(rows[i - 1]?.ts as never, rows[i]?.ts as never) < 0);
    assert.ok((rows[i - 1]?.epoch ?? 0n) <= (rows[i]?.epoch ?? 0n), 'epochs never go back');
  }
  assert.ok(!rows.some((l) => Buffer.from(l.identity).toString() === 'a-late'));
  assert.ok(results.every((r) => r.r === 'Committed'));
  await a.rt.stop(); await b.rt.stop();
});

test('C02 / P1-S78: a displacement marker with ANY attempt fails displacementRead; ConditionFailed carries the marker', async () => {
  const { rt, store } = await boot();
  const link = utf8('L-disp');
  const request = new Uint8Array(12);
  const cond = (attempt: number) => ({ kind: 'displacementRead' as const, link, request, attempt, lockTimeoutMs: 10, label: 'disp' });
  const A = utf8('acct-d');
  assert.equal((await rt.append({ partition: A, conditions: [cond(2)], entries: [entry('none')] })).r, 'Committed', 'no marker: passes');
  store.displacement.set(`${hex(link)}|${hex(request)}`, { attempt: 1, reduction_seq: '7' });
  for (const attempt of [1, 2]) {
    const r = await rt.append({ partition: A, conditions: [cond(attempt)], entries: [entry(`e${attempt}`)] });
    assert.equal(r.r, 'ConditionFailed');
    if (r.r === 'ConditionFailed') {
      assert.equal(r.which, 'disp');
      assert.equal(r.displacement?.attempt, 1, 'the marker attempt is returned (C02 alert on mismatch)');
    }
  }
  await rt.stop();
});
