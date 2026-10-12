# C01. Platform contract: owner runtime, account slot map, history query, probe designation, alert feed, column encryption binding

| | |
|---|---|
| Contract ID | C01 |
| Version | 1 (draft 2) |
| Status | **Draft, for fix verification.** Draft 1 was rejected by [review 47](../../reviews/47-contract-C01-review.md) (R47-01, R47-02 Blockers; R47-03 … R47-10 Majors; R47-11 … R47-31 Minors). This draft applies every fix the review proposes and its decisions D1 … D4 (binding; §12 "Review 47 resolution"). The orchestrator settled M1 … M13 (binding; §11 "Settled", unchanged). The errata these imply on slice RFCs and RFC-000 are listed in §10.3 |
| Provider | RFC-006 (platform layer: owner runtime, placement, relay and closure emitter, history, probes, alert service). Column encryption's library is RFC-005's (C13); this contract fixes only how the runtime binds it |
| Consumers | Every owner and reader: RFC-001 (link schedule owner, link registry), RFC-002 (account owner, partner adapters, status readers), RFC-003 (metering ingestion, attribution A/B, rating, catalogue), RFC-004 (funds module in the account owner, ledger, settlement, payments, receivables, reconciliation, payouts), RFC-005 (identity and access, edge, audit, console); and RFC-006's own kinds (placement, notifier, alert service, probe results, history, closure emitter) |
| Transport | Mixed, by part: **in-process call** (owner runtime library, NestJS/TypeScript); **database** (log, head, projection, outbox, session, slot and integrity-stop tables; the platform reads named in §2.3, under RFC-000 A1); **Kafka event** (feeds, report markers, closure topics, relay progress, placement feed, operational alert feed); **gRPC** (integrity stop, slot-map and splitting operations, probe-set summary, history query, checkpoint store) |
| Pinned to | `requirements-v1.10`; RFC-000 rev. 4.4 (§4.6, §5.2, §5.5, §8 rows: substrate conventions, account slot map, history query, probe designation and exclusion, operational alert feed, column encryption); RFC-006 rev. 6 (§3.5, §3.7, §4, §5.3–§5.5, §6.3, §7.1, §12, §13.3, §16, §17); RFC-001 rev. 5 (§5.1, §7, §8, §11); RFC-002 rev. 5 (§2.5, §8.2, §12.1, §13); RFC-003 rev. 5 + erratum 5.1 (§1.1, §3.4, §5.12, §6.4, §7); RFC-004 rev. 5 + erratum 5.1 (§A3, §A4, §B1.3, §B12); RFC-005 rev. 5 (§3.1, §4.4, §5.4, C3, C5, C9, C13) |
| Binding decisions | **C4-7**: this contract is the single definition of the move hooks (`onAdopt`, `onMovedOut`), the `Moving` and `Stopped` results and the slot map's splitting state; §10.3 lists what each consumer RFC must handle. **M1 … M13** (§11). **Review 47 D1 … D4** (§12) |
| Supersedes | C01 version 1 draft 1; the pre-baseline `docs/04-delivery/contracts.md` (not authority) |

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
  state and its handshake, probe accounts, `probeAccountSet(v)` and `probeSetSummary(v)`.
- **P3 History query**: as known at T, ranges, replay.
- **P4 Probe designation and exclusion.**
- **P5 Operational alert feed**, including probing-fault alerts (X2-S33).
- **P6 Column encryption binding** (what the runtime does with RFC-005 C13).

Out of scope: the semantics of each owner's entries, feeds and commands (each owner's own
contract); RFC-005 C13's cryptography; RFC-006's deployment topology, sizing and runbooks,
which no consumer builds against.

**Precondition** (R47-23). The read-lease and holder's-view arguments of §3.1 and §3.4 hold
only while the database's pairwise clock offset stays below `max_offset` (100 ms). That is
given by CockroachDB's self-termination (a node whose offset to a majority exceeds 80% of
`max_offset` leaves) and by RFC-006 §6.3's alarm ladder (an owner host more than 50 ms off
gives up its leases). Commit safety (one writer per partition) does not depend on clocks.

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
export type Seq = bigint;                // int64, contiguous per partition from 1, across slots and moves
export type StreamSeq = bigint;          // int64, contiguous per (partition, stream) from 1
export type MapVersion = bigint;         // int64, strictly increasing per account slot map
export type Millis = number;             // durations in milliseconds unless the name says otherwise
export type MonotonicNs = bigint;        // process.hrtime.bigint() of the calling process

/** Writers of a partition are ordered by (generation, epoch, seq), generation first. */
export interface WriterFence { generation: Generation; epoch: Epoch }
```

Units used in this contract: durations in **ms** (or **s** where stated), timestamps as
`HlcTs`, sizes in **bytes** (KB = 1,000 B; MB = 10⁶ B), rates in **per second**, probe
bookings in **Mbps** (1 Mbps, §3.10). No money amount is carried by this contract. Figures
marked "est." are RFC-006's estimates, to be replaced by the R1 spike's measurements.

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
    ddl: string;                             // owner-defined; the key MUST begin with (home_key, partition) or with
                                             // the owner's logical key starting with the partition; a key beginning
                                             // with `slot` is rejected by the migration tool (R47-01)
    clearColumns: string[];                  // only pseudonymous keys, times, tenant-free enums (RFC-005 §5.4)
    deletable?: boolean;                     // DELETE granted only if true (RFC-001: link_displacement, link_reduction_cut)
    rowTtl?: { column: string; after: string }; // e.g. RFC-001 link_request 24 h
    readableBy?: Array<{ role: string; contractRef: string }>; // cross-owner reads named in RFC-000 §8 only
  }>;
  selfOutboxed?: boolean;                    // RFC-003 ingest_log
  streams: Array<{
    name: string;                            // e.g. 'outcome', 'lifecycle', 'schedule', 'alert'
    topic: string;                           // '<kind>.<feed>.v<n>'
    key: 'partition' | 'slot';               // 'slot' only for the request outcome feed
    emitFn: { version: number };             // entry → event, versioned, kept 7 years (§3.9 replay)
    closure: 'none' | 'resolved' | 'closedPerLink'; // §3.6; markers go to '<topic>.closure' (R47-06)
    reportGated?: boolean;                   // outcome feed: delivered under 'reported' gate
    consumers: OwnerKind[];                  // named consumer kinds; each gets its own gap-fill role (R47-19)
  }>;
  statusReaders?: boolean;                   // true only for the account kind today
  entityIndexes?: Array<{ name: string; from: string; to: 'partition+seq' | 'segment' }>; // §3.9
  bitemporalQueries?: Array<{ name: string; validTime: string; knownTime: 'ts' | 'payloadField'; field?: string }>;
}
```

### 2.3 Database (RFC-006 §3.7, §4.2, §7.1; DDL for CockroachDB)

Per owner kind `<kind>`. **Key rule** (R47-01). The log and outbox are slot-first (a slot's
recent rows contiguous, ranges split along slots); **every row an owner's decision may
depend on after a move is keyed without the slot**: the head row by `(home_key, partition)`,
projections by `(home_key, partition, …)` or by a logical key beginning with the partition,
and the log and outbox carry a secondary index by partition. So a moved partition's earlier
rows are found by its new slot, its standbys and every later takeover, by partition, wherever
they were written. Owner RFCs' logical keys (for example RFC-001's `(link, request)`) map onto
these.

```sql
-- Log: insert only. Clear columns are exactly these plus key_id; audit and payload are C13 ciphertext.
CREATE TABLE <kind>_log (
  slot        INT4  NOT NULL,              -- the slot that wrote the row (history of the partition's slots)
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
  PRIMARY KEY (slot, partition, seq),
  UNIQUE INDEX <kind>_log_by_partition (partition, seq)   -- R47-01: reads across a partition's slot history
);

-- Self-outboxed kinds only (R47-19): stream index derived in the same batch.
CREATE TABLE <kind>_stream_index (
  partition BYTES NOT NULL, stream STRING NOT NULL, stream_seq INT8 NOT NULL, seq INT8 NOT NULL,
  PRIMARY KEY (partition, stream, stream_seq)
);

-- Head: one row per partition, keyed by home so a move changes columns, never the key.
CREATE TABLE <kind>_head (
  home_key    INT4  NOT NULL,              -- 20-bit reversal of home = hash(partition) mod 2^20
  partition   BYTES NOT NULL,
  slot        INT4  NOT NULL,              -- current slot (set to the target by `moved`)
  generation  INT4  NOT NULL,
  adopted     BOOL  NOT NULL DEFAULT true, -- R47-02: false from `moved` until `adopt` commits
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
  PRIMARY KEY (slot, partition, stream, stream_seq, n),
  INDEX <kind>_outbox_by_stream (partition, stream, stream_seq)   -- gap fill across moves (R47-01)
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
  stops_version INT8 NOT NULL DEFAULT 0,          -- R47-04: incremented by every Stop/Resume touching a partition of the slot
  PRIMARY KEY (kind, slot)
);
CREATE TABLE platform_timing (                    -- RFC-006 §6.4; read inside batches for tau
  shard INT2 NOT NULL, version INT8 NOT NULL,
  epsilon_ms INT4 NOT NULL, delta_x_ms INT4 NOT NULL, tau_ms INT4 NOT NULL,
  second_lane JSONB NOT NULL,                     -- {kind: {account|deadline: bool}} (lane (c) excluded in v1, §3.2)
  PRIMARY KEY (shard)
);

-- Placement (owner kind 'placement').
CREATE TABLE placement_account_slot_map (         -- insert-only history; current state in a projection
  version INT8 PRIMARY KEY, slot_count INT4 NOT NULL,          -- power of two
  split_state BYTES NOT NULL,                                   -- encoded {oldSlot: 'unsplit'|'splitting'|'split'} during a doubling
  overrides_digest BYTES NOT NULL, probe_delta BYTES NOT NULL,  -- probe accounts added in this version (R47-21)
  published_at DECIMAL NOT NULL
);
CREATE TABLE placement_slot_override (account BYTES, version INT8, slot INT4, reason STRING, operator BYTES, PRIMARY KEY (account, version));
CREATE TABLE placement_partition_moves (kind STRING, partition BYTES, from_slot INT4, to_slot INT4, generation INT4,
  state STRING CHECK (state IN ('prewarm','moved','adopted','done')), PRIMARY KEY (kind, partition, generation));
CREATE TABLE placement_probe_accounts (slot INT4 PRIMARY KEY, account BYTES NOT NULL UNIQUE,
  designated_in INT8 NOT NULL, limit_state STRING NOT NULL);    -- 'pending'|'applied'
CREATE TABLE placement_split_acks (slot INT4, map_version INT8, epoch INT8, acked_at DECIMAL, PRIMARY KEY (slot, map_version));
CREATE TABLE placement_integrity_stops (kind STRING, partition BYTES, detection_ref BYTES NOT NULL,
  state STRING CHECK (state IN ('stopped','resumed')), checkpoint BYTES NULL, at DECIMAL NOT NULL,
  PRIMARY KEY (kind, partition, detection_ref));
```

**Grants** (R47-18: CockroachDB privileges; RFC-006's conformance job checks them; anything
else fails it):

