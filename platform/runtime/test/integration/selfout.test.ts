/**
 * S-PLAT-I2 exit criterion (4) on the dev cell: a self-outboxed test kind with three streams passes CP-8 and
 * CP-9 (the clauses of I1). The changefeed runs on `<kind>_log`; the relay derives the events; gap fill reads
 * the log through `<kind>_stream_index`. The tests use their own database and their own topic names, and
 * cancel their changefeeds at the end. They skip when the dev cell is not reachable, and fail instead with
 * REQUIRE_DEV_CELL=1.
 */
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { EmitFunctions, EntryInput, FeedEvent, HlcTs, OwnerDeclaration, OwnerHooks } from '../../src/index.ts';
import {
  ClosureEmitter, CockroachOwnerRuntime, DevSealer, FeedConsumerRuntime, KafkaBus, KafkaPublisher, LogDerivedGapFill, ManualLoad,
  OutboxRelay, PgStore, cancelChangefeeds, compareHlc, ensureChangefeed, hex, hlc, pgFeedSeqReader, pgStreamIndex, utf8,
} from '../../src/index.ts';
import type { OutboxMessage } from '../../src/index.ts';
import type { Publisher } from '../../src/publisher.ts';
import { migrateKinds } from '@share/owner-migrate';
import { createTestDatabase, devCellSkip } from '../../testing/dev-cell.ts';

const URL = process.env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';
const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
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
const KIND = `iself_${R}`;
const DECL: OwnerDeclaration = {
  kind: KIND, slotCount: 4, selfOutboxed: true,
  entryKinds: [{ kind: 1, name: 'row', schemaVersions: [1], retention: '7y' }],
  projections: [],
  streams: [
    { name: 'handoff', topic: `${KIND}.handoff.v1`, key: 'partition', emitFn: { version: 1 }, closure: 'resolved', consumers: ['iattr'] },
    { name: 'drop_alert', topic: `${KIND}.alert.v1`, key: 'partition', emitFn: { version: 1 }, closure: 'none', consumers: [] },
    { name: 'drop_report', topic: `${KIND}.alert.v1`, key: 'partition', emitFn: { version: 1 }, closure: 'none', consumers: [] },
  ],
};
type Row = { type: 'batch' | 'drop' | 'report'; id: string };
const asRow = (p: unknown): Row => p as Row;
const EMIT: EmitFunctions = {
  handoff: { 1: (e) => (asRow(e.payload).type === 'batch' ? [{ batch: asRow(e.payload).id }] : []) },
  drop_alert: { 1: (e) => (asRow(e.payload).type === 'drop' ? [{ dropped: asRow(e.payload).id }] : []) },
  drop_report: { 1: (e) => (asRow(e.payload).type === 'report' ? [{ report: asRow(e.payload).id }] : []) },
};
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const STREAM_OF = { batch: 'handoff', drop: 'drop_alert', report: 'drop_report' } as const;
function entry(type: Row['type'], id: string): EntryInput {
  const event = type === 'batch' ? { batch: id } : type === 'drop' ? { dropped: id } : { report: id };
  return { kind: 1, schemaV: 1, identity: utf8(`${type}-${id}`), audit: AUDIT, payload: { type, id }, emits: [{ stream: STREAM_OF[type], event }] };
}
const FAST = { sessionTtlMs: 1_500, sessionRenewMs: 200, renewRetryMs: 100, holderViewMs: 1_400, maxLoopDelayMs: 100 };
const T = { timeout: 120_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, ms: number, what = f.toString()): Promise<void> {
  const end = Date.now() + ms;
  while (!(await f())) { if (Date.now() > end) throw new Error(`timed out after ${ms} ms: ${what}`); await sleep(50); }
}
const hooks = (): OwnerHooks => ({ async onAcquire() {}, onRelease() {}, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {} });

