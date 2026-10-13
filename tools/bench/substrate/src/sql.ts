/**
 * The SQL of one slot batch (RFC-006 §4.3; C01 §3.2), as platform/runtime/src/store/pg.ts sends it, and of the
 * setup. Every statement that differs between CockroachDB and YugabyteDB comes from `DIALECTS`: that is the one
 * switch. The rest is portable PostgreSQL-wire SQL.
 */
import type { Flavour, StmtMode } from './config.ts';
import type { Call } from './lane.ts';
import { KIND, homeKeyOf, partitionKey, requestIdOf, type BatchWrites } from './plan.ts';
import { reverseBits20 } from '../../../../platform/runtime/src/home.ts';

/** One statement with its parameters. */
export interface Stmt {
  text: string;
  values: unknown[];
}

/** What differs between the two databases. */
export interface Dialect {
  flavour: Flavour;
  /** BEGIN (serialisable; the session sets the statement and idle timeouts) and, on CockroachDB, the restart savepoint. */
  begin: string[];
  /** The restart of the client-side retry protocol; null where no restart keeps the intents. */
  restart: string | null;
  restartMode: 'savepoint' | 'fresh';
  /** SET LOCAL statement_timeout = backstop (C01 §7, M1), then the commit. */
  commit(backstopMs: number): string[];
  /** The batch's `ts`, shared by its partitions. */
  tsRead: string;
  bytesType: string;
  /** An upsert of `cols` with conflict key `key`, given the VALUES list. */
  upsert(table: string, cols: string[], key: string[], values: string): string;
  /** Range splits by slot (RFC-006 §3.6); empty where the database splits by itself. */
  presplit: boolean;
}

const setTimeout = (ms: number): string => `SET LOCAL statement_timeout = '${Math.max(1, Math.floor(ms))}ms'`;

export const DIALECTS: Record<Flavour, Dialect> = {
  crdb: {
    flavour: 'crdb',
    begin: ['BEGIN', 'SAVEPOINT cockroach_restart'],
    restart: 'ROLLBACK TO SAVEPOINT cockroach_restart',
    restartMode: 'savepoint',
    commit: (ms) => [setTimeout(ms), 'RELEASE SAVEPOINT cockroach_restart', 'COMMIT'],
    tsRead: 'SELECT cluster_logical_timestamp()::STRING AS ts',
    bytesType: 'BYTES',
    upsert: (table, cols, _key, values) => `UPSERT INTO ${table} (${cols.join(', ')}) VALUES ${values}`,
    presplit: true,
  },
  yugabyte: {
    flavour: 'yugabyte',
    begin: ['BEGIN ISOLATION LEVEL SERIALIZABLE'],
    restart: null,
    restartMode: 'fresh',
    commit: (ms) => [setTimeout(ms), 'COMMIT'],
    // No cluster_logical_timestamp(): the transaction timestamp in ns stands in for the HLC `ts`.
    tsRead: 'SELECT ((extract(epoch FROM transaction_timestamp()) * 1000000000)::DECIMAL)::TEXT AS ts',
    bytesType: 'BYTEA',
    upsert: (table, cols, key, values) => `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${values} ON CONFLICT (${key.join(', ')}) DO UPDATE SET `
      + cols.filter((c) => !key.includes(c)).map((c) => `${c} = EXCLUDED.${c}`).join(', '),
    presplit: false,
  },
};

interface Col { name: string; cast?: string }
const cols = (...names: string[]): Col[] => names.map((n) => (n === 'ts' ? { name: n, cast: 'DECIMAL' } : { name: n }));
const LOG_COLS = cols('slot', 'partition', 'seq', 'generation', 'epoch', 'kind', 'schema_v', 'ts', 'identity', 'emits', 'audit', 'retention', 'key_id', 'payload', 'chain');
const OUTBOX_COLS = cols('slot', 'partition', 'stream', 'stream_seq', 'n', 'topic', 'msg_key', 'headers', 'payload', 'ts', 'generation', 'epoch');
const HEAD_COLS = cols('home_key', 'partition', 'slot', 'generation', 'adopted', 'seq', 'ts', 'epoch', 'streams', 'chain', 'batch_id');
const PROJECTION_COLS = cols('partition', 'request_id', 'state', 'body', 'ts');
/** Rows in one multi-row statement (platform/runtime/src/store/pg.ts WRITE_CHUNK). */
const WRITE_CHUNK = 200;

export const TABLES = { log: `${KIND}_log`, head: `${KIND}_head`, outbox: `${KIND}_outbox`, projection: `${KIND}_requests` };

