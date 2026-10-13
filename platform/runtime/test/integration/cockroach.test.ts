/**
 * Integration tests on the dev cell (`npm run dev:up`). They skip with a message when CockroachDB is not
 * reachable at DATABASE_URL, and fail instead with REQUIRE_DEV_CELL=1. Cover CP-1, CP-2 (Committed, ConditionFailed, Retry, StaleEpoch, Ambiguous,
 * Overloaded), CP-3, CP-4, "decide re-runs on restart" and "a stale epoch never commits"; plus direct publish
 * to Kafka when KAFKA_BROKERS (default localhost:9092) answers.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Kafka, logLevel } from 'kafkajs';
import type { EntryInput, OwnerDeclaration, OwnerHooks, ProjectionWrite, RowRef, SlotNo } from '../../src/index.ts';
import {
  CockroachOwnerRuntime, KafkaBus, KafkaPublisher, ManualLoad, MemoryPublisher, PgStore, chainGenesis, chainNext,
  compareHlc, hex, slotOfPartition, utf8,
} from '../../src/index.ts';
import { AmbiguousCommitError, retryableError } from '../../src/errors.ts';
import type { Publisher } from '../../src/publisher.ts';
import type { BatchTxn, OwnerStore } from '../../src/store/types.ts';
import { migrateKinds } from '@share/owner-migrate';
import { devCellSkip } from '../../testing/dev-cell.ts';

const URL = process.env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';
const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');

async function dbReachable(): Promise<string | undefined> {
  const c = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 1_500 });
  try { await c.connect(); await c.query('SELECT 1'); return undefined; } catch (e) { return (e as { code?: string }).code ?? String(e); } finally { await c.end().catch(() => {}); }
}

function tcpReachable(hostPort: string): Promise<boolean> {
  const [host = 'localhost', port = '9092'] = hostPort.split(':');
  return new Promise((resolve) => {
    const s = connect({ host, port: Number(port), timeout: 1_000 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

const dbError = await dbReachable();
const SKIP = devCellSkip(dbError === undefined ? undefined : `CockroachDB at ${URL}: ${dbError}`);
const kafkaUp = !SKIP && await tcpReachable(BROKERS[0] ?? 'localhost:9092');
const KAFKA_SKIP = SKIP || devCellSkip(kafkaUp ? undefined : `Kafka at ${BROKERS[0]}`);

const KIND = `itest_${randomBytes(3).toString('hex')}`;
const DECL: OwnerDeclaration = {
  kind: KIND, slotCount: 4,
  entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }],
  projections: [
    { name: 'mark', ddl: 'partition BYTES NOT NULL, id STRING NOT NULL, PRIMARY KEY (partition, id)', clearColumns: ['partition', 'id'], deletable: true },
    // A stand-in for C02's link_displacement, keyed without the slot.
    { name: 'displacement', ddl: 'link_id STRING NOT NULL, request_part BYTES NOT NULL, request_seq INT8 NOT NULL, attempt INT4 NOT NULL, reduction_seq INT8 NOT NULL, record_hlc DECIMAL NOT NULL, PRIMARY KEY (link_id, request_part, request_seq)',
      clearColumns: ['link_id', 'request_part', 'request_seq', 'attempt', 'reduction_seq', 'record_hlc'], deletable: true },
  ],
  streams: [{ name: 'counter', topic: `${KIND}.counter.v1`, key: 'partition', emitFn: { version: 1 }, closure: 'none', consumers: [] }],
};
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'internal_service', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const entry = (id: string): EntryInput => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id }, emits: [{ stream: 'counter', event: { id } }] });
const FAST = { sessionTtlMs: 1_500, sessionRenewMs: 200, renewRetryMs: 100, holderViewMs: 1_400, maxLoopDelayMs: 100 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wraps PgStore to inject faults around the real transaction (the real SQL still runs). */
class FaultStore {
  retriesAtCommit = 0;
  ambiguous: 'none' | 'committed' | 'notCommitted' = 'none';
  beforeCommit: (() => Promise<void>) | undefined;
  readonly inner: PgStore;
  constructor(inner: PgStore) {
    this.inner = inner;
  }
  wrap(): OwnerStore {
    const self = this;
    const inner = this.inner;
    return new Proxy(inner, {
      get(target, prop, recv) {
        if (prop !== 'beginBatch') { const v: unknown = Reflect.get(target, prop, recv); return typeof v === 'function' ? (v.bind(target) as unknown) : v; }
        return async (): Promise<BatchTxn> => {
          const tx = await inner.beginBatch();
          const commit = tx.commit.bind(tx);
          const rollback = tx.rollback.bind(tx);
          tx.commit = async (ms: number) => {
            if (self.beforeCommit) { const f = self.beforeCommit; self.beforeCommit = undefined; await f(); }
            if (self.retriesAtCommit > 0) {
              self.retriesAtCommit -= 1;
              // A real 40001 from CockroachDB: the transaction restarts with a new timestamp, as in production.
              // (A client-made 40001 would keep the old timestamp across ROLLBACK TO SAVEPOINT.)
              await (tx as unknown as { client: pg.PoolClient }).client.query(`SELECT crdb_internal.force_retry('1h')`);
              throw retryableError('force_retry did not fail');
            }
            if (self.ambiguous === 'notCommitted') { self.ambiguous = 'none'; await rollback(); throw new AmbiguousCommitError('injected: not committed'); }
            await commit(ms);
            if (self.ambiguous === 'committed') { self.ambiguous = 'none'; throw new AmbiguousCommitError('injected: committed, answer lost'); }
          };
          return tx;
        };
      },
    }) as OwnerStore;
  }
}