let db: { name: string; url: string; drop: () => Promise<void> } | undefined;
let pool: pg.Pool | undefined;
const open: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of open.splice(0).reverse()) await c().catch(() => {}); });
before(async () => {
  if (SKIP) return;
  db = await createTestDatabase(URL, 'iselfout');
  pool = new pg.Pool({ connectionString: db.url, max: 4 });
  await migrateKinds(db.url, [DECL], { presplit: false, grants: true });
  const admin = new KafkaBus({ brokers: BROKERS, clientId: 'iself-admin', metadataMaxAgeMs: 1_000 });
  try {
    await admin.ensureTopic(`cdc.${KIND}`, 2);
    await admin.ensureTopic(`${KIND}.handoff.v1`, 4);
    await admin.ensureTopic(`${KIND}.handoff.v1.closure`, 4);
    await admin.ensureTopic(`${KIND}.alert.v1`, 2);
    await admin.ensureTopic(`relay.progress.${KIND}`, 1, { compacted: true });
  } finally { await admin.close(); }
  await ensureChangefeed(pool, KIND, { sinkUri: SINK, table: 'log' });
}, { timeout: 180_000 });
after(async () => {
  if (pool) { await cancelChangefeeds(pool, KIND, 'log').catch(() => {}); await pool.end(); }
  await db?.drop();
}, { timeout: 180_000 });

function bus(clientId: string): KafkaBus {
  const b = new KafkaBus({ brokers: BROKERS, clientId, metadataMaxAgeMs: 1_000 });
  open.push(() => b.close());
  return b;
}

async function runtime(publisher: Publisher) {
  if (!db) throw new Error('no test database');
  const store = new PgStore({ connectionString: db.url });
  const rt = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], publisher, load: new ManualLoad(), emitFns: EMIT,
    testing: { sessionTimings: FAST } });
  open.push(async () => { await rt.stop(); await store.close(); });
  await rt.start(hooks());
  await until(() => rt.heldSlots().length === 4, 10_000);
  return { rt, store };
}

/** Drops the direct publish of some stream_seqs, so the relay or the gap fill must give them. */
class Lossy implements Publisher {
  readonly inner: Publisher;
  readonly drop: Set<string>;
  constructor(inner: Publisher, drop: string[]) { this.inner = inner; this.drop = new Set(drop); }
  async publish(ms: OutboxMessage[]): Promise<void> { await this.inner.publish(ms.filter((m) => !this.drop.has(String(m.headers['stream_seq'])))); }
  async close(): Promise<void> { await this.inner.close(); }
}

test('C01 CP-9 self-outboxed on the cell: gap fill through the stream index fills dropped direct publishes; the relay copies are byte-identical; each stream in order, once', { ...T, skip: SKIP }, async () => {
  if (!pool) throw new Error('no pool');
  const { rt } = await runtime(new Lossy(new KafkaPublisher({ brokers: BROKERS, clientId: `${KIND}-holder` }), ['2', '4']));
  const derive = { declaration: DECL, sealer: new DevSealer(), emitFns: EMIT };
  const gapFill = new LogDerivedGapFill(pgStreamIndex(pool, 'present'), [derive]);
  const applied = new Map<string, FeedEvent[]>();
  const alerts: unknown[] = [];
  const c = new FeedConsumerRuntime({ bus: bus('iattr-consumer'), groupId: `iattr-${R}`, sealer: new DevSealer(), gapFill, gapTimeoutMs: 1_000,
    alert: (a) => alerts.push(a) });
  for (const topic of [`${KIND}.handoff.v1`, `${KIND}.alert.v1`]) {
    c.subscribe(topic, { positions: [] }, 'committed', async (e) => {
      const k = `${hex(e.headers.partition)}|${e.headers.stream}`;
      applied.set(k, [...(applied.get(k) ?? []), e]);
    });
  }
  open.push(() => c.stop());
  await c.ready();
  const parts = ['P', 'Q'].map((x) => utf8(`${R}-${x}`));
  for (let i = 0; i < 5; i++) for (const p of parts) {
    assert.equal((await rt.append({ partition: p, entries: [entry('batch', `${i}`), entry('drop', `${i}`), entry('report', `${i}`)] })).r, 'Committed');
  }
  const key = (p: Uint8Array, s: string) => `${hex(p)}|${s}`;
  await until(() => parts.every((p) => Object.values(STREAM_OF).every((s) => (applied.get(key(p, s)) ?? []).length >= 5)), 60_000, 'all applied (gap fill)');
  // Now the relay runs too: it sends every event again. The consumer drops the copies; each relay copy is byte-identical.
  const relay = new OutboxRelay({ bus: bus(`${KIND}-relay`), kind: KIND, derive });
  await relay.start();
  open.push(() => relay.stop());
  await until(() => relay.stats.rows >= 30, 60_000, 'the relay derived all 30 events');
  await sleep(500);
  for (const p of parts) for (const s of Object.values(STREAM_OF)) {
    const got = applied.get(key(p, s)) ?? [];
    assert.deepEqual(got.map((e) => e.headers.stream_seq), ['1', '2', '3', '4', '5'], `${s} of ${hex(p)} once, in order`);
  }
  assert.deepEqual(alerts, [], 'no FEED_CONTENT_CONFLICT: the relay and gap-fill copies equal the direct copies byte for byte');
  assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::INT4 AS n FROM ${KIND}_stream_index`)).rows[0]?.n, 30);
  assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::INT4 AS n FROM [SHOW TABLES] WHERE table_name = $1`, [`${KIND}_outbox`])).rows[0]?.n, 0, 'no outbox table');
});

