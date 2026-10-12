# RFC-006. Availability, durability and operations: the platform layer

| | |
|---|---|
| Status | **Draft**, revision 1 |
| Satisfies | X2-S01, X2-S02, X2-S03, X2-S04, X2-S05, X2-S06, X2-S07, X2-S08, X2-S09, X2-S10, X2-S11, X2-S12, X2-S13, X2-S14, X2-S15, X2-S16, X2-S17, X2-S18, X2-S19, X2-S20, X2-S21, X2-S22, X2-S23, X2-S24 (all 24 X2 scenarios, as primary RFC). Contributes the platform, history, notifier and alerting contracts to P1-S26, P1-S33, P1-S40, P1-S50, P1-S54, P1-S62, P2-S04, P2-S09, P2-S10, P2-S22, P2-S23, P2-S51, P2-S53, P2-S93, P2-S99, P2-S104, P2-S106, P2-S107, P2-S108, P2-S111, P3-S31, P3-S36, P3-S39, P4-S23, P4-S54, P4-S71, P4-S72, P4-S80, P4-S81, P4-S90, P4-S91, P4-S104, X1-S11, X1-S14, X1-S15, X1-S24, whose primary RFC is named in the traceability table |
| Policies | POL-04 (`ack_budget`, `status_staleness`, `webhook_retry`), POL-06, POL-07 (`affected_notice_time`), POL-14 (`attribution_lag_max`, `max_lateness`), POL-15 (the probe account's `credit_limit`), POL-16 (notices), POL-18, POL-19, POL-24 (retention pending legal confirmation), POL-26 (`release_grace`, the deadline), POL-29 (7-year identities), POL-32 (operator roles) |
| Builds on | [RFC-000](RFC-000-architecture.md) revision 3.2 (tag `rfc-000-accepted`): §1 principles A1 … A10, §2 components (placement and time, history, notifier, probes), §3 latency budget and leader placement, §4.3 the confirm fence and `ε`, §4.6 positions and read leases, §5 topology, fencing and recovery targets, §6 sizing, §8 the contracts RFC-006 owns, R1, R2, R4, R10, R13, R14, R16. The requirements at tag `requirements-v1.5` |

Terms are used in the sense of the [glossary](../02-specs/glossary.md). "Reserved rate" is
capacity and "traffic" is bytes. Every round-trip time, latency, volume, size and count
below is an **estimate** (marked "est.") unless it is a requirement's own figure; the R1
spike (§20.1) replaces the estimates with measurements. Design parameters that are not
policies (heartbeat interval, lease lengths, seal interval and the like) are named in
`code` and listed in §10.9; changing one changes no mechanism.

## Need

RFC-000 decides the shape: single-writer owners, each partition a single-leader state
machine over a replicated log fenced by its term (A2), every commit through a majority
that spans two regions (A3), five voters per group placed 2 (R1 Nairobi) + 2 (R2 Mombasa)
+ 1 (R3 Johannesburg, GCP `africa-south1`), all leaders in one Kenyan region, reconfigured
to 2 + 2 during a declared region disaster. It leaves to this RFC everything that makes
that shape run and be measured (§7, §8 of RFC-000):

1. **The platform layer itself** (X2-N4, X2-N5): the replicated logs, the placement log,
   leadership and read leases, fencing terms and epochs, closed and report positions, the
   clock bound `ε` and its monitoring, and the single-voter membership changes with the
   own-term-entry guard, as a contract complete enough for RFC-001 … RFC-005 to build on.
2. **Failure handling with stated numbers** (X2-N5, R16): how a failed node, facility or
   region is detected; how every leader moves region-wide within admission's 1 min RTO;
   how a declared region disaster is entered and left; what each failure does to RPO,
   RTO, availability and latency.
3. **The monitored invariant `ack_budget ≥ τ > ε + δ_x`** (RFC-000 §4.3, R4), with the
   alarm that fires before its margin is used up, and the automatic action when it is.
4. **RPO 0** (X2-N4): what "acknowledged" means for every fact, on every failure scope,
   including during a declared disaster (X2-S23).
5. **RTO per capability** (X2-N5, POL-06) and the per-minute budget arithmetic for the hot
   standbys on the rating paths (RFC-000 §2, A0-07), because X2-S13 and X2-S22 are
   counted per minute at 99.99%.
6. **Measurement** (X2-N1, X2-N3): the probes, the probe account and its isolation from
   rating and settlement, the available minute; latency and timeliness measured at the
   system boundary; declared-disaster exclusions.
7. **Capacity** (X2-N2): sizing for POL-06's provisional design load (×50), and the load
   test that accepts it.
8. **Retention for 7 years** (X2-N6, POL-19, X1-N8, P3-N11): history (bitemporal), storage,
   immutability, backups and restore tests.
9. **The notifier and the operational alert feed** (RFC-000 §2, §8): delivery semantics for
   webhooks, affected-reservation notices, standing notices to buyers and alerts.
10. **The diverse-fibre go-live condition** (POL-06, X2 constraints, R14): what exactly must
    be true and how Share verifies it before production and keeps it true afterwards.

What hurts if this is wrong: an acknowledged fact lost on a region loss (finance cannot
trust the books, X2-N4); two writers for one link after a slow failover (an oversell,
POL-05); a confirm accepted after its fence because a clock drifted (POL-26); a region
failover that takes longer than the 1 min admission RTO because thousands of groups
elect at once; availability that cannot be audited because the probes measure the wrong
thing.

## Approach

### 1. Scope and building blocks

RFC-006 specifies six components of RFC-000 §2 and one runtime:

| Block | What it is | Section |
|---|---|---|
| **Partition host** (runtime) | The process that hosts replicas of replicated-log groups and runs the owners' state machines in them. Every owner of RFC-000 (link, account, partner adapter, ingestion, attribution, rating, settlement, ledger, payments, payouts, catalogue, identity, approvals, notifier, alerts) runs inside it. It is the implementation of the platform contract (§10) | §3, §10 |
| **Placement and time** | The placement log and its controller: partition map and epochs, leader-region preference, region health, disaster state, timing parameters; the time service and the `ε` monitor | §4, §5, §6 |
| **History** | Sealing of owner logs into two-region object storage, bitemporal indexes, the "as known at T" query service and replay | §11 |
| **Notifier** | Outbound delivery: webhooks, notices, alerts to people | §13 |
| **Probes** | Probe runners outside each serving region; the probe account, links and exporters; the measurement pipeline | §15, §16 |
| **Alerting** | The operational alert feed and its routing | §14 |

It does not specify any owner's state machine, entry kinds or business rules (RFC-001 …
RFC-005), the signing of webhooks (RFC-005) or the exclusion logic inside rating and
settlement (RFC-003, RFC-004), beyond the contract they must meet.

### 2. Topology: sites, facilities, nodes and voters

RFC-000 §5.1 fixes the regions and the voter placement. RFC-006 adds the node roles.

| Site | Facilities ("zones") | Node roles |
|---|---|---|
| R1 Nairobi (Share data centres, serving) | Two independent facilities, R1a and R1b (own power and fibre entry), **to be confirmed by Share's platform team** (RFC-000 R2; §18.4) | Storage nodes (partition hosts: one voter of each group per facility, status replicas, leaders while R1 is preferred); edge nodes; stateless workers; probe-facing load balancers; Ceph object store (hot archive copy) |
| R2 Mombasa (Share data centres, serving) | Two independent facilities, R2a and R2b, to be confirmed likewise | As R1. Leaders only after a region-wide failover, or after the R1 spike shows Mombasa nearer to R3 (RFC-000 R2-D7) |
| R3 GCP `africa-south1` (voter only) | Google's zones a, b, c | Storage nodes only: one voter per group, spread across zones by group; a **warm learner** in a second zone for the admission, placement and approvals groups (§6.2); the GCS archive copy. No edge, no leaders: R3 voters **never campaign** (§3.2) |
| Probe sites | Three colocation sites within about 10 ms of each serving region, outside Share's facilities (RFC-000 D2) | Probe runners only |

**Why R3 voters never campaign.** Every majority of a 2 + 2 + 1 group contains at least
two Kenyan voters, and every majority of a 2 + 2 group (§6.2) contains at least one, so a
Kenyan voter can always lead whenever any majority exists. An R3 leader would put an R3
round trip on every commit and every hop, and would need R3's clocks inside `ε`. Making
R3 voters non-campaigning costs no availability and removes R3 from the clock domain
(§4.1).

**Where state lives.** Every group has its five voters on five different storage nodes in
five different facilities or zones. Status replicas of account groups (RFC-000 §4.6) are
the three Kenyan voters other than the leader, plus one non-voting **status learner** per
Kenyan facility added for read capacity (§17). Every serving region therefore answers
status reads and headroom answers from replicas in its own metro.

**External reachability.** Buyers, suppliers, exporters and payment providers reach the
edges through anycast addresses that Share announces by BGP from both R1 and R2 (Share runs
its own network), withdrawn from a region whose edge fails its health check; DNS names
with a 30 s TTL are the fallback. Each region's edge also has a **unicast** address, which
is what the probes use, so a region's own availability is measured even while anycast
routes clients around it (§15).

### 3. Replicated logs: the partition host

#### 3.1 Groups and partitions

A **partition** is the unit of single writing (a link, an account, a partner link, an
exporter, a ledger home, and so on, RFC-000 §2). A **group** is one consensus log with five
voters. A group carries many partitions, interleaved in its log; its leader is the leader
of every partition in it, and so the only writer of each (A1, A2). A hot partition gets a
group to itself (RFC-000 §2: the hottest link).

| Owner | Partitions | Groups at the design load (est.) | Notes |
|---|---|---|---|
| Account owner | Account | 1,024 | About 50 entries/s per group on average; one account at `account_rate_limit` (200/s) is about 400 entries/s |
| Link schedule owner | Link | 512 shared + up to 128 dedicated | A link that sustains more than 200 requests/s for 10 min is moved to a dedicated group (§3.5); the hottest link (2,500/s, at least 5,000 entries/s) is one |
| Partner adapter | Partner link | 64 | |
| Metering ingestion | Exporter | 256 | Batches of records, one commit per batch |
| Attribution and quarantine | Account; exporter (quarantine) | 256 | |
| Rating | Buyer account | 1,024 | Hot standby by construction (§8.3) |
| Settlement | Buyer account; supplier (debts) | 256 | |
| Ledger | Movement home (RFC-000 §2) | 1,024 buyer homes + 64 supplier + 32 Share sub-partitions | |
| Payments, receivables, reconciliation | (provider, transaction reference); account; day | 128 + 128 + 4 | Partitioned per kind (RFC-000 V-04) |
| Payouts | Supplier | 32 | |
| Catalogue, identity and access, approvals, notifier, alerts, probe results | Entity / account | 16 + 32 + 8 + 256 + 8 + 4 | |
| Placement | One partition | 1 | The placement log (§5.1) |
| **Total** | | **about 5,000 groups** | Partition counts are 4 to 8 times the planned node count, so the cluster can grow four-fold without re-partitioning (§17) |

Partition → group assignment is by a hash of the partition key into a fixed number of
**slots** per owner (4,096 for accounts, links, ledger homes), and slot → group by the
placement map (§5.1). Moving a slot or a single partition between groups is a handoff
with an epoch increment (§3.5); nothing else changes an assignment.

#### 3.2 Consensus profile

**Raft, as implemented by `etcd-io/raft`, embedded in a Go partition host** (Competition
explains the choice), with these settings and four small extensions:

| Setting | Value | Why |
|---|---|---|
| Voters | 5 (2 R1 + 2 R2 + 1 R3), for **every** group, ingestion included | RFC-000 A3. RFC-000 left three voters open for ingestion (§5.1); RFC-006 decides five: a single node loss with three voters would put R3 on every ingestion commit and a second loss would stop ingestion (99.99%), while five voters cost about 60 MB/s more replication at peak (§17.3) |
| Durability of an acknowledgement | A voter acknowledges an append only after `fsync` of its write-ahead log on local NVMe (or a write cache with power-loss protection) | "Durable" in X2-N4 means it survives a power loss of that facility |
| Commit | Majority (3 of 5); the leader counts itself only after its own `fsync` | A3: every majority spans two regions |
| Pre-vote and check-quorum | On | A partitioned or removed voter cannot disrupt a healthy leader; a leader that cannot reach a majority within `election_timeout_min` steps down |
| Leader stickiness | A voter refuses a (pre-)vote while it has heard from a leader within its election timeout, except for an explicit leadership transfer | Required for lease safety (§3.4) and for the double Nairobi–Mombasa cut (§9) |
| `heartbeat_interval` | 100 ms, coalesced per pair of nodes (one message carries the heartbeats of every group the two nodes share) | 5,000 groups would otherwise send about 250,000 heartbeat messages a second per node |
| Election timeout | Kenyan voters in the **preferred** leader region: random in [1.0 s, 1.5 s]. Kenyan voters in the other region: [3.0 s, 4.0 s] for the admission, ingestion and placement classes, [4.0 s, 8.0 s] for the others. R3 voters: never campaign; their stickiness window is 1.0 s | Priority elections: a node loss in R1 is won by the R1 peer, not by R2; a region loss is won by R2 in class order, which staggers elections (§5.4) |
| Batching | Proposals of all groups on a node are batched into one write-ahead-log `fsync` (group commit, about every 1 to 5 ms under load) and one replication message per peer | Throughput at 5,000 groups; RFC-000's group-commit assumption |
| Transport | mTLS between nodes (certificates from RFC-005's PKI), zstd-compressed batches | Confidentiality across Share's fibre and the GCP interconnect; bandwidth (§17.3) |

**The four extensions** (each a few hundred lines on top of the library, each covered by
the TLA+ model and the fault-injection suite of §20):

1. **Non-campaigning voters** (R3): the node never becomes a candidate on election
   timeout; it still votes and still accepts a leadership-transfer `TimeoutNow` only if
   it is Kenyan (R3 never accepts one).
2. **Leadership and read leases** (§3.4, §3.6), timed by `CLOCK_MONOTONIC` with a stated
   drift bound.
3. **Report position and the lease-status query** (§3.6).
4. **The own-term-entry guard and one configuration change at a time** (§3.8).

#### 3.3 Entries and timestamps

Every entry carries a platform envelope; the owner's payload is opaque to the platform.

| Field | Meaning |
|---|---|
| `group`, `index`, `term` | Raft position; `term` is the **fencing term** of A2 |
| `partition`, `epoch`, `pseq` | The partition, its placement epoch (§3.5) and its **partition sequence**: a counter kept in the partition's own state, incremented by every entry of the partition, continuous across leader changes and partition moves |
| `ts` | The leader's timestamp, in microseconds of TAI (§4.1): **`ts = max(clock_now, previous ts of the partition + 1 µs, last durable closed T of the partition + 1 µs)`**, every operand read from the clock or the partition's applied state. So `ts` is strictly increasing per partition across leader changes, and no entry is ever stamped at or before a durable closed T (RFC-000 §4.5, A0R-10) |
| `timing_epoch` | The timing parameters (§4.3) in force for this entry |
| `kind`, `payload` | The owner's entry kind and content; audit fields (principal, role, reason) are in the payload, as RFC-005 defines (RFC-000 §4.1, last row) |
| `identity` | The deterministic idempotency identity of the command that caused the entry (A6), when there is one |
| `retention` | The retention class of the entry kind (§11.3) |

Apply is deterministic: a state machine's transition depends only on its prior state and
the entry, never on a local clock, so every replica reaches the same state (A4). Where a
rule compares times (the confirm fence, RFC-000 §4.3), it compares fields of entries
(`ts`, the deadline `D` in the request record, `τ` from the timing epoch).

#### 3.4 Leadership, leases and takeover

- **Leadership lease.** A leader holds a lease of `leadership_lease` = 900 ms from the
  **send** time of the last heartbeat round that a majority acknowledged, measured on its
  monotonic clock and shortened by the drift bound (500 ppm). Every voter refuses to vote
  for another candidate within at least 1.0 s of hearing from the leader (stickiness,
  §3.2), so no new leader can be elected while the lease is valid. A leader whose lease
  has lapsed **stops deciding**: it proposes nothing new, grants no read lease, answers
  no headroom query and makes no check from its applied state (the pre-partner-confirm
  checks of RFC-000 §3), until a heartbeat round renews it. RFC-000 §5.2.
- **Takeover entry.** A new leader's first proposal is a **takeover** entry in its own
  term (it is also Raft's no-op, and the "takeover" entry of RFC-000 §4.3). Until it is
  committed the leader serves nothing. Once it is committed, and **once the predecessor's
  leadership lease has certainly expired** (the new leader waits `leadership_lease` + `ε`
  from its election, which an election timeout of at least 1.0 s normally already
  covers), the partition host calls the owner's `on_lead(term)`. The owner then resumes
  its workflows from its applied state (POL-03), re-arms its timers (§10.6) and may start
  reporting (§3.6).
- **Step-down.** On losing the lease, on a higher term, on a failing clock (§4.2) or on a
  leadership transfer, the host calls `on_step_down(term)`; outstanding proposals of the
  old term are failed back to their callers with `NotLeader`, which never means "not
  committed" (§10.1).
- **Leadership transfer** (used by placement, upgrades and failback): the leader stops
  proposing, brings the target up to date, and sends `TimeoutNow`; the target campaigns
  at once, bypassing stickiness. The new leader still waits out the old lease before it
  reports (one pause of at most about 0.9 s for that group's reports; a transfer is
  planned, so rare).

**Failure detection and election time for one group (est.).** A crashed leader is
detected by its followers' election timeout: 1.0 to 1.5 s after its last heartbeat. A
pre-vote and a vote take one round trip within R1 (about 2 ms) and one `fsync`; the
takeover entry commits in about 25 ms (RFC-000 §3). The edge learns the new leader from
the `NotLeader` hint of any replica within one retry. **A group is answering again about
1.6 to 2.5 s after its leader dies (est.)**, against admission's 1 min RTO.

#### 3.5 Fencing: terms, epochs, sequences and partition moves

RFC-000 §5.2 states the rules; the platform enforces them as follows.

| Fence | Where it is carried | Who checks it | What a stale one gets |
|---|---|---|---|
| **Term** (per group) | Every entry; every command an owner sends carries its leader's term (`sender_term`) | Raft (an entry of a lower term never commits after a higher term is known); receivers that keep a per-sender high-water mark (the partner adapter's account-owner term check, RFC-000 §3, V-03) | Refused, journaled where the receiver keeps a journal |
| **Epoch** (per partition) | The placement map; every command routed to an owner carries the epoch it was routed with | The receiving partition's state machine, in the same entry that would apply the command | `StaleEpoch(current epoch, group)`; the sender re-routes. A command the partition has already applied (same identity) is answered with its result instead |
| **Sequence** (per partition) | Every feed event and notification: (`partition`, `epoch`, `term`, `pseq`) | Every consumer, in its own state: it applies an event only if its `pseq` is the next one it expects from that partition, ignores lower ones and asks for a replay on a gap | Ignored (idempotent consumption, A6) |

**Moving a partition** (to rebalance, or to give a hot link its own group): the placement
controller (§5.1) proposes `move(partition, to group g′, epoch e + 1)`. (1) The source
group's leader appends **`moved(e + 1, g′, pseq p, snapshot ref)`**; from that entry on, the
source refuses every command for the partition with `Moved(e + 1, g′)`. (2) The target
group's leader appends **`adopt(partition, e + 1, p, snapshot)`**, installing the
partition's state as of `p`; its next entry for the partition is `p + 1`. (3) Once `adopt`
is committed, the placement map records epoch `e + 1` → `g′` and pushes it to every edge and
owner. The partition answers `Moving, retry` between (1) and (3), about 100 ms (est.).
Deadlines and timers are part of the partition's state and are re-armed by the target
leader; a hold or request in flight therefore survives the move. A move is never made for
a partition whose group is reconfiguring (§3.8), and the hottest links are given their
own groups during low load, not at peak.

**No two writers, ever.** Within a group, Raft and the lease give one leader per term and
stop the old one deciding before a new one can. Across groups, the `moved` entry is
committed before `adopt`, so the source never applies an entry for the partition after the
target could. Notifications carry `term` and `pseq`, so a consumer never applies an older
writer's output after a newer one's. This is POL-05 across failures (P1-N1, RFC-000 §7).

#### 3.6 Positions: commit, closed and report; read leases

The platform maintains four positions per group and exposes them per partition.

| Position | Definition | How it is learnt | Used by |
|---|---|---|---|
| **Commit** | Raft's commit index | Leader; followers on the next message | Everything: an acknowledgement to a caller is given only at commit (§7) |
| **Closed** (heartbeat) | (`C`, `T`): every entry of the group with `ts ≤ T` is at or below index `C`, and every replica that reports it has applied through `C`. Published by the leader every `closed_interval` = 200 ms with `T` ≤ the leader's clock − `ε` and ≤ its lease expiry | Piggybacked on heartbeats | Status replicas (RFC-000 §4.6: "a closed position every 200 ms or so"); consumers that need a consistent cut of one group; history indexing |
| **Durable closed** | A committed **`closed_through(partition, T)`** entry: no later entry of the partition has `ts ≤ T` (enforced by the `ts` rule of §3.3, which reads the last such T from the partition's state) | The log | The ledger's "closed through T" (RFC-000 §4.5) for reconciliation and payout runs (RFC-004); any owner that publishes a cut. The owner decides when to append one; the platform guarantees the monotonicity |
| **Report** | `R`: the leader advances `R` to `P` only once **(a)** a majority of voters has acknowledged knowing that `P` is committed (each follower returns, with its heartbeat response, the commit index it knows), **and (b)** every replica holding a live read lease has acknowledged applying through `P`, or its lease has expired | Piggybacked on heartbeats; every replica stores the highest `R` it has seen | Every report of an outcome (A10, RFC-000 §4.6): the edge's final answer, status replicas, the outcome feed, webhooks |

**Why a reported entry is never lost or hidden.** (a) puts the knowledge "P is committed"
on a majority, which intersects every later majority, so any later leader or rule-3 check
(below) finds it. (b) means every replica that may answer `pending` from its lease has
already applied everything reported (RFC-000 V-01, V-02). A new leader cannot know its
predecessor's read leases, so it starts advancing `R` only after the old leadership lease
(and so every read lease granted under it, §below) has expired, which §3.4 already waits.

**Report-position delay (est.).** One heartbeat-response round trip after the commit:
about 10 ms steady (R1 ↔ R2), 65 to 70 ms when a majority must include R3 (RFC-000 §3).
To keep it at one round trip rather than up to a heartbeat interval, the leader sends an
immediate commit-notification message to every follower and leased replica when its commit
index advances past an entry that an owner marked `report_wanted` (deciding entries and
"releases durable" entries, RFC-002), instead of waiting for the next 100 ms heartbeat.

**Read leases** (RFC-000 §4.6, W-01). A status replica asks the leader for a read lease;
the leader grants it only within its own leadership lease and only if the replica has
applied through the leader's current `R`. A lease lasts `read_lease` = 500 ms from the
replica's **send** time of the request, and the replica treats it as expired `ε` before
that. The leader does not renew the lease of a replica behind the `R` it is trying to
reach, so a slow replica delays a report by at most one lease. Bound check (W-01): worst
decision-to-report path (about 215 ms after a region loss, RFC-000 §3) + `read_lease` +
`ε` = 215 + 500 + 10 = 725 ms ≤ `status_staleness` (1 s), with `ε` ≤ 40 ms still giving
755 ms.

**Lease-status query** (for replica rule 3, RFC-000 §4.6, owned by RFC-002). A replica
asks every voter: "have you acknowledged a heartbeat from any leader within
`leadership_lease` + `ε`, and what is the highest commit index you know?" Each voter
answers from its own state. If a majority answer "no", **no leader can hold a valid
leadership lease** (a lease needs acknowledgements from a majority within that time, and
two majorities intersect), so no leader can be reporting. The replica then fetches and
applies the log through the highest known commit index and applies RFC-002's rule 3. The
answer is valid as of the query; RFC-002 bounds its reuse to at most `read_lease`.

#### 3.7 Snapshots, sealing and truncation

- **Snapshots.** Each partition's state machine produces a snapshot every
  `snapshot_interval` (10 min, or 1 GB of log since the last one, whichever is first),
  recording the index and `pseq` it covers and a **state digest** (a hash of the canonical
  state). Snapshots are written to the archive (§11) like sealed segments. A digest entry
  is also appended to the log every snapshot, so any replica or restore can be compared
  with the live state at the same index (§12).
- **Sealing.** Every `seal_interval` (60 s, or 64 MB, whichever is first) each group's
  committed log since the last seal is cut into a **segment**, reorganised by partition
  (sorted by `partition`, `pseq`) into a compressed columnar file, and written to the
  archive (§11.2). The segment's hash, and the hash of the previous segment of the same
  group, are recorded in a committed `sealed` entry, forming a hash chain (§11.4).
- **Truncation.** A replica may discard log entries only below the **truncation index** =
  the lowest of: the newest snapshot that is durable in two archive regions, with every
  entry below it in sealed segments durable in two regions; the newest snapshot durable
  in the R3 archive (GCS), so that a new R3 learner can always bootstrap from R3-local
  data plus the leader's tail (§6.2); and the oldest checkpoint of any registered feed
  consumer that is less than `tail_retention` (24 h) behind. A consumer further behind
  does not hold the tail; it reads from the archive instead (§10.5). With the archive healthy the live tail
  is about 10 to 20 minutes of log (est.); the nodes are sized to buffer 24 h (§17.2), and
  the archive lag alarms at 10 min (warning) and 1 h (page) (§14).

#### 3.8 Membership changes and the own-term-entry guard

**Single-voter changes, not joint consensus.** RFC-000 §5.1 (V-07, W-02) allows either;
RFC-006 picks **single-voter changes with learners**, because every change it needs (the
2 + 2 reconfiguration, its reversal, replacing a failed node, moving a voter between
zones) is a sequence of add-learner, promote and remove steps, each easy to reason about
and each with a majority that overlaps the previous configuration's. Joint consensus
would allow a one-step switch, which is exactly what V-07 rules out for the disaster case,
and its two-configuration commit rule is the part of Raft implementations most often
wrong.

Rules, enforced by the partition host at the leader before it proposes any configuration
entry:

1. **Own-term-entry guard.** The leader proposes a configuration change only once an entry
   of its **own term** is committed (its takeover entry, §3.4). This is the known
   correction to single-server membership changes (Ongaro, raft-dev, 2015): without it, a
   leader that has not yet committed in its term could add a voter based on a
   configuration that a competing leader of an earlier term has already superseded, and
   two disjoint majorities could each commit.
2. **One change at a time.** No configuration entry is proposed while another is
   uncommitted; the next step waits for the previous one's commit.
3. **Learners before voters.** A voter is added only as a learner first, and promoted only
   once its log is within `learner_catchup` (1 s of entries, or 1,000 entries) of the
   leader's. So a promotion never adds a voter that would slow every commit.
4. **Never 4 of 4.** A step whose new configuration would need every live voter of the
   group for a majority is refused unless the orchestrator explicitly names it as the
   only remaining option; the 2 + 2 order (§6.2) never needs it (W-02).
5. **Removed replicas cannot disrupt.** A removed voter's replica ID is tombstoned in the
   placement map; a replica that finds its ID tombstoned stops campaigning for that group
   and deletes its data after `removed_grace` (24 h). Pre-vote and stickiness keep it
   harmless meanwhile.
6. **Each step is idempotent and recorded.** The orchestrator (§5.1) records the step it
   is on in the placement log, so a placement-leader failover resumes the sequence, and
   re-proposing a step that is already in the group's configuration is a no-op.

### 4. Time and the clock bound ε

#### 4.1 Sources and scale

- **Time sources.** Each Kenyan facility has two GNSS-disciplined time servers with
  rubidium holdover (drift about 1 µs a day without GNSS), from different vendors, serving
  PTP (IEEE 1588, hardware time-stamping on the storage and edge NICs) and NTP as the
  fallback. Each host runs `chrony` against both local servers and both servers of the
  facility's same-metro peer, and cross-checks against the other Kenyan region's servers
  (RTT about 10 ms).
- **Scale.** Entry timestamps and deadlines are **TAI** (`CLOCK_TAI`, kept by `chrony`
  with the leap-second table), so intervals never jump at a leap second. UTC appears only
  at the API boundary and in human-facing records. No leap smear is used, and none is
  needed, because R3's (Google's, smeared) clocks are not in the clock domain: R3 voters
  never lead and never stamp an entry, and leases use monotonic durations (§3.4).
- **No steps.** `chrony` may step a clock only at boot, before the partition host starts;
  afterwards it only slews, at most 500 ppm, which is the drift bound the leases assume.

#### 4.2 The per-node bound and the clock-safety gate

Each Kenyan node computes, every second, its **error bound** `e_node` = |offset| + root
dispersion + root delay / 2 (`chrony`'s "maximum error"), and a **sentinel** measures its
offset against three nodes in the other facility of its region and one in the other
region. The configured bound used by every protocol is **`ε_cfg`**:

| Parameter | Value | Why |
|---|---|---|
| `ε_cfg` target | **10 ms** | GNSS-disciplined PTP in the facility gives errors of microseconds; NTP fallback within a metro gives below 1 ms (est., measured by the R1 spike). 10 ms leaves a wide margin and frees 30 ms of the budget RFC-000 §4.3 assumed |
| `ε_cfg` ceiling | 40 ms | RFC-000 §4.3's estimate; above it the invariant's margin in the degraded state is gone (§4.4) |

The **clock-safety gate**, enforced by the partition host on every node:

| Condition | Automatic action |
|---|---|
| `e_node` > `ε_cfg` / 2, or sentinel disagreement > `ε_cfg` / 2 | Warning alert; the node is de-preferred as leader (leadership transferred away by the placement agent) |
| `e_node` > `ε_cfg`, or sentinel disagreement > `ε_cfg`, or `chrony` unsynchronised, or `e_node` unknown | The node **steps down** from every leadership (transfer if possible, otherwise stop renewing the lease), refuses read leases, refuses to serve headroom answers and stops campaigning until it has been within bound for 60 s. Any confirm it was about to propose is not proposed, which is safe: the request expires instead (RFC-000 R4) |
| More than half of the Kenyan nodes of a region gated at once (a site-wide time failure) | Critical alert; runbook RB-8 (§19). The other region's nodes keep leading, because placement treats the gated region as unable to lead (§5.3) |
| GNSS lost at a facility (both servers in holdover) | Warning only: holdover keeps errors far inside `ε_cfg` for days; page after 24 h |

The confirm guard therefore fails safe whenever the uncertainty is unknown (RFC-000 R4).

#### 4.3 Timing parameters in the log

The confirm fence is applied by the account owner's **state machine** (RFC-000 §4.3:
accept a confirm only if its `ts < D − τ`), so every replica must use the same `τ`. The
timing parameters are therefore data, not local configuration:

- The placement controller holds the **timing epoch**: (`ε_cfg`, `δ_x_cfg`,
  `τ = max(ack_budget, ε_cfg + δ_x_cfg)`), numbered.
- When it changes, every admission-group leader appends a `timing(epoch)` entry to its log
  before it proposes any further confirm. A confirm entry is judged against the `τ` of the
  latest `timing` entry applied before it. A rise of `τ` therefore takes effect for every
  later confirm; a confirm already proposed under the old `τ` and judged under the new one
  may be refused, which is safe (the request expires).
- The leader's **expiry timer** (RFC-000 §4.3: "expire if undecided" at `D − ε − δ_x`) uses
  the current `ε_cfg` + `δ_x_cfg`. It is a liveness rule (A8), so it can use the leader's
  view; it never decides an outcome.
- **`δ_x_cfg`** is set from measurement (§4.4) with **presets per topology state**, applied
  at once when placement changes state, so the fence moves earlier before the
  measurement catches up:

| Topology state (§5.3) | `δ_x` estimate (RFC-000 §4.3) | `δ_x_cfg` preset | `ε_cfg + δ_x_cfg` | `τ` |
|---|---|---|---|---|
| Steady (both Kenyan regions up, leaders in R1) | about 60 ms at p99 | 80 ms | 90 ms | 200 ms |
| One facility lost | about 60 to 70 ms | 90 ms | 100 ms | 200 ms |
| R1 committing through R3 (double Nairobi–Mombasa cut), or R2 lost | about 135 ms | 160 ms | 170 ms | 200 ms |
| R1 lost, leaders in R2 (worst, RFC-000 V-06) | about 150 ms | 170 ms | 180 ms | 200 ms |
| Same, with `ε_cfg` at its 40 ms ceiling | about 150 ms | 170 ms | 210 ms | **210 ms** (alarm A-T3, §4.4) |

So with `ε_cfg` = 10 ms, `τ` stays 200 ms in every state, and the worst state keeps 20 ms
of margin (against RFC-000's 10 ms with `ε` = 40 ms).

#### 4.4 The monitored invariant `ack_budget ≥ τ > ε + δ_x`, and its alarms

Because `τ` is defined as `max(ack_budget, ε_cfg + δ_x_cfg)`, the right-hand inequality
holds **by construction for the configured values**; what can fail is reality exceeding
the configuration. The platform therefore monitors three things (Architecture issue
AI-1):

1. **Measured `δ_x`.** For every expiry entry and every non-confirmed ending entry, the
   account owner records the time from the entry's commit to the "release durable"
   acknowledgement of each Share leg (RFC-002's entries carry both `ts`). Synthetic
   **timing probes** also run one expiry-and-release round trip a second between a sample
   of account groups and link groups in each topology state. `δ_x_meas` is the **p99.9**
   over a sliding 5-minute window, per pair of group classes, plus the maximum observed.
   P2-S93 needs every Share-link release durable by `D`, so p99 (RFC-000's figure) is not
   tail enough; p99.9 with the preset's margin is the design point, and every individual
   release later than `D` is counted and reported (A-T4).
2. **Measured `ε`.** The maximum `e_node` and sentinel disagreement over the Kenyan nodes
   that hold leaderships.
3. **The margin** `m = ack_budget − (ε_cfg + δ_x_meas)` and the relation of `δ_x_meas` to
   `δ_x_cfg`.

| Alarm | Condition | Severity | Automatic action |
|---|---|---|---|
| A-T1 | `m` < 30 ms for 5 min | Warning | None |
| A-T2 | `δ_x_meas` > `δ_x_cfg` for 1 min, or `m` < 10 ms | Page | Raise `δ_x_cfg` to `δ_x_meas` + 10 ms, rounded up to 10 ms, in a new timing epoch (fast attack); `τ` follows; the fence moves earlier, never the release later (RFC-000 §4.3). `δ_x_cfg` is lowered again only after 1 h with `δ_x_meas` + 20 ms below it, one 10 ms step at a time |
| A-T3 | `τ` > `ack_budget`, i.e. `ack_budget ≥ τ` broken | Page | None beyond A-T2: a fence earlier than `D − ack_budget` still meets POL-26 (stricter), but requests with short deadlines lose commit time. Runbook RB-8 |
| A-T4 | Any Share-link release for an expiry durable after `D`; any request still pending at `D` (POL-26) | Page (aggregated per minute) | Reported per request (P2-S53, RFC-002); feeds A-T2 |
| A-T5 | Any node over `ε_cfg` (§4.2) | Page | Clock-safety gate (§4.2) |

### 5. Placement, failure detection and region-wide failover

#### 5.1 The placement log

The placement controller is the owner of one partition on its own 2 + 2 + 1 group (RFC-000
§2), led like every group from the preferred region. Its state:

| State | Content |
|---|---|
| Partition map | Slot → group, partition overrides (dedicated groups), epoch per slot and override |
| Group configurations | Desired and current voters and learners of every group, with node, facility and zone; reconfiguration progress (§3.8, rule 6) |
| Leader-region preference | `R1` by default, until the R1 spike measures each Kenyan region's RTT to R3 (RFC-000 R2-D7); changed by failover (§5.4) and failback (§5.5) |
| Region and facility health | The topology state of §5.3, with its evidence |
| Disaster state | Declared region disasters: region, declaration time, the detected loss time, the operator and approver, end time and how it ended (restored or replaced) |
| Timing epoch | `ε_cfg`, `δ_x_cfg`, `τ` (§4.3) |
| Measurement exclusion windows | Derived from the disaster state; read by the measurement pipeline (§16.4) |

It is read through a cache in every edge and owner, refreshed by push (a feed of the
placement partition) and on any `StaleEpoch` or `Moved` answer. **Elections never depend
on the placement controller**: each group elects by Raft alone, and replicas give
`NotLeader(hint)` answers, so a lost placement leader delays only placement *actions*
(transfers, moves, reconfiguration), not failover.

#### 5.2 Leader placement in steady state

A **placement agent** on every storage node checks, every second, each group it leads:
if the node is not in the preferred region, or is clock-gated (§4.2), or holds more than
its share of leaderships, it transfers leadership (§3.4) to a voter in the preferred
region, choosing between the two facilities by a hash of the group so that leaders are
spread evenly over R1a and R1b. Transfers are rate-limited to 50 per node per second.
After any election that lands outside the preferred region (leader drift, RFC-000 §3),
leadership is back within about 10 s (est.).

#### 5.3 Failure detection

Every storage node exports, per peer node, the age of the last coalesced heartbeat from it,
and per group its role, term and lag. The placement leader aggregates them every second
into a **topology state**:

| State | Condition (all evaluated from outside the region in question) |
|---|---|
| Steady | Every facility reachable |
| Facility lost | Every voter of a facility silent for 3 s, as seen from both other regions **and** from the same metro's other facility |
| R3 lost | Every R3 voter silent for 3 s from both Kenyan regions |
| Region unreachable (R1 or R2) | Every voter of both facilities of the region silent for **`region_detect`** = 3 s, as seen from **both** other regions (so a double Nairobi–Mombasa cut, where R3 still hears R1, is not this state) |
| Kenyan link degraded | R1 and R2 voters hear each other only through R3, or with RTT above 25 ms (one path cut and the other longer, or both cut and traffic transiting R3) |
| Region gated | More than half of a region's storage nodes clock-gated (§4.2) or failing their disk-latency check (write-ahead-log `fsync` p99 > 20 ms for 30 s) |

The topology state drives the `δ_x_cfg` presets (§4.3), the region-wide failover (§5.4)
and the dashboards; it does not by itself declare a disaster (§6.1).

#### 5.4 Region-wide failover (R16)

**What it is.** Moving the leadership of every group from the preferred region to the
other Kenyan region, so that admission leaders are never split across regions (RFC-000
A0-05) and admission recovers within 1 min. It is automatic; declaring a disaster is not
(§6.1).

**Triggers.** The placement leader sets the preference to the other region when any of
these holds, and the other region is **ready** (at least 95% of its voters within
`learner_catchup` of their leaders, and not itself gated):

| Trigger | Condition | Covers |
|---|---|---|
| T1 Quorum loss | Topology state "region unreachable" for the preferred region (§5.3) | R1 lost or isolated: its voters cannot form a majority anywhere (2 of 5) |
| T2 Probes | **Admission probes from both serving regions** fail for `probe_trigger` = 3 consecutive rounds (30 s; §15), while the leaders' region is reachable, and the other region's internal canary (a commit by a group it leads for the purpose) succeeds | A gray failure of the leader region (overload, disk, a bad deploy there) that Raft does not detect because heartbeats still flow. A failure of the probes of **one** region only means that region's edge is failing, which moving leaders would not cure; it pages instead (RB-12) |
| T3 Region gated | Topology state "region gated" for the preferred region for 10 s | Site-wide time or storage failure |
| T4 Operator | An operator in network operations orders it through the console (RFC-005), with a reason; audited | Planned moves, drills, anything the triggers miss |

**Damping.** At most one automatic failover per `failover_damping` (30 min); a second
needs T4. A failover never moves leaders to a region that is itself unreachable, gated or
not ready.

**Procedure.**

1. The placement leader (re-elected in the other region first, if it was in the failed
   one: the placement group is in the admission class, so its R2 voters campaign after
   3.0 to 4.0 s) commits `preference = R2` with the trigger and its evidence.
2. Every R2 voter switches to the preferred-region election timeouts (§3.2). Where the old
   leaders are dead or cut off (T1), R2 voters have **already started electing** on their
   own timeouts, so step 1 only confirms the outcome; where they are alive (T2, T3, T4),
   placement agents transfer leadership (§3.4), staggered.
3. **Staggering.** Elections and transfers are ordered by class: placement; admission
   (account, link, partner adapter), with the approvals and identity groups; ingestion;
   payments and ledger; rating, attribution, settlement; the rest. Within a class they
   are spread by a hash of the group over the class's window (the timeout ranges of §3.2
   for elections; 50 transfers per node per second for transfers).
4. Each new leader commits its takeover entry, waits out the old lease (already expired
   in T1) and resumes (§3.4). The edges learn each new leader from `NotLeader` hints and
   the placement push.

**Expected time to move every admission leader (est.; R1 lost, about 1,700 admission
groups over about 48 R2 storage nodes, about 35 per node).**

| Phase | From the loss |
|---|---|
| Followers stop hearing R1 | 0 to 0.1 s |
| R2 voters of admission groups reach their election timeouts (3.0 to 4.0 s, spread) | 3.0 to 4.0 s |
| Pre-vote and vote: each majority is both R2 voters + R3 (about 50 ms round trip) | + 0.1 s |
| Takeover entry commits through R3 (about 55 to 70 ms) | + 0.1 s |
| Owner resumes: workflows and timers from the applied state, which every follower keeps current (hot by construction) | + 0.2 to 1 s |
| Edges re-route on `NotLeader` hints and the placement push | + up to 1 s |
| **Every admission group led from R2** | **about 5 to 7 s** |
| Every other group (classes with 4.0 to 8.0 s timeouts) | about 9 to 11 s |

A per-node peak of about 35 elections within one second is within one batched
write-ahead-log `fsync` per few milliseconds. The design target is **p99 ≤ 30 s** for
every admission leader, leaving half of the 1 min RTO for anything the estimate misses;
the R1 spike (§20.1) measures it. During T2, T3 and T4 the move is by transfer, not
election, and takes about 5,000 groups / (48 nodes × 50 per s) ≈ 2 s of transfers plus the
lease waits, about 3 to 5 s (est.).

**What buyers see.** After T1, the R1 edge is down with R1; R2's edge answers again once
its account and link leaders are in R2 (about 5 to 7 s); requests in flight at the old
leaders resume (POL-03) or expire, as RFC-002 specifies; their status reads answer
`pending` meanwhile (RQ-12, replica rule 3). A probe minute in R2 in which the move happens
loses at most one round of probes (two failed probes), so the failover costs R2 at most
one or two unavailable minutes (est.); R1's minutes are unavailable until R1 returns or
its loss is declared (POL-06).

#### 5.5 Failback

Leadership returns to the original region **only by operator order** (T4) once the region
has been back and caught up for 30 min, never automatically, so a flapping region cannot
make leaders flap. Failback is by transfers, staggered as in §5.4, and costs at most one
lease pause per group (§3.4). If the R1 spike shows R2 nearer to R3, the default
preference becomes R2 the same way.

### 6. Declared region disaster

#### 6.1 Declaration

- **Who.** An operator in the network-operations role declares, through the operator
  console, with a reason and the evidence (topology state, facility reports), and a
  **second operator approves** (four eyes), because a declaration removes minutes from
  the availability, latency and timeliness measurement (POL-06). POL-32 does not yet name
  this action (Requirements issue RQ-A).
- **When.** The runbook (RB-4, §19) says to declare when a whole region has been
  unreachable or unusable for 10 min with no credible restoration within 1 h, or at once
  on confirmed destruction or loss of power in both its facilities. A fibre isolation is
  **not** a disaster unless the region itself is lost (RFC-000 R2-D2): it counts against
  availability.
- **Effects.** (1) The placement log records the declaration (time, region, operator,
  approver) and the detected loss time; (2) the measurement pipeline excludes the
  disaster window as POL-06 defines it, from the declaration until the region is restored
  or replaced (§16.4); (3) the 2 + 2 reconfiguration starts at once (§6.2); (4) the
  `δ_x_cfg` preset for the surviving region applies (already applied on detection).

#### 6.2 Reconfiguration to 2 + 2

With A the surviving Kenyan region, B the lost one and C the R3 voters (RFC-000 §5.1,
W-02), each group goes through four committed configuration steps, each under the rules of
§3.8:

| Step | Configuration after it | Majority | Live voters | A further fault tolerated? |
|---|---|---|---|---|
| 0 (loss) | A1 A2 B1 B2 C1 | 3 of 5 | 3 (A1 A2 C1) | No |
| 1 remove B1 | A1 A2 B2 C1 | 3 of 4 | 3 | No |
| 2 add C2 as learner, until caught up | voters unchanged | 3 of 4 | 3 | No |
| 3 promote C2 | A1 A2 B2 C1 C2 | 3 of 5 | 4 | **Yes** |
| 4 remove B2 | A1 A2 C1 C2 | 3 of 4 | 4 | Yes |

Every step's majority overlaps the previous configuration's, so if B is only isolated,
its voters can never form a majority of either (they need C1 or C2, and both follow A's
leader under stickiness). C2 is in a different GCP zone from C1. Every majority of the
final configuration contains an A voter and a C voter, so it still spans two regions (A3,
X2-N4), and commit latency is unchanged (leader, Kenyan peer, nearer R3 voter).

**Making steps 2 and 3 fast.**

- **Admission, placement and approvals groups** (about 1,750) keep C2 as a **permanent
  warm learner** in a second GCP zone. Step 2 is then already done, and steps 1, 3 and 4
  are three commits through R3 (about 70 ms each). At 200 groups in parallel, every
  admission group is fault-tolerant again **within about 2 to 5 s** of the declaration
  (est.), and certainly within a minute. The cost is one extra copy of the admission
  log in R3 (about 25 MB/s compressed at peak, §17.3).
- **Every other group** bootstraps C2 when needed, from the newest snapshot in the R3 (GCS)
  archive plus the leader's tail, which truncation keeps for exactly this (§3.7). At about
  10 TB of snapshot state over 16 R3 nodes (est.), every group is fault-tolerant again
  **within about 15 to 30 min** of the declaration (est.). Until then a further fault in
  one of those groups stops its writes; ingestion and the ledger are ordered first.

R3 capacity for the second voter of every group is **reserved** in GCP (a capacity
reservation in a second zone, sized for the full second voter set), not obtained on
demand, because on-demand capacity in one cloud region during a regional event is not
assured (Risk RK8).

The placement log is reconfigured first, then the groups in class order (§5.4, step 3).
Until a group's step 3 commits, all three survivors are needed for each of its commits,
which is why the change starts on declaration and not later (RFC-000 V-07). Between the
loss and the declaration every group runs on three of five voters; Architecture issue AI-2
proposes starting the steps automatically after a sustained loss.

#### 6.3 Restoration or replacement

- **Restored region.** Its storage nodes are wiped and rejoin with **new replica IDs**
  (the old IDs are tombstoned, §3.8 rule 5). Per group: add B1 and B2 as learners
  (bootstrapped from the archive copy in their own region if it survived, otherwise from
  A's), promote B1, promote B2, remove C2 (RFC-000 §5.1); the admission groups keep C2 as
  a learner again, not a voter. Once every group is back to 2 + 2 + 1, an operator ends the
  disaster (four eyes, recorded with its end time), and failback follows by order (§5.5).
- **Replacement.** A new site takes the lost region's place with new node IDs, by the same
  steps. Before the disaster is ended as "replaced", the new site's RTTs are measured
  (§20.1) and the go-live fibre condition is re-verified for it (§18).
- **The end time** in the placement log ends the measurement exclusion (§16.4).

#### 6.4 Degraded latency, and the parallel-commit fast path (R13)

During a declared disaster the latency targets are suspended (POL-06, RQ-3); RFC-000 §3
estimates final single-link answers at about 280 ms (R2 lost) and 300 ms (R1 lost), with
`pending` within about 90 ms. RFC-000 R13 asks RFC-006 to evaluate a parallel-commit
single-link path for this state and for the double Nairobi–Mombasa cut.

**Evaluation.** The fast path would cut three two-region writes to two, about 210 ms at
p99 with the report gate (RFC-000 §3). It does **not** bring the final answer under 200 ms
in either case. It costs a second decision mechanism (the decision becomes a derived fact
over two logs), which RFC-000 rejected for steady state because it undermines the single
decision point (POL-04) and needs a resolution step in every status read. The cases it
would help are a declared disaster, where the targets are suspended anyway, and a double
fibre cut, which the go-live condition makes two independent cuts (§18). **Decision: not
built.** Instead: (a) the edge answers `pending` within about 90 ms in both cases, which
meets X2-S05 (an answer, final or `pending`) though not X2-S15; (b) the double cut is
prevented by the go-live condition and repaired as a priority-one incident (RB-7); (c) a
**replacement site is not pre-built** (it ends a disaster but costs a third Kenyan
facility set and its fibre; RFC-000 Competition) and remains an option if the business
asks for latency during a disaster. Re-evaluated if the R1 spike measures the degraded
state worse than estimated.

### 7. Durability: RPO 0

**Rule.** A fact is acknowledged to anyone (a buyer, a payment provider, an exporter, the
service that posted a movement, another owner) only once the entry that records it is
**committed**: `fsync`ed by at least three of five voters, which by placement are in at
least two regions (A3). The partition host has no other acknowledgement path: an owner's
`propose` returns success only at commit (§10.1), and the edge's final answer, the
outcome feed and webhooks additionally wait for the report position (§3.6).

| Fact (X2-S14) | Entry that records it | Acknowledged to | When |
|---|---|---|---|
| A confirmed reservation | The account owner's deciding entry (RFC-002) | The buyer | At the report position, after commit |
| A received payment event | The payments partition's event entry (RFC-004) | The payment provider | After commit |
| A posted money movement | The ledger's append (RFC-004) | The posting service (settlement, payments, payouts) | After commit |
| An accepted usage record | The ingestion partition's batch entry (RFC-003) | The exporter | After commit |

**Why nothing acknowledged is lost on any failure scope.**

| Scope | Copies left of every committed entry | Why |
|---|---|---|
| A node | At least 2 of the 3 that committed it, on other nodes | One node holds one voter of a group |
| A facility | At least 2 | A facility holds at most one voter of a group |
| A region (R1 or R2) | At least 1 in the other two regions, and Raft's election rule makes only a voter with every committed entry electable | A region holds at most two of five voters; a majority of three is never inside one region |
| R3 | At least 2 in Kenya | |
| During a declared disaster, after 2 + 2 | Each commit is on 3 of 4 voters, at least one Kenyan and one in R3 | The next facility or zone fault still leaves a copy in two regions (X2-S23) |

Sealed history is in object storage in two regions before the log tail is truncated
(§3.7), so retention never depends on the voters. Ingestion may lag (X2-S02): its
acknowledgements are commits, and the consumers behind it (attribution, rating) read the
committed log at their own pace, from the archive if they fall more than 24 h behind
(§10.5), so a lag loses nothing.

Out of scope, and stated: the simultaneous loss of **both** Kenyan regions (two regions,
beyond X2-N4). R3's single voter may then lack the newest committed entries (commits
normally complete in Kenya); the archive in GCS holds everything sealed up to
`seal_interval` before the loss (RK11).

### 8. Recovery per capability: RTO, and hot standbys

#### 8.1 Recovery targets and how each is met

| Capability (POL-06) | RTO node or zone (target) | Design (est.) | RTO region (target) | Design (est.) | Mechanism |
|---|---|---|---|---|---|
| Admission, with the funds holds and headroom checks a booking needs (X2-S21) | 1 min | 2 to 5 s | 1 h | 5 to 7 s to leaders in R2; R2 edge serving | §3.4 elections; §5.4 region-wide failover; the account owner is an admission-tier group, so its funds module recovers with it (RFC-000 §2) |
| Usage ingestion | 1 min | 2 to 5 s | 1 h | about 5 to 7 s | Same; exporters retry to the other region's edge (anycast) |
| Rating and posting | 5 min (ceiling) | about 3 to 5 s on the attribution → unposted-usage and accrual-posting paths; 30 s at most | 1 h | about 10 s | Rating, attribution and settlement are groups: their followers apply every entry, so a follower is a **hot standby by construction** (§8.3) |
| Wallet, other operations | 5 min | 2 to 5 s | 1 h | about 10 s | Account-owner replicas, payments and ledger groups |
| Payouts | 15 min | 2 to 10 s; a run resumes by reference (RFC-004) | 1 h | about 10 s | Payout groups; instructions are facts |
| Reporting and statements | 30 min | seconds (read models in both Kenyan regions) | 1 h | seconds; a rebuild from history takes at most hours, never needed for one region | Reporting read models are kept in **both** R1 and R2, each fed from the owners' feeds; a lost region's copy is simply not used |

Every RTO is verified by failure injection (§20.2), measured from the injection to the
capability's probes succeeding again (X2-S10).

#### 8.2 Availability budget arithmetic

A month has 43,200 minutes; 99.99% allows **4.32 unavailable minutes** a month, 99.9%
allows 43.2. A minute is unavailable if more than 10% of its probes fail (§15.3), so with
probes every 10 s from three locations (18 a minute) one failed probe is tolerated and two
are not (§15.3).

| Event | Probes failed (est.) | Unavailable minutes per event (est.) | Events per month the 99.99% budget allows |
|---|---|---|---|
| Leader node loss, for the groups it led (2 to 5 s; a probe touches one account group and one probe link group) | 0 to 2 | 0 to 1 | at least 4 |
| Facility loss in the leader region (half the leaders re-elect) | 1 to 3 | 1 to 2 | 2 |
| Region-wide failover after T1 (for the surviving region) | 2 to 4 | 1 to 2 | 2 |
| Rolling deploy, one facility at a time, with leadership transfers | 0 | 0 | unlimited |

Node losses are therefore affordable at the expected rate (a few a month across the
fleet), and the budget is spent mainly by facility events. This is why upgrades always
transfer leadership first (planned maintenance is not excluded, POL-06).

#### 8.3 Hot standbys on the rating paths: the per-minute arithmetic (RFC-000 A0-07)

X2-S22 and X2-S13 are judged per minute at 99.99%: 4.32 breaching minutes a month.

**Attribution → unposted usage → account (X2-S22, `attribution_lag_max` = 10 s).** Let `L`
be the normal lag from acceptance to counting in headroom (target p99.9 ≤ 3 s, est.), `O`
the duration of an interruption of the path (takeover), and `k` the catch-up rate
(throughput at full speed over the arriving rate, at least 3 at the design peak). A
record accepted at time `t` before or during an interruption is counted at about
about `O + t / k + L` for an interruption starting at 0 (the backlog is drained in order
at `k` × the arrival rate), so its lag is `O + L − t (1 − 1/k)`, largest for the records
accepted just as the path stopped: `O + L`. **No record breaches if `O ≤ 10 s − L`**;
otherwise the records accepted from about `−L` to `(O + L − 10 s) / (1 − 1/k)` breach.

| Takeover `O` | With `L` = 3 s, `k` = 3: breach-free if `O` ≤ 7 s | Breaching minutes per event |
|---|---|---|
| 3 s (follower takeover, §3.4, est.) | none | 0 |
| 7 s | none (at the limit) | 0 |
| 30 s (RFC-000's figure) | records accepted over about 37 s | 1 or 2 |
| 5 min (the RTO ceiling) | records accepted over about 7.4 min | 8 or 9: **the whole month's budget** |

So the path must take over in **under about 7 s**, which a Raft follower does (§3.4): the
attribution and rating partitions are groups whose followers apply every entry, so the
standby has the state already; only the leader runs the compute, and the new leader
resumes from the last committed batch. The R1 spike measures `L`, `k` and `O` (exit
criterion `O` ≤ 5 s, keeping 2 s of margin). A takeover over 7 s costs one or two
breaching minutes, so the budget absorbs about two such events a month.

**Reservation accrual posting (X2-S13, 2 min).** If minute `m`'s accruals are normally
posted within `P` = 30 s of its end (est.), a takeover of `O` delays minutes ending in the
`O − (120 s − P)` before recovery: **no** minute breaches while `O` < 90 s. The same holds
for usage-priced charges against `max_lateness` + 2 min. A zone loss therefore costs no
breaching minutes, and the 7-minute bound (target + 5 min RTO, X2-S13) is met with a wide
margin. On a declared disaster the affected minutes are excluded and every charge is
posted within its target plus the 1 h regional RTO (X2-S19); the design posts them within
minutes (§8.1), and the ledger's per-line deduplication (RFC-004) ensures none is posted
twice.

### 9. Failure modes

Latency figures are single-link p99 (est.) from RFC-000 §3 and §5.1 unless stated.
"Targets" are RPO, RTO, availability and latency for the serving regions.

| Failure | Detection | Automatic action | Effect on targets |
|---|---|---|---|
| A storage node (leader of some groups) | Followers' election timeout, 1.0 to 1.5 s; node heartbeat age in placement | R1 peer (other facility) wins each election; placement agents rebalance leaderships within R1 | RPO 0. RTO 2 to 5 s per group. At most 1 unavailable minute (§8.2). Latency unchanged after the move |
| A storage node (follower only) | Heartbeat age | None for 10 min; then placement replaces the voter (add learner on a spare node in the same facility, promote, remove the old; §3.8) | None; the group has 4 of 5 meanwhile |
| An edge or stateless worker node | Load-balancer health check, 2 s | Removed from rotation; workers rescheduled | Requests in flight on it are retried by clients (idempotency, POL-29). None measurable |
| A facility in R1 (leader region) | All its voters silent 3 s from three viewpoints (§5.3) | Elections for the groups it led are won by R1's other facility; placement re-spreads nothing (one R1 facility now leads everything, which sizing allows, §17.1) | RPO 0. RTO 2 to 5 s. 1 to 2 unavailable minutes. Latency about 105 to 120 ms |
| A facility in R2 | As above | None; groups commit through the remaining R2 voter, R3 as the spare | RPO 0. None on RTO. Latency about 105 to 120 ms |
| Region R1 lost (or isolated) | T1: R1 silent 3 s from R2 and R3 | Region-wide failover to R2 (§5.4); `δ_x_cfg` preset for "R1 lost" | RPO 0. Admission back in R2 in 5 to 7 s. R1 unavailable until restored or declared (then excluded). R2 final answers about 300 ms, `pending` about 90 ms: latency counts unless declared |
| … then declared a disaster | Operator declaration, four eyes (§6.1) | 2 + 2 reconfiguration (§6.2); measurement exclusion from the declaration | RPO 0, one further fault tolerated (admission within seconds, the rest within 15 to 30 min). Latency targets suspended (POL-06) |
| Region R2 lost | T1 for R2 | None for leaders (they are in R1); preset for "R2 lost"; R2 edge withdrawn from anycast | RPO 0. R1 final answers about 280 ms (commit through R3). R2 unavailable until restored or declared |
| Region R3 lost | All R3 voters silent | None (R3 is never on the commit path while Kenya is whole) | None; each group tolerates one more fault, not two. Archive copy in GCS paused: sealing still reaches two Kenyan regions (§11.2) |
| One Nairobi–Mombasa path | BFD on the path, sub-second; RTT change | Traffic on the diverse path (network layer) | None material: about 105 to 115 ms |
| Both Nairobi–Mombasa paths (two independent cuts) | Topology state "Kenyan link degraded" | Preset for "R1 commits through R3"; R1 keeps leading (quorum R1 + R1 + R3); no failover (leaders are healthy); priority-one repair (RB-7) | RPO 0. R1 final answers about 280 ms, `pending` within budget; R2 reaches leaders only through R3. Counts against availability and latency (not a disaster, RFC-000 R2-D2) |
| R1 ↔ R3 or R2 ↔ R3 path | BFD; R3 voter lag | None | None; groups lose their spare voter for the duration |
| Clock: one node out of bound | §4.2 gate | Node steps down, refuses leases; leaderships transfer | None beyond a transfer pause |
| Clock: a region's time sources fail together, or GNSS spoofed | Sentinel disagreement across facilities and regions; more than half of a region gated | Region gated → T3 failover to the other region | As a region-wide failover (seconds). Safety intact: confirms fail safe |
| Slow disk or gray failure of one node | `fsync` p99 > 20 ms for 30 s; commit-latency outliers | Leaderships transferred away; voter replaced if it persists | Latency spike limited to about 30 s for its groups |
| Gray failure of the leader region (overload, network loss, bad deploy) | T2 probes in both regions, or T3 | Region-wide failover by transfer (§5.4) | 1 to 4 unavailable minutes (30 s of trigger + seconds of move) |
| A hot link above its group's capacity | Group commit queue length, per-link request rate | Placement moves the link to a dedicated group (§3.5) | About 100 ms of `Moving, retry` for that link |
| Placement leader lost | Its group elects as any other | None; elections elsewhere are unaffected (§5.1) | None on targets; placement actions pause for seconds |
| Archive store unavailable (Ceph in one region, or GCS) | Seal-write failures; archive lag alarm 10 min | Sealing continues to the other two stores; truncation waits for two regions | None while two of three stores accept; the tail buffers 24 h (§17.2) |
| All archive writes failing | Archive lag 1 h page | Truncation stops; nodes buffer | None for 24 h; then risk of disk exhaustion (RB-9) |
| A bad software release (logical corruption, crash loop) | Canary groups' digest mismatch (§12), crash loops, probe failures | Rollout halts automatically (§19, RB-13); only one facility is upgraded at a time, so a crash loop never takes a majority | Bounded to the canary facility; RPO 0 for committed entries; a faulty apply is corrected by replay (§12.3) |
| A partition between R1's two facilities | Heartbeat ages | Each group keeps a majority on the side with R2 and R3 connectivity; stickiness prevents disruption | None material |
| Notifier endpoint failures (a buyer's webhook down) | Delivery attempt failures | Exponential backoff for `webhook_retry`; per-endpoint isolation (§13) | None on other buyers |
| A probe location fails | Probe-runner heartbeat | Remaining two locations still give 12 probes a minute; page | None on measurement while two locations remain (§15.3) |
| Alert pipeline fails | Dead-man's switch: every producer heartbeats an external watchdog every minute | Watchdog pages through an independent paging provider | None on targets |

### 10. The platform contract

This section is the complete semantics of the "replicated-log, placement, leader-placement
and fencing conventions; region-wide failover; 2 + 2 reconfiguration; closed and report
positions; clock-uncertainty bound and the invariant" contract of RFC-000 §8, which every
owner builds on. It is an in-process Go interface of the partition host; the delivery
phase defines the exact signatures.

#### 10.1 Proposing

- `propose(partition, epoch, identity, kind, payload, flags) → Committed(index, term, pseq, ts) | NotLeader(hint) | StaleEpoch(epoch, group) | Moved(epoch, group) | Moving | ClockUnsafe | Overloaded(retry_after) | Unknown`.
- **Committed** means durable on a majority spanning two regions (§7). It is the only
  success.
- **Every other answer is "not known to be committed"**: the entry may or may not commit
  later (a proposal in flight at a leader change can still be committed by the new
  leader). The caller retries with the **same identity**; the owner's state machine
  deduplicates by identity in the same entry that applies the effect (A6). The platform
  does not deduplicate.
- `flags`: `report_wanted` (§3.6), `config` (reserved to the platform), `retention`
  override (§11.3, only upward).
- Only the leader proposes, and only while its lease is valid and its clock is within
  bound; otherwise `NotLeader` or `ClockUnsafe`.
- Back-pressure: a group whose commit queue exceeds 50 ms of work answers `Overloaded`
  with a `retry_after`; the edge maps it to the POL-04 answer the owner RFC chooses.

#### 10.2 Applying, snapshots and leadership

- `apply(entry)` is called on every replica, in log order, exactly once per replica
  lifetime per index; it must be deterministic (§3.3).
- `snapshot() → bytes, digest` and `restore(bytes)`; the platform schedules them (§3.7).
- `on_lead(term)`: called once the takeover entry of `term` is committed and the
  predecessor's lease has expired (§3.4). `on_step_down(term)`: called at once when the
  lease lapses or the term changes.
- `lease_valid() → bool, until`: the owner must check it before **any** action taken from
  its applied state rather than through a log entry (a headroom answer, the checks before
  a partner confirm, RFC-000 §3).
- `term()`: the leader's term, to put in every command it sends (§3.5).

#### 10.3 Time

- `now() → ts, e_node`: TAI microseconds and the node's error bound; refuses
  (`ClockUnsafe`) when the clock-safety gate is closed (§4.2).
- The `ts` of an entry is assigned by the platform by the rule of §3.3; owners never
  stamp entries themselves.
- `timing() → epoch, ε_cfg, δ_x_cfg, τ` as applied in the partition (§4.3); the state
  machine reads `τ` from there when judging a confirm.

#### 10.4 Positions and reads

- `positions(partition) → commit, closed(C, T), durable_closed(T), report(R)` (§3.6).
- `close_through(partition, T)`: appends a `closed_through` entry; refused if `T` is at or
  below the partition's last `ts`. After it commits, no entry with `ts ≤ T` is ever
  appended (§3.3). RFC-004 uses it for the ledger.
- Read leases on replicas: `read_lease() → valid, until, applied_index, R`.
- `lease_status_query(group) → majority_says_no_leader, highest_commit` (§3.6).
- A **replica read** sees state at its applied index; a read that must be current is
  served either under a read lease or by the leader under `lease_valid()`.

#### 10.5 Feeds

- `subscribe(partition, from_pseq, gate) → stream of (partition, epoch, term, pseq, ts, kind, payload)`.
- `gate` = `committed` (default) or `reported` (only entries at or below the report
  position; the outcome feed and the notifier use it, A10).
- Delivery is **at least once, in `pseq` order per partition**, with no order across
  partitions (RFC-000 §4.5). A consumer checkpoints `pseq` in its own state (its own
  group's log, if it is an owner) in the same entry that applies the event, so a consumer
  restart neither skips nor double-applies.
- A subscription served from the replica nearest the consumer, never the leader, unless
  no other replica is current.
- **Replay from the archive.** A `from_pseq` below the live tail is served transparently
  from sealed segments (§11), at lower throughput (about 50 MB/s per stream, est.), then
  switches to the live log; so a consumer can be rebuilt from the start of retention.

#### 10.6 Timers

- `timer(partition, key, at_ts)`: a leader-only timer, persisted only as part of the
  partition's state (the owner records the deadline in an entry); on `on_lead`, the owner
  re-arms its timers from its state. Firing a timer only makes the owner propose an entry;
  timers never decide (A8).

#### 10.7 Routing and placement

- `route(partition) → group, epoch, leader_hint, replicas` from the local placement cache.
- Commands carry the epoch; `StaleEpoch`/`Moved` refresh the cache (§3.5).
- `topology() → state, preference, disaster`: the topology state (§5.3), the preferred
  region and any declared disaster, for owners that must know (for example, RFC-002 may
  shorten its `pending` threshold in a degraded state).

#### 10.8 Guarantees the platform gives, and what it requires of owners

| Guarantee | Requires of the owner |
|---|---|
| One writer per partition at any moment (§3.5) | Every effect is an entry; nothing is decided from a replica's state without a lease |
| Two-region durability of every acknowledged entry (§7) | Acknowledge nothing before `Committed` (or the report position, for reports) |
| `ts` strictly increasing per partition, never at or below a durable closed T, within `ε_cfg` of true TAI | Compare times only through entry fields and the timing epoch |
| A reported entry is found by every later reader (§3.6) | Report only entries at or below `R` |
| Feeds at least once, ordered per partition | Consume idempotently by `pseq` (A6) |
| Membership and placement changes never create two writers or lose an entry | Handle `Moved`, `StaleEpoch`, `NotLeader` by re-routing and retrying with the same identity |
| 7-year retention of every entry of a 7-year class (§11) | Declare each entry kind's retention class |

#### 10.9 Platform parameters (defaults)

| Parameter | Default | Section |
|---|---|---|
| `heartbeat_interval` | 100 ms | §3.2 |
| Election timeouts | [1.0, 1.5] s preferred region; [3.0, 4.0] s or [4.0, 8.0] s other region; R3 never | §3.2 |
| `leadership_lease` | 900 ms | §3.4 |
| `read_lease` | 500 ms (RFC-000 W-01) | §3.6 |
| `closed_interval` | 200 ms | §3.6 |
| `ε_cfg` | 10 ms (ceiling 40 ms) | §4.2 |
| `δ_x_cfg` | Presets 80 / 90 / 160 / 170 ms; measured | §4.3 |
| `region_detect` | 3 s | §5.3 |
| `probe_trigger` | 3 rounds (30 s) | §5.4 |
| `failover_damping` | 30 min | §5.4 |
| `learner_catchup` | 1 s or 1,000 entries | §3.8 |
| `snapshot_interval` | 10 min or 1 GB | §3.7 |
| `seal_interval` | 60 s or 64 MB | §3.7 |
| `tail_retention` | 24 h | §3.7 |
| `removed_grace` | 24 h | §3.8 |

### 11. History and archive: retention for 7 years

#### 11.1 What is kept, and for how long

RFC-000 makes every owner's log the bitemporal record of its state (A4); history archives
and indexes it, and is never a writer (RFC-000 §2). Transaction time is the entry's `ts`
("known at"); valid time is whatever the owner's payload states (a reservation's window,
a movement's posting time, a minute of traffic).

| Record (X2-N6, POL-19, X1-N8, P3-N7) | Where it lives | Retention |
|---|---|---|
| Ledger movements (P4-N7, P4-N15) | Ledger partitions | 7 years (class `7y`) |
| Payment events and reference bindings (P4-N1) | Payments partitions | 7 years |
| Reservation history: every change, who and when (POL-19); link schedule changes and capacity history (P1-N9) | Account owner and link owner partitions | 7 years |
| Raw flow records, accepted or not, with reasons (P3-N7, P3-N11) | Ingestion partitions | 7 years |
| Audit records: every change to money, capacity, links or keys; operator actions; refused privileged attempts (X1-N8) | The audit fields of the owners' entries; the approvals log | 7 years |
| Inputs a charge is reproduced from (P3-N9): price history and corrections, quarantine attributions, fees shown, standing changes | Catalogue, attribution, account owner partitions | 7 years |
| Source-reference and record-identity indexes (POL-29) | Ledger, payments, ingestion state (snapshots) | 7 years |
| Transient coordination entries (capacity holds, tombstones, waiter registrations, read-lease and closed-position bookkeeping) | Link and account partitions | Class `ops`: 400 days, **unless** the owning RFC declares the kind `7y`; the default for any undeclared kind is `7y` |

The legal end of retention is not yet confirmed per market (POL-24). Storage is
**write-once with a retention lock of 7 years + 90 days** from the segment's newest entry
(GCS bucket lock; Ceph object lock in compliance mode); deletion after that is a lifecycle
job enabled only once legal confirms the period, per market. Nothing inside 7 years can be
deleted by anyone, operators included (X1-S15).

#### 11.2 Storage tiers and copies

| Tier | Age | Copies | Stores |
|---|---|---|---|
| Live tail | Minutes (up to 24 h) | 5 voters (+ learners) | Local NVMe on storage nodes |
| Hot archive | Up to 13 months | 3: one in each Kenyan region, one in R3 | Ceph RGW (erasure-coded 8 + 3 across the two facilities of the metro) in R1 and in R2; GCS in `africa-south1` |
| Cold archive | 13 months to 7 years + 90 days | 2, in two regions and with two operators: one Kenyan Ceph copy (R1 or R2 by a hash of the segment, to balance capacity) and the GCS copy (Archive storage class, millisecond first-byte access) | Ceph RGW; GCS |

A segment counts as **durable in two regions** once any two of the three stores have
acknowledged it and its checksum has been verified on read-back; only then may the log tail
below it be truncated (§3.7). Retrieval prefers the copy in the reader's metro.

#### 11.3 Indexes and queries

- **Segment format.** Compressed columnar files (Parquet, zstd), one per (group, seal),
  sorted by partition and `pseq`, carrying the platform envelope as columns and the
  payload as a versioned typed column (the owner's schema version is part of every
  entry's kind). The ledger's lines use RFC-004's delta-encoded layout (RFC-000 A0R-11).
- **Per-partition index.** For each partition: `pseq` range and `ts` range → segment, kept
  in the history service's catalogue (a read model, rebuilt from the segments if lost).
- **Entity indexes**, declared by the owning RFC: reservation → partitions and `pseq`
  (RFC-002); link → schedule entries by valid minute range (RFC-001); source reference
  → movement (RFC-004); (exporter, epoch, sequence) and (reservation, link, minute) →
  records (RFC-003, P3-S39).
- **Bitemporal projections.** For the query kinds the owner RFCs define (the link
  schedule as known at T, P1-S33; a reservation's history; the inputs to an account's
  headroom at a position, P4-S72), history maintains tables with valid-time and
  transaction-time intervals per entity, updated from the feeds and backfilled from
  segments.
- **Queries.** `as_known_at(entity, T)`, `history(entity, from, to)`,
  `entries(partition, pseq or ts range)`, `snapshot(partition, ≤ index)`. Semantics of
  each query's result are the owner RFC's (RFC-000 §8: "History query: as known at T");
  RFC-006 guarantees completeness (every committed entry of a `7y` class is returned for
  its range) and immutability.
- **Replay.** For P3-S36 (recompute a period) and P4-S72 (rebuild headroom), the history
  service runs the owner's own state machine over `snapshot + entries`. Owners keep every
  version of their decoders and apply logic loadable for the retention period, selected
  by the schema and logic version recorded in the entries; a replay never uses a newer
  rule for an older entry.

#### 11.4 Immutability

Besides the retention lock, every segment's hash is chained to the previous segment of its
group and recorded in a committed `sealed` entry (§3.7), and the chain head of every group
is published daily into the approvals log and signed (RFC-005's keys). Altering or removing
a sealed segment is therefore both prevented (write-once) and detectable (chain mismatch
found by the daily integrity check, §12.1). This is the storage half of X1-S15 and P3-S31;
RFC-005 and RFC-003 own the rest.

#### 11.5 Format durability over 7 years

Seven years outlives most libraries. Rules: (1) segment formats are versioned and every
reader keeps decoding every version ever written; (2) a **format corpus** with one sample
segment and snapshot of every format and schema version is kept and decoded by every build
in CI; (3) encryption keys for archived data are kept for the retention period by RFC-005's
key management (no crypto-shredding inside retention; a dependency on RFC-005).

### 12. Backups and restore tests

The archive **is** the backup: sealed segments and snapshots are write-once in two regions
(three while hot), so a later software fault or operator error cannot damage them. What the
archive does not hold is the unsealed tail (at most `seal_interval` plus the archive lag),
which the five voters hold.

#### 12.1 Continuous checks

| Check | Frequency | Pass condition |
|---|---|---|
| Archive integrity | Daily, on a random 0.1% of segments in every store, and every segment within a month | Checksums match the `sealed` entries; hash chains intact |
| State digests | Every snapshot (§3.7) | Every replica's digest at the same index equals the leader's; a mismatch pages and quarantines the replica |
| Archive lag | Continuous | Below 10 min |

#### 12.2 Restore tests

| Test | Frequency | What it proves |
|---|---|---|
| **Partition restore**: 1% of partitions of every owner, restored from the archive (newest snapshot + segments) into an isolated restore cell, replayed, digests compared with the live digest entries at the same index | Weekly, automated | Snapshots and segments are complete and replayable |
| **Group-class restore**: every link group (or another class in rotation) rebuilt from the archive alone, timed | Quarterly | Recovery of a whole class within hours if every voter were lost (beyond X2-N4's scope, but the only answer to a bug that corrupts every replica) |
| **Retention-edge retrieval**: records of each X2-S11 kind retrieved from the cold tier at the oldest age available, plus back-dated synthetic segments of every format version aged 7 years less one day | Quarterly | X2-S11: returned unchanged |
| **R3 bootstrap**: a new R3 learner for a sample of non-admission groups from the GCS archive plus the leader's tail | Monthly | The 2 + 2 timing of §6.2 |

#### 12.3 Logical corruption

A faulty apply (a bug in an owner's state machine) cannot be fixed by restoring older data,
because facts are append-only (A4): the remedy is to fix the code and **replay** the affected
partitions from a snapshot taken before the faulty release (snapshots are retained hourly
for 30 days and monthly for the retention period), then let the owner append corrective
entries where its own rules say so (corrections are new facts). Releases are rolled out one
facility at a time, with the canary facility's digests compared before the next (§19, RB-13),
so a faulty apply is normally caught on one replica of each group.

### 13. Notifier

RFC-000 §2: "deliver every outbound notice: signed buyer webhooks retried for
`webhook_retry`, affected-reservation notices within `affected_notice_time`, suspension
and low-balance notices, supplier notices, operational alerts".

**Structure.** The notifier is an owner on 256 groups partitioned by account. For each
input event it appends a **delivery** entry (destination, content, idempotency identity =
(source partition, `pseq`, destination)); each attempt and its result is an entry; so
deliveries survive failover and are never duplicated by a restart, only by retries the
receiver deduplicates.

| Input feed (gate) | Notice | Destination |
|---|---|---|
| Request outcome feed, RFC-002 (`reported`) | Outcome of a request answered `pending` (P2-S09) | The account's registered webhook endpoint (from identity and access, RFC-005; X1-S24) |
| Reservation lifecycle and affected-status feed, RFC-002 (`committed`) | Affected reservation, restoration, revocation, offers (P1-S26, P1-S40, P1-S50; POL-07) | The holder's webhook and notice list |
| Link schedule feed, RFC-001 | Affected reservations and restorations for the link | Network operations' integration (P1-S26) |
| Account owner standing and funds feeds, RFC-004 | Suspension, release at the end of the grace (P4-S23), low balance, resume amount | The account's webhook and notice list (the standing feed to network operations is RFC-004's own, P4-S25) |
| Supplier-facing feeds (maintenance, schedules), RFC-001/RFC-004 | Supplier notices | Supplier endpoints |
| Operational alert feed (§14) | Pages and messages to people | Paging provider, chat, e-mail, by routing rule |

**Delivery semantics.**

- **At least once**, each delivery carrying its identity as an event ID; receivers
  deduplicate. A request's outcome is final once reported, so its outcome webhook never
  contradicts another.
- **Signed** by RFC-005's signing service (keys from identity and access) with the event
  ID and a timestamp inside the signature (X1-S11).
- **Retries**: attempt at once; on failure or no 2xx within 5 s, retry with exponential
  backoff from 1 s doubling to a cap of 1 h, with jitter, for `webhook_retry` (24 h); then
  the delivery is recorded as given up, visible to the buyer and support. The outcome is
  still available by poll (POL-04).
- **Isolation**: one queue and concurrency limit (4 in flight) per endpoint, and a circuit
  breaker per endpoint, so a slow or failing endpoint delays only its own account.
- **No order across requests**; per reservation, notices are sent in `pseq` order.
- **Notice list**: every notice to an account is also kept in the account's notice list,
  readable through the API, so a buyer whose endpoint is down can still be told (RQ-E).

**Timing (est.).** Affected notices: the link owner records the outage and flags affected
reservations (RFC-001), its feed reaches the account owner and the notifier within about
1 s each; the first attempt is within about 3 to 5 s of the record, against
`affected_notice_time` (60 s), leaving the 1, 2, 4, 8, 16 s retries inside the target.
Outcome webhooks: first attempt within about 1 s of the report.

**Load (R10, X2 open question 2).** No target exists. Provisional: one webhook per request
answered `pending` (routes and contended single links, about 5,000 to 7,000/s at the design
load, RFC-000 §6), plus notices; sized for **20,000 deliveries/s** with retries, to be
replaced by measurement.

### 14. Operational alerts

The **operational alert feed** (RFC-000 §8) is how every owner raises an alert (P2-S53,
P2-S104, P4-S81, reconciliation differences P4-S54, P4-S80, P4-S91, POL-14 breach reports,
and every platform alarm in this RFC).

- **Raising.** An owner raises an alert as an entry in its **own** log (kind `alert`, with
  kind, severity, the entities concerned, reason and an identity), so the alert is as
  durable as the fact that caused it and cannot be lost by a failing alert service. The
  alert service consumes every owner's alert entries through the feed.
- **Alert service.** An owner on 8 groups: deduplicates by identity, tracks raised →
  acknowledged → resolved, escalates unacknowledged pages after 5 min, and routes by kind
  to the role that acts on it (network operations, finance, compliance, support,
  platform on-call). Routing rules are data.
- **Visibility.** Alerts and the requests in trouble behind them are listed in the operator
  console with their reason and the leg concerned (P2-S51, RFC-002).
- **Dead-man's switch.** Every alert producer and the alert service send a heartbeat every
  minute to a watchdog **outside** Share's sites, which pages through an independent
  provider if heartbeats stop, so a failure of alerting is itself alerted.
- **Error-budget alerts** (§16.5) and the invariant alarms (§4.4) use the same path.

### 15. Probes and availability measurement

#### 15.1 The probe estate

| Item | Design |
|---|---|
| Probe runners | Three colocation sites per serving region, outside Share's facilities, within about 10 ms (RFC-000 D2); persistent TLS connections to the region's **unicast** edge address (§2), so each region is measured on its own |
| Probe account | The designated Share probe account (POL-06): Share-internal, `credit_limit` set by a finance operator (POL-32), counted as vetted, never invoiced; one agent key per runner (X1), with key limits that comfortably cover the probe rate |
| Probe links | 16 designated probe links per serving region, each a Share link on Share's own equipment in that region, with a large virtual capacity (10 Gbps) and Share's **probe supplier** account as supplier; spread by placement over different link groups and facilities |
| Probe exporters | Two designated probe exporters per serving region, spread over ingestion groups |
| Probe supplier | A designated Share-internal supplier account owning the probe links; it never earns (nothing is settled) and its payout runs always end "nothing due" (RQ-C) |
| Schedule | Each runner probes each capability every 10 s, the three runners offset by about 3.3 s, so a capability is probed about every 3.3 s and **18 times a minute** per region |

#### 15.2 Per-capability operation and "correct answer" (X2-S18)

| Capability | Operation | Limit | Correct when |
|---|---|---|---|
| Admission API | Book a single probe link, 1 Mbps, window [next minute, +1 min), `wait = true`, fresh idempotency key; the probe links rotate | 200 ms | A well-formed answer for this request: confirmed (expected, since probe links always have free capacity), or `pending` whose outcome, read later, is confirmed. A rejection, an error, a different request's answer or a `pending` that ends not confirmed is incorrect (scored retroactively) |
| Usage ingestion | Send one flow record from a probe exporter with the next (epoch, sequence); every tenth probe resends an earlier record | 1 s | Acknowledged as accepted, naming that record; a resend acknowledged as the same accepted record (never accepted twice, P3-N3) |
| Wallet | Ask for the probe account's balance and headroom | 200 ms | Well-formed, carrying its account-log position, and internally consistent (headroom = balance − funds held − usage exposure + credit limit, POL-18), with the credit limit finance set |
| Payouts | Ask for the status of the probe supplier's latest payout run | 1 s | Well-formed, for the run expected by the schedule, "nothing due" |
| Reporting and statements | Ask for the probe account's statement for the previous UTC day | 2 s | Well-formed, for that day, containing no charges (nothing is rated) and the credit holds as expected |

The probes take the real path: edge, identity, account owner (funds hold against the credit
limit, X2-S24), link owner, report position. The limits are measured end to end at the
runner (RFC-000 §3: about 115 to 125 ms for admission, est.).

#### 15.3 The available minute (X2-S16) and the monthly figure (X2-S01)

- Probe results (runner, region, capability, send time, latency, correctness, error) are
  written to the probe-results owner (4 groups), timestamped by the runner's
  NTP-synchronised clock; a result scored incorrect retroactively is a new entry, not an
  edit.
- A **minute** (UTC) of a capability in a region is available if at least 90% of its
  probes succeeded (POL-06). With 18 probes, 17 must succeed; with 12 (one runner down),
  11.
- A minute with **fewer than 12 probes** (two runners down, or the probe estate failing)
  counts as **unavailable** and pages: the measurement never makes a minute available by
  the absence of evidence.
- Availability per capability, per serving region, per calendar month = available minutes
  / minutes in the month, leaving out the minutes of a declared disaster for the regions
  POL-06 excludes (§16.4). Planned maintenance is not excluded.
- Monthly reports are generated from the probe-results log and kept 7 years with the
  results, so every figure can be recomputed.

#### 15.4 Probe designation and isolation (X2-S20, X2-S24)

RFC-006 owns the "probe designation and exclusion" contract (RFC-000 §8). Its rules:

1. **Designation** is an attribute of an account (identity and access), a link and an
   exporter (catalogue). It is set only at provisioning, by an operator (finance for the
   account's credit limit, network operations for links and exporters), with a reason,
   audited (RFC-005). It can be set only on an entity with no history, and **never
   cleared**, so no real link, account or exporter can be turned into a probe one to hide
   revenue, and no probe one can start earning.
2. **Probe traffic stays probe traffic.** A probe account may book only probe links, and a
   non-probe account may not book a probe link: the account owner refuses such a request
   at intake as invalid (RFC-002 enforces; a validity rule, not a policy change). Probe
   exporters report only flows on probe links.
3. **Exclusion.** Rating produces no charge line for a reservation of the probe account or
   a record from a probe exporter (RFC-003); settlement therefore receives nothing
   (RFC-004); supplier reports leave out probe links; quarantine reports leave out probe
   exporters' records (RFC-003); reconciliation is unaffected because no movement exists.
   Every consumer checks the designation in the catalogue or identity; since designation
   never changes, any position gives the same answer.
4. **Real funds path.** The probe account's credit holds are real (POL-06, X2-S24): they
   gate its bookings like any account's and are released when the reservation ends
   (RFC-004). The credit limit is sized for the probe rate: about 18 bookings a minute per
   region × 2 regions, each holding its coverage for a 1-minute reservation; finance sets
   it with that figure and the alert for "probe account headroom below 25%".
5. **Retention.** Probe records and reservations are kept like any (they are facts); their
   volume is negligible.
6. **What probes do not show.** The single probe account measures admission through one
   account partition; probe links spread over link groups. A failure of other account
   groups is invisible to the probes (and a failure of the probe account's group affects
   every probe). Internal canaries (§16.5) cover every group for detection, but they are not
   the measurement POL-06 defines (RQ-C).

### 16. Latency and timeliness measurement

#### 16.1 Latency at the system boundary (X2-S05, X2-S15, X2-S06)

- The edge records, per request, the arrival time (first byte) and response time (last
  byte sent), the operation, the region, whether the answer was final or `pending`, and,
  for single-link bookings, whether the link reported capacity in flight (the link owner's
  hold answer carries the flag, RFC-001), into per-minute HDR histograms per (region,
  operation, class).
- **p99** is computed per serving region over each calendar month (and per day for
  operations), with the minutes of a declared disaster left out (§16.4). The window is not
  stated in the requirements (RQ-D).
- X2-S05: all single-link bookings, final or `pending`. X2-S15: single-link bookings on
  Share links without capacity in flight, final answers only (a `pending` there counts as
  a miss). X2-S06: route bookings to the first response; outcome by deadline is measured
  by RFC-002's outcome records (decision `ts` before `D`, A-T4 for any that is not).

#### 16.2 End-to-end timings (X2-S07, X2-S22, X2-S17, X2-S08)

All times are entry `ts` values (TAI, within `ε_cfg` of each other) or boundary times, so
each timing is exact to about 2 × `ε_cfg` (20 ms, est.).

| Target | Start | End | Computed by |
|---|---|---|---|
| Top-up to credited headroom ≤ 10 s, p99 | Edge arrival of the provider's notification (recorded in the payments event entry) | `ts` of the account owner's entry applying the ledger balance through a position at or after the movement (RFC-004) | Joining source reference → movement position → account-log position |
| Accepted record to headroom ≤ `attribution_lag_max`, 99.99% of minutes | `ts` of the ingestion batch entry that accepted the record | `ts` of the account owner's entry applying unposted usage through a rating position that covers the record (RFC-003) | **Watermarks**: for each acceptance second, the time at which every ingestion position accepted in it is covered; a minute is good if every second in it is within 10 s. Exact as an upper bound; RFC-003 reports each late record as a breach (POL-14) |
| Standing to network operations ≤ `standing_notice_time` | `ts` of the standing-change entry | Network operations' acknowledgement of the standing message (RFC-004's feed) | Per change |
| Suspension to enforcement ≤ 60 s | `ts` of the suspension entry | Network operations' report of the block in effect at the edge | Per suspension; network operations' 50 s is theirs, reported here |

#### 16.3 Charge timeliness (X2-S13, X2-S19)

- **Reservation accrual.** Rating publishes, per partition, a watermark "accruals posted
  through minute m" with its `ts` (RFC-003; posting acknowledged by the ledger, RFC-004).
  Minute `m` is good if every partition's watermark passes `m` within 2 min of its end.
- **Usage-priced.** For minute `m`, the records that arrived within `max_lateness` of its
  end are those accepted at ingestion positions up to `m_end + max_lateness`; minute `m` is
  good if the usage charges covering those positions are posted by `m_end + max_lateness +
  2 min` (watermarks again).
- **Monthly figure**: good minutes / minutes, excluding the minutes affected by a declared
  disaster (§16.4), against 99.99%.
- **Bounds**: any charge later than its target + 5 min (outside a disaster), or target +
  1 h (in one), is a page and a reported breach.

#### 16.4 Declared-disaster exclusions (X2-S19, X2-S23)

The measurement pipeline reads the disaster windows from the placement log (§5.1). From the
declaration until the end recorded at restoration or replacement:

| Measurement | Treatment |
|---|---|
| Availability (X2-S01) | Minutes excluded for every serving region (POL-06: a region loss is outside the availability measurement; glossary *Declared region disaster*: availability is not measured during it). Probes keep running and their results are kept, so the surviving region's service is still visible; see RQ-B for the start time |
| Latency targets (X2-S23 list) | Not measured |
| Charge timeliness and attribution lag (X2-S13, X2-S22) | Affected minutes excluded; bounds of target + 1 h apply (X2-S19) |
| RPO, outcomes by deadline, breach reporting | **Always** measured (X2-S23): A-T4 and the failure-injection checks run throughout |

#### 16.5 Error budgets and canaries

- Burn-rate alerts on each availability and timeliness budget: a page when the 1 h burn
  rate exceeds 14.4 × the monthly rate (2% of the budget in an hour) and when the 6 h burn
  rate exceeds 6 ×; a warning at 1 × over 3 days.
- **Internal canaries** (not the POL-06 measurement): a canary partition in every group
  commits a write every 10 s and checks it from a replica in each Kenyan region, so a
  failing group is detected even if no probe touches it.

### 17. Capacity planning at the design load (×50)

#### 17.1 Sizing rules

1. **Size for the provisional design load of POL-06** (25,000 requests/s, 2,500/s on one
   link, 260,000 records/s average and 600,000/s peak, 1,000 notifications/s, the admission
   mix), plus the derived loads of RFC-000 §6 (about 1 M reservation lines/s rated, about
   1,700 movements/s, 100,000 status polls/s).
2. **One facility carries every leader.** Every Kenyan facility can run all leaders of all
   groups at the design load at no more than 70% of CPU, because after the loss of the
   other facility of the leader region (or, during a declared disaster, of the other
   facility of the surviving region) one facility leads everything.
3. **Followers apply everything.** Every replica applies every entry (hot standby), which
   costs about 30% of the leader's CPU per group (est.).
4. **R3** carries one voter of every group at all times, the warm learners of §6.2, and a
   reserved second voter set for disasters.
5. **Re-run on measurement.** When exporter, provider and admission measurements replace
   the provisional figures (X2 open question 1), this section and the load test are re-run
   before production.

#### 17.2 Starting estimate (est.)

| Item | Per Kenyan facility | R3 | Notes |
|---|---|---|---|
| Storage nodes (64 cores, 512 GB RAM, 4 × 7.68 TB NVMe) | 24 | 16 per zone in use (2 zones) + 16 reserved | About 210 group replicas per Kenyan node |
| Edge nodes (TLS, authentication cache, routing) | 8 | — | 25,000 bookings/s + 100,000 polls/s + ingestion and payments ingress across a region's two facilities, with one facility able to take it all |
| Stateless workers (partner calls, rating compute helpers, reporting read models) | 12 | — | |
| Leader CPU at design load, all groups | about 400 cores | — | Under 30% of one facility's storage nodes (rule 2 allows 70%) |
| Memory for state | about 1.5 TB per facility of replica state | same per voter set | Link schedules, 63 M active reservations, rating watermarks, deduplication indexes (RFC-000 §6) |
| Live tail and 24 h buffer | about 20 TB of log at peak rates per voter set, about 0.9 TB per node | same | §3.7 |

#### 17.3 Replication bandwidth (est., peak, uncompressed / zstd at about 3 ×)

| Stream | Rate |
|---|---|
| Account groups | about 40 MB/s |
| Link groups | about 28 MB/s |
| Ingestion | about 72 MB/s |
| Attribution, rating | about 50 MB/s |
| Ledger | about 50 MB/s |
| Everything else | under 5 MB/s |
| **Total leader output per follower** | **about 245 MB/s raw, about 80 MB/s compressed** |
| R1 → R2 (two voters, plus two status learners for account groups) | about 570 MB/s raw (4.6 Gbps), about 190 MB/s compressed (1.5 Gbps) |
| R1 → R3 (one voter, plus warm learners for admission groups) | about 315 MB/s raw (2.5 Gbps), about 105 MB/s compressed (0.85 Gbps) |
| Archive replication (each of the other two stores) | about 60 MB/s compressed (0.5 Gbps) |
| R2 → R3 during a declared R1 disaster (two R3 voters) | about 160 MB/s compressed (1.3 Gbps), plus bootstrap bursts |

**Rule for the fibre**: each Nairobi–Mombasa path, and each Kenya–Johannesburg path
including its GCP interconnect, must carry **at least 10 Gbps** for the platform alone, so
that either path of a pair carries everything with room for snapshot bursts (§18).

#### 17.4 Storage over 7 years (est., per copy)

| Data | Raw | Stored (compressed columnar) |
|---|---|---|
| Raw flow records (260,000/s × 100 B) | 5.7 PB | about 2.9 PB |
| Ledger lines (about 1 M/s; RFC-000 A0R-11) | 22 PB at 100 B | about 2.2 PB |
| Account and link logs, `7y` classes | about 4.4 PB | about 1.1 PB (up to about 3.8 PB if every kind is `7y`) |
| Rating, attribution, payments, audit, snapshots | about 4 PB | about 1 PB |
| **Total at 7 years** | | **about 7 to 10 PB per copy**, growing about 1.2 PB a year; two copies, plus a third for the hot 13 months |

#### 17.5 The load test (X2-S03, X2-S04)

On a **pre-production cell on the real three sites and fibre** (its own storage nodes and
groups, same placement, same network paths), a generator reproduces the design profile for
**at least one hour**: 25,000 requests/s with 2,500/s on one link, 80% single-link and 20%
routes, 70% fitting, with realistic account and link skews, poll and webhook traffic;
records at 260,000/s with 600,000/s peaks for 5 min each quarter hour, duplicated, late and
out of order as P3 describes; 1,000 payment notifications/s. Pass: every latency target of
X2-S05, X2-S15 and X2-S06 and every timeliness target of X2-S13 and X2-S22 met throughout
(§16 methods). A second run injects a node loss, a facility loss and a region-wide failover
during the hour and checks RPO 0 and the RTOs (§20.2).

### 18. The diverse-fibre go-live condition

#### 18.1 The condition

RFC-000 §5.1 (A0R-05, R2-D2), which the cut analysis depends on: **four paths, pairwise
with no shared risk** (no common duct, cable, landing station, building entry, bridge or
right of way, including power for in-line equipment):

| Path | Requirement |
|---|---|
| N–M A and N–M B | Two Nairobi–Mombasa paths |
| N–J | Nairobi to Johannesburg (GCP `africa-south1` interconnect), **not via Mombasa** |
| M–J | Mombasa to Johannesburg, **not via Nairobi** |

Each with the capacity rule of §17.3 and latency within the RTT matrix (RFC-000 §3), the
diverse N–M path within 15 ms RTT. The requirements' wording (X2 constraints, glossary
"Serving region") is weaker than this; RFC-006 verifies the stricter one (RQ-F).

#### 18.2 Verification before production

Share's network team owns the verification; the platform lead countersigns. Production does
not start until the record is complete.

1. **Route evidence.** For every path and every carrier on it: the as-built route (GIS
   file of duct and cable, landing stations, building entries, in-line amplifier and
   regeneration sites), the carrier's written statement of shared risk, and the
   contractual duty to notify Share of any reroute.
2. **Shared-risk register.** Every element of every path is entered as a shared-risk link
   group (SRLG); the condition holds only if the four paths' SRLG sets are pairwise
   disjoint, checked mechanically, with particular attention to the corridors that tend to
   be shared (the Mombasa–Nairobi road and railway corridors, power-line fibre, the
   Mombasa cable landing stations, and the Johannesburg interconnect facility).
3. **Independent desk audit** of the evidence by someone outside the team that procured the
   paths.
4. **Cut tests** on the pre-production cell: each path disabled in turn and each pair whose
   loss RFC-000 §5.1 analyses (N–M A + N–M B; N–J alone; M–J alone), checking that traffic
   takes the expected path and that the latency and failure-mode rows of §9 hold.
5. **Sign-off record** (evidence, register, audit, test results) kept with the platform's
   records for the retention period.

#### 18.3 Keeping it true

- Per-path latency, loss and BFD monitoring; an alert when a path's RTT changes by more
  than 2 ms for 5 min (a sign of a reroute that may share risk), investigated within a
  day.
- Re-verification yearly, on any carrier change and on any carrier notice of a reroute;
  the condition is re-checked for a replacement site before a disaster is ended as
  "replaced" (§6.3).

#### 18.4 The facility inventory (RFC-000 R2)

Part of the same gate: Share's platform team confirms at least two independent facilities
(own power feed, own fibre entry) in each of Nairobi and Mombasa. If a metro has only one,
the topology state "facility lost" becomes "region lost" for it (RFC-000 R2) and §8.2's
budget arithmetic is redone before go-live.

### 19. Runbooks (outline)

| ID | Situation | Outline |
|---|---|---|
| RB-1 | Node loss | Confirm automatic elections completed (dashboard: groups without leader = 0); confirm probe minutes; after 10 min, confirm automatic voter replacement or replace by hand; open hardware ticket |
| RB-2 | Facility loss | Confirm leaders consolidated in the surviving facility of the region; check CPU headroom (§17.1 rule 2); freeze deploys; if the facility will be out over 4 h, replace its voters with spares in the remaining facilities only if the group would otherwise have two voters in one facility (never); track recovery; rejoin with new replica IDs |
| RB-3 | Region-wide failover (automatic) | Verify trigger and evidence in the placement log; verify every admission group led in the new region within 30 s; check `δ_x_cfg` preset applied; decide within 10 min whether to declare (RB-4); communicate status |
| RB-4 | Declare a region disaster | Criteria (§6.1); declaration with reason and evidence, second approver; watch the 2 + 2 progress (admission groups in seconds; others in class order); confirm `R` and commits healthy; publish customer notice; record the detected loss time |
| RB-5 | End a disaster (restored) / failback | Wipe and rejoin the region with new replica IDs; learners, promotions, remove C2; verify every group 2 + 2 + 1; end the disaster (four eyes); after 30 min stable, order failback (T4) |
| RB-6 | Replace a region | Commission site, measure RTTs (§20.1), verify fibre (§18), then RB-5 with the new site |
| RB-7 | Fibre cut (one or both N–M paths, or a Kenya–J path) | Confirm network failover; for both N–M paths: priority-one with carriers, confirm `δ_x_cfg` preset, do not declare (counts against availability), consider moving leaders only if R2 is the region with better reach to R3 and the cut will last hours (operator T4) |
| RB-8 | Clock alarm, invariant alarm (A-T2, A-T3, A-T5) | Identify gated nodes and sources; check GNSS status and holdover, sentinel disagreement; if region-wide, confirm T3 failover; review `δ_x_meas` by group pair; if A-T3, review whether `ε_cfg` or a slow class drives it |
| RB-9 | Archive lag or failure | Identify failing store; confirm two of three accept; if fewer, raise priority; watch node tail growth against the 24 h buffer; never truncate below the two-region rule |
| RB-10 | Restore or replay | Identify affected partitions and the faulty release; choose a snapshot before it; replay in the restore cell; compare digests; promote the corrected code; owner appends corrective entries per its RFC |
| RB-11 | Hot partition | Confirm automatic move to a dedicated group; if a dedicated group is saturated, page the owner RFC's team (RFC-001's measured ceiling) |
| RB-12 | Probe failures | Separate measurement faults (runner, probe account headroom, probe link) from service faults (one region's edge, a group); if only one region's probes fail, investigate its edge and anycast, not leaders |
| RB-13 | Bad release | Automatic halt on canary digest mismatch, crash loop or probe failure; roll back the canary facility; replay if an apply was faulty (RB-10) |
| RB-14 | Decision record unavailable at a deadline (P2-S104), request pending at deadline (P2-S53) | Identify the group; confirm election; confirm holds released within `release_grace`; report the affected requests |

### 20. Verification

#### 20.1 The R1 spike (RFC-000 R1)

On the real three sites, before RFC-001, RFC-002 and RFC-004 are approved:

| Measurement | Exit criterion |
|---|---|
| RTT matrix (RFC-000 §3) with each fibre path alone | Within the estimates ± 25%; else RFC-000's budget is redone |
| Each Kenyan region's RTT to R3 | Fixes the default leader region (R2-D7) |
| Two-region commit p50, p99, p99.9 for a five-voter group under group commit at the hottest-link rate, in every topology state of §4.3 | Within RFC-000 §3 |
| `δ_x` and the report-position delay in every topology state | `ε_cfg + δ_x_meas` p99.9 ≤ 190 ms in the worst state |
| `e_node` with GNSS + PTP, with NTP only, in holdover | `ε_cfg` = 10 ms justified |
| Region-wide failover of about 5,000 groups (T1 by isolating R1; T2 by transfer) | Every admission leader moved within 30 s at p99 |
| 2 + 2 reconfiguration of every group (with warm learners for admission) | Admission groups within 1 min; all within 30 min |
| Attribution path takeover `O`, lag `L`, catch-up `k` (§8.3) | `O` ≤ 5 s |

#### 20.2 Failure injection (X2-S09, X2-S10, X2-S12)

Before production, on the pre-production cell, and then regularly:

| Scope | Where and how often | Check |
|---|---|---|
| Node kill, disk stall, clock skew, packet loss | Production, weekly, one node at a time; pre-production daily | Every fact acknowledged before the failure is present after (a checker writes facts of each X2-S09 kind and verifies them); RTO by probes |
| Facility isolation | Production, quarterly (transparent by design); pre-production monthly | Same, and RTO ≤ 1 min for admission and ingestion |
| Region isolation and declared disaster | Pre-production cell on the real sites, quarterly; production only as a planned graceful leader-region switch (T4), monthly | X2-S12 (no fact lost), X2-S10 region rows, 2 + 2 safety with the "lost" region alive but isolated (V-07) |
| Membership and lease safety | Continuous in CI: a Jepsen-style harness with partitions, clock skew within and beyond `ε_cfg`, crashes during each membership step; a TLA+ model of leases, the report position, single-voter changes with the own-term guard, and partition moves | No two leaders with valid leases; no reported entry lost; no two disjoint majorities; no two writers per partition |

#### 20.3 Design-level acceptance tests

Each cites the scenario it serves (docs/README.md conventions).

| Test | Serves |
|---|---|
| DT-01 An entry is acknowledged only after `fsync` on three voters in two regions; killing any two voters after the acknowledgement loses nothing | X2-S14, X2-S09 |
| DT-02 Isolating R1 entirely: every entry acknowledged before is present on the R2 + R3 majority, and admission is back within 1 min | X2-S12, X2-S10 |
| DT-03 A deposed leader whose lease has lapsed proposes nothing, answers no headroom query and grants no read lease | X2-S21 (and POL-05 via RFC-001) |
| DT-04 A new leader neither reports nor calls `on_lead` before its takeover entry commits and the old lease has expired | P2-S108 (with RFC-002) |
| DT-05 The report position never passes an index that a majority does not know committed or that a leased replica has not applied | P2-S10, P2-S99 (with RFC-002) |
| DT-06 The lease-status query answers "no leader" only when no leader can hold a lease | P2-S111 (with RFC-002) |
| DT-07 `ts` is strictly increasing per partition across leader changes and partition moves, and never at or before a durable closed T | P4-S90 (with RFC-004) |
| DT-08 A node with `e_node` > `ε_cfg` steps down within 1 s and proposes no confirm | X2-S06, P2-S93 (with RFC-002) |
| DT-09 Raising `δ_x_cfg` produces a timing entry before the next confirm in every admission group; a confirm judged under the new `τ` after `D − τ` is refused | P2-S93 (with RFC-002) |
| DT-10 The 2 + 2 sequence never needs four of four live voters, and with the "lost" region alive but isolated no two majorities commit | X2-S23, X2-S12 |
| DT-11 A configuration change is not proposed before an own-term entry commits, and never while another is uncommitted | X2-S12 |
| DT-12 A moved partition's source refuses every command after `moved`; the target's first entry continues `pseq` | X2-S09 (and POL-05 via RFC-001) |
| DT-13 A minute with 16 of 18 probes succeeding is unavailable; with 17 of 18, available; with 11 probes in total, unavailable | X2-S16 |
| DT-14 A probe account cannot book a non-probe link and a buyer cannot book a probe link; probe bookings and records produce no charge line, settlement, supplier-report or quarantine-report entry | X2-S20 |
| DT-15 A sealed segment cannot be overwritten or deleted inside its retention lock, in either store; a chain mismatch is detected the same day | X2-S11, X1-S15 |
| DT-16 Records, movements, payment events and reservation changes back-dated 7 years less one day are returned unchanged from the cold tier, for every format version | X2-S11 |
| DT-17 A webhook delivery survives a notifier leader failover without loss, is retried with backoff for 24 h, and carries the same event ID on every attempt | P2-S09 |
| DT-18 An alert raised in an owner's log reaches the alert service after the alert service's leader is killed | P2-S53 |

## Benefits

Figures marked "est." are estimates (to be replaced by the R1 spike and the load test).

| Target | How this design meets it |
|---|---|
| RPO 0 on node, zone and region loss, and during a declared disaster (X2-N4, X2-S09, S12, S14, S23) | One acknowledgement path, at commit on three of five voters that by placement span two regions; during a disaster 2 + 2 keeps two-region commits and tolerates one further fault (admission within seconds of the declaration, est.) |
| Admission RTO 1 min on node or zone loss (X2-S10) | About 2 to 5 s per group (est.): priority elections, hot followers, takeover entry |
| Region RTO 1 h (X2-S10) | Region-wide failover in about 5 to 7 s for admission and about 10 s for everything (est.), against a 30 s design target; nothing is rebuilt |
| Availability 99.99% (X2-S01) | A node loss costs at most one unavailable minute, a facility loss one or two (est.); upgrades cost none (leadership transfers); probes measure each region on its own path |
| Charge timeliness and attribution lag, 99.99% of minutes (X2-S13, S22) | Followers are hot standbys by construction: a 3 s takeover causes no breaching minute (est.), where the 5 min ceiling would spend a month's budget in one event |
| Confirm fence and deadlines (POL-26, P2-S93) | `ε_cfg` = 10 ms instead of 40 ms (est.) keeps `τ` at 200 ms in every topology state with 20 ms of margin in the worst; `τ` is data in the log, so the fence moves earlier the moment `δ_x` grows, before any release would be late |
| Single writer across failures (POL-05) | Terms, leases with stickiness, epochs with `moved`/`adopt`, sequences on every notification |
| Retention 7 years (X2-S11, POL-19, X1-S15) | Write-once, two-region (three while hot), hash-chained archive; format corpus; quarterly retrieval at the retention edge |
| Design load (X2-S03, S04) | About 5,000 groups on 24 storage nodes per facility, each facility able to lead everything at ≤ 70% CPU (est.); 4 × growth without re-partitioning |
| Auditable measurement (X2-N1) | Every probe result and monthly figure kept and recomputable; absence of probes never counts as available; disaster exclusions come from a four-eyes, audited declaration |

## Competition

| Alternative | Why it loses |
|---|---|
| **A distributed SQL database as the log substrate** (CockroachDB or similar, with five replicas over three regions and leaseholder preferences) | Closest off-the-shelf match (leases, closed timestamps, survival goals), and a candidate store for read models. As the owners' log it puts a database transaction, with its own leaseholder, between the owner process and its log: an extra hop unless the owner is pinned to the leaseholder, which the database does not guarantee across failovers; it offers no report position, no replica rule-3 primitive and no per-partition term to fence partner calls with (RFC-000 V-03); and owners would still need their own single-writer lease on top. RFC-000 Competition rejected it as the coordination mechanism |
| **A stretched Kafka cluster** (five replicas, rack-aware, `acks=all`) | `acks=all` waits for every in-sync replica, so R3 is on every commit until it is dropped from the in-sync set, after which durability silently shrinks; no read leases; owners as consumers have no single-writer guarantee beyond transactional fencing, which does not cover reads from applied state. Kafka remains a fine transport for the external feeds of RFC-004 or reporting, if wanted |
| **A separate shared-log service** (BookKeeper- or Delos-style) with owners as external writers | Separates the consensus log from the state machine, so every owner action needs an extra network hop to the log and its own fencing protocol against the log's epochs; the leases, report position and timers would be rebuilt anyway |
| **Build Raft from scratch, or in TypeScript** (Share's stack) | No production-grade multi-group Raft exists for Node.js; a new consensus implementation is a multi-year correctness risk. `etcd-io/raft` (Go) runs etcd, CockroachDB and others at scale; the extensions of §3.2 are small. The cost is a Go runtime for owners (Risk RK10); edge and reporting can stay TypeScript |
| **Joint consensus** for the 2 + 2 change | Equivalent per RFC-000; loses on implementation risk (§3.8) and buys nothing, since every change needed is a sequence of single steps |
| **Three voters for ingestion** (RFC-000 §5.1 option) | A node loss puts R3 on every commit and a second loss stops ingestion (99.99%); saves about 60 MB/s of replication at peak. Five voters, uniform with every other group |
| **Leader-eligible R3 voters** | R3 leaders would add 45 to 50 ms to every commit and hop and bring R3's smeared clocks into `ε`; no availability gained, since a Kenyan voter is in every majority (§2) |
| **Per-group failover** (each group elects wherever, no region preference) | Splits account and link leaders across regions after partial failures (RFC-000 A0-05) |
| **Fully automatic failback** | A flapping region would make thousands of leaders flap; failback costs nothing to delay (§5.5) |
| **NTP-only time, no GNSS in the facilities** | Errors of a few ms within a metro are achievable, but without an independent reference a common upstream fault moves every clock together undetected; GNSS with holdover and cross-region sentinels detects it. Cloud "true time" services are not available to customers in this form |
| **Leap smear** instead of TAI | Mixing smeared (Google) and unsmeared clocks would make `ε` 0.5 s around a leap second; with R3 outside the clock domain and TAI timestamps, no smear is needed |
| **Parallel-commit degraded fast path** (RFC-000 R13) | Still above 200 ms with the report gate, a second decision mechanism, and helpful only where targets are suspended or two independent cuts have occurred (§6.4) |
| **A pre-built replacement site** | A third Kenyan facility set and its fibre to end disasters sooner; latency during a disaster is not a target (§6.4) |
| **Traditional database backups** (periodic dumps) | The append-only archive in two regions is already a complete, write-once backup; dumps would be a second, less complete copy. Replay with fixed code is the remedy for logical faults (§12.3) |
| **Server-side availability from logs** instead of external probes | POL-06 requires probes from outside the region; server logs miss failures in front of the servers |
| **Missing probes counted as available** (or the minute skipped) | Would make a probe-estate failure look like uptime; counting it unavailable is the honest default (§15.3) |
| **A message broker for the notifier's retries** | Retries for 24 h need per-delivery state; a broker's redelivery is not per-endpoint isolated and its retention is not tied to delivery state. Delivery entries in the notifier's own log are durable and idempotent |
| **DNS-only failover** for clients | Minutes of TTL and resolver caching; anycast from Share's own network converges in seconds, with DNS as the fallback |

## Risks and open issues

| # | Risk or issue | Mitigation or next step |
|---|---|---|
| RK1 | **The extensions to Raft are where bugs hide**: leases, the report position, the lease-status query, non-campaigning voters, the own-term guard | TLA+ model and Jepsen-style harness in CI (§20.2) before any owner goes live; keep the extensions small; review by someone outside the team |
| RK2 | **The go-live fibre condition may not be procurable**, notably a Nairobi–Johannesburg path not via Mombasa | Start procurement now; if impossible, raise against RFC-000 (the cut analysis changes) before production; production does not start without it (§18) |
| RK3 | **Facility inventory** (RFC-000 R2): fewer than two independent facilities in a metro | Part of the go-live gate (§18.4) |
| RK4 | **GNSS jamming or spoofing** in the region | Two vendors per facility, rubidium holdover, sentinels across facilities and regions; a spoofed region is gated and fails over (§4.2) |
| RK5 | **Between a region loss and its declaration, every group has zero fault tolerance** (three of five); for a fibre isolation, which is never declared, possibly for hours | Declare promptly (RB-4); raised as AI-2 (start the single-voter steps automatically after a sustained loss) |
| RK6 | **Bandwidth and storage are estimates** that depend on entry sizes not yet designed | Measured in the spike and the load test; the 10 Gbps per-path rule leaves about 7 × headroom over the compressed estimate |
| RK7 | **The probe account measures one account partition** | RQ-C; internal canaries cover detection meanwhile |
| RK8 | **R3 capacity during a regional event**: on-demand GCP capacity in `africa-south1` is not assured | Reserved capacity for the second voter set and permanent warm learners for admission (§6.2) |
| RK9 | **Seven-year readability** of formats and keys | Format corpus in CI, versioned decoders, key retention by RFC-005 (§11.5) |
| RK10 | **Team size and skills**: a company of 11 to 50 people building and operating a multi-group consensus platform in Go | Use `etcd-io/raft` rather than writing consensus; limit custom code to §3.2's four extensions; staff a platform team of at least four before go-live; re-examine the distributed-SQL alternative if the spike shows the platform cannot be ready in time |
| RK11 | **Correlated loss of both Kenyan regions** (shared country, grid, some fibre; RFC-000 R2) | Outside X2-N4. R3 holds a voter and the GCS archive holds everything sealed; recovery would lose at most the unsealed tail of entries not yet on R3. Stated, not designed for |
| RK12 | **Webhook load unknown** (R10) | Provisional 20,000/s (§13); measured once buyers integrate |
| RK13 | **`δ_x` tail in the degraded state**: 20 ms of margin at p99.9 is thin if R3's latency tail is long | `ε_cfg` lowered to 10 ms; A-T2 moves the fence; the spike measures p99.9 |
| RK14 | **Gray failures that probes do not catch** (one account group) | Internal canaries in every group (§16.5) |

## Requirements issues

New issues found while writing this RFC. The requirements are not changed here; each is
proposed for the next requirements amendment.

| # | Issue | Where | Proposal |
|---|---|---|---|
| RQ-A | **Who may declare a region disaster, and on what evidence, is not stated.** A declaration removes minutes from the availability, latency and timeliness measurement, so it is a privileged action with a conflict of interest, but POL-32 names no role for it and no four-eyes rule | POL-06, POL-32 | Network operations declares, with a reason and evidence, a second approver confirms, and both are audited; the same for ending one. RFC-006 designs it so (§6.1) |
| RQ-B | **When a declared disaster starts for measurement.** POL-06 says it lasts from its declaration, so the minutes between the region's loss and the declaration count against availability, latency and timeliness in both serving regions, though they are the same event; the measured figure then depends on how fast an operator declares | POL-06, glossary *Declared region disaster* | State whether the exclusion starts at the declaration (as now, and as RFC-006 measures, §16.4) or at the loss the declaration establishes, which the placement log records (§5.1) |
| RQ-C | **One probe account measures admission and wallet availability through one account partition**, which is not representative of other accounts; and the payouts probe needs a probe supplier that POL-06 does not designate | POL-06, X2-N1 | Allow a small set of designated probe accounts spread over the account owner's partitions, and designate a probe supplier owning the probe links, with the same exclusions |
| RQ-D | **The aggregation window of the p99 latency targets is not stated** (per hour, day or month), nor whether p99 is per serving region | POL-06, X2-N3 | Per calendar month and per serving region, like availability; RFC-006 measures so (§16.1) |
| RQ-E | **"Told within `affected_notice_time`"** cannot be met when the holder's own endpoint is down | P1-S26, P1-S40, P1-S50, POL-07 | Define "told" as the notice recorded in the account's notice list and its first delivery attempted within the time |
| RQ-F | **The go-live fibre condition in the requirements is weaker than the one the architecture's cut analysis relies on.** X2's constraint (and the glossary's *Serving region*) asks only that each serving region have two diverse paths, one to R3 not via the other; RFC-000 §5.1 requires two Nairobi–Mombasa paths and both Johannesburg paths, all four pairwise without shared risk. Under the requirement's wording, R1 could have one path to R2 and one to R3, and a single Nairobi–Mombasa cut would put R2's traffic to the leaders through Johannesburg | X2 constraints, glossary | Align the requirement with RFC-000 §5.1; RFC-006 verifies the stricter condition (§18) |

## Architecture issues

Defects or gaps found in RFC-000 while writing this RFC. RFC-000 is not changed here; each
is raised for its next revision. None blocks this RFC, which follows RFC-000 as accepted.

| # | Issue | Where in RFC-000 | Proposal |
|---|---|---|---|
| AI-1 | **The monitored invariant's right-hand side holds by construction.** `τ = max(ack_budget, ε + δ_x)` makes `τ > ε + δ_x` (or `≥`) true for the configured values, so monitoring the invariant as written detects nothing; and `δ_x` is quoted at p99, while P2-S93 needs every release durable by `D`, a tail requirement | §4.3, R4 | State the monitored quantities as measured `ε` and measured `δ_x` at p99.9 (and its maximum) against the configured values, with every late release counted, as §4.4 does; quote `δ_x` at p99.9 |
| AI-2 | **The 2 + 2 reconfiguration waits for a declaration**, so between a region's loss and the declaration (and for the whole of a fibre isolation, which is never declared) every group runs on three of five voters with no fault tolerance. The single-voter steps are safe even if the region is only isolated (V-07, W-02), so nothing requires waiting | §5.1 | Let placement start the steps automatically after a sustained loss (`region_detect` plus 10 min), independently of the declaration, which would then govern only measurement; revert by the restoration steps. RFC-006 keeps the declaration trigger until RFC-000 decides |
| AI-3 | **Leader placement is stated for admission leaders only.** RFC-000 §3 and §5.1 keep "all admission leaders" in one region; ingestion, ledger, payments and the other owners are unstated | §3, §5.1 | All leaders of all groups follow the same preference and fail over together (RFC-006 §5.2), so no owner's commands cross regions in steady state and the failover reasoning is one |
| AI-4 | **Status replicas are not identified.** §4.6 relies on "replicas of the account owner's log" holding read leases, and §6 sizes 100,000 polls/s on them, but §5.1 lists only five voters, one of them in R3, which serves no reads | §4.6, §5.1, §6 | Name the three Kenyan non-leader voters plus status learners per Kenyan facility (RFC-006 §2), and count their lease acknowledgements in the report-position delay (they are within 10 ms) |

## Traceability

**X2 scenarios (RFC-006 primary).** "Also" names the RFC that specifies the mechanism the
measurement observes.

| Scenario | Approach section | Also |
|---|---|---|
| X2-S01 Availability per capability | §15.3, §8.1, §8.2, §9, §18 | — |
| X2-S16 Available minute, 90% of probes | §15.1, §15.3, DT-13 | — |
| X2-S18 Each capability probed by its own operation and limit | §15.2 | — |
| X2-S20 Probes end to end without business side effects | §15.4, DT-14 | RFC-002 (intake rule), RFC-003, RFC-004 (exclusions) |
| X2-S24 Probe account on a credit limit, never invoiced | §15.4 (rule 4), §15.1 | RFC-004 (credit holds, invoicing) |
| X2-S21 Funds holds and headroom checks at admission's targets | §8.1, §3.4, §9, DT-03 | RFC-002, RFC-004 Part A (in the account owner) |
| X2-S02 Ingestion may lag, never loses an accepted record | §7, §3.7, §10.5 | RFC-003 |
| X2-S03 Admission sustains the design load | §17, §17.5 | RFC-001, RFC-002 |
| X2-S04 Metering keeps up with the design volume | §17, §17.5 | RFC-003 |
| X2-S05 Single-link answer within `ack_budget`, any length | §16.1, §17.5 | RFC-001, RFC-002 (path), RFC-000 §3 (budget) |
| X2-S15 Final answer with no capacity in flight | §16.1, §6.4 | RFC-001, RFC-002 |
| X2-S06 Route acknowledged within `ack_budget`, outcome by deadline | §16.1, §4.3, §4.4 | RFC-002 |
| X2-S07 Top-up credited within 10 s | §16.2 | RFC-004 |
| X2-S22 Accepted record counted in headroom within `attribution_lag_max` | §8.3, §16.2 | RFC-003 |
| X2-S17 Standing reaches network operations within `standing_notice_time` | §16.2 | RFC-004 |
| X2-S08 Suspension enforced within 60 s | §16.2 | RFC-004; network operations |
| X2-S13 Charges posted within target and bound | §8.3, §16.3 | RFC-003, RFC-004 |
| X2-S19 Disaster minutes excluded, charges within target + 1 h, none lost or doubled | §6, §8.1, §8.3, §16.3, §16.4 | RFC-004 (per-line deduplication) |
| X2-S23 During a disaster latency is suspended, deadlines and RPO 0 hold | §6.2, §7, §4.3, §4.4, §16.4, DT-10 | RFC-002 (deadlines) |
| X2-S09 A fact survives a node or zone loss | §7, §9, §20.2, DT-01, DT-12 | — |
| X2-S12 No fact lost on a region loss | §7, §5.4, §6.2, §9, §20.2, DT-02, DT-10, DT-11 | — |
| X2-S14 Acknowledged only once durable in two regions | §7, §3.2, §10.1, DT-01 | RFC-002, RFC-003, RFC-004 (each acknowledgement) |
| X2-S10 Recovery time per capability and scope | §8.1, §3.4, §5.4, §9, §20.2, DT-02 | — |
| X2-S11 Retrieval at the end of the retention period | §11, §12.2, DT-15, DT-16 | — |

**Other scenarios to which RFC-006 contributes a contract** (primary RFC named; the
scenario is satisfied there).

| Scenario | RFC-006 contribution | Primary |
|---|---|---|
| P1-S26, P1-S40, P1-S50 Affected and restoration notices within `affected_notice_time` | §13 delivery and timing | RFC-001 (flags), RFC-002 (holders) |
| P1-S33 Schedule as known at a past time | §11 storage, indexes, `as_known_at` | RFC-001 |
| P1-S54, P1-S62 Release within `release_grace` while a record or schedule owner fails over | §3.4 failover in seconds, §8.1 | RFC-001, RFC-002 |
| P2-S04 Whatever fails, never booked on some legs only | §3.4, §3.5 (one writer, takeover) | RFC-002 |
| P2-S09 Webhook sent, signed, retried | §13, DT-17 | RFC-002 (outcome), RFC-005 (signing) |
| P2-S10, P2-S99, P2-S107, P2-S108, P2-S111 Status reads, report position | §3.6 report position, read leases, lease-status query; DT-04, DT-05, DT-06 | RFC-002 (replica rule) |
| P2-S22, P2-S23 Interrupted requests resumed or failed | §3.4 takeover, `on_lead` | RFC-002 |
| P2-S93 Every hold released at the deadline | §4.3, §4.4 (`δ_x`, `τ`, alarms), DT-08, DT-09 | RFC-002 |
| P2-S104, P2-S106 Decision record unavailable at the deadline | §3.4 (seconds to a new leader), §14 alert | RFC-002 |
| P2-S51, P2-S53 Requests in trouble visible; pending at deadline alerted | §14, DT-18 | RFC-002 |
| P3-S31 An accepted record is never altered or removed | §11.1, §11.4 | RFC-003 |
| P3-S36 Recomputing a period gives the recorded charges | §11.1 (inputs kept), §11.3 replay | RFC-003 |
| P3-S39 Records retrieved by reservation, link and minute | §11.3 entity indexes | RFC-003 |
| P4-S23 Buyer told when reservations are released | §13 | RFC-004 |
| P4-S71, P4-S72 Movements trace to facts; past headroom rebuilt | §11.3 replay and projections | RFC-004 |
| P4-S90, P4-S104 Reconciliation at a consistent cut | §3.6 durable closed positions, §3.3 `ts` rule, DT-07 | RFC-004 |
| P4-S54, P4-S80, P4-S81, P4-S91 Differences and late reconciliation alerted | §14 | RFC-004 |
| X1-S11 Webhook verifiable | §13 (event ID and timestamp signed) | RFC-005 |
| X1-S24 Webhook only to its own account's endpoint | §13 (endpoint from identity, per-account queues) | RFC-005 |
| X1-S14, X1-S15 Changes record principal and time; audit record cannot be altered or removed | §11.1, §11.4 (write-once, hash chain), DT-15 | RFC-005 |
