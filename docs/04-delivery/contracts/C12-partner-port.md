# C12. Partner port, partner driver, partner reconciliation feed and equivalent-path source

| | |
|---|---|
| Contract ID | C12 |
| Version | 1.0 (candidate for freeze) |
| Status | **Draft**, for contract review. No open mismatch: M1 settled by the orchestrator (see "Settled"); RFC-002 §9.3, §10.2 and §13.1 take S1 as errata |
| Provider | **Partner port** and **partner reconciliation feed**: the partner adapters of RFC-002 §10 (Share side; one adapter per partner link, a single-writer owner of the partner link's partition). **Partner driver interface**: each per-partner driver, inside its adapter. **Equivalent-path source**: routing (external input, out of scope) |
| Consumers | Partner port: the account owner's booking module (RFC-002 §5, §9). Partner driver interface: the partner adapter (RFC-002 §10.2); counterparties are the external partner networks, reached only through drivers. Reconciliation feed: operator console, notifier (RFC-006), account owner (writes E14). Equivalent-path source: RFC-002 only (RFC-000 AI-R1-5); RFC-003's catalogue is a precondition party, not a consumer |
| Transport | Partner port: **gRPC command between NestJS owners**, routed by the adapter's partition (slot) through the placement cache (RFC-002 §13; RFC-000 §8 "adapter interface, per partner"); adapter-to-owner results as **point-to-point state messages** (gRPC push, Kafka relay; RFC-000 §4.4). Partner driver: **in-process call** inside the adapter process; the driver speaks the partner's own API (wire format out of scope). Reconciliation feed: **Kafka event** through the adapter's transactional outbox. Equivalent-path source: **synchronous query** to routing (external input, RFC-000 §8) |
| Pinned to | `requirements-v1.10`; RFC-000 revision 4.4 (§8 rows "Partner port", "Partner reconciliation feed", "Equivalent-path source"; V-03, A0R-08, A0R-14, AI-R1-5, AI-R6-3, AI-19-2); RFC-002 revision 5 (§5.1, §5.5, §9.3, §9.6, §10, §13); RFC-003 revision 5 with erratum 5.1 (§6.1 catalogue, equivalent-path source row); RFC-005 revision 5 (§8.2 partner callbacks); RFC-006 revision 6 (runtime: (generation, epoch), slot routing, outbox) |

Partner-specific wire formats (HTTP, SOAP, batch files, a partner's own idempotency header
name) are out of scope: each driver maps the **Partner driver interface** (§2.2) onto its
partner's API.

## 1. Purpose

A route may cross partner links that Share does not schedule. The account owner books
those legs through one uniform **partner port**, implemented by every partner adapter, so
the booking workflow never sees a partner's API. The adapter stands in for a schedule
owner: it journals every partner call before making it (the journaled send time of a
confirm is the request's "begin committing" time, POL-26), refuses calls a fence, an
epoch or a tombstone forbids (RFC-000 V-03), keeps Share's own waiter queue at the
partner (POL-02, POL-05 at a partner), and reconciles unknown results at once and every
partner daily (POL-28). Its daily mismatches are published on the **partner
reconciliation feed**. The **equivalent-path source** supplies candidate paths for
POL-07 offers, every one a catalogue route with split weights (AI-19-2).

## 2. Schema

Units and encodings, used throughout:

| Quantity | Type | Unit |
|---|---|---|
| Instants (`D`, `D_c`, send time, decision time, partner expiry) | `UnixMs` = integer | Milliseconds since the Unix epoch, UTC. Commit timestamps are the HLC wall component, truncated to ms |
| Window bounds, effective minutes | `UnixMinute` = integer | Whole minutes since the Unix epoch, UTC; windows half-open `[start, end)` (glossary) |
| Rate | `Mbps` = integer ≥ `rate_min` | Whole Mbps (POL-31) |
| Durations in this contract | integer | Milliseconds unless the name ends in `_s` |
| Money (fees) | not carried here | Fees are on the lifecycle feed in pico-USD (RFC-003); this contract carries only the cost bearer |

### 2.1 Partner port (account owner → adapter; every adapter implements it)

```ts
type UnixMs = number; type UnixMinute = number; type Mbps = number;

/** A booking request, or the partner booking at an offer's acceptance (RFC-002 §9.6). */
type PartnerRequestId =
  | { kind: 'booking'; requestId: string }            // account partition + sequence, as the owner names it
  | { kind: 'offer'; reservationId: string; offerId: string };

type LegRef = { legIndex: number; partnerLinkId: string };   // leg numbered in route order (glossary)

/** Sender stamp on every command (RFC-000 §5.2, AI-R6-3; RFC-006 runtime). */
interface OwnerStamp {
  accountPartition: string;     // the account slot's partition id
  generation: number;           // partition generation
  epoch: number;                // owner-lease epoch
  sequence: number;             // owner's command sequence, for tracing only
  mapVersion: number;           // placement map version the sender routed by
}

interface Window { start: UnixMinute; end: UnixMinute | null }   // null = open-ended

// ---- commands ----
interface ClassifyCmd   { partnerLinkId: string }
interface HoldCmd       { stamp: OwnerStamp; request: PartnerRequestId; leg: LegRef;
                          rate: Mbps; window: Window;
                          expiresAt: UnixMs;          // = D, always (POL-26, P2-S100)
                          requestAge: UnixMs; requestAgeTiebreak: string; // POL-02 priority
                          commitFence: UnixMs;        // D_c = D − commit_margin
                          opaqueRef: string }         // what the partner may see (POL-33)
interface ConfirmCmd    { stamp: OwnerStamp; request: PartnerRequestId; leg: LegRef;
                          attempt: number }           // the attempt HELD named
interface BookFinalCmd  { stamp: OwnerStamp; request: PartnerRequestId; leg: LegRef;
                          rate: Mbps; window: Window; deadline: UnixMs; requestAge: UnixMs;
                          requestAgeTiebreak: string; commitFence: UnixMs; opaqueRef: string }
interface ReleaseCmd    { stamp: OwnerStamp; request: PartnerRequestId; deadline: UnixMs;
                          reason: 'not_confirmed' | 'yield_accepted' | 'withdrawn' | 'expired'
                                | 'rejected' | 'failed' | 'displaced' | 'offer_failed';
                          decisionTime: UnixMs }      // request-scoped: no attempt, ends every attempt
interface OutcomeConfirmedCmd { stamp: OwnerStamp; request: PartnerRequestId; leg: LegRef;
                          attempt: number; reservationId: string; decisionTime: UnixMs }
interface CancelCmd     { stamp: OwnerStamp;
                          target: { request: PartnerRequestId; leg: LegRef }
                                | { reservationId: string; leg: LegRef };
                          cancelId: string;           // owner-chosen, unique per target
                          reason: 'residue_unconfirmed' | 'withdrawn_after_booking' | 'displaced'
                                | 'offer_failed' | 'moved_off_leg' | 'buyer_cancel'
                                | 'revocation' | 'termination' | 'release_after_grace'
                                | 'reconciliation_orphan';
                          costBearer: 'share' | 'payer_per_terms';   // POL-08, POL-28
                          effectiveMinute: UnixMinute | null }       // null = at once
interface ChangeCmd     { stamp: OwnerStamp; reservationId: string; leg: LegRef;
                          changeId: string;
                          change: { kind: 'shorten'; newEnd: UnixMinute }
                                | { kind: 'decrease'; fromMinute: UnixMinute; newRate: Mbps };
                          decisionTime: UnixMs }      // settled S1: shorten/decrease only, via driver amend
interface MarkWaitingCmd { stamp: OwnerStamp; request: PartnerRequestId; waiting: boolean;
                          accountLogPosition: number }               // advisory hint (§10.5)
interface YieldAnswerCmd { stamp: OwnerStamp; request: PartnerRequestId; attempt: number;
                          answer: 'accept' | 'refuse' }
interface ResumeQueryCmd { stamp: OwnerStamp; request: PartnerRequestId }  // J7: records (generation, epoch)

// ---- synchronous replies ----
type CommandReply =
  | { kind: 'ACCEPTED'; journalPosition: number }       // intent journaled; result follows as a PartnerResult
  | { kind: 'RESULT'; result: PartnerResult }           // already known (duplicate, or decided without a call)
  | { kind: 'NOT_OWNER' | 'UNAVAILABLE' | 'MOVING' }
  | { kind: 'MOVED'; slot: string; generation: number }
  | { kind: 'STALE_EPOCH' }                             // adapter's own lease lost
  | { kind: 'STALE_SENDER'; highest: { generation: number; epoch: number } }
  | { kind: 'MISMATCH'; field: string };                // same identity, different content

interface Classification {
  partnerLinkId: string;
  termsVersion: number;               // catalogue partner-terms version used
  holds: 'with_holds' | 'without_holds';
  maxHoldS: number;                   // partner's maximum hold length, seconds
  acceptsAbsoluteExpiry: boolean;
  sigmaP: number;                     // σ_p, ms (ε + h_s + measured partner clock bound)
  expectedAnswerMs: number;           // p99 partner answer time, from terms (RFC-002 §5.5 step 3)
  expiryGranularityMs: number;        // partner's expiry resolution (1 = exact)
  supportsAmend: boolean;             // S1: recorded into the shown terms; false ⇒ terms forbid shorten and decrease
  effectiveFrom: UnixMs }             // applies to requests whose intake ts ≥ this

// ---- results (adapter → owner, state messages) ----
type PartnerResult =
  | { kind: 'HELD'; attempt: number; partnerExpiry: UnixMs }
  | { kind: 'WAITING'; attempt: number; latestBlockerDeadline: UnixMs }
  | { kind: 'REFUSED'; attempt: number | null;
      reason: 'NO_FIT' | 'HOLD_LAPSED' | 'FENCE_PASSED' | 'TOMBSTONED' | 'PAST_DEADLINE'
            | 'STALE_SENDER' | 'NOT_SENT_LATE' }
  | { kind: 'FAILED'; attempt: number | null;
      reason: 'partner_fault' | 'unclassifiable_answer' | 'expiry_mismatch' }
  | { kind: 'CONFIRMED'; attempt: number; partnerBookingRef: string; sendTime: UnixMs }
  | { kind: 'BOOKED'; attempt: number; partnerBookingRef: string; sendTime: UnixMs }   // book_final
  | { kind: 'RELEASED' }
  | { kind: 'CANCELLED'; cancelId: string; partnerBookingRef: string }
  | { kind: 'CHANGED'; changeId: string }
  | { kind: 'RESUMED'; journal: PartnerLegJournalView[] };

interface PartnerResultMsg {
  adapter: { partnerLinkId: string; generation: number; epoch: number };
  request: PartnerRequestId; leg: LegRef;
  operation: 'hold' | 'confirm' | 'book_final' | 'release' | 'cancel' | 'change'
           | 'resume_query' | 'outcome';
  result: PartnerResult;
  adapterSeq: number }                // adapter partition sequence; highest wins within one identity

interface YieldRequestMsg { adapter: PartnerResultMsg['adapter']; request: PartnerRequestId;
                            attempt: number; olderRequest: PartnerRequestId }

interface PartnerLegJournalView {    // answer to resume_query
  leg: LegRef; attempt: number;
  status: 'none' | 'hold_sent' | 'held' | 'waiting' | 'confirm_sent' | 'final_sent'
        | 'querying' | 'partner_booked' | 'confirmed' | 'releasing' | 'released'
        | 'refused' | 'not_booked' | 'cancelling' | 'cancelled';
  sendTime: UnixMs | null; partnerBookingRef: string | null;
  tombstonedUntil: UnixMs | null;
  highestOwnerStamp: { generation: number; epoch: number } }

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

`release` and `outcomeConfirmed` are the partner-adapter binding of the outcome and expiry
port (RFC-000 §8): the outcome notice "confirmed" and the request-scoped release with `D`.
`markWaiting` and `yieldAnswer` are the partner binding of the waiting hints and yield
answers (RFC-002 §13.1, outcome and expiry port row).

### 2.2 Partner driver interface (adapter → driver; every driver implements it)

```ts
type PartnerKey = string;   // §5.1: lowercase hex, ≥ 128 bits of SHA-256

type DriverAnswer<T> =
  | { class: 'success'; value: T }
  | { class: 'definite_refusal'; code: 'NO_FIT' | 'UNKNOWN_HOLD' | 'NOT_FOUND' | 'NOT_ALLOWED' }
  | { class: 'transient'; code: 'BUSY' | 'RATE_LIMITED' | 'SERVER_ERROR_BEFORE_WORK' | 'CONNECT_FAILED'; retryAfterMs?: number }
  | { class: 'unknown'; code: 'TIMEOUT' | 'CONNECTION_LOST_AFTER_SEND' | 'UNPARSEABLE' };

interface PartnerBookingState {
  key: PartnerKey; partnerBookingRef: string | null;
  state: 'absent' | 'held' | 'booked' | 'released' | 'cancelled' | 'lapsed';
  rate: Mbps | null; window: Window | null; expiresAt: UnixMs | null }

interface PartnerDriver {
  readonly partnerLinkId: string;
  capabilities(): { holds: boolean; acceptsAbsoluteExpiry: boolean; maxHoldS: number;
                    expiryGranularityMs: number; supportsAmend: boolean;
                    maxKeyBytes: number; callTimeoutMs: number };
  hold(key: PartnerKey, ref: string, rate: Mbps, window: Window, expiresAt: UnixMs, deadlineMs: number)
    : Promise<DriverAnswer<{ partnerExpiry: UnixMs; partnerHoldRef: string }>>;
  confirm(key: PartnerKey, partnerHoldRef: string, deadlineMs: number)
    : Promise<DriverAnswer<{ partnerBookingRef: string }>>;
  bookFinal(key: PartnerKey, ref: string, rate: Mbps, window: Window, deadlineMs: number)
    : Promise<DriverAnswer<{ partnerBookingRef: string }>>;
  release(key: PartnerKey, partnerHoldRef: string, deadlineMs: number): Promise<DriverAnswer<void>>;
  cancel(key: PartnerKey, partnerBookingRef: string, deadlineMs: number): Promise<DriverAnswer<void>>;
  amend?(key: PartnerKey, partnerBookingRef: string,
         change: { newEnd?: UnixMinute; fromMinute?: UnixMinute; newRate?: Mbps }, deadlineMs: number)
    : Promise<DriverAnswer<void>>;                            // S1: present iff supportsAmend
  query(key: PartnerKey, deadlineMs: number): Promise<DriverAnswer<PartnerBookingState>>;
  listDay(dayUtc: string /* YYYY-MM-DD */, deadlineMs: number)
    : AsyncIterable<PartnerBookingState>;                     // daily reconciliation listing
  onCallbackHint(handler: (hint: { key?: PartnerKey; partnerBookingRef?: string }) => void): void;
}
```

A driver **never** retries, never decides, never reads the clock for a fence and never
writes Share state: it maps one call to the partner and classifies the answer (RFC-002
§10.2). Classification of a partner answer into the four classes is the driver's whole
contract; an answer it cannot classify is `unknown/UNPARSEABLE`. Callbacks are verified by
the partner's scheme and passed to the adapter only as hints (RFC-005 §8.2).

### 2.3 Partner reconciliation feed (Kafka)

Topic `partner.reconciliation.v1`, key = `partnerLinkId`. Value (encrypted payload per
RFC-006 §5, schema in the registry):

```ts
interface ReconciliationEvent {
  header: { partnerLinkId: string; generation: number; epoch: number;
            stream: 'reconciliation'; streamSeq: number;    // contiguous per partner link
            committedAt: UnixMs };
  body:
    | { kind: 'MISMATCH';
        day: string;                         // UTC day D reconciled, YYYY-MM-DD
        partnerBookingRef: string;           // identity part (Share's recorded ref for SHARE_ONLY)
        mismatch: 'PARTNER_ONLY'             // partner booking with no Share reservation behind it
                | 'SHARE_ONLY'               // Share reservation leg the partner lacks
                | 'TERMS_DIFFER';            // both have it; rate or window differ
        share: { accountPartition: string; reservationId: string | null;
                 request: PartnerRequestId | null; leg: LegRef } | null;
        partner: { rate: Mbps | null; window: Window | null; state: PartnerBookingState['state'] } | null;
        action: 'CANCEL_AT_SHARE_COST'       // PARTNER_ONLY (POL-23, POL-28)
              | 'MARK_LEG_AFFECTED'          // SHARE_ONLY → account owner writes E14
              | 'ALERT_ONLY';                // TERMS_DIFFER
        cancelId: string | null }
    | { kind: 'RUN_COMPLETED'; day: string; bookingsCompared: number; mismatches: number;
        completedAt: UnixMs } };
```

Identity: (partner link, day, partner booking reference) for `MISMATCH`; (partner link,
day) for `RUN_COMPLETED`. No buyer identity, no principal, no personal data (A11, POL-33):
`accountPartition` and `reservationId` are internal pseudonymous identifiers.

### 2.4 Equivalent-path source (routing → RFC-002)

```ts
interface EquivalentPathQuery {
  reservationId: string; routeId: string;             // current catalogue route
  legs: string[];                                     // current link ids in order
  affectedLinkId: string; reductionId: string;
  fromMinute: UnixMinute; end: UnixMinute | null; rate: Mbps;
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

Notation as RFC-002 §1.3: `D` deadline, `D_c` commit fence (`D − commit_margin` with a
partner leg), `σ_p` partner-skew budget, `h_s` adapter commit-to-send bound (est. 20 ms),
`τ` confirm fence offset, `release_grace` 1 min, `commit_margin` 10 s.

**Common to every command.** The adapter checks, in its own partition and in the same
log entry as the effect: (1) the sender's (generation, epoch) is not lower than the
highest recorded for the request (J7), else `STALE_SENDER`; (2) the identity (§5) is new,
or equal in content to the recorded one (then the recorded reply or result is returned),
else `MISMATCH`; (3) the adapter holds its owner lease, else `NOT_OWNER` / `STALE_EPOCH` /
`MOVED` / `MOVING`. Every partner call is preceded by its intent entry (J1…J6), committed,
and followed by its result entry.

| Operation | Preconditions | Outcomes | Errors and refusals |
|---|---|---|---|
| `classify` | None | The classification from the catalogue's partner terms and the onboarding test, including the driver's `supportsAmend`, which is recorded into the shown terms (false ⇒ shorten and decrease forbidden, S1): `with_holds` only if `maxHoldS ≥ route_deadline_max + commit_margin` (70 s) **and** `acceptsAbsoluteExpiry` (POL-26, P2-S36, P2-S102); a change applies to requests whose intake `ts` ≥ `effectiveFrom` only | `UNAVAILABLE` if terms not loaded; the owner then refuses intake of routes over that link until answered |
| `hold` | Partner with holds; not tombstoned; adapter clock and the J1 intent's `ts` before `D_c` (hold fence) and before `D` | J1 intent, driver `hold(expiresAt = D)`. `HELD(attempt, partnerExpiry)` with `partnerExpiry ≤ D` and `≥ D − expiryGranularityMs`; definite refusal with a Share position overlapping (another Share request holding, or partner-booked and undecided) → waiter registered (J9), `WAITING(attempt, latest blocker deadline)` (P2-S89, P2-S96); definite refusal with none → tombstone, `REFUSED(NO_FIT)` (P2-S31); transient → retried until `D_c`, then `FAILED(partner_fault)`; unknown → query at once (J6) and follow the answer (P2-S90) | `REFUSED(TOMBSTONED)`, `REFUSED(PAST_DEADLINE)`; a partner expiry later than `D` or outside the granularity → release at once, `FAILED(expiry_mismatch)`, alert |
| `confirm` | Leg `held` at `attempt`; not tombstoned; sender stamp ≥ highest; J2 intent commits with `ts < D_c − σ_p` | J2 intent (its `ts` is the **send time**, the request's begin-committing time, POL-26); call sent within `h_s` of that commit, else journaled `NOT_SENT_LATE`. `CONFIRMED(attempt, ref, sendTime)`; `UNKNOWN_HOLD` → `REFUSED(HOLD_LAPSED)`; unknown → query by the same key; still unknown at the owner's `D − τ` → the owner decides not confirmed and the adapter keeps querying; a booking found later is cancelled at Share's cost | `REFUSED(FENCE_PASSED)` (never sent), `REFUSED(TOMBSTONED)`, `STALE_SENDER`, `MISMATCH` (attempt ≠ held attempt) |
| `book_final` | Partner without holds (at most one per route, checked at intake, P2-S34); not tombstoned; J3 intent `ts < D_c − σ_p` | As `confirm` with J3; `BOOKED(attempt, ref, sendTime)`; definite refusal → `WAITING` if a Share position overlaps, else `REFUSED(NO_FIT)`; unknown → query at once (P2-S35 if the request has meanwhile ended: cancel at Share's cost) | As `confirm` |
| `release` | Any | Request-scoped: every hold of the request at the partner released (J4), every waiter registration removed, tombstone written until `D + release_grace`; `RELEASED` once the partner answered or the hold lapsed at `D`. A partner booking found for the request is cancelled at once at Share's cost (POL-28, P2-S105). Never refused for the epoch: a release only removes | — |
| `outcome_confirmed` | Leg `partner_booked` at `attempt` | Leg `confirmed` (J8), bound to the reservation; blockers resolved for waiters (re-asks start, §10.5) | `MISMATCH` (attempt ≠ booked attempt); if the leg is not partner-booked: alert (protocol defect) |
| `cancel` | Target has a partner booking, or none (then a no-op with `CANCELLED` and `partnerBookingRef` empty after a query confirms absence) | J5 intent, driver `cancel` by the booking reference; retried until the partner confirms, without bound (P2-S82), alerting while a Share-cost cancellation is outstanding (RFC-002 §13.2). Takes effect for the buyer whatever the partner answers (owner side) | — |
| `change` | Reservation leg `confirmed`; `supportsAmend` recorded in the leg's shown terms; for `decrease`, the shown terms allow one. A shorten or decrease over a partner leg whose shown terms forbid it (including every partner whose driver cannot amend) is rejected at the owner's intake, stating the rule, and never reaches the adapter (P2-S115) | Driver `amend`, retried until the partner confirms, without bound, as `cancel`; `CHANGED(changeId)`. Takes effect for the buyer whatever the partner answers. **Never** cancel-and-rebook at Share's risk (S1) | A `change` for a leg whose driver lacks `amend` is a protocol defect: alerted, nothing sent |
| `mark_waiting` | Request known | Hint recorded (J9); used only to choose which of Share's own partner holds to ask to yield | — |
| `yield_answer` | A yield request outstanding for (request, attempt) | `accept`: hold released at the partner, the adapter waits for the release's answer, registers the request as a waiter at its own age with a new attempt, answers `WAITING(newAttempt, …)`; `refuse`: no change | `STALE_SENDER` |
| `resume_query` | Any | J7 entry recording the sender's (generation, epoch) as the highest for the request; answers `RESUMED(journal)`. After it, confirm, book final and yield acceptance with a lower pair are refused | — |

**Adapter-initiated messages.** `PartnerResultMsg` for every result above, re-sent until
the owner's acknowledgement; `YieldRequestMsg` when a waiter is older than a blocker whose
hold the adapter believes waiting (§10.5), re-sent until answered; `expire_if_undecided`
(outcome and expiry port, RFC-000 §8) for a request still undecided at `D` (P2-S53).

**Re-asks.** On a blocker's resolution (its outcome notice and, if not confirmed, the
partner's answer to its release or cancel) the adapter re-asks the partner for waiters in
`priority_rule` order, a waiter's re-ask starting once no older waiter with an
overlapping window has one outstanding (A0R-08); it skips waiters past `D_c − σ_p` less
their expected hold time, or ended. A re-ask is a new `hold` call with a new attempt, and
its success is sent as `HELD(newAttempt)` (P2-S95).

**Equivalent-path source.** `candidates` returns paths ordered all-Share first (P1-S58).
RFC-002 refuses (does not offer, alerts) any candidate that is not a catalogue route with
split weights at the catalogue replica's current version, and tries the next (RFC-002
§9.4, AI-19-2). An empty list means no path: the reservation is cut by the target as for a
declined offer.

## 4. Delivery and ordering

| Message | Delivery | Ordering scope |
|---|---|---|
| Owner → adapter commands | At least once: re-sent with the same identity with backoff (min(1000, 50·2^n) ms × jitter) on no answer, `UNAVAILABLE`, `NOT_OWNER`, `MOVED`, `MOVING`, re-routed by the placement cache, until answered or the request's expiry (RFC-002 §5.1); `cancel` and `change` until answered, without bound | None across identities. Within one request, the owner sends `confirm` only after `HELD`, `outcome_confirmed` only after `CONFIRMED`/`BOOKED`; the adapter enforces the leg state machine (RFC-002 §10.3), so a reordered command is refused or deferred, never misapplied |
| Adapter → owner `PartnerResultMsg`, `YieldRequestMsg` | At least once (gRPC push, Kafka relay); idempotent state messages identified by (request, leg, attempt, operation); no high-water rule across identities; within one identity the highest `adapterSeq` wins | The owner reconciles a lost result by re-sending the outstanding command (§3: a duplicate returns `RESULT`) every 5 s (est.) while the leg is outstanding, and by `resume_query` on takeover |
| Partner calls (driver) | At least once at the partner; exactly-once effect by the partner key (P2 C7, P2-S28) | Per (request, leg): hold → confirm → (cancel); release and cancel may overtake an in-flight confirm, the adapter querying afterwards |
| Reconciliation feed | At least once, exactly-once effect by identity | Ordered per partner link by `streamSeq`; consumers wait on a gap (RFC-000 §4.4) |
| Equivalent-path source | Synchronous; RFC-002 retries | — |

## 5. Idempotency

| Input | Key | Duplicate (same content) | Same key, different content | Retention |
|---|---|---|---|---|
| `hold`, `book_final` | (request, leg, operation); the adapter assigns the attempt | Returns the recorded reply/result; no second partner call | `MISMATCH`, alert; nothing changes | Life of the request + 24 h |
| `confirm`, `outcome_confirmed`, `yield_answer` | (request, leg, operation, attempt) | As above | `MISMATCH` | Life of the request + 24 h |
| `release` | (request): request-scoped, no attempt | No-op, `RELEASED` (or the in-progress state) | A different `reason` is recorded but ignored | Tombstone until `D + release_grace`; record life + 24 h |
| `cancel` | (target, `cancelId`) | Recorded result | `MISMATCH` | 7 years with the partner booking record |
| `change` | (reservation, leg, `changeId`) | Recorded result | `MISMATCH` | 7 years |
| `resume_query` | (request, generation, epoch) | Same journal answer | — | Life of the request + 24 h |
| Partner call | **Partner key** = SHA-256 of the canonical string `v1\|<request>\|<leg>\|<operation>\|<attempt>`, lowercase hex, truncated by the driver to `maxKeyBytes` only if ≥ 128 bits remain (else onboarding fails); `confirm` uses the attempt of the hold it confirms; `release` the hold's key with operation `release`; `cancel` and `amend` act by the partner booking reference, keyed by (reference, `cancelId`/`changeId`) | The partner returns the original result (P2 C7) | A partner answering a reused key with another booking is a driver defect: `FAILED(unclassifiable_answer)`, alert | 7 years with the partner booking record (RFC-000 §4.4) |
| Reconciliation event | (partner link, day, booking ref) / (partner link, day) | Consumers drop it | Not produced: an adapter re-run for a day re-uses the run's recorded mismatches | Until consumed and checkpointed |
| Equivalent-path query | None (read) | — | — | — |

## 6. Ownership

| Data | Writer | Readers |
|---|---|---|
| Adapter log (state, call journal J1…J10, waiter queue, tombstones, reconciliation) | The adapter holding the partner link partition's owner lease, only, in epoch-conditional batches (RFC-000 A1, §5.2) | The adapter; history (RFC-006) from archived segments. No other component reads it; the owner learns state only through results and `resume_query` |
| Partner credentials | Secrets service; used only by the driver (RFC-005 §8.2, §10) | The adapter process |
| Partner leg status in the reservation (E5, E14) | The account owner | Per RFC-002 |
| Classification inputs (partner terms) | Catalogue, commercial operator (RFC-003 §6.1, POL-32) | Adapter |
| Reconciliation feed | Adapter's outbox | Operator console, notifier, account owner |
| Equivalent paths | Routing (out of scope); route and weights registered in the catalogue first (RFC-003 §6.1) | RFC-002 only |

What the partner may see: the `opaqueRef` (an adapter-generated reference per (request,
leg), kept as the reservation's reference on that leg), rate and window. Never the account,
principal or buyer identity (POL-33).

## 7. Timeouts and deadlines

| Bound | Value | Applies to |
|---|---|---|
| Port RPC deadline (owner → adapter) | 1,000 ms (est., `partner_port_rpc_ms`) | Each command; on expiry re-sent with the same identity |
| Driver call timeout | `callTimeoutMs` per partner (from terms; default 2,000 ms, est.), never beyond the operation's fence | Each partner call; a timeout after sending is `unknown` → query at once |
| Hold retry fence | `D_c` | Transient hold answers retried with exponential backoff and jitter (base 50 ms, cap 1 s, est.); still failing → `FAILED(partner_fault)` (P2-S30, P2-S62) |
| Confirm / final booking fence | J2/J3 intent `ts < D_c − σ_p`; send within `h_s` (20 ms) of its commit | Never sent otherwise (P2-S55, P2-S109) |
| Owner's confirm wait | Until `D − τ`; the partner has at least `commit_margin − τ` (about 9.6 s) | After it the owner decides not confirmed and releases/cancels |
| Partner hold expiry | Exactly `D` (at the partner's granularity, never later) | P2-S100, P2-S101 |
| Query after unknown | At once, then backoff (cap 5 s, est.) until a definite answer; no bound | P2-S90; alert if unknown past `D − τ` |
| Cancel / amend | Retried until confirmed, no bound; alert while a Share-cost cancellation is outstanding (threshold 5 min, est.) | P2-S82, P2-S105 |
| Daily reconciliation | Run for UTC day D, every `MISMATCH` and the `RUN_COMPLETED` committed by 12:00 UTC on D + 1 | P2-S32 |
| Tombstones | Until `D + release_grace` | Refuse late hold, confirm, final booking |
| `move_deadline` (offer booking) | `D` = acceptance `ts` + 60 s, `D_c = D − commit_margin` | RFC-002 §9.6 |
| Equivalent-path query | 2,000 ms (est.); on failure retried with backoff (cap 30 s) and alerted after 3 failures; no offer is made while it fails | RFC-002 §9.6 |

## 8. Versioning and compatibility

- The port's gRPC package and the topic carry a major version (`partner.v1`,
  `partner.reconciliation.v1`). Additive fields (new optional fields, new enum values that
  receivers must map to "unknown, alert, treat as no answer") are minor; anything that
  changes an identity, a fence, the partner-key derivation or the meaning of a result is
  major and needs a new contract version with both sides' C3 RFCs revised.
- The partner-key derivation is frozen for 7 years per booking: the `v1|` prefix names
  it; a new derivation uses a new prefix and old keys stay queryable.
- Reconciliation event schemas are kept in the schema registry for 7 years (RFC-006 §5).
- Each driver is versioned independently; a driver change that alters answer
  classification re-runs the driver conformance suite (§10.3) before deployment.
- A classification change applies only to requests with intake `ts ≥ effectiveFrom`.

## 9. Scenarios relied on

P2-S03, P2-S13, P2-S14, P2-S28, P2-S29, P2-S30, P2-S31, P2-S32, P2-S33, P2-S34, P2-S35,
P2-S36, P2-S37, P2-S44, P2-S48, P2-S50, P2-S53, P2-S55, P2-S57, P2-S62, P2-S82, P2-S83,
P2-S89, P2-S90, P2-S91, P2-S93, P2-S95, P2-S96, P2-S100, P2-S101, P2-S102, P2-S105,
P2-S109, P2-S115; P1-S58, P1-S59, P1-S60, P1-S61 (all at `requirements-v1.10`).

## 10. Conformance tests

### 10.1 Adapter (provider of the partner port), against a scripted fake driver

1. Fence: a `confirm` whose J2 intent would commit at `D_c − σ_p` is refused `FENCE_PASSED` and the fake driver records no call; one at `D_c − σ_p − 1 ms` is sent (P2-S55, P2-S109).
2. Send bound: a J2 intent whose send is delayed past `h_s` is journaled `NOT_SENT_LATE`; no call.
3. Epoch: after `resume_query` at (g, e), `confirm`, `book_final` and `yield_answer` at (g, e − 1) are `STALE_SENDER`, journaled, never sent; `release` at (g, e − 1) still releases.
4. Tombstone: after `release`, `hold` / `confirm` / `book_final` for the request are `REFUSED(TOMBSTONED)` until `D + release_grace`.
5. Expiry: every driver `hold` carries `expiresAt = D`; a partner expiry later than `D` is released and answered `FAILED(expiry_mismatch)` (P2-S100).
6. Idempotency: any command repeated N times yields one driver call per partner key and the same reply; same identity with different content is `MISMATCH`.
7. Unknown: a timeout after send triggers an immediate `query` with the same key, and the result follows the query (P2-S90); a booking found for a tombstoned request is cancelled with `costBearer = share` (P2-S105).
8. Transient: `BUSY` is retried until `D_c` (hold) or `D_c − σ_p` (confirm), never producing `REFUSED` (P2-S30), then `FAILED(partner_fault)`.
9. Contention: a definite refusal with another Share request's overlapping hold yields `WAITING(latest blocker deadline)`; without, `REFUSED(NO_FIT)` (P2-S31, P2-S89, P2-S96); re-asks in priority order, serialised per overlapping pair, skipping waiters past their fence (P2-S95).
10. Yield: on `yield_answer(accept)` the hold is released at the partner before `WAITING(newAttempt)` is sent.
11. Cancel: a `cancel` answered transient forever keeps retrying and raises the outstanding-cancellation alert (P2-S82).
12. Amend: `change` calls driver `amend` once per (reservation, leg, `changeId`), retries a transient answer until the partner confirms, and never calls `cancel` or `bookFinal` for it (S1).
13. Chaos (P2-S28): fake driver failing before work, timing out after work and slow at random; any interleaving of commands and adapter crashes/lease moves; after daily reconciliation Share's records equal the fake partner's.
14. Reconciliation: seeded PARTNER_ONLY and SHARE_ONLY differences produce one `MISMATCH` each, the right action, and `RUN_COMPLETED` before 12:00 UTC D + 1 (P2-S32, P2-S91).

### 10.2 Account owner (consumer of the partner port), against a fake adapter

1. A route is never confirmed unless every partner leg answered `CONFIRMED` or `BOOKED` (P2-S03, P2-S29).
2. `book_final` is sent only after every other leg is held, the funds hold taken and Share's checks passed; two without-holds legs are rejected at intake (P2-S33, P2-S34).
3. Results are applied idempotently by identity; a lost result is recovered by re-sending the command; `STALE_SENDER` deposes the owner.
4. `CONFIRMED` arriving after the owner's `D − τ` leads to `cancel(costBearer = share)` (P2-S105, R17).
5. `WAITING` for a request with `wait = false` gives E7 rejected with `retry_after`, followed by `release`.
6. A `SHARE_ONLY` reconciliation event produces exactly one E14 for the reservation's leg (P2-S91).
7. Offer acceptance with a partner leg uses `request = {kind: 'offer'}`, `D` = acceptance `ts` + 60 s; a failure releases offer holds and offers the next candidate (P1-S60, P1-S61).
8. A shorten or decrease over a partner leg whose shown terms forbid it (`supportsAmend = false`, or no decrease allowed) is rejected at intake stating the rule, and no command reaches the adapter; an allowed one sends `change`, never `cancel` plus a new booking (P2-S115, S1).

### 10.3 Driver conformance suite (every driver, against the partner's sandbox)

Classification of each documented partner answer into the four classes; reuse of a key
returns the original result; `hold` honours an absolute expiry to the declared
granularity; `query` finds every booking made under a key; `listDay` returns every
booking of the day; `amend` is present exactly when `supportsAmend` is advertised and changes the booking in place; callbacks reach the adapter only as hints. The `classify` result is
computed from these measurements and the catalogue terms (P2-S36, P2-S102).

### 10.4 Equivalent-path source

A candidate not registered in the catalogue, or without split weights, is refused and
alerted, and the next candidate tried; all-Share candidates are offered first (P1-S58,
P1-S59).

## Settled

No open mismatches. Settled by the orchestrator (binding):

| # | Between | Disagreement | Settlement | Consumer obligation |
|---|---|---|---|---|
| **S1** (was M1) | RFC-000 §8 partner port row vs RFC-002 §13.1, §9.3, §10.2 | How a booked partner leg is changed: RFC-000 §8 lists no change operation; RFC-002 §13.1's `change(reservation leg, added part)` contradicted §9.3 (additions by hold and confirm), §9.3 required a partner change on a decrease and was silent on shorten, and the driver had no amend operation | **Additions** (extend, increase, make open-ended) go through `hold`, `confirm` or `book_final` as a request of their own, the change's request id (P2-S83). **Shorten and decrease** use `change` → driver `amend`, retried until the partner confirms. The driver advertises `supports_amend` (`capabilities().supportsAmend`); `classify` records it into the partner leg's shown terms. A partner whose driver cannot amend has shown terms forbidding shorten and decrease, and such a change is **rejected at intake** (P2-S115). Never cancel-and-rebook at Share's risk | RFC-002 takes this as errata to §9.3 (shorten covered, partner change via `amend`), §10.2 (`amend` is a driver operation) and §13.1 (`change` carries shorten and decrease, not additions) |

Readings reconciled without a disagreement (recorded so reviewers can check them; none
blocks Frozen):

- **Confirm fence clock.** RFC-000 §8 refuses "when the adapter's clock is past `D − commit_margin` less the partner-skew budget"; RFC-002 §10.4 checks the J2/J3 intent's commit `ts` against `D_c − σ_p` plus the `h_s` send bound. Same fence (`D_c = D − commit_margin`); the commit `ts` is within `ε` of true time and `σ_p ≥ ε + h_s`, so RFC-002's check implies RFC-000's. Adopted: RFC-002's.
- **Resume query stamp.** RFC-000 §8 says "owner-lease epoch"; RFC-002 J7 and RFC-000 AI-R6-3 use (generation, epoch). Adopted: (generation, epoch).
- **Attempt numbering at a partner.** RFC-002 §13.1's `confirm` carries an attempt that `hold` does not; adopted: the adapter numbers attempts and returns them in `HELD`/`WAITING`, as the link does (RFC-002 JI-1).
- **Reconciliation feed consumers.** RFC-000 §8 names the operator console and notifier; RFC-002 §13.1 adds the account owner, which the RFC-000 row's own text (and A0-14) requires for E14. Adopted: all three.
- **Equivalent-path source consumers.** RFC-000 §8's consumer column also names RFC-003; AI-R1-5 and RFC-002 §13.2 say RFC-002 only, RFC-003 §13 "through RFC-002". Adopted: RFC-002 is the only consumer; RFC-003's catalogue registration is a precondition.
- **Gaps filled here** (the RFCs are silent; the values are this contract's): the command-acknowledgement-plus-result-message shape of the port; `partnerExpiry` granularity rule and `expiry_mismatch`; the `TERMS_DIFFER` mismatch kind (alert only) and the `RUN_COMPLETED` event; "day D" = bookings whose window intersects UTC day D or that were created, changed or cancelled during it; port RPC, driver and equivalent-path timeouts marked (est.).
