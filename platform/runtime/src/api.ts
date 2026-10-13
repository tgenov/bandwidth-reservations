/**
 * C01 v1 (frozen) — TypeScript surface of the owner runtime.
 *
 * Names and fields are copied from C01 §2.1, §2.2, §2.4, §2.5, §2.7 and §2.10. Types that C01
 * names but does not define (AuditFields, HeadRow, InboundNotification, ReadTx, FeedCheckpoint,
 * OperatorEnvelope) are marked "not defined by C01" and kept minimal; see STATUS-I1a.md.
 */

// ---------- §2.1 common types and units ----------

/** CockroachDB HLC commit timestamp as the decimal string the database returns:
 *  "<wall ns since Unix epoch>.<10-digit logical>". Totally ordered by decimal value.
 *  Never produced by an owner; only by the runtime (§3.2). */
export type HlcTs = string & { readonly __brand: 'HlcTs' };

export type OwnerKind = string;
export type SlotNo = number;
export type PartitionKey = Uint8Array;
export type Generation = number;
export type Epoch = bigint;
export type Seq = bigint;
export type StreamSeq = bigint;
export type MapVersion = bigint;
export type Millis = number;
export type MonotonicNs = bigint;

/** Writers of a partition are ordered by (generation, epoch, seq), generation first. */
export interface WriterFence { generation: Generation; epoch: Epoch }

/** A position in a partition's log (not named by C01; used by the runtime double and tests). */
export interface LogPosition { partition: PartitionKey; seq: Seq; ts: HlcTs }

// ---------- §2.2 owner declaration ----------

export interface OwnerDeclaration {
  kind: OwnerKind;
  slotCount: number;
  slotGroupWith?: OwnerKind;
  entryKinds: Array<{
    kind: number;
    name: string;
    schemaVersions: number[];
    retention: '7y' | 'ops';
    reportWanted?: boolean;
  }>;
  projections: Array<{
    name: string;
    ddl: string;
    clearColumns: string[];
    deletable?: boolean;
    rowTtl?: { column: string; after: string };
    readableBy?: Array<{ role: string; contractRef: string }>;
  }>;
  selfOutboxed?: boolean;
  streams: Array<{
    name: string;
    /** `<kind>.<feed>.v<n>`, or a topic a contract names exactly (e.g. `catalogue.v1`; C01 v1.1 erratum). */
    topic: string;
    /** 'partition', 'slot' (request outcome feed), or a declared event field (e.g. `{ field: 'account' }`). */
    key: 'partition' | 'slot' | { field: string };
    emitFn: { version: number };
    closure: 'none' | 'resolved' | 'closedPerLink';
    reportGated?: boolean;
    consumers: OwnerKind[];
  }>;
  statusReaders?: boolean;
  /** Declared non-log messages (e.g. a watermark), published by the holder on the stream ACL (`publishMessage`). */
  messages?: Array<{ name: string; topic: string; consumers: OwnerKind[] }>;
  /** Keep a slot-wide commit sequence (C08 §C `position`): BatchContext.slotPosition, Committed.slotPositions. */
  slotPositions?: boolean;
  entityIndexes?: Array<{ name: string; from: string; to: 'partition+seq' | 'segment' }>;
  bitemporalQueries?: Array<{ name: string; validTime: string; knownTime: 'ts' | 'payloadField'; field?: string }>;
}

// ---------- types C01 names but does not define ----------

/** C08 common types: microseconds since the Unix epoch. */
export type EpochMicros = bigint;
/** C08 common types. */
export type Tenant =
  | { kind: 'account'; account: string }
  | { kind: 'supplier'; supplier: string }
  | { kind: 'none' };

/** Not defined by C01; the field set is C08 §J `AuditFields` (RFC-005 §9.2). Pseudonymous only.
 *  `tenant` is C08's Tenant; `received_at` is C08's EpochMicros. The I1a forms (a tenant string, a number)
 *  are still accepted. */
export interface AuditFields {
  schema: 'audit.v1';
  principal: {
    principal_id: string; kind: string; tenant: Tenant | string;
    key_id?: string; session_id?: string; cert_serial?: string; edge_workload?: string;
  };
  on_behalf_of?: { account: string; request_ref: string };
  operator?: {
    role: string; reason_code: string; order_ref?: string; request_ref?: string;
    note_ref?: string; note_sha256?: Uint8Array; approver?: string; envelope_digest: Uint8Array;
    action_id: string; member?: string; set_version?: number;
  };
  cause?: { rule: string; trigger: { partition: string; seq: string } };
  received_at?: EpochMicros | number; request_id?: string;
  decided_at: 'commit';
  policy_version: number;
  iam_position?: { identity_slot: number; head: string };
  old?: unknown; new?: unknown;
}