| Role | Grants |
|---|---|
| Owner service `<kind>` | SELECT, INSERT on `<kind>_log`, `<kind>_outbox`, `<kind>_stream_index`; SELECT, INSERT, UPDATE on `<kind>_head` and its projections; DELETE only on projections declared `deletable`; SELECT on `owner_session`, `owner_slot`, `platform_timing` and **`placement_integrity_stops`** (named read, R47-04); UPDATE on `owner_session` and `owner_slot`, confined by row-level security to rows whose `kind` is the role's kind. Within one kind, a forged session or slot write is **detected, not prevented** (chain and lease audit, RFC-005 §4.4); SELECT on another owner's table **only** where RFC-000 §8 names the read (today: the account owner on `link_displacement`) |
| `truncator` | DELETE on log tables, confined by row-level security to `seq ≤ audit_watermark(kind, partition)` |
| `restore` (break-glass) | Writes only partitions with an open stop in **placement's** `placement_integrity_stops` (row-level security; R47-28). Audit's own table stays the detection record |
| Platform read roles | Below; read-only |

**Named platform read roles** (settled M10, completed per R47-05, R47-19). Each is
read-only, outside any owner transaction, holds SELECT on exactly what is listed, and is
checked by the conformance job (RFC-000 A1 erratum lists them):

| Role | Reads | How | Why |
|---|---|---|---|
| `history_sealer` | Every `<kind>_log` | Follower read at `T ≤ closedTimestamp()` | Sealing segments (RFC-006 §13.2) |
| `gapfill_<consumer>_<producer>` (one per named consumer kind and producer kind) | `<producer>_outbox` rows whose `topic` is one of the consumer's (row-level security on `topic`), or a self-outboxed `<producer>_log` through `<producer>_stream_index` | Follower read, by (partition, stream, `stream_seq`) | Filling a feed gap after `gap_timeout` (§3.5), and the D3 conflict read (§3.5) |
| `closure_emitter` | `<kind>_head.streams` (today `link_head`) | Follower read `AS OF SYSTEM TIME t`, `t` a resolved timestamp | `feed_seq` of `ClosedMarker` (§3.6) |
| `status_reader` | The account kind's log (by partition), head and projections; `owner_session`, `owner_slot` of account slots | Point reads, bounded staleness with minimum timestamp (rule 2); present-time consistent read (rule 3 only) | Status replicas (§3.4) |
| `standby` (same owner kind, not cross-owner) | Its own kind's tables | Follower read; present-time only for a taking-over standby | Tailing and takeover (§3.1) |

Placement lists a splitting slot's partitions **through the holder** (`listPartitions`,
§2.7), not by SQL, so A1 gains no placement read (review 47 A-2, the holder-answered option).

### 2.4 Owner runtime interface (TypeScript, in-process)

```ts
// ---------- lifecycle ----------
export type AcquisitionKind = 'expiry' | 'handoff' | 'rehome';
export interface OwnerHooks {
  /** After the acquisition commit and present-time catch-up; once per slot of a group, all before the group serves.
   *  'rehome': memory is still valid; re-arming is idempotent (`timer` with an existing key replaces it);
   *  the takeover entry is still written (R47-15). */
  onAcquire(slot: SlotNo, epoch: Epoch, kind: AcquisitionKind): Promise<void>;
  /** Slot lost (StaleEpoch, revoked and taken, handed off). Drop the slot's memory. */
  onRelease(slot: SlotNo, reason: 'staleEpoch' | 'handedOff' | 'taken' | 'shutdown'): void;
  /** Reporting enabled: read_lease + ε after an acquisition commit, or at once after a resume (§3.1). */
  onReportable(slot: SlotNo): void;
  /** After `moved(to, g+1)` commits in the old slot: cancel the partition's timers, stop deciding for it.
   *  Memory may be dropped once the report fence (§3.3 step 4) is written. Must not append for the partition. */
  onMovedOut(partition: PartitionKey): void;
  /** After `adopt(g+1)` commits in the new slot (head.adopted = true): re-arm the partition's timers from its state,
   *  rebuild the admitCommand high-water marks it records, and apply the takeover-entry rule to it. */
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
  senderFence?: { kind: OwnerKind; partition: PartitionKey } & WriterFence; // R47-24: recorded for admitCommand
  /** C04 v2: on an outcome entry, the request id if the slot answered that request `pending` before.
   *  The runtime puts it in `pendingAnswered` of the first marker that covers this entry's ts (§3.4). */
  pendingAnswered?: Uint8Array;
}
export interface ProjectionWrite { table: string; op: 'upsert' | 'delete'; key: unknown; row?: unknown } // delete only on declared deletable
export interface NotificationOut {
  to: { kind: OwnerKind; partition: PartitionKey };
  id: { subject: Uint8Array; attempt: number; kind: string };  // (request or reservation, attempt, kind)
  body: unknown;
}
export interface RowRef { table: string; key: unknown }       // projection, head or (displacement) row, keyed by partition

export type Condition =
  | { kind: 'rowAbsent' | 'rowPresent'; row: RowRef; label: string }   // rows of partitions the slot serves (§3.2)
  | { kind: 'tsBefore'; bound: (t: TimingSnapshot) => HlcTs; label: string }  // e.g. ts < D − τ
  | { kind: 'displacementRead'; link: PartitionKey; request: Uint8Array; attempt: number; // account owner only;
      lockTimeoutMs: Millis; label: string };                                              // keyed (link, request); savepoint

/** In-transaction context given to `decide`, after the epoch, stops_version, head rows, `reads` and condition rows
 *  are fetched and ts is fixed. Synchronous (R47-11). Re-created on every restart of the transaction (M2). */
export interface BatchContext {
  ts: HlcTs; timing: TimingSnapshot;
  head(partition: PartitionKey): HeadRow;
  read(row: RowRef): unknown | undefined;  // only rows listed in AppendCall.reads or in conditions
  conditionResults: Record<string, boolean | 'lockTimeout'>;
}
export interface AppendCall {
  partition: PartitionKey;
  conditions?: Condition[];
  reads?: RowRef[];                        // fetched with the condition reads, before any write (R47-11)
  /** Static form: entries known before the transaction. */
  entries?: EntryInput[]; projections?: ProjectionWrite[]; notifications?: NotificationOut[];
  /** Decide form (M2): computed inside the transaction at ctx.ts; deterministic in ctx and the call;
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
  lane?: 'primary' | 'second';             // second lane only for partitions not in the first lane's batch (§3.2)
}

export type AppendResult =
  | { r: 'Committed'; seqFrom: Seq; seqTo: Seq; ts: HlcTs; streamSeqs: Record<string, [StreamSeq, StreamSeq]> }
  | { r: 'ConditionFailed'; which: string }        // nothing of this call committed; others in the batch may have
  | { r: 'Retry' }                                 // not committed, after batch_retries restarts and one fresh attempt (R47-12)
  | { r: 'StaleEpoch' }                            // this slot is lost to this process
  | { r: 'Moved'; slot: SlotNo; generation: Generation }  // the partition is adopted elsewhere
  | { r: 'Moving' }                                // partition between `moved` and `adopt`; retry after a short wait
  | { r: 'Stopped'; detectionRef: Uint8Array }     // integrity stop open; answer "temporarily unavailable"
  | { r: 'Ambiguous' }                             // commit sent, answer lost or backstop expired; resolved before the slot decides again
  | { r: 'Overloaded'; retryAfterMs: Millis };     // admission control or event-loop shedding only (R47-12)

export interface OwnerRuntime {
  append(call: AppendCall, opts?: AppendOptions): Promise<AppendResult>;
  /** false when untilMonotonic − now < max_loop_delay (200 ms) (R47-23). Call immediately before any reply or command from memory. */
  leaseValid(slot: SlotNo): { valid: boolean; untilMonotonic: MonotonicNs };
  epoch(slot: SlotNo): Epoch;
  generation(partition: PartitionKey): Generation;
  /** Receiver side of every command. The high-water mark per sending partition is the highest senderFence recorded in an
   *  applied entry, rebuilt by the runtime on onAcquire and onAdopt (R47-24). */
  admitCommand(sender: { kind: OwnerKind; partition: PartitionKey }, fence: WriterFence):
    { admit: true } | { admit: false; recorded: WriterFence };
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
  timer(partition: PartitionKey, key: string, atTs: HlcTs): void;   // an existing key is replaced
  cancelTimer(partition: PartitionKey, key: string): void;
  // routing and placement
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
  /** Point reads only, each its own single-statement read at with_min_timestamp(ceil_µs(max(pGrant, adoptTs(partition))))
   *  (R47-17); throws NotClosed ⇒ answer by rule 4. */
  leasedRead(partition: PartitionKey, points: RowRef[]): Promise<Array<unknown | undefined>>;
  isMovedOut(partition: PartitionKey): boolean;      // reader applied `moved` ⇒ answer by rule 4
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
  | { code: 'MOVED'; slot: SlotNo; generation: Generation }   // only once the target has adopted
  | { code: 'MOVING'; retryAfterMs: Millis }           // ~100 ms (est.)
  | { code: 'STOPPED' }                                // integrity stop: temporarily unavailable
  | { code: 'STALE_SENDER'; recorded: WriterFence }    // admitCommand refused; carries the recorded fence (R47-09)
  | { code: 'OVERLOADED'; retryAfterMs: Millis }
  | { code: 'UNAVAILABLE' };
```

### 2.5 Kafka wire format

- **Topic names** `<owner kind>.<feed>.v<n>`; closure topics `<owner kind>.<feed>.v<n>.closure`
  (R47-06); relay topics `cdc.<kind>`; audit topics `cdc.audit.<kind>`; relay progress
  `relay.progress.<kind>` (compacted); alerts `<kind>.alert.v1` (M9); placement
  `placement.slot_map.v1`, `placement.routing.v1`.
- **Key**: the producing partition; the request outcome feed only: the account slot.
- **Partition count** (R47-30): a power of two ≥ producer slot count / 4. It may be
  increased (never decreased), for example when the account slot count doubles (account
  topics from about 4,096 to about 8,192 partitions, est.). An increase re-maps keys; it is
  safe **only** because consumers order by `stream_seq` with buffering and the `reported`
  gate buffers by slot (§3.5), never by Kafka offset; closure markers name the partition
  count they were computed for, and a consumer re-subscribes its destination partitions
  when it changes. Partitions per broker after one doubling are sized in RFC-006 §19
  (erratum, §10.3).
- **Headers** (clear; nothing else in clear):

```ts
export interface FeedHeaders {
  partition: Uint8Array;
  stream?: string; stream_seq?: string;        // feed events (decimal int64)
  notification_id?: string;                    // point-to-point: "<subject b64>:<attempt>:<kind>"
  generation: string; epoch: string; ts: HlcTs;
  kind: string; schema_v: string; key_id: string;
  slot?: string;                               // request outcome feed: the account slot, on every event and marker (R47-22)
  report_through?: HlcTs;                      // report marker only
}
export interface FeedEvent { headers: FeedHeaders; value: Uint8Array /* sealed under the topic's feed key */ }

/** Report marker, request outcome feed (RFC-002), keyed by slot (M6). Produced with the outcome events.
 *  pendingAnswered and prevReportPosition: binding addition from C04 v2 (review 43 B-01). */
export interface ReportMarker {
  slot: SlotNo; generation: 0; epoch: Epoch;
  reportPosition: HlcTs;
  /** The report position of the previous marker of this slot (same or earlier writer). For the first marker after an
   *  acquisition: the new holder's initial report position (§3.1). */
  prevReportPosition: HlcTs;
  /** Request ids answered `pending` whose outcomes this marker is the first to cover, i.e. outcome ts in
   *  (prevReportPosition, reportPosition]. Empty list if none. Pseudonymous ids only (A11). */
  pendingAnswered: Uint8Array[];
}

/** Closure topic messages (R47-06), produced only by the closure emitter of the kind. */
export interface ResolvedMarker {
  dataTopic: string; partitionCount: number; destinationPartition: number;
  resolved: HlcTs;                 // "no row with ts ≤ resolved follows on this destination partition"
  dataHighWater: bigint;           // end offset of that data partition when the marker was computed
  emitterEpoch: Epoch;
}
export interface ClosedMarker {    // link schedule feed
  link: Uint8Array; t: HlcTs; feedSeq: StreamSeq;
  partitionCount: number; destinationPartition: number; dataHighWater: bigint; emitterEpoch: Epoch;
}
/** relay.progress.<kind>, compacted, key = cdc partition k. */
export interface RelayProgress { cdcPartition: number; resolved: HlcTs; linksRelayed?: Uint8Array[] }
```

