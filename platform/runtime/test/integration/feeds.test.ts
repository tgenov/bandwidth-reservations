/**
 * I1b integration tests on the dev cell (CockroachDB + Kafka): changefeed relay and closure emitter (CP-8,
 * with changefeed re-creation), consumer runtime with gap fill and a stop/restart (CP-9 without moves,
 * X2-S02), the marker chain across a takeover (CP-7a), read leases and status readers (CP-7), and the
 * grants conformance job (CP-11). They skip when the dev cell is not reachable, and fail instead with
 * REQUIRE_DEV_CELL=1.
 */
import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { EntryInput, FeedEvent, HlcTs, OwnerDeclaration, OwnerHooks, ReportMarker, SlotNo } from '../../src/index.ts';
import {
  ClosureEmitter, CockroachOwnerRuntime, FeedConsumerRuntime, KafkaBus, ManualLoad, MemoryPublisher, NotClosed, OutboxRelay, PgGapFill,
  PgStore, StatusReader, cancelChangefeeds, compareHlc, decodeClosure, ensureChangefeed, hex, hlc, pgFeedSeqReader, slotOfPartition, utf8,
  DevSealer, homeKey,
} from '../../src/index.ts';
import type { OutboxMessage } from '../../src/index.ts';
import type { Publisher } from '../../src/publisher.ts';
import { checkGrants, migrateKinds } from '@share/owner-migrate';
import { devCellSkip } from '../../testing/dev-cell.ts';

const URL = process.env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';
const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
/** The Kafka sink as the database nodes reach it inside the dev cell. */
const SINK = process.env['CDC_SINK'] ?? 'kafka://kafka1:19092';

function tcp(hostPort: string): Promise<boolean> {
  const [host = 'localhost', port = '0'] = hostPort.split(':');
  return new Promise((resolve) => {
    const s = connect({ host, port: Number(port), timeout: 1_000 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}
const dbUp = await tcp(new globalThis.URL(URL.replace(/^postgresql:/, 'http:')).host || 'localhost:26257');
const kafkaUp = await tcp(BROKERS[0] ?? 'localhost:9092');
const SKIP = devCellSkip(!dbUp ? `CockroachDB at ${URL}` : !kafkaUp ? `Kafka at ${BROKERS[0]}` : undefined);

const R = randomBytes(3).toString('hex');
const LINK = `ilink_${R}`;
const ACCT = `iacct_${R}`;
const LINK_DECL: OwnerDeclaration = {
  kind: LINK, slotCount: 4,
  entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }],
  projections: [],
  streams: [{ name: 'schedule', topic: `${LINK}.schedule.v1`, key: 'partition', emitFn: { version: 1 }, closure: 'closedPerLink', consumers: [ACCT] }],
};
const ACCT_DECL: OwnerDeclaration = {
  kind: ACCT, slotCount: 4, statusReaders: true,
  entryKinds: [{ kind: 1, name: 'outcome', schemaVersions: [1], retention: '7y' }],
  projections: [],
  streams: [{ name: 'outcome', topic: `${ACCT}.outcome.v1`, key: 'slot', emitFn: { version: 1 }, closure: 'none', reportGated: true, consumers: [] }],
};
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const ev = (id: string, stream: string, pending = false): EntryInput => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id },
  emits: [{ stream, event: { id } }], ...(pending ? { pendingAnswered: utf8(id) } : {}) });
const FAST = { sessionTtlMs: 1_500, sessionRenewMs: 200, renewRetryMs: 100, holderViewMs: 1_400, maxLoopDelayMs: 100 };
const T = { timeout: 120_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, ms: number, what = f.toString()): Promise<void> {
  const end = Date.now() + ms;
  while (!(await f())) { if (Date.now() > end) throw new Error(`timed out after ${ms} ms: ${what}`); await sleep(50); }
}
const hooks = (): OwnerHooks & { reportable: SlotNo[] } => {
  const h = { reportable: [] as SlotNo[], async onAcquire() {}, onRelease() {}, onReportable(s: SlotNo) { h.reportable.push(s); },
    onMovedOut() {}, async onAdopt() {}, async onNotification() {} };
  return h;
};

