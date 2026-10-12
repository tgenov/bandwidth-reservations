# C05. Funds and standing

| | |
|---|---|
| Contract ID | C05 |
| Version | 0.1 |
| Status | **Draft**, for contract review. The orchestrator settled the three mismatches (M1 … M3) and the gap fills; see [Settled](#settled) and [Consumer obligations](#consumer-obligations-rfc-errata) |
| Provider | RFC-004 Part A: the funds-and-standing module (§A1 … §A11), a library linked into the account owner. RFC-004 also defines the semantics of the standing feed, the standing query, the standing enforcement acknowledgement and the headroom and balance query (§A8, §A9, §B12) |
| Emitter and host | RFC-002: the account owner. It calls the module, appends every entry, serves the queries from its status replicas, and publishes the standing feed and the usage-applied acknowledgement from its outbox (§2.3, §2.4, §2.5, §13.1) |
| Consumers | RFC-002, the account owner's booking module (every in-process call). Network operations: standing feed and standing query (RFC-005 §2: mTLS client). Network operations is also the **producer** of the enforcement acknowledgement. Edge (RFC-005; buyer API, permission matrix §4.2) and probes (RFC-006 §17, wallet probe): the headroom and balance query. RFC-003 rating: the usage-applied acknowledgement |
| Transport | (1) **In-process call**: TypeScript library inside the account owner's NestJS process; no I/O, clock or randomness. (2) **Account log**: every input and outcome is recorded in an entry of RFC-002's `account_log` (insert-only, epoch-conditional batch transactions). (3) **Kafka event**: `account.standing.v1` and `account.usage_applied.v1` go out through the owner's transactional outbox. `netops.enforcement_ack.v1` comes in. (4) **gRPC query** to the status replicas: headroom and balance, standing |
| Pinned to | `requirements-v1.10`; RFC-000 rev. 4.4 (§4.3, §4.6, §8); RFC-004 rev. 5 + erratum 5.1; RFC-002 rev. 5. Readers' sections: RFC-003 rev. 5 + erratum 5.1 (§5.9, §7); RFC-005 rev. 5 (§3.3, §3.6, §4.2, C3, C10); RFC-006 rev. 6 (§5.4, §5.5, §17) |

**Units.** Every amount is a signed integer of **micro-USD** (µ, 10⁻⁶ USD), `bigint`. Prices
are integer **pico-USD** (10⁻¹² USD), `bigint`: per Mbps-minute for reservation prices,
per GB (10⁹ bytes) for usage prices (RFC-003 §2). Rates are integer **Mbps** (`bigint`).
Minutes are integer **UTC minutes since 1970-01-01T00:00Z** (`bigint`). Every interval is
half-open `[start, end)`, and `end = null` means open-ended. Durations are integer
**milliseconds** (`bigint`). Times of entries are database **HLC commit timestamps**. No
quantity is a JavaScript `number`, except a timestamp's logical counter and counts of
submissions. No arithmetic is floating point. Intermediate products are exact `bigint`, and
each value is rounded only where RFC-004 says (POL-11).

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

/** Rating's position for the account: rating log sequence and the input positions behind it (RFC-003 §5.9). */
interface RatingPosition { ratingPartition: string; sequence: bigint; inputs: string /* opaque, recorded */ }

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
  addingKey?: KeyId;
}

/** Identity-signed key record for a key not yet applied by F4 (settled S-1). */
interface ProvisionalKeyRecord {
  key: KeyId; version: bigint;
  keySpendLimit?: Micros; keyInflightLimit?: Mbps; keyRateLimit?: bigint /* submissions per second */;
  signature: string;            // verified by the owner (RFC-005 C1) before the call
}

