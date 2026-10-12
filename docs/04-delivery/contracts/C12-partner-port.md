# C12. Partner port, partner driver, partner reconciliation feed and equivalent-path source

| | |
|---|---|
| Contract ID | C12 |
| Version | 1 (from draft 1.1, revised per [review 38](../../reviews/38-contract-C12-review.md), with V1–V7 of [fix verification 50](../../reviews/50-contract-C12-fix-verification.md) applied) |
| Status | **Frozen.** Frozen at C4 on fix verification 50; errata owed listed below (S1 consumer obligations, "Settled"; and "Review 38 resolution"). Requirements issue RQ-2 is still open with the requirements owner; C12 already behaves as its amendment would |
| Provider | **Partner port** and **partner reconciliation feed**: the partner adapters of RFC-002 §10 (Share side). There is one adapter per partner link, the single writer of that partner link's partition. **Partner driver interface**: each per-partner driver, inside its adapter. **Equivalent-path source**: routing (external input, out of scope) |
| Consumers | **Partner port**: the account owner's booking module (RFC-002 §5, §9). **Partner driver interface**: the partner adapter (RFC-002 §10.2); counterparties are the external partner networks, reached only through drivers. **Reconciliation feed**: operator console and notifier (RFC-006). The account owner is not a consumer of the feed: it receives `partner_leg_affected` on the reservation command port (§3.4, review 38 m12). **Equivalent-path source**: RFC-002 only (RFC-000 AI-R1-5); RFC-003's catalogue is a precondition party, not a consumer |
| Transport | **Partner port**: gRPC command between NestJS owners, routed by the adapter's partition (slot) through the placement cache (RFC-002 §13; RFC-000 §8 "adapter interface, per partner"). Results from the adapter are **point-to-point state messages** (gRPC push, Kafka relay; RFC-000 §4.4). **Partner driver**: in-process call inside the adapter process; the driver speaks the partner's own API (wire format out of scope). **Reconciliation feed**: Kafka event through the adapter's transactional outbox. **`partner_leg_affected`**: a gRPC command from the adapter to the account owner on RFC-002's reservation command port. **Equivalent-path source**: synchronous query to routing (external input, RFC-000 §8) |
| Pinned to | `requirements-v1.10`. RFC-000 revision 4.4: §5.2; §8 rows "Partner port", "Partner reconciliation feed", "Equivalent-path source", "Outcome and expiry port"; V-03, A0R-08, A0R-14, AI-R1-5, AI-R6-3, AI-19-2. RFC-002 revision 5: §1.3, §3.2, §5.1, §5.5, §9.3–§9.7, §10, §12.1, §13. RFC-003 revision 5 with erratum 5.1: §6.1 catalogue, equivalent-path source row. RFC-005 revision 5: §8.2 partner callbacks. RFC-006 revision 6: runtime ((generation, epoch), slot routing, outbox) |

Partner-specific wire formats are out of scope: HTTP, SOAP, batch files, a partner's own
idempotency header name. Each driver maps the **Partner driver interface** (§2.2) onto its
partner's API.

## 1. Purpose

A route may cross partner links that Share does not schedule. The account owner books
those legs through one uniform **partner port**, which every partner adapter implements, so
the booking workflow never sees a partner's API. The adapter stands in for a schedule owner:

- it journals every partner call before making it. The journaled send time of a confirm is
  the request's "begin committing" time (POL-26);
- it refuses any call that a fence, an epoch or a tombstone forbids (RFC-000 §5.2, V-03);
- it keeps Share's own waiter queue at the partner (POL-02, and POL-05 applied at a partner);
- it keeps the set of partner bookings behind each reservation leg, and applies cancels and
  changes to them, in order and at their effective minute;
- it reconciles unknown results at once, and every partner daily (POL-28).

Daily mismatches are published on the **partner reconciliation feed**. The
**equivalent-path source** supplies candidate paths for POL-07 offers, each one a catalogue
route with split weights (AI-19-2).

## 2. Schema

Units and encodings, used throughout:

| Quantity | Type | Unit |
|---|---|---|
| Instants (`D`, `D_c`, send time, decision time, partner expiry) | `UnixMs` = integer | Milliseconds since the Unix epoch, UTC. A commit timestamp is the wall component of the HLC timestamp, truncated to ms |
| Window bounds, effective minutes | `UnixMinute` = integer | Whole minutes since the Unix epoch, UTC. Windows are half-open, `[start, end)` (glossary) |
| Rate | `Mbps` = integer ≥ 0 | Whole Mbps (POL-31). A reserved rate is ≥ `rate_min`; 0 appears only as a part's target rate in a decrease |
| Durations in this contract | integer | Milliseconds, unless the name ends in `_s` |
| Money (fees) | not carried here | Fees travel on the lifecycle feed in pico-USD (RFC-003). This contract carries only the cost bearer, and only to classify alerts (§3.3) |

### 2.1 Partner port (account owner → adapter; every adapter implements it)

