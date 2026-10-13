# S-PLAT I1b status

Checks: `npm run typecheck:platform` is clean. `npm run test:platform` passes 53 tests. `npm run test:platform:integration`
passes 17 tests on the dev cell (CockroachDB 24.3.5 with 3 nodes, Kafka 3.9 with 1 broker).

## The integration hang (fixed)

- Cause: in the dev cell CockroachDB returns `count(*)::INT` as INT8, and `pg` gives INT8 as a string. So the first
  assertions failed. Each test called `close()` only on its success path. Thus a failed test left its runtime running.
  The session renewed every 200 ms on a pooled socket, which kept the event loop alive. The test file never ended, and
  `node --test` printed nothing while the file ran. The leaked runtimes also kept their slots, so the next tests got
  `StaleEpoch`.
- Fix: the tests use `count(*)::INT4`. An `afterEach` hook closes every runtime, pool and Kafka consumer, also after a
  failure. Each test has a 30 s timeout. The npm script adds `--test-timeout=60000 --test-force-exit`.
- Two fault injections did not match how CockroachDB behaves. A client-made 40001 at RELEASE keeps the transaction
  timestamp, so CP-3 "new ts" failed. The test now uses `crdb_internal.force_retry`, a real restart. The StaleEpoch
  test now pushes the batch with a high-priority read after the epoch bump. Without that push, CockroachDB can correctly
  order the batch before the acquisition.
- `PgStore` sends `statement_timeout` and `idle_in_transaction_session_timeout` as startup options. This removes the
  pg "client.query while executing" deprecation warning and the race on the first query.

## C01 parts done in I1b (`platform/runtime/src/…`)

| Part | Where | Tests |
|---|---|---|
| Changefeed per outbox table, relay (re-key, delete drop, `relay.progress.<kind>`) §3.5 | `relay/relay.ts` | feeds unit; CP-8 (cell) |
| Closure emitter: R_min over `cdc` metadata partitions, hold-back, never back, `dataHighWater`, Resolved/Closed markers, 10 s heartbeat, all links once for a new holder, emitter slot lease §3.6 | `closure/emitter.ts` | CP-8 unit + cell (also across changefeed re-creation and a partition-count increase) |
| Consumer runtime: stream_seq order, buffering, duplicate drop, gap fill after 5 s (`PgGapFill`), D3 conflict rule, `reported` gate, `onMarker` keeps every marker, `onResolved`/`onClosed`, offsets committed below the first undelivered record §3.4–§3.6 | `consumer/` | CP-9 unit; X2-S02 + CP-9 (cell, stop and restart) |
| Report position, read leases (400 ms, inside the view, after read_lease + ε), marker-only transactions, marker chain (`prevReportPosition` from `owner_slot.report_through`, `pendingAnswered`, chunks of 5,000, rule 7), `onReportable` §3.1, §3.4 | `report/report.ts`, `runtime.ts` | CP-7, CP-7a unit + cell |
| `StatusReaderRuntime`: `readLease`, `leasedRead` at `with_min_timestamp(ceil_µs(P_grant))`, `replicaRule3Check` with caching, `isMovedOut` false | `status/reader.ts` | CP-7 (cell) |
| Grants and roles §2.3, conformance job (CP-11) | `migrate/src/grants.ts` | unit; CP-11 (cell) |
| Kafka producer ACL generator §2.5 | `acl/kafka-acl.ts` | unit |
| Placement feed `placement.slot_map.v1` with a fixed map; `slotOf`/`route('account')` from it §3.8 | `placement/slot-map.ts` | unit |
| Buses: `KafkaBus` (kafkajs) and `MemoryBus`; `MemoryChangefeed` in `/testing` | `feed/` | all of the above |

Runtime options added: `feeds` (bus, gap fill, gap timeout, alert, `producerOf`), `slotMap`, and `testing.postAcquisitionWaitMs` / `markerChunkMax`.
New runtime methods: `grantReadLease`, `attachReader`, `detachReader`, `feedConsumer`, and `markersWritten` (for tests).

## Additions asked by the slice teams (all additive; one test each in `test/additions.test.ts` and the cell)

