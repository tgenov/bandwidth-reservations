-- Substrate bench (S-PLAT-SP1 (a)): the synthetic tables on YugabyteDB (YSQL), for the comparison in SP3.
-- The same columns and keys as schema.crdb.sql, with PostgreSQL types. Primary keys are range-sharded (ASC), so a
-- slot's rows stay together as on CockroachDB (RFC-006 §3.7). Differences from CockroachDB:
-- - no row TTL on the outbox (YugabyteDB YSQL has no row-level TTL); the bench does not depend on it;
-- - no pre-split by slot; tablets split automatically;
-- - the ts column holds the transaction timestamp in ns, not the HLC (sql.ts DIALECTS.yugabyte).
-- A statement ends with ";" at the end of a line.

CREATE TABLE IF NOT EXISTS owner_slot (
  kind TEXT NOT NULL, slot INT NOT NULL,
  session_id UUID NULL, epoch BIGINT NOT NULL, acquired_at TIMESTAMPTZ, slot_group TEXT NULL,
  stops_version BIGINT NOT NULL DEFAULT 0,
  report_through DECIMAL NULL,
  marker_seq BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (kind ASC, slot ASC)
);

CREATE TABLE IF NOT EXISTS platform_timing (
  shard SMALLINT NOT NULL, version BIGINT NOT NULL,
  epsilon_ms INT NOT NULL, delta_x_ms INT NOT NULL, tau_ms INT NOT NULL,
  second_lane JSONB NOT NULL,
  PRIMARY KEY (shard ASC)
);

CREATE TABLE IF NOT EXISTS account_log (
  slot INT NOT NULL, partition BYTEA NOT NULL, seq BIGINT NOT NULL, generation INT NOT NULL, epoch BIGINT NOT NULL,
  kind SMALLINT NOT NULL, schema_v SMALLINT NOT NULL, ts DECIMAL NOT NULL, identity BYTEA NOT NULL, emits BYTEA NOT NULL,
  audit BYTEA NOT NULL, retention SMALLINT NOT NULL, key_id BYTEA NOT NULL, payload BYTEA NOT NULL,
  chain BYTEA NOT NULL CHECK (octet_length(chain) = 32),
  PRIMARY KEY (slot ASC, partition ASC, seq ASC)
);

CREATE UNIQUE INDEX IF NOT EXISTS account_log_by_partition ON account_log (partition ASC, seq ASC);

CREATE TABLE IF NOT EXISTS account_head (
  home_key INT NOT NULL, partition BYTEA NOT NULL, slot INT NOT NULL, generation INT NOT NULL,
  adopted BOOLEAN NOT NULL DEFAULT true, seq BIGINT NOT NULL, ts DECIMAL NOT NULL, epoch BIGINT NOT NULL,
  streams BYTEA NOT NULL, chain BYTEA NOT NULL, batch_id BYTEA NOT NULL,
  PRIMARY KEY (home_key ASC, partition ASC)
);

CREATE TABLE IF NOT EXISTS account_outbox (
  slot INT NOT NULL, partition BYTEA NOT NULL, stream TEXT NOT NULL, stream_seq BIGINT NOT NULL, n INT NOT NULL,
  topic TEXT NOT NULL, msg_key BYTEA NOT NULL, headers BYTEA NOT NULL, payload BYTEA NOT NULL,
  ts DECIMAL NOT NULL, generation INT NOT NULL, epoch BIGINT NOT NULL,
  PRIMARY KEY (slot ASC, partition ASC, stream ASC, stream_seq ASC, n ASC)
);

CREATE INDEX IF NOT EXISTS account_outbox_by_stream ON account_outbox (partition ASC, stream ASC, stream_seq ASC);

CREATE TABLE IF NOT EXISTS account_requests (
  partition BYTEA NOT NULL, request_id BYTEA NOT NULL, state TEXT NOT NULL, body BYTEA NOT NULL, ts DECIMAL NOT NULL,
  PRIMARY KEY (partition ASC, request_id ASC)
);
