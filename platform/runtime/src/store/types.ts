import type { Condition, HlcTs, ProjectionWrite, ReadTx, RowRef, SlotNo, TimingSnapshot } from '../api.ts';

/** A `platform_timing` row as the runtime reads it: C01's TimingSnapshot and the lane settings (C01 §2.3). */
export interface TimingRow extends TimingSnapshot {
  /** `second_lane` JSONB: {kind: {account|deadline: bool}} (lane (c) excluded in v1, C01 §3.2). */
  secondLane?: Record<string, { account?: boolean; deadline?: boolean }>;
}

export interface StoredHead {
  homeKey: number; partition: Uint8Array; slot: SlotNo; generation: number; adopted: boolean;
  seq: bigint; ts: HlcTs; epoch: bigint; streams: Record<string, bigint>; chain: Uint8Array; batchId: Uint8Array;
}

/** The owner_slot fence row (C01 §2.3). */
export interface FenceRow {
  sessionId: string | null; epoch: bigint; stopsVersion: bigint; reportThrough: HlcTs | null; markerSeq: bigint;
}

export interface LogRowWrite {
  slot: SlotNo; partition: Uint8Array; seq: bigint; generation: number; epoch: bigint; kind: number; schemaV: number;
  identity: Uint8Array; emits: Uint8Array; audit: Uint8Array; retention: number; keyId: Uint8Array;
  payload: Uint8Array; chain: Uint8Array;
}

export interface OutboxRowWrite {
  slot: SlotNo; partition: Uint8Array; stream: string; streamSeq: bigint; n: number; topic: string;
  msgKey: Uint8Array; headers: Uint8Array; payload: Uint8Array; generation: number; epoch: bigint;
  /** Notification rows may be re-sent with the same identity: insert-if-absent. */
  ifAbsent: boolean;
}

/** Every write of one batch; all rows carry the batch's `ts`. */
export interface BatchWrites {
  ts: HlcTs; log: LogRowWrite[]; outbox: OutboxRowWrite[]; heads: StoredHead[]; projections: ProjectionWrite[];
  /** A report marker in this transaction: owner_slot.report_through and marker_seq (C01 §3.4, V59-6). */
  slotUpdate?: { slot: SlotNo; reportThrough: HlcTs; markerSeq: bigint };
  /** Self-outboxed kinds: `<kind>_stream_index` rows (C01 §2.3, R47-19). */
  streamIndex?: Array<{ partition: Uint8Array; stream: string; streamSeq: bigint; seq: bigint }>;
  /** Kinds with slotPositions: the slot's new commit position (C08 §C). */
  slotPosition?: { slot: SlotNo; position: bigint };
}

export type DisplacementCondition = Extract<Condition, { kind: 'displacementRead' }>;

/** One serialisable batch transaction, opened with BEGIN; SAVEPOINT cockroach_restart (RFC-006 §4.3). */
export interface BatchTxn {
  /** firstStatement writes and the ts read in one statement (C01 §2.4 AppendOptions, M3). */
  firstStatement(writes: ProjectionWrite[]): Promise<HlcTs>;
  readFence(kind: string, slot: SlotNo): Promise<FenceRow | undefined>;
  readTiming(shard: number): Promise<TimingRow>;
  /** Open stops (state 'stopped') of these partitions: hex(partition) → detection_ref. */
  readStops(kind: string, partitions: Uint8Array[]): Promise<Map<string, Uint8Array>>;
  /** hex(partition) → head, for partitions that have one. */
  readHeads(kind: string, partitions: Uint8Array[]): Promise<Map<string, StoredHead>>;
  /** rowId → row, for rows that exist. */
  readRows(refs: RowRef[]): Promise<Map<string, unknown>>;
  readDisplacement(c: DisplacementCondition): Promise<{ row: unknown | undefined } | 'lockTimeout'>;
  readTs(): Promise<HlcTs>;
  /** C01 §3.4 rule 7: `outcome_id` of every outcome event of the slot with after < ts ≤ upTo (marker-only transactions). */
  readOutcomeIds?(kind: string, slot: SlotNo, stream: string, after: HlcTs | null, upTo: HlcTs): Promise<Uint8Array[]>;
  /** Kinds with slotPositions: the slot's last commit position (0 before the first). */
  readSlotPosition?(kind: string, slot: SlotNo): Promise<bigint>;
  write(kind: string, w: BatchWrites): Promise<void>;
  /** ROLLBACK TO SAVEPOINT cockroach_restart: keeps intents (a restart, not an abort). */
  restart(): Promise<void>;
  /** SET LOCAL statement_timeout = backstop; RELEASE SAVEPOINT; COMMIT. Throws a 40001 error when not
   *  committed and retryable, or AmbiguousCommitError when the outcome is unknown. */
  commit(backstopMs: number): Promise<void>;
  rollback(): Promise<void>;
  close(broken: boolean): void;
}

