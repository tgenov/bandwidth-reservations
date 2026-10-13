/**
 * StatusReaderRuntime (C01 §2.4, §3.4; plan S-PLAT-I1 item 10).
 *
 * A status reader holds a read lease per slot from the slot's holder. It renews the lease every
 * heartbeat (100 ms); a lease lasts 400 ms from the send and the reader treats it as expired ε (100 ms)
 * earlier. The reader keeps no copy of the state: `leasedRead` makes point reads, each its own
 * single-statement read at with_min_timestamp(ceil_µs(P_grant)) (R47-17), so the reader has applied
 * through any position the holder pushes; it answers the holder's push with that position.
 */
import type pg from 'pg';
import type { HlcTs, MonotonicNs, PartitionKey, RowRef, SlotNo, StatusReaderRuntime } from '../api.ts';
import { NotClosed } from '../api.ts';
import { assertIdentifier } from '../declaration.ts';
import { compareHlc, hlcParts } from '../hlc.ts';
import { keyObject } from '../rowref.ts';
import { toPg } from '../store/pg.ts';
import { PARAMS } from '../params.ts';
import { REPORT, type LeaseAnswer, type ReaderChannel } from '../report/report.ts';
import { systemClock, type WallClock } from '../clock.ts';

/** The holder's side of the lease protocol (in-process in I1; gRPC later). */
export interface ReadLeaseHolder {
  grantReadLease(req: { slot: SlotNo; readerId: string; appliedThrough: HlcTs; sendMonotonic: MonotonicNs }): LeaseAnswer;
  attachReader(readerId: string, channel: ReaderChannel): void;
  detachReader(readerId: string): void;
}

export interface StatusReaderOptions {
  readerId: string;
  /** The account kind (status readers exist for kinds with statusReaders: true). */
  kind: string;
  /** Read pool connected as the `status_reader` role. */
  pool: Pick<pg.Pool, 'query'>;
  /** The slot of a partition (the fixed map in I1, the slot-map feed for accounts). */
  slotOf(partition: PartitionKey): SlotNo;
  /** The holder of a slot (undefined when the reader does not know one). */
  holderOf(slot: SlotNo): ReadLeaseHolder | undefined;
  /** Rows of rule 3 (owner-specific, C02): the present-time consistent read of a request. */
  rule3Rows?: (q: (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>, requestKey: Uint8Array) => Promise<unknown>;
  /** Cache time of a "holder live" answer of replicaRule3Check. */
  rule3CacheMs?: number;
  /** The wall clock of the rule 3 cache (default: the system clock). */
  wallMs?: WallClock;
}

interface LeaseState {
  valid: boolean; untilMonotonic: MonotonicNs; appliedThrough: HlcTs; reportPosition: HlcTs; pGrant: HlcTs;
}

const ZERO = '0.0000000000' as HlcTs;

/** ceil to a microsecond, as a TIMESTAMPTZ literal (with_min_timestamp takes a TIMESTAMPTZ). */
export function ceilMicrosLiteral(t: HlcTs): string {
  const { wallNs, logical } = hlcParts(t);
  let us = wallNs / 1000n;
  if (wallNs % 1000n !== 0n || logical > 0n) us += 1n;
  const ms = Number(us / 1000n);
  const frac = (us % 1_000_000n).toString().padStart(6, '0');
  const iso = new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  return `${iso}.${frac}+00:00`;
}

export class StatusReader implements StatusReaderRuntime {
  private readonly o: StatusReaderOptions;
  private readonly wallMs: WallClock;
  private readonly leases = new Map<SlotNo, LeaseState>();
  private readonly applied = new Map<SlotNo, HlcTs>();
  private readonly slots = new Set<SlotNo>();
  private readonly attached = new Set<ReadLeaseHolder>();
  private readonly rule3Cache = new Map<SlotNo, number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(o: StatusReaderOptions) {
    this.o = o;
    this.wallMs = o.wallMs ?? systemClock;
  }

  /** Serve these slots: attach to their holders and renew leases every heartbeat. */
  start(slots: SlotNo[]): void {
    for (const s of slots) this.slots.add(s);
    const tick = (): void => { for (const s of this.slots) this.renew(s); };
    tick();
    this.timer = setInterval(tick, REPORT.heartbeatMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const h of this.attached) h.detachReader(this.o.readerId);
    this.attached.clear();
  }

