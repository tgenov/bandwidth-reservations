# RFC-000. Architecture overview: single-writer owners on two-region consensus logs

| | |
|---|---|
| Status | Draft, revision 3.1: revision 3 revised per the [second adversarial review](../reviews/08-rfc-000-review-2.md) (A0R-01 … A0R-14, R2-D1 … R2-D7), then corrected per its [verification](../reviews/10-rfc-000-verification.md) (V-01 … V-08), after revision 2 applied the [first](../reviews/06-rfc-000-review.md) (A0-01 … A0-21); see "Review resolution" at the end |
| Satisfies | All — structural. Allocates every need (P1-N1 … X2-N6, 66 in all) to an owning component and to the detailed RFC that specifies it; the scenarios themselves are satisfied by RFC-001 … RFC-006 |
| Policies | POL-01 … POL-33 (every entry of the register; §7 names the component that applies each need, and §2 the policies each component serves) |
| Prior decisions | History log D3, D12, D13, D21 (carried forward in Competition) |
| Builds on | The requirements at tag `requirements-v1.5` ([problem statements](../01-discovery/), [specs](../02-specs/), [policy register](../02-specs/policy-register.md), [glossary](../02-specs/glossary.md)), which include RQ-1 … RQ-6 ([review 07](../reviews/07-requirements-amendments-from-rfc-000-review.md)), and the decisions on RQ-7 … RQ-12 raised by the second review and this revision, which `requirements-v1.4` and `requirements-v1.5` record ([review 09](../reviews/09-requirements-amendments-from-rfc-000-review-2.md)): the confirm fence (RQ-7), reporting once releases are durable (RQ-8), P1-S54 (RQ-9), the status-read exception (RQ-10, RQ-12), payments in flight in reconciliation (RQ-11), and diverse fibre paths as a go-live condition (A0R-05) |
| Supersedes | The structural parts of the pre-baseline drafts RFC-001 … RFC-004, which were written from a prototype |

Terms are used in the sense of the [glossary](../02-specs/glossary.md). In particular,
"reserved rate" is capacity and "traffic" is bytes; neither is called "usage". Every
round-trip time, latency, volume and size in this RFC is an **estimate**, to be replaced
by measurement (Risks, R1), unless it is a requirement's own figure.

## Need

The requirements describe one marketplace with four very different workloads, which the
architecture has to make possible at once without one compromising another:

1. **A capacity decision that can never be wrong in the generous direction** (P1-N1, POL-05)
   and that is answered within `ack_budget` (200 ms at p99, POL-04) at 25,000 requests/s
   overall and 2,500/s on the hottest link (POL-06), whatever the booking's length
   (X2-N3). Every booking on a link, single-link or route, is decided by that link's one
   schedule owner (P1-N3), and every request has **one decision point** (POL-04) against
   which its account's suspension, its key's revocation, its withdrawal and its deadline
   are judged.
2. **A multi-party booking that is all or nothing** across Share links, partner systems that
   cannot join a transaction, and the buyer's funds (P2-N1, P2-N7, P2-N8), bounded by a
   deadline after which it is never confirmed and its holds are released (P2-N3, POL-26,
   with `release_grace` when the decision record, or the schedule of a link it holds, is
   unavailable), confirmed only by a decision timestamped before the deadline, and reported
   not confirmed only once the Share-link capacity it frees is durably released (POL-04,
   RQ-7, RQ-8), with contention resolved
   by an explicit priority rule on Share links and at partners alike (P2-N4, POL-02), and
   recovery from Share's own crashes (P2-N5, POL-03).
3. **A metering and rating pipeline** that takes about 260,000 flow records/s (600,000/s
   peak), duplicated, late and out of order (P3-N3), keeps every one of them for 7 years
   (P3-N7, X2-N6), counts each accepted record in headroom within `attribution_lag_max`
   (P3-N10), and turns reservations and traffic into charges that are exactly once,
   reproducible and amended rather than rewritten (P3-N2, P3-N8, P3-N9), posted within
   2 min of each minute's end (X2-N3).
4. **A money system** that is conserved and immutable (P4-N7), moves money once per source
   reference for 7 years (P4-N15, POL-29), holds funds before capacity (POL-25), suspends
   and resumes by rule (P4-N5), splits exactly (P4-N8), pays out once (P4-N12), reconciles
   daily with the outside world (P4-N14, POL-24) and can rebuild any past headroom exactly
   as shown (P4-N16).

Across all four: every operation by an authenticated principal, accounts isolated, operator
power controlled and every change attributable (X1-N1 … X1-N10); availability per
capability and per serving region of 99.99% (admission, including the funds holds a
booking needs; ingestion) or 99.9% (wallet, payouts, reporting); RPO 0 with **every fact
acknowledged only once durable in two regions** (X2-N4); RTO from 1 min to 30 min on node
or zone loss and 1 h on region loss (X2-N5); latency targets suspended, but RPO 0 kept,
during a declared region disaster (POL-06); 7-year retention (X2-N6).

