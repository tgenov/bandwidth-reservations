/**
 * Placement's side of the move protocol (C01 §3.3 steps 1 and 7; RFC-006 §4.5; plan S-PLAT-I3 work items 1 and 5).
 *
 * `MoveCoordinator.move` records the `placement_partition_moves` row (state `prewarm`, generation g + 1), asks B's
 * holder to pre-warm the partition (step 2), asks A's holder to append `moved` (step 3, state `moved`), asks B's holder
 * to adopt after the report fence (steps 4 to 6, state `adopted`), then publishes the routing and marks the move `done`
 * (step 7). A partition `Moving` for more than `move_cutover_max` (1 s) raises `MOVE_CUTOVER` (a page).
 * `HotPartitionDetector` is the trigger of a hot-link move: above 200 requests a second for 10 min.
 */
import type { AppendResult, Generation, OwnerKind, PartitionKey, SlotNo } from '../api.ts';
import { hex } from '../bytes.ts';
import type { PartitionMoveRow } from './integrity-stop.ts';

/** C01 §7: `Moving` beyond this pages (`MOVE_CUTOVER`). */
export const MOVE_CUTOVER_MAX_MS = 1_000;

/** RFC-006 §4.1: a link above this request rate for `HOT_WINDOW_MS` moves to a dedicated slot. */
export const HOT_RATE_PER_S = 200;
export const HOT_WINDOW_MS = 10 * 60_000;

/** One move: the partition of a kind from slot A to slot B. */
export interface MoveRequest { kind: OwnerKind; partition: PartitionKey; from: SlotNo; to: SlotNo }

/** The holders of A and B, as placement reaches them (gRPC in production, in process in tests). */
export interface MoveHolders {
  /** Step 2 at B's holder (`prepareAdopt`). */
  prepare(m: MoveRequest & { generation: Generation }): Promise<void>;
  /** Step 3 at A's holder (`moveOut`). */
  moveOut(m: MoveRequest & { generation: Generation }): Promise<AppendResult>;
  /** Steps 4 to 6 at B's holder (`adopt`). */
  adopt(m: MoveRequest & { generation: Generation }): Promise<AppendResult>;
}

/** The store of `placement_partition_moves` (C01 §2.3). */
export interface MoveStore {
  movesOf(kind: string, partition: Uint8Array): Promise<PartitionMoveRow[]>;
  insert(kind: string, partition: Uint8Array, row: PartitionMoveRow): Promise<void>;
  setState(kind: string, partition: Uint8Array, generation: number, state: PartitionMoveRow['state']): Promise<void>;
}

/** An in-memory `placement_partition_moves`; `rows` may be shared with `MemoryIntegrityStopStore.moves`. */
export class MemoryMoveStore implements MoveStore {
  readonly rows: Map<string, PartitionMoveRow[]>;
  constructor(rows: Map<string, PartitionMoveRow[]> = new Map()) {
    this.rows = rows;
  }
  async movesOf(kind: string, partition: Uint8Array): Promise<PartitionMoveRow[]> {
    return (this.rows.get(`${kind}|${hex(partition)}`) ?? []).map((r) => ({ ...r }));
  }
  async insert(kind: string, partition: Uint8Array, row: PartitionMoveRow): Promise<void> {
    const k = `${kind}|${hex(partition)}`;
    const list = this.rows.get(k) ?? [];
    if (list.some((r) => r.generation === row.generation)) throw new MoveError('DUPLICATE', `move of generation ${row.generation} exists`);
    this.rows.set(k, [...list, { ...row }]);
  }
  async setState(kind: string, partition: Uint8Array, generation: number, state: PartitionMoveRow['state']): Promise<void> {
    const r = (this.rows.get(`${kind}|${hex(partition)}`) ?? []).find((x) => x.generation === generation);
    if (!r) throw new MoveError('NO_MOVE', `no move of generation ${generation}`);
    r.state = state;
  }
}

/** The refusal codes of a move. */
export type MoveErrorCode = 'OPEN_MOVE' | 'MOVED_REFUSED' | 'ADOPT_REFUSED' | 'DUPLICATE' | 'NO_MOVE';

/** A move that cannot go on; `result` is the holder's answer when a step was refused. */
export class MoveError extends Error {
  readonly code: MoveErrorCode;
  readonly result: AppendResult | undefined;
  constructor(code: MoveErrorCode, message: string, result?: AppendResult) {
    super(`${code}: ${message}`);
    this.name = 'MoveError';
    this.code = code;
    this.result = result;
  }
}

/** The `MOVE_CUTOVER` alert (C01 §2.10 fields that placement fills; the episode is placement's log entry). */
export interface MoveCutoverAlert {
  alertKind: 'MOVE_CUTOVER'; severity: 'page'; reasonCode: 'MOVING_OVER_MAX';
  entities: Array<{ type: string; id: Uint8Array }>;
  detail: { kind: string; from: number; to: number; generation: number; maxMs: number };
}

/** A one-shot timer (injected: tests fire it by hand). */
export interface Scheduler { schedule(ms: number, fn: () => void): { cancel(): void } }

const realScheduler: Scheduler = {
  schedule(ms, fn) { const t = setTimeout(fn, ms); t.unref(); return { cancel: () => clearTimeout(t) }; },
};

export interface MoveCoordinatorOptions {
  store: MoveStore;
  holders: MoveHolders;
  /** Step 7: publish routing (for accounts, the slot-map version is the slot map service's). */
  publishRouting?: (m: MoveRequest & { generation: Generation }) => Promise<void>;
  alert?: (a: MoveCutoverAlert) => void;
  scheduler?: Scheduler;
  cutoverMaxMs?: number;
}

