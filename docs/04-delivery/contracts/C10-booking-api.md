# C10. Booking API

| | |
|---|---|
| Contract ID | C10 |
| Name | `booking-api` |
| Version | 1.0.0-draft.3 |
| Status | **Draft**, revised per [review 40](../../reviews/40-contract-C10-review.md) (ACCEPT WITH CHANGES), with decisions D1 … D8 applied; see [Review 40 resolution](#review-40-resolution). Open points M1 … M9 are settled ([Settled](#settled)). **Freezing is conditional on** the errata listed under [Errata required of other documents](#errata-required-of-other-documents), first among them RFC-005's permission-matrix rows for `quote` and offer answers (AI-40-2), without which C2 refuses those operations at the edge |
| Provider | RFC-002 (account owner, booking module): book, change (incl. cancel), withdraw, status, quote, offer read and answers. RFC-005: the edge (authentication, coarse authorisation, routing, poll limiter) and the documented-request intake (operator console) |
| Consumers | Buyers through RFC-005's edge: account users, account administrators, agent keys (AI agents and other automated clients), probe keys (probe links and probe reservations only) |
| Transport | **HTTP/JSON** at the public edge (TLS 1.3); the edge forwards each submission once by gRPC to the owner-lease holder of the account's slot (RFC-002 §3.1, RFC-005 §2.2), and documented requests to the operator console (RFC-005 §4.4, §7.5). The gRPC hop is internal and not part of this contract |
| Pinned to | `requirements-v1.10`; RFC-000 revision 4.4 (§4.4; §8 rows "Booking API" and "Documented-request intake"; C4-7); RFC-002 revision 5 (§3, §4.1, §5.5 … §5.8, §6.2 … §6.5, §7.1, §7.2, §8, §9.1 … §9.6, §13.1, §13.2); RFC-005 revision 5 (§2.1 … §2.3, §3.5, §4.1 … §4.4, §5.1 … §5.3, §7.5, C1, C2, §13); RFC-004 revision 5 with erratum 5.1, cited for the refusal reasons and the resume quote the booking module passes through (§A3, §A5.1, §A10 `Verdict`, `ResumeQuote`); review 40 |

## Purpose

The one external interface by which a buyer principal creates, changes and ends its
account's reservations, sees the terms before committing to them, follows each request to
its single outcome, answers an equivalent-path offer made under POL-07, and asks support to
act for it (a documented request, POL-32). It fixes the wire form of what RFC-002 §13.1 and
RFC-005 §7.5 promise: an answer within `ack_budget` (final, `pending`, or not accepted);
idempotency per (account, operation family, key); status reads that never contradict the
decided outcome and never return to `pending` after a reported outcome; rejections that are
counter-offers with the amounts and the itemised resume amount. It adds a `quote` operation
(M2, D1, D3) so that every fee is **shown before booking** in the one sense this contract
gives "shown": present in a quote the request cites.

Out of scope (other contracts): outcome webhooks and the notice list (signed webhook,
RFC-005 C8 and RFC-006), through which offers reach the holder; erasure requests and
recovery objections (RFC-005 C12, §3.8); balance, headroom, statements and reservation
listings (reporting); key and user management (identity and access).

## Schema

### Units and representations

| Quantity | Representation |
|---|---|
| Instants | ISO 8601 UTC strings with `Z`, millisecond precision (`"2026-10-12T09:31:00.000Z"`) |
| Windows | Half-open `[start, end)`, both on **minute boundaries**; `end: null` is open-ended |
| Minutes in move and effective fields | ISO 8601 UTC instant on a minute boundary |
| Rate | Integer **Mbps**, ≥ `rate_min` (1) (POL-31) |
| Money | `{ "currency": "USD", "micros": "<integer as decimal string>" }`, micros = 10⁻⁶ of the major unit (POL-11, POL-20). Amounts in JSON are strings, never numbers |
| Price per Mbps-minute | `{ "currency": "USD", "micros_per_mbps_minute": "<exact decimal string>" }`, the catalogue's exact figure (POL-01; may carry fraction digits since a charge line is computed exactly and rounded once, POL-11) |
| Durations | Integer **milliseconds**, field names ending `_ms` |
| Identifiers | Opaque strings: `request_id`, `reservation_id`, `link_id`, `offer_id`, `product_id`, `quote_id`, `documented_request_ref`, `invoice_id`. Clients never parse them |
| Idempotency key | Client-chosen, 1 … 128 characters of `[A-Za-z0-9._:-]`, containing **at least one alphanumeric character** (a key of dots only, such as `.` or `..`, is malformed). A key **must carry no personal data**; the edge logs a keyed digest of the key, never the key (A11). Sent in the `Idempotency-Key` header, or in the path for `status` and `withdraw` |

### Malformed or invalid (M7, R40-23)

| Input | Answer |
|---|---|
| Body not JSON; a JSON type mismatch (`rate_mbps` as a string, `deadline_ms` not an integer, a `Window` field not a string); a required field missing; an unknown enum value (`kind`); `Idempotency-Key` missing where required, or breaking its syntax | `400 NotAccepted{malformed}`: nothing recorded, key not consumed |
| Well-typed but breaking a rule: window off a minute boundary, `end ≤ start`, start in the past or past the horizon, rate below `rate_min` or above the link's rules, deadline out of bounds, unknown route or product (D6), `new_end`/`new_rate_mbps` absent or inconsistent with `kind` | Outcome `invalid` with its reason, recorded under the key (E1′) |
| Offer answer breaking an offer rule (`move_from` not a minute boundary or after `T_eff`; `move-earlier` with `T < nb(ts)` or not earlier than `move_at`) | `422 {error:"invalid", rule}`: nothing recorded, key not consumed (R40-18) |

### Common request headers

| Header | Required | Meaning |
|---|---|---|
| `Authorization` | Yes | `Bearer shk_<key id>_<secret>` (agent or probe key) or `Bearer <OIDC access token>` (account user or administrator); probe keys also present the probe mTLS client certificate (RFC-005 §2.1) |
| `Idempotency-Key` | On every `POST` **except `withdraw`**, which names its target's key in the path (M5) | Scoped to (account, operation family) (D2) |
| `Content-Type` | On bodies | `application/json` |

### Types (TypeScript)

```ts
type Instant = string;            // ISO 8601 UTC, ms precision
type Minute = string;             // ISO 8601 UTC on a minute boundary
type Micros = string;             // integer decimal string
interface Money { currency: "USD"; micros: Micros }
interface Price { currency: "USD"; micros_per_mbps_minute: string }  // exact decimal
interface Window { start: Minute; end: Minute | null }               // [start, end); null = open-ended
interface LinkRef { link_id: string; leg_index: number }             // legs numbered from 0, route order

// ---------- Submissions ----------

interface BookRequest {
  legs: string[];                 // link_ids in route order, first leg first; 1 leg = single-link booking
  window: Window;
  rate_mbps: number;              // integer
  product_id: string;
  wait?: boolean;                 // default true (POL-05)
  deadline_ms?: number;           // default route_deadline_default = 30000 (POL-26)
  quote_id?: string;              // required when the locked terms carry any partner-leg fee (D1)
}

type ChangeKind = "cancel" | "shorten" | "extend" | "increase" | "decrease";
interface ChangeRequest {         // POST /v1/reservations/{reservation_id}/changes
  kind: ChangeKind;               // renew = extend; make open-ended = extend with new_end null
  new_end?: Minute | null;        // shorten, extend
  new_rate_mbps?: number;         // increase, decrease: the reservation's new total rate
  wait?: boolean;                 // default true
  deadline_ms?: number;           // default 30000
  quote_id?: string;              // extend, increase: required as for BookRequest (D1)
}
// cancel(reservation, key) of RFC-002 §13.1 is ChangeRequest{kind:"cancel"} (M1).

interface QuoteRequest {          // POST /v1/quotes
  candidate: { booking: Omit<BookRequest, "quote_id"> }
           | { change: { reservation_id: string } & Omit<ChangeRequest, "quote_id"> };
}

interface OfferAccept {           // POST .../offers/{offer_id}/accept
  move_from?: Minute;             // m_req; default: the reduction's notice end T_eff (POL-07 step 6)
}
interface OfferMoveEarlier {      // POST .../offers/{offer_id}/move-earlier (while accepted or final)
  move_from: Minute;
}
// POST .../offers/{offer_id}/decline has no body.

type DocumentedAction = "cancel" | "shorten" | "extend" | "increase" | "decrease";  // no withdraw (D7)
interface DocumentedRequestSubmit {   // POST /v1/documented-requests
  action: DocumentedAction;
  target: { reservation_id: string };  // recorded as given; existence not checked at intake (D5)
  parameters?: { new_end?: Minute | null; new_rate_mbps?: number };
  note?: string;                  // ≤ 4096 bytes UTF-8; a case note in the personal-data store, never logged
}

// ---------- Answers ----------

type FinalOutcome = "confirmed" | "rejected" | "invalid" | "failed";
type RequestState = "pending" | FinalOutcome;

interface RequestStatus {
  request_id: string;
  idempotency_key: string;
  request_kind: "booking" | "change" | "preemptive_withdrawal";  // the last: D4
  change_kind?: ChangeKind;
  reservation_id?: string;        // booking: set once confirmed; change: always
  state: RequestState;
  deadline?: Instant;             // D = intake ts + deadline (absent for preemptive_withdrawal)
  decided_at?: Instant;           // ts of the deciding entry; for an expiry, D (RFC-002 §8.3)
  key_expires_at: Instant;        // intake ts + idempotency_retention; after it the key names a new request (R40-24)
  reason?: ReasonCode;            // every final outcome other than confirmed
  rule?: string;                  // rejected for a rule, invalid: the rule stated (B-RQ-3)
  counter_offer?: CounterOffer;   // rejected no_fit or in_flight (POL-10)
  blocking_partner_link?: LinkRef;// rejected partner_refused: the partner link that refused (P2-S31)
  retry_after_ms?: number;        // authoritative: in_flight; deadline_passed_while_waiting (R40-16)
  amounts?: RejectionAmounts;     // rejected by funds and standing
  shown?: ShownTerms;             // booking and additions: the terms locked in E1 (POL-27, POL-08)
  requote?: Quote;                // rejected quote_required or terms_changed: current terms, fresh quote_id
  effect?: ChangeEffect;          // confirmed change
}

type ReasonCode =
  // rejected
  | "no_fit" | "in_flight" | "partner_refused"
  | "rule_at_most_one_leg_without_holds" | "rule_route_changed_as_one_unit"
  | "rule_decrease_not_allowed_by_partner_terms"
  | "quote_required"              // D1: fee-bearing partner terms, no quote cited
  | "terms_changed"               // TERMS_CHANGED (M2): cited quote expired or a term differs
  | "account_suspended" | "key_inflight_limit" | "account_inflight_limit"
  | "insufficient_funds" | "key_spend_limit"
  // invalid
  | "unknown_route" | "product_not_on_route"          // D6
  | "invalid_window" | "invalid_rate" | "invalid_deadline" | "beyond_selling_horizon"
  // failed
  | "deadline_passed" | "deadline_passed_while_waiting" | "interrupted_by_internal_failure"
  | "withdrawn" | "key_revoked" | "reservation_ended" | "reservation_changed_by_share";

interface CounterOffer {
  largest_rate_mbps: number;      // fits the requested window on every Share leg; 0 if none
  earliest_window: Window | null; // requested length, start ≥ requested start, within the horizon
  blocking_link: LinkRef;         // first refusing leg in route order
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
  headroom_after?: Money;         // headroom once total is applied (P4-S114 row 1); present once RQ-40-4 / AI-40-4 land
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
  fees: ShownFee[];               // every fee the leg imposes; empty: none (R40-04)
}
interface ShownFee {
  kind: "plain" | "minimum_term"; // plain: a cancellation fee; minimum_term: the term charged as a fee
  amount: Money;                  // exact, never rounded (POL-11)
  term_end?: Minute;              // minimum_term only
  due_at_window_end: boolean;     // minimum_term: the window, as booked or last changed, ends inside the term (P3-S74)
}

interface Quote {
  quote_id: string;               // owner-signed token (D3); opaque to clients
  valid_until: Instant;           // binding: a request citing the quote after it is rejected terms_changed (R40-11)
  shown: ShownTerms;              // price, announced price change, every partner leg's terms and fees
  effect?: ChangeEffect;          // change candidates: preview of effective minute and fees due with payer (R40-13)
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
  limit?: "key_rate_limit" | "account_rate_limit" | "key_poll_limit" | "mgmt_rate_limit";  // R40-15
  retry_after_ms?: number;        // rate_limited, poll_limited
}

interface ErrorAnswer {
  error: "unauthenticated" | "not_found" | "refused" | "temporarily_unavailable" | "invalid";
  right?: string;                 // refused: the missing right (RFC-005 §2.3)
  rule?: string;                  // invalid (422, offer answers only)
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
  cut_kept?: {                    // accepted or final, once the reduction's cut applies to the move (P1-S84, R40-17)
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

| Operation | Family (D2) | Method and path | Body | Success answers | Other answers |
|---|---|---|---|---|---|
| **quote** | quote | `POST /v1/quotes` | `QuoteRequest` | `200 Quote` | `400`, `401`, `403`, `404` (reservation of a change candidate), `409`, `422` (invalid candidate), `429 rate_limited`, `503` |
| **book** | booking and change | `POST /v1/bookings` | `BookRequest` | `200 RequestStatus` (final), `202 RequestStatus` (`pending`) | `400`, `401`, `403`, `404` (only for `quote_id`), `409`, `429 rate_limited`, `503` |
| **change** (cancel, shorten, extend/renew/make open-ended, increase, decrease) | booking and change | `POST /v1/reservations/{reservation_id}/changes` | `ChangeRequest` | as book | as book; `404` for the reservation or `quote_id` |
| **withdraw** | booking and change | `POST /v1/requests/{idempotency_key}/withdraw` | none; no `Idempotency-Key` header | `200`/`202 RequestStatus` of the named request, or of the pre-emptive withdrawal (D4) | `400` (path key malformed), `401`, `409 key_reuse_other_principal`, `429 rate_limited`, `503` |
| **status** | booking and change | `GET /v1/requests/{idempotency_key}` | none | `200`/`202 RequestStatus` | `404` (no such request), `409 key_reuse_other_principal`, `401`, `429 poll_limited`, `503` |
| **offer read** | — | `GET /v1/reservations/{reservation_id}/offers/{offer_id}` | none | `200 Offer & OfferStatus` | `401`, `403`, `404`, `429 poll_limited`, `503` |
| **offer accept** | offer answer | `POST /v1/reservations/{reservation_id}/offers/{offer_id}/accept` | `OfferAccept` | `200 OfferStatus` | `400`, `401`, `403`, `404`, `409`, `422`, `429 rate_limited`, `503` |
| **offer decline** | offer answer | `POST .../offers/{offer_id}/decline` | none | `200 OfferStatus` | as accept |
| **move earlier** | offer answer | `POST .../offers/{offer_id}/move-earlier` | `OfferMoveEarlier` | `200 OfferStatus` | as accept |
| **documented request** | documented request | `POST /v1/documented-requests` | `DocumentedRequestSubmit` | `201 DocumentedRequestRecorded` | `400` (incl. note over 4096 bytes), `401`, `403 refused`, `409`, `429 rate_limited` (`mgmt_rate_limit`), `503` |

`200` carries a final outcome (`confirmed`, `rejected`, `invalid`, `failed`); `202` carries
`pending`. A rejected, invalid or failed request is a **successful** HTTP exchange: the
outcome is the answer, not an error.

### Error codes

| HTTP | Body | When | Retry |
|---|---|---|---|
| 400 | `NotAccepted{malformed}` | As the "Malformed or invalid" table (M7). Nothing recorded | Fix and resend |
| 401 | `{error:"unauthenticated"}` | No, malformed, unknown, wrong, expired or revoked credential; ended session; key revoked as applied at the owner (`NotAccepted{revoked}`, X1-S06, X1-S41). Identical status, body and headers for every cause, sent no earlier than `unauth_floor` (5 ms) after arrival (RFC-005 §2.3) | No |
| 403 | `{error:"refused", right}` | Within the own tenant, the principal's kind or rights do not allow the operation (RFC-005 §4.2). The link-level and reservation-level checks (a probe key naming a non-probe link or answering an offer of a non-probe reservation) are made **at the owner** with C2 and recorded there; the edge refuses only by principal kind × operation and does not record (R40-25) | No |
| 404 | `{error:"not_found"}` | Reservation or offer outside the principal's account or not existing; a `quote_id` that fails verification or names another account; identical to a genuine miss (X1-S02, X1-S03, X1-S05, X1-S09). For `status`: "no such request", given only after a consistent read at the present timestamp shows no idempotency row (RFC-002 §8.2). Never for `withdraw` (D4) or the documented-request intake (D5) | No |
| 409 | `NotAccepted{key_reuse_different_request}` | Same principal, same family, same key, different fingerprint (P2-S26, P2-S113). Reveals nothing of the first request | Use a new key |
| 409 | `NotAccepted{key_reuse_other_principal}` | Another principal of the account used the key first in the family (P2-S64), including `status` and `withdraw` of its key (M4). Reveals nothing of the first request or its outcome | Use a new key |
| 422 | `{error:"invalid", rule}` | Offer answer breaking an offer rule (R40-18), or a quote candidate failing route, product or validity checks (§quote). Nothing recorded, key not consumed | Fix and resend |
| 429 | `NotAccepted{rate_limited, limit, retry_after_ms}` | Over `key_rate_limit` (50/s per key) or `account_rate_limit` (200/s per account), sliding second, `limit` naming which (P2-S41); for documented requests, `mgmt_rate_limit` (5/s per principal). Nothing logged, key not consumed. Header `Retry-After` (seconds, rounded up) | After `retry_after_ms`, same key allowed |
| 429 | `NotAccepted{poll_limited, limit:"key_poll_limit", retry_after_ms}` | Over `key_poll_limit` (20 per key per UTC second) at the edge poll limiter: status reads and offer reads (P2-S67, R40-19) | After `retry_after_ms` |
| 503 | `{error:"temporarily_unavailable"}` with header `Retry-After` (seconds) | Edge replica stale beyond `edge_staleness_max` for the credential; poll-limiter shard moving; status reader rule 4 (no read lease, moved partition, database unreachable); price cache older than 60 s at intake or quote (RFC-002 §3.2); owner partition `Stopped` (integrity stop) or routing exhausted after `Moving`/`Moved` (RFC-000 C4-7; M9) | Yes, after `Retry-After`, same key |

## Semantics per operation

### book

- **Preconditions** (edge, then owner): authenticated (RFC-005 §2.2); permission row "Book,
  change, cancel, withdraw (own account)" permits; the key is in the owner's applied key
  list or carried by an identity-signed key record naming the account; under the rate
  limits; the price cache's resolved timestamp within 60 s of the intake's `ts`.
- **Idempotency lookup** (RFC-002 §3.1 step 3) precedes everything that can create a
  request; a recorded request (or pre-emptive withdrawal, D4) under the key answers the
  submission without any further check.
- **Checks, in order** (R40-12), each failure recorded under the key as an outcome (E1′),
  so a retry returns it even after the horizon has rolled:
  1. **Route and product** (D6): `invalid`, `unknown_route` for an unknown `link_id`, legs
     that do not form a catalogue route, duplicate or empty legs, or a probe link named by
     a non-probe principal (revealing nothing of probe designation); `invalid`,
     `product_not_on_route` for a product unknown or not sold on the route. A probe key
     naming a non-probe link is `403` (R40-25).
  2. **Validity** (RFC-002 §3.2): window and rate by the link registry's rules, "now" = the
     minute boundary at or before receipt (`invalid_window`, `invalid_rate`,
     `beyond_selling_horizon`); deadline within 1 000 … 60 000 ms, ≥ 11 000 ms with a
     partner leg (`invalid_deadline`; P2-S12, P2-S86).
  3. **Rules**: at most one leg on a partner without holds (`rejected`,
     `rule_at_most_one_leg_without_holds`, P2-S34, P2-S36, P2-S102).
  4. **Terms shown** (D1, M2): the owner reads the terms it will lock. If they include
     **any partner-leg fee** and no `quote_id` is cited: `rejected`, `quote_required`. If a
     `quote_id` is cited and it is past `valid_until`, or any term it carries differs from
     the terms to be locked (price, price version, announced price change, any partner
     leg's `decrease_allowed`, `shorten_allowed`, `holds`, or any fee, its kind, amount,
     term end or `due_at_window_end`): `rejected`, `terms_changed`. Either way nothing is
     held, and `requote` carries the current terms with a fresh `quote_id`, so the agent
     resubmits **under a new key** citing it. Routes without partner-leg fees need no
     quote; a cited quote is still checked.
  5. **`admit`** in arrival order (RFC-004 §A5.1): `account_suspended` (with `resume`),
     `key_inflight_limit`, `account_inflight_limit`, `insufficient_funds` (with
     `top_up_min`, `top_up_min_plus_low_balance_warning`), `key_spend_limit`.

  Checks 4 and 5 are evaluated by the batch transaction at its commit timestamp `ts`, as
  `admit` is (RFC-002 §1.3, J-03): a batch pushed to a later timestamp re-evaluates them,
  so a price version taking effect in between can turn an intake into `terms_changed`, or
  the reverse.
- **Outcomes**: `confirmed` with `reservation_id` and `shown`; `rejected` for no fit
  (`no_fit`, `counter_offer`), for `wait = false` with capacity in flight (`in_flight`,
  `retry_after_ms`, `counter_offer`), for a definite partner refusal (`partner_refused`,
  `blocking_partner_link`, P2-S31), or by checks 3 … 5; `invalid`; `failed`
  (`deadline_passed`, `deadline_passed_while_waiting` with `retry_after_ms`,
  `interrupted_by_internal_failure`, `withdrawn`, `key_revoked`). A request not confirmed
  by its deadline has failed as of `D`; its `decided_at` is `D` and it is never reported
  before `D` (RFC-002 §6.5).
- **Shown figures**: `shown` echoes the terms locked in E1, which equal the cited quote's
  whenever one was cited. A request is never charged a fee that was not in a quote it
  cited (D1).
- **`quote_id` and idempotency**: `quote_id` is not a fingerprint field (POL-29); a retry
  under the same key is the same request whatever `quote_id` it carries, and the first
  submission governs. Hence after `quote_required` or `terms_changed`, a new key.

### change (cancel, shorten, extend, renew, make open-ended, increase, decrease)

- A change is a booking request with its own key, deadline and `wait` (RFC-002 §9.2).
  Fingerprint: reservation, kind, new end or new rate, `wait`, principal; the deadline and
  `quote_id` are not part of it (P2-S113).
- **Checks** as for book, in the same order, where they apply: validity; rules (a change
  to part of a route, `rule_route_changed_as_one_unit`, P2-S49; a decrease over a partner
  leg whose shown terms forbid it, `rule_decrease_not_allowed_by_partner_terms`, stating
  that the reservation may be cancelled instead, P2-S115); terms shown for **extend and
  increase** only (D1: an addition over a fee-bearing partner leg must cite a quote);
  `admit` for additions (`account_suspended` with `resume`, P2-S78). Invalid: an
  extension past the horizon (P2-S84). Reductions are never funds-checked and are allowed
  while suspended (P2-S77); cancel, shorten and decrease need no quote (their terms were
  shown at booking).
- **Ending changes are never queued**: `cancel`, or `shorten` with `new_end` at or before
  the next minute boundary (including a past end), end the reservation from the next
  boundary and fail every queued change and the change in progress with
  `reservation_ended` (P2-S43, P2-S81, P2-S94). An open-ended reservation may be given an
  end, or cancelled before it starts (P2-S85).
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
- **Fees** (RFC-002 §9.5, R40-04): `effect.fees_due` lists any fee the change makes due, at
  most one per reservation and leg. On a leg with both fees: a cancellation inside the
  minimum term pays the minimum-term fee; a cancellation after the term pays the plain
  fee; a shorten whose new end falls inside the term pays the minimum-term fee; a shorten
  to a later end never pays the plain fee. Payer `share` on a cancellation after a POL-07
  cut, or for a fee not shown; otherwise `buyer`.

### quote (M2, D1, D3)

- For a candidate booking or change, returns the terms the owner would lock now from its
  catalogue cache (the same cache and freshness rule as intake, RFC-002 §3.2): price per
  Mbps-minute and price version, any announced price change for an open-ended candidate,
  and for every partner leg whether shorten and decrease are allowed, whether it holds,
  and **every** fee with kind, amount, term end and `due_at_window_end`, plus `valid_until`.
  For a change candidate it also returns `effect`: the effective minute and the fees the
  change would make due, with payer (R40-13).
- **Checks**: well-formedness (`400`), tenancy (another account's reservation is `404`),
  and book checks 1 and 2 (route, product, validity). A candidate failing checks 1 or 2
  answers `422 {error:"invalid", rule}` with the reason code as `rule` (`unknown_route`,
  `product_not_on_route`, `invalid_window`, …); nothing is recorded, since a quote has no
  outcome. Not fit, funds or limits.
- **Not a booking request**: no outcome, nothing written to the account log, no capacity
  or funds hold, not counted toward capacity in flight or headroom, outside `ack_budget`.
  Latency: one owner round trip with an in-memory cache read and a MAC, est. p99 under
  50 ms within the region (est., to be sized in RFC-002 §14, AI-40-3).
- **Rate limits**: a quote counts as a submission toward `key_rate_limit` and
  `account_rate_limit` (AI-40-2). Consequence: an agent that quotes before every booking
  spends two of its submissions per booking, halving its booking throughput at the limit.
- **The token** (D3): `quote_id` is an owner-issued authenticated token, a MAC under a
  **per-account-slot quote key** held by every owner-lease holder of the slot (never the
  edge), over (account, candidate digest, the shown terms themselves, `valid_until`, key
  version), carrying the shown terms so that `book` and `change` verify and compare it
  statelessly. It survives every owner change (takeover, slot move, re-home). A token
  that fails verification or names another account is `404`. A key version is retired no
  earlier than the latest `valid_until` issued under it; RFC-002 owns the key's custody
  and rotation (AI-40-3).
- **Valid until** (R40-11): binding. A request citing a quote after its `valid_until` is
  rejected `terms_changed` with a `requote`, even if the terms are unchanged. The term
  comparison remains the safety rule. `valid_until` is never later than the next price
  version's effective minute known to the cache.
- Permission: "Quote (own account)", with the book row's columns (probe keys: probe links
  and probe reservations only), pending RFC-005's matrix row (AI-40-2).

### withdraw

- Names the **request's own idempotency key** in the path (RFC-002 §7.1, §9.2), so its
  retries are the same withdrawal; it takes no `Idempotency-Key` header (M5, R40-05). It
  addresses the booking-and-change family only.
- Undecided → `failed`, `withdrawn`; funds released, holds released, any partner booking
  already made cancelled at once at Share's cost (P2-S56, P2-S57, P2-S105); the buyer is
  not charged. Already decided → no effect; the answer is the decided outcome (P2-S103).
  Withdrawing a change request withdraws only that change.
- **Unknown key** (D4, R40-06): a withdrawal of a key the account has not used records a
  **pre-emptive withdrawal** under (account, booking-and-change family, key) with the
  principal: an E1′ with outcome `failed`, `withdrawn`, no fingerprint,
  `request_kind: "preemptive_withdrawal"`. The answer is that `RequestStatus`. A later
  submission under the key by the same principal is answered with it, whatever its body,
  and creates nothing; by another principal, `409 key_reuse_other_principal`. So a
  withdrawal that overtakes its booking still stops it. Counted toward `key_rate_limit`
  and `account_rate_limit` like any submission.
- A known key of another principal: `409 key_reuse_other_principal` (M4).
- The answer is the named request's `RequestStatus` under the ack rule below.

### status

- Answers the request named by (account, booking-and-change family, key) under the
  reporting gate and the status rule (below). Polls count only toward `key_poll_limit`,
  never toward booking rate limits (P2-S68).
- Another principal of the account reading a key it did not submit gets
  `key_reuse_other_principal`, revealing nothing (M4).
- A key never used in the account, used only by another account, or past
  `key_expires_at` and removed, is "no such request" (`404`), identical to a key never
  used anywhere (X1-S08, X1-S09). A client treats a `404` for a key it used more than
  `idempotency_retention` ago as expired, not lost (R40-24).

### Offers and moves (POL-07 steps 3 to 7; RFC-002 §9.6)

The offer itself reaches the holder as a notice (outside this contract); these
operations read and answer it.

- **Who may answer** (D8): any principal of the account permitted to change the
  reservation (account users and administrators, agent keys); probe keys only for probe
  reservations. The other-principal rule applies only to reuse of a key within the
  offer-answer family. Permission row "Answer an equivalent-path offer (own account)"
  pending RFC-005 (AI-40-2).
- **read**: the `Offer` with its current `OfferStatus`; counts toward `key_poll_limit`.
- **accept**: precondition: offer in `made` and not past `lapses_at`. On an all-Share path
  the move is `final` in the acceptance's own entry; with a partner leg the answer is
  `accepted` and becomes `final` once the partner booking is confirmed, or `failed` (as a
  declined offer; another path may be offered, P1-S61). `move_at = max(move_from,
  nb(ts))`; `move_from` defaults to the reduction's notice end and must be a minute
  boundary not after it (P1-S53; otherwise `422`). The moved reservation keeps each part's
  age and key (P1-S71) and pays the lower of the original and the path's price.
- **after the cut** (v1.10, P1-S84; M6, R40-17): once the reduction's cut applies to the
  move, `cut_kept` is present in every `OfferStatus` answer, `accepted` or `final`,
  stating the rate the cut left and that an increase may be booked on the path; so the
  holder is told at acceptance. Capacity held beyond it is released at the move.
- **decline**: `declined`; capacity held for the offer released at once (P1-S57); only the
  affected Mbps are removed at the notice end, with no charge for what is removed.
- **move-earlier**: while `accepted` or `final`, choose an earlier minute boundary
  `T ≥ nb(ts)` and earlier than `move_at` (otherwise `422`); recorded and used at
  `final`, or applied by a further change if already final.
- **lapse**: no answer by `lapses_at` counts as declined (P1-S45).
- Answering an offer in a terminal state (`final`, `failed`, `declined`, `lapsed`) has no
  effect and returns its `OfferStatus`. While `accepted`, the holder may still cancel the
  reservation (the offer then fails).

### documented request (POL-32; RFC-005 §7.5)

- **Precondition**: the console's intake evaluates C2 `decide(context, requested
  operation)` with the requester's principal context, and checks well-formedness; it
  records the request only on `permit` (the requester's kind may make that change
  itself). Account administrators, users and agent keys: yes; supplier principals and
  probe keys: no.
- **No existence check** (D5, R40-08): the target is recorded as given. Existence and
  tenancy are checked when support acts, at the owner, where another account's
  reservation is the same miss as a non-existent one (refused there, recorded). So the
  intake never answers `404`, and keeps X1-S02's uniform miss.
- **Outcome**: recorded on the console's log partition of the account's requests with the
  requester's `principal_id`, the action, the target and the time; `note` (≤ 4096 bytes)
  goes to the personal-data store as a case note (identifier and SHA-256 only in the log).
  The console renders the note as inert untrusted text and never feeds it to an
  automated actor (R40-22). The answer is `201` with `documented_request_ref`. Recording
  executes nothing: a support operator later acts citing it, as the account's own change
  (POL-08), never a termination.
- **No `withdraw`** action (D7): a pending request lives at most 60 s, and a support action
  needs a signed envelope and a hardware touch, so it could never act in time.
- **Errors**: `refused` (C2 `refused`, recorded), `unauthenticated`, `429` at
  `mgmt_rate_limit` (5/s per principal). Erasure of a user's own data is **not** this
  operation (RFC-005 C12).

## Acknowledgement rule (`ack_budget`)

- Every `book`, `change`, `withdraw`, and retry of a submission (not `quote`, offer
  answers or documented requests) receives an answer within **`ack_budget` = 200 ms at
  p99**, measured at the edge from receipt (POL-04, P2-S07, X2-S15). The owner holds the
  forwarded submission until the earlier of: the outcome is reportable (answer final,
  `200`), or `ack_budget` less the edge's share (est. 20 ms) after the edge received it,
  provided the intake is committed (answer `pending`, `202`) (RFC-002 §8.1).
- `pending` is sent only for a durable intake. If the intake cannot commit in time no
  answer is given within `ack_budget`; that counts as unavailability and the client
  retries with the same key.
- A route with a partner leg typically answers `pending` and reaches its outcome by its
  deadline (P2-S08, X2-S06).
- Quotes write nothing to the account log, so they take nothing from the account lane's
  `ack_budget` margin (D3).

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

- **Synchronous request/response.** Exactly-once effect per (account, family, key): any
  number of identical submissions, concurrent or retried, join one request (P2-S24,
  P2-S25, P2-S27).
- **Arrival order** for one account is the order the owner receives submissions (not
  client send order); admission checks run one at a time in that order, and a request
  refused because of another's hold stays refused (POL-25, P2-S70, P2-S112). A withdrawal
  may arrive before its booking; D4 makes that safe.
- **Per reservation**, non-ending changes apply in arrival order; endings are never
  queued (P2-S79, P2-S81).
- No ordering is promised across accounts, or between a synchronous answer and a webhook.

## Idempotency

Keys live in **one namespace per operation family** (D2): (account, family, key), with four
families. A key reused across families is independent: an agent may use one key per
intent for its quote and its booking.

| Family | Operations | Fingerprint | Same key, same fingerprint, same principal | Different fingerprint | Other principal of the account | Retention |
|---|---|---|---|---|---|---|
| **booking and change** | book; change (incl. cancel); `withdraw` and `status` address it | Booking: legs in order, window, rate, product, `wait`. Change: reservation, kind, new end or new rate, `wait`. Deadline and `quote_id` excluded (P2-S63, M2). A pre-emptive withdrawal has none (D4) | The same request: its current status under the ack rule; no new entry. Under a pre-emptive withdrawal, its `failed withdrawn` status whatever the body | `409 key_reuse_different_request`, first request unaffected (P2-S26, P2-S113) | `409 key_reuse_other_principal`, nothing revealed (P2-S64) | `idempotency_retention` 24 h from intake (`key_expires_at`); afterwards the key names a new request (P2-S65) |
| **quote** | quote | The candidate | The first `Quote` while the owner holds it in memory; otherwise a re-issued quote for the same candidate, equal to the first if the terms are unchanged (D3). Nothing is durable | `409 key_reuse_different_request` while held in memory | `409 key_reuse_other_principal` while held in memory; after an owner change, a fresh quote for the caller's own candidate, revealing nothing | Best effort, at most 24 h |
| **offer answer** | accept, decline, move-earlier | Offer, answer, `move_from` (M3) | The offer's current `OfferStatus` | `409 key_reuse_different_request` | `409 key_reuse_other_principal` | 24 h |
| **documented request** | documented request (deduplicated at the console, RFC-005 §7.5) | Action, target, parameters; note excluded (M8) | The first `DocumentedRequestRecorded` | `409 key_reuse_different_request` | `409 key_reuse_other_principal` | 24 h |

Not-accepted submissions consume no key (P2-S41). Keys of two accounts never meet
(X1-S08).

## Ownership

| Data | Written by | Read by |
|---|---|---|
| Intake, deciding and completing entries (incl. pre-emptive withdrawals), idempotency index, request and reservation records | Account owner (RFC-002), only | Status readers (follower reads and pushed batches), the owner |
| Offer state (E13) | Account owner | The owner and status readers |
| Quotes | Nobody: a quote is a stateless token, verified by the owner; at most held in owner memory for replay (D3) | The owner (verification at intake) |
| Per-account-slot quote key | RFC-002 (custody and rotation, AI-40-3); held only by owner-lease holders of the slot | Owner-lease holders of the slot |
| Documented requests | Operator console's log; case-note text in the personal-data store | Support (console), audit |
| Principal context | Edge (built from identity's replica); never signed by the edge | Owner, console (verify per RFC-005 C1) |
| Poll counters | Edge poll limiter (soft state) | Edge |

The edge keeps no authoritative state, never touches the database, and logs a keyed
digest of each idempotency key, never the key. Nothing of another account or another
principal's request is revealed by any answer.

## Timeouts and deadlines

| Item | Value | Source |
|---|---|---|
| `ack_budget` | 200 ms p99 | POL-04 |
| `status_staleness` | 1 s | POL-04 |
| `release_grace` | 1 min | POL-26 |
| Deadline `deadline_ms` | default 30 000; 1 000 … 60 000; ≥ 11 000 with a partner leg (`commit_margin` 10 s) | POL-26 |
| `idempotency_retention` | 24 h (`key_expires_at`) | POL-29 |
| `offer_window` | 7 days | POL-07 |
| Quote `valid_until` | Set by the owner per quote, binding; never later than the next price version's effective minute known to the cache | M2, R40-11 |
| Quote latency | est. p99 under 50 ms within the region; not an `ack_budget` operation | R40-26 (est.) |
| `unauth_floor` | ≥ 5 ms before any unauthenticated answer | RFC-005 §13 |
| `context_ttl` | 60 s (edge context to owner); bounds how late a forwarded booking can reach the owner after a withdrawal (D4) | RFC-005 §13 |
| Key revocation | No new request of a revoked key accepted after 60 s; its undecided requests fail `key_revoked` | POL-25, X1-S06, P2-S72 |
| Client timeout | A client SHOULD wait at least `ack_budget` plus its network round trip, then retry with the same key; a late first answer and the retry's answer agree | RFC-002 §3.1 |

## Versioning and compatibility

- Major version in the path (`/v1`). Within a major version only additive changes: new
  optional request fields with defaults that keep today's behaviour, new response
  fields, new `ReasonCode`, error `code` and `limit` values.
- Clients MUST ignore unknown response fields and treat an unknown `ReasonCode` by its
  `state` (`rejected`, `invalid`, `failed`). Providers MUST NOT change the meaning of a
  field, an existing code, a unit, a family or the fingerprint of an operation within a
  major version.
- A change to the fingerprint fields, the families, units, or the status guarantees is a
  new major version; both versions are served at least `idempotency_retention` past the
  announcement, so every key issued under the old version resolves under it.
- The quote token format is opaque and may change within a major version; a token from a
  retired key version is `404`, never before its `valid_until`.
- The policy version used for each decision is recorded by the owner (X1-N8); it is not
  part of the wire contract.

## Scenarios relied on

- **P2**: P2-S01 … P2-S13, P2-S18, P2-S23 … P2-S27, P2-S31, P2-S34, P2-S36, P2-S38 … P2-S50,
  P2-S54 … P2-S57, P2-S61, P2-S63 … P2-S70, P2-S72 … P2-S86, P2-S92, P2-S94, P2-S95,
  P2-S98, P2-S99, P2-S102, P2-S103, P2-S105 … P2-S108, P2-S110 … P2-S117.
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
| CT-P01 | Single-link booking, no capacity in flight, no partner fee: `200 confirmed` within 200 ms at p99 over 10⁴ calls | P2-S07, X2-S15 |
| CT-P02 | Partner route with slow partner: `202 pending` within 200 ms; polls reach the final outcome by `D` | P2-S08 |
| CT-P03 | Two identical submissions in parallel: one request, both answers equal | P2-S24 |
| CT-P04 | Retry after outcome, across an owner restart: same outcome | P2-S25 |
| CT-P05 | Same key, each fingerprint field changed (legs, window, rate, product, `wait`): `409 key_reuse_different_request`; changed deadline or `quote_id` only: same request | P2-S26, P2-S63 |
| CT-P06 | Same key by another agent key of the account: `409 key_reuse_other_principal`, body identical regardless of the first request's state; same for `status` and `withdraw` of that key | P2-S64 |
| CT-P07 | Same key from two accounts: independent; poll from the other account equals a never-used key | X1-S08, X1-S09 |
| CT-P08 | Change re-sent with each of reservation, kind, end/rate, `wait` changed: `409`; identical: same change | P2-S113 |
| CT-P09 | Rate limits: 51st/s per key `429` with `limit:"key_rate_limit"`, 201st/s per account with `limit:"account_rate_limit"`, key reusable; 21st poll/s (status or offer read) `429 poll_limited`; polls do not count toward booking limits; quotes do | P2-S41, P2-S67, P2-S68 |
| CT-P10 | Status never contrary and never `pending` after reported: fault-inject owner takeover, status-reader lease loss, slot move and link failover during and after the decision; assert the five guarantees | P2-S10, P2-S99, P2-S106 … P2-S108, P2-S111 |
| CT-P11 | Expiry: outcome `failed` with `decided_at = D`, never reported before `D`; waiter gets `deadline_passed_while_waiting` and top-level `retry_after_ms` | P2-S13, P2-S61, P2-S95 |
| CT-P12 | Rejections: no fit returns `counter_offer` beside held capacity; `wait=false` returns `in_flight` with top-level `retry_after_ms`; a definite partner refusal returns `partner_refused` with `blocking_partner_link` naming P; two legs without holds rejected before anything is held; funds returns both top-up amounts in micros strings; suspended returns `resume` whose items sum to `total` | P2-S02, P2-S18, P2-S31, P2-S34, P2-S38, P2-S69, P1-S73, P4-S114 |
| CT-P13 | Invalid deadlines (61 s, 0, −5 s, 0.5 s, 10 s with partner) are `invalid`, recorded, returned on retry | P2-S12, P2-S86 |
| CT-P14 | Cancel during a queued increase: cancel effective next boundary, increase `failed reservation_ended`; cancelled capacity free on every Share leg when the outcome is read; an open-ended reservation given an end, and one cancelled before it starts | P2-S43, P2-S81, P2-S85, P2-S94 |
| CT-P15 | Decrease over a partner leg forbidding it: `rejected rule_decrease_not_allowed_by_partner_terms` | P2-S115 |
| CT-P16 | `shown` and `Quote.shown` on a partner route: decrease and shorten allowed, `fees[]` with kind, amount, term end, `due_at_window_end` true for a 10-day window on a 30-day term, false for 30 days; a leg with **both** a minimum term and a plain fee lists both, and a cancellation inside the term makes only the minimum-term fee due, after it only the plain fee | P2-S50, P3-S43, P3-S63, P3-S74 |
| CT-P17 | Withdraw pending → `failed withdrawn`, partner leg cancelled at Share's cost; withdraw decided → decided outcome | P2-S56, P2-S57, P2-S103 |
| CT-P18 | Unauthenticated causes are byte-identical and ≥ 5 ms; another account's reservation `404` identical to a missing one; an agent key naming another account's reservation gets that `404` and nothing is forwarded | X1-S01 … X1-S03, X1-S05 |
| CT-P19 | Offer: accept all-Share → `final` with `move_at`; accept with partner leg → `accepted` then `final` or `failed`; decline releases; lapse after 7 days; acceptance after the cut → `cut_kept` already in the `accepted` answer; another user of the account may answer | P1-S35, P1-S45, P1-S53, P1-S57, P1-S60, P1-S61, P1-S84 |
| CT-P20 | Quote then book citing it, terms unchanged: confirmed, `shown` equal to the quote's; price version or a partner fee changed between quote and intake: `rejected terms_changed`, nothing held, `requote` with current terms; quote past `valid_until`, terms unchanged: `terms_changed`; fee-bearing partner route with no `quote_id`: `rejected quote_required` with `requote`, and the resubmission under a new key citing it is confirmed; quote holds no capacity, no funds, writes no log entry | P2-S50, P3-S74 |
| CT-P21 | Quote replay under the same key returns the same `Quote`; different candidate `409`; quote, then owner takeover (and separately a slot move), then book citing it: verified and confirmed; tampered or other-account token `404` | — |
| CT-P22 | Price version effective between composition and a pushed-later commit of the intake: the in-transaction re-evaluation turns it into `terms_changed` | — |
| CT-P23 | The same key used for a quote then a book: one quote and one request, no `409` (D2); the same key used for an offer answer and a documented request: independent | — |
| CT-P24 | Withdraw with no `Idempotency-Key` header is accepted | — |
| CT-P25 | Withdraw of key K, then a delayed book under K by the same principal: answered `failed withdrawn`, no reservation, nothing held; by another principal: `409` | — |
| CT-P26 | Unknown link, legs not a catalogue route, duplicate or empty legs, product not on the route: `invalid` `unknown_route` / `product_not_on_route`, recorded; a non-probe principal naming a probe link: `unknown_route`, same body as an unknown link; a probe key naming a non-probe link: `403`, recorded at the owner | — |
| CT-P27 | Revoked key and ended session refused `401` at every edge within 60 s; the revoked key's undecided requests `failed key_revoked`, reservations kept | X1-S06, X1-S41, P2-S72 |
| CT-P28 | Offer-answer key reuse with a different answer `409`; `move_from` after `T_eff` or off-boundary, move-earlier not earlier than `move_at`: `422`, nothing recorded, key reusable | — |
| CT-P29 | `400 malformed` for each row of the "Malformed or invalid" table, nothing recorded, key reusable; keys `.`, `..` and a 129-character key `400`; access logs hold no key in clear | — |
| CT-P30 | Owner partition `Stopped`: `503` with `Retry-After`; retry after the resume with the same key yields one request | — |
| CT-P31 | Documented request: permitted principal → `201`, note absent from every log; note over 4096 bytes `400`; principal that may not make the change → `403`, recorded; one naming another account's reservation → `201`, and the later support action is refused with the same answer as for a non-existent reservation; support action without a documented request refused | X1-S27 |

### Consumer (buyer SDKs and agents)

| ID | Test |
|---|---|
| CT-C01 | Sends an `Idempotency-Key` on every `POST` except `withdraw`, and reuses it, unchanged with the same body, for every retry of that intent within its family; may reuse one key across families for one intent |
| CT-C02 | On timeout or `503`, waits `Retry-After` and retries with the same key; never mints a new key for the same intent |
| CT-C03 | Treats `202 pending` as non-final and polls (respecting `key_poll_limit`) or awaits the webhook; flags a `pending` read after a final read as a provider defect |
| CT-C04 | Parses money as decimal strings into integer micros, never floating point; rates as integers; durations as ms |
| CT-C05 | Honours `retry_after_ms` on `429` (backing off the key or the whole account as `limit` says) and on `in_flight` rejections |
| CT-C06 | Ignores unknown fields; maps unknown `ReasonCode` by `state` |
| CT-C07 | Sends windows on minute boundaries and `end: null` for open-ended |
| CT-C08 | Quotes before a booking or addition on a partner route and cites `quote_id`; on `quote_required` or `terms_changed`, accepts or rejects `requote` and, if accepting, resubmits under a **new** key citing its `quote_id` |
| CT-C09 | Withdraws by the target's key with no header; treats the answer, including a pre-emptive `failed withdrawn`, as "this key will not book" |
| CT-C10 | Never resubmits a key past `key_expires_at`; treats a `404` for such a key as expired, not lost |
| CT-C11 | Generates keys with at least one alphanumeric character and no personal data |

## Errata required of other documents

C10 is frozen only once these are taken (R40-09). Review 40's IDs are kept.

| ID | Against | Erratum |
|---|---|---|
| AI-40-1 | RFC-000 §8 | Booking API row: "book, change (incl. cancel), withdraw, status, quote, offer read/accept/decline/move-earlier"; outcomes include `TERMS_CHANGED`/`terms_changed` and `quote_required` |
| AI-40-1 | RFC-000 §4.4 | One idempotency row per family (D2): booking and change; quote ("stateless token, no log entry", D3); offer answer; documented request; the namespaces are separate. A pre-emptive withdrawal is recorded under the booking-and-change key (D4) |
| AI-40-2 | RFC-005 §4.2 (permission matrix) | Rows "Quote (own account)" and "Answer an equivalent-path offer (own account)" with the book row's columns (probe: probe links and probe reservations only); the documented-request row without `withdraw` (D7). **Freeze condition**: without these rows C2 refuses `quote` and every offer answer at the edge |
| AI-40-2 | RFC-005 §5.2 | Idempotency scopes for quote, offer answer and documented request, each its own namespace (D2) |
| AI-40-2 | RFC-005 §5.3 | Quotes and offer answers count toward `key_rate_limit` and `account_rate_limit`; offer reads toward `key_poll_limit`; documented requests at `mgmt_rate_limit` |
| AI-40-2 | RFC-005 §7.5 | Idempotency (account, documented-request family, key), 24 h; no existence check at intake (D5); note ≤ 4096 bytes, rendered inert; no documented `withdraw` (D7) |
| AI-40-2 | RFC-005 §2.3, §4.1 | The link-level and reservation-level refusal (probe key on a non-probe link or reservation) is made and recorded at the owner, not the edge (R40-25) |
| AI-40-3 | RFC-002 §3.2 | Check order: route and product (D6, `unknown_route`, `product_not_on_route`), validity, rules, terms shown (`quote_required`, `terms_changed`, D1), `admit`; checks 4 and 5 re-evaluated in the transaction at `ts` (R40-12); E1′ records the current terms and a fresh `quote_id` |
| AI-40-3 | RFC-002 §7.1, §8.2 | Pre-emptive withdrawal of an unknown key (D4); `withdraw` never answers "no such request" |
| AI-40-3 | RFC-002 §13.1 | `quote` (stateless token under a per-slot key, its custody and rotation), offer read and answers with their idempotency (M3), cancel as a change kind (M1), `cut_kept` at acceptance (P1-S84), `Stopped` → temporarily unavailable (C4-7, M9), `blocking_partner_link`, `key_expires_at`, `fees[]` per leg |
| AI-40-3 | RFC-002 §14 | Quote load sizing (est.): owner CPU per quote, no lane write |
| AI-40-4 | RFC-004 §A10 | `ResumeQuote += headroom_after: Micros`, subject to RQ-40-4 |
| RQ-40-1 | Glossary "Outcome", POL-08 | "Rejected" also covers terms no longer those shown, and a fee-bearing route booked without the terms shown (the rejection states the current terms) |
| RQ-40-2 | Glossary "Not accepted", "Outcome" | Not accepted adds "not parseable as a request"; "invalid" becomes "breaks a validity rule (window, rate, deadline, horizon, route)" |
| RQ-40-3 | POL-29 | "A withdrawal names the request's own key and is the same withdrawal on every retry" |
| RQ-40-4 | P4-S114 / POL-16 | Confirm whether headroom-after is an item of the resume amount |
| RQ-40-5 | POL-08, glossary | "Shown before booking" for an API client: present in a quote the request cites (D1) |

## Settled

The points where the sources disagreed or were silent, settled by the orchestrator's
binding decisions. Section references in this contract to M1 … M9 point here.

| # | Point | Sources | Settlement |
|---|---|---|---|
| M1 | `cancel` as its own operation or a change kind | RFC-002 §13.1 vs §9.2, POL-29 | One `changes` endpoint with `kind: "cancel"`, the change fingerprint |
| M2 | Figures shown before booking (POL-08, P3-S74, P2-S50) with no quote operation in RFC-002 or RFC-000 §8 | POL-08, P3-S74 vs RFC-002 §13.1 | **Override**: a `quote` operation (`POST /v1/quotes`, idempotent by key, holds nothing, outside `ack_budget`) returns price, every shown fee with kind, term end and `due_at_window_end`, partner terms including whether shorten and decrease are allowed, and `valid_until`; `book` and `change` may carry `quote_id`, and if any shown term differs when the terms are locked the request is rejected `terms_changed` (`TERMS_CHANGED`), never charging terms not shown; the booking answer still echoes the figures. **Narrowed by review 40**: D3, `quote_id` is a stateless owner-signed token carrying the shown terms and `valid_until`, nothing written to the account log; quote idempotency is "the first quote while held in memory, else an equal re-issue", no longer "unchanged even past `valid_until`"; `valid_until` binding (R40-11). D1, `quote_id` is **required** when the locked terms carry any partner-leg fee (`quote_required`). D2, quotes have their own key namespace. Errata: AI-40-1 … AI-40-3, RQ-40-1, RQ-40-5 |
| M3 | Offer answers not in the booking API's operation list | RFC-000 §8, RFC-002 §13.1 vs §9.6 | Offer read, accept, decline, move-earlier; idempotent in the offer-answer family, fingerprint (offer, answer, `move_from`); outside `ack_budget`; counted as submissions for rate limits, reads toward `key_poll_limit`; any permitted principal of the account may answer (D8) |
| M4 | Status read by another principal of the account | RFC-005 §4.2 vs POL-29, RFC-002 §8.2 | `409 key_reuse_other_principal`, nothing revealed (also for `withdraw`) |
| M5 | Withdraw's key | POL-29 vs RFC-002 §9.2 | Names the target request's key in the path, no key of its own and no header (R40-05); an unknown key records a pre-emptive withdrawal (D4) |
| M6 | Acceptance answer after the cut (v1.10, P1-S84) | P1-S84 vs RFC-002 §9.6 | `OfferStatus.cut_kept`, present in `accepted` and `final` (R40-17) |
| M7 | Malformed bodies | Glossary vs RFC-002 §3.2 | `400 NotAccepted{malformed}`, nothing recorded; well-typed values breaking a rule are the recorded outcome `invalid`; the boundary is the "Malformed or invalid" table (R40-23) |
| M8 | Documented-request idempotency, latency, answer | RFC-005 §7.5, RFC-000 §8 | (account, documented-request family, key), fingerprint (action, target, parameters), 24 h; `201` after the console log commits; no `ack_budget`; no existence check (D5); no `withdraw` (D7) |
| M9 | `Stopped` from the owner runtime | RFC-000 C4-7 | `503 temporarily_unavailable` with `Retry-After`; the client retries with the same key |

## Review 40 resolution

All fixes accepted as review 40 proposes, with its decisions D1 … D8 (binding).

| ID | Severity | Resolution in draft.3 |
|---|---|---|
| R40-01 | Major | D3: stateless owner-signed `quote_id` under a per-slot key, carrying the shown terms and `valid_until`; no log write; survives owner changes; quote replay narrowed (§quote, Idempotency, Ownership, M2); CT-P21 |
| R40-02 | Major | D2: four families, (account, family, key); `status` and `withdraw` read only booking and change (Idempotency, endpoints); CT-P23, CT-C01 |
| R40-03 | Major | D1: `quote_required` for book, extend, increase whose locked terms carry any partner-leg fee and cite no quote, with `requote` (§book check 4, §change); CT-P20, CT-C08 |
| R40-04 | Major | `PartnerLegTerms.fees: ShownFee[]`; which fee one event makes due, at most one per reservation and leg (§change Fees); CT-P16 |
| R40-05 | Major | Header table and 400 row: `withdraw` takes no `Idempotency-Key`; CT-P24 |
| R40-06 | Major | D4: pre-emptive withdrawal recorded under the key, `request_kind: "preemptive_withdrawal"`; no `404` on withdraw; CT-P25, CT-C09 |
| R40-07 | Major | D6: `invalid` `unknown_route` (incl. probe link named by a non-probe principal) and `product_not_on_route`, checked first; `404` on book only for `quote_id`; CT-P26 |
| R40-08 | Major | D5: no existence check at the documented-request intake; `404` removed; CT-P31 |
| R40-09 | Major | "Errata required of other documents" lists AI-40-1 … AI-40-4 and RQ-40-1 … RQ-40-5; freeze conditional on RFC-005's matrix rows (Status) |
| R40-10 | Major | `blocking_partner_link` on `partner_refused`; P2-S18, P2-S31, P2-S34 cited; CT-P12 |
| R40-11 | Minor | `valid_until` binding: past it, `terms_changed` with `requote` |
| R40-12 | Minor | Check order stated; terms check and `admit` re-evaluated in the transaction at `ts`; CT-P22 |
| R40-13 | Minor | `Quote.effect` for change candidates |
| R40-14 | Minor | `ResumeAmount.headroom_after?`, subject to RQ-40-4 and AI-40-4 |
| R40-15 | Minor | `NotAccepted.limit` |
| R40-16 | Minor | Top-level `retry_after_ms` authoritative; removed from `CounterOffer` |
| R40-17 | Minor | `cut_kept` in `accepted` and `final` |
| R40-18 | Minor | `422 {error:"invalid", rule}` for offer-rule violations, nothing recorded, key not consumed; CT-P28 |
| R40-19 | Minor | Offer reads count toward `key_poll_limit`; `429 poll_limited` |
| R40-20 | Minor | Key needs an alphanumeric character, no dots-only key; no personal data; the edge logs a keyed digest; CT-P29, CT-C11 |
| R40-21 | Minor | D7: documented `withdraw` and `request_idempotency_key` dropped |
| R40-22 | Minor | Note ≤ 4096 bytes; `mgmt_rate_limit` 5/s per principal; rendered inert, never fed to an automated actor |
| R40-23 | Minor | "Malformed or invalid" table |
| R40-24 | Minor | `RequestStatus.key_expires_at`; CT-C10 |
| R40-25 | Minor | Link-level and reservation-level probe refusals made and recorded at the owner (403 row; AI-40-2) |
| R40-26 | Minor | Tests added (CT-P21 … CT-P31, CT-C08 … CT-C11) and renumbered in order; quote p99 (est.) and the shared-limit consequence stated in §quote |
