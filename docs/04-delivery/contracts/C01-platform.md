# C01. Platform contract: owner runtime, account slot map, history query, probe designation, alert feed, column encryption binding

| | |
|---|---|
| Contract ID | C01 |
| Version | 1 (draft 1) |
| Status | **Draft, for contract review.** The orchestrator settled M1 … M13 (binding; §11 "Settled"); the errata they imply on slice RFCs and RFC-000 are listed in §10.3 |
| Provider | RFC-006 (platform layer: owner runtime, placement, relay and closure emitter, history, probes, alert service). Column encryption's library is RFC-005's (C13); this contract fixes only how the runtime binds it |
| Consumers | Every owner and reader: RFC-001 (link schedule owner, link registry), RFC-002 (account owner, partner adapters, status readers), RFC-003 (metering ingestion, attribution A/B, rating, catalogue), RFC-004 (funds module in the account owner, ledger, settlement, payments, receivables, reconciliation, payouts), RFC-005 (identity and access, edge, audit, console); and RFC-006's own kinds (placement, notifier, alert service, probe results, history, closure emitter) |
| Transport | Mixed, by part: **in-process call** (owner runtime library, NestJS/TypeScript); **database** (log, head, projection, outbox, session and slot tables; the platform reads named in §6, under RFC-000 A1); **Kafka event** (feeds, report and closure markers, relay progress, placement feed, operational alert feed); **gRPC** (integrity stop, slot-map queries, probe-set summary, history query, checkpoint store) |
| Pinned to | `requirements-v1.10`; RFC-000 rev. 4.4 (§8 rows: substrate conventions, account slot map, history query, probe designation and exclusion, operational alert feed, column encryption); RFC-006 rev. 6 (§3.5, §3.7, §4, §5.3–§5.5, §7.1, §12, §13.3, §16, §17.4); RFC-001 rev. 5 (§7, §8, §11); RFC-002 rev. 5 (§2.5, §8.2, §12.1, §13); RFC-003 rev. 5 + erratum 5.1 (§1.1, §3.4, §5.12, §6.4, §7); RFC-004 rev. 5 + erratum 5.1 (§A3, §A4, §B1.3, §B12); RFC-005 rev. 5 (§3.1, §4.4, §5.4, C5, C9, C13) |
| Binding decision | **C4-7**: this contract is the single definition of the move hooks (`onAdopt`, `onMovedOut`), the `Moving` and `Stopped` results and the slot map's splitting state. §10.3 lists what each consumer RFC must handle; the items not yet in its revision 5 become errata on that RFC once this contract is frozen |
| Supersedes | The pre-baseline `docs/04-delivery/contracts.md` (not authority) |

## 1. Purpose

Every owner in the system is a single-writer state machine over an append-only log
(RFC-000 A1, A2, A4), and all of them run on one platform. This contract fixes what the
platform gives and what each owner owes it, precisely enough that RFC-006's runtime and
each owner can be built and tested apart:

- **P1 Owner runtime** (RFC-000 §8 "Substrate conventions"): table conventions, sessions
  and slot leases, epochs and generations, the slot batch transaction and its results,
  takeover, resume and re-home, the move protocol and its hooks, integrity stops, report
  positions and read leases, the outbox, feeds and closure, timers, routing, checkpoints,
  time, and the binding of column encryption.
- **P2 Account slot map** (placement): `slotOf`, map versions, doubling only, the splitting
  state, probe accounts, `probeAccountSet(v)` and `probeSetSummary(v)`.
- **P3 History query**: as known at T, ranges, replay.
- **P4 Probe designation and exclusion.**
- **P5 Operational alert feed.**
- **P6 Column encryption binding** (what the runtime does with RFC-005 C13).

Out of scope: the semantics of each owner's entries, feeds and commands (each owner's own
contract); RFC-005 C13's cryptography; RFC-006's deployment topology, sizing and runbooks,
which no consumer builds against.

## 2. Schema

### 2.1 Common types and units

```ts
/** CockroachDB HLC commit timestamp as the decimal string the database returns:
 *  "<wall ns since Unix epoch>.<10-digit logical>". Totally ordered by decimal value.
 *  Never produced by an owner; only by the runtime (§3.2). */
export type HlcTs = string & { readonly __brand: 'HlcTs' };

export type OwnerKind = string;          // 'account' | 'link' | 'partner' | 'ingest' | 'attr_a' | 'attr_b' | 'rating' | 'catalogue' | 'ledger' | 'settlement' | 'payments' | 'receivables' | 'recon' | 'payouts' | 'iam' | 'placement' | 'notifier' | 'alerts' | 'probe_results' | 'history' | 'closure' | …
export type SlotNo = number;             // int32, 0 ≤ slot < slot count of the kind (dedicated/override slots above)
export type PartitionKey = Uint8Array;   // pseudonymous key bytes; '' (empty) is the slot's reserved marker partition
export type Generation = number;         // int32 ≥ 0, +1 per move of the partition
export type Epoch = bigint;              // int64 ≥ 1, +1 per acquisition, handoff or re-home of the slot
export type Seq = bigint;                // int64, contiguous per partition from 1
export type StreamSeq = bigint;          // int64, contiguous per (partition, stream) from 1
export type MapVersion = bigint;         // int64, strictly increasing per account slot map
export type Millis = number;             // durations in milliseconds unless the name says otherwise
export type MonotonicNs = bigint;        // process.hrtime.bigint() of the calling process

/** Writers of a partition are ordered by (generation, epoch, seq), generation first. */
export interface WriterFence { generation: Generation; epoch: Epoch }
```

Units used in this contract: durations in **ms** (or **s** where stated), timestamps as
`HlcTs`, sizes in **bytes** (KB = 1,000 B; MB = 10⁶ B), rates in **per second**, probe
bookings in **Mbps** (1 Mbps, §3.10). No money amount is carried by this contract.

### 2.2 Owner declaration (consumed by the migration tool and the runtime)

```ts
export interface OwnerDeclaration {
  kind: OwnerKind;
  slotCount: number;                         // power of two; account kind via the slot map (§2.7)
  slotGroupWith?: OwnerKind;                 // RFC-003: attr_b i with rating i
  entryKinds: Array<{
    kind: number;                            // int16
    name: string;
    schemaVersions: number[];                // every schema_v ever written; decoders kept 7 years
    retention: '7y' | 'ops';                 // undeclared ⇒ '7y'
    reportWanted?: boolean;                  // deciding and "releases durable" entries (RFC-002)
  }>;
  projections: Array<{
    name: string;                            // table <kind>_<name>
    ddl: string;                             // owner-defined key and columns
    clearColumns: string[];                  // only pseudonymous keys, times, tenant-free enums (RFC-005 §5.4)
    deletable?: boolean;                     // DELETE granted only if true (RFC-001: link_displacement, link_reduction_cut)
    rowTtl?: { column: string; after: string }; // e.g. RFC-001 link_request 24 h
  }>;
  selfOutboxed?: boolean;                    // RFC-003 ingest_log
  streams: Array<{
    name: string;                            // e.g. 'outcome', 'lifecycle', 'schedule', 'alert'
    topic: string;                           // '<kind>.<feed>.v<n>'
    key: 'partition' | 'slot';               // 'slot' only for the request outcome feed
    emitFn: { version: number };             // entry → event, versioned, kept 7 years (§3.9 replay)
    closure: 'none' | 'resolved' | 'closedPerLink'; // §3.6 and M7
    reportGated?: boolean;                   // outcome feed: delivered under 'reported' gate
  }>;
  statusReaders?: boolean;                   // true only for the account kind today
  readableBy?: Array<{ table: string; role: string; contractRef: string }>; // cross-owner reads named in RFC-000 §8 only
  entityIndexes?: Array<{ name: string; from: string; to: 'partition+seq' | 'segment' }>; // §3.9
  bitemporalQueries?: Array<{ name: string; validTime: string; knownTime: 'ts' | 'payloadField'; field?: string }>;
}
```

### 2.3 Database (RFC-006 §3.7, §4.2, §7.1; DDL for CockroachDB)

