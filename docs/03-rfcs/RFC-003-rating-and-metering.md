# RFC-003. Rating and metering: exporter logs, exact charge lines, amended by total

| | |
|---|---|
| Status | **Draft**, revision 1. Rewritten on the accepted architecture; replaces the pre-baseline prototype draft of the same number |
| Satisfies | P3-S01 … P3-S62 (all 62). The metering, attribution and rating parts of X2-S02, X2-S04, X2-S09, X2-S10, X2-S11, X2-S12, X2-S13, X2-S14, X2-S19, X2-S20, X2-S22 and X2-S23 (the rest of each is RFC-006's). Inputs to P4-S15 and P4-S16 (headroom itemised; RFC-004 satisfies them). See the traceability table at the end |
| Policies | POL-01, POL-06, POL-07, POL-08, POL-11, POL-12 (weights stored, applied by RFC-004), POL-13, POL-14, POL-15 (fee holds, by reference), POL-16, POL-17, POL-18, POL-19, POL-20, POL-23, POL-27, POL-28, POL-29, POL-30, POL-32, POL-33 |
| Prior decisions | History log D10 (facts first), D18 (raw records, deduplicated by identity), D19 (amend, never edit; bound the exposure), D20 (price by usage time), D25 (amend by the line's new total), D27 (the bound covers the wait before charging). D26 (minute lock) and D28 (end-minute assignment) are **not** carried forward; see Competition |
| Builds on | The requirements at tag `requirements-v1.5` and [RFC-000](RFC-000-architecture.md) at tag `rfc-000-accepted` (revision 3.2): its components (metering ingestion, attribution and quarantine, rating, catalogue), their ownership and partitioning (§2), principles A1 … A6 (§1), the feed and idempotency conventions (§4.4, §4.5), the topology (§5), the sizing (§6), the allocation (§7) and the contracts (§8) |
| Specifies | Per RFC-000 §7: metering ingestion; attribution and quarantine; rating; the catalogue except its link registry (RFC-001) |

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
   with the part (POL-27, POL-08), at the lower price after a move to an equivalent path
   (POL-07), and nothing for a maintenance booking. At the design load this is about
   **1 M reservation lines/s** (RFC-000 §6, est.), each posted within 2 min of its
   minute's end at 99.99% of minutes (X2-N3).
2. **Flow records** (from exporters): about 260,000 records/s, 600,000/s at peak (POL-06),
   delivered at least once, late, out of order, sometimes unreadable, reported by several
   legs for the same traffic, spanning minutes, from exporters whose counters wrap and
   restart. Each must be acknowledged only once durable in two regions, within 1 s
   (X2-N1, X2-N4), kept for 7 years with its outcome (P3-N7, X2-N6), identified uniquely
   for those 7 years "whatever the exporter's counters do" (P3-N3), attributed to an
   account, route, product and reservation or quarantined (P3-N6, P3-N13), spread over the
   minutes its flow was active (P3-N4), priced at the price of its own minute (P3-N5),
   counted in its account's headroom within `attribution_lag_max` (10 s) of acceptance
   (P3-N10, X2-S22), and charged once per route at the egress count (P3-N13).

The outputs are charge lines of three kinds (POL-11: reservation, usage, fee), each
computed exactly and rounded down once (fees exact), and **amendments** that restate a
line's new total less what was charged (P3-N8), each with its reason; the inputs to the
usage exposure part of headroom (P3-N10, POL-14, POL-18); the amounts of the costs Share
bears that only rating can compute (carried excess, the dearer-path difference,
Share-borne partner fees); breach and quarantine reports; and the evidence store
(P3-N11). The catalogue (prices and their corrections, weights, partner terms, probe
designations) is reference data every owner prices, splits or validates against (RFC-000
§2).

What makes it hard is the combination: exactly-once over a 7-year identity space at
600,000 records/s; exact rational arithmetic (a 70-second flow puts 4/7 of its bytes in
one minute, P3-S51) that must give the same result in any arrival order (P3-N3); charges
that must be final enough to post within minutes yet amendable forever for late traffic;
and a headroom input that must be within 10 s of acceptance while the classification of a
byte (covered, burst, excess, outside a reservation) depends on totals not yet known.

## Approach

### 1. Shape of the design

```mermaid
flowchart LR
  EXP["Exporters"] -->|"ingestion protocol (§3.1)"| ED["Edge (exporter sessions)"]
  ED --> MI["Metering ingestion<br/>by exporter: raw record log,<br/>identity range sets"]
  MI -. "raw record feed" .-> AQA["Attribution, stage A<br/>by exporter: spread, bind, classify;<br/>quarantine log"]
  PRV["Provisioning (attribution keys)"] -. "binding feed" .-> AQA
  AQA -. "attributed parts" .-> AQB["Attribution, stage B<br/>by account: attribution log"]
  AO["Account owner"] -. "reservation lifecycle feed<br/>(closed through T)" .-> RA["Rating<br/>by account: lines, amendments,<br/>exposure inputs"]
  LO["Link schedule owners"] -. "affected flags" .-> RA
  AQB -. "attribution feed" .-> RA
  CAT["Catalogue<br/>by entity"] -. "catalogue feed" .-> RA
  CAT -. .-> AQA
  RA -. "charge-line feed" .-> ST["Settlement (RFC-004)"]
  ST -. "posting acknowledgements" .-> RA
  RA -. "unposted-usage feed" .-> AO
  AO -. "usage applied" .-> RA
  CON["Operator console"] --> CAT
  CON --> AQA
  MI -. "sealed segments" .-> HI["History (RFC-006)"]
```

Dashed arrows are feeds from the writer's log: at least once, ordered per producer
partition, identified by (producer partition, term, sequence) and consumed idempotently
(RFC-000 A6, §4.4). Every component below is a set of partitions, each a single-leader
state machine over a replicated log of 2 + 2 + 1 voters (RFC-000 A2, A3, §5.1).

The split of work follows what each decision depends on:

| Decided by | Depends only on | Never depends on |
|---|---|---|
| Metering ingestion: accepted, duplicate or rejected; the record's identity | The record and the exporter's own history | Reservations, provisioning, prices (so ingestion stays at 99.99% when they are unavailable, RFC-000 §2) |
| Attribution: which minutes, which account, route, product, reservation reference, which observation point is the egress, which class of POL-17 | The record, the provisioning bindings, the catalogue's probe designations | Reservation history, prices |
| Rating: covered, burst, excess, outside an active reservation; every amount | Attributed parts, reservation history, prices and corrections, fees shown | The network |

RFC-000 §2 gives attribution "which billing rule of POL-17 applies". The rule's *class*
(on a reservation's binding, best-effort, account attachment without reservation,
unattributable, non-egress evidence, probe) is fixed by attribution; whether the bytes of
a reservation's minute are within its reserved rate, burst or excess, and whether the
reservation was active in that minute at all, depends on the minute's total and on the
reservation history, so rating computes it (Architecture issue AI3-1).

### 2. Conventions: time, money and exact arithmetic

**Time.** All times are UTC. Flow times are carried at millisecond resolution; a record's
absolute start `s` and end `e` are derived from the export message as §3.1 states. Minute
`m` is the half-open interval `[m, m + 60 s)`. `floor_min(t)` is the minute containing
`t`; `ceil_min(t)` is the first minute boundary at or after `t`. The **acceptance time**
of a record is the timestamp of the ingestion log entry that accepted it, monotone within
an exporter partition across leader changes (each entry's timestamp is
`max(leader clock, previous entry's timestamp + 1 µs)`, as RFC-000 §4.5 does for posting
time).

**Money.** Amounts are integer micro-USD (POL-11, POL-20). **Prices** are stored exactly as
integers in **pico-USD** (10⁻⁶ micro-USD) per unit: per Mbps-minute for
`reservation_price`, per GB (10⁹ bytes) for `usage_price`. Integer micros per Mbps-minute
would be too coarse for real prices (0.50 USD per Mbps-month is about 11.57 micro-USD per
Mbps-minute); six further decimal places make every realistic price exact. No floating
point is used anywhere.

**The line formulas** (POL-11), with `⌊·⌋` rounding toward minus infinity:

| Line | Exact value (pico-USD) | Charge (micro-USD) |
|---|---|---|
| Reservation line (r, m) | `V = Σ over parts p active at m of rate_p(m) [Mbps] × price_p(m) [pico/Mbps-min]` | `⌊V / 10⁶⌋` |
| Usage line (account, product, route, m) | `V = usage_price(product, route, m) [pico/GB] × X / 10⁹`, with `X` the line's usage-priced bytes, an exact rational | `⌊V / 10⁶⌋ = ⌊price × X / 10¹⁵⌋` |
| Fee line (r, fee) | The shown amount | Exactly the shown amount, no rounding |

Checks against the spec: 150,000 bytes at 10,000 micro-USD/GB is exactly 1.5, charged 1
(P3-S21, P3-S48); 99,999 bytes is 0.99999, charged 0 (P3-S21); 3 GB × 40/70 at 10,000 is
17,142.857…, charged 17,142 (P3-S51); 100 Mbps × 2 micro-USD is 200 (P3-S01).

**Exact line accumulator (ELA).** A usage line's bytes `X` is a sum of integers (records
within one minute) and of fractions `b × t_i / D` (a spread record's part: bytes `b`,
milliseconds active in the minute `t_i`, total active milliseconds `D`, POL-13). Summing
fractions with different denominators exactly would grow without bound, so the
accumulator keeps:

- `S`, an unbounded integer: the whole bytes;
- a map `d → r_d` with `0 ≤ r_d < d`: for each reduced denominator `d`, the sum of the
  numerators of fractions with that denominator, whole multiples of `d` carried into `S`.

`X = S + Σ_d r_d / d` exactly. Adding a fraction is O(1) (a gcd, an add and a carry), and
the result is the same in any order, because addition of exact rationals commutes
(P3-N3). The charge `⌊price × X / 10¹⁵⌋` is evaluated by **verified interval
arithmetic**: lower and upper bounds of `price × r_d / d` in 128-bit fixed point (64
fractional bits), summed; if `⌊lower⌋ = ⌊upper⌋` that is the answer, otherwise (a sum
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
acknowledge only once it is durable in two regions. **Partition**: one per exporter,
hosted many to a replicated-log group. **Capability**: usage ingestion, 99.99% per
serving region, RTO 1 min (POL-06).

#### 3.1 The flow-record ingestion protocol (contract owned here, RFC-000 §8)

Routers export over UDP, which has no acknowledgement; producing records is out of scope
(P3). The protocol below is what an **exporter**, the sender Share accounts records to,
must speak. A router able to export reliably may speak it directly; otherwise a relay
next to it (operated by network operations) speaks it on the router's behalf and *is*
the exporter of record. The assumed source is reliable (P3 constraints): nothing is lost
before it reaches the exporter, and the exporter retransmits until acknowledged.

| Element | Semantics |
|---|---|
| Session | Mutually authenticated TLS to the ingestion edge of either serving region. The credential names one **exporter ID**; every message on the session is accounted to it (X1-N1, RFC-005). An unauthenticated session is not accepted and creates nothing |
| Export message | One IPFIX message (or NetFlow v9 packet) **verbatim**, header included: observation domain (source ID), 32-bit sequence number of its first data record, export time (seconds), and the exporter's **system init time** (IPFIX information element 160 `systemInitTimeMilliseconds` in an options record, or for NetFlow v9 derived as header `unix_secs × 1000 − sysUpTime`). Data records carry at least flow start and end times (milliseconds, absolute or relative to system init), an octet count, the observation point (interface), direction and the attribution key fields of §4.1 |
| Batch | Up to 1 MB (est.) of messages with a sender-chosen batch number, used only to correlate the acknowledgement |
| Acknowledgement | Sent per batch only after the ingestion log entry holding it is committed (durable in two regions, X2-S14). Lists, per message, how many records were **accepted**, how many were **duplicates** of records already accepted, and each **rejected** record with its reason. All three outcomes are durable; an acknowledged batch never needs resending |
| Retransmission | The exporter keeps every message until acknowledged and resends it **verbatim**, to either region, after `ingest_retry_timeout` (2 s, est.). Verbatim matters: a record's identity (§3.2) is computed from the message it was exported in |
| Flow control | Credit based per session; an exporter that runs out of credit buffers. The edge never drops a batch it has taken credit for |
| Correction message | Carries a corrected record and the **raw reference** of a rejected record it corrects (§3.3) |

The probe of usage ingestion (X2-S18) sends one record from a designated probe exporter
and succeeds on its acknowledgement within 1 s.

#### 3.2 Record identity (P3 open question 1, decided here)

A record's identity is **(exporter ID, observation domain, epoch, extended sequence)**,
refining RFC-000 §4.4's (exporter, exporter epoch, sequence number).

- **Epoch.** The exporter's system init time is constant for one boot of its counters and
  differs after a restart. Each exporter partition keeps an **epoch table** (log entries):
  a message whose init time is within `epoch_jitter` (2 s, which absorbs NetFlow v9's
  whole-second `unix_secs`) of a known epoch's init time belongs to it; any other opens a
  new epoch, numbered in order. Two restarts within 2 s of each other are impossible for
  a real exporter (a boot takes longer). A message with no usable init time is rejected
  "no epoch".
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
| **Rejected**, with reason | `no exporter` (no observation domain or source ID, or one not registered to the session's exporter), `no sequence number`, `no epoch`, `negative byte count`, `end time before its start time`, `missing flow times`, `flow time in the future` (end later than acceptance time + `future_skew_max`, 5 min, est.), `unparseable` | The record is kept verbatim with its reason; its identity, if it has one, is **not** added to the range set; nothing flows on and nothing is charged (P3-S28) |

Validation is per record. A rejected record never delays the records after it: the rest
of its batch is accepted or deduplicated in the same entry, as if it had not arrived
(P3-S29). A record with zero bytes is accepted (it charges nothing).

**Corrected records (P3-S30).** A rejected record can be corrected by a **correction
message** from the same exporter (its own principal; Requirements issue RQ3-2 asks
whether an operator role is also needed), naming the rejected record's **raw reference**
(exporter partition, log position, index). The correction is validated like any record
and has its own identity: the original's identity if it had one, else
`(exporter, "correction", raw reference)`. The partition keeps the set of raw references
already corrected; a correction for a reference already corrected, or whose identity is
already accepted, is a duplicate. So a correction submitted any number of times is
charged once. The correction entry records the principal and the raw reference, so a
recomputation sees it as the decision P3-N9 lists ("corrected records").

**Accepted records are never altered or removed (P3-S31).** There is no command that
changes or deletes a log entry. Sealed segments are written to object storage under a
retention lock for 7 years (compliance mode: no principal, operators included, can
shorten it). An attempt through the operator console to alter or remove a record is
refused there and recorded as a refused privileged attempt (RFC-005, X1-N8).

#### 3.4 Entries and state of an exporter partition

| Entry | Contents | Written when |
|---|---|---|
| `batch` | Session, edge region, acceptance timestamp, the messages verbatim, and per record its outcome (accepted, duplicate with digest, rejected with reason) | Each batch, group-committed |
| `epoch-opened` | Epoch number, init time, first export time | A message with a new init time |
| `wrap-opened` | Epoch, `k`, `t_k` | §3.2 |
| `correction` | Raw reference corrected, the corrected record, its outcome, the principal | A correction message |
| `identity-conflict` | Identity, both digests, positions | §3.5's verifier finds a duplicate whose content differs |
| `sealed` | Segment ID, position range, object-storage location, checksum | A segment is sealed (§3.7) |
| `checkpoint` | Snapshot reference of the derived state below | Every 10 s of log or 256 MB (est.) |

Derived state (in memory, rebuilt from the latest checkpoint plus the log tail): the
epoch table and wrap anchors, the **identity range sets**, the set of corrected raw
references, and a 24-hour **digest cache** (identity → 64-bit content digest) on local
disk.

#### 3.5 Deduplication for 7 years: per-exporter range sets

For each (exporter, observation domain, epoch) the partition keeps a sorted set of
disjoint closed intervals `[lo, hi]` of extended sequence numbers already accepted. A
batch's records are mostly consecutive sequences, so checking and inserting a message is
one O(log n) search and at most one merge. The set's size is the number of **gaps**, not
of records: a gap exists while a reordered record is still in flight (it closes when the
record arrives) or permanently where a record with an identity was rejected (rare). After
an epoch ends (its exporter restarted), its set usually compacts to a few intervals.

| Item | Estimate |
|---|---|
| Records over 7 years | about 5.7 × 10¹³ (260,000/s, RFC-000 §6) |
| Exporters, observation domains | 10,000 exporters, 4 domains each (est.) |
| Epochs over 7 years | about 50 per domain (restarts, est.) → 2 × 10⁶ epoch sets |
| Intervals | about 10 per set on average (rejects with identities, est.), plus up to a few thousand per live set for reordering → about 2 × 10⁷ |
| Memory | 32 B per interval → about 640 MB in all, about 5 MB per ingestion group (128 groups, est.) |
| Safeguard | A set above 10⁶ intervals (a misbehaving exporter) spills to an on-disk ordered store keyed by `(epoch, lo)`; checks then cost one disk read per message, and an alert is raised |

The range sets are kept for the life of the system, not only 7 years: they are small, and
keeping them means a redelivery after the retention period is still a duplicate.

**Duplicate content check.** A duplicate's digest is compared, asynchronously and off the
acknowledgement path, with the original's: from the digest cache when the original is
younger than 24 h (est. about 4 GB per group on disk), otherwise by reading the original
from its sealed segment (§3.7). A mismatch means two different records share an identity,
which only a protocol violation can cause; the duplicate is then re-recorded as an
`identity-conflict`, kept in full, routed to quarantine with reason "identity conflict",
and alerted. It is never silently treated as the original (P3-N3, P3-N7).

#### 3.6 Topology, throughput and recovery

- **Voters.** RFC-000 §5.1 leaves ingestion's voter count to this RFC and RFC-006. This
  RFC proposes the standard **2 + 2 + 1**. The three-voter alternative saves 40% of the
  copies of the *live tail* only (sealed segments are kept twice either way, RFC-000
  A0-16), which is hours of data, and costs ingestion its tolerance of a second fault after
  a facility loss, against a 99.99% target equal to admission's (Competition).
- **Groups.** 128 groups (est.), exporters assigned by hash with hot exporters placed
  alone. Peak load per group about 4,700 records/s, about 0.5 MB/s (est.); a group commits
  every 5 ms.
- **Acknowledgement latency** (est., p99): edge 5 ms + forward to the leader up to 10 ms
  (an R2 edge, R1 leader) + two-region commit 25 ms + response = **about 45 ms** steady;
  about 90 ms after a region loss (RFC-000 §3 quorum table). The probe limit is 1 s.
- **Throughput.** 600,000 records/s is 60 MB/s of raw records (100 B each, RFC-000 §6),
  about 300 MB/s of replication traffic at five copies; neither is near a limit.
- **Recovery.** A leader failure elects a follower in seconds (RTO 1 min, X2-S10); the
  new leader has every committed entry, so nothing is rebuilt. Exporters resend
  unacknowledged batches, which the range sets deduplicate. Ingestion may lag (credit runs
  out, exporters buffer), but an accepted record is never lost (X2-S02, X2-S09, X2-S12).
- **Independence.** Ingestion reads nothing but its own log and the exporter credential
  cache: no reservation, provisioning, catalogue or rating state (RFC-000 §2).

#### 3.7 Retention and evidence

Every 15 minutes of an exporter's log (est.) is **sealed** into a columnar segment in
object storage replicated in two regions (RFC-000 A0-16), compressed (est. 30 to 50 B a
record against 100 B raw). Within a segment, records are sorted by (observation point,
attribution key, flow start), with per-block minimum and maximum statistics and a sparse
identity index (epoch, sequence range → block). The segment keeps every outcome:
rejected records with their reasons and duplicate entries too. Storage over 7 years:
about 5.7 PB per copy raw, about 2 to 3 PB per copy compressed (est.).

**Evidence retrieval (P3-S39).** "The traffic of reservation r, or of link L, in minutes
[a, b)" is answered as follows. The binding history (§4.1, kept 7 years) gives, for r,
its attribution keys and their observation points over [a, b), and for L its observation
points. Those name exporters; the segment index gives their segments whose time range
meets [a, b), plus every later segment that holds an accepted record active in those
minutes (found from the attribution log's minute index while it is retained, and from the
segments' flow-time statistics after). Only the blocks whose key range matches are read.
The answer is every accepted record whose active interval meets [a, b) and whose key and
observation point match, each with its identity and acceptance time. There is no latency
target; a day of one reservation reads a few blocks per exporter-hour (est.). The query
contract is listed in §7.

### 4. Attribution and quarantine

**Component** (RFC-000 §2): decide, for each accepted record, the account, route,
product and reservation it belongs to, which observation point's count is the egress
count, and the class of POL-17 that applies; keep what cannot be attributed in
quarantine. It runs in two stages, both on replicated logs:

| Stage | Partition | Single responsibility | State it owns |
|---|---|---|---|
| **A, binder** | By exporter (one per ingestion partition) | Spread each accepted record over its minutes, bind each part to a provisioning binding, classify it, route it to its account; quarantine the rest | Processing checkpoints (raw position, binding position used); the binding feed as consumed; quarantine entries and their finance attributions; pending-binding holds |
| **B, attribution log** | By account | Record every attributed part of the account, exactly once | The account's attribution log: parts, finance attributions applied, attachment set per product |

#### 4.1 Attribution keys from provisioning (external input; the minimum this RFC needs)

Provisioning (Problem 5) is out of scope; RFC-000 §8 makes its keys an external input
whose minimum this RFC defines (RFC-000 R9). Provisioning publishes a **binding feed**,
ordered and positioned, of facts it never deletes (a binding is ended by a new fact):

| Fact | Contents |
|---|---|
| Observation point | (exporter ID, observation domain, interface index, direction) → link ID (RFC-001's registry), from a time |
| Binding | Key = (observation point, service tag: VLAN or 802.1ad pair, MPLS label or VRF, as configured); valid-time interval `[from, to)`; **account**; **product**; **route** (catalogue route ID); **reservation ID** or none (an account attachment with no reservation, or a best-effort service); **egress**: whether this observation point is where traffic on this binding, in this direction, leaves the route |
| Correction | A binding fact superseded, with the time it was recorded |

Each fact carries its recorded-at time, so the feed is bitemporal, and attribution
records the **binding position** it used for every decision, which makes attribution
reproducible (P3-N9). The contract requires that a binding be published **before** the
network carries traffic on it (Risks, R3-4). Stage A writes every fact it consumes to its
own log, so the binding history is kept 7 years.

Egress (P3-N13, POL-17): for each direction of a route, exactly one observation point is
the egress, normally the last Share-metered point before the traffic leaves the route.
When the route's last leg is a partner link that Share does not meter, the egress is the
hand-off point to that partner (Requirements issue RQ3-7).

#### 4.2 Stage A: spread, bind, classify

Stage A's leader consumes its exporter's raw record feed in log order. For each accepted
record (and each accepted correction):

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
| **Probe** | The exporter, the observation point's link or the binding's account is designated probe in the catalogue (POL-06) | Kept as evidence; never sent to rating; never quarantined or reported (X2-S20) |
| **Non-egress** | A binding matches, but the observation point is not its egress | Sent to the account (stage B) as evidence only; it never counts in any charge (P3-S49) |
| **Reservation binding** | A binding with a reservation ID matches, at its egress | Sent to the account; rating decides covered, burst, excess or outside (§5.3) |
| **Attachment** | A binding without a reservation matches, at its egress, on a guaranteed product | Traffic outside any reservation (POL-17), usage priced (§5.3) |
| **Best-effort** | A binding of a best-effort product matches, at its egress | Usage priced (§5.3) |
| **Unattributable** | No binding matches, or two do (a provisioning error, alerted) | Pending-binding hold, then quarantine (below) |

5. **Route** each attributed part to its account's stage B partition, in a batch per
   account, carrying (stage A partition, term, raw-position range, binding position) as
   the feed identity, and per part: record identity, acceptance time, minute, bytes (an
   exact fraction), class, account, product, route, reservation ID, observation point and
   link.

Stage A appends a `processed` entry (raw position reached, binding position used, the
quarantine and pending changes below) **before** sending the batches that entry
determines, so a new leader resends exactly the same batches (they are deterministic in
the raw records and the binding position).

**Pending-binding hold.** A part with no binding is held, not quarantined at once, until
the binding feed's position is known to cover the part's time plus `binding_grace`
(5 min, est.): provisioning heartbeats advance the position. If a binding arrives in that
time the part is attributed normally; its attribution lag is then over 10 s and is
reported as a breach (§5.9), which is correct, since headroom did not see it in time. At
the end of the hold it is quarantined. Unattributable traffic belongs to no account, so
the hold delays no account's headroom.

**Stage A watermark.** Every stage A partition publishes, with each batch and on a 1 s
heartbeat, its **attribution watermark**: the acceptance time through which its raw log
is fully processed (pending-binding parts excepted). Rating uses the minimum over all
exporter partitions to close usage minutes (§5.6). An idle exporter's watermark follows
its partition's clock.

#### 4.3 Stage B: the account's attribution log

The account's partition appends each batch from stage A unless its feed identity is at or
below the **producer watermark** it keeps for that stage A partition ("applied through
raw position p"), so redelivery and resends are dropped (RFC-000 §4.4, feed events). Per
account the watermarks number the exporters the account's traffic crosses (tens, est.).
Stage B also applies finance attributions from quarantine (§4.4) by the same mechanism,
and keeps the account's **attachment set**: the products for which the account has a live
binding, from the binding feed, which defines the "one per account and product" set of
POL-14 (§5.9).

The attribution log is the input of rating. It is kept hot for `dispute_window` + 7 days
and then archived by history (RFC-006). It can always be recomputed from the raw records
and the binding history, so it is not the 7-year evidence store; §3.7 is.

#### 4.4 Quarantine

A quarantine entry, in the exporter's stage A partition, holds: the part (record identity,
minute, bytes), its observation point and therefore its **link and supplier** (via the
link registry), the reason ("no binding", "ambiguous binding", "identity conflict"), and
the time it was quarantined. Traffic is quarantined, not charged (P3-S26).

**Reports.** Quarantine entries feed a **quarantine report feed** (§7): to operations per
entry, aggregated per link and minute; and to each supplier for its own links, aggregated
per link and minute, with no buyer data (there is none to show; POL-33). Reporting and the
notifier deliver them (RFC-004, RFC-006). Probe traffic is never quarantined, so never
reported (X2-S20).

**Finance attribution (P3-S27).** An operator in finance (POL-32) sends, through the
operator console with the operator action envelope (role, reason; RFC-005), an
**attribution command**: a source reference (POL-29), a selector of quarantine entries
(exporter, observation point, key, minute range) and the target: account, product, route
and, optionally, a reservation ID. Stage A validates it in one entry:

- every selected entry's minute must be within `dispute_window` of the attribution:
  `attributed_at < m + 60 s + dispute_window`, the window measured from the end of the
  traffic's minute (RQ3-6); if any is not, the whole command is refused and nothing is
  attributed (P3-S27, second row);
- an entry already attributed is not attributed again (first attribution wins; RQ3-3);
- a repeat of the same source reference returns the first result.

Accepted, the entry is marked attributed (with operator, reason and reference) and its
parts go to the account's stage B like any attributed part, classed by the target (a
reservation ID gives the reservation class). Rating then charges them at the price of the
traffic's minute (P3-S27, first row) and settlement pays the supplier its split (RFC-004).

#### 4.5 Throughput and recovery

| Item | Estimate |
|---|---|
| Parts | About 1.5 per record (60 s flows that straddle a minute boundary), so about 900,000 parts/s at peak, about a third of them at an egress |
| Binding state | About 10⁷ bindings (est.), about 1 GB per stage A replica, in a hash map keyed by (observation point, tag, direction) with the valid intervals per key |
| Stage B write rate | About 300,000 egress parts/s at peak, as about 10,000 batches/s (est.), spread over 256 account groups (est.) |
| Latency, acceptance → stage B committed | Feed tail 20 ms + bind < 1 ms + hop 5 ms + commit 25 ms ≈ **50 ms** p99 steady (est.); about 120 ms after a region loss |

Both stages have **hot standbys** (RFC-000 §2): their followers apply the log and keep the
binding state and the in-memory structures current, so a takeover is an election, about
**5 s** with a 2 s leader lease (est.), well inside the 30 s RFC-000 assumes. Nothing is
lost on takeover: stage A resumes from its last `processed` entry and resends; stage B
drops what it already has.

### 5. Rating

**Component** (RFC-000 §2): turn reservation history, attributed traffic and price
history into charge lines and amendments, exactly once and reproducibly; feed unposted
usage to the account owner. **Partition**: by buyer account; 256 groups (est.), each
leader co-located with its account's stage B leader. **Capability**: rating and posting,
judged by timeliness (2 min, `max_lateness` + 2 min), RTO 5 min ceiling, designed for a
takeover in about 5 s (est.).

#### 5.1 Inputs, entries and state

Rating's state machine is deterministic in its inputs. The leader chooses the order in
which input batches are applied and records it, so every follower and every recomputation
applies the same inputs in the same order.

| Input | From | Used for |
|---|---|---|
| Reservation lifecycle feed, with its closed time (§7) | Account owner (RFC-002) | Parts, prices, effective minutes, ends, fees shown, moves, partner-leg affected status, probe account |
| Link schedule feed: affected flags | Link schedule owners (RFC-001) | Affected marks on reservation lines (P3-S10) |
| Attribution feed | Stage B (§4.3) | Attributed parts |
| Attribution watermarks | Stage A (§4.2) | Usage minute closure |
| Catalogue feed | Catalogue (§6) | Prices, price corrections, `usage_rate_cap`, probe designations |
| Posting acknowledgements | Settlement (RFC-004) | Which lines are posted, at which ledger position |
| Usage-applied acknowledgements | Account owner | When an unposted-usage figure was counted in headroom |

| Entry | Contents |
|---|---|
| `inputs` | For each input feed, the position applied through, in the order applied |
| `accrual-closed` | Account, minute `m`, and the reservation lines for `m` (reservation, amount, affected marks), run-length encoded across minutes |
| `usage-closed` | Account, minute `m`, the usage lines for `m` (product, route, amount) and the Share-borne cost lines for `m` (§5.5) |
| `amendment` | Line reference, amendment sequence, amount, reason, trigger reference |
| `fee` | Fee line or Share-borne fee line (§5.4) |
| `emitted` | The charge-line batch identity sent to settlement |
| `breach` | Lateness or attribution-lag breach reports (§5.9) |
| `checkpoint` | Snapshot reference |

Derived state per account (in memory on leader and followers):

- the **reservation model**: for each reservation its route, product, legs, window, and
  for each part its rate over effective intervals and its price over minutes (§5.2), its
  end, end cause and fees shown;
- the **accrual watermark** per reservation: lines emitted through minute `m`;
- for each **open usage minute** (not yet closed), an ELA per reservation (egress bytes of
  the reservation class) and per (product, route) (attachment and best-effort classes);
- for each **closed usage line** of the last `dispute_window` + 7 days, its ELA and its
  emitted total; older closed lines keep only their emitted total and a pointer to their
  parts (an amendment for them is rare and reads the parts back from the archived
  attribution log or recomputes them from raw records, §5.10);
- per line, the **acknowledged posted total** and the ledger position of its last
  acknowledgement.

#### 5.2 Reservation accrual (P3-N1)

The account owner owns reservations and their parts (RFC-002 applies POL-08's and POL-07's
rules: last in, first out on a decrease; newest Mbps first on a permanent reduction). The
lifecycle feed carries the **part-level** result of every change, so rating charges what
the account owner decided and does not reimplement those rules. Rating checks the
last-in-first-out invariant on every decrease (P3-S46) and alerts on a mismatch.

**Active minutes.** A reservation's first active minute is
`max(window start, floor_min(decision timestamp))`; a part minute is a whole minute
(P3-S02: confirmed at 10:05:40 starting now, 10:05 accrues). Its active minutes end
(exclusive) at the effective minute of its end: a cancellation's next minute boundary
(P3-S04: at 10:29:20, effective 10:30), a termination's (P3-S42: at 10:15:30, so
[10:00, 10:16) accrues), a release's at the end of `suspension_grace` (P3-S09; the
reservation accrues every minute of the grace, unchanged by the suspension), a
revocation's at the end of its notice (P3-S08), or the window's end (P3-S03:
[10:00, 10:01) accrues 200 in all). An ended reservation is never refunded what it
accrued (P3-S42).

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
   price_notice))`, a part locked before that version took effect is re-priced to it
   (P3-S07: announced 09:00:20 on day D, effective for the reservation from 09:01 on
   D + 30). The re-pricing applies to every part of the reservation (RQ3-5).
3. After a **move to an equivalent path** (POL-07), from the move's effective minute, each
   part is charged `min(its price, the path's price)`, the path's price being the one
   shown in the offer, carried in the lifecycle feed (P3-S59).
4. A **price correction** (§6.3) that covers the reservation, its part and the minute
   replaces the result of 1 to 3 for that minute.

**Affected marks (P3-S10).** An unplanned outage changes nothing in the accrual: every
minute keeps accruing. The link schedule feed's affected flag for (reservation, minute,
leg), and the lifecycle feed's partner-leg affected status, become **affected marks** on
the reservation line, published in the charge-line feed as annotations (no amount, no
amendment), whenever they arrive, for SLA credit (Problem 6).