**Per-topic producer ACL** (settled M8, refined by R47-06 and R47-25). Every topic's ACL
names exactly the producing principals below and nothing else. Kafka enforces WRITE per topic;
no rule here depends on a consumer learning a record's principal.

| Topic | Producing principals |
|---|---|
| `<kind>.<feed>.v<n>` (every owner feed, notifications and report markers included) | `<kind>-holder` (direct publish after `Committed`, and the takeover republish by a new holder), `<kind>-relay` (guaranteed path) |
| `<kind>.<feed>.v<n>.closure` | `closure-emitter-<kind>` only |
| `<kind>.alert.v1` | `<kind>-holder`, `<kind>-relay` (self-outboxed `ingest` alerts: `ingest-relay`) |
| `cdc.<kind>`, `cdc.audit.<kind>` | The database's CDC principal only |
| `relay.progress.<kind>` | `<kind>-relay` only |
| `placement.slot_map.v1`, `placement.routing.v1` | `placement-holder`, `placement-relay` |

The relay of a **self-outboxed** kind (RFC-003 `ingest`) holds that kind's **log key** (to
run the emit function on the row) and the feed keys of its streams: a trust increase over an
ordinary relay, which only forwards ciphertext, stated here and in RFC-005's key-release
policy (R47-19).

### 2.6 Integrity stop (gRPC, audit → placement)

```proto
service IntegrityStop {
  rpc Stop(StopRequest) returns (StopAck);      // audit only (mTLS workload identity)
  rpc Resume(ResumeRequest) returns (StopAck);  // audit only
}
message StopRequest   { string kind = 1; bytes partition = 2; bytes detection_ref = 3; }
message ResumeRequest { string kind = 1; bytes partition = 2; bytes detection_ref = 3; bytes checkpoint = 4; bytes incident_decision_ref = 5; }
message StopAck {
  enum State { STOPPED = 0; RESUMED = 1; }
  State state = 1;
  string enforced_at = 2;                       // HlcTs of the transaction that wrote the stop and bumped stops_version
  repeated int32 fenced_slots = 3;              // the slot(s) whose stops_version was incremented (both during a move)
}
// Errors: CONFLICT (same detection_ref, other kind/partition), NOT_STOPPED (resume without an open stop),
//         HEAD_MISMATCH (restored head ≠ audit's first-seen head and no incident_decision_ref), PERMISSION_DENIED.
```

### 2.7 Placement: account slot map, splitting handshake and probe set

```ts
export type SplitState = 'unsplit' | 'splitting' | 'split';
export interface SlotMapVersion {
  version: MapVersion; slotCount: number;               // power of two n (2n after a doubling is published)
  previousCount?: number;                               // n while a doubling is in progress
  splitState: Record<SlotNo, SplitState>;               // old slots s < previousCount during a doubling
  overrides: Array<{ account: Uint8Array; slot: SlotNo; reason: 'probe_pin' | 'probe_new' | 'reslot' | 'dedicated' }>;
  probeAccounts: Array<{ slot: SlotNo; account: Uint8Array }>; // R47-21: probe accounts designated in this version (delta)
  publishedAt: HlcTs;
}
/** R47-29: placement cannot read heads; in a splitting slot it answers s and the router follows MOVED. */
export interface SlotOfAnswer { slot: SlotNo; mapVersion: MapVersion; headDecides: boolean }

export interface PlacementApi {                         // gRPC; slotOf is served from the feed cache, query on miss
  slotOf(account: Uint8Array): SlotOfAnswer;
  reslot(req: { accounts: Uint8Array[]; toSlot: SlotNo; reason: string; requestId: Uint8Array; envelope: OperatorEnvelope }):
    Promise<{ accepted: true; versionWhenDone?: MapVersion } | { accepted: false; refusal: 'PROBE_LEFT_WITHOUT' | 'SECOND_PROBE' | 'TARGET_WITHOUT_PROBE' | 'NOT_DOUBLING' | 'CONFLICT' }>;
  doubleSlotCount(req: { kind: 'account'; requestId: Uint8Array; envelope: OperatorEnvelope }): Promise<{ targetCount: number }>;
  probeAccountSet(v: MapVersion): Promise<Array<{ slot: SlotNo; account: Uint8Array }>>;
  probeSetSummary(v: MapVersion): Promise<ProbeSetSummary>;
  slotGroup(kind: OwnerKind, slot: SlotNo): Array<{ kind: OwnerKind; slot: SlotNo }>;
  /** R47-05, holder → placement. Sent only after the holder applied version v (s splitting) and once no batch of the
   *  slot started before applying it is in flight or unresolved. Carries the slot's upper-half partitions as of then. */
  ackSplitting(req: { kind: 'account'; slot: SlotNo; mapVersion: MapVersion; epoch: Epoch;
                      upperHalf: Uint8Array[]; asOf: HlcTs }): Promise<{ recorded: true }>;
}
/** R47-05, placement → holder (gRPC served by the slot's holder; answered from memory at an acknowledged position). */
export interface HolderPlacementApi {
  listPartitions(req: { kind: 'account'; slot: SlotNo; mapVersion: MapVersion; home: { mod: number; eq: number } }):
    Promise<{ partitions: Uint8Array[]; asOf: HlcTs; epoch: Epoch } | { refused: 'NOT_ACKED' | 'NOT_OWNER' }>;
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
  /** By partition, across every slot the partition has lived in (R47-01). */
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

/** Account owner's F9 (RFC-004 Part A), applied from SlotMapVersion.probeAccounts, recording its version. */
export interface F9ProbeDesignation { account: Uint8Array; excluded: true; slot: SlotNo; designatingMapVersion: MapVersion }
```

### 2.10 Operational alert (stream `alert`, topic `<kind>.alert.v1`)

```ts
export interface OperationalAlert {
  /** R47-08: (raising partition, alert kind, subject, episode); the episode is the raising entry's (partition, seq),
   *  so a later raise of the same kind and subject is a new episode, never a duplicate. */
  alertId: { partition: Uint8Array; alertKind: string; subject: Uint8Array; episode: { partition: Uint8Array; seq: Seq } };
  op: 'raised' | 'cleared';          // 'cleared' by the raiser only (M9), naming the episode it clears
  alertKind: string;                 // e.g. 'UNDECIDED_PAST_DEADLINE', 'CUT_TARGET_UNMET', 'MOVE_CUTOVER', 'CLOSURE_LAG',
                                     //      'PROBING_FAULT', 'FEED_CONTENT_CONFLICT', 'STALE_SENDER_UNMOVED'
  severity: 'info' | 'warning' | 'page';
  entities: Array<{ type: string; id: Uint8Array }>;   // pseudonymous identifiers only (A11)
  reasonCode: string;
  detail?: Record<string, string | number>;            // no personal data, no free text from users
  raisedAt: HlcTs;                   // the raising entry's ts
}

/** D1: one episode per (region, minute), raised by the probe-results owner. */
export interface ProbingFaultDetail {
  region: 'R1' | 'R2'; minute: string;                  // UTC minute, ISO 8601
  shortSlots: Array<{ slot: SlotNo; probes: number; locations: number }>;
  escalation?: 'sameSlot5Minutes' | 'over1PercentOfSlots';  // present ⇒ severity 'page', else 'warning'
}
```

## 3. Semantics

### 3.1 Sessions, slot leases, acquisitions, resume and re-home

- A slot's owner lease is valid while `owner_slot.session_id` names a session that is not
  revoked and whose `expires_at` is in the future by the database clock. Sessions renew
  every 500 ms to `now() + 3 s`, conditional only on `NOT revoked`.
- **Holder's view**: the lease ends at `t_send + session_ttl − ε` (2,900 ms after the send
  of the last renewal that succeeded inside the view) by the holder's monotonic clock. From
  then the holder proposes nothing, decides nothing from memory, grants or renews no read
  lease, reports nothing and sends no command. `leaseValid` answers false from
  `max_loop_delay` (200 ms) before the view's end, so a pause after the check cannot carry a
  reply or command past it (R47-23); owners call it immediately before any action taken from
  memory.
- **Acquisition** (expiry): one high-priority transaction revokes the expired session and
  increments the epoch of every slot taken (a slot group in one transaction). The new holder
  catches up by a high-priority present-time read, reads the integrity stops of its slots
  from `placement_integrity_stops` (no placement call), then `onAcquire(slot, epoch, 'expiry')`.
- **Handoff**: the holder stops proposing and granting read leases, waits for its in-flight
  batch, and in one transaction names the successor and increments the epoch; the successor
  catches up, reads the stops, `onAcquire(…, 'handoff')`.
- **Resolution steps** (numbered as RFC-006 §4.2; used by resume, re-home and `Ambiguous`):
  1. a **high-priority** read-only transaction at the present timestamp, retried until it
     answers, of the process's `owner_session` row, the `owner_slot` rows of its slots, and
     the head rows of every partition of every batch still unanswered; its
     `cluster_logical_timestamp()` is `T_res`;
  2. each unanswered batch is classified from those head rows by `batch_id`: committed if
     any carries it, otherwise not committed and re-evaluated (pushing a fixed-`ts` batch
     aborts it, consistent with "not committed"; a `STAGING` one is recovered by the read);
  3. slots whose epoch is no longer the process's are released (`onRelease('taken')`); if the
     session is `revoked`, the process re-homes the rest (below) instead of continuing;
  4. each kept slot's report position is set to `T_res`.
- **Resume**: a renewal whose success arrives after the holder's view ended. No
  `onAcquire`; memory kept. Steps 1–4, then `onReportable` without a further wait.
- **Re-home** (session revoked or replaced): conditional transfer of each slot still at its
  own epoch to a new session, then steps 1–4 (step 1's read of the re-homed `owner_slot` rows
  puts `T_res` above the re-home), `onAcquire(…, 'rehome')` with memory valid (re-arming
  idempotent), the takeover entry, and the `read_lease` + ε reporting wait.
- **Takeover-entry rule**: the owner's first entry in each partition it touches in a new
  epoch (or after `adopt`) is its takeover entry (RFC-001 `Takeover`, RFC-002 E9); timers are
  re-armed from state; work in flight is re-sent with the same identities (RFC-002 §12.1).
- **Initial report position after any acquisition** (expiry, handoff, re-home, resume;
  AI-33-2): the timestamp of the new holder's present-time catch-up read (expiry, handoff) or
  `T_res` (resume, re-home). No read lease is granted with `P_grant` below it. After an
  acquisition commit (not a resume) the holder writes no marker and reports nothing until
  `read_lease` + ε (500 ms) after it learned of the commit; then `onReportable`.
- **Rebuilding a partition** (takeover, `Ambiguous` reload, `adopt`): from its head row
  (by home), its projections (by partition) and its log since the last projection
  checkpoint **by `(partition, seq)`**, whatever slots wrote those rows (R47-01).

### 3.2 `append` and its results