```ts
type UnixMs = number; type UnixMinute = number; type Mbps = number;

/** A booking request (an original booking, or an addition: extend, increase, make
 *  open-ended), or the partner booking at an offer's acceptance (RFC-002 §9.6). */
type PartnerRequestId =
  | { kind: 'booking'; requestId: string }            // account partition + sequence, as the owner names it
  | { kind: 'offer'; reservationId: string; offerId: string };

type LegRef = { legIndex: number; partnerLinkId: string };   // legs numbered in route order (glossary)

/** Sender stamp on every command (RFC-000 §5.2, AI-R6-3; RFC-006 runtime). Never part of sameness (§5.2). */
interface OwnerStamp {
  accountPartition: string;     // the account slot's partition id
  generation: number;           // partition generation
  epoch: number;                // owner-lease epoch
  sequence: number;             // owner's command sequence, for tracing only
  mapVersion: number;           // placement map version the sender routed by
}

interface Window { start: UnixMinute; end: UnixMinute | null }   // null = open-ended

// ---- commands ----
interface ClassifyCmd   { partnerLinkId: string; asOf: UnixMs }    // m5: classification in force at asOf
interface HoldCmd       { stamp: OwnerStamp; request: PartnerRequestId; leg: LegRef;
                          reservationId: string | null;           // set for an addition (F3)
                          rate: Mbps; window: Window;
                          expiresAt: UnixMs;          // = D, always (POL-26, P2-S100)
                          requestAge: UnixMs; requestAgeTiebreak: string; // POL-02 priority
                          commitFence: UnixMs;        // D_c = D − commit_margin
                          wait: boolean;              // m6
                          opaqueRef: string }         // m2: what the partner may see (POL-33)
interface ConfirmCmd    { stamp: OwnerStamp; request: PartnerRequestId; leg: LegRef;
                          attempt: number }           // the attempt HELD named
interface BookFinalCmd  { stamp: OwnerStamp; request: PartnerRequestId; leg: LegRef;
                          reservationId: string | null;
                          rate: Mbps; window: Window; deadline: UnixMs; requestAge: UnixMs;
                          requestAgeTiebreak: string; commitFence: UnixMs; wait: boolean;
                          opaqueRef: string }
interface ReleaseCmd    { stamp: OwnerStamp; request: PartnerRequestId; deadline: UnixMs;
                          reason: 'not_confirmed' | 'yield_accepted' | 'withdrawn' | 'expired'
                                | 'rejected' | 'failed' | 'displaced' | 'offer_failed';
                          decisionTime: UnixMs }      // request-scoped: no attempt; ends every attempt;
                                                      // the adapter alone cancels any residue booking (F6)
interface OutcomeConfirmedCmd { stamp: OwnerStamp; request: PartnerRequestId; leg: LegRef;
                          attempt: number;
                          reservationId: string; partId: string;   // F3: joins the reservation-leg booking set
                          decisionTime: UnixMs }
interface CancelCmd     { stamp: OwnerStamp;
                          reservationId: string; leg: LegRef;      // acts on every booking in the set (F3)
                          cancelId: string;           // owner-chosen, unique per (reservation, leg)
                          changeSeq: number;          // F5: the ending E11's log sequence
                          reason: 'buyer_cancel' | 'shortened' | 'moved_off_leg' | 'revocation'
                                | 'termination' | 'release_after_grace';   // F6: no residue reasons
                          costBearer: 'share' | 'payer_per_terms';         // §3.3 pairing table (m16)
                          effectiveMinute: UnixMinute }                    // F4: required; the minute the leg ends
interface ChangeCmd     { stamp: OwnerStamp; reservationId: string; leg: LegRef;
                          changeId: string;
                          changeSeq: number;          // F5: the E11's log sequence
                          cause: 'buyer' | 'cut';     // m8
                          change: { kind: 'shorten'; newEnd: UnixMinute }
                                | { kind: 'decrease';               // RFC-002 §9.7 absolute form, newest part first
                                    parts: { partId: string; fromMinute: UnixMinute; rate: Mbps }[] };
                          decisionTime: UnixMs }      // S1: shorten and decrease only, through the driver's amend
interface MarkWaitingCmd { stamp: OwnerStamp; request: PartnerRequestId; waiting: boolean;
                          accountLogPosition: number }               // advisory hint (RFC-002 §10.5)
interface YieldAnswerCmd { stamp: OwnerStamp; request: PartnerRequestId; leg: LegRef;   // m1
                          attempt: number; answer: 'accept' | 'refuse' }
interface ResumeQueryCmd { stamp: OwnerStamp; request: PartnerRequestId }  // J7: per-request takeover barrier

// ---- synchronous replies ----
type CommandReply =
  | { kind: 'ACCEPTED'; journalPosition: number }       // intent journaled; the result follows as a PartnerResultMsg
  | { kind: 'RESULT'; result: PartnerResult }           // already known (a duplicate, or decided without a call)
  | { kind: 'NOT_OWNER' | 'UNAVAILABLE' | 'MOVING' }
  | { kind: 'MOVED'; slot: string; generation: number }
  | { kind: 'STALE_EPOCH' }                             // the adapter's own lease is lost
  | { kind: 'STALE_SENDER'; highest: { generation: number; epoch: number } }
  | { kind: 'MISMATCH'; field: string };                // same identity, different content (§5.2)

interface Classification {
  partnerLinkId: string;
  termsVersion: number;               // catalogue partner-terms version used
  holds: 'with_holds' | 'without_holds';
  maxHoldS: number;                   // partner's maximum hold length, seconds
  acceptsAbsoluteExpiry: boolean;
  sigmaP: number;                     // σ_p, ms (ε + h_s + measured partner clock bound)
  partnerClockBoundMs: number;        // measured partner clock offset bound
  transitMs: number;                  // measured one-way transit, p99.9
  expectedAnswerMs: number;           // p99 partner answer time, from terms (RFC-002 §5.5 step 3)
  expiryGranularityMs: number;        // partner's expiry resolution (1 = exact)
  supportsAmend: boolean;             // S1: from the driver
  decreaseAllowed: boolean;           // shown term: the commercial term (record), checked against supportsAmend (m13)
  supportsFutureCancel: boolean;      // F4: driver can schedule a cancel at a future instant
  cancelLeadMs: number;               // F4: driver lead before effectiveMinute (default 0, est.)
  effectiveFrom: UnixMs }             // applies to requests whose intake ts ≥ this

// ---- results (adapter → owner, state messages) ----
type PartnerResult =
  | { kind: 'HELD'; attempt: number; partnerExpiry: UnixMs }
  | { kind: 'WAITING'; attempt: number; latestBlockerDeadline: UnixMs }
  | { kind: 'REFUSED'; attempt: number | null;
      reason: 'NO_FIT' | 'HOLD_LAPSED' | 'FENCE_PASSED' | 'TOMBSTONED' | 'PAST_DEADLINE'
            | 'STALE_SENDER' | 'IN_FLIGHT';            // F12: NOT_SENT_LATE is not a result
      retryAfter?: UnixMs }                            // with IN_FLIGHT (m6)
  | { kind: 'FAILED'; attempt: number | null;
      reason: 'partner_fault' | 'unclassifiable_answer' | 'expiry_mismatch' }
  | { kind: 'CONFIRMED'; attempt: number; partnerBookingRef: string; sendTime: UnixMs }
  | { kind: 'BOOKED'; attempt: number; partnerBookingRef: string; sendTime: UnixMs }   // book_final
  | { kind: 'NOT_BOOKED'; attempt: number }           // F10: final only after the release or second query
  | { kind: 'RELEASED' }
  | { kind: 'CANCELLED'; cancelId: string; partnerBookingRefs: string[] }              // F3
  | { kind: 'CHANGED'; changeId: string; partnerBookingRefs: string[];
      superseded: boolean }                            // F5
  | { kind: 'CHANGE_FAULT'; changeId: string; partnerBookingRef: string }              // F5: amend NOT_ALLOWED, Share's cost
  | { kind: 'RESUMED'; journal: PartnerLegJournalView[] };

/** F9: a result's identity is either request-scoped or reservation-scoped. */
type ResultIdentity =
  | { scope: 'request'; request: PartnerRequestId; leg: LegRef | null;   // null for release
      attempt: number | null;
      operation: 'hold' | 'confirm' | 'book_final' | 'release' | 'outcome' | 'yield' | 'resume_query' }
  | { scope: 'reservation'; reservationId: string; leg: LegRef;
      operation: 'cancel' | 'change'; id: string };                       // cancelId or changeId

interface PartnerResultMsg {
  adapter: { partnerLinkId: string; generation: number; epoch: number };
  identity: ResultIdentity;
  result: PartnerResult;
  adapterSeq: number }                // adapter partition sequence; within one identity the highest wins

interface YieldRequestMsg { adapter: PartnerResultMsg['adapter']; request: PartnerRequestId;
                            leg: LegRef; attempt: number; olderRequest: PartnerRequestId }   // m1

/** m4: outcome and expiry port, partner binding. */
interface ExpireIfUndecidedMsg { adapter: PartnerResultMsg['adapter']; request: PartnerRequestId;
                                 deadline: UnixMs }          // identity (request, 'expire')
type ExpireAnswer =
  | { kind: 'confirmed'; decisionTime: UnixMs; reservationId: string;
      legs: { leg: LegRef; attempt: number; partId: string }[] }   // applied as outcome_confirmed
  | { kind: 'not_confirmed'; deadline: UnixMs };                    // applied as release

interface PartnerLegJournalView {    // answer to resume_query
  leg: LegRef; attempt: number;
  status: 'none' | 'hold_sent' | 'held' | 'waiting' | 'confirm_sent' | 'final_sent'
        | 'querying' | 'partner_booked' | 'confirmed' | 'releasing' | 'released'
        | 'refused' | 'not_booked' | 'amending' | 'cancel_scheduled' | 'cancelling' | 'cancelled';
  sendTime: UnixMs | null; partnerBookingRef: string | null;
  tombstonedUntil: UnixMs | null;
  highestOwnerStamp: { generation: number; epoch: number } }   // per account partition (F7)

interface PartnerPort {               // implemented by every partner adapter
  classify(c: ClassifyCmd): Promise<Classification>;
  hold(c: HoldCmd): Promise<CommandReply>;
  confirm(c: ConfirmCmd): Promise<CommandReply>;
  bookFinal(c: BookFinalCmd): Promise<CommandReply>;
  release(c: ReleaseCmd): Promise<CommandReply>;
  outcomeConfirmed(c: OutcomeConfirmedCmd): Promise<CommandReply>;
  cancel(c: CancelCmd): Promise<CommandReply>;
  change(c: ChangeCmd): Promise<CommandReply>;
  markWaiting(c: MarkWaitingCmd): Promise<CommandReply>;
  yieldAnswer(c: YieldAnswerCmd): Promise<CommandReply>;
  resumeQuery(c: ResumeQueryCmd): Promise<CommandReply>;
}
```

`release` and `outcomeConfirmed` are the partner adapter's binding of the outcome and expiry
port (RFC-000 §8): the outcome notice "confirmed", and the request-scoped release with `D`.
`markWaiting` and `yieldAnswer` are its binding of the waiting hints and yield answers
(RFC-002 §13.1, outcome and expiry port row). `ExpireIfUndecidedMsg` is its binding of the
expiry request.

### 2.2 Partner driver interface (adapter → driver; every driver implements it)

```ts
type PartnerKey = string;   // §5.3: lowercase hex SHA-256, ≥ 128 bits after any truncation

type DriverAnswer<T> =
  | { class: 'success'; value: T }
  | { class: 'definite_refusal'; code: 'NO_FIT' | 'UNKNOWN_HOLD' | 'NOT_FOUND' | 'NOT_ALLOWED' }
  | { class: 'transient'; code: 'BUSY' | 'RATE_LIMITED' | 'SERVER_ERROR_BEFORE_WORK' | 'CONNECT_FAILED'; retryAfterMs?: number }
  | { class: 'unknown'; code: 'TIMEOUT' | 'CONNECTION_LOST_AFTER_SEND' | 'UNPARSEABLE' };

interface PartnerBookingState {
  key: PartnerKey | null; partnerBookingRef: string | null;
  state: 'absent' | 'held' | 'booked' | 'released' | 'cancelled' | 'lapsed';
  rate: Mbps | null; window: Window | null; expiresAt: UnixMs | null }

interface PartnerDriver {
  readonly partnerLinkId: string;
  capabilities(): { holds: boolean; acceptsAbsoluteExpiry: boolean; maxHoldS: number;
                    expiryGranularityMs: number; supportsAmend: boolean;
                    supportsFutureCancel: boolean; maxKeyBytes: number; callTimeoutMs: number };
  hold(key: PartnerKey, ref: string, rate: Mbps, window: Window, expiresAt: UnixMs, deadlineMs: number)
    : Promise<DriverAnswer<{ partnerExpiry: UnixMs; partnerHoldRef: string }>>;
  confirm(key: PartnerKey, partnerHoldRef: string, deadlineMs: number)
    : Promise<DriverAnswer<{ partnerBookingRef: string }>>;
  bookFinal(key: PartnerKey, ref: string, rate: Mbps, window: Window, deadlineMs: number)
    : Promise<DriverAnswer<{ partnerBookingRef: string }>>;
  release(key: PartnerKey, partnerHoldRef: string, deadlineMs: number): Promise<DriverAnswer<void>>;
  cancel(key: PartnerKey, partnerBookingRef: string, deadlineMs: number,
         effectiveAt?: UnixMs)                                  // F4: only if supportsFutureCancel
    : Promise<DriverAnswer<void>>;
  amend?(key: PartnerKey, partnerBookingRef: string,
         change: { newEnd: UnixMinute } | { fromMinute: UnixMinute; newRate: Mbps },
         deadlineMs: number)
    : Promise<DriverAnswer<void>>;                              // S1: present if and only if supportsAmend
  query(key: PartnerKey, deadlineMs: number): Promise<DriverAnswer<PartnerBookingState>>;
  queryRef(partnerBookingRef: string, deadlineMs: number): Promise<DriverAnswer<PartnerBookingState>>;
  listDay(dayUtc: string /* YYYY-MM-DD */, deadlineMs: number)
    : AsyncIterable<PartnerBookingState>;                       // daily reconciliation listing
  onCallbackHint(handler: (hint: { key?: PartnerKey; partnerBookingRef?: string }) => void): void;
}
```

