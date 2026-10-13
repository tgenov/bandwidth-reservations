/**
 * C10 v1.0.0 (frozen): booking API wire types. Only `book` and `status` are served in AM-I1.
 * Names are copied from C10 "Types (TypeScript)".
 */

export type Instant = string;
export type Minute = string;
export type Micros = string;
export interface Money { currency: 'USD'; micros: Micros }
export interface Price { currency: 'USD'; micros_per_mbps_minute: string }
export interface Window { start: Minute; end: Minute | null }
export interface LinkRef { link_id: string; leg_index: number }

export interface BookRequest {
  legs: string[];
  window: Window;
  rate_mbps: number;
  product_id: string;
  wait?: boolean;
  deadline_ms?: number;
  quote_id?: string;
}

export type FinalOutcome = 'confirmed' | 'rejected' | 'invalid' | 'failed';
export type RequestState = 'pending' | FinalOutcome;

export type ReasonCode =
  | 'no_fit' | 'in_flight' | 'partner_refused'
  | 'rule_at_most_one_leg_without_holds' | 'rule_route_changed_as_one_unit'
  | 'rule_decrease_not_allowed_by_partner_terms'
  | 'quote_required' | 'terms_changed'
  | 'account_suspended' | 'key_inflight_limit' | 'account_inflight_limit'
  | 'insufficient_funds' | 'key_spend_limit'
  | 'unknown_route' | 'product_not_on_route'
  | 'invalid_window' | 'invalid_rate' | 'invalid_deadline' | 'beyond_selling_horizon'
  | 'deadline_passed' | 'deadline_passed_while_waiting' | 'interrupted_by_internal_failure'
  | 'withdrawn' | 'key_revoked' | 'reservation_ended' | 'reservation_changed_by_share';

export interface CounterOffer {
  largest_rate_mbps: number;
  earliest_window: Window | null;
  blocking_link: LinkRef;
  share_legs_only: boolean;
}

export interface ResumeAmount {
  total: Money;
  written_off: Money;
  overdue_invoices: { invoice_id: string; amount: Money }[];
  headroom_part: Money;
  headroom_after?: Money;
}

export interface RejectionAmounts {
  top_up_min?: Money;
  top_up_min_plus_low_balance_warning?: Money;
  resume?: ResumeAmount;
}

export interface PartnerLegTerms {
  leg_index: number;
  link_id: string;
  decrease_allowed: boolean;
  shorten_allowed: boolean;
  holds: boolean;
  fees: unknown[];
}

export interface ShownTerms {
  price: Price;
  price_version: string;
  announced_price_change?: { price: Price; price_version: string; effective: Minute };
  partner_legs: PartnerLegTerms[];
}

export interface RequestStatus {
  request_id: string;
  idempotency_key: string;
  request_kind: 'booking' | 'change' | 'preemptive_withdrawal';
  reservation_id?: string;
  state: RequestState;
  deadline?: Instant;
  decided_at?: Instant;
  key_expires_at: Instant;
  reason?: ReasonCode;
  rule?: string;
  counter_offer?: CounterOffer;
  retry_after_ms?: number;
  amounts?: RejectionAmounts;
  shown?: ShownTerms;
}

export interface NotAccepted {
  error: 'not_accepted';
  code: 'key_reuse_different_request' | 'key_reuse_other_principal' | 'rate_limited' | 'poll_limited' | 'malformed';
  limit?: 'key_rate_limit' | 'account_rate_limit' | 'key_poll_limit' | 'mgmt_rate_limit';
  retry_after_ms?: number;
}

export interface ErrorAnswer {
  error: 'unauthenticated' | 'not_found' | 'refused' | 'temporarily_unavailable' | 'invalid';
  right?: string;
  rule?: string;
}

/** One answer of the owner to the edge: the HTTP status and the C10 body. */
export type C10Answer =
  | { http: 200 | 202; body: RequestStatus }
  | { http: 400 | 409 | 429; body: NotAccepted; retryAfterS?: number }
  | { http: 401 | 403 | 404 | 422; body: ErrorAnswer }
  | { http: 503; body: ErrorAnswer; retryAfterS: number };

/** C10 "Units": an idempotency key is 1 … 128 of [A-Za-z0-9._:-] with at least one alphanumeric. */
export function isValidIdempotencyKey(k: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(k) && /[A-Za-z0-9]/.test(k);
}

/** C10 "Timeouts and deadlines". */
export const C10_PARAMS = {
  ackBudgetMs: 200,
  edgeShareMs: 20,
  deadlineDefaultMs: 30_000,
  deadlineMinMs: 1_000,
  deadlineMaxMs: 60_000,
  idempotencyRetentionMs: 24 * 3_600_000,
  rateMinMbps: 1,
} as const;
