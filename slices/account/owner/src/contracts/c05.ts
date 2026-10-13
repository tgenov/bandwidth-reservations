/**
 * C05 v1 (frozen): funds and standing. The TypeScript surface of the in-process module interface.
 *
 * Names and fields are copied from C05 "Schema". Types that C05 takes from C06 and C08 are imported
 * from the local copies of those contracts. Do not change a field here without a C05 revision.
 */
import type { SignedKeyRecord } from './c08.ts';

// ---------- Primitives ----------

export type Micros = bigint;
export type Picos = bigint;
export type Mbps = bigint;
export type UtcMinute = bigint;
export type Millis = bigint;
export type EpochMs = bigint;

/** Database hybrid-logical-clock commit timestamp. Ordered by (wallNanos, logical). */
export interface HlcTimestamp { wallNanos: bigint; logical: number }

export type AccountId = string;
export type PrincipalId = string;
export type KeyId = string;
export type ReservationId = string;
export type PartId = string;
export type InvoiceId = string;
export type ProductId = string;
export type RouteId = string;
export type PriceVersion = string;
export type RulesVersion = string;
export type BatchId = string;

/** (account partition, sequence) of an entry in the account log. A request's id is its intake's position. */
export interface LogPosition { partition: AccountId; sequence: bigint }
export type RequestId = LogPosition;

export interface LedgerPosition { ledgerPartition: string; sequence: bigint; commitTs: HlcTimestamp }
export interface RatingPosition { ratingPartition: string; generation: number; seq: bigint }
export interface FeedPosition { source: string; partition: string; seq: bigint }
export interface MinuteInterval { start: UtcMinute; end: UtcMinute | null }

// ---------- Context, schedule and ask ----------

export interface Ctx { pos: LogPosition; ts: HlcTimestamp; rules: RulesVersion }

export interface RatePiece { from: UtcMinute; mbps: Mbps }

export interface Part {
  part: PartId;
  rate: RatePiece[];
  lockedPrice: Picos;
  interval: MinuteInterval;
  age: HlcTimestamp;
}

export interface PriceStep { priceVersion: PriceVersion; price: Picos; effectiveMinute: UtcMinute }

export interface Segment { part: PartId; interval: MinuteInterval; principal: PrincipalId; key?: KeyId }

export interface Schedule {
  parts: Part[];
  priceSteps: PriceStep[];
  segments: Segment[];
  end?: UtcMinute | null;
  effectiveMinute?: UtcMinute;
}

export interface FeeTerms {
  fee: Micros;
  kind: 'plain' | 'minimum_term';
  termEnd: UtcMinute | null;
  dueAtWindowEnd: boolean;
}

export type ChangeKind = 'Increase' | 'Extend' | 'Decrease' | 'Shorten';

export interface QueuedChange {
  request: RequestId;
  kind: ChangeKind;
  newEnd?: UtcMinute | null;
  newRate?: Mbps;
  addedMbps?: Mbps;
  interval?: MinuteInterval;
  lockedPrice?: Picos;
  priceVersion?: PriceVersion;
  addingKey?: KeyId;
}

export interface ProvisionalKeyRecord {
  signedBytes: Uint8Array;
  record: SignedKeyRecord;
}

export interface Ask {
  request: RequestId;
  principal: PrincipalId;
  key?: KeyId;
  provisionalKey?: ProvisionalKeyRecord;
  kind: 'New' | 'Increase' | 'Extend';
  scheduleAfter: Schedule;
  scheduleBefore?: Schedule;
  change?: {
    interval: MinuteInterval;
    addedMbps?: Mbps;
    addingPrincipal: PrincipalId;
    addingKey?: KeyId;
  };
  ahead?: QueuedChange[];
  feeTerms?: FeeTerms;
  mbps: Mbps;
}

// ---------- Verdicts, inputs and outcomes ----------

export interface ResumeQuote {
  total: Micros;
  writtenOff: Micros;
  overdue: { invoice: InvoiceId; unpaid: Micros }[];
  headroomPart: Micros;
  /** Optional, additive (CI4-2, RFC-004 A10): the headroom once `total` is applied. */
  headroomAfter?: Micros;
}

export interface Checked { headroom: Micros; keyHeadroom?: Micros }

export type RefuseReason =
  | { kind: 'Suspended'; ra: ResumeQuote }
  | { kind: 'KeyInflight'; limit: Mbps }
  | { kind: 'AccountInflight'; limit: Mbps }
  | { kind: 'InsufficientFunds'; min: Micros; minPlusLbw: Micros }
  | { kind: 'KeySpendLimit'; keyHeadroom: Micros };

export type Verdict =
  | { kind: 'Admit'; hold: Micros; holdKind: 'Funds' | 'Credit'; mbps: Mbps; checked: Checked }
  | { kind: 'Refuse'; checked: Checked; reason: RefuseReason };

