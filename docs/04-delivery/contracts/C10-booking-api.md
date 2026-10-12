# C10. Booking API

| | |
|---|---|
| Contract ID | C10 |
| Name | `booking-api` |
| Version | 1.0.0-draft.2 |
| Status | **Draft**, for contract review. The open points M1 … M9 are settled by the orchestrator's binding decisions (see [Settled](#settled)); RFC-002 takes `quote` and `TERMS_CHANGED` as errata (M2) |
| Provider | RFC-002 (account owner, booking module) for book, change, cancel, withdraw, status, quote and offer answers; RFC-005 for the edge (authentication, coarse authorisation, routing, poll limiter) and for the documented-request intake (operator console) |
| Consumers | Buyers through RFC-005's edge: account users, account administrators, agent keys (AI agents and other automated clients), probe keys (probe links only) |
| Transport | **HTTP/JSON** at the public edge (TLS 1.3); the edge forwards each submission once by gRPC to the owner-lease holder of the account's slot (RFC-002 §3.1, RFC-005 §2.2) and documented requests to the operator console (RFC-005 §4.4, §7.5). The gRPC hop is internal and not part of this contract |
| Pinned to | `requirements-v1.10`; RFC-000 revision 4.4 (§8 rows "Booking API" and "Documented-request intake"; C4-7); RFC-002 revision 5 (§3, §4.1, §5.8, §6.2, §6.5, §7.1, §7.2, §8, §9.1 … §9.6, §13.1); RFC-005 revision 5 (§2.1 … §2.3, §4.1 … §4.3, §5.2, §5.3, §7.5, C1, C2, §13); RFC-004 revision 5 with erratum 5.1, cited only for the refusal reasons and the resume quote the booking module passes through (§A5.1, §A10 `Verdict`, `ResumeQuote`) |

## Purpose

The one external interface by which a buyer principal creates, changes and ends its
account's reservations, follows each request to its single outcome, answers an
equivalent-path offer made under POL-07, and asks support to act for it (a documented
request, POL-32). It fixes the wire form of what RFC-002 §13.1 and RFC-005 §7.5 promise, plus a `quote`
operation that shows every figure before booking (M2):
an answer within `ack_budget` (final, `pending`, or not accepted), idempotency per
(account, key), status reads that never contradict the decided outcome and never return
to `pending` after a reported outcome, rejections that are counter-offers with the
amounts and the itemised resume amount, and the fees shown at booking with their kind
and whether they fall due at the window's end.

Out of scope (other contracts): outcome webhooks and the notice list (signed webhook,
RFC-005 C8 and RFC-006); erasure requests and recovery objections (RFC-005 C12, §3.8);
balance, headroom, statements and reservation listings (reporting); key and user
management (identity and access).

## Schema

### Units and representations

| Quantity | Representation |
|---|---|
| Instants | ISO 8601 UTC strings with `Z`, millisecond precision (`"2026-10-12T09:31:00.000Z"`) |
| Windows | Half-open `[start, end)`, both on **minute boundaries** (seconds and milliseconds zero); `end: null` is open-ended |
| Minutes in move and effective fields | ISO 8601 UTC instant on a minute boundary |
| Rate | Integer **Mbps**, ≥ `rate_min` (1); fractional, zero or negative is invalid (POL-31) |
| Money | `{ "currency": "USD", "micros": "<integer as decimal string>" }`, micros = 10⁻⁶ of the major unit (POL-11, POL-20). Amounts in JSON are strings, never numbers |
| Price per Mbps-minute | `{ "currency": "USD", "micros_per_mbps_minute": "<exact decimal string>" }`, the catalogue's exact figure (POL-01; may carry fraction digits since a charge line is computed exactly and rounded once, POL-11) |
| Durations | Integer **milliseconds**, field names ending `_ms` (`deadline_ms`, `retry_after_ms`) |
| Identifiers | Opaque strings: `request_id`, `reservation_id`, `link_id`, `offer_id`, `product_id`, `documented_request_ref`, `invoice_id`. Clients never parse them |
| Idempotency key | Client-chosen string, 1 … 128 characters of `[A-Za-z0-9._:-]`, sent in the `Idempotency-Key` header |

### Common request headers

| Header | Required | Meaning |
|---|---|---|
| `Authorization` | Yes | `Bearer shk_<key id>_<secret>` (agent or probe key) or `Bearer <OIDC access token>` (account user or administrator); probe keys also present the probe mTLS client certificate (RFC-005 §2.1) |
| `Idempotency-Key` | On every `POST` except offer answers' reads | Scoped to the account (POL-29) |
| `Content-Type` | On bodies | `application/json` |

### Types (TypeScript)

