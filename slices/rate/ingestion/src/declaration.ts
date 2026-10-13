import type { OwnerDeclaration } from '@share/owner-runtime';
import { TOPIC_HANDOFF } from '@share/rate-common';

/** Entry kinds of `ingest_log` (RFC-003 §3.4). I1 writes `batch` and `epoch-opened`. */
export const INGEST_ENTRY = {
  batch: 1,
  dropAlert: 2,
  withdrawn: 3,
  dropCount: 4,
  epochOpened: 5,
  wrapOpened: 6,
  correction: 7,
  supersession: 8,
  identityConflict: 9,
  checkpoint: 10,
} as const;

/**
 * The metering ingestion owner kind (RFC-003 §3.4, §3.6; C01 §2.2). One partition for each
 * exporter. `ingest_log` is self-outboxed: the hand-off stream is derived from its rows by the
 * versioned emit function `emitHandoff` (RFC-006 §3.5).
 *
 * The topic is the C11 name `ingestion.handoff.v1`. It does not start with the kind name
 * `ingest`, which C01 §2.5 asks for (a contract issue that I1 records).
 */
export const ingestDeclaration: OwnerDeclaration = {
  kind: 'ingest',
  slotCount: 128,
  selfOutboxed: true,
  entryKinds: [
    { kind: INGEST_ENTRY.batch, name: 'batch', schemaVersions: [1], retention: '7y' },
    { kind: INGEST_ENTRY.dropAlert, name: 'drop-alert', schemaVersions: [1], retention: '7y' },
    { kind: INGEST_ENTRY.withdrawn, name: 'withdrawn', schemaVersions: [1], retention: '7y' },
    { kind: INGEST_ENTRY.dropCount, name: 'drop-count', schemaVersions: [1], retention: '7y' },
    { kind: INGEST_ENTRY.epochOpened, name: 'epoch-opened', schemaVersions: [1], retention: '7y' },
    { kind: INGEST_ENTRY.wrapOpened, name: 'wrap-opened', schemaVersions: [1], retention: '7y' },
    { kind: INGEST_ENTRY.correction, name: 'correction', schemaVersions: [1], retention: '7y' },
    { kind: INGEST_ENTRY.supersession, name: 'supersession', schemaVersions: [1], retention: '7y' },
    { kind: INGEST_ENTRY.identityConflict, name: 'identity-conflict', schemaVersions: [1], retention: '7y' },
    { kind: INGEST_ENTRY.checkpoint, name: 'checkpoint', schemaVersions: [1], retention: 'ops' },
  ],
  projections: [
    { name: 'format', ddl: 'partition BYTES NOT NULL, format STRING NOT NULL, PRIMARY KEY (partition)',
      clearColumns: ['partition', 'format'] },
    { name: 'epoch', ddl: 'partition BYTES NOT NULL, observation_domain INT8 NOT NULL, epoch INT8 NOT NULL, init_time_ms INT8 NOT NULL, PRIMARY KEY (partition, observation_domain, epoch)',
      clearColumns: ['partition', 'observation_domain', 'epoch', 'init_time_ms'] },
    { name: 'range_chunk', ddl: 'partition BYTES NOT NULL, observation_domain INT8 NOT NULL, epoch INT8 NOT NULL, lo INT8 NOT NULL, intervals BYTES NOT NULL, PRIMARY KEY (partition, observation_domain, epoch, lo)',
      clearColumns: ['partition', 'observation_domain', 'epoch', 'lo', 'intervals'] },
    { name: 'context', ddl: 'partition BYTES NOT NULL, context_hash STRING NOT NULL, log_seq INT8 NOT NULL, context BYTES NOT NULL, PRIMARY KEY (partition, context_hash)',
      clearColumns: ['partition', 'context_hash', 'log_seq', 'context'] },
  ],
  streams: [
    { name: 'handoff', topic: TOPIC_HANDOFF, key: 'partition', emitFn: { version: 1 }, closure: 'resolved', consumers: ['attr_a'] },
    // RFC-003 §3.4, §7: the drop alert and the drop report go on the C01 §2.10 alert feed (from I17).
    { name: 'drop_alert', topic: 'ingest.alert.v1', key: 'partition', emitFn: { version: 1 }, closure: 'none', consumers: [] },
    { name: 'drop_report', topic: 'ingest.alert.v1', key: 'partition', emitFn: { version: 1 }, closure: 'none', consumers: [] },
  ],
};
