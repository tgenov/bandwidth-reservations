/**
 * The account owner kind declaration (C01 §2.2). Entry kinds are the closed registry of
 * RFC-002 §2.2 (E1 … E16; E10 is retired and its number is not used again) and §2.3 (F1 … F11).
 * Every projection key starts with the account partition (RFC-002 §2.5, C01 R47-01).
 */
import type { OwnerDeclaration } from '@share/owner-runtime';

export const ACCOUNT_KIND = 'account';

/** Entry kind numbers. E-n has the number n. E1′ has 17. F-n has the number 100 + n. */
export const ENTRY = {
  E1: 1, E2: 2, E3: 3, E4: 4, E5: 5, E6: 6, E7: 7, E8: 8, E9: 9,
  E11: 11, E12: 12, E13: 13, E14: 14, E15: 15, E16: 16, E1p: 17,
  F1: 101, F2: 102, F3: 103, F4: 104, F5: 105, F6: 106, F7: 107, F8: 108, F9: 109, F10: 110, F11: 111,
} as const;

/** Development slot count. Production is about 16,384 (RFC-002 §2.5); placement sets it. */
export const DEV_SLOT_COUNT = 16;

export const TABLE = {
  request: `${ACCOUNT_KIND}_request`,
  decision: `${ACCOUNT_KIND}_decision`,
  idempotency: `${ACCOUNT_KIND}_idempotency`,
  reservation: `${ACCOUNT_KIND}_reservation`,
  changeQueue: `${ACCOUNT_KIND}_change_queue`,
  funds: `${ACCOUNT_KIND}_funds`,
  feedCheckpoint: `${ACCOUNT_KIND}_feed_checkpoint`,
} as const;

export function accountDeclaration(slotCount = DEV_SLOT_COUNT): OwnerDeclaration {
  const e = (kind: number, name: string, reportWanted = false) =>
    ({ kind, name, schemaVersions: [1], retention: '7y' as const, ...(reportWanted ? { reportWanted } : {}) });
  return {
    kind: ACCOUNT_KIND,
    slotCount,
    entryKinds: [
      e(ENTRY.E1, 'intake'),
      e(ENTRY.E1p, 'intake_decided', true),
      e(ENTRY.E2, 'waiting_mark'),
      e(ENTRY.E3, 'yield_or_displacement_accepted'),
      e(ENTRY.E4, 'withdraw', true),
      e(ENTRY.E5, 'confirm', true),
      e(ENTRY.E6, 'expire', true),
      e(ENTRY.E7, 'end', true),
      e(ENTRY.E8, 'releases_durable', true),
      e(ENTRY.E9, 'takeover'),
      e(ENTRY.E11, 'reservation_change', true),
      e(ENTRY.E12, 'leg_changes_durable', true),
      e(ENTRY.E13, 'offer'),
      e(ENTRY.E14, 'partner_leg_affected'),
      e(ENTRY.E15, 'operator_command_refused'),
      e(ENTRY.E16, 'residue_recorded'),
      e(ENTRY.F1, 'ledger_applied'),
      e(ENTRY.F2, 'usage_applied'),
      e(ENTRY.F3, 'exposure_parameters'),
      e(ENTRY.F4, 'identity_status'),
      e(ENTRY.F5, 'credit_limit'),
      e(ENTRY.F6, 'invoice_status'),
      e(ENTRY.F7, 'funds_tick'),
      e(ENTRY.F8, 'enforcement_ack'),
      e(ENTRY.F9, 'probe_designation'),
      e(ENTRY.F10, 'rules_version'),
      e(ENTRY.F11, 'price_notice'),
    ],
    projections: [
      { name: 'request', ddl: 'account BYTES NOT NULL, request_seq INT8 NOT NULL, state STRING NOT NULL, record BYTES NOT NULL, expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (account, request_seq)',
        clearColumns: ['account', 'request_seq', 'state', 'expires_at'], rowTtl: { column: 'expires_at', after: '0s' },
        readableBy: [{ role: 'account_status_reader', contractRef: 'C10 status' }] },
      { name: 'decision', ddl: 'account BYTES NOT NULL, request_seq INT8 NOT NULL, decided_seq INT8 NOT NULL, PRIMARY KEY (account, request_seq)',
        clearColumns: ['account', 'request_seq', 'decided_seq'], readableBy: [{ role: 'account_status_reader', contractRef: 'C10 status' }] },
      { name: 'idempotency', ddl: 'account BYTES NOT NULL, family STRING NOT NULL, idem_key STRING NOT NULL, request_seq INT8 NOT NULL, fingerprint BYTES NOT NULL, principal STRING NOT NULL, expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (account, family, idem_key)',
        clearColumns: ['account', 'family', 'request_seq', 'fingerprint', 'principal', 'expires_at'], rowTtl: { column: 'expires_at', after: '0s' },
        readableBy: [{ role: 'account_status_reader', contractRef: 'C10 status' }] },
      { name: 'reservation', ddl: 'account BYTES NOT NULL, reservation STRING NOT NULL, record BYTES NOT NULL, PRIMARY KEY (account, reservation)',
        clearColumns: ['account', 'reservation'] },
      { name: 'change_queue', ddl: 'account BYTES NOT NULL, reservation STRING NOT NULL, position INT8 NOT NULL, record BYTES NOT NULL, PRIMARY KEY (account, reservation, position)',
        clearColumns: ['account', 'reservation', 'position'], deletable: true },
      { name: 'funds', ddl: 'account BYTES NOT NULL, balance INT8 NOT NULL, funds_held INT8 NOT NULL, headroom INT8 NOT NULL, standing STRING NOT NULL, PRIMARY KEY (account)',
        clearColumns: ['account', 'balance', 'funds_held', 'headroom', 'standing'], readableBy: [{ role: 'account_status_reader', contractRef: 'C05 headroom query' }] },
      { name: 'feed_checkpoint', ddl: 'account BYTES NOT NULL, source STRING NOT NULL, feed_partition STRING NOT NULL, feed_seq INT8 NOT NULL, PRIMARY KEY (account, source, feed_partition, feed_seq)',
        clearColumns: ['account', 'source', 'feed_partition', 'feed_seq'] },
    ],
    streams: [
      { name: 'outcome', topic: 'account.outcome.v1', key: 'slot', emitFn: { version: 1 }, closure: 'none', reportGated: true,
        consumers: ['notifier', 'reporting'] },
      { name: 'lifecycle', topic: 'account.lifecycle.v1', key: 'partition', emitFn: { version: 1 }, closure: 'resolved',
        consumers: ['rating', 'notifier', 'reporting'] },
      { name: 'standing', topic: 'account.standing.v1', key: 'partition', emitFn: { version: 1 }, closure: 'none',
        consumers: ['network_operations'] },
      { name: 'usage_applied', topic: 'account.usage-applied.v1', key: 'partition', emitFn: { version: 1 }, closure: 'none',
        consumers: ['rating'] },
    ],
    statusReaders: true,
  };
}
