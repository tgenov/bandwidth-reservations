/**
 * The apply state machine of one link (RFC-001 §3.3, §4.1, §4.2, §4.4, §7.3, §7.4), parts I1 and I2.
 *
 * `beginBatch(ts)` starts a batch at its commit timestamp `ts`. `decide(command, ts)` then applies one
 * command. It returns the outcome and tells if the command writes a log entry. A command that writes no
 * entry does not change the state. Every change is journaled, so `rollback()` gives the committed state
 * again (RFC-001 §7.2 step 5). `commit()` makes the changes permanent.
 *
 * Request records (§3.3, §4.4). Memory keeps a final record until D + release_grace, and a held record for
 * the life of its hold. The entry that records a final state also writes a `link_request` row
 * (`Decision.final`), so the record is known until D + 24 h. For a command whose record has gone from
 * memory, the owner reads that row and gives the record to `decide` as `recalled`.
 *
 * Determinism (§7.4): the apply reads `ts`, never a clock. It uses integer arithmetic only. It
 * iterates maps in insertion order, which is a function of the log. The counter-offer budgets are step
 * counts that `beginBatch` resets. A replay calls `beginBatch` at each new `ts` (all entries of one batch
 * have the same `ts`), so it gets the same outcomes.
 */
import { createHash } from 'node:crypto';
import { encodeJson, type HlcTs, type WriterFence } from '@share/owner-runtime';
import type {
  ConvertCmd, ConvertOutcome, CounterOffer, FitRanges, HoldCmd, HoldOutcome, LinkCommand, LinkId, Minute, QueryState,
  ReleaseCmd, ReleaseOutcome, RequestId, Window,
} from './c02.ts';
import { requestKey } from './c02.ts';
import { CounterOfferBatch, earliest, fitRanges, horizonMinute, largestRate } from './counteroffer.ts';
import { OccupancyTree } from './occupancy.ts';

/** The policy parameters that I1 and I2 use (RFC-001 §7.3 `Init`; the full `Policy` entry is I4). */
export interface LinkPolicy {
  version: string;
  /** POL-04, POL-26: 1 min. */
  releaseGraceMs: number;
  /** RFC-001 §4.4: a request record is kept for D + 24 h. */
  requestRecordTtlMs: number;
  /** V1: the smallest rate (Mbps). */
  rateMinMbps: number;
  /** POL-09 `selling_horizon`, in calendar months (12). */
  sellingHorizonMonths: number;
  /** RFC-001 §4.2 `counteroffer_steps`: the most jumps for one refusal (512). */
  counterofferSteps: number;
  /** RFC-001 §4.2 `counteroffer_batch_steps`: the most jumps for all refusals of one batch (4,096). */
  counterofferBatchSteps: number;
}

