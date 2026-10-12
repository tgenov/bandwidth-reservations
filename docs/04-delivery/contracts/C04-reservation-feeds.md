# C04. Reservation feeds: request outcome feed, reservation lifecycle feed, and the operator side of the reservation command port

| | |
|---|---|
| Contract ID | C04 |
| Version | 1 (draft) |
| Status | **Draft**, for contract review. Every mismatch is settled by the orchestrator (see [Settled](#settled)). Frozen after contract review ACCEPT (tag `contract-C04-v1`) |
| Provider | RFC-002 (the account owner: booking module, with RFC-004 Part A's funds module in the same log) |
| Consumers | RFC-006 (the notifier, alerting and history), RFC-003 (rating, and the catalogue's locked-price read model), RFC-004 (Part A owns the release-after-grace rule; Part B settlement reads this feed only through RFC-003's charge lines), RFC-005 (envelope verification on the command port), the operator console, reporting |
| Transport | **Kafka event** for both feeds, published from the transactional outbox (direct publish plus changefeed relay, RFC-006 §5.3). **Synchronous gRPC command** for `terminate`, routed by account slot. **In-process** for release after grace: the funds module's F7 outcome feeds the booking module's E11 in the same entry, and nothing goes on the wire |
| Pinned to | `requirements-v1.10`. RFC-000 rev. 4.4 (§8 rows: "Request outcome feed", "Reservation lifecycle feed", "Reservation command port"; "Revision 4.4 errata" C4-1 … C4-7). RFC-002 rev. 5 (§2.2, §2.5, §8.3, §9, §13.1). RFC-003 rev. 5 with erratum 5.1 (§5.1, §5.2, §5.4, §5.6, §5.7, §7). RFC-004 rev. 5 with erratum 5.1 (§A4 E11/F7 rows, §A7, JR-2, §B3.4). RFC-005 rev. 5 (§7.2, §7.3, §7.4). RFC-006 rev. 6 (§5.3, §5.4, §5.5, §12.5, §15, §16) |
| Depends on | **C01** (platform substrate contract, RFC-006): feed headers, per-stream sequences, (generation, epoch) fencing, the closure emitter's resolved markers, the `reported` gate, runtime results (`Committed`, `StaleEpoch`, `Moved`, `Moving`, `Stopped`, `Overloaded`), and the commit-timestamp type. This contract does not restate those rules. It names the C01 rule each one relies on |

## Purpose

The account owner decides requests and changes reservations. Three things come out of
those decisions, and other components rely on all three:

1. **Request outcome feed.** One event for each reported outcome of a booking or change
   request, plus per-slot report-position markers. The notifier sends a buyer webhook only
   for an outcome at or below a marker. Alerting and the operator console list failed
   requests.
2. **Reservation lifecycle feed.** The part-level history of every reservation: parts,
   locked prices, legs, effective minutes, ends with their causes, shortens, the fees shown
   and when they fall due, moves, price steps, POL-07 cuts, partner-leg affected status,
   POL-28 residue and offer notices. The feed carries an effective-time closure. Rating
   accrues from it, history answers "as known at T" from it, and the notifier tells
   holders from it.
3. **Reservation command port, operator side.** `terminate`, with `withhold_notice` only
   inside a compliance legal-order termination, and the internal release after grace.
   Cut targets and equivalent-path offers use the same port, but they belong to the
   link-facing contract and are out of scope here. Their results show up on the lifecycle
   feed only as the `cut`, `moved` and `offer_*` events defined below.

## Schema

TypeScript is used for every message. The value written to Kafka is the owner's ciphertext
(RFC-005 column encryption, key purpose "feed"). These types describe the plaintext. No
field carries personal data (RFC-000 A11). Principals are pseudonymous.

### Units and shared types

| Quantity | Type | Unit |
|---|---|---|
| Commit timestamp `ts` | `HlcTs` (from C01) | The database's hybrid-logical commit timestamp, serialised as a decimal string `"<wall-ns>.<logical>"`, totally ordered. "At or below" always means HLC order |
| Effective minute | `UtcMinute` | An ISO 8601 UTC string on a minute boundary, `"2026-10-12T09:31:00Z"`. A minute `m` covers `[m, m + 1 min)` |
| Window | `{ start: UtcMinute; end: UtcMinute \| null }` | Half-open `[start, end)`. `null` means open-ended |
| Rate | `Mbps = number` (integer ≥ 0) | Mbps |
| Money | `MicroUsd = string` | A decimal integer string of micro-USD (10⁻⁶ USD), for example `"500000"` |
| Unit price | `PicoUsdPerMbpsMin = string` | A decimal integer string of pico-USD (10⁻¹² USD) per Mbps-minute (RFC-003 §2) |
| Durations | `number` | Milliseconds unless the field name says `_s` or `_min` |

```ts
// Identifiers. All are opaque strings unless stated otherwise.
type AccountId = string;        // also the account log partition key
type SlotId = number;           // account slot (placement's map, RFC-006 §7.1)
type RequestId = string;        // "(account partition, sequence)" of the E1, rendered "<account>:<seq>"
type ReservationId = string;
type PartId = string;           // unique within its reservation
type LinkId = string;
type ReductionId = string;      // RFC-001's reduction identifier, unique per link
type OfferId = string;
type CatalogueRouteId = string;
type ProductId = string;
type PriceVersion = string;     // catalogue price version
type ChangeId = string;         // the E11's "(account partition, sequence)", rendered "<account>:<seq>"
type PrincipalRef = string;     // pseudonymous principal (RFC-005)
type KeyRef = string;           // pseudonymous API key reference
type FeeId = string;            // "<reservation>/<leg index>" (Settled MM-2)

// Every partition's events carry C01's event header.
// These fields travel as Kafka headers (RFC-006 §5.4) and are repeated here in plaintext.
interface EventHeader {
  partition: AccountId;         // producing account partition
  stream: "outcome" | "lifecycle";
  stream_seq: number;           // contiguous per (partition, stream), continued across owner changes and moves (C01)
  generation: number;           // writer's partition generation (C01)
  epoch: number;                // writer's slot epoch (C01)
  slot: SlotId;                 // writer's slot at the commit
  ts: HlcTs;                    // commit timestamp of the entry that wrote the row
  entry_seq: number;            // the log entry's sequence in the partition
  kind: string;                 // event kind, below
  schema_v: number;             // payload schema version (see Versioning)
}

interface MinutePiece { from: UtcMinute; rate: Mbps }          // holds from `from` until the next piece's `from`, the last until the part's end
type Pieces = MinutePiece[];                                     // strictly increasing `from`; adjacent equal rates merged
interface PartRates { part: PartId; pieces: Pieces }            // absolute; supersedes, from pieces[0].from on, every earlier statement for the part
interface LinkReduction { link: LinkId; reduction: ReductionId }
```

### Request outcome feed

Topic `account.outcome.v1`, **keyed by account slot** (RFC-000 B-AI-8). Every partition of
a slot, and every marker of that slot, goes to one Kafka partition.

```ts
type Outcome = "confirmed" | "rejected" | "invalid" | "failed";

type OutcomeReason =
  | { code: "confirmed" }
  | { code: "invalid"; rule: string }                                         // E1′, the rule broken
  | { code: "insufficient_funds"; needed: MicroUsd; available: MicroUsd }    // E1′, the two amounts (POL-10)
  | { code: "limit"; limit: string }                                          // E1′, the limit by name
  | { code: "account_suspended"; resume_amount: MicroUsd; items: { label: string; amount: MicroUsd }[] } // POL-16, itemised
  | { code: "change_to_part_of_route" | "more_than_one_partner_without_holds" }
  | { code: "decrease_forbidden_by_partner_terms"; may_cancel_instead: true }  // P2-S115
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

type UtcInstant = string; // ISO 8601 with milliseconds, UTC

interface CounterOffer {
  largest_rate: Mbps;                       // fits the requested window on every Share leg
  earliest_window: { start: UtcMinute; end: UtcMinute | null } | null; // requested length at the requested rate, or null if none fits inside the horizon
  share_legs_only: boolean;                 // true when the route has a partner leg (its availability is not computable)
}

interface OutcomeEvent extends EventHeader {
  stream: "outcome";
  kind: "outcome";
  request: RequestId;
  account: AccountId;
  idempotency_key_digest: string;           // the key as the buyer sent it, digested (no raw key in feeds)
  principal: PrincipalRef;
  request_kind: "book" | "change";
  reservation: ReservationId | null;        // set for confirmed bookings and for every change
  outcome: Outcome;
  reason: OutcomeReason;
  decided_ts: HlcTs;                        // ts of the deciding entry
  stated_time: UtcInstant;                  // D for an expiry, decided_ts otherwise (RFC-002 §8.3)
  leg: number | null;                       // the leg concerned, when the reason names one (P2-S51)
  answered_pending: boolean;                // a `pending` answer was sent for this request; recorded in the reporting entry (Settled MM-10)
}

interface ReportMarker {
  stream: "outcome";
  kind: "report_marker";
  slot: SlotId;
  epoch: number;                            // the slot epoch of the writer
  generation: number;                       // header field required by the topic convention, not used by the gate (MM-11)
  report_position: HlcTs;                   // every entry of the slot at or below this ts is committed and on every leased status reader
  ts: HlcTs;                                // commit of the batch or marker-only transaction carrying it
}
```

### Reservation lifecycle feed

Topic `account.lifecycle.v1`, **keyed by account partition** (RFC-006 §5.4). Each
destination Kafka partition also carries C01's resolved markers (below).

```ts
interface Leg {
  index: number;                            // 0-based, route order
  link: LinkId;
  kind: "share" | "partner_with_holds" | "partner_without_holds";
  shown_fees: ShownFee[];                   // partner legs only; [] otherwise
}

interface ShownFee {
  fee_id: FeeId;
  partner_link: LinkId;
  amount: MicroUsd;
  kind: "plain" | "minimum_term";
  term_end: UtcMinute | null;               // minimum_term only: end of the partner's minimum term for this reservation
  due_at_window_end: boolean;               // minimum_term only: the offer showed it due when the booked window ends inside the term (P3-S74)
}

interface Part {
  part: PartId;
  own_rate: Mbps;                           // as booked, less any decrease
  window: { start: UtcMinute; end: UtcMinute | null };
  locked_price: PicoUsdPerMbpsMin;
  price_version: PriceVersion;              // the version the price was locked at
  catalogue_position: string;               // catalogue position read (J-17)
  locked_at: HlcTs;                         // ts of the deciding entry that added the part
  age: HlcTs;                               // request_age of the admission that added it
  request: RequestId;                       // that admission
  added_by: { principal: PrincipalRef; key: KeyRef | null }; // P2-S117
}

interface FeeDue { fee_id: FeeId; amount: MicroUsd; payer: "account" | "share" }

type EndCause =
  | "cancelled"              // by the account (including a shorten to or before the next boundary, and support acting at a documented request)
  | "cancelled_after_cut"    // by the holder after a POL-07 rate cut; Share pays a shown fee
  | "revoked"                // POL-07: every part's current rate 0 to the end
  | "released"               // POL-16 release after grace
  | "terminated"             // POL-30
  | "window_end";            // "ended at its window's end", as booked or as last changed

interface LifecycleBase extends EventHeader {
  stream: "lifecycle";
  account: AccountId;
  account_is_probe: boolean;                // F9 designation in force at the entry (MM-1); rating emits nothing for a probe account
  reservation: ReservationId | null;        // null only for residue events
  change_id: ChangeId | null;               // the E11's identity for changes; null for confirmed/part_added (E5) and residue
}

type LifecycleEvent =
  | Confirmed | PartAdded | RateDecreased | Cut | Shortened | Moved | PriceStep | Ended
  | LegChangesDurable | PartnerLegAffected | Pol28Residue | OfferNotice | OfferCutKept;

interface Confirmed extends LifecycleBase {
  kind: "confirmed";                        // E5 of a booking
  route: CatalogueRouteId;
  product: ProductId;
  legs: Leg[];
  window: { start: UtcMinute; end: UtcMinute | null };
  parts: Part[];                            // exactly one at creation
  decided_ts: HlcTs;                        // first active minute = max(window.start, floor_min(decided_ts))
  announced_price_steps: { price_version: PriceVersion; effective: UtcMinute }[]; // announced change shown at booking (§3.2), else []
  booked_by: { principal: PrincipalRef; key: KeyRef | null };
}

interface PartAdded extends LifecycleBase {
  kind: "part_added";                       // E5 of an extension, renewal, open-ended change or increase
  part: Part;
  window: { start: UtcMinute; end: UtcMinute | null }; // the reservation's window after the change
  part_rates: PartRates[];                  // every part's current rate pieces after the change
}

interface RateDecreased extends LifecycleBase {
  kind: "rate_decreased";                   // E11 for a decrease; last in, first out on current rates
  effective: UtcMinute;                     // nb(ts)
  part_rates: PartRates[];                  // only the changed parts, from `effective`
}

interface Cut extends LifecycleBase {
  kind: "cut";                              // E11 cause POL-07 cut, one per (link, reduction, reservation) target received or lowered
  link: LinkId;
  reduction: ReductionId;
  target_revision: number;                  // revision of the cut_target this event applies, as the link sent it; 1 = first target (binding, settled with C03 M2)
  t_eff: UtcMinute;                         // effective minute; may be before ts (the one exception, see Semantics)
  target: Pieces | "none";                  // as recorded, the per-minute min of every target received for the key
  covered_parts: PartId[];
  applied: { status: "applied"; change_ids: ChangeId[] | "none" }
         | { status: "not_applied"; why: "ended" | "left_link" };
  part_rates: PartRates[];                  // resulting current rates of every changed part, from t_eff; [] when nothing changed
  applies: LinkReduction[];                 // every (link, reduction) the composition includes at the changed minutes
  rate_cut: boolean;                        // some part's current rate fell; the holder may then cancel without fee (POL-08)
}

interface Shortened extends LifecycleBase {
  kind: "shortened";                        // E11, a new end after the next boundary (not ending now)
  new_end: UtcMinute;
  part_rates: PartRates[];                  // parts clipped to new_end
  fee_due: FeeDue | null;                   // only a minimum-term fee whose term the new end falls inside; a plain fee is never due on a shorten
}

interface Moved extends LifecycleBase {
  kind: "moved";                            // E11 written with E13 final; the move is decided in advance
  offer: OfferId;
  route: CatalogueRouteId;                  // the path's catalogue route ID (AI-19-2)
  shown_price: PicoUsdPerMbpsMin;           // the lower of the original and the path's, fixed for the reservation's life
  move_at: UtcMinute;                       // >= nb(ts); later than requested => delay_min > 0
  delay_min: number;                        // minutes later than the holder's requested move minute (alerted when > 0)
  legs: Leg[];                              // the new path's legs
  part_rates: PartRates[];                  // every part from move_at; a move final after a cut carries the cut rates (P1-S84)
  applies: LinkReduction[];                 // the (link, reduction) pairs whose cuts still bind on the new path; [] if none
}

interface PriceStep extends LifecycleBase {
  kind: "price_step";                       // one per reservation, all in the account's single price-change E11
  price_version: PriceVersion;
  effective: UtcMinute;                     // oe_effective, recorded at the announcement, before it
  route: CatalogueRouteId;
}

interface Ended extends LifecycleBase {
  kind: "ended";
  cause: EndCause;
  effective: UtcMinute;                     // accrual ends here (exclusive)
  delay_min: number;                        // > 0 only for a cause the owner reached late (alerted)
  fees_due: FeeDue[];                       // every shown fee that falls due at this end, with its payer; [] if none
  failed_changes: RequestId[];              // pending and queued changes this end failed, "reservation ended"
  termination?: {                           // cause "terminated" only
    action_id: string;
    role: "network_operations" | "compliance";
    reason_code: string;
    notice: "told" | "withheld" | "withhold_refused";
    order_ref: string | null;               // set iff notice = "withheld"
  };
}

interface LegChangesDurable extends LifecycleBase {
  kind: "leg_changes_durable";              // E12: every Share leg acknowledged the E11's leg changes (MM-6)
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
  kind: "pol28_residue";                    // a partner booking cancelled at Share's cost because its request was withdrawn or failed (AI3-4)
  reservation: ReservationId | null;        // set when the request was an offer's partner booking, (reservation, offer)
  request: RequestId | null;                // the booking or change request; null for an offer's partner booking
  offer: OfferId | null;
  partner_link: LinkId;
  fee: MicroUsd;                            // per the partner terms in force at booking
  payer: "share";
}

interface OfferNotice extends LifecycleBase {                    // holder notices only; rating ignores (MM-7)
  kind: "offer_made" | "offer_accepted" | "offer_declined" | "offer_lapsed" | "offer_failed";
  offer: OfferId;
  route: CatalogueRouteId;
  shown_price: PicoUsdPerMbpsMin;
  offer_window_end: UtcInstant | null;      // offer_made
  confirmed_only_at_acceptance: boolean;    // a partner leg on the path (P1-S59)
  cut_kept: { rate: Mbps; may_book_increase: true } | null; // offer_accepted after the cut applied (P1-S84 row 2)
}

interface OfferCutKept extends LifecycleBase {
  kind: "offer_cut_kept";                   // KEPT_FOR_OFFER: offer-scoped target recorded in E13; NOT a "cut" event, never holds closure
  offer: OfferId;
  link: LinkId;
  reduction: ReductionId;
  target: Pieces | "none";
}

// Effective-time closure, published by C01's closure emitter, not by the account owner.
interface LifecycleResolved {
  kind: "resolved";
  resolved: HlcTs;                          // no row with ts <= resolved follows on this destination Kafka partition
}
```

### Reservation command port: operator side

gRPC service `AccountOwner.ReservationCommand`, routed by C01's `route(account)`.

```ts
// RFC-005 §7.4 envelope, verbatim fields; this contract fixes only what terminate uses.
interface OperatorEnvelope {
  action_id: string;
  action_type: "terminate_reservation_network_abuse" | "terminate_reservation_compliance";
  target: { account: AccountId; reservation: ReservationId };
  target_version: number;                   // sequence of the reservation's last change, from target_summary
  role: "network_operations" | "compliance";
  reason_code: "network_abuse" | "fraud" | "sanctions_order" | "legal_order";
  order_ref: string | null;                 // order register identifier; required for legal_order and with withhold_notice
  note_ref: string | null;
  flags: { withhold_notice?: boolean };
  not_after: UtcInstant;
  requester: SignerBlock;
  approver: SignerBlock | null;             // compliance: a second compliance operator
  console_epoch: number; issued_at: UtcInstant; // informational
}

interface TerminateRequest {
  routing: RoutingHeader;                   // C01: slot, generation, epoch, map_version the caller routed with
  envelope: OperatorEnvelope;
}

type TerminateAnswer =
  | { result: "TERMINATED"; change_id: ChangeId; effective: UtcMinute; ts: HlcTs;
      notice: "told" | "withheld" | "withhold_refused" }
  | { result: "REFUSED"; failed_check: EnvelopeCheck; ts: HlcTs | null }
  | { result: "NOT_ACTIVE"; ended_effective: UtcMinute }   // the reservation had already ended
  | RuntimeResult;                                          // C01: StaleEpoch | Moved | Moving | Stopped | Overloaded

type EnvelopeCheck =
  | "digest" | "action_type" | "role" | "reason_code"       // RFC-005 §7.4 check 1
  | "assertion"                                              // check 2
  | "operator_check"                                         // check 3 (identity C15 at apply time)
  | "four_eyes"                                              // check 4
  | "not_after"                                              // check 5: ts > not_after - ε
  | "target_version"                                         // check 6
  | "unknown_reservation";
```

Release after grace has no wire schema. It is the in-process call `release_due: ReservationId[]`
in the F7 *grace ended* outcome (RFC-004 §A7). Consumers see it only as `ended` events
with cause `released`.

## Semantics

### Request outcome feed

- **One event per reported outcome.** The row is written in the transaction of the entry
  that makes the outcome reportable: E5 (confirmed), E1′ (decided at intake), the ending
  entry (E4, E6, E7) if it already records every release, or otherwise the E8 that
  completes the releases. A request has at most one deciding entry (its `decision` row),
  so it has at most one outcome event. Redeliveries are duplicates by identity.
- **Precondition for acting.** A consumer may treat an `OutcomeEvent` as reported only
  when it holds a `ReportMarker` that meets all three conditions:
  - it is for the same `slot`;
  - its `epoch` is at least the event's `epoch`;
  - its `report_position` is at or above the event's `ts`.

  This is C01's `reported` gate. The gate buffers each event until a covering marker
  arrives, whichever path (direct or relay) brought either one.
- **Markers.** A marker is carried by the next batch of any partition in the slot. If no
  batch comes within 20 ms (est.) of the report position passing an unmarked event, a
  marker-only transaction carries it instead. Markers never go backwards for a given
  (slot, epoch). After any acquisition the new holder's first marker is at or above its
  catch-up read's timestamp, and it writes none until `read_lease` + ε after it acquired
  the slot (C01; RFC-000 AI-33-2, AI-R6-2).
- **Outcomes are final.** A reported outcome never changes (P2-S10). An event whose
  `request` already has an outcome in the consumer's state is a duplicate, by
  construction.
- **Notifier.** For each reported outcome with `answered_pending = true` of an account
  with a registered endpoint, the notifier sends one signed webhook. It sends none for an
  outcome answered synchronously (P2-S09; Settled MM-10).
- **`answered_pending`.** It is recorded in the entry that makes the outcome reportable.
  It is `true` if the owner sent a `pending` answer for the request before that entry
  committed. After a takeover the new owner cannot know whether its predecessor sent one,
  so a request it reports takes `true`. That can mean an extra webhook, never a missing
  one. Alerting and the console list events whose
  `outcome` is `failed`, with `reason` and `leg` (P2-S51).
- **Errors.** The feed has no error responses. A consumer that cannot decode an event
  stops that partition and raises an alert. It never skips the event.

### Reservation lifecycle feed

Every event is written as an outbox row in the transaction of the entry it reports. The
mapping from entry to events:

| Entry | Events written in its transaction |
|---|---|
| E5 (booking) | `confirmed` |
| E5 (change adding a part) | `part_added` |
| E11 decrease | `rate_decreased` |
| E11 cut (one target) | `cut`. Also `ended(revoked)` if every part's current rate is 0 from a minute to the end |
| E11 shorten (not ending) | `shortened` |
| E11 cancel, or a shorten to or before the next boundary | `ended(cancelled \| cancelled_after_cut)` |
| E11 move (with E13 final) | `moved` |
| E11 price change (with F11) | one `price_step` per listed reservation |
| E11 in the F7 *grace ended* entry | one `ended(released)` per listed reservation |
| E11 termination | `ended(terminated)` |
| E11 window end | `ended(window_end)` (MM-5) |
| E12 | `leg_changes_durable` |
| E13 made, accepted, declined, lapsed, failed | `offer_*`. Also `pol28_residue` for a failed offer whose partner booking was made |
| E13 offer-scoped target | `offer_cut_kept` |
| E14 | `partner_leg_affected` |
| E4, E6, E7 that cancel a partner booking at Share's cost | `pol28_residue` |

**Part rates are absolute.** Every `part_rates` entry gives the part's current rate as
minute pieces from its first `from`. It supersedes everything earlier stated for that part
from that minute on. A consumer applies `part_rates` and never re-derives LIFO order or
the cut composition. Rating checks that its own result agrees and alerts on a mismatch
(RFC-003 §5.2, P3-S46).

**Effective minutes.**
- `ended`, `shortened`, `rate_decreased`, `part_added` and `moved` take effect at or after
  `nb(ts)`, or at a minute fixed in advance and recorded before it.
- `price_step` and `moved` are recorded before their minute (A-3). A cause the owner
  reaches late takes `nb(ts)`, sets `delay_min`, and is alerted (RFC-006 §16, "Late
  E11").
- **Exception: `cut`.** `t_eff` may be at or before `ts`.
- **Exception: `ended(window_end)`.** Its `effective` equals the window end the earlier
  events already carry (MM-5).

**Cut.**
- One event is written for each target received for a (link, reduction, reservation).
- A later, lower target for the same key emits another `cut` with a higher
  `target_revision`. Its `target` is the per-minute `min` of everything recorded, and it
  supersedes the earlier event for that key.
- A repeat of a target with the same content emits nothing.
- If the target was not applied, `part_rates` is `[]` and `applied.status` says why.
- `NOT_APPLIED(unknown)` writes no entry and so emits no event (it is only alerted).
- An offer-scoped target emits `offer_cut_kept`, never `cut`. It is applied, if ever, only
  in the `moved` event's `part_rates` and `applies` (RFC-002 §9.6, D5).

**Move after a cut (v1.10, P1-S84).**
- If a move becomes final after the old link's `t_eff`, its `part_rates` are the cut rates
  and `applies` names the binding (link, reduction) pairs. The Mbps the offer held beyond
  those rates are released at `move_at`.
- If a move is final at or before `t_eff`, it moves the full rate. A later target from the
  old link is then recorded as `cut` with `not_applied: left_link`.

**Fees.**
- `confirmed` carries every shown fee. Each `ended`, and each `shortened`, names the fees
  that fall due and their payer, under POL-08 as amended in v1.8 (RFC-002 §9.5).
- A fee is due at most once per `fee_id`. Rating charges what the event names and checks
  it against RFC-003 §5.4's tables, alerting on any difference.

**Holder notices.** The notifier tells the holder (POL-07, P1-S26, P1-S50, P1-S72, P2-S91,
P4-S23, X1-S17) on these events:
- `cut` with `rate_cut`, adding that the holder may cancel without fee;
- `ended` (revoked, released or terminated);
- `partner_leg_affected`;
- the `offer_*` events.

Exception: it suppresses the notice for `ended` with `termination.notice = "withheld"`
(MM-8).

**Leg changes durable.**
- The E12 event is `leg_changes_durable`. Buyer-facing consumers must not present the
  capacity freed by a change until they hold it: reporting a cancellation or decrease, for
  example (RFC-002 §9.3, P2-S43, P2-S48).
- Rating ignores it. Accrual follows the change event's effective minute (RFC-003 §5.2).

### Effective-time closure (resolved markers)

- **Emitter.** C01's closure emitter publishes `resolved` markers on each destination
  Kafka partition of `account.lifecycle.v1`. The account owner never emits closure.
- **Guarantee.** No row with `ts` ≤ `resolved` will follow on that destination partition.
  Every event other than `cut` and `ended(window_end)` takes effect at or after
  `floor_min(ts)`, so no unseen event can change an earlier minute `m` once `resolved` ≥
  the end of `m`.
- **Cuts.** The consumer holds closure for each open reduction with RFC-001's `hold_1` and
  `hold_2`, using C01 schedule-feed markers and RFC-001's feed. These holds are not part of
  this contract. `offer_cut_kept` never holds closure.
- **Releasing `hold_2` (binding, settled with C03 M2).** Rating releases a reservation's
  `hold_2` for a reduction only when both of these are true:
  - it holds `REDUCTION_FINAL` for the reduction;
  - it holds a `cut` event for (link, reduction, reservation) whose `target_revision`
    equals the highest `CUT_DECIDED` revision for that key seen on the schedule feed
    before `REDUCTION_FINAL`.

  A `cut` with a lower revision updates `part_rates` but does not release the hold.
- **Late extension.** A reservation added to a reduction's affected set by a late extension
  may already have minutes from `t_eff` closed and emitted at the uncut rate. The `cut`
  event for it arrives like any other `cut`. Rating then amends every already-closed minute
  down to the cut `part_rates`, with reason "late POL-07 cut", carrying (link, reduction)
  and the extension chunk it takes from RFC-001's `REDUCTION_EFFECTIVE`. Settlement posts it
  as M6, or M7 in own mode (RFC-003 erratum 5.1, RFC-004 erratum 5.1, P4-S117). This feed
  does not mark a cut as late: rating recognises one from its own closure state.

### Reservation command port: `terminate`

**Preconditions.** The command is routed to the slot the C01 placement cache names, and
carries the caller's routing header. The owner admits it with C01's `admitCommand`.

**Checks.** At apply time, inside the batch transaction at `ts`, the owner runs RFC-005
§7.4 checks 1 to 6:
- the digest is recomputed;
- the action type, role and reason code are allowed;
- the WebAuthn assertions verify;
- identity's `operator_check` (C15) passes;
- four eyes holds for compliance;
- `ts` ≤ `not_after` − ε;
- `target_version` equals the reservation's last change sequence.

**Outcomes.**
- **`TERMINATED`.** One E11 (cause "terminated") ends the reservation from `nb(ts)`. The
  same entry fails every pending and queued change with "reservation ended" (P2-S80) and
  makes the shown fees due, paid by the buyer. The E11 records the envelope's audit
  fields, `withhold_notice` and the order reference. The answer is given after the E11
  commits.
- **Notice withheld.**
  - `notice = "withheld"` only when all of these hold: `action_type` is the compliance
    termination, `role` is compliance with a compliance approver, `reason_code` is
    `legal_order`, `order_ref` is present, and `flags.withhold_notice` is true. Both RFC-005
    and the E11 check role and reason.
  - Any other envelope with `withhold_notice`, a network-abuse termination for example,
    still terminates, with `notice = "withhold_refused"`. The holder is told (X1-S36
    row 1).
  - An envelope of an action type other than a termination is refused as a whole. That is
    RFC-005's rule, and such envelopes never reach this RPC.
- **No later withhold.** The port has no withhold command. A later request to withhold is
  refused at the console, and the notice is sent within `affected_notice_time` (X1-S36
  row 3).
- **`REFUSED(failed_check)`.** Nothing changes. The console records the refusal. A reason
  outside POL-30 is refused at `reason_code` (X1-S16).
- **`NOT_ACTIVE`.** The reservation had already ended (any cause). Nothing changes.
- **Runtime results** follow C01:
  - `StaleEpoch` and `Moved`: refresh the cache and re-send with the same `action_id`.
  - `Moving`: retry after about 100 ms.
  - `Stopped`: "temporarily unavailable".
  - `Overloaded`: back off.

### Release after grace (internal)

The release rule belongs to RFC-004 Part A §A7; the entry is written by RFC-002 (JR-2):
- At `grace_end`, if the account is still suspended and not yet released, the F7
  *grace ended* entry commits at a `ts` at or after `grace_end`. Its outcome
  `release_due` lists the reservations to release.
- The booking module writes one E11 per listed reservation in the same entry, cause
  "released", effective `nb(ts)` (MM-4). Each E11 fails every pending change.
- The buyer pays any shown fee. Any shortfall becomes a negative balance (P4-S97).
- Each E11 emits `ended(released)`, which the notifier uses to tell the buyer which
  reservations were released and why (P4-S23, MM-9).

## Delivery and ordering

| | Outcome feed | Lifecycle feed | `terminate` |
|---|---|---|---|
| Delivery | At least once: the direct publish, the relay, and the takeover republish (C01) | At least once, as for the outcome feed | Synchronous, retried by the console until it gets an answer |
| Effect | Exactly-once effect at the consumer, by deduplicating on identity | Exactly-once effect at the consumer, by deduplicating on identity | Exactly-once by `action_id`: one E11 at most |
| Kafka key | Account slot | Account partition | — |
| Order guaranteed | `stream_seq` order per (partition, `outcome`). No order across partitions of a slot beyond commit order. Markers are interleaved in the slot's Kafka partition on the direct path. On the relay path events and markers can arrive in any order, so the consumer buffers (C01) | `stream_seq` order per (partition, `lifecycle`), contiguous across owner changes and moves. The consumer buffers out-of-order arrivals until the gap fills (C01 gap fill after `gap_timeout`). No order across accounts | Applied in the account owner's log order |
| Closure | Report markers per slot | Resolved markers per destination Kafka partition (C01 closure emitter) | — |

## Idempotency

| Item | Key | Duplicate (same key, same content) | Same key, different content |
|---|---|---|---|
| Feed event (both feeds) | (`partition`, `stream`, `stream_seq`) | Dropped by the consumer (C01). The writer's (generation, epoch) is informational for ordering | Cannot happen: a stream sequence is assigned once in a committed row. If a consumer sees it, it treats it as an integrity defect, stops the partition and raises a page |
| Outcome (semantic) | `request` | Same outcome, by A7 | Impossible (`decision` row). If seen, an integrity alert |
| `cut` (semantic) | (`link`, `reduction`, `reservation`) | The owner writes no event for a repeat | A later lower target: a new event with a higher `target_revision`, which supersedes. A higher target is ignored at the minutes where it is higher, and alerted |
| `price_step` (semantic) | (`account`, `price_version`, `reservation`) | A redelivered announcement writes no entry | — |
| Fee | `fee_id` | Charged at most once | — |
| `pol28_residue` | `request`, or (`reservation`, `offer`) | At most one per partner booking | — |
| Notifier notice | (source partition, stream, `stream_seq`, destination) | One notice | — |
| `terminate` | `action_id` | Answers the first result again, `TERMINATED` or `REFUSED` | RFC-005's digest covers every field. A different envelope under a used `action_id` fails `operator_check` (the assertions were consumed under that action) and is refused |

## Ownership

| Data | Who writes | Who may read |
|---|---|---|
| `account.outcome.v1` rows and markers | The account owner's outbox only (RFC-000 A1). The relay copies them; the relay never authors | The notifier, alerting and the operator console. The console reads failed requests through a read grant (RFC-005 §7.6) |
| `account.lifecycle.v1` rows | The account owner's outbox only | Rating (RFC-003), the catalogue's locked-price read model (AI3-7), history (RFC-006), the notifier, reporting. Supplier-facing reporting applies RFC-005's supplier-visibility query before it shows anything about an account |
| `resolved` markers | The closure emitter only (C01) | Every lifecycle consumer |
| E11 termination entry | The account owner only | History and audit |

## Timeouts and deadlines

| Item | Value |
|---|---|
| Marker-only transaction | Within 20 ms (est.) of the report position passing an unmarked event |
| Outcome webhook first attempt | About 1 s after the report (RFC-006 §15, est.). Retried for `webhook_retry`, 24 h |
| Holder notices (cut, affected, termination, offers, release) | Told within `affected_notice_time`, 60 s (POL-07), measured from the entry's `ts` |
| Lifecycle closure lag | About 2 to 3 s behind now (C01, est.). Longer only while a reduction is open (`hold_2`) |
| Late-E11 alarm | Raised for any `delay_min` > 0. Not raised for `ended(window_end)` or `ended(released)` (MM-4, MM-5) |
| `terminate` per-call deadline | 2 s (est., to be confirmed in C5). The console retries with the same `action_id` until it gets an answer or until `not_after` − ε. After that the owner refuses with `not_after` |
| Consumer feed lag alarm | A consumer more than 60 s behind a stream's head (RFC-006 §16) |
| Retention | Outbox 25 h. History archive and replay for 7 years (RFC-006 §13). Schemas decodable for 7 years |

## Versioning and compatibility

- `schema_v` travels in the header of every event. Schemas live in the schema registry and
  every version stays decodable for 7 years (RFC-006 §13.5).
- **Compatible change** (same topic, `schema_v` + 1): add an optional field, or add an
  enum value to `OutcomeReason.code`.
- **Incompatible change** (new topic `.v2`): add a lifecycle `kind` that rating must act
  on, add an `EndCause` value, or change the meaning of any unit or of `part_rates`. The
  provider publishes both topics until every consumer has moved.
- **Unknown values.**
  - Rating must **stop the partition and page** on an unknown lifecycle `kind` or
    `EndCause`, never skip it, because accrual would be wrong.
  - The notifier, reporting and history may store an unknown `kind` and ignore it.
  - Every consumer ignores unknown optional fields.
- The `terminate` RPC follows the same rules. New `EnvelopeCheck` values are compatible.
  Callers treat an unknown one as a refusal.

## Scenarios relied on

- **Outcome feed:** P2-S07, P2-S08, P2-S09, P2-S10, P2-S13, P2-S18, P2-S23, P2-S51,
  P2-S73, P2-S111.
- **Lifecycle feed:**
  - ends, shortens and decreases: P2-S43, P2-S44, P2-S48, P2-S80, P2-S81, P2-S82;
  - part keys: P2-S117;
  - partner leg affected: P2-S91;
  - holder notices: P1-S26, P1-S50, P1-S72, P1-S75;
  - offers and moves: P1-S35, P1-S52, P1-S53, P1-S57, P1-S59, P1-S61, P1-S71, P1-S84;
  - accrual and price: P3-S02, P3-S03, P3-S04, P3-S05, P3-S07, P3-S08, P3-S09, P3-S40,
    P3-S42, P3-S45, P3-S46, P3-S58, P3-S59, P3-S64;
  - fees: P3-S11, P3-S43, P3-S44, P3-S60, P3-S63, P3-S74;
  - late POL-07 cut: P4-S117;
  - probe accounts: X2-S20.
- **Command port:** X1-S12, X1-S16, X1-S17, X1-S36, P4-S23, P4-S97.

## Conformance tests

**Provider (RFC-002), run against the account owner with a recorded Kafka sink.**

| # | Test | Scenarios |
|---|---|---|
| PO-1 | Every reported outcome has exactly one outcome event. It is written in the transaction of E5, E1′, the ending entry or the completing E8, and nowhere else. An expired request's event `ts` is at or after `D` | P2-S10, P2-S13 |
| PO-2 | The same event identity appears on the direct path, the relay path and the takeover republish, across an owner change and a partition move | P2-S111 |
| PO-3 | Markers never go backwards for a (slot, epoch). A new holder's first marker is at or above its catch-up read and is written no sooner than `read_lease` + ε after it acquired the slot. An unmarked event gets a marker within 20 ms (est.) | P2-S111 |
| PO-4 | A rejection carries `blocking_link`, `counter_offer`, and `retry_after` when `wait = false`. An expiry carries the reason from RFC-002 §6.2's table | P2-S18, P2-S23, P2-S73 |
| PO-5 | `answered_pending` is `true` exactly when a `pending` answer was sent before the reporting entry committed, and `true` for every request reported after a takeover whose predecessor's answer is unknown | P2-S08, P2-S09 |
| PL-1 | Each entry in the table under Semantics emits exactly the events listed, in that entry's transaction, with contiguous `stream_seq` | — |
| PL-2 | `part_rates` composed per RFC-002 §9.7: one target alone gives the link's rate exactly; several give the per-minute min; a decrease is LIFO on current rates; a part added after a target is not capped | P3-S46, P3-S58 |
| PL-3 | A lower re-target emits a superseding `cut` with a higher `target_revision`. A repeat emits nothing. An unknown reservation emits nothing. An offer-scoped target emits `offer_cut_kept` and never `cut` | P1-S52 |
| PL-4 | A move final before `t_eff` carries the full rate. A move final after it carries the cut rate and the binding `applies` | P1-S84 |
| PL-5 | Fees: kind, term end and due-at-window-end are on `confirmed`. Due and payer at each end and shorten follow RFC-002 §9.5, at most once per `fee_id` | P3-S43, P3-S44, P3-S63, P3-S74 |
| PL-6 | No event other than `cut` and `ended(window_end)` has an effective minute before `floor_min(ts)`. A late cause sets `delay_min` and raises the alarm | — |
| PL-7 | `account_is_probe` matches F9 | X2-S20 |
| PC-1 | Network-abuse termination with `withhold_notice` gives `TERMINATED` with `withhold_refused`. Compliance legal-order termination with withhold and approval gives `withheld` and records `order_ref`. A later withhold request is impossible on the port | X1-S36 |
| PC-2 | Every RFC-005 §7.4 check fails in turn and gives `REFUSED` with that check and no entry. A reason outside POL-30 is refused | X1-S16 |
| PC-3 | A repeated `action_id` returns the first answer and no second E11 | — |
| PC-4 | F7 *grace ended* writes `ended(released)` for every listed reservation in the same entry, effective `nb(ts)`, with the buyer as payer of shown fees | P4-S23, P4-S97 |

**Consumers.**

| # | Side | Test | Scenarios |
|---|---|---|---|
| CN-1 | Notifier | An outcome event without a covering marker (same slot, epoch ≥, `report_position` ≥ `ts`) is not delivered. Once covered, it is delivered once, whichever path delivered the event or marker first. An event with `answered_pending = false` gets no webhook | P2-S09 |
| CN-2 | Notifier | `ended(terminated, withheld)` produces no holder notice. `withhold_refused` and `told` produce one within 60 s | X1-S36, X1-S17 |
| CN-3 | Notifier | `cut` with `rate_cut`, `ended(revoked \| released)`, `partner_leg_affected` and `offer_*` each produce one notice. Duplicates by identity produce none | P1-S26, P1-S75, P2-S91, P4-S23 |
| CR-1 | Rating | Accrual uses `part_rates` as given. It ends at `ended.effective`. It starts at `max(window.start, floor_min(decided_ts))` | P3-S02, P3-S04, P3-S42 |
| CR-2 | Rating | A minute is never closed past the lifecycle `resolved` marker. A reservation in `A_R` stays held at `t_eff` until `REDUCTION_FINAL` and a `cut` whose `target_revision` equals the highest `CUT_DECIDED` revision seen before `REDUCTION_FINAL`. A lower-revision `cut` keeps the hold. `offer_cut_kept` never holds | P3-S58 |
| CR-3 | Rating | A `cut` for minutes already closed produces downward "late POL-07 cut" amendments to the cut rates and leaves the originals unchanged | P4-S117 |
| CR-4 | Rating | Fee lines follow the fee and payer the event names. A disagreement with RFC-003 §5.4's tables raises an alert. A `fee_id` is charged once | P3-S60, P3-S63, P3-S74 |
| CR-5 | Rating | `moved` relabels lines with `route` from `move_at` and prices at `min(price, shown_price)`. `price_step` re-prices every part from `effective` | P3-S59, P3-S64 |
| CR-6 | Rating | `account_is_probe` gives no lines. An unknown `kind` stops the partition | X2-S20 |
| CH-1 | History | "As known at T" equals the events with `ts` ≤ T, rebuilt from the archive | — |
| CC-1 | Console | Handles each `TerminateAnswer`. On `StaleEpoch` or `Moved` it retries with the same `action_id`. It records refusals | X1-S16 |

## Settled

Each item was a point where the RFCs disagreed, or where one of them was silent on something
a consumer relies on. The orchestrator settled every one; its decisions are binding and the
contract follows them. Each RFC erratum they require is listed under
[Consumer obligations](#consumer-obligations-errata-required-by-settled-points).

| # | Point | Provider side (RFC-002 rev. 5) | Consumer side | Settled as |
|---|---|---|---|---|
| MM-1 | Probe-account flag on the lifecycle feed | §13.1 does not list it. Probe accounts are ordinary accounts with an F9 designation | RFC-003 §7 consumes "whether the account is a probe account" | `account_is_probe` on every lifecycle event, from F9 as in force at the entry |
| MM-2 | Identifier of a shown fee | Gives each fee's kind and due-at-window-end flag. Due "at most once per reservation and leg" (§9.5). No fee ID | RFC-003 §5.4 consumes a fee ID, amount and partner link | `fee_id = "<reservation>/<leg index>"` |
| MM-3 | Target revision on `cut` (RFC-000 C4-2) | No revision. Idempotent by (link, reduction, reservation) | RFC-001 carries a revision. RFC-003 holds closure until the cut is final | `cut` carries the applied `target_revision`. Rating releases `hold_2` only at the highest `CUT_DECIDED` revision seen before `REDUCTION_FINAL` (from C03 M2) |
| MM-4 | Effective minute of release after grace | E11 effective ≥ `nb(ts)`. Written in the F7 entry, which cannot commit before `grace_end` (RFC-004 §A7) | RFC-003 §5.2 expects it recorded before its minute, and alerts a late one | Effective at the next minute boundary after the F7 entry's commit. This keeps closure exact, at the cost of at most 1 extra minute of a reservation that was still held. Not alerted as late |
| MM-5 | Who writes "ended at its window's end" | §9.1 publishes an end event at that minute, but no entry kind writes it | RFC-003 §5.4 needs it, with any minimum-term fee due | A timer-driven E11 (cause window end) in the first batch with `ts` ≥ window end, effective = window end. It is the second exception to the effective-minute rule. Accrual never depends on it |
| MM-6 | "Published as effective only once E12 is committed" (§13.1) | The row is written with the E11 | RFC-003 §5.2 never waits for a later event | The change event is written with its entry, plus `leg_changes_durable` at E12. Buyer-facing consumers wait for the E12 event; rating does not |
| MM-7 | Offer notices | No offer events on the lifecycle feed. E13's holder notice names no channel | RFC-006 §15 takes offers from the lifecycle feed. P1-S84 requires telling the holder that the cut is kept | `offer_*` and `offer_cut_kept` events on the lifecycle stream. Rating ignores them. `offer_cut_kept` is never a `cut` |
| MM-8 | Honouring `withhold_notice` | `ended` says whether the notice is withheld | RFC-006 §15 is silent on it | The notifier suppresses the holder notice only for `termination.notice = "withheld"` |
| MM-9 | Source of the release notice (P4-S23) | Released ends go on the lifecycle feed | RFC-006 §15 takes it from RFC-004's standing and funds feeds | `ended(released)` on this feed is the source. No second release notice is sent |
| MM-10 | Which outcomes get a webhook | The edge's `pending` answer is not logged | RFC-006 §15: only outcomes "of a request answered `pending`", sized on that | **Orchestrator override.** The outcome event carries `answered_pending`. The account owner knows the flag when it acknowledges, and records it in the outcome entry. The notifier sends a webhook only when it is `true`. RFC-006's sizing is unchanged |
| MM-11 | Marker fields | (slot, epoch, report position) | RFC-006 §5.3 adds generation | Payload (slot, epoch, report_position). `generation` is a topic-convention header only, not used by the gate |
| MM-12 | `ended(revoked)` from a cut | §9.7 names no end event for a cut that leaves every part at 0 | RFC-003 §5.2 ends accrual at a revocation's notice end (P3-S08) | The same E11 emits `cut` and `ended(revoked)`, effective at the first minute from which every part is 0 to the end |
| — | `terminate` per-call deadline | Not stated | Not stated | 2 s (est.), to be confirmed at C5 |

## Consumer obligations (errata required by settled points)

The RFCs are not edited by this contract. The owning RFCs need the errata below so that
they match this contract.

| RFC | Erratum | Source |
|---|---|---|
| RFC-002 (provider) | §9.7, §13.1: the lifecycle `cut` event carries the **target revision** of the `cut_target` it applies, beside (link, reduction), the minute pieces or `none`, and the resulting part rates. `cut_target` is received with its revision. A lower re-target writes a new `cut` with the higher revision | MM-3; C03 M2 |
| RFC-002 | §13.1 lifecycle feed: `account_is_probe` on every event (from F9); `fee_id = "<reservation>/<leg index>"` on every shown and due fee | MM-1, MM-2 |
| RFC-002 | §9.4, §9.5 and RFC-004 JR-2: a release-after-grace E11 is effective at `nb(ts)` of the F7 entry and is not a late cause. Not alerted | MM-4 |
| RFC-002 | §9.1, §9.5: a timer-driven E11 (cause "ended at its window's end"), written in the first batch with `ts` ≥ the window end, effective at the window end, naming any minimum-term fee due. It is listed beside the cut as an exception to the effective-minute rule | MM-5 |
| RFC-002 | §13.1: replace "published as effective only once E12 is committed" with the change event written with the E11, plus a `leg_changes_durable` event written with the E12 | MM-6 |
| RFC-002 | §9.6, §13.1: the E13 states made, accepted, declined, lapsed and failed emit `offer_*` lifecycle events. An offer-scoped target emits `offer_cut_kept`, not `cut`. Drop the separate "notices" outbox feed from §2.5 | MM-7 |
| RFC-002 | §8.3: the outcome event carries `answered_pending`. The owner records the flag in the entry that makes the outcome reportable (E5, E1′, the ending entry or the completing E8), set when a `pending` answer was sent for the request. After a takeover the flag is taken as `true` when unknown | MM-10 |
| RFC-002 | §9.7: a cut that leaves every part at 0 to the end emits `ended(revoked)` in the same E11 | MM-12 |
| RFC-003 (consumer) | §5.6 `hold_2`: released only when `REDUCTION_FINAL` is held **and** the applied `cut` revision equals the highest `CUT_DECIDED` revision for (link, reduction, reservation) seen before `REDUCTION_FINAL`. A lower revision updates rates but keeps the hold. §7: add the revision to the consumed `cut` event | MM-3; C03 M2 |
| RFC-003 | §5.2: a release ends accrual at the next boundary after its entry's commit and is not a late-recorded end. `ended(window_end)` may carry an effective minute below its `ts`. §5.4 and §7: the fee ID is `"<reservation>/<leg index>"`. §7: consume `account_is_probe` from this feed. Ignore `offer_*`, `offer_cut_kept` and `leg_changes_durable` | MM-1, MM-2, MM-4, MM-5, MM-6, MM-7 |
| RFC-004 | §A7 and JR-2: the release E11s written in the F7 *grace ended* entry are effective at `nb(ts)`, so at most 1 minute of a reservation still held after `grace_end` | MM-4 |
| RFC-006 (notifier) | §15: take holder notices from the lifecycle feed's `cut` (with `rate_cut`), `ended`, `partner_leg_affected` and `offer_*` events. Suppress a holder notice only for `ended` with `termination.notice = "withheld"`. Take the release notice from `ended(released)` and send no second one from the standing or funds feeds. Send outcome webhooks only for `answered_pending = true`; sizing unchanged. Buyer-facing reports of freed capacity wait for `leg_changes_durable` | MM-6, MM-7, MM-8, MM-9, MM-10 |
| RFC-006 (platform) | §5.3: the report marker's payload is (slot, epoch, report position). `generation` is a header only and not part of the gate | MM-11 |

Out of scope, settled elsewhere: C4-1 (the delivered form of the cut-target answer), C4-3
(`STALE_CHANGE`) and C4-4 (`end_leg` naming every applied pair) belong to the link-facing
contract. C4-7 (`Stopped` and `Moving` handling) belongs to C01. This contract consumes
their results only as shown above.
