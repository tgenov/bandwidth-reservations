/**
 * The CockroachDB `SlotMapStore` of placement's account slot map (C01 §2.3; RFC-006 §7.1; plan S-PLAT-I3 work item 6).
 *
 * C01 §2.3 tables and how this store uses them:
 * - `placement_account_slot_map`: one row per version. `split_state` holds encodeJson({ previousCount, splitState })
 *   (C01 has no previousCount column); `probe_delta` holds encodeJson(probeAccounts); `overrides_digest` is SHA-256
 *   over encodeJson(overrides) and is checked on every read.
 * - `placement_slot_override`: one row per (account, version) where the account's override is new or changed in that
 *   version. The overrides of version v are, per account, the row with the highest version ≤ v.
 * - `placement_probe_accounts`, `placement_split_acks`: as C01 §2.3.
 * Tables that C01 §2.3 does not have (created by `ensure()`; see the design issues of S-PLAT-I3):
 * - `placement_split_ack_partitions`: the upper-half list of each ack (RFC-006 §7.1 records it; C01's DDL has no column).
 * - `placement_slot_map_requests`: reslot and doubleSlotCount requests by requestId (C01 §5 idempotency).
 * - `placement_slot_map_doubling`: the progress of the current doubling (one row).
 * A SQLSTATE 40001 runs a transaction again from BEGIN.
 */
import { createHash } from 'node:crypto';
import type { MapVersion, SlotMapVersion, SlotNo, SplitState } from '../api.ts';
import { bytesEqual, decodeJson, encodeJson, hex, toBuffer } from '../bytes.ts';
import { isRetryable } from '../errors.ts';
import { hlc } from '../hlc.ts';
import {
  SlotMapError, type DoublingState, type ProbeAccountRow, type RequestRow, type SlotMapStore, type SplitAckRow,
} from './slot-map-service.ts';

/** The part of a `pg.PoolClient` that the store uses. */
export interface SlotMapPgClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(err?: Error): void;
}

/** The part of a `pg.Pool` that the store uses. */
export interface SlotMapPgPool {
  connect(): Promise<SlotMapPgClient>;
}

/** The statements that create the tables C01 §2.3 does not have (idempotent). */
export const SLOT_MAP_EXTRA_TABLES = [
  `CREATE TABLE IF NOT EXISTS placement_split_ack_partitions (
  slot INT4, map_version INT8, epoch INT8 NOT NULL, upper_half BYTES NOT NULL, PRIMARY KEY (slot, map_version)
)`,
  `CREATE TABLE IF NOT EXISTS placement_slot_map_requests (
  request_id BYTES PRIMARY KEY, op STRING NOT NULL CHECK (op IN ('reslot','double')), digest BYTES NOT NULL, answer BYTES NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS placement_slot_map_doubling (
  singleton INT4 PRIMARY KEY CHECK (singleton = 1), state BYTES NOT NULL
)`,
] as const;

type Row = Record<string, unknown>;
type Q = (sql: string, params?: unknown[]) => Promise<Row[]>;

const bytesOf = (v: unknown): Uint8Array => {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  throw new TypeError(`expected BYTES, got ${typeof v}`);
};
const sha256 = (b: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(b).digest());
const limitState = (v: unknown): ProbeAccountRow['limitState'] => {
  if (v === 'pending' || v === 'applied') return v;
  throw new TypeError(`unknown limit_state ${String(v)}`);
};
const reason = (v: unknown): SlotMapVersion['overrides'][number]['reason'] => {
  if (v === 'probe_pin' || v === 'probe_new' || v === 'reslot' || v === 'dedicated') return v;
  throw new TypeError(`unknown override reason ${String(v)}`);
};
const op = (v: unknown): RequestRow['op'] => {
  if (v === 'reslot' || v === 'double') return v;
  throw new TypeError(`unknown request op ${String(v)}`);
};

/** `SlotMapStore` on CockroachDB through a pool of the `placement` role. */
export class PgSlotMapStore implements SlotMapStore {
  private readonly pool: SlotMapPgPool;
  private readonly maxAttempts: number;

