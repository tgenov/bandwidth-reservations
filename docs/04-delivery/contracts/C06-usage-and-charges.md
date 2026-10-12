# C06. Usage and charges

| | |
|---|---|
| Contract ID | **C06** |
| Name | Usage and charges: catalogue, unposted usage, usage-applied acknowledgement, charge lines, postings, ledger movements, metering reports, evidence |
| Version | 1 (draft 4). Draft 4 applies review 55 (M1 … M9, m1 … m17, decisions D5 … D7). Draft 3 applied review 44 (F01 … F25, D1 … D4) and C05 v0.2. Draft 2 settled C06-M1 … C06-M12 |
| Status | **Draft, for contract review.** There is no open mismatch. The orchestrator settled C06-M1 … C06-M14 and adopted reviews 44 and 55; these decisions are binding. "Consumer obligations" lists the RFC errata that follow from them. "Upstream issues" lists the issues that this contract raises. See "Settled", "Review 44 resolution" and "Review 55 resolution" at the end |
| Provider | **RFC-003** (rating and metering) provides the Catalogue, the Unposted-usage feed, the Charge-line feed, the affected-mark feed, the Quarantine and Breach report feeds, the Evidence query, and the `resolve_parked` command. **RFC-004** (ledger and settlement) provides the Posting acknowledgement, the Ledger posting port and the Ledger movement feed. **RFC-002** (the account owner) provides the Usage-applied acknowledgement; RFC-004 §A4 F2 gives its semantics. C06 is the **canonical definition** of the usage-applied acknowledgement. C05 v1 refers to it, and C06 uses C05 v1's `LogPosition`, dedup key and recovery key without change |
| Consumers | **Catalogue**: RFC-002, the account owner (locked prices, partner terms, price notices). RFC-004: settlement (weights) and the funds module (F3, F11). Network operations: edge policing of `usage_rate_cap`. **Unposted usage**: RFC-002, which applies it as F2. RFC-004 gives the semantics. **Usage-applied acknowledgement**: RFC-003. **Charge lines**: RFC-004 settlement. **Affected marks**: reporting. **Posting acknowledgement**: RFC-003. **Ledger posting port**: settlement, payments, payouts, receivables and reconciliation, all in RFC-004 (AI-44-2). **Ledger movement feed**: RFC-002, the account owner (F1). RFC-003, the cold re-rate. RFC-004 receivables, payouts, settlement's supplier partition and reconciliation. Reporting. RFC-006 history and audit. **Quarantine and breach reports**: the operator console, the notifier, reporting and RFC-006 alerting. **Evidence query**: operations, support and finance. **`resolve_parked`**: the operator console (finance) |
| Not in C06 | **Link rows** stay on RFC-001's link-registry feed (RFC-001 §10). C03 consumes that feed by `(link_id, version)`. **Probe accounts** come from placement's account slot map (C01, settled M11). **Link validity rules** are AI-55-1 |
| Transport | **Kafka events.** The producer's transactional outbox publishes each event. The changefeed relay is the second path (RFC-000 §5.5). There is one exception: settlement publishes refusals and its own exclusions directly on the posting-acknowledgement topic. **Synchronous gRPC** carries the catalogue query, the ledger posting port (a command to the owner of the ledger partition), the evidence query (served by RFC-006 history) and `resolve_parked` (to rating) |
| Pinned to | `requirements-v1.10`. RFC-000 revision 4.4 §8 rows: Catalogue, Unposted-usage feed, Usage-applied acknowledgement, Charge-line feed, Posting acknowledgement, Quarantine report feed and breach report feed, Evidence query, Ledger posting port, Ledger movement feed, Account slot map, Probe designation and exclusion, and the substrate conventions. RFC-002 revision 5 (§3.2, §2.5, §13.1, §13.2). RFC-003 revision 5 with erratum 5.1 (§2, §5.2 … §5.10, §6, §7, §8). RFC-004 revision 5 with erratum 5.1 (§A3, §A4, §B1 … §B3, §B6, §B9, §B10, §B12). Contract C05 v1 (frozen; `LogPosition`, `usage_applied_since`). Reviews [44](../../reviews/44-contract-C06-review.md) and [55](../../reviews/55-contract-C06-review.md) |

## Purpose

C06 is the money seam between three owners:
- metering and rating (RFC-003);
- the account owner's funds module (RFC-002 with RFC-004 Part A);
- settlement and the ledger (RFC-004 Part B).

It carries four things:

1. **Reference data.** All sides use the catalogue to price, split and bound exposure. It
   holds:
   - products, and routes with split weights;
   - price and weight versions, published at least 1 min before they take effect;
   - price corrections and partner terms;
   - account-product terms and policy parameters, which take effect at least 1 min after
     they are recorded.
2. **The exposure loop.**
   - Rating publishes the unposted-usage figure `U(X)`, with the in-flight usage batch `b`
     and its reduction `Δ_b`.
   - The account owner applies a figure only when its ledger position reaches `X`.
   - The account owner's usage-applied acknowledgement then opens rating's
     publish-before-emit gate.
3. **The charging loop.**
   - Charge lines and cost lines move in two batch streams: reservation and usage.
   - Settlement posts them as ledger movements. The ledger posts a usage batch **whole or
     not at all**.
   - Per-line posting acknowledgements go back to rating.
   - The ledger movement feed tells the account owner which usage batch each movement
     posted.
4. **The operational outputs of metering**: quarantine and breach reports, and the evidence
   query.

The design needs exact headroom at each pair that the account owner applies (RFC-003 §5.9).
This contract sets the fields and rules that make this true.

## Conventions

| Quantity | Representation |
|---|---|
| Money | Integer **micro-USD** (10⁻⁶ USD), type `MicroUsd`. JSON: a signed decimal integer **string** (`"-600"`). TypeScript: `bigint`. SQL: `INT8` or `DECIMAL(…, 0)`. Never a float |
| Prices | Integer **pico-USD** (10⁻¹² USD) per unit, type `PicoUsd` (decimal string). The unit is the **Mbps-minute** for `reservation_price` and the **GB (10⁹ bytes)** for `usage_price` (RFC-003 §2). Example: 1.5 micro-USD per Mbps-minute is `"1500000"` |
| Rates | Integer **Mbps** (10⁶ bit/s) |
| Volumes | Integer **bytes**. A usage line's exact bytes are a rational number (RFC-003 §2, ELA). That number does not cross this contract |
| Minutes | UTC minute start, ISO 8601 with a `Z` and zero seconds, type `Minute` (`"2026-10-12T10:05:00Z"`). Minute `m` is `[m, m + 60 s)` |
| Database timestamps | The database commit or resolved timestamp (HLC), type `DbTs`: a decimal string `"<wall-ns>.<logical>"`, compared as a number. Positions, posting times and closure use commit timestamps only |
| Durations | Milliseconds, unless the name ends in `S` (seconds) |
| Identifiers | Pseudonymous opaque strings (RFC-000 A11): `AccountId`, `ReservationId`, `RequestId`, `ProductId`, `RouteId`, `LinkId`, `SupplierId`, `ExporterId`, `FeeId`, `ReductionId`. No field contains personal data (X1-N11) |
| Event identity | `EventId = { partition, stream, streamSeq, generation, epoch }`. This is the substrate's per-stream contiguous sequence, with the writer's generation and epoch (RFC-000 §8 substrate conventions, AI-17-2, AI-R6-3; C06-M10). The owner's direct publish and the changefeed relay give the same `EventId` |
| Account-log position | C05 v1's `LogPosition { partition: AccountId; sequence: bigint }`, imported unchanged. In JSON, `sequence` is a decimal string |
| Canonical `SourceRef` encoding | Use this encoding when you digest or compare a `SourceRef` (the ledger keeps dedup for 7 years). Put the `kind` tag first, then the fields in schema order. Write integers and sequences as decimal strings with no leading zeros. Write minutes in `Minute` form. Write identifiers as UTF-8. Put a length prefix (u32, big-endian) before each field. Hash the result with SHA-256 |
| Encryption | The producer encrypts each message body with its feed key (RFC-005 column encryption, AI5-3). Only the Kafka key, the `EventId` and the resolved markers are in clear text. The schemas below show the decrypted logical form |
| Encoding | JSON (UTF-8) in the encrypted body. Each message has `type` and `schemaVersion` |

### Topics

This contract gives the topic names. Retention is as RFC-006 §5.2 gives it.

| Topic | Producer (only writer, ACL) | Key | Retention | Resolved markers | Consumers |
|---|---|---|---|---|---|
| `catalogue.v1` | The RFC-003 catalogue **only** (D7). Commands from the console and deployments write it. No other principal can produce to it | Entity (`<entityType>:<entityId>`) | 7 days | Yes | All catalogue consumers. Each consumer keeps a full replica |
| `rating.unposted-usage.v1` | Rating (RFC-003) | `AccountId` | 7 days | Yes | Account owner (RFC-002) |
| `account.usage-applied.v1` | Account owner (RFC-002) | `AccountId` | ≥ 7 days (C05 v1) | Yes | Rating (RFC-003) |
| `rating.charge-lines.v1` | Rating (RFC-003) | `AccountId`: the buyer, or for a cost line the causing buyer | 3 days | Yes | Settlement (RFC-004) |
| `rating.affected-marks.v1` | Rating (RFC-003) | `AccountId` | 7 days | Yes | Reporting |
| `settlement.posting-acks.v1` | Two producers, each for its own answers. The **ledger** publishes the acknowledgements of committed movements; it writes them as the posting-answer row in the outbox of the posting transaction (RFC-004 §B1.3). **Settlement** publishes refusals of usage batches and its own line exclusions directly. It publishes them at least once before it commits its Kafka offset. ACL: these two principals only | `AccountId` | 7 days | **No** (m10): the topic has direct publishes, so the closure emitter cannot vouch for it | Rating (RFC-003) |
| `ledger.movements.v1` | Ledger (RFC-004) | Ledger partition | 7 days | Yes | Reporting, reconciliation, RFC-006 history and audit, the cold re-rate of rating |
| `ledger.movements.by-buyer.v1` | Ledger. Filtered view: **all movements whose home is the buyer**, whatever ledger accounts they touch. This includes usage batches that hold only cost lines or Share-borne fees | `AccountId` | 7 days | Yes | Account owner (F1), receivables |
| `ledger.movements.by-supplier.v1` | Ledger. Filtered view: all movements that touch `S:<supplier>:*` | `SupplierId` | 7 days | Yes | Payouts, settlement's supplier partition (deviation report) |
| `ledger.movements.by-external.v1` | Ledger. Filtered view: all movements that touch `X:*` (M1, M2, M3, M14 … M17, M20, M21, M22) | External account | 7 days | Yes | Reconciliation |
| `rating.quarantine-report.v1` | Attribution stage A (RFC-003) | `LinkId` | 7 days | Yes | Operator console, notifier, reporting, RFC-006 alerting |
| `rating.breach-report.v1` | Rating and stage A (RFC-003) | `ExporterId` (coverage rows: the serving region) | 7 days | Yes | Operator console, notifier, reporting, RFC-006 alerting |

RFC-006's closure emitter writes a **resolved marker** (`ResolvedMarker`, below) for each
destination partition, on each topic that the table marks "Yes". Each such topic has one
relayed owner kind (AI-55-2). The value of a marker is the minimum over all changefeed
partitions that can feed that destination. The emitter publishes a marker only after it
has published all rows from those partitions (RFC-000 §8, AI-27-3, AI6-11).

A filtered view keeps the order of the full feed for each key. A movement can be in a view
under two keys (for example, two suppliers). Each view copy has the same `EventId`, so a
consumer of a view must dedup by **(view key, `EventId`)** (m11).

## Schema

