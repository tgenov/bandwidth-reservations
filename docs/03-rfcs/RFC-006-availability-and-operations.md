# RFC-006. Availability, durability and operations: the platform layer

| | |
|---|---|
| Status | **Draft, revision 2.** Revision 2 rewrites the platform for RFC-000 revision 4's substrate (CockroachDB at 2 + 2 + 1, NestJS owner services with epoch-fenced owner leases, Kafka fed by a transactional outbox) and applies the `requirements-v1.6` decisions on RQ-A … RQ-F. Revision 1 specified a custom multi-group Raft platform (`etcd-io/raft` in a Go partition host); it is now a rejected alternative (Competition). See "Revision 2 resolution" at the end |
| Satisfies | X2-S01 … X2-S28 (all 28 X2 scenarios, as primary RFC), including the new X2-S25 … X2-S28 and the amended X2-S05, X2-S06, X2-S07, X2-S15, X2-S20, X2-S23, X2-S24. Contributes the platform, history, notifier, alerting and backup contracts to P1-S26, P1-S33, P1-S40, P1-S50, P1-S54, P1-S62, P1-S63, P1-S72, P1-S75, P2-S04, P2-S09, P2-S10, P2-S22, P2-S23, P2-S51, P2-S53, P2-S93, P2-S99, P2-S104, P2-S106, P2-S107, P2-S108, P2-S111, P3-S31, P3-S36, P3-S39, P4-S23, P4-S54, P4-S71, P4-S72, P4-S80, P4-S81, P4-S90, P4-S91, P4-S104, X1-S11, X1-S14, X1-S15, X1-S24, X1-S31, X1-S34, X1-S37, whose primary RFC is named in the traceability table |
| Policies | POL-04 (`ack_budget`, `status_staleness`, `webhook_retry`, "told"), POL-06 (targets, available minute, probe accounts and probe supplier, p99 per calendar month and serving region, declared region disaster with four eyes and counted from the recorded loss, go-live fibre condition), POL-07 (`affected_notice_time`), POL-14 (`attribution_lag_max`, `max_lateness`), POL-15 (each probe account's `credit_limit`), POL-16 (notices), POL-18, POL-19, POL-24 (retention pending legal confirmation), POL-26 (`release_grace`, the deadline), POL-29 (7-year identities), POL-32 (network operations declares and ends disasters with four eyes; `approval_expiry`) |
| Builds on | [RFC-000](RFC-000-architecture.md) **revision 4**: §1 principles A1 … A11, §2 components (placement and time, history, notifier, probes), §3 latency budget and leader placement, §4.3 the confirm fence, `ε` and the monitored quantities, §4.5 closed timestamps, §4.6 positions, read leases and status replicas, §5.1 topology, §5.2 owner leases and fencing, §5.3, §5.4, **§5.5 (the substrate mapping and its list of what RFC-006 must change)**, §6 sizing, §8 the substrate-conventions contract, R1, R2, R4, R13, R14, R16, R18 … R21, and its "Revision 4 resolution". The requirements at tag **`requirements-v1.6`**, including the decisions on RQ-A … RQ-F ([review 11](../reviews/11-requirements-amendments-from-detailed-rfcs.md)) |

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

## Need

RFC-000 revision 4 decides the shape: single-writer owners (A1, A2), each partition an
append-only log in a distributed SQL database whose every commit is acknowledged by a
majority that spans two regions (A3), five voters per range placed 2 (R1 Nairobi) + 2 (R2
Mombasa) + 1 (R3 Johannesburg, GCP `africa-south1`), range leases and owner leases in one
Kenyan region, reconfigured to 2 + 2 after a sustained region loss. It leaves to this RFC
everything that makes that shape run and be measured (RFC-000 §5.5, §7, §8):

1. **The platform layer** (X2-N4, X2-N5): the database's topology and configuration (zone
   configurations, voters and non-voters, lease preferences, closed timestamps, follower
   reads, changefeeds), the log-table schema conventions, and the owner runtime (sessions,
   slot leases and epochs, epoch-guarded batch transactions, reload on failure, standby
   tailing, read leases and the report position), as a contract complete enough for
   RFC-001 … RFC-005 to build on.
2. **The feeds** (RFC-000 §5.5, §8): the outbox, the changefeeds, the Kafka cluster and its
   topic conventions, and webhook delivery.
3. **Time** (RFC-000 §4.3, R4): the GNSS/PTP discipline that the 100 ms `max_offset` relies
   on, the owner hosts' offset check, `δ_x` per topology state at p99.9, and the monitored
   quantities (AI-1).
4. **Failure handling with stated numbers** (X2-N5, R16): detection, region-wide failover
   of every range lease and owner slot within admission's 1 min RTO, the automatic 2 + 2
   change (AI-2), declaration and restoration, and what each failure does to RPO, RTO,
   availability and latency.
5. **RPO 0** (X2-N4) for every fact and failure scope, during a declared disaster too.
6. **RTO per capability** (X2-N5) and the per-minute arithmetic for the hot standbys on the
   rating paths, with the about-5 s takeover RFC-000 fixed (AI3-9).
7. **Measurement** (X2-N1, X2-N3): the probes, the designated probe accounts and probe
   supplier (RQ-C), the available minute, percentiles per calendar month and serving
   region (RQ-D), and the disaster exclusion from the recorded loss (RQ-B).
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
| **Owner runtime** | A NestJS module every owner service embeds: sessions, slot acquisition, epoch-guarded batch transactions, standby tailing, read leases and report positions, outbox publishing, timers, payload encryption hooks. It is the implementation of the platform contract (§12) | §4, §12 |
| **Kafka and the relay** | One Apache Kafka cluster over the four Kenyan facilities (no broker in R3), the changefeeds that relay outbox rows to it, and the consumer conventions | §5 |
| **Time** | GNSS/PTP time in every Kenyan facility, NTP from Kenya to R3, the offset checks and the alarm ladder | §6 |
| **Placement** | The placement controller: slot preferences, region preference, topology state, zone-configuration changes (failover, 2 + 2, restoration), disaster records, timing parameters | §7, §8 |
| **History** | Sealing of owner logs into the write-once two-region archive, indexes, the "as known at T" query and replay, truncation of the live tail | §13 |
| **Backups** | Scheduled CockroachDB backups to GCS and Ceph, restore tests, the personal-data store's backups | §14 |
| **Notifier** | Outbound delivery: webhooks, notices, alerts to people | §15 |
| **Alerting** | The operational alert feed and its routing | §16 |
| **Probes** | Probe runners outside each serving region; the probe accounts, probe supplier, probe links and exporters; the measurement pipeline | §17, §18 |

It does not specify any owner's state machine, entry kinds or business rules (RFC-001 …
RFC-005), the signing of webhooks or the payload-encryption library (RFC-005), or the
exclusion logic inside rating and settlement (RFC-003, RFC-004), beyond the contract they
must meet.

### 2. Topology: sites, facilities, racks and nodes

RFC-000 §5.1 fixes the regions, the voter placement and the leader region. RFC-006 adds
the facility layout and the node roles.

| Site | Facilities ("zones") | Node roles |
|---|---|---|
| R1 Nairobi (Share data centres, serving) | Two independent facilities, `r1a` and `r1b` (own power and fibre entry), **to be confirmed by Share's platform team** (RFC-000 R2; §20.4) | Database nodes (one voter and, for account tables, one non-voter of every range per facility; range leases while R1 is preferred); owner hosts (slot holders and in-region hot standbys); status-reader hosts; Kafka brokers; one KRaft controller; edge nodes; stateless workers; Ceph (archive and backups); time servers |
| R2 Mombasa (Share data centres, serving) | Two independent facilities, `r2a` and `r2b`, to be confirmed likewise | As R1. Range leases and owner slots only after a region-wide failover, or after the R1 spike shows Mombasa nearer to R3 (RFC-000 R2-D7); its owner processes are the cross-region warm standbys meanwhile |
| R3 GCP `africa-south1` (voter only) | Google's zones `r3a`, `r3b`, `r3c` | Database nodes only: one voter of every range, spread over the three zones; a standing non-voter of every admission range in a zone other than its voter's (§8.1); a reserved capacity block for a second voter set (§8.1); one KRaft controller (metadata only); the GCS archive and backup buckets. No edge, no owner process, no Kafka broker, no status reader (RFC-000 AI5-3) |
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
with a 30 s TTL are the fallback. Each region's edge also has a **unicast** address, which
the probes use, so a region's own availability is measured even while anycast routes
clients around it (§17).

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

**Every other table**: the `default` configuration.

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
| Follower reads | `AS OF SYSTEM TIME follower_read_timestamp()` for scans (sealer, standbys, reconciliation cuts); `with_max_staleness('4s', true)` (bounded staleness, nearest replica only) for status readers' point reads | A read served by a replica in the reader's own facility, never by the leaseholder |

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
  destination topic (§5.4) with its (partition, epoch, sequence) and its outbox payload,
  which is already ciphertext. The changefeed's own payload is the row; columns in clear
  are only keys, sequence, epoch, timestamps and pseudonymous identifiers (A11).
- **Resolved timestamps** (`resolved = '1s'`) are forwarded by the relay as markers on every
  destination partition: "no row with a commit timestamp at or below `R` will follow".
  They are the lifecycle feed's effective-time closure (RFC-000 §4.5) and every consumer's
  safe cut.
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

#### 3.6 Other cluster settings

| Setting | Value | Why |
|---|---|---|
| `--max-offset` (every node) | **100 ms** | `ε` (RFC-000 coordinator decision); a node whose offset from a majority of its peers exceeds 80 ms terminates itself (§6.3) |
| Clock source | `chrony` disciplined by PTP and GNSS (§6.1) | §6 |
| `gc.ttlseconds` | 14,400 (4 h) by default; **90,000 (25 h) on outbox tables** | The default covers historical reads, backups' protected timestamps and the garbage of the truncator's deletes (§13.2); outbox tables keep 25 h of history so a changefeed can be recreated from a consumer's resolved timestamp |
| Row-level TTL on outbox tables | `ttl_expire_after = '26 hours'` | Outbox rows are transport, not record; the log is the record |
| `range_max_bytes` | 512 MiB (default) | Load-based splitting (on by default) splits busy ranges; a hot link's slot is its own range at most a few hundred MB |
| Pre-splits | Every log and head table pre-split at slot boundaries | Each slot's rows start in their own range, so a slot's writes never contend with another slot's range lease |
| Encryption at rest | On (enterprise `--enterprise-encryption`, AES-256, store keys rotated monthly) | Every store; R3's nodes hold their own store keys, never a payload key (RFC-000 §5.1) |
| Snapshot rate (`kv.snapshot_rebalance.max_rate`) | 256 MiB/s per store | Up-replication after a node loss, the 2 + 2 change and restoration (§8) |
| Delegated snapshots | On, where the release supports them | A new R3 voter is bootstrapped from R3's existing replica, not across the Johannesburg path (§8.1) |
| `storage.max_sync_duration` | 10 s | A node whose disk stalls that long terminates itself, a node loss, instead of stalling its ranges for longer |
| Admission control | On (default) | Overload sheds at the database rather than queueing |
| Statement timeouts | 2 s for owner transactions (set by the runtime); 30 s for history and reporting | A stuck transaction becomes a retry, not a stuck partition |

#### 3.7 Schema conventions for log tables

Each owner kind has four table types, created by RFC-006's migration tool from the owner
RFC's declaration:

| Table | Primary key | Columns | Writes |
|---|---|---|---|
| `<kind>_log` | (`slot` INT2, `partition` BYTES, `seq` INT8) | `epoch` INT8; `kind` INT2; `schema_v` INT2; `ts` DECIMAL (the commit timestamp, below); `identity` BYTES (the command's idempotency identity, A6); `audit` (pseudonymous principal, role, reason code: RFC-005's field set, A11); `retention` INT2 (§13.1); `key_id` BYTES; `payload` BYTES (owner-compressed, then encrypted, RFC-005) | **Insert only.** No role is granted UPDATE or DELETE except the truncator (§13.2) |
| `<kind>_head` | (`slot`, `partition`) | last `seq`, last `ts`, last `epoch` | Upserted in the batch transaction |
| `<kind>_<projection>` | Owner-defined | Current state derived from the log (A4), payload columns encrypted likewise | Upserted in the batch transaction |
| `<kind>_outbox` | (`slot`, `partition`, `seq`, `n`) | destination topic, key, headers, ciphertext payload, `ts` | Inserted in the batch transaction; expired by row-level TTL |

- **Slot first.** Every key begins with the slot, so a slot's rows are contiguous, ranges
  split along slots, and a slot is the unit of leasing, moving and failure.
- **Commit timestamp.** `ts` is `cluster_logical_timestamp()` read in the batch
  transaction, which fixes the transaction's commit timestamp to it; if the database must
  push the transaction, it fails with a retry error instead, and the runtime retries
  (§4.3). Within a partition `ts` is strictly increasing across owners (each batch reads
  the head row its predecessor wrote, so the database orders it later), and no entry is
  ever stamped at or below a closed timestamp (RFC-000 §4.3, §4.5, A0R-10).
- **Contiguous sequence.** `seq` continues the head row's `seq`; a gap is impossible inside
  one partition, so a consumer that sees one knows it has missed something (§5.5).
- **Grants.** Each owner service's database role may INSERT and SELECT on its own kind's
  log and outbox, UPSERT on its own head and projections, and SELECT on the session and
  slot tables; nothing on any other owner's tables except SELECT where a contract makes
  them readable (RFC-000 A1). Status readers, the sealer and the relay are read-only.
- **Encryption.** The runtime calls RFC-005's library to compress and encrypt every
  payload before the insert, with the partition, `seq` and `kind` as associated data, and
  data keys wrapped by keys held only in the Kenyan HSMs (RFC-000 AI5-3). Clear columns
  carry pseudonymous identifiers only (A11).

### 4. Owner leases and the NestJS owner runtime

#### 4.1 Owner kinds and slots

A **partition** is the unit of single writing (a link, an account, a partner link, an
exporter, a ledger home, RFC-000 §2). Partitions hash into a fixed number of **slots** per
owner kind; a slot is held by one owner process at a time, which is the only writer of
every partition in it (A1, A2). A hot partition gets a slot of its own (the hottest links,
RFC-000 §6).

| Owner kind | Partitions | Slots at the design load (est.) | Notes |
|---|---|---|---|
| Account owner | Account | 1,024 | About 100 active accounts and 50 entries/s per slot on average; one account at `account_rate_limit` (200/s) is about 400 entries/s |
| Link schedule owner | Link | 512 shared + up to 128 dedicated | A link that sustains more than 200 requests/s for 10 min is moved to a dedicated slot (§4.5); the hottest link (2,500/s, at least 5,000 entries/s) is one |
| Partner adapter | Partner link | 64 | |
| Metering ingestion | Exporter | 256 | One transaction per accepted batch |
| Attribution and quarantine | Account; exporter (quarantine) | 256 | Hot standby (§10.3) |
| Rating | Buyer account | 1,024 | Hot standby (§10.3) |
| Settlement | Buyer account; supplier (debts) | 256 | |
| Ledger | Movement home (RFC-000 §2) | 1,024 buyer homes + 64 supplier + 32 Share sub-partitions | |
| Payments, receivables, reconciliation | (provider, transaction reference); account; day | 128 + 128 + 4 | RFC-000 V-04 |
| Payouts | Supplier | 32 | |
| Catalogue, identity and access, approvals, notifier, alerts, probe results | Entity or account | 16 + 32 + 8 + 256 + 8 + 4 | |
| Placement | One partition | 1 | §7.1 |
| **Total** | | **about 5,000 slots** | Held by about 600 owner processes in the preferred region (est., §19.2); slot counts can be raised by a split with an epoch increment (§4.5) |