  constructor(o: { pool: SlotMapPgPool; maxAttempts?: number }) {
    this.pool = o.pool;
    this.maxAttempts = o.maxAttempts ?? 10;
  }

  /** Creates the tables that C01 §2.3 does not have (the C01 tables come from the platform migration). */
  async ensure(): Promise<void> {
    await this.tx(async (q) => { for (const s of SLOT_MAP_EXTRA_TABLES) await q(s); });
  }

  private async tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    let broken: Error | undefined;
    const q: Q = async (sql, params) => (await c.query(sql, params)).rows;
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await c.query('BEGIN');
          const value = await fn(q);
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

  async versions(): Promise<SlotMapVersion[]> {
    return this.tx(async (q) => {
      const rows = await q(`SELECT version, slot_count, split_state, overrides_digest, probe_delta, published_at::STRING AS published_at
        FROM placement_account_slot_map ORDER BY version`);
      const ovr = await q('SELECT account, version, slot, reason FROM placement_slot_override ORDER BY version, account');
      const current = new Map<string, SlotMapVersion['overrides'][number]>();
      let i = 0;
      return rows.map((r) => {
        const version = BigInt(String(r['version']));
        for (let o = ovr[i]; o !== undefined && BigInt(String(o['version'])) <= version; o = ovr[++i]) {
          const account = bytesOf(o['account']);
          current.set(hex(account), { account, slot: Number(o['slot']), reason: reason(o['reason']) });
        }
        const overrides = [...current.values()].sort((a, b) => (hex(a.account) < hex(b.account) ? -1 : 1)).map((x) => ({ ...x }));
        if (!bytesEqual(sha256(encodeJson(overrides)), bytesOf(r['overrides_digest']))) {
          throw new SlotMapError('VERSION_CONFLICT', `the override rows of version ${version} do not match its digest`);
        }
        const split = decodeJson(bytesOf(r['split_state'])) as { previousCount?: number; splitState: Record<SlotNo, SplitState> };
        return {
          version, slotCount: Number(r['slot_count']),
          ...(split.previousCount !== undefined ? { previousCount: split.previousCount } : {}),
          splitState: split.splitState, overrides,
          probeAccounts: decodeJson(bytesOf(r['probe_delta'])) as SlotMapVersion['probeAccounts'],
          publishedAt: hlc(String(r['published_at'])),
        };
      });
    });
  }

  async insertVersion(v: SlotMapVersion): Promise<void> {
    const split = encodeJson({ previousCount: v.previousCount, splitState: v.splitState });
    const digest = sha256(encodeJson(v.overrides));
    const delta = encodeJson(v.probeAccounts);
    await this.tx(async (q) => {
      const prev = (await q(`SELECT slot_count, split_state, overrides_digest, probe_delta, published_at::STRING AS published_at
        FROM placement_account_slot_map WHERE version = $1`, [v.version.toString()]))[0];
      if (prev) {
        const same = Number(prev['slot_count']) === v.slotCount && bytesEqual(bytesOf(prev['split_state']), split)
          && bytesEqual(bytesOf(prev['overrides_digest']), digest) && bytesEqual(bytesOf(prev['probe_delta']), delta)
          && hlc(String(prev['published_at'])) === v.publishedAt;
        if (!same) throw new SlotMapError('VERSION_CONFLICT', `version ${v.version} exists with other content`);
        return;
      }
      await q(`INSERT INTO placement_account_slot_map (version, slot_count, split_state, overrides_digest, probe_delta, published_at)
        VALUES ($1, $2, $3, $4, $5, $6::DECIMAL)`, [v.version.toString(), v.slotCount, toBuffer(split), toBuffer(digest), toBuffer(delta), v.publishedAt]);
      const last = new Map<string, { slot: number; reason: string }>();
      for (const r of await q(`SELECT DISTINCT ON (account) account, slot, reason FROM placement_slot_override
        WHERE version < $1 ORDER BY account, version DESC`, [v.version.toString()])) {
        last.set(hex(bytesOf(r['account'])), { slot: Number(r['slot']), reason: String(r['reason']) });
      }
      for (const o of v.overrides) {
        const l = last.get(hex(o.account));
        if (l && l.slot === o.slot && l.reason === o.reason) continue;
        await q('INSERT INTO placement_slot_override (account, version, slot, reason, operator) VALUES ($1, $2, $3, $4, NULL)',
          [toBuffer(o.account), v.version.toString(), o.slot, o.reason]);
      }
    });
  }