```ts
type Instant = string;            // ISO 8601 UTC, ms precision
type Minute = string;             // ISO 8601 UTC on a minute boundary
type Micros = string;             // integer decimal string
interface Money { currency: "USD"; micros: Micros }
interface Price { currency: "USD"; micros_per_mbps_minute: string }  // exact decimal
interface Window { start: Minute; end: Minute | null }               // [start, end); null = open-ended

// ---------- Submissions ----------

interface BookRequest {
  legs: string[];                 // link_ids in route order, first leg first; 1 leg = single-link booking
  window: Window;
  rate_mbps: number;              // integer
  product_id: string;
  wait?: boolean;                 // default true (POL-05)
  deadline_ms?: number;           // default route_deadline_default = 30000 (POL-26)
  quote_id?: string;              // binds the terms shown by that quote (M2)
}

type ChangeKind = "cancel" | "shorten" | "extend" | "increase" | "decrease";
interface ChangeRequest {         // POST /v1/reservations/{reservation_id}/changes
  kind: ChangeKind;               // renew = extend; make open-ended = extend with new_end null
  new_end?: Minute | null;        // shorten, extend
  new_rate_mbps?: number;         // increase, decrease: the reservation's new total rate
  wait?: boolean;                 // default true
  deadline_ms?: number;           // default 30000
  quote_id?: string;              // binds the terms shown by that quote (M2)
}
// cancel(reservation, key) of RFC-002 §13.1 is ChangeRequest{kind:"cancel"}.

interface OfferAccept {           // POST .../offers/{offer_id}/accept
  move_from?: Minute;             // m_req; default: the reduction's notice end T_eff (POL-07 step 6)
}
interface OfferMoveEarlier {      // POST .../offers/{offer_id}/move-earlier (while Accepted or Final)
  move_from: Minute;
}
// POST .../offers/{offer_id}/decline has no body.

type DocumentedAction = "cancel" | "shorten" | "extend" | "increase" | "decrease" | "withdraw";
interface DocumentedRequestSubmit {   // POST /v1/documented-requests
  action: DocumentedAction;
  target: { reservation_id: string } | { request_idempotency_key: string };  // the latter for withdraw
  parameters?: { new_end?: Minute | null; new_rate_mbps?: number };
  note?: string;                  // free text; stored as a case note in the personal-data store, never logged (RFC-005 §7.5)
}

interface QuoteRequest {          // POST /v1/quotes
  candidate: { booking: BookRequest }
           | { change: { reservation_id: string } & ChangeRequest };
}

// ---------- Answers ----------

type FinalOutcome = "confirmed" | "rejected" | "invalid" | "failed";
type RequestState = "pending" | FinalOutcome;

interface RequestStatus {
  request_id: string;
  idempotency_key: string;
  request_kind: "booking" | "change";
  change_kind?: ChangeKind;
  reservation_id?: string;        // booking: set once confirmed; change: always
  state: RequestState;
  deadline: Instant;              // D = intake ts + deadline
  decided_at?: Instant;           // ts of the deciding entry; for an expiry, D (RFC-002 §8.3)
  reason?: ReasonCode;            // every final outcome other than confirmed
  rule?: string;                  // rejected for a rule, invalid: the rule stated (B-RQ-3)
  counter_offer?: CounterOffer;   // rejected for no fit or wait=false (POL-10)
  amounts?: RejectionAmounts;     // rejected by funds and standing
  retry_after_ms?: number;        // wait=false rejection; "deadline passed while waiting"
  shown?: ShownTerms;             // booking and additions: the figures locked in E1 (POL-27, POL-08)
  effect?: ChangeEffect;          // confirmed change
}

type ReasonCode =
  // rejected
  | "no_fit" | "in_flight" | "partner_refused"
  | "rule_at_most_one_leg_without_holds" | "rule_route_changed_as_one_unit"
  | "rule_decrease_not_allowed_by_partner_terms"
  | "terms_changed"               // TERMS_CHANGED (M2): a quoted term differs at the lock
  | "account_suspended" | "key_inflight_limit" | "account_inflight_limit"
  | "insufficient_funds" | "key_spend_limit"
  // invalid
  | "invalid_window" | "invalid_rate" | "invalid_deadline" | "beyond_selling_horizon"
  // failed
  | "deadline_passed" | "deadline_passed_while_waiting" | "interrupted_by_internal_failure"
  | "withdrawn" | "key_revoked" | "reservation_ended" | "reservation_changed_by_share";

interface CounterOffer {
  largest_rate_mbps: number;      // fits the requested window on every Share leg; 0 if none
  earliest_window: Window | null; // requested length, start ≥ requested start, within the horizon
  blocking_link: { link_id: string; leg_index: number };  // first refusing leg in route order; legs from 0
  retry_after_ms?: number;        // wait=false: latest remaining deadline among blockers
  share_legs_only: boolean;       // true when the route has a partner leg (RFC-002 §5.8)
}

interface RejectionAmounts {
  // insufficient_funds (POL-10): x − h and x − h + low_balance_warning
  top_up_min?: Money;
  top_up_min_plus_low_balance_warning?: Money;
  // account_suspended (POL-16): the resume amount, itemised
  resume?: ResumeAmount;
}
interface ResumeAmount {          // RFC-004 ResumeQuote; total = written_off + Σ overdue + headroom_part
  total: Money;
  written_off: Money;             // "0" if none
  overdue_invoices: { invoice_id: string; amount: Money }[];  // oldest first
  headroom_part: Money;           // what headroom still needs, full coverage restored, to reach low_balance_warning
}

interface ShownTerms {
  price: Price;                   // locked for the part (POL-27)
  price_version: string;
  announced_price_change?: { price: Price; price_version: string; effective: Minute };  // open-ended only
  partner_legs: PartnerLegTerms[];
}
interface PartnerLegTerms {
  leg_index: number;
  link_id: string;
  decrease_allowed: boolean;      // P2-S50
  shorten_allowed: boolean;       // POL-08: shorten is allowed at any time; carried explicitly (M2)
  holds: boolean;                 // false: partner without holds (POL-28)
  fee?: ShownFee;                 // absent: no fee on this leg
}
interface ShownFee {
  kind: "plain" | "minimum_term"; // plain: due only on a cancellation; minimum_term: see due rules
  amount: Money;                  // exact, never rounded (POL-11)
  term_end?: Minute;              // minimum_term only
  due_at_window_end: boolean;     // true iff the booked window, as last changed, ends inside the term (P3-S74)
}

interface Quote {
  quote_id: string;
  valid_until: Instant;           // after it, a request citing the quote is judged against the terms then in force
  shown: ShownTerms;              // price, announced price change, every partner leg's terms and fee
  for_candidate: QuoteRequest["candidate"];  // echoed as quoted
}

interface ChangeEffect {
  effective: Minute;              // next minute boundary after ts, or the new end
  fees_due: { leg_index: number; kind: "plain" | "minimum_term"; amount: Money;
              payer: "buyer" | "share" }[];
}

interface NotAccepted {           // no request created, nothing held, no outcome (glossary)
  error: "not_accepted";
  code: "key_reuse_different_request" | "key_reuse_other_principal"
      | "rate_limited" | "poll_limited" | "malformed";
  retry_after_ms?: number;        // rate_limited, poll_limited
}

interface ErrorAnswer {
  error: "unauthenticated" | "not_found" | "refused" | "temporarily_unavailable";
  right?: string;                 // refused: the missing right (RFC-005 §2.3)
}

interface Offer {                 // content of the offer as made (E13 Made; RFC-002 §9.6)
  offer_id: string;
  reservation_id: string;
  path: { catalogue_route_id: string; legs: string[] };
  shown_price: Price;             // lower of the original and the path's (POL-07 step 4)
  rate_mbps: number;              // the reservation's whole rate at the offer's from-minute
  lapses_at: Instant;             // made + offer_window (7 days)
  move_by_default: Minute;        // the reduction's notice end T_eff
  partner_leg_confirmed_only_at_acceptance: boolean;
}
interface OfferStatus {
  offer_id: string;
  state: "made" | "accepted" | "final" | "failed" | "declined" | "lapsed";
  move_at?: Minute;               // final: max(m_req, nb(ts)); later than m_req is a recorded delay
  cut_kept?: {                    // final after the reduction's cut (POL-07 step 6, P1-S84)
    rate_mbps: number;            // the rate the cut left; held capacity beyond it released at the move
    may_book_increase: true;
  };
}

interface DocumentedRequestRecorded {
  documented_request_ref: string;
  recorded_at: Instant;           // the console log's commit time
}
```