A driver does none of the following: retry, decide, read the clock for a fence, or write
Share state. It maps one call to the partner and classifies the answer (RFC-002 §10.2). That
classification into the four classes is the driver's whole contract; an answer it cannot
classify is `unknown/UNPARSEABLE`.

Callbacks are verified by the partner's scheme and passed to the adapter only as hints
(RFC-005 §8.2). The adapter **coalesces hints per key and rate-limits them per partner**:
at most one re-query per key per 5 s (est.), within a per-partner re-query budget (m14).

### 2.3 Partner reconciliation feed (Kafka)

Topic `partner.reconciliation.v1`, key = `partnerLinkId`. Value: an encrypted payload as
RFC-006 §5 defines, with its schema in the registry.

```ts
interface ReconciliationEvent {
  header: { partnerLinkId: string; generation: number; epoch: number;
            stream: 'reconciliation'; streamSeq: number;    // contiguous per partner link
            committedAt: UnixMs };
  body:
    | { kind: 'MISMATCH';
        day: string;                         // UTC day D in which it was first found, YYYY-MM-DD
        partnerBookingRef: string;           // identity (Share's recorded ref for SHARE_ONLY)
        mismatch: 'PARTNER_ONLY'             // a ref unknown to the journal, or of a tombstoned request (F13)
                | 'SHARE_ONLY'               // a Share reservation leg booking the partner lacks
                | 'PARTNER_SHORT'            // both have it; the partner has less rate or a shorter window (F14)
                | 'PARTNER_EXCESS';          // both have it; the partner has more (F14)
        share: { accountPartition: string; reservationId: string | null;
                 request: PartnerRequestId | null; leg: LegRef; partId: string | null } | null;
        partner: { rate: Mbps | null; window: Window | null; state: PartnerBookingState['state'] } | null;
        action: 'CANCEL_AT_SHARE_COST'       // PARTNER_ONLY (POL-23, POL-28)
              | 'MARK_LEG_AFFECTED'          // SHARE_ONLY, PARTNER_SHORT → partner_leg_affected (§3.4)
              | 'REDRIVE_AT_SHARE_COST';     // PARTNER_EXCESS: outstanding amend or cancel re-driven, alerted
        cancelId: string | null }            // = hash(partnerLinkId, ref) for PARTNER_ONLY (F13)
    | { kind: 'DEFERRED'; day: string; partnerBookingRef: string;
        journalStatus: PartnerLegJournalView['status'] }     // F13: work in flight; re-checked once it resolves
    | { kind: 'RUN_COMPLETED'; day: string; bookingsCompared: number; mismatches: number;
        deferred: number; partial: boolean;                  // m11: a partial run publishes what it compared
        completedAt: UnixMs } };
```

Identities:

- `MISMATCH`: (partner link, partner booking reference). The identity is **across days**
  (F13): one action per ref, whichever day finds it first.
- `DEFERRED`: (partner link, day, ref).
- `RUN_COMPLETED`: (partner link, day).

The feed carries no buyer identity, no principal and no personal data (A11, POL-33).
`accountPartition` and `reservationId` are internal pseudonymous identifiers.

### 2.4 Equivalent-path source (routing → RFC-002)

```ts
interface EquivalentPathQuery {
  correlationId: string;                              // opaque; no reservation id leaves Share (m9)
  routeId: string;                                    // current catalogue route
  legs: string[];                                     // current link ids, in order
  affectedLinkId: string; reductionId: string;
  pieces: { fromMinute: UnixMinute; end: UnixMinute | null; rate: Mbps }[];   // offer parts (RFC-002 §9.6)
  excludeRouteIds: string[] }                         // paths already offered or failed (P1-S61)

interface EquivalentPathCandidate {
  routeId: string;                                    // a catalogue route (RFC-003 §6.1)
  legs: { linkId: string; kind: 'share' | 'partner' }[];
  allShare: boolean;
  weightsVersion: number }                            // split-weights version routing saw

interface EquivalentPathSource {
  candidates(q: EquivalentPathQuery): Promise<EquivalentPathCandidate[]>;   // all-Share first
}
```

## 3. Semantics per operation

Notation as RFC-002 §1.3:

- `D`: the deadline. `D_c`: the commit fence, `D − commit_margin` with a partner leg.
- `σ_p`: the partner-skew budget. `h_s`: the adapter's commit-to-send bound (est. 20 ms,
  measured at p99.9 from commit callback to socket write).
- `τ`: the confirm fence offset (about 420 ms, est.). `release_grace`: 1 min.
  `commit_margin`: 10 s.

### 3.1 Common to every command

The adapter checks the following in its own partition, in the same log entry as the effect.

1. **Stale sender (F7, D3).** The adapter records the highest (generation, epoch) **per
   account partition**. Every accepted command updates it, and so does J7. Any command
   carrying a lower pair is refused with `STALE_SENDER` and journaled, **except `release`**,
   which only removes and is always applied (RFC-000 §5.2, V-03). J7 (`resume_query`) is
   also kept as an explicit per-request barrier.
2. **Identity.** The identity (§5) is new, or it is the same in content as the recorded one,
   as §5.2 defines sameness. In the second case the recorded reply or result is returned.
   Otherwise the answer is `MISMATCH`.
3. **Lease.** The adapter holds its owner lease. Otherwise it answers `NOT_OWNER`,
   `STALE_EPOCH`, `MOVED` or `MOVING`.

Every partner call is preceded by its committed intent entry (J1…J6, J11 amend) and followed
by its result entry.

**Adapter takeover (F10).** An intent with no result is **unknown**. The new adapter owner
resolves it before reporting anything:

- **J1 (hold):** query by key. If the hold is found, it is reported or released, according
  to the request's state.
- **J2 (confirm):** first send the J4 release of the hold at the partner. A confirm still in
  flight then fails at the partner (`UNKNOWN_HOLD`), which is a fence the partner
  understands. Then query. `NOT_BOOKED` is reported only after the release has been answered
  and the query shows no booking.
- **J3 (final booking), and a `cancel` that has no recorded booking:** query at once, and
  again at `max(D, takeover + callTimeoutMs) + release_grace` (est.). Only the second
  `absent` is final. A booking found after that is a POL-28 residue: the adapter cancels it
  at Share's cost.
- **J4, J5, J11:** re-sent with the same key.

### 3.2 Booking operations

| Operation | Preconditions | Outcomes | Errors and refusals |
|---|---|---|---|
| `classify(partnerLinkId, asOf)` | None | The classification in force at `asOf`, built from the catalogue's partner terms and the onboarding test. **`with_holds`** requires all four: `maxHoldS ≥ route_deadline_max + commit_margin` (70 s); `acceptsAbsoluteExpiry` (POL-26, P2-S36, P2-S102); **`expiryGranularityMs + partnerClockBoundMs + transitMs ≤ commit_margin − τ − 1 s`**; and **`σ_p ≤ σ_p_max`** (500 ms, est.) (F11, D6). A partner failing any of the first three is classified `without_holds` and alerted at onboarding. **`σ_p ≤ σ_p_max` is a listing condition for every partner** (V7): a partner, with or without holds, that fails it is not listed. `decreaseAllowed` is the commercial term, which is the source of record (m13). If that term allows a decrease and the driver cannot amend, **onboarding fails** and alerts. The owner caches classifications by `termsVersion`, refreshed from the catalogue feed. Intake uses the cache and is refused only when no version is cached (m5) | `UNAVAILABLE` if the terms are not loaded |
| Owner intake checks (RFC-002 §3.2, erratum) | — | Rejected at intake: a route with two `without_holds` legs (P2-S34); a deadline for which `D − commit_margin − σ_p ≤` the intake `ts`, so that no confirm could ever be sent (F11 as amended by V7; every listed partner has σ_p ≤ `σ_p_max`, so an 11 s deadline is never rejected, P2-S86); a **decrease** over a partner leg whose terms shown at booking, as recorded on the reservation (RFC-002 E1), do not allow one (P2-S115; V4). `expectedAnswerMs` never rejects: it only triggers RFC-002 §5.5 step 3's parallel send. **A shorten is never rejected for partner reasons** (POL-08 "any time"; F1, D1) | — |
| `hold` | Partner with holds; not tombstoned; the J1 intent's `ts` before `D_c` and before `D` | J1 intent, then driver `hold(expiresAt = D)`. Answers: (a) `HELD(attempt, partnerExpiry)`, with `D − expiryGranularityMs ≤ partnerExpiry ≤ D`. (b) A definite refusal while a Share position overlaps (another Share request holding, or partner-booked and undecided): with `wait = true` the request is registered as a waiter (J9) and the answer is `WAITING(attempt, latest blocker deadline)` (P2-S89, P2-S96); with `wait = false` the answer is `REFUSED(IN_FLIGHT, retryAfter)` with a tombstone and no waiter (m6, as the link does, AI-17-1). (c) A definite refusal with no Share position overlapping: tombstone, `REFUSED(NO_FIT)` (P2-S31). (d) Transient: retried until `D_c`, then `FAILED(partner_fault)`. (e) Unknown: query at once (J6) and follow the answer (P2-S90) | `REFUSED(TOMBSTONED)`, `REFUSED(PAST_DEADLINE)`. A partner expiry outside the bound above: release at once, `FAILED(expiry_mismatch)`, alert |
| `confirm` | Leg `held` at `attempt`; not tombstoned; sender not stale; J2 intent commits with `ts < D_c − σ_p` | J2 intent; its `ts` is the **send time**, the request's begin-committing time (POL-26). The call is sent within `h_s` of that commit. **If the send would leave later than `h_s` (F12):** nothing is sent, the J2 is journaled as not sent, and a **fresh J2 intent** with the same partner key is written, as long as its `ts < D_c − σ_p`. The begin-committing time is the `ts` of the intent actually sent. Late sends are counted and alerted on rate. Answers: `CONFIRMED(attempt, ref, sendTime)`. `UNKNOWN_HOLD` → `REFUSED(HOLD_LAPSED)`. Unknown → query by the same key. Still unknown at the owner's `D − τ` → the owner decides not confirmed and sends `release`; the adapter keeps querying and cancels any booking it later finds, at Share's cost (F6) | `REFUSED(FENCE_PASSED)` (never sent), `REFUSED(TOMBSTONED)`, `STALE_SENDER`, `MISMATCH` (attempt ≠ held attempt) |
| `book_final` | Partner without holds; not tombstoned; J3 intent `ts < D_c − σ_p` | As `confirm`, with J3 and the same F12 rule. `BOOKED(attempt, ref, sendTime)`. A definite refusal gives `WAITING` (or `REFUSED(IN_FLIGHT)` with `wait = false`) if a Share position overlaps, and `REFUSED(NO_FIT)` otherwise. Unknown → query at once, with F10's second query before `NOT_BOOKED` is final (P2-S35) | As `confirm` |
| `release` | Any. Never refused for the epoch | Request-scoped. Every hold of the request at the partner is released (J4) and every waiter registration removed. A tombstone is written until `D + release_grace`. The answer is `RELEASED` once the partner has answered or the hold has lapsed at `D`. **Any partner booking of the request**, found now or later (late answer, query, reconciliation), **is cancelled by the adapter at once, at Share's cost.** The adapter is the only component that cancels a residue (POL-28, V-03, P2-S105; F6, D2) | — |
| `outcome_confirmed` | Leg `partner_booked` at `attempt` | Leg `confirmed` (J8). The booking (partId, ref, window, rate) **joins the reservation-leg booking set** for (reservationId, leg) (F3). Waiters' blockers are resolved and re-asks start (RFC-002 §10.5) | `MISMATCH` (attempt ≠ booked attempt). If the leg is cancelled or not partner-booked: alert (protocol defect) |
| `mark_waiting` | Request known | Hint recorded (J9). It is used only to choose which of Share's own partner holds to ask to yield | — |
| `yield_answer` | A yield request outstanding for (request, leg, attempt) | `accept`: the hold is released at the partner; the adapter waits for the release's answer, then registers the request as a waiter at its own age with a new attempt and answers `WAITING(newAttempt, …)`. `refuse`: no change | `STALE_SENDER` |
| `resume_query` | Any | J7 entry recording the sender's (generation, epoch), for the partition and the request. Answers `RESUMED(journal)` | — |

