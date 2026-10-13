/**
 * C02 v1.0.0 (frozen) — the types of the link hold port and the link availability query that S-LINK provides.
 *
 * The names and the fields are copied from C02 "Schema". I1 provides `hold`, `convert` and `release`. I2 adds
 * the counter-offer, `query` and the availability query (`availability`, `fit_ranges`). I3 adds `hold` check (8)
 * `WAITING` and the link waiting port notifications `WAITING_NOTICE`, `GRANTED` and `WAITER_REFUSED`. I5 adds
 * `YIELD_REQUEST`, `mark_waiting`, `yield_accept` and `yield_refuse`. The other operations of C02 come in later
 * increments (S-LINK plan §6).
 */
import type { CommandEnvelope, Epoch, Generation, HlcTs, PartitionKey, RoutingRefusal, Seq } from '@share/owner-runtime';

export type { CommandEnvelope, RoutingRefusal };

// ---------- Identities and units (C02 "Conventions and units") ----------

export type LinkId = string;
export type AccountPartition = PartitionKey;
export type Hlc = HlcTs;
export type EpochMs = number;
export type DurationMs = number;
export type Minute = number;
export type Mbps = number;

/** (account partition, sequence) of an entry in the account log (RFC-002 §2.2). */
export interface LogRef { partition: AccountPartition; seq: Seq }
export type RequestId = LogRef;
export type ChangeId = LogRef;
export type ReservationId = string;
export type LegId = string;
export type PartId = string;
export type Attempt = number;
/** The link-log sequence of the entry that raised a yield request (C02 `ClaimSeq`). */
export type ClaimSeq = Seq;

/** Half-open window [start, end). `end: null` is open-ended. */
export interface Window { start: Minute; end: Minute | null }
export interface Fence { generation: Generation; epoch: Epoch }

export interface C02Body {
  link: LinkId;
  /** For a command to the link, this is the link id (C02 review 42 M2). */
  receiverPartition: string;
}
export interface LinkStamp { linkFence: Fence; linkSeq: Seq }

export type C02Error =
  | { code: 'MISMATCH' }
  | { code: 'UNKNOWN_LINK' }
  | { code: 'LINK_CLOSING' }
  | { code: 'LINK_RETIRED' };
export type Refusal = RoutingRefusal | C02Error;

// ---------- Link hold port ----------

export type HoldKind = { kind: 'booking' } | { kind: 'change'; reservation: ReservationId };

export interface HoldCmd extends C02Body {
  request: RequestId; account: AccountPartition; leg: LegId; holdKind: HoldKind;
  rateMbps: Mbps; window: Window;
  deadline: EpochMs;
  commitFence: EpochMs;
  requestAge: Hlc;
  wait: boolean;
  receiptMinute: Minute;
  policyVersion: Seq;
}

export interface CounterOffer {
  largestRateMbps: Mbps;
  earliest: { window: Window } | { none: true } | { notFoundBefore: Minute };
}

