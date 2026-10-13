/**
 * Placement's integrity stop service (C01 §2.6, §3.2, §5; RFC-006 §7.1, §14.3; plan S-PLAT-I3 work item 9).
 *
 * Audit calls `Stop(kind, partition, detection_ref)` and, after its checks, `Resume(...)`. Each call is ONE
 * transaction through an `IntegrityStopStore`: it writes the row of `placement_integrity_stops` and increments
 * `owner_slot.stops_version` of every fenced slot (V59-3: placement changes no other column). The commit
 * timestamp of that transaction is `enforced_at`. The `StopAck` goes back only after the commit (D2): if the
 * commit fails, the call throws and no stop exists. The fenced slots are the slots that hold the partition
 * (V59-4): both slots while a move of the partition is not `done`, and both `s` and `s + n` for an account whose
 * `slotOf` answer has `headDecides`. Stop and Resume are idempotent by `detection_ref` (C01 §5).
 */
import type { HlcTs, SlotMapVersion, SlotNo } from '../api.ts';
import { bytesEqual, hex } from '../bytes.ts';
import { slotOfPartition } from '../home.ts';
import type { MemoryStore } from '../store/memory.ts';
import { slotOfInMap } from './slot-map.ts';

/** The refusal codes of C01 §2.6. */
export type IntegrityStopErrorCode = 'CONFLICT' | 'NOT_STOPPED' | 'HEAD_MISMATCH' | 'PERMISSION_DENIED';

/** All refusal codes of C01 §2.6, in contract order. */
export const INTEGRITY_STOP_ERROR_CODES: readonly IntegrityStopErrorCode[] = ['CONFLICT', 'NOT_STOPPED', 'HEAD_MISMATCH', 'PERMISSION_DENIED'];

/** A Stop or Resume that placement refuses (C01 §2.6). Nothing is written. */
export class IntegrityStopError extends Error {
  readonly code: IntegrityStopErrorCode;
  constructor(code: IntegrityStopErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'IntegrityStopError';
    this.code = code;
  }
}

/** A fenced slot has no `owner_slot` row: the transaction is rolled back and the call throws. */
export class FenceSlotMissingError extends Error {
  readonly kind: string;
  readonly slot: SlotNo;
  constructor(kind: string, slot: SlotNo) {
    super(`no owner_slot row for ${kind} slot ${slot}`);
    this.name = 'FenceSlotMissingError';
    this.kind = kind;
    this.slot = slot;
  }
}

/** `StopRequest` of C01 §2.6. */
export interface StopRequest { kind: string; partition: Uint8Array; detectionRef: Uint8Array }

/** `ResumeRequest` of C01 §2.6. */
export interface ResumeRequest {
  kind: string; partition: Uint8Array; detectionRef: Uint8Array; checkpoint: Uint8Array; incidentDecisionRef?: Uint8Array;
}

/** `StopAck` of C01 §2.6. `enforcedAt` is the commit timestamp of the fence transaction. */
export interface StopAck { state: 'STOPPED' | 'RESUMED'; enforcedAt: HlcTs; fencedSlots: SlotNo[] }

/** The caller of a Stop or Resume: its mTLS workload identity. */
export interface IntegrityStopCaller { workload: string }

/** One row of `placement_integrity_stops`, with the I3 columns (fenced slots, resume time, incident decision). */
export interface IntegrityStopRow {
  kind: string;
  partition: Uint8Array;
  detectionRef: Uint8Array;
  state: 'stopped' | 'resumed';
  /** `enforced_at` of the Stop (the column `at`). */
  at: HlcTs;
  checkpoint: Uint8Array | null;
  fencedSlots: SlotNo[];
  resumedAt: HlcTs | null;
  resumeFencedSlots: SlotNo[] | null;
  incidentDecisionRef: Uint8Array | null;
}

/** One row of `placement_partition_moves` (C01 §2.3). */
export interface PartitionMoveRow {
  fromSlot: SlotNo; toSlot: SlotNo; generation: number; state: 'prewarm' | 'moved' | 'adopted' | 'done';
}