export interface SlotLeaseRow {
  slot: SlotNo; sessionId: string | null; epoch: bigint; sessionExpired: boolean; sessionRevoked: boolean;
}

/** One owner_slot row of a slot group. */
export interface GroupMember { kind: string; slot: SlotNo }

export interface SessionRow {
  shard: number; sessionId: string; host: string; region: string; facility: string; kind: string; ttlMs: number;
}

/** Resolution step 1 (C01 §3.1): one high-priority present-time read. */
export interface ResolutionRead {
  tRes: HlcTs;
  sessionRevoked: boolean;
  slots: Map<SlotNo, { sessionId: string | null; epoch: bigint }>;
  heads: Map<string, StoredHead>;
}

export interface OwnerStore {
  beginBatch(): Promise<BatchTxn>;
  insertSession(s: SessionRow): Promise<void>;
  /** UPDATE … SET expires_at = now() + ttl WHERE … AND NOT revoked; false when no row was updated. */
  renewSession(shard: number, sessionId: string, ttlMs: number): Promise<boolean>;
  listSlots(kind: string, slots: SlotNo[]): Promise<SlotLeaseRow[]>;
  acquireFree(kind: string, slot: SlotNo, sessionId: string): Promise<{ slot: SlotNo; epoch: bigint } | undefined>;
  /** One high-priority transaction: revoke the expired session, take its slots (RFC-006 §4.2). */
  acquireExpired(kind: string, oldShard: number, oldSession: string, slots: SlotNo[], sessionId: string):
    Promise<Array<{ slot: SlotNo; epoch: bigint }>>;
  rehome(kind: string, held: Array<{ slot: SlotNo; epoch: bigint }>, oldSession: string, newSession: string):
    Promise<Array<{ slot: SlotNo; epoch: bigint }>>;
  /** Frees the slots still at these epochs; revokes the session too unless `keepSession` (a handoff, RFC-006 §4.2). */
  release(kind: string, held: Array<{ slot: SlotNo; epoch: bigint }>, sessionId: string, keepSession?: boolean): Promise<void>;
  /** Opens a connection on every gateway tier (RFC-006 §4.7); a store without tiers does nothing. */
  warm?(): Promise<void>;
  /** The database's time, `SELECT cluster_logical_timestamp()` (the owner-host offset check, RFC-006 §6.2). */
  clusterTime?(): Promise<HlcTs>;
  /** Gives up the session at once (RFC-006 §6.2 level D): standbys see it revoked and take its slots. */
  revokeSession?(shard: number, sessionId: string): Promise<void>;
  /**
   * Slot groups (RFC-006 §4.2, §7.1; C01 §3.1): take every member of one group in one transaction, or none.
   * `old` null: free-slot acquisition (every member free). Else acquisition by expiry: revoke the old session
   * (expired or revoked) and take every member it holds. Sets `slot_group`. Undefined when not all were taken.
   */
  acquireGroup?(members: GroupMember[], sessionId: string, group: string, old: { shard: number; sessionId: string } | null):
    Promise<Array<GroupMember & { epoch: bigint }> | undefined>;
  /** Re-home of one group in one transaction: every member still at its own epoch, or none (C01 §3.1). */
  rehomeGroup?(held: Array<GroupMember & { epoch: bigint }>, oldSession: string, newSession: string):
    Promise<Array<GroupMember & { epoch: bigint }> | undefined>;
  resolutionRead(kind: string, sessionShard: number, sessionId: string, slots: SlotNo[], partitions: Uint8Array[]):
    Promise<ResolutionRead>;
  readTiming(shard: number): Promise<TimingRow>;
  /** A partition's log rows by (partition, seq) from `fromSeq`, across slots (C01 §3.1 rebuild, R47-01). */
  readLogRows?(kind: string, partition: Uint8Array, fromSeq: bigint): Promise<Array<LogRowWrite & { ts: HlcTs }>>;
  /**
   * A standby's tail (RFC-006 §4.4): log rows written by these slots with ts above `afterTs`, in (ts, partition,
   * seq) order, and the read timestamp `through` (every such row with ts ≤ through is in `rows`). 'follower': a follower read (the standby_poll tail); 'present': a high-priority present-time read
   * (the catch-up of a taking-over standby only).
   */
  tailLog?(kind: string, slots: SlotNo[], afterTs: HlcTs | null, at: 'follower' | 'present'):
    Promise<{ rows: Array<LogRowWrite & { ts: HlcTs }>; through: HlcTs }>;
  /** Partitions whose head names the slot and is adopted (the partitions the slot serves, C01 §3.2). */
  listPartitions?(kind: string, slot: SlotNo): Promise<Uint8Array[]>;
  withReadTx<T>(at: 'present' | HlcTs, fn: (tx: ReadTx) => Promise<T>): Promise<T>;
  followerRead<T>(fn: (tx: ReadTx) => Promise<T>): Promise<{ value: T; servedAt: HlcTs }>;
  close(): Promise<void>;
}