Preconditions: the caller holds the slot (`leaseValid`); every identity is deterministic;
`projections` delete only declared-deletable tables. **"Partitions the slot serves"**
(R47-01): partitions whose head row names this slot **and** has `adopted = true`. Conditions,
`reads` and `ctx.read` reach any row of a served partition by its partition-led key,
including rows written before the partition moved here. `displacementRead` (account kind only)
reads `link_displacement` by `(link, request)`, wherever the link's slot is.

The runtime runs **one batch transaction in flight per slot lane**, carrying every pending
call of every served partition of the slot (at most 2,000 entries or 4 MB). In order:
`BEGIN` (serialisable); savepoint; `owner_slot` read (epoch must equal the holder's;
`stops_version` compared with the holder's, and on a change the stops are re-read from
`placement_integrity_stops` before any call is evaluated); head rows of each partition; per
call: a stopped partition ⇒ `Stopped`; head not naming this slot ⇒ `Moved` or `Moving` (below);
head naming this slot but `adopted = false` ⇒ `Moving`, except the `adopt` call itself;
condition and `reads` rows (the displacement read under its own savepoint with
`lockTimeoutMs`; a timeout fails only that call's condition as `'lockTimeout'`); `ts` =
`cluster_logical_timestamp()`; each `decide` at `ctx.ts`; seal (C13), chain; inserts and
upserts — **every call that commits upserts its partition's head row with the batch's
`batch_id`**, so every committed call is classifiable (R47-14); `COMMIT` (exempt from the 2 s
statement timeout; 15 s backstop). A call that is `exclusive` goes alone; `firstStatement` is
executed as the transaction's first statement together with the `ts` read. `ts` is shared by
every entry of the batch and is strictly increasing per partition. A creation (a partition
with no head row) carries an implicit `rowAbsent(head)` (R47-05).

**Old slot after `moved`** (R47-02): in slot A, a call for X whose head names B answers
`Moving` while `adopted = false`, and `Moved(B, g+1)` once `adopted = true`.

**Lanes** (R47-31): the second lane carries only partitions **not** in the first lane's
batch (account slots; deadline entries). RFC-006 §4.3's lane (c), a second batch of the same
partition on a dedicated slot, is **excluded from v1** of this contract (a new version will
define it with its `Ambiguous` rule).

| Result | Meaning | Required caller action |
|---|---|---|
| `Committed` | Durable on a majority spanning two regions; the **only** success | Apply to memory; acknowledge; the runtime publishes events and notifications |
| `ConditionFailed(which)` | This call wrote nothing; the rest of the batch may have committed | Owner-specific (e.g. "already decided"; for `'lockTimeout'` RFC-002 defers the confirm to the next batch) |
| `Retry` | Not committed, after `batch_retries` (5) restarts keeping intents and one fresh attempt | Retry later with the **same identities**; map to the owner's POL-04 answer if a caller waits |
| `StaleEpoch` | The slot was taken | Stop serving that slot (`onRelease`); fail its in-flight calls "not known to be committed"; other slots continue |
| `Moved(slot, generation)` | The partition is adopted elsewhere | Re-route to the named slot with the same identity |
| `Moving` | Between `moved` and `adopt` (about 100 ms, est.) | Retry after a short wait (≥ 20 ms, backoff) with the same identity; never a failure to the buyer by itself |
| `Stopped` | Integrity stop open on the partition | Decide nothing; answer the caller "temporarily unavailable"; retry only after the stop is lifted |
| `Ambiguous` | `COMMIT` sent, answer lost, or the 15 s commit backstop expired (settled M1) | **Never aborted blind**: before anything further is decided in **that slot**, the runtime runs resolution steps 1–3 (§3.1); no batch of the slot starts and the owner decides nothing for the slot from memory until they complete; then every partition of the batch is reloaded and callers are answered `Committed` or re-run; a revoked session leads to re-home, a moved epoch to `StaleEpoch` |
| `Overloaded(retryAfter)` | Admission control or event-loop shedding only | Back-pressure; owner maps to its POL-04 answer |

Every result except `Committed` and `ConditionFailed` means "not known to be committed":
the owner's memory for every partition of the batch is rebuilt (§3.1) before its next
decision. A consumer receiving an **unknown future result** treats it as `Retry` and alerts
(§8).

**Integrity stops** (R47-04, D2). Placement's `Stop` is one transaction: it inserts the stop
row and increments `owner_slot.stops_version` of the slot holding the partition, and **of
both slots** while a `partition_moves` row for it is not `done`. Every batch reads
`owner_slot` (the fence read), so a batch of that slot in flight when `Stop` commits fails its
read refresh and restarts; the restart sees the new `stops_version`, re-reads the stops and
answers the stopped partition's calls `Stopped`. `StopAck` is returned only after that
transaction commits: from then, no entry of the partition can commit under any holder, across
takeovers (holders read the table on acquisition, without placement) and across moves (both
slots fenced; B re-reads stops in its `adopt` batch). `Resume` likewise, after audit's checks.

### 3.3 Moves, `Moving`, `onMovedOut` and `onAdopt`

A partition X moves from slot A to slot B (hot link to a dedicated slot, re-slotted account,
upper-half account in a doubling split, hot exporter to its own slot):

| Step | Who | What | X is served by |
|---|---|---|---|
| 1 | Placement | `partition_moves` row (X, A → B, generation g+1), `prewarm` | A |
| 2 | B's holder and standbys | Load X (checkpoint or replay by `(partition, seq)`), then tail A's pushes until within one batch | A |
| 3 | A's holder | Appends `moved(to B, g+1)` and sets X's head row `slot = B, generation = g+1, adopted = false` in one batch; calls **`onMovedOut(X)`**; from that commit A answers every command for X `MOVING` | nobody (`Moving`) |
| 4 | A's holder | Report fence: a marker is **due** for `moved` (§3.4), so A advances its report position past `ts(moved)` and writes the marker (`report_through ≥ ts(moved)`); pushes it to B's holder | nobody |
| 5 | B's holder | After seeing `report_through ≥ ts(moved)` (push, or a bounded-staleness read of A's partition `''` head row after 100 ms), appends `adopt(g+1)` conditional on `head(X).slot = B ∧ generation = g+1 ∧ adopted = false`, sets `adopted = true`, records the fence evidence, re-reads X's stops; continues `seq`, `chain` and every `stream_seq`; calls **`onAdopt(X, g+1)`** | B |
| 6 | B's holder | Reports nothing for X until `read_lease` + ε after `adopt`: B's report position does not pass the `ts` of any entry of X committed in that window until it ends (R47-16) | B |
| 7 | Placement | Marks the move done; publishes routing (for accounts, a new map version) | B |

Before step 5, **no entry of X commits in B** (the runtime answers `Moving` to every call of
X but `adopt`); after it, A answers `MOVED(B, g+1)`. Kinds without status readers skip step 4's
fence wait. `Moving` beyond `move_cutover_max` (1 s) pages. If A's holder fails after `moved`,
its successor writes the `moved` marker as soon as its post-acquisition wait ends (§3.4), so B
adopts within `read_lease` + ε + one commit after the successor acquires (R47-03). If B's
holder fails, B's standby (pre-warmed) adopts. **Rows**: nothing is re-keyed; X's earlier
log, outbox and projection rows stay where they were written and are reached by partition
(§2.3, §3.2). **`onMovedOut` obligations**: cancel every timer of X, decide nothing for X,
send no command for X, keep reporting entries already committed. **`onAdopt` obligations**:
re-arm X's timers from its state, write the takeover entry in X's first batch, re-send what
the takeover-entry rule re-sends for X (releases, conversions, leg changes, offers…), and
report nothing for X until step 6 ends. Readers of A that applied `moved` answer X by rule 4;
readers of B answer X by rule 2 only from state that includes `adopt`.

