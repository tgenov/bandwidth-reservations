/** OwnerStore on CockroachDB through `pg` (RFC-006 §4.2, §4.3; C01 §2.3, §3.1, §3.2, §7). */
import pg from 'pg';
import type { HlcTs, ProjectionWrite, ReadTx, RowRef, SlotNo, TimingSnapshot } from '../api.ts';
import { decodeJson, encodeJson, hex } from '../bytes.ts';
import { assertIdentifier, tableNames } from '../declaration.ts';
import { AmbiguousCommitError, isLockTimeout, isRetryable, sqlState } from '../errors.ts';
import { hlc } from '../hlc.ts';
import { homeKey } from '../home.ts';
import { PARAMS } from '../params.ts';
import { keyObject, rowId } from '../rowref.ts';
import type {
  BatchTxn, BatchWrites, DisplacementCondition, FenceRow, OwnerStore, ResolutionRead, SessionRow, SlotLeaseRow, StoredHead,
} from './types.ts';

/** Maps a displacementRead condition to link_displacement's key columns (C02 §link_displacement). */
export interface DisplacementBinding {
  table: string;
  key(c: DisplacementCondition): Record<string, unknown>;
}

/** Default C02 binding: link_id = UTF-8 of the link partition; request = request_part ‖ U64BE(request_seq). */
export const C02_DISPLACEMENT: DisplacementBinding = {
  table: 'link_displacement',
  key: (c) => {
    const r = Buffer.from(c.request);
    if (r.byteLength < 8) throw new Error('displacementRead.request must be request_part ‖ U64BE(request_seq)');
    return {
      link_id: Buffer.from(c.link).toString('utf8'),
      request_part: r.subarray(0, r.byteLength - 8),
      request_seq: r.readBigUInt64BE(r.byteLength - 8).toString(),
    };
  },
};

export interface PgStoreOptions {
  connectionString: string;
  poolSize?: number;
  displacement?: DisplacementBinding;
}

type Row = Record<string, unknown>;

export function toPg(v: unknown): unknown {
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(toPg);
  return v;
}

const bytes = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(Buffer.from(String(v ?? ''), 'hex')));
const big = (v: unknown): bigint => BigInt(String(v));

function decodeStreams(b: Uint8Array): Record<string, bigint> {
  const raw = decodeJson(b) as Record<string, string>;
  const out: Record<string, bigint> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = BigInt(v);
  return out;
}

function encodeStreams(s: Record<string, bigint>): Uint8Array {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(s)) o[k] = v.toString();
  return encodeJson(o);
}

function headFromRow(r: Row): StoredHead {
  return {
    homeKey: Number(r['home_key']), partition: bytes(r['partition']), slot: Number(r['slot']), generation: Number(r['generation']),
    adopted: Boolean(r['adopted']), seq: big(r['seq']), ts: hlc(String(r['ts'])), epoch: big(r['epoch']),
    streams: decodeStreams(bytes(r['streams'])), chain: bytes(r['chain']), batchId: bytes(r['batch_id']),
  };
}

const HEAD_COLS = 'home_key, partition, slot, generation, adopted, seq, ts::STRING AS ts, epoch, streams, chain, batch_id';

function selectHeads(kind: string): string {
  // One point read per partition by (home_key, partition) (RFC-006 §4.3).
  return `SELECT ${HEAD_COLS} FROM ${assertIdentifier(tableNames(kind).head)}
           WHERE home_key = ANY($1::INT4[]) AND partition = ANY($2::BYTES[])`;
}

function headParams(partitions: Uint8Array[]): unknown[] {
  return [partitions.map(homeKey), partitions.map((p) => toPg(p))];
}

function whereKey(key: Record<string, unknown>, offset = 0): { sql: string; params: unknown[] } {
  const cols = Object.keys(key).map(assertIdentifier);
  return { sql: cols.map((c, i) => `${c} = $${i + 1 + offset}`).join(' AND '), params: cols.map((c) => toPg(key[c])) };
}

