/**
 * The apply state machine of one link (RFC-001 §2, §3.3, §4.1 … §4.5, §7.3, §7.4), parts I1 … I6.
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
 * Waiters (§4.3, I3). A hold with `wait = true` that only capacity in flight blocks registers a waiter. An entry
 * that removes occupancy from `occ_all` (a release) or adds to `occ_firm` (a conversion) scans the waiters that
 * overlap its range, in priority order, at most `scan_steps` of them. The scan grants, refuses for no fit, or
 * updates the waiting notice. If the budget binds, the scan is pending, and `tick` continues it: the owner writes
 * `Tick` entries before the next command. Each change for a waiter is a notice (`Decision.notices`).
 *
 * Yields (§4.3, I5). A `mark_waiting` sets or clears the waiting mark of a request, in the order of its position. A
 * waiter asks the younger holders that carry the mark to yield, only if their capacity and the free capacity let it
 * fit. It then takes a yield claim (identified by the sequence of the entry that raised it) over its conflict
 * ranges. While the claim is live, the scan grants no younger waiter inside those ranges. `yield_accept` makes the
 * holder a waiter at attempt + 1; `yield_refuse` ends only its claim. The end of a hold attempt ends every claim on it.
 *
 * Policy versions (§2, §7.3, I4). `Init` and each `Policy(version, parameters)` entry add a version. The link keeps
 * every version, so it can judge each hold by the rules (V1 … V6, `rate_min`, `selling_horizon`) of the version
 * that the hold carries. The newest version gives the other parameters of the link from its entry on.
 *
 * Leg changes (§4.5, I6). `end_leg` and `reduce_parts` change the confirmed parts of one (reservation, leg), in the
 * order of their change ids (C02 "Leg-command sequencing"). The link keeps the recorded reply of every applied change
 * id for the life of the leg. A `convert` is clipped only by an applied `end_leg` with a change id above `createdBy`.
 *
 * Determinism (§7.4): the apply reads `ts`, never a clock. It uses integer arithmetic only. It
 * iterates maps in insertion order, which is a function of the log. The counter-offer budgets are step
 * counts that `beginBatch` resets. A replay calls `beginBatch` at each new `ts` (all entries of one batch
 * have the same `ts`), so it gets the same outcomes.
 */
import { createHash } from 'node:crypto';
import { compareHlc, encodeJson, type HlcTs, type WriterFence } from '@share/owner-runtime';
import type {
  AcceptOutcome, ChangeId, ConvertCmd, ConvertOutcome, CounterOffer, EndLegCmd, FitRanges, HoldCmd, HoldOutcome, LegChangeOutcome,
  LinkCommand, LinkId, MarkWaitingCmd, MarkWaitingOutcome, Minute, Piece, QueryState, ReducePartsCmd, ReleaseCmd, ReleaseOutcome,
  RequestId, WaitingContent, Window, YieldAnswerCmd,
} from './c02.ts';
import { legKey, requestKey } from './c02.ts';
import { endFrom, piecesOf, raises, segments, setPieces, wellFormedPieces } from './legs.ts';
import { CounterOfferBatch, earliest, fitRanges, horizonMinute, largestRate } from './counteroffer.ts';
import { OccupancyTree, type MinuteRange } from './occupancy.ts';

/** The policy parameters of one policy version (RFC-001 §7.3 `Init` and `Policy(version, parameters)`). */
export interface LinkPolicy {
  /** The policy version: a positive decimal integer, without leading zeros (C02 `policyVersion`). */
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
  /** RFC-001 §4.3 `scan_steps`: the most waiters that one entry examines (1,024). */
  scanSteps: number;
}

export const DEFAULT_POLICY: LinkPolicy = {
  version: '1', releaseGraceMs: 60_000, requestRecordTtlMs: 86_400_000, rateMinMbps: 1,
  sellingHorizonMonths: 12, counterofferSteps: 512, counterofferBatchSteps: 4_096, scanSteps: 1_024,
};

/** The fixture command that registers the link (RFC-001 §7.3 `Init`; the registry feed is I9). */
export interface InitCmd { link: LinkId; capacityMbps: number; policy: LinkPolicy }

/** The deployment command that gives the link a policy version (RFC-001 §7.3 `Policy(version, parameters)`). */
export interface PolicyCmd { link: LinkId; policy: LinkPolicy }

/** The outcome of one command, without the link stamp. */
export type Outcome =
  | HoldOutcome | ConvertOutcome | ReleaseOutcome | MarkWaitingOutcome | AcceptOutcome | LegChangeOutcome
  | { code: 'UNKNOWN_LINK' } | { code: 'UNAVAILABLE' }
  | { result: 'INITIALISED' } | { result: 'TAKEOVER' } | { result: 'TICK' }
  | { result: 'POLICY_APPLIED'; version: string } | { code: 'INVALID_POLICY' };

/**
 * A change for a waiter that an entry makes (RFC-001 §4.3, §11.1). The owner sends it to the waiter's account
 * owner as a C02 `WaitingNotification`, with the link stamp of the entry.
 */
export type WaitingNotice = { request: RequestId; account: Uint8Array; attempt: number } & WaitingContent;

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
  /** The waiting-port notices of the entry, in the order of the scan (I3). */
  notices?: WaitingNotice[];
  /** The final records of other requests that the entry made (waiters refused by the scan). */
  finals?: RequestRecord[];
}

/** A waiter (RFC-001 §3.3 "Waiters"): a request that waits for capacity in flight. It holds nothing. */
export interface Waiter {
  /** The hold command that registered it (rate, window, D, D_c, request_age, account). */
  cmd: HoldCmd;
  attempt: number;
  /** The latest blocker deadline that the link told the account owner (ms). */
  aheadDeadline: number;
}

/** Where a pending scan continues: its range, and the last waiter that it examined (by priority). */
interface ScanCursor { start: number; end: number | null; after: HoldCmd }

/** A capacity hold in `occ_all` (RFC-001 §3.3 "Capacity holds"). */
export interface ActiveHold {
  request: RequestId; account: Uint8Array; leg: string;
  rateMbps: number; window: Window;
  deadline: number; commitFence: number; requestAge: HlcTs;
  attempt: number;
  /** The hold command. An accepted yield registers it again as a waiter (same age and window, RFC-001 §4.3). */
  cmd: HoldCmd;
}

/** A yield claim (RFC-001 §4.3): raised for the waiter `waiter` by the entry `seq`, over its conflict ranges then. */
interface Claim { seq: bigint; waiter: string; ranges: MinuteRange[] }