function hooks(): OwnerHooks & { released: Array<[SlotNo, string]> } {
  const h = { released: [] as Array<[SlotNo, string]>,
    async onAcquire() {}, onRelease(s: SlotNo, r: string) { h.released.push([s, r]); }, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {} };
  return h;
}

/** Each test has a hard timeout, so that a hang fails fast. */
const T = { timeout: 30_000 };
/** Every runtime and client that a test opens. afterEach closes them, also when an assertion fails. */
const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of open.splice(0).reverse()) await c().catch(() => {});
});

async function boot(slots: SlotNo[] = [0, 1, 2, 3], publisher: Publisher = new MemoryPublisher()) {
  const pgStore = new PgStore({ connectionString: URL, displacement: {
    table: `${KIND}_displacement`,
    key: (c) => ({ link_id: Buffer.from(c.link).toString('utf8'), request_part: Buffer.from(c.request.subarray(0, c.request.length - 8)), request_seq: Buffer.from(c.request).readBigUInt64BE(c.request.length - 8).toString() }),
  } });
  const faults = new FaultStore(pgStore);
  const load = new ManualLoad();
  const h = hooks();
  const rt = new CockroachOwnerRuntime({ declaration: DECL, store: faults.wrap(), slots, publisher, load, testing: { sessionTimings: FAST },
    log: process.env['ITEST_LOG'] ? (m, f) => console.log(m, f) : undefined });
  let closed = false;
  const close = async (): Promise<void> => { if (closed) return; closed = true; await rt.stop(); await pgStore.close(); };
  open.push(close);
  await rt.start(h);
  for (let i = 0; i < 40 && rt.heldSlots().length < slots.length; i++) await sleep(100);
  return { rt, faults, load, h, pgStore, close };
}

async function q(sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const c = new pg.Client({ connectionString: URL });
  await c.connect();
  try { return (await c.query(sql, params)).rows as Array<Record<string, unknown>>; } finally { await c.end(); }
}

const fresh = (): Uint8Array => utf8(`p-${randomBytes(4).toString('hex')}`);

const KIND2 = `${KIND}x`;
const DECL2: OwnerDeclaration = {
  kind: KIND2, slotCount: 2, slotPositions: true, selfOutboxed: true,
  entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }],
  projections: [],
  streams: [{ name: 'byacct', topic: `${KIND2}.byacct.v1`, key: { field: 'account' }, emitFn: { version: 1 }, closure: 'none', consumers: [] }],
};