### Endpoints (OpenAPI-style)

| Operation | Method and path | Body | Success answers | Other answers |
|---|---|---|---|---|
| **quote** | `POST /v1/quotes` | `QuoteRequest` | `200 Quote` | `400 NotAccepted{malformed}`, `401`, `403`, `404`, `409 NotAccepted{key_reuse_*}`, `429 NotAccepted{rate_limited}`, `503` |
| **book** | `POST /v1/bookings` | `BookRequest` | `200 RequestStatus` (final), `202 RequestStatus` (`state: "pending"`) | `400 NotAccepted{malformed}`, `401`, `404`, `403`, `409 NotAccepted{key_reuse_*}`, `429 NotAccepted{rate_limited}`, `503` |
| **change** (incl. cancel, shorten, extend/renew/make open-ended, increase, decrease) | `POST /v1/reservations/{reservation_id}/changes` | `ChangeRequest` | as book | as book |
| **withdraw** | `POST /v1/requests/{idempotency_key}/withdraw` | none | `200`/`202 RequestStatus` of the named request | `404` (no such request), `409 NotAccepted{key_reuse_other_principal}`, `401`, `429`, `503` |
| **status** | `GET /v1/requests/{idempotency_key}` | none | `200`/`202 RequestStatus` | `404` (no such request), `409 NotAccepted{key_reuse_other_principal}`, `401`, `429 NotAccepted{poll_limited}`, `503` |
| **offer read** (M3) | `GET /v1/reservations/{reservation_id}/offers/{offer_id}` | none | `200 Offer & OfferStatus` | `401`, `404`, `503` |
| **offer accept** (M3) | `POST /v1/reservations/{reservation_id}/offers/{offer_id}/accept` | `OfferAccept` | `200 OfferStatus` | `401`, `403`, `404`, `409`, `429`, `503` |
| **offer decline** (M3) | `POST .../offers/{offer_id}/decline` | none | `200 OfferStatus` | as accept |
| **move earlier** (M3) | `POST .../offers/{offer_id}/move-earlier` | `OfferMoveEarlier` | `200 OfferStatus` | as accept |
| **documented request** | `POST /v1/documented-requests` | `DocumentedRequestSubmit` | `201 DocumentedRequestRecorded` | `401`, `403 refused`, `404`, `409`, `429`, `503` |

`200` carries a final outcome (`confirmed`, `rejected`, `invalid`, `failed`); `202` carries
`pending`. A rejected, invalid or failed request is a **successful** HTTP exchange: the
outcome is the answer, not an error.

### Error codes

