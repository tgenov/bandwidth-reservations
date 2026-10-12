# C06. Usage and charges

| | |
|---|---|
| Contract ID | **C06** |
| Name | Usage and charges: catalogue, unposted usage, charge lines, postings, ledger movements, metering reports, evidence |
| Version | 1 (draft 2: orchestrator decisions on C06-M1 … C06-M12 applied) |
| Status | **Draft, for contract review.** No open mismatch: C06-M1 … C06-M12 are settled by the orchestrator (binding); the RFC errata they imply are listed under "Consumer obligations". See "Settled" at the end |
| Provider | **RFC-003** (rating and metering): Catalogue (with RFC-001's link registry), Unposted-usage feed, Charge-line feed, Quarantine report feed, Breach report feed, Evidence query. **RFC-004** (ledger and settlement): Posting acknowledgement, Ledger posting port, Ledger movement feed. **RFC-002** (account owner; semantics in RFC-004 §A4 F2): Usage-applied acknowledgement |
| Consumers | Catalogue: RFC-002 (account owner: locked prices, partner terms, price notices), RFC-004 (settlement: weights; funds module F3, F11), RFC-001 (probe designations), RFC-006 (probe designations), network operations (`usage_rate_cap`). Unposted usage: RFC-002 (applies it as F2), RFC-004 (semantics). Usage-applied acknowledgement: RFC-003. Charge lines: RFC-004 settlement. Posting acknowledgement: RFC-003. Ledger posting port: settlement, payments, payouts, receivables, reconciliation (all RFC-004). Ledger movement feed: RFC-002 account owner (F1), RFC-003 (cold re-rate), RFC-004 receivables and payouts, reporting, reconciliation, RFC-006 history and audit. Quarantine and breach reports: operator console, notifier, reporting, RFC-006 alerting. Evidence query: operations, support, finance |
| Transport | **Kafka event** (from the producer's transactional outbox, with the changefeed relay as the guaranteed second path, RFC-000 §5.5): catalogue feed, unposted-usage feed, usage-applied acknowledgement, charge-line feed, posting acknowledgement, ledger movement feed, quarantine and breach report feeds. **Synchronous gRPC**: catalogue query, ledger posting port (command to the ledger partition's owner), evidence query (served by RFC-006 history) |
| Pinned to | `requirements-v1.10`; RFC-000 revision 4.4 (§8 rows: Catalogue, Unposted-usage feed, Usage-applied acknowledgement, Charge-line feed, Posting acknowledgement, Quarantine report feed and breach report feed, Evidence query, Ledger posting port, Ledger movement feed); RFC-002 revision 5 (§3.2, §2.5, §13.1, §13.2); RFC-003 revision 5 with erratum 5.1 (§2, §5.2 … §5.10, §6, §7, §8); RFC-004 revision 5 with erratum 5.1 (§A3, §A4, §B1 … §B3, §B9, §B10, §B12) |

## Purpose

C06 is the money seam between metering and rating (RFC-003), the account owner's funds
module (RFC-002 with RFC-004 Part A), and settlement and the ledger (RFC-004 Part B). It
carries:

1. the **reference data** every side prices, splits and bounds exposure with: the catalogue
   (products, routes with split weights, price versions published at least 1 min ahead,
   price corrections, partner terms, account-product terms, probe designations);
2. the **exposure loop**: rating's unposted-usage figure `U(X)` with the in-flight usage
   batch `b` and its reduction `Δ_b`, which the account owner applies only once its ledger
   position reaches `X`, and the account owner's usage-applied acknowledgement, which opens
   rating's publish-before-emit gate;
3. the **charging loop**: charge lines and cost lines in two batch streams (reservation and
   usage), posted by settlement as ledger movements, with per-line posting acknowledgements
   back to rating, and the ledger movement feed that tells the account owner which usage
   batch each movement posted and whether it posted it whole;
4. the **operational outputs** of metering: quarantine and breach reports and the
   evidence query.

The design depends on headroom being exact at every pair the account owner applies (RFC-003
§5.9). This contract fixes the fields and rules that make that hold.

## Conventions

| Quantity | Representation |
|---|---|
| Money | Integer **micro-USD** (10⁻⁶ USD), type `MicroUsd`: a signed decimal integer **string** in JSON (`"-600"`), `bigint` in TypeScript, `INT8` or `DECIMAL(…, 0)` in SQL. Never a float |
| Prices | Integer **pico-USD** (10⁻¹² USD) per unit, type `PicoUsd` (decimal string): per **Mbps-minute** for `reservation_price`, per **GB (10⁹ bytes)** for `usage_price` (RFC-003 §2). A price of 1.5 micro-USD per Mbps-minute is `"1500000"` |
| Rates | Integer **Mbps** (10⁶ bit/s) |
| Volumes | Integer **bytes**; a usage line's exact bytes are a rational (RFC-003 §2, ELA) and do not cross this contract |
| Minutes | UTC minute start, ISO 8601 with a `Z` and zero seconds, type `Minute` (`"2026-10-12T10:05:00Z"`); minute `m` is `[m, m + 60 s)` |
| Database timestamps | The database's commit or resolved timestamp (HLC), type `DbTs`: a decimal string `"<wall-ns>.<logical>"`, compared numerically. Commit timestamps are the only clock for positions, posting times and closure |
| Durations | Milliseconds unless the name ends in `S` (seconds) |
| Identifiers | Pseudonymous opaque strings (RFC-000 A11): `AccountId`, `ReservationId`, `RequestId`, `ProductId`, `RouteId`, `LinkId`, `SupplierId`, `ExporterId`, `FeeId`, `ReductionId`. No personal data in any field (X1-N11) |
| Event identity | `EventId = { partition: string, stream: string, streamSeq: string /* bigint */, generation: number, epoch: number }`, the substrate's per-stream contiguous sequence with the writer's (generation, epoch) (RFC-000 §8 substrate conventions, AI-17-2, AI-R6-3; see C06-M10). Identical on the owner's direct publish and on the changefeed relay |
| Encryption | Every message body is encrypted owner-side under the feed key of its producer (RFC-005 column encryption, AI5-3); only the Kafka key, `EventId` and resolved markers are clear. The schemas below are the decrypted logical form |
| Encoding | JSON (UTF-8) in the encrypted body; every message carries `type` and `schemaVersion` |

### Topics

Names are this contract's; retention is RFC-006 §5.2's.

| Topic | Producer (only writer, ACL) | Key | Retention | Consumers |
|---|---|---|---|---|
| `catalogue.v1` | Catalogue (RFC-003; link-registry rows by RFC-001's registry partition) | Entity (`<entityType>:<entityId>`) | 7 days | Every catalogue consumer, each keeping a full replica |
| `rating.unposted-usage.v1` | Rating (RFC-003) | `AccountId` | 7 days | Account owner (RFC-002) |
| `account.usage-applied.v1` | Account owner (RFC-002) | `AccountId` | 7 days | Rating (RFC-003) |
| `rating.charge-lines.v1` | Rating (RFC-003) | `AccountId` (the buyer; for a cost line, the causing buyer) | 3 days | Settlement (RFC-004) |
| `settlement.posting-acks.v1` | Settlement (RFC-004) | `AccountId` | 7 days | Rating (RFC-003) |
| `ledger.movements.v1` | Ledger (RFC-004) | Ledger partition | 7 days | Reporting, reconciliation, payouts, RFC-006 history and audit, rating's cold re-rate |
| `ledger.movements.by-buyer.v1` | Ledger (RFC-004), filtered view | `AccountId` (buyer movements only) | 7 days | Account owner (F1), receivables |
| `rating.quarantine-report.v1` | Attribution stage A (RFC-003) | `LinkId` | 7 days | Operator console, notifier, reporting, RFC-006 alerting |
| `rating.breach-report.v1` | Rating and stage A (RFC-003) | `ExporterId` (coverage rows: serving region) | 7 days | Operator console, notifier, reporting, RFC-006 alerting |

Each topic also carries **resolved markers** (`ResolvedMarker`, below) per destination
partition, emitted by RFC-006's closure emitter: the minimum over every changefeed partition
that can feed it, published only after every such row (RFC-000 §8, AI-27-3, AI6-11).

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

interface RatingPosition {          // monotone per account
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
  | { entityType: "split_weights"; route: RouteId; weightsVersion: string; effectiveFrom: Minute;
      legs: Array<{ link: LinkId; supplier: SupplierId; weight: number /* positive integer */ }>;
      commissionWeight: number }
  | { entityType: "partner_terms"; partnerLink: LinkId; minimumTermS?: number; cancellationFee?: MicroUsd;
      decreaseAllowed: boolean; maxHoldS?: number; acceptsShareExpiry: boolean }
  | { entityType: "account_product_terms"; account: AccountId; product: ProductId; usageRateCapMbps: number }
  | { entityType: "policy_parameters"; effectiveFrom: Minute;   // C06-M7
      maxLatenessS: number; flowActiveTimeoutS: number; attributionLagMaxS: number;
      rtoAdmS: number; priceNoticeS: number; disputeWindowS: number }
  | { entityType: "probe_designation"; subject: { account: AccountId } | { supplier: SupplierId } | { link: LinkId } | { exporter: ExporterId };
      probe: true }
  | { entityType: "link"; /* RFC-001 link registry: supplier, endpoints, Share or partner, probe flag, retired */ [k: string]: unknown };

interface CatalogueEvent {
  type: "CatalogueEvent"; schemaVersion: 1;
  eventId: EventId;
  entityVersion: Seq;                // per-entity order
  committedAt: DbTs;                 // knowledge time (bitemporal)
  principal: string;                 // pseudonymous; requester
  approver?: string;                 // four-eyes actions (prices, weights)
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

No lateness bound field: the bound (430 s at the defaults, priced over
`[now − 370 s, now + 60 s]`) is computed only by RFC-004's F3 from the catalogue (RFC-003
§5.9, RFC-004 §A3).

### 4. Usage-applied acknowledgement

```ts
interface UsageApplied {
  type: "UsageApplied"; schemaVersion: 1;
  eventId: EventId;                    // the account owner's usage-applied stream
  account: AccountId;
  appliedThrough: RatingPosition;      // rating position of the figure the F2 entry applied
  appliedTs: DbTs;                     // commit timestamp of that F2 entry (C06-M1)
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
  route: RouteId;                     // after a move: the path's catalogue route
  weightsVersion: string;             // weights in force at the line's minute on that route
  minute?: Minute;                    // absent only for fee lines
  payer: "account" | "share";         // share for cost lines and Share-borne fees
  amount: MicroUsd;                   // signed; original: the charge ≥ 0; amendment: C − E
  newTotal: MicroUsd;                 // C (C06-M3)
  priorTotal: MicroUsd;               // E before this line; "0" for an original
  reason: Reason;
  reasonDetails?: Record<string, string>;  // record identities, correction id, operator, references
  cause?: Cause;                      // only where RFC-003 §5.7 gives one; never for late_pol07_cut
  triggerRef?: string;                // correction, attribution, reversal, superseded record
  lateCut?: { link: LinkId; reduction: ReductionId; extensionChunk: number };  // iff reason = late_pol07_cut
  priceCatalogue: CataloguePosition;  // catalogue position of the prices and weights used
  feeId?: FeeId;                      // fee and share_borne_fee
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
  };
  lines: ChargeLine[];                // 1 … 5,000 (the movement limit L)
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
      duplicate: boolean;              // true: already posted with the same contents earlier
      position: LedgerPosition; movementId: string;
      postedAmount: MicroUsd; postedTotal: MicroUsd }
  | { sourceRef: SourceRef; outcome: "excluded";
      reason: "content_conflict" | "prior_total_mismatch" | "out_of_sequence"
            | "batch_refused"            // usage batch refused whole because another of its lines was excluded (C06-M12)
            | "batch_over_limit" | "movement_refused";
      refusal?: "invalid" | "wrong_home" | "principal" | "stale";   // iff movement_refused
      conflictOf?: string;             // movement id holding the reference
      ledgerPostedTotal?: MicroUsd;    // C06-M2: content_conflict, prior_total_mismatch
      ledgerLastSeq?: number };        // C06-M2: content_conflict, prior_total_mismatch

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
  principal: string;                   // settlement | payments | payouts | receivables | reconciliation (pseudonymous)
  operatorEnvelope?: unknown;          // relayed operator action (RFC-005), M21/M22
  cause: string;                       // causing fact
  currency: "USD";
  batch?: { id: BatchId; kind: "reservation" | "usage" };
  conditionalOn?: LedgerPosition;      // M18 only: no movement touched B since
  lines: Array<{
    kind: MovementKind;                // a usage batch mixes kinds
    lineRef?: SourceRef | string;      // charge, amendment, fee, cost lines: their SourceRef
    amendmentSeq?: number;
    split?: { route: RouteId; weightsVersion: string; mode: "normal" | "own";
              explicitShares?: Array<{ party: string; amount: MicroUsd }> };
    entries: Array<{ ledgerAccount: string /* "B:<acct>", "S:<sup>:earn" … */; amount: MicroUsd /* ≠ 0 */ }>;
                                       // sums to zero; empty only for an M23 nil line
  }>;                                  // ≤ 5,000
}

type PostMovementResponse =
  | { result: "committed"; movementId: string; postingTime: DbTs; position: LedgerPosition;
      lines: Array<{ lineRef?: SourceRef | string; outcome: "posted" | "duplicate" | "conflict"; of?: string }>;
                                       // a usage batch is never committed with a "conflict" line (C06-M12)
      whole?: boolean }                // usage batches only; always true when committed (C06-M12)
  | { result: "refused_batch"; lines: Array<{ lineRef: SourceRef; problem: "conflict" | "prior_total_mismatch" | "out_of_sequence";
      of?: string; ledgerPostedTotal?: MicroUsd; ledgerLastSeq?: number }> }   // usage batch refused whole, nothing posted
  | { result: "refused"; reason: "invalid" | "wrong_home" | "principal" | "stale" | "over_limit"; detail: string }
  | { result: "unavailable"; why: "not_owner" | "moving" | "stopped" | "overloaded" };   // retry
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
  kinds: MovementKind[];
  cause: string;                       // an M19 names its invoice
  currency: "USD";
  partyTotals: Array<{ ledgerAccount: string; amount: MicroUsd }>;
  lines: Array<{
    lineRef?: SourceRef | string; kind: MovementKind; amendmentSeq?: number;
    outcome: "posted" | "duplicate" | "conflict"; nil: boolean;
    reason?: Reason; lateCut?: { link: LinkId; reduction: ReductionId; extensionChunk: number };
    split?: { route: RouteId; weightsVersion: string; mode: "normal" | "own";
              shares?: Array<{ party: string; amount: MicroUsd }> }  // explicit in own mode and for cost lines after a downward amendment
  }>;
  postedThrough?: Array<{ reservation: ReservationId; minute: Minute }>;
  feesPosted?: Array<{ reservation: ReservationId; feeId: FeeId }>;
  batch?: { id: BatchId; kind: "reservation" | "usage"; whole?: boolean };   // whole: usage batches only
  buyer?: { account: AccountId; balanceAfter: MicroUsd; writtenOffOwedAfter: MicroUsd };  // from ledger_balance in the posting transaction
}
```

There is no `Cut` event: a cut at `T` is a read of every partition at one database
timestamp below the closed timestamp (RFC-004 §B1.3); the feed's closure is its
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

- **Writes** are operator commands through the console (prices and weights by commercial
  with a second commercial approver; corrections, `usage_rate_cap` by finance; partner
  terms by one commercial operator). Each accepted change is one `CatalogueEvent`; a
  refused one emits nothing. A version is never changed or withdrawn; a mistake is fixed by
  a `price_correction`.
- **Price lead time.** Every `price_version` satisfies
  `effectiveFrom ≥ ceil_min(announcedAt + 60 s)`; every `usage_price` version also
  `effectiveFrom ≥ ceil_min(announcedAt + price_notice)`. A version that breaks either is
  refused at approval and never reaches the feed.
- **Freshness gate (consumer).** The account owner composes an intake only while its cache's
  applied `resolvedTs` is within **60 s** of the intake's timestamp; otherwise it does not
  accept it (no entry, unavailability, alerted). E1 records the price version and the
  `CataloguePosition`. Since every version effective by `T + 60 s` was announced by `T`, a
  cache through `T` cannot lock a price a published version would have replaced.
- **Routes and weights.** Every equivalent path is a `route` with `split_weights`
  registered before it is offered; RFC-002 refuses (and alerts) a candidate that is not.
  Settlement splits with the `weightsVersion` named on the line, never deriving it.
- **Exposure parameters.** RFC-004's F3 takes `usage_rate_cap` per (account, product), the
  highest `usage_price` schedule per product (from `price_version`, announced
  `price_notice` ahead), and `policy_parameters` (C06-M7).
- **Query** answers "entity E as known at T, effective at minute m" by a follower read at T.
  Errors: `NOT_FOUND`; `UNAVAILABLE` (retry). No booking, record or charge waits on a
  catalogue write.

### Unposted-usage figure

- **Content.** Per product, `U(X) = Σ_L max(0, ⌊V(L)/10⁶⌋ − P_X(L))` over the account's
  usage lines of the product, `P_X(L)` what settlement acknowledged as posted for `L`
  through ledger position `X`. `X` is a position of the buyer's home ledger partition such
  that every posting of a usage line of the account at or below `X` has been acknowledged to
  rating. `Δ_b = U(X) − U(X with b posted)`, per product, line by line with the same
  `max(0, ·)`. Only usage batches are ever named; reservation batches never.
- **Producer.** Published whenever it changes, **at most one per account every 2 s**
  (`exposure_publish_interval`), absolute values; a usage batch that becomes ready
  triggers a figure at the next allowed moment. Probe accounts get none.
- **Consumer (account owner, F2).** Holds a figure until its applied ledger position
  `P ≥ X`; applies the latest held figure per account in each batch; sets
  `U[product] = U(X) − Δ_b` if an applied F1 at or below `P` reports batch `b` posted
  `whole`, else `U(X)`; re-applies the reduction when a later F1 reports `b` whole and the
  current figure still names `b`. A figure with a `ratingPosition` at or below the last
  applied is dropped.
- **Errors.** None returned. A lag of F2 beyond `attribution_lag_max` is alarmed (RFC-006,
  J-18).

### Usage-applied acknowledgement

- Written as the outbox row of the F2 entry, so it exists iff the figure was applied.
- `appliedThrough` tells rating the account owner has applied a figure at or above that
  rating position. **Publish before emit**: rating emits a gated usage batch `b` only after
  receiving an acknowledgement at or above the position of a figure that names `b` and
  already counts its lines.
- `appliedTs` is the "counted" time of every record newly counted by that figure: rating
  reports each counted more than `attribution_lag_max` (10 s) after acceptance as an
  attribution-lag breach, and the per-minute, per-region measure of X2-S22.

### Charge-line batches

- **Reservation batch**: the reservation-line **originals** of one account and one minute,
  at most 5,000 lines; a minute above that is several reservation batches with disjoint
  reservations. Never gated. Up to **8 in flight per account**; a reservation's line of
  `m + 1` is emitted only once its line of `m` is acknowledged. Settlement posts each as
  one **M4**.
- **Usage batch**: every other line (usage originals and amendments, reservation-line
  amendments including "late POL-07 cut", fees, Share-borne fees, cost lines and their
  amendments), at most 5,000 lines; **one in flight per account**, the next emitted only
  after every line of the last is acknowledged; **gated** by publish before emit iff it
  holds a usage line. Settlement posts it **whole in one movement**, never split or shared.
- **Size.** Rating checks `lines.length ≤ 5,000` before committing `emitted`. Settlement
  refuses a larger usage batch whole: nothing posted, every line acknowledged `excluded`,
  `batch_over_limit`, alerted; rating re-composes the lines into batches within the limit
  under new `BatchId`s, each named in a new figure before emission.
- **Lines.** Originals per reservation in strictly increasing minutes; per line, amendments
  in amendment-sequence order with `amount = newTotal − priorTotal`. An amendment of a
  reservation line is emitted only after the line's previous sequence is acknowledged
  posted (C06-M5). Fee lines are decided once: exactly the shown amount, `seq` 0, never
  amended (C06-M4). Probe accounts produce no lines.
- **Settlement mapping** (RFC-004 §B2, §B3):

| `lineKind` | `seq` | `reason` | `cause` | Movement |
|---|---|---|---|---|
| reservation | 0 | original | — | M4 (one per reservation batch) |
| usage | 0 | original (or a late original) | — | M5 |
| fee (payer account) | 0 | original | — | M10 |
| share_borne_fee (payer share) | 0 | original | — | M11 |
| carried_excess | 0 | original | — | M12 |
| dearer_path | 0 | original | — | M13 |
| reservation, usage | > 0 | late_traffic, quarantine_attribution, corrected_record; price_correction or superseding_record with `amount > 0`; re_rate with `amount > 0` | any | M6 (M7 if the line is in own mode) |
| reservation | > 0 | **late_pol07_cut** (`amount < 0`, `lateCut` present) | **absent** | **M6** normal mode, each party to `split(T_new)` less shares posted; M7 if already in own mode (C06-M9). No `SH:corrections`, no `fault` debt, own mode not entered; posted however late, even after the supplier was paid out |
| reservation, usage | > 0 | price_correction, superseding_record, attribution_reversed with `amount < 0` | share or other | M8 (line enters own mode) |
| reservation, usage | > 0 | price_correction, superseding_record with `amount < 0` | supplier `f` | M9 (`f`'s own reduction as `fault` debt; own mode) |
| reservation, usage | > 0 | re_rate with `amount < 0` | share (C06-M8) | M8 |
| carried_excess, dearer_path | > 0 | any | as given | M23 (a nil line when no party moves) |

  Any other combination (an unknown `reason`, a `late_pol07_cut` with a cause or with
  `amount ≥ 0`, a downward amendment of a non-cost line without a cause other than
  `late_pol07_cut`) is acknowledged `excluded` with reason `movement_refused` and refusal
  `invalid`, and alerted; settlement never guesses a posting rule.
- **Affected marks** (`AffectedMark`) are annotations for SLA credit: no amount, never
  posted, not lines, not counted toward the limit or `whole`. Settlement skips them;
  reporting consumes them.

### Posting acknowledgement

- Published by settlement for **every line** of a batch once its movement is answered:
  `posted` with the ledger position (a `duplicate: true` posting answers the original
  movement's position), or `excluded` with its reason.
- Rating marks a line posted **only** on `posted`, recording `postedTotal` and `position`
  (its `posted` entry), which `P_X` reads.
- A usage batch refused whole (C06-M12) is acknowledged line by line: each offending line
  with its own reason (`content_conflict`, `prior_total_mismatch`, `out_of_sequence`), every
  other line `batch_refused`. Rating handles the offending lines as below and re-emits the
  `batch_refused` lines in a new usage batch under a new `BatchId`, named in a new figure
  before emission.
- On `content_conflict` or `prior_total_mismatch` rating re-bases the line's `E` on
  `ledgerPostedTotal` and its next amendment sequence on `ledgerLastSeq + 1`, and the next
  amendment restates the ledger to `C`. On `out_of_sequence` rating re-emits after the
  predecessor's acknowledgement (no re-base). On `batch_over_limit` rating re-composes. On
  `movement_refused` the lines stay unposted (still counted in `U`), settlement and rating
  **alert at once**, and the lines **appear in daily reconciliation (RFC-004 §B6) as
  unresolved** until an operator resolves them; rating does not re-emit them automatically
  (C06-M11).

### Ledger posting port

- `post` appends one movement in one database transaction in the home partition of
  `movementRef`, conditional on the owner's epoch; the answer is given only once committed
  in two regions.
- **Validation** (refused, recorded, nothing moved): one currency; every line sums to zero;
  amounts non-zero integers (only M23 may carry a nil line); account classes allowed for the
  kind; principal allowed for the kind; partition is the home (`wrong_home`); M18 stale
  (`stale`); more than 5,000 lines (`over_limit`).
- **Per line**: `posted`; `duplicate` (same reference, same contents: nothing posted again,
  `of` the first: an idempotent repeat, dropped); `conflict` (same reference, different
  contents). In a **reservation batch** a conflicting line is excluded, the rest
  posted, reported and alerted.
  In a **usage batch** a line that is a `conflict` (or `prior_total_mismatch` or
  `out_of_sequence`) **refuses the whole batch** (`refused_batch`): nothing is posted, and
  a `conflict` raises an **integrity alert** (C06-M12).
- `whole` (usage batches only) is true for every committed usage-batch movement: each line
  is `posted` in it, nil lines included, or is a `duplicate` with identical content, which is
  dropped and does not break `whole` (C06-M12). Rating's `Δ_b` never counts a line it
  already holds as posted, so a dropped duplicate leaves the reduction exact.
- `unavailable` (`not_owner`, `moving`, `stopped`, `overloaded`): nothing appended; the
  caller retries (RFC-000 C4-7 settles the runtime results for every owner).
- Posting time is the commit timestamp, monotone per partition across owner changes. There
  is no command that alters or removes a movement (P4-S29).

### Ledger movement feed

- One `MovementPosted` per committed movement, in partition sequence order. The by-buyer
  view carries exactly the movements homed at that buyer (all in its home partition), in
  the same order.
- The account owner applies them as **F1** (new `Bal`, `W`, posted-through minutes per
  reservation, fees posted, and for a usage batch `batch.id` with `whole`), which advances
  its applied ledger position `P` and so releases held F2 figures (and invoice-status
  events).
- Rating's cold re-rate reads, per line, postings, amendment sequences and split modes.

### Quarantine and breach reports

- One `QuarantineEntryReport` per quarantine entry and per state change; one
  `QuarantineAggregate` per (link, minute) on change. Supplier-facing views (through the
  notifier and reporting) are filtered to the supplier's own links and carry no buyer data.
  Probe traffic never appears.
- Breach reports as RFC-003 §5.9: lateness beyond `max_lateness` (180 s) from the record's
  last minute end; attribution lag beyond `attribution_lag_max` (10 s), except parts reached
  through a finance attribution; superseding versions that raise bytes; per minute and
  serving region whether every accepted record was counted in time. Probe records never
  appear.

### Evidence query

- Answers every accepted record whose active interval meets `[minuteFrom, minuteTo)` and
  whose key and observation point match the reservation's bindings or the link's
  observation points, with its versions (accepted and refused) for the retention period
  (7 years); non-conforming rejects by identity, keyed digest, key version and reason only.
- The reader verifies the read grant (RFC-005 `operator_check`) and appends its audit record
  before answering; each read is recorded for its role (POL-32). Errors: `GRANT_INVALID`,
  `NOT_FOUND`, `UNAVAILABLE`. No latency target.

## Delivery and ordering

| Message | Delivery | Partition key | Ordering scope |
|---|---|---|---|
| `CatalogueEvent` | At least once (direct publish + relay) | Entity | Per entity by `entityVersion`; cross-entity consistency by `ResolvedMarker` |
| `UnpostedUsageFigure` | At least once | Account | Per account by `ratingPosition`; consumers apply the latest, drop older |
| `UsageApplied` | At least once | Account | Per account by `streamSeq`; `appliedThrough` monotone |
| `ChargeLineBatch` | At least once until acknowledged | Account | Per account stream; originals per reservation in increasing minute; amendments per line in sequence |
| `AffectedMark` | At least once | Account | Unordered relative to batches; latest per (reservation, minute, leg) wins |
| `PostingAck` | At least once (re-sent from the ledger's answer after a settlement restart) | Account | Per account; per line idempotent |
| `post` (gRPC) | Caller retries until a `committed`, `refused` or `refused_batch` answer | Home partition of `movementRef` | Per partition, posting time monotone |
| `MovementPosted` | At least once, **exactly-once effect** at each consumer by `EventId` | Ledger partition; by-buyer view by account | Per partition sequence; per account in the by-buyer view |
| Quarantine, breach reports | At least once | Link; exporter or region | Per entry state; per key |

Settlement commits its Kafka offset only after each acknowledged post; the account owner
records each applied feed position in its entry, so a new owner resumes from it.

## Idempotency

| Message or operation | Key | Duplicate (same content) | Same key, different content |
|---|---|---|---|
| Any Kafka event | `EventId` (partition, stream, streamSeq) with (generation, epoch) | Dropped by the consumer | Impossible by construction (one writer per partition); a lower (generation, epoch) is ignored |
| `CatalogueEvent` | (entity, `entityVersion`) | No-op | Refused at the catalogue; never on the feed |
| `price_correction` command | `sourceRef` (7 years) | First result returned | Refused (AI4-1) |
| `UnpostedUsageFigure` | (account, `ratingPosition`) | No-op | Not possible; a later position supersedes |
| `UsageApplied` | (account, `appliedThrough`) | No-op | Not possible |
| `ChargeLine` | `sourceRef` (line key, minute, amendment seq; fee by (reservation or request[, partner link], fee)) | Ledger: idempotent repeat, dropped, acknowledged `posted` (`duplicate: true`); a usage batch stays `whole` | Ledger: `conflict` and integrity alert. Reservation batch: line excluded `content_conflict`, rest posted. Usage batch: refused whole (`refused_batch`), nothing posted |
| `ChargeLineBatch` / movement | `BatchId` = `movementRef` | Ledger returns the first movement's answer | A re-composed batch gets a new `BatchId`; lines dedup per line |
| `PostingAck` | (`batchId`, line `sourceRef`) | No-op at rating | Last answer for the line wins only if `posted`; `posted` is final |
| `post` | Per movement `movementRef`, per line `lineRef` | First answer | Per line `conflict`; a usage batch refused whole |
| `MovementPosted` | `EventId` | Dropped | — |
| Quarantine attribution and reversal | Operator `sourceRef` | First result | Refused |
| Evidence query | None (read-only) | Any number of retries | — |

## Ownership

| Data | Only writer | Readers |
|---|---|---|
| Catalogue entities except links | Catalogue partitions (RFC-003) | All consumers above, by replica or follower read |
| Link registry rows | RFC-001's registry partition | As catalogue |
| Unposted-usage figures, charge lines, quarantine and breach reports | Rating and stage A (RFC-003) | As the topic table |
| Usage-applied acknowledgements | Account owner (RFC-002) | Rating |
| Posting acknowledgements | Settlement (RFC-004) | Rating |
| Ledger movements | Ledger partition owner (RFC-004), on posts from settlement, payments, payouts, receivables, reconciliation only, each for the kinds §B2 allows | Movement-feed consumers; no role may update or delete a movement |
| Evidence | Ingestion's log, sealed by RFC-006 history | Operations, support, finance with a read grant |

Kafka ACLs: an owner produces only to its own topics (RFC-006 §5.2).

## Timeouts and deadlines

| Item | Bound | Source |
|---|---|---|
| Price version lead | ≥ 1 min before `effectiveFrom`; `usage_price` ≥ `price_notice` (30 days) | POL-27; RFC-003 §6.2 |
| Catalogue freshness at the account owner | Applied `resolvedTs` within 60 s of the intake `ts`; alarm at 60 s | RFC-002 §3.2, RB-19; RFC-006 §16 |
| Unposted-usage publication | ≤ 1 figure per account per 2 s | RFC-003 §8 |
| Acceptance → counted (F2 `appliedTs`) | ≤ `attribution_lag_max` = 10 s (budget about 2.5 s, est.); later is a breach | POL-14; X2-S22 |
| F2 apply lag alarm | Beyond `attribution_lag_max` | RFC-006 §16 |
| Lateness bound (exposure) | 430 s window, price span `[now − 370 s, now + 60 s]`, computed by RFC-004 F3 only | RFC-004 §A3; RFC-003 §5.9 |
| Reservation minute closure | About 3 to 5 s after `m + 60 s` (est.), later only under an open reduction's holds | RFC-003 §5.6 |
| Usage minute closure | By `m + 60 s + flow_active_timeout + max_lateness + 45 s` (285 s after the minute's end) | RFC-003 §5.6 |
| Posting | Within the X2-S13 timeliness target (2 min from closure); settlement takeover about 5 s (est.) | RFC-004 §B3.1 |
| `post` call | Per-call deadline 2 s (est.), retried with backoff until answered; `unavailable` always retried | This contract |
| Topic retention | 3 days (charge lines), 7 days (others): a consumer further behind rebuilds from history | RFC-006 §5.2 |
| Evidence query | No latency target | RFC-003 §3.7 |

## Versioning and compatibility

- `schemaVersion` per message type; the topic name carries the major version (`.v1`).
- **Compatible (minor)**: adding an optional field; adding a message type consumers may
  skip (`ResolvedMarker`-style). Consumers ignore unknown fields.
- **Not compatible (major)**: removing or renaming a field, changing a unit, changing a key
  or partitioning, **adding an enum value to `Reason`, `LineKind`, `Cause`, `MovementKind`,
  or an exclusion reason**. Money enums are closed: a settlement that meets an unknown
  value excludes the line (`movement_refused`/`invalid`) and alerts, never posts by guess.
  A major version is a new topic, dual-published until every consumer has moved.
- Schemas are registered in the schema registry with BACKWARD_TRANSITIVE compatibility per
  topic.
- A change of meaning of any figure (for example what `U(X)` counts) is a contract version
  even if the schema is unchanged, and needs RFC-000 §8 to change first.

## Scenarios relied on

P3-S10, P3-S12, P3-S13, P3-S15, P3-S17, P3-S26, P3-S27, P3-S32, P3-S35, P3-S37, P3-S39,
P3-S41, P3-S56, P3-S58, P3-S59, P3-S61, P3-S62, P3-S64, P3-S65, P3-S66, P3-S69;
P4-S15, P4-S16, P4-S29, P4-S38, P4-S39, P4-S57, P4-S72, P4-S110, P4-S115, P4-S116,
P4-S117; X1-S31; X2-S13, X2-S22 (all at `requirements-v1.10`).

## Conformance tests

**Provider side, RFC-003 (rating, catalogue).**

| Test | Checks | Serves |
|---|---|---|
| CT-R1 Schema | Every emitted message validates against this schema; money and prices are integer strings | — |
| CT-R2 Price lead | A `usage_price` with less than `price_notice` and any version with less than 1 min lead never reach the feed | P3-S69 |
| CT-R3 Batch limits | 5,001 reservation lines in a minute → two reservation batches, disjoint reservations; no usage batch above 5,000 lines | X2-S13 |
| CT-R4 Publish before emit | With `UsageApplied` withheld, no gated usage batch is emitted; reservation batches flow | P3-S61 |
| CT-R5 Figure content | P3-S37: 0.2 GB at 10,000 micro-USD/GB gives `unpostedUsage` `"2000"`; no lateness-bound field | P3-S37 |
| CT-R6 Late POL-07 cut | After an extension chunk, a closed minute at 100 Mbps × 15 micro-USD (1,500) cut to 60 Mbps emits `seq` 1, `amount "-600"`, `newTotal "900"`, `priorTotal "1500"`, reason `late_pol07_cut`, `lateCut` set, no `cause`, in a usage batch, after seq 0 is acknowledged | P4-S117, P3-S58 |
| CT-R7 Re-base | A `content_conflict` acknowledgement with `ledgerPostedTotal` re-bases `E`; the next amendment restates the ledger to `C` | P3-S12, P3-S13 |
| CT-R8 Redelivery | Every batch redelivered three times with identical contents | P3-S12, P4-S57 |
| CT-R9 Moves and cost lines | P4-S110 dearer path `"4"`, route = path; P4-S115 buyer amendment `"-1"` cause share, no dearer-path amendment; P4-S116 rows as cost-line amendments with causes | P4-S110, P4-S115, P4-S116 |

**Provider side, RFC-002 (account owner).**

| Test | Checks | Serves |
|---|---|---|
| CT-A1 Gate on X | A figure with `X` above the applied ledger position is held, applied once F1 reaches it, and its `UsageApplied` carries the F2 commit `ts` | P4-S16, P3-S61 |
| CT-A2 Δ_b | `U = U(X) − Δ_b` only when an applied F1 reports the named batch `whole`; a `whole = false` movement leaves `U(X)` | P4-S16 |
| CT-A3 Freshness | With the catalogue cache 61 s behind, intakes are not accepted and an alert raised | — (RFC-002 RB-19) |

**Provider side, RFC-004 (settlement, ledger).**

| Test | Checks | Serves |
|---|---|---|
| CT-L1 Mapping | Every row of the settlement mapping table posts the movement named; unknown or inconsistent combinations are excluded and alerted | P4-S41, P4-S42 |
| CT-L2 Late POL-07 cut | P4-S117: weights 3000/3333/2167/1500, line 1,500 → 900: M6 `B +600`; A −180, B −200, C −130, commission −90; no `SH:corrections`, no `fault` | P4-S117 |
| CT-L3 Over limit | A 5,001-line usage batch posts nothing; every line `excluded` `batch_over_limit` | X2-S13 |
| CT-L4 Whole | A usage batch with one line already posted with identical content commits with `whole = true` and that line dropped; one with a line of the same id and different content is refused whole, nothing posted, an integrity alert raised, the line acknowledged `content_conflict` and the rest `batch_refused` | P4-S16, P4-S57 |
| CT-L5 Dedup | A re-posted batch returns the first answer; a changed line in a reservation batch is `conflict`, excluded, with `ledgerPostedTotal` and `ledgerLastSeq` in its acknowledgement; a `movement_refused` line is alerted at once and listed unresolved in the next daily reconciliation | P4-S57, P4-S29 |
| CT-L6 Order | An amendment whose predecessor sequence is not posted is `out_of_sequence` | P4-S38 |
| CT-L7 Feed | Every committed movement appears once per `EventId` with `batch` and `whole`; the by-buyer view equals the filtered full feed | P4-S72 |

**Consumer side (each runs against recorded provider fixtures).**

| Test | Side | Checks |
|---|---|---|
| CT-C1 | Settlement | Consumes the CT-R fixtures; posts amounts equal to the golden ledger |
| CT-C2 | Rating | Consumes CT-L fixtures; marks posted only on `posted`; re-composes on `batch_over_limit` |
| CT-C3 | Account owner | Consumes figure and movement fixtures in every interleaving; headroom equals the exact value at every applied pair |
| CT-C4 | Funds module F3 | From catalogue fixtures, LB = 53,750 and exposure 55,750 for P3-S37; a price rise announced inside the next 60 s raises it at once; after a decrease the old price counts for 370 s more |
| CT-C5 | All | Duplicate and reordered delivery of every topic gives identical state |

## Settled

The orchestrator settled every point raised in draft 1 (binding). Each is specified above
as stated here; the RFC changes it implies are listed under "Consumer obligations".

| # | Point | Settlement |
|---|---|---|
| C06-M1 | Usage-applied acknowledgement content | Carries `appliedTs`, the commit timestamp of the F2 entry, beside the rating position (RFC-003 needs it for attribution-lag breaches and X2-S22) |
| C06-M2 | `excluded` posting acknowledgement content | Carries `ledgerPostedTotal` and `ledgerLastSeq` on `content_conflict` and `prior_total_mismatch`; exclusion reasons are a closed enum |
| C06-M3 | Amendment amount | Carries `amount`, `newTotal`, `priorTotal`, with `amount = newTotal − priorTotal`; a `priorTotal` that differs from the ledger's posted total is `prior_total_mismatch`, and rating re-bases |
| C06-M4 | Share-borne fee lines | RFC-003's key: (reservation, fee ID) or (request, partner link, fee ID); the reason is a field, not part of the key. Share-borne fee lines are never amended (`seq` 0) |
| C06-M5 | Reservation-line amendment vs original | Rating emits an amendment of a reservation line only after the previous sequence is acknowledged `posted`; otherwise the ledger answers `out_of_sequence` |
| C06-M6 | Affected marks | A separate `AffectedMark` message on the charge-line topic: never posted, not a line, not counted toward the limit or `whole` |
| C06-M7 | Lateness-bound parameters | A versioned `policy_parameters` catalogue entity, effective from a minute, applied by F3 |
| C06-M8 | Downward re-rate amendment | Rating sets cause **share**, and settlement posts **M8**: supplier earnings stay final (POL-23). An upward re-rate posts M6/M7 |
| C06-M9 | Late POL-07 cut on an own-mode line | M7 posts each party `−split(−Δ)` |
| C06-M10 | Feed event identity | The substrate's `EventId`: (partition, stream, stream sequence) with (generation, epoch) |
| C06-M11 | Lines of a refused movement | They stay unposted (counted in `U`), are **alerted at once**, and **appear in daily reconciliation as unresolved** until an operator resolves them. They are never re-emitted automatically |
| C06-M12 | Repeats and conflicts inside a usage batch | A repeated line id with identical content is an **idempotent repeat**: dropped, and the batch is still `whole`. The **same line id with different content refuses the usage batch whole** (nothing posted) and raises an **integrity alert**. The other lines are acknowledged `batch_refused` and re-emitted by rating under a new `BatchId`. So a committed usage-batch movement is always `whole` |

## Consumer obligations

These are the errata each RFC must take so that it matches this contract. The contract
does not edit the RFCs.

| RFC | Erratum |
|---|---|
| RFC-002 (rev. 5) | §13.1 usage-applied acknowledgement: add `appliedTs`, the F2 entry's commit timestamp (M1). Feed identity as `EventId` (M10, already its convention) |
| RFC-003 (rev. 5 + 5.1) | §7 charge-line feed: carry `newTotal` and `priorTotal` beside `amount` (M3), affected marks as a separate `AffectedMark` message (M6), and the `SourceRef` forms of this contract, with Share-borne fee lines never amended (M4). §5.8: emit a reservation-line amendment only after the previous sequence is acknowledged (M5); re-emit `batch_refused` lines under a new `BatchId` named in a new figure (M12). §5.7: re-base on `ledgerPostedTotal` and `ledgerLastSeq` for `content_conflict` and `prior_total_mismatch` (M2); `out_of_sequence` re-emits without re-basing; `movement_refused` lines stay unposted, are alerted and are never re-emitted automatically (M11). §5.10: a downward "re-rate" amendment carries cause Share (M8). §6.1: add the `policy_parameters` entity (M7). §7: event identity per M10 |
| RFC-004 (rev. 5 + 5.1) | §B3.1, §B12 posting acknowledgement: closed exclusion reasons, with `ledgerPostedTotal` and `ledgerLastSeq` (M2) and `batch_refused` (M12). §B3.1 input contract: `amount`, `newTotal` and `priorTotal`, with `prior_total_mismatch` (M3). §B2 M11: key without the reason; M23 not used for Share-borne fees (M4). §B1.4: `out_of_sequence` for an amendment whose predecessor is not posted (M5). §B12, §A4 F3: parameters from `policy_parameters` (M7). §B2, §B3.4: a downward re-rate posts M8 (M8); M7 for a negative `Δ` posts `−split(−Δ)` (M9). §B9, §B12: `EventId` (M10). §B6: list the lines of refused movements as unresolved in daily reconciliation until resolved, alerted at once (M11). §B1.2, §B12: a duplicate line with identical content is dropped and leaves `whole` true; a same-id line with different content refuses a usage batch whole (`refused_batch`) with an integrity alert; reservation batches keep per-line exclusion (M12) |

RFC-000 revision 4.4's points C4-1 … C4-7 do not concern C06, except C4-7 (runtime
results `Stopped` and `Moving`), which this contract takes as RFC-006's and surfaces as
`unavailable` on the posting port.