### 1. Common types

```ts
type MicroUsd = string;   // signed decimal integer, micro-USD
type PicoUsd  = string;   // non-negative decimal integer, pico-USD per unit
type DbTs     = string;   // HLC "<wall-ns>.<logical>"
type Minute   = string;   // "YYYY-MM-DDTHH:MM:00Z"
type Seq      = string;   // non-negative decimal integer (bigint)

interface EventId { partition: string; stream: string; streamSeq: Seq; generation: number; epoch: number }

import type { LogPosition } from './C05-funds-and-standing';   // { partition: AccountId; sequence: bigint }

interface ResolvedMarker {          // only on topics marked "Yes" in the topic table
  type: "ResolvedMarker"; schemaVersion: 1;
  destinationPartition: number;     // the Kafka partition that it closes
  resolvedTs: DbTs;                 // no row committed at or below this time follows on this partition
}

interface LedgerPosition {          // C05 v1's field names: a position in the log of one ledger partition
  ledgerPartition: string;          // ledger partition (1 … 128, plus Share sub-partitions)
  sequence: Seq;                    // partition log sequence; "0" = nothing posted yet
  commitTs: DbTs;                   // commit timestamp of the movement at sequence
}

interface RatingPosition {          // monotone for each account, ordered by (generation, seq)
  ratingPartition: string;
  generation: number;
  seq: Seq;                         // rating_log sequence of the entry that made the figure
}

interface CataloguePosition { resolvedTs: DbTs }   // the feed resolved timestamp that the consumer had applied

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
  | { entityType: "route"; routeId: RouteId; legs: LinkId[] /* ordered; ids from RFC-001's registry */; equivalentPathOf?: RouteId }
  | { entityType: "price_version"; product: ProductId; route: RouteId;
      priceKind: "reservation_price" | "usage_price";
      priceVersion: string;
      price: PicoUsd;                // per Mbps-minute | per GB
      effectiveFrom: Minute;         // ≥ ceil_min(announcedAt + 60 s); usage_price: ≥ ceil_min(announcedAt + price_notice)
                                     // at most one version for each (product, route, priceKind, effectiveFrom) (m8)
      announcedAt: DbTs;             // commit timestamp of the entry that records it
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
      recordedAt: DbTs }             // before the first version: the POL-14 default, 100 Mbps (m7)
  | { entityType: "policy_parameters"; policyVersion: string;    // entity id (m8)
      effectiveFrom: Minute;         // ≥ ceil_min(recordedAt + 60 s) (D3)
      recordedAt: DbTs;
      deployment: string;            // the configuration release that wrote it (D6)
      maxLatenessS: number; flowActiveTimeoutS: number; attributionLagMaxS: number;
      priceNoticeS: number; disputeWindowS: number }
  | { entityType: "probe_designation";
      subject: { supplier: SupplierId } | { link: LinkId } | { exporter: ExporterId };  // no accounts (D7)
      probe: boolean };

interface CatalogueEvent {
  type: "CatalogueEvent"; schemaVersion: 1;
  eventId: EventId;
  entityVersion: Seq;                // order for each entity
  committedAt: DbTs;                 // knowledge time (bitemporal)
  principal: string;                 // pseudonymous requester, or the deployment identity for policy_parameters
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
  ledgerPositionX: LedgerPosition;    // the home ledger partition of the buyer; U(X) is computed against it
  inFlightUsageBatch?: BatchId;       // present iff a gated usage batch is emitted or will be emitted next
  products: Array<{
    product: ProductId;               // attachment set ∪ each product with a usage line not fully posted
    unpostedUsage: MicroUsd;          // U(X) ≥ 0
    usageReduction?: MicroUsd;        // Δ_b for this product, ≥ 0; present iff inFlightUsageBatch
  }>;
  accruedReservationUnposted?: MicroUsd;  // for information only (P4-S16); not in the headroom formula
  publishedAt: DbTs;
}
```

There is no field for the lateness bound. Only RFC-004's F3 calculates the bound, from the
catalogue (RFC-003 §5.9, RFC-004 §A3). At the defaults the window is 430 s and the price span
is `[now − 370 s, now + 60 s]`.

### 4. Usage-applied acknowledgement (canonical here; C05 v1 refers to it)

```ts
interface UsageApplied {
  type: "UsageApplied"; schemaVersion: 1;
  eventId: EventId;                    // the usage-applied stream of the account owner
  account: AccountId;
  appliedThrough: RatingPosition;      // rating position of the figure that the F2 entry applied
  appliedTs: DbTs;                     // commit timestamp of that F2 entry (C06-M1)
  entry: LogPosition;                  // the F2 entry: C05 v1's LogPosition { partition: AccountId; sequence } (M9)
  inFlightUsageBatch?: BatchId;        // as the applied figure names it
}
```

Rating dedups by **(account, `appliedThrough`)**, as C05 v1 states. Rating finds gaps by
`eventId.streamSeq`. For a gap past the topic retention, rating calls C05 v1's
`usage_applied_since(accountPartition, afterStreamSeq)`. The key `afterStreamSeq` is the last
`eventId.streamSeq` that rating applied. The call returns these `UsageApplied` events with
the same content.

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
  account: AccountId;                 // the buyer; for cost lines, the causing buyer
  reservation?: ReservationId;
  product?: ProductId;
  route?: RouteId;                    // necessary except for fee kinds; after a move, the catalogue route of the path
  weightsVersion?: string;            // necessary except for fee kinds; an amendment has the version that its original was posted with (D4)
  payee?: { supplier: SupplierId; partnerLink: LinkId };   // necessary iff lineKind ∈ {fee, share_borne_fee}
  minute?: Minute;                    // absent only for fee kinds
  payer: "account" | "share";         // share for cost lines and Share-borne fees
  amount: MicroUsd;                   // signed. Original: the charge, ≥ 0. Amendment: C − E
  newTotal: MicroUsd;                 // C (C06-M3)
  priorTotal: MicroUsd;               // E before this line; "0" for an original
  reason: Reason;                     // "original" for each seq 0 line, late originals included (m5)
  reasonDetails?: Record<string, string>;  // record identities, correction id, operator, references; not compared
  cause?: Cause;                      // only where RFC-003 §5.7 gives one; never for late_pol07_cut
  triggerRef?: string;                // the correction, attribution, reversal or superseded record that caused the line,
                                      // late originals included (m5)
  lateCut?: { link: LinkId; reduction: ReductionId; extensionChunk: number };  // iff reason = late_pol07_cut
  priceCatalogue: CataloguePosition;  // catalogue position of the prices and weights used; not compared
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
    gated: boolean;                   // usage batch that holds ≥ 1 usage line
    lineCount: number;                // = lines.length
  };
  lines: ChargeLine[];                // 1 … 5,000 (the movement limit L); at most one sequence for each line key (D2)
  emittedAt: DbTs;
}
```

### 6. Affected-mark feed

```ts
interface AffectedMark {               // C06-M6: an annotation; nobody posts it
  type: "AffectedMark"; schemaVersion: 1;
  eventId: EventId;
  account: AccountId; reservation: ReservationId; minute: Minute;
  leg?: LinkId; partnerLeg?: boolean; affected: boolean;
  source: "link_schedule" | "partner_leg";
}
```

### 7. Posting acknowledgement

```ts
type LineAck =
  | { sourceRef: SourceRef; outcome: "posted";
      duplicate: boolean;              // true: an idempotent repeat of a line that was posted before with the same content
      position: LedgerPosition; movementId: string;
      postedAmount: MicroUsd; postedTotal: MicroUsd }
  | { sourceRef: SourceRef; outcome: "excluded";
      reason: "content_conflict" | "prior_total_mismatch" | "out_of_sequence"
            | "invalid"                  // the line breaks a line-level rule: mapping, weights or template (D5)
            | "batch_refused"            // a usage batch is refused whole because another of its lines cannot be posted (D1)
            | "batch_over_limit";
      conflictOf?: string;             // id of the movement that holds the reference
      ledgerPostedTotal?: MicroUsd;    // content_conflict, prior_total_mismatch (C06-M2)
      ledgerLastSeq?: number;          // content_conflict, prior_total_mismatch (C06-M2)
      ledgerPosition?: LedgerPosition }; // position of the last posting of the line

interface PostingAck {
  type: "PostingAck"; schemaVersion: 1;
  eventId: EventId;
  account: AccountId;
  batchId: BatchId;
  lines: LineAck[];                    // the lines of a batch are answered in one or more PostingAck messages;
                                       // together they answer each line exactly once (m1)
}
```

### 8. Ledger posting port (gRPC, to the owner of the home partition)

```ts
type MovementKind = "M1"|"M2"|"M3"|"M4"|"M5"|"M6"|"M7"|"M8"|"M9"|"M10"|"M11"|"M12"
                  | "M13"|"M14"|"M15"|"M16"|"M17"|"M18"|"M19"|"M20"|"M21"|"M22"|"M23";

interface PostMovementRequest {
  movementRef: string;                 // source reference of the movement (BatchId for charge batches)
  // principal: the ledger takes it from the mTLS or workload identity of the caller (RFC-005), never from the body
  operatorEnvelope?: unknown;          // a relayed operator action (RFC-005), M21/M22
  cause: string;                       // the causing fact
  currency: "USD";
  batch?: { id: BatchId; kind: "reservation" | "usage";
            lineCount: number };       // the number of lines that settlement sends in this request (M3)
  conditionalOn?: LedgerPosition;      // M18 only: no movement touched B since
  lines: Array<{
    kind: MovementKind;                // a usage batch has mixed kinds
    lineRef?: SourceRef | string;      // charge, amendment, fee and cost lines: their SourceRef
    // charge, amendment, fee and cost lines (M1, review 55):
    lineKind?: LineKind;
    payer?: "account" | "share";
    payee?: { supplier: SupplierId; partnerLink: LinkId };
    reason?: Reason;
    cause?: Cause;
    lateCut?: { link: LinkId; reduction: ReductionId; extensionChunk: number };
    triggerRef?: string;
    amendmentSeq?: number;
    priorTotal?: MicroUsd;             // "0" for an original
    newTotal?: MicroUsd;
    split?: { route: RouteId; weightsVersion: string; mode: "normal" | "own";
              explicitShares?: Array<{ party: string; amount: MicroUsd }> };
    entries: Array<{ ledgerAccount: string /* "B:<acct>", "S:<sup>:earn" … */; amount: MicroUsd /* ≠ 0 */ }>;
                                       // the sum is zero; empty only for an M23 nil line
  }>;                                  // ≤ 5,000
}

type LineProblem = "conflict" | "prior_total_mismatch" | "out_of_sequence" | "invalid";

type PostMovementResponse =
  | { result: "committed"; movementId: string; postingTime: DbTs; position: LedgerPosition;
      lines: Array<{ lineRef?: SourceRef | string; outcome: "posted" | "duplicate" | "excluded";
                     problem?: LineProblem;              // iff excluded; reservation batches only (m2)
                     of?: string; ledgerPostedTotal?: MicroUsd; ledgerLastSeq?: number; ledgerPosition?: LedgerPosition }>;
      whole?: boolean;                 // usage batches only; always true when committed (D1)
      integrityAlert?: boolean }       // the request differed from the committed movement (M4)
  | { result: "refused"; reason: "invalid" | "wrong_home" | "principal" | "stale" | "over_limit"; detail: string }
  | { result: "refused_batch";         // a usage batch refused whole; nothing posted (D1)
      lines: Array<{ lineRef: SourceRef; problem: LineProblem; of?: string;
                     ledgerPostedTotal?: MicroUsd; ledgerLastSeq?: number; ledgerPosition?: LedgerPosition }> }
  | { result: "unavailable"; why: "not_owner" | "moving" | "stopped" | "overloaded" };   // retry rules: see Semantics
