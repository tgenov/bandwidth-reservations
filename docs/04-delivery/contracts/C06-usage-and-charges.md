# C06. Usage and charges

| | |
|---|---|
| Contract ID | **C06** |
| Name | Usage and charges: catalogue, unposted usage, usage-applied acknowledgement, charge lines, postings, ledger movements, metering reports, evidence |
| Version | 1 (draft 3: review 44's F01 … F25 and decisions D1 … D4 applied, on top of draft 2's settled points C06-M1 … C06-M12) |
| Status | **Draft, for contract review.** No open mismatch. The orchestrator settled C06-M1 … C06-M12 and adopted review 44 (both binding). The RFC errata these imply are listed under "Consumer obligations", and the upstream issues raised under "Upstream issues". See "Settled" and "Review 44 resolution" at the end |
| Provider | **RFC-003** (rating and metering): Catalogue (with RFC-001's link registry and RFC-006 placement's probe-account projection), Unposted-usage feed, Charge-line feed, Quarantine report feed, Breach report feed, Evidence query. **RFC-004** (ledger and settlement): Posting acknowledgement, Ledger posting port, Ledger movement feed. **RFC-002** (account owner; semantics in RFC-004 §A4 F2): Usage-applied acknowledgement. This contract is the **canonical definition** of the usage-applied acknowledgement; C05 refers to it |
| Consumers | **Catalogue:** RFC-002 (account owner: locked prices, partner terms, price notices); RFC-004 (settlement: weights; funds module F3, F11); RFC-001 and RFC-006 (probe designations, display only); network operations (edge policing of `usage_rate_cap`). **Unposted usage:** RFC-002 applies it as F2; RFC-004 defines the semantics. **Usage-applied acknowledgement:** RFC-003. **Charge lines:** RFC-004 settlement. **Posting acknowledgement:** RFC-003. **Ledger posting port:** settlement, payments, payouts, receivables, reconciliation (all RFC-004; AI-44-2). **Ledger movement feed:** RFC-002 account owner (F1); RFC-003 cold re-rate; RFC-004 receivables, payouts, settlement's supplier partition and reconciliation; reporting; RFC-006 history and audit. **Quarantine and breach reports:** operator console, notifier, reporting, RFC-006 alerting. **Evidence query:** operations, support, finance |
| Transport | **Kafka events.** Each is published from the producer's transactional outbox, with the changefeed relay as the guaranteed second path (RFC-000 §5.5). The exception is the posting acknowledgements for refusals and settlement's exclusions, which settlement publishes directly (F12). Topics: catalogue feed, unposted-usage feed, usage-applied acknowledgement, charge-line feed, posting acknowledgement, ledger movement feed and its views, quarantine and breach report feeds. **Synchronous gRPC:** catalogue query; ledger posting port (a command to the ledger partition's owner); evidence query (served by RFC-006 history) |
| Pinned to | `requirements-v1.10`. RFC-000 revision 4.4, §8 rows: Catalogue, Unposted-usage feed, Usage-applied acknowledgement, Charge-line feed, Posting acknowledgement, Quarantine report feed and breach report feed, Evidence query, Ledger posting port, Ledger movement feed, Account slot map, Probe designation and exclusion. RFC-002 revision 5 (§3.2, §2.5, §13.1, §13.2). RFC-003 revision 5 with erratum 5.1 (§2, §5.2 … §5.10, §6, §7, §8). RFC-004 revision 5 with erratum 5.1 (§A3, §A4, §B1 … §B3, §B6, §B9, §B10, §B12). Review [44](../../reviews/44-contract-C06-review.md) |

## Purpose

C06 is the money seam between three owners:
- metering and rating (RFC-003);
- the account owner's funds module (RFC-002 with RFC-004 Part A);
- settlement and the ledger (RFC-004 Part B).

It carries:

1. **Reference data**, which every side uses to price, split and bound exposure. This is the
   catalogue: products, routes with split weights, price and weight versions published at
   least 1 min ahead, price corrections, partner terms, account-product terms and policy
   parameters taking effect at least 1 min ahead, and probe designations.
2. **The exposure loop.** Rating publishes the unposted-usage figure `U(X)`, with the
   in-flight usage batch `b` and its reduction `Δ_b`. The account owner applies a figure only
   once its ledger position reaches `X`. Its usage-applied acknowledgement then opens
   rating's publish-before-emit gate.
3. **The charging loop.** Charge lines and cost lines travel in two batch streams
   (reservation and usage). Settlement posts them as ledger movements, and a usage batch is
   posted **whole or not at all**. Per-line posting acknowledgements go back to rating. The
   ledger movement feed tells the account owner which usage batch each movement posted.
4. **Metering's operational outputs**: quarantine and breach reports, and the evidence query.

The design depends on headroom being exact at every pair the account owner applies (RFC-003
§5.9). This contract fixes the fields and rules that make that true.

## Conventions

| Quantity | Representation |
|---|---|
| Money | Integer **micro-USD** (10⁻⁶ USD), type `MicroUsd`. In JSON it is a signed decimal integer **string** (`"-600"`); in TypeScript a `bigint`; in SQL `INT8` or `DECIMAL(…, 0)`. Never a float |
| Prices | Integer **pico-USD** (10⁻¹² USD) per unit, type `PicoUsd` (decimal string). The unit is the **Mbps-minute** for `reservation_price` and the **GB (10⁹ bytes)** for `usage_price` (RFC-003 §2). A price of 1.5 micro-USD per Mbps-minute is `"1500000"` |
| Rates | Integer **Mbps** (10⁶ bit/s) |
| Volumes | Integer **bytes**. A usage line's exact bytes are a rational (RFC-003 §2, ELA) and do not cross this contract |
| Minutes | UTC minute start, ISO 8601 with a `Z` and zero seconds, type `Minute` (`"2026-10-12T10:05:00Z"`). Minute `m` is `[m, m + 60 s)` |
| Database timestamps | The database's commit or resolved timestamp (HLC), type `DbTs`: a decimal string `"<wall-ns>.<logical>"`, compared numerically. Commit timestamps are the only clock for positions, posting times and closure |
| Durations | Milliseconds, unless the name ends in `S` (seconds) |
| Identifiers | Pseudonymous opaque strings (RFC-000 A11): `AccountId`, `ReservationId`, `RequestId`, `ProductId`, `RouteId`, `LinkId`, `SupplierId`, `ExporterId`, `FeeId`, `ReductionId`. No field holds personal data (X1-N11) |
| Event identity | `EventId = { partition, stream, streamSeq, generation, epoch }`: the substrate's per-stream contiguous sequence, with the writer's generation and epoch (RFC-000 §8 substrate conventions, AI-17-2, AI-R6-3; C06-M10). It is identical on the owner's direct publish and on the changefeed relay |
| Canonical `SourceRef` encoding | Used wherever a `SourceRef` is digested or compared (dedup for 7 years; F17). The fields come in the order the schema lists them, with the `kind` tag first. Integers and sequences are decimal strings with no leading zeros. Minutes are in the `Minute` form. Identifiers are UTF-8 strings. Each field is length-prefixed (u32 big-endian). The result is hashed with SHA-256 |
| Encryption | Every message body is encrypted owner-side under its producer's feed key (RFC-005 column encryption, AI5-3). Only the Kafka key, the `EventId` and resolved markers are in the clear. The schemas below are the decrypted logical form |
| Encoding | JSON (UTF-8) in the encrypted body. Every message carries `type` and `schemaVersion` |

### Topics

The topic names are this contract's. Retention follows RFC-006 §5.2.

| Topic | Producer (only writer, ACL) | Key | Retention | Consumers |
|---|---|---|---|---|
| `catalogue.v1` | Three writer kinds, each for its own entity types. The catalogue partitions (RFC-003) write every type except the two below. RFC-001's link-registry partition writes `link` and `link_rules`. RFC-006 placement writes `probe_designation` for accounts (F10) | Entity (`<entityType>:<entityId>`) | 7 days | Every catalogue consumer; each keeps a full replica |
| `rating.unposted-usage.v1` | Rating (RFC-003) | `AccountId` | 7 days | Account owner (RFC-002) |
| `account.usage-applied.v1` | Account owner (RFC-002) | `AccountId` | 7 days | Rating (RFC-003) |
| `rating.charge-lines.v1` | Rating (RFC-003) | `AccountId` (the buyer; for a cost line, the causing buyer) | 3 days | Settlement (RFC-004) |
| `settlement.posting-acks.v1` | Two producers, each for its own answers (F12). The **ledger** writes acknowledgements of committed movements, as the posting-answer row of the posting transaction's outbox (RFC-004 §B1.3). **Settlement** publishes directly the acknowledgements of `refused`, `refused_batch` and mapping exclusions, which commit nothing; it publishes them at least once before it commits its Kafka offset. ACL: these two principals only | `AccountId` | 7 days | Rating (RFC-003) |
| `ledger.movements.v1` | Ledger (RFC-004) | Ledger partition | 7 days | Reporting, reconciliation, RFC-006 history and audit, rating's cold re-rate |
| `ledger.movements.by-buyer.v1` | Ledger, filtered view: **every movement homed at the buyer**, whatever ledger accounts it touches. This includes cost-line-only and Share-borne-fee-only usage batches (F13) | `AccountId` | 7 days | Account owner (F1), receivables |
| `ledger.movements.by-supplier.v1` | Ledger, filtered view: every movement touching `S:<supplier>:*` | `SupplierId` | 7 days | Payouts, settlement's supplier partition (deviation report) (F20) |
| `ledger.movements.by-external.v1` | Ledger, filtered view: every movement touching `X:*` (M1, M2, M3, M14 … M17, M20, M21, M22) | External account | 7 days | Reconciliation (F20) |
| `rating.quarantine-report.v1` | Attribution stage A (RFC-003) | `LinkId` | 7 days | Operator console, notifier, reporting, RFC-006 alerting |
| `rating.breach-report.v1` | Rating and stage A (RFC-003) | `ExporterId` (coverage rows: serving region) | 7 days | Operator console, notifier, reporting, RFC-006 alerting |

Every topic also carries **resolved markers** (`ResolvedMarker`, below) for each destination
partition. They are emitted by RFC-006's closure emitter. A marker's value is the minimum
over every changefeed partition that can feed that destination, and it is published only
after every such row (RFC-000 §8, AI-27-3, AI6-11). Each filtered view preserves the order
of the full feed within its key.

## Schema

### 1. Common types

```ts
type MicroUsd = string;   // signed decimal integer, micro-USD
type PicoUsd  = string;   // non-negative decimal integer, pico-USD per unit
type DbTs     = string;   // HLC "<wall-ns>.<logical>"
type Minute   = string;   // "YYYY-MM-DDTHH:MM:00Z"
type Seq      = string;   // non-negative decimal integer (bigint)

interface EventId { partition: string; stream: string; streamSeq: Seq; generation: number; epoch: number }

interface ResolvedMarker {          // on every topic of this contract
  type: "ResolvedMarker"; schemaVersion: 1;
  destinationPartition: number;     // Kafka partition it closes
  resolvedTs: DbTs;                 // no row committed at or below it follows on this partition
}

interface LedgerPosition {          // a position in one ledger partition's log
  partition: number;                // ledger partition (1 … 128, plus Share sub-partitions)
  seq: Seq;                         // partition log sequence; "0" = nothing posted yet
  commitTs: DbTs;                   // commit timestamp of the movement at seq
}

interface RatingPosition {          // monotone per account, ordered by (generation, seq)
  ratingPartition: string;
  generation: number;
  seq: Seq;                         // rating_log sequence of the entry that produced the figure
}

interface CataloguePosition { resolvedTs: DbTs }   // feed resolved timestamp the consumer had applied

type Cause =
  | { kind: "share" }
  | { kind: "supplier"; supplier: SupplierId }
  | { kind: "other" };

type BatchId = string;  // "<ratingPartition>:<generation>:<emittedSeq>:<index>", unique forever
```

### 2. Catalogue (feed and query)

```ts
type CatalogueEntity =
  | { entityType: "product"; productId: ProductId; kind: "guaranteed" | "best_effort"; permitsBurst: boolean }
  | { entityType: "route"; routeId: RouteId; legs: LinkId[] /* ordered */; equivalentPathOf?: RouteId }
  | { entityType: "price_version"; product: ProductId; route: RouteId;
      priceKind: "reservation_price" | "usage_price";
      priceVersion: string;
      price: PicoUsd;                // per Mbps-minute | per GB
      effectiveFrom: Minute;         // ≥ ceil_min(announcedAt + 60 s); usage_price: ≥ ceil_min(announcedAt + price_notice)
      announcedAt: DbTs;             // commit timestamp of the recording entry
      oeEffective?: Minute }         // reservation_price only: max(effectiveFrom, ceil_min(announcedAt + price_notice))
  | { entityType: "price_correction"; sourceRef: string;
      target: { priceVersion: string } | { reservation: ReservationId; part?: string };
      minuteFrom: Minute; minuteTo: Minute;      // [from, to)
      correctedPrice: PicoUsd; cause: Cause; reason: string }
  | { entityType: "split_weights"; route: RouteId; weightsVersion: string;
      effectiveFrom: Minute;         // ≥ ceil_min(announcedAt + 60 s); never retroactive (D4)
      announcedAt: DbTs;
      legs: Array<{ link: LinkId; supplier: SupplierId; weight: number /* positive integer */ }>;
      commissionWeight: number }     // positive integer
  | { entityType: "partner_terms"; partnerLink: LinkId; supplier: SupplierId; minimumTermS?: number;
      cancellationFee?: MicroUsd; decreaseAllowed: boolean; maxHoldS?: number; acceptsShareExpiry: boolean }
  | { entityType: "account_product_terms"; account: AccountId; product: ProductId; usageRateCapMbps: number;
      effectiveFrom: Minute;         // ≥ ceil_min(recordedAt + 60 s) (D3)
      recordedAt: DbTs }
  | { entityType: "policy_parameters"; effectiveFrom: Minute;   // ≥ ceil_min(recordedAt + 60 s) (D3)
      recordedAt: DbTs;
      maxLatenessS: number; flowActiveTimeoutS: number; attributionLagMaxS: number;
      rtoAdmS: number; priceNoticeS: number; disputeWindowS: number }
  | { entityType: "probe_designation";
      subject: { account: AccountId; slotMapVersion: string }      // written only by RFC-006 placement (F10)
             | { supplier: SupplierId } | { link: LinkId } | { exporter: ExporterId };
      probe: boolean }
  | { entityType: "link"; /* RFC-001 link registry: supplier, endpoints, Share or partner, probe flag, retired */ [k: string]: unknown }
  | { entityType: "link_rules"; policyVersion: string; /* RFC-001 link validity rules (RFC-001 §10) */ [k: string]: unknown };

interface CatalogueEvent {
  type: "CatalogueEvent"; schemaVersion: 1;
  eventId: EventId;
  entityVersion: Seq;                // per-entity order
  committedAt: DbTs;                 // knowledge time (bitemporal)
  principal: string;                 // pseudonymous; requester (placement's workload identity for its projection)
  approver?: string;                 // four-eyes actions
  reason?: string;
  body: CatalogueEntity;
}

// Query (gRPC, follower read at T)
interface CatalogueQuery { entityType: string; entityId: string; knownAt: DbTs; effectiveAt?: Minute }
type CatalogueAnswer = { found: true; event: CatalogueEvent } | { found: false };
```

### 3. Unposted-usage feed

```ts
interface UnpostedUsageFigure {
  type: "UnpostedUsageFigure"; schemaVersion: 1;
  eventId: EventId;
  account: AccountId;
  ratingPosition: RatingPosition;
  ledgerPositionX: LedgerPosition;    // the buyer's home ledger partition; U(X) computed against it
  inFlightUsageBatch?: BatchId;       // present iff a gated usage batch is emitted or about to be
  products: Array<{
    product: ProductId;               // attachment set ∪ every product with a usage line not fully posted
    unpostedUsage: MicroUsd;          // U(X) ≥ 0
    usageReduction?: MicroUsd;        // Δ_b for this product, ≥ 0; present iff inFlightUsageBatch
  }>;
  accruedReservationUnposted?: MicroUsd;  // information only (P4-S16); not in the headroom formula
  publishedAt: DbTs;
}
```

There is no lateness-bound field. The bound is computed only by RFC-004's F3, from the
catalogue (RFC-003 §5.9, RFC-004 §A3). At the defaults its window is 430 s and its price
span is `[now − 370 s, now + 60 s]`.

### 4. Usage-applied acknowledgement (canonical here; C05 refers to it)

```ts
interface UsageApplied {
  type: "UsageApplied"; schemaVersion: 1;
  eventId: EventId;                    // the account owner's usage-applied stream
  account: AccountId;
  appliedThrough: RatingPosition;      // rating position of the figure the F2 entry applied
  appliedTs: DbTs;                     // commit timestamp of that F2 entry (C06-M1)
  entry: {                             // identity of that F2 entry in the account owner's log (C05 v0.2)
    accountPartition: string; generation: number; epoch: number; seq: Seq };
  inFlightUsageBatch?: BatchId;        // as named by the applied figure
}
```

### 5. Charge-line feed

```ts
type LineKind = "reservation" | "usage" | "fee" | "share_borne_fee" | "carried_excess" | "dearer_path";

type SourceRef =
  | { kind: "reservation"; reservation: ReservationId; minute: Minute; seq: number }
  | { kind: "usage"; account: AccountId; product: ProductId; route: RouteId; minute: Minute; seq: number }
  | { kind: "fee"; reservation: ReservationId; feeId: FeeId }                                   // fee and share_borne_fee
  | { kind: "residue_fee"; request: RequestId; partnerLink: LinkId; feeId: FeeId }               // POL-28 residue
  | { kind: "carried_excess"; account: AccountId; product: ProductId; route: RouteId; minute: Minute; seq: number }
  | { kind: "dearer_path"; reservation: ReservationId; minute: Minute; seq: number };

type Reason =
  | "original" | "late_traffic" | "price_correction" | "quarantine_attribution"
  | "attribution_reversed" | "late_pol07_cut" | "corrected_record" | "superseding_record" | "re_rate";

interface ChargeLine {
  sourceRef: SourceRef;               // POL-29; seq = amendment sequence, 0 for an original
  lineKind: LineKind;
  account: AccountId;                 // buyer; causing buyer for cost lines
  reservation?: ReservationId;
  product?: ProductId;
  route?: RouteId;                    // required except for fee kinds; after a move: the path's catalogue route
  weightsVersion?: string;            // required except for fee kinds; for an amendment: the version its original was posted with (D4)
  payee?: { supplier: SupplierId; partnerLink: LinkId };   // required iff lineKind ∈ {fee, share_borne_fee} (F04)
  minute?: Minute;                    // absent only for fee kinds
  payer: "account" | "share";         // share for cost lines and Share-borne fees
  amount: MicroUsd;                   // signed; original: the charge ≥ 0; amendment: C − E
  newTotal: MicroUsd;                 // C (C06-M3)
  priorTotal: MicroUsd;               // E before this line; "0" for an original
  reason: Reason;
  reasonDetails?: Record<string, string>;  // record identities, correction id, operator, references; not compared (F17)
  cause?: Cause;                      // only where RFC-003 §5.7 gives one; never for late_pol07_cut
  triggerRef?: string;                // correction, attribution, reversal, superseded record
  lateCut?: { link: LinkId; reduction: ReductionId; extensionChunk: number };  // iff reason = late_pol07_cut
  priceCatalogue: CataloguePosition;  // catalogue position of the prices and weights used; not compared (F17)
  feeId?: FeeId;                      // fee kinds
}

interface ChargeLineBatch {
  type: "ChargeLineBatch"; schemaVersion: 1;
  eventId: EventId;
  batch: {
    id: BatchId;
    kind: "reservation" | "usage";
    account: AccountId;
    minute?: Minute;                  // reservation batch: the one charge minute
    gated: boolean;                   // usage batch holding ≥ 1 usage line
    lineCount: number;                // = lines.length (F01)
  };
  lines: ChargeLine[];                // 1 … 5,000 (the movement limit L); at most one sequence per line key (D2)
  emittedAt: DbTs;
}

interface AffectedMark {               // C06-M6: an annotation, never posted
  type: "AffectedMark"; schemaVersion: 1;
  eventId: EventId;
  account: AccountId; reservation: ReservationId; minute: Minute;
  leg?: LinkId; partnerLeg?: boolean; affected: boolean;
  source: "link_schedule" | "partner_leg";
}
```

### 6. Posting acknowledgement

```ts
type LineAck =
  | { sourceRef: SourceRef; outcome: "posted";
      duplicate: boolean;              // true: an idempotent repeat of a line posted earlier with the same content
      position: LedgerPosition; movementId: string;
      postedAmount: MicroUsd; postedTotal: MicroUsd }
  | { sourceRef: SourceRef; outcome: "excluded";
      reason: "content_conflict" | "prior_total_mismatch" | "out_of_sequence"
            | "batch_refused"            // usage batch refused whole because another of its lines could not be posted (D1)
            | "batch_over_limit" | "movement_refused";
      refusal?: "invalid" | "wrong_home" | "principal" | "stale";   // iff movement_refused
      conflictOf?: string;             // movement id holding the reference
      ledgerPostedTotal?: MicroUsd;    // content_conflict, prior_total_mismatch (C06-M2)
      ledgerLastSeq?: number;          // content_conflict, prior_total_mismatch (C06-M2)
      ledgerPosition?: LedgerPosition }; // position of the line's last posting (F19)

interface PostingAck {
  type: "PostingAck"; schemaVersion: 1;
  eventId: EventId;
  account: AccountId;
  batchId: BatchId;
  lines: LineAck[];                    // one per line of the batch, every line answered
}
```

### 7. Ledger posting port (gRPC, to the home partition's owner)

```ts
type MovementKind = "M1"|"M2"|"M3"|"M4"|"M5"|"M6"|"M7"|"M8"|"M9"|"M10"|"M11"|"M12"
                  | "M13"|"M14"|"M15"|"M16"|"M17"|"M18"|"M19"|"M20"|"M21"|"M22"|"M23";

interface PostMovementRequest {
  movementRef: string;                 // source reference of the movement (BatchId for charge batches)
  // principal: taken from the caller's mTLS / workload identity (RFC-005), never from the body (F18)
  operatorEnvelope?: unknown;          // relayed operator action (RFC-005), M21/M22
  cause: string;                       // causing fact
  currency: "USD";
  batch?: { id: BatchId; kind: "reservation" | "usage"; lineCount: number };   // lineCount: lines of the rating batch (F01)
  conditionalOn?: LedgerPosition;      // M18 only: no movement touched B since
  lines: Array<{
    kind: MovementKind;                // a usage batch mixes kinds
    lineRef?: SourceRef | string;      // charge, amendment, fee, cost lines: their SourceRef
    amendmentSeq?: number;
    priorTotal?: MicroUsd;             // every charge, amendment and cost line (F03); "0" for an original
    newTotal?: MicroUsd;               // every charge, amendment and cost line (F03)
    split?: { route: RouteId; weightsVersion: string; mode: "normal" | "own";
              explicitShares?: Array<{ party: string; amount: MicroUsd }> };
    entries: Array<{ ledgerAccount: string /* "B:<acct>", "S:<sup>:earn" … */; amount: MicroUsd /* ≠ 0 */ }>;
                                       // sums to zero; empty only for an M23 nil line
  }>;                                  // ≤ 5,000
}

type LineProblem = "conflict" | "prior_total_mismatch" | "out_of_sequence" | "invalid";

type PostMovementResponse =
  | { result: "committed"; movementId: string; postingTime: DbTs; position: LedgerPosition;
      lines: Array<{ lineRef?: SourceRef | string; outcome: "posted" | "duplicate" | "conflict"; of?: string }>;
                                       // "conflict" occurs only in a reservation batch
      whole?: boolean }                // usage batches only; always true when committed (D1)
  | { result: "refused"; reason: "invalid" | "wrong_home" | "principal" | "stale" | "over_limit"; detail: string }
  | { result: "refused_batch";         // usage batch refused whole, nothing posted (D1)
      lines: Array<{ lineRef: SourceRef; problem: LineProblem; of?: string;
                     ledgerPostedTotal?: MicroUsd; ledgerLastSeq?: number; ledgerPosition?: LedgerPosition }> }
  | { result: "unavailable"; why: "not_owner" | "moving" | "stopped" | "overloaded" };   // retry rules: Semantics
```

### 8. Ledger movement feed

```ts
interface MovementPosted {
  type: "MovementPosted"; schemaVersion: 1;
  eventId: EventId;
  movementId: string;                  // (home partition, sequence)
  position: LedgerPosition;
  postingTime: DbTs;                   // = position.commitTs
  movementRef: string;
  home: { account?: AccountId; supplier?: SupplierId; shareSubPartition?: number };
  kinds: MovementKind[];
  cause: string;                       // an M19 names its invoice
  currency: "USD";
  partyTotals: Array<{ ledgerAccount: string; amount: MicroUsd }>;
  lines: Array<{
    lineRef?: SourceRef | string; kind: MovementKind; amendmentSeq?: number;
    outcome: "posted" | "duplicate" | "conflict"; nil: boolean;
    amount?: MicroUsd;                 // buyer side (or payer side for cost lines), signed; charge lines (F05)
    postedTotal?: MicroUsd;            // line's posted total after this movement (F05)
    reason?: Reason; cause?: Cause;
    lateCut?: { link: LinkId; reduction: ReductionId; extensionChunk: number };
    payee?: { supplier: SupplierId; partnerLink: LinkId };   // fee kinds
    split?: { route: RouteId; weightsVersion: string; mode: "normal" | "own";
              shares?: Array<{ party: string; amount: MicroUsd }> }
              // normal mode: shares omitted, each party holds split(postedTotal) under weightsVersion;
              // own mode and cost lines after a downward amendment: explicit held shares
  }>;
  postedThrough?: Array<{ reservation: ReservationId; minute: Minute }>;
  feesPosted?: Array<{ reservation: ReservationId; feeId: FeeId }>;
  batch?: { id: BatchId; kind: "reservation" | "usage"; whole?: boolean };   // whole: usage batches only, always true
  buyer?: { account: AccountId; balanceAfter: MicroUsd; writtenOffOwedAfter: MicroUsd };  // from ledger_balance in the posting transaction
}
```

There is no `Cut` event. A cut at `T` is a read of every partition at one database
timestamp below the closed timestamp (RFC-004 §B1.3), and the feed's closure is its
`ResolvedMarker`.

### 9. Quarantine report feed

```ts
interface QuarantineEntryReport {
  type: "QuarantineEntryReport"; schemaVersion: 1; eventId: EventId;
  entryRef: string;
  record: { exporter: ExporterId; observationDomain: string; epoch: number; extendedSeq: Seq; version: number };
  minute: Minute; bytes: Seq;
  observationPoint: string; link: LinkId; supplier: SupplierId;
  reason: "no_binding" | "ambiguous_binding" | "identity_conflict";
  state: "quarantined" | "attributed" | "reversed" | "superseded";
  replacedBy?: string;                 // the entry that replaces a superseded one
  quarantinedAt: DbTs;
}
interface QuarantineAggregate {
  type: "QuarantineAggregate"; schemaVersion: 1; eventId: EventId;
  link: LinkId; supplier: SupplierId; minute: Minute;
  bytesByState: Record<"quarantined" | "attributed" | "reversed" | "superseded", Seq>;
}
```

### 10. Breach report feed

```ts
type BreachReport =
  | { type: "LatenessBreach"; schemaVersion: 1; eventId: EventId; exporter: ExporterId; record: string; latenessMs: number }
  | { type: "AttributionLagBreach"; schemaVersion: 1; eventId: EventId; exporter: ExporterId;
      records: Array<{ from: string; to: string }>; lagMs: number; provisioning?: boolean }  // provisioning: released from the pending-binding hold
  | { type: "SupersessionRaisedBytes"; schemaVersion: 1; eventId: EventId; exporter: ExporterId; record: string; version: number; bytesDelta: Seq }
  | { type: "CountedInTime"; schemaVersion: 1; eventId: EventId; minute: Minute; servingRegion: string; allCountedInTime: boolean };
```

### 11. Evidence query (gRPC, served by RFC-006 history)

```ts
interface EvidenceRequest {
  target: { reservation: ReservationId } | { link: LinkId };
  minuteFrom: Minute; minuteTo: Minute;      // [from, to)
  readGrant: unknown;                        // RFC-005 signed grant (role, reason, not_after)
}
type EvidenceItem =                          // server stream
  | { kind: "record"; record: { exporter: ExporterId; observationDomain: string; epoch: number; extendedSeq: Seq };
      acceptedAt: DbTs; startMs: number; endMs: number; bytes: Seq; packets: Seq;
      observationPoint: string; attributionKey: string;
      versions: Array<{ version: number; outcome: "accepted" | "refused"; reason?: string; acceptedAt: DbTs }> }
  | { kind: "rejected_payload"; record: string; keyedDigest: string; digestKeyVersion: number; reason: "no_template" | "unparseable" };
```

## Semantics

### Catalogue

- **Writers.** Changes are operator commands through the console, each under an operator
  action envelope (RFC-005):
  - prices and split weights: commercial, with a second commercial approver;
  - price corrections and `usage_rate_cap`: finance;
  - partner terms: one commercial operator;
  - `policy_parameters`: the role that owns the policy (finance for `max_lateness`,
    `attribution_lag_max`, `dispute_window` and `rto_adm`; commercial for `price_notice` and
    `flow_active_timeout`), always four-eyes with a second operator of that role (F07).

  The link registry rows (`link`, `link_rules`) are RFC-001's. Probe designation of accounts
  is placement's (below). Each accepted change is one `CatalogueEvent`; a refused one emits
  nothing. A version is never changed or withdrawn. A mistaken price is fixed by a
  `price_correction`; a mistaken weight only going forward (D4).
- **Lead times.**
  - Every `price_version`: `effectiveFrom ≥ ceil_min(announcedAt + 60 s)`.
  - Every `usage_price` version, in addition: `effectiveFrom ≥ ceil_min(announcedAt + price_notice)`.
  - Every `split_weights` version: `effectiveFrom ≥ ceil_min(announcedAt + 60 s)` (D4).
  - Every `account_product_terms` and `policy_parameters` version:
    `effectiveFrom ≥ ceil_min(recordedAt + 60 s)` (D3).

  A version that breaks its rule is refused at approval and never reaches the feed.
- **`oeEffective`** (RFC-003 §6.2) is the minute from which **open-ended** reservations take
  a `reservation_price` version: every part locked before it is re-priced to the version. New
  bookings and new parts take the version from `effectiveFrom`. A version whose `oeEffective`
  concerns open-ended reservations of an account drives that account's F11 price notice. RFC-002
  appends it at the announcement, idempotent by (account, price version), and records the
  price step effective at `oeEffective` (F21).
- **Freshness gate (consumer).** The account owner composes an intake only while its cache's
  applied `resolvedTs` is within **60 s** of the intake's timestamp. Otherwise it does not
  accept the intake: no entry, unavailability, alerted. E1 records the price version and the
  `CataloguePosition`. Every version effective by `T + 60 s` was announced by `T`, so a cache
  through `T` cannot lock a price that a published version would have replaced.
- **Routes and weights.** Every equivalent path is a `route` with `split_weights`,
  registered before it is offered; RFC-002 refuses (and alerts) a candidate that is not.
  Weights are positive integers. An original is split with the version in force at its
  minute. Every amendment of that line carries the **same** `weightsVersion` as its
  original (D4); the ledger holds that version and refuses a mismatch as `invalid`.
  Settlement never derives a version itself.
- **Exposure parameters (F3; D3).** RFC-004's F3 takes:
  - `usage_rate_cap` per (account, product);
  - the highest-`usage_price` schedule per product (from `price_version`);
  - `policy_parameters`.

  It computes `LB = ceil(cap* × Λ* × hp*)`, where each starred value is the **maximum** in
  force at any instant of the span `[ts − (Λ* − 60 s), ts + 60 s]`. `Λ*` is the largest window
  in force over that span, found as the fixed point over the recorded schedule. An increase
  therefore enters the bound 60 s before it takes effect, and a decrease leaves it
  `Λ* − 60 s` (370 s at the defaults) after. Every step is an F7 exposure-step entry. The
  edge polices the new cap from its `effectiveFrom`.
- **Probe designations (F10).** Probe **accounts** are designated only by placement's
  account slot map (RFC-006; RFC-000 §8 B-AI-10; C01 S-M11). The catalogue carries account
  designations as a **read-only projection**, which placement writes from the slot map; no
  console command writes it. The catalogue displays the designation and never decides it.
  Every consumer that excludes probe accounts (rating: no lines, no figures; the funds module:
  F9) takes the designation from the slot map, or from this projection, which is the same
  thing. Probe links, suppliers and exporters stay catalogue facts, set as RFC-006 states.
- **Query.** It answers "entity E as known at T, effective at minute m" by a follower read at
  T. Errors: `NOT_FOUND`; `UNAVAILABLE` (retry). No booking, record or charge waits on a
  catalogue write.

### Unposted-usage figure

- **Content.** Per product, `U(X) = Σ_L max(0, ⌊V(L)/10⁶⌋ − P_X(L))` over the account's usage
  lines of the product. `P_X(L)` is what settlement acknowledged as posted for `L` through
  ledger position `X`. `X` is a position of the buyer's home ledger partition such that
  every posting of a usage line of the account at or below `X` has been acknowledged to
  rating. `Δ_b = U(X) − U(X with b posted)`, per product, computed line by line with the same
  `max(0, ·)`. Rating never counts a line in `Δ_b` that it already holds as posted. Only
  usage batches are ever named, never reservation batches.
- **Producer.** A figure is published whenever it changes, **at most once per account every
  2 s** (`exposure_publish_interval`), as absolute values. A usage batch that becomes ready
  triggers a figure at the next allowed moment. Probe accounts get none. Parked lines
  (below) stay counted in `U`.
- **Consumer (account owner, F2).**
  - It holds a figure until its applied ledger position `P ≥ X`, then applies the latest
    held figure per account in each batch.
  - It sets `U[product] = U(X) − Δ_b` if an applied F1 at or below `P` reports batch `b`
    posted (a committed usage-batch movement is always `whole`), else `U(X)`.
  - It re-applies the reduction when a later F1 reports `b` and the current figure still
    names `b`.
  - A figure with a `ratingPosition` at or below the last applied one is dropped.
- **Errors.** None returned. An F2 lag beyond `attribution_lag_max` is alarmed (RFC-006,
  J-18).

### Usage-applied acknowledgement

- It is written as the outbox row of the F2 entry, so it exists iff the figure was applied.
- `appliedThrough` tells rating that the account owner has applied a figure at or above that
  rating position. Rating keeps the **maximum** `appliedThrough` per account; a redelivered
  or older acknowledgement is a no-op and never lowers the gate (F24).
- **Publish before emit.** Rating emits a gated usage batch `b` only after it has received an
  acknowledgement at or above the position of a figure that names `b` and already counts
  `b`'s lines.
- `appliedTs` is the "counted" time of every record that figure newly counts. Rating reports
  each record counted more than `attribution_lag_max` (10 s) after its acceptance as an
  attribution-lag breach, and uses `appliedTs` for the per-minute, per-region measure of
  X2-S22.

### Charge-line batches

- **Reservation batch.** It carries the reservation-line **originals** of one account and one
  minute, at most 5,000 lines; a minute above that becomes several reservation batches with
  disjoint reservations. It is never gated. Up to **8 are in flight per account**. A
  reservation's line of `m + 1` is emitted only once its line of `m` is acknowledged.
  Settlement posts each batch as one **M4**. A conflicting line is excluded on its own and
  the rest are posted.
- **Usage batch.** It carries every other line: usage originals and amendments,
  reservation-line amendments including "late POL-07 cut", fees, Share-borne fees, cost lines
  and their amendments. It holds at most 5,000 lines.
  - **One is in flight per account**: the next is emitted only after every line of the last
    is acknowledged.
  - It is **gated** by publish before emit iff it holds a usage line.
  - It is posted **whole, in one movement, or not at all (D1)**, never split and never
    shared with another batch.
- **One sequence per line per batch; sequences in order (D2).**
  - A usage batch carries **at most one amendment sequence per line key**.
  - For **every** line (reservation, usage, cost, late original), sequence `k + 1` is
    emitted only once sequence `k` has been acknowledged **`posted`**.
  - Amendments therefore reach the ledger in sequence, and settlement knows each line's mode
    (normal or own) from the ledger when it posts `k + 1`.
  - Each amendment keeps exactly one reason (RFC-003 §5.7).
- **Lines.** Originals of a reservation come in strictly increasing minutes. Each amendment
  has `amount = newTotal − priorTotal`. Fee lines are decided once: exactly the shown amount,
  `seq` 0, never amended (C06-M4). They name their `payee` (the partner and its link, from
  the lifecycle feed's fee shown, RFC-003 §5.4), carry no route or weights, and are not
  split. Probe accounts produce no lines.
- **Size.** Rating checks `lines.length ≤ 5,000` before it commits `emitted`. Settlement
  refuses a larger usage batch whole: nothing is posted, every line is acknowledged
  `excluded` with `batch_over_limit`, and an alert is raised. Rating then re-composes the
  lines into batches within the limit, under new `BatchId`s, each named in a new figure
  before it is emitted.
- **Settlement mapping** (RFC-004 §B2, §B3). The combinations that rating produces map as
  follows:

| `lineKind` | `seq` | `reason` | `cause` | Movement |
|---|---|---|---|---|
| reservation | 0 | original | — | M4 (one per reservation batch) |
| usage | 0 | original (or a late original) | — | M5 |
| fee (payer account) | 0 | original | — | M10, to `payee` |
| share_borne_fee (payer share) | 0 | original | — | M11, to `payee` |
| carried_excess | 0 | original | — | M12 |
| dearer_path | 0 | original | — | M13 |
| reservation | > 0 | **late_pol07_cut** (`amount < 0`, `lateCut` present) | **absent** | **M6**, normal mode: each party moves to `split(T_new)` less the shares already posted. **M7** if the line is already in own mode, each party `−split(−Δ)` (C06-M9). No `SH:corrections` entry, no `fault` debt, own mode not entered. Posted however late, even after the supplier was paid out |
| reservation | > 0 | price_correction with `amount < 0` | share or other | M8 (the line enters own mode) |
| reservation | > 0 | price_correction with `amount < 0` | supplier `f` | M9 (`f`'s own reduction as a `fault` debt; own mode) |
| reservation | > 0 | re_rate with `amount > 0` | — | M6 (M7 in own mode) |
| reservation | > 0 | re_rate with `amount < 0` | share (C06-M8) | M8 |
| usage | > 0 | late_traffic, quarantine_attribution, corrected_record (`amount > 0`); price_correction or superseding_record with `amount > 0`; re_rate with `amount > 0` | any or absent | M6 (M7 in own mode) |
| usage | > 0 | price_correction, superseding_record or attribution_reversed with `amount < 0` | share or other | M8 (own mode) |
| usage | > 0 | price_correction or superseding_record with `amount < 0` | supplier `f` | M9 (own mode) |
| usage | > 0 | re_rate with `amount < 0` | share (C06-M8) | M8 |
| carried_excess, dearer_path | > 0 | any reason above valid for the trigger | as given | M23 (a nil line when no party moves) |

  Every other combination is **invalid** (F16). This includes:
  - an unknown value of an enum;
  - a reservation amendment with another reason, or an upward `price_correction` of a
    reservation line;
  - a `late_pol07_cut` that has a cause or has `amount ≥ 0`;
  - a downward amendment of a non-cost line with no cause (other than `late_pol07_cut`);
  - a fee kind with no `payee`, or with `seq > 0`;
  - two sequences of one line key in one usage batch.

  In a **usage batch**, settlement posts nothing (D1, F01). It acknowledges the invalid line
  `movement_refused`/`invalid` and every other line `batch_refused`, and alerts. In a
  reservation batch only the invalid line is excluded. Settlement never guesses a posting
  rule.
- **Affected marks** (`AffectedMark`) are annotations for SLA credit: they have no amount,
  are never posted, are not lines, and count toward neither the limit nor `whole`.
  Settlement skips them; reporting consumes them.

### Posting acknowledgement

- **Producer.** The ledger publishes the acknowledgement for **every line** of a committed
  movement from its outbox: `posted` with the ledger position. A `duplicate: true` line
  carries the position of the original movement. Settlement publishes, directly, the
  acknowledgements of `refused`, `refused_batch` and its own mapping exclusions (F12).
- **Posted.** Rating marks a line posted **only** on `posted`, recording `postedTotal` and
  `position` in its `posted` entry, which `P_X` reads.
- **Refused usage batch (D1).** A usage batch refused whole is acknowledged line by line.
  Each offending line carries its own reason: `content_conflict`, `prior_total_mismatch`,
  `out_of_sequence`, or `movement_refused` with refusal `invalid`. Every other line is
  `batch_refused`. Rating handles the offending lines as below and re-emits the
  `batch_refused` lines in a new usage batch, under a new `BatchId` named in a new figure
  before emission. Lines parked under the rules below are left out of that batch.
- **`content_conflict` or `prior_total_mismatch`** on a non-fee line. Rating re-bases the
  line's `E` on `ledgerPostedTotal` and its next amendment sequence on `ledgerLastSeq + 1`,
  and places that posting at `ledgerPosition` for `P_X`. The next amendment restates the
  ledger to `C`. It carries the **reason and cause of the trigger** that produced the
  offending line (F14); only a cold re-rate's residual uses `re_rate`.
- **`out_of_sequence`** is a defect under D2. Rating alerts and re-emits the line after its
  predecessor's `posted` acknowledgement, without re-basing.
- **`batch_over_limit`.** Rating re-composes the lines into batches within the limit.
- **Parked lines (C06-M11, F02, F15).** Three cases park a line:
  - a line acknowledged `movement_refused`;
  - a fee or Share-borne fee line acknowledged `content_conflict` (fees are never amended,
    so they are never re-based);
  - **every later sequence of a parked line**, which is parked with it.

  A parked line stays unposted and counted in `U`. It is **alerted at once** and **appears
  in daily reconciliation (RFC-004 §B6) as unresolved** until an operator resolves it (for a
  fee, by an M22 through the escalation's owner). Rating never re-emits it automatically and
  never lets it make another batch fail.

### Ledger posting port

- **Commit.** `post` appends one movement, in one database transaction, in the home
  partition of `movementRef`, conditional on the owner's epoch. The answer is given only once
  the movement is committed in two regions.
- **Principal (F18).** The principal is the caller's authenticated mTLS or workload identity
  (RFC-005). Only settlement, payments, payouts, receivables and reconciliation may post,
  each only the kinds that §B2 allows it; any other caller or kind is refused `principal`.
- **Validation.** An invalid movement is refused, recorded, and moves nothing. The checks:
  - one currency;
  - every line sums to zero;
  - amounts are non-zero integers (only M23 may carry a nil line);
  - each ledger account's class is allowed for the kind;
  - the partition is the home of `movementRef` (`wrong_home`);
  - an M18 is not stale (`stale`);
  - no more than 5,000 lines (`over_limit`);
  - for a charge batch, `lines.length = batch.lineCount`.
- **Per-line checks on charge, amendment and cost lines (F03).**
  - `priorTotal` must equal the ledger's posted total for the line key, else
    `prior_total_mismatch`.
  - `amendmentSeq` must be one more than the last sequence posted, else `out_of_sequence`.
  - `weightsVersion` must be the one the line's original was posted with, else `invalid`.
  - The entries must equal the §B2 template for `priorTotal`, `newTotal`, the mode and the
    weights (for example M6: `split(newTotal) − split(priorTotal)`), else `invalid`.
- **Per-line outcomes.**
  - `posted`.
  - `duplicate`: the same canonical `SourceRef` with the **same content**. This is an
    idempotent repeat: nothing is posted again, and `of` names the first posting. Content is
    compared only on (`lineKind`, `amount`, `newTotal`, `priorTotal`, `payer`, `payee`,
    `route`, `weightsVersion`, `reason`, `cause`, `lateCut`), so `reasonDetails`,
    `priceCatalogue` and encoding differences never make a conflict (F17).
  - `conflict`: the same reference with different content, which raises an **integrity
    alert**.
- **Reservation batch.** A line with a problem is excluded on its own and the rest are
  posted.
- **Usage batch (D1).** Any line with a problem (`conflict`, `prior_total_mismatch`,
  `out_of_sequence`, `invalid`) **refuses the whole batch** (`refused_batch`), and nothing is
  posted. A committed usage-batch movement has `whole = true` by construction: the posted
  lines plus the duplicate lines equal `batch.lineCount`. The ledger refuses `invalid`
  otherwise, as a defence in depth (F01).
- **`unavailable`** (`not_owner`, `moving`, `stopped`, `overloaded`): nothing is appended.
  `not_owner` and `moving`: retry at once against the refreshed route. `overloaded`: retry
  with backoff. **`stopped`** (an integrity stop): alert, hold the batch, and retry no more
  often than every 30 s (est.), never in a tight loop (RFC-000 C4-7; F23).
- Posting time is the commit timestamp, monotone per partition across owner changes. No
  command alters or removes a movement (P4-S29).

### Ledger movement feed

- There is one `MovementPosted` per committed movement, in partition sequence order. The
  by-buyer view carries every movement homed at the buyer, whatever ledger accounts it
  touches; all of them are in the buyer's home partition, in the same order. The by-supplier
  and by-external views carry the movements that touch `S:<supplier>:*` or `X:*`.
- The account owner applies the by-buyer view as **F1**. From it, F1 takes:
  - the new `Bal` and `W`;
  - the posted-through minutes per reservation;
  - the per-line `amount` and `postedTotal`, which give `a_{r,k}(m)` for key spending (KP,
    POL-25), corrections included;
  - the fees posted;
  - for a usage batch, `batch.id`.

  This advances the owner's applied ledger position `P`, and so releases held F2 figures
  and invoice-status events.
- Rating's cold re-rate reads, per line, the postings, amendment sequences, posted totals and
  split modes. Reporting and statements show each line's postings with their reasons and,
  for each supplier, its share: `split(postedTotal)` in normal mode, and the explicit shares
  otherwise.

### Quarantine and breach reports

- There is one `QuarantineEntryReport` per quarantine entry and per state change, and one
  `QuarantineAggregate` per (link, minute) when it changes. Supplier-facing views, through
  the notifier and reporting, are filtered to the supplier's own links and carry no buyer
  data. Probe traffic never appears.
- Breach reports follow RFC-003 §5.9:
  - lateness beyond `max_lateness` (180 s) from the record's last minute end;
  - attribution lag beyond `attribution_lag_max` (10 s), except for parts reached through a
    finance attribution;
  - superseding versions that raise bytes;
  - per minute and serving region, whether every accepted record was counted in time.

  Probe records never appear.

### Evidence query

- It answers every accepted record whose active interval meets `[minuteFrom, minuteTo)` and
  whose key and observation point match the reservation's bindings or the link's observation
  points. Each record comes with its versions (accepted and refused) for the retention period
  (7 years). Non-conforming rejects are given by identity, keyed digest, key version and
  reason only.
- The reader verifies the read grant (RFC-005 `operator_check`) and appends its audit record
  before answering. Each read is recorded for its role (POL-32). Errors: `GRANT_INVALID`,
  `NOT_FOUND`, `UNAVAILABLE`. There is no latency target.

## Delivery and ordering

| Message | Delivery | Partition key | Ordering scope |
|---|---|---|---|
| `CatalogueEvent` | At least once (direct publish + relay) | Entity | Per entity by `entityVersion`; consistency across entities by `ResolvedMarker` |
| `UnpostedUsageFigure` | At least once | Account | Per account by `ratingPosition`; consumers apply the latest and drop older ones |
| `UsageApplied` | At least once | Account | Per account by `entry` (generation, seq), equivalently `streamSeq`; rating keeps the maximum `appliedThrough` (F24) |
| `ChargeLineBatch` | At least once until acknowledged | Account | Per account stream. Originals per reservation in increasing minute; at most one sequence per line per batch; `k + 1` only after `k` is `posted` (D2) |
| `AffectedMark` | At least once | Account | Unordered relative to batches; the latest per (reservation, minute, leg) wins |
| `PostingAck` | At least once. Committed answers come from the ledger outbox; refusals and exclusions are published directly by settlement before its offset commit | Account | Per account; idempotent per line |
| `post` (gRPC) | The caller retries until it gets `committed`, `refused` or `refused_batch`; `unavailable` is retried per its rule | Home partition of `movementRef` | Per partition; posting time monotone |
| `MovementPosted` | At least once, with **exactly-once effect** at each consumer by `EventId` | Ledger partition; views by buyer, supplier or external account | Per partition sequence; per key in each view |
| Quarantine, breach reports | At least once | Link; exporter or region | Per entry state; per key |

Settlement commits its Kafka offset only after each batch is answered and its
acknowledgements are published. The account owner records each applied feed position in its
entry, so a new owner resumes from it.

## Idempotency

| Message or operation | Key | Duplicate (same content) | Same key, different content |
|---|---|---|---|
| Any Kafka event | `EventId` (partition, stream, streamSeq) with (generation, epoch) | Dropped by the consumer | Impossible by construction (one writer per partition); a lower (generation, epoch) is ignored |
| `CatalogueEvent` | (entity, `entityVersion`) | No-op | Refused at the catalogue; never on the feed |
| `price_correction` command | `sourceRef` (7 years) | First result returned | Refused (AI4-1) |
| `UnpostedUsageFigure` | (account, `ratingPosition`) | No-op | Not possible; a later position supersedes |
| `UsageApplied` | `entry` (account partition, generation, epoch, seq): the F2 entry; ordered by (generation, seq). Used by rating and by C05's `usage_applied_since` | No-op; rating keeps the maximum `appliedThrough` | Not possible: one F2 entry has one content. A lower (generation, epoch) for the same partition is ignored |
| `ChargeLine` | Canonical `SourceRef` (line key, minute, amendment seq; fee by reservation or request, partner link and fee) | Ledger: idempotent repeat, dropped, acknowledged `posted` (`duplicate: true`); a usage batch stays `whole` | Ledger: `conflict` and integrity alert. Reservation batch: the line is excluded `content_conflict` and the rest posted. Usage batch: refused whole (`refused_batch`), nothing posted |
| `ChargeLineBatch` / movement | `BatchId` = `movementRef`. The ledger stores the movement's content digest with its answer, **including `refused_batch` and `over_limit` answers** (F11) | Ledger returns the recorded answer | `refused`/`invalid` and an integrity alert. A re-composed batch gets a new `BatchId`, and its lines dedup per line |
| `PostingAck` | (`batchId`, line `sourceRef`) | No-op at rating | `posted` is final; a later answer never undoes it |
| `post` | Per movement `movementRef` (with its content digest), per line `lineRef` | Recorded answer | Per line `conflict`; a usage batch is refused whole |
| `MovementPosted` | `EventId` | Dropped | — |
| Quarantine attribution and reversal | Operator `sourceRef` | First result | Refused |
| Evidence query | None (read-only) | Any number of retries | — |

## Ownership

| Data | Only writer | Readers |
|---|---|---|
| Catalogue entities other than those below | Catalogue partitions (RFC-003), on operator envelopes from the roles named under Semantics | All consumers above, by replica or follower read |
| `link`, `link_rules` | RFC-001's link-registry partition | As catalogue |
| `probe_designation` of accounts | RFC-006 placement, a projection of the account slot map (F10) | As catalogue (display); decisions use the slot map |
| Unposted-usage figures, charge lines, quarantine and breach reports | Rating and stage A (RFC-003) | As the topic table |
| Usage-applied acknowledgements | Account owner (RFC-002) | Rating |
| Posting acknowledgements | Ledger (committed answers, outbox); settlement (refusals and exclusions, direct) | Rating |
| Ledger movements | The ledger partition owner (RFC-004), on posts from settlement, payments, payouts, receivables and reconciliation only, authenticated by workload identity, each for the kinds §B2 allows | Movement-feed consumers. No role may update or delete a movement |
| Evidence | Ingestion's log, sealed by RFC-006 history | Operations, support, finance, with a read grant |

Kafka ACLs: each owner produces only to its own topics, or for its own entity types on
`catalogue.v1` (RFC-006 §5.2).

## Timeouts and deadlines

| Item | Bound | Source |
|---|---|---|
| Price version lead | ≥ 1 min before `effectiveFrom`; `usage_price` ≥ `price_notice` (30 days) | POL-27; RFC-003 §6.2 |
| Weights, cap and lateness-parameter lead | ≥ 1 min before `effectiveFrom`, never retroactive | D3, D4 |
| Catalogue freshness at the account owner | Applied `resolvedTs` within 60 s of the intake `ts`; alarm at 60 s | RFC-002 §3.2, RB-19; RFC-006 §16 |
| Unposted-usage publication | ≤ 1 figure per account per 2 s | RFC-003 §8 |
| Acceptance → counted (F2 `appliedTs`) | ≤ `attribution_lag_max` = 10 s (budget about 2.5 s, est.); later is a breach | POL-14; X2-S22 |
| F2 apply-lag alarm | Beyond `attribution_lag_max` | RFC-006 §16 |
| Lateness bound (exposure) | 430 s window; price, cap and window span `[now − 370 s, now + 60 s]`; computed by RFC-004 F3 only | RFC-004 §A3; RFC-003 §5.9; D3 |
| **Reservation lines posted (X2-S13)** | Within **120 s of the minute's end**. Closure is about 3 to 5 s after the end (est.). Posting takes about 0.2 s a movement, with up to 8 in flight, so even an account with 1 M reservations posts within about 10 s of closure (est.). That leaves about 100 s for a settlement takeover (about 5 s, est.) or a lost database node | X2-S13; RFC-003 §5.6, §5.8 |
| **Usage lines posted (X2-S13)** | Within **`max_lateness` + 120 s = 300 s of the minute's end** (F08). Typical close is at 60 (`flow_active_timeout`) + 180 (`max_lateness`) + 15 (`usage_close_margin`) = **255 s** after the end, leaving **45 s**. The hard close bound is 60 + 180 + 45 = **285 s**, leaving **15 s**. The 15 s are used as follows (est.): figure coalescing ≤ 2 s, Kafka to the owner 0.05 s, F2 entry ≤ 0.06 s, acknowledgement back 0.05 s, emission 0.06 s, settlement and `post` about 0.2 s. That is about 2.5 s, leaving about 12 s for **one** of: a relay hop (about 1 s), a settlement takeover (about 5 s), or one `refused_batch` re-emission (a new figure, about 2.5 s or more). Two of these together at the hard bound may exceed 300 s; such a minute counts against the 99.99% target and is reported | X2-S13; RFC-003 §5.6, §5.9 |
| `post` call | Per-call deadline 2 s (est.), retried with backoff until answered; `stopped` retried at most every 30 s (est.) | This contract |
| Topic retention | 3 days (charge lines), 7 days (others). A consumer further behind rebuilds from history | RFC-006 §5.2 |
| Evidence query | No latency target | RFC-003 §3.7 |

## Versioning and compatibility

- Each message type has a `schemaVersion`; the topic name carries the major version (`.v1`).
- **Compatible (minor) changes.** Adding an optional field. Adding a message type that
  consumers may skip, like `ResolvedMarker`. Consumers ignore unknown fields.
- **Incompatible (major) changes.** Removing or renaming a field. Changing a unit, a key, the
  partitioning, the canonical `SourceRef` encoding or the content-comparison field set.
  **Adding a value to any of these enums: `Reason`, `LineKind`, `Cause`, `MovementKind`, an
  exclusion reason.**
- **Money enums are closed.** When settlement meets an unknown value, it treats the line as
  invalid (D1: a usage batch is refused whole) and alerts; it never posts by guess.
- A major version is a new topic, dual-published until every consumer has moved.
- Schemas are registered in the schema registry with BACKWARD_TRANSITIVE compatibility per
  topic.
- A change in the meaning of any figure (for example, what `U(X)` counts) is a new contract
  version even if the schema does not change, and needs RFC-000 §8 to change first.

## Scenarios relied on

All at `requirements-v1.10`:
- P3-S10, P3-S12, P3-S13, P3-S15, P3-S17, P3-S26, P3-S27, P3-S32, P3-S35, P3-S37, P3-S39,
  P3-S41, P3-S56, P3-S58, P3-S59, P3-S61, P3-S62, P3-S64, P3-S65, P3-S66, P3-S69;
- P4-S15, P4-S16, P4-S29, P4-S38, P4-S39, P4-S57, P4-S72, P4-S110, P4-S115, P4-S116,
  P4-S117;
- X1-S31;
- X2-S13, X2-S22.

## Conformance tests

**Provider side: RFC-003 (rating, catalogue).**

| Test | Checks | Serves |
|---|---|---|
| CT-R1 Schema | Every emitted message validates against this schema; money and prices are integer strings; the canonical `SourceRef` encoding of fixed vectors matches | — |
| CT-R2 Lead times | None of these reach the feed: a `usage_price` with less lead than `price_notice`; any price, weight, cap or `policy_parameters` version with less than 1 min lead; a zero weight | P3-S69, P4-S38 |
| CT-R3 Batch limits | 5,001 reservation lines in a minute give two reservation batches with disjoint reservations; no usage batch exceeds 5,000 lines | X2-S13 |
| CT-R4 Publish before emit | With `UsageApplied` withheld, no gated usage batch is emitted while reservation batches flow. A redelivered older `UsageApplied` does not lower the gate | P3-S61 |
| CT-R5 Figure content | P3-S37: 0.2 GB at 10,000 micro-USD/GB gives `unpostedUsage` `"2000"`; there is no lateness-bound field | P3-S37 |
| CT-R6 Late POL-07 cut | After an extension chunk, a closed minute at 100 Mbps × 15 micro-USD (1,500) is cut to 60 Mbps. Rating emits `seq` 1, `amount "-600"`, `newTotal "900"`, `priorTotal "1500"`, reason `late_pol07_cut`, `lateCut` set, no `cause`, the original's `weightsVersion`. It travels in a usage batch, after seq 0 is acknowledged `posted` | P4-S117 |
| CT-R7 Re-base | A `content_conflict` acknowledgement with `ledgerPostedTotal` re-bases `E`. The restating amendment carries the offending trigger's reason and cause (a supplier-fault correction stays M9) | P3-S12, P3-S13 |
| CT-R8 Redelivery | Every batch redelivered three times with identical content | P3-S12, P4-S57 |
| CT-R9 Moves and cost lines | P4-S110: dearer path `"4"`, route = the path. P4-S115: buyer amendment `"-1"` with cause share, and no dearer-path amendment. P4-S116: the rows as cost-line amendments with their causes | P4-S110, P4-S115, P4-S116 |
| CT-R10 Sequencing and parking | A price correction and a late-traffic amendment due together on one usage line go into consecutive batches, never one batch. A line acknowledged `movement_refused` parks its later sequences, which stay counted in `U` and never make another batch fail | P3-S61, P4-S38 |
| CT-R11 Fee payee | Every fee and Share-borne fee line names its `payee`, has no route or weights, and is never amended | P4-S57 |

**Provider side: RFC-002 (account owner).**

| Test | Checks | Serves |
|---|---|---|
| CT-A1 Gate on X | A figure whose `X` is above the applied ledger position is held, then applied once F1 reaches it. Its `UsageApplied` carries the F2 commit `ts` and `entry` equal to that F2 entry's (account partition, generation, epoch, sequence) | P4-S16, P3-S61 |
| CT-A5 Entry identity | Across an owner takeover, `UsageApplied` events redelivered by both publish paths dedupe by `entry`; `entry` increases with (generation, seq); C05's `usage_applied_since` from a given `entry` returns exactly the later ones | P3-S61, X2-S22 |
| CT-A2 Δ_b | `U = U(X) − Δ_b` only once an applied F1 reports the named batch; until then `U(X)` | P4-S16 |
| CT-A3 Freshness | With the catalogue cache 61 s behind, intakes are not accepted and an alert is raised | — (RFC-002 RB-19) |
| CT-A4 Key spending from the feed | F1's KP per key and the balance reproduce exactly from the by-buyer feed's per-line `amount` and `postedTotal`, corrections included | P4-S72 |

**Provider side: RFC-004 (settlement, ledger).**

| Test | Checks | Serves |
|---|---|---|
| CT-L1 Mapping | Every row of the settlement mapping table posts the movement named; fee lines credit their `payee`. Every invalid combination in a usage batch refuses it whole (`movement_refused`/`invalid` plus `batch_refused`) and alerts | P4-S41, P4-S42, P4-S89 |
| CT-L2 Late POL-07 cut | P4-S117: weights 3000/3333/2167/1500, line 1,500 → 900. M6 posts `B +600`; A −180, B −200, C −130, commission −90; no `SH:corrections`, no `fault` | P4-S117 |
| CT-L3 Over limit | A 5,001-line usage batch posts nothing; every line is acknowledged `excluded` with `batch_over_limit`; the answer is recorded and returned on a repeat | X2-S13 |
| CT-L4 Whole | Four cases. (1) A usage batch with one line already posted with identical content commits with `whole = true` and that line dropped. (2) A line with the same id and different content refuses the batch whole, posts nothing, raises an integrity alert, and is acknowledged `content_conflict` with the rest `batch_refused`. (3) The same for an unmappable line. (4) A request whose `lines.length ≠ lineCount` is refused `invalid` | P4-S16, P4-S57 |
| CT-L5 Dedup | A re-posted batch returns the recorded answer. The same `movementRef` with a different digest is refused `invalid` with an integrity alert. A changed line in a reservation batch is a `conflict`, excluded, with `ledgerPostedTotal`, `ledgerLastSeq` and `ledgerPosition` in its acknowledgement. A `movement_refused` line is alerted at once and listed as unresolved in the next daily reconciliation | P4-S57, P4-S29 |
| CT-L6 Order and totals | An amendment whose predecessor is not posted is `out_of_sequence`. A wrong `priorTotal` is `prior_total_mismatch`. Entries that do not match the template for the stated totals are `invalid`. An amendment with a different `weightsVersion` from its original is `invalid`. In a usage batch, each of these refuses the batch whole | P4-S38, P4-S39 |
| CT-L7 Feed | Every committed movement appears once per `EventId`, with `batch`, per-line `amount` and `postedTotal`. The by-buyer view equals the full feed filtered by home = buyer, including cost-line-only batches. The supplier and external views equal their filters | P4-S72 |
| CT-L8 Principal | A post from a caller whose workload identity is not one of the five posting principals, or one posting a kind not allowed to it, is refused `principal` | P4-S29 |

**Consumer side** (each runs against recorded provider fixtures).

| Test | Side | Checks |
|---|---|---|
| CT-C1 | Settlement | Consumes the CT-R fixtures; the amounts posted equal the golden ledger |
| CT-C2 | Rating | Consumes the CT-L fixtures; marks a line posted only on `posted`; re-composes on `batch_over_limit`; re-emits `batch_refused` lines under a new `BatchId`; parks per the rules |
| CT-C3 | Account owner | Consumes the figure and movement fixtures in every interleaving; headroom equals the exact value at every applied pair |
| CT-C4 | Funds module F3 | From catalogue fixtures, for P3-S37, LB = 53,750 and exposure = 55,750. A price rise **effective** within the next 60 s raises LB at once. After a decrease the old price counts for 370 s more. A `usage_rate_cap` lowered from 100 to 50 Mbps keeps LB at 100 Mbps for 370 s after its `effectiveFrom`; a raise counts from 60 s before it |
| CT-C5 | All | Duplicate and reordered delivery of every topic gives identical state |
| CT-C6 | Rating, funds module, RFC-001, RFC-006 | A probe account is excluded because the slot map designates it. No console command can set or clear an account's designation on `catalogue.v1` |

## Settled

The orchestrator settled these points (binding). Draft 3 amends them per review 44 and its
decisions D1 … D4. The RFC changes they imply are under "Consumer obligations".

| # | Point | Settlement |
|---|---|---|
| C06-M1 | Usage-applied acknowledgement content | It carries `appliedTs`, the F2 entry's commit timestamp, and `entry`, the F2 entry's identity (account partition, generation, epoch, sequence; C05 v0.2), beside the rating position. Rating keeps the maximum `appliedThrough` (F24). This contract is the acknowledgement's canonical definition; C05 refers to it |
| C06-M2 | `excluded` posting acknowledgement content | `ledgerPostedTotal`, `ledgerLastSeq` and `ledgerPosition` (F19) on `content_conflict` and `prior_total_mismatch`. The exclusion reasons are a closed enum. The restating amendment carries the trigger's reason and cause (F14) |
| C06-M3 | Amendment amount | `amount`, `newTotal` and `priorTotal`, with `amount = newTotal − priorTotal`, on the charge-line feed **and on the posting port** (F03). The ledger checks `priorTotal` and the entries against the template |
| C06-M4 | Share-borne fee lines and fee lines | RFC-003's key: (reservation, fee ID) or (request, partner link, fee ID). The reason is a field, not part of the key. Fee kinds are never amended (`seq` 0), name their **`payee`**, and carry no route or weights (F04). A fee conflict is parked, never re-based (F15) |
| C06-M5 | Amendment order | Extended to **every** line (D2). A usage batch carries at most one sequence per line key, and `k + 1` is emitted only after `k` is acknowledged `posted`. The ledger answers `out_of_sequence` otherwise |
| C06-M6 | Affected marks | A separate `AffectedMark` message on the charge-line topic. It is never posted, is not a line, and counts toward neither the limit nor `whole` |
| C06-M7 | Lateness-bound parameters | A versioned `policy_parameters` catalogue entity, written by the policy's owning role, four-eyes, under an operator envelope (F07). It and `account_product_terms` take effect ≥ 60 s after they are recorded. F3 uses the maximum cap and the maximum window over the bound's span; the edge polices from `effectiveFrom` (D3) |
| C06-M8 | Downward re-rate amendment | Rating sets cause **share**, and settlement posts **M8**, so supplier earnings stay final (POL-23). An upward re-rate posts M6/M7. Only a cold re-rate's residual uses `re_rate` (F14) |
| C06-M9 | Late POL-07 cut on an own-mode line | M7 posts each party `−split(−Δ)` |
| C06-M10 | Feed event identity | The substrate's `EventId`: (partition, stream, stream sequence) with (generation, epoch) |
| C06-M11 | Lines that cannot be posted | A line refused `movement_refused`, a fee conflict, and every later sequence of such a line are **parked**. They stay unposted (counted in `U`), are **alerted at once**, and **appear in daily reconciliation as unresolved** until an operator resolves them. They are never re-emitted automatically and never make another batch fail (F02, F15) |
| C06-M12 | Usage-batch wholeness | **D1: any line of a usage batch that cannot be posted, for whatever reason, refuses the batch whole.** The reasons are a ledger conflict, `prior_total_mismatch`, `out_of_sequence`, settlement's mapping (`invalid`), or size. Only the offending lines carry their own reason; the rest are `batch_refused` and re-emitted under a new `BatchId`. A repeated line id with identical content is an idempotent repeat: dropped, and the batch stays whole. The same line id with different content refuses the batch and raises an **integrity alert**. `lineCount` lets the ledger check wholeness. Refusal answers are recorded (F11). A committed usage-batch movement is always `whole` |
| C06-M13 | Split weights timing | **D4**: at least 1 min lead, never retroactive, positive integers. An amendment carries its original's `weightsVersion`. A mistaken weight is fixed going forward only; its past effect is visible in the deviation report (RFC-004 §B3.5) and settled by an M22 if finance chooses (F06) |
| C06-M14 | Probe-account designation | Only placement's account slot map designates probe accounts (C01 S-M11). The catalogue carries a read-only projection that placement writes, for display; it never decides (F10, AI-44-1) |

## Consumer obligations

These are the errata each RFC must take to match this contract. The contract does not edit
the RFCs.

### RFC-002 (rev. 5)

- §13.1, usage-applied acknowledgement: add `appliedTs`, the F2 entry's commit timestamp,
  and `entry`, the F2 entry's identity (account partition, generation, epoch, sequence), and
  cite C06 as the canonical definition (M1; C05 v0.2).
- §13.2: apply F1 from the by-buyer view (every movement homed at the buyer), taking KP from
  the per-line `amount` and `postedTotal` (F05, F13).
- §13.2, catalogue: probe accounts from the slot map only; the catalogue designation is for
  display (F10).
- Feed identity as `EventId` (M10; already its convention).

### RFC-003 (rev. 5 + 5.1)

- **§7, charge-line row.**
  - Carry `newTotal` and `priorTotal` beside `amount` (M3), `lineCount` per batch (F01),
    `payee` on fee kinds, and no route or weights on fee kinds (F04).
  - Use this contract's `SourceRef` forms and canonical encoding (F17).
  - Affected marks travel as a separate `AffectedMark` message, not as annotations inside
    reservation batches (M6, F09).
  - Event identity per M10.
- **§5.8.**
  - Remove the sentence saying settlement may post a usage batch with an excluded line.
    Instead, a usage batch is posted whole or not at all (D1). On `refused_batch`, rating
    re-emits the `batch_refused` lines under a new `BatchId`, named in a new figure.
  - At most one sequence per line key per usage batch, and `k + 1` only after `k` is
    `posted`, for every line kind (M5, D2).
- **§5.9, last exactness bullet.** Replace "a batch posted with an excluded line is reported
  not whole" with: "a usage batch with a line that cannot be posted is refused whole and
  re-emitted, so every posted usage batch is whole" (M12, F09).
- **§5.7.**
  - Re-base on `ledgerPostedTotal`, `ledgerLastSeq` and `ledgerPosition` for
    `content_conflict` and `prior_total_mismatch` (M2, F19). The restating amendment carries
    the trigger's reason and cause (F14).
  - `out_of_sequence` re-emits without re-basing.
  - `movement_refused` lines, fee conflicts and their later sequences are parked: alerted,
    counted in `U`, never re-emitted automatically (M11, F02, F15).
- **§5.10.** A downward "re-rate" carries cause Share; only the residual uses "re-rate"
  (M8, F14).
- **§6.1, §6.2.**
  - `split_weights`: positive integers, ≥ 1 min lead, never retroactive (D4, F06).
  - `account_product_terms` gains `effectiveFrom` with ≥ 1 min lead (D3).
  - Add the `policy_parameters` entity, with its writers (four-eyes, owning role) and lead
    (M7, F07).
  - Account probe designations are placement's projection (F10).
  - State `oeEffective`'s role in F11 (F21).
- **§7, consumed.**
  - Rating keeps the maximum `appliedThrough` (F24).
  - On the runtime result `Moving`, retry. On `Stopped`, alert and hold, with no tight loop
    (C4-7, F23).

### RFC-004 (rev. 5 + 5.1)

- **§A4.**
  - F2: replace "a batch posted with an excluded line is not reduced" with "every posted
    usage batch is whole; `Δ_b` applies once F1 reports the batch" (M12, F09).
  - F1: take KP and posted charges from the per-line `amount` and `postedTotal` (F05).
- **§A3, F3, F7.** `LB = ceil(cap* × Λ* × hp*)`, with the maximum cap and window over the
  span (D3, F07).
- **§B1.2.** `whole` is always true for a committed usage-batch movement, kept as a check
  with `lineCount`; a duplicate with identical content is dropped and leaves it true (M12,
  F01).
- **§B1.4.** Content comparison is on the fields named here, with the canonical `SourceRef`
  encoding (F17). The movement's content digest is stored with its answer, including
  `refused_batch` and `over_limit` answers (F11).
- **§B2.**
  - M10 and M11 credit the line's `payee` (F04). M11's key has no reason, and M23 is not used
    for Share-borne fees (M4).
  - A downward re-rate is M8 (M8). M7 for a negative `Δ` is `−split(−Δ)` (M9).
  - Amendments carry the original's `weightsVersion` (D4).
- **§B3.1.**
  - The `whole` column reads "always (D1)", not "True unless a line is excluded".
  - "Restarts": a re-composed batch with a changed line is refused whole, not "neither
    refused".
  - Settlement's mapping exclusions refuse a usage batch whole (D1, F01).
  - The input contract adds `newTotal`, `priorTotal`, `payee` and `lineCount` (M3, F04).
  - Posting acknowledgements of committed movements come from the ledger's outbox;
    refusals and exclusions are published directly by settlement before its offset commit
    (F12).
- **§B3.5.** A mistaken weight's past effect is reported, and fixed by an M22 at finance's
  choice (D4).
- **§B6.** Parked lines are listed as unresolved in daily reconciliation until they are
  resolved, and are alerted at once (M11).
- **§B9.** Replace the posting row "Line excluded and reported; the rest of the movement
  posted" with: "reservation batch: line excluded, rest posted; usage batch: refused whole,
  integrity alert" (M12, F09). The `BatchId` row: same reference with a different digest is
  refused with an integrity alert (F11).
- **§B12.**
  - The `post` signature adds `priorTotal` and `newTotal` per line, `batch.lineCount`, the
    answers `refused_batch` and `unavailable(not_owner | moving | stopped | overloaded)`
    with their retry rules (C4-7, F23), and the principal from workload identity (F18).
  - The posting-acknowledgement exclusion enum, with `ledgerPostedTotal`, `ledgerLastSeq`
    and `ledgerPosition` (M2, F19).
  - The movement feed adds per-line `amount` and `postedTotal` (F05), the by-buyer view
    defined by home (F13), and the by-supplier and by-external views as this contract
    defines them (F20).
  - Event identity per M10.
- **Callers of the posting port** (settlement, payments, payouts, receivables,
  reconciliation): retry `not_owner` and `moving`; back off on `overloaded`; on `stopped`,
  alert and hold, retrying no more often than every 30 s (C4-7, F23).

### RFC-006 (rev. 6)

- Placement writes account `probe_designation` rows to `catalogue.v1` from the slot map, as
  a third writer kind with its own ACL (F10).
- The topic table gains the by-supplier and by-external views (F20).
- The posting-acknowledgement topic ACL admits the ledger and settlement (F12).

### Network operations (edge policing)

- Polices `usage_rate_cap` from the version's `effectiveFrom`, never before it (D3).

## Upstream issues

| ID | To | Issue | Proposed amendment |
|---|---|---|---|
| RQ-44-1 | Requirements, POL-14 | The policy does not say which `usage_rate_cap`, or which window, applies across a change of the cap or of `max_lateness`, `attribution_lag_max` or `flow_active_timeout` | "**Which cap and window.** The highest `usage_rate_cap`, and the longest window, in force at any time in the bound's span. A cap change takes effect on a minute boundary at least the enforcement target after it is recorded." This contract applies it meanwhile (D3) |
| AI-44-1 | RFC-000 §8, "Probe designation and exclusion" and "Account slot map" | Probe accounts have two sources | "Probe **accounts** are designated only by placement's account slot map; the catalogue carries them as a read-only projection written by placement; probe links, suppliers and exporters stay catalogue facts set as RFC-006 states." This contract applies it (F10) |
| AI-44-2 | RFC-000 §8, Ledger posting port and Ledger movement feed rows | The consumer list lacks receivables (M18, M19) and reconciliation (M21). The rule "each line balanced and deduplicated on its own" omits whole-batch refusal | Add receivables and reconciliation. Add "a usage batch is posted whole or not at all (C06-M12)". In the movement-feed row, note that `whole` is always true for a committed usage-batch movement and is kept as a check |

Of RFC-000 revision 4.4's points C4-1 … C4-7, only C4-7 concerns C06: the runtime results
`Stopped` and `Moving`. This contract takes them as RFC-006's, surfaces them as `unavailable`
on the posting port with the retry rules above, and lists the handling in the RFC-003 and
RFC-004 errata.

## Review 44 resolution

| Finding | Severity | Resolution in draft 3 |
|---|---|---|
| F01 | Major | D1. Settlement's mapping exclusions refuse a usage batch whole (`movement_refused`/`invalid` plus `batch_refused`). Added `lineCount` on the batch and on the port; the ledger refuses `invalid` unless posted plus duplicate lines equal it. CT-L4 rows (3), (4) and CT-L1 added |
| F02 | Major | D2. At most one sequence per line key per usage batch; `k + 1` only after `k` is `posted`, for every line kind. Dependants of a parked line are parked with it. Added CT-R10 |
| F03 | Major | `priorTotal` and `newTotal` on every charge, amendment and cost line of `PostMovementRequest`. The ledger checks `prior_total_mismatch` and the template (`invalid`). Added CT-L6 |
| F04 | Major | `payee { supplier, partnerLink }` required on fee kinds; `route` and `weightsVersion` absent for them. Added CT-L1 and CT-R11 |
| F05 | Major | `MovementPosted` lines carry `amount`, `postedTotal`, reason, cause and payee. Normal-mode shares are `split(postedTotal)`. Added CT-A4 and CT-L7 |
| F06 | Major | D4. Weights take ≥ 1 min lead, are never retroactive and are positive; amendments carry the original's `weightsVersion`, and the ledger refuses a mismatch. Added CT-R2 and CT-L6 |
| F07 | Major | D3. `account_product_terms` and `policy_parameters` have `effectiveFrom` with ≥ 60 s lead. F3 uses the maximum cap and window over the span; the edge polices from `effectiveFrom`. `policy_parameters` writers are named: the owning role, four-eyes, under an operator envelope. RQ-44-1 raised. Added a CT-C4 row |
| F08 | Major | The posting bound is restated from the minute's end per X2-S13 (reservation 120 s, usage 300 s), with the 255 s / 285 s arithmetic and the itemised 15 s |
| F09 | Major | Errata completed for RFC-002, RFC-003, RFC-004 (including §5.8, §5.9, §7, §A4 F2, §B3.1, §B9, §B12, and C4-7 `unavailable`), RFC-006 and network operations |
| F10 | Major | Account probe designations come only from placement's slot map (C01 S-M11). The catalogue carries a read-only projection written by placement, for display only. AI-44-1 raised. Added CT-C6 |
| F11 | Minor | The ledger stores the movement's content digest with its answer; `refused_batch` and `over_limit` answers are recorded; the same `movementRef` with a different digest is refused with an integrity alert |
| F12 | Minor | Posting-acknowledgement producers are named: the ledger outbox for committed movements, settlement's direct publish for refusals and exclusions; the ACL is restricted |
| F13 | Minor | The by-buyer view is every movement homed at the buyer; CT-L7 uses that filter |
| F14 | Minor | The restating amendment carries the offending trigger's reason and cause; `re_rate` is only for a cold re-rate's residual |
| F15 | Minor | A fee conflict is parked (alerted, in reconciliation, resolved by an M22), never re-based |
| F16 | Minor | Reservation amendments are restricted to `price_correction` < 0, `late_pol07_cut` and `re_rate`; everything else is invalid |
| F17 | Minor | Content-comparison fields are named; the canonical `SourceRef` encoding is defined |
| F18 | Minor | The principal comes from workload identity, not the body. Added CT-L8 |
| F19 | Minor | `ledgerPosition` added to excluded acknowledgements |
| F20 | Minor | By-supplier and by-external views added |
| F21 | Minor | `oeEffective` explained; the `link_rules` entity (RFC-001 registry) added |
| F22 | Minor | CT-C4 reads "effective within the next 60 s"; CT-R6 cites P4-S117 only |
| F23 | Minor | `unavailable` retry rules (`stopped`: alert and hold, no tight loop) added, with errata for RFC-003 and RFC-004 |
| F24 | Minor | Rating keeps the maximum `appliedThrough` |
| F25 | Minor | AI-44-2 raised |
| C05 v0.2 | Binding addition | `UsageApplied` gains `entry` (F2 entry identity) for dedup and ordering by rating and C05's `usage_applied_since`; idempotency table and CT-A5 updated |
