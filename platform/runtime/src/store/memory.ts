/**
 * An in-memory OwnerStore for unit tests of the real runtime core. It is serialisable by optimistic
 * validation at commit (fence row and head rows read must be unchanged), and it injects faults:
 * retry errors, ambiguous commits (committed or not), hanging commits, lock timeouts.
 */
import type { HlcTs, ProjectionWrite, ReadTx, RowRef, SlotNo, TimingSnapshot } from '../api.ts';
import { hex } from '../bytes.ts';
import { AmbiguousCommitError, retryableError } from '../errors.ts';
import { hlc } from '../hlc.ts';

import { rowId } from '../rowref.ts';
import type {
  BatchTxn, BatchWrites, DisplacementCondition, FenceRow, LogRowWrite, OutboxRowWrite, OwnerStore, ResolutionRead,
  SessionRow, SlotLeaseRow, StoredHead,
} from './types.ts';

export type CommitFault = 'ok' | 'retry' | 'ambiguousCommitted' | 'ambiguousNotCommitted' | 'hang';

export interface MemoryFaults {
  /** Throw a 40001 at the next N fence reads. */
  retryAtFence: number;
  /** Outcomes of the next commits, in order ('ok' when empty). */
  commits: CommitFault[];
  /** The displacement read meets its lock timeout. */
  displacementLockTimeout: boolean;
  /** Runs inside each attempt just before COMMIT (e.g. a concurrent acquisition). */
  beforeCommit?: () => void | Promise<void>;
}

interface SlotRow { sessionId: string | null; epoch: bigint; stopsVersion: bigint; reportThrough: HlcTs | null; markerSeq: bigint }
interface SessionRec { shard: number; expiresAt: number; revoked: boolean; kind: string }

export class MemoryStore implements OwnerStore {
  readonly faults: MemoryFaults = { retryAtFence: 0, commits: [], displacementLockTimeout: false };
  readonly sessions = new Map<string, SessionRec>();
  readonly slots = new Map<string, SlotRow>();
  readonly heads = new Map<string, StoredHead>();
  readonly log: Array<LogRowWrite & { ts: HlcTs }> = [];
  readonly outbox: Array<OutboxRowWrite & { ts: HlcTs }> = [];
  readonly rows = new Map<string, unknown>();
  readonly stops = new Map<string, Uint8Array>();
  readonly displacement = new Map<string, unknown>();
  timing: TimingSnapshot = { version: 1n, epsilonMs: 100, deltaXMs: 320, tauMs: 420 };
  commitCount = 0;
  /** Statement names in order, across transactions (tests assert ordering, e.g. CP-4). */
  readonly statements: string[] = [];
  private lastWallNs = 0n;
  private logical = 0n;

  /** Seed owner_slot rows as the migration tool does. */
  seedSlots(kind: string, slotCount: number): void {
    for (let s = 0; s < slotCount; s++) {
      if (!this.slots.has(`${kind}|${s}`)) this.slots.set(`${kind}|${s}`, { sessionId: null, epoch: 0n, stopsVersion: 0n, reportThrough: null, markerSeq: 0n });
    }
  }

  /** Placement's Stop: insert the stop and bump stops_version of the slot (C01 §3.2). */
  stopPartition(kind: string, slot: SlotNo, partition: Uint8Array, detectionRef: Uint8Array): void {
    this.stops.set(`${kind}|${hex(partition)}`, detectionRef);
    const row = this.slots.get(`${kind}|${slot}`);
    if (row) row.stopsVersion += 1n;
  }

  slotRow(kind: string, slot: SlotNo): SlotRow | undefined {
    return this.slots.get(`${kind}|${slot}`);
  }

  nowTs(): HlcTs {
    const wall = BigInt(Date.now()) * 1_000_000n;
    if (wall > this.lastWallNs) { this.lastWallNs = wall; this.logical = 0n; } else { this.logical += 1n; }
    return hlc(`${this.lastWallNs}.${this.logical.toString().padStart(10, '0')}`);
  }

  async beginBatch(): Promise<BatchTxn> {
    return new MemoryTxn(this);
  }

  async insertSession(s: SessionRow): Promise<void> {
    this.sessions.set(s.sessionId, { shard: s.shard, expiresAt: Date.now() + s.ttlMs, revoked: false, kind: s.kind });
  }