#### 4.2 Sessions, slot leases and epochs

RFC-000 §5.2 states the owner lease as a row (slot → holder, epoch, expiry). RFC-006
implements it as two tables, so that renewing costs one row per **process**, not one per
slot (about 5,000 slots renewed twice a second would be 10,000 two-region writes a second
for nothing; Architecture issue AI6-1):

| Table | Key | Columns | Written by |
|---|---|---|---|
| `owner_session` | `session_id` (random, never reused) | `host`, `region`, `facility`, `kind`, `started_at`, **`expires_at`** | Its process: inserted at start, `expires_at` renewed every `session_renew` (500 ms) to `now() + session_ttl` (3 s) |
| `owner_slot` | (`kind`, `slot`) | `session_id` (the holder), **`epoch`**, `acquired_at`; in column families apart from any column a renewal writes | The acquiring process (one transaction per acquisition) |

- **A slot's owner lease is valid** while its `owner_slot.session_id` names a session whose
  `expires_at` is in the future by the database's clock. The **epoch** is the term of A2.
- **Renewal**: `UPDATE owner_session SET expires_at = now() + '3s' WHERE session_id = $me
  AND expires_at > now()`. It touches no slot row, so it never conflicts with a batch
  transaction's epoch read. A renewal that finds its session expired fails: the process
  gives up every slot (§4.4).
