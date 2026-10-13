/**
 * The apply state machine of one link (RFC-001 §3.3, §4.1, §4.4, §7.3, §7.4), part I1.
 *
 * `decide(command, ts)` applies one command at the batch commit timestamp `ts`. It returns the
 * outcome and tells if the command writes a log entry. A command that writes no entry does not
 * change the state. Every change is journaled, so `rollback()` gives the committed state again
 * (RFC-001 §7.2 step 5). `commit()` makes the changes permanent.
 *
 * Determinism (§7.4): the apply reads `ts`, never a clock. It uses integer arithmetic only. It
 * iterates maps in insertion order, which is a function of the log.
 */
import { createHash } from 'node:crypto';
import { encodeJson, type HlcTs, type WriterFence } from '@share/owner-runtime';
import type {
  ConvertCmd, ConvertOutcome, HoldCmd, HoldOutcome, LinkCommand, LinkId, ReleaseCmd, ReleaseOutcome, RequestId,
  Window,
} from './c02.ts';
import { requestKey } from './c02.ts';
import { OccupancyTree } from './occupancy.ts';

/** The policy parameters that I1 uses (RFC-001 §7.3 `Init`; the full `Policy` entry is I4). */
export interface LinkPolicy {
  version: string;
  /** POL-04, POL-26: 1 min. */
  releaseGraceMs: number;
  /** RFC-001 §4.4: a request record is kept for D + 24 h. */
  requestRecordTtlMs: number;
  /** V1: the smallest rate (Mbps). */
  rateMinMbps: number;
}

export const DEFAULT_POLICY: LinkPolicy = {
  version: '1', releaseGraceMs: 60_000, requestRecordTtlMs: 86_400_000, rateMinMbps: 1,
};

/** The fixture command that registers the link (RFC-001 §7.3 `Init`; the registry feed is I9). */
export interface InitCmd { link: LinkId; capacityMbps: number; policy: LinkPolicy }

/** The outcome of one command, without the link stamp. */
export type Outcome =
  | HoldOutcome | ConvertOutcome | ReleaseOutcome
  | { code: 'UNKNOWN_LINK' } | { code: 'UNAVAILABLE' }
  | { result: 'INITIALISED' } | { result: 'TAKEOVER' };

export interface Decision {
  outcome: Outcome;
  /** True if the command writes a log entry. */
  entry: boolean;
  /** An alert kind for a protocol defect (I7 sends it on `link.alert.v1`). */
  alert?: string;
  /** For a reply from a request record: the log sequence of the entry that recorded that state. */
  recordedSeq?: bigint;
}

/** A capacity hold in `occ_all` (RFC-001 §3.3 "Capacity holds"). */
export interface ActiveHold {
  request: RequestId; account: Uint8Array; leg: string;
  rateMbps: number; window: Window;
  deadline: number; commitFence: number; requestAge: HlcTs;
  attempt: number;
}

/** A confirmed leg part in `occ_firm` (RFC-001 §3.3 "Leg parts"). */
export interface LegPart {
  reservation: string; leg: string; part: string; request: string;
  rateMbps: number; window: Window; age: HlcTs;
}

/** The recorded state of a request at this link (RFC-001 §3.3 "Request records", "Tombstones"). */
interface RequestRecord {
  madeBy: 'hold' | 'release';
  state: 'HELD' | 'REFUSED' | 'RELEASED' | 'CONVERTED';
  holdDigest?: string;
  /** The reply to a repeat of the hold. */
  holdOutcome?: HoldOutcome;
  convertDigest?: string;
  convertAttempt?: number;
  convertOutcome?: ConvertOutcome;
  tombstoneUntil?: number;
  /** D + request_record_ttl, in ms. After it, the record is gone from memory. */
  expiresAt: number;
  /** The log sequence of the entry that recorded the current state. */
  seq: bigint;
}

export class LinkState {
  readonly occFirm = new OccupancyTree();
  readonly occAll = new OccupancyTree();
  link: LinkId | undefined;
  cRef = 0;
  policy: LinkPolicy = DEFAULT_POLICY;
  /** The log sequence and commit timestamp of the last applied entry. */
  appliedSeq = 0n;
  appliedTs: HlcTs | undefined;

  private readonly holds = new Map<string, ActiveHold>();
  private readonly parts = new Map<string, LegPart>();
  private readonly records = new Map<string, RequestRecord>();
  /** Per sending partition: the highest (generation, epoch) applied (RFC-001 §3.3 "Sender fences"). */
  private readonly fences = new Map<string, WriterFence>();
  private undo: Array<() => void> = [];

  // ---------------- journal ----------------

  commit(): void {
    this.occFirm.commit();
    this.occAll.commit();
    this.undo = [];
  }