**What never accrues.** A planned maintenance booking is a link schedule entry, not a
reservation, so it never reaches the reservation model and no line or settlement exists
for it (P3-S47, POL-07). The probe account's reservations produce no lines (POL-06).

#### 5.3 Usage-priced lines: each kind of traffic by its rule (P3-N6, P3-N13)

For account `a` and minute `m`, rating applies POL-17 to the egress parts of `m`:

| Parts | Rule | Result |
|---|---|---|
| Reservation class, reservation `r` **active at m** | Let `B` = the ELA of `r`'s egress bytes at `m` and `A = rate_r(m) × 7,500,000` bytes (reserved rate × 60 s ÷ 8). Within `A`: covered by the accrual, no charge (P3-S22). Above `A`, `B − A`, exactly: **burst** if the product permits it, added to the usage line (a, product, route, m) at `usage_price` (P3-S23: 1.75 GB − 0.75 GB = 1 GB, 10,000 micro-USD); **excess** if not (§5.5) | Measured per minute, not per second: 200 Mbps for 30 s and nothing for 30 s is 0.75 GB, no charge (P3-S54) |
| Reservation class, `r` **not active at m** (before it starts, after it ends) | Outside an active reservation | All bytes to the usage line (a, product, route, m) (P3-S53: a flow 11:59:30 to 12:00:30 on a reservation ending 12:00 has its 0.5 GB at 11:59 covered and its 0.5 GB at 12:00 charged 5,000) |
| Attachment class | Outside an active reservation | All bytes to the usage line (P3-S25) |
| Best-effort class | Best-effort | All bytes to the usage line |
| Non-egress, probe | — | Nothing (P3-S49: three legs report 1.00, 0.99 and 0.98 GB; only the egress 0.98 GB is charged, 9,800 micro-USD) |