export const DEFAULT_POLICY: LinkPolicy = {
  version: '1', releaseGraceMs: 60_000, requestRecordTtlMs: 86_400_000, rateMinMbps: 1,
  sellingHorizonMonths: 12, counterofferSteps: 512, counterofferBatchSteps: 4_096,
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
  /** For an entry that records a final state of a request: the record after the entry (it writes `link_request`). */
  final?: RequestRecord;
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

/**
 * The recorded state of a request at this link (RFC-001 §3.3 "Request records", "Tombstones"). The entry
 * that records a final state keeps a copy in its payload. Thus the `link_request` row and the log row that
 * it names give the record again after it has gone from memory (§4.4).
 */
export interface RequestRecord {
  request: RequestId;
  madeBy: 'hold' | 'release';
  state: 'HELD' | 'REFUSED' | 'RELEASED' | 'CONVERTED';
  holdDigest?: string;
  /** The reply to a repeat of the hold. */
  holdOutcome?: HoldOutcome;
  convertDigest?: string;
  convertAttempt?: number;
  convertOutcome?: ConvertOutcome;
  tombstoneUntil?: number;
  /** The largest D (ms) of the commands that made the record. */
  deadline: number;
  /** D + request_record_ttl, in ms. After it, a final record is gone (from memory and from `link_request`). */
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
  /** The earliest time (ms) at which a final record can leave memory. Before it, `beginBatch` removes nothing. */
  nextPruneAt = Infinity;

  private readonly holds = new Map<string, ActiveHold>();
  private readonly parts = new Map<string, LegPart>();
  private readonly records = new Map<string, RequestRecord>();
  /** Per sending partition: the highest (generation, epoch) applied (RFC-001 §3.3 "Sender fences"). */
  private readonly fences = new Map<string, WriterFence>();
  private undo: Array<() => void> = [];
  /** The counter-offer budget and cache of the batch being decided (RFC-001 §4.2). */
  private batch = new CounterOfferBatch(DEFAULT_POLICY.counterofferSteps, DEFAULT_POLICY.counterofferBatchSteps);
  /** The `link_request` record of the command being decided, if the owner read one. */
  private recalled: RequestRecord | undefined;

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

  private setScalar<K extends 'link' | 'cRef' | 'policy' | 'appliedSeq' | 'appliedTs' | 'nextPruneAt'>(k: K, v: this[K]): void {
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

  // ---------------- batches and request records ----------------

  /**
   * Start a batch at its commit timestamp `ts`. Remove the final records that are due to leave memory, and
   * reset the counter-offer budget and cache. The owner calls it at each run of `decide`. A replay calls it
   * at each new `ts`.
   */
  beginBatch(ts: HlcTs): void {
    this.batch = new CounterOfferBatch(this.policy.counterofferSteps, this.policy.counterofferBatchSteps);
    this.prune(ts);
  }

  /** The steps of the batch counter-offer budget that are left. */
  get counterofferStepsLeft(): number {
    return this.batch.stepsLeft;
  }

  /** The time (ms) until which memory keeps a record: the life of a hold, else D + release_grace. */
  private memoryUntil(r: RequestRecord): number {
    return r.state === 'HELD' ? Infinity : r.deadline + this.policy.releaseGraceMs;
  }

  private putRecord(key: string, r: RequestRecord): void {
    this.setIn(this.records, key, r);
    const until = this.memoryUntil(r);
    if (until < this.nextPruneAt) this.setScalar('nextPruneAt', until);
  }

  /**
   * Remove from memory each final record with ts ≥ D + release_grace (RFC-001 §4.4). Its `link_request` row
   * keeps it. The removal is journaled, so a batch that does not commit gets the records back.
   */
  private prune(ts: HlcTs): void {
    if (!atOrAfterMs(ts, this.nextPruneAt)) return;
    let next = Infinity;
    for (const [k, r] of [...this.records]) {
      const until = this.memoryUntil(r);
      if (atOrAfterMs(ts, until)) this.deleteIn(this.records, k);
      else if (until < next) next = until;
    }
    this.setScalar('nextPruneAt', next);
  }

  /**
   * True if `decide` can need the `link_request` row of the command's request: memory has no record of it,
   * or the record can leave memory before `nowMs + marginMs`. For a hold, only if `nowMs ≥ D_c`: a record
   * leaves memory at D + release_grace, after D_c, so a hold before its D_c whose record has gone has another
   * body than the recorded one (a defect, DI-7). This keeps the read off the path of new holds (RFC-001 §7.2).
   */
  needsRecall(cmd: LinkCommand, nowMs: number, marginMs: number): boolean {
    const rec = this.records.get(requestKey(cmd.body.request));
    if (rec && this.memoryUntil(rec) > nowMs + marginMs) return false;
    return cmd.op !== 'hold' || nowMs >= cmd.body.commitFence;
  }

  /**
   * Replay: set the record that an entry recorded (its payload `record`). A live decision can use a record
   * read from `link_request`, which a replay does not read. Only a release that extends a tombstone writes an
   * entry from such a record, and its outcome is the same without the record. This makes the state the same.
   */
  restoreRecord(r: RequestRecord): void {
    this.putRecord(requestKey(r.request), r);
  }

  /** True if memory has no record of the request. A query does not remove records, so this is enough. */
  queryNeedsRecall(r: RequestId): boolean {
    return !this.records.has(requestKey(r));
  }

  // ---------------- entries ----------------

  init(cmd: InitCmd): Decision {
    if (this.link !== undefined) return { outcome: { result: 'INITIALISED' }, entry: false };
    this.setScalar('link', cmd.link);
    this.setScalar('cRef', cmd.capacityMbps);
    this.setScalar('policy', cmd.policy);
    this.batch = new CounterOfferBatch(cmd.policy.counterofferSteps, cmd.policy.counterofferBatchSteps);
    return { outcome: { result: 'INITIALISED' }, entry: true };
  }

  /**
   * Apply one command at the batch commit timestamp `ts`. `seq` is the log sequence that the entry
   * gets if the command writes one. `recalled` is the request's record from `link_request`, if the owner read it.
   */
  decide(cmd: LinkCommand, ts: HlcTs, seq: bigint, recalled?: RequestRecord): Decision {
    if (this.link === undefined || cmd.body.link !== this.link) return { outcome: { code: 'UNKNOWN_LINK' }, entry: false };
    this.seq = seq;
    this.recalled = recalled !== undefined && requestKey(recalled.request) === requestKey(cmd.body.request) ? recalled : undefined;
    try {
      switch (cmd.op) {
        case 'hold': return this.hold(cmd.body, ts);
        case 'convert': return this.convert(cmd.body, ts);
        case 'release': return this.release(cmd.body, ts);
      }
    } finally {
      this.recalled = undefined;
    }
  }

  /** The sequence of the entry being decided. */
  private seq = 0n;

  /** RFC-001 §4.1, C02 `hold` checks (1) … (8). Waiting is I3. */
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
    if (atOrAfterMs(ts, b.commitFence)) return this.refuse(b, { result: 'REFUSED', reason: 'DEADLINE_PASSED' });
    // (4) Validity, the structural rules only. V4 … V6 (against m0 and the horizon) are I4.
    const invalid = this.structurallyInvalid(b);
    if (invalid) return this.refuse(b, { result: 'REFUSED', reason: { invalid } });
    const { start, end } = b.window;
    // (5) No fit on committed capacity (P1-S37, I2 of §3.4), with the counter-offer beside held capacity (P1-S73).
    if (this.occFirm.peak(start, end) + b.rateMbps > this.cRef) {
      return this.refuse(b, { result: 'REFUSED', reason: 'NO_FIT', counterOffer: this.counterOffer(b) });
    }
    // (6) Fit beside every hold: HELD at attempt 1 (P1-S05, invariant I1).
    if (this.occAll.peak(start, end) + b.rateMbps <= this.cRef) {
      this.occAll.add(start, end, b.rateMbps);
      this.setIn(this.holds, key, {
        request: b.request, account: b.account, leg: b.leg, rateMbps: b.rateMbps, window: b.window,
        deadline: b.deadline, commitFence: b.commitFence, requestAge: b.requestAge, attempt: 1,
      });
      const outcome: HoldOutcome = { result: 'HELD', attempt: 1 };
      this.putRecord(key, {
        request: b.request, madeBy: 'hold', state: 'HELD', holdDigest: digest(b), holdOutcome: outcome,
        deadline: b.deadline, expiresAt: b.deadline + this.policy.requestRecordTtlMs, seq: this.seq,
      });
      return { outcome, entry: true };
    }
    // (7) Only capacity in flight blocks it, and wait = false: IN_FLIGHT at once (P1-S12, P2-S112), with the
    // counter-offer beside held capacity and retry_after from the latest blocker (P1-S70).
    if (!b.wait) {
      const counterOffer = this.counterOffer(b);
      const retryAfterMs = this.retryAfterMs(b, ts);
      return this.refuse(b, { result: 'REFUSED', reason: 'IN_FLIGHT', counterOffer, retryAfterMs });
    }
    // (8) Waiting is I3. Give an explicit error, never a wrong answer (S-LINK plan §1 rule 1).
    return { outcome: { code: 'UNAVAILABLE' }, entry: false, alert: 'WAIT_NOT_SUPPORTED' };
  }

  /** A refusal records a tombstone until D + release_grace. It is also the release acknowledgement. */
  private refuse(b: HoldCmd, outcome: HoldOutcome): Decision {
    const rec: RequestRecord = {
      request: b.request, madeBy: 'hold', state: 'REFUSED', holdDigest: digest(b), holdOutcome: outcome,
      tombstoneUntil: b.deadline + this.policy.releaseGraceMs,
      deadline: b.deadline, expiresAt: b.deadline + this.policy.requestRecordTtlMs, seq: this.seq,
    };
    this.putRecord(requestKey(b.request), rec);
    return { outcome, entry: true, final: rec };
  }

  /** The POL-10 counter-offer of a refused hold, beside committed and held capacity (RFC-001 §4.2). */
  private counterOffer(b: HoldCmd): CounterOffer {
    const h = horizonMinute(b.receiptMinute, this.policy.sellingHorizonMonths);
    return this.batch.offer(this.occAll, this.cRef, this.policy.rateMinMbps, b.window, b.rateMbps, h);
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
    const next: RequestRecord = {
      ...rec, state: 'CONVERTED', holdOutcome: { result: 'CONVERTED', part: b.part },
      convertDigest: digest(b), convertAttempt: b.attempt, convertOutcome: outcome, seq: this.seq,
    };
    this.putRecord(key, next);
    return { outcome, entry: true, final: next };
  }

  /** RFC-001 §4.4 "Release": request-scoped; it also records a tombstone for a request not seen. */
  private release(b: ReleaseCmd, ts: HlcTs): Decision {
    const key = requestKey(b.request);
    const rec = this.liveRecord(key, ts);
    const until = b.deadline + this.policy.releaseGraceMs;
    const expiresAt = b.deadline + this.policy.requestRecordTtlMs;
    if (!rec) {
      const next: RequestRecord = {
        request: b.request, madeBy: 'release', state: 'RELEASED', tombstoneUntil: until, deadline: b.deadline, expiresAt, seq: this.seq,
      };
      this.putRecord(key, next);
      return { outcome: { result: 'RELEASED', tombstoneUntil: until }, entry: true, final: next };
    }
    const newUntil = Math.max(rec.tombstoneUntil ?? 0, until);
    const deadline = Math.max(rec.deadline, b.deadline);
    if (rec.state === 'HELD') {
      const h = this.holds.get(key) as ActiveHold;
      // The capacity is free for others from this entry (P1-S08, P2-S14).
      this.occAll.add(h.window.start, h.window.end, -h.rateMbps);
      this.deleteIn(this.holds, key);
      const next: RequestRecord = {
        ...rec, state: 'RELEASED', holdOutcome: { result: 'RELEASED' }, tombstoneUntil: newUntil,
        deadline, expiresAt: Math.max(rec.expiresAt, expiresAt), seq: this.seq,
      };
      this.putRecord(key, next);
      return { outcome: { result: 'RELEASED', tombstoneUntil: newUntil }, entry: true, final: next };
    }
    // A converted request keeps its part. A release after a conversion is a protocol defect.
    const alert = rec.state === 'CONVERTED' ? 'RELEASE_AFTER_CONVERT' : undefined;
    if (newUntil === rec.tombstoneUntil) {
      return { outcome: { result: 'RELEASED', tombstoneUntil: newUntil }, entry: false, recordedSeq: rec.seq, ...(alert ? { alert } : {}) };
    }
    const next: RequestRecord = { ...rec, tombstoneUntil: newUntil, deadline, expiresAt: Math.max(rec.expiresAt, expiresAt), seq: this.seq };
    this.putRecord(key, next);
    return { outcome: { result: 'RELEASED', tombstoneUntil: newUntil }, entry: true, final: next, ...(alert ? { alert } : {}) };
  }

  /**
   * The record of a request at `ts`: the one in memory, else the one read from `link_request`. A held record
   * lives as long as its hold. A final record lives until D + request_record_ttl.
   */
  private liveRecord(key: string, ts: HlcTs): RequestRecord | undefined {
    const rec = this.records.get(key) ?? this.recalled;
    if (!rec) return undefined;
    return rec.state !== 'HELD' && atOrAfterMs(ts, rec.expiresAt) ? undefined : rec;
  }

  // ---------------- queries (not entries; RFC-001 §7.3) ----------------

  /** C02 `query`: the state of a request at `ts`, from memory or from its `link_request` record. */
  query(r: RequestId, ts: HlcTs, recalled?: RequestRecord): QueryState {
    const key = requestKey(r);
    this.recalled = recalled !== undefined && requestKey(recalled.request) === key ? recalled : undefined;
    const rec = this.liveRecord(key, ts);
    this.recalled = undefined;
    if (!rec) return { state: 'UNSEEN' };
    const tomb = rec.tombstoneUntil === undefined ? {} : { tombstoneUntil: rec.tombstoneUntil };
    if (rec.madeBy === 'release') return { state: 'RELEASED', ...tomb };
    if (rec.state === 'HELD') return { state: 'HELD', attempt: (this.holds.get(key) as ActiveHold).attempt };
    if (rec.state === 'REFUSED') {
      const o = rec.holdOutcome as Extract<HoldOutcome, { result: 'REFUSED' }>;
      const refusal = {
        reason: o.reason,
        ...(o.counterOffer === undefined ? {} : { counterOffer: o.counterOffer }),
        ...(o.retryAfterMs === undefined ? {} : { retryAfterMs: o.retryAfterMs }),
      };
      return { state: 'REFUSED', refusal, ...tomb };
    }
    return { state: rec.state, ...tomb };
  }

  /**
   * C02 `availability(window, rate)`: the largest rate that fits `w`, and the earliest window of its length
   * that fits `b`, beside committed and held capacity, within the horizon from minute `m0`. At most
   * `counteroffer_steps` steps. Advisory: it changes nothing.
   */
  availability(w: Window, b: number, m0: Minute): CounterOffer {
    const h = horizonMinute(m0, this.policy.sellingHorizonMonths);
    const length = w.end === null ? null : w.end - w.start;
    return {
      largestRateMbps: largestRate(this.occAll, this.cRef, w, this.policy.rateMinMbps),
      earliest: earliest(this.occAll, this.cRef, w.start, length, b, h, this.policy.counterofferSteps).value,
    };
  }

  /** C02 `fit_ranges(rate, from, until, k)`, at most `counteroffer_steps` steps. Advisory: it changes nothing. */
  fitRanges(b: number, from: Minute, until: Minute, k: number): FitRanges {
    return fitRanges(this.occAll, this.cRef, b, from, until, k, this.policy.counterofferSteps);
  }

  // ---------------- read access (queries, tests) ----------------

  holdsInOrder(): ActiveHold[] {
    return [...this.holds.values()];
  }

  partsInOrder(): LegPart[] {
    return [...this.parts.values()];
  }

  /** The record of a request in memory, or undefined if memory has none. */
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
  if (ms === Infinity) return false;
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