  rollback(): void {
    this.occFirm.rollback();
    this.occAll.rollback();
    for (let i = this.undo.length - 1; i >= 0; i--) (this.undo[i] as () => void)();
    this.undo = [];
  }

  private setIn<K, V>(m: Map<K, V>, k: K, v: V): void {
    const had = m.has(k);
    const old = m.get(k);
    m.set(k, v);
    this.undo.push(() => { if (had) m.set(k, old as V); else m.delete(k); });
  }

  private deleteIn<K, V>(m: Map<K, V>, k: K): void {
    if (!m.has(k)) return;
    const old = m.get(k) as V;
    m.delete(k);
    this.undo.push(() => m.set(k, old));
  }

  private setScalar<K extends 'link' | 'cRef' | 'policy' | 'appliedSeq' | 'appliedTs'>(k: K, v: this[K]): void {
    const old = this[k];
    this[k] = v;
    this.undo.push(() => { this[k] = old; });
  }

  /** Record the position of an entry that this state applied. */
  advance(seq: bigint, ts: HlcTs): void {
    this.setScalar('appliedSeq', seq);
    this.setScalar('appliedTs', ts);
  }

  // ---------------- sender fences ----------------

  fenceOf(senderKey: string): WriterFence | undefined {
    return this.fences.get(senderKey);
  }

  recordFence(senderKey: string, f: WriterFence): void {
    const cur = this.fences.get(senderKey);
    if (!cur || fenceBelow(cur, f)) this.setIn(this.fences, senderKey, { generation: f.generation, epoch: f.epoch });
  }

  // ---------------- entries ----------------

  init(cmd: InitCmd): Decision {
    if (this.link !== undefined) return { outcome: { result: 'INITIALISED' }, entry: false };
    this.setScalar('link', cmd.link);
    this.setScalar('cRef', cmd.capacityMbps);
    this.setScalar('policy', cmd.policy);
    return { outcome: { result: 'INITIALISED' }, entry: true };
  }

  /**
   * Apply one command at the batch commit timestamp `ts`. `seq` is the log sequence that the entry
   * gets if the command writes one.
   */
  decide(cmd: LinkCommand, ts: HlcTs, seq: bigint): Decision {
    if (this.link === undefined || cmd.body.link !== this.link) return { outcome: { code: 'UNKNOWN_LINK' }, entry: false };
    this.seq = seq;
    switch (cmd.op) {
      case 'hold': return this.hold(cmd.body, ts);
      case 'convert': return this.convert(cmd.body, ts);
      case 'release': return this.release(cmd.body, ts);
    }
  }

  /** The sequence of the entry being decided. */
  private seq = 0n;

  /** RFC-001 §4.1, C02 `hold` checks (1) … (8). I1 has no counter-offer (I2) and no waiting (I3). */
  private hold(b: HoldCmd, ts: HlcTs): Decision {
    const key = requestKey(b.request);
    const rec = this.liveRecord(key, ts);
    // (1) A record that a release made: TOMBSTONED, with no digest check (R26-10).
    if (rec && rec.madeBy === 'release') return { outcome: { result: 'REFUSED', reason: 'TOMBSTONED' }, entry: false, recordedSeq: rec.seq };
    // (2) A record that a hold made: the recorded state, or MISMATCH for another body.
    if (rec) {
      if (rec.holdDigest !== digest(b)) return { outcome: { code: 'MISMATCH' }, entry: false, alert: 'MISMATCH' };
      return { outcome: rec.holdOutcome as HoldOutcome, entry: false, recordedSeq: rec.seq };
    }
    // (3) ts ≥ D_c (this also covers ts ≥ D).
    if (atOrAfterMs(ts, b.commitFence)) return this.refuse(b, ts, { result: 'REFUSED', reason: 'DEADLINE_PASSED' });
    // (4) Validity, the structural rules only. V4 … V6 (against m0 and the horizon) are I4.
    const invalid = this.structurallyInvalid(b);
    if (invalid) return this.refuse(b, ts, { result: 'REFUSED', reason: { invalid } });
    const { start, end } = b.window;
    // (5) No fit on committed capacity (P1-S37, I2 of §3.4).
    if (this.occFirm.peak(start, end) + b.rateMbps > this.cRef) return this.refuse(b, ts, { result: 'REFUSED', reason: 'NO_FIT' });
    // (6) Fit beside every hold: HELD at attempt 1 (P1-S05, invariant I1).
    if (this.occAll.peak(start, end) + b.rateMbps <= this.cRef) {
      this.occAll.add(start, end, b.rateMbps);
      this.setIn(this.holds, key, {
        request: b.request, account: b.account, leg: b.leg, rateMbps: b.rateMbps, window: b.window,
        deadline: b.deadline, commitFence: b.commitFence, requestAge: b.requestAge, attempt: 1,
      });
      const outcome: HoldOutcome = { result: 'HELD', attempt: 1 };
      this.setIn(this.records, key, {
        madeBy: 'hold', state: 'HELD', holdDigest: digest(b), holdOutcome: outcome,
        expiresAt: b.deadline + this.policy.requestRecordTtlMs, seq: this.seq,
      });
      return { outcome, entry: true };
    }
    // (7) Only capacity in flight blocks it, and wait = false: IN_FLIGHT at once (P1-S12, P2-S112).
    if (!b.wait) {
      const retryAfterMs = this.retryAfterMs(b, ts);
      return this.refuse(b, ts, { result: 'REFUSED', reason: 'IN_FLIGHT', retryAfterMs });
    }
    // (8) Waiting is I3. Give an explicit error, never a wrong answer (S-LINK plan §1 rule 1).
    return { outcome: { code: 'UNAVAILABLE' }, entry: false, alert: 'WAIT_NOT_SUPPORTED' };
  }