export type RateCheckResult =
  | { kind: 'Accept' }
  | { kind: 'NotAccepted'; reason: 'rate'; retryAfterMs: Millis }
  | { kind: 'NotAccepted'; reason: 'revoked' };

export type EndCause = 'cancelled' | 'shortened_to_end' | 'revoked' | 'released' | 'terminated' | 'window_end' | 'moved';

export type BookingInput =
  | { kind: 'Intake'; request: RequestId; ask: Ask; verdict: Verdict }
  | { kind: 'Decided'; request: RequestId;
      outcome: { kind: 'Confirmed'; reservation: ReservationId; schedule: Schedule } | { kind: 'NotConfirmed' } }
  | { kind: 'ReservationChanged'; reservation: ReservationId; schedule: Schedule;
      effectiveMinute: UtcMinute;
      end?: { cause: EndCause; feeDue: Micros };
      feeDue?: Micros }
  | { kind: 'PriceTookEffect'; reservation: ReservationId; priceVersion: PriceVersion; effectiveMinute: UtcMinute };

export interface HoldChange {
  target: { request: RequestId } | { reservation: ReservationId };
  from: Micros; to: Micros; holdKind: 'Funds' | 'Credit';
  state?: 'Requested' | 'Released' | 'Rolling' | 'Frozen' | 'Draining' | 'Closed';
}

export type Notice =
  | { kind: 'Suspended'; stdSeq: bigint; ra: ResumeQuote }
  | { kind: 'Resumed'; stdSeq: bigint }
  | { kind: 'LowBalanceWarning'; wq: Micros }
  | { kind: 'ReleasedAfterGrace'; reservations: ReservationId[] }
  | { kind: 'PriceNotice'; priceVersion: PriceVersion; effectiveMinute: UtcMinute;
      perReservation: { reservation: ReservationId; newPrice: Picos; holdNeeded: Micros }[];
      growth: Micros; covered: boolean; topUp?: Micros };

export type Alert =
  | { code: 'ENFORCEMENT_ACK_MISSING'; stdSeq: bigint; target: EpochMs }
  | { code: 'LATE_ENFORCEMENT'; stdSeq: bigint; target: EpochMs; enforcedAt?: EpochMs }
  | { code: 'ENFORCEMENT_ACK_CONFLICT'; stdSeq: bigint; first: EpochMs; second: EpochMs }
  | { code: 'ENFORCEMENT_ACK_UNEXPECTED'; stdSeq: bigint; enforcedAt: EpochMs }
  | { code: 'KEY_ABSENT_FROM_SNAPSHOT'; key: KeyId };

export type Standing = 'active' | 'suspended';
export type Cause = 'headroom' | 'invoice' | 'written_off';

/** C05 §Kafka messages. Only the fields AM-I1 needs; the standing feed is AM-I11. */
export interface StandingEvent { account: AccountId; standing: Standing; stdSeq: bigint; since: HlcTimestamp }

export type OutboxEvent =
  | { stream: 'standing'; event: StandingEvent }
  | { stream: 'usage_applied'; event: unknown /* C06 UsageApplied (MONEY-I3) */ };

export interface Outcomes {
  holdChanges: HoldChange[];
  standing?: { from: Standing; to: Standing; stdSeq: bigint; causes: Cause[]; ra?: ResumeQuote };
  warning?: { wq: Micros };
  notices: Notice[];
  releaseDue?: ReservationId[];
  revokedKeys?: KeyId[];
  alerts: Alert[];
  outbox: OutboxEvent[];
}

// ---------- Funds entry kinds F1 … F11 ----------

export interface F1 { kind: 'F1'; ledgerPos: LedgerPosition; feed: FeedPosition[];
  movements: { movementKind: string; amount: Micros; sourceRef: string;
               cause?: { invoice?: InvoiceId };
               batch?: { batch: BatchId; batchKind: 'reservation' | 'usage'; postedWhole?: boolean } }[];
  balance: Micros;
  writtenOffOwed: Micros;
  postedThrough: { allThrough?: UtcMinute; exceptions: { reservation: ReservationId; through: UtcMinute }[] };
  feesPosted: ReservationId[] }

export interface F2 { kind: 'F2'; feed: FeedPosition;
  perProduct: { product: ProductId; unposted: Micros }[];
  ratingPos: RatingPosition;
  computedAgainst: LedgerPosition;
  inFlight?: { batch: BatchId; reduction: Micros } }

export interface F3 { kind: 'F3'; cataloguePos: FeedPosition;
  perProduct: { product: ProductId; usageRateCap: Mbps; maxLateness: Millis; flowActiveTimeout: Millis;
                attributionLagMax: Millis; rtoAdm: Millis;
                highestUsagePrice: { inForce: Picos; changes: { effectiveAt: EpochMs; price: Picos }[] } }[] }