- **The holder's own view.** The process takes its lease to end at `t_send + session_ttl −
  ε` by its **monotonic** clock (`process.hrtime`), where `t_send` is when it sent the last
  renewal that succeeded and `ε` = 100 ms covers the offset between the database node that
  stamped that renewal and the one that will stamp a successor's acquisition (both within
  `max_offset`) plus the owner host's offset (held below 50 ms, §6.2). From then on it
  proposes nothing, decides nothing from memory, grants and renews no read lease and sends
  no command, until a renewal succeeds. Safety does not depend on this timing (A8); the
  epoch-conditional write does (§4.3).
- **Acquisition** of a free or expired slot, in one transaction:

  ```sql
  UPDATE owner_slot AS s
     SET session_id = $me, epoch = s.epoch + 1, acquired_at = now()
   WHERE s.kind = $kind AND s.slot = $slot
     AND NOT EXISTS (SELECT 1 FROM owner_session o
                      WHERE o.session_id = s.session_id AND o.expires_at > now())
  RETURNING epoch;
  ```

  Serialisable isolation orders it after every transaction that read the old epoch (they
  either committed before it, and the new holder sees their rows, or they abort). It
  succeeds only if the old holder's session has expired by the transaction's timestamp.
- **Handoff** (planned moves, rebalancing, failback, drained hosts): the holder stops
  proposing, waits for its in-flight batch, and sets `session_id` to the named successor and
  increments the epoch in one transaction; the successor starts at once, without waiting
  for an expiry.

#### 4.3 The epoch-guarded batch transaction

Each partition has **one batch transaction in flight** (RFC-000 §3); entries that arrive
while it commits form the next batch. A slot's partitions commit independently and in
parallel.

```sql
BEGIN;  -- SERIALIZABLE, statement timeout 2 s
SELECT epoch FROM owner_slot WHERE kind = $kind AND slot = $slot;            -- must equal mine
SELECT seq, ts FROM account_head WHERE slot = $slot AND partition = $p;      -- predecessor
SELECT cluster_logical_timestamp();                                          -- this batch's ts
INSERT INTO account_log (slot, partition, seq, epoch, kind, ts, ...) VALUES ($seq + 1, ...), ...;
INSERT INTO account_outbox (...) VALUES (...), ...;
UPSERT INTO account_head (...) VALUES ($slot, $p, $seq + n, $ts, $epoch);
UPSERT INTO account_requests (...) VALUES (...);                             -- projections
COMMIT;
```

- The epoch read is the fence: if a successor's acquisition commits after this read and
  before this commit, this transaction cannot commit (its read is invalidated) and fails
  with a retry error. A deposed owner, however long it was paused, therefore never commits
  an entry after its successor started (RFC-000 §5.2).
- Conditions an entry depends on ("confirm if undecided", "binding is new", "`ts` < `D − τ`")
  are evaluated against the rows read in the same transaction and against `ts`; the
  decision row's primary key is the request, so a second deciding entry cannot commit
  (RFC-000 §5.5). The fence reads `τ` from the `platform_timing` row (§6.4) in the same
  transaction.
- **Results** the runtime returns to the owner:

  | Result | Meaning | Owner's action |
  |---|---|---|
  | `Committed(seq range, ts)` | Durable on a majority spanning two regions | Apply to memory; acknowledge; publish outbox rows (§5.3) |
  | `Retry` (SQLSTATE 40001) | Not committed | Re-read epoch, head and rows; re-evaluate conditions; retry (up to `batch_retries` = 5, then `Overloaded`) |
  | `StaleEpoch` | The epoch read differs from the holder's | Stop: the slot is lost (§4.4) |
  | `Ambiguous` (SQLSTATE 40003, or a lost connection after COMMIT was sent) | May or may not have committed | **Reload** the partition from the log at the present timestamp; the batch committed if its first identity is there; never re-decide before that |
  | `Overloaded(retry_after)` | Admission control or timeout | Back-pressure to callers, mapped by the owner RFC to its POL-04 answer |

- **An owner's memory is a cache of its log** (RFC-000 §5.2): after any result other than
  `Committed` the partition's memory is rebuilt from the head, the projections and the log
  since the last projection checkpoint before the next decision.
- The fence's epoch read goes to the slot row's leaseholder in R1, about 1 ms within the
  metro (est.), inside RFC-000 §3's 2 to 5 ms of per-transaction overhead.

#### 4.4 Takeover, standbys and reload

Every slot has, besides its holder, two standbys that tail it (RFC-000 §5.1, AI3-9):

| Standby | Where | Takes over on |
|---|---|---|
| **In-region hot standby** | The other facility of the preferred region | Holder process, host or facility loss |
| **Cross-region warm standby** | The other Kenyan region, spread over its two facilities | Region-wide failover (§7.4) |

- **Tailing.** A standby reads its slot's new log rows every `standby_poll` (250 ms) by
  follower reads from its own facility's replicas (`AS OF SYSTEM TIME
  follower_read_timestamp()`, so about 1.5 s behind, est.) and applies them to its memory
  exactly as the holder did. For rating and attribution, whose state is largely derived
  from their input feeds, the standby also consumes the same Kafka partitions as the
  holder, without acting on them.
- **Takeover.** A standby watches its holder's `owner_session.expires_at` (read with the
  tail). When the session has expired by the database's clock, the in-region standby
  acquires the slot (§4.2); the cross-region standby does so only if the slot is still free
  `standby_grace` (1 s) later, or at once if placement has set its region as preferred
  (§7.4). It then reads every row committed after its tail at the present timestamp (the
  last 1 to 2 s), applies them, calls the owner's `onAcquire(slot, epoch)`, and serves.
- **Takeover time (est.)**: session expiry up to 3 s after the holder's last renewal, plus
  the acquisition transaction (about 30 ms), plus the catch-up read and apply (about 0.2 to
  0.5 s): **about 3.5 to 4.5 s, p99 ≤ 5 s** (the spike's exit criterion, AI3-9). A
  takeover whose ranges also lost their leaseholder (a database node failure under the
  slot's ranges) waits for the range lease as well (§3.3).
- **Takeover entry and resumption** (RFC-000 §4.3, POL-03): the owner's first entry in the
  new epoch, in each partition it touches, is its takeover entry; it re-arms its timers from
  its state (§12.6), re-sends releases for ending entries without a "releases durable"
  entry (RFC-002), and starts reporting only after the old holder's read leases have
  certainly expired, which they have, since the old session expired first (§4.6).
- **Takeover republish.** Before serving, the new holder republishes every outbox row of
  its slot committed within `republish_window` (30 s) before its acquisition, so a row the
  old holder committed but never published reaches Kafka at once rather than by the
  changefeed (§5.3). Consumers drop the duplicates (§5.5).
- **Giving up.** A process that fails a renewal, finds a `StaleEpoch`, breaches the offset
  check (§6.2) or its event-loop limit (§4.7) stops serving every slot of the session at
  once, fails its in-flight requests back as "not known to be committed", and exits; the
  supervisor restarts it with a new session.

#### 4.5 Fencing across components

RFC-000 §5.2 states the rules; the runtime enforces them as follows.

| Fence | Carried in | Checked by | A stale one gets |
|---|---|---|---|
| **Epoch** (per slot) | Every log row; every command an owner sends (`sender_epoch`); every routing decision | The database (the batch transaction's epoch read); receivers that keep a per-sender high-water mark (the partner adapter's account-owner epoch check, RFC-000 V-03) | Not committed; refused and journaled where the receiver keeps a journal |
| **Routing epoch** | Every command routed to an owner carries the slot epoch it was routed with | The receiving owner, against its own epoch | `StaleEpoch(current, holder hint)`; the sender re-routes. A command already applied (same identity) is answered with its result |
| **Sequence** (per partition) | Every feed event: (`partition`, `epoch`, `seq`) | Every consumer, in its own state | Ignored (idempotent consumption, A6) |

**Moving a partition** to another slot (a hot link to a dedicated slot): placement records
the move; the old slot's holder appends a final **`moved(to slot, epoch e′)`** entry and
refuses every later command for the partition with `Moved`; the new slot's holder appends
**`adopt`**, continuing `seq` from the head row, which moves with the partition (its key is
re-written under the new slot in the same transaction as `adopt`, conditional on the old
head). Commands in between get `Moving, retry` (about 100 ms, est.). Moves are made at low
load. The database splits and moves **ranges** under owners by itself, which changes no
slot, no owner and no epoch.

**No two writers, ever.** Within a slot, the epoch-conditional write gives one writer per
epoch, and the expiry timing stops the old holder acting before a new one can. Across
slots, `moved` commits before `adopt`. Feed events carry `epoch` and `seq`, so no consumer
applies an older writer's output after a newer one's (POL-05 across failures; P1-N1).

#### 4.6 Report position, read leases and status readers

The logic is RFC-000 §4.6's; RFC-006 gives the mechanism.

- **Status readers** (AI-4). One per Kenyan facility, four in all. A status reader is a
  service of `status_shards` (8) processes on the facility's status-reader hosts, each the
  facility's reader for one-eighth of the account slots, so each account slot has exactly
  four leased readers, one per facility. A reader holds (a) every committed batch the
  holder has pushed to it since its read lease began, and (b) for anything older, point
  reads by bounded staleness from the facility's own replicas (`with_max_staleness('4s',
  true)`): the Kenyan voters and the account tables' non-voter in that facility (§3.2).
- **Push and acknowledgement.** On every `Committed` batch that contains an entry the owner
  marks `report_wanted` (deciding and "releases durable" entries, RFC-002), and otherwise
  every `heartbeat_interval` (100 ms), the holder pushes the batch to each leased reader of
  its slot over gRPC; each reader acknowledges once applied.
- **Report position.** The holder advances the slot's report position to `P` once every
  entry at or below `P` is committed **and** every reader holding a live read lease has
  acknowledged applying through `P`, or that reader's lease has expired. Because the
  database acknowledges only two-region-durable commits, no further round is needed for
  "every later majority holds it" (RFC-000 V-02 as restated in revision 4). Delay: about
  10 ms steady (the farthest reader is in R2), about 5 ms when only one region's readers
  remain (est., RFC-000 §3).
- **Read leases.** A reader asks the holder for a read lease; the holder grants one only
  within its own owner lease (§4.2) and only if the reader has applied through its current
  report position. A lease lasts `read_lease` = 400 ms from the reader's **send** time of
  the request, and the reader treats it as expired `ε` (100 ms) before that. The holder does
  not renew the lease of a reader behind the position it is trying to reach, so a slow
  reader delays a report by at most one lease. Bound (RFC-000 §4.6, W-01): worst
  decision-to-report path (about 165 ms, a route ended after a region loss) + `read_lease`
  + `ε` = 165 + 400 + 100 = 665 ms ≤ `status_staleness` (1 s).
- **Replica rule 3's check** (RFC-002 owns the rule). "No instance holds the account's owner
  lease" is one consistent read at the present timestamp: the account slot's `owner_slot`
  row and its holder's `owner_session.expires_at`; if the session has expired or the slot
  is unassigned, the reader reads the request's rows in the same transaction, which sees
  every committed entry (RFC-000 B-AI-6). While the slot's ranges are moving their range
  lease after a database node loss, the read waits for the new leaseholder (seconds, est.)
  rather than answer (RFC-000 "not resolved here"; the spike measures it).
- **Closed position** on the readers: the timestamp at which their bounded-staleness read
  was served, which the reader records with any answer it gives from it.

#### 4.7 Process hygiene

NestJS on Node.js runs an owner's decisions on one event loop. A long pause (a garbage
collection, a blocked loop) does not break safety (§4.3), but would make the holder act on
a lease that has expired or answer late. Rules: (1) the runtime monitors the loop's delay
(`perf_hooks.monitorEventLoopDelay`) and gives up its session (§4.4) if the delay exceeds
`max_loop_delay` (200 ms) twice in 10 s; (2) the lease check of §4.2 is made immediately
before every reply or command sent from memory, after any `await`; (3) heap limits and the
young-generation size are set per process class so that measured pauses stay below 50 ms
at p99.9 (the spike measures them); (4) CPU-heavy work (payload encryption, compression,
Parquet encoding) runs in worker threads, never on the decision loop. Database access uses
the `pg` driver with prepared statements and a pool per process to database nodes in the
process's own facility; Kafka uses `@confluentinc/kafka-javascript` (librdkafka); gRPC uses
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
holding data, which AI5-3 rules out (Architecture issue AI6-2).

#### 5.2 Cluster topology and broker configuration

| Item | Value | Why |
|---|---|---|
| Brokers | 6 per Kenyan facility, 24 in all; none in R3 | §19.2 |
| KRaft controllers | 5 voters: one in each Kenyan facility, one in R3 (metadata only, no partition data) | A controller majority (3 of 5) survives any one region |
| `broker.rack` | The facility (`r1a` … `r2b`) | Rack-aware placement: one replica per facility |
| Replication factor | 4 | One replica per facility |
| `min.insync.replicas` | **3** in steady state; **2** while placement's topology state says fewer than three facilities can hold replicas (a region lost or isolated, or one facility in each region lost) | With four replicas and three required, every acknowledged write is on at least one replica in each Kenyan region; placement lowers it through the admin API when the topology state changes and restores it when it recovers (§7.3) |
| `unclean.leader.election.enable` | false | No acknowledged message is lost by an election |
| `replica.lag.time.max.ms` | 10 s | A lagging replica leaves the in-sync set quickly; `min.insync.replicas` keeps writes two-region meanwhile |
| Partition leaders | Preferred replica in the preferred region (assignment order), `auto.leader.rebalance.enable` = true; placement reassigns preferred leaders on a region-wide failover (§7.4) | Producers (owners) are in the preferred region |
| Follower fetching | `replica.selector.class` = rack-aware; consumers set `client.rack` | Consumers read from their own facility's replica; no cross-region fetch traffic |
| Retention | 3 days for the metering hand-off and charge-line topics; 7 days for every other topic | Transport only (§5.6); the outbox tables keep 25 h and the archive keeps everything |
| Compression | zstd producer batches (headers and clear fields; payloads are already compressed and encrypted) | |
| Security | mTLS between brokers and clients (RFC-005's PKI); ACLs per service: an owner may produce only to its own topics | A1 for transport |

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
epoch, seq) (§5.5). The **takeover republish** (§4.4) adds a third copy only for the last
`republish_window` of a slot that changed holder. Nothing in Kafka is a fact: a lost topic
or cluster is rebuilt from the database (§5.6).

**Report markers.** The request outcome feed carries the slot's report position as markers,
written as outbox rows of the holder's next batch once the position advances (RFC-000
§4.6); the notifier and every other consumer that reports outcomes acts only on outcome
events at or below a marker it has seen.

#### 5.4 Topic conventions

- **Names**: `<owner kind>.<feed>.v<n>` (for example `account.outcome.v1`,
  `ingestion.handoff.v1`, `account.standing.v1`, `notifier.delivery.v1`); relay topics
  `cdc.<owner kind>`.
- **Keys**: the producing partition, so one partition's events stay in order in one Kafka
  partition. Kafka partition counts are a power of two at least the producer's slot count
  divided by 4, and never decrease.
- **Headers**: `partition`, `epoch`, `seq`, `ts` (commit timestamp), `kind`, `schema_v`,
  `key_id`, and for markers `report_through` or `resolved`.
- **Value**: the owner's ciphertext payload; schemas are versioned with the entry kinds and
  kept in a schema registry so every reader can decode every version for 7 years (§13.5).
- **Topics** (RFC-000 §8): the metering hand-off; the request outcome feed (with report
  markers); the reservation lifecycle feed (with resolved markers, the effective-time
  closure); the link schedule feed; the standing feed and the standing enforcement
  acknowledgement; the identity status push; the unposted-usage feed and the usage-applied
  acknowledgement; the charge-line feed and the posting acknowledgement; the ledger
  movement feed; the quarantine and breach report feeds; the partner reconciliation feed;
  the catalogue feed; the placement feed; the operational alert feed; probe results; and
  `notifier.delivery` (§15).

#### 5.5 Consumers: order, deduplication, gaps and replay

- A consumer applies an event only if its `seq` is the next one it expects from that
  partition (higher epoch with the next `seq` included), ignores lower ones, and on a
  **gap** waits `gap_timeout` (5 s) and then reads the missing rows directly from the
  producer's log table by follower read (the log is readable to consumers named in a
  contract), so a lost or delayed Kafka message costs seconds, never a fact.
- An owner that consumes checkpoints (partition, `seq`) in its **own** log, in the same
  batch that applies the event; Kafka offsets are committed only as a restart hint. A
  consumer restart neither skips nor double-applies.
- **Replay from the start.** A consumer rebuilding from older than the outbox's 25 h reads
  the producer's sealed segments from history (§13.3), at lower throughput (about 50 MB/s
  per stream, est.), then switches to Kafka at a resolved timestamp it has passed.

#### 5.6 Kafka failures

| Failure | Effect | Action |
|---|---|---|
| A broker | Its partitions' leaders move within seconds; in-sync set shrinks to 3 | None; replaced as a node |
| A facility | Every partition loses one replica; still 3 in sync | None |
| A Kenyan region | 2 replicas in sync; producers fail with `NotEnoughReplicas` until placement lowers `min.insync.replicas` to 2 (seconds after the topology state changes) | Automatic (§7.3); feeds resume from the surviving region; the takeover republish and the changefeed cover the gap |
| The whole cluster | Feeds stop; facts keep committing (owners do not wait for Kafka); consumers fall behind | RB-15: restore the cluster, then recreate each changefeed from the oldest resolved timestamp any consumer applied (within the outbox's 25 h); consumers fill gaps from the logs (§5.5). Admission is unaffected except for webhooks and status of `pending` outcomes by webhook (polls still answer) |

### 6. Time: clock discipline and the offset alarm ladder

#### 6.1 Sources and distribution

- **Kenyan facilities.** Each facility has two GNSS-disciplined time servers with rubidium
  holdover (drift about 1 µs a day without GNSS), from different vendors, in different racks,
  each a PTP grandmaster (IEEE 1588 with hardware time-stamping on every database, owner and
  edge NIC) and an NTP server. Every host runs `ptp4l` and `chrony` with the PTP hardware
  clock as its reference (`refclock PHC`), both local servers and the same metro's other
  facility as NTP sources, and the other Kenyan region's servers (about 10 ms RTT) as
  cross-checks.
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
  over its pool and takes `offset = db_ts − (t_send + t_recv) / 2` with uncertainty
  `rtt / 2`. The **owner offset bound** is `|offset| + rtt / 2`. Above 50 ms on three
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
| Normal | Offsets within a few ms (PTP: microseconds; R3 NTP: a few ms, est.) | — | — |
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

The fence, the expiry timer and the read-lease margin use one row, `platform_timing`
(version, `ε_cfg`, `δ_x_cfg`, `τ_cfg`), written only by placement and read in every confirm
transaction (§4.3), so a change orders before every later confirm.

| Parameter | Value | Source |
|---|---|---|
| `ε_cfg` | **100 ms** | The database's `max_offset` (RFC-000 coordinator decision) |
| `δ_x_cfg` | **160 ms** | RFC-000's worst-case `δ_x` (R1 lost, owners in R2, both commits through R3), to be confirmed at **p99.9** by the spike (AI-1; Architecture issue AI6-3) |
| `τ_cfg` = max(`ack_budget`, `ε_cfg` + `δ_x_cfg`) | **260 ms** | RFC-000 §4.3: confirms only if `ts` < `D − 260 ms`; expiry entry at `D − 260 ms`; partner confirm window `commit_margin − τ` ≈ 9.7 s |

One configured `τ` for every topology state: the worst-case value is what the fence must
honour at the moment a region is lost, before any measurement catches up, and in steady
state it costs only a request's last 60 ms of commit time. `δ_x` is still **measured** per
topology state (§6.5):

| Topology state (§7.3) | `δ_x` estimate at p99 (RFC-000 §4.3) | p99.9 the spike must show (≤ `δ_x_cfg`) |
|---|---|---|
| Steady (leases and slots in R1) | about 65 ms (30 + 5 + 30) | ≤ 100 ms |
| One facility lost | about 65 to 75 ms | ≤ 110 ms |
| R2 lost, or R1 committing through R3 (double Nairobi–Mombasa cut) | about 145 ms (70 + 5 + 70) | ≤ 160 ms |
| R1 lost, leases and slots in R2 (worst) | about 160 ms (75 + 10 + 75) | ≤ 160 ms |

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
| A-T3 | `τ_cfg` > 300 ms | Page | None beyond A-T2: a fence earlier than `D − ack_budget` still meets POL-26 (stricter), but short deadlines lose commit time. RB-8 |
| A-T4 | Any Share-link release for an expiry durable after `D`; any request still pending at `D` (POL-26) | Page, aggregated per minute | Reported per request (P2-S53, RFC-002); feeds A-T2 |
| A-T5 | Any offset at ladder level A or above (§6.3) | Page | As the ladder |

### 7. Placement, failure detection and region-wide failover

#### 7.1 The placement controller

Placement is an owner on one slot (an admission-class slot, held in the preferred region
with standbys like any other). Its state is tables in the database:

| Table | Content |
|---|---|
| `slot_preference` | Per owner kind and slot: preferred region, preferred facility (by a hash of the slot, spreading slots over the region's two facilities), dedicated-slot overrides |
| `region_preference` | `R1` by default, until the R1 spike measures each Kenyan region's RTT to R3 (RFC-000 R2-D7); changed by failover and failback |
| `topology_events` | Every topology-state change (§7.3), with its detection time and evidence; insert-only; the **recorded losses** that a declaration names (§8.3) |
| `zone_state` | The expected zone configurations (steady, failed over, 2 + 2 for R1 or R2, restoring) and the progress of every change |
| `disasters` | Declared region disasters: the recorded loss they name, declaration and approval (operators, reasons, evidence, times), end and how it ended (restored or replaced) (§8.2) |
| `platform_timing` | §6.4 |

Edges and owners read it through a cache refreshed from the placement feed and on any
`StaleEpoch` or `Moved` answer. **Failover never depends on placement being up**: range
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
| R3 lost | Every R3 node not live for 3 s from both Kenyan regions |
| **Region unreachable** (R1 or R2) | Every node of both facilities of the region not live for **`region_detect`** = 3 s, as seen from **both** other regions (so a double Nairobi–Mombasa cut, where R3 still hears R1, is not this state) |
| Kenyan link degraded | R1 and R2 reach each other only through R3, or with RTT above 25 ms |
| Region gated | More than half of a region's database nodes at clock level A or above (§6.3), or with disk-sync p99 above 20 ms for 30 s |
| Kafka degraded | Fewer than three facilities can hold Kafka replicas |

The state drives the `min.insync.replicas` change (§5.2), the region-wide failover (§7.4),
the automatic 2 + 2 change (§8.1), the dashboards and the `topology_events` record that a
declaration names (§8.3). It does not declare a disaster.

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
| T2 Probes | Admission probes from **both** serving regions fail for `probe_trigger` = 3 consecutive 10 s rounds, while the preferred region is reachable, and the other region's canary commits succeed | A gray failure of the preferred region (overload, disk, a bad deploy there) that the database does not detect. A failure of one region's probes only means that region's edge is failing; it pages instead (RB-12) | Placement: swaps every zone configuration's `lease_preferences` to `[[+region=r2], [+region=r1]]` and drains the leases of R1's database nodes (`cockroach node drain`, nodes stay replicas) |
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
   the slot. Under T1 the old sessions expire by themselves and cross-region standbys take
   the slots; under T2 … T4 holders hand their slots off (§4.2).
4. **Kafka**: placement reassigns preferred partition leaders to the new region; under T1
   it also lowers `min.insync.replicas` to 2 (§5.2).
5. Edges learn new holders from `StaleEpoch` hints and the placement feed.

**Expected time (est.; R1 lost; about 1,700 admission slots over about 300 admission
processes in R2).**

| Phase | From the loss |
|---|---|
| Range leases of every range re-elected and held in R2 (majority R2 + R2 + R3) | 4 to 9 s |
| R1 sessions expire (up to `session_ttl`) | 0 to 3 s, overlapping |
| Admission slots acquired by R2 standbys (each acquisition about 75 ms through R3), in parallel, once the session and slot tables' ranges have their new leaseholders | + 0.1 to 0.5 s |
| Catch-up of the last 1 to 2 s of each slot, `onAcquire`, resumption | + 0.3 to 1 s |
| Edges re-route | + up to 1 s |
| **Every admission slot served from R2** | **about 6 to 12 s** |
| Every other slot (staggered) | about 10 to 18 s |

The design target is **p99 ≤ 30 s** for every admission slot, leaving half of the 1 min
RTO for anything the estimate misses; the R1 spike measures it. Under T2 … T4 the lease
drain of about 25,000 leaseholder ranges (est., §19) by transfers takes about 20 to 60 s
(est.), during which ranges move one by one and slots follow their ranges' class order; no
range is unavailable for more than one transfer (milliseconds).

**What buyers see.** After T1, the R1 edge is down with R1; R2's edge answers again once its
admission slots are held in R2 (about 6 to 12 s); requests in flight resume (POL-03) or
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

and the account and admission tables keep their surviving Kenyan non-voters and drop the
standing R3 non-voter's role, which becomes R3's second voter (`num_replicas` 6 and 2,
`voter_constraints` as above).

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
| Session, slot, placement, approvals, account, link and partner tables (admission) | **Standing R3 non-voter promoted**: one joint-configuration change per range, about 150 ms each through R3, about 50 in parallel per store | **about 1 to 5 min** after the change starts |
| Ingestion, ledger, payments | Learner bootstrapped by delegated snapshot from C1, inside R3, at up to 256 MiB/s per store | about 30 to 60 min (est., about 6 TB per copy) |
| Every other range | As above | about 1 to 3 h (est., the rest of about 35 TB per copy at year 7, §19.4) |

Placement applies the classes' zone changes in this order and waits for each class to
finish before starting the next. Until a range's change completes, all three survivors are
needed for its commits (RFC-000 §5.1); the standing non-voter makes that window minutes for
admission, at the cost of one extra R3 copy of the admission tables (§19.3). R3 capacity
for the second voter set is **reserved** in GCP (a capacity reservation in a second zone),
not obtained on demand, because on-demand capacity in one cloud region during a regional
event is not assured (RK8). Fault tolerance for the non-admission tables takes hours, not
the minutes RFC-000 implies (Architecture issue AI6-4).

The automatic change is **not** made for "Kenyan link degraded" (both regions alive, R1
still commits with R3), for a facility loss, or for R3's loss.

#### 8.2 Declaration (RQ-A, as decided in `requirements-v1.6`)

- **Who** (POL-06, POL-32, X2-S25, X1-S31). An operator in **network operations** declares a
  region disaster through the operator console, with a reason and the evidence of the loss
  (the `topology_events` record it names, facility reports), and the declaration takes
  effect only once a **second network-operations operator** approves it. An attempt by any
  other role is refused and recorded (RFC-005's approvals; the refusal is audited, X1-N8).
  An unapproved declaration lapses after `approval_expiry` (72 h, POL-32), may be cancelled
  by its requester, and its preconditions (an open recorded loss of that region) are
  re-checked at approval. The **end** of a disaster is declared and approved the same way.
- **When** (runbook RB-4): when a whole region has been lost for 10 min with no credible
  restoration within 1 h, or at once on confirmed destruction or loss of power in both its
  facilities. A fibre isolation is **not** a disaster unless the region itself is lost
  (RFC-000 R2-D2).
- **Effects: measurement only.** The 2 + 2 change no longer waits for it (§8.1). The
  declaration records, in `disasters`, the recorded loss it names, both operators, the
  reasons and the evidence; the measurement pipeline then excludes the disaster window
  (§18.4).

#### 8.3 When a disaster counts from (RQ-B, as decided)

POL-06: a declared disaster lasts, for every measurement, **from the loss of the region as
the system recorded it when it happened** until the declared end; a loss never declared
is no disaster.

- **The recorded loss** is a `topology_events` row of kind *region unreachable* or *region
  gated* for that region, written by placement at detection with its detection time, or the
  T2 failover record for it. It is insert-only, written by placement's role only, and its
  time is the detection time (the first second of the 3 s `region_detect` window, not its
  end), so it cannot be backdated or moved.
- **A declaration must name an open recorded loss** of the region; it cannot state its own
  start time. Whatever start an operator writes in the reason (X2-S26's 09:40) is kept as
  text and ignored by the measurement: the window starts at the recorded loss (10:00), and
  the minutes before it count as usual.
- **A loss never declared** leaves no window: every minute counts against every target, in
  each serving region (X2-S28). The recorded loss is still kept, and the monthly report
  lists it.
- **The end** is the approved end declaration's time. A disaster can be ended only once the
  region is restored or replaced (§8.4).
- A region that is reachable but unusable without being gated (for example its edges down
  with its database healthy) has no recorded loss, so it cannot be declared; it counts
  against availability (Requirements issue RQ6-3).

#### 8.4 Restoration or replacement

- **Restored region.** Its database nodes are wiped and rejoin as **new nodes** (the old
  node IDs are decommissioned, so no stale replica rejoins). Placement reverts the zone
  configurations to 2 + 2 + 1 in class order (system, admission, …): the allocator adds the
  region's voters by snapshot over the Nairobi–Mombasa paths (about 35 TB per copy at year
  7, about 4 to 8 h at 10 to 20 Gbps, est.) and demotes R3's second voter back to the
  standing non-voter (admission) or removes it. Kafka partitions are reassigned to the
  region's brokers and `min.insync.replicas` returns to 3. Owner processes start as
  cross-region standbys. Once every range is at 2 + 2 + 1 and the region's probes pass,
  operators declare the end (four eyes, §8.2), and failback follows by order (§7.5).
- **Replacement.** A new site takes the lost region's place with new nodes and localities,
  by the same steps. Before the disaster is ended as "replaced", the new site's RTTs are
  measured (§22.1) and the go-live fibre condition is re-verified for it (§20).
- **The end time** in `disasters` ends the measurement exclusion (§18.4).

#### 8.5 Degraded latency, and the two-write path (R13)

After a region loss, a single-link final answer is about 230 ms (R2 lost) or 245 ms (R1
lost) at p99, with `pending` within about 90 ms (RFC-000 §3, est.). RFC-000 R13 asks RFC-006
to evaluate a two-write single-link path for this state and for the double
Nairobi–Mombasa cut. On this substrate it would be about 10 + 6 + 2 × 70 + 5 = 160 ms, so
**within** 200 ms.

**Decision: not built for go-live; kept as the first lever.** During a declared disaster the
latency targets are suspended (POL-06), so the path would help only the undeclared cases:
the minutes before a loss is detected are few, and the double Nairobi–Mombasa cut needs two
independent cuts under the go-live condition (§20) and is repaired as a priority-one
incident (RB-7). Against that, the path makes the decision a derived fact over two logs,
which costs the single decision point (POL-04) a resolution step in every status read and
ordering against suspension, revocation and withdrawal (RFC-000 Competition). It is
re-evaluated if the spike measures the degraded state worse than estimated, or if a double
cut or an isolated region occurs in production (Risk RK19). A **replacement site** is not
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
path: `append` returns success only at `Committed` (§12.2), and the edge's final answer, the
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
| Admission, with the funds holds and headroom checks a booking needs (X2-S21) | 1 min | Owner process or host: 3.5 to 4.5 s; database node under the slot's ranges: 4 to 9 s | 1 h | 6 to 12 s to slots in R2; R2 edge serving | §4.4 takeover; §3.3 range-lease failover; §7.4. The account owner is an admission-class slot, so its funds module recovers with it (RFC-000 §2) |
| Usage ingestion | 1 min | As admission | 1 h | about 7 to 13 s | Same; exporters retry to the other region's edge (anycast) |
| Rating and posting | 5 min (ceiling) | about 4 to 5 s on the attribution → unposted-usage and accrual-posting paths (hot standbys, AI3-9); up to 9 s if a database node under them is lost | 1 h | about 10 to 15 s | §4.4 hot standbys; §10.3 |
| Wallet, other operations | 5 min | seconds | 1 h | about 10 to 15 s | Status readers in both regions; payments and ledger slots |
| Payouts | 15 min | seconds; a run resumes by reference (RFC-004) | 1 h | about 15 s | Payout slots; instructions are facts |
| Reporting and statements | 30 min | seconds (read models in both Kenyan regions) | 1 h | seconds | Read models kept in R1 and R2, each fed from Kafka; a lost region's copy is not used |

Every RTO is verified by failure injection (§22.2), measured from the injection to the
capability's probes succeeding again (X2-S10).

#### 10.2 Availability budget arithmetic

A month has 43,200 minutes; 99.99% allows **4.32 unavailable minutes**, 99.9% allows 43.2.
A minute is unavailable if more than 10% of its probes fail (§17.3). Admission and the
wallet are probed about 1,100 times a minute per region (§17.1), spread over every account
slot, so an event that stops a fraction `f` of slots for `s` seconds fails about `f × s / 60`
of a minute's probes.

| Event | Probes failed in the worst minute (est.) | Unavailable minutes per event (est.) | Events a month the 99.99% budget allows |
|---|---|---|---|
| Owner process or host loss (its slots, about 1 to 2% of a kind's slots, for 4 s) | well under 1% | 0 | unlimited |
| Database node loss (its leaseholder ranges, about 1/24 of R1's, for up to 9 s) | about 0.6% | 0 | unlimited |
| Facility loss in the preferred region (half the slots and leases for up to 9 s) | about 8% | 0 to 1 | at least 4 |
| Region-wide failover after T1 (every slot for 6 to 12 s, the surviving region) | 10 to 20% | 1 | 4 |
| Rolling deploy, one facility at a time, leases drained and slots handed off first | 0 | 0 | unlimited |

Node losses are therefore affordable at the expected rate; facility and region events
spend the budget. This is why upgrades always drain leases and hand slots off first
(planned maintenance is not excluded, POL-06).

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
| 4.5 s (hot standby, §4.4, p50) | none | 0 |
| 5 s (hot standby, p99, AI3-9) | none | 0 |
| 9 s (a database node under the path's ranges, worst estimate) | records accepted over about 3 s | 1 |
| 5 min (the RTO ceiling) | records accepted over about 7.4 min | 8 or 9: **the whole month's budget** |

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
| A database node holding range leases | Raft leader loss on its ranges; node liveness | The database re-elects each range's leader among survivors (R1 peer first) and moves the lease; after 5 min, replicas replaced in the same facility | RPO 0. Writes to its ranges wait 4 to 9 s (est.). No unavailable minute (§10.2). Latency unchanged after |
| A database node without leases | Liveness | Replicas replaced after 5 min in the same facility | None; its ranges have 4 of 5 meanwhile |
| An owner process or host | Its session expires (3 s) | In-region hot standbys take its slots (§4.4) | RPO 0. 3.5 to 4.5 s for its slots. Latency unchanged |
| A status-reader process | Its read leases lapse (400 ms) | The holder stops waiting for it; supervisor restarts it with fresh leases | Reports wait at most one lease; polls retry to another reader (rule 4) |
| An edge or stateless worker node | Load-balancer health check, 2 s | Removed from rotation | Requests in flight retried by clients (POL-29). None measurable |
| A Kafka broker or controller | Kafka | Partition leaders move; controller quorum keeps 4 of 5 | None on facts; feeds pause for seconds |
| A rack | As its nodes | As its nodes; at most one replica of any range is in a rack | As a few node losses |
| A facility in R1 (preferred) | All its nodes not live 3 s from three viewpoints (§7.3) | Range leases move to `r1b`; in-region standbys there take the slots | RPO 0. 4 to 9 s. 0 to 1 unavailable minute. Latency about 115 to 135 ms |
| A facility in R2 | As above | None for leases; commits use the R1 peer and the other R2 voter, R3 as spare; cross-region standbys of the facility's slots are re-homed to the other R2 facility | RPO 0. None on RTO. Latency about 115 to 135 ms |
| Region R1 lost (or isolated) | T1: R1 not live 3 s from R2 and R3 | Database moves leases to R2; region-wide failover of slots (§7.4); Kafka `min.insync.replicas` 2 | RPO 0. Admission back in R2 in 6 to 12 s. R1 unavailable. R2 final answers about 245 ms, `pending` about 90 ms. Counts against every target unless declared, and then from the recorded loss (§8.3) |
| … still unreachable after `region_detect` + 10 min | Placement timer | **Automatic 2 + 2** (§8.1), declared or not | One further fault tolerated: admission within minutes, the rest within hours |
| … declared | Network operations, four eyes (§8.2) | Measurement exclusion from the recorded loss | Latency targets suspended; availability not measured; charges within target + 1 h (POL-06) |
| Region R2 lost (or isolated) | T1 for R2 | None for leases or slots (they are in R1); the slots have no cross-region standby until R2 returns (their in-region standbys remain); Kafka `min.insync.replicas` 2; after 10 min, automatic 2 + 2 | RPO 0. R1 final answers about 230 ms (commits through R3). R2 unavailable; counts unless declared |
| Region R3 lost | All R3 nodes not live | None (R3 is never on the commit path while Kenya is whole); Kafka controller quorum keeps 4 of 5 | None; each range tolerates one more Kenyan fault, not two. GCS archive and backups paused; Ceph copies continue (§13.2) |
| One Nairobi–Mombasa path | BFD, sub-second | Traffic on the diverse path | None material: about 115 to 125 ms |
| Both Nairobi–Mombasa paths (two independent cuts) | "Kenyan link degraded" | None: R1 keeps leading (R1 + R1 + R3); priority-one repair (RB-7) | RPO 0. R1 final answers about 230 ms, `pending` within budget; R2 reaches the owners only through R3. Counts against availability and latency (not a disaster, RFC-000 R2-D2) |
| The R1–R3 or R2–R3 path | BFD; R3 replica lag | None | None; ranges lose their spare voter for the duration |
| Clock: one database node drifting | Ladder (§6.3) | Leases drained at 40 ms; self-termination at 80 ms | None beyond lease transfers |
| Clock: one owner host drifting | Owner offset check (§6.2) | Hand-off at 40 ms; session given up at 50 ms | As an owner host loss at worst |
| Clock: a region's time sources fail, or GNSS spoofed there | Ladder; cross-region and external references | Region gated → T3 failover | As a region-wide failover. Safety intact: confirms fail safe |
| Clock: the whole cluster drifts together | External references (§6.2) | None automatic; RB-8 | Deadlines judged against drifted time; never an oversell or partial booking (A8) |
| An owner's event loop stalls (GC, blocking) | Loop-delay monitor | Session given up above 200 ms twice in 10 s (§4.7) | As an owner process loss |
| Slow disk or gray database node | Disk-sync p99 > 20 ms for 30 s; `storage.max_sync_duration` | Leases drained from it; it terminates itself after 10 s of stall | Latency spike for its ranges limited to tens of seconds |
| Gray failure of the preferred region | T2 probes in both regions, or T3 | Region-wide failover by preference swap and drain (§7.4) | 1 to 3 unavailable minutes (30 s of trigger plus the move) |
| A hot link above its slot's capacity | Batch queue length, per-link request rate | Placement moves the link to a dedicated slot (§4.5) | About 100 ms of `Moving, retry` for that link |
| A hot range | Database load-based splitting | Split and rebalance by the database | None visible |
| Placement holder lost | Its session expires | Its standby takes the slot | None on targets; placement actions pause for seconds |
| A changefeed paused or failed | Changefeed status and lag metrics | Pages at 1 min lag; owners' direct publish continues | None while direct publishing works; RB-16 |
| Kafka cluster lost | Producer errors | Facts keep committing; webhooks and feed consumers stop | RB-15; webhooks late; polls answer; ratings and postings fall behind and catch up (X2-S13 minutes may breach) |
| Archive store unavailable (Ceph in one region, or GCS) | Seal-write failures; archive lag 10 min | Sealing continues to the other two stores; truncation waits for two regions | None while two of three accept; the tail buffers 24 h (§19.4) |
| All archive writes failing | Archive lag 1 h page | Truncation stops; the database grows | None for 24 h; then disk risk (RB-9) |
| Backup schedule failing | Schedule status | Pages after two missed incrementals | None on targets; recovery from logical corruption loses PITR coverage (RB-10) |
| HSMs unavailable in one region | RFC-005's health checks | Owners use the other region's HSMs; data keys cached | None |
| HSMs unavailable in both regions | As above | Owners continue on cached and pre-generated data keys (RFC-005) | None for the cache's horizon; then writes stop (RFC-005 R21) |
| A bad software release (logical fault, crash loop) | Canary facility's digest mismatch (§14.2), crash loops, probe failures | Rollout halts automatically; one facility at a time, leases drained first | Bounded to the canary facility; RPO 0; a faulty apply is corrected by replay (§14.3) |
| A partition between R1's two facilities | Liveness from each side | Ranges keep a majority on the side with R2 and R3 connectivity; leases move there | None material |
| Notifier endpoint failures | Delivery failures | Backoff for `webhook_retry`; per-endpoint isolation (§15) | None on other buyers |
| A probe location fails | Runner heartbeat | Two locations remain; page | None while two remain (§17.3) |
| Alert pipeline fails | Dead-man's switch | External watchdog pages | None on targets |

### 12. The platform contract

This section is the complete semantics of RFC-000 §8's **substrate conventions** contract:
"database topology and zone configurations, log-table schema, owner leases and
epoch-conditional writes, leader placement for every group and region-wide failover, the
automatic 2 + 2 reconfiguration, closed and report positions, read leases and status
replicas, the transactional outbox, changefeeds and Kafka topics; the clock bound `ε` and
the monitored quantities". It is a TypeScript interface of the owner runtime (§4); the
delivery phase defines the exact signatures.

#### 12.1 Schema

- Each owner RFC declares its kinds' log entry kinds (with retention class), projections,
  outbox destinations and readable contracts; RFC-006's migration tool creates the tables
  of §3.7 with their zone configurations (§3.2), grants and pre-splits.
- Owners never write SQL against log or outbox tables directly; they use `append` (§12.2).
  Projections are written only inside `append`'s transaction, from the batch's entries.

#### 12.2 Lifecycle and appending

- `onAcquire(slot, epoch)` and `onRelease(slot, reason)`: called when a slot is taken
  (after the catch-up of §4.4) and when it is lost or handed off. Between them the owner is
  the slot's only writer.
- `append(partition, entries[], projections, outbox[]) → Committed(seqFrom, seqTo, ts) |
  Retry | StaleEpoch | Ambiguous | Overloaded(retryAfter)`, as §4.3. **Committed** means
  durable on a majority spanning two regions; it is the only success. Every other result is
  "not known to be committed"; the caller retries with the **same identities**, and the
  owner's entries deduplicate by identity in the same transaction that applies the effect
  (A6). The runtime batches calls per partition (one transaction in flight).
- `conditions`: an `append` may carry conditions over rows of its own slot (for example
  "no decision row for request r") and over `ts` ("`ts` < `D − τ`"); a failed condition
  commits nothing and returns which failed.
- `leaseValid() → { valid, untilMonotonic }`: the owner must check it immediately before
  any action taken from memory rather than through `append` (a headroom answer, the checks
  before a partner confirm, a command sent, RFC-000 §3).
- `epoch()`: the slot's epoch, put in every command the owner sends (§4.5).

#### 12.3 Time

- Entry timestamps are the commit timestamps the runtime assigns (§3.7); owners never stamp
  entries themselves.
- `timing() → { version, epsilon, deltaX, tau }` as read in the transaction (§6.4); the
  fence condition reads `tau` from there.
- `now() → { ts, bound }`: the database's time as last sampled and the owner offset bound
  (§6.2), for liveness only (timers, expiry proposals), never to decide an outcome (A8).

#### 12.4 Positions and reads

- `reportPosition(slot)` and `onReport(slot, P)`: the report position (§4.6); owners report
  outcomes only at or below it.
- Read leases are the runtime's (§4.6); a status reader gets `readLease() → { valid,
  untilMonotonic, appliedThrough, reportPosition }`.
- `replicaRule3Check(accountSlot, requestKey) → { holderLive, rows }`: the consistent read
  of §4.6, for RFC-002's rule.
- `consistentRead(fn, at = 'present' | T)`: a read-only transaction at the present timestamp
  (leaseholders) or at a fixed `T` (`AS OF SYSTEM TIME`), for cuts (§3.4).
- `followerRead(fn)`: a read from the caller's own facility's replicas at
  `follower_read_timestamp()` or bounded staleness, returning the timestamp served.
- `closedTimestamp()`: `follower_read_timestamp()`, a timestamp at or below the closed
  timestamp of every range, used as the conservative "closed through" for the ledger and
  the sealer.

#### 12.5 Feeds

- `outbox` rows in `append` (§12.2) are the only way to publish; the runtime publishes them
  after `Committed` and the changefeed relays them (§5.3).
- `subscribe(topic, fromCheckpoint, gate = 'committed' | 'reported') → events in seq order
  per producer partition, deduplicated, gaps filled from the log (§5.5)`. `reported`
  delivers outcome events only at or below a report marker (A10).
- Delivery is **at least once, in `seq` order per producer partition**, with no order across
  partitions (RFC-000 §4.5). A consumer that is an owner checkpoints in its own `append`.
- Resolved markers: `onResolved(topic, R)`: no event with `ts` ≤ `R` will follow on that
  topic (the lifecycle feed's effective-time closure).
- **Replay from the archive** below the outbox's 25 h is served by history (§13.3).

#### 12.6 Timers

- `timer(partition, key, atTs)`: a holder-only timer, persisted only as part of the
  partition's state (the owner records the deadline in an entry); on `onAcquire`, the owner
  re-arms its timers from its state. Firing a timer only makes the owner append an entry;
  timers never decide (A8).

#### 12.7 Routing and placement

- `route(kind, partitionKey) → { slot, holderHint, epoch, readers }` from the placement
  cache. Commands carry the epoch; `StaleEpoch`, `Moved` and `Moving` refresh the cache.
- `topology() → { state, preferredRegion, disaster }`: the topology state (§7.3), the
  preferred region and any declared disaster, for owners that must know (RFC-002 may
  shorten its `pending` threshold in a degraded state).

#### 12.8 Encryption

- The runtime calls RFC-005's library on every payload before `append` and every outbox
  value before publishing; decryption is in the consumer's runtime. Payloads are compressed
  before encryption. Clear columns carry only pseudonymous identifiers (A11).

#### 12.9 Guarantees the platform gives, and what it requires of owners

| Guarantee | Requires of the owner |
|---|---|
| One writer per partition at any moment (§4.2, §4.3, §4.5) | Every effect is an entry; nothing is decided from memory without `leaseValid()` |
| Two-region durability of every acknowledged entry (§9) | Acknowledge nothing before `Committed` (or the report position, for reports) |
| `ts` strictly increasing per partition across owners, never at or below a closed timestamp, within `max_offset` of the database's other clocks | Compare times only through entry fields and `timing()` |
| A reported entry is found by every later reader (§4.6) | Report only at or below the report position |
| Feeds at least once, ordered per partition, nothing lost (outbox, two paths, gap fill) | Consume idempotently by (partition, epoch, seq) (A6) |
| Placement, failover and the 2 + 2 change never create two writers or lose an entry | Handle `StaleEpoch`, `Moved`, `Moving` and `Ambiguous` by re-routing or reloading and retrying with the same identity |
| 7-year retention of every entry of a `7y` class (§13) | Declare each entry kind's retention class; keep every decoder version (§13.5) |
| Personal data never stored by the platform (A11) | Put only pseudonymous identifiers in clear columns, headers, audit fields and logs |

#### 12.10 Platform parameters (defaults)

| Parameter | Default | Section |
|---|---|---|
| `max_offset` (`ε`) | 100 ms | §3.6, §6 |
| `δ_x_cfg`, `τ_cfg` | 160 ms, 260 ms | §6.4 |
| `session_ttl`, `session_renew` | 3 s, 500 ms | §4.2 |
| `standby_poll`, `standby_grace` | 250 ms, 1 s | §4.4 |
| `republish_window` | 30 s | §4.4 |
| `batch_retries` | 5 | §4.3 |
| `heartbeat_interval` (owner → readers) | 100 ms | §4.6 |
| `read_lease` | 400 ms | §4.6 |
| `status_shards` | 8 per facility | §4.6 |
| `max_loop_delay` | 200 ms | §4.7 |
| `kv.closed_timestamp.target_duration` | 1 s | §3.4 |
| `gc.ttlseconds` | 4 h; outbox 25 h | §3.6 |
| `region_detect`, `reconfig_delay` | 3 s, 10 min | §7.3, §8.1 |
| `probe_trigger`, `failover_damping` | 3 rounds (30 s), 30 min | §7.4 |
| `drift_correct` | 10 s | §7.2 |
| `gap_timeout` | 5 s | §5.5 |
| Kafka `min.insync.replicas` | 3 (2 while degraded) | §5.2 |
| `seal_interval` | 60 s or 64 MB | §13.2 |
| `tail_buffer` | 24 h | §13.2 |

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
**write-once with a retention lock of 7 years + 90 days** from the segment's newest entry
(GCS bucket lock; Ceph object lock in compliance mode); deletion after that is a lifecycle
job enabled only once legal confirms the period, per market. Nothing inside 7 years can be
deleted by anyone, operators included (X1-S15). Erasure of personal data never touches the
archive, because no personal data is in it (X1-S34, X1-S37).

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
  kind are recorded in an insert-only `sealed` table (§13.4).
- **Tiers.**

  | Tier | Age | Copies | Stores |
  |---|---|---|---|
  | Live tail | Minutes (up to `tail_buffer`, 24 h) | 5 voters (+ non-voters) | The database |
  | Hot archive | Up to 13 months | 3: one in each Kenyan region, one in R3 | Ceph RGW (erasure-coded 8 + 3 across the two facilities of the metro) in R1 and R2; GCS in `africa-south1` |
  | Cold archive | 13 months to 7 years + 90 days | 2, in two regions and with two operators: one Kenyan Ceph copy (R1 or R2 by a hash of the segment) and the GCS copy (Archive storage class) | Ceph RGW; GCS |

- **Two-region durable** means any two of the three stores have acknowledged the segment and
  its checksum has been verified on read-back.
- **Truncation.** The **truncator** role, the only role with DELETE on log tables, deletes a
  slot's rows with `ts` ≤ `T` only once the segment covering them is two-region durable,
  and never rows newer than the oldest resolved timestamp of any registered consumer that
  is less than `tail_buffer` behind. Its deletes are range deletes in `seq` order and their
  MVCC garbage is collected after `gc.ttlseconds`. With the archive healthy the live tail
  is minutes of log (est.); the database is sized to buffer 24 h (§19.4), and archive lag
  alarms at 10 min (warning) and 1 h (page).

#### 13.3 Indexes and queries

- **Per-slot index**: `seq` range and `ts` range → segment, kept in the history service's
  catalogue (a read model, rebuilt from the segments if lost).
- **Entity indexes**, declared by the owning RFC: reservation → partitions and `seq`
  (RFC-002); link → schedule entries by valid minute range (RFC-001); source reference →
  movement (RFC-004); (exporter, epoch, sequence) and (reservation, link, minute) → records
  (RFC-003, P3-S39).
- **Bitemporal projections** for the query kinds the owner RFCs define (the link schedule as
  known at T, P1-S33; a reservation's history; the inputs to an account's headroom at a
  position, P4-S72), with valid-time and transaction-time intervals per entity, updated
  from Kafka and backfilled from segments.
- **Queries**: `asKnownAt(entity, T)`, `history(entity, from, to)`, `entries(partition, seq
  or ts range)` (served from the live tail and the archive seamlessly), `replayFrom(partition,
  seq)` for consumers (§5.5). Result semantics are the owner RFC's; RFC-006 guarantees
  completeness (every committed entry of a `7y` class is returned for its range) and
  immutability.
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
    WITH revision_history, kms = '<backup key URI>'
    RECURRING '@hourly' FULL BACKUP '@weekly'
    WITH SCHEDULE OPTIONS first_run = 'now', on_previous_running = 'wait';
  -- and backup_ceph to 's3://share-backup?AWS_ENDPOINT=https://rgw.r2.share.internal'
  -- (Ceph RGW in R2; R1's for a database whose leases are in R2)
  ```