### 3.3 Reservation-leg operations (after confirmation)

The adapter keeps, per (reservation, leg), a **booking set** {(partId, partnerBookingRef,
window, rate)} (F3). An original booking and each addition (extend, increase, make
open-ended) are separate partner bookings. **Additions** go through `hold`, `confirm` or
`book_final` as a request of their own (S1, P2-S83), with `reservationId` set. Each joins the
set on `outcome_confirmed`.

**Ordering (F5).** The adapter applies `change` and `cancel` for one (reservation, leg)
strictly in `changeSeq` order:

- change n+1 is not sent to the partner until change n is confirmed or superseded;
- a later change, being absolute, supersedes the outstanding parts of an earlier one, which
  then report `CHANGED{superseded: true}`;
- a `cancel` supersedes an outstanding amend with a lower `changeSeq` only for bookings
  whose remaining effect lies at or after the cancel's `effectiveMinute`; those retries stop
  and report `CHANGED{superseded: true}`. Other amends continue (V2);
- a change with a higher `changeSeq` than a scheduled cancel is still applied before the
  cancel's effective minute.

| Operation | Preconditions | Outcomes | Errors and refusals |
|---|---|---|---|
| `cancel` | Booking set known for (reservation, leg) | **Scheduled (F4).** J5 is journaled as a **scheduled cancel** for every booking in the set. The schedule is a timer in the adapter's log, re-armed on takeover and on `adopt`. The driver is called at `effectiveMinute − cancelLeadMs`, or earlier with `cancel(…, effectiveAt)` if `supportsFutureCancel`. Bookings whose window starts at or after `effectiveMinute` are cancelled at once. **One J5 per `partnerBookingRef`** (F6): a cancel for a ref already being cancelled, or cancelled, returns that J5's result, whatever its `cancelId`. **A cancel for a ref whose J5 is still scheduled, with an earlier `effectiveMinute`, moves that J5's effective minute earlier and re-arms its timer. It is never moved later. Its result lists both `cancelId`s** (V1). A cancel is retried until the partner confirms, without bound (P2-S82). `NOT_FOUND`, or a query state of `cancelled` or `absent` for the known ref, counts as confirmed (F5). Answer: `CANCELLED(cancelId, refs)`. The cancel takes effect for the buyer whatever the partner answers (owner side) | `MISMATCH` for an invalid (reason, `costBearer`) pair (table below) |
| `change` (shorten) | Reservation leg `confirmed` | **If `supportsAmend`:** the booking straddling `newEnd` is amended to end at `newEnd` (J11 amend intent and result). Bookings lying wholly at or after `newEnd` are cancelled at once (allowed by S1: nothing is rebooked). Answer: `CHANGED(changeId, refs)`. **Otherwise (D1):** the owner does not send `change`. It writes E11 as for any shorten, and sends `cancel(reason = 'shortened', effectiveMinute = newEnd, costBearer = 'payer_per_terms')`, which is deferred to `newEnd` (F4). For **a shorten to a later end (after `nb(ts)`)**, the buyer pays only a minimum-term fee shown at booking that `newEnd` falls inside (POL-08), and Share bears any plain cancellation fee the partner charges for this cancel, as a cost line (RFC-002 §9.5, POL-23). **A shorten to or before `nb(ts)` is a cancellation** (with or without amend): `cancel(reason = 'buyer_cancel', effectiveMinute = nb(ts), costBearer = 'payer_per_terms')`, and the buyer pays the plain fee shown (POL-08; V5). This is not cancel-and-rebook | A `change` sent for a leg without `supportsAmend` is a protocol defect: alert, nothing sent |
| `change` (decrease) | Reservation leg `confirmed`; shown terms allow a decrease (else rejected at intake, P2-S115); `supportsAmend` | Per part, newest first (last in, first out, POL-08; RFC-002 §9.7's absolute form): if the part's booking started before `fromMinute`, it is amended to `rate` from `fromMinute` (`rate = 0` amends its end to `fromMinute`); if it starts at or after `fromMinute`, `rate = 0` cancels it. Answer: `CHANGED(changeId, refs)` | As above |
| `change` (cause `cut`, m8) | A POL-07 cut on a Share leg of the route | Sent to a partner leg only when `supportsAmend`, at Share's initiative, because it lowers Share's cost. Otherwise nothing is sent, and Share keeps paying for the partner capacity (POL-07, POL-23) | — |
| Amend answers | — | Retried until the partner confirms, without bound. **`NOT_ALLOWED` is terminal**: `CHANGE_FAULT`, alert, Share bears the difference, no retry (F5) | — |

**Valid (reason, `costBearer`) pairs (m16).** The adapter uses `costBearer` only to
classify alerts, notably the "Share-cost cancellation outstanding" alert. It never charges
from it: fees flow on the lifecycle feed.

| Reason | Allowed `costBearer` |
|---|---|
| `moved_off_leg`, `revocation` | `share` |
| `buyer_cancel`, `shortened` | `payer_per_terms`, or `share` (a cancellation after a POL-07 cut) |
| `termination`, `release_after_grace` | `payer_per_terms` |

The residue reasons (withdrawn, displaced, offer failed, unconfirmed) and
`reconciliation_orphan` are the adapter's own (F6). They are not accepted on the port.

### 3.4 Adapter-initiated messages

- **`PartnerResultMsg`**, for every result, re-sent until the owner acknowledges it.
- **`YieldRequestMsg`**, sent when a waiter is older than a blocker whose hold the adapter
  believes waiting (RFC-002 §10.5); re-sent until answered.
- **`ExpireIfUndecidedMsg`**, for a request still undecided at `D` (P2-S53; m4). An answer
  `confirmed` is applied as `outcome_confirmed` for each listed leg. `not_confirmed` is
  applied as `release`.
- **`partner_leg_affected(reservationId, leg, partnerLinkId, delivered, eventIdentity)`**
  (m12, F14, D5), on RFC-002's reservation command port. `delivered` is `null` when the
  partner lacks the booking (SHARE_ONLY). Otherwise it is the partner's `{rate, window}` for
  a PARTNER_SHORT, so that rating charges only what was delivered.
  - The owner writes E14, idempotent by (reservation, leg, partner link). A later event with
    less delivered capacity replaces the recorded one; an equal one is a duplicate.
  - The holder is told (P2-S91). The buyer is never charged for capacity the partner did not
    deliver (POL-23).

**Re-asks.** A blocker resolves when its outcome notice arrives and, if it was not confirmed,
when the partner answers its release or cancel. The adapter then re-asks the partner for its
waiters in `priority_rule` order:

- a waiter's re-ask starts once no older waiter with an overlapping window has one
  outstanding (A0R-08);
- it skips waiters past `D_c − σ_p` less their expected hold time, and waiters that have
  ended;
- a re-ask is a new `hold` call with a new attempt, and its success is sent as
  `HELD(newAttempt)` (P2-S95).

### 3.5 Daily reconciliation (F13, F14, D4, D5, m11)

**When it runs.** The run for UTC day D starts at 00:15 UTC on D + 1 (est.). The driver's
`listDay` is retried within a budget that ends at 11:30 (est.). A partial run publishes what
it compared, with `partial = true`. The operator console alerts at 12:00 UTC on D + 1 if no
`RUN_COMPLETED` has arrived for (partner link, D) (P2-S32).

**What it compares.** "Day D" covers the bookings whose window intersects day D, and those
created, changed or cancelled during it. The listing is compared against **the journal as of
listing time**:

- **Deferred, never actioned.** A ref or key the journal knows in a non-terminal state:
  `hold_sent`, `confirm_sent`, `final_sent`, `querying`, `partner_booked` undecided,
  `amending`, `cancelling`. The run publishes `DEFERRED` and re-checks the ref once its
  work resolves.
- **Scheduled cancels are compared, not deferred (V3).** A ref with a scheduled cancel whose
  driver call has not been sent is compared as `confirmed` for the minutes before its
  `effectiveMinute`. It is deferred only once `cancelling`.
- **`PARTNER_ONLY`.** A ref unknown to the journal, or one belonging to a tombstoned request
  (the latter takes the POL-28 residue path). It is cancelled at Share's cost with
  `cancelId = hash(partnerLinkId, ref)`: one action per ref, across days.
- **`SHARE_ONLY`.** A confirmed booking in the set that the partner lacks. It is sent as
  `partner_leg_affected` with `delivered = null`.
- **`PARTNER_SHORT`.** The partner has a lower rate or a shorter window. It is sent as
  `partner_leg_affected` carrying the partner's figures (D5).
- **`PARTNER_EXCESS`.** The partner has more than the leg's **intended** state: the
  latest change not answered `CHANGE_FAULT`, whether or not the partner has confirmed it
  (V2). The
  outstanding amend or cancel is re-driven at Share's cost; if none is outstanding, a fresh
  amend or cancel to the intended state is sent with `changeId = hash(partnerLinkId, ref,
  day)`. Operations is alerted.

Every mismatch alerts operations.

### 3.6 Equivalent-path source

`candidates` returns paths ordered all-Share first (P1-S58). RFC-002 refuses any candidate
that is not a catalogue route with split weights at the catalogue replica's current version:
it does not offer it, alerts, and tries the next (RFC-002 §9.4, AI-19-2). An empty list means
there is no path: the reservation is cut by the target, as for a declined offer.

## 4. Delivery and ordering

| Message | Delivery | Ordering scope |
|---|---|---|
| Owner → adapter commands | At least once. A command is re-sent with the same identity, with backoff `min(1000, 50·2^n) ms × jitter` (est.), on no answer, `UNAVAILABLE`, `NOT_OWNER`, `MOVED` or `MOVING`, re-routed through the placement cache. Booking commands are re-sent until answered or until the request's expiry (RFC-002 §5.1); `cancel` and `change` until answered, without bound | **Booking commands:** the owner sends `confirm` only after `HELD`, and `outcome_confirmed` only after `CONFIRMED`/`BOOKED`. The adapter enforces the leg state machine (RFC-002 §10.3), so a reordered command is refused or deferred, never misapplied. **`change` and `cancel`:** applied strictly in `changeSeq` order per (reservation, leg) (§3.3) |
| Adapter → owner `PartnerResultMsg`, `YieldRequestMsg`, `ExpireIfUndecidedMsg`, `partner_leg_affected` | At least once (gRPC push, Kafka relay). These are idempotent state messages, identified by `ResultIdentity` (F9) or their own identity. There is no high-water rule across identities; within one identity the highest `adapterSeq` wins | The owner recovers a lost result by re-sending the outstanding command (a duplicate returns `RESULT`) every 5 s (est.) while the leg is outstanding, and by `resume_query` on takeover |
| Partner calls (driver) | At least once at the partner; exactly-once effect by the partner key (P2 C7, P2-S28) | **Per (request, leg):** hold → confirm. A release may overtake an in-flight confirm; F10 governs what is reported. **Per (reservation, leg):** amends and cancels in `changeSeq` order |
| Reconciliation feed | At least once, exactly-once effect by identity | Ordered per partner link by `streamSeq`. Consumers wait on a gap (RFC-000 §4.4) |
| Equivalent-path source | Synchronous; RFC-002 retries | — |

## 5. Idempotency

### 5.1 Keys

| Input | Key | Duplicate (same content, §5.2) | Same key, different content | Retention |
|---|---|---|---|---|
| `hold`, `book_final` | (request, leg, operation). The adapter assigns the attempt | Returns the recorded reply or result; no second partner call | `MISMATCH`, alert; nothing changes | Life of the request + 24 h |
| `confirm`, `outcome_confirmed`, `yield_answer` | (request, leg, operation, attempt) | As above | `MISMATCH` | Life of the request + 24 h |
| `release` | (request): request-scoped, no attempt | No-op; answers `RELEASED`, or the state in progress | Not applicable (`reason` and `decisionTime` are not compared) | Tombstone until `D + release_grace`; record for the life of the request + 24 h |
| `cancel` | (reservation, leg, `cancelId`). At the partner, one J5 per ref (§3.3) | Recorded result | `MISMATCH` | 7 years with the partner booking record |
| `change` | (reservation, leg, `changeId`) | Recorded result | `MISMATCH` | 7 years |
| `resume_query` | (request, generation, epoch) | Same journal answer | — | Life of the request + 24 h |
| `ExpireIfUndecidedMsg` | (request, 'expire') | Same answer | — | Life of the request + 24 h |
| `partner_leg_affected` | (reservation, leg, partner link) | No new E14 | Less delivered capacity replaces the record; more is ignored and alerted | Life of the reservation |
| Reconciliation event | `MISMATCH`: (partner link, ref), across days. `DEFERRED`: (partner link, day, ref). `RUN_COMPLETED`: (partner link, day) | Consumers drop it | Not produced: a re-run reuses the recorded mismatches | Until consumed and checkpointed |
| Equivalent-path query | None (a read) | — | — | — |

### 5.2 Sameness (F8)

Only the listed fields are compared. **`stamp` is never compared**, so a new owner's
re-send at a higher (generation, epoch) returns the recorded result. Neither is
`decisionTime`.

| Command | Fields compared |
|---|---|
| `hold` | leg, rate, window, `expiresAt`, `requestAge`, `requestAgeTiebreak`, `commitFence`, `wait`, `opaqueRef`, `reservationId` |
| `book_final` | As `hold`, with `deadline` in place of `expiresAt` |
| `confirm` | leg, attempt |
| `outcome_confirmed` | leg, attempt, `reservationId`, `partId` |
| `release` | request only (`reason` and `deadline` are recorded, not compared) |
| `cancel` | `changeSeq`, reason, `costBearer`, `effectiveMinute` |
| `change` | `changeSeq`, cause, change |
| `yield_answer` | leg, attempt, answer |
| `mark_waiting` | Not compared: the latest `accountLogPosition` wins |

### 5.3 Partner keys (m3)

**Encoding.** A partner key is the SHA-256, in lowercase hex, of the **canonical JSON** of a
key object: keys sorted, no whitespace, UTF-8, no escaping of non-ASCII. Ids are therefore
quoted strings, and `|` or any other character inside an id is safe. A driver may truncate
the key to `maxKeyBytes` only if at least 128 bits remain; otherwise onboarding fails.

**Which key each operation uses.**

| Operation | Key object |
|---|---|
| hold, confirm, book final, release | `{"v":1,"req":<PartnerRequestId>,"leg":<LegRef>,"op":<op>,"attempt":<n>}`. A confirm uses the attempt of the hold it confirms; a release uses the attempt of the hold it releases |
| cancel | `{"v":1,"ref":<partnerBookingRef>,"op":"cancel","id":<cancelId>}` |
| amend | `{"v":1,"ref":<partnerBookingRef>,"op":"amend","id":<changeId>}` |

**Test vectors** (each driver and the adapter must reproduce them):

| Key object (canonical) | Key |
|---|---|
| `{"attempt":1,"leg":{"legIndex":2,"partnerLinkId":"P-DJI-MRS"},"op":"hold","req":{"kind":"booking","requestId":"acct-0042:118"},"v":1}` | `47cd8ac9b2a5b00675e74caa65a60c123229824f0ccc4c3b5ee4078146d8d787` |
| `{"attempt":2,"leg":{"legIndex":1,"partnerLinkId":"P-DJI-MRS"},"op":"confirm","req":{"kind":"offer","offerId":"off-3","reservationId":"res-77"},"v":1}` | `1615c26143f7f5f10874b75cca5a6dd067f9f76d294cda05b94fdc02d22ec16a` |
| `{"id":"c-1","op":"cancel","ref":"PB-9\|x","v":1}` | `34aa3bfd12dba624821e6ee130a5fe78e3ac83199005cc5c42a6289f83332df8` |

In the third row, `\|` is a Markdown escape: the reference is the five characters `PB-9|x`.

**Duplicates and retention.** The partner returns the original result for a reused key
(P2 C7). A partner answering a reused key with another booking is a driver defect:
`FAILED(unclassifiable_answer)` and an alert. Keys are kept for 7 years with the partner
booking record (RFC-000 §4.4).

## 6. Ownership

| Data | Writer | Readers |
|---|---|---|
| Adapter log: state, call journal J1…J11, booking sets, scheduled cancels, waiter queue, tombstones, per-partition sender high-water, reconciliation | The adapter holding the partner link partition's owner lease, and only it, in epoch-conditional batches (RFC-000 A1, §5.2) | The adapter; history (RFC-006) from archived segments. No other component reads it. The owner learns state only through results and `resume_query` |
| Partner credentials | Secrets service; used only by the driver (RFC-005 §8.2, §10) | The adapter process |
| Partner leg status in the reservation (E5, E14) | The account owner | As RFC-002 |
| Partner terms, including `decreaseAllowed` (the source of record, m13) | Catalogue, by a commercial operator (RFC-003 §6.1, POL-32; X1-S31 audits the action) | Adapter, owner (via the classification cache) |
| Residue cancellation (POL-28) | The adapter alone (D2) | — |
| Reconciliation feed | Adapter's outbox | Operator console, notifier |
| Equivalent paths | Routing (out of scope). The route and its weights are registered in the catalogue first (RFC-003 §6.1) | RFC-002 only |

**What the partner may see (m2).** The partner sees the `opaqueRef`, the rate and the window,
and never the account, principal or buyer identity (POL-33). The owner supplies `opaqueRef`,
stable per (reservation, leg):

`HMAC-SHA-256(partner_ref_key, origin request id | legIndex | partnerLinkId)`

The origin is the reservation's originating booking request. It is reused for every
addition, and for an offer booking on that partner link and leg. One reservation therefore
shows one reference per partner leg.

## 7. Timeouts and deadlines

| Bound | Value | Applies to |
|---|---|---|
| Port RPC deadline (owner → adapter) | 1,000 ms (est., `partner_port_rpc_ms`) | Each command. On expiry it is re-sent with the same identity, with backoff `min(1000, 50·2^n)` ms × jitter (est.) |
| Driver call timeout | `callTimeoutMs` per partner (from the terms; default 2,000 ms, est.), never beyond the operation's fence | Each partner call. A timeout after sending is `unknown` → query at once |
| Hold retry fence | `D_c` | Transient hold answers are retried with exponential backoff and jitter (base 50 ms, cap 1 s, est.). Still failing at the fence → `FAILED(partner_fault)` (P2-S30, P2-S62) |
| Confirm / final booking fence | The J2/J3 intent `ts < D_c − σ_p`, sent within `h_s` (20 ms, est., p99.9) of its commit. A late send is re-journaled while the fence allows (F12) | P2-S55, P2-S109 |
| `σ_p_max` | 500 ms (est.; D6) | Listing condition for **every** partner (V7) |
| Expiry granularity bound | `expiryGranularityMs + partnerClockBoundMs + transitMs ≤ commit_margin − τ − 1 s` (about 8.58 s, est.; F11) | Listing condition for `with_holds` |
| Owner's confirm wait | Until `D − τ`. The partner has at least `commit_margin − τ` (about 9.58 s, est.) | After it, the owner decides not confirmed and sends `release` |
| Partner hold expiry | `D`, at the partner's granularity, never later, and no earlier than `D − expiryGranularityMs` | P2-S100, P2-S101 |
| Query after unknown | At once, then backoff (cap 5 s, est.) until a definite answer; no bound. On takeover, the second query of F10 at `max(D, takeover + callTimeoutMs) + release_grace` (est.) | P2-S90. Alert if unknown past `D − τ` |
| Scheduled cancel | The driver is called at `effectiveMinute − cancelLeadMs` (default 0, est.), or earlier with `effectiveAt` if `supportsFutureCancel` (F4) | Revocation at `T_eff`, termination, release after grace, buyer cancel at `nb(ts)`, shorten without amend at `newEnd` |
| Cancel / amend retries | Until the partner confirms, no bound. Alert while a Share-cost cancellation is outstanding, past 5 min (est.) | P2-S82, P2-S105 |
| Callback hint re-queries | At most one per key per 5 s (est.), within a per-partner budget (m14) | RFC-005 §8.2 |
| Daily reconciliation | Starts 00:15 UTC on D + 1 (est.); listing retries until 11:30 (est.); every `MISMATCH` and the `RUN_COMPLETED` committed by 12:00 UTC on D + 1; console alert if `RUN_COMPLETED` is missing at 12:00 (m11) | P2-S32 |
| Tombstones | Until `D + release_grace` | Refuse a late hold, confirm or final booking |
| `move_deadline` (offer booking) | `D` = acceptance `ts` + 60 s (est., RFC-002 §9.6; = `route_deadline_max`), `D_c = D − commit_margin` | RFC-002 §9.6 |
| Equivalent-path query | 2,000 ms (est.). On failure, retried with backoff (cap 30 s, est.) and alerted after 3 failures (est.). No offer is made while it fails | RFC-002 §9.6 |

## 8. Versioning and compatibility

- **Versions.** The port's gRPC package and the topic carry a major version (`partner.v1`,
  `partner.reconciliation.v1`).
  - **Minor:** additive changes, meaning new optional fields, or new enum values that
    receivers map to "unknown, alert, treat as no answer".
  - **Major:** anything that changes an identity, a sameness rule, a fence, the partner-key
    encoding or the meaning of a result. A major change needs a new contract version, with
    both sides' C3 RFCs revised.