/** Placement's driver of the move protocol (C01 §3.3). */
export class MoveCoordinator {
  private readonly o: MoveCoordinatorOptions;
  constructor(o: MoveCoordinatorOptions) {
    this.o = o;
  }

  /**
   * Moves the partition from `from` to `to` with generation g + 1 (g: the last move's generation, 0 before any).
   * Refuses a partition that has a move not `done` (`OPEN_MOVE`). When A refuses `moved` the row stays `prewarm`
   * (`MOVED_REFUSED`); when B refuses `adopt` (for example `Stopped`) the row stays `moved`, so a stop keeps both slots
   * fenced, and `ADOPT_REFUSED` carries B's answer; `resume` continues it.
   */
  async move(req: MoveRequest): Promise<{ generation: Generation }> {
    const rows = await this.o.store.movesOf(req.kind, req.partition);
    if (rows.some((r) => r.state !== 'done')) throw new MoveError('OPEN_MOVE', `${req.kind} partition ${hex(req.partition)} has a move in progress`);
    const generation = rows.reduce((g, r) => Math.max(g, r.generation), 0) + 1;
    const m = { ...req, generation };
    await this.o.store.insert(req.kind, req.partition, { fromSlot: req.from, toSlot: req.to, generation, state: 'prewarm' });
    await this.o.holders.prepare(m);
    const moved = await this.o.holders.moveOut(m);
    if (moved.r !== 'Committed') throw new MoveError('MOVED_REFUSED', `A answered ${moved.r}`, moved);
    await this.o.store.setState(req.kind, req.partition, generation, 'moved');
    await this.finish(m);
    return { generation };
  }

  /** Continues a move whose `adopt` was refused (the row is `moved`), for example after the stop was resumed. */
  async resume(kind: string, partition: Uint8Array): Promise<{ generation: Generation }> {
    const open = (await this.o.store.movesOf(kind, partition)).find((r) => r.state === 'moved' || r.state === 'adopted');
    if (!open) throw new MoveError('NO_MOVE', `no move of ${kind} partition ${hex(partition)} to continue`);
    const m = { kind, partition, from: open.fromSlot, to: open.toSlot, generation: open.generation };
    if (open.state === 'moved') await this.finish(m);
    else { await this.o.publishRouting?.(m); await this.o.store.setState(kind, partition, m.generation, 'done'); }
    return { generation: open.generation };
  }

  private async finish(m: MoveRequest & { generation: Generation }): Promise<void> {
    const maxMs = this.o.cutoverMaxMs ?? MOVE_CUTOVER_MAX_MS;
    const watchdog = (this.o.scheduler ?? realScheduler).schedule(maxMs, () => {
      this.o.alert?.({ alertKind: 'MOVE_CUTOVER', severity: 'page', reasonCode: 'MOVING_OVER_MAX',
        entities: [{ type: m.kind, id: m.partition }], detail: { kind: m.kind, from: m.from, to: m.to, generation: m.generation, maxMs } });
    });
    let adopted: AppendResult;
    try {
      adopted = await this.o.holders.adopt(m);
    } finally {
      watchdog.cancel();
    }
    if (adopted.r !== 'Committed') throw new MoveError('ADOPT_REFUSED', `B answered ${adopted.r}`, adopted);
    await this.o.store.setState(m.kind, m.partition, m.generation, 'adopted');
    await this.o.publishRouting?.(m);
    await this.o.store.setState(m.kind, m.partition, m.generation, 'done');
  }
}

/**
 * The hot-link trigger (RFC-006 §4.1, §4.5): a partition whose request rate stays above `ratePerS` (200) over a full
 * window of `windowMs` (10 min) is reported once, until its rate falls back. Counts are kept per second.
 */
export class HotPartitionDetector {
  private readonly ratePerS: number;
  private readonly windowS: number;
  private readonly seconds = new Map<string, Map<number, number>>();
  private readonly firstSeen = new Map<string, number>();
  private readonly reported = new Set<string>();

  constructor(o: { ratePerS?: number; windowMs?: number } = {}) {
    this.ratePerS = o.ratePerS ?? HOT_RATE_PER_S;
    this.windowS = Math.round((o.windowMs ?? HOT_WINDOW_MS) / 1_000);
  }

  /** Counts `n` requests of the partition at `atMs` (the caller's clock). */
  record(partition: Uint8Array, atMs: number, n = 1): void {
    const k = hex(partition);
    const sec = Math.floor(atMs / 1_000);
    let m = this.seconds.get(k);
    if (!m) { m = new Map(); this.seconds.set(k, m); this.firstSeen.set(k, sec); }
    m.set(sec, (m.get(sec) ?? 0) + n);
  }

  /**
   * The partitions to move now: each partition whose rate over the last full window before `nowMs` is above the
   * limit, once. A partition whose rate falls to the limit or below may be reported again later.
   */
  due(nowMs: number): string[] {
    const end = Math.floor(nowMs / 1_000);          // the window is [end − windowS, end)
    const start = end - this.windowS;
    const out: string[] = [];
    for (const [k, m] of this.seconds) {
      for (const s of [...m.keys()]) if (s < start) m.delete(s);
      let total = 0;
      for (const [s, c] of m) if (s >= start && s < end) total += c;
      const full = (this.firstSeen.get(k) ?? end) <= start;
      const hot = full && total > this.ratePerS * this.windowS;
      if (hot && !this.reported.has(k)) { this.reported.add(k); out.push(k); }
      if (!hot) this.reported.delete(k);
    }
    return out;
  }
}