| HTTP | Body | When | Retry |
|---|---|---|---|
| 400 | `NotAccepted{malformed}` | Body not parseable as the schema, or `Idempotency-Key` missing or malformed, so no fingerprint can be formed (M7). Nothing recorded | Fix and resend |
| 401 | `{error:"unauthenticated"}` | No, malformed, unknown, wrong, expired or revoked credential; ended session; key revoked as applied at the owner (`NotAccepted{revoked}`, X1-S06). Identical status, body and headers for every cause, sent no earlier than `unauth_floor` (5 ms) after arrival (RFC-005 §2.3) | No |
| 403 | `{error:"refused", right}` | Within the own tenant, the principal's kind or rights do not allow the operation (RFC-005 §4.2: e.g. a probe key on a non-probe link; documented request by a principal that may not make the change itself). Recorded by the owner | No |
| 404 | `{error:"not_found"}` | Reservation, offer or request outside the principal's account, or not existing; identical to a genuine miss (X1-S02, X1-S03, X1-S09). For status and withdraw: "no such request", given only after a consistent read at the present timestamp shows no idempotency row (RFC-002 §8.2) | No |
| 409 | `NotAccepted{key_reuse_different_request}` | Same principal, same key, different fingerprint (P2-S26, P2-S113). Reveals nothing of the first request | Use a new key |
| 409 | `NotAccepted{key_reuse_other_principal}` | Another principal of the account used the key first (P2-S64). Reveals nothing of the first request or its outcome | Use a new key |
| 429 | `NotAccepted{rate_limited, retry_after_ms}` | Over `key_rate_limit` (50/s per key) or `account_rate_limit` (200/s per account), sliding second; nothing logged, key not consumed (P2-S41). Also sent with header `Retry-After` (seconds, rounded up) | After `retry_after_ms`, same key allowed |
| 429 | `NotAccepted{poll_limited, retry_after_ms}` | Over `key_poll_limit` (20 polls/s per key, per UTC second) at the edge poll limiter (P2-S67) | After `retry_after_ms` |
| 503 | `{error:"temporarily_unavailable"}` with header `Retry-After` (seconds) | Edge replica stale beyond `edge_staleness_max` for the credential; poll-limiter shard moving; status reader rule 4 (no read lease, moved partition, database unreachable); price cache older than 60 s at intake (RFC-002 §3.2); owner partition `Stopped` (integrity stop) or routing exhausted after `Moving`/`Moved` (RFC-000 C4-7; M9) | Yes, after `Retry-After`, same key |

## Semantics per operation

### book

- **Preconditions** (edge, then owner): authenticated (RFC-005 §2.2); permission row "Book,
  change, cancel, withdraw (own account)" permits (probe keys only on probe links); the
  key is in the owner's applied key list or carried by an identity-signed key record
  naming the account; under the rate limits; the price cache's resolved timestamp within
  60 s of the intake's `ts`.
- **Idempotency lookup** (RFC-002 §3.1 step 3) precedes everything that can create a request.
- **Validation** (RFC-002 §3.2), each failure recorded as an outcome under the key (E1′),
  so a retry returns it even after the horizon has rolled: window and rate validity by
  the link registry's rules, "now" = the minute boundary at or before receipt
  (`invalid_window`, `invalid_rate`, `beyond_selling_horizon`); deadline within 1 000 …
  60 000 ms, and ≥ 11 000 ms with a partner leg (`invalid_deadline`; P2-S12, P2-S86); at
  most one leg on a partner without holds (`rejected`,
  `rule_at_most_one_leg_without_holds`); then `admit` in arrival order (RFC-004 §A5.1):
  `account_suspended` (with `resume`), `key_inflight_limit`, `account_inflight_limit`,
  `insufficient_funds` (with `top_up_min`, `top_up_min_plus_low_balance_warning`),
  `key_spend_limit`.
- **Outcomes**: `confirmed` with `reservation_id` and `shown`; `rejected` for no fit
  (with `counter_offer`), for `wait = false` with capacity in flight (`in_flight`,
  `counter_offer.retry_after_ms`), for a definite partner refusal naming the partner link
  (`partner_refused`), for a rule or a funds/standing check; `invalid`; `failed`
  (`deadline_passed`, `deadline_passed_while_waiting` with `retry_after_ms`,
  `interrupted_by_internal_failure`, `withdrawn`, `key_revoked`). A request not confirmed
  by its deadline has failed as of `D`; its `decided_at` is `D` and it is never reported
  before `D` (RFC-002 §6.5).
- **Shown figures**: `shown` carries the price and price version locked in E1, any
  announced price change for an open-ended booking (which becomes the reservation's
  price step), and per partner leg whether a decrease is allowed and the fee with its
  kind, term end and `due_at_window_end` (POL-08, P2-S50, P3-S74), echoed whether or not
  the request cited a quote. To see them before submitting, the buyer calls `quote` (M2).
- **`quote_id`**: when present, the owner compares the quote's `shown` with the terms it
  locks at intake (E1), which are the terms the decision charges. Any difference (price,
  price version, announced price change, any partner leg's terms or fee, its kind, term
  end or `due_at_window_end`), or a `valid_until` already passed with the terms changed,
  gives outcome `rejected`, reason `terms_changed` (`TERMS_CHANGED`), recorded under the
  key, nothing held, with the current terms in `shown`. A request is never charged terms
  that were not shown to it. `quote_id` is not a fingerprint field (POL-29): a retry
  under the same key is the same request whatever `quote_id` it carries, and the first
  submission's `quote_id` governs. An unknown `quote_id`, or one of another account, is
  `404`.

### change (cancel, shorten, extend, renew, make open-ended, increase, decrease)

- A change is a booking request with its own key, deadline and `wait` (RFC-002 §9.2).
  Fingerprint: reservation, kind, new end or new rate, `wait`, principal; the deadline is
  not part of it (P2-S113).