```

### 9. Ledger movement feed

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
    outcome: "posted" | "duplicate" | "excluded"; nil: boolean;
    lineKind?: LineKind; payer?: "account" | "share";
    amount?: MicroUsd;                 // buyer side (payer side for cost lines), signed; charge lines
    postedTotal?: MicroUsd;            // posted total of the line after this movement
    reason?: Reason; cause?: Cause; triggerRef?: string;   // as stored from the post (M1)
    lateCut?: { link: LinkId; reduction: ReductionId; extensionChunk: number };
    payee?: { supplier: SupplierId; partnerLink: LinkId };   // fee kinds
    split?: { route: RouteId; weightsVersion: string; mode: "normal" | "own";
              shares?: Array<{ party: string; amount: MicroUsd }> }
              // normal mode: no shares; each party holds split(postedTotal) for weightsVersion.
              // own mode, and cost lines after a downward amendment: the explicit shares held
  }>;
  postedThrough?: Array<{ reservation: ReservationId; minute: Minute }>;
  feesPosted?: Array<{ reservation: ReservationId; feeId: FeeId }>;
  batch?: { id: BatchId; kind: "reservation" | "usage"; whole?: boolean };   // whole: usage batches only, always true
  buyer?: { account: AccountId; balanceAfter: MicroUsd; writtenOffOwedAfter: MicroUsd };  // from ledger_balance in the posting transaction
}
```

There is no `Cut` event. A cut at `T` reads all partitions at one database timestamp below
the closed timestamp (RFC-004 §B1.3). The closure of the feed is its `ResolvedMarker`.

### 10. Quarantine report feed

```ts
interface QuarantineEntryReport {
  type: "QuarantineEntryReport"; schemaVersion: 1; eventId: EventId;
  entryRef: string;
  record: { exporter: ExporterId; observationDomain: string; epoch: number; extendedSeq: Seq; version: number };
  minute: Minute;
  bytes: Seq;                          // floor of the exact (rational) sum of the parts (m17)
  observationPoint: string; link: LinkId; supplier: SupplierId;
  reason: "no_binding" | "ambiguous_binding" | "identity_conflict";
  state: "quarantined" | "attributed" | "reversed" | "superseded";
  replacedBy?: string;                 // the entry that replaces a superseded one
  quarantinedAt: DbTs;
}
interface QuarantineAggregate {
  type: "QuarantineAggregate"; schemaVersion: 1; eventId: EventId;
  link: LinkId; supplier: SupplierId; minute: Minute;
  bytesByState: Record<"quarantined" | "attributed" | "reversed" | "superseded", Seq>;  // floor of each exact sum (m17)
}
```

### 11. Breach report feed

```ts
type BreachReport =
  | { type: "LatenessBreach"; schemaVersion: 1; eventId: EventId; exporter: ExporterId; record: string; latenessMs: number }
  | { type: "AttributionLagBreach"; schemaVersion: 1; eventId: EventId; exporter: ExporterId;
      records: Array<{ from: string; to: string }>; lagMs: number; provisioning?: boolean }  // provisioning: released from the pending-binding hold
  | { type: "SupersessionRaisedBytes"; schemaVersion: 1; eventId: EventId; exporter: ExporterId; record: string; version: number; bytesDelta: Seq }
  | { type: "CountedInTime"; schemaVersion: 1; eventId: EventId; minute: Minute; servingRegion: string; allCountedInTime: boolean };
```

### 12. Evidence query (gRPC, served by RFC-006 history)

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

### 13. `resolve_parked` (gRPC, to rating; D5)

```ts
interface ResolveParkedRequest {
  actionId: string;                    // idempotency key (from the operator action envelope)
  envelope: unknown;                   // RFC-005 operator action envelope; role: finance
  line: SourceRef;                     // the parked line (its parked later sequences go with it)
  action: "re_emit" | "abandon";
  reason: string;
}
type ResolveParkedAnswer =
  | { result: "done"; action: "re_emit" | "abandon"; lines: SourceRef[] }   // the line and its dependants
  | { result: "refused"; why: "not_parked" | "unauthorised" | "invalid" };
```

## Semantics

### Catalogue

- **One writer (D7).** Only the RFC-003 catalogue writes `catalogue.v1`. The link registry
  (RFC-001 §10) publishes link rows on its own feed. Placement publishes probe accounts in
  its account slot map (C01). The catalogue does not carry probe-account designations.
- **Writers of each entity.** An operator command through the console writes most
  entities. Each command has an operator action envelope (RFC-005):
  - Prices and split weights: commercial, with approval by a second commercial operator.
  - Price corrections and `usage_rate_cap`: finance.
  - Partner terms: one commercial operator.
  - Probe links, suppliers and exporters: the catalogue writes them as RFC-006 states.
  - `policy_parameters` (D6): only a **deployment** writes these. A deployment is a
    configuration release that carries the policy-register values, with a lead of ≥ 60 s.
    No console command can write them. A change to a value goes through the policy
    register (requirements), then a deployment.
- **Versions.** Each accepted change is one `CatalogueEvent`. A refused change makes no
  event. Nobody changes or withdraws a version. To fix an incorrect price, use a
  `price_correction`. To fix an incorrect weight, use a new version, which applies from its
  `effectiveFrom` forward (D4).
- **Lead times.** The catalogue refuses, at approval, any version that does not obey these
  rules. Such a version never gets to the feed.
  - Each `price_version`: `effectiveFrom ≥ ceil_min(announcedAt + 60 s)`.
  - Each `usage_price` version, also: `effectiveFrom ≥ ceil_min(announcedAt + price_notice)`.
  - Each `split_weights` version: `effectiveFrom ≥ ceil_min(announcedAt + 60 s)` (D4).
  - Each `account_product_terms` and `policy_parameters` version:
    `effectiveFrom ≥ ceil_min(recordedAt + 60 s)` (D3).
- **Price ties.** There is at most one `price_version` for each
  (product, route, `priceKind`, `effectiveFrom`). The catalogue refuses a second one (m8).
- **`oeEffective`** (RFC-003 §6.2). Open-ended reservations take a `reservation_price`
  version from this minute. Each part locked before this minute changes to the new price.
  New bookings and new parts take the version from `effectiveFrom`. If a version applies to
  open-ended reservations of an account, the version causes the F11 price notice of that
  account. RFC-002 appends F11 at the announcement, idempotent by (account, price version).
  It records the price step at `oeEffective`.
- **Freshness gate (consumer).** The account owner composes an intake only when the applied
  `resolvedTs` of its cache is not more than **60 s** before the timestamp of the intake.
  If not, the account owner does not accept the intake. It writes no entry, it reports
  unavailability, and it sends an alert. E1 records the price version and the
  `CataloguePosition`. The catalogue announces each version that is effective by `T` at or
  before `T − 60 s`. Thus a cache within 60 s of `T` holds each such version (m13).
- **Routes and weights.** Each equivalent path is a `route` with `split_weights`. The
  catalogue registers both before the path is offered. RFC-002 refuses a candidate path
  that is not registered, and sends an alert. Weights are positive integers. Settlement
  splits an original with the version in force at its minute. Each amendment of that line
  has the **same** `weightsVersion` as its original (D4). The ledger keeps that version and
  refuses a mismatch as `invalid`. Settlement does not find a version itself.
- **Exposure parameters (F3; D3, D6).** RFC-004's F3 uses three inputs:
  - `usage_rate_cap` for each (account, product). Before the first version, the POL-14
    default (100 Mbps) applies (m7).
  - The schedule of the highest `usage_price` for each product (from `price_version`).
  - `policy_parameters`.

  F3 calculates `Λ = maxLateness + flowActiveTimeout + 60 s + attributionLagMax + 60 s + 60 s`.
  The last two 60 s terms are constants of the formula: admission's recovery time, and the
  time from suspension to enforcement (D6). Then:

  `LB = ceil(cap* × Λ* × hp*)`

  Each starred value is the **maximum** in force at any instant of the span
  `[ts − (Λ* − 60 s), ts + 60 s]`. `Λ*` is the largest window in force over that span (the
  fixed point over the recorded schedule). Thus an increase enters the bound 60 s before it
  takes effect, and a decrease leaves the bound `Λ* − 60 s` after it takes effect (370 s at
  the defaults). F7 records each step as an exposure-step entry.
- **Edge policing (m6).** The edge polices a new cap from its `effectiveFrom`. If the
  edge's catalogue replica is more than 60 s behind, the edge sends an alarm. For a cap
  decrease, F3 keeps the old cap for 60 s more: until `effectiveFrom + Λ* − 60 s + 60 s`
  (430 s at the defaults). This covers an edge that is at most 60 s late. If an edge is
  later than that, the exposure can be too low. The alarm and the breach report make this
  visible.
- **Probe designations.** Placement's account slot map is the only source for probe
  **accounts** (C01, settled M11). All decisions use the slot map only (m14). The catalogue
  holds designations of probe links, suppliers and exporters only.
- **Query.** The query gives "entity E as known at T, effective at minute m". It uses a
  follower read at T. Errors: `NOT_FOUND`; `UNAVAILABLE` (retry). No booking, record or
  charge waits for a catalogue write.

### Unposted-usage figure

- **Content.** For each product, `U(X) = Σ_L max(0, ⌊V(L)/10⁶⌋ − P_X(L))`, over the usage
  lines of the account for the product.
  - `P_X(L)` is the amount that settlement acknowledged as posted for `L`, through ledger
    position `X`.
  - `X` is a position in the home ledger partition of the buyer. For each usage line of the
    account posted at or below `X`, rating has received the posting acknowledgement.
  - `Δ_b = U(X) − U(X with b posted)`, for each product. Rating calculates it line by line,
    with the same `max(0, ·)`. `Δ_b` does not include a line that rating already holds as
    posted.
  - A figure can name only a usage batch, never a reservation batch.
- **Producer.** Rating publishes a figure when the figure changes. It publishes **not more
  than one figure for each account in 2 s** (`exposure_publish_interval`), with absolute
  values. When a usage batch becomes ready, rating publishes a figure at the next permitted
  time. Probe accounts get no figures. `U` includes parked usage lines (below).
- **Consumer (account owner, F2).**
  - The account owner holds a figure until its applied ledger position `P ≥ X`. Then it
    applies the latest held figure for each account in each batch.
  - It sets `U[product] = U(X) − Δ_b` if an applied F1 at or below `P` reports batch `b`.
    Otherwise it sets `U(X)`. A committed usage-batch movement is always `whole`.
  - It applies the reduction again when a later F1 reports `b` and the current figure
    still names `b`.
  - It ignores a figure whose `ratingPosition` is at or below the last applied figure.
- **Errors.** None. If the F2 lag is more than `attribution_lag_max`, RFC-006 sends an alarm
  (J-18).

### Usage-applied acknowledgement

- The account owner writes it as the outbox row of the F2 entry. Thus it exists if and only
  if the account owner applied the figure. `entry` is the `LogPosition` of that F2 entry
  (C05 v1).
- `appliedThrough` tells rating that the account owner applied a figure at or above that
  rating position. Rating dedups by **(account, `appliedThrough`)** (C05 v1) and keeps the
  **maximum** `appliedThrough` for each account. An older or repeated acknowledgement has no
  effect. It never makes the gate lower.
- **Gap recovery** (C05 v1). Rating finds gaps by `eventId.streamSeq`. First, rating replays
  the topic (retention ≥ 7 days). Then it calls
  `usage_applied_since(accountPartition, afterStreamSeq)`, with the last `streamSeq` that it
  applied. Rating never reads the outbox of the owner.