A usage line is one account and product on one route for one minute (POL-11), however
many reservations, attachments and records contribute to it, priced at
`usage_price(product, route, m)` as it stood for that minute, corrected (§6.3), whenever
its records arrive (P3-S20). One account's traffic on two routes in one minute is two
lines, each rounded once and each split by its own route (P3-S48). A part in a minute
after a price change is priced at that minute's price (P3-S52: 0.5 GB at 10,000 and
0.5 GB at 13,000).

Traffic above the reserved rate that the edge dropped never appears in an egress record,
so it is never charged (P3-S24); every record is still kept (§3).

#### 5.4 Fee lines (P3-N12)

The lifecycle feed carries, for each reservation, each **fee shown at booking**
(fee ID, amount, partner link, and the term while it applies: until the end of the
partner's minimum term, or, for a plain cancellation fee, until the window ends, or at
any time for an open-ended reservation) and, at its end, the **end cause**: cancelled by
the account (including a shorten to the next minute boundary, and a support operator's
change at the account's request, POL-08, POL-32), released (POL-16), terminated (POL-30),
revoked (POL-07), cancelled by the holder after a rate cut under POL-07, or ended at its
window's end.

At the end, for each fee shown whose term still applied at the end's effective minute:

| End cause | Line |
|---|---|
| Cancelled by the account, released, terminated | **Fee line** charged to the account: exactly the shown amount, not rounded, not split, wholly the partner's (P3-S11 first row, P3-S43 first row, P3-S44 rows 1 and 2, P3-S60: 0.500000 USD is 500,000 micro-USD) |
| Revoked; cancelled after a POL-07 rate cut | **Share-borne fee line**: the same amount, paid by Share to the partner, not charged to the account (P3-S44 rows 3 and 4) |

A fee whose term had ended is not due (P3-S43: cancelled after 31 days of a 30-day
minimum term, nothing). A fee the partner imposes that was **not shown** is never charged
to the account; it is a Share-borne fee line for the partner's fee per the partner terms
in force at booking (P3-S11, second row). A partner booking left without Share's
confirmation and cancelled because its request was withdrawn or failed (POL-28) gives a
Share-borne fee line keyed by the request, from the account owner's residue event (§7;
AI3-4).