**Trace: P1-S78 across a hot-link move** (R47-01). A reduction on link L, in shared slot A,
commits in its own exclusive batch and writes `link_displacement(L, r)` (keyed by link and
request, no slot) for the displaced hold of request r. L then moves to dedicated slot B:
`moved` (no decision possible in between: `Moving`), report fence, `adopt` in B; the marker
row is untouched. The account owner's confirm of r runs `displacementRead(link = L, request =
r)` in its serialisable transaction: the key is the same before and after the move, so it
finds the marker and does not write E5 (POL-07: the confirmation had not begun committing).
Had the confirm read before the reduction committed, serialisable order makes the reduction's
transaction (in A, or in B after `adopt`) meet the read and the confirm is first, and the
link flags the reservation affected (P1-S63). B's state (pre-warmed by replay by `(partition,
seq)`) holds the displaced hold, and a later takeover of B rebuilds it the same way, so B's
`convert` or release deletes the marker as A's would have. Likewise for an account moved
`s → s+n`: a decision row written in `s` before the move is keyed `(home_key, account, …)`,
so `rowAbsent` in `s+n` or its successor still fails ("confirm if undecided" cannot pass
twice, A7).

### 3.4 Report position, read leases and status readers (kinds with `statusReaders`)

Report position P of a slot: every entry with `ts ≤ P` is committed and applied by every
reader holding a live read lease (or that lease has expired). Owners report outcomes only at
or below P. A read lease lasts 400 ms from the reader's send time, treated as expired ε
(100 ms) earlier, is granted only if the reader has applied through P, it ends inside the
holder's view, the holder is not handing off, and the post-acquisition wait is over.
`P_grant` is fixed at the start of a continuous lease. **Report markers are due** when P
passes a `reportWanted` entry, an entry that emitted an outcome event, **or a `moved` entry**
(R47-03) — including for a successor whose initial position is at or above `ts(moved)`, which
writes that marker as soon as its post-acquisition wait ends. A marker rides the slot's next
batch or a marker-only transaction (at most 20 ms later, outside the lane, serialised on
partition `''`) and is never written by a stale epoch. Status readers read older state only
by `leasedRead` point reads (R47-17).

**Marker chain** (C04 v2, review 43 B-01). The rules for `prevReportPosition` and
`pendingAnswered` are:
1. Each marker of a slot names the report position of the marker before it in
   `prevReportPosition`. Thus the markers of a slot make a chain. Each marker covers the
   interval (`prevReportPosition`, `reportPosition`].
2. The holder writes `reportPosition` > `prevReportPosition`. It does not write two markers
   with the same `prevReportPosition` in one epoch.
3. After an acquisition, the first marker of the new holder starts its chain at the initial
   report position (§3.1). Its `prevReportPosition` is that position. The interval below it
   was covered by the previous holder or is covered by rule 3 reads.
4. `pendingAnswered` lists each request that the slot answered `pending` and whose outcome
   entry has `ts` in the interval of the marker. Each such request is in exactly one marker of
   the chain: the first marker that covers its outcome.
5. The relay path can deliver markers out of order. A consumer must not use arrival order.
   The consumer finds the first covering marker of an outcome from the interval
   (`prevReportPosition`, `reportPosition`], not from which marker arrived first. A copy of a
   marker (same slot, epoch and `reportPosition`) is a duplicate and the consumer drops it.
6. The `reported` gate (§3.5) is not changed. It uses `reportPosition` and `epoch` only.

The producing principals of the outcome topic do not change (§2.5).

### 3.5 Outbox, publication and consumption

Events and notifications are written only through `append` and published only after
`Committed`, by two paths: direct publish by the holder (`acks=all`, idempotent producer) and
the changefeed relay; a takeover republishes the slot's rows above the kind's closure
position (bounded to 30 s before the acquisition, at most 5,000 rows/s per process).
`subscribe` delivers feed events in `stream_seq` order per (producer partition, stream),
buffering later ones, dropping lower ones, and filling a gap after `gap_timeout` (5 s) from
the producer's outbox through its `gapfill_<consumer>_<producer>` role (by partition, across
moves) or, below 25 h, from history. Gate `reported` holds an outcome until a marker of the
same slot (`slot` header) with epoch ≥ the event's and position ≥ its `ts`. Owner consumers
checkpoint (partition, stream, `stream_seq`) **and the applied event's ciphertext digest** in
their own `append`. Notifications are delivered by `onNotification`, deduplicated by identity,
in no order, with no high-water rule.

**Content conflict** (R47-07, decision D3). Copies of one event (direct, relay, republish)
are the same outbox row and therefore byte-identical. A copy of an already seen (partition,
stream, `stream_seq`) whose bytes differ is a **conflict**: the consumer runtime reads the
committed row from the database (gap-fill role) — **the database copy wins** — raises
`FEED_CONTENT_CONFLICT` (security and platform on-call, naming the topic and both producing
paths), and **blocks the stream at that `stream_seq`** until the read answers. If both copies
are buffered, it applies only the database copy. If the conflicting copy arrives after a copy
was applied, the consumer compares the database copy with the recorded digest: if the applied
copy was the database's, it continues; otherwise the stream stays blocked and the owner's
correction path (its RFC) applies under incident handling, never a silent overwrite.

### 3.6 Closure

The closure emitter (one platform slot per relayed kind) computes `R_min`, the minimum over
**every** partition of `cdc.<kind>` **as listed in the topic's metadata** of the relay's
acknowledged progress; a partition with no progress record (added by recreation or growth)
**holds `R_min` back** (R47-20). For each stream declared with closure it publishes, on that
stream's **closure topic** (R47-06), per destination partition: `ResolvedMarker` or, on the
link schedule feed, `ClosedMarker(link, t, feedSeq)` (`feedSeq` read from `link_head.streams`
as of `t`), for links whose `feed_seq` changed, as a 10 s heartbeat for every link, and for
every link once by a new emitter holder. Each marker carries `dataHighWater`, the data
partition's end offset read after `R_min` was established (every row with `ts ≤ R_min` was
acknowledged before, so it lies below that offset). The consumer runtime fires `onResolved`
(or `onClosed`) only once its position on the data partition has passed `dataHighWater` and
every buffered event with `ts ≤ R` of that destination partition has been delivered. Markers
never go back; consumers ignore one at or below their last. Owners emit no closure markers of
their own, and only the emitter can write a closure topic (ACL), so no holder or relay can
forge closure and the emitter cannot inject data. Streams carrying closure (M7): reservation
lifecycle (RFC-002), link schedule (RFC-001, `closedPerLink`), catalogue (RFC-003), metering
hand-off (RFC-003, self-outboxed), identity status push (RFC-005), ledger movement (RFC-004).

### 3.7 Timers

`timer(partition, key, atTs)` is holder-local; an existing key is replaced; its deadline must
be recorded in an entry. Firing only makes the owner append an entry (A8). Timers are
re-armed from state on `onAcquire` (the slot's partitions) and `onAdopt` (that partition),
and cancelled by `onMovedOut`.

### 3.8 Routing and the account slot map

`route(kind, partition)` answers from the placement cache, refreshed by the placement feed
and by any `STALE_EPOCH`, `MOVED` or `MOVING` answer. Every command carries
`CommandEnvelope.routedTo`; the receiver answers a stale one with a `RoutingRefusal`, and
applies a command already applied (same identity) by answering its recorded result.

**`STALE_SENDER`** (R47-09, decision D4). The receiver records the sender's `(generation,
epoch)` in the applying entry and refuses a command below the recorded pair with
`STALE_SENDER(recorded)`. The sender:
- recorded generation **equal** to its own and epoch higher ⇒ it has been deposed: as
  `StaleEpoch` for that slot;
- recorded generation **higher** ⇒ the partition has moved and the new writer has superseded
  the command: the sender **drops the command and keeps the slot**; it raises
  `STALE_SENDER_UNMOVED` only if it has not applied `moved` for that partition;
- otherwise ⇒ a defect: alert, drop the command.

`slotOf(account)` (R47-29): an override row if any; else with `h = hash(account) mod 2²⁰`
and `s = h mod n`: unsplit → `{ slot: s, headDecides: false }`; **splitting** → lower half
(`h mod 2n = s`) `{ slot: s, headDecides: false }`, upper half (`h mod 2n = s + n`)
`{ slot: s, headDecides: true }`: the router sends to `s` and then follows the last `MOVED`
it got for that account (or retries on `MOVING`), cached until the slot is split; split →
`h mod 2n`. While `s` is splitting, both slots **defer to the head row** (R47-02): `s`
answers `MOVED(s+n)` for an account whose head names `s+n` **and is adopted**, and `MOVING`
while it is not; `s+n` serves an account whose head names it **and is adopted**, answers
`MOVING` for one whose head names it unadopted, and `MOVED(s)` otherwise.

**Splitting handshake** (R47-05). Placement publishes version v marking `s` splitting. `s`'s
holder applies v; from then it creates no upper-half account (a creation with no head row gets
`MOVED(s+n)`), and every creation in either slot appends with an implicit `rowAbsent(head)`,
so the two slots race safely on the same home-keyed row. Once no batch of `s` started before
applying v is in flight or unresolved, the holder calls `ackSplitting(v, upperHalf)`, listing
`s`'s upper-half accounts from memory as of that point; placement records it
(`placement_split_acks`) and moves exactly those accounts; a takeover of `s` meanwhile is
answered by placement re-asking with `listPartitions`, which the new holder answers only after
it has applied v and resolved its in-flight batches (`NOT_ACKED` before). A creation in
flight at the acknowledgement is therefore either committed before it (and listed) or refused
`MOVED(s+n)`. After the last move, a version marks `s` split.

Outside a splitting slot, an owner answers `MOVED` for an account its current map version
places elsewhere (and adopted there); a command with an older map version is re-routed by the
sender.

**Doubling only**, in this order (R47-21): (1) placement leases the new slots `s + n` (their
`owner_slot` rows and holders exist, serving only override partitions); (2) it pins every
existing probe account by an override and provisions one new Share-internal probe account per
new slot in identity (KYB passed); (3) it publishes an **override version** routing each new
probe account to its `s + n`, with `probeAccounts` naming them, count still `n`; (4) each new
slot's account owner applies F9 for its probe account, recording that version; (5) finance's
set-scoped credit-limit action over `probeAccountSet` is applied (F5 `applied` for every new
probe account); (6) placement publishes the version with `2n`, every old slot unsplit; (7) lazy
splits, 16 at a time, each `unsplit → splitting → split`. No ordinary account routes to `s + n`
before (6). Re-slotting is refused (with the reason) if it would move a probe account out of
its slot, put a second probe account in a slot, target a slot without one, or change the
count other than by doubling. Doubling applies to the **account kind only** in v1 (M12).

`probeAccountSet(v)` is the exact set of probe accounts of version v; `probeSetSummary(v)`
signs (version, slot count, probe-account count, set digest) with placement's key through
RFC-005's signing service; the four-eyes approval shows it and RFC-005 verifies it.

### 3.9 History query

History never writes an owner's state. It guarantees **completeness** (every committed entry
of a `7y` class in range is returned, for 7 years; `ops` for 400 days), by partition across
every slot the partition has lived in, and **immutability**; the **meaning** of `asKnownAt`
is the owner RFC's declared query (RFC-001 known-at by decision time vs recorded-at by `ts`;
RFC-002 entries with `ts ≤ T`; RFC-004 headroom inputs at a position). `T` above the closed
timestamp answers `NOT_CLOSED`. Results are served seamlessly from the live tail and the
archive; replays run the owner's decoder and apply logic of the recorded `schema_v` and logic
version, never a newer rule. Operator reads carry a read grant; history checks it with
`operator_check` and appends its audit record before answering (M13).

### 3.10 Probe designation and exclusion

1. Designation is set only at provisioning, with reason, audited, only on an entity with no
   history, and **never cleared**. **Accounts** (settled M11): placement's account slot map is
   the sole authority for which account is a slot's probe account; placement provisions the
   account in identity (which holds it as a Share-internal tenant with KYB passed) and names
   it in a map version's `probeAccounts`; the account owner applies it as F9 (`excluded`) and
   records the designating slot-map version. Identity holds the account and the catalogue may
   show the designation, but neither decides it. **Links, exporters and the probe supplier**:
   set by network operations in the catalogue.
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
components without a log raise through the alert service's own `append`. Each raise is a new
**episode** (§2.10); the alert service deduplicates by `(alertId, op)`, groups episodes of one
(kind, subject) for display, tracks raised → acknowledged → resolved, escalates unacknowledged
pages after 5 min and routes by `alertKind` (routing rules are data). A raiser may emit
`cleared` for its own episode (e.g. RFC-001's `CUT_TARGET_INEXACT` withdrawn). Every producer
and the alert service heartbeat every minute to an external dead-man's switch.

**Probing faults** (X2-S33, decision D1). The probe-results owner raises **one
`PROBING_FAULT` episode per (region, minute)** in which any account slot was probed short
(fewer than 3 probes, or from one location), listing every such slot, severity `warning`,
routed to **network operations**; it escalates to `page` when the same slot is short for 5
consecutive minutes or more than 1% of slots are short in the minute. Every slot-minute is
still recorded in the probe results. The shortfall alone does not make the minute
unavailable (X2-S33); the availability rule itself is RFC-006's (§17.3; erratum N1).

### 3.12 Column encryption binding (RFC-005 C13)

The runtime seals every application column of every row it writes (log payload under the
log key, `audit` under the audit-column key, outbox rows under the topic's feed key) before
the transaction, with associated data (owner kind, table, primary key, sequence or version,
epoch, row kind, key identifier); compresses before sealing; recomputes seals and chains on
every retry (new nonces). Consumers' runtimes open on read and reject (and raise a security
alert) any row that fails to open or whose version is lower than one already seen. Clear
columns are only those in §2.3 and each projection's declared `clearColumns`. A moved
partition's rows written in A are sealed under A's slot log keys and opened by B by `key_id`.
Checkpoints are sealed under the partition's log key.

## 4. Delivery and ordering

| Item | Delivery | Ordering scope | Partition key |
|---|---|---|---|
| `append` entries | Exactly-once effect (per identity, deduplicated by the owner in the applying transaction) | Total per partition by `seq` (across moves); `ts` strictly increasing per partition | — |
| Feed events | At least once (direct, relay, republish) | Per (producer partition, stream) by `stream_seq`; none across partitions | Producing partition (outcome feed: account slot) |
| Notifications | At least once (gRPC push, relay) | None | Receiving partition |
| Report markers | At least once, monotone | Per account slot | Account slot |
| Closure markers | At least once, monotone, on the closure topic | Per destination partition (per link for `CLOSED`), gated by `dataHighWater` | Destination partition |
| Relay progress | At least once, compacted | Per `cdc` partition | `cdc` partition |
| Slot map versions | At least once, in version order | Global | Single partition |
| Alerts | At least once; deduplicated by `(alertId, op)` | Per raising partition | Raising partition |
| Integrity stop | Synchronous; acknowledged once enforced at the slot fence | Per (kind, partition) | — |

## 5. Idempotency

| Operation | Key | Duplicate | Same key, different content |
|---|---|---|---|
| `append` entry | Entry `identity` (owner-defined, deterministic) | Owner returns the recorded result; no second effect | Owner contract decides (typically a recorded refusal); the runtime never merges |
| Feed event | (partition, stream, `stream_seq`) | Dropped | **The database copy wins** (D3, §3.5): read the committed row, block the stream at that `stream_seq` until read, `FEED_CONTENT_CONFLICT` alert |
| Notification | (subject, attempt, kind) | Dropped | Receiver keeps the first, alerts |
| Command | `CommandEnvelope.identity` | Answered with the recorded result | Owner contract's refusal |
| Report / closure marker | (slot or destination, position) | Ignored at or below the last | — (monotone) |
| `Stop` / `Resume` | `detection_ref` | Same `StopAck` | `CONFLICT` |
| `reslot`, `doubleSlotCount` | `requestId` | Same answer | `CONFLICT` |
| `ackSplitting` | (slot, `mapVersion`, epoch) | Recorded once | A later epoch's ack replaces an earlier one's list |
| `putCheckpoint` | (kind, partition, seq) | Same reference and digest | Error `DIGEST_MISMATCH`, alerted |
| Alert | (`alertId` with episode, `op`) | Deduplicated | Later `detail` replaces earlier for display; severity only rises |
| Slot map | `version` | Ignored | Impossible (insert-only); a consumer seeing it stops routing and alerts |

## 6. Ownership

| Data | Sole writer | May read |
|---|---|---|
| `<kind>_log`, `_head`, `_outbox`, `_stream_index`, projections | The kind's lease holder, through `append` | The kind; platform read roles of §2.3; other owners only where RFC-000 §8 names it (`link_displacement` to the account owner) |
| `owner_session` | Its process (renewal), acquirers (`revoked`) | Every owner process, standbys, status readers |
| `owner_slot` | Acquisition, handoff and re-home transactions; placement's `Stop`/`Resume` (only `stops_version`) | Same |
| `placement_integrity_stops` | Placement, on audit's command only | Placement; every owner role (named read, R47-04); the `restore` role's row-level security |
| Other placement tables, slot map, probe-account list, split acks | Placement | Everyone through the placement feed and gRPC, never by SQL |
| Relay progress, closure topics | Relay (progress), closure emitter (closure topics) | Closure emitter; feed consumers |
| History archive and indexes | History (from logs; never an owner's writer) | Callers of §2.8 |
| Probe designation | Accounts: placement (slot map), applied by the account owner as F9 with the designating map version; links, exporters, probe supplier: catalogue | Every consumer |
| Alert state | Alert service | Console, routing targets |
| Kafka topics | Exactly the producing principals of the per-topic ACL (§2.5) | Consumers named in each feed's contract |

## 7. Timeouts and deadlines

| Parameter | Value | Note |
|---|---|---|
| `ε` (`max_offset`) | 100 ms | Owner hosts leave at 50 ms offset; precondition in §1 |
| `session_ttl`, `session_renew` | 3,000 ms, 500 ms | Renewal retried every 100 ms on error |
| Holder's view | `t_send` + 2,900 ms | `leaseValid` false from `max_loop_delay` (200 ms) before its end |
| Per-tier gateway timeout (renewal, epoch read, session poll) | 400 ms | Breaker after 3 timeouts |
| `idle_in_transaction_session_timeout` | 1,000 ms | Aborts a paused holder's open batch |
| `statement_timeout` | 2,000 ms | Every statement except `COMMIT` |
| Abandon before `COMMIT` | 2,000 ms from `BEGIN` (owner may set lower, RFC-001 250 ms) | ROLLBACK, re-propose |
| `COMMIT` | Exempt from the 2 s timeout; 15,000 ms backstop ⇒ `Ambiguous`, resolved by a present-time read before the slot decides again (settled M1) | Never aborted blind |
| Resolution read | High priority, retried until it answers | §3.1 step 1 |
| `batch_retries` | 5 restarts + 1 fresh attempt, then `Retry` | `Overloaded` only for admission control and shedding |
| Displacement read lock timeout | 10 ms (RFC-002's figure) | Fails only that call (`lockTimeout`) |
| `read_lease`; post-acquisition reporting wait | 400 ms; 500 ms | Reader treats lease as expired ε early |
| `heartbeat_interval` (holder → readers) | 100 ms | |
| `marker_max_wait` | 20 ms | |
| `Moving` | About 100 ms (est.); page at `move_cutover_max` 1,000 ms | Fence wait before reading A's head by bounded read: 100 ms |
| `gap_timeout` | 5,000 ms | |
| `republish_window`, `republish_rate` | 30 s, 5,000 rows/s per process | |
| Closure heartbeat; closure-lag page | 10 s; 10 s (60 s during a drain) | |
| Outbox retention | 26 h row TTL, 25 h GC | Older replay from history |
| Takeover (expected) | 3.3–3.8 s from last renewal (est.), p99 ≤ 5 s | +1 s cross-region `standby_grace` |
| Alert escalation | 5 min unacknowledged page; `PROBING_FAULT` page after 5 consecutive short minutes of one slot or > 1% of slots short | D1 |
| History query timeout | 30 s statement | |

## 8. Versioning and compatibility

- This contract is versioned `C01 vN`; a frozen version is tagged `contract-C01-vN`.
- **Runtime API** (TypeScript package `@share/owner-runtime`): semantic versioning. Adding an
  optional field or option is minor; adding an `AppendResult` variant, a `RoutingRefusal`
  code, a required hook, a lane kind (for example RFC-006's lane (c)) or changing a result's
  meaning is **major** and needs a new contract version. Consumers switch exhaustively and
  treat an unknown result as `Retry` plus an alert; an unknown refusal code as `UNAVAILABLE`.
- **Entries**: `schema_v` per entry kind; decoders and apply logic of every version kept 7
  years; a new version never reinterprets an old entry.
- **Topics**: `.v<n>` in the name; a breaking event change is a new topic version, both
  published until every consumer has moved; header set may only grow; partition counts may
  only grow (§2.5).
- **Slot map**: `version` strictly increasing; consumers must accept split states,
  `headDecides` and `probeAccounts` from v1.
- **`platform_timing`**: `version` per row; owners read it in the transaction, never cache it
  across batches.
- **Tables**: columns may be added (nullable or with a default, as `adopted` and
  `stops_version`); keys and clear-column sets change only by a new contract version and a
  migration.

## 9. Scenarios relied on (requirements-v1.10)

X2-S03, X2-S04, X2-S05, X2-S06, X2-S09, X2-S10, X2-S11, X2-S12, X2-S13, X2-S14, X2-S15,
X2-S16, X2-S18, X2-S19, X2-S20, X2-S21, X2-S22, X2-S23, X2-S24, X2-S27, X2-S30, X2-S33 (alert
granularity per D1, §3.11); P1-S33, P1-S54, P1-S62, P1-S63, P1-S78 (traced across a move,
§3.3); P2-S10, P2-S22, P2-S23, P2-S53, P2-S104, P2-S106, P2-S107, P2-S111; P3-S36, P3-S39;
P4-S72, P4-S81; X1-S14, X1-S15, X1-S31, X1-S37.

## 10. Conformance tests

### 10.1 Provider (RFC-006) contract tests

| Id | Test |
|---|---|
| CP-1 | Two processes contend for a slot across pauses, renewals, revocations and ambiguous commits (fault injection): no partition ever has two committed writers; `seq` contiguous, `ts` strictly increasing per partition |
| CP-2 | Every `AppendResult` is produced by an injected cause and carries the documented effect (`ConditionFailed` commits the rest of the batch; `Retry` after exactly 5 restarts + 1 fresh attempt; `Overloaded` only from admission control or shedding) |
| CP-2a | `Ambiguous` (lost answer, and the 15 s backstop expiring): no batch of the slot starts and no decision from memory is allowed until the high-priority present-time resolution read has classified the batch by `batch_id`; injected both ways (committed, not committed), with an epoch change (⇒ `StaleEpoch`), and with the session revoked meanwhile (⇒ re-home, not continue); a committed call with projections only is classified by its head row |
| CP-2b | Producer ACL: each principal of §2.5 can produce only to its listed topics; a holder or relay principal cannot write a closure topic, and the emitter cannot write a data topic; a consumer fires `onResolved` only after passing `dataHighWater` |
| CP-2c | Platform read roles: each role of §2.3 can SELECT only its listed tables (gap-fill roles only rows of their consumer's topics) and has no write grant |
| CP-3 | `decide` is re-run on every restart with a new `ts`; nothing from an earlier attempt commits; `ctx.read` serves only declared `reads`, fetched before any write (M2, R47-11) |
| CP-4 | `exclusive` + `firstStatement`: placeholders are intents before any other write, and a concurrent displacement read meets them (M3) |
| CP-5 | Move protocol: `MOVING` in A between `moved` and `adopt`, `MOVED(B, g+1)` once adopted; **no entry of X commits in B before `adopt`**; `onMovedOut` after `moved` commit, `onAdopt` after `adopt` commit; `adopt` never before `report_through ≥ ts(moved)`; B's report position does not pass an entry of X before `read_lease` + ε after `adopt`; `seq`, `chain`, `stream_seq` continue; **after a move and a takeover of the new slot, a decision committed before the move still fails `rowAbsent`**, and a displacement marker written before the move is found; **A's holder killed after `moved`: B adopts within `read_lease` + ε + one commit after A's successor acquires** |
| CP-6 | Integrity stop: `StopAck` only after the fence transaction commits; **a batch in flight when `Stop` commits does not commit an entry of the stopped partition**; `Stopped` under the current holder, after a takeover **with placement down**, and across a move (stop landing between `moved` and step 7); resume refused on head mismatch without an incident decision; restore role cannot write an unstopped partition |
| CP-7 | Initial report position: after expiry, handoff, re-home and resume, no lease with `P_grant` below the catch-up/resolution read; a rule-3 answer during a lapse is never contradicted by a leased reader |
| CP-7a | Marker chain (C04 v2): for each slot, across takeovers, the markers make a chain with no gap and no overlap (each `prevReportPosition` equals the `reportPosition` of the marker before it, or the initial report position after an acquisition). Each request answered `pending` is in `pendingAnswered` of exactly one marker, the one whose interval holds its outcome `ts`. With markers delivered in random order and as duplicates, the consumer finds the same first covering marker for each request |
| CP-8 | Closure: markers never precede a row at or below them on the destination partition, under relay rebalances, emitter takeover, changefeed recreation and **a `cdc` partition added with no progress (holds `R_min` back)**; `R_min` never goes back; a partition-count increase is handled |
| CP-9 | Feeds: duplicates across direct, relay and republish paths dropped by (partition, stream, `stream_seq`); gaps filled within `gap_timeout` across a move; `reported` gate holds outcomes until a covering marker, using the `slot` header for gap-filled events; **a forged copy with the same `stream_seq` (before and after application) makes the database copy win, blocks the stream and raises `FEED_CONTENT_CONFLICT`** |
| CP-10 | Slot map: doubling in the §3.8 order (no ordinary account routed to `s+n` before the `2n` version; F9 before the limit; limit `applied` before publication); splitting answers `headDecides` with `slot: s`; `s` and `s+n` defer to adopted heads and answer `MOVING` for unadopted ones; **a creation in flight at `ackSplitting` is either listed or refused `MOVED(s+n)`**; refusals of §3.8; `probeSetSummary` verifies with RFC-005 |
| CP-11 | Grants: conformance job fails on UPDATE/DELETE on a log table by an application role, DELETE on an undeclared projection, a projection key beginning with `slot`, a session/slot UPDATE outside the role's kind, or a cross-owner SELECT not listed in §2.3 |
| CP-12 | History: completeness over live tail + archive boundary and across a partition's moves; `NOT_CLOSED` above the closed timestamp; operator reads without a grant refused |
| CP-13 | Encryption: a row copied to another key, sequence or epoch fails to open everywhere; no clear column outside the declared set (schema lint); a moved partition's old rows open in B by `key_id` |
| CP-14 | Alerts: two raises of one (kind, subject) are two episodes; `cleared` clears only its episode; `PROBING_FAULT` is one episode per (region, minute) and escalates per D1 |

### 10.2 Consumer contract tests (every owner kind)

| Id | Test |
|---|---|
| CC-1 | Exhaustive result handling: a stub runtime returns each `AppendResult` (and an unknown one); the owner takes exactly the action of §3.2, retries with the same identities, never acknowledges before `Committed` |
| CC-2 | `onMovedOut(X)`: afterwards no timer of X fires, no entry or command for X is produced; commands for X answered `MOVING` |
| CC-3 | `onAdopt(X, g)`: timers of X re-armed from state equal those a fresh `onAcquire` would arm; takeover entry written in X's first batch; pending re-sends issued with the original identities; **after a takeover of the new slot, a decision committed before the move still fails `rowAbsent`** |
| CC-4 | `Stopped`: the owner decides nothing for the partition, answers "temporarily unavailable" (or its contract's equivalent), and resumes after the stop is lifted |
| CC-5 | As a sender: `MOVING`, `MOVED`, `STALE_EPOCH`, `NOT_OWNER`, `STOPPED` from a receiver re-route or back off with the same identity; **`STALE_SENDER` with an equal generation and higher epoch ⇒ slot lost; with a higher generation ⇒ command dropped, slot kept** (D4); as a receiver, `admitCommand` refuses below the recorded fence after the receiver's own takeover and after `adopt` |
| CC-6 | Idempotent consumption: replaying any feed twice and out of order yields the same state; checkpoint (with event digest) recorded in the applying `append` |
| CC-7 | Leased decisions: every reply or command from memory is preceded by `leaseValid` (instrumented) |
| CC-8 | Declaration: entry kinds, retention classes, deletable projections, projection keys led by partition, streams, consumers and closure flags match the owner RFC |

### 10.3 Errata list (consumer obligations, decision C4-7; and provider and architecture errata)

This table is the **errata list** of C01. "In rev.?" (for RFC-000: rev. 4.4; RFC-006: rev. 6;
others: rev. 5) says whether the RFC already states it; every "No" item becomes an erratum on
that RFC once this contract is frozen.

| RFC (kinds) | Obligation or erratum | In rev.? |
|---|---|---|
| **RFC-001** (link, link registry) | `onAcquire`/`onRelease`, takeover entry, timers re-armed (§8) | Yes |
| | `onMovedOut(link)`: cancel the link's timers (expiry requests past `D`, `ReductionEffective`/`ReductionStep`, offer-lapse backstops, effective boundaries, due notices), stop deciding and sending for it | **No** |
| | `onAdopt(link, g)`: re-arm those timers from state, `Takeover` entry in the link's first batch, resume projections from their checkpoint rows, continue a frozen cut set | **No** (prose in §8 only for the hot-link move) |
| | Answer `MOVING` for a link between `moved` and `adopt`; treat `MOVING` from an account owner as retry | **No** |
| | `Stopped`: decide nothing, answer `UNAVAILABLE`; treat `STOPPED` from the account owner as back-off | **No** |
| | Use `MOVED(slot, generation)` (not `Moved(epoch)`) and the canonical refusal codes; `STALE_SENDER` per D4 (M4, R47-09) | **No** |
| | Capacity-lowering entries via `exclusive` + `firstStatement` + `abandonBeforeCommitMs: 250`; decisions at `ts` via `decide` with declared `reads` (M2, M3, R47-11) | Yes in substance; signature **No** |
| | Projection keys led by the link (`link_request`, `link_displacement (link, request)`, `link_reduction_cut`, `link_projection`), never by slot (R47-01) | Yes (§7.1 logical keys); physical rule **No** |
| | Deletable projections `link_displacement`, `link_reduction_cut` only; `link_request` row TTL | Yes |
| | Alerts on `link.alert.v1` (not the schedule feed), episodes, `cleared` for withdrawn alerts (M9, R47-08) | **No** |
| | Closure only from the emitter (`onClosed`, closure topic); no own `CLOSED` | Yes; topic **No** |
| | Checkpoint store, probe flag on links | Yes |
| **RFC-002** (account, partner adapter; status readers) | `Moving` handled by retry/re-route | Yes |
| | `Stopped` handled (account and adapter partitions): "temporarily unavailable", nothing decided | **No** |
| | Route by `slotOf(…).headDecides` (answer `slot: s`), follow the last `MOVED`, retry on `MOVING`; in a splitting slot defer to the **adopted** head row; creation of upper-half accounts only in `s+n` with implicit `rowAbsent(head)`; `ackSplitting` after applying the version and resolving in-flight batches; answer `listPartitions` | **No** |
| | `onMovedOut(account)`: cancel the account's timers (`D`, `offer_window`, `due(S)`, position gates), stop deciding | **No** (named hook) |
| | `onAdopt(account, g)`: recovery queries for the partition, E9, re-sends, identity catch-up if stale, per-partition reporting wait | Partly (§2.5 prose); hook **No** |
| | Initial report position after any acquisition (catch-up/resolution read; no `P_grant` below it), cited in the P2-S111 argument | **No** |
| | Status readers: `leasedRead` as point reads with `adoptTs`, `isMovedOut` ⇒ rule 4, `replicaRule3Check` (R47-17) | Partly (`leasedRead` over a function) |
| | On each outcome entry of a request that the slot answered `pending`, set `EntryInput.pendingAnswered` to the request id, so that the runtime can fill the marker's `pendingAnswered` (C04 v2, review 43 B-01) | **No** |
| | Report markers only by the runtime, with the `slot` header; feed dedup by (partition, stream, `stream_seq`) for the outcome feed (M5, M6, R47-22) | Partly |
| | `iam_fresh` advanced from the identity push's closure markers (`onResolved` on its closure topic), price-cache freshness from the catalogue's (M7, R47-10 b) | **No** ("resolved timestamps") |
| | `STALE_SENDER` row (§5.1 table): per D4, not "stops serving the slot" when the recorded generation is higher (R47-09) | **No** |
| | Displacement read as `displacementRead` condition keyed `(link, request)` with 10 ms lock timeout ⇒ defer (M3, R47-01) | Yes in substance |
| | Probe accounts' designation taken from placement's slot map (not the catalogue), applied as F9 recording the designating slot-map version (settled M11) | **No** (§13.2 says catalogue) |
| | `Ambiguous`: decide nothing in the slot until the runtime's present-time resolution completes (settled M1) | Partly ("reload"); the wait **No** |
| | Projection keys (`request`, `decision`, `idempotency`, `reservation`, `change_queue`, `funds_*`) led by the account, never by slot (R47-01) | Yes (logical keys); physical rule **No** |
| **RFC-003** (ingest, attr A, attr B, rating, catalogue) | Slot groups acquired together; `onAcquire` per slot before the group serves | Yes |
| | `Stopped` and `Moving` handled on every kind (callers retry; ingestion answers exporters "temporarily unavailable") | **No** |
| | `onMovedOut`/`onAdopt` for moved partitions (a hot exporter moved to its own slot) | **No** |
| | Closure only from `onResolved` on closure topics; catalogue and metering hand-off declared with closure (M7) | Yes; declaration and topic **No** |
| | Feed dedup by (partition, stream, `stream_seq`), not "(producer partition, epoch, sequence)", in the opening rule and the feed rule (M5, R47-10 a) | **No** |
| | `CommandEnvelope` with `(generation, epoch)` on commands it sends; `admitCommand` as a receiver; CC-5 (R47-10 c) | **No** (one mention of generation) |
| | `ingest_log` self-outboxed with three streams, emit functions and a declared `ingest_stream_index`; the `ingest` relay holds the log key (R47-19) | Yes; index and key **No** |
| | The catalogue may show an account's probe designation but does not decide it; rating's exclusion of probe accounts uses the slot-map-derived designation (settled M11) | **No** (§6.1 lists probe accounts as a catalogue entity) |
| **RFC-004** (funds module, ledger, settlement, payments, receivables, reconciliation, payouts) | `Stopped` on every kind: posting-port callers retry with the same movement identity; a payout run or cut job waits | **No** |
| | `Moving`, `onMovedOut`/`onAdopt` (timers: payout runs, cut jobs, invoice issue, `due(S)`) | **No** |
| | Set-scoped credit-limit action over `probeAccountSet(v)` with `probeSetSummary(v)` shown and verified | Yes |
| | Dedup by (partition, stream, `stream_seq`) on the ledger movement feed, the invoice-status feed, and in the crash-point and delivery rows that say "(partition, epoch, sequence)" (M5, R47-10 a) | **No** |
| | Ledger movement feed declared with closure; receivables' and invoice issue's "resolved timestamp" from `onResolved` on its closure topic (M7) | **No** |
| | `CommandEnvelope` with `(generation, epoch)` on posting-port commands, payout and cut jobs; `admitCommand` at the ledger and as receiver of the credit-limit command; CC-5 (R47-10 c) | **No** |
| | Cut job within the 4 h MVCC window (`gc.ttlseconds`) | Yes |
| | F9 applied from the slot map's `probeAccounts`, recording the designating slot-map version, before the set-scoped limit (settled M11, R47-21) | Yes for the source; version and order **No** |
| **RFC-005** (identity, edge, audit, console) | Edge forwards by `route`/`slotOf` with `headDecides`, follows `MOVED`/`MOVING`, keeps no mapping | Partly (§2.2 step 8); `headDecides` **No** |
| | Identity kind: `Stopped`, `Moving`, `onMovedOut`/`onAdopt` | **No** |
| | Audit is the only caller of `Stop`/`Resume`; resume rule (first-seen head or incident decision); a stop counts only once `StopAck` (enforced) returns (D2) | Partly; "durable with placement" **No** |
| | Restore role's row-level security reads **placement's** `placement_integrity_stops` (not audit's table) (R47-28) | **No** |
| | Verifies `probeSetSummary(v)` signature at the four-eyes approval | Yes |
| | C13 library meets §3.12's binding; key-release policy gives the `ingest` relay the `ingest` log key (R47-19) | Yes; relay key **No** |
| | Kafka ACL: replace "one producing workload identity (the relay)" by the per-topic producer list of §2.5, closure topics produced only by the emitter (settled M8, R47-06); T-20, T-25 threats updated; authenticity of a conflicting copy by the database row (D3) | **No** (§4.4) |
| | Identity status push declared `closure: 'resolved'`; "resolved timestamps to every topic partition every 1 s" become emitter markers on its closure topic; dedup by (partition, stream, `stream_seq`) in T-25 (M5, M7, R47-10) | **No** (C3, lines on resolved timestamps) |
| | History as a receiver of operator read grants (settled M13) | **No** (§4.4, §7.6) |
| | Identity holds probe accounts as tenants but does not decide designation; C9's flag follows the slot map (settled M11) | **No** (§3.5, C9) |
| **RFC-000** (architecture) | §8 substrate row, AI6-6 and **§5.2** ("`COMMIT` itself is not timed out") and the §5.5 crash point: "`COMMIT` never aborted blind (15 s backstop ends as `Ambiguous`, resolved by a present-time read before the slot decides again)" (settled M1, R47-27) | **No** |
| | A1: list the named platform read roles of §2.3 and the owners' read of `placement_integrity_stops` beside the link displacement read (settled M10, A-2) | **No** |
| | §5.2 move bullet: "the new slot serves the partition only from its `adopt` commit; the head row records whether `adopt` has committed, and both slots answer `Moving` until it has"; moves increment the **generation**, not an epoch as for a handoff (A-1, R47-27) | **No** |
| | §5.5 A6: dedup key "(partition, stream, stream sequence) for feed events; identity for notifications" (A-3, M5) | **No** |
| | §8 integrity-stop row: "acknowledged once enforced at the fence of the slot (both slots during a move) that holds the partition" (A-4, D2) | **No** |
| | §8 substrate row: closure markers authenticated by a closure topic only the emitter writes, with data high-water offsets (A-5, R47-06) | **No** |
| | §8 probe designation row and §5.4 ("check the probe designation from the catalogue and identity"): accounts designated by placement's slot map, links/exporters/supplier in the catalogue (settled M11, R47-27) | **No** |
| **RFC-006** (provider) | §12.2 `append`: `decide(ctx)` with declared `reads`, `AppendOptions`, `displacementRead` keyed `(link, request)` (M2, M3, R47-01, R47-11); canonical refusals with `STALE_SENDER(recorded)` (M4, R47-09) | **No** |
| | §3.7: projection keys never led by slot; `link_displacement` keyed `(link, request)` (not "link slot, link and request"); `(partition, seq)` log index, outbox stream index, self-outboxed stream index; head column `adopted` (R47-01, R47-02, R47-19, R47-27) | **No** |
| | §4.2/§4.3: resume steps numbered and reused for `Ambiguous` with a high-priority read including `owner_session`; every committed call upserts its head with `batch_id`; `Retry` (not `Overloaded`) after exhausted retries; lane (c) excluded from v1 (M1, R47-12, R47-14, R47-31) | **No** |
| | §4.5: `MOVING`/`MOVED` by `adopted`; nothing served in B before `adopt`; step 6 enforced on B's report position; §4.6: marker due on `moved`, including by a successor (R47-02, R47-03, R47-16) | Partly (§4.6 states the `moved` marker) |
| | §4.2/§12.2: `stops_version` on `owner_slot`, `Stop` acknowledged once enforced at the fence(s), owners read `placement_integrity_stops` without placement (R47-04, D2) | **No** |
| | §7.1: `ackSplitting`, `listPartitions`, creation with `rowAbsent(head)`; `slot_of` answers `s` with `headDecides` (not "the head row names (`s` until its `adopt`, `s + n` after)"); `probeAccounts` per version and the doubling order (R47-05, R47-21, R47-27, R47-29) | **No** |
| | §5.3–§5.5: closure topics with `dataHighWater`; `R_min` from topic metadata with no-progress partitions holding it back; closure on six streams with sizing (M7); per-topic producer ACL without a separate republish role (M8, R47-06, R47-20, R47-25); D3 conflict rule; `slot` header on outcome events (R47-22) | **No** |
| | §16: alert episodes (`alertId` with the raising entry), `cleared` by episode, `PROBING_FAULT` per D1 (M9, R47-08, R47-26) | **No** |
| | §17.3 and traceability: a slot-minute whose every probe failed is unavailable even with fewer than 3 probes (X2-S30, v1.10); X2-S33 cited, a short-probed slot alerted to network operations per D1 (N1, R47-26) | **No** |
| | §19: Kafka partitions per broker after one account-slot doubling (about 8,192 per account topic, est.) and the safety of a partition-count increase (R47-30) | **No** |
| | §6.3 stated as the precondition of the holder's view and read leases; `leaseValid` margin of `max_loop_delay` (R47-23) | Partly |

## 11. Settled

All points the two sides' RFCs disagreed on were settled by the orchestrator (binding). Each
row gives the decision as this contract states it and where the errata are listed (§10.3).
Review 47 refined how some are applied (§12), without changing the decisions.

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
| N1 | `requirements-v1.10` X2-S30 / X2-S33 vs RFC-006 rev. 6 §17.3 (a slot-minute with fewer than 3 probes, all failed; short-probed slot alerted to network operations) | **Noted** as an RFC-006 erratum; it changes probe-results classification, not this contract's schema (alert granularity: D1, §3.11) | RFC-006 |

## 12. Review 47 resolution

Every proposed fix and decisions D1 … D4 are applied (binding). Where the review offered two
options, the one taken is named.

| ID | Severity | Resolution | Where |
|---|---|---|---|
| R47-01 | Blocker | Projections and every row a condition or `ctx.read` may reach are keyed without the slot (`(home_key, partition, …)` or a logical key led by the partition); the migration tool rejects a slot-led projection key. "Own slot" = partitions whose head names the slot **and is adopted**. `displacementRead` keyed `(link, request)` (RFC-006 §3.7 erratum). Log and outbox stay slot-first with `(partition, seq)` and `(partition, stream, stream_seq)` indexes; the runtime, gap fill and history read a partition across its slot history. P1-S78 traced across a hot-link move, and A7 across an account move | §2.2, §2.3, §2.4, §3.1, §3.2, §3.3, §3.9, CP-5, CC-3, §10.3 |
| R47-02 | Blocker | Head column `adopted`: `moved` sets `slot = B, generation = g+1, adopted = false`; `adopt` sets it true. A: unadopted ⇒ `Moving`, adopted ⇒ `Moved(B, g+1)`; B: unadopted ⇒ `Moving` except `adopt`. Splitting rules defer to adopted heads | §2.3, §3.2, §3.3, §3.8, CP-5, CP-10, §10.3 (RFC-000 A-1) |
| R47-03 | Major | A marker is due when P passes a `moved` entry, including for a successor at or above `ts(moved)`, written as soon as its wait ends; CP-5 bound added | §3.3, §3.4, CP-5 |
| R47-04 | Major | `stops_version` on `owner_slot`, incremented by `Stop` on the holding slot (both during a move); owners SELECT `placement_integrity_stops` (named read); in-flight batches fail refresh; `StopAck` after the fence transaction commits (D2); takeover reads the table without placement | §2.3, §2.6, §3.1, §3.2, §6, CP-6, §10.3 |
| R47-05 | Major | `ackSplitting(kind, slot, v, upperHalf)` after the version is applied and in-flight batches resolved; holder-answered `listPartitions` (keeps A1 unchanged for placement); creation with implicit `rowAbsent(head)` | §2.3, §2.7, §3.2, §3.8, CP-10 |
| R47-06 | Major | **Option taken: separate closure topic** `<topic>.closure`, written only by the emitter (Kafka ACL), each marker with `dataHighWater`; `onResolved` fires only after the data position passes it. No per-message principal rule remains | §2.5, §3.6, CP-2b, §10.3 (RFC-005, RFC-000 A-5) |
| R47-07 | Major | D3: on a content conflict the database copy wins, the stream blocks at that `stream_seq` until read, `FEED_CONTENT_CONFLICT`; applied-digest check for a late conflicting copy | §3.5, §5, CP-9 |
| R47-08 | Major | `alertId` includes the episode (raising entry's (partition, seq)); `cleared` names the episode; `PROBING_FAULT` one episode per (region, minute) per D1 | §2.10, §3.11, §5, CP-14 |
| R47-09 | Major | `STALE_SENDER(recorded)`; equal generation and higher epoch ⇒ slot lost; higher generation ⇒ drop the command, keep the slot (D4), alert only if `moved` not applied | §2.4, §3.8, CC-5, §10.3 |
| R47-10 | Major | Errata rows added: M5 for RFC-003, RFC-004 (further lines), RFC-005 T-25, RFC-000 A6; M7 consumption for RFC-002 (`iam_fresh`, price cache) and RFC-005 (identity push declaration); `CommandEnvelope`/`admitCommand` for RFC-003 and RFC-004 | §10.3 |
| R47-11 | Minor | `AppendCall.reads`; `ctx.read` synchronous over declared rows | §2.4, CP-3 |
| R47-12 | Minor | `Retry` after 5 restarts + 1 fresh attempt; `Overloaded` only for admission control and shedding | §2.4, §3.2, §7, CP-2 |
| R47-13 | Minor | Resolution steps 1–4 numbered in §3.1 | §3.1 |
| R47-14 | Minor | High-priority resolution read retried until it answers, including `owner_session`; revoked ⇒ re-home; every committed call upserts its head with `batch_id` | §3.1, §3.2, CP-2a |
| R47-15 | Minor | `onAcquire(…, 'rehome')`: memory valid, re-arm idempotent, takeover entry still written | §2.4, §3.1, §3.7 |
| R47-16 | Minor | **Option taken: step 6 kept** (RFC-000 AI-27-2 requires it), made enforceable: B's report position does not pass an entry of X during the wait | §3.3, CP-5 |
| R47-17 | Minor | `leasedRead` as point reads, each its own statement | §2.4, §3.4 |
| R47-18 | Minor | Grants as INSERT/UPDATE/SELECT; session and slot updates bounded by row-level security per kind; same-kind forgery detected, not prevented | §2.3, CP-11 |
| R47-19 | Minor | Gap-fill roles per (consumer kind, producer kind) with row-level security on `topic`; `<kind>_stream_index` for self-outboxed kinds; the `ingest` relay holds the `ingest` log key | §2.2, §2.3, §2.5 |
| R47-20 | Minor | `R_min` over the topic metadata's partitions; no-progress partitions hold it back | §3.6, CP-8 |
| R47-21 | Minor | `SlotMapVersion.probeAccounts`; doubling order with new slots leased before the override version and F9 before the limit | §2.7, §3.8, CP-10 |
| R47-22 | Minor | `slot` header on outcome-feed events and markers | §2.5, §3.5 |
| R47-23 | Minor | `leaseValid` false within `max_loop_delay` of the view's end; §6.3 cited as precondition | §1, §2.4, §3.1, §7 |
| R47-24 | Minor | Receiver records the sender's fence in the applying entry; high-water rebuilt on `onAcquire` and `onAdopt` | §2.4, CC-5 |
| R47-25 | Minor | Republish folded into `<kind>-holder` | §2.5 |
| R47-26 | Minor | `PROBING_FAULT` (region, minute, slots) per D1; X2-S33 cited; N1 stays an RFC-006 erratum | §2.10, §3.11, §9, §10.3 |
| R47-27 | Minor | Wording errata added for RFC-000 §5.2, §5.4, §5.5 and RFC-006 §7.1, §3.7 | §10.3 |
| R47-28 | Minor | Restore role reads placement's table; RFC-005 erratum | §2.3, §10.3 |
| R47-29 | Minor | `slotOf` answers `{ slot: s, headDecides: true }`; router follows `MOVED` or retries `MOVING` | §2.7, §3.8 |
| R47-30 | Minor | Partition-count increase allowed and safe only by stream-sequence buffering and the slot gate; markers carry the count; RFC-006 §19 sizing erratum; estimates marked | §2.5, CP-8, §10.3 |
| R47-31 | Minor | **Option taken: lane (c) excluded from v1** | §2.3, §3.2, §8 |
| C04 v2 (review 43 B-01) | Binding addition | `ReportMarker` gets `pendingAnswered` and `prevReportPosition`. The markers of a slot make a chain, so a consumer can find the first covering marker when the relay changes the order. The producers do not change | §2.5, §3.4, CP-7a |
| D1 | Decision | `PROBING_FAULT` per (region, minute), `warning`, page on 5 consecutive minutes of one slot or > 1% of slots | §3.11, §7 |
| D2 | Decision | Stop acknowledged only once enforced at the slot fence | §2.6, §3.2 |
| D3 | Decision | Database copy wins a feed content conflict; stream blocks at that `stream_seq` | §3.5, §5 |
| D4 | Decision | `STALE_SENDER` with a higher generation is a superseded command, not a lost slot | §3.8, CC-5 |

Unmarked estimates the review found (`Moving` about 100 ms, takeover 3.3–3.8 s, the 8,192
partitions) are now marked "est.". Settled points M1 … M13 are unchanged; review 47 changed
how M8 is applied (no separate republish role; closure on its own topic) and completed M10's
role list, both within the settled decisions.