const pool = new pg.Pool({ connectionString: URL, max: 4 });
const open: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of open.splice(0).reverse()) await c().catch(() => {}); });
after(async () => {
  if (!SKIP) { await cancelChangefeeds(pool, LINK).catch(() => {}); await cancelChangefeeds(pool, ACCT).catch(() => {}); }
  await pool.end();
});

async function runtime(decl: OwnerDeclaration, slots: SlotNo[], publisher: Publisher = new MemoryPublisher(), extra: Record<string, unknown> = {}) {
  const store = new PgStore({ connectionString: URL });
  const h = hooks();
  const rt = new CockroachOwnerRuntime({ declaration: decl, store, slots, publisher, load: new ManualLoad(),
    testing: { sessionTimings: FAST, ...extra } });
  let closed = false;
  const close = async (): Promise<void> => { if (closed) return; closed = true; await rt.stop(); await store.close(); };
  open.push(close);
  await rt.start(h);
  await until(() => rt.heldSlots().length === slots.length, 10_000);
  return { rt, store, h, close };
}

function bus(clientId: string): KafkaBus {
  const b = new KafkaBus({ brokers: BROKERS, clientId, metadataMaxAgeMs: 1_000 });
  open.push(() => b.close());
  return b;
}

/** Every record of a topic, read once from the beginning. */
async function readAll(b: KafkaBus, topic: string, expect: (n: number) => boolean, ms = 30_000) {
  const recs: Array<{ partition: number; offset: bigint; headers: Record<string, Uint8Array>; value: Uint8Array | null; key: Uint8Array | null }> = [];
  const sub = await b.subscribe({ groupId: `read-${randomBytes(4).toString('hex')}`, topics: [topic], fromBeginning: true, onRecord: async (r) => { recs.push(r); } });
  try { await until(() => expect(recs.length), ms, `records of ${topic}`); } finally { await sub.stop(); }
  return recs;
}

test('setup: migrate both kinds with grants; topics; changefeeds', { ...T, skip: SKIP }, async () => {
  await migrateKinds(URL, [LINK_DECL, ACCT_DECL], { presplit: false, grants: true });
  const admin = bus('itest-admin');
  await admin.ensureTopic(`cdc.${LINK}`, 2);
  await admin.ensureTopic(`cdc.${ACCT}`, 1);
  await admin.ensureTopic(`${LINK}.schedule.v1`, 4);
  await admin.ensureTopic(`${LINK}.schedule.v1.closure`, 4);
  await admin.ensureTopic(`${ACCT}.outcome.v1`, 2);
  await admin.ensureTopic(`relay.progress.${LINK}`, 1, { compacted: true });
  await admin.ensureTopic(`relay.progress.${ACCT}`, 1, { compacted: true });
  await ensureChangefeed(pool, LINK, { sinkUri: SINK });
  await ensureChangefeed(pool, ACCT, { sinkUri: SINK });
  assert.equal((await pool.query(`SELECT count(*)::INT4 AS n FROM owner_slot WHERE kind = $1`, [`closure_${LINK}`])).rows[0].n, 1);
});

