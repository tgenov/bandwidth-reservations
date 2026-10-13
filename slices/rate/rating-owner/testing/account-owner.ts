/**
 * The account owner double: the provider side of C06 §4 (usage-applied acknowledgement) and
 * the consumer of C06 §3 (figures), as C06 CT-A1 and CT-A2 state them. It does not use the
 * code of the RFC-002 team.
 *
 * It holds a figure until its applied ledger position P (from the by-buyer movement feed, F1)
 * reaches the figure's X. Then it applies the latest held figure as F2 and publishes
 * `UsageApplied`. U = U(X) − Δ_b when an applied F1 reports the named batch b, else U(X).
 */
import { hlc } from '@share/owner-runtime';
import type { RatingPosition, UnpostedUsageFigure, UsageApplied } from '@share/rate-common';
import { TOPIC_UNPOSTED, TOPIC_USAGE_APPLIED } from '../src/declarations.ts';
import type { Bus } from './bus.ts';
import type { LedgerDouble, MovementRecord } from './settlement.ts';

interface AccountView {
  held?: UnpostedUsageFigure;
  applied?: UnpostedUsageFigure;
  p: bigint;
  postedBatches: Set<string>;
  entrySeq: bigint;
  streamSeq: bigint;
  u: Map<string, bigint>;
}

function posLess(a: RatingPosition, b: RatingPosition): boolean {
  return a.generation < b.generation || (a.generation === b.generation && BigInt(a.seq) < BigInt(b.seq));
}

export class AccountOwnerDouble {
  /** Hold every UsageApplied (C06 CT-R4: "UsageApplied is held back"). */
  holdAcks = false;
  readonly applied: UsageApplied[] = [];
  /** The headroom input after each applied pair: (account, product) → U. */
  readonly history: Array<{ account: string; product: string; u: bigint; x: string; p: bigint }> = [];
  private readonly accounts = new Map<string, AccountView>();
  private readonly pendingAcks: UsageApplied[] = [];
  private readonly bus: Bus;
  private logical = 0;

  constructor(bus: Bus, ledger: LedgerDouble) {
    this.bus = bus;
    bus.on(TOPIC_UNPOSTED, (ev) => this.onFigure(ev as UnpostedUsageFigure));
    ledger.onMovement((m) => this.onMovement(m));
  }

  private view(account: string): AccountView {
    let v = this.accounts.get(account);
    if (!v) { v = { p: 0n, postedBatches: new Set(), entrySeq: 0n, streamSeq: 0n, u: new Map() }; this.accounts.set(account, v); }
    return v;
  }

  /** U for the account and product as the owner applied it (0 if none). */
  unposted(account: string, product: string): bigint {
    return this.view(account).u.get(product) ?? 0n;
  }

  appliedPosition(account: string): bigint {
    return this.view(account).p;
  }

  private onMovement(m: MovementRecord): void {
    // F1 from the by-buyer view: the applied ledger position moves; the batch it posted is known.
    const v = this.view(m.home.account);
    const seq = BigInt(m.position.sequence);
    if (seq > v.p) v.p = seq;
    if (m.batch) v.postedBatches.add(m.batch.id);
    // F1 again reduces the current figure when it names the batch (C06 "Consumer (account owner, F2)").
    if (v.applied) this.setU(m.home.account, v, v.applied);
  }

  private async onFigure(f: UnpostedUsageFigure): Promise<void> {
    const v = this.view(f.account);
    if (v.applied && !posLess(v.applied.ratingPosition, f.ratingPosition)) return; // at or below the last applied: ignored
    if (!v.held || posLess(v.held.ratingPosition, f.ratingPosition)) v.held = f;
    await this.tryApply(f.account);
  }

  /** Called by tests after a movement, or by `onFigure`. */
  async tryApply(account: string): Promise<void> {
    const v = this.view(account);
    const f = v.held;
    if (!f || BigInt(f.ledgerPositionX.sequence) > v.p) return; // CT-A1: held until P ≥ X
    v.held = undefined;
    v.applied = f;
    this.setU(account, v, f);
    v.entrySeq += 1n;
    v.streamSeq += 1n;
    this.logical += 1;
    const ua: UsageApplied = {
      type: 'UsageApplied', schemaVersion: 1,
      eventId: { partition: account, stream: 'usage_applied', streamSeq: v.streamSeq.toString(), generation: 0, epoch: 1 },
      account, appliedThrough: f.ratingPosition,
      appliedTs: hlc(`${BigInt(this.bus.nowMs) * 1_000_000n}.${String(this.logical).padStart(10, '0')}`),
      entry: { partition: account, sequence: v.entrySeq.toString() },
      ...(f.inFlightUsageBatch ? { inFlightUsageBatch: f.inFlightUsageBatch } : {}),
    };
    this.applied.push(ua);
    if (this.holdAcks) { this.pendingAcks.push(ua); return; }
    await this.bus.publish(TOPIC_USAGE_APPLIED, account, 'usage_applied', ua);
  }

  /** Publish the held-back acknowledgements, in order. */
  async releaseAcks(): Promise<void> {
    this.holdAcks = false;
    for (const ua of this.pendingAcks.splice(0)) await this.bus.publish(TOPIC_USAGE_APPLIED, ua.account, 'usage_applied', ua);
  }

  /** Publish an acknowledgement again (redelivery). */
  async redeliver(ua: UsageApplied): Promise<void> {
    await this.bus.publish(TOPIC_USAGE_APPLIED, ua.account, 'usage_applied', ua);
  }

  private setU(account: string, v: AccountView, f: UnpostedUsageFigure): void {
    const reduced = f.inFlightUsageBatch !== undefined && v.postedBatches.has(f.inFlightUsageBatch);
    for (const p of f.products) {
      const u = BigInt(p.unpostedUsage) - (reduced ? BigInt(p.usageReduction ?? '0') : 0n);
      v.u.set(p.product, u);
      this.history.push({ account, product: p.product, u, x: f.ledgerPositionX.sequence, p: v.p });
    }
  }
}