/** A value as `pg` sends it: bytes as a Buffer, bigint as text. */
export function toPg(v: unknown): unknown {
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(toPg);
  return v;
}

/** "($1, $2::DECIMAL, …), (…)" for `rows` rows of `c`, numbered from `offset` + 1. */
function valuesList(c: Col[], rows: number, offset = 0): string {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    out.push(`(${c.map((col, i) => `$${offset + r * c.length + i + 1}${col.cast ? `::${col.cast}` : ''}`).join(', ')})`);
  }
  return out.join(', ');
}

function chunked<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** The reads of one attempt, in the order of platform/runtime/src/batch/attempt.ts (lines 115-152). */
export function readStatements(d: Dialect, o: { slot: number; slots: number; timingRead: boolean; calls: Call[] }): {
  fence: Stmt; timing: Stmt | null; heads: Stmt; conditions: Stmt; ts: Stmt;
} {
  const parts = [...new Set(o.calls.map((c) => c.partition))];
  const condValues: unknown[] = [];
  for (const c of o.calls) condValues.push(toPg(partitionKey(o.slot, c.partition)), toPg(requestIdOf(o.slot, c)));
  return {
    // The fence (RFC-006 §4.3): the epoch must equal the holder's.
    fence: { text: `SELECT epoch, stops_version, report_through::TEXT AS report_through, marker_seq FROM owner_slot WHERE kind = '${KIND}' AND slot = $1`, values: [o.slot] },
    // τ for tsBefore conditions (RFC-006 §6.4); the runtime reads it in every batch (attempt.ts line 123).
    timing: o.timingRead ? { text: 'SELECT version, epsilon_ms, delta_x_ms, tau_ms FROM platform_timing WHERE shard = $1', values: [o.slot % 64] } : null,
    heads: {
      text: `SELECT home_key, partition, slot, generation, adopted, seq, ts::TEXT AS ts, epoch, streams, chain, batch_id FROM ${TABLES.head}`
        + ` WHERE home_key = ANY($1::INT4[]) AND partition = ANY($2::${d.bytesType}[])`,
      values: [parts.map((p) => homeKeyOf(o.slot, p, o.slots)), parts.map((p) => toPg(partitionKey(o.slot, p)))],
    },
    // Each call's condition row: rowAbsent on its request (a second deciding entry cannot commit, RFC-000 §5.5).
    conditions: { text: `SELECT partition, request_id FROM ${TABLES.projection} WHERE (partition, request_id) IN (${valuesList(cols('partition', 'request_id'), o.calls.length)})`, values: condValues },
    ts: { text: d.tsRead, values: [] },
  };
}

function rowValues(c: Col[], row: Record<string, unknown>): unknown[] {
  return c.map((col) => toPg(row[col.name]));
}

/** The writes of one attempt. `per-row` sends one statement per log, outbox and head row, as store/pg.ts does. */
export function writeStatements(d: Dialect, w: BatchWrites, slot: number, mode: StmtMode): Stmt[] {
  const log = w.log.map((r) => ({
    slot: r.slot, partition: r.partition, seq: r.seq, generation: r.generation, epoch: r.epoch, kind: r.kind, schema_v: r.schemaV,
    ts: w.ts, identity: r.identity, emits: r.emits, audit: r.audit, retention: r.retention, key_id: r.keyId, payload: r.payload, chain: r.chain,
  }));
  const outbox = w.outbox.map((r) => ({
    slot: r.slot, partition: r.partition, stream: r.stream, stream_seq: r.streamSeq, n: r.n, topic: r.topic, msg_key: r.msgKey,
    headers: r.headers, payload: r.payload, ts: w.ts, generation: r.generation, epoch: r.epoch,
  }));
  const heads = w.heads.map((h) => ({
    home_key: h.homeKey, partition: h.partition, slot: h.slot, generation: h.generation, adopted: h.adopted, seq: h.seq, ts: w.ts,
    epoch: h.epoch, streams: h.streams, chain: h.chain, batch_id: h.batchId,
  }));
  const projections = w.projections.map((p) => ({ partition: p.partition, request_id: p.requestId, state: p.state, body: p.body, ts: w.ts }));

  const insert = (table: string, c: Col[], rows: Array<Record<string, unknown>>): Stmt => ({
    text: `INSERT INTO ${table} (${c.map((x) => x.name).join(', ')}) VALUES ${valuesList(c, rows.length)}`,
    values: rows.flatMap((r) => rowValues(c, r)),
  });
  const upsert = (table: string, c: Col[], key: string[], rows: Array<Record<string, unknown>>): Stmt => ({
    text: d.upsert(table, c.map((x) => x.name), key, valuesList(c, rows.length)),
    values: rows.flatMap((r) => rowValues(c, r)),
  });
  const size = mode === 'per-row' ? 1 : WRITE_CHUNK;
  const out: Stmt[] = [
    ...chunked(log, size).map((rows) => insert(TABLES.log, LOG_COLS, rows)),
    ...chunked(outbox, size).map((rows) => insert(TABLES.outbox, OUTBOX_COLS, rows)),
    ...chunked(heads, size).map((rows) => upsert(TABLES.head, HEAD_COLS, ['home_key', 'partition'], rows)),
    // The runtime groups projection upserts in multi-row statements in both modes (store/pg.ts write).
    ...chunked(projections, WRITE_CHUNK).map((rows) => upsert(TABLES.projection, PROJECTION_COLS, ['partition', 'request_id'], rows)),
  ];
  if (w.marker) {
    out.push({
      text: `UPDATE owner_slot SET report_through = $1::DECIMAL, marker_seq = $2 WHERE kind = '${KIND}' AND slot = $3`,
      values: [w.marker.reportThrough, w.marker.markerSeq.toString(), slot],
    });
  }
  return out;
}