- **Scope.** Every table except the high-volume ingestion, attribution and rating log and
  outbox tables, whose rows the archive holds write-once within `seal_interval` plus the
  archive lag; the account, link, partner, ledger, payments and every other log are
  included. This keeps the incrementals to about 60 MB/s per destination (est., §19.3).
- **Encryption.** Backups are encrypted with a backup key held in the Kenyan HSMs, exposed
  to the scheduler through a KMS interface; payload columns are already ciphertext (§3.7),
  so a GCS backup is ciphertext twice over.
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

#### 14.4 The personal-data store: backups and key destruction (A11, X1-N11)

RFC-005 owns the personal-data store; RFC-006 runs its storage. Its tables are in the same
database, with their own zone configuration (2 + 2 + 1, no non-voters), encrypted per data
subject with subject keys held in an HSM-backed key store in both Kenyan regions.

- **Data backups** are part of the database backups (§14.1); they hold only ciphertext.
- **Key-store backups** are taken daily, encrypted under the HSMs' master key, kept for
  `pds_key_backup_retention` (35 days) under object lock, in Kenya only.
- **Erasure** destroys the subject's key in the live key store at once (RFC-005), so every
  live copy is unreadable immediately; every backup of the data is unreadable once the last
  key-store backup holding the key expires, at most 35 days later. Restores of the key store
  re-apply every erasure recorded since the backup (erasures are themselves facts in
  identity's log), so a restore never resurrects an erased key. Whether 35 days is an
  acceptable completion time for erasure is not stated in the requirements (Requirements
  issue RQ6-1).

### 15. Notifier

RFC-000 §2: "deliver every outbound notice: signed buyer webhooks retried for
`webhook_retry`, affected-reservation notices within `affected_notice_time`, suspension and
low-balance notices, supplier notices, operational alerts".

**Structure.** The notifier is an owner on 256 slots partitioned by account. For each input
event it appends a **delivery** entry (destination, content reference, idempotency identity
= (source partition, `seq`, destination)) and an outbox row to `notifier.delivery.v1`;
**delivery workers** (stateless, in both Kenyan regions) consume that topic, make the
attempt, and send the result back to the notifier, which appends it as an entry. Deliveries
therefore survive failover and are never lost or duplicated by a restart, only retried, and
the receiver deduplicates.

| Input feed (gate) | Notice | Destination |
|---|---|---|
| Request outcome feed, RFC-002 (`reported`) | Outcome of a request answered `pending` (P2-S09) | The account's registered webhook endpoint (from identity and access, RFC-005; X1-S24) |
| Reservation lifecycle and affected-status feed, RFC-002 (`committed`) | Affected reservation, restoration, revocation, offers (P1-S26, P1-S40, P1-S50, P1-S72; POL-07) | The holder's webhook and notice list |
| Link schedule feed, RFC-001 | Affected reservations and restorations; a confirmation completed across a reduction (P1-S63) | Network operations' integration |
| Account owner standing and funds feeds, RFC-004 | Suspension, release at the end of the grace (P4-S23), low balance, resume amount | The account's webhook and notice list |
| Supplier-facing feeds, RFC-001 and RFC-004 | Supplier notices | Supplier endpoints |
| Operational alert feed (§16) | Pages and messages to people | Paging provider, chat, e-mail, by routing rule |

**Delivery semantics.**

- **Told** (RQ-E, as decided; POL-04, P1-S75): a principal has been told once the notice is
  recorded in its account's **notice list** (a projection of the notifier's log, readable
  through the API) **and its first delivery attempted**, within the notice's time; delivery
  is then retried for `webhook_retry`. The notifier records both times, and the measurement
  of `affected_notice_time` uses them (§18.2).