/** Reads the move rows of one partition (inside the fence transaction). */
export interface MoveLookup {
  movesOf(kind: string, partition: Uint8Array): Promise<PartitionMoveRow[]>;
}

/** The operations of one Stop or Resume transaction. The store applies the writes only at commit. */
export interface IntegrityStopTx extends MoveLookup {
  /** Every stop row with this detection ref (any kind and partition). */
  rowsByDetectionRef(detectionRef: Uint8Array): Promise<IntegrityStopRow[]>;
  /** The commit timestamp of this transaction (CockroachDB `cluster_logical_timestamp()`). */
  commitTs(): Promise<HlcTs>;
  insertStop(row: IntegrityStopRow): Promise<void>;
  /** Sets the row to `resumed`, with the checkpoint, the resume time, the fenced slots and the incident decision. */
  markResumed(row: IntegrityStopRow): Promise<void>;
  /** Increments `owner_slot.stops_version` of (kind, slot). Throws `FenceSlotMissingError` without the row. */
  bumpStopsVersion(kind: string, slot: SlotNo): Promise<void>;
}

/** The store port of the service: one `transaction` call for each Stop or Resume. */
export interface IntegrityStopStore {
  /** Runs `fn` in one transaction and commits. If `fn` or the commit throws, nothing is applied. */
  transaction<T>(fn: (tx: IntegrityStopTx) => Promise<T>): Promise<T>;
}

/** Gives the slots that hold a partition (C01 §3.2, V59-4): sorted, unique. */
export interface SlotLocator {
  slotsOf(kind: string, partition: Uint8Array, moves: MoveLookup): Promise<SlotNo[]>;
}

/**
 * Gives the head chain of a partition at a timestamp, or now. It stands in for audit's first-seen head
 * (C01 V59-5); C01 §2.3 gives placement no head read.
 */
export interface HeadInspector {
  headChainAt(kind: string, partition: Uint8Array, at: HlcTs | 'present'): Promise<Uint8Array | undefined>;
}

/** Options of `placementSlotLocator`. */
export interface PlacementSlotLocatorOptions {
  /** The slot count of each kind (the fixed map of the kind). */
  slotCounts: Record<string, number>;
  /** The current account slot map (kind 'account'); undefined until the first version. */
  accountMap?: () => SlotMapVersion | undefined;
}

const sortedUnique = (xs: SlotNo[]): SlotNo[] => [...new Set(xs)].sort((a, b) => a - b);

/**
 * The default slot locator (C01 §3.2, V59-4): (a) a move of the partition that is not `done` ⇒ its from and to
 * slots; (b) else the to slot of the latest `done` move; (c) else, for kind 'account' with a map, `slotOfInMap`,
 * with both `s` and `s + n` when `headDecides`; (d) else `slotOfPartition`. Throws `RangeError` for a kind
 * with no slot count.
 */
export function placementSlotLocator(o: PlacementSlotLocatorOptions): SlotLocator {
  return {
    async slotsOf(kind, partition, moves) {
      const rows = await moves.movesOf(kind, partition);
      const open = rows.filter((m) => m.state !== 'done');
      if (open.length > 0) return sortedUnique(open.flatMap((m) => [m.fromSlot, m.toSlot]));
      const done = rows.filter((m) => m.state === 'done').sort((a, b) => b.generation - a.generation)[0];
      if (done) return [done.toSlot];
      const map = kind === 'account' ? o.accountMap?.() : undefined;
      if (map) {
        const a = slotOfInMap(map, partition);
        if (a.headDecides) return sortedUnique([a.slot, a.slot + (map.previousCount ?? map.slotCount)]);
        return [a.slot];
      }
      const n = o.slotCounts[kind];
      if (n === undefined) throw new RangeError(`no slot count for kind ${kind}`);
      return [slotOfPartition(partition, n)];
    },
  };
}

/** Options of `IntegrityStopService`. */
export interface IntegrityStopServiceOptions {
  store: IntegrityStopStore;
  locator: SlotLocator;
  heads: HeadInspector;
  /** The one workload that may call Stop and Resume (C01 §2.6: audit only). Default 'audit'. */
  auditWorkload?: string;
}

