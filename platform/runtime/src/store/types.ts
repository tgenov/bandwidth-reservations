import type { Condition, HlcTs, ProjectionWrite, ReadTx, RowRef, SlotNo, TimingSnapshot } from '../api.ts';

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
}

export type DisplacementCondition = Extract<Condition, { kind: 'displacementRead' }>;

/** One serialisable batch transaction, opened with BEGIN; SAVEPOINT cockroach_restart (RFC-006 §4.3). */
export interface BatchTxn {
  /** firstStatement writes and the ts read in one statement (C01 §2.4 AppendOptions, M3). */
  firstStatement(writes: ProjectionWrite[]): Promise<HlcTs>;
  readFence(kind: string, slot: SlotNo): Promise<FenceRow | undefined>;
  readTiming(shard: number): Promise<TimingSnapshot>;
  /** Open stops (state 'stopped') of these partitions: hex(partition) → detection_ref. */
  readStops(kind: string, partitions: Uint8Array[]): Promise<Map<string, Uint8Array>>;
  /** hex(partition) → head, for partitions that have one. */
  readHeads(kind: string, partitions: Uint8Array[]): Promise<Map<string, StoredHead>>;
  /** rowId → row, for rows that exist. */
  readRows(refs: RowRef[]): Promise<Map<string, unknown>>;
  readDisplacement(c: DisplacementCondition): Promise<{ row: unknown | undefined } | 'lockTimeout'>;
  readTs(): Promise<HlcTs>;
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
  release(kind: string, held: Array<{ slot: SlotNo; epoch: bigint }>, sessionId: string): Promise<void>;
  resolutionRead(kind: string, sessionShard: number, sessionId: string, slots: SlotNo[], partitions: Uint8Array[]):
    Promise<ResolutionRead>;
  readTiming(shard: number): Promise<TimingSnapshot>;
  withReadTx<T>(at: 'present' | HlcTs, fn: (tx: ReadTx) => Promise<T>): Promise<T>;
  followerRead<T>(fn: (tx: ReadTx) => Promise<T>): Promise<{ value: T; servedAt: HlcTs }>;
  close(): Promise<void>;
}