function projectionSql(w: ProjectionWrite, offset: number): { sql: string; params: unknown[] } {
  const table = assertIdentifier(w.table);
  const key = keyObject(w);
  if (w.op === 'delete') {
    const wk = whereKey(key, offset);
    return { sql: `DELETE FROM ${table} WHERE ${wk.sql}`, params: wk.params };
  }
  const row = { ...key, ...(w.row as Record<string, unknown>) };
  const cols = Object.keys(row).map(assertIdentifier);
  return {
    sql: `UPSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1 + offset}`).join(', ')})`,
    params: cols.map((c) => toPg(row[c])),
  };
}

function ambiguous(e: unknown): boolean {
  const code = sqlState(e);
  // 40003 statement completion unknown; 57014 statement timeout (the 15 s backstop); no code: connection lost.
  return code === undefined || code === '40003' || code === '57014' || code.startsWith('08');
}

class PgBatchTxn implements BatchTxn {
  private readonly client: pg.PoolClient;
  private readonly displacement: DisplacementBinding;

  constructor(client: pg.PoolClient, displacement: DisplacementBinding) {
    this.client = client;
    this.displacement = displacement;
  }

  private async q(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.client.query(sql, params)).rows as Row[];
  }

  async firstStatement(writes: ProjectionWrite[]): Promise<HlcTs> {
    // C01 §2.4 / M3: the placeholder writes and the ts read are one statement, so they are intents first.
    const ctes: string[] = [];
    const params: unknown[] = [];
    writes.forEach((w, i) => {
      const s = projectionSql(w, params.length);
      params.push(...s.params);
      ctes.push(`w${i} AS (${s.sql} RETURNING 1)`);
    });
    const rows = await this.q(`WITH ${ctes.join(', ')} SELECT cluster_logical_timestamp()::STRING AS ts`, params);
    return hlc(String(rows[0]?.['ts']));
  }

  async readFence(kind: string, slot: SlotNo): Promise<FenceRow | undefined> {
    const rows = await this.q(
      `SELECT session_id::STRING AS session_id, epoch, stops_version, report_through::STRING AS report_through, marker_seq
         FROM owner_slot WHERE kind = $1 AND slot = $2`, [kind, slot]);
    const r = rows[0];
    if (!r) return undefined;
    return {
      sessionId: r['session_id'] === null ? null : String(r['session_id']), epoch: big(r['epoch']),
      stopsVersion: big(r['stops_version']), markerSeq: big(r['marker_seq']),
      reportThrough: r['report_through'] === null ? null : hlc(String(r['report_through'])),
    };
  }

  async readTiming(shard: number): Promise<TimingSnapshot> {
    return readTiming((sql, p) => this.q(sql, p), shard);
  }

  async readStops(kind: string, partitions: Uint8Array[]): Promise<Map<string, Uint8Array>> {
    const rows = await this.q(
      `SELECT partition, detection_ref FROM placement_integrity_stops
        WHERE kind = $1 AND partition = ANY($2::BYTES[]) AND state = 'stopped'`, [kind, partitions.map((p) => toPg(p))]);
    return new Map(rows.map((r) => [hex(bytes(r['partition'])), bytes(r['detection_ref'])]));
  }

  async readHeads(kind: string, partitions: Uint8Array[]): Promise<Map<string, StoredHead>> {
    const rows = await this.q(selectHeads(kind), headParams(partitions));
    const want = new Set(partitions.map(hex));
    const m = new Map<string, StoredHead>();
    for (const r of rows) {
      const h = headFromRow(r);
      if (want.has(hex(h.partition))) m.set(hex(h.partition), h);
    }
    return m;
  }

  async readRows(refs: RowRef[]): Promise<Map<string, unknown>> {
    const m = new Map<string, unknown>();
    for (const ref of refs) {
      const id = rowId(ref);
      if (m.has(id)) continue;
      const wk = whereKey(keyObject(ref));
      const rows = await this.q(`SELECT * FROM ${assertIdentifier(ref.table)} WHERE ${wk.sql}`, wk.params);
      if (rows[0]) m.set(id, rows[0]);
    }
    return m;
  }

  async readDisplacement(c: DisplacementCondition): Promise<{ row: unknown | undefined } | 'lockTimeout'> {
    // C01 §3.2: under its own savepoint with lockTimeoutMs; a timeout fails only this call's condition.
    const wk = whereKey(this.displacement.key(c));
    const ms = Math.max(1, Math.floor(c.lockTimeoutMs));
    await this.q('SAVEPOINT displacement');
    try {
      await this.q(`SET LOCAL lock_timeout = '${ms}ms'`);
      const rows = await this.q(`SELECT attempt, reduction_seq, record_hlc::STRING AS record_hlc FROM ${assertIdentifier(this.displacement.table)} WHERE ${wk.sql}`, wk.params);
      await this.q('SET LOCAL lock_timeout = 0');           // back to no lock timeout for the rest of the batch
      await this.q('RELEASE SAVEPOINT displacement');       // the read stays in the batch's serialisable read set
      return { row: rows[0] };
    } catch (e) {
      if (!isLockTimeout(e)) throw e;
      await this.q('ROLLBACK TO SAVEPOINT displacement');
      await this.q('RELEASE SAVEPOINT displacement');
      return 'lockTimeout';
    }
  }

  async readTs(): Promise<HlcTs> {
    const rows = await this.q('SELECT cluster_logical_timestamp()::STRING AS ts');
    return hlc(String(rows[0]?.['ts']));
  }

  async write(kind: string, w: BatchWrites): Promise<void> {
    const t = tableNames(kind);
    const ts = w.ts;
    for (const r of w.log) {
      await this.q(
        `INSERT INTO ${t.log} (slot, partition, seq, generation, epoch, kind, schema_v, ts, identity, emits, audit, retention, key_id, payload, chain)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::DECIMAL, $9, $10, $11, $12, $13, $14, $15)`,
        [r.slot, toPg(r.partition), r.seq.toString(), r.generation, r.epoch.toString(), r.kind, r.schemaV, ts,
          toPg(r.identity), toPg(r.emits), toPg(r.audit), r.retention, toPg(r.keyId), toPg(r.payload), toPg(r.chain)]);
    }
    for (const r of w.outbox) {
      await this.q(
        `INSERT INTO ${t.outbox} (slot, partition, stream, stream_seq, n, topic, msg_key, headers, payload, ts, generation, epoch)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::DECIMAL, $11, $12)${r.ifAbsent ? ' ON CONFLICT DO NOTHING' : ''}`,
        [r.slot, toPg(r.partition), r.stream, r.streamSeq.toString(), r.n, r.topic, toPg(r.msgKey), toPg(r.headers),
          toPg(r.payload), ts, r.generation, r.epoch.toString()]);
    }
    for (const h of w.heads) {
      await this.q(
        `UPSERT INTO ${t.head} (home_key, partition, slot, generation, adopted, seq, ts, epoch, streams, chain, batch_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::DECIMAL, $8, $9, $10, $11)`,
        [h.homeKey, toPg(h.partition), h.slot, h.generation, h.adopted, h.seq.toString(), h.ts, h.epoch.toString(),
          toPg(encodeStreams(h.streams)), toPg(h.chain), toPg(h.batchId)]);
    }
    for (const p of w.projections) {
      const s = projectionSql(p, 0);
      await this.q(s.sql, s.params);
    }
  }

  async restart(): Promise<void> {
    await this.q('ROLLBACK TO SAVEPOINT cockroach_restart');
  }

  async commit(backstopMs: number): Promise<void> {
    // COMMIT is exempt from the 2 s timeout; the 15 s backstop ends as Ambiguous (C01 §7, M1).
    await this.q(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(backstopMs))}ms'`);
    try {
      await this.q('RELEASE SAVEPOINT cockroach_restart');
    } catch (e) {
      if (isRetryable(e)) throw e;
      if (ambiguous(e)) throw new AmbiguousCommitError(`RELEASE: ${(e as Error).message}`, e);
      throw e;
    }
    try {
      await this.q('COMMIT');
    } catch (e) {
      throw new AmbiguousCommitError(`COMMIT after RELEASE: ${(e as Error).message}`, e);
    }
  }

  async rollback(): Promise<void> {
    await this.q('ROLLBACK');
  }

  close(broken: boolean): void {
    this.client.release(broken ? new Error('discarded after an unknown outcome') : undefined);
  }
}