interface Ask {
  request: RequestId;
  principal: PrincipalId;
  key?: KeyId;
  provisionalKey?: ProvisionalKeyRecord;   // S-1
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

type Verdict =
  | { kind: 'Admit'; hold: Micros; holdKind: 'Funds' | 'Credit'; mbps: Mbps }
  | { kind: 'Refuse'; reason:
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

type Alert =
  | { code: 'LATE_ENFORCEMENT'; stdSeq: bigint; target: HlcTimestamp; enforcedAt?: EpochMs }
  | { code: 'ENFORCEMENT_ACK_CONFLICT'; stdSeq: bigint; first: EpochMs; second: EpochMs };

/** Rows the owner writes to its outbox in the same transaction (RFC-002 §2.5 "events"). */
type OutboxEvent =
  | { stream: 'standing'; event: StandingEvent }
  | { stream: 'usage_applied'; event: UsageAppliedAck };

interface Outcomes {
  holdChanges: HoldChange[];
  standing?: { from: Standing; to: Standing; stdSeq: bigint; causes: Cause[]; ra?: ResumeQuote };
  warning?: { wq: Micros };
  notices: Notice[];
  releaseDue?: ReservationId[];            // F7 grace ended: booking writes E11 releases in the same entry
  revokedKeys?: KeyId[];                   // F4: booking writes "key revoked" endings in the same entry
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

interface F4 { kind: 'F4'; source: 'push' | 'catch_up';
  events: (( { kind: 'key'; key: KeyId; version: bigint; status: 'active' | 'revoked';
               keySpendLimit?: Micros; keyInflightLimit?: Mbps; keyRateLimit?: bigint }
           | { kind: 'kyb'; status: 'passed' | 'failed' | 'withdrawn' } )
          & { identityPos: { partition: string; sequence: bigint }; commitTs: HlcTimestamp })[];
  completeThrough: HlcTimestamp }                                     // id_ts: drops repeats only; NOT freshness

type F5 = { kind: 'F5' } & (
  | { variant: 'set'; amount: Micros; principal: PrincipalId; reason: string; actionId: string;
      member?: AccountId; setScope?: { mapVersion: bigint };          // set-scoped (probe accounts)
      iamFreshUsed?: HlcTimestamp }                                   // S-3: required on 'set'
  | { variant: 'removed_by_operator'; principal: PrincipalId; reason: string; actionId: string }
  | { variant: 'removed_invoice_written_off'; invoice: InvoiceId; rcvPos: FeedPosition; ledgerPos: LedgerPosition } );

type F6 = { kind: 'F6'; rcvPos: FeedPosition; ledgerPos: LedgerPosition } & (
  | { variant: 'overdue'; invoice: InvoiceId; unpaid: Micros; dueDate: UtcMinute }
  | { variant: 'paid'; invoice: InvoiceId }
  | { variant: 'written_off'; invoice: InvoiceId; amount: Micros } );

type F7 = { kind: 'F7'; instant: EpochMs } & (
  | { variant: 'fee_term_ended'; reservation: ReservationId }
  | { variant: 'grace_ended' }
  | { variant: 'enforcement_check'; stdSeq: bigint }
  | { variant: 'price_effective'; priceVersion: PriceVersion; reservations: ReservationId[] }
  | { variant: 'exposure_step'; product: ProductId } );

interface F8 { kind: 'F8'; feed: FeedPosition; stdSeq: bigint; enforcedAt: EpochMs }
interface F9 { kind: 'F9'; excluded: boolean; mapVersion: bigint }
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

interface PrincipalCtx { principal: PrincipalId; key?: KeyId; provisionalKey?: ProvisionalKeyRecord /* S-1 */ }

interface DueTick { instant: EpochMs; payload: F7 }

interface FundsModule {
  /** Owner clock. Logs nothing. Reads the key status as applied by F4 (JR-1). */
  rateCheck(soft: RateWindows, nowMs: EpochMs, who: PrincipalCtx): RateCheckResult;

  /** Decisive only inside the batch transaction, with ctx.ts its commit timestamp. Evaluated
   *  on the state left by every earlier entry of the account, earlier entries of the same batch included. */
  admit(s: FundsState, ctx: Ctx, ask: Ask): Verdict;

  /** The only state transition. An F7 whose instant is after ctx.ts returns Deferred, and nothing changes. */
  apply(s: FundsState, ctx: Ctx, input: Input):
    | { kind: 'Applied'; state: FundsState; outcomes: Outcomes }
    | { kind: 'Deferred' };

  /** Instants for the five F7 variants. */
  due(s: FundsState): DueTick[];

  /** ctx.ts: the read timestamp. Pure. */
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
  position: { log: LogPosition; ts: HlcTimestamp; ledger: LedgerPosition; rating?: RatingPosition };
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
type HeadroomError = 'RETRY' /* replica cannot serve; the client retries another */ | 'MOVED' | 'PERMISSION_DENIED';
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
| `account.standing.v1` | account partition | Account owner: direct publish after commit, with the changefeed relay as the guaranteed path | `partition`, `stream` = `standing`, `stream_seq`, `generation`, `epoch`, `ts`, `kind` = `StandingChanged`, `schema_v`, `key_id` |
| `account.usage_applied.v1` | account partition | Account owner (same two paths) | as above; `stream` = `usage_applied`, `kind` = `UsageApplied`; `ts` = the F2 entry's commit timestamp |
| `netops.enforcement_ack.v1` | account | Network operations | `schema_v`; mTLS producer identity (RFC-005 §2) |

```ts
interface StandingEvent {               // RFC-004 §A8. Carries no cause.
  account: AccountId;
  stdSeq: bigint;
  standing: Standing;
  since: HlcTimestamp;                  // commit ts of the entry that changed standing
  decisionPosition: LogPosition;
}

interface UsageAppliedAck {             // RFC-000 §8; RFC-002 §13.1; RFC-003 §5.9, §7
  account: AccountId;
  ratingPos: RatingPosition;            // through which the owner has applied unposted usage
  appliedAt: HlcTimestamp;              // = header ts (RFC-003: "and when")
  entry: LogPosition;                   // the F2 entry
}

interface EnforcementAck {              // RFC-000 §8; RFC-004 §A8
  account: AccountId;
  stdSeq: bigint;
  enforcedAt: EpochMs;                  // when usage-priced traffic was blocked or unblocked, network operations' clock
}
```

### Gap recovery for usage-applied acknowledgements (no cross-owner read)

No consumer reads the account owner's tables. RFC-000 forbids cross-owner table reads, so
there is no view or index on RFC-002's outbox. If rating finds a gap in `stream_seq` on
`account.usage_applied.v1`, it recovers as follows:

1. **Topic replay.** `account.usage_applied.v1` is retained for **at least 7 days**. Rating
   re-reads the topic from an offset before the gap.
2. **Owner-served query**, used if the missing events are older than the topic's retention,
   or if replay does not fill the gap.

```ts
// gRPC, routed like any command to the account owner (placement's slot map: slot, generation, epoch, map version)
interface UsageAppliedSinceRequest {
  accountPartition: AccountId;
  afterStreamSeq: bigint;               // the last stream_seq rating has applied for (partition, 'usage_applied')
  limit?: number;                       // default 1,000 events
}
interface UsageAppliedSinceAnswer {
  events: { streamSeq: bigint; generation: bigint; epoch: bigint; ack: UsageAppliedAck }[];  // in stream_seq order, contiguous
  throughStreamSeq: bigint;             // the highest stream_seq the owner has committed for the stream
  more: boolean;                        // true: call again from the last streamSeq returned
}
type UsageAppliedSinceError = 'STALE_EPOCH' | 'MOVED' | 'MOVING' | 'UNAVAILABLE' | 'PERMISSION_DENIED';
```

The owner answers from its own log. Events still in the outbox come from there. Older ones
are rebuilt by RFC-006's versioned emit function over the sealed log segments in history
(§13.3), so every event can be recovered for 7 years.

- **Read-only and idempotent**: any number of retries is safe.
- **Who may call**: only rating's service principal (RFC-005 C1).
- **Consistency**: the answer covers only committed entries.

Network operations recovers a gap in `account.standing.v1` through the standing query.

## Semantics

### Calls of the module

All six calls are pure and deterministic. Arithmetic is integer only. Reservations are
iterated in `(start_r, id)` order and keys in id order. Time comes only from `ctx.ts`
(`nowMs` for `rateCheck` alone). Every parameter comes from state applied by an entry, and
the rules from F10 (RFC-004 §A10).

| Call | Preconditions (caller) | Outcome | Errors and special results |
|---|---|---|---|
| `rateCheck` | A booking submission (never a poll, P2-S68) has arrived at the owner and passed the tenant and key checks of RFC-002 §3.1 | `Accept`. `NotAccepted{rate, retryAfterMs}` when the submission is over `key_rate_limit` or `account_rate_limit` in the sliding second ending at `nowMs`; nothing is logged and the idempotency key is not consumed (P2-S41). `NotAccepted{revoked}` when the key is revoked as applied by F4; it is checked before anything else, and the booking module treats the submission as unauthenticated (X1-S06, JR-1) | For one second after an owner change, a key or account may be admitted up to twice its limit (B-AI-4, JR-3) |
| `admit` | Called once per intake, in the account's arrival order, **inside the batch transaction after it has read its commit timestamp** (`ctx.ts`). It counts the holds and capacity in flight of every request then undecided. Any call before that is provisional and only orders submissions. A pushed transaction re-evaluates the whole batch in sequence order (J-03) | Checks 1 to 5 of RFC-004 §A5.1, in order. `x` is sized by §A5.2: for a new reservation, `R_r`; for a change with nothing ahead, `R_r(after) − R_r(before)`; for a change with `ahead`, the **envelope** (ρ⁺, e⁻, e⁺, recorded price steps priced at the stepped price, V-3). On `Admit`, `hold = x`. Reductions (decrease, shorten, cancel) are never passed to `admit` (POL-08, P2-S77) | `Refuse` is recorded as E1′ with the Ask, the verdict, and the headroom and key headroom checked against (J-13). A refusal caused by the hold of a request in flight stands even if that request later releases it (P2-S112) |
| `apply(Intake)` | E1 (admitted) or E1′ | E1 adds `h_q` and `mbps_q`. E1′ holds nothing | — |
| `apply(Decided)` | E5, or E4/E6/E7, in the deciding entry. For an addition, E5 is composed only if `standing(S)` is active at that position (P2-S69) | `Confirmed`: `h_q` becomes the hold. For a new reservation `H_r = R_r`. For a change, `H_r = R_r(after)` and the excess `h_q − (R_r(after) − R_r(before))` is released when positive (D-1). `NotConfirmed`: `h_q` and `mbps_q` are released (P4-S12) | A shortfall from posting drift is a failed roll-forward (§A7); the confirmation stands (P2-S70) |
| `apply(ReservationChanged)` | E11; `effectiveMinute ≥ nb(ts)`, except a POL-07 cut or revocation at `T_eff` | The hold is resized or ended by §A6. A recorded future end or cheaper schedule lowers `R_r` at once. A due fee sets `fee_state → due` | — |
| `apply(PriceTookEffect)` | Carried by the one price-change E11 per (account, price version), written in the F11 entry | Records the step in `sched_price_r`. The hold grows only at F7 `price_effective` | — |
| `apply(F1 … F11)` | The owner built the entry from a feed, command or timer. F2 is composed only once the applied `ledger_pos` ≥ X. F5 (`removed_invoice_written_off`) and F6 only once the applied `ledger_pos` ≥ the event's `ledgerPos`, in `rcvPos` order (the gate, §A4) | The apply rules of §A4 (table below). Standing is evaluated after every entry (§A7) | F7 with `instant > ctx.ts` returns `Deferred`, and the owner commits it in a later batch (J-10) |
| `due` | — | The instants of fee-term ends, the grace end, enforcement checks (`since + 60 s`), price-effective minutes and exposure steps | — |
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
| F1 | — | Ledger movement-feed events for the account have arrived. One entry may cover several movements in one batch | Updates `Bal`, `W`, `p_r`; rolls or consumes holds; adds the newly posted minutes to `KP_k`; marks posted fees `charged`; removes from `OD` the invoice named by an applied M19. Re-applies a pending `Δ_b` if a usage batch is now reported posted whole and the current F2 still names it |
| F2 | — | A rating figure has arrived **and** the applied `ledger_pos` ≥ X. Only the latest figure per account in a batch is applied | `U[product] = U(X) − Δ_b` if an applied F1 at or below the current position reports `b` posted whole, else `U(X)`. Reservation batches never enter `U`. Standing is evaluated. The outbox gets a `UsageAppliedAck` |
| F3 | — | An account-product term changes (at its effective minute), or a `usage_price` change is **announced** | Recomputes `LB` (Λ = 430 s at the defaults, `hp*` over `[ts − (Λ − 60 s), ts + 60 s]`) and arms the exposure steps |
| F4 | — | Push or catch-up, **only for an actual status change** of a key (status, limits) or of KYB. Never for an event-free heartbeat or catch-up | Updates keys and `kyb`. Skips any event at or below `completeThrough` (`id_ts`) and any key event of lower version. `revoked` is terminal. The outcome `revokedKeys` lists keys newly revoked |
| F5 | `set`, `removed_by_operator`, `removed_invoice_written_off` | `set` and `removed_by_operator`: the credit-limit command. `removed_invoice_written_off`: the invoice-status feed, behind the gate | `set`: `out_of_scope` is checked first, together with the envelope (for the set-scoped form: `member` is this account, the account is `excluded` (F9), and it is a member of the signed set at `mapVersion`). Then the set is refused unless `kyb = passed`. A refusal is recorded and changes nothing. Otherwise sets `CL` and `mode`, relabels holds, and may suspend. Applied once per (`actionId`, account) |
| F6 | `overdue`, `paid`, `written_off` | The invoice-status feed, behind the gate, in `rcvPos` order | `overdue` adds to `OD`. `paid` and `written_off` remove from `OD` (a no-op if the M19's F1 already did) |
| F7 | `fee_term_ended`, `grace_ended`, `enforcement_check`, `price_effective`, `exposure_step` | The owner's timer from `due(S)`, committed only with `ts ≥ instant` | Each variant's time-driven change. `grace_ended` yields `releaseDue` (JR-2). `enforcement_check` raises `LATE_ENFORCEMENT` if no F8 for that `stdSeq` has been applied |
| F8 | — | An `EnforcementAck` is consumed | Recorded. `LATE_ENFORCEMENT` is raised if `enforcedAt > since + 60 s` (P4-S27) |
| F9 | — | Placement's probe designation | `excluded`: never rated; `p_r` follows the clock; `H_r` is re-evaluated at every apply (§A3, J-11) |
| F10 | — | Deployment of a new rules version | Later entries are evaluated with it, and replay uses the version recorded |
| F11 | — | The catalogue announces a price change for open-ended reservations, `price_notice` ahead. Idempotent by (account, price version) | No state change. The outcome is the `PriceNotice`. The booking module writes, in the same entry, the one price-change E11 with `PriceTookEffect` per reservation (JR-4) |

### Identity-freshness watermark (slot level)

- `iamFresh` is kept by the **booking module**, **per account slot, in owner memory**, and
  is never written to an entry. Settled definition (S-2):
  `iamFresh = max( min over the identity-push partitions feeding the slot of each partition's latest resolved timestamp, the last catch-up's read timestamp )`.
  It moves with resolved timestamps and catch-ups, whether or not they carry events. A
  heartbeat on one partition alone does not advance it past a lagging partition.
- After any acquisition (takeover, handoff, lapsed renewal, re-home, `adopt`) it is
  **unset**. The holder pulls `catch_up(slot, since)` before deciding anything. Any holder
  pulls when `now − iamFresh > 20 s`, and then every 5 s until fresh.
- **E5 commits only if `ctx.ts ≤ iamFresh + 45 s`.** The `iamFresh` used is recorded in
  the E5, and an unset watermark fails the check. A confirm that fails the check is
  deferred, and the request may reach its deadline.
- An F5 `set` (single or set-scoped) is composed only under the same condition, with
  `iamFreshUsed` recorded. When the slot is stale, nothing is appended and the command is
  answered "temporarily unavailable" (S-3).
- The funds module neither reads nor computes `iamFresh`. `F4.completeThrough` (`id_ts`)
  only drops repeated events.

### Headroom and balance query

Status replicas serve it, never the owner's write path. They evaluate `answer` on the
state at one account-log position: either the state the owner pushed under a live read
lease, or a bounded-staleness follower read of the projection rows through a replica in the
reader's own facility. `position` states the account-log position and timestamp, the ledger
position of `Bal` and the rating position of `U`.

Read-only, with any number of retries. An answer never gates a decision (§A9): decisions
are taken in entries. A replica that has applied the partition's `moved` entry answers
`MOVED`. One that can serve neither from a live lease nor from a follower read answers
`RETRY`. The edge returns `PERMISSION_DENIED` for supplier principals (RFC-005 §4.2).

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
usage-priced traffic for that `stdSeq`. The owner applies it as F8. The F7
`enforcement_check` at `since + 60 s` is an entry, so whether enforcement was late is
decided in the log, never by a clock read (P4-S27, X2-S08).

### Usage-applied acknowledgement

Exactly one is written in each F2 entry's transaction, after commit, carrying the rating
position that F2 applied. There is none while F2 is held by the X gate, and none for probe
accounts, which get no figures. Rating relies on it for two things:

- **Publish before emit**: rating emits a gated usage batch only after an acknowledgement
  whose `ratingPos` covers a figure naming that batch as in flight.
- **Attribution lag**: `appliedAt` is the time a record was counted (RFC-003 §5.9).

## Delivery and ordering

| Path | Guarantee | Ordering scope | Duplicate handling |
|---|---|---|---|
| In-process calls | Synchronous, exactly once per evaluation. Re-evaluation on a pushed transaction is part of the contract | The account's log sequence. Entries of one batch share `ts` and are ordered by sequence | — |
| Funds inputs (F1, F2, F4, F6, F8, F5 feed variant, F3/F9/F11 from catalogue and placement) | At least once from Kafka. **Exactly-once effect**: the owner checkpoints each feed's position in the entry that applies it (RFC-006 §5.5), and Kafka offsets are only restart hints | Per producer partition and stream (`stream_seq`), gaps buffered. F2 is held until X; F5/F6 are held until their `ledgerPos`. Held invoice events persist in `funds_*` | An event at or below the applied position is a no-op |
| `account.standing.v1` | At least once; owner publish within about 50 ms of commit, relay within about 1 s (est.), both inside `standing_notice_time` 10 s | Per account partition, `stream_seq` contiguous across owner changes and moves | Consumer drops by (partition, stream, `stream_seq`). Network operations applies an event only if its `stdSeq` is above the last applied (P4-S25) |
| `account.usage_applied.v1` | At least once, two publish paths | Per account partition | By (partition, stream, `stream_seq`). A lower `ratingPos` than one already seen changes nothing |
| `netops.enforcement_ack.v1` | At least once | Per account (Kafka key) | Idempotent by (account, `stdSeq`), see Idempotency |
| Headroom and standing queries | Synchronous request/response; the client retries `RETRY` and `MOVED` | — | Read-only |

## Idempotency

| Input | Key | On duplicate | Same key, different content |
|---|---|---|---|
| E1/E1′ (via the booking idempotency index) | (account, idempotency key) | The request's current status, no entry (RFC-002 §3.1) | Not accepted, as key reuse |
| F1 | (ledger partition, epoch, sequence) per movement | No effect | Not possible: the ledger is single-writer |
| F2 | Rating position | No effect. An older figure is ignored | — (absolute values; the latest wins) |
| F4 | (identity partition, sequence); per key, the highest version wins; events at or below `id_ts` are skipped | No effect | The lower version is ignored |
| F5 command variants | (`actionId`, account) | The first entry's outcome is answered | Refused as a conflict, recorded |
| F5 feed variant, F6 | (receivables partition, epoch, sequence), in `rcvPos` order | No effect | — |
| F7 | (variant, instant, subject) | Re-arming after takeover finds the tick already applied | — |
| F8 | (account, `stdSeq`) | No effect | First applied wins; `ENFORCEMENT_ACK_CONFLICT` alerted (gap filled here, see C-6) |
| F11 | (account, price version) | No effect | — |
| `StandingEvent` at consumers | (partition, stream, `stream_seq`); semantically `stdSeq` | No effect | — |
| `UsageAppliedAck` at rating | (partition, stream, `stream_seq`) | No effect | — |

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
| Suspension to enforcement | 60 s. The F7 `enforcement_check` fires at `since + 60 s` | X2-S08, P4-S27 |
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
- **Topics.** A breaking change to `StandingEvent`, `UsageAppliedAck` or `EnforcementAck`
  is a new topic `….v2`, published beside `v1` until every consumer has moved. Within `v1`,
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
P4-S111, P4-S114; P3-S37, P3-S61; X1-S06, X1-S37; X2-S07, X2-S08, X2-S17, X2-S18, X2-S21,
X2-S24, X2-S27.

## Conformance tests

**Provider (RFC-004 module, run against the library alone):**

| # | Test | Scenarios |
|---|---|---|
| P1 | Replay determinism: every generated account log replayed on the current and previous rules versions reproduces every recorded verdict, outcome and `answer`. Iteration order, integer-only arithmetic and the absence of clock reads are checked by a lint | P4-S72 |
| P2 | `admit` check order and amounts on RFC-004's worked examples (P2-S38 `88,000` / `1,088,000`; P2-S39 row 4; P4-S68; P2-S117 rows 1 and 2) | P2-S38, P2-S39, P4-S68, P2-S117 |
| P3 | Arrival-order sequence: random concurrent requests of one account and key; every verdict equals a strictly sequential evaluation over the undecided holds; refusals by an in-flight hold stand | P2-S70, P2-S71, P2-S112, P4-S66 |
| P4 | Envelope: queued Increase/Extend behind every combination of Increase, Extend, Decrease and Shorten ahead, each outcome confirmed or failed, with price steps between intake and decision. `x ≥` the true added hold, the excess is released at E5, and nothing suspends from its own queue (J-01 trace: 36,000 / 24,000) | P2-S70, P4-S66 |
| P5 | Minute-piece rates: a `Part.rate` with a cut step at `T_eff` gives `cov_r`, `e_{r,k}` and ρ⁺ read at each minute; equal to a brute-force per-minute sum | P4-S60 row 5 |
| P6 | Commit-timestamp evaluation: the same batch evaluated at `ts` across 00:00 UTC, across a fee-term end and across an `LB` step gives the recorded E1 ↔ E1′ flips | P4-S72 |
| P7 | `LB` span: random `hp` schedules; `LB(ts)` equals the brute-force maximum over `[ts − 370 s, ts + 60 s]`; P3-S37 gives 53,750 µ | P4-S16, P4-S19, P3-S37 |
| P8 | Invariants A-1 and A-2 after every apply in a randomized simulation (postings with lag, price changes, suspensions, resumptions, release after grace) | P4-S10, P4-S64, P4-S66, P4-S101 |
| P9 | Standing machine: every RFC-004 §A7 worked example (P4-S22, S92, S93, S94, S97, S101, S105, S108, S114 rows 1 and 2); `RA` itemised equals the least resuming top-up found by search | P4-S18, P4-S22, P4-S114 |
| P10 | F2 pairing: figures and F1s in every interleaving, with `Δ_b` posted whole and not whole; `U` never counts a posted usage line twice, and headroom equals the exact value at every applied pair | P3-S61, P4-S16 |
| P11 | F7 deferral: `apply(F7)` with `ctx.ts < instant` returns `Deferred` and leaves the state unchanged | P4-S27, P4-S96 |
| P12 | F8 lateness: an ack at `since + 60 s` exactly, at `+60 s + 1 ms`, missing at the check, and duplicated with different `enforcedAt` | P4-S27 |

**Consumer and host (RFC-002 account owner, run on the substrate):**

| # | Test | Scenarios |
|---|---|---|
| H1 | `admit` and `apply` called only inside the batch transaction after its timestamp is read; a forced push re-evaluates the whole batch, and the committed verdicts equal a replay | P4-S72 |
| H2 | Same-entry endings: suspension (F1, F2, F3, F5, F6, F7) ends undecided additions only; F4 revocation ends that key's undecided requests; F7 `grace_ended` writes the E11 releases. No committed state has the cause without its endings | P2-S69, P2-S72, P2-S77, P4-S23 |
| H3 | Gates: F2 held until `ledger_pos ≥ X`; invoice events held until their `ledgerPos`, across owner failover; no transient resume | P4-S94, P4-S105, P4-S111 |
| H4 | Identity freshness: the push is blocked with identity reachable or unreachable; after takeover the watermark is unset; no E5 with `ts > iamFresh + 45 s`; no F4 is written for event-free heartbeats; a revocation is applied within 60 s by catch-up | X1-S06, P2-S72, P2-S103 |
| H5 | `rateCheck`: over-limit submissions create nothing, and polls are not counted; at most twice the limit in the second after an owner change | P2-S41, P2-S68 |
| H6 | Provisional key (S-1): an intake with a signed key record for a key not yet applied is admitted under its limits, recorded in E1, and replays identically after the F4 arrives | X1-S06, P2-S40 |
| H7 | Exactly-once effect of every funds input under kill or pause of the owner mid-batch: no F entry is applied twice and none is skipped | P4-S57, X2-S21 |

**Feeds and queries:**

| # | Test | Side | Scenarios |
|---|---|---|---|
| Q1 | `account.standing.v1`: a transition at entry `ts` is visible on the topic within 10 s, through the owner path and through the relay path with the owner killed after commit; duplicates and replays are dropped by `stream_seq`, then by `stdSeq` | Owner / network-operations stub | P4-S25, X2-S17 |
| Q2 | Standing query returns `standing`, `since` and `stdSeq` at a stated position equal to the log | Status replica | P4-S26 |
| Q3 | Enforcement ack round trip: on time, late, missing, duplicated | Network-operations stub / owner | P4-S27, X2-S08 |
| Q4 | Headroom answer: fields present; `items.headroom = balance − fundsHeld − Σ(unposted + latenessBound) + creditLimit`; agent-key headline `kh_k`; `position` lets P4-S72's rebuild reproduce it; p99 ≤ 200 ms per region | Status replica / edge / probe | P4-S15, P4-S16, P4-S17, P4-S55, X2-S18, X2-S27 |
| Q5 | `account.usage_applied.v1`: one ack per F2 with `appliedAt` = the F2's `ts`; rating emits no gated usage batch before an ack covering a figure that names it; gap recovery by topic replay (retention ≥ 7 days) and by `usage_applied_since` beyond it | Owner / rating | P3-S61 |

## Settled

The RFCs disagreed on these three points. The orchestrator's binding decision for each is
recorded here, and nothing in this section blocks Frozen.

| # | Point | Where the RFCs differed | Decision (binding) |
|---|---|---|---|
| S-1 (was M1) | **A key not yet applied by F4** | RFC-004 §A10: `rate_check` and `Ask` carry no key limits. RFC-002 §3.1 and RFC-005 C3: such a key is admitted under its identity-signed key record's limits, held provisionally | `Ask.provisionalKey` and `PrincipalCtx.provisionalKey` carry the verified record's limits. They are **recorded in E1/E1′**, so replay is exact. They apply only while the key is absent from applied state, are ignored if the applied key is revoked or has a higher version, and are superseded by the F4 that applies the key |
| S-2 (was M2) | **Holder and definition of `iam_fresh`** | RFC-002 and RFC-004: the booking module holds it, "advanced by every heartbeat". RFC-005 C3: "F4 keeps `iam_fresh`", defined as the minimum over the partitions | The booking module holds it, in owner memory. `iam_fresh = max( min over the identity-push partitions feeding the slot of each partition's latest resolved timestamp, the last catch-up's read timestamp )`. It is unset after any acquisition |
| S-3 (was M3) | **Freshness at the KYB check of F5 `set`** | RFC-004 §A4 and RFC-002 §7.3: no freshness condition. RFC-005 §3.6 and C10: checked with `iam_fresh` within 45 s, both recorded | If `ts > iamFresh + 45 s`, or `iamFresh` is unset, nothing is appended and the command is answered "temporarily unavailable" (the console retries). Otherwise the F5 records `iamFreshUsed`. The KYB refusal rule is unchanged |
| S-4 | **Gap fills C-1 … C-7** | — | C-1 … C-6 are accepted as written. C-7 is **replaced**: a view and index on RFC-002's outbox for rating would be a cross-owner table read, which RFC-000 forbids. Rating recovers by topic replay (retention ≥ 7 days) and by the owner-served `usage_applied_since` beyond that |

## Consumer obligations (RFC errata)

The RFC owners must apply these errata. None of the RFCs is edited by this contract.

| RFC | Erratum |
|---|---|
| RFC-004 Part A | §A10: `Ask` gains `provisionalKey?` (the key record's limits), and `rate_check` takes it in the principal context. §A5.1: checks 0, 2 and 5 and the rate limits read a provisional key's limits while the key is not applied (S-1). §A2 and JR-11: replace "advanced by every push heartbeat's resolved timestamp" with S-2's definition. §A4 F5 and §B12: `set` composed only if `ts ≤ iam_fresh + 45 s`, otherwise "temporarily unavailable" with nothing appended; the entry records the `iam_fresh` used (S-3) |
| RFC-002 | §2.2 E1/E1′: record `provisionalKey` in the funds payload (S-1). §1.2, §1.3, §2.4 table and item 14: replace "advanced by every heartbeat" with S-2's definition. §7.3 and §13.1 credit-limit row: S-3's freshness gate and answer. §13.1: provide `usage_applied_since(account partition, position)`; `account.usage_applied.v1` retained at least 7 days (S-4) |
| RFC-003 | §5.9 and §7: on a gap in usage-applied acknowledgements, replay the topic, then call `usage_applied_since`. Never read the owner's outbox (S-4) |
| RFC-005 | C3 and §3.3: `iam_fresh` is held by the booking module, not by F4; its definition is S-2's |
| RFC-006 | §5.4: retention of `account.usage_applied.v1` at least 7 days. §5.5: for this stream, the outbox follower-read gap path is replaced by `usage_applied_since` (S-4) |

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
  timestamp, carried as header `ts` and as `appliedAt`.
- **C-5.** Every headroom answer carries `items.headroom` (`h`), so that the wallet probe's
  consistency check holds for every principal. For an agent key, the headline remains `kh_k`.
- **C-6.** The enforcement acknowledgement is idempotent by (account, `stdSeq`). For a
  repeat with a different `enforcedAt`, the first applied wins and `ENFORCEMENT_ACK_CONFLICT`
  is alerted. `enforcedAt` is network operations' clock (EpochMs). Neither RFC fixes this
  key, and network operations has no RFC.
- **C-7.** *Replaced by S-4.* Rating recovers usage-applied gaps by topic replay
  (retention ≥ 7 days) and by the owner-served `usage_applied_since` query. There is no
  read of RFC-002's tables. Network operations recovers gaps by the standing query.
