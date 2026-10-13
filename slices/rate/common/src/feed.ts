/**
 * Ordered, idempotent consumption of one feed (C01 §3.5, CC-6).
 *
 * For each key (for example the producer partition and stream), the cursor applies events in
 * sequence order. It drops an event at or below the last applied sequence. It keeps an event
 * above the next sequence until the gap is filled. A copy of a sequence it holds with
 * different bytes is a content conflict: the cursor blocks that key and reports it.
 */
import { createHash } from 'node:crypto';
import type { FeedEvent } from '@share/owner-runtime';

export function eventDigest(e: FeedEvent): string {
  return createHash('sha256').update(e.value).digest('hex');
}

/** The checkpoint that an owner records in the applying append (C01 §3.5). */
export interface FeedCheckpointRecord { key: string; seq: string; digest: string }

export class FeedCursor<T> {
  private readonly last = new Map<string, bigint>();
  private readonly pending = new Map<string, Map<bigint, { item: T; digest: string }>>();
  private readonly applied = new Map<string, Map<bigint, string>>();
  readonly conflicts: Array<{ key: string; seq: bigint }> = [];
  private readonly blocked = new Set<string>();

  /** The last applied sequence of a key (0 if none). */
  position(key: string): bigint {
    return this.last.get(key) ?? 0n;
  }

  /** Set the position when the owner rebuilds its state (for example from its log). */
  restore(key: string, seq: bigint): void {
    this.last.set(key, seq);
  }

  /**
   * Offer an event. Returns the events that are now ready to apply, in order. The caller
   * applies each one, then calls `commit` for it.
   */
  offer(key: string, seq: bigint, item: T, digest: string): Array<{ seq: bigint; item: T; digest: string }> {
    const seen = this.applied.get(key)?.get(seq) ?? this.pending.get(key)?.get(seq)?.digest;
    if (seen !== undefined && seen !== digest) {
      this.conflicts.push({ key, seq });
      this.blocked.add(key);
      return [];
    }
    if (this.blocked.has(key)) return [];
    if (seq <= this.position(key)) return [];
    let p = this.pending.get(key);
    if (!p) { p = new Map(); this.pending.set(key, p); }
    p.set(seq, { item, digest });
    const ready: Array<{ seq: bigint; item: T; digest: string }> = [];
    let next = this.position(key) + 1n;
    while (p.has(next)) {
      const x = p.get(next);
      if (!x) break;
      ready.push({ seq: next, ...x });
      next += 1n;
    }
    return ready;
  }

  /** Mark an event applied (after its append committed). */
  commit(key: string, seq: bigint, digest: string): void {
    this.pending.get(key)?.delete(seq);
    if (seq > this.position(key)) this.last.set(key, seq);
    let a = this.applied.get(key);
    if (!a) { a = new Map(); this.applied.set(key, a); }
    a.set(seq, digest);
  }

  /** True if an event of the key waits for a gap to fill (or for its own apply). */
  hasPending(key?: string): boolean {
    if (key !== undefined) return (this.pending.get(key)?.size ?? 0) > 0;
    for (const p of this.pending.values()) if (p.size > 0) return true;
    return false;
  }

  /** True after a content conflict on the key. An event that the caller did not commit stays pending. */
  isBlocked(key: string): boolean {
    return this.blocked.has(key);
  }
}

/** Run async work one at a time, in order (the serial state machine of one owner process). */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private count = 0;

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.count += 1;
    const p = this.tail.then(fn, fn);
    this.tail = p.then(() => { this.count -= 1; }, () => { this.count -= 1; });
    return p;
  }

  /** Resolves when the queue has no work. */
  async idle(): Promise<void> {
    while (this.count > 0) await this.tail;
  }
}
