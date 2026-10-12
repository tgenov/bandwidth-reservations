# RFC-006. Availability, durability and operations: the platform layer

| | |
|---|---|
| Status | **Draft, revision 7.** Revision 7 rebases revision 6 on the requirements at tag **`requirements-v1.11`** (from `requirements-v1.9`; [review 35](../reviews/35-requirements-amendments-before-c4.md) and [review 65](../reviews/65-requirements-amendments-after-c4.md)) and on RFC-000 **revision 4.5**, and makes RFC-006 conform to the **frozen contracts C01 … C12**. **C01 (platform contract) is the contract that RFC-006 provides**: where this RFC and C01 differ, C01 governs, and this revision changes the RFC to agree with it. Revision 7 applies every erratum, consumer obligation and settled item that names RFC-006 in C01 (§10.3, §11, review 47 D1 … D4, V59-1 … V59-7, N-01, N-12), C02, C03, C04, C05, C06, C07, C08, C09, C11 and C12, and the RFC-006 rows of RFC-000 revision 4.5 (with AI-41-5 and AI-48-3). See "Revision 7 resolution" at the end. Revision 6 was **accepted** at C3 on [fix verification 34](../reviews/34-rfc-006-fix-verification.md); it answered [review 33](../reviews/33-rfc-006-review.md) (D1 … D4). Revision 5 answered [review 27](../reviews/27-rfc-006-review.md) (D1 … D7); revision 4 answered [review 20](../reviews/20-rfc-006-review.md) (D1 … D7); revision 3 rebased on `requirements-v1.7`; revision 2 rewrote the platform for RFC-000 revision 4's substrate (CockroachDB at 2 + 2 + 1, NestJS owners, Kafka fed by a transactional outbox); revision 1's custom multi-group Raft platform is a rejected alternative (Competition). Each revision's resolution table is at the end |
| Satisfies | X2-S01 … X2-S33 (all 33 X2 scenarios, as primary RFC), including **X2-S33** (new in `requirements-v1.10`: a slot probed short is a probing fault, alerted to network operations), X2-S30 (amended in `requirements-v1.10`: a slot-minute fails when every probe the slot got failed, however few), X2-S31 and X2-S32 (new in `requirements-v1.8`) and X2-S27, X2-S29 (amended in v1.8). Contributes the platform (C01), history, notifier, alerting and backup contracts to P1-S26, P1-S33, P1-S40, P1-S78, P3-S71, X1-S39, P1-S50, P1-S54, P1-S62, P1-S63, P1-S72, P1-S75, P2-S04, P2-S09 (amended in v1.11: a change answered `pending` too), P2-S10, P2-S22, P2-S23, P2-S51, P2-S53, P2-S93, P2-S99, P2-S104, P2-S106, P2-S107, P2-S108, P2-S111, P3-S31, P3-S36, P3-S39, P4-S23, P4-S54, P4-S71, P4-S72, P4-S80, P4-S81, P4-S90, P4-S91, P4-S104, X1-S11 and X1-S24 (amended in v1.11: supplier webhooks too), X1-S14, X1-S15, X1-S31, X1-S34, X1-S37, whose primary RFC is named in the traceability table |
| Policies | POL-04 (`ack_budget`, `status_staleness`, `webhook_retry`, "told": one delivery carries many notices, each first attempted when the delivery is), POL-06 (targets; the available minute; **v1.10: a failing slot-minute is a slot that got at least one probe in the minute, every one failing within `slot_probe_limit` (1 s), however few; a slot probed short (fewer than 3 probes, or from one location, none included) is a probing fault, alerted to network operations, and does not by itself make the minute unavailable**; probe accounts and probe supplier; p99 per calendar month and serving region; declared region disaster with four eyes, counted from the recorded loss or from the first of `disaster_probe_minutes` measured failing minutes, whichever is earlier; go-live fibre condition), POL-07 (`affected_notice_time`; "begun committing" judged by the displacement record; a maintenance booking cut at a reduction's effect is told to its supplier; **v1.11: a notice due while the link's schedule owner fails over is due within `affected_notice_time` + `release_grace`**), POL-14 (`attribution_lag_max`, `max_lateness`, the lateness bound), POL-15 (each probe account's `credit_limit`), POL-16 (notices), POL-18, POL-19 (`erasure_max` in every copy; a non-conforming payload unrecoverable in every copy by `dispute_window` + 7 days, kept only if the caps and the store allow; v1.11: a shared record erased whole, payout-destination details erased once their payouts are reconciled, RFC-005's, no change to the copies RFC-006 keeps), POL-24 (retention pending legal confirmation; v1.11 `provider_unreceived_alert`, RFC-004's, routed by §16), POL-26 (`release_grace`, the deadline, the commit fence), POL-29 (7-year identities), POL-32 (network operations declares and ends disasters with four eyes; `approval_expiry`; compliance four eyes for an erasure without request; v1.11: credit limits above `credit_limit_four_eyes_above` with four eyes, which no probe-account limit reaches, §17.4) |
| Builds on | [RFC-000](RFC-000-architecture.md) **revision 4.5** (revision 4 and its errata 4.1 … 4.5), the requirements at tag **`requirements-v1.11`** (which include v1.6 … v1.10), and the frozen contracts **C01 … C12** in `docs/04-delivery/contracts/` (C01 version 1, provided by RFC-006; C02 1.0.0; C03 2.4; C04 2.3.1; C05 1; C06 1; C07 1.1; C08 1.1; C09 1.1; C10 1.0.0; C11 1.0.0; C12 1). From RFC-000: §1 principles A1 … A11 (A1 with the named platform read roles of revision 4.5), §2 components, §3 latency budget, §4.3 the confirm fence, `ε`, `δ_x_cfg`, `τ` and the monitored quantities, §4.5, §4.6, §5.1 topology, §5.2 owner leases, generations and fencing, §5.3, §5.4, §5.5, §6 sizing, §8 rows (each now a summary of its contract), R1, R2, R4, R13, R14, R16, R18 … R21, R23, R24 |
| Prior decisions | **Contract decisions (binding)**: C01's settled points M1 … M13 and N1, review 47's decisions D1 (one `PROBING_FAULT` episode per region and minute), D2 (a stop is acknowledged once enforced at the slot fence), D3 (the database copy wins a feed content conflict) and D4 (`STALE_SENDER` with a higher generation is a superseded command), and RFC-000 4.4's C4-7 (C01 is the single definition of the move hooks, `Moving`, `Stopped` and the splitting state); C08 S-M2 … S-M5; C09 S-M1 … S-M3; C03 D39-3; C06 D7 and m10; C05 S-4; C07 S1. **Review 33's decisions D1 … D4 (binding)**: D1 the probe sites arbitrate whether the other region is passing for an anycast withdrawal, and with no arbiter reachable a region never withdraws; D2 automatic Kafka leader consolidation on a metro split; D3 a **splitting** state during a lazy slot doubling, the head row authoritative for the moving half; D4 `min.insync.replicas` lowered to 2 automatically on a correlated in-sync shrink. **Review 27's decisions D1 … D7 (binding)**: D1 the R2 gateway fallback always on, plus consolidation and drain on a metro split; D2 Kafka failure detection about 3 to 4 s; D3 never withdraw the last announcing region; D4 a fixed reserved first-attempt concurrency of 16 per endpoint with a 1 to 2 s connect timeout, AIMD for retries only; D5 one primary platform rotation of at least 6, about 12 rostered engineers a go-live condition; D6 hot-link moves at load with pre-warm and bounded `Moving`; D7 account slot counts doubled only, accounts moved lazily, probe accounts last. Review 20's decisions D1 … D7 (binding): D1 and D2 are now `requirements-v1.8`; D3 Kafka `min.insync.replicas` 2 on a facility lost or drained; D4 batched webhooks of up to 100 events; D5 cold archive on two providers' object storage in South Africa with one Kenyan hot copy; D6 a per-slot internal page; D7 an isolated region is not declarable. RFC-000 revision 4.2 R24 resolution: **more account slots** are the default lever and the second in-flight account batch the spike fallback |

Terms are used in the sense of the [glossary](../02-specs/glossary.md). "Reserved rate" is
capacity and "traffic" is bytes. Every round-trip time, latency, volume, size, rate and
count below is an **estimate** (marked "est.") unless it is a requirement's own figure or
a configured value; the R1 spike (§22.1) replaces the estimates with measurements. Design
parameters that are not policies (lease lengths, intervals, retention of transport data
and the like) are named in `code` and listed in §12.10; changing one changes no mechanism.
Database and Kafka settings are named as the products name them; where a setting's exact
name or behaviour depends on the release Share deploys, the text says so and the spike
confirms it.

**Revision 2 in one paragraph.** Share writes no consensus code. Every owner's log is an
insert-only table in one self-hosted **CockroachDB** cluster whose ranges each have five
voters, one in each Kenyan facility and one in R3, with range leases preferred in R1 and
then R2 and one non-voting replica per Kenyan facility on the account tables for status
reads (§3). Owners are **NestJS** services; each slot of partitions is held by one owner
process through a **session** row it heartbeats and a **slot row** carrying the epoch that
fences every write, which is one transaction conditional on that epoch (§4). Feeds leave
through a **transactional outbox**: the owner publishes committed rows to **Apache Kafka**
and a CockroachDB **changefeed** relays the same rows as the guaranteed path (§5); Redpanda
is not used (§5.1). Clocks are disciplined by GNSS and PTP so that the database's
**`max_offset` of 100 ms** holds with a wide margin, with an alarm ladder at 20, 40, 50 and
80 ms (§6). Placement keeps owner slots with range leases, fails both over region-wide,
and reconfigures every range to **2 + 2** automatically once a region has been unreachable
for `region_detect` + 10 min (§7, §8). The declaration of a region disaster now governs
measurement only, needs two network-operations operators, and counts from the loss the
system recorded (§8.2, §8.3). Probes, history, the notifier and the measurement method
are kept and re-based (§13 … §18); capacity, bandwidth and 7-year storage are re-costed
(§19); backups are CockroachDB backups to GCS and Ceph beside the write-once archive (§14).

**Revision 3 in one paragraph.** The substrate is unchanged. The owner runtime now commits
**one batch transaction per slot** (every partition of the slot with entries pending, each
with its own head row; §4.3, RFC-000 AI3-11), link slots get **two hot standbys** fed by the
holder's push (§4.4, AI-R1-12), and report positions travel as **per-slot markers** on a
slot-keyed outcome topic (§4.6, §5.3, B-AI-8). The account owner's role may read the link
owners' displacement markers and nothing else of theirs (§3.7, AI-R1-11); the truncator
deletes only below audit's verified sealed-through watermark (§13.2, AI5-8). A region with
no recorded loss may be declared on **probe evidence**, `disaster_probe_minutes` (5)
consecutive minutes in which admission was not available there, counted from the first of
them (§8.2, §8.3, X2-S29). The personal-data store is backed up apart, tagged with its key
generation and deleted with it, so an erasure reaches every copy within **`erasure_max`**
(30 days) of the request (§14.4).

**Revision 4 in one paragraph.** The owner runtime is re-proved against review 20. An
acquisition **revokes** the expired holder's session, and a renewal succeeds only on a
non-revoked session, so no renewal can be serialised after a successor (§4.2). A read lease
is granted only if it ends inside the granter's lease view, and **every** new holder,
handoff included, reports nothing for `read_lease` + ε after its acquisition (§4.6).
Session, slot and timing rows are **sharded** over many ranges, and a renewal that fails
only because a range is unavailable keeps the process's warm state: it renews or re-homes
its slots instead of exiting, so one database node can no longer expire the platform
(§3.2, §4.2, §4.4). Partitions carry a **generation**, head rows are keyed by partition, and
feeds carry **per-stream sequences** (§3.7, §4.5, §5.5). Slot counts follow RFC-000's
occupancy target (about **16,384 account** and **4,096 shared link** slots), marker-only
transactions run outside the lane, and the database is re-sized for the resulting
transaction count (§4.1, §4.3, §19.2). Placement owns the **account slot map** and one
probe account per slot (§7.1, §17). Measurement follows `requirements-v1.8`: measured
failing minutes as evidence, the per-slot rule with at least 3 probes from two locations,
the earlier-of rule (§8.2, §8.3, §17.3). Kafka lowers `min.insync.replicas` on a facility
loss or drain, a metro split and a Kenyan-link cut are topology states, webhooks are
batched, and the archive keeps two cloud copies with two providers in South Africa and one
Kenyan hot copy (§5, §7.3, §13, §15).

**Revision 5 in one paragraph.** Three mechanisms of revision 4 get the reporting and
closure proofs they lacked (review 27). A renewal that succeeds after the holder's own
lease view had ended is a **resume**, and a resume, like a re-home, is an **acquisition for
reporting**: a present-time resume read resolves every in-flight batch, and no read lease
is granted and nothing reported below its timestamp (§4.2, AI-27-1). A **partition move**
pre-warms the new slot, and `adopt` commits only once the old slot's report position has
passed `moved`, which the database checks; readers answer a moved partition by rule 4, and
the new slot reports nothing for it until `read_lease` + ε after `adopt` (§4.5, §4.6,
AI-27-2). **Feed closure** is computed by a single-writer **closure emitter** per relayed
owner kind as the minimum over every changefeed partition of what the relay has published
and acknowledged, and `CLOSED(t, feed_seq)` reads each link's `feed_seq` from its head row
as of `t` (§5.3, AI-27-3). Besides: standbys detect expiry by a present-time point read;
the owner's gateways fall back to the other Kenyan region, so a metro split costs seconds,
and the cut-off facility is drained; Kafka detects a dead broker in about 4 s; the last
announcing region is never withdrawn; first webhook attempts get 16 fixed slots per
endpoint; moves have owner hooks; account slot counts are only doubled; consumed contract
points (deletable projections, the retry keeping intents, the audit `chain`) are added; the
audit changefeeds and changefeed CPU are costed (36 database nodes per facility); one
platform on-call rotation of at least 6 with about 12 rostered engineers is a go-live
condition. `requirements-v1.9`'s 1 s `slot_probe_limit` takes the probe latency tail out of
the slot rule (§10.2, §17.3).

**Revision 7 in one paragraph.** The frozen contract C01 is now the interface of this
platform. Section 12 refers to C01 and does not repeat its signatures. The other sections
change where they disagreed with C01. The head row has an `adopted` column, and a moved
partition is served only after `adopt` commits (§4.5). The report position of a slot and
its marker sequence are on `owner_slot`, not on a head row of partition `''` (§3.7, §4.6).
Markers form a chain per slot, with `prevReportPosition`, `pendingAnswered` and chunks
(§4.6). An integrity stop is acknowledged only when it is enforced at the slot fence, by
`stops_version` (§4.3, §14.3). An `Ambiguous` batch is resolved by a present-time read
before the slot decides again (§4.3). Closure markers go on separate closure topics that
only the closure emitter can write (§5.3). Placement splits slots by a handshake with the
holder (`ackSplitting`, `listPartitions`) and doubles the slot count in C01's order
(§7.1). Alerts are episodes (§16). The slot rule follows `requirements-v1.10`: a slot
that got probes in a minute, all failed, makes the minute unavailable, however few the
probes. A slot probed short is a probing fault, which goes to network operations (§17.3).
The notifier follows C03, C04 and C08: it tells holders only from `AFFECTED_NOTICE`, in
40 s, and its delivery worker signs each delivery (§15). The restore of the personal-data
store follows C09 (§14.4).

## Need

RFC-000 revision 4 (as corrected by revisions 4.1 and 4.2) decides the shape: single-writer owners (A1, A2), each partition an
append-only log in a distributed SQL database whose every commit is acknowledged by a
majority that spans two regions (A3), five voters per range placed 2 (R1 Nairobi) + 2 (R2
Mombasa) + 1 (R3 Johannesburg, GCP `africa-south1`), range leases and owner leases in one
Kenyan region, reconfigured to 2 + 2 after a sustained region loss. It leaves to this RFC
everything that makes that shape run and be measured (RFC-000 §5.5, §7, §8):

1. **The platform layer** (X2-N4, X2-N5): the database's topology and configuration (zone
   configurations, voters and non-voters, lease preferences, closed timestamps, follower
   reads, changefeeds), the log-table schema conventions, and the owner runtime (sessions
   and their revocation, slot leases, epochs and generations, epoch-guarded batch
   transactions, reload on failure, standby tailing, read leases and the report position,
   per-stream feed sequences), as a contract complete enough for RFC-001 … RFC-005 to
   build on. That contract is now frozen as **C01**, which RFC-006 provides (§12).
2. **The feeds** (RFC-000 §5.5, §8): the outbox, the changefeeds, the Kafka cluster and its
   topic conventions, and webhook delivery.
3. **Time** (RFC-000 §4.3, R4): the GNSS-disciplined clock discipline that the 100 ms `max_offset` relies
   on, the owner hosts' offset check, `δ_x` per topology state at p99.9, and the monitored
   quantities (AI-1).
4. **Failure handling with stated numbers** (X2-N5, R16): detection, region-wide failover
   of every range lease and owner slot within admission's 1 min RTO, the automatic 2 + 2
   change (AI-2), declaration and restoration, and what each failure does to RPO, RTO,
   availability and latency.
5. **RPO 0** (X2-N4) for every fact and failure scope, during a declared disaster too.
6. **RTO per capability** (X2-N5) and the per-minute arithmetic for the hot standbys on the
   rating paths, with the about-5 s takeover RFC-000 fixed (AI3-9).
7. **Measurement** (X2-N1, X2-N3): the probes, the designated probe accounts (one per
   account slot, from placement's account slot map) and probe supplier, the available
   minute with `requirements-v1.10`'s failing slot-minute and probing fault, percentiles per calendar
   month and serving region, and the disaster exclusion from the recorded loss or from a
   run of measured failing minutes, whichever is earlier.
8. **Capacity** (X2-N2) at POL-06's provisional design load (×50) on this substrate, and
   the load test that accepts it.
9. **Retention for 7 years** (X2-N6, POL-19, X1-N8, P3-N11): history, the write-once
   archive, storage, backups and restore tests, and the personal-data store's backups and
   key destruction (A11, X1-N11).
10. **The notifier and the operational alert feed** (RFC-000 §2, §8).
11. **The diverse-fibre go-live condition** as `requirements-v1.6` now states it (RQ-F).

What hurts if this is wrong: an acknowledged fact lost on a region loss (finance cannot
trust the books, X2-N4); two writers for one link after a slow failover (an oversell,
POL-05); a confirm accepted after its fence because a clock drifted (POL-26); a region
failover that takes longer than admission's 1 min RTO because thousands of slots and
range leases move at once; availability that cannot be audited because the probes measure
the wrong thing or a declaration can be timed to flatter the figure.

## Approach

### 1. Scope and building blocks

| Block | What it is | Section |
|---|---|---|
| **Database** | One self-hosted CockroachDB cluster (enterprise licence) over R1, R2 and R3: every owner's log, head, projection and outbox tables, the session and slot tables, placement, timing and approvals tables | §3 |
| **Owner runtime** | A NestJS module every owner service embeds: sessions, slot acquisition, epoch-guarded batch transactions, standby tailing, read leases and report positions, outbox publishing, timers, payload encryption hooks. It is the implementation of the platform contract **C01** (§12) | §4, §12 |
| **Kafka and the relay** | One Apache Kafka cluster over the four Kenyan facilities (no broker in R3), the changefeeds that relay outbox rows to it, and the consumer conventions | §5 |
| **Time** | GNSS-disciplined NTP in every Kenyan facility (PTP only if the spike needs it), NTP from Kenya to R3, the offset checks and the alarm ladder | §6 |
| **Placement** | The placement controller: the **account slot map** and slot groups, slot preferences, region preference, topology state, zone-configuration changes (failover, 2 + 2, restoration), disaster records, timing parameters, probe-account provisioning | §7, §8, §17 |
| **History** | Sealing of owner logs into the write-once archive (two cloud copies with two providers in two South African regions, one Kenyan hot copy for 13 months), indexes, the "as known at T" query and replay, truncation of the live tail below audit's watermark, the checkpoint store | §13, §12.11 |
| **Backups** | Scheduled CockroachDB backups to GCS and to Ceph in R2, restore tests, the personal-data store's own backups (Kenyan Ceph only, 7 days, generation-tagged) | §14 |
| **Notifier** | Outbound delivery: webhooks, notices, alerts to people | §15 |
| **Alerting** | The operational alert feed and its routing | §16 |
| **Probes** | Probe runners at three locations outside each serving region; one probe account per account slot, the probe supplier, probe links and exporters; the measurement pipeline (available minutes, measured failing minutes and slot-minutes) | §17, §18 |

It does not specify any owner's state machine, entry kinds or business rules (RFC-001 …
RFC-005), the signing of webhooks or the payload-encryption library (RFC-005), or the
exclusion logic inside rating and settlement (RFC-003, RFC-004), beyond the contract they
must meet.

### 2. Topology: sites, facilities, racks and nodes

RFC-000 §5.1 fixes the regions, the voter placement and the leader region. RFC-006 adds
the facility layout and the node roles.

| Site | Facilities ("zones") | Node roles |
|---|---|---|
| R1 Nairobi (Share data centres, serving) | Two independent facilities, `r1a` and `r1b` (own power and fibre entry), **to be confirmed by Share's platform team** (RFC-000 R2; §20.4) | Database nodes (one voter and, for account tables, one non-voter of every range per facility; range leases while R1 is preferred); owner hosts (slot holders and in-region hot standbys); status-reader hosts; Kafka brokers; one KRaft controller; edge nodes; stateless workers; a small Ceph cluster (personal-data store backups, link checkpoints); GNSS time servers |
| R2 Mombasa (Share data centres, serving) | Two independent facilities, `r2a` and `r2b`, to be confirmed likewise | As R1, and the Kenyan **hot archive** copy and the Kenyan database backups on R2's Ceph cluster (§13.2, §14.1). Range leases and owner slots only after a region-wide failover, or after the R1 spike shows Mombasa nearer to R3 (RFC-000 R2-D7); its owner processes are the cross-region warm standbys meanwhile |
| R3 GCP `africa-south1` (voter only) | Google's zones `r3a`, `r3b`, `r3c` | Database nodes only: one voter of every range, spread over the three zones; a standing non-voter of every admission range in a zone other than its voter's (§8.1); a second voter set kept as stopped VMs with provisioned disks under a capacity reservation (§8.1); one KRaft controller (metadata only, never the active controller, §5.2); the GCS archive and backup buckets. No edge, no owner process, no Kafka broker, no status reader (RFC-000 AI5-3) |
| AWS `af-south-1` (Cape Town; archive only) | Amazon S3 | The second cloud copy of the archive (§13.2, D5): ciphertext segments only, no compute, no database, reached by Direct Connect at a Johannesburg interconnect facility over the Kenya–Johannesburg paths |
| Probe sites | Three colocation sites per serving region, within about 10 ms, outside Share's facilities (RFC-000 D2) | Probe runners only |

**Rack layout in a Kenyan facility.** Each facility has at least **three racks on separate
power distribution** (A, B, C), and every role is spread over them: database nodes
round-robin by rack, owner hosts and status-reader hosts likewise, the Kafka brokers two
per rack, the KRaft controller in rack A, the two time servers in racks A and B, edge and
worker nodes in every rack. The database is started with the locality
`region=<r>,zone=<facility>,rack=<rack>`; replica constraints are at facility level (one
voter per facility, §3.2), so a rack loss costs at most a few nodes of each role and never
more than one replica of a range, and the allocator's diversity rule keeps a range's
non-voter in a different rack from its voter. Kafka brokers carry `broker.rack` = the
facility (§5.2). Each rack has two top-of-rack switches to two spine switches; each
facility has two diverse building entries, one towards each Nairobi–Mombasa path (§20).

**R3 layout.** R3's database nodes run in a GCP project with Share's own VPC, reached over
two Partner or Dedicated Interconnects, one terminating the Nairobi–Johannesburg path and
one the Mombasa–Johannesburg path (§20). Nodes carry `region=r3,zone=r3a|r3b|r3c`; GCP
zones are the racks of R3.

**Where state lives.** Every range has five voters on five different nodes in five
different facilities or zones. The account tables also have one **non-voting replica per
Kenyan facility**, which with the three Kenyan voters other than the leaseholder's back the
**status readers** (RFC-000 §4.6, AI-4): one status reader per Kenyan facility (§4.6). Every
serving region therefore answers status and headroom reads from its own metro. R3's
replicas serve no reads.

**External reachability.** Buyers, suppliers, exporters and payment providers reach the
edges through anycast addresses that Share announces by BGP from both R1 and R2 (Share runs
its own network), withdrawn from a region whose edge fails its health check; DNS names
with a 30 s TTL are the fallback. The **edge health check** (R6-27) is not only "the edge
process answers": every 2 s each edge node makes a **canary commit**, an append to the
canary partition of one account slot and one link slot chosen round-robin, through the
current holders. An edge node failing three consecutive canaries is taken out of its
region's load balancing. **Whether the other region is passing is decided by an arbiter
outside both regions** (R33-02, review 33 decision D1): the **probe sites** (three per
serving region, outside Share's facilities, §17.1) each make an **unicast canary booking**
through every region's unicast edge address every 2 s and serve, over the public internet
and mutually authenticated, a signed verdict per region: "region X **announcing and
passing**" if its last 3 canaries passed and X's edges stated in their signed answers to
those canaries that X's anycast prefix is announced (V-1); a region with a withdrawn prefix
is never reported as a reason to withdraw the other. A region **withdraws** its anycast
prefix only when (a) more than half of its edge nodes fail three consecutive canaries
**and** (b) a **majority of the probe sites it can reach** report the other region
announcing and passing; if it reaches none, or no majority says so,
it does not withdraw (R27-07, review 27 decision D3). So **the last announcing region is
never withdrawn** and the rule fails closed: when both regions fail (a takeover gap under
T1, a facility loss, a database-wide fault) both keep announcing and serve errors, which
clients and AI agents retry, rather than black-holing every buyer until BGP re-converges.
The arbiter needs no path between the regions, so it works in exactly the partitions the
rule is for: in a **double Nairobi–Mombasa cut**, R2's edges fail their canaries (the
owners are in R1, no transit through R3), the probe sites see R1 passing, and R2 withdraws;
an **R1 isolated** from R2 and R3 fails its canaries, the probe sites (which reach R1's edge
over the internet) see R2 passing once its admission slots are held there, and R1
withdraws, within about 6 to 15 s (est.). A withdrawn region **re-announces** once more than
half of its edge nodes have passed canaries for 10 s; damping: after a re-announce, a
region is not withdrawn again for `anycast_damping` (5 min) except under T1 (the region
unreachable), and every withdrawal and re-announce pages. Each region's edge also has a
**unicast** address, which the POL-06 probes use, so a region's own availability is
measured even while anycast routes clients around it (§17); because they use unicast, they
do not observe an anycast withdrawal, so an **anycast-reachability canary** from every probe
site books through the anycast address every 10 s and pages when it fails (internal
detection, not the POL-06 measurement, §18.5).

### 3. The database: CockroachDB configuration

#### 3.1 Cluster, release and licence

- **One cluster**, self-hosted on Share's nodes in R1 and R2 and on GCP VMs in R3. The
  managed CockroachDB service is not usable: it runs only in cloud regions, and Kenya has
  none (Competition).
- **Release**: the vendor's current long-term-support release at go-live, with the lease
  protocol in which a range's lease is held by its Raft leader ("leader leases"), so that a
  lease does not depend on a separate node-liveness heartbeat; the spike (§22.1) confirms
  the release and measures range-lease failover with it.
- **Licence and support** (RFC-000 R18): the enterprise licence (changefeeds, follower
  reads, bounded-staleness reads, encryption at rest, backups with revision history and
  locality-aware restore) and a 24 × 7 support contract are **go-live conditions**, recorded
  with the fibre and facility conditions (§20).
- **Upgrades** are rolling, one facility at a time, after the node's leases are drained
  (§21, RB-13), so a crash loop in a new release never reaches a majority of any range.

#### 3.2 Localities and replica placement (zone configurations)

RFC-006 uses **explicit zone configurations**, not the database's multi-region SQL
abstractions (`PRIMARY REGION`, `SURVIVE REGION FAILURE`): the abstractions place voters by
region, not by facility, cannot express "one voter in each Kenyan facility" or the
non-voter layout below, and would have to be overridden table by table anyway
(Competition). The database is an ordinary one whose nodes carry localities; the zone
configurations are the contract, applied by placement (§7.1) through a privileged role and
checked every minute by a conformance report (`SHOW ZONE CONFIGURATIONS` against the
expected set; any difference pages).

**Every range** (the `default` range configuration, and the same explicitly for the
`meta`, `liveness`, `system` and `timeseries` ranges and the `system` database, so the
database's own metadata is placed like the data):

```sql
ALTER RANGE default CONFIGURE ZONE USING
  num_replicas      = 5,
  num_voters        = 5,
  voter_constraints = '{"+zone=r1a": 1, "+zone=r1b": 1, "+zone=r2a": 1, "+zone=r2b": 1, "+region=r3": 1}',
  lease_preferences = '[[+region=r1], [+region=r2]]',
  gc.ttlseconds     = 14400;
```

**Account tables** (the account owner's log, head, projection and outbox tables): five
voters as above, one **non-voting replica per Kenyan facility** for status reads, and one
standing non-voter in R3 for the 2 + 2 change (§8.1). The allocator's diversity rule puts
R3's two replicas in different GCP zones; the conformance report checks it.

```sql
ALTER TABLE account_log CONFIGURE ZONE USING
  num_replicas      = 10,
  num_voters        = 5,
  constraints       = '{"+zone=r1a": 2, "+zone=r1b": 2, "+zone=r2a": 2, "+zone=r2b": 2, "+region=r3": 2}',
  voter_constraints = '{"+zone=r1a": 1, "+zone=r1b": 1, "+zone=r2a": 1, "+zone=r2b": 1, "+region=r3": 1}',
  lease_preferences = '[[+region=r1], [+region=r2]]';
```

**Other admission tables** (link, partner adapter, session and slot tables, placement,
timing, approvals, identity): five voters and the standing R3 non-voter, `num_replicas = 6`,
`constraints = '{"+region=r3": 2}'`.

**The personal-data store's tables** (RFC-005 C12): five voters as `default`, no
non-voters, `gc.ttlseconds` = `pd_gc_ttl` (3,600), and **no changefeed** on them, ever
(§14.4).

**Every other table**: the `default` configuration.

**The platform's own control rows are sharded, never one range** (R6-03). Every
transaction of the platform reads or writes one of three small tables: `owner_session`
(renewed by every process twice a second), `owner_slot` (read by every batch as the fence)
and `platform_timing` (read by every confirm). As single ranges, the loss of the one node
holding a range's lease would stop renewals, every batch or every confirm in the platform
for the range-lease failover (4 to 9 s, est.), longer than `session_ttl`. So:

| Table | Key | Pre-split | Effect of one database node loss |
|---|---|---|---|
| `owner_session` | (`shard`, `session_id`), `shard` = hash(`session_id`) mod 64 (a hash-sharded primary key) | 64 ranges, one per shard | Only the sessions in the shards whose leaseholder was on the node (about 1/48 of shards, 1 or 2) cannot renew for the failover; their processes keep their warm state and renew or re-home once the range is back (§4.4) |
| `owner_slot` | (`kind`, `slot`) | At every 64 slots of each kind (about 400 ranges, est.), the same boundaries as the kind's log and head tables (§3.6) | Only the slots whose fence row was on the node pause, about the same slots whose data ranges pause anyway |
| `platform_timing` | (`shard`, `version`), 64 identical copies per version, one per shard; a confirm reads shard `slot mod 64` | 64 ranges | Only the confirms of the slots reading that shard pause; placement writes every new version to all 64 copies in **one** transaction, so a version is never visible in one shard and not another (§6.4) |

Their leaseholders are spread over `r1a` and `r1b` by the allocator's load-based lease
placement within the preference `[[+region=r1], [+region=r2]]`, which the conformance
report checks (no more than 60% of any table's leases in one facility).

| Replica | Count per range | Role |
|---|---|---|
| Kenyan voter | 4 (one per facility) | Quorum; leaseholder candidates (R1's two first, then R2's) |
| R3 voter | 1 | Quorum only; never preferred for the lease |
| Kenyan non-voter (account tables) | 4 (one per facility) | Follower reads for status readers; no vote, so no effect on commit latency |
| R3 non-voter (admission tables) | 1, in a zone other than R3's voter | Promoted to voter by the 2 + 2 change in seconds rather than bootstrapped (§8.1) |

No region holds three voters, so every majority (3 of 5) contains voters in at least two
regions, and a commit is durable in two regions by construction (A3, X2-N4). The R3
non-voter does not vote and so changes nothing about that.

#### 3.3 Lease preferences and range leases

- `lease_preferences = [[+region=r1], [+region=r2]]` keeps every range lease in R1 while it
  can, otherwise in R2. The database's allocator spreads leases over `r1a` and `r1b` by
  load. R3 cannot be forbidden to hold a lease; it holds one only transiently (after the
  loss of both Kenyan candidates of a range there is no majority to lead anyway, RFC-000
  §5.1), and placement transfers any lease it finds in R3 at once.
- **Range-lease failover** after a node loss is the database's: the range's Raft leader is
  re-elected among the surviving voters (the R1 peer first, by preference) and takes the
  lease, a few seconds after the loss (est. 4 to 9 s; the spike's exit criterion is p99
  ≤ 6 s, §22.1). Writes to the ranges whose leaseholder was on the node wait meanwhile;
  nothing is lost.
- `server.time_until_store_dead` = 5 min (the default): a node silent that long has its
  replicas replaced on another node of the **same facility** (the voter constraints allow
  nothing else). A rack loss in one facility therefore heals within that facility.
- Placement changes preferences only for a region-wide move (§7.4) and restoration (§8.4);
  it never per range.

#### 3.4 Closed timestamps, follower reads and rangefeeds

| Setting | Value | Why |
|---|---|---|
| `kv.closed_timestamp.target_duration` | **1 s** (default 3 s) | The closed timestamp backs the ledger's closed positions, the changefeeds' resolved timestamps (the lifecycle feed's effective-time closure, RFC-000 §4.5, AI3-2), the history sealer's cut (§13.2) and follower reads (§4.6). 1 s keeps them within about 1.5 s of now (est.) while every owner transaction (tens of milliseconds) stays far below it, so none is pushed |
| `kv.closed_timestamp.side_transport_interval` | 200 ms (default) | Closed timestamps of idle ranges advance without writes |
| `kv.rangefeed.enabled` | true | Changefeeds (§3.5) |
| Follower reads | `AS OF SYSTEM TIME follower_read_timestamp()` for scans (sealer, standbys, reconciliation cuts); for status readers' point reads, `with_min_timestamp(P_grant, true)` (bounded staleness, nearest replica only, **never older than the report position the reader's lease was granted at**, §4.6) | A read served by a replica in the reader's own facility, never by the leaseholder; a replica not yet closed past `P_grant` refuses, and the reader answers by rule 4 instead |

A transaction whose provisional timestamp falls at or below a range's closed timestamp is
pushed above it and must re-validate its reads; an owner batch transaction that reads its
own commit timestamp (§3.7) then retries, which the runtime handles as any retry (§4.3).
With a 1 s target and transactions of tens of milliseconds this is rare; the spike counts
it.

**Consistent cuts.** A read at a fixed timestamp `T` below the closed timestamp, of any
set of rows, sees every transaction committed at or below `T` and no other, and no
transaction can later commit at or below `T` on those ranges (the closed timestamp, or the
timestamp cache the read leaves). Reconciliation and payout runs (RFC-004) read every
ledger partition `AS OF SYSTEM TIME T` with `T` = `follower_read_timestamp()` at the run's
start, record `T`, and so cut consistently (RFC-000 §4.5).

#### 3.5 Changefeeds

Every outbox table (§3.7) has one enterprise changefeed to Kafka, the **guaranteed publish
path** (§5.3):

```sql
CREATE CHANGEFEED FOR TABLE account_outbox
  INTO 'kafka://kafka-r1a-1:9093,kafka-r2a-1:9093?tls_enabled=true&topic_name=cdc.account'
  WITH envelope = 'wrapped', format = 'json', updated, mvcc_timestamp,
       resolved = '1s', min_checkpoint_frequency = '1s',
       initial_scan = 'no', on_error = 'pause', protect_data_from_gc_on_pause,
       kafka_sink_config = '{"RequiredAcks": "ALL", "Flush": {"Frequency": "5ms", "Messages": 500}}';
```

- **Relay topics** `cdc.<owner kind>` carry the outbox rows as the database committed them;
  a relay consumer per owner kind (a stateless NestJS service) re-keys each row to its
  destination topic (§5.4) with its (partition, stream, stream sequence, generation, epoch) and its outbox payload,
  which is already ciphertext. The changefeed's own payload is the row; columns in clear
  are only keys, sequence, epoch, timestamps and pseudonymous identifiers (A11).
- **Resolved timestamps** (`resolved = '1s'`) are **not** forwarded one for one. A
  changefeed hashes each row's primary key to a `cdc.<kind>` partition, so one destination
  partition's rows arrive over every `cdc` partition, and a resolved message on one `cdc`
  partition guarantees completeness for that partition only (R27-03). Destination
  closure markers are therefore emitted by the **closure emitter** (§5.3), on the stream's
  own **closure topic** `<topic>.closure` (C01 §2.5, §3.6), as the minimum
  over **every** `cdc` partition of the kind of what the relay has published and Kafka has
  acknowledged (RFC-000 revision 4.3, AI-27-3): "no row with a commit timestamp at or below
  `R` will follow" on that destination partition. On the **link schedule feed** they are
  published per link as **`CLOSED(t, feed_seq)`** markers (RFC-001): the link's feed is
  closed through `t`, and `feed_seq` is the last schedule-feed sequence of that link
  committed at or below `t`, read from the link's head row as of `t` (§5.3), so a consumer
  knows both that the minute is closed and which event it must have applied first. They are
  the lifecycle feed's effective-time closure (RFC-000 §4.5) and every consumer's safe cut.
- **Where the changefeed runs.** Its aggregators are planned by the database on nodes that
  hold replicas, R3's included; an R3 aggregator produces to Kenyan brokers over a
  Johannesburg path, carrying ciphertext payloads only. Pinning aggregators to one region
  would make the guaranteed path stop with that region; the owner's direct publish and the
  takeover republish (§5.3) cover the seconds a region-wide failover costs the changefeed.
- **Failures.** A changefeed that errors pauses, keeps its data protected from garbage
  collection (`protect_data_from_gc_on_pause`), and pages (§16); resumed, it continues from
  its checkpoint. A changefeed lost entirely is recreated with `cursor` = the oldest
  resolved timestamp any consumer has applied, which is within the outbox tables'
  `gc.ttlseconds` (25 h, §3.6) by the alarm on changefeed lag (1 h page).
- The **history sealer** does not use changefeeds: it scans log tables by follower reads
  below the closed timestamp (§13.2), which is cheaper at the log tables' volume.
- **A log table that is its own outbox** (R6-07; RFC-003's `ingest_log`). An owner RFC may
  declare a log table **self-outboxed**: its changefeed runs on the log table itself and the
  relay derives each destination event from the row. Such a table gets the outbox's
  `gc.ttlseconds` (25 h) instead of 4 h, and the truncator never deletes a row newer than
  the oldest resolved timestamp of its changefeed's registered consumers minus 1 h (§13.2),
  so a recreated changefeed always finds its history. The truncator's deletes reach the
  changefeed as delete events; the relay **drops every delete event** of every changefeed
  (deletes are never feed events), and audit's verifier treats deletes at or below the
  sealed-through watermark as the expected truncation (RFC-005 §9.3). The declaration names
  each stream the relay derives from the row and its emit function. The runtime also
  writes a **stream index** table `<kind>_stream_index` (partition, stream, `stream_seq`
  → `seq`) in the same batch, so a gap fill and history find an event by its stream
  sequence (C01 §2.3, R47-19). The relay of a self-outboxed kind holds that kind's **log
  key** and the feed keys of its streams, because it runs the emit function on the row.
  This is more trust than an ordinary relay has, which only forwards ciphertext; RFC-005's
  key-release policy states it (C01 §2.5). **RFC-003's
  `ingest_log` declares three streams** (RFC-003 revision 5): the **hand-off** (topic
  `ingestion.handoff.v1`, C11; it carries `batch`, `correction`, `supersession` **and
  `identity-conflict`** rows, C11 S-2), the **drop alert** (a non-conforming payload not kept, POL-19 v1.9,
  P3-S75) and the **hourly drop report** (drops by reason, and withdrawal counts: was kept,
  was absent, from `ingest_log`'s `withdrawn` rows that record `withdraw_payload` answers);
  the relay publishes the last two to the **operational alert feed** (§16), routed to
  network operations, as it does RFC-003's alert for a withdrawal pending more than 10 min.
  The relay treats the `withdrawn` row type like any declared row: it emits only what the
  declaration's emit functions derive. Sealing of `ingest_log`,
  like every log, uses follower reads, never its changefeed (§13.2).
- **Row-level TTL deletes** (R6-07). Outbox tables are created with
  `ttl_disable_changefeed_replication = true` where the release supports it (the spike
  confirms), so expiring outbox rows emit nothing; the relay drops delete events in any
  case.
- **No secret in a job definition** (RFC-000 AI-R5-2). Changefeed sink URIs carry no
  credential: the brokers expose a dedicated **CDC listener** (TLS server authentication)
  that admits only the database nodes' addresses and maps them to one Kafka principal
  allowed to produce only to `cdc.*`. Backup and archive destinations use implicit
  (node-environment) credentials (§14.1). System ranges therefore hold no secret; debug
  bundles are taken with redaction (`--redact`), and statement diagnostics never capture
  placeholder values.
- **Audit changefeeds are narrow** (R27-13; RFC-005 revision 5, §9.3 and C5). Audit's
  verifier consumes one changefeed per log table, about 20 beside the outbox ones. Each is a
  CDC query projecting only `(slot, partition, seq, generation, epoch, kind, chain, ts,
  event_op())`, **delete events included**, `resolved` every 10 s, into a
  `cdc.audit.<kind>` topic keyed by partition that only audit consumes (no relay, no
  payload, no key needed): about 300,000 log rows a second at about 100 bytes each, about
  **30 MB/s** (est., §19.3) instead of the full rows' about 220 MB/s. An update of a log
  row emits an update event whatever the projection, so every SQL-level change is seen;
  full chain recomputation happens at sealing (§13.2), as RFC-005 states. If the spike finds
  CDC queries unable to emit deletes, the fallback is a full-row changefeed, costed in
  §19.3 (about 190 MB/s more produced, est.).
- **Changefeeds are watched as security events** (RFC-005 §9.3). Audit's verifier consumes
  the changefeeds of every log table for chain and gap verification; any pause,
  alteration or cancellation of a changefeed is recorded through audit's append log and
  pages security as well as platform on-call (§16). **Changefeed job control** (pause,
  alter, cancel, create) is possible **only through break-glass** (RFC-005 §10), so any
  pause (an incident's, RB-16) is recorded and paged with its session reference. **Rolling
  upgrades do not pause changefeeds** (R33-14): a drained node's aggregators are re-planned
  by the database, and the resolved timestamp stalls meanwhile (est. 10 to 30 s; the spike
  measures it); the closure-lag page (§16) is raised to 60 s while placement's maintenance
  state shows a drain in progress. **No changefeed is ever created on the
  personal-data store** (RFC-005 C12).
- **Resolved interval** (R6-26). `resolved = '1s'` with the 1 s closed-timestamp target
  gives resolved timestamps about 1.5 to 2 s behind now (est.). RFC-003's planning figure of
  3 to 5 s (R3-5) is conservative and stays as its budget; the spike measures both.

#### 3.6 Other cluster settings

| Setting | Value | Why |
|---|---|---|
| `--max-offset` (every node) | **100 ms** | `ε` (RFC-000 coordinator decision); a node whose offset from a majority of its peers exceeds 80 ms terminates itself (§6.3) |
| Clock source | `chrony` from the facility's GNSS-disciplined NTP servers (§6.1) | §6 |
| `gc.ttlseconds` | 14,400 (4 h) by default; **90,000 (25 h) on outbox tables and self-outboxed log tables** (§3.5); 3,600 (1 h, `pd_gc_ttl`) on the personal-data store | The default covers historical reads, backups' protected timestamps and the garbage of the truncator's deletes (§13.2); outbox tables keep 25 h of history so a changefeed can be recreated from a consumer's resolved timestamp |
| Row-level TTL on outbox tables | `ttl_expire_after = '26 hours'`, `ttl_disable_changefeed_replication = true` | Outbox rows are transport, not record; the log is the record; expiries are not feed events (§3.5) |
| Row-level TTL on declared projections | As the owner RFC declares, e.g. RFC-001's `link_request` at **24 h**; never on a log table | Short-lived request state expires without owner deletes (the owner role has no DELETE); the log keeps the record |
| `range_max_bytes` | 512 MiB (default) | Load-based splitting (on by default) splits busy ranges; a hot link's slot is its own range at most a few hundred MB |
| Pre-splits | Every log, head and outbox table pre-split every 64 slots (account, link) or every slot (other kinds); `owner_session`, `owner_slot` and `platform_timing` sharded (§3.2) | Slot ranges start apart, so a slot's writes do not contend with a distant slot's range lease, and no control row is a single range |
| Encryption at rest | On (enterprise `--enterprise-encryption`, AES-256, store keys rotated monthly) | Every store; R3's nodes hold their own store keys, never a payload key (RFC-000 §5.1) |
| Snapshot rate (`kv.snapshot_rebalance.max_rate`) | 256 MiB/s per store | Up-replication after a node loss, the 2 + 2 change and restoration (§8) |
| Delegated snapshots | On, where the release supports them | A new R3 voter is bootstrapped from R3's existing replica, not across the Johannesburg path (§8.1) |
| `storage.max_sync_duration` | 10 s | A node whose disk stalls that long terminates itself, a node loss, instead of stalling its ranges for longer |
| Admission control | On (default) | Overload sheds at the database rather than queueing |
| Timeouts (R6-17; RFC-000 AI-17-4) | Owner sessions: `idle_in_transaction_session_timeout` = **1 s**; `statement_timeout` = 2 s on every statement **except `COMMIT`**, which the runtime sends after `SET LOCAL statement_timeout = '15s'` (above the range-lease failover p99, §3.3); the runtime itself abandons (ROLLBACK) any batch not at `COMMIT` within 2 s of `BEGIN`. History and reporting: 30 s | A paused holder's open transaction is aborted by the database within 1 s, below the lease margin, so it cannot block a successor (AI-17-4); a `COMMIT` caught in a range-lease move waits for the new leaseholder instead of becoming `Ambiguous` and causing a reload storm as the range recovers (R6-17). Reloads are also rate-limited per process (§4.3) |

#### 3.7 Schema conventions for log tables

Each owner kind has four table types (five for a self-outboxed kind), created by RFC-006's
migration tool from the owner's declaration (C01 §2.2 `OwnerDeclaration`). C01 §2.3 gives
the DDL; this section gives the reasons:

| Table | Primary key | Columns | Writes |
|---|---|---|---|
| `<kind>_log` | (`slot` INT4, `partition` BYTES, `seq` INT8) | `generation` INT4 and `epoch` INT8 (the writer, §4.5); `kind` INT2; `schema_v` INT2; `ts` DECIMAL (the commit timestamp, below); `identity` BYTES (the command's idempotency identity, A6); `emits` (the (stream, stream sequence) pairs of the feed events the entry produced, §5.5); `audit` (pseudonymous principal, role, reason code: RFC-005's field set, A11); `retention` INT2 (§13.1); `key_id` BYTES; `payload` BYTES (owner-compressed, then sealed, RFC-005 C13); **`chain`** BYTES (RFC-005 §9.3 layer 4, C5, computed by `append` in the same transaction, below; R27-12). A unique secondary index on (`partition`, `seq`) finds a partition's rows across every slot it lived in (C01 R47-01) | **Insert only.** No application role is granted UPDATE or DELETE; the truncator role alone has DELETE, and the database itself refuses any delete above audit's verified sealed-through watermark (row-level security, §13.2; RFC-000 AI5-8; RFC-005 §9.3) |
| `<kind>_head` | (`home_key`, `partition`), `home_key` = bit-reversed **`home` = hash(partition) mod `home_space`** (2²⁰, a fixed constant, independent of any slot count; R27-10); a slot's partitions are those whose home mod the kind's slot count is the slot, unless moved | current `slot`, `generation`, **`adopted`** BOOL (false from `moved` until `adopt` commits, §4.5; C01 R47-02), last `seq`, last `ts`, last `epoch`, the last sequence of each **feed stream** (`streams`), the last **`chain`** (RFC-005), `batch_id` of the last batch that wrote it. No head row exists for partition `''`; the report position of a slot is on `owner_slot` (§4.2, §4.6; C01 V59-6) | Upserted in the batch transaction. **Keyed by partition**, so a move to another slot changes columns, never the key, and needs no delete (RFC-000 AI-R6-3) |
| `<kind>_<projection>` | Owner-defined, but the key **begins with (`home_key`, `partition`) or with a logical key led by the partition**, never with `slot`; the migration tool refuses a slot-led key (C01 R47-01) | Current state derived from the log (A4), payload columns sealed likewise | Upserted in the batch transaction; **deleted** in the batch transaction only where the owner RFC declares the projection **deletable** (R27-12; RFC-001's `link_displacement` markers) |
| `<kind>_outbox` | (`slot`, `partition`, `stream`, `stream_seq`, `n`), with a secondary index on (`partition`, `stream`, `stream_seq`) for gap fill across moves (C01 R47-01) | destination topic, key, headers, ciphertext payload, `ts`, `generation`, `epoch`. Report markers use partition `''` (no head row) | Inserted in the batch transaction; expired by row-level TTL (26 h) without changefeed events (§3.6). A **self-outboxed** log table (§3.5) has no outbox table |
| `<kind>_stream_index` (self-outboxed kinds only) | (`partition`, `stream`, `stream_seq`) | `seq` of the log row that emitted the event | Inserted in the batch transaction (§3.5; C01 R47-19) |

- **Slot first, home for heads.** Log and outbox keys begin with the slot, so a slot's rows
  are contiguous, ranges split along slots, and a slot is the unit of leasing, moving and
  failure. **The slot-first rule applies only to log and outbox tables** (C02 M7; C01
  R47-01). Every row that a decision of an owner can depend on after a move has a key
  without the slot: the head row by home, projections by partition (for example RFC-001's
  `link_displacement` by (`link_id`, `request_part`, `request_seq`), C02), and the log and
  outbox through their partition indexes. So a moved partition's earlier rows are found by
  its new slot, its standbys and every later takeover, wherever they were written; nothing
  is re-keyed. Head rows are keyed by the partition's **home**, stored **bit-reversed**
  (`home_key` = the 20-bit reversal of `home`; R33-06): the homes of slot `s` under a
  power-of-two count `n` are `s, s + n, s + 2n, …`, which share their low bits, so their
  reversed keys are **one contiguous key range** for every power-of-two `n`, also after a
  doubling (the range halves). A batch of partitions that never moved therefore still
  touches one head range, and head tables are pre-split on the same reversed boundaries; a
  moved partition (a hot link, an account re-slotted, §4.5) keeps its head row where it
  was.
- **Generation.** Each partition carries a generation, incremented by each move to another
  slot (§4.5), written in every log row, outbox row, feed header and command. Writers of a
  partition are ordered by **(generation, epoch, sequence)** (RFC-000 §5.2, AI-R6-3).
- **Commit timestamp.** `ts` is `cluster_logical_timestamp()` read in the batch
  transaction, which fixes the transaction's commit timestamp to it; if the database must
  push the transaction, it fails with a retry error instead, and the runtime retries
  (§4.3). Within a partition `ts` is strictly increasing across owners (each batch reads
  the head row its predecessor wrote, so the database orders it later), and no entry is
  ever stamped at or below a closed timestamp (RFC-000 §4.3, §4.5, A0R-10).
- **Contiguous sequences.** `seq` continues the head row's `seq`, so the log has no gap
  inside one partition. Feed events do not use `seq` (most entries emit nothing on a given
  stream): each **feed stream** of a partition has its own contiguous `stream_seq`, kept in
  the head row's `streams` and assigned by the runtime in the batch that emits the event, so
  it continues across owner changes and moves, and a consumer that sees a gap knows an event
  of that stream is missing (§5.5; RFC-000 AI-17-2). Point-to-point notifications carry no
  stream sequence (§5.5).
- **Hash chain** (RFC-005 §9.3 layer 4 and C5, revision 5; R27-12). `append` computes each
  entry's `chain` exactly as RFC-005 defines it (over the row's position, fencing columns,
  identity, emits, retention, `key_id`, and the `audit` and `payload` **ciphertexts** as
  stored, from the previous chain; genesis per partition), after sealing the row and before
  commit, in the batch transaction, from the chain it holds in memory; it compares the head
  row's `chain` read in the same batch with its memory and writes the last chain to the
  head row. **On a mismatch the runtime does not stop the partition by its own authority**
  (C08 §J, R46-12): it holds the partition locally (`append` refuses its calls, and the
  owner answers "temporarily unavailable"), and it sends `integrity_report` to audit, which
  opens the stop (§14.3). The local hold stays across a restart of the holder (a takeover
  finds the mismatch again) until audit's `Resume` lifts it. A retried batch reseals
  with new nonces, so `append` **recomputes every chain of the batch on every retry**
  (§4.3). A new holder, standby or moved partition's new slot takes `chain_{n−1}` from the
  head row.
- **Grants** (C01 §2.3, R47-18; RFC-000 A1 as revision 4.5 states it). Each owner
  service's database role has SELECT and INSERT on its own kind's log, outbox and stream
  index; SELECT, INSERT and UPDATE on its own head and projections; DELETE **only** on the
  projections its declaration marks deletable (never on a log, head or outbox table);
  SELECT on `owner_session`, `owner_slot`, `platform_timing` and
  **`placement_integrity_stops`**; and UPDATE on `owner_session` and `owner_slot`, limited
  by row-level security to rows of its own kind (a batch writes only `report_through` and
  `marker_seq` of `owner_slot`). Within one kind, a forged session or slot write is
  **detected, not prevented** (the chain and the lease audit, RFC-005 §4.4). Placement also
  has a **column** grant: UPDATE of `owner_slot.stops_version` only, for every kind, used
  only by the `Stop` and `Resume` transactions (C01 V59-3). The truncator and the
  break-glass restore role are in §13.2 and §14.3.
- **Reads across owners** are only those RFC-000 A1 names (revision 4.5, C01 settled M10):
  (1) the **link displacement read** inside an owner's own transaction: the account
  owner's role has SELECT on `link_displacement` (the link owner's marker projection, keyed
  by (`link_id`, `request_part`, `request_seq`) with no slot, C02 M7; written only in the
  reduction's own batch) and on no other link table; the confirm transaction makes one point
  read per Share leg (RFC-002) under its own savepoint with a 10 ms lock timeout, and a
  timeout fails only that call's condition (C01 M3). The read joins the confirm's
  serialisable read set, so a reduction that commits after the read and before the confirm
  makes the confirm fail with a retry error (it is **retried** as a whole, not refreshed),
  and the retry re-reads and finds the marker; the reduction is never blocked by it.
  Whether a confirmation had begun committing is judged by exactly this: whether its
  confirm transaction sees the marker (POL-07, POL-26, P1-S78). The key is the same before
  and after a move of the link, so the read finds the marker across a move (C01 §3.3).
  (2) Every owner role reads `placement_integrity_stops` and the `stops_version` of its
  own `owner_slot` rows (C01 R47-04). (3) The **named platform read roles**, read-only and
  outside any owner transaction (C01 §2.3): `history_sealer` (every log, follower reads),
  `gapfill_<consumer>_<producer>` (one per named consumer kind and producer kind: the
  producer's outbox rows of the consumer's topics, by row-level security on `topic`, or a
  self-outboxed log through its stream index; follower reads), `closure_emitter`
  (`<kind>_head.streams`, follower reads at a resolved timestamp), `status_reader` (the
  account kind's log, head and projections, and the account slots' `owner_session` and
  `owner_slot` rows) and `standby` (its own kind's tables). Placement has **no** SQL read:
  it lists a splitting slot's partitions through the holder (`listPartitions`, §7.1).
  Grants are checked by the **conformance job** (§20.3) against the expected set (C01
  CP-2c, CP-11): it fails on any UPDATE or DELETE on a log table by an application role,
  any DELETE on a projection not declared deletable, a projection key led by `slot`, a
  session or slot update outside the role's kind, a placement update of an `owner_slot`
  column other than `stops_version`, or any cross-owner SELECT not listed above.
- **Encryption.** The runtime calls RFC-005's library (C13) to compress and seal every
  payload and every application column before the insert, with the table, primary key,
  sequence, epoch and kind as associated data, and keys held only in the Kenyan HSMs
  (RFC-000 AI5-3, AI-R5-2). The only clear columns are pseudonymous keys and the ordering
  and fencing columns named above (`slot`, `partition`, `home`, `seq`, `stream_seq`,
  `generation`, `adopted`, `epoch`, `ts`, `kind`, `schema_v`, `key_id`, `retention`,
  `chain`, and on `owner_slot` `report_through`, `marker_seq` and `stops_version`), and
  each projection's declared `clearColumns` (A11; C01 §3.12).

### 4. Owner leases and the NestJS owner runtime

#### 4.1 Owner kinds and slots

A **partition** is the unit of single writing (a link, an account, a partner link, an
exporter, a ledger home, RFC-000 §2). Partitions hash into a fixed number of **slots** per
owner kind; a slot is held by one owner process at a time, which is the only writer of
every partition in it (A1, A2). A hot partition gets a slot of its own (the hottest links,
RFC-000 §6).

| Owner kind | Partitions | Slots at the design load (est.) | Notes |
|---|---|---|---|
| Account owner | Account | **16,384** | RFC-000 §3's occupancy target (lane about 0.11 occupied): about 110,000 entries/s (intake and deciding entries, marks, "releases durable", applied unposted usage and ledger positions; RFC-002, RFC-004), about 6 accounts and 7 entries/s per slot. Account → slot by placement's **account slot map** (§7.1). One account at `account_rate_limit` (200/s) is about 400 entries/s, its own wait. Held by **64 account-owner processes** per region, about 256 slots each (RFC-002 §14; R27-22) |
| Link schedule owner | Link | **4,096 shared** + up to 128 dedicated | About 45,000 entries/s on shared slots (lane about 0.2); a link above 200 requests/s for 10 min moves to a dedicated slot (§4.5); the hottest link (2,500/s, at least 5,000 entries/s) is one |
| Partner adapter | Partner link | 64 | |
| Metering ingestion; attribution stage A | Exporter | 128; 128 (the same slot map as ingestion) | RFC-003 §1.1; `ingest_log` is self-outboxed (§3.5) |
| Attribution stage B; rating | Buyer account | 256; 256, as **slot group** pairs (stage B *i*, rating *i*) kept in one process and taken, handed off and re-homed **as one acquisition** (one transaction for both slots, §4.2, §7.1; RFC-003 revision 5) | Hot standbys (§10.3); RFC-003 §1.1 |
| Settlement | Buyer account; supplier (debts) | 256 | Hot standby (AI3-9) |
| Ledger | Movement home (RFC-000 §2) | 128 | RFC-004 |
| Payments, receivables, reconciliation | (provider, transaction reference); account; day | 128 + 128 + 4 | RFC-000 V-04 |
| Payouts | Supplier | 32 | |
| Identity and access | Account, supplier, operator | **256** (`iam_slots`, RFC-005) | Push-fed hot standby in the other Kenyan region, as link slots (§4.4) |
| Catalogue, approvals, notifier, alerts, probe results | Entity; request; account; alert; probe account | 16 + 8 + **1,024** + 8 + **64** | Notifier sized for batched deliveries (§15); probe results for about 3,300 results/s (§17.1) |
| History (sealer, pruner) | Slot range | 64 | §13.2, §14.4 |
| Placement | One partition | 1 | §7.1 |
| **Total** | | **about 23,600 slots** | Held by about 600 owner processes in the preferred region (est., §19.2), of which about 200 are admission processes (64 account, about 100 link, the rest partner adapter, identity, approvals; est.). Slots are logical: sessions are renewed per process (§4.2) and read leases per holder and reader process (§4.6). Counts are **only doubled**, by moving partitions lazily (§7.1, §4.5; decision D7), and in v1 only the **account** kind is doubled (C01 M12); a hot link or exporter gets a dedicated slot by a move instead. The spike may set the account count lower if the per-transaction cost dominates (§19.2, RK28) |

#### 4.2 Sessions, slot leases and epochs

RFC-000 §5.2 (revision 4.2) states the owner lease as a slot row naming its holder session
and epoch, valid while that session is live and not revoked. RFC-006 implements it as two
tables, so that renewing costs one row per **process**, not one per slot (about 23,600
slots renewed twice a second would be about 47,000 two-region writes a second for nothing):

| Table | Key | Columns | Written by |
|---|---|---|---|
| `owner_session` | (`shard`, `session_id`), `session_id` random, never reused (§3.2) | `host`, `region`, `facility`, `kind`, `started_at`, **`expires_at`**, **`revoked`** BOOL | Its process: inserted at start, `expires_at` renewed every `session_renew` (500 ms) to `now() + session_ttl` (3 s). `revoked` is set only by an acquisition (below) |
| `owner_slot` | (`kind`, `slot`) | `session_id` (the holder), **`epoch`**, `acquired_at`, `slot_group` (§7.1), **`stops_version`** (incremented by every `Stop` and `Resume` that touches a partition of the slot, §4.3, §14.3; C01 R47-04), **`report_through`** (the report position of the slot's last marker, any epoch; NULL before the first) and **`marker_seq`** (the stream sequence of the slot's marker stream) (§4.6; C01 V59-6) | Acquisitions, handoffs and re-homes, one transaction each (the lease columns); the holder's batches and marker-only transactions (`report_through`, `marker_seq` only); placement's `Stop` and `Resume` (`stops_version` only) |

```mermaid
stateDiagram-v2
  [*] --> Live: insert session
  Live --> Live: renew (NOT revoked), success inside the holder's view
  Live --> Lapsed: holder's view ended (no successful renewal for session_ttl − ε)
  Lapsed --> Resuming: renew succeeds (NOT revoked; no slot was taken)
  Resuming --> Live: resume read done (in-flight batches resolved; report floor = T_res)
  Lapsed --> Revoked: an acquisition of one of its slots
  Live --> Revoked: an acquisition after expiry by the database clock
  Revoked --> [*]: process re-homes its untaken slots under a new session (§4.4)
```

| State | The process may | It may not |
|---|---|---|
| Live | Commit batches, decide from memory, grant and renew read leases, report at or below the report position | — |
| Lapsed (its own view ended) | Retry renewal every 100 ms; keep every slot's memory; wait for in-flight batches' answers | Propose, decide from memory, grant or renew a read lease, report, send a command |
| Resuming | Run the resume read (below) | As Lapsed |
| Revoked | Re-home (an acquisition, §4.4) | Anything in the old session |

- **A slot's owner lease is valid** while its `owner_slot.session_id` names a session that
  is not revoked and whose `expires_at` is in the future by the database's clock. The
  **epoch** is the term of A2.
- **Renewal** (one statement, its own transaction):

  ```sql
  UPDATE owner_session SET expires_at = now() + '3s'
   WHERE shard = $shard AND session_id = $me AND NOT revoked;
  ```

  It requires only that the session is not revoked, not that it is unexpired: a session
  that lapsed while its range was unavailable, and none of whose slots was taken, may
  resume (§4.4). It writes only the session row, so it never conflicts with a batch
  transaction's epoch read. A renewal that updates no row (revoked) fails, and the process
  re-homes (§4.4). A renewal that errors for unavailability or a timeout is retried every
  100 ms; the process acts meanwhile only within its own view (below).
- **The holder's own view** (R27-19). The process takes its lease to end at `t_send +
  session_ttl − ε` by its **monotonic** clock (`process.hrtime`), where `t_send` is when it
  sent the last renewal that succeeded **inside the view**. Only the database's pairwise
  clock offset enters: the renewal's `now()` and a successor's acquisition (or a rule-3
  read) are stamped by two database nodes whose clocks differ by at most `max_offset`, and
  the interval between them is measured by the owner's monotonic clock from the send, so
  `ε` = `max_offset` (100 ms) covers it exactly; the owner host's own wall-clock offset does
  not enter (its offset check, §6.2, guards the timers and `now()` (C01 §2.4), not this). From
  the view's end it proposes nothing, decides nothing from memory, grants and renews no read
  lease and sends no command. The runtime's `leaseValid(slot)` answers false from
  `max_loop_delay` (200 ms) **before** the view's end, so a pause after the check cannot
  carry a reply or a command past it; owners call it immediately before every action from
  memory (C01 §3.1, R47-23). The read-lease and holder's-view arguments hold only while the
  database's pairwise offset stays below `max_offset`; the database's self-termination and
  §6.3's alarm ladder give that **precondition** (C01 §1). Safety of commits does not
  depend on this timing (A8): the epoch-conditional write (§4.3) and the revocation do.
- **Resume: a lapsed renewal is an acquisition for reporting** (R27-01; RFC-000 revision
  4.3, AI-27-1). A renewal whose success reaches the process **after its view ended** is a
  **resume**, whether or not the database's clock saw the session expire. The test is
  conservative and exact: if the success arrives at `t_ack` < `t_send_prev` + `session_ttl`
  − ε (inside the view), the renewal's commit timestamp is below the old `expires_at` (the
  two stamps are at most `t_ack − t_send_prev` + `max_offset` apart), so no rule-3 read can
  have seen the session expired and the renewal is ordinary; otherwise a reader may have
  run rule 3 against the slot (§4.6) and answered from the database while the holder had
  batches in flight. On a resume the process, before it reports or grants anything again,
  runs the **resolution steps** 1 to 4 below. C01 §3.1 numbers them, and the runtime uses
  the same steps for a re-home and for an `Ambiguous` batch (§4.3; C01 M1, R47-13, R47-14):
  1. runs one **resolution read** per slot shard of its slots, a **high-priority**
     read-only transaction at the present timestamp, retried until it answers, that reads
     its `owner_session` row (which forces the read above the
     renewal's commit), the `owner_slot` rows of its slots, and the head rows of every
     partition of every batch still unanswered, and records `T_res` =
     `cluster_logical_timestamp()` of that read, so `T_res` is above the renewal's commit;
  2. resolves each in-flight batch from those head rows by `batch_id`, as for `Ambiguous`
     (§4.3): committed if any head row carries it, else not committed and re-evaluated (a
     push of a fixed-`ts` batch aborts it, which is "not committed"; a `STAGING` batch is
     recovered by the read); a batch whose fixed `ts` is above `T_res` is
     committed after any rule-3 read and is reported normally;
  3. drops every slot whose epoch is no longer its own (taken: `onRelease('taken')`); if
     the session is `revoked`, it re-homes the other slots (below) instead of continuing;
  4. sets each kept slot's report position to `T_res` (every entry at or below it is now
     committed and known, and no read lease of its own is live, since every lease ended
     inside the view, which ended before the renewal), so every later read lease has
     `P_grant` ≥ `T_res` and every leased reader's bounded read sees every entry a rule-3
     read during the lapse could have seen.
  Then it serves. No `read_lease` + ε wait is needed: the only read leases that could be
  live were its own, and they ended with its view. A resume costs one point read per
  partition in flight and about 10 to 50 ms (est.); it happens after a session-range lease
  move (§4.4) or a long pause.
- **Acquisition revokes** (R6-01; RFC-000 AI-R6-1). Taking a slot whose holder session has
  expired, in one transaction:

  ```sql
  BEGIN PRIORITY HIGH;
  UPDATE owner_session SET revoked = true
   WHERE shard = $old_shard AND session_id = $old
     AND (revoked OR expires_at <= now());                 -- must update one row, else abort
  UPDATE owner_slot SET session_id = $me, epoch = epoch + 1, acquired_at = now()
   WHERE kind = $kind AND slot = ANY($slots) AND session_id = $old
  RETURNING slot, epoch;
  COMMIT;
  ```

  A standby takes **every** slot it stands by for of one expired session, up to 256, in
  one such transaction (§7.4); a **slot group** (§7.1) is always in one transaction. A
  **free slot** (no session: never assigned, or released by a drained process) is taken by
  its own statement, `UPDATE owner_slot SET session_id = $me, epoch = epoch + 1, acquired_at
  = now() WHERE kind = $kind AND slot = $slot AND session_id IS NULL` (R27-15: `= $old`
  never matches `NULL`). **Why no renewal can be serialised after it.** The acquisition writes the old
  session's row. A renewal in flight writes the same row: if the renewal's write is ordered
  first, the acquisition reads `expires_at` in the future and updates nothing, so it aborts;
  if the acquisition's write is ordered first, the renewal either reads `revoked` and
  updates nothing, or, if it started earlier, meets the acquisition's committed write above
  its own read timestamp, is pushed, fails its read refresh on that row and retries, then
  reads `revoked`. The trace of R6-01 (a renewal started at `r`, the acquisition at `a` >
  `r + session_ttl`, the renewal pushed above `a`) therefore ends with the renewal failing.
  Serialisable isolation also orders the acquisition after every batch that read the old
  epoch: such a batch committed before it (and the new holder sees its rows) or aborts.
  After the commit the new holder catches up by a high-priority present-time read, reads
  the integrity stops of its slots from `placement_integrity_stops` (no call to placement,
  so a stop holds across a takeover while placement is down; C01 §3.1, CP-6), and then
  calls `onAcquire(slot, epoch, 'expiry')`. A handoff and a re-home read the stops in the
  same way.
- **Handoff** (planned moves, rebalancing, failback, drained hosts): the holder stops
  proposing and **stops granting read leases**, waits for its in-flight batch, and in one
  transaction sets `session_id` to the named successor's session and increments the epoch,
  conditional on the epoch still being its own. The successor, like a taking-over standby,
  first **catches up** at the present timestamp in a high-priority read (an account standby
  is about 1.5 s behind; a link or identity standby a few milliseconds, §4.4), applies the
  rows, calls `onAcquire(slot, epoch, 'handoff')`, and only then serves (R27-26); it
  **reports nothing until `read_lease` + ε after the handoff's commit** (§4.6; R6-02).
  Slots of one group are handed off together (§7.1).
- **Re-home** (a process whose session was revoked, or that chooses a new session): the
  process opens a new session and, for each slot still named under the old session with
  the epoch it holds, `UPDATE owner_slot SET session_id = $new, epoch = epoch + 1 WHERE
  kind = $kind AND slot = $slot AND session_id = $old AND epoch = $mine`. No other writer
  can have written the slot's partitions, since the epoch is still its own, so its memory
  stays valid; it is an acquisition all the same and applies the **full resume** (R33-01;
  RFC-000 AI-27-1): after the re-home commits, a **resolution read** at the present
  timestamp (step 1, whose read of the re-homed `owner_slot` rows, written by the re-home,
  puts `T_res` above the re-home's commit), steps 2 and 3, and **step 4: each re-homed slot's report position is set to
  `T_res`**, so no read lease is ever granted with `P_grant` below it; then the takeover
  entry and the `read_lease` + ε reporting wait apply. (The floor matters exactly when the
  session was revoked because a sibling slot was taken during a lapse, so a rule-3 read may
  have answered for this slot.) A slot that fails the condition was taken: its memory is
  dropped.
- **Crash points.** Acquisition: before commit, nothing changed; after commit and before
  the answer, the standby re-reads `owner_slot` and finds itself the holder (or not).
  **Handoff** (R27-11): if the old holder gets no answer, it reads its slots' `owner_slot`
  rows **at the present timestamp** (retried until the ranges answer): a slot still at its
  own epoch was not handed off, so it serves again and retries the handoff (or re-homes if
  its session was revoked meanwhile); a slot held by the successor is released
  (`onRelease`). The successor, on no answer, does the same read and acquires (catch-up,
  `onAcquire`) or not. So an ambiguous handoff never leaves a slot unserved beyond the
  read's latency. Renewal: an unknown outcome is a failed renewal for the view; the next
  renewal settles it (a resume if the view ended meanwhile). Resume: a crash during the
  resume read leaves the session to expire and be taken over; nothing was reported. Re-home:
  as acquisition.

#### 4.3 The epoch-guarded slot batch transaction

**One batch transaction in flight per slot** (RFC-000 §3 and §5.5, revision 4.1, AI3-11).
The runtime keeps, per slot, a queue of pending `append` calls. When no transaction of the
slot is in flight, it takes **every** pending call, of every partition of the slot, into one
transaction; calls that arrive while it commits form the next. So each partition still has
at most one transaction in flight, and its sequence stays contiguous and its `ts`
monotone, because each partition reads and writes its own head row in the transaction.

```sql
BEGIN;  -- SERIALIZABLE; statement timeout 2 s; idle-in-transaction 1 s (§3.6)
SAVEPOINT cockroach_restart;                                                 -- a 40001 rolls back to here, keeping intents (§4.3 Retry)
SELECT epoch, stops_version, report_through, marker_seq FROM owner_slot
 WHERE kind = $kind AND slot = $slot;                                        -- the fence: epoch must equal mine; a new
                                                                             -- stops_version re-reads placement_integrity_stops
SELECT partition, slot, generation, adopted, seq, streams, chain, ts FROM account_head
 WHERE home_key = ANY($home_keys) AND partition = ANY($partitions);           -- one row per partition; slot mine and adopted
SELECT ...;                                                                  -- each call's condition rows and declared reads, by
                                                                             -- partition-led keys; the displacement read under its
                                                                             -- own savepoint with a 10 ms lock timeout (§3.7)
SELECT cluster_logical_timestamp();                                          -- this batch's ts, shared by its partitions
                                                                             -- (then each call's decide(ctx) runs at ctx.ts)
INSERT INTO account_log (slot, partition, seq, epoch, kind, ts, chain, ...) VALUES ...;  -- entries; seq and chain per partition, recomputed on every retry
INSERT INTO account_outbox (...) VALUES ...;                                 -- incl. a report marker (§4.6) if due
UPSERT INTO account_head (..., batch_id) VALUES ...;                         -- one per committing call's partition, with this batch's id
UPDATE owner_slot SET report_through = $p, marker_seq = $m WHERE ...;        -- only if this batch carries a marker (§4.6)
UPSERT INTO account_requests (...) VALUES ...;                               -- projections (DELETE only on declared-deletable ones)
SET LOCAL statement_timeout = '15s';                                         -- the commit point: 15 s backstop, then Ambiguous (C01 M1)
RELEASE SAVEPOINT cockroach_restart;                                         -- commits (CockroachDB's retry protocol)
COMMIT;
```

- **The calls** (C01 §2.4, §3.2; M2, M3, R47-11). An `append` call names its partition and
  carries `conditions` (`rowAbsent` or `rowPresent` on a row of a served partition,
  `tsBefore` a bound computed from the timing snapshot, or, for the account owner only,
  `displacementRead` keyed (link, request)), declared `reads`, and either static entries,
  projections and notifications or a **`decide(ctx)`** function. `decide` runs inside the
  transaction at `ctx.ts`, reads only the declared rows (`ctx.read`, synchronous), is
  deterministic, and runs again on every restart, so nothing of an earlier attempt
  commits. Options (`AppendOptions`): `exclusive` (the call goes alone in its own
  transaction on the slot's lane), `firstStatement` (writes made in the first statement
  with the `ts` read: RFC-001's placeholder markers), `abandonBeforeCommitMs` (default
  2,000 ms; RFC-001 uses 250 ms for capacity-lowering entries) and `lane`.
- **"Partitions the slot serves"** are those whose head row names this slot **and** has
  `adopted` = true (C01 R47-01). Conditions and reads reach any row of a served partition
  by its partition-led key, also rows written before the partition moved here. A creation
  (no head row) carries an implicit `rowAbsent(head)` (C01 R47-05).
- **Per-call outcome, in order.** A stopped partition (its `stops_version` changed and the
  re-read stops name it) gets `Stopped`; a head that does not name this slot gets `Moving`
  while it is not adopted elsewhere and `Moved(slot, generation)` once it is; a head that
  names this slot with `adopted` = false gets `Moving`, except for the `adopt` call itself
  (§4.5). Every read precedes every write. The runtime evaluates each call's conditions on
  the rows read; a call whose condition fails contributes no write and is answered
  `ConditionFailed(which)`; a displacement read that meets its lock timeout fails only that
  call's condition (`'lockTimeout'`, RFC-002 then defers the confirm). The others commit.
  One call's failure never aborts another's. **Every call that commits upserts its
  partition's head row with the batch's `batch_id`**, a call with projections only
  included, so every committed call can be classified after an `Ambiguous` (C01 R47-14).
- **Size limits.** A batch carries at most `slot_batch_max_entries` (2,000) entries or
  `slot_batch_max_bytes` (4 MB); the rest wait for the next. Per-partition order is the
  order of calls.
- **Batching wait** (RFC-000 §3 revision 4.2, AI-17-5, AI-R6-4; R6-05). At the design load
  no admission slot is idle: an entry finds the lane busy with probability about the lane's
  occupancy ρ and waits the rest of the commit in flight. Slot counts are set for ρ of about
  0.15 or less (§4.1), which gives the budgeted waits `W_a` (account) and `W_l` (shared
  link): about 20 ms at p99 in steady state, 25 ms with a facility lost in R2 or a path cut,
  65 to 70 ms after a region loss (est., RFC-000 §3's wait table). The hottest links, each on
  a dedicated always-busy slot, wait up to one commit (30 ms).
- **Marker-only transactions do not take the lane** (§4.6): they read the epoch and write
  only the slot's marker outbox row under partition `''` and the slot's `owner_slot` row
  (`report_through`, `marker_seq`), so they run beside the batch in flight. **Markers are
  serialised on the `owner_slot` row** (R27-16; C01 V59-6): while a marker-only transaction
  is in flight the next batch carries no marker, and while a batch carrying a marker is in
  flight no marker-only transaction starts, so the row has at most one marker writer in
  flight and a marker never makes a batch retry. Only the slot's holder writes these two
  columns; placement's `Stop` writes only `stops_version`, which no marker reads.
- **The second in-flight batch** (one mechanism, two uses). The runtime can run a **second
  lane** per slot: a second batch may start while the first is in flight, carrying only
  calls of partitions **not** in the first, so each partition still has at most one
  transaction in flight and its sequences and `ts` stay as above. (a) **Account slots**: the
  fallback lever if the R1 spike's account step p99, batching wait included, exceeds 50 ms
  at the design load (RFC-000 R23; §22.1): with it `W_a` falls to about 5 ms steady (an entry
  waits only when both lanes are busy or its own account is in flight). (b) **Deadline
  entries** (expiry entries at the account owner, releases at the link owner) ride the
  second lane whenever their partition is not in flight, if the measured `δ_x` would take
  `τ` past its cap (§6.4). Each lane is enabled per owner kind by the `second_lane`
  column of `platform_timing` (C01 §2.3), so turning it on needs no release. (c) A second
  batch of the **same** partition on a dedicated link slot (R19's lever) is **excluded from
  v1** of C01 (R47-31): its `Ambiguous` rule is not defined, so a new contract version must
  define it before any owner can use it. A dedicated hot link that needs more than one
  lane is a risk for RFC-001's measured ceiling (RB-11).
- **Crash points.** Before `COMMIT` is sent: nothing committed; the callers get "not known
  to be committed" only if the process dies, otherwise the runtime retries. After `COMMIT`
  is sent and before the answer, or the 15 s `COMMIT` backstop expired: `Ambiguous` for
  **every** call in the batch. `COMMIT` is **never aborted blind** (C01 M1): before anything
  more is decided in **that slot**, the runtime runs the resolution steps 1 to 3 (§4.2); no
  batch of the slot starts and the owner decides nothing for the slot from memory until
  they complete; then it reloads every partition of the batch and answers each caller
  `Committed` or runs the call again. A revoked session leads to a re-home, a changed epoch
  to `StaleEpoch`. A process paused with the transaction open: the database aborts it after 1 s idle
  (§3.6), and a successor's high-priority catch-up read pushes it, so it never commits after
  the successor's acquisition (RFC-000 AI-17-4). After the answer and before the outbox
  publish: the changefeed relays the rows; a takeover republishes them (§4.4). After the
  publish and before the callers are answered: callers retry with the same identities and
  are answered from the deduplicated entries (A6).

- The epoch read is the fence: if a successor's acquisition commits after this read and
  before this commit, this transaction cannot commit (its read is invalidated) and fails
  with a retry error. A deposed owner, however long it was paused, therefore never commits
  an entry after its successor started (RFC-000 §5.2).
- Conditions an entry depends on ("confirm if undecided", "binding is new", "`ts` < `D − τ`")
  are evaluated against the rows read in the same transaction and against `ts`; the
  decision row's primary key is the request, so a second deciding entry cannot commit
  (RFC-000 §5.5). The fence reads `τ` from the `platform_timing` row (§6.4) in the same
  transaction.
- **Results** the runtime returns to each call in the batch. C01 §2.4 (`AppendResult`) and
  §3.2 are the definition; this table gives the mechanism behind each result:

  | Result | Meaning | Mechanism | Owner's action (C01 §3.2) |
  |---|---|---|---|
  | `Committed(seqFrom, seqTo, ts, streamSeqs)` | Durable on a majority spanning two regions; the **only** success | `COMMIT` answered | Apply to memory; acknowledge; the runtime publishes events and notifications (§5.3) |
  | `ConditionFailed(which)` | This call wrote nothing; the rest of the batch may have committed | A condition read, a `decide` returning null (`'decide'`) or a lock timeout (`'lockTimeout'`) | Owner-specific (for example "already decided") |
  | `Retry` | Not committed | CockroachDB's **client-side retry protocol on the same transaction** (`SAVEPOINT cockroach_restart` … `ROLLBACK TO SAVEPOINT cockroach_restart`) restarts it at a higher timestamp **keeping its intents, locks and priority** (RFC-001 §5.1 and R1-1 rely on this for the capacity-decrease transaction; R27-12): it re-reads the epoch, heads and rows, runs every `decide` again and re-runs the writes, up to `batch_retries` (5) restarts; then the batch starts afresh **once**; if that also fails, the call gets `Retry` (C01 R47-12). The protocol keeps intents across a **restart** (a retryable 40001), not after an **abort** (`TransactionAbortedError`: pushed by a higher priority, a deadlock, an expired transaction record), which replaces the transaction and loses its intents (R33-17): then the batch starts afresh, re-reads everything and re-evaluates every condition, so RFC-001's capacity decrease re-lays its placeholder markers and re-checks the displacement markers, correct but without R1-1's no-push argument for that attempt. The spike counts restarts and aborts separately (§22.1) | Retry later with the **same identities**; map to the owner's POL-04 answer if a caller waits |
  | `StaleEpoch` | The slot was taken | The epoch read differs from the holder's | Stop serving **that slot** (drop its memory, `onRelease`); fail its in-flight calls "not known to be committed"; the process's other slots continue (§4.4) |
  | `Moved(slot, generation)` | The partition is adopted in another slot | Head names another slot with `adopted` = true (§4.5) | Re-route to the named slot with the same identity |
  | `Moving` | Between `moved` and `adopt` (about 100 ms, est.) | Head names another slot unadopted, or this slot unadopted (§4.5) | Retry after a short wait (≥ 20 ms, backoff) with the same identity; never a failure to the buyer by itself |
  | `Stopped(detectionRef)` | Integrity stop open on the partition | The fence read sees a new `stops_version`; the stops re-read name the partition (§14.3) | Decide nothing; answer the caller "temporarily unavailable"; retry only after the stop is lifted |
  | `Ambiguous` | `COMMIT` sent and its answer lost (SQLSTATE 40003 or a lost connection), or the 15 s backstop expired | Resolved by steps 1 to 3 of §4.2 before the slot decides again (crash points above; R6-16) | Wait for the runtime's resolution; then `Committed` or re-run, as the runtime answers |
  | `Overloaded(retryAfterMs)` | Back-pressure | **Only** admission control or event-loop shedding (§4.7), never exhausted retries (C01 R47-12) | Back-pressure to callers, mapped by the owner RFC to its POL-04 answer |

  Every result except `Committed` and `ConditionFailed` means "not known to be committed". A
  consumer that receives a result it does not know treats it as `Retry` and alerts (C01 §8).
  Reloads are rate-limited per process (at most 8 partitions reloading at once, est.).

- **An owner's memory is a cache of its log** (RFC-000 §5.2): after any result other than
  `Committed` or `ConditionFailed` the memory of each partition in the batch is rebuilt from the head, the projections and the log
  since the last projection checkpoint before the next decision.
- The fence's epoch read goes to the slot row's leaseholder in R1 (one of about 400
  `owner_slot` ranges, §3.2), about 1 ms within the metro (est.), inside RFC-000 §3's 2 to
  5 ms of per-transaction overhead. A batch of `n` partitions adds one head point read and
  one head upsert per partition (batched statements, about 0.1 ms each, est.); a slot's
  ranges are contiguous (§3.7), so most batches touch one range per table.
- **Generation check.** The batch also checks that each head row names this slot, is
  adopted, and carries the generation the holder holds for the partition; a mismatch (the
  partition was moved meanwhile) fails that call with `Moving` or `Moved` (§4.5).

#### 4.4 Takeover, standbys and reload

Every slot has, besides its holder, two standbys that tail it (RFC-000 §5.1, AI3-9):

| Standby | Where | Takes over on |
|---|---|---|
| **In-region hot standby** | The other facility of the preferred region | Holder process, host or facility loss |
| **Cross-region warm standby** | The other Kenyan region, spread over its two facilities | Region-wide failover (§7.4) |

**Link slots and identity slots have two hot standbys** (RFC-000 §5.1 and §5.4, revision
4.1, AI-R1-12; RFC-005 §2 for identity): one in the other facility of the preferred region
and one in the second Kenyan region, each holding the slot's state **a fraction of a second
behind**, so a takeover never rebuilds a hot link or an identity slot cold, even
region-wide (identity's credentials go unauthenticable at the edges after 30 s without a
holder, RFC-005 RK-16). Rating, attribution and settlement slots keep the hot in-region
standby of AI3-9 and a warm cross-region one. A **slot group** (§7.1) has one standby
process per role, standing by for every slot of the group.
- **Tailing.** A standby reads its slot's new log rows every `standby_poll` (250 ms) by
  follower reads from its own facility's replicas (`AS OF SYSTEM TIME
  follower_read_timestamp()`, so about 1.5 s behind, est.) and applies them to its memory
  exactly as the holder did. For rating and attribution, whose state is largely derived
  from their input feeds, the standby also consumes the same Kafka partitions as the
  holder, without acting on them.
- **Push to link and identity standbys.** A link or identity slot's holder pushes every
  `Committed` batch (entries, `seq` range, `ts`) to both its hot standbys over gRPC, as it does to status readers
  (§4.6), without waiting for an acknowledgement; each standby applies a push only if its
  `seq` continues what it holds for the partition, and otherwise waits for the missing rows
  from its follower-read tail. The `standby_poll` tail is the backstop. **No reader but a
  taking-over standby reads the live log tail at the present timestamp** (RFC-001 rev. 4):
  standbys, status readers, the sealer and consumers' gap fills use follower reads, so none
  leaves timestamp-cache entries that push the holder's batches (rule 3's check, §4.6, reads at the present timestamp only while the slot has no live holder). Lag: about 1 to 5 ms
  in-region and 5 to 10 ms cross-region (est.); a lost push costs at most one
  `standby_poll` plus the follower-read lag (about 1.5 s). Cost: about 2 × 42,000 pushed link batches a second plus a few
  hundred identity batches at the design load (est., §19.2; R6-22), on the owner hosts'
  network, not the database.
- **Takeover.** A standby watches its holder's `owner_session.expires_at` and `revoked` by a
  **plain, non-locking point read at the present timestamp** every `standby_poll` (250 ms),
  separate from its follower-read tail (R27-05): a follower read would see the expiry about
  1.5 s late. The read goes to the session shard's leaseholder (about 1 ms in the metro,
  est.); the timestamp-cache entry it leaves can only push a renewal in flight, which
  refreshes trivially (nothing else wrote the row), so it never fails one. About 1,200
  sessions, each watched by the few standby processes of its slots: about 5,000 to 10,000
  point reads a second (est., §19.2). A standby acquires only when that read shows the
  session expired or revoked, never on a stale value, so no high-priority acquisition is
  aimed at a live session. When the session has expired by the database's clock, the in-region
  standby acquires the slot, revoking the session (§4.2); the cross-region standby does so
  only if the slot is still held by the expired session `standby_grace` (1 s) later, or at
  once if placement has set its region as preferred (§7.4). **If the standby's reads of the
  session's range were failing** (its leaseholder was moving), it waits `standby_grace`
  after the range answers again before acquiring, so a holder whose session lapsed only
  because of that range renews first and keeps its slots warm (R6-03). The standby then
  reads every row committed after its tail at the present timestamp, in a **high-priority**
  transaction that pushes any pending batch of the deposed holder (RFC-000 AI-17-4), applies
  them, calls the owner's `onAcquire(slot, epoch)`, and serves; it reports nothing until
  `read_lease` + ε after its acquisition commit (§4.6).
- **Takeover time (est.)**: session expiry 3 s after the holder's last renewal, plus
  detection by the present-time poll (0 to 0.25 s), plus the acquisition transaction (about
  30 ms), plus the catch-up read and apply (about 0.05 s for a hot standby, 0.2 to 0.5 s for
  a warm one): **about 3.3 to 3.8 s from the last renewal, p99 ≤ 5 s** (the spike's exit
  criterion, AI3-9) to serving; the holder failed 0 to 0.5 s after its last renewal, so 2.8
  to 3.8 s from the failure; reports follow 0.5 s later. A cross-region standby adds
  `standby_grace` (1 s) unless placement has made its region preferred (§7.4). A
  takeover whose ranges also lost their leaseholder (a database node failure under the
  slot's ranges) waits for the range lease as well (§3.3).
- **Takeover entry and resumption** (RFC-000 §4.3, POL-03): the owner's first entry in the
  new epoch, in each partition it touches, is its takeover entry; it re-arms its timers from
  its state (C01 §3.7), re-sends releases for ending entries without a "releases durable"
  entry (RFC-002), and starts reporting only `read_lease` + ε after its acquisition commit,
  whatever the kind of acquisition (expiry, handoff, re-home), so every read lease its
  predecessor granted has ended without any timing argument (§4.6; RFC-000 AI-R6-2).
- **Takeover republish.** **After it starts serving** (R33-15), the new holder republishes every outbox row of
  its slot committed **after the kind's closure position** (the closure emitter's `R_min`,
  §5.3: every row at or below it has already been published by the relay and acknowledged),
  bounded by `republish_window` (30 s) before its acquisition, so a row the old holder
  committed but never published reaches Kafka at once rather than by the changefeed (§5.3).
  Normally that is the last 2 to 3 s (est.), not 30 s. Republish is rate-limited to
  `republish_rate` (5,000 rows/s) per process (R27-24): at a
  region-wide failover about 21,000 slots × about 2 to 3 s of rows is about 0.5 M rows
  (est.) spread over about 200 processes and a few seconds, instead of about 5 M at once
  while the brokers' in-sync sets change. Consumers drop the duplicates (§5.5); new
  events with higher stream sequences that arrive first are **buffered** by the consumer
  runtime until the republished ones fill the gap (§5.5), so the cost is feed lag of up to
  the republish time, not `gap_timeout`.
- **Losing and giving up** (R6-03). Failures are handled at the narrowest scope that is
  safe, so a database fault never turns into a platform-wide cold restart:

  | Event | Scope | What the process does |
  |---|---|---|
  | `StaleEpoch` on a slot, or `Moved` for a whole slot | That slot | Stops serving it, fails its in-flight calls as "not known to be committed", drops its memory, `onRelease`; other slots continue |
  | Renewal errors or times out (range unavailable) | The view only | Acts on nothing past its view's end (§4.2); keeps every slot's memory; retries renewal every 100 ms; when a renewal succeeds after the view ended, **resumes** through the resume read, an acquisition for reporting (§4.2; AI-27-1) |
  | Renewal finds the session revoked | The session | Re-homes every slot still under the old session with its own epoch (§4.2), keeping their memory; drops the slots that were taken |
  | Offset bound above 50 ms (§6.2), or event-loop limit (§4.7) | The process | Stops serving every slot, fails in-flight calls, exits; the supervisor restarts it with a new session; standbys take its slots on expiry |

  A database node loss under the session table's ranges therefore costs the processes whose
  sessions were there a pause of about the range-lease failover (4 to 9 s, est.) for their
  slots, and no cold reload: they renew (or a standby, warm, takes over) when the range is
  back. The failure-injection suite kills the leaseholders of these ranges weekly (§22.2).

#### 4.5 Fencing across components

RFC-000 §5.2 (revision 4.2) states the rules; the runtime enforces them as follows.

| Fence | Carried in | Checked by | A stale one gets |
|---|---|---|---|
| **Epoch** (per slot) | Every log and outbox row | The database: the batch transaction's epoch read (§4.3) | Not committed |
| **(Generation, epoch)** (per partition; RFC-000 AI-R6-3) | Every command (`CommandEnvelope.sender`, C01 §2.4) and point-to-point notification an owner sends, every feed header | Every receiver of a **command**, by `admitCommand`, against the highest (generation, epoch) recorded in an applied entry for the sending partition (`senderFence`); the runtime rebuilds that high-water mark on `onAcquire` and `onAdopt` (C01 R47-24); the partner adapter's account-owner check (RFC-000 V-03) is one | `STALE_SENDER(recorded)`, journaled where the receiver keeps a journal. The sender (C01 §3.8, review 47 D4): recorded generation equal and epoch higher ⇒ deposed, as `StaleEpoch` for that slot; recorded generation higher ⇒ the partition moved and the new writer superseded the command: **drop the command, keep the slot**, and raise `STALE_SENDER_UNMOVED` only if it has not applied `moved` for that partition; otherwise a defect: alert and drop |
| **Routing** | Every command carries `CommandEnvelope.routedTo` (kind, slot, generation, epoch, map version) | The receiving owner, against its own | One of C01's **canonical refusals** (M4): `STALE_EPOCH(current, holderHint)`, `NOT_OWNER`, `MOVED(slot, generation)` (only once the target has adopted), `MOVING(retryAfterMs)`, `STOPPED`, `STALE_SENDER(recorded)`, `OVERLOADED(retryAfterMs)`, `UNAVAILABLE`; the sender re-routes or backs off with the same identity, and treats an unknown code as `UNAVAILABLE`. A command already applied (same identity) is answered with its recorded result |
| **Stream sequence** (per partition and feed stream; AI-17-2) | Every feed event: (`partition`, `stream`, `stream_seq`) with (`generation`, `epoch`) | Every consumer, in its own state (§5.5) | Ignored as a duplicate |
| **Notification identity** | Point-to-point notifications: (request, attempt, kind) | The receiving owner, in the same entry as the effect | Deduplicated; no high-water rule (§5.5) |

**Moving a partition** to another slot (a hot link to a dedicated slot, an account
re-slotted or split off by a slot-count doubling, §7.1; R6-09, R27-02, R27-09; RFC-000
revision 4.3, AI-27-2). Moves are made **at load** (decision D6): the trigger of a hot-link
move is load, so the protocol bounds the partition's unavailability by commits, not by a
state rebuild.

| Step | Who | What | Partition X serves |
|---|---|---|---|
| 1 Record | Placement | `partition_moves` row (X, from A, to B, generation `g + 1`), state `prewarm` | From A |
| 2 Pre-warm | B's holder and B's standbys | Load X from its latest checkpoint (§12.11) or by replay from the log (follower reads), then tail X: A's holder **pushes** X's committed batches to them as to its own standbys (§4.4), the `standby_poll` follower-read tail as backstop. Each reports to placement when it holds X within one batch of A's last push | From A |
| 3 `moved` | A's holder | Appends **`moved(to B, g + 1)`** in its next batch and, in the same batch, upserts X's head row with `slot` = B, `generation` = `g + 1`, **`adopted` = false**; from the commit it answers every command for X with `MOVING` (retry) and calls the owner's **`onMovedOut(X)`** (cancel every timer of X, decide nothing for X, send no command for X, keep reporting entries already committed; C01 §3.3); it pushes the `moved` batch to B's holder and standbys and to its own leased readers, and keeps reporting | Nobody (`Moving`) |
| 4 Report fence | A's holder | A marker is **due** for `moved` (§4.6), so A advances its report position past `moved`'s `ts` (every reader of A holding a live lease has applied `moved`) and writes the marker, so **`owner_slot(kind, A).report_through` ≥ `ts(moved)`** (C01 V59-6); it pushes the committed marker batch, with its commit timestamp, to B's holder. Kinds without status readers skip this wait | Nobody |
| 5 `adopt` | B's holder | **Fence check before the batch** (R33-07): B's holder waits until A's pushed marker batch shows `report_through` ≥ `ts(moved)` (A pushes it to B's holder as part of the move, step 3), or, if no push arrives within 100 ms, reads the row **`owner_slot(kind, A)`** by a **bounded-staleness read** with minimum timestamp `ts(moved)` until it shows the same; `report_through` is monotone, so a value seen at any timestamp stays true and the check need not be serialisable. Then it appends **`adopt(g + 1)`** in X, in a batch that reads only X's own head row (keyed by home, so it has not moved), with the condition `head(X).slot = B ∧ head(X).generation = g + 1 ∧ head(X).adopted = false`, sets **`adopted` = true**, re-reads X's integrity stops, and records the fence evidence (A's `report_through` and its timestamp) in the `adopt` entry (for kinds without status readers no fence is needed). Nothing of A's is read in B's transaction, so no marker or batch of A is pushed by it. It continues `seq`, `chain` and every stream sequence from the head row and calls **`onAdopt(X, g + 1)`**: the runtime rebuilds the `admitCommand` high-water marks that X's entries record, and the owner re-arms X's timers from its state and applies the takeover-entry rule to X (its takeover entry in X's first batch) (re-sends releases for ending entries without "releases durable", RFC-002), as `onAcquire` does for a slot. No row is deleted or re-keyed, so INSERT and UPSERT grants suffice | From B |
| 6 Report wait | B's holder | Reports nothing for X until `read_lease` + ε after the `adopt` commit (as after an acquisition, per partition), so no reader whose lease predates the push can be contradicted. The runtime **enforces** it: B's report position does not pass the `ts` of any entry of X committed in that window until the window ends (C01 R47-16) | From B; reports 0.5 s later |
| 7 Publish | Placement | Marks the move done; edges and owners refresh routing from the placement feed (for accounts, the slot map version, §7.1) | From B |

**Readers** (§4.6, replica rules 2 and 4 as RFC-000 revision 4.3 restates them). A reader of
A that has applied `moved(X)` answers every read of X by **rule 4** (retry, re-route); rule 2
no longer applies to X there. A reader of B answers X by rule 2 only from state that shows
X's `adopt` in B (pushed, or read by a bounded read at or after the `adopt` commit);
otherwise by rule 4. Step 4 makes every reader still leased by A hold `moved` before B can
decide anything for X, and step 6 covers readers of B leased before the push.

**Bound on `Moving`.** Steps 3 to 5 take one commit of A (about 30 ms on a busy dedicated
slot), the report advance and marker (about 10 to 30 ms, §4.6), the push (about 5 ms) and one
commit of B (about 30 ms): about **100 ms** (est.); for kinds without status readers about
70 ms. **Before step 5, no entry of X commits in B** (the runtime answers `Moving` to every
call of X but `adopt`); after it, A answers `MOVED(B, g + 1)`. If B's holder fails in
between, B's standby, also pre-warmed, takes B and adopts. If A's holder fails after
`moved`, its successor writes the `moved` marker as soon as its post-acquisition wait ends
(a marker is due for `moved` also for a successor whose initial position is at or above
`ts(moved)`, C01 R47-03). On catch-up the successor finds each partition whose head names
another slot and is not adopted, and **pushes its first marker to the holder of that slot**
(C01 V59-7), so B adopts within `read_lease` + ε + one commit after the successor
acquires. `Moving` lasting more than `move_cutover_max` (1 s) pages. A move is never started
without step 2 complete, so the new slot never rebuilds X cold, and its standbys hold X for
a takeover soon after (DT-28 holds).

The new writer's epoch is the new slot's, which may be lower than the old slot's (57 there,
3 here): receivers order by generation first, so the moved partition's commands are never
taken for stale ones, and consumers follow stream sequences, which continue. The database
splits and moves **ranges** under owners by itself, which changes no slot, no owner, no
epoch and no generation.

**No two writers, ever.** Within a slot, the epoch-conditional write gives one writer per
epoch, revocation stops a deposed session renewing, and the expiry timing stops the old
holder acting before a new one can. Across slots, `moved` commits before `adopt`, and both
check the head row's generation, and `adopt` is committed only after B's holder has seen the old slot's report fence. Feed events carry stream sequences and commands carry
(generation, epoch), so no consumer applies an older writer's output after a newer one's
(POL-05 across failures; P1-N1).

#### 4.6 Report position, read leases and status readers

The logic is RFC-000 §4.6's (revision 4.2); RFC-006 gives the mechanism.

- **Status readers** (AI-4). One per Kenyan facility, four in all. A status reader is a
  service of `status_shards` (8) processes on the facility's status-reader hosts, each the
  facility's reader for one-eighth of the account slots, so each account slot has exactly
  four leased readers, one per facility. A reader holds (a) every committed batch the
  holder has pushed to it since its read lease began, and (b) for anything older, point
  reads from the facility's own replicas (the Kenyan voter and the account tables'
  non-voter there, §3.2), each its own single-statement read (`leasedRead`, C01 R47-17),
  by bounded staleness **with a minimum timestamp**: `AS OF SYSTEM
  TIME with_min_timestamp(max(P_grant, adoptTs), true)` (`adoptTs` the partition's `adopt`
  timestamp if it moved into the slot), where `P_grant` is the report position (a commit
  timestamp, below) at which its current lease was granted (R6-04). Such a read is served at
  a timestamp at or after `P_grant`, so it sees every entry the lease guarantees; if the
  local replica's closed timestamp has not reached `P_grant`, the read errors and the reader
  answers by RFC-002's rule 4 instead of rule 2. **`P_grant`** (R27-18) is the report
  position at the **start of a continuous lease** (renewals every `heartbeat_interval` do
  not change it; a lease that lapsed and is granted again gets a new one), and it is
  converted to the `TIMESTAMPTZ` that `with_min_timestamp` takes by **rounding up** to the
  next microsecond, so an entry in the same microsecond is never missed. A reader **keeps
  the committed facts it has applied across lease changes and owner changes** (rule 1 needs
  no lease, and a committed entry never changes), and drops only its claim to be current:
  without a live lease it answers nothing by rule 2. A new holder (after any acquisition,
  resume or `adopt`) pushes its catch-up to the readers it leases before granting, so after
  a rolling deploy readers return to rule 2 within one lease of the new holder's reporting
  wait instead of about 1.7 s of rule 4 (est.). A reader that restarted has no state and
  relies on (b) under its grant's `P_grant`.
- **Push and acknowledgement.** On every `Committed` batch that contains an entry the owner
  marks `report_wanted` (deciding and "releases durable" entries, RFC-002), and otherwise
  every `heartbeat_interval` (100 ms), the holder pushes the batch to each leased reader of
  its slot over one gRPC stream per (holder process, reader process), coalescing whatever is
  ready every 2 ms; each reader acknowledges once applied. At the design load this is about
  4 × 105,000 batch pushes a second over about **2,048 streams**: 64 account-owner
  processes (RFC-002 §14), each serving slots of all 8 reader shards of each of the 4
  facilities, so 32 reader processes each (R27-22). Per owner process: about 1,640 batches a
  second pushed to 32 readers, coalesced every 2 ms, and 320 lease messages a second; per
  reader process, about 13,000 batch pushes a second from 64 holders (est., §19.2).
- **Report position.** Per slot, a commit timestamp `P`: every entry of the slot with `ts`
  ≤ `P` is committed **and** every reader holding a live read lease has acknowledged applying
  through `P`, or that reader's lease has expired. Because the database acknowledges only
  two-region-durable commits, no further round is needed for "every later majority holds
  it" (RFC-000 V-02 as restated in revision 4). Delay: about 10 ms steady (the farthest
  reader is in R2), about 5 ms when only one region's readers remain (est., RFC-000 §3).
- **After a resume** (§4.2) the holder sets the report position to `T_res` before granting
  anything; no wait (its own leases ended with its view). **After an `adopt`** (§4.5) the
  same wait as below applies to the adopted partition only.
- **Initial report position after any acquisition** (R33-01; RFC-000 revision 4.4,
  AI-33-2; C01 §3.1). The new holder's first report position is the timestamp of its **present-time
  catch-up or resolution read**, taken after the acquisition, handoff or re-home commit
  (expiry and handoff: the high-priority catch-up read of §4.4 and §4.2, whose
  `cluster_logical_timestamp()` it records; re-home and resume: `T_res`). Every entry at or
  below it is committed and applied, so the position can start there, and **no read lease
  is granted with `P_grant` below it**: a reader leased afterwards, even one restarted with
  no pushed state, reads at or above every entry a rule-3 read before the acquisition could
  have seen.
- **After any acquisition** (expiry, handoff or re-home), the new holder does not advance
  the report position, write a marker, or report anything until **`read_lease` + ε** (500 ms)
  after its acquisition commit, by its monotonic clock from the moment it learned of the
  commit (R6-02; RFC-000 AI-R6-2). Every read lease its predecessor granted ended inside the
  predecessor's lease view (next item), which ended no later than the acquisition, so after
  that wait none is live, whatever the predecessor's clock or pause. Commits are not delayed;
  only reports, by about 0.5 s after an owner change.
- **Report markers per account slot** (RFC-000 §4.6 and §8, B-AI-8; C01 §2.5, §3.4). A
  marker is **due** only when the report position passes an entry the owner marks
  `reportWanted` (a deciding entry or a "releases durable" entry, RFC-002), an entry that
  emitted an outcome event, or a **`moved`** entry (§4.5), not on every advance (R27-17).
  Then the runtime adds a marker outbox row to the **next batch** of the slot (§4.3),
  whatever partition that batch carries, and in the same transaction writes
  `owner_slot(kind, slot).report_through` and `marker_seq` (C01 V59-6). If no batch is due
  within `marker_max_wait` (20 ms), it commits a **marker-only transaction** (the epoch
  read, the marker row in the slot's `_outbox` under partition `''`, the `owner_slot`
  update, nothing else), which **runs beside the slot's batch, outside its lane** (RFC-000
  revision 4.2, §3), serialised with the batch on the `owner_slot` row (§4.3). The marker
  is C01's **`ReportMarker`**: `slot`, `generation` (0), `epoch`, `reportPosition`,
  **`prevReportPosition`**, **`pendingAnswered`** and **`chunk`** (C01 §2.5; C04 v2.1,
  review 43 B-01, N-12; V59-1). Its header `slot`, as on every outcome event, names the
  account slot (C01 R47-22). The runtime keeps C01 §3.4's **marker chain**:
  1. markers of one (slot, epoch) never go back;
  2. after any acquisition, the new holder's first marker is at or above its catch-up read,
     and none is written until `read_lease` + ε after the acquisition;
  3. `prevReportPosition` is the `reportPosition` of the previous marker of the **same
     slot**, read from `owner_slot.report_through` in the marker's transaction; after an
     acquisition it is the predecessor's last marker; an `adopt` does not change the
     destination slot's chain; it is null only for the slot's first marker ever;
  4. `pendingAnswered` lists every request whose outcome event the marker newly covers
     (`prevReportPosition` < `ts` ≤ `reportPosition`) and for which the holder sent
     `pending` (the owner sets `EntryInput.pendingAnswered` on the outcome entry); the
     first marker after an acquisition (expiry, handoff, re-home or resume, not an `adopt`)
     lists **every** covered event above `prevReportPosition`, because the new holder
     cannot know its predecessor's answers: an extra webhook is possible, a missing one is
     not;
  5. a list longer than 5,000 ids (est.) goes in consecutive markers with the same
     `reportPosition`, `chunk.part` 0, 1, 2 …, the last with `chunk.last` = true.
  **Rate** (est.): about 25,000 deciding entries, 10,000 "releases durable" entries and
  1,640 probe outcomes a second, about 35,000 batches a second carrying a `reportWanted`
  entry; with about 6.5 batches a second per slot, about 12% find another batch within 20
  ms, so about **30,000 marker-only transactions a second** (§19.2; RFC-000 revision 4.4,
  AI6-10). A marker is never written for a position the slot has not reached, and never by
  a holder whose epoch is stale (the fence aborts it). The `pendingAnswered` lists add
  about 16 bytes per covered `pending` outcome (est., about 0.1 MB/s), which changes no
  sizing.
- **Read leases.** A reader asks the holder process for a read lease covering every slot of
  that holder it serves; one lease message per (holder process, reader process) every
  `heartbeat_interval` renews them all (RFC-000 §3: read-lease heartbeats are per process).
  The holder grants or renews a lease on a slot only if **(1)** the reader has applied
  through the slot's current report position, **(2)** `now_mono + read_lease ≤
  untilMonotonic` of its own lease view (§4.2), so the read lease ends inside the owner
  lease (R6-02), **(3)** it is not handing the slot off (it stops granting at the handoff
  transaction), and **(4)** its post-acquisition wait (above) is over. A lease lasts
  `read_lease` = 400 ms from the reader's **send** time of the request, and the reader treats
  it as expired `ε` (100 ms) before that. The holder does not renew the lease of a reader
  behind the position it is trying to reach, so a slow reader delays a report by at most one
  lease. Bound (RFC-000 §4.6, revision 4.2): worst decision-to-report path (about 305 ms, a
  route ended after a region loss, batching waits included) + `read_lease` + `ε` = 305 +
  400 + 100 = **805 ms ≤ `status_staleness` (1 s)**.
- **Replica rule 3's check** (RFC-002 owns the rule). "No instance holds the account's owner
  lease" is one consistent read at the present timestamp: the account slot's `owner_slot`
  row and its holder's `owner_session` (`expires_at`, `revoked`); if the session has expired
  or is revoked, or the slot is unassigned, the reader reads the request's rows in the same
  transaction, which sees every committed entry (RFC-000 B-AI-6). While those ranges are
  moving their range lease after a database node loss, the read waits for the new
  leaseholder (seconds, est.) rather than answer (the spike measures it). A holder that
  later renews a lapsed, unrevoked session **resumes** (§4.2): it resolves every batch that
  was in flight and grants no read lease and reports nothing below `T_res`, which is above
  any such rule-3 read, so no leased reader can later answer `pending` for an entry rule 3
  has answered (R27-01; RFC-000 AI-27-1).
  **Caching the check** (R33-16): the reader caches, per slot, a holder session it has seen
  live, until its `expires_at` − ε by the database clock (the commit timestamp of the read
  that saw it, plus the remaining validity, measured from the send by the reader's monotonic
  clock); before then a poll needs no re-read and answers by rule 4 (a live holder, no lease
  of the reader's). A slot seen without a live holder is re-read on every poll, since that
  is when rule 3 answers. Residual: about one read per (reader, slot) per owner change, and
  per poll only for slots with no live holder (est. a few thousand reads a second at a
  region failover, a few hundred otherwise; §19.2).
- **Closed position** on the readers: the timestamp at which their bounded-staleness read
  was served (at or after `P_grant`), which the reader records with any answer it gives
  from it.

#### 4.7 Process hygiene

NestJS on Node.js runs an owner's decisions on one event loop. A long pause (a garbage
collection, a blocked loop) does not break safety (§4.3), but would make the holder act on
a lease that has expired or answer late. Rules: (1) the runtime monitors the loop's delay
(`perf_hooks.monitorEventLoopDelay`); above 50 ms at p99 over 1 s it **sheds load first**
(new `append` calls answered `Overloaded`, standby tailing and pushes coalesced more), and it
gives up its session (§4.4) only if the delay still exceeds `max_loop_delay` (200 ms)
twice in 10 s (R33-05). A **standby process holds no slots** until it takes over those of
the one holder process it pairs with; after a takeover the supervisor starts a fresh
standby for it. So a takeover never lands on an already loaded holder and overload does not
cascade; (2) the lease check of §4.2 is made immediately
before every reply or command sent from memory, after any `await`; (3) heap limits and the
young-generation size are set per process class so that measured pauses stay below 50 ms
at p99.9 (the spike measures them); (4) CPU-heavy work (payload encryption, compression,
Parquet encoding) runs in worker threads, never on the decision loop. Database access uses
the `pg` driver with prepared statements and a pool per process to database nodes (SQL
gateways) in the process's own facility, with **two fallbacks, always on** (decision D1,
R27-04): the metro's other facility's gateways, then the **other Kenyan region's
gateways**. A statement that fails for unreachability, or does not answer within its
per-tier timeout, on one tier is retried on the next (a batch is abandoned and restarted
there; a `COMMIT` without an answer is `Ambiguous`, §4.3). **Per-tier timeouts** (R33-09):
the session renewal, the batch's epoch read and the standby's session poll use **400 ms**
per tier (a metro statement normally takes about 1 ms), other statements the 2 s statement
timeout. A **per-tier circuit breaker** opens on BFD loss of the metro link or placement's
"metro split" state for the process's region (§7.3), or after 3 consecutive per-tier
timeouts, and the pool then starts at the next live tier; so a split costs at most one
400 ms timeout per tier before the R2 tier is used, and a renewal reaches the database well
inside the holder's 2.9 s view. A gateway
only forwards to leaseholders, so a fallback costs about one extra Nairobi–Mombasa round
trip (about 10 ms, est.) and no rule; since R2 reaches every Kenyan facility in a metro
split, every leaseholder stays reachable from either side of the split; Kafka uses `@confluentinc/kafka-javascript` (librdkafka); gRPC uses
`@grpc/grpc-js`.

### 5. Kafka and the outbox relay

#### 5.1 Why Kafka, not Redpanda

RFC-000 allows Redpanda. RFC-006 picks **Apache Kafka (KRaft mode)**, because of how each
replicates under the constraint that **no broker runs in R3** (RFC-000 AI5-3). Redpanda
replicates every partition by Raft, so a write needs a majority of its replicas; with
replicas only in the four Kenyan facilities, a Kenyan region loss leaves 2 of 4, no
majority, and every partition stops until an operator forces a reconfiguration. Kafka's
in-sync-replica model lets a partition continue on the surviving region's two replicas
once the controller (whose quorum includes R3's metadata-only controller) removes the lost
ones from the in-sync set, with no unclean election. Redpanda would need a broker in R3
holding data, which AI5-3 rules out (RFC-000 revision 4.1, AI6-2).

#### 5.2 Cluster topology and broker configuration

| Item | Value | Why |
|---|---|---|
| Brokers | 6 per Kenyan facility, 24 in all; none in R3 | §19.2 |
| KRaft controllers | 5 voters: one in each Kenyan facility, one in R3 (metadata only, no partition data) | A controller majority (3 of 5) survives any one region. **The active controller is kept in the preferred region** (R6-28, R27-20): Apache Kafka has no admin API that makes the active controller resign, so placement checks every 10 s and, when the active controller is in R3 or in the other region, makes a **controlled restart of that controller process** (at most once a minute), which makes the remaining voters elect another; R3's controller process is restarted with the same rule. The spike confirms that a controller restart moves leadership within seconds without fencing brokers; RB-15 states it |
| `broker.rack` | The facility (`r1a` … `r2b`) | Rack-aware placement: one replica per facility |
| Replication factor | 4 | One replica per facility |
| `min.insync.replicas` | **3** while all four facilities hold in-sync replicas; **2** whenever any facility is lost or **drained** for maintenance, a region is lost or isolated, a metro is split, the Kenyan link is cut, or an in-sync shrink of one region's replicas is observed (R33-10) (§7.3 "Kafka degraded"; decision D3, R6-11, R6-12) | With four replicas and three required, every acknowledged write is on at least one replica in each Kenyan region. With one facility gone, any further broker failure would leave 2 in sync for about a sixth of the partitions and stop them (R6-12); Kafka is transport and the facts are two-region in the database (§5.3), so placement lowers it through the admin API the moment the state changes, and restores 3 once all four facilities have been in sync for 10 min. A drain lowers it before the first broker stops |
| `unclean.leader.election.enable` | false | No acknowledged message is lost by an election |
| `replica.lag.time.max.ms`; `broker.session.timeout.ms`, `broker.heartbeat.interval.ms` | **4 s; 4 s, 1 s** (decision D2, R27-06; defaults 30 s, 9 s, 2 s) | With `acks=all` the leader waits for every in-sync replica, so a crashed broker stalls produce to its partitions until it leaves the in-sync set: by the lag rule or when the controller fences it on session expiry. At about 3 to 4 s the stall of one broker crash, or of a facility loss (every partition), stays inside the 10 s feed targets (§10.3: `O` ≤ 4 s plus `L` = 3 s is the breach-free bound of 7 s). Cost: more in-sync churn under load (facts are in the database, so a flap costs nothing durable); the spike measures flapping under the design load (§22.1). `min.insync.replicas` keeps writes two-region meanwhile |
| Partition leaders | Preferred replica in the preferred region (assignment order), `auto.leader.rebalance.enable` = true; placement reassigns preferred leaders on a region-wide failover (§7.4) | Producers (owners) are in the preferred region |
| Follower fetching | `replica.selector.class` = rack-aware; consumers set `client.rack` | Consumers read from their own facility's replica; no cross-region fetch traffic |
| Retention | 3 days for the metering hand-off (`ingestion.handoff.v1`, C11) and charge-line (`rating.charge-lines.v1`, C06) topics; **26 h for the relay topics `cdc.*`** (R6-20); **at least 7 days for `account.usage-applied.v1`** (C05 S-4, sized in §19.4); **at least 14 days, `cleanup.policy=delete` (never compaction) and `max.message.bytes` = 1,048,576 for identity's personal-data store events feed** (C09 R36-06, R48-06; events ≤ 512 KiB); compacted for `relay.progress.<kind>`; 7 days for every other topic | Transport only (§5.6); the outbox tables keep 25 h, the self-outboxed logs 25 h, and the archive keeps everything. A consumer further behind uses history, or `usage_applied_since` for the usage-applied acknowledgements (§5.5) |
| Compression | zstd producer batches (headers and clear fields; payloads are already compressed and encrypted) | |
| Security | mTLS between brokers and clients (RFC-005's PKI). **A per-topic producer ACL** (C01 §2.5, settled M8, R47-06, R47-25) names exactly the producing principals of each topic and nothing else: an owner feed `<kind>.<feed>.v<n>` (notifications and report markers included): `<kind>-holder` (direct publish and the takeover republish) and `<kind>-relay`; a closure topic `<kind>.<feed>.v<n>.closure`: `closure-emitter-<kind>` only; `<kind>.alert.v1`: `<kind>-holder` and `<kind>-relay` (the self-outboxed `ingest` alerts: `ingest-relay`); `cdc.<kind>` and `cdc.audit.<kind>`: the database's CDC principal only (the CDC listener admits only database nodes, §3.5); `relay.progress.<kind>`: `<kind>-relay` only; `placement.slot_map.v1` and `placement.routing.v1`: `placement-holder`, `placement-relay`. A topic that its contract gives other producers lists exactly those (C06 `settlement.posting-acks.v1`: the ledger's holder and relay and settlement's principal; `catalogue.v1`: the catalogue only, C06 D7; CI6-3). Kafka enforces WRITE per topic, so no rule depends on a consumer learning a record's principal | A1 for transport; no holder or relay can forge closure and the emitter cannot inject data; no credential in a changefeed definition |

#### 5.3 The outbox: two publish paths

Every feed event is an outbox row committed in the same transaction as the fact it
reports (RFC-000 §5.5). It reaches Kafka by two paths:

1. **Direct publish** (the fast path): after `Committed`, the holder produces the batch's
   outbox rows to their destination topics (`acks=all`, idempotent producer), tens of
   milliseconds after the commit (est.). It never publishes before commit, so nothing is
   published that did not commit.
2. **Changefeed relay** (the guaranteed path): the outbox table's changefeed (§3.5) carries
   every committed row to `cdc.<kind>`, and the relay forwards it to the destination topic,
   about 1 to 2 s after the commit (est.).

So every event is normally published twice; consumers drop the duplicate by (partition,
stream, stream sequence) (§5.5). The **takeover republish** (§4.4) adds a third copy only for the last
`republish_window` of a slot that changed holder. Nothing in Kafka is a fact: a lost topic
or cluster is rebuilt from the database (§5.6).

**Report markers.** The request outcome feed carries the slot's report position as
**per-slot markers** (slot, generation, epoch, report position), written as outbox rows of the slot's
next batch or of a marker-only transaction (§4.6; RFC-000 B-AI-8). The outcome topic is
**keyed by slot**, so the direct path puts a marker after every outcome it covers in the
same Kafka partition; on the relay path a slot's outcome rows and its marker arrive from
different `cdc` partitions in any order, and the **`reported` gate's buffering** keeps the
rule: an outcome is held until a covering marker has arrived (R33-08). The notifier and every other consumer that reports
outcomes acts only on an outcome event whose commit timestamp is at or below the report
position of a marker of the same slot written by the same or a later writer (epoch at
least the event's). A marker-only transaction runs outside the slot's batch lane (§4.6).
The markers are C01's `ReportMarker` with its chain (§4.6). The `reported` gate uses only
`reportPosition` and `epoch`, and for the gate only a marker at or below the last one seen
is ignored. **The consumer runtime keeps every marker** of the outcome feed by (slot,
epoch, `reportPosition`, `chunk.part`) and gives each to `onMarker`, without that drop
(C01 §3.4 rule 9, N-01): the relay path and the takeover republish can deliver markers out
of order, and a first covering marker that arrives after a later marker must still give
its `pendingAnswered` list to the notifier (§15). A consumer finds an outcome's **first
covering marker** from the interval `prevReportPosition` < `ts` ≤ `reportPosition`, not
from arrival order. If the first covering marker has not arrived within `gap_timeout`, the
consumer reads it from the outbox or from history, as for a feed gap (§5.5).

**Feed closure: relay progress and the closure emitter** (R27-03; RFC-000 revision 4.3,
AI-27-3). A changefeed hashes each outbox row's primary key over the `cdc.<kind>`
partitions, so the rows of one destination partition arrive over all of them, and a
resolved timestamp on a `cdc` partition says nothing about the others. The relay is a
stateless consumer group whose instances each hold some `cdc` partitions and may be
rebalanced. Closure is therefore computed in two steps, independent of how the changefeed
partitions:

1. **Relay progress.** A relay instance processes each `cdc` partition `k` it holds in
   order. When it reads a resolved timestamp `R` on `k`, it **flushes** its producer (every
   row it read from `k` before `R` acknowledged by Kafka, `acks=all`), then writes a
   progress record (`k`, `R`) to `relay.progress.<kind>`, a compacted topic keyed by `k`, and
   only then commits its consumer offset. One flush per consumer poll covers every
   partition whose resolved timestamp arrived in that poll (R33-14), so the 64 partitions'
   resolved messages a second cost a few `acks=all` round trips a second, not 64 serial
   ones. A successor after a rebalance or a crash restarts
   from the committed offset, re-relays (consumers drop duplicates by stream sequence) and
   reports again; a progress record is never written for rows not yet acknowledged.
2. **The closure emitter** is a platform owner with one slot per relayed owner kind (about
   20 slots, held in the preferred region with standbys like any slot, §4). Its state is
   `R_k` per `cdc` partition, rebuilt on acquisition from the compacted progress topic.
   Because compaction drops the link lists of superseded progress records, a new emitter
   holder emits `CLOSED` for **every** link once at its first `R_min` (R33-14), so no link
   waits for its heartbeat after a takeover.
   `R_min` = the minimum of `R_k` over **every** partition of `cdc.<kind>` **as the topic's
   metadata lists them**; a partition with no progress record (added by a recreation or a
   growth of the topic) holds `R_min` back (C01 R47-20). When `R_min` advances, the emitter
   publishes, for each stream of the kind declared with closure, on that stream's **closure
   topic** `<topic>.closure` (C01 R47-06), per destination partition, a marker "no row with
   a commit timestamp at or below `R_min` will follow on this destination partition": a
   **`ResolvedMarker`** (`dataTopic`, `partitionCount`, `destinationPartition`,
   `resolved`, `dataHighWater`, `emitterEpoch`) or, on the **link schedule feed**, a
   **`ClosedMarker`** (`link`, `t` = `R_min`, `feedSeq`, the same partition fields) per
   link. Each marker carries **`dataHighWater`**, the end offset of the data partition read
   **after** `R_min` was established: every row with `ts` ≤ `R_min` was acknowledged before
   that, so it lies below that offset. The consumer runtime fires `onResolved` (or
   `onClosed`) only after its position on the data partition has passed `dataHighWater`
   and every buffered event with `ts` ≤ `R` of that destination partition has been
   delivered. Only the emitter can write a closure topic and it cannot write a data topic
   (ACL, §5.2), so no holder or relay can forge closure and the emitter cannot inject data.
   Markers name the partition count they were computed for; a consumer re-subscribes its
   destination partitions when the count grows (§5.4).
3. **`feed_seq` state is explicit**: for `CLOSED(t, feed_seq)` the emitter reads each link's
   last schedule-feed sequence from `link_head.streams` **as of `t`** by a follower read
   (`AS OF SYSTEM TIME t`; `t` is a resolved timestamp, so at or below the closed timestamp
   and served locally): exactly the last `feed_seq` committed at or below `t`, with no state
   of the relay's to rebuild. It emits `CLOSED` only for links whose `feed_seq` changed since
   their last marker (the relay's progress records list the links it relayed rows of), and
   a **heartbeat** `CLOSED` for every link every `closed_heartbeat` (10 s), so an idle link
   still closes its minutes.
4. **Ordering and crash points.** Markers are idempotent: a consumer ignores one at or below
   its last. Emitter crash between markers: its successor recomputes `R_min` and re-emits.
   Relay crash between produce and progress: re-relay and re-report. A changefeed recreated
   from a `cursor` (§3.5) restarts every `R_k` at the cursor; `R_min` never goes back, since
   the emitter keeps the highest it published (in its log) and publishes nothing until
   `R_min` passes it.
5. **Streams that carry closure** (C01 settled M7, §3.6; C06; AI-55-2). Every stream
   whose declaration says `closure: 'resolved'` or `'closedPerLink'` gets markers. Today:
   the reservation lifecycle feed (RFC-002), the link schedule feed (RFC-001,
   `closedPerLink`), the catalogue (RFC-003, `catalogue.v1`), the metering hand-off
   (RFC-003, self-outboxed), the identity status push (RFC-005) and the ledger movement
   feed (RFC-004, with its filtered views), and the topics C06 marks "Yes"
   (`rating.unposted-usage.v1`, `account.usage-applied.v1`, `rating.charge-lines.v1`,
   `rating.affected-marks.v1`, `rating.quarantine-report.v1`, `rating.breach-report.v1`;
   CI6-2). **Each topic with markers has exactly one relayed owner kind** (RFC-000 revision
   4.5, AI-55-2), because `R_min` is one kind's minimum. A topic with direct publishes
   outside any outbox gets **no** markers: `settlement.posting-acks.v1` (C06 m10).
   Owners emit no closure markers of their own.
6. **Lag and volume (est.).** Closure follows the changefeed's resolved timestamps (about 1.5
   to 2 s behind now, §3.5) by the flush and one progress round, about 2 to 3 s behind now,
   inside RFC-003's 3 to 5 s planning figure. Progress: about 64 `cdc` partitions × 20
   kinds a second, about 1,300 small records/s; lifecycle markers: one per destination
   partition a second (about 4,096/s); `CLOSED`: one per link with events a second plus the
   heartbeats, a few thousand a second (est.). Counted in §19.3.

Consumers see closure only through `onResolved` (C01 §2.4), per destination partition.

#### 5.4 Topic conventions

C01 §2.5 is the wire format; this section gives the rules and their reasons.

- **Names**: `<owner kind>.<feed>.v<n>` (for example `account.outcome.v1`,
  `ingestion.handoff.v1` (C11 uses this name; AI-41-5), `account.standing.v1`,
  `notifier.delivery.v1`); closure topics `<owner kind>.<feed>.v<n>.closure`; relay topics
  `cdc.<owner kind>`; audit topics `cdc.audit.<owner kind>`; relay progress
  `relay.progress.<owner kind>` (compacted); alerts `<owner kind>.alert.v1`; placement
  `placement.slot_map.v1` and `placement.routing.v1`. A contract may name a topic outside
  the pattern; its ACL then lists its producers (§5.2).
- **Keys**: the producing partition, so one partition's events stay in order in one Kafka
  partition. **Exceptions**, each named by its contract: the request outcome feed is keyed
  by **account slot** (B-AI-8), which keeps every partition of a slot, and its markers, in
  one Kafka partition (order per account partition is unchanged, since a slot's events are
  produced in commit order); **`attribution.parts.v1`** is keyed by account, for stage B's
  locality (C11; AI-41-5); the **filtered views** of the ledger movement feed
  (`ledger.movements.by-buyer.v1`, `.by-supplier.v1`, `.by-external.v1`) are keyed by the
  view key, and their consumers deduplicate by (view key, `EventId`) (C06 m11). No rule
  below depends on the key: consumers order by `stream_seq`.
- **Partition counts** (C01 §2.5, R47-30): a power of two at least the producer's slot
  count divided by 4. A count may **grow** (never shrink), for example when the account
  slot count doubles (account topics from about 4,096 to about 8,192 partitions, est.).
  A growth re-maps keys. It is safe **only** because consumers order by `stream_seq` with
  buffering and the `reported` gate buffers by the `slot` header, never by Kafka offset,
  and because closure markers name the partition count they were computed for (§5.3).
  Partitions per broker after one doubling are in §19.2.
- **Headers** (C01 `FeedHeaders`, the only clear fields): `partition`, `stream` and
  `stream_seq` (feed events) or `notification_id` (point-to-point notifications),
  `generation`, `epoch`, `ts` (commit timestamp), `kind`, `schema_v`, `key_id`; on the
  request outcome feed **`slot`** on every event and marker (C01 R47-22); on markers
  `report_through`. The header set may only grow.
- **Value**: the owner's ciphertext payload, sealed under the topic's feed key; schemas are
  versioned with the entry kinds and kept in a schema registry so every reader can decode
  every version for 7 years (§13.5).
- **Topics** (RFC-000 §8 and the contracts): the metering hand-off (C11); the request
  outcome feed with report markers and the reservation lifecycle feed (C04); the link
  schedule feed (C03); the standing feed, the standing enforcement acknowledgement and the
  usage-applied acknowledgement (C05); the identity status push, the endpoint feed and the
  policy feed (C08); the catalogue feed, the unposted-usage feed, the charge-line feed, the
  affected marks, the posting acknowledgement, the ledger movement feed and its three
  filtered views, and the quarantine and breach report feeds (C06); the invoice-status feed
  (C07); the partner reconciliation feed (C12); the personal-data store events feed (C09);
  the placement feeds, the operational alert topics, the closure topics and relay progress
  (C01); probe results; and `notifier.delivery` (§15).

#### 5.5 Consumers: order, deduplication, gaps and replay

- **Feed events** (RFC-000 §4.4, AI-17-2). A consumer applies an event of (partition,
  stream) only if its `stream_seq` is the next one it expects, whatever its (generation,
  epoch), and **buffers** a later one until the gap is filled: stream sequences continue across owner changes and moves, so no epoch rule is
  needed to order them (R6-09). It ignores lower ones (duplicates of the two publish paths
  and the takeover republish), and on a **gap** waits `gap_timeout` (5 s) and then reads the
  missing events directly from the producer's outbox by (partition, stream, `stream_seq`),
  through the outbox's partition index (so across moves), by follower read under its own
  **`gapfill_<consumer>_<producer>`** role (§3.7; C01 R47-19), or below 25 h from history,
  so a lost or delayed Kafka message costs seconds, never a fact. **Exception** (C05 S-4):
  rating fills a gap of `account.usage-applied.v1` by replaying the topic (retained at
  least 7 days, §5.2) and then by the status readers' `usage_applied_since`; no consumer
  reads the account owner's outbox for that stream, and no gap-fill role exists for it.
- **Content conflict** (C01 §3.5, R47-07, review 47 D3). Copies of one event (direct, relay,
  republish) are the same outbox row and so are byte-identical. A copy of an already seen
  (partition, stream, `stream_seq`) whose bytes differ is a **conflict**: the consumer
  runtime reads the committed row from the database through its gap-fill role, and **the
  database copy wins**; it raises `FEED_CONTENT_CONFLICT` (security and platform on-call,
  naming the topic and both producing paths) and **blocks the stream at that
  `stream_seq`** until the read answers. If both copies are buffered, it applies only the
  database copy. If the conflicting copy arrives after a copy was applied, the runtime
  compares the database copy with the recorded digest: if the applied copy was the
  database's, it continues; otherwise the stream stays blocked and the owner's correction
  path applies under incident handling, never a silent overwrite.
- **Point-to-point notifications** (waiting notice, capacity released, yield requested,
  `DISPLACED`, release acknowledged, expire requested) are idempotent state messages: the
  receiver applies one whose (request, attempt, kind) is new, however late, and records the
  identity in the same entry as the effect; there is no high-water rule. The runtime's
  `append` (its `notifications`, §4.3) sends them; the receiver also reconciles every request still waiting with
  a `query` on a timer (the owner RFC's interval).
- **Commands** are refused below the highest (generation, epoch) recorded for the sending
  partition, with `STALE_SENDER(recorded)` (§4.5).
- An owner that consumes checkpoints (partition, stream, `stream_seq`) **and the applied
  event's ciphertext digest** in its **own** log, in the same batch that applies the event
  (C01 §3.5); Kafka offsets are committed only as a restart hint.
  A consumer restart neither skips nor double-applies.
- **Replay from the start.** A consumer rebuilding from older than the outbox's 25 h reads
  the producer's sealed log segments from history (§13.3): each log row lists the
  (stream, `stream_seq`) of the events it emitted (`emits`, §3.7), and the owner RFC's
  versioned **emit function** turns the entry into the event, so history serves any stream
  from the log at lower throughput (about 50 MB/s per stream, est.); the consumer switches
  to Kafka at a resolved timestamp it has passed.

#### 5.6 Kafka failures

| Failure | Effect | Action |
|---|---|---|
| A broker | Produce to every partition that had it in sync **stalls** (`acks=all`) until it leaves the in-sync set or its leaders move: at most about 4 s (§5.2, R27-06); then 3 in sync | None; replaced as a node. Feeds 4 s late at worst: no breaching X2-S22 or X2-S17 event (§10.3) |
| A facility (lost or drained) | Every partition loses one replica: produce to **every** partition stalls up to about 4 s on a loss (none on a drain, which moves leaders first); then 3 in sync | Placement lowers `min.insync.replicas` to 2 at once (D3), so a further broker failure elsewhere stops no partition; restored to 3 after recovery (R6-12) |
| A Kenyan region | 2 replicas in sync; producers fail with `NotEnoughReplicas` until placement lowers `min.insync.replicas` to 2 (seconds after the topology state changes) | Automatic (§7.3); feeds resume from the surviving region; the takeover republish and the changefeed cover the gap |
| A correlated in-sync shrink (both R2 replicas, or both R1 followers, of many partitions behind for more than 4 s: heavy loss or a stall on the Nairobi–Mombasa paths short of a cut; R33-10) | With `min.insync.replicas` 3, produce to those partitions fails with `NotEnoughReplicas` | Placement lowers `min.insync.replicas` to 2 once more than 2% of partitions show it for 2 s ("Kafka degraded", §7.3; D4), so produce continues within about 3 s of the in-sync shrink (about 7 s from the stall's start: 4 s to the shrink, 2 s to the trigger, then the admin call; at §10.3's 7 s bound); restored to 3 after 10 min fully in sync. The window with one region's replicas only is seconds; facts are in the database |
| A metro split (R33-03, V-2) | About half the partition leaders stay in the cut-off facility, reachable by R2 but not by the chosen side's producers and consumers; the replicas that cannot reach their leader leave the in-sync sets within 4 s; a controller in the cut-off facility would fence the chosen side's brokers | Automatic, by admin calls through an R2 broker: a cut-off controller restarted through R2 (preferred-region rule suspended); for each partition led in the cut-off facility, its first in-sync R2 replica put first and elected, then the chosen facility's once back in sync; a controlled shutdown of the cut-off brokers after 20 s; `min.insync.replicas` 2 (§7.3 step 4; review 33 D2) |
| The Kenyan link cut (both Nairobi–Mombasa paths, R6-11) | R2's two replicas of every partition fall out of sync; R1 keeps two in sync; R2's consumers and brokers are cut off from R1 (no transit through R3, §20.1) | Placement lowers `min.insync.replicas` to 2 ("Kafka degraded", §7.3), so R1's producers continue; the active controller is in R1 (§5.2), so R1's brokers stay unfenced; R2's brokers rejoin and catch up after repair. Residual: a cut at the instant the controller is outside R1 fences R1's brokers until RB-15's controlled restart of that controller (RK29) |
| The whole cluster | Feeds stop; facts keep committing (owners do not wait for Kafka); consumers fall behind | RB-15: restore the cluster, then recreate each changefeed from the oldest resolved timestamp any consumer applied (within the outbox's 25 h); consumers fill gaps from the logs (§5.5). Admission is unaffected except for webhooks and status of `pending` outcomes by webhook (polls still answer) |

### 6. Time: clock discipline and the offset alarm ladder

#### 6.1 Sources and distribution

- **Kenyan facilities** (R6-14). Each facility has two GNSS-disciplined NTP stratum-1
  servers with **OCXO holdover** (drift of the order of 10 µs a day without GNSS, est.),
  from different vendors, in different racks. Every host runs `chrony` with both local
  servers and the same metro's other facility's servers as sources (sub-millisecond on the
  facility LAN, est.) and the other Kenyan region's servers (about 10 ms RTT) as
  cross-checks. **PTP is not deployed by default**: `ε` is fixed at 100 ms, `τ` uses `ε_cfg`,
  and the first alarm is at 20 ms, so microsecond time buys nothing the design uses. The
  spike measures NTP offsets under load (§22.1); only if any host's offset exceeds 5 ms at
  p99.9 does Share add PTP (grandmaster-capable GNSS servers and hardware time-stamping
  NICs on the database and owner hosts). The trade-off: rubidium and PTP everywhere cost
  hardware and a timing fabric a small team must run; OCXO holdover is days, not weeks,
  which the 24 h GNSS-holdover page (§6.3) already covers.
- **R3.** GCP does not offer PTP to customer VMs. R3's database nodes synchronise by NTP
  from the **Kenyan** time servers over both Johannesburg paths (two independent server
  sets), with Google's metadata NTP server as a monitored source that `chrony` does not
  select. Path asymmetry bounds the error at about half the round trip, at most about 25 ms
  and typically a few ms (est.; the spike measures it). R3's nodes are inside the database's
  clock domain (they compare offsets with every peer and could hold a range lease
  transiently), so their time must come from the same reference as Kenya's.
- **Leap seconds.** Every node, Kenyan and R3, runs the same `chrony` leap-second handling
  (`leapsecmode slew`, the same `maxslewrate`), so all slew together and inter-node offsets
  are unaffected; Google's smeared time is not selected. No leap second is scheduled; a
  runbook (RB-8) re-checks the configuration if one is announced.
- **No steps.** `chrony` may step a clock only at boot, before the database or owner
  process starts; afterwards it only slews.

#### 6.2 The database's bound and the owner hosts' check

- **The database** enforces `max_offset` = 100 ms among its nodes: each node measures its
  offset to every peer, and a node whose offset from a majority of its peers exceeds 80% of
  `max_offset` (80 ms) terminates itself (RFC-000 R4). Its replicas then behave as a node
  loss (§11).
- **Owner hosts.** The runtime of every owner, status-reader and relay process measures,
  every second, its offset to the database: it sends `SELECT cluster_logical_timestamp()`
  over its pool, measures the round trip `rtt` with the **monotonic** clock
  (`process.hrtime`), and takes `offset = db_ts − (t_send_wall + rtt / 2)` with uncertainty
  `rtt / 2`, using the wall clock only for `t_send_wall` (R6-31); a slew during the sample
  cannot then distort `rtt`. The **owner offset bound** is `|offset| + rtt / 2`. Above 50 ms on three
  consecutive samples the process gives up its session (§4.4); above 40 ms it stops taking
  new slots and hands its slots off (§4.2). The database's HLC may run slightly ahead of
  physical time, which makes the check conservative.
- **External reference.** The database cannot see a drift of the whole cluster together.
  A **clock monitor** in each Kenyan facility compares the database's time (sampled as above)
  with three independent references: the facility's GNSS servers, the other region's GNSS
  servers (other vendor), and NTS-authenticated public servers.

#### 6.3 The alarm ladder

| Level | Condition | Automatic action | Alert |
|---|---|---|---|
| Normal | Offsets within a few ms (Kenyan NTP: sub-millisecond; R3 NTP: a few ms, est.) | — | — |
| **W (20 ms)** | Any database node's offset to its peers, or any owner host's owner offset bound, above 20 ms for 1 min; or a facility's GNSS lost (both servers in holdover) | None | Warning; GNSS holdover pages after 24 h |
| **A (40 ms, 40% of `max_offset`)** | Any database node or owner host above 40 ms; or the cluster's time against the external references above 40 ms; or a facility's time source lost beyond holdover | Database node: placement **drains its leases** (`cockroach node drain`, the node stays a replica), so it serves no leaseholder writes; it is restarted and rejoins once within bound for 10 min. Owner host: stops taking slots and hands its slots off (§6.2) | **Page** (RFC-000 R4's alarm, before nodes start to stop) |
| **D (50 ms)** | An owner host's bound above 50 ms on three samples | The process gives up its session at once; standbys take its slots (§4.4) | Page |
| **T (80 ms)** | A database node's offset from a majority of peers above 80 ms | The node terminates itself (the database); a node loss | Page |
| **Region** | More than half of a region's database nodes at level A or above | Topology state "region gated" (§7.3), region-wide failover (T3, §7.4) | Critical |
| **Cluster** | The cluster against the external references above 80 ms | None automatic (no single node is wrong); RB-8 decides whether to stop admission | Critical |

Every level is measured and alarmed independently of the database's own check, so a
drifting clock pages at 40 ms, before the database starts removing nodes at 80 ms. Safety
does not depend on any of it (A8): a confirm is accepted only if its commit timestamp is
before `D − τ`, and a deposed owner's writes fail the epoch condition.

#### 6.4 Timing parameters: `ε`, `δ_x` and `τ`

The fence, the expiry timer and the read-lease margin use one version of `platform_timing`
(version, `ε_cfg`, `δ_x_cfg`, `τ_cfg`, lane settings), written only by placement, to all 64
shards in one transaction (§3.2), and read by every confirm transaction from its shard
(§4.3), so a change orders before every later confirm.

| Parameter | Value | Source |
|---|---|---|
| `ε_cfg` | **100 ms** | The database's `max_offset` (RFC-000 coordinator decision) |
| `δ_x_cfg` | **320 ms** | RFC-000 §4.3 revision 4.2: the worst-case `δ_x` **with batching waits** (R1 lost, owners in R2, commits through R3: `W_a` + expiry commit + hop + `W_l` + release commit, about 300 ms at p99, 305 ms on the hottest link), configured at **p99.9** (AI6-3), to be confirmed by the spike |
| `τ_cfg` = max(`ack_budget`, `ε_cfg` + `δ_x_cfg`) | **420 ms**, **cap 450 ms** | RFC-000 §4.3: confirms only if `ts` < `D − τ`; expiry entry at `D − ε − δ_x`; partner confirm window `commit_margin − τ` ≈ 9.58 s (9.55 s at the cap); `route_deadline_min` (1 s) leaves at least about 550 ms before the fence |

One configured `τ` for every topology state: the worst-case value is what the fence must
honour at the moment a region is lost, before any measurement catches up, and in steady
state it costs only a request's last few hundred milliseconds of commit time. **Beyond the
cap** `τ` is not raised further: placement turns on the **second lane for deadline
entries** (§4.3 (b)) for the account and link kinds in a new `platform_timing` version,
which removes `W_a` and the shared-slot `W_l` from `δ_x` (about 160 ms worst, 235 ms on the
hottest link, est.), and sets `δ_x_cfg` ≈ 235 ms, `τ` ≈ 335 ms. `δ_x` is still **measured**
per topology state (§6.5):

| Topology state (§7.3) | `δ_x` estimate at p99 (RFC-000 §4.3, waits included) | p99.9 the spike must show (≤ `δ_x_cfg`) |
|---|---|---|
| Steady (leases and slots in R1) | about 105 ms (20 + 30 + 5 + 20 + 30); 115 ms on the hottest link | ≤ 160 ms |
| One facility lost in R2, or one Nairobi–Mombasa path cut | about 125 ms | ≤ 180 ms |
| R2 lost, or R1 committing through R3 (Kenyan link cut) | about 275 ms (65 + 70 + 5 + 65 + 70) | ≤ 320 ms |
| R1 lost, leases and slots in R2 (worst) | about 300 ms (70 + 75 + 10 + 70 + 75); 305 ms on the hottest link | ≤ 320 ms |

#### 6.5 Monitored quantities (AI-1)

RFC-000 §4.3 replaced the invariant by measured quantities against configured ones. The
platform measures:

1. **Measured `δ_x`.** For every expiry and every non-confirmed ending entry, the account
   owner records the time from the entry's `ts` to the `ts` of each Share leg's release (both
   commit timestamps, carried in the release acknowledgement, RFC-002). Synthetic **timing
   probes** run one expiry-and-release round trip a second between a sample of account and
   link slots. `δ_x_meas` = p99.9 over a sliding 5-minute window per topology state, and
   the maximum.
2. **Measured `ε`**: the maximum database peer offset and owner offset bound (§6.2), and the
   cluster against the external references.
3. **Late releases**: every Share-link release for an expiry durable after `D`, counted.

| Alarm | Condition | Severity | Automatic action |
|---|---|---|---|
| A-T1 | `ε_cfg` + `δ_x_meas` > `τ_cfg` − 30 ms for 5 min | Warning | None |
| A-T2 | `δ_x_meas` > `δ_x_cfg` for 1 min | Page | Placement raises `δ_x_cfg` to `δ_x_meas` + 20 ms, rounded up to 10 ms, in a new `platform_timing` version (fast attack); `τ` follows; the fence and the expiry move earlier, never the release later (RFC-000 §4.3). Lowered again only by operator order after a week below |
| A-T3 | A-T2 would take `τ_cfg` above its cap (450 ms) | Page | Placement turns on the deadline-entry lane (§6.4) instead of raising `τ`; a fence earlier than `D − ack_budget` still meets POL-26 (stricter), but short deadlines lose commit time. RB-8 |
| A-T4 | Any Share-link release for an expiry durable after `D`; any request still pending at `D` (POL-26) | Page, aggregated per minute | Reported per request (P2-S53, RFC-002); feeds A-T2 |
| A-T5 | Any offset at ladder level A or above (§6.3) | Page | As the ladder |

### 7. Placement, failure detection and region-wide failover

#### 7.1 The placement controller

Placement is an owner on one slot (an admission-class slot, held in the preferred region
with standbys like any other). Its state is tables in the database:

| Table | Content |
|---|---|
| `slot_preference` | Per owner kind and slot: preferred region, preferred facility (by a hash of the slot, spreading slots over the region's two facilities) |
| **`placement_account_slot_map`** (B-AI-10; R6-08, R27-10; C01 §2.3) | The **single source of truth** for account → account slot: per **version**, the slot count `n` (a power of two), the **split state** of each old slot while a doubling is in progress, a digest of the overrides, and **`probe_delta`**, the probe accounts designated in that version (C01 R47-21); every other account is placed by its home (§3.7) as below. Insert-only history; current rows in a projection |
| `placement_slot_override` | Override rows (account, version, slot, reason `probe_pin`, `probe_new`, `reslot` or `dedicated`, operator) |
| `placement_partition_moves` | Every move of a partition between slots of any kind (a hot link to a dedicated slot, an account re-slotted or split off): kind, partition, from, to, new generation, state `prewarm` → `moved` → `adopted` → `done` (§4.5) |
| `placement_split_acks` | Per (slot, map version): the epoch and time at which the slot's holder acknowledged a splitting version, with the upper-half accounts it listed (§7.1 below; C01 R47-05) |
| `placement_integrity_stops` | Integrity stops (kind, partition, `detection_ref`, `stopped` or `resumed`, checkpoint, `at`), written only on audit's `Stop` and `Resume` (§14.3); read by every owner role and by the restore role's row-level security (C01 R47-04, R47-28) |
| `slot_groups` | Sets of slots of different kinds acquired, handed off and taken over together (RFC-003's stage B *i* with rating *i*); a standby or successor takes all slots of a group in one transaction or none (R6-07) |
| `placement_probe_accounts` | Per account slot, its designated probe account (exactly one, B-AI-10, unique), the designating map version and the credit-limit state (`pending` or `applied`); the probe links and exporters per serving region are catalogue designations (§17.1, §17.4) |
| `region_preference` | `R1` by default, until the R1 spike measures each Kenyan region's RTT to R3 (RFC-000 R2-D7); changed by failover and failback |
| `topology_events` | Every topology-state change (§7.3), with its detection time and evidence; insert-only; written by placement only; the **recorded losses** that a declaration names (§8.3) |
| `loss_observations` (R27-21) | Written only by the **loss recorders** (§7.3), insert-only, idempotent by (region, episode): each recorder's observation of a region unreachable, with the evidence time. Placement reads it and never writes it; it is not placement's table |
| `zone_state` | The expected zone configurations (steady, failed over, 2 + 2 for R1 or R2, restoring) and the progress of every change |
| `disasters` | Declared region disasters: their **basis** (the recorded loss they name, or the probe evidence: region, first and last failing probe minute, each minute's probe count and success share, §8.2), declaration and approval (operators, reasons, evidence, times), the window start the system derived, end and how it ended (restored, replaced or, for a probe-evidence disaster, service recovered) (§8.2) |
| `platform_timing` | §6.4 |

Edges and owners read it through a cache refreshed from the placement feed
(`placement.slot_map.v1`, `placement.routing.v1`) and on any `STALE_EPOCH`, `MOVED` or
`MOVING` answer, never by SQL (C01 §6).

**The account slot map** (RFC-000 §8, revision 4.2; R6-08). Placement owns it; the account
owner (RFC-002), the edge's routing (RFC-005) and the probes read it and keep no mapping of
their own:

- `slotOf(account) → { slot, mapVersion, headDecides }` (C01 §2.7, §3.8), served from the
  placement feed's cache (and a point query for a cache miss). The feed carries every new
  version in order. **The rule** (R27-10, R33-04; review 33 D3; C01 R47-29): an override
  row, if any; otherwise, with `h` = the account's home (hash mod `home_space`, §3.7) and
  `s` = `h mod n`, during a doubling to `2n` each old slot `s` is **unsplit**,
  **splitting** or **split**:
  - unsplit: `{ slot: s, headDecides: false }`;
  - **splitting**: the lower half (`h mod 2n = s`) gets `{ slot: s, headDecides: false }`;
    the **upper half** (`h mod 2n = s + n`) gets **`{ slot: s, headDecides: true }`**.
    Placement cannot read head rows, so it always answers `s`; the router sends to `s` and
    then follows the last `MOVED` it got for that account (or retries on `MOVING`), cached
    per account until the slot is split;
  - split: `h mod 2n`.
  An account's slot never changes without a move (§4.5). While `s` is splitting, **both
  slots defer to the head row** (C01 R47-02): `s` answers `MOVED(s + n)` for an account
  whose head names `s + n` **and is adopted**, and `MOVING` while it is not adopted;
  `s + n` serves an account whose head names it and is adopted, answers `MOVING` for one
  whose head names it unadopted, **creates an upper-half account that has no head row**
  (with the implicit `rowAbsent(head)`; C01 V59-2), and answers `MOVED(s)` otherwise. So
  no ping-pong is possible and a creation does not loop between the slots.
- **Splitting handshake** (C01 §3.8, R47-05). Placement publishes version `v` that marks
  `s` splitting. `s`'s holder applies `v`; from then it creates no upper-half account (a
  creation with no head row gets `MOVED(s + n)`), and every creation in either slot
  appends with the implicit `rowAbsent(head)`, so the two slots race safely on the same
  home-keyed row. When no batch of `s` that started before the holder applied `v` is in
  flight or unresolved, the holder calls **`ackSplitting(kind, slot, v, epoch,
  upperHalf, asOf)`**, listing `s`'s upper-half accounts from memory as of that point.
  Placement records it in `placement_split_acks` and moves exactly those accounts (§4.5).
  If `s` is taken over meanwhile, placement asks the new holder again with
  **`listPartitions`** (served by the holder over gRPC), which the new holder answers only
  after it has applied `v` and resolved its in-flight batches (`NOT_ACKED` before). A
  creation in flight at the acknowledgement is therefore either committed before it (and
  listed) or refused `MOVED(s + n)`. After the last move, a version marks `s` split.
  Placement reads no head row: this keeps RFC-000 A1 without a placement read (C01
  review 47 A-2). `ackSplitting` is idempotent by (slot, map version, epoch); a later
  epoch's list replaces an earlier one's.
- `reslot(accounts[], toSlot, reason, requestId, envelope)`, ordered by an operator in
  network operations through the console (RFC-005 envelope, audited); placement applies it
  as partition moves (§4.5), one account at a time, each with its generation increment,
  and publishes the new version once each `adopt` commits. Idempotent by `requestId`
  (`CONFLICT` for the same id with other content).
- **Raising the slot count: doubling only, account kind only, lazy, probe accounts first
  pinned** (decision D7, R27-10; C01 §3.8, R47-21, M12). A count is raised from `n` to
  `2n` only, never otherwise and never lowered, in this order:
  1. placement **leases the new slots** `s + n`: their `owner_slot` rows and holders
     exist, and they serve only override partitions;
  2. it **pins every existing probe account** to its slot by an override row (no probe
     account ever moves, so every slot stays probed throughout) and provisions one new
     Share-internal probe account per new slot in identity (KYB passed, §17.1);
  3. it publishes an **override version** that routes each new probe account to its
     `s + n`, with `probeAccounts` naming them; the count is still `n`;
  4. each new slot's account owner applies **F9** for its probe account, recording that
     version (RFC-004);
  5. finance's set-scoped credit-limit action over `probeAccountSet(v)` is applied: F5
     answers `applied` for every new probe account;
  6. placement publishes the version with count **`2n`**, every old slot unsplit; routing
     is unchanged for every ordinary account, and **no ordinary account routes to `s + n`
     before this step**; the new slots hold only their probe accounts, so they are probed
     from the version's first minute;
  7. it splits old slots lazily, `split_parallelism` (16) at a time, each `unsplit →
     splitting → split` by the handshake above, every ordinary upper-half account (about
     half of the slot's about 6) moved to `s + n` by the move protocol (§4.5, pre-warm and
     report fence included).
  The doubling is done when every old slot is split; the pinning override rows of probe
  accounts stay (harmless).

  **Time** (R33-12, est.): per slot, the pre-warm of about 3 accounts in parallel (a
  follower-read tail about 1.5 s behind, then within one batch), the fence and `adopt`
  (about 0.1 s), the 0.5 s reporting wait, and two map versions through the placement feed
  (about 0.5 s): about **1 to 3 s a slot**, so a doubling of 16,384 slots at 16 in parallel
  takes about **20 to 50 min**. Each account is unavailable for about 100 ms of `Moving`;
  the splitting state keeps every moved account served throughout the window. **Probe
  load** doubles with the slot count: 16,384 more probe accounts × 3 probes a minute per
  capability is about 820 more admission bookings and 820 more wallet reads a second per
  region (est., §17.1, §19.2), and the probe links go from 64 to **128 per region**, so each
  stays below about 40 entries a second (RFC-001). The Kafka partitions of the account
  topics may grow with the count (§5.4).
- **Refusals** (C01 §2.7): a re-slotting is refused, recorded and answered with the reason:
  `PROBE_LEFT_WITHOUT` (it would move a probe account out of its slot), `SECOND_PROBE` (a
  second probe account in a slot), `TARGET_WITHOUT_PROBE` (a slot that has no probe
  account), `NOT_DOUBLING` (a count change other than by doubling) or `CONFLICT`.
- **Probe-account set and credit limits** (C01 §2.7, §3.10; C07 S1; C08 S-M1 … S-M3).
  Placement serves `probeAccountSet(v) → [(slot, account)]`, the exact set of probe
  accounts of version `v`, for finance's **set-scoped credit-limit action** (one action for
  the whole set, POL-15, POL-32; RFC-004), **also for a pending version that is not yet
  published** (C07 S1: step 5 above runs before step 6). It serves
  **`probeSetSummary(v)`** = { `mapVersion`, `slotCount`, `probeAccountCount`, `setDigest`
  (SHA-256 over the sorted (slot int32 big-endian, account bytes) pairs) }, **signed by
  placement's summary-signing key** with its `keyId` (C08 S-M3, R46-21), as a target
  summary for the set: the request comes only from the console's workload under the
  operator's console session with `action_id` and `action_type`, placement refuses a target
  kind that does not match the action, and it **appends the request to audit before it
  answers** (C08 common summary duties; `refused read_limit` on audit's refusal). The
  requester's signing client shows the signed summary and RFC-005 verifies it; there is
  **no four-eyes approval** of the set-scoped probe limit, only one out-of-band
  confirmation per set-scoped action (C08 S-M2). Each member account checks its membership
  by its **own applied F9**, and records `v` only (C08 S-M1). A slot is **published in a
  map version only after its probe account has answered `applied`** to its credit limit,
  so no published slot is ever unprobed or probed by an account without a limit.
- **Ordering**: outside a splitting slot, an owner that receives a command for an account
  its current map version places elsewhere (and adopted there) answers `MOVED(slot,
  generation)`; a command carrying an older map version is re-routed by the sender.
- A dedicated slot for one account (an account given a slot of its own) is an override row
  to a new slot whose probe account placement provisions first; probe accounts of override
  slots are placed by override rows, never by hash.
- **Disaster declaration and end** (C08 R46-27): placement verifies the envelopes of
  `declare_region_disaster` and `end_region_disaster` (four eyes, network operations, §8.2)
  and **calls `operator_check` at apply**; it serves the region-disaster target summary
  with the same summary duties as above.
- **Integrity stops** (C01 §2.6, §3.2; review 47 D2; V59-3 … V59-5). Placement serves
  `IntegrityStop.Stop` and `Resume`, from audit only (mTLS workload identity). `Stop` is
  **one transaction**: it inserts the stop row in `placement_integrity_stops` and
  increments `owner_slot.stops_version` of the slot that holds the partition, and of
  **both** slots while a `placement_partition_moves` row of the partition is not `done` or
  for an account whose `slotOf` answer has `headDecides` (both `s` and `s + n`). Its
  commit timestamp is **`enforced_at`**. `StopAck` (`STOPPED`, `enforced_at`,
  `fenced_slots`) is returned **only after that transaction commits**, so a stop row is
  always an enforced stop. The guarantee is by timestamp: **no entry of the partition
  commits with `ts` > `enforced_at`** (§4.3). `Resume` is the same transaction shape, after
  audit's checks. Errors: `CONFLICT` (same `detection_ref`, other kind or partition),
  `NOT_STOPPED`, `HEAD_MISMATCH` (restored head ≠ audit's first-seen head and no
  `incident_decision_ref`), `PERMISSION_DENIED`. Idempotent by `detection_ref` (the same
  `StopAck`, the same `enforced_at`).

**Failover never depends on placement being up**: range
leases move by the database, and slots are taken by standbys on session expiry; a lost
placement holder delays only placement actions (preference swaps, moves, the 2 + 2 change),
until its own standby takes over (seconds).

#### 7.2 Steady state

- **Range leases** follow the preferences (§3.3); placement checks every 10 s that no lease
  is outside the preferred region and transfers any it finds (`ALTER RANGE … RELOCATE
  LEASE`), at most 100 a second.
- **Slots.** An owner process acquires only slots whose preferred region is its own; the
  in-region standby of a slot is in the other facility. Placement rebalances slots between
  processes of a kind by handoff (§4.2) when a process holds more than 1.2 × its share.
- **Keeping slots with leaseholders** (RFC-000 AI-3). Both are in the preferred region, so
  every commit costs at most a metro round trip between owner and leaseholder. A slot whose
  holder is in the other region (after a cross-region takeover without a region-wide
  failover) is handed back to an in-region process within `drift_correct` (10 s).

#### 7.3 Failure detection: topology states

Placement aggregates, every second: the database's node liveness and per-node health
(`crdb_internal.gossip_liveness`, store metrics), owner session ages, Kafka broker and
in-sync state, per-path BFD and RTT, the clock ladder, and probe results. All are
evaluated **from outside** the region in question.

| State | Condition |
|---|---|
| Steady | Every facility reachable |
| Facility lost | Every database node of a facility not live for 3 s, as seen from both other regions **and** from the same metro's other facility |
| **Metro split** (R6-10) | The two facilities of one serving region cannot reach each other for 3 s while both still reach the other Kenyan region and R3 (BFD and liveness from each side, confirmed from the other region) |
| R3 lost | Every R3 node not live for 3 s from both Kenyan regions |
| **Region unreachable** (R1 or R2) | Every node of both facilities of the region not live for **`region_detect`** = 3 s, as seen from **both** other regions (so a Kenyan link cut, where R3 still hears R1, is not this state) |
| **Kenyan link cut** | R1 and R2 cannot reach each other directly (both Nairobi–Mombasa paths down) while each reaches R3. No traffic transits R3 (§20.1) |
| Kenyan link degraded | R1–R2 RTT above 25 ms for 1 min |
| Region gated | More than half of a region's database nodes at clock level A or above (§6.3), or with disk-sync p99 above 20 ms for 30 s |
| Kafka degraded | Any facility lost or drained, a region unreachable, a metro split, or the Kenyan link cut: fewer than four facilities hold in-sync replicas everywhere (§5.2; R27-20); **or, observed directly** (R33-10, review 33 decision D4), more than 2% of partitions have **both** replicas of one region out of the in-sync set for 2 s (a lossy or stalled Nairobi–Mombasa path that is not a full cut) |

The state drives the `min.insync.replicas` change (§5.2), the region-wide failover (§7.4),
the automatic 2 + 2 change (§8.1), the metro-split consolidation (below), the dashboards
and the `topology_events` record that a declaration names (§8.3). It does not declare a
disaster.

**Metro split: reachability, then consolidation** (R6-10, R27-04; decision D1). With R1's
facilities cut from each other, no range loses its majority: each side still reaches the
other region and R3, so a leader on either side keeps 4 of 5 voters and its lease stays
valid, and lease transfers between the two sides fail. What breaks is reachability from an
owner to the leaseholders on the other side through its own facility's gateways. So:

1. **Reachability (seconds).** Every owner process's pool falls back to the other Kenyan
   region's gateways (§4.7), which reach both sides: a statement towards the far side fails
   or times out (2 s) and is retried through R2, and once placement publishes the state
   (within 3 s of the split plus 1 s) every pool starts at the R2 tier. Commits to ranges led
   on the far side cost about 10 ms more; nothing is unreachable, so sessions renew, batches
   commit and standbys read. Status readers read their own facility's replicas, whose
   closed timestamps keep advancing (their leaders reach a majority); the holder's push
   streams and read leases across the split fail, so readers on the far side of a holder
   answer by rule 4 and polls retry another reader (§4.6).
2. **Consolidation (about 20 to 60 s, est.).** Placement (on whichever side holds its slot,
   reaching the database through R2 like everyone) chooses the facility with more live owner
   processes and database nodes (ties: `r1a`), writes every zone configuration's
   `lease_preferences` as `[[+zone=<chosen>], [+region=r2]]`, and **drains the cut-off
   facility's database nodes** (`cockroach node drain` issued through an R2 node; the nodes
   stay replicas): their leases cannot go to the chosen facility directly (unreachable) and
   so go to R2's voters, the second preference, from where the allocator moves them to the
   chosen facility, which R2 reaches. Placement then has every slot held in the cut-off
   facility **handed off** to its standby in the chosen facility (the holders commit the
   handoff through R2's gateways; a holder that does not answer within 5 s is left to
   expire). Cut-off processes learn the state from the database (each reads the topology row
   every second), stop taking slots, and stay as standbys.
3. **Edges.** The cut-off facility's edge nodes fail their canaries (their owners are
   unreachable without a gateway path for gRPC) and leave the region's load balancing; the
   region keeps announcing (§2).
4. **Kafka leader consolidation (automatic, about 10 to 20 s, est.; R33-03, review 33
   decision D2, V-2).** About half of the partition leaders are in the cut-off facility; they
   still reach R2's followers, while producers and consumers on the chosen side, which have
   no gateway tier for Kafka, cannot reach them. The **replicas that cannot reach their
   leader leave the in-sync sets** within about 4 s (`replica.lag.time.max.ms`): for the
   partitions led in the cut-off facility that is the chosen facility's replica, and for
   those led on the chosen side the cut-off facility's. Placement then:
   1. issues every admin call **through an R2 broker**, which both sides reach;
   2. if the active controller is in the cut-off facility, makes a **controlled restart of
      that controller through an R2 path**, and suspends §5.2's preferred-region restart rule
      for the split's duration, so a controller on the chosen side or in R2 is accepted;
      with the controller there, the cut-off brokers that cannot heartbeat to it are fenced
      by Kafka itself (4 s), and the chosen side's brokers are not;
   3. for each partition still led in the cut-off facility, puts **its first in-sync
      replica among R2's first** in the assignment and triggers preferred leader election
      (Kafka elects only the first assigned replica, and only if it is in sync); once the
      chosen facility's replica is back in sync with the new leader, puts it first and
      elects again;
   4. if a partition is still led in the cut-off facility 20 s after the split, makes a
      **controlled shutdown** of the cut-off brokers through an R2 path.
   The cut-off brokers stay replicas. `min.insync.replicas` is lowered to 2 ("Kafka
   degraded"). Consumers in the chosen facility fetch from leaders or from R2's replicas
   until their own rack's replica is in sync. Restored with the database preference, by
   operator order.

Expected effect (est.): renewals and epoch reads skip a dead gateway tier after one
per-tier timeout (400 ms, §4.7) and the circuit breaker opens at the topology state, so
about 1 to 3 s of failed or slow commits for the ranges and slots on the far side of each
owner (derivation: 400 ms on the own tier, 400 ms on the metro tier, the R2 round trip; the
holders' 2.9 s view is not exceeded, so sessions renew and **no owner change** follows;
R33-09), then about 10 ms more latency on those commits until the drain completes, then
normal latency in the chosen facility; no slot is unserved for more than about 3 s, well
under the 40 s that a failing slot-minute of a slot probed 3 times needs, so 0 to 1 unavailable minute by the 90%
rule (§10.2). Feeds of partitions led in the cut-off facility stall until step 4, about 10
to 20 s: outcome markers, webhooks, standing (X2-S17) and the attribution path (X2-S22) for
about half the accounts are late by up to about 20 s, about 1 breaching minute of each per
split (§10.3). Placement restores `[[+region=r1], [+region=r2]]` and
undrains by operator order once the cut is repaired and stable for 30 min. The case is in
the cut tests (§20.2) and failure injection (§22.2), DT-35.

**Loss recorders outside placement** (R6-29, R27-21). Each Kenyan facility also runs a
**loss recorder** (beside the clock monitor) that evaluates the region-unreachable condition
for the other Kenyan region from its own vantage point and, with the R3 view it reads,
writes a row to its own insert-only **`loss_observations`** table (§7.1), never to
placement's `topology_events`: the row's **time is derived from the liveness evidence** (the
first second in which the region's last heartbeat had been missing, i.e. the start of the
`region_detect` window), never from when the row is written; idempotent by (region,
episode), so the first write stands. Placement records its own `topology_events` row; the
**recorded loss** of a region (§8.3) is the earliest evidence time over both tables for the
episode, which placement and the measurement pipeline compute alike. A loss of R1, which
takes placement's holder with it, is therefore recorded within seconds by R2's recorders
with the right time, before placement's standby takes over, and placement keeps a single
writer for its own table (A1).

#### 7.4 Region-wide failover (R16)

**What it is.** Moving every range lease and every owner slot from the preferred region to
the other Kenyan region together, so that no owner and its leaseholders, and no account and
link owners, are split across regions (RFC-000 A0-05, AI-3), and admission recovers within
1 min. It is automatic; declaring a disaster is not (§8.2).

**Triggers.** Placement sets `region_preference` to the other region when any of these
holds and the other region is **ready** (its database nodes live, not gated, its owner
processes' standbys tailing within 5 s):

| Trigger | Condition | Covers | What moves the range leases |
|---|---|---|---|
| T1 Region lost | "Region unreachable" for the preferred region | R1 lost or isolated | The database, by itself: R1's replicas cannot lead (2 of 5), so leases go to R2, the second preference |
| T2 Probes | In each of `probe_trigger` = 3 consecutive 10 s rounds, **more than 10% of the admission probes** against **each** serving region's edge fail (R6-27), while the preferred region is reachable and the other region's canary commits succeed | A gray failure of the preferred region (overload, disk, a bad deploy there) that the database does not detect. A failure of one region's probes only means that region's edge is failing; it pages instead (RB-12) | Placement: swaps every zone configuration's `lease_preferences` to `[[+region=r2], [+region=r1]]` and drains the leases of R1's database nodes (`cockroach node drain`, nodes stay replicas) |
| T3 Region gated | "Region gated" for the preferred region for 10 s | Site-wide time or storage failure | As T2 |
| T4 Operator | An operator in network operations orders it through the console (RFC-005), with a reason; audited | Planned moves, drills, failback | As T2 |

**Damping.** At most one automatic failover per `failover_damping` (30 min); a second needs
T4. Never to a region that is unreachable, gated or not ready.

**Procedure.**

1. Placement's own slot moves first (its cross-region standby takes it on session expiry or
   by preference) and records the trigger and evidence.
2. **Range leases**: by the database (T1) or by the preference swap and drain (T2 … T4).
3. **Owner slots**, staggered by class so that thousands of acquisitions do not land at
   once: placement and admission (account, link, partner adapter, approvals, identity) at
   once; ingestion after 1 s; payments and ledger after 2 s; rating, attribution and
   settlement after 3 s; the rest after 5 s; within a class, spread over 1 s by a hash of
   the slot. A standby takes every slot it stands by for of one expired session (up to 256)
   in one acquisition transaction (§4.2), and a slot group always together. Under T1 the old sessions expire by themselves and cross-region standbys take
   the slots; under T2 … T4 holders hand their slots off (§4.2).
4. **Kafka**: placement reassigns preferred partition leaders to the new region; under T1
   it also lowers `min.insync.replicas` to 2 (§5.2).
5. Edges learn new holders from `StaleEpoch` hints and the placement feed.

**Expected time (est.; R1 lost; about 21,000 admission slots, account, link, partner and
identity, over about 200 admission processes in R2 (64 of them account, §4.1), so about 200
to 400 acquisition transactions; R27-05, R27-22).**

| Phase | From the loss |
|---|---|
| Range leases of every range re-elected and held in R2 (majority R2 + R2 + R3) | 4 to 9 s |
| R1 sessions expire (up to `session_ttl`) | 0 to 3 s, overlapping |
| `standby_grace` after the session ranges answer again (§4.4: their reads were failing), unless placement has already made R2 preferred | + 0 to 1 s |
| Expiry seen by the standbys' present-time poll | + 0 to 0.25 s |
| Admission slots acquired by R2 standbys (each acquisition transaction about 75 ms through R3, up to 256 slots each), in parallel | + 0.1 to 0.5 s |
| Catch-up of the last 1 to 2 s of each slot (account slots: warm standbys; link and identity slots: hot), `onAcquire`, resumption; reports 0.5 s later (§4.6) | + 0.3 to 1 s |
| Edges re-route | + up to 1 s |
| **Every admission slot served from R2** | **about 6 to 13 s** |
| Every other slot (staggered) | about 10 to 19 s |

The design target is **p99 ≤ 30 s** for every admission slot, leaving half of the 1 min
RTO for anything the estimate misses; the R1 spike measures it. Under T2 … T4 the lease
drain of about 25,000 leaseholder ranges (est., §19) by transfers takes about 20 to 60 s
(est.), during which ranges move one by one and slots follow their ranges' class order; no
range is unavailable for more than one transfer (milliseconds).

**What buyers see.** After T1, the R1 edge is down with R1; R2's edge answers again once its
admission slots are held in R2 (about 6 to 13 s); requests in flight resume (POL-03) or
expire, as RFC-002 specifies; status reads answer `pending` meanwhile (RQ-12, replica rule
3). The failover costs R2 at most one or two unavailable minutes (est.); R1's minutes are
unavailable until R1 returns, unless its loss is declared, and then they are excluded from
the loss the system recorded (§8.3).

#### 7.5 Failback

Leases and slots return to the original region **only by operator order** (T4) once the
region has been back, every range at 2 + 2 + 1, and caught up for 30 min, never
automatically, so a flapping region cannot make leases flap. Failback is the T4 procedure
in reverse. If the R1 spike shows R2 nearer to R3, the default preference becomes R2 the
same way.

### 8. Sustained region loss: automatic 2 + 2, declaration and restoration

#### 8.1 Automatic reconfiguration to 2 + 2 (AI-2)

After the loss of R1 or R2, only 3 of 5 voters survive, so every commit needs all three and
one more node, facility or R3-zone fault stops writes (RFC-000 §5.1). Placement therefore
changes every zone configuration to **2 + 2** automatically once the region has been in
"region unreachable" for **`region_detect` + `reconfig_delay`** (3 s + 10 min), **whether
or not a disaster is declared**, and whether the region is lost or only isolated (a fibre
isolation is never declared). With A the surviving region (R2 below) the `default`
configuration becomes:

```sql
ALTER RANGE default CONFIGURE ZONE USING
  num_replicas      = 4,
  num_voters        = 4,
  voter_constraints = '{"+zone=r2a": 1, "+zone=r2b": 1, "+region=r3": 2}',
  lease_preferences = '[[+region=r2]]';
```

Every explicitly configured zone is rewritten too (R6-18); the full expected set, which
the conformance report checks during and after the change, is:

| Zone | Steady (2 + 2 + 1) | After 2 + 2 with A surviving |
|---|---|---|
| `default`, `meta`, `liveness`, `system`, `timeseries`, the `system` database | 5 replicas, 5 voters | 4 replicas, 4 voters: A's two facilities, two in R3 (different zones); `lease_preferences` `[[+region=A]]` |
| Account tables | 10 replicas: 5 voters, a non-voter per Kenyan facility, the standing R3 non-voter | 6 replicas: 4 voters (A's two, R3's two: the standing non-voter promoted), A's two non-voters |
| Other admission tables, `owner_session`, `owner_slot`, `platform_timing`, placement, approvals, identity | 6 replicas: 5 voters, the standing R3 non-voter | 4 replicas, 4 voters (the standing non-voter promoted) |
| Outbox and self-outboxed log tables | `default` placement, `gc.ttlseconds` 25 h | As `default` after, `gc.ttlseconds` kept |
| Personal-data store | 5 voters, `gc.ttlseconds` 1 h | 4 voters as `default` after, `gc.ttlseconds` kept |

Placement writes each class's zones in one transaction per class, and the conformance
report's expected set follows `zone_state`, so a half-applied change pages.

**Why this is safe if the region is only isolated.** The database applies each range's
change as an **atomic replication change through a joint configuration**: the change
commits only with a majority of the old voters ({A1, A2, B1, B2, C1}: A1, A2 and C1 suffice)
**and** of the new ({A1, A2, C1, C2}). The isolated B voters can never form a majority of
either, because both need an R3 voter that follows A's leader, so the disjoint-majority
hazard of a one-step switch (RFC-000 V-07) cannot arise. The new R3 voter is a learner (or
the standing non-voter) caught up before it is promoted, so the range never needs four of
four. Every majority of {A1, A2, C1, C2} contains an A voter and a C voter: still two
regions (A3, X2-N4), and commit latency is unchanged (leaseholder, Kenyan peer, nearer R3
voter). When the isolated region comes back, its replicas find themselves removed and are
garbage-collected.

**Order and speed (est.).**

| Ranges | How C2 is made | Time to tolerate one more fault |
|---|---|---|
| System ranges (`meta`, `liveness`, `system`) | Learner bootstrapped from C1 (delegated snapshot, small) | about 1 min |
| Admission tables (session, slot, timing, placement, approvals, account, link, partner, identity) | **Standing R3 non-voter promoted**: one joint-configuration change per range, about 150 ms each through R3, about 50 in parallel per store | **about 1 to 5 min** after the change starts |
| Payments (reference bindings about 22 TB), ingestion and ledger: about 25 TB per copy at year 7 | Learner bootstrapped by delegated snapshot from C1, inside R3, on the second voter set | about 2 to 4 h (est.; R6-19) |
| Every other range (the rest of about 38 TB per copy, §19.4) | As above | about 1 h more (est.) |

The second voter set is **24 VMs kept stopped with their persistent disks provisioned**,
under a GCP capacity reservation for the machine type in a second R3 zone (a reservation
covers VMs, not disks, R6-19). Placement starts them when the timer reaches `region_detect`
+ 5 min, so they have joined the cluster (about 3 to 5 min, est.) by the time the change
starts; the admission class does not need them, since its standing non-voters already run
on the 24 running R3 nodes. Placement applies the classes in this order and waits for each
class to finish before starting the next. Until a range's change completes, all three
survivors are needed for its commits (RFC-000 §5.1); the standing non-voter makes that
window minutes for admission, at the cost of one extra R3 copy of the admission tables
(§19.3). On-demand capacity in one cloud region during a regional event is not assured
(RK8). Fault tolerance for the non-admission tables takes hours (RFC-000 AI6-4).

The automatic change is **not** made for "Kenyan link degraded" (both regions alive, R1
still commits with R3), for a facility loss, or for R3's loss.

#### 8.2 Declaration (POL-06 and POL-32 as of `requirements-v1.8`)

- **Who** (POL-06, POL-32, X2-S25, X1-S31). An operator in **network operations** declares a
  region disaster through the operator console, with a reason and its **basis**, and the
  declaration takes effect only once a **second network-operations operator** approves it.
  An attempt by any other role is refused and recorded (RFC-005's approvals; the refusal is
  audited, X1-N8). An unapproved declaration lapses after `approval_expiry` (72 h, POL-32),
  may be cancelled by its requester, and its basis is re-checked at approval. The **end** of
  a disaster is declared and approved the same way.
- **Measured failing minute** (POL-06 v1.8; RQ6-4 resolved by review 22). Only a minute in
  which admission in the region was probed at least 12 times from at least two locations
  and fewer than 90% of those probes succeeded is **probe evidence**. A minute probed less
  than that is not available (§17.3) but is **not evidence and breaks a run**; nor is a
  minute that is unavailable only because of a failing slot-minute (§17.3). The
  probe-results owner records, per (region, capability, minute), the probe count, the
  locations, the success share and the classification (available; measured failing;
  unmeasured; slot-minute failing), so the check reads the measurement's own record and the
  evidence cannot be supplied by an operator.
- **Basis** (POL-06; X2-S26, X2-S29, X2-S31, X2-S32). Exactly one of:

  | Basis | Precondition, checked by placement at request and at approval | Window starts at |
  |---|---|---|
  | **Recorded loss** | An open `topology_events` loss of the region (§8.3), named by the declaration; facility reports attached as evidence | The **earlier** of the recorded loss's time and the first minute of an unbroken run of at least `disaster_probe_minutes` (5) measured failing minutes of admission there **leading up to** the loss: the run's last minute is the minute in which the loss was recorded or the one before it (POL-06 v1.8; RQ6-5 resolved; X2-S31) |
  | **Probe evidence** (X2-S29, X2-S32) | No loss of the region recorded at any time from the run's first minute to the request; a **run** of at least `disaster_probe_minutes` consecutive UTC minutes, **each a measured failing minute** of admission in that region; the declaration names the run's first and last minute, and the minute before the first must not be a measured failing minute, so the start is the run's own first minute and cannot be chosen | The run's **first minute** |

  The system computes the window start itself in both cases; the operator cannot state it.
  A declaration with neither basis is refused, recorded, and the minutes count against
  every target. X2-S29: five measured failing minutes 10:00 to 10:04 are declared from 10:00;
  four (10:00 to 10:03) are refused. X2-S32: if the minute 10:02 had 12 probes from two
  locations of which 3 succeeded, it is evidence and the run holds (declared from 10:00); if
  it had only 8 probes, or 12 from one location, it is not evidence, the run breaks into
  two runs of two minutes, the declaration is refused, and 10:02 still counts as
  unavailable. X2-S31: with a loss recorded at 10:06, a run 10:00 to 10:05 (six minutes)
  starts the window at 10:00; a run 10:03 to 10:05 (three) leaves it at 10:06. A request
  made while a run is still open names its last complete minute; the window, once approved,
  runs from its start until the declared end whatever happened since.
- **When** (runbook RB-4): when a whole region has been lost for 10 min with no credible
  restoration within 1 h, or at once on confirmed destruction or loss of power in both its
  facilities; on probe evidence, when the region's admission has been unusable for at least
  `disaster_probe_minutes` with no recorded loss (edges down with the database healthy, for
  example) and the cause is a regional failure, not a single slot. A fibre isolation is
  **not** a disaster unless the region itself is lost (RFC-000 R2-D2; decision D7).
- **Effects: measurement only.** The 2 + 2 change does not wait for it (§8.1), and a
  probe-evidence declaration changes no placement or topology state. The declaration
  records, in `disasters`, its basis, both operators, the reasons, the evidence (each
  minute's classification and counts) and the window start the system derived; the
  measurement pipeline then excludes the disaster window (§18.4).

#### 8.3 When a disaster counts from (POL-06 v1.8)

POL-06: a declared disaster lasts, for every measurement, **from the loss of the region as
the system recorded it when it happened**, or from the start of an unbroken run of at least
`disaster_probe_minutes` measured failing minutes leading up to that loss if that is
earlier, or, with no recorded loss, **from the first minute of the run of measured failing
minutes** it was declared on, until the declared end; a loss never declared is no disaster.

- **The recorded loss** is a `topology_events` row of kind *region unreachable* or *region
  gated* for that region, written by placement or by a loss recorder (§7.3), or the T2
  failover record for it. It is insert-only, written only by those roles, and its time is
  derived from the liveness evidence (the first second of the 3 s `region_detect` window,
  not its end, nor when the row was written), so it cannot be backdated or moved.
- **A declaration must name an open recorded loss** of the region, or a run of measured
  failing minutes; it cannot state its own start time. Whatever start an operator writes in
  the reason (X2-S26's 09:40) is kept as text and ignored by the measurement: the window
  starts as computed above (10:00), and the minutes before it count as usual.
- **A loss never declared** leaves no window: every minute counts against every target, in
  each serving region (X2-S28). The recorded loss is still kept, and the monthly report
  lists it.
- **The end** is the approved end declaration's time. A recorded-loss disaster can be ended
  only once the region is restored or replaced (§8.4); a probe-evidence disaster once the
  region's admission has had at least one available minute since the run, or the region is
  replaced. The end cannot be backdated.
- **A disaster left open over a healthy region** pages network operations and the
  compliance audit read when the region's admission has been available for
  `disaster_healthy_alert` (30 min) with the disaster still open, and every such interval
  is listed in the monthly report, so the exclusion cannot be kept open silently.
- **A loss recorded after a probe-evidence declaration**: the declaration stands, and its
  window already starts at the run's first minute, which is no later than the loss.

#### 8.4 Restoration or replacement

- **Restored region.** Its database nodes are wiped and rejoin as **new nodes** (the old
  node IDs are decommissioned, so no stale replica rejoins). Placement reverts the zone
  configurations to 2 + 2 + 1 in class order (system, admission, …): the allocator adds the
  region's voters by snapshot: the first copy over the Nairobi–Mombasa paths (about 38 TB
  per copy at year 7, about 4.5 to 9 h at 10 to 20 Gbps, est.), the second voter and the
  account tables' two non-voters (about 2 TB each) by delegated snapshots from the first
  inside the metro (about 1 to 2 h more, est.; R6-19), and demotes R3's second voter back to the
  standing non-voter (admission) or removes it, and stops the second voter set's VMs again.
  Kafka partitions are reassigned to the region's brokers and `min.insync.replicas` returns
  to 3 once all four facilities are in sync. Owner processes start as
  cross-region standbys. Once every range is at 2 + 2 + 1 and the region's probes pass,
  operators declare the end (four eyes, §8.2), and failback follows by order (§7.5).
- **Replacement.** A new site takes the lost region's place with new nodes and localities,
  by the same steps. Before the disaster is ended as "replaced", the new site's RTTs are
  measured (§22.1) and the go-live fibre condition is re-verified for it (§20).
- **The end time** in `disasters` ends the measurement exclusion (§18.4).

#### 8.5 Degraded latency, and the two-write path (R13)

After a region loss, a single-link final answer is about 425 ms (R2 lost) or 455 ms (R1
lost) at p99 with the batching waits (RFC-000 §3 revision 4.2; p50 about 200 to 210 ms),
with `pending` within `ack_budget`. RFC-000 R13 asks RFC-006 to evaluate a two-write
single-link path for this state and for the Kenyan link cut. With the degraded waits it
would be about 10 + 6 + 2 × (65 + 70) + 5 ≈ 290 ms (about 230 ms with the second account
lane): **no longer within** 200 ms, so it would not restore X2-S15 in these states.

**Decision: not built.** It is no longer even a lever for the 200 ms target. During a declared disaster the
latency targets are suspended (POL-06), so the path would help only the undeclared cases:
the minutes before a loss is detected are few, and the double Nairobi–Mombasa cut needs two
independent cuts under the go-live condition (§20) and is repaired as a priority-one
incident (RB-7). Against that, the path makes the decision a derived fact over two logs,
which costs the single decision point (POL-04) a resolution step in every status read and
ordering against suspension, revocation and withdrawal (RFC-000 Competition). Degraded,
undeclared states count against the targets in proportion to their share of the month
(Risk RK19). A **replacement site** is not
pre-built (RFC-000 Competition) and remains an option if the business asks for latency
during a disaster.

### 9. Durability: RPO 0

**Rule.** A fact is acknowledged to anyone (a buyer, a payment provider, an exporter, the
service that posted a movement, another owner) only once the transaction that records it
has **committed**: the database acknowledges a commit only once its writes are durable,
synced to the Raft log on disk, on a majority of each range's voters (three of five), which
by placement span at least two regions (A3). A transaction over several ranges commits by
parallel commits, whose staging record and every write are each replicated to such a
majority before the commit is acknowledged. The owner runtime has no other acknowledgement
path: `append` returns success only at `Committed` (§4.3), and the edge's final answer, the
outcome feed and webhooks also wait for the report position (§4.6). Kafka is never the
record (§5.3).

| Fact (X2-S14) | Recorded by | Acknowledged to | When |
|---|---|---|---|
| A confirmed reservation | The account owner's deciding entry (RFC-002) | The buyer | At the report position, after commit |
| A received payment event | The payments partition's event entry (RFC-004) | The payment provider | After commit |
| A posted money movement | The ledger's entry (RFC-004) | The posting service | After commit |
| An accepted usage record | The ingestion partition's batch entry (RFC-003) | The exporter | After commit |

**Why nothing acknowledged is lost on any failure scope.**

| Scope | Copies left of every committed write | Why |
|---|---|---|
| A node or a rack | At least 2 of the 3 that committed it | A node, or a rack (§2), holds at most one replica of a range |
| A facility | At least 2 | A facility holds one voter of a range |
| A region (R1 or R2) | At least 1, in the other two regions; the Raft election rule makes only a voter with every committed entry electable | A region holds two of five voters; a majority of three is never inside one region |
| R3 | At least 2 in Kenya | |
| After the 2 + 2 change | Each commit on 3 of 4 voters, at least one Kenyan and one in R3 | The next facility or zone fault still leaves a copy in two regions (X2-S23) |
| A loss of Kafka, a changefeed, a status reader | No fact is there | Transport and caches only |

Sealed history is in two-region object storage before the live tail is truncated (§13.2),
so retention never depends on the voters. Ingestion may lag (X2-S02): its acknowledgements
are commits, and the consumers behind it read the committed log through Kafka, the logs or
history at their own pace, so a lag loses nothing.

Out of scope, and stated: the simultaneous loss of **both** Kenyan regions (two regions,
beyond X2-N4). R3's single voter may then lack the newest commits; what remains is R3's
replicas, the GCS archive (everything sealed) and the GCS backups (§14), so recovery would
lose at most the commits that had not reached R3 (RK11).

### 10. Recovery per capability: RTO, and hot standbys

#### 10.1 Recovery targets and how each is met

| Capability (POL-06) | RTO node or zone (target) | Design (est.) | RTO region (target) | Design (est.) | Mechanism |
|---|---|---|---|---|---|
| Admission, with the funds holds and headroom checks a booking needs (X2-S21) | 1 min | Owner process or host: about 3.3 to 3.8 s (§4.4); database node under the slot's ranges: 4 to 9 s | 1 h | 6 to 13 s to slots in R2; R2 edge serving | §4.4 takeover; §3.3 range-lease failover; §7.4. The account owner is an admission-class slot, so its funds module recovers with it (RFC-000 §2) |
| Usage ingestion | 1 min | As admission | 1 h | about 7 to 13 s | Same; exporters retry to the other region's edge (anycast) |
| Rating and posting | 5 min (ceiling) | about 4 to 5 s on the attribution → unposted-usage and accrual-posting paths (hot standbys, AI3-9); up to 9 s if a database node under them is lost | 1 h | about 10 to 15 s | §4.4 hot standbys; §10.3 |
| Wallet, other operations | 5 min | seconds | 1 h | about 10 to 15 s | Status readers in both regions; payments and ledger slots |
| Payouts | 15 min | seconds; a run resumes by reference (RFC-004) | 1 h | about 15 s | Payout slots; instructions are facts |
| Reporting and statements | 30 min | seconds (read models in both Kenyan regions) | 1 h | seconds | Read models kept in R1 and R2, each fed from Kafka; a lost region's copy is not used |

Every RTO is verified by failure injection (§22.2), measured from the injection to the
capability's probes succeeding again (X2-S10).

#### 10.2 Availability budget arithmetic

A month has 43,200 minutes; 99.99% allows **4.32 unavailable minutes**, 99.9% allows 43.2.
Under `requirements-v1.10` (POL-06, X2-S30) a minute of admission or the wallet in a region
is unavailable if fewer than 90% of its probes succeed (each judged against its 200 ms
limit), **or** if any account slot had a **failing slot-minute** (at least one probe of the
slot in the minute, and every probe it got failing, a probe failing for this rule only with
no correct answer within **`slot_probe_limit`**, 1 s, **however few the probes**), or if
the capability was not probed as required (§17.3). A slot **probed short** (fewer than 3
probes, or from one location; none at all included) is a **probing fault**: it is alerted
to network operations and does not by itself make the minute unavailable (X2-S33). Each
account slot is probed 3 times a minute per capability and region, once from each location,
**20 s apart** (§17.1). So:

- an event that stops a fraction `f` of slots for `s` seconds fails about `f × s / 60` of a
  minute's probes (90% rule);
- a slot probed as scheduled (3 probes) fails its slot-minute only if all three probes
  fail: an outage of one slot must cover three probe instants 20 s apart, so **outages of
  40 s or less never make a failing slot-minute of a fully probed slot**; one longer than
  40 s costs about one unavailable minute per minute it lasts beyond that;
- **a slot probed short is weaker**: with `k` probes in the minute (1 or 2), every one of
  them failing is enough. A slot is probed short only when the probe estate fails to send
  a scheduled probe (a runner skip, or a location lost in the minute before the other two
  locations double their rate, §17.1); a probe that is sent and gets no correct answer is
  a failed probe, not a missing one. The runners therefore never skip a scheduled probe for
  load: they shed other work first, every skip is a probing fault, and a skip-rate above
  10⁻⁴ per location pages (§17.3). With a skip probability `q` per scheduled probe, the
  extra risk per slot-minute is about `3 q p²` (two probes, both failing), so over 16,384
  slots about `49,000 q p²` per minute: at `q` = 10⁻⁴ and `p` = 10⁻³, about 5×10⁻⁹ per
  minute, nothing next to the `p³` term below. A short window in which **no** probe of a
  slot fails cannot make the minute unavailable, so probe loss alone never costs a minute
  (POL-06's reason for the probing-fault rule);
- independent probe failures **for the slot rule** (no correct answer within 1 s: an error,
  a runner glitch, a lost connection; a probe answered `pending` at about 180 ms whose
  outcome is later confirmed is correct, and a slow but correct answer under 1 s does not
  count) with probability `p` each make a fully probed slot-minute fail with probability
  about `p³`; over 16,384 slots that is `16,384 p³` per minute. `p` is the probes'
  **error** rate, not the 200 ms latency tail: the edge's `pending` timer (`ack_budget` −
  20 ms) and edge event-loop pauses decide the 200 ms tail (the 90% rule and X2-S15), but a
  pause would have to exceed about 800 ms to fail a probe for the slot rule, beyond
  `max_loop_delay` (§4.7) (R27-25).

| Event | Worst minute (est.) | Unavailable minutes per event (est.) | Events a month the 99.99% budget allows |
|---|---|---|---|
| Owner process or host loss (its slots, about 1 to 2% of a kind's, for 4 s) | well under 1% of probes; at most 1 probe of a slot | 0 | unlimited |
| Database node loss (its leaseholder ranges, about 1/48 of R1's, for up to 9 s; R6-22), including the leaseholder of a session, slot or timing shard (§3.2) | about 0.3% of probes; at most 1 probe of a slot | 0 | unlimited |
| Facility loss in the preferred region (half the slots and leases for up to 9 s) | about 8% | 0 to 1 | at least 4 |
| Metro split (§7.3; commits to the far side's ranges failing or slow for 1 to 3 s, then through R2) | about 1 to 3% | 0 to 1 | at least 4 |
| Kafka broker or facility loss (produce stall up to 4 s, §5.2) | none on admission probes (facts commit without Kafka) | 0 | unlimited |
| Region-wide failover after T1 (every slot for 6 to 13 s, p99 30 s) | 10 to 20%; up to 2 probes of a slot (3 only beyond 40 s) | 1 (2 at the p99 tail) | 2 to 4 |
| One account slot down beyond 40 s (a stuck slot) | one failing slot-minute per minute | about 1 per minute of outage beyond 40 s | 4 minutes in all |
| A probe location lost (runner or site) | up to 20 s of short probing for the slots that location was due to probe, before the other two locations double their rate (§17.1); probing faults alerted, no failing slot-minute unless the slot's remaining probes all fail | 0 (unless the service fails too) | unlimited |
| Independent slot-rule probe failures at `p` = 10⁻³ (errors, not latency) | `16,384 × 10⁻⁹` ≈ 1.6×10⁻⁵ per minute | about 0.7 a month (16% of the budget) | — |
| Rolling deploy, one facility at a time, leases drained and slots handed off first | 0 | 0 | unlimited |

Node losses are affordable at the expected rate; facility, metro and region events spend
the budget, and a single slot stuck for minutes now spends it too (as it should: its
buyers were not served). The internal per-slot page (D6, §17.3) fires at the first
failing slot-minute. The last-but-one row is why the share of admission and wallet probes
with **no correct answer within 1 s** must stay below about **5×10⁻⁴** at each probe
location (a spike exit criterion, §22.1; RK28; RFC-000 revision 4.3, AI6-7): at that rate
`16,384 p³` costs about 0.1 minute a month. The 200 ms share now matters for the 90% rule
and the latency targets only (R23, RK26), where a share of 10⁻³ is far inside both. The probes'
three instants per slot are 20 s apart so that one slow moment of a busy slot cannot fail
all three (their failures are then close to independent). Upgrades always drain leases and
hand slots off first (planned maintenance is not excluded, POL-06).

#### 10.3 Hot standbys on the rating paths: the per-minute arithmetic (AI3-9)

X2-S22 and X2-S13 are judged per minute at 99.99%: 4.32 breaching minutes a month.

**Attribution → unposted usage → account (X2-S22, `attribution_lag_max` = 10 s).** Let `L`
be the normal lag from acceptance to counting in headroom (target p99.9 ≤ 3 s, est.: the
direct publish of the hand-off, attribution, rating, the unposted-usage feed and the
account owner's apply), `O` the duration of an interruption (takeover), and `k` the catch-up
rate (throughput at full speed over the arriving rate, at least 3 at the design peak). A
record accepted at time `t` after an interruption starts at 0 is counted at about `O + t /
k + L`, so its lag is `O + L − t (1 − 1/k)`, largest for the records accepted just as the
path stopped: `O + L`. **No record breaches if `O ≤ 10 s − L`**; otherwise the records
accepted over about `(O + L − 10 s) / (1 − 1/k)` breach.

| Takeover `O` | With `L` = 3 s, `k` = 3: breach-free if `O` ≤ 7 s | Breaching minutes per event |
|---|---|---|
| 3.5 s (hot standby, §4.4, p50) | none | 0 |
| 4 s (a Kafka broker or facility loss stalls the feeds, §5.2) | none | 0 |
| 10 to 20 s (a metro split: partitions led in the cut-off facility until Kafka leader consolidation, §7.3 step 4; R33-03) | records accepted over about 4 to 20 s, for about half the accounts | 1 (and about 1 X2-S17 minute, standing changes in the window) |
| 5 s (hot standby, p99, AI3-9) | none | 0 |
| 9 s (a database node under the path's ranges, worst estimate) | records accepted over about 3 s | 1 |
| 5 min (the RTO ceiling) | records accepted over about 7.3 min | 8 or 9: **the whole month's budget** |

So the path must take over in **under about 7 s**, which the hot standby does (§4.4): it
has applied every committed entry of its slot to within about 1.5 s and consumes the same
Kafka partitions, so on acquiring it reads 1 to 2 s of rows and resumes. A database node
loss under the path's ranges can cost one breaching minute (est.), so the budget absorbs
about four a month; the spike's range-lease exit criterion (p99 ≤ 6 s) removes it. The R1
spike measures `L`, `k` and `O` (exit criterion `O` ≤ 5 s at p99).

**Reservation accrual posting (X2-S13, 2 min).** If minute `m`'s accruals are normally
posted within `P` = 30 s of its end (est.), a takeover of `O` delays minutes ending in the
`O − (120 s − P)` before recovery: **no** minute breaches while `O` < 90 s. The same holds
for usage-priced charges against `max_lateness` + 2 min. A zone loss costs no breaching
minute, and the 7-minute bound (X2-S13) is met with a wide margin. During a declared
disaster the affected minutes are excluded and every charge is posted within its target
plus the 1 h regional RTO (X2-S19); the design posts them within minutes (§10.1), and the
ledger's per-line deduplication (RFC-004) ensures none is posted twice.

### 11. Failure modes

Latency figures are single-link p99 (est.) from RFC-000 §3 and §5.1 unless stated. "Targets"
are RPO, RTO, availability and latency in the serving regions.

| Failure | Detection | Automatic action | Effect on targets |
|---|---|---|---|
| A database node holding range leases, including those of session, slot or timing shards (R6-03) | Raft leader loss on its ranges; node liveness | The database re-elects each range's leader among survivors (R1 peer first) and moves the lease; processes whose sessions were in an affected shard keep their warm state and renew (or are taken over warm) when it returns (§4.4); after 5 min, replicas replaced in the same facility | RPO 0. Writes to its ranges, and the slots whose session, fence or timing shard was there, wait 4 to 9 s (est.); no cold reload. No unavailable minute (§10.2). Latency unchanged after |
| A database node without leases | Liveness | Replicas replaced after 5 min in the same facility | None; its ranges have 4 of 5 meanwhile |
| An owner process or host | Its session expires (3 s) | In-region hot standbys take its slots (§4.4) | RPO 0. About 3.3 to 3.8 s for its slots (§4.4). Latency unchanged |
| A status-reader process | Its read leases lapse (400 ms) | The holder stops waiting for it; supervisor restarts it with fresh leases, reading older state only at or after `P_grant` (§4.6) | Reports wait at most one lease; polls retry to another reader (rule 4) |
| An edge or stateless worker node | Load-balancer health check, 2 s | Removed from rotation | Requests in flight retried by clients (POL-29). None measurable |
| A Kafka broker or controller | Kafka; broker session expiry (4 s) | Partition leaders move; the broker leaves the in-sync sets within about 4 s; controller quorum keeps 4 of 5; an active controller outside the preferred region is restarted in a controlled way (§5.2) | None on facts; produce to its partitions stalls up to about 4 s; no breaching feed minute (§10.3) |
| A rack | As its nodes | As its nodes; at most one replica of any range is in a rack | As a few node losses |
| A facility in R1 (preferred) | All its nodes not live 3 s from three viewpoints (§7.3) | Range leases move to `r1b`; in-region standbys there take the slots; Kafka `min.insync.replicas` 2 (D3), feeds stalled up to 4 s; owners whose gateways were there use the metro peer's (§4.7) | RPO 0. 4 to 9 s. 0 to 1 unavailable minute. Latency about 176 ms p99 (RFC-000 §3) |
| A facility in R2 | As above | None for leases; commits use the R1 peer and the other R2 voter, R3 as spare; cross-region standbys of the facility's slots are re-homed to the other R2 facility; Kafka `min.insync.replicas` 2 | RPO 0. None on RTO. Latency about 205 ms p99 while it lasts (RFC-000 §3) |
| A facility drained for maintenance | Placement's maintenance state | Leases and slots moved off first; Kafka `min.insync.replicas` 2 before the first broker stops (D3) | None |
| Region R1 lost (or isolated) | T1: R1 not live 3 s from R2 and R3; the loss recorded with its evidence time by R2's loss recorders (§7.3) | Database moves leases to R2; region-wide failover of slots (§7.4); Kafka `min.insync.replicas` 2 | RPO 0. Admission back in R2 in 6 to 13 s. R1 unavailable. R2 final answers about 455 ms p99, `pending` within budget. Counts against every target unless declared, and then from the recorded loss (§8.3) |
| … still unreachable after `region_detect` + 10 min | Placement timer | **Automatic 2 + 2** (§8.1), declared or not | One further fault tolerated: admission within minutes, the rest within hours |
| … declared | Network operations, four eyes (§8.2) | Measurement exclusion from the recorded loss | Latency targets suspended; availability not measured; charges within target + 1 h (POL-06) |
| Region R2 lost (or isolated) | T1 for R2 | None for leases or slots (they are in R1); the slots have no cross-region standby until R2 returns (their in-region standbys remain); Kafka `min.insync.replicas` 2; after 10 min, automatic 2 + 2 | RPO 0. R1 final answers about 425 ms p99 (commits through R3). R2 unavailable; counts unless declared |
| Region R3 lost | All R3 nodes not live | None (R3 is never on the commit path while Kenya is whole); Kafka controller quorum keeps 4 of 5 | None; each range tolerates one more Kenyan fault, not two. sealing to GCS and GCS backups paused; S3 and the Kenyan hot copy keep segments two-region durable, Ceph backups continue (§13.2) |
| One Nairobi–Mombasa path | BFD, sub-second | Traffic on the diverse path | Latency about 205 ms p99 while it lasts (RFC-000 §3) |
| Both Nairobi–Mombasa paths (two independent cuts; R6-11) | "Kenyan link cut" (§7.3) | R1 keeps leading (R1 + R1 + R3); **no transit through R3** (§20.1), so R2's edges fail their canary commits and, since the probe sites report R1 passing, withdraw from anycast (§2, arbiter), and R2's clients reach R1; Kafka `min.insync.replicas` 2; priority-one repair (RB-7) | RPO 0. R1 final answers about 425 ms p99, `pending` within budget; **R2 unserved** for the cut's duration (its minutes unavailable). Counts against availability and latency (not a disaster, RFC-000 R2-D2; D7) |
| The R1–R3 or R2–R3 path | BFD; R3 replica lag | None | None; ranges lose their spare voter for the duration |
| Clock: one database node drifting | Ladder (§6.3) | Leases drained at 40 ms; self-termination at 80 ms | None beyond lease transfers |
| Clock: one owner host drifting | Owner offset check (§6.2) | Hand-off at 40 ms; session given up at 50 ms | As an owner host loss at worst |
| Clock: a region's time sources fail, or GNSS spoofed there | Ladder; cross-region and external references | Region gated → T3 failover | As a region-wide failover. Safety intact: confirms fail safe |
| Clock: the whole cluster drifts together | External references (§6.2) | None automatic; RB-8 | Deadlines judged against drifted time; never an oversell or partial booking (A8) |
| An owner's event loop stalls (GC, blocking) | Loop-delay monitor | Session given up above 200 ms twice in 10 s (§4.7) | As an owner process loss |
| Slow disk or gray database node | Disk-sync p99 > 20 ms for 30 s; `storage.max_sync_duration` | Leases drained from it; it terminates itself after 10 s of stall | Latency spike for its ranges limited to tens of seconds |
| Gray failure of the preferred region | T2 probes in both regions, or T3 | Region-wide failover by preference swap and drain (§7.4) | 1 to 3 unavailable minutes (30 s of trigger plus the move) |
| A hot link above its slot's capacity | Batch queue length, per-link request rate | Placement moves the link to a dedicated slot at load, with pre-warm and the report fence (§4.5) | About 100 ms of `Moving, retry` for that link (est.); no cold rebuild |
| A hot range | Database load-based splitting | Split and rebalance by the database | None visible |
| Placement holder lost | Its session expires | Its standby takes the slot | None on targets; placement actions pause for seconds |
| A changefeed paused or failed | Changefeed status and lag metrics | Pages at 1 min lag; owners' direct publish continues | None while direct publishing works; RB-16 |
| Kafka cluster lost | Producer errors | Facts keep committing; webhooks and feed consumers stop | RB-15; webhooks late; polls answer; ratings and postings fall behind and catch up (X2-S13 minutes may breach) |
| Archive store unavailable (GCS, S3 or the Kenyan hot copy) | Seal-write failures; archive lag 10 min | Sealing continues to the other stores; truncation waits for two (§13.2) | None while two of three accept; the tail buffers 24 h (§19.4) |
| All archive writes failing | Archive lag 1 h page | Truncation stops; the database grows | None for 24 h; then disk risk (RB-9) |
| Backup schedule failing | Schedule status | Pages after two missed incrementals | None on targets; recovery from logical corruption loses PITR coverage (RB-10) |
| Audit finds a live record altered or missing (RFC-005 §9.3) | Audit's verification against its checkpoints, or the runtime's head-chain check (`integrity_report`) | Audit's `Stop`, enforced at the slot fence (`enforced_at`), stops every decision for the partition (§14.3); RFC-006 restores the partition's log rows from the sealed segments, and the unsealed tail from the backups' revision history as of the last verified checkpoint (§14.3, RB-18), and rebuilds the projections by replay; the owner resumes only after audit re-verifies | RPO 0 for every sealed entry; that partition unavailable meanwhile (minutes to hours, est.); an incident |
| HSMs unavailable in one region | RFC-005's health checks | Owners use the other region's HSMs; data keys cached | None |
| HSMs unavailable in both regions | As above | Owners continue on cached and pre-generated data keys (RFC-005) | None for the cache's horizon; then writes stop (RFC-005 R21) |
| A bad software release (logical fault, crash loop) | Canary facility's digest mismatch (§14.2), crash loops, probe failures | Rollout halts automatically; one facility at a time, leases drained first | Bounded to the canary facility; RPO 0; a faulty apply is corrected by replay (§14.3) |
| A partition between R1's two facilities (metro split; R6-10, R27-04) | "Metro split" (§7.3) | Owners reach far-side leaseholders through R2's gateways; then leases and slots consolidated in the chosen facility by preference, drain of the cut-off facility's nodes and handoff; the cut-off facility's edges leave load balancing; Kafka `min.insync.replicas` 2 | RPO 0. About 1 to 3 s of failed or slow commits for far-side ranges, no owner change, then +10 ms until consolidated (est.); 0 to 1 unavailable minute (§10.2); feeds of about half the partitions late by up to about 20 s until Kafka leaders are consolidated (about 1 breaching X2-S22 and X2-S17 minute, §10.3) |
| Both regions' edge canaries failing (a takeover gap under T1, a database-wide fault), or no probe site reachable | Canary results; the probe sites' verdicts (§2) | **Never withdraw the last announcing region** (review 27 D3); with no arbiter reachable, never withdraw (review 33 D1); errors served, clients retry | No black-holed prefix; minutes count as their probes show |
| Notifier endpoint failures | Delivery failures | Backoff for `webhook_retry`; per-endpoint isolation (§15) | None on other buyers |
| A probe location fails | Runner heartbeat | Two locations remain and probe every slot twice a minute; page | Up to 20 s of short probing: `PROBING_FAULT` episodes to network operations (X2-S33), no unavailable minute by the shortfall alone (§10.2, §17.3) |
| Alert pipeline fails | Dead-man's switch | External watchdog pages | None on targets |

### 12. The platform contract

**The platform contract is C01** (`docs/04-delivery/contracts/C01-platform.md`, version 1,
frozen), and RFC-006 is its provider. C01 governs every signature, table, wire format,
result, refusal, ordering, idempotency key and timeout of the platform. This section does
not repeat them. It maps each part of C01 to the mechanism in this RFC that provides it,
and it states the provider's obligations. RFC-000 §8's rows "Substrate conventions",
"Account slot map", "History query", "Probe designation and exclusion", "Operational
alert feed" and the column-encryption binding are summaries of C01 (RFC-000 revision 4.5).

| C01 part | What it fixes | Provided by |
|---|---|---|
| §2.1 common types | `HlcTs`, `SlotNo`, `Generation`, `Epoch`, `Seq`, `StreamSeq`, `MapVersion`, units | §3.7 |
| §2.2 `OwnerDeclaration` | Entry kinds with retention class and `reportWanted`, projections (keys led by the partition, `clearColumns`, `deletable`, `rowTtl`, `readableBy`), `selfOutboxed`, streams (topic, key, emit function, closure, `reportGated`, consumers), `statusReaders`, entity indexes, bitemporal queries | §3.7 (the migration tool), §3.5, §5.4, §13.3 |
| §2.3 database | DDL of log, stream index, head (`adopted`), outbox, `owner_session`, `owner_slot` (`stops_version`, `report_through`, `marker_seq`), `platform_timing`, placement tables; grants; named platform read roles | §3.2, §3.7, §4.2, §6.4, §7.1, §13.2 |
| §2.4 runtime interface | `OwnerHooks` (`onAcquire`, `onRelease`, `onReportable`, `onMovedOut`, `onAdopt`, `onNotification`); `append` with `conditions`, `reads`, `decide(ctx)`, `AppendOptions`; `AppendResult`; `leaseValid`, `admitCommand`, timing, positions, reads, feeds (`subscribe`, `onResolved`, `onClosed`, `onMarker`), timers, routing, checkpoints; `StatusReaderRuntime`; `CommandEnvelope` and `RoutingRefusal` | §4.2 … §4.7, §5.5, §12.11 |
| §2.5 Kafka wire format | Topic names, keys, partition counts, `FeedHeaders`, `ReportMarker`, `ResolvedMarker`, `ClosedMarker`, `RelayProgress`, the per-topic producer ACL | §5.2 … §5.4, §4.6 |
| §2.6 integrity stop | `Stop`, `Resume`, `StopAck` (`enforced_at`, `fenced_slots`), errors | §7.1, §14.3 |
| §2.7 placement | `SlotMapVersion`, `slotOf` with `headDecides`, `reslot`, `doubleSlotCount`, `probeAccountSet`, `probeSetSummary`, `slotGroup`, `ackSplitting`, `listPartitions` | §7.1 |
| §2.8 history query | `asKnownAt`, `history`, `entries`, `replayFrom`; errors `NOT_CLOSED`, `NOT_FOUND`, `GRANT_REFUSED`, `UNAVAILABLE` | §13.3 |
| §2.9, §3.10 probe designation | Accounts by the slot map (F9 with the designating version); links, exporters and the probe supplier by the catalogue | §7.1, §17.4 |
| §2.10, §3.11 operational alerts | `OperationalAlert` with episodes, `cleared`, `ProbingFaultDetail` | §16, §17.3 |
| §3.1 … §3.9 semantics | Sessions, resolution steps, `append` results, moves, report position and marker chain, outbox and consumption, closure, timers, routing and the slot map, history | §4, §5, §7.1, §13 |
| §3.12 column encryption | Sealing of every application column under RFC-005 C13 | §12.8 |
| §4 … §7 | Delivery and ordering, idempotency, ownership, timeouts | §4, §5, §12.10 |

**Provider obligations.** RFC-006 passes C01's provider tests **CP-1 … CP-14** (C01 §10.1)
in CI, with the Jepsen-style harness and the TLA+ model of §22.2; the design-level tests of
§22.3 cite them. The consumer tests CC-1 … CC-8 (C01 §10.2) are run by the runtime's stub
for every owner kind. A change of a result's meaning, a new `AppendResult` variant, a new
`RoutingRefusal` code, a required hook or a lane kind (for example lane (c), §4.3) needs a
new C01 version (C01 §8); a new optional field or option is a minor version of the
`@share/owner-runtime` package.

**Points C01 adds to earlier revisions of this RFC**, each now stated in its section:
`decide(ctx)` and declared `reads` (§4.3; M2, R47-11); `AppendOptions` and the
`displacementRead` condition keyed (link, request) (§4.3, §3.7; M3, R47-01); the canonical
refusals with `STALE_SENDER(recorded)` (§4.5; M4, R47-09, D4); resolution steps for
`Ambiguous` and the 15 s backstop (§4.2, §4.3; M1, R47-13, R47-14); `Retry` after exhausted
retries (§4.3; R47-12); `adopted` and `Moving` until `adopt` (§3.7, §4.5; R47-02); the
marker due on `moved` and the successor's push (§4.5, §4.6; R47-03, V59-7); `stops_version`
and the stop enforced at the fence (§4.2, §4.3, §7.1, §14.3; R47-04, D2, V59-3 … V59-5);
`ackSplitting`, `listPartitions`, `headDecides` with `slot: s`, creation in `s + n` and the
doubling order (§7.1; R47-05, R47-21, R47-29, V59-2); closure topics with `dataHighWater`
and `R_min` from topic metadata (§5.3; R47-06, R47-20); the per-topic producer ACL (§5.2;
M8, R47-25); the conflict rule (§5.5; D3); the `slot` header (§5.4; R47-22); alert episodes
and `PROBING_FAULT` (§16; M9, R47-08, R47-26, D1); `report_through` and `marker_seq` on
`owner_slot` (§4.2, §4.6; V59-6); the `ReportMarker` chain (§4.6; V59-1, N-01, N-12);
lane (c) excluded (§4.3; R47-31); `leaseValid` margin and the clock precondition (§4.2;
R47-23); partition-count growth (§5.4, §19.2; R47-30); read grants on history (§13.3; M13).

#### 12.1 Schema

- Each owner declares its kinds by C01's `OwnerDeclaration`; RFC-006's migration tool
  creates the tables of §3.7 with their zone configurations (§3.2), grants, pre-splits, the
  truncation and restore row-level-security policies (§13.2, §14.3), the stream index of a
  self-outboxed kind (§3.5) and the gap-fill roles of each declared consumer (§3.7). It
  refuses a projection key led by `slot`.
- Owners never write SQL against log or outbox tables directly; they use `append` (§4.3).
  Projections are written only inside `append`'s transaction, from the batch's entries.

#### 12.2 … 12.7 Lifecycle, appending, time, positions, feeds, timers, routing

C01 §2.4 and §3.1 … §3.8 state these. The mechanisms are: lifecycle hooks and
acquisitions §4.2 and §4.4; `append`, its conditions, `decide`, options and results §4.3;
moves and their hooks §4.5; the report position, read leases, status readers and markers
§4.6; time (`timing()`, `now()` for liveness only, never to decide, A8) §6.4 and §6.2;
publication, `subscribe` with the `committed` and `reported` gates, `onResolved`,
`onClosed`, `onMarker` and `onNotification` §5.3 and §5.5; timers (holder-local, re-armed
on `onAcquire` and `onAdopt`, cancelled by `onMovedOut`, a deadline always recorded in an
entry, firing only makes an entry) §4.4 and §4.5; routing, `slotOf`, `reslot`,
`doubleSlotCount`, `probeAccountSet`, `probeSetSummary`, `slotGroup` and `topology()`
§7.1 and §7.3; the integrity stop §7.1 and §14.3. The second lane is set by placement in
`platform_timing`, never by an owner (§4.3, §6.4).

#### 12.8 Encryption

- The runtime calls RFC-005's library (C13) on every payload and application column before
  `append` and every event value before publishing; decryption is in the consumer's
  runtime. Payloads are compressed before encryption. Clear columns carry only
  pseudonymous identifiers and the ordering and fencing columns (§3.7; A11, AI-R5-2).

#### 12.9 Guarantees the platform gives, and what it requires of owners

| Guarantee | Requires of the owner |
|---|---|
| One writer per partition at any moment (§4.2, §4.3, §4.5) | Every effect is an entry; nothing is decided from memory without `leaseValid()` |
| Two-region durability of every acknowledged entry (§9) | Acknowledge nothing before `Committed` (or the report position, for reports) |
| `ts` strictly increasing per partition across owners, never at or below a closed timestamp, within `max_offset` of the database's other clocks | Compare times only through entry fields and `timing()` |
| A reported entry is found by every later reader (§4.6) | Report only at or below the report position |
| Feeds at least once, ordered per partition and stream, nothing lost (outbox, two paths, gap fill) | Consume feed events idempotently by (partition, stream, stream sequence) and notifications by identity (A6) |
| Placement, failover and the 2 + 2 change never create two writers or lose an entry | Handle every `AppendResult` and `RoutingRefusal` exhaustively as C01 §3.2 and CC-1, CC-5 state (`StaleEpoch`, `Moved`, `Moving`, `Stopped`, `Ambiguous`, `STALE_SENDER`), retrying with the same identity |
| A stopped partition commits nothing with `ts` above `enforced_at`, under every holder (§14.3) | Decide nothing for it; answer "temporarily unavailable" (CC-4) |
| 7-year retention of every entry of a `7y` class (§13) | Declare each entry kind's retention class; keep every decoder version (§13.5) |
| Personal data never stored by the platform (A11) | Put only pseudonymous identifiers in clear columns, headers, audit fields and logs |

#### 12.10 Platform parameters (defaults)

| Parameter | Default | Section |
|---|---|---|
| `max_offset` (`ε`) | 100 ms | §3.6, §6 |
| `δ_x_cfg`, `τ_cfg` (cap) | 320 ms, 420 ms (450 ms; beyond it the deadline lane, `τ` ≈ 335 ms) | §6.4 |
| `session_ttl`, `session_renew` | 3 s, 500 ms | §4.2 |
| `standby_poll` (follower-read tail and the present-time session poll), `standby_grace` | 250 ms, 1 s | §4.4 |
| Session, slot and timing shards | 64, every 64 slots, 64 | §3.2 |
| `idle_in_transaction_session_timeout`, `statement_timeout`, `COMMIT` backstop | 1 s, 2 s, 15 s (then `Ambiguous`, resolved before the slot decides again) | §3.6, §4.3 |
| Abandon before `COMMIT` (`abandonBeforeCommitMs`); displacement read lock timeout | 2,000 ms from `BEGIN` (an owner may set lower: RFC-001 250 ms); 10 ms | §4.3 |
| Account, shared link slots | 16,384, 4,096 (est.; set by the spike) | §4.1 |
| Second lane (account; deadline) | off; off below the `τ` cap (lane (c), a second batch of one partition, is excluded from C01 v1) | §4.3, §6.4 |
| `slot_batch_max_entries`, `slot_batch_max_bytes` | 2,000, 4 MB | §4.3 |
| `marker_max_wait` | 20 ms (markers due only on `report_wanted` or outcome entries) | §4.6 |
| `republish_window`, `republish_rate` | 30 s (from the kind's closure position), 5,000 rows/s per process | §4.4 |
| `home_space` | 2²⁰ | §3.7 |
| `split_parallelism` (slot-count doubling) | 16 slots | §7.1 |
| `move_cutover_max` | 1 s (pages) | §4.5 |
| `closed_heartbeat` | 10 s | §5.3 |
| `anycast_damping` | 5 min | §2 |
| Kafka `replica.lag.time.max.ms`, `broker.session.timeout.ms`, `broker.heartbeat.interval.ms` | 4 s, 4 s, 1 s | §5.2 |
| Gateway tiers; per-tier timeout for renewals, epoch reads and session polls | own facility, metro peer, other Kenyan region; 400 ms, circuit breaker after 3 timeouts or on the topology state | §4.7 |
| In-sync-driven `min.insync.replicas` drop | more than 2% of partitions with both replicas of one region out of sync for 2 s | §5.2, §7.3 |
| Kafka leader consolidation on a metro split | admin calls through an R2 broker; in-sync R2 replica first, then the chosen facility's once in sync; controlled shutdown of cut-off brokers after 20 s | §7.3 |
| `batch_retries` | 5 | §4.3 |
| `heartbeat_interval` (owner → readers) | 100 ms | §4.6 |
| `read_lease` | 400 ms | §4.6 |
| `status_shards` | 8 per facility | §4.6 |
| Post-acquisition reporting wait | `read_lease` + ε = 500 ms | §4.6 |
| `max_loop_delay` | 200 ms | §4.7 |
| `kv.closed_timestamp.target_duration` | 1 s | §3.4 |
| `gc.ttlseconds` | 4 h; outbox and self-outboxed logs 25 h; personal-data store 1 h | §3.6 |
| Edge canary commit; probe-site arbiter | every 2 s; node out of load balancing after 3 failures; region withdrawn only if more than half fail **and** a majority of the probe sites it reaches report the other region passing (unicast canary every 2 s); never with no arbiter reachable; re-announce after 10 s passing | §2 |
| `region_detect`, `reconfig_delay` | 3 s, 10 min | §7.3, §8.1 |
| `probe_trigger`, `failover_damping` | 3 rounds (30 s), 30 min | §7.4 |
| `drift_correct` | 10 s | §7.2 |
| `gap_timeout` | 5 s | §5.5 |
| Kafka `min.insync.replicas` | 3 (2 while "Kafka degraded": a facility lost or drained, a region lost, the Kenyan link cut) | §5.2 |
| Probes per account slot | 3 a minute per capability and region, 20 s apart, one per location (6 from two locations while one is down) | §17.1 |
| `PROBING_FAULT` escalation | one episode per (region, minute), `warning`; `page` when one slot is short for 5 consecutive minutes or more than 1% of slots are short in the minute; runner skip rate page above 10⁻⁴ per location | §16, §17.3 |
| `seal_interval` | 60 s or 64 MB | §13.2 |
| `tail_buffer` | 24 h | §13.2 |
| `disaster_probe_minutes` (POL-06, a policy parameter, listed for reference) | 5 consecutive minutes | §8.2 |
| `disaster_healthy_alert` | 30 min | §8.3 |
| `pd_backup_retention`, `kek_generation_period`, `pd_gc_ttl` (RFC-005's parameters; RFC-006 enforces them on storage) | 7 days, 7 days, 1 h | §14.4 |
| Webhook batch size; first-attempt lane per endpoint (fixed); first-attempt connect timeout; retry concurrency (AIMD) | 100 events; 16; 2 s; 1 to 16 | §15 |
| Checkpoint retention | the last 3 per partition, at least 48 h | §12.11 |

#### 12.11 Checkpoint store (R6-25; consumed by RFC-001 §7.6)

- `putCheckpoint(kind, partition, seq, bytes) → { reference, digest }`: a standby writes a
  state checkpoint (RFC-001: 1 to 2 GB for a hot link, every 10 min or 1 M entries); the
  runtime compresses and seals it with the partition's payload key (RFC-005 C13) and
  writes it to the Kenyan Ceph cluster of **its own region only** (object storage, not the
  archive; R27-13), returning once it has it; the owner records the reference and digest in
  its `Checkpoint` entry. The in-region standby checkpoints into the preferred region's
  Ceph, the cross-region standby **takes its own** checkpoints of the same state into its
  region's Ceph, so no checkpoint crosses Nairobi–Mombasa (it would be about 0.2 to 0.4 GB/s
  before compression at the design load, est.), and each region always has recent
  checkpoints of every hot partition.
- `getCheckpoint(reference) → bytes`: read from the reading process's own region (a cold
  rebuild after a region-wide failover reads R2's own checkpoints, found by the latest
  `Checkpoint` entry whose reference names R2), digest verified; a missing or mismatched
  copy falls back to the other region's latest checkpoint, then to replay from history.
  The pre-warm of a move (§4.5) uses the same call.
- Retention: the last 3 checkpoints of each partition and at least 48 h, then deleted by
  the history service; checkpoints hold no personal data (A11) and are never a record (the
  log is). Volume: about 130 hot links × 2 GB × 3 ≈ 0.8 TB per region (est.), written only
  inside the region.

### 13. History and archive: retention for 7 years

#### 13.1 What is kept, and for how long

RFC-000 makes every owner's log the bitemporal record of its state (A4); history archives
and indexes it, and is never a writer (RFC-000 §2). Transaction time is the entry's `ts`
("known at"); valid time is whatever the owner's payload states.

| Record (X2-N6, POL-19, X1-N8, P3-N7) | Where it lives | Retention |
|---|---|---|
| Ledger movements (P4-N7, P4-N15) | Ledger log | 7 years (class `7y`) |
| Payment events and reference bindings (P4-N1) | Payments log; bindings also as a live index (§19.4) | 7 years |
| Reservation history: every change, who and when (POL-19); link schedule changes and capacity history (P1-N9) | Account and link logs | 7 years |
| Raw flow records, accepted or not, with reasons (P3-N7, P3-N11) | Ingestion log | 7 years |
| Audit records (X1-N8), by pseudonymous principal (A11) | The audit fields of the owners' entries; the approvals log | 7 years |
| Inputs a charge is reproduced from (P3-N9) | Catalogue, attribution, account logs | 7 years |
| Source-reference and record-identity indexes (POL-29) | Ledger, payments, ingestion projections | 7 years |
| Transient coordination entries (capacity holds, tombstones, waiter registrations) | Link and account logs | Class `ops`: 400 days, **unless** the owning RFC declares the kind `7y`; the default for any undeclared kind is `7y` |
| Personal data | **Never in the archive** (A11): only in RFC-005's personal-data store, backed up per §14.4 | Until erased |

The legal end of retention is not yet confirmed per market (POL-24). Storage is
**write-once** under object locks in compliance mode, by **separate buckets per tier and
retention class** (R6-13): class `7y` segments in the cloud buckets under a lock of **7 years
+ 90 days**, class `ops` segments in cloud buckets under **400 days**, and the Kenyan hot
copy under **13 months**, each lock counted from the **object's creation** (which is after
the segment's newest entry, so the retention is at least as long as stated). Deletion after
a lock is a lifecycle job, enabled for `7y` only once legal confirms the period, per market.
Nothing inside its retention can be deleted by anyone, operators included (X1-S15).
Erasure of personal data never touches the archive, because no personal data is in it
(X1-S34, X1-S37).

#### 13.2 Sealing, tiers and truncation

- **Sealing.** The **sealer** (a NestJS service in Kenya, one worker per slot range, with the
  history service's own session and slot leases) seals each slot every `seal_interval`
  (60 s, or 64 MB): it scans the slot's new log rows **by follower read at a timestamp `T`
  at or below `closedTimestamp()`**, so the set of rows with `ts` ≤ `T` is complete and
  final; it decrypts the payloads (it holds the history key grant), reorganises the rows by
  partition and `seq` into a Parquet file with zstd compression, and applies **Parquet
  modular encryption** with segment keys wrapped by the Kenyan HSMs. Compression is
  therefore columnar, as RFC-000 §6 sized it (the ledger's delta-encoded lines, A0R-11),
  and every archive copy, GCS included, is ciphertext.
- **Hash chain.** Each segment's hash and the previous segment's hash of the same slot and
  kind are recorded in an insert-only `sealed` table (§13.4); each segment also lists, per
  partition, its first and last `seq` and the partition's chain values, so audit can verify
  and watermark per partition (RFC-005 §9.3). Audit's checkpoints go to its own two
  write-once stores (RFC-005: a Kenyan bucket and a bucket in a separate Google Cloud
  organisation), which RFC-006 hosts as buckets but does not administer for the second.
- **Tiers** (R6-13, decision D5).

  | Tier | Age | Copies | Stores |
  |---|---|---|---|
  | Live tail | Minutes (up to `tail_buffer`, 24 h) | 5 voters (+ non-voters) | The database |
  | **Cold (the record)** | From sealing to 7 years + 90 days (`7y`) or 400 days (`ops`) | **2, with two providers in two South African regions**: GCS `africa-south1` (Johannesburg; Archive class after 30 days) and Amazon S3 `af-south-1` (Cape Town; Glacier Instant Retrieval after 30 days), each under S3/GCS object lock in compliance mode | GCS; S3 |
  | **Kenyan hot copy** | Up to 13 months | 1 | Ceph RGW on R2's cluster in one R2 facility, erasure-coded 4 + 2 with **host** as the CRUSH failure domain over at least 12 hosts, at most 2 chunks per rack over the facility's three racks (R27-23): a host loss leaves one chunk of redundancy, a rack loss leaves the copy readable without redundancy until re-filled from GCS. Under a 13-month object lock |

  The two cloud copies are the record: two operators, two regions, ciphertext only (A11,
  RFC-000 AI5-3), nothing in them needs Kenyan residency (no personal data; POL-24 legal
  confirmation pending, and if legal requires a Kenyan cold copy, the hot copy's lock and
  capacity are extended to 7 years, RK30). The hot copy exists for **fast replay** and
  history queries from Kenya; nothing depends on it for durability, so it is not built to
  survive a facility loss: if `r2a`'s Ceph is lost, replay and queries read GCS (slower,
  about 50 MB/s per stream instead of hundreds, est.) and the hot copy is re-filled from
  GCS. This replaces revision 3's Ceph erasure coding across a metro's two facilities, which
  lost the copy with either facility (R6-13), and removes most of the multi-petabyte
  on-premises operation (R6-14).
- **Two-region durable** means **both cloud copies** have acknowledged the segment and its
  checksum has been verified on read-back (or, while one cloud store is unavailable, one
  cloud copy and the Kenyan hot copy: still two regions and two operators). Truncation waits
  for it. **While the hot copy stands in for a cloud copy**, the sealer back-fills the
  missing cloud copy as soon as that store accepts writes, and the hot copy's lifecycle
  deletion (after its 13-month lock) is **blocked for every segment not yet verified in
  both cloud copies** (R27-23); the archive-integrity check (§14.1) lists any such segment
  and pages.
- **Truncation** (RFC-000 §5.5, AI5-8; RFC-005 §9.3). The **truncator** role, the only role
  with DELETE on log tables, granted to the truncation job alone, deletes a partition's rows
  only once the segment covering them is two-region durable **and** at or below the
  **sealed-through watermark** that audit writes per partition after verifying the segment
  against the live rows and its chain. The database enforces the second condition itself: a
  **row-level-security policy** on every log table, `FOR DELETE TO truncator USING (seq <=
  (SELECT watermark FROM audit_watermark w WHERE w.kind = <kind> AND w.partition =
  <kind>_log.partition))`, with row-level security **enabled and forced** (it holds for the
  table owner too), so a delete above the watermark is refused whoever runs it. **Every
  policy names its role; none is `TO PUBLIC`** (C08 R46-02, R46-18, V56-1), and the
  restore role's restrictive `restore_confined` policies (§14.3) also apply, so the restore
  role cannot delete a row at or below the watermark in a partition that is not stopped,
  even with the truncation policy present (C08 C-10). If the release lacks row-level
  security, the spike's fallback is a stored procedure owned by audit's role as the only
  delete path (RFC-005 RK-18). The job also never deletes rows newer than the oldest resolved timestamp
  of any registered consumer that is less than `tail_buffer` behind, nor, on a
  self-outboxed log, within 1 h of its changefeed's oldest consumer position (§3.5). Its
  deletes are range deletes in `seq` order; their MVCC garbage is collected after
  `gc.ttlseconds`. With the archive healthy the live tail is minutes of log plus audit's
  verification lag (est.); the database is sized to buffer 24 h (§19.4), and archive lag
  alarms at 10 min (warning) and 1 h (page). Audit checks after each run that no row above a
  watermark disappeared (RFC-005).

#### 13.3 Indexes and queries

- **Per-slot index**: `seq` range and `ts` range → segment, kept in the history service's
  catalogue (a read model, rebuilt from the segments if lost).
- **Entity indexes**, declared by the owning RFC: reservation → partitions and `seq`
  (RFC-002); link → schedule entries by valid minute range (RFC-001); source reference →
  movement (RFC-004); record identity (exporter, observation domain, the exporter's counter
  epoch, position in the export stream; P3-N3 as amended in `requirements-v1.11`, C11) and
  (reservation, link, minute) → records (RFC-003, P3-S39).
- **Bitemporal projections** for the query kinds the owner RFCs define (the link schedule as
  known at T, P1-S33; a reservation's history; the inputs to an account's headroom at a
  position, P4-S72), with valid-time and transaction-time intervals per entity, updated
  from Kafka and backfilled from segments.
- **Queries** (C01 §2.8, §3.9): `asKnownAt(entity, T, query, params, grant)`,
  `history(entity, from, to, grant)`, `entries(kind, partition, seq or ts range, grant)` by
  partition **across every slot the partition has lived in** (through the log's partition
  index and the segments' per-partition ranges), served from the live tail and the archive
  seamlessly, and `replayFrom(kind, partition, stream, fromStreamSeq)` for consumers
  (§5.5). Result semantics are the owner RFC's declared query; RFC-006 guarantees
  completeness (every committed entry of a `7y` class is returned for its range, `ops` for
  400 days) and immutability. `T` above the closed timestamp answers `NOT_CLOSED`. Errors:
  `NOT_CLOSED`, `NOT_FOUND`, `GRANT_REFUSED`, `UNAVAILABLE`; a 30 s statement timeout.
- **Operator reads need a read grant** (C01 settled M13; RFC-005 C4): history is a
  read-grant reader. It checks the grant with `operator_check`, and **appends its audit
  record before it answers**; with no grant, an expired grant or a read outside the grant's
  target it answers `GRANT_REFUSED` and records the refusal (C08 C-08). Workload callers
  (owners, rating's cold re-rate, reconciliation) read under their workload identity.
- **Replay** (P3-S36, P4-S72): history runs the owner's own state machine over projections
  checkpointed in segments plus entries. Owners keep every version of their decoders and
  apply logic loadable for the retention period, selected by the `schema_v` and logic
  version recorded in the entries; a replay never uses a newer rule for an older entry.

#### 13.4 Immutability

Besides the retention lock, the hash chain of every slot is published daily into the
approvals log and signed with RFC-005's keys. Altering or removing a sealed segment is
therefore both prevented (write-once) and detectable (chain mismatch found by the daily
integrity check, §14.1). In the live database, log tables are insert-only by grants
(§3.7), and the truncator deletes only below a verified seal. This is the storage half of
X1-S15 and P3-S31; RFC-005 and RFC-003 own the rest.

#### 13.5 Format durability over 7 years

Rules: (1) segment formats and payload schemas are versioned (the schema registry, §5.4) and
every reader keeps decoding every version ever written; (2) a **format corpus** with one
sample segment and projection checkpoint of every format and schema version is kept and
decoded by every build in CI; (3) archive and payload keys are kept for the retention
period by RFC-005's key management. Crypto-shredding applies only to the personal-data
store's subject keys, never to archive keys (A11).

### 14. Backups and restore

The **archive** is the 7-year, write-once record of every log. **Backups** cover what the
archive does not: the database's current state (heads, projections, indexes, sessions,
placement, the unsealed tail of the logs), so that a logical fault or an operator error can
be undone to a point in time without replaying 7 years.

#### 14.1 CockroachDB backups and continuous checks

- **Two schedules**, one to each destination, so each holds a complete chain:

  ```sql
  CREATE SCHEDULE backup_gcs FOR BACKUP DATABASE share
    INTO 'gs://share-backup-af-south1/cluster?AUTH=implicit'
    WITH revision_history, kms = 'gs:///projects/share/locations/africa-south1/keyRings/backup/cryptoKeys/db-backup?AUTH=implicit'
    RECURRING '@hourly' FULL BACKUP '@weekly'
    WITH SCHEDULE OPTIONS first_run = 'now', on_previous_running = 'wait';
  -- and backup_ceph to 's3://share-backup?AWS_ENDPOINT=https://rgw.r2.share.internal'
  -- (Ceph RGW in R2; R1's for a database whose leases are in R2)
  ```

- **Scope.** Every table except the high-volume ingestion, attribution and rating log and
  outbox tables, whose rows the archive holds write-once within `seal_interval` plus the
  archive lag, and except the **personal-data store's tables**, which have their own
  schedule (§14.4); the account, link, partner, ledger, payments and every other log are
  included. This keeps the incrementals to about 60 MB/s per destination (est., §19.3).
- **Encryption** (R6-24). CockroachDB's backup `kms` option accepts cloud KMS URIs, not an
  on-premises HSM. The backup key is therefore a **GCP Cloud KMS key under Cloud External Key
  Manager**, whose key material stays in the Kenyan HSMs (Google holds only a reference and
  calls the HSMs' EKM endpoint for each wrap and unwrap), with implicit node credentials, so
  no secret sits in the schedule (AI-R5-2). The spike confirms EKM's availability in
  `africa-south1` and its latency. **There is no passphrase fallback** (RFC-005 revision 5):
  `encryption_passphrase` would put a secret in the job record, so it is never used. If
  EKM is unreachable, **backups wait**: the run fails and is retried, the schedule check
  pages after two missed incrementals (below), and the facts stay safe in the database and
  the write-once archive meanwhile; only point-in-time coverage of current state ages. If
  the spike finds EKM unusable in `africa-south1`, that is raised against RFC-005 and
  RFC-000 before production, not worked around. Payload columns are already ciphertext (§3.7), so a GCS
  backup is ciphertext twice over.
- **Retention.** 35 days (five weekly chains), write-once under a 35-day bucket or object
  lock. Point-in-time restore to any moment in the last 35 days (revision history).
- **Checks.**

  | Check | Frequency | Pass condition |
  |---|---|---|
  | Backup schedules | Continuous | No more than one missed incremental; page on two |
  | Archive integrity | Daily, a random 0.1% of segments in every store, every segment within a month | Checksums match `sealed`; hash chains intact |
  | Projection digests | Hourly per slot | The holder's digest of its projections at a `seq` equals the digest the standby computes from the log at the same `seq`; a mismatch pages |
  | Archive lag | Continuous | Below 10 min |

#### 14.2 Restore tests

| Test | Frequency | What it proves |
|---|---|---|
| **Table restore**: a rotating sample of tables restored from the latest backup into an isolated restore cluster (`RESTORE TABLE … WITH into_db`), projections compared with a replay of the archive at the same timestamp | Weekly, automated | Backups are complete and consistent with the logs |
| **Point-in-time restore** of one owner kind to a chosen timestamp, timed | Monthly | RB-10 works within hours |
| **Full cluster restore** from GCS alone into a restore cluster in R3, timed | Quarterly | The answer to a correlated loss of both Kenyan regions (outside X2-N4) or a fault in every replica |
| **Retention-edge retrieval**: records of each X2-S11 kind retrieved from the cold tier at the oldest age available, plus back-dated synthetic segments of every format version aged 7 years less one day | Quarterly | X2-S11: returned unchanged |
| **2 + 2 drill**: the zone change of §8.1 on the pre-production cell with one region isolated | Monthly | §8.1 timings and safety |
| **Canary digest** on every release: the canary facility's processes compute projection digests before the next facility upgrades | Every release | A faulty apply is caught on one facility (RB-13) |

#### 14.3 Logical corruption

A faulty apply (a bug in an owner's logic) is not undone by restoring older data alone,
because facts are append-only (A4): the remedy is to fix the code, **rebuild** the affected
projections by replaying the log (from the archive and the live tail) or by restoring them
to a point before the faulty release and replaying forward, then let the owner append
corrective entries where its own rules say so (corrections are new facts). Releases roll
out one facility at a time with canary digests (RB-13).

**A record found altered or missing by audit** (RFC-005 §9.3; C08 §J, §K; C01 §2.6,
§3.2; RB-18). The order of events is:

1. **Detection.** Audit's verification finds a live log row of a partition altered, or a row
   missing above the sealed-through watermark. Or the runtime finds a head-chain mismatch
   (§3.7): it then holds the partition locally and sends `integrity_report(kind,
   partition, seq, observed_chain, expected_chain, reporter)` to audit, retried until
   accepted (5 s per call, est.). **The runtime never stops a partition by its own
   authority** (C08 R46-12).
2. **Stop.** Audit records the `integrity_violation` with a new `detection_ref`, opens its
   own detection row, and sends `Stop(kind, partition, detection_ref)` to placement.
   Placement's `Stop` transaction writes the stop row in `placement_integrity_stops` and
   increments `stops_version` on the holding slot (both slots during a move or for a
   `headDecides` account), and only after it commits returns `StopAck` with
   `enforced_at` (§7.1; review 47 D2). From then **no entry of the partition commits with
   `ts` > `enforced_at`**: a batch in flight either commits below `enforced_at` (a read at
   `enforced_at` sees it) or restarts, sees the new `stops_version`, re-reads the stops and
   answers the stopped partition's calls `Stopped`. Holders read the table on acquisition
   without placement, and B re-reads the stops in its `adopt` batch, so the stop holds
   across takeovers and moves. Owners answer "temporarily unavailable"; nothing is decided.
3. **First-seen head.** Audit records the partition's head **as of `enforced_at`** as its
   first-seen head for the resume check (C01 V59-5; C08 §K).
4. **Restore.** RFC-006 restores the rows at or below the watermark from the sealed
   segments (verified against audit's checkpoints), and the rows above it from the
   database backups' revision history at the last timestamp audit verified. Each row is
   written back by the **restore role**, usable only through break-glass with two
   approvers and `break_glass_ttl` (4 h; RFC-005 §10), holding no application key, the only
   role that may rewrite a log row. It is confined by **forced** row-level security on
   `<kind>_log` **and** `<kind>_head`, a permissive `restore_only_stopped` policy and a
   restrictive `restore_confined` policy with the same predicate, to partitions with a row
   in state `stopped` in **placement's `placement_integrity_stops`** (C01 R47-28; C08 §K,
   CC-2, V56-1). Audit's own `integrity_stops` table is the detection record only, not a
   row-level-security predicate. The projections are rebuilt by replay.
5. **Resume.** Audit re-verifies, closes its detection row, and sends `Resume(kind,
   partition, detection_ref, checkpoint, incident_decision_ref?)`. Placement refuses it with
   `HEAD_MISMATCH` if the restored head is not audit's first-seen head and no incident
   decision is given, and `NOT_STOPPED` without an open stop. A resume is the same
   transaction shape as a stop (it increments `stops_version`); only it lifts the stop and
   the runtime's local hold. After `Resume`, a restore-role write to the partition is
   refused again (C08 C-10).

Rows committed after the last verified point and not recoverable are an incident reported
to compliance, not silently re-created.

#### 14.4 The personal-data store: backups and key destruction (A11, X1-N11, POL-19)

RFC-005 owns the personal-data store, its key hierarchy (`KEK_PD` generations, a new one
every `kek_generation_period` = 7 days, each destroyed by a scheduled HSM quorum operation
on every member of every Kenyan HSM cluster at its usage end date, with signed
attestations), the per-day **expiry keys** of non-conforming payloads, and the erasure
itself; RFC-006 runs its storage. Its tables are in the same database with their own zone
configuration (5 voters, no non-voters, §3.2), `gc.ttlseconds` = `pd_gc_ttl` (1 h) and **no
changefeed**, holding subject keys wrapped under the current `KEK_PD` generation, items
encrypted under the subject keys, and the payloads of flow records refused for not
conforming to their template (P3-S71, RFC-003, RFC-000 AI3-12, AI3-13). A payload's
**bucket key** (one per exporter and receipt hour), not each item key, is wrapped under its
receipt day's expiry key (C09 `put_payload`, R48-20; RFC-005 §3.7). At the design load the payloads
are sized at 0.01% of records refused (est.), about 26 payloads/s of 100 KB on average,
about 225 GB a day and about 8 TB per copy over `dispute_window` (30 days) + 7 days, to be
replaced by the measured refusal rate (§19.4, RK27). **Keeping a payload is not required**
(POL-19 and P3-N7, P3-S71, P3-S75): `put_payload` answers `not kept(cap)` beyond
RFC-005's **full set of caps** (C09 S-M3): 10 payloads/s and 256 KiB/s per exporter,
1,000/s and 4 MiB/s overall, 64 KiB a payload, and the sixth cap **`storage`** at 90% of
the **40 TB per-copy allotment** that RFC-006 gives the store (36 × 10¹² B of live payload
bytes per copy, on `put_payload` only, never on `put`; C09 S-M1); or `not kept(late)` if
the store does not take it by its `keep_by`; or `not kept(erased)`. Ingestion then keeps
only the identity, keyed digest and reason. Each drop is counted and reported to network
operations through `ingest_log`'s drop alert and hourly drop report (§3.5, §16); that
count is the authoritative one, and the store's own counts go to monitoring only (C09).
The allotment is five times the estimate. The store's **state-based row sweep**, each day
and after each restore, deletes rows whose expiry has passed, so the allotment is a
backstop, not the bound (C09 R36-07, R48-14): a misconfigured exporter can neither fill the
facilities' NVMe nor stall ingestion (at the 1,000/s overall cap, 37 days would be about
320 TB per copy, which the `storage` cap forbids).

**The bounds** (POL-19 as of `requirements-v1.11`): an erasure is complete in every copy,
the live store, every backup and every escrowed copy, within **`erasure_max` = 30 days of
the request** (X1-N11, X1-S39); a non-conforming payload is unrecoverable in every copy,
backups and escrow included, by **`dispute_window` + 7 days** after receipt, or earlier when
an erasure covering it is executed (P3-N7, P3-S71). `requirements-v1.11` adds three
rules, all RFC-005's: a record that holds the data of more than one person is erased
whole; a supplier's payout-destination details are erased only once every payout to them
is confirmed or has failed finally and is reconciled, with `erasure_max` running from then;
a request covers the payloads received before it is executed. None changes a copy RFC-006
keeps: each copy below becomes unrecoverable by key destruction after the erasure's
execution, whenever that starts. The copies RFC-006 keeps, and how each meets them (R6-23
corrected):

| Copy | Kept by | Becomes unrecoverable | Bound |
|---|---|---|---|
| Live store (four Kenyan voters and R3's voter) | RFC-006 storage; RFC-005 erases and expires | At the erasure's commit (subject key row deleted) or the expiry key's destruction; MVCC history after `pd_gc_ttl` (1 h); Raft logs and uncompacted files when the generation or expiry key is destroyed (RFC-005) | RFC-005's arithmetic: every copy within 24 days of the request |
| The store's own backups (**this schedule only**) | RFC-006 | Unreadable when the `KEK_PD` generations they contain are destroyed, or for a payload when its day's expiry key is destroyed; deleted at `pd_backup_retention` (7 days) of age, and within 24 h of any contained generation's destruction as a backstop | ≤ 7 days of age; RFC-005's 24-day bound holds by key destruction alone |
| HSM-held keys (`KEK_PD` generations, expiry keys) | RFC-005 | Destroyed weekly (generations) and daily (expiry keys) by quorum, attested | RFC-005 |
| Escrowed copies | — | **None exist** (RFC-005 D-2): no key is escrowed and no expiry key or `KEK_PD` is ever in any backup | — |
| Database backups of other tables (§14.1) | RFC-006 | Hold no personal data (A11; DT-25 checks), so nothing to erase | — |
| Archive, Kafka, checkpoints, logs | RFC-006 | Hold no personal data (A11) | — |

- **Schedule.** `CREATE SCHEDULE backup_pds FOR BACKUP TABLE pds.*` to Ceph RGW in R1 and R2
  only (never a cloud store), daily full plus hourly incrementals, **without revision
  history**, encrypted with the backup key (§14.1). Each backup object is tagged with
  **every `KEK_PD` generation it contains** (read from RFC-005's generation table at the
  backup's AS OF SYSTEM TIME; during a rewrap, two) and written under an object lock of at
  most `pd_backup_retention` (7 days), so deletion is never blocked by the lock. The **expiry
  keys and `KEK_PD` are never in a backup**: they live only in the HSMs; the store's tables
  hold only wrapped keys and ciphertext (RFC-005 AI3-13).
- **Deletion.** The backup pruner (a NestJS job on the history service's slots) deletes each
  backup object at 7 days of age and, as a backstop, consumes identity's **store events
  feed** and deletes within **24 h** every backup object tagged with a generation named by
  a `generation_destroyed` event, then records the deletion (C09 test 27). A daily
  **erasure-conformance check** lists every backup object of the store and pages compliance
  and platform on-call if any is tagged with a destroyed generation, is older than
  `pd_backup_retention` + 24 h, or sits outside the two named buckets.
- **The store events feed** (C09 "Store events"; R48-12, S-M2). Identity writes every store
  event to **one** outbox partition, `"pds"`, with a dense sequence, so the feed has a
  total order and `store_outbox_head()` is one `EventId`. Events: `payload_withdrawn`,
  **`expiry_destroyed(day, attestations)`** (committed with the expiry key's attestation
  entry), `generation_destroyed(g, attestations)` and `erasure_executed(request_ref, part,
  of, …)` (one part per batch of an erasure). Identifiers only. Only identity's relay
  writes the topic; only RFC-006's pruner and restore tooling and the store's own `reapply`
  read it (ACL by workload identity). Retention at least 14 days, delete policy,
  `max.message.bytes` 1,048,576 (§5.2). Consumers apply each event once by `event_id`.
- **Restores of the store** (RB-10; C09 "Restore", R36-06, R36-24, R48-03, R48-04, R48-13,
  V60-2, V60-3, V60-6). The restore tooling follows these steps; a restore never
  resurrects an erased subject, a withdrawn payload or an expired payload:
  1. Choose a backup. Do not use a backup whose oldest contained generation reaches its
     usage end during the expected time of the restore (a backup whose generation is
     destroyed cannot be read at all).
  2. **Set the fence before the restore starts.** The fence is a control row in identity's
     own tables, **outside `pds`**; store instances read it, and while it is set they serve
     only `reapply` and the rewrap and answer every other operation
     `temporarily_unavailable` (V60-3). Then restore the backup.
  3. **Rewrap every key at once** under the current `KEK_PD` generation (R36-24).
  4. Call identity's `store_outbox_head()` **after** the fence is set, and wait until the
     relay has published through that head.
  5. Call `reapply(restore_id, from_as_of, through)` with `from_as_of` the backup's AS OF
     time and `through` that head. **The store reads the feed itself** (the tooling cannot
     give events; D-48-4), from the first event with `committed_at` ≥ `from_as_of` −
     `max_offset`, in feed order, idempotently by `event_id`, and writes the state each act
     wrote: each `erasure_executed` part as it reads it, with the "envelope checked" record
     and its progress (V60-2); the withdrawal tombstones; day `d`'s rows for
     `expiry_destroyed` (never by date computation, S-M2). `reapply` on a store without the
     fence is `refused(not_restoring)`. An erasure committed but not yet relayed when the
     restore starts is still re-applied, because step 4 reads the head after the fence.
  6. Run the row sweep. **Give the restore's AS OF time to identity** before the fence is
     removed (C09 V60-6, R48-04), so identity re-bases mutable items (each payout-destination
     version in force at or committed after it; for each `not_found`, every supplier
     administrator is asked to enter the destination again). Then remove the fence.
  Items put after the backup and not put again are lost and answer `not_found`; identity
  alerts and asks for re-entry.
- **What RFC-006 contributes to RFC-005's arithmetic**: backups at most 7 days old, without
  revision history, never holding a key; the 1 h garbage collection; no changefeed. RFC-005
  states the bound (24 days of the request, inside `erasure_max`).

### 15. Notifier

RFC-000 §2: "deliver every outbound notice: signed buyer webhooks retried for
`webhook_retry`, affected-reservation notices within `affected_notice_time`, suspension and
low-balance notices, supplier notices, operational alerts". The notifier is a consumer of
C03 (link schedule feed), C04 (request outcome and reservation lifecycle feeds), C05
(standing feed), C08 (endpoint feed and signed webhook), C09 (`get` of contact details) and
C12 (partner reconciliation feed); this section states how it meets each.

**Structure.** The notifier is an owner on 1,024 slots partitioned by **tenant** (an
account or a supplier). For each input event it appends a **notice** entry (destination
endpoint, content reference, idempotency identity) and records it in the tenant's **notice
list**. The identity is (source partition, stream, `stream_seq`, destination); for a
link-schedule notice it is (`link_id`, `log_seq`, reservation), as C03 states. **Delivery
workers** (stateless, in both Kenyan regions) take notices per endpoint, form
**deliveries**, make the attempt and send the result back to the notifier, which appends a
**delivery** entry (the notices it carried, the `webhook-id`, the attempt's start time and
result). Deliveries therefore survive failover and are never lost or duplicated by a
restart, only retried, and the receiver deduplicates.

| Input feed (gate) | Notice | Destination |
|---|---|---|
| Request outcome feed, C04 (`reported` gate, and **every** marker through `onMarker`) | Outcome of a booking request **answered `pending`, a change included** (P2-S09 as amended in `requirements-v1.11`): a webhook **if and only if** the outcome event carries `answered_pending`, **or** the request is in `pendingAnswered` of the outcome's **first covering marker** (C04 MM-10, B-01). The notifier keeps every marker by (slot, epoch, `reportPosition`, `chunk.part`); the monotone drop applies only to the gate (N-01). A first covering marker still missing after `gap_timeout` is read from the outbox or from history; if it still cannot be read, the webhook **is sent** (D58-1): an extra webhook is possible, a missing one is not | The account's registered webhook endpoint (X1-S24) |
| Reservation lifecycle feed, C04 (`committed`) | Holder notices from `cut` (with `rate_cut`), `ended`, `partner_leg_affected`, `offer_made`, `offer_accepted`, `offer_declined`, `offer_lapsed`, `offer_failed` and `offer_cut_kept` (P1-S50, P1-S72; POL-07). The release notice comes **only** from `ended(released)` (P4-S23; C04 MM-9; C05's `ReleasedAfterGrace` is not delivered). **No notice and no webhook** for any event that carries `withheld_by`: every notice a withheld termination's entry causes is suppressed (C04 MM-8, POL-30); status reads stay truthful | The holder's webhook and notice list |
| Link schedule feed, C03 | **`AFFECTED_NOTICE` is the only trigger** of affected and restoration notices (C03 D39-3, R39-05): one per reservation per due notice, self-contained; the notifier tells the **holder and network operations** (P1-S26, P1-S40, P1-S75). `AFFECTED_CHANGED` alone sends **no** notice (history and alerting only). `CAPACITY_CHANGED` with `maintenance_cut` tells the **supplier** of the maintenance booking (POL-07, P1-N8; C03 CT-6.1). `REDUCTION_SET_EXTENDED` and `ALERT` events go to alerting (§16) | Holders' endpoints and notice lists; network operations' integration; the supplier's endpoint |
| Standing feed, C05 (RFC-004) | Suspension, low balance, resume amount with the headroom after it (POL-16 as amended in `requirements-v1.11`) | The account's webhook and notice list |
| Partner reconciliation feed, C12 | `PARTNER_SHORT`, `PARTNER_EXCESS`, `DEFERRED` and `RUN_COMPLETED` events, keyed by (partner link, ref) across days (C12 V6 b, e) | Network operations and finance (the console shows them; a missing `RUN_COMPLETED` is an alert, §16) |
| Identity and access (RFC-005): a documented erasure request refused as unverifiable (POL-19) | The refusal, to the requester who is not a Share user | **E-mail** to the address in the request, read from the personal-data store at send time by `get` with its purpose (C09), never logged (A11) |
| Operational alert feed (§16) | Pages and messages to people | Paging provider, chat, e-mail, by routing rule |

**Endpoints** (C08 §L, §M). The notifier learns endpoints from identity's endpoint feed
`iam.endpoints.v1` (sealed, C13), and may query one endpoint by identifier. An endpoint
belongs to one tenant, an account or (since `requirements-v1.11`, X1-N6) a **supplier**.
The notifier picks an endpoint **only** from the event's tenant, derived from the event's
**clear partition** (the account; for a link-partitioned topic, the link's supplier in the
catalogue at the event's position), never from the payload. It does **not** call
`visibility` (C08 R46-22): it shows no identity to anyone.

**Delivery semantics.**

- **Batched deliveries** (decision D4; POL-04; R6-15). One signed POST carries **up to 100
  notices** for one endpoint, as a JSON array, each with its own event ID; receivers
  deduplicate per event. **A delivery never mixes tenants**: the worker forms a delivery
  only from notices of the endpoint's tenant, which the notifier's partitioning by tenant
  already guarantees, and checks it again (X1-S24).
- **Told** (POL-04, P1-S75; glossary *Told*): a principal has been told once the notice is
  in its tenant's notice list **and** its first delivery attempted, within the notice's
  time; a notice carried in a delivery has its first delivery attempted **when that
  delivery is first attempted**. Delivery is then retried for `webhook_retry`. The notifier
  records both times per notice, and the measurement of `affected_notice_time` uses them
  (§18.2).
- **Two lanes per endpoint** (decision D4, R27-08). **First attempts** have their own lane
  with a **fixed** concurrency of **16** deliveries in flight, never reduced by errors,
  timeouts or the circuit breaker, a **connect timeout of 2 s** and a response timeout of
  5 s. **Retries** have a separate lane whose concurrency is adaptive (AIMD: starts at 4,
  +1 a second while deliveries succeed within 1 s, up to 16, halved on errors or timeouts)
  and which the circuit breaker governs. So a dead or slow endpoint never makes a notice
  late: a burst of 10,000 affected notices to one AI-agent buyer is 100 deliveries; to an
  endpoint that refuses or never accepts connections, 100 ÷ 16 × 2 s ≈ **13 s**; to one that
  accepts and never answers (5 s timeout), 100 ÷ 16 × 5 s ≈ **32 s**; at 100 ms per POST,
  about 1 s (DT-23b). The extra load on a failing endpoint is bounded by 16 connections per
  endpoint, only while first attempts are due.
- **`webhook-id`** (C08 S-M4). A `webhook-id` names one **fixed** set of notices and is
  reused for every attempt of that set; for a delivery of one notice it equals that
  notice's `event_id`. Notices regrouped on retry form a **new** delivery with a **new**
  `webhook-id`. Receivers deduplicate by `webhook-id` and by each notice's `event_id`
  (delivery is at least once). A request's outcome is final once reported, so its outcome
  webhook never contradicts another.
- **Signed by the delivery worker** (C08 S-M3, R46-19; X1-S11). The **delivery worker**, the
  workload that sets each attempt's timestamp, holds the endpoint secrets **in memory
  only**, unwrapped with the key service under its own key-release entry, and computes the
  HMAC itself in RFC-005's format, **per attempt** with a fresh `webhook-timestamp`, over the
  delivery's event IDs and body; there is no remote signing service. After an overlap
  rotation the previous secret signs until the new secret's `active_from` + 24 h; after a
  rotate-now, until the new secret's `active_from`. The same signing applies to a
  supplier's webhooks (X1-S11 and X1-S24 as amended in `requirements-v1.11`).
- **Transport checks** (C08 §M, R46-23). The worker resolves the host itself, accepts only
  global unicast addresses (RFC-005 §8.3's exclusion list, so a DNS rebinding to a private
  address is refused at delivery), connects to the checked address **with SNI set to the
  URL's host and the TLS certificate verified against that host**, follows no redirects,
  and sends from the dedicated egress.
- **Retries**: on failure or no 2xx within 5 s, exponential backoff from 1 s doubling to a cap
  of 1 h, with jitter, for `webhook_retry` (24 h), the undelivered notices regrouped into
  deliveries of up to 100; then recorded as given up, visible to the tenant and support. The
  outcome is still available by poll (POL-04).
- **Isolation**: one queue, concurrency limit and circuit breaker per endpoint, so a slow or
  failing endpoint delays only its own tenant.
- **Personal data** (A11): contact details for e-mail notices are read from the
  personal-data store at send time by the delivery worker and never written to the
  notifier's log, Kafka or any application log.
- **No order across requests**; per reservation, notices are delivered in stream order (a
  delivery carries them in that order, and the next delivery of the endpoint waits only
  for its predecessor's first attempt to **start**, never for it to complete, R27-08).

**Timing (est.).** **Affected notices** (C03 R39-06, V52-3): `affected_notice_time` (60 s)
is split into the link's share, **15 s** at p99 from the due time to `AFFECTED_NOTICE` on
Kafka, the **notifier's 40 s** from the feed publish to the first attempt of the delivery
that carries the notice, and a 5 s tail margin. If C03's 200 B size budget cannot be met,
the split becomes 20 s, **35 s** and 5 s; the notifier is designed to the 35 s figure. Its
path: the direct publish reaches the notifier in tens of milliseconds (about 2 s by the
relay); the notice entry commits in about 30 ms; the first attempt follows within about 1
s for a live endpoint, about 13 s for one refusing connections and about 32 s for a
10,000-notice burst to a silent endpoint, all inside 35 s. A notifier slot takeover (about
3.3 to 3.8 s, §4.4) fits in the remainder for a live or refusing endpoint; for a silent
endpoint during a notifier takeover the 35 s figure can be exceeded by a few seconds, which
the 5 s margin covers. **While the link's schedule owner fails over**, each notice that
POL-07 times by `affected_notice_time` is due within `affected_notice_time` +
`release_grace` (60 + 60 s; POL-07 and P1-N8 as amended in `requirements-v1.11`, which
settles C03's RQ-39-1); the notifier's 40 s share is unchanged, and the link uses the
allowance. **Outcome webhooks**: first attempt within about 1 s of the report; one account
at `account_rate_limit` (200/s) is about 2 to 4 deliveries a second.

**Load (R10, X2 open question 2).** No target exists. Provisional: one notice per request
answered `pending` (about 5,000 to 7,000/s at the design load, RFC-000 §6), plus notices;
sized for **20,000 notices/s** with retries, which batching turns into about 2,000 to
10,000 deliveries/s (est.), to be replaced by measurement. C03's worst outage (about
100,000 `AFFECTED_NOTICE` events in 10 to 14 s) is about 5 s of that rate.

### 16. Operational alerts

The **operational alert feed** (RFC-000 §8) is how every owner raises an alert (P2-S53,
P2-S104, P1-S63, P4-S81, reconciliation differences P4-S54, P4-S80, P4-S91, POL-14 breach
reports, and every platform alarm in this RFC).

- **Raising** (C01 §2.10, §3.11; settled M9, R47-08). An owner raises an alert as an entry
  in its **own** log emitting on its stream `alert`, topic `<kind>.alert.v1` (not on a
  business feed), so the alert is as durable as the fact that caused it and cannot be lost
  by a failing alert service. Platform components without a log (the clock monitor, the
  conformance report) raise through the alert service's own `append`. The alert is C01's
  `OperationalAlert`: `alertId` = (raising partition, alert kind, subject, **episode**),
  the episode being the raising entry's (partition, `seq`), so a later raise of the same
  kind and subject is a **new episode**, never a duplicate; `op` `raised` or `cleared`;
  `alertKind`; `severity` (`info`, `warning`, `page`); entities by pseudonymous identifier
  only (A11); `reasonCode`; `detail` with no personal data and no free text from users;
  `raisedAt`. Only the raiser may emit `cleared`, naming the episode it clears (for
  example RFC-001's withdrawn `CUT_TARGET_INEXACT`).
- **Alert service.** An owner on 8 slots: deduplicates by (`alertId`, `op`) (a later
  `detail` replaces an earlier one for display; severity only rises), groups the episodes
  of one (kind, subject) for display, tracks raised → acknowledged → resolved, escalates
  unacknowledged pages after 5 min, and routes by `alertKind` to the role that acts on it
  (network operations, finance, compliance, support, platform on-call, security). Routing
  rules are data. Alert kinds the platform itself raises include `MOVE_CUTOVER`,
  `CLOSURE_LAG`, `PROBING_FAULT`, `FEED_CONTENT_CONFLICT` and `STALE_SENDER_UNMOVED`.
- **Probing faults** (X2-S33; C01 §3.11, review 47 D1). The probe-results owner raises
  **one `PROBING_FAULT` episode per (region, minute)** in which any account slot was
  probed short (fewer than 3 probes, or from one location; none at all included), listing
  every such slot with its probe count and locations (`ProbingFaultDetail`), severity
  `warning`, routed to **network operations**. The episode escalates to `page` when the
  same slot is short for 5 consecutive minutes or more than 1% of slots are short in the
  minute. Every slot-minute is still recorded in the probe results. The shortfall alone
  does not make the minute unavailable (§17.3).
- **Visibility.** Alerts and the requests in trouble behind them are listed in the operator
  console with their reason and the leg concerned (P2-S51, RFC-002).
- **Dead-man's switch.** Every alert producer and the alert service send a heartbeat every
  minute to a watchdog **outside** Share's sites, which pages through an independent
  provider if heartbeats stop.
- **Error-budget alerts** (§18.5) and the alarms of §6 use the same path.
- **Alarms RFC-006's monitoring raises for other RFCs** (from metrics the owners export, so
  no owner has to watch itself):

  | Alarm | Condition | Routed to | Asked by |
  |---|---|---|---|
  | Identity freshness | An account owner's `now − iam_fresh` for a slot, or an edge's `now − fresh_s`, above `revocation_alarm` (30 s) | Platform on-call, security | RFC-005 §6, RFC-002 |
  | Catalogue freshness | A consumer's applied catalogue `resolvedTs` (the account owner's, or the edge's replica) more than 60 s behind | Platform on-call, commercial; network operations for the edge | RFC-002, C06 (m6) |
  | F2 apply lag | Acceptance to counted (F2 `appliedTs`) more than `attribution_lag_max` (C06) | Platform on-call, finance | RFC-002, RFC-004, C06 |
  | Late E11 | A future-effective lifecycle entry recorded after its effective minute (RFC-000 AI-17-3) | Platform on-call | RFC-002 |
  | Changefeed paused, altered or cancelled | Any such job event | Security and platform on-call; recorded in audit's append log | RFC-005 §9.3 |
  | Failing slot-minute | Any (D6): a slot whose every probe in the minute failed | Platform on-call | §17.3 |
  | Probing fault (`PROBING_FAULT`) | A slot probed short in a minute (X2-S33); escalation as above; runner skip rate above 10⁻⁴ per location | Network operations (platform on-call on `page`) | §17.3; C01 D1 |
  | Feed content conflict (`FEED_CONTENT_CONFLICT`) | Two copies of one (partition, stream, `stream_seq`) differ (§5.5) | Security and platform on-call | C01 D3 |
  | Stale sender not moved (`STALE_SENDER_UNMOVED`) | `STALE_SENDER` with a higher generation for a partition whose `moved` the sender has not applied (§4.5) | Platform on-call | C01 D4 |
  | Integrity hold | The runtime holds a partition after a head-chain mismatch and `integrity_report` is not yet accepted (§3.7, §14.3) | Security and platform on-call | C08 R46-12 |
  | Partner run missing | No `RUN_COMPLETED` of a partner's daily reconciliation by 12:00 UTC on D + 1 | Network operations, finance; shown in the console | C12 m11 |
  | Provider payments not yet received | One provider's total of payments posted and not yet received above `provider_unreceived_alert` (raised by RFC-004's reconciliation; never stops a payment) | Finance | POL-24 (`requirements-v1.11`), RFC-004 |
  | Feed lag | A consumer more than 60 s behind a stream's head | The consumer's team | RFC-002 RB-13, RFC-004 |
  | Non-conforming payload drops | `ingest_log`'s drop alert (each drop), hourly drop report (counts by reason, withdrawals was kept / was absent), a withdrawal pending more than 10 min; relayed from the self-outboxed streams (§3.5) | Network operations | RFC-003 rev. 5; POL-19 v1.9, P3-S75 |
  | Closure lag (`CLOSURE_LAG`) | A kind's closure emitter `R_min` more than 10 s behind now (60 s while a drain is in progress, §3.5) (§5.3) | Platform on-call; the consumers' teams | RFC-001, RFC-003, C01 |
  | Anycast reachability | The anycast canary from a probe site fails 3 times, or a region withdraws or re-announces (§2) | Network operations, platform on-call | §2 |
  | Move cut-over (`MOVE_CUTOVER`) | A partition `Moving` for more than `move_cutover_max` (1 s) (§4.5) | Platform on-call | §4.5, C01 |

### 17. Probes and availability measurement

#### 17.1 The probe estate

| Item | Design |
|---|---|
| Probe runners | Three colocation sites per serving region (at least two required, POL-06), outside Share's facilities, within about 10 ms (RFC-000 D2); persistent TLS connections to the region's **unicast** edge address (§2), so each region is measured on its own. Every probe site is also the **anycast arbiter** (§2; review 33 D1): it books a unicast canary in every region every 2 s and serves signed per-region verdicts to both regions' edges over the internet; this is internal detection, not the POL-06 measurement |
| **Probe accounts** (X2-S27; RFC-000 B-AI-10) | **Exactly one designated probe account per account slot** (about 16,384 at the design load), each Share-internal, placed in its slot by **placement's account slot map** (§7.1): by hash for ordinary slots, by an override row for a slot created by an override, never by guessing identifiers (R6-08). Placement provisions them in bulk: identity creates each as a Share-internal account with **KYB passed** (Share's own, POL-06), then one **set-scoped** finance action sets the credit limits of the whole set that placement supplies for the map version (`probeAccountSet(v)`, §7.1; POL-15, POL-32; RFC-004 revision 5), and a slot is published only after its probe account has answered **`applied`** to its credit limit, so no published slot is unprobed or probed without a limit. Each counts as vetted, is never invoiced, and has one agent key per runner location. No probe account is a buyer's account (designation is set only on a new Share-internal account, §17.4). The wallet's balance and headroom answer is the account owner's funds module in the same slot, so one probe account per slot covers both capabilities |
| Probe links | 64 designated probe links per serving region, each a Share link on Share's own equipment in that region with a large virtual capacity (10 Gbps), on shared link slots spread over both facilities' processes; probes never book the hottest links (RFC-000 R24) |
| **Probe supplier** | One designated Share-internal supplier owning every probe link; it never earns (nothing is settled), and its payout runs always end "nothing due" (X2-S20) |
| Probe exporters | Eight per serving region, spread over ingestion slots |
| Schedule (`requirements-v1.8`, X2-S27, X2-S30) | **Admission and wallet**: each of the three locations probes **every account slot once a minute** for admission and once for the wallet, through the slot's probe account, the three locations' probes of one slot **20 s apart** (location *k* at offset `hash(slot) mod 20 s + 20k s`), so each slot gets **at least 3 probes a minute from 3 locations** per capability and region. If a location fails (runner heartbeat), the other two each probe every slot **twice** a minute (10 s and 30 s apart), so each slot still gets 4 probes from two locations and the slot rule stays live. Volume: 16,384 × 3 ≈ **820 admission bookings/s and 820 wallet reads/s per region** (about 3,300 probes/s in both regions, about 6.6% of the design booking load in bookings, est.). After a doubling of the account slot count the probe volume doubles (about 1,640 bookings and 1,640 wallet reads a second per region) and the probe links double to 128 per region (§7.1, R33-12). **Ingestion, payouts and reporting**: each location every 10 s, offset by about 3.3 s, **18 a minute** per region. Every capability is therefore probed at least every 10 s from at least two locations (X2-S16) |

#### 17.2 Per-capability operation and "correct answer" (X2-S18)

| Capability | Operation | Limit | Correct when |
|---|---|---|---|
| Admission API | Book a single probe link, 1 Mbps, window [next minute, +1 min), `wait = true`, fresh idempotency key, as the probe account of the slot due; probe links rotate | 200 ms (the 90% rule); `slot_probe_limit` 1 s (the slot rule, §17.3) | A well-formed answer for this request: confirmed (expected, since probe links always have free capacity), or `pending` whose outcome, read later, is confirmed. A rejection, an error, a different request's answer or a `pending` that ends not confirmed is incorrect (scored retroactively) |
| Usage ingestion | Send one flow record from a probe exporter with the next position in its export stream (same observation domain and counter epoch; C11); every tenth probe resends an earlier record | 1 s | Acknowledged as accepted, naming that record; a resend acknowledged as the same accepted record (never accepted twice, P3-N3) |
| Wallet | Ask for the probe account's balance and headroom | 200 ms (the 90% rule); `slot_probe_limit` 1 s (the slot rule) | Well-formed, carrying its account-log position, internally consistent (headroom = balance − funds held − usage exposure + credit limit, POL-18), with the credit limit finance set |
| Payouts | Ask for the status of the probe supplier's latest payout run | 1 s | Well-formed, for the run expected by the schedule, "nothing due" |
| Reporting and statements | Ask for a probe account's statement for the previous UTC day | 2 s | Well-formed, for that day, containing no charges and the credit holds as expected |

The probes take the real path: edge, identity, account owner (credit hold against the
credit limit, X2-S24), link owner, report position, status readers. The limits are measured
end to end at the runner (RFC-000 §3: about 125 to 135 ms for admission, est.).

#### 17.3 The available minute (X2-S16) and the monthly figure (X2-S01)

- Probe results (runner, region, capability, probe account or exporter, send time, latency,
  correctness, error) are recorded by the probe-results owner (64 slots, about 3,300 results a second over both regions, est.), timestamped by the
  runner's NTP clock; a result scored incorrect retroactively is a new entry, not an edit.
- A probe belongs to the minute of its send time at the runner. A slot **got** a probe when
  a runner sent it: a probe that was sent and got no correct answer in time (an error, a
  wrong answer, a lost connection) is a **failed** probe, not a missing one. A probe that
  no runner sent is missing.
- A **minute** (UTC) of a capability in a region is **available** (POL-06 as of
  `requirements-v1.10`; X2-S16, X2-S30, X2-S33) only if all hold:
  1. it was **probed as required**: at least 12 probes, from at least two locations;
  2. at least 90% of its probes succeeded;
  3. for admission and the wallet, **no account slot had a failing slot-minute** in it: a
     slot that got **at least one** probe in that minute, **every one** of which got no
     correct answer within **`slot_probe_limit`** (1 s), **however few** they were. The
     pipeline therefore scores each admission and wallet probe twice: against its 200 ms
     limit for rule 2, against 1 s for rule 3.

  A slot **probed short** in a minute (fewer than 3 probes, or from fewer than two
  locations; a slot with no probe at all included) is a **probing fault**: the
  probe-results owner raises the `PROBING_FAULT` episode of that (region, minute) to
  network operations (§16; X2-S33). The shortfall does **not** by itself make the minute
  unavailable, so a slot with no probe at all in a minute never does; a slot probed short
  whose every probe failed still makes it unavailable by rule 3. Rule 1 still counts a
  real shortfall of the capability's probing against Share.

  X2-S30: with 99% of probes succeeding, slot 17's 3 probes from two locations none of which
  got a correct answer within 1 s make the minute unavailable; 3 probes each answered
  correctly in 400 ms (failing their 200 ms limit, inside `slot_probe_limit`) leave it
  available; 2 of 3 failing leaves it available; **only 2 probes, both failing, make it
  unavailable** (a failing slot-minute however few its probes); **no probe at all** for
  slot 17, every other slot probed as required, leaves it available (a probing fault); 11
  probes all from one location make it unavailable by rule 1. X2-S33: slot 17 with no probe,
  with 2 probes from two locations both correct, or with 3 probes from one location all
  correct, raises a `PROBING_FAULT` for slot 17 in that minute and leaves the minute
  available.
- **Classification recorded per minute** (for §8.2): available; **measured failing** (rule 1
  holds and rule 2 fails: the only probe evidence for a disaster); **unmeasured** (rule 1
  fails: unavailable, not evidence, breaks a run, X2-S32); **slot-failing** (only rule 3
  fails: unavailable, not evidence). The record keeps the probe count, locations, success
  share, the failing slots and the short-probed slots.
- **Alerts and pages.** An unmeasured minute pages as a measurement fault. A slot probed
  short is a `PROBING_FAULT` (`warning` to network operations, `page` after 5 consecutive
  short minutes of one slot or more than 1% of slots short in a minute; C01 D1), flagged in
  the monthly report. Each runner counts the scheduled probes it did not send; a skip rate
  above 10⁻⁴ per location pages (§10.2): runners shed every other task before they skip a
  scheduled probe. **Any failing slot-minute pages platform on-call at once** (decision
  D6, R6-30: a stuck slot is acted on at its first minute, not after it has spent the
  month's budget).
- Availability per capability, per serving region, per calendar month = available minutes /
  minutes in the month, leaving out the minutes of a declared disaster (§18.4). Planned
  maintenance is not excluded.
- Monthly reports are generated from the probe-results log and kept 7 years with the
  results, so every figure can be recomputed; they list the failing slot-minutes, the
  probing faults and the unmeasured minutes.

#### 17.4 Probe designation and isolation (X2-S20, X2-S24, X2-S27)

RFC-006 owns the "probe designation and exclusion" contract (RFC-000 §8). Its rules:

1. **Designation** (C01 §2.9, §3.10, settled M11; C06 D7, AI-44-1). For **accounts**,
   placement's account slot map is the **only** authority for which account is a slot's
   probe account: placement provisions the account in identity (a Share-internal tenant
   with KYB passed) and names it in a map version's `probeAccounts`; the account owner
   applies it as **F9** (`excluded`) and records the designating map version. Identity
   holds the account and the catalogue may show the designation, but neither decides it.
   For **links, exporters and the probe supplier**, the catalogue holds the designation,
   set by network operations. Each designation is set only at provisioning, with a reason,
   audited (RFC-005); finance sets the accounts' credit limits. It can be set only on an entity with no
   history, and **never cleared**, so no real link, account, supplier or exporter can be
   turned into a probe one to hide revenue, and no probe one can start earning.
2. **Probe traffic stays probe traffic.** A probe account may book only probe links, and a
   non-probe account may not book a probe link: the account owner refuses such a request at
   intake as invalid (RFC-002 enforces). Probe exporters report only flows on probe links.
3. **Exclusion.** Rating produces no charge line for a reservation of a probe account or a
   record from a probe exporter (RFC-003); settlement therefore receives nothing (RFC-004);
   supplier reports leave out probe links; quarantine reports leave out probe exporters'
   records; reconciliation is unaffected because no movement exists. Every consumer takes
   an account's designation from the slot map (directly, or as the account owner's F9 and
   the feeds derived from it, such as C04's `account_is_probe`, a copy and never a
   decision, C04 CC-1) and a link's, exporter's or supplier's from the catalogue; since
   designation never changes, any position gives the same answer.
4. **Real funds path.** Each probe account's credit holds are real (POL-06, X2-S24): they
   gate its bookings like any account's and are released when the reservation ends
   (RFC-004). Each credit limit is sized for its rate: 3 bookings a minute per region (6
   while a location is down) × 2 regions, each holding its coverage for a 1-minute
   reservation of 1 Mbps, so at most about 12 to 24 holds at once; finance sets the limits
   of the whole set placement supplies for a map version (`probeAccountSet(v)`) with that
   figure in one set-scoped action (RFC-004), and the alert "probe account headroom below
   25%" pages. That figure is a few US dollars per account (est.), far below
   `credit_limit_four_eyes_above` (10,000 USD; POL-32 as amended in `requirements-v1.11`,
   X1-S49), so one finance operator sets it, with the one out-of-band confirmation per
   set-scoped action that C08 S-M2 states. A set-scoped value above the threshold would
   need a second finance approval like any limit (the account owner checks it per member,
   C08 C-14); placement never asks for one.
5. **Retention.** Probe records and reservations are kept like any (they are facts): about
   1,640 probe bookings a second over both regions (est.), sealed like other account and
   link entries.
6. **What probes do not show.** Probes cover every account slot three times a minute, but only
   statistically every edge node and status-reader process. Internal canaries (§18.5)
   cover every slot, reader and node for detection; they are not the measurement POL-06
   defines.

### 18. Latency and timeliness measurement

#### 18.1 Latency at the system boundary (X2-S05, X2-S15, X2-S06, X2-S07; RQ-D)

- The edge records, per request, the arrival time (first byte) and response time (last byte
  sent), the operation, the region, whether the answer was final or `pending`, and, for
  single-link bookings, whether the link reported capacity in flight (the link owner's hold
  answer carries the flag, RFC-001), into per-minute HDR histograms per (region, operation,
  class).
- **Every percentile is per calendar month and per serving region** (POL-06 as decided on
  RQ-D): the month's per-minute histograms of a region are merged and its p99 taken, leaving
  out the minutes of a declared disaster (§18.4). Daily figures are computed for operations
  only.
- X2-S05: all single-link bookings, final or `pending`. X2-S15: single-link bookings on Share
  links without capacity in flight, final answers only (a `pending` there counts as a miss).
  X2-S06: route bookings to the first response; outcome by deadline from RFC-002's outcome
  records (decision `ts` before `D`, A-T4 for any that is not). X2-S07: top-up from
  notification to credited headroom (§18.2), p99 per month and region.

#### 18.2 End-to-end timings (X2-S07, X2-S22, X2-S17, X2-S08, P1-S75)

All times are entry `ts` values (commit timestamps, within the measured database offsets of
one another, normally about 1 ms or less with LAN NTP, est.) or boundary times recorded by the edge or
the notifier, so each timing is exact to within twice the measured offset.

| Target | Start | End | Computed by |
|---|---|---|---|
| Top-up to credited headroom ≤ 10 s, p99 per month per region | Edge arrival of the provider's notification (in the payments event entry) | `ts` of the account owner's entry applying the ledger balance through a position at or after the movement (RFC-004) | Joining source reference → movement position → account-log position |
| Accepted record to headroom ≤ `attribution_lag_max`, 99.99% of minutes | `ts` of the ingestion batch entry that accepted the record | `ts` of the account owner's entry applying unposted usage through a rating position that covers the record (RFC-003) | **Watermarks**: for each acceptance second, when every ingestion position accepted in it is covered; a minute is good if every second in it is within 10 s; RFC-003 reports each late record as a breach (POL-14) |
| Standing to network operations ≤ `standing_notice_time` | `ts` of the standing-change entry | Network operations' acknowledgement (RFC-004's feed) | Per change |
| Suspension to enforcement ≤ 60 s | `ts` of the suspension entry | Network operations' report of the block in effect | Per suspension |
| Told within `affected_notice_time` (P1-S75) | `ts` of the link owner's record of the outage or change | The later of the notice-list entry's `ts` and the first attempt's start (§15) | Per notice |

#### 18.3 Charge timeliness (X2-S13, X2-S19)

- **Reservation accrual.** Rating publishes, per slot, a watermark "accruals posted through
  minute m" with its `ts` (RFC-003; posting acknowledged by the ledger, RFC-004). Minute `m`
  is good if every slot's watermark passes `m` within 2 min of its end.
- **Usage-priced.** For minute `m`, the records that arrived within `max_lateness` of its end
  are those accepted at ingestion positions up to `m_end + max_lateness`; minute `m` is good
  if the usage charges covering them are posted by `m_end + max_lateness + 2 min`.
- **Monthly figure**: good minutes / minutes, excluding the minutes affected by a declared
  disaster (§18.4), against 99.99%.
- **Bounds**: any charge later than its target + 5 min (outside a disaster) or target + 1 h
  (in one) is a page and a reported breach.

#### 18.4 Declared-disaster exclusions (X2-S19, X2-S23, X2-S26, X2-S28)

The measurement pipeline reads the `disasters` table (§7.1). A window runs from the start
placement derived (§8.2, §8.3): the **recorded loss**, or the first minute of a run of at
least `disaster_probe_minutes` measured failing minutes leading up to it if earlier, or for
a probe-evidence declaration the **first measured failing minute** of its run, to the
approved end; minutes before that
start, and every minute of a loss never declared, count as usual. Because a declaration
may be approved after the month's report was generated, the report is regenerated on every
approved declaration or end, and every version is kept.

| Measurement | Treatment in the window |
|---|---|
| Availability (X2-S01) | Minutes excluded for every serving region (POL-06). Probes keep running and their results are kept, so the surviving region's service stays visible |
| Latency targets (X2-S05, X2-S15, X2-S06, X2-S07, X2-S22, X2-S17, X2-S08; X2-S23) | Not measured |
| Charge timeliness and attribution lag (X2-S13, X2-S22) | Affected minutes excluded; bounds of target + 1 h apply (X2-S19) |
| RPO, outcomes by deadline, breach reporting | **Always** measured (X2-S23): A-T4 and the durability checker run throughout |

A declaration approved at 10:20 for a loss recorded at 10:00 (X2-S26) excludes 10:00 onwards;
the minutes 09:40 to 10:00 that an operator may claim count. A recorded loss from 10:00 to
10:20 never declared (X2-S28) counts in full. With no recorded loss, measured failing
admission minutes from 10:00 to 10:04 and a declaration approved at 10:20 (X2-S29) exclude
10:00 onwards, latency included (X2-N3); 10:00 to 10:03 only, or a run broken at 10:02 by an
unmeasured minute (X2-S32), and the declaration is refused and every minute counts. With a
loss recorded at 10:06 after measured failing minutes from 10:00 to 10:05, the window starts
at 10:00; from 10:03 only, at 10:06 (X2-S31). The monthly report lists every recorded loss,
declared or not, with its window.

#### 18.5 Error budgets and canaries

- Burn-rate alerts on each availability and timeliness budget: a page when the 1 h burn rate
  exceeds 14.4 × the monthly rate and when the 6 h burn rate exceeds 6 ×; a warning at 1 ×
  over 3 days.
- **Internal canaries** (not the POL-06 measurement): a canary partition in every slot
  appends an entry every 10 s and checks it through Kafka and from a status reader in every
  Kenyan facility, so a failing slot, reader, relay or broker is detected even if no probe
  touches it. The **anycast-reachability canary** (§2) books through the anycast address
  from every probe site every 10 s, since the POL-06 probes use unicast and cannot see a
  withdrawal.

### 19. Capacity planning and storage at the design load (×50)

#### 19.1 Sizing rules

1. **Size for the provisional design load of POL-06** (25,000 requests/s, 2,500/s on one
   link, 260,000 records/s average and 600,000/s peak, 1,000 notifications/s, the admission
   mix), plus RFC-000 §6's derived loads (about 1 M reservation lines/s rated, about 1,700
   movements/s, 100,000 status polls/s).
2. **One facility carries its region.** Each Kenyan facility can hold every range lease and
   every owner slot of the design load at no more than 70% CPU, because after the loss of
   the other facility of the preferred region one facility leads everything.
3. **The other region mirrors it**, since it must carry everything after a region-wide
   failover, and during 2 + 2 one of its facilities alone may again carry everything.
4. **R3** carries one voter of every range, a non-voter of every admission range, and a
   reserved second voter set.
5. **Re-run on measurement.** When exporter, provider and admission measurements replace the
   provisional figures (X2 open question 1), this section and the load test are re-run
   before production.

#### 19.2 Transaction load and node counts (est.)

Revision 4 re-derives the load from the slot counts RFC-000 revision 4.2 sets and from
RFC-003 §1.1 and RFC-004 (R6-06). At an occupancy of about 0.1 to 0.2, most batches carry
one or two partitions, so the transaction count rises steeply and the fixed cost of a
transaction (epoch read, `ts` read, commit) dominates. Statements are counted per
transaction as below, at about 1,000 statements per vCPU-second (est., to be measured).

| Load | Transactions/s (est.) | Statements per transaction (est.) | Note |
|---|---|---|---|
| Account owners: batches | about 105,000 | 8 | About 110,000 entries/s plus about 1,640 probe bookings/s (×2 entries), 16,384 slots at about 6.5 batches/s each, about 1.1 entries per batch (RFC-000 §3) |
| Account owners: marker-only | about 30,000 | 3 | Outside the lane (§4.6); due only on `report_wanted` or outcome entries, about 35,000 batches/s, of which about 88% find no batch within 20 ms (R27-17) |
| Link owners | about 42,000 | 8 | 4,096 shared slots (about 37,000) and up to 128 dedicated (about 5,000) |
| Ingestion; stage A; stage B; rating | about 6,400; 2,600; 8,500; 8,500 (26,000) | 10 | RFC-003 §1.1 and R3-12 |
| Ledger, settlement, payments, receivables, payouts | about 6,000 | 10 | RFC-004 (one batch in flight per ledger slot, 1 to 3 movements each) |
| Notifier | about 10,000 | 8 | About 20,000 notices/s and about 2,000 to 10,000 delivery entries/s on 1,024 slots (§15; R6-06 recounted) |
| Identity, catalogue, approvals, alerts, probe results, placement, partner adapters | about 4,000 | 6 | Probe results about 3,300 entries/s on 64 slots |
| Session renewals | about 2,400 | 1 | About 1,200 processes in both regions twice a second |
| Standbys' present-time session polls (§4.4) | about 5,000 to 10,000 | 1 (read-only) | R27-05 |
| Resume and resolution reads, relay progress | under 1,000 | 1 to 2 | §4.2, §5.3 (leaseholder load) |
| Rule-3 checks by readers without a live lease, cached (§4.6) | a few hundred; a few thousand at a region failover | 2 (read-only) | R33-16 |
| *Follower reads, not at the leaseholders*: the closure emitter's `link_head` reads (a few thousand links a second), standby tails, the sealer | — | — | Served by each facility's own replicas (R33-18) |
| **Total** | **about 235,000** | | **about 1.70 M statements/s at R1's leaseholders** |
| **Changefeeds** (R27-13) | about 20 outbox (about 150,000 rows/s) and about 20 narrow audit changefeeds (about 300,000 rows/s) | — | Rangefeed, encoding and Kafka production on the database nodes: about 180 vCPU per facility (est., about 5,000 rows/s per vCPU, doubled for rangefeed overhead); the spike measures it (§22.1) |

| Item | Per Kenyan facility | R3 | Notes |
|---|---|---|---|
| Database nodes (96 vCPU, 384 GB RAM, 4 × 3.84 TB NVMe) | **36** | 8 per zone × 3 zones running (64 vCPU); 24 more stopped with disks provisioned (§8.1) | Leaseholder work about 1,700 vCPU plus follower work about 30% plus changefeeds about 180: about 2,390 vCPU, **69%** of one facility's 3,456 (§19.1 rule 2). Revision 4's 34 nodes would be at 73% once the changefeeds and the marker recount are counted (R27-13, R27-17). Revision 3's 24 nodes of 64 vCPU (1,536) would be at about 155%: the slot counts RFC-000 revision 4.2 adopted about double the database's CPU (RK28) |
| Owner hosts (64 cores, 256 GB) | 32 | — | About 600 owner processes per region at about 2 cores each (est.), all within one facility at ≤ 70%, plus the hot standbys of the other facility and, in the other region, the link and identity slots' cross-region hot standbys; the read-lease and push streams (§4.6) |
| Status-reader hosts | 4 (8 reader processes, §4.6) | — | 25,000 polls/s per facility, most from pushed state, plus 820 wallet probes/s per region |
| Kafka brokers (32 cores, 128 GB, 8 × 3.84 TB NVMe) | 6 | — (one KRaft controller) | §19.3 |
| KRaft controller | 1 | 1 | Small hosts |
| Edge nodes | 8 | — | 25,000 bookings/s plus 1,640 probe bookings/s + 100,000 polls/s + ingestion and payments ingress across a region, one facility able to take it all |
| Stateless workers (partner calls, relay, delivery workers, reporting read models) | 12 | — | |
| Time servers | 2 (GNSS, OCXO holdover, NTP) | — | §6.1 |
| Ceph | R1: 4 nodes (personal-data store backups, checkpoints); R2: 4 such nodes plus the hot archive and database backups, about 3 PB raw (about 16 nodes of 200 TB, est.) | — (GCS; S3 in Cape Town) | §13.2, §14 |

**Per owner process and connections** (R33-05, est.). An account-owner process (64 per
region, about 256 slots each) runs about 1,640 batch transactions a second × 8 statements,
about 13,000 `pg` round trips a second on its event loop, plus about 6,560 gRPC pushes and
320 lease messages a second and its decisions. At about 20 to 30 µs of main-thread work per
round trip (protocol parse and serialise, est.) and about 50 µs per decision, that is about
0.4 to 0.6 of one core's main thread, with encryption, compression and chain hashing in
worker threads (§4.7): it fits, but with little margin for pauses. Exit criterion (§22.1):
**an account-owner process at 1,640 transactions a second with event-loop delay p99.9 ≤ 50
ms**; the lever is **128 slots per process** (128 account processes per region, about 0.25
of a main thread each). **Connections** by Little's law: about 235,000 transactions a second
× 20 to 30 ms is about 5,000 to 7,000 open transactions in steady state, about 15,000 after
a region loss (65 to 70 ms commits). Pools are sized per process at its expected concurrency
× 2 (an account process: about 1,640 × 30 ms × 2 ≈ 100 connections; 64 × 100 = 6,400 for the
kind), spread over the facility's gateways: in steady state about 100 to 200 active connections
per node over the preferred region's 72 nodes, after a facility loss about 15,000 over the surviving facility's 36
nodes, **about 420 per node**, which the spike checks against the release's per-node limits
(§22.1); the per-tier circuit breaker (§4.7) keeps a fallback tier from doubling the open
connections. **Probe load during a doubling** (R33-12): while the count is `2n`, probes are
about 1,640 admission bookings and 1,640 wallet reads a second per region, about 13% of the
design booking load, carried on 128 probe links per region (§17.1).

**Kafka partitions per broker** (C01 R47-30; est.). A topic has a power of two of at least
its producer's slot count divided by 4 partitions (§5.4). The account kind's topics
(outcome, lifecycle, standing, usage-applied, alert, and the closure topics of lifecycle
and usage-applied: about 8) have about 4,096 partitions each, about 32,800 in all; the link
kind's (schedule, its closure topic, alert) about 1,024 each; every other kind a few
hundred at most. That is about **36,000 partitions, about 144,000 replicas at replication
factor 4, about 6,000 per broker** over 24 brokers. After one doubling of the account slot
count the account topics may grow to about 8,192 partitions each: about **70,000
partitions, about 11,700 replicas per broker**. The growth is optional (a topic keeps
working at the old count, because consumers never order by offset), so placement grows a
topic only when its partitions' produce rate needs it. The spike measures a broker and the
KRaft controllers at 12,000 replicas per broker (§22.1); the lever is more brokers (8 per
facility gives about 8,800 per broker after a doubling), not fewer partitions (RK36).

**The trade-off of more slots** (R24, as the coordinator decided). The default is more slots
(16,384 account, 4,096 shared link), which keeps the batching wait at about 20 ms and every
per-partition guarantee simple, at about double the database CPU of fewer, fuller
batches. The alternative, about 2,048 account slots with the second lane always on, would
carry roughly half the account transactions (about 2 entries per batch) for a similar
wait, at the cost of running the second lane everywhere from day one. The spike measures
the per-transaction cost; if it is above the estimate, the spike sets the least account
slot count that meets the R23 exit criterion (account step p99 ≤ 50 ms, §22.1) and enables
the second account lane to cover the rest (RK28). Coalescing applied unposted usage
(RFC-004) would roughly halve the account load either way.

#### 19.3 Replication and fibre bandwidth (est., at peak)

Payloads are compressed by the owner before encryption, so database and Kafka traffic is
close to RFC-000 §6's compressed figures, plus clear columns and the write amplification
of heads, projections and outbox rows.

| Stream | Rate |
|---|---|
| Logical writes at the leaseholders (log rows, outbox rows, heads, projections, indexes) | about 220 MB/s (more, smaller batches add per-row overhead) |
| Audit changefeeds (narrow, §3.5) into `cdc.audit.*`, each replicated to R2's two replicas | about 30 MB/s produced; about 60 MB/s R1 → R2 (full-row fallback: about 220 MB/s produced, about 440 MB/s R1 → R2) |
| Checkpoints (§12.11) | none across regions (each region's standby writes its own; R27-13) |
| Relay progress, closure markers (§5.3) | under 1 MB/s |
| R1 → R2: two voters, plus two non-voters of the account tables | about 500 MB/s (4.0 Gbps) |
| R1 → R3: one voter, plus the admission tables' non-voter | about 280 MB/s (2.2 Gbps) |
| Kafka: about 60 MB/s of outbox values produced **three** times (direct, the changefeed into `cdc.*`, the relay), each replicated to R2's two replicas (R6-20) | about 360 MB/s R1 → R2 (2.9 Gbps); consumers fetch locally |
| Archive: each segment to GCS and to S3 (both over the Kenya–Johannesburg paths), and to R2's hot copy | about 60 MB/s each: 120 MB/s towards Johannesburg, 60 MB/s R1 → R2 |
| Backups: hourly incrementals to GCS and to R2's Ceph | about 60 MB/s each |
| **Nairobi–Mombasa, total** | **about 1,040 MB/s (8.3 Gbps)**; about 1,420 MB/s (11.4 Gbps) with full-row audit changefeeds |
| **Each Kenya–Johannesburg path** | about 460 MB/s (3.7 Gbps) from the preferred region; during 2 + 2, about 680 MB/s (5.4 Gbps), plus snapshot bursts if delegation is unavailable |
| Restoration of a region (§8.4) | 10 to 20 Gbps of snapshots over the Nairobi–Mombasa paths for hours |

**Rule for the fibre**: each Nairobi–Mombasa path must carry **at least 40 Gbps** for the
platform alone, and each Kenya–Johannesburg path, including its GCP interconnect and its
AWS Direct Connect, **at least 10 Gbps**, so that either path of a pair carries everything
with room for snapshot bursts (§20). **No traffic transits R3 between the Kenyan regions**
(R6-11): Share does not configure transit through its GCP VPC or carrier transit in
Johannesburg, so a Kenyan link cut leaves R2 unserved (§11) rather than adding about
1,040 MB/s to a Johannesburg path that could not carry it. This is about four times revision
1's Nairobi–Mombasa figure (Risk RK6).

#### 19.4 Storage over 7 years (est.)

| Data | Per copy at year 7 | Copies | Total |
|---|---|---|---|
| **Archive** (§13.2): raw flow records about 2.9 PB, ledger lines about 2.2 PB, account and link logs about 1.1 PB (up to 3.8 PB if every kind is `7y`), rating, attribution, payments and audit about 1 PB | **about 7 to 10 PB**, growing about 1.2 PB a year | 2 cloud copies (GCS, S3) for 7 years; the Kenyan hot copy for 13 months (about 1.3 PB, 2 PB raw at 4 + 2) | about 14 to 20 PB in two clouds; about 2 PB raw on R2's Ceph (R6-13: revision 3's three copies could not be kept, since every copy was under the 7-year lock) |
| **Database, live**: payment reference bindings about 22 TB; ledger watermarks, record-identity range sets, projections and 63 M active reservations about 3 TB; outbox rows 26 h live plus 25 h of MVCC garbage at about 60 MB/s, about **11 TB** (R6-21); the truncator's garbage (4 h at about 100 MB/s of log) about 1.5 TB; log tails (minutes normally) | **about 38 TB normally; about 60 TB with a 24 h archive outage buffered** | 5 voters, plus non-voters of the account tables (about 2 TB each) and admission tables | about 200 to 310 TB; about 50 to 75 TB per Kenyan facility (with the personal-data store), about 10 to 15% of its 553 TB of NVMe (36 nodes × 4 × 3.84 TB; R33-11) |
| **Kafka**: 3 days of the high-volume topics, 26 h of `cdc.*` (with `cdc.audit.*`, about 3 TB), 7 days of the rest, of which `account.usage-applied.v1` about 3 to 6 TB (C05 "Gap recovery": 25,000 to 50,000 events a second of about 200 B for 7 days), 14 days of the store events feed (under 1 GB) | about 69 TB | 4 | about 275 TB, about 11.5 TB per broker; the usage-applied topic is about 12 to 24 TB of it at replication factor 4 (C05 states 9 to 18 TB at factor 3; CI6-4) |
| **Personal-data store**: subject items and keys (about 10⁶ subjects, under 1 TB) and refused-template payloads (about 8 TB, §14.4) | about 9 TB | 5 voters | about 45 TB; its own backups about 2 fulls (7 days) on each Kenyan Ceph |
| **Backups**: 35 days, weekly fulls of about 10 TB (the backed-up tables) and hourly incrementals of about 60 MB/s | about 0.35 PB | 2 (GCS, R2's Ceph) | about 0.7 PB |
| **Checkpoints** (§12.11) | about 0.8 TB | 2 (R1 and R2 Ceph) | about 1.6 TB |

The live database grows by about 3 TB a year per copy, almost all payment reference
bindings; if that becomes a cost problem, bindings older than 13 months can be served from
a history index instead (RFC-004 decides; RK22).

#### 19.5 The load test (X2-S03, X2-S04)

On a **pre-production cell on the real three sites and fibre** (its own nodes, same
placement, same paths), a generator reproduces the design profile for **at least one hour**:
25,000 requests/s with 2,500/s on one link, 80% single-link and 20% routes, 70% fitting, with
realistic account and link skews, poll and webhook traffic; records at 260,000/s with
600,000/s peaks for 5 min each quarter hour, duplicated, late and out of order as P3
describes; 1,000 payment notifications/s; and the full probe schedule (§17.1) running
against the cell. Pass: every latency target of X2-S05, X2-S15 and X2-S06 and every
timeliness target of X2-S13 and X2-S22 met throughout (§18 methods), no failing
slot-minute and no probing fault, and the share of admission probes slower than 200 ms below 5×10⁻⁴ at each
location (§10.2). A
second run injects a database node loss, an owner host loss, a facility loss and a
region-wide failover during the hour and checks RPO 0 and the RTOs (§22.2).

### 20. The diverse-fibre go-live condition

#### 20.1 The condition (RQ-F, as decided)

`requirements-v1.6` now states exactly the condition RFC-000 §5.1's cut analysis depends on
(X2 constraints; POL-06; glossary *Serving region*): **four paths, pairwise with no shared
risk** (no common duct, trench, cable, landing station, building entry, bridge or right of
way, and no common power for in-line equipment):

| Path | Requirement |
|---|---|
| N–M A and N–M B | Two Nairobi–Mombasa paths |
| N–J | Nairobi to Johannesburg (GCP `africa-south1` interconnect), **not via Mombasa** |
| M–J | Mombasa to Johannesburg, **not via Nairobi** |

Each with the capacity rule of §19.3 and latency within RFC-000 §3's RTT matrix, the diverse
N–M path within 15 ms RTT. The Johannesburg ends terminate both Share's GCP interconnect and
its AWS Direct Connect (§2). **No transit between the Kenyan regions through Johannesburg**
is configured (R6-11; §19.3); RFC-000 §5.1's double-cut row reading "R2 reaches the owners
only through R3" is therefore read as "R2 unserved" (AI6-9). The same gate includes the facility inventory (§20.4), the
database's enterprise licence and support contract (§3.1), and **staffing**: about 12
rostered platform engineers with the primary on-call rotation staffed at 6 or more, and the
vendor 24 × 7 contracts in force (Benefits, decision D5, R27-14).

#### 20.2 Verification before production

Share's network team owns the verification; the platform lead countersigns. Production does
not start until the record is complete.

1. **Route evidence.** For every path and every carrier on it: the as-built route (GIS file
   of duct and cable, landing stations, building entries, in-line amplifier and regeneration
   sites), the carrier's written statement of shared risk, and the contractual duty to notify
   Share of any reroute.
2. **Shared-risk register.** Every element of every path is entered as a shared-risk link
   group (SRLG); the condition holds only if the four paths' SRLG sets are pairwise disjoint,
   checked mechanically, with attention to the corridors that tend to be shared (the
   Mombasa–Nairobi road and railway corridors, power-line fibre, the Mombasa cable landing
   stations, the Johannesburg interconnect facility).
3. **Independent desk audit** of the evidence by someone outside the team that procured the
   paths.
4. **Cut tests** on the pre-production cell: each path disabled in turn, and each pair whose
   loss RFC-000 §5.1 analyses (N–M A + N–M B; N–J alone; M–J alone), checking that traffic
   takes the expected path, that the database's commits and Kafka's replication behave as
   §11 states (including `min.insync.replicas` 2 and R2's anycast withdrawal on the Kenyan
   link cut, and no traffic transiting Johannesburg), and that the latency rows hold; and
   the **metro split** of each Kenyan region (the link between its two facilities cut),
   checking the R2 gateway fallback and the consolidation of §7.3: no admission slot
   unserved for more than 30 s (the design expects about 3 s), the cut-off facility's
   leaseholders drained within 60 s, and no Kafka partition led there after 30 s.
5. **Sign-off record** (evidence, register, audit, test results) kept with the platform's
   records for the retention period.

#### 20.3 Keeping it true

- Per-path latency, loss and BFD monitoring; an alert when a path's RTT changes by more than
  2 ms for 5 min (a sign of a reroute that may share risk), investigated within a day.
- Re-verification yearly, on any carrier change and on any carrier notice of a reroute; the
  condition is re-checked for a replacement site before a disaster is ended as "replaced"
  (§8.4).

#### 20.4 The facility inventory (RFC-000 R2)

Part of the same gate: Share's platform team confirms at least two independent facilities
(own power feed, own fibre entry) in each of Nairobi and Mombasa, each with three racks on
separate power distribution (§2). If a metro has only one, the topology state "facility
lost" becomes "region lost" for it, the voter constraints change, and §10.2's budget
arithmetic is redone before go-live.

### 21. Runbooks (outline)

| ID | Situation | Outline |
|---|---|---|
| RB-1 | Database node loss | Confirm every range has a leaseholder (no unavailable ranges); confirm probe minutes; after 5 min confirm replicas re-placed in the same facility; open a hardware ticket; decommission the old node ID if it will not return |
| RB-2 | Owner host loss | Confirm standbys hold every slot (dashboard: slots without a live holder = 0); confirm no `Ambiguous` batch left unresolved; restart or replace the host; standbys re-created |
| RB-3 | Facility loss | Confirm leases and slots consolidated in the surviving facility; check CPU headroom (§19.1 rule 2); freeze deploys; confirm Kafka in-sync at 3; track recovery; rejoin as new nodes |
| RB-4 | Region-wide failover (automatic) and declaration | Verify trigger and evidence; verify every admission slot in the new region within 30 s; confirm Kafka `min.insync.replicas` 2; watch the 10 min timer for the automatic 2 + 2; within 10 min decide whether to declare (§8.2); **declaration**: network operations declares naming the recorded loss, with reason and evidence; a second network-operations operator approves; publish the customer notice. **On probe evidence** (no recorded loss): only after RB-12 has shown a service fault of the whole region, not a slot; the console shows the run of **measured failing minutes** (unmeasured and slot-failing minutes are not evidence and break a run, so a measurement fault cannot build one); second operator approves; end it once admission there is available again. With a recorded loss, the window start is computed by placement (the earlier-of rule) |
| RB-5 | Automatic 2 + 2 in progress | Watch class progress (system, admission within minutes; others within hours); confirm R3 reserved capacity in use; confirm no range needs 4 of 4; escalate if admission is not done in 10 min |
| RB-6 | Restore a region, end a disaster, fail back | Wipe and rejoin as new nodes; revert zone configurations in class order; watch up-replication; Kafka reassignment and `min.insync.replicas` 3; probes pass in the region; **end** declared and approved by two network-operations operators; after 30 min stable, order failback (T4) |
| RB-7 | Fibre cut (one or both N–M paths, or a Kenya–J path) | Confirm network failover; for both N–M paths: priority-one with carriers; do not declare (counts against availability); consider T4 to R2 only if R2 reaches R3 better and the cut will last hours |
| RB-8 | Clock alarm (ladder A and above, A-T2, A-T3) | Identify drained nodes and dropped hosts; check GNSS status, holdover, the NTP servers, R3's NTP paths; if region-wide, confirm T3; if the cluster drifts against external references, decide with the business whether to stop admission; review `δ_x_meas` by state; on a leap-second announcement, re-check `chrony` configuration everywhere |
| RB-9 | Archive lag or failure | Identify the failing store; confirm two of three accept; watch the database's tail growth against the 24 h buffer; never truncate below the two-region rule |
| RB-10 | Logical corruption, restore or replay | Identify affected kinds and the faulty release; choose replay from the log or a point-in-time restore of projections into a side database; compare digests; promote the corrected code; owner appends corrective entries per its RFC |
| RB-11 | Hot partition or range | Confirm automatic move to a dedicated slot; check the range's load and splits; if a dedicated slot is saturated, page the owner RFC's team (RFC-001's measured ceiling) |
| RB-12 | Probe failures and probing faults | Separate measurement faults (runner, probe account headroom, a slot probed short, probe link) from service faults (one region's edge, a slot); a `PROBING_FAULT` episode names the short slots, their probe counts and locations: check the runners' skip counters and the location's health first; if only one region's probes fail, investigate its edge and anycast, not leases |
| RB-13 | Release | Never pause changefeeds (a drain re-plans them; the closure-lag page is raised to 60 s meanwhile, §3.5); drain one facility's leases, hand off its slots, upgrade, compare canary digests, proceed; automatic halt on mismatch, crash loop or probe failure; roll back; replay if an apply was faulty (RB-10) |
| RB-14 | Decision record unavailable at a deadline (P2-S104); request pending at deadline (P2-S53) | Identify the slot and its ranges; confirm the takeover or range-lease move; confirm holds released within `release_grace`; report the affected requests |
| RB-15 | Kafka cluster loss, or the active KRaft controller outside the preferred region | If the controller is in R3 or the other region and placement's automatic controlled restart has not moved it within 2 min, restart that controller process by hand (Apache Kafka has no resignation API; R27-20), and under a Kenyan link cut stop R2's controllers so R1's and R3's elect; confirm owners still commit; restore brokers; recreate changefeeds from the oldest consumer resolved timestamp; confirm consumers filled gaps from the logs; confirm webhooks resumed |
| RB-16 | Changefeed paused or lagging; closure lag | Inspect the error; resume or recreate with `cursor` through break-glass only (RFC-005); confirm every relay instance's progress and the closure emitter's `R_min` advance (§5.3); a single `cdc` partition without progress holds the whole kind's closure back |
| RB-18 | A record found altered or missing by audit (RFC-005 §9.3) | Confirm the owner stopped deciding for the partition; break-glass with two approvers for the restore role; restore rows at or below the watermark from sealed segments and above it from backups' revision history at the last verified point; rebuild projections by replay; audit re-verifies; owner resumes; incident report to compliance (§14.3) |
| RB-19 | Metro split | Confirm the owners' pools use R2's gateways; confirm consolidation to one facility (§7.3): preferences written, the cut-off facility's database nodes drained through an R2 node, slots handed off or expired, its edges out of load balancing; Kafka `min.insync.replicas` 2; repair; undrain and restore the region's lease preference by order after 30 min stable |
| RB-20 | A failing slot-minute (D6) | Identify the slot's holder, ranges and probe account; check the probe account's headroom and the probe link; take over or move the slot (handoff) if its holder is stuck (an ambiguous handoff resolves itself, §4.2); record the cause in the monthly report |
| RB-21 | Account slot-count doubling (§7.1) | Confirm the new probe accounts' credit limits `applied`; publish the doubled version; watch splits (`split_parallelism`), `Moving` durations and the move cut-over alarm; pause the splitting on any page; done when every old slot is split |
| RB-22 | Both regions' canaries failing, or anycast withdrawn | Confirm the last announcing region stayed announced (§2); find the common cause (takeover gap, database); after recovery confirm re-announce after 10 s of passing canaries |
| RB-17 | Vendor escalation | Open a priority case with the database vendor under the support contract; collect debug zips; never apply an unreviewed cluster setting change in production |

### 22. Verification

#### 22.1 The R1 spike (RFC-000 R1)

On the real three sites, before RFC-001, RFC-002 and RFC-004 are approved, a CockroachDB
cluster at 2 + 2 + 1 with this RFC's zone configurations, NestJS account and link owners on
the owner runtime, status readers, the outbox and a Kafka cluster:

| Measurement | Exit criterion |
|---|---|
| RTT matrix (RFC-000 §3) with each fibre path alone | Within the estimates ± 25%; else RFC-000's budget is redone |
| Each Kenyan region's RTT to R3 | Fixes the default preferred region (R2-D7) |
| Zone configurations as applied | `SHOW ZONE CONFIGURATIONS` and every range's replicas match §3.2 exactly |
| Two-region commit p50, p99, p99.9 of the batch transaction, at the hottest-link rate, in every topology state | Within RFC-000 §3 |
| Single-link booking p99 at the edge, steady and degraded, batching waits included | About 176 ms from R1, 196 ms at the R2 probe (RFC-000 §3, R23) |
| **Account step p99, batching wait included, at the design load** (RFC-000 R23) | ≤ 50 ms; otherwise the second account lane is turned on before go-live (§4.3) |
| **Share of admission and wallet probes with no correct answer within `slot_probe_limit` (1 s)**, per location, at the design load (§10.2, RK28; AI6-7) | ≤ 5×10⁻⁴; otherwise the cause (errors, runner faults) is fixed before go-live |
| Share of admission probes answered after 200 ms; edge process pause distribution and the `pending` timer's slack (R27-25) | Within X2-S15's budget (R23); edge pauses p99.9 ≤ 50 ms |
| **Per-transaction database cost** at about 1.1 partitions per batch (§19.2) | Within the estimate ± 25%; otherwise the slot count is re-chosen (RK28) |
| `δ_x` p99.9 per topology state; report-position delay | `δ_x` p99.9 ≤ 320 ms in the worst state (§6.4) |
| Clock offsets with NTP from the facility GNSS servers, in holdover, and R3 over NTP from Kenya | Every Kenyan host below 5 ms at p99.9 (else PTP is added, §6.1); R3 below 20 ms |
| Product features the design relies on: row-level security for the truncation policy and the restore role; `ttl_disable_changefeed_replication`; `with_min_timestamp` in bounded-staleness reads; `SET LOCAL statement_timeout` before the commit; `PRIORITY HIGH` pushes; hash-sharded keys; **the client-side retry protocol keeping intents across a restart, counted apart from aborts** (§4.3, R33-17); **CDC-query changefeeds emitting delete events** (§3.5); `cockroach node drain` of a node through another node (§7.3); Kafka **controlled controller restart** moving leadership without fencing brokers (§5.2); Cloud EKM in `africa-south1` for the backup key | Each works as §3, §4, §5, §7.3, §13.2 and §14.1 assume; fallbacks as stated there |
| Renewal across expiry (R6-01): a renewal delayed past `session_ttl` while a standby acquires | The renewal fails every time (revocation) |
| Owner takeover (process kill, host kill), with expiry seen by the present-time poll | p99 ≤ 5 s (AI3-9); expected about 3.3 to 3.8 s |
| **Kafka broker kill** and facility loss: produce stall; in-sync flapping under the design load with 4 s timeouts (R27-06) | Stall p99 ≤ 4 s; no flapping that stalls produce more than once an hour |
| R2's fetch stalled for 15 s on the Nairobi–Mombasa paths, not a cut (R33-10, V-4) | Produce resumes within 7 s of the stall's start (in-sync-driven `min.insync.replicas` 2) |
| Changefeed CPU of about 40 changefeeds (outbox and narrow audit) at the design load (R27-13) | Within 180 vCPU per facility ± 25%; else nodes are added |
| Closure emitter lag (§5.3) | `R_min` p99 ≤ 3 s behind now |
| Range-lease failover (database node kill) | p99 ≤ 6 s |
| Killing the leaseholder of an `owner_session`, `owner_slot` and `platform_timing` shard (R6-03) | No process exits; no slot re-acquired cold; no unavailable minute |
| Region-wide failover of about 23,600 slots and every range lease (T1 by isolating R1; T4 by preference swap and drain) | Every admission slot served from R2 within 30 s at p99 |
| Automatic 2 + 2 of every range with R1 isolated (not killed) | No two majorities; admission ranges fault-tolerant within 10 min; all within 4 h |
| Changefeed lag, relay lag, direct-publish lag | Changefeed p99 ≤ 2 s; direct publish p99 ≤ 50 ms |
| A hot link moved at 2,500 requests/s with pre-warm (§4.5) | `Moving` p99 ≤ 200 ms; no deadline missed |
| Attribution path takeover `O`, lag `L`, catch-up `k` (§10.3) | `O` ≤ 5 s at p99 |
| Transactions pushed by the closed timestamp (§3.4) | Below 0.01% |
| Node.js pauses per process class (§4.7) | p99.9 ≤ 50 ms |
| Account-owner process at 1,640 transactions a second (§19.2, R33-05) | Event-loop delay p99.9 ≤ 50 ms; else 128 slots per process |
| Active SQL connections per node after a facility loss (about 420, §19.2) | Within the release's limits with p99 commit unchanged |
| Kafka brokers and KRaft controllers at 12,000 partition replicas per broker (§19.2, after a doubling) | Produce p99 and controller failover unchanged within 25%; else 8 brokers per facility (RK36) |

#### 22.2 Failure injection (X2-S09, X2-S10, X2-S12)

Before production on the pre-production cell, and then regularly:

| Scope | Where and how often | Check |
|---|---|---|
| Database node kill (including the leaseholders of session, slot and timing shards), disk stall, clock skew, packet loss; owner process and host kill; event-loop stalls | Production weekly, one at a time; pre-production daily | Every fact acknowledged before the failure is present after (a checker writes facts of each X2-S09 kind and verifies them); RTO by probes |
| Facility isolation; metro split (§7.3); Kenyan link cut; Kafka broker kill | Facility isolation in production quarterly; metro split and link cut in pre-production monthly; broker kill in production weekly | Same, and RTO ≤ 1 min for admission and ingestion; metro split: no admission slot unserved for more than 30 s, cut-off leaseholders drained within 60 s; R2 withdrawn on a link cut; Kafka `min.insync.replicas` 2; broker kill: produce stall ≤ 4 s |
| Both regions' canaries failing (forced canary failure in both, a takeover gap under T1) | Pre-production monthly | The last announcing region is never withdrawn; re-announce after 10 s of passing canaries |
| Account slot-count doubling under the design load; hot-link move at load | Pre-production quarterly | No probe-coverage gap; every slot probed throughout; `Moving` within bound; no `pending` after a report |
| Region isolation, automatic 2 + 2, declared disaster | Pre-production quarterly; production only as a planned T4 switch, monthly | X2-S12 (no fact lost), X2-S10 region rows, 2 + 2 safety with the "lost" region alive but isolated (V-07) |
| Lease and fencing safety | Continuous in CI: a Jepsen-style harness against the owner runtime on a real CockroachDB cluster with partitions, clock skew within and beyond 100 ms, process pauses longer than `session_ttl`, renewals delayed across expiry, session-range unavailability, `Ambiguous` commits, crashes during acquisition, handoff (including a lost connection after the handoff's commit), re-home, resume and moves; a holder killed between commit and publish under a lagging relay instance; a **TLA+ model of the owner-lease protocol** (sessions with revocation and lapsed renewal **as a resume**, re-home after rule 3 during a lapse (the report-position floor), slot epochs, epoch-conditional writes under serialisability with timestamp pushes, handoff, re-home, read leases granted inside the lease, the post-acquisition reporting wait, the report position, rule 3 during a lapse, partition moves with generations, the report fence and readers' rule 4 for moved partitions, takeover republish, the relay's progress and the closure emitter), required before any owner RFC is approved (reviews 20 and 27) | No two holders with valid leases acting; no renewal serialised after an acquisition; no entry committed by a deposed holder after its successor's acquisition; no reader answering `pending` after a report or after a rule-3 answer, across expiry, handoff, resume and moves; no reported entry lost or contradicted; no gap or duplicate applied by a consumer; no consumer receiving a row at or below a closure marker it has received |

#### 22.3 Design-level acceptance tests

Each cites the scenario it serves (docs/README.md conventions).

| Test | Serves |
|---|---|
| DT-01 A batch is acknowledged only after commit; killing any two voters after the acknowledgement loses nothing | X2-S14, X2-S09 |
| DT-02 Isolating R1 entirely: every entry acknowledged before is present on the R2 + R2 + R3 majority, and admission is back within 1 min | X2-S12, X2-S10 |
| DT-03 A holder whose session has expired by its own monotonic view proposes nothing, answers no headroom query and grants no read lease | X2-S21 (and POL-05 via RFC-001) |
| DT-04 A holder paused past its session's expiry, then resumed, commits nothing after its successor's acquisition (the epoch read fails) | X2-S09 (and POL-05 via RFC-001) |
| DT-05 A new holder neither reports nor calls `onAcquire` before its catch-up, and reports nothing for `read_lease` + ε after its acquisition commit, after an expiry takeover, a **handoff** and a re-home alike; no read lease is granted that ends after the granter's lease view; a handing-off holder grants none after the handoff | P2-S108, P2-S10, P2-S111 (with RFC-002) |
| DT-06 The report position never passes an entry that is not committed or that a leased reader has not applied | P2-S10, P2-S99 (with RFC-002) |
| DT-07 Rule 3's consistent read answers "no holder" only when the holder's session has expired by the database's clock | P2-S111 (with RFC-002) |
| DT-08 `ts` is strictly increasing per partition across holders and partition moves, and never at or below a closed timestamp; a reconciliation read at `T` is a consistent cut | P4-S90, P4-S104 (with RFC-004) |
| DT-09 An owner host whose offset bound exceeds 50 ms gives up its session within 3 s; a database node over 40 ms has its leases drained | X2-S06, P2-S93 (with RFC-002) |
| DT-10 Raising `δ_x_cfg` writes a new `platform_timing` version; a confirm whose `ts` is at or after `D − τ` under the new version is refused | P2-S93 (with RFC-002) |
| DT-11 The 2 + 2 change with the "lost" region alive but isolated never yields two majorities and never needs four of four | X2-S23, X2-S12 |
| DT-12 A moved partition's old slot refuses every command after `moved`; the new slot's first entry continues `seq` and every stream sequence from the unmoved head row, with generation + 1; a receiver that has seen (g, 57) accepts (g + 1, 3) and refuses (g, 56); consumers apply the moved partition's events in stream order | X2-S09 (and POL-05 via RFC-001) |
| DT-13 Every outbox row reaches its topic if the holder dies between commit and publish; a consumer applies each event once in `stream_seq` order and fills a gap from the outbox by its gap-fill role or from history; a forged copy with the same `stream_seq` makes the database copy win and blocks the stream (C01 CP-9) | P2-S09, X2-S02 |
| DT-14 Losing Kafka entirely loses no fact; after restoration every consumer reaches the same state as without the loss | X2-S12, X2-S02 |
| DT-15 A minute with 10 of 12 probes succeeding is unavailable; 11 of 12, available; with probes from one location only, unavailable | X2-S16 |
| DT-16 Every account slot receives at least 3 admission and 3 wallet probes a minute from at least two locations in each region, 20 s apart, also with one location down; a slot probed short raises a `PROBING_FAULT`; every slot has exactly one probe account, and a re-slotting that would break that is refused | X2-S27 |
| DT-30 With 99% of a minute's probes succeeding: slot 17's 3 probes from two locations with no correct answer within 1 s make it unavailable for that capability and page; 3 probes answered correctly in 400 ms leave it available (and count as failures for the 90% rule only); 2 of 3 failing leaves it available; **only 2 probes, both failing, make it unavailable**; **no probe at all for slot 17** (every other slot probed as required) leaves it available and raises a `PROBING_FAULT`; 11 probes from one location make it unavailable | X2-S30 |
| DT-46 **Probing faults** (X2-S33; C01 CP-14): in one minute, slot 17 gets (a) no probe, (b) 2 probes from two locations, both correct, (c) 3 probes from one location, all correct: in each case one `PROBING_FAULT` episode for (region, minute) lists slot 17 with its probe count and locations, `warning`, routed to network operations, and the minute stays available; slot 17 short for 5 consecutive minutes, or 2% of slots short in one minute, raises the episode as `page`; a runner forced to skip scheduled probes above 10⁻⁴ pages | X2-S33 |
| DT-31 Measured failing minutes 10:00 to 10:05 and a loss recorded at 10:06: the window starts at 10:00; with 10:03 to 10:05 only, at 10:06 | X2-S31 |
| DT-32 A run 10:00 to 10:04 in which 10:02 had 12 probes from two locations with 3 succeeding is declared from 10:00; with 8 probes, or 12 from one location, the declaration is refused and 10:02 counts as unavailable | X2-S32 |
| DT-33 A renewal held in flight across its session's expiry while a standby acquires never succeeds; the old holder's view ends and it grants no read lease; killing the leaseholder of the session shard of 50 processes makes none of them exit or reload cold | X2-S09, X2-S10, P2-S108 |
| DT-34 A restarted status reader with a fresh lease answers `pending` only from a read served at or after `P_grant`; a replica behind `P_grant` makes it answer by rule 4 | P2-S108 (with RFC-002) |
| DT-35 A metro split: owners reach far-side leaseholders through R2's gateways within about 3 s with no owner change (per-tier timeouts), no admission slot is unserved for more than 30 s, the cut-off facility's leaseholders are drained within 60 s, and **no Kafka partition is led in the cut-off facility after 30 s**; a Kenyan link cut withdraws R2's anycast and lowers Kafka `min.insync.replicas` to 2 | X2-S10, X2-S12 |
| DT-36 **Resume and re-home** (R27-01, R33-01): a holder's batch X in slot 3 decides q; the holder pauses past its session's expiry while X commits; a reader answers q "confirmed" by rule 3; (a) the holder renews (not revoked); (b) a standby takes its sibling slot 7, the renewal finds the session revoked and the holder re-homes slot 3; (c) a standby takes slot 3 by expiry. In each case no reader leased afterwards, including one restarted with no pushed state, answers q `pending`, and no read lease is granted with `P_grant` below the resume, resolution or catch-up read | P2-S111, P2-S108 (with RFC-002) |
| DT-37 **Moves fence readers** (R27-02; C01 CP-5): with request q of account X pending at a move from slot A to B, after B decides and reports q no reader of A or B answers q `pending`; a reader of A that applied `moved` answers X by rule 4; `adopt` does not commit before `owner_slot(kind, A).report_through` passes `moved`; no entry of X commits in B before `adopt`; A's holder killed after `moved`: its successor pushes its first marker to B, and B adopts within `read_lease` + ε + one commit; after a move and a takeover of B, a decision committed before the move still fails `rowAbsent` | P2-S108, P2-S10 (with RFC-002) |
| DT-38 **Closure** (R27-03): kill a holder between commit and publish while one relay instance lags; no consumer of the lifecycle or link schedule feed receives a row at or below a resolved or `CLOSED` marker it has already received; `CLOSED(t, feed_seq)` carries the last `feed_seq` committed at or below `t` | X2-S13, X2-S22 (with RFC-001, RFC-003) |
| DT-39 Kill a Kafka broker, then a facility's brokers: produce stalls at most 4 s; no X2-S22 or X2-S17 minute breaches | X2-S22, X2-S17 |
| DT-40 Force both regions' canaries to fail: neither region withdraws; after one region recovers, the other is withdrawn only while a majority of the probe sites it reaches report the recovered one passing; with every probe site unreachable, neither withdraws; **a double Nairobi–Mombasa cut withdraws R2, and an R1 isolated from R2 and R3 withdraws R1** once the probe sites see the other region passing; a withdrawn region re-announces after 10 s of passing canaries; **while a recovered region has not yet re-announced, the other region does not withdraw** (V-1) | X2-S01, X2-S10 |
| DT-41 Double the account slot count under the design load: every account keeps its slot until moved; every slot, old and new, has exactly one probe account and its 3 probes a minute throughout; no command is refused other than with `Moving` or `Moved`; **a moved account's commands are served by its new slot between its `adopt` and its old slot's split version, with no `Moved` ping-pong; an upper-half account created while its slot is splitting is created in the new slot and served**; a creation in flight at `ackSplitting` is either listed or refused `MOVED(s + n)`; no ordinary account routes to `s + n` before the `2n` version, F9 applies before the limit, and the limit is `applied` before publication (C01 CP-10) | X2-S27, X2-S03 |
| DT-42 Move a hot link at 2,500 requests/s: unavailable (`Moving`) for at most about 100 ms (p99 ≤ 200 ms), no cold rebuild, its deadline timers fire on the new slot (`onAdopt`) and not on the old (`onMovedOut`); a takeover of the new slot right after is warm | X2-S10 (and P1-S54, P1-S62 via RFC-001) |
| DT-43 Lose the connection after the commit of a handoff: within one present-time read, exactly one of the old holder and the successor serves the slot | X2-S10 |
| DT-44 A capacity-decrease batch that meets a 40001 retries on the same transaction and keeps its intents (RFC-001 T-12); a declared-deletable projection row is deleted in a batch, and a DELETE on any other projection or a log table fails the conformance job; every log row's `chain` matches RFC-005's recomputation, also after a retried batch | X2-S09, X1-S15 (with RFC-001, RFC-005) |
| DT-45 An audit `Stop` on a partition (C01 CP-6, C08 C-10, C-11): `StopAck` arrives only after the fence transaction commits; no entry of the partition commits with `ts` > `enforced_at`, under the current holder, after a takeover **with placement down**, across a move (both slots fenced) and for a `headDecides` account (both `s` and `s + n`); placement can update only `stops_version`; resume is refused on a head mismatch without an incident decision; the restore role cannot write a partition that is not stopped (log and head; also the table owner, FORCE), nor after `Resume`; a head-chain mismatch holds the partition locally and sends `integrity_report`, and only audit's stop and resume follow | X1-S15 (with RFC-005) |
| DT-17 A probe account cannot book a non-probe link and a buyer cannot book a probe link; probe bookings and records produce no charge line, settlement, supplier-report or quarantine-report entry; each probe account's credit hold is real and never invoiced | X2-S20, X2-S24 |
| DT-18 A declaration by one network-operations operator has no effect until a second approves; a declaration by another role is refused and recorded; the end likewise | X2-S25 |
| DT-19 A disaster window starts at the recorded loss whatever the declaration states, and a recorded loss never declared counts in full | X2-S26, X2-S28 |
| DT-20 Percentiles are computed per calendar month per serving region, leaving out disaster windows | X2-S05, X2-S06, X2-S07, X2-S15 |
| DT-21 A sealed segment cannot be overwritten or deleted inside its retention lock, in any store; a chain mismatch is detected the same day; the truncator never deletes a row not yet two-region archived, and a delete above audit's watermark is refused by the database even in a manual session; an altered row found by audit is restored from sealed segments (RB-18) | X2-S11, X1-S15 |
| DT-22 Records, movements, payment events and reservation changes back-dated 7 years less one day are returned unchanged from the cold tier, for every format version | X2-S11 |
| DT-23 A webhook delivery survives a notifier holder failover without loss, is retried with backoff for 24 h, and carries the same `webhook-id` and event IDs on every attempt of one notice set; a regrouped retry has a new `webhook-id`; a notice is "told" once in the notice list and the first delivery carrying it is attempted; no delivery carries two tenants' notices; the endpoint is chosen from the event's clear partition only; each attempt has a fresh timestamp and HMAC computed by the delivery worker; a pinned-address connection whose certificate does not match the URL's host, or a DNS rebinding to a private address, is refused (C08 C-12) | P2-S09, P1-S75, X1-S11, X1-S24 |
| DT-47 **Outcome webhooks and suppliers' webhooks** (P2-S09, X1-S11, X1-S24 as amended in `requirements-v1.11`): a booking and a **change**, each answered `pending`, each get exactly one outcome webhook (by `answered_pending` or the first covering marker's `pendingAnswered`), also when the markers arrive out of order and after a holder takeover (the first marker lists every covered outcome); a withheld termination sends nothing; a maintenance booking of supplier `s1` cut at a reduction's effect is sent only to `s1`'s endpoint, carries nothing about `s2` or any account, and verifies with the secret Share gave `s1` | P2-S09, X1-S11, X1-S24 |
| DT-48 **Affected notices on time** (C03 CT-6.1): `AFFECTED_NOTICE` is first attempted within 35 s of its feed publish with the endpoint down; `AFFECTED_CHANGED` alone sends nothing; a restoration notice goes to exactly the reservations with an earlier `AFFECTED_NOTICE` for the outage; with the link's schedule owner failing over, every such notice is told within `affected_notice_time` + `release_grace` | P1-S26, P1-S40, P1-S75 |
| DT-49 **Restore of the personal-data store** (C09 test 29): the fence is set outside `pds` before the restore; `reapply` reads the feed itself from `from_as_of` − `max_offset` through the head read after the fence; an erasure committed but not yet relayed when the restore starts is re-applied, part by part; `expiry_destroyed` is re-applied from the feed; `reapply` on an unfenced store is refused; the AS OF time reaches identity before the fence is removed | X1-S39, P3-S71 (with RFC-005) |
| DT-23b 10,000 affected notices to one endpoint are all first attempted within 60 s, in deliveries of at most 100: alive (about 1 s), refusing connections (about 13 s), accepting and never answering (about 32 s); first attempts keep 16 in flight whatever the retry lane's state; a delivery's first attempt starts without waiting for its predecessor's to finish | P1-S75, P1-S26 |
| DT-24 An alert raised in an owner's log reaches the alert service after the alert service's holder is killed | P2-S53 |
| DT-25 No personal data appears in any log table, outbox row, Kafka message, archive segment, checkpoint, backup of an owner table or application log (scanner over samples of each); an erased subject's data is unreadable in the live store at once; store backups have no revision history, carry every contained generation, hold no key, and are deleted at 7 days and within 24 h of a contained generation's destruction; the daily erasure-conformance check pages on any left; no changefeed exists on the store | X1-S34, X1-S37, X1-S39, P3-S71 (with RFC-005) |
| DT-26 With no recorded loss of R1, admission a measured failing minute in R1 in every minute 10:00 to 10:04: a declaration at 10:20 approved by a second operator excludes from 10:00 until its end, for availability and latency; with 10:00 to 10:03 only, it is refused and recorded; naming 10:01 as first minute when 10:00 also failed is refused; with a loss of R1 recorded at 10:06 after that run, the declaration names the loss and counts from 10:00 (DT-31); an open disaster over a region available for 30 min pages | X2-S29 |
| DT-27 A slot batch carrying partitions p and q, with q's condition failing, commits p only; an `Ambiguous` batch reloads both; a deposed holder's batch commits neither | X2-S09, X2-S14 (and POL-05 via RFC-001) |
| DT-28 Killing a hot link's holder: the in-region hot standby serves within 5 s with no reload from the log beyond the last pushed batch; isolating the region: the cross-region hot standby likewise | X2-S10 (and P1-S54, P1-S62 via RFC-001) |
| DT-29 An outcome on an idle account slot is followed within `marker_max_wait` + commit by a marker covering it, in the same Kafka partition; the notifier never delivers above a marker; the markers of each slot form a chain across takeovers and `adopt` (each `prevReportPosition` the previous `report_through` of the slot, null only for the first; chunks above 5,000 ids) (C01 CP-7a) | P2-S09 (with RFC-002) |

## Benefits

Figures marked "est." are estimates (to be replaced by the R1 spike and the load test).

| Target | How this design meets it |
|---|---|
| RPO 0 on node, rack, zone and region loss, and during a declared disaster (X2-N4, X2-S09, S12, S14, S23) | One acknowledgement path, at commit by a database majority that by placement spans two regions; feeds are outbox rows of the same commit; after a sustained loss the automatic 2 + 2 keeps two-region commits and tolerates one further fault, declared or not |
| Admission RTO 1 min on node or zone loss (X2-S10) | About 3.3 to 3.8 s for an owner loss (expiry seen by a present-time poll), about 3 s at worst for a metro split (R2 gateway fallback, per-tier timeouts), 4 to 9 s for a database node loss (est.): hot standbys in the other facility, range-lease failover by the database; control rows sharded and lapsed sessions renewed warm, so no single database node can expire the platform (R6-03) |
| Region RTO 1 h (X2-S10) | Region-wide failover of every range lease and slot in about 6 to 13 s for admission and under 20 s for everything (est.), against a 30 s design target; nothing is rebuilt |
| Availability 99.99% (X2-S01, X2-S30) | Owner and database node losses cost no unavailable minute, a facility loss at most one (est.); upgrades cost none (leases drained, slots handed off); probes measure each region on its own path and every account slot 3 times a minute, so **a slot down for more than about 40 s is now seen by the figure** (`requirements-v1.8`) and pages at its first minute (R6-30, D6); the probe-tail condition (§10.2) keeps random probe failures to about 0.1 minute a month |
| Charge timeliness and attribution lag, 99.99% of minutes (X2-S13, S22) | Hot standbys tailing within about 1.5 s take over in about 4 to 5 s: no breaching minute (est.) |
| Confirm fence and deadlines (POL-26, P2-S93) | `τ` = 420 ms in every state (cap 450 ms, then the deadline lane), configured from the worst case with batching waits; `τ` is a row read in the confirm transaction, so it moves earlier the moment measured `δ_x` grows; GNSS-disciplined NTP keeps offsets far below the 40 ms alarm and the 80 ms self-termination |
| Single writer across failures (POL-05) | Sessions revoked on acquisition, slot epochs, every write conditional on the epoch under serialisable isolation, `moved`/`adopt` with generations, stream sequences on every feed event |
| Auditable measurement (X2-N1, X2-S25 … S33) | Every probe result and monthly figure kept and recomputable; too few probes of a capability never count as available and are never evidence; a stuck slot cannot hide behind a short probe count, and a slot probed short is a probing fault that network operations sees in its first minute, never lost availability by itself; disaster windows start at a loss the system recorded or at an earlier run of measured failing minutes leading up to it, or at the first minute of such a run with no loss, computed by placement, and need two network-operations operators |
| Retention 7 years (X2-S11, POL-19, X1-S15) | Write-once, two copies with two providers in two regions (plus a Kenyan hot copy for 13 months), hash-chained, encrypted columnar archive; truncation bounded by the database itself; format corpus; quarterly retrieval at the retention edge; backups for point-in-time recovery of current state |
| Design load (X2-S03, S04) | About 235,000 transactions/s (about 1.70 M statements/s) plus about 40 changefeeds on 36 database nodes of 96 vCPU per facility, each facility able to hold every lease at about 69% CPU (est.); account slots added by doubling with lazy moves, without re-partitioning |
| Personal data erasable within `erasure_max`, payloads expired by `dispute_window` + 7 days (A11, X1-N11, X1-S39, P3-S71) | No platform store but the personal-data store holds personal data; its backups are apart, 7 days old at most, without revision history, generation-tagged, never holding a key, and checked daily, so every copy becomes unreadable with RFC-005's key destructions |
| A platform the team can build and run (RFC-000 RK10; R6-14) | No consensus code of Share's own: an off-the-shelf database and Kafka under a TypeScript runtime, one language with the rest of Share's stack; no PTP fabric or rubidium by default; the 7-year archive in two managed object stores rather than petabytes of on-premises Ceph. The staffing it needs is stated below |

**Staffing and on-call** (R6-14; est.). The estate is about 440 running machines (database
144 Kenyan + 24 R3, owner hosts 128, status readers 16, Kafka 24 + 5 controllers, edges 32,
workers 48, time servers 8, Ceph about 24) plus two cloud object stores. The code is the
owner runtime (sessions, batches, standbys, read leases, outbox), placement, the sealer and
truncator, the notifier, alerting, probes and measurement, the clock monitor and loss
recorders: an estimated 25,000 to 40,000 lines of TypeScript, not "a few thousand".

| Role | People before go-live | Steady state | Vendor support used |
|---|---|---|---|
| Platform engineering (owner runtime, placement, history, notifier, probes) | 4 | 4 to 5 | — |
| Database and Kafka SRE | 2 | 3 | CockroachDB enterprise 24 × 7 (a go-live condition, §3.1); a Kafka support subscription with 24 × 7 cover |
| Network and facilities (fibre, BGP and anycast, racks, GNSS) | 2 | 3 | Carriers' NOCs; facility operators |
| Storage (Ceph, cloud object stores, backups) | shared with SRE | 1 | A Ceph support contract; GCP and AWS support |
| Security officers for HSM ceremonies (RFC-005) | 2 named, part-time | 2 named, part-time | HSM vendor |
| **24 × 7 on-call** (decision D5, R27-14) | Rotation formed 3 months before go-live | **One primary platform rotation** of at least **6** engineers (one week in six), drawn from platform engineering, SRE, network and storage, taking first response for the database, Kafka, the runtime and the network (runbooks §21 written for a generalist first responder); **secondary escalation** by specialty: network and carriers, database and Kafka, storage; vendor 24 × 7 cover behind each; the RFC-005 security rotation separately | Vendor escalation within 1 h (RB-17) |

That is about 8 to 10 engineers before go-live and about **12 rostered engineers in steady
state** (4 to 5 + 3 + 3 + 1), of whom at least 6 are in the primary rotation, plus 2
part-time HSM officers. **About 12 rostered engineers with the primary rotation staffed at
6 is a go-live condition** (§20.1), beside the database licence and support, the fibre and
the facility inventory. For an 11-person company that is the whole company, so the design
needs Share at the upper part of its 11 to 50 range by go-live (about a quarter of a 50-person
company); the vendor 24 × 7 contracts (database, Kafka, Ceph, cloud) carry the depth a
small rotation cannot. The comparison stands against RFC-000's rejection of the Go platform
at "at least four" for the platform alone: the same order of people, but none of them
writing consensus code.

## Competition

| Alternative | Why it loses |
|---|---|
| **A custom multi-group Raft platform** (this RFC's revision 1: `etcd-io/raft` embedded in a Go partition host, about 5,000 groups, four extensions: non-campaigning R3 voters, leadership and read leases, the report position and lease-status query, the own-term-entry guard) | **Rejected** (RFC-000 revision 4, the coordinator's decision on RK10). Technically sound, and it gave finer control: a 10 ms clock bound instead of 100 ms (so `τ` 200 ms in every state instead of 260 ms), R3 voters forbidden to lead, election priorities per class, Raft pipelining instead of one transaction in flight per partition, about 5 ms less per commit, and a rule-3 check that read a majority's positions instead of waiting for a range lease. But a company of **11 to 50 people** would have had to build, prove (TLA+, fault injection) and operate at 99.99% a consensus platform hosting every owner, with its own write-ahead log, snapshots, membership changes, lease timing, placement, archive path and on-call, staffed by a platform team of at least four before go-live; it put **Go** under owners in a **TypeScript** stack, so two runtimes, toolchains and hiring profiles; and every operating burden (5,000 groups, coalesced heartbeats, staggered elections) was Share's alone, with no vendor to escalate to. RK10 named this as the risk; the database gives the same quorum, placement, leases and closed timestamps as a supported product. What is given up changes margins and latency, stated in §4, §6.4 and RFC-000 §3, never a guarantee |
| **Build Raft in TypeScript** | No production-grade multi-group Raft exists for Node.js; writing one is a multi-year correctness risk, worse than the rejected Go platform |
| **YugabyteDB instead of CockroachDB** | **Retained alternative** (RFC-000 §5.5), not rejected. Tablets with Raft per tablet, placement 2 + 2 + 1 by placement policies, preferred leader zones in R1 then R2, read replicas for status reads, bounded-staleness follower reads, a maximum clock skew set to 100 ms. Differences this RFC would change: no closed timestamp exposed in the same form, so the effective-time closure, reconciliation cuts and the sealer's cut use the CDC stream's checkpoints and safe times; CDC through its change-data-capture connector into Kafka instead of changefeeds; per-facility replica placement and the standing R3 non-voter expressed as placement blocks and read replicas; its YSQL layer is closer to Postgres. Chosen against only because CockroachDB's closed and resolved timestamps, non-voting replicas and native changefeeds map onto RFC-000 §4.5 and §4.6 directly; kept if the spike or licence terms rule CockroachDB out |
| **Managed globally distributed databases** (Google Cloud Spanner, Amazon Aurora DSQL, Azure Cosmos DB, the managed CockroachDB or YugabyteDB services) | **Not available in-region.** None runs in Share's Nairobi or Mombasa data centres or in any Kenyan cloud region (there is none); the nearest regions are Johannesburg and Cape Town. Every commit would then be in South Africa, the serving regions would hold no voter, a South African region loss would be a total outage, and RPO 0 "durable in two regions" would mean two South African regions. Spanner's TrueTime would give a tighter clock bound, but only inside Google's regions. Aurora Global Database and similar replicate asynchronously across regions (RPO above 0) |
| **TiDB** | Placement rules can express 2 + 2 + 1 with leader preference, Raft per region, learners and stale reads, and TiCDC feeds Kafka. It speaks the MySQL protocol, not Postgres, which Share's TypeScript stack and RFC-000 assume; it splits SQL, storage and placement into three services (TiDB, TiKV, PD) to operate; and it offers nothing CockroachDB lacks for this design |
| **Postgres with synchronous quorum replication** (a primary per shard, Patroni-style failover) | RFC-000 Competition: failover safety rests on an external lease manager and fencing scripts, and sharding and rebalancing are Share's to build |
| **The database's multi-region SQL abstractions** (`PRIMARY REGION`, `SURVIVE REGION FAILURE`, regional tables) | They place voters by region and cannot state one voter per facility or the non-voter layout of §3.2; using them would mean overriding their zone configurations table by table, which the database discourages and which a later abstraction change could silently undo. Explicit zone configurations with a conformance check say exactly what RFC-000 §5.1 requires |
| **Regional-by-row tables** (each account's rows homed in a chosen region) | Useful when writers live in several regions; here every range lease and slot is in one region by design (AI-3), so homing rows elsewhere would only split owners from leaseholders |
| **One owner-lease row per slot with its own expiry** (RFC-000 §5.2 read literally) | About 47,000 two-region renewal writes a second for about 23,600 slots at a 500 ms renewal. Sessions renew once per process; slot rows change only on acquisition, handoff and re-home (AI6-1) |
| **Renewals stamped with `cluster_logical_timestamp()`** instead of revocation (review 20's alternative for R6-01) | Forbids the push, so a renewal in flight across an acquisition fails as a retry; but it also makes every renewal under contention or a closed-timestamp push fail, and it does not let a lapsed but untaken session resume, which R6-03's fix needs. Revocation is one write per acquisition and gives both |
| **Exit on any failed renewal** (revision 3) | One database node holding the session range expired every session and restarted every process cold (R6-03). Renewing unless revoked, and re-homing, keep warm state |
| **Handoff passing the live reader set** (review 20's alternative for R6-02) | The successor would need every reader's acknowledgement; the fixed `read_lease` + ε wait costs 0.5 s of reporting only after an owner change and needs no state transfer |
| **`global_reads` (non-blocking) ranges for `owner_slot` and `platform_timing`** | Local reads at every replica, but every write (an acquisition, a `τ` change) waits out the clock bound in the future, adding hundreds of milliseconds to takeovers, and it relies on a product feature for the fence; sharding to 64 ranges gives the same failure isolation with ordinary ranges |
| **Fewer account slots with the second lane on from day one** (RFC-000 R24) | About half the account transactions (§19.2) for a similar wait, but every account slot then runs two lanes and their interaction from go-live; kept as the spike's fallback, as decided |
| **Redpanda** (allowed by RFC-000) | Raft per partition needs a majority of replicas; without a broker in R3 (AI5-3) a Kenyan region loss leaves 2 of 4 and stops every partition (§5.1, AI6-2) |
| **Kafka as the system of record**, or Kafka transactions for the relay | RFC-000 Competition for the first; for the second, exactly-once relay transactions would still leave the direct publish and the takeover republish as duplicates, so consumers deduplicate by sequence anyway |
| **Owner publishes only, no changefeed** | Then an owner dying between commit and publish would leave an event unpublished until the takeover republish, and a lost Kafka could not be replayed from a resolved timestamp; the changefeed is the guaranteed path and the source of the resolved timestamps the lifecycle closure needs |
| **A polling relay instead of changefeeds** (a job scanning outbox tables by follower read) | Viable and kept as the fallback if changefeeds misbehave at scale (RK20), but it must compute its own "nothing more at or below T", which the changefeed's resolved timestamp gives as a product |
| **Postgres logical replication or Debezium for CDC** | The database's changefeeds are its supported CDC; a Postgres replication-slot interface is not the path its vendor supports for this |
| **Changefeed aggregators pinned to one region** | The guaranteed path would stop with that region, exactly when owners are failing over; unpinned aggregators in R3 carry only ciphertext (§3.5) |
| **Waiting for a declaration before the 2 + 2 change** (revision 1) | Leaves every range without fault tolerance between loss and declaration, and for the whole of a fibre isolation, which is never declared (AI-2) |
| **Bootstrapping the second R3 voter on demand for admission tables** | Admission would then take an hour or more to tolerate the next fault; the standing non-voter costs one R3 copy of the admission tables and makes it minutes (§8.1) |
| **A per-state `τ`** (revision 1's presets in a timing epoch) | It would let `τ` fall to about 205 ms in steady state, but must jump to the worst case the moment a region is lost, before measurement catches up; one configured worst-case `τ` (420 ms) is simpler and costs only a request's last few hundred milliseconds of commit time |
| **A smaller `max_offset`** (for example 20 ms) | Would move the fence about 80 ms later, but a PTP or GNSS fault in one facility would then make its nodes self-terminate at 16 ms; the coordinator chose 100 ms with an alarm ladder that pages at 40 ms |
| **Google's leap-smeared time in R3** | Mixing smeared and unsmeared clocks would put up to 0.5 s between R3 and Kenya around a leap second, beyond `max_offset`; R3 takes Kenyan time and every node slews identically (§6.1) |
| **Two-write degraded fast path** (RFC-000 R13) | With the degraded batching waits it would be about 290 ms, no longer within 200 ms, and it costs the single decision point a resolution step (§8.5) |
| **Ceph erasure-coded across a metro's two facilities** (revision 3) | At least 6 of 11 chunks sit in one facility, so losing it loses the copy; Ceph's stretch mode needs replicated pools and a tie-breaker site (R6-13) |
| **A Ceph cluster per Kenyan facility with RGW multisite, for every archive copy** | Durable and Kenyan, but about 3 × 7 to 10 PB of on-premises storage over 7 years, operated by a small team; the archive holds only ciphertext and no personal data (A11), so nothing requires it in Kenya unless legal says so (POL-24, RK30) |
| **Managed object storage of a second provider in South Africa** (S3 `af-south-1`) | **Adopted** (D5): two providers, two regions, write-once locks, no hardware |
| **PTP and rubidium in every facility** (revision 3) | Microsecond time buys nothing a 100 ms `ε` and a 20 ms first alarm use; costs a timing fabric and NIC choices. **NTP from facility GNSS servers adopted**, PTP only if the spike shows offsets above 5 ms (§6.1) |
| **Transit between the Kenyan regions through Johannesburg** | GCP does not transit between interconnect attachments by default, carrier transit would add about 1 GB/s to a 10 Gbps Johannesburg path, and the case is two independent cuts; R2 unserved during it is the stated cost (§11, R6-11) |
| **A pre-built replacement site** | A third Kenyan facility set and its fibre to end disasters sooner; latency during a disaster is not a target (§8.5) |
| **The archive as the only backup** (revision 1) | The archive holds every log write-once, but rebuilding the database's current state (heads, projections, indexes) from 7 years of logs would take days; point-in-time backups restore it in hours (§14) |
| **Server-side availability from logs** instead of external probes | POL-06 requires probes from outside the region; server logs miss failures in front of the servers |
| **Missing probes counted as available** (or the minute skipped) | Would make a probe-estate failure look like uptime (§17.3) |
| **One probe account** (revision 1) | Measured admission through one account slot only (RQ-C, now decided) |
| **Probe accounts chosen by identifiers that hash to their slot** (revision 3) | Cannot land in an override slot, and a second routing source could disagree with the account owner's; placement's slot map is the single source (R6-08, B-AI-10) |
| **One webhook per notice** (revision 3) | A 10,000-notice burst to one endpoint at 4 in flight takes minutes, past `affected_notice_time` (R6-15); batches of up to 100 are allowed by `requirements-v1.8` (D4) |
| **A message broker's redelivery for the notifier's retries** | Retries for 24 h need per-delivery state and per-endpoint isolation; delivery entries in the notifier's own log are durable and idempotent, and Kafka carries only the tasks |
| **DNS-only failover** for clients | Minutes of TTL and resolver caching; anycast from Share's own network converges in seconds, with DNS as the fallback |
| **Closure by changefeed `key_column`** (review 27's option (a): key the changefeed by the producing partition and map `cdc` partitions to destination partitions, one relay instance per destination) | Fewer moving parts if it works, but it depends on how `key_column` combines with ordering and `resolved` in the deployed release (it requires the `unordered` option in current releases) and pins the relay's scaling to a static partition map. The closure emitter (§5.3) is sound under any changefeed partitioning and any relay rebalancing; kept as an optimisation if the spike shows `key_column` with `resolved` works |
| **Resume detected by the database clock** (the renewal returning the old `expires_at`) | The renewal's `now()` can be below its commit timestamp after a push, so "not expired at `now()`" does not prove that no rule-3 read saw the session expired; the holder's own view, which ends `ε` before any such read is possible, is the exact conservative test and needs no SQL change (§4.2) |
| **A `read_lease` + ε wait on a resume** | Not needed (the resuming holder's own leases ended with its view) and would add 0.5 s of reporting delay after every session-range lease move |
| **Adaptive first-attempt concurrency** (revision 4) | On a dead endpoint it halves to 1 or 2 in flight and a burst is not told within 60 s (R27-08); the fixed 16-slot lane bounds the load on a failing endpoint instead (D4) |
| **Two six-person on-call rotations** (revision 4) | Needs 12 people on rotation, more than network and facilities have; one primary rotation of 6 with specialist escalation and vendor cover is staffable (D5) |
| **Full-row audit changefeeds** | About 220 MB/s more through Kafka and about 440 MB/s more on Nairobi–Mombasa; the narrow projection sees every SQL-level change and full recomputation happens at sealing (RFC-005); kept as the fallback (§3.5) |
| **Checkpoints written to both regions** (revision 4) | 0.2 to 0.4 GB/s on Nairobi–Mombasa for state each region's standby can checkpoint itself (§12.11) |
| **Moves only at low load** (revision 4) | The trigger of a hot-link move is load; pre-warm and the report fence bound `Moving` to about 100 ms at load (D6) |
| **Raising the account slot count to an arbitrary value** (revision 4) | Changes `hash mod count` for most accounts at once, re-routing them before their head rows move; doubling with lazy splits moves about half of each slot's accounts, one slot at a time, with routing changed only after the moves (D7) |
| **Metro split by consolidation alone** (revision 4) | Lease transfers between the two sides fail, the cut-off side's leaders keep their majority, and owners on the chosen side cannot reach them: an outage until an operator acts (R27-04). The R2 gateway fallback (D1) keeps every leaseholder reachable at about +10 ms |
| **Fully automatic failback** | A flapping region would make every lease and slot flap; failback costs nothing to delay (§7.5) |

## Risks and open issues

| # | Risk or issue | Mitigation or next step |
|---|---|---|
| RK1 | **The owner runtime is where single-writer bugs would hide**: sessions, revocation, lapsed renewal and re-home, epochs and generations, handoff, ambiguous commits, read leases, the report position, takeover republish (review 20 found three) | TLA+ model of the owner-lease protocol with every interleaving of §22.2 and a Jepsen-style harness against a real cluster in CI, **required before any owner RFC is approved**; keep the runtime small; review by someone outside the team |
| RK2 | **The go-live fibre condition may not be procurable**, notably a Nairobi–Johannesburg path not via Mombasa, now also at 40 Gbps between Nairobi and Mombasa | Start procurement now; production does not start without it (§20); if impossible, raise against RFC-000 before production |
| RK3 | **Facility inventory** (RFC-000 R2): fewer than two independent facilities, or fewer than three power-separated racks, in a metro | Part of the go-live gate (§20.4) |
| RK4 | **GNSS jamming or spoofing** in the region | Two vendors per facility, OCXO holdover (24 h page), cross-region and external references, the alarm ladder; a spoofed region is gated and fails over (§6) |
| RK5 | *(Resolved.)* Zero fault tolerance between a region loss and its declaration | The 2 + 2 change is automatic after `region_detect` + 10 min (§8.1; RFC-000 AI-2) |
| RK6 | **Bandwidth and storage are estimates**, and this substrate needs about four times revision 1's Nairobi–Mombasa bandwidth | Measured in the spike and the load test; the 40 Gbps rule leaves about 6 × headroom over the estimate |
| RK7 | *(Resolved by RQ-C and B-AI-10.)* One probe account measured one partition | One probe account per account slot, from the slot map (§17.1) |
| RK8 | **R3 capacity during a regional event**: on-demand GCP capacity in `africa-south1` is not assured | Reserved capacity for the second voter set; standing non-voters for admission (§8.1) |
| RK9 | **Seven-year readability** of formats, schemas and keys | Format corpus in CI, schema registry, versioned decoders, key retention by RFC-005 (§13.5) |
| RK10 | *(Closed.)* Team size and skills for a custom consensus platform | Substrate changed by RFC-000 revision 4; Competition |
| RK11 | **Correlated loss of both Kenyan regions** (shared country, grid, some fibre; RFC-000 R2) | Outside X2-N4. R3's voters, the GCS archive and GCS backups remain; recovery would lose commits not yet on R3. Stated, not designed for; the quarterly full restore from GCS (§14.2) times it |
| RK12 | **Webhook load unknown** (R10) | Provisional 20,000/s (§15); measured once buyers integrate |
| RK13 | **`δ_x` tail in the degraded state**: about 300 ms at p99 with waits; at p99.9 the worst state may exceed 320 ms | A-T2 raises `τ` up to its 450 ms cap, then the deadline lane (§6.4); the spike measures p99.9 |
| RK14 | **Gray failures that probes do not catch** (a reader or node) | Internal canaries in every slot, reader and relay (§18.5) |
| RK15 | **The database is a product Share does not control** (RFC-000 R18): closed-timestamp behaviour, lease failover time, changefeed scale, per-transaction cost, upgrade regressions | Enterprise licence and support as go-live conditions; the spike measures each figure; YugabyteDB retained; one facility at a time upgrades with canary digests; no unreviewed setting changes (RB-17) |
| RK16 | **Range-lease failover may exceed the hot-standby budget**: a database node loss under the rating path's ranges could cost a breaching minute (§10.3) | Spike exit criterion p99 ≤ 6 s; the budget absorbs about four such events a month meanwhile |
| RK17 | **Node.js pauses** (garbage collection, blocking) under owners | Loop-delay self-fencing, worker threads for heavy work, measured pauses per process class (§4.7) |
| RK18 | **Fault tolerance after the 2 + 2 change takes hours for non-admission tables** (snapshot volume) | Standing non-voters for admission; delegated snapshots inside R3; snapshot rate raised; stated as a known cost in RFC-000 revision 4.1 (AI6-4) |
| RK19 | **Degraded latency in undeclared states** (double Nairobi–Mombasa cut, an isolated region before its 2 + 2 or never declared) counts against the targets | The go-live condition; RB-7; the second account lane narrows it; the two-write path no longer helps (§8.5) |
| RK20 | **Changefeeds at scale**: about 40 changefeeds (20 outbox, 20 narrow audit) over thousands of ranges, R3-planned aggregators, resolved-timestamp lag, about 180 vCPU per facility (est.) | The spike measures lag and CPU (§22.1); the polling relay is the fallback (Competition); the direct publish and gap fill make changefeed lag cost latency, not facts; closure lag pages at 10 s (§16) |
| RK21 | **A drift of the whole cluster** is invisible to the database's own checks | External references and the cluster level of the ladder (§6.2, §6.3); safety does not depend on it (A8) |
| RK22 | **Live database growth from 7-year payment reference bindings** (about 22 TB per copy at year 7) | Sized for (§19.4); RFC-004 may move bindings older than 13 months to a history index |
| RK23 | **Ciphertext limits database compression**: payloads compressed by owners entry by entry compress worse than columnar storage would | Accounted for in §19; the archive decrypts and re-encrypts with columnar compression (§13.2) |
| RK24 | *(Resolved by `requirements-v1.7`.)* Erasure completion through backups took up to 35 days | `erasure_max` = 30 days (RQ6-1 decided); generation-tagged store backups deleted with their generation (§14.4). RFC-005's own arithmetic (44 days in its revision 2) must come within 30 days |
| RK25 | *(Mostly resolved by `requirements-v1.8`.)* A disaster declared on probe evidence could hide a measurement fault | Only measured failing minutes are evidence (§8.2); remaining: an open disaster over a healthy region pages after 30 min and is listed monthly (§8.3) |
| RK26 | **Batching waits on every admission step** (RFC-000 R23): about 196 ms p99 at the R2 probe, about 4 ms margin on X2-S15 | Spike exit criterion: account step p99 ≤ 50 ms with the wait; else the second account lane (about 166 ms); the deadline lane beyond the `τ` cap (§4.3, §6.4, §22.1) |
| RK27 | **Refused-template payloads in the personal-data store** may be far more than its designed size if exporters misconfigure templates | Sized at 0.01% of records (est., about 8 TB per copy, §14.4); expiry at `dispute_window` + 7 days; a page when refusals exceed 0.01% of an exporter's records over an hour, and storage alarms at 50% of the store's allotment; at 10 × the estimate the store would need about 80 TB per copy, but its allotment is capped at 40 TB per copy (`not kept(cap)` at 90%, §14.4), about 200 TB over five voters and 40 TB per Kenyan facility, about 7% of a facility's 553 TB of NVMe (§19.4) |
| RK28 | **More slots cost database CPU, and the slot rule still turns probe errors into unavailable minutes** (RFC-000 R24 as restated in revision 4.3, AI6-7): with 3 probes a slot, a share `p` of probes with no correct answer within `slot_probe_limit` (1 s) costs about `16,384 p³` minutes per minute, about 0.7 a month at `p` = 10⁻³. Since `requirements-v1.9` that is the error rate, not the 200 ms tail. And 16,384 account slots about double the database's CPU (§19.2) | Spike exit criteria: `p` ≤ 5×10⁻⁴ per location and the per-transaction cost within 25% (§22.1); probes of one slot 20 s apart; probes never on hot links; if the CPU criterion fails, fewer account slots with the second lane on, as RFC-000 R24 allows |
| RK29 | **Kafka controller outside R1 at a Kenyan link cut** fences R1's brokers and stops every feed (facts continue) | Placement keeps the active controller in the preferred region by a controlled restart of a misplaced controller (there is no resignation API, R27-20; §5.2); RB-15 |
| RK30 | **Legal may require a Kenyan cold copy** of the archive (POL-24) | The Kenyan hot copy's lock and capacity extend to 7 years (about 15 PB raw at 4 + 2 by year 7) and the cloud copies stay; decided when legal confirms |
| RK31 | **Staffing**: about 12 rostered engineers to run the platform 24 × 7 (Benefits), the whole of an 11-person company and about a quarter of a 50-person one | A **go-live condition** (§20.1, D5): one primary rotation of at least 6, specialist escalation, vendor 24 × 7 cover for the database, Kafka, Ceph and the clouds; no PTP, no on-premises cold archive; re-assessed at go-live |
| RK32 | **The closure emitter is on the path of every feed's closure** (§5.3): a stalled relay instance or one `cdc` partition without progress holds a whole kind's closure, and with it rating's minute closing (X2-S13) | One slot per kind with hot standbys; closure lag pages at 10 s; markers idempotent; consumers keep their own 3 to 5 s planning budget; the spike measures `R_min` lag |
| RK33 | **Kafka in-sync churn with 4 s timeouts** (D2): a GC pause or a load spike on a broker can drop it from in-sync sets and back | Facts are in the database; the spike measures flapping under load (§22.1) and tunes the heartbeat; `min.insync.replicas` keeps writes two-region |
| RK35 | **The anycast arbiter is outside Share's network** (review 33 D1): probe sites that are themselves partitioned or compromised could withhold or fake a verdict | Verdicts signed and mutually authenticated; a majority of reachable sites needed; with none reachable a region never withdraws (fail closed); every withdrawal pages |
| RK34 | **Moves and doublings add protocol** (pre-warm, report fence, `onAdopt`, lazy splits, the splitting handshake `ackSplitting` and `listPartitions`, the stop fence `stops_version`) to the part of the runtime where single-writer bugs hide (RK1) | In the TLA+ model and the Jepsen harness (§22.2); C01's provider tests CP-1 … CP-14 in CI; DT-37, DT-41, DT-42, DT-45 |
| RK36 | **Kafka partitions per broker** after an account slot doubling: about 11,700 replicas per broker (est., §19.2), above common operating practice | Growing a topic's count is optional and done only when its produce rate needs it; the spike measures 12,000 replicas per broker; more brokers (8 per facility) is the lever |
| RK37 | **The v1.10 slot rule counts a short-probed slot whose few probes all fail** (§10.2): a probe estate that skips scheduled probes makes the rule weaker against probe errors (`p²` or `p` instead of `p³` for those slots) | Runners never skip a scheduled probe for load; every skip is a `PROBING_FAULT`; a skip rate above 10⁻⁴ per location pages; at that rate the extra risk is about 5×10⁻⁹ unavailable minutes a minute (§10.2) |

## Requirements issues

**Resolved in `requirements-v1.6`** ([review 11](../reviews/11-requirements-amendments-from-detailed-rfcs.md)),
applied since revision 2:

| # | Issue | Decision in `requirements-v1.6` | Applied in |
|---|---|---|---|
| RQ-A | Who may declare a region disaster | Network operations declares, and ends, with reason and evidence; a second network-operations operator approves (POL-06, POL-32; X2-S25, X1-S31; glossary *Declared region disaster*) | §8.2, §7.1 (`disasters`), RB-4, RB-6, DT-18 |
| RQ-B | When a disaster starts for measurement | From the loss as the system recorded it, not the declaration; a loss never declared counts against every target (POL-06; X2-S26, X2-S28, X2-S23 amended) | §8.3, §18.4, DT-19 |
| RQ-C | One probe account; no probe supplier | Several designated probe accounts spread so every part of admission and the wallet serving accounts is probed, plus a designated probe supplier owning the probe links (POL-06; X2-S20, X2-S24, X2-S27) | §17.1, §17.4, DT-16, DT-17; "part" confirmed as account slot by RQ6-2 in `requirements-v1.7` |
| RQ-D | Window of the p99 targets | Every percentile per calendar month and per serving region (POL-06; X2-S05, S06, S07, S15) | §18.1, DT-20 |
| RQ-E | "Told" when the endpoint is down | Told once recorded in the account's notice list and first delivery attempted within the time, then retried for `webhook_retry` (POL-04; P1-S75; glossary *Told*) | §15, §18.2, DT-23 |
| RQ-F | The fibre condition was weaker than the design's | Four paths pairwise without shared risk: two Nairobi–Mombasa, one from each serving region to Johannesburg not via the other (POL-06; X2 constraints; glossary *Serving region*) | §20.1 |

**Resolved in `requirements-v1.7`** ([review 12](../reviews/12-requirements-amendments-from-rfc-revision-2.md)),
applied in revision 3:

| # | Issue (revision 2) | Decision in `requirements-v1.7` | Applied in |
|---|---|---|---|
| RQ6-1 | How soon an erasure must be complete, backups included | `erasure_max` = 30 days from the request, in every copy (live store, backups, escrow); one compliance operator executes (POL-19, POL-32; X1-N11, X1-S39). RFC-006's 35-day reading was not adopted | §14.4 (store backups apart, generation-tagged, deleted within 24 h of the generation's destruction; daily check), §14.1 (scope), §19.4, DT-25, RK24 |
| RQ6-2 | What "every part of admission and the wallet that serves accounts" is | Every account slot, each probed by at least one probe account every minute (POL-06; X2-S27 retitled) | §17.1 (as designed), §17.3, DT-16 |
| RQ6-3 | A reachable but unusable region has no recorded loss | It may be declared on probe evidence, admission not available there for `disaster_probe_minutes` (5) consecutive minutes, counted from the first of them (POL-06, POL-32; X2-S29). RFC-006's reading (only an unreachable or gated region) was not adopted | §7.1, §8.2, §8.3, §18.4, RB-4, DT-26 |

**Resolved in `requirements-v1.8`** ([review 22](../reviews/22-requirements-amendments-from-c3-reviews.md)),
applied in revision 4:

| # | Issue | Decision in `requirements-v1.8` | Applied in |
|---|---|---|---|
| RQ6-4 (revision 3) | A run of minutes unavailable only for lack of probes could be probe evidence | Only a **measured failing minute** (at least 12 probes from two locations, under 90% succeeding) is evidence; an unmeasured minute is unavailable, not evidence, and breaks a run (POL-06; X2-N1; X2-S29 amended, X2-S32) — review 20's D1 | §8.2, §17.3 (classification), §18.4, RB-4, DT-26, DT-32; RK25 |
| RQ6-5 (revision 3) | Probe evidence followed by a recorded loss counted from the loss | From the **earlier** of the recorded loss and the start of an unbroken run of at least `disaster_probe_minutes` measured failing minutes leading up to it (POL-06; X2-S31) — review 20's D2 | §8.2 (basis table), §8.3, §18.4, DT-31 |
| RQ-R6-1 (review 20) | The 90% rule could not see a partial outage of one account slot | A minute of admission or the wallet is also unavailable when one slot had a **measured failing slot-minute** (at least 3 probes from two locations, all failed); every slot probed at least 3 times a minute from two locations (POL-06; X2-S27 amended, X2-S30) | §17.1 (schedule), §17.3, §10.2, Benefits, DT-16, DT-30; RK28 |
| RQ-R6-2 (review 20) | "Told" for many notices in one delivery | A notice carried in a delivery is first attempted when the delivery is (POL-04, P1-N8, glossary *Told*) — review 20's D4 | §15, §18.2, DT-23, DT-23b |

**Resolved in `requirements-v1.9`** ([review 28](../reviews/28-requirements-amendments-from-c3-round-2.md)),
applied in revision 5:

| # | Issue | Decision in `requirements-v1.9` | Applied in |
|---|---|---|---|
| RQ-R6-3 (review 27) | The slot rule turned the probe latency tail into unavailability | For the slot rule only, a probe fails if it got no correct answer within `slot_probe_limit` (1 s); 200 ms stays for the 90% rule and the latency targets (POL-06; X2-N1; X2-S30 amended) | §17.2, §17.3 (probes scored twice), §10.2, §22.1, DT-30, RK28 |

Also read in `requirements-v1.9`: POL-07 and P1-N8 (maintenance outside the committed rate,
cut at a reduction's effect, its supplier told: §15's supplier notices); POL-19, P3-N7 and
P3-S71 (a payload may be dropped beyond the caps, counted and reported: §14.4, §3.5, §16;
P3-S75 is RFC-003's); POL-32 (the held recovery: no platform change).

**Resolved in `requirements-v1.10` and `requirements-v1.11`** ([review 35](../reviews/35-requirements-amendments-before-c4.md),
[review 65](../reviews/65-requirements-amendments-after-c4.md)), applied in revision 7:

| # | Issue (raised in) | Decision | Applied in |
|---|---|---|---|
| X2-S30 slot rule (C01 N1; review 35) | A slot with fewer than 3 probes, all failing, was not evidence, so a stuck slot could hide behind a short probe count | A failing slot-minute is a slot that got at least one probe, every one failing, however few; a slot probed short (none included) is a **probing fault**, alerted to network operations, not unavailability (POL-06; X2-N1; X2-S30 amended; X2-S33 new) | §10.2, §16 (`PROBING_FAULT`), §17.3, §11, §12.10, §19.5, RB-12, DT-30, DT-46, RK37 |
| RQ-39-1 (review 39; C03) | An affected notice during a link schedule owner's failover could miss `affected_notice_time` | Every POL-07 notice timed by `affected_notice_time` is due within `affected_notice_time` + `release_grace` while the link's schedule owner fails over (POL-07, P1-N8; P1-S85 new; review 65 item 6) | §15 timing, DT-48 |
| RQ46-1 (review 46; C08) | Suppliers could not verify webhooks | Every receiver, buyer or supplier, can verify every webhook (X1-N6; X1-S11, X1-S24 outlines with a supplier example) | §15 (endpoints of either tenant, signing, transport checks), DT-23, DT-47 |
| Review 43 RQ-2 (C04 M-01) | Which requests get an outcome webhook | Every request answered `pending`, a change included (P2-S09 reworded) | §15 (request outcome feed row), DT-47 |
| Review 65 item 4 (POL-32) | Four eyes on credit limits | Above `credit_limit_four_eyes_above` (10,000 USD), the probe accounts' limits included | §17.4 rule 4 (probe limits are far below it) |
| RQ41-3 (review 41; C11) | Record identity per format | (exporter, observation domain, counter epoch, position in the export stream) (P3-N3) | §13.3, §17.2 |

Also read in `requirements-v1.11` with no change to RFC-006: POL-19 and X1-N11 (a shared
record erased whole; payout-destination details erased once reconciled; RFC-005's, §14.4
states why the copies RFC-006 keeps are unaffected); POL-24 (`provider_unreceived_alert`,
RFC-004's alert, routed by §16); POL-14, POL-16, POL-29 (owners' rules; the platform
carries them unchanged); P3-N7 (correction deadline, RFC-003's).

**New.** None.

## Architecture issues

**Resolved by RFC-000 revision 4.** AI-1 (monitored quantities instead of the invariant;
`δ_x` at p99.9), AI-2 (automatic 2 + 2 after `region_detect` + 10 min), AI-3 (placement of
every group) and AI-4 (status replicas named), and RK10 (substrate changed), applied here in
§6.5, §8.1, §7.2 and §4.6, and Competition.

**Resolved by RFC-000 revision 4.1** ("Revision 4.1 errata"), each as proposed in revision 2:

| # | Issue (revision 2) | Decision in RFC-000 revision 4.1 | Applied in |
|---|---|---|---|
| AI6-1 | Owner-lease expiry per slot row is too costly to renew | Session rows (one per process, renewed) plus slot rows (holder session, epoch) | §4.2 (as designed), §4.6, §12 |
| AI6-2 | Redpanda cannot survive a Kenyan region loss without a broker in R3 | Apache Kafka (KRaft), replication factor 4, `min.insync.replicas` 3, lowered to 2 by placement | §5.1, §5.2, §5.6 (as designed) |
| AI6-3 | `δ_x` = 160 ms is a p99 figure | `δ_x_cfg` at p99.9; `τ` starts at about 260 ms, up to about 300 ms | §6.4, §6.5, RK13 |
| AI6-4 | Fault tolerance after the automatic 2 + 2 returns in minutes only with a standing R3 non-voter | The admission tables keep a standing R3 non-voter; other tables about 30 min to 3 h (est.), a known cost | §3.2, §8.1, RK18 |
| AI6-5 | R3's clocks are inside the database's clock domain | R3 takes Kenyan time (NTP from Kenyan time servers) | §6.1 |

**Resolved by RFC-000 revision 4.2** ("Revision 4.2 errata"), each as review 20 proposed:

| # | Issue (review 20) | Decision in RFC-000 revision 4.2 | Applied in |
|---|---|---|---|
| AI-R6-1 | A renewal could be serialised after an acquisition | Acquisitions revoke the expired holder session; renewals only on non-revoked sessions | §4.2, §22.1, §22.2, DT-33 |
| AI-R6-2 | Read leases could outlive the owner lease; handoff skipped the wait | Read leases end inside the granter's lease; after any acquisition, `read_lease` + ε before reporting | §4.6, §4.2 (handoff), §4.4, DT-05 |
| AI-R6-3 | The per-slot epoch served as a per-partition order | Per-partition generation; (generation, epoch, sequence); head rows keyed by partition | §3.7, §4.5, §5.4, §5.5, DT-12 |
| AI-R6-4 | Account slots were busy at the design load | Batching waits budgeted; about 16,384 account slots; marker-only transactions outside the lane; the second account lane as fallback | §4.1, §4.3, §4.6, §6.4, §19.2, §22.1 |

**Resolved by RFC-000 revision 4.3** ("Revision 4.3 errata"), each as proposed:

| # | Issue (raised in) | Decision in RFC-000 revision 4.3 | Applied in |
|---|---|---|---|
| AI6-6 (revision 4) | A transaction timeout would apply to `COMMIT` | No transaction timeout on `COMMIT`; idle-in-transaction timeout below the lease margin; batches not at the commit point abandoned | §3.6, §4.3 (as designed) |
| AI6-7 (revision 4) | R24's noise arithmetic predated the measured slot-minute | R24 restated with `16,384 p³` and v1.9's 1 s bound; the 200 ms margin threatens X2-S15 only | §10.2, §22.1, RK28 |
| AI6-8 (revision 4) | Low occupancy is not free | Sized by RFC-006 | §19.2 (now 36 nodes, AI6-10) |
| AI6-9 (revision 4) | Double Nairobi–Mombasa cut needs transit | R2 unserved, edge withdrawn, unless the R2 gateway fallback reaches the leaseholders (which the double cut prevents for R1's) | §11, §19.3, §20.1 (as designed); §4.7 fallback |
| AI-27-1 (review 27, R27-01) | Lapsed renewal and re-home lacked the reporting consequence | A lapsed renewal or a re-home is an acquisition for reporting | §4.2 (resume, resume read), §4.6, §12.2, DT-36 |
| AI-27-2 (review 27, R27-02) | Moves fenced writers, not readers | `adopt` after the old report position passes `moved`; readers by rule 4; `read_lease` + ε after `adopt` | §4.5, §4.6, §12.4, DT-37 |
| AI-27-3 (review 27, R27-03) | Closure was per changefeed partition, not per destination | Per-destination minimum, emitted after the relay published every such row; explicit `feed_seq` state | §3.5, §5.3 (closure emitter), §12.5, DT-38 |

**Resolved by RFC-000 revision 4.4** ("Revision 4.4 errata"), each as proposed in
revisions 5 and 6:

| # | Issue | Decision in RFC-000 revision 4.4 | Applied in |
|---|---|---|---|
| AI6-10 | Marker-only transactions about 30,000/s and about 36 nodes per facility | Estimates restated as proposed | §4.6, §19.2 (as designed) |
| AI6-11 | §8 substrate row lacked the closure emitter, the move hooks and the doubling rule | Added as proposed; now C01 §2.4, §3.3, §3.6, §3.8 | §5.3, §4.5, §7.1 |
| AI-33-1 (R33-04) | The slot map's routing state during a lazy split | Upper-half accounts served by the slot the head row names; splitting and split versions; now C01 §3.8 with `headDecides` answering `slot: s` (R47-29) | §7.1, DT-41 |
| AI-33-2 (R33-01) | The reporting floor after an expiry takeover or a handoff | The first report position after any acquisition is at or above the present-time catch-up read; now C01 §3.1 | §4.6, DT-36 |

**Routed to RFC-006 by RFC-000 revision 4.5** ("Items that are not RFC-000's"), resolved
here:

| # | Issue | Resolution | Applied in |
|---|---|---|---|
| AI-41-5 (review 41) | §5.4's key rule had no exception for `attribution.parts.v1`, and the hand-off name differed from C11's | The exception is stated; C11 adopted `ingestion.handoff.v1` | §5.4 |
| AI-48-3 (review 48) | §14.4 lacked the restore fence outside `pds`, `reapply` reading the feed, the feed topic's `max.message.bytes`, the bucket-key wrap wording and the state-based sweep | Stated as C09 gives them | §14.4, §5.2, DT-49 |

**New.** None. Revision 7 changes no component, owner or principle of RFC-000; every
change is C01's interface detail or a mechanism behind it.

## Contract issues

Defects found in the frozen contracts while conforming to them. No contract is edited
here; each issue gives the reading this RFC adopts meanwhile.

| # | Contract | Issue | Proposed erratum | Reading adopted meanwhile |
|---|---|---|---|---|
| CI6-1 | C08 v1.1 (Transport row; review 46 resolution R46-02) | The Transport row still says the restore role's row-level-security predicate is "over audit's `integrity_stops`", and R46-02 grants SELECT on `audit.integrity_stops` to the restore role. C08's own erratum CC-2 (§K, S-M5) and C01 R47-28 make placement's `placement_integrity_stops` the predicate | In the Transport row, read "over placement's `placement_integrity_stops` (C01)"; mark R46-02's grant superseded by CC-2 | C01 and C08 §K: placement's table; audit's table is the detection record only (§14.3) |
| CI6-2 | C01 v1 §3.6 (settled M7) and C06 v1 topic table | C01 lists six streams that carry closure; C06 marks six more topics "Yes" (`rating.unposted-usage.v1`, `account.usage-applied.v1`, `rating.charge-lines.v1`, `rating.affected-marks.v1`, `rating.quarantine-report.v1`, `rating.breach-report.v1`). C01 §2.2 lets any stream declare closure, so the mechanism does not change, but C01's list reads as complete | C01 §3.6: "Streams carrying closure (M7) **include** …; any stream declared with `closure` gets markers (C06)" | The union: every stream declared with closure gets markers, one relayed owner kind per closure topic (§5.3); sized in §5.3 and §19.3 (est., under 1 MB/s more) |
| CI6-3 | C01 v1 §2.5 (producer ACL) and C06 v1 (`settlement.posting-acks.v1`) | C01's ACL rows are by name pattern (`<kind>.<feed>.v<n>`: the kind's holder and relay). C06's posting-acknowledgement topic has the ledger as producer through its outbox **and** settlement publishing directly, under a name of neither pattern owner. C01 §3.5 says events are published only after `Committed` through `append`; settlement's direct publish is outside that rule | C01 §2.5: "A topic named by an owner contract lists its producers there; direct publishes outside an outbox are allowed only on a topic that carries no closure markers (C06 m10)" | The ACL of that topic lists the ledger's holder and relay and settlement's principal; the topic carries no closure markers (§5.2, §5.3) |
| CI6-4 | C05 v1 ("Gap recovery", consumer obligation to RFC-006) | C05 sizes `account.usage-applied.v1` at "9–18 TB at replication factor 3"; the cluster's replication factor is 4 (RFC-000 AI6-2, §5.2) | "About 3–6 TB per copy, 12–24 TB at the cluster's replication factor 4" | §19.4 sizes 12 to 24 TB (est.), inside the brokers' capacity |

## Traceability

**X2 scenarios (RFC-006 primary).** "Also" names the RFC that specifies the mechanism the
measurement observes.

| Scenario | Approach section | Also |
|---|---|---|
| X2-S01 Availability per capability | §17.3, §10.1, §10.2, §11, §20, §2 (anycast rule), DT-40 | — |
| X2-S16 Available minute, 90% of probes | §17.1, §17.3, DT-15 | — |
| X2-S30 A minute of admission or the wallet unavailable when every probe one account slot got failed, however few, or when not probed as required *(new in v1.8; amended in v1.9: `slot_probe_limit` 1 s; amended in v1.10: however few)* | §17.1 (3 probes per slot, 20 s apart, from three locations), §17.2 (limits), §17.3 (rules 1 to 3, probes scored twice, a probe sent is got), §10.2, §16, DT-30 | RFC-002 (account slots) |
| X2-S33 An account slot probed short in a minute is a probing fault, alerted to network operations *(new in v1.10)* | §17.3 (probing fault, no unavailability by the shortfall alone), §16 (`PROBING_FAULT`, one episode per region and minute, escalation; C01 §3.11, D1), §10.2 (short-probed risk), §11 (probe location lost), RB-12, DT-46, RK37 | — |
| X2-S18 Each capability probed by its own operation and limit | §17.2 | — |
| X2-S20 Probes end to end as designated probe accounts, without business side effects *(amended)* | §17.1, §17.4, DT-17 | RFC-002 (intake rule), RFC-003, RFC-004 (exclusions) |
| X2-S24 Each probe account on a credit limit set by finance, never invoiced *(amended)* | §17.4 (rule 4), §17.1, DT-17 | RFC-004 (credit holds), RFC-005 (finance sets the limit) |
| X2-S27 Enough probe accounts that every account slot is probed, at least 3 times a minute from two locations *(amended in v1.8)* | §17.1, §7.1 (account slot map, one probe account per slot, refusals, doubling with pinned probe accounts, a slot published only once its probe account's limit is applied), §17.3 (probing fault), §12, DT-16, DT-41 | RFC-002 (reads the slot map), RFC-005 (edge routing by the map), RFC-004 (credit limits) |
| X2-S21 Funds holds and headroom checks at admission's targets | §10.1, §4.4, §11, DT-03 | RFC-002, RFC-004 Part A (in the account owner) |
| X2-S02 Ingestion may lag, never loses an accepted record | §9, §5.5, §13.2, DT-13, DT-14 | RFC-003 |
| X2-S03 Admission sustains the design load | §19, §19.5 | RFC-001, RFC-002 |
| X2-S04 Metering keeps up with the design volume | §19, §19.5 | RFC-003 |
| X2-S05 Single-link answer within `ack_budget`, any length *(amended: per month, per region)* | §18.1, §19.5, DT-20 | RFC-001, RFC-002 (path), RFC-000 §3 (budget) |
| X2-S15 Final answer with no capacity in flight *(amended)* | §18.1, §8.5, DT-20 | RFC-001, RFC-002 |
| X2-S06 Route acknowledged within `ack_budget`, outcome by deadline *(amended)* | §18.1, §6.4, §6.5, DT-20 | RFC-002 |
| X2-S07 Top-up credited within 10 s *(amended)* | §18.1, §18.2, DT-20 | RFC-004 |
| X2-S22 Accepted record counted in headroom within `attribution_lag_max` | §10.3, §18.2, §5.2 (4 s broker detection, in-sync-driven drop), §5.3 (closure), §7.3 (Kafka leader consolidation on a metro split), DT-35, DT-38, DT-39 | RFC-003 |
| X2-S17 Standing reaches network operations within `standing_notice_time` | §18.2, §5.2, §5.6, DT-39 | RFC-004 |
| X2-S08 Suspension enforced within 60 s | §18.2 | RFC-004; network operations |
| X2-S13 Charges posted within target and bound | §10.3, §18.3, §5.3 (closure per destination), DT-38 | RFC-003, RFC-004 |
| X2-S19 Disaster minutes excluded, charges within target + 1 h, none lost or doubled | §8, §10.1, §10.3, §18.3, §18.4 | RFC-004 (per-line deduplication) |
| X2-S23 During a disaster, from the recorded loss to its end, latency suspended, deadlines and RPO 0 hold *(amended)* | §8.1, §8.3, §9, §6.4, §6.5, §18.4, DT-11 | RFC-002 (deadlines) |
| X2-S25 A disaster and its end take effect only once declared with evidence and approved by a second operator *(new)* | §8.2, §7.1, RB-4, RB-6, DT-18 | RFC-005 (approvals, refusals audited) |
| X2-S26 A disaster counts from the loss the system recorded *(new)* | §8.3, §18.4, DT-19 | — |
| X2-S28 A loss never declared counts against every target *(new)* | §8.3, §18.4, DT-19 | — |
| X2-S29 A region with no recorded loss may be declared on probe evidence of measured failing minutes, counted from the first *(amended in v1.8)* | §8.2 (basis), §8.3, §7.1 (`disasters`), §17.3 (classification), §18.4, RB-4, DT-26 | RFC-005 (approvals, four eyes) |
| X2-S31 A declared disaster counts from the earlier of the recorded loss and a run of probe evidence leading up to it *(new in v1.8)* | §8.2 (basis table), §8.3, §7.3 (loss time from evidence), §18.4, DT-31 | — |
| X2-S32 A minute not probed as required is unavailable but is not probe evidence *(new in v1.8)* | §8.2, §17.3 (unmeasured minutes), §18.4, DT-32 | — |
| X2-S09 A fact survives a node or zone loss | §9, §11, §22.2, §4.2 (revocation), §4.3 (slot batches), DT-01, DT-04, DT-12, DT-27, DT-33 | — |
| X2-S12 No fact lost on a region loss | §9, §7.4, §8.1, §11, §22.2, DT-02, DT-11, DT-14 | — |
| X2-S14 Acknowledged only once durable in two regions | §9, §3.2, §4.3, §12, DT-01 | RFC-002, RFC-003, RFC-004 (each acknowledgement) |
| X2-S10 Recovery time per capability and scope | §10.1, §4.4 (incl. link and identity hot standbys, present-time expiry poll, warm renewal and resume), §4.2 (ambiguous handoff), §4.5 (moves), §4.7 (gateway fallback), §3.2 (sharded control rows), §3.3, §7.3 (metro split), §7.4, §11, §22.2, DT-02, DT-28, DT-33, DT-35, DT-40, DT-42, DT-43 | — |
| X2-S11 Retrieval at the end of the retention period | §13, §14.2, DT-21, DT-22 | — |

**Other scenarios to which RFC-006 contributes a contract** (primary RFC named; the scenario
is satisfied there).

| Scenario | RFC-006 contribution | Primary |
|---|---|---|
| P1-S26, P1-S40, P1-S50, P1-S72 Affected and restoration notices within `affected_notice_time` (and, v1.9, a maintenance booking cut told to its supplier, §15) (P1-S40 retitled in v1.7: the flag ends from the first minute boundary at or after the restoration's record) | §15 delivery and timing; the boundary rule is RFC-001's | RFC-001 (flags), RFC-002 (holders) |
| P1-S78 A confirmation that had begun committing is judged by whether the reduction's displacement record is visible to the confirming transaction *(v1.7; cites POL-07 in v1.8)* | §3.7 (the account owner's SELECT on `link_displacement`, serialisable read set, retry when a reduction commits in between), §4.3 (condition reads in the slot batch) | RFC-002 (the read), RFC-001 (the markers) |
| P1-S75 Told: recorded in the notice list and first attempted (a delivery may carry many notices, v1.8) | §15 (batched deliveries, a fixed first-attempt lane of 16, 2 s connect timeout), §18.2, DT-23, DT-23b | RFC-001 |
| P1-S63 A confirmation completed across a reduction is alerted *(Given restated in POL-07 terms in v1.8)* | §15, §16 | RFC-001 |
| P1-S33 Schedule as known at a past time | §13 storage, indexes, `asKnownAt` | RFC-001 |
| P1-S54, P1-S62 Release within `release_grace` while a record or schedule owner fails over | §4.4 takeover in seconds, §10.1 | RFC-001, RFC-002 |
| P2-S04 Whatever fails, never booked on some legs only | §4.2, §4.3, §4.5 (one writer, takeover) | RFC-002 |
| P2-S09 Webhook sent, signed, retried, for each request answered `pending`, a change included *(amended in v1.11)* | §15 (webhook iff `answered_pending` or the first covering marker's `pendingAnswered`; every marker kept), §4.6 (marker chain), §5.3 (per-slot markers, slot-keyed topic), DT-13, DT-23, DT-29, DT-47 | RFC-002 (outcome), RFC-005 (signing format) |
| P2-S10, P2-S99, P2-S107, P2-S108, P2-S111 Status reads, report position | §4.6 report position, read leases, rule-3 check; §4.2 resume; §4.5 report fence and rule 4 for moved partitions; DT-05, DT-06, DT-07, DT-36, DT-37 | RFC-002 (replica rule) |
| P2-S22, P2-S23 Interrupted requests resumed or failed | §4.4 takeover, `onAcquire` | RFC-002 |
| P2-S93 Every hold released at the deadline | §6.4, §6.5 (`δ_x`, `τ`, alarms), DT-09, DT-10 | RFC-002 |
| P2-S104, P2-S106 Decision record unavailable at the deadline | §4.4 (seconds to a new holder), §3.3, §16 alert | RFC-002 |
| P2-S51, P2-S53 Requests in trouble visible; pending at deadline alerted | §16, DT-24 | RFC-002 |
| P3-S31 An accepted record is never altered or removed | §3.7 (insert-only), §13.1, §13.4 | RFC-003 |
| P3-S36 Recomputing a period gives the recorded charges | §13.1 (inputs kept), §13.3 replay | RFC-003 |
| P3-S39 Records retrieved by reservation, link and minute | §13.3 entity indexes | RFC-003 |
| P3-S71 A non-conforming payload kept only in the erasable store, if kept, unrecoverable in every copy by `dispute_window` + 7 days *(amended in v1.8 and v1.9)* | §14.4 (storage, sizing, the 40 TB allotment and drops beyond the caps, backups without keys, 7 days, the store events feed), §3.5 and §16 (drop alert and report to network operations), §19.4, RK27, DT-25 | RFC-003 (refusal, drops), RFC-005 (the store, caps, expiry keys) |
| P4-S23 Buyer told when reservations are released | §15 | RFC-004 |
| P4-S71, P4-S72 Movements trace to facts; past headroom rebuilt | §13.3 replay and projections | RFC-004 |
| P4-S90, P4-S104 Reconciliation at a consistent cut | §3.4 consistent cuts, §3.7 `ts`, DT-08 | RFC-004 |
| P4-S54, P4-S80, P4-S81, P4-S91 Differences and late reconciliation alerted | §16 | RFC-004 |
| X1-S11 Webhook verifiable by a buyer or a supplier *(amended in v1.11)* | §15 (the delivery worker signs each attempt in RFC-005's format, fresh timestamp, `webhook-id`; supplier endpoints), DT-23, DT-47 | RFC-005 |
| X1-S24 Webhook only to its own account's or supplier's endpoint *(amended in v1.11)* | §15 (endpoint from the event's clear partition only, per-tenant queues, one tenant per delivery, transport checks), DT-23, DT-47 | RFC-005 |
| P1-S85 While the link's schedule owner fails over, holders told within `affected_notice_time` + `release_grace` *(new in v1.11)* | §15 (timing: the notifier's 40 s share unchanged), DT-48 | RFC-001 |
| X1-S14, X1-S15 Changes record principal and time; an audit record cannot be altered or removed through the system, and below it is detected and accepted by no reader *(X1-S15 an outline in v1.8)* | §3.7 (`chain`, deletable projections only), §3.5 (narrow audit changefeeds, job control by break-glass), §13.1 (locks per tier), §13.2 (truncation by row-level security), §13.4, §14.3 (restore on detection, integrity stop enforced at the slot fence), §7.1, DT-21, DT-44, DT-45 | RFC-005 |
| X1-S31 Network operations declares a region disaster with four eyes | §8.2, DT-18 | RFC-005 |
| X1-S34, X1-S37 Personal data held apart and erasable; audit keeps the pseudonym | §3.7 (A11), §13.1, §14.4, §15, DT-25 | RFC-005 |
| X1-S39 Erasure on request, by compliance, complete in every copy within `erasure_max` *(new in v1.7)* | §14.4 (every copy RFC-006 keeps, 24 h deletion, daily check), DT-25 | RFC-005 |

## Revision 2 resolution

How RFC-000 revision 4's list of what RFC-006 must change (§5.5) is applied:

| # | RFC-000 §5.5 item | Where in revision 2 |
|---|---|---|
| 1 | Replace the partition host, consensus profile, Raft extensions, snapshots and membership with the database topology, zone configurations, voter and non-voter placement, lease preferences, closed-timestamp and changefeed settings, `max_offset` and clock discipline, log-table schema, the owner-lease protocol and NestJS runtime | §2, §3, §4, §6 |
| 2 | Restate time on `max_offset`: `ε` = 100 ms with GNSS/PTP, the owner hosts' offset check, `δ_x` per topology state at p99.9, the monitored quantities | §6 |
| 3 | Restate placement and the declared disaster: leaseholders and owner leases for every group, triggers through lease preferences, the automatic 2 + 2 | §7, §8 |
| 4 | Restate report positions, read leases and status replicas on follower reads and non-voting replicas, with the replicas named | §3.2, §3.4, §4.6, §12.4 |
| 5 | Add the outbox, changefeeds, Kafka and topic conventions, and webhook delivery | §3.5, §5, §12.5, §15 |
| 6 | Restate the per-minute arithmetic with the 5 s hot-standby takeover | §4.4, §10.3 |
| 7 | Re-cost capacity, bandwidth, storage and node counts; the spike and fault-injection suite for the new substrate, with TLA+ on the owner-lease protocol | §19, §22 |
| 8 | Close RK10 and replace the Competition row on building Raft | Risks (RK10 closed), Competition |
| 9 | Owner-side payload encryption hooks; the personal-data store's backups and key destruction | §3.7, §12.8, §13.2, §14.4 |

Also in revision 2: the `requirements-v1.6` decisions on RQ-A … RQ-F applied (Requirements
issues, Resolved); X2-S25 … X2-S28 covered and the amended X2 scenarios re-traced
(Traceability); revision 1's architecture issues AI-1 … AI-4 closed against RFC-000
revision 4; new issues RQ6-1 … RQ6-3 and AI6-1 … AI6-5 raised; risks RK5, RK7 and RK10
closed and RK15 … RK24 added. Kept from revision 1, re-based on the new substrate: the
probe estate and measurement method (§17, §18), history and the write-once archive (§13),
the notifier (§15), alerting (§16), the fibre verification (§20) and the runbook set (§21).

## Revision 3 resolution

Revision 3 rebases revision 2 on `requirements-v1.7` (`python3 tools/impact.py diff
requirements-v1.6 requirements-v1.7`: for S-PLAT P1-N01, P1-S40, P3-N07, X1-N11, X2-N01,
X2-S27, X2-S29 and POL-05, POL-06, POL-07, POL-14, POL-15, POL-19, POL-24, POL-32) and on
RFC-000 revision 4.1.

| Finding or record | Change in revision 3 |
|---|---|
| RQ6-1 decided (review 12): `erasure_max` 30 days from the request, every copy (X1-N11, X1-S39, POL-19) | §14.4 rewritten: the store backed up apart (Ceph only), generation-tagged, deleted within 24 h of the generation's destruction, daily conformance check; 35-day key-store backups removed; §14.1 scope; DT-25; Benefits; RK24 resolved; RFC-005's arithmetic named as its share |
| RQ6-2 decided: every account slot probed every minute (X2-S27 retitled, X2-N1) | §17.1 cites the decision (design unchanged); traceability retitled |
| RQ6-3 decided: declaration on probe evidence, `disaster_probe_minutes` (X2-S29, X2-N1, POL-06, POL-32) | §7.1 `disasters` basis; §8.2 basis table, refusals, "when", effects; §8.3 window start, end rule, open-over-healthy alert; §18.4; RB-4; §12.10; DT-26; RK25; new RQ6-4, RQ6-5 |
| P1-S40 retitled, P1-N01 and P1-S78 (B-RQ-9, displacement read), POL-07 (every rise in sellable capacity) | Traceability only for P1-S40 (the boundary rule is RFC-001's); §3.7 grant and serialisable read for P1-S78 |
| P3-N07, P3-S71 (RQ3-14: non-conforming payloads in the erasable store) | §14.4 storage and sizing; §19.4 row; RK27 |
| POL-05, POL-14, POL-15, POL-24 amendments | Read; no change to the platform (they bind RFC-001, RFC-003, RFC-004) |
| RFC-000 4.1 AI3-11: one transaction in flight per slot | §4.3 rewritten (slot batch, per-call conditions, size limits, batching wait and lever, crash points); §12.2; §19.2 re-costed (about 70,000 transactions/s); DT-27; RK26 |
| RFC-000 4.1 AI-R1-12: link hot standbys | §4.4 (two hot standbys per link slot, pushed batches); §19.2 owner hosts; DT-28 |
| RFC-000 4.1 B-AI-8: per-slot report markers, slot-keyed outcome topic | §4.6 (markers, `marker_max_wait`, marker-only transactions), §5.3, §5.4 keys, §12.5, §12.10; §19.2; DT-29 |
| RFC-000 4.1 AI-R1-11: the link displacement read | §3.7 grants and read semantics; §4.3 condition reads; §12.2 |
| RFC-000 4.1 AI5-8: truncation below audit's verified watermark | §3.7, §13.2 |
| RFC-000 4.1 AI5-11: store backups never outlive their key generation | §14.4 |
| RFC-000 4.1 AI6-1 … AI6-5 (raised by revision 2) | Architecture issues: resolved, each pointing to RFC-000 revision 4.1's errata; in-text references repointed; RK13, RK18 updated |

## Revision 4 resolution

Revision 4 answers [review 20](../reviews/20-rfc-006-review.md) and rebases on
`requirements-v1.8` (`python3 tools/impact.py diff requirements-v1.7 requirements-v1.8`, for
S-PLAT: P1-N01, P1-S63, P1-S78, P3-N07, P3-S71, X1-N08, X1-N11, X1-S15, X2-N01, X2-S27,
X2-S29, X2-S30, X2-S31, X2-S32; POL-04, POL-06, POL-07, POL-14, POL-16, POL-19, POL-26,
POL-32) and on RFC-000 revision 4.2.

| Finding, issue or record | Change in revision 4 |
|---|---|
| R6-01 (Blocker) renewal serialised after an acquisition | §4.2: `revoked` column; acquisitions revoke in a high-priority transaction; renewal only `NOT revoked`; the R6-01 trace argued; §22.1, §22.2 (TLA+ and Jepsen interleaving), DT-33 |
| R6-02 (Blocker) read leases past the owner lease; handoff | §4.6: grant only if `now + read_lease ≤ untilMonotonic`, none during handoff, `read_lease` + ε reporting wait after every acquisition; §4.2 handoff, §4.4; DT-05 extended |
| R6-03 (Blocker) single-range control tables | §3.2: `owner_session`, `owner_slot`, `platform_timing` sharded (64 / every 64 slots / 64); §4.2 lapsed renewal and re-home; §4.4 failure-scope table (no exit on unavailability), standby grace after the range returns; §10.2, §11 corrected; §22.1, §22.2 leaseholder kills |
| R6-04 reader follower reads below the lease's position | §3.4, §4.6: `with_min_timestamp(P_grant)`, rule 4 otherwise; §12.4 `leasedRead`; DT-34 |
| R6-05 account slots busy | §4.1 16,384 account slots; §4.3 waits, marker-only outside the lane, second account lane as fallback with the 50 ms exit criterion; §22.1 |
| R6-06 capacity arithmetic | §4.1 counts reconciled with RFC-003 §1.1 and RFC-004; §19.2 re-derived (about 215,000 transactions/s, 34 nodes of 96 vCPU per facility); notifier recounted |
| R6-07 log-as-outbox, slot groups, TTL deletes | §3.5 self-outboxed logs (25 h GC, truncation outside the consumer window, deletes dropped); §7.1 `slot_groups`, §4.2, §4.4, §7.4; §3.6 `ttl_disable_changefeed_replication` |
| R6-08 two sources of account routing | §7.1 placement's account slot map (RFC-000 B-AI-10 assigned it to placement, not RFC-002), refusals, overrides; §12.7; §17.1 probe accounts by the map |
| R6-09 epoch as a per-partition fence; moves | §3.7 generation and partition-keyed heads; §4.5 move protocol without deletes; §5.5 stream sequences; DT-12 |
| R6-10 metro split | §7.3 state and consolidation; §11, §20.2, §22.2, RB-19, DT-35 |
| R6-11 double Nairobi–Mombasa cut | §19.3, §20.1 no transit, R2 unserved; §7.3 "Kenyan link cut" lowers `min.insync.replicas`; §5.6, §11; AI6-9 |
| R6-12 `min.insync.replicas` after a facility | §5.2, §5.6: 2 on a facility lost or drained (D3) |
| R6-13 archive tiers | §13.1 locks per tier and class from object creation; §13.2 two cloud copies (GCS, S3) and one Kenyan hot copy (D5); §19.4 re-costed |
| R6-14 operability | Benefits staffing and on-call table; §6.1 NTP by default; Competition rows; RK31 |
| R6-15 notifier bursts | §15 batched deliveries of up to 100 (D4), adaptive concurrency to 16, first attempts outside the breaker; DT-23b |
| R6-16 `Ambiguous` resolution | §4.3 `batch_id` in head rows |
| R6-17 `COMMIT` timeout | §3.6 `COMMIT` exempt (15 s), 1 s idle-in-transaction, runtime abandon before `COMMIT`, reload rate limit; AI6-6 |
| R6-18 2 + 2 zone list | §8.1 full expected set |
| R6-19 2 + 2 and restoration figures | §8.1 class sizes (payments about 22 TB), stopped VMs with disks, start before the change; §8.4 per-copy restoration |
| R6-20 `cdc.*` streams | §19.3 three productions; §5.2 26 h retention |
| R6-21 live-database outbox and truncation garbage | §19.4 (about 11 TB and 1.5 TB) |
| R6-22 arithmetic nits | §4.4 push cost, §10.2 1/48, §10.3 7.3 min |
| R6-23 personal-data store table | §14.4: four Kenyan voters; escrow "none (RFC-005)" |
| R6-24 backup `kms` | §14.1 Cloud KMS with External Key Manager on the Kenyan HSMs; fallback stated (withdrawn in revision 6: no passphrase fallback) |
| R6-25 checkpoint store | §12.11 |
| R6-26 resolved interval | §3.5 note: RFC-003's 3 to 5 s is conservative |
| R6-27 T2 threshold; edge health | §7.4 more than 10% per round in both regions; §2 canary commits |
| R6-28 KRaft controller in R3 | §5.2 resignation; RB-15 |
| R6-29 recorded loss under T1 | §7.3 loss recorders; time from the liveness evidence; §8.3 |
| R6-30 partial outages | `requirements-v1.8` slot rule (§17.3); Benefits restated; first-minute page (D6), RB-20 |
| R6-31 offset check on wall clock | §6.2 `process.hrtime` round trip |
| R6-32 missing alternatives | Competition (per-facility Ceph multisite, second cloud provider, NTP, and others) |
| RQ6-4, RQ6-5, RQ-R6-1, RQ-R6-2 | Resolved by `requirements-v1.8` (review 22); applied as "Requirements issues" states |
| AI-R6-1 … AI-R6-4 | Resolved by RFC-000 revision 4.2; applied as "Architecture issues" states |
| RFC-000 4.2 AI-17-2 per-stream sequences | §3.7 `streams`, §5.4 headers, §5.5, §12.2, §12.5 |
| RFC-000 4.2 AI-17-4 timeouts, high-priority takeover reads | §3.6, §4.2, §4.3, §4.4 |
| RFC-000 4.2 AI-17-5 `δ_x_cfg` and `τ` with waits | §6.4 (320 ms, 420 ms, cap 450 ms, deadline lane), §6.5 A-T3, §12.10 |
| RFC-000 4.2 AI-R5-2, AI-R5-3, AI3-13 | §3.5 no secrets in job definitions, §3.7 column sealing, §14.4 expiry keys never in a backup |
| RFC-000 4.2 R23, R24 | §22.1 exit criteria; §10.2, §19.2, RK26, RK28; AI6-7, AI6-8 |
| v1.8 POL-06 probes (3 per slot, two locations), measured failing minutes and slot-minutes, earlier-of rule | §17.1, §17.3, §8.2, §8.3, §18.4, §10.2; DT-16, DT-26, DT-30 … DT-32 |
| v1.8 POL-04 many notices per delivery | §15 |
| v1.8 POL-19 / P3-S71 payload expiry in every copy; X1-N11 | §14.4 |
| v1.8 X1-S15 / X1-N08 (detected below the system) | §13.2 (database-enforced truncation), §14.3 and RB-18 (restore on audit's finding) |
| v1.8 POL-07, POL-26 / P1-S63, P1-S78 (begun judged by the displacement record) | §3.7 wording; traceability |
| v1.8 POL-14, POL-16, POL-32 | Read: no platform change beyond §15's notices and §8.2's four eyes |
| RFC-005 rev. 3.1 and rev. 4 interface points | §14.4 (7-day backups, every generation tagged, no keys, no changefeed, weekly HSM destructions), §4.4 (identity hot standbys), §13.2 (row-level-security truncation, per-partition watermark), §3.5 (changefeed events to audit), §15 (no mixed tenants; e-mail to a refused non-user requester), §17.1 (at least two probe sites), §14.3 and RB-18 (restore from sealed segments), §12.7 (edge routes by the slot map), §16 (identity freshness alarm) |
| RFC-002 rev. 4 and RFC-004 rev. 4 interface points | §16 alarms (identity freshness 30 s, catalogue cache 60 s, F2 apply lag, late E11); §17.1 probe accounts with KYB passed before the credit limit; 3 probes per slot (about 820/s per region) |
| RFC-001 rev. 4 interface points | §3.5 `CLOSED(t, feed_seq)` on the schedule feed; §3.6 row-level TTL for `link_request` (24 h); §12.11 checkpoint store; §17.1 probe links for about 820 bookings/s per region; §3.7 the confirm retries; §4.4 push-fed standbys, follower-read backstop, no present-time tail reads but a takeover's |

## Revision 5 resolution

Revision 5 answers [review 27](../reviews/27-rfc-006-review.md) and rebases on
`requirements-v1.9` (`python3 tools/impact.py diff requirements-v1.8 requirements-v1.9`, for
S-PLAT: P1-N08, P3-N07, P3-S71, X2-N01, X2-S30; POL-06, POL-07, POL-19, POL-32) and on
RFC-000 revision 4.3, and matches the revision-5 interface updates of RFC-003, RFC-004 and
RFC-005.

| Finding, issue or record | Change in revision 5 |
|---|---|
| R27-01 (Blocker) lapsed resume vs readers | §4.2 resume (a renewal succeeding after the view ended), resume read with `T_res`, in-flight batches resolved, report position set to `T_res`; state table and diagram; §4.4 failure table; §4.6 rule-3 paragraph; §12.2; §22.2 TLA+ and Jepsen; DT-36. AI-27-1 resolved by RFC-000 revision 4.3 |
| R27-02 (Blocker) moves vs readers | §4.5 move protocol table: report fence checked by `adopt` against `report_through` in the old slot's partition `''` head row; readers' rule 4 for moved partitions and adopt-only reads in the new slot; `read_lease` + ε for the adopted partition; §3.7 `report_through`; §4.6; §12.4; DT-37. AI-27-2 resolved |
| R27-03 (Blocker) relay closure | §5.3 relay progress (flush, then progress, then offset) and the closure emitter (minimum over every `cdc` partition; `CLOSED` `feed_seq` from `link_head` as of `t`; heartbeats; crash points; volume); §3.5; §12.5 `onResolved` per destination partition; §16 closure-lag alarm; RB-16; DT-38; RK32; Competition (`key_column`). AI-27-3 resolved |
| R27-04 metro split | §4.7 gateway tiers incl. the other Kenyan region, always on (D1); §7.3 rewritten (reachability, then preference plus drain through an R2 node, handoffs); §10.2, §11, §20.2, §22.2, RB-19, DT-35 |
| R27-05 expiry detection | §4.4 present-time non-locking session poll; takeover time 3.3 to 3.8 s; §7.4 timeline with `standby_grace` and the poll (6 to 13 s); §10.1, §10.3, §11, §19.2 |
| R27-06 Kafka produce stall | §5.2 `replica.lag.time.max.ms` and `broker.session.timeout.ms` 4 s (D2); §5.6, §10.2, §10.3, §11; §22.1 exit criterion; §22.2; DT-39; RK33 |
| R27-07 anycast withdrawal | §2 rule (other region passing; never the last announcing region, D3; re-announce, damping; anycast canary); §11; §16; §18.5; §22.2; RB-22; DT-40 |
| R27-08 notifier first attempts | §15 fixed first-attempt lane of 16, 2 s connect timeout, AIMD for retries only (D4); ordering waits for the predecessor's start; timing; §12.10; DT-23b |
| R27-09 move hooks and pre-warm | §4.5 pre-warm from checkpoint plus push, moves at load (D6), `Moving` bound and alarm; §12.2 `onAdopt`/`onMovedOut`; §12.6; §12.11 pre-warm reads; §11; §22.1; DT-42; RK34 |
| R27-10 slot-count raise | §3.7 `home` = hash mod `home_space`; §7.1 slot rule with split state, doubling only, lazy splits, probe accounts pinned (D7); refusals; §4.1; §12.7; RB-21; DT-41 |
| R27-11 ambiguous handoff | §4.2 crash points: present-time read of `owner_slot` resolves it; RB-20; DT-43 |
| R27-12 consumed contract points | §3.7 DELETE on declared-deletable projections and the conformance set; §4.3 client-side retry on the same transaction (`SAVEPOINT cockroach_restart`), intents kept; `chain` in log and head rows computed by `append` (RFC-005), recomputed on every retry; §12.2; DT-44 |
| R27-13 uncosted streams | §3.5 narrow audit changefeeds (RFC-005 revision 5's projection, deletes included); §12.11 checkpoints within the region; §19.2 changefeed CPU and 36 nodes; §19.3, §19.4; RK20; AI6-10 |
| R27-14 staffing | Benefits: one primary rotation of at least 6, specialist escalation, about 12 rostered engineers (D5); §20.1 go-live condition; RK31 |
| R27-15 free-slot SQL | §4.2 separate `session_id IS NULL` statement |
| R27-16 partition `''` | §4.3 serialised across the lane and marker-only transactions |
| R27-17 marker rate | §4.6 markers due only on `report_wanted` or outcome entries, about 30,000/s; §19.2; AI6-10 |
| R27-18 `P_grant` | §4.6 rounded up to the microsecond, fixed at the start of a continuous lease; committed facts kept across lease changes; new holder pushes its catch-up; §12.4 |
| R27-19 `ε` | §4.2 the view: only the database's pairwise offset enters |
| R27-20 KRaft controller | §5.2 controlled restart (no resignation API); metro split in "Kafka degraded" (§7.3, §5.2); RK29; RB-15 |
| R27-21 loss recorders | §7.1 `loss_observations`; §7.3; recorded loss as the earliest evidence over both tables |
| R27-22 process counts | §4.1 64 account processes (RFC-002 §14), about 200 admission processes; §4.6 2,048 streams and per-process figures; §7.4 |
| R27-23 hot archive | §13.2 CRUSH rule (host domain, at most 2 chunks per rack); deletion blocked until both cloud copies are verified |
| R27-24 republish burst | §4.4 republish from the kind's closure position, rate-limited per process |
| R27-25 probe tail | §10.2 derived with v1.9's 1 s bound (error rate, not latency); §22.1 edge pauses measured |
| R27-26 handoff catch-up | §4.2 successor catches up before serving |
| R27-27 tests | §22.2 rows (broker kill, both-region canaries, doubling, moves at load, resume, handoff loss, relay lag) and DT-36 … DT-45 |
| RQ-R6-3 | Resolved by `requirements-v1.9` (review 28): §17.2, §17.3, §10.2, DT-30, RK28 |
| v1.9 POL-07 / P1-N8 (maintenance cut told to the supplier) | §15 supplier notices; traceability |
| v1.9 POL-19 / P3-N7 / P3-S71 (payload drops) | §14.4 (caps, 40 TB allotment, drops counted), §3.5 `ingest_log` streams, §16 alarm |
| v1.9 POL-32 (held recovery) | Read: no platform change |
| AI6-6 … AI6-9 | Resolved by RFC-000 revision 4.3; "Architecture issues" |
| RFC-000 4.3 B-AI-12 (3 probes a minute from two locations) | §17.1 (as designed) |
| RFC-004 revision 5 interface: probe-account set per map version, publish after `applied` | §7.1, §12.7, §17.1, §17.4 |
| RFC-003 revision 5 interface: three self-outboxed streams of `ingest_log`, drop alert and hourly drop report (with withdrawal counts) to network operations, `withdrawn` rows; the slot group as one acquisition; sealing by follower reads | §3.5, §16, §4.1, §4.2, §13.2 (as designed) |
| RFC-005 revision 5 interface: `chain` (recomputed on retry), DELETE only on declared-deletable projections, narrow audit changefeed with deletes, changefeed job control by break-glass, `integrity_stop` durable across takeovers, restore role confined to stopped partitions, store events feed for the pruner and restores | §3.5, §3.7, §4.3, §12.2, §14.3, §14.4, RB-16, DT-44, DT-45 |

## Revision 6 resolution

Revision 6 answers [review 33](../reviews/33-rfc-006-review.md) (ACCEPT WITH CHANGES) with
its decisions D1 … D4, and two interface points of the accepted RFC-005 revision 5. No
requirement changed (`requirements-v1.9`); RFC-000 stays at revision 4.3, with AI-33-1 and
AI-33-2 pending its revision 4.4.

| Finding, decision or record | Change in revision 6 |
|---|---|
| R33-01 (Major) re-home without a report floor | §4.2 re-home applies the full resume (resolution read, steps 2, 3 and **4**: report position = `T_res`); §4.6 initial report position after any acquisition = the present-time catch-up or resolution read, no `P_grant` below it; DT-36 extended (re-home after a sibling slot is taken; expiry takeover); §22.2 TLA+ property; AI-33-2 pending |
| R33-02 (Major) anycast rule blind in its own partitions; D1 | §2 probe sites as arbiter (signed verdicts, majority of reachable sites, never withdraw with none); double cut withdraws R2, isolated R1 withdraws R1; §11 rows; §17.1; §12.10; DT-40; RK35 |
| R33-03 (Major) Kafka leaders in the cut-off facility; D2 | §7.3 step 4 automatic leader consolidation (preferred replicas reordered, preferred leader election, controlled shutdown after 20 s); §5.6 row; §10.2, §10.3 (about 1 breaching X2-S22 and X2-S17 minute per split), §11; §20.2; DT-35 |
| R33-04 (Major) routing during a lazy split; D3 | §7.1 splitting state with the head row authoritative for the upper half, owners deferring to it, creation of upper-half accounts in `s + n`, listing after the holder acknowledges; ordering rule; §12.7 `headDecides`; DT-41; AI-33-1 pending |
| R33-05 per-process budget, connections | §4.7 shed load before giving up the session; standby processes hold no slots; §19.2 per-process CPU and Little's-law connections (about 420 per node after a facility loss); §22.1 exit criteria (1,640 txn/s at loop delay p99.9 ≤ 50 ms, else 128 slots per process; connections) |
| R33-06 head range claim | §3.7 head rows keyed by the bit-reversed home: one contiguous range per slot for every power-of-two count |
| R33-07 `adopt` fence contention | §4.5 steps 4 and 5: the fence is seen from A's push or a bounded-staleness read before B's batch; B's transaction reads nothing of A's |
| R33-08 ordering on the relay path | §5.3 sentence corrected; §5.5 and §12.5: the runtime buffers out-of-order events, `onResolved` only after every buffered event at or below `R`, the `reported` gate buffers outcomes until a covering marker |
| R33-09 tier timing | §4.7 400 ms per-tier timeouts for renewals, epoch reads and polls, circuit breaker; §7.3 expected effect derived (about 1 to 3 s, no owner change); §11, §10.2, DT-35 |
| R33-10 correlated in-sync shrink; D4 | §5.2, §7.3 "Kafka degraded" observed directly; §5.6 row; §12.10; §22.1 row (R2 fetch stalled 6 s) |
| R33-11 NVMe | §19.4 553 TB; RK27 re-checked against the store's 40 TB allotment |
| R33-12 doubling time and probe load | §7.1 about 1 to 3 s a slot, 20 to 50 min a doubling; probe load and probe links doubled (§7.1, §17.1, §19.2) |
| R33-13 one-sided hooks | Joint items for the neighbours' next revisions, below |
| R33-14 emitter and upgrades | §5.3 one flush per poll; a new emitter holder emits `CLOSED` for every link once; §3.5 upgrades never pause changefeeds, closure-lag page at 60 s during a drain; §16; RB-13 |
| R33-15 republish wording | §4.4 after serving, rate-limited; consumers buffer |
| R33-16 rule-3 checks | §4.6 cached per slot until `expires_at` − ε; §19.2 line |
| R33-17 restart vs abort | §4.3 `Retry` row: abort loses intents, the batch starts afresh; RFC-001 to state its abort case; §22.1 counts both |
| R33-18 follower reads | §19.2 separate follower-read line |
| RFC-005 rev. 5: no passphrase fallback | §14.1: if EKM is unusable, backups wait (page after two missed incrementals); R6-24 row annotated |
| RFC-005 rev. 5: signed probe-set summary | §7.1, §12.7 `probeSetSummary(v)`: slot map at `v`, slot count, probe-account count, digest, signed |
| V-1 (review 34) verdict without announcement state | §2 verdict "announcing and passing", the edges' announcement signed in the canary answer; DT-40 case |
| V-2 (review 34) Kafka consolidation premises | §7.3 step 4 rewritten (admin calls through R2, cut-off controller restarted through R2 with the preferred-region rule suspended, first in-sync R2 replica first, then the chosen facility's; 20 s fallback); out-of-sync sentence corrected; §5.6 row; §12.10 |
| V-3 (review 34) | §4.2 re-home: `T_res` lifted by the read of the re-homed `owner_slot` rows |
| V-4 (review 34) | §5.6 about 7 s from the stall's start; §22.1 a 15 s stall, produce within 7 s of its start |

**Joint items for neighbouring RFCs** (R33-13; not edited here):

| RFC | Must add |
|---|---|
| RFC-001 | Consume `onAdopt(partition, generation)` (re-arm the link's deadline timers, `release_grace` and A-T4, and re-send releases without "releases durable") and `onMovedOut(partition)` (cancel them); handle the `Moving` and `Stopped` results; state the abort case of the capacity-decrease retry (R33-17); 128 probe links per region after a doubling |
| RFC-002 | Handle `Stopped`; route by `slotOf(...).headDecides` and defer to the head row in a splitting slot (R33-04); its P2-S111 argument cites the initial report position after any acquisition (R33-01) |
| RFC-003 | `onResolved` delivered after buffered events; no other change |


## Revision 7 resolution

Revision 7 rebases revision 6 on `requirements-v1.11` (`python3 tools/impact.py diff
requirements-v1.9 requirements-v1.11`: S-PLAT ids P1-N08, P2-S09, P3-N03, P3-N07, X1-N11,
X1-S11, X1-S24, X2-N01, X2-S30, X2-S33; policies POL-06, POL-07, POL-14, POL-16, POL-19,
POL-24, POL-29, POL-32) and on RFC-000 revision 4.5, and applies every item of the frozen
contracts that names RFC-006. The binding rule is that RFC-006 conforms to the frozen
contracts and that C01 is the contract RFC-006 provides.

**C01 errata list (§10.3, rows "RFC-006 (provider)"), N1 and settled points:**

| Item | Change in revision 7 |
|---|---|
| `append`: `decide(ctx)` with declared `reads`, `AppendOptions`, `displacementRead` keyed (link, request) (M2, M3, R47-01, R47-11); canonical refusals with `STALE_SENDER(recorded)` (M4, R47-09) | §4.3 (calls, SQL, results), §4.5 (fencing table, D4 sender rule), §3.7 (displacement read), §12 |
| §3.7: projection keys never led by slot; `link_displacement` keyed (link, request); `(partition, seq)` log index, outbox stream index, self-outboxed stream index; head column `adopted` (R47-01, R47-02, R47-19, R47-27) | §3.7 table and "Slot first" bullet, §3.5 (stream index, relay log key) |
| §4.2/§4.3: resolution steps numbered and reused for `Ambiguous` with a high-priority read including `owner_session`; every committed call upserts its head with `batch_id`; `Retry` (not `Overloaded`) after exhausted retries; lane (c) excluded from v1 (M1, R47-12, R47-14, R47-31) | §4.2 (resolution steps 1 to 4), §4.3 (crash points, per-call outcome, results table, lanes), §12.10 |
| §4.5: `MOVING`/`MOVED` by `adopted`; nothing served in B before `adopt`; step 6 enforced on B's report position; §4.6: marker due on `moved`, including by a successor (R47-02, R47-03, R47-16) | §4.5 steps 3 to 6 and the bound paragraph, §4.6 |
| §4.2/§12.2: `stops_version` on `owner_slot`, `Stop` acknowledged once enforced at the fence(s), owners read `placement_integrity_stops` without placement (R47-04, D2) | §4.2 (`owner_slot` columns; stops read on acquisition), §4.3 (fence read), §7.1 (integrity stops), §14.3 |
| §7.1: `ackSplitting`, `listPartitions`, creation with `rowAbsent(head)`; `slotOf` answers `s` with `headDecides`; `probeAccounts` per version and the doubling order (R47-05, R47-21, R47-27, R47-29) | §7.1 (tables, `slotOf`, splitting handshake, doubling in C01's seven steps, refusal codes), DT-41 |
| §5.3–§5.5: closure topics with `dataHighWater`; `R_min` from topic metadata; closure streams and sizing (M7); per-topic producer ACL without a separate republish role (M8, R47-06, R47-20, R47-25); D3 conflict rule; `slot` header on outcome events (R47-22) | §3.5, §5.2 (ACL), §5.3 (closure topics, markers, streams), §5.4 (headers), §5.5 (conflict), CI6-2, CI6-3 |
| §16: alert episodes, `cleared` by episode, `PROBING_FAULT` per D1 (M9, R47-08, R47-26) | §16 (raising, alert service, probing faults, alarm rows), §12.10 |
| §17.3 and traceability: a slot-minute whose every probe failed is unavailable even with fewer than 3 probes (X2-S30, v1.10); X2-S33 cited, a short-probed slot alerted to network operations per D1 (N1, R47-26) | §17.3, §10.2, §11, traceability (X2-S30, X2-S33), DT-30, DT-46, RK37 |
| §3.7, §4.6: `report_through` and the marker stream sequence on `owner_slot`, not on a partition `''` head row; marker-only transactions serialise on that row; the successor pushes its first marker to the slot named by an unadopted head (V59-6, V59-7) | §3.7 (no `''` head row), §4.2, §4.3 (marker-only), §4.5 (step 4, successor), §4.6 |
| §5.3, §5.4: `ReportMarker` with `prevReportPosition`, `pendingAnswered`, `chunk`; marker rules as C01 §3.4; every marker kept for `onMarker`, the monotone drop only for the gate (V59-1, N-01, N-12) | §4.6 (marker chain rules 1 to 5), §5.3, §15 |
| §7.1, §12.2: placement's column grant on `owner_slot.stops_version`; `Stop` fences both `s` and `s + n` for a `headDecides` account; the guarantee by `ts` against `enforced_at`; audit's first-seen head as of `enforced_at` (V59-3, V59-4, V59-5) | §3.7 (grants), §7.1, §14.3 steps 2 and 3, DT-45 |
| §19: Kafka partitions per broker after one doubling; safety of a partition-count increase (R47-30) | §5.4 (partition counts), §19.2, §22.1 row, RK36 |
| §6.3 as the precondition of the holder's view and read leases; `leaseValid` margin of `max_loop_delay` (R47-23) | §4.2 (holder's view) |
| M10 (named platform read roles), M11 (probe accounts by the slot map), M12 (doubling of the account kind only), M13 (history read grants), C4-7 (C01 is the single definition of the hooks, `Moving`, `Stopped` and splitting) | §3.7 (reads across owners), §17.4 rules 1 and 3, §4.1, §13.3, §12 |
| Provider tests CP-1 … CP-14 | §12 (provider obligations); DT-13, DT-29, DT-37, DT-41, DT-45, DT-46 cite them |

**Other contracts:**

| Contract item | Change in revision 7 |
|---|---|
| C02 M7: the slot-first convention applies only to log and outbox tables | §3.7 "Slot first" bullet |
| C03 Status errata, R39-05, R39-06, D39-3, CT-6.1, V52-3 (notifier tells holders only from `AFFECTED_NOTICE`, within 40 s, 35 s fallback; `maintenance_cut` tells the supplier; dedup by (`link_id`, `log_seq`, reservation)) | §15 (structure, link schedule row, timing), DT-48 |
| C04 consumer obligations to RFC-006 (§5.3, §5.4 marker fields; §15 holder notices, `withheld_by`, release notice from `ended(released)`, outcome webhooks iff `answered_pending` or `pendingAnswered`, every marker kept, fallback), MM-7 … MM-11, CC-1 | §4.6, §5.3, §15 (outcome and lifecycle rows), §17.4 rule 3 (`account_is_probe` a copy), DT-47 |
| C05 obligation: `account.usage-applied.v1` retained at least 7 days and sized; its gap path is `usage_applied_since`, not the outbox (S-4) | §5.2 (retention), §5.5 (exception), §19.4, CI6-4 |
| C06 obligations: three topics added to the topic table; `catalogue.v1` produced by the catalogue only (D7); the posting-acknowledgement ACL and no markers there (m10); one relayed owner kind per topic with markers (AI-55-2) | §5.2 (ACL), §5.3 (streams), §5.4 (topics, filtered-view keys), CI6-2, CI6-3 |
| C07 (RFC-006 row): the F9 source carries the designating slot-map version; `probeAccountSet(v)` and `probeSetSummary(v)` served for a pending, unpublished version (S1, R37-11) | §7.1 (probe-account set), §17.4 rule 1 |
| C08 obligations: S-M2 (no four-eyes approval, one out-of-band confirmation), S-M3 with R46-19 and R46-21 (the delivery worker signs; placement's summary-signing key), S-M4 (`webhook-id`), S-M5 (acknowledgement at the fence), R46-12 (local hold and `integrity_report`, no stop of its own), R46-02, R46-18, V56-1 (forced policies, `restore_confined`, none `TO PUBLIC`, truncation policy `FOR DELETE TO truncator`), R46-22 (no `visibility` call), R46-23 (SNI and host verification), R46-27 (`operator_check` at apply), summary duties (audit append before answering) | §3.7 (chain mismatch), §7.1 (summary, disasters, stops), §13.2 (policies), §14.3, §15 (endpoints, signing, transport, `webhook-id`), §16 (integrity hold alarm), DT-23, DT-45, CI6-1 |
| C09 obligations with AI-48-3: S-M1 (storage cap), S-M2 (`expiry_destroyed`), S-M3 (full caps), R36-06, R48-03, R48-13 (restore procedure: fence outside `pds` before the restore, `reapply` reading the feed itself, cutoff, feed retention ≥ 14 days), R48-06 (`max.message.bytes`), R36-07 and R48-14 (state-based sweep), R36-24 (rewrap at once, backup choice), R48-20 (bucket key wrapped under the day's expiry key), R48-04 with V60-6 (AS OF time to identity before the fence is removed), V60-2, V60-3, R48-12 (one `pds` partition) | §14.4 (caps, sweep, wrap wording, store events feed, restore steps 1 to 6), §5.2 (feed retention), DT-49 |
| C11 S-2 (the `ingest_log` hand-off stream carries `identity-conflict` rows); the hand-off topic name `ingestion.handoff.v1` | §3.5, §5.4 |
| C12 V6 e: console alert at 12:00 UTC on D + 1 when `RUN_COMPLETED` is missing (m11); the new event kinds for the console and notifier | §15 (partner reconciliation row), §16 (partner run missing) |
| C01 settled M1 … M13, review 47 D1 … D4 as prior decisions | Header ("Prior decisions") |

**RFC-000 revision 4.5, row "RFC-006" of "Interface points the detailed RFCs must match",
and the items routed to RFC-006:**

| Item | Change in revision 7 |
|---|---|
| `COMMIT` backstop and `Ambiguous` resolution (C01 M1) | §3.6 is unchanged (15 s); §4.3 crash points and results, §4.2 steps |
| Move protocol with `adopted` and `Moving` until `adopt` (A-1) | §3.7, §4.3, §4.5 |
| Integrity stop enforced at the slot fence with `enforced_at`; restore role on placement's table (A-4) | §7.1, §14.3 |
| Closure topics written only by the emitter; one relayed owner kind per closure topic (A-5, AI-55-2) | §5.2, §5.3 |
| Markers with `prevReportPosition`, `pendingAnswered`, chunks; the notifier keeps every marker (AI-58-1) | §4.6, §5.3, §15 |
| Platform read roles as A1 lists them, checked by the conformance job (M10) | §3.7 |
| Probe designation from the slot map, served for a pending version (M11, C07 S1) | §7.1, §17.4 |
| Store events from one `pds` partition, `expiry_destroyed`, `reapply` and `store_outbox_head` in the restore procedure (C09) | §14.4 |
| AI-41-5, AI-48-3 | §5.4; §14.4, §5.2 (Architecture issues) |
| AI6-10, AI6-11, AI-33-1, AI-33-2 (raised in revisions 5 and 6) | Resolved by RFC-000 revision 4.4; moved to "Resolved" in Architecture issues |

**Requirements (`requirements-v1.10`, `requirements-v1.11`):**

| Change | Change in revision 7 |
|---|---|
| X2-S30 amended, X2-S33 new (POL-06, X2-N1) | §10.2, §16, §17.3, §11, §19.5, DT-30, DT-46, RK37; header "Satisfies"; traceability. `impact.py coverage S-PLAT` no longer reports X2-S33 uncited |
| P1-N8, POL-07: notices due within `affected_notice_time` + `release_grace` during a schedule-owner failover (P1-S85) | §15 timing, DT-48 |
| X1-N6, X1-S11, X1-S24: supplier webhooks | §15, DT-47 |
| P2-S09: changes answered `pending` get their outcome webhook | §15, DT-47 |
| POL-32: four eyes above `credit_limit_four_eyes_above` | §17.4 rule 4 |
| P3-N3: record identity per format | §13.3, §17.2 |
| POL-19, X1-N11, POL-24, POL-14, POL-16, POL-29, P3-N7 | Read; no change to RFC-006 (Requirements issues) |

**Interface points other RFCs must match** (each is already a contract obligation; listed
so the slice owners can check): RFC-001, RFC-002, RFC-003, RFC-004 and RFC-005 handle every
`AppendResult` and `RoutingRefusal` and the move hooks as C01 §10.3 lists; RFC-002 sets
`EntryInput.pendingAnswered` and answers `listPartitions` and `ackSplitting`; RFC-003
declares `ingest_log`'s hand-off stream with `identity-conflict` rows and its closure; RFC-005
gives the notifier's delivery worker and the `ingest` relay their key-release entries,
sends `integrity_report` intake, and verifies `probeSetSummary(v)` under placement's
summary-signing key.