test('should migrate the platform tables and the test kind when the suite sets up', { ...T, skip: SKIP }, async () => {
  await migrateKinds(URL, [DECL, DECL2], { presplit: false });
  await migrateKinds(URL, [DECL], { presplit: false });   // idempotent
  const rows = await q('SELECT count(*)::INT4 AS n FROM owner_slot WHERE kind = $1', [KIND]);
  assert.equal(rows[0]?.['n'], 4);
});

test('CP-2 Committed: log, head (batch_id) and outbox in one transaction; chain matches; ts increasing', { ...T, skip: SKIP }, async () => {
  const { rt, close } = await boot();
  const P = fresh();
  const a = await rt.append({ partition: P, entries: [entry('a'), entry('b')] });
  const b = await rt.append({ partition: P, entries: [entry('c')] });
  assert.equal(a.r, 'Committed'); assert.equal(b.r, 'Committed');
  if (a.r !== 'Committed' || b.r !== 'Committed') return;
  assert.equal(compareHlc(a.ts, b.ts), -1);
  const log = await q(`SELECT * FROM ${KIND}_log WHERE partition = $1 ORDER BY seq`, [Buffer.from(P)]);
  assert.deepEqual(log.map((r) => String(r['seq'])), ['1', '2', '3']);
  let chain = chainGenesis(KIND, P);
  for (const r of log) {
    chain = chainNext(chain, { kindName: KIND, partition: P, seq: BigInt(String(r['seq'])), slot: Number(r['slot']), generation: Number(r['generation']),
      epoch: BigInt(String(r['epoch'])), entryKind: Number(r['kind']), schemaV: Number(r['schema_v']), identity: r['identity'] as Buffer,
      emits: r['emits'] as Buffer, retention: Number(r['retention']), keyId: r['key_id'] as Buffer, audit: r['audit'] as Buffer, payload: r['payload'] as Buffer });
    assert.equal(hex(chain), hex(r['chain'] as Buffer));
  }
  const head = await q(`SELECT seq, batch_id, chain FROM ${KIND}_head WHERE partition = $1`, [Buffer.from(P)]);
  assert.equal(String(head[0]?.['seq']), '3');
  assert.equal((head[0]?.['batch_id'] as Buffer).length, 16);
  const ob = await q(`SELECT count(*)::INT4 AS n FROM ${KIND}_outbox WHERE partition = $1`, [Buffer.from(P)]);
  assert.equal(ob[0]?.['n'], 3);
  await close();
});

test('CP-2 ConditionFailed commits the rest of the batch', { ...T, skip: SKIP }, async () => {
  const { rt, close } = await boot();
  const P = fresh();
  const mark: RowRef = { table: `${KIND}_mark`, key: { partition: P, id: 'm' } };
  const up: ProjectionWrite = { table: `${KIND}_mark`, op: 'upsert', key: mark.key, row: {} };
  const first = rt.append({ partition: P, entries: [entry('x')], projections: [up] });
  const second = rt.append({ partition: P, conditions: [{ kind: 'rowAbsent', row: mark, label: 'unmarked' }], entries: [entry('y')] });
  const third = rt.append({ partition: P, entries: [entry('z')] });
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.deepEqual([a.r, b.r, c.r], ['Committed', 'ConditionFailed', 'Committed']);
  await close();
});