- **At least once**, each delivery carrying its identity as an event ID; receivers
  deduplicate. A request's outcome is final once reported, so its outcome webhook never
  contradicts another.
- **Signed** by RFC-005's signing service with the event ID and a timestamp inside the
  signature (X1-S11).
- **Retries**: at once; on failure or no 2xx within 5 s, exponential backoff from 1 s
  doubling to a cap of 1 h, with jitter, for `webhook_retry` (24 h); then recorded as given
  up, visible to the buyer and support. The outcome is still available by poll (POL-04).
- **Isolation**: one queue and concurrency limit (4 in flight) and a circuit breaker per
  endpoint, so a slow or failing endpoint delays only its own account.
- **Personal data** (A11): contact details for e-mail notices are read from the
  personal-data store at send time by the delivery worker and never written to the
  notifier's log, Kafka or any application log.
- **No order across requests**; per reservation, notices are sent in `seq` order.

**Timing (est.).** Affected notices: the link owner records the outage (RFC-001); its feed
reaches the account owner and the notifier within tens of milliseconds by direct publish
(about 2 s by the relay); the first attempt is within about 1 to 3 s of the record, against
`affected_notice_time` (60 s). Outcome webhooks: first attempt within about 1 s of the
report.

**Load (R10, X2 open question 2).** No target exists. Provisional: one webhook per request
answered `pending` (about 5,000 to 7,000/s at the design load, RFC-000 §6), plus notices;
sized for **20,000 deliveries/s** with retries, to be replaced by measurement.

### 16. Operational alerts

The **operational alert feed** (RFC-000 §8) is how every owner raises an alert (P2-S53,
P2-S104, P1-S63, P4-S81, reconciliation differences P4-S54, P4-S80, P4-S91, POL-14 breach
reports, and every platform alarm in this RFC).

- **Raising.** An owner raises an alert as an entry in its **own** log with an outbox row
  (kind `alert`, with kind, severity, the entities concerned by pseudonymous identifier,
  reason and identity), so the alert is as durable as the fact that caused it and cannot be
  lost by a failing alert service. Platform components without a log (the clock monitor,
  the conformance report) raise through the alert service's own `append`.
- **Alert service.** An owner on 8 slots: deduplicates by identity, tracks raised →
  acknowledged → resolved, escalates unacknowledged pages after 5 min, and routes by kind to
  the role that acts on it (network operations, finance, compliance, support, platform
  on-call). Routing rules are data.
- **Visibility.** Alerts and the requests in trouble behind them are listed in the operator
  console with their reason and the leg concerned (P2-S51, RFC-002).
- **Dead-man's switch.** Every alert producer and the alert service send a heartbeat every
  minute to a watchdog **outside** Share's sites, which pages through an independent
  provider if heartbeats stop.
- **Error-budget alerts** (§18.5) and the alarms of §6 use the same path.

### 17. Probes and availability measurement

#### 17.1 The probe estate

| Item | Design |
|---|---|
| Probe runners | Three colocation sites per serving region, outside Share's facilities, within about 10 ms (RFC-000 D2); persistent TLS connections to the region's **unicast** edge address (§2), so each region is measured on its own |
| **Probe accounts** (RQ-C, X2-S27) | **One designated probe account per account slot** (1,024 at the design load; one more for every slot added), each Share-internal, with identifiers chosen so that each hashes to its slot. "Every part of admission and the wallet that serves accounts" is read as **every account slot**, the unit in which the account owner, its funds module and its status reads are owned, fail and fail over (§4.1); probing every slot every minute means no slot can fail unseen (Requirements issue RQ6-2 asks the requirements to confirm the reading). Each has a `credit_limit` set by a finance operator (POL-15, POL-32), counts as vetted, is never invoiced, and has one agent key per runner. No probe account is a buyer's account (designation is set only on a new Share-internal account, §17.4) |
| Probe links | 64 designated probe links per serving region, each a Share link on Share's own equipment in that region with a large virtual capacity (10 Gbps), spread over link slots and both facilities' processes |
| **Probe supplier** | One designated Share-internal supplier owning every probe link; it never earns (nothing is settled), and its payout runs always end "nothing due" (X2-S20, RQ-C) |
| Probe exporters | Eight per serving region, spread over ingestion slots |
| Schedule | Admission and wallet: each runner probes one probe account per call, cycling through all of them, the three runners offset, so every account slot gets **at least one admission probe and one wallet probe a minute** from each region (about 1,100 each a minute per region, about 18 a second). Ingestion, payouts and reporting: each runner every 10 s, offset by about 3.3 s, **18 a minute** per region. Every capability is therefore probed at least every 10 s from three locations (X2-S16) |

#### 17.2 Per-capability operation and "correct answer" (X2-S18)