Per owner kind `<kind>`; physical keys begin with the slot. Owner RFCs' logical keys
(for example RFC-001's `(link, sequence)`) map onto these.

```sql
-- Log: insert only. Clear columns are exactly these plus key_id; audit and payload are C13 ciphertext.
CREATE TABLE <kind>_log (
  slot        INT4  NOT NULL,
  partition   BYTES NOT NULL,
  seq         INT8  NOT NULL,
  generation  INT4  NOT NULL,
  epoch       INT8  NOT NULL,
  kind        INT2  NOT NULL,
  schema_v    INT2  NOT NULL,
  ts          DECIMAL NOT NULL,            -- commit timestamp, = cluster_logical_timestamp() of the batch
  identity    BYTES NOT NULL,              -- the command's idempotency identity (A6)
  emits       BYTES NOT NULL,              -- encoded [(stream, stream_seq)] of events this entry produced
  audit       BYTES NOT NULL,              -- RFC-005 C5 field set, sealed (audit-column key)
  retention   INT2  NOT NULL,              -- 0 = '7y', 1 = 'ops'
  key_id      BYTES NOT NULL,
  payload     BYTES NOT NULL,              -- compressed then sealed (log key)
  chain       BYTES NOT NULL,              -- RFC-005 §9.3 layer 4, computed by append
  PRIMARY KEY (slot, partition, seq)
);

-- Head: one row per partition, keyed by home so a move changes columns, never the key.
CREATE TABLE <kind>_head (
  home_key    INT4  NOT NULL,              -- 20-bit reversal of home = hash(partition) mod 2^20
  partition   BYTES NOT NULL,
  slot        INT4  NOT NULL,              -- current slot (changes on `moved`)
  generation  INT4  NOT NULL,
  seq         INT8  NOT NULL,
  ts          DECIMAL NOT NULL,
  epoch       INT8  NOT NULL,
  streams     BYTES NOT NULL,              -- encoded {stream: last stream_seq}
  chain       BYTES NOT NULL,
  batch_id    BYTES NOT NULL,              -- id of the last batch that wrote this row (Ambiguous resolution)
  report_through DECIMAL NULL,             -- only on partition '' of each slot: last report position a marker carried
  PRIMARY KEY (home_key, partition)
);

-- Outbox: transport, not record. Absent for a self-outboxed kind.
CREATE TABLE <kind>_outbox (
  slot INT4 NOT NULL, partition BYTES NOT NULL, stream STRING NOT NULL, stream_seq INT8 NOT NULL, n INT4 NOT NULL,
  topic STRING NOT NULL, msg_key BYTES NOT NULL, headers BYTES NOT NULL,
  payload BYTES NOT NULL,                  -- sealed under the topic's feed key
  ts DECIMAL NOT NULL, generation INT4 NOT NULL, epoch INT8 NOT NULL,
  PRIMARY KEY (slot, partition, stream, stream_seq, n)
) WITH (ttl_expire_after = '26 hours', ttl_disable_changefeed_replication = true);
-- Point-to-point notifications use stream = '' and stream_seq = 0, identity in headers (notification_id).

-- Sessions and slot leases (platform tables).
CREATE TABLE owner_session (
  shard INT2 NOT NULL, session_id UUID NOT NULL,   -- never reused
  host STRING, region STRING, facility STRING, kind STRING,
  started_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, revoked BOOL NOT NULL DEFAULT false,
  PRIMARY KEY (shard, session_id)
);
CREATE TABLE owner_slot (
  kind STRING NOT NULL, slot INT4 NOT NULL,
  session_id UUID NULL, epoch INT8 NOT NULL, acquired_at TIMESTAMPTZ, slot_group STRING NULL,
  PRIMARY KEY (kind, slot)
);
CREATE TABLE platform_timing (                    -- §6.4 of RFC-006; read inside batches for tau
  shard INT2 NOT NULL, version INT8 NOT NULL,
  epsilon_ms INT4 NOT NULL, delta_x_ms INT4 NOT NULL, tau_ms INT4 NOT NULL,
  second_lane JSONB NOT NULL,                     -- {kind: {account|deadline|dedicated: bool}}
  PRIMARY KEY (shard)
);

-- Placement (owner kind 'placement'; readers through the placement feed and gRPC only).
CREATE TABLE placement_account_slot_map (         -- insert-only history; current state in a projection
  version INT8 PRIMARY KEY, slot_count INT4 NOT NULL,          -- power of two
  split_state BYTES NOT NULL,                                   -- encoded {oldSlot: 'unsplit'|'splitting'|'split'} during a doubling
  overrides_digest BYTES NOT NULL, published_at DECIMAL NOT NULL
);
CREATE TABLE placement_slot_override (account BYTES, version INT8, slot INT4, reason STRING, operator BYTES, PRIMARY KEY (account, version));
CREATE TABLE placement_partition_moves (kind STRING, partition BYTES, from_slot INT4, to_slot INT4, generation INT4,
  state STRING CHECK (state IN ('prewarm','moved','adopted','done')), PRIMARY KEY (kind, partition, generation));
CREATE TABLE placement_probe_accounts (slot INT4 PRIMARY KEY, account BYTES NOT NULL UNIQUE, limit_state STRING NOT NULL); -- 'pending'|'applied'
CREATE TABLE placement_integrity_stops (kind STRING, partition BYTES, detection_ref BYTES NOT NULL,
  state STRING CHECK (state IN ('stopped','resumed')), checkpoint BYTES NULL, at DECIMAL NOT NULL,
  PRIMARY KEY (kind, partition, detection_ref));
```

**Grants** (checked by RFC-006's conformance job; anything else fails it):

| Role | Grants |
|---|---|
| Owner service `<kind>` | INSERT, SELECT on `<kind>_log`, `<kind>_outbox`; UPSERT, SELECT on `<kind>_head` and its projections; DELETE only on projections declared `deletable`; SELECT on `owner_session`, `owner_slot`, `platform_timing`; UPDATE on its own `owner_session` row and on `owner_slot` rows by the acquisition, handoff and re-home statements; SELECT on another owner's table **only** where RFC-000 §8 names the read (today: the account owner on `link_displacement`) |
| `truncator` | DELETE on log tables, confined by row-level security to `seq ≤ audit_watermark(kind, partition)` |
| `restore` (break-glass) | Writes only partitions with an open integrity stop (row-level security over `placement_integrity_stops`) |
| Platform reads (M10) | Read-only roles, outside any owner transaction, listed below; no INSERT, UPDATE or DELETE |

**Named platform read roles** (settled M10; RFC-000 A1 erratum lists them). Each is
read-only, holds SELECT on exactly the tables named, and is checked by the conformance job:

| Role | Reads | How | Why |
|---|---|---|---|
| `history_sealer` | Every `<kind>_log` | Follower read at `T ≤ closedTimestamp()` | Sealing segments (RFC-006 §13.2) |
| `feed_gapfill` | `<kind>_outbox` (and a self-outboxed `<kind>_log`) of a producer, by (partition, stream, `stream_seq`), only for a consumer named in that feed's contract | Follower read | Filling a feed gap after `gap_timeout` (§3.5) |
| `closure_emitter` | `<kind>_head.streams` (today `link_head`) | Follower read `AS OF SYSTEM TIME t`, `t` a resolved timestamp | `feed_seq` of `ClosedMarker` (§3.6) |
| `status_reader` | The account kind's log, head and projections; `owner_session`, `owner_slot` of account slots | Bounded staleness with minimum timestamp (rule 2); present-time consistent read (rule 3 only) | Status replicas (§3.4) |
| `standby` (same owner kind, not cross-owner) | Its own kind's tables | Follower read; present-time only for a taking-over standby | Tailing and takeover (§3.1) |

### 2.4 Owner runtime interface (TypeScript, in-process)

```ts
// ---------- lifecycle ----------
export type AcquisitionKind = 'expiry' | 'handoff' | 'rehome';
export interface OwnerHooks {
  /** After the acquisition commit and present-time catch-up; once per slot of a group, all before the group serves. */
  onAcquire(slot: SlotNo, epoch: Epoch, kind: AcquisitionKind): Promise<void>;
  /** Slot lost (StaleEpoch, revoked and taken, handed off, Moved for a whole slot). Drop the slot's memory. */
  onRelease(slot: SlotNo, reason: 'staleEpoch' | 'handedOff' | 'taken' | 'shutdown' | 'movedSlot'): void;
  /** Reporting enabled: read_lease + ε after an acquisition commit, or at once after a resume read (§3.1). */
  onReportable(slot: SlotNo): void;
  /** After `moved(to, g+1)` commits in the old slot: cancel the partition's timers, stop deciding for it.
   *  Memory may be dropped after the report fence (step 4 of §3.3). Synchronous; must not append for the partition. */
  onMovedOut(partition: PartitionKey): void;
  /** After `adopt(g+1)` commits in the new slot: re-arm the partition's timers from its state and apply the
   *  takeover-entry rule to it (as onAcquire does for a slot). Reporting for it starts read_lease + ε later. */
  onAdopt(partition: PartitionKey, generation: Generation): Promise<void>;
  onNotification(n: InboundNotification): Promise<void>;
}

// ---------- appending ----------
export interface EntryInput {
  kind: number; schemaV: number;
  identity: Uint8Array;                    // deterministic idempotency identity (A6)
  audit: AuditFields;                      // RFC-005 §9.2, pseudonymous only
  payload: unknown;                        // encoded, compressed and sealed by the runtime
  emits?: Array<{ stream: string; event: unknown }>; // feed events (stream_seq assigned by the runtime)
}
export interface ProjectionWrite { table: string; op: 'upsert' | 'delete'; key: unknown; row?: unknown } // delete only on declared deletable
export interface NotificationOut {
  to: { kind: OwnerKind; partition: PartitionKey };
  id: { subject: Uint8Array; attempt: number; kind: string };  // (request or reservation, attempt, kind)
  body: unknown;
}

export type Condition =
  | { kind: 'rowAbsent' | 'rowPresent'; table: string; key: unknown; label: string }       // own slot only
  | { kind: 'tsBefore'; bound: (t: TimingSnapshot) => HlcTs; label: string }               // e.g. ts < D − τ
  | { kind: 'displacementRead'; link: PartitionKey; request: Uint8Array; attempt: number;   // account owner only
      lockTimeoutMs: Millis; label: string };                                                // savepoint; M3

/** In-transaction context given to `decide`, after the epoch, head rows and condition rows are read
 *  and ts is fixed. Re-created on every restart of the transaction (M2). */
export interface BatchContext {
  ts: HlcTs; timing: TimingSnapshot;
  head(partition: PartitionKey): HeadRow;
  read(table: string, key: unknown): Promise<unknown | undefined>;     // own slot's rows only
  conditionResults: Record<string, boolean | 'lockTimeout'>;
}
export interface AppendCall {
  partition: PartitionKey;
  conditions?: Condition[];
  /** Static form: entries known before the transaction. */
  entries?: EntryInput[]; projections?: ProjectionWrite[]; notifications?: NotificationOut[];
  /** Decide form (M2): computed inside the transaction at ctx.ts; must be deterministic in ctx and the call;
   *  re-run on every restart. Returning null withdraws the call (answered ConditionFailed('decide')). */
  decide?(ctx: BatchContext): { entries: EntryInput[]; projections?: ProjectionWrite[]; notifications?: NotificationOut[] } | null;
}
export interface AppendOptions {
  /** Carry this call alone in its own transaction on the slot's lane (RFC-001 capacity-lowering entries). */
  exclusive?: boolean;
  /** Writes executed as the transaction's first statement, together with the ts read (RFC-001 placeholder markers). */
  firstStatement?: ProjectionWrite[];
  /** Abandon (ROLLBACK) if not at COMMIT within this many ms of BEGIN; default 2,000; RFC-001 uses 250 for capacity-lowering. */
  abandonBeforeCommitMs?: Millis;
  lane?: 'primary' | 'second';             // ignored unless placement enabled the second lane for the kind
}

export type AppendResult =
  | { r: 'Committed'; seqFrom: Seq; seqTo: Seq; ts: HlcTs; streamSeqs: Record<string, [StreamSeq, StreamSeq]> }
  | { r: 'ConditionFailed'; which: string }        // nothing of this call committed; others in the batch may have
  | { r: 'Retry' }                                 // not committed; returned only after batch_retries restarts and one fresh attempt
  | { r: 'StaleEpoch' }                            // this slot is lost to this process
  | { r: 'Moved'; slot: SlotNo; generation: Generation }
  | { r: 'Moving' }                                // partition between `moved` and `adopt`; retry after a short wait
  | { r: 'Stopped'; detectionRef: Uint8Array }     // integrity stop open; answer "temporarily unavailable"
  | { r: 'Ambiguous' }                             // commit sent, answer lost; runtime resolves by batch_id before the next batch
  | { r: 'Overloaded'; retryAfterMs: Millis };

export interface OwnerRuntime {
  append(call: AppendCall, opts?: AppendOptions): Promise<AppendResult>;
  leaseValid(slot: SlotNo): { valid: boolean; untilMonotonic: MonotonicNs };
  epoch(slot: SlotNo): Epoch;
  generation(partition: PartitionKey): Generation;
  /** Receiver side of every command: refuses below the highest (generation, epoch) recorded for the sending partition. */
  admitCommand(sender: { kind: OwnerKind; partition: PartitionKey }, fence: WriterFence): 'admit' | 'staleSender';
  // time
  timing(): TimingSnapshot;
  now(): { ts: HlcTs; boundMs: Millis };   // liveness only; never decides an outcome (A8)
  // positions
  reportPosition(slot: SlotNo): HlcTs | undefined;   // undefined until onReportable
  onReport(handler: (slot: SlotNo, p: HlcTs) => void): void;
  // reads
  consistentRead<T>(fn: (tx: ReadTx) => Promise<T>, at: 'present' | HlcTs): Promise<T>;
  followerRead<T>(fn: (tx: ReadTx) => Promise<T>): Promise<{ value: T; servedAt: HlcTs }>;
  closedTimestamp(): Promise<HlcTs>;
  // feeds
  subscribe(topic: string, from: FeedCheckpoint, gate: 'committed' | 'reported', handler: (e: FeedEvent) => Promise<void>): void;
  onResolved(topic: string, handler: (destinationPartition: number, R: HlcTs) => void): void;
  onClosed(handler: (link: PartitionKey, t: HlcTs, feedSeq: StreamSeq) => void): void; // link schedule feed
  // timers
  timer(partition: PartitionKey, key: string, atTs: HlcTs): void;
  cancelTimer(partition: PartitionKey, key: string): void;
  // routing
  route(kind: OwnerKind, partition: PartitionKey): RouteInfo;
  slotOf(account: PartitionKey): SlotOfAnswer;       // §2.7
  topology(): { state: string; preferredRegion: 'R1' | 'R2'; disaster: null | { region: string; since: HlcTs } };
  // checkpoints (RFC-006 §12.11)
  putCheckpoint(kind: OwnerKind, partition: PartitionKey, seq: Seq, bytes: Uint8Array): Promise<{ reference: string; digest: Uint8Array }>;
  getCheckpoint(reference: string): Promise<Uint8Array>;
}

export interface TimingSnapshot { version: bigint; epsilonMs: Millis; deltaXMs: Millis; tauMs: Millis }
export interface RouteInfo { slot: SlotNo; generation: Generation; holderHint?: string; epoch: Epoch; readers: string[]; mapVersion?: MapVersion }

// ---------- status readers (kinds with statusReaders: true) ----------
export interface StatusReaderRuntime {
  readLease(slot: SlotNo): { valid: boolean; untilMonotonic: MonotonicNs; appliedThrough: HlcTs; reportPosition: HlcTs; pGrant: HlcTs };
  /** Runs at with_min_timestamp(ceil_µs(max(pGrant, adoptTs(partition)))); throws NotClosed ⇒ answer by rule 4. */
  leasedRead<T>(fn: (tx: ReadTx) => Promise<T>, partition: PartitionKey): Promise<T>;
  isMovedOut(partition: PartitionKey): boolean;      // true ⇒ answer by rule 4
  replicaRule3Check(accountSlot: SlotNo, requestKey: Uint8Array): Promise<{ holderLive: boolean; rows?: unknown }>;
}
export class NotClosed extends Error {}
```

**Wire form of routed commands** (gRPC metadata on every command between owners):

```ts
export interface CommandEnvelope {
  routedTo: { kind: OwnerKind; slot: SlotNo; generation: Generation; epoch: Epoch; mapVersion?: MapVersion };
  sender: { kind: OwnerKind; partition: PartitionKey; generation: Generation; epoch: Epoch; seq?: Seq };
  identity: Uint8Array;                               // A6
}
/** Canonical refusals of routing and fencing (M4). Owner-specific errors are the owner contract's. */
export type RoutingRefusal =
  | { code: 'STALE_EPOCH'; current: Epoch; holderHint?: string }
  | { code: 'NOT_OWNER'; holderHint?: string }        // receiving process holds no lease on the slot
  | { code: 'MOVED'; slot: SlotNo; generation: Generation }
  | { code: 'MOVING'; retryAfterMs: Millis }           // ~100 ms
  | { code: 'STOPPED' }                                // integrity stop: temporarily unavailable
  | { code: 'STALE_SENDER' }                           // admitCommand refused the sender's (generation, epoch)
  | { code: 'OVERLOADED'; retryAfterMs: Millis }
  | { code: 'UNAVAILABLE' };
```

### 2.5 Kafka wire format

- **Topic names** `<owner kind>.<feed>.v<n>`; relay topics `cdc.<kind>`; audit topics
  `cdc.audit.<kind>`; relay progress `relay.progress.<kind>` (compacted); alerts
  `<kind>.alert.v1` (M9); placement `placement.slot_map.v1`, `placement.routing.v1`.
- **Key**: the producing partition; the request outcome feed only: the account slot.
- **Partition count**: a power of two ≥ producer slot count / 4; never decreased.
- **Headers** (clear; nothing else in clear):

```ts
export interface FeedHeaders {
  partition: Uint8Array;
  stream?: string; stream_seq?: string;        // feed events (decimal int64)
  notification_id?: string;                    // point-to-point: "<subject b64>:<attempt>:<kind>"
  generation: string; epoch: string; ts: HlcTs;
  kind: string; schema_v: string; key_id: string;
  report_through?: HlcTs;                      // report marker only
  resolved?: HlcTs;                            // closure marker only
}
export interface FeedEvent { headers: FeedHeaders; value: Uint8Array /* sealed under the topic's feed key */ }

/** Report marker, request outcome feed (RFC-002), keyed by slot (M6). */
export interface ReportMarker { slot: SlotNo; generation: 0; epoch: Epoch; reportPosition: HlcTs }
/** Closure marker per destination partition, published by the closure emitter. */
export interface ResolvedMarker { destinationPartition: number; resolved: HlcTs }      // "no row with ts ≤ resolved follows"
export interface ClosedMarker { link: Uint8Array; t: HlcTs; feedSeq: StreamSeq }      // link schedule feed
/** relay.progress.<kind>, compacted, key = cdc partition k. */
export interface RelayProgress { cdcPartition: number; resolved: HlcTs; linksRelayed?: Uint8Array[] }
```

**Per-topic producer ACL** (settled M8; RFC-005 erratum). Every topic's ACL names exactly
the producing roles below and nothing else; all roles of one row belong to the topic's one
producing owner kind or to the platform component named:

| Topic | Producing roles |
|---|---|
| `<kind>.<feed>.v<n>` (every owner feed, notifications included) | `<kind>-holder` (direct publish after `Committed`), `<kind>-republish` (takeover republish by the new holder, same workload identity class as the holder), `<kind>-relay` (guaranteed path) |
| Feeds carrying closure (§3.6) | The three above **plus** `closure-emitter-<kind>`, which may produce **only** `ResolvedMarker` or `ClosedMarker` messages (enforced by the consumer runtime rejecting any other message from that principal) |
| `account.outcome.v1` | The three above; report markers come from `account-holder` and `account-relay` |
| `<kind>.alert.v1` | `<kind>-holder`, `<kind>-republish`, `<kind>-relay` (self-outboxed `ingest` alerts: `ingest-relay`) |
| `cdc.<kind>`, `cdc.audit.<kind>` | The database's CDC principal only |
| `relay.progress.<kind>` | `<kind>-relay` only |
| `placement.slot_map.v1`, `placement.routing.v1` | `placement-holder`, `placement-republish`, `placement-relay` |

### 2.6 Integrity stop (gRPC, audit → owner runtime / placement)

```proto
service IntegrityStop {
  rpc Stop(StopRequest) returns (StopAck);      // audit only (mTLS workload identity)
  rpc Resume(ResumeRequest) returns (StopAck);  // audit only
}
message StopRequest   { string kind = 1; bytes partition = 2; bytes detection_ref = 3; }
message ResumeRequest { string kind = 1; bytes partition = 2; bytes detection_ref = 3; bytes checkpoint = 4; bytes incident_decision_ref = 5; }
message StopAck { enum State { STOPPED = 0; RESUMED = 1; } State state = 1; string recorded_at = 2; /* HlcTs */ }
// Errors: CONFLICT (same detection_ref, other kind/partition), NOT_STOPPED (resume without an open stop),
//         HEAD_MISMATCH (restored head ≠ audit's first-seen head and no incident_decision_ref), PERMISSION_DENIED.
```

### 2.7 Placement: account slot map and probe set (feed + gRPC)

```ts
export type SplitState = 'unsplit' | 'splitting' | 'split';
export interface SlotMapVersion {
  version: MapVersion; slotCount: number;               // power of two n (2n after a doubling is published)
  previousCount?: number;                               // n while a doubling is in progress
  splitState: Record<SlotNo, SplitState>;               // old slots s < previousCount during a doubling
  overrides: Array<{ account: Uint8Array; slot: SlotNo; reason: 'probe_pin' | 'probe_new' | 'reslot' | 'dedicated' }>;
  publishedAt: HlcTs;
}
export interface SlotOfAnswer { slot: SlotNo; mapVersion: MapVersion; headDecides: boolean }

export interface PlacementApi {                         // gRPC; slotOf is served from the feed cache, query on miss
  slotOf(account: Uint8Array): SlotOfAnswer;
  reslot(req: { accounts: Uint8Array[]; toSlot: SlotNo; reason: string; requestId: Uint8Array; envelope: OperatorEnvelope }):
    Promise<{ accepted: true; versionWhenDone?: MapVersion } | { accepted: false; refusal: 'PROBE_LEFT_WITHOUT' | 'SECOND_PROBE' | 'TARGET_WITHOUT_PROBE' | 'NOT_DOUBLING' | 'CONFLICT' }>;
  doubleSlotCount(req: { kind: 'account'; requestId: Uint8Array; envelope: OperatorEnvelope }): Promise<{ targetCount: number }>;
  probeAccountSet(v: MapVersion): Promise<Array<{ slot: SlotNo; account: Uint8Array }>>;
  probeSetSummary(v: MapVersion): Promise<ProbeSetSummary>;
  slotGroup(kind: OwnerKind, slot: SlotNo): Array<{ kind: OwnerKind; slot: SlotNo }>;
}
export interface ProbeSetSummary {
  mapVersion: MapVersion; slotCount: number; probeAccountCount: number;
  setDigest: Uint8Array;        // SHA-256 over the sorted [(slot int32 BE, account bytes)] of probeAccountSet(v)
  signature: Uint8Array;        // placement's key via RFC-005's signing service, over the four fields above
  keyId: string;
}
```

### 2.8 History query (gRPC, RFC-006 history service)

```ts
export interface EntityRef { ownerKind: OwnerKind; entityType: string; id: Uint8Array } // e.g. ('link','schedule',link), ('account','reservation',r)
export interface HistoryApi {
  /** Owner-defined semantics (RFC-001 schedule_as_known_at, RFC-002 "ts ≤ T", RFC-004 headroom at a position). */
  asKnownAt(q: { entity: EntityRef; T: HlcTs; query: string; params?: unknown; grant?: ReadGrant }): Promise<{ result: unknown; servedThrough: HlcTs }>;
  history(q: { entity: EntityRef; from: HlcTs; to: HlcTs; grant?: ReadGrant }): AsyncIterable<LogRow>;
  entries(q: { kind: OwnerKind; partition: Uint8Array; range: { seq: [Seq, Seq] } | { ts: [HlcTs, HlcTs] }; grant?: ReadGrant }): AsyncIterable<LogRow>;
  replayFrom(q: { kind: OwnerKind; partition: Uint8Array; stream: string; fromStreamSeq: StreamSeq }): AsyncIterable<FeedEvent>;
}
export interface LogRow { slot: SlotNo; partition: Uint8Array; seq: Seq; generation: Generation; epoch: Epoch; kind: number; schemaV: number; ts: HlcTs; identity: Uint8Array; emits: Array<[string, StreamSeq]>; keyId: Uint8Array; payload: Uint8Array /* sealed */; audit: Uint8Array /* sealed */ }
// Errors: NOT_CLOSED (T above the closed timestamp), NOT_FOUND, GRANT_REFUSED (operator read without a valid read grant), UNAVAILABLE.
```

### 2.9 Probe designation (attributes)

```ts
export interface ProbeDesignation {
  entity: { type: 'account' | 'supplier' | 'link' | 'exporter'; id: Uint8Array };
  probe: true;                       // set once at provisioning, never cleared; absent ⇒ not a probe
  setAt: HlcTs; setBy: Uint8Array /* pseudonymous principal */; reason: string;
  /** Settled M11: for accounts the authority is placement's account slot map (which account is a slot's probe);
   *  for links, exporters and the probe supplier, the catalogue (set by network operations). */
  source: 'slotMap' | 'catalogue';
  designatingMapVersion?: MapVersion; // accounts only: the slot-map version that designated it
}

/** Account owner's F9 (RFC-004 Part A), applied from the slot map, recording its version. */
export interface F9ProbeDesignation { account: Uint8Array; excluded: true; slot: SlotNo; designatingMapVersion: MapVersion }
```

### 2.10 Operational alert (stream `alert`, topic `<kind>.alert.v1`)

```ts
export interface OperationalAlert {
  alertId: Uint8Array;               // deterministic: (raising partition, alert kind, subject)
  op: 'raised' | 'cleared';          // 'cleared' by the raiser only (M9)
  alertKind: string;                 // e.g. 'UNDECIDED_PAST_DEADLINE', 'CUT_TARGET_UNMET', 'MOVE_CUTOVER', 'CLOSURE_LAG'
  severity: 'info' | 'warning' | 'page';
  entities: Array<{ type: string; id: Uint8Array }>;   // pseudonymous identifiers only (A11)
  reasonCode: string;
  detail?: Record<string, string | number>;            // no personal data, no free text from users
  raisedAt: HlcTs;                   // the raising entry's ts
}
```

## 3. Semantics

### 3.1 Sessions, slot leases, acquisitions, resume and re-home

- A slot's owner lease is valid while `owner_slot.session_id` names a session that is not
  revoked and whose `expires_at` is in the future by the database clock. Sessions renew
  every 500 ms to `now() + 3 s`, conditional only on `NOT revoked`.
- **Holder's view**: the lease ends at `t_send + session_ttl − ε` by the holder's monotonic
  clock (`t_send`: send time of the last renewal that succeeded inside the view). From then
  the holder proposes nothing, decides nothing from memory, grants or renews no read lease,
  reports nothing and sends no command. Owners must call `leaseValid` immediately before any
  action taken from memory (a headroom answer, a partner confirm, any command sent).
- **Acquisition** (expiry): one high-priority transaction revokes the expired session and
  increments the epoch of every slot taken (a slot group in one transaction). The new holder
  catches up by a high-priority present-time read, then `onAcquire(slot, epoch, 'expiry')`.
- **Handoff**: the holder stops proposing and granting read leases, waits for its in-flight
  batch, and in one transaction names the successor and increments the epoch; the
  successor catches up, `onAcquire(…, 'handoff')`.
- **Resume**: a renewal whose success arrives after the holder's view ended. No
  `onAcquire`; memory kept. Before reporting: resume read at the present timestamp (`T_res`),
  in-flight batches resolved by `batch_id`, slots whose epoch moved released
  (`onRelease('taken')`), report position of each kept slot set to `T_res`; then
  `onReportable` without a further wait.
- **Re-home** (session revoked or replaced): conditional transfer of each slot still at its
  own epoch to a new session, then the full resume (resolution read `T_res`, steps 2–4),
  `onAcquire(…, 'rehome')`, takeover entry, and the `read_lease` + ε reporting wait.
- **Takeover-entry rule**: the owner's first entry in each partition it touches in a new
  epoch (or after `adopt`) is its takeover entry (RFC-001 `Takeover`, RFC-002 E9); timers are
  re-armed from state; work in flight is re-sent with the same identities (RFC-002 §12.1).
- **Initial report position after any acquisition** (expiry, handoff, re-home, resume;
  AI-33-2): the timestamp of the new holder's present-time catch-up read (expiry, handoff) or
  `T_res` (resume, re-home). No read lease is granted with `P_grant` below it. After an
  acquisition commit (not a resume) the holder writes no marker and reports nothing until
  `read_lease` + ε (500 ms) after it learned of the commit; then `onReportable`.

### 3.2 `append` and its results

Preconditions: the caller holds the slot (`leaseValid`); every identity is deterministic;
`projections` delete only declared-deletable tables; `conditions` read only the caller's
own slot, except `displacementRead` (account kind only).

The runtime runs **one batch transaction in flight per slot lane**, carrying every pending
call of every partition of the slot (at most 2,000 entries or 4 MB). In order: `BEGIN`
(serialisable); savepoint; epoch read (must equal the holder's); head rows of each partition
(slot and generation must be the holder's, else that call is `Moved`); integrity-stop check
(else `Stopped`); condition reads (the displacement read under its own savepoint with
`lockTimeoutMs`; a timeout fails only that call's condition as `'lockTimeout'`); `ts` =
`cluster_logical_timestamp()`; each `decide` at `ctx.ts`; seal (C13), chain; inserts and
upserts; `COMMIT`. A call that is `exclusive` goes alone; `firstStatement` is executed as the
transaction's first statement together with the `ts` read. `ts` is shared by every entry of
the batch and is strictly increasing per partition.

| Result | Meaning | Required caller action |
|---|---|---|
| `Committed` | Durable on a majority spanning two regions; the **only** success | Apply to memory; acknowledge; the runtime publishes events and notifications |
| `ConditionFailed(which)` | This call wrote nothing; the rest of the batch may have committed | Owner-specific (e.g. "already decided"; for `'lockTimeout'` RFC-002 defers the confirm to the next batch) |
| `Retry` | Not committed, after up to `batch_retries` (5) restarts keeping intents and one fresh attempt | Retry later with the **same identities**; map to the owner's POL-04 answer if a caller waits |
| `StaleEpoch` | The slot was taken | Stop serving that slot (`onRelease`); fail its in-flight calls "not known to be committed"; other slots continue |
| `Moved(slot, generation)` | The partition lives elsewhere | Re-route to the named slot with the same identity |
| `Moving` | Between `moved` and `adopt` (about 100 ms) | Retry after a short wait (≥ 20 ms, backoff) with the same identity; never a failure to the buyer by itself |
| `Stopped` | Integrity stop open on the partition | Decide nothing; answer the caller "temporarily unavailable"; retry only after the stop is lifted (runtime pushes the resume) |
| `Ambiguous` | `COMMIT` sent, answer lost, or the 15 s commit backstop expired (settled M1) | **Never aborted blind**: before anything further is decided in **that slot**, the runtime runs the resolution step of a resume (§3.1 step 1–2): a present-time read of the slot's `owner_slot` row and of the head rows the batch would have upserted; committed if any carries the batch's `batch_id`, otherwise not committed (and re-evaluated); if the epoch is no longer the holder's, `StaleEpoch`. No batch of the slot starts, and the owner decides nothing for the slot from memory, until it completes; then every partition of the batch is reloaded and callers are answered `Committed` or re-run |
| `Overloaded(retryAfter)` | Admission control, event-loop shedding, or exhausted retries | Back-pressure; owner maps to its POL-04 answer |

Every result except `Committed` and `ConditionFailed` means "not known to be committed":
the owner's memory for every partition of the batch is rebuilt from head, projections and
log before its next decision. A consumer receiving an **unknown future result** treats it
as `Retry` and alerts (§8).

Integrity stops: while a stop is open on (kind, partition), every `append` of that partition
answers `Stopped` under every holder, across takeovers and moves; every holder reads
`placement_integrity_stops` on acquisition, resume and `adopt`, and placement pushes changes
to the current holder.

### 3.3 Moves, `Moving`, `onMovedOut` and `onAdopt`

A partition X moves from slot A to slot B (hot link to a dedicated slot, re-slotted account,
upper-half account in a doubling split, hot exporter to its own slot):

| Step | Who | What | X is served by |
|---|---|---|---|
| 1 | Placement | `partition_moves` row (X, A → B, generation g+1), `prewarm` | A |
| 2 | B's holder and standbys | Load X (checkpoint or replay), then tail A's pushes until within one batch | A |
| 3 | A's holder | Appends `moved(to B, g+1)` and sets X's head row `slot = B, generation = g+1` in one batch; from that commit answers every command for X `MOVING` and calls **`onMovedOut(X)`** | nobody (`Moving`) |
| 4 | A's holder | Report fence: advances A's report position past `ts(moved)` and writes the marker (`report_through ≥ ts(moved)`); pushes it to B's holder | nobody |
| 5 | B's holder | After seeing `report_through ≥ ts(moved)` (push, or a bounded-staleness read of A's partition `''` head row after 100 ms), appends `adopt(g+1)` conditional on `head(X).slot = B ∧ generation = g+1`, recording the fence evidence; continues `seq`, `chain` and every `stream_seq`; calls **`onAdopt(X, g+1)`** | B |
| 6 | B's holder | Reports nothing for X until `read_lease` + ε after `adopt` | B |
| 7 | Placement | Marks the move done; publishes routing (for accounts, a new map version) | B |

Kinds without status readers skip step 4's fence wait. `Moving` beyond 1 s pages. If A's
holder fails after `moved`, its successor continues at step 4; if B's fails, B's standby
adopts. **`onMovedOut` obligations**: cancel every timer of X, decide nothing for X, send no
command for X, keep reporting entries already committed. **`onAdopt` obligations**: re-arm
X's timers from its state, write the takeover entry in X's first batch, re-send what the
takeover-entry rule re-sends for X (releases, conversions, leg changes, offers…), and report
nothing for X until the runtime's per-partition wait ends. Readers of A that applied `moved`
answer X by rule 4; readers of B answer X by rule 2 only from state that includes `adopt`.

### 3.4 Report position, read leases and status readers (kinds with `statusReaders`)

Report position P of a slot: every entry with `ts ≤ P` is committed and applied by every
reader holding a live read lease (or that lease has expired). Owners report outcomes only at
or below P. A read lease lasts 400 ms from the reader's send time, treated as expired ε
(100 ms) earlier, is granted only if the reader has applied through P, it ends inside the
holder's view, the holder is not handing off, and the post-acquisition wait is over.
`P_grant` is fixed at the start of a continuous lease. Report markers are due only when P
passes a `reportWanted` entry or one that emitted an outcome event, ride the slot's next
batch or a marker-only transaction (at most 20 ms later, outside the lane, serialised on
partition `''`), and are never written by a stale epoch.

### 3.5 Outbox, publication and consumption

Events and notifications are written only through `append` and published only after
`Committed`, by two paths: direct publish by the holder (`acks=all`, idempotent producer) and
the changefeed relay; a takeover republishes the slot's rows above the kind's closure
position (bounded to 30 s before the acquisition, at most 5,000 rows/s per process).
`subscribe` delivers feed events in `stream_seq` order per (producer partition, stream),
buffering later ones, dropping lower ones, and filling a gap after `gap_timeout` (5 s) from
the producer's outbox (follower read) or, below 25 h, from history. Gate `reported` holds an
outcome until a marker of the same slot with epoch ≥ the event's and position ≥ its `ts`.
Owner consumers checkpoint (partition, stream, `stream_seq`) in their own `append`. Notifications
are delivered by `onNotification`, deduplicated by identity, in no order, with no high-water
rule.

### 3.6 Closure

The closure emitter (one platform slot per relayed kind) computes `R_min`, the minimum over
every `cdc.<kind>` partition of the relay's acknowledged progress, and publishes per
destination partition of each stream declared with closure: `ResolvedMarker` ("no row with
`ts ≤ resolved` follows on this destination partition") or, on the link schedule feed,
`ClosedMarker(link, t, feedSeq)` (`feedSeq` read from `link_head.streams` as of `t`), for links
whose `feed_seq` changed, as a 10 s heartbeat for every link, and for every link once by a
new emitter holder. Markers never go back; consumers ignore one at or below their last.
`onResolved` fires only after every buffered event with `ts ≤ R` of that destination
partition has been delivered. Owners emit no closure markers of their own. Streams carrying
closure (M7): reservation lifecycle (RFC-002), link schedule (RFC-001, `closedPerLink`),
catalogue (RFC-003), metering hand-off (RFC-003, self-outboxed), identity status push
(RFC-005), ledger movement (RFC-004).

### 3.7 Timers

`timer(partition, key, atTs)` is holder-local; its deadline must be recorded in an entry.
Firing only makes the owner append an entry (A8). Timers are re-armed from state on
`onAcquire` (the slot's partitions) and `onAdopt` (that partition), and cancelled by
`onMovedOut`.

### 3.8 Routing and the account slot map

`route(kind, partition)` answers from the placement cache, refreshed by the placement feed
and by any `STALE_EPOCH`, `MOVED` or `MOVING` answer. Every command carries
`CommandEnvelope.routedTo`; the receiver answers a stale one with a `RoutingRefusal`, and
applies a command already applied (same identity) by answering its recorded result.

`slotOf(account)`: an override row if any; else with `h = hash(account) mod 2²⁰` and
`s = h mod n`: unsplit → `s`; **splitting** → lower half (`h mod 2n = s`) `s`, upper half
(`h mod 2n = s + n`) the slot **its head row names**, answered `{ slot: s or s + n,
headDecides: true }`; the router then follows the last `MOVED` answer it got for that account
(cached until the slot is split), starting at `s`; split → `h mod 2n`. While `s` is splitting,
both `s` and `s + n` **defer to the head row**: `s` answers `MOVED(s + n)` only for an
account whose head names `s + n`; `s + n` serves an account whose head names it and answers
`MOVED(s)` otherwise; `s`'s holder creates no upper-half account (a creation with no head row
gets `MOVED(s + n)`), `s + n`'s holder creates it with its head naming `s + n` from the first
entry. Placement lists `s`'s upper-half accounts only after `s`'s holder has acknowledged the
version marking `s` splitting. Outside a splitting slot, an owner answers `MOVED` for an
account its current map version places elsewhere; a command with an older map version is
re-routed by the sender.

**Doubling only**: `n → 2n`, never otherwise, never lowered. Before publishing `2n`, every
existing probe account is pinned by an override, one probe account per new slot is provisioned
by override and its credit limit answered `applied`; then the version with `2n` (all old slots
unsplit); then lazy splits (16 at a time), each `unsplit → splitting → split`. Re-slotting is
refused (with the reason) if it would move a probe account out of its slot, put a second probe
account in a slot, target a slot without one, or change the count other than by doubling. A
slot is published only after its probe account's limit is `applied`.

`probeAccountSet(v)` is the exact set of probe accounts of version v; `probeSetSummary(v)`
signs (version, slot count, probe-account count, set digest) with placement's key through
RFC-005's signing service; the four-eyes approval shows it and RFC-005 verifies it.

### 3.9 History query

History never writes an owner's state. It guarantees **completeness** (every committed entry
of a `7y` class in range is returned, for 7 years; `ops` for 400 days) and **immutability**;
the **meaning** of `asKnownAt` is the owner RFC's declared query (RFC-001 known-at by decision
time vs recorded-at by `ts`; RFC-002 entries with `ts ≤ T`; RFC-004 headroom inputs at a
position). `T` above the closed timestamp answers `NOT_CLOSED`. Results are served seamlessly
from the live tail and the archive; replays run the owner's decoder and apply logic of the
recorded `schema_v` and logic version, never a newer rule. Operator reads carry a read grant;
history checks it with `operator_check` and appends its audit record before answering (M13).

### 3.10 Probe designation and exclusion

1. Designation is set only at provisioning, with reason, audited, only on an entity with no
   history, and **never cleared**. **Accounts** (settled M11): placement's account slot map is
   the sole authority for which account is a slot's probe account; placement provisions the
   account in identity (which holds it as a Share-internal tenant with KYB passed) and
   publishes it in a map version; the account owner applies it as F9 (`excluded`) and records
   the designating slot-map version. Identity holds the account and the catalogue may show the
   designation, but neither decides it. **Links, exporters and the probe supplier**: set by
   network operations in the catalogue.
2. A probe account books only probe links (1 Mbps, one-minute windows); a non-probe account
   may not book a probe link: the account owner refuses at intake as invalid. Probe exporters
   report only flows on probe links.
3. Rating produces no charge line for a probe account's reservation or a probe exporter's
   record; settlement, supplier reports and quarantine reports therefore contain nothing of
   them. Consumers take an account's designation from the slot map (directly, or as the
   account owner's F9 and the feeds derived from it) and a link's, exporter's or supplier's
   from the catalogue; since designation never changes, any position gives the same answer.
4. Probe accounts' credit holds are real; their limits are set by one set-scoped finance
   action over `probeAccountSet(v)`; "probe account headroom below 25%" pages.
5. Exactly one probe account per account slot (§3.8).

### 3.11 Operational alerts

An owner raises an alert as an entry in its own log emitting on stream `alert`; platform
components without a log raise through the alert service's own `append`. The alert service
deduplicates by `alertId`, tracks raised → acknowledged → resolved, escalates unacknowledged
pages after 5 min and routes by `alertKind` (routing rules are data). A raiser may emit
`cleared` for its own `alertId` (e.g. RFC-001's `CUT_TARGET_INEXACT` withdrawn). Every producer
and the alert service heartbeat every minute to an external dead-man's switch.

### 3.12 Column encryption binding (RFC-005 C13)

The runtime seals every application column of every row it writes (log payload under the
log key, `audit` under the audit-column key, outbox rows under the topic's feed key) before
the transaction, with associated data (owner kind, table, primary key, sequence or version,
epoch, row kind, key identifier); compresses before sealing; recomputes seals and chains on
every retry (new nonces). Consumers' runtimes open on read and reject (and raise a security
alert) any row that fails to open or whose version is lower than one already seen. Clear
columns are only those in §2.3 and each projection's declared `clearColumns`. Checkpoints are
sealed under the partition's log key.

## 4. Delivery and ordering

| Item | Delivery | Ordering scope | Partition key |
|---|---|---|---|
| `append` entries | Exactly-once effect (per identity, deduplicated by the owner in the applying transaction) | Total per partition by `seq`; `ts` strictly increasing per partition | — |
| Feed events | At least once (direct, relay, republish) | Per (producer partition, stream) by `stream_seq`; none across partitions | Producing partition (outcome feed: account slot) |
| Notifications | At least once (gRPC push, relay) | None | Receiving partition |
| Report markers | At least once, monotone | Per account slot | Account slot |
| Closure markers | At least once, monotone | Per destination partition (per link for `CLOSED`) | Destination partition |
| Relay progress | At least once, compacted | Per `cdc` partition | `cdc` partition |
| Slot map versions | At least once, in version order | Global | Single partition |
| Alerts | At least once; deduplicated by `alertId` | Per raising partition | Raising partition |
| Integrity stop | Synchronous; acknowledged once durable in placement | Per (kind, partition) | — |

## 5. Idempotency

| Operation | Key | Duplicate | Same key, different content |
|---|---|---|---|
| `append` entry | Entry `identity` (owner-defined, deterministic) | Owner returns the recorded result; no second effect | Owner contract decides (typically a recorded refusal); the runtime never merges |
| Feed event | (partition, stream, `stream_seq`) | Dropped | Impossible by construction; a consumer that sees it raises a security alert and keeps the first |
| Notification | (subject, attempt, kind) | Dropped | Receiver keeps the first, alerts |
| Command | `CommandEnvelope.identity` | Answered with the recorded result | Owner contract's refusal |
| Report / closure marker | (slot or destination, position) | Ignored at or below the last | — (monotone) |
| `Stop` / `Resume` | `detection_ref` | Same `StopAck` | `CONFLICT` |
| `reslot`, `doubleSlotCount` | `requestId` | Same answer | `CONFLICT` |
| `putCheckpoint` | (kind, partition, seq) | Same reference and digest | Error `DIGEST_MISMATCH`, alerted |
| Alert | `alertId` + `op` | Deduplicated | Later `detail` replaces earlier for display; severity only rises |
| Slot map | `version` | Ignored | Impossible (insert-only); a consumer seeing it stops routing and alerts |

## 6. Ownership

| Data | Sole writer | May read |
|---|---|---|
| `<kind>_log`, `_head`, `_outbox`, projections | The kind's lease holder, through `append` | The kind; platform roles of §2.3 (sealer, gap fill, closure emitter, status readers, audit changefeed); other owners only where RFC-000 §8 names it (`link_displacement` to the account owner) |
| `owner_session` | Its process (renewal), acquirers (`revoked`) | Every owner process, standbys, status readers |
| `owner_slot` | Acquisition, handoff and re-home transactions | Same |
| Placement tables, slot map, integrity stops, probe-account list | Placement (integrity stops on audit's command only) | Everyone through the placement feed and gRPC, never by SQL |
| Relay progress, closure markers | Relay (progress), closure emitter (markers) | Closure emitter; feed consumers |
| History archive and indexes | History (from logs; never an owner's writer) | Callers of §2.8 |
| Probe designation | Accounts: placement (slot map), applied by the account owner as F9 with the designating map version; links, exporters, probe supplier: catalogue | Every consumer |
| Alert state | Alert service | Console, routing targets |
| Kafka topics | Exactly the producing roles of the per-topic ACL (§2.5) | Consumers named in each feed's contract |

## 7. Timeouts and deadlines

| Parameter | Value | Note |
|---|---|---|
| `ε` (`max_offset`) | 100 ms | Owner hosts leave at 50 ms offset |
| `session_ttl`, `session_renew` | 3,000 ms, 500 ms | Renewal retried every 100 ms on error |
| Per-tier gateway timeout (renewal, epoch read, session poll) | 400 ms | Breaker after 3 timeouts |
| `idle_in_transaction_session_timeout` | 1,000 ms | Aborts a paused holder's open batch |
| `statement_timeout` | 2,000 ms | Every statement except `COMMIT` |
| Abandon before `COMMIT` | 2,000 ms from `BEGIN` (owner may set lower, RFC-001 250 ms) | ROLLBACK, re-propose |
| `COMMIT` | Exempt from the 2 s timeout; 15,000 ms backstop ⇒ `Ambiguous`, resolved by a present-time read before the slot decides again (settled M1) | Never aborted blind |
| `batch_retries` | 5 restarts + 1 fresh attempt | Then `Retry`/`Overloaded` |
| Displacement read lock timeout | 10 ms (RFC-002's figure) | Fails only that call (`lockTimeout`) |
| `read_lease`; post-acquisition reporting wait | 400 ms; 500 ms | Reader treats lease as expired ε early |
| `heartbeat_interval` (holder → readers) | 100 ms | |
| `marker_max_wait` | 20 ms | |
| `Moving` | ~100 ms expected; page at `move_cutover_max` 1,000 ms | Fence wait before reading A's head by bounded read: 100 ms |
| `gap_timeout` | 5,000 ms | |
| `republish_window`, `republish_rate` | 30 s, 5,000 rows/s per process | |
| Closure heartbeat; closure-lag page | 10 s; 10 s (60 s during a drain) | |
| Outbox retention | 26 h row TTL, 25 h GC | Older replay from history |
| Takeover (expected) | 3.3–3.8 s from last renewal, p99 ≤ 5 s | +1 s cross-region `standby_grace` |
| Alert escalation | 5 min unacknowledged page | |
| History query timeout | 30 s statement | |

## 8. Versioning and compatibility

- This contract is versioned `C01 vN`; a frozen version is tagged `contract-C01-vN`.
- **Runtime API** (TypeScript package `@share/owner-runtime`): semantic versioning. Adding an
  optional field or option is minor; adding an `AppendResult` variant, a `RoutingRefusal`
  code, a required hook or changing a result's meaning is **major** and needs a new contract
  version. Consumers switch exhaustively and treat an unknown result as `Retry` plus an alert;
  an unknown refusal code as `UNAVAILABLE`.
- **Entries**: `schema_v` per entry kind; decoders and apply logic of every version kept 7
  years; a new version never reinterprets an old entry.
- **Topics**: `.v<n>` in the name; a breaking event change is a new topic version, both
  published until every consumer has moved; header set may only grow.
- **Slot map**: `version` strictly increasing; consumers must accept split states and
  `headDecides` from v1.
- **`platform_timing`**: `version` per row; owners read it in the transaction, never cache it
  across batches.
- **Tables**: columns may be added (nullable); keys and clear-column sets change only by a new
  contract version and a migration.

## 9. Scenarios relied on (requirements-v1.10)

X2-S03, X2-S04, X2-S05, X2-S06, X2-S09, X2-S10, X2-S11, X2-S12, X2-S13, X2-S14, X2-S15,
X2-S16, X2-S18, X2-S19, X2-S20, X2-S21, X2-S22, X2-S23, X2-S24, X2-S27, X2-S30, X2-S33;
P1-S33, P1-S54, P1-S62, P1-S63; P2-S10, P2-S22, P2-S23, P2-S53, P2-S104, P2-S106, P2-S107,
P2-S111; P3-S36, P3-S39; P4-S72, P4-S81; X1-S14, X1-S15, X1-S31, X1-S37.

## 10. Conformance tests

### 10.1 Provider (RFC-006) contract tests

| Id | Test |
|---|---|
| CP-1 | Two processes contend for a slot across pauses, renewals, revocations and ambiguous commits (fault injection): no partition ever has two committed writers; `seq` contiguous, `ts` strictly increasing per partition |
| CP-2 | Every `AppendResult` is produced by an injected cause and carries the documented effect (`ConditionFailed` commits the rest of the batch; `Retry` only after 5 restarts + 1 fresh attempt) |
| CP-2a | `Ambiguous` (lost answer, and the 15 s backstop expiring): no batch of the slot starts and no decision from memory is allowed until the present-time resolution read has classified the batch by `batch_id`; injected both ways (committed, not committed) and with an epoch change (⇒ `StaleEpoch`) |
| CP-2b | Producer ACL: each role of §2.5 can produce only to its listed topics; the closure emitter's principal is refused for anything but markers; no other principal can produce |
| CP-2c | Platform read roles: each role of §2.3 can SELECT only its listed tables and has no write grant |
| CP-3 | `decide` is re-run on every restart with a new `ts`; nothing from an earlier attempt commits (M2) |
| CP-4 | `exclusive` + `firstStatement`: placeholders are intents before any other write, and a concurrent displacement read meets them (M3) |
| CP-5 | Move protocol: `MOVING` between `moved` and `adopt`; `onMovedOut` after `moved` commit, `onAdopt` after `adopt` commit; `adopt` never before `report_through ≥ ts(moved)`; no report for X before `read_lease` + ε after `adopt`; `seq`, `chain`, `stream_seq` continue |
| CP-6 | Integrity stop: `Stopped` under the current holder, after a takeover and after a move; resume refused on head mismatch without an incident decision; restore role cannot write an unstopped partition |
| CP-7 | Initial report position: after expiry, handoff, re-home and resume, no lease with `P_grant` below the catch-up/resolution read; a rule-3 answer during a lapse is never contradicted by a leased reader |
| CP-8 | Closure: markers never precede a row at or below them on the destination partition, under relay rebalances, emitter takeover and changefeed recreation; `R_min` never goes back |
| CP-9 | Feeds: duplicates across direct, relay and republish paths dropped by (partition, stream, `stream_seq`); gaps filled within `gap_timeout`; `reported` gate holds outcomes until a covering marker |
| CP-10 | Slot map: doubling with probe pins; splitting state answers `headDecides`; `s` and `s+n` defer to head rows; no account created on the wrong side; refusals of §3.8; no published slot without an `applied` probe limit; `probeSetSummary` verifies with RFC-005 |
| CP-11 | Grants: conformance job fails on UPDATE/DELETE on a log table by an application role, DELETE on an undeclared projection, or a cross-owner SELECT not listed in §2.3 |
| CP-12 | History: completeness over live tail + archive boundary; `NOT_CLOSED` above the closed timestamp; operator reads without a grant refused |
| CP-13 | Encryption: a row copied to another key, sequence or epoch fails to open everywhere; no clear column outside the declared set (schema lint) |

### 10.2 Consumer contract tests (every owner kind)

| Id | Test |
|---|---|
| CC-1 | Exhaustive result handling: a stub runtime returns each `AppendResult` (and an unknown one); the owner takes exactly the action of §3.2, retries with the same identities, never acknowledges before `Committed` |
| CC-2 | `onMovedOut(X)`: afterwards no timer of X fires, no entry or command for X is produced; commands for X answered `MOVING` |
| CC-3 | `onAdopt(X, g)`: timers of X re-armed from state equal those a fresh `onAcquire` would arm; takeover entry written in X's first batch; pending re-sends issued with the original identities |
| CC-4 | `Stopped`: the owner decides nothing for the partition, answers "temporarily unavailable" (or its contract's equivalent), and resumes after the push |
| CC-5 | As a sender: `MOVING`, `MOVED`, `STALE_EPOCH`, `NOT_OWNER`, `STOPPED` from a receiver re-route or back off with the same identity |
| CC-6 | Idempotent consumption: replaying any feed twice and out of order yields the same state; checkpoint recorded in the applying `append` |
| CC-7 | Leased decisions: every reply or command from memory is preceded by `leaseValid` (instrumented) |
| CC-8 | Declaration: entry kinds, retention classes, deletable projections, streams and closure flags match the owner RFC |

### 10.3 Consumer obligations per RFC (decision C4-7)

This table is the **errata list** of C01. "In rev. 5?" (for RFC-000: rev. 4.4; for RFC-006:
rev. 6) says whether the RFC already states it; every "No" item becomes an erratum on that RFC
once this contract is frozen.

| RFC (kinds) | Obligation | In rev. 5? |
|---|---|---|
| **RFC-001** (link, link registry) | `onAcquire`/`onRelease`, takeover entry, timers re-armed (§8) | Yes |
| | `onMovedOut(link)`: cancel the link's timers (expiry requests past `D`, `ReductionEffective`/`ReductionStep`, offer-lapse backstops, effective boundaries, due notices), stop deciding and sending for it | **No** |
| | `onAdopt(link, g)`: re-arm those timers from state, `Takeover` entry in the link's first batch, resume projections from their checkpoint rows, continue a frozen cut set | **No** (prose in §8 only for the hot-link move) |
| | Answer `MOVING` for a link between `moved` and `adopt`; treat `MOVING` from an account owner as retry | **No** |
| | `Stopped`: decide nothing, answer `UNAVAILABLE`; treat `STOPPED` from the account owner as back-off | **No** |
| | Use `MOVED(slot, generation)` (not `Moved(epoch)`) and the canonical refusal codes (M4) | **No** |
| | Capacity-lowering entries via `exclusive` + `firstStatement` + `abandonBeforeCommitMs: 250`; decisions at `ts` via `decide` (M2, M3) | Yes in substance; signature **No** |
| | Deletable projections `link_displacement`, `link_reduction_cut` only; `link_request` row TTL | Yes |
| | Alerts on `link.alert.v1` (not the schedule feed), with `cleared` for withdrawn alerts (M9) | **No** |
| | Closure only from the emitter (`onClosed`); no own `CLOSED` | Yes |
| | Checkpoint store, probe flag on links | Yes |
| **RFC-002** (account, partner adapter; status readers) | `Moving` handled by retry/re-route | Yes |
| | `Stopped` handled (account and adapter partitions): "temporarily unavailable", nothing decided | **No** |
| | Route by `slotOf(…).headDecides`, follow the last `MOVED`; in a splitting slot defer to the head row (`s` answers `MOVED(s+n)` only for heads naming `s+n`; `s+n` answers `MOVED(s)` otherwise); creation of upper-half accounts only in `s+n`; acknowledge the splitting version | **No** |
| | `onMovedOut(account)`: cancel the account's timers (`D`, `offer_window`, `due(S)`, position gates), stop deciding | **No** (named hook) |
| | `onAdopt(account, g)`: recovery queries for the partition, E9, re-sends, identity catch-up if stale, per-partition reporting wait | Partly (§2.5 prose); hook **No** |
| | Initial report position after any acquisition (catch-up/resolution read; no `P_grant` below it), cited in the P2-S111 argument | **No** |
| | Status readers: `leasedRead` with `adoptTs`, `isMovedOut` ⇒ rule 4, `replicaRule3Check` | Yes |
| | Report markers only by the runtime; feed dedup by (partition, stream, `stream_seq`) (M5, M6) | Partly |
| | Displacement read as `displacementRead` condition with 10 ms lock timeout ⇒ defer (M3) | Yes in substance |
| | Probe accounts' designation taken from placement's slot map (not the catalogue), applied as F9 recording the designating slot-map version (settled M11) | **No** (§13.2 says catalogue) |
| | `Ambiguous`: decide nothing in the slot until the runtime's present-time resolution completes (settled M1) | Partly ("reload"); the wait **No** |
| **RFC-003** (ingest, attr A, attr B, rating, catalogue) | Slot groups acquired together; `onAcquire` per slot before the group serves | Yes |
| | `Stopped` and `Moving` handled on every kind (callers retry; ingestion answers exporters "temporarily unavailable") | **No** |
| | `onMovedOut`/`onAdopt` for moved partitions (a hot exporter moved to its own slot; a doubling of a kind) | **No** |
| | Closure only from `onResolved`; catalogue and metering hand-off declared with closure (M7) | Yes; declaration **No** |
| | The catalogue may show an account's probe designation but does not decide it; rating's exclusion of probe accounts uses the slot-map-derived designation (settled M11) | **No** (§6.1 lists probe accounts as a catalogue entity) |
| | `ingest_log` self-outboxed with three streams and emit functions; drop alerts to the alert feed | Yes |
| **RFC-004** (funds module, ledger, settlement, payments, receivables, reconciliation, payouts) | `Stopped` on every kind: posting-port callers retry with the same movement identity; a payout run or cut job waits | **No** |
| | `Moving`, `onMovedOut`/`onAdopt` (timers: payout runs, cut jobs, invoice issue, `due(S)`) | **No** |
| | Set-scoped credit-limit action over `probeAccountSet(v)` with `probeSetSummary(v)` shown and verified | Yes |
| | Ledger movement feed dedup by (partition, stream, `stream_seq`) (M5); closure declared on it (M7) | **No** |
| | Cut job within the 4 h MVCC window (`gc.ttlseconds`) | Yes |
| | F9 applied from placement's slot map, recording the designating slot-map version (settled M11) | Yes for the source; version **No** |
| **RFC-005** (identity, edge, audit, console) | Edge forwards by `route`/`slotOf` with `headDecides`, follows `MOVED`/`MOVING`, keeps no mapping | Partly (§2.2 step 8); `headDecides` **No** |
| | Identity kind: `Stopped`, `Moving`, `onMovedOut`/`onAdopt` | **No** |
| | Audit is the only caller of `Stop`/`Resume`; resume rule (first-seen head or incident decision) | Yes |
| | Verifies `probeSetSummary(v)` signature at the four-eyes approval | Yes |
| | C13 library meets §3.12's binding | Yes |
| | Kafka ACL: replace "one producing workload identity (the relay)" by the per-topic producer list of §2.5 (settled M8) | **No** (§4.4) |
| | History as a receiver of operator read grants (settled M13) | **No** (§4.4, §7.6) |
| | Identity holds probe accounts as tenants but does not decide designation; C9's flag follows the slot map (settled M11) | **No** (§3.5, C9) |
| **RFC-000** (architecture) | §8 substrate row and AI6-6 wording: "`COMMIT` never aborted blind (15 s backstop ends as `Ambiguous`, resolved by a present-time read before the slot decides again)" instead of "no `COMMIT` timeout" (settled M1) | **No** |
| | A1: list the named platform read roles of §2.3 (`history_sealer`, `feed_gapfill`, `closure_emitter`, `status_reader`) beside the link displacement read (settled M10) | **No** |
| | §8 probe designation row: accounts designated by placement's slot map, links/exporters/supplier in the catalogue (settled M11) | **No** ("flag in catalogue and identity") |
| **RFC-006** (provider) | §12.2 `append`: `decide(ctx)`, `AppendOptions`, `displacementRead` (M2, M3); canonical refusals (M4); closure on six streams with sizing (M7); per-topic producer ACL (M8); alert topic and `cleared` (M9); Ambiguous resolution before the slot decides again (M1); `ProbeDesignation` source for accounts = slot map (M11) | **No** |
| | §17.3: a slot-minute whose every probe failed is unavailable even with fewer than 3 probes (X2-S30, v1.10), and a short-probed slot alerts network operations (X2-S33) | **No** |


## 11. Settled

All points the two sides' RFCs disagreed on were settled by the orchestrator (binding). Each
row gives the decision as this contract states it and where the errata are listed (§10.3).

| # | Point | Decision | Errata on |
|---|---|---|---|
| M1 | `COMMIT` timeout (RFC-006 15 s vs "no timeout" in RFC-000/001/002) | **Refined.** Keep the 15 s `COMMIT` backstop; it ends as `Ambiguous`. The runtime resolves every `Ambiguous` batch by the resume's resolution step (present-time read of `owner_slot` and the batch's head rows, by `batch_id`) **before anything further is decided in that slot**. Wording: `COMMIT` is "never aborted blind" (§3.2, §7) | RFC-000 (§8 wording), RFC-006, RFC-002 |
| M2 | `append` signature vs in-transaction decisions at `ts` | **Accepted**: `decide(ctx)`, re-run on every retry (§2.4) | RFC-006, RFC-001 |
| M3 | Transaction shapes (exclusive capacity-lowering batch, placeholder first statement, 250 ms margin; savepointed displacement read with lock timeout) | **Accepted**: `AppendOptions` and the `displacementRead` condition kind (§2.4) | RFC-006 |
| M4 | Routing refusal names | **Accepted**: one canonical `RoutingRefusal` list (§2.4) | RFC-001, RFC-002, RFC-006 |
| M5 | Feed dedup key | **Accepted**: RFC-006's (partition, stream, `stream_seq`) | RFC-002, RFC-004 |
| M6 | Report marker fields | **Accepted**: RFC-006's (slot, generation, epoch, report position), generation 0 | RFC-002 |
| M7 | Feeds carrying closure | **Accepted**: closure markers on all six streams of §3.6 | RFC-006, RFC-003 (declaration), RFC-004 |
| M8 | Kafka producers per topic | **Refined.** RFC-006's producers, with a per-topic ACL naming exactly which roles may produce (holder, takeover republish, relay, closure emitter for markers only, as applicable; §2.5) | RFC-005 (§4.4), RFC-006 |
| M9 | Alert channel and clearing | **Accepted**: `<kind>.alert.v1` with `op: 'cleared'` (§2.10, §3.11) | RFC-001, RFC-006 |
| M10 | Platform reads vs RFC-000 A1 | **Refined.** The named platform roles are accepted, read-only, each listed with what it reads (§2.3) | RFC-000 (A1 lists them) |
| M11 | Source of an account's probe designation | **Override.** Placement's account slot map is authoritative for which account is a slot's probe; the account owner's F9 applies it and records the designating slot-map version (consistent with C07 S1 and C08); identity holds the accounts and the catalogue may show the designation, but neither decides it. Links, exporters and the probe supplier stay catalogue designations (§2.9, §3.10) | RFC-000 (§8), RFC-002, RFC-003, RFC-004, RFC-005, RFC-006 |
| M12 | Doubling of non-account kinds | **Accepted**: doubling for the account kind only in v1 | — (RFC-006 §4.1 reads as v1-limited) |
| M13 | Operator reads of history | **Accepted**: they need a read grant, checked with `operator_check` and audited (§3.9) | RFC-005 |
| N1 | `requirements-v1.10` X2-S30 / X2-S33 vs RFC-006 rev. 6 §17.3 (a slot-minute with fewer than 3 probes, all failed; short-probed slot alerted to network operations) | **Noted** as an RFC-006 erratum; it changes probe-results classification, not this contract's schema | RFC-006 |