Each fee or Share-borne fee line has the source reference (reservation or request, fee ID)
and is decided once, in one `fee` entry, however often the end is processed (P3-S60). A
shorten that moves the end inside the partner's minimum term is treated as a cancellation
of the remaining part (POL-08) and makes the fee due (RQ3-4).

#### 5.5 Share-borne cost lines

Two costs Share bears are amounts that only rating can compute, per minute, so rating
emits them on the charge-line feed as **cost lines**, distinct from charge lines: they
charge no buyer. Settlement pays each as POL-23 says: split by Webster among the route's
parties, each supplier paid its share from Share's own account, no commission share
posted (RFC-004).

| Cost line | Key | Amount |
|---|---|---|
| **Carried excess** (POL-17) | (account, product, route, minute) | The usage line the excess would have made: `⌊usage_price × Σ (B − A) / 10¹⁵⌋` over the minute's reservations of a product without burst whose egress bytes exceed `A` (P3-S41). An **incident** is raised to network operations through the alert feed (RFC-006), one per reservation and run of consecutive excess minutes, updated while it lasts |
| **Dearer equivalent path** (POL-07) | (reservation, minute) | `⌊Σ_p rate_p × path price / 10⁶⌋ − the reservation line's charge`, when positive: what the path would have charged, rounded once, less what was charged (P3-S59: 100 × 3 − 200 = 100; 0 on a cheaper path). RQ3-8 |

