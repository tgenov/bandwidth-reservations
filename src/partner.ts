// A simulated partner system that owns one link (e.g. a subsea cable operator).
// We cannot join its transactions, it knows nothing about our priority tickets,
// and its API is unreliable. Every call can:
//
//   fail     - error before doing anything
//   time out - do the work, then lose the response
//   be slow  - latency is random
//
// Every call is idempotent by key, which is what makes blind retries safe.

import { LinkBook } from './links.ts';

export class PartnerError extends Error {}

export type PartnerHold = 'held' | 'busy' | 'nofit';
export type PartnerConfirm = 'confirmed' | 'unknown-hold';

type Faults = { failRate: number; timeoutRate: number; maxLatencyMs: number };

export class PartnerLink {
  readonly book: LinkBook;
  private confirmedKeys = new Set<string>();
  private random: () => number;
  private faults: Faults;
  calls = 0;

  constructor(id: number, capacity: number, n: number, random: () => number, faults: Faults) {
    // First come, first served: the partner does not understand our tickets.
    this.book = new LinkBook(id, capacity, n, { woundWait: false });
    this.random = random;
    this.faults = faults;
  }

  get id() {
    return this.book.id;
  }

  private async call<T>(work: () => T): Promise<T> {
    this.calls++;
    await new Promise((r) => setTimeout(r, Math.floor(this.random() * this.faults.maxLatencyMs)));
    const roll = this.random();
    if (roll < this.faults.failRate) throw new PartnerError('partner error');
    const result = work();
    if (roll < this.faults.failRate + this.faults.timeoutRate) throw new PartnerError('partner timeout');
    return result;
  }

  // 'busy': fits on their confirmed capacity but not with current holds; try again.
  // 'nofit': does not fit even on confirmed capacity; definitive.
  hold(key: string, s: number, e: number | null, mbps: number, ttlMs: number): Promise<PartnerHold> {
    return this.call(() => {
      const o = this.book.tryHold({ key, sagaId: 0, ticket: [0, 0], s, e, mbps }, ttlMs);
      return o.kind === 'held' ? 'held' : o.kind === 'reject' ? 'nofit' : 'busy';
    });
  }

  confirm(key: string): Promise<PartnerConfirm> {
    return this.call(() => {
      if (this.confirmedKeys.has(key)) return 'confirmed';
      if (!this.book.has(key)) return 'unknown-hold'; // expired before we confirmed
      this.book.confirm(key);
      this.confirmedKeys.add(key);
      return 'confirmed';
    });
  }

  release(key: string): Promise<void> {
    return this.call(() => this.book.release(key));
  }
}
