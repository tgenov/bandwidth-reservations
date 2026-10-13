/**
 * Gateway tiers (RFC-006 §4.7; C01 §7; plan S-PLAT-I2 work item 7).
 *
 * A process has a pool per tier of SQL gateways: its own facility's, then the metro's other facility's, then
 * the other Kenyan region's. The session renewal, the batch's epoch (fence) read and the standby's session
 * poll each have a per-tier timeout of 400 ms: a statement that does not answer in time on one tier is
 * tried on the next. A per-tier circuit breaker opens after 3 consecutive per-tier timeouts, or on an outside
 * signal (BFD loss of the metro link, placement's "metro split"); while it is open, work starts at the next
 * live tier.
 *
 * RFC-006 does not say when an open breaker closes. Here it is half-open after `openMs` (10 s, est.): the tier
 * is first again, and one more timeout opens it again (see STATUS-I2.md).
 */
import { systemClock, type WallClock } from '../clock.ts';
import { PARAMS } from '../params.ts';

/** A statement did not answer within its per-tier timeout. */
export class TierTimeout extends Error {
  readonly tier: number;
  constructor(tier: number, ms: number) {
    super(`gateway tier ${tier} did not answer within ${ms} ms`);
    this.name = 'TierTimeout';
    this.tier = tier;
  }
}

export interface GatewayTiersOptions {
  /** Consecutive per-tier timeouts that open a tier's breaker (C01 §7: 3). */
  breakerAfter?: number;
  /** How long an open breaker stays open before the tier is tried again (est.). */
  openMs?: number;
  wallMs?: WallClock;
}

interface TierState { timeouts: number; openUntil: number }

/** Breaker state of each tier, and the order in which to try them. */
export class GatewayTiers {
  readonly count: number;
  private readonly s: TierState[];
  private readonly after: number;
  private readonly openMs: number;
  private readonly wallMs: WallClock;
  /** Every tier change, for tests and metrics. */
  readonly events: Array<{ tier: number; event: 'timeout' | 'open' | 'halfOpen' | 'success' }> = [];

  constructor(count: number, o: GatewayTiersOptions = {}) {
    if (count < 1) throw new Error('at least one gateway tier');
    this.count = count;
    this.s = Array.from({ length: count }, () => ({ timeouts: 0, openUntil: 0 }));
    this.after = o.breakerAfter ?? 3;
    this.openMs = o.openMs ?? 10_000;
    this.wallMs = o.wallMs ?? systemClock;
  }

  /** True while the tier's breaker is open. */
  isOpen(tier: number): boolean {
    const t = this.s[tier];
    if (!t || t.openUntil === 0) return false;
    if (this.wallMs() < t.openUntil) return true;
    // Half-open: tried first again; one more timeout opens it again.
    t.openUntil = 0;
    t.timeouts = this.after - 1;
    this.events.push({ tier, event: 'halfOpen' });
    return false;
  }

  /** Live tiers in tier order, then open ones (so work goes on when every breaker is open). */
  order(): number[] {
    const all = Array.from({ length: this.count }, (_, i) => i);
    return [...all.filter((i) => !this.isOpen(i)), ...all.filter((i) => this.isOpen(i))];
  }

  success(tier: number): void {
    const t = this.s[tier];
    if (!t) return;
    if (t.timeouts > 0) this.events.push({ tier, event: 'success' });
    t.timeouts = 0;
  }

  timeout(tier: number): void {
    const t = this.s[tier];
    if (!t) return;
    t.timeouts += 1;
    this.events.push({ tier, event: 'timeout' });
    if (t.timeouts >= this.after && t.openUntil === 0) this.open(tier);
  }

  /** Opens the breaker now (also the outside signals: BFD loss, placement's metro split). */
  open(tier: number): void {
    const t = this.s[tier];
    if (!t) return;
    t.openUntil = this.wallMs() + this.openMs;
    this.events.push({ tier, event: 'open' });
  }
}

/** Rejects with TierTimeout when `p` does not settle within `ms`. `onLate` gets a value that settles later. */
export function withTierTimeout<T>(p: Promise<T>, tier: number, ms: number = PARAMS.tierTimeoutMs, onLate?: (v: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { done = true; reject(new TierTimeout(tier, ms)); }, ms);
    p.then((v) => {
      if (done) { onLate?.(v); return; }
      done = true; clearTimeout(timer); resolve(v);
    }, (e: unknown) => {
      if (done) return;
      done = true; clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}