test('CP-8 on the cell: relay + closure emitter; markers never precede a row at or below them, across changefeed re-creation', { ...T, skip: SKIP }, async () => {
  const { rt, store } = await runtime(LINK_DECL, [0, 1, 2, 3]);
  const relay = new OutboxRelay({ bus: bus(`${LINK}-relay`), kind: LINK });
  await relay.start();
  open.push(() => relay.stop());
  const emitter = new ClosureEmitter({ bus: bus(`closure-emitter-${LINK}`), declaration: LINK_DECL, store, feedSeqs: pgFeedSeqReader(pool),
    pollMs: 200, heartbeatMs: 60_000, sessionTimings: FAST });
  await emitter.start();
  open.push(() => emitter.stop());
  const links = ['A', 'B', 'C'].map((x) => utf8(`${R}-${x}`));
  let last: HlcTs | undefined;
  for (let i = 0; i < 3; i++) for (const l of links) {
    const r = await rt.append({ partition: l, entries: [ev(`${hex(l)}-${i}`, 'schedule')] });
    assert.equal(r.r, 'Committed');
    if (r.r === 'Committed') last = r.ts;
  }
  await until(() => { const x = emitter.rMin(); return x !== undefined && last !== undefined && compareHlc(x, last) >= 0; }, 60_000, 'R_min passes the last commit');
  // Re-create the changefeed from R_min (no gap), then append more.
  const R1 = emitter.rMin() as HlcTs;
  await cancelChangefeeds(pool, LINK);
  await ensureChangefeed(pool, LINK, { sinkUri: SINK, cursor: R1 });
  for (const l of links) { const r = await rt.append({ partition: l, entries: [ev(`${hex(l)}-late`, 'schedule')] }); if (r.r === 'Committed') last = r.ts; }
  await until(() => compareHlc(emitter.rMin() as HlcTs, last as HlcTs) >= 0, 60_000, 'R_min after re-creation');
  assert.ok(compareHlc(emitter.rMin() as HlcTs, R1) > 0, 'R_min never goes back');
  const reader = bus('itest-reader');
  const data = await readAll(reader, `${LINK}.schedule.v1`, (n) => n >= 12);
  for (const m of emitter.emitted) {
    for (const r of data.filter((d) => d.partition === m.partition)) {
      const ts = hlc(Buffer.from(r.headers['ts'] ?? []).toString());
      if (compareHlc(ts, m.resolved) <= 0) assert.ok(r.offset < m.dataHighWater, `row at ${r.partition}/${r.offset} (ts ≤ ${m.resolved}) below dataHighWater ${m.dataHighWater}`);
    }
  }
  const closed = (await readAll(reader, `${LINK}.schedule.v1.closure`, (n) => n >= 3)).map((r) => decodeClosure(r.value as Uint8Array));
  for (const l of links) {
    const top = closed.filter((c) => c.type === 'closed' && hex(c.m.link) === hex(l)).map((c) => (c.type === 'closed' ? c.m.feedSeq : 0n));
    assert.ok(top.includes(4n), `CLOSED with feed_seq 4 for ${hex(l)}`);
  }
});

/** A publisher that drops the direct publish of some stream_seqs (gap fill or the relay must cover them). */
class Lossy implements Publisher {
  readonly inner: Publisher;
  readonly drop = new Set(['2', '4', '8']);
  constructor(inner: Publisher) { this.inner = inner; }
  async publish(ms: OutboxMessage[]): Promise<void> {
    await this.inner.publish(ms.filter((m) => !this.drop.has(String(m.headers['stream_seq']))));
  }
  async close(): Promise<void> { await this.inner.close(); }
}

test('X2-S02 + CP-9: a consumer that stops and restarts applies every event in stream_seq order, no gap, no duplicate (gap fill from the outbox)', { ...T, skip: SKIP }, async () => {
  const { KafkaPublisher } = await import('../../src/index.ts');
  const { rt } = await runtime(LINK_DECL, [0, 1, 2, 3], new Lossy(new KafkaPublisher({ brokers: BROKERS, clientId: `${LINK}-holder` })));
  const applied = new Map<string, bigint[]>();
  const gapFill = new PgGapFill({ pool, read: 'present' });
  const groupId = `${ACCT}-x2s02`;
  const start = async (positions: Array<{ partition: Uint8Array; stream: string; streamSeq: bigint }>) => {
    const c = new FeedConsumerRuntime({ bus: bus(`${ACCT}-consumer`), groupId, sealer: new DevSealer(), gapFill, gapTimeoutMs: 1_000 });
    c.subscribe(`${LINK}.schedule.v1`, { positions }, 'committed', async (e: FeedEvent) => {
      const k = hex(e.headers.partition);
      applied.set(k, [...(applied.get(k) ?? []), BigInt(e.headers.stream_seq as string)]);
    });
    await c.ready();
    return c;
  };
  const parts = ['P', 'Q'].map((x) => utf8(`${R}-x2-${x}`));
  let c = await start([]);
  for (let i = 0; i < 6; i++) for (const p of parts) assert.equal((await rt.append({ partition: p, entries: [ev(`${hex(p)}-${i}`, 'schedule')] })).r, 'Committed');
  await until(() => parts.every((p) => (applied.get(hex(p)) ?? []).length === 6), 60_000, 'phase 1 applied (gap fill covers dropped publishes)');
  // Stop the consumer (a short stop), append while it is down, restart from its checkpoint.
  // The relay (the guaranteed path) runs from now on.
  await c.stop();
  const relay = new OutboxRelay({ bus: bus(`${LINK}-relay`), kind: LINK });
  await relay.start();
  open.push(() => relay.stop());
  for (let i = 6; i < 12; i++) for (const p of parts) assert.equal((await rt.append({ partition: p, entries: [ev(`${hex(p)}-${i}`, 'schedule')] })).r, 'Committed');
  await sleep(1_000);
  c = await start(parts.map((p) => ({ partition: p, stream: 'schedule', streamSeq: BigInt((applied.get(hex(p)) ?? []).length) })));
  await until(() => parts.every((p) => (applied.get(hex(p)) ?? []).length >= 12), 60_000, 'phase 2 applied');
  await sleep(500);
  for (const p of parts) assert.deepEqual(applied.get(hex(p)), Array.from({ length: 12 }, (_, i) => BigInt(i + 1)), 'every event once, in order');
  await c.stop();
});

