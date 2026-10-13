import type { OwnerDeclaration } from '@share/owner-runtime';
import { PARAMS, assertDeclaration, reverseBits20, tableNames } from '@share/owner-runtime';

export interface Migration { id: string; statements: string[] }

const OUTBOX_GC_SECONDS = 25 * 3600;    // C01 §7: outbox retention 26 h row TTL, 25 h GC

/** Platform tables shared by every kind (C01 §2.3): sessions, slots, timing, integrity stops. Idempotent. */
export function platformMigration(): Migration {
  const timingSeeds = Array.from({ length: PARAMS.timingShards }, (_, s) =>
    `(${s}, 1, ${PARAMS.epsilonMs}, 320, 420, '{}'::JSONB)`).join(', ');
  return {
    id: 'platform-v1',
    statements: [
      `CREATE TABLE IF NOT EXISTS platform_migrations (
  id STRING PRIMARY KEY, statements INT4 NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
      // owner_session: hash-sharded over 64 shards by the explicit shard column (plan I1 item 1).
      `CREATE TABLE IF NOT EXISTS owner_session (
  shard INT2 NOT NULL CHECK (shard >= 0 AND shard < ${PARAMS.sessionShards}), session_id UUID NOT NULL,
  host STRING, region STRING, facility STRING, kind STRING,
  started_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, revoked BOOL NOT NULL DEFAULT false,
  PRIMARY KEY (shard, session_id)
)`,
      `CREATE TABLE IF NOT EXISTS owner_slot (
  kind STRING NOT NULL, slot INT4 NOT NULL,
  session_id UUID NULL, epoch INT8 NOT NULL, acquired_at TIMESTAMPTZ, slot_group STRING NULL,
  stops_version INT8 NOT NULL DEFAULT 0,
  report_through DECIMAL NULL,
  marker_seq INT8 NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, slot)
)`,
      // C01 §8: columns may be added with a default; keep older dev databases current.
      `ALTER TABLE owner_slot ADD COLUMN IF NOT EXISTS stops_version INT8 NOT NULL DEFAULT 0`,
      `ALTER TABLE owner_slot ADD COLUMN IF NOT EXISTS report_through DECIMAL NULL`,
      `ALTER TABLE owner_slot ADD COLUMN IF NOT EXISTS marker_seq INT8 NOT NULL DEFAULT 0`,
      `CREATE TABLE IF NOT EXISTS platform_timing (
  shard INT2 NOT NULL, version INT8 NOT NULL,
  epsilon_ms INT4 NOT NULL, delta_x_ms INT4 NOT NULL, tau_ms INT4 NOT NULL,
  second_lane JSONB NOT NULL,
  PRIMARY KEY (shard)
)`,
      `INSERT INTO platform_timing (shard, version, epsilon_ms, delta_x_ms, tau_ms, second_lane) VALUES ${timingSeeds}
  ON CONFLICT (shard) DO NOTHING`,
      `CREATE TABLE IF NOT EXISTS placement_integrity_stops (
  kind STRING, partition BYTES, detection_ref BYTES NOT NULL,
  state STRING CHECK (state IN ('stopped','resumed')), checkpoint BYTES NULL, at DECIMAL NOT NULL,
  PRIMARY KEY (kind, partition, detection_ref)
)`,
      // TODO(I1b, C01 §2.3 Grants and named platform read roles; CP-2c, CP-11): roles, grants, row-level security.
      // TODO(I1b, C01 §2.3 placement tables): placement_account_slot_map, overrides, moves, probe accounts, split acks.
    ],
  };
}

function projectionStatement(d: OwnerDeclaration, p: OwnerDeclaration['projections'][number]): string {
  const table = tableNames(d.kind).projection(p.name);
  const body = /^\s*CREATE\s+TABLE/i.test(p.ddl)
    ? p.ddl.replace(/^\s*CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?\S+\s*\(/i, '').replace(/\)\s*;?\s*$/, '')
    : p.ddl;
  const ttl = p.rowTtl
    ? ` WITH (ttl_expiration_expression = '(${p.rowTtl.column} + INTERVAL ''${p.rowTtl.after}'')')`
    : '';
  return `CREATE TABLE IF NOT EXISTS ${table} (\n  ${body.trim()}\n)${ttl}`;
}

/** Split points: every 64 slots for kinds above 256 slots (account, link), else every slot (RFC-006 §3.6). */
export function splitSlots(slotCount: number): number[] {
  const step = slotCount > 256 ? 64 : 1;
  const out: number[] = [];
  for (let s = step; s < slotCount; s += step) out.push(s);
  return out;
}

/** The C01 §2.3 tables of one owner kind, generated from its declaration. Idempotent. */
export function kindMigration(d: OwnerDeclaration, opts: { presplit?: boolean } = {}): Migration {
  assertDeclaration(d);
  const t = tableNames(d.kind);
  const kindLit = `'${d.kind}'`;
  const statements: string[] = [
    `CREATE TABLE IF NOT EXISTS ${t.log} (
  slot INT4 NOT NULL, partition BYTES NOT NULL, seq INT8 NOT NULL, generation INT4 NOT NULL, epoch INT8 NOT NULL,
  kind INT2 NOT NULL, schema_v INT2 NOT NULL, ts DECIMAL NOT NULL, identity BYTES NOT NULL, emits BYTES NOT NULL,
  audit BYTES NOT NULL, retention INT2 NOT NULL, key_id BYTES NOT NULL, payload BYTES NOT NULL,
  chain BYTES NOT NULL CHECK (length(chain) = 32),
  PRIMARY KEY (slot, partition, seq),
  UNIQUE INDEX ${t.log}_by_partition (partition, seq)
)`,
    `CREATE TABLE IF NOT EXISTS ${t.head} (
  home_key INT4 NOT NULL, partition BYTES NOT NULL, slot INT4 NOT NULL, generation INT4 NOT NULL,
  adopted BOOL NOT NULL DEFAULT true, seq INT8 NOT NULL, ts DECIMAL NOT NULL, epoch INT8 NOT NULL,
  streams BYTES NOT NULL, chain BYTES NOT NULL, batch_id BYTES NOT NULL,
  PRIMARY KEY (home_key, partition)
)`,
    `ALTER TABLE ${t.head} ADD COLUMN IF NOT EXISTS adopted BOOL NOT NULL DEFAULT true`,
    `CREATE TABLE IF NOT EXISTS ${t.outbox} (
  slot INT4 NOT NULL, partition BYTES NOT NULL, stream STRING NOT NULL, stream_seq INT8 NOT NULL, n INT4 NOT NULL,
  topic STRING NOT NULL, msg_key BYTES NOT NULL, headers BYTES NOT NULL, payload BYTES NOT NULL,
  ts DECIMAL NOT NULL, generation INT4 NOT NULL, epoch INT8 NOT NULL,
  PRIMARY KEY (slot, partition, stream, stream_seq, n),
  INDEX ${t.outbox}_by_stream (partition, stream, stream_seq)
) WITH (ttl_expire_after = '26 hours', ttl_disable_changefeed_replication = true)`,
    `ALTER TABLE ${t.outbox} CONFIGURE ZONE USING gc.ttlseconds = ${OUTBOX_GC_SECONDS}`,
    ...d.projections.map((p) => projectionStatement(d, p)),
    `INSERT INTO owner_slot (kind, slot, session_id, epoch)
  SELECT ${kindLit}, s, NULL, 0 FROM generate_series(0, ${d.slotCount - 1}) AS s
  ON CONFLICT (kind, slot) DO NOTHING`,
  ];
  if (opts.presplit !== false) {
    const splits = splitSlots(d.slotCount);
    if (splits.length > 0) {
      statements.push(`ALTER TABLE ${t.log} SPLIT AT VALUES ${splits.map((s) => `(${s})`).join(', ')}`);
      statements.push(`ALTER TABLE ${t.outbox} SPLIT AT VALUES ${splits.map((s) => `(${s})`).join(', ')}`);
      // A slot's homes s, s+n, s+2n… reverse to one contiguous home_key range starting at reverse(s) (RFC-006 §3.7).
      const headSplits = [...new Set(splits.map(reverseBits20))].sort((a, b) => a - b);
      statements.push(`ALTER TABLE ${t.head} SPLIT AT VALUES ${headSplits.map((h) => `(${h})`).join(', ')}`);
      statements.push(`ALTER TABLE owner_slot SPLIT AT VALUES ${[0, ...splits.filter((s) => s % 64 === 0)].map((s) => `(${kindLit}, ${s})`).join(', ')}`);
    }
  }
  // TODO(I2, C01 §2.3 self-outboxed kinds): <kind>_stream_index; refused by validateDeclaration for now.
  // TODO(I1b, C01 §2.3 Grants): owner role <kind> grants, DELETE only on deletable projections, RLS by kind.
  return { id: `kind-${d.kind}-v1`, statements };
}
