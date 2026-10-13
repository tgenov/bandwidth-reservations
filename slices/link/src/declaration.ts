/**
 * The owner declaration of the link schedule owner kind (C01 §2.2; RFC-001 §7.1, §7.3, §11.1).
 *
 * It declares every entry kind of RFC-001 §7.3, so that the numbers do not change in later
 * increments. I1 writes only Init, Takeover, Hold, Convert and Release. The projections and the
 * streams are the ones of §7.1 and §11.1. I1 writes no projection row and emits no event (PLAT-B,
 * PLAT-D). CC-8 compares this declaration with RFC-001.
 */
import type { OwnerDeclaration } from '@share/owner-runtime';

export const LINK_KIND = 'link';

/** Entry kind numbers (int16). Stable from I1. */
export const ENTRY = {
  Init: 1,
  Takeover: 2,
  Policy: 3,
  Registry: 4,
  Tick: 5,
  Hold: 10,
  Convert: 11,
  Release: 12,
  MarkWaiting: 13,
  YieldAccept: 14,
  YieldRefuse: 15,
  DisplaceAccept: 16,
  EndLeg: 20,
  ReduceParts: 21,
  CutAnswer: 22,
  OfferHold: 30,
  OfferAccept: 31,
  OfferMoveAt: 32,
  OfferRelease: 33,
  Outage: 40,
  Restoration: 41,
  Maintenance: 42,
  MaintenanceCancel: 43,
  ReductionAnnounce: 44,
  ReductionEffective: 45,
  ReductionStep: 46,
  Increase: 47,
  Checkpoint: 50,
  Compact: 51,
  Alert: 52,
} as const;

export type EntryName = keyof typeof ENTRY;

/** Entry kinds that record a fact of the schedule are kept 7 years (C01 §2.2 retention). */
const OPS_ONLY: ReadonlySet<EntryName> = new Set<EntryName>(['Tick', 'Checkpoint', 'Compact', 'Takeover']);

export const declaration: OwnerDeclaration = {
  kind: LINK_KIND,
  // RFC-001 §1: the hottest links each have a slot of their own. C01 needs a power of two.
  slotCount: 256,
  entryKinds: (Object.keys(ENTRY) as EntryName[]).map((name) => ({
    kind: ENTRY[name], name, schemaVersions: [1], retention: OPS_ONLY.has(name) ? 'ops' as const : '7y' as const,
  })),
  projections: [
    {
      // RFC-001 §7.1: the final record of a request, 24 h after D, by row-level TTL. Written from I2.
      name: 'request',
      ddl: 'link_id STRING NOT NULL, request_part BYTES NOT NULL, request_seq INT8 NOT NULL, seq INT8 NOT NULL, '
        + 'deadline_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (link_id, request_part, request_seq)',
      clearColumns: ['link_id', 'request_part', 'request_seq', 'seq', 'deadline_at'],
      rowTtl: { column: 'deadline_at', after: '24 hours' },
    },
    {
      // RFC-001 §7.1, C02 "Link displacement read". Written from I11.
      name: 'displacement',
      ddl: 'link_id STRING NOT NULL, request_part BYTES NOT NULL, request_seq INT8 NOT NULL, attempt INT4 NOT NULL, '
        + 'reduction_seq INT8 NOT NULL, record_hlc DECIMAL NOT NULL, PRIMARY KEY (link_id, request_part, request_seq)',
      clearColumns: ['link_id', 'request_part', 'request_seq', 'attempt', 'reduction_seq', 'record_hlc'],
      deletable: true,
      readableBy: [{ role: 'account_owner', contractRef: 'C02 link displacement read' }],
    },
    {
      // RFC-001 §7.1: the reduction projection output during the notice. Written from I14.
      name: 'reduction_cut',
      ddl: 'link_id STRING NOT NULL, reduction_seq INT8 NOT NULL, part STRING NOT NULL, cut BYTES NOT NULL, '
        + 'PRIMARY KEY (link_id, reduction_seq, part)',
      clearColumns: ['link_id', 'reduction_seq', 'part', 'cut'],
      deletable: true,
    },
    {
      // RFC-001 §7.5: the projection checkpoints. Written from I2.
      name: 'projection',
      ddl: 'link_id STRING NOT NULL, projection STRING NOT NULL, through_seq INT8 NOT NULL, PRIMARY KEY (link_id, projection)',
      clearColumns: ['link_id', 'projection', 'through_seq'],
    },
  ],
  streams: [
    { name: 'schedule', topic: 'link.schedule.v1', key: 'partition', emitFn: { version: 1 }, closure: 'closedPerLink',
      consumers: ['account', 'notifier', 'money'] },
    { name: 'alert', topic: 'link.alert.v1', key: 'partition', emitFn: { version: 1 }, closure: 'none', consumers: [] },
  ],
  bitemporalQueries: [
    { name: 'schedule_as_known_at', validTime: 'window', knownTime: 'payloadField', field: 'decisionTime' },
    { name: 'schedule_as_recorded_at', validTime: 'window', knownTime: 'ts' },
  ],
};

export default declaration;