  /** A refusal records a tombstone until D + release_grace. It is also the release acknowledgement. */
  private refuse(b: HoldCmd, _ts: HlcTs, outcome: HoldOutcome): Decision {
    this.setIn(this.records, requestKey(b.request), {
      madeBy: 'hold', state: 'REFUSED', holdDigest: digest(b), holdOutcome: outcome,
      tombstoneUntil: b.deadline + this.policy.releaseGraceMs,
      expiresAt: b.deadline + this.policy.requestRecordTtlMs, seq: this.seq,
    });
    return { outcome, entry: true };
  }

  private structurallyInvalid(b: HoldCmd): 'V1' | 'V2' | 'V3' | undefined {
    if (!Number.isSafeInteger(b.rateMbps) || b.rateMbps < this.policy.rateMinMbps) return 'V1';
    const { start, end } = b.window;
    if (!Number.isSafeInteger(start) || (end !== null && !Number.isSafeInteger(end))) return 'V2';
    if (end !== null && end <= start) return 'V3';
    return undefined;
  }

  /**
   * The remaining deadline of the latest blocker (RFC-001 §4.1). Blockers are the holds of other
   * requests that overlap a conflict range of `occ_all` above C_ref − b.
   */
  private retryAfterMs(b: HoldCmd, ts: HlcTs): number {
    const ranges = this.occAll.conflicts(b.window.start, b.window.end, this.cRef - b.rateMbps);
    let latest = -1;
    for (const h of this.holds.values()) {
      if (h.deadline <= latest) continue;
      if (ranges.some((r) => overlaps(h.window, r))) latest = h.deadline;
    }
    if (latest < 0) return 0;
    const remainingNs = BigInt(latest) * 1_000_000n - wallNs(ts);
    return remainingNs <= 0n ? 0 : Number((remainingNs + 999_999n) / 1_000_000n);
  }

  /** RFC-001 §4.4 "Convert". I1 has no clip (I6) and no displacement mark (I11). */
  private convert(b: ConvertCmd, ts: HlcTs): Decision {
    const key = requestKey(b.request);
    const rec = this.liveRecord(key, ts);
    if (!rec) return { outcome: { code: 'NO_HOLD' }, entry: false, alert: 'NO_HOLD' };
    if (rec.state === 'CONVERTED') {
      if (rec.convertAttempt !== b.attempt || rec.convertDigest !== digest(b)) return { outcome: { code: 'MISMATCH' }, entry: false, alert: 'MISMATCH' };
      return { outcome: rec.convertOutcome as ConvertOutcome, entry: false, recordedSeq: rec.seq };
    }
    if (rec.state !== 'HELD') return { outcome: { code: 'TOMBSTONED' }, entry: false, alert: 'TOMBSTONED' };
    const h = this.holds.get(key) as ActiveHold;
    if (b.attempt !== h.attempt) return { outcome: { code: 'MISMATCH' }, entry: false, alert: 'MISMATCH' };
    // The pulse goes to occ_firm. occ_all does not change, so the capacity is not counted twice (P1-S09).
    this.occFirm.add(h.window.start, h.window.end, h.rateMbps);
    this.deleteIn(this.holds, key);
    this.setIn(this.parts, partKey(b.reservation, b.leg, b.part), {
      reservation: b.reservation, leg: b.leg, part: b.part, request: key,
      rateMbps: h.rateMbps, window: h.window, age: b.decisionTime,
    });
    const outcome: ConvertOutcome = { result: 'CONVERTED', part: b.part };
    this.setIn(this.records, key, {
      ...rec, state: 'CONVERTED', holdOutcome: { result: 'CONVERTED', part: b.part },
      convertDigest: digest(b), convertAttempt: b.attempt, convertOutcome: outcome, seq: this.seq,
    });
    return { outcome, entry: true };
  }