- **Rejected at intake**: a change to part of a route (`rule_route_changed_as_one_unit`,
  P2-S49); a decrease over a partner leg whose shown terms forbid it
  (`rule_decrease_not_allowed_by_partner_terms`, stating that the reservation may be
  cancelled instead, P2-S115); additions while suspended (`account_suspended` with
  `resume`, P2-S78). Invalid: an extension past the horizon (P2-S84). Reductions are
  never funds-checked and are allowed while suspended (P2-S77).
- **Ending changes are never queued**: `cancel`, or `shorten` with `new_end` at or before
  the next minute boundary (including a past end), end the reservation from the next
  boundary and fail every queued change and the change in progress with
  `reservation_ended` (P2-S43, P2-S81, P2-S94).
- **Every other change** is queued per reservation in arrival order and decided at the
  head against the reservation as left by the change before (P2-S79). Extend and
  increase are new admissions of the difference; a rejected or failed addition leaves
  the reservation unchanged (P2-S46, P2-S74, P2-S83). A decrease removes Mbps last in,
  first out from the next boundary.
- **Share-initiated effects on a pending change**: an ending by Share fails it
  `reservation_ended`; a move fails a change in progress on removed legs
  `reservation_changed_by_share`; a cut or price step fails nothing (RFC-002 §9.4).
- **Reported when**: a change that frees capacity (cancel, shorten, decrease) is reported
  only once its leg changes are durable, so a buyer reading the outcome finds the
  capacity free from `effect.effective` (RFC-002 §9.3). A cancellation over a partner
  leg is confirmed for the buyer whatever the partner answers (P2-S82).
- **Fees**: `effect.fees_due` lists any fee the change makes due: a plain fee only on a
  cancellation; a minimum-term fee on a cancellation inside the term or a shorten whose
  new end falls inside it; payer `share` on a cancellation after a POL-07 cut or for a
  fee not shown, otherwise `buyer` (RFC-002 §9.5). A fee is due at most once per
  reservation and leg.

### quote (M2)

- For a candidate booking or change, returns the figures the owner would lock now from
  its catalogue cache (the same cache and freshness rule as intake, RFC-002 §3.2): the
  price per Mbps-minute and price version, any announced price change for an open-ended
  candidate, and for every partner leg whether shorten and decrease are allowed, whether
  it holds, and every fee with kind, term end and `due_at_window_end`, plus `valid_until`.
- **Not a booking request**: no outcome, no capacity hold, no funds hold, not counted
  toward capacity in flight or headroom, and outside `ack_budget`. It checks the
  candidate's well-formedness and tenancy (another account's reservation is `404`), not
  fit, funds or limits. Counted as a submission for `key_rate_limit` and
  `account_rate_limit`.
- Permission as for book and change (probe keys only on probe links).
- A quote binds nothing by itself: it only makes a later `book` or `change` citing it
  refuse `terms_changed` rather than charge terms that differ.

### withdraw

- Names the **request's own idempotency key** (RFC-002 §7.1, §9.2), so its retries are the
  same withdrawal; it takes no `Idempotency-Key` of its own (M5).
- Undecided → `failed`, `withdrawn`; funds released, holds released, any partner booking
  already made cancelled at once at Share's cost (P2-S56, P2-S57, P2-S105); the buyer is
  not charged. Already decided → no effect; the answer is the decided outcome (P2-S103).
- Withdrawing a change request withdraws only that change.
- The answer is the named request's `RequestStatus` under the ack rule below.

### status

- Answers the request named by (account, key) under the reporting gate and the status
  rule (below). Polls never count toward booking rate limits, only toward
  `key_poll_limit` (P2-S68).
- Another principal of the account reading a key it did not submit gets
  `key_reuse_other_principal`, revealing nothing (M4).
- A key never used in the account, or used only by another account, is "no such
  request" (404), identical to a key never used anywhere (X1-S08, X1-S09).

### Offers and moves (POL-07 steps 3 to 7; RFC-002 §9.6)

The offer itself reaches the holder as a notice (outside this contract); these
operations answer it.

- **accept**: precondition: offer in `made` and not past `lapses_at`. On an all-Share path
  the move is `final` in the acceptance's own entry; with a partner leg the answer is
  `accepted` and becomes `final` once the partner booking is confirmed, or `failed` (as a
  declined offer; another path may be offered, P1-S61). `move_at = max(move_from,
  nb(ts))`; `move_from` defaults to the reduction's notice end and must be a minute
  boundary not after it (P1-S53). The moved reservation keeps each part's age and key
  (P1-S71) and pays the lower of the original and the path's price.
- **final after the cut** (v1.10, P1-S84): if the reduction's cut applied before the move
  is final, `OfferStatus.cut_kept` states the rate the cut left and that an increase may
  be booked on the path; capacity held beyond it is released at the move (M6).
- **decline**: `declined`; capacity held for the offer released at once (P1-S57); only the
  affected Mbps are removed at the notice end, with no charge for what is removed.
- **move-earlier**: while `accepted` or `final`, choose an earlier minute boundary
  `T ≥ nb(ts)`; recorded and used at `final`, or applied by a further change if already
  final.
- **lapse**: no answer by `lapses_at` counts as declined (P1-S45).
- Answering an offer in a terminal state (`final`, `failed`, `declined`, `lapsed`) has no
  effect and returns its `OfferStatus`. While `accepted`, the holder may still cancel the
  reservation (the offer then fails).

### documented request (POL-32; RFC-005 §7.5)