  async renewSession(_shard: number, sessionId: string, ttlMs: number): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s || s.revoked) return false;
    s.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async listSlots(kind: string, slots: SlotNo[]): Promise<SlotLeaseRow[]> {
    return slots.flatMap((slot) => {
      const r = this.slots.get(`${kind}|${slot}`);
      if (!r) return [];
      const s = r.sessionId ? this.sessions.get(r.sessionId) : undefined;
      return [{ slot, sessionId: r.sessionId, epoch: r.epoch, sessionExpired: s ? s.expiresAt <= Date.now() : true, sessionRevoked: s?.revoked ?? false }];
    });
  }

  async acquireFree(kind: string, slot: SlotNo, sessionId: string): Promise<{ slot: SlotNo; epoch: bigint } | undefined> {
    const r = this.slots.get(`${kind}|${slot}`);
    if (!r || r.sessionId !== null) return undefined;
    r.sessionId = sessionId; r.epoch += 1n;
    return { slot, epoch: r.epoch };
  }

  async acquireExpired(kind: string, _oldShard: number, oldSession: string, slots: SlotNo[], sessionId: string): Promise<Array<{ slot: SlotNo; epoch: bigint }>> {
    const old = this.sessions.get(oldSession);
    if (!old || !(old.revoked || old.expiresAt <= Date.now())) return [];
    old.revoked = true;
    const out: Array<{ slot: SlotNo; epoch: bigint }> = [];
    for (const slot of slots) {
      const r = this.slots.get(`${kind}|${slot}`);
      if (r && r.sessionId === oldSession) { r.sessionId = sessionId; r.epoch += 1n; out.push({ slot, epoch: r.epoch }); }
    }
    return out;
  }

  async rehome(kind: string, held: Array<{ slot: SlotNo; epoch: bigint }>, oldSession: string, newSession: string): Promise<Array<{ slot: SlotNo; epoch: bigint }>> {
    const out: Array<{ slot: SlotNo; epoch: bigint }> = [];
    for (const h of held) {
      const r = this.slots.get(`${kind}|${h.slot}`);
      if (r && r.sessionId === oldSession && r.epoch === h.epoch) { r.sessionId = newSession; r.epoch += 1n; out.push({ slot: h.slot, epoch: r.epoch }); }
    }
    return out;
  }

  async release(kind: string, held: Array<{ slot: SlotNo; epoch: bigint }>, sessionId: string): Promise<void> {
    for (const h of held) {
      const r = this.slots.get(`${kind}|${h.slot}`);
      if (r && r.sessionId === sessionId && r.epoch === h.epoch) r.sessionId = null;
    }
    const s = this.sessions.get(sessionId);
    if (s) s.revoked = true;
  }

  async resolutionRead(kind: string, _shard: number, sessionId: string, slots: SlotNo[], partitions: Uint8Array[]): Promise<ResolutionRead> {
    const out: ResolutionRead = { tRes: this.nowTs(), sessionRevoked: this.sessions.get(sessionId)?.revoked ?? true, slots: new Map(), heads: new Map() };
    for (const s of slots) {
      const r = this.slots.get(`${kind}|${s}`);
      if (r) out.slots.set(s, { sessionId: r.sessionId, epoch: r.epoch });
    }
    for (const p of partitions) {
      const h = this.heads.get(`${kind}|${hex(p)}`);
      if (h) out.heads.set(hex(p), h);
    }
    return out;
  }

  async readTiming(): Promise<TimingSnapshot> {
    return this.timing;
  }

  async withReadTx<T>(_at: 'present' | HlcTs, fn: (tx: ReadTx) => Promise<T>): Promise<T> {
    return fn({ query: async () => [] });
  }

  async followerRead<T>(fn: (tx: ReadTx) => Promise<T>): Promise<{ value: T; servedAt: HlcTs }> {
    return { value: await fn({ query: async () => [] }), servedAt: this.nowTs() };
  }

  async close(): Promise<void> {}

  /** Apply a committed batch atomically. */
  applyWrites(kind: string, w: BatchWrites): void {
    for (const r of w.log) this.log.push({ ...r, ts: w.ts });
    for (const r of w.outbox) {
      if (r.ifAbsent && this.outbox.some((o) => o.slot === r.slot && hex(o.partition) === hex(r.partition) && o.stream === r.stream && o.n === r.n)) continue;
      this.outbox.push({ ...r, ts: w.ts });
    }
    for (const h of w.heads) this.heads.set(`${kind}|${hex(h.partition)}`, h);
    for (const p of w.projections) applyProjection(this.rows, p);
    this.commitCount += 1;
  }
}

function applyProjection(rows: Map<string, unknown>, p: ProjectionWrite): void {
  const id = rowId({ table: p.table, key: p.key });
  if (p.op === 'delete') rows.delete(id);
  else rows.set(id, p.row);
}

