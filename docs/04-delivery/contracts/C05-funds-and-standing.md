# C05. Funds and standing

| | |
|---|---|
| Contract ID | C05 |
| Version | 1 |
| Status | **Frozen.** Frozen at C4 on fix verification 53 ([review 53](../../reviews/53-contract-C05-fix-verification.md), V53-1 … V53-4 applied), after [review 45](../../reviews/45-contract-C05-review.md); errata owed listed below ([Consumer obligations](#consumer-obligations-rfc-errata): RFC errata, C06's `entry` field and C08's row are owed by those owners and contracts). See also [Settled](#settled) and [Review 45 resolution](#review-45-resolution) |
| Provider | RFC-004 Part A: the funds-and-standing module (§A1 … §A11), a library linked into the account owner. RFC-004 also defines the semantics of the standing feed, the standing query, the standing enforcement acknowledgement and the headroom and balance query (§A8, §A9, §B12) |
| Emitter and host | RFC-002: the account owner. It calls the module, appends every entry, serves the queries from its status replicas, and publishes the standing feed and the usage-applied acknowledgement from its outbox (§2.3, §2.4, §2.5, §13.1) |
| Consumers | RFC-002, the account owner's booking module (every in-process call). Network operations: standing feed and standing query (RFC-005 §2: mTLS client). Network operations is also the **producer** of the enforcement acknowledgement. Edge (RFC-005; buyer API, permission matrix §4.2) and probes (RFC-006 §17, wallet probe): the headroom and balance query. RFC-003 rating: the usage-applied acknowledgement |
| Transport | (1) **In-process call**: TypeScript library inside the account owner's NestJS process; no I/O, clock or randomness. (2) **Account log**: every input and outcome is recorded in an entry of RFC-002's `account_log` (insert-only, epoch-conditional batch transactions). (3) **Kafka event**: `account.standing.v1` and `account.usage-applied.v1` go out through the owner's transactional outbox. The wire form of `account.usage-applied.v1` is C06's. `netops.enforcement_ack.v1` comes in. (4) **gRPC query** to the status replicas: headroom and balance, standing |
| Pinned to | `requirements-v1.10`; RFC-000 rev. 4.4 (§4.3, §4.6, §8); RFC-004 rev. 5 + erratum 5.1; RFC-002 rev. 5. Readers' sections: RFC-003 rev. 5 + erratum 5.1 (§5.9, §7); RFC-005 rev. 5 (§3.3, §3.6, §4.2, C3, C10); RFC-006 rev. 6 (§5.4, §5.5, §17). Neighbouring contracts, contract sections only: C06 (usage-applied acknowledgement: topic, body, encoding, dedupe key), C07 (credit-limit command: check order, answers), C08 (`SignedKeyRecord`, push and catch-up including the snapshot answer) |

**Units.** Every amount is a signed integer of **micro-USD** (µ, 10⁻⁶ USD), `bigint`. Prices
are integer **pico-USD** (10⁻¹² USD), `bigint`: per Mbps-minute for reservation prices,
per GB (10⁹ bytes) for usage prices (RFC-003 §2). Rates are integer **Mbps** (`bigint`).
Minutes are integer **UTC minutes since 1970-01-01T00:00Z** (`bigint`). Every interval is
half-open `[start, end)`, and `end = null` means open-ended. Durations are integer
**milliseconds** (`bigint`). Times of entries are database **HLC commit timestamps**. No
quantity is a JavaScript `number`, except a timestamp's logical counter and counts of
submissions. No arithmetic is floating point. Intermediate products are exact `bigint`, and
each value is rounded only where RFC-004 says (POL-11).

**Converting between ms and HLC** (review 45 m2). An instant in ms is compared with a
commit timestamp only through its wall time:

- `instant ≤ ts` ⇔ `instant × 10⁶ ≤ ts.wallNanos`.
- An instant derived from a timestamp `t`, such as `since`, is
  `ceil(t.wallNanos / 10⁶) + offset_ms`. For example, the enforcement check fires at
  `ceil(since.wallNanos / 10⁶) + 60,000`.
- A minute is `floor(ts.wallNanos / (60 × 10⁹))`.
- **Identity instants in µs** (C08 `EpochMicros`: `committed_at`, `resolved`,
  `read_timestamp`, snapshot `position`; V53-4) are compared through their wall time:
  `µs × 10³ ≤ ts.wallNanos`. `iamFresh` is held as wall nanoseconds (`µs × 10³`). The E5
  and F5 freshness gate is `ctx.ts.wallNanos ≤ iamFresh + 45 × 10⁹`. F4 `commitTs` and the
  snapshot `position` carry C08's µs value as `wallNanos = µs × 10³`, `logical = 0`.

**The lateness bound in integers** (review 45 m3). This is the only rounding of `LB`:

`LB = ceil( usage_rate_cap[Mbps] × Λ[ms] × hp*[pico-USD/GB] / (8 × 10¹²) )` µ.

Check against P3-S37: `100 × 430,000 × 10¹⁰ / (8 × 10¹²) = 53,750` µ.

## Purpose

This contract freezes the seam between booking and funds inside one account owner, and
the feeds and queries that leave it:

1. The **funds-and-standing module** has six calls: `rateCheck`, `admit`, `apply`, `due`,
   `answer` and `standing`. Its `Ask` includes queued changes ahead (`change`, `ahead`).
   `admit` and `apply` are evaluated at the **batch commit timestamp**. `Schedule` carries
   each `Part.rate` as minute pieces. The contract also fixes the payloads and variants of
   the funds entries F1 … F11, the funds payload of booking entries E1, E1′, E4 … E7 and
   E11, and the slot-level identity-freshness watermark rule that gates confirmations.
2. The **headroom and balance query**, answered at a recorded position.
3. The **standing feed and the standing query**, sent to network operations.
4. The **standing enforcement acknowledgement**, from network operations, applied as F8.
5. The **usage-applied acknowledgement**, to the extent that it is F2's output and
   rating's "publish before emit" depends on it.

Out of scope: the credit-limit command and the invoice-status feed as wire contracts.
F5 and F6, their entries, are in scope. Also out of scope: the identity status push and
catch-up (RFC-005 C3), apart from F4 and the freshness rule; the unposted-usage feed's
wire form (RFC-003), apart from what F2 consumes; and the runtime results `Moving` and
`Stopped` (platform contract, RFC-000 C4-7).

## Schema

### Primitives

```ts
type Micros = bigint;          // signed µ (10^-6 USD), POL-11
type Picos = bigint;           // pico-USD (10^-12 USD); prices
type Mbps = bigint;            // integer megabits per second
type UtcMinute = bigint;       // minutes since 1970-01-01T00:00Z
type Millis = bigint;          // duration in ms
type EpochMs = bigint;         // instant, ms since 1970-01-01T00:00Z

/** Database hybrid-logical-clock commit timestamp. Ordered by (wallNanos, logical). */
interface HlcTimestamp { wallNanos: bigint; logical: number }

type AccountId = string;       // pseudonymous (RFC-000 A11)
type PrincipalId = string;     // pseudonymous user, key or operator
type KeyId = string;
type ReservationId = string;
type PartId = string;
type InvoiceId = string;
type ProductId = string;
type RouteId = string;
type PriceVersion = string;
type RulesVersion = string;    // F10
type BatchId = string;         // a charge-line batch (RFC-003 §5.8)

/** (account partition, sequence) of an entry in the account log. A request's id is its intake's position. */
interface LogPosition { partition: AccountId; sequence: bigint }
type RequestId = LogPosition;

/** A position in the buyer's one home ledger partition (RFC-004 §B1.3). */
interface LedgerPosition { ledgerPartition: string; sequence: bigint; commitTs: HlcTimestamp }

/** C06 `RatingPosition` (monotone per account); `seq` decoded to bigint in process. Bounded size (review 45 m9). */
interface RatingPosition { ratingPartition: string; generation: number; seq: bigint }

/** Types owned by neighbouring contracts, referenced not redefined. */
import type { UsageApplied } from './C06-usage-and-charges';        // §4: topic account.usage-applied.v1
import type { SignedKeyRecord } from './C08-identity-and-access';    // §A: identity-signed key record

/** Position of an inbound feed event as applied: (producer partition, stream, stream_seq) or (topic partition, offset) for producers without an outbox. */
interface FeedPosition { source: string; partition: string; seq: bigint }

interface MinuteInterval { start: UtcMinute; end: UtcMinute | null }
```

### Context, schedule and ask

```ts
/** ts: the batch transaction's commit timestamp for admit/apply; the read timestamp for answer. */
interface Ctx { pos: LogPosition; ts: HlcTimestamp; rules: RulesVersion }

/** The part's rate in force from `from` until the next piece's `from`, or to the part's interval end. */
interface RatePiece { from: UtcMinute; mbps: Mbps }

interface Part {
  part: PartId;
  rate: RatePiece[];            // current rate after the POL-07 cut targets in force, as minute pieces (K-3; RFC-002 §9.1, §9.7)
  lockedPrice: Picos;           // per Mbps-minute
  interval: MinuteInterval;
  age: HlcTimestamp;            // request_age of the admission that added it
}

/** A recorded price step (PriceTookEffect). It re-prices every part from its minute, later parts included (RQ3-5). */
interface PriceStep { priceVersion: PriceVersion; price: Picos /* per Mbps-minute */; effectiveMinute: UtcMinute }

interface Segment { part: PartId; interval: MinuteInterval; principal: PrincipalId; key?: KeyId }

interface Schedule {
  parts: Part[];
  priceSteps: PriceStep[];      // see "Clarifications" C-2
  segments: Segment[];          // who added each piece (POL-25, J-02)
  end?: UtcMinute | null;
  effectiveMinute?: UtcMinute;
}

interface FeeTerms {
  fee: Micros;                  // shown partner fee
  kind: 'plain' | 'minimum_term';
  termEnd: UtcMinute | null;    // minimum term's end; for 'plain', the window's end
  dueAtWindowEnd: boolean;      // the booked window ends inside a minimum term (RQ-19-2)
}

type ChangeKind = 'Increase' | 'Extend' | 'Decrease' | 'Shorten';

/** An undecided change ahead in the reservation's queue, in queue order. Ending changes are never queued (RFC-002 §9.2). */
interface QueuedChange {
  request: RequestId;
  kind: ChangeKind;
  newEnd?: UtcMinute | null;    // Extend, Shorten (null: made open-ended)
  newRate?: Mbps;               // Increase, Decrease: the reservation rate requested (fingerprinted, RFC-002 §9.2)
  addedMbps?: Mbps;             // Increase: as recorded in that change's own Ask.change
  interval?: MinuteInterval;    // Increase, Extend: as recorded in that change's own Ask.change
  lockedPrice?: Picos;          // Increase: per Mbps-minute, as locked in that change's own E1 (review 45 M1, D-1)
  priceVersion?: PriceVersion;  // Increase: the catalogue price version of lockedPrice
  addingKey?: KeyId;
}

/** A key not yet applied by F4 (settled S-1, D-4). The record is C08's SignedKeyRecord, kept as the exact
 *  signed bytes received, so its signature and tenant can be re-verified from E1 on replay or audit (review 45 M4).
 *  The module derives its view (status, limits, version) from `record`; it never takes limits from elsewhere. */
interface ProvisionalKeyRecord {
  signedBytes: Uint8Array;      // the JCS-canonical record with its Ed25519 signature, verbatim (domain "share-key-record-v1")
  record: SignedKeyRecord;      // parsed from signedBytes; status, tenant, limits, version, probe
}

interface Ask {
  request: RequestId;
  principal: PrincipalId;
  key?: KeyId;
  provisionalKey?: ProvisionalKeyRecord;   // S-1: recorded verbatim in E1/E1′
  kind: 'New' | 'Increase' | 'Extend';
  scheduleAfter: Schedule;
  scheduleBefore?: Schedule;               // for a change
  change?: {
    interval: MinuteInterval;              // Extend: [old end, new end); Increase: [nb(ts), end)
    addedMbps?: Mbps;                      // Increase
    addingPrincipal: PrincipalId;
    addingKey?: KeyId;
  };
  ahead?: QueuedChange[];                  // undecided changes ahead, in order (J-01, D-1)
  feeTerms?: FeeTerms;
  mbps: Mbps;                              // capacity in flight, once, whatever the number of legs (P2-S66)
}
```

### Verdicts, inputs and outcomes

```ts
interface ResumeQuote {                    // §A3, D-5: itemised
  total: Micros;
  writtenOff: Micros;                      // W
  overdue: { invoice: InvoiceId; unpaid: Micros }[];   // oldest first
  headroomPart: Micros;                    // RH
}

/** What the check used; recorded in E1/E1′ (J-13). Booking never computes amounts (RFC-002 rule 2). */
interface Checked { headroom: Micros; keyHeadroom?: Micros }

type Verdict =
  | { kind: 'Admit'; hold: Micros; holdKind: 'Funds' | 'Credit'; mbps: Mbps; checked: Checked }
  | { kind: 'Refuse'; checked: Checked; reason:
        | { kind: 'Suspended'; ra: ResumeQuote }                          // check 1
        | { kind: 'KeyInflight'; limit: Mbps }                            // check 2
        | { kind: 'AccountInflight'; limit: Mbps }                        // check 3
        | { kind: 'InsufficientFunds'; min: Micros; minPlusLbw: Micros }  // check 4: x − h, x − h + LBW
        | { kind: 'KeySpendLimit'; keyHeadroom: Micros } };               // check 5

type RateCheckResult =
  | { kind: 'Accept' }
  | { kind: 'NotAccepted'; reason: 'rate'; retryAfterMs: Millis }
  | { kind: 'NotAccepted'; reason: 'revoked' };

type BookingInput =
  | { kind: 'Intake'; request: RequestId; ask: Ask; verdict: Verdict }               // E1, E1′
  | { kind: 'Decided'; request: RequestId;
      outcome: { kind: 'Confirmed'; reservation: ReservationId; schedule: Schedule } | { kind: 'NotConfirmed' } } // E4…E7
  | { kind: 'ReservationChanged'; reservation: ReservationId; schedule: Schedule;
      effectiveMinute: UtcMinute;                                                    // may be after ctx.ts (A-3)
      end?: { cause: EndCause; feeDue: Micros };
      feeDue?: Micros }                                                              // shorten into a minimum term (RQ3-4)
  | { kind: 'PriceTookEffect'; reservation: ReservationId; priceVersion: PriceVersion; effectiveMinute: UtcMinute };

type EndCause = 'cancelled' | 'shortened_to_end' | 'revoked' | 'released' | 'terminated' | 'window_end' | 'moved';

type Input = BookingInput | FundsEntry;    // FundsEntry: F1 … F11 below

interface HoldChange {
  target: { request: RequestId } | { reservation: ReservationId };
  from: Micros; to: Micros; holdKind: 'Funds' | 'Credit';
  state?: 'Requested' | 'Released' | 'Rolling' | 'Frozen' | 'Draining' | 'Closed';
}

type Notice =
  | { kind: 'Suspended'; stdSeq: bigint; ra: ResumeQuote }
  | { kind: 'Resumed'; stdSeq: bigint }
  | { kind: 'LowBalanceWarning'; wq: Micros }
  | { kind: 'ReleasedAfterGrace'; reservations: ReservationId[] }
  | { kind: 'PriceNotice'; priceVersion: PriceVersion; effectiveMinute: UtcMinute;
      perReservation: { reservation: ReservationId; newPrice: Picos; holdNeeded: Micros }[];
      growth: Micros; covered: boolean; topUp?: Micros };

type Alert =                                   // routed by the owner to the operational alert feed (RFC-006)
  | { code: 'ENFORCEMENT_ACK_MISSING'; stdSeq: bigint; target: EpochMs }            // operations, at since + 60 s (D-3)
  | { code: 'LATE_ENFORCEMENT'; stdSeq: bigint; target: EpochMs; enforcedAt?: EpochMs } // operations and finance, once per stdSeq (D-3)
  | { code: 'ENFORCEMENT_ACK_CONFLICT'; stdSeq: bigint; first: EpochMs; second: EpochMs }
  | { code: 'ENFORCEMENT_ACK_UNEXPECTED'; stdSeq: bigint; enforcedAt: EpochMs }     // unknown or future stdSeq only (m14, V53-2)
  | { code: 'KEY_ABSENT_FROM_SNAPSHOT'; key: KeyId };                                // applied key missing from a catch-up snapshot (m8)

/** Rows the owner writes to its outbox in the same transaction (RFC-002 §2.5 "events"). */
type OutboxEvent =
  | { stream: 'standing'; event: StandingEvent }
  | { stream: 'usage_applied'; event: UsageApplied };   // C06's body (review 45 M6, D-5)

interface Outcomes {
  holdChanges: HoldChange[];
  standing?: { from: Standing; to: Standing; stdSeq: bigint; causes: Cause[]; ra?: ResumeQuote };
  warning?: { wq: Micros };
  notices: Notice[];
  releaseDue?: ReservationId[];            // F7 grace ended: booking writes E11 releases in the same entry
  revokedKeys?: KeyId[];                   // F4: every key whose applied status becomes revoked, from active OR from absent
                                           // (first applied as revoked, D-4); booking writes "key revoked" endings in the same entry
  alerts: Alert[];
  outbox: OutboxEvent[];
}

type Standing = 'active' | 'suspended';
type Cause = 'headroom' | 'invoice' | 'written_off';
```

### Funds entry kinds F1 … F11

```ts
type FundsEntry = F1 | F2 | F3 | F4 | F5 | F6 | F7 | F8 | F9 | F10 | F11;

interface F1 { kind: 'F1'; ledgerPos: LedgerPosition; feed: FeedPosition[];
  movements: { movementKind: string /* M1…M23, RFC-004 §B2 */; amount: Micros; sourceRef: string;
               cause?: { invoice?: InvoiceId };                       // an M19 names its invoice
               batch?: { batch: BatchId; batchKind: 'reservation' | 'usage'; postedWhole?: boolean /* usage only */ } }[];
  balance: Micros;                                                    // Bal
  writtenOffOwed: Micros;                                             // W
  postedThrough: { allThrough?: UtcMinute; exceptions: { reservation: ReservationId; through: UtcMinute }[] };
  feesPosted: ReservationId[] }

interface F2 { kind: 'F2'; feed: FeedPosition;
  perProduct: { product: ProductId; unposted: Micros /* U(X) */ }[];
  ratingPos: RatingPosition;
  computedAgainst: LedgerPosition;                                    // X
  inFlight?: { batch: BatchId; reduction: Micros /* Δ_b */ } }

interface F3 { kind: 'F3'; cataloguePos: FeedPosition;
  perProduct: { product: ProductId; usageRateCap: Mbps; maxLateness: Millis; flowActiveTimeout: Millis;
                attributionLagMax: Millis; rtoAdm: Millis;
                highestUsagePrice: { inForce: Picos /* per GB */; changes: { effectiveAt: EpochMs; price: Picos }[] } }[] }

type IdentityStatusChange =
  | { kind: 'key'; key: KeyId; version: bigint; status: 'active' | 'revoked';
      keySpendLimit?: Micros; keyInflightLimit?: Mbps; keyRateLimit?: bigint }
  | { kind: 'kyb'; version?: bigint; status: 'passed' | 'failed' | 'withdrawn' | 'none' };

type F4 = { kind: 'F4' } & (
  | { source: 'push' | 'catch_up';
      events: (IdentityStatusChange & { identityPos: { partition: string; sequence: bigint }; commitTs: HlcTimestamp })[] }
  | { source: 'snapshot';                                             // C08 catch-up answer for since older than 7 days (m8)
      position: HlcTimestamp;                                         // the snapshot's consistent-read timestamp
      keys: Extract<IdentityStatusChange, { kind: 'key' }>[];         // every key of the account, full state
      kyb: Extract<IdentityStatusChange, { kind: 'kyb' }> } );
// No completeThrough / id_ts: the timestamp skip rule is deleted (review 45 M3). Dedupe is by
// (identity partition, sequence) plus, per key, the highest version.

type F5 = { kind: 'F5' } & (
  | { variant: 'set'; amount: Micros; principal: PrincipalId; reason: string; actionId: string;
      member?: AccountId;                                             // set-scoped (probe accounts)
      setScope?: { mapVersion: bigint;                                // the signed v: recorded for audit, NOT checked (D-2, C07 S1)
                   designatedAtMapVersion: bigint };                  // from the applied F9 that designated the account
      iamFreshUsed: HlcTimestamp }                                    // S-3: required (m6)
  | { variant: 'removed_by_operator'; principal: PrincipalId; reason: string; actionId: string }
  | { variant: 'removed_invoice_written_off'; invoice: InvoiceId; rcvPos: FeedPosition; ledgerPos: LedgerPosition;
      decidedAt: HlcTimestamp;                                        // C07 decided_at: receivables' deciding entry
      superseded?: boolean } );                                       // C07 R37-03: true when a later F5 'set' is in force

type F6 = { kind: 'F6'; rcvPos: FeedPosition; ledgerPos: LedgerPosition } & (
  | { variant: 'overdue'; invoice: InvoiceId; unpaid: Micros; dueDate: UtcMinute }
  | { variant: 'paid'; invoice: InvoiceId }
  | { variant: 'written_off'; invoice: InvoiceId; amount: Micros } );

type F7 = { kind: 'F7'; instant: EpochMs } & (
  | { variant: 'fee_term_ended'; reservation: ReservationId }
  | { variant: 'grace_ended' }
  | { variant: 'enforcement_check'; stdSeq: bigint; at: 60 | 120 }   // seconds after since; suspensions only (D-3)
  | { variant: 'price_effective'; priceVersion: PriceVersion; reservations: ReservationId[] }
  | { variant: 'exposure_step'; product: ProductId } );

interface F8 { kind: 'F8'; feed: FeedPosition; stdSeq: bigint; enforcedAt: EpochMs }
interface F9 { kind: 'F9'; excluded: boolean; mapVersion: bigint /* the designating slot-map version (C07 S1) */ }
interface F10 { kind: 'F10'; rules: RulesVersion }
interface F11 { kind: 'F11'; priceVersion: PriceVersion; route: RouteId; newPrice: Picos /* per Mbps-minute */;
  effectiveMinute: UtcMinute; catalogueRef: string; reservations: ReservationId[] }
```

### The module interface

```ts
/** Opaque, immutable. Rebuilt from projection rows or by replay of the log. */
interface FundsState { readonly __brand: 'FundsState' }
/** Owner-memory submission timestamps per key and account in the last second; never logged. */
interface RateWindows { readonly __brand: 'RateWindows' }

interface PrincipalCtx { principal: PrincipalId; tenant: AccountId; key?: KeyId; provisionalKey?: ProvisionalKeyRecord /* S-1 */ }

interface DueTick { instant: EpochMs; payload: F7 }

interface FundsModule {
  /** Owner clock. Logs nothing. Reads the key status as applied by F4 (JR-1). */
  rateCheck(soft: RateWindows, nowMs: EpochMs, who: PrincipalCtx): RateCheckResult;

  /** Decisive only inside the batch transaction, with ctx.ts its commit timestamp. Evaluated
   *  on the state left by every earlier entry of the account, earlier entries of the same batch included. */
  admit(s: FundsState, ctx: Ctx, ask: Ask): Verdict;

  /** The only state transition. An F7 with instant × 10⁶ > ctx.ts.wallNanos returns Deferred, and nothing changes. */
  apply(s: FundsState, ctx: Ctx, input: Input):
    | { kind: 'Applied'; state: FundsState; outcomes: Outcomes }
    | { kind: 'Deferred' };

  /** Instants for the five F7 variants. */
  due(s: FundsState): DueTick[];

  /** ctx.ts: the read timestamp (answer.evaluatedAt). Pure. Reads applied state only (m4). */
  answer(s: FundsState, ctx: Ctx, who: PrincipalCtx): HeadroomAnswer;

  standing(s: FundsState): { standing: Standing; since: HlcTimestamp | null; stdSeq: bigint };
}
```

### Headroom and balance query (gRPC, status replicas)

```ts
// service AccountStatusReader { rpc Headroom(HeadroomRequest) returns (HeadroomAnswer); rpc Standing(StandingRequest) returns (StandingAnswer); }
interface HeadroomRequest {
  account: AccountId;
  routing: { slot: number; generation: bigint; mapVersion: bigint };  // from placement's slot map
  // the principal comes from the authenticated principal context (RFC-005 C1), never from the body
}

interface HeadroomAnswer {
  position: { log: LogPosition;
              ts: HlcTimestamp;            // commit timestamp of the entry at position.log
              ledger: LedgerPosition; rating?: RatingPosition };
  evaluatedAt: HlcTimestamp;               // ctx.ts: the read timestamp answer() was evaluated at (m4)
  headline: Micros;                        // h; for an agent key kh_k (P4-S55)
  headlineKind: 'account' | 'key';
  key?: { key: KeyId; spending: Micros /* KS_k */; limit: Micros /* ksl_k */; keyHeadroom: Micros };
  items: {
    balance: Micros;                       // Bal at position.ledger (P4-S17)
    fundsHeld: Micros;                     // F
    creditHolds: Micros;                   // the part of F labelled credit (P4-S13)
    usageExposure: { product: ProductId; unposted: Micros /* U */; latenessBound: Micros /* LB */ }[];
    accruedNotPosted: Micros;              // A, "within funds held"
    creditLimit: Micros;                   // CL, 0 if none
    headroom: Micros;                      // h = Bal − F − ΣX + CL, always present (probe check)
  };
  standing: { standing: Standing; causes: Cause[]; ra?: ResumeQuote; overdue?: { invoice: InvoiceId; unpaid: Micros }[] };
  lowBalanceThreshold: Micros;             // LBW
}
type HeadroomError =
  | 'RETRY'        // replica cannot serve; the client retries another
  | 'MOVED'        // the replica has applied the partition's `moved` entry
  | 'NOT_FOUND';   // the principal context's tenant is not this account, or the principal is a supplier (m5); reveals nothing
```

JSON encoding: every `bigint` is a decimal string, every `HlcTimestamp` is the string
`"<wallNanos>.<logical, 10 digits>"`, and every `EpochMs` is a decimal string.

### Standing query (gRPC, status replicas)

```ts
interface StandingRequest { account: AccountId; routing: HeadroomRequest['routing'] }
interface StandingAnswer {
  account: AccountId; standing: Standing; since: HlcTimestamp | null; stdSeq: bigint;
  position: { log: LogPosition; ts: HlcTimestamp };
}
```

### Kafka messages

| Topic | Key | Producer | Headers (RFC-006 §5.4) |
|---|---|---|---|
| `account.standing.v1` | account partition | Account owner: direct publish after commit (about 50 ms, est.), with the changefeed relay as the guaranteed path | `partition`, `stream` = `standing`, `stream_seq`, `generation`, `epoch`, `ts`, `kind` = `StandingChanged`, `schema_v`, `key_id` |
| `account.usage-applied.v1` | **Defined by C06 §4** (topic, key, body `UsageApplied`, encoding, `EventId`) | Account owner (same two paths) | Per C06. C05 owns only the semantics below |
| `netops.enforcement_ack.v1` | account | Network operations | `schema_v`; mTLS producer identity (RFC-005 §2) |

```ts
interface StandingEvent {               // RFC-004 §A8. Carries no cause.
  account: AccountId;
  stdSeq: bigint;
  standing: Standing;
  since: HlcTimestamp;                  // commit ts of the entry that changed standing
  decisionPosition: LogPosition;
}

// Usage-applied acknowledgement: C06's `UsageApplied` (appliedThrough, appliedTs, inFlightUsageBatch, eventId),
// plus `entry` (the F2 entry's LogPosition), which C06 adds (Consumer obligations). Not redefined here.

interface EnforcementAck {              // RFC-000 §8; RFC-004 §A8
  account: AccountId;
  stdSeq: bigint;
  enforcedAt: EpochMs;                  // when usage-priced traffic was blocked or unblocked, network operations' clock
}
```

### Gap recovery for usage-applied acknowledgements (no cross-owner read)

No consumer reads the account owner's tables (RFC-000). If rating finds a gap in
`eventId.streamSeq` on `account.usage-applied.v1`, it recovers as follows:

1. **Topic replay.** The topic is retained for **at least 7 days**. Sizing (est.,
   review 45 m9): 25,000–50,000 acknowledgements a second (RFC-003; RFC-004 §A11)
   × 604,800 s ≈ 1.5–3.0 × 10¹⁰ events. At about 200 B each, that is about 3–6 TB per copy,
   or 9–18 TB at replication factor 3.
2. **`usage_applied_since`**, for events older than the topic retention, or if replay does
   not fill the gap.

```ts
// gRPC on RFC-002's account status readers (the account owner component), never on the owner's write path (m10)
interface UsageAppliedSinceRequest {
  accountPartition: AccountId;
  afterStreamSeq: bigint;               // the last C06 eventId.streamSeq rating has applied for the account's usage-applied stream
  limit?: number;                       // default 1,000 events
}
interface UsageAppliedSinceAnswer {
  events: UsageApplied[];               // C06's events, byte-identical in content, in streamSeq order, contiguous
  throughStreamSeq: bigint;             // the highest streamSeq committed for the stream at the read
  more: boolean;                        // true: call again from the last streamSeq returned
}
type UsageAppliedSinceError = 'RETRY' | 'MOVED' | 'NOT_FOUND' /* not rating's service principal */;
```

Events are rebuilt **from the account log**, using live rows by follower read, or history's
sealed segments for older rows. Each log row lists the `(stream, stream_seq)` of the events
it emitted (`emits`, RFC-006 §3), and RFC-006's versioned emit function turns that row back
into the C06 event. So `streamSeq` and the content are reproduced exactly, for 7 years.

- The query is read-only and idempotent.
- Only rating's service principal may call it (RFC-005 C1).
- An answer covers committed entries only.

Network operations recovers a gap in `account.standing.v1` through the standing query.

**Value of the query** (review 45 m10, recorded and not changed, S-4). A missing
acknowledgement only delays the "counted" time of its records until the next
acknowledgement. Beyond 7 days, attribution lag is already breached. The query is kept
because S-4 is binding, and it is served off the write path.

## Semantics

### Calls of the module

All six calls are pure and deterministic. Arithmetic is integer only. Reservations are
iterated in `(start_r, id)` order and keys in id order. Time comes only from `ctx.ts`
(`nowMs` for `rateCheck` alone). Every parameter comes from state applied by an entry, and
the rules from F10 (RFC-004 §A10).

| Call | Preconditions (caller) | Outcome | Errors and special results |
|---|---|---|---|
| `rateCheck` | A booking submission (never a poll, P2-S68) has arrived at the owner and passed the tenant and key checks of RFC-002 §3.1 | `Accept`. `NotAccepted{rate, retryAfterMs}` when the submission is over `key_rate_limit` or `account_rate_limit` in the sliding second ending at `nowMs`; nothing is logged and the idempotency key is not consumed (P2-S41). `NotAccepted{revoked}` when the key is revoked as applied by F4; it is checked before anything else, and the booking module treats the submission as unauthenticated (X1-S06, JR-1) | For one second after an owner change, a key or account may be admitted up to twice its limit (B-AI-4, JR-3) |
| `admit` | Called once per intake, in the account's arrival order, **inside the batch transaction after it has read its commit timestamp** (`ctx.ts`). It counts the holds and capacity in flight of every request then undecided. Any call before that is provisional and only orders submissions. A pushed transaction re-evaluates the whole batch in sequence order (J-03) | Checks 1 to 5 of RFC-004 §A5.1, in order. `x` is sized by §A5.2: for a new reservation, `R_r`; for a change with nothing ahead, `R_r(after) − R_r(before)`; for a change with `ahead`, the **envelope** (ρ⁺, e⁻, e⁺). In ρ⁺(m), each part, whether committed or added by an Increase ahead (at its `addedMbps` over its `interval`), is priced at `max(its locked price, the price of a recorded step in force at m)`. The locked price of an Increase ahead is `QueuedChange.lockedPrice` (D-1, V-3). On `Admit`, `hold = x`. Both verdicts return `checked` (the headroom and key headroom the checks used), recorded in E1/E1′ (m13). A provisional key's limits and status come only from `provisionalKey.record`, and only while the key is absent from applied state (S-1). Reductions (decrease, shorten, cancel) are never passed to `admit` (POL-08, P2-S77) | `Refuse` is recorded as E1′ with the Ask, the verdict, and the headroom and key headroom checked against (J-13). A refusal caused by the hold of a request in flight stands even if that request later releases it (P2-S112) |
| `apply(Intake)` | E1 (admitted) or E1′ | E1 adds `h_q` and `mbps_q`. E1′ holds nothing | — |
| `apply(Decided)` | E5, or E4/E6/E7, in the deciding entry. For an addition, E5 is composed only if `standing(S)` is active at that position (P2-S69) | `Confirmed`: `h_q` becomes the hold. For a new reservation `H_r = R_r`. For a change, `H_r = R_r(after)` and the excess `h_q − (R_r(after) − R_r(before))` is released when positive (D-1). `NotConfirmed`: `h_q` and `mbps_q` are released (P4-S12) | A shortfall from posting drift is a failed roll-forward (§A7); the confirmation stands (P2-S70) |
| `apply(ReservationChanged)` | E11; `effectiveMinute ≥ nb(ts)`, except a POL-07 cut at `T_eff`, a revocation (a cut to 0) included (S-5) | The hold is resized or ended by §A6. A recorded future end or cheaper schedule lowers `R_r` at once. A due fee sets `fee_state → due` | — |
| `apply(PriceTookEffect)` | Carried by the one price-change E11 per (account, price version), written in the F11 entry | Records the step in `sched_price_r`. The hold grows only at F7 `price_effective` | — |
| `apply(F1 … F11)` | The owner built the entry from a feed, command or timer. F2 is composed only once the applied `ledger_pos` ≥ X. F5 (`removed_invoice_written_off`) and F6 only once the applied `ledger_pos` ≥ the event's `ledgerPos`, in `rcvPos` order (the gate, §A4) | The apply rules of §A4 (table below). Standing is evaluated after every entry (§A7) | F7 with `instant × 10⁶ > ctx.ts.wallNanos` returns `Deferred`, and the owner commits it in a later batch (J-10) |
| `due` | — | The instants of fee-term ends, the grace end, enforcement checks for a suspension only (at `ceil(since.wallNanos / 10⁶) + 60,000` and `+ 120,000`, D-3), price-effective minutes and exposure steps | — |
| `answer` | Status replicas only, on the state at one position, `ctx.ts` = the read timestamp | `HeadroomAnswer` (§A9) | — |
| `standing` | — | The current standing, `since` and `std_seq` | — |

**Endings in the same entry** (RFC-002 rule 5). When the outcomes carry `standing → suspended`,
`revokedKeys` or `releaseDue`, the booking module writes, **in that same entry**, the
ending of every undecided addition (rejected, "account suspended", with the itemised `RA`),
the ending of each revoked key's undecided requests (failed, "key revoked"), or the E11
release of each listed reservation, respectively. The funds module never ends a request or
a reservation.

**Order inside an entry** (RFC-002 rule 3). In a booking entry the booking record comes
first, then the funds payload. In a funds entry the funds payload comes first, then the
booking records its outcomes require.

### Funds entries: when appended and what they do

| Kind | Variants | Appended when | Apply rule (RFC-004 §A4) |
|---|---|---|---|
| F1 | — | Ledger movement-feed events for the account have arrived. One entry may cover several movements in one batch | Updates `Bal`, `W`, `p_r`; rolls or consumes holds; adds the newly posted minutes to `KP_k`; marks posted fees `charged`; removes from `OD` the invoice named by an applied M19. A downward amendment (for example "late POL-07 cut", P4-S117) raises `Bal` like any credit, and standing is re-evaluated, so it can resume the account. Re-applies a pending `Δ_b` if a usage batch is now reported posted whole and the current F2 still names it |
| F2 | — | A rating figure has arrived **and** the applied `ledger_pos` ≥ X. Only the latest figure per account in a batch is applied | `U[product] = U(X) − Δ_b` if an applied F1 at or below the current position reports `b` posted whole, else `U(X)`. Reservation batches never enter `U`. Standing is evaluated. The outbox gets C06's `UsageApplied` |
| F3 | — | An account-product term changes (at its effective minute), or a `usage_price` change is **announced** | Recomputes `LB` by the integer formula under Units (Λ = 430 s at the defaults, `hp*` over `[ts − (Λ − 60 s), ts + 60 s]`) and arms the exposure steps |
| F4 | `push`, `catch_up`, `snapshot` | Push or catch-up, **only for an actual status change** of a key (status, limits) or of KYB. Never for an event-free heartbeat or catch-up. A C08 snapshot answer gives one F4 `snapshot` per account that has a difference | Updates keys and `kyb`. An event already applied, by (identity partition, sequence), is a no-op. Per key, an event whose version is not above the applied version is a no-op. There is **no timestamp skip** (M3). `revoked` is terminal. `snapshot` replaces the account's applied state with the snapshot: keys in it are applied by version; an applied key absent from it is **revoked as applied**, with `KEY_ABSENT_FROM_SNAPSHOT` alerted (m8). `revokedKeys` lists every key whose applied status becomes revoked, including one first applied as revoked (from absent, D-4) |
| F5 | `set`, `removed_by_operator`, `removed_invoice_written_off` | `set` and `removed_by_operator`: the credit-limit command. `removed_invoice_written_off`: the invoice-status feed, behind the gate | `set` and `remove`, in **C07's frozen order** (Operation 2, R37-01; V53-1): (1) authenticity, C08 checks 1–2; (2) dedupe by (`actionId`, account): a repeat answers the recorded first outcome, whatever changed since (F9, `not_after`, the operator's role, freshness); the same `actionId` with different content is `refused{conflict}`; (3) operator freshness, C08 checks 3, 5 and 6 for a single target; (4) scope, set-scoped only: `member` is this account **and** its applied F9 has `excluded` on; the signed v is recorded in `setScope.mapVersion` with `designatedAtMapVersion` and is **not** checked (D-2, C07 S1); otherwise `out_of_scope`; (5) validity, otherwise `refused{invalid}`, recorded; (6) KYB, `set` only: **first the `iamFresh` gate**, so if `ctx.ts.wallNanos > iamFresh + 45 × 10⁹` or `iamFresh` is unset, nothing is appended and the answer is C07's `temporarily_unavailable{identity_stale}` (S-3); then `refused{kyb_not_vetted}` unless `kyb = passed`. A refusal is recorded and changes nothing. Otherwise `set` sets `CL` and `mode`, relabels holds, and may suspend. `removed_invoice_written_off`: removes `CL`, but is **recorded as superseded, with no change**, if the `CL` in force was set by an F5 `set` committed after the event's `decidedAt` (C07 R37-03) |
| F6 | `overdue`, `paid`, `written_off` | The invoice-status feed, behind the gate, in `rcvPos` order | `overdue` adds to `OD`. `paid` and `written_off` remove from `OD` (a no-op if the M19's F1 already did) |
| F7 | `fee_term_ended`, `grace_ended`, `enforcement_check`, `price_effective`, `exposure_step` | The owner's timer from `due(S)`, committed only with `ts ≥ instant` | Each variant's time-driven change. `grace_ended` yields `releaseDue` (JR-2). `enforcement_check` (suspensions only, D-3) at 60 s: no check if a later standing transition has committed. Otherwise, if no F8 for that `stdSeq` has been applied, raise `ENFORCEMENT_ACK_MISSING` (operations). At 120 s, if there is still no F8 and no later transition, raise `LATE_ENFORCEMENT` (operations and finance) |
| F8 | — | An `EnforcementAck` is consumed | Recorded. For a suspension's `stdSeq`: `LATE_ENFORCEMENT` is raised if `enforcedAt > ceil(since.wallNanos / 10⁶) + 60,000`, unless the 120 s check already raised it (once per `stdSeq`, D-3; P4-S27). An ack at or before the target is on time however late it is delivered. An ack for a **recorded** `stdSeq` lower than the current one (a fast suspend → resume) is recorded with no alert and no late check, because a later transition has committed (D-3, V53-2). Only an ack for an unknown or future `stdSeq` is recorded with `ENFORCEMENT_ACK_UNEXPECTED`. Neither changes state or another `stdSeq`'s check (m14) |
| F9 | — | Placement's probe designation | `excluded`: never rated; `p_r` follows the clock; `H_r` is re-evaluated at every apply (§A3, J-11) |
| F10 | — | Deployment of a new rules version | Later entries are evaluated with it, and replay uses the version recorded |
| F11 | — | The catalogue announces a price change for open-ended reservations, `price_notice` ahead. Idempotent by (account, price version) | No state change. The outcome is the `PriceNotice`. The booking module writes, in the same entry, the one price-change E11 with `PriceTookEffect` per reservation (JR-4) |

### Identity-freshness watermark (slot level)

- `iamFresh` is kept by the **booking module**, **per account slot, in owner memory**, and
  is never written to an entry. Settled definition (S-2, as amended by review 45 M2, D-6),
  counting only **applied** events:

  `iamFresh = max( min over the identity-push partitions feeding the slot of R_applied(p), the read timestamp of the last catch-up whose entry has committed )`

  `R_applied(p)` is the latest resolved timestamp R of partition p such that every event of
  p at or below R has been applied (its F4 committed, or found a no-op), and no
  `stream_seq` gap lies below it. An event in a gap buffer holds `R_applied(p)` below that
  event.

  A catch-up's read timestamp, or a snapshot's position, counts only once the entry that
  applies it has committed, or at once when it brought no status change.

  Resolved timestamps and catch-ups move `iamFresh` whether or not they carry events. A
  heartbeat on one partition alone never advances it past a lagging partition.
- After any acquisition (takeover, handoff, lapsed renewal, re-home, `adopt`) it is
  **unset**. It is set again only by the catch-up, which the holder pulls before deciding
  anything, or once **every** partition feeding the slot has delivered an applied resolved
  timestamp since the acquisition. Any holder pulls when `now − iamFresh > 20 s`, and then
  every 5 s until fresh.
- **E5 commits only if `ctx.ts ≤ iamFresh + 45 s`.** The `iamFresh` used is recorded in
  the E5, and an unset watermark fails the check. A confirm that fails the check is
  deferred, and the request may reach its deadline.
- An F5 `set` (single or set-scoped) is composed only under the same condition, applied
  inside the KYB step of C07's order, with `iamFreshUsed` recorded. When the slot is stale,
  nothing is appended and the answer is C07's `temporarily_unavailable{identity_stale}`,
  which is never final (S-3). A repeated `actionId` is deduplicated earlier and answers its
  recorded first outcome. An invalid `set` on a stale slot gets the recorded
  `refused{invalid}`.
- The funds module neither reads nor computes `iamFresh`. F4 records no timestamp
  watermark (M3).

### Headroom and balance query

Status replicas serve it, never the owner's write path. They evaluate `answer` on the
state at one account-log position: either the state the owner pushed under a live read
lease, or a bounded-staleness follower read of the projection rows through a replica in the
reader's own facility. `position` states the account-log position, the commit timestamp of
the entry at that position (`position.ts`), the ledger position of `Bal` and the rating
position of `U`. `evaluatedAt` is the read timestamp `answer` used.

`answer` reads **applied state** (m4): `LB`, `H_r`, price steps and standing as the entries
up to `position.log` left them. It never re-derives them at the read timestamp. Only `A`
(through `m_now = minute(evaluatedAt)`) and the `key_spend_period` boundary of `KP_k` use
`evaluatedAt`. P4-S72's rebuild therefore replays to `position.log` and evaluates at
`evaluatedAt`.

Read-only, with any number of retries. An answer never gates a decision (§A9): decisions
are taken in entries. A replica that has applied the partition's `moved` entry answers
`MOVED`. One that can serve neither from a live lease nor from a follower read answers
`RETRY`. **The replica re-checks the principal context itself** (RFC-005 C1 receiver
obligation): if the tenant is not the account, or the principal is a supplier user or key,
it answers `NOT_FOUND`, which does not reveal whether the account exists (m5).

For an agent key, `headline` is `kh_k = min(h, ksl_k − KS_k)` and `key` is filled. For
every other principal, the probe key included, `headline` is `h`. `items.headroom` is
always `h`, so a probe can check `h = Bal − F − ΣX + CL` (RFC-006 §17).

### Standing feed

There is one `StandingEvent` per **standing transition**: suspension, or resumption with
holds restored. It carries a new `stdSeq`, increasing by one per account. A cause added
while the account is already suspended emits nothing (§A7). The event is written as an
outbox row in the transaction of the entry whose outcome changed standing. Its `since` is
that entry's commit timestamp.

### Standing query

Network operations calls it at any time. The answer is the current standing, `since` and
`stdSeq` at a stated position (P4-S26).

### Enforcement acknowledgement

Network operations publishes it once it has blocked (suspension) or unblocked (resumption)
usage-priced traffic for that `stdSeq`. The owner applies it as F8. Only suspensions are
checked (X2-S08 bounds suspension only), by F7 entries at 60 s and 120 s after `since`
(D-3). Whether enforcement was late is therefore decided in the log, never by a clock read
(P4-S27).

- Operations sees a missing acknowledgement at 60 s.
- Finance sees only a confirmed late (`enforcedAt` after the target) or an acknowledgement
  still missing at 120 s, each reported once.
- Under a fast suspend → resume, where network operations applies only the higher
  `stdSeq`, the earlier suspension is not reported, because a later transition has
  committed.

`enforcedAt` is on network operations' clock. The contract assumes that clock is within the
database's `max_offset` of the database clock domain (RQ-45-1, raised to requirements).

### Usage-applied acknowledgement

Exactly one C06 `UsageApplied` is written as an outbox row **in each F2 entry's
transaction**, and published after that transaction commits. It carries the rating
position that F2 applied as `appliedThrough`, and the F2's commit timestamp as
`appliedTs`. C06 owns its topic, body, encoding and dedupe key (D-5). There is none while F2 is held by the X gate, and none for probe
accounts, which get no figures. Rating relies on it for two things:

- **Publish before emit**: rating emits a gated usage batch only after an acknowledgement
  whose `appliedThrough` covers a figure naming that batch as in flight.
- **Attribution lag**: `appliedTs` is the time a record was counted (RFC-003 §5.9).

## Delivery and ordering

| Path | Guarantee | Ordering scope | Duplicate handling |
|---|---|---|---|
| In-process calls | Synchronous, exactly once per evaluation. Re-evaluation on a pushed transaction is part of the contract | The account's log sequence. Entries of one batch share `ts` and are ordered by sequence | — |
| Funds inputs (F1, F2, F4, F6, F8, F5 feed variant, F3/F9/F11 from catalogue and placement) | At least once from Kafka. **Exactly-once effect**: the owner checkpoints each feed's position in the entry that applies it (RFC-006 §5.5), and Kafka offsets are only restart hints | Per producer partition and stream (`stream_seq`), gaps buffered. F2 is held until X; F5/F6 are held until their `ledgerPos`. Held invoice events persist in `funds_*` | An event at or below the applied position is a no-op |
| `account.standing.v1` | At least once; owner publish within about 50 ms of commit, relay within about 1 s (est.), both inside `standing_notice_time` 10 s | Per account partition, `stream_seq` contiguous across owner changes and moves | Consumer drops by (partition, stream, `stream_seq`). Network operations applies an event only if its `stdSeq` is above the last applied (P4-S25) |
| `account.usage-applied.v1` | Per C06: at least once, two publish paths, retained ≥ 7 days | Per account, by `eventId.streamSeq` | Per C06: (account, `appliedThrough`); `appliedThrough` monotone |
| `netops.enforcement_ack.v1` | At least once | Per account (Kafka key) | Idempotent by (account, `stdSeq`), see Idempotency |
| Headroom and standing queries | Synchronous request/response; the client retries `RETRY` and `MOVED` | — | Read-only |

## Idempotency

| Input | Key | On duplicate | Same key, different content |
|---|---|---|---|
| E1/E1′ (via the booking idempotency index) | (account, idempotency key) | The request's current status, no entry (RFC-002 §3.1) | Not accepted, as key reuse |
| F1 | (ledger partition, epoch, sequence) per movement | No effect | Not possible: the ledger is single-writer |
| F2 | Rating position | No effect. An older figure is ignored | — (absolute values; the latest wins) |
| F4 | (identity partition, sequence); per key, the highest version wins. No timestamp skip (M3). A snapshot is applied by version | No effect | The lower version is ignored |
| F5 command variants | (`actionId`, account), checked second, after authenticity and before operator freshness, scope, validity and KYB (C07 order, V53-1) | The recorded first outcome is answered, even when the slot is stale, F9 changed or the envelope's `not_after` passed | Refused as a conflict, recorded |
| F5 feed variant, F6 | (receivables partition, epoch, sequence), in `rcvPos` order | No effect | — |
| F7 | (variant, instant, subject) | Re-arming after takeover finds the tick already applied | — |
| F8 | (account, `stdSeq`) | No effect | First applied wins; `ENFORCEMENT_ACK_CONFLICT` alerted (C-6). A recorded earlier `stdSeq`: recorded, no alert. An unknown or future `stdSeq`: recorded, `ENFORCEMENT_ACK_UNEXPECTED` (m14, V53-2) |
| F11 | (account, price version) | No effect | — |
| `StandingEvent` at consumers | (partition, stream, `stream_seq`); semantically `stdSeq` | No effect | — |
| `UsageApplied` at rating | Per C06: (account, `appliedThrough`) | No effect | Not possible |

## Ownership

| Data | Writer | Readers |
|---|---|---|
| Funds payloads in E1, E1′, E4 … E7, E11; entries F1 … F11; `funds_*` projection rows; outbox rows of streams `standing` and `usage_applied` | The account owner's lease holder only, in epoch-conditional batch transactions. Values are computed by the funds module (RFC-004); appends and booking records are done by the booking module (RFC-002) | The owner's hot standby, replay and history (RFC-006, 7 years); status replicas. No other component reads these rows. Rating gets usage-applied events from the topic or from `usage_applied_since` |
| Funds state rules (formulas, apply rules, rules versions) | RFC-004 Part A | — |
| `iamFresh` (owner memory) | The booking module of the slot's lease holder | The booking module (E5 gate; F5 `set` gate, S-3) |
| Rate windows (owner memory) | Funds rule, held by the owner | `rateCheck` only |
| `EnforcementAck` | Network operations | The account owner (as F8) |
| Key status and limits, KYB | Identity and access (RFC-005) is the writer. The module holds the **applied copy** | Booking reads revocation through `rateCheck` and F4's outcome |

No role may update or delete a log, decision or outbox row (RFC-002 §2.5).

## Timeouts and deadlines

| Item | Value | Source |
|---|---|---|
| `admit` at intake | Inside entry 1's budget. In-transaction evaluation about 0.1 ms per entry (est.) | RFC-000 §3, RFC-002 §2.5 |
| Funds hold made before any capacity hold | Always in the intake entry | POL-25, P2-S92 |
| Queued change excess held | At most until the change's decision (≤ 60 s) | §A5.2 |
| Standing published to network operations | ≤ `standing_notice_time` 10 s after the deciding entry | X2-S17, P4-S25 |
| Suspension to enforcement | 60 s. F7 `enforcement_check` at `since + 60 s` (missing acknowledgement, to operations) and at `+ 120 s` (late, to finance), suspensions only | X2-S08, P4-S27, D-3 |
| F4 applied after an identity change | ≤ 60 s | POL-25, RFC-005 C3 |
| `iam_pull_after` / `iam_pull_period` / `iam_fresh_max` | 20 s / 5 s / 45 s | RFC-005 C3 |
| `exposure_publish_interval` (F2 input rate) | ≥ 2 s between figures per account | RFC-003 §5.9 |
| F2 apply lag alarm | > `attribution_lag_max` (10 s) | RFC-004 §A7, RFC-002 §13.2 |
| Top-up to credited headroom | ≤ 10 s p99 (F1 apply) | X2-S07 |
| Headroom answer | ≤ 200 ms (wallet probe), `slot_probe_limit` 1 s for the per-slot rule | X2-S18, RFC-006 §17 |
| Grace before release | `suspension_grace` = `CW` = 24 h | POL-16 |
| Rate-count inexactness after an owner change | 1 s | B-AI-4 |

## Versioning and compatibility

- **Rules version** (F10). A change to any formula, check order or apply rule is a new
  `RulesVersion`, effective from the F10 position. The library keeps every earlier version
  evaluable, because replay of any entry uses the version it recorded (P4-N16). A rules
  change never alters a logged figure.
- **Entry kinds** are a closed registry (RFC-002 §2.3). A new F kind, or a new variant of
  F5, F6 or F7, needs a contract revision, a new `schema_v` and a rules version. Optional
  fields may be added within a `schema_v`, and readers ignore unknown fields. Removing or
  re-typing a field needs a new `schema_v`, and readers decode every `schema_v` for 7 years
  (schema registry, RFC-006 §5.4).
- **Library API.** The TypeScript signatures above are versioned with this contract. A
  breaking change needs a new contract version agreed by RFC-002 and RFC-004 together
  (their joint acceptance, RFC-000 §7, R11).
- **Topics.** C06 versions `UsageApplied`. A breaking change to `StandingEvent` or
  `EnforcementAck` is a new topic `….v2`, published beside `v1` until every consumer has moved. Within `v1`,
  changes are additive only.
- **Query.** New response fields are additive. `items.headroom` and `position` are never
  removed, because the probes depend on them.

## Scenarios relied on

`requirements-v1.10`: P2-S38, P2-S39, P2-S40, P2-S41, P2-S42, P2-S54, P2-S66, P2-S68, P2-S69,
P2-S70, P2-S71, P2-S72, P2-S75, P2-S76, P2-S77, P2-S78, P2-S92, P2-S98, P2-S103, P2-S112,
P2-S117; P4-S08, P4-S09, P4-S10, P4-S11, P4-S12, P4-S13, P4-S15, P4-S16, P4-S17, P4-S18,
P4-S19, P4-S20, P4-S21, P4-S22, P4-S23, P4-S24, P4-S25, P4-S26, P4-S27, P4-S51, P4-S55,
P4-S59, P4-S60, P4-S61, P4-S62, P4-S63, P4-S64, P4-S65, P4-S66, P4-S68, P4-S69, P4-S70,
P4-S57, P4-S72, P4-S82, P4-S92, P4-S93, P4-S94, P4-S96, P4-S97, P4-S98, P4-S101, P4-S105, P4-S108,
P4-S111, P4-S114, P4-S117; P3-S37, P3-S61; X1-S06, X1-S37; X2-S07, X2-S08, X2-S17, X2-S18, X2-S21,
X2-S24, X2-S27.

## Conformance tests

**Provider (RFC-004 module, run against the library alone):**

| # | Test | Scenarios |
|---|---|---|
| P1 | Replay determinism: every generated account log replayed on the current and previous rules versions reproduces every recorded verdict, outcome and `answer`. Iteration order, integer-only arithmetic and the absence of clock reads are checked by a lint | P4-S72 |
| P2 | `admit` check order and amounts on RFC-004's worked examples (P2-S38 `88,000` / `1,088,000`; P2-S39 row 4; P4-S68; P2-S117 rows 1 and 2) | P2-S38, P2-S39, P4-S68, P2-S117 |
| P3 | Arrival-order sequence: random concurrent requests of one account and key; every verdict equals a strictly sequential evaluation over the undecided holds; refusals by an in-flight hold stand | P2-S70, P2-S71, P2-S112, P4-S66 |
| P4 | Envelope: queued Increase/Extend behind every combination of Increase, Extend, Decrease and Shorten ahead, each outcome confirmed or failed, with price steps between intake and decision. `x ≥` the true added hold, the excess is released at E5, and nothing suspends from its own queue (J-01 trace: 36,000 / 24,000). **Plus an Increase ahead at a higher locked price** (M1 trace: a 2 µ reservation, catalogue at 3 µ, I1 +50 Mbps ahead of an extension E2): ρ⁺ = 100 × 2 + 50 × 3 = 350 µ/min, and E2's decision never meets `R(after) − R(before) > h_q` | P2-S70, P4-S66, P4-S60 |
| P5 | Minute-piece rates: a `Part.rate` with a cut step at `T_eff` gives `cov_r`, `e_{r,k}` and ρ⁺ read at each minute; equal to a brute-force per-minute sum | P4-S60 row 5 |
| P6 | Commit-timestamp evaluation: the same batch evaluated at `ts` across 00:00 UTC, across a fee-term end and across an `LB` step gives the recorded E1 ↔ E1′ flips | P4-S72 |
| P7 | `LB` span: random `hp` schedules; `LB(ts)` equals the brute-force maximum over `[ts − 370 s, ts + 60 s]`; P3-S37 gives 53,750 µ | P4-S16, P4-S19, P3-S37 |
| P8 | Invariants A-1 and A-2 after every apply in a randomized simulation (postings with lag, price changes, suspensions, resumptions, release after grace) | P4-S10, P4-S64, P4-S66, P4-S101 |
| P9 | Standing machine: every RFC-004 §A7 worked example (P4-S22, S92, S93, S94, S97, S101, S105, S108, S114 rows 1 and 2); `RA` itemised equals the least resuming top-up found by search | P4-S18, P4-S22, P4-S114 |
| P10 | F2 pairing: figures and F1s in every interleaving, with `Δ_b` posted whole and not whole; `U` never counts a posted usage line twice, and headroom equals the exact value at every applied pair | P3-S61, P4-S16 |
| P11 | F7 deferral: `apply(F7)` with `instant × 10⁶ > ctx.ts.wallNanos` (including an instant 1 ns of wall time after `ts`) returns `Deferred` and leaves the state unchanged; at `instant × 10⁶ = ts.wallNanos` it applies | P4-S27, P4-S96 |
| P12 | Enforcement (D-3): `enforcedAt` = `ceil(since.wallNanos/10⁶) + 60,000` exactly (on time) and `+ 1 ms` (late); an on-time ack delivered after the 60 s check; missing at 60 s (`ENFORCEMENT_ACK_MISSING` only), then at 120 s (`LATE_ENFORCEMENT` once); suspend → resume within seconds with only the resume acknowledged (no report); a resumption (no check); a duplicate with a different `enforcedAt`; an ack for a recorded earlier `stdSeq` delivered after the next transition (recorded, no alert); an ack for an unknown or future `stdSeq` (`ENFORCEMENT_ACK_UNEXPECTED`) | P4-S27, X2-S08 |
| P13 | F4 without a timestamp skip: events of one account delivered out of commit order, a revocation with a lower commit timestamp arriving after a later event, duplicates from push and catch-up; every status change is applied, none twice. Snapshot: an applied key absent from it is revoked, and a key first applied as revoked is in `revokedKeys` | X1-S06, P2-S72 |
| P14 | `LB` integer formula: random `usage_rate_cap`, Λ and `hp*`; the module's `LB` equals `ceil(cap × Λ_ms × hp / 8×10¹²)` exactly | P4-S16, P3-S37 |
| P15 | `checked` in every verdict equals the headroom and key headroom used by checks 4 and 5 | P2-S38, P2-S39 |

**Consumer and host (RFC-002 account owner, run on the substrate):**

| # | Test | Scenarios |
|---|---|---|
| H1 | `admit` and `apply` called only inside the batch transaction after its timestamp is read; a forced push re-evaluates the whole batch, and the committed verdicts equal a replay | P4-S72 |
| H2 | Same-entry endings: suspension (F1, F2, F3, F5, F6, F7) ends undecided additions only; F4 revocation ends that key's undecided requests; F7 `grace_ended` writes the E11 releases. No committed state has the cause without its endings | P2-S69, P2-S72, P2-S77, P4-S23 |
| H3 | Gates: F2 held until `ledger_pos ≥ X`; invoice events held until their `ledgerPos`, across owner failover; no transient resume | P4-S94, P4-S105, P4-S111 |
| H4 | Identity freshness: the push is blocked with identity reachable or unreachable; after takeover, `adopt` and re-home the watermark is unset until the catch-up commits or every partition reports; no E5 with `ts > iamFresh + 45 s`; no F4 is written for event-free heartbeats; a revocation is applied within 60 s by catch-up. **Plus** (m15, M2): heartbeats on one partition while another lags (no advance past the lagging one); a revocation held in a `stream_seq` gap buffer while resolved markers keep arriving (the watermark stops below it, and no E5 for the key passes after 45 s); a catch-up whose F4 entry has not yet committed (does not count); F5 `set` on a stale slot answers `temporarily_unavailable`, and a repeat `actionId` answers its first outcome | X1-S06, P2-S72, P2-S103, P4-S82 |
| H5 | `rateCheck`: over-limit submissions create nothing, and polls are not counted; at most twice the limit in the second after an owner change | P2-S41, P2-S68 |
| H6 | Provisional key (S-1, D-4): an intake with a C08 signed key record for a key not yet applied is admitted under its limits; the signed bytes are in E1, and the signature and tenant re-verify on replay; it replays identically after the F4 arrives. A record with `status = revoked`, or with a tenant other than the account, is refused as unauthenticated. A key created and revoked before its first F4 is in `revokedKeys`, and its provisional requests end "key revoked" | X1-S06, P2-S40, P2-S72 |
| H7 | Exactly-once effect of every funds input under kill or pause of the owner mid-batch: no F entry is applied twice and none is skipped | P4-S57, X2-S21 |

**Feeds and queries:**

| # | Test | Side | Scenarios |
|---|---|---|---|
| Q1 | `account.standing.v1`: a transition at entry `ts` is visible on the topic within 10 s, through the owner path and through the relay path with the owner killed after commit; duplicates and replays are dropped by `stream_seq`, then by `stdSeq` | Owner / network-operations stub | P4-S25, X2-S17 |
| Q2 | Standing query returns `standing`, `since` and `stdSeq` at a stated position equal to the log | Status replica | P4-S26 |
| Q3 | Enforcement ack round trip: the cases of P12 end to end, with alerts routed to operations and finance as D-3 states | Network-operations stub / owner | P4-S27, X2-S08 |
| Q4 | Headroom answer: fields present; `position.ts` is the commit timestamp at `position.log` and `evaluatedAt` the read timestamp; another tenant and a supplier get `NOT_FOUND`; `items.headroom = balance − fundsHeld − Σ(unposted + latenessBound) + creditLimit`; agent-key headline `kh_k`; `position` lets P4-S72's rebuild reproduce it; p99 ≤ 200 ms per region | Status replica / edge / probe | P4-S15, P4-S16, P4-S17, P4-S55, X2-S18, X2-S27 |
| Q5 | `account.usage-applied.v1` (C06's CT-R4 and CT-A1 apply): one `UsageApplied` per F2, with `appliedTs` = the F2's `ts` and `entry` = its position; none while gated and none for probe accounts; gap recovery by topic replay (retention ≥ 7 days), and by `usage_applied_since` returning C06 events identical to the originals, including events rebuilt from live log rows and from sealed segments | Owner / rating | P3-S61 |

## Settled

The orchestrator's binding decisions are recorded here. S-1 … S-4 settle the original
mismatches and gap fills, as amended by review 45. S-5 … S-8 adopt review 45's decisions.
Nothing in this section blocks Frozen.

| # | Point | Where the RFCs differed | Decision (binding) |
|---|---|---|---|
| S-1 (was M1) | **A key not yet applied by F4** | RFC-004 §A10: `rate_check` and `Ask` carry no key limits. RFC-002 §3.1 and RFC-005 C3: such a key is admitted under its identity-signed key record's limits, held provisionally | `Ask.provisionalKey` and `PrincipalCtx.provisionalKey` carry **C08's `SignedKeyRecord` as its exact signed bytes**, recorded in E1/E1′. Replay is then exact, and the signature and tenant are auditable (review 45 M4, D-4). The record is refused, as unauthenticated, if its `status` is `revoked` or its tenant is not the account. It is used only while the key is absent from applied state, and the F4 that applies the key supersedes it. `revokedKeys` lists a key first applied as revoked |
| S-2 (was M2) | **Holder and definition of `iam_fresh`** | RFC-002 and RFC-004: the booking module holds it, "advanced by every heartbeat". RFC-005 C3: "F4 keeps `iam_fresh`", defined as the minimum over the partitions | The booking module holds it, in owner memory. `iam_fresh = max( min over the identity-push partitions feeding the slot of R_applied(p), the read timestamp of the last catch-up whose entry has committed )`. `R_applied(p)` is the latest resolved timestamp up to which every event of p is applied, with no gap below it (review 45 M2, D-6). It is unset after any acquisition until the catch-up commits, or until every partition has reported |
| S-3 (was M3) | **Freshness at the KYB check of F5 `set`** | RFC-004 §A4 and RFC-002 §7.3: no freshness condition. RFC-005 §3.6 and C10: checked with `iam_fresh` within 45 s, both recorded | If `ts > iamFresh + 45 s`, or `iamFresh` is unset, nothing is appended and the answer is C07's **`temporarily_unavailable`**, never final (the console retries). Otherwise the F5 records `iamFreshUsed` (required). The order is C07's frozen one: authenticity → dedupe → operator freshness → scope → validity → KYB, with the `iamFresh` gate inside the KYB step (V53-1). A `CreditLimitRemoved` is superseded by an F5 `set` committed after its `decided_at` (C07 R37-03). The KYB refusal rule is unchanged |
| S-4 | **Gap fills C-1 … C-7** | — | C-1 … C-6 are accepted as written. C-7 is **replaced**: a view and index on RFC-002's outbox for rating would be a cross-owner table read, which RFC-000 forbids. Rating recovers by topic replay (retention ≥ 7 days) and by `usage_applied_since` beyond that. Amended by review 45 (M6, m10, D-5): C06 owns the acknowledgement's wire form, and the query returns C06's events and is served by RFC-002's status readers, off the write path |
| S-5 (review 45 m11) | **E11 effective before `nb(ts)`** | RFC-004 §A4: "a POL-07 cut **or revocation** at `T_eff`". RFC-002 §2.2 E11: "a POL-07 cut" only | A POL-07 revocation is a cut to 0 (RFC-002 §9.7, `r = 0`), so both readings mean the same. The contract reads it as "a POL-07 cut at `T_eff`, a revocation included". RFC-002 erratum |
| S-6 (D-1) | **Price of an Increase ahead** | — (missing from both) | `QueuedChange.lockedPrice` and `priceVersion` for an Increase. ρ⁺ prices each part at max(locked price, recorded step in force) |
| S-7 (D-2) | **Set-scoped membership** | C05 v0.1: membership at the signed v. C07 S1: v not checked | Scope = `member` is the receiving account **and** its applied F9 has `excluded` on. v is recorded for audit only, together with `designatedAtMapVersion` |
| S-8 (D-3) | **Enforcement reporting** | — | Suspensions only. At `since + 60 s`, no check if a later transition has committed; otherwise, with no F8, `ENFORCEMENT_ACK_MISSING` to operations. `LATE_ENFORCEMENT` to operations and finance, once: by an F8 with `enforcedAt` after the target, or at `since + 120 s` with still no F8 |

## Consumer obligations (RFC errata)

The RFC owners must apply these errata. None of the RFCs is edited by this contract.

| Owner | Erratum or change |
|---|---|
| RFC-000 §8 | Identity status push and catch-up row: replace "advanced by every push heartbeat's resolved timestamp and every catch-up's read timestamp" with S-2's applied, gap-free definition (AI-45-1). Usage-applied acknowledgement row: topic retention ≥ 7 days and `usage_applied_since`, served by RFC-002's status readers (AI-45-2) |
| RFC-004 Part A | §A4 F5 (with C07): C07's check order and the supersession of a `CreditLimitRemoved` by a later `set` (R37-03). §A10: `Ask` gains `provisionalKey?` (C08's signed record bytes), and `rate_check` takes it in the principal context (S-1). §A5.1: checks 0, 2 and 5 and the rate limits read a provisional key's status and limits from that record, only while the key is absent from applied state. `admit` returns `checked` (m13). §A5.2: `QueuedChange` carries `lockedPrice` and `priceVersion` for an Increase; ρ⁺ prices at max(locked, stepped) (S-6). §A2, §A4 F4 row, §B12 consumed identity row, JR-11 and revision 5 item 1: S-2's definition; **delete the `id_ts` skip rule** and dedupe F4 by (identity partition, sequence) plus key version (M3); add the `snapshot` source; an applied key absent from a snapshot is revoked as applied; `revoked_keys` includes keys first applied as revoked. §A4 F5 and §B12: C07's check order; scope = `member` plus applied F9, v recorded only (S-7); freshness gate with `temporarily_unavailable` and `iam_fresh` recorded (S-3). §A8 and F7/F8: S-8. §A9: `position.ts` and `evaluatedAt`; `answer` reads applied state; `NOT_FOUND` (m4, m5). §A3: the integer `LB` formula (m3). Traceability: cite P4-S117 and P4-S118, which the tool reports uncited (m12) |
| RFC-002 | §2.2 E1/E1′: record `provisionalKey` (signed bytes) and `checked` (S-1, m13); E11: "a POL-07 cut at `T_eff`, a revocation (r = 0) included" (S-5). §1.2, §1.3, §2.4 table and item 14: S-2's definition, applied and gap-free, set after acquisition only by a committed catch-up or by every partition reporting. §3.1: refuse a provisional record with `status = revoked` or the wrong tenant. §7.3 and §13.1 credit-limit row: C07's order and `temporarily_unavailable` (S-3, S-7). §8.2: status readers re-check the principal context and answer `NOT_FOUND` (m5). §13.1: usage-applied in C06's form; `usage_applied_since` on the status readers, rebuilt from the log by `emits`; topic retention ≥ 7 days (S-4) |
| RFC-003 | §5.9 and §7: consume C06's `UsageApplied`. On a gap, replay the topic, then call `usage_applied_since`. Never read the owner's outbox (S-4) |
| RFC-005 | C3 and §3.3: `iam_fresh` is held by the booking module, with S-2's applied, gap-free definition. C3: a provisional key record is used only while the key is absent from applied state (stricter than "a version lower than the applied one is ignored", D-4); the snapshot answer as C08 S-G1. §7.4 and the console's set-scoped fan-out (with RFC-004 §B12): `temporarily_unavailable` is no answer, and the console retries the member |
| RFC-006 | §5.4: `account.usage-applied.v1` retained at least 7 days, sized as in "Gap recovery" (est.). §5.5: for this stream, the outbox follower-read gap path is replaced by `usage_applied_since` (S-4) |
| C06 | §4 `UsageApplied`: add `entry: LogPosition` (the F2 entry); name `usage_applied_since` as the recovery path beyond retention (D-5) |
| C08 | §B freshness watermark and consumer test C-02: S-2's applied, gap-free `R_applied(p)`; after an acquisition set only by a **committed** catch-up or once every partition has reported, replacing "unset … until the first marker or catch-up"; a catch-up's `read_timestamp` and a snapshot's `position` count only once their F4 entry commits (or at once with no change). §B snapshot (S-G1): an applied key absent from the snapshot is revoked as applied (m8). (V53-3) |
| C07 | Already carried by C07: `temporarily_unavailable{identity_stale}`, never final, inside the KYB step; the F5 supersession rule (R37-03). No change owed (M5, V53-1) |
| Requirements | RQ-45-1 (raised): whose clock measures "blocked within 60 s"; this contract assumes network operations' clock is within `max_offset` |

## Clarifications made by this contract (no conflict between the RFCs; accepted, S-4)

- **C-1.** `ReservationChanged.effectiveMinute` is required. RFC-004 §A10 has it; RFC-002
  §2.4's call table omits it, but its E11 records it.
- **C-2.** Price steps are carried once per `Schedule`. RFC-004's `Part.price_steps` puts
  them on each part, but a step re-prices every part (RQ3-5; RFC-002 §9.1), so the two forms
  are equivalent.
- **C-3.** `QueuedChange` carries `newRate` as the reservation rate requested (the
  fingerprinted value), plus `addedMbps` and `interval` copied from that change's own
  `Ask.change`. Both RFCs say only "new end or rate", and §A5.2's envelope needs Δ and the
  interval of each increase ahead.
- **C-4.** The usage-applied acknowledgement's "when" (RFC-003) is the F2 entry's commit
  timestamp, carried as C06's `appliedTs` (S-4, D-5).
- **C-5.** Every headroom answer carries `items.headroom` (`h`), so that the wallet probe's
  consistency check holds for every principal. For an agent key, the headline remains `kh_k`.
- **C-6.** The enforcement acknowledgement is idempotent by (account, `stdSeq`). For a
  repeat with a different `enforcedAt`, the first applied wins and `ENFORCEMENT_ACK_CONFLICT`
  is alerted. `enforcedAt` is network operations' clock (EpochMs). Neither RFC fixes this
  key, and network operations has no RFC. Extended by m14 (unexpected `stdSeq`) and S-8.
- **C-7.** *Replaced by S-4.* Rating recovers usage-applied gaps by topic replay
  (retention ≥ 7 days) and by `usage_applied_since`, served by RFC-002's status readers. There is no
  read of RFC-002's tables. Network operations recovers gaps by the standing query.

## Review 45 resolution

| Finding | Change in v0.2 |
|---|---|
| M1 (D-1) | `QueuedChange.lockedPrice`, `priceVersion`; ρ⁺ at max(locked, stepped); P4 case with an Increase ahead at a higher price; S-6 |
| M2 (D-6) | `iamFresh` counts only applied, gap-free resolved timestamps and committed catch-ups. After acquisition it is set only by the catch-up or by every partition reporting. S-2 amended; H4 cases |
| M3 | `completeThrough` and the `id_ts` skip deleted. F4 dedupe by (identity partition, sequence) plus key version; P13 |
| M4 (D-4) | `ProvisionalKeyRecord` = C08 `SignedKeyRecord` signed bytes plus parsed record. Refused if revoked or the wrong tenant. `revokedKeys` includes keys first applied as revoked; S-1 amended; H6 cases |
| M5 (D-2) | Set-scoped scope = `member` plus applied F9; v and `designatedAtMapVersion` recorded only. Stale answer is C07's `temporarily_unavailable{identity_stale}`; S-3 amended; S-7. Order corrected by V53-1 to C07's frozen order: authenticity → dedupe → operator freshness → scope → validity → KYB, with the `iamFresh` gate inside KYB; C07's F5 supersession rule (R37-03) adopted |
| M6 (D-5) | C06 owns the acknowledgement's wire form. `UsageAppliedAck` removed in favour of C06 `UsageApplied`; topic `account.usage-applied.v1`; `usage_applied_since` returns C06 events; C06 obligation adds `entry` |
| m1 (D-3) | Enforcement checks for suspensions only, at 60 s and 120 s; `ENFORCEMENT_ACK_MISSING`; `LATE_ENFORCEMENT` once; S-8; P12, Q3 |
| m2 | ms ↔ HLC conversion rules under Units; F7 and `due` instants restated; P11, P12 boundaries |
| m3 | Exact integer `LB` formula under Units; P14 |
| m4 | `position.ts` = commit timestamp at `position.log`; `evaluatedAt` = read timestamp; `answer` reads applied state |
| m5 | `NOT_FOUND` for another tenant or a supplier; the replica re-checks the C1 principal context; `PERMISSION_DENIED` removed |
| m6 | `iamFreshUsed` required on F5 `set`; `designatedAtMapVersion` added |
| m7 | Consumer obligations completed: RFC-000 §8 (AI-45-1, AI-45-2), RFC-004 F4/§B12/rev. 5 item 1, RFC-005 C3 and §7.4 fan-out, C06, C07 |
| m8 | F4 `snapshot` source; an applied key absent from the snapshot is revoked as applied (`KEY_ABSENT_FROM_SNAPSHOT`) |
| m9 | Wording fixed (outbox row in the F2 transaction, published after commit); rebuild from the account log by `emits`; 7-day sizing (est.); `RatingPosition` is C06's, with no unbounded `inputs`; owner publish marked est. |
| m10 | `usage_applied_since` served by the status readers, off the write path. The finding that the query buys little is recorded, and the query is kept per S-4 |
| m11 | S-5: a revocation is a POL-07 cut to 0; RFC-002 E11 erratum |
| m12 | P4-S117 cited (F1 credit re-evaluates standing); the RFC-004 traceability gap (P4-S117, P4-S118) listed under obligations |
| m13 | `Verdict.checked` (headroom, key headroom), recorded in E1/E1′; P15 |
| m14 | F8 for an unknown or future `stdSeq`: recorded, `ENFORCEMENT_ACK_UNEXPECTED`, no effect. An ack for a recorded earlier `stdSeq`: recorded without alert (V53-2) |
| m15 | H4 extended (lagging partition, gap-buffered revocation, uncommitted catch-up, `adopt` and re-home) |
| RQ-45-1, AI-45-1, AI-45-2 | Listed under Consumer obligations (requirements; RFC-000 §8) |

## Fix verification 53 resolution

| Finding | Change in v1 |
|---|---|
| V53-1 | F5 row, Idempotency F5 row, freshness section, S-3 and resolution row M5 restated to C07's frozen order (authenticity → dedupe → operator freshness → scope → validity → KYB, with the `iamFresh` gate inside KYB). C07's F5 supersession rule (R37-03) adopted, with `decidedAt` and `superseded` on F5 `removed_invoice_written_off`. F9 `mapVersion` annotated as the designating version |
| V53-2 | An ack for a recorded earlier `stdSeq` is recorded without alert. `ENFORCEMENT_ACK_UNEXPECTED` only for an unknown or future `stdSeq`. F8 row, Idempotency, `Alert` comment, P12 and resolution row m14 adjusted |
| V53-3 | C08 obligation row added: applied-only `iam_fresh`; a catch-up counts after its F4 commits; absent-key revocation in the snapshot rule; test C-02 |
| V53-4 | µs → HLC rule under Units: `µs × 10³ ≤ ts.wallNanos`; `iamFresh` held as wall ns; gate `ctx.ts.wallNanos ≤ iamFresh + 45 × 10⁹`; C08 µs values carried as `wallNanos = µs × 10³`, `logical = 0` |
| Status | Frozen, version 1. Errata owed: the RFC rows under Consumer obligations, C06's `entry` field and C08's row |
