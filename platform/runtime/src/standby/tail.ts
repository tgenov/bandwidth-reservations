/**
 * The memory feed of a hot standby (RFC-006 §4.4; plan S-PLAT-I2 work item 2).
 *
 * The holder pushes every `Committed` batch of a slot to its hot standbys, without waiting for an answer.
 * A push carries the batch's rows, its `ts`, and `prevTs`: the `ts` of the slot's previous pushed batch (or
 * the holder's catch-up read after its acquisition), and `advances`: false while another lane of the slot had a
 * batch in flight (its ts can be lower). A push applies when its rows continue each partition's `seq` (rows at
 * or below the applied seq are skipped); otherwise it waits in a buffer for the follower-read tail (every
 * `standby_poll`, 250 ms), which is the backstop. So the standby never applies a row twice or out of order,
 * and a lost push costs at most one poll plus the follower-read lag.
 *
 * Per slot the standby also keeps `complete`: every row of the slot with ts ≤ complete is applied. The tail
 * sets it to its read timestamp; an applied push with `advances` and `prevTs ≤ complete` moves it to the
 * push's ts. A takeover reads at the present only the rows above `complete` (the catch-up).
 */
import type { HlcTs, SlotNo } from '../api.ts';
import { hex } from '../bytes.ts';
import { compareHlc } from '../hlc.ts';
import type { LogRowWrite } from '../store/types.ts';

/** One pushed batch (RFC-006 §4.4: entries, seq range, ts). */
export interface StandbyPush {
  kind: string;
  slot: SlotNo;
  epoch: bigint;
  ts: HlcTs;
  /** ts of the slot's previous pushed batch, or the holder's catch-up read after its acquisition. */
  prevTs: HlcTs;
  /** False while another lane of the slot had a batch in flight: then no batch is known to lie below `ts` unpushed. */
  advances: boolean;
  rows: LogRowWrite[];
}

/** The holder → standby push channel: `GrpcStandbyChannel` between processes (`grpc.ts`), or the standby's own channel in process. */
export interface StandbyChannel {
  push(p: StandbyPush): void;
}

export type TailRow = LogRowWrite & { ts: HlcTs };

/** Counts for tests and metrics. */
export interface StandbyStats {
  pushes: number; pushedRows: number; pushesBuffered: number; pushesDropped: number;
  tailRows: number; catchUpRows: number;
}

/** Maximum buffered pushes per slot before the oldest is dropped (the tail covers it). */
export const STANDBY_BUFFER_MAX = 10_000;

export class StandbyTail {
  /** hex(partition) → last applied seq. */
  private readonly applied = new Map<string, bigint>();
  /** slot → every row of the slot with ts ≤ this is applied. */
  private readonly complete = new Map<SlotNo, HlcTs>();
  private readonly buffer = new Map<SlotNo, StandbyPush[]>();
  /** slot → applied advancing pushes above `complete`, as (prevTs, ts) links of the holder's chain. */
  private readonly links = new Map<SlotNo, Array<{ prevTs: HlcTs; ts: HlcTs }>>();
  private readonly onRows: (rows: TailRow[]) => void;
  readonly stats: StandbyStats = { pushes: 0, pushedRows: 0, pushesBuffered: 0, pushesDropped: 0, tailRows: 0, catchUpRows: 0 };

  /** `onRows` applies rows to the owner's memory, in order. */
  constructor(onRows: (rows: TailRow[]) => void) {
    this.onRows = onRows;
  }

  /** The position up to which the slot's rows are all applied (undefined before the first tail). */
  completeThrough(slot: SlotNo): HlcTs | undefined {
    return this.complete.get(slot);
  }

  appliedSeq(partition: Uint8Array): bigint {
    return this.applied.get(hex(partition)) ?? 0n;
  }

  /** A push from the holder. Applied now if it continues, else buffered for the tail. */
  push(p: StandbyPush): void {
    this.stats.pushes += 1;
    if (!this.tryPush(p)) {
      const b = this.buffer.get(p.slot) ?? [];
      b.push(p);
      if (b.length > STANDBY_BUFFER_MAX) { b.shift(); this.stats.pushesDropped += 1; }
      this.buffer.set(p.slot, b);
      this.stats.pushesBuffered += 1;
    }
  }

  /**
   * Rows read by the tail (or the takeover catch-up) for `slots`, complete through `through`: every row of
   * those slots with ts ≤ through is in `rows` or was applied before. Returns the number of rows applied.
   */
  tail(slots: SlotNo[], rows: TailRow[], through: HlcTs, catchUp = false): number {
    const fresh = rows.filter((r) => r.seq > this.appliedSeq(r.partition));
    const applied = this.applyRows(fresh);
    this.stats.tailRows += applied;
    if (catchUp) this.stats.catchUpRows += applied;
    for (const s of slots) {
      const cur = this.complete.get(s);
      if (cur === undefined || compareHlc(through, cur) > 0) this.complete.set(s, through);
      this.drain(s);
      this.fold(s);
    }
    return applied;
  }

  private tryPush(p: StandbyPush): boolean {
    const c = this.complete.get(p.slot);
    if (c !== undefined && compareHlc(p.ts, c) <= 0) return true;    // the tail already applied it
    const rows = p.rows.map((r) => ({ ...r, ts: p.ts })).filter((r) => r.seq > this.appliedSeq(r.partition));
    const next = new Map<string, bigint>();
    for (const r of rows) {
      const k = hex(r.partition);
      const want = (next.get(k) ?? this.applied.get(k) ?? 0n) + 1n;
      if (r.seq !== want) return false;           // seq does not continue: wait for the tail
      next.set(k, r.seq);
    }
    this.stats.pushedRows += this.applyRows(rows);
    if (p.advances) {
      this.links.set(p.slot, [...(this.links.get(p.slot) ?? []), { prevTs: p.prevTs, ts: p.ts }]);
      this.fold(p.slot);
    }
    return true;
  }

  /** Moves `complete` along the chain of applied pushes: a link whose prevTs ≤ complete leaves no gap below its ts. */
  private fold(slot: SlotNo): void {
    let links = this.links.get(slot) ?? [];
    for (let moved = true; moved;) {
      moved = false;
      const c = this.complete.get(slot);
      if (c === undefined) return;
      links = links.filter((l) => compareHlc(l.ts, c) > 0);
      const next = links.filter((l) => compareHlc(l.prevTs, c) <= 0).sort((a, b) => compareHlc(b.ts, a.ts))[0];
      if (next) { this.complete.set(slot, next.ts); moved = true; }
    }
    this.links.set(slot, links);
  }

  private drain(slot: SlotNo): void {
    const b = this.buffer.get(slot);
    if (!b) return;
    b.sort((x, y) => compareHlc(x.ts, y.ts));
    const keep: StandbyPush[] = [];
    for (const p of b) {
      const c = this.complete.get(slot);
      if (c !== undefined && compareHlc(p.ts, c) <= 0) continue;   // covered by the tail
      if (!this.tryPush(p)) keep.push(p);
    }
    this.buffer.set(slot, keep);
  }

  private applyRows(rows: TailRow[]): number {
    if (rows.length === 0) return 0;
    for (const r of rows) this.applied.set(hex(r.partition), r.seq);
    this.onRows(rows);
    return rows.length;
  }
}