- **Publish before emit.** Rating emits a gated usage batch `b` only after it receives an
  acknowledgement at or above the position of a figure that names `b`. That figure must
  already count the lines of `b`.
- `appliedTs` is the "counted" time of each record that the figure counts for the first
  time. If a record is counted more than `attribution_lag_max` (10 s) after its acceptance,
  rating reports an attribution-lag breach. Rating also uses `appliedTs` for the X2-S22
  measure, for each minute and region.

### Charge-line batches

- **Reservation batch.** It holds the **originals** of the reservation lines of one account
  for one minute. It holds not more than 5,000 lines.
  - If a minute has more lines, rating makes more reservation batches. Each has a different
    set of reservations.
  - A reservation batch has no gate. Not more than **8 can be in flight for each account**.
  - Rating emits the line of a reservation for `m + 1` only after the line for `m` is
    acknowledged.
  - Settlement posts each batch as one **M4**. If one line has a problem, the ledger
    excludes only that line and posts the other lines.
  - A reservation batch with more than 5,000 lines is refused whole (`over_limit`). Rating
    then splits it again (m2).
- **Usage batch.** It holds all other lines: usage originals and amendments,
  reservation-line amendments (including "late POL-07 cut"), fees, Share-borne fees, cost
  lines and their amendments. It holds not more than 5,000 lines.
  - Only **one is in flight for each account**. Rating emits the next batch only after each
    line of the last batch is acknowledged.
  - A usage batch is **gated** by publish before emit if and only if it holds a usage line.
  - The ledger posts it **whole, in one movement, or not at all (D1)**. The ledger never
    splits it and never mixes it with another batch.
- **One sequence for each line in a batch; sequences in order (D2).**
  - A usage batch holds **not more than one amendment sequence for each line key**.
  - For **each** line (reservation, usage, cost, late original), rating emits sequence
    `k + 1` only after sequence `k` is acknowledged **`posted`**.
  - Thus amendments get to the ledger in sequence. When settlement posts `k + 1`, it knows
    the mode of the line (normal or own) from the ledger.
  - Each amendment has exactly one reason (RFC-003 §5.7).
- **Lines.**
  - The originals of a reservation come in strictly increasing minutes.
  - Each amendment has `amount = newTotal − priorTotal`.
  - Each `seq 0` line has reason `original`. This includes a late original from a quarantine
    attribution or a superseding record. The trigger goes in `triggerRef` and
    `reasonDetails` (m5).
  - A fee line is decided once. It has exactly the shown amount and `seq` 0. Rating never
    amends it (C06-M4). It names its `payee` (the partner and its link, from the fee shown
    in the lifecycle feed, RFC-003 §5.4). It has no route and no weights, and settlement
    does not split it.
  - Probe accounts have no lines.
- **Size.** Rating checks `lines.length ≤ 5,000` before it commits `emitted`. If a usage
  batch is larger:
  - Settlement refuses it whole: it posts nothing.
  - Settlement acknowledges each line `excluded`, reason `batch_over_limit`, and sends an
    alert.
  - Rating then makes new batches within the limit, with new `BatchId`s. Rating names each
    new batch in a new figure before it emits the batch.
- **Settlement mapping** (RFC-004 §B2, §B3). This table gives the combinations that rating
  makes, and the movement for each:

| `lineKind` | `seq` | `reason` | `cause` | Movement |
|---|---|---|---|---|
| reservation | 0 | original | — | M4 (one per reservation batch) |
| usage | 0 | original (a late original included) | — | M5 |
| fee (payer account) | 0 | original | — | M10, to `payee` |
| share_borne_fee (payer share) | 0 | original | — | M11, to `payee` |
| carried_excess | 0 | original | — | M12 |
| dearer_path | 0 | original | — | M13 |
| reservation | > 0 | **late_pol07_cut** (`amount < 0`, `lateCut` present) | **absent** | **M6**, normal mode: each party goes to `split(T_new)` minus the shares already posted. **M7** if the line is already in own mode: each party `−split(−Δ)` (C06-M9). No `SH:corrections` entry, no `fault` debt, and the line does not enter own mode. Settlement posts it at any time, also after the supplier got the payout |
| reservation | > 0 | price_correction, `amount < 0` | share or other | M8 (the line enters own mode) |
| reservation | > 0 | price_correction, `amount < 0` | supplier `f` | M9 (the reduction of `f` as a `fault` debt; own mode) |
| reservation | > 0 | re_rate, `amount > 0` | — | M6 (M7 in own mode) |
| reservation | > 0 | re_rate, `amount < 0` | share (C06-M8) | M8 |
| usage | > 0 | late_traffic, quarantine_attribution or corrected_record (`amount > 0`); price_correction or superseding_record with `amount > 0`; re_rate with `amount > 0` | any, or absent | M6 (M7 in own mode) |
| usage | > 0 | price_correction, superseding_record or attribution_reversed, with `amount < 0` | share or other | M8 (own mode) |
| usage | > 0 | price_correction or superseding_record, with `amount < 0` | supplier `f` | M9 (own mode) |
| usage | > 0 | re_rate, `amount < 0` | share (C06-M8) | M8 |
| carried_excess, dearer_path | > 0 | any reason above that is correct for the trigger | as given | M23 (a nil line if no party moves) |

  All other combinations are **invalid**. Examples:
  - a value that is not in an enum;
  - a reservation amendment with a different reason, or an upward `price_correction` of a
    reservation line;
  - a `late_pol07_cut` with a cause, or with `amount ≥ 0`;
  - a downward amendment of a line that is not a cost line, with no cause, other than
    `late_pol07_cut`;
  - a fee kind with no `payee`, or with `seq > 0`;
  - a `seq 0` line with a reason other than `original`;
  - two sequences of one line key in one usage batch.

  If a **usage batch** has an invalid line, settlement posts nothing (D1). It acknowledges
  that line `excluded` with reason `invalid`, and each other line `batch_refused`. It sends
  an alert. If a **reservation batch** has an invalid line, settlement removes that line,
  acknowledges it `excluded`/`invalid`, and sends the other lines to the ledger. Settlement
  never guesses a posting rule.
- **Affected marks** (`AffectedMark`) go on their own topic, `rating.affected-marks.v1`
  (m12). They are annotations for SLA credit. They have no amount and nobody posts them.
  Reporting consumes them.

### Posting acknowledgement

- **Producers.** The ledger publishes, from its outbox, the acknowledgement for each line of
  a committed movement. A line is `posted`, with the ledger position. A line with
  `duplicate: true` has the position of the original movement. A line of a reservation
  batch can also be `excluded`, with its problem. Settlement publishes, directly, the
  acknowledgements of `refused_batch` and of its own line exclusions. The answers for the
  lines of one batch can be in more than one message. Together they answer each line
  exactly once (m1).
- **Posted.** Rating marks a line as posted **only** when it gets `posted`. It records
  `postedTotal` and `position` in its `posted` entry, and `P_X` reads them.
- **Refused usage batch (D1).** The acknowledgement of a usage batch that was refused whole
  gives each line separately. Each problem line has its reason: `content_conflict`,
  `prior_total_mismatch`, `out_of_sequence` or `invalid`. Each other line is
  `batch_refused`. Rating does these steps:
  1. It handles each problem line as given below.
  2. It puts the `batch_refused` lines into a new usage batch, with a new `BatchId`, but
     not the lines that it parks.
  3. It names the new batch in a new figure before it emits the batch.
- **`content_conflict` or `prior_total_mismatch`** on a line that is not a fee. Rating does
  these steps:
  1. It sets the `E` of the line to `ledgerPostedTotal`, and the next amendment sequence of
     the line to `ledgerLastSeq + 1`.
  2. It puts that posting at `ledgerPosition` for `P_X`.
  3. If `C ≠ ledgerPostedTotal`, it emits **at once** an amendment that changes the ledger
     total to `C` (m3). That amendment has the **reason and cause of the trigger** that
     made the problem line. For a problem **original**, it has reason `re_rate`: an upward
     amendment goes as M6, a downward one has cause share and goes as M8 (m3, C06-M8).
- **`out_of_sequence`** is a defect under D2. Rating sends an alert. It emits the line
  again after its predecessor is acknowledged `posted`. It does not change `E`.
- **`batch_over_limit`.** Rating makes batches within the limit.
- **Parked lines (C06-M11, D5).** Rating parks a line in these cases:
  - the line is acknowledged `excluded` with reason `invalid` (a line-level defect);
  - a fee or Share-borne fee line is acknowledged `content_conflict` (rating never amends
    fees, so it cannot re-base them);
  - **each later sequence of a parked line**. It is parked with the line.

  A parked line stays unposted. Rating sends an alert **at once**. The line **shows in daily
  reconciliation (RFC-004 §B6) as unresolved**. Rating never emits it again automatically.
  A parked line never causes the refusal of another batch.

  Headroom continues to cover each kind of parked line as follows (m4):
  - a usage line stays in `U`;
  - a fee stays in the hold through `fee_state = open` (RFC-004 §A3);
  - a reservation amendment or a cost line is not in headroom. A reservation amendment is
    downward, or it is an upward `re_rate` of a minute that was already held. A cost line
    is a cost to Share, not to the buyer.
- **Exit from parking (D5).** A finance operator sends `resolve_parked` to rating. The
  command has an operator envelope and is idempotent by `actionId`.
  - **`re_emit`**: use it after a fix. Rating puts the line and its parked dependants back
    into the next usage batches, in sequence.
  - **`abandon`**: rating records a write-down. The line and its dependants leave `U` and
    the parking. Reconciliation closes them. Share bears the abandoned charge. The buyer
    pays nothing for the line.

### Ledger posting port

- **Commit.** `post` appends one movement, in one database transaction, in the home
  partition of `movementRef`. The transaction has the condition of the owner's epoch. The
  ledger answers only when the movement is committed in two regions.
- **Principal.** The principal is the mTLS or workload identity of the caller (RFC-005).
  Only settlement, payments, payouts, receivables and reconciliation can post. Each can post
  only the kinds that §B2 permits for it. The ledger refuses other callers or kinds with
  `principal`.
- **Movement-level validation.** If a movement is invalid, the ledger refuses it, records the
  refusal, and moves no money. The ledger checks these items:
  - one currency;
  - the sum of each line is zero;
  - amounts are non-zero integers (only M23 can have a nil line);
  - the class of each ledger account is permitted for the kind;
  - the partition is the home of `movementRef` (`wrong_home`);
  - an M18 is not stale (`stale`);
  - not more than 5,000 lines (`over_limit`);
  - for a charge batch, `lines.length = batch.lineCount`. `lineCount` counts only the lines
    that settlement sends in the request (M3). For a usage batch, it is equal to rating's
    `lineCount`, because settlement removes no line from a usage batch (D1).
- **Per-line checks, in this order (M2).** The ledger does these checks for charge,
  amendment, fee and cost lines:
  1. **Find the canonical `SourceRef`.** If the ledger finds it, it compares the content.
     It uses only these fields: `lineKind`, `amount`, `newTotal`, `priorTotal`, `payer`,
     `payee`, `route`, `weightsVersion`, `reason`, `cause`, `lateCut`, `triggerRef`. If the
     content is the same, the line is a `duplicate`: an idempotent repeat. The ledger posts
     nothing again, and `of` names the first posting. The ledger does no more checks on a
     duplicate. If the content is different, the line is a `conflict`, and the ledger sends
     an **integrity alert**. A difference in `reasonDetails`, `priceCatalogue` or encoding
     is not a conflict.
  2. **Only for a new reference**, the ledger does these checks:
     - `priorTotal` must be equal to the posted total of the line key; if not,
       `prior_total_mismatch`.
     - `amendmentSeq` must be one more than the last sequence posted; if not,
       `out_of_sequence`.
     - `weightsVersion` must be the version that the original of the line was posted with;
       if not, `invalid`.
     - The entries must be equal to the §B2 template for `priorTotal`, `newTotal`, the mode
       and the weights (for example, M6: `split(newTotal) − split(priorTotal)`); if not,
       `invalid`.
