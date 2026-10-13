/**
 * Report position, read leases and the report-marker chain of one slot (C01 §3.4; plan S-PLAT-I1 item 9).
 *
 * P (the report position): every entry with ts ≤ P is committed and applied by every reader that holds a
 * live read lease. The holder starts P at its catch-up read (expiry, handoff) or at T_res (resume, re-home)
 * and reports nothing before the post-acquisition wait ends. A read lease lasts 400 ms from the reader's
 * send time; it is granted only if the reader has applied through P, it ends inside the holder's view and
 * the wait is over. P_grant is fixed at the start of a continuous lease.
 */
import type { Epoch, HlcTs, MonotonicNs, OwnerDeclaration, ReportMarker, SlotNo } from '../api.ts';
import { compareHlc } from '../hlc.ts';

export const REPORT = {
  readLeaseMs: 400,
  /** read_lease + ε: no marker and no report before this after an acquisition commit (§3.1). */
  postAcquisitionWaitMs: 500,
  heartbeatMs: 100,
  markerMaxWaitMs: 20,
  /** One marker lists at most this many ids (est.); a longer list goes in chunks (rule 5). */
  markerChunkMax: 5_000,
} as const;

const msNs = (ms: number): bigint => BigInt(Math.round(ms * 1e6));

export interface ReadLease {
  readerId: string;
  pGrant: HlcTs;
  /** Holder side: the lease ends at the reader's send time + 400 ms. */
  endsAt: MonotonicNs;
}

/** The holder's channel to a status reader: push "committed through" and get "applied through" back. */
export interface ReaderChannel {
  apply(slot: SlotNo, through: HlcTs): Promise<HlcTs>;
}

export type LeaseAnswer =
  | { granted: true; pGrant: HlcTs; reportPosition: HlcTs; untilMonotonic: MonotonicNs }
  | { granted: false; reason: 'notHolder' | 'notReportable' | 'notApplied' | 'outsideView' | 'handingOff' };

export class SlotReport {
  /** True after the post-acquisition wait (or at once after a resume). */
  reportable = false;
  position: HlcTs;
  /** ts of the newest batch this holder committed (or the initial position). */
  committedThrough: HlcTs;
  /** Rule 7: the first marker after any acquisition lists every covered outcome. */
  firstMarkerPending = true;
  /** Entries that make a marker due and are not yet covered by a written marker. */
  due: Array<{ ts: HlcTs; pending?: Uint8Array }> = [];
  readonly leases = new Map<string, ReadLease>();
  /** Last "applied through" answer of each reader. */
  readonly applied = new Map<string, HlcTs>();
  markerScheduled = false;
  markerRunning = false;

  constructor(initial: HlcTs) {
    this.position = initial;
    this.committedThrough = initial;
  }

  liveLeases(now: MonotonicNs): ReadLease[] {
    const out: ReadLease[] = [];
    for (const [id, l] of this.leases) {
      if (l.endsAt > now) out.push(l);
      else this.leases.delete(id);
    }
    return out;
  }

  /** The highest P that the live leases allow: min(committedThrough, applied of each leased reader). */
  target(now: MonotonicNs): HlcTs {
    let t = this.committedThrough;
    for (const l of this.liveLeases(now)) {
      const a = this.applied.get(l.readerId);
      if (a === undefined || compareHlc(a, t) < 0) t = a ?? this.position;
    }
    return compareHlc(t, this.position) > 0 ? t : this.position;
  }

  /** Is a marker due (the position passed an entry that no marker covers yet)? */
  markerDue(): boolean {
    if (!this.reportable) return false;
    if (this.firstMarkerPending) return true;
    return this.due.some((d) => compareHlc(d.ts, this.position) <= 0);
  }

  grant(slot: SlotNo, req: { readerId: string; appliedThrough: HlcTs; sendMonotonic: MonotonicNs }, viewEnd: MonotonicNs, live: boolean): LeaseAnswer {
    void slot;
    if (!live) return { granted: false, reason: 'notHolder' };
    if (!this.reportable) return { granted: false, reason: 'notReportable' };
    if (compareHlc(req.appliedThrough, this.position) < 0) return { granted: false, reason: 'notApplied' };
    const endsAt = req.sendMonotonic + msNs(REPORT.readLeaseMs);
    if (endsAt > viewEnd) return { granted: false, reason: 'outsideView' };
    this.applied.set(req.readerId, req.appliedThrough);
    const cur = this.leases.get(req.readerId);
    // P_grant is fixed at the start of a continuous lease.
    const continuous = cur !== undefined && cur.endsAt > req.sendMonotonic;
    const pGrant = continuous ? cur.pGrant : this.position;
    this.leases.set(req.readerId, { readerId: req.readerId, pGrant, endsAt });
    return { granted: true, pGrant, reportPosition: this.position, untilMonotonic: endsAt };
  }
}

/** Split a marker's id list into chunks with one reportPosition (rule 5). An empty list is one chunk. */
export function markerChunks(base: Omit<ReportMarker, 'pendingAnswered' | 'chunk'>, ids: Uint8Array[], max: number = REPORT.markerChunkMax): ReportMarker[] {
  const parts: Uint8Array[][] = [];
  for (let i = 0; i < ids.length; i += max) parts.push(ids.slice(i, i + max));
  if (parts.length === 0) parts.push([]);
  return parts.map((p, i) => ({ ...base, pendingAnswered: p, chunk: { part: i, last: i === parts.length - 1 } }));
}

/** The kind's outcome stream (the reportGated stream, keyed by slot), if it has one. */
export function outcomeStream(decl: OwnerDeclaration): OwnerDeclaration['streams'][number] | undefined {
  return decl.streams.find((s) => s.reportGated === true);
}

/** Kinds that keep a report position with markers: status readers, a reportGated stream, or reportWanted entries. */
export function reportsMarkers(decl: OwnerDeclaration): boolean {
  return decl.statusReaders === true || outcomeStream(decl) !== undefined || decl.entryKinds.some((k) => k.reportWanted === true);
}

export type { Epoch };