- **Partner keys** are frozen for 7 years per booking. The `"v":1` field names the
  encoding; a new encoding uses a new `v`, and old keys stay queryable.
- **Reconciliation event schemas** are kept in the schema registry for 7 years (RFC-006 §5).
- **Drivers** are versioned independently. A driver change that alters answer
  classification, `supportsAmend` or `supportsFutureCancel` re-runs the driver conformance
  suite (§10.3) and re-classification before deployment. A capability that would disagree
  with the commercial `decreaseAllowed` blocks the deployment (m13). **A driver change
  removing `supportsAmend` is blocked while any live reservation on the link has a shown
  term allowing a decrease** (V4).
- **Classification changes** apply only to requests whose intake `ts ≥ effectiveFrom`.

## 9. Scenarios relied on

All IDs at `requirements-v1.10`:

- P2-S03, P2-S13, P2-S14, P2-S28, P2-S29, P2-S30, P2-S31, P2-S32, P2-S33, P2-S34, P2-S35,
  P2-S36, P2-S37, P2-S43, P2-S44, P2-S48, P2-S50, P2-S53, P2-S55, P2-S57, P2-S62, P2-S82,
  P2-S83, P2-S85, P2-S86, P2-S89, P2-S90, P2-S91, P2-S93, P2-S94, P2-S95, P2-S96, P2-S100,
  P2-S101, P2-S102, P2-S105, P2-S109, P2-S115;