async function readTiming(q: (sql: string, p: unknown[]) => Promise<Row[]>, shard: number): Promise<TimingSnapshot> {
  const rows = await q('SELECT version, epsilon_ms, delta_x_ms, tau_ms FROM platform_timing WHERE shard = $1', [shard]);
  const r = rows[0];
  if (!r) return { version: 0n, epsilonMs: PARAMS.epsilonMs, deltaXMs: 320, tauMs: 420 };
  return { version: big(r['version']), epsilonMs: Number(r['epsilon_ms']), deltaXMs: Number(r['delta_x_ms']), tauMs: Number(r['tau_ms']) };
}

export class PgStore implements OwnerStore {
  readonly pool: pg.Pool;
  private readonly displacement: DisplacementBinding;

  constructor(o: PgStoreOptions) {
    this.pool = new pg.Pool({ connectionString: o.connectionString, max: o.poolSize ?? 8 });
    this.displacement = o.displacement ?? C02_DISPLACEMENT;
    this.pool.on('connect', (client) => {
      // C01 §7: statement timeout 2 s (COMMIT excepted per transaction); idle-in-transaction 1 s.
      void client.query(`SET statement_timeout = '${PARAMS.statementTimeoutMs}ms'`).catch(() => {});
      void client.query(`SET idle_in_transaction_session_timeout = '${PARAMS.idleInTransactionMs}ms'`).catch(() => {});
    });
    this.pool.on('error', () => { /* an idle client died; the pool replaces it */ });
  }

