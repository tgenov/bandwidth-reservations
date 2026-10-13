/**
 * The ledger owner kind declaration (C01 §2.2, RFC-004 §B1.3). One C01 partition is one ledger partition.
 * The partition log `ledger_log` is the movement table that RFC-004 §B1.3 calls `ledger_movement`: one log
 * entry for each movement, insert-only by grants (C01 §2.3, CP-11). Every projection key starts with the
 * partition (C01 R47-01).
 */
import type { OwnerDeclaration } from '@share/owner-runtime';
import { TOPIC } from '../contracts/c06.ts';

export const LEDGER_KIND = 'ledger';

/** Entry kinds of the ledger log. */
export const LEDGER_ENTRY = {
  /** One committed movement (RFC-004 §B1.2). */
  movement: 1,
  /** A refused movement: recorded, moves nothing (RFC-004 §B1.2 "Validation at append"). */
  refusal: 2,
} as const;

/** Development slot count; placement sets the production count. */
export const LEDGER_DEV_SLOT_COUNT = 16;

export const LEDGER_TABLE = {
  /** Per (partition, ledger account): the balance through the head; a buyer row also has `W`. */
  balance: `${LEDGER_KIND}_balance`,
  /** Per (partition, line key): the postings of the line, its posted total and last sequence (RFC-004 §B1.4). */
  line: `${LEDGER_KIND}_line`,
  /** Per (partition, movementRef digest): the movement digest, the principal and the recorded answer (C06 M4). */
  movementRef: `${LEDGER_KIND}_movement_ref`,
  /** Per partition: the digest of the last movement, for the `prev` chain (RFC-004 §B1.2). */
  chain: `${LEDGER_KIND}_chain`,
} as const;

export const LEDGER_STREAM = {
  movements: 'movements',
  byBuyer: 'by_buyer',
  bySupplier: 'by_supplier',
  byExternal: 'by_external',
  postingAcks: 'posting_acks',
} as const;

/** The ledger declaration. `slotCount` is the slot count of the ledger kind (a power of two). */
export function ledgerDeclaration(slotCount = LEDGER_DEV_SLOT_COUNT): OwnerDeclaration {
  return {
    kind: LEDGER_KIND,
    slotCount,
    entryKinds: [
      { kind: LEDGER_ENTRY.movement, name: 'movement', schemaVersions: [1], retention: '7y' },
      { kind: LEDGER_ENTRY.refusal, name: 'refusal', schemaVersions: [1], retention: '7y' },
    ],
    projections: [
      { name: 'balance', ddl: 'partition BYTES NOT NULL, ledger_account STRING NOT NULL, balance INT8 NOT NULL, record BYTES NOT NULL, PRIMARY KEY (partition, ledger_account)',
        clearColumns: ['partition', 'ledger_account', 'balance'] },
      { name: 'line', ddl: 'partition BYTES NOT NULL, line_key STRING NOT NULL, record BYTES NOT NULL, PRIMARY KEY (partition, line_key)',
        clearColumns: ['partition', 'line_key'] },
      { name: 'movement_ref', ddl: 'partition BYTES NOT NULL, ref_digest STRING NOT NULL, record BYTES NOT NULL, PRIMARY KEY (partition, ref_digest)',
        clearColumns: ['partition', 'ref_digest'] },
      { name: 'chain', ddl: 'partition BYTES NOT NULL, record BYTES NOT NULL, PRIMARY KEY (partition)',
        clearColumns: ['partition'] },
    ],
    streams: [
      { name: LEDGER_STREAM.movements, topic: TOPIC.movements, key: 'partition', emitFn: { version: 1 }, closure: 'resolved',
        consumers: ['reporting', 'reconciliation', 'rating'] },
      { name: LEDGER_STREAM.byBuyer, topic: TOPIC.byBuyer, key: { field: 'view_key' }, emitFn: { version: 1 }, closure: 'resolved',
        consumers: ['account', 'receivables'] },
      { name: LEDGER_STREAM.bySupplier, topic: TOPIC.bySupplier, key: { field: 'view_key' }, emitFn: { version: 1 }, closure: 'resolved',
        consumers: ['payouts', 'settlement'] },
      { name: LEDGER_STREAM.byExternal, topic: TOPIC.byExternal, key: { field: 'view_key' }, emitFn: { version: 1 }, closure: 'resolved',
        consumers: ['reconciliation'] },
      // C06 topic table: no resolved markers on the posting acknowledgement (m10).
      { name: LEDGER_STREAM.postingAcks, topic: TOPIC.postingAcks, key: { field: 'account' }, emitFn: { version: 1 }, closure: 'none',
        consumers: ['rating'] },
    ],
  };
}