export type IdentityStatusChange =
  | { kind: 'key'; key: KeyId; version: bigint; status: 'active' | 'revoked';
      keySpendLimit?: Micros; keyInflightLimit?: Mbps; keyRateLimit?: bigint }
  | { kind: 'kyb'; version?: bigint; status: 'passed' | 'failed' | 'withdrawn' | 'none' };

export type F4 = { kind: 'F4' } & (
  | { source: 'push' | 'catch_up';
      events: (IdentityStatusChange & { identityPos: { partition: string; sequence: bigint }; commitTs: HlcTimestamp })[] }
  | { source: 'snapshot';
      position: HlcTimestamp;
      keys: Extract<IdentityStatusChange, { kind: 'key' }>[];
      kyb: Extract<IdentityStatusChange, { kind: 'kyb' }> } );

export type F5 = { kind: 'F5' } & (
  | { variant: 'set'; amount: Micros; principal: PrincipalId; reason: string; actionId: string;
      member?: AccountId;
      setScope?: { mapVersion: bigint; designatedAtMapVersion: bigint };
      iamFreshUsed: HlcTimestamp }
  | { variant: 'removed_by_operator'; principal: PrincipalId; reason: string; actionId: string }
  | { variant: 'removed_invoice_written_off'; invoice: InvoiceId; rcvPos: FeedPosition; ledgerPos: LedgerPosition;
      decidedAt: HlcTimestamp; superseded?: boolean } );

export type F6 = { kind: 'F6'; rcvPos: FeedPosition; ledgerPos: LedgerPosition } & (
  | { variant: 'overdue'; invoice: InvoiceId; unpaid: Micros; dueDate: UtcMinute }
  | { variant: 'paid'; invoice: InvoiceId }
  | { variant: 'written_off'; invoice: InvoiceId; amount: Micros } );

export type F7 = { kind: 'F7'; instant: EpochMs } & (
  | { variant: 'fee_term_ended'; reservation: ReservationId }
  | { variant: 'grace_ended' }
  | { variant: 'enforcement_check'; stdSeq: bigint; at: 60 | 120 }
  | { variant: 'price_effective'; priceVersion: PriceVersion; reservations: ReservationId[] }
  | { variant: 'exposure_step'; product: ProductId } );

export interface F8 { kind: 'F8'; feed: FeedPosition; stdSeq: bigint; enforcedAt: EpochMs }
export interface F9 { kind: 'F9'; excluded: boolean; mapVersion: bigint }
export interface F10 { kind: 'F10'; rules: RulesVersion }
export interface F11 { kind: 'F11'; priceVersion: PriceVersion; route: RouteId; newPrice: Picos;
  effectiveMinute: UtcMinute; catalogueRef: string; reservations: ReservationId[] }

export type FundsEntry = F1 | F2 | F3 | F4 | F5 | F6 | F7 | F8 | F9 | F10 | F11;

export type Input = BookingInput | FundsEntry;

// ---------- Headroom and standing answers ----------

export interface HeadroomAnswer {
  position: { log: LogPosition; ts: HlcTimestamp; ledger: LedgerPosition; rating?: RatingPosition };
  evaluatedAt: HlcTimestamp;
  headline: Micros;
  headlineKind: 'account' | 'key';
  key?: { key: KeyId; spending: Micros; limit: Micros; keyHeadroom: Micros };
  items: {
    balance: Micros;
    fundsHeld: Micros;
    creditHolds: Micros;
    usageExposure: { product: ProductId; unposted: Micros; latenessBound: Micros }[];
    accruedNotPosted: Micros;
    creditLimit: Micros;
    headroom: Micros;
  };
  standing: { standing: Standing; causes: Cause[]; ra?: ResumeQuote; overdue?: { invoice: InvoiceId; unpaid: Micros }[] };
  lowBalanceThreshold: Micros;
}

// ---------- The module interface ----------

export interface FundsState { readonly __brand: 'FundsState' }
export interface RateWindows { readonly __brand: 'RateWindows' }

export interface PrincipalCtx { principal: PrincipalId; tenant: AccountId; key?: KeyId; provisionalKey?: ProvisionalKeyRecord }

export interface DueTick { instant: EpochMs; payload: F7 }

export type ApplyResult =
  | { kind: 'Applied'; state: FundsState; outcomes: Outcomes }
  | { kind: 'Deferred' };

export interface FundsModule {
  rateCheck(soft: RateWindows, nowMs: EpochMs, who: PrincipalCtx): RateCheckResult;
  admit(s: FundsState, ctx: Ctx, ask: Ask): Verdict;
  apply(s: FundsState, ctx: Ctx, input: Input): ApplyResult;
  due(s: FundsState): DueTick[];
  answer(s: FundsState, ctx: Ctx, who: PrincipalCtx): HeadroomAnswer;
  standing(s: FundsState): { standing: Standing; since: HlcTimestamp | null; stdSeq: bigint };
}