| Capability | Operation | Limit | Correct when |
|---|---|---|---|
| Admission API | Book a single probe link, 1 Mbps, window [next minute, +1 min), `wait = true`, fresh idempotency key, as the probe account of the slot due; probe links rotate | 200 ms | A well-formed answer for this request: confirmed (expected, since probe links always have free capacity), or `pending` whose outcome, read later, is confirmed. A rejection, an error, a different request's answer or a `pending` that ends not confirmed is incorrect (scored retroactively) |
| Usage ingestion | Send one flow record from a probe exporter with the next (epoch, sequence); every tenth probe resends an earlier record | 1 s | Acknowledged as accepted, naming that record; a resend acknowledged as the same accepted record (never accepted twice, P3-N3) |
| Wallet | Ask for the probe account's balance and headroom | 200 ms | Well-formed, carrying its account-log position, internally consistent (headroom = balance − funds held − usage exposure + credit limit, POL-18), with the credit limit finance set |
| Payouts | Ask for the status of the probe supplier's latest payout run | 1 s | Well-formed, for the run expected by the schedule, "nothing due" |
| Reporting and statements | Ask for a probe account's statement for the previous UTC day | 2 s | Well-formed, for that day, containing no charges and the credit holds as expected |

The probes take the real path: edge, identity, account owner (credit hold against the
credit limit, X2-S24), link owner, report position, status readers. The limits are measured
end to end at the runner (RFC-000 §3: about 125 to 135 ms for admission, est.).

#### 17.3 The available minute (X2-S16) and the monthly figure (X2-S01)

- Probe results (runner, region, capability, probe account or exporter, send time, latency,
  correctness, error) are recorded by the probe-results owner (4 slots), timestamped by the
  runner's NTP clock; a result scored incorrect retroactively is a new entry, not an edit.
- A **minute** (UTC) of a capability in a region is available if at least 90% of its probes
  succeeded (POL-06).
- A minute with **fewer than 12 probes, or probes from fewer than two locations**, counts as
  **unavailable** and pages: the measurement never makes a minute available by the absence
  of evidence. A minute in which an account slot got no admission or wallet probe (an X2-S27
  coverage gap) pages as a measurement fault and is flagged in the monthly report.
- Availability per capability, per serving region, per calendar month = available minutes /
  minutes in the month, leaving out the minutes of a declared disaster (§18.4). Planned
  maintenance is not excluded.
- Monthly reports are generated from the probe-results log and kept 7 years with the
  results, so every figure can be recomputed.

#### 17.4 Probe designation and isolation (X2-S20, X2-S24, X2-S27)

RFC-006 owns the "probe designation and exclusion" contract (RFC-000 §8). Its rules:

1. **Designation** is an attribute of an account (identity and access), a supplier, a link
   and an exporter (catalogue). It is set only at provisioning, by an operator (finance for
   the accounts' credit limits; network operations for links, exporters and the probe
   supplier), with a reason, audited (RFC-005). It can be set only on an entity with no
   history, and **never cleared**, so no real link, account, supplier or exporter can be
   turned into a probe one to hide revenue, and no probe one can start earning.
2. **Probe traffic stays probe traffic.** A probe account may book only probe links, and a
   non-probe account may not book a probe link: the account owner refuses such a request at
   intake as invalid (RFC-002 enforces). Probe exporters report only flows on probe links.
3. **Exclusion.** Rating produces no charge line for a reservation of a probe account or a
   record from a probe exporter (RFC-003); settlement therefore receives nothing (RFC-004);
   supplier reports leave out probe links; quarantine reports leave out probe exporters'
   records; reconciliation is unaffected because no movement exists. Every consumer checks
   the designation in the catalogue or identity; since designation never changes, any
   position gives the same answer.
4. **Real funds path.** Each probe account's credit holds are real (POL-06, X2-S24): they
   gate its bookings like any account's and are released when the reservation ends
   (RFC-004). Each credit limit is sized for its rate: at most about 2 bookings a minute per
   region × 2 regions, each holding its coverage for a 1-minute reservation of 1 Mbps; finance
   sets the limits with that figure and the alert "probe account headroom below 25%".
5. **Retention.** Probe records and reservations are kept like any (they are facts); their
   volume is about 2 × 1,100 bookings a minute, under 0.02% of the design load.
6. **What probes do not show.** Probes cover every account slot, but statistically, not
   deterministically, every edge node and status-reader process. Internal canaries (§18.5)
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
one another, normally well under 1 ms with PTP) or boundary times recorded by the edge or
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

The measurement pipeline reads the `disasters` table (§7.1). A window runs from the
**recorded loss** the declaration names (§8.3) to the approved end; minutes before the
recorded loss, and every minute of a loss never declared, count as usual.

| Measurement | Treatment in the window |
|---|---|
| Availability (X2-S01) | Minutes excluded for every serving region (POL-06). Probes keep running and their results are kept, so the surviving region's service stays visible |
| Latency targets (X2-S05, X2-S15, X2-S06, X2-S07, X2-S22, X2-S17, X2-S08; X2-S23) | Not measured |
| Charge timeliness and attribution lag (X2-S13, X2-S22) | Affected minutes excluded; bounds of target + 1 h apply (X2-S19) |
| RPO, outcomes by deadline, breach reporting | **Always** measured (X2-S23): A-T4 and the durability checker run throughout |

A declaration approved at 10:20 for a loss recorded at 10:00 (X2-S26) excludes 10:00 onwards;
the minutes 09:40 to 10:00 that an operator may claim count. A recorded loss from 10:00 to
10:20 never declared (X2-S28) counts in full. The monthly report lists every recorded loss,
declared or not, with its window.

#### 18.5 Error budgets and canaries

- Burn-rate alerts on each availability and timeliness budget: a page when the 1 h burn rate
  exceeds 14.4 × the monthly rate and when the 6 h burn rate exceeds 6 ×; a warning at 1 ×
  over 3 days.
- **Internal canaries** (not the POL-06 measurement): a canary partition in every slot
  appends an entry every 10 s and checks it through Kafka and from a status reader in every
  Kenyan facility, so a failing slot, reader, relay or broker is detected even if no probe
  touches it.

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

| Load | Transactions/s (est.) | Note |
|---|---|---|
| Account owners | about 50,000 | Intake and deciding entries for 25,000 requests/s, little batching (about 25 requests/s per active account slot partition), plus marks and "releases durable" |
| Link owners | about 35,000 | The hottest link batches about 75 to 150 entries per transaction (about 33 a second); other links have low per-link rates |
| Ingestion | about 600 | One per accepted batch of about 1,000 records |
| Attribution, rating, settlement, ledger | about 10,000 | Feed applications and one movement per account and minute |
| Payments, notifier, alerts, others | about 25,000 | 20,000 webhook deliveries/s each an entry |
| Session renewals | about 2,400 | About 1,200 processes (both regions) twice a second |
| **Total** | **about 120,000** | About 6 statements each, about 700,000 statements/s at R1's leaseholders |