/** Range splits by slot, as platform/migrate/src/generate.ts makes them (RFC-006 §3.6, §3.7). */
export function presplitStatements(d: Dialect, slots: number): string[] {
  if (!d.presplit) return [];
  const step = slots > 256 ? 64 : 1;
  const splits: number[] = [];
  for (let s = step; s < slots; s += step) splits.push(s);
  if (splits.length === 0) return [];
  const headSplits = [...new Set(splits.map(reverseBits20))].sort((a, b) => a - b);
  const slotSplits = [0, ...splits.filter((s) => s % 64 === 0)];
  return [
    `ALTER TABLE ${TABLES.log} SPLIT AT VALUES ${splits.map((s) => `(${s})`).join(', ')}`,
    `ALTER TABLE ${TABLES.outbox} SPLIT AT VALUES ${splits.map((s) => `(${s})`).join(', ')}`,
    `ALTER TABLE ${TABLES.head} SPLIT AT VALUES ${headSplits.map((h) => `(${h})`).join(', ')}`,
    `ALTER TABLE owner_slot SPLIT AT VALUES ${slotSplits.map((s) => `('${KIND}', ${s})`).join(', ')}`,
  ];
}

/** The rows the setup writes: owner_slot for every slot, 64 platform_timing shards, and a head per partition. */
export function seedStatements(o: { slots: number; slotFirst: number; slotCount: number; partitionsPerSlot: number }): Stmt[] {
  const out: Stmt[] = [
    {
      text: `INSERT INTO owner_slot (kind, slot, session_id, epoch) SELECT '${KIND}', s, NULL, 0 FROM generate_series(0, $1::INT8) AS s ON CONFLICT (kind, slot) DO NOTHING`,
      values: [o.slots - 1],
    },
    {
      text: `INSERT INTO platform_timing (shard, version, epsilon_ms, delta_x_ms, tau_ms, second_lane) VALUES ${
        Array.from({ length: 64 }, (_, s) => `(${s}, 1, 100, 320, 420, '{}'::JSONB)`).join(', ')} ON CONFLICT (shard) DO NOTHING`,
      values: [],
    },
  ];
  const rows: Array<Record<string, unknown>> = [];
  for (let slot = o.slotFirst; slot < o.slotFirst + o.slotCount; slot++) {
    for (let p = 0; p < o.partitionsPerSlot; p++) {
      rows.push({
        home_key: homeKeyOf(slot, p, o.slots), partition: partitionKey(slot, p), slot, generation: 1, adopted: true, seq: 0n, ts: '0',
        epoch: 0n, streams: Buffer.from('{"outcome":"0"}'), chain: new Uint8Array(32), batch_id: new Uint8Array(16),
      });
    }
  }
  for (const chunk of chunked(rows, WRITE_CHUNK)) {
    // Seed heads only where none exists, so a second setup keeps the sequences of an earlier run.
    out.push({
      text: `INSERT INTO ${TABLES.head} (${HEAD_COLS.map((c) => c.name).join(', ')}) VALUES ${valuesList(HEAD_COLS, chunk.length)} ON CONFLICT (home_key, partition) DO NOTHING`,
      values: chunk.flatMap((r) => rowValues(HEAD_COLS, r)),
    });
  }
  return out;
}

/** Splits a schema file into statements: one ends with ";" at the end of a line; "--" comment lines are dropped. */
export function splitSql(text: string): string[] {
  const body = text.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  return body.split(/;\s*$/m).map((s) => s.trim()).filter((s) => s !== '');
}