test('C01 CP-8 self-outboxed on the cell: relay over the log changefeed + closure emitter; markers never precede a row at or below them; R_min never goes back', { ...T, skip: SKIP }, async () => {
  if (!pool) throw new Error('no pool');
  const { rt, store } = await runtime(new KafkaPublisher({ brokers: BROKERS, clientId: `${KIND}-holder` }));
  const relay = new OutboxRelay({ bus: bus(`${KIND}-relay`), kind: KIND, groupId: `${KIND}-relay-cp8`, derive: { declaration: DECL, sealer: new DevSealer(), emitFns: EMIT } });
  await relay.start();
  open.push(() => relay.stop());
  const emitter = new ClosureEmitter({ bus: bus(`closure-emitter-${KIND}`), declaration: DECL, store, feedSeqs: pgFeedSeqReader(pool),
    pollMs: 200, heartbeatMs: 60_000, sessionTimings: FAST });
  await emitter.start();
  open.push(() => emitter.stop());
  const exporters = ['A', 'B', 'C'].map((x) => utf8(`${R}-cp8-${x}`));
  let last: HlcTs | undefined;
  const seen: HlcTs[] = [];
  for (let i = 0; i < 3; i++) for (const e of exporters) {
    const r = await rt.append({ partition: e, entries: [entry('batch', `cp8-${i}`)] });
    assert.equal(r.r, 'Committed');
    if (r.r === 'Committed') last = r.ts;
    const x = emitter.rMin();
    if (x !== undefined) seen.push(x);
  }
  await until(() => { const x = emitter.rMin(); if (x !== undefined) seen.push(x); return x !== undefined && last !== undefined && compareHlc(x, last) >= 0; },
    60_000, 'R_min passes the last commit');
  for (let i = 1; i < seen.length; i++) assert.ok(compareHlc(seen[i] as HlcTs, seen[i - 1] as HlcTs) >= 0, 'R_min never goes back');
  const reader = bus('iself-reader');
  const recs: Array<{ partition: number; offset: bigint; headers: Record<string, Uint8Array> }> = [];
  const sub = await reader.subscribe({ groupId: `read-${randomBytes(4).toString('hex')}`, topics: [`${KIND}.handoff.v1`], fromBeginning: true, onRecord: async (r) => { recs.push(r); } });
  const mine = () => recs.filter((r) => Buffer.from(r.headers['partition'] ?? []).toString().startsWith(`${R}-cp8-`));
  try { await until(() => new Set(mine().map((r) => `${Buffer.from(r.headers['partition'] ?? []).toString()}|${Buffer.from(r.headers['stream_seq'] ?? []).toString()}`)).size >= 9, 30_000); } finally { await sub.stop(); }
  assert.ok(emitter.emitted.length > 0, 'resolved markers were written');
  for (const m of emitter.emitted) {
    for (const r of recs.filter((d) => d.partition === m.partition)) {
      const ts = hlc(Buffer.from(r.headers['ts'] ?? []).toString());
      if (compareHlc(ts, m.resolved) <= 0) assert.ok(r.offset < m.dataHighWater, `row at ${r.partition}/${r.offset} (ts ≤ ${m.resolved}) below dataHighWater ${m.dataHighWater}`);
    }
  }
});