const sameTarget = (r: IntegrityStopRow, kind: string, partition: Uint8Array): boolean =>
  r.kind === kind && bytesEqual(r.partition, partition);
function sameOptional(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
  const x = a ?? null;
  const y = b ?? null;
  return x === null || y === null ? x === y : bytesEqual(x, y);
}
const sameHead = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean =>
  a === undefined || b === undefined ? a === b : bytesEqual(a, b);

/** Placement's `IntegrityStop` service (C01 §2.6). */
export class IntegrityStopService {
  private readonly o: IntegrityStopServiceOptions;
  private readonly audit: string;

  constructor(o: IntegrityStopServiceOptions) {
    this.o = o;
    this.audit = o.auditWorkload ?? 'audit';
  }

  /** Stop: write the stop row and fence the holding slot(s) in one transaction; the ack after the commit. */
  async stop(caller: IntegrityStopCaller, req: StopRequest): Promise<StopAck> {
    this.authorise(caller);
    return this.o.store.transaction(async (tx) => {
      const rows = await tx.rowsByDetectionRef(req.detectionRef);
      const other = rows.find((r) => !sameTarget(r, req.kind, req.partition));
      if (other) throw new IntegrityStopError('CONFLICT', `detection_ref ${hex(req.detectionRef)} names ${other.kind} ${hex(other.partition)}`);
      const mine = rows[0];
      // C01 §5: the same Stop gives the same StopAck (the same enforced_at), with no second fence.
      if (mine) return { state: 'STOPPED', enforcedAt: mine.at, fencedSlots: mine.fencedSlots };
      const fencedSlots = await this.o.locator.slotsOf(req.kind, req.partition, tx);
      const at = await tx.commitTs();
      await tx.insertStop({
        kind: req.kind, partition: req.partition, detectionRef: req.detectionRef, state: 'stopped', at, checkpoint: null, fencedSlots,
        resumedAt: null, resumeFencedSlots: null, incidentDecisionRef: null,
      });
      for (const s of fencedSlots) await tx.bumpStopsVersion(req.kind, s);
      return { state: 'STOPPED', enforcedAt: at, fencedSlots };
    });
  }

  /** Resume: after the head check, set the row `resumed` and fence the holding slot(s) in one transaction. */
  async resume(caller: IntegrityStopCaller, req: ResumeRequest): Promise<StopAck> {
    this.authorise(caller);
    return this.o.store.transaction(async (tx) => {
      const rows = await tx.rowsByDetectionRef(req.detectionRef);
      const other = rows.find((r) => !sameTarget(r, req.kind, req.partition));
      if (other) throw new IntegrityStopError('CONFLICT', `detection_ref ${hex(req.detectionRef)} names ${other.kind} ${hex(other.partition)}`);
      const row = rows[0];
      if (!row) throw new IntegrityStopError('NOT_STOPPED', `no stop of ${req.kind} ${hex(req.partition)} with this detection_ref`);
      if (row.state === 'resumed') {
        // C01 §5: the same Resume gives the same StopAck; the same key with another content is CONFLICT.
        if (!sameOptional(row.checkpoint, req.checkpoint) || !sameOptional(row.incidentDecisionRef, req.incidentDecisionRef)) {
          throw new IntegrityStopError('CONFLICT', 'the stop was resumed with another checkpoint or incident decision');
        }
        if (row.resumedAt === null) throw new Error('a resumed stop row has no resumed_at');
        return { state: 'RESUMED', enforcedAt: row.resumedAt, fencedSlots: row.resumeFencedSlots ?? [] };
      }
      if (req.incidentDecisionRef === undefined) {
        // RFC-006 §14.3 step 5: the restored head must be the head as of enforced_at (audit's first-seen head, V59-5).
        const firstSeen = await this.o.heads.headChainAt(req.kind, req.partition, row.at);
        const restored = await this.o.heads.headChainAt(req.kind, req.partition, 'present');
        if (!sameHead(firstSeen, restored)) throw new IntegrityStopError('HEAD_MISMATCH', `restored head of ${req.kind} ${hex(req.partition)} is not the first-seen head`);
      }
      const fencedSlots = await this.o.locator.slotsOf(req.kind, req.partition, tx);
      const at = await tx.commitTs();
      await tx.markResumed({
        ...row, state: 'resumed', checkpoint: req.checkpoint, resumedAt: at, resumeFencedSlots: fencedSlots,
        incidentDecisionRef: req.incidentDecisionRef ?? null,
      });
      for (const s of fencedSlots) await tx.bumpStopsVersion(req.kind, s);
      return { state: 'RESUMED', enforcedAt: at, fencedSlots };
    });
  }