/** An open yield request of a claim on one holder attempt (C02 `YIELD_REQUEST`). */
export interface YieldRequest {
  /** The claim: the sequence of the entry that raised it. */
  claim: bigint;
  /** The key of the older waiter of the claim, and its request. */
  waiter: string; olderRequest: RequestId;
  /** The key of the holder, its request, its account partition and its hold attempt. */
  holder: string; request: RequestId; account: Uint8Array; attempt: number;
}

/** A confirmed leg part in `occ_firm` (RFC-001 §3.3 "Leg parts"). */
export interface LegPart {
  reservation: string; leg: string; part: string; request: string;
  /** The rate at conversion. */
  rateMbps: number;
  /** The current window: an `end_leg` or a convert clip ends it earlier (I6). */
  window: Window; age: HlcTs;
  /** The rate as absolute pieces from the window start, after a `reduce_parts` (I6). Absent: `rateMbps` throughout. */
  pieces?: Piece[];
}

/**
 * The changes of one (reservation, leg) at this link (RFC-001 §4.5; C02 "Leg-command sequencing"). Kept for the life
 * of the leg. The state replaces the whole record on each change, so the journal can undo it.
 */
export interface LegRecord {
  /** The account partition (hex) that owns the reservation: the account of the hold of its first part. */
  owner: string;
  /** The part keys of the leg, in conversion order. */
  parts: string[];
  /** The highest applied change id. */
  lastApplied?: ChangeId;
  /** The applied `end_leg` changes: change sequence and effective minute (the convert clip, C02 V61-1). */
  ends: Array<{ seq: bigint; fromMinute: number }>;
  /** The recorded reply of every applied change id, by `requestKey(changeId)`: the body digest and the entry. */
  changes: Record<string, { digest: string; seq: bigint }>;
}

/**
 * The recorded state of a request at this link (RFC-001 §3.3 "Request records", "Tombstones"). The entry
 * that records a final state keeps a copy in its payload. Thus the `link_request` row and the log row that
 * it names give the record again after it has gone from memory (§4.4).
 */
export interface RequestRecord {
  request: RequestId;
  madeBy: 'hold' | 'release';
  state: 'HELD' | 'WAITING' | 'REFUSED' | 'RELEASED' | 'CONVERTED';
  holdDigest?: string;
  /** The reply to a repeat of the hold. */
  holdOutcome?: HoldOutcome;
  convertDigest?: string;
  convertAttempt?: number;
  convertOutcome?: ConvertOutcome;
  tombstoneUntil?: number;
  /** The waiting mark of the request and the account-log position of the `mark_waiting` that set it (I5). */
  mark?: { waiting: boolean; position: bigint };
  /** The recorded replies to `yield_accept` and `yield_refuse`, by (attempt, claim, kind) (C02 "Idempotency"). */
  answers?: Array<{ attempt: number; claim: bigint; answer: YieldAnswerCmd['answer']; outcome: AcceptOutcome; seq: bigint }>;
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
  /** A scan that the step budget stopped (RFC-001 §4.3 "scan-pending"). `tick` continues it. */
  scanCursor: ScanCursor | undefined;

  private readonly holds = new Map<string, ActiveHold>();
  private readonly parts = new Map<string, LegPart>();
  /** The leg records, by `legKey(reservation, leg)` (I6). */
  private readonly legs = new Map<string, LegRecord>();
  private readonly records = new Map<string, RequestRecord>();
  private readonly waiters = new Map<string, Waiter>();
  /** The waiter keys in priority order: `request_age`, ties by request identity (RFC-001 §4.3). */
  private readonly waitOrder: string[] = [];
  /** The yield claims by `claimKey(seq, waiter)`, and the open yield requests by `yieldKey(holder, attempt, claim)` (I5). */
  private readonly claims = new Map<string, Claim>();
  private readonly yieldReqs = new Map<string, YieldRequest>();
  /** The notices and the final records of other requests of the entry being decided. */
  private notices: WaitingNotice[] = [];
  private finals: RequestRecord[] = [];
  /** Per sending partition: the highest (generation, epoch) applied (RFC-001 §3.3 "Sender fences"). */
  private readonly fences = new Map<string, WriterFence>();
  /** Every policy version that the link has applied, by version (RFC-001 §2: "keeps every version"). */
  private readonly policies = new Map<string, LinkPolicy>();
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