| Item | Per Kenyan facility | R3 | Notes |
|---|---|---|---|
| Database nodes (64 vCPU, 256 GB RAM, 4 × 3.84 TB NVMe) | 24 | 8 per zone × 3 zones running; 24 reserved | Leaseholder work about 700 vCPU at about 1,000 statements per vCPU-second (est., to be measured), plus follower work about 30%: about 900 vCPU, 59% of one facility's 1,536 |
| Owner hosts (64 cores, 256 GB) | 28 | — | About 600 owner processes per region at about 2 cores each (est.; Node.js taken at about 2.5 × RFC-006 revision 1's Go estimate), all within one facility at ≤ 70%, plus the hot standbys of the other facility |
| Status-reader hosts | 4 (8 reader processes, §4.6) | — | 25,000 polls/s per facility, most from pushed state |
| Kafka brokers (32 cores, 128 GB, 8 × 3.84 TB NVMe) | 6 | — (one KRaft controller) | §19.3 |
| KRaft controller | 1 | 1 | Small hosts |
| Edge nodes | 8 | — | 25,000 bookings/s + 100,000 polls/s + ingestion and payments ingress across a region, one facility able to take it all |
| Stateless workers (partner calls, relay, delivery workers, reporting read models) | 12 | — | |
| Time servers | 2 (GNSS + rubidium, PTP grandmasters) | — | §6.1 |
| Ceph (archive, backups) | Sized for §19.4 | GCS | |

#### 19.3 Replication and fibre bandwidth (est., at peak)

Payloads are compressed by the owner before encryption, so database and Kafka traffic is
close to RFC-000 §6's compressed figures, plus clear columns and the write amplification
of heads, projections and outbox rows.

| Stream | Rate |
|---|---|
| Logical writes at the leaseholders (log rows, outbox rows, heads, projections, indexes) | about 200 MB/s |
| R1 → R2: two voters, plus two non-voters of the account tables | about 460 MB/s (3.7 Gbps) |
| R1 → R3: one voter, plus the admission tables' non-voter | about 260 MB/s (2.1 Gbps) |
| Kafka: about 60 MB/s of outbox values, published twice (direct and relay), replicated to R2's two replicas | about 240 MB/s R1 → R2 (1.9 Gbps); consumers fetch locally |
| Archive: each segment to the other Kenyan region's Ceph and to GCS | about 60 MB/s each (0.5 Gbps) |
| Backups: hourly incrementals to GCS and to the other region's Ceph | about 60 MB/s each (0.5 Gbps) |
| **Nairobi–Mombasa, total** | **about 820 MB/s (6.6 Gbps)** |
| **Each Kenya–Johannesburg path** | about 380 MB/s (3.1 Gbps) from the preferred region; during 2 + 2, about 460 MB/s (3.7 Gbps) to R3's two voters, plus snapshot bursts if delegation is unavailable |
| Restoration of a region (§8.4) | 10 to 20 Gbps of snapshots over the Nairobi–Mombasa paths for hours |

**Rule for the fibre**: each Nairobi–Mombasa path must carry **at least 40 Gbps** for the
platform alone, and each Kenya–Johannesburg path, including its GCP interconnect, **at least
10 Gbps**, so that either path of a pair carries everything with room for snapshot bursts
(§20). This is four times revision 1's Nairobi–Mombasa figure: the database replicates heads,
projections and outbox rows that the custom platform did not, and Kafka adds its own
replication (Risk RK6).

#### 19.4 Storage over 7 years (est.)

| Data | Per copy at year 7 | Copies | Total |
|---|---|---|---|
| **Archive** (§13.2): raw flow records about 2.9 PB, ledger lines about 2.2 PB, account and link logs about 1.1 PB (up to 3.8 PB if every kind is `7y`), rating, attribution, payments and audit about 1 PB | **about 7 to 10 PB**, growing about 1.2 PB a year | 2 (cold), 3 for the hot 13 months | about 16 to 22 PB |
| **Database, live**: payment reference bindings (about 2×10¹¹ at about 100 B with index, RFC-000 §6) about 22 TB; ledger watermarks, record-identity range sets, projections and 63 M active reservations about 3 TB; log tails (minutes normally) and outbox (25 h at about 60 MB/s, about 5 TB) | **about 30 TB normally; about 50 TB with a 24 h archive outage buffered** | 5 voters, plus non-voters of the account tables (about 2 TB each) and admission tables | about 160 to 260 TB; about 40 to 65 TB per Kenyan facility, about 15% of its NVMe |
| **Kafka**: 3 days of the high-volume topics and 7 days of the rest, 4 replicas | about 60 TB | 4 | about 240 TB, about 10 TB per broker |
| **Backups**: 35 days, weekly fulls of about 10 TB (the backed-up tables) and hourly incrementals of about 60 MB/s | about 0.35 PB | 2 (GCS, Ceph) | about 0.7 PB |

The live database grows by about 3 TB a year per copy, almost all payment reference
bindings; if that becomes a cost problem, bindings older than 13 months can be served from
a history index instead (RFC-004 decides; RK22).

#### 19.5 The load test (X2-S03, X2-S04)

On a **pre-production cell on the real three sites and fibre** (its own nodes, same
placement, same paths), a generator reproduces the design profile for **at least one hour**:
25,000 requests/s with 2,500/s on one link, 80% single-link and 20% routes, 70% fitting, with
realistic account and link skews, poll and webhook traffic; records at 260,000/s with
600,000/s peaks for 5 min each quarter hour, duplicated, late and out of order as P3
describes; 1,000 payment notifications/s. Pass: every latency target of X2-S05, X2-S15 and
X2-S06 and every timeliness target of X2-S13 and X2-S22 met throughout (§18 methods). A
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
N–M path within 15 ms RTT. The same gate includes the facility inventory (§20.4) and the
database's enterprise licence and support contract (§3.1).

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
   §11 states, and that the latency rows hold.
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
| RB-4 | Region-wide failover (automatic) and declaration | Verify trigger and evidence; verify every admission slot in the new region within 30 s; confirm Kafka `min.insync.replicas` 2; watch the 10 min timer for the automatic 2 + 2; within 10 min decide whether to declare (§8.2); **declaration**: network operations declares naming the recorded loss, with reason and evidence; a second network-operations operator approves; publish the customer notice |
| RB-5 | Automatic 2 + 2 in progress | Watch class progress (system, admission within minutes; others within hours); confirm R3 reserved capacity in use; confirm no range needs 4 of 4; escalate if admission is not done in 10 min |
| RB-6 | Restore a region, end a disaster, fail back | Wipe and rejoin as new nodes; revert zone configurations in class order; watch up-replication; Kafka reassignment and `min.insync.replicas` 3; probes pass in the region; **end** declared and approved by two network-operations operators; after 30 min stable, order failback (T4) |
| RB-7 | Fibre cut (one or both N–M paths, or a Kenya–J path) | Confirm network failover; for both N–M paths: priority-one with carriers; do not declare (counts against availability); consider T4 to R2 only if R2 reaches R3 better and the cut will last hours |
| RB-8 | Clock alarm (ladder A and above, A-T2, A-T3) | Identify drained nodes and dropped hosts; check GNSS status, holdover, PTP grandmasters, R3's NTP paths; if region-wide, confirm T3; if the cluster drifts against external references, decide with the business whether to stop admission; review `δ_x_meas` by state; on a leap-second announcement, re-check `chrony` configuration everywhere |
| RB-9 | Archive lag or failure | Identify the failing store; confirm two of three accept; watch the database's tail growth against the 24 h buffer; never truncate below the two-region rule |
| RB-10 | Logical corruption, restore or replay | Identify affected kinds and the faulty release; choose replay from the log or a point-in-time restore of projections into a side database; compare digests; promote the corrected code; owner appends corrective entries per its RFC |
| RB-11 | Hot partition or range | Confirm automatic move to a dedicated slot; check the range's load and splits; if a dedicated slot is saturated, page the owner RFC's team (RFC-001's measured ceiling) |
| RB-12 | Probe failures | Separate measurement faults (runner, probe account headroom, coverage gap, probe link) from service faults (one region's edge, a slot); if only one region's probes fail, investigate its edge and anycast, not leases |
| RB-13 | Release | Drain one facility's leases, hand off its slots, upgrade, compare canary digests, proceed; automatic halt on mismatch, crash loop or probe failure; roll back; replay if an apply was faulty (RB-10) |
| RB-14 | Decision record unavailable at a deadline (P2-S104); request pending at deadline (P2-S53) | Identify the slot and its ranges; confirm the takeover or range-lease move; confirm holds released within `release_grace`; report the affected requests |
| RB-15 | Kafka cluster loss | Confirm owners still commit; restore brokers; recreate changefeeds from the oldest consumer resolved timestamp; confirm consumers filled gaps from the logs; confirm webhooks resumed |
| RB-16 | Changefeed paused or lagging | Inspect the error; resume; if lost, recreate with `cursor`; confirm the relay's resolved markers advance |
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
| Single-link booking p99 at the edge, steady and degraded | About 115 to 150 ms steady (RFC-000 §3) |
| `δ_x` p99.9 per topology state; report-position delay | `δ_x` p99.9 ≤ 160 ms in the worst state (§6.4) |
| Clock offsets with PTP, with NTP only, in holdover, and R3 over NTP from Kenya | Every node far below 40 ms; R3 below 20 ms |
| Owner takeover (process kill, host kill) | p99 ≤ 5 s (AI3-9) |
| Range-lease failover (database node kill) | p99 ≤ 6 s |
| Region-wide failover of about 5,000 slots and every range lease (T1 by isolating R1; T4 by preference swap and drain) | Every admission slot served from R2 within 30 s at p99 |
| Automatic 2 + 2 of every range with R1 isolated (not killed) | No two majorities; admission ranges fault-tolerant within 10 min; all within 4 h |
| Changefeed lag, relay lag, direct-publish lag | Changefeed p99 ≤ 2 s; direct publish p99 ≤ 50 ms |
| Attribution path takeover `O`, lag `L`, catch-up `k` (§10.3) | `O` ≤ 5 s at p99 |
| Transactions pushed by the closed timestamp (§3.4) | Below 0.01% |
| Node.js pauses per process class (§4.7) | p99.9 ≤ 50 ms |

#### 22.2 Failure injection (X2-S09, X2-S10, X2-S12)

Before production on the pre-production cell, and then regularly:

| Scope | Where and how often | Check |
|---|---|---|
| Database node kill, disk stall, clock skew, packet loss; owner process and host kill; event-loop stalls | Production weekly, one at a time; pre-production daily | Every fact acknowledged before the failure is present after (a checker writes facts of each X2-S09 kind and verifies them); RTO by probes |
| Facility isolation | Production quarterly (transparent by design); pre-production monthly | Same, and RTO ≤ 1 min for admission and ingestion |
| Region isolation, automatic 2 + 2, declared disaster | Pre-production quarterly; production only as a planned T4 switch, monthly | X2-S12 (no fact lost), X2-S10 region rows, 2 + 2 safety with the "lost" region alive but isolated (V-07) |
| Lease and fencing safety | Continuous in CI: a Jepsen-style harness against the owner runtime on a real CockroachDB cluster with partitions, clock skew within and beyond 100 ms, process pauses longer than `session_ttl`, `Ambiguous` commits, crashes during acquisition and handoff; a **TLA+ model of the owner-lease protocol** (sessions, slot epochs, epoch-conditional writes under serialisability, handoff, read leases, the report position, takeover republish) | No two holders with valid leases acting; no entry committed by a deposed holder after its successor's acquisition; no reported entry lost or contradicted; no gap or duplicate applied by a consumer |

#### 22.3 Design-level acceptance tests

Each cites the scenario it serves (docs/README.md conventions).

| Test | Serves |
|---|---|
| DT-01 A batch is acknowledged only after commit; killing any two voters after the acknowledgement loses nothing | X2-S14, X2-S09 |
| DT-02 Isolating R1 entirely: every entry acknowledged before is present on the R2 + R2 + R3 majority, and admission is back within 1 min | X2-S12, X2-S10 |
| DT-03 A holder whose session has expired by its own monotonic view proposes nothing, answers no headroom query and grants no read lease | X2-S21 (and POL-05 via RFC-001) |
| DT-04 A holder paused past its session's expiry, then resumed, commits nothing after its successor's acquisition (the epoch read fails) | X2-S09 (and POL-05 via RFC-001) |
| DT-05 A new holder neither reports nor calls `onAcquire` before its catch-up, and starts reporting only after every read lease of the old holder has expired | P2-S108 (with RFC-002) |
| DT-06 The report position never passes an entry that is not committed or that a leased reader has not applied | P2-S10, P2-S99 (with RFC-002) |
| DT-07 Rule 3's consistent read answers "no holder" only when the holder's session has expired by the database's clock | P2-S111 (with RFC-002) |
| DT-08 `ts` is strictly increasing per partition across holders and partition moves, and never at or below a closed timestamp; a reconciliation read at `T` is a consistent cut | P4-S90, P4-S104 (with RFC-004) |
| DT-09 An owner host whose offset bound exceeds 50 ms gives up its session within 3 s; a database node over 40 ms has its leases drained | X2-S06, P2-S93 (with RFC-002) |
| DT-10 Raising `δ_x_cfg` writes a new `platform_timing` version; a confirm whose `ts` is at or after `D − τ` under the new version is refused | P2-S93 (with RFC-002) |
| DT-11 The 2 + 2 change with the "lost" region alive but isolated never yields two majorities and never needs four of four | X2-S23, X2-S12 |
| DT-12 A moved partition's old slot refuses every command after `moved`; the new slot's first entry continues `seq` | X2-S09 (and POL-05 via RFC-001) |
| DT-13 Every outbox row reaches its topic if the holder dies between commit and publish; a consumer applies each event once in `seq` order and fills a gap from the log | P2-S09, X2-S02 |
| DT-14 Losing Kafka entirely loses no fact; after restoration every consumer reaches the same state as without the loss | X2-S12, X2-S02 |
| DT-15 A minute with 10 of 12 probes succeeding is unavailable; 11 of 12, available; with probes from one location only, unavailable | X2-S16 |
| DT-16 Every account slot receives at least one admission and one wallet probe a minute from each region; a coverage gap pages | X2-S27 |
| DT-17 A probe account cannot book a non-probe link and a buyer cannot book a probe link; probe bookings and records produce no charge line, settlement, supplier-report or quarantine-report entry; each probe account's credit hold is real and never invoiced | X2-S20, X2-S24 |
| DT-18 A declaration by one network-operations operator has no effect until a second approves; a declaration by another role is refused and recorded; the end likewise | X2-S25 |
| DT-19 A disaster window starts at the recorded loss whatever the declaration states, and a recorded loss never declared counts in full | X2-S26, X2-S28 |
| DT-20 Percentiles are computed per calendar month per serving region, leaving out disaster windows | X2-S05, X2-S06, X2-S07, X2-S15 |
| DT-21 A sealed segment cannot be overwritten or deleted inside its retention lock, in either store; a chain mismatch is detected the same day; the truncator never deletes a row not yet two-region archived | X2-S11, X1-S15 |
| DT-22 Records, movements, payment events and reservation changes back-dated 7 years less one day are returned unchanged from the cold tier, for every format version | X2-S11 |
| DT-23 A webhook delivery survives a notifier holder failover without loss, is retried with backoff for 24 h, and carries the same event ID on every attempt; a notice is "told" once in the notice list and first attempted | P2-S09, P1-S75 |
| DT-24 An alert raised in an owner's log reaches the alert service after the alert service's holder is killed | P2-S53 |
| DT-25 No personal data appears in any log table, outbox row, Kafka message, archive segment, backup of an owner table or application log (scanner over samples of each); an erased subject's data is unreadable in the live store at once and in every backup after `pds_key_backup_retention` | X1-S34, X1-S37 (with RFC-005) |

## Benefits

Figures marked "est." are estimates (to be replaced by the R1 spike and the load test).

| Target | How this design meets it |
|---|---|
| RPO 0 on node, rack, zone and region loss, and during a declared disaster (X2-N4, X2-S09, S12, S14, S23) | One acknowledgement path, at commit by a database majority that by placement spans two regions; feeds are outbox rows of the same commit; after a sustained loss the automatic 2 + 2 keeps two-region commits and tolerates one further fault, declared or not |
| Admission RTO 1 min on node or zone loss (X2-S10) | About 4 s for an owner loss, 4 to 9 s for a database node loss (est.): hot standbys in the other facility, range-lease failover by the database |
| Region RTO 1 h (X2-S10) | Region-wide failover of every range lease and slot in about 6 to 12 s for admission and under 20 s for everything (est.), against a 30 s design target; nothing is rebuilt |
| Availability 99.99% (X2-S01) | Owner and database node losses cost no unavailable minute, a facility loss at most one (est.); upgrades cost none (leases drained, slots handed off); probes measure each region on its own path and every account slot every minute |
| Charge timeliness and attribution lag, 99.99% of minutes (X2-S13, S22) | Hot standbys tailing within about 1.5 s take over in about 4 to 5 s: no breaching minute (est.) |
| Confirm fence and deadlines (POL-26, P2-S93) | `τ` = 260 ms in every state, configured from the worst case; `τ` is a row read in the confirm transaction, so it moves earlier the moment measured `δ_x` grows; GNSS/PTP keeps offsets far below the 40 ms alarm and the 80 ms self-termination |
| Single writer across failures (POL-05) | Sessions and slot epochs, every write conditional on the epoch under serialisable isolation, `moved`/`adopt`, sequences on every feed event |
| Auditable measurement (X2-N1, X2-S25 … S28) | Every probe result and monthly figure kept and recomputable; absence of probes never counts as available; disaster windows start at a loss the system recorded and need two network-operations operators |
| Retention 7 years (X2-S11, POL-19, X1-S15) | Write-once, two-region (three while hot), hash-chained, encrypted columnar archive; format corpus; quarterly retrieval at the retention edge; backups for point-in-time recovery of current state |
| Design load (X2-S03, S04) | About 120,000 transactions/s on 24 database nodes per facility, each facility able to hold every lease at ≤ 70% CPU (est.); slots split without re-partitioning |
| Personal data erasable (A11, X1-N11) | No platform store holds personal data in clear; the personal-data store's backups are ciphertext and its key backups expire in 35 days |
| A platform the team can build and run (RFC-000 RK10) | No consensus code of Share's own: an off-the-shelf database and Kafka under a TypeScript runtime of a few thousand lines, one language with the rest of Share's stack |

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
| **One owner-lease row per slot with its own expiry** (RFC-000 §5.2 read literally) | About 10,000 two-region renewal writes a second for 5,000 slots at a 500 ms renewal. Sessions renew once per process; slot rows change only on acquisition and handoff (AI6-1) |
| **Redpanda** (allowed by RFC-000) | Raft per partition needs a majority of replicas; without a broker in R3 (AI5-3) a Kenyan region loss leaves 2 of 4 and stops every partition (§5.1, AI6-2) |
| **Kafka as the system of record**, or Kafka transactions for the relay | RFC-000 Competition for the first; for the second, exactly-once relay transactions would still leave the direct publish and the takeover republish as duplicates, so consumers deduplicate by sequence anyway |
| **Owner publishes only, no changefeed** | Then an owner dying between commit and publish would leave an event unpublished until the takeover republish, and a lost Kafka could not be replayed from a resolved timestamp; the changefeed is the guaranteed path and the source of the resolved timestamps the lifecycle closure needs |
| **A polling relay instead of changefeeds** (a job scanning outbox tables by follower read) | Viable and kept as the fallback if changefeeds misbehave at scale (RK20), but it must compute its own "nothing more at or below T", which the changefeed's resolved timestamp gives as a product |
| **Postgres logical replication or Debezium for CDC** | The database's changefeeds are its supported CDC; a Postgres replication-slot interface is not the path its vendor supports for this |
| **Changefeed aggregators pinned to one region** | The guaranteed path would stop with that region, exactly when owners are failing over; unpinned aggregators in R3 carry only ciphertext (§3.5) |
| **Waiting for a declaration before the 2 + 2 change** (revision 1) | Leaves every range without fault tolerance between loss and declaration, and for the whole of a fibre isolation, which is never declared (AI-2) |
| **Bootstrapping the second R3 voter on demand for admission tables** | Admission would then take an hour or more to tolerate the next fault; the standing non-voter costs one R3 copy of the admission tables and makes it minutes (§8.1) |
| **A per-state `τ`** (revision 1's presets in a timing epoch) | It would let `τ` fall to 200 ms in steady state, but must jump to the worst case the moment a region is lost, before measurement catches up; one configured worst-case `τ` (260 ms) is simpler and costs only a request's last 60 ms of commit time |
| **A smaller `max_offset`** (for example 20 ms) | Would move the fence about 80 ms later, but a PTP or GNSS fault in one facility would then make its nodes self-terminate at 16 ms; the coordinator chose 100 ms with an alarm ladder that pages at 40 ms |
| **Google's leap-smeared time in R3** | Mixing smeared and unsmeared clocks would put up to 0.5 s between R3 and Kenya around a leap second, beyond `max_offset`; R3 takes Kenyan time and every node slews identically (§6.1) |
| **Two-write degraded fast path** (RFC-000 R13) | Would bring degraded single-link answers to about 160 ms, but costs the single decision point a resolution step and helps only undeclared degraded states the go-live condition makes rare; kept as the first lever (§8.5) |
| **A pre-built replacement site** | A third Kenyan facility set and its fibre to end disasters sooner; latency during a disaster is not a target (§8.5) |
| **The archive as the only backup** (revision 1) | The archive holds every log write-once, but rebuilding the database's current state (heads, projections, indexes) from 7 years of logs would take days; point-in-time backups restore it in hours (§14) |
| **Server-side availability from logs** instead of external probes | POL-06 requires probes from outside the region; server logs miss failures in front of the servers |
| **Missing probes counted as available** (or the minute skipped) | Would make a probe-estate failure look like uptime (§17.3) |
| **One probe account** (revision 1) | Measured admission through one account slot only (RQ-C, now decided) |
| **A message broker's redelivery for the notifier's retries** | Retries for 24 h need per-delivery state and per-endpoint isolation; delivery entries in the notifier's own log are durable and idempotent, and Kafka carries only the tasks |
| **DNS-only failover** for clients | Minutes of TTL and resolver caching; anycast from Share's own network converges in seconds, with DNS as the fallback |
| **Fully automatic failback** | A flapping region would make every lease and slot flap; failback costs nothing to delay (§7.5) |

## Risks and open issues

| # | Risk or issue | Mitigation or next step |
|---|---|---|
| RK1 | **The owner runtime is where single-writer bugs would hide**: sessions, epochs, handoff, ambiguous commits, read leases, the report position, takeover republish | TLA+ model of the owner-lease protocol and a Jepsen-style harness against a real cluster in CI (§22.2) before any owner goes live; keep the runtime small; review by someone outside the team |
| RK2 | **The go-live fibre condition may not be procurable**, notably a Nairobi–Johannesburg path not via Mombasa, now also at 40 Gbps between Nairobi and Mombasa | Start procurement now; production does not start without it (§20); if impossible, raise against RFC-000 before production |
| RK3 | **Facility inventory** (RFC-000 R2): fewer than two independent facilities, or fewer than three power-separated racks, in a metro | Part of the go-live gate (§20.4) |
| RK4 | **GNSS jamming or spoofing** in the region | Two vendors per facility, rubidium holdover, cross-region and external references, the alarm ladder; a spoofed region is gated and fails over (§6) |
| RK5 | *(Resolved.)* Zero fault tolerance between a region loss and its declaration | The 2 + 2 change is automatic after `region_detect` + 10 min (§8.1; RFC-000 AI-2) |
| RK6 | **Bandwidth and storage are estimates**, and this substrate needs about four times revision 1's Nairobi–Mombasa bandwidth | Measured in the spike and the load test; the 40 Gbps rule leaves about 6 × headroom over the estimate |
| RK7 | *(Resolved by RQ-C.)* One probe account measured one partition | One probe account per account slot (§17.1) |
| RK8 | **R3 capacity during a regional event**: on-demand GCP capacity in `africa-south1` is not assured | Reserved capacity for the second voter set; standing non-voters for admission (§8.1) |
| RK9 | **Seven-year readability** of formats, schemas and keys | Format corpus in CI, schema registry, versioned decoders, key retention by RFC-005 (§13.5) |
| RK10 | *(Closed.)* Team size and skills for a custom consensus platform | Substrate changed by RFC-000 revision 4; Competition |
| RK11 | **Correlated loss of both Kenyan regions** (shared country, grid, some fibre; RFC-000 R2) | Outside X2-N4. R3's voters, the GCS archive and GCS backups remain; recovery would lose commits not yet on R3. Stated, not designed for; the quarterly full restore from GCS (§14.2) times it |
| RK12 | **Webhook load unknown** (R10) | Provisional 20,000/s (§15); measured once buyers integrate |
| RK13 | **`δ_x` tail in the degraded state**: RFC-000's 160 ms is a p99 figure; at p99.9 the worst state may exceed it | A-T2 raises `τ` automatically; the spike measures p99.9 (AI6-3) |
| RK14 | **Gray failures that probes do not catch** (a reader or node) | Internal canaries in every slot, reader and relay (§18.5) |
| RK15 | **The database is a product Share does not control** (RFC-000 R18): closed-timestamp behaviour, lease failover time, changefeed scale, per-transaction cost, upgrade regressions | Enterprise licence and support as go-live conditions; the spike measures each figure; YugabyteDB retained; one facility at a time upgrades with canary digests; no unreviewed setting changes (RB-17) |
| RK16 | **Range-lease failover may exceed the hot-standby budget**: a database node loss under the rating path's ranges could cost a breaching minute (§10.3) | Spike exit criterion p99 ≤ 6 s; the budget absorbs about four such events a month meanwhile |
| RK17 | **Node.js pauses** (garbage collection, blocking) under owners | Loop-delay self-fencing, worker threads for heavy work, measured pauses per process class (§4.7) |
| RK18 | **Fault tolerance after the 2 + 2 change takes hours for non-admission tables** (snapshot volume) | Standing non-voters for admission; delegated snapshots inside R3; snapshot rate raised; RFC-000 told (AI6-4) |
| RK19 | **Degraded latency in undeclared states** (double Nairobi–Mombasa cut, an isolated region before its 2 + 2 or never declared) counts against the targets | The go-live condition; RB-7; the two-write path as the first lever (§8.5) |
| RK20 | **Changefeeds at scale**: about 20 changefeeds over thousands of ranges, R3-planned aggregators, resolved-timestamp lag | The spike measures lag; the polling relay is the fallback (Competition); the direct publish and gap fill make changefeed lag cost latency, not facts |
| RK21 | **A drift of the whole cluster** is invisible to the database's own checks | External references and the cluster level of the ladder (§6.2, §6.3); safety does not depend on it (A8) |
| RK22 | **Live database growth from 7-year payment reference bindings** (about 22 TB per copy at year 7) | Sized for (§19.4); RFC-004 may move bindings older than 13 months to a history index |
| RK23 | **Ciphertext limits database compression**: payloads compressed by owners entry by entry compress worse than columnar storage would | Accounted for in §19; the archive decrypts and re-encrypts with columnar compression (§13.2) |
| RK24 | **Erasure completion through backups** takes up to 35 days | RQ6-1 |

## Requirements issues

**Resolved.** Every issue revision 1 raised is settled in `requirements-v1.6`
([review 11](../reviews/11-requirements-amendments-from-detailed-rfcs.md)), and revision 2
applies each decision as written:

| # | Issue | Decision in `requirements-v1.6` | Applied in |
|---|---|---|---|
| RQ-A | Who may declare a region disaster | Network operations declares, and ends, with reason and evidence; a second network-operations operator approves (POL-06, POL-32; X2-S25, X1-S31; glossary *Declared region disaster*) | §8.2, §7.1 (`disasters`), RB-4, RB-6, DT-18 |
| RQ-B | When a disaster starts for measurement | From the loss as the system recorded it, not the declaration; a loss never declared counts against every target (POL-06; X2-S26, X2-S28, X2-S23 amended) | §8.3, §18.4, DT-19 |
| RQ-C | One probe account; no probe supplier | Several designated probe accounts spread so every part of admission and the wallet serving accounts is probed, plus a designated probe supplier owning the probe links (POL-06; X2-S20, X2-S24, X2-S27) | §17.1, §17.4, DT-16, DT-17; RQ6-2 asks to confirm "part" |
| RQ-D | Window of the p99 targets | Every percentile per calendar month and per serving region (POL-06; X2-S05, S06, S07, S15) | §18.1, DT-20 |
| RQ-E | "Told" when the endpoint is down | Told once recorded in the account's notice list and first delivery attempted within the time, then retried for `webhook_retry` (POL-04; P1-S75; glossary *Told*) | §15, §18.2, DT-23 |
| RQ-F | The fibre condition was weaker than the design's | Four paths pairwise without shared risk: two Nairobi–Mombasa, one from each serving region to Johannesburg not via the other (POL-06; X2 constraints; glossary *Serving region*) | §20.1 |

**New.** Found while writing revision 2. The requirements are not changed here; each is
proposed for the next requirements amendment.

| # | Issue | Where | Proposal |
|---|---|---|---|
| RQ6-1 | **How soon an erasure must be complete, backups included, is not stated.** X1-N11 asks that erased personal data cannot be recovered; the design makes it unreadable at once in the live store and, through the expiry of key-store backups, in every backup within 35 days. Without a stated bound, either reading (immediate everywhere, or "as backups age out") is arguable | X1-N11, X1-S34, X1-S37, POL-19 | State that erasure is effective at once in every live store and complete in backups within a bounded period (35 days proposed), with the subject told of that period |
| RQ6-2 | **"Every part of admission and the wallet that serves accounts" (X2-S27) is not defined.** The number of probe accounts, and so the measurement, depends on what a part is | POL-06, X2-S27, glossary *Available minute* | Define a part as the unit in which the design owns and fails over accounts, stated by the platform RFC (today an account slot, 1,024 at the design load), so the probe set follows the design |
| RQ6-3 | **A region that is reachable but unusable has no recorded loss.** POL-06 counts a disaster from "the loss of the region as the system recorded it"; if a region's edges fail while its database and network stay up, the system records a failover (T2) or nothing, not a loss, and the design does not let it be declared | POL-06, glossary *Declared region disaster* | State that only a region that is unreachable, or gated by its own clocks or storage, as the system records it, can be declared; anything else counts against the targets. RFC-006 applies this reading meanwhile (§8.3) |

## Architecture issues

**Resolved by RFC-000 revision 4.** AI-1 (monitored quantities instead of the invariant;
`δ_x` at p99.9), AI-2 (automatic 2 + 2 after `region_detect` + 10 min), AI-3 (placement of
every group) and AI-4 (status replicas named), and RK10 (substrate changed), are adopted
in RFC-000 revision 4 ("Revision 4 resolution") and applied here in §6.5, §8.1, §7.2 and
§4.6, and Competition.

**New.** Found while writing revision 2; raised for RFC-000's next revision. None blocks
this RFC.

| # | Issue | Where in RFC-000 | Proposal |
|---|---|---|---|
| AI6-1 | **Owner-lease expiry per slot row is too costly to renew.** §5.2 makes the owner lease a row (slot → holder, epoch, expiry) renewed by its holder; at about 5,000 slots and a 500 ms renewal that is about 10,000 two-region writes a second | §5.2, §5.5 | State the lease as a slot row (holder session, epoch) whose validity is its holder **session's** expiry, one row per process, as §4.2; the epoch and the conditional write are unchanged |
| AI6-2 | **Redpanda cannot survive a Kenyan region loss without a broker in R3**, and "at least two in-sync replicas in different regions" is not a Kafka setting | §5.1, §5.5, R20 | Name Apache Kafka (KRaft) only; state replication factor 4, `min.insync.replicas` 3, lowered to 2 by placement while fewer than three facilities can hold replicas (§5.2) |
| AI6-3 | **`δ_x` = 160 ms is RFC-000's p99 figure**, but AI-1 quotes `δ_x` at p99.9, at which the worst state may exceed 160 ms, making `τ` about 280 to 300 ms | §4.3, coordinator decision (1) of revision 4 | Read `τ` ≈ 260 ms as the starting configuration, raised automatically if measured p99.9 exceeds 160 ms (§6.5) |
| AI6-4 | **After the automatic 2 + 2 change, fault tolerance returns in minutes only for ranges with a standing R3 non-voter**; other ranges need a new R3 voter bootstrapped, about 1 to 3 h | §5.1 | State the times, and the standing R3 non-voter for admission tables (one extra R3 copy of them) |
| AI6-5 | **R3's clocks are inside the database's clock domain**: R3 nodes compare offsets with every peer and may hold a lease transiently, so their time must not be Google's smeared time and must come from Kenyan references | §5.1, R4 | Note that R3 synchronises from Kenyan time servers (§6.1) |

## Traceability

**X2 scenarios (RFC-006 primary).** "Also" names the RFC that specifies the mechanism the
measurement observes.

| Scenario | Approach section | Also |
|---|---|---|
| X2-S01 Availability per capability | §17.3, §10.1, §10.2, §11, §20 | — |
| X2-S16 Available minute, 90% of probes | §17.1, §17.3, DT-15 | — |
| X2-S18 Each capability probed by its own operation and limit | §17.2 | — |
| X2-S20 Probes end to end as designated probe accounts, without business side effects *(amended)* | §17.1, §17.4, DT-17 | RFC-002 (intake rule), RFC-003, RFC-004 (exclusions) |
| X2-S24 Each probe account on a credit limit set by finance, never invoiced *(amended)* | §17.4 (rule 4), §17.1, DT-17 | RFC-004 (credit holds), RFC-005 (finance sets the limit) |
| X2-S27 Every part of admission and the wallet serving accounts probed *(new)* | §17.1, §17.3 (coverage gap), DT-16; RQ6-2 | RFC-002 (account slots) |
| X2-S21 Funds holds and headroom checks at admission's targets | §10.1, §4.4, §11, DT-03 | RFC-002, RFC-004 Part A (in the account owner) |
| X2-S02 Ingestion may lag, never loses an accepted record | §9, §5.5, §13.2, DT-13, DT-14 | RFC-003 |
| X2-S03 Admission sustains the design load | §19, §19.5 | RFC-001, RFC-002 |
| X2-S04 Metering keeps up with the design volume | §19, §19.5 | RFC-003 |
| X2-S05 Single-link answer within `ack_budget`, any length *(amended: per month, per region)* | §18.1, §19.5, DT-20 | RFC-001, RFC-002 (path), RFC-000 §3 (budget) |
| X2-S15 Final answer with no capacity in flight *(amended)* | §18.1, §8.5, DT-20 | RFC-001, RFC-002 |
| X2-S06 Route acknowledged within `ack_budget`, outcome by deadline *(amended)* | §18.1, §6.4, §6.5, DT-20 | RFC-002 |
| X2-S07 Top-up credited within 10 s *(amended)* | §18.1, §18.2, DT-20 | RFC-004 |
| X2-S22 Accepted record counted in headroom within `attribution_lag_max` | §10.3, §18.2 | RFC-003 |
| X2-S17 Standing reaches network operations within `standing_notice_time` | §18.2 | RFC-004 |
| X2-S08 Suspension enforced within 60 s | §18.2 | RFC-004; network operations |
| X2-S13 Charges posted within target and bound | §10.3, §18.3 | RFC-003, RFC-004 |
| X2-S19 Disaster minutes excluded, charges within target + 1 h, none lost or doubled | §8, §10.1, §10.3, §18.3, §18.4 | RFC-004 (per-line deduplication) |
| X2-S23 During a disaster, from the recorded loss to its end, latency suspended, deadlines and RPO 0 hold *(amended)* | §8.1, §8.3, §9, §6.4, §6.5, §18.4, DT-11 | RFC-002 (deadlines) |
| X2-S25 A disaster and its end take effect only once declared with evidence and approved by a second operator *(new)* | §8.2, §7.1, RB-4, RB-6, DT-18 | RFC-005 (approvals, refusals audited) |
| X2-S26 A disaster counts from the loss the system recorded *(new)* | §8.3, §18.4, DT-19 | — |
| X2-S28 A loss never declared counts against every target *(new)* | §8.3, §18.4, DT-19 | — |
| X2-S09 A fact survives a node or zone loss | §9, §11, §22.2, DT-01, DT-04, DT-12 | — |
| X2-S12 No fact lost on a region loss | §9, §7.4, §8.1, §11, §22.2, DT-02, DT-11, DT-14 | — |
| X2-S14 Acknowledged only once durable in two regions | §9, §3.2, §4.3, §12.2, DT-01 | RFC-002, RFC-003, RFC-004 (each acknowledgement) |
| X2-S10 Recovery time per capability and scope | §10.1, §4.4, §3.3, §7.4, §11, §22.2, DT-02 | — |
| X2-S11 Retrieval at the end of the retention period | §13, §14.2, DT-21, DT-22 | — |

**Other scenarios to which RFC-006 contributes a contract** (primary RFC named; the scenario
is satisfied there).

| Scenario | RFC-006 contribution | Primary |
|---|---|---|
| P1-S26, P1-S40, P1-S50, P1-S72 Affected and restoration notices within `affected_notice_time` | §15 delivery and timing | RFC-001 (flags), RFC-002 (holders) |
| P1-S75 Told: recorded in the notice list and first attempted | §15, §18.2, DT-23 | RFC-001 |
| P1-S63 A confirmation completed across a reduction is alerted | §15, §16 | RFC-001 |
| P1-S33 Schedule as known at a past time | §13 storage, indexes, `asKnownAt` | RFC-001 |
| P1-S54, P1-S62 Release within `release_grace` while a record or schedule owner fails over | §4.4 takeover in seconds, §10.1 | RFC-001, RFC-002 |
| P2-S04 Whatever fails, never booked on some legs only | §4.2, §4.3, §4.5 (one writer, takeover) | RFC-002 |
| P2-S09 Webhook sent, signed, retried | §15, §5.3, DT-13, DT-23 | RFC-002 (outcome), RFC-005 (signing) |
| P2-S10, P2-S99, P2-S107, P2-S108, P2-S111 Status reads, report position | §4.6 report position, read leases, rule-3 check; DT-05, DT-06, DT-07 | RFC-002 (replica rule) |
| P2-S22, P2-S23 Interrupted requests resumed or failed | §4.4 takeover, `onAcquire` | RFC-002 |
| P2-S93 Every hold released at the deadline | §6.4, §6.5 (`δ_x`, `τ`, alarms), DT-09, DT-10 | RFC-002 |
| P2-S104, P2-S106 Decision record unavailable at the deadline | §4.4 (seconds to a new holder), §3.3, §16 alert | RFC-002 |
| P2-S51, P2-S53 Requests in trouble visible; pending at deadline alerted | §16, DT-24 | RFC-002 |
| P3-S31 An accepted record is never altered or removed | §3.7 (insert-only), §13.1, §13.4 | RFC-003 |
| P3-S36 Recomputing a period gives the recorded charges | §13.1 (inputs kept), §13.3 replay | RFC-003 |
| P3-S39 Records retrieved by reservation, link and minute | §13.3 entity indexes | RFC-003 |
| P4-S23 Buyer told when reservations are released | §15 | RFC-004 |
| P4-S71, P4-S72 Movements trace to facts; past headroom rebuilt | §13.3 replay and projections | RFC-004 |
| P4-S90, P4-S104 Reconciliation at a consistent cut | §3.4 consistent cuts, §3.7 `ts`, DT-08 | RFC-004 |
| P4-S54, P4-S80, P4-S81, P4-S91 Differences and late reconciliation alerted | §16 | RFC-004 |
| X1-S11 Webhook verifiable | §15 (event ID and timestamp signed) | RFC-005 |
| X1-S24 Webhook only to its own account's endpoint | §15 (endpoint from identity, per-account queues) | RFC-005 |
| X1-S14, X1-S15 Changes record principal and time; audit record cannot be altered or removed | §3.7, §13.1, §13.4, DT-21 | RFC-005 |
| X1-S31 Network operations declares a region disaster with four eyes | §8.2, DT-18 | RFC-005 |
| X1-S34, X1-S37 Personal data held apart and erasable; audit keeps the pseudonym | §3.7 (A11), §13.1, §14.4, §15, DT-25; RQ6-1 | RFC-005 |

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