  private authorise(caller: IntegrityStopCaller): void {
    if (caller.workload !== this.audit) throw new IntegrityStopError('PERMISSION_DENIED', `workload ${caller.workload} may not call IntegrityStop`);
  }
}

// ---------------- in-memory store ----------------

const stopKey = (r: { kind: string; partition: Uint8Array; detectionRef: Uint8Array }): string =>
  `${r.kind}|${hex(r.partition)}|${hex(r.detectionRef)}`;
const copyRow = (r: IntegrityStopRow): IntegrityStopRow => ({
  ...r, fencedSlots: [...r.fencedSlots], resumeFencedSlots: r.resumeFencedSlots === null ? null : [...r.resumeFencedSlots],
});

/**
 * An `IntegrityStopStore` over a `MemoryStore` (unit tests). It keeps its own stop rows and move rows. At commit it
 * applies the row writes, sets or deletes `store.stops` (the runtime's read of open stops) and increments
 * `stopsVersion` of the fenced slots in `store.slots`. The commit timestamp comes from `store.nowTs()`.
 */
export class MemoryIntegrityStopStore implements IntegrityStopStore {
  /** The stop rows by `kind|hex(partition)|hex(detectionRef)`. */
  readonly rows = new Map<string, IntegrityStopRow>();
  /** The rows of `placement_partition_moves`, by `kind|hex(partition)`. */
  readonly moves = new Map<string, PartitionMoveRow[]>();
  /** Committed transactions. */
  commits = 0;
  /** The next commit throws and applies nothing. */
  failNextCommit = false;
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async transaction<T>(fn: (tx: IntegrityStopTx) => Promise<T>): Promise<T> {
    const writes: IntegrityStopRow[] = [];
    const bumps: Array<{ kind: string; slot: SlotNo }> = [];
    let ts: HlcTs | undefined;
    const tx: IntegrityStopTx = {
      movesOf: async (kind, partition) => (this.moves.get(`${kind}|${hex(partition)}`) ?? []).map((m) => ({ ...m })),
      rowsByDetectionRef: async (ref) => [...this.rows.values()].filter((r) => bytesEqual(r.detectionRef, ref)).map(copyRow),
      commitTs: async () => { ts ??= this.store.nowTs(); return ts; },
      insertStop: async (row) => { writes.push(copyRow(row)); },
      markResumed: async (row) => { writes.push(copyRow(row)); },
      bumpStopsVersion: async (kind, slot) => {
        if (!this.store.slots.has(`${kind}|${slot}`)) throw new FenceSlotMissingError(kind, slot);
        bumps.push({ kind, slot });
      },
    };
    const value = await fn(tx);
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error('commit failed (injected)');
    }
    for (const w of writes) this.rows.set(stopKey(w), w);
    for (const w of writes) this.syncOpenStop(w.kind, w.partition);
    for (const b of bumps) {
      const r = this.store.slots.get(`${b.kind}|${b.slot}`);
      if (r) r.stopsVersion += 1n;
    }
    if (writes.length > 0 || bumps.length > 0) this.commits += 1;
    return value;
  }

  /** Sets `store.stops` to an open stop of the partition, or deletes it when none is open. */
  private syncOpenStop(kind: string, partition: Uint8Array): void {
    const key = `${kind}|${hex(partition)}`;
    const open = [...this.rows.values()].find((r) => r.state === 'stopped' && sameTarget(r, kind, partition));
    if (open) this.store.stops.set(key, open.detectionRef);
    else this.store.stops.delete(key);
  }
}
