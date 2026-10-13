/**
 * The CockroachDB store of placement's integrity stop (C01 §2.3, §2.6, §3.2; plan S-PLAT-I3 work item 9).
 *
 * One Stop or Resume is one transaction: BEGIN; read the stop rows of the detection ref; read the move rows of the
 * partition; `cluster_logical_timestamp()` (the commit timestamp: `enforced_at`); INSERT or UPDATE the row of
 * `placement_integrity_stops`; `placement_set_stops_version(kind, slot)` for each fenced slot (placement has no
 * UPDATE on `owner_slot`; V59-3 fallback, platform/migrate grants.ts); COMMIT. A SQLSTATE 40001 runs the
 * transaction again from BEGIN (RFC-006 §4.3).
 */
import type { HlcTs, SlotNo } from '../api.ts';
import { toBuffer } from '../bytes.ts';
import { isRetryable } from '../errors.ts';
import { hlc } from '../hlc.ts';
import {
  FenceSlotMissingError, type IntegrityStopRow, type IntegrityStopStore, type IntegrityStopTx, type PartitionMoveRow,
} from './integrity-stop.ts';

/** The part of a `pg.PoolClient` that the store uses. */
export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(err?: Error): void;
}

/** The part of a `pg.Pool` that the store uses. */
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}

/** Options of `PgIntegrityStopStore`. */
export interface PgIntegrityStopStoreOptions {
  /** A pool that connects as the `placement` role. */
  pool: PgPoolLike;
  /** Attempts of one transaction under SQLSTATE 40001 before the error goes to the caller. Default 10 (est.). */
  maxAttempts?: number;
}

const SELECT_STOPS = `SELECT kind, partition, detection_ref, state, at::STRING AS at, checkpoint, fenced_slots,
  resumed_at::STRING AS resumed_at, resume_fenced_slots, incident_decision_ref
  FROM placement_integrity_stops WHERE detection_ref = $1`;
const SELECT_MOVES = `SELECT from_slot, to_slot, generation, state FROM placement_partition_moves WHERE kind = $1 AND partition = $2`;
const SELECT_TS = `SELECT cluster_logical_timestamp()::STRING AS ts`;
const INSERT_STOP = `INSERT INTO placement_integrity_stops (kind, partition, detection_ref, state, checkpoint, at, fenced_slots)
  VALUES ($1, $2, $3, 'stopped', NULL, $4::DECIMAL, $5::INT4[])`;
const UPDATE_RESUME = `UPDATE placement_integrity_stops SET state = 'resumed', checkpoint = $4, resumed_at = $5::DECIMAL,
  resume_fenced_slots = $6::INT4[], incident_decision_ref = $7 WHERE kind = $1 AND partition = $2 AND detection_ref = $3`;
const BUMP = `SELECT placement_set_stops_version($1, $2) AS v`;

const bytesOf = (v: unknown): Uint8Array => {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  throw new TypeError(`expected BYTES, got ${typeof v}`);
};
const bytesOrNull = (v: unknown): Uint8Array | null => (v === null || v === undefined ? null : bytesOf(v));
const slotsOf = (v: unknown): SlotNo[] => (Array.isArray(v) ? v.map((x) => Number(x)) : []);
const tsOrNull = (v: unknown): HlcTs | null => (v === null || v === undefined ? null : hlc(String(v)));
const state = (v: unknown): IntegrityStopRow['state'] => {
  if (v === 'stopped' || v === 'resumed') return v;
  throw new TypeError(`unknown stop state ${String(v)}`);
};
const moveState = (v: unknown): PartitionMoveRow['state'] => {
  if (v === 'prewarm' || v === 'moved' || v === 'adopted' || v === 'done') return v;
  throw new TypeError(`unknown move state ${String(v)}`);
};

function rowOf(r: Record<string, unknown>): IntegrityStopRow {
  return {
    kind: String(r['kind']), partition: bytesOf(r['partition']), detectionRef: bytesOf(r['detection_ref']), state: state(r['state']),
    at: hlc(String(r['at'])), checkpoint: bytesOrNull(r['checkpoint']), fencedSlots: slotsOf(r['fenced_slots']),
    resumedAt: tsOrNull(r['resumed_at']),
    resumeFencedSlots: r['resume_fenced_slots'] === null || r['resume_fenced_slots'] === undefined ? null : slotsOf(r['resume_fenced_slots']),
    incidentDecisionRef: bytesOrNull(r['incident_decision_ref']),
  };
}

/** `IntegrityStopStore` on CockroachDB through a pool of the `placement` role. */
export class PgIntegrityStopStore implements IntegrityStopStore {
  private readonly pool: PgPoolLike;
  private readonly maxAttempts: number;

  constructor(o: PgIntegrityStopStoreOptions) {
    this.pool = o.pool;
    this.maxAttempts = o.maxAttempts ?? 10;
  }

  async transaction<T>(fn: (tx: IntegrityStopTx) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    let broken: Error | undefined;
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await c.query('BEGIN');
          const value = await fn(this.tx(c));
          await c.query('COMMIT');
          return value;
        } catch (e) {
          try { await c.query('ROLLBACK'); } catch (r) { broken = r instanceof Error ? r : new Error(String(r)); throw e; }
          if (!isRetryable(e) || attempt >= this.maxAttempts) throw e;
        }
      }
    } finally {
      c.release(broken);
    }
  }

  private tx(c: PgClientLike): IntegrityStopTx {
    let ts: HlcTs | undefined;
    return {
      movesOf: async (kind, partition) => (await c.query(SELECT_MOVES, [kind, toBuffer(partition)])).rows.map((r) => ({
        fromSlot: Number(r['from_slot']), toSlot: Number(r['to_slot']), generation: Number(r['generation']), state: moveState(r['state']),
      })),
      rowsByDetectionRef: async (ref) => (await c.query(SELECT_STOPS, [toBuffer(ref)])).rows.map(rowOf),
      commitTs: async () => {
        if (ts === undefined) {
          const r = (await c.query(SELECT_TS)).rows[0];
          if (r === undefined) throw new Error('cluster_logical_timestamp() returned no row');
          ts = hlc(String(r['ts']));
        }
        return ts;
      },
      insertStop: async (row) => {
        await c.query(INSERT_STOP, [row.kind, toBuffer(row.partition), toBuffer(row.detectionRef), row.at, row.fencedSlots]);
      },
      markResumed: async (row) => {
        await c.query(UPDATE_RESUME, [row.kind, toBuffer(row.partition), toBuffer(row.detectionRef),
          row.checkpoint === null ? null : toBuffer(row.checkpoint), row.resumedAt, row.resumeFencedSlots,
          row.incidentDecisionRef === null ? null : toBuffer(row.incidentDecisionRef)]);
      },
      bumpStopsVersion: async (kind, slot) => {
        const v = (await c.query(BUMP, [kind, slot])).rows[0]?.['v'];
        if (v === null || v === undefined) throw new FenceSlotMissingError(kind, slot);
      },
    };
  }
}