- **Stored fields (M1).** The ledger stores `lineKind`, `payer`, `payee`, `reason`, `cause`,
  `lateCut` and `triggerRef` in the movement payload, with the totals and the split. It
  uses them for the comparison above and publishes them on `MovementPosted.lines`.
- **Reservation batch.** The ledger excludes only a line that has a problem, gives its
  `problem`, and posts the other lines (m2).
- **Usage batch (D1).** If a line has a problem (`conflict`, `prior_total_mismatch`,
  `out_of_sequence`, `invalid`), the ledger **refuses the full batch** (`refused_batch`) and
  posts nothing. Thus a committed usage-batch movement always has `whole = true`. The posted
  lines plus the duplicate lines are equal to `batch.lineCount`. If they are not, the ledger
  refuses the movement as `invalid` (defence in depth).
- **Movement-level refusals are not parked (D5).** These are `invalid` (movement level),
  `wrong_home`, `principal` and `stale` on a charge batch. Settlement does not acknowledge
  the lines. It sends an alert, holds the batch in the queue of the account, and tries again
  not more often than once every 30 s (est.). A deployment or configuration fix ends the
  hold. Other accounts continue (M8).
- **`unavailable`** (`not_owner`, `moving`, `stopped`, `overloaded`). The ledger appends
  nothing.
  - `not_owner` and `moving`: try again at once on the refreshed route.
  - `overloaded`: try again after a backoff.
  - **`stopped`** (an integrity stop): send an alert, hold the batch, and try again not more
    often than once every 30 s (est.). Never try again in a tight loop (RFC-000 C4-7).
- **Isolation for each account (M8).** Settlement holds batches **for each account**, not for
  each Kafka partition.
  - A held account (`stopped`, `overloaded`, a movement-level refusal) waits in its own
    queue. Other accounts on the same Kafka partition continue to post.
  - Settlement commits its Kafka offset at the **low-water mark** of the batches that are
    not yet answered.
  - After a restart, settlement reads those batches again. Dedup by `movementRef` and by
    line makes this safe.
- Posting time is the commit timestamp. It is monotone for each partition, also when the
  owner changes. No command changes or removes a movement (P4-S29).

### Ledger movement feed

- There is one `MovementPosted` for each committed movement, in the sequence order of the
  partition.
  - The by-buyer view has each movement whose home is the buyer, whatever ledger accounts it
    touches. All of these are in the home partition of the buyer, in the same order.
  - The by-supplier view has the movements that touch `S:<supplier>:*`.
  - The by-external view has the movements that touch `X:*`.
  - Consumers of a view dedup by (view key, `EventId`).
- The account owner applies the by-buyer view as **F1**. From it, F1 gets:
  - the new `Bal` and `W`;
  - the posted-through minutes for each reservation;
  - the per-line `amount` and `postedTotal`, which give `a_{r,k}(m)` for key spending (KP,
    POL-25), corrections included;
  - the fees posted;
  - for a usage batch, `batch.id`.

  This moves the applied ledger position `P` of the owner forward. Thus the owner releases
  held F2 figures and invoice-status events.
- The cold re-rate of rating reads, for each line: the postings, the amendment sequences,
  the posted totals, the split modes, and **`triggerRef`**. It skips each trigger whose
  reference the ledger already has (RFC-003 §5.10 step 3; M1).
- Reporting and statements show the postings of each line, with their reasons. They show the
  share of each supplier: `split(postedTotal)` in normal mode, and the explicit shares in
  other modes.

### Quarantine and breach reports

- There is one `QuarantineEntryReport` for each quarantine entry and each state change.
  There is one `QuarantineAggregate` for each (link, minute) when it changes. Byte counts
  are the floor of the exact sum (m17). The notifier and reporting give suppliers a filtered
  view: the supplier's own links only, with no buyer data. Probe traffic never shows.
- Breach reports follow RFC-003 §5.9:
  - lateness more than `max_lateness` (180 s) from the end of the record's last minute;
  - attribution lag more than `attribution_lag_max` (10 s), except for parts that come
    through a finance attribution;
  - superseding versions that increase bytes;
  - for each minute and serving region, whether each accepted record was counted in time.

  Probe records never show.

### Evidence query

- The query gives each accepted record that meets these conditions:
  - its active interval meets `[minuteFrom, minuteTo)`;
  - its key and observation point agree with the bindings of the reservation, or with the
    observation points of the link.

  Each record has its versions (accepted and refused), for the retention period (7 years).
  A non-conforming reject shows only its identity, keyed digest, key version and reason.
- The reader verifies the read grant (RFC-005 `operator_check`). It appends its audit record
  before it answers. It records each read for its role (POL-32). Errors: `GRANT_INVALID`,
  `NOT_FOUND`, `UNAVAILABLE`. There is no latency target.

## Delivery and ordering

| Message | Delivery | Partition key | Ordering scope |
|---|---|---|---|
| `CatalogueEvent` | At least once (direct publish and relay) | Entity | For each entity by `entityVersion`. Across entities by `ResolvedMarker` (one writer, D7) |
| `UnpostedUsageFigure` | At least once | Account | For each account by `ratingPosition`. Consumers apply the latest and ignore older ones |
| `UsageApplied` | At least once; replay and `usage_applied_since` for gaps (C05 v1) | Account | For each account by `eventId.streamSeq`. Rating keeps the maximum `appliedThrough` |
| `ChargeLineBatch` | At least once, until acknowledged | Account | For each account stream. Originals for each reservation in increasing minute. Not more than one sequence for each line in a batch. `k + 1` only after `k` is `posted` (D2) |
| `AffectedMark` | At least once | Account | No order relative to batches. The latest for each (reservation, minute, leg) wins |
| `PostingAck` | At least once. The ledger outbox sends committed answers. Settlement publishes refusals and its exclusions directly, before its offset commit | Account | For each account; idempotent for each line |
| `post` (gRPC) | The caller tries again until it gets `committed`, `refused` or `refused_batch`. It handles `unavailable` and movement-level refusals by their rules, for each account | Home partition of `movementRef` | For each partition; posting time is monotone |
| `MovementPosted` | At least once, with an **exactly-once effect** at each consumer: by `EventId` on the full feed, by (view key, `EventId`) on a view | Ledger partition. Views by buyer, supplier or external account | For each partition sequence. For each key in each view |
| `resolve_parked` (gRPC) | The console tries again until it gets an answer | — | Idempotent by `actionId` |
| Quarantine and breach reports | At least once | Link; exporter or region | For each entry state; for each key |

Settlement commits its Kafka offset at the low-water mark of the batches that are not yet
answered (M8). The account owner records each applied feed position in its entry. Thus a
new owner starts again from that position.

## Idempotency

| Message or operation | Key | Duplicate (same content) | Same key, different content |
|---|---|---|---|
| Any Kafka event | `EventId` (partition, stream, streamSeq) with (generation, epoch); on a view, (view key, `EventId`) | The consumer ignores it | Not possible: there is one writer for each partition. The consumer ignores a lower (generation, epoch) |
| `CatalogueEvent` | (entity, `entityVersion`) | No effect | The catalogue refuses it; it never gets to the feed |
| `price_correction` command | `sourceRef` (7 years) | Returns the first result | Refused (AI4-1) |
| `UnpostedUsageFigure` | (account, `ratingPosition`) | No effect | Not possible: a later position replaces it |
| `UsageApplied` | At rating: **(account, `appliedThrough`)** (C05 v1). `entry` (`LogPosition`) identifies the F2 entry | No effect. Rating keeps the maximum `appliedThrough` | Not possible: one F2 entry has one content |
| `ChargeLine` | Canonical `SourceRef` | Ledger: an idempotent repeat. The ledger posts nothing and acknowledges `posted` (`duplicate: true`). The ledger finds duplicates before the sequence and total checks (M2). A usage batch stays `whole` | Ledger: `conflict` and an integrity alert. Reservation batch: the ledger excludes the line (`content_conflict`) and posts the others. Usage batch: refused whole (`refused_batch`); the ledger posts nothing |
| `ChargeLineBatch` / movement | `BatchId` = `movementRef`. The ledger stores the content digest of the movement with its answer, also for `refused_batch` and `over_limit` answers | The ledger returns the recorded answer | **If the reference has a committed answer**, the ledger returns that committed answer (each line deduplicated by line) with `integrityAlert: true`, and sends an integrity alert. It never refuses (M4). **If the recorded answer is not committed** (`refused_batch`, `over_limit`), the ledger answers `refused`/`invalid` and sends an integrity alert. A new batch from rating has a new `BatchId` |
| `PostingAck` | (`batchId`, line `sourceRef`) | No effect at rating | `posted` is final. A later answer never changes it |
| `post` | For each movement, `movementRef` with its content digest. For each line, `lineRef` | The recorded answer | As in the two rows above |
| `MovementPosted` | `EventId`, or (view key, `EventId`) on a view | Ignored | — |
| `resolve_parked` | `actionId` | Returns the first answer | Refused (`invalid`) and recorded |
| Quarantine attribution and reversal | Operator `sourceRef` | Returns the first result | Refused |
| Evidence query | None (read-only) | Any number of retries | — |

## Ownership

| Data | Only writer | Readers |
|---|---|---|
| All entities on `catalogue.v1` | The RFC-003 catalogue, on operator envelopes from the roles that Semantics names. `policy_parameters`: on deployments only (D6) | All consumers above, by replica or follower read |
| Link rows | RFC-001's link registry, on its own feed (not C06) | C03 and the consumers of that feed |
| Probe-account designation | RFC-006 placement, in the account slot map (C01; not C06) | All decisions about probe accounts |
| Unposted-usage figures, charge lines, affected marks, quarantine and breach reports, parking | Rating and stage A (RFC-003) | As the topic table gives. Parking also: `resolve_parked` (finance) |
| Usage-applied acknowledgements | Account owner (RFC-002) | Rating |
| Posting acknowledgements | Ledger (committed answers, outbox); settlement (refusals and exclusions, direct) | Rating |
| Ledger movements | The owner of the ledger partition (RFC-004). It accepts posts only from settlement, payments, payouts, receivables and reconciliation, authenticated by workload identity, each for the kinds §B2 permits | Consumers of the movement feed. No role can change or delete a movement |
| Evidence | The log of ingestion, sealed by RFC-006 history | Operations, support and finance, with a read grant |

Kafka ACLs: each owner can produce only to its own topics (RFC-006 §5.2).

## Timeouts and deadlines

