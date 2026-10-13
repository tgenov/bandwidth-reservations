/** OwnerStore on CockroachDB through `pg` (RFC-006 §4.2, §4.3; C01 §2.3, §3.1, §3.2, §7). */
import pg from 'pg';
import type { HlcTs, ProjectionWrite, ReadTx, RowRef, SlotNo } from '../api.ts';
import { decodeJson, encodeJson, hex } from '../bytes.ts';
import { assertIdentifier, tableNames } from '../declaration.ts';
import { AmbiguousCommitError, isLockTimeout, isRetryable, sqlState } from '../errors.ts';
import { GatewayTiers, TierTimeout, withTierTimeout, type GatewayTiersOptions } from './tiers.ts';
import { ceilMicrosLiteral, hlc } from '../hlc.ts';
import { homeKey } from '../home.ts';
import { PARAMS } from '../params.ts';
import { keyObject, rowId } from '../rowref.ts';
import type {
  GroupMember, LogRowWrite, BatchTxn, BatchWrites, DisplacementCondition, FenceRow, OwnerStore, ResolutionRead, SessionRow, SlotLeaseRow, StoredHead, TimingRow,
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
  /**
   * Gateway tiers in order (RFC-006 §4.7): own facility, the metro's other facility, the other Kenyan region.
   * Default: `connectionString` alone.
   */
  tiers?: string[];
  /** Per-tier timeout of the renewal, the epoch read and the session poll (C01 §7: 400 ms). */
  tierTimeoutMs?: number;
  /** Breaker options of the tiers. */
  breaker?: GatewayTiersOptions;
  /** One pool per tier in place of `tiers` (unit tests of the tier logic with pool doubles). */
  pools?: pg.Pool[];
}

type Row = Record<string, unknown>;

/** Rows in one batched read or one multi-row UPSERT (bounds the statement size). */
const READ_CHUNK = 500;
const WRITE_CHUNK = 200;

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

/** `outcome_id` values of outbox `headers` JSON (C01 §3.4 rule 7). */
export function outcomeIdsOf(headers: Uint8Array[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const h of headers) {
    const id = (decodeJson(h) as Record<string, unknown>)['outcome_id'];
    if (typeof id === 'string') out.push(new Uint8Array(Buffer.from(id, 'hex')));
  }
  return out;
}

function ambiguous(e: unknown): boolean {
  const code = sqlState(e);
  // 40003 statement completion unknown; 57014 statement timeout (the 15 s backstop); no code: connection lost.
  return code === undefined || code === '40003' || code === '57014' || code.startsWith('08');
}

class PgBatchTxn implements BatchTxn {
  private readonly client: pg.PoolClient;
  private readonly displacement: DisplacementBinding;
  private readonly tier: { index: number; timeoutMs: number; onTimeout: () => void };

  constructor(client: pg.PoolClient, displacement: DisplacementBinding, tier: { index: number; timeoutMs: number; onTimeout: () => void }) {
    this.client = client;
    this.displacement = displacement;
    this.tier = tier;
  }

  /**
   * One statement. Every statement except COMMIT has a client-side limit just above the 2 s statement timeout
   * (C01 §7), so a gateway that stops answering (RFC-006 §4.7) ends the attempt as a TierTimeout: the batch
   * is abandoned and starts again on the next tier.
   */
  private async q(sql: string, params: unknown[] = [], limitMs: number | null = PARAMS.statementTimeoutMs + 500): Promise<Row[]> {
    const p = this.client.query(sql, params).then((r) => r.rows as Row[]);
    if (limitMs === null) return p;
    try {
      return await withTierTimeout(p, this.tier.index, limitMs);
    } catch (e) {
      if (e instanceof TierTimeout) this.tier.onTimeout();
      throw e;
    }
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
    // RFC-006 §4.7: the epoch read has the per-tier timeout; on a timeout the batch restarts on the next tier.
    // One limit only, so a stalled read counts one timeout toward the breaker.
    const rows = await this.q(
      `SELECT session_id::STRING AS session_id, epoch, stops_version, report_through::STRING AS report_through, marker_seq
         FROM owner_slot WHERE kind = $1 AND slot = $2`, [kind, slot], this.tier.timeoutMs);
    const r = rows[0];
    if (!r) return undefined;
    return {
      sessionId: r['session_id'] === null ? null : String(r['session_id']), epoch: big(r['epoch']),
      stopsVersion: big(r['stops_version']), markerSeq: big(r['marker_seq']),
      reportThrough: r['report_through'] === null ? null : hlc(String(r['report_through'])),
    };
  }

