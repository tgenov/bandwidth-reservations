/**
 * An in-memory OwnerStore for unit tests of the real runtime core. It is serialisable by optimistic
 * validation at commit (fence row and head rows read must be unchanged), and it injects faults:
 * retry errors, ambiguous commits (committed or not), hanging commits, lock timeouts.
 */
import type { HlcTs, ProjectionWrite, ReadTx, RowRef, SlotNo } from '../api.ts';
import { hex } from '../bytes.ts';
import { AmbiguousCommitError, retryableError } from '../errors.ts';
import { compareHlc, hlc, hlcBefore } from '../hlc.ts';
import { outcomeIdsOf } from './pg.ts';

import { rowId } from '../rowref.ts';
import type {
  BatchTxn, BatchWrites, DisplacementCondition, FenceRow, GroupMember, LogRowWrite, OutboxRowWrite, OwnerStore, ResolutionRead,
  SessionRow, SlotLeaseRow, StoredHead, TimingRow,
} from './types.ts';
import { systemClock, type WallClock } from '../clock.ts';

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
  timing: TimingRow = { version: 1n, epsilonMs: 100, deltaXMs: 320, tauMs: 420 };
  commitCount = 0;
  readonly streamIndex: Array<{ kind: string; partition: Uint8Array; stream: string; streamSeq: bigint; seq: bigint }> = [];
  readonly slotPositions = new Map<string, bigint>();
  /** Rows of projections by table, with their key columns (for withReadTx queries). */
  /** Called after each committed batch (tests use it as a changefeed). */
  readonly commitListeners: Array<(kind: string, w: BatchWrites) => void> = [];
  /** Statement names in order, across transactions (tests assert ordering, e.g. CP-4). */
  readonly statements: string[] = [];
  private readonly wallMs: WallClock;
  private lastWallNs = 0n;
  private logical = 0n;

  /** `wallMs`: the clock of session expiry and of commit timestamps (default: the system clock). */
  constructor(o: { wallMs?: WallClock } = {}) {
    this.wallMs = o.wallMs ?? systemClock;
  }

  /** Seed owner_slot rows as the migration tool does. */
  seedSlots(kind: string, slotCount: number): void {
    for (let s = 0; s < slotCount; s++) {
      if (!this.slots.has(`${kind}|${s}`)) this.slots.set(`${kind}|${s}`, { sessionId: null, epoch: 0n, stopsVersion: 0n, reportThrough: null, markerSeq: 0n });
    }
  }

  /**
   * Placement's Stop in one step: insert the stop and bump stops_version of each fenced slot (C01 §3.2; both slots
   * during a move). Returns the step's timestamp (the `enforced_at` of the stop).
   */
  stopPartition(kind: string, slot: SlotNo | SlotNo[], partition: Uint8Array, detectionRef: Uint8Array): HlcTs {
    this.stops.set(`${kind}|${hex(partition)}`, detectionRef);
    for (const s of Array.isArray(slot) ? slot : [slot]) {
      const row = this.slots.get(`${kind}|${s}`);
      if (row) row.stopsVersion += 1n;
    }
    return this.nowTs();
  }

  /** Placement's Resume in one step: lift the stop and bump stops_version of each fenced slot (C01 §3.2). */
  resumePartition(kind: string, slot: SlotNo | SlotNo[], partition: Uint8Array): HlcTs {
    this.stops.delete(`${kind}|${hex(partition)}`);
    for (const s of Array.isArray(slot) ? slot : [slot]) {
      const row = this.slots.get(`${kind}|${s}`);
      if (row) row.stopsVersion += 1n;
    }
    return this.nowTs();
  }

  /** Reads of `owner_slot.report_through` by the bounded read of C01 §3.3 step 5 (tests count them). */
  reportThroughReads = 0;

  async readReportThrough(kind: string, slot: SlotNo): Promise<HlcTs | null> {
    this.reportThroughReads += 1;
    return this.slots.get(`${kind}|${slot}`)?.reportThrough ?? null;
  }

  async pendingMovesFrom(kind: string, fromSlot: SlotNo): Promise<Array<{ partition: Uint8Array; to: SlotNo; ts: HlcTs }>> {
    const out: Array<{ partition: Uint8Array; to: SlotNo; ts: HlcTs }> = [];
    for (const [k, h] of this.heads) {
      if (!k.startsWith(`${kind}|`) || h.adopted || h.slot === fromSlot) continue;
      const last = this.log.find((l) => hex(l.partition) === hex(h.partition) && l.seq === h.seq);
      if (last?.slot === fromSlot) out.push({ partition: h.partition, to: h.slot, ts: h.ts });
    }
    return out;
  }

  slotRow(kind: string, slot: SlotNo): SlotRow | undefined {
    return this.slots.get(`${kind}|${slot}`);
  }

  nowTs(): HlcTs {
    const wall = BigInt(this.wallMs()) * 1_000_000n;
    if (wall > this.lastWallNs) { this.lastWallNs = wall; this.logical = 0n; } else { this.logical += 1n; }
    return hlc(`${this.lastWallNs}.${this.logical.toString().padStart(10, '0')}`);
  }

  async beginBatch(): Promise<BatchTxn> {
    return new MemoryTxn(this);
  }

  async insertSession(s: SessionRow): Promise<void> {
    this.sessions.set(s.sessionId, { shard: s.shard, expiresAt: this.wallMs() + s.ttlMs, revoked: false, kind: s.kind });
  }

  async renewSession(_shard: number, sessionId: string, ttlMs: number): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s || s.revoked) return false;
    s.expiresAt = this.wallMs() + ttlMs;
    return true;
  }

  async listSlots(kind: string, slots: SlotNo[]): Promise<SlotLeaseRow[]> {
    return slots.flatMap((slot) => {
      const r = this.slots.get(`${kind}|${slot}`);
      if (!r) return [];
      const s = r.sessionId ? this.sessions.get(r.sessionId) : undefined;
      return [{ slot, sessionId: r.sessionId, epoch: r.epoch, sessionExpired: s ? s.expiresAt <= this.wallMs() : true, sessionRevoked: s?.revoked ?? false }];
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
    if (!old || !(old.revoked || old.expiresAt <= this.wallMs())) return [];
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

  /** Fault injection for group acquisitions and group hand-offs: throw after this many member updates (then nothing is applied). */
  groupFailAfter: number | undefined;
  /** slot_group column values (kind|slot → group). */
  readonly slotGroups = new Map<string, string>();

  async acquireGroup(members: GroupMember[], sessionId: string, group: string, old: { shard: number; sessionId: string } | null):
    Promise<Array<GroupMember & { epoch: bigint }> | undefined> {
    // One transaction: decide on a copy, apply only when every member is takeable.
    if (old) {
      const s = this.sessions.get(old.sessionId);
      if (!s || !(s.revoked || s.expiresAt <= this.wallMs())) return undefined;
    }
    const out: Array<GroupMember & { epoch: bigint }> = [];
    for (const [i, m] of members.entries()) {
      if (this.groupFailAfter !== undefined && i >= this.groupFailAfter) { this.groupFailAfter = undefined; throw new Error('injected: group transaction failed'); }
      const r = this.slots.get(`${m.kind}|${m.slot}`);
      if (!r || r.sessionId !== (old ? old.sessionId : null)) return undefined;
      out.push({ ...m, epoch: r.epoch + 1n });
    }
    if (old) { const s = this.sessions.get(old.sessionId); if (s) s.revoked = true; }
    for (const m of out) {
      const r = this.slots.get(`${m.kind}|${m.slot}`);
      if (r) { r.sessionId = sessionId; r.epoch = m.epoch; }
      this.slotGroups.set(`${m.kind}|${m.slot}`, group);
    }
    return out;
  }

  async releaseGroup(held: Array<GroupMember & { epoch: bigint }>, sessionId: string, keepSession = true): Promise<void> {
    // One transaction: decide on a copy, apply only when no member update failed.
    const free: SlotRow[] = [];
    for (const [i, h] of held.entries()) {
      if (this.groupFailAfter !== undefined && i >= this.groupFailAfter) { this.groupFailAfter = undefined; throw new Error('injected: group transaction failed'); }
      const r = this.slots.get(`${h.kind}|${h.slot}`);
      if (r && r.sessionId === sessionId && r.epoch === h.epoch) free.push(r);
    }
    for (const r of free) r.sessionId = null;
    const s = this.sessions.get(sessionId);
    if (s && !keepSession) s.revoked = true;
  }

  async rehomeGroup(held: Array<GroupMember & { epoch: bigint }>, oldSession: string, newSession: string):
    Promise<Array<GroupMember & { epoch: bigint }> | undefined> {
    for (const h of held) {
      const r = this.slots.get(`${h.kind}|${h.slot}`);
      if (!r || r.sessionId !== oldSession || r.epoch !== h.epoch) return undefined;
    }
    return held.map((h) => {
      const r = this.slots.get(`${h.kind}|${h.slot}`) as SlotRow;
      r.sessionId = newSession; r.epoch += 1n;
      return { kind: h.kind, slot: h.slot, epoch: r.epoch };
    });
  }

  async clusterTime(): Promise<HlcTs> {
    return this.nowTs();
  }

  async revokeSession(_shard: number, sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) s.revoked = true;
  }

  async release(kind: string, held: Array<{ slot: SlotNo; epoch: bigint }>, sessionId: string, keepSession = false): Promise<void> {
    for (const h of held) {
      const r = this.slots.get(`${kind}|${h.slot}`);
      if (r && r.sessionId === sessionId && r.epoch === h.epoch) r.sessionId = null;
    }
    const s = this.sessions.get(sessionId);
    if (s && !keepSession) s.revoked = true;
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

  async readTiming(): Promise<TimingRow> {
    return this.timing;
  }

  async readLogRows(kind: string, partition: Uint8Array, fromSeq: bigint): Promise<Array<LogRowWrite & { ts: HlcTs }>> {
    void kind;
    return this.log.filter((l) => hex(l.partition) === hex(partition) && l.seq >= fromSeq).sort((a, b) => (a.seq < b.seq ? -1 : 1));
  }

  /** Rows the follower-read tail does not see yet (the closed-timestamp lag): the newest `followerLagRows` rows. */
  followerLagRows = 0;

  async tailLog(kind: string, slots: SlotNo[], afterTs: HlcTs | null, at: 'follower' | 'present'):
    Promise<{ rows: Array<LogRowWrite & { ts: HlcTs }>; through: HlcTs }> {
    void kind;
    const lag = at === 'follower' ? Math.min(this.followerLagRows, this.log.length) : 0;
    const visible = this.log.slice(0, this.log.length - lag);
    // The read is complete just below the first row it does not see (or at the present).
    const hidden = this.log.slice(this.log.length - lag).map((l) => l.ts).sort(compareHlc)[0];
    const through = hidden !== undefined ? hlcBefore(hidden) : this.nowTs();
    const rows = visible.filter((l) => slots.includes(l.slot) && (afterTs === null || compareHlc(l.ts, afterTs) > 0))
      .sort((a, b) => compareHlc(a.ts, b.ts) || (hex(a.partition) < hex(b.partition) ? -1 : hex(a.partition) > hex(b.partition) ? 1 : 0) || (a.seq < b.seq ? -1 : 1));
    return { rows, through };
  }

  async listPartitions(kind: string, slot: SlotNo): Promise<Uint8Array[]> {
    return [...this.heads.entries()].filter(([k, h]) => k.startsWith(`${kind}|`) && h.slot === slot && h.adopted).map(([, h]) => h.partition);
  }

  async withReadTx<T>(_at: 'present' | HlcTs, fn: (tx: ReadTx) => Promise<T>): Promise<T> {
    return fn({ query: async (sql, params) => this.query(sql, params ?? []) as never });
  }

  async followerRead<T>(fn: (tx: ReadTx) => Promise<T>): Promise<{ value: T; servedAt: HlcTs }> {
    return { value: await fn({ query: async (sql, params) => this.query(sql, params ?? []) as never }), servedAt: this.nowTs() };
  }

  /**
   * A small query engine for consistentRead / followerRead in unit tests:
   * `SELECT … FROM <projection> [WHERE c1 = $1 AND c2 = $2 …]` over the projection rows (key columns and row),
   * and the same over `<kind>_head`. Any other statement throws.
   */
  query(sql: string, params: unknown[]): Array<Record<string, unknown>> {
    return memoryQuery(sql, params, (table) => {
      const out: Array<Record<string, unknown>> = [];
      if (table.endsWith('_head')) {
        const kind = table.slice(0, -'_head'.length);
        for (const [k, h] of this.heads) if (k.startsWith(`${kind}|`)) out.push({ ...h, home_key: h.homeKey });
      } else {
        for (const r of this.projectionRows.get(table) ?? []) out.push({ ...r.key, ...(r.row as Record<string, unknown>) });
      }
      return out;
    });
  }

  /** table → rows with their key (kept beside `rows` for query()). */
  readonly projectionRows = new Map<string, Array<{ id: string; key: Record<string, unknown>; row: unknown }>>();

  async close(): Promise<void> {}

  private indexProjection(p: ProjectionWrite): void {
    const id = rowId({ table: p.table, key: p.key });
    const list = (this.projectionRows.get(p.table) ?? []).filter((r) => r.id !== id);
    if (p.op === 'upsert') list.push({ id, key: p.key as Record<string, unknown>, row: p.row });
    this.projectionRows.set(p.table, list);
  }

  /** Apply a committed batch atomically. */
  applyWrites(kind: string, w: BatchWrites): void {
    for (const r of w.log) this.log.push({ ...r, ts: w.ts });
    for (const r of w.outbox) {
      if (r.ifAbsent && this.outbox.some((o) => o.slot === r.slot && hex(o.partition) === hex(r.partition) && o.stream === r.stream && o.n === r.n)) continue;
      this.outbox.push({ ...r, ts: w.ts });
    }
    for (const h of w.heads) this.heads.set(`${kind}|${hex(h.partition)}`, h);
    for (const p of w.projections) { applyProjection(this.rows, p); this.indexProjection(p); }
    for (const x of w.streamIndex ?? []) this.streamIndex.push({ kind, ...x });
    if (w.slotPosition) this.slotPositions.set(`${kind}|${w.slotPosition.slot}`, w.slotPosition.position);
    if (w.slotUpdate) {
      const row = this.slots.get(`${kind}|${w.slotUpdate.slot}`);
      if (row) { row.reportThrough = w.slotUpdate.reportThrough; row.markerSeq = w.slotUpdate.markerSeq; }
    }
    this.commitCount += 1;
    for (const l of this.commitListeners) l(kind, w);
  }
}

function applyProjection(rows: Map<string, unknown>, p: ProjectionWrite): void {
  const id = rowId({ table: p.table, key: p.key });
  if (p.op === 'delete') rows.delete(id);
  else rows.set(id, p.row);
}

class MemoryTxn implements BatchTxn {
  private readonly store: MemoryStore;
  private fenceSeen: { kind: string; slot: SlotNo; epoch: bigint; sessionId: string | null; stopsVersion: bigint } | undefined;
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
    this.fenceSeen = { kind, slot, epoch: r.epoch, sessionId: r.sessionId, stopsVersion: r.stopsVersion };
    return { sessionId: r.sessionId, epoch: r.epoch, stopsVersion: r.stopsVersion, reportThrough: r.reportThrough, markerSeq: r.markerSeq };
  }

  async readTiming(): Promise<TimingRow> {
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

  async readSlotPosition(kind: string, slot: SlotNo): Promise<bigint> {
    return this.store.slotPositions.get(`${kind}|${slot}`) ?? 0n;
  }

  async readOutcomeIds(kind: string, slot: SlotNo, stream: string, after: HlcTs | null, upTo: HlcTs): Promise<Uint8Array[]> {
    void kind;
    const rows = this.store.outbox.filter((o) => o.slot === slot && o.stream === stream && o.partition.byteLength > 0
      && (after === null || compareHlc(o.ts, after) > 0) && compareHlc(o.ts, upTo) <= 0);
    return outcomeIdsOf(rows.map((r) => r.headers));
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
      // A Stop or Resume writes stops_version: serialisable order restarts a batch that read the old value (C01 §3.2).
      if (!r || r.epoch !== f.epoch || r.sessionId !== f.sessionId || r.stopsVersion !== f.stopsVersion) throw retryableError('fence row changed');
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


/** FeedSeqReader over a MemoryStore: the highest stream_seq of each partition's rows with ts ≤ at (unit tests). */
export function memoryFeedSeqReader(store: MemoryStore): import('../closure/emitter.ts').FeedSeqReader {
  return {
    async feedSeqs(_kind, stream, at, changedAfter) {
      const best = new Map<string, { link: Uint8Array; feedSeq: bigint; ts: HlcTs }>();
      for (const o of store.outbox) {
        if (o.stream !== stream || compareHlc(o.ts, at) > 0) continue;
        const k = hex(o.partition);
        const cur = best.get(k);
        if (!cur || cur.feedSeq < o.streamSeq) best.set(k, { link: o.partition, feedSeq: o.streamSeq, ts: o.ts });
      }
      return [...best.values()].filter((b) => changedAfter === null || compareHlc(b.ts, changedAfter) > 0)
        .map((b) => ({ link: b.link, feedSeq: b.feedSeq }));
    },
  };
}

/**
 * `SELECT … FROM <table> [WHERE c1 = $1 AND c2 = $2 …]` over rows that `rowsOf(table)` gives (unit tests and
 * the runtime double). Bytes compare by value; other values by their string form. Any other statement throws.
 */
export function memoryQuery(sql: string, params: unknown[], rowsOf: (table: string) => Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const m = /^\s*SELECT\s+[\s\S]+?\s+FROM\s+([a-z][a-z0-9_]*)(?:\s+WHERE\s+([\s\S]+?))?\s*;?\s*$/i.exec(sql);
  if (!m) throw new Error(`memory query supports SELECT … FROM t [WHERE c = $n AND …] only: ${sql}`);
  const conds = (m[2] ?? '').split(/\s+AND\s+/i).filter((c) => c.trim().length > 0).map((c) => {
    const x = /^\s*([a-z][a-z0-9_]*)\s*=\s*\$(\d+)\s*$/i.exec(c);
    if (!x) throw new Error(`memory query: unsupported condition ${c}`);
    return { col: x[1] as string, value: params[Number(x[2]) - 1] };
  });
  const eq = (a: unknown, b: unknown): boolean =>
    a instanceof Uint8Array || b instanceof Uint8Array ? a instanceof Uint8Array && b instanceof Uint8Array && hex(a) === hex(b) : String(a) === String(b);
  return rowsOf(m[1] as string).filter((r) => conds.every((c) => eq(r[c.col], c.value)));
}
