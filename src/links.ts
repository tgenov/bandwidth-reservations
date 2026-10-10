// One link's schedule with holds (D14). Two trees:
//
//   confirmed : confirmed reservations only
//   total     : confirmed + held
//
// A request has three outcomes:
//   fits on total            -> hold it
//   misses even on confirmed -> reject, with the exact conflicting minutes
//   otherwise                -> it fits only if some holds release: wait
//
// Collisions between sagas use wound-wait on priority tickets (D17): an older
// request revokes younger, unpinned holds in its way; a younger request waits.
// Waits only ever point from younger to older, so they cannot form a cycle.
//
// Pinned holds belong to a saga that has made its commit decision. They are
// never wounded and never expire: the saga must roll forward, not back.

import { UsageTree, checkWindow } from './tree.ts';

export type Ticket = readonly [startedAtMs: number, sagaId: number];

export const older = (a: Ticket, b: Ticket) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

export type Hold = {
  key: string;
  sagaId: number;
  ticket: Ticket;
  s: number;
  e: number | null;
  mbps: number;
  expiresAt: number;
  pinned: boolean;
};

export type HoldRequest = Omit<Hold, 'expiresAt' | 'pinned'>;

export type HoldOutcome =
  | { kind: 'held' }
  | { kind: 'reject'; peak: number; conflicts: Array<[number, number]> }
  | { kind: 'wait'; blockers: number[] };

type Options = { woundWait?: boolean; clock?: () => number };

export class LinkBook {
  readonly confirmed: UsageTree;
  readonly total: UsageTree;
  readonly holds = new Map<string, Hold>();
  onWound: (sagaId: number) => void = () => {};
  private waiters: Array<() => void> = [];
  private woundWait: boolean;
  private clock: () => number;

  readonly id: number;
  readonly capacity: number;

  constructor(id: number, capacity: number, n: number, opts: Options = {}) {
    this.id = id;
    this.capacity = capacity;
    this.confirmed = new UsageTree(n);
    this.total = new UsageTree(n);
    this.woundWait = opts.woundWait ?? true;
    this.clock = opts.clock ?? Date.now;
  }

  private end(e: number | null) {
    return e ?? this.total.n;
  }

  private overlaps(h: Hold, s: number, e: number | null) {
    return h.s < this.end(e) && this.end(h.e) > s;
  }

  // Idempotent by key: asking again for a hold you already have is a no-op.
  tryHold(r: HoldRequest, ttlMs: number): HoldOutcome {
    checkWindow(r.s, r.e, this.total.n);
    this.expire();
    if (this.holds.has(r.key)) return { kind: 'held' };
    const end = this.end(r.e);
    const confirmedPeak = this.confirmed.peak(r.s, end);
    if (confirmedPeak + r.mbps > this.capacity) {
      return {
        kind: 'reject',
        peak: confirmedPeak,
        conflicts: this.confirmed.conflicts(r.s, end, this.capacity - r.mbps),
      };
    }
    if (this.total.peak(r.s, end) + r.mbps > this.capacity && this.woundWait) {
      const victims = [...this.holds.values()].filter(
        (h) => !h.pinned && h.sagaId !== r.sagaId && older(r.ticket, h.ticket) && this.overlaps(h, r.s, r.e),
      );
      for (const sagaId of new Set(victims.map((h) => h.sagaId))) this.wound(sagaId);
    }
    if (this.total.peak(r.s, end) + r.mbps <= this.capacity) {
      this.holds.set(r.key, { ...r, expiresAt: this.clock() + ttlMs, pinned: false });
      this.total.add(r.s, r.e, r.mbps);
      return { kind: 'held' };
    }
    const blockers = [...this.holds.values()]
      .filter((h) => h.sagaId !== r.sagaId && this.overlaps(h, r.s, r.e))
      .map((h) => h.sagaId);
    return { kind: 'wait', blockers: [...new Set(blockers)] };
  }

  // Revoke every unpinned hold of a saga on this link and tell its coordinator.
  private wound(sagaId: number): void {
    for (const h of [...this.holds.values()]) if (h.sagaId === sagaId && !h.pinned) this.drop(h);
    this.onWound(sagaId);
    this.notify();
  }

  has(key: string): boolean {
    this.expire();
    return this.holds.has(key);
  }

  // The commit decision for this hold: from now on it neither expires nor is wounded.
  pin(key: string): boolean {
    this.expire();
    const h = this.holds.get(key);
    if (!h) return false;
    h.pinned = true;
    return true;
  }

  // Hold becomes a confirmed reservation. Total usage does not change.
  confirm(key: string): void {
    const h = this.holds.get(key);
    if (!h) throw new Error(`confirm: no hold ${key} on link ${this.id}`);
    this.holds.delete(key);
    this.confirmed.add(h.s, h.e, h.mbps);
    this.notify(); // waiters re-check: they may now be a definitive reject
  }

  // Load a confirmed reservation directly (recovery from the facts).
  addConfirmed(s: number, e: number | null, mbps: number): void {
    this.confirmed.add(s, e, mbps);
    this.total.add(s, e, mbps);
  }

  // Load a hold directly (recovery), keeping its original expiry.
  restoreHold(h: Hold): void {
    this.holds.set(h.key, h);
    this.total.add(h.s, h.e, h.mbps);
  }

  // Idempotent: releasing a hold that is gone (released, expired, wounded) is a no-op.
  release(key: string): void {
    const h = this.holds.get(key);
    if (!h) return;
    this.drop(h);
    this.notify();
  }

  private drop(h: Hold): void {
    this.holds.delete(h.key);
    this.total.add(h.s, h.e, -h.mbps);
  }

  expire(): void {
    const now = this.clock();
    let freed = false;
    for (const h of [...this.holds.values()]) {
      if (!h.pinned && h.expiresAt <= now) {
        this.drop(h);
        freed = true;
      }
    }
    if (freed) this.notify();
  }

  // Earliest expiry among unpinned holds, so a waiter knows when to look again.
  nextExpiry(): number {
    let next = Infinity;
    for (const h of this.holds.values()) if (!h.pinned) next = Math.min(next, h.expiresAt);
    return next;
  }

  // Resolves at the next release, expiry or wound. Waiters are woken in the
  // order they started waiting (FIFO), and each re-checks synchronously.
  changed(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private notify(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  // Never oversold: peak of confirmed + held over the whole horizon.
  peakUsage(): number {
    return Math.max(0, this.total.peak(0, this.total.n));
  }
}