- P1-S58, P1-S59, P1-S60, P1-S61.

## 10. Conformance tests

### 10.1 Adapter (provider of the partner port), against a scripted fake driver

1. **Fence.** A `confirm` whose J2 intent would commit at `D_c − σ_p` is refused `FENCE_PASSED`, and the fake driver records no call. One at `D_c − σ_p − 1 ms` is sent (P2-S55, P2-S109).
2. **Send bound (F12).** A J2 whose send is delayed past `h_s` is journaled as not sent. A fresh J2 with the same key follows while the fence allows, and the request is not failed. Past the fence it gives `FENCE_PASSED`.
3. **Epoch (F7).** After any accepted command at (g, e) for partition A, every command except `release` at (g, e − 1) for partition A is `STALE_SENDER`, journaled and never sent; this includes `cancel` and `change`. `release` at (g, e − 1) still releases.
4. **Tombstone.** After `release`, `hold`, `confirm` and `book_final` for the request are `REFUSED(TOMBSTONED)` until `D + release_grace`.
5. **Expiry.** Every driver `hold` carries `expiresAt = D`. A partner expiry later than `D`, or earlier than `D − expiryGranularityMs`, is released and answered `FAILED(expiry_mismatch)` (P2-S100).
6. **Idempotency (F8).** Any command repeated N times yields one driver call per partner key and the same reply. A re-send at a higher (generation, epoch), with a different `decisionTime`, returns the recorded result. A difference in a compared field is `MISMATCH`. The §5.3 test vectors are reproduced.
7. **Unknown and residue (F6).** A timeout after send triggers an immediate `query` with the same key, and the result follows the query (P2-S90). A booking found for a tombstoned request is cancelled by the adapter itself. A `cancel` for a ref with a J5 already open returns that J5's result, with no second driver cancel.
8. **Transient.** `BUSY` is retried until `D_c` (hold) or `D_c − σ_p` (confirm), never producing `REFUSED` (P2-S30), then gives `FAILED(partner_fault)`.
9. **Contention.** A definite refusal while another Share request's hold overlaps yields `WAITING(latest blocker deadline)`, or `REFUSED(IN_FLIGHT)` with a tombstone and no waiter if `wait = false`. Without an overlap it yields `REFUSED(NO_FIT)` (P2-S31, P2-S89, P2-S96). Re-asks run in priority order, serialised per overlapping pair, skipping waiters past their fence (P2-S95).
10. **Yield.** On `yield_answer(accept)`, the hold is released at the partner before `WAITING(newAttempt)` is sent.
11. **Cancel.** A `cancel` answered transient forever keeps retrying and raises the outstanding-cancellation alert (P2-S82). `NOT_FOUND` for a known ref counts as cancelled.
12. **Booking set (F3).** Base booking plus one extension, then a shorten into the base window: the extension is cancelled and the base amended. Then a cancel: every remaining booking is cancelled, and `CANCELLED` lists all refs. A decrease reduces the newest part first.
13. **Deferred cancel (F4, V1).** A revocation with `effectiveMinute` = `T_eff` + 2 days sends no driver call before `T_eff − cancelLeadMs`. If a buyer cancel then arrives, the driver is called at `nb(ts) − cancelLeadMs`, and the result lists both `cancelId`s; a later cancel with a later minute never postpones it. The timer survives takeover and `adopt`. A shorten over a non-amend partner cancels at `newEnd`, not before (D1).
14. **Change order (F5).** Change 1 (shorten to 14:00) is answered unknown while change 2 (shorten to 12:00) is issued: the partner never ends at 14:00 after 12:00 is confirmed. A deferred cancel supersedes an outstanding amend only where the amend's remaining effect lies at or after the cancel's minute; a decrease effective earlier continues (V2). `NOT_ALLOWED` on an amend gives `CHANGE_FAULT` with no retry.
15. **Takeover (F10).** Pause the adapter between the `h_s` check and the send, then take over. The new owner releases the hold before reporting `NOT_BOOKED`, and a confirm landing later fails at the fake partner. For `book_final`, `NOT_BOOKED` comes only after the second query, and a late booking is cancelled at Share's cost.
16. **Chaos (P2-S28).** The fake driver fails before work, times out after work and is slow, at random. Run any interleaving of commands, adapter crashes and lease moves. After daily reconciliation, Share's records equal the fake partner's.
17. **Reconciliation (F13, F14, m11).** Seeded PARTNER_ONLY and SHARE_ONLY differences produce one `MISMATCH` each, with the right action. A booking of an undecided request created at 23:59:50 is `DEFERRED`, never cancelled. A booking with a scheduled cancel not yet sent, which the partner has reduced, gives PARTNER_SHORT (V3). A decrease not superseded and not yet applied by the partner, found with the higher rate, gives PARTNER_EXCESS against the intended state (V2). The same ref mismatching on D and D + 1 produces one action. PARTNER_SHORT produces `partner_leg_affected` carrying the partner's figures; PARTNER_EXCESS re-drives the amend. `RUN_COMPLETED` arrives before 12:00 UTC on D + 1, or the console alerts (P2-S32, P2-S91).
18. **Classification (F11, m13).** A partner with minute expiry granularity, or with σ_p > 500 ms, is classified `without_holds`. A commercial `decreaseAllowed = true` with a driver lacking `amend` fails onboarding.