test('CP-2 Retry after 5 restarts + 1 fresh attempt; CP-3 decide re-runs with a new ts each time', { ...T, skip: SKIP }, async () => {
  const { rt, faults, close } = await boot();
  const P = fresh();
  faults.retriesAtCommit = 7;
  const seen: string[] = [];
  assert.deepEqual(await rt.append({ partition: P, decide: (ctx) => { seen.push(ctx.ts); return { entries: [entry('r')] }; } }), { r: 'Retry' });
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7);
  assert.equal((await q(`SELECT count(*)::INT4 AS n FROM ${KIND}_log WHERE partition = $1`, [Buffer.from(P)]))[0]?.['n'], 0);
  faults.retriesAtCommit = 2;
  seen.length = 0;
  const r = await rt.append({ partition: P, decide: (ctx) => { seen.push(ctx.ts); return { entries: [entry(`at-${seen.length}`)] }; } });
  assert.equal(r.r, 'Committed');
  const ids = (await q(`SELECT identity FROM ${KIND}_log WHERE partition = $1`, [Buffer.from(P)])).map((x) => (x['identity'] as Buffer).toString());
  assert.deepEqual(ids, ['at-3'], 'nothing from an earlier attempt commits');
  await close();
});

test('CP-2 StaleEpoch: a successor acquisition between the fence read and COMMIT; the stale epoch never commits', { ...T, skip: SKIP }, async () => {
  const { rt, faults, h, close } = await boot();
  const P = fresh();
  const slot = slotOfPartition(P, 4);
  faults.beforeCommit = async () => {
    // The successor's acquisition commits after the fence read. Its high-priority read of the head then pushes
    // the batch above the acquisition, so the batch's fence read fails refresh (40001) and the restart sees the
    // new epoch. (Without the push, CockroachDB can order the batch before the acquisition, which is correct.)
    const c = new pg.Client({ connectionString: URL });
    await c.connect();
    try {
      await c.query('BEGIN PRIORITY HIGH');
      await c.query('UPDATE owner_slot SET epoch = epoch + 1 WHERE kind = $1 AND slot = $2', [KIND, slot]);
      await c.query(`SELECT seq FROM ${KIND}_head WHERE partition = $1`, [Buffer.from(P)]);
      await c.query('COMMIT');
    } finally { await c.end(); }
  };
  assert.deepEqual(await rt.append({ partition: P, entries: [entry('late')] }), { r: 'StaleEpoch' });
  assert.equal((await q(`SELECT count(*)::INT4 AS n FROM ${KIND}_log WHERE partition = $1`, [Buffer.from(P)]))[0]?.['n'], 0);
  assert.ok(h.released.some(([s, r]) => s === slot && r === 'staleEpoch'));
  await close();
});

test('CP-2a Ambiguous: classified by batch_id with the resolution read (committed, and not committed)', { ...T, skip: SKIP }, async () => {
  const { rt, faults, close } = await boot();
  const P = fresh();
  faults.ambiguous = 'committed';
  assert.deepEqual(await rt.append({ partition: P, entries: [entry('a1')] }), { r: 'Ambiguous' });
  const n1 = await rt.append({ partition: P, entries: [entry('a2')] });
  if (n1.r === 'Committed') assert.equal(n1.seqFrom, 2n); else assert.fail(n1.r);
  faults.ambiguous = 'notCommitted';
  assert.deepEqual(await rt.append({ partition: P, entries: [entry('a3')] }), { r: 'Ambiguous' });
  const n2 = await rt.append({ partition: P, entries: [entry('a4')] });
  if (n2.r === 'Committed') assert.equal(n2.seqFrom, 3n); else assert.fail(n2.r);
  await close();
});

test('CP-2 Overloaded only from shedding', { ...T, skip: SKIP }, async () => {
  const { rt, load, close } = await boot();
  load.value = true;
  assert.equal((await rt.append({ partition: fresh(), entries: [entry('o')] })).r, 'Overloaded');
  await close();
});