  async beginBatch(): Promise<BatchTxn> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');                                  // SERIALIZABLE
      await client.query('SAVEPOINT cockroach_restart');
    } catch (e) {
      client.release(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
    return new PgBatchTxn(client, this.displacement);
  }

  private async tx<T>(fn: (q: (sql: string, p?: unknown[]) => Promise<Row[]>) => Promise<T>, begin = 'BEGIN'): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query(begin);
      const out = await fn(async (sql, p = []) => (await client.query(sql, p)).rows as Row[]);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw e;
    } finally {
      client.release(broken ? new Error('broken') : undefined);
    }
  }

  async insertSession(s: SessionRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO owner_session (shard, session_id, host, region, facility, kind, started_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now() + $7::INTERVAL)`,
      [s.shard, s.sessionId, s.host, s.region, s.facility, s.kind, `${s.ttlMs} milliseconds`]);
  }

  async renewSession(shard: number, sessionId: string, ttlMs: number): Promise<boolean> {
    // RFC-006 §4.2: conditional only on NOT revoked (a lapsed, untaken session may resume).
    const r = await this.pool.query(
      `UPDATE owner_session SET expires_at = now() + $3::INTERVAL WHERE shard = $1 AND session_id = $2 AND NOT revoked`,
      [shard, sessionId, `${ttlMs} milliseconds`]);
    return (r.rowCount ?? 0) === 1;
  }

  async listSlots(kind: string, slots: SlotNo[]): Promise<SlotLeaseRow[]> {
    const r = await this.pool.query(
      `SELECT s.slot, s.session_id::STRING AS session_id, s.epoch,
              coalesce(se.expires_at <= now(), true) AS expired, coalesce(se.revoked, false) AS revoked
         FROM owner_slot s LEFT JOIN owner_session se ON se.session_id = s.session_id
        WHERE s.kind = $1 AND s.slot = ANY($2::INT4[])`, [kind, slots]);
    return (r.rows as Row[]).map((x) => ({
      slot: Number(x['slot']), sessionId: x['session_id'] === null ? null : String(x['session_id']), epoch: big(x['epoch']),
      sessionExpired: Boolean(x['expired']), sessionRevoked: Boolean(x['revoked']),
    }));
  }

  async acquireFree(kind: string, slot: SlotNo, sessionId: string): Promise<{ slot: SlotNo; epoch: bigint } | undefined> {
    // R27-15: `= $old` never matches NULL, so a free slot has its own statement.
    const r = await this.pool.query(
      `UPDATE owner_slot SET session_id = $3, epoch = epoch + 1, acquired_at = now()
        WHERE kind = $1 AND slot = $2 AND session_id IS NULL RETURNING slot, epoch`, [kind, slot, sessionId]);
    const row = r.rows[0] as Row | undefined;
    return row ? { slot: Number(row['slot']), epoch: big(row['epoch']) } : undefined;
  }

  async acquireExpired(kind: string, oldShard: number, oldSession: string, slots: SlotNo[], sessionId: string):
    Promise<Array<{ slot: SlotNo; epoch: bigint }>> {
    return this.tx(async (q) => {
      // RFC-006 §4.2: revoke the expired session and take its slots in one high-priority transaction.
      const revoked = await q(
        `UPDATE owner_session SET revoked = true WHERE shard = $1 AND session_id = $2 AND (revoked OR expires_at <= now())
         RETURNING session_id`, [oldShard, oldSession]);
      if (revoked.length !== 1) return [];
      const rows = await q(
        `UPDATE owner_slot SET session_id = $1, epoch = epoch + 1, acquired_at = now()
          WHERE kind = $2 AND slot = ANY($3::INT4[]) AND session_id = $4 RETURNING slot, epoch`, [sessionId, kind, slots, oldSession]);
      return rows.map((r) => ({ slot: Number(r['slot']), epoch: big(r['epoch']) }));
    }, 'BEGIN PRIORITY HIGH');
  }

  async rehome(kind: string, held: Array<{ slot: SlotNo; epoch: bigint }>, oldSession: string, newSession: string):
    Promise<Array<{ slot: SlotNo; epoch: bigint }>> {
    return this.tx(async (q) => {
      const out: Array<{ slot: SlotNo; epoch: bigint }> = [];
      for (const h of held) {
        const rows = await q(
          `UPDATE owner_slot SET session_id = $1, epoch = epoch + 1, acquired_at = now()
            WHERE kind = $2 AND slot = $3 AND session_id = $4 AND epoch = $5 RETURNING slot, epoch`,
          [newSession, kind, h.slot, oldSession, h.epoch.toString()]);
        const r = rows[0];
        if (r) out.push({ slot: Number(r['slot']), epoch: big(r['epoch']) });
      }
      return out;
    }, 'BEGIN PRIORITY HIGH');
  }

  async release(kind: string, held: Array<{ slot: SlotNo; epoch: bigint }>, sessionId: string): Promise<void> {
    await this.tx(async (q) => {
      for (const h of held) {
        await q(`UPDATE owner_slot SET session_id = NULL WHERE kind = $1 AND slot = $2 AND session_id = $3 AND epoch = $4`,
          [kind, h.slot, sessionId, h.epoch.toString()]);
      }
      await q(`UPDATE owner_session SET revoked = true WHERE session_id = $1`, [sessionId]);
    });
  }

  async resolutionRead(kind: string, sessionShard: number, sessionId: string, slots: SlotNo[], partitions: Uint8Array[]): Promise<ResolutionRead> {
    // C01 §3.1 step 1: high priority, present time, retried until it answers (by the caller).
    return this.tx(async (q) => {
      const s = await q('SELECT revoked FROM owner_session WHERE shard = $1 AND session_id = $2', [sessionShard, sessionId]);
      const sl = await q('SELECT slot, session_id::STRING AS session_id, epoch FROM owner_slot WHERE kind = $1 AND slot = ANY($2::INT4[])', [kind, slots]);
      const hs = partitions.length > 0 ? await q(selectHeads(kind), headParams(partitions)) : [];
      const t = await q('SELECT cluster_logical_timestamp()::STRING AS ts');
      const heads = new Map<string, StoredHead>();
      for (const r of hs) { const h = headFromRow(r); heads.set(hex(h.partition), h); }
      return {
        tRes: hlc(String(t[0]?.['ts'])),
        sessionRevoked: s[0] ? Boolean(s[0]['revoked']) : true,
        slots: new Map(sl.map((r) => [Number(r['slot']), { sessionId: r['session_id'] === null ? null : String(r['session_id']), epoch: big(r['epoch']) }])),
        heads,
      };
    }, 'BEGIN PRIORITY HIGH');
  }

  async readTiming(shard: number): Promise<TimingSnapshot> {
    return readTiming(async (sql, p) => (await this.pool.query(sql, p)).rows as Row[], shard);
  }

  async withReadTx<T>(at: 'present' | HlcTs, fn: (tx: ReadTx) => Promise<T>): Promise<T> {
    const begin = at === 'present' ? 'BEGIN PRIORITY HIGH' : `BEGIN AS OF SYSTEM TIME '${hlc(at)}'`;
    return this.tx((q) => fn({ query: async <R extends Record<string, unknown>>(sql: string, p?: unknown[]) => (await q(sql, (p ?? []).map(toPg))) as R[] }), begin);
  }

  async followerRead<T>(fn: (tx: ReadTx) => Promise<T>): Promise<{ value: T; servedAt: HlcTs }> {
    const r = await this.pool.query(
      `SELECT ((extract(epoch FROM follower_read_timestamp()) * 1000000)::INT8 * 1000)::STRING AS ns`);
    const servedAt = hlc(String((r.rows[0] as Row)['ns']));
    const value = await this.withReadTx(servedAt, fn);
    return { value, servedAt };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