| Item | Bound | Source |
|---|---|---|
| Lead time for a price version | ≥ 1 min before `effectiveFrom`; for `usage_price`, ≥ `price_notice` (30 days) | POL-27; RFC-003 §6.2 |
| Lead time for weights, caps and policy parameters | ≥ 1 min before `effectiveFrom`; never retroactive | D3, D4, D6 |
| Catalogue freshness at the account owner | Applied `resolvedTs` not more than 60 s before the intake `ts`; alarm at 60 s | RFC-002 §3.2, RB-19; RFC-006 §16 |
| Catalogue freshness at the edge | Alarm at 60 s. F3 keeps a decreased cap for 60 s more | m6 |
| Publication of unposted usage | ≤ 1 figure for each account in 2 s | RFC-003 §8 |
| Acceptance → counted (F2 `appliedTs`) | ≤ `attribution_lag_max` = 10 s (budget about 2.5 s, est.). Later is a breach | POL-14; X2-S22 |
| F2 apply-lag alarm | More than `attribution_lag_max` | RFC-006 §16 |
| Lateness bound (exposure) | Window 430 s. Price, cap and window span `[now − 370 s, now + 60 s]`. Only RFC-004 F3 calculates it | RFC-004 §A3; RFC-003 §5.9; D3 |
| **Reservation lines posted (X2-S13)** | Within **120 s after the end of the minute**. Closure is about 3 to 5 s after the end (est.). Each movement takes about 0.2 s to post, and up to 8 are in flight. Thus an account with 1 M reservations posts within about 10 s after closure (est.). About 100 s remain for a settlement takeover (about 5 s, est.) or a lost database node | X2-S13; RFC-003 §5.6, §5.8 |
| **Usage lines posted (X2-S13)** | Within **`max_lateness` + 120 s = 300 s after the end of the minute**. Typical close is at 60 (`flow_active_timeout`) + 180 (`max_lateness`) + 15 (`usage_close_margin`) = **255 s** after the end. Thus **45 s** remain. The hard close bound is 60 + 180 + 45 = **285 s**. Thus **15 s** remain. The 15 s (est.) are used as follows: figure coalescing ≤ 2 s, Kafka to the owner 0.05 s, F2 entry ≤ 0.06 s, acknowledgement back 0.05 s, emission 0.06 s, settlement and `post` about 0.2 s. The total is about 2.5 s. About 12 s remain for **one** of these: a relay hop (about 1 s), a settlement takeover (about 5 s), or one `refused_batch` re-emission (a new figure, about 2.5 s or more). If two occur at the hard bound, the posting can be later than 300 s. Such a minute counts against the 99.99% target and is reported | X2-S13; RFC-003 §5.6, §5.9 |
| **Usage lines of a large account** (m15) | An account with `n` usage lines due in one minute needs ⌈n / 5,000⌉ gated cycles in sequence, each about 2.5 s (est.). For 17,000 lines, that is 4 cycles, about 10 s. At the typical close this is within the 45 s. At the hard bound it uses most of the 15 s. Any minute that is late for this reason counts against the 99.99% target and is reported | RFC-003 §5.8; X2-S13 |
| `post` call | Deadline for each call: 2 s (est.). Try again with backoff until answered. `stopped` and movement-level refusals: not more often than once every 30 s (est.), for each account | This contract |
| Topic retention | 3 days (charge lines); 7 days (other topics; `account.usage-applied.v1` ≥ 7 days). A consumer that is further behind uses history, or `usage_applied_since` | RFC-006 §5.2; C05 v1 |
| Evidence query | No latency target | RFC-003 §3.7 |

## Versioning and compatibility

- Each message type has a `schemaVersion`. The topic name has the major version (`.v1`).
- **Compatible (minor) changes:**
  - add an optional field;
  - add a message type that consumers can skip, for example `ResolvedMarker`.

  Consumers ignore unknown fields.
- **Incompatible (major) changes:**
  - remove or rename a field;
  - change a unit, a key, the partitioning, the canonical `SourceRef` encoding, or the set
    of fields that the ledger compares;
  - **add a value to one of these enums: `Reason`, `LineKind`, `Cause`, `MovementKind`, an
    exclusion reason**.
- **Money enums are closed.** If settlement finds a value that it does not know, the line is
  invalid (D1: a usage batch is refused whole), and settlement sends an alert. Settlement
  never posts by guessing.
- For a major version, make a new topic. Publish on both topics until all consumers have
  moved.
- The schema registry holds the schemas, with BACKWARD_TRANSITIVE compatibility for each
  topic.
- A change of meaning of a figure (for example, what `U(X)` counts) is a new contract
  version, also if the schema does not change. RFC-000 §8 must change first.
- `UsageApplied` uses C05 v1's `LogPosition`. A change to that type is a change to C05 and
  to C06.

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
| CT-R1 Schema | Each emitted message agrees with this schema. Money and prices are integer strings. The canonical `SourceRef` encoding of fixed vectors agrees | — |
| CT-R2 Lead times | None of these gets to the feed: a `usage_price` with less lead than `price_notice`; a price, weight, cap or `policy_parameters` version with less than 1 min lead; a zero weight; a second price version for the same (product, route, kind, `effectiveFrom`) | P3-S69, P4-S38 |
| CT-R3 Batch limits | 5,001 reservation lines in a minute make two reservation batches, with different reservations. No usage batch has more than 5,000 lines | X2-S13 |
| CT-R4 Publish before emit | If `UsageApplied` is held back, rating emits no gated usage batch, but reservation batches continue. An older `UsageApplied`, sent again, does not make the gate lower | P3-S61 |
| CT-R5 Figure content | P3-S37: 0.2 GB at 10,000 micro-USD/GB gives `unpostedUsage` `"2000"`. There is no lateness-bound field | P3-S37 |
| CT-R6 Late POL-07 cut | After an extension chunk, a closed minute at 100 Mbps × 15 micro-USD (1,500) is cut to 60 Mbps. Rating emits `seq` 1, `amount "-600"`, `newTotal "900"`, `priorTotal "1500"`, reason `late_pol07_cut`, `lateCut` set, no `cause`, and the `weightsVersion` of the original. The line goes in a usage batch, after seq 0 is acknowledged `posted` | P4-S117 |
| CT-R7 Re-base | A `content_conflict` acknowledgement with `ledgerPostedTotal` changes `E`. If `C ≠ ledgerPostedTotal`, rating emits the restating amendment at once, with the reason and cause of the problem trigger (a supplier-fault correction stays M9). For a problem original, the reason is `re_rate` | P3-S12, P3-S13 |
| CT-R8 Redelivery | Each batch is sent again three times, with the same content | P3-S12, P4-S57 |
| CT-R9 Moves and cost lines | P4-S110: dearer path `"4"`, route = the path. P4-S115: buyer amendment `"-1"`, cause share, and no dearer-path amendment. P4-S116: the rows as cost-line amendments with their causes | P4-S110, P4-S115, P4-S116 |
| CT-R10 Sequence and parking | A price correction and a late-traffic amendment that are due together on one usage line go in two consecutive batches, never in one batch. A line acknowledged `invalid` parks its later sequences. A parked usage line stays in `U`. A parked line never causes the refusal of another batch | P3-S61, P4-S38 |
| CT-R11 Fee payee | Each fee and Share-borne fee line names its `payee`, has no route or weights, and is never amended | P4-S57 |
| CT-R12 `resolve_parked` | `re_emit` after a fix posts the line and its dependants in sequence. `abandon` removes them from `U` and from the parking, and reconciliation shows them closed. A repeated `actionId` returns the first answer. A caller that is not finance is refused | P3-S61, P4-S57 |
| CT-R13 Late original | A late original from a quarantine attribution has reason `original` and the attribution in `triggerRef`. Settlement maps it to M5 | P3-S27 |

**Provider side: RFC-002 (account owner).**

| Test | Checks | Serves |
|---|---|---|
| CT-A1 Gate on X | A figure whose `X` is above the applied ledger position is held. The account owner applies it when F1 gets to `X`. Its `UsageApplied` has the F2 commit `ts` and an `entry` equal to the `LogPosition` (account partition, sequence) of that F2 entry | P4-S16, P3-S61 |
| CT-A2 Δ_b | `U = U(X) − Δ_b` only when an applied F1 reports the named batch. Before that, `U(X)` | P4-S16 |
| CT-A3 Freshness | If the catalogue cache is 61 s behind, the owner does not accept intakes and sends an alert | — (RFC-002 RB-19) |
| CT-A4 Key spending from the feed | F1's KP for each key, and the balance, come exactly from the per-line `amount` and `postedTotal` of the by-buyer feed, corrections included | P4-S72 |
| CT-A5 Entry identity and recovery | During an owner takeover, `UsageApplied` events come on both publish paths. Rating dedups them by (account, `appliedThrough`). `entry.sequence` increases. Rating finds a gap past retention, and `usage_applied_since(accountPartition, afterStreamSeq)` returns exactly the later events, with the same content | P3-S61, X2-S22 |

**Provider side: RFC-004 (settlement, ledger).**

| Test | Checks | Serves |
|---|---|---|
| CT-L1 Mapping | Each row of the settlement mapping table posts the movement that it names. Fee lines credit their `payee`. An invalid combination in a usage batch refuses the batch whole (`invalid` plus `batch_refused`) and sends an alert. In a reservation batch, settlement removes only the invalid line, and `lineCount` counts the lines that it sends | P4-S41, P4-S42, P4-S89 |
| CT-L2 Late POL-07 cut | P4-S117: weights 3000/3333/2167/1500, line 1,500 → 900. M6 posts `B:b1 +600`, `S:A:earn −180`, `S:B:earn −200`, `S:C:earn −130`, `SH:commission −90`. There is no `SH:corrections` entry and no `fault` debt (m16) | P4-S117 |
| CT-L3 Over limit | A usage batch of 5,001 lines posts nothing. Each line is acknowledged `excluded`, `batch_over_limit`. The ledger records the answer and returns it on a repeat. A reservation batch of 5,001 lines is refused whole, and rating splits it again | X2-S13 |
| CT-L4 Whole | (1) A usage batch with one line already posted with the same content commits with `whole = true` and ignores that line. This includes an **amendment** that is sent again: the ledger finds the duplicate before the sequence and total checks (M2). (2) A line with the same id and different content refuses the batch whole, posts nothing, and sends an integrity alert. That line is acknowledged `content_conflict` and the other lines `batch_refused`. (3) The same for an invalid line. (4) A request with `lines.length ≠ lineCount` is refused `invalid` | P4-S16, P4-S57 |
| CT-L5 Dedup | A batch sent again returns the recorded answer. After a **commit**, the same `movementRef` with a different digest returns the committed answer, with an integrity alert, and never a refusal (M4). Before a commit (a recorded `refused_batch`), it is refused `invalid` with an integrity alert. Two lines that differ only in `cause` (M8 versus M9) are a `conflict`, not a duplicate. A changed line in a reservation batch is excluded with `ledgerPostedTotal`, `ledgerLastSeq` and `ledgerPosition`. A line acknowledged `invalid` gets an alert at once and shows as unresolved in the next daily reconciliation | P4-S57, P4-S29 |
| CT-L6 Order and totals | For a new reference: an amendment whose predecessor is not posted is `out_of_sequence`. A wrong `priorTotal` is `prior_total_mismatch`. Entries that do not agree with the template are `invalid`. A `weightsVersion` that is not the original's is `invalid`. In a usage batch, each of these refuses the batch whole | P4-S38, P4-S39 |
| CT-L7 Feed | Each committed movement shows once for each `EventId`, with `batch`, and with the per-line `amount`, `postedTotal`, `reason`, `cause`, `triggerRef`, `lateCut` and `payee`. The by-buyer view is equal to the full feed filtered by home = buyer, including batches that hold only cost lines. The supplier and external views are equal to their filters. A movement that touches two suppliers is in both supplier views, and dedup by (view key, `EventId`) keeps both copies | P4-S72, P3-S35 |
| CT-L8 Principal | If the workload identity of a caller is not one of the five posting principals, or the caller posts a kind that is not permitted for it, the ledger refuses it with `principal`. Settlement holds that account's batches and tries again every 30 s (est.). It parks no lines | P4-S29 |
| CT-L9 Isolation for each account | One account gets `stopped` (or a movement-level refusal) for 10 min. Other accounts on the same Kafka partition continue to post within X2-S13. The committed offset stays at the low-water mark. After a settlement restart, nothing is posted twice | X2-S13, P4-S57 |

**Consumer side.** Each test uses recorded fixtures from the provider.