export type RefusalReason = 'NO_FIT' | 'IN_FLIGHT' | 'DEADLINE_PASSED' | 'TOMBSTONED'
  | { invalid: 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' };

/** The decision part of a hold reply. The reply adds the link stamp (`LinkStamp`). */
export type HoldOutcome =
  | { result: 'HELD'; attempt: Attempt }
  | { result: 'WAITING'; attempt: Attempt; aheadDeadline: EpochMs }
  | { result: 'REFUSED'; reason: RefusalReason; counterOffer?: CounterOffer; retryAfterMs?: DurationMs }
  | { result: 'RELEASED' }
  | { result: 'CONVERTED'; part: PartId };
export type HoldReply = (LinkStamp & HoldOutcome) | Refusal;

export interface ConvertCmd extends C02Body {
  request: RequestId; attempt: Attempt; reservation: ReservationId; leg: LegId; part: PartId;
  createdBy: ChangeId;
  decisionTime: Hlc;
}
export type ConvertOutcome =
  | { result: 'CONVERTED'; part: PartId; clippedAt?: Minute }
  | { code: 'NO_HOLD' } | { code: 'TOMBSTONED' } | { code: 'MISMATCH' };
export type ConvertReply = (LinkStamp & { result: 'CONVERTED'; part: PartId; clippedAt?: Minute })
  | { code: 'NO_HOLD' } | { code: 'TOMBSTONED' } | Refusal;

export interface ReleaseCmd extends C02Body {
  request: RequestId; deadline: EpochMs;
  reason: 'WITHDRAWN' | 'EXPIRED' | 'REJECTED' | 'FAILED' | 'ENDED';
  decisionTime: Hlc;
}
export type ReleaseOutcome = { result: 'RELEASED'; tombstoneUntil: EpochMs };
export type ReleaseReply = (LinkStamp & ReleaseOutcome) | Refusal;

export interface QueryCmd extends C02Body { request: RequestId }
/** The decision part of a query reply. The reply adds the link stamp. No displacement before I11. */
export interface QueryState {
  state: 'UNSEEN' | 'HELD' | 'WAITING' | 'DISPLACED' | 'REFUSED' | 'RELEASED' | 'CONVERTED';
  attempt?: Attempt; aheadDeadline?: EpochMs;
  refusal?: { reason: RefusalReason; counterOffer?: CounterOffer; retryAfterMs?: DurationMs };
  /** The open yield requests on the present hold attempt (I5). Absent when there is none. */
  openYieldClaims?: { claim: ClaimSeq; olderRequest: RequestId }[];
  tombstoneUntil?: EpochMs;
}
export type QueryReply = (LinkStamp & QueryState) | Refusal;

// ---------- Link waiting port (notifications, link → account owner) ----------

/** The notification kinds of the link waiting port that I3 and I5 send. `DISPLACED` is I11. */
export type WaitingKind = 'WAITING_NOTICE' | 'GRANTED' | 'WAITER_REFUSED' | 'YIELD_REQUEST';

/** The content of a waiting-port notification after its identity (link, request, attempt, kind). */
export type WaitingContent =
  | { kind: 'WAITING_NOTICE'; aheadDeadline: EpochMs }
  | { kind: 'GRANTED' }
  | { kind: 'WAITER_REFUSED'; reason: 'NO_FIT'; counterOffer: CounterOffer }
  | { kind: 'YIELD_REQUEST'; claim: ClaimSeq; olderRequest: RequestId };

/**
 * C02 `WaitingNotification`: a point-to-point state message. Identity: (link, request, attempt, kind), and the
 * claim for `YIELD_REQUEST`. It carries the link's fence and the log sequence of the entry that it reflects.
 */
export type WaitingNotification = LinkStamp & { link: LinkId; request: RequestId; attempt: Attempt } & WaitingContent;

/** C02 `mark_waiting` (account owner → link): the waiting mark of a request, in the order of `position`. */
export interface MarkWaitingCmd extends C02Body {
  request: RequestId; waiting: boolean;
  /** The account-log sequence of the E2 (or of the entry that leaves Waiting) that the mark reflects. */
  position: Seq;
}
export type MarkWaitingOutcome = { result: 'APPLIED' | 'IGNORED_OLDER' };
export type MarkWaitingReply = (LinkStamp & MarkWaitingOutcome) | Refusal;

// ---------- Outcome and expiry port: yield answers ----------

/** C02 `YieldAnswerCmd`: the answer of the account owner to one `YIELD_REQUEST`. */
export interface YieldAnswerCmd extends C02Body {
  /** The attempt that the YIELD_REQUEST named. */
  request: RequestId; attempt: Attempt;
  /** The claim that the YIELD_REQUEST named. */
  claim: ClaimSeq;
  answer: 'yield_accept' | 'yield_refuse';
}
export type AcceptOutcome =
  | { result: 'ACCEPTED'; newWaiterAttempt: Attempt }
  | { result: 'REFUSED_RECORDED' }
  | { result: 'STALE_ATTEMPT' };
export type AcceptReply = (LinkStamp & AcceptOutcome) | Refusal;

// ---------- Link availability query ----------

export interface AvailabilityQuery extends C02Body { window: Window; rateMbps: Mbps }
export type AvailabilityReply = (LinkStamp & { asOfSeq: Seq; offer: CounterOffer }) | Refusal;

export interface FitRangesQuery extends C02Body { rateMbps: Mbps; from: Minute; until: Minute; k: number }
export interface FitRanges {
  /** Up to k maximal ranges in [from, until) where occ_all + rate ≤ C_ref. */
  ranges: Window[];
  /** null: the search went to `until`. */
  continueFrom: Minute | null;
}
export type FitRangesReply = (LinkStamp & { asOfSeq: Seq } & FitRanges) | Refusal;

// ---------- Commands as the link applies them ----------

export type LinkCommand =
  | { op: 'hold'; body: HoldCmd }
  | { op: 'convert'; body: ConvertCmd }
  | { op: 'release'; body: ReleaseCmd }
  | { op: 'mark_waiting'; body: MarkWaitingCmd }
  | { op: 'yield'; body: YieldAnswerCmd };

export type LinkOp = LinkCommand['op'];

/** A reply as the port sends it, for each operation. */
export interface ReplyOf { hold: HoldReply; convert: ConvertReply; release: ReleaseReply; mark_waiting: MarkWaitingReply; yield: AcceptReply }
export type BodyOf<O extends LinkOp> = Extract<LinkCommand, { op: O }>['body'];

/** The text key of a request identity (account partition in hex, then the sequence). */
export function requestKey(r: RequestId): string {
  return `${Buffer.from(r.partition).toString('hex')}:${r.seq.toString()}`;
}

export function isRoutingRefusal(x: unknown): x is RoutingRefusal {
  return typeof x === 'object' && x !== null && 'code' in x && !('result' in x)
    && ['STALE_EPOCH', 'NOT_OWNER', 'MOVED', 'MOVING', 'STOPPED', 'STALE_SENDER', 'OVERLOADED', 'UNAVAILABLE']
      .includes((x as { code: string }).code);
}