  /** RFC-001 §4.4 "Release": request-scoped; it also records a tombstone for a request not seen. */
  private release(b: ReleaseCmd, ts: HlcTs): Decision {
    const key = requestKey(b.request);
    const rec = this.liveRecord(key, ts);
    const until = b.deadline + this.policy.releaseGraceMs;
    const expiresAt = b.deadline + this.policy.requestRecordTtlMs;
    if (!rec) {
      this.setIn(this.records, key, { madeBy: 'release', state: 'RELEASED', tombstoneUntil: until, expiresAt, seq: this.seq });
      return { outcome: { result: 'RELEASED', tombstoneUntil: until }, entry: true };
    }
    const newUntil = Math.max(rec.tombstoneUntil ?? 0, until);
    if (rec.state === 'HELD') {
      const h = this.holds.get(key) as ActiveHold;
      // The capacity is free for others from this entry (P1-S08, P2-S14).
      this.occAll.add(h.window.start, h.window.end, -h.rateMbps);
      this.deleteIn(this.holds, key);
      this.setIn(this.records, key, {
        ...rec, state: 'RELEASED', holdOutcome: { result: 'RELEASED' }, tombstoneUntil: newUntil,
        expiresAt: Math.max(rec.expiresAt, expiresAt), seq: this.seq,
      });
      return { outcome: { result: 'RELEASED', tombstoneUntil: newUntil }, entry: true };
    }
    // A converted request keeps its part. A release after a conversion is a protocol defect.
    const alert = rec.state === 'CONVERTED' ? 'RELEASE_AFTER_CONVERT' : undefined;
    if (newUntil === rec.tombstoneUntil) {
      return { outcome: { result: 'RELEASED', tombstoneUntil: newUntil }, entry: false, recordedSeq: rec.seq, ...(alert ? { alert } : {}) };
    }
    this.setIn(this.records, key, { ...rec, tombstoneUntil: newUntil, expiresAt: Math.max(rec.expiresAt, expiresAt), seq: this.seq });
    return { outcome: { result: 'RELEASED', tombstoneUntil: newUntil }, entry: true, ...(alert ? { alert } : {}) };
  }

  /** The record of a request, or undefined if there is none or it has expired at `ts`. */
  private liveRecord(key: string, ts: HlcTs): RequestRecord | undefined {
    const rec = this.records.get(key);
    if (!rec) return undefined;
    return atOrAfterMs(ts, rec.expiresAt) ? undefined : rec;
  }

  /**
   * Remove the expired records from memory. A lookup ignores an expired record, so this has no effect
   * on an outcome. It is not journaled. Call it only on a committed state.
   */
  prune(ts: HlcTs): void {
    for (const [k, r] of this.records) if (atOrAfterMs(ts, r.expiresAt)) this.records.delete(k);
  }

  // ---------------- read access (queries, tests) ----------------

  holdsInOrder(): ActiveHold[] {
    return [...this.holds.values()];
  }

  partsInOrder(): LegPart[] {
    return [...this.parts.values()];
  }

  recordState(r: RequestId): { state: RequestRecord['state']; madeBy: RequestRecord['madeBy']; tombstoneUntil?: number } | undefined {
    const rec = this.records.get(requestKey(r));
    if (!rec) return undefined;
    return { state: rec.state, madeBy: rec.madeBy, ...(rec.tombstoneUntil === undefined ? {} : { tombstoneUntil: rec.tombstoneUntil }) };
  }
}

/** sha256 of the command body only (C02 "Digest": the envelope is not part of it). */
export function digest(body: unknown): string {
  return createHash('sha256').update(encodeJson(body)).digest('hex');
}

/** True if the commit timestamp `ts` is at or after the epoch-ms instant `ms`. */
export function atOrAfterMs(ts: HlcTs, ms: number): boolean {
  return wallNs(ts) >= BigInt(ms) * 1_000_000n;
}

/** The wall-clock part of an HLC timestamp, in ns (C01 §2.1: "<wall ns>.<logical>"). */
export function wallNs(ts: HlcTs): bigint {
  const dot = ts.indexOf('.');
  return BigInt(dot < 0 ? ts : ts.slice(0, dot));
}

function overlaps(w: Window, r: { start: number; end: number | null }): boolean {
  const wEndAfterRStart = w.end === null || w.end > r.start;
  const rEndAfterWStart = r.end === null || r.end > w.start;
  return wEndAfterRStart && rEndAfterWStart;
}

function fenceBelow(a: WriterFence, b: WriterFence): boolean {
  return a.generation < b.generation || (a.generation === b.generation && a.epoch < b.epoch);
}

function partKey(reservation: string, leg: string, part: string): string {
  return `${reservation}|${leg}|${part}`;
}

export { fenceBelow };