test('CP-7a on the cell: the marker chain across a takeover (prev = owner_slot.report_through), rule 7, onMarker gets every marker', { ...T, skip: SKIP }, async () => {
  const P = utf8(`${R}-acct`);
  const S = slotOfPartition(P, 4);
  const { KafkaPublisher } = await import('../../src/index.ts');
  const a = await runtime(ACCT_DECL, [S], new KafkaPublisher({ brokers: BROKERS, clientId: `${ACCT}-holder` }), { postAcquisitionWaitMs: 500 });
  await until(() => a.rt.markersWritten.length >= 1, 10_000, 'A first marker');
  assert.equal((await a.rt.append({ partition: P, entries: [ev('q1', 'outcome', true), ev('n1', 'outcome')] })).r, 'Committed');
  await until(() => a.rt.markersWritten.some((m) => m.pendingAnswered.length > 0), 10_000, 'A covering marker');
  const aLast = a.rt.markersWritten[a.rt.markersWritten.length - 1] as ReportMarker;
  assert.deepEqual(aLast.pendingAnswered.map((x) => Buffer.from(x).toString()), ['q1']);
  // A stalls its report position with a reader lease, commits q2, then stops renewing ("crashes").
  a.rt.attachReader('stuck', { apply: async () => aLast.reportPosition });
  const renew = () => a.rt.grantReadLease({ slot: S, readerId: 'stuck', appliedThrough: aLast.reportPosition, sendMonotonic: process.hrtime.bigint() });
  assert.ok(renew().granted);
  const keep = setInterval(renew, 100);
  assert.equal((await a.rt.append({ partition: P, entries: [ev('q2', 'outcome', true)] })).r, 'Committed');
  a.rt.pauseRenewalsForTest();
  const b = await runtime(ACCT_DECL, [S], new KafkaPublisher({ brokers: BROKERS, clientId: `${ACCT}-holder` }), { postAcquisitionWaitMs: 500 });
  clearInterval(keep);
  await until(() => b.rt.markersWritten.length >= 1, 10_000, 'B first marker');
  const bFirst = b.rt.markersWritten[0] as ReportMarker;
  const row = (await pool.query(`SELECT report_through::STRING AS rt, marker_seq FROM owner_slot WHERE kind = $1 AND slot = $2`, [ACCT, S])).rows[0];
  assert.equal(bFirst.prevReportPosition, aLast.reportPosition, 'prev = the predecessor\'s last marker');
  assert.ok(bFirst.pendingAnswered.map((x) => Buffer.from(x).toString()).includes('q2'), 'rule 7: the successor lists q2');
  assert.equal(hlc(String(row.rt)), b.rt.markersWritten[b.rt.markersWritten.length - 1]?.reportPosition);
  // The marker rows in the outbox chain without a gap or overlap.
  const ms = await pool.query(`SELECT stream_seq FROM ${ACCT}_outbox WHERE slot = $1 AND partition = ''::BYTES ORDER BY stream_seq`, [S]);
  assert.deepEqual(ms.rows.map((x) => Number(x.stream_seq)), Array.from({ length: ms.rows.length }, (_, i) => i + 1));
  assert.equal(Number(row.marker_seq), ms.rows.length);
  // onMarker on Kafka gets every marker (direct publish of both holders).
  const got = new Set<string>();
  const c = new FeedConsumerRuntime({ bus: bus(`${ACCT}-notifier`), groupId: `${ACCT}-notifier`, sealer: new DevSealer() });
  c.onMarker(`${ACCT}.outcome.v1` as 'account.outcome.v1', async (m) => { got.add(`${m.epoch}|${m.reportPosition}|${m.chunk.part}`); });
  await c.ready();
  open.push(() => c.stop());
  const all = [...a.rt.markersWritten, ...b.rt.markersWritten].map((m) => `${m.epoch}|${m.reportPosition}|${m.chunk.part}`);
  await until(() => all.every((k) => got.has(k)), 60_000, 'onMarker got every marker');
});