### 10.2 Account owner (consumer of the partner port), against a fake adapter

1. A route is never confirmed unless every partner leg answered `CONFIRMED` or `BOOKED` (P2-S03, P2-S29).
2. `book_final` is sent only after every other leg is held, the funds hold is taken and Share's checks have passed. Two `without_holds` legs are rejected at intake (P2-S33, P2-S34). A deadline for which `D − commit_margin − σ_p ≤` intake `ts` is rejected. An 11 s deadline is accepted at every listed partner (P2-S86; V7).
3. Results are applied idempotently by `ResultIdentity`, including reservation-scoped results (F9). A lost result is recovered by re-sending the command. `STALE_SENDER` deposes the owner.
4. A `CONFIRMED` arriving after the owner's `D − τ` leads the owner to send **`release`** and nothing else. The adapter cancels the booking (P2-S105, R17; F6).
5. `HoldCmd.wait = false` is sent for such requests. A `REFUSED(IN_FLIGHT)` gives E7 rejected with `retry_after`.
6. A `partner_leg_affected` produces exactly one E14 for (reservation, leg, partner link). A PARTNER_SHORT records the delivered rate and window, so the buyer is not charged for the shortfall (P2-S91; D5).
7. Offer acceptance with a partner leg uses `request = {kind: 'offer'}`, `D` = acceptance `ts` + 60 s. A failure releases the offer holds and offers the next candidate (P1-S60, P1-S61).
8. **Decrease and shorten (S1, D1).** A decrease over a partner leg whose terms shown at booking (recorded on the reservation) forbid one is rejected at intake, stating the rule, whatever the current terms say (P2-S115; V4). A shorten over any partner leg is accepted (P2-S44, P2-S85, P2-S94): with amend it sends `change`; without amend it sends `cancel(reason = 'shortened', effectiveMinute = newEnd)`. A shorten to or before `nb(ts)` sends `cancel(reason = 'buyer_cancel', effectiveMinute = nb(ts), costBearer = 'payer_per_terms')` (V5). Neither path ever sends a new booking.
9. `cancel` and `change` carry `changeSeq` equal to their E11's log sequence, and a valid (reason, `costBearer`) pair. A buyer cancel carries `effectiveMinute = nb(ts)` (P2-S43).

### 10.3 Driver conformance suite (every driver, against the partner's sandbox)

The suite checks that:

- each documented partner answer is classified into the right one of the four classes;
- reusing a key returns the original result;
- `hold` honours an absolute expiry to the declared granularity, and that granularity is
  measured;
- `query` finds every booking made under a key, and `queryRef` finds every booking by its
  ref;
- `listDay` returns every booking of the day;
- `amend` is present exactly when `supportsAmend` is advertised, and changes the booking in
  place;
- `cancel(…, effectiveAt)` is honoured exactly when `supportsFutureCancel` is advertised;
- callbacks reach the adapter only as hints, coalesced;
- the §5.3 test vectors are reproduced.

The `classify` result is computed from these measurements and the catalogue terms (P2-S36,
P2-S102).

### 10.4 Equivalent-path source

A candidate not registered in the catalogue, or without split weights, is refused and
alerted, and the next candidate is tried. All-Share candidates are offered first (P1-S58,
P1-S59). The query carries no reservation id.

## Settled

There are no open mismatches. The orchestrator's settlement is binding, and review 38's D1
amends it.

### S1 (was M1): how a booked partner leg is changed

**Between:** the RFC-000 §8 partner port row, and RFC-002 §13.1, §9.3 and §10.2.

**Disagreement:**

- RFC-000 §8 lists no change operation.
- RFC-002 §13.1's `change(reservation leg, added part)` contradicts §9.3, which makes
  additions by hold and confirm.
- §9.3 requires a partner change on a decrease, and says nothing about a shorten.
- The driver has no amend operation.

**Settlement.**

- **Additions** (extend, increase, make open-ended) go through `hold`, `confirm` or
  `book_final` as a request of their own. Each addition is a separate booking in the leg's
  booking set (P2-S83, F3).
- **Decrease** uses `change` → the driver's `amend`, retried until the partner confirms. It
  is applied newest part first. Where the partner's terms shown at booking, as recorded on the
  reservation (RFC-002 E1), forbid a decrease, it is rejected at intake (P2-S115; V4). The
  shown term is the commercial `decreaseAllowed` at booking. Onboarding fails if that term
  allows a decrease the driver cannot amend, and a driver cannot drop amend while a live
  reservation's shown term allows a decrease.
