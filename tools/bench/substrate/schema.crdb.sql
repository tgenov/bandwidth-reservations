-- Substrate bench (S-PLAT-SP1 (a)): the synthetic tables on CockroachDB.
-- The shapes are those of platform/migrate/src/generate.ts (C01 §2.3) for an owner kind named "account":
-- owner_slot (the fence), platform_timing, the log, the head, the outbox (26 h row TTL, 25 h GC) and one
-- projection (account_requests, partition-led key, RFC-006 §3.7). The bench applies this file in
-- SUBSTRATE_MODE=setup, then the slot splits and the seed rows. Placement: placement.crdb.sql.
-- A statement ends with ";" at the end of a line.

CREATE TABLE IF NOT EXISTS owner_slot (
  kind STRING NOT NULL, slot INT4 NOT NULL,
  session_id UUID NULL, epoch INT8 NOT NULL, acquired_at TIMESTAMPTZ, slot_group STRING NULL,
  stops_version INT8 NOT NULL DEFAULT 0,
  report_through DECIMAL NULL,
  marker_seq INT8 NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, slot)
);

CREATE TABLE IF NOT EXISTS platform_timing (
  shard INT2 NOT NULL, version INT8 NOT NULL,
  epsilon_ms INT4 NOT NULL, delta_x_ms INT4 NOT NULL, tau_ms INT4 NOT NULL,
  second_lane JSONB NOT NULL,
  PRIMARY KEY (shard)
);

CREATE TABLE IF NOT EXISTS account_log (
  slot INT4 NOT NULL, partition BYTES NOT NULL, seq INT8 NOT NULL, generation INT4 NOT NULL, epoch INT8 NOT NULL,
  kind INT2 NOT NULL, schema_v INT2 NOT NULL, ts DECIMAL NOT NULL, identity BYTES NOT NULL, emits BYTES NOT NULL,
  audit BYTES NOT NULL, retention INT2 NOT NULL, key_id BYTES NOT NULL, payload BYTES NOT NULL,
  chain BYTES NOT NULL CHECK (length(chain) = 32),
  PRIMARY KEY (slot, partition, seq),
  UNIQUE INDEX account_log_by_partition (partition, seq)
);

CREATE TABLE IF NOT EXISTS account_head (
  home_key INT4 NOT NULL, partition BYTES NOT NULL, slot INT4 NOT NULL, generation INT4 NOT NULL,
  adopted BOOL NOT NULL DEFAULT true, seq INT8 NOT NULL, ts DECIMAL NOT NULL, epoch INT8 NOT NULL,
  streams BYTES NOT NULL, chain BYTES NOT NULL, batch_id BYTES NOT NULL,
  PRIMARY KEY (home_key, partition)
);

CREATE TABLE IF NOT EXISTS account_outbox (
  slot INT4 NOT NULL, partition BYTES NOT NULL, stream STRING NOT NULL, stream_seq INT8 NOT NULL, n INT4 NOT NULL,
  topic STRING NOT NULL, msg_key BYTES NOT NULL, headers BYTES NOT NULL, payload BYTES NOT NULL,
  ts DECIMAL NOT NULL, generation INT4 NOT NULL, epoch INT8 NOT NULL,
  PRIMARY KEY (slot, partition, stream, stream_seq, n),
  INDEX account_outbox_by_stream (partition, stream, stream_seq)
) WITH (ttl_expire_after = '26 hours', ttl_disable_changefeed_replication = true);

ALTER TABLE account_outbox CONFIGURE ZONE USING gc.ttlseconds = 90000;

CREATE TABLE IF NOT EXISTS account_requests (
  partition BYTES NOT NULL, request_id BYTES NOT NULL, state STRING NOT NULL, body BYTES NOT NULL, ts DECIMAL NOT NULL,
  PRIMARY KEY (partition, request_id)
);