  async probeAccounts(): Promise<ProbeAccountRow[]> {
    const rows = await this.tx((q) => q('SELECT slot, account, designated_in, limit_state FROM placement_probe_accounts ORDER BY slot'));
    return rows.map((r) => ({
      slot: Number(r['slot']), account: bytesOf(r['account']), designatedIn: BigInt(String(r['designated_in'])), limitState: limitState(r['limit_state']),
    }));
  }

  async putProbeAccount(r: ProbeAccountRow): Promise<void> {
    await this.tx((q) => q('UPSERT INTO placement_probe_accounts (slot, account, designated_in, limit_state) VALUES ($1, $2, $3, $4)',
      [r.slot, toBuffer(r.account), r.designatedIn.toString(), r.limitState]));
  }

  async splitAck(slot: SlotNo, mapVersion: MapVersion): Promise<SplitAckRow | undefined> {
    const r = (await this.tx((q) => q(`SELECT a.epoch, a.acked_at::STRING AS acked_at, p.upper_half FROM placement_split_acks a
      JOIN placement_split_ack_partitions p ON p.slot = a.slot AND p.map_version = a.map_version
      WHERE a.slot = $1 AND a.map_version = $2`, [slot, mapVersion.toString()])))[0];
    if (!r) return undefined;
    return {
      slot, mapVersion, epoch: BigInt(String(r['epoch'])), ackedAt: hlc(String(r['acked_at'])),
      upperHalf: decodeJson(bytesOf(r['upper_half'])) as Uint8Array[],
    };
  }

  async putSplitAck(r: SplitAckRow): Promise<void> {
    await this.tx(async (q) => {
      await q('UPSERT INTO placement_split_acks (slot, map_version, epoch, acked_at) VALUES ($1, $2, $3, $4::DECIMAL)',
        [r.slot, r.mapVersion.toString(), r.epoch.toString(), r.ackedAt]);
      await q('UPSERT INTO placement_split_ack_partitions (slot, map_version, epoch, upper_half) VALUES ($1, $2, $3, $4)',
        [r.slot, r.mapVersion.toString(), r.epoch.toString(), toBuffer(encodeJson(r.upperHalf))]);
    });
  }

  async request(requestId: Uint8Array): Promise<RequestRow | undefined> {
    const r = (await this.tx((q) => q('SELECT op, digest, answer FROM placement_slot_map_requests WHERE request_id = $1', [toBuffer(requestId)])))[0];
    return r && { requestId, op: op(r['op']), digest: bytesOf(r['digest']), answer: bytesOf(r['answer']) };
  }

  async putRequest(r: RequestRow): Promise<void> {
    await this.tx((q) => q(`INSERT INTO placement_slot_map_requests (request_id, op, digest, answer) VALUES ($1, $2, $3, $4)
      ON CONFLICT (request_id) DO NOTHING`, [toBuffer(r.requestId), r.op, toBuffer(r.digest), toBuffer(r.answer)]));
  }

  async doubling(): Promise<DoublingState | undefined> {
    const r = (await this.tx((q) => q('SELECT state FROM placement_slot_map_doubling WHERE singleton = 1')))[0];
    return r && decodeJson(bytesOf(r['state'])) as DoublingState;
  }

  async putDoubling(s: DoublingState): Promise<void> {
    await this.tx((q) => q('UPSERT INTO placement_slot_map_doubling (singleton, state) VALUES (1, $1)', [toBuffer(encodeJson(s))]));
  }
}