test('CP-7 on the cell: status reader leases; leasedRead at ≥ P_grant; a lapse ends the lease (NotClosed) before the holder view ends; rule 3', { ...T, skip: SKIP }, async () => {
  const P = utf8(`${R}-sr`);
  const S = slotOfPartition(P, 4);
  const a = await runtime(ACCT_DECL, [S], new MemoryPublisher(), { postAcquisitionWaitMs: 500 });
  const c = await a.rt.append({ partition: P, entries: [ev('s1', 'outcome')] });
  assert.equal(c.r, 'Committed');
  const reader = new StatusReader({ readerId: 'sr-1', kind: ACCT, pool, slotOf: (p) => slotOfPartition(p, 4), holderOf: (s) => (s === S ? a.rt : undefined) });
  reader.start([S]);
  open.push(async () => reader.stop());
  await until(() => reader.readLease(S).valid, 10_000, 'lease granted after the reporting wait');
  const l = reader.readLease(S);
  assert.ok(c.r === 'Committed' && compareHlc(l.pGrant, c.ts) >= 0, 'P_grant at or above the catch-up read and the commit');
  const head = { table: `${ACCT}_head`, key: { home_key: homeKey(P), partition: P } };
  const rows = await reader.leasedRead(P, [head]);
  assert.equal(String((rows[0] as Record<string, unknown>)['seq']), '1');
  assert.equal((await reader.replicaRule3Check(S, utf8('req'))).holderLive, true);
  a.rt.pauseRenewalsForTest();
  await until(() => !reader.readLease(S).valid, 3_000, 'the lease ends with the holder view');
  await assert.rejects(reader.leasedRead(P, [head]), NotClosed);
  await until(async () => !(await reader.replicaRule3Check(S, utf8('req'))).holderLive, 5_000, 'rule 3 sees the session expired');
  a.rt.resumeRenewalsForTest();
});

test('CP-11: the grants conformance job is clean, then finds UPDATE on a log table and a placement UPDATE on owner_slot', { ...T, skip: SKIP }, async () => {
  const clean = await checkGrants(pool, [LINK_DECL, ACCT_DECL]);
  assert.deepEqual(clean.violations, []);
  assert.ok(clean.warnings.some((w) => /row-level security/.test(w)), 'RLS gap reported on 24.3');
  await pool.query(`GRANT UPDATE ON TABLE ${LINK}_log TO ${LINK}`);
  await pool.query(`GRANT UPDATE ON TABLE owner_slot TO placement`);
  try {
    const bad = await checkGrants(pool, [LINK_DECL, ACCT_DECL]);
    assert.ok(bad.violations.some((v) => v.startsWith(`CP-11: UPDATE on log table ${LINK}_log`)), bad.violations.join('\n'));
    assert.ok(bad.violations.some((v) => /placement may change only stops_version/.test(v)));
  } finally {
    await pool.query(`REVOKE UPDATE ON TABLE ${LINK}_log FROM ${LINK}`);
    await pool.query(`REVOKE UPDATE ON TABLE owner_slot FROM placement`);
  }
  // Placement's Stop path: only stops_version, through the definer function.
  const before = (await pool.query(`SELECT stops_version FROM owner_slot WHERE kind = $1 AND slot = 0`, [LINK])).rows[0].stops_version;
  await pool.query(`SELECT placement_set_stops_version($1, 0)`, [LINK]);
  const afterV = (await pool.query(`SELECT stops_version FROM owner_slot WHERE kind = $1 AND slot = 0`, [LINK])).rows[0].stops_version;
  assert.equal(BigInt(afterV), BigInt(before) + 1n);
});