/** Not defined by C01. The head row as `BatchContext.head` presents it (C01 §2.3 `<kind>_head`).
 *  `exists: false` for a partition with no head row (a creation; implicit rowAbsent(head), §3.2). */
export interface HeadRow {
  exists: boolean;
  partition: PartitionKey;
  slot: SlotNo;
  generation: Generation;
  adopted: boolean;
  seq: Seq;
  ts: HlcTs | null;
  epoch: Epoch;
  streams: Record<string, StreamSeq>;
  chain: Uint8Array;
}

/** Not defined by C01: a point-to-point notification as `onNotification` receives it (§3.5). */
export interface InboundNotification {
  from: { kind: OwnerKind; partition: PartitionKey } & WriterFence;
  id: { subject: Uint8Array; attempt: number; kind: string };
  body: unknown;
  ts: HlcTs;
}

/** Not defined by C01: the read handle given to `consistentRead` and `followerRead`. */
export interface ReadTx {
  query<R extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

/** Not defined by C01: where `subscribe` starts, per (producer partition, stream) (§3.5). */
export interface FeedCheckpoint {
  positions: Array<{ partition: PartitionKey; stream: string; streamSeq: StreamSeq; digest?: Uint8Array }>;
}

/** Not defined by C01 (C08 §E owns it). */
export type OperatorEnvelope = unknown;

// ---------- §2.4 lifecycle ----------

export type AcquisitionKind = 'expiry' | 'handoff' | 'rehome';
export interface OwnerHooks {
  /** After the acquisition commit and present-time catch-up; once per slot of a group, all before the group serves. */
  onAcquire(slot: SlotNo, epoch: Epoch, kind: AcquisitionKind): Promise<void>;
  /** Slot lost (StaleEpoch, revoked and taken, handed off). Drop the slot's memory. */
  onRelease(slot: SlotNo, reason: 'staleEpoch' | 'handedOff' | 'taken' | 'shutdown'): void;
  /** Reporting enabled: read_lease + ε after an acquisition commit, or at once after a resume (§3.1). */
  onReportable(slot: SlotNo): void;
  /** After `moved(to, g+1)` commits in the old slot (§3.3). Must not append for the partition. */
  onMovedOut(partition: PartitionKey): void;
  /** After `adopt(g+1)` commits in the new slot (§3.3). */
  onAdopt(partition: PartitionKey, generation: Generation): Promise<void>;
  onNotification(n: InboundNotification): Promise<void>;
}

// ---------- §2.4 appending ----------

export interface EntryInput {
  kind: number; schemaV: number;
  identity: Uint8Array;
  audit: AuditFields;
  payload: unknown;
  emits?: Array<{ stream: string; event: unknown }>;
  senderFence?: { kind: OwnerKind; partition: PartitionKey } & WriterFence;
  pendingAnswered?: Uint8Array;
}
export interface ProjectionWrite { table: string; op: 'upsert' | 'delete'; key: unknown; row?: unknown }
export interface NotificationOut {
  to: { kind: OwnerKind; partition: PartitionKey };
  id: { subject: Uint8Array; attempt: number; kind: string };
  body: unknown;
}
export interface RowRef { table: string; key: unknown }

export type Condition =
  | { kind: 'rowAbsent' | 'rowPresent'; row: RowRef; label: string }
  | { kind: 'tsBefore'; bound: (t: TimingSnapshot) => HlcTs; label: string }
  | { kind: 'displacementRead'; link: PartitionKey; request: Uint8Array; attempt: number;
      lockTimeoutMs: Millis; label: string };

/** In-transaction context given to `decide` (§2.4, M2, R47-11). Synchronous; re-created on every restart. */
export interface BatchContext {
  ts: HlcTs; timing: TimingSnapshot;
  /** Kinds with `slotPositions`: the slot-wide position the first entry of this call gets (C08 §C). */
  slotPosition?: bigint;
  head(partition: PartitionKey): HeadRow;
  read(row: RowRef): unknown | undefined;
  conditionResults: Record<string, boolean | 'lockTimeout'>;
}
export interface DecideResult { entries: EntryInput[]; projections?: ProjectionWrite[]; notifications?: NotificationOut[] }
export interface AppendCall {
  partition: PartitionKey;
  conditions?: Condition[];
  reads?: RowRef[];
  entries?: EntryInput[]; projections?: ProjectionWrite[]; notifications?: NotificationOut[];
  decide?(ctx: BatchContext): DecideResult | null;
}
export interface AppendOptions {
  exclusive?: boolean;
  firstStatement?: ProjectionWrite[];
  abandonBeforeCommitMs?: Millis;
  lane?: 'primary' | 'second';
}

export type AppendResult =
  | { r: 'Committed'; seqFrom: Seq; seqTo: Seq; ts: HlcTs; streamSeqs: Record<string, [StreamSeq, StreamSeq]>;
      /** Kinds with `slotPositions`: the slot-wide positions of this call's entries (C08 §C). */
      slotPositions?: [bigint, bigint] }
  /** `displacement`: for a failed displacementRead, the marker row found (any attempt fails it, C02 / P1-S78). */
  | { r: 'ConditionFailed'; which: string; displacement?: { attempt: number; row: unknown } }
  | { r: 'Retry' }
  | { r: 'StaleEpoch' }
  | { r: 'Moved'; slot: SlotNo; generation: Generation }
  | { r: 'Moving' }
  | { r: 'Stopped'; detectionRef: Uint8Array }
  | { r: 'Ambiguous' }
  | { r: 'Overloaded'; retryAfterMs: Millis };

/** Result discriminants (C01 §8: a new one is a major change). */
export const APPEND_RESULT_KINDS = [
  'Committed', 'ConditionFailed', 'Retry', 'StaleEpoch', 'Moved', 'Moving', 'Stopped', 'Ambiguous', 'Overloaded',
] as const;

export interface OwnerRuntime {
  append(call: AppendCall, opts?: AppendOptions): Promise<AppendResult>;
  leaseValid(slot: SlotNo): { valid: boolean; untilMonotonic: MonotonicNs };
  epoch(slot: SlotNo): Epoch;
  generation(partition: PartitionKey): Generation;
  admitCommand(sender: { kind: OwnerKind; partition: PartitionKey }, fence: WriterFence):
    { admit: true } | { admit: false; recorded: WriterFence };
  timing(): TimingSnapshot;
  now(): { ts: HlcTs; boundMs: Millis };
  reportPosition(slot: SlotNo): HlcTs | undefined;
  onReport(handler: (slot: SlotNo, p: HlcTs) => void): void;
  consistentRead<T>(fn: (tx: ReadTx) => Promise<T>, at: 'present' | HlcTs): Promise<T>;
  followerRead<T>(fn: (tx: ReadTx) => Promise<T>): Promise<{ value: T; servedAt: HlcTs }>;
  closedTimestamp(): Promise<HlcTs>;
  subscribe(topic: string, from: FeedCheckpoint, gate: 'committed' | 'reported', handler: (e: FeedEvent) => Promise<void>): void;
  onResolved(topic: string, handler: (destinationPartition: number, R: HlcTs) => void): void;
  onClosed(handler: (link: PartitionKey, t: HlcTs, feedSeq: StreamSeq) => void): void;
  onMarker(topic: 'account.outcome.v1', handler: (m: ReportMarker) => Promise<void>): void;
  timer(partition: PartitionKey, key: string, atTs: HlcTs): void;
  cancelTimer(partition: PartitionKey, key: string): void;
  route(kind: OwnerKind, partition: PartitionKey): RouteInfo;
  slotOf(account: PartitionKey): SlotOfAnswer;
  topology(): { state: string; preferredRegion: 'R1' | 'R2'; disaster: null | { region: string; since: HlcTs } };
  putCheckpoint(kind: OwnerKind, partition: PartitionKey, seq: Seq, bytes: Uint8Array): Promise<{ reference: string; digest: Uint8Array }>;
  getCheckpoint(reference: string): Promise<Uint8Array>;
}

export interface TimingSnapshot { version: bigint; epsilonMs: Millis; deltaXMs: Millis; tauMs: Millis }
export interface RouteInfo { slot: SlotNo; generation: Generation; holderHint?: string; epoch: Epoch; readers: string[]; mapVersion?: MapVersion }

// ---------- §2.4 status readers ----------

export interface StatusReaderRuntime {
  readLease(slot: SlotNo): { valid: boolean; untilMonotonic: MonotonicNs; appliedThrough: HlcTs; reportPosition: HlcTs; pGrant: HlcTs };
  leasedRead(partition: PartitionKey, points: RowRef[]): Promise<Array<unknown | undefined>>;
  isMovedOut(partition: PartitionKey): boolean;
  replicaRule3Check(accountSlot: SlotNo, requestKey: Uint8Array): Promise<{ holderLive: boolean; rows?: unknown }>;
}
export class NotClosed extends Error {}

// ---------- §2.4 routed commands ----------

export interface CommandEnvelope {
  routedTo: { kind: OwnerKind; slot: SlotNo; generation: Generation; epoch: Epoch; mapVersion?: MapVersion };
  sender: { kind: OwnerKind; partition: PartitionKey; generation: Generation; epoch: Epoch; seq?: Seq };
  identity: Uint8Array;
}
export type RoutingRefusal =
  | { code: 'STALE_EPOCH'; current: Epoch; holderHint?: string }
  | { code: 'NOT_OWNER'; holderHint?: string }
  | { code: 'MOVED'; slot: SlotNo; generation: Generation }
  | { code: 'MOVING'; retryAfterMs: Millis }
  | { code: 'STOPPED' }
  | { code: 'STALE_SENDER'; recorded: WriterFence }
  | { code: 'OVERLOADED'; retryAfterMs: Millis }
  | { code: 'UNAVAILABLE' };

/** Refusal codes (C01 §8: a new one is a major change; unknown ⇒ UNAVAILABLE). */
export const ROUTING_REFUSAL_CODES = [
  'STALE_EPOCH', 'NOT_OWNER', 'MOVED', 'MOVING', 'STOPPED', 'STALE_SENDER', 'OVERLOADED', 'UNAVAILABLE',
] as const;

// ---------- §2.5 Kafka wire format ----------

export interface FeedHeaders {
  partition: Uint8Array;
  stream?: string; stream_seq?: string;
  notification_id?: string;
  generation: string; epoch: string; ts: HlcTs;
  kind: string; schema_v: string; key_id: string;
  slot?: string;
  report_through?: HlcTs;
}
export interface FeedEvent { headers: FeedHeaders; value: Uint8Array }

export interface ReportMarker {
  slot: SlotNo; generation: 0; epoch: Epoch;
  reportPosition: HlcTs;
  prevReportPosition: HlcTs | null;
  pendingAnswered: Uint8Array[];
  chunk: { part: number; last: boolean };
}
export interface ResolvedMarker {
  dataTopic: string; partitionCount: number; destinationPartition: number;
  resolved: HlcTs;
  dataHighWater: bigint;
  emitterEpoch: Epoch;
}
export interface ClosedMarker {
  link: Uint8Array; t: HlcTs; feedSeq: StreamSeq;
  partitionCount: number; destinationPartition: number; dataHighWater: bigint; emitterEpoch: Epoch;
}
export interface RelayProgress { cdcPartition: number; resolved: HlcTs; linksRelayed?: Uint8Array[] }

// ---------- §2.7 placement (the part the runtime surfaces) ----------

export type SplitState = 'unsplit' | 'splitting' | 'split';
export interface SlotMapVersion {
  version: MapVersion; slotCount: number;
  previousCount?: number;
  splitState: Record<SlotNo, SplitState>;
  overrides: Array<{ account: Uint8Array; slot: SlotNo; reason: 'probe_pin' | 'probe_new' | 'reslot' | 'dedicated' }>;
  probeAccounts: Array<{ slot: SlotNo; account: Uint8Array }>;
  publishedAt: HlcTs;
}
export interface SlotOfAnswer { slot: SlotNo; mapVersion: MapVersion; headDecides: boolean }

// ---------- §2.10 operational alert ----------

export interface OperationalAlert {
  alertId: { partition: Uint8Array; alertKind: string; subject: Uint8Array; episode: { partition: Uint8Array; seq: Seq } };
  op: 'raised' | 'cleared';
  alertKind: string;
  severity: 'info' | 'warning' | 'page';
  entities: Array<{ type: string; id: Uint8Array }>;
  reasonCode: string;
  detail?: Record<string, string | number>;
  raisedAt: HlcTs;
}

// ---------- additions (not C01 types) ----------

/** A log row with payload and audit opened (unsealed), for rebuild by replay (C01 §3.1 "Rebuilding a partition"). */
export interface OpenedLogRow {
  slot: SlotNo; partition: PartitionKey; seq: Seq; generation: Generation; epoch: Epoch; kind: number; schemaV: number;
  ts: HlcTs; identity: Uint8Array; emits: Array<[string, StreamSeq]>; retention: number;
  payload: unknown; audit: unknown; senderFence?: { kind: OwnerKind; partition: PartitionKey } & WriterFence;
  chain: Uint8Array;
}
