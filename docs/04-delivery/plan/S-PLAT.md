# S-PLAT delivery plan: availability, durability and operations (the platform layer)

| | |
|---|---|
| Slice | S-PLAT (primary spec X2, 33 scenarios) |
| Status | Draft for C5 plan review |
| Authority | [RFC-006](../../03-rfcs/RFC-006-availability-and-operations.md) revision 7 (read as accepted); [RFC-000](../../03-rfcs/RFC-000-architecture.md) revision 4.5 (components, substrate); requirements at tag `requirements-v1.11` ([X2](../../02-specs/X2-non-functional.feature)) |
| Provides | **C01 v1** (platform contract, frozen) |
| Consumes | C02 v1.0.0 (`link_displacement` key only), C03 v2.4, C04 v2.3.1, C05 v1, C06 v1, C07 v1.2, C08 v1.2, C09 v1.1, C10 v1.0.0, C11 v1.0.0, C12 v1 |
| Language | ASD-STE100 Simplified Technical English |

## 1. Rules for this plan

1. Each increment depends only on frozen contracts or on earlier increments of S-PLAT.
   Anything else is a blocker (§9).
2. Each X2 scenario is in exactly one increment (§7). An increment "delivers" a scenario
   when its exit criteria prove the S-PLAT part of that scenario.
3. Other slices meet S-PLAT only through C01 and the contracts above. §3 tells them which
   increment gives which C01 part.
4. "Dev cell" is the docker-compose setup of I1. "Emulated cell" is the multi-region test
   cell of I4: real software, three emulated sites, RTTs set by `netem` to RFC-000 §3's
   matrix. "Pre-production cell" is the cell on the real three sites (§20.2 of RFC-006).
5. An estimate in RFC-006 (marked "est.") is not an exit criterion until a spike or a
   measurement confirms it. Then the measured value is the criterion.

## 2. Components and owners

Owners are roles. Each role runs its component in production and approves changes to the
contract parts it provides.

| Component (RFC-006) | Responsibility | Owner role |
|---|---|---|
| Owner runtime (§4, §12) | Sessions, slot leases, epochs, generations, the slot batch transaction, takeover, resume, re-home, handoff, moves and their hooks, report positions, read leases, markers, the consumer runtime, timers, routing, checkpoints, column-encryption binding | Platform runtime team |
| Migration tool (§3.7, §12.1) | Tables, keys, grants, row-level security, roles and pre-splits from each `OwnerDeclaration` | Platform runtime team |
| Status readers (§4.6) | Leased reads, rule 3 check, bounded-staleness reads | Platform runtime team |
| Database platform (§3) | CockroachDB cluster, zone configurations, cluster settings, conformance report | Platform database operations |
| Kafka, relay and closure emitter (§5) | Kafka cluster, changefeeds, relay, relay progress, closure emitter, per-topic producer ACL | Platform streaming team |
| Placement and time (§6, §7, §8) | Slot map, slot preferences, moves, splitting, integrity stops, topology states, failover, 2 + 2, declarations, `platform_timing`, clock monitor, loss recorders | Platform reliability (SRE) |
| History and checkpoint store (§12.11, §13) | Sealer, archive tiers, truncator, history query, entity indexes, checkpoints | Platform data team |
| Backups and restore (§14) | Database backups, restore tests, logical-corruption restore, personal-data store backups and restore tooling | Platform data team |
| Notifier (§15) | Notices, deliveries, delivery workers, signing per attempt | Platform delivery team |
| Alert service (§16) | Alert episodes, routing, escalation, dead-man's switch | Platform reliability (SRE) |
| Probes and measurement (§17, §18) | Probe runners, probe-results owner, minute classification, monthly reports, latency and timeliness pipeline, error budgets, internal canaries | Platform reliability (SRE) |
| Edge health sidecar and anycast arbiter (§2) | Canary commits per edge node, signed region verdicts at the probe sites, withdrawal rule | Platform reliability (SRE) with the Share network team |
| Go-live gate (§20) | Fibre verification, facility inventory, licences, staffing record | Share network team; the platform lead countersigns |

## 3. Packages and the C01 delivery schedule

**Package paths.** Other slices depend on these paths and package names.

| Path | Package | Content | First in |
|---|---|---|---|
| `platform/runtime/` | `@share/owner-runtime` | C01 §2.4 `OwnerRuntime`, `OwnerHooks`, `StatusReaderRuntime`, `CommandEnvelope`, `RoutingRefusal`, consumer runtime | I1 |
| `platform/runtime/testing/` | `@share/owner-runtime/testing` | A runtime double. It produces every `AppendResult` and every `RoutingRefusal` on demand (unknown ones too), for C01 CC-1 … CC-8 | I1 |
| `platform/migrate/` | `@share/owner-migrate` | Migration tool and the grants conformance job | I1 |
| `platform/relay/`, `platform/closure-emitter/` | services | Relay per owner kind; closure emitter | I1 |
| `platform/status-reader/` | service | Status reader processes | I1 |
| `platform/placement/` | service | Placement owner | I1 (minimal), I3 (full) |
| `platform/dev/docker-compose.yml` | dev cell | CockroachDB (3 nodes, one region, localities `r1a`, `r1b`, `r1c`), Kafka KRaft (3 brokers, ACLs on), relay, closure emitter, placement, two status readers, the `canary` reference owner kind | I1 |
| `platform/history/`, `platform/backup/` | services, jobs | History, sealer, truncator, backups, restore tooling | I5 |
| `platform/notifier/`, `platform/alerts/` | services | Notifier and delivery workers; alert service | I6 |
| `platform/probes/`, `platform/measurement/` | services | Probe runners, probe results, measurement pipeline | I7, I8 |

**Version rule** (C01 §8). `@share/owner-runtime` is `1.0.0-alpha.N` until I3. I3 releases
`1.0.0`: every C01 §2.4 operation works and CP-1 … CP-11 and CP-13 pass. A minor version adds
an optional field. A new `AppendResult`, refusal code, required hook or lane kind needs a new
C01 version.

**C01 part by increment.** Until an increment gives a part, a consumer uses the runtime
double. When the part arrives, the consumer runs its tests again on the real runtime.