test('CP-4: exclusive + firstStatement placeholders are intents first; a concurrent displacement read meets them (lockTimeout)', { ...T, skip: SKIP }, async () => {
  // Two partitions in different slots so their lanes run concurrently.
  const L = utf8('link-A');
  let R = fresh();
  while (slotOfPartition(R, 4) === slotOfPartition(L, 4)) R = fresh();
  const { rt, faults, close } = await boot();
  const request = Buffer.concat([Buffer.from('req'), Buffer.alloc(8)]);
  const key = { link_id: 'link-A', request_part: Buffer.from('req'), request_seq: '0' };
  let unblock: () => void = () => {};
  const held = new Promise<void>((r) => { unblock = r; });
  let entered: () => void = () => {};
  const atCommit = new Promise<void>((r) => { entered = r; });
  faults.beforeCommit = async () => { entered(); await held; };
  const cut = rt.append({ partition: L, entries: [entry('cut')] }, {
    exclusive: true, abandonBeforeCommitMs: 5_000,
    firstStatement: [{ table: `${KIND}_displacement`, op: 'upsert', key, row: { attempt: 1, reduction_seq: '1', record_hlc: '0' } }],
  });
  await atCommit;
  const confirm = await rt.append({ partition: R, conditions: [{ kind: 'displacementRead', link: utf8('link-A'), request: new Uint8Array(request), attempt: 1, lockTimeoutMs: 10, label: 'disp' }], entries: [entry('confirm')] });
  assert.deepEqual(confirm, { r: 'ConditionFailed', which: 'lockTimeout' });
  unblock();
  assert.equal((await cut).r, 'Committed');
  const after = await rt.append({ partition: R, conditions: [{ kind: 'displacementRead', link: utf8('link-A'), request: new Uint8Array(request), attempt: 1, lockTimeoutMs: 10, label: 'disp' }], entries: [entry('confirm2')] });
  assert.equal(after.r, 'ConditionFailed', 'the committed marker is found');
  if (after.r === 'ConditionFailed') { assert.equal(after.which, 'disp'); assert.equal(after.displacement?.attempt, 1); }
  // C02 / P1-S78: a marker of ANY attempt fails the condition (here the confirm asks for attempt 2).
  const other = await rt.append({ partition: R, conditions: [{ kind: 'displacementRead', link: utf8('link-A'), request: new Uint8Array(request), attempt: 2, lockTimeoutMs: 10, label: 'disp' }], entries: [entry('confirm3')] });
  assert.equal(other.r, 'ConditionFailed');
  if (other.r === 'ConditionFailed') assert.equal(other.displacement?.attempt, 1, 'the marker attempt is returned');
  await close();
});

test('CP-1: two processes contend for a slot across a pause; one committed writer at a time; seq contiguous', { ...T, skip: SKIP }, async () => {
  const P = fresh();
  const slot = slotOfPartition(P, 4);
  const a = await boot([slot]);
  // A may not get the slot if an earlier test's process still holds it; wait for its expiry.
  for (let i = 0; i < 40 && !a.rt.heldSlots().includes(slot); i++) await sleep(100);
  for (let i = 0; i < 3; i++) assert.equal((await a.rt.append({ partition: P, entries: [entry(`a${i}`)] })).r, 'Committed');
  a.rt.pauseRenewalsForTest();
  const b = await boot([slot]);
  for (let i = 0; i < 60 && !b.rt.heldSlots().includes(slot); i++) await sleep(100);
  assert.ok(b.rt.heldSlots().includes(slot), 'B took the slot after expiry');
  const late = a.rt.append({ partition: P, entries: [entry('a-late')] });
  a.rt.resumeRenewalsForTest();
  assert.equal((await late).r, 'StaleEpoch');
  for (let i = 0; i < 3; i++) assert.equal((await b.rt.append({ partition: P, entries: [entry(`b${i}`)] })).r, 'Committed');
  const log = await q(`SELECT seq, epoch, ts::STRING AS ts, identity FROM ${KIND}_log WHERE partition = $1 ORDER BY seq`, [Buffer.from(P)]);
  assert.deepEqual(log.map((r) => String(r['seq'])), ['1', '2', '3', '4', '5', '6']);
  assert.ok(!log.some((r) => (r['identity'] as Buffer).toString() === 'a-late'));
  await a.close(); await b.close();
});