- `displacementRead`: a marker of ANY attempt fails the condition (C02, P1-S78). `ConditionFailed.displacement` (optional)
  carries the marker's attempt and row. The double does the same (`putDisplacementMarker`).
- `readLog(partition, fromSeq)` gives opened rows (payload, audit, sender fence). `listPartitions(slot)`. The admitCommand
  high-water is rebuilt from the log before `onAcquire` (R47-24). A sender fence is kept in the sealed payload envelope.
- Slot-wide commit sequence (C08 §C): `slotPositions: true` in the declaration gives `ctx.slotPosition` and
  `Committed.slotPositions`. The value is kept in the new platform table `owner_slot_position`.
- `hlcParts`, `validTopic` and `assertIdentifier` are exported. `AuditFields.principal.tenant` is `Tenant | string`, and
  `received_at` is `EpochMicros | number`.
- `selfOutboxed` is accepted. The migration adds `<kind>_stream_index` and the batch fills it. The outbox is still
  written (TODO I2). A stream topic can be a contract topic named exactly (e.g. `catalogue.v1`). A stream key can be
  `{ field }`. Declared `messages` are published with `publishMessage(name, partition, value)` and get the stream ACL.
- `MemoryStore` `consistentRead`/`followerRead` answers `SELECT … FROM t [WHERE c = $n AND …]` over projections and heads.
- Double: `start()` calls `onAcquire` and `onReportable` for the start slots. The report position moves with each
  commit. The double writes `chain`. `route` uses the target kind's slot count. `RuntimeDouble.group(decls)` serves
  several kinds in one world. `consistentRead` returns rows. `StatusReaderDouble` is new.

## Left (TODO, each named in code)

- TLA+ model (plan item 15) and Jepsen harness (item 16): TODO in `runtime/src/index.ts`.
- Takeover republish from the closure position (§3.5). Marker liveness rule 10 (read a missing first covering marker
  from the outbox). Notification delivery by `onNotification`: the I1a seal context of a notification includes the
  writer's slot, which the receiver cannot know.
- Dev cell: one Kafka broker, no SASL and no authorizer, so the generated ACLs are not applied (`aclCommands()` prints them).
  Status readers talk to the holder in process, not over gRPC. Handoff (§3.1), standbys, owner-host offset check,
  closed timestamp proper, `integrity_report`. The service packages `platform/relay`, `platform/closure-emitter`,
  `platform/status-reader` and `platform/placement` are not split out: the code is in `@share/owner-runtime`.
- Package versions stay at `1.0.0-alpha.1`, because the workspace dependencies pin the exact version.

## C01 issues found (for v1.1 errata)

1. Rule 7 needs the request id of EVERY covered outcome, but `EntryInput` carries one only when `pending` was sent.
   This runtime uses `pendingAnswered ?? identity` and keeps it as `outcome_id` in the outbox `headers` column only
   (never on Kafka).
2. Row-level security (R47-18) and column privileges (V59-3) are not in CockroachDB 24.3. The fallbacks are: placement
   uses a SECURITY DEFINER function `placement_set_stops_version`, and gap-fill roles read a view per consumer. Kind
   confinement of `owner_session`/`owner_slot` UPDATE needs CockroachDB 25.2 or later (`grantMigration({ rowLevelSecurity: true })`).
   The conformance job warns about this.
3. The report-marker outbox row key is not defined. This runtime uses partition `''`, stream = the outcome stream,
   `stream_seq` = `marker_seq` (one per chunk), n = 0. The marker body is sealed with a context that the consumer
   builds from clear headers.
4. A gap is found only when a later event arrives. Without the relay, the last event of a stream can wait for the next
   one. The relay (the guaranteed path) closes this.
5. `slot-wide position` (C08 §C) and `owner_slot_position` are not in C01 §2.3. They are added here.
6. The readings accepted by the orchestrator are used: home = SHA-256[0..4) big-endian mod 2^20; an Ambiguous call is
   answered once and the slot is blocked until it is resolved; the `onTimer` option; `<kind>.notifications.v1`, where
   the kind is the sender's.
