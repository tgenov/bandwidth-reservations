/**
 * C02 v1.0.0 (frozen) — the types of the link hold port and the link availability query that S-LINK provides.
 *
 * The names and the fields are copied from C02 "Schema". I1 provides `hold`, `convert` and `release`. I2 adds
 * the counter-offer, `query` and the availability query (`availability`, `fit_ranges`). The other operations
 * of C02 come in later increments (S-LINK plan §6).
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
/** The decision part of a query reply. The reply adds the link stamp. I2 has no waiter, displacement or yield claim. */
export interface QueryState {
  state: 'UNSEEN' | 'HELD' | 'WAITING' | 'DISPLACED' | 'REFUSED' | 'RELEASED' | 'CONVERTED';
  attempt?: Attempt; aheadDeadline?: EpochMs;
  refusal?: { reason: RefusalReason; counterOffer?: CounterOffer; retryAfterMs?: DurationMs };
  tombstoneUntil?: EpochMs;
}
export type QueryReply = (LinkStamp & QueryState) | Refusal;

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
  | { op: 'release'; body: ReleaseCmd };

export type LinkOp = LinkCommand['op'];

/** A reply as the port sends it, for each operation. */
export interface ReplyOf { hold: HoldReply; convert: ConvertReply; release: ReleaseReply }
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