- **Shorten** is **always accepted** (POL-08 "any time"; review 38 D1, which overrides the
  first settlement's rejection). With `supportsAmend`, it uses `change` → `amend`. Without
  it, the owner sends a cancel at the partner deferred to `newEnd`. For a shorten to a later
  end (after `nb(ts)`), the buyer pays only a minimum-term fee shown at booking that
  `newEnd` falls inside, and Share bears any plain cancellation fee as a cost line. A
  shorten to or before `nb(ts)` is a cancellation: `cancel(reason = 'buyer_cancel',
  effectiveMinute = nb(ts), costBearer = 'payer_per_terms')`, and the buyer pays the plain
  fee shown (POL-08; V5).
- **Never** cancel-and-rebook at Share's risk.

**Consumer obligations (errata), F2:**

| Document | Erratum |
|---|---|
| RFC-000 §8 (AR-1) | Add `change` (shorten or decrease, through the driver's amend). Add the binding sentence for `outcome_confirmed`, `mark_waiting`, `yield_answer` and `expire_if_undecided`. Record that the account owner receives `partner_leg_affected` on the reservation command port. Erratum 4.5 |
| RFC-000 V-03 and §8 (AR-2) | Reword the fence: "the J2/J3 intent's commit `ts` before `D − commit_margin − σ_p`, sent within `h_s`" |
| RFC-002 §3.2 | Intake: reject a decrease where `decreaseAllowed = false`. Never reject a shorten for partner reasons. Apply F11's deadline rule |
| RFC-002 §9.3 | The shorten row covers both paths (amend, or cancel deferred to `newEnd`). The decrease row uses the partner's amend. Additions are requests of their own |
| RFC-002 §9.5, §13.1 lifecycle feed | "Partner terms shown": the decrease-allowed flag is the commercial term, consistent with `supportsAmend`. A plain fee on a shorten without amend is Share's cost line |
| RFC-002 §10.1 | Journal kind **J11 amend intent / result**. The booking set, scheduled cancels and the per-partition sender high-water become adapter state |
| RFC-002 §10.2 | `amend`, `queryRef` and future-dated `cancel` are driver operations, with `supportsAmend` and `supportsFutureCancel` capabilities |
| RFC-002 §10.3 | Transitions `confirmed → amending → confirmed` and `confirmed → cancel_scheduled → cancelling → cancelled` |
| RFC-002 §10.4, §10.6 (AR-3) | Per-partition high-water (F7). Rule for an intent with no result at takeover (F10). Ordering by `changeSeq` (F5). In-flight deferral in reconciliation (F13). `NOT_SENT_LATE` re-journaled (F12) |
| RFC-002 §10.7 | Partner keys for amend and cancel by ref; canonical-JSON encoding (§5.3) |
| RFC-002 §13.1 | `change` carries shorten and decrease, not additions. `outcome_confirmed` carries `partId`. `cancel` is reservation-scoped and has no residue reasons. The reconciliation feed's consumers are the console and notifier |
| RFC-003 §6.1 | Partner terms: "whether a leg can be decreased" must agree with the driver's capability. Onboarding fails otherwise |
| RFC-005 (line 1133; X1-S31) | The commercial action recording "whether a leg can be decreased" remains the source of record. A driver deployment cannot change the shown term |
| RFC-002 E14, §9 input row, §13 (V6 a) | E14 gains `delivered {rate, window} \| null` and the replacement rule (less delivered capacity replaces the record). The "Partner leg affected … Partner reconciliation feed" input becomes `partner_leg_affected` on the reservation command port (m12, D5) |
| RFC-002 §13.1 reconciliation feed (V6 b) | Identity across days, (partner link, ref) (F13). Kinds PARTNER_SHORT, PARTNER_EXCESS, DEFERRED and RUN_COMPLETED added |
| RFC-002 §9.7 (V6 c) | A cut sends `change(cause = 'cut')` to a partner leg with amend (m8); today it covers Share legs only |
| RFC-003 (V6 d) | Rating charges a partner leg marked affected only for the delivered figures (D5). Share's cost line for the plain fee on a shorten to a later end without amend (D1, V5) |
| RFC-006 (V6 e) | Console alert at 12:00 UTC on D + 1 when `RUN_COMPLETED` is missing (m11). The new event kinds for the console and notifier |

### Readings reconciled without a disagreement

None of these blocks Frozen.

- **Confirm fence (m7).** RFC-000 §8 and V-03 word the fence as "the adapter's clock past
  `D − commit_margin` less the partner-skew budget". RFC-002 §10.4 checks the J2/J3 intent's
  commit `ts` against `D_c − σ_p`, plus the `h_s` send bound. The two rules are **not
  equivalent**: RFC-002 permits a send at adapter clock `D_c − σ_p + h_s + ε`, which
  RFC-000's literal rule refuses. They serve the **same purpose**, though: since
  `σ_p ≥ ε + h_s`, the call leaves before `D_c` in true time. RFC-002's rule is adopted, and
  RFC-000's wording takes erratum AR-2.
- **Resume query stamp.** RFC-000 §8 says "owner-lease epoch"; RFC-002 J7 and RFC-000
  AI-R6-3 use (generation, epoch). Adopted: (generation, epoch).
- **Attempt numbering at a partner.** The adapter numbers attempts and returns them in
  `HELD` and `WAITING`, as the link does (RFC-002 JI-1).
- **Equivalent-path source consumers.** RFC-002 is the only consumer (AI-R1-5). RFC-003's
  catalogue registration is a precondition.
- **Gaps filled here, values (est.):**
  - the shape of the port: a command acknowledgement, plus a result message;
  - the bounds on partner expiry;
  - the `RUN_COMPLETED` and `DEFERRED` events;
  - what "day D" covers (§3.5);
  - timeouts.

## Review 38 resolution

All findings are applied. Decisions D1–D6 are adopted as binding.

| Finding | Resolution | Where |
|---|---|---|
| F1 (D1) | A shorten is always accepted. Without amend, it is carried out by a cancel deferred to `newEnd`, with fees as D1 states. Only a decrease may be forbidden | §3.2 intake row, §3.3, S1, §10.2 test 8 |
| F2 | The S1 errata list is completed: RFC-000 §8 and V-03; RFC-002 §3.2, §9.3, §9.5, §10.1–§10.4, §10.6, §10.7, §13.1; RFC-003; RFC-005; and, per fix verification 50 V6, RFC-002 E14 / §9 / §13 (`partner_leg_affected`, `delivered`), §13.1 feed identity and kinds, §9.7 (cut to a partner leg), RFC-003 (rating of delivered figures; Share's plain-fee cost line) and RFC-006 (missing-run alert, event kinds). J11 is added, and `amending` and `cancel_scheduled` statuses | S1 obligations, §2.1, §3.1 |
| F3 | Reservation-leg booking set. `outcome_confirmed` carries `reservationId` and `partId`. `cancel` acts on every booking. `change` is mapped per booking (straddling booking amended, later ones cancelled, last in first out for a decrease). Results list refs | §2.1, §3.3, §10.1 test 12 |
| F4 | `effectiveMinute` is required. Cancels are scheduled in the adapter's log, re-armed on takeover and `adopt`. `supportsFutureCancel` and `cancelLeadMs` added | §2.1, §2.2, §3.3, §7, §10.1 test 13 |
| F5 | `changeSeq` is the E11's log sequence. Changes are applied strictly in order per (reservation, leg); a later absolute change and a cancel supersede. For a cancel, `NOT_FOUND`/`absent` counts as confirmed. For an amend, `NOT_ALLOWED` is terminal | §2.1, §3.3, §4, §10.1 test 14 |
| F6 (D2) | Residue cancellation is the adapter's alone, on `release` or a tombstone. Residue reasons are removed from `CancelCmd`. One J5 per ref | §2.1, §3.2 `release`, §3.3, §6, §10.1 test 7, §10.2 test 4 |
| F7 (D3) | High-water is kept per account partition. J7 is kept. `release` is exempt | §3.1, §10.1 test 3 |
| F8 | Sameness fields defined per command. `stamp` and `decisionTime` are excluded | §5.2, §10.1 test 6 |
| F9 | Result identity is a union: request-scoped or reservation-scoped | §2.1 `ResultIdentity`, §4 |
| F10 | At takeover, an intent with no result is unknown. For J2, release before reporting not-booked. For J3 and a cancel with no booking, a second query before `absent` is final | §3.1, §7, §10.1 test 15 |
| F11 (D6) | Granularity bound and `σ_p_max` = 500 ms (est.) added to `with_holds`. Intake deadline rule added | §3.2, §7, §10.1 test 18, §10.2 test 2 |
| F12 | `NOT_SENT_LATE` is not a result. A fresh intent with the same key is written while within the fence. `h_s` measured at p99.9 | §2.1, §3.2, §10.1 test 2 |
| F13 (D4) | Reconciliation compares against the journal at listing time and defers refs with work in flight. PARTNER_ONLY only for unknown or tombstoned refs. One action per ref across days. E14 idempotent | §2.3, §3.5, §5.1, §10.1 test 17 |
| F14 (D5) | `TERMS_DIFFER` is split. PARTNER_SHORT marks the leg affected with the delivered figures, and the buyer is not charged for the shortfall (POL-23). PARTNER_EXCESS re-drives at Share's cost and alerts | §2.3, §3.4, §3.5, §10.2 test 6 |
| m1 | `leg` added to `YieldAnswerCmd` and `YieldRequestMsg` | §2.1 |
| m2 | `opaqueRef` is owner-supplied: an HMAC of the origin request id, leg and partner link, stable per (reservation, leg) | §6 |
| m3 | Canonical-JSON key encoding, with test vectors | §5.3 |
| m4 | `ExpireIfUndecidedMsg` and its answer, and how the adapter applies them | §2.1, §3.4 |
| m5 | `classify(partnerLinkId, asOf)`. Owner-side cache by `termsVersion`. Intake refused only when nothing is cached | §2.1, §3.2 |
| m6 | `wait` added. With `wait = false`: `REFUSED(IN_FLIGHT, retryAfter)`, a tombstone, no waiter | §2.1, §3.2, §10.2 test 5 |
| m7 | Reading restated as "same purpose; RFC-002's rule adopted". RFC-000 wording erratum AR-2 | Readings reconciled, S1 obligations |
| m8 | `cause` added. A cut reaches a partner leg only with amend | §2.1, §3.3 |
| m9 | Equivalent-path query uses offer pieces and an opaque correlation id | §2.4 |
| m10 | P2-S43, P2-S85, P2-S86 and P2-S94 added (P2-S93 and P2-S101 were already listed) | §9 |
| m11 | Start time, retry budget, partial runs, and a console alert on a missing `RUN_COMPLETED` | §2.3, §3.5, §7 |
| m12 | SHARE_ONLY and PARTNER_SHORT reach the owner as `partner_leg_affected` on the reservation command port, idempotent by (reservation, leg, partner link). The account owner is removed from the feed's consumers | Header, §3.4, §5.1 |
| m13 | The commercial term is the source of record. Onboarding fails, and alerts, if it allows a decrease the driver cannot amend | §3.2, §6, §8 |
| m14 | Callback hints coalesced per key and rate-limited per partner | §2.2, §7 |
| m15 | Unmarked figures marked (est.) or given a source | §7 |
| m16 | `costBearer` is used only to classify alerts. Valid pairs are enforced (`MISMATCH` otherwise) | §3.3 |
| RQ-1 | Resolved by D1; no requirements change | — |
| RQ-2 | **Open with the requirements owner:** extend P2-S91 row 2 to a partner that has the reservation only in part. C12 already behaves this way (D5), so no contract change follows from it | — |
| AR-1, AR-2, AR-3 | Listed as errata | S1 obligations |

## Fix verification 50 resolution

Applied exactly as proposed; C12 frozen at C4.

| Defect | Resolution | Where |
|---|---|---|
| V1 | A later cancel with an earlier minute moves a scheduled J5 earlier and re-arms it; never later; both `cancelId`s listed | §3.3 `cancel`, §10.1 test 13 |
| V2 | A cancel supersedes only amends whose remaining effect lies at or after its minute. PARTNER_EXCESS compares against the intended state | §3.3 Ordering, §3.5, §10.1 tests 14, 17 |
| V3 | A scheduled cancel not yet sent is compared as confirmed before its minute; deferred only once `cancelling` | §3.5, §10.1 test 17 |
| V4 | The decrease check reads the terms shown at booking, recorded on the reservation. A driver cannot drop amend while a live reservation's shown term allows a decrease | §3.2, §8, S1, §10.2 test 8 |
| V5 | Share bears a plain fee only for a shorten to a later end. A shorten to or before `nb(ts)` is a cancellation, and the buyer pays the plain fee shown | §3.3, S1, §10.2 test 8 |
| V6 | Five erratum groups added (RFC-002 E14/§9/§13, §13.1 feed, §9.7; RFC-003; RFC-006) | S1 obligations, F2 row |
| V7 | Intake rejects only when no confirm could ever be sent. `σ_p ≤ σ_p_max` is a listing condition for every partner | §3.2, §7, §10.2 test 2 |