class MemoryTxn implements BatchTxn {
  private readonly store: MemoryStore;
  private fenceSeen: { kind: string; slot: SlotNo; epoch: bigint; sessionId: string | null } | undefined;
  private readonly headsSeen = new Map<string, string>();
  private pending: { kind: string; w: BatchWrites } | undefined;
  private firstWrites: ProjectionWrite[] = [];
  private ts: HlcTs | undefined;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async firstStatement(writes: ProjectionWrite[]): Promise<HlcTs> {
    this.store.statements.push('firstStatement');
    this.firstWrites = writes;
    this.ts = this.store.nowTs();
    return this.ts;
  }

  async readFence(kind: string, slot: SlotNo): Promise<FenceRow | undefined> {
    this.store.statements.push('readFence');
    if (this.store.faults.retryAtFence > 0) {
      this.store.faults.retryAtFence -= 1;
      throw retryableError('injected restart at the fence read');
    }
    const r = this.store.slotRow(kind, slot);
    if (!r) return undefined;
    this.fenceSeen = { kind, slot, epoch: r.epoch, sessionId: r.sessionId };
    return { sessionId: r.sessionId, epoch: r.epoch, stopsVersion: r.stopsVersion, reportThrough: r.reportThrough, markerSeq: r.markerSeq };
  }

  async readTiming(): Promise<TimingSnapshot> {
    return this.store.timing;
  }

  async readStops(kind: string, partitions: Uint8Array[]): Promise<Map<string, Uint8Array>> {
    const m = new Map<string, Uint8Array>();
    for (const p of partitions) {
      const s = this.store.stops.get(`${kind}|${hex(p)}`);
      if (s) m.set(hex(p), s);
    }
    return m;
  }

  async readHeads(kind: string, partitions: Uint8Array[]): Promise<Map<string, StoredHead>> {
    this.store.statements.push('readHeads');
    const m = new Map<string, StoredHead>();
    for (const p of partitions) {
      const h = this.store.heads.get(`${kind}|${hex(p)}`);
      this.headsSeen.set(`${kind}|${hex(p)}`, h ? hex(h.batchId) : '');
      if (h) m.set(hex(p), h);
    }
    return m;
  }

  async readRows(refs: RowRef[]): Promise<Map<string, unknown>> {
    this.store.statements.push('readRows');
    const m = new Map<string, unknown>();
    for (const r of refs) {
      const id = rowId(r);
      if (this.store.rows.has(id)) m.set(id, this.store.rows.get(id));
    }
    return m;
  }

  async readDisplacement(c: DisplacementCondition): Promise<{ row: unknown | undefined } | 'lockTimeout'> {
    this.store.statements.push('readDisplacement');
    if (this.store.faults.displacementLockTimeout) return 'lockTimeout';
    return { row: this.store.displacement.get(`${hex(c.link)}|${hex(c.request)}`) };
  }

  async readTs(): Promise<HlcTs> {
    this.store.statements.push('readTs');
    this.ts = this.store.nowTs();
    return this.ts;
  }

  async write(kind: string, w: BatchWrites): Promise<void> {
    this.store.statements.push('write');
    this.pending = { kind, w: { ...w, projections: [...this.firstWrites, ...w.projections] } };
  }

  async restart(): Promise<void> {
    this.store.statements.push('restart');
    this.reset();
  }

  async commit(): Promise<void> {
    this.store.statements.push('commit');
    await this.store.faults.beforeCommit?.();
    const fault = this.store.faults.commits.shift() ?? 'ok';
    if (fault === 'retry') throw retryableError('injected restart at RELEASE');
    if (fault === 'hang') return new Promise<void>(() => {});
    this.validate();
    if (fault === 'ambiguousNotCommitted') throw new AmbiguousCommitError('injected: answer lost, not committed');
    if (this.pending) this.store.applyWrites(this.pending.kind, this.pending.w);
    if (fault === 'ambiguousCommitted') throw new AmbiguousCommitError('injected: answer lost, committed');
  }

  async rollback(): Promise<void> {
    this.store.statements.push('rollback');
    this.reset();
  }

  close(): void {}

  /** Serialisable validation: the fence row and every head read are unchanged (else a 40001). */
  private validate(): void {
    const f = this.fenceSeen;
    if (f) {
      const r = this.store.slotRow(f.kind, f.slot);
      if (!r || r.epoch !== f.epoch || r.sessionId !== f.sessionId) throw retryableError('fence row changed');
    }
    for (const [k, batch] of this.headsSeen) {
      const h = this.store.heads.get(k);
      if ((h ? hex(h.batchId) : '') !== batch) throw retryableError('head row changed');
    }
  }

  private reset(): void {
    this.pending = undefined;
    this.firstWrites = [];
    this.headsSeen.clear();
    this.fenceSeen = undefined;
  }
}