  async readTiming(shard: number): Promise<TimingRow> {
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
    // One SELECT for each table and key-column set when every key value is BYTES or STRING (the values compare
    // exactly after the round trip); one SELECT for each row otherwise.
    const groups = new Map<string, { table: string; cols: string[]; refs: Array<{ id: string; key: Record<string, unknown> }> }>();
    const seen = new Set<string>();
    for (const ref of refs) {
      const id = rowId(ref);
      if (seen.has(id)) continue;
      seen.add(id);
      const key = keyObject(ref);
      const cols = Object.keys(key).map(assertIdentifier);
      if (cols.length > 0 && cols.every((c) => key[c] instanceof Uint8Array || typeof key[c] === 'string')) {
        const g = `${assertIdentifier(ref.table)}|${cols.join(',')}`;
        let group = groups.get(g);
        if (!group) { group = { table: assertIdentifier(ref.table), cols, refs: [] }; groups.set(g, group); }
        group.refs.push({ id, key });
        continue;
      }
      const wk = whereKey(key);
      const rows = await this.q(`SELECT * FROM ${assertIdentifier(ref.table)} WHERE ${wk.sql}`, wk.params);
      if (rows[0]) m.set(id, rows[0]);
    }
    const norm = (v: unknown): string => (v instanceof Uint8Array ? `b:${hex(v)}` : `s:${String(v)}`);
    for (const g of groups.values()) {
      for (let i = 0; i < g.refs.length; i += READ_CHUNK) {
        const chunk = g.refs.slice(i, i + READ_CHUNK);
        const params: unknown[] = [];
        const tuples = chunk.map((r) => `(${g.cols.map((c) => { params.push(toPg(r.key[c])); return `$${params.length}`; }).join(', ')})`);
        const rows = await this.q(`SELECT * FROM ${g.table} WHERE (${g.cols.join(', ')}) IN (${tuples.join(', ')})`, params);
        const byKey = new Map(chunk.map((r) => [g.cols.map((c) => norm(r.key[c])).join('|'), r.id]));
        for (const row of rows) {
          const id = byKey.get(g.cols.map((c) => norm(row[c])).join('|'));
          if (id !== undefined) m.set(id, row);
        }
      }
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
    // The last write of each row wins, as in order. Upserts of one table with one column set go in multi-row
    // statements; deletes go one by one. Rows are distinct, so the order between them does not change the result.
    const last = new Map<string, ProjectionWrite>();
    for (const p of w.projections) {
      const id = rowId({ table: p.table, key: p.key });
      last.delete(id);
      last.set(id, p);
    }
    const upserts = new Map<string, { table: string; cols: string[]; rows: Array<Record<string, unknown>> }>();
    for (const p of last.values()) {
      if (p.op === 'delete') {
        const s = projectionSql(p, 0);
        await this.q(s.sql, s.params);
        continue;
      }
      const row = { ...keyObject(p), ...(p.row as Record<string, unknown>) };
      const cols = Object.keys(row).map(assertIdentifier).sort();
      const g = `${assertIdentifier(p.table)}|${cols.join(',')}`;
      let group = upserts.get(g);
      if (!group) { group = { table: assertIdentifier(p.table), cols, rows: [] }; upserts.set(g, group); }
      group.rows.push(row);
    }
    for (const g of upserts.values()) {
      for (let i = 0; i < g.rows.length; i += WRITE_CHUNK) {
        const params: unknown[] = [];
        const values = g.rows.slice(i, i + WRITE_CHUNK)
          .map((r) => `(${g.cols.map((c) => { params.push(toPg(r[c])); return `$${params.length}`; }).join(', ')})`);
        await this.q(`UPSERT INTO ${g.table} (${g.cols.join(', ')}) VALUES ${values.join(', ')}`, params);
      }
    }
    for (const x of w.streamIndex ?? []) {
      await this.q(`INSERT INTO ${assertIdentifier(t.streamIndex)} (partition, stream, stream_seq, seq) VALUES ($1, $2, $3, $4)`,
        [toPg(x.partition), x.stream, x.streamSeq.toString(), x.seq.toString()]);
    }
    if (w.slotPosition) {
      await this.q(`UPSERT INTO owner_slot_position (kind, slot, position) VALUES ($1, $2, $3)`,
        [kind, w.slotPosition.slot, w.slotPosition.position.toString()]);
    }
    if (w.slotUpdate) {
      // Only the holder writes these columns, in a batch or a marker-only transaction (C01 §3.4, V59-6).
      await this.q(`UPDATE owner_slot SET report_through = $3::DECIMAL, marker_seq = $4 WHERE kind = $1 AND slot = $2`,
        [kind, w.slotUpdate.slot, w.slotUpdate.reportThrough, w.slotUpdate.markerSeq.toString()]);
    }
  }

  async readSlotPosition(kind: string, slot: SlotNo): Promise<bigint> {
    const rows = await this.q('SELECT position FROM owner_slot_position WHERE kind = $1 AND slot = $2', [kind, slot]);
    return rows[0] ? big(rows[0]['position']) : 0n;
  }

  async readOutcomeIds(kind: string, slot: SlotNo, stream: string, after: HlcTs | null, upTo: HlcTs): Promise<Uint8Array[]> {
    const rows = await this.q(
      `SELECT headers FROM ${assertIdentifier(tableNames(kind).outbox)}
        WHERE slot = $1 AND stream = $2 AND partition != ''::BYTES AND ($3::DECIMAL IS NULL OR ts > $3::DECIMAL) AND ts <= $4::DECIMAL
        ORDER BY ts`, [slot, stream, after, upTo]);
    return outcomeIdsOf(rows.map((r) => bytes(r['headers'])));
  }

  async restart(): Promise<void> {
    await this.q('ROLLBACK TO SAVEPOINT cockroach_restart');
  }

  async commit(backstopMs: number): Promise<void> {
    // COMMIT is exempt from the 2 s timeout; the 15 s backstop ends as Ambiguous (C01 §7, M1).
    await this.q(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(backstopMs))}ms'`);
    try {
      await this.q('RELEASE SAVEPOINT cockroach_restart', [], null);
    } catch (e) {
      if (isRetryable(e)) throw e;
      if (ambiguous(e)) throw new AmbiguousCommitError(`RELEASE: ${(e as Error).message}`, e);
      throw e;
    }
    try {
      await this.q('COMMIT', [], null);
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

async function readTiming(q: (sql: string, p: unknown[]) => Promise<Row[]>, shard: number): Promise<TimingRow> {
  const rows = await q('SELECT version, epsilon_ms, delta_x_ms, tau_ms, second_lane::STRING AS second_lane FROM platform_timing WHERE shard = $1', [shard]);
  const r = rows[0];
  if (!r) return { version: 0n, epsilonMs: PARAMS.epsilonMs, deltaXMs: 320, tauMs: 420 };
  const lanes = JSON.parse(String(r['second_lane'] ?? '{}')) as unknown;
  return { version: big(r['version']), epsilonMs: Number(r['epsilon_ms']), deltaXMs: Number(r['delta_x_ms']), tauMs: Number(r['tau_ms']),
    ...(lanes !== null && typeof lanes === 'object' ? { secondLane: lanes as NonNullable<TimingRow['secondLane']> } : {}) };
}

/** Thrown inside a group transaction to roll it back when one member cannot be taken. */
class GroupNotTaken extends Error {}

export class PgStore implements OwnerStore {
  /** One pool per gateway tier (RFC-006 §4.7). */
  readonly pools: pg.Pool[];
  readonly tiers: GatewayTiers;
  private readonly tierTimeoutMs: number;
  private readonly displacement: DisplacementBinding;

  constructor(o: PgStoreOptions) {
    // C01 §7: statement timeout 2 s (COMMIT excepted per transaction); idle-in-transaction 1 s.
    // They go in the startup message, so they apply before the first query on each connection.
    const urls = o.tiers && o.tiers.length > 0 ? o.tiers : [o.connectionString];
    this.pools = o.pools ?? urls.map((connectionString) => {
      const p = new pg.Pool({
        // Idle connections stay open on every tier, so a fallback needs no new connection (RFC-006 §4.7).
        connectionString, max: o.poolSize ?? 8, idleTimeoutMillis: urls.length > 1 ? 0 : 10_000,
        options: `-c statement_timeout=${PARAMS.statementTimeoutMs} -c idle_in_transaction_session_timeout=${PARAMS.idleInTransactionMs}`,
      });
      p.on('error', () => { /* an idle client died; the pool replaces it */ });
      return p;
    });
    this.tiers = new GatewayTiers(this.pools.length, o.breaker);
    // RFC-006 §4.7: a statement that misses its per-tier timeout is retried on the next tier. With one tier there is
    // no next tier, so the per-tier timeout would only drop a slow but good renewal: the statement timeout applies.
    this.tierTimeoutMs = this.pools.length > 1 ? (o.tierTimeoutMs ?? PARAMS.tierTimeoutMs) : PARAMS.statementTimeoutMs + 500;
    this.displacement = o.displacement ?? C02_DISPLACEMENT;
  }

  /** Opens one idle connection on every tier, so the first fallback does not wait for a connect (RFC-006 §4.7). */
  async warm(): Promise<void> {
    if (this.pools.length < 2) return;
    await Promise.all(this.pools.map(async (p, tier) => {
      try { const c = await withTierTimeout(p.connect(), tier, PARAMS.statementTimeoutMs, (late) => late.release()); c.release(); } catch { /* the tier is down now; the breaker learns it */ }
    }));
  }

  /** The pool of the first live tier: every statement without a per-tier timeout starts there. */
  get pool(): pg.Pool {
    return this.pools[this.tiers.order()[0] ?? 0] as pg.Pool;
  }

  /** A client of one tier, connected within the per-tier timeout (a late connection is discarded). */
  private tierClient(tier: number): Promise<pg.PoolClient> {
    const pool = this.pools[tier] as pg.Pool;
    return withTierTimeout(pool.connect(), tier, this.tierTimeoutMs, (late) => late.release(new Error('connected after the tier timeout')));
  }

  /**
   * Runs `fn` on the first tier that answers within the per-tier timeout (RFC-006 §4.7): the renewal and the
   * session poll. A timeout or an unreachable gateway moves to the next tier and counts toward its breaker.
   */
  /** Each per-tier attempt of the renewal and the session poll (monotonic ms), newest last; for tests and metrics. */
  readonly tierTrace: Array<{ op: string; tier: number; startMs: number; endMs: number; ok: boolean }> = [];

  private async onTiers<T>(fn: (c: pg.PoolClient) => Promise<T>, timeoutMs: number = this.tierTimeoutMs, op = 'statement'): Promise<T> {
    let last: unknown;
    for (const tier of this.tiers.order()) {
      let client: pg.PoolClient | undefined;
      const startMs = performance.now();
      const trace = (ok: boolean): void => {
        this.tierTrace.push({ op, tier, startMs, endMs: performance.now(), ok });
        if (this.tierTrace.length > 1_000) this.tierTrace.shift();
      };
      try {
        client = await this.tierClient(tier);
        const out = await withTierTimeout(fn(client), tier, timeoutMs);
        client.release();
        this.tiers.success(tier);
        trace(true);
        return out;
      } catch (e) {
        trace(false);
        client?.release(new Error('discarded after a tier failure'));
        if (!(e instanceof TierTimeout) && !unreachable(e)) throw e;
        this.tiers.timeout(tier);
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error('no gateway tier answered');
  }

  async beginBatch(): Promise<BatchTxn> {
    let last: unknown;
    for (const tier of this.tiers.order()) {
      let client: pg.PoolClient | undefined;
      try {
        client = await this.tierClient(tier);
        await withTierTimeout(client.query('BEGIN'), tier, this.tierTimeoutMs);                // SERIALIZABLE
        await withTierTimeout(client.query('SAVEPOINT cockroach_restart'), tier, this.tierTimeoutMs);
        return new PgBatchTxn(client, this.displacement, { index: tier, timeoutMs: this.tierTimeoutMs, onTimeout: () => this.tiers.timeout(tier) });
      } catch (e) {
        client?.release(e instanceof Error ? e : new Error(String(e)));
        if (!(e instanceof TierTimeout) && !unreachable(e)) throw e;
        this.tiers.timeout(tier);
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error('no gateway tier answered');
  }

  /**
   * A short transaction on the first tier that answers (RFC-006 §4.7): a tier that does not finish it within the
   * statement timeout (plus 500 ms) is left for the next one. A write that timed out may still have committed:
   * the acquisition adopts slots that already name its session (runtime.ts).
   */
  private async tx<T>(fn: (q: (sql: string, p?: unknown[]) => Promise<Row[]>) => Promise<T>, begin = 'BEGIN'): Promise<T> {
    let last: unknown;
    for (const tier of this.tiers.order()) {
      let client: pg.PoolClient | undefined;
      try {
        client = await this.tierClient(tier);
        const c = client;
        const run = async (): Promise<T> => {
          let broken = false;
          try {
            await c.query(begin);
            const out = await fn(async (sql, p = []) => (await c.query(sql, p)).rows as Row[]);
            await c.query('COMMIT');
            return out;
          } catch (e) {
            try { await c.query('ROLLBACK'); } catch { broken = true; }
            if (broken) throw Object.assign(e instanceof Error ? e : new Error(String(e)), { brokenClient: true });
            throw e;
          }
        };
        const out = await withTierTimeout(run(), tier, PARAMS.statementTimeoutMs + 500);
        client.release();
        this.tiers.success(tier);
        return out;
      } catch (e) {
        const timeout = e instanceof TierTimeout || unreachable(e);
        client?.release(timeout || (e as { brokenClient?: boolean }).brokenClient ? new Error('discarded') : undefined);
        if (!timeout) throw e;
        this.tiers.timeout(tier);
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error('no gateway tier answered');
  }

  /** One statement outside a transaction, on the first tier that answers within the statement timeout. */
  private async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number | null }> {
    return this.onTiers((c) => c.query(sql, params).then((r) => ({ rows: r.rows as Row[], rowCount: r.rowCount })), PARAMS.statementTimeoutMs + 500);
  }

  async insertSession(s: SessionRow): Promise<void> {
    await this.query(
      `INSERT INTO owner_session (shard, session_id, host, region, facility, kind, started_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now() + $7::INTERVAL)`,
      [s.shard, s.sessionId, s.host, s.region, s.facility, s.kind, `${s.ttlMs} milliseconds`]);
  }

  async renewSession(shard: number, sessionId: string, ttlMs: number): Promise<boolean> {
    // RFC-006 §4.2: conditional only on NOT revoked (a lapsed, untaken session may resume). §4.7: per-tier timeout.
    const r = await this.onTiers((c) => c.query(
      `UPDATE owner_session SET expires_at = now() + $3::INTERVAL WHERE shard = $1 AND session_id = $2 AND NOT revoked`,
      [shard, sessionId, `${ttlMs} milliseconds`]), this.tierTimeoutMs, 'renewal');
    return (r.rowCount ?? 0) === 1;
  }

  async listSlots(kind: string, slots: SlotNo[]): Promise<SlotLeaseRow[]> {
    // The session poll (acquisition and the standby's present-time poll): per-tier timeout (RFC-006 §4.7).
    const r = await this.onTiers((c) => c.query(
      `SELECT s.slot, s.session_id::STRING AS session_id, s.epoch,
              coalesce(se.expires_at <= now(), true) AS expired, coalesce(se.revoked, false) AS revoked
         FROM owner_slot s LEFT JOIN owner_session se ON se.session_id = s.session_id
        WHERE s.kind = $1 AND s.slot = ANY($2::INT4[])`, [kind, slots]));
    return (r.rows as Row[]).map((x) => ({
      slot: Number(x['slot']), sessionId: x['session_id'] === null ? null : String(x['session_id']), epoch: big(x['epoch']),
      sessionExpired: Boolean(x['expired']), sessionRevoked: Boolean(x['revoked']),
    }));
  }

  async acquireFree(kind: string, slot: SlotNo, sessionId: string): Promise<{ slot: SlotNo; epoch: bigint } | undefined> {
    // R27-15: `= $old` never matches NULL, so a free slot has its own statement.
    const r = await this.query(
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

  async acquireGroup(members: GroupMember[], sessionId: string, group: string, old: { shard: number; sessionId: string } | null):
    Promise<Array<GroupMember & { epoch: bigint }> | undefined> {
    return this.tx(async (q) => {
      if (old) {
        const revoked = await q(
          `UPDATE owner_session SET revoked = true WHERE shard = $1 AND session_id = $2 AND (revoked OR expires_at <= now())
           RETURNING session_id`, [old.shard, old.sessionId]);
        if (revoked.length !== 1) throw new GroupNotTaken();
      }
      const out: Array<GroupMember & { epoch: bigint }> = [];
      for (const m of members) {
        const rows = await q(
          `UPDATE owner_slot SET session_id = $1, epoch = epoch + 1, acquired_at = now(), slot_group = $4
            WHERE kind = $2 AND slot = $3 AND ${old ? 'session_id = $5' : 'session_id IS NULL'} RETURNING epoch`,
          [sessionId, m.kind, m.slot, group, ...(old ? [old.sessionId] : [])]);
        const r = rows[0];
        // One member not takeable: the whole group stays where it is (RFC-006 §4.2, §7.1).
        if (!r) throw new GroupNotTaken();
        out.push({ ...m, epoch: big(r['epoch']) });
      }
      return out;
    }, old ? 'BEGIN PRIORITY HIGH' : 'BEGIN').catch((e: unknown) => {
      if (e instanceof GroupNotTaken) return undefined;
      throw e;
    });
  }

  async releaseGroup(held: Array<GroupMember & { epoch: bigint }>, sessionId: string, keepSession = true): Promise<void> {
    // RFC-006 §6.2, §7.1: every member of the group in one transaction, so a failure frees no member.
    await this.tx(async (q) => {
      for (const h of held) {
        await q(`UPDATE owner_slot SET session_id = NULL WHERE kind = $1 AND slot = $2 AND session_id = $3 AND epoch = $4`,
          [h.kind, h.slot, sessionId, h.epoch.toString()]);
      }
      if (!keepSession) await q(`UPDATE owner_session SET revoked = true WHERE session_id = $1`, [sessionId]);
    });
  }

  async rehomeGroup(held: Array<GroupMember & { epoch: bigint }>, oldSession: string, newSession: string):
    Promise<Array<GroupMember & { epoch: bigint }> | undefined> {
    return this.tx(async (q) => {
      const out: Array<GroupMember & { epoch: bigint }> = [];
      for (const h of held) {
        const rows = await q(
          `UPDATE owner_slot SET session_id = $1, epoch = epoch + 1, acquired_at = now()
            WHERE kind = $2 AND slot = $3 AND session_id = $4 AND epoch = $5 RETURNING epoch`,
          [newSession, h.kind, h.slot, oldSession, h.epoch.toString()]);
        const r = rows[0];
        if (!r) throw new GroupNotTaken();
        out.push({ kind: h.kind, slot: h.slot, epoch: big(r['epoch']) });
      }
      return out;
    }, 'BEGIN PRIORITY HIGH').catch((e: unknown) => {
      if (e instanceof GroupNotTaken) return undefined;
      throw e;
    });
  }

  async clusterTime(): Promise<HlcTs> {
    const r = await this.query('SELECT cluster_logical_timestamp()::STRING AS ts');
    return hlc(String((r.rows[0] as Row)['ts']));
  }

  async revokeSession(shard: number, sessionId: string): Promise<void> {
    await this.onTiers((c) => c.query('UPDATE owner_session SET revoked = true WHERE shard = $1 AND session_id = $2', [shard, sessionId]));
  }

  async release(kind: string, held: Array<{ slot: SlotNo; epoch: bigint }>, sessionId: string, keepSession = false): Promise<void> {
    await this.tx(async (q) => {
      for (const h of held) {
        await q(`UPDATE owner_slot SET session_id = NULL WHERE kind = $1 AND slot = $2 AND session_id = $3 AND epoch = $4`,
          [kind, h.slot, sessionId, h.epoch.toString()]);
      }
      if (!keepSession) await q(`UPDATE owner_session SET revoked = true WHERE session_id = $1`, [sessionId]);
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

  async readLogRows(kind: string, partition: Uint8Array, fromSeq: bigint): Promise<Array<LogRowWrite & { ts: HlcTs }>> {
    const r = await this.query(
      `SELECT slot, partition, seq, generation, epoch, kind, schema_v, ts::STRING AS ts, identity, emits, audit, retention, key_id, payload, chain
         FROM ${assertIdentifier(tableNames(kind).log)} WHERE partition = $1 AND seq >= $2 ORDER BY seq`, [toPg(partition), fromSeq.toString()]);
    return (r.rows as Row[]).map((x) => ({
      slot: Number(x['slot']), partition: bytes(x['partition']), seq: big(x['seq']), generation: Number(x['generation']), epoch: big(x['epoch']),
      kind: Number(x['kind']), schemaV: Number(x['schema_v']), ts: hlc(String(x['ts'])), identity: bytes(x['identity']), emits: bytes(x['emits']),
      audit: bytes(x['audit']), retention: Number(x['retention']), keyId: bytes(x['key_id']), payload: bytes(x['payload']), chain: bytes(x['chain']),
    }));
  }

  async tailLog(kind: string, slots: SlotNo[], afterTs: HlcTs | null, at: 'follower' | 'present'):
    Promise<{ rows: Array<LogRowWrite & { ts: HlcTs }>; through: HlcTs }> {
    const sql = `SELECT slot, partition, seq, generation, epoch, kind, schema_v, ts::STRING AS ts, identity, emits, audit, retention, key_id, payload, chain
         FROM ${assertIdentifier(tableNames(kind).log)} WHERE slot = ANY($1::INT4[]) AND ($2::DECIMAL IS NULL OR ts > $2::DECIMAL)
        ORDER BY ts, partition, seq`;
    let through: HlcTs;
    let rows: Row[];
    if (at === 'present') {
      // Only a taking-over standby reads the live tail at the present timestamp (RFC-006 §4.4).
      [rows, through] = await this.tx(async (q) => {
        const r = await q(sql, [slots, afterTs]);
        const t = await q('SELECT cluster_logical_timestamp()::STRING AS ts');
        return [r, hlc(String(t[0]?.['ts']))] as [Row[], HlcTs];
      }, 'BEGIN PRIORITY HIGH');
    } else {
      const f = await this.query(`SELECT ((extract(epoch FROM follower_read_timestamp()) * 1000000)::INT8 * 1000)::STRING AS ns`);
      through = hlc(String((f.rows[0] as Row)['ns']));
      rows = await this.tx((q) => q(sql, [slots, afterTs]), `BEGIN AS OF SYSTEM TIME '${through}'`);
    }
    return { through, rows: rows.map((x) => ({
      slot: Number(x['slot']), partition: bytes(x['partition']), seq: big(x['seq']), generation: Number(x['generation']), epoch: big(x['epoch']),
      kind: Number(x['kind']), schemaV: Number(x['schema_v']), ts: hlc(String(x['ts'])), identity: bytes(x['identity']), emits: bytes(x['emits']),
      audit: bytes(x['audit']), retention: Number(x['retention']), keyId: bytes(x['key_id']), payload: bytes(x['payload']), chain: bytes(x['chain']),
    })) };
  }

  async listPartitions(kind: string, slot: SlotNo): Promise<Uint8Array[]> {
    const r = await this.query(`SELECT partition FROM ${assertIdentifier(tableNames(kind).head)} WHERE slot = $1 AND adopted`, [slot]);
    return (r.rows as Row[]).map((x) => bytes(x['partition']));
  }

  async pendingMovesFrom(kind: string, fromSlot: SlotNo): Promise<Array<{ partition: Uint8Array; to: SlotNo; ts: HlcTs }>> {
    const t = tableNames(kind);
    // V59-7: unadopted heads whose last row (the `moved` entry, found by the (partition, seq) index) this slot wrote.
    const r = await this.query(
      `SELECT h.partition, h.slot, h.ts::STRING AS ts FROM ${assertIdentifier(t.head)} AS h
         JOIN ${assertIdentifier(t.log)} AS l ON l.partition = h.partition AND l.seq = h.seq
        WHERE NOT h.adopted AND h.slot <> $1 AND l.slot = $1`, [fromSlot]);
    return (r.rows as Row[]).map((x) => ({ partition: bytes(x['partition']), to: Number(x['slot']), ts: hlc(String(x['ts'])) }));
  }

  async readReportThrough(kind: string, slot: SlotNo, minTs: HlcTs): Promise<HlcTs | null> {
    // C01 §3.3 step 5: a bounded-staleness point read; report_through is monotone, so any timestamp ≥ minTs will do.
    const r = await this.query(
      `SELECT report_through::STRING AS rt FROM owner_slot AS OF SYSTEM TIME with_min_timestamp('${ceilMicrosLiteral(minTs)}'::TIMESTAMPTZ)
        WHERE kind = $1 AND slot = $2`, [kind, slot]);
    const v = (r.rows as Row[])[0]?.['rt'];
    return v === null || v === undefined ? null : hlc(String(v));
  }

  async readTiming(shard: number): Promise<TimingRow> {
    return readTiming(async (sql, p) => (await this.query(sql, p)).rows as Row[], shard);
  }

  async withReadTx<T>(at: 'present' | HlcTs, fn: (tx: ReadTx) => Promise<T>): Promise<T> {
    const begin = at === 'present' ? 'BEGIN PRIORITY HIGH' : `BEGIN AS OF SYSTEM TIME '${hlc(at)}'`;
    return this.tx((q) => fn({ query: async <R extends Record<string, unknown>>(sql: string, p?: unknown[]) => (await q(sql, (p ?? []).map(toPg))) as R[] }), begin);
  }

  async followerRead<T>(fn: (tx: ReadTx) => Promise<T>): Promise<{ value: T; servedAt: HlcTs }> {
    const r = await this.query(
      `SELECT ((extract(epoch FROM follower_read_timestamp()) * 1000000)::INT8 * 1000)::STRING AS ns`);
    const servedAt = hlc(String((r.rows[0] as Row)['ns']));
    const value = await this.withReadTx(servedAt, fn);
    return { value, servedAt };
  }

  async close(): Promise<void> {
    for (const p of this.pools) await p.end();
  }
}

/** A connection-level failure: the gateway is not reachable (the next tier may be). */
function unreachable(e: unknown): boolean {
  const code = (e as { code?: unknown }).code;
  if (typeof code === 'string' && (code.startsWith('08') || ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(code))) return true;
  return e instanceof Error && /Connection terminated|connection.*(closed|ended)/i.test(e.message);
}

/** The `closure_emitter` role's read (C01 §2.3, §3.6): feed sequence per link from `<kind>_head.streams` as of `at`. */
export function pgFeedSeqReader(pool: Pick<pg.Pool, 'query'>): import('../closure/emitter.ts').FeedSeqReader {
  return {
    async feedSeqs(kind, stream, at, changedAfter) {
      const t = assertIdentifier(tableNames(kind).head);
      const r = await pool.query(
        `SELECT partition, streams FROM ${t} AS OF SYSTEM TIME '${hlc(at)}' WHERE ($1::DECIMAL IS NULL OR ts > $1::DECIMAL)`,
        [changedAfter]);
      const out: Array<{ link: Uint8Array; feedSeq: bigint }> = [];
      for (const row of r.rows as Row[]) {
        const s = decodeStreams(bytes(row['streams']))[stream];
        if (s !== undefined) out.push({ link: bytes(row['partition']), feedSeq: s });
      }
      return out;
    },
  };
}