| C01 part | Increment |
|---|---|
| §2.2 `OwnerDeclaration`; §2.3 log, head (with `adopted`), projection, outbox tables, `owner_session`, `owner_slot` (`stops_version`, `report_through`, `marker_seq`), `platform_timing`, `placement_integrity_stops`; grants; named platform read roles; `chain` per C08 §J | I1 |
| §2.4 `append` (static and `decide` forms), `reads`, conditions `rowAbsent`, `rowPresent`, `tsBefore`, `displacementRead`; `AppendOptions` `exclusive`, `firstStatement`, `abandonBeforeCommitMs` | I1 |
| `AppendResult` `Committed`, `ConditionFailed`, `Retry`, `StaleEpoch`, `Ambiguous`, `Overloaded` | I1 |
| Hooks `onAcquire`, `onRelease`, `onReportable`, `onNotification`; `leaseValid`, `epoch`, `generation`, `admitCommand`, `timing`, `now`, `consistentRead`, `followerRead`, `closedTimestamp` | I1 |
| Acquisition by expiry, free-slot acquisition, handoff, re-home, resume, resolution steps; in-region standby by follower-read tail | I1 |
| Report position, read leases, `StatusReaderRuntime`, `ReportMarker` chain, marker-only transactions | I1 |
| Outbox, direct publish, changefeed relay, takeover republish, `subscribe` (`committed`, `reported`), `onResolved`, `onClosed`, `onMarker`, gap fill from the outbox, content-conflict rule; `ResolvedMarker`, `ClosedMarker`, `RelayProgress`; per-topic producer ACL | I1 |
| `timer`, `cancelTimer`; `CommandEnvelope`; refusals `STALE_EPOCH`, `NOT_OWNER`, `STALE_SENDER`, `OVERLOADED`, `UNAVAILABLE`; `route`; `slotOf` on a fixed map (`headDecides` always false); `placement.slot_map.v1` | I1 |
| Alert stream `<kind>.alert.v1` with `OperationalAlert` episodes (raising only) | I1 |
| Column-encryption binding (§3.12) behind a sealer interface; a dev sealer until RFC-005's library is plugged in (B1) | I1 |
| Second lane (`lane: 'second'`, set by `platform_timing`); push to hot standbys; self-outboxed log tables and `<kind>_stream_index`; slot groups; `putCheckpoint`, `getCheckpoint`; `platform_timing` versions and timing alarms; gateway tiers | I2 |
| `Moved`, `Moving`, `Stopped`; refusals `MOVED`, `MOVING`, `STOPPED`; `onMovedOut`, `onAdopt`; `isMovedOut`; move protocol; §2.6 integrity stop; §2.7 overrides, `reslot`, `doubleSlotCount`, splitting, `ackSplitting`, `listPartitions`, `probeAccountSet`, `probeSetSummary`, `slotGroup`; restore-role row-level security | I3 |
| `topology()` with real states; cross-region standbys; region-wide failover | I4 |
| §2.8 history query; replay from history in the consumer runtime | I5 |
| Alert service (consumer of every `<kind>.alert.v1`) | I6 |
| §2.9, §3.10 probe designation in use by probes; `PROBING_FAULT` | I7 |

## 4. Spikes

Spikes come first where the design depends on an estimate. Each states the measurement and
the decision it unlocks.

| ID | Measurement | Exit criterion (RFC-006 §22.1) | Decision it unlocks | When |
|---|---|---|---|---|
| S-PLAT-SP1 Batch transaction cost and latency | (a) Before I1: a load generator runs the §4.3 SQL shape (fence read, head reads, `ts` read, inserts, head upserts, commit) at about 1.1 partitions per batch on the dev cell and on the emulated cell. It measures database CPU per transaction, statements per vCPU-second, commit p50/p99/p99.9, client-side restarts and aborts counted apart, and transactions pushed by the closed timestamp. (b) On the I1 runtime: an account-owner process at 1,640 transactions a second; event-loop delay; Node.js pauses per process class. (c) On the real sites (needs B2): account step p99 with the batching wait, at the design load | (a) Cost within ± 25% of 1,000 statements per vCPU-second; pushes below 0.01%. (b) Event-loop delay p99.9 ≤ 50 ms. (c) Account step p99 ≤ 50 ms | Account slot count (16,384, or fewer with the second account lane on); slots per process (256 or 128); second account lane on or off before go-live; database nodes per facility (36 or more). Unlocks the I2 lane defaults, the I4 sizing and the I9 capacity | (a) before I1; (b) in I1; (c) in I9 |
| S-PLAT-SP2 Kafka partition count and broker load | A Kafka cluster at 12,000 partition replicas per broker, with 4 s `replica.lag.time.max.ms` and `broker.session.timeout.ms`: produce p99, controller failover, broker-kill produce stall, in-sync flapping under load, controlled restart of the active KRaft controller | Produce p99 and controller failover within 25% of a cluster at 6,000 replicas per broker; stall p99 ≤ 4 s; no flapping that stalls produce more than once an hour; a controller restart moves leadership without fencing brokers | Brokers per facility (6 or 8); account-topic partition count (4,096) and whether a doubling grows it; the heartbeat settings. Unlocks I3 (topic growth on doubling) and I4 (production Kafka topology) | Before I3 |
| S-PLAT-SP3 Product features | Each CockroachDB and Kafka feature that §22.1 lists: row-level security for the truncator and the restore role; `ttl_disable_changefeed_replication`; `with_min_timestamp`; `SET LOCAL statement_timeout` before `COMMIT`; `PRIORITY HIGH` pushes; hash-sharded keys; the client-side retry protocol keeps intents across a restart; CDC-query changefeeds emit delete events; `cockroach node drain` through another node; Kafka controlled controller restart; Cloud EKM in `africa-south1` | Each feature works as RFC-006 §3, §4, §5, §7.3, §13.2 and §14.1 state | Which fallback to use: the stored-procedure delete path (no row-level security); full-row audit changefeeds (no CDC-query deletes); relay drop of TTL deletes. If EKM is not usable, raise an issue against RFC-005 and RFC-000 (§9, B6). Unlocks I1 (retry protocol, statement timeouts, priority, bounded staleness, sharding), I4 (drain, controller restart), I5 (row-level security, EKM) | Before I1 (dev features); before I4 and I5 (the rest) |
| S-PLAT-SP4 Three-site spike (RFC-000 R1) | On the real three sites: RTT matrix per fibre path; each Kenyan region's RTT to R3; two-region commit latency per topology state; range-lease failover; owner takeover; region-wide failover of every slot and range lease; automatic 2 + 2 with R1 isolated; `δ_x` p99.9 per state; clock offsets with NTP and in holdover; changefeed CPU and lag; closure `R_min` lag; direct-publish lag; hot-link move at 2,500 requests a second; attribution takeover `O`; active connections per node after a facility loss | Every §22.1 row: for example range-lease failover p99 ≤ 6 s; takeover p99 ≤ 5 s; every admission slot served from R2 within 30 s p99; `δ_x` p99.9 ≤ 320 ms; Kenyan hosts below 5 ms offset at p99.9; changefeed CPU within 180 vCPU per facility ± 25%; `R_min` p99 ≤ 3 s; `Moving` p99 ≤ 200 ms | Preferred region (R2-D7); `δ_x_cfg`; PTP or not; node and broker counts. I4 uses the RFC-000 §3 estimates until SP4 runs; I9 needs SP4 | Blocked by B2; its exit is an I9 gate |