  private setScalar<K extends 'link' | 'cRef' | 'policy' | 'appliedSeq' | 'appliedTs' | 'nextPruneAt' | 'scanCursor'>(k: K, v: this[K]): void {
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

  /** The time (ms) until which memory keeps a record: the life of a hold or a waiter, else D + release_grace. */
  private memoryUntil(r: RequestRecord): number {
    return isLive(r) ? Infinity : r.deadline + this.policy.releaseGraceMs;
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
    // A leg change has no request record: its leg keeps the recorded replies for the life of the leg (I6).
    if (cmd.op === 'end_leg' || cmd.op === 'reduce_parts') return false;
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
    this.setIn(this.policies, cmd.policy.version, cmd.policy);
    this.batch = new CounterOfferBatch(cmd.policy.counterofferSteps, cmd.policy.counterofferBatchSteps);
    return { outcome: { result: 'INITIALISED' }, entry: true };
  }

  /**
   * The `Policy(version, parameters)` entry (RFC-001 §7.3). A new version is kept for the holds that carry
   * it. If it is newer than the current policy, it gives the parameters of the link from this entry on. A
   * version that the link has with the same parameters is a duplicate: no entry. The same version with other
   * parameters is `MISMATCH`, and a malformed policy is `INVALID_POLICY`; both are alerted and write nothing.
   */
  applyPolicy(cmd: PolicyCmd): Decision {
    if (this.link === undefined || cmd.link !== this.link) return { outcome: { code: 'UNKNOWN_LINK' }, entry: false };
    const p = cmd.policy;
    if (!wellFormedPolicy(p)) return { outcome: { code: 'INVALID_POLICY' }, entry: false, alert: 'INVALID_POLICY' };
    const outcome: Outcome = { result: 'POLICY_APPLIED', version: p.version };
    const known = this.policies.get(p.version);
    if (known) {
      if (digest(known) !== digest(p)) return { outcome: { code: 'MISMATCH' }, entry: false, alert: 'POLICY_MISMATCH' };
      return { outcome, entry: false };
    }
    this.setIn(this.policies, p.version, p);
    if (BigInt(p.version) > BigInt(this.policy.version)) this.setScalar('policy', p);
    return { outcome, entry: true };
  }

  /** The policy version `v`, if the link has applied it. */
  policyOf(v: bigint | string): LinkPolicy | undefined {
    return this.policies.get(typeof v === 'string' ? v : v.toString());
  }

  /**
   * Apply one command at the batch commit timestamp `ts`. `seq` is the log sequence that the entry
   * gets if the command writes one. `recalled` is the request's record from `link_request`, if the owner read it.
   */
  decide(cmd: LinkCommand, ts: HlcTs, seq: bigint, recalled?: RequestRecord): Decision {
    if (this.link === undefined || cmd.body.link !== this.link) return { outcome: { code: 'UNKNOWN_LINK' }, entry: false };
    this.seq = seq;
    this.notices = [];
    this.finals = [];
    const request = 'request' in cmd.body ? cmd.body.request : undefined;
    this.recalled = recalled !== undefined && request !== undefined && requestKey(recalled.request) === requestKey(request) ? recalled : undefined;
    try {
      switch (cmd.op) {
        case 'hold': return this.withEffects(this.hold(cmd.body, ts));
        case 'convert': return this.withEffects(this.convert(cmd.body, ts));
        case 'release': return this.withEffects(this.release(cmd.body, ts));
        case 'mark_waiting': return this.withEffects(this.markWaiting(cmd.body, ts));
        case 'yield': return this.withEffects(this.yieldAnswer(cmd.body, ts));
        case 'end_leg': return this.withEffects(this.legChange(cmd.op, cmd.body, ts));
        case 'reduce_parts': return this.withEffects(this.legChange(cmd.op, cmd.body, ts));
      }
    } finally {
      this.recalled = undefined;
    }
  }

  /** True if a scan is pending. The owner then writes `Tick` entries before the next command (RFC-001 §4.3). */
  get scanPending(): boolean {
    return this.scanCursor !== undefined;
  }

  /**
   * The `Tick` continuation of a pending scan (RFC-001 §4.3, §7.3): it examines the next `scan_steps` waiters of
   * the range, after the last one examined. With no pending scan, it writes no entry.
   */
  tick(ts: HlcTs, seq: bigint): Decision {
    this.seq = seq;
    this.notices = [];
    this.finals = [];
    const c = this.scanCursor;
    if (c === undefined) return { outcome: { result: 'TICK' }, entry: false };
    this.scan(c.start, c.end, ts, c.after);
    return this.withEffects({ outcome: { result: 'TICK' }, entry: true });
  }

  private withEffects(d: Decision): Decision {
    if (this.notices.length > 0) d.notices = this.notices;
    if (this.finals.length > 0) d.finals = this.finals;
    return d;
  }

  /** The sequence of the entry being decided. */
  private seq = 0n;

  /** RFC-001 §4.1, C02 `hold` checks (1) … (8). Check (8) registers a waiter and asks for yields (I5). */
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
    // RFC-001 §2: a version that the link has not applied yet gets UNAVAILABLE, and the link records nothing.
    // The account owner sends the hold again.
    const rules = this.policyOf(b.policyVersion);
    if (!rules) return { outcome: { code: 'UNAVAILABLE' }, entry: false };
    // (4) Validity V1 … V6 against the receipt minute m0, by the rules of the hold's policy version (§2).
    const invalid = invalidRule(b, rules);
    if (invalid) return this.refuse(b, { result: 'REFUSED', reason: { invalid } });
    const { start, end } = b.window;
    // (5) No fit on committed capacity (P1-S37, I2 of §3.4), with the counter-offer beside held capacity (P1-S73).
    if (this.occFirm.peak(start, end) + b.rateMbps > this.cRef) {
      return this.refuse(b, { result: 'REFUSED', reason: 'NO_FIT', counterOffer: this.counterOffer(b, rules) });
    }
    // (6) Fit beside every hold: HELD at attempt 1 (P1-S05, invariant I1).
    if (this.occAll.peak(start, end) + b.rateMbps <= this.cRef) {
      this.occAll.add(start, end, b.rateMbps);
      this.setIn(this.holds, key, {
        request: b.request, account: b.account, leg: b.leg, rateMbps: b.rateMbps, window: b.window,
        deadline: b.deadline, commitFence: b.commitFence, requestAge: b.requestAge, attempt: 1, cmd: b,
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
      const counterOffer = this.counterOffer(b, rules);
      const retryAfterMs = this.retryAfterMs(b, ts);
      return this.refuse(b, { result: 'REFUSED', reason: 'IN_FLIGHT', counterOffer, retryAfterMs });
    }
    // (8) wait = true: a waiter at attempt 1, with the latest blocker deadline (P1-S07, P1-S34). It reserves
    // nothing: a later hold is still checked against held capacity only (POL-05).
    const aheadDeadline = Math.max(this.latestBlockerDeadline(b.window, b.rateMbps), 0);
    const outcome: HoldOutcome = { result: 'WAITING', attempt: 1, aheadDeadline };
    const waiter: Waiter = { cmd: b, attempt: 1, aheadDeadline };
    this.insertWaiter(key, waiter);
    this.putRecord(key, {
      request: b.request, madeBy: 'hold', state: 'WAITING', holdDigest: digest(b), holdOutcome: outcome,
      deadline: b.deadline, expiresAt: b.deadline + this.policy.requestRecordTtlMs, seq: this.seq,
    });
    // RFC-001 §4.1 check (8): "WAITING(1, aheadDeadline), and yield requests" (§4.3).
    this.requestYields(key, waiter, ts);
    return { outcome, entry: true };
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

  /**
   * The POL-10 counter-offer of a refused hold, beside committed and held capacity (RFC-001 §4.2), within the
   * request's horizon H. H and `rate_min` come from the policy version that the hold carries (§2).
   */
  private counterOffer(b: HoldCmd, rules: LinkPolicy): CounterOffer {
    const h = horizonMinute(b.receiptMinute, rules.sellingHorizonMonths);
    return this.batch.offer(this.occAll, this.cRef, rules.rateMinMbps, b.window, b.rateMbps, h);
  }

  /**
   * The remaining deadline of the latest blocker (RFC-001 §4.1). Blockers are the holds of other
   * requests that overlap a conflict range of `occ_all` above C_ref − b.
   */
  private retryAfterMs(b: HoldCmd, ts: HlcTs): number {
    const latest = this.latestBlockerDeadline(b.window, b.rateMbps);
    if (latest < 0) return 0;
    const remainingNs = BigInt(latest) * 1_000_000n - wallNs(ts);
    return remainingNs <= 0n ? 0 : Number((remainingNs + 999_999n) / 1_000_000n);
  }

  /** The largest D (ms) of the holds that overlap a conflict range of `occ_all` above C_ref − rate; −1 if none. */
  private latestBlockerDeadline(w: Window, rate: number): number {
    const ranges = this.occAll.conflicts(w.start, w.end, this.cRef - rate);
    let latest = -1;
    for (const h of this.holds.values()) {
      if (h.deadline <= latest) continue;
      if (ranges.some((r) => overlaps(h.window, r))) latest = h.deadline;
    }
    return latest;
  }

  // ---------------- waiters and the scan (RFC-001 §4.3) ----------------

  /** Insert a waiter at its place in priority order (journaled). */
  private insertWaiter(key: string, w: Waiter): void {
    this.setIn(this.waiters, key, w);
    const i = this.upperBound(w.cmd);
    this.waitOrder.splice(i, 0, key);
    this.undo.push(() => { this.waitOrder.splice(i, 1); });
  }

  /** Remove a waiter (journaled). */
  private removeWaiter(key: string): void {
    const w = this.waiters.get(key);
    if (!w) return;
    const i = this.upperBound(w.cmd) - 1;
    this.deleteIn(this.waiters, key);
    this.waitOrder.splice(i, 1);
    this.undo.push(() => { this.waitOrder.splice(i, 0, key); });
  }

  /** The first index in `waitOrder` whose waiter comes after `c` in priority order. */
  private upperBound(c: HoldCmd): number {
    let lo = 0;
    let hi = this.waitOrder.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const w = this.waiters.get(this.waitOrder[mid] as string) as Waiter;
      if (comparePriority(w.cmd, c) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * RFC-001 §4.3 `scan(R)`: the waiters that overlap [start, end), in priority order, after `after` if given. At
   * most `scan_steps` of them. If waiters of the range are left, the scan is pending (`scanCursor`).
   */
  private scan(start: number, end: number | null, ts: HlcTs, after?: HoldCmd): void {
    const range = { start, end };
    const keys = this.waitOrder.slice(after === undefined ? 0 : this.upperBound(after));
    let steps = 0;
    let last: HoldCmd | undefined;
    for (const key of keys) {
      const w = this.waiters.get(key) as Waiter;
      if (!overlaps(w.cmd.window, range)) continue;
      if (steps >= this.policy.scanSteps) {
        this.setScalar('scanCursor', { start, end, after: last as HoldCmd });
        return;
      }
      steps += 1;
      last = w.cmd;
      this.examine(key, w, ts);
    }
    if (this.scanCursor !== undefined) this.setScalar('scanCursor', undefined);
  }

  /** One step of the scan for one waiter: skip, refuse, grant, or update its waiting notice. */
  private examine(key: string, w: Waiter, ts: HlcTs): void {
    const b = w.cmd;
    const { start, end } = b.window;
    // A waiter at or after its D_c cannot commit. The link grants it nothing; its account owner ends it (I3 of §3.4).
    if (atOrAfterMs(ts, b.commitFence)) return;
    // No fit on committed capacity: WAITER_REFUSED with a counter-offer, and a tombstone (P1-S42, P2-S52).
    if (this.occFirm.peak(start, end) + b.rateMbps > this.cRef) {
      this.refuseWaiter(key, w);
      return;
    }
    // Capacity that a younger waiter yielded for an older one is not granted to it again while the claim is live (§4.3).
    if (this.insideOlderClaim(key, b)) return;
    // Fit beside every hold: the waiter becomes a hold at the same attempt (P1-S11, P2-S20, invariant I1).
    if (this.occAll.peak(start, end) + b.rateMbps <= this.cRef) {
      this.grant(key, w);
      return;
    }
    // Still blocked: ask for yields, then send the waiting notice again if its latest blocker changed (RFC-001 §4.3).
    this.requestYields(key, w, ts);
    const aheadDeadline = Math.max(this.latestBlockerDeadline(b.window, b.rateMbps), 0);
    if (aheadDeadline === w.aheadDeadline) return;
    this.setIn(this.waiters, key, { ...w, aheadDeadline });
    const rec = this.records.get(key) as RequestRecord;
    this.putRecord(key, { ...rec, holdOutcome: { result: 'WAITING', attempt: w.attempt, aheadDeadline }, seq: this.seq });
    this.notices.push({ request: b.request, account: b.account, attempt: w.attempt, kind: 'WAITING_NOTICE', aheadDeadline });
  }

  private grant(key: string, w: Waiter): void {
    const b = w.cmd;
    this.occAll.add(b.window.start, b.window.end, b.rateMbps);
    this.removeWaiter(key);
    this.endClaimsOfWaiter(key);
    this.setIn(this.holds, key, {
      request: b.request, account: b.account, leg: b.leg, rateMbps: b.rateMbps, window: b.window,
      deadline: b.deadline, commitFence: b.commitFence, requestAge: b.requestAge, attempt: w.attempt, cmd: b,
    });
    const rec = this.records.get(key) as RequestRecord;
    this.putRecord(key, { ...rec, state: 'HELD', holdOutcome: { result: 'HELD', attempt: w.attempt }, seq: this.seq });
    this.notices.push({ request: b.request, account: b.account, attempt: w.attempt, kind: 'GRANTED' });
  }

  private refuseWaiter(key: string, w: Waiter): void {
    const b = w.cmd;
    this.removeWaiter(key);
    this.endClaimsOfWaiter(key);
    // The waiter's policy version was applied when it registered, and the link keeps every version (§2).
    const counterOffer = this.counterOffer(b, this.policyOf(b.policyVersion) as LinkPolicy);
    const rec = this.records.get(key) as RequestRecord;
    const next: RequestRecord = {
      ...rec, state: 'REFUSED', holdOutcome: { result: 'REFUSED', reason: 'NO_FIT', counterOffer },
      tombstoneUntil: b.deadline + this.policy.releaseGraceMs, seq: this.seq,
    };
    this.putRecord(key, next);
    this.finals.push(next);
    this.notices.push({ request: b.request, account: b.account, attempt: w.attempt, kind: 'WAITER_REFUSED', reason: 'NO_FIT', counterOffer });
  }

  /**
   * RFC-001 §4.4 "Convert", with the clip backstop (I6): an applied `end_leg` of the leg with a change id above
   * `createdBy` clips the new part at its minute (`clippedAt`, alert `CONVERT_AFTER_END`). No displacement mark (I11).
   */
  private convert(b: ConvertCmd, ts: HlcTs): Decision {
    const key = requestKey(b.request);
    const rec = this.liveRecord(key, ts);
    if (!rec) return { outcome: { code: 'NO_HOLD' }, entry: false, alert: 'NO_HOLD' };
    if (rec.state === 'CONVERTED') {
      if (rec.convertAttempt !== b.attempt || rec.convertDigest !== digest(b)) return { outcome: { code: 'MISMATCH' }, entry: false, alert: 'MISMATCH' };
      return { outcome: rec.convertOutcome as ConvertOutcome, entry: false, recordedSeq: rec.seq };
    }
    // A waiter holds nothing: the account owner confirms only with every leg held (RFC-001 §4.4).
    if (rec.state === 'WAITING') return { outcome: { code: 'NO_HOLD' }, entry: false, alert: 'NO_HOLD' };
    if (rec.state !== 'HELD') return { outcome: { code: 'TOMBSTONED' }, entry: false, alert: 'TOMBSTONED' };
    const h = this.holds.get(key) as ActiveHold;
    if (b.attempt !== h.attempt) return { outcome: { code: 'MISMATCH' }, entry: false, alert: 'MISMATCH' };
    const lk = legKey(b.reservation, b.leg);
    const leg = this.legs.get(lk);
    const clippedAt = leg === undefined ? undefined : clipOf(leg, b.createdBy);
    const window = clippedAt === undefined ? h.window : endFrom(h.window, clippedAt);
    // The pulse goes to occ_firm. occ_all does not change, so the capacity is not counted twice (P1-S09). A clip
    // removes the hold's pulse after the clip minute from occ_all (C02 V61-1).
    this.occFirm.add(window.start, window.end, h.rateMbps);
    if (window.end !== h.window.end) this.occAll.add(window.end as number, h.window.end, -h.rateMbps);
    this.deleteIn(this.holds, key);
    // The entry that ends a hold attempt ends every yield claim on it (C02 port invariants, review 54 m1).
    this.endClaimsOnAttempt(key, h.attempt);
    const pk = partKey(b.reservation, b.leg, b.part);
    this.setIn(this.parts, pk, {
      reservation: b.reservation, leg: b.leg, part: b.part, request: key,
      rateMbps: h.rateMbps, window, age: b.decisionTime,
    });
    this.setIn(this.legs, lk, leg === undefined
      ? { owner: hexOf(h.account), parts: [pk], ends: [], changes: {} }
      : { ...leg, parts: [...leg.parts, pk] });
    const outcome: ConvertOutcome = clippedAt === undefined
      ? { result: 'CONVERTED', part: b.part }
      : { result: 'CONVERTED', part: b.part, clippedAt };
    const next: RequestRecord = {
      ...rec, state: 'CONVERTED', holdOutcome: { result: 'CONVERTED', part: b.part },
      convertDigest: digest(b), convertAttempt: b.attempt, convertOutcome: outcome, seq: this.seq,
    };
    this.putRecord(key, next);
    // occ_firm grew over the window: the waiters there can no longer fit (P2-S52, RFC-001 §4.3). A clip frees the
    // rest of the hold's window, which is in the same range.
    this.scan(h.window.start, h.window.end, ts);
    return { outcome, entry: true, final: next, ...(clippedAt === undefined ? {} : { alert: 'CONVERT_AFTER_END' }) };
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
    if (rec.state === 'HELD' || rec.state === 'WAITING') {
      const h = this.holds.get(key);
      if (h) {
        // The capacity is free for others from this entry (P1-S08, P2-S14).
        this.occAll.add(h.window.start, h.window.end, -h.rateMbps);
        this.deleteIn(this.holds, key);
        this.endClaimsOnAttempt(key, h.attempt);
      } else {
        this.removeWaiter(key);
        this.endClaimsOfWaiter(key);
      }
      const next: RequestRecord = {
        ...rec, state: 'RELEASED', holdOutcome: { result: 'RELEASED' }, tombstoneUntil: newUntil,
        deadline, expiresAt: Math.max(rec.expiresAt, expiresAt), seq: this.seq,
      };
      this.putRecord(key, next);
      // Released capacity goes to the oldest waiter that it fits, in this entry (P1-S11, P2-S16).
      if (h) this.scan(h.window.start, h.window.end, ts);
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
    return !isLive(rec) && atOrAfterMs(ts, rec.expiresAt) ? undefined : rec;
  }

  // ---------------- yields (RFC-001 §4.3, C02 "YIELD_REQUEST", I5) ----------------

  /**
   * C02 `mark_waiting`. The link applies it only if `position` is above the last position applied for the request;
   * otherwise `IGNORED_OLDER` with no entry. A mark that is set makes the link check again, in this entry, every
   * older waiter that the holder's attempt blocks (P2-S118). The mark is advisory: it ends no claim.
   */
  private markWaiting(b: MarkWaitingCmd, ts: HlcTs): Decision {
    const key = requestKey(b.request);
    const rec = this.liveRecord(key, ts);
    // C02 states no reply for a request that the link has not seen (S-LINK I5 design issue DI-22).
    if (!rec) return { outcome: { result: 'IGNORED_OLDER' }, entry: false, alert: 'MARK_WITHOUT_REQUEST' };
    // A final request has no hold and no waiter here, so a mark can change nothing (DI-22).
    if (!isLive(rec)) return { outcome: { result: 'IGNORED_OLDER' }, entry: false, recordedSeq: rec.seq };
    if (rec.mark && b.position <= rec.mark.position) return { outcome: { result: 'IGNORED_OLDER' }, entry: false, recordedSeq: rec.seq };
    this.putRecord(key, { ...rec, mark: { waiting: b.waiting, position: b.position } });
    const h = this.holds.get(key);
    if (b.waiting && h) {
      for (const k of [...this.waitOrder]) {
        const o = this.waiters.get(k);
        if (!o || comparePriority(o.cmd, h) >= 0) continue;
        if (this.openRequestsOn(key, h.attempt).some((y) => y.waiter === k)) continue;
        this.requestYields(k, o, ts, key);
      }
    }
    return { outcome: { result: 'APPLIED' }, entry: true };
  }

  /**
   * C02 `yield_accept` and `yield_refuse`. A repeat gets the recorded reply. An attempt or a claim that is not open
   * gets `STALE_ATTEMPT` and changes nothing. `yield_refuse` ends only its claim, and raises a new claim at once if
   * the holder's mark is set and the older waiter is still blocked by that attempt. `yield_accept` removes the pulse,
   * registers the holder as a waiter at attempt + 1 (same age and window), ends every other claim on the old attempt,
   * and scans (RFC-001 §4.3).
   */
  private yieldAnswer(b: YieldAnswerCmd, ts: HlcTs): Decision {
    const key = requestKey(b.request);
    const rec = this.liveRecord(key, ts);
    const done = rec?.answers?.find((a) => a.attempt === b.attempt && a.claim === b.claim && a.answer === b.answer);
    if (done) return { outcome: done.outcome, entry: false, recordedSeq: done.seq };
    const h = this.holds.get(key);
    const y = this.yieldReqs.get(yieldKey(key, b.attempt, b.claim));
    if (!rec || !h || h.attempt !== b.attempt || !y) return { outcome: { result: 'STALE_ATTEMPT' }, entry: false };
    const answered = (outcome: AcceptOutcome): RequestRecord['answers'] =>
      [...(rec.answers ?? []), { attempt: b.attempt, claim: b.claim, answer: b.answer, outcome, seq: this.seq }];
    if (b.answer === 'yield_refuse') {
      this.endClaim(claimKey(y.claim, y.waiter));
      const outcome: AcceptOutcome = { result: 'REFUSED_RECORDED' };
      this.putRecord(key, { ...rec, answers: answered(outcome) });
      // C02 review 54 M3: the order "mark first, then refusal".
      const o = this.waiters.get(y.waiter);
      if (rec.mark?.waiting && o) this.requestYields(y.waiter, o, ts, key);
      return { outcome, entry: true };
    }
    this.occAll.add(h.window.start, h.window.end, -h.rateMbps);
    this.deleteIn(this.holds, key);
    this.endClaimsOnAttempt(key, h.attempt, claimKey(y.claim, y.waiter));
    this.deleteIn(this.yieldReqs, yieldKey(key, b.attempt, b.claim));
    const attempt = h.attempt + 1;
    const aheadDeadline = Math.max(this.latestBlockerDeadline(h.window, h.rateMbps), 0);
    this.insertWaiter(key, { cmd: h.cmd, attempt, aheadDeadline });
    const outcome: AcceptOutcome = { result: 'ACCEPTED', newWaiterAttempt: attempt };
    this.putRecord(key, {
      ...rec, state: 'WAITING', holdOutcome: { result: 'WAITING', attempt, aheadDeadline }, answers: answered(outcome), seq: this.seq,
    });
    this.scan(h.window.start, h.window.end, ts);
    return { outcome, entry: true };
  }

  /**
   * RFC-001 §4.3 `request_yields(w)`. The candidates are the holders that are younger than `w`, carry the waiting mark
   * and overlap a conflict range of `w`. The link asks them only if their capacity and the free capacity together let
   * `w` fit. It raises one yield request for each candidate that has no open request from `w` on its attempt, in a
   * claim identified by this entry's sequence. One entry raises at most one request on a holder attempt (DI-21).
   * With `mustInclude`, it raises nothing unless that holder is a candidate (a mark or a refusal of that holder).
   */
  private requestYields(key: string, w: Waiter, ts: HlcTs, mustInclude?: string): void {
    const b = w.cmd;
    // A waiter at or after its D_c cannot commit, so a yield for it is in vain (S-LINK I5 design issue DI-26).
    if (atOrAfterMs(ts, b.commitFence)) return;
    const ranges = this.occAll.conflicts(b.window.start, b.window.end, this.cRef - b.rateMbps);
    const holders = [...this.holds.entries()]
      .filter(([k, h]) => k !== key && comparePriority(h, b) > 0 && this.records.get(k)?.mark?.waiting === true
        && ranges.some((r) => overlaps(h.window, r)))
      .sort(([, x], [, y]) => comparePriority(x, y));
    if (holders.length === 0 || (mustInclude !== undefined && !holders.some(([k]) => k === mustInclude))) return;
    if (!this.yieldsSuffice(b, holders.map(([, h]) => h))) return;
    let raised = false;
    for (const [hk, h] of holders) {
      if (this.openRequestsOn(hk, h.attempt).some((y) => y.waiter === key || y.claim === this.seq)) continue;
      this.setIn(this.yieldReqs, yieldKey(hk, h.attempt, this.seq), {
        claim: this.seq, waiter: key, olderRequest: b.request, holder: hk, request: h.request, account: h.account, attempt: h.attempt,
      });
      this.notices.push({ request: h.request, account: h.account, attempt: h.attempt, kind: 'YIELD_REQUEST', claim: this.seq, olderRequest: b.request });
      raised = true;
    }
    if (raised) this.setIn(this.claims, claimKey(this.seq, key), { seq: this.seq, waiter: key, ranges });
  }

  /**
   * The sufficiency rule of RFC-001 §4.3: `peak(occ_all − Σ h, w.W) + w.b ≤ C_ref`. The window is cut where the sum of
   * the holders changes; on each piece the sum is constant. It reads `occ_all` and changes nothing.
   */
  private yieldsSuffice(b: HoldCmd, hs: ActiveHold[]): boolean {
    const { start, end } = b.window;
    const inside = (m: number | null): m is number => m !== null && m > start && (end === null || m < end);
    const cuts = [...new Set([start, ...hs.flatMap((h) => [h.window.start, h.window.end].filter(inside))])].sort((x, y) => x - y);
    for (const [i, s] of cuts.entries()) {
      const e = cuts[i + 1] ?? end;
      const freed = hs.reduce((n, h) => n + (overlaps(h.window, { start: s, end: s + 1 }) ? h.rateMbps : 0), 0);
      if (this.occAll.peak(s, e) - freed + b.rateMbps > this.cRef) return false;
    }
    return true;
  }

  /** True if an older waiter has a live claim whose ranges overlap the window of `b` (RFC-001 §4.3). */
  private insideOlderClaim(key: string, b: HoldCmd): boolean {
    for (const c of this.claims.values()) {
      if (c.waiter === key) continue;
      const o = this.waiters.get(c.waiter);
      if (o && comparePriority(o.cmd, b) < 0 && c.ranges.some((r) => overlaps(b.window, r))) return true;
    }
    return false;
  }

  /** The open yield requests on one holder attempt. */
  private openRequestsOn(holder: string, attempt: number): YieldRequest[] {
    return [...this.yieldReqs.values()].filter((y) => y.holder === holder && y.attempt === attempt);
  }

  /** End a claim: remove it and every open yield request of it (journaled). */
  private endClaim(ck: string): void {
    const c = this.claims.get(ck);
    if (!c) return;
    this.deleteIn(this.claims, ck);
    for (const [k, y] of [...this.yieldReqs]) if (y.claim === c.seq && y.waiter === c.waiter) this.deleteIn(this.yieldReqs, k);
  }

  /** A waiter that is granted, refused or released ends every claim that it has. */
  private endClaimsOfWaiter(key: string): void {
    for (const [ck, c] of [...this.claims]) if (c.waiter === key) this.endClaim(ck);
  }

  /** The end of a hold attempt ends every claim with a request on it, except `keep` (the claim that `yield_accept` names). */
  private endClaimsOnAttempt(holder: string, attempt: number, keep?: string): void {
    for (const y of this.openRequestsOn(holder, attempt)) {
      const ck = claimKey(y.claim, y.waiter);
      if (ck !== keep) this.endClaim(ck);
    }
  }

  /** The open yield requests, by claim, then by holder. The owner sends each again with the same claim. */
  openYieldRequests(): YieldRequest[] {
    return [...this.yieldReqs.values()].sort((a, b) => (a.claim < b.claim ? -1 : a.claim > b.claim ? 1 : a.holder < b.holder ? -1 : a.holder > b.holder ? 1 : 0));
  }

  // ---------------- leg changes (RFC-001 §4.5; C02 "Leg-command sequencing"; I6) ----------------

  /**
   * `end_leg` and `reduce_parts`. The checks, in order: the leg is known (`UNKNOWN_RESERVATION`); (1) an applied
   * change id gets its recorded reply, or `MISMATCH` for another body; (4) a change id of a partition that does not
   * own the reservation gets `MISMATCH`; `applies` present exactly with cause `POL07` (`INVALID(applies)`, C4-4); a
   * well-formed minute and pieces (`INVALID`, DI-32); (3) a lower change id that the link never applied gets
   * `STALE_CHANGE`; every named part is on the leg (`UNKNOWN_PART`); no piece raises a rate (`INVALID(pieces)`,
   * DI-33); no pair names a reduction of this link (`UNKNOWN_REDUCTION`: the link has no reductions before I13).
   * (2) Otherwise the change is applied. Only an applied change writes an entry.
   */
  private legChange(op: 'end_leg' | 'reduce_parts', b: EndLegCmd | ReducePartsCmd, ts: HlcTs): Decision {
    const refuse = (o: Extract<LegChangeOutcome, { code: string }>): Decision => ({ outcome: o, entry: false, alert: o.code });
    const lk = legKey(b.reservation, b.leg);
    const leg = this.legs.get(lk);
    if (!leg) return refuse({ code: 'UNKNOWN_RESERVATION' });
    const ck = requestKey(b.changeId);
    const applied = leg.changes[ck];
    if (applied) {
      if (applied.digest !== digest({ op, body: b })) return refuse({ code: 'MISMATCH' });
      return { outcome: { result: 'CHANGED' }, entry: false, recordedSeq: applied.seq };
    }
    if (hexOf(b.changeId.partition) !== leg.owner) return refuse({ code: 'MISMATCH' });
    if ((b.cause === 'POL07') !== (b.applies !== undefined)) return refuse({ code: 'INVALID', field: 'applies' });
    if (op === 'end_leg' && !Number.isSafeInteger((b as EndLegCmd).fromMinute)) return refuse({ code: 'INVALID', field: 'fromMinute' });
    const named = op === 'reduce_parts' ? (b as ReducePartsCmd).parts : [];
    if (op === 'reduce_parts' && (!Array.isArray(named) || named.length === 0 || new Set(named.map((n) => n.part)).size !== named.length
      || !named.every((n) => wellFormedPieces(n.pieces)))) return refuse({ code: 'INVALID', field: 'pieces' });
    if (leg.lastApplied !== undefined && b.changeId.seq <= leg.lastApplied.seq) {
      return { outcome: { result: 'STALE_CHANGE', lastApplied: leg.lastApplied }, entry: false };
    }
    const keys = named.map((n) => partKey(b.reservation, b.leg, n.part));
    if (keys.some((k) => !leg.parts.includes(k))) return refuse({ code: 'UNKNOWN_PART' });
    const next = named.map((n, i) => {
      const p = this.parts.get(keys[i] as string) as LegPart;
      const old = piecesOf(p);
      return { key: keys[i] as string, p, old, pieces: setPieces(old, p.window, n.pieces), first: (n.pieces[0] as Piece).from };
    });
    if (next.some((x) => raises(x.old, x.pieces, x.p.window))) return refuse({ code: 'INVALID', field: 'pieces' });
    if ((b.applies ?? []).some((r) => r.link === this.link)) return refuse({ code: 'UNKNOWN_REDUCTION' });

    // Apply. The freed range is [the least first freed minute, the largest end) over the changed parts.
    let freedStart = Infinity;
    let freedEnd: number | null = -Infinity;
    const freed = (s: number, e: number | null): void => {
      freedStart = Math.min(freedStart, s);
      freedEnd = freedEnd === null || e === null ? null : Math.max(freedEnd, e);
    };
    let effective: number;
    if (op === 'end_leg') {
      const t = (b as EndLegCmd).fromMinute;
      effective = t;
      for (const k of leg.parts) {
        const p = this.parts.get(k) as LegPart;
        const w = endFrom(p.window, t);
        if (w === p.window) continue;
        this.replaceContribution(k, p, { ...p, window: w });
        freed(w.end as number, p.window.end);
      }
      this.setIn(this.legs, lk, { ...leg, ends: [...leg.ends, { seq: b.changeId.seq, fromMinute: t }] });
    } else {
      effective = Math.min(...next.map((x) => x.first));
      for (const x of next) {
        this.replaceContribution(x.key, x.p, { ...x.p, pieces: x.pieces });
        const s = Math.max(x.p.window.start, x.first);
        if (x.p.window.end === null || s < x.p.window.end) freed(s, x.p.window.end);
      }
    }
    const cur = this.legs.get(lk) as LegRecord;
    this.setIn(this.legs, lk, { ...cur, lastApplied: b.changeId, changes: { ...cur.changes, [ck]: { digest: digest({ op, body: b }), seq: this.seq } } });
    // Every change scans the waiters over the freed range (RFC-001 §4.5).
    if (freedStart !== Infinity) this.scan(freedStart, freedEnd, ts);
    // A change that arrives after its effective minute is applied as decided, from that minute, and alerted (§4.5).
    const late = atOrAfterMs(ts, effective * 60_000);
    return { outcome: { result: 'CHANGED' }, entry: true, ...(late ? { alert: 'LATE_CHANGE' } : {}) };
  }

  /**
   * Replace a part, and its pulses in `occ_firm` and `occ_all` (journaled). Only the net impulses go to the trees, so a
   * change that leaves the rate as it was does not change the `occ_all` change counter (the counter-offer cache, §4.2).
   */
  private replaceContribution(key: string, old: LegPart, next: LegPart): void {
    const delta = new Map<number, number>();
    const put = (t: number, d: number): void => { delta.set(t, (delta.get(t) ?? 0) + d); };
    for (const [sign, p] of [[-1, old], [1, next]] as const) {
      for (const g of segments(piecesOf(p), p.window)) {
        put(g.s, sign * g.b);
        if (g.e !== null) put(g.e, -sign * g.b);
      }
    }
    for (const [t, d] of delta) {
      this.occFirm.impulse(t, d);
      this.occAll.impulse(t, d);
    }
    this.setIn(this.parts, key, next);
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
    if (rec.state === 'HELD') {
      const attempt = (this.holds.get(key) as ActiveHold).attempt;
      const open = this.openRequestsOn(key, attempt).sort((a, b) => (a.claim < b.claim ? -1 : a.claim > b.claim ? 1 : 0))
        .map((y) => ({ claim: y.claim, olderRequest: y.olderRequest }));
      return { state: 'HELD', attempt, ...(open.length > 0 ? { openYieldClaims: open } : {}) };
    }
    if (rec.state === 'WAITING') {
      const w = this.waiters.get(key) as Waiter;
      return { state: 'WAITING', attempt: w.attempt, aheadDeadline: w.aheadDeadline };
    }
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

  /** The waiters in priority order. */
  waitersInOrder(): Waiter[] {
    return this.waitOrder.map((k) => this.waiters.get(k) as Waiter);
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

/** A held or a waiting request: its record stays in memory, and stays live, for as long as it is. */
function isLive(r: RequestRecord): boolean {
  return r.state === 'HELD' || r.state === 'WAITING';
}

/**
 * The waiter priority order of RFC-001 §4.3 (`priority_rule` = `request_age`, POL-02): the older `request_age`
 * first, ties by request identity (account partition bytes, then sequence; RFC-000 §4.5).
 */
export function comparePriority(a: Pick<HoldCmd, 'requestAge' | 'request'>, b: Pick<HoldCmd, 'requestAge' | 'request'>): number {
  const age = compareHlc(a.requestAge, b.requestAge);
  if (age !== 0) return age;
  const part = Buffer.compare(Buffer.from(a.request.partition), Buffer.from(b.request.partition));
  if (part !== 0) return part;
  return a.request.seq < b.request.seq ? -1 : a.request.seq > b.request.seq ? 1 : 0;
}

function overlaps(w: Window, r: { start: number; end: number | null }): boolean {
  const wEndAfterRStart = w.end === null || w.end > r.start;
  const rEndAfterWStart = r.end === null || r.end > w.start;
  return wEndAfterRStart && rEndAfterWStart;
}

/** A validity rule of RFC-001 §2. */
export type ValidityRule = 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6';

/**
 * The first rule of V1 … V6 (RFC-001 §2, P1-S19, P1-S74) that the hold breaks, or undefined. The rules are
 * relative to the receipt minute m0 that the hold carries, never to `ts`. H is `selling_horizon` calendar
 * months after m0, in UTC, clamped to the month end. A receipt minute that is not a whole minute fails V4,
 * because `s ≥ m0` cannot be shown (S-LINK I4 design issue DI-16).
 */
export function invalidRule(b: HoldCmd, rules: LinkPolicy): ValidityRule | undefined {
  if (!Number.isSafeInteger(b.rateMbps) || b.rateMbps < rules.rateMinMbps) return 'V1';
  const { start, end } = b.window;
  if (!Number.isSafeInteger(start) || (end !== null && !Number.isSafeInteger(end))) return 'V2';
  if (end !== null && end <= start) return 'V3';
  if (!Number.isSafeInteger(b.receiptMinute) || start < b.receiptMinute) return 'V4';
  const h = horizonMinute(b.receiptMinute, rules.sellingHorizonMonths);
  // `!(s < H)`, so that an H out of the range of a date (NaN) also fails V5.
  if (!(start < h)) return 'V5';
  if (end !== null && end > h) return 'V6';
  return undefined;
}

const VERSION = /^[1-9][0-9]*$/;

/** True if the policy has a version and every parameter is a whole number in its range. */
function wellFormedPolicy(p: LinkPolicy): boolean {
  const atLeast = (x: number, min: number): boolean => Number.isSafeInteger(x) && x >= min;
  return typeof p.version === 'string' && VERSION.test(p.version)
    && atLeast(p.releaseGraceMs, 0) && atLeast(p.requestRecordTtlMs, 1) && atLeast(p.rateMinMbps, 1)
    && atLeast(p.sellingHorizonMonths, 1) && atLeast(p.counterofferSteps, 1) && atLeast(p.counterofferBatchSteps, 1)
    && atLeast(p.scanSteps, 1);
}

function fenceBelow(a: WriterFence, b: WriterFence): boolean {
  return a.generation < b.generation || (a.generation === b.generation && a.epoch < b.epoch);
}

function claimKey(seq: bigint, waiter: string): string {
  return `${seq}|${waiter}`;
}

function yieldKey(holder: string, attempt: number, claim: bigint): string {
  return `${holder}|${attempt}|${claim}`;
}

function partKey(reservation: string, leg: string, part: string): string {
  return `${reservation}|${leg}|${part}`;
}

function hexOf(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

/**
 * The clip minute of a part that a `convert` creates (RFC-001 §4.4; C02 V61-1): the earliest minute of the applied
 * `end_leg`s of the leg with a change id above `createdBy`, or undefined. A change id of another partition is never
 * applied (rule 4), so the sequences compare.
 */
function clipOf(leg: LegRecord, createdBy: ChangeId): number | undefined {
  let clip: number | undefined;
  for (const e of leg.ends) if (e.seq > createdBy.seq && (clip === undefined || e.fromMinute < clip)) clip = e.fromMinute;
  return clip;
}

export { fenceBelow };