test('should publish directly to Kafka after Committed (idempotent producer, acks=all) when Kafka is available', { ...T, skip: KAFKA_SKIP }, async () => {
  const publisher = new KafkaPublisher({ brokers: BROKERS, clientId: `${KIND}-holder` });
  const { rt, close } = await boot([0, 1, 2, 3], publisher);
  const kafka = new Kafka({ clientId: 'itest-consumer', brokers: BROKERS, logLevel: logLevel.NOTHING });
  const admin = new KafkaBus({ brokers: BROKERS, clientId: 'itest-admin' });
  try { await admin.ensureTopic(`${KIND}.counter.v1`, 4); } finally { await admin.close(); }
  const consumer = kafka.consumer({ groupId: `itest-${KIND}` });
  await consumer.connect();
  open.push(() => consumer.disconnect());
  await consumer.subscribe({ topic: `${KIND}.counter.v1`, fromBeginning: true });
  const got: string[] = [];
  await consumer.run({ eachMessage: async ({ message }) => { got.push(String(message.headers?.['stream_seq'] ?? '')); } });
  const P = fresh();
  assert.equal((await rt.append({ partition: P, entries: [entry('k1'), entry('k2')] })).r, 'Committed');
  for (let i = 0; i < 100 && got.length < 2; i++) await sleep(100);
  assert.deepEqual(got.sort(), ['1', '2']);
  await consumer.disconnect();
  await close();
});

test('should run the additions (readLog opened with sender fence, listPartitions, slot positions, stream index) with no pg deprecation warning when on the dev cell', { ...T, skip: SKIP }, async () => {
  const warnings: string[] = [];
  const onWarning = (w: Error): void => { warnings.push(w.message); };
  process.on('warning', onWarning);
  const store = new PgStore({ connectionString: URL });
  const rt = new CockroachOwnerRuntime({ declaration: DECL2, store, slots: [0, 1], publisher: new MemoryPublisher(), load: new ManualLoad(), testing: { sessionTimings: FAST } });
  open.push(async () => { await rt.stop(); await store.close(); process.off('warning', onWarning); });
  await rt.start(hooks());
  for (let i = 0; i < 40 && rt.heldSlots().length < 2; i++) await sleep(100);
  const P = fresh();
  const fence = { kind: 'other', partition: utf8('S1'), generation: 0, epoch: 3n };
  const e = (id: string, extra: Partial<EntryInput> = {}): EntryInput => ({ ...entry(id), emits: [{ stream: 'byacct', event: { account: 'a-1' } }], ...extra });
  const r1 = await rt.append({ partition: P, entries: [e('a', { senderFence: fence }), e('b')] });
  const r2 = await rt.append({ partition: P, entries: [e('c')] });
  assert.ok(r1.r === 'Committed' && r2.r === 'Committed');
  if (r1.r === 'Committed' && r2.r === 'Committed') {
    assert.ok(r1.slotPositions && r2.slotPositions);
    assert.equal(r2.slotPositions?.[0], (r1.slotPositions?.[1] ?? 0n) + 1n, 'slot-wide positions are contiguous');
  }
  const rows = await rt.readLog(P);
  assert.deepEqual(rows.map((r) => r.seq), [1n, 2n, 3n]);
  assert.deepEqual(rows[0]?.payload, { id: 'a' });
  assert.equal(rows[0]?.senderFence?.epoch, 3n);
  assert.deepEqual((await rt.listPartitions(slotOfPartition(P, 2))).map(hex), [hex(P)]);
  const idx = await q(`SELECT stream_seq, seq FROM ${KIND2}_stream_index WHERE partition = $1 ORDER BY stream_seq`, [Buffer.from(P)]);
  assert.deepEqual(idx.map((x) => [String(x['stream_seq']), String(x['seq'])]), [['1', '1'], ['2', '2'], ['3', '3']]);
  const ob = await q(`SELECT msg_key FROM ${KIND2}_outbox WHERE partition = $1 LIMIT 1`, [Buffer.from(P)]);
  assert.equal((ob[0]?.['msg_key'] as Buffer).toString(), 'a-1', 'keyed by the declared field');
  assert.deepEqual(warnings.filter((w) => /client\.query\(\) when the client is already executing/.test(w)), []);
});