## 5. Increments

Increments are in dependency order. I4 and I5 can run in parallel after I3. I6 can start
after I3.

### S-PLAT-I1. Minimal C01 runtime on the dev cell

| | |
|---|---|
| Goal | One owner kind runs on CockroachDB in one region (docker-compose). It holds slots through sessions and slot leases. It commits one batch transaction per slot with `decide(ctx)`. It writes log, head and outbox rows. The relay publishes to Kafka. Report markers and closure markers flow. Status readers answer leased reads. Other slices can start their own I1 on this runtime |
| Components | Owner runtime; migration tool; status readers; relay; closure emitter; placement (minimal: a fixed slot map, slot assignment, `placement.slot_map.v1`); database platform (dev cell); the `canary` reference owner kind (§18.5) |
| Contracts | Introduces C01 v1 parts listed for I1 in §3. Consumes C08 v1.2 §J (`chain` formula; local hold on a mismatch), C02 v1.0.0 (`link_displacement` key for the `displacementRead` condition), C04 v2.3.1 (`ReportMarker` chain fields), C03 v2.4 (`ClosedMarker` per link), C06 v1 (closure on any declared stream, CI6-2; the `settlement.posting-acks.v1` ACL, CI6-3) |
| Scenarios delivered | X2-S02 |
| Work items | (1) Migration tool: tables of C01 §2.3 from an `OwnerDeclaration`; head key `home_key` bit-reversed; refuse a slot-led projection key; deletable projections; outbox row TTL 26 h and GC 25 h; `owner_session` hash-sharded over 64 shards; `owner_slot` split every 64 slots; `platform_timing` in 64 shards; grants and row-level security by kind; roles `status_reader`, `closure_emitter`, `gapfill_<consumer>_<producer>`, `standby`, `history_sealer`. (2) Grants conformance job (CP-2c, CP-11). (3) Sessions: insert, renew every 500 ms, holder's view by the monotonic clock, `leaseValid` with the 200 ms margin, revocation on acquisition, free-slot acquisition, handoff with its crash points, re-home, resume, resolution steps 1 to 4. (4) In-region standby: follower-read tail every 250 ms, present-time session poll, takeover, catch-up, `onAcquire`, takeover entry, reporting wait. (5) Slot batch transaction (§4.3): per-slot queue, one batch in flight, size limits, every condition kind, declared reads, `decide` re-run on every restart, client-side retry protocol (5 restarts, then one fresh attempt), commit backstop 15 s, `Ambiguous` resolution before the slot decides again, `batch_id` on every committed head, `chain` computed after sealing and compared with the head. (6) Sealer interface per C01 §3.12 with a dev sealer (B1). (7) Outbox: direct publish after `Committed` (idempotent producer, `acks=all`); one changefeed per outbox table; relay with re-keying and delete drop; relay progress topic; closure emitter with `R_min` over the topic metadata's partitions, closure topics, `dataHighWater`, `CLOSED(t, feed_seq)` read as of `t`, heartbeat; takeover republish from the closure position. (8) Consumer runtime: `stream_seq` order with buffering, duplicate drop, gap fill from the outbox by the gap-fill role after 5 s, content-conflict rule (D3), `reported` gate by the `slot` header, `onMarker` keeps every marker, applied checkpoint with digest. (9) Report position, read leases (400 ms, granted inside the holder's view), push to readers every 100 ms, marker due rules, marker-only transactions beside the lane, marker chain (`prevReportPosition`, `pendingAnswered`, chunks of 5,000). (10) `StatusReaderRuntime`: `readLease`, `leasedRead` with `with_min_timestamp`, `replicaRule3Check` with caching; `isMovedOut` answers false until I3. (11) Kafka ACL generator per C01 §2.5, from the declarations and from the producer lists that contracts name. (12) Timers, `admitCommand`, `CommandEnvelope`, canonical refusals of this increment. (13) Owner-host offset check against the database (§6.2); event-loop monitor and shedding (`Overloaded`). (14) Runtime double `@share/owner-runtime/testing`. (15) TLA+ model of sessions, revocation, resume as acquisition, re-home, epochs, slot batches, handoff, read leases, report position, marker chain, relay progress and closure; TLC runs in CI. (16) Jepsen-style harness in CI on the dev cell: partitions, process pauses longer than `session_ttl`, renewals delayed across expiry, `Ambiguous` commits, crashes in acquisition, handoff, re-home and resume, a holder killed between commit and publish while one relay instance lags |
| Exit criteria | (1) C01 provider tests pass: **CP-1**; **CP-2** for `Committed`, `ConditionFailed`, `Retry`, `StaleEpoch`, `Ambiguous`, `Overloaded`; **CP-2a**; **CP-2b**; **CP-2c**; **CP-3**; **CP-4**; **CP-7**; **CP-7a**; **CP-8**; **CP-9** except its "across a move" clause; **CP-11**; **CP-13** clauses 1 and 2 with the dev sealer. (2) The runtime double passes a self-test: each of CC-1 … CC-8 can be driven by it. (3) X2-S02: DT-13 and DT-14 pass. A consumer stopped for 10 min applies every event after restart, in `stream_seq` order, with no gap and no duplicate. (4) DT-03, DT-04, DT-05, DT-06, DT-07, DT-08 (without moves), DT-27, DT-29 (runtime part), DT-33 (one-region parts), DT-34, DT-36, DT-38 and DT-44 (retry keeps intents, deletable projection, `chain`) pass. (5) TLC finds no violation of the I1 invariants. The Jepsen harness runs 24 h with no violation. (6) No X2 target is measured on the dev cell. SP1 (b) records the event-loop figures |
| Dependencies | Frozen C01, C02, C03, C04, C06, C08. SP1 (a) and SP3 (dev features) |

### S-PLAT-I2. Runtime completion for owner kinds

| | |
|---|---|
| Goal | Every runtime feature that an owner kind needs on one region is available: the second lane, hot standbys fed by push, self-outboxed logs, slot groups, checkpoints, timing versions and timing alarms, gateway tiers |
| Components | Owner runtime; migration tool; relay; placement (timing); database platform |
| Contracts | Introduces the C01 parts listed for I2 in §3. Consumes C11 v1.0.0 (`ingestion.handoff.v1` and the self-outboxed `ingest_log` streams) |
| Scenarios delivered | None. Contributes P2-S93 (DT-10) and P1-S54, P1-S62 (DT-28) to their primary slices |
| Work items | (1) Second lane per slot: only partitions not in the first lane's batch; enabled per owner kind by `platform_timing.second_lane`; lane (c) refused (C01 v1 excludes it). (2) Push of every `Committed` batch to the hot standbys of link and identity kinds over gRPC; a push applies only if its `seq` continues. (3) Self-outboxed log tables: the changefeed on the log, the relay derives events by the declared emit functions, `<kind>_stream_index` written in the batch, gap fill through the stream index; the relay of such a kind holds the log key (RFC-005 key-release, B1). (4) Slot groups: acquisition, handoff, takeover and re-home of every slot of a group in one transaction. (5) Checkpoint store on an S3-compatible store in the process's own region: seal, digest, retention of the last 3 and at least 48 h, `DIGEST_MISMATCH`. (6) `platform_timing` versions written by placement to all 64 shards in one transaction; `tsBefore` bounds from `TimingSnapshot`; timing probes; alarms A-T1 … A-T5 raised on the alert stream. (7) Gateway tiers with per-tier timeouts (400 ms for renewal, epoch read and session poll) and the circuit breaker, proven with a fault proxy between owners and gateways. (8) Owner-host offset ladder actions: stop taking slots and hand off at 40 ms, give up the session at 50 ms |
| Exit criteria | (1) DT-09 (owner-host part) and DT-10 pass. (2) DT-28 (in-region) passes: a killed link-kind holder is replaced by its hot standby within 5 s with no reload beyond the last pushed batch. (3) A slot group is always taken in one transaction or not at all, under the Jepsen harness. (4) A self-outboxed test kind with three streams passes CP-8 and CP-9 (same clauses as in I1). (5) A second-lane batch never carries a partition of the first lane's batch; per-partition `seq` stays contiguous (CP-1 re-run with the second lane on). (6) With the gateway tier of one facility cut by the fault proxy, renewals reach the next tier within one 400 ms timeout and no session lapses |
| Dependencies | I1. SP1 (b) for the lane defaults. Frozen C11 |

### S-PLAT-I3. Moves, splitting and integrity stops

| | |
|---|---|
| Goal | Partitions move between slots with the full protocol. The account slot count doubles. Audit can stop and resume a partition. The runtime API of C01 is complete, and `@share/owner-runtime` 1.0.0 is released |
| Components | Owner runtime; status readers; placement (full); migration tool (restore-role policies) |
| Contracts | Introduces the C01 parts listed for I3 in §3. Consumes C08 v1.2 §J and §K (audit calls `Stop` and `Resume`; `integrity_report`; restore role; `probeSetSummary` target-summary duties), C05 v1 (F9 and the credit-limit answer `applied`), C07 v1.2 (set-scoped credit-limit action over `probeAccountSet(v)`) |
| Scenarios delivered | None. Contributes P2-S10, P2-S108 (DT-37) and X1-S15 (DT-45) to their primary slices |
| Work items | (1) `placement_partition_moves` and steps 1 to 7 of the move protocol: pre-warm by checkpoint or replay, `moved` with `adopted = false`, the report fence on `owner_slot(kind, A).report_through`, `adopt` after the fence check, `onMovedOut`, `onAdopt`, the reporting wait per partition, `MOVE_CUTOVER` raised after 1 s. (2) Successor of A after `moved`: pushes its first marker to B's holder (V59-7). (3) Head checks in the batch: `Moving`, `Moved(slot, generation)`; readers answer moved partitions by rule 4. (4) `STALE_SENDER(recorded)` rules (D4), `STALE_SENDER_UNMOVED`. (5) Hot-link move trigger: above 200 requests a second for 10 min. (6) Slot map: overrides, `reslot` with its refusals, `doubleSlotCount` in the C01 §3.8 order, splitting with `headDecides`, `ackSplitting`, `listPartitions`, creation in `s + n` with the implicit `rowAbsent(head)`. (7) Probe-account steps of the doubling against fakes of identity (B4), the account owner (C05) and finance (C07): pin, provision, F9, set-scoped limit, publish only after `applied`; `probeAccountSet(v)` and the signed `probeSetSummary(v)`, also for a pending version. (8) Topic partition growth on doubling, as SP2 decides. (9) `Stop` and `Resume` (gRPC, audit only): one transaction that writes the stop row and increments `stops_version` (both slots during a move or for a `headDecides` account); `StopAck` after commit; errors. (10) Runtime: `Stopped` from a changed `stops_version`; stops read on every acquisition without placement; local hold and `integrity_report` to audit on a `chain` mismatch. (11) Restore-role policies `restore_only_stopped` and `restore_confined` on log and head, forced (CI6-1 reading). (12) Extend the TLA+ model and the Jepsen harness with moves, the report fence, splitting and stops |
| Exit criteria | (1) C01 provider tests pass: **CP-2** (all results), **CP-5**, **CP-6**, **CP-9** (all clauses), **CP-10**, **CP-13** (all clauses, dev sealer). CP-1, CP-7, CP-7a and CP-8 pass again with moves and stops in the fault mix. (2) DT-08 (with moves), DT-12, DT-37, DT-41 (64 account slots doubled to 128 on the dev cell under steady test load) and DT-45 pass. (3) DT-42 on the dev cell: a hot partition moves at the highest rate the dev cell sustains, `Moving` at most 200 ms p99, no cold rebuild. The run at 2,500 requests a second is part of SP4. (4) TLC and 24 h of the Jepsen harness find no violation. (5) `@share/owner-runtime` 1.0.0 is published; the runtime double is updated to the same API |
| Dependencies | I1, I2. SP2 (topic growth). Frozen C05, C07, C08 |

### S-PLAT-I4. Multi-region topology and failover

| | |
|---|---|
| Goal | The platform runs at 2 + 2 + 1 on the emulated cell. No acknowledged fact is lost on the loss of a node, a facility or a region. Every capability class recovers within its RTO |
| Components | Database platform; placement and time; owner runtime (cross-region standbys); Kafka; status readers (one per facility) |
| Contracts | C01 v1 (`topology()`, failover behaviour). Consumes C05 v1 (`account.usage-applied.v1` retention, CI6-4) |
| Scenarios delivered | X2-S09, X2-S10, X2-S12, X2-S14, X2-S21 |
| Work items | (1) Zone configurations by placement (§3.2): five voters, account non-voters per Kenyan facility, standing R3 non-voter on admission tables, lease preferences; the conformance report every minute. (2) Cluster settings of §3.4 and §3.6; pre-splits. (3) Cross-region warm standbys and the cross-region hot standbys of link and identity slots; `standby_grace`. (4) Topology states (§7.3) and loss recorders. (5) Region-wide failover T1 … T4 with class staggering and damping; failback by order. (6) Metro split: gateway fallback, consolidation, drain of the cut-off facility, Kafka leader consolidation. (7) Automatic 2 + 2 after `region_detect` + 10 min, by class; restoration; the stopped second voter set in R3. (8) Kafka over four facilities: replication factor 4, `min.insync.replicas` 3 and 2 by placement, in-sync-shrink trigger, active controller kept in the preferred region; sizing per SP2 and CI6-4. (9) Clock ladder (§6.3): GNSS NTP configuration, database-node drain at 40 ms, region gated, clock monitor with external references. (10) Failure-injection suite (§22.2) on the emulated cell. (11) A fact checker that writes facts of four synthetic kinds (one per X2-S09 example) and verifies them after each injection |
| Exit criteria | (1) X2-S14: DT-01 passes. A batch is answered only after commit. Killing any two voters after the answer, the two of one region included, loses nothing. (2) X2-S09: DT-01, DT-04, DT-12, DT-27 and DT-33 pass; the fact checker finds every fact after a node, rack and facility loss. (3) X2-S12: DT-02, DT-11 and DT-14 pass with R1 isolated, not killed. (4) X2-S10: DT-02, DT-28 (cross-region), DT-33, DT-35, DT-42 and DT-43 pass. Measured on the emulated cell with internal canaries of a reference kind per capability class: node or zone loss, admission and ingestion classes back within 1 min, rating and wallet within 5 min, payouts within 15 min, reporting within 30 min; region loss, every class within 1 h, and every admission slot served from R2 within 30 s p99. (5) X2-S21: the account-class reference kind meets admission's 1 min RTO on node and zone loss, and DT-03 passes. (6) DT-09 (database-node part) and DT-39 pass: a broker kill and a facility's brokers stall produce at most 4 s. (7) The monthly 2 + 2 drill passes on the emulated cell. (8) The figures above are on emulated RTTs. SP4 confirms them on the real sites in I9 |
| Dependencies | I1, I2, I3. SP2, SP3. SP4 is not needed for this exit (the estimates are used) |

### S-PLAT-I5. History, archive, backups and restore

| | |
|---|---|
| Goal | Every log is sealed into write-once storage and can be read for 7 years. Backups and restores work. The personal-data store's backups meet C09 |
| Components | History and checkpoint store; backups and restore; migration tool (truncator policy); consumer runtime (replay from history) |
| Contracts | Introduces C01 v1 §2.8 history query (CP-12). Consumes C08 v1.2 (`operator_check`, read grants, audit watermark, restore role, break-glass), C09 v1.1 (store events feed, `store_outbox_head()`, restore fence, `reapply`, generation tags) |
| Scenarios delivered | X2-S11 |
| Work items | (1) Sealer: follower reads at or below the closed timestamp, Parquet with zstd, modular encryption with segment keys wrapped by the HSMs (B1), the `sealed` table and its chain. (2) Tiers: two cloud copies under object lock (compliance mode) by retention class, the Kenyan hot copy for 13 months; "two-region durable" check with read-back; back-fill. (3) Truncator: row-level-security policy against audit's watermark (SP3 fallback if needed), consumer-position guards, self-outboxed guard. (4) History query: `asKnownAt`, `history`, `entries`, `replayFrom`, `NOT_CLOSED`, grants with `operator_check` and audit before answer. (5) Entity indexes and bitemporal projection framework that owner RFCs declare into. (6) Replay from history in the consumer runtime beyond 25 h. (7) Format corpus decoded by every build. (8) Backups to GCS and Ceph with revision history and the EKM key (SP3); checks; 35-day lock. (9) Restore tests of §14.2. (10) RB-18 drill: restore a stopped partition from segments and backups through break-glass. (11) Personal-data store: `backup_pds` schedule, generation tags, 7-day lock, pruner on the store events feed, daily erasure-conformance check, restore tooling steps 1 to 6. (12) Daily archive-integrity check and projection digests |
| Exit criteria | (1) X2-S11: DT-21 and DT-22 pass. Records of each X2-S11 kind, back-dated 7 years less one day in every format version, come back unchanged from the cold tier. (2) **CP-12** passes. (3) DT-25 and DT-49 pass with a C09-conformant fake store. (4) The weekly table restore, the monthly point-in-time restore and the quarterly full restore from the GCS copy alone pass on the emulated cell, each timed. (5) The RB-18 drill restores a stopped partition and audit's fake re-verifies it. (6) Archive lag stays below 10 min for 24 h at the dev cell's write rate |
| Dependencies | I1, I3 (stops, restore role). SP3 (row-level security, EKM). Frozen C08, C09 |

### S-PLAT-I6. Alert service and notifier

| | |
|---|---|
| Goal | Every owner's alerts reach the right role. Every outbound notice and webhook is delivered on time, signed and to the right tenant |
| Components | Alert service; notifier; delivery workers |
| Contracts | Consumes C03 v2.4 (`AFFECTED_NOTICE`, `CAPACITY_CHANGED` with `maintenance_cut`), C04 v2.3.1 (outcome feed with `reported` gate and `onMarker`; lifecycle feed; `withheld_by`), C05 v1 (standing feed), C08 v1.2 (endpoint feed `iam.endpoints.v1`, endpoint query, signing format, transport checks), C09 v1.1 (`get` for e-mail notices), C12 v1 (partner reconciliation feed) |
| Scenarios delivered | None. Contributes P1-S26, P1-S40, P1-S50, P1-S72, P1-S75, P1-S85, P2-S09, P2-S51, P2-S53, P4-S23, X1-S11 and X1-S24 to their primary slices |
| Work items | (1) Alert service on 8 slots: dedupe by (`alertId`, `op`), episodes, severity only rises, raised → acknowledged → resolved, escalation after 5 min, routing rules as data, dead-man's switch to an outside watchdog. (2) Platform alarms of §16 wired to the alert stream (`CLOSURE_LAG`, `MOVE_CUTOVER`, `FEED_CONTENT_CONFLICT`, `STALE_SENDER_UNMOVED`, integrity hold, changefeed job events, feed lag, the rest of the §16 table). (3) Notifier on 1,024 slots by tenant: notice entries and notice lists; the input rules of the §15 table. (4) Delivery workers: batches of up to 100 notices for one tenant; a fixed first-attempt lane of 16 per endpoint with a 2 s connect timeout; an AIMD retry lane with a circuit breaker; `webhook-id` rules; HMAC per attempt in RFC-005's format; transport checks; retries for 24 h; "told" times recorded. (5) Contract fakes of the C03, C04, C05, C08, C09 and C12 producers, built from the frozen schemas |
| Exit criteria | (1) DT-23, DT-23b, DT-24, DT-47 and DT-48 pass against the producer fakes. (2) DT-29 (notifier side): the notifier never delivers above a marker, also with markers out of order. (3) A burst of 10,000 affected notices to one silent endpoint is first attempted within 35 s of the feed publish. (4) The watchdog pages within 2 min when the alert service stops sending heartbeats |
| Dependencies | I1, I3 (consumer handling of `Moving` and `Moved`). Frozen C03, C04, C05, C08, C09, C12 |

### S-PLAT-I7. Probes and availability

| | |
|---|---|
| Goal | Every capability is probed from outside each region as POL-06 requires. Each minute is classified, and each month's availability is computed |
| Components | Probes and measurement; placement (probe-account provisioning); edge health sidecar and anycast arbiter; alert service (`PROBING_FAULT` routing) |
| Contracts | Consumes C10 v1.0.0 (probe booking), C11 v1.0.0 (probe flow record, resend), C05 v1 (balance and headroom answer), C07 v1.2 (payout status; set-scoped credit limit), C06 v1 (catalogue designation of probe links, exporters and supplier), C08 v1.2 (probe keys, `probeSetSummary` verification). Introduces the C01 §2.10 and §3.11 `PROBING_FAULT` episodes |
| Scenarios delivered | X2-S01, X2-S16, X2-S18, X2-S27, X2-S30, X2-S33 |
| Work items | (1) Probe runners at three sites per region: the schedule of §17.1 (3 probes a minute per account slot and capability, 20 s apart, doubled on a location loss), the 10 s schedule of the other capabilities, no skip for load, a skip counter. (2) The five probe operations of §17.2 with correctness rules and retroactive scoring. (3) Probe-results owner on 64 slots. (4) Minute classification (available, measured failing, unmeasured, slot-failing), probes scored against 200 ms and 1 s. (5) `PROBING_FAULT`: one episode per (region, minute), `warning` to network operations, `page` per D1; failing slot-minute page. (6) Monthly report per capability and region, kept 7 years, regenerated on each declaration. (7) Probe-account provisioning by placement, one per account slot, with fakes for identity (B4), C05 and C07. (8) Internal canaries in every slot, reader and relay (§18.5). (9) Edge health sidecar (canary commit every 2 s) and the probe-site arbiter (signed verdicts, majority rule, never withdraw the last announcing region) against a simulated edge and BGP speaker (B5) |
| Exit criteria | (1) X2-S16: DT-15 passes. (2) X2-S30: DT-30 passes. (3) X2-S33: DT-46 and **CP-14** pass. (4) X2-S27: DT-16 passes, and the probe-coverage clauses of DT-41 pass during a 64 → 128 doubling. (5) X2-S18: each probe operation is scored correct or failed against its limit, on the contract fakes. (6) X2-S01: DT-40 passes against the simulated edge, and a 7-day soak on the emulated cell, with probes against the contract fakes and the weekly failure-injection schedule, gives an availability per capability and region at or above its X2-S01 target, computed by the monthly pipeline. (7) In the soak, the share of admission and wallet probes with no correct answer within 1 s is at most 5×10⁻⁴ per location, and the runner skip rate is at most 10⁻⁴ |
| Dependencies | I3 (slot map, probe accounts), I4 (two regions), I6 (alert routing). Frozen C05, C06, C07, C08, C10, C11 |

### S-PLAT-I8. Disaster declaration and measurement pipeline

| | |
|---|---|
| Goal | A region disaster is declared only as POL-06 and POL-32 allow. Latency and timeliness are computed per calendar month and region, with the disaster window left out |
| Components | Placement (`disasters`, declaration checks); probes and measurement (pipeline, exclusions, error budgets) |
| Contracts | Consumes C08 v1.2 (operator envelope, four eyes, `operator_check`, region-disaster target summary), C06 v1 (rating watermarks for charge timeliness) |
| Scenarios delivered | X2-S23, X2-S25, X2-S26, X2-S28, X2-S29, X2-S31, X2-S32 |
| Work items | (1) `declare_region_disaster` and `end_region_disaster`: network operations only, a second network-operations approver, `approval_expiry` 72 h, cancel, basis re-check at approval. (2) Basis rules: recorded loss (earliest of `topology_events` and `loss_observations`), probe evidence (a run of measured failing minutes), the earlier-of rule; the window start computed by the system, never stated by the operator. (3) Open-disaster-over-healthy-region page after 30 min. (4) Measurement pipeline: per-minute HDR histograms per (region, operation, class) (input interface B5), per-month p99 per region, end-to-end timings of §18.2, charge timeliness of §18.3, exclusions of §18.4, report regeneration on each approved declaration or end. (5) Burn-rate alerts of §18.5 |
| Exit criteria | (1) X2-S25: DT-18 passes. (2) X2-S26 and X2-S28: DT-19 passes. (3) X2-S29: DT-26 passes. (4) X2-S31: DT-31 passes. (5) X2-S32: DT-32 passes. (6) X2-S23: DT-11 passes with a declared disaster; in the window, the pipeline leaves out every latency target, while A-T4 and the fact checker keep running and report; every fact is acknowledged only after it is durable in two regions (fact checker on the 2 + 2 configuration). (7) DT-20 passes on recorded synthetic histograms |
| Dependencies | I4 (topology events, loss recorders, 2 + 2), I7 (minute classification). Frozen C06, C08 |

### S-PLAT-I9. Design-load acceptance and go-live gate

| | |
|---|---|
| Goal | The whole system meets the X2 load, latency and timeliness targets on the real three sites, and every go-live condition is recorded |
| Components | Every S-PLAT component; the pre-production cell |
| Contracts | C01 v1 and every consumed contract, end to end with the other slices' conformant code |
| Scenarios delivered | X2-S03, X2-S04, X2-S05, X2-S06, X2-S07, X2-S08, X2-S13, X2-S15, X2-S17, X2-S19, X2-S20, X2-S22, X2-S24 |
| Work items | (1) SP4 on the real sites; apply its decisions (preferred region, `δ_x_cfg`, PTP, node and broker counts). (2) SP1 (c). (3) The load test of §19.5 for at least one hour, and the second run with a database node loss, an owner host loss, a facility loss and a region-wide failover. (4) The §22.2 failure-injection schedule on the pre-production cell. (5) End-to-end probes on the real services (DT-17). (6) Fibre verification of §20.2, facility inventory, licences, support contracts, staffing record. (7) CP-13 and the sealer re-run with RFC-005's library (B1) |
| Exit criteria | (1) Every SP4 exit criterion is met. (2) X2-S03, X2-S05, X2-S06, X2-S15: in the load test, the single-link p99 to an answer, the final-answer p99 with no capacity in flight, and the route first-response p99 are each at most 200 ms per region; every route has its outcome by its deadline (A-T4 silent). (3) X2-S04, X2-S13, X2-S22: at 260,000 records a second with 600,000 a second peaks, accruals are posted within 2 min and usage charges within `max_lateness` + 2 min of the minute's end in every minute; every record is counted in headroom within 10 s. (4) X2-S07: at 1,000 notifications a second, top-up to credited headroom p99 ≤ 10 s. (5) X2-S17 and X2-S08: every standing change reaches network operations within 10 s, and every suspension is enforced within 60 s. (6) X2-S19: in a declared-disaster drill, every charge of the affected minutes is posted within target + 1 h, none lost and none posted twice. (7) X2-S20 and X2-S24: DT-17 passes on the real services. (8) No failing slot-minute and no probing fault in the hour; the share of admission probes slower than 200 ms is below 5×10⁻⁴ at each location. (9) The second run shows RPO 0 and every X2-S10 RTO. (10) The §20.2 sign-off record is complete |
| Dependencies | I1 … I8, SP1, SP4. Blockers B1, B2, B3, B5 (§9) |

## 6. Contract tests by increment

| Test | Increment that passes it |
|---|---|
| CP-1, CP-2a, CP-2b, CP-2c, CP-3, CP-4, CP-7, CP-7a, CP-8, CP-11 | I1 (re-run in I3 with moves and stops) |
| CP-2 | I1 (six results), I3 (complete) |
| CP-9 | I1 (without moves), I3 (complete) |
| CP-13 | I1 (clauses 1, 2, dev sealer), I3 (complete, dev sealer), I9 (RFC-005 library) |
| CP-5, CP-6, CP-10 | I3 |
| CP-12 | I5 |
| CP-14 | I7 |
| CC-1 … CC-8 | Runnable from I1 through `@share/owner-runtime/testing` (consumer slices run them) |

## 7. Scenario map

Each X2 scenario of the slice is in exactly one increment. Check:
`rg -o '^\| X2-S[0-9]{2} \| S-PLAT-I[0-9] \|' docs/04-delivery/plan/S-PLAT.md | sort | uniq -c`
must show 33 rows, each with count 1, and no ID twice.

| Scenario | Increment |
|---|---|
| X2-S01 | S-PLAT-I7 |
| X2-S02 | S-PLAT-I1 |
| X2-S03 | S-PLAT-I9 |
| X2-S04 | S-PLAT-I9 |
| X2-S05 | S-PLAT-I9 |
| X2-S06 | S-PLAT-I9 |
| X2-S07 | S-PLAT-I9 |
| X2-S08 | S-PLAT-I9 |
| X2-S09 | S-PLAT-I4 |
| X2-S10 | S-PLAT-I4 |
| X2-S11 | S-PLAT-I5 |
| X2-S12 | S-PLAT-I4 |
| X2-S13 | S-PLAT-I9 |
| X2-S14 | S-PLAT-I4 |
| X2-S15 | S-PLAT-I9 |
| X2-S16 | S-PLAT-I7 |
| X2-S17 | S-PLAT-I9 |
| X2-S18 | S-PLAT-I7 |
| X2-S19 | S-PLAT-I9 |
| X2-S20 | S-PLAT-I9 |
| X2-S21 | S-PLAT-I4 |
| X2-S22 | S-PLAT-I9 |
| X2-S23 | S-PLAT-I8 |
| X2-S24 | S-PLAT-I9 |
| X2-S25 | S-PLAT-I8 |
| X2-S26 | S-PLAT-I8 |
| X2-S27 | S-PLAT-I7 |
| X2-S28 | S-PLAT-I8 |
| X2-S29 | S-PLAT-I8 |
| X2-S30 | S-PLAT-I7 |
| X2-S31 | S-PLAT-I8 |
| X2-S32 | S-PLAT-I8 |
| X2-S33 | S-PLAT-I7 |

Totals: I1 1, I4 5, I5 1, I7 6, I8 7, I9 13. I2, I3 and I6 deliver no X2 scenario; they
deliver contract parts and scenarios of other slices (stated in each increment).

## 8. Risks

### 8.1 Contract issues CI6-1 … CI6-4 (plan around them; they do not block)

| # | Issue | Plan |
|---|---|---|
| CI6-1 | C08 v1 Transport row names audit's `integrity_stops` as the restore role's predicate; C01 R47-28 and C08 §K name `placement_integrity_stops` | I3 builds the restore-role policies on `placement_integrity_stops` (C01). The restore role gets no grant on audit's table. DT-45 checks it. The C08 erratum stays owed. Risk: S-SEC builds to the old Transport row; S-SEC's plan (CI5 list) and the C08 §K text are the check |
| CI6-2 | C01 §3.6 lists six closure streams; C06 marks six more topics "Yes" | I1 drives closure from each stream's declared `closure` flag, never from a fixed list. I1 tests closure on a test kind that declares a C06 topic. One relayed owner kind per closure topic |
| CI6-3 | C01's ACL patterns do not cover `settlement.posting-acks.v1` (two producers, one outside an outbox) | I1's ACL generator takes explicit producer lists from contracts. That topic lists the ledger's holder and relay and settlement's principal, and gets no closure markers. CP-2b covers it |
| CI6-4 | C05 sizes `account.usage-applied.v1` at replication factor 3; the cluster uses 4 | I4 sizes the topic at 12 to 24 TB (est.) at factor 4, with retention of at least 7 days |
| CV-1 | RFC-006 revision 7 cites C07 1.1 and C08 1.1; the frozen files are C07 1.2 and C08 1.2 | This plan consumes 1.2. The 1.2 changes (four-eyes credit limits above 10,000 USD; clarifications) do not reach a probe-account limit (§17.4 rule 4). No action; record at plan review |

### 8.2 RFC-006 risks

| Risk | Disposition |
|---|---|
| RK1 Single-writer bugs in the runtime | Work item: TLA+ model and Jepsen harness from I1, extended in I3 and I4; an exit criterion of each. Review of the runtime by an engineer outside the runtime team before I3 |
| RK2 Fibre condition, RK3 facility inventory | External; blocker B2; I9 gate |
| RK4 GNSS jamming or spoofing | Work item in I4 (two vendors, holdover page, external references, region gated) |
| RK6 Bandwidth and storage estimates | SP4 and the I9 load test measure them |
| RK8 R3 capacity in a regional event | Work item in I4 (standing non-voters; capacity reservation for the second voter set). Procurement is part of B2 |
| RK9 Seven-year readability | Work item in I5 (format corpus in CI, schema registry) |
| RK11 Loss of both Kenyan regions | Accepted: outside X2-N4. I5's quarterly full restore from GCS times the recovery |
| RK12 Webhook load unknown | Accepted: I6 sizes for 20,000 notices a second; re-sized when measured |
| RK13 `δ_x` tail in the degraded state | Work item in I2 (A-T2, A-T3 automation); SP4 measures p99.9 |
| RK14 Gray failures that probes miss | Work item in I7 (internal canaries) |
| RK15 The database is a product Share does not control | SP3; enterprise licence and support in the I9 gate; RB-17 |
| RK16 Range-lease failover longer than the hot-standby budget | SP4 exit p99 ≤ 6 s; accepted meanwhile (about four breaching minutes a month of budget) |
| RK17 Node.js pauses | Work item in I1 (loop monitor, shedding, worker threads); SP1 (b) |
| RK18 Fault tolerance after 2 + 2 takes hours for non-admission tables | Accepted (RFC-000 AI6-4); I4 keeps standing non-voters for admission |
| RK19 Degraded latency in undeclared states | Accepted: a business trade-off of RFC-000; RB-7 |
| RK20 Changefeeds at scale | SP4 (CPU, lag). Contingency work item: the polling relay of RFC-006 Competition, built only if SP4 fails |
| RK21 Drift of the whole cluster | Work item in I4 (clock monitor with external references) |
| RK22 Payment-binding growth | Accepted; RFC-004 decides |
| RK23 Ciphertext limits compression | Accepted; sized in RFC-006 §19 |
| RK25 Open disaster over a healthy region | Work item in I8 (30 min page, monthly listing) |
| RK26 Batching waits | SP1 decides the second account lane |
| RK27 Payloads in the personal-data store | Work item in I5 (storage alarms at 50%; 40 TB allotment) |
| RK28 Slot CPU cost and probe errors | SP1 (cost); I7 soak measures `p` per location |
| RK29 Kafka controller outside R1 at a link cut | Work item in I4 (controller placement by controlled restart) |
| RK30 Legal may require a Kenyan cold copy | Accepted until legal decides; I5 makes the hot copy's lock and capacity configurable |
| RK31 Staffing | External; part of the I9 gate (B2) |
| RK32 Closure emitter on every feed's path | Work item in I1 (emitter as an owner with a standby) and I6 (`CLOSURE_LAG`) |
| RK33 Kafka in-sync churn | SP2 and SP4 |
| RK34 Moves and doublings add protocol | Work item in I3 (TLA+, Jepsen, CP-5, CP-6, CP-10, DT-37, DT-41, DT-42, DT-45) |
| RK35 Arbiter outside Share's network | Work item in I7 (signed and authenticated verdicts, fail closed) |
| RK36 Partitions per broker | SP2 |
| RK37 Short-probed slots | Work item in I7 (no skip for load, skip-rate page) |
| RK5, RK7, RK10, RK24 | Resolved or closed in RFC-006; no work |

### 8.3 Plan risks

| # | Risk | Plan |
|---|---|---|
| P-1 | Every other slice waits for I1 | I1 ships the runtime double first (week one of I1) so consumers can start; §3 tells each slice which increment gives each part |
| P-2 | The dev cell needs CockroachDB enterprise features (changefeeds to Kafka, follower reads, bounded staleness) | Get a development licence key before I1 starts. Without it, I1 cannot pass CP-8 or CP-9 |
| P-3 | Emulated RTTs can hide real-site behaviour | I4 numbers are provisional; SP4 and I9 repeat them on the real sites |
| P-4 | Contract fakes can drift from the providers' real behaviour | Fakes are built from the frozen schemas and worked examples; I9 runs end to end on real services |

## 9. Blockers

| # | Blocker | Affects | Owner |
|---|---|---|---|
| B1 | RFC-005's column-encryption library and key service (C13, HSM key release) has no frozen delivery contract. C08 excludes it | Production sealing in I1 … I8 (a dev sealer is used meanwhile); relay key holding (I2); archive segment keys (I5); CP-13 with the real library (I9) | S-SEC (RFC-005) and the contracts owner |
| B2 | The real three sites: the four fibre paths (§20.1), the facility inventory (§20.4), R3 capacity reservation, the CockroachDB enterprise licence and support contract, the staffing record | SP4, SP1 (c), I9 | Share network team, platform lead, procurement |
| B3 | Other slices' conformant code (C6) on the pre-production cell: edge and booking (C10), account owner and funds (C04, C05), link owner (C03), ingestion, rating, ledger, payments, payouts and reporting (C06, C07, C11), identity (C08) | I9 (load test, end-to-end probes, DT-17) | S-LINK, S-ACCT, S-MONEY, S-RATE, S-SEC |
| B4 | No frozen operation creates a Share-internal probe account with KYB passed in identity | The real provisioning path in I3 (doubling step 2) and I7; fakes are used for the exits | S-SEC and the contracts owner |
| B5 | No frozen contract states the edge's hooks: per-request latency records with the capacity-in-flight flag (RFC-006 §18.1), the edge health canary and the anycast withdrawal (§2) | Real DT-40 (I7), the latency inputs of I8, X2-S05/S06/S15 in I9 | S-SEC (edge) and S-PLAT, through a new contract or a C10 erratum |
| B6 | Conditional on SP3: if Cloud EKM is not usable in `africa-south1`, database backups have no permitted key path (no passphrase fallback) | I5 backups | Raised against RFC-005 and RFC-000 |