| Test | Side | Checks |
|---|---|---|
| CT-C1 | Settlement | Consumes the CT-R fixtures. The posted amounts are equal to the golden ledger |
| CT-C2 | Rating | Consumes the CT-L fixtures. Marks a line posted only on `posted`. Splits again on `batch_over_limit`. Emits `batch_refused` lines again under a new `BatchId`. Parks lines by the rules |
| CT-C3 | Account owner | Consumes the figure and movement fixtures in all orders. At each applied pair, headroom is equal to the exact value |
| CT-C4 | Funds module F3 | Uses catalogue fixtures. For P3-S37, LB = 53,750 and exposure = 55,750. A price increase that is **effective** within the next 60 s increases LB at once. After a decrease, the old price counts for 370 s more. A `usage_rate_cap` decreased from 100 to 50 Mbps keeps LB at 100 Mbps until `effectiveFrom` + 430 s (370 s plus the 60 s edge allowance). An increase counts from 60 s before it takes effect. With no `account_product_terms` version, the cap is 100 Mbps |
| CT-C5 | All | Duplicate and reordered delivery on each topic gives the same state |
| CT-C6 | Rating, funds module | A probe account is excluded only because the slot map designates it. `catalogue.v1` holds no account designation. A producer other than the catalogue cannot write to `catalogue.v1` |

## Settled

The orchestrator settled these points; the decisions are binding. Draft 3 changed them per
review 44 (D1 … D4). Draft 4 changes them per review 55 (D5 … D7). "Consumer obligations"
lists the RFC changes that follow from them.