**The sites are given.** Share serves from its own data centres in **Nairobi** and
**Mombasa** and runs on Google Cloud as well ([company profile](../01-discovery/company-profile.md)).
The coordinator has fixed the geography (decision D1 of the review, as overridden): R1
Nairobi and R2 Mombasa (Share's own data centres) serve traffic; R3, Google Cloud
`africa-south1` (Johannesburg), is the third voting region and serves none.

The architecture must therefore decide: what the components are and what each one alone
may write; which interactions are synchronous on the 200 ms path and which can lag; where
atomicity is needed and how it is achieved without a global transaction; and how state is
replicated so that two-region acknowledgement fits inside `ack_budget` on these three
sites and a link or an account never has two writers, even across failures.

## Approach

### 1. Principles

| # | Principle | Why (requirement) |
|---|---|---|
| A1 | **Every piece of state has exactly one writer component.** Others read it, subscribe to it, or ask its owner to change it. | POL-05 for link schedules; the same discipline makes the account, reservation, ledger and request invariants each provable in one place. |
| A2 | **Each owner is partitioned by its natural serial key** (link, account, partner link, exporter, ledger account) and each partition is a **single-leader state machine over a replicated log**, fenced by the log's term. | "Decided as if one at a time" is stated per link (P1-N2), per account and key (P2-N8, P4-N3, POL-25) and per reservation (P2-N9). A single leader per partition gives that order directly, without locks or retries. |
| A3 | **Every replicated log commits only through a quorum that spans two regions.** There is no one-region state on any path that answers a buyer. | X2-N4, POL-06: a fact is acknowledged only once durable in two regions. P4-S72: what a buyer was shown must survive a region loss. |
| A4 | **Facts are append-only; current state is derived.** Corrections are new facts. | P1-N7, P1-N9 (known-at history), P3-N7, P3-N8, P4-N7, X1-N8. |
| A5 | **The 200 ms path touches only admission components**, synchronously; everything else (rating, settlement, statements, history, notifications) is asynchronous and catches up from the owners' logs. | POL-04 `ack_budget`; POL-06 gives rating no availability target of its own, only timeliness. |
| A6 | **Every command between components carries a deterministic idempotency identity**; every external input carries its own (idempotency key, source reference, record identity). Delivery between components is at least once. | POL-29, P2-N6, P3-N2, P3-N3, P4-N1, P4-N15. |
| A7 | **One decision point per request, and it is a log entry.** A request's outcome is fixed by the first deciding entry in its account owner's log: a conditional *confirm*, a conditional *expire*, or an ending entry (rejected, withdrawn, key revoked, account suspended). Log order, not clocks, decides which comes first. | POL-04 (one decision per request), POL-26 (never confirmed after the deadline), P2-S69, P2-S103. |
| A8 | **Deadlines are data; clocks drive liveness only.** The deadline is in the request record and in every hold. Clocks decide *when* a participant asks for expiry and *whether* a confirm may still be proposed; they never decide which of two outcomes wins. | POL-26: failed as of the deadline, whatever Share's state; review A0-01. |
| A9 | **Only a request's account owner ends its holds, and a release ends them for good.** A link owner or partner adapter releases a request's hold only on that owner's say-so (an outcome, an accepted yield). A release for an outcome is **request-scoped**: it ends every hold, waiter registration and grant the request has at that participant, whatever the attempt, and leaves a tombstone that refuses any later hold or grant for the request (A0R-03). | All or nothing (P2-N1): no participant can release a hold the decision still depends on, and no late or retried command can recreate one after the outcome. |
| A10 | **An outcome is reported only once it is final everywhere a buyer could see it.** A confirmation is reported once its deciding entry, and a non-confirmed outcome once a **"releases durable"** entry in the same log recording that every Share-link release it needs is durable (A0R-02), is at the log's **report position** (§4.6): known committed by a majority of voters and applied by every status replica holding a read lease. The edge's synchronous final answer, status replicas, the outcome feed and webhooks are all reports and all obey this gate (V-01, V-02). | POL-04 as amended by RQ-6 and RQ-8: capacity is free from the moment the outcome is reported. |

### 2. Component decomposition

Each component below owns the state listed and is its only writer. "Serves" names the
needs and policies it is the primary owner of; the full allocation is in §7.

#### Admission (capability: admission API, 99.99%, RTO 1 min)

| Component | Single responsibility | State it owns (only writer) | Partition | Serves |
|---|---|---|---|---|
| **Link schedule owner** | Decide every capacity question on one Share link, and record every change to what the link has sold or can carry | Per link: capacity history (baseline, unplanned outages and restorations, planned maintenance bookings, permanent reductions and their notice); confirmed reservation legs and their parts; capacity holds, each carrying its account, request identity, deadline `D` and `request_age`; Share's own holds for firm equivalent-path offers, at full rate from the offer to the reservation's end, counted as committed for new sales while the offer is open (POL-07, RQ-4); the link's waiter queue ordered by the priority rule, with waiter registrations, waiting notices and yields as **log entries**; **request tombstones** (one per request released or refused on the link, kept until its `D` + `release_grace`; any hold or grant for a tombstoned request, or for one past its `D`, is refused); affected flags per reservation and minute; the link's bitemporal change log | One partition per link; a hot link has a group to itself | P1-N1 … P1-N9, POL-05, POL-07, POL-09, POL-10, POL-31 |
| **Account owner** | Decide every booking request and every change of one account, and keep everything that account-level admission depends on, **in one serial order on one two-region log** | Per account. *Booking module* (RFC-002): booking requests (idempotency key, fingerprint, principal, `D`, `request_age`, `wait`, progress per leg, waiting, withdrawing and takeover marks, the **deciding entry** with its reason, and for a non-confirmed outcome its **"releases durable"** record, built from the release acknowledgements of every Share leg in the intake); reservations as route-level units (legs, parts, locked prices, partner terms shown at booking, lifecycle and end cause, partner-leg affected status, equivalent-path offers); per-reservation change queue. *Funds and standing module* (RFC-004 Part A): funds holds and credit holds; capacity in flight per key and account; key spending per `key_spend_period`; booking-rate counters per key and account (exact, D5); key status as applied here (D6); headroom inputs as applied feed entries (ledger balance through a ledger position, unposted usage through a rating position); credit limit as applied; standing, its cause, grace start and resume amount; low-balance warning state | By account (idempotency keys, limits and headroom are all per account) | P2-N1 … P2-N11, P4-N3 … P4-N6, P4-N17 (limit and standing side), POL-03, POL-04, POL-08, POL-15, POL-16, POL-18, POL-25, POL-26, POL-29 |
| **Partner adapters** | Speak one partner's API safely, and **stand in for a schedule owner for Share's own position at each partner link**: idempotent hold (with an absolute expiry set to `D`), confirm, final booking, release and cancel; classify answers (held, definite refusal, transient, unknown); order Share's own waiters by the priority rule; reconcile | Per partner link: the partner's classification under POL-26 (offers holds only if they last at least `route_deadline_max` + `commit_margin` **and** accept an expiry set by Share; otherwise without holds, P2-S102); Share's outstanding holds and bookings at the partner, each with its request, `D` and age; the waiter queue of Share requests refused because of Share's own position (POL-02), by `priority_rule`, each waiter with its `D` and commit fence; request tombstones as on a link owner; call journal with idempotency keys and the time each partner confirm was sent (the request's "begin committing" time, POL-26); reconciliation results and mismatches | By partner link, on a two-region log | P2-N7, part of P2-N4, POL-02 (partner refusals), POL-26 (partner holds), POL-28 |

**Why the coordinator and the account funds are one component** (review A0-02). In the
previous draft the booking coordinator's request log and the account's funds and
standing were two components on the same partition key, the second durable in one region
only. That gave each request two decision points (the *bind* and the *decision record*),
so P2-S69 and P2-S103 could not both hold; it gave the account two serial orders, so
"concurrent bookings checked as if one at a time" (POL-25) spanned two logs; and it lost
the shown headroom on a region loss (P4-S72). Merging them gives one writer process per
account, whose decision entry checks standing, key status, the withdrawal mark, any
expiry entry and every limit in one place, and binds the funds in the same entry. The
two modules keep separate specifications (RFC-002 and RFC-004 Part A) and separate
invariants, but one log and one leader. The account owner is engineered to admission's
targets (99.99%, RTO 1 min), as POL-06 now requires for the funds holds a booking needs.

**Where the booking workflow runs.** The workflow that drives a request (taking holds,
calling the partner adapter, asking for expiry) runs **in the account owner's leader
process**, so every step it takes is in the same region as the log it writes. The edge
forwards each request once, to that leader. A new leader resumes every unfinished
workflow from the log (POL-03).

#### Metering and rating (capabilities: usage ingestion 99.99%, RTO 1 min; rating and posting, judged by timeliness, RTO 5 min ceiling)

| Component | Single responsibility | State it owns | Partition | Serves |
|---|---|---|---|---|
| **Metering ingestion** | Accept every flow record, durably, exactly as received; acknowledge only once it is durable in two regions | The raw record log (every record received, accepted or not, with its reason); record-identity index per exporter as run-length range sets of (exporter epoch, sequence number), for the retention period | By exporter | P3-N3, P3-N7, P3-N11, X2-N4 for records |
| **Attribution and quarantine** | Decide, for each accepted record, the account, route, product and reservation it belongs to, which leg's count is the egress count, and which billing rule of POL-17 applies; keep what cannot be attributed in quarantine | Attribution results per record and minute; quarantine entries and finance attributions within `dispute_window` | By account once attributed; by exporter in quarantine | P3-N4, P3-N6, P3-N13, POL-13, POL-17 |
| **Rating** | Turn reservation history, attributed traffic and price history into charge lines and amendments, exactly once and reproducibly; feed unposted usage to the account owner | Charge lines (reservation, usage, fee) and their amendments, each with its source reference and reason; per-line rated totals; unposted usage per account and product; lateness and attribution-lag breach reports | By buyer account | P3-N1, P3-N2, P3-N5, P3-N8, P3-N9, P3-N10, P3-N12, POL-01, POL-11, POL-14, POL-27 |
| **Catalogue** | Hold the reference data every other owner prices, splits or validates against | Links (supplier, Share or partner, endpoints, probe flag), products, `reservation_price` and `usage_price` history on minute boundaries, price corrections (as bitemporal facts, POL-23), split weights per route and party, partner terms (minimum term, cancellation fee, hold length, whether the partner accepts an expiry set by Share), probe designations | By entity | Inputs to P1, P2, P3, P4; POL-12 weights, POL-23 corrections, POL-27 |

**The attribution → unposted-usage → account path and the reservation-accrual posting
path run with hot standbys** that take over within about 30 s (review A0-07). The 5 min
RTO of rating and posting is a ceiling, not the design point: X2-S13 and X2-S22 are
counted per minute at 99.99%, which allows about 4.3 min a month, and one 5-minute
recovery would spend all of it. With a 30 s takeover a zone loss costs one or two
breaching minutes. RFC-006 states the per-minute budget arithmetic.

#### Money (capabilities: wallet, payouts and reporting 99.9%; rating and posting RTO 5 min)

| Component | Single responsibility | State it owns | Partition | Serves |
|---|---|---|---|---|
| **Ledger** | Be the only writer of money movements: validate (sums to zero per currency, every amount tagged), deduplicate by source reference, append, never alter; publish **closed positions** | The journal of movements; source-reference deduplication (7 years) as watermarks per structured reference plus exception sets, with principal and content digest; per-partition closed positions ("closed through T"); per-account balances as derived projections | Journal partitioned by the movement's **home**, a function of its source reference alone, so a redelivery always lands where the original did: (1) the buyer, if the movement touches a buyer (charges, amendments, fees, top-ups, invoice payments, reversals, write-offs, corrections Share bears for a buyer); (2) otherwise the **buyer whose request, reservation or traffic caused it**, where there is one (carried excess paid by Share, the dearer-path difference, a partner cancellation fee Share bears, the FX difference on a buyer's top-up, a supplier debt raised by an amendment); the buyer's own balance is not touched, so it stays wholly in its partition; (3) otherwise the supplier, if it touches exactly one (payouts, supplier debts and their payments, duplicate-payout debts); (4) otherwise one of N **Share sub-partitions** by a hash of the source reference (FX differences on payouts, Share's own deposits and withdrawals). A movement never touches two buyers. Supplier and Share balances are aggregates over partitions at closed positions, so no partition is a hot row (A0R-09) | P4-N7, P4-N15, P4-N16 (movements), POL-11, POL-20, POL-29 |
| **Settlement** | Turn each charge or amendment into one movement split among its route's parties; pay the costs Share bears; raise supplier debts | Per charge line: shares already posted per party; deviation from exact proportions per party per payout period | By buyer account (charges); by supplier (debts) | P4-N8, P4-N9, P4-N11, POL-12, POL-23 |
| **Payments, receivables and reconciliation** | Everything that moves money between Share and the outside on the buyer side, and the daily proof that the books match the money | Payment events as received (authenticated, 2-region durable before the provider is acknowledged); the **binding of each provider transaction reference to its account**, fixed by the first authenticated **and well-formed** event, which every later event for that reference is checked against (a malformed event is recorded and rejected without creating a binding, P4-S05; V-05); top-up conversions; pending orphan reversals (72 h); invoices, invoice payments as applied to invoices, and write-offs; daily reconciliation runs, each at one closed position per ledger partition, and their differences, including incoming payments received by the partner and not yet posted (RQ-11) | Per kind of state (V-04): payment events, their reference bindings and pending orphan reversals by **(provider, transaction reference)**, so every event for one provider transaction, its reversal included, is in one partition (A0R-04); invoices, invoice payments as applied and write-offs **by account**, fed idempotently by the payment's reference (the overdue and paid feeds go to that account's owner); reconciliation runs **by day** | P4-N1, P4-N2, P4-N13, P4-N14, P4-N17 (invoices), POL-15, POL-20, POL-21, POL-24 |
| **Payouts** | Pay suppliers weekly, once, and recover what a provider executes twice | Payout runs (each at closed positions), instructions (with their references), **transfer confirmations and failures** (routed by the instruction reference, with the provider's reference recorded, and deduplicated here; payouts is their only writer, V-04), escalations, residues carried | By supplier | P4-N12, POL-22 |
| **Reporting and statements** | Serve every account its statement and every supplier its view, from the owners' feeds | Read models only (no facts of its own): statements, supplier schedules with opaque reservation references, deviation reports | By account | P4-N10, the supplier view of X1-N2 and POL-33 |

#### Cross-cutting

| Component | Single responsibility | State it owns | Serves |
|---|---|---|---|
| **Edge gateway** | Terminate every external call: authenticate, resolve the principal, shed gross abuse with advisory rate counters, forward once to the owner partition's leader, answer within `ack_budget` | Advisory rate counters (soft state; the exact limits are enforced by the account owner, D5) | X1-N1 |
| **Identity and access** | Principals, agent keys and their limits, roles, consent to identify an account to a named supplier, and the authorisation decision for every operation | Accounts' users and administrators; agent keys, their limits and revocations (pushed to the account owner, which applies them, D6); operator roles; supplier-consent records (POL-33); KYB status as recorded by onboarding | X1-N1 … X1-N4, X1-N9, X1-N10, POL-25, POL-32, POL-33 |
| **Operator console and approvals** | The only way operators act: every action names its role and reason, four-eyes actions wait for a second compliance approval, then the action is sent to the component that owns the state | Operator action requests, pending approvals and their outcomes, on a two-region log; refused attempts at privileged actions | X1-N7, POL-30, POL-32 |
| **Audit** | Keep the immutable record of every change to money, capacity, links or keys, every operator action and every refused privileged attempt, for the retention period | The audit store, built from audit fields every owner writes in its own log (principal, time, role, reason) | X1-N8, POL-19 |
| **History** | Answer "as known at T" questions and keep every owner's log for 7 years | Archived owner-log segments in object storage replicated in two regions, and their bitemporal indexes (read models; owners stay the writers of the facts) | P1-N9 (storage), P4-N16 (rebuild), X2-N6, POL-19 |
| **Notifier** | Deliver every outbound notice: signed buyer webhooks retried for `webhook_retry`, affected-reservation notices within `affected_notice_time`, suspension and low-balance notices, supplier notices, operational alerts | Delivery attempts and their status | P2-N2 (webhooks), part of P1-N8, P4-N5, X1-N6 (signing with keys from identity and access) |
| **Probes** | Measure availability from outside each serving region as the designated probe account on designated probe links and exporters | Probe results per capability and minute | X2-N1 |
| **Placement and time** (platform) | Map every partition to its replicated log; keep all admission leaders in one region while it is healthy and move them region-wide when it is not; reconfigure groups to 2 + 2 during a declared region disaster; move partitions with an epoch; publish closed positions and report positions (§4.6); provide the clock-uncertainty bound `ε` | Partition map and epochs, on its own 2 + 2 + 1 log; leader-placement policy and its trigger | Single writer across failures (POL-05), deadlines (POL-26), status reads (POL-04) |

**Merges and splits, and why.**

- *Booking and account funds are one component* (above). One serial order per account
  covers requests, decisions, holds, limits, key status and standing (POL-04, POL-25).
- *Waiting, crossings and deadlines* are not a separate component. The waiter queue for a
  Share link is part of that link's schedule (POL-02, POL-05); for Share's own position at
  a partner link it is part of that link's partner adapter; the request's waiting state
  and deadline are part of the request (the account owner). A separate "contention
  manager" would be a third writer between owners whose state it reads on every decision.
- *Funds holds are split from the ledger.* Holds are not money movements (the glossary's
  funds hold: "it is not a money movement"; POL-18), change on every booking, and gate
  admission at 99.99%; movements are conserved, immutable and 7-year idempotent.
  Different invariants, different write rates, different availability classes.
- *Rating is split from settlement*, at the charge (P3 ends at a charge, P4 starts from
  one): rating's correctness is per charge line, settlement's per party.
- *Attribution is split from ingestion*, because ingestion must acknowledge within 1 s at
  99.99% and must never depend on reservation or provisioning data being available;
  attribution can lag and catch up within `attribution_lag_max`.
- *Reporting owns no facts*, so its 30-minute RTO can be met by rebuilding from feeds.
- *History is a read model, not a writer.* Each owner's own log is the bitemporal record of
  its state; history archives and indexes it. This keeps POL-05's single writer intact.

### 3. Interaction overview

```mermaid
flowchart LR
  subgraph EXT["Outside parties"]
    BUY["Buyers, agents, suppliers"]
    OPR["Operators"]
    EXP["Exporters"]
    PAY["Payment providers and payment partner"]
    PTN["Partner systems"]
    NET["Network operations"]
  end

  subgraph EDGE["Edge"]
    GW["Edge gateway"]
    IAM["Identity and access"]
    CON["Operator console and approvals"]
  end

  subgraph ADM["Admission (99.99%, RTO 1 min)"]
    AO["Account owner (one per account): booking + funds and standing"]
    LO["Link schedule owners (one per link)"]
    PA["Partner adapters (one per partner link)"]
  end

  subgraph MET["Metering and rating"]
    MI["Metering ingestion"]
    AQ["Attribution and quarantine"]
    RA["Rating"]
    CAT["Catalogue"]
  end

  subgraph MON["Money"]
    ST["Settlement"]
    LE["Ledger"]
    PR["Payments, receivables, reconciliation"]
    PO["Payouts"]
  end

  subgraph REC["Records and operations"]
    RP["Reporting and statements"]
    HI["History"]
    AU["Audit"]
    NO["Notifier"]
    PB["Probes"]
  end

  BUY --> GW
  OPR --> CON
  GW --> IAM
  CON --> IAM
  GW --> AO
  GW --> RP
  AO --> LO
  AO --> PA
  PA --> PTN
  LO -.-> AO
  PA -.-> AO
  IAM -.-> AO
  CON --> AO
  CON --> LO
  CON --> AQ
  CON --> CAT
  CON --> PO
  CON --> PR
  EXP --> MI
  MI -.-> AQ
  AQ -.-> RA
  AO -.-> RA
  LO -.-> RA
  CAT -.-> RA
  RA -.-> AO
  RA -.-> ST
  ST --> LE
  PAY --> PR
  PR --> LE
  PR --> AO
  PO --> LE
  PO --> PAY
  LE -.-> AO
  LE -.-> RP
  LE -.-> PR
  AO -.-> NET
  LO -.-> NO
  AO -.-> NO
  NO -.-> BUY
  NO -.-> NET
  AO -.-> HI
  LO -.-> HI
  LE -.-> HI
  AO -.-> AU
  LO -.-> AU
  LE -.-> AU
  IAM -.-> AU
  CON -.-> AU
  PB --> GW
  PB --> MI
```

Solid arrows are synchronous requests; dashed arrows are asynchronous feeds from the
writer's log (at least once, ordered per partition, consumed idempotently).

| Interaction | Mode | Why |
|---|---|---|
| Edge → identity and access | Synchronous, from a local cache refreshed by push; cache entries for agent keys live at most 30 s | Authentication must be on every call (X1-N1) but cannot cost a remote call within 200 ms. A revocation reaches every edge within 60 s for new requests (X1-N3). |
| Edge → account owner leader | Synchronous, one forward; the edge answers `pending` if no final answer is ready in time for `ack_budget` | POL-04. The workflow runs at the account leader, so the edge makes one hop, not four (A0-05). |
| Account owner → link owners | Synchronous on the booking path (hold); asynchronous after the decision (convert, request-scoped release); each release is acknowledged once durable | The answer within `ack_budget` needs the hold; conversions can lag because the hold keeps counting; a non-confirmed outcome is reported only once every Share leg has acknowledged its release (A10). |
| Link owner or partner adapter → account owner (waiting notice, capacity released to a waiter, yield requested, affected reservation, revocation due, expire requested, release acknowledged) | Asynchronous notification or command, idempotent by (link, epoch, sequence) | The participant observes; the account owner decides (A9). A yield takes effect only once the account owner accepts it in its own order, so a hold is never yielded under a request that is already committing. |
| Account owner → partner adapter → partner | Asynchronous to the buyer (the buyer gets `pending`), synchronous within the request's own workflow | Partner calls are slow and unreliable (P2 C7); only the request's deadline bounds them (POL-26). |
| Identity and access → account owner (key revoked) | Asynchronous push, applied as an entry within 60 s of the administrator's action | Gives P2-S72 and P2-S103 one order (D6). |
| Ledger → account owner (balance through position); rating → account owner (unposted usage through position); payments → account owner (invoice overdue, invoices paid) | Asynchronous feeds, applied as log entries | Headroom is computed from inputs at recorded positions, so every shown figure is reproducible (P4-S72, A0-21). |
| Account owner → rating, history (reservation lifecycle); link owner → rating, notifier, history (capacity and affected flags) | Asynchronous feeds | Rating has 2 min per minute; affected notices have 60 s (POL-07); history and statements have minutes. |
| Rating → settlement → ledger | Asynchronous feed; posting is a synchronous call to the ledger from settlement, idempotent by source reference | A posting must be acknowledged durable before rating marks a line posted. |
| Payment notification → payments → ledger → account owner | Synchronous acknowledgement to the provider after 2-region durability; posting and headroom update asynchronous | X2-S14; top-up to credited headroom within 10 s at p99 (X2-N3). |
| Account owner → network operations (standing) | Asynchronous feed with per-account sequence numbers, plus a query | At least once, within `standing_notice_time` (10 s); repeats change nothing (P4-N6). |
| Operator console → owners | Synchronous command after authorisation (and approval where four eyes apply) | Each owner stays the only writer; the console only carries authorised intent (X1-N7). |

#### A route booking with a funds hold and a partner leg

Route over Share links L1, L2 and partner link P (a partner with holds under POL-26),
default deadline 30 s, so `commit_margin` = 10 s applies. `D` is the deadline; `τ` is the
confirm fence (§4.3), 200 ms with the current estimates.

```mermaid
sequenceDiagram
  autonumber
  participant Bu as Buyer
  participant Ed as Edge gateway
  participant Ao as Account owner (leader)
  participant L1 as Link owner L1
  participant L2 as Link owner L2
  participant PA as Partner adapter P
  participant Pa as Partner P
  participant No as Notifier

  Bu->>Ed: book route L1, L2, P (idempotency key, rate, window, deadline)
  Ed->>Ed: authenticate from cache, advisory rate check
  Ed->>Ao: forward once to the account leader
  Ao->>Ao: exact rate limits, dedupe by key and fingerprint, validate, fix D and age, check headroom, key headroom, in-flight, standing
  Ao->>Ao: entry 1, intake + funds hold, durable in two regions
  par capacity holds
    Ao->>L1: hold (account, request, rate, window, D, age)
    L1-->>Ao: held, durable in two regions
  and
    Ao->>L2: hold (account, request, rate, window, D, age)
    L2-->>Ao: held, durable in two regions
  and
    Ao->>PA: hold at partner, expires_at D
    PA->>Pa: hold (idempotent partner key, expiry D)
  end
  Ao-->>Ed: pending (intake is durable)
  Ed-->>Bu: pending, within ack_budget
  Pa-->>PA: held until D
  PA-->>Ao: held
  Note over Ao: committing begins no later than D minus commit_margin
  Ao->>Ao: checks standing, key, limits, withdrawal from its applied state, in its serial order (no log entry)
  Ao->>PA: confirm
  PA->>PA: journal the confirm with its send time, durable in two regions
  PA->>Pa: confirm (same partner key)
  Pa-->>PA: confirmed
  PA-->>Ao: confirmed
  Ao->>Ao: entry 2, confirm if undecided (timestamp before D minus tau, checks standing, key, withdrawal, no expiry), then the funds hold becomes the coverage hold
  par conversions, asynchronous and idempotent
    Ao--)L1: convert hold to reservation leg (decision timestamp)
    Ao--)L2: convert hold to reservation leg (decision timestamp)
  end
  Ao--)No: outcome confirmed, once entry 2 is at the report position
  No--)Bu: signed webhook, confirmed
```

Share's checks before the partner confirm are made from the account owner's applied state
and are **not a log entry** (A0R-14: the committing mark of revision 2 is dropped). They
are not a decision point. An event after them (a suspension, a revocation, a withdrawal)
still makes entry 2 end the request not confirmed, as POL-04 requires; the partner
booking is then cancelled at once at Share's cost (POL-28 as amended by RQ-2). The window
is one partner round trip. A new leader that resumes the request learns whether a confirm
is outstanding from the partner adapter's call journal, which is two-region durable and
records when the confirm was sent. Its **resume query is itself an entry in the adapter's
log, recording the new leader's term**, so the journal is complete once queried: the
adapter refuses, journals as refused and never sends a confirm or final booking that
carries a lower account-owner term than the highest it has recorded for the request, one
for a tombstoned request, or one arriving when its own clock is past `D − commit_margin`
less the partner-skew budget (R17). A partner booking it nonetheless finds for a
tombstoned request is cancelled at once at Share's cost (POL-28; V-03). The journaled send time is the request's "begin committing" time, which is therefore
never later than `D − commit_margin` (POL-26, P2-S109). The partner confirm thus has
`commit_margin − τ` (about 9.8 s) before the confirm fence (RQ-7, R2-D1).

#### The deadline path

```mermaid
sequenceDiagram
  autonumber
  participant Ao as Account owner (leader)
  participant L1 as Link owner L1
  participant PA as Partner adapter P
  participant Pa as Partner P
  participant No as Notifier

  Note over Ao: no confirm accepted from D minus tau on
  Note over Ao: at D minus epsilon minus delta_x by its own clock, no decision yet
  Ao->>Ao: expire if undecided (reason from the request's state), durable in two regions
  Note over Ao: the first of confirm and expire in log order wins, here expire wins
  Ao--)L1: outcome failed, request-scoped release
  L1->>L1: release entry and tombstone, capacity free by D
  L1--)Ao: release durable
  Ao--)PA: outcome failed, request-scoped release
  PA->>Pa: release (the partner hold also lapses at D by itself)
  Ao->>Ao: releases durable (every Share leg in the intake acknowledged), batched in a group commit
  Ao--)No: outcome failed as of D, once releases durable is at the report position
  Note over L1: if no outcome has reached L1 by D, L1 asks the account owner to expire the request, keeps the hold and alerts; the answer carries the committed outcome, confirmed (convert) or not (release), within release_grace
```

What changes on the other paths (each specified in RFC-002):

- **A leg does not fit on committed capacity** (L2 rejects): L2 records the refusal with a
  tombstone for the request, so the refusal is also L2's release acknowledgement; the
  account owner appends the ending entry *rejected*, with the blocking link and the route
  counter-offer (P2-N11), and sends request-scoped releases; the outcome is reported once
  the "releases durable" entry records L1's and L2's acknowledgements (§4.3). The partner
  release at P is sent at the same time but does not gate the report (RQ-6 concerns Share
  links; P's hold lapses at `D` in any case).
- **A leg is blocked only by capacity in flight**: the link owner queues the request as a
  waiter by age; the account owner marks the request *waiting* and tells every link owner
  and partner adapter where it holds capacity. A link owner whose older waiter is blocked
  by a younger request's hold, where that younger request is itself waiting, asks the
  younger request's account owner to yield; the account owner accepts in its own order
  only if the request is still waiting (not committing), and then the hold is released
  and the request keeps its age and its place (POL-02). Cycles of any length break without
  being detected. A holder that is not waiting is never pre-empted.
- **The partner refuses definitively** while another Share request holds, or has a
  final-only booking for an undecided request, overlapping capacity there: the partner
  adapter recognises Share's own position, queues the refused request in its waiter queue
  by `priority_rule`, and applies the same yield rule to Share's own partner holds. When
  the request ahead resolves (and, if not confirmed, Share's cancellation at the partner
  is done), it asks the partner again for its waiters strictly in priority order (POL-02,
  A0-04). It skips a waiter past its commit fence (`D − commit_margin`, from the waiter
  entry) or already ended by its account owner, because a re-ask is a partner hold that
  would block the next waiter until it is released or lapses (A0R-08). Re-asks are
  serialised per pair of conflicting windows, not per chain of overlapping windows, so
  one busy partner link is not serialised as a whole.
- **A partner without holds** (including one whose holds are too short or cannot take an
  expiry set by Share, POL-26, P2-S102) is booked last, after every other leg is held,
  after the funds hold and after Share's checks, at most one per route (POL-28). If
  the request then ends not confirmed, the adapter cancels it at once at Share's cost.
- **Withdrawal**: the account owner appends a withdrawing mark; the next deciding entry
  (normally at once) ends the request "withdrawn"; a partner booking already confirmed or
  final is cancelled at Share's cost (POL-08, RQ-2).
- **Single-link booking** (80% of the load): the same protocol with one participant and no
  partner: intake + funds hold, link hold, decision. If the decision is not at the report
  position in time for `ack_budget`, the edge answers `pending`, which is safe because the intake is
  already durable.

#### Latency budget

**Round-trip-time assumptions (all estimates, to be measured; R1).**

| Pair | RTT (estimate) |
|---|---|
| Two facilities ("zones") in one metro, Nairobi or Mombasa | 1 to 2 ms |
| R1 Nairobi ↔ R2 Mombasa (Share's own fibre) | about 10 ms |
| R1 Nairobi ↔ R3 Johannesburg (GCP `africa-south1`) | about 45 ms |
| R2 Mombasa ↔ R3 Johannesburg | about 50 ms |
| A probe (D2) or a buyer in the same metro ↔ that region's edge | up to 10 ms |
| Buyers elsewhere (Djibouti, Marseille) ↔ R1 or R2 | Not budgeted: `ack_budget` is measured at the system boundary (X2-N3) |

Each figure assumes the **go-live fibre condition** (A0R-05, R2-D2, recorded in RFC-006):
at least two Nairobi–Mombasa paths with no shared risk (no common duct, landing station or
right of way), and a Nairobi–Johannesburg and a Mombasa–Johannesburg path that each go
directly, not via the other Kenyan city, and share no risk with each other or with the
Nairobi–Mombasa paths. Without it, the subsea routes landing at Mombasa would put the
Nairobi–Mombasa fibre on Nairobi's path to Johannesburg too, and one cut could isolate R1
(§5.1).

**Two-region quorum write, five voters placed 2 (R1) + 2 (R2) + 1 (R3), majority 3,
group commit (estimates).** A commit needs the leader and the two fastest other voters.

| State | Who completes the majority (leader in R1 unless stated) | p50 | p99 |
|---|---|---|---|
| Steady state | R1 peer and the nearer R2 voter (one 10 ms round trip) | about 13 ms | about 25 ms |
| One Nairobi–Mombasa path cut (traffic on the diverse path, assumed up to about 15 ms) | As steady state | about 16 ms | about 30 ms |
| One facility lost in R1 (leader stays in R1, or moves to the R1 survivor) | Both R2 voters | about 13 ms | about 25 ms |
| One facility lost in R2 | R1 peer and the remaining R2 voter (R3 as the spare) | about 13 ms | about 30 ms |
| **R2 lost** (declared disaster; leader in R1) | R1 peer and **R3** (45 ms round trip) | about 50 ms | about 65 ms |
| **R1 lost** (declared disaster; leaders move to R2) | R2 peer and **R3** (50 ms round trip) | about 55 ms | about 70 ms |
| Either loss, after reconfiguration to **2 + 2** (§5.1; majority 3 of 4) | Surviving Kenyan peer and the nearer R3 voter | unchanged | unchanged |

R3 is never on the commit path while both Kenyan regions are up. Once either is lost,
every commit must reach R3: that is the price of keeping every fact durable in two
regions (RPO 0), and no placement avoids it (RQ-3).

**Leader placement.** All admission leaders (account owners, link owners, partner
adapters) are kept in one Kenyan region while it is healthy: **R1 by default, until the
spike (R1) measures each Kenyan region's RTT to R3, and then the nearer one** (R2-D7). The
preference rests on an assumed 5 ms difference (45 against 50 ms) and on Nairobi being
assumed the larger market; a measurement replaces both. Placement fails leaders over
**region-wide**, not per group, so a partial failure in R1 does not leave account and link
leaders in different regions (A0-05). RFC-006 specifies the region-wide failover (A0R-13):
the placement map on its own 2 + 2 + 1 log; the trigger (the leader region has lost quorum
in its own facilities, or its probes fail for a stated number of consecutive probes, or
an operator declares it); staggered elections, so thousands of groups do not elect at once;
and the expected time to move every leader after the lease waits, which must fit within
admission's 1 min RTO. The R1 spike tests it.

**Single-link booking, steady state, p99 (estimates; the sum of p99s, so conservative).**

| Step | Durability | p99 |
|---|---|---|
| Edge: TLS on a persistent connection, authentication from cache, advisory limits, routing | none | 10 ms |
| Hops in one region: edge → account leader → link leader → account leader → edge | — | 5 ms |
| Entry 1 at the account owner: exact rate limits, dedupe, headroom, key headroom, in-flight, standing; intake + funds hold | two regions | 27 ms |
| Capacity check (in-memory peak query) and hold at the link owner | two regions | 27 ms |
| Entry 2 at the account owner: confirm if undecided, binding the funds | two regions | 25 ms |
| Report position reaches entry 2: one majority round trip, and every leased status replica applied it (V-01, V-02); the edge answers final only then | — | 10 ms |
| **Total, edge in R1** | | **about 105 ms**, against 200 ms |

| Variant | Estimate (p99) |
|---|---|
| Edge in R2 (a Mombasa buyer, or the R2 probe), leaders in R1: one extra R2 ↔ R1 round trip | about 115 ms |
| Probe overhead (D2: within 10 ms of the region, persistent TLS) | + up to 10 ms, so about 115 to 125 ms measured |
| Leader drift in steady state (an account and a link leader in different regions, before placement corrects it): + 10 ms per crossing call | at worst about 135 ms |
| One facility lost in R1 or R2 | about 105 to 120 ms |
| Single-link **rejection** on committed capacity: the link's refusal entry carries the request's tombstone, so the ending entry also records the release as durable and no further entry is needed | about 105 ms, as a confirmation |
| Single-link request ended not confirmed after its hold (suspension, revocation, withdrawal): ending entry, request-scoped release at the link (hop + commit), "releases durable" entry, report position | about 95 + 5 + 27 + 25 + 10, so about 160 ms |
| Route booking, time to `pending` (edge, hop, entry 1, response) | about 45 ms steady; about 90 ms after a region loss |
| Route ended not confirmed, from its ending entry to the report: release at each held link (hop + commit, in parallel), "releases durable" entry, report position | about 70 ms steady; about 215 ms after a region loss; within `status_staleness` (1 s) |
| **R2 lost**, R1 serving: three commits at about 65 ms + 20 ms, plus the report position through R3 (about 65 ms) | **about 280 ms** (p50 about 220 ms) |
| **R1 lost**, R2 serving: three commits at about 70 ms + 20 ms, plus the report position (about 70 ms) | **about 300 ms** (p50 about 240 ms) |

The **report-position delay** is one majority round trip after the commit (the leader
learns that a majority knows the commit position, and leased replicas acknowledge applying
it, on the next heartbeat): about 10 ms steady, about 65 to 70 ms once a majority must
include R3 (est.). It is the price of "a reported outcome stays reported" (POL-04,
P2-S10, P2-S108) when the edge's own answer is a report. `pending` is not a report and
is not delayed.

In steady state the budget leaves about 95 ms of margin, more than the previous draft's
claim, because the Kenyan pair is closer (10 ms) and no write is made in one region only.
After a region loss a single-link booking's **final** answer misses 200 ms at p99; the
**acknowledgement** still fits, because the edge answers `pending` once entry 1 is durable
(about 90 ms) and the outcome follows by poll or webhook. POL-06 (RQ-3) suspends the
latency targets for the declared disaster; RPO 0 is kept. Reconfiguring to 2 + 2 (§5.1)
restores fault tolerance during the disaster but not latency. Two mitigations are open for
RFC-006: a parallel-commit fast path for single-link bookings in the degraded state (two
writes instead of three, about 10 + 5 + 2 × 65 + 65 (report position) = 210 ms at p99;
Competition, R13), the largest lever while a double Nairobi–Mombasa cut makes R1 commit
through R3 (§5.1), though with the report gate it no longer brings R1 under 200 ms on its
own, and RFC-006 evaluates it against that case too; and a
replacement site for the lost region, which ends the disaster as POL-06 defines it.

### 4. Consistency model

#### 4.1 Where atomicity is needed, and how it is achieved

| Unit that must be atomic | Mechanism | Owner RFC |
|---|---|---|
| **One decision on one link** (check the peak and record the hold or the confirmation) | A single entry in the link's log, applied by its single leader; no locks | RFC-001 |
| **One booking: every leg, the partner's included, and the funds hold, or none** (P2-N1, P2-N8) | A commit protocol whose **decision log is the account owner's log**. Participants prepare: the funds hold (in entry 1), capacity holds on Share links and partner holds with expiry `D`. The decision is one conditional entry in the account owner's log; conversions follow idempotently. Because the decision log is itself a two-region consensus log, a dead coordinator does not block: whoever leads the partition reads the decision and resumes. Partners cannot prepare in Share's sense, so a partner leg is confirmed after Share's own checks and **before** the decision (Share never confirms a leg the partner has not confirmed, P2-N7); any partner booking left without a Share confirmation is cancelled at once at Share's cost (POL-28, RQ-2). | RFC-002 |
| **Account-level admission** (headroom, key headroom, capacity in flight, rate limits, standing, key revocation, withdrawal, deadline; concurrent bookings by one account decided as if one at a time) | The account owner's serial order. The **decision entry is the single POL-04 decision point**: it checks all of these and binds the funds in the same entry. | RFC-002 (state machine and decision); RFC-004 Part A (funds and standing rules) |
| **One change to one reservation** (P2-N9) | The reservation's change queue in the account owner: changes applied in arrival order; a cancellation is never queued and fails a pending change; an extension or increase is a new admission of the difference through the same booking protocol | RFC-002 |
| **One money movement** (P4-N7) | One journal record holding all its entries, written to one ledger partition (its home's, §2), validated to sum to zero per currency before append. Double entry is atomic by construction, because a movement never spans partitions. A movement that carries many charge lines is balanced line by line, so dropping a line keeps it balanced (§4.4). | RFC-004 |
| **Posting a charge or amendment once** (P3-N2, P4-N15) | The ledger's append is conditional on each line's source reference being new; the deduplication state is in the same partition as the movement | RFC-004 |
| **Accepting a payment once** (P4-N1) | One payments partition per (provider, transaction reference): the first authenticated event binds the reference to its account in the same entry that records it; every later event for that reference is checked against the binding there (A0R-04) | RFC-004 |
| **Accepting a flow record once** (P3-N3) | The record-identity check and the append are one entry in the exporter's ingestion partition | RFC-003 |
| **An operator action and its audit record** (X1-N7, X1-N8) | The audit fields are part of the owner's own log entry for the change; there is no separate audit write to lose | RFC-005 |

Serialisability across links follows from the protocol's shape: a request takes all its
holds before its decision and keeps them until it (strict two-phase locking, with holds
as the locks and the priority rule as the conflict policy), so concurrent bookings end in
the state of some one-at-a-time order (P1-N2, P2-N9). A yield is the only early release,
and it is accepted only while the request is waiting, so it never removes a lock a
decision relies on (A9).

#### 4.2 Where eventual consistency is acceptable

| What lags | Bound | Why it is acceptable |
|---|---|---|
| Conversion of holds into reservation legs on link owners after the decision | Milliseconds; the hold keeps counting against capacity until converted | Capacity is counted either way; nothing can be sold in between. The conversion carries the decision's timestamp, so "known at T" is defined (§4.3). |
| Status reads behind the decision | `status_staleness` (1 s); up to `release_grace` while a link the request held fails over (P2-S107), or while its decision record is unavailable at its deadline; while the account partition fails over before the deadline, until it has a leader again, bounded by admission's 1 min RTO (RQ-12, P2-S111); never `pending` after a reported outcome (P2-S108) | POL-04 as amended by RQ-8, RQ-10 and RQ-12; §4.3, §4.6. |
| Rating and posting behind the reservation and traffic feeds | 2 min per minute (`max_lateness` + 2 min for traffic), 99.99% of minutes (X2-N3) | Funds holds already cover accrued-but-unposted charges (POL-18). |
| Accepted record reaching headroom | `attribution_lag_max` (10 s), 99.99% of minutes, with hot standbys (§2) | POL-14 now includes this lag in the lateness bound; later records are reported as breaches. |
| Supplier balances and Share's own balance | Aggregated at closed positions; closed per payout run and per reconciliation day | Payouts are weekly; reconciliation is daily (POL-22, POL-24). Share-only movements are homed by their causing buyer or spread over N Share sub-partitions (§2), so no partition is the hot row that Share's own account would otherwise be (A0R-09). |
| Statements, supplier views, history, audit store | Minutes | Reporting RTO is 30 min; none of them is a writer of facts. |
| Standing at network operations | `standing_notice_time` (10 s) | POL-06 splits the 60 s enforcement target. |
| Affected-reservation notices | `affected_notice_time` (60 s) | POL-07. |
| Agent-key revocation at the edge (new requests) and at the account owner (undecided requests) | 60 s | X1-N3, POL-25, D6. |

#### 4.3 Deadlines, expiry and the decision point

- **The deadline is data.** `D` and `request_age` are fixed in entry 1 (intake) and are
  part of every hold the request takes. A retry with the same key finds them there.
- **The confirm fence** (A0R-01, RQ-7, R2-D1). One fence for every request: a confirm
  entry carries its leader's timestamp from when it is appended, and the state machine
  accepts it only if that timestamp is earlier than `D − τ`, with
  **`τ = max(ack_budget, ε + δ_x)`**, 200 ms with the current estimates. The requirements
  (POL-26 as amended by RQ-7) count a confirmation only if its entry is timestamped before
  `D`, and require a request to **begin committing** no later than `D − commit_margin` with a
  partner leg and `D − ack_budget` without one. The design meets both: without a partner
  leg, committing is proposing the confirm entry, which the fence puts before
  `D − τ` ≤ `D − ack_budget`; with a partner leg, committing begins when the partner confirm
  is sent, which the partner adapter journals with its time, no later than
  `D − commit_margin`, and the confirm entry then still has `commit_margin − τ` (about
  9.8 s) for the partner's answer (P2-S109, P2-S110). The fence is stricter than the requirement by `τ` so
  that, under one leader, a confirm accepted by the guard always precedes the expiry entry
  in the log, and the expiry still has time to release every Share-link hold by `D`. The
  **decision point** of a request (POL-04) is its deciding entry, and its time is that
  entry's timestamp: a request is never decided confirmed after its deadline.
- **Expiry is a log entry, not a read** (A0-01). At `D − ε − δ_x` by its own clock, the
  account owner's leader appends a conditional **"expire if undecided"** entry. `ε` is the
  clock-uncertainty bound (about 40 ms at most, est.; R4). `δ_x` covers everything that
  must be durable by `D` for P2-S93: the expiry's commit, the notice to the link owner and
  the release's commit there, at p99 about 25 + 5 + 27 ≈ 60 ms steady and, in the worst
  degraded state (R1 lost, leaders in R2, both commits through R3),
  70 + 10 + 70 ≈ 150 ms (est., A0R-02, V-06). So `ε + δ_x` is about **190 ms** at worst,
  leaving 10 ms of margin to `τ` = 200 ms at p99. RFC-006 keeps
  **`ack_budget ≥ τ > ε + δ_x`** as a monitored invariant and **alarms** on it before that
  margin is used up; the fence already moves earlier by itself (if `ε` or `δ_x` grows, `τ`
  grows with it), never the release later. Any participant may also ask for the same entry (idempotent),
  and a link owner or partner adapter that has seen no outcome by `D` does so.
- **First in log wins.** The state machine keeps whichever deciding entry comes first in
  log order: confirm, expire, or an ending entry. Each is conditional ("if undecided"), so
  a later one changes nothing. No participant releases a hold until it learns of a
  committed non-confirmed outcome (A9). There is no read that could miss a decision still
  being replicated, so no hold is ever released under a confirmed reservation.
- **Releases are request-scoped, with tombstones** (A0R-03, R2-D5). The outcome notice to
  a link owner carries a release that ends every hold, waiter registration and grant the
  request has on that link, whatever the attempt. The link owner records, in the same
  entry, a **tombstone** for the request, kept until `D` + `release_grace`, and refuses any
  hold or grant for a tombstoned request or for one past its `D` by the link owner's clock
  (refusing is always safe: a request that cannot hold cannot confirm). A late or retried
  hold command, or a hold re-granted after a yield (attempt n + 1) that the account owner
  has not yet heard of, can therefore never outlive the outcome. A refusal on committed
  capacity records a tombstone too, so it doubles as that link's release. The link owner
  acknowledges a release once it is durable. Partner adapters keep the same rule for
  Share's own position at a partner link, and their tombstone also refuses a **confirm or
  final booking**, as do the adapter's own `D − commit_margin` clock check and its
  account-owner term check (§3, V-03).
- **"Releases durable", and when an outcome is reported** (A0R-02, RQ-6, RQ-8). The
  account owner collects release acknowledgements from **every Share leg in the intake**,
  not only from the legs it believes it holds, and records them in a **"releases durable"**
  entry, batched into its group commits. When every acknowledgement is already in hand
  as the ending entry is appended (the only leg refused, or the request ended at intake
  before any hold was sent), the ending entry records it itself. A non-confirmed outcome is
  **reported** (status reads, the outcome feed, webhooks) only once that entry is at the
  report position (§4.6), so no buyer or competitor sees an outcome while capacity is still
  held for it (POL-04, P2-S14). Normally that is about 70 ms after the decision (est.),
  well within `status_staleness`. While a link's schedule owner fails over, its release
  becomes durable once the link has a leader again, within seconds and at most
  `release_grace` after the decision, and the outcome is reported then (P2-S107); nobody can book
  that link meanwhile, so nothing is lost commercially (RQ-8). In the same way a release
  due at `D` is made within `release_grace` after `D` if the link's schedule is unavailable
  at `D`. A new account leader re-sends releases for every ending entry that has no
  "releases durable" entry yet. A partner release is sent at the same time but does not
  gate the report; the partner hold lapses at `D` by itself in any case (P2-S101).
- **An expiry request is answered with the outcome** (A0R-03). The answer to a
  participant's "expire if undecided" request carries the committed outcome, either way:
  *confirmed*, with its decision timestamp, and the link owner converts the hold; or not
  confirmed, and it releases.
- **When the decision record is unavailable at the deadline** (the account partition is
  electing a leader, or has lost quorum), no participant can learn the outcome, so every
  Share-link hold is kept, which is safe, and an alert is raised. The new leader's first
  entry is a **takeover** entry; it then appends the expiry for every request past its
  deadline, and holds are released within `release_grace` (1 min) after `D` (POL-26). An
  election takes seconds, so this bound is met with a wide margin; a partition without
  quorum for longer than 1 min has already missed admission's RTO. A confirm appended
  before `D − τ` whose leader failed before a majority stored it, and which the new leader
  carries, is kept, because the new leader cannot tell whether it was already committed
  and reported: the request is then **confirmed by a decision in time that becomes known
  after `D`**, at most `release_grace` after it, and status reads report `pending`
  meanwhile. POL-26 and POL-04 as amended by RQ-5 allow exactly this. The case needs a
  leader failure within about one commit before the fence with a confirm in flight.
- **Reasons** (A0-20). The expiry entry takes its reason from the request's state:
  "deadline passed while waiting" with its `retry_after` (taken from the waiting notice,
  which carries the deadline of the request ahead) if it was waiting; "interrupted by an
  internal failure" if a takeover entry occurred after its last progress and it could not
  be resumed in time (P2-S23); otherwise "deadline passed".
- **Non-confirmed outcomes before `D`** (rejected, withdrawn, key revoked, account
  suspended) are fixed by their ending entry, which is the decision point, and reported
  under the "releases durable" rule above.
- A request still undecided at `D` raises an operational alert (P2-N10, POL-26).

#### 4.4 Idempotency (POL-29)

| Input | Identity | Where it is checked | Retention |
|---|---|---|---|
| Booking request | (account, idempotency key); sameness = route, window, rate, product and `wait`, plus the principal; the deadline is not part of sameness | The account owner, in entry 1, **atomically with the request record and the funds hold**, before any capacity hold (A0-03). Two concurrent submissions with one key are ordered by the account log: the first creates the request; the other is the same request (and gets its answer) or is not accepted. A submission over a rate limit is not accepted and creates nothing (D5). | `idempotency_retention` 24 h |
| Internal command (hold, convert, release, release acknowledgement, yield request and acceptance, expire request, revoke, release after grace, move hold) | Derived from the request or reservation identity, the leg and the step (and an attempt number where a hold can be re-granted after a yield). A **release is request-scoped**: it carries no attempt number and ends every attempt; the tombstone it leaves refuses every later hold or grant for the request (§4.3) | The receiving owner's partition, in the same log entry as the effect | Life of the request or reservation, plus 24 h; tombstones until `D` + `release_grace` |
| Partner call | Partner key derived from the request, leg and operation | The partner (P2 C7), and the adapter's call journal | 7 years with the partner booking record |
| Flow record | (exporter, exporter epoch, sequence number); the epoch distinguishes counter restarts (P3 open question 1, decided in RFC-003) | Ingestion partition of the exporter, as run-length range sets per (exporter, epoch): mostly contiguous sequences make the index the size of its gaps, not of the 7-year record count (about 6×10¹³) | 7 years |
| Charge, amendment and fee lines | (reservation or usage key, minute, amendment sequence) | Ledger partition, as a watermark per reservation and product ("posted through minute m") plus an exception set for amendments and late lines, not a hash index over about 2×10¹⁴ line references (A0-08). Deduplication is **per line, not per movement** (A0R-10): in a movement carrying many lines, a line already posted with the same contents is dropped; a line whose contents differ from what was posted is excluded and reported; the remaining lines are posted. Each line is balanced on its own, so the movement stays balanced. A settlement batch re-composed after a crash is therefore neither refused nor double-posted | 7 years |
| Payment events (top-up, invoice payment, reversal) | (provider, transaction reference, event kind); a reversal shares its payment's transaction reference | The payments partition of (provider, transaction reference) (A0R-04, R2-D6). The first authenticated **and well-formed** event **binds the reference to its account** (a malformed one is recorded and rejected, creating no binding, P4-S05; V-05); the posting carries that binding, so the ledger's home for the movement follows from the reference. A later event for the reference whose contents differ (another account reference, amount or currency) moves nothing and is reported (P4-N1); a different principal is refused. Orphan reversals (72 h) are matched in the same partition | 7 years |
| Invoice payment as applied to an invoice; write-off | The payment's (provider, transaction reference) for an invoice payment; the write-off's own reference | The account's receivables partition (V-04), fed idempotently from the payments partition | 7 years |
| Transfer confirmation or failure (payouts) | The payout instruction reference, with the provider's transaction reference recorded | Payouts, the only writer, in the supplier's partition (V-04; P4-S87, P4-S95) | 7 years |
| Reconciliation run | The day reconciled | The run's partition, by day (V-04) | 7 years |
| Other money-moving inputs (payout instruction, operator correction or attribution, escalation resolution, write-off posting, Share-borne cost, supplier debt, movement of Share's own funds) | Its source reference, generated inside Share and unique by construction | Ledger partition of the movement's home, atomically with the movement; a redelivery with different contents moves nothing and is reported; a different principal is refused | 7 years |
| Feed events between components | (producer partition, epoch, sequence) | Each consumer's own state | Until consumed and checkpointed |

#### 4.5 Ordering

| Scope | Order | Source |
|---|---|---|
| One link | Total order of every schedule change, waiter registration and yield (the link log) | P1-N2, POL-05 |
| One account | Total order of intakes, holds, marks, deciding entries, rate counts, key revocations, credit limits, feed positions applied and standing changes | P2-N8, P4-N3, POL-04, POL-25 |
| One request | The first deciding entry in the account log wins; the outcome never changes once reported | P2-N2, POL-04 |
| One reservation | Changes in arrival order; cancellation first | P2-N9, POL-08 |
| Waiters on one Share link | Priority rule (`request_age`: the intake entry's timestamp, ties by request identity) | POL-02 |
| Share's waiters at one partner link | The same priority rule, kept by the partner adapter; re-asks serialised per pair of conflicting windows, skipping waiters past their commit fence or already ended (A0R-08) | POL-02 |
| One charge line | Amendments in sequence; each is the new total rounded once less what was posted, so the result does not depend on arrival order | P3-N3, P3-N8, P4-N9 |
| One account's standing feed | Sequence numbers; a consumer applies the latest | P4-N6 |
| Across ledger partitions | Closed positions only: each partition commits "closed through T", after which no entry with a posting time at or before T is appended; reconciliation for day D and each payout run read every partition at its closed T. **Posting time is monotone across leader changes** (A0R-10): every entry's posting time is `max(leader clock, previous entry's posting time, last closed T + 1 µs)`, all read from the log, so a new leader with a slower clock cannot append at or before a closed T | P4-N14, POL-22, POL-24 |
| Globally | **None needed.** No requirement orders events across links, accounts or exporters, so there is no global sequencer | — |

#### 4.6 Status reads and headroom reads

- **Status reads** (polls, retries with a key) are served by replicas of the account
  owner's log, never through the leader's write path. The leader publishes two positions,
  piggybacked on its heartbeats: a **closed position** every 200 ms or so (everything up to
  it has been applied as of a stated time), and a **report position**. Status replicas hold
  **read leases** from the leader, renewed on heartbeats and lasting at most
  `status_staleness` − ε (V-01). The leader advances the report position to P only once a
  majority of voters knows P is committed **and** every replica with a live read lease has
  acknowledged applying the log through P (or its lease has expired). That costs one
  majority round trip after the commit: about 10 ms steady, about 65 to 70 ms with a region
  lost (est., V-02); a slow replica delays a report by at most its lease. An outcome is
  **reported**, by the edge's synchronous final answer, a replica, the outcome feed or the
  notifier, only once its deciding entry, and for a non-confirmed outcome its "releases
  durable" entry, is at or below the report position. So every replica that may answer
  `pending` from freshness already has it, and because a majority of voters knows such a
  position is committed, every later majority holds a voter that knows it: a reported
  outcome can always be found again (P2-S10, P2-S108).
- **Replica rule** (A0R-06, R2-D4). For a given request, a replica answers:
  1. if it has applied a reported outcome: that outcome, however stale the replica is (a
     reported outcome is final, P2-S10);
  2. otherwise, if it holds a **live read lease**: `pending` (the lease guarantees it has
     applied every reported position, and that it is within `status_staleness` of the
     leader);
  3. otherwise, if it has checked with a majority of voters that **no leader holds the
     lease**: it reads their highest known committed positions, applies the log through
     the highest, and answers as in rule 1 if it now finds a reported outcome, otherwise
     `pending`. This is the POL-04 exception (the decision record unavailable, at the
     deadline at most `release_grace` after it, before it until the partition has a
     leader again, RQ-12). It **never applies to an outcome already reported** (RQ-10):
     such an outcome is always found in this step;
  4. otherwise (it cannot reach a majority, or a leader holds the leadership lease but the
     replica holds no read lease): it refuses with a retry, and the client's retry reaches
     another replica.

  Rule 3's lease check keeps a replica that is merely cut off from a healthy leader from
  answering `pending` for longer than `status_staleness`. A replica reports *failed as of
  D* only once a committed expiry or ending entry, and its "releases durable" entry, are
  reported, never from the clock alone (P2-S99, P2-S10, P2-S103, P2-S106, P2-S108). Before
  `D`, rule 3 also answers `pending` while the record is unavailable, as POL-04 now allows
  (RQ-12, P2-S111).
- **Headroom answers** are computed at one recorded account-log position. Because the
  ledger balance (through a ledger position), unposted usage (through a rating position),
  holds and limits all enter the account owner's log, the state at that position is the
  whole input. Every headroom answer carries its position, and an answer that gates a
  decision is evaluated inside the deciding entry, so any past headroom can be rebuilt
  exactly as shown (P4-S72, A0-21). With the home-account rule (§2) a buyer's ledger
  balance is the balance of one partition, so it is exact, not an estimate.

### 5. Deployment and durability topology

#### 5.1 Regions, zones and voters

```mermaid
flowchart LR
  subgraph R1["R1 Nairobi, Share data centres (serving)"]
    R1a["Facility A: voter, edge, workers"]
    R1b["Facility B: voter, edge, workers"]
  end
  subgraph R2["R2 Mombasa, Share data centres (serving)"]
    R2a["Facility A: voter, edge, workers"]
    R2b["Facility B: voter, edge, workers"]
  end
  subgraph R3["R3 GCP africa-south1, Johannesburg (voter only)"]
    R3a["One voter per group, zones spread across groups; a second one per group during a declared disaster (2 + 2)"]
  end
  R1 ---|"path A, about 10 ms RTT, est."| R2
  R1 ---|"path B, diverse from A"| R2
  R1 ---|"direct, not via Mombasa, about 45 ms RTT, est."| R3
  R2 ---|"direct, not via Nairobi, about 50 ms RTT, est."| R3
```

The four fibre paths share no risk with each other (no common duct, landing station or
right of way). That is a **go-live condition**, verified by Share's network team and
recorded in RFC-006 (A0R-05, R2-D2); the cut analysis below depends on it.

- **Regions.** R1 Nairobi and R2 Mombasa are Share's own data centres and are the serving
  regions (POL-06): their edges answer buyers, suppliers, exporters and payment
  providers. R3, Google Cloud `africa-south1` (Johannesburg), keeps voters only, has no
  edge and so no targets of its own. The three are in different metros and, for R3, a
  different operator, so no single disaster loses two of them.
- **Zones.** Within R1 and R2, a zone is one of Share's independent facilities (own power
  and fibre entry) in the metro. The design assumes **at least two facilities per Kenyan
  metro** (Share reports 10 data centres); this is to be confirmed (R2). R3 uses Google's
  zones.
- **Voters.** Every replicated log (link, account, partner-adapter, ingestion, ledger,
  approvals) has five voters: two in R1 (different facilities), two in R2 (different
  facilities), one in R3. No region holds three voters, so **every majority spans at
  least two regions**: a commit is, by construction, durable in two regions (A3, X2-N4).
  Ingestion may instead use three voters, one per region (RFC-003 and RFC-006 decide;
  Competition), since its 1 s budget absorbs a commit through R3.
- **Reconfiguration during a declared region disaster** (A0R-12, R2-D3). When the loss
  of R1 or R2 is declared, only 3 of 5 voters survive, so every commit needs all of them
  and one more node, facility or R3-zone fault would stop every write. Placement then
  reconfigures each group to **2 + 2**: the surviving Kenyan region's two voters and two
  R3 voters in different GCP zones. A
  majority, 3 of 4, still spans two regions (it always includes an R3 voter and a Kenyan
  one), one further fault is tolerated, and commit latency is unchanged (leader, Kenyan
  peer, nearer R3 voter). The change reverts to 2 + 2 + 1 when the lost region is
  restored. No third site is needed; the cost is one extra R3 voter per group while the
  disaster lasts. **The change is made one voter at a time** (V-07), never as a one-step
  switch, whose old and new majorities could be disjoint ({B1, B2, C1} and {A1, A2, C2})
  and unsafe if the declared-lost region is only isolated. With A the surviving region,
  B the lost one and C the R3 voters: (1) add C2 as a non-voting learner until it has
  caught up; (2) promote C2 to voter (6 voters, majority 4); (3) remove B1 (5 voters,
  majority 3); (4) remove B2 (4 voters, majority 3). Each step is one committed
  configuration entry whose majority overlaps the previous one's. Restoration reverses it
  the same way (add B1 and B2 as learners, promote them one at a time, then remove C2).
  Joint consensus is an equivalent alternative; RFC-006 picks one. Until step 3 commits,
  all three survivors are needed for every commit, so the change starts immediately on
  declaration, the placement log first, then every group in a staggered order.
- **Leaders** of the admission tier are all in one Kenyan region while it is healthy
  (R1 until measured otherwise, R2-D7), failed over region by region (§3). Stateless services (edge, workflow workers co-located with account
  leaders, rating and settlement workers and their hot standbys) run in both facilities
  of R1 and R2. Each region's edge answers its own probes; writes go to the leader.
- **Probes** (D2) run from colocation sites within about 10 ms of each serving region,
  outside Share's facilities, over persistent TLS connections, as the designated probe
  account, which books on a credit limit set by finance (D3, POL-06). The 200 ms limit is
  measured end to end from the probe.

| Failure | What happens | Effect on acknowledged facts | Effect on latency (single-link, p99, est.) |
|---|---|---|---|
| A node | Leader moves within its group in seconds | None (RPO 0) | None after the move |
| A facility (zone) | At most one voter per group lost; groups keep quorum; leaders on that facility move within R1 (or region-wide to R2 if R1 can no longer lead) | None | About 105 to 120 ms |
| Region R2 (declared disaster) | Groups keep quorum with R1 + R1 + R3; R1 serves alone; on declaration each group is reconfigured to 2 + 2 (R1 + R1 + R3 + R3), so one further fault is tolerated | None | About 280 ms; `pending` within about 90 ms; targets suspended (RQ-3) |
| Region R1 (declared disaster) | Groups keep quorum with R2 + R2 + R3; all leaders move to R2 automatically, region-wide; R2 serves alone; then 2 + 2 as above | None; admission back within minutes, inside the 1 h target | About 300 ms; `pending` within about 90 ms; targets suspended (RQ-3) |
| Region R3 | Groups keep quorum with R1 and R2 | None | None |
| One Nairobi–Mombasa path | Traffic moves to the diverse path | None | About 105 to 115 ms (the other path may be longer) |
| The R1 ↔ R3 or R2 ↔ R3 path | R3 is not on the commit path while both Kenyan regions are up; groups lose their spare voter for the cut's duration | None | None |
| **Both** Nairobi–Mombasa paths, both regions up (two independent cuts) | Leaders in R1 keep quorum through R1 peer + R3 (commits about 65 ms); R2's edge reaches the leaders only through R3 | None | R1 final answers about 280 ms (p50 about 220 ms), so the edge answers `pending` within the budget but final answers miss 200 ms; R2 unavailable. Not a declared disaster: it counts against availability (POL-06, R2-D2). The degraded two-write single-link path (R13, about 210 ms with the report gate) is the largest lever. With the go-live condition this needs two independent cuts |
| **R1 isolated** (every path from R1 cut, or Nairobi's metro fibre lost; at least three independent cuts under the go-live condition) | R1 keeps 2 of 5 voters and loses quorum; leaders move region-wide to R2 (R2 + R2 + R3); R1's edge is down | None | R1 unavailable; R2 final answers about 300 ms (p50 about 240 ms). It counts against availability unless an operator declares the loss of R1 (POL-06), after which it is handled as that row |
| **R2 isolated** | Leaders in R1 keep quorum with R1 + R1 + R3; R2's edge is down | None | R1 final answers about 280 ms; R2 unavailable; counts against availability unless declared |

#### 5.2 Single writer per partition, across failures (fencing)

- The link owner for a link **is** the leader of that link's partition; the account owner
  for an account is the leader of that account's partition. Each is the only process that
  can append to its log, and every entry carries the group's term.
- Leadership is held under a lease shorter than the election timeout, so a deposed leader
  stops deciding before a new one can start.
- Every command to an owner carries the partition epoch it was routed with; a command
  routed with a stale epoch is refused and re-routed. Every notification from an owner
  carries (partition, term, sequence); consumers ignore anything older than what they
  applied.
- Moving a partition to another group (rebalancing a hot link) is a handoff through the
  placement map with an epoch increment: the old group appends a final *moved* entry and
  refuses further commands.
- The same mechanism fences every owner partition (link, account, partner link, exporter,
  ledger), so no state has two writers at any moment.

#### 5.3 What is durable where

| State | Durability before it is acknowledged or acted on | After a region loss |
|---|---|---|
| Every owner's log: confirmed reservations, schedule changes, capacity holds, request tombstones, waiter entries, requests and their marks, decisions and "releases durable" entries, funds and credit holds, key spending, capacity in flight, standing, credit limits, invoices, partner holds and bookings, payout instructions and confirmations, pending approvals | Two regions | Itself; nothing is rebuilt |
| Ledger movements, payment events, accepted flow records | Two regions (X2-N4) | Itself |
| Sealed log segments older than the live tail | Object storage replicated in two regions (A0-16) | Itself |
| Advisory edge counters, caches, read models | None or local | Reset or rebuilt from feeds |

The previous draft's one-region account partition, and its rebuild after a region loss,
are removed (A0-02).

#### 5.4 Recovery targets per capability

| Capability (POL-06) | Components | Availability | RTO node or zone | RTO region | How it is met |
|---|---|---|---|---|---|
| Admission (including the funds holds and headroom checks a booking needs) | Edge, identity and access (cache), account owners, link owners, partner adapters | 99.99% | 1 min | 1 h (designed for minutes) | Leader election within seconds; requests, holds and decisions are in the log; a new account leader resumes every workflow (POL-03) |
| Usage ingestion | Edge for exporters, metering ingestion | 99.99% | 1 min | 1 h | Same log topology; exporters retry; acknowledgement only after two-region durability |
| Rating and posting | Attribution, rating, settlement, ledger | Judged by timeliness | Designed for about 30 s (hot standbys); 5 min ceiling | 1 h | Hot standbys over checkpoints on the unposted-usage and reservation-accrual paths, so X2-S13 and X2-S22 keep their per-minute budgets (A0-07) |
| Wallet (other operations) | Account owner replicas (balance and headroom answers), payments, ledger reads | 99.9% | 5 min | 1 h | As admission |
| Payouts | Payouts, ledger | 99.9% | 15 min | 1 h | Instructions are facts; a restarted run resumes by reference and never re-instructs |
| Reporting and statements | Reporting, history | 99.9% | 30 min | 1 h | Read models rebuilt from feeds and history |

Probes (X2-N1) run as the designated probe account on probe links and probe exporters in
every serving region, through the real path; every consumer that would rate, settle,
report to suppliers or report quarantine checks the probe designation from the catalogue
and identity and access, and excludes it (POL-06).

### 6. Partitioning and sizing for the design load

All volumes are estimates from POL-06's provisional design load and the assumptions
stated; RFC-006 replaces them with measurements.

| Load | Partitioning | Sizing note |
|---|---|---|
| 25,000 booking requests/s | Account owners by account; link owners by link | `account_rate_limit` (200/s) bounds any account partition. Each request writes 2 entries to its account log (intake, deciding entry), with or without a partner leg (the committing mark is dropped, A0R-14), plus waiting marks, plus a share of a batched "releases durable" entry when it ends not confirmed after taking a hold |
| 2,500 requests/s on the hottest link | That link's group alone; one leader, group commit about every 5 ms | At least 2 link-log entries per request (hold, then convert or release; a refusal is one entry that also records the tombstone), plus waiter and yield entries: at least 5,000 entries/s, about 25 to 40 per group commit. A hold lives from its own commit to the conversion, about 75 ms, so about 190 holds are in flight at once. Tombstones live until `D` + `release_grace`: at most about 750 releases and refusals a second (30% of 2,500/s, est.) × (60 s + 60 s) ≈ 90,000 small entries in memory on the hottest link, a few MB (R2-D5). A request on that link sees capacity in flight, and may get `pending` instead of a final answer, only when the link's free capacity is below those holds' Mbps; RFC-001 measures the share (A0-19) |
| Status polls | Served by account-log replicas at closed positions (§4.6) | Requests that end `pending` (routes, about 5,000/s, plus contended single-link ones) polled about once a second for a few seconds: about 25,000 to 70,000 polls/s; sized for 100,000/s. `key_poll_limit` bounds any one key. Polls never touch the leader's log |
| 260,000 records/s (600,000/s peak) | Ingestion by exporter; attribution and rating by account | Records accepted in batches; one two-region commit per batch. 7 years at about 100 B a record is about 5.7 PB of raw records; sealed segments are kept twice (two regions), not five times (A0-16) |
| Reservation charge lines | Rating, settlement and ledger by buyer account | 70% of 25,000/s fit, so about 17,500 confirmed/s; with an **assumed** mean reservation of 1 h, about 63 M reservations are active and about **1 M reservation lines/s** are rated (more than the flow-record peak). Settlement posts **one movement per account and minute** carrying all that account's lines, each line keeping its own source reference: at an assumed 100,000 active buyer accounts, about 1,700 movements/s. Deduplication by watermark per reservation (§4.4), about 63 M live watermarks rather than 2×10¹⁴ references (A0-08) |
| 1,000 payment notifications/s | Payments by (provider, transaction reference) (A0R-04) | Spreads evenly by construction; locality by account is not needed by any operation. Reference bindings are kept for 7 years, about 2×10¹¹ (est.), as the source-reference index |
| Ledger journal storage, 7 years (A0R-11) | Sealed segments per ledger partition | About 1 M lines/s for 7 years is about 2.2×10¹⁴ lines: about 22 PB per copy at 100 B a line (est.), four times the raw flow records. The design keeps per-party totals in each movement and the lines in **sealed columnar segments** ordered by reservation and minute (reservation, minute and amount, delta-encoded; about 10 B a line, so about 2.2 PB per copy, 4.4 PB in two regions, est.), which still answer P4-N16 (trace and rebuild) and P3-N9 (reproduce a charge) by reservation and minute. Only the live tail is on five voters. RFC-004 confirms the encoding and the access paths |

### 7. Allocation of needs

Every need is allocated to the component or components that own it and to the detailed RFC
that will specify it. "Also" names RFCs that specify a contract the need depends on.
"Account owner (booking)" and "account owner (funds)" are the two modules of the one
account owner (§2).

| Need | Owning component(s) | Specified in |
|---|---|---|
| P1-N1 Never oversold | Link schedule owner | RFC-001; also RFC-002 (only the account owner ends a hold), RFC-006 (single writer across failures) |
| P1-N2 Requests that fit are confirmed | Link schedule owner | RFC-001 |
| P1-N3 One schedule per link; holds; waiting | Link schedule owner, account owner (booking) | RFC-001; also RFC-002 (waiting and yield protocol) |
| P1-N4 Rejections actionable and discreet | Link schedule owner | RFC-001 |
| P1-N5 Malformed requests are errors | Account owner (booking: intake), link schedule owner (window and horizon rules) | RFC-001 (validity rules); also RFC-002 (intake) |
| P1-N6 Open-ended and long reservations | Link schedule owner | RFC-001 |
| P1-N7 Only facts recorded | Link schedule owner | RFC-001 |
| P1-N8 Loss of supply never revokes silently | Link schedule owner (affected flags, move holds for firm offers); account owner (booking: offers, moves, revocations of the route-level reservation, partner-leg affected status); notifier | RFC-001; also RFC-002, RFC-006 (notices) |
| P1-N9 Decisions explained after the fact | Link schedule owner (bitemporal log, conversions carrying the decision time); history | RFC-001; also RFC-006 (retention) |
| P2-N1 All or nothing | Account owner (booking), partner adapters | RFC-002 |
| P2-N2 Fast, uniform answer | Edge gateway, account owner (booking; status reads from replicas by the replica rule, outcomes reported at the report position), notifier | RFC-002; also RFC-005 (webhook signing), RFC-006 (delivery, closed and report positions) |
| P2-N3 Bounded wait | Account owner (booking: confirm fence, expiry entries, decision point, "releases durable" entries), link schedule owner (request-scoped release, tombstones, release acknowledgement), partner adapters (hold expiry at `D`, tombstones) | RFC-002; also RFC-001 |
| P2-N4 Fair contention | Account owner (booking: yield acceptance), link schedule owner (waiter queues), partner adapters (waiter queues and yields at partners) | RFC-002; also RFC-001 |
| P2-N5 Recovery from Share's own faults | Account owner (booking: takeover and resumption) | RFC-002; also RFC-006 |
| P2-N6 Retries never book twice | Account owner (booking) | RFC-002; also RFC-005 (scope) |
| P2-N7 Partners booked safely | Partner adapters, account owner (booking) | RFC-002 |
| P2-N8 Funds and limits at admission | Account owner (booking and funds: holds, key headroom, in-flight, exact rate limits), edge gateway (advisory limits) | RFC-002; also RFC-004 (funds rules), RFC-005 (key limits) |
| P2-N9 Changed or ended as one unit | Account owner (booking) | RFC-002; also RFC-001, RFC-004 |
| P2-N10 Operations see requests in trouble | Account owner (booking), operator console | RFC-002; also RFC-006 (alerting) |
| P2-N11 Route counter-offer | Account owner (booking), link schedule owner | RFC-002; also RFC-001 |
| P3-N1 Reservations accrue what was sold | Rating | RFC-003 |
| P3-N2 Each charge line charged once | Rating, ledger | RFC-003; also RFC-004 |
| P3-N3 Traffic counted exactly once | Metering ingestion, rating | RFC-003 |
| P3-N4 Traffic in well-defined minutes | Attribution and quarantine | RFC-003 |
| P3-N5 Priced as it happened | Rating, catalogue | RFC-003 |
| P3-N6 Each kind of traffic by its rule | Attribution and quarantine, rating, settlement (carried excess) | RFC-003; also RFC-004 |
| P3-N7 No record silently discarded | Metering ingestion | RFC-003 |
| P3-N8 Amended, never rewritten | Rating, catalogue (price corrections), ledger | RFC-003; also RFC-004 |
| P3-N9 Every charge reproducible | Rating | RFC-003; also RFC-006 (inputs retained) |
| P3-N10 Usage exposure visible | Rating (unposted usage within `attribution_lag_max`, hot standby), account owner (funds) | RFC-003; also RFC-004 |
| P3-N11 Metered traffic is evidence | Metering ingestion, history | RFC-003; also RFC-006 |
| P3-N12 Partner fees by rule | Rating, account owner (booking: fee shown, who ended) | RFC-003; also RFC-002 |
| P3-N13 Billed once per route at egress | Attribution and quarantine | RFC-003 |
| P4-N1 Top-up exactly once | Payments, receivables and reconciliation (partitioned by provider and transaction reference, reference bound to its account); ledger | RFC-004 |
| P4-N2 Converted at the shown rate | Payments, receivables and reconciliation | RFC-004 |
| P4-N3 Funds held for the coverage window | Account owner (funds) | RFC-004 |
| P4-N4 Headroom itemised | Account owner (funds), ledger, rating | RFC-004 |
| P4-N5 Suspension predictable and reversible | Account owner (funds: standing; booking: release after grace), notifier | RFC-004; also RFC-002 |
| P4-N6 Network operations knows standing | Account owner (funds) | RFC-004 |
| P4-N7 Money conserved, history fixed | Ledger | RFC-004 |
| P4-N8 Split exactly and fairly | Settlement | RFC-004 |
| P4-N9 Late charges settle like on-time ones | Settlement, rating | RFC-004; also RFC-003 |
| P4-N10 Statements checkable | Reporting and statements | RFC-004; also RFC-005 (visibility) |
| P4-N11 Supplier earnings final | Settlement | RFC-004 |
| P4-N12 Payouts weekly, exact, once | Payouts | RFC-004 |
| P4-N13 Reversals and bad debt by rule | Payments, receivables and reconciliation; account owner (funds) | RFC-004 |
| P4-N14 Books reconcile with the money | Payments, receivables and reconciliation (at closed positions, with incoming payments received by the partner and not yet posted, RQ-11); ledger (monotone posting time) | RFC-004; also RFC-006 (closed-position convention) |
| P4-N15 Every money-moving input once | Ledger | RFC-004 |
| P4-N16 Traced, and the past rebuilt | Ledger, account owner (funds: headroom at recorded positions), history | RFC-004; also RFC-006 |
| P4-N17 Credit only to vetted accounts | Account owner (funds: credit limit and credit holds), payments and receivables (invoices), identity and access (finance role, KYB status) | RFC-004; also RFC-005 |
| X1-N1 Authenticated principal | Edge gateway, identity and access | RFC-005 |
| X1-N2 Accounts isolated | Identity and access; every owner (tenant scoping); reporting (supplier view); notifier (webhook endpoints) | RFC-005 |
| X1-N3 Agent keys in scope; revocation | Identity and access, edge gateway, account owner (applies revocation; undecided requests fail) | RFC-005; also RFC-002 |
| X1-N4 Idempotency keys scoped to the account | Account owner (booking) | RFC-005; also RFC-002 |
| X1-N5 Only authentic payment notifications | Payments, receivables and reconciliation | RFC-005; also RFC-004 |
| X1-N6 Webhooks verifiable | Notifier, identity and access (signing keys) | RFC-005 |
| X1-N7 Operator power controlled | Operator console and approvals (two-region approvals), identity and access | RFC-005 |
| X1-N8 Every change attributable | Audit (including refused privileged attempts); every owner's log | RFC-005; also RFC-006 (retention) |
| X1-N9 Only an administrator manages keys | Identity and access | RFC-005 |
| X1-N10 Only the link's supplier changes what it sells | Identity and access, link schedule owner | RFC-005; also RFC-001 |
| X2-N1 Availability per capability | Probes; every capability's topology, including the go-live fibre condition (§5.1) | RFC-006 |
| X2-N2 Design load | Every owner's partitioning and sizing (§6) | RFC-006; also RFC-001 … RFC-004 |
| X2-N3 Latency per operation | Admission path (account owner, link owners); rating (hot standbys); payments | RFC-006 (budgets, RTT matrix); also RFC-001, RFC-002, RFC-003, RFC-004 |
| X2-N4 No loss of recorded facts | Replicated logs (§5), including the 2 + 2 reconfiguration during a declared region disaster | RFC-006 |
| X2-N5 Recovery time | Every owner; placement (region-wide failover: trigger, staggered elections, time to move every leader) | RFC-006 |
| X2-N6 Retention | History, ledger, metering ingestion | RFC-006 |

**Coverage:** 9 (P1) + 11 (P2) + 13 (P3) + 17 (P4) + 10 (X1) + 6 (X2) = 66 needs, every one
allocated to at least one owning component and exactly one primary detailed RFC.

**The RFC split.** One detailed RFC per problem is kept, because each problem's needs fall
almost entirely to its own components, and cross-RFC dependencies are carried by the
contracts in §8.

| RFC | Title | Components it specifies |
|---|---|---|
| RFC-001 | Link schedule and admission (P1) | Link schedule owner; the link part of the catalogue |
| RFC-002 | Account owner and booking coordination (P2) | The account owner's state machine, log and entry kinds (intake, marks, deciding entries, "releases durable", takeover), its booking module and workflow; the status replica rule; partner adapters |
| RFC-003 | Rating and metering (P3) | Metering ingestion; attribution and quarantine; rating; catalogue (prices, corrections) |
| RFC-004 | Wallet, ledger and settlement (P4) | Part A: the account owner's funds-and-standing module (hold sizing, headroom, key headroom, in-flight, standing transitions), as deterministic rules the account owner's entries evaluate. Part B: ledger; settlement; payments, receivables and reconciliation; payouts; reporting and statements |
| RFC-005 | Security and tenancy (X1) | Edge gateway; identity and access; operator console and approvals; audit; webhook signing |
| RFC-006 | Availability, durability and operations (X2) | Replicated-log topology, regions and voters, placement and fencing, closed positions, time; history; notifier; probes; alerting |

Three adjustments, and why:

- **The account owner is one component specified by two RFCs**, with a strict division:
  RFC-002 owns the state machine (its log, its entry kinds, the decision entry and the
  workflow), RFC-004 Part A owns the funds-and-standing rules that those entries apply.
  The rules are a deterministic module with its own invariants (P4-N3 … P4-N6) and no
  writer of its own. RFC-002 and RFC-004 Part A are reviewed and approved together.
- **RFC-004 stays one RFC**, although it is the largest. Its invariants are one argument:
  headroom is computed from the ledger balance and the holds; every money input is
  idempotent by one source-reference regime; reconciliation proves the whole.
- **The catalogue is specified in RFC-003, with its link part in RFC-001**, because rating
  is the component whose correctness depends on price history and corrections (P3-N5,
  P3-N8), while the link registry is what the link owner validates against.

### 8. Cross-RFC contracts

Names and owners only; each detailed RFC defines the semantics of the contracts it owns,
and the delivery phase ([contracts](../04-delivery/contracts.md), to be rewritten) defines
schemas and wire formats.

| Contract | Kind | Owner (defines it) | Consumers |
|---|---|---|---|
| Link hold port: hold (with account, request, `D`, age), convert (with the decision timestamp), request-scoped release and its acknowledgement once durable, query hold. Port invariants (A0R-03): a release ends every hold, waiter registration and grant of the request, whatever the attempt; a tombstone kept until `D` + `release_grace` refuses any later hold or grant for the request; no hold or grant is made past `D`; a refusal records a tombstone and counts as the release acknowledgement | Synchronous command | RFC-001 | RFC-002 |
| Link waiting port: register waiter, waiting notice (with the deadline of the request ahead), capacity released, yield request | Command and notification | RFC-001 | RFC-002 |
| Outcome and expiry port: outcome notice to participants; expire-if-undecided request, **answered with the committed outcome, confirmed (with its decision timestamp) or not**; yield acceptance or refusal | Command and notification | RFC-002 | RFC-001, partner adapters |
| Link availability query: peak and free-capacity profile for counter-offers | Synchronous query | RFC-001 | RFC-002 |
| Link supply commands: unplanned outage and restoration, maintenance booking, permanent reduction | Synchronous command | RFC-001 | Supplier API and operator console (RFC-005) |
| Link schedule feed: schedule changes, capacity history, affected flags | Asynchronous feed | RFC-001 | RFC-002 (affected reservations, revocations due), RFC-003, RFC-006 (history, notifier) |
| Booking API: book, change, cancel, withdraw, status | External API | RFC-002 | Buyers through RFC-005's edge |
| Request outcome feed | Asynchronous feed | RFC-002 | RFC-006 (notifier, alerting), operator console |
| Reservation lifecycle feed: parts, locked prices, legs, effective minutes, end cause, fees shown at booking | Asynchronous feed | RFC-002 | RFC-003, RFC-006 (history), reporting |
| Reservation command port: revoke or reduce (from RFC-001), release after grace (internal to the account owner, rule from RFC-004), terminate (from the operator console), offer and move to an equivalent path with its move hold (RQ-4) | Synchronous command | RFC-002 | RFC-001, RFC-005 |
| Partner port: classify (POL-26 test), hold with `expires_at = D`, confirm (journaled with its send time), book final, release, cancel, resume query (an adapter log entry recording the account owner's term). Port invariants (V-03), beside the link hold port's: a confirm or final booking is refused, journaled as refused and never sent for a tombstoned request, when the adapter's clock is past `D − commit_margin` less the partner-skew budget, or when it carries an account-owner term lower than the highest recorded for the request; a partner booking found for a tombstoned request is cancelled at once at Share's cost. RFC-002 budgets partner clock skew inside `commit_margin` and states the reconcile-then-cancel path for a confirm the partner answers "unknown" after its own `D` (A0R-08) | Adapter interface, per partner | RFC-002 | Partner adapters |
| Partner reconciliation feed: mismatches and actions; a Share reservation the partner lacks is recorded as affected on its partner leg by the account owner | Asynchronous feed | RFC-002 | Operator console, notifier |
| Equivalent-path source | External input | Routing (out of scope) | RFC-001, RFC-002 |
| Funds-and-standing module: hold sizing, headroom, key headroom, in-flight, rate limits, standing transitions, resume amount | In-process deterministic module | RFC-004 (Part A) | RFC-002 (the account owner) |
| Headroom and balance query (at a recorded position) | Synchronous query, served by account-owner replicas | RFC-004 | Edge (buyer API), probes |
| Standing feed and query | Asynchronous feed and query | RFC-004 (semantics), emitted by the account owner | Network operations |
| Key-status push: revocations and limit changes | Asynchronous feed, applied as an entry within 60 s | RFC-005 | RFC-002 |
| Flow-record ingestion protocol | External protocol | RFC-003 | Exporters |
| Attribution keys from provisioning | External input | Provisioning (Problem 5) | RFC-003 |
| Catalogue: products, prices and corrections, weights, partner terms, probe designations | Query and feed | RFC-003 (link registry: RFC-001) | RFC-001, RFC-002, RFC-004, RFC-006 |
| Unposted-usage feed (through a rating position) | Asynchronous feed | RFC-003 | RFC-002 (applied in the account owner's log), RFC-004 (semantics) |
| Charge-line feed: charges and amendments with source references and reasons | Asynchronous feed | RFC-003 | RFC-004 (settlement) |
| Ledger posting port (one movement per account and minute, many lines, each line balanced and deduplicated on its own; posting time monotone, §4.5) | Synchronous command | RFC-004 | Settlement, payments, payouts (all within RFC-004) |
| Ledger movement feed and closed positions | Asynchronous feed | RFC-004 | Account owner, reporting, reconciliation, payouts, RFC-006 (history, audit) |
| Payment notification ingress (routed by provider and transaction reference) | External API | RFC-004 (authenticity: RFC-005) | Payment providers |
| Payout instruction and confirmation | External API | RFC-004 | Payout providers |
| Principal and authorisation context | Library and feed | RFC-005 | Every component |
| Operator action envelope: role, reason, approver | Command wrapper | RFC-005 | Every owner that accepts operator actions |
| Audit record | Field set in every owner's log; feed | RFC-005 | RFC-006 (retention) |
| Signed webhook | Outbound protocol | RFC-005 (signing), RFC-006 (delivery) | Buyers |
| Replicated-log, placement, leader-placement and fencing conventions; region-wide failover; 2 + 2 reconfiguration during a declared disaster; closed and report positions; clock-uncertainty bound and the invariant `ack_budget ≥ τ > ε + δ_x` | Platform contract | RFC-006 | Every owner |
| History query: as known at T | Query | RFC-006 (storage); semantics in RFC-001, RFC-002, RFC-004 | Operations, support, finance |
| Probe designation and exclusion | Flag in catalogue and identity | RFC-006 | RFC-003, RFC-004, reporting |
| Operational alert feed | Asynchronous feed | RFC-006 | Every owner raises alerts through it |

## Benefits

Figures marked "est." are estimates (§3, §6), to be replaced by measurement (R1).

| Target or policy | How the architecture meets it |
|---|---|
| Never oversell (P1-N1, POL-05) | One writer per link, by construction: the link owner is the leader of the link's log, fenced by term and epoch. Every booking on the link goes through it. Only the request's account owner ends a hold, after a committed outcome, so no hold is released under a confirmed reservation, whatever the replication delay. |
| One decision per request (POL-04) | The first deciding entry in one account log; suspension, revocation, withdrawal and the deadline are all ordered against it. |
| Concurrent decisions equal some one-at-a-time order (P1-N2, P2-N8, P2-N9, POL-25) | Serial order per link and per account (one log each); holds until the decision give serialisability across them. |
| `ack_budget` 200 ms at p99 (POL-04, X2-N3) | Only admission components on the path; three two-region writes for a single-link booking, each about 25 ms (est.) on the Nairobi–Mombasa pair: about 105 ms at p99 from R1 including the report position, about 115 to 135 ms from R2 or with drift (est.). After a region loss, `pending` within about 90 ms (est.); final answers then about 280 to 300 ms (est.), while the latency targets are suspended (RQ-3). |
| Deadline (POL-26, P2-N3) | Expiry is a conditional log entry appended before `D`; Share-link holds are released by `D` normally and within `release_grace` if the decision record or the link's schedule is unavailable; a confirmation is never decided after `D − τ` (200 ms before `D`, est.), stricter than RQ-7's "before `D`"; partner routes begin committing by `D − commit_margin` and keep about 9.8 s for the partner confirm; partner holds carry expiry `D`. |
| Capacity free once the outcome is reported (POL-04, RQ-6, RQ-8) | Request-scoped releases with tombstones, so no late command recreates a hold; a non-confirmed outcome is reported only after a "releases durable" entry, about 70 ms after the decision (est.), within `release_grace` while a link fails over. |
| Status reads never wrong, never `pending` after a reported outcome (POL-04, RQ-10) | Every report, the edge's synchronous answer included, gated on the report position, which waits for every leased status replica; the four-step replica rule (§4.6). |
| All or nothing with partners (P2-N1, P2-N7, POL-28) | Account log as decision log; everything Share decides is checked just before the partner confirm; any partner booking left without a confirmation is cancelled at once at Share's cost; at most one final-only partner, booked last. |
| Fair contention, partners included (P2-N4, POL-02) | Waiter queues by `priority_rule` at every link owner and at every partner adapter; yields accepted by the account owner only while the request is waiting. |
| RPO 0, two-region acknowledgement (X2-N4) | Five-voter groups, 2 + 2 + 1 across Nairobi, Mombasa and Johannesburg, no region with a majority: every commit is two-region durable, for every fact and every figure shown. During a declared region disaster, 2 + 2 keeps that and tolerates one further fault. |
| RTO (X2-N5) | Automatic leader failover in seconds for node and facility loss, and region-wide failover for region loss with nothing to rebuild. |
| Availability per capability (X2-N1) | Capabilities are separate components with separate failure domains; probes measure each serving region end to end; diverse fibre paths are a go-live condition, so no single cut makes a serving region unavailable or marginal. |
| Every payment once (P4-N1, P4-N15) | Payment events partitioned by (provider, transaction reference), each reference bound to its account by its first event; a redelivery naming another account moves nothing. |
| Design load (X2-N2) | Partitioned by natural keys with no global sequencer; the hottest link is the one irreducible serial point (at least 5,000 entries/s, est.), an in-memory state machine with group commit. Charge lines (about 1 M/s, est.) are posted as one movement per account and minute. |
| Charge and attribution timeliness, exactly once (X2-N3, P3-N2, P3-N10) | Rating consumes owner logs; hot standbys take over in about 30 s (est.); postings are idempotent by source reference. |
| Immutability and audit (P4-N7, X1-N8, POL-19) | Append-only logs everywhere; audit fields written in the same entry as the change. |
| Past headroom rebuilt as shown (P4-N16, P4-S72) | Every input to headroom is an entry in the account log; every answer carries its position. |
| Reconciliation (P4-N14, POL-24) | Each movement is zero-sum within one partition; posting time is monotone across leader changes; every run reads all partitions at one closed position and counts incoming payments received by the partner but not yet posted (RQ-11). |
| Retention (X2-N6) | Owner logs archived to two-region object storage; nothing is deleted inside 7 years. |
| Policy changes without mechanism changes (policy register preamble) | Parameters (`priority_rule`, deadlines, windows, limits, prices, weights, `release_grace`) are data read by owners; no parameter is built into the structure. |

## Competition

| Alternative | Why it loses |
|---|---|
| **One database transaction for everything**: a distributed SQL database with serialisable transactions spanning the link schedules, the funds hold and the ledger | Partner legs cannot join it (P2 C6). On a hot link at 2,500 requests/s, serialisable transactions conflict and retry; the prototype found that optimistic or serialisable concurrency "wrecks the tail latency" under contention (history D3). It also makes Share's own account a hot row on every charge, and ties admission's availability to the ledger's. Distributed SQL is still a good *store* for the ledger (RFC-004 may choose it), but not as the coordination mechanism. |
| **Per-link SQL row locks as the authority** (pre-baseline RFC-001) | Measured on the prototype at p99 115.5 ms with 50 clients on one link, the lock wait being most of it, and per-link throughput about one over the transaction time. With a two-region commit inside the lock, one link would sustain well under 100 decisions/s against the 2,500/s target. Correctness also depended on the isolation level (`REPEATABLE READ` oversold, history D12), and the database's lock queue cannot express POL-02's priority rule or the crossing rule. |
| **Booking coordinator and account funds as two components** (this RFC's previous draft) | Two decision points per request (bind and decision record), so P2-S69 and P2-S103 cannot both hold; two serial orders per account; funds state durable in one region, lost with it (P4-S72). It saved about one 25 ms write. Replaced by the account owner (A0-02). |
| **Expiry by a strong read of the decision log** (this RFC's previous draft) | A linearisable read does not see a decision proposed but not yet committed, so a link could release a hold under a confirmation that commits a moment later: an oversell or a partly booked route. Replaced by the expiry entry (A0-01). |
| **Event-sourced monolith**: one log, one process applying every command | A single total order makes every invariant easy, but nothing requires a global order (§4.5), and one sequencer must then carry 25,000 bookings/s, 600,000 records/s and every posting. One failure domain cannot give admission 99.99% while rating is judged by timeliness. Its good part, facts as an append-only log that can be replayed (A4), is kept per partition. |
| **Deterministic ordering in the style of Calvin** (a sequencing layer orders all transactions, then every partition executes them deterministically, with no commit protocol) | Removes two-phase commit among Share's own partitions, but a sequencer batch adds a round per transaction (an epoch of about 10 ms plus a two-region commit of the batch), the sequencer is a global ordering layer the requirements do not need, and partner legs are non-deterministic external calls that cannot be executed deterministically, so the commit protocol is still needed for every partner route. |
| **Parallel commits** (the transaction record kept with a participant; the decision implied once every participant's hold and a staged record are durable, as in CockroachDB) | Saves one write (three become two: about 70 ms steady, about 150 to 160 ms after a region loss, est., before the report position). But the decision is then a derived fact spread over the account and link logs, so "one decision point" (POL-04) and status reads need a resolution step that reads every participant, and suspension, revocation and withdrawal must be ordered against a distributed condition. Kept as a fallback for the single-link path in the degraded state (R13), not adopted. |
| **Three voters, one per region** | Same steady-state latency (leader in R1 plus R2) and 40% fewer copies. But a single node or facility loss leaves a region with no voter, so the next commit must reach R3 (about 65 to 70 ms) during an event that counts against availability, and two node losses lose quorum. Kept as an option for ingestion, whose budget is 1 s (§5.1). |
| **Actor per link** (virtual actors, cluster sharding) | The right shape, and the link owner is an actor per link. As usually deployed, actor runtimes guarantee single activation only in the absence of partitions: a split-brain or a slow failure detector can activate the same link twice, and persistence plugins append without a term fence. Two activations are two schedule owners, which POL-05 forbids. The architecture keeps the actor model but puts each actor on a consensus log whose term fences it. |
| **Saga with compensation and wound-wait** (pre-baseline RFC-002) | Wound-wait lets an older request pre-empt any younger unpinned hold; POL-02 forbids pre-empting a holder that is not waiting and asks instead that a *waiting* younger holder yield. The prototype's single coordinator process was a single point of failure, and compensating after a commit decision left routes partly booked (history D21). The account log as decision log keeps the commit point and removes the single coordinator. |
| **Two-phase commit including partners** (XA) | Partners do not offer it (P2 C6, history D13). |
| **Capacity first, funds checked after** | Breaks POL-25 (no capacity hold before the funds hold) and invites squatting. |
| **Active-active multi-region with conflict resolution** (CRDTs, last writer wins) | Two regions could each confirm the last Mbps of a link; merging afterwards is overselling. "Never oversell" needs a single decision per link, which needs consensus. |
| **A third voting region in Nairobi or Mombasa** (a third Share facility in the same metro as R1 or R2) | Lower latency in the degraded state, but one metro-wide disaster could lose a fact committed only in that metro's two sites, breaking RPO 0. R3 in another country and with another operator avoids that. |
| **Partition the booking by route rather than by link** | Links are shared between routes and single-link bookings (POL-05); a route owner would be a second writer for every link it crosses. |
| **A committing mark in the account log before the partner confirm** (revision 2) | Not needed for correctness: the same checks are made from the applied state in the same serial order, the deciding entry makes them again, and the outstanding confirm is in the partner adapter's two-region call journal. It cost every partner route one extra two-region write. Dropped (A0R-14). |
| **Confirm fence at `D − commit_margin` for partner routes** (v1.3's literal POL-26) | Committing may begin at `D − commit_margin` but would have to be decided before it, leaving no time for the partner confirm, or shortening every partner deadline by a confirm budget. Replaced by one fence `D − τ` for every request (RQ-7, R2-D1). |
| **Payments partitioned by provider and account** (revision 2) | A redelivery naming another account lands in another partition, where its reference is new, and is credited again (P4-N1). Replaced by (provider, transaction reference) (A0R-04). |
| **One ledger partition for Share's own account** (revision 2) | Carried excess, dearer-path differences, FX differences and partner fees all land in it: the serial point the home-account rule was meant to remove. Replaced by homing by the causing buyer, else hashing (A0R-09). |
| **A third site, or one voter less, during a declared region disaster** | A third site costs a new facility and its fibre; running on 3 of 5 tolerates no further fault (A0R-12). Reconfiguring to 2 + 2 with a second R3 voter costs neither (R2-D3). |
| **Reporting at commit, with rule 3 refusing when it finds an outcome entry it cannot prove committed** (an alternative to V-01 and V-02) | Saves the report-position delay (about 10 ms steady, 65 to 70 ms degraded), but answers a status read with a refusal, not `pending`, for an unreported outcome during a failover, against P2-S106 and P2-S111, and it does not fix a fresh but lagging replica (V-01). |
| **Treating a fibre cut as a declared disaster** | It would hide hours of unavailability in a serving region from the 99.99% measurement. Fibre diversity is a go-live condition instead, and an isolated region counts against availability unless its loss is declared (R2-D2). |
| **Single-entry balances updated in place** (pre-baseline RFC-004 alternatives) | No conservation check and no history (P4-N7); hot rows on supplier and Share accounts. The journal per home account makes double entry atomic within one partition and removes the hot rows. |

## Risks and open issues

| # | Risk or issue | Mitigation or next step |
|---|---|---|
| R1 | **The latency budget is an estimate.** The Nairobi–Mombasa and Kenya–Johannesburg round-trip times, two-region quorum writes at p99 under load, group commit on the hottest link and the edge's overhead are not measured. | Before RFC-001, RFC-002 and RFC-004 are approved, a spike measures a five-voter group (2 Nairobi, 2 Mombasa, 1 `africa-south1`) running the account-owner and link-owner path, in steady state and with each region cut off. It also measures each Kenyan region's RTT to R3 (which fixes the leader region, R2-D7), `δ_x` and the report-position delay, and a region-wide failover of every leader (R16). RFC-006 sets the measurement. |
| R2 | **Facilities as zones.** The design assumes at least two independent Share facilities in each of Nairobi and Mombasa. If a metro has only one, a facility loss is a region loss (a declared disaster) and more frequent. Nairobi and Mombasa share a country, a grid operator and some fibre routes, so a correlated loss of both is more likely than for distant cloud regions; it is outside X2-N4 (two-region loss) but would stop admission. | Confirm the facility inventory with Share's platform team; RFC-006 records it. During a declared region disaster, groups are reconfigured to 2 + 2 (§5.1), so one further fault is tolerated without a replacement site. |
| R3 | **One geography only.** A single-link booking where the account and the link have their leaders in different geographies would cross a long round trip and miss X2-S15. | Start with one geography (Kenya plus Johannesburg). Multi-geography (Djibouti, Marseille) is a later RFC; it must keep every account's partitions and the links it books in the same geography, or accept `pending` for cross-geography bookings. |
| R4 | **Clock uncertainty.** The expiry timing, the confirm fence's timestamp guard, the closed positions and `request_age` depend on a bounded `ε`. Safety against overselling and partial booking does not (A8). | The platform monitors `ε` (target in RFC-006, about 40 ms at most, est.) and the invariant `ack_budget ≥ τ > ε + δ_x`; a node whose clock is out of bound stops leading; the confirm guard fails safe (no confirm) when uncertainty is unknown. If `ε + δ_x` approaches `ack_budget`, the confirm fence moves earlier, never the release later. |
| R5 | **The hottest link is a serial point.** 2,500 requests/s is provisional (POL-06; P1 open question 1). | Group commit and an in-memory schedule; RFC-001 states the measured ceiling per link and the share of `pending` (§6). |
| R6 | **The account owner is a large state machine.** An account with many reservations or agent keys concentrates state and work in one partition. | `account_rate_limit` bounds its booking rate; reservations and charge-line state can be sub-partitioned by reservation under the account's log if needed, without a second writer of decisions. RFC-002 sets the limit. |
| R7 | *(Resolved.)* Waiter queues across a failover. | Waiter registrations, waiting notices and yields are log entries (§2). |
| R8 | **Decision record unavailable at a deadline.** Holds stay until the outcome is committed. | Bounded by `release_grace` (RQ-1) through takeover and expiry entries (§4.3); alerted. |
| R9 | **Attribution depends on provisioning data** (P3 open question 2). | An external contract (§8); RFC-003 defines the minimum it needs. |
| R10 | **Webhook load is unknown** (X2 open question 2). | The notifier is partitioned by account and scaled independently; RFC-006 sets a provisional figure. |
| R11 | **RFC-004 is large, and its Part A is now inside RFC-002's component.** | The division in §7; RFC-002 and RFC-004 Part A are reviewed together. |
| R12 | *(Resolved by RQ-4.)* Firm equivalent-path offers hold capacity on the new path for `offer_window`. | A move hold on each new-path link, owned by the reservation's move command; no funds hold, since the price is no higher (D4). RFC-001 and RFC-002 specify it. |
| R13 | **Degraded latency after a region loss, or while R1 commits through R3** (about 280 to 300 ms for a final single-link answer, est., report position included). | Allowed by RQ-3 for a declared disaster; not allowed for a fibre cut. RFC-006 evaluates a parallel-commit single-link path while degraded (about 210 ms, est.) against both cases, and a replacement site for a lost region. |
| R14 | **Fibre paths.** The subsea routes to southern Africa land at Mombasa, so without diverse paths one Nairobi–Mombasa cut could isolate R1 from R2 and R3 at once, and even a cut that does not would make R2 unavailable and R1 marginal for the hours a repair takes, outside any declared disaster (A0R-05). | **Go-live condition** (R2-D2, recorded in the requirements' topology assumption and in RFC-006): two Nairobi–Mombasa paths, and Nairobi–Johannesburg and Mombasa–Johannesburg paths not via each other, with no shared risk, verified by Share's network team. The cut analysis (§5.1) depends on it. |
| R15 | **Charge-line volume depends on reservation length**, which is assumed (mean 1 h); so does journal storage (about 2.2 PB per copy over 7 years in columnar segments, est.; §6). | RFC-003 and RFC-004 size from a stated distribution; posting one movement per account and minute keeps the ledger's write rate independent of it; RFC-004 confirms the segment encoding (A0R-11). |
| R16 | **Region-wide failover is a mechanism of its own** (A0R-13): what decides that a region can no longer lead, and how thousands of groups re-elect after the lease waits within admission's 1 min RTO. | RFC-006 specifies the placement log (2 + 2 + 1), the trigger, staggered elections and the expected time to move every leader; the R1 spike tests it. |
| R17 | **Partner clocks** (A0R-08). A partner applies the hold expiry `D` by its own clock, so a confirm that reaches it after its `D` is answered "unknown" (P2 C8). | RFC-002 budgets partner clock skew inside `commit_margin`, and states the path: reconcile, then cancel at Share's cost (POL-28) if the partner booked it. |

## Requirements issues

**Resolved.** Every issue this RFC and its reviews raised, RQ-1 … RQ-12, is settled in the
requirements:

| # | Issue | Resolution |
|---|---|---|
| RI-1 | Partner holds outliving the deadline | Resolved in `requirements-v1.1`: a partner offers holds only if it accepts an expiry set by Share, which Share sets to `D` (POL-26, POL-28; P2-S100 … S102). See [review 05](../reviews/05-requirements-amendments-from-architecture.md). |
| RI-2 | Propagation lag of unposted usage | Resolved in v1.1: unposted usage counts accepted records; `attribution_lag_max` added to the lateness bound and as a timeliness target (POL-14, POL-18, POL-06; P3-S61, P3-S62, X2-S22). Review 05. |
| RI-3 | Which point decides "still pending" | Resolved in v1.1 **against this RFC's earlier reading**: one decision per request, and status reads lag it by at most `status_staleness` (POL-04; P2-S99, P2-S103). Adopted: the account owner's deciding entry (§4.3). Review 05. |
| RI-4 | Funds holds on the admission path | Resolved in v1.1: the funds holds and headroom checks a booking needs meet admission's targets (POL-06; X2-S21). Review 05. |
| RI-5 | "Per region" | Resolved in v1.1: every target is per serving region (POL-06; X2-S01). Review 05. |
| RQ-1 | Release at the deadline when the decision record is unavailable | Resolved in v1.2: Share-link holds are released at the deadline, or within `release_grace` (1 min) after it if the decision record is unavailable; never confirmed after the deadline (POL-26; P2-S104, P1-S54; glossary *Decision record*). See [review 07](../reviews/07-requirements-amendments-from-rfc-000-review.md). |
| RQ-2 | Partner booking left without a Share confirmation | Resolved in v1.2: cancelled at once at Share's cost, with or without holds (POL-28, POL-08). Review 07. |
| RQ-3 | Latency during a declared region disaster | Resolved in v1.2: latency targets are suspended from the declaration until the region is restored or replaced; RPO 0 still applies (POL-06). Review 07. |
| RQ-4 | Equivalent-path offers | Resolved in v1.2: the offer is firm and its capacity held for `offer_window` (POL-07); the probe account books on a credit limit set by finance (POL-06, decision D3). Review 07. |
| RQ-5 | A confirmation in flight when the decision record fails at the deadline | Resolved in v1.3: a request is confirmed only by a decision timestamped in time; one decided in time may become known up to `release_grace` after the deadline if the record was unavailable, status reads reporting `pending` until then (POL-26, POL-04; P2-S106). Applied in §4.3 and §4.6. Review 07. |
| RQ-6 | Release at the instant of the outcome | Resolved in v1.3 as this RFC proposed: a non-confirmed outcome is reported only once the Share-link releases it needs are durable, and the capacity is free from the report (POL-04; glossary *Capacity hold*; P2-S14). Designed in revision 3 as the "releases durable" entry (§4.3, A0R-02). Review 07. |
| RQ-7 | The confirm fence for partner routes contradicted `commit_margin` | Resolved in v1.4: a request is confirmed only by a decision entry timestamped before its deadline; a request with a partner leg begins committing no later than deadline − `commit_margin`, one without no later than deadline − `ack_budget`. The design's fence `D − τ` is stricter (§4.3, R2-D1). See [review 09](../reviews/09-requirements-amendments-from-rfc-000-review-2.md). |
| RQ-8 | RQ-6 against `status_staleness` while a link's owner fails over | Resolved in v1.4: a non-confirmed outcome is reported only once its Share-link releases are durable, within `status_staleness` of the decision normally and within `release_grace` while a link's schedule owner fails over; a release due at the deadline likewise within `release_grace` if the link's schedule is unavailable (POL-04, POL-26; P2-S93, P2-S99). §4.3. Review 09. |
| RQ-9 | P1-S54 lacked the "no confirmation decided in time" Given | Resolved in v1.4 as proposed (P1-S54). Review 09. |
| RQ-10 | The status-read exception covered outcomes already reported | Resolved in v1.4: the `pending`-while-unavailable exception never applies to an outcome already reported (POL-04; glossary *Status read*). Replica rule 3 and the report position (§4.6). Review 09. |
| RQ-11 | Reconciliation lacked incoming payments in flight | Resolved in v1.4: reconciliation includes payments received and reported by the partner but not yet posted (P4-N14 (1) and (2)). §2, §7. Review 09. |
| RQ-12 | The status-read exception covered only unavailability at the deadline | Resolved in v1.5 as this RFC proposed: while a request's decision record is unavailable, before or at its deadline, a status read of an outcome not yet reported reports `pending`, never a wrong outcome (POL-04; glossary *Status read*; P2-S111). Replica rule 3 (§4.6), §4.2. Review 09. |

**New.** None found in revision 3.1.

## Review resolution

How each finding and decision of the [first review](../reviews/06-rfc-000-review.md) was
applied in revision 2, and of the [second review](../reviews/08-rfc-000-review-2.md) in
revision 3 (below the first tables), and of its [verification](../reviews/10-rfc-000-verification.md)
in revision 3.1 (last table).

**First review (revision 2; A0-06 and A0-10 reopened by v1.3 and resolved again in revision 3).**

| Finding | Severity | Change in this revision |
|---|---|---|
| A0-01 | Blocker | Expiry is a conditional "expire if undecided" entry in the request's decision log (the account owner's log), appended by its leader at `D − ε − δ_x` or at any participant's request; the first deciding entry in log order wins; a participant releases only on a committed non-confirmed outcome (A9); clocks drive liveness only (A8); the confirm fence stays as a liveness rule with a timestamp guard; status reads report "failed" only after the expiry is applied; record unavailable at `D` → holds kept, takeover, release within `release_grace` (RQ-1). §1, §3 (deadline diagram), §4.3, §4.6, R4, R8; residual case raised as RQ-5. |
| A0-02 | Blocker | Booking coordinator and account funds merged into one **account owner** on a 2 + 2 + 1 log, with a booking module (RFC-002) and a funds-and-standing module (RFC-004 Part A), one writer process; entries are intake + funds hold, marks, and the decision entry, which is the single POL-04 decision point and binds the funds. One-region durability, the rebuild (old §5.3 row 4 and R6) and the "all two-region" fallback are deleted. §2, §3, §4.1, §5.3, §7, §8, Competition. |
| A0-03 | Major | The request record is written first, in entry 1, atomically with the idempotency check and the funds hold, before any capacity hold; every hold carries account, request, `D` and age. §3, §4.4. |
| A0-04 | Major | Partner adapters keep Share's waiter queue at each partner link by `priority_rule`, apply the yield rule to Share's own partner holds (accepted by the account owner), and re-ask strictly in priority order, one at a time per overlapping window (refined in revision 3 by A0R-08). RFC-002's acceptance tests gain a partner-leg variant of P2-S87. §2, §3, §4.5. |
| A0-05 | Major | RTT matrix and quorum latencies for every failure state on the coordinator's geography; the workflow runs at the account leader and the edge forwards once; leaders co-located in R1 with region-wide failover; probe path budgeted (D2); degraded case after losing R1 or R2 stated, with RQ-3 applied. §3, §5.1. |
| A0-06 | Major | Status reads served by account-log replicas at closed positions within `status_staleness`, "failed" only once applied; poll load sized at 100,000/s on replicas. §4.6, §6. **Reopened by v1.3** (`pending`, not "unavailable", while the record is unavailable at the deadline); resolved again in revision 3 by the replica rule and the report position (A0R-06). |
| A0-07 | Major | Hot standbys (takeover about 30 s) on the attribution → unposted-usage → account path and the reservation-accrual posting path; per-minute budget arithmetic assigned to RFC-006. §2, §5.4. |
| A0-08 | Major | Charge-line volume sized from an assumed 1 h mean reservation (about 1 M lines/s); one movement per account and minute; deduplication by watermark plus exception set for postings and by run-length range sets for flow records. §4.4, §6, R15. |
| A0-09 | Major | Order: committing mark (all of Share's checks) → partner confirm → decision; the same for partners without holds; the residue is cancelled at once at Share's cost (RQ-2). The committing mark is not a decision point, so a later event still ends the request not confirmed, keeping POL-04. §3, §4.1. (Revision 3 keeps the order and drops the mark as a log entry, A0R-14.) |
| A0-10 | Major | Rebased on `requirements-v1.1` and the RQ amendments; partner port gains `expires_at = D` and the POL-26 classification test (P2-S102); the 70 s partner hold is removed; the Requirements-issues table now points to the resolutions. Header, §2, §3, §8, Requirements issues. **Reopened** (revision 2 was not rebased on v1.3); resolved again in revision 3: rebased on v1.3 and the RQ-7 … RQ-11 decisions (A0R-07). |
| A0-11 | Major | Ledger partitions by **home account** (a movement touching a buyer lives in that buyer's partition), so a buyer's balance is exact in one partition, which is strictly better than the review's conservative aggregate; per-partition closed positions give reconciliation and payout runs a consistent cut; the home-account rule names every movement kind. §2, §4.5. |
| A0-12 | Minor | Booking-rate limits enforced exactly in the account owner before a request is created; edge counters advisory (D5). §2, §4.4. |
| A0-13 | Minor | A revocation takes effect for undecided requests when applied in the account owner's log, within 60 s (D6); identity and access stays the writer of the key record. §2, §3, §8. |
| A0-14 | Minor | The account owner records partner-leg affected status from the partner reconciliation feed; the notifier tells the holder. §2, §8. |
| A0-15 | Minor | Known-at for a link is the link log with each conversion carrying its decision timestamp. §4.2, §7 (P1-N9). |
| A0-16 | Minor | Five voters for the live tail only; sealed segments in two-region object storage; three voters per region considered for ingestion. §5.1, §5.3, §6, Competition. |
| A0-17 | Minor | Pending approvals on a two-region log; refused privileged attempts audited. §2, §5.3. |
| A0-18 | Minor | Competition adds the merged account owner (now adopted, with the old split as the loser), parallel commits, Calvin-style ordering and three voters; Benefits figures marked as estimates; Prior decisions row added; Policies field complete. |
| A0-19 | Minor | Hot-link entries per request, group-commit size, holds in flight and the condition for `pending` stated. §6. |
| A0-20 | Minor | Takeover entries; the expiry entry records its reason from the request's state, including "interrupted by an internal failure" (P2-S23). §4.3. |
| A0-21 | Minor | Headroom inputs enter the account log as feed entries; every headroom answer carries its one position, so the past is rebuilt exactly as shown. §4.6. |

| Decision | Applied |
|---|---|
| D1 | **Replaced by the coordinator's decision**: R1 Nairobi and R2 Mombasa (Share's own data centres, about 10 ms apart) serve; R3 GCP `africa-south1` Johannesburg (about 45 ms from Nairobi, 50 ms from Mombasa) is the third voting region. Edge in each Kenyan region instead of separate points of presence. §5.1, §3. |
| D2 | Accepted: probes within about 10 ms of each serving region, persistent TLS, measured end to end. §5.1. |
| D3 | Applied in the requirements (POL-06) and here: the probe account books on a finance-set credit limit. §5.1. |
| D4 | Accepted: firm equivalent-path offers with move holds for `offer_window`, no funds hold. §2, R12. |
| D5 | Accepted: exact rate limits at the account owner. |
| D6 | Accepted: revocation effective when applied in the account owner's log, within 60 s. |
| D7 | Accepted in revision 2, with one refinement: the committing mark precedes the partner confirm but does not block withdrawal or later events, since only the decision entry may be the POL-04 decision point. **Superseded in revision 3** by A0R-14: the checks are kept, made from the applied state just before the partner confirm, but the mark is no longer a log entry. |

**Second review (revision 3).**

| Finding | Severity | Change in this revision |
|---|---|---|
| A0R-01 | Major | One confirm fence for every request, `D − τ` with `τ = max(ack_budget, ε + δ_x)` (200 ms, est.), following RQ-7 as decided (confirmed only by an entry timestamped before `D`; begin committing by `D − commit_margin` with a partner leg, `D − ack_budget` without). "Begin committing" for a partner route is the journaled send of the partner confirm, which then has about 9.8 s. §3 (route sequence), §4.3, Benefits, Competition. |
| A0R-02 | Major | A **"releases durable"** entry in the account log, built from the release acknowledgements of every Share leg in the intake and batched into group commits (folded into the ending entry when every acknowledgement is already in hand); a non-confirmed outcome is reported only once it is at the report position; a new leader re-sends releases for every ending entry without one; while a link fails over the report waits, within `release_grace` (RQ-8). `δ_x` restated as two commits plus two hops (about 60 ms steady, 145 ms degraded, est.) with `ack_budget ≥ τ > ε + δ_x` monitored. A10, §3 (deadline diagram, rejected path), §3 latency table, §4.3, R4. |
| A0R-03 | Major | Releases are **request-scoped** (every hold, waiter registration and grant, whatever the attempt), leave a tombstone until `D` + `release_grace`, and any hold or grant for a tombstoned request or one past `D` is refused; a refusal records a tombstone too; "releases durable" counts every leg in the intake; the answer to an expiry request carries the committed outcome, confirmed or not. Stated as link hold port invariants for RFC-001 and RFC-002. A9, §2, §3, §4.3, §4.4, §6 (tombstone sizing), §8. |
| A0R-04 | Major | Payment events partitioned by **(provider, transaction reference)**; the first authenticated event binds the reference to its account and the posting carries the binding; a later event with different contents moves nothing and is reported; orphan reversals matched in one partition; internally generated references keep the home rule. §2, §4.1, §4.4, §6, §7, §8. |
| A0R-05 | Major | Diverse fibre paths are a **go-live condition** (two Nairobi–Mombasa paths; Nairobi and Mombasa each to Johannesburg, not via each other; no shared risk). Cut analysis redone: one Nairobi–Mombasa cut changes nothing material; a Kenya–R3 cut changes nothing; a double Nairobi–Mombasa cut makes R2 unavailable and R1 marginal (counts against availability); R1 isolated and R2 isolated rows added. Leader region chosen by measured RTT to R3 (R2-D7). The degraded two-write path is evaluated against the double cut too. §3 (RTT note, quorum table, leader placement, mitigations), §5.1, R13, R14. |
| A0R-06 | Major | Replica rule in four steps (reported outcome always reported; `pending` within freshness; `pending` past it only once a majority of voters confirms no leader holds the lease, after catching up to their committed positions; otherwise refuse with retry), with a **report position** so that a reported outcome is always found again (RQ-10). §4.6, §4.2. Before the deadline, raised as RQ-12 (resolved in v1.5). Corrected in revision 3.1 by read leases and an edge gated on the report position (V-01, V-02). |
| A0R-07 | Minor | Rebased on `requirements-v1.3` plus the RQ-7 … RQ-11 decisions (v1.4); RQ-5 and RQ-6 moved to Resolved (review 07), RQ-7 … RQ-11 too (review 09); the P2-S104 sentence dropped; §4.3 restated on v1.3's late-known confirmation. Header, §4.3, Requirements issues. |
| A0R-08 | Minor | The partner adapter skips waiters past their commit fence or already ended; re-asks serialised per pair of conflicting windows; RFC-002 budgets partner clock skew inside `commit_margin` and states reconcile-then-cancel. §2, §3, §4.5, §8, R17. |
| A0R-09 | Minor | A movement that touches no buyer is homed with the buyer whose request, reservation or traffic caused it; otherwise with its one supplier; otherwise in one of N Share sub-partitions by a hash of its source reference; the home is a function of the source reference. §2, §4.2, Competition. |
| A0R-10 | Minor | Posting time `max(leader clock, previous posting time, last closed T + 1 µs)`, read from the log, so monotone across leader changes; deduplication per line within a movement (already-posted lines dropped, conflicting lines excluded and reported, the rest posted; each line balanced). §4.1, §4.4, §4.5, §8; RFC-004 specifies. |
| A0R-11 | Minor | Journal storage sized: about 2.2×10¹⁴ lines over 7 years, about 22 PB per copy at 100 B; per-party totals in the movement and lines in sealed columnar segments (about 10 B a line, about 2.2 PB per copy, est.) that still answer P4-N16 and P3-N9; RFC-004 confirms. §6, R15. |
| A0R-12 | Minor | On a declared region disaster each group (the placement log first) is reconfigured to **2 + 2**: two surviving Kenyan voters and two R3 voters in different zones; majority 3 of 4 spans two regions, one further fault tolerated, latency unchanged; reverted on restoration. §2 (placement), §3 quorum table, §5.1, R2. |
| A0R-13 | Minor | Region-wide failover assigned to RFC-006 (placement log 2 + 2 + 1, trigger, staggered elections, time to move every leader within 1 min) and tested in the R1 spike. §2, §3 (leader placement), §7 (X2-N5), R1, R16. |
| A0R-14 | Minor | **Decided: the committing mark is dropped.** The checks are made from the applied state, in the account owner's serial order, just before the partner confirm; the deciding entry repeats them; the outstanding confirm and its send time are in the partner adapter's two-region call journal. Each partner route saves one two-region write. §2, §3, §6, Competition; D7 superseded. |

| Decision | Applied |
|---|---|
| R2-D1 | Accepted; consistent with RQ-7 as decided (the requirement's fence is `D`, the design's `D − τ` is stricter). §4.3. |
| R2-D2 | Accepted, with the binding decision: diverse fibre paths are a go-live condition; a fibre cut is not a declared disaster, and an isolated serving region counts against availability unless its loss is declared. §3, §5.1, R14. |
| R2-D3 | Accepted: 2 + 2 reconfiguration during a declared region disaster. §5.1. |
| R2-D4 | Accepted: the replica rule, with the lease check and, added here, the report position that makes RQ-10 hold. §4.6. |
| R2-D5 | Accepted: request-scoped releases with tombstones until `D` + `release_grace`; sized at a few MB on the hottest link. §4.3, §6. |
| R2-D6 | Accepted: payments by (provider, transaction reference); Share-only movements homed by the causing buyer, otherwise by hash; supplier-only movements without a causing buyer stay with their supplier. §2, §4.4. |
| R2-D7 | Accepted: R1 leads by default until the spike measures each Kenyan region's RTT to R3. §3, R1. |

**Verification of revision 3 (revision 3.1).**

| Defect | Change in this revision |
|---|---|
| V-01 | Status replicas hold **read leases** (at most `status_staleness` − ε, renewed on heartbeats); the report position advances to P only once a majority of voters knows P committed and every leased replica has applied P (or its lease expired); replica rule 2 is now "holds a live read lease → `pending`"; a replica without one goes to rule 3 or 4. §4.6, A10. |
| V-02 | The edge's synchronous final answer is a report and is gated on the report position, as are replicas, the outcome feed and webhooks; A10 restated. The report delay is restated as one majority round trip (about 10 ms steady, 65 to 70 ms with a region lost, est.) and added to the latency tables and Benefits: single-link about 105 ms from R1, 115 ms from R2, 135 ms with drift, 280 ms (R2 lost) and 300 ms (R1 lost); rejection likewise; route report about 70 ms. Fibre-cut rows and R13 updated (the two-write lever is about 210 ms). The alternative of refusing instead is in Competition. §3, §4.6, §5.1, Benefits, R13. |
| V-03 | Partner adapters refuse (journal as refused, never send) a confirm or final booking for a tombstoned request, past `D − commit_margin` less the partner-skew budget by the adapter's clock, or with an account-owner term lower than the highest recorded for the request; a new leader's resume query is an adapter log entry recording its term; any partner booking found for a tombstoned request is cancelled at once at Share's cost. Added to the partner port invariants. §3, §4.3, §8. |
| V-04 | Payments state partitioned per kind: payment events, reference bindings and orphan reversals by (provider, transaction reference); invoices, invoice payments as applied and write-offs by account; reconciliation runs by day. Transfer confirmations and failures moved to payouts (their only writer), keyed by the instruction reference with the provider reference recorded. §2, §4.4. |
| V-05 | The binding is made only by the first authenticated **and well-formed** event; malformed events are recorded and rejected without a binding (P4-S05). §2, §4.4. |
| V-06 | Worst case restated: `δ_x` ≈ 70 + 10 + 70 = 150 ms (R1 lost), `ε + δ_x` ≈ 190 ms, a 10 ms margin to `τ`; RFC-006 alarms on the monitored invariant before the margin is used up. §4.3. |
| V-07 | The 2 + 2 change is specified as single-voter steps (add C2 as learner, promote, remove B1, remove B2; reversed on restoration), with joint consensus as an equivalent alternative for RFC-006; all survivors are needed until step 3, so the change starts at once on declaration, the placement log first. §5.1. |
| V-08 | §4.2 adds the account partition failing over before the deadline (RQ-12, bounded by the 1 min RTO); RQ-12 moved to Resolved (v1.5, review 09); P2-S107 cited in §4.3 and §4.2, P2-S108 in §4.6, P2-S109 and P2-S110 in the fence bullet and §3, P2-S111 in §4.2 and §4.6. Header rebased on `requirements-v1.5`. |
