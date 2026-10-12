# RFC-003. Rating and metering: exporter logs, exact charge lines, amended by total

| | |
|---|---|
| Status | **Draft, revision 2.** Rebased on the requirements at tag `requirements-v1.6` and on RFC-000 revision 4 (distributed SQL substrate, NestJS owners, Kafka). Revision 1 was the rewrite on the accepted architecture (revision 3.2) that replaced the pre-baseline prototype draft of the same number. What changed is listed in "Revision 2 resolution" at the end |
| Satisfies | P3-S01 … P3-S70 (all 70). The metering, attribution and rating parts of X2-S02, X2-S04, X2-S09, X2-S10, X2-S11, X2-S12, X2-S13, X2-S14, X2-S19, X2-S20, X2-S22 and X2-S23 (the rest of each is RFC-006's). The validation parts of X1-S12 (finance: price corrections, quarantine attribution and its reversal, `usage_rate_cap`) and X1-S31 (commercial: prices, split weights, partner terms). Inputs to P4-S15 and P4-S16 (headroom itemised) and P4-S110 (the dearer-path amount); RFC-004 satisfies them. See the traceability table at the end |
| Policies | POL-01, POL-06, POL-07, POL-08, POL-11, POL-12 (weights stored, applied by RFC-004), POL-13, POL-14, POL-15 (fee holds, by reference), POL-16, POL-17, POL-18, POL-19, POL-20, POL-23, POL-27, POL-28, POL-29, POL-30, POL-32, POL-33 |
| Prior decisions | History log D10 (facts first), D18 (raw records, deduplicated by identity), D19 (amend, never edit; bound the exposure), D20 (price by usage time), D25 (amend by the line's new total), D27 (the bound covers the wait before charging). D26 (minute lock) and D28 (end-minute assignment) are **not** carried forward; see Competition |
| Builds on | The requirements at tag `requirements-v1.6`, which decide this RFC's revision 1 issues RQ3-1 … RQ3-12 ([review 11](../reviews/11-requirements-amendments-from-detailed-rfcs.md)), and [RFC-000](RFC-000-architecture.md) revision 4: its components (metering ingestion, attribution and quarantine, rating, catalogue), their ownership and partitioning (§2), principles A1 … A11 (§1), idempotency and ordering (§4.4, §4.5), the topology (§5.1), the substrate mapping (§5.5), the sizing (§6), the allocation (§7) and the contracts (§8), including its resolution of this RFC's AI3-1 … AI3-9 |
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
   delivered at least once, late, out of order, sometimes unreadable, sometimes wrong and
   later corrected by their own exporter, reported by several legs for the same traffic,
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
  LO["Link schedule owners"] -. "link schedule feed" .-> RA
  CAT["Catalogue<br/>by entity"] -. "catalogue feed" .-> RA
  CAT -. .-> AQA
  AO -. "lifecycle feed" .-> CAT
  RA -. "charge-line feed" .-> ST["Settlement (RFC-004)"]
  ST -. "posting acknowledgements" .-> RA
  RA -. "unposted-usage feed" .-> AO
  AO -. "usage-applied acknowledgements" .-> RA
  CON["Operator console and approvals"] --> CAT
  CON --> AQA
  MI -. "log table, changefeed" .-> HI["History (RFC-006): sealed segments"]
```

Dashed arrows are Kafka topics fed by the **transactional outbox** (RFC-000 §5.5): the
event is a row committed in the same database transaction as the fact, published by the
owner after commit and relayed again by a database changefeed as the guaranteed path;
consumers apply per producer partition in sequence order and drop duplicates by
(producer partition, epoch, sequence) (RFC-000 A6, §4.4). Every component below is an
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
| Metering ingestion | By exporter; 128 slots (est.), hot exporters in a slot alone | `ingest_log` (batch, epoch, wrap, correction, supersession, identity-conflict, checkpoint entries); projections: identity range-set chunks, epoch table, wrap anchors, corrected and superseded references | Metering hand-off: the changefeed on `ingest_log` itself, plus the owner's direct publish (the log table is its own outbox, so a batch is written once, not twice) | Warm: tails the projections; takeover about 5 s (est.) |
| Attribution, stage A | By exporter, the same slot map as ingestion | `attr_a_log` (processed, binding fact, quarantine, pending, attribution, reversal entries) | Attributed parts per account (outbox), watermark heartbeats | Hot, 3 s lease (RFC-000 §2) |
| Attribution, stage B | By buyer account; 256 slots (est.) | `attr_b_log` (part batches, producer watermarks, attachment set) | In-process hand-off to rating, after commit; the table is the guaranteed path | Hot, 3 s lease |
| Rating | By buyer account, the **same slot map as stage B**; placement keeps both slots' lease holders in one process | `rating_log` (inputs, accrual-closed, usage-closed, amendment, fee, emitted, posted, breach, checkpoint entries) | Charge-line feed, unposted-usage feed, breach report feed | Hot, 3 s lease |
| Catalogue | By entity | `catalogue_log` per entity kind; projection: current versions | Catalogue feed | Warm |

**Slot batch transactions.** An owner commits, per slot, one batch transaction at a time
carrying the pending entries of every partition of the slot (each partition keeps its own
contiguous sequence and head row, so RFC-000's "one batch transaction in flight per
partition" holds). Committing per partition instead would cost on the order of 10⁵
transactions/s for metering and rating alone (est.); per slot it is about 26,000/s (§1.2).
Architecture issue AI3-11 asks RFC-006 to make this part of the owner runtime.

**Time on the substrate.** An entry's timestamp is its transaction's **commit timestamp**
(the database's hybrid-logical clock), monotone per partition across owner changes
(RFC-000 §4.5). Closure uses **resolved timestamps**: the changefeed on a table emits, in
each Kafka partition, a marker "every row committed at or below T has been emitted" (§5.6).

**Personal data** (A11). No table or topic of this RFC holds personal data: exporters,
accounts, suppliers and operators appear by pseudonymous identifiers; every entry's payload
is encrypted by the owner with keys held in Kenyan HSMs (RFC-005, AI5-3), so R3's replicas
and Kafka hold ciphertext. Flow records must not carry personal data (§3.1); Architecture
issue AI3-12 records the residual case.

#### 1.2 Sizing at the design load

| Item | Estimate | Section |
|---|---|---|
| Records | 260,000/s, 600,000/s peak; about 60 MB/s raw, 20 MB/s compressed at peak | §3.6 |
| Ingestion transactions | ≤ 50 per slot per second × 128 slots ≈ **6,400/s**, about 94 records (3 KB compressed) each at peak | §3.6 |
| Stage A transactions | ≈ **2,600/s** (a processed entry per slot every 50 ms) | §4.5 |
| Stage B transactions | ≈ **8,500/s** (256 slots, one commit at a time each) | §4.5 |
| Rating transactions | ≈ **8,500/s**, carrying about 1,700 accrual closures, 1,700 usage closures, 300,000 applied parts and 100,000 exposure figures a second | §5.11 |
| Database write volume (logical) | About 20 MB/s of records, 12 MB/s of parts, 10 MB/s of rating entries at peak; × 5 replicas for replication | §3.6, §4.5, §5.11 |
| Kafka | Hand-off about 20 MB/s, parts about 12 MB/s, figures about 100,000 small events/s, charge-line batches about 1,700/s | §3.6, §4.5, §5.9 |
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
rationals commutes (P3-N3). The charge `⌊price × X / 10¹⁵⌋` is evaluated by **verified
interval arithmetic**: lower and upper bounds of `price × r_d / d` in 128-bit fixed point
(64 fractional bits), summed; if `⌊lower⌋ = ⌊upper⌋` that is the answer, otherwise (a sum
within 2⁻⁶⁴ × (number of denominators) of an integer, est. never at the design load) the
exact rational is computed with arbitrary-precision integers. The answer is the exact
floor in every case; the fallback only costs time. Comparisons of `X` with an integer
(the burst threshold, §5.3) use the same method. The same accumulator holds a
reservation's minute bytes before they are split into covered and above-rate parts.

**Rounding direction elsewhere.** The lateness bound (§5.9) is an upper bound and is
rounded **up** to the micro; a Share-borne cost line (§5.5) is the difference of two
amounts each rounded down once.

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

| Element | Semantics |
|---|---|
| Session | Mutually authenticated TLS to the ingestion edge of either serving region. The credential names one **exporter ID** and its owner; every message on the session is accounted to it (X1-N1, RFC-005). An unauthenticated session is not accepted and creates nothing |
| Template | Data records use the **Share metering template**: flow start and end times (milliseconds, absolute or relative to system init), an octet count, the observation point (interface), direction, and the attribution key fields of §4.1. It contains no element that can identify a person (no IP addresses, ports or subscriber identifiers; A11). A template message declaring any other element is refused for the session, with the reason, before any data record can use it |
| Export message | One IPFIX message (or NetFlow v9 packet) **verbatim**, header included: observation domain (source ID), 32-bit sequence number of its first data record, export time (seconds), and the exporter's **system init time** (IPFIX information element 160 `systemInitTimeMilliseconds` in an options record, or for NetFlow v9 derived as header `unix_secs × 1000 − sysUpTime`) |
| Batch | Up to 1 MB (est.) of messages with a sender-chosen batch number, used only to correlate the acknowledgement |
| Acknowledgement | Sent per batch only after the transaction holding it has committed (durable in two regions, X2-S14). Lists, per message, how many records were **accepted**, how many were **duplicates** of records already accepted, and each **rejected** record with its reason. All three outcomes are durable; an acknowledged batch never needs resending |
| Retransmission | The exporter keeps every message until acknowledged and resends it **verbatim**, to either region, after `ingest_retry_timeout` (2 s, est.). Verbatim matters: a record's identity (§3.2) is computed from the message it was exported in |
| Flow control | Credit based per session; an exporter that runs out of credit buffers. The edge never drops a batch it has taken credit for |
| Correction message | Carries a corrected record and the **raw reference** of a **rejected** record of the same exporter that it corrects (§3.3) |
| Supersession message | Carries a corrected version of an **accepted** record of the same exporter, the original's identity and a **version number** `v ≥ 1`, increasing per original (§3.3) |

The probe of usage ingestion (X2-S18, X2-S20) sends one record from a designated probe
exporter and succeeds on its acknowledgement within 1 s.

#### 3.2 Record identity (P3 open question 1, decided here)

A record's identity is **(exporter ID, observation domain, epoch, extended sequence)**,
refining RFC-000 §4.4's (exporter, exporter epoch, sequence number).

- **Epoch.** The exporter's system init time is constant for one boot of its counters and
  differs after a restart. Each exporter partition keeps an **epoch table** (log entries,
  with a projection row per epoch): a message whose init time is within `epoch_jitter`
  (2 s, which absorbs NetFlow v9's whole-second `unix_secs`) of a known epoch's init time
  belongs to it; any other opens a new epoch, numbered in order. Two restarts within 2 s
  of each other are impossible for a real exporter (a boot takes longer). A message with
  no usable init time is rejected "no epoch".
- **Extended sequence.** IPFIX and NetFlow sequence numbers are 32-bit and wrap: at
  50,000 records/s an exporter wraps about daily (est.). Within an epoch the partition keeps
  **wrap anchors** `(k, t_k)`: wrap `k` began with a message exported at time `t_k`. A
  message with sequence `q` and export time `t` is placed in wrap `k` = the latest anchor
  with `t_k ≤ t`, except that a sequence in the top quarter of the space (`q ≥ 3 × 2³⁰`)
  exported within `wrap_slack` (10 min) after `t_k` belongs to wrap `k − 1`; a sequence in
  the bottom quarter when the wrap's highest sequence so far is in the top quarter opens
  wrap `k + 1` at `t`. The record's extended sequence is `k × 2³² + q + i` for its
  position `i` in the message. Because the anchor is the *export* time in the message, and
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
| **Rejected**, with reason | `no exporter` (no observation domain or source ID, or one not registered to the session's exporter), `no template` (a data set whose template was not declared or was refused, §3.1), `no sequence number`, `no epoch`, `negative byte count`, `end time before its start time`, `missing flow times`, `flow time in the future` (end later than the owner's clock + `future_skew_max`, 5 min, est.), `unparseable` | The record is kept as received with its reason; its identity, if it has one, is **not** added to the range set; nothing flows on and nothing is charged (P3-S28) |

Validation is per record. A rejected record never delays the records after it: the rest
of its batch is accepted or deduplicated in the same entry, as if it had not arrived
(P3-S29). A record with zero bytes is accepted (it charges nothing).

**Only the producing exporter corrects (P3-S30, P3-N7, POL-23; RQ3-2 as decided).** A
corrected version of a record is accepted only on a session of the exporter that produced
the original, under its own credential: the raw reference or identity it names must be in
the session's own exporter partition. A correction or supersession naming another
exporter's record is **rejected** "not this exporter's record", kept with that reason in
the sender's partition, and recorded as a refused attempt (audit fields of the entry,
RFC-005). There is no operator path: the operator console offers no command that submits,
edits or removes a record's contents, and an attempt through it is refused there and
recorded as a refused privileged attempt (RFC-005, X1-N8).

**Corrected records: a rejected record made usable (P3-S30).** A correction message names
the rejected record's **raw reference** (exporter partition, log sequence, index). The
correction is validated like any record and has its own identity: the original's identity
if it had one, else `(exporter, "correction", raw reference)`. The partition keeps the set
of raw references already corrected; a correction for a reference already corrected, or
whose identity is already accepted, is a duplicate. So a correction submitted any number
of times is charged once. The correction entry records the principal and the raw
reference, so a recomputation sees it among the corrected versions P3-N9 lists.

**Superseding records: an accepted record whose contents were wrong (P3-S66, POL-23; RQ3-11
as decided).** A supersession message names an accepted original of the same exporter and
carries version `v`. It is validated like any record, and then:

| Check | Outcome when it fails |
|---|---|
| The original is accepted in this partition | Rejected "no such accepted record" |
| Acceptance time before the original's last minute end + `dispute_window` (§2), against the commit timestamp | Rejected "outside `dispute_window`": kept, never charged; the original stands (P3-S66 third row) |
| `v` is above every version already accepted for the original | A repeat of an accepted `(original, v)` with the same digest is a **duplicate**; any other is rejected "version out of order" |
| The superseding version keeps the original's observation domain, observation point and direction | Rejected "changes the observation point" (provisional reading, Requirements issue RQ3-15) |

Accepted, a `supersession` entry records the original's identity and raw reference, `v`,
the new contents and the exporter's **owner** as the credential names it. Its identity is
`(original identity, "version", v)`; the original's identity stays in the range set, so a
redelivery of the original is still a duplicate. The original is **never altered**; it
stays in the log and in evidence beside its versions. For charging, the latest accepted
version replaces the one before it: attribution negates the parts it had produced and adds
the new version's parts (§4.2), and rating amends every line that changes (§5.7), a
downward amendment carrying the cause **the exporter's owner** (a named supplier, or Share).
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
| `batch` | Session, edge region, the messages as received (compressed, encrypted payload), and per record its outcome (accepted, duplicate with digest, rejected with reason) | Each batch, in the slot's batch transaction |
| `epoch-opened` | Epoch number, init time, first export time | A message with a new init time |
| `wrap-opened` | Epoch, `k`, `t_k` | §3.2 |
| `correction` | Raw reference corrected, the corrected record, its outcome, the principal | A correction message |
| `supersession` | Original identity and raw reference, `v`, the new contents, its outcome, the principal, the exporter's owner | A supersession message |
| `identity-conflict` | Identity, both digests, positions | §3.5's verifier finds a duplicate whose content differs |
| `checkpoint` | Snapshot reference of the derived state below | Every 10 s of log or 256 MB (est.) |

Projection rows, written in the same transaction as the entries they derive from (RFC-000
§5.5): the epoch table and wrap anchors; the **identity range-set chunks** (§3.5); the
corrected raw references; the latest accepted version per superseded original. The owner
keeps all of them in memory and rebuilds them from the projection rows on taking the
lease. A 24-hour **digest cache** (identity → 64-bit content digest) is soft state on the
owner's local disk.

#### 3.5 Deduplication for 7 years: per-exporter range sets

For each (exporter, observation domain, epoch) the partition keeps a sorted set of
disjoint closed intervals `[lo, hi]` of extended sequence numbers already accepted. A
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
| Epochs over 7 years | about 50 per domain (restarts, est.) → 2 × 10⁶ epoch sets |
| Intervals | about 10 per set on average (rejects with identities, est.), plus up to a few thousand per live set for reordering → about 2 × 10⁷ |
| Memory | 32 B per interval → about 640 MB in all, about 5 MB per ingestion slot (128 slots, est.) |
| Database | About 10⁵ chunk rows, a few GB with five replicas; a batch touches one or two chunks per message |
| Safeguard | A set above 10⁶ intervals (a misbehaving exporter) keeps only its recent chunks in memory and reads older ones from the database; checks then cost one read per message, and an alert is raised |

The range sets are kept for the life of the system, not only 7 years: they are small, and
keeping them means a redelivery after the retention period is still a duplicate.

**Duplicate content check.** A duplicate's digest is compared, asynchronously and off the
acknowledgement path, with the original's: from the digest cache when the original is
younger than 24 h (est. about 4 GB per slot on local disk), otherwise by reading the
original from the live tail or its sealed segment (§3.7). A mismatch means two different
records share an identity, which only a protocol violation can cause; the duplicate is then
re-recorded as an `identity-conflict`, kept in full, routed to quarantine with reason
"identity conflict", and alerted. It is never silently treated as the original (P3-N3,
P3-N7).

#### 3.6 Topology, throughput and recovery

- **Voters.** Every range of `ingest_log` and its projections has the database's five
  voters, 2 + 2 + 1, as RFC-000 §5.1 decides for ingestion (revision 1's proposal is now
  RFC-000's). Sealed segments are kept twice, in object storage (RFC-000 A0-16).
- **Slots.** 128 ingestion slots (est.), exporters assigned by hash, hot exporters placed
  alone. Peak load per slot about 4,700 records/s, about 0.5 MB/s raw (est.). The owner
  flushes a slot's pending batches every 20 ms or at 256 KB, whichever first, into one
  transaction, one in flight per slot: at most about 50 transactions/s per slot, about
  6,400/s in all, each about 94 records (3 KB compressed) at peak. A hot exporter at
  50,000 records/s fills its own slot's transactions with about 1,500 records (150 KB
  compressed); rows are chunked at 256 KB.
- **Acknowledgement latency** (est., p99): edge 5 ms + forward to the owner in the leader
  region up to 10 ms (an R2 edge) + flush wait up to 20 ms + one transaction in flight up
  to 30 ms + commit 30 ms (RFC-000 §3) + response 10 ms = **about 105 ms** steady; about
  200 ms after a region loss (commits at about 75 ms). The probe limit is 1 s.
- **Throughput.** 600,000 records/s is 60 MB/s raw (100 B each, RFC-000 §6), about
  20 MB/s compressed in the database, about 100 MB/s of replication traffic at five copies
  before storage-engine amplification; RFC-006 costs the nodes. The metering hand-off is
  the changefeed on `ingest_log` (accepted records only are applied by stage A), about
  20 MB/s in Kafka at peak.
- **Recovery.** A slot's lease holder fails: a warm standby in the other Kenyan region,
  which tails the slot's projection rows, takes the lease after expiry (3 s) and resumes:
  about **5 s** (est.), within the 1 min RTO (X2-S10). Nothing committed is rebuilt.
  Exporters resend unacknowledged batches after 2 s, to either region; the range sets
  deduplicate them. Ingestion may lag (credit runs out, exporters buffer), but an accepted
  record is never lost (X2-S02, X2-S09, X2-S12). A region loss moves every lease to the
  surviving region with the database's leaseholders (RFC-000 §3).
- **Independence.** Ingestion reads nothing but its own tables and the exporter credential
  cache: no reservation, provisioning, catalogue or rating state (RFC-000 §2).

#### 3.7 Retention and evidence

**Sealing** is RFC-006's history service (RFC-000 §5.5): it reads `ingest_log` through its
changefeed, seals every 15 minutes of an exporter's log (est.) into a columnar segment in
object storage replicated in two regions, verifies it, and only then is the live tail
truncated. This RFC fixes what a segment must contain for the evidence query: records
sorted by (observation point, attribution key, flow start), per-block minimum and maximum
statistics, and a sparse identity index (epoch, sequence range → block); every outcome
kept, rejected records with their reasons, duplicate entries, corrections and superseding
versions beside their originals. Payloads stay encrypted under RFC-005's keys. Storage
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
mapping**, which attribution holds (AI3-8, resolved). Provisioning publishes a **binding
feed**, ordered and positioned, of facts it never deletes (a binding is ended by a new
fact):

| Fact | Contents |
|---|---|
| Observation point | (exporter ID, observation domain, interface index, direction) → link ID (RFC-001's registry), from a time |
| Binding | Key = (observation point, service tag: VLAN or 802.1ad pair, MPLS label or VRF, as configured); valid-time interval `[from, to)`; **account**; **product**; **route** (catalogue route ID); **reservation ID** or none (an account attachment with no reservation, or a best-effort service); **egress**: whether this observation point is where traffic on this binding, in this direction, leaves the route |
| Correction | A binding fact superseded, with the time it was recorded |

Each fact carries its recorded-at time, so the feed is bitemporal, and attribution
records the **binding position** it used for every decision, which makes attribution
reproducible (P3-N9). The contract requires that a binding be published **before** the
network carries traffic on it (Risks, R3-4). Stage A writes every fact it consumes, for
the observation points of its exporters, to `attr_a_log`, so the binding history is kept 7
years.

**Egress (P3-N13, POL-17; RQ3-7 as decided).** For each direction of a route, exactly one
observation point is the egress, normally the last Share-metered point before the traffic
leaves the route. When the route's last leg is a partner link that Share does not meter,
the egress is the **hand-off point to that partner**, the last point Share meters, and its
count is billed (P3-S67: L1 counts 1.1 GB entering and 1.0 GB handed off to the unmetered
partner link P; only the hand-off's 1.0 GB is egress, so the account is charged once for
1.0 GB). Provisioning sets the egress flag; attribution checks that each (route,
direction) has exactly one egress binding and alerts otherwise.

#### 4.2 Stage A: spread, bind, classify

Stage A's lease holder consumes its exporters' metering hand-off from Kafka, in each
exporter partition's sequence order (contiguous, so a gap waits), dropping duplicates.
For each accepted record (and each accepted correction):

1. **Absolute times** `s`, `e` in milliseconds from the record and its message header.
2. **Spread (POL-13, P3-N4).** If `e = s`, one part: all bytes in `floor_min(s)`
   (P3-S18, last row). Otherwise the active interval is `[s, e)`; for each minute `m`
   meeting it, `t_m` = milliseconds of `[s, e) ∩ [m, m + 60 s)`, and the part's bytes are
   the exact fraction `b × t_m / (e − s)`. Minutes are half-open, so a flow ending exactly
   at 12:06:00 has no part in 12:06 (P3-S18 rows 1 to 3; P3-S19; P3-S51). A record whose
   active interval exceeds `flow_active_timeout` + 60 s is still spread, and its exporter
   is alerted for breaking POL-13's export rule.
3. **Bind.** For each part, the binding whose key matches the record's (observation
   point, service tag, direction) and whose valid interval contains `max(s, m)`, in the
   binding state at stage A's current binding position.
4. **Classify** each part:

| Class | When | What happens to it |
|---|---|---|
| **Probe** | The exporter, the observation point's link (a link of the designated probe supplier) or the binding's account is designated probe in the catalogue (POL-06, X2-S20) | Kept as evidence in the raw log only; never sent to rating; never quarantined or reported |
| **Non-egress** | A binding matches, but the observation point is not its egress | Recorded in the `processed` entry's counts only; never sent to stage B and never in any charge (P3-S49). The raw record is the evidence (§3.7) |
| **Reservation binding** | A binding with a reservation ID matches, at its egress | Sent to the account; rating decides covered, burst, excess or outside (§5.3) |
| **Attachment** | A binding without a reservation matches, at its egress, on a guaranteed product | Traffic outside any reservation (POL-17), usage priced (§5.3) |
| **Best-effort** | A binding of a best-effort product matches, at its egress | Usage priced (§5.3) |
| **Unattributable** | No binding matches, or two do (a provisioning error, alerted) | Pending-binding hold, then quarantine (below) |

5. **Route** each attributed part to its account, in one batch per (stage A entry,
   account), carrying per part: record identity, acceptance time, last minute end,
   minute, bytes (an exact fraction, signed), class, account, product, route,
   reservation ID, observation point and link.

Stage A commits a `processed` entry (ingestion sequence reached per exporter, binding
position used, the quarantine and pending changes) and, in the same transaction, the
**outbox rows** of the batches that entry determines, each with feed identity (stage A
partition, epoch, sequence, account) and a **per-destination sequence**: contiguous per
(stage A partition, account), so stage B detects a gap and waits for it even though a
stage A entry sends to only some accounts (RFC-000 §4.4's contiguity, per destination). A
new lease holder resumes from the last `processed` entry; the batches are deterministic in
the records and the binding position, and already committed as outbox rows, so nothing is
sent twice with different contents.

**Superseded records (§3.3).** For a `supersession` of an original (or of an earlier
version), stage A recomputes the parts the replaced version produced, from that version's
contents and the binding position recorded when it was processed, and routes them
**negated**, with reason "superseding record", the record's exporter and its owner; it
then spreads, binds and classifies the new version at the current binding position and
routes its parts with the same reason. A replaced version that was quarantined has its
quarantine entry marked superseded and the new version is attributed or quarantined
afresh; one that a finance attribution covered keeps that attribution's target for the new
version; one whose attribution was reversed stays uncharged (provisional readings,
Requirements issue RQ3-15).

**Pending-binding hold.** A part with no binding is held, not quarantined at once, until
the binding feed's position is known to cover the part's time plus `binding_grace`
(5 min, est.): provisioning heartbeats advance the position. If a binding arrives in that
time the part is attributed normally; its attribution lag is then over 10 s and is
reported as a breach (§5.9), which is correct, since headroom did not see it in time. At
the end of the hold it is quarantined. Unattributable traffic belongs to no account, so
the hold delays no account's headroom.

**Stage A watermark.** Stage A has processed every record of its exporters accepted at or
before `w` when it has consumed, on every Kafka partition it reads, the changefeed's
resolved marker at or after `w` and processed everything before it. It publishes `w`
(pending-binding parts excepted) on a heartbeat topic every 1 s; an idle exporter's
watermark follows the resolved timestamps. Rating uses the minimum over all stage A
partitions to decide when a usage minute may close (§5.6). The heartbeat is not a fact:
rating records the value it closed on.

#### 4.3 Stage B: the account's attribution log

Stage B consumes the part batches from Kafka and appends each one, in a slot batch
transaction, unless its per-destination sequence is at or below the **producer watermark**
it keeps for that stage A partition (redeliveries and the outbox's two publish paths are
dropped; a gap waits). Per account the watermarks number the exporters the account's
traffic crosses (tens, est.). Stage B also keeps the account's **attachment set**: the
products for which the account has a live binding, from the binding facts stage A
forwards, which defines the "one per account and product" set of POL-14 (§5.9).

After commit, the lease holder passes the committed batches to rating **in process**
(stage B's and rating's slot leases are kept in one process by placement); after a
takeover, rating reads them from `attr_b_log` from its last applied position. So the
attribution → rating hop costs no Kafka round trip.

The attribution log is the input of rating. It is kept in the database for
`dispute_window` + 7 days and then archived by history (RFC-006). It can always be
recomputed from the raw records and the binding history, so it is not the 7-year evidence
store; §3.7 is.

#### 4.4 Quarantine, finance attribution and its reversal

A quarantine entry, in the exporter's stage A partition, holds: the part (record identity,
minute, bytes), its observation point and therefore its **link and supplier** (via the
observation point → link mapping and the link registry), the reason ("no binding",
"ambiguous binding", "identity conflict"), the time it was quarantined, and its state:
**quarantined**, **attributed**, **reversed** or **superseded**. Traffic is quarantined,
not charged (P3-S26).

**Reports.** Quarantine entries feed the **quarantine report feed** (§7): to operations per
entry, aggregated per link and minute; and to each supplier for its own links, aggregated
per link and minute, with no buyer data (there is none to show; POL-33). The notifier
delivers them (RFC-006), a supplier being told once the notice is in its notice list and a
first delivery attempted. Probe traffic is never quarantined, so never reported (X2-S20).

**Finance attribution (P3-S27, POL-17, POL-32).** An operator in finance sends, through
the operator console with the operator action envelope (role, reason; RFC-005), an
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

| Input | From | Used for |
|---|---|---|
| Reservation lifecycle feed, with its resolved timestamp (§7) | Account owner (RFC-002), Kafka | Parts, prices, effective minutes, ends and end causes, shortens, fees shown, moves, POL-07 rate cuts, partner-leg affected status, residue events, probe account |
| Link schedule feed: affected flags | Link schedule owners (RFC-001), Kafka | Affected marks on reservation lines (P3-S10) |
| Attributed parts | Stage B, in process (§4.3) | Usage line totals |
| Stage A watermarks | Stage A heartbeats, Kafka | Usage minute closure |
| Catalogue feed, with its resolved timestamp | Catalogue (§6), Kafka | Prices, price corrections, `usage_rate_cap`, probe designations |
| Posting acknowledgements | Settlement (RFC-004), Kafka | Which lines are posted, at which ledger position |
| Usage-applied acknowledgements | Account owner (RFC-002), Kafka | Through which rating position the account owner has applied unposted usage, and when |

| Entry | Contents |
|---|---|
| `inputs` | For each input feed, the position applied through (sequence, or resolved timestamp), in the order applied |
| `accrual-closed` | Account, minute `m`, and the reservation lines for `m` (reservation, amount, affected marks), run-length encoded across minutes |
| `usage-closed` | Account, minute `m`, the usage lines for `m` (product, route, amount, and the line's ELA) and the cost lines for `m` (§5.5) |
| `amendment` | Line reference, amendment sequence, amount, reason, cause where §5.7 gives one, trigger reference, the line's new ELA for a usage line |
| `fee` | Fee line or Share-borne fee line (§5.4) |
| `emitted` | The charge-line batch identity sent to settlement, and its usage reduction (§5.9) |
| `posted` | A posting acknowledgement applied: lines, amounts as posted, ledger position |
| `breach` | Lateness or attribution-lag breach reports (§5.9) |
| `checkpoint` | Snapshot reference |

Derived state per account (in the lease holder's memory and the standby's):

- the **reservation model**: for each reservation its route, product, legs, window, and
  for each part its rate over effective intervals and its price over minutes (§5.2), its
  end, end cause and fees shown;
- the **accrual watermark** per reservation: lines emitted through minute `m`;
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

**Accrual of minute m** = `Σ over parts active at m of rate_p(m) × price_p(m)`, rounded
down once (§2). A part's rate follows its effective intervals: an increase applies from
its next minute boundary (P3-S45: at 10:29:20, from 10:30, 100 × 2 + 50 × 3 = 350), a
decrease likewise and removes the newest part first (P3-S05, P3-S46), and a permanent
reduction's cut applies from the end of the notice (P3-S58: 4 Mbps → 2 Mbps, 8 → 4). An
extension adds a part for the added window only (P3-S40: [10:00, 12:00) at 2,
[12:00, 13:00) at 3).

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
   part is charged `min(its price, the path's price)`, the path's price being the one
   shown in the offer, carried in the lifecycle feed (P3-S59).
4. A **price correction** (§6.3) that covers the reservation, its part and the minute
   replaces the result of 1 to 3 for that minute.

**Affected marks (P3-S10).** An unplanned outage changes nothing in the accrual: every
minute keeps accruing. The link schedule feed's affected flags for (reservation, leg,
minute) (a projection of the link log, RFC-000 AI-R1-6), including a confirmation that
completed across a capacity reduction (v1.6, RQ-R1-1) and a reservation moved onto a path
(RQ-R1-6), and the lifecycle feed's partner-leg affected status, become **affected marks**
on the reservation line, published in the charge-line feed as annotations (no amount, no
amendment), whenever they arrive, for SLA credit (Problem 6).

**What never accrues.** A planned maintenance booking is a link schedule entry, not a
reservation, so it never reaches the reservation model and no line or settlement exists
for it (P3-S47, POL-07). The probe accounts' reservations produce no lines (POL-06,
X2-S20).

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

A usage line's **source reference** names the account (§5.8), so it is never shown to a
supplier: RFC-004's reporting shows a usage-priced share by an opaque reference derived
from it (POL-33, RQ5-1).

#### 5.4 Fee lines (P3-N12)

The lifecycle feed carries, for each reservation, each **fee shown at booking**
(fee ID, amount, partner link, and the term while it applies: until the end of the
partner's minimum term, or, for a plain cancellation fee, until the window ends, or at
any time for an open-ended reservation) and, at its end or shorten, the **end cause**:
cancelled by the account (including a shorten to the next minute boundary, and a support
operator's change at the account's documented request, POL-08, POL-32), **shortened** by
the account to a later end, released (POL-16), terminated (POL-30), revoked (POL-07),
cancelled by the holder after a rate cut under POL-07, or ended at its window's end.

For each fee shown whose term still applies at the effective minute of the end, or, for a
shorten, at the **new end** (POL-08; RQ3-4 as decided):

| End cause | Line |
|---|---|
| Cancelled or shortened by the account, released, terminated | **Fee line** charged to the account: exactly the shown amount, not rounded, not split, wholly the partner's (P3-S11 first row, P3-S43 first row, P3-S44 rows 1 and 2, P3-S60: 0.500000 USD is 500,000 micro-USD; P3-S63: shortened to end 10 days after its start, inside a 30-day minimum term, 0.500000 USD) |
| Revoked; cancelled after a POL-07 rate cut | **Share-borne fee line**: the same amount, paid by Share to the partner, not charged to the account (P3-S44 rows 3 and 4) |

A fee whose term had ended is not due (P3-S43: cancelled after 31 days of a 30-day
minimum term, nothing; P3-S63: shortened to end 31 days after its start, nothing). A
shorten's fee line is decided by the entry that applies the shorten, not when the
shortened reservation later ends. A fee the partner imposes that was **not shown** is
never charged to the account; it is a Share-borne fee line for the partner's fee per the
partner terms in force at booking (P3-S11, second row). A partner booking left without
Share's confirmation and cancelled because its request was withdrawn or failed (POL-28)
gives a Share-borne fee line keyed by the request, from the lifecycle feed's residue event
(RFC-000 §8; AI3-4, resolved).

Each fee or Share-borne fee line has the source reference (reservation or request, fee ID)
and is decided once, in one `fee` entry, however often the end or shorten is processed and
whatever end follows a shorten (P3-S60): a fee ID is charged at most once per reservation.

#### 5.5 Share-borne cost lines

Two costs Share bears are amounts that only rating can compute, per minute, so rating
emits them on the charge-line feed as **cost lines**, distinct from charge lines: they
charge no buyer. Each carries its payer (Share), the catalogue position of the weights
that split it, and its reason (RFC-000 §8, AI4-7). Settlement pays each as POL-23 says:
split by Webster among the parties concerned, each supplier paid its share from Share's
own account, no commission share posted (RFC-004).

| Cost line | Key | Amount |
|---|---|---|
| **Carried excess** (POL-17) | (account, product, route, minute) | The usage line the excess would have made: `⌊usage_price × Σ (B − A) / 10¹⁵⌋` over the minute's reservations of a product without burst whose egress bytes exceed `A` (P3-S41); split among the route's parties. An **incident** is raised to network operations through the alert feed (RFC-006), one per reservation and run of consecutive excess minutes, updated while it lasts |
| **Dearer equivalent path** (POL-07, POL-23; RQ3-8 as decided) | (reservation, minute) | `⌊Σ_p rate_p × path price_p / 10⁶⌋ − the reservation line's charge`, when positive: the new path's charge, computed exactly and rounded down once, less the buyer's charge (P3-S59: 100 × 3 − 200 = 100; 0 on a cheaper path; P4-S110: ⌊3 × 2.7⌋ − ⌊3 × 1.5⌋ = 8 − 4 = 4 micro-USD); split among the **new path's** parties |

Cost lines are amended like charge lines (late excess records raise the excess cost line;
a price correction changes both).

#### 5.6 Closure: when a line is first emitted

A line's **original** is emitted when its minute is **closed** for the account, by one
entry; everything rating applied before that entry is in the original, everything after
it is an amendment. Because the account's state machine is serial, a record arriving
while its minute is being charged is either before the closing entry or after it, never
both and never neither (P3-S17); no lock is needed (Competition: D26). Closure decides only
what is original and what is amendment; it is never a condition of correctness.

**Reservation minute `m`** closes when the lifecycle feed's **resolved timestamp** for the
account's Kafka partition is at or after `m + 60 s` and rating has applied every event
before that marker (RFC-000 §4.5; AI3-2, resolved). Every entry not yet seen then has a
commit timestamp after `m + 60 s`, and every reservation fact takes effect at or after the
minute containing its commit timestamp (confirmations from `floor_min`, every change and
end from a later boundary), so no fact can still affect `m`. The resolved timestamp is the
database's, not the account owner's: it advances while an account owner fails over, and
stalls only while a range moves its lease (seconds). Rating closes `m` about 3 to 5 s after
`m + 60 s` (est.: the closed-timestamp target and the changefeed's resolved interval,
RFC-006 settings). Prices for `m` were fixed at least `price_notice` earlier, or are a
correction, which amends.

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

| Trigger | Reason recorded, and cause | Direction |
|---|---|---|
| Late records (attributed parts after the line's closure) | "late traffic", with the record identities | Only up: adding bytes never lowers an exact value, so never lowers its floor (P3-S33). A repeat of a record already charged never reaches rating (§3.5), so it amends nothing (P3-S16) |
| A price correction (§6.3) | "price correction", with the correction's ID, the operator, the **cause** (Share, a named supplier, other) and the reason | Either way for a usage price (P3-S34: −50,000; P3-S55: +20,000); only down for a locked reservation price (P3-S56) |
| A finance attribution of quarantined traffic (§4.4) | "quarantine attribution", with the operator, the reason and the reference | Up |
| Its reversal (§4.4) | "attribution reversed", with the operator, the reason and both references; cause **Share** | Down (P3-S65: −10,000) |
| An accepted correction of a rejected record (§3.3) | "corrected record", with the raw reference | Up |
| A superseding record (§3.3) | "superseding record", with the original's identity and version; for a downward amendment, cause **the exporter's owner** (a named supplier, or Share) | Either way (P3-S66: −10,000) |

**Batching.** Late records for one line are gathered into at most one amendment per
`amendment_interval` (60 s, est.); each other trigger gives its own amendment, so every
amendment has exactly one reason and at most one cause. A correction that covers many
lines (a route's price for 30 days) is applied line by line in minute order, paced so that
its amendments do not crowd out originals, and its progress is reported to the operator.

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

| Line | Source reference |
|---|---|
| Reservation | (reservation ID, minute, amendment sequence) |
| Usage | (account, product, route, minute, amendment sequence) |
| Fee | (reservation ID, fee ID); for a POL-28 residue, (request ID, partner link, fee ID) |
| Cost | (cost kind, its key, minute, amendment sequence) |

Rating commits the line to `rating_log` **before** emitting it, then emits the account's
lines as one **charge-line batch** per account and closure tick (about one a minute per
account: the reservation lines of the minute just closed, the usage lines of the minute
closed about 4¼ minutes after its end, amendments and fees), as an outbox row in the same
transaction as its `emitted` entry, which settlement posts as one movement per account and
minute (RFC-000 §6). **One batch is in flight per account**: the next is emitted only once
settlement has acknowledged the last; lines that become due meanwhile wait for the next
batch (a minute's tick normally finds the last batch acknowledged within about 0.2 s).
Delivery is at least once (the outbox's two paths); the ledger deduplicates each line by
its source reference, dropping a line already posted with the same contents (RFC-000 §4.4,
A0R-10). So however charging is repeated, interrupted or restarted, each reservation
minute, each record and each fee is charged once (P3-S12, P3-S13): the line's identity and
amount are fixed in rating's two-region log before it leaves.

A line is marked posted only on settlement's **posting acknowledgement** (RFC-000 §8;
AI3-3, resolved): per line, posted with the ledger position, or excluded with the reason
(a line whose contents differ from what was posted, which is a defect and is alerted).

#### 5.9 Usage exposure inputs to headroom (P3-N10)

Rating publishes, per account and product in the account's attachment set (§4.3), the
two parts of usage exposure (POL-18, POL-14), on the **unposted-usage feed** (§7):

- **Unposted usage** `U(X)` = `Σ over the account's usage lines L of the product of
  max(0, ⌊V(L)/10⁶⌋ − P_X(L))`, where `V(L)` is the line's exact value from every part
  rating has applied (records accepted and attributed, open minutes included) and `P_X(L)`
  is what settlement has acknowledged as posted for `L` through **ledger position X** of
  the account's ledger partition. The `max(0, ·)` keeps a downward amendment from being
  counted before its credit is posted. P3-S37: 0.2 GB at 10,000 micro-USD/GB is 2,000
  micro-USD.
- **The in-flight batch** `b`, if one is emitted or about to be: its identity and its
  **usage reduction** `Δ_b = U(X) − U(X with b posted)`, computed line by line with the
  same `max(0, ·)`.
- **Lateness bound** = `usage_rate_cap × (max_lateness + attribution_lag_max + 60 s) ×
  the product's highest usage_price on any route`, rounded up to the micro, with the
  highest price taken over prices in force from now to the end of that interval (so a
  rise announced within it is covered). P3-S37: 100 Mbps × 250 s = 3.125 GB at 10,000,
  so 31,250 micro-USD; usage exposure 33,250. (See Requirements issue RQ3-13 on the
  window.)
- For information (P4-S16), **accrued reservation charges not yet posted**, with the same
  in-flight reduction.

**Exact against the ledger balance (RQ3-12: no requirements change; the design pairs
exactly).** The account owner's headroom subtracts unposted usage from the ledger balance
it has applied, through position `P` (RFC-004 Part A). It applies a figure only once
`P ≥ X` (RFC-000 §4.6, AI3-3), and it counts
`U(X) − (Δ_b if the movement posting b is at or below P and posted b whole, else 0)`.
That is exact at every applied pair:

- nothing posted at or below `X` is counted, since `U(X)` excludes it;
- the only usage postings between `X` and `P` are those of the in-flight batch, because
  rating emits a batch only after the account owner has applied a figure naming it
  (**publish before emit**, below) and only one is in flight; its movement removes exactly
  `Δ_b`;
- a batch posted with an excluded line is not reduced, which overstates exposure (never
  headroom) until the next figure, and is alerted.

This needs the ledger movement feed to say, per movement, which charge-line batch it
posted and whether whole (Architecture issue AI3-10). Without the reduction the design
would count an in-flight posting twice until the next figure, which is what revision 1
allowed and the requirement does not.

**Publication.** A figure is published for an account whenever it changes, coalesced to at
most one every `exposure_publish_interval` (500 ms, est.), as absolute values with the
rating position (rating log sequence and the input positions behind it), `X` and the
in-flight batch, so a consumer applies the latest it may and ignores older ones. Rating
emits a charge-line batch only after the account owner has acknowledged applying a figure
that names it as in flight and already counts its lines (**publish before emit**), so a
posting can never reach the balance before its traffic was counted in unposted usage.

**Attribution lag (P3-S61, P3-S62, X2-S22).** A record is **counted** when the account
owner applies the first figure whose rating position includes the record's parts; the
usage-applied acknowledgement carries the applying entry's commit timestamp. For each
published figure rating keeps, per exporter, the earliest acceptance time and the identity
ranges of the records it newly counts. On the acknowledgement, every record counted more
than `attribution_lag_max` after its acceptance is reported as a **breach** of the usage
exposure bound with its exporter, identity and attribution lag. It is charged like any
other record (P3-S62). Rating also reports, per minute and serving region, whether every
record accepted in it was counted in time, which is the X2-S22 measure (RFC-006 aggregates
it per month and region).

**Lateness (P3-S38, P3-S68).** A record whose lateness (§2: acceptance time less its last
minute end) exceeds `max_lateness` is reported as a breach with its exporter and lateness,
and charged like any late record. P3-S68: active 10:00:00 to 10:02:00, arriving 10:04:50
(170 s) is charged and not reported; arriving 10:05:10 (190 s) is charged and reported.
Corrections and superseding versions are not lateness breaches (they are not late
traffic); a superseding version that raises bytes is reported on the breach feed as such,
for finance and risk. Probe records are in neither report.

**Latency budget, acceptance → counted** (est., p99, steady): stage B committed 0.3 s
(§4.5) + rating applies and commits its `inputs` entry 60 ms + coalescing up to 500 ms +
Kafka to the account owner 50 ms + the account owner's entry up to 60 ms ≈ **1 s**; about
1.3 s after a region loss; against 10 s. RFC-000 §2 allows 2 to 3 s for this path; the
difference is margin. A takeover of any stage on the path costs about 5 s (est.), still
inside 10 s; a changefeed relay instead of a direct publish (an owner died between commit
and publish) adds about 1 s per hop (RFC-000 §4.2); a longer outage of the path produces
breach reports, never a silent miss.

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

**Cold re-rate.** If a rating partition had to be rebuilt without its log (a disaster
beyond RFC-000's model, or a migration), it would recompute every line's current exact
value from the inputs and take each line's posted total from the **ledger**, the authority
on what was charged; it then emits, for each line, `C − posted` as the next amendment.
Nothing is charged twice and nothing is missed, even with no record of where charging had
got to (P3-S13).

#### 5.11 Throughput and sizing

| Item | Estimate | Note |
|---|---|---|
| Reservation lines | About 1.05 M/s (63 M active reservations, RFC-000 §6) | One multiply-add per part per minute; run-length encoded in `accrual-closed` (a reservation's line is usually the same every minute): about 10 MB/s of log in all |
| Accrual closures | About 1,700/s (100,000 active buyer accounts, est.) | One entry per account and minute |
| Usage lines | About 1 M (account, product, route) attachments active (est.) → at most 17,000 lines/s | Plus about 1,000 amendments/s for late traffic (est., 5% of lines) |
| Attributed parts applied | About 300,000/s at peak | ELA updates, O(1) each |
| Unposted-usage figures | At most 2 per second per account with usage traffic: about 100,000/s at 50,000 such accounts (est.) | Kafka events; each account owner applies at most 2 entries/s, inside its own batch transactions (RFC-002) |
| Rating transactions | One slot batch transaction in flight per slot, 256 slots: about 8,500/s | §1.1 |
| Memory per rating slot | Reservation models about 200 B each, 63 M / 256 → about 50 MB; open usage ELAs and the last hour of closed lines' ELAs (17,000 × 3,600 lines at about 64 B, about 4 GB in all) → about 20 MB; lines not yet fully posted, a few MB | Revision 1's "37 days of closed ELAs in memory" would be about 5 × 10¹⁰ lines (est. several TB); they are read back from the log when needed instead |
| Old-line reads | An amendment to a line closed more than `amendment_hot_window` ago reads its last entry from `rating_log` (live in the database for `dispute_window` + 7 days, est.) or from history's segments | Rare for late traffic; paced for a correction's fan-out (R3-7) |
| Charge-line batches to settlement | About 1,700 movements/s (RFC-000 §6) | One in flight per account |

RFC-000 R6 (a very large account) is absorbed: an account with 1 M reservations closes
1 M lines a minute (about 17,000/s) in one partition, within one lease holder's capacity
(est.); it can be given a slot to itself.

#### 5.12 Hot standbys, recovery and timeliness

RFC-000 §2 requires hot standbys on the attribution → unposted-usage → account path and
on the reservation-accrual posting path. Here:

- every slot of stage A, stage B and rating has a standby NestJS instance in the other
  Kenyan region that consumes the same Kafka partitions, tails the slot's log rows and
  keeps the derived state current;
- the owner lease for these classes is 3 s; on its expiry the standby takes it, reads
  anything committed since its last applied row, and resumes, re-emitting anything not
  yet acknowledged (idempotent): about **5 s** at p99 (est.; RFC-000 AI3-9). A database
  range-lease move after a node loss runs in parallel with it;
- checkpoints every 10 s of log bound a replacement standby's catch-up.

| Target | Design point (est., p99) | With one takeover | Bound |
|---|---|---|---|
| Reservation line posted (X2-S13) | Closure about 3 to 5 s after the minute's end, `accrual-closed` commit 30 ms, Kafka 50 ms, settlement and ledger about 100 ms: about **6 s** after the minute's end | + 5 s per takeover on the path (rating, settlement); an account owner's failover no longer stops closure (§5.6) | 2 min target; 7 min after a zone loss (5 min RTO ceiling) |
| Usage line posted, records within `max_lateness` (X2-S13) | Closure at 60 + 180 + 15 = 255 s after the minute's end, plus posting: about **256 s** | + 5 s per takeover; at worst 285 s (the stalled-watermark bound) plus posting | `max_lateness` + 2 min = 300 s target; + 5 min after a zone loss |
| Accepted record counted in headroom (X2-S22) | About 1 s | About 6 s | 10 s (`attribution_lag_max`) |

A declared region disaster moves every database leaseholder and owner lease to the
surviving region (RFC-000 §5.1); rating's tables are two-region durable, so nothing is
recomputed: the affected minutes are posted late, within their target plus the 1 h
regional RTO, none lost or posted twice (X2-S19, X2-S23). The usage line's margin to its
target is about 44 s steady; a regional failover consumes it, and those minutes count
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
| Route | Ordered legs (link IDs from RFC-001's registry) | Commercial | Every link exists and is not retired |
| Price series (product, route, kind) | `reservation_price` (guaranteed only) or `usage_price` (every product, POL-17) versions: price in pico-USD, `effective_from`, `announced_at`, `oe_effective` | **Commercial, with a second commercial operator's approval** (POL-27, POL-01; RQ3-1 as decided) | §6.2 |
| Price correction | §6.3 | Finance (POL-23) | §6.3 |
| Split weights (route) | Per leg a weight, and the commission's weight, from a minute boundary (POL-12) | **Commercial, with a second commercial operator's approval** (POL-12) | Non-negative; legs match the route |
| Partner terms (partner link) | Minimum term, cancellation fee, whether a leg can be decreased, maximum hold length, whether it accepts an expiry set by Share (POL-08, POL-26, POL-28) | Commercial, one operator (POL-32) | — |
| Account-product terms | `usage_rate_cap` (POL-14, default 100 Mbps) | **Finance**, with a reason (POL-14) | Positive, in whole Mbps |
| Probe designations | Probe accounts, the probe supplier and its links, probe exporters (POL-06; semantics RFC-006) | As RFC-006 states | — |

Every fact carries its commit timestamp, the pseudonymous principal, any approver and the
reason (operator action envelope, RFC-005), so the catalogue is bitemporal and answers "as
known at T" (POL-19). A four-eyes action reaches the catalogue only once the operator
console has its second approval (the console owns pending approvals, their
`approval_expiry` and cancellation); the catalogue checks, at application, that the
requester and the approver are distinct operators of the owning role, and **re-checks the
preconditions** (the price rules below, the route's legs), refusing with nothing changed if
they no longer hold (POL-32). An action from any other role is refused and recorded
(X1-S13, RFC-005). The role checks replace revision 1's "a principal RFC-005 authorises".

#### 6.2 Price rules (POL-27)

- Every `effective_from` is a minute boundary; a version that is not is refused.
- `announced_at` is the commit timestamp of the entry that records the approved version:
  a price is announced when it takes its place in the catalogue, not when it was
  requested.
- A `reservation_price` version applies to new bookings and new parts from
  `effective_from` (at or after `ceil_min(announced_at)`), and to open-ended reservations
  from `oe_effective = max(effective_from, ceil_min(announced_at + price_notice))` (§5.2).
- **Every `usage_price` version**, whatever traffic it prices (best-effort, burst on a
  guaranteed product, traffic outside a reservation), needs
  `effective_from ≥ ceil_min(announced_at + price_notice)`; a version that does not is
  refused at approval (P3-S69; POL-27, RQ3-10 as decided).
- A version is never changed or withdrawn after it is recorded; a mistake in a price is
  fixed by a correction (§6.3).
- The notice of an open-ended price change to each holder, with the hold it needs and any
  top-up (POL-27, RQ4-8), is RFC-004's and the notifier's, from the catalogue feed.

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
| Locked prices only downwards | The corrected price is above any locked price it would replace: for a reservation correction, a part's locked price at a covered minute (P3-S56: 3 refused; 1 accepted, −100 a minute); for a `reservation_price` version, **any** upward correction, since every use of it is a lock |
| Usage prices | Never refused for direction (P3-S55) |
| Repeat | The same source reference with the same principal and contents returns the first result; with different ones it is refused (RFC-000 §4.4, AI4-1; kept 7 years) |

The reservation-price check reads the locked part prices from the catalogue's read model
of the reservation lifecycle feed (RFC-000 §2; AI3-7, resolved). Corrections are
bitemporal: a later correction of the same minutes supersedes an earlier one from its
commit timestamp, and the amendments it causes restate the line against the new price
(§5.7). Rating applies them to lines already posted (amendments) and to lines not yet
posted (their originals use the corrected price).

#### 6.4 Query, feed and availability

- **Feed**: per entity, ordered, every version, on Kafka from the outbox, with the
  changefeed's resolved timestamp. Every consumer (rating, attribution, the account owner
  for locked prices and partner terms, settlement for weights, network operations'
  policing for `usage_rate_cap`, RFC-006 for probe designations) keeps a full in-memory
  replica and records the **catalogue position** it used in every decision: the resolved
  timestamp through which it had applied the feed, so "the catalogue as known at T" is
  exactly what it used.
- **Query**: "the value of entity E as known at T, effective at minute m", served from the
  catalogue's projection by follower reads at T.
- **Availability**: no booking, record or charge waits on a catalogue write. Consumers
  decide from their replica; a catalogue partition that is down delays only operator
  changes to it. Writes are rare (est. a few per second).

### 7. Contracts

RFC-000 §8 (revision 4) names the contracts; this section gives the semantics of those
this RFC owns and the guarantees it needs from those it consumes. Every asynchronous feed
is a Kafka topic fed by the transactional outbox, its events identified by (producer
partition, epoch, sequence) and consumed idempotently in sequence order (RFC-000 §5.5).
Schemas and wire formats belong to the delivery phase.

**Provided.**

| Contract (RFC-000 §8) | Kind | Semantics |
|---|---|---|
| **Flow-record ingestion protocol** | External protocol, to exporters | §3.1. At least once from the exporter, verbatim retransmission; each record's outcome is durable in two regions before the acknowledgement; an acknowledged record is never lost; identity per §3.2; duplicates acknowledged as such; rejections kept with their reason; corrections and superseding versions only from the producing exporter (§3.3); the Share metering template, without personal data. Probe: acknowledgement within 1 s |
| **Metering hand-off** | Kafka, from `ingest_log`'s changefeed and the owner's direct publish | Per exporter, in sequence order: every batch, correction and supersession entry with its outcomes and commit timestamp; resolved markers. Consumer: attribution stage A |
| **Catalogue** (link registry RFC-001) | Query and feed | §6. Products, account-product terms (`usage_rate_cap`), prices and corrections, weights, partner terms, probe designations; ordered per entity, bitemporal, never rewritten; resolved timestamps; every consumer records the catalogue position it used. Consumers: RFC-001, RFC-002, RFC-004, RFC-006, network operations |
| **Unposted-usage feed** | Kafka, applied as entries in the account owner's log (RFC-002); semantics in headroom RFC-004's | Per (account, product): unposted usage `U(X)`, lateness bound, accrued reservation charges not yet posted, all in micro-USD; the rating position; the ledger position `X`; the in-flight charge-line batch and its reductions (§5.9). Absolute values, monotone positions: apply the latest whose `X` the applied ledger position has reached; subtract a batch's reduction once its movement is applied whole. Each application is acknowledged. At most one figure per account per 500 ms (est.). Probe accounts get none |
| **Charge-line feed** | Kafka, to settlement (RFC-004) | One batch per account and closure tick, **one in flight per account**. Each item: kind (reservation, usage, fee; or cost line: carried excess, dearer path, Share-borne fee), source reference (§5.8), account, reservation or product and route, minute, amendment sequence, amount (signed micro-USD), **payer** (the account; Share for cost lines and Share-borne fees), reason and its details, **cause** of a downward amendment where §5.7 gives one, trigger reference (correction, attribution, reversal, superseded record), and the catalogue position of its prices and **weights version**; plus affected marks as annotations. Originals per reservation in strictly increasing minutes; at least once until acknowledged; each line idempotent by its source reference (an item resent has identical contents) |
| **Quarantine report feed** | Kafka, to the operator console, notifier, reporting, RFC-006 alerting | Per quarantine entry and aggregated per (link, minute): bytes, observation point, reason, state (quarantined, attributed, reversed, superseded); per supplier only its own links, no buyer data; never probe traffic |
| **Breach report feed** | Kafka, to the same consumers, for finance and risk | Lateness breaches (exporter, identity, lateness), attribution-lag breaches (exporter, identity, lag), superseding versions that raise bytes; per minute and serving region, whether every accepted record was counted in time |
| **Evidence query** | Query, served by RFC-006's history | §3.7: every accepted record of a reservation or link in a minute range, with its versions, for the retention period. Consumers: operations, support, finance, each read recorded for its role (POL-32) |
| **Operator commands** | Synchronous commands through the operator console (RFC-005 envelope) | Price corrections (§6.3), quarantine attributions and reversals (§4.4), each idempotent by its source reference and checked for principal and contents, refused with nothing changed when invalid; catalogue changes (§6.1), four-eyes ones only once approved |
| Attributed parts; attribution log | Internal | Stage A → stage B on Kafka with per-destination sequences (§4.2); stage B → rating in process, the table as the guaranteed path (§4.3) |

**Consumed.**

| Contract | Owner | What this RFC needs from it |
|---|---|---|
| **Reservation lifecycle feed** | RFC-002 | Per reservation: route, product, legs, window, each part's rate over its effective intervals and its locked price (with the time it was locked), the deciding entry's commit timestamp, every change's effective minute, shortens with the new end, the end, its effective minute and its **end cause** (§5.4), each fee shown at booking with its term, moves to an equivalent path with the path's shown price and effective minute, rate cuts under POL-07 (flagged as such), partner-leg affected status, whether the account is a probe account. **Effective-time closure**: the changefeed's resolved timestamp, every entry's effective time at or after its commit timestamp (RFC-000 §4.5, AI3-2). **Residue events** (POL-28; AI3-4) |
| **Usage-applied acknowledgement** | RFC-002 (emitted by the account owner) | Through which rating position the account owner has applied unposted usage, with the applying entry's commit timestamp (AI3-3) |
| **Link schedule feed** | RFC-001 | Affected flags per reservation, leg and minute, as a projection of the link log. Nothing else; maintenance bookings are not reservations |
| **Posting acknowledgement** | RFC-004 (settlement) | Per line: posted, with the ledger position, or excluded and why (AI3-3) |
| **Ledger movement feed** | RFC-004 | For the account owner's exact pairing (§5.9): per movement, the charge-line batch it posted and whether it posted it whole (AI3-10). For the cold re-rate (§5.10): posted totals per line |
| **Attribution keys**, with the observation point → link mapping | Provisioning (Problem 5) | §4.1, published before traffic flows |
| **Principal and authorisation context; operator action envelope; audit record; payload encryption** | RFC-005 | Exporter credentials, each naming its exporter's owner (a supplier or Share); roles: finance for corrections, attributions, reversals and `usage_rate_cap`, commercial for prices, weights and partner terms, with the approver; audit fields in each command's entry; pseudonymous principals; HSM-held keys for every payload |
| **Substrate conventions; history; alert feed; probe designation semantics** | RFC-006 | As RFC-000 §8; plus slot batch transactions (AI3-11) and the sealed-segment layout of §3.7 |

### 8. Parameters

POL parameters are read from the policy register's values as configured; the others are
design parameters of this RFC, changeable without a change of mechanism.

| Parameter | Value | Source |
|---|---|---|
| `max_lateness`, `attribution_lag_max`, `usage_rate_cap` | 180 s, 10 s, 100 Mbps default (set by finance) | POL-14 |
| `dispute_window` | 30 days, from the end of the minute | POL-17 |
| `price_notice` | 30 days | POL-27 |
| `flow_active_timeout` | 60 s | POL-13 |
| `approval_expiry` | 72 h (applied by the operator console) | POL-32 |
| `ingest_retry_timeout`, `epoch_jitter`, `wrap_slack`, `future_skew_max` | 2 s, 2 s, 10 min, 5 min (est.) | This RFC |
| Ingestion flush interval and size | 20 ms, 256 KB (est.) | This RFC |
| `binding_grace` | 5 min (est.) | This RFC |
| `usage_close_margin`, usage close bound | 15 s; `flow_active_timeout` + `max_lateness` + 45 s after the minute's end (est.) | This RFC |
| `amendment_interval`, `amendment_hot_window`, `exposure_publish_interval` | 60 s, 1 h, 500 ms (est.) | This RFC |
| Owner lease (stage A, stage B, rating) | 3 s | RFC-000 §2 |

### 9. Design-level acceptance tests

Each cites the scenario it serves (docs/README.md conventions).

| Test | Serves |
|---|---|
| Identity: an exporter restart (new init time), a 32-bit wrap, and a verbatim redelivery of a pre-wrap message a simulated year later; the redelivery is a duplicate, the restarted sequence 7 is new | P3-S50, P3-S14 |
| Range sets: 10⁹ records with 1% reordering and 0.01% identity-bearing rejects; interval count and memory against §3.5; kill the ingestion lease holder mid-transaction and check the range-set rows equal the accepted identities in the log | P3-S14, X2-S04 |
| ELA: random records, spreads and negated parts against an arbitrary-precision reference, every floor equal; the interval fallback exercised by crafted near-integer sums | P3-S21, P3-S51, P3-S15 |
| Order independence: one set of records delivered in order once, and shuffled with 30% duplicates and 20% after their minute's closure; every line's posted total equal | P3-S15, P3-S32, P3-S33 |
| Closure race: records injected around the closing entry under load; each in the original or an amendment, exactly once | P3-S17 |
| Closure on resolved timestamps: kill an account owner during a minute; reservation lines still close within 10 s of the minute's end | X2-S13 |
| Restart: kill rating lease holders mid-batch and mid-emission, and drop the owner's direct Kafka publish so only the changefeed relays; then a cold re-rate from inputs and the ledger; no line missing or posted twice | P3-S12, P3-S13 |
| Publish before emit and exact pairing: delay the usage-applied acknowledgement and the ledger movement feed independently; no usage posting reaches the ledger before its figure is applied; at every applied pair, headroom equals the exact value | P3-S61, P4-S16 |
| Attribution lag: stop a stage B lease holder for 15 s; the records accepted meanwhile are reported as breaches with exporter and lag | P3-S62, X2-S22 |
| Lateness from the last minute: records spanning two minutes at 170 s and 190 s after their last minute; only the second reported; both minutes' parts in their originals | P3-S68, P3-S38 |
| Corrections and supersessions: a correction and a supersession from the producing exporter, each sent three times; another exporter's and an operator's attempt; a supersession after the window | P3-S30, P3-S66 |
| Attribution and reversal: attribute quarantined traffic, reverse it, try to attribute it again, and repeat each command with its source reference; once at the window's boundary | P3-S27, P3-S65, P3-S70 |
| Prices: an open-ended change with a part added after the announcement; a `usage_price` version for each kind of traffic with too little notice, refused at approval; a price and a weight approved by the requester, refused | P3-S64, P3-S69, X1-S31 |
| Fees: shortens into and past a minimum term, then a cancellation; one fee line at most | P3-S63, P3-S60 |
| Throughput: 600,000 records/s for 1 h with 1 M reservation lines/s on the database and Kafka at 2 + 2 + 1; transaction rates against §1.2; every X2-S13 and X2-S22 target met | X2-S04 |

## Benefits

| Need | How this design meets it |
|---|---|
| Exactly once for records (P3-N3) | One transaction per slot batch checks and inserts each identity with the append; range sets make 7 years of identities a few hundred MB (est.), so the check is in memory at 600,000 records/s; identity survives wraps and restarts by construction |
| Every received record kept (P3-N7) | Every outcome, rejections, duplicates, corrections and superseding versions included, in a two-region insert-only table before the acknowledgement, sealed under retention lock; no head-of-line blocking; only the producing exporter corrects |
| Exact charges in any order (P3-N3, P3-N5, POL-11) | Exact rational accumulation (ELA) and one rounding per line; amendments restate the total; verified interval arithmetic keeps exactness cheap |
| Exactly once for lines (P3-N2) | Deterministic source references fixed in rating's two-region log before emission; ledger deduplication per line; watermarks per reservation |
| Amended, never rewritten (P3-N8) | Every change is a new amendment with one reason and, when downward and caused, its cause; late traffic only ever increases a line |
| Each kind of traffic by its rule (P3-N6, P3-N13) | Attribution fixes class and egress (the hand-off where the last leg is unmetered); rating applies the per-minute rule on exact totals; reversals at Share's cost; Share-borne costs computed where the amounts are known |
| Reproducible (P3-N9) | Every input retained and positioned (sequences, resolved timestamps); rating's log records the order of inputs; a continuous re-rater checks it |
| Usage exposure within 10 s, exact (P3-N10, X2-S22) | About 1 s from acceptance to headroom (est.), 5 s takeovers; exact against the balance by the ledger position X and the in-flight reduction; breaches reported per record |
| Timeliness (X2-S13) | Reservation lines posted about 6 s after their minute (est.) against 2 min, closure no longer waiting on an account owner's failover; usage lines about 256 s against 300 s |
| Ingestion availability (X2-N1) | Ingestion depends on nothing but its own tables; acknowledgement in about 105 ms (est.) against 1 s |
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
| **A per-partition transaction for every batch** | About 10⁵ transactions/s for these components alone (est.); slot batch transactions carry the same entries in about 26,000/s with the same single-writer and contiguity guarantees (AI3-11) |
| **A separate outbox table for the metering hand-off** | Writes every accepted record twice; the insert-only `ingest_log` is already a committed feed row, so its changefeed is the outbox |
| **Stage B to rating over Kafka** | One more hop (about 50 ms p99, about 1 s on the relay path) on the 10 s headroom path, for two owners whose slots placement keeps in one process anyway |
| **Unposted usage as a stream of deltas** | A lost or repeated delta would skew headroom permanently; absolute values at positions are idempotent and reproducible |
| **Unposted usage without the ledger position X** | The account owner could apply a figure that has already dropped a line whose posting it has not applied, overstating headroom (AI3-3) |
| **Pairing by X alone** (revision 1) | Counts the in-flight batch's usage twice until the next figure; conservative, but not "until posted, and no longer" (RQ3-12). The in-flight reduction makes it exact for one more field |
| **Keeping every closed line's ELA in memory for `dispute_window`** (revision 1) | About 5 × 10¹⁰ lines (est.); the ELA is in the line's last log entry, read back when an amendment needs it |
| **Attribution inside ingestion** | Ingestion's 99.99% and 1 s would then depend on provisioning data (RFC-000 §2) |
| **Rating deciding attribution too** | Rating would need the network's keys; separating them lets attribution be replayed from provisioning history alone |
| **An operator path for corrected records** | Rejected by the requirements (POL-23, RQ3-2): an operator could then create or remove traffic |
| **"First attribution wins"** (revision 1) | Rejected by the requirements (POL-17, RQ3-3): a wrongly charged buyer could never be refunded |
| **Storing duplicates verbatim** | Doubles storage for an expected few percent of records without adding evidence; a compact entry with a digest keeps every receipt findable and detects conflicts |
| **A separate 7-year postings index for evidence** | About 1 PB per copy (est.); sorting sealed segments by key with block statistics answers the same queries |

## Risks and open issues

| # | Risk | Mitigation |
|---|---|---|
| R3-1 | **Every load figure is an estimate**: records per second, 100 B a record, parts per record, exporters, active reservations, usage lines, transactions per slot | RFC-006's load test (X2-S04) at the design profile; slot counts and flush intervals are configuration |
| R3-2 | **Exporter clocks.** Minutes are assigned by the exporter's flow times; a skewed exporter shifts traffic between minutes, prices and reservations | Per exporter, the gap between export time and acceptance time is monitored and alerted; records too far in the future are rejected (§3.3); the source is assumed reliable (P3) |
| R3-3 | **Byte accounting versus policing.** If the policer counts bytes at another layer than the exporter, a reservation at its reserved rate could appear to exceed it, inventing burst or excess | The protocol fixes the octet count's layer to the policer's (delivery contract); excess incidents (§5.5) surface any mismatch early |
| R3-4 | **Provisioning lag.** A binding published after traffic starts sends that traffic to quarantine, recoverable only by finance attribution | Contract: bindings before traffic (§4.1); `binding_grace`; quarantine volume alerted per link |
| R3-5 | **Resolved-timestamp lag.** Reservation closure follows the database's closed timestamps and changefeed resolved interval (about 3 to 5 s, est.); a range-lease move stalls it for seconds | Far inside 2 min; RFC-006 sets the closed-timestamp target and resolved interval and the spike measures them (RFC-000 R18). Revision 1's dependence on the account owner's failover is gone |
| R3-6 | **A stalled stage A partition** would hold every usage closure | The 45 s bound (§5.6) closes anyway; its late records become amendments |
| R3-7 | **Correction fan-out**: a 30-day route correction amends every line of every account on the route, most of them read back from the log | Paced application; progress reported; bounded by `dispute_window` |
| R3-8 | **Very old usage lines** (a record years late) need their state read back from archives | Rare by assumption (reliable source); cost is a read of a few segments |
| R3-9 | **Publish before emit, and one batch in flight, couple posting to the account owner and settlement** | A batch waits at most for the account owner's or settlement's takeover (about 5 s); within the targets |
| R3-10 | **Storage**: about 2 to 3 PB per copy of compressed raw records over 7 years (est.) | Two copies only (sealed segments); columnar compression; RFC-006 confirms |
| R3-11 | **The exactness fallback** could be slow for a pathological line | Bounded by the number of distinct denominators; measured on the load test |
| R3-12 | **Database transaction rate**: about 26,000 transactions/s from these components (est.), beside admission's and the ledger's | Slot batch transactions (AI3-11); the R1 spike and RFC-006's re-costing include it (RFC-000 §5.5 item 7) |
| R3-13 | **Usage margin.** The usage line's design point is about 256 s against 300 s; a regional failover or a slow Kafka hop consumes the margin | Measured; `usage_close_margin` can shrink toward `attribution_lag_max`; failover minutes in a declared disaster are outside the measure |
| R3-14 | **Kafka consumer lag** on the attribution path turns into attribution-lag breaches | Consumer lag alerted per partition; hot standbys consume the same partitions; breaches are reported, never silent |

## Requirements issues

Revision 1 raised RQ3-1 … RQ3-12; `requirements-v1.6` decides all of them
([review 11](../reviews/11-requirements-amendments-from-detailed-rfcs.md), RFC-003 table),
and this revision applies the decisions.

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
| RQ3-9 | Lateness of a spread record | **Resolved** (v1.6) as revision 1 read it: from the end of its last minute (POL-14; P3-S68). Usage closure now allows for it (§5.6); see RQ3-13 | §2, §5.6, §5.9 |
| RQ3-10 | Notice for every `usage_price` | **Resolved** (v1.6) as revision 1 read it (POL-27, POL-14; P3-S69) | §6.2 |
| RQ3-11 | Correcting an accepted record whose contents were wrong | **Resolved** (v1.6): a superseding version from its own exporter within `dispute_window` of the original's last minute, the original kept, the downward amendment borne by the erring exporter's owner (POL-23; P3-S66). See RQ3-15 | §3.3, §4.2, §5.7 |
| RQ3-12 | Unposted usage "until posted, and no longer" | **No requirements change** (v1.6): the design must pair exactly. It now does, with the in-flight reduction (AI3-10) | §5.9 |

New in this revision. None blocks the design; each is decided provisionally as stated and
raised for the requirements owner.

| # | Issue | Provisional reading in this RFC |
|---|---|---|
| RQ3-13 | **The lateness bound's window and RQ3-9.** POL-14's bound covers `max_lateness` + `attribution_lag_max` + 60 s of traffic at `usage_rate_cap`, and counts lateness from the end of a record's last minute. A byte carried at τ can be in a record whose last minute ends up to 2 min after τ (a record of at most `flow_active_timeout` straddling a boundary), so an on-time record can leave traffic uncounted for up to about 120 + 180 + 10 s after it was carried, before the 60 s enforcement; the bound's 250 s may understate the exposure it is meant to cover by up to about two minutes at the cap | The bound is computed exactly as POL-14 states (§5.9). The requirements owner may want the window to include the minute and `flow_active_timeout` explicitly, or to confirm that the gap is accepted |
| RQ3-14 | **Personal data in a non-conforming export.** X1-N11 and A11 keep personal data out of every log; P3-N7 keeps every record received. An exporter that sends a data set for a template the session refused (one declaring IP addresses, say) would put personal data into the kept record | The template contract excludes personal data and refuses non-conforming templates before data (§3.1); a data set for a refused template is rejected "no template" and kept, its payload encrypted like any other; see AI3-12 for making it erasable. The requirements may want to say whether such a payload may be kept only as a digest |
| RQ3-15 | **Scope of a superseding record.** POL-23 says when a superseding version is accepted, not what it may change, nor how it interacts with quarantine | A superseding version keeps the original's observation domain, observation point and direction (it may change times, bytes and service keys); each minute it now touches is charged at that minute's price; a quarantined original's entry is marked superseded and the new version attributed afresh; a finance attribution's target carries over to the new version; a reversed attribution stays uncharged; a later version supersedes an earlier one, the window still from the original's last minute (§3.3, §4.2) |

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

New in this revision, raised for RFC-000's owner (and RFC-004, RFC-005, RFC-006 as named).

| # | Issue | Proposed resolution |
|---|---|---|
| AI3-10 | **Exact pairing needs one more field each way.** With pairing by X alone, a usage posting between X and the applied ledger position is counted twice until the next figure, which RQ3-12's decision does not allow. RFC-000 §8's unposted-usage feed and ledger movement feed do not carry what removes it | §8: the unposted-usage figure carries the in-flight charge-line batch and its usage reduction; the **ledger movement feed** carries, per movement, the charge-line batch it posted and whether whole; rating keeps one batch in flight per account and emits it only after a figure naming it is applied (§5.8, §5.9). RFC-004 Part A applies the reduction |
| AI3-11 | **Slot batch transactions.** RFC-000 §3 and §5.5 describe one batch transaction per partition; at the partition counts here (10,000 exporters, 100,000 accounts) that is on the order of 10⁵ transactions/s for metering and rating alone | RFC-006's owner runtime commits per slot, one transaction in flight per slot, carrying every partition of the slot with entries pending, each with its own head row and contiguous sequence (§1.1); RFC-000's per-partition guarantees are unchanged |
| AI3-12 | **Erasable rejected payloads.** A11 relies on logs never holding personal data; the only path by which a flow record could carry it is a non-conforming export (RQ3-14), which P3-N7 still keeps | RFC-005: payloads of data sets rejected "no template" are encrypted under a per-exporter, per-day key in the personal-data store's custody, so they can be crypto-shredded without touching the log; or, if the requirements allow (RQ3-14), keep only a digest |

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
| P3-S28 | §3.3 |
| P3-S29 | §3.3 |
| P3-S30 | §3.3 (only the producing exporter; correction message; refusals recorded with RFC-005) |
| P3-S31 | §3.3 (never altered; refused attempts recorded with RFC-005) |
| P3-S32 | §5.7 |
| P3-S33 | §5.7 |
| P3-S34 | §6.3, §5.7 |
| P3-S35 | §5.7 (served by reporting, RFC-004) |
| P3-S36 | §5.10 |
| P3-S37 | §5.9 |
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
| P3-S56 | §6.3 |
| P3-S57 | §6.3 |
| P3-S58 | §5.2 |
| P3-S59 | §5.2, §5.5 (Share's payment: RFC-004) |
| P3-S60 | §5.4, §5.8 (unsplit posting: RFC-004) |
| P3-S61 | §5.9 |
| P3-S62 | §5.9 |
| P3-S63 | §5.4 (shorten into a minimum term) |
| P3-S64 | §5.2 (every part re-priced), §6.2 |
| P3-S65 | §4.4 (reversal), §5.7 (cause Share; Share bears it: RFC-004) |
| P3-S66 | §3.3 (superseding records), §4.2, §5.7 (supplier debt or Share: RFC-004) |
| P3-S67 | §4.1 (egress at the hand-off) |
| P3-S68 | §2 (lateness), §5.6, §5.9 |
| P3-S69 | §6.2 |
| P3-S70 | §2 (`dispute_window`), §6.3 |
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
| X1-S12 (finance: price corrections, quarantine attribution and its reversal, `usage_rate_cap`) | RFC-005; validation in §4.4, §6.1 and §6.3 |
| X1-S13 (refusals of another role's action) | RFC-005; role checks in §3.3, §4.4, §6.1, §6.3 |
| X1-S31 (commercial: prices, split weights with four eyes; partner terms) | RFC-005 (approvals); validation and precondition re-checks in §6.1, §6.2 |
| P4-S15, P4-S16 (headroom itemised) | RFC-004 Part A, from §5.9's inputs |
| P4-S110 (dearer-path difference) | §5.5 (amount); split and payment RFC-004 |
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