Cost lines are amended like charge lines (late excess records raise the excess cost line;
a price correction changes both).

#### 5.6 Closure: when a line is first emitted

A line's **original** is emitted when its minute is **closed** for the account, by one
entry; everything rating applied before that entry is in the original, everything after
it is an amendment. Because the account's state machine is serial, a record arriving
while its minute is being charged is either before the closing entry or after it, never
both and never neither (P3-S17); no lock is needed (Competition: D26).

**Reservation minute `m`** closes when the account's **lifecycle feed is closed through
`m + 60 s`**: no entry not yet published can affect a minute before `m + 60 s`. Every
reservation fact takes effect at or after the minute containing its deciding entry
(confirmations from `floor_min`, every change and end from a later boundary), so this is
the account owner's ordinary closed time, provided its entry timestamps stay monotone
across leader changes and a closed time is never published past an uncommitted entry
(AI3-2). Rating closes `m` at the first `inputs` entry after that, about 0.5 s after
`m + 60 s` (est.: closed time published every 200 ms, RFC-000 §4.6). Prices for `m` were
fixed at least `price_notice` earlier, or are a correction, which amends.

**Usage minute `m`** closes at the later of `m + 60 s + max_lateness +
usage_close_margin` (15 s, est., which covers the 10 s of attribution lag) and the moment
the minimum attribution watermark over every stage A partition (§4.2) reaches
`m + 60 s + max_lateness`; but in any case by `m + 60 s + max_lateness + 90 s`, so a
stalled exporter partition cannot delay every account's charges past the timeliness
target. Records of that partition that arrive later are amendments.

So the original usage line holds every record accepted within `max_lateness` of its
minute (POL-14, X2-S13), and amendments for "late traffic" are only for records that
really arrived late. The reservation activity a usage minute depends on was closed about
3 minutes earlier.

**Per-reservation accrual watermarks.** Each reservation's lines are emitted in strictly
increasing minute order, one for every active minute, never skipping; the watermark
"emitted through minute m" is all rating needs to never emit an original twice, and it is
what lets the ledger deduplicate originals by a watermark per reservation rather than by
an index over 2 × 10¹⁴ references (RFC-000 §4.4). About 63 M live watermarks at the design
load (RFC-000 §6), 16 B each: about 1 GB across all partitions, held in memory. Usage
lines are closed in increasing minute order per (account, product, route); a usage line
first created after its minute closed (a quarantine attribution, a very late record) is a
**late original**, which the ledger keeps in its exception set.

#### 5.7 Amendments (P3-N8)

**The amendment rule.** For each line, rating keeps its **emitted total** `E` (the original
and every amendment emitted). When an input changes the line's exact value, the new
charge is `C = ⌊V_new / 10⁶⌋` (§2), and if `C ≠ E` an amendment of `C − E` is emitted, with
the next amendment sequence and a reason. The original is never changed (P3-S32: 10,000
charged, a late 1 GB, an amendment of 10,000 to a total of 20,000; 75,000 bytes charged 0,
75,000 more, exactly 1.5, amendment 1). Because each amendment restates the line's total,
the sum of a line's postings is always `⌊exact value of everything known⌋`, whatever the
order and grouping of the inputs (P3-S15).