| # | Point | Settlement |
|---|---|---|
| C06-M1 | Content of the usage-applied acknowledgement | It has `appliedTs` (the commit timestamp of the F2 entry) and `entry` (that F2 entry's C05 v1 `LogPosition { partition, sequence }`), with the rating position. Rating dedups by (account, `appliedThrough`) and keeps the maximum. Rating recovers gaps by replay, then by `usage_applied_since(accountPartition, afterStreamSeq)`, both as C05 v1 states (M9). C06 is the canonical definition. C05 v1 refers to it |
| C06-M2 | Content of an `excluded` posting acknowledgement | `ledgerPostedTotal`, `ledgerLastSeq` and `ledgerPosition` on `content_conflict` and `prior_total_mismatch`. The exclusion reasons are a closed enum. The restating amendment goes at once if `C ≠ ledgerPostedTotal`. It has the trigger's reason and cause, or `re_rate` for a problem original (m3) |
| C06-M3 | Amount of an amendment | `amount`, `newTotal` and `priorTotal`, with `amount = newTotal − priorTotal`, on the charge-line feed **and on the posting port**. The port line also has `lineKind`, `payer`, `payee`, `reason`, `cause`, `lateCut` and `triggerRef`. The ledger stores, compares and publishes them (M1) |
| C06-M4 | Fee lines and Share-borne fee lines | RFC-003's key: (reservation, fee ID) or (request, partner link, fee ID). The reason is a field and is not part of the key. Rating never amends fee kinds (`seq` 0). They name their **`payee`** and have no route or weights. A fee conflict is parked and never re-based |
| C06-M5 | Order of amendments | For **each** line (D2): not more than one sequence for each line key in a usage batch. `k + 1` is emitted only after `k` is acknowledged `posted`. The ledger checks the sequence only for a new reference, after the duplicate check (M2) |
| C06-M6 | Affected marks | An `AffectedMark` message on its own 7-day topic, `rating.affected-marks.v1`, for reporting (m12). Nobody posts it. It is not a line, and it does not count toward the limit or `whole` |
| C06-M7 | Parameters of the lateness bound | A versioned `policy_parameters` catalogue entity, with `policyVersion`. **Only a deployment writes it (D6)**, with the policy-register values. No operator writes it. It and `account_product_terms` take effect ≥ 60 s after they are recorded. F3 uses the maximum cap and the maximum window over the span. Admission's recovery time and the enforcement time are constants of the formula. The edge polices from `effectiveFrom`. F3 keeps a decreased cap for 60 s more, for edge staleness (m6). The default cap is 100 Mbps (m7) |
| C06-M8 | Downward re-rate amendment | Rating sets cause **share**, and settlement posts **M8**. Thus supplier earnings stay final (POL-23). An upward re-rate posts M6/M7. `re_rate` is used only for the residual of a cold re-rate and for the restatement of a problem original |
| C06-M9 | Late POL-07 cut on an own-mode line | M7 posts `−split(−Δ)` for each party |
| C06-M10 | Event identity of feeds | The substrate's `EventId`: (partition, stream, stream sequence) with (generation, epoch). On a view: (view key, `EventId`) |
| C06-M11 | Lines that the ledger cannot post | **D5.** A line-level `invalid` line, a fee conflict, and each later sequence of such a line are **parked**. They stay unposted. Rating sends an **alert at once**. They **show in daily reconciliation as unresolved**. Rating never emits them again automatically. They never cause the refusal of another batch. A finance operator ends the parking with `resolve_parked`: `re_emit` or `abandon` (Share bears an abandoned charge). **Movement-level refusals are not parked**: settlement holds the account's batches and tries again every 30 s (est.) |
| C06-M12 | Wholeness of usage batches | **D1.** If one line of a usage batch cannot be posted, for any reason, the ledger refuses the full batch. The reasons are a ledger conflict, `prior_total_mismatch`, `out_of_sequence`, `invalid` (from settlement or the ledger) or size. Only the problem lines have their own reason; the others are `batch_refused`. A repeated line id with the same content is an idempotent repeat: the ledger ignores it, before the sequence checks, and the batch stays whole. The same line id with different content refuses the batch, with an **integrity alert**. `lineCount` counts the lines that settlement sends (M3). If a movement is committed, a later request for it with a different digest gets the committed answer and an integrity alert (M4). A committed usage-batch movement is always `whole` |
| C06-M13 | Timing of split weights | **D4.** Lead time at least 1 min. Never retroactive. Positive integers. An amendment has the `weightsVersion` of its original. An incorrect weight is fixed forward only. The deviation report (RFC-004 §B3.5) shows its past effect. Finance can settle that effect with an M22 |
| C06-M14 | Writers of the catalogue and probe accounts | **D7.** Only the RFC-003 catalogue writes `catalogue.v1`. Link rows stay on RFC-001's link-registry feed. Only placement's account slot map designates probe accounts (C01 M11). The catalogue has no account designation. `link_rules` is not in v1 (AI-55-1) |

## Consumer obligations

Each RFC must take these errata to agree with this contract. The contract does not edit the
RFCs.

### RFC-002 (rev. 5)

- §13.1 usage-applied acknowledgement:
  - Add `appliedTs` (the commit timestamp of the F2 entry).
  - Add `entry`, the C05 v1 `LogPosition` of the F2 entry.
  - Name C06 as the canonical definition (M1, M9).
- §13.2:
  - Apply F1 from the by-buyer view (each movement whose home is the buyer).
  - Take KP from the per-line `amount` and `postedTotal`.
  - Dedup by (view key, `EventId`).
- §13.2 catalogue:
  - Probe accounts come only from the slot map (D7).
  - Link validity rules are not on the catalogue (AI-55-1).
- Feed identity is `EventId` (M10; already its convention).

### RFC-003 (rev. 5 + 5.1)

- **§7, charge-line row.**
  - Add `newTotal`, `priorTotal` and `lineCount`.
  - Add `payee` on fee kinds. Fee kinds have no route or weights.
  - Use the `SourceRef` forms of this contract, and its canonical encoding.
  - Each `seq 0` line has reason `original`, with the trigger in `triggerRef` (m5).
  - Event identity per M10.
- **§7, affected marks.** Publish affected marks on `rating.affected-marks.v1`, not inside
  reservation batches (M6, m12).
- **§5.8.**
  - Remove the sentence that settlement can post a usage batch with an excluded line. A
    usage batch is posted whole or not at all (D1).
  - On `refused_batch`, emit the `batch_refused` lines again under a new `BatchId`, named
    in a new figure.
  - Not more than one sequence for each line key in a usage batch. `k + 1` only after `k`
    is `posted`, for each line kind (D2).
- **§5.9**, last exactness bullet. Replace it with: "a usage batch with a line that cannot be
  posted is refused whole and emitted again, so each posted usage batch is whole" (M12).
- **§5.7.**
  - Re-base on `ledgerPostedTotal`, `ledgerLastSeq` and `ledgerPosition`. Emit the
    restatement at once if `C ≠ ledgerPostedTotal`. It has the trigger's reason and cause,
    or `re_rate` for a problem original (m3).
  - `out_of_sequence` emits again without a re-base.
  - Park line-level `invalid` lines, fee conflicts and their later sequences (D5).
  - Add the `resolve_parked` command (finance, envelope, idempotent by `actionId`), with
    `re_emit` and `abandon` (D5).
- **§5.10.**
  - A downward "re-rate" has cause Share.
  - The cold re-rate reads `triggerRef` from the movement feed and skips each trigger that
    the ledger has (M1).
- **§6.1, §6.2.**
  - `split_weights`: positive integers, lead ≥ 1 min, never retroactive (D4).
  - `account_product_terms` gets `effectiveFrom` with a lead ≥ 1 min. The default is
    100 Mbps (D3, m7).
  - Add the `policy_parameters` entity, with `policyVersion`. Only a deployment writes it
    (D6).
  - At most one price version for each (product, route, kind, `effectiveFrom`) (m8).
  - Remove probe accounts from the catalogue entities (D7).
  - State the role of `oeEffective` in F11.
- **§7, consumed.**
  - Rating dedups `UsageApplied` by (account, `appliedThrough`) and keeps the maximum. It
    recovers by replay, then by `usage_applied_since` (C05 v1).
  - On the runtime result `Moving`, try again. On `Stopped`, send an alert and hold, with no
    tight loop (C4-7).

### RFC-004 (rev. 5 + 5.1)

- **§A4.**
  - F2: replace "a batch posted with an excluded line is not reduced" with "each posted
    usage batch is whole; `Δ_b` applies when F1 reports the batch" (M12).
  - F1: take KP and posted charges from the per-line `amount` and `postedTotal`.
- **§A3, F3, F7.**
  - `LB = ceil(cap* × Λ* × hp*)`, with the maximum cap and window over the span (D3).
  - Keep a decreased cap 60 s more for edge staleness (m6).
  - Admission's recovery time and the enforcement time are constants (D6).
  - Default cap 100 Mbps (m7).
- **§B1.2.**
  - `whole` is always true for a committed usage-batch movement. The ledger keeps the field
    as a check, with `lineCount` (the lines that settlement sends) (M3).
  - A duplicate with the same content is ignored and `whole` stays true.
- **§B1.4.**
  - Do the duplicate lookup by canonical `SourceRef` **before** the sequence, total,
    weights and template checks (M2).
  - Compare the fields that this contract names, `triggerRef` included.
  - Store the content digest of the movement with its answer.
  - After a commit, a different digest returns the committed answer with an integrity
    alert. Before a commit, it is refused `invalid` (M4).
- **§B2.**
  - M10 and M11 credit the `payee` of the line. The key of M11 has no reason. M23 is not
    used for Share-borne fees.
  - A downward re-rate is M8. M7 for a negative `Δ` is `−split(−Δ)`.
  - Amendments have the `weightsVersion` of the original (D4).
- **§B3.1.**
  - The `whole` column says "always (D1)".
  - A batch made again with a changed line is refused whole.
  - Settlement's line exclusions refuse a usage batch whole.
  - In a reservation batch, settlement removes the line and `lineCount` counts only the
    lines that it sends (M3).
  - The input contract adds `newTotal`, `priorTotal`, `payee`, `lineCount` and
    `triggerRef`.
  - The ledger outbox publishes acknowledgements of committed movements. Settlement
    publishes refusals and exclusions directly.
  - **Isolation for each account**: held batches wait in the queue of the account, and the
    Kafka offset is committed at the low-water mark (M8).
  - Movement-level refusals are held and tried again every 30 s (est.), not parked (D5).
- **§B3.5.** The deviation report shows the past effect of an incorrect weight. Finance can
  fix it with an M22 (D4).
- **§B6.** Daily reconciliation shows parked lines as unresolved until `resolve_parked`
  closes them. Rating alerts them at once. Reconciliation closes an abandoned line (D5).
- **§B9.**
  - Posting row: "reservation batch: the line is excluded and the others are posted; usage
    batch: refused whole, with an integrity alert".
  - Duplicates are found before the sequence checks (M2).
  - `BatchId` row: the committed and uncommitted digest rules (M4).
- **§B12.**
  - The `post` signature adds, for each line: `lineKind`, `payer`, `payee`, `reason`,
    `cause`, `lateCut`, `triggerRef`, `priorTotal` and `newTotal`, plus `batch.lineCount`
    (M1).
  - It adds the answers `refused_batch` and
    `unavailable(not_owner | moving | stopped | overloaded)`, with their retry rules
    (C4-7).
  - It adds per-line `problem` on committed answers (m2), and `integrityAlert`.
  - The principal comes from the workload identity.
  - The posting-acknowledgement exclusion enum, with `ledgerPostedTotal`, `ledgerLastSeq`
    and `ledgerPosition`. Answers for one batch can be in more than one message (m1).
  - The movement feed adds the per-line fields above.
  - The by-buyer view is defined by home. Add the by-supplier and by-external views, with
    dedup by (view key, `EventId`) (m11).
  - Event identity per M10.
- **Callers of the posting port** (settlement, payments, payouts, receivables,
  reconciliation):
  - Try `not_owner` and `moving` again at once.
  - Use backoff for `overloaded`.
  - On `stopped`, send an alert and hold. Try again not more often than once every 30 s,
    for each account (C4-7, M8).

### RFC-006 (rev. 6)

- Add the topics `rating.affected-marks.v1`, `ledger.movements.by-supplier.v1` and
  `ledger.movements.by-external.v1` to the topic table.
- `catalogue.v1` has only the catalogue as producer (D7).
- The ACL of the posting-acknowledgement topic permits the ledger and settlement. The closure
  emitter writes no markers on that topic (m10).
- There is one relayed owner kind for each topic that has markers (AI-55-2).

### Network operations (edge policing)

- Police `usage_rate_cap` from the `effectiveFrom` of the version, never before.
- Send an alarm when the catalogue replica of the edge is more than 60 s behind (m6).

## Upstream issues

| ID | To | Issue | Proposed change |
|---|---|---|---|
| RQ-44-1 | Requirements, POL-14 | The policy does not say which `usage_rate_cap`, or which window, applies when the cap, `max_lateness`, `attribution_lag_max` or `flow_active_timeout` changes | "**Which cap and window.** The highest `usage_rate_cap`, and the longest window, in force at any time in the span of the bound. A cap change takes effect on a minute boundary at least the enforcement target after it is recorded." This contract applies it now (D3) |
| AI-44-1 | RFC-000 §8, "Probe designation and exclusion" and "Account slot map" | Probe accounts had two sources | **Changed by D7**: "Only placement's account slot map designates probe **accounts**. The catalogue does not carry them. Probe links, suppliers and exporters stay catalogue facts, set as RFC-006 states." |
| AI-44-2 | RFC-000 §8, rows Ledger posting port and Ledger movement feed | The list of consumers does not have receivables (M18, M19) and reconciliation (M21). The rule "each line balanced and deduplicated on its own" does not include whole-batch refusal | Add receivables and reconciliation. Add "a usage batch is posted whole or not at all (C06-M12)". In the movement-feed row: `whole` is always true for a committed usage-batch movement and stays as a check |
| **AI-55-1** | RFC-000 §8 Catalogue; RFC-001 §10 | RFC-002 §13.2 consumes "link validity rules and their policy version" from the catalogue. No RFC defines that entity or its writer. C06 v1 does not have `link_rules` | "Link validity rules are versioned with `policyVersion`. RFC-001 owns them. A deployment publishes them on the link-registry feed. Intake records them (C02 `policyVersion`)." |
| **AI-55-2** | RFC-000 §8 substrate conventions, closure emitter | A topic with closure markers must have exactly one relayed owner kind | Add "one relayed owner kind for each topic that has resolved markers". This contract applies it (D7; no markers on the posting-acknowledgement topic) |

RFC-000 revision 4.4 lists points C4-1 … C4-7. Only C4-7 is about C06: the runtime results
`Stopped` and `Moving`. This contract takes them from RFC-006. It shows them as
`unavailable` on the posting port, with the retry rules above. The RFC-003 and RFC-004
errata give the handling.

## Review 44 resolution

Draft 3 applied these. Some notes show where draft 4 changed the result.

| Finding | Severity | Resolution |
|---|---|---|
| F01 | Major | D1. Settlement's mapping exclusions refuse a usage batch whole. `lineCount` is on the batch and the port. Draft 4: `lineCount` counts the lines that settlement sends (R55 M3) |
| F02 | Major | D2. Not more than one sequence for each line key in a usage batch. `k + 1` only after `k` is `posted`. Dependants of a parked line are parked. CT-R10 |
| F03 | Major | `priorTotal` and `newTotal` on the port. The ledger checks them. Draft 4 adds the other compared fields (R55 M1) and puts the duplicate lookup first (R55 M2) |
| F04 | Major | `payee` on fee kinds. No route or weights for fee kinds. CT-L1, CT-R11 |
| F05 | Major | Per-line `amount` and `postedTotal` on `MovementPosted`. Draft 4 adds the stored reason fields and `triggerRef` (R55 M1) |
| F06 | Major | D4. Lead for weights, no retroactive versions, positive integers, original `weightsVersion` on amendments |
| F07 | Major | D3 lead and maximum rule. Draft 4 replaces the writer split with deployment only (D6, R55 M7) |
| F08 | Major | Posting bounds start from the end of the minute (120 s, 300 s), with the itemised 15 s. Draft 4 adds large accounts (R55 m15) |
| F09 | Major | Errata are complete. Draft 4 updates them |
| F10 | Major | Draft 3 had a projection written by placement. Draft 4 removes it: only the slot map designates accounts (D7, R55 M6) |
| F11 | Minor | The ledger stores the digest and records refusal answers. Draft 4 changes the rule after a commit (R55 M4) |
| F12 | Minor | Two named producers of posting acknowledgements. Draft 4: no markers on that topic (R55 m10) |
| F13 | Minor | The by-buyer view is defined by home |
| F14 | Minor | The restatement has the trigger's reason and cause. Draft 4: it goes at once, with `re_rate` for originals (R55 m3) |
| F15 | Minor | A fee conflict is parked. Draft 4 adds `resolve_parked` (D5) |
| F16 | Minor | Reservation amendments are limited |
| F17 | Minor | Compared fields and canonical encoding are given. Draft 4 adds `triggerRef` and puts the fields on the port (R55 M1) |
| F18 | Minor | The principal comes from workload identity |
| F19 | Minor | `ledgerPosition` on exclusions |
| F20 | Minor | By-supplier and by-external views. Draft 4 adds dedup by view key (R55 m11) |
| F21 | Minor | `oeEffective` is explained. Draft 3's `link_rules` is removed in draft 4 (AI-55-1) |
| F22 | Minor | CT-C4 and CT-R6 wording |
| F23 | Minor | `unavailable` retry rules |
| F24 | Minor | Rating keeps the maximum `appliedThrough` |
| F25 | Minor | AI-44-2 |
| C05 v0.2 | Addition | `UsageApplied.entry`. Draft 4 uses the C05 v1 type (R55 M9) |

## Review 55 resolution

| Finding | Severity | Resolution in draft 4 |
|---|---|---|
| M1 | Major | Each port line has `lineKind`, `payer`, `payee`, `reason`, `cause`, `lateCut` and `triggerRef`. The ledger stores, compares and publishes them, `triggerRef` included. The cold re-rate reads `triggerRef`. CT-L5 (cause conflict) and CT-L7 are extended |
| M2 | Major | The per-line checks are in order: first the lookup by canonical `SourceRef` (duplicate or conflict), then, only for a new reference, the `priorTotal`, sequence, weights and template checks. CT-L4(1) includes an amendment |
| M3 | Major | `lineCount` on the port counts only the lines that settlement sends. Settlement removes no line from a usage batch, so the number is equal to rating's count. In a reservation batch, settlement removes the invalid line and the other lines post |
| M4 | Major | After a commit, a request with the same `movementRef` and a different digest gets the committed answer, with `integrityAlert` and an integrity alert. It is never refused. Only an uncommitted recorded answer gives `refused`/`invalid`. CT-L5 |
| M5 | Major | D5. Only line-level defects (`invalid`, fee conflicts) and their dependants are parked. Movement-level refusals hold and are tried again. `resolve_parked` (finance; `re_emit` or `abandon`) ends the parking. CT-R12, CT-L8 |
| M6 | Major | D7. `catalogue.v1` has one writer, the catalogue. Link rows stay on RFC-001's registry feed. There is no account probe projection. CT-C6 |
| M7 | Major | D6. Only a deployment writes `policy_parameters`. The writer split by role is removed. `rtoAdmS` is removed: the recovery and enforcement terms are constants |
| M8 | Major | Settlement holds batches for each account. The Kafka offset is committed at the low-water mark. This also applies to `overloaded` and to movement-level refusals. CT-L9 |
| M9 | Major | `UsageApplied.entry` is C05 v1's `LogPosition { partition: AccountId; sequence }`. Rating dedups by (account, `appliedThrough`). Recovery is by replay, then `usage_applied_since(accountPartition, afterStreamSeq)`. CT-A1, CT-A5 |
| m1 | Minor | One batch's acknowledgements can come in more than one message. Together they answer each line exactly once |
| m2 | Minor | Per-line `problem` on committed answers. A reservation batch over `L` is refused whole and split again |
| m3 | Minor | The restatement is emitted at once if `C ≠ ledgerPostedTotal`. A problem original uses `re_rate` |
| m4 | Minor | The coverage of each kind of parked line is given |
| m5 | Minor | Each `seq 0` line has reason `original`. The trigger is in `triggerRef`. CT-R13 |
| m6 | Minor | Edge staleness alarm at 60 s. F3 keeps a decreased cap 60 s more |
| m7 | Minor | Default cap 100 Mbps before the first version |
| m8 | Minor | `policyVersion` added. At most one price version for each (product, route, kind, `effectiveFrom`) |
| m9 | Minor | `link` and `link_rules` are removed from `catalogue.v1` (D7). AI-55-1 |
| m10 | Minor | No resolved markers on `settlement.posting-acks.v1`. The topic table shows which topics have markers |
| m11 | Minor | Consumers of a view dedup by (view key, `EventId`) |
| m12 | Minor | Affected marks are on their own 7-day topic, for reporting |
| m13 | Minor | The freshness proof is corrected |
| m14 | Minor | Decisions about probe accounts use the slot map only |
| m15 | Minor | Large accounts: ⌈n / 5,000⌉ gated cycles. A late minute counts against the target |
| m16 | Minor | CT-L2 uses ledger-account names |
| m17 | Minor | Quarantine bytes are the floor of the exact sum |
| D5, D6, D7 | Decisions | Applied as given above |
| C05 v1 `LedgerPosition` | Coordinator, binding | `LedgerPosition` uses C05 v1's field names `ledgerPartition` (string) and `sequence`, not `partition` and `seq`, everywhere in C06 |
| AI-55-1, AI-55-2 | Architecture issues | Listed under "Upstream issues" |