- **Precondition**: the console's intake evaluates C2 `decide(context, requested
  operation, target)` with the requester's principal context and records the request
  only on `permit` (the requester may make that change itself). Permission row: account
  administrators, users and agent keys yes; supplier principals and probe keys no.
- **Outcome**: recorded on the console's log partition of the account's requests with the
  requester's `principal_id`, the action, the target and the time; `note` goes to the
  personal-data store as a case note (identifier and SHA-256 only in the log). The
  answer is `201` with `documented_request_ref`. Recording executes nothing: a support
  operator later acts citing it, as the account's own change (POL-08), never a
  termination.
- **Errors**: `refused` (C2 `refused`, recorded), `not_found` (target outside the tenant or
  absent), `unauthenticated`. Erasure of a user's own data is **not** this operation
  (RFC-005 C12).

## Acknowledgement rule (`ack_budget`)

- Every `book`, `change`, `withdraw`, and retry of a submission (not `quote`, offer answers
or documented requests), receives an answer within
  **`ack_budget` = 200 ms at p99**, measured at the edge from receipt (POL-04, P2-S07,
  X2-S15). The owner holds the forwarded submission until the earlier of: the outcome is
  reportable (answer final, `200`), or `ack_budget` less the edge's share (est. 20 ms)
  after the edge received it, provided the intake is committed (answer `pending`, `202`)
  (RFC-002 §8.1).
- `pending` is sent only for a durable intake. If the intake cannot commit in time no
  answer is given within `ack_budget`; that counts as unavailability and the client
  retries with the same key.
- A route with a partner leg typically answers `pending` and reaches its outcome by its
  deadline (P2-S08, X2-S06).

## Status-read guarantees

A request's outcome is **reported** once the entries that make it final are at or below
the account slot's report position (RFC-002 §8). Every channel (synchronous answer,
status read, outcome feed, webhook) obeys that gate. A `RequestStatus` from `status`,
from a retry, or from `withdraw`:

1. **Never contradicts the decided outcome**: it is `pending` or the decided outcome,
   never another (P2-S10, P2-S106).
2. **Lags the decision by at most `status_staleness` (1 s)**, with two exceptions for an
   outcome not yet reported: a non-confirmed outcome waits for its Share-link releases to
   be durable, within `release_grace` (1 min) while a link's schedule owner fails over;
   while the decision record is unavailable, `pending` for at most 1 min (admission RTO),
   or `release_grace` after the deadline if unavailable at it (POL-04; P2-S99, P2-S107,
   P2-S111).
3. **Never `pending` after a reported outcome**: once reported, every later read returns
   it, whatever the state of the decision record or the links (P2-S108).
4. **Once any read has answered the decided outcome, every later read does**
   (P2-S111).
5. An expired request is never reported failed before its deadline `D`.
6. A read that cannot satisfy 1 … 4 answers `503 temporarily_unavailable`, never a guess.

## Delivery and ordering

- **Synchronous request/response.** Exactly-once effect per (account, idempotency key):
  any number of identical submissions, concurrent or retried, join one request
  (P2-S24, P2-S25, P2-S27).
- **Arrival order** for one account is the order the owner receives submissions (not
  client send order); admission checks run one at a time in that order, and a request
  refused because of another's hold stays refused (POL-25, P2-S70, P2-S112).
- **Per reservation**, non-ending changes apply in arrival order; endings are never
  queued (P2-S79, P2-S81).
- No ordering is promised across accounts, or between a synchronous answer and a webhook.

## Idempotency

| Operation | Key | Same key, same fingerprint, same principal | Same key, different fingerprint | Same key, other principal of the account | Retention |
|---|---|---|---|---|---|
| quote | (account, `Idempotency-Key`); fingerprint: the candidate | The first `Quote`, unchanged, even past `valid_until` | `409 key_reuse_different_request` | `409 key_reuse_other_principal` | 24 h |
| book | (account, `Idempotency-Key`) | The same request: its current status under the ack rule; no new entry | `409 key_reuse_different_request`, first request unaffected | `409 key_reuse_other_principal`, nothing revealed | `idempotency_retention` 24 h from intake; afterwards the key names a new request (P2-S65) |
| change (incl. cancel) | (account, `Idempotency-Key`); fingerprint: reservation, kind, new end or new rate, `wait` | as book | as book (P2-S113) | as book | 24 h |
| withdraw | The target request's key (M5) | Same withdrawal; the status of the request | — | `409 key_reuse_other_principal` | The target's retention |
| offer answers | (account, `Idempotency-Key`); fingerprint: offer, answer, `move_from` (M3) | The offer's current `OfferStatus` | `409 key_reuse_different_request` | `409 key_reuse_other_principal` | 24 h |
| documented request | (account, `Idempotency-Key`); fingerprint: action, target, parameters; note excluded (M8) | The first `DocumentedRequestRecorded` | `409 key_reuse_different_request` | `409 key_reuse_other_principal` | 24 h |

Fingerprints for bookings: legs in order, window, rate, product, `wait`; the deadline and
`quote_id` are excluded (P2-S63, M2). Not-accepted submissions consume no key (P2-S41). Keys of two accounts
never meet (X1-S08).

## Ownership

| Data | Written by | Read by |
|---|---|---|
| Intake, deciding and completing entries, idempotency index, request and reservation records | Account owner (RFC-002), only | Status readers (follower reads and pushed batches), the owner |
| Offer state (E13) | Account owner | The owner and status readers |
| Documented requests | Operator console's log; case note text in the personal-data store | Support (console), audit |
| Principal context | Edge (built from identity's replica); never signed by the edge | Owner, console (verify per RFC-005 C1) |
| Poll counters | Edge poll limiter (soft state) | Edge |

The edge keeps no authoritative state and never touches the database. Nothing of another
account or another principal's request is revealed by any answer.

## Timeouts and deadlines

| Item | Value | Source |
|---|---|---|
| `ack_budget` | 200 ms p99 | POL-04 |
| `status_staleness` | 1 s | POL-04 |
| `release_grace` | 1 min | POL-26 |
| Deadline `deadline_ms` | default 30 000; 1 000 … 60 000; ≥ 11 000 with a partner leg (`commit_margin` 10 s) | POL-26 |
| `idempotency_retention` | 24 h | POL-29 |
| `offer_window` | 7 days | POL-07 |
| Quote `valid_until` | Set by the provider per quote; never later than the next price version's effective minute known to the cache | M2 |
| `unauth_floor` | ≥ 5 ms before any unauthenticated answer | RFC-005 §13 |
| `context_ttl` | 60 s (edge context to owner) | RFC-005 §13 |
| Key revocation | No new request of a revoked key accepted after 60 s; its undecided requests fail `key_revoked` | POL-25, X1-S06 |
| Client timeout | A client SHOULD wait at least `ack_budget` plus its network round trip, then retry with the same key; a late first answer and the retry's answer agree | RFC-002 §3.1 |

## Versioning and compatibility

- Major version in the path (`/v1`). Within a major version only additive changes: new
  optional request fields with defaults that keep today's behaviour, new response
  fields, new `ReasonCode` and error `code` values.
- Clients MUST ignore unknown response fields and treat an unknown `ReasonCode` by its
  `state` (`rejected`, `invalid`, `failed`). Providers MUST NOT change the meaning of a
  field, an existing code, a unit, or the fingerprint of an operation within a major
  version.
- A change to the fingerprint fields, to units, or to the status guarantees is a new
  major version; both versions are served at least `idempotency_retention` past the
  announcement, so every key issued under the old version resolves under it.
- The policy version used for each decision is recorded by the owner (X1-N8); it is not
  part of the wire contract.

## Scenarios relied on

- **P2**: P2-S01 … P2-S13, P2-S23 … P2-S27, P2-S38 … P2-S50, P2-S54 … P2-S57, P2-S61,
  P2-S63 … P2-S70, P2-S72 … P2-S84, P2-S86, P2-S92, P2-S94, P2-S95, P2-S98, P2-S99,
  P2-S102, P2-S103, P2-S105 … P2-S108, P2-S110 … P2-S117.
- **P1**: P1-S19, P1-S20, P1-S31, P1-S35, P1-S36, P1-S39, P1-S45, P1-S52, P1-S53,
  P1-S55 … P1-S61, P1-S71, P1-S73, P1-S74, P1-S84.
- **P3**: P3-S11, P3-S43, P3-S44, P3-S63, P3-S74 (fees shown, kind, due at window end).
- **P4**: P4-S114 (resume amount itemised).
- **X1**: X1-S01 … X1-S09, X1-S27, X1-S41.
- **X2**: X2-S06, X2-S15.

## Conformance tests

### Provider (account owner + edge + console)

| ID | Test | Scenarios |
|---|---|---|
| CT-P01 | Single-link booking, no capacity in flight: `200 confirmed` within 200 ms at p99 over 10⁴ calls | P2-S07, X2-S15 |
| CT-P02 | Partner route with slow partner: `202 pending` within 200 ms; polls reach the final outcome by `D` | P2-S08 |
| CT-P03 | Two identical submissions in parallel: one request, both answers equal | P2-S24 |
| CT-P04 | Retry after outcome, across an owner restart: same outcome | P2-S25 |
| CT-P05 | Same key, each fingerprint field changed (legs, window, rate, product, `wait`): `409 key_reuse_different_request`; changed deadline only: same request | P2-S26, P2-S63 |
| CT-P06 | Same key by another agent key of the account: `409 key_reuse_other_principal`, body identical regardless of the first request's state | P2-S64 |
| CT-P07 | Same key from two accounts: independent; poll from the other account equals a never-used key | X1-S08, X1-S09 |
| CT-P08 | Change re-sent with each of reservation, kind, end/rate, `wait` changed: `409`; identical: same change | P2-S113 |
| CT-P09 | Rate limits: 51st/s per key and 201st/s per account `429 rate_limited` with `retry_after_ms`, key reusable; 21st poll/s `429 poll_limited`; polls do not count toward booking limits | P2-S41, P2-S67, P2-S68 |
| CT-P10 | Status never contrary and never `pending` after reported: fault-inject owner takeover, status-reader lease loss, slot move and link failover during and after the decision; assert the five guarantees | P2-S10, P2-S99, P2-S106 … P2-S108, P2-S111 |
| CT-P11 | Expiry: outcome `failed` with `decided_at = D`, never reported before `D`; waiter gets `deadline_passed_while_waiting` and `retry_after_ms` | P2-S13, P2-S61, P2-S95 |
| CT-P12 | Rejections: no fit returns `counter_offer` beside held capacity; `wait=false` returns `in_flight` with `retry_after_ms`; funds returns both top-up amounts in micros strings; suspended returns `resume` whose items sum to `total` | P2-S02, P2-S18, P2-S38, P2-S69, P1-S73, P4-S114 |
| CT-P13 | Invalid deadlines (61 s, 0, −5 s, 0.5 s, 10 s with partner) are `invalid`, recorded, returned on retry | P2-S12, P2-S86 |
| CT-P14 | Cancel during a queued increase: cancel effective next boundary, increase `failed reservation_ended`; cancelled capacity free on every Share leg when the outcome is read | P2-S43, P2-S81, P2-S94 |
| CT-P15 | Decrease over a partner leg forbidding it: `rejected rule_decrease_not_allowed_by_partner_terms` | P2-S115 |
| CT-P16 | `shown` on a partner route: decrease allowed, fee kind, term end, `due_at_window_end` true for a 10-day window on a 30-day term, false for 30 days | P2-S50, P3-S74 |
| CT-P17 | Withdraw pending → `failed withdrawn`, partner leg cancelled at Share's cost; withdraw decided → decided outcome | P2-S56, P2-S57, P2-S103 |
| CT-P18 | Unauthenticated causes are byte-identical and ≥ 5 ms; another account's reservation `404` identical to a missing one | X1-S01 … X1-S03 |
| CT-P19 | Offer: accept all-Share → `final` with `move_at`; accept with partner leg → `accepted` then `final` or `failed`; decline releases; lapse after 7 days; accept after the cut → `cut_kept` | P1-S35, P1-S45, P1-S53, P1-S57, P1-S60, P1-S61, P1-S84 |
| CT-P21 | Quote then book citing it, terms unchanged: confirmed, `shown` equal to the quote's; price version or a partner fee changed between quote and intake: `rejected terms_changed`, nothing held, current terms in `shown`; quote holds no capacity and no funds | P2-S50, P3-S74 |
| CT-P22 | Quote retried with the same key returns the same `Quote`; different candidate under the key `409` | — |
| CT-P20 | Documented request: permitted principal → `201`, note absent from every log; principal that may not make the change → `403`, recorded; support action without it refused | X1-S27 |

### Consumer (buyer SDKs and agents)

| ID | Test |
|---|---|
| CT-C01 | Sends an `Idempotency-Key` on every submission and reuses it, unchanged with the same body, for every retry of that intent |
| CT-C02 | On timeout or `503`, retries with the same key; never mints a new key for the same intent |
| CT-C03 | Treats `202 pending` as non-final and polls (respecting `key_poll_limit`) or awaits the webhook; never treats a `pending` read after a final read as a reversal (the provider guarantees it cannot occur, so the client flags it as a defect) |
| CT-C04 | Parses money as decimal strings into integer micros, never floating point; rates as integers; durations as ms |
| CT-C05 | Honours `retry_after_ms` on `429` and on `in_flight` rejections |
| CT-C06 | Ignores unknown fields; maps unknown `ReasonCode` by `state` |
| CT-C08 | Calls `quote` before committing an agent to a partner route, cites `quote_id`, and on `terms_changed` re-quotes rather than retrying the same key |
| CT-C09 | On `503`, waits `Retry-After` and retries with the same key |
| CT-C07 | Sends windows on minute boundaries and `end: null` for open-ended |

## Settled

The points where the sources disagreed or were silent, settled by the orchestrator's
binding decisions (contract review pending). Section references in this contract to
M1 … M9 point here.

| # | Point | Sources | Settlement |
|---|---|---|---|
| M1 | `cancel` as its own operation or a change kind | RFC-002 §13.1 vs §9.2, POL-29 | Accepted as adopted: one `changes` endpoint with `kind: "cancel"`, the change fingerprint |
| M2 | Figures shown before booking (POL-08, P3-S74, P2-S50) with no quote operation in RFC-002 or RFC-000 §8 | POL-08, P3-S74 vs RFC-002 §13.1 | **Override**: a `quote` operation (`POST /v1/quotes`, idempotent by key, holds nothing, outside `ack_budget`) returns price, every shown fee with kind, term end and `due_at_window_end`, partner terms including whether shorten and decrease are allowed, and `valid_until`; `book` and `change` may carry `quote_id`, and if any shown term differs when the terms are locked the request is rejected `terms_changed` (`TERMS_CHANGED`), never charging terms not shown; the booking answer still echoes the figures. **Consumer obligation**: RFC-002 takes `quote` and `TERMS_CHANGED` as errata |
| M3 | Offer answers not in the booking API's operation list | RFC-000 §8, RFC-002 §13.1 vs §9.6 | Accepted as adopted: offer read, accept, decline, move-earlier; idempotent by (account, key), fingerprint (offer, answer, `move_from`); outside `ack_budget`; counted as submissions for rate limits |
| M4 | Status read by another principal of the account | RFC-005 §4.2 vs POL-29, RFC-002 §8.2 | Accepted as adopted: `409 key_reuse_other_principal`, nothing revealed |
| M5 | Withdraw's key | POL-29 vs RFC-002 §9.2 | Accepted as adopted: names the target request's key, no key of its own |
| M6 | Acceptance answer after the cut (v1.10, P1-S84) | P1-S84 vs RFC-002 §9.6 | Accepted as adopted: `OfferStatus.cut_kept` |
| M7 | Malformed bodies | Glossary vs RFC-002 §3.2 | Accepted as adopted: `400 NotAccepted{malformed}`, nothing recorded; out-of-rule values are the recorded outcome `invalid` |
| M8 | Documented-request idempotency, latency, answer | RFC-005 §7.5, RFC-000 §8 | Accepted as adopted: (account, key), fingerprint (action, target, parameters), 24 h; `201` after the console log commits; no `ack_budget` |
| M9 | `Stopped` from the owner runtime | RFC-000 C4-7 | Accepted: `503 temporarily_unavailable` with `Retry-After`; the client retries with the same key |