| Trigger | Reason recorded | Direction |
|---|---|---|
| Late records (attributed parts after the line's closure) | "late traffic", with the record identities | Only up: adding bytes never lowers an exact value, so never lowers its floor (P3-S33). A repeat of a record already charged never reaches rating (§3.5), so it amends nothing (P3-S16) |
| A price correction (§6.3) | "price correction", with the correction's ID, the operator, the cause (Share, a named supplier, other) and the reason | Either way for a usage price (P3-S34: −50,000; P3-S55: +20,000); only down for a locked reservation price (P3-S56) |
| A finance attribution of quarantined traffic | "quarantine attribution", with the operator, the reason and the reference | Up |
| An accepted correction of a rejected record | "corrected record", with the raw reference | Up |

**Batching.** Late records for one line are gathered into at most one amendment per
`amendment_interval` (60 s, est.); each other trigger gives its own amendment, so every
amendment has exactly one reason. A correction that covers many lines (a route's price for
30 days) is applied line by line in minute order, paced so that its amendments do not
crowd out originals, and its progress is reported to the operator.

**Splitting.** Rating labels each amendment with its reason and, for a price correction,
its cause; how it is split (POL-12: on its own after a correction borne by Share or a
supplier at fault, otherwise the split of the new total less the shares posted) is
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

Rating appends the line to its own log **before** emitting it, then emits the account's
lines as one **charge-line batch** per account and closure tick (about one a minute per
account: the reservation lines of the minute just closed, the usage lines of the minute
closed about four minutes after its end, amendments and fees), which settlement posts as
one movement per account and minute (RFC-000 §6). Emission is at least once and repeated
until settlement acknowledges the batch; the ledger deduplicates each line by its source
reference, dropping a line already posted with the same contents (RFC-000 §4.4, A0R-10).
So however charging is repeated, interrupted or restarted, each reservation minute, each
record and each fee is charged once (P3-S12, P3-S13): the line's identity and amount are
fixed in rating's two-region log before it leaves.

#### 5.9 Usage exposure inputs to headroom (P3-N10)

Rating publishes, per account and product in the account's attachment set (§4.3), the
two parts of usage exposure (POL-18, POL-14), on the **unposted-usage feed** (§7):

- **Unposted usage** = `Σ over the account's usage lines L of the product of
  max(0, ⌊V(L)/10⁶⌋ − P_X(L))`, where `V(L)` is the line's exact value from every part
  rating has applied (records accepted and attributed, open minutes included) and `P_X(L)`
  is what settlement has acknowledged as posted for `L` through **ledger position X** of
  the account's ledger partition. Each figure carries X. The `max(0, ·)` keeps a downward
  correction from being counted before its credit is posted. P3-S37: 0.2 GB at
  10,000 micro-USD/GB is 2,000 micro-USD.
- **Lateness bound** = `usage_rate_cap × (max_lateness + attribution_lag_max + 60 s) ×
  the product's highest usage_price on any route`, rounded up to the micro, with the
  highest price taken over prices in force from now to the end of that interval (so a
  rise announced within it is covered). P3-S37: 100 Mbps × 250 s = 3.125 GB at 10,000, so
  31,250 micro-USD; usage exposure 33,250.
- For information (P4-S16), **accrued reservation charges not yet posted**.

**Exactness with the ledger balance.** The account owner's headroom subtracts unposted
usage from the ledger balance (RFC-004 Part A). The figure is exact against the balance
through position X: what it counts is exactly what X does not contain. The account owner
must never apply a figure with an X beyond the ledger position it has applied (that would
subtract a posting the balance lacks, overstating headroom); with a balance past X, a
usage posting between X and its position is counted twice, which understates headroom,
for at most one publication interval. RFC-004 Part A pairs the two feeds by X (§7).

**Publication.** A figure is published for an account whenever it changes, coalesced to at
most one every `exposure_publish_interval` (500 ms, est.), as absolute values with the
rating position (rating log position and the input positions behind it) and X, so a
consumer applies the latest and ignores older ones. Rating emits a usage line's original
or amendment only after the account owner has acknowledged applying a figure that already
counted it (**publish before emit**), so a posting can never reach the balance before its
traffic was counted in unposted usage.

**Attribution lag (P3-S61, P3-S62, X2-S22).** A record is **counted** when the account
owner applies (its usage-applied acknowledgement, §7) the first figure whose rating
position includes the record's parts. For each published figure rating keeps, per
exporter, the earliest acceptance time and the identity ranges of the records it newly
counts. On the acknowledgement, every record counted more than `attribution_lag_max` after
its acceptance is reported as a **breach** of the usage exposure bound with its exporter,
identity and attribution lag. It is charged like any other record (P3-S62). Rating also
reports, per minute, whether every record accepted in it was counted in time, which is the
X2-S22 measure (RFC-006 aggregates it).

**Lateness (P3-S38).** A record whose acceptance time is more than `max_lateness` after the
end of the last minute it was active in is reported as a breach with its exporter and
lateness, and charged like any late record (the definition of "its minute" for a spread
record is RQ3-9). Probe records are in neither report.

**Latency budget, acceptance → counted** (est., p99, steady): stage B committed 50 ms
(§4.5) + rating applies 20 ms + coalescing up to 500 ms + feed hop 10 ms + the account
owner's entry 25 ms ≈ **0.6 s**; about 0.9 s after a region loss; against 10 s. A takeover
of any stage on the path costs about 5 s (est.), still inside 10 s; a longer outage of
the path produces breach reports, never a silent miss.

#### 5.10 Reproducibility and the cold re-rate (P3-N9)

Every input rating uses is a retained fact: raw records and their outcomes (§3, 7 years);
corrected records (§3.3); the binding history and the binding position of every
attribution decision (§4); finance attributions (§4.4); the reservation lifecycle feed,
from the account owner's log, which records every change, end and its cause, and so every
standing change that ends a reservation (RFC-002, kept 7 years by history); the catalogue's
price history and corrections with who made them (§6); and rating's own log of the order
in which it applied them. Rating's state machine is deterministic, so replaying its log
against those inputs gives the recorded lines, amendments and amounts exactly (P3-S36). A
**re-rater** does this continuously for a sample of account-days, and on demand for any
period, and alerts on any difference.

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
| Unposted-usage figures | At most 2 per second per account with usage traffic: about 100,000/s across all account partitions at 50,000 such accounts (est.) | Each account partition applies at most 2 entries/s |
| Memory per rating group | Reservation models about 200 B each, 63 M / 256 groups → about 50 MB per group; open usage ELAs and 37 days of closed lines' ELAs a few GB per group (est.) | |
| Charge-line batches to settlement | About 1,700 movements/s (RFC-000 §6) | |

RFC-000 R6 (a very large account) is absorbed: an account with 1 M reservations closes
1 M lines a minute (about 17,000/s) in one partition, within one leader's capacity (est.).

#### 5.12 Hot standbys, recovery and timeliness

RFC-000 §2 requires hot standbys on the attribution → unposted-usage → account path and
on the reservation-accrual posting path. Here:

- every partition of stage A, stage B and rating has two followers in other facilities
  that apply the log, tail the same input feeds and keep the derived state current;
- a leader holds a 2 s lease; on its loss a follower is elected and resumes from the last
  committed entry, re-emitting anything not yet acknowledged (idempotent): about **5 s**
  (est.);
- checkpoints every 10 s of log bound a replacement follower's catch-up.

| Target | Design point (est., p99) | With one takeover | Bound |
|---|---|---|---|
| Reservation line posted (X2-S13) | Closure at `m` + 60.5 s, `accrual-closed` commit 25 ms, settlement and ledger about 100 ms: about **1.5 s** after the minute's end | + 5 s per takeover on the path (rating, settlement); + up to 60 s while the account owner fails over (its closed time stops) | 2 min target; 7 min after a zone loss (5 min RTO ceiling) |
| Usage line posted, records within `max_lateness` (X2-S13) | `m` + 60 s + 180 s + 15 s + posting: about **196 s** after the minute's end | + 5 s per takeover | `max_lateness` + 2 min = 300 s target; + 5 min after a zone loss |
| Accepted record counted in headroom (X2-S22) | About 0.6 s | About 5.6 s | 10 s (`attribution_lag_max`) |

A declared region disaster moves every leader to the surviving region (RFC-000 §5.1);
rating's logs are two-region durable, so nothing is recomputed: the affected minutes are
posted late, within their target plus the 1 h regional RTO, none lost or posted twice
(X2-S19, X2-S23).

### 6. Catalogue

**Component** (RFC-000 §2): hold the reference data every other owner prices, splits or
validates against. **Partition**: by entity, on 2 + 2 + 1 logs; small (est. well under
10 GB in all). Its link registry part (links, their supplier and endpoints, Share or
partner, probe flag) is RFC-001's; everything else is specified here.

#### 6.1 Entities and their versions

| Entity | Versioned facts | Validated on write |
|---|---|---|
| Product | Kind (guaranteed, best-effort), permits burst | — |
| Route | Ordered legs (link IDs from RFC-001's registry) | Every link exists |
| Price series (product, route, kind) | `reservation_price` (guaranteed only) or `usage_price` (every product, POL-17) versions: price in pico-USD, `effective_from`, `announced_at`, `oe_effective` | §6.2 |
| Price correction | §6.3 | §6.3 |
| Split weights (route) | Per leg a weight, and the commission's weight, from a minute boundary (POL-12) | Non-negative; legs match the route |
| Partner terms (partner link) | Minimum term, cancellation fee, maximum hold length, whether it accepts an expiry set by Share (POL-26, POL-28) | — |
| Account-product terms | `usage_rate_cap` (POL-14, default 100 Mbps), set at onboarding | Positive, in whole Mbps (AI3-6) |
| Probe designations | Probe accounts, links and exporters (POL-06; semantics RFC-006) | — |

Every fact carries its recorded-at time, the principal and the reason (operator action
envelope, RFC-005), so the catalogue is bitemporal and answers "as known at T" (POL-19).
Who may set prices, weights, partner terms and `usage_rate_cap` is not in POL-32
(RQ3-1); the catalogue accepts them from a principal RFC-005 authorises.

#### 6.2 Price rules (POL-27)

- Every `effective_from` is a minute boundary; a version that is not is refused.
- A `reservation_price` version applies to new bookings and new parts from
  `effective_from`, and to open-ended reservations from
  `oe_effective = max(effective_from, ceil_min(announced_at + price_notice))` (§5.2).
- A `usage_price` version needs `effective_from ≥ ceil_min(announced_at + price_notice)`,
  for every product (POL-27 states it for best-effort prices; POL-14's bound assumes no
  rise within its window for burst prices too; RQ3-10).
- A version is never changed or withdrawn after it is recorded; a mistake in a price is
  fixed by a correction (§6.3).

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
| Window | Any minute of the range ends more than `dispute_window` before the correction is recorded (`recorded_at ≥ m + 60 s + dispute_window`, RQ3-6) (P3-S57) |
| Locked prices only downwards | The corrected price is above any locked price it would replace: for a reservation correction, a part's locked price at a covered minute (P3-S56: 3 refused; 1 accepted, −100 a minute); for a `reservation_price` version, **any** upward correction, since every use of it is a lock |
| Usage prices | Never refused for direction (P3-S55) |
| Repeat | The same source reference returns the first result |

The reservation-price check reads the locked part prices from a read model of the
reservation lifecycle feed that the catalogue keeps for this purpose (AI3-7). Corrections
are bitemporal: a later correction of the same minutes supersedes an earlier one from its
recorded time, and the amendments it causes restate the line against the new price
(§5.7). Rating applies them to lines already posted (amendments) and to lines not yet
posted (their originals use the corrected price).

#### 6.4 Query, feed and availability

- **Feed**: per entity, ordered, every version. Every consumer (rating, attribution, the
  account owner for locked prices and partner terms, settlement for weights, RFC-006 for
  probe designations) keeps a full in-memory replica and records the catalogue position it
  used in every decision, so a decision is reproducible.
- **Query**: "the value of entity E as known at T, effective at minute m", served by
  catalogue replicas.
- **Availability**: no booking, record or charge waits on a catalogue write. Consumers
  decide from their replica; a catalogue partition that is down delays only operator
  changes to it. Writes are rare (est. a few per second).

### 7. Contracts

RFC-000 §8 names the contracts; this section gives the semantics of those this RFC owns
and the guarantees it needs from those it consumes. Schemas and wire formats belong to the
delivery phase.

**Provided.**

| Contract | Kind | Semantics |
|---|---|---|
| **Flow-record ingestion protocol** (RFC-000 §8) | External protocol, to exporters | §3.1. At least once from the exporter, verbatim retransmission; each record's outcome is durable in two regions before the acknowledgement; an acknowledged record is never lost; identity per §3.2; duplicates acknowledged as such; rejections kept with their reason. Probe: acknowledgement within 1 s |
| **Catalogue** (RFC-000 §8; link registry RFC-001) | Query and feed | §6. Ordered per entity, bitemporal, never rewritten; every consumer records the position it used |
| **Unposted-usage feed** (RFC-000 §8) | Asynchronous feed to the account owner, applied as entries in its log (RFC-002); its use in headroom is RFC-004's | Per (account, product): unposted usage, lateness bound, accrued reservation charges not yet posted, all in micro-USD; the rating position; the ledger position X. Absolute values, monotone positions: apply the latest, ignore older. **Never apply a figure whose X is beyond the ledger position applied**; pair by X when possible (§5.9). Each application is acknowledged (below). At most one figure per account per 500 ms (est.). Probe accounts get none |
| **Charge-line feed** (RFC-000 §8) | Asynchronous feed to settlement (RFC-004) | One batch per account and closure tick. Each item: kind (reservation, usage, fee; or cost line: carried excess, dearer path, Share-borne fee), source reference (§5.8), account, reservation or product and route, minute, amendment sequence, amount (signed micro-USD), reason and its details (§5.7), and the catalogue position of its prices and weights; plus affected marks as annotations. Originals per reservation in strictly increasing minutes; at least once until acknowledged; each line idempotent by its source reference (an item resent has identical contents) |
| **Raw record feed** | Internal (ingestion → attribution, history) | The exporter partition's log, in order |
| **Attribution feed** | Internal (stage B → rating) | The account's attribution log, in order |
| **Quarantine report feed** (AI3-5) | Asynchronous feed to operations, reporting and the notifier | Per quarantine entry and aggregated per (link, minute): bytes, observation point, reason; per supplier only its own links; never probe traffic |
| **Breach report feed** (AI3-5) | Asynchronous feed to finance and risk, reporting and RFC-006 | Lateness breaches (exporter, identity, lateness) and attribution-lag breaches (exporter, identity, lag); per minute, whether every accepted record was counted in time |
| **Metered-traffic evidence query** (AI3-5) | Query (storage RFC-006) | §3.7: every accepted record of a reservation or link in a minute range, for the retention period |
| **Operator commands** | Synchronous commands through the operator console (RFC-005 envelope) | Price corrections (§6.3) and quarantine attributions (§4.4), each idempotent by its source reference, refused with nothing changed when invalid; catalogue changes (§6.1) |

**Consumed.**

| Contract | Owner | What this RFC needs from it |
|---|---|---|
| **Reservation lifecycle feed** (RFC-000 §8) | RFC-002 | Per reservation: route, product, legs, window, each part's rate over its effective intervals and its locked price (with the time it was locked), the deciding entry's timestamp, every change's effective minute, the end, its effective minute and its **end cause** (§5.4), each fee shown at booking with its term, moves to an equivalent path with the path's shown price and effective minute, rate cuts under POL-07 (flagged as such), partner-leg affected status, whether the account is the probe account. **Closed time**: a published time T such that no later entry affects a minute before `floor_min(T)`, monotone across leader changes (AI3-2). **Residue events**: a partner booking cancelled for a request not confirmed, with the partner's fee (AI3-4). **Usage-applied acknowledgements**: the rating position of each unposted-usage figure applied, with the entry's timestamp (AI3-3) |
| **Link schedule feed** (RFC-000 §8) | RFC-001 | Affected flags per reservation, leg and minute. Nothing else; maintenance bookings are not reservations |
| **Posting acknowledgements** | RFC-004 (settlement) | Per charge-line batch, once posted: each line's source reference and amount as posted (or "excluded and reported" if the ledger found different contents) and the account's **ledger position** (AI3-3) |
| **Ledger movement feed** | RFC-004 | Used only by the cold re-rate (§5.10): posted totals per line |
| **Attribution keys** (RFC-000 §8) | Provisioning (Problem 5) | §4.1, published before traffic flows |
| **Principal and authorisation context; operator action envelope; audit record** | RFC-005 | Exporter credentials; finance role for corrections and attributions; audit fields in each command's entry |
| **Replicated-log, placement, fencing, closed-position conventions; history; alert feed; probe designation semantics** | RFC-006 | As RFC-000 §8 |

### 8. Parameters

POL parameters are read from the policy register's values as configured; the others are
design parameters of this RFC, changeable without a change of mechanism.

| Parameter | Value | Source |
|---|---|---|
| `max_lateness`, `attribution_lag_max`, `usage_rate_cap` | 180 s, 10 s, 100 Mbps default | POL-14 |
| `dispute_window` | 30 days | POL-17 |
| `price_notice` | 30 days | POL-27 |
| `flow_active_timeout` | 60 s | POL-13 |
| `ingest_retry_timeout`, `epoch_jitter`, `wrap_slack`, `future_skew_max` | 2 s, 2 s, 10 min, 5 min (est.) | This RFC |
| `binding_grace` | 5 min (est.) | This RFC |
| `usage_close_margin`, usage close bound | 15 s, `max_lateness` + 90 s after the minute's end (est.) | This RFC |
| `amendment_interval`, `exposure_publish_interval` | 60 s, 500 ms (est.) | This RFC |

### 9. Design-level acceptance tests

Each cites the scenario it serves (docs/README.md conventions).

| Test | Serves |
|---|---|
| Identity: an exporter restart (new init time), a 32-bit wrap, and a verbatim redelivery of a pre-wrap message a simulated year later; the redelivery is a duplicate, the restarted sequence 7 is new | P3-S50, P3-S14 |
| Range sets: 10⁹ records with 1% reordering and 0.01% identity-bearing rejects; interval count and memory against §3.5 | P3-S14, X2-S04 |
| ELA: random records and spreads against an arbitrary-precision reference, every floor equal; the interval fallback exercised by crafted near-integer sums | P3-S21, P3-S51, P3-S15 |
| Order independence: one set of records delivered in order once, and shuffled with 30% duplicates and 20% after their minute's closure; every line's posted total equal | P3-S15, P3-S32, P3-S33 |
| Closure race: records injected around the closing entry under load; each in the original or an amendment, exactly once | P3-S17 |
| Restart: kill rating leaders mid-batch and mid-emission; then a cold re-rate from inputs and the ledger; no line missing or posted twice | P3-S12, P3-S13 |
| Publish before emit: delay the usage-applied acknowledgement; no usage posting reaches the ledger before its figure is applied; headroom never above the exact value at any applied pair | P3-S61, P4-S16 |
| Attribution lag: stop a stage B leader for 15 s; the records accepted meanwhile are reported as breaches with exporter and lag | P3-S62, X2-S22 |
| Throughput: 600,000 records/s for 1 h with 1 M reservation lines/s; every X2-S13 and X2-S22 target met | X2-S04 |

## Benefits

| Need | How this design meets it |
|---|---|
| Exactly once for records (P3-N3) | One entry per batch checks and inserts each identity; range sets make 7 years of identities a few hundred MB (est.), so the check is in memory at 600,000 records/s; identity survives wraps and restarts by construction |
| Every received record kept (P3-N7) | Every outcome, rejections and duplicates included, in a two-region log before the acknowledgement, sealed under retention lock; no head-of-line blocking |
| Exact charges in any order (P3-N3, P3-N5, POL-11) | Exact rational accumulation (ELA) and one rounding per line; amendments restate the total; verified interval arithmetic keeps exactness cheap |
| Exactly once for lines (P3-N2) | Deterministic source references fixed in rating's two-region log before emission; ledger deduplication per line; watermarks per reservation |
| Amended, never rewritten (P3-N8) | Every change is a new amendment with one reason; late traffic only ever increases a line |
| Reproducible (P3-N9) | Every input retained and positioned; rating's log records the order of inputs; a continuous re-rater checks it |
| Usage exposure within 10 s (P3-N10, X2-S22) | About 0.6 s from acceptance to headroom (est.), 5 s takeovers; exact against the balance by the ledger position X; breaches reported per record |
| Timeliness (X2-S13) | Reservation lines posted about 1.5 s after their minute (est.) against 2 min; usage lines about 196 s against 300 s |
| Ingestion availability (X2-N1) | Ingestion depends on nothing but its own log; acknowledgement in about 45 ms (est.) against 1 s |
| Each kind of traffic by its rule, billed once at egress (P3-N6, P3-N13) | Attribution fixes class and egress from provisioning; rating applies the per-minute rule on exact totals; Share-borne costs computed where the amounts are known |
| Policies as data | Prices, notice, windows, lateness, caps and design parameters are configuration; the mechanism does not change with them |

## Competition

| Alternative | Why it loses |
|---|---|
| **A hash index of every record identity** (prototype primary key) | About 6 × 10¹³ entries over 7 years; even at 16 B each about 1 PB, so not in memory, and every record a random read (RFC-000 §4.4, A0-08) |
| **A Bloom filter for duplicates** | A false positive drops a genuine record silently, against P3-N7 and P3-N3 |
| **Identity by content digest** | Two distinct flows can have identical contents (same keys, times and bytes); counting them once loses revenue |
| **Exporter-supplied 64-bit sequence and epoch** | Simpler, but "unique whatever the exporter's counters do" (P3-N3) would then rest on every exporter's correctness; deriving the epoch from the system init time and the wrap from the export time puts it in Share's hands, with a digest check for violations |
| **A minute lock** (prototype, D26) | Correct only under one isolation level, and a lock per (reservation, minute) at 1 M lines/s. A serial state machine per account gives the same guarantee with no lock: a record is before or after the closing entry |
| **Assigning a flow to the minute it ended** (prototype, D28) | Against POL-13, and it can put more than the reserved rate's bytes in one minute, inventing burst |
| **Rounding each record, or each amendment's own amount** | The total would depend on arrival order (D25); rounding the line's exact total once is the rule (POL-11) |
| **Posting usage lines at the end of the minute and amending often** | Every record arriving 1 s to 180 s after its minute would be a "late traffic" amendment: many more ledger lines and an amendment-heavy bill for traffic that was not late by POL-14. Closing at `max_lateness` stays inside the timeliness target |
| **A stream processor with transactional exactly-once** (Kafka transactions, Flink checkpoints) | A good substrate for stage A, but: its acknowledgement to the exporter is not tied to two-region durability of the record (X2-S14) without an outer log; 7-year deduplication state and the per-account serial order still have to be built; and checkpoint replay re-groups inputs, so amendments would differ between runs unless the input order is recorded, which is what rating's log does |
| **Unposted usage as a stream of deltas** | A lost or repeated delta would skew headroom permanently; absolute values at positions are idempotent and reproducible |
| **Unposted usage without the ledger position X** | The account owner could apply a figure that has already dropped a line whose posting it has not applied, overstating headroom (AI3-3) |
| **Attribution inside ingestion** | Ingestion's 99.99% and 1 s would then depend on provisioning data (RFC-000 §2) |
| **Rating deciding attribution too** | Rating would need the network's keys; separating them lets attribution be replayed from provisioning history alone |
| **Three ingestion voters, one per region** (RFC-000 §5.1 option) | Saves copies of only the live tail; after a facility loss a single further fault stops ingestion, against a 99.99% target |
| **Storing duplicates verbatim** | Doubles storage for an expected few percent of records without adding evidence; a compact entry with a digest keeps every receipt findable and detects conflicts |
| **A separate 7-year postings index for evidence** | About 1 PB per copy (est.); sorting sealed segments by key with block statistics answers the same queries |

## Risks and open issues

| # | Risk | Mitigation |
|---|---|---|
| R3-1 | **Every load figure is an estimate**: records per second, 100 B a record, parts per record, exporters, active reservations, usage lines | RFC-006's load test (X2-S04) at the design profile; the partition counts are configuration |
| R3-2 | **Exporter clocks.** Minutes are assigned by the exporter's flow times; a skewed exporter shifts traffic between minutes, prices and reservations | Per exporter, the gap between export time and acceptance time is monitored and alerted; records too far in the future are rejected (§3.3); the source is assumed reliable (P3) |
| R3-3 | **Byte accounting versus policing.** If the policer counts bytes at another layer than the exporter, a reservation at its reserved rate could appear to exceed it, inventing burst or excess | The protocol fixes the octet count's layer to the policer's (delivery contract); excess incidents (§5.5) surface any mismatch early |
| R3-4 | **Provisioning lag.** A binding published after traffic starts sends that traffic to quarantine, recoverable only by finance attribution | Contract: bindings before traffic (§4.1); `binding_grace`; quarantine volume alerted per link |
| R3-5 | **The account owner's closed time** stops while it fails over, delaying that account's reservation lines (up to 1 min) | Within the 2 min target; measured |
| R3-6 | **A stalled stage A partition** would hold every usage closure | The 90 s bound (§5.6) closes anyway; its late records become amendments |
| R3-7 | **Correction fan-out**: a 30-day route correction amends every line of every account on the route | Paced application; progress reported; bounded by `dispute_window` |
| R3-8 | **Very old usage lines** (a record years late) need their parts read back from archives | Rare by assumption (reliable source); cost is a read of a few segments |
| R3-9 | **Publish before emit couples posting to the account owner** | A usage line waits at most for the account owner's recovery (1 min); within the target |
| R3-10 | **Storage**: about 2 to 3 PB per copy of compressed raw records over 7 years (est.) | Two copies only (sealed segments); columnar compression; RFC-006 confirms |
| R3-11 | **The exactness fallback** could be slow for a pathological line | Bounded by the number of distinct denominators; measured on the load test |

## Requirements issues

None of these blocks the design; each is decided provisionally as stated and raised for
the requirements owner. The requirements are not changed here.

| # | Issue | Provisional reading in this RFC |
|---|---|---|
| RQ3-1 | POL-32 gives no role the setting of prices, split weights, partner terms or `usage_rate_cap`, while X1-N7 requires every operator action to belong to exactly one role | Accepted from a principal RFC-005 authorises; the role is for the requirements |
| RQ3-2 | Who submits a corrected record (P3-S30, P3-N9 "corrected records" as an operator decision)? No role in POL-32 | The exporter itself, by its own credential, through the correction message (§3.3); an operator path, if wanted, needs a role |
| RQ3-3 | No rule for undoing a wrong finance attribution of quarantined traffic | Not possible: first attribution wins; a mistaken one would need a downward correction rule |
| RQ3-4 | Does a shorten that moves the end inside a partner's minimum term incur the shown fee? POL-08 calls a shorten "a cancellation of the remaining part" | Yes, the fee is due, payer as for a cancellation (§5.4) |
| RQ3-5 | POL-27's notice re-pricing of an open-ended reservation does not say whether it applies to every part, including parts added at a later price | Every part, from `oe_effective` of each version that took effect after the part was locked (§5.2) |
| RQ3-6 | `dispute_window` is not anchored: from the start or end of the minute, or from the charge? (P3-S27, P3-S57) | From the end of the traffic's or charge's minute (§4.4, §6.3) |
| RQ3-7 | "The egress (delivered) count" when a route's last leg is a partner link Share does not meter | The last Share-metered point, the hand-off to the partner (§4.1) |
| RQ3-8 | The dearer-path difference (POL-07, POL-23) does not say how it is rounded | What the path would have charged, rounded down once, less the buyer's charge (§5.5) |
| RQ3-9 | "Later than `max_lateness` after the end of its minute" is ambiguous for a record spread over several minutes | After the end of the last minute it was active in (§5.9) |
| RQ3-10 | POL-27 requires notice for best-effort usage prices only; a burst `usage_price` on a guaranteed product could rise without notice inside POL-14's window | Notice required for every `usage_price` (§6.2) |
| RQ3-11 | An accepted record whose contents are wrong (an exporter's error inflating bytes) can never be corrected: P3-N7 forbids altering it, P3-N8 provides price corrections only | Out of the design; a "record dispute" amendment would need a rule |
| RQ3-12 | P3-N10's "until its charge is posted, and no longer" is exact only when the account owner pairs the unposted-usage figure with the ledger position it was computed at; otherwise a posting is counted twice for at most one publication interval (est. 500 ms), conservatively | Exact when paired (§5.9); the requirement may want to state the tolerance |

## Architecture issues

Defects or gaps found in RFC-000 while designing on it. RFC-000 is not changed here;
each is raised for its owner, with the reading this RFC assumes.

| # | Issue | Proposed resolution |
|---|---|---|
| AI3-1 | RFC-000 §2 gives attribution "which billing rule of POL-17 applies", but whether a reservation's bytes are covered, burst or excess, and whether the reservation was active in the minute, depends on the minute's total and the reservation history, which attribution does not have | Attribution fixes the class (§4.2); rating applies the rule (§5.3). Reword RFC-000 §2 |
| AI3-2 | The account owner's closed position (RFC-000 §4.6) is defined for status reads; rating needs an **effective-time closure** on the lifecycle feed: no later entry may affect a minute before the closed time, across leader changes (a carried, late-known confirmation, RQ-5, must not appear behind a published closed time) | RFC-002 and RFC-006 guarantee monotone entry timestamps across leader changes (as A0R-10 does for posting time) and never publish a closed time past an uncommitted entry |
| AI3-3 | RFC-000 §8 has no **posting acknowledgement** to rating (though §3 says rating marks a line posted only once its posting is durable) and no **usage-applied acknowledgement** from the account owner. And it does not say how unposted usage "through a rating position" and the balance "through a ledger position" stay consistent: applied independently, a line can leave unposted usage before its posting reaches the balance, overstating headroom | Add both acknowledgements to §8; carry the ledger position X with every unposted-usage figure, and never apply one beyond the applied ledger position (§5.9) |
| AI3-4 | POL-28 residue fees (a partner booking cancelled because its request was withdrawn or failed) reach no feed rating consumes: the request outcome feed goes to the notifier and the console only | The reservation lifecycle feed carries residue events (§7) |
| AI3-5 | §8 lacks the quarantine report feed, the breach report feed, the evidence query (P3-N11) and the **cost lines** (carried excess, dearer path, Share-borne fees) that settlement needs on the charge-line feed, which §8 describes as charges and amendments only | Add them as owned by RFC-003 (§7) |
| AI3-6 | `usage_rate_cap` has no owner in RFC-000 (the catalogue's state list omits account-product terms) | The catalogue (§6.1); the edge's policing reads it (network operations) |
| AI3-7 | Validating that a locked price is corrected only downwards needs the reservation's locked prices, a dependency of the catalogue on the account owner's feed that §3's diagram lacks | The catalogue keeps a read model of locked prices from the lifecycle feed (§6.3) |
| AI3-8 | The observation point → link mapping (needed to report quarantined traffic to the supplier of the link it crossed, P3-S26, and to retrieve by link, P3-S39) is in no owner's state | Part of provisioning's attribution-key input (§4.1) |
| AI3-9 | RFC-000 §2 sizes the hot standbys' takeover at about 30 s, which alone breaches `attribution_lag_max` (10 s) on every takeover | Takeover about 5 s (§5.12), so most takeovers stay within 10 s; RFC-006's per-minute budget should use it |

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
| P3-S30 | §3.3 (correction message) |
| P3-S31 | §3.3 (never altered; refused attempts recorded with RFC-005) |
| P3-S32 | §5.7 |
| P3-S33 | §5.7 |
| P3-S34 | §6.3, §5.7 |
| P3-S35 | §5.7 (served by reporting, RFC-004) |
| P3-S36 | §5.10 |
| P3-S37 | §5.9 |
| P3-S38 | §5.9 |
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
| X2-S02 | §3.6 (ingestion may lag, loses nothing) |
| X2-S04 | §3.6, §4.5, §5.11; the load test is RFC-006's |
| X2-S09, X2-S12, X2-S14 (accepted usage records) | §3.1, §3.6; topology RFC-006 |
| X2-S10 (usage ingestion; rating and posting rows) | §3.6, §5.12; other rows RFC-001, RFC-002, RFC-004, RFC-006 |
| X2-S11 (accepted usage records) | §3.7; retention RFC-006 |
| X2-S13 | §5.6, §5.12 (posting: RFC-004) |
| X2-S19 | §5.12 |
| X2-S20 (probe exporter records; probe bookings not rated) | §4.2 (probe class), §5.2; probe operation RFC-006 |
| X2-S22 | §5.9, §5.12; the monthly measure RFC-006 |
| X2-S23 (records and charges during a declared disaster) | §5.12; RFC-006 |
| P4-S15, P4-S16 (headroom itemised) | RFC-004 Part A, from §5.9's inputs |
| X1-S12 (finance actions: price corrections, quarantine attribution) | RFC-005; validation in §4.4 and §6.3 |
| Every other X2, X1, P1, P2 and P4 scenario | Not allocated to these components (RFC-001, RFC-002, RFC-004, RFC-005, RFC-006) |
