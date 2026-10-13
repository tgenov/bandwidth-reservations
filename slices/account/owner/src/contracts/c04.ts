/**
 * C04 v2.3.1 (frozen): the request outcome event and the lifecycle event `confirmed`.
 * Only the variants AM-I1 emits. Names are copied from C04 "Schema".
 */
import type { HlcTs, Seq, SlotNo } from '@share/owner-runtime';

export type UtcMinute = string;
export type Mbps = number;
export type MicroUsd = string;
export type PicoUsdPerMbpsMin = string;
export type AccountId = string;
export type RequestId = string;
export type ReservationId = string;
export type PartId = string;
export type LinkId = string;
export type CatalogueRouteId = string;
export type ProductId = string;
export type PriceVersion = string;
export type PrincipalRef = string;
export type KeyRef = string;
export type UtcInstant = string;

export interface PayloadBase {
  account: AccountId;
  entry_seq: Seq;
  withheld_by: string | null;
}

export type Outcome = 'confirmed' | 'rejected' | 'invalid' | 'failed';

export interface CounterOffer {
  largest_rate: Mbps;
  earliest_window: { start: UtcMinute; end: UtcMinute | null } | null;
  share_legs_only: boolean;
}

export type OutcomeReason =
  | { code: 'confirmed' }
  | { code: 'invalid'; rule: string }
  | { code: 'insufficient_funds'; needed: MicroUsd; available: MicroUsd }
  | { code: 'limit'; limit: string }
  | { code: 'account_suspended'; resume_amount: MicroUsd; items: { label: string; amount: MicroUsd }[] }
  | { code: 'no_fit'; blocking_link: LinkId; counter_offer: CounterOffer };

export interface OutcomeEvent extends PayloadBase {
  slot: SlotNo;
  request: RequestId;
  idempotency_key_digest: string;
  principal: PrincipalRef;
  request_kind: 'book' | 'change';
  change_kind: 'cancel' | 'shorten' | 'extend' | 'increase' | 'decrease' | null;
  reservation: ReservationId | null;
  outcome: Outcome;
  reason: OutcomeReason;
  decided_ts: HlcTs;
  stated_time: UtcInstant;
  leg: number | null;
  answered_pending: boolean;
}

export interface Leg {
  index: number;
  link: LinkId;
  kind: 'share' | 'partner_with_holds' | 'partner_without_holds';
  shown_fee: null;
}

export interface LifecyclePart {
  part: PartId;
  own_rate: Mbps;
  window: { start: UtcMinute; end: UtcMinute | null };
  locked_price: PicoUsdPerMbpsMin;
  price_version: PriceVersion;
  catalogue_position: string;
  locked_at: HlcTs;
  age: HlcTs;
  request: RequestId;
  added_by: { principal: PrincipalRef; key: KeyRef | null };
}

export interface LifecycleBase extends PayloadBase {
  account_is_probe: boolean;
  reservation: ReservationId | null;
  change_id: string | null;
}

export interface Confirmed extends LifecycleBase {
  kind: 'confirmed';
  route: CatalogueRouteId;
  product: ProductId;
  path: '0';
  legs: Leg[];
  window: { start: UtcMinute; end: UtcMinute | null };
  parts: LifecyclePart[];
  decided_ts: HlcTs;
  announced_price_steps: { price_version: PriceVersion; effective: UtcMinute }[];
  booked_by: { principal: PrincipalRef; key: KeyRef | null };
}
