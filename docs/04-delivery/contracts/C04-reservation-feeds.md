# C04. Reservation feeds: request outcome feed, reservation lifecycle feed, and the operator side of the reservation command port

| | |
|---|---|
| Contract ID | C04 |
| Version | 2 (draft). Revises version 1 per [review 43](../../reviews/43-contract-C04-review.md); see [Review 43 resolution](#review-43-resolution) |
| Status | **Draft**, for contract re-review. Every point is settled by the orchestrator (see [Settled](#settled)). Frozen after a contract review ACCEPT (tag `contract-C04-v2`) |
| Provider | RFC-002 (the account owner: the booking module, and RFC-004 Part A's funds module, writing to the same log) |
| Consumers | RFC-006 (the notifier, alerting and history), RFC-003 (rating, and the catalogue's locked-price read model), RFC-004 (Part A owns the release-after-grace rule; Part B settlement reads this feed only through RFC-003's charge lines), RFC-005 (envelope verification on the command port), the operator console, reporting |
| Transport | **Kafka event** for both feeds, published from the transactional outbox (direct publish plus changefeed relay; C01 §2.5, RFC-006 §5.3). **Synchronous gRPC command** for `terminate`, routed by account slot with C01's `CommandEnvelope`. **In-process** for release after grace: the funds module's F7 outcome feeds the booking module's E11 in the same entry, and nothing goes on the wire |
| Pinned to | `requirements-v1.10`. RFC-000 rev. 4.4 (§8 rows "Request outcome feed", "Reservation lifecycle feed" and "Reservation command port"; "Revision 4.4 errata" C4-1 … C4-7). RFC-002 rev. 5 (§2.2, §2.5, §8, §9, §10.4, §10.6, §13.1). RFC-003 rev. 5 with erratum 5.1 (§5.1, §5.2, §5.4, §5.6, §5.7, §7). RFC-004 rev. 5 with erratum 5.1 (§A4 E11/F7 rows, §A7, JR-2, §B3.4). RFC-005 rev. 5 (§7.2, §7.3, §7.4). RFC-006 rev. 6 (§5.3, §5.4, §5.5, §12.5, §15, §16) |
| Depends on | **C01** (the platform contract). From it this contract takes `HlcTs`, `SlotNo`, `PartitionKey`, `Generation`, `Epoch`, `Seq`, `StreamSeq`, `FeedHeaders`, `FeedEvent`, `ReportMarker`, `ResolvedMarker`, `CommandEnvelope` and `RoutingRefusal`. It also relies on C01's rules for per-stream sequences, (generation, epoch) fencing, the `reported` gate, the closure emitter, `Ambiguous` resolution and feed-event idempotency. **C02** supplies `cut_target` and its revisions, and **C03** the `CUT_DECIDED` and `REDUCTION_FINAL` closure holds. **C05** is the in-process booking/funds interface. **C10** defines the buyer's `pending` answer. None of their rules are restated here |

## Purpose

The account owner decides requests and changes reservations. Other components rely on
three things that come out of those decisions:

1. **Request outcome feed.** One event per reported outcome of a booking or change
   request, plus per-slot report markers. Each marker also lists the newly covered
   requests that were answered `pending`. The notifier sends a buyer webhook only for an
   outcome at or below a marker, and only if the buyer was answered `pending`. Alerting
   and the operator console list failed requests.
2. **Reservation lifecycle feed.** The part-level history of every reservation:
   - parts and locked prices;
   - legs;
   - effective minutes;
   - ends and their causes, and shortens;
   - fees shown, and when they fall due;
   - moves and price steps;
   - POL-07 cuts;
   - partner-leg affected status;
   - POL-28 residue;
   - offer notices.

   The feed has an effective-time closure. Rating accrues from it, history answers "as
   known at T" from it, and the notifier tells holders from it.
3. **Reservation command port, operator side.** `terminate`, which can carry
   `withhold_notice` only inside a compliance legal-order termination, and the internal
   release after grace. Cut targets and equivalent-path offers go through the same port,
   but they are C02's. They appear here only as the `cut`, `moved`, `offer_*` and
   `offer_cut_kept` events defined below.

## Schema

All messages are given in TypeScript.

**Kafka encoding.** Every event is a C01 `FeedEvent`:

- the routing and ordering fields are the clear C01 `FeedHeaders`: `partition`, `stream`,
  `stream_seq`, `generation`, `epoch`, `ts`, `kind`, `schema_v`, `key_id`, and
  `report_through` or `resolved` on markers;
- the `value` is the owner's ciphertext (RFC-005 column encryption, key purpose "feed").

The types below describe the plaintext `value`.

**Field rules:**

- No field carries personal data (RFC-000 A11). Principals are pseudonymous.
- C01's `bigint` types (`Epoch`, `Seq`, `StreamSeq`) are serialised as decimal strings,
  both in payloads and in headers.

### Units and shared types

| Quantity | Type | Unit |
|---|---|---|
| Commit timestamp | `HlcTs` (C01 §2.1) | The database's HLC decimal string, totally ordered. "At or below" always means HLC order |
| Effective minute | `UtcMinute` | ISO 8601 UTC on a minute boundary, `"2026-10-12T09:31:00Z"`. Minute `m` covers `[m, m + 1 min)` |
| Window | `{ start: UtcMinute; end: UtcMinute \| null }` | Half-open `[start, end)`. `null` means open-ended |
| Rate | `Mbps = number` (integer ≥ 0) | Mbps |
| Money | `MicroUsd = string` | Decimal integer string of micro-USD (10⁻⁶ USD), for example `"500000"` |
| Unit price | `PicoUsdPerMbpsMin = string` | Decimal integer string of pico-USD (10⁻¹² USD) per Mbps-minute (RFC-003 §2) |
| Durations | `Millis` (C01) | Milliseconds, unless the field name says `_min` (whole minutes) |

```ts
import type { HlcTs, SlotNo, PartitionKey, Generation, Epoch, Seq, StreamSeq,
              FeedHeaders, ReportMarker as C01ReportMarker, ResolvedMarker,
              CommandEnvelope, RoutingRefusal, Millis } from "C01";

type AccountId = string;        // pseudonymous account id; its bytes are the PartitionKey
type RequestId = string;        // "<account>:<seq>", the E1's (account partition, Seq)
type ReservationId = string;
type PartId = string;           // unique within its reservation
type LinkId = string;
type ReductionId = string;      // RFC-001's reduction id, unique per link
type OfferId = string;
type CatalogueRouteId = string;
type ProductId = string;
type PriceVersion = string;
type ChangeId = string;         // "<account>:<seq>", the E11's (account partition, Seq); every leg command of that E11 carries it
type PrincipalRef = string;     // pseudonymous principal (RFC-005)
type KeyRef = string;           // pseudonymous API key reference
type PathId = string;           // "0" for the booked path; the OfferId of the move that put the reservation on its current path
type FeeId = string;            // "<reservation>/<path>/<leg index>" (Settled MM-2, review 43 D-2)
type UtcInstant = string;       // ISO 8601 UTC with milliseconds

interface MinutePiece { from: UtcMinute; rate: Mbps }   // holds from `from` until the next piece's `from`; the last until the part's end
type Pieces = MinutePiece[];                              // strictly increasing `from`; adjacent equal rates merged
interface PartRates { part: PartId; pieces: Pieces }     // absolute; supersedes every earlier statement for the part from pieces[0].from on
interface LinkReduction { link: LinkId; reduction: ReductionId }

/** Fields every payload repeats from its entry. Headers stay authoritative for ordering. */
interface PayloadBase {
  account: AccountId;
  entry_seq: Seq;               // the log entry's sequence in the partition
  withheld_by: string | null;   // action_id of a termination with notice "withheld" whose entry caused this event; else null (review 43 D-3)
}
```

### Request outcome feed

The topic is `account.outcome.v1`, **keyed by account slot** (RFC-000 B-AI-8; C01 §2.5).
Every partition of a slot, and every marker of that slot, goes to the same Kafka
partition.

```ts
type Outcome = "confirmed" | "rejected" | "invalid" | "failed";

type OutcomeReason =
  | { code: "confirmed" }                                                       // a booking, or a change that confirmed (added part, cancel, shorten, decrease)
  | { code: "invalid"; rule: string }
  | { code: "insufficient_funds"; needed: MicroUsd; available: MicroUsd }
  | { code: "limit"; limit: string }
  | { code: "account_suspended"; resume_amount: MicroUsd; items: { label: string; amount: MicroUsd }[] }
  | { code: "change_to_part_of_route" | "more_than_one_partner_without_holds" }
  | { code: "decrease_forbidden_by_partner_terms"; may_cancel_instead: true }   // P2-S115
  | { code: "no_fit"; blocking_link: LinkId; counter_offer: CounterOffer }
  | { code: "in_flight"; blocking_link: LinkId; retry_after: UtcInstant; counter_offer: CounterOffer } // wait = false
  | { code: "partner_refused"; partner_link: LinkId }
  | { code: "partner_fault"; leg: number; partner_link: LinkId }
  | { code: "deadline_passed" }
  | { code: "deadline_passed_while_waiting"; retry_after: UtcInstant }
  | { code: "interrupted_by_internal_failure" }
  | { code: "withdrawn" }
  | { code: "reservation_ended" }
  | { code: "reservation_changed_by_share" }
  | { code: "suspended" | "key_revoked" };

interface CounterOffer {
  largest_rate: Mbps;
  earliest_window: { start: UtcMinute; end: UtcMinute | null } | null;
  share_legs_only: boolean;                 // true when the route has a partner leg
}

interface OutcomeEvent extends PayloadBase {   // headers: stream "outcome", kind "outcome"
  slot: SlotNo;                             // writer's slot (also the Kafka key)
  request: RequestId;
  idempotency_key_digest: string;
  principal: PrincipalRef;
  request_kind: "book" | "change";
  change_kind: "cancel" | "shorten" | "extend" | "increase" | "decrease" | null; // request_kind "change" only
  reservation: ReservationId | null;        // set for a confirmed booking and for every change
  outcome: Outcome;
  reason: OutcomeReason;
  decided_ts: HlcTs;                        // ts of the deciding entry (E5, E1′, E4/E6/E7, or the E11 that decides or fails the change)
  stated_time: UtcInstant;                  // D for an expiry; decided_ts otherwise
  leg: number | null;                       // the leg concerned, when the reason names one (P2-S51)
  answered_pending: boolean;                // true if `pending` was sent before this entry was formed (Settled MM-10)
}

/** C01's ReportMarker, extended by this contract (review 43 B-01, D-1). Headers: kind "report_marker", report_through = reportPosition. */
interface ReportMarker extends C01ReportMarker {   // { slot: SlotNo; generation: 0; epoch: Epoch; reportPosition: HlcTs }
  prevReportPosition: HlcTs | null;         // the previous marker's reportPosition for this slot, as written; null if the writer has none
  pending_answered: RequestId[];            // requests whose outcome events this marker newly covers (prev < ts ≤ reportPosition) and that were answered `pending`
}
```

### Reservation lifecycle feed

The topic is `account.lifecycle.v1`, **keyed by account partition** (C01 §2.5). Each
destination Kafka partition also carries C01 `ResolvedMarker`s.

```ts
interface Leg {
  index: number;                            // 0-based, route order, within its path
  link: LinkId;
  kind: "share" | "partner_with_holds" | "partner_without_holds";
  shown_fees: ShownFee[];                   // partner legs only; [] otherwise
}

interface ShownFee {
  fee_id: FeeId;
  partner_link: LinkId;
  amount: MicroUsd;
  kind: "plain" | "minimum_term";
  term_end: UtcMinute | null;               // minimum_term only
  due_at_window_end: boolean;               // minimum_term only (P3-S74)
}

interface Part {
  part: PartId;
  own_rate: Mbps;
  window: { start: UtcMinute; end: UtcMinute | null };  // start ≥ floor_min(ts) of the entry that added it (see Effective minutes)
  locked_price: PicoUsdPerMbpsMin;
  price_version: PriceVersion;
  catalogue_position: string;               // J-17
  locked_at: HlcTs;
  age: HlcTs;                               // request_age of the admission that added it
  request: RequestId;
  added_by: { principal: PrincipalRef; key: KeyRef | null }; // P2-S117
}

interface FeeDue { fee_id: FeeId; amount: MicroUsd; payer: "account" | "share" }

type EndCause =
  | "cancelled"              // by the account (a shorten to or before the next boundary included; support at a documented request)
  | "cancelled_after_cut"    // by the holder after a POL-07 rate cut; Share pays a shown fee
  | "revoked"                // POL-07: every part's current rate 0 to the end
  | "released"               // POL-16 release after grace
  | "terminated"             // POL-30
  | "window_end";            // ended at its window's end, as booked or as last changed

interface LifecycleBase extends PayloadBase {   // headers: stream "lifecycle"
  account_is_probe: boolean;                // cross-check only; the catalogue designation is the source of truth (m-05)
  reservation: ReservationId | null;        // null only for residue events of a booking request
  change_id: ChangeId | null;               // the E11's id for E11 events; null otherwise
}

type LifecycleEvent =
  | Confirmed | PartAdded | RateDecreased | Cut | Shortened | Moved | PriceStep | Ended
  | LegChangesDurable | PartnerLegAffected | Pol28Residue | OfferNotice | OfferCutKept;

interface Confirmed extends LifecycleBase {
  kind: "confirmed";                        // E5 of a booking
  route: CatalogueRouteId;
  product: ProductId;
  path: "0";
  legs: Leg[];
  window: { start: UtcMinute; end: UtcMinute | null };
  parts: Part[];                            // exactly one
  decided_ts: HlcTs;
  announced_price_steps: { price_version: PriceVersion; effective: UtcMinute }[];
  booked_by: { principal: PrincipalRef; key: KeyRef | null };
}

interface PartAdded extends LifecycleBase {
  kind: "part_added";                       // E5 of an extension, renewal, open-ended change or increase
  part: Part;
  window: { start: UtcMinute; end: UtcMinute | null };
  part_rates: PartRates[];
}

interface RateDecreased extends LifecycleBase {
  kind: "rate_decreased";
  effective: UtcMinute;                     // nb(ts)
  part_rates: PartRates[];
}

interface Cut extends LifecycleBase {
  kind: "cut";                              // one per revision above the highest recorded for (link, reduction, reservation) (V52-1)
  link: LinkId;
  reduction: ReductionId;
  target_revision: number;                  // the revision of the cut_target command this E11 applied (C02)
  t_eff: UtcMinute;
  target: Pieces | "none";                  // as recorded after this command: per-minute min over every revision received for the key
  covered_parts: PartId[];
  applied: { status: "applied"; change_ids: ChangeId[] }    // [] = no part's rate changed; otherwise [this E11's change_id]
         | { status: "not_applied"; why: "ended" | "left_link" };
  part_rates: PartRates[];                  // changed parts from t_eff; [] when nothing changed
  applies: LinkReduction[];
  rate_cut: boolean;                        // some part's current rate fell (POL-08: the holder may cancel without fee)
}

interface Shortened extends LifecycleBase {
  kind: "shortened";
  new_end: UtcMinute;
  part_rates: PartRates[];
  fee_due: FeeDue | null;                   // only a minimum-term fee the new end falls inside
}

interface Moved extends LifecycleBase {
  kind: "moved";                            // E11 written with E13 final
  offer: OfferId;
  path: PathId;                             // = offer
  route: CatalogueRouteId;
  shown_price: PicoUsdPerMbpsMin;
  move_at: UtcMinute;
  delay_min: number;
  legs: Leg[];                              // the new path's legs; their shown fees carry fee ids under the new path
  part_rates: PartRates[];                  // every part from move_at, at the rates the targets recorded before this entry leave (m-07)
  applies: LinkReduction[];
  fees_due: FeeDue[];                       // old-path partner fees falling due at move_at by cancelling the old partner leg; payer "share" (M-03)
}

interface PriceStep extends LifecycleBase {
  kind: "price_step";
  price_version: PriceVersion;
  effective: UtcMinute;
  route: CatalogueRouteId;
}

interface Ended extends LifecycleBase {
  kind: "ended";
  cause: EndCause;
  effective: UtcMinute;
  delay_min: number;                        // late cause; for "released", nb(ts) − nb(grace_end) in minutes (m-01)
  fees_due: FeeDue[];
  failed_changes: RequestId[];
  termination?: {
    action_id: string;
    role: "network_operations" | "compliance";
    reason_code: string;
    notice: "told" | "withheld" | "withhold_refused";
    order_ref: string | null;               // set iff notice = "withheld"
  };
}

interface LegChangesDurable extends LifecycleBase {
  kind: "leg_changes_durable";              // E12
  of_change: ChangeId;
}

interface PartnerLegAffected extends LifecycleBase {
  kind: "partner_leg_affected";             // E14
  leg: number;
  partner_link: LinkId;
  from: UtcMinute;
  source: "reconciliation";
}

interface Pol28Residue extends LifecycleBase {
  kind: "pol28_residue";
  request: RequestId | null;                // the booking or change request; null for an offer's partner booking
  offer: OfferId | null;
  partner_link: LinkId;
  fee: MicroUsd;                            // per the partner terms in force at booking
  payer: "share";
  found_by: "decision" | "late_answer" | "reconciliation";  // m-11
}

interface OfferNotice extends LifecycleBase {   // holder notices; rating ignores (Settled MM-7)
  kind: "offer_made" | "offer_accepted" | "offer_declined" | "offer_lapsed" | "offer_failed";
  offer: OfferId;
  route: CatalogueRouteId;
  shown_price: PicoUsdPerMbpsMin;
  offer_window_end: UtcInstant | null;
  confirmed_only_at_acceptance: boolean;    // P1-S59
  cut_kept: { pieces: Pieces; may_book_increase: true } | null;   // reservation total after the cut (P1-S84 row 2; m-13)
}

interface OfferCutKept extends LifecycleBase {
  kind: "offer_cut_kept";                   // KEPT_FOR_OFFER; never holds closure. A target on a Final offer with move_at ≤ t_eff and the link on the new path is a "cut" instead (V52-2)
  offer: OfferId;
  link: LinkId;
  reduction: ReductionId;
  target_revision: number;
  target: Pieces | "none";
}

// Effective-time closure: C01 ResolvedMarker, published by the closure emitter (headers: kind "resolved", resolved).
```

### Reservation command port: operator side

`terminate` is served as gRPC service `AccountOwner.ReservationCommand`. Callers route it
with C01's `route(kind "account", account)`.

```ts
interface OperatorEnvelope {               // RFC-005 §7.4; only what terminate uses is fixed here
  action_id: string;
  action_type: "terminate_reservation_network_abuse" | "terminate_reservation_compliance";
  target: { account: AccountId; reservation: ReservationId };
  target_version: Seq;                      // Seq of the reservation's last E11 that changed its parts, window or legs (m-15)
  role: "network_operations" | "compliance";
  reason_code: "network_abuse" | "fraud" | "sanctions_order" | "legal_order";
  order_ref: string | null;
  note_ref: string | null;
  flags: { withhold_notice?: boolean };
  not_after: UtcInstant;
  requester: SignerBlock;
  approver: SignerBlock | null;
  console_epoch: number; issued_at: UtcInstant;   // informational
}

interface TerminateRequest {
  command: CommandEnvelope;                 // C01: routedTo, sender (the console), identity = bytes of "<account>/<action_id>" (M-05)
  envelope: OperatorEnvelope;
}

type TerminateAnswer =
  | { result: "TERMINATED"; change_id: ChangeId; effective: UtcMinute; ts: HlcTs;
      notice: "told" | "withheld" | "withhold_refused" }
  | { result: "REFUSED"; failed_check: EnvelopeCheck; ts: HlcTs }        // recorded in an audit-only entry (D-5)
  | { result: "NOT_ACTIVE"; ended_effective: UtcMinute; ts: HlcTs }      // recorded likewise
  | { result: "ROUTING"; refusal: RoutingRefusal };                      // C01: STALE_EPOCH | NOT_OWNER | MOVED | MOVING | STOPPED | STALE_SENDER | OVERLOADED | UNAVAILABLE

type EnvelopeCheck =
  | "digest" | "action_type" | "role" | "reason_code"   // RFC-005 §7.4 check 1; "digest" also: same identity, different envelope
  | "assertion"                                          // check 2
  | "operator_check"                                     // check 3
  | "four_eyes"                                          // check 4
  | "not_after"                                          // check 5
  | "unknown_reservation"
  | "target_version";                                    // check 6
```

Release after grace has no wire schema. It is the in-process `release_due:
ReservationId[]` in the outcome of F7 *grace ended* (RFC-004 §A7; C05). Consumers see it
only as `ended` events with cause `released`.

## Semantics

### Request outcome feed

**Reporting entries (M-01).** An outcome event is written in the transaction of the entry
that makes the outcome reportable:

| Entry | When it reports |
|---|---|
| E5 | Confirmed: a booking, or a change that adds a part |
| E1′ | Decided at intake |
| Ending entry: E4, E6, E7, **or the E11 that decides a change** (cancel, shorten, decrease) **or fails one** ("reservation ended", "reservation changed by Share") | Only if the entry already records every release the request needs |
| E8 | It completes the releases of a non-confirmed outcome |
| **E12** | A change whose leg changes free capacity: its E11 decides the change, and E12 reports it (RFC-002 §9.3) |

A request has at most one deciding entry (its `decision` row), so it has at most one
outcome event. Redeliveries are duplicates by identity.

**Precondition for acting.** C01's `reported` gate applies. A consumer treats an
`OutcomeEvent` as reported only when it holds a `ReportMarker` for the same `slot`, with
`epoch` at least the event's epoch header and `reportPosition` ≥ the event's `ts`. The gate
buffers until such a marker arrives, whichever path brought the event or the marker.

**Markers.**

- A marker is carried by the next batch of any partition of the slot, or by a marker-only
  transaction within 20 ms (est.) of the report position passing an unmarked event.
- Markers never go back for a given (slot, epoch).
- After any acquisition, the new holder's first marker is at or above its catch-up read,
  and none is written until `read_lease` + ε after the acquisition (C01; RFC-000 AI-33-2,
  AI-R6-2).
- `prevReportPosition` is the `reportPosition` of the writer's previous marker for the
  slot. After an acquisition or `adopt` it is the predecessor's last `report_through`
  (C01 `owner_slot.report_through`).

**Webhooks and `pending` (B-01, D-1).**

- `answered_pending` on the event is `true` if the owner had sent `pending` for the
  request before it formed the reporting entry.
- The owner sends a final answer only once the report position has passed the reporting
  entry (RFC-002 §8.1), and it writes the covering marker after that. So when it writes
  the first marker covering a request q, it knows whether it sent `pending` for q. Once it
  has decided to send the final answer, it never sends `pending` for q.
- `pending_answered` lists every request whose event the marker newly covers
  (`prevReportPosition` < `ts` ≤ `reportPosition`) and for which `pending` was sent.
- After any acquisition or `adopt`, the first marker of the new holder lists **every**
  covered event above `prevReportPosition`. The new holder cannot know its predecessor's
  answers, so this errs towards an extra webhook.
- **Notifier rule.** Send exactly one signed webhook for a reported outcome of an account
  with a registered endpoint if and only if:
  - the event's `answered_pending` is `true`, **or**
  - the **first covering marker**, the one with `prevReportPosition` < `ts` ≤
    `reportPosition`, lists the request.
  - Exception: never when `withheld_by` is set (M-04).

  When `answered_pending` is `false`, the notifier waits for that first covering marker,
  whichever path brings it. On the direct path that marker precedes every later one in the
  slot's Kafka partition, so this adds no latency over the gate. P2-S06, P2-S08 and
  P2-S09 apply to change requests as to bookings (RQ-2).
- **Alerting and the console** list every event whose `outcome` is `failed`, with its
  `reason` and `leg` (P2-S51).

**Outcomes are final.** A reported outcome never changes (P2-S10).

**Errors.** The feed has no error responses. A consumer that cannot decode an event stops
that partition and raises an alert. It never skips the event.

### Reservation lifecycle feed

Every event is written as an outbox row in the transaction of the entry it reports:

| Entry | Events in its transaction |
|---|---|
| E5 (booking) | `confirmed` |
| E5 (change adding a part) | `part_added` |
| E11 decrease | `rate_decreased` |
| E11 cut (one `cut_target` revision) | `cut`. In the same E11, `ended(revoked)` if every part's current rate is then 0 from some minute to the end |
| E11 shorten (not ending) | `shortened` |
| E11 cancel, or a shorten to or before the next boundary | `ended(cancelled \| cancelled_after_cut)` |
| E11 move (with E13 final) | `moved` |
| E11 price change (with F11) | One `price_step` per listed reservation |
| E11s in the F7 *grace ended* entry | One `ended(released)` per listed reservation |
| E11 termination | `ended(terminated)`. Also `offer_failed` and `pol28_residue` for an offer it fails |
| E11 window end (timer; see "Window end") | `ended(window_end)` |
| E12 | `leg_changes_durable` |
| E13 made, accepted, declined, lapsed, failed | `offer_*`. Also `pol28_residue` (`found_by: "decision"`) for a failed offer whose partner booking was made |
| E13 offer-scoped target | `offer_cut_kept`. If the offer is Final with `move_at ≤ t_eff` and the link is on the new path, the target is an E11 cut and emits `cut` (V52-2) |
| E14 | `partner_leg_affected` |
| E4, E6, E7 that cancel a partner booking at Share's cost | `pol28_residue` (`found_by: "decision"`) |
| The entry recording a partner booking found later for a tombstoned request or a failed offer (a late answer or a query, RFC-002 §10.4; reconciliation, §10.6), cancelled at Share's cost | `pol28_residue` (`found_by: "late_answer" \| "reconciliation"`) (m-11) |

**Part rates are absolute.**

- Every `part_rates` entry is the part's current rate, as minute pieces from its first
  `from`, and supersedes everything earlier stated for the part from that minute on.
- Consumers apply `part_rates` as given. They never re-derive LIFO or the cut
  composition.
- Rating checks the result and alerts on a mismatch (RFC-003 §5.2, P3-S46).

**Effective minutes (M-06, m-14).**

- `ended`, `shortened`, `rate_decreased` and `moved` take effect at or after `nb(ts)`, or
  at a minute fixed in advance and recorded before it.
- `price_step` and `moved` are recorded before their minute (A-3). A cause the owner
  reaches late takes `nb(ts)`, sets `delay_min`, and is alerted.
- `part_added`: `part.window.start` ≥ `floor_min(ts)`. This holds because an addition is
  decided within its deadline, at most `route_deadline_max` = 60 s, of an intake made
  before the part's start.
- **The only events whose effective minute may be before `floor_min(ts)`:**
  1. `cut` (`t_eff`);
  2. `ended(revoked)` written in the same E11 as a `cut`, effective at the first minute
     from which every part is 0 (≥ `t_eff`);
  3. `ended(window_end)`, effective at the window end already carried by earlier events.

  Closure for cases 1 and 2 is held by `hold_2`, and late cases are amended (CR-3).
  Case 3 changes no accrual.

**Cut (M-02; review 52 V52-1 and V52-2, binding; the same rule as C02 and C03).**

- **Higher revisions.** Every revision above the highest recorded for (link, reduction,
  reservation) writes exactly one `cut`, **even when its content is the same**,
  `APPLIED(none)` included. In that case `part_rates` is `[]` and `applied.change_ids` is
  `[]`.
- **Lower or equal revisions.** A revision at or below the highest recorded writes nothing
  and never supersedes:
  - a repeat of a recorded (key, revision) is answered with its recorded reply;
  - a lower revision that was never recorded is answered with the highest recorded
    revision's reply, echoing its own revision.

  Neither writes an entry or a `cut` (C02 answers both).
- **Order.** Among the `cut` events of a key, revisions therefore strictly increase in
  `stream_seq` order, and the later event supersedes.
- **`target`.** It is the per-minute `min` of everything recorded. A piece above the
  recorded one is ignored at that minute and alerted.
- **Not applied.** `part_rates` is `[]` and `applied.status` says why.
  `NOT_APPLIED(unknown)` writes no entry and is only alerted.
- **Offer-scoped targets.** An offer-scoped target emits `offer_cut_kept`, never `cut`,
  except an offer-scoped target whose offer is Final with `move_at ≤ t_eff` and the link
  on the new path: that one is applied as a normal cut and emitted as `cut` (V52-2). Any
  other offer-scoped target is applied, if ever, only in `moved`.

**Move and cuts (P1-S84; m-07).**

- `moved.part_rates` carry the rates that the targets recorded **before the move's entry**
  leave, with `applies` naming those pairs:
  - a move final after the cut applied carries the cut rate;
  - the offer Mbps held beyond that rate are released at `move_at`.
- A target recorded after the move's entry follows the ordinary rules:
  - from the old link with `move_at` ≤ `t_eff`: a `cut` with `not_applied: left_link`;
  - otherwise: a `cut` lowering the moved parts from `max(t_eff, move_at)`.

**Fees (M-03).**

- `confirmed` carries every shown fee, and `moved.legs` carries the new path's fees.
- `fee_id` is `"<reservation>/<path>/<leg index>"`, so it never repeats across paths.
- `ended`, `shortened` and `moved` name the fees falling due and their payer, under
  POL-08 as amended in v1.8 (RFC-002 §9.5). A move's cancelled old partner leg is paid by
  Share (POL-23).
- A fee is due at most once per `fee_id`. Rating charges what the event names and alerts
  on any difference from RFC-003 §5.4.

**Holder notices.** The notifier tells the holder on these events (POL-07, P1-S26,
P1-S50, P1-S72, P2-S91, P4-S23, X1-S17):

- `cut` with `rate_cut`, adding that the holder may cancel without fee;
- `ended` (revoked, released or terminated);
- `partner_leg_affected`;
- `offer_*`.

**Withheld termination (M-04, D-3).**

- When a termination E11 records `notice = "withheld"`, every event that entry causes
  carries `withheld_by` = its `action_id`. That includes `ended`, `offer_failed`,
  `pol28_residue`, and the outcome events of the requests it fails, even when a later
  E8 or E12 writes them.
- The notifier sends no notice and no webhook for any event with `withheld_by` set.
- A buyer's own status read still answers truthfully. A read is not a notice, and P2-S10
  stands.

**Leg changes durable.**

- `leg_changes_durable` (E12) gates buyer-facing reports of capacity freed by a change
  (RFC-002 §9.3, P2-S43, P2-S48).
- Rating ignores it.

**Window end (Settled MM-5, M-07, D-4).**

- The owner arms a timer at the reservation's window end. In the first batch with `ts` ≥
  the window end, it writes an E11 (cause window end) with `effective` = the window end,
  naming any minimum-term fee due.
- **Deferral.** While an addition whose added part starts at the window end (a renewal or
  extension admitted before it, P2-S84) is undecided, that E11 is not written. It waits for
  the addition's outcome:
  - confirmed: nothing ends, and the timer is re-armed at the new end;
  - not confirmed: `ended(window_end)` is written, with `effective` = the old window end.
- Other pending changes fail with "reservation ended" (P2-S80).

### Effective-time closure (resolved markers)

- **Emitter.** C01's closure emitter publishes `ResolvedMarker`s on each destination
  partition of `account.lifecycle.v1`. The account owner never emits closure.
- **Guarantee (m-04).** No row with a **new** (partition, stream, `stream_seq`) and `ts` ≤
  `resolved` follows on that destination partition. Duplicates may still arrive and are
  dropped. Apart from the three exceptions above, every event takes effect at or after
  `floor_min(ts)`. So once `resolved` ≥ the end of minute `m`, no unseen event changes `m`.
- **Cuts.** For each open reduction, closure is held with C03's `hold_1` and `hold_2`.
  `offer_cut_kept` never holds closure.
- **Releasing `hold_2` (MM-3, M-02).** Rating releases a reservation's `hold_2` for a
  reduction when both of these hold:
  - it holds `REDUCTION_FINAL`;
  - it holds a `cut` for (link, reduction, reservation) whose `target_revision` equals
    the highest `CUT_DECIDED` revision for that key seen before `REDUCTION_FINAL`.

  Every revision above the highest recorded produces a `cut` (V52-1), so the hold always releases at the highest
  applied revision.
- **Late extension.** Minutes already closed at the uncut rate are amended down to the
  `cut`'s `part_rates`. The amendment has reason "late POL-07 cut", and carries (link,
  reduction) and the extension chunk from C03's `REDUCTION_EFFECTIVE`. Settlement posts it
  as M6, or M7 in own mode (P4-S117). The same applies to a late `ended(revoked)`.

### Reservation command port: `terminate` (M-05, m-12, m-15)

**Identity.** C01 `CommandEnvelope.identity` = bytes of `"<account>/<action_id>"`.

**Order of evaluation**, inside the batch transaction at `ts`:

1. **Identity lookup, before any check.** If the identity is already recorded, answer the
   recorded answer if the RFC-005 digest is equal, or `REFUSED(digest)` (not recorded
   again) if it differs. Nothing else changes.
2. **RFC-005 §7.4 checks 1 to 5:**
   - the digest is recomputed;
   - the action type, role and reason code are allowed (X1-S16);
   - the assertions verify;
   - identity's `operator_check` (C15) passes;
   - four eyes holds for compliance;
   - `ts` ≤ `not_after` − ε.
3. **Existence and activity.** An unknown reservation gives `REFUSED(unknown_reservation)`.
   An ended one gives `NOT_ACTIVE`. Neither is answered before the checks in step 2 pass,
   so an invalid envelope reveals no state.
4. **Check 6.** `target_version` must equal the `Seq` of the reservation's last E11 that
   changed its parts, window or legs. Price steps, E13 and E14 do not bump it.

**Outcomes.**

- **`TERMINATED`.**
  - One E11 (cause "terminated") ends the reservation from `nb(ts)`. The same entry fails
    every pending and queued change with "reservation ended" (P2-S80), fails an Accepted
    offer, and makes the shown fees due, paid by the buyer.
  - The E11 records the envelope's audit fields, `withhold_notice` and the order
    reference, together with the identity.
- **Notice withheld.**
  - `notice = "withheld"` only when all of these hold: the compliance termination action,
    the compliance role with a compliance approver, reason `legal_order`, `order_ref`
    present, and `flags.withhold_notice` set. Any other envelope with `withhold_notice`
    still terminates, with `notice = "withhold_refused"`, and the holder is told (X1-S36
    row 1).
  - The port has no withhold command. A later request is refused at the console, and the
    notice is sent within `affected_notice_time` (X1-S36 row 3).
- **`REFUSED` and `NOT_ACTIVE`** are recorded in an **audit-only entry** keyed by the
  identity, with no state change (D-5). A retry therefore gets the same answer.
- **Routing refusals** (C01 `RoutingRefusal`):
  - `STALE_EPOCH`, `NOT_OWNER`, `MOVED`: refresh the route and re-send with the same
    identity.
  - `MOVING`, `OVERLOADED`: retry after `retryAfterMs`.
  - `STOPPED`, `UNAVAILABLE`: "temporarily unavailable"; retry later with the same
    identity.
- **Lost or ambiguous replies.** A deadline expiry or a dropped connection means "not
  known to be committed". The console re-sends with the same identity. The owner resolves
  any C01 `Ambiguous` batch before it decides again in the slot, so the retry returns the
  recorded outcome: `TERMINATED`, `REFUSED` or `NOT_ACTIVE`.

### Release after grace (internal)

- **When.** At `grace_end`, if the account is still suspended and not yet released, the F7
  *grace ended* entry commits at a `ts` at or after `grace_end`. Its `release_due` lists
  the reservations to release (RFC-004 §A7, JR-2).
- **Entries.** The booking module writes one E11 per listed reservation in the same entry:
  - cause "released";
  - effective `nb(ts)`;
  - fees due paid by the buyer, any shortfall becoming a negative balance (P4-S97);
  - every pending change failed.
- **Lateness (m-01, D-6).** `delay_min` = (`nb(ts)` − `nb(grace_end)`) in whole minutes.
  It is 0 when F7 commits within the minute containing `grace_end`, and alerted when
  greater than 0. Accrual continues to `effective` (P3-S09).
- **Notice.** `ended(released)` is the only release notice (Settled MM-9). The funds
  module's in-process `Notice.ReleasedAfterGrace` (C05) is not delivered as a second one.

## Delivery and ordering

| | Outcome feed | Lifecycle feed | `terminate` |
|---|---|---|---|
| Delivery | At least once: direct publish, relay, takeover republish (C01) | As for the outcome feed | Synchronous. Retried with the same identity until answered or until `not_after` passes |
| Effect | Exactly-once effect by consumer deduplication | As for the outcome feed | Exactly once per identity. Every answer is recorded |
| Kafka key | Account slot | Account partition | — |
| Order | `stream_seq` per (partition, `outcome`). On the direct path markers interleave in commit order. On the relay path the consumer buffers (C01) | `stream_seq` per (partition, `lifecycle`), contiguous across owner changes and moves. The consumer buffers until gaps fill (C01 `gap_timeout`). No order across accounts | The owner's log order |
| Closure | Report markers per slot | `ResolvedMarker` per destination partition | — |

## Idempotency

| Item | Key | Duplicate | Same key, different content |
|---|---|---|---|
| Feed event | (`partition`, `stream`, `stream_seq`) | Dropped (C01) | C01 §5: security alert, keep the first. **Rating also stops the partition** and pages, because accrual cannot proceed on a doubtful history (m-03) |
| Outcome | `request` | Same outcome (A7) | Impossible (the `decision` row). Integrity alert |
| Webhook | `request` | One webhook per request | — |
| `cut` | (`link`, `reduction`, `reservation`, `target_revision`) | No event. The recorded reply | A revision above the highest recorded writes one `cut`, even with the same content. A revision at or below it, recorded or never recorded, writes nothing and never supersedes (V52-1). The same (key, revision) with different content gives C02 `MISMATCH`, alerted |
| `price_step` | (`account`, `price_version`, `reservation`) | No entry | — |
| Fee | `fee_id` | Charged at most once | — |
| `pol28_residue` | `request`, or (`reservation`, `offer`) | At most one per partner booking | — |
| Notifier notice | (source partition, stream, `stream_seq`, destination) | One notice | — |
| `terminate` | (account partition, `action_id`) = `CommandEnvelope.identity` | The recorded answer | `REFUSED(digest)`, and the recorded answer stands (RFC-005 check 3 alone would not catch this, because its assertions are consumed under the same `action_id`) |

## Ownership

| Data | Who writes | Who may read |
|---|---|---|
| `account.outcome.v1` events and markers | Only the account owner's outbox (RFC-000 A1). The relay and republish copy rows but never author them | Notifier, alerting, operator console (read grant, RFC-005 §7.6) |
| `account.lifecycle.v1` events | Only the account owner's outbox | Rating, the catalogue read model (AI3-7), history, notifier, reporting. Supplier-facing reporting applies RFC-005's supplier-visibility query |
| `ResolvedMarker` | Only the closure emitter (C01) | Every lifecycle consumer |
| Termination E11 and refusal audit entries | Only the account owner | History, audit |
| Probe designation | Catalogue (RFC-003 §6.1), the source of truth. `account_is_probe` is a cross-check that rating alerts on when it differs | Rating, the account owner (F9) |

## Timeouts and deadlines

| Item | Value |
|---|---|
| Marker-only transaction | Within 20 ms (est.) of the report position passing an unmarked event, or an unlisted `pending` answer |
| Outcome webhook first attempt | About 1 s after the report (est., RFC-006 §15). Retried for `webhook_retry` (24 h) |
| Holder notices | Within `affected_notice_time` (60 s, POL-07) of the entry's `ts` |
| Lifecycle closure lag | About 2 to 3 s (est.). Longer only while a reduction is open |
| Late-E11 alarm | Any `delay_min` > 0, `ended(released)` included (m-01). Never for `ended(window_end)` |
| `terminate` per-call deadline | 2 s (est., to be confirmed at C5). The console retries with the same identity until `not_after` − ε; after that the owner answers `REFUSED(not_after)` |
| Consumer feed lag alarm | A consumer more than 60 s behind a stream's head (RFC-006 §16) |
| Retention | Outbox 25 h. Archive and replay for 7 years. Schemas decodable for 7 years |

## Versioning and compatibility

- `schema_v` travels in the headers, and the registry keeps every version decodable for
  7 years.
- **Compatible change** (same topic): add an optional field, an `OutcomeReason.code`, or
  an `EnvelopeCheck`. Callers treat an unknown check as a refusal.
- **Lifecycle kinds (m-06).** A new lifecycle `kind` goes to a new topic `.v2` unless its
  events carry the header `rating_ignorable: "true"`. Rating trusts that header and
  skips such events. Without the header, rating **stops the partition and pages** on an
  unknown `kind` or `EndCause`.
- **Incompatible change** (new topic `.v2`, both published until every consumer has moved):
  a new `EndCause`, or any change to units or to the meaning of `part_rates` or `fee_id`.
- The notifier, reporting and history may store an unknown `kind` and ignore it. Every
  consumer ignores unknown optional fields.
- The `ReportMarker` extension (`prevReportPosition`, `pending_answered`) is part of
  `account.outcome.v1` from this version on.

## Scenarios relied on

**Outcome feed**

P2-S06, P2-S07, P2-S08, P2-S09, P2-S10, P2-S13, P2-S18, P2-S23, P2-S51, P2-S73, P2-S111.

**Lifecycle feed**

| Topic | Scenarios |
|---|---|
| Ends, shortens, decreases | P2-S43, P2-S44, P2-S48, P2-S80, P2-S81, P2-S82, P2-S84 |
| Keys | P2-S117 |
| Partner leg | P2-S91 |
| Holder notices | P1-S26, P1-S50, P1-S72, P1-S75 |
| Offers and moves | P1-S31, P1-S35, P1-S52, P1-S53, P1-S57, P1-S59, P1-S61, P1-S71, P1-S84 |
| Accrual and price | P3-S02, P3-S03, P3-S04, P3-S05, P3-S07, P3-S08, P3-S09, P3-S40, P3-S42, P3-S45, P3-S46, P3-S58, P3-S59, P3-S64 |
| Fees | P3-S11, P3-S43, P3-S44, P3-S60, P3-S63, P3-S74 |
| Late cut | P4-S117 |
| Probes | X2-S20 |

**Command port**

X1-S12, X1-S16, X1-S17, X1-S36, P4-S23, P4-S97.

## Conformance tests

**Provider (RFC-002), run against the account owner with a recorded Kafka sink.**

| # | Test | Scenarios |
|---|---|---|
| PO-1 | Every reported outcome has exactly one outcome event. It is written in the transaction of E5, E1′, the ending entry (E4, E6, E7, or the E11 deciding or failing a change) if it records every release, the completing E8, or the E12 of a change that frees capacity, and nowhere else. An expired request's event `ts` is at or after `D`. A cancel, a decrease and a shorten each produce one event, as does every change failed by an ending E11 | P2-S10, P2-S13, P2-S43, P2-S48, P2-S80 |
| PO-2 | Identical event identity on the direct path, the relay path and the takeover republish, across an owner change and a move | P2-S111 |
| PO-3 | Markers never go back. A new holder's first marker is at or above its catch-up read and comes no sooner than `read_lease` + ε. `prevReportPosition` chains markers, and after an acquisition or `adopt` it equals the predecessor's last `report_through` | P2-S111 |
| PO-4 | Rejections carry `blocking_link`, `counter_offer`, and `retry_after` when `wait = false`. Expiry reasons follow RFC-002 §6.2 | P2-S18, P2-S23, P2-S73 |
| PO-5 | Trace 1 of review 43: E5 commits before `pending` is sent, `pending` is sent at the sync deadline, then the report. The event has `answered_pending = false` and the first covering marker lists the request. Trace 2: the owner crashes after sending `pending`, and the new holder's first marker lists every covered event above `prevReportPosition`. A request answered with a final result is never listed and never has the flag | P2-S06, P2-S08, P2-S09 |
| PL-1 | Each entry in the entry-to-event table emits exactly the events listed, in its transaction, with contiguous `stream_seq` | — |
| PL-2 | `part_rates` composition per RFC-002 §9.7 (single target exact, `min` per minute, LIFO decrease, a later part not capped) | P3-S46, P3-S58 |
| PL-3 | Revisions 1, 2 (same content as 1) and 3 of a key give three `cut` events, the second with `part_rates: []` (every higher revision writes a `cut` even with the same content). A redelivered revision 2 gives none. A revision 1 never recorded, arriving after revision 3, gives none and is answered with revision 3's reply echoing revision 1. The same revision with different content gives none (`MISMATCH`, alerted). A lower or equal revision never supersedes. An offer-scoped target gives `offer_cut_kept` only, except on a Final offer with `move_at ≤ t_eff` and the link on the new path, which gives `cut` (V52-2). An unknown reservation gives none | P1-S52, P1-S84, P4-S117 |
| PL-4 | Both orders. A move final before `t_eff` moves the full rate, and a later target gives `cut` `left_link`. A move final after a recorded target carries the cut rate and `applies`. A move final after `t_eff` but before the target arrives carries the full rate, and the later `cut` lowers the moved parts | P1-S84 |
| PL-5 | Fees: shown fees on `confirmed` and `moved.legs`. Due and payer at each end, shorten and move per RFC-002 §9.5. A move with a cancelled old partner leg gives `fees_due` paid by Share. A fee due on the new path after the move has a distinct `fee_id`. At most once per `fee_id` | P3-S43, P3-S44, P3-S63, P3-S74 |
| PL-6 | Only `cut`, `ended(revoked)` in a cut's E11, and `ended(window_end)` have an effective minute below `floor_min(ts)`. `part_added` has `part.window.start` ≥ `floor_min(ts)`. A late cause sets `delay_min` and raises the alarm | P3-S08, P3-S45 |
| PL-7 | `account_is_probe` matches the catalogue designation | X2-S20 |
| PL-8 | Window end: a renewal admitted at 17:59:30 for a reservation ending 18:00, confirmed at 18:00:20, gives `part_added` and no `ended`. The same renewal failing gives `ended(window_end)` effective 18:00, written after the outcome | P2-S84 |
| PL-9 | A late-found partner booking for a tombstoned request gives one `pol28_residue` (`found_by` `late_answer` or `reconciliation`) | P2-S91 |
| PC-1 | Network-abuse termination with withhold gives `TERMINATED`, `withhold_refused`. Compliance legal order with withhold and approval gives `withheld` and records `order_ref`. There is no later withhold on the port | X1-S36 |
| PC-2 | Each check of steps 2 to 4 fails in turn and gives `REFUSED` with that check, recorded in an audit-only entry with no state change. An invalid envelope on an ended reservation gives the envelope check's refusal, not `NOT_ACTIVE`. A reason outside POL-30 is refused | X1-S16 |
| PC-3 | A retry with the same identity after `TERMINATED`, `REFUSED` or `NOT_ACTIVE` returns the recorded answer and no second E11. The same identity with a different envelope gives `REFUSED(digest)`. A lost reply and an `Ambiguous` batch (resolved both ways) end in the recorded outcome | — |
| PC-4 | F7 *grace ended* writes `ended(released)` for every listed reservation in the same entry, effective `nb(ts)`, with the buyer paying shown fees. `delay_min` is 0 within the `grace_end` minute and positive (and alerted) after an owner outage | P3-S09, P4-S23, P4-S97 |
| PC-5 | A withheld termination of a reservation with an Accepted offer and a queued extension: every event from that E11, and the extension's outcome event, carry `withheld_by` | X1-S36 |
| PC-6 | `target_version` is unchanged by a price step, E13 and E14, and bumped by a cut, a decrease, a shorten, an addition and a move | — |

**Consumers.**

| # | Side | Test | Scenarios |
|---|---|---|---|
| CN-1 | Notifier | No delivery without a covering marker. Exactly one webhook when `answered_pending` or the first covering marker's `pending_answered` says so, whichever path delivers first. None otherwise. A later marker arriving before the first covering marker does not trigger a decision when `answered_pending` is `false` | P2-S06, P2-S09 |
| CN-2 | Notifier | Nothing (no notice, no webhook) for any event with `withheld_by`. `withhold_refused` and `told` give one notice within 60 s | X1-S36, X1-S17 |
| CN-3 | Notifier | `cut` with `rate_cut`, `ended(revoked \| released)`, `partner_leg_affected` and `offer_*` give one notice each. Duplicates give none. There is no second release notice from the funds or standing feeds | P1-S26, P1-S75, P2-S91, P4-S23 |
| CR-1 | Rating | Accrual uses `part_rates`. A booking starts at `max(window.start, floor_min(decided_ts))`, an added part at `part.window.start`, and accrual ends at `ended.effective` | P3-S02, P3-S04, P3-S42, P3-S45 |
| CR-2 | Rating | Nothing closes past `resolved`. `hold_2` releases only with `REDUCTION_FINAL` and a `cut` at the highest `CUT_DECIDED` revision seen before it, including when that revision's `cut` has `part_rates: []`. A lower revision keeps the hold. `offer_cut_kept` never holds | P3-S58 |
| CR-3 | Rating | A `cut`, or an `ended(revoked)`, covering already-closed minutes gives downward "late POL-07 cut" amendments and leaves the originals unchanged | P3-S08, P4-S117 |
| CR-4 | Rating | Fee lines as named, alerted against RFC-003 §5.4. `moved.fees_due` gives Share-borne fee lines. Each `fee_id` is charged once, and a new path's fee is not dropped | P3-S60, P3-S63, P3-S74 |
| CR-5 | Rating | `moved`: route relabelled from `move_at`, price `min(price, shown_price)`. `price_step`: re-price from `effective` | P3-S59, P3-S64 |
| CR-6 | Rating | Probe accounts per the catalogue give no lines. A differing `account_is_probe` is alerted. An unknown `kind` without `rating_ignorable` stops the partition, as does a feed-event identity with different content | X2-S20 |
| CH-1 | History | "As known at T" = events with `ts` ≤ T, rebuilt from the archive | — |
| CC-1 | Console | Handles every `TerminateAnswer` and `RoutingRefusal`. Retries with the same identity on routing refusals, a deadline expiry and a dropped connection. Records only the recorded answer | X1-S16 |

## Settled

Each item below was a point where the RFCs disagreed, or where an RFC was silent on
something a consumer relies on. Every one is decided by the orchestrator (binding).
Review 43's amendments are folded into the rows.

| # | Point | Provider side (RFC-002 rev. 5) | Consumer side | Settled as |
|---|---|---|---|---|
| MM-1 | Probe-account flag | Not listed. F9 designation | RFC-003 §7 consumes it | `account_is_probe` on every lifecycle event. The catalogue designation is the source of truth, and the flag is a cross-check alerted on mismatch (m-05) |
| MM-2 | Fee identifier | None (due once per reservation and leg) | RFC-003 §5.4 charges a fee ID once | `fee_id = "<reservation>/<path>/<leg index>"`, with `path` `0` for the booked path and the offer ID after a move (amended by review 43 D-2) |
| MM-3 | Target revision on `cut` (C4-2) | No revision | RFC-001 and C02 carry one. RFC-003 holds closure until the cut is final | `cut` carries the applied `target_revision`. **Every revision above the highest recorded writes one `cut`, even with the same content. A revision at or below it writes nothing and never supersedes. An offer-scoped target on a Final offer with `move_at ≤ t_eff` and the link on the new path writes a `cut`** (amended by review 43 M-02 and review 52 V52-1/V52-2; the same rule as C02 and C03). `hold_2` releases at the highest applied revision, equal to the highest `CUT_DECIDED` revision seen before `REDUCTION_FINAL` (C03 M2) |
| MM-4 | Effective minute of release after grace | Written in F7 at `ts` ≥ `grace_end`; effective ≥ `nb(ts)` | RFC-003 §5.2 expects it recorded in advance | Effective `nb(ts)` of the F7 entry. `delay_min` = `nb(ts)` − `nb(grace_end)`, alerted when > 0. The normal case is 0 and unalerted (amended by review 43 D-6) |
| MM-5 | Window-end end event | No entry writes it | RFC-003 §5.4 needs it | A timer-driven E11, effective at the window end. **It is deferred while an addition starting at the window end is undecided** (amended by review 43 D-4) |
| MM-6 | E12 and "published as effective" | Row with the E11 | Rating never waits | Change event at E11, plus `leg_changes_durable` at E12 for buyer-facing consumers. E12 is also a reporting entry for the change's outcome (review 43 M-01) |
| MM-7 | Offer notices | No offer events | RFC-006 §15 expects them | `offer_*` and `offer_cut_kept`. Rating ignores both. `cut_kept` is carried as pieces (m-13) |
| MM-8 | Honouring `withhold_notice` | "Which the notifier honours" | RFC-006 §15 silent | **Every** notice and webhook caused by a withheld termination's entry is suppressed, marked `withheld_by`. Status reads stay truthful (amended by review 43 D-3) |
| MM-9 | Release notice source | Lifecycle feed | RFC-006 §15: standing and funds feeds | `ended(released)` only. C05's `ReleasedAfterGrace` notice is not delivered |
| MM-10 | Which outcomes get a webhook | `pending` not logged | RFC-006 §15: only outcomes answered `pending` | `answered_pending` on the event **or** `pending_answered` on the first covering marker. After a holder change, the first marker lists every covered event above the predecessor's last `report_through`. RFC-006 sizing is unchanged (amended by review 43 B-01, D-1) |
| MM-11 | Marker fields | (slot, epoch, report position) | RFC-006 adds generation | C01's `ReportMarker` (`generation: 0`, `reportPosition`, header `report_through`), extended by `prevReportPosition` and `pending_answered` |
| MM-12 | `ended(revoked)` from a cut | No end event named | RFC-003 §5.2 ends accrual at revocation (P3-S08) | Written in the cut's E11. **Listed as an allowed early-effective exception**, held by `hold_2` and amended late like a cut (amended by review 43 M-06) |
| — | `terminate` per-call deadline | Not stated | Not stated | 2 s (est.), to be confirmed at C5 |
| D-5 | Refusals of operator commands | Not recorded | Console and audit need stable replays | Recorded as an audit-only entry keyed by (partition, `action_id`) |

## Consumer obligations (errata required by settled points)

This contract does not edit any RFC or neighbouring contract. To match it, each of them
needs the errata below.

| RFC or contract | Erratum | Source |
|---|---|---|
| RFC-002 | §8 (gate sentence) and §8.3: the reporting entries include the E11 that decides or fails a change, and E12 for a change that frees capacity. Every change request gets an outcome event | M-01 |
| RFC-002 | §8.1 and §8.3: the outcome event carries `answered_pending` (`pending` sent before the entry was formed). The owner decides a final answer or `pending` atomically per request. The first marker covering a request lists it in `pending_answered` if `pending` was sent. After an acquisition or `adopt`, the first marker lists every covered event above the predecessor's `report_through`. Markers carry `prevReportPosition` | B-01, MM-10 |
| RFC-002 | §9.7, §13.1: one lifecycle `cut` per `cut_target` revision above the highest recorded, even with the same content, carrying `target_revision`. Nothing for a revision at or below it: a recorded repeat gets its recorded reply; a never-recorded lower revision gets the highest recorded revision's reply, echoing its own revision; neither supersedes (V52-1). An offer-scoped target on a Final offer with `move_at ≤ t_eff` and the link on the new path is applied as a normal cut and emitted as `cut` (V52-2). `ended(revoked)` in the same E11 when every part is 0 to the end | MM-3, M-02, MM-12 |
| RFC-002 | §9.5, §9.6: `fee_id = "<reservation>/<path>/<leg index>"`. The move's E11 records the old partner leg's fees due at `move_at`, paid by Share, and `moved` carries them | MM-2, M-03 |
| RFC-002 | §13.1: `account_is_probe` on lifecycle events, as a cross-check of the catalogue designation | MM-1 |
| RFC-002 | §9.1, §9.5: the timer-driven window-end E11, effective at the window end, deferred while an addition starting at the window end is undecided | MM-5, M-07 |
| RFC-002 | §13.1: the change event with the E11, and `leg_changes_durable` with the E12 | MM-6 |
| RFC-002 | §9.6, §13.1, §2.5: `offer_*` and `offer_cut_kept` lifecycle events. Drop the separate "notices" outbox feed | MM-7 |
| RFC-002 | §9.4: a withheld termination marks every event its entry causes, including later outcome events of the requests it fails, with `withheld_by` | M-04, MM-8 |
| RFC-002 | §9.4, §13.1: `terminate` is idempotent by (account partition, `action_id`). The identity is looked up before the checks. Refusals and `NOT_ACTIVE` are recorded in an audit-only entry. Check order: 1 to 5, then existence and activity, then 6. `target_version` = `Seq` of the last E11 changing parts, window or legs | M-05, m-12, m-15, D-5 |
| RFC-002 | §10.4, §10.6: a partner booking found later and cancelled at Share's cost is recorded by the account owner in an entry that emits `pol28_residue` | m-11 |
| RFC-002 | §9.4 (release after grace): `delay_min` = `nb(ts)` − `nb(grace_end)`, alerted when > 0 | MM-4, m-01 |
| RFC-003 | §5.6 `hold_2`: released when `REDUCTION_FINAL` is held and the applied `cut` revision equals the highest `CUT_DECIDED` revision before it. A `cut` with `part_rates: []` counts. A lower revision keeps the hold. §7: the revision is on the consumed `cut` | MM-3, M-02 |
| RFC-003 | §5.2, §7: the allowed early-effective events are `cut`, `ended(revoked)` in a cut's E11 (held by `hold_2`, amended late with "late POL-07 cut"), and `ended(window_end)`. A release ends accrual at `nb(ts)` of its F7 entry and is late only when `delay_min` > 0. An added part accrues from `part.window.start` | M-06, MM-4, MM-5, m-14 |
| RFC-003 | §5.4, §7: `fee_id = "<reservation>/<path>/<leg index>"`. `moved.fees_due` gives Share-borne fee lines. §7: the catalogue is the probe source of truth, and `account_is_probe` is alerted on mismatch. Ignore `offer_*`, `offer_cut_kept` and `leg_changes_durable`. Skip kinds with `rating_ignorable`. Stop the partition on a feed-event identity with different content | MM-1, MM-2, M-03, MM-7, m-03, m-05, m-06 |
| RFC-004 | §A7, JR-2: release E11s effective `nb(ts)` of the F7 entry. Lateness is alerted per `delay_min`. Part A's release notice is not delivered (the lifecycle `ended(released)` is the notice). A fee due carries its payer, so the funds module never drains a buyer's hold for a Share-paid fee (revoked, cancelled after a cut, a move's old partner leg) | MM-4, MM-9, m-09 |
| RFC-004 | Traceability: cite P4-S117 (the late POL-07 cut, §B3.4) | m-10 |
| RFC-001 | Traceability: cite P1-S84 (a move final after the cut carries the cut rate) | m-10 |
| RFC-006 | §5.3, §5.4: the report marker is C01's `ReportMarker` (header `report_through`), extended with `prevReportPosition` and `pending_answered`. `generation` is a header only, not part of the gate | MM-11, B-01, m-02 |
| RFC-006 | §15: holder notices from the lifecycle `cut` (with `rate_cut`), `ended`, `partner_leg_affected` and `offer_*`. No notice or webhook for any event with `withheld_by`. The release notice only from `ended(released)`. Outcome webhooks iff `answered_pending` or the first covering marker's `pending_answered`, applying to every booking request, changes included. Buyer-facing freed-capacity reports wait for `leg_changes_durable`. Sizing unchanged | MM-6 … MM-10, B-01, M-04 |
| C01 | §2.5: extend `ReportMarker` with `prevReportPosition` and `pending_answered` (account kind), or let C04 extend it. §5: confirm "security alert, keep the first", with consumer contracts allowed to stop | B-01, m-03 |
| C05 | `EndCause` aligned with C04 (`cancelled_after_cut`; no `moved` or `shortened_to_end` as end causes). `feeDue` carries the payer. `Notice.ReleasedAfterGrace` is not delivered by the notifier | m-09 |
| RFC-005 | None. Note: check 3 does not catch a different envelope under a used `action_id`. The identity lookup does (M-05) | M-05 |
| Requirements | RQ-1 (*Told* under a withheld termination) and RQ-2 (P2-S09 covers change requests), as review 43 proposes | M-04, M-01 |
| RFC-000 §8 | AI-43-1 (markers list newly covered requests answered `pending`). AI-43-2 (three early-effective exceptions). AI-43-3 (`terminate` idempotent by (account partition, `action_id`), refusals recorded) | B-01, M-06, M-05 |

Out of scope, settled elsewhere:

- C4-1 (cut-target answer form), C4-3 (`STALE_CHANGE`) and C4-4 (`end_leg` naming every
  applied pair) are C02's.
- C4-7 (`Stopped` and `Moving`) is C01's.

## Review 43 resolution

Every fix review 43 proposes is accepted with its decisions D-1 … D-6 (binding).

| Finding | Severity | Resolution in version 2 |
|---|---|---|
| B-01 | Blocker | `ReportMarker.pending_answered` and `prevReportPosition`. Webhook iff `answered_pending` or the first covering marker lists the request. After a holder change the first marker lists every covered event. PO-5, CN-1. RFC-002, RFC-006 and C01 errata (D-1) |
| M-01 | Major | Reporting entries include the E11 deciding or failing a change, and E12. PO-1 amended. RFC-002 §8/§8.3 erratum |
| M-02 | Major | Superseded by review 52 V52-1 and V52-2 (binding): every revision above the highest recorded writes a `cut`, even with the same content. A lower or equal revision writes nothing and never supersedes. An offer-scoped target on a Final offer (`move_at ≤ t_eff`, link on the new path) writes a `cut`. Revisions strictly increase in `stream_seq`. `change_ids: ChangeId[]`. PL-3, CR-2 and the Idempotency row amended. MM-3 amended |
| M-03 | Major | `Moved.fees_due` (old path, payer Share). `fee_id` includes the path. PL-5, CR-4. RFC-002 and RFC-003 errata (D-2). MM-2 amended |
| M-04 | Major | `withheld_by` on every event the withheld termination's entry causes. The notifier suppresses all of them. PC-5, CN-2 (D-3). MM-8 amended. RQ-1 |
| M-05 | Major | C01 `CommandEnvelope` identity (account partition, `action_id`), looked up before the checks. Refusals and `NOT_ACTIVE` recorded (D-5). `RoutingRefusal` in full. Lost or `Ambiguous` replies retried with the same identity. The check-3 claim is corrected. PC-2, PC-3, CC-1 |
| M-06 | Major | The three early-effective exceptions are listed in Effective minutes, the closure guarantee, PL-6 and the RFC-003 erratum. MM-12 amended |
| M-07 | Major | The window-end E11 is deferred while an addition starting at the window end is undecided (D-4). PL-8. MM-5 amended |
| m-01 | Minor | `delay_min` = `nb(ts)` − `nb(grace_end)`, alerted when > 0 (D-6). This formula makes the normal case 0, which the review's `ceil_min(grace_end)` would not when `grace_end` is on a boundary. PC-4. MM-4 amended |
| m-02 | Minor | C01 types and names used verbatim (`HlcTs`, `Epoch`, `StreamSeq`, `PartitionKey` as headers, `ReportMarker` with `generation: 0` and `reportPosition`, `report_through`) |
| m-03 | Minor | C01's rule (security alert, keep the first), plus rating stops the partition. C01 erratum |
| m-04 | Minor | The guarantee is reworded to "no row with a new identity". Duplicates may follow |
| m-05 | Minor | The catalogue designation is the source of truth. `account_is_probe` is a cross-check, alerted |
| m-06 | Minor | A new kind goes to `.v2` unless it carries `rating_ignorable: "true"` |
| m-07 | Minor | `moved` carries the cuts recorded before its entry. Later targets give `cut`. PL-4 tests both orders |
| m-08 | Minor | `change_ids: ChangeId[]`, `[]` = none, the E11's own id |
| m-09 | Minor | RFC-004 and C05 obligations: no second release notice, `EndCause` aligned, payer with `feeDue` |
| m-10 | Minor | P2-S06, P2-S84 and P1-S31 cited (P3-S08 and P3-S09 already were). RFC-001 and RFC-004 traceability errata |
| m-11 | Minor | A late-found partner booking writes `pol28_residue` with `found_by`. PL-9. RFC-002 erratum |
| m-12 | Minor | Check order: identity, then 1 to 5, then existence and activity, then 6 |
| m-13 | Minor | `cut_kept.pieces` |
| m-14 | Minor | `part.window.start` ≥ `floor_min(ts)` by `route_deadline_max`. PL-6, CR-1 |
| m-15 | Minor | `target_version` = `Seq` of the last E11 changing parts, window or legs. PC-6 |
| RQ-1, RQ-2 | Requirements | Listed under obligations for the requirements owner. The contract applies the proposed readings |
| AI-43-1 … AI-43-3 | Architecture | Listed under obligations for RFC-000 §8 |
