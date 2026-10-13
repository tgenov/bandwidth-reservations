/**
 * Owner declarations of attribution stage A, attribution stage B and rating
 * (RFC-003 §4.2, §4.3, §5.1; C01 §2.2). The C06 and C11 topic names do not start with the
 * owner kind, which C01 §2.5 asks for (a contract issue that I1 records).
 */
import type { OwnerDeclaration } from '@share/owner-runtime';
import { TOPIC_PARTS } from '@share/rate-common';

export const ATTR_A_ENTRY = { processed: 1, bindingFact: 2, quarantine: 3, financeAttribution: 4, reversal: 5, checkpoint: 6 } as const;

export const attrADeclaration: OwnerDeclaration = {
  kind: 'attr_a',
  slotCount: 128,
  entryKinds: [
    { kind: ATTR_A_ENTRY.processed, name: 'processed', schemaVersions: [1], retention: '7y' },
    { kind: ATTR_A_ENTRY.bindingFact, name: 'binding-fact', schemaVersions: [1], retention: '7y' },
    { kind: ATTR_A_ENTRY.quarantine, name: 'quarantine', schemaVersions: [1], retention: '7y' },
    { kind: ATTR_A_ENTRY.financeAttribution, name: 'finance-attribution', schemaVersions: [1], retention: '7y' },
    { kind: ATTR_A_ENTRY.reversal, name: 'reversal', schemaVersions: [1], retention: '7y' },
    { kind: ATTR_A_ENTRY.checkpoint, name: 'checkpoint', schemaVersions: [1], retention: 'ops' },
  ],
  projections: [
    { name: 'position', ddl: 'partition BYTES NOT NULL, handoff_seq INT8 NOT NULL, binding_seq INT8 NOT NULL, PRIMARY KEY (partition)',
      clearColumns: ['partition', 'handoff_seq', 'binding_seq'] },
    { name: 'dest_seq', ddl: 'partition BYTES NOT NULL, account STRING NOT NULL, dest_seq INT8 NOT NULL, PRIMARY KEY (partition, account)',
      clearColumns: ['partition', 'account', 'dest_seq'] },
  ],
  streams: [
    // C11 Part IV is keyed by account, an exception to "key = producing partition" (C11 errata, F41-14).
    { name: 'parts', topic: TOPIC_PARTS, key: 'partition', emitFn: { version: 1 }, closure: 'none', consumers: ['attr_b'] },
  ],
};

export const ATTR_B_ENTRY = { parts: 1, checkpoint: 2 } as const;

export const attrBDeclaration: OwnerDeclaration = {
  kind: 'attr_b',
  slotCount: 256,
  slotGroupWith: 'rating',
  entryKinds: [
    { kind: ATTR_B_ENTRY.parts, name: 'parts', schemaVersions: [1], retention: '7y' },
    { kind: ATTR_B_ENTRY.checkpoint, name: 'checkpoint', schemaVersions: [1], retention: 'ops' },
  ],
  projections: [
    { name: 'producer_watermark', ddl: 'partition BYTES NOT NULL, stage_a_partition STRING NOT NULL, dest_seq INT8 NOT NULL, PRIMARY KEY (partition, stage_a_partition)',
      clearColumns: ['partition', 'stage_a_partition', 'dest_seq'] },
    { name: 'attachment', ddl: 'partition BYTES NOT NULL, exporter_id STRING NOT NULL, binding_id STRING NOT NULL, binding BYTES NOT NULL, PRIMARY KEY (partition, exporter_id, binding_id)',
      clearColumns: ['partition', 'exporter_id', 'binding_id', 'binding'] },
  ],
  streams: [],
};

export const RATING_ENTRY = {
  inputs: 1, accrualClosed: 2, usageClosed: 3, amendment: 4, fee: 5, emitted: 6, posted: 7, breach: 8, checkpoint: 9,
} as const;

export const TOPIC_UNPOSTED = 'rating.unposted-usage.v1';
export const TOPIC_CHARGES = 'rating.charge-lines.v1';
export const TOPIC_AFFECTED = 'rating.affected-marks.v1';
export const TOPIC_BREACH = 'rating.breach-report.v1';
export const TOPIC_USAGE_APPLIED = 'account.usage-applied.v1';
export const TOPIC_POSTING_ACKS = 'settlement.posting-acks.v1';

export const ratingDeclaration: OwnerDeclaration = {
  kind: 'rating',
  slotCount: 256,
  slotGroupWith: 'attr_b',
  entryKinds: [
    { kind: RATING_ENTRY.inputs, name: 'inputs', schemaVersions: [1], retention: '7y' },
    { kind: RATING_ENTRY.accrualClosed, name: 'accrual-closed', schemaVersions: [1], retention: '7y' },
    { kind: RATING_ENTRY.usageClosed, name: 'usage-closed', schemaVersions: [1], retention: '7y' },
    { kind: RATING_ENTRY.amendment, name: 'amendment', schemaVersions: [1], retention: '7y' },
    { kind: RATING_ENTRY.fee, name: 'fee', schemaVersions: [1], retention: '7y' },
    { kind: RATING_ENTRY.emitted, name: 'emitted', schemaVersions: [1], retention: '7y' },
    { kind: RATING_ENTRY.posted, name: 'posted', schemaVersions: [1], retention: '7y' },
    { kind: RATING_ENTRY.breach, name: 'breach', schemaVersions: [1], retention: '7y' },
    { kind: RATING_ENTRY.checkpoint, name: 'checkpoint', schemaVersions: [1], retention: 'ops' },
  ],
  projections: [
    { name: 'usage_line', ddl: 'partition BYTES NOT NULL, product STRING NOT NULL, route STRING NOT NULL, minute INT8 NOT NULL, line BYTES NOT NULL, PRIMARY KEY (partition, product, route, minute)',
      clearColumns: ['partition', 'product', 'route', 'minute', 'line'] },
    { name: 'applied', ddl: 'partition BYTES NOT NULL, identity BYTES NOT NULL, seq INT8 NOT NULL, PRIMARY KEY (partition, identity)',
      clearColumns: ['partition', 'identity', 'seq'] },
  ],
  streams: [
    { name: 'unposted', topic: TOPIC_UNPOSTED, key: 'partition', emitFn: { version: 1 }, closure: 'resolved', consumers: ['account'] },
    { name: 'charges', topic: TOPIC_CHARGES, key: 'partition', emitFn: { version: 1 }, closure: 'resolved', consumers: ['settlement'] },
    { name: 'affected', topic: TOPIC_AFFECTED, key: 'partition', emitFn: { version: 1 }, closure: 'resolved', consumers: [] },
    { name: 'breach', topic: TOPIC_BREACH, key: 'partition', emitFn: { version: 1 }, closure: 'resolved', consumers: [] },
  ],
};
