import { randomUUID } from 'node:crypto';
import type { MonotonicNs } from './api.ts';
import { PARAMS, type SessionTimings } from './params.ts';
import type { OwnerStore } from './store/types.ts';

export function sessionShard(sessionId: string): number {
  return parseInt(sessionId.replace(/-/g, '').slice(0, 4), 16) % PARAMS.sessionShards;
}

const ms = (n: number): bigint => BigInt(Math.round(n * 1e6));

export interface SessionEvents {
  /** The renewal updated no row: the session was revoked (RFC-006 §4.2) ⇒ re-home. */
  onRevoked(): Promise<void>;
  /** A renewal succeeded after the holder's view ended ⇒ resume (C01 §3.1 steps 1–4). */
  onResume(): Promise<void>;
  /** Called after each renew tick (the runtime tries to acquire wanted slots there). */
  onTick(): Promise<void>;
}

/**
 * The process's owner_session (C01 §3.1): renewal every 500 ms to now() + 3 s, holder's view
 * t_send + session_ttl − ε by the monotonic clock; leaseLive false from max_loop_delay before its end.
 */
export class Session {
  sessionId: string;
  shard: number;
  private viewEnd: MonotonicNs = 0n;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private busy = false;
  private readonly store: OwnerStore;
  private readonly t: SessionTimings;
  private readonly meta: { host: string; region: string; facility: string; kind: string };
  private readonly events: SessionEvents;

  constructor(store: OwnerStore, timings: SessionTimings, meta: { host: string; region: string; facility: string; kind: string }, events: SessionEvents) {
    this.store = store;
    this.t = timings;
    this.meta = meta;
    this.events = events;
    this.sessionId = randomUUID();
    this.shard = sessionShard(this.sessionId);
  }

  /** Insert a new session row (never reused); the view starts at the send. */
  async open(): Promise<void> {
    this.sessionId = randomUUID();
    this.shard = sessionShard(this.sessionId);
    const tSend = process.hrtime.bigint();
    await this.store.insertSession({ shard: this.shard, sessionId: this.sessionId, ttlMs: this.t.sessionTtlMs, ...this.meta });
    this.viewEnd = tSend + ms(this.t.holderViewMs);
  }

  start(): void {
    this.stopped = false;
    this.schedule(this.t.sessionRenewMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** C01 §3.1, R47-23: false from max_loop_delay before the end of the holder's view. */
  leaseLive(): boolean {
    return process.hrtime.bigint() < this.viewEnd - ms(this.t.maxLoopDelayMs);
  }

  viewEndsAt(): MonotonicNs {
    return this.viewEnd;
  }

  /** Test hook: end the view now (as if renewals stopped arriving). */
  expireViewForTest(): void {
    this.viewEnd = 0n;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.busy = true;
    let next = this.t.sessionRenewMs;
    try {
      const tSend = process.hrtime.bigint();
      let ok: boolean;
      try {
        ok = await this.store.renewSession(this.shard, this.sessionId, this.t.sessionTtlMs);
      } catch {
        next = this.t.renewRetryMs;     // C01 §7: renewal retried every 100 ms on error
        return;
      }
      if (!ok) {
        await this.events.onRevoked();
      } else if (process.hrtime.bigint() <= this.viewEnd) {
        this.viewEnd = tSend + ms(this.t.holderViewMs);
      } else {
        // The success arrived after the view ended: a resume, not an ordinary renewal (RFC-006 §4.2).
        await this.events.onResume();
        this.viewEnd = tSend + ms(this.t.holderViewMs);
      }
      await this.events.onTick();
    } catch {
      next = this.t.renewRetryMs;
    } finally {
      this.busy = false;
      this.schedule(next);
    }
  }
}