  private channel(): ReaderChannel {
    return {
      apply: async (slot, through) => {
        // Reads go to the database at ≥ P_grant, so every pushed position is applied at once.
        const cur = this.applied.get(slot);
        if (cur === undefined || compareHlc(through, cur) > 0) this.applied.set(slot, through);
        return this.applied.get(slot) as HlcTs;
      },
    };
  }

  /** Ask (or renew) the lease of one slot. Public for tests. */
  renew(slot: SlotNo): LeaseAnswer {
    const h = this.o.holderOf(slot);
    if (!h) { this.leases.delete(slot); return { granted: false, reason: 'notHolder' }; }
    if (!this.attached.has(h)) { h.attachReader(this.o.readerId, this.channel()); this.attached.add(h); }
    const send = process.hrtime.bigint();
    const appliedThrough = this.applied.get(slot) ?? ZERO;
    const a = h.grantReadLease({ slot, readerId: this.o.readerId, appliedThrough, sendMonotonic: send });
    if (a.granted) {
      this.leases.set(slot, {
        valid: true, untilMonotonic: send + BigInt((REPORT.readLeaseMs - PARAMS.epsilonMs) * 1e6),
        appliedThrough, reportPosition: a.reportPosition, pGrant: a.pGrant,
      });
    }
    return a;
  }

  readLease(slot: SlotNo): LeaseState {
    const l = this.leases.get(slot);
    if (!l) return { valid: false, untilMonotonic: 0n, appliedThrough: this.applied.get(slot) ?? ZERO, reportPosition: ZERO, pGrant: ZERO };
    return { ...l, valid: process.hrtime.bigint() < l.untilMonotonic };
  }

  /** Point reads at with_min_timestamp(ceil_µs(P_grant)); NotClosed ⇒ the caller answers by rule 4. */
  async leasedRead(partition: PartitionKey, points: RowRef[]): Promise<Array<unknown | undefined>> {
    const l = this.readLease(this.o.slotOf(partition));
    if (!l.valid) throw new NotClosed('no valid read lease for the slot');
    // TODO(I3, C01 §3.4 R47-17): max(pGrant, adoptTs(partition)) for an adopted partition.
    const pGrant = l.pGrant;
    const lit = ceilMicrosLiteral(pGrant);
    const out: Array<unknown | undefined> = [];
    for (const ref of points) {
      const key = keyObject(ref);
      const cols = Object.keys(key).map(assertIdentifier);
      const where = cols.map((c, i) => `${c} = $${i + 1}`).join(' AND ');
      try {
        const r = await this.o.pool.query(
          `SELECT * FROM ${assertIdentifier(ref.table)} AS OF SYSTEM TIME with_min_timestamp('${lit}'::TIMESTAMPTZ) WHERE ${where}`,
          cols.map((c) => toPg(key[c])));
        out.push(r.rows[0]);
      } catch (e) {
        throw new NotClosed(`bounded-staleness read failed: ${(e as Error).message}`);
      }
    }
    return out;
  }

  /** Moves are I3: a reader never applied `moved` in I1. */
  isMovedOut(_partition: PartitionKey): boolean {
    return false;
  }

  /** Rule 3: a present-time consistent read of the holder's session and the request's rows. */
  async replicaRule3Check(accountSlot: SlotNo, requestKey: Uint8Array): Promise<{ holderLive: boolean; rows?: unknown }> {
    const cachedUntil = this.rule3Cache.get(accountSlot);
    const q = async (sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> =>
      (await this.o.pool.query(sql, params.map(toPg))).rows as Array<Record<string, unknown>>;
    let holderLive: boolean;
    if (cachedUntil !== undefined && this.wallMs() < cachedUntil) {
      holderLive = true;
    } else {
      const rows = await q(
        `SELECT coalesce(se.expires_at > now() AND NOT se.revoked, false) AS live
           FROM owner_slot s LEFT JOIN owner_session se ON se.session_id = s.session_id
          WHERE s.kind = $1 AND s.slot = $2`, [this.o.kind, accountSlot]);
      holderLive = Boolean(rows[0]?.['live']);
      if (holderLive) this.rule3Cache.set(accountSlot, this.wallMs() + (this.o.rule3CacheMs ?? 100));
      else this.rule3Cache.delete(accountSlot);
    }
    if (!this.o.rule3Rows) return { holderLive };
    return { holderLive, rows: await this.o.rule3Rows(q, requestKey) };
  }
}
