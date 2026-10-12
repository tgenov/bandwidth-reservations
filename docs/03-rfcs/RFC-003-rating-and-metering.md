# RFC-003. Rating and metering: exporter logs, exact charge lines, amended by total

| | |
|---|---|
| Status | **Accepted, revision 6.** Accepted on 2026-10-13 after the post-C4 errata pass: it conforms to the frozen contracts C01 … C12 and requirements-v1.11, with coverage clean; no separate fix verification (orchestrator decision, to start C5 and C6). Revision 6 rebases the RFC on `requirements-v1.11` ([review 65](../reviews/65-requirements-amendments-after-c4.md): P3-S76, P3-S77 and P3-S78 are new, P3-S28 and P3-N3, P3-N7, P3-N10 changed) and on RFC-000 revision 4.5 (its "Revision 4.5 errata", RFC-003 row). It applies every erratum, consumer obligation and settled item that names RFC-003 in the frozen contracts C01 (§10.3, M5, M7, M11), C03 (M2, rule 5, R39-20), C04 v2.3.1 (MM-1 … MM-5, MM-12, consumer obligations), C05 (S-4), C06 (C06-M1 … C06-M14, consumer obligations), C08 (target summaries, `operator_check`), C09 v1.1 (consumer obligations), C11 (S-1, S-2, review 41 and review 57 errata) and C12 (S1, V6 d). The contracts are the authority for interface detail: where this RFC and a frozen contract differ, this RFC now agrees with the contract (§7). The contract defects found are under "Contract issues" (CI3-1 … CI3-4). What changed is in "Revision 6 resolution" at the end. History: **Accepted, revision 5** at C3 on [fix verification 29](../reviews/29-rfc-003-fix-verification.md) (W-1 … W-3 applied), with erratum 5.1 ([review 32](../reviews/32-rfc-001-fix-verification.md) V-5 and V-3); revision 5 rebased on `requirements-v1.9` ([review 28](../reviews/28-requirements-amendments-from-c3-round-2.md)), RFC-000 revision 4.3 and RFC-006 revision 4; revision 4 was accepted at C3 on [fix verification 24](../reviews/24-rfc-003-fix-verification.md) and applied [review 19](../reviews/19-rfc-003-review.md) (F3-01 … F3-20; D-19-1, D-19-3 … D-19-8) on `requirements-v1.8` and RFC-000 revision 4.2; revision 3 rebased on `requirements-v1.7` and RFC-000 revision 4.1; revision 2 on `requirements-v1.6` and RFC-000 revision 4 (distributed SQL substrate, NestJS owners, Kafka); revision 1 was the rewrite on the accepted architecture (revision 3.2) |
| Satisfies | P3-S01 … P3-S78 (all 78). The metering, attribution and rating parts of X2-S02, X2-S04, X2-S09, X2-S10, X2-S11, X2-S12, X2-S13, X2-S14, X2-S19, X2-S20, X2-S22 and X2-S23 (the rest of each is RFC-006's). The validation parts of X1-S12 (finance: price corrections, quarantine attribution and its reversal, `usage_rate_cap`) and X1-S31 (commercial: prices, split weights, partner terms). The metering parts of X1-N11 (no personal data outside the erasable store: non-conforming payloads, P3-S71, P3-S75). Inputs to P4-S15 and P4-S16 (headroom itemised; the 430 s lateness bound is RFC-004's to compute, by the definition of §5.9), P4-S110 and P4-S115 (the dearer-path amount, against the buyer's charge as booked) and P4-S116 (a downward cost-line amendment with its cause); RFC-004 satisfies them. See the traceability table at the end |
| Policies | POL-01, POL-06, POL-07, POL-08, POL-11, POL-12 (weights stored, applied by RFC-004), POL-13, POL-14, POL-15 (fee holds, by reference), POL-16, POL-17, POL-18, POL-19, POL-20, POL-23, POL-26 (by reference), POL-27, POL-28, POL-29, POL-30, POL-32, POL-33 |
| Prior decisions | History log D10 (facts first), D18 (raw records, deduplicated by identity), D19 (amend, never edit; bound the exposure), D20 (price by usage time), D25 (amend by the line's new total), D27 (the bound covers the wait before charging). D26 (minute lock) and D28 (end-minute assignment) are **not** carried forward; see Competition. Review 19: D-19-1, D-19-3 … D-19-8 (binding) |
| Builds on | The requirements at tag `requirements-v1.11`, which decide this RFC's earlier issues (RQ3-1 … RQ3-17, RQ-19-1 … RQ-19-5; see "Requirements issues") and the C4 contract issues that touch it (RQ41-1 … RQ41-3, RQ-36-3, RQ-48-1, RQ-44-1; [review 65](../reviews/65-requirements-amendments-after-c4.md)); [RFC-000](RFC-000-architecture.md) revision 4.5: its components (metering ingestion, attribution and quarantine, rating, catalogue), their ownership and partitioning (§2), principles A1 … A11 (§1), idempotency and ordering (§4.4, §4.5), the topology (§5.1), the substrate mapping (§5.5), the sizing (§6), the allocation (§7) and the contracts (§8), with every earlier resolution of this RFC's architecture issues (AI3-1 … AI3-15, AI-19-1, AI-19-2); and the **frozen contracts** that govern every interface of this RFC: [C01](../04-delivery/contracts/C01-platform.md) v1 (owner runtime, closure, alerts, probe designation), [C03](../04-delivery/contracts/C03-link-schedule.md) v2.4 (link schedule feed), [C04](../04-delivery/contracts/C04-reservation-feeds.md) v2.3.1 (reservation lifecycle feed), [C05](../04-delivery/contracts/C05-funds-and-standing.md) v1 (usage-applied recovery), [C06](../04-delivery/contracts/C06-usage-and-charges.md) v1 (catalogue, unposted usage, charge lines, posting acknowledgements, reports, evidence, `resolve_parked`; provided here), [C08](../04-delivery/contracts/C08-identity-and-access.md) v1.1 (principal context, operator envelope, target summary, read grant, audit), [C09](../04-delivery/contracts/C09-personal-data-store.md) v1.1 (`put_payload`, `withdraw_payload`, `digest_key`), [C11](../04-delivery/contracts/C11-metering-ingress.md) v1 (ingestion protocol, metering hand-off, attribution keys, part batches; provided here) and [C12](../04-delivery/contracts/C12-partner-port.md) v1 (partner terms and delivered figures). The substrate is [RFC-006](RFC-006-availability-and-operations.md)'s as C01 states it: self-outboxed log tables and slot groups |
| Specifies | Per RFC-000 §7: metering ingestion; attribution and quarantine; rating; the catalogue except its link registry (RFC-001); the quarantine and breach report feeds and the evidence query |

Terms are used in the sense of the [glossary](../02-specs/glossary.md): "reserved rate" is
capacity, "traffic" is bytes, and neither is called "usage". Every volume, rate, latency
and size marked **est.** is an estimate from POL-06's provisional design load and the
stated assumptions, to be replaced by measurement (Risks, R3-1).

## Need

P3 asks for a pipeline that turns two very different inputs into charges that are exact,
exactly once, reproducible and never rewritten:

1. **Reservation history** (from the account owner): every minute a reservation is active
   accrues, per part, reserved rate × that part's price (P3-N1), following every change
   from its effective minute, with no minimum term, at prices locked at booking or added
   with the part (POL-27, POL-08), re-priced for an open-ended reservation from a notified
   change's effective minute (POL-27), at the lower price after a move to an equivalent
   path (POL-07), and nothing for a maintenance booking. At the design load this is about
   **1 M reservation lines/s** (RFC-000 §6, est.), each posted within 2 min of its
   minute's end at 99.99% of minutes (X2-N3).
2. **Flow records** (from exporters): about 260,000 records/s, 600,000/s at peak (POL-06),
   delivered at least once, late, out of order, sometimes unreadable or not conforming to
   the record template (and then possibly carrying personal data, which may live only in
   the erasable personal-data store, P3-N7, X1-N11), sometimes wrong and later corrected
   by their own exporter in their measured fields only (POL-23), reported by several legs for the same traffic,
   spanning minutes, from exporters whose counters wrap and restart. Each must be
   acknowledged only once durable in two regions, within 1 s (X2-N1, X2-N4), kept for 7
   years with its outcome (P3-N7, X2-N6), identified uniquely for those 7 years "whatever
   the exporter's counters do" (P3-N3), attributed to an account, route, product and
   reservation or quarantined (P3-N6, P3-N13), spread over the minutes its flow was active
   (P3-N4), priced at the price of its own minute (P3-N5), counted in its account's
   headroom within `attribution_lag_max` (10 s) of acceptance (P3-N10, X2-S22), and
   charged once per route at the egress count (P3-N13).

The outputs are charge lines of three kinds (POL-11: reservation, usage, fee), each
computed exactly and rounded down once (fees exact), and **amendments** that restate a
line's new total less what was charged (P3-N8), each with its reason and, when downward
and caused by someone, its cause; the inputs to the usage exposure part of headroom
(P3-N10, POL-14, POL-18); the amounts of the costs Share bears that only rating can
compute (carried excess, the dearer-path difference, Share-borne partner fees); breach and
quarantine reports; and the evidence query (P3-N11). The catalogue (prices and their
corrections, weights, partner terms, `usage_rate_cap`, probe designations) is reference
data every owner prices, splits or validates against (RFC-000 §2).

What makes it hard is the combination: exactly-once over a 7-year identity space at
600,000 records/s; exact rational arithmetic (a 70-second flow puts 4/7 of its bytes in
one minute, P3-S51) that must give the same result in any arrival order (P3-N3); charges
that must be final enough to post within minutes yet amendable for late traffic,
corrections, superseding records and reversed attributions; a headroom input that must be
within 10 s of acceptance, exact against the ledger balance, while the classification of a
byte (covered, burst, excess, outside a reservation) depends on totals not yet known; and,
in revision 2, doing all of it on a general-purpose distributed SQL database and Kafka
rather than a purpose-built log platform.

## Approach

### 1. Shape of the design

```mermaid
flowchart LR
  EXP["Exporters"] -->|"ingestion protocol (§3.1)"| ED["Edge (exporter sessions)"]
  ED --> MI["Metering ingestion<br/>by exporter: ingestion log table,<br/>identity range sets"]
  MI -. "metering hand-off (Kafka)" .-> AQA["Attribution, stage A<br/>by exporter: spread, bind, classify;<br/>quarantine, attributions, reversals"]
  PRV["Provisioning (attribution keys)"] -. "binding feed" .-> AQA
  AQA -. "attributed parts (Kafka)" .-> AQB["Attribution, stage B<br/>by account: attribution log"]
  AQB -->|"in-process, after commit"| RA["Rating<br/>by account: lines, amendments,<br/>cost lines, exposure inputs"]
  AO["Account owner"] -. "reservation lifecycle feed<br/>(resolved timestamp)" .-> RA
  LO["Link schedule owners"] -. "link schedule feed<br/>(affected sets, final steps, closed time)" .-> RA
  CAT["Catalogue<br/>by entity"] -. "catalogue feed" .-> RA
  CAT -. .-> AQA
  AO -. "lifecycle feed" .-> CAT
  RA -. "charge-line feed:<br/>reservation batches, usage batches" .-> ST["Settlement (RFC-004)"]
  ST -. "posting acknowledgements" .-> RA
  RA -. "unposted-usage feed" .-> AO
  AO -. "usage-applied acknowledgements" .-> RA
  CON["Operator console and approvals"] --> CAT
  CON --> AQA
  MI -. "log table, changefeed" .-> HI["History (RFC-006): sealed segments"]
  MI -->|"put_payload (non-conforming payloads only)"| PDS["Personal-data store (RFC-005)"]
```

Dashed arrows are Kafka topics fed by the **transactional outbox** (RFC-000 §5.5): the
event is a row committed in the same database transaction as the fact, published by the
owner after commit and relayed again by a database changefeed as the guaranteed path;
consumers apply per producer partition in sequence order and drop duplicates by
(partition, stream, `stream_seq`) (C01 M5; RFC-000 revision 4.5 A6), the `EventId` of
C06 and C11. Every component below is an
owner kind whose partitions are single-writer state machines over **insert-only log
tables** in the database, written by the NestJS instance holding the partition's slot
**owner lease**, every write a transaction conditional on the lease **epoch** (RFC-000 A2,
§5.2); every range has five voters, 2 + 2 + 1, so every commit is durable in two regions
(A3, §5.1).

The split of work follows what each decision depends on:

| Decided by | Depends only on | Never depends on |
|---|---|---|
| Metering ingestion: accepted, duplicate or rejected; the record's identity; whether a corrected or superseding version is accepted | The record and the exporter's own history | Reservations, provisioning, prices (so ingestion stays at 99.99% when they are unavailable, RFC-000 §2) |
| Attribution: which minutes, which account, route, product, reservation reference, which observation point is the egress, which **traffic class** of POL-17; quarantine, finance attributions and their reversals | The record, the provisioning bindings, the catalogue's probe designations, finance commands | Reservation history, prices |
| Rating: POL-17's **rule** (covered, burst, excess, outside an active reservation); every amount | Attributed parts, reservation history, prices and corrections, fees shown | The network |

This is RFC-000 §2 as revision 4 states it (AI3-1, resolved): attribution fixes the class,
rating applies the rule.

#### 1.1 On the substrate (RFC-000 §5.5)

| Component | Partition and slot | Log table (insert-only) and projections | Feeds out | Standby |
|---|---|---|---|---|
| Metering ingestion | By exporter; 128 slots (est.), hot exporters in a slot alone | `ingest_log` (batch, epoch, wrap, correction, supersession, identity-conflict, checkpoint entries); projections: identity range-set chunks, epoch table, wrap anchors, corrected and superseded references | Metering hand-off and the non-conforming drop report (§3.3): `ingest_log` is declared **self-outboxed** (RFC-006 revision 4 §3.5): its changefeed runs on the log table itself and the relay derives each destination event from the row, beside the owner's direct publish, so a batch is written once, not twice. As RFC-006 §3.5 gives it: 25 h `gc.ttlseconds`, the truncator never deletes a row within 1 h of the changefeed's oldest consumer position, and the relay drops delete events | Warm: tails the projections; takeover about 5 s (est.) |
| Attribution, stage A | By exporter, the same slot map as ingestion | `attr_a_log` (processed, binding fact, quarantine, pending, attribution, reversal entries) | Attributed parts per account (outbox), watermark heartbeats | Hot, 3 s lease (RFC-000 §2) |
| Attribution, stage B | By buyer account; 256 slots (est.); stage B slot *i* and rating slot *i* form a **slot group** (RFC-006 revision 4 §7.1) | `attr_b_log` (part batches, producer watermarks, attachment set) | In-process hand-off to rating, after commit; the table is the guaranteed path | Hot, 3 s lease; one standby process per role for the group |
| Rating | By buyer account, the **same slot map as stage B**; the slot group (stage B *i*, rating *i*) is acquired, handed off and taken over together, in one transaction or not at all (RFC-006 §7.1, §12.2: `onAcquire` once per slot, both before the group serves), so both leases are always held by one process | `rating_log` (inputs, accrual-closed, usage-closed, amendment, fee, emitted, posted, breach, checkpoint entries) | Charge-line feed (reservation batches and usage batches, §5.8), unposted-usage feed, breach report feed | Hot, 3 s lease |
| Catalogue | By entity | `catalogue_log` per entity kind; projection: current versions | Catalogue feed | Warm |

**Slot batch transactions.** An owner commits, per slot, one batch transaction at a time
carrying the pending entries of every partition of the slot (each partition keeps its own
contiguous sequence and head row, so at most one transaction is in flight per partition).
Committing per partition instead would cost on the order of 10⁵ transactions/s for
metering and rating alone (est.); per slot it is about 24,000/s (§1.2). RFC-000 revision
4.1 makes this the owner runtime's rule (§3, §5.5; AI3-11, resolved).

**Time on the substrate.** An entry's timestamp is its transaction's **commit timestamp**
(the database's hybrid-logical clock), monotone per partition across owner changes
(RFC-000 §4.5). Closure uses **resolved markers per destination partition** (RFC-000
revision 4.3 §4.5, §5.5, AI-27-3): the marker a consumer reads on a destination (Kafka)
partition says "every row of every changefeed partition that can feed this destination,
committed at or below T, has been published"; the relay computes it as the minimum of
those changefeed partitions' resolved timestamps and emits it only after publishing every
such row. Every closure of this RFC (§4.2, §5.6, §6.4) takes **only** these markers as
given; no consumer here combines raw changefeed resolved timestamps itself. The markers
come from C01's closure emitter, on a closure topic that only the emitter writes; the
runtime gives them to the owner through `onResolved` (C01 §3.6, M7). This RFC declares
closure on the streams it produces that have consumers which close on them: the metering
hand-off (`ingestion.handoff.v1`), the catalogue (`catalogue.v1`) and the topics C06
marks "Yes" (C06 topic table). There is one relayed owner kind for each closure topic
(AI-55-2).

**Personal data** (A11). No table or topic of this RFC holds personal data: exporters,
accounts, suppliers and operators appear by pseudonymous identifiers; every entry's payload
is encrypted by the owner with keys held in Kenyan HSMs (RFC-005, AI5-3), so R3's replicas
and Kafka hold ciphertext. Flow records must not carry personal data (§3.1). The residual
case, a received payload that does not conform to the record template, never reaches a
table or topic of this RFC: its payload goes to the personal-data store through RFC-005's
`put_payload` (into a bucket per exporter and hour) **if it is kept**, and the log keeps its
identity, keyed digest and reason, always, and nothing more of it (§3.3; P3-S71, P3-S75,
POL-19 as `requirements-v1.9` states it; RFC-000 A11 as revision 4.1 states it, AI3-12,
resolved; the store's expiry, AI3-13, resolved in revision 4.2; the call's scope and
signature, AI3-14, resolved in revision 4.3).

**Runtime results, moves and commands (C01 §10.3, C4-7).** Every owner kind of this RFC
(ingestion, stage A, stage B, rating, catalogue) handles the runtime results as C01 gives
them:

| Result or hook | What the owner does |
|---|---|
| `Moving` | The caller tries again. Ingestion does not acknowledge the batch; the exporter sends it again (C11 Part I). A rating or stage B consumer does not commit its Kafka offset |
| `Stopped` (integrity stop) | The owner decides nothing for the slot. Ingestion answers the exporter `notice{waiting}` and does not acknowledge. A consumer holds its position and sends an alert, with no tight loop of retries. Commands to the owner get "temporarily unavailable" |
| `onMovedOut(partition)` | The owner cancels the partition's timers (drop-count flush, pending withdrawals, `binding_grace` holds, usage-close timers) and stops deciding for it. A hot exporter moved to its own slot is the usual case |
| `onAdopt(partition, g)` | The owner rebuilds the partition's derived state from its projection rows and log, writes its takeover entry in the first batch, and re-arms the timers from state (pending withdrawals, holds, missing `drop-count`) |
| Commands it sends | Every command between owners carries C01's `CommandEnvelope` with (generation, epoch); as a receiver (`resolve_parked`, operator commands) it calls `admitCommand` (C01 CC-5, R47-10 c) |

`ingest_log` is declared self-outboxed with three streams (hand-off, drop alert, drop
report), each with its emit function, and with a declared `ingest_stream_index`; the
`ingest` relay holds the log key (C01 R47-19; RFC-005 key release).

#### 1.2 Sizing at the design load

| Item | Estimate | Section |
|---|---|---|
| Records | 260,000/s, 600,000/s peak; about 60 MB/s raw, 20 MB/s compressed at peak | §3.6 |
| Ingestion transactions | One in flight per slot at about 30 ms a commit: about 33 per slot per second × 128 slots ≈ **4,300/s** (est.), about 140 records (about 14 KB raw, 5 KB compressed) each at peak | §3.6 |
| Stage A transactions | ≈ **2,600/s** (a processed entry per slot every 50 ms) | §4.5 |
| Stage B transactions | ≈ **8,500/s** (256 slots, one commit at a time each) | §4.5 |
| Rating transactions | ≈ **8,500/s** (est.), carrying about 1,700 accrual closures, 1,700 usage closures, 300,000 applied parts and about 25,000 exposure figures a second | §5.11 |
| All transactions of these components | About 4,300 + 2,600 + 8,500 + 8,500 ≈ **24,000/s** (est.) | R3-12 |
| Database write volume (logical) | About 20 MB/s of records, 12 MB/s of parts, about 18 MB/s of rating entries (10 MB/s of reservation lines, 8 MB/s of usage lines with their ELAs) at peak (est.); × 5 replicas for replication | §3.6, §4.5, §5.11 |
| Kafka | Hand-off about 20 MB/s, parts about 12 MB/s, figures about 25,000 small events/s (at most one per account every 2 s), about 1,700 reservation batches/s and 1,700 usage batches/s (est.) | §3.6, §4.5, §5.8, §5.9 |
| Non-conforming payloads to the personal-data store | Rare: a misbehaving exporter's refused data sets; at most RFC-005's caps (10 puts/s and 256 KB/s per exporter, 1,000/s and 4 MB/s overall, 64 KB a payload), about 0 in steady state; beyond them dropped and counted, one `drop-count` entry per exporter with drops per hour (at most 10,000 an hour, est.) | §3.3 |
| Live tail in the database | A few hours of `ingest_log` (est.; RFC-006 sets it), sealed to object storage every 15 min (est.) | §3.7 |

Every row is an input to RFC-006's re-costing of the database and Kafka (RFC-000 §5.5,
item 7) and to its load test (X2-S04).

### 2. Conventions: time, money and exact arithmetic

**Time.** All times are UTC. Flow times are carried at millisecond resolution; a record's
absolute start `s` and end `e` are derived from the export message as §3.1 states. Minute
`m` is the half-open interval `[m, m + 60 s)`. `floor_min(t)` is the minute containing
`t`; `ceil_min(t)` is the first minute boundary at or after `t`. The **acceptance time**
of a record is the commit timestamp of the ingestion entry that accepted it.

A record's **last minute end** is `ceil_min(e)` when `e > s`, and `floor_min(s) + 60 s`
when `e = s`: the end of the last minute it was active in. Its **lateness** is its
acceptance time less its last minute end (POL-14, RQ3-9 as decided; P3-S68: a flow active
10:00:00 to 10:02:00 has last minute end 10:02, so arriving at 10:04:50 is 170 s late).

**`dispute_window` (POL-17, RQ3-6 as decided).** For a minute `m`, the window ends at
`window_end(m) = m + 60 s + dispute_window`. An action on traffic or a charge of minute `m`
(a finance attribution, its reversal, a price correction) is within the window when the
**commit timestamp** of the entry that accepts it is before `window_end(m)`; for a range of
minutes, every minute must be. The owner checks it against its clock before proposing and
the transaction re-checks it against its commit timestamp, as RFC-000 §4.3 does for the
confirm fence, so the boundary is exact (P3-S70: 10:00:59 on day D + 30 accepted for the
minute 10:00 of day D; 10:01 refused). For a superseding record (§3.3) the window runs from
the original's last minute end.

**Money.** Amounts are integer micro-USD (POL-11, POL-20). **Prices** are stored exactly as
integers in **pico-USD** (10⁻⁶ micro-USD) per unit: per Mbps-minute for
`reservation_price`, per GB (10⁹ bytes) for `usage_price`. Integer micros per Mbps-minute
would be too coarse for real prices (0.50 USD per Mbps-month is about 11.57 micro-USD per
Mbps-minute); six further decimal places make every realistic price exact. No floating
point is used anywhere. (On the substrate, amounts and prices are `INT8` or `DECIMAL`
columns with scale 0; NestJS code uses `bigint`, never `number`, for them.)

**The line formulas** (POL-11), with `⌊·⌋` rounding toward minus infinity:

| Line | Exact value (pico-USD) | Charge (micro-USD) |
|---|---|---|
| Reservation line (r, m) | `V = Σ over parts p active at m of rate_p(m) [Mbps] × price_p(m) [pico/Mbps-min]` | `⌊V / 10⁶⌋` |
| Usage line (account, product, route, m) | `V = usage_price(product, route, m) [pico/GB] × X / 10⁹`, with `X` the line's usage-priced bytes, an exact rational | `⌊V / 10⁶⌋ = ⌊price × X / 10¹⁵⌋` |
| Fee line (r, fee) | The shown amount | Exactly the shown amount, no rounding |

Checks against the spec: 150,000 bytes at 10,000 micro-USD/GB is exactly 1.5, charged 1
(P3-S21, P3-S48); 99,999 bytes is 0.99999, charged 0 (P3-S21); 3 GB × 40/70 at 10,000 is
17,142.857…, charged 17,142 (P3-S51); 100 Mbps × 2 micro-USD is 200 (P3-S01); 150 Mbps ×
3 micro-USD is 450 (P3-S64).

**Exact line accumulator (ELA).** A usage line's bytes `X` is a sum of integers (records
within one minute) and of fractions `b × t_i / D` (a spread record's part: bytes `b`,
milliseconds active in the minute `t_i`, total active milliseconds `D`, POL-13), with signs:
a superseded record or a reversed attribution contributes its parts negated (§3.3, §4.4).
Summing fractions with different denominators exactly would grow without bound, so the
accumulator keeps:

- `S`, an unbounded integer: the whole bytes;
- a map `d → r_d` with `0 ≤ r_d < d`: for each reduced denominator `d`, the sum of the
  numerators of fractions with that denominator, whole multiples of `d` carried into `S`.

`X = S + Σ_d r_d / d` exactly. Adding a fraction, of either sign, is O(1) (a gcd, an add
and a carry or borrow), and the result is the same in any order, because addition of exact
rationals commutes (P3-N3). The charge `⌊price × X / 10¹⁵⌋` is computed **exactly, with
`bigint`, always**: `Σ_d r_d / d` is brought to one denominator (the least common multiple
of the line's denominators) and the floor taken by integer division. Node.js has no native
128-bit integer, so a fixed-point shortcut would be `bigint` arithmetic too and save
nothing; one code path is simpler to test (review 19, F3-18). The floor is computed only
when a line closes, when an input changes a closed line, and when a figure of unposted
usage is published (§5.9), and cached per line between changes. Comparisons of `X` with
an integer (the burst threshold, §5.3) are made the same way. The same accumulator holds a
reservation's minute bytes before they are split into covered and above-rate parts.

**ELA size** (est., to be measured; R3-19). Denominators are durations in milliseconds
(at most `flow_active_timeout` + 60 s, so `d ≤ 120,000` and `r_d` fits 32 bits), so an
entry is 8 B. A line has one entry per distinct reduced denominator among its spread
records: typically dozens, an assumed **50** at the design load, about 450 B a line with
`S` and overhead; at worst 120,000 entries (about 1 MB) for a line fed by flows of every
duration. §5.11 sizes memory at the assumed figure.

**Rounding direction elsewhere.** The lateness bound (§5.9; computed by RFC-004) is an
upper bound and is rounded **up** to the micro; a Share-borne cost line (§5.5) is the
difference of two amounts each rounded down once.

### 3. Metering ingestion

**Component** (RFC-000 §2): accept every flow record, durably, exactly as received, and
acknowledge only once it is durable in two regions. **Partition**: one per exporter, many
to an owner slot. **Capability**: usage ingestion, 99.99% per serving region, RTO 1 min
(POL-06).

#### 3.1 The flow-record ingestion protocol (contract owned here, RFC-000 §8)

Routers export over UDP, which has no acknowledgement; producing records is out of scope
(P3). The protocol below is what an **exporter**, the sender Share accounts records to,
must speak. A router able to export reliably may speak it directly; otherwise a relay
next to it speaks it on the router's behalf and *is* the exporter of record. The assumed
source is reliable (P3 constraints): nothing is lost before it reaches the exporter, and
the exporter retransmits until acknowledged. An exporter's credential is managed by its
supplier's administrators, or by network operations for exporters on Share's own network
(POL-32); the credential names the exporter's **owner** (a supplier, or Share), which a
superseding record's cost follows (§3.3).

The wire form is C11 Part I (gRPC stream `share.metering.v1.Ingest/Session` over mutual
TLS); C11 governs every field. The semantics:

| Element | Semantics |
|---|---|
| Session | Mutually authenticated TLS to the ingestion edge of either serving region, with a C08 `device_cert` of kind `exporter` or `probe` that names one **exporter ID**. The edge forwards C08's principal context with every batch; ingestion maps the owner (a supplier, or Share) from its tenant (C11 F41-24). Ingestion reads that context, not an exporter credential cache (F57-18). An unauthenticated session is not accepted and creates nothing. The edge accepts no batch it receives after it applied a revocation, at most 31 s after the revocation |
| Export format | IPFIX or NetFlow v9, **fixed per exporter ID**: the owner records it with the first committed batch and refuses a batch in another format (no acknowledgement, `notice{protocol-error}`). A new format needs a new exporter ID (C11 D57-5) |
| Template | Data records use the **Share metering template** (the *record template* of the glossary), whose field list C11 fixes: flow start and end times, an octet count, optionally a packet count, the interface, the direction, and the service-tag fields of §4.1. Its **measured fields** are the octet and packet counts and the flow start and end times; its **attribution keys** are the observation domain, interface, direction and service-tag fields (glossary, *Flow record*). It contains no element that can identify a person (no IP addresses, ports or subscriber identifiers; A11). A template that declares any other element is **refused for the item**, with the reason, and a data set that uses it is a non-conforming payload (§3.3). Options templates follow C11's options-template rule (F57-07): only scope and the system init time are read and logged |
| Export item | One IPFIX message (or NetFlow v9 packet) **verbatim**, header included, with its **context**: the template, options template and options records in force when the message was first exported, kept by the exporter with the message and sent again byte-identical with it (C11 F41-01). Ingestion decodes and identifies an item from (exporter ID, context, message) only, never from templates of earlier items or sessions |
| Batch | Up to 1 MB (est.) of items with a sender-chosen batch number, used only to correlate the acknowledgement |
| Acknowledgement | Sent per batch only after the transaction holding it has committed (durable in two regions, X2-S14). Lists, per item, how many records were **accepted** (with their identities), how many were **duplicates**, each **rejected** record with its reason, its stable **reject key** and its raw reference, and each refused template. All outcomes are durable; an acknowledged batch never needs resending. There is no negative acknowledgement: an unacknowledged batch is the exporter's to resend |
| Retransmission | The exporter keeps every item (message and context) until acknowledged, buffers at least 1 h at its peak rate (est.), and resends it **verbatim**, to either region, after `ingest_retry_timeout` (2 s, est.) |
| Flow control | Credit is a window of unacknowledged batches and bytes per session (4 batches and 4 MB, est.). A batch's credit returns at its acknowledgement, or `ingest_retry_timeout` after it was sent; then the edge forgets the batch and a resend takes fresh credit (C11 D41-5) |
| Correction message | Carries one or more corrected records and the **reject key** of a **rejected** record, remainder or message of the same exporter that it corrects (§3.3; C11 D41-4, F57-03) |
| Supersession message | Carries a corrected version of an **accepted** record or an accepted correction of the same exporter, the original (by Share's identity or by the exporter's coordinates) and a **version number** `v ≥ 1`, increasing per original. It may differ from the original only in measured fields, its times within the original's minutes (§3.3; C11 F41-06) |

The probe of usage ingestion (X2-S18, X2-S20) sends one record from a designated probe
exporter and succeeds on its acknowledgement within 1 s.

#### 3.2 Record identity (P3 open question 1, decided here)

A record's identity is **(exporter ID, observation domain, epoch, extended sequence)**,
refining RFC-000 §4.4's (exporter, exporter epoch, sequence number) and P3-N3's (exporter,
observation domain, the exporter's counter epoch, the position in the export stream). It
is a function of the exporter ID and the item (context and message) only (C11 F41-01,
AI-41-1), so a byte-identical resend years later has the same identity. Per format (C11
F41-02, AI-41-2):

- **IPFIX**: `(exporter, domain, epoch, k × 2³² + q + i)`, with `q` the message's
  sequence number and `i` the record's position among its data records.
- **NetFlow v9**: the header sequence counts packets, so the identity is
  `(exporter, domain, epoch, packetExtSeq = k × 2³² + q, index i)`. The range set (§3.5)
  holds packet sequences: a packet is resent whole. Each record of a packet that was
  rejected with an identity is in the partition's **rejected-record exception set**
  `(packetExtSeq, i)`; a record is a duplicate when its packet is in the range set and it
  is not in the exception set.

- **Epoch.** The exporter's system init time (IPFIX: information element 160 in an options
  record of the item's context; NetFlow v9: header `unix_secs × 1000 − sysUpTime`) is
  constant for one boot of its counters and differs after a restart. Each (exporter,
  domain) keeps an **epoch table** (log entries, with a projection row per epoch). A
  message takes the **lowest-numbered** epoch whose init time is within `epoch_jitter`
  (2 s) of its own; if there is none, it opens a new epoch with the next number; no epoch
  is ever removed or changed (C11 epoch rule, F57-02, AI-57-2). So a later epoch never
  captures a message an earlier epoch holds, although the derived init time drifts. A
  message with no usable init time (IPFIX) is rejected "no epoch".
- **Context check memo** (C11 F57-09). A relay that lost its stored contexts can resend a
  message with a different init time. The owner keeps a 24 h memo, in a table of the slot's
  store with row expiry, never logged or backed up, keyed by (exporter, domain, export
  time, `q`, 64-bit content digest), holding the epoch the message took. A resend whose key
  is in the memo takes that epoch, and the owner alerts a **context violation** to network
  operations.
- **Extended sequence.** IPFIX and NetFlow sequence numbers are 32-bit and wrap: at
  50,000 records/s an exporter wraps about daily (est.). Within an epoch the partition keeps
  **wrap anchors** `(k, t_k)`: wrap `k` began with a message exported at time `t_k`. A
  message with sequence `q` and export time `t` is placed in wrap `k` = the latest anchor
  with `t_k ≤ t`, except that a sequence in the top quarter of the space (`q ≥ 3 × 2³⁰`)
  exported within `wrap_slack` (10 min) after `t_k` belongs to wrap `k − 1`; a sequence in
  the bottom quarter when the wrap's highest sequence so far is in the top quarter opens
  wrap `k + 1` at `t`. Because the anchor is the *export* time in the message, and
  retransmission is verbatim, a duplicate delivered years later is placed in the same wrap
  as the original. This is sound while the exporter's export clock is monotone to within
  `wrap_slack` and wraps are more than `2 × wrap_slack` apart (fewer than about 3.5 M
  records/s per observation domain), both checked per exporter and alerted when broken.

So a counter restart (P3-S50) gives a new epoch, a wrap gives a new `k`, and neither can
make a new record look like an old one, for any number of years. A collision could still
come from an exporter that violates the protocol (say, one that resets its init time
backwards); §3.5's digest check detects it.

#### 3.3 Validation and outcomes

Every record received gets exactly one outcome, recorded in the same log entry as the
record (P3-N7):

| Outcome | When | Effect |
|---|---|---|
| **Accepted** | Valid, and its identity is not in the range set (§3.5) | Identity added to the range set; the record flows to attribution |
| **Duplicate** | Valid, and its identity is already in the range set | A compact duplicate entry (identity, acceptance time, 64-bit content digest) is kept; nothing flows on (P3-S14, P3-S16) |
| **Rejected**, with reason | One of C11's `RejectReason` values, recorded with its display string: `no exporter` (the header carries no observation domain; unreachable for well-formed IPFIX and NetFlow v9 headers), `no template` (a data set whose template is neither in the item's context nor in the message, or was refused, §3.1; recorded as "does not conform to the record template"), `no sequence number` (unreachable for IPFIX and NetFlow v9), `no epoch`, `negative byte count`, `end time before its start time`, `missing flow times`, `missing attribution key` (for example both interfaces and no direction), `missing byte count`, `flow time in the future` (end later than the owner's clock + `future_skew_max`, 5 min, est.), `unparseable` | The record is kept with its reason and its **reject key** (C11 F57-03: a function of the received item only, so a resend gives the same key); its identity, if it has one, is **not** added to the range set; nothing flows on to charging and nothing is charged (P3-S28). A record that conforms to the template is kept as received; a **non-conforming payload** (`no template`, `unparseable`) is kept in the log only as its identity, keyed digest and reason, the payload itself going to the personal-data store (below; P3-S71) |

Validation is per record. A rejected record never delays the records after it: the rest
of its batch is accepted or deduplicated in the same entry, as if it had not arrived
(P3-S29). A record with zero bytes is accepted (it charges nothing).

**A domain that is not the exporter's (P3-S77; C11 S-1).** Ingestion reads no provisioning
(§3.6), and the C08 credential names no domains. So ingestion accounts every observation
domain in a message to the session's exporter, and rejects `no exporter` only when the
header carries no domain. Attribution stage A decides whether the domain is the
exporter's, from the exporter's own observation-point facts (§4.1). A record from a domain
that no fact of its exporter names is accepted here, kept, and quarantined by stage A with
the reason "domain not of exporter" (§4.2, §4.4). It is charged only if an operator in
finance attributes it within `dispute_window` (POL-17). It is never attributed to another
exporter's observation points.

**Non-conforming payloads: identity, digest and reason always; the payload only in the
erasable store, if kept (P3-S71, P3-S75, P3-N7, POL-19 as `requirements-v1.9` states it;
RQ3-14 and RQ3-17 as decided, AI3-12 … AI3-14 resolved).** A payload **conforms** when it
parses and each of its data sets uses a template the session accepted (§3.1), which by
construction holds no personal data. A data set rejected `no template` (one declaring IP
addresses, say) does not; nor does an `unparseable` remainder of a message, whose content
cannot be shown free of personal data (RFC-000 revision 4.3 §8 names both, AI3-14). Keeping
the payload is **not required** (POL-19): it is kept within the caps the design states and
when the store takes it in time, and otherwise **dropped**, never kept anywhere else, each
drop counted and the count reported to network operations. For each, while the owner
builds the batch's transaction:

1. **Identity and digest.** Its identity is the record identity of §3.2 where the message
   header gives one, otherwise its **raw reference** (exporter partition, the log sequence
   of the `batch` entry being written, and the payload's ordinal among the entry's
   non-conforming payloads). C11 gives the mapping to C09's `RecordId`: the identity ref
   holds the observation domain, the epoch and the sequence, and for NetFlow v9 also the
   record index (C11 F41-15). Its **keyed digest** is HMAC-SHA-256 of the
   payload bytes under the exporter's **digest key**, one per (exporter, version), generated
   in the Kenyan HSMs and released wrapped to ingestion's workload identity by
   `digest_key(exporter[, version]) → (version, key)` (C09; RFC-005 §10); the owner caches
   the current version per exporter in memory (never on disk) and records the **key
   version** beside the digest, so a dispute check uses the same key. The digest is
   **mandatory** (review 29 W-1, coordinator's binding decision):
   - the owner **fetches the current version for every exporter of the slot when it takes
     the lease** (and for an exporter newly assigned to the slot, before serving it);
   - at a **rotation** it keeps signing with the cached version until the new one is
     fetched (every version stays valid for the retention period, RFC-005 §10);
   - if **no version is cached** for the exporter and the fetch fails, the batch holding
     the non-conforming payload is **neither committed nor acknowledged**: the exporter
     retransmits it verbatim after `ingest_retry_timeout` (§3.1), the wait is alerted, and
     only that exporter partition waits (its later batches queue behind it in the slot's
     pending entries; other exporters' partitions commit as usual) until the key service
     answers. During the wait the owner keeps **one** pending batch for the partition (its
     head batch) and drops later batches and copies without an acknowledgement; the edge
     answers each new batch of the partition with `notice{waiting, "digest key"}` (C11
     F57-11). So every non-conforming payload's record holds its keyed digest (P3-S71,
     P3-S75), and every drop has a `record_id` and a keep outcome to count.
   - The key service creates version 1 of a registered exporter's key on the first request;
     `not_found` on the current-version form is an alerted **configuration error**, not
     retried in a loop (C09 R36-12). Keyed, because a plain hash of a short record holding an address could be
   reversed by trying every address; Share, holding the key, can still show that a payload
   presented in a dispute is the one it received. These are computed for every
   non-conforming payload, kept or not.
2. **Put.** The owner calls the personal-data store's
   **`put_payload(record_id, exporter, supplier, account?, received_at, keep_by, payload)
   → kept(bucket) | not_kept(cap | late | erased)`** (C09; AI3-15 as the coordinator decided
   it; RFC-000 revision 4.5 §8), with:

   | Argument | Value |
   |---|---|
   | `record_id` | (exporter, identity or raw reference, keyed digest). The digest makes it content-bound: a raw reference reused after a crash by a different payload, or two different payloads under one identity (a protocol violation), are two items, never one (F3-20) |
   | `exporter` | The session's exporter ID; the store files the item in the **payload bucket (exporter, UTC hour of `received_at`)** |
   | `supplier` | The exporter's **owner** as its credential names it (a supplier, or Share for an exporter on Share's network) |
   | `account` | Omitted: a rejected record is never attributed, and ingestion reads no provisioning (§1, RFC-000 §2) |
   | `received_at` | The time the edge received the batch, as the owner records it in the entry |
   | `keep_by` | The put's issue time on the owner's clock + `pd_put_timeout` − ε (400 ms with ε = `max_offset`, 100 ms): the store commits the item only at a commit timestamp ≤ `keep_by` − ε, otherwise answers `not_kept(late)`, keeping nothing |

   **Precondition** (C09 R36-29): the ingestion owner's host clock is within `max_offset`
   (100 ms) of the cluster's, under RFC-006's clock discipline; a host outside it issues no
   put. The store answers **`kept(bucket)`** (durable in two regions; idempotent by
   `record_id`), **`not_kept(cap)`** when keeping it would exceed a cap (C09 S-M3, S-M1:
   10 puts/s and 256 KiB/s per exporter, 1,000/s and 4 MiB/s overall, 64 KiB per payload,
   so a larger payload is always dropped, and the storage backstop; "the caps the design
   states", review 28 decision 6), **`not_kept(late)`** when it could not commit by
   `keep_by` − ε, or **`not_kept(erased)`** when `received_at` is in an erased range of the
   exporter (C09 R36-09); in each case nothing is kept. The store answers a `not_kept` only
   when its transaction is known not to have committed (C09 R36-05). The owner treats
   `temporarily_unavailable`, `refused` of any kind and a transport error as **unanswered**
   (a `refused` is also alerted as a defect), and an unknown `CapName` or `not_kept` reason
   as `cap`. It may send the same put again only while its clock is before `keep_by` + ε. The store wraps the item's payload key under
   the account key (none here), the **bucket key** of (exporter, hour) and the **expiry key
   of `received_at`'s UTC day**, destroyed at that day's start + `dispute_window` + 7 days
   (RFC-005 §3.7), so the deadline is fixed at the put and no caller acts at expiry. A kept
   answer names the bucket the item is in; for a repeated `record_id` (a resend after a
   crash, possibly in a later hour) that is the first put's bucket, and the entry records
   the bucket the store names, never one computed locally (F3-20).
3. **Commit.** The slot's batch transaction commits once every put of the batch is answered,
   or once `keep_by` + ε (= `pd_put_timeout`, 500 ms, est., after the put) has passed. Its `batch` entry holds, for that
   data set, the identity, the keyed digest, the reason ("does not conform to the record
   template" or `unparseable`), the `record_id` and the **keep outcome**: **kept** (with
   the bucket), **dropped: cap** (`not_kept(cap)` with the cap name, the per-payload size
   included), **dropped: not taken in time** (`not_kept(late)`, P3-S75's second example),
   **dropped: erased** (`not_kept(erased)`), or **dropped: unanswered, withdrawal pending**
   (no answer by `keep_by` + ε, or an answer treated as unanswered; C09 S-M4's label), and
   the digest key version. Nothing more of the payload
   is in the entry (P3-S71). The message is kept with the non-conforming sets cut out
   (header, template sets and conforming data sets verbatim, so the conforming records'
   identities and digests are unchanged).
4. **Acknowledge**, as for any batch, after the commit.
5. **Withdraw every unanswered put** (P3-S75; C09). For each payload recorded
   "unanswered, withdrawal pending", the owner sends `withdraw_payload(record_id,
   received_at)` (C09 R36-14) after the commit, off the acknowledgement path, retrying with backoff until answered
   `withdrawn(was kept | was absent)`. The store deletes any item a late put committed and
   writes a tombstone until the receipt day's expiry, so no retried or later put can keep
   it. The answer is recorded in a `withdrawn` entry (`record_id`, was kept or was absent).
   Of `kept` and `withdrawn` for one `record_id`, the **later entry in the log is
   authoritative**: a `kept` answer to a resend, followed by the withdrawal of the earlier
   unanswered put, leaves the payload withdrawn, and the evidence path treats `not_found`
   after `withdrawn` as expected (C09 R36-28).
   The pending set is derived state: a new lease holder rebuilds it from `batch` entries
   with a pending withdrawal and no `withdrawn` entry, and resends (idempotent by
   `record_id`). A withdrawal pending more than 10 min (est.) is alerted. Until it is
   answered, the payload can exist only in the erasable store, under its day expiry and
   every covering erasure; once answered, it is kept nowhere.
6. **Count and report the drops** (P3-S75). The count is derived from the `batch` entries
   alone, so it is exact, durable and reproducible:
   - The owner keeps, per exporter of the partition, the number of drops by reason in the
     current **report hour** (the UTC hour of the `batch` entries' commit timestamps,
     which are monotone per partition), in memory and in each `checkpoint`.
   - The **first drop** of an (exporter, hour, reason) makes the batch transaction also
     write a `drop-alert` entry (exporter, reason, the drop's identity and keyed digest);
     the relay derives from it an alert to **network operations** on the alert feed
     (RFC-006), at once.
   - The first batch transaction of the slot committed after the hour's end (or, for an
     idle slot, a marker-only transaction at the hour's end + 1 min) writes, for each
     exporter with drops in the hour, a **`drop-count`** entry (exporter, hour, drops by
     reason, the `batch` sequence range covered, and the withdrawals answered in the hour,
     "was kept" and "was absent"); the relay derives from it the hourly
     **drop report** to network operations (alert feed, RFC-006; also served to the
     operator console). Because every later commit of the partition has a later
     timestamp, no batch of the hour can commit after its `drop-count`.
   - A new lease holder rebuilds the counters from the last `checkpoint` and the `batch`
     entries after it, and writes a missing `drop-count` (it checks the log first, so each
     (exporter, hour) has exactly one). The relay's events are identified by (partition,
     sequence) and deduplicated downstream (RFC-000 §4.4).
   The store's own counts and its daily notice to the supplier (RFC-005 §3.7) remain, but
   they only reconcile: payloads not kept are counted from ingestion's log and reported
   hourly to network operations (C09 consumer obligations; RFC-000 revision 4.5 §8). This
   report carries no payload.

So no log row, hand-off event, alert, sealed segment, application log or trace holds the
payload (RFC-000 A11). Crash points:

| Crash or fault | What happens |
|---|---|
| After the put, before the commit | An item exists that no log names. The exporter resends the unacknowledged batch; an identity-bearing payload gets the same `record_id` and the put is a no-op answered with the first bucket; a raw-referenced one may get a new raw reference and so a second item. An item nothing names is in the erasable store only, unreadable after its day's expiry and erased by any erasure that covers its exporter or supplier |
| After the commit, before the acknowledgement | The resend's conforming records are duplicates; its non-conforming set is rejected again with the same identity and digest (a second rejection entry, charging nothing) and a repeated put, answered as the store now holds it (kept with the first bucket; `not_kept(late)` once withdrawn) and recorded with that outcome; a drop is counted again (the count is of drops, each recorded) |
| After a drop's commit, before its `drop-alert` or `drop-count` reaches the relay | They are rows of the same `ingest_log`; the changefeed relays them (RFC-006 §3.5) |
| Between the hour's end and the `drop-count` commit | A takeover writes it (above); a report later than the hour's end + 1 min is itself alerted |
| Put committed but its answer lost, or not answered by `keep_by` + ε | Recorded "unanswered, withdrawal pending"; `withdraw_payload` deletes any item and tombstones the `record_id` (step 5). A store commit after `keep_by` − ε is impossible (the store's condition), so no item can appear after the withdrawal |
| Crash after the batch commit, before the withdrawal is answered | The new holder finds the pending withdrawal in the log and resends it; until answered the item, if any, is only in the erasable store |
| Key service unavailable at first use (no digest key version cached for the exporter, e.g. right after a takeover whose acquisition fetch failed) | The batch holding the non-conforming payload is neither committed nor acknowledged; the exporter retransmits it verbatim; the wait is alerted; only that exporter partition waits, and it resumes with the first successful fetch. Nothing is lost: an unacknowledged batch is the exporter's to resend (§3.1). With a version cached, a key-service outage changes nothing |
| Store unavailable | Batches holding a non-conforming payload wait at most `pd_put_timeout`, then commit with "dropped: not taken in time" or "unanswered, withdrawal pending", counted and reported; pending withdrawals are retried until the store answers. Conforming batches and the ingestion probe never wait, so usage ingestion's 99.99% and its 1 s acknowledgement do not depend on the store |

**Decision (`pd_put_timeout`).** Waiting longer for the store would keep more dispute
evidence at the cost of acknowledging a misconfigured exporter's batches late, which holds
back its conforming records too; the payload is rejected in any case, its identity, digest
and reason are kept, and POL-19 (`requirements-v1.9`) makes keeping the payload a courtesy
to a dispute, not an obligation. 500 ms (`keep_by` 400 ms after the put, plus ε) keeps the batch's acknowledgement inside
1 s (X2-N4).

**Decision (the drop report).** Counting from the log rather than from a metrics counter
makes the count exact across takeovers and re-derivable by an auditor; an hourly report
with an immediate first alert per exporter tells network operations of a misconfigured
exporter within seconds without one alert per dropped payload (a flood beyond the cap is
up to tens of thousands an hour, est.). The alert names identities and keyed digests only.

**Unrecoverable on an erasure or at its deadline (P3-S71, POL-19 as `requirements-v1.9`
states it).** A kept payload stays readable until the first of:

- **An erasure request that covers it is executed.** A request covers a payload if it
  names the payload's exporter and a period including its receipt, or if it is the request
  of a user of the exporter's supplier (POL-19; no account applies, above). A user's or an
  account's request covers the payloads **received before it is executed**; only a request
  that names exporters and a period covers later ones (POL-19 as `requirements-v1.11`
  states it, RQ-36-3). C09 covers payloads received up to the store's commit + 1 h, which
  covers more and conforms. A payload is one item, so a payload that holds the data of more
  than one person is erased whole (POL-19, RQ-48-1). RFC-005
  executes it: a request naming exporters and a period destroys the bucket keys of those
  exporters for every hour meeting the period; a user's request of the supplier reaches
  every payload of that supplier (D-4). From the erasure's commit no reader
  can get the payload, and every copy is unrecoverable within `erasure_max` (30 days) of
  the request. The identity, digest and reason stay in the log, so no record's evidence
  beyond its payload is lost.
- **Its deadline.** The expiry key of its receipt day is destroyed at that day's start +
  `dispute_window` + 7 days, which makes it unrecoverable **in every copy** (live store,
  backups, escrow) at most `dispute_window` + 7 days after receipt and at least
  `dispute_window` + 6 days after it (RFC-000 §8 revision 4.2, personal-data store,
  **expire**; RFC-005 §3.7).

**Reading one.** For a dispute about a rejected payload, an operator in finance or support
with a read grant for the purpose (RFC-005 §7.6, POL-32) reads it through the operator
console by `record_id`, with the C09 purpose `flow_record_dispute`; the store audits the read and
the payload is held in memory for the request only. After the payload is gone, or if it was
not kept, the identity, keyed digest and reason still answer whether a presented payload is
the one rejected; the check calls `digest_key(exporter, version)` with the **recorded**
key version (C09 S-G3).

**Only the producing exporter corrects (P3-S30, P3-N7, POL-23; RQ3-2 as decided).** A
corrected version of a record is accepted only on a session of the exporter that produced
the original, under its own credential: the raw reference or identity it names must be in
the session's own exporter partition. A correction or supersession naming another
exporter's record is **rejected** "not this exporter's record", kept with that reason in
the sender's partition, and recorded as a refused attempt (audit fields of the entry,
RFC-005). There is no operator path: the operator console offers no command that submits,
edits or removes a record's contents, and an attempt through it is refused there and
recorded as a refused privileged attempt (RFC-005, X1-N8).

**Corrected records: a rejected record made usable (P3-S30, P3-S78; POL-23, RQ41-2 as
decided).** A correction message names the rejection by its **reject key** (C11 F57-03)
and carries the corrected record, or one or more records for a rejected remainder or a
whole message (C11 D41-4). Ingestion makes these checks in this order (C11 Part I,
"Correction"):

| # | Check | Outcome when it fails |
|---|---|---|
| 1 | The reject key is the session exporter's | Refused "not this exporter's record"; a refused attempt is recorded |
| 2 | **Idempotency first** (F57-20): no correction of this reject key is accepted yet | `duplicate` (the first accepted wins). So a retry after the deadline gets `duplicate`, not a refusal |
| 3 | The key names a rejection of this partition | Refused "no such rejected record" |
| 4 | **Deadline** (D57-3, V62-03): the commit timestamp is before `min(last minute end of the rejected record, its first receipt) + dispute_window`; with no usable times, before `first receipt + dispute_window`. The **first receipt** is the commit timestamp of the first `batch` entry that rejected this key; a resend does not move it | Refused "outside dispute_window", recorded, nothing charged (P3-S78 second row) |
| 5 | Each corrected record's flow end is at most the first receipt + `future_skew_max` (F57-05) | Refused "outside the original's receipt" |
| 6 | When the rejected item's header parsed, each record's observation domain equals the header's (F41-26) | Refused "changes an attribution key" |
| 7 | Each record is valid like any record | The whole correction is refused with that reason |
| 8 | A single record that keeps an identity already accepted | `duplicate` |

P3-S78: a record active only in the minute starting 12:05 on day D (last minute end
12:06), first received at 12:07, has the deadline `min(12:06, 12:07) + 30 days` = 12:06 on
day D + 30. A correction at 12:05 on day D + 30 is accepted and its bytes are charged once;
one at 12:06 is refused, recorded, and charges nothing.

Only an accepted correction marks the reject key corrected, in the permanent
**corrected-key index**; a refused one does not, so the exporter can send a new one. A
single record that had an identity keeps it; otherwise each record gets the identity
`(correction, reject key, position)`. In the same transaction an accepted correction marks
its identity accepted: IPFIX adds it to the range set, NetFlow v9 removes it from the
exception set (F57-04). A later copy of the original is then a duplicate, also when it is
inside a corrected remainder or message (V62-06); its digest differs from the correction's,
which is expected and recorded as an informative duplicate, not an identity conflict. A
rejection is fixed only by a correction (F57-19): a later copy of a record rejected "no
epoch" is a duplicate once a correction of its key is accepted. So a correction submitted
any number of times is charged once. The correction entry records the principal, the
certificate serial and the reject key, so a recomputation sees it among the corrected
versions P3-N9 lists.

**Superseding records: an accepted record whose measured fields were wrong (P3-S66,
P3-S72, POL-23; RQ3-11 and RQ3-15 as decided).** A supersession message names an accepted
original of the same exporter, a record or an accepted correction (C11 F41-06), and carries
version `v`. **Idempotency first** (C11 F57-20): a repeat of an accepted `(original, v)`
with the same digest is a `duplicate` before any other check. Then it is validated like
any record, and then every check is made against the **original** (never against an
earlier version, so a chain of versions cannot walk away from it):

| Check | Outcome when it fails |
|---|---|
| The original is accepted in this partition | Rejected "no such accepted record" |
| Acceptance time before the original's last minute end + `dispute_window` (§2), against the commit timestamp | Rejected "outside `dispute_window`": kept, never charged; the original stands (P3-S66 third row) |
| `v` is above every version already accepted for the original | Rejected "version out of order" (a same-digest repeat was already answered `duplicate`) |
| **Identity and attribution keys unchanged**: every field other than the measured fields (§3.1) equals the original's: observation domain, observation point, direction and every service-tag field (the identity is the original's by construction, and the exporter is the session's) | Rejected "changes an attribution key"; the original, or its latest accepted version, stands (P3-S72 fourth row) |
| **Times within the original's minutes**: `floor_min(s') ≥ floor_min(s)` and the version's last minute end (§2) ≤ the original's, so `[s', e')` lies in the original's minutes | Rejected "outside the original's minutes"; the original, or its latest accepted version, stands (P3-S72 third row: moved into the minute starting 12:07) |

Accepted, a `supersession` entry records the original's identity and raw reference, `v`,
the new contents and the exporter's **owner** as the credential names it. Its identity is
`(original identity, "version", v)`; the original's identity stays in the range set, so a
redelivery of the original is still a duplicate. A refused version is kept with its reason
in a `supersession` entry and recorded as a refused correction (audit fields), and changes
nothing. The original is **never altered**; it stays in the log and in evidence beside its
versions. For charging, the latest accepted version replaces the one before it:
attribution negates the parts it had produced and adds the new version's parts **in the
original's disposition for each minute** (same binding, same account and reservation; a
quarantined original's version quarantined in its place; §4.2), and rating amends every
line that changes (§5.7), a downward amendment carrying the cause **the exporter's owner**
(a named supplier, or Share). P3-S72: 2 GB in the minute starting 12:05, superseded by
1 GB (packets changed too) or by an end time moved within that minute, supersedes the
original; one moved to 12:07, or changing a service-tag field, is refused. Because a
version's times stay in the original's minutes, its last minute end, lateness and
`dispute_window` never extend beyond the original's.
P3-S66: 2 GB charged 20,000 micro-USD, superseded by 1 GB within the window, is amended by
−10,000; the supplier owes its reduction when its exporter erred, Share bears it when the
exporter is Share's (settlement, RFC-004).

**Accepted records are never altered or removed (P3-S31).** There is no command that
changes or deletes a log row: no database role is granted update or delete on
`ingest_log` (RFC-000 §5.5). Sealed segments are written to object storage under a
retention lock for 7 years (compliance mode: no principal, operators included, can shorten
it; RFC-006). An attempt through the operator console to alter or remove a record is
refused there and recorded as a refused privileged attempt (RFC-005, X1-N8).

#### 3.4 Entries and state of an exporter partition

| Entry | Contents | Written when |
|---|---|---|
| `batch` | Session, edge region, certificate serial, export format, the hashes of the contexts used, the messages as received (compressed, encrypted payload) with any non-conforming payload cut out, and per record its outcome (accepted, duplicate with digest, rejected with reason; a non-conforming payload as identity, keyed digest with its key version, reason, `record_id` and keep outcome: kept with its bucket, dropped: cap, dropped: not taken in time, or dropped: unanswered, withdrawal pending, §3.3) | Each batch, in the slot's batch transaction, after any put of a non-conforming payload is answered or timed out |
| `drop-alert` | Exporter, reason, the drop's identity and keyed digest | With the first drop of an (exporter, hour, reason) (§3.3) |
| `withdrawn` | `record_id`, was kept or was absent | `withdraw_payload` answered for a put left unanswered by `keep_by` + ε (§3.3 step 5) |
| `drop-count` | Exporter, report hour, drops by reason, `batch` sequence range, withdrawals answered (was kept, was absent) | Once per exporter with drops, after the hour's end (§3.3) |
| `epoch-opened` | Epoch number, init time, first export time | A message with a new init time |
| `wrap-opened` | Epoch, `k`, `t_k` | §3.2 |
| `correction` | Reject key corrected and its raw reference, the corrected records with their identities, the outcome (accepted, duplicate, or refused with its reason), the principal and certificate serial | A correction message |
| `supersession` | Original identity and raw reference, `v`, the new contents, its outcome (accepted, duplicate, or refused with its reason), the principal, the exporter's owner | A supersession message |
| `identity-conflict` | The **conflict identity** (identity and the conflicting record's raw reference), both digests, the conflicting record's fields | §3.5's verifier finds a duplicate whose content differs (C11 S-2, F41-10) |
| `checkpoint` | Snapshot reference of the derived state below | Every 10 s of log or 256 MB (est.) |

`ingest_log` is **self-outboxed** (RFC-006 revision 4 §3.5, §12.1): its declaration names
three streams the relay derives from its rows, the **metering hand-off** (`batch`,
`correction`, `supersession` and `identity-conflict` rows, C11 Part II, S-2), the **drop
alert** (`drop-alert`) and the **drop report** (`drop-count`), each with its versioned emit function; the owner's direct publish
of the hand-off is the fast path and the changefeed the guaranteed one. No outbox table
exists for it, and a truncator delete is never a feed event.

Projection rows, written in the same transaction as the entries they derive from (RFC-000
§5.5): the export format of the exporter; the epoch table and wrap anchors; the
**identity range-set chunks** and, for NetFlow v9, the **exception-set** rows (§3.5); the
permanent **corrected-key index** (reject keys with an accepted correction); the latest
accepted version per superseded original; and the **context table** (each cut context
logged once per partition, keyed by the SHA-256 of the context as received, C11 F57-08).
The 24 h context check memo (§3.2) is a separate table with row expiry, not a projection. The owner
keeps all of them in memory and rebuilds them from the projection rows on taking the
lease. A 24-hour **digest cache** (identity → 64-bit content digest) is soft state on the
owner's local disk.

#### 3.5 Deduplication for 7 years: per-exporter range sets

For each (exporter, observation domain, epoch) the partition keeps a sorted set of
disjoint closed intervals `[lo, hi]` of extended sequence numbers already accepted
(packet sequences for NetFlow v9, with the exception set of §3.2). A
batch's records are mostly consecutive sequences, so checking and inserting a message is
one O(log n) search and at most one merge, in the owner's memory. The set's size is the
number of **gaps**, not of records: a gap exists while a reordered record is still in
flight (it closes when the record arrives) or permanently where a record with an identity
was rejected (rare). After an epoch ends (its exporter restarted), its set usually compacts
to a few intervals.

**Atomicity with the append** (RFC-000 §4.1). The check is made by the single writer, in
memory, and the changed **range-set chunks** (rows keyed `(exporter, domain, epoch, lo)`,
each holding up to 256 intervals) are upserted in the same transaction as the `batch`
entry. Either both commit or neither does, so the range set in the database always equals
the accepted identities in the log; a new lease holder reads it and continues. A deposed
holder's transaction fails the epoch condition (RFC-000 §5.2), so two writers can never
both accept one identity.

| Item | Estimate |
|---|---|
| Records over 7 years | about 5.7 × 10¹³ (260,000/s, RFC-000 §6) |
| Exporters, observation domains | 10,000 exporters, 4 domains each (est.) |
| Epochs over 7 years | With init-time drift of 20 to 50 ppm a domain can open about one epoch a day: about 2,555 per domain → about 10⁸ epoch sets (C11 epoch sizing, AI-57-2; revision 5 assumed 50 per domain) |
| Intervals | An epoch set that is closed compacts to a few intervals; a live set has up to a few thousand for reordering, plus about 10 for rejects with identities (est.) |
| Memory | Only the sets of epochs with an acceptance in the last 24 h are in memory (a few MB per slot, est.); older sets are read from the database, one read per message, as the safeguard below. In the database: at least 32 B per set, more than 3.2 GB in all, about 25 MB per slot (128 slots, est.) |
| Database | About 10⁸ chunk rows, at least one per epoch set; at about 100 B a row about 10 GB per copy, about 50 GB with five replicas (est.); a batch touches one or two chunks per message |
| Safeguard | A set above 10⁶ intervals (a misbehaving exporter) keeps only its recent chunks in memory and reads older ones from the database; checks then cost one read per message, and an alert is raised |

The range sets are kept for the life of the system, not only 7 years: they are small, and
keeping them means a redelivery after the retention period is still a duplicate.

**Duplicate content check.** A duplicate's digest is compared, asynchronously and off the
acknowledgement path, with the original's: from the digest cache when the original is
younger than 24 h (est. about 4 GB per slot on local disk), otherwise by reading the
original from the live tail or its sealed segment (§3.7). A mismatch means two different
records share an identity, which only a protocol violation can cause; the duplicate is then
re-recorded as an `identity-conflict` under a **conflict identity** (the identity and the
conflicting record's raw reference, C11 F41-10), kept in full, sent on the hand-off, routed
to quarantine with reason "identity conflict" under that identity (§4.2), and alerted. A
duplicate of a corrected record differs from the correction by design and is recorded as
an informative duplicate, not a conflict (§3.3). It is never silently treated as the original (P3-N3,
P3-N7).

#### 3.6 Topology, throughput and recovery

- **Voters.** Every range of `ingest_log` and its projections has the database's five
  voters, 2 + 2 + 1, as RFC-000 §5.1 decides for ingestion (revision 1's proposal is now
  RFC-000's). Sealed segments are kept twice, in object storage (RFC-000 A0-16).
- **Slots.** 128 ingestion slots (est.), exporters assigned by hash, hot exporters placed
  alone. Peak load per slot about 4,700 records/s, about 0.5 MB/s raw (est.). The owner
  flushes a slot's pending batches into one transaction when the previous one has
  committed, or every 20 ms or at 256 KB when idle, one in flight per slot. With one in
  flight, a slot commits at most `1 / commit time` transactions a second: about 33 at
  30 ms (RFC-000 §3), so about **4,300/s** in all (est.), each about 140 records (about
  14 KB raw, 5 KB compressed) at peak. A hot exporter at 50,000 records/s fills its own
  slot's transactions with about 1,500 records (150 KB raw, about 50 KB compressed); rows
  are chunked at 256 KB.
- **Acknowledgement latency** (est., p99): edge 5 ms + forward to the owner in the leader
  region up to 10 ms (an R2 edge) + wait for the transaction in flight up to 30 ms + commit
  30 ms (RFC-000 §3) + response 10 ms = **about 85 ms** steady (an idle slot's 20 ms flush
  replaces the in-flight wait); about 200 ms after a region loss (commits at about
  75 ms). A batch holding a non-conforming payload adds at most `pd_put_timeout` (500 ms).
  The probe limit is 1 s.
- **Throughput.** 600,000 records/s is 60 MB/s raw (100 B each, RFC-000 §6), about
  20 MB/s compressed in the database, about 100 MB/s of replication traffic at five copies
  before storage-engine amplification; RFC-006 costs the nodes. The metering hand-off is
  derived by the relay from `ingest_log`'s own changefeed, the table being self-outboxed
  (§3.4; RFC-006 §3.5), with the owner's direct publish as the fast path (accepted records
  only are applied by stage A), about 20 MB/s in Kafka at peak. The table keeps 25 h of
  MVCC history so a recreated changefeed finds its rows, and the truncator keeps at least
  the hour behind the changefeed's oldest consumer position (RFC-006 §3.5, §13.2).
- **Recovery.** A slot's lease holder fails: a warm standby in the other Kenyan region,
  which tails the slot's projection rows, takes the lease after expiry (3 s) and resumes:
  about **5 s** (est.), within the 1 min RTO (X2-S10). Nothing committed is rebuilt.
  Exporters resend unacknowledged batches after 2 s, to either region; the range sets
  deduplicate them. Ingestion may lag (credit runs out, exporters buffer), but an accepted
  record is never lost (X2-S02, X2-S09, X2-S12). A region loss moves every lease to the
  surviving region with the database's leaseholders (RFC-000 §3).
- **Independence.** Ingestion reads nothing but its own tables and the principal context
  the edge forwards with each batch (C11 F57-18): no reservation, provisioning, catalogue
  or rating state (RFC-000 §2).

#### 3.7 Retention and evidence

**Sealing** is RFC-006's history service (RFC-000 §5.5): it reads `ingest_log` by follower
reads below the closed timestamp (RFC-006 revision 4 §3.5, §13.2; not through the
changefeed), seals every 15 minutes of an exporter's log (est.) into a columnar segment in
object storage replicated in two regions, verifies it, and only then is the live tail
truncated. This RFC fixes what a segment must contain for the evidence query: records
sorted by (observation point, attribution key, flow start), per-block minimum and maximum
statistics, and a sparse identity index (epoch, sequence range → block); every outcome
kept, rejected records with their reasons (a non-conforming payload by its identity, keyed
digest and reason only, §3.3), duplicate entries, corrections and superseding versions,
accepted or refused, beside their originals; and the logged contexts, so that evidence
and a recomputation decode each record from its own context (C11 F57-08). Payloads stay
encrypted under RFC-005's keys. Storage
over 7 years: about 5.7 PB per copy raw, about 2 to 3 PB per copy compressed (est.).

**Evidence retrieval (P3-S39).** "The traffic of reservation r, or of link L, in minutes
[a, b)" is answered as follows. The binding history (§4.1, kept 7 years) gives, for r,
its attribution keys and their observation points over [a, b), and for L its observation
points (the observation point → link mapping, RFC-000 AI3-8). Those name exporters; the
segment index gives their segments whose time range meets [a, b), plus every later
segment that holds an accepted record active in those minutes (found from the
attribution log's minute index while it is retained, and from the segments' flow-time
statistics after). Only the blocks whose key range matches are read. The answer is every
accepted record whose active interval meets [a, b) and whose key and observation point
match, each with its identity, acceptance time and, where superseded, its versions. There
is no latency target; a day of one reservation reads a few blocks per exporter-hour (est.).
Each query by an operator is recorded as a read of the role it prepares (POL-32). The
query contract is in §7.

### 4. Attribution and quarantine

**Component** (RFC-000 §2): decide, for each accepted record, the account, route,
product and reservation it belongs to, which observation point's count is the egress
count, and its traffic class under POL-17; keep what cannot be attributed in quarantine,
with finance's attributions and their reversals. It runs in two stages:

| Stage | Partition | Single responsibility | State it owns |
|---|---|---|---|
| **A, binder** | By exporter (the ingestion slot map) | Spread each accepted record over its minutes, bind each part to a provisioning binding, classify it, route it to its account; quarantine the rest; apply finance attributions and reversals; negate and replace superseded records | Processing checkpoints (ingestion sequence and binding position used); the binding facts consumed; quarantine entries, attributions and reversals with their source references; pending-binding holds; per destination account, the last sequence sent |
| **B, attribution log** | By buyer account (the rating slot map) | Record every attributed part of the account, exactly once | The account's attribution log: part batches, producer watermarks, attachment set per product |

#### 4.1 Attribution keys from provisioning (external input; the minimum this RFC needs)

Provisioning (Problem 5) is out of scope; RFC-000 §8 makes its keys an external input
whose minimum this RFC defines (RFC-000 R9), including the **observation point → link
mapping**, which attribution holds (AI3-8, resolved). The wire form is C11 Part III
(topic `provisioning.bindings.v1`, keyed by exporter, **never compacted**, retained at least
7 days); C11 governs every field. Provisioning publishes facts it never deletes (a binding
is ended or changed by a new version or a correction fact):

| Fact | Contents |
|---|---|
| Observation point | (exporter ID, observation domain, interface index, direction) → link ID (RFC-001's registry) or none, over a valid-time interval. It also **registers the observation domain as the exporter's** while it is in force (C11 S-1). There is no separate domain topic |
| Binding | A stable binding ID; key = (observation point, service tag: VLAN or 802.1ad pair, MPLS label or VRF, as configured); valid-time interval `[from, to)`; **account**; **product**; **route** (catalogue route ID); **reservation ID** or none (an account attachment with no reservation, or a best-effort service); **egress**: whether this observation point is where traffic on this binding, in this direction, leaves the route; an optional **egress group** for points that carry disjoint parts of one flow (LAG members), which counts as one egress point |
| Correction | A fact found wrong, replaced or retracted from its position on (never a delete) |
| Heartbeat | Not a fact: a **coverage assertion** that every fact taking effect at or before `coversThrough` has a lower position. Per exporter with facts at least every 5 s; per Kafka partition (`partition-heartbeat`) for exporters with no fact yet. Coverage ahead is limited to `binding_lead` (60 s, est.) |

Each event carries its recorded-at time and a contiguous **binding position** per exporter
(`bindingSeq`), so the feed is bitemporal; attribution records the position it used for
every part, which makes attribution reproducible (P3-N9). The contract requires that every
fact that takes effect at time t (a start, an end or a change of a binding or an
observation point) is published at or before t − `binding_lead` (R3-4, extended to ends and
changes by C11 D57-1). Stage A writes every fact it consumes (not heartbeats) to
`attr_a_log`, restores its binding state from it, and resumes the topic from the recorded
position, so the binding history is kept 7 years and topic retention never limits it;
stage A alerts when its lag on the topic exceeds 1 day.

**Tenancy invariants** (C11 F41-13). Only provisioning's workload identity may produce to
the topic, and only stage A consumes it. The consumers check:

| # | Invariant | Checked by | On violation |
|---|---|---|---|
| T1 | Every exporter in a fact equals the event's key | Stage A | Fact refused and recorded; provisioning alerted; stage A stops the exporter's binding consumption |
| T2 | The reservation belongs to the account, with the binding's route and product | Rating, against the lifecycle feed (§5.3) | The part's line is held, provisioning and finance alerted; never charged to another account; released by a corrected binding or a finance decision |
| T3 | A probe account is bound only at probe observation points, and only probe accounts are bound there | Stage A, from the probe designations | Parts held as unattributable (hold, then quarantine), alerted |
| T4 | At most one egress point (or egress group) per (account, product, route, reservation, direction) at any valid time | Stage B, from forwarded binding facts (§4.3) | T4 hold (§4.3) |

**Egress (P3-N13, POL-17; RQ3-7 as decided).** For each direction of a route, exactly one
observation point is the egress, normally the last Share-metered point before the traffic
leaves the route. When the route's last leg is a partner link that Share does not meter,
the egress is the **hand-off point to that partner**, the last point Share meters, and its
count is billed (P3-S67: L1 counts 1.1 GB entering and 1.0 GB handed off to the unmetered
partner link P; only the hand-off's 1.0 GB is egress, so the account is charged once for
1.0 GB). Provisioning sets the egress flag; stage B checks invariant T4, scoped per
(account, product, route, reservation, direction) and by egress point or egress group
(C11 AI-41-3, D57-4).

#### 4.2 Stage A: spread, bind, classify

Stage A's lease holder consumes its exporters' metering hand-off from Kafka (C11 Part II,
`ingestion.handoff.v1`), in each exporter's `handoffSeq` order (contiguous, so a gap
waits), dropping events at or below the last applied; an event with the same position and
different content stops the partition and alerts, and so does an unknown `body.kind`. It
takes the acceptance time from the event's commit timestamp. For each accepted record,
each accepted correction and each **identity conflict** (spread and quarantined "identity
conflict" under its conflict identity; C11 S-2):

1. **Absolute times** `s`, `e` in milliseconds from the record and its message header.
2. **Spread (POL-13, P3-N4).** If `e = s`, one part: all bytes in `floor_min(s)`
   (P3-S18, last row). Otherwise the active interval is `[s, e)`; for each minute `m`
   meeting it, `t_m` = milliseconds of `[s, e) ∩ [m, m + 60 s)`, and the part's bytes are
   the exact fraction `b × t_m / (e − s)`. Minutes are half-open, so a flow ending exactly
   at 12:06:00 has no part in 12:06 (P3-S18 rows 1 to 3; P3-S19; P3-S51). A record whose
   active interval exceeds `flow_active_timeout` + 60 s is still spread, and its exporter
   is alerted for breaking POL-13's export rule.
3. **Bind**, only at a **covered position** (C11 F57-01, D57-1; AI-57-1). The part's bind
   time is `t_b = max(s, m)`. Stage A binds a part only at a binding position whose
   coverage (the last heartbeat of the exporter, or of its Kafka partition when the
   exporter has no fact yet) is at or after `t_b`; otherwise the part waits, as in the hold
   below. Then the binding is the one whose key matches the record's (observation point,
   service tag, direction) and whose valid interval contains `t_b`, at that position. So a
   binding ended or moved before `t_b` cannot charge its previous tenant while stage A lags
   on the feed. The part records the position it used.
4. **Classify** each part:

| Class | When | What happens to it |
|---|---|---|
| **Probe** | The exporter or the observation point's link (a link of the designated probe supplier) is designated probe in the catalogue, or the binding's account is a probe account in placement's account slot map (C01 M11; POL-06, X2-S20) | Kept as evidence in the raw log only; never sent to rating; never quarantined or reported |
| **Non-egress** | A binding matches, but the observation point is not its egress | Recorded in the `processed` entry's counts only; never sent to stage B and never in any charge (P3-S49). The raw record is the evidence (§3.7) |
| **Reservation binding** | A binding with a reservation ID matches, at its egress | Sent to the account; rating decides covered, burst, excess or outside (§5.3) |
| **Attachment** | A binding without a reservation matches, at its egress, on a guaranteed product | Traffic outside any reservation (POL-17), usage priced (§5.3) |
| **Best-effort** | A binding of a best-effort product matches, at its egress | Usage priced (§5.3) |
| **Unattributable** | No binding matches (whatever the domain's state), or two do ("ambiguous binding", a provisioning error, alerted) | Pending-binding hold, then quarantine with its reason (below) |

5. **Route** each attributed part to its account, in one batch per (stage A entry,
   account), carrying per part: record identity, acceptance time, last minute end,
   minute, bytes (an exact fraction, signed), class, account, product, route,
   reservation ID, observation point, link (none when no observation-point fact names
   one: still attributed, provisioning alerted, C11 D41-6) and the binding position used
   (C11 Part IV `Part`). Each batch also carries every binding fact of that account that
   the entry consumed, per binding (C11 F41-11): a correction fact that moves a binding to
   another account goes to the old account (retracted) and to the new one (F57-14).

Stage A commits a `processed` entry (ingestion sequence reached per exporter, binding
position used, the quarantine and pending changes) and, in the same transaction, the
**outbox rows** of the batches that entry determines, each with feed identity (stage A
partition, epoch, sequence, account) and a **per-destination sequence**: contiguous per
(stage A partition, account), so stage B detects a gap and waits for it even though a
stage A entry sends to only some accounts (RFC-000 §4.4's contiguity, per destination). A
new lease holder resumes from the last `processed` entry; the batches are deterministic in
the records and the binding position, and already committed as outbox rows, so nothing is
sent twice with different contents.

**Superseded records (§3.3; P3-S66, P3-S72, P3-S73; POL-23, RQ3-15 as decided).** For an
accepted `supersession` of an original (or of an earlier version), stage A, in one
`processed` entry:

1. recomputes the parts the replaced version produced, from its contents and the binding
   position recorded when it was processed, and routes each one **negated**, to wherever
   it went, with reason "superseding record", the exporter and its owner;
2. spreads the new version (step 2 above); its parts fall only in the original's minutes
   (§3.3), and each takes **the original's disposition in that minute**, never a fresh
   binding, since a version cannot change the attribution keys and must not change where
   its traffic is charged:

| The original's part in minute `m` (as it now stands) | The new version's part in `m` |
|---|---|
| Bound at its egress (reservation, attachment, best-effort), at binding position β | Bound to the same binding at β, same class, routed to the same account, reservation, product and route |
| Non-egress, or probe | The same: counted only, or evidence only |
| In the pending-binding hold | Replaces it in the hold, keeping the hold's deadline |
| **Quarantined** | **Quarantined in its place** (P3-S73): the original's (or replaced version's) entry is marked **superseded** by version `v`, and a new quarantine entry holds the version's bytes, same reason, link and supplier, state quarantined; nothing is billed for either; the quarantine report shows the replacement |
| Attributed by finance, attribution `a` | Routed to `a`'s target, carrying `a`'s source reference, so charged to the same account; the version's quarantine entry is marked attributed by `a` |
| Reversed | Kept under the reversed entry and never routed: uncharged |

The disposition is found without new state: the original's binding by recomputing its bind
at its recorded binding position, its quarantine state from the quarantine entries, which
are keyed by (record identity, minute) and looked up only for identities of kind record or
correction, so an identity conflict never changes an original's disposition (C11 S-2),
and its hold from the in-memory holds. A later
finance attribution or reversal selects only entries in state quarantined or attributed, so
it applies to the current version, never to a superseded entry. The original is never
altered (P3-S73: the original's entry is kept, marked superseded).

**Pending-binding hold** (C11 S-1, D41-2). A part with no binding is held, not quarantined
at once, **whatever the state of its observation domain**, until the exporter's coverage
is at or after the part's time plus `binding_grace` (5 min, est.). If a binding arrives in
that time the part is attributed normally; its attribution lag is then over 10 s and is
reported as a breach (§5.9), which is correct, since headroom did not see it in time. At
the end of the hold it is quarantined, with the reason chosen from the covered state:

- **"domain not of exporter"** when no observation-point fact of this exporter in force at
  the part's time names the record's observation domain (P3-S77). An exporter that has a
  C08 credential but no provisioning at all gets this reason too (C11 F57-10);
- **"no binding"** otherwise.

Unattributable traffic belongs to no account, so the hold delays no account's headroom.

**Stage A watermark.** Stage A has processed every record of its exporters accepted at or
before `w` when it has consumed, on every metering hand-off partition it reads, the
**destination resolved marker** at or after `w` (the minimum over every `ingest_log`
changefeed partition that can feed that destination, emitted only after the relay has
published every such row: RFC-000 revision 4.3 §4.5, AI-27-3) and processed everything
before it. It relies on nothing else: a changefeed partition's own resolved timestamp is
never read directly, so a range split or a slow relay can delay the watermark but never
make it pass a row still unpublished. It publishes `w`
(pending-binding parts excepted) on a heartbeat topic every 1 s; an idle exporter's
watermark follows the resolved timestamps. Rating uses the minimum over all stage A
partitions to decide when a usage minute may close (§5.6). The heartbeat is not a fact:
rating records the value it closed on.

#### 4.3 Stage B: the account's attribution log

Stage B consumes the part batches from Kafka and appends each one, in a slot batch
transaction, unless its per-destination sequence is at or below the **producer watermark**
it keeps for that stage A partition (redeliveries and the outbox's two publish paths are
dropped; a gap waits). Per account the watermarks number the exporters the account's
traffic crosses (tens, est.). The wire form is C11 Part IV (`attribution.parts.v1`, keyed
by account, `destSeq` contiguous per (stage A partition, account)). Stage B also keeps the
account's **attachment set** from the forwarded binding facts, keyed by (exporter, binding
ID): a product is attached for a minute when at least one of its bindings is valid in that
minute, by valid time, not by stage B's clock (C11 F41-11, F57-14). It defines the "one
per account and product" set of POL-14 (§5.9).

**T4 hold and resolution** (C11 F57-12, D57-4; AI-41-3). Stage B checks invariant T4 from
the forwarded binding facts. While two egress points (not of one egress group) are valid
for one (account, product, route, reservation, direction) at one time, stage B appends the
parts of the bindings concerned marked **held (T4)** and alerts provisioning. Rating counts
held parts in unposted usage (§5.9), so headroom sees them, and emits no charge line for
them. A later fact that leaves one egress point resolves it: parts of a binding that a
correction retracted, or that ended before the part's minute, are **dropped** (never
charged); parts of the surviving binding are released and charged. A part still held at
its minute's end + `dispute_window` is dropped, and finance is alerted. Held parts leave
unposted usage when they are released or dropped.

After commit, the lease holder passes the committed batches to rating **in process**:
stage B slot *i* and rating slot *i* are one **slot group** (RFC-006 revision 4 §7.1), which
placement acquires, hands off and lets a standby take over only together, in one
transaction, so the two leases are never held by different processes. After a takeover or
handoff, rating reads the batches from `attr_b_log` from its last applied position (in
`rating_log`'s `inputs` entry), since the in-process hand-off is not durable. So the
attribution → rating hop costs no Kafka round trip.

The attribution log is the input of rating. It is kept in the database for
`dispute_window` + 7 days and then archived by history (RFC-006). It can always be
recomputed from the raw records and the binding history, so it is not the 7-year evidence
store; §3.7 is.

#### 4.4 Quarantine, finance attribution and its reversal

A quarantine entry, in the exporter's stage A partition, holds: the part (record identity,
minute, bytes), its observation point and therefore its **link and supplier** (via the
observation point → link mapping and the link registry; with no link, the exporter's
owner, C11 S-1), the reason ("no binding", "domain not of exporter", "ambiguous binding",
"identity conflict"), the time it was quarantined, and its state:
**quarantined**, **attributed**, **reversed** or **superseded** (by a version from its own
exporter, which takes its place, §4.2). Traffic is quarantined, not charged (P3-S26).

**Reports.** Quarantine entries feed the **quarantine report feed** (§7; C06
`rating.quarantine-report.v1`): to operations per entry, aggregated per link and minute;
and to each supplier for its own links, aggregated per link and minute, with no buyer data
(there is none to show; POL-33). An entry with no link is reported to the exporter's owner
(C11 S-1; its C06 form is CI3-2). The notifier
delivers them (RFC-006), a supplier being told once the notice is in its notice list and a
first delivery attempted. Probe traffic is never quarantined, so never reported (X2-S20).

**Operator commands (C08 §E, §F, §G).** Stage A serves the C08 **target summary** for the
target kind `quarantine_item`, and appends its audit record before it answers. It verifies
the operator action envelope of `attribute_quarantine` and `reverse_attribution` (role
finance, no four eyes), and calls `operator_check` when it applies the command. A repeat of
a recorded `action_id` gets the recorded outcome before the other checks (RFC-000 revision
4.5, AI-37-2).

**Finance attribution (P3-S27, P3-S77, POL-17, POL-32).** An operator in finance sends,
through the operator console with the operator action envelope (role, reason; C08), an
**attribution command**: a source reference (POL-29), a selector of quarantine entries
(exporter, observation point, key, minute range) and the target: account, product, route
and, optionally, a reservation ID. Stage A validates it in one entry:

- the principal is in finance; otherwise refused and recorded (X1-S13, RFC-005);
- every selected entry's minute must be within `dispute_window` (§2): the accepting
  entry's commit timestamp before `window_end(m)`; if any is not, the whole command is
  refused and nothing is attributed (P3-S27, second row);
- every selected entry must be **quarantined**: an entry attributed, reversed or
  superseded is never attributed again;
- a repeat of the same source reference with the same principal and contents returns the
  first result; with different ones it is refused (RFC-000 §4.4, AI4-1). Source references
  are kept 7 years with principal and content digest.

Accepted, the entries are marked attributed (with operator, reason and reference) and
their parts go to the account's stage B like any attributed part, classed by the target (a
reservation ID gives the reservation class), carrying the attribution's source reference.
Rating charges them at the price of the traffic's minute (P3-S27, first row), as an
amendment with reason "quarantine attribution", and settlement pays the supplier its split
(RFC-004), each movement under a reference derived from the attribution's (AI4-1).

**Reversal of a mistaken attribution (P3-S65, POL-17, POL-23; RQ3-3 as decided).** An
operator in finance sends a **reversal command**: its own source reference, the source
reference of the attribution, optionally a subset of its entries, and a reason. Stage A
validates it in one entry:

- the principal is in finance;
- every reversed entry is **attributed** by that attribution (not already reversed);
- every reversed entry's minute is within `dispute_window` (§2); otherwise the whole
  command is refused and nothing changes;
- idempotent by its source reference, as for an attribution.

Accepted, the entries are marked **reversed**, which is terminal: the traffic is never
attributed again. Their parts are routed to the same account **negated**, with reason
"attribution reversed", cause **Share**, and both references. Rating restates each line
concerned without that traffic, so the buyer's charge for it falls to zero (P3-S65:
an amendment of −10,000 micro-USD with cause Share), and settlement bears it in full from
Share's account, the supplier keeping what it was paid (POL-23; RFC-004).

#### 4.5 Throughput and recovery

| Item | Estimate |
|---|---|
| Parts | About 1.5 per record (60 s flows that straddle a minute boundary), so about 900,000 parts/s at peak, about a third of them at an egress |
| Binding state | About 10⁷ bindings in all (est.); each stage A slot holds only its exporters' observation points, about 80,000 bindings and 10 MB (est.), in a hash map keyed by (observation point, tag, direction) with the valid intervals per key |
| Stage A transactions | A `processed` entry per slot every 50 ms (est.) with its outbox rows: about 2,600 transactions/s |
| Stage B write rate | About 300,000 egress parts/s at peak, as about 10,000 batches/s (est.), about 12 MB/s, in 256 slots' batch transactions: about 8,500 transactions/s |
| Latency, acceptance → stage B committed | Ingestion's direct publish 20 ms + Kafka to stage A 50 ms + stage A flush and commit up to 110 ms + Kafka to stage B 50 ms + stage B commit up to 60 ms ≈ **0.3 s** p99 steady (est.); about 0.5 s after a region loss |

Both stages have **hot standbys** (RFC-000 §2): a standby NestJS instance consumes the
same Kafka partitions and tails the slot's log rows, keeping the binding state and the
in-memory structures current; on the 3 s owner lease's expiry it takes the lease and
resumes, about **5 s** at p99 (est.; RFC-000 AI3-9, resolved). Nothing is lost on
takeover: stage A resumes from its last `processed` entry, whose outbox rows are already
committed; stage B drops what it already has.

### 5. Rating

**Component** (RFC-000 §2): turn reservation history, attributed traffic and price
history into charge lines, cost lines and amendments, exactly once and reproducibly,
applying POL-17's rule; feed unposted usage to the account owner. **Partition**: by buyer
account; 256 slots (est.), co-located with stage B's. **Capability**: rating and posting,
judged by timeliness (2 min, `max_lateness` + 2 min), RTO 5 min ceiling, designed for a
takeover in about 5 s (est.).

#### 5.1 Inputs, entries and state

Rating's state machine is deterministic in its inputs. The lease holder chooses the order
in which input batches are applied and records it in an `inputs` entry, so every standby
and every recomputation applies the same inputs in the same order.

**Lifecycle feed rules (C04 consumer obligations).** Rating applies the events that change
charges: `confirmed`, `part_added`, `rate_decreased`, `cut`, `shortened`, `moved`,
`price_step`, `ended`, `partner_leg_affected` and `pol28_residue`. It **ignores**
`offer_made`, `offer_accepted`, `offer_declined`, `offer_lapsed`, `offer_failed`,
`offer_cut_kept` and `leg_changes_durable` (C04 MM-7, MM-6), and skips any kind that carries
the header `rating_ignorable: "true"`. It **stops the partition and pages** on an unknown
kind without that header, and on a feed-event identity that arrives again with different
content (C04 m-03, m-06). It alerts when `account_is_probe` differs from the slot map's
designation, and follows the slot map (C04 CC-1).

| Input | From | Used for |
|---|---|---|
| Reservation lifecycle feed (C04 `account.lifecycle.v1`), with its resolved markers (§7) | Account owner (RFC-002), Kafka | Parts, prices, effective minutes, ends and end causes, shortens, fees shown, moves (with the path's catalogue route ID and shown price, and the old path's fees due), price steps, POL-07 cuts ((link, reduction), `target_revision`, the applied target as minute pieces `[(from, r)…]` from `T_eff` or `none`, and the part rates that result, AI-26-2, C04 MM-3), partner-leg affected status, residue events, `account_is_probe` (a copy, checked against the slot map) |
| Link schedule feed: affected flags, each reduction's affected set and final step, per-link closed time | Link schedule owners (RFC-001), Kafka | Affected marks on reservation lines (P3-S10); reservation closure (§5.6) |
| Attributed parts | Stage B, in process (§4.3) | Usage line totals |
| Stage A watermarks | Stage A heartbeats, Kafka | Usage minute closure |
| Catalogue feed (C06 `catalogue.v1`), with its resolved markers | Catalogue (§6), Kafka | Prices, price corrections, split weights, partner terms, probe designations of links, exporters and the probe supplier |
| Account slot map (C01 §2.7, §2.9) | Placement (RFC-006) | The only source of **probe accounts** (C01 M11, C06-M14): their reservations and traffic give no lines and no figures |
| Posting acknowledgements (C06 `settlement.posting-acks.v1`) | Settlement and the ledger (RFC-004), Kafka | Which lines are posted, at which ledger position; excluded lines with their reasons; refused usage batches (§5.7, §5.8) |
| Usage-applied acknowledgements (C06 §4, `account.usage-applied.v1`) | Account owner (RFC-002), Kafka | Through which rating position the account owner has applied unposted usage, and when (`appliedTs`). Deduplicated by (account, `appliedThrough`), keeping the maximum; gaps found by `streamSeq` are recovered by replay of the topic (retained at least 7 days), then by `usage_applied_since(accountPartition, afterStreamSeq)` on RFC-002's status readers, never by a read of the owner's outbox (C05 S-4, C06-M1) |
| Ledger movement feed (C06 `ledger.movements.v1`) | Ledger (RFC-004), Kafka | Only for the cold re-rate (§5.10): each line's postings and `triggerRef` |

| Entry | Contents |
|---|---|
| `inputs` | For each input feed, the position applied through (sequence, or resolved timestamp), in the order applied |
| `accrual-closed` | Account, minute `m`, and the reservation lines for `m` (reservation, amount, affected marks), run-length encoded across minutes |
| `usage-closed` | Account, minute `m`, the usage lines for `m` (product, route, amount, and the line's ELA) and the cost lines for `m` (§5.5) |
| `amendment` | Line reference, amendment sequence, amount, reason, cause where §5.7 gives one, trigger reference, the line's new ELA for a usage line |
| `fee` | Fee line or Share-borne fee line (§5.4) |
| `emitted` | A charge-line batch sent to settlement: its stream (reservation or usage), identity, lines, and for a usage batch its usage reduction (§5.8, §5.9) |
| `posted` | A posting acknowledgement applied: lines, amounts as posted, ledger position |
| `breach` | Lateness or attribution-lag breach reports (§5.9) |
| `checkpoint` | Snapshot reference |

Derived state per account (in the lease holder's memory and the standby's):

- the **reservation model**: for each reservation its route, product, legs, window, and
  for each part its rate over effective intervals and its price over minutes (§5.2), its
  end, end cause and fees shown;
- the **accrual watermark** per reservation: lines emitted through minute `m`, and its
  **closure holds** (§5.6: `T_eff` of each open reduction on its links whose affected set is
  not yet complete, and of each whose affected set contains it until final and applied);
- per Share link the reservations of the account use, its latest `CLOSED(t, feed_seq)`
  and its open reductions with the chunks of their affected sets received;
- for each **open usage minute** (not yet closed), an ELA per reservation (egress bytes of
  the reservation class) and per (product, route) (attachment and best-effort classes);
- for each **closed usage line** of the last `amendment_hot_window` (1 h, est.), its ELA
  and its emitted total; an older line's ELA and emitted total are in its last
  `usage-closed` or `amendment` entry, read back from `rating_log` (or from history's
  segments once archived) when an amendment needs them (§5.11);
- per line not yet fully posted, the **acknowledged posted total** and the ledger position
  of its last acknowledgement; a line whose posted total equals its emitted total is
  dropped from memory.

#### 5.2 Reservation accrual (P3-N1)

The account owner owns reservations and their parts (RFC-002 applies POL-08's and POL-07's
rules: last in, first out on a decrease; newest Mbps first on a permanent reduction; a
decrease over a partner leg whose terms forbid it is rejected, so never reaches rating).
The lifecycle feed carries the **part-level** result of every change, so rating charges
what the account owner decided and does not reimplement those rules. Rating checks the
last-in-first-out invariant on every decrease (P3-S46) and alerts on a mismatch.

**Active minutes.** A reservation's first active minute is
`max(window start, floor_min(decision timestamp))`, the decision timestamp being the
deciding entry's commit timestamp; a part minute is a whole minute (P3-S02: confirmed at
10:05:40 starting now, 10:05 accrues). Its active minutes end (exclusive) at the effective
minute of its end: a cancellation's next minute boundary (P3-S04: at 10:29:20, effective
10:30), a termination's (P3-S42: at 10:15:30, so [10:00, 10:16) accrues), a release's at
the end of `suspension_grace` (P3-S09; the reservation accrues every minute of the grace,
unchanged by the suspension), a revocation's at the end of its notice (P3-S08), a
shorten's new end, or the window's end (P3-S03: [10:00, 10:01) accrues 200 in all). An
ended reservation is never refunded what it accrued (P3-S42).

**Effective minutes are the lifecycle feed's** (F3-11; RFC-000 §4.5 and §8 as revision 4.2
states them). An end fixed in advance (a release at the end of `suspension_grace`, a
revocation at its notice end, a move at the offer's move time) is recorded by the account
owner before its minute; one it reaches late (it was unavailable) takes the next minute
boundary after its entry's timestamp, and the owner records and alerts the delay. Rating
ends accrual at the effective minute the **end entry** carries, never waiting for a later
event of the account owner that confirms it, and the minutes accrued up to a late-recorded
end stand: the reservation was held and usable until its release took effect (P3-S09,
"after its release"). No entry carries an effective minute before its timestamp except the
**three early-effective events** of C04 (MM-5, MM-12; RFC-000 revision 4.5 AI-43-2):

| Event | Effective | How rating stays exact |
|---|---|---|
| `cut` | Its `T_eff` | `hold_2` holds closure (§5.6); a cut applied after minutes closed amends them ("late POL-07 cut", §5.6, §5.7) |
| `ended(revoked)` written in a cut's entry (every part's rate 0 to the end) | Its `T_eff` | The same: held by `hold_2`, amended late like a cut |
| `ended(window_end)`, the timer-driven entry at the window's end | The window's end | The window's end is known in advance; the entry is deferred while an addition that starts at the window's end is undecided (MM-5), and the minutes before the end were active in any case |

A **release after grace** ends accrual at `nb(ts)` of the funds module's F7 entry (C04
MM-4); it is late only when its `delay_min` (`nb(ts)` − `nb(grace_end)`) is above 0, which
the account owner alerts, and the minutes up to it stand. An **added part** accrues from
its `part.window.start`. When a reservation has two `ended` events (a buyer's cancel and a
later `ended(revoked)`, C04 N-07), accrual stops at the **least** `effective`, and the fee
follows the end that took effect (D58-3).

**Accrual of minute m** = `Σ over parts active at m of rate_p(m) × price_p(m)`, rounded
down once (§2). A part's rate follows its effective intervals: an increase applies from
its next minute boundary (P3-S45: at 10:29:20, from 10:30, 100 × 2 + 50 × 3 = 350), a
decrease likewise and removes the newest part first (P3-S05, P3-S46), and a permanent
reduction's cut applies from the end of the notice (P3-S58: 4 Mbps → 2 Mbps, 8 → 4). An
extension adds a part for the added window only (P3-S40: [10:00, 12:00) at 2,
[12:00, 13:00) at 3).

**POL-07 cuts as minute pieces** (RFC-000 revision 4.3 §8, AI-26-2). A cut event names its
(link, reduction) and carries the reservation's **applied target**: a step function of the
minute, `[(from, r)…]` from `T_eff` (each piece's rate holding until the next piece's
`from`), or `none` (the reduction leaves the reservation uncut). The account owner composes
the targets of every (link, reduction) affecting the reservation by `min` **per minute**
and removes Mbps newest first to meet it; the event carries the **part rates** that result,
over their effective intervals, as every change does. Rating accrues those part rates
(never re-deriving the cut), and checks at each minute from `T_eff` that the reservation's
total rate is at most the `min`, over the cuts applied to it, of each target's piece at
that minute, alerting on a mismatch (as for P3-S46). A target whose pieces differ by minute
(parts with different windows) is charged exactly minute by minute; run-length encoding in
`accrual-closed` (§5.1) absorbs the steps. Maintenance bookings are not reservations and
accrue nothing, so POL-07's trimming of maintenance at a reduction's effect (v1.9) charges
nothing and needs no event here; and whether a reservation is affected during an outage
after a reduction's notice (POL-07 v1.9: the committed rate counts the cut rate) is the
link's decision, reaching rating only as affected marks (P3-S10).

**A part's price at minute m.**

1. The price **locked** when the part was added: the `reservation_price` in force for new
   bookings at the deciding entry's timestamp, carried in the lifecycle feed (POL-27,
   POL-08). A route price change does not touch it (P3-S06).
2. For an **open-ended** reservation, at each catalogue price version's **open-ended
   effective minute** (§6.2), `oe_effective = max(effective_from, ceil_min(announced_at +
   price_notice))`, **every part** locked before that minute is re-priced to the version,
   parts added after the announcement included; a part added at or after `oe_effective` is
   already at the new price (POL-27; RQ3-5 as decided). P3-S07: announced 09:00:20 on day
   D, effective for the reservation from 09:01 on D + 30. P3-S64: 100 Mbps at 2, a new
   price of 3 announced `price_notice` before 10:00, 50 Mbps added after the announcement
   at 2; from 10:00 all 150 Mbps accrue at 3, 450 micro-USD a minute.
3. After a **move to an equivalent path** (POL-07), from the move's effective minute, each
   part is charged `min(its price, the path's price)` (P3-S59). **Its price** keeps
   following rules 1 and 2: the original lock and every open-ended change notified to the
   reservation. **The path's price** is the one shown in the offer, carried in the
   lifecycle feed, fixed for the reservation's life (D-19-8): the buyer keeps the lower of
   two known prices and Share never profits from the move.
4. A **reservation price correction** (§6.3) that covers the reservation, its part and the
   minute applies as `min(corrected price, the result of 1 to 3)` (D-19-5): a correction
   can only lower a minute's charge, whatever moves or re-pricing the minute had. A
   correction of a **price version** (§6.3) changes the price that version gives wherever
   rules 1 to 3 use it, before the `min` of rule 3.

The **effective price** of a part at a minute is the result of rules 1 to 3; the **price as
booked** is the result of rules 1 to 3 with no correction of any kind applied (§5.5 uses
it). Rating takes open-ended price changes from the lifecycle feed's **price step** events
(price version, minute; recorded at the announcement), which are authoritative for the
reservation (the account owner notified them and holds
for them); it checks each against the catalogue's `oe_effective` (§6.2) and alerts on a
mismatch (F3-15).

**A move after a cut** (POL-07 as `requirements-v1.11` states it; P1-S84). A move that
becomes final after the reduction's cut carries the reservation at its cut rate: the
`moved` event's part rates are the rates the recorded targets leave, from `move_at` (C04
m-07), and rating accrues them. An offer-scoped target on an offer that is already Final,
with the link on the new path, is applied by the account owner as a normal `cut` from
`max(T_eff, move_at)` (C04 N-03); rating applies it as any cut, and amends the minutes it
finds closed (§5.6).

**Route and weights after a move** (P3-S59, F3-07; AI-19-2 resolved). The move event
carries the path's **catalogue route ID**; every offered path is a catalogue route with
split weights, registered before it is offered (§6.1). From the move's effective minute,
rating labels the reservation's lines, and its dearer-path cost lines (§5.5), with that
route and the weights version in force at the minute, so settlement splits them among the
new path's parties, never the exiting supplier. Usage lines follow the bindings
provisioning publishes for the new path (§4.1).

**Affected marks (P3-S10).** An unplanned outage changes nothing in the accrual: every
minute keeps accruing. The link schedule feed's affected flags for (reservation, leg,
minute) (a projection of the link log, RFC-000 AI-R1-6), including a confirmation that
completed across a capacity reduction (v1.6, RQ-R1-1) and a reservation moved onto a path
(RQ-R1-6), and the lifecycle feed's partner-leg affected status, become **affected marks**
on the reservation line, published as **affected marks** on their own topic
`rating.affected-marks.v1` (C06 §6, C06-M6, m12), never inside a charge-line batch: no
amount, no amendment, latest per (reservation, minute, leg) wins, for SLA credit (Problem
6). A `partner_leg_affected` event (C04 E14) marks the partner leg affected from its `from`
minute, source `partner_leg`; a reservation that the partner has only in part is affected
for the missing part (POL-28 as `requirements-v1.11` states it). Rating charges the part
rates the lifecycle feed carries; it does not lower a charge for a partner shortfall by
itself (CI3-3).

**What never accrues.** A planned maintenance booking is a link schedule entry, not a
reservation, so it never reaches the reservation model and no line or settlement exists
for it (P3-S47, POL-07). The probe accounts' reservations produce no lines (POL-06,
X2-S20); a probe account is one that placement's account slot map designates (C01 M11).

#### 5.3 Usage-priced lines: each kind of traffic by its rule (P3-N6, P3-N13)

For account `a` and minute `m`, rating applies POL-17 to the egress parts of `m`:

| Parts | Rule | Result |
|---|---|---|
| Reservation class, reservation `r` **active at m** | Let `B` = the ELA of `r`'s egress bytes at `m` and `A = rate_r(m) × 7,500,000` bytes (reserved rate × 60 s ÷ 8). Within `A`: covered by the accrual, no charge (P3-S22). Above `A`, `B − A`, exactly: **burst** if the product permits it, added to the usage line (a, product, route, m) at `usage_price` (P3-S23: 1.75 GB − 0.75 GB = 1 GB, 10,000 micro-USD); **excess** if not (§5.5) | Measured per minute, not per second: 200 Mbps for 30 s and nothing for 30 s is 0.75 GB, no charge (P3-S54) |
| Reservation class, `r` **not active at m** (before it starts, after it ends) | Outside an active reservation | All bytes to the usage line (a, product, route, m) (P3-S53: a flow 11:59:30 to 12:00:30 on a reservation ending 12:00 has its 0.5 GB at 11:59 covered and its 0.5 GB at 12:00 charged 5,000) |
| Attachment class | Outside an active reservation | All bytes to the usage line (P3-S25) |
| Best-effort class | Best-effort | All bytes to the usage line |
| Non-egress, probe | — | Never reach rating (§4.2; P3-S49: three legs report 1.00, 0.99 and 0.98 GB; only the egress 0.98 GB is charged, 9,800 micro-USD) |

A usage line is one account and product on one route for one minute (POL-11), however
many reservations, attachments and records contribute to it, priced at
`usage_price(product, route, m)` as it stood for that minute, corrected (§6.3), whenever
its records arrive (P3-S20). One account's traffic on two routes in one minute is two
lines, each rounded once and each split by its own route (P3-S48). A part in a minute
after a price change is priced at that minute's price (P3-S52: 0.5 GB at 10,000 and
0.5 GB at 13,000).

Traffic above the reserved rate that the edge dropped never appears in an egress record,
so it is never charged (P3-S24); every record is still kept (§3).

**Tenancy check T2** (C11 F41-13). For each reservation-class part, rating checks against
the lifecycle feed that the reservation belongs to the part's account and has the
binding's route and product. If not, the part's line is held and not emitted, provisioning
and finance are alerted, and the part is never charged to another account; a corrected
binding that re-attributes it, or a finance decision, releases it. Parts held by stage B's
T4 hold (§4.3) are counted in unposted usage and charged only when released.

A usage line's **source reference** names the account (§5.8), so it is never shown to a
supplier: RFC-004's reporting shows a usage-priced share by an opaque reference derived
from it (POL-33, RQ5-1).

#### 5.4 Fee lines (P3-N12)

The lifecycle feed carries, for each reservation, each **fee shown at booking** (C04
`ShownFee`: at most one per leg, a minimum term charged as the leg's cancellation fee;
`fee_id = "<reservation>/<path>/<leg index>"`, path `0` for the booked path and the offer
ID after a move (C04 MM-2); amount, partner link, and its **kind**: a **plain cancellation fee**, or a **minimum-term
fee** with the end of the partner's minimum term for this reservation; and, for a
minimum-term fee, whether the offer showed it as **due at the window's end**, because the
requested window ended inside the term, P3-S74) and, at each end or shorten, the **end
cause**: cancelled by the account (including a shorten to or before the next minute
boundary, and a support operator's change at the account's documented request, POL-08,
POL-32), **shortened** by the account to a later end, released (POL-16), terminated
(POL-30), revoked (POL-07), cancelled by the holder after a rate cut under POL-07, or
**ended at its window's end** (as booked or as last changed).

**When a shown fee is due** (POL-08 and P3-N12 as `requirements-v1.8` states them; D-19-1;
RQ-19-1, RQ-19-2 decided). `t` is the effective minute of the end, or, for a shorten, the
**new end**:

| End cause | Plain cancellation fee | Minimum-term fee |
|---|---|---|
| Cancelled (a shorten to or before the next boundary included), released, terminated, revoked, cancelled after a POL-07 cut | Due (an open-ended reservation's at any time) | Due if `t` is before the term's end |
| Shortened to a later end | **Never** (P3-S63 third row: a plain fee, shortened to end 10 days after its start, no fee) | Due if the new end is before the term's end (P3-S63: 10 days into a 30-day term, 0.500000 USD; 31 days, nothing) |
| Ended at its window's end | Never | Due if the window's end is before the term's end (P3-S74: a 10-day window on a 30-day term, 0.500000 USD; a 30-day window, nothing) |

**Who pays a due fee:**

| End cause | Line |
|---|---|
| Cancelled or shortened by the account, ended at its window's end, released, terminated | **Fee line** charged to the account: exactly the shown amount, not rounded, not split, wholly the partner's (P3-S11 first row, P3-S43 first row, P3-S44 rows 1 and 2, P3-S60: 0.500000 USD is 500,000 micro-USD; P3-S63 first row; P3-S74 first row) |
| Revoked; cancelled after a POL-07 rate cut | **Share-borne fee line**: the same amount, paid by Share to the partner, not charged to the account (P3-S44 rows 3 and 4) |

A window ending inside the term is charged to the account only if the offer showed the fee
as due at the window's end (the feed's flag). POL-08 makes the offer show it, so a fee due
at the window's end that the offer did not show is, like any fee not shown, a Share-borne
fee line, and is alerted as a defect of the offer. The window's end is the one in force
when the reservation ends: an extension past the term's end avoids the fee; a shorten into
the term was already charged at the shorten (P3-N12), and the fee ID is never charged twice.

A fee whose term had ended is not due (P3-S43: cancelled after 31 days of a 30-day
minimum term, nothing). A shorten's fee line is decided by the entry that applies the
shorten, not when the shortened reservation later ends. A fee the partner imposes that was
**not shown** is never charged to the account; it is a Share-borne fee line for the
partner's fee per the partner terms in force at booking (P3-S11, second row). A partner
booking left without Share's confirmation and cancelled because its request was withdrawn
or failed (POL-28) gives a Share-borne fee line keyed by the request, from the lifecycle
feed's residue event (RFC-000 §8; AI3-4, resolved).

**Rating charges what the account owner decided.** The lifecycle feed's **shortened**
and **ended** events carry the fee due and its payer (RFC-002 §13.1), computed by the same
rule; rating charges the fee line or Share-borne fee line the event names, and checks it
against the tables above, alerting on a mismatch (a defect on one side, which finance
resolves by a correction).

**A move's old partner leg** (C04 M-03). When a move cancels the old path's partner leg,
the `moved` event's `fees_due` names each old-path fee due at `move_at`, payer Share;
rating emits each as a Share-borne fee line. The new path's legs carry their own fee IDs
under the new path, so a new path's fee is never lost and never charged twice (P3-S60).

**A shorten to a later end at a partner without amend** (C12 S1, V5). The account owner
cancels at the partner deferred to the new end; the buyer pays only a minimum-term fee
shown that the new end falls inside, and Share bears a plain cancellation fee. Rating emits
that Share-borne fee line when the lifecycle feed carries it with payer Share (CI3-4 gives
the reading while C04's `shortened` event carries only the buyer's fee).

Each fee or Share-borne fee line has the source reference (reservation or request, fee ID)
and is decided once, in one `fee` entry, however often the end or shorten is processed and
whatever end follows a shorten (P3-S60): a fee ID is charged at most once per reservation.
A fee line names its **payee** (the partner's supplier and partner link, from the shown
fee), has no route and no weights, has amendment sequence 0 and is never amended (C06-M4).
Fee lines travel in usage batches (§5.8).

#### 5.5 Share-borne cost lines

Two costs Share bears are amounts that only rating can compute, per minute, so rating
emits them on the charge-line feed as **cost lines**, distinct from charge lines: they
charge no buyer. Each carries its payer (Share), the route and the catalogue position of
the weights that split it, and its reason (RFC-000 §8, AI4-7). Settlement pays each as
POL-23 says: split by Webster among the parties concerned, each supplier paid its share
from Share's own account, no commission share posted (RFC-004 M12, M13).

| Cost line | Key | Amount |
|---|---|---|
| **Carried excess** (POL-17) | (account, product, route, minute) | The usage line the excess would have made: `⌊usage_price × Σ (B − A) / 10¹⁵⌋` over the minute's reservations of a product without burst whose egress bytes exceed `A` (P3-S41); split among the route's parties. An **incident** is raised to network operations through the alert feed (RFC-006), one per reservation and run of consecutive excess minutes, updated while it lasts |
| **Dearer equivalent path** (POL-07, POL-23; RQ3-8, RQ-19-3 decided; D-19-3) | (reservation, minute) | `⌊Σ_p rate_p × path price_p / 10⁶⌋ − ⌊Σ_p rate_p × booked price_p / 10⁶⌋`, when positive: the new path's charge, computed exactly and rounded down once, less the buyer's charge **as booked**, the price as booked being rules 1 to 3 of §5.2 with no correction applied (P3-S59: 100 × 3 − 200 = 100; 0 on a cheaper path; P4-S110: ⌊3 × 2.7⌋ − ⌊3 × 1.5⌋ = 8 − 4 = 4 micro-USD); split among the **new path's** parties, by the route and weights of §5.2 |

A correction of the buyer's price amends **only the buyer's line**, never the difference
(POL-23; P4-S115: the buyer's price corrected to 1.0 gives a buyer's line of 3, amended by
−1; the difference stays 8 − 4 = 4 and no supplier is paid again). A correction of the
path route's price version changes the path's charge and so amends the difference by the
rules below.

**Amending a cost line** (F3-01; POL-23 and RQ-19-4 as decided; D-19-4). A cost line keeps
its emitted total `E` like a charge line (§5.7), and an input that changes its exact value
(late excess records, a superseding record, a reversal, a correction of a `usage_price` or
of the path's price) restates it to `C`:

| Change | Amendment emitted | What settlement posts (RFC-004) |
|---|---|---|
| `C > E` | `C − E`, with the trigger's reason | M23: each supplier paid up to its share of `C` less what it already holds (RFC-004) |
| `C < E`, the trigger a **superseding record from a supplier's exporter** that lowered it (cause: that supplier) | `C − E`, reason "superseding record", cause the supplier | Only that supplier's own reduction, as supplier debt: its share of `E` less its share of `C` (POL-22; P4-S116 second row: excess 10,000 → 5,000, A owes 3,000 − 1,500 = 1,500); every other party keeps what it was paid |
| `C < E`, any other cause (Share's exporter, a price correction whatever its cause, a reversal, other) | `C − E`, with its reason and cause | **Nothing**: a cost Share has paid is final (P4-S116 first row) |

In every case `E` becomes `C`. A later rise pays a party only above what it already holds,
so no party is paid twice (RFC-004 M23). The cost line's source reference carries an
amendment sequence (§5.8), as RFC-004's M12, M13 (sequence 0) and M23 references carry it.

#### 5.6 Closure: when a line is first emitted

A line's **original** is emitted when its minute is **closed** for the account, by one
entry; everything rating applied before that entry is in the original, everything after
it is an amendment. Because the account's state machine is serial, a record arriving
while its minute is being charged is either before the closing entry or after it, never
both and never neither (P3-S17); no lock is needed (Competition: D26). Closure decides only
what is original and what is amendment; it is never a condition of correctness.

**Reservation minute `m`** closes **per reservation** `r` (RFC-000 §4.5 and §8 as
revisions 4.2 and 4.3 state them; AI-17-3, AI-27-3; RFC-001 revision 4 §11.1) when
`m + 60 s` is at or before

`closure(r) = min( lifecycle closed time of the account's partition,
                   CLOSED(t) of every Share link of r's route,
                   hold_1(r), hold_2(r) )`

and rating has applied every event before those markers.

**Closure relies only on per-destination markers** (RFC-000 revision 4.3 §4.5, §5.5,
AI-27-3). Each closed time above is a marker read on the **destination partition** rating
consumes: the lifecycle feed's Kafka partition carrying the account, and the schedule
feed's partition carrying the link. The relay emits such a marker at `T` only once `T` is
at or below the resolved timestamp of **every changefeed partition that can feed that
destination** (the minimum over them) and it has published every row of those changefeed
partitions committed at or below `T`. Rating never reads a changefeed partition's own
resolved timestamp, never combines them itself, and never infers closure from an owner's
heartbeat; a range split, a lease move or a lagging relay partition can only hold a marker
back. So "rating has applied every event before the marker" means every fact committed at
or below `T` that can reach this account or link.

The lifecycle feed's closed time is that marker over the account's destination partition
(AI3-2): every entry not yet seen has a commit timestamp after it, and every reservation fact takes effect at or after the minute
containing its commit timestamp (confirmations from `floor_min`, every change and end from
a later boundary, a cause known in advance recorded before its minute), so no fact can
still affect `m`. A link's closed time is the `t` of its latest `CLOSED(t, feed_seq)`
marker, which RFC-001 emits as the per-destination minimum (above) with the link's
contiguous `feed_seq` (the relay's per-link `feed_seq` state being explicit, AI-27-3), applied
once rating holds every event of the link up to that `feed_seq`.

The one exception is a **POL-07 cut**, effective at its `T_eff` but decided by the link at
or after it. For each **open reduction** `R` of a link, known from its
`CAPACITY_CHANGED(reduction announced, R, T_eff)` event, rating applies RFC-001's two holds:

| Hold | Applies to | From | Until |
|---|---|---|---|
| `hold_1` = `T_eff` | **Every** reservation on the link | `CAPACITY_CHANGED(reduction_announced, R)` | Rating has applied the chunk of `REDUCTION_EFFECTIVE(R, extension 0)` with `last: true`, and so, events being applied in `feed_seq` order, every earlier chunk; these fix the affected set `A_R` (an empty `A_R` publishes chunk 1 with `last: true`) |
| `hold_2` = `T_eff` | Each reservation listed in `REDUCTION_EFFECTIVE` chunks (membership from the chunks only; `CUT_DECIDED` never adds a member) | All chunks held | `REDUCTION_FINAL(R)` is held **and** the highest `target_revision` among the lifecycle `cut` events applied for (link, R, reservation) equals the highest `CUT_DECIDED` revision for that key seen before `REDUCTION_FINAL(R)` in `feed_seq` order (C03 rule 3, settled M2, D39-1; C04 MM-3). A `cut` with `part_rates: []` (`APPLIED(none)`) counts; a lower revision keeps the hold |

So no reservation closes past `T_eff` before the affected set is known, and no affected
reservation closes past it before its cut is final and applied; the other reservations of
the account and the link close as usual once `hold_1` is lifted. **Offer-scoped cuts never hold closure** (RFC-001 review 32
V-3): a reservation whose only cut parts on the link are parts kept for an open
equivalent-path offer is not in `A_R` for the holds; while the offer is not Final its
offer-scoped target is recorded by the account owner against the offer (`KEPT_FOR_OFFER`,
the lifecycle event `offer_cut_kept`, which rating ignores; no **cut** event), so `hold_2`
never waits on it. On an offer that is already Final with the link on the new path, the
target is a normal `cut` (C04 N-03; "Late cuts amend" below). Its rate changes only through a move, which the lifecycle feed
records before the move's minute and rating applies as any move (§5.2).

**Late cuts amend** (C03 rule 5, R39-03 (c); POL-07 and POL-23 as `requirements-v1.11`
state them; P4-S117). **Any** lifecycle `cut` (or `ended(revoked)` in a cut's entry)
applied after some of its minutes from `T_eff` closed amends those minutes down to the cut
part rates. The usual paths are: an extension chunk after `REDUCTION_SET_EXTENDED` (a
projection defect RFC-001 alerts), which re-imposes `hold_2` on the reservations it adds
only from their current closure, so minutes from `T_eff` may already be closed and emitted
at the uncut rate (review 32 V-5); and an offer-scoped target applied as a normal cut from
`max(T_eff, move_at)` because the offer was Final with the link on the new path (C04
N-03). Rating never assumes such minutes open: once the cut is applied in the lifecycle,
it recomputes every closed minute from the cut's first minute at the cut part rates and
emits a reservation-line **amendment** for each line that changes (§5.7, reason
`late_pol07_cut`, keyed by (link, reduction) and the target revision), while minutes not
yet closed are held by `hold_2` where it applies and emitted at the cut rate as originals.
The held reservations' lines are emitted when their hold is released, in minute order, in
later reservation batches (§5.8). This replaces erratum 5.1's extension-only rule.

**Liveness** (C03 rule 7, R39-20). Rating alerts when a reservation's `hold_2` outlives
`REDUCTION_FINAL(R)` by more than 1 h (est.). A `cut_target` answered `MISMATCH` counts as
the recorded answer for `REDUCTION_FINAL`; that reservation's `hold_2` then waits for an
operator decision, and this alarm reports it (C02 review 54 m7).

**Gaps.** With a `feed_seq` gap on a link, `CLOSED(t, s)` beyond the gap does not advance
closure until the gap is filled; a duplicate chunk changes nothing; an unknown kind with the
next `feed_seq` is consumed as a no-op (C03 CT-3.5, CT-all).

The closed times are the database's, not the owners': they advance while an account owner
or a link schedule owner fails over, and stall only while a range moves its lease
(seconds). Rating closes `m` about 3 to 5 s after `m + 60 s` (est.: the closed-timestamp
target and the changefeed's resolved interval, RFC-006 settings), longer only for a
reservation held by an open reduction (R3-18). For speed, rating keeps the closed time per
route (the minimum over its Share links) and the holds per reservation. Prices for `m`
were fixed at least `price_notice` earlier, or are a correction, which amends.

**Usage minute `m`** closes at the later of

- `m + 60 s + flow_active_timeout + max_lateness + usage_close_margin` (15 s, est., which
  covers `attribution_lag_max`), and
- the moment the minimum stage A watermark (§4.2) reaches
  `m + 60 s + flow_active_timeout + max_lateness`,

but in any case by `m + 60 s + flow_active_timeout + max_lateness + 45 s`, so a stalled
exporter partition cannot delay every account's charges past the timeliness target.
`flow_active_timeout` is there because lateness now runs from a record's last minute
(RQ3-9 as decided): a record of at most `flow_active_timeout` that straddles `m` and
`m + 1` is on time until `max_lateness` after `m + 120 s`, and its part in `m` must be in
`m`'s original. So the original usage line holds every record accepted within
`max_lateness` (POL-14, X2-S13), and "late traffic" amendments are only for records that
really arrived late, or broke POL-13's export rule, or whose stage A partition stalled.

**Per-reservation accrual watermarks.** Each reservation's lines are emitted in strictly
increasing minute order, one for every active minute, never skipping; the watermark
"emitted through minute m" is all rating needs to never emit an original twice, and it is
what lets the ledger deduplicate originals by a watermark per reservation rather than by
an index over 2 × 10¹⁴ references (RFC-000 §4.4). About 63 M live watermarks at the design
load (RFC-000 §6), 16 B each: about 1 GB across all slots, about 4 MB per slot. Usage
lines are closed in increasing minute order per (account, product, route); a usage line
first created after its minute closed (a quarantine attribution, a superseding record, a
very late record) is a **late original**, which the ledger keeps in its exception set.

#### 5.7 Amendments (P3-N8)

**The amendment rule.** For each line, rating keeps its **emitted total** `E` (the original
and every amendment emitted). When an input changes the line's exact value, the new
charge is `C = ⌊V_new / 10⁶⌋` (§2), and if `C ≠ E` an amendment of `C − E` is emitted, with
the next amendment sequence and a reason. The original is never changed (P3-S32: 10,000
charged, a late 1 GB, an amendment of 10,000 to a total of 20,000; 75,000 bytes charged 0,
75,000 more, exactly 1.5, amendment 1). Because each amendment restates the line's total,
the sum of a line's postings is always `⌊exact value of everything known⌋`, whatever the
order and grouping of the inputs (P3-S15).

Each reason is a value of C06's closed `Reason` enum, shown here in brackets; its details
go in `reasonDetails` and the trigger in `triggerRef`.

| Trigger | Reason recorded, and cause | Direction |
|---|---|---|
| Late records (attributed parts after the line's closure) | "late traffic" (`late_traffic`), with the record identities | Only up: adding bytes never lowers an exact value, so never lowers its floor (P3-S33). A repeat of a record already charged never reaches rating (§3.5), so it amends nothing (P3-S16) |
| A price correction (§6.3) | "price correction" (`price_correction`), with the correction's ID, the operator, the **cause** (Share, a named supplier, other) and the reason | Either way for a usage price (P3-S34: −50,000; P3-S55: +20,000); only down for a reservation price, applied as `min(corrected, effective)` (§5.2 rule 4; P3-S56) |
| A finance attribution of quarantined traffic (§4.4) | "quarantine attribution" (`quarantine_attribution`), with the operator, the reason and the reference | Up |
| Its reversal (§4.4) | "attribution reversed" (`attribution_reversed`), with the operator, the reason and both references; cause **Share** | Down (P3-S65: −10,000) |
| Any lifecycle `cut` applied after minutes it covers closed (§5.6: an extension chunk, a Final offer's target, any other path) | "late POL-07 cut" (`late_pol07_cut`), with `lateCut` (link, reduction; CI3-1 for the target revision); **no cause** (settlement posts M6, or M7 in own mode: every party goes to its split of the corrected total, POL-23 as `requirements-v1.11` states it, also after a payout, netted from later runs) | Down: the cut part rates replace the uncut ones; the original stays |
| An accepted correction of a rejected record (§3.3) | "corrected record" (`corrected_record`), with the reject key | Up |
| A superseding record (§3.3) | "superseding record" (`superseding_record`), with the original's identity and version; for a downward amendment, cause **the exporter's owner** (a named supplier, or Share) | Either way (P3-S66: −10,000) |

Cost lines follow the same rule, with the posting rules of §5.5 for a downward amendment.

A line first created after its minute closed (a quarantine attribution, a corrected or
superseding record, a very late record) is a **late original**: sequence 0, reason
`original`, with the trigger in `triggerRef` and `reasonDetails` (C06 m5). Every sequence-0
line has reason `original`.

**Batching.** Late records for one line are gathered into at most one amendment per
`amendment_interval` (60 s, est.); each other trigger gives its own amendment, so every
amendment has exactly one reason and at most one cause. A correction that covers many
lines (a route's price for 30 days) is applied line by line in minute order, paced so that
its amendments do not crowd out originals (a usage batch holds at most the movement limit,
§5.8), and its progress is reported to the operator.

**Order of amendments** (C06-M5, D2). For **each** line (reservation, usage, cost line,
late original), rating emits sequence `k + 1` only after sequence `k` is acknowledged
`posted`, and a usage batch holds at most one sequence of each line key. So two
amendments due together on one line go in two consecutive batches.

**An excluded line** (F3-14; C06-M2, m3). Rating acts on each exclusion reason of the
posting acknowledgement:

| Reason | What rating does |
|---|---|
| `content_conflict` or `prior_total_mismatch`, on a line that is not a fee | Re-bases the line: `E` := `ledgerPostedTotal`, the next sequence := `ledgerLastSeq + 1`, and that posting is put at `ledgerPosition` for `P_X` (§5.9), in a `posted` entry. If `C ≠ ledgerPostedTotal`, it emits **at once** an amendment that restates the ledger to `C`, with the **reason and cause of the trigger** that made the problem line; for a problem **original**, reason `re_rate` (upward: M6; downward: cause Share, M8). So the ledger is never left short of the line's value for good |
| `out_of_sequence` | A defect under D2: alerted; the line is emitted again after its predecessor is acknowledged `posted`; `E` does not change |
| `invalid` (a line-level defect) | The line is **parked** (below) |
| `content_conflict` on a fee or Share-borne fee line | **Parked**: rating never amends fees, so it cannot re-base them |
| `batch_refused` | The line goes into a new usage batch (§5.8) |
| `batch_over_limit` | Rating makes batches within the limit (§5.8) |

**Parked lines** (C06-M11, D5). A parked line, and each later sequence of it, stays
unposted; rating alerts **at once**, the line shows in daily reconciliation as unresolved
(RFC-004), and rating never emits it again by itself. A parked line never causes the
refusal of another batch. Headroom still covers it: a usage line stays in `U` (§5.9); a fee
stays in the funds hold; a reservation original stays in the reservation hold. A finance
operator ends the parking with **`resolve_parked`** (C06 §13; operator envelope, role
finance, idempotent by `actionId`; a repeat returns the first answer, a caller not in
finance is refused):

- `re_emit`, after a fix: a parked reservation original goes in its own reservation batch,
  an exception to the increasing-minute rule (V63-5); every other line goes in the next
  usage batches, in sequence;
- `abandon`: rating emits the line again with the same source reference, `payer: share`,
  `abandon.actionId` set and `triggerRef` = `actionId`, with each parked dependant after it
  in sequence (a reservation original in its own reservation batch). Settlement posts it
  as a **Share-paid posting**: the buyer is not charged, the suppliers get their normal
  shares, and the funds hold is released (V63-4). For a fee conflict the ledger already
  has the fee key; rating takes the ledger's posting as final and closes the line.

**Splitting.** Rating labels each amendment with its reason and cause; how it is split
(POL-12: on its own after a correction borne by Share or a supplier at fault, otherwise the
split of the new total less the shares posted) and who bears a downward one (POL-23: Share
in full for cause Share or "other"; the supplier at fault for its own reduction) is
settlement's (RFC-004).

**What the buyer sees (P3-S35).** Each line's original and amendments, each with its
reason, emission time and posting time, are on the charge-line feed and in the ledger;
reporting serves them per minute (RFC-004).

#### 5.8 Source references and exactly-once emission (P3-N2)

Every line has a deterministic **source reference** (POL-29):

| Line (C06 `lineKind`) | Source reference (C06 `SourceRef`) |
|---|---|
| Reservation (`reservation`) | `reservation`: (reservation ID, minute, amendment sequence) |
| Usage (`usage`) | `usage`: (account, product, route, minute, amendment sequence) |
| Fee (`fee`, `share_borne_fee`) | `fee`: (reservation ID, fee ID); for a POL-28 residue, `residue_fee`: (request ID, partner link, fee ID). The reason is a field, not part of the key (C06-M4) |
| Carried excess (`carried_excess`) | `carried_excess`: (account, product, route, minute, amendment sequence) |
| Dearer path (`dearer_path`) | `dearer_path`: (reservation ID, minute, amendment sequence); the same form for every amendment of a cost line, as RFC-004's M12, M13 (sequence 0) and M23 references carry it |

A source reference is digested and compared only in C06's **canonical encoding** (kind tag
first, fields in schema order, length-prefixed, SHA-256), since the ledger keeps its
deduplication for 7 years. Each line carries `amount`, `newTotal` (`C`) and `priorTotal`
(`E` before it; 0 for an original), with `amount = newTotal − priorTotal` (C06-M3), its
`payer`, the `weightsVersion` of its original (never of its own minute, C06-M13), and
`triggerRef`. Each batch carries its `BatchId` and `lineCount`; each feed event carries
the substrate's `EventId` (C06-M10).

Rating commits the line to `rating_log` **before** emitting it, then emits it, as an
outbox row in the same transaction as the `emitted` entry, in one of **two batch streams**
(RFC-000 §8 as revision 4.2 states it; AI-19-1 resolved, F3-04):

| | **Reservation batch** | **Usage batch** |
|---|---|---|
| Carries | Reservation lines of **one minute** `m` of the account (originals only; affected marks go on their own topic, §5.2) | Every other line: usage lines (originals and amendments), reservation-line amendments, fee and Share-borne fee lines, cost lines and their amendments |
| Size | At most the movement limit `L` (RFC-004 §B10: 5,000 lines); a minute with more lines is several reservation batches, each with a disjoint set of reservations and each posted as one movement (RFC-000 revision 4.3 §6, §8, AI4-12) | At most `L` lines, and at most one sequence of each line key (C06-M5); lines due beyond it wait for the next usage batch |
| Over the limit | Rating checks `lines.length ≤ L` before it commits `emitted`. Settlement refuses **any** larger charge batch whole and acknowledges each line `batch_over_limit` (C06 V63-3); a defect, alerted: rating splits the lines again into batches within `L` under new `BatchId`s | The same; each new usage batch is named in a new figure before it is emitted |
| Gate | **None**: reservation lines never enter unposted usage, so no figure need name them | **Publish before emit** (§5.9) when it holds any usage line; a usage batch with none (fees, reservation amendments, cost lines only) is not gated |
| In flight per account | Up to `reservation_batches_in_flight` (8, est.), with one ordering rule: a reservation's line of minute `m + 1` is emitted only once its line of `m` is acknowledged, so originals reach the ledger in strictly increasing minutes per reservation, which its per-reservation watermark needs (RFC-000 §4.4) | **One**: the next is emitted only once settlement has acknowledged the last |
| Posted by settlement (RFC-004) | One M4 movement per reservation batch; a problem line is excluded alone and the others are posted | **Whole, in one movement, or not at all** (C06 D1): never split and never sharing a movement with another usage batch. If any line cannot be posted, the batch is refused whole: each problem line has its reason, every other line is `batch_refused`. Rating handles each problem line (§5.7), puts the `batch_refused` lines, but not the lines it parks, into a **new usage batch** with a new `BatchId`, and names it in a new figure before it emits it |
| Cadence | About one a minute per account (more for an account above `L` reservations), as each minute closes (§5.6) | About one a minute per account: the usage lines of the minute closed about 4¼ minutes after its end, with amendments and fees due since the last |

Delivery is at least once (the outbox's two paths); the ledger deduplicates each line by
its source reference, dropping a line already posted with the same contents (RFC-000 §4.4,
A0R-10). So however charging is repeated, interrupted or restarted, each reservation
minute, each record and each fee is charged once (P3-S12, P3-S13): the line's identity and
amount are fixed in rating's two-region log before it leaves.

**A very large account** (RFC-000 R6, F3-19). An account with 1 M reservations closes 1 M
lines a minute: 200 reservation batches of 5,000 lines (about 3.3 a second). With up to 8
in flight and about 0.2 s a posting (est.), they are posted within about 10 s of closure
(est.), inside the 2 min target. Its usage batches stay one in flight: about 17,000 usage
lines a minute at most for such an account (est.) is 4 batches a minute, well inside.

A line is marked posted only on a `posted` **posting acknowledgement** (C06 §7; RFC-000
§8; AI3-3, resolved), with its `postedTotal` and ledger position, recorded in a `posted`
entry; a `posted` answer is final, and a repeat (`duplicate: true`) carries the original
movement's position. An excluded line is handled by its reason (§5.7). The answers to one
batch may come in more than one message; together they answer each line exactly once.

#### 5.9 Usage exposure inputs to headroom (P3-N10)

Rating publishes, per account, for every product in the account's attachment set (§4.3)
**and every product with a usage line not fully posted** (a finance attribution to a
product the account does not attach, lines left after a binding ends; F3-09), the
unposted-usage part of usage exposure (POL-18, POL-14), on the **unposted-usage feed**
(§7):

- **Unposted usage** `U(X)` = `Σ over the account's usage lines L of the product of
  max(0, ⌊V(L)/10⁶⌋ − P_X(L))`, where `V(L)` is the line's exact value from every part
  rating has applied (records accepted and attributed, open minutes included) and `P_X(L)`
  is what settlement has acknowledged as posted for `L` through **ledger position X** of
  the account's ledger partition. The `max(0, ·)` keeps a downward amendment from being
  counted before its credit is posted. `V(L)` includes parts held by stage B's T4 hold
  (§4.3) and the tenancy check T2 (§5.3), and `U` includes parked usage lines (§5.7), so
  headroom sees traffic that is not charged yet (C11 F57-12, C06 m4). P3-S37: 0.2 GB at
  10,000 micro-USD/GB is 2,000 micro-USD.
- **The in-flight usage batch** `b`, if one is emitted or about to be: its identity and its
  **usage reduction** `Δ_b = U(X) − U(X with b posted)`, computed line by line with the
  same `max(0, ·)`. Only usage batches have one (AI-19-1); reservation batches are never
  named.
- For information (P4-S16), **accrued reservation charges not yet posted** through `X`.
  Reservation batches are not gated, so this may still count a batch posted after `X`
  until the next figure; it is information only and not in the headroom formula.

**The lateness bound is RFC-004's** (D-19-6, F3-08; RQ-19-5 and Q-1 decided). It is
computed once, by RFC-004's F3 from the catalogue, and rating does not publish it (C06 §3
has no field for it). Its definition (POL-14, P3-N10 as `requirements-v1.11` states them;
C06 "Exposure parameters"), which RFC-004 implements:
`cap* × Λ* × hp*`, rounded up to the micro, where `Λ = max_lateness + flow_active_timeout
+ 60 s + attribution_lag_max + admission's recovery time + 60 s`, and each starred value is
the **highest** in force at any instant of the bound's span `[now − (Λ* − 60 s), now +
60 s]`: `cap*` the highest `usage_rate_cap` of the (account, product), `Λ*` the longest
window (from the `policy_parameters` versions), `hp*` the product's highest `usage_price`
on any route. A `usage_rate_cap` change takes effect at a minute boundary at least the
60 s enforcement target after it is recorded (`effectiveFrom ≥ ceil_min(recordedAt +
60 s)`, §6.1), so an increase enters the bound 60 s before it takes effect, and a decrease
leaves it only `Λ* − 60 s` after (POL-14 v1.11, RQ-44-1). C06 m6 keeps a decreased cap 60 s
more for the edge's staleness, which review 65 accepts as conforming. The window
is the longest a byte can go uncounted at the cap: up to `flow_active_timeout` in a record
still open at its exporter, up to 60 s more until the end of the record's last minute (a
record straddling a boundary ends in the next minute), `max_lateness` from that minute's
end (§2), `attribution_lag_max` to be counted, admission's 60 s recovery time while the
account owner that applies the figure fails over (POL-06), and the 60 s from suspension to
enforcement. The price span looks back over the oldest traffic not yet counted (370 s) and
ahead over the traffic still to be carried before enforcement (60 s), so after a price
decrease the old price counts until no uncounted traffic can carry it. P3-S37: 180 + 60 +
60 + 10 + 60 + 60 = 430 s; 100 Mbps × 430 s = 5.375 GB at 10,000 micro-USD per GB, so
53,750 micro-USD; usage exposure 2,000 + 53,750 = 55,750. P4-S15 and P4-S16 show the same
figures in USD (0.053750 and 0.055750), as RFC-004 Part A presents them.

**P3-S76** (a cap change). Account "a1" has one best-effort product whose highest
`usage_price` is 10,000 micro-USD per GB, with a cap of 100 Mbps. At 10:00:30 finance
records a new cap; it takes effect at 10:02:00, the first minute boundary at least 60 s
after the record. The span at time `t` is `[t − 370 s, t + 60 s]`:

| New cap | Asked at | Span | Cap in the bound | Bound |
|---|---|---|---|---|
| 50 Mbps | 10:05:00 | 09:58:50 to 10:06:00, which has minutes at 100 Mbps | 100 Mbps | 5.375 GB, 53,750 micro-USD |
| 50 Mbps | 10:10:00 | 10:03:50 to 10:11:00, after the decrease took effect | 50 Mbps | 2.6875 GB, 26,875 micro-USD |
| 200 Mbps | 10:00:45 | 09:54:35 to 10:01:45, before the increase takes effect | 100 Mbps | 5.375 GB, 53,750 micro-USD |
| 200 Mbps | 10:01:30 | 09:55:20 to 10:02:30, after the increase takes effect | 200 Mbps | 10.75 GB, 107,500 micro-USD |

Rating's part is the catalogue entity: it refuses a cap version whose `effectiveFrom` is
earlier than `ceil_min(recordedAt + 60 s)` (§6.1) and publishes it at once, so F3 and the
edge's policing see it before it takes effect.

**Exact against the ledger balance (RQ3-12: no requirements change; the design pairs
exactly).** The account owner's headroom subtracts unposted usage from the ledger balance
it has applied, through position `P` (RFC-004 Part A). It applies a figure only once
`P ≥ X` (RFC-000 §4.6, AI3-3), and it counts
`U(X) − (Δ_b if the movement posting b is at or below P and posted b whole, else 0)`.
That is exact at every applied pair:

- nothing posted at or below `X` is counted, since `U(X)` excludes it;
- the only usage postings between `X` and `P` are those of the in-flight usage batch,
  because rating emits a usage batch holding a usage line only after the account owner has
  applied a figure naming it (**publish before emit**, below) and only one is in flight;
  reservation batches and ungated usage batches post no usage line;
- a usage batch is at most the movement limit and settlement posts it whole in one
  movement (RFC-000 §8 revision 4.2, AI-19-1), so its movement removes exactly `Δ_b`;
- a usage batch with a line that cannot be posted is refused whole and emitted again, so
  each posted usage batch is whole (C06-M12, D1).

This needs the ledger movement feed to say, per movement, which usage batch it posted and
whether whole, which RFC-000 §8 states (revision 4.1, AI3-10; revision 4.2, AI-19-1).

**Publication.** A figure is published for an account whenever it changes, coalesced to at
most one every `exposure_publish_interval` (**2 s**, est.; RFC-004 §A11 sizes F2 at this
rate, about 25,000 entries/s, where 500 ms would cost up to about 200,000/s), as absolute
values with the rating position (rating log sequence and the input positions behind it),
`X` and the in-flight usage batch, so a consumer applies the latest it may and ignores
older ones. A usage batch that becomes ready triggers a figure at the next allowed moment.
Rating emits a gated usage batch only after the account owner has acknowledged applying a
figure that names it as in flight and already counts its lines (**publish before emit**),
so a posting can never reach the balance before its traffic was counted in unposted usage.
The acknowledgement is C06's `UsageApplied` (§5.1): rating keeps the maximum
`appliedThrough` per account, and an older or repeated acknowledgement never lowers the
gate.

**Attribution lag (P3-S61, P3-S62, X2-S22).** A record is **counted** when the account
owner applies the first figure whose rating position includes the record's parts; the
usage-applied acknowledgement carries the applying entry's commit timestamp. For each
published figure rating keeps, per exporter, the earliest acceptance time and the identity
ranges of the records it newly counts. On the acknowledgement, every record counted more
than `attribution_lag_max` after its acceptance is reported as a **breach** of the usage
exposure bound with its exporter, identity and attribution lag, even when admission's
recovery time in the lateness bound covers it (POL-14, review 22 decision 4: every
failover that delays counting stays visible). It is charged like any other record (P3-S62).
Rating also reports, per minute and serving region, whether every record accepted in it was
counted in time, which is the X2-S22 measure (RFC-006 aggregates it per month and region).

Parts that reach rating through a **finance attribution** (a quarantined record's
superseding version included, §4.2) are **excluded** from attribution-lag breaches and from the X2-S22
measure (D-19-7, F3-10): at acceptance they belonged to no account, so no headroom could
have counted them. Parts released from the pending-binding hold are still reported, as a
provisioning breach (§4.2).

**Lateness (P3-S38, P3-S68).** A record whose lateness (§2: acceptance time less its last
minute end) exceeds `max_lateness` is reported as a breach with its exporter and lateness,
and charged like any late record. P3-S68: active 10:00:00 to 10:02:00, arriving 10:04:50
(170 s) is charged and not reported; arriving 10:05:10 (190 s) is charged and reported.
Corrections and superseding versions are not lateness breaches (they are not late
traffic); a superseding version that raises bytes is reported on the breach feed as such,
for finance and risk. Probe records are in neither report.

**Latency budget, acceptance → counted** (est., p99, steady): stage B committed 0.3 s
(§4.5) + rating applies and commits its `inputs` entry 60 ms + coalescing up to 2 s +
Kafka to the account owner 50 ms + the account owner's entry up to 60 ms ≈ **2.5 s**; about
2.8 s after a region loss; against 10 s, and inside the 2 to 3 s RFC-000 §2 allows for this
path. A takeover of any stage on the path costs about 5 s (est.), so about 7.5 s, still
inside 10 s; a changefeed relay instead of a direct publish (an owner died between commit
and publish) adds about 1 s per hop (RFC-000 §4.2); two of those at once, or a longer
outage of the path, produce breach reports, never a silent miss.

#### 5.10 Reproducibility and the cold re-rate (P3-N9)

Every input rating uses is a retained fact: raw records and their outcomes, corrected
records and superseding versions submitted by their exporters (§3, 7 years); the binding
history and the binding position of every attribution decision (§4); finance attributions
and their reversals (§4.4); the reservation lifecycle feed, from the account owner's log,
which records every change, shorten, end and its cause, and so every standing change that
ends a reservation (RFC-002, kept 7 years by history); the catalogue's price history and
corrections with who made them (§6); and rating's own log of the order in which it applied
them. Rating's state machine is deterministic, so replaying its log against those inputs
gives the recorded lines, amendments and amounts exactly (P3-S36). A **re-rater** does
this continuously for a sample of account-days, and on demand for any period, and alerts
on any difference.

**Cold re-rate** (F3-13). If a rating partition had to be rebuilt without its log (a
disaster beyond RFC-000's model, or a migration), it would:

1. replay every retained input in its commit-timestamp order, giving each line's sequence
   of totals, one per trigger (the original at closure, then each late-traffic interval,
   correction, attribution, reversal or superseding record), each with its reason and
   cause;
2. read from the **ledger**, the authority on what was charged, each line's postings: its
   last amendment sequence, its posted total and the mode of each posting;
3. for each line, skip the triggers the ledger already has (matched by the `triggerRef`
   that the ledger movement feed carries per line, C06-M3, M1), and emit the rest in
   order: an **original** where nothing is posted, otherwise one amendment per remaining
   trigger, numbered after the ledger's last sequence, each with its own reason and cause,
   so settlement splits and bears each as POL-12 and POL-23 say; a final amendment restates
   any remaining difference to `C` with reason `re_rate`: upward with no cause (M6),
   downward with cause **Share** (M8), so supplier earnings stay final (C06-M8).

Nothing is charged twice and nothing is missed, even with no record of where charging had
got to (P3-S13).

#### 5.11 Throughput and sizing

| Item | Estimate | Note |
|---|---|---|
| Reservation lines | About 1.05 M/s (63 M active reservations, RFC-000 §6) | One multiply-add per part per minute; run-length encoded in `accrual-closed` (a reservation's line is usually the same every minute): about 10 MB/s of log in all |
| Accrual closures | About 1,700/s (100,000 active buyer accounts, est.) | One entry per account and minute |
| Usage lines | About 1 M (account, product, route) attachments active (est.) → at most 17,000 lines/s | Plus about 1,000 amendments/s for late traffic (est., 5% of lines); about 8 MB/s of `usage-closed` and `amendment` entries with their ELAs (est., at 450 B a line) |
| Attributed parts applied | About 300,000/s at peak | ELA updates, O(1) each |
| Unposted-usage figures | At most one every 2 s per account with usage traffic: about 25,000/s at 50,000 such accounts, at most 50,000/s if all 100,000 had usage (est.; RFC-004 §A11) | Kafka events; each account owner applies at most one entry every 2 s per account, inside its own batch transactions (RFC-002) |
| Rating transactions | One slot batch transaction in flight per slot, 256 slots: about 8,500/s | §1.1 |
| Memory per rating slot | Reservation models about 200 B each, 63 M / 256 → about 50 MB; the last hour of closed lines' ELAs (17,000 × 3,600 ≈ 61 M lines at about 450 B, est., about 28 GB in all) → about **110 MB**, plus open usage ELAs (about 5 minutes of lines, about 10 MB); lines not yet fully posted, a few MB | The ELA size is an assumption (§2, R3-19); if measured larger, `amendment_hot_window` shrinks (15 min quarters it). Revision 1's "37 days of closed ELAs in memory" would be about 5 × 10¹⁰ lines (est. tens of TB); they are read back from the log when needed instead |
| Old-line reads | An amendment to a line closed more than `amendment_hot_window` ago reads its last entry from `rating_log` (live in the database for `dispute_window` + 7 days, est.) or from history's segments | Rare for late traffic; paced for a correction's fan-out (R3-7) |
| Charge-line batches to settlement | About 1,700 reservation batches/s and 1,700 usage batches/s (est.; RFC-000 §6) | Reservation batches up to 8 in flight per account, usage batches one (§5.8) |

RFC-000 R6 (a very large account) is absorbed: an account with 1 M reservations closes
1 M lines a minute (about 17,000/s) in one partition, within one lease holder's capacity
(est.), posted as 200 reservation batches a minute (§5.8); it can be given a slot to
itself.

#### 5.12 Hot standbys, recovery and timeliness

RFC-000 §2 requires hot standbys on the attribution → unposted-usage → account path and
on the reservation-accrual posting path. Here:

- every slot of stage A, stage B and rating has a standby NestJS instance in the other
  Kenyan region that consumes the same Kafka partitions, tails the slot's log rows and
  keeps the derived state current; for a slot group (stage B *i*, rating *i*) one standby
  process per role stands by for both slots and takes both in one acquisition
  transaction, `onAcquire` called for each before the group serves (RFC-006 revision 4
  §7.1, §10.3, §12.2). These owners serve no status reads, so RFC-000 revision 4.3's reporting
  rules for lapsed renewals, re-homes and moves (AI-27-1, AI-27-2) do not change them: every
  output is a feed event committed under the epoch;
- the owner lease for these classes is 3 s; on its expiry the standby takes it, reads
  anything committed since its last applied row, and resumes, re-emitting anything not
  yet acknowledged (idempotent): about **5 s** at p99 (est.; RFC-000 AI3-9). A database
  range-lease move after a node loss runs in parallel with it;
- checkpoints every 10 s of log bound a replacement standby's catch-up.

| Target | Design point (est., p99) | With one takeover | Bound |
|---|---|---|---|
| Reservation line posted (X2-S13) | Closure about 3 to 5 s after the minute's end, `accrual-closed` commit 30 ms, Kafka 50 ms; reservation batches are not gated (§5.8), so rating emits within about 6 s; settlement posts within about 1 min of the minute's end (RFC-004 §B3.1, est.) | + 5 s per takeover on the path (rating, settlement); neither an account owner's nor a link schedule owner's failover stops closure (§5.6); a reservation held by an open reduction waits for its final step (R3-18) | 2 min target; 7 min after a zone loss (5 min RTO ceiling) |
| Usage line posted, records within `max_lateness` (X2-S13) | Closure at 60 + 180 + 15 = 255 s after the minute's end, plus publish before emit (up to 2 s) and posting: about **258 s** | + 5 s per takeover; at worst 285 s (the stalled-watermark bound) plus about 3 s | `max_lateness` + 2 min = 300 s target; + 5 min after a zone loss |
| Accepted record counted in headroom (X2-S22) | About 2.5 s | About 7.5 s | 10 s (`attribution_lag_max`) |

A declared region disaster moves every database leaseholder and owner lease to the
surviving region (RFC-000 §5.1); rating's tables are two-region durable, so nothing is
recomputed: the affected minutes are posted late, within their target plus the 1 h
regional RTO, none lost or posted twice (X2-S19, X2-S23). The usage line's margin to its
target is about 42 s steady; a regional failover consumes it, and those minutes count
against the target only outside a declared disaster (POL-06).

### 6. Catalogue

**Component** (RFC-000 §2): hold the reference data every other owner prices, splits or
validates against. **Partition**: by entity, on `catalogue_log` tables; small (est. well
under 10 GB in all). Its link registry part (links, their supplier and endpoints, Share or
partner, probe flag; registered and retired by commercial, POL-07) is RFC-001's; everything
else is specified here.

#### 6.1 Entities, their versions and who sets them

| Entity | Versioned facts | Set by (POL-32) | Validated on write |
|---|---|---|---|
| Product | Kind (guaranteed, best-effort), permits burst | Commercial | — |
| Route | Ordered legs (link IDs from RFC-001's registry). Every **equivalent path** routing may offer under POL-07 is registered here as a route, with its prices and split weights, before it is offered (RFC-000 §8 revision 4.2, equivalent-path source; AI-19-2) | Commercial | Every link exists and is not retired; an offered path without weights is refused at the offer by RFC-002, which reads the catalogue replica |
| Price series (product, route, kind) | `reservation_price` (guaranteed only) or `usage_price` (every product, POL-17) versions: price in pico-USD, `effective_from`, `announced_at`, `oe_effective` | **Commercial, with a second commercial operator's approval** (POL-27, POL-01; RQ3-1 as decided) | §6.2 |
| Price correction | §6.3 | Finance (POL-23) | §6.3 |
| Split weights (route) | Per leg a weight, and the commission's weight, from `effectiveFrom` (POL-12) | **Commercial, with a second commercial operator's approval** (POL-12) | **Positive integers**; legs match the route; `effectiveFrom ≥ ceil_min(announcedAt + 60 s)`, **never retroactive**. A wrong weight is fixed forward only, by a new version; an amendment keeps its original's `weightsVersion` (C06-M13, D4) |
| Partner terms (partner link) | Minimum term, cancellation fee, whether a leg can be decreased (`decreaseAllowed`), maximum hold length, whether it accepts an expiry set by Share (POL-08, POL-26, POL-28) | Commercial, one operator (POL-32) | `decreaseAllowed` must agree with the partner driver's amend capability; onboarding fails otherwise (C12 S1) |
| Account-product terms | `usage_rate_cap` (POL-14), with `effectiveFrom` and `recordedAt`; before the first version the POL-14 default, 100 Mbps, applies (C06 m7) | **Finance**, with a reason (POL-14) | Positive, in whole Mbps; `effectiveFrom ≥ ceil_min(recordedAt + 60 s)`, the enforcement target (POL-14 v1.11, C06 D3; P3-S76) |
| Policy parameters (`policy_parameters`) | `policyVersion`, `effectiveFrom`, the deployment that wrote it, and the POL-14, POL-13, POL-27 and POL-17 values F3 and rating use (`max_lateness`, `flow_active_timeout`, `attribution_lag_max`, `price_notice`, `dispute_window`) | **Only a deployment** (a configuration release carrying the policy-register values); no console command writes it (C06-M7, D6) | `effectiveFrom ≥ ceil_min(recordedAt + 60 s)` |
| Probe designations | The probe supplier and its links, probe exporters (POL-06; semantics RFC-006). **No probe accounts**: placement's account slot map is their only source (C01 M11, C06-M14) | As RFC-006 states | — |

There is no `link_rules` entity in v1 (AI-55-1): the link decides validity, and the
validity rules are policy-register parameters a deployment gives to RFC-001 and RFC-002
under one `policyVersion`. Only this catalogue writes `catalogue.v1` (C06-M14, D7); link
rows stay on RFC-001's link-registry feed.

Every fact carries its commit timestamp, the pseudonymous principal, any approver and the
reason (operator action envelope, C08 §E), so the catalogue is bitemporal and answers "as
known at T" (POL-19). The catalogue serves C08's **target summaries** for the target kinds
`product_route`, `account_product`, `supplier_terms`, `partner` and `charge` (with rating
for `charge`), and appends its audit record before it answers; it verifies the envelopes
of `set_price`, `set_split_weight` (four eyes), `record_partner_terms`, `correct_price`
and `set_usage_rate_cap`, and calls `operator_check` when it applies each (C08 consumer
table, R46-09). A repeat of a recorded `action_id` gets the recorded outcome first. A four-eyes action reaches the catalogue only once the operator
console has its second approval (the console owns pending approvals, their
`approval_expiry` and cancellation); the catalogue checks, at application, that the
requester and the approver are distinct operators of the owning role, and **re-checks the
preconditions** (the price rules below, the route's legs), refusing with nothing changed if
they no longer hold (POL-32). An action from any other role is refused and recorded
(X1-S13, RFC-005). The role checks replace revision 1's "a principal RFC-005 authorises".

#### 6.2 Price rules (POL-27)

- Every `effective_from` is a minute boundary; a version that is not is refused. There is
  at most one version for each (product, route, kind, `effective_from`); a second one is
  refused (C06 m8).
- `announced_at` is the commit timestamp of the entry that records the approved version:
  a price is announced when it takes its place in the catalogue, not when it was
  requested.
- **Every version is published at least 1 min before it takes effect**:
  `effective_from ≥ ceil_min(announced_at + 60 s)`; a version that is not is refused at
  approval. This RFC **confirms** the lead time RFC-000 revision 4.3 §8 asks of the
  catalogue (B-AI-11): the catalogue feed carries per-destination resolved markers (§6.4),
  so a consumer whose replica has applied the feed through `T` holds every version
  announced at or below `T`, and every version effective at or before `T + 60 s` was
  announced by then. The account owner locks prices from its catalogue cache and
  refuses intakes while that cache is more than 60 s behind the feed's resolved timestamp
  (RFC-002 RB-19), so it can never lock a price that a version already published would
  have replaced.
- A `reservation_price` version applies to new bookings and new parts from
  `effective_from`, and to open-ended reservations from
  `oe_effective = max(effective_from, ceil_min(announced_at + price_notice))` (§5.2).
- **Every `usage_price` version**, whatever traffic it prices (best-effort, burst on a
  guaranteed product, traffic outside a reservation), needs
  `effective_from ≥ ceil_min(announced_at + price_notice)`; a version that does not is
  refused at approval (P3-S69; POL-27, RQ3-10 as decided).
- A version is never changed or withdrawn after it is recorded; a mistake in a price is
  fixed by a correction (§6.3).
- The notice of an open-ended price change to each holder, with the hold it needs and any
  top-up (POL-27, RQ4-8), is RFC-004's and the notifier's, from the catalogue feed. A
  `reservation_price` version carries `oeEffective`; a version that applies to an account's
  open-ended reservations causes that account's F11 price notice, which RFC-002 appends at
  the announcement, idempotent by (account, price version), recording the price step at
  `oeEffective` (C06 "Catalogue", `oeEffective`).

#### 6.3 Price corrections (POL-23)

A correction is a command from an operator in finance (POL-32), with a source reference
(POL-29), a **cause** (Share, a named supplier, other) and a reason, naming either:

- a **price version** of a (product, route) and a minute range: the corrected price
  replaces that version's price for those minutes for every line priced from it; or
- a **reservation** (and optionally a part) and a minute range: the corrected price
  replaces that reservation's part price for those minutes (P3-S56).

It is accepted in one entry, or refused with nothing changed:

| Check | Refused when |
|---|---|
| Role | The principal is not in finance (X1-S13) |
| Window | Any minute `m` of the range has `window_end(m)` at or before the accepting entry's commit timestamp (§2) (P3-S57; P3-S70: 10:00:59 on day D + 30 accepted for the minute 10:00 of day D, 10:01 refused) |
| Reservation prices only downwards | For a reservation correction: the corrected price is above the part's **effective price** (§5.2: rules 1 to 3, after a move or an open-ended re-price) at any covered minute (P3-S56: 3 refused; 1 accepted, −100 a minute; after a move to a path at 1.5, 1.8 refused; after an open-ended re-price 2 → 3, 2.5 accepted). For a `reservation_price` version, **any** upward correction, since every use of it is a lock |
| Usage prices | Never refused for direction (P3-S55) |
| Repeat | The same source reference with the same principal and contents returns the first result; with different ones it is refused (RFC-000 §4.4, AI4-1; kept 7 years) |

The reservation-price check evaluates the effective price from the catalogue's read model
of the reservation lifecycle feed (RFC-000 §2; AI3-7, resolved), which holds per part its
locked price, whether the reservation is open-ended (so the price versions' `oe_effective`
apply), and its moves (path price, effective minute), with the **same pricing module** as
rating (§5.2), so both compute one effective price (D-19-5, F3-03). Should the read model
lag the lifecycle feed (a move not yet applied), rating still applies the correction as
`min(corrected, effective)`, so no minute's charge can rise. Corrections are
bitemporal: a later correction of the same minutes supersedes an earlier one from its
commit timestamp, and the amendments it causes restate the line against the new price
(§5.7). Rating applies them to lines already posted (amendments) and to lines not yet
posted (their originals use the corrected price).

#### 6.4 Query, feed and availability

- **Feed**: per entity, ordered, every version, on Kafka from the outbox, with the
  resolved marker of each destination partition (the minimum over every changefeed
  partition that can feed it, emitted after the relay has published every such row;
  RFC-000 revision 4.3, AI-27-3). Every consumer (rating, attribution, the account owner
  for locked prices and partner terms, settlement for weights, network operations'
  policing for `usage_rate_cap`, RFC-006 for probe designations) keeps a full in-memory
  replica and records the **catalogue position** it used in every decision: the resolved
  timestamp through which it had applied the feed, so "the catalogue as known at T" is
  exactly what it used. The wire form is C06 §2 (`CatalogueEvent`, one per accepted
  change, ordered per entity by `entityVersion`); a refused change makes no event.
- **Query**: "the value of entity E as known at T, effective at minute m", served from the
  catalogue's projection by follower reads at T.
- **Availability**: no booking, record or charge waits on a catalogue write. Consumers
  decide from their replica; a catalogue partition that is down delays only operator
  changes to it. Writes are rare (est. a few per second).

### 7. Contracts

From RFC-000 revision 4.5, the interface detail is in the **frozen contracts**; RFC-000 §8
names each contract and gives a summary, and the contract governs. This section gives, for
each contract this RFC provides or consumes, its contract, and the semantics this RFC
depends on; where this text and a frozen contract differ, the contract governs, and a
defect found in a contract is under "Contract issues". Every asynchronous feed is a Kafka
topic fed by the transactional outbox (or a self-outboxed log), its events identified by
the substrate's `EventId` (partition, stream, `stream_seq`, with generation and epoch) and
consumed idempotently in sequence order (C01 §2.5, M5).

**Provided.**

| Contract (RFC-000 §8) | Frozen contract | Semantics this RFC gives |
|---|---|---|
| **Flow-record ingestion protocol** | C11 Part I | §3.1 … §3.3. At least once from the exporter, verbatim with its context; each record's outcome is durable in two regions before the acknowledgement; no negative acknowledgement; identity per §3.2, from (exporter, context, message) only; duplicates acknowledged as such; rejections kept with their reason and reject key; a non-conforming payload (`no template` or `unparseable`) in the log only as identity, keyed digest and reason, the payload, if kept, only in the personal-data store, each drop counted and reported (P3-S71, P3-S75); corrections (by reject key, before their deadline, P3-S78) and superseding versions (measured fields only) only from the producing exporter; the Share metering template, without personal data. Probe: acknowledgement within 1 s |
| **Metering hand-off** | C11 Part II (`ingestion.handoff.v1`) | `batch`, `correction`, `supersession` and `identity-conflict` rows, per exporter in `handoffSeq` order, from the self-outboxed `ingest_log`; closure markers from the emitter; never a delete event; never any part of a non-conforming payload. Consumer: attribution stage A |
| **Attributed parts** (internal) | C11 Part IV (`attribution.parts.v1`) | §4.2, §4.3: per (stage A partition, account) in `destSeq` order, with the binding facts forwarded per binding; stage B → rating in process, the table as the guaranteed path |
| **Non-conforming drop alert and drop report** | C01 §2.10 alert feed (outside C11) | §3.3 step 6 (P3-S75): first drop of an (exporter, hour, reason) alerted at once; one hourly report per (exporter, hour) from the log; never any payload |
| **Catalogue** (link registry RFC-001) | C06 §2 (`catalogue.v1`) | §6: products, routes, price versions (at least 1 min ahead, `usage_price` at least `price_notice` ahead, at most one per key), price corrections, split weights (positive integers, at least 1 min ahead, never retroactive), partner terms, account-product terms (`usage_rate_cap`, at least 1 min ahead), `policy_parameters` (deployment only), probe designations of links, exporters and the probe supplier only; one writer; resolved markers. Consumers: RFC-001, RFC-002, RFC-004, RFC-006, network operations |
| **Unposted-usage feed** | C06 §3 (`rating.unposted-usage.v1`) | §5.9: per account and product, `U(X)` with the rating position, the ledger position `X`, the in-flight usage batch and its `Δ_b`; no lateness bound; at most one figure per account every 2 s; none for probe accounts |
| **Charge-line feed** | C06 §5 (`rating.charge-lines.v1`) | §5.7, §5.8: reservation batches and usage batches; `SourceRef`, `lineKind`, `amount`, `newTotal`, `priorTotal`, `payer`, `payee` for fees, `reason`, `cause`, `triggerRef`, `lateCut`, `weightsVersion`, `abandon`; at most one sequence per line key in a usage batch; `k + 1` after `k` is `posted` |
| **Affected marks** | C06 §6 (`rating.affected-marks.v1`) | §5.2: annotations for SLA credit; nobody posts them |
| **Quarantine report feed** | C06 §10 (`rating.quarantine-report.v1`) | §4.4: per entry and state change, and per (link, minute); suppliers see their own links only; no probe traffic (CI3-2 for the "domain not of exporter" reason and entries with no link) |
| **Breach report feed** | C06 §11 (`rating.breach-report.v1`) | §5.9: lateness and attribution-lag breaches, superseding versions that raise bytes, and per minute and serving region whether every record was counted in time |
| **Evidence query** | C06 §12 (served by RFC-006 history) | §3.7: every accepted record of a reservation or link in a minute range, with its versions; a non-conforming reject only by identity, keyed digest, key version and reason; the reader verifies the read grant and appends its audit record before it answers |
| **`resolve_parked`** | C06 §13 | §5.7: finance only, operator envelope, idempotent by `actionId`; `re_emit` or `abandon` |
| **Operator commands and target summaries** | C08 §E, §F, §G | §4.4, §6.1, §6.3: envelopes verified, `operator_check` at apply, recorded outcome first for a repeated `action_id`, target summaries for `product_route`, `account_product`, `supplier_terms`, `partner`, `charge` and `quarantine_item` with the audit record appended before the answer |

**Consumed.**

| Contract | Frozen contract | What this RFC needs from it |
|---|---|---|
| **Reservation lifecycle feed** and its effective-time closure | C04 (`account.lifecycle.v1`), v2.3.1 | §5.1, §5.2, §5.4, §5.6: the events and fields C04 gives (`cut` with `target_revision`, `moved` with `fees_due`, `ShownFee`, `FeeDue` with payer, `ended` with `delay_min`, `partner_leg_affected`, `pol28_residue`, `account_is_probe`); the three early-effective events; the kinds rating ignores; the closure markers |
| **Link schedule feed** | C03 (`link.schedule.v1`) | §5.2, §5.6: `AFFECTED_CHANGED` (with `leg`), `CAPACITY_CHANGED`, `REDUCTION_EFFECTIVE` chunks with `last`, `REDUCTION_SET_EXTENDED`, `CUT_DECIDED` with revisions, `REDUCTION_FINAL`, `CLOSED(t, feed_seq)`; closure rules 1 … 7; `CAPACITY_CHANGED(maintenance*)` gives no line |
| **Usage-applied acknowledgement** | C06 §4, C05 S-4 | §5.1, §5.9: `appliedThrough`, `appliedTs`, `entry`; dedup by (account, `appliedThrough`); replay, then `usage_applied_since` |
| **Posting acknowledgement** | C06 §7 | §5.7, §5.8: `posted` with position and totals, or `excluded` with its reason and the ledger's totals |
| **Ledger movement feed** | C06 §9 | §5.10: per line its postings and `triggerRef` (cold re-rate only) |
| **Exposure parameters (F3)** | C06 "Catalogue", RFC-004 | §5.9: RFC-004 computes the lateness bound from the catalogue |
| **Attribution keys**, with the observation point → link mapping | C11 Part III (`provisioning.bindings.v1`) | §4.1: facts published at least `binding_lead` before they take effect; heartbeats; tenancy invariants T1 … T4 |
| **Owner runtime, account slot map, alerts, probe designation** | C01 | §1.1: slot batch transactions, slot groups, self-outboxed `ingest_log`, closure markers by `onResolved`, `Moving`, `Stopped`, `onMovedOut`, `onAdopt`, `CommandEnvelope`, alert feed, probe accounts from the slot map |
| **Principal context; operator envelope; read grant; audit** | C08 | §3.1 (exporter `device_cert` and its owner), §4.4, §6.1 (roles, envelopes, `operator_check`), §3.7 (read grants) |
| **Personal-data store and key service** | C09 v1.1 | §3.3: `put_payload` with `keep_by` and its four outcomes, `withdraw_payload(record_id, received_at)`, `digest_key(exporter[, version])`, `get` with purpose `flow_record_dispute` |
| **Partner terms and delivered figures** | C12 (S1) | §5.2, §5.4, §6.1: `decreaseAllowed` agrees with the driver; affected partner legs (CI3-3); Share's plain fee on a shorten without amend (CI3-4) |
| **Equivalent-path source** | RFC-000 §8, through RFC-002 | Every offered path is a catalogue route with split weights (AI-19-2), registered before it is offered (§6.1) |

### 8. Parameters

POL parameters are read from the policy register's values as configured; the others are
design parameters of this RFC, changeable without a change of mechanism.

| Parameter | Value | Source |
|---|---|---|
| `max_lateness`, `attribution_lag_max`, `usage_rate_cap` | 180 s, 10 s, 100 Mbps default (set by finance, effective at a minute boundary at least 60 s after its record) | POL-14; C06 D3, m7 |
| `dispute_window` | 30 days, from the end of the minute | POL-17 |
| `price_notice` | 30 days | POL-27 |
| `flow_active_timeout` | 60 s | POL-13 |
| Lateness bound window (computed by RFC-004) | `max_lateness` + `flow_active_timeout` + 60 s + `attribution_lag_max` + admission's 60 s recovery time + 60 s = 430 s; price span the last 370 s and the next 60 s | POL-14, POL-06 |
| `erasure_max` | 30 days from the request | POL-19 |
| Non-conforming payload deadline | `dispute_window` + 7 days after receipt (the receipt day's expiry key destroyed at that day's start + that) | POL-19; RFC-005 |
| `payload_put_limit`, `payload_put_global`; `payload_bytes_limit`, `payload_bytes_global`, `payload_max_bytes`; storage | 10/s per exporter, 1,000/s overall; 256 KiB/s per exporter, 4 MiB/s overall, 64 KiB a payload; 36 × 10¹² B of live payload bytes per copy (backstop) | C09 S-M1, S-M3 |
| `pd_put_timeout`; `keep_by` | 500 ms (est.); the put's issue time + `pd_put_timeout` − ε (ε = `max_offset`, 100 ms) | This RFC; C09 |
| Pending-withdrawal alert | 10 min (est.) | This RFC |
| Drop report hour; idle-slot report flush | 1 h (UTC hour of commit); at the hour's end + 1 min (est.) | This RFC (P3-S75) |
| `approval_expiry` | 72 h (applied by the operator console) | POL-32 |
| `ingest_retry_timeout`, `epoch_jitter`, `wrap_slack`, `future_skew_max` | 2 s, 2 s, 10 min, 5 min (est.) | This RFC; C11 |
| Credit window; exporter buffer; context check memo | 4 batches and 4 MB per session; at least 1 h at peak; 24 h (est.) | C11 |
| Correction deadline | `min(last minute end, first receipt) + dispute_window`; first receipt + `dispute_window` with no usable times | POL-23, POL-17; C11 D57-3 |
| Ingestion flush interval and size | 20 ms, 256 KB (est.) | This RFC |
| `binding_grace`; `binding_lead`; provisioning heartbeat | 5 min; 60 s; at least every 5 s, staleness alerted at 60 s (est.) | This RFC; C11 |
| `hold_2` liveness alarm | 1 h after `REDUCTION_FINAL` (est.) | C03 R39-20 |
| `usage_close_margin`, usage close bound | 15 s; `flow_active_timeout` + `max_lateness` + 45 s after the minute's end (est.) | This RFC |
| `amendment_interval`, `amendment_hot_window`, `exposure_publish_interval` | 60 s, 1 h, 2 s (est.) | This RFC |
| Movement limit `L`; `reservation_batches_in_flight` | 5,000 lines (RFC-004 §B10); 8 per account (est.) | RFC-004; this RFC |
| Owner lease (stage A, stage B, rating) | 3 s | RFC-000 §2 |

### 9. Design-level acceptance tests

Each cites the scenario it serves (docs/README.md conventions).

| Test | Serves |
|---|---|
| Identity: an exporter restart (new init time), a 32-bit wrap, and a verbatim redelivery of a pre-wrap message a simulated year later; the redelivery is a duplicate, the restarted sequence 7 is new | P3-S50, P3-S14 |
| Range sets: 10⁹ records with 1% reordering and 0.01% identity-bearing rejects; interval count and memory against §3.5; kill the ingestion lease holder mid-transaction and check the range-set rows equal the accepted identities in the log | P3-S14, X2-S04 |
| ELA: random records, spreads and negated parts against an independent rational reference, every floor equal, including crafted sums within 10⁻¹⁸ of an integer; denominators per line measured on a production-like flow mix (R3-19) | P3-S21, P3-S51, P3-S15 |
| Order independence: one set of records delivered in order once, and shuffled with 30% duplicates and 20% after their minute's closure; every line's posted total equal | P3-S15, P3-S32, P3-S33 |
| Closure race: records injected around the closing entry under load; each in the original or an amendment, exactly once | P3-S17 |
| Closure on resolved timestamps: kill an account owner, then a link schedule owner, during a minute; reservation lines still close within 10 s of the minute's end | X2-S13 |
| Closure under an open reduction: a POL-07 cut with `T_eff` inside a minute, its final step delayed 30 s; the affected reservations' minutes from `T_eff` are held and then emitted at the target rate, in minute order; the account's other reservations close on time; no affected minute is emitted at the old rate | X2-S13, P3-S58 |
| Restart: kill rating lease holders mid-batch and mid-emission, and drop the owner's direct Kafka publish so only the changefeed relays; then a cold re-rate from inputs and the ledger; no line missing or posted twice | P3-S12, P3-S13 |
| Lateness bound, jointly with RFC-004: P3-S37's account at 100 Mbps and 10,000 micro-USD per GB; the bound is 53,750 and exposure 55,750; a price rise announced inside the next 60 s raises it at once; after a decrease the old price counts for 370 s more; a byte carried at the start of an on-time 60 s record straddling a boundary, accepted at `max_lateness` and counted after an account owner's failover, is inside the window | P3-S37, P4-S15, P4-S16 |
| Publish before emit and exact pairing: an account with reservations and usage, one with more than 5,000 reservations; delay the usage-applied acknowledgement and the ledger movement feed independently; reservation batches post without waiting for any figure; no usage posting reaches the ledger before its figure is applied; every usage batch is posted whole; at every applied pair, headroom equals the exact value | P3-S61, P4-S16 |
| Unposted usage beyond the attachment set: a finance attribution to a product the account does not attach, and a binding ended with lines unposted; both counted in `U` until posted; the attributed parts raise no attribution-lag breach | P3-S27, P3-S61, X2-S22 |
| Attribution lag: stop a stage B lease holder for 15 s; the records accepted meanwhile are reported as breaches with exporter and lag | P3-S62, X2-S22 |
| Lateness from the last minute: records spanning two minutes at 170 s and 190 s after their last minute; only the second reported; both minutes' parts in their originals | P3-S68, P3-S38 |
| Corrections and supersessions: a correction (by reject key, also of a remainder with several records) and a supersession (also of a correction) from the producing exporter, each sent three times; another exporter's and an operator's attempt; a supersession after the window | P3-S30, P3-S66 |
| Supersession scope: versions changing bytes and packets, an end time within the minute, times moved into another minute, a service-tag field, the observation point; then a version 2 that moves outside the original's minutes after a version 1 that narrowed them; only the first two accepted, refusals recorded, the original's charge untouched by the refused ones | P3-S72 |
| Supersession dispositions: originals bound, held pending, quarantined, attributed by finance and reversed, each superseded; the version is bound to the same binding after a provisioning correction of it, quarantined in the quarantined one's place (0.5 GB of 1 GB, nothing billed), charged to the attribution's account, uncharged after the reversal; a later attribution selects the version's entry | P3-S73, P3-S66 |
| Non-conforming payloads: a template declaring source addresses, data sets sent with it anyway, and an unparseable tail, with marker addresses; scan every log table, topic, sealed segment, application log and trace for the markers (none); the identity, keyed digest and reason present; the payload readable through the console; unrecoverable after an erasure request naming its exporter and period, and after one by a user of its supplier, and, with the clock advanced, after its receipt day's expiry from the live store and a restored backup; kill the owner between put and commit and check the resend; exceed the per-exporter cap ("dropped: cap", identity, keyed digest and reason kept); make the store unavailable and check that conforming batches and the probe are unaffected and the batch is acknowledged within 1 s | P3-S71 |
| Drops counted and reported: one exporter sends non-conforming payloads at 50/s for 10 min (over the 10/s cap), one payload of 70 KB, then with the store stalled for 5 min, and once with the store committing a put whose answer is dropped; scan the store and every other copy for the dropped payloads (none once every withdrawal is answered); each drop's `batch` entry holds identity, keyed digest with its key version, reason and its keep outcome (cap, not taken in time, or unanswered with a `withdrawn` entry "was kept"); network operations gets one immediate alert per (exporter, hour, reason) and one hourly report whose counts equal the drop outcomes in the log; kill the ingestion lease holder just after the hour's end and before a withdrawal is answered, and check the report is written once and the withdrawal resent | P3-S75 |
| Attribution and reversal: attribute quarantined traffic, reverse it, try to attribute it again, and repeat each command with its source reference; once at the window's boundary | P3-S27, P3-S65, P3-S70 |
| Prices: an open-ended change with a part added after the announcement; a `usage_price` version for each kind of traffic with too little notice, refused at approval; a price and a weight approved by the requester, refused | P3-S64, P3-S69, X1-S31 |
| Fees: shortens into and past a minimum term, then a cancellation, one fee line at most; a shorten of a reservation with a plain cancellation fee, none; a 10-day and a 30-day window ending on a 30-day minimum term, the first charged at its end, the second not; a 10-day window extended to 40 days, none; a 10-day window shortened to 5 days, charged once at the shorten | P3-S63, P3-S74, P3-S60 |
| Cost-line amendments: carried excess lowered by a superseding record from a Share exporter (nothing posted), from supplier A's exporter (A's own reduction only, 1,500), and by a `usage_price` correction (nothing posted); then new excess back to 10,000: nothing to B and C, A repaid its 1,500 (M23) | P3-S41, P3-S66 (P4-S116 by RFC-004) |
| Moves: a reservation moved to a dearer path at 2.7 then its buyer's price corrected to 1.0; the buyer's line 4 → 3, the difference stays 4; its lines and the difference carry the path's route and weights; a reservation correction to 1.8 after a move to a path at 1.5 refused, and applied as `min` if it races the move | P3-S59, P3-S56 (P4-S110, P4-S115 by RFC-004) |
| Throughput: 600,000 records/s for 1 h with 1 M reservation lines/s on the database and Kafka at 2 + 2 + 1; transaction rates against §1.2; every X2-S13 and X2-S22 target met | X2-S04 |
| Cap change: P3-S76's four rows against RFC-004's F3 with the catalogue fixtures; a cap version with `effectiveFrom` earlier than `ceil_min(recordedAt + 60 s)` refused and never on the feed | P3-S76 |
| Domain not of exporter: records from a domain no observation-point fact of exporter "e1" names, and from an exporter with a credential but no facts; each accepted, held for `binding_grace`, quarantined "domain not of exporter", reported to the exporter's owner, never bound to another exporter's points; a finance attribution within `dispute_window` charges it, after it is refused | P3-S77, P3-S26 |
| Correction deadline: a record active only in 12:05 on day D, first received 12:07, corrected at 12:05 and at 12:06 on day D + 30; the first charged once, the second refused "outside dispute_window", recorded, nothing charged; a retry of the first after the deadline answered `duplicate`; a corrected flow end beyond the first receipt + `future_skew_max` refused; a record rejected "no epoch" made a duplicate in any context once corrected | P3-S78, P3-S30 |
| Rejection reasons: records with missing flow times, an interface pair and no direction, a negative byte count and an end before its start, each rejected with C11's reason and a stable reject key, the rest of the batch accepted | P3-S28, P3-S29 |
| Contract conformance, provider: C06 CT-R1 … CT-R13 (schema, lead times, batch limits, publish before emit, figure content, late POL-07 cut, re-base, redelivery, moves and cost lines, sequence and parking, fee payee, `resolve_parked`, late original); C11 provider tests for parts I, II and IV | P3-S12, P3-S27, P3-S37, P3-S61, P4-S117, X2-S13 |
| Contract conformance, consumer: C06 CT-C2 (posting acknowledgements), CT-C5, CT-C6 (probe accounts from the slot map only); C03 CT-3.1 … CT-3.8 (holds, offer-scoped targets, revisions, late cuts, gaps, maintenance, Final offers, liveness); C04 CR-4 and CR-6 (fee identifiers and `moved.fees_due`; probe flag, ignorable kinds, stop on conflict); C09 consumer tests (unanswered puts withdrawn, `not_kept(erased)`, `received_at` on the withdrawal, recorded key version) | P3-S10, P3-S44, P3-S58, P3-S60, P3-S71, P3-S75, X2-S20 |

## Benefits

| Need | How this design meets it |
|---|---|
| Exactly once for records (P3-N3) | One transaction per slot batch checks and inserts each identity with the append; range sets make 7 years of identities a few GB (est.), with the last day's epochs in memory, so the check is in memory at 600,000 records/s; identity survives wraps and restarts by construction |
| Every received record kept (P3-N7) | Every outcome, rejections, duplicates, corrections and superseding versions included, in a two-region insert-only table before the acknowledgement, sealed under retention lock; no head-of-line blocking; only the producing exporter corrects, and only measured fields, so a correction cannot move traffic between accounts, reservations or minutes |
| No personal data outside the erasable store (P3-N7, X1-N11) | A non-conforming payload never reaches a log, topic or segment: only its identity, keyed digest and reason do; the payload, if kept, is in the personal-data store, in an (exporter, hour) bucket, until an erasure request covering it or its receipt day's expiry, which reaches backups and escrow; a dropped one is nowhere, counted and reported from the log; ingestion's availability and its 1 s acknowledgement do not depend on the store |
| Exact charges in any order (P3-N3, P3-N5, POL-11) | Exact rational accumulation (ELA) and one rounding per line, by one `bigint` code path; amendments restate the total |
| Exactly once for lines (P3-N2) | Deterministic source references fixed in rating's two-region log before emission; ledger deduplication per line; watermarks per reservation |
| Amended, never rewritten (P3-N8) | Every change is a new amendment with one reason and, when downward and caused, its cause; late traffic only ever increases a line |
| Each kind of traffic by its rule (P3-N6, P3-N13) | Attribution fixes class and egress (the hand-off where the last leg is unmetered); rating applies the per-minute rule on exact totals; reversals at Share's cost; Share-borne costs computed where the amounts are known, paid once (the dearer-path difference against the charge as booked) and final except a supplier's own reduction |
| Fees by rule (P3-N12) | A plain fee only on a cancellation; a minimum-term fee on a cancellation or shorten into the term, or a booked window ending inside it as the offer showed; a fee ID at most once |
| Reproducible (P3-N9) | Every input retained and positioned (sequences, resolved timestamps); rating's log records the order of inputs; a continuous re-rater checks it |
| Usage exposure within 10 s, exact (P3-N10, X2-S22) | About 2.5 s from acceptance to headroom (est.), 5 s takeovers; exact against the balance by the ledger position X and the in-flight usage batch's reduction, usage batches posted whole; the lateness bound (RFC-004's, one definition) covers every on-time byte through an account owner's failover; breaches reported per record, finance attributions excluded |
| Timeliness (X2-S13) | Reservation batches emitted about 6 s after their minute (est.), not gated by any figure, posted within about 1 min against 2 min; closure waits on no owner's failover; usage lines about 258 s against 300 s |
| Ingestion availability (X2-N1) | Ingestion depends on nothing but its own tables (the store only for non-conforming batches, at most 500 ms); acknowledgement in about 85 ms (est.) against 1 s |
| Operator power controlled (X1-N7) | Prices and weights by commercial with four eyes, preconditions re-checked; corrections, attributions, reversals and caps by finance; no operator path to a record's contents |
| Policies as data | Prices, notice, windows, lateness, caps and design parameters are configuration; the mechanism does not change with them |

## Competition

| Alternative | Why it loses |
|---|---|
| **A hash index of every record identity** (prototype primary key) | About 6 × 10¹³ entries over 7 years; even at 16 B each about 1 PB, so not in memory, and every record a random read (RFC-000 §4.4, A0-08). As a database unique index it would also be the largest table in the system |
| **A Bloom filter for duplicates** | A false positive drops a genuine record silently, against P3-N7 and P3-N3 |
| **Identity by content digest** | Two distinct flows can have identical contents (same keys, times and bytes); counting them once loses revenue |
| **Exporter-supplied 64-bit sequence and epoch** | Simpler, but "unique whatever the exporter's counters do" (P3-N3) would then rest on every exporter's correctness; deriving the epoch from the system init time and the wrap from the export time puts it in Share's hands, with a digest check for violations |
| **A minute lock** (prototype, D26) | Correct only under one isolation level, and a lock per (reservation, minute) at 1 M lines/s. A serial state machine per account gives the same guarantee with no lock: a record is before or after the closing entry |
| **Assigning a flow to the minute it ended** (prototype, D28) | Against POL-13, and it can put more than the reserved rate's bytes in one minute, inventing burst |
| **Rounding each record, or each amendment's own amount** | The total would depend on arrival order (D25); rounding the line's exact total once is the rule (POL-11) |
| **Posting usage lines at the end of the minute and amending often** | Every record arriving 1 s to 240 s after its minute would be a "late traffic" amendment: many more ledger lines and an amendment-heavy bill for traffic that was not late by POL-14. Closing at `flow_active_timeout` + `max_lateness` stays inside the timeliness target |
| **Kafka as the record of ingestion** (acknowledge on Kafka's acks; Kafka transactions or a stream processor's checkpoints for exactly once) | RFC-000 makes Kafka transport, not record (§5.5): a fact is durable when the database commits it. Acknowledging on Kafka would tie X2-S14's two-region durability to Kafka's in-sync replicas, and the 7-year identity check would still have to be atomic with the append somewhere. The database transaction does both at once |
| **A per-partition transaction for every batch** | About 10⁵ transactions/s for these components alone (est.); slot batch transactions carry the same entries in about 24,000/s with the same single-writer and contiguity guarantees (AI3-11) |
| **A separate outbox table for the metering hand-off** | Writes every accepted record twice; the insert-only `ingest_log` is already a committed feed row, so its changefeed is the outbox |
| **Stage B to rating over Kafka** | One more hop (about 50 ms p99, about 1 s on the relay path) on the 10 s headroom path, for two owners whose slots form one slot group, held by one process, anyway (RFC-006 §7.1) |
| **Unposted usage as a stream of deltas** | A lost or repeated delta would skew headroom permanently; absolute values at positions are idempotent and reproducible |
| **Unposted usage without the ledger position X** | The account owner could apply a figure that has already dropped a line whose posting it has not applied, overstating headroom (AI3-3) |
| **One mixed charge-line batch per tick** (revision 3) | Settlement posts reservation lines and usage lines in different movements, so the batch is never posted whole and the in-flight usage is counted twice every minute (F3-04); gating reservation lines on a figure also delayed them for nothing |
| **Rating publishes its own lateness bound** (revision 3) | Two owners computing one value disagree (rating looked forward, RFC-004 at the current price); one definition, computed once by RFC-004 (D-19-6) |
| **Verified interval arithmetic with an exact fallback** (revision 3) | In Node.js 128-bit fixed point is itself `bigint`; two code paths, one rarely exercised, for no saving (F3-18) |
| **Validating reservation corrections against the locked price** (revision 3) | After a move a "downward" correction could raise the charge above the path price, and an open-ended re-price could not be corrected (F3-03) |
| **Amending cost lines by posting every downward change** (revision 3) | Debits suppliers whose earnings are final (POL-23); only a supplier's own reduction is owed |
| **Pairing by X alone** (revision 1) | Counts the in-flight batch's usage twice until the next figure; conservative, but not "until posted, and no longer" (RQ3-12). The in-flight reduction makes it exact for one more field |
| **Keeping every closed line's ELA in memory for `dispute_window`** (revision 1) | About 5 × 10¹⁰ lines (est.); the ELA is in the line's last log entry, read back when an amendment needs it |
| **Attribution inside ingestion** | Ingestion's 99.99% and 1 s would then depend on provisioning data (RFC-000 §2) |
| **Rating deciding attribution too** | Rating would need the network's keys; separating them lets attribution be replayed from provisioning history alone |
| **An operator path for corrected records** | Rejected by the requirements (POL-23, RQ3-2): an operator could then create or remove traffic |
| **"First attribution wins"** (revision 1) | Rejected by the requirements (POL-17, RQ3-3): a wrongly charged buyer could never be refunded |
| **Storing duplicates verbatim** | Doubles storage for an expected few percent of records without adding evidence; a compact entry with a digest keeps every receipt findable and detects conflicts |
| **Keeping a non-conforming payload in the log, encrypted under a per-exporter, per-day key that is later destroyed** (revision 2's AI3-12 proposal) | Puts possibly personal data in a 7-year insert-only log and its sealed segments under retention lock, erasable only by key destruction the log's own tooling must respect; the requirements now keep it only in the erasable store (POL-19, RQ3-14), which has erasure, expiry and audit of reads already |
| **Holding a non-conforming batch until the store answers** | Keeps more dispute evidence, but a store outage would also hold a misconfigured exporter's conforming records; `pd_put_timeout` bounds the wait |
| **Keeping only the digest, discarding the payload** | Simplest, but a supplier disputing a rejection could not be shown what was received; the requirements keep the payload for `dispute_window` + 7 days |
| **A plain SHA-256 digest of a rejected payload** | Reversible for a short record holding an address, by trying every address; the keyed digest keeps the same evidential value for Share alone |
| **Binding a superseding version afresh at the current binding position** (revision 2) | A provisioning correction between the original and its version would move the traffic to another account or reservation through the exporter's correction, which POL-23 now forbids; inheriting the original's disposition per minute charges it where the original was charged |
| **Keeping an unparseable remainder in the log as received** | Its content cannot be shown free of personal data; treating it as non-conforming costs a store put for a rare case |
| **A separate 7-year postings index for evidence** | About 1 PB per copy (est.); sorting sealed segments by key with block statistics answers the same queries |

## Risks and open issues

| # | Risk | Mitigation |
|---|---|---|
| R3-1 | **Every load figure is an estimate**: records per second, 100 B a record, parts per record, exporters, active reservations, usage lines, transactions per slot | RFC-006's load test (X2-S04) at the design profile; slot counts and flush intervals are configuration |
| R3-2 | **Exporter clocks.** Minutes are assigned by the exporter's flow times; a skewed exporter shifts traffic between minutes, prices and reservations | Per exporter, the gap between export time and acceptance time is monitored and alerted; records too far in the future are rejected (§3.3); the source is assumed reliable (P3) |
| R3-3 | **Byte accounting versus policing.** If the policer counts bytes at another layer than the exporter, a reservation at its reserved rate could appear to exceed it, inventing burst or excess | The protocol fixes the octet count's layer to the policer's (delivery contract); excess incidents (§5.5) surface any mismatch early |
| R3-4 | **Provisioning lag.** A binding published after traffic starts sends that traffic to quarantine, recoverable only by finance attribution; an end or a move published late could charge the previous tenant | Contract (C11 D57-1): every fact at least `binding_lead` before it takes effect, ends and changes included; stage A binds only at a covered position (§4.2); `binding_grace`; quarantine volume alerted per link |
| R3-23 | **Epoch sets grow with init-time drift**: about one epoch a day per domain, about 10⁸ sets in 7 years (est.) | Closed sets compact and stay in the database; only the last day's sets are in memory; older ones cost one read per message (§3.5) |
| R3-24 | **A T4 or T2 hold** keeps traffic uncharged until provisioning or finance resolves it | Counted in unposted usage, so headroom sees it; alerted; dropped and reported to finance at its minute's end + `dispute_window` (§4.3, §5.3) |
| R3-5 | **Resolved-timestamp lag.** Reservation closure follows the database's closed timestamps and changefeed resolved interval (about 3 to 5 s, est.); a range-lease move stalls it for seconds | Far inside 2 min; RFC-006 sets the closed-timestamp target and resolved interval and the spike measures them (RFC-000 R18). Revision 1's dependence on the account owner's failover is gone |
| R3-6 | **A stalled stage A partition** would hold every usage closure | The 45 s bound (§5.6) closes anyway; its late records become amendments |
| R3-7 | **Correction fan-out**: a 30-day route correction amends every line of every account on the route, most of them read back from the log | Paced application; progress reported; bounded by `dispute_window` |
| R3-8 | **Very old usage lines** (a record years late) need their state read back from archives | Rare by assumption (reliable source); cost is a read of a few segments |
| R3-9 | **Publish before emit, and one usage batch in flight, couple usage posting to the account owner and settlement** | Only usage batches holding a usage line are gated; a batch waits at most for the account owner's or settlement's takeover (about 5 s) plus the 2 s publish interval; within the targets. Reservation batches are not gated |
| R3-10 | **Storage**: about 2 to 3 PB per copy of compressed raw records over 7 years (est.) | Two copies only (sealed segments); columnar compression; RFC-006 confirms |
| R3-11 | **Exact `bigint` floors** on lines with many denominators cost CPU | Computed only on close, change and publication, and cached per line; measured on the load test |
| R3-12 | **Database transaction rate**: about 24,000 transactions/s from these components (est.), beside admission's and the ledger's | Slot batch transactions (AI3-11); the R1 spike and RFC-006's re-costing include it (RFC-000 §5.5 item 7) |
| R3-13 | **Usage margin.** The usage line's design point is about 258 s against 300 s; a regional failover or a slow Kafka hop consumes the margin | Measured; `usage_close_margin` can shrink toward `attribution_lag_max`; failover minutes in a declared disaster are outside the measure |
| R3-14 | **Kafka consumer lag** on the attribution path turns into attribution-lag breaches | Consumer lag alerted per partition; hot standbys consume the same partitions; breaches are reported, never silent |
| R3-15 | **Payload expiry depends on the store's keys.** A day expiry key that leaked into a backup would let a payload outlive `dispute_window` + 7 days | RFC-000 §8 (revision 4.2) and RFC-005 hold expiry keys only in the HSMs, never escrowed or backed up; the test of §9 restores a backup past the expiry |
| R3-16 | **A misbehaving exporter's non-conforming flood** | RFC-005's caps (10 puts/s per exporter, 1,000/s overall): beyond them the payload is dropped, its identity, keyed digest and reason kept, counted and reported to network operations (§3.3), and the store alerts the supplier; a batch waits at most `pd_put_timeout` |
| R3-22 | **An exporter partition stalled on its digest key**: a non-conforming payload from an exporter with no cached key version, while the key service is down, holds that exporter's batches unacknowledged (its conforming records too) | Keys fetched at lease acquisition, so this needs a takeover or a new exporter during a key-service outage; only that partition waits; alerted; the exporter buffers and retransmits, and ingestion may lag but loses nothing (X2-N1). Rejected alternative: a fifth keep outcome "dropped: digest unavailable", which would keep no keyed digest, against P3-S71 and P3-S75 |
| R3-21 | **A withdrawal pending while the store is down**: a payload committed by a put whose answer was lost exists, in the erasable store only, until `withdraw_payload` is answered | Bounded by the store's recovery; retried until answered and rebuilt after a takeover from the log; alerted after 10 min; meanwhile under its day expiry and every covering erasure (POL-19's restriction holds). The earlier race (a store commit after the caller stopped waiting) is removed by `keep_by` (AI3-15) |
| R3-17 | **A larger lateness bound** (430 s, was 370 s) deducts 60 s more of `usage_rate_cap` from every account's headroom (7,500 micro-USD at P3-S37's price) | Accepted by the requirements (Q-1 as decided in v1.8); finance can lower `usage_rate_cap` per account and product |
| R3-18 | **Closure held by an open reduction**: a reservation in a POL-07 cut's affected set accrues no posted line from `T_eff` until the link's final step is applied | RFC-001's final step is normally seconds after `T_eff`; a hold older than 60 s is alerted; held minutes past the 2 min target count against X2-S13 and are visible |
| R3-19 | **ELA size**: 450 B a line assumes about 50 denominators | Measured (§9); `amendment_hot_window` shrinks if larger; the worst case per line is about 1 MB |
| R3-20 | **A cost-line correction reversed by a later one** | None: RFC-004's M23 pays each party only up to its share of the new total less what it holds, so a reduction that was not reclaimed is never re-paid |

## Requirements issues

Revision 1 raised RQ3-1 … RQ3-12; `requirements-v1.6` decides all of them
([review 11](../reviews/11-requirements-amendments-from-detailed-rfcs.md), RFC-003 table).
Revision 2 raised RQ3-13 … RQ3-15; `requirements-v1.7` decides all three
([review 12](../reviews/12-requirements-amendments-from-rfc-revision-2.md)). This revision
applies every decision.

| # | Issue | Resolution | Applied in |
|---|---|---|---|
| RQ3-1 | No role sets prices, weights, partner terms, `usage_rate_cap` | **Resolved** (v1.6): commercial sets prices and weights, each with four eyes, and records partner terms; finance sets `usage_rate_cap` (POL-32, POL-14) | §6.1 |
| RQ3-2 | Who submits a corrected record | **Resolved** (v1.6): only the producing exporter, under its own credential; no operator path (POL-23, POL-32; P3-S30) | §3.3 |
| RQ3-3 | Undoing a wrong finance attribution | **Resolved** (v1.6), revision 1's "first attribution wins" not adopted: finance reverses within `dispute_window`, the buyer's charge goes to zero with cause Share, the supplier keeps its payment, the traffic is never attributed again (POL-17; P3-S65) | §4.4, §5.7 |
| RQ3-4 | A shorten into a partner's minimum term | **Resolved** (v1.6) as revision 1 read it: the shown fee, paid as for a cancellation (POL-08; P3-S63) | §5.4 |
| RQ3-5 | Open-ended re-pricing of later parts | **Resolved** (v1.6) as revision 1 read it: every part, parts added later included (POL-27; P3-S64) | §5.2 |
| RQ3-6 | Where `dispute_window` starts | **Resolved** (v1.6) as revision 1 read it: from the end of the traffic's or charge's minute (POL-17; P3-S70) | §2, §4.4, §6.3 |
| RQ3-7 | Egress on an unmetered partner last leg | **Resolved** (v1.6) as revision 1 read it: the count at the hand-off (POL-17; P3-S67) | §4.1 |
| RQ3-8 | Rounding of the dearer-path difference | **Resolved** (v1.6) as revision 1 read it: the path's charge rounded down once, less the buyer's charge (POL-07, POL-23; P4-S110) | §5.5 |
| RQ3-9 | Lateness of a spread record | **Resolved** (v1.6) as revision 1 read it: from the end of its last minute (POL-14; P3-S68). Usage closure allows for it (§5.6); the bound's window too, since RQ3-13 | §2, §5.6, §5.9 |
| RQ3-10 | Notice for every `usage_price` | **Resolved** (v1.6) as revision 1 read it (POL-27, POL-14; P3-S69) | §6.2 |
| RQ3-11 | Correcting an accepted record whose contents were wrong | **Resolved** (v1.6): a superseding version from its own exporter within `dispute_window` of the original's last minute, the original kept, the downward amendment borne by the erring exporter's owner (POL-23; P3-S66); its scope since RQ3-15 | §3.3, §4.2, §5.7 |
| RQ3-12 | Unposted usage "until posted, and no longer" | **No requirements change** (v1.6): the design must pair exactly. It does, with the in-flight reduction (AI3-10) | §5.9 |
| RQ3-13 | The lateness bound's window | **Resolved** (v1.7, [review 12](../reviews/12-requirements-amendments-from-rfc-revision-2.md)) as revision 2 derived it: `usage_rate_cap` × (`max_lateness` + `flow_active_timeout` + 60 s + `attribution_lag_max` + 60 s) × the highest `usage_price`, 370 s at the defaults (POL-14, POL-18, P3-N10; P3-S37, P4-S15, P4-S16 recomputed) ; since v1.8 (Q-1, RQ-19-5) 430 s with admission's recovery time, priced over the bound's span, and computed by RFC-004 | §5.9, §8 |
| RQ3-14 | Personal data in a non-conforming export | **Resolved** (v1.7, review 12): rejected; logs and the record kept hold only identity, digest and reason; the payload only in the erasable personal-data store, unrecoverable on an erasure it falls under or `dispute_window` + 7 days after receipt, whichever first (POL-19, P3-N7; P3-S71). Revision 2's reading (kept, encrypted, in the log) is withdrawn | §1.1, §3.1, §3.3, §3.4, §3.7, §7 |
| RQ3-15 | Scope of a superseding record | **Resolved** (v1.7, review 12), revision 2's reading (service keys may change; a quarantined original's version attributed afresh) **not** adopted: measured fields only (bytes, packets, times within the original's minutes), never identity or attribution keys, else refused and recorded; a version of a quarantined record is quarantined in its place; one of an attributed record charged to the same account; one of a reversed attribution uncharged (POL-23, P3-N7; P3-S72, P3-S73) | §3.1, §3.3, §4.2, §4.4, §7 |

Revision 3 raised RQ3-16, and review 19 raised RQ-19-1 … RQ-19-5; `requirements-v1.8`
decides all six ([review 22](../reviews/22-requirements-amendments-from-c3-reviews.md)).

| # | Issue | Resolution | Applied in |
|---|---|---|---|
| RQ3-16 | Who can ask for an erasure that a rejected flow payload falls under | **Resolved** (v1.8, review 22): a non-user, or someone acting for that person, by a documented erasure request naming the exporters and period, verified by compliance; a request covers a payload if it names its exporter and a period including its receipt, or comes from a user of the exporter's supplier or of the attributed account (POL-19, X1-N7, X1-N11; X1-S42) | §3.3 |
| RQ-19-1 | A plain cancellation fee on a shorten | **Resolved** (v1.8): only on a cancellation; a shorten to a later end incurs only a minimum-term fee its new end falls inside (POL-08, P3-N12; P3-S63 third row) | §5.4 |
| RQ-19-2 | A booked window ending inside a minimum term | **Resolved** (v1.8): the buyer pays the fee shown on the offer (POL-08, P3-N12; P3-S74); review 19's interim Share-borne line (D-19-2) is not adopted | §5.4 |
| RQ-19-3 | Dearer-path difference after a correction of the buyer's price | **Resolved** (v1.8): against the buyer's charge as booked (POL-23, POL-07; P4-S115) | §5.5 |
| RQ-19-4 | Downward change of a cost Share has paid | **Resolved** (v1.8): final, except a supplier's own reduction when its exporter erred (POL-23; P4-S116) | §5.5 |
| RQ-19-5 | Time span of the lateness bound's price | **Resolved** (v1.8): the highest price in force from the window less the enforcement target before now to the enforcement target after (POL-14, P3-N10) | §5.9 (RFC-004 computes) |

Revision 4 raised RQ3-17; `requirements-v1.9` decides it
([review 28](../reviews/28-requirements-amendments-from-c3-round-2.md), RQ3-17 row and its
decision 6).

| # | Issue | Resolution | Applied in |
|---|---|---|---|
| RQ3-17 | Whether a non-conforming payload must be kept | **Resolved** (v1.9, review 28) as revision 4 read it, the restriction reading: identity, keyed digest and reason always kept, nothing more of the payload outside the erasable store; the payload, if kept, only there; keeping it not required, dropped beyond the design's caps (RFC-005 RD-1, review 28 decision 6) or when the store does not take it in time, never kept elsewhere, each drop counted and the count reported to network operations (POL-19, P3-N7; P3-S71 reworded, new P3-S75) | §1.1, §3.3, §3.4, §7, §8, §9 |

No new requirements issue in this revision. The other `requirements-v1.9` changes were
checked against these components: X2-N1's `slot_probe_limit` (1 s) applies to the slot
rule of admission and the wallet only, not to usage ingestion, whose probe limit stays
1 s (§3.6); POL-06's other text is unchanged for ingestion; POL-07's maintenance outside the
committed rate, trimmed at a reduction's effect, and the cut rate counted after a notice's
end are the link's (RFC-001), reaching rating only as affected marks and cut events (§5.2);
POL-32's recovery hold (no exporter credentials issued in it) is RFC-005's, and an exporter
credential, whenever issued, still names its owner as §3.3 needs.

The C4 contract reviews raised requirements issues against this RFC's components;
`requirements-v1.11` decides each ([review 65](../reviews/65-requirements-amendments-after-c4.md)),
and revision 6 applies them. No new requirements issue is raised in revision 6.

| # | Issue | Resolution | Applied in |
|---|---|---|---|
| RQ41-1 | P3-S28's "no exporter" and "no sequence number" cannot occur for authenticated IPFIX and NetFlow v9 | **Resolved** (v1.11): P3-S28 uses "missing flow times" and "missing attribution key"; new P3-S77 for a domain not registered to its exporter | §3.3, §4.2, §4.4, §9 |
| RQ41-2 | No deadline for a correction of a rejected record | **Resolved** (v1.11): charged only before `dispute_window` from the earlier of its last minute's end and its first receipt; later refused and recorded; new P3-S78 (POL-23) | §3.3, §8, §9 |
| RQ41-3 | Identity for NetFlow v9 | **Resolved** (v1.11): identity = exporter, observation domain, counter epoch and position in the export stream (P3-N3, glossary) | §3.2 |
| RQ-36-3 | Which payloads a user's erasure request covers | **Resolved** (v1.11): those received before it is executed; C09's 1 h margin conforms (POL-19) | §3.3 |
| RQ-48-1 | A record that holds two persons' data | **Resolved** (v1.11): erased whole (POL-19); a payload is one item | §3.3 |
| RQ-44-1 | Which cap and which window the lateness bound uses | **Resolved** (v1.11): the highest cap and the longest window over the span; a cap change at a minute boundary at least 60 s after its record; new P3-S76 (POL-14) | §5.9, §6.1, §9 |

The other `requirements-v1.11` changes were checked against these components: POL-07's
move after a cut and amendment of minutes charged at the uncut rate, and POL-23's late cut
exception, are applied in §5.2, §5.6 and §5.7; POL-08's "shown means in a quote" is the
account owner's (the lifecycle feed carries the fees shown, §5.4); POL-28's partly-missing
partner reservation is applied as affected marks (§5.2, CI3-3); POL-06, POL-16, POL-21,
POL-22, POL-24, POL-29, POL-30, POL-32, X1-N6, X1-N7, X1-N9 and X2-N1 change nothing in
metering, attribution or rating.

## Architecture issues

Revision 1 raised AI3-1 … AI3-9; RFC-000 revision 4 resolves all of them ("Revision 4
resolution", RFC-003 table), and this revision builds on the resolutions.

| # | Issue | Resolution in RFC-000 revision 4 | Used in |
|---|---|---|---|
| AI3-1 | Attribution "decides the billing rule" | **Resolved**: attribution fixes the traffic class, rating applies POL-17's rule (§2, §7) | §1, §4.2, §5.3 |
| AI3-2 | Effective-time closure of the lifecycle feed | **Resolved**: the changefeed's resolved timestamp over monotone commit timestamps (§4.5, §8) | §5.6 |
| AI3-3 | Posting and usage-applied acknowledgements; pairing by ledger position | **Resolved**: both added; every figure carries X, applied once the applied ledger position reaches X (§2, §4.6, §8) | §5.8, §5.9 |
| AI3-4 | POL-28 residue fees on no feed | **Resolved**: residue events on the lifecycle feed (§8) | §5.4 |
| AI3-5 | Quarantine and breach feeds, evidence query, cost lines | **Resolved**: added, owned here (§2, §8) | §5.5, §7 |
| AI3-6 | No owner for `usage_rate_cap` | **Resolved**: the catalogue's account-product terms; the edge's policing reads it (§2, §8) | §6.1 |
| AI3-7 | Locked prices for downward-only corrections | **Resolved**: the catalogue's read model from the lifecycle feed (§2, §3, §8) | §6.3 |
| AI3-8 | Observation point → link mapping | **Resolved**: part of provisioning's attribution keys, held by attribution (§2, §8) | §4.1, §4.4 |
| AI3-9 | 30 s takeover breaches `attribution_lag_max` | **Resolved**: hot-standby takeover about 5 s at p99, 3 s lease (§2) | §4.5, §5.12 |

Revision 2 raised AI3-10 … AI3-12; RFC-000 revision 4.1 resolves all three ("Revision 4.1
errata", RFC-003 rows).

| # | Issue | Resolution in RFC-000 revision 4.1 | Used in |
|---|---|---|---|
| AI3-10 | Exact pairing needs one more field each way | **Resolved**: the ledger movement feed carries, per movement, the charge-line batch it posted and whether whole; the unposted-usage feed names the in-flight batch and its usage reduction (§8) | §5.8, §5.9, §7 |
| AI3-11 | Slot batch transactions | **Resolved**: the owner runtime commits per slot, one transaction in flight per slot, per-partition guarantees unchanged (§3, §5.2, §5.5, §8, R19) | §1.1, §1.2, §3.6, §4.5, §5.11 |
| AI3-12 | Erasable rejected payloads | **Resolved**, with RQ3-14: payloads of non-conforming data sets go to the personal-data store, the raw record log keeps identity, digest and reason (A11, §2, §8 naming metering ingestion as a user of the store) | §1.1, §3.3, §7 |

Revision 3 raised AI3-13, and review 19 raised AI-19-1 and AI-19-2; RFC-000 revision 4.2
resolves all three ("Revision 4.2 errata").

| # | Issue | Resolution in RFC-000 revision 4.2 | Used in |
|---|---|---|---|
| AI3-13 | The personal-data store had no expiry | **Resolved** (with AI-R5-3): put / get / erase / expire kept apart; expiry fixed at put, unrecoverable in every copy by destroying an expiry key held only in the HSMs (§8, personal-data store); RFC-005 implements it as a day expiry key over (exporter, hour) bucket keys | §3.3, §7 |
| AI-19-1 | Charge-line batches and settlement's movements disagreed | **Resolved**: reservation batches and usage batches; usage batches at most the movement limit, posted whole; "whole" and the reduction over usage batches only (§6, §8) | §5.8, §5.9, §7 |
| AI-19-2 | No route for a moved reservation's split | **Resolved**: moves carry the path's catalogue route ID and shown price; every offered path is a catalogue route with split weights (§8) | §5.2, §5.5, §6.1, §7 |

Revision 4 raised AI3-14; RFC-000 revision 4.3 resolves it ("Revision 4.3 errata", AI3-14
row, with AI-R5-5).

| # | Issue | Resolution in RFC-000 revision 4.3 | Used in |
|---|---|---|---|
| AI3-14 | RFC-000 §8 named `put_payload` only for data sets rejected "no template", without the exporter argument | **Resolved**: `put_payload(record_id, exporter, supplier, account?, received_at, payload) → kept(bucket) \| not kept(cap)` for non-conforming data (rejected "no template" or "unparseable"), into a payload bucket per exporter and hour; on `not kept(cap)` the log keeps identity, digest and reason only (§2, §3, §8) | §1.1, §3.3, §7 |

Raised in this revision for RFC-000's owner, and decided during it.

| # | Issue | Resolution | Used in |
|---|---|---|---|
| AI3-15 | **`put_payload` had no deadline**: P3-S75 requires a payload the store does not take in time to be kept nowhere, but the store could commit after ingestion stopped waiting | **Decided by the coordinator (binding)** and specified in RFC-005 revision 5 C12: `keep_by` with `not kept(late)` (no commit after `keep_by` − ε), plus `withdraw_payload(record_id)` for every put unanswered by `keep_by` + ε, which deletes any committed item and blocks a later put; RFC-000 §8's erratum is pending under RFC-005's AI-R5-6. Adopted here; the `late-kept` interim is withdrawn | §3.3 (steps 2, 3, 5), §3.4 (`withdrawn`), §7, §8, R3-21 |

Revision 6 takes the RFC-003 items that RFC-000 revision 4.5 routes here ("Items that are
not RFC-000's"); each was settled in C11 and is applied as C11 states it.

| # | Issue | Resolution | Applied in |
|---|---|---|---|
| AI-41-1 | Identity and decoding from the item's context and message only | **Resolved** by C11 (F41-01) | §3.1, §3.2 |
| AI-41-2 | NetFlow v9 packet-level identity and the rejected-record exception set | **Resolved** by C11 (F41-02, D41-3) | §3.2, §3.5 |
| AI-41-3 | Egress uniqueness per (account, product, route, reservation, direction), checked in stage B | **Resolved** by C11 (F41-12, D57-4) | §4.1, §4.3 |
| AI-57-1 | Bind only at a covered position; heartbeats with a lead; facts published `binding_lead` ahead | **Resolved** by C11 (F57-01, F57-10, D57-1) | §4.1, §4.2, R3-4 |
| AI-57-2 | Epoch rule and epoch sizing with drift | **Resolved** by C11 (F57-02) | §3.2, §3.5, R3-23 |
| AI-57-3 | One pending head batch per partition waiting for a digest key | **Resolved** by C11 (F57-11) | §3.3 |
| AI-57-4 | Stable reject key; corrections deduplicated by it | **Resolved** by C11 (F57-03) | §3.3, §3.4 |

## Contract issues

Defects found in the frozen contracts while this RFC was made to agree with them. The
contracts are not edited here; each issue gives a proposed amendment and the reading this
RFC adopts meanwhile.

| # | Issue | Proposed amendment | Reading adopted meanwhile |
|---|---|---|---|
| CI3-1 | **C06 `lateCut` names an `extensionChunk`, but C03 (rule 5, R39-03 (c)), C04 (V61-6) and RFC-000 revision 4.5 key a late POL-07 cut by (link, reduction) and the **target revision**.** A late cut from a Final offer's target (C04 N-03) has no extension chunk at all | C06 1.1: `lateCut: { link, reduction, targetRevision, extension? }` (an additive change; `lateCut` is not part of the compared `SourceRef`) | Rating fills `extensionChunk` with the extension number of the `REDUCTION_EFFECTIVE` set that listed the reservation (0 when it is the first set, or for a cut from any other path), and puts `targetRevision` in `reasonDetails`. The amendment's key is its `SourceRef`, so posting is unchanged |
| CI3-2 | **C06's quarantine report cannot carry C11's reason "domain not of exporter", or an entry with no link.** `QuarantineEntryReport.reason` lists only `no_binding`, `ambiguous_binding` and `identity_conflict`, and `link` and `supplier` are required; C11 S-1 quarantines "domain not of exporter" and reports an entry with no link to the exporter's owner (P3-S77) | C06 1.1: add `domain_not_of_exporter` to the reason; make `link` optional and add `owner: ExporterOwner` | Rating publishes reason `domain_not_of_exporter` (the quarantine reason is not one of C06's closed money enums, so consumers that do not know it show it as text), and for an entry with no link it sets `link` to the empty string and `supplier` to the exporter's owner (Share's own identifier for a Share exporter). The supplier view filters by `supplier`, so the owner sees it |
| CI3-3 | **C12 S1 (V6 d, D5) says rating charges a partner leg marked affected only for the delivered figures, but C04's `PartnerLegAffected` carries no `delivered` figures**, and C06 has no reason for a downward amendment of a partner shortfall. POL-28 (v1.11) asks only that the reservation be **affected** for the missing part | C04 1.x: add `delivered: { rate, window } \| null` to `partner_leg_affected` (additive). If the requirements owner (C12 RQ-2) decides that the buyer is not charged for the shortfall, the account owner records it as a rate change of the reservation's parts, which rating already charges exactly | Rating marks the partner leg affected from the event's `from` minute (affected marks, source `partner_leg`), as POL-28 asks, and charges the part rates the lifecycle feed carries. It does not lower a charge by itself |
| CI3-4 | **C12 S1 (V5) makes Share bear a plain cancellation fee on a shorten to a later end at a partner without amend, but C04's `shortened` event carries only `fee_due` for a minimum-term fee**, so the Share-borne line has no carrier | C04 1.x: `Shortened.fees_due: FeeDue[]` (the buyer's minimum-term fee and a Share-paid plain fee), as `ended` and `moved` carry it | Rating emits a Share-borne fee line from any `FeeDue` with payer `share` that the lifecycle feed carries (§5.4). Until C04 carries it, the plain fee reaches Share's books only through the partner's daily reconciliation (C12), not as a cost line |

## Traceability

Every P3 scenario, and every other scenario with a part allocated to these components,
mapped to the section of this RFC that satisfies it, or to the RFC that does.

| Scenario | Section |
|---|---|
| P3-S01 | §2 (line formula), §5.2 |
| P3-S02 | §5.2 (first active minute) |
| P3-S03 | §5.2 |
| P3-S04 | §5.2 (end at the next boundary) |
| P3-S05 | §5.2 |
| P3-S06 | §5.2 (locked price) |
| P3-S07 | §5.2, §6.2 (`oe_effective`) |
| P3-S08 | §5.2 |
| P3-S09 | §5.2 (release at the end of the grace) |
| P3-S10 | §5.2 (affected marks) |
| P3-S11 | §5.4 |
| P3-S12 | §5.6, §5.8 |
| P3-S13 | §5.8, §5.10 (cold re-rate) |
| P3-S14 | §3.3, §3.5 |
| P3-S15 | §2 (ELA), §5.7 |
| P3-S16 | §3.5, §5.7 |
| P3-S17 | §5.6 |
| P3-S18 | §4.2 (spread) |
| P3-S19 | §4.2 |
| P3-S20 | §5.3, §6.1 |
| P3-S21 | §2 |
| P3-S22 | §5.3 |
| P3-S23 | §5.3 |
| P3-S24 | §5.3, §3 |
| P3-S25 | §5.3, §5.9 |
| P3-S26 | §4.2, §4.4 |
| P3-S27 | §4.4, §5.7 (settlement's split: RFC-004) |
| P3-S28 | §3.3 (C11's rejection reasons and reject keys) |
| P3-S29 | §3.3 |
| P3-S30 | §3.3 (only the producing exporter; correction by reject key; refusals recorded with RFC-005) |
| P3-S31 | §3.3 (never altered; refused attempts recorded with RFC-005) |
| P3-S32 | §5.7 |
| P3-S33 | §5.7 |
| P3-S34 | §6.3, §5.7 |
| P3-S35 | §5.7 (served by reporting, RFC-004) |
| P3-S36 | §5.10 |
| P3-S37 | §5.9 (unposted usage; the 430 s lateness bound by its definition, computed by RFC-004 F3), §8 |
| P3-S38 | §2 (lateness), §5.9 |
| P3-S39 | §3.7 |
| P3-S40 | §5.2 |
| P3-S41 | §5.5 (Share's payment to suppliers: RFC-004) |
| P3-S42 | §5.2 |
| P3-S43 | §5.4 |
| P3-S44 | §5.4 |
| P3-S45 | §5.2 |
| P3-S46 | §5.2 (part-level feed, LIFO check; LIFO itself RFC-002) |
| P3-S47 | §5.2 (what never accrues) |
| P3-S48 | §5.3, §2 (each line split by its route: RFC-004) |
| P3-S49 | §4.1, §4.2, §5.3 (suppliers' split: RFC-004) |
| P3-S50 | §3.2 |
| P3-S51 | §2, §4.2 |
| P3-S52 | §5.3, §4.2 |
| P3-S53 | §5.3 |
| P3-S54 | §5.3 |
| P3-S55 | §6.3, §5.7 |
| P3-S56 | §6.3, §5.2 (rule 4) |
| P3-S57 | §6.3 |
| P3-S58 | §5.2 |
| P3-S59 | §5.2 (path price, route and weights after a move), §5.5 (Share's payment: RFC-004) |
| P3-S60 | §5.4, §5.8 (unsplit posting: RFC-004) |
| P3-S61 | §5.9 |
| P3-S62 | §5.9 |
| P3-S63 | §5.4 (shorten into a minimum term; no plain fee on a shorten) |
| P3-S64 | §5.2 (every part re-priced), §6.2 |
| P3-S65 | §4.4 (reversal), §5.7 (cause Share; Share bears it: RFC-004) |
| P3-S66 | §3.3 (superseding records), §4.2, §5.7 (supplier debt or Share: RFC-004) |
| P3-S67 | §4.1 (egress at the hand-off) |
| P3-S68 | §2 (lateness), §5.6, §5.9 |
| P3-S69 | §6.2 |
| P3-S70 | §2 (`dispute_window`), §6.3 |
| P3-S71 | §3.3 (non-conforming payloads: identity, keyed digest and reason in the log and nothing more; the payload, if kept, put to the personal-data store in an (exporter, hour) bucket; erasure requests covering it; day-key expiry in every copy), §3.4, §3.7; the store's erasure and expiry RFC-005 |
| P3-S72 | §3.1 (measured fields, attribution keys), §3.3 (supersession checks) |
| P3-S73 | §4.2 (the original's disposition per minute: quarantined in its place), §4.4 |
| P3-S74 | §5.4 (a booked window ending inside a minimum term: the fee shown on the offer) |
| P3-S75 | §3.3 (dropped beyond RFC-005's count, byte and size caps, or when not taken by `keep_by` (`not kept(late)`) or unanswered and then withdrawn by `withdraw_payload`: identity, keyed digest and reason kept; drops counted from the log, alerted and reported hourly to network operations), §3.4 (`drop-alert`, `drop-count`), §7; the caps, `keep_by` and the withdrawal tombstone RFC-005 (RD-1, C12 revision 5) |
| P3-S76 | §5.9 (the cap and window in force over the span; RFC-004 F3 computes the bound), §6.1 (cap versions at least 60 s ahead, at a minute boundary) |
| P3-S77 | §3.3 (the domain accounted to the session's exporter), §4.2 (hold, then quarantine "domain not of exporter"), §4.4 (finance attribution within `dispute_window`) |
| P3-S78 | §3.3 (correction deadline from the earlier of the last minute's end and the first receipt; refusal recorded) |
| X2-S02 | §3.6 (ingestion may lag, loses nothing) |
| X2-S04 | §1.2, §3.6, §4.5, §5.11; the load test is RFC-006's |
| X2-S09, X2-S12, X2-S14 (accepted usage records) | §3.1, §3.5, §3.6; topology RFC-006 |
| X2-S10 (usage ingestion; rating and posting rows) | §3.6, §5.12; other rows RFC-001, RFC-002, RFC-004, RFC-006 |
| X2-S11 (accepted usage records) | §3.7; retention RFC-006 |
| X2-S13 | §5.6, §5.12 (posting: RFC-004) |
| X2-S19 | §5.12 |
| X2-S20 (probe exporter records, probe supplier's links; probe bookings not rated) | §4.2 (probe class), §5.2, §6.1; probe operation RFC-006 |
| X2-S22 | §5.9, §5.12; the monthly, per-region measure RFC-006 |
| X2-S23 (records and charges during a declared disaster) | §5.12; RFC-006 |
| X1-S12 (finance: price corrections, quarantine attribution and its reversal, `usage_rate_cap`) | RFC-005; validation in §4.4, §6.1 and §6.3. Its compliance erasure row is RFC-005's; payload buckets it reaches, §3.3 |
| X1-S13 (refusals of another role's action) | RFC-005; role checks in §3.3, §4.4, §6.1, §6.3. Its "support erases" row is RFC-005's |
| X1-S31 (commercial: prices, split weights with four eyes; partner terms) | RFC-005 (approvals); validation and precondition re-checks in §6.1, §6.2 |
| P4-S15, P4-S16 (headroom itemised; lateness bound 0.053750 USD, exposure 0.055750) | RFC-004 Part A, from §5.9's unposted usage and its lateness-bound definition |
| P4-S110 (dearer-path difference) | §5.5 (amount); split and payment RFC-004 |
| P4-S115 (difference unchanged by a correction of the buyer's price) | §5.5 (against the charge as booked); RFC-004 |
| P4-S116 (a cost Share paid is final, except a supplier's own reduction) | §5.5 (cost-line amendments with cause); posting RFC-004 |
| Every other X2, X1, P1, P2 and P4 scenario | Not allocated to these components (RFC-001, RFC-002, RFC-004, RFC-005, RFC-006) |

## Revision 2 resolution

What changed from revision 1, and why.

| Change | Driver | Where |
|---|---|---|
| Rebased on the substrate: insert-only log tables, slot owner leases with epoch-conditional writes, commit timestamps, resolved timestamps, Kafka through the transactional outbox; the ingestion log as its own outbox; stage B to rating in process; slot batch transactions; sizing per component | RFC-000 revision 4 (RK10) | §1.1, §1.2, §3.4 … §3.7, §4.2 … §4.5, §5.1, §5.6, §5.8, §5.11, §5.12, §6.4 |
| Range-set chunks committed with the batch; ingestion voters as RFC-000 decides (revision 1's proposal adopted there) | RFC-000 §4.1, §5.1 | §3.5, §3.6 |
| Sealing moved to RFC-006's history service; this RFC fixes the segment layout | RFC-000 §5.5 | §3.7 |
| Reservation closure on the resolved timestamp; no longer stops during an account owner's failover | RFC-000 AI3-2 | §5.6, R3-5 |
| Usage closure moved by `flow_active_timeout` for lateness from the last minute | v1.6 RQ3-9 | §5.6, §5.12 |
| Exact pairing of unposted usage with the balance: in-flight batch and its reduction, one batch in flight | v1.6 RQ3-12; RFC-000 AI3-3 | §5.8, §5.9; AI3-10 |
| Contracts aligned with RFC-000 §8: metering hand-off, posting acknowledgement per line, usage-applied acknowledgement, cost lines with payer and weights version, residue events, quarantine and breach feeds, evidence query, observation point → link mapping, `usage_rate_cap` in the catalogue | RFC-000 revision 4 | §7 |
| Roles: commercial sets prices and weights with four eyes and partner terms; finance sets `usage_rate_cap`, corrections, attributions and reversals; preconditions re-checked at approval; `announced_at` is the approved version's commit | v1.6 RQ3-1, RQ5-4 | §6.1, §6.2 |
| Only the producing exporter corrects; superseding records for accepted ones | v1.6 RQ3-2, RQ3-11 | §3.1, §3.3, §4.2, §5.7 |
| Reversal of a mistaken attribution at Share's cost; "first attribution wins" removed | v1.6 RQ3-3 | §4.4, §5.7 |
| Shorten into a minimum term; every part re-priced; `dispute_window` from the end of the minute, checked against commit timestamps; hand-off egress; dearer-path rounding; notice for every `usage_price` | v1.6 RQ3-4 … RQ3-8, RQ3-10 | §2, §4.1, §5.2, §5.4, §5.5, §6.2, §6.3 |
| Non-egress parts no longer sent to stage B (evidence is the raw log) | Sizing | §4.2 |
| Closed lines' ELAs read back from the log after an hour instead of kept in memory for 37 days (revision 1 understated that memory by orders of magnitude) | Sizing | §5.1, §5.11 |
| Flow records carry no personal data (the Share metering template) | v1.6 RQ5-8, RFC-000 A11 | §1.1, §3.1; RQ3-14, AI3-12 |
| Probe supplier and several probe accounts | v1.6 RQ-C | §4.2, §6.1 |
| Requirements issues RQ3-1 … RQ3-12 and architecture issues AI3-1 … AI3-9 marked resolved; RQ3-13 … RQ3-15 and AI3-10 … AI3-12 raised | — | Requirements issues, Architecture issues |

## Revision 3 resolution

What changed from revision 2, and why. Driven by `requirements-v1.7`
([review 12](../reviews/12-requirements-amendments-from-rfc-revision-2.md)) and RFC-000
revision 4.1 (its "Revision 4.1 errata").

| Finding or issue | Change | Where |
|---|---|---|
| RQ3-13 (decided, v1.7: POL-14, P3-N10; P3-S37, P4-S15, P4-S16 recomputed) | Lateness bound window adds `flow_active_timeout` and 60 s of minute granularity: 370 s, 46,250 micro-USD in P3-S37, usage exposure 48,250; window derivation stated; parameter row; test | §5.9, §8, §9, Benefits, R3-17 |
| RQ3-14 (decided, v1.7: POL-19, P3-N7; new P3-S71); AI3-12 (resolved, RFC-000 4.1 A11, §2, §8) | Non-conforming payloads (`no template`, and `unparseable` by this RFC's reading) leave the log: identity, keyed digest and reason only; payload put to the personal-data store in (exporter, hour) buckets before the batch commits; unrecoverable on an erasure of its bucket or at the bucket's expiry; crash points; store unavailability confined to such batches; `pd_put_credit` | §1.1, §1.2, §3.1, §3.3, §3.4, §3.7, §7, §8, §9, Competition, R3-15, R3-16 |
| RQ3-15 (decided, v1.7: POL-23, P3-N7; new P3-S72, P3-S73) | Supersession limited to measured fields, within the original's minutes, checked against the original; refusals recorded; versions take the original's disposition per minute instead of a fresh binding; a quarantined original's version quarantined in its place; template gains an optional packet count and names its measured fields and attribution keys | §3.1, §3.3, §3.4, §4.2, §4.4, §7, §9, Competition |
| AI3-10, AI3-11 (resolved, RFC-000 4.1 §8, §3, §5.5) | References changed from "raised" to "resolved"; no design change | §1.1, §5.9, §7, Architecture issues |
| X2-N1 amended (v1.7: a probe account per account slot) | Probe accounts' number noted as irrelevant to rating (designated, never charged) | §7 |
| POL-19 `erasure_max`, POL-32 compliance erasure (v1.7) | Erasure of payload buckets by a compliance operator; `erasure_max` parameter | §3.3, §8 |
| POL-05, POL-06, POL-07, POL-15, POL-21, POL-24, POL-30 amendments (v1.7) | Checked; no effect on metering, attribution or rating (link order, probe-evidence disasters, capacity rises, top-up repayment order, write-off clock, reconciliation netting and notice withholding are other slices'; termination's end cause on the lifecycle feed is unchanged) | — |
| New | RQ3-16 (erasure requester for a non-user's data in flow exports); AI3-13 (personal-data store expiry) | Requirements issues, Architecture issues |

## Revision 4 resolution

What changed from revision 3, and why. Driven by [review 19](../reviews/19-rfc-003-review.md)
(decisions D-19-1, D-19-3 … D-19-8 binding; D-19-2 superseded), `requirements-v1.8`
([review 22](../reviews/22-requirements-amendments-from-c3-reviews.md)), RFC-000 revision
4.2 ("Revision 4.2 errata", RFC-003 row) and RFC-005 revision 4's `put_payload`.

| Finding or issue | Change | Where |
|---|---|---|
| F3-01, D-19-4; RQ-19-4 (v1.8 POL-23; P4-S116) | Cost-line amendments: upward paid as the increment; downward from a supplier's own exporter is that supplier's own reduction as debt; any other downward posts nothing; `E` restates to `C`; source reference with amendment sequence | §5.5, §5.7, §5.8, §7, §9, R3-20 |
| F3-02, D-19-3; RQ-19-3 (v1.8 POL-23, POL-07; P4-S115) | Dearer-path difference against the buyer's charge as booked (rules 1 to 3, no correction); a correction of the buyer's price amends only the buyer's line | §5.2, §5.5, §9 |
| F3-03, D-19-5 | Reservation corrections validated against the effective price and applied as `min(corrected, effective)`; the catalogue's read model carries moves and open-endedness, with rating's pricing module | §5.2, §6.3, §9 |
| F3-04, F3-12, F3-19; AI-19-1 (resolved, RFC-000 4.2) | Two batch streams: reservation batches (one minute, ≤ movement limit, not gated, up to 8 in flight, per-reservation minute order) and usage batches (≤ movement limit, gated when holding a usage line, one in flight, posted whole); `Δ_b` over usage batches; R6 arithmetic; timeliness aligned with RFC-004 | §1.1, §1.2, §5.8, §5.9, §5.11, §5.12, §7, §8, §9, Benefits, Competition, R3-9 |
| F3-05, D-19-1; RQ-19-1 (v1.8 POL-08, P3-N12; P3-S63 third row) | A plain cancellation fee only on a cancellation; a shorten to a later end charges only a minimum-term fee it falls inside; fee kinds on the lifecycle feed | §5.4, §7, §9 |
| F3-06; RQ-19-2 (v1.8 POL-08, P3-N12; new P3-S74), D-19-2 superseded | A booked window ending inside a minimum term: fee line charged to the account when the offer showed it; not shown, Share-borne and alerted; extension avoids it, never twice | §5.4, §7, §9, Traceability |
| F3-07, AI-19-2 (resolved, RFC-000 4.2) | Moves carry the path's catalogue route ID; lines and the difference labelled with it and its weights version; offered paths registered as catalogue routes with weights | §5.2, §5.5, §6.1, §7 |
| F3-08, D-19-6; RQ-19-5 and Q-1 (v1.8 POL-14, P3-N10; P3-S37, P4-S15, P4-S16) | Lateness bound computed once by RFC-004; rating stops publishing it; definition stated: 430 s with admission's recovery time, price span `[now − 370 s, now + 60 s]`; P3-S37 53,750 / 55,750 | §2, §5.9, §7, §8, §9, R3-17 |
| F3-09 | `U` published for every product with a line not fully posted, as well as the attachment set | §5.9, §7, §9 |
| F3-10, D-19-7 | Finance-attributed parts excluded from attribution-lag breaches and the X2-S22 measure; breaches still reported when the recovery time covers them (review 22, decision 4) | §5.9, §9 |
| F3-11; RFC-000 4.2 A-3, AI-17-3 | Effective minutes are the lifecycle feed's (causes known in advance recorded before their minute; late ones at the next boundary, minutes stand); accrual ends at the end entry's minute | §5.2 |
| F3-13 | Cold re-rate takes sequences and modes from the ledger, emits originals where nothing is posted and one amendment per trigger | §5.10 |
| F3-14 | An excluded line re-bases `E` and its sequence on the ledger's posted total; the next amendment restates to `C` | §5.7 |
| F3-15, D-19-8 | After a move, "its price" follows the original lock and notified changes; the path price is fixed; lifecycle price-change events authoritative, checked against the catalogue | §5.2, §7 |
| F3-16 | Ingestion sized at `1 / commit time` per slot: about 4,300 transactions/s of about 140 records; hot exporter 50 KB compressed; total about 24,000/s | §1.1, §1.2, §3.6, R3-12 |
| F3-17 | ELA size marked est. (about 450 B at 50 denominators), memory recomputed (about 110 MB per slot), measured in a test | §2, §5.11, §9, R3-19 |
| F3-18 | Interval arithmetic dropped; exact `bigint` floors on close, change and publication | §2, §9, Benefits, Competition, R3-11 |
| F3-20; RFC-005 rev 4 `put_payload` | `record_id` binds the keyed digest; the entry records the bucket the store names | §3.3, §3.4 |
| AI3-13 (resolved, RFC-000 4.2); RFC-005 C12 revision 4; v1.8 POL-19, P3-N7, P3-S71 (RQ-R5-2) | Non-conforming payloads put with `put_payload(record_id, exporter, supplier, account?, received_at, payload)` into (exporter, hour) buckets under a day expiry key reaching every copy; RD-1 caps replace `pd_put_credit`; `pd_put_timeout` keeps ingestion independent of the store; erasure by any request that covers the payload; reads by console read grant | §1, §1.1, §1.2, §3.3, §3.4, §3.6, §7, §8, §9, Competition, R3-15, R3-16 |
| AI-17-3 (RFC-000 4.2) | Reservation closure per reservation: least of lifecycle closure, its links' schedule-feed closed times and open reductions' `T_eff`; held until the link's final step | §5.1, §5.6, §7, §9, R3-18 |
| `exposure_publish_interval` (RFC-004 §A11, R4-A3) | 2 s (was 500 ms); latency budget about 2.5 s steady, 7.5 s with a takeover | §5.9, §5.11, §5.12, §7, §8 |
| RQ3-16 (resolved, v1.8 POL-19, X1-N7, X1-N11; X1-S42) | Erasure coverage of payloads as POL-19 states it | §3.3, Requirements issues |
| X2-N1, POL-06 (v1.8: probes per account slot) | Probe accounts about 16,384; no effect on rating beyond designation | §7 |
| POL-07 (capacity in force), POL-16, POL-26, POL-32 (v1.8) | Checked: outage levels are the link's (affected marks unchanged); resume amount, the commit fence and new principals do not touch metering, attribution or rating | — |
| New | RQ3-17 (whether a non-conforming payload must be kept); AI3-14 (`put_payload` scope and arguments in RFC-000 §8) | Requirements issues, Architecture issues |
| Reconcile with RFC-002 revision 4 (B-AI-11, RB-19, §13.1) | Every price version published at least 1 min before it takes effect, refused otherwise; the account owner's 60 s catalogue freshness gate noted. Lifecycle events named as RFC-002 §13.1 lists them (cut with target or none, moved with route ID, price step, shortened and ended with fee due and payer); rating charges the feed's fee decision and checks it against §5.4 | §5.2, §5.4, §5.6, §6.2, §7 |
| Reconcile with RFC-004 revision 4 (§B10, posting port) | Usage batches within 5,000 lines; settlement refuses a larger one whole, which rating treats as a defect, re-composing within the limit; cost lines with amendment sequence and cause and moved reservations' path route as already specified | §5.8 |
| V-1 (review 24) | Cost-line rise aligned with RFC-004's M23 (each party paid only up to its share of the new total less what it holds); stale interface sentence dropped; R3-20 restated (none: M23 never re-pays); cost-line test updated | §5.5, §5.8, §9, R3-20 |
| V-2 (review 24) | The kept answer naming the bucket marked as an interface point for RFC-005 C12 (completes F3-20) | §3.3 |
| V-3 (review 24) | R3-13 design point 258 s | Risks |
| RFC-001 revision 4 (§11.1 schedule feed) | Closure uses per-link `CLOSED(t, feed_seq)`, and the two holds per open reduction: every reservation on the link held at `T_eff` until every `REDUCTION_EFFECTIVE` chunk is held; the affected set held until `REDUCTION_FINAL` and its cut is applied; `CUT_DECIDED` as a check | §5.6 |

## Revision 5 resolution

What changed from revision 4, and why. Revision 4 was accepted at C3 (fix verification
24); this revision reopens it as a draft because `requirements-v1.9` adds P3-S75, which
revision 4 did not satisfy, and RFC-000 revision 4.3 and RFC-006 revision 4 change
contracts this RFC uses. Driven by `requirements-v1.9`
([review 28](../reviews/28-requirements-amendments-from-c3-round-2.md); impact P3-N7,
P3-S71, P3-S75, X2-N1, POL-06, POL-07, POL-19, POL-32), RFC-000 revision 4.3 ("Revision 4.3
errata", RFC-003 interface row) and RFC-006 revision 4.

| Finding or issue | Change | Where |
|---|---|---|
| RQ3-17 (resolved, v1.9, review 28; POL-19, P3-N7; P3-S71 reworded) | Restriction reading confirmed: identity, keyed digest and reason always, nothing more; payload kept only if within caps and taken in time; RQ3-17 marked resolved | §1.1, §3.3, §7, Requirements issues |
| P3-S75 (new, v1.9) | Drops (cap; not taken within `pd_put_timeout`) recorded per payload in the `batch` entry; counted from the log; an immediate `drop-alert` per (exporter, hour, reason) and an hourly `drop-count` report to network operations, derived by the relay from `ingest_log`, exactly once per (exporter, hour) across takeovers; crash points; parameters; test | §1.2, §3.3, §3.4, §7, §8, §9, Traceability |
| AI3-14 (resolved, RFC-000 4.3, with AI-R5-5) | `put_payload … → kept(bucket) \| not kept(cap)` for `no template` and `unparseable`, cited as RFC-000 §8 states it; AI3-14 marked resolved | §1.1, §3.3, §7, Architecture issues |
| RFC-000 4.3 AI-27-3 (per-destination closure) | Every closure (reservation, link, catalogue, stage A watermark) relies only on the destination partition's resolved marker, the minimum over every changefeed partition that can feed it, emitted after every such row is published; rating never combines raw changefeed timestamps | §1.1, §4.2, §5.6, §6.4, §7 |
| RFC-000 4.3 AI-26-2 (cut targets as minute pieces) | Cut events carry (link, reduction), the applied target as minute pieces or `none`, and the resulting part rates; rating accrues the part rates, checks them against the `min` of the targets per minute, alerts on a mismatch; `hold_2` waits for the applied minute-piece target | §5.1, §5.2, §5.6, §7 |
| RFC-000 4.3 AI4-12 (split reservation batches) | Already designed (several reservation batches per account minute above `L`, disjoint reservations); now cited, each batch one movement | §5.8, §7 |
| RFC-000 4.3 B-AI-11 (price lead time) | Confirmed: every price version published at least 1 min before its effective minute, refused otherwise, with per-destination resolved markers on the catalogue feed | §6.2, §6.4 |
| RFC-006 rev 4 §3.5 (self-outboxed log) | `ingest_log` declared self-outboxed with three named streams (hand-off, drop alert, drop report); 25 h GC; truncation outside the consumer window; delete events dropped; sealing by follower reads, not the changefeed | §1.1, §3.4, §3.6, §3.7, §7 |
| RFC-006 rev 4 §7.1 (slot groups) | Stage B *i* and rating *i* are a slot group, acquired, handed off and taken over together; one standby process per role; in-process hand-off resumes from `attr_b_log` after a takeover | §1.1, §4.3, §5.12, §7 |
| X2-N1, POL-06 (v1.9 `slot_probe_limit`) | Checked: the slot rule covers admission and the wallet; ingestion's probe limit stays 1 s | Requirements issues |
| POL-07 (v1.9: maintenance outside the committed rate and trimmed at `T_eff`; the cut rate counted after a notice's end), POL-32 (v1.9 recovery hold) | Checked: the link's and RFC-005's; no effect on metering, attribution or rating beyond affected marks and cut events | §5.2, §7, Requirements issues |
| AI3-15 (raised and decided in this revision); RFC-005 revision 5 C12 | `put_payload` with `keep_by` and `not kept(late)`; `withdraw_payload` for every put unanswered by `keep_by` + ε, recorded in a `withdrawn` entry, rebuilt and resent after a takeover; the `late-kept` interim withdrawn; byte caps (256 KB/s per exporter, 4 MB/s overall) and the 64 KB per-payload cap (over it: dropped, cap, counted); digest keys per (exporter, version) via `digest_key`, the version recorded with the digest; R3-21 restated as a pending withdrawal | §1.2, §3.3, §3.4, §7, §8, §9, R3-21, Architecture issues |
| W-1 (review 29; coordinator's binding choice of the first option) | Digest key mandatory: versions fetched for every exporter of the slot at lease acquisition, the cached version used through a rotation; with no cached version and a failed fetch, the batch is neither committed nor acknowledged (the exporter retransmits), alerted, only that exporter partition waiting. Replaces the earlier "rejected with digest unavailable" path; crash row and R3-22 added | §3.3 (step 1, crash table), Risks |
| W-2 (review 29) | Header "Builds on" cites RFC-005 revision 5 C12 (`keep_by`, `not kept(cap \| late)`, `withdraw_payload`, `digest_key`) and the pending RFC-000 §8 erratum | Header |
| W-3 (review 29) | Crash row "after the commit, before the acknowledgement": the repeated put is answered as the store now holds it (kept with the first bucket; `not kept(late)` once withdrawn) and recorded with that outcome | §3.3 |
| Erratum 5.1: review 32 V-5 (joint with RFC-001) | The claim that a late extension chunk's reservations cannot have closed past `T_eff` is withdrawn: minutes already closed at the uncut rate are amended (reason "late POL-07 cut", downward, no fault cause) once the extension's cuts are applied in the lifecycle; minutes still open are held by `hold_2` | §5.6, §5.7 |
| Erratum 5.1: review 32 V-3 (RFC-001 change, being applied) | Noted: reservations whose only cut parts are offer parts are outside `A_R` for the holds, so `hold_2` never waits on an offer-scoped target (`KEPT_FOR_OFFER`, no lifecycle cut); their rate changes only by a move | §5.6 |

## Revision 6 resolution

What changed from revision 5 with erratum 5.1, and why. Driven by `requirements-v1.11`
([review 65](../reviews/65-requirements-amendments-after-c4.md); impact P3-N3, P3-N7,
P3-N10, P3-S28, P3-S76, P3-S77, P3-S78, X1-N7, X1-N11, X1-S12, X2-N1), RFC-000 revision 4.5
("Revision 4.5 errata", RFC-003 row of "Interface points the detailed RFCs must match"), and
the errata, consumer obligations and settled items that name RFC-003 in the frozen
contracts C01 … C12.

| Finding or issue | Change | Where |
|---|---|---|
| P3-S76; RQ-44-1 (v1.11 POL-14, P3-N10); C06 D3, M7, m6, m7 | Lateness bound with the highest cap and the longest window over the span; cap versions effective at a minute boundary at least 60 s after their record; worked rows; test | §5.9, §6.1, §8, §9, Traceability |
| P3-S77; RQ41-1 (v1.11 P3-S28); C11 S-1 | `no exporter` only without a domain; domains registered by the exporter's own observation-point facts; every unbound part held, then quarantined "domain not of exporter" or "no binding"; entries with no link reported to the exporter's owner; P3-S28's reasons per C11 | §3.3, §4.1, §4.2, §4.4, §9, Traceability |
| P3-S78; RQ41-2 (v1.11 POL-23, P3-N7); C11 D41-1, D57-3, F57-05, V62-03 | Correction deadline from the earlier of the last minute's end and the first receipt; receipt bound; ordered checks with idempotency first | §3.3, §8, §9, Traceability |
| RQ41-3 (v1.11 P3-N3); AI-41-1, AI-41-2 | Identity from (exporter, context, message) only; NetFlow v9 packet identity and exception set | §3.2, §3.5 |
| AI-57-1 … AI-57-4; C11 review 57 errata | Covered binding positions and `binding_lead`; partition heartbeats; epoch rule and sizing with drift; context logging and the 24 h memo; one pending head batch; stable reject keys; corrected-key index; export format fixed per exporter; options-template rule; principal context from the edge | §3.1 … §3.6, §4.1, §4.2, §8, R3-4, R3-23 |
| AI-41-3; C11 F41-11 … F41-13, F57-12, F57-14, D41-6, D57-4 | Tenancy invariants T1 … T4; T4 hold in stage B; attachment set per binding by valid time; forwarding to old and new account; parts with no link still attributed | §4.1, §4.3, §5.3, §5.9, R3-24 |
| C11 S-2, F41-10 | Identity conflicts on the hand-off with a conflict identity; disposition lookups by kind record or correction | §3.4, §3.5, §4.2 |
| C01 §10.3 (M5, M7, M11, C4-7, CC-5, R47-19) | Dedup by (partition, stream, `stream_seq`); closure from the emitter's markers by `onResolved`, declared on the streams this RFC produces; `Moving`, `Stopped`, `onMovedOut`, `onAdopt`; `CommandEnvelope` and `admitCommand`; `ingest_stream_index` and the relay's log key; probe accounts from the slot map | §1, §1.1, §4.2, §5.1, §5.2, §6.1, §7 |
| C03 M2, rule 5 (R39-03 (c)), R39-20, CT-3.x; C02 review 54 m7 | `hold_2` released on the highest applied revision; any late lifecycle cut amends closed minutes ("late POL-07 cut", keyed by (link, reduction) and revision), replacing erratum 5.1's extension-only rule; liveness alarm; gaps | §5.6, §5.7, §8 |
| C04 v2.3.1 consumer obligations (MM-1 … MM-5, MM-12, M-03, N-03, N-07, m-03, m-05, m-06, CC-1) | Three early-effective events; release at `nb(ts)` of F7; added parts from `part.window.start`; least `effective` of two ends; `fee_id` format; `moved.fees_due` as Share-borne lines; Final-offer targets as cuts; ignored kinds, `rating_ignorable`, stop on conflict; `account_is_probe` checked against the slot map | §5.1, §5.2, §5.4, §5.6 |
| C05 S-4; C06-M1 | `UsageApplied` deduplicated by (account, `appliedThrough`); recovery by replay, then `usage_applied_since`; no read of the owner's outbox | §5.1, §5.9, §7 |
| C06 consumer obligations (§7, §5.7, §5.8, §5.9, §5.10, §6.1, §6.2; C06-M2 … M14, D1 … D7, V63-1 … V63-6) | `newTotal`, `priorTotal`, `lineCount`, `payee`, `SourceRef` forms and canonical encoding, reason `original` with `triggerRef`, `EventId`; affected marks on their own topic; usage batches whole or refused and re-emitted; one sequence per line key; re-base on the ledger's totals; parking and `resolve_parked`; downward `re_rate` with cause Share; cold re-rate by `triggerRef`; split weights, cap and `policy_parameters` rules; one price version per key; no probe accounts and no `link_rules` in the catalogue; `oeEffective` and F11 | §5.7, §5.8, §5.9, §5.10, §6.1, §6.2, §6.4, §7, §9 |
| C08 consumer table (R46-09) | Target summaries with the audit record before the answer; envelopes verified; `operator_check` at apply; recorded outcome first for a repeated `action_id` | §4.4, §6.1, §7 |
| C09 v1.1 consumer obligations (S-M4, S-G3, R36-05, R36-09, R36-12, R36-14, R36-28, R36-29) | Four `put_payload` outcomes with `not_kept(erased)`; non-answers withdrawn; unknown reasons as cap; `withdraw_payload(record_id, received_at)`; later log entry authoritative; clock precondition; `digest_key` version 1 and `not_found` as configuration error; evidence check with the recorded key version; `RecordId` mapping; counts reconciled from the log | §3.3, §7, §8 |
| C12 S1 (V6 d, V5) | `decreaseAllowed` agrees with the driver; partner-leg affected marks; Share's plain fee on a shorten without amend; CI3-3 and CI3-4 raised for the missing carriers | §5.2, §5.4, §6.1, Contract issues |
| POL-07, POL-23 (v1.11: a move after a cut carries the cut rate; late cuts amend, every party to its split) | Moves accrue the `moved` part rates; late cut amendments for any path, no cause, M6 or M7 | §5.2, §5.6, §5.7 |
| POL-19, X1-N11 (v1.11; RQ-36-3, RQ-48-1) | A user's or an account's request covers payloads received before it is executed; a payload erased whole | §3.3 |
| POL-28 (v1.11: partly missing at the partner) | Affected for the missing part, by affected marks | §5.2 |
| New | CI3-1 … CI3-4 (contract defects, each with its reading) | Contract issues |

