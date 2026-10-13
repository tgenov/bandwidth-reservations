# S-PLAT I2 status

Increment: S-PLAT-I2 "Runtime completion for owner kinds" (`docs/04-delivery/plan/S-PLAT.md` §5). Package version stays
`1.0.0-alpha.1` (I3 releases `1.0.0`). Every addition is optional, so C01 v1 consumers do not change.

Checks (this run, 2026-10-13, after the fixes of review 68): `npm run -s typecheck` passes (all workspaces);
`npm run -s test:platform` 296 pass, 0 fail (two runs); `npm run -s test:contracts` 75 pass, 0 fail, 3 todo (`PENDING real provider` entries of other
slices, not of this increment); `npx eslint platform contracts` is clean. `npm run check` and `npm run ci` were not run
(engineering.md §2: an agent runs only the slice's tests and `test:contracts`).

Integration tests: **integration proof written, not run (manual)**. A person runs `REQUIRE_DEV_CELL=1 npm run
test:platform:integration` on the dev cell. The integration tests of I2 are `platform/runtime/test/integration/i2.test.ts`,
`selfout.test.ts` and `timing.test.ts`. Each one makes its own database (`ii2_…`, `iselfout_…`, `itiming_…`) and uses
unique kind and topic names. The timings quoted below as "on the cell" come from an earlier agent's runs; nobody has
run them again on this tree.

## Work items

| # | Work item | Where | Tests |
|---|---|---|---|
| 1 | Second lane per slot. Only calls of partitions that are not in the other lane's batch; a later call of such a partition waits too, so the partition keeps its order. `platform_timing.second_lane[kind]`: `account` (any call) or `deadline` (calls with `lane: 'second'`). Off: `lane: 'second'` runs on the first lane. Lane (c) cannot happen. The runtime reads `platform_timing` on each renewal tick | `runtime.ts` (`pump`, `take`, `startBatch`, `secondLaneMode`, `refreshTiming`) | `second-lane.test.ts` (4); cell: CP-1 with the second lane |
| 2 | Push of every `Committed` batch to the hot standbys (`attachStandby`). The standby (`standby: { apply }`) applies a push only when the seq continues, else waits for its follower-read tail (`standby_poll` 250 ms). It holds no slot while its holder lives, polls the session at present time every 250 ms, takes the slots on expiry, and reads at present time only the rows above its tail. Transport: gRPC (`@grpc/grpc-js`), one client stream `share.owner.standby.v1.Standby/Push` per (holder process, standby process), protobuf messages encoded by hand. `GrpcStandbyChannel` (holder side) never waits and never throws: it drops a push when 1,024 pushes are queued on the stream (est.), when the stream broke, or after `close`; it opens a new stream on the next push and reconnects with a backoff of 100 ms to 1 s. `GrpcStandbyServer` (standby side) gives each push in stream order to `standbyChannel()` | `standby/tail.ts`, `standby/grpc.ts`, `runtime.ts`, `PgStore.tailLog` | `standby.test.ts` (5), `standby-grpc.test.ts` (10: the codec and its 3 refusal codes, order, queue limit, a standby down and back, a closed channel, an apply that throws, holder and standby runtimes over gRPC on loopback); cell: DT-28 |
| 3 | Self-outboxed kinds: no outbox table; `<kind>_stream_index` in the batch; 25 h GC on the log; the changefeed on the log; the relay (`derive`) opens the row with the log key and derives the events with the versioned emit functions (`emitFns`); the holder checks that its declared events are what the emit functions derive; gap fill through the stream index (`LogDerivedGapFill`); grants and the gap-fill view over index ⋈ log | `selfout/derive.ts`, `relay/relay.ts`, `consumer/gapfill.ts`, `relay/memory-changefeed.ts`, `migrate/src/generate.ts`, `migrate/src/grants.ts` | `self-outboxed.test.ts` (7), `generate.test.ts` (+1); cell: `selfout.test.ts` (2) |
| 4 | Slot groups. A leader runtime (`slotGroup: { members }`) and members (`slotGroupMember: true`) share one session. Slot i of every member is taken (free or by expiry), re-homed and resumed in one transaction, or not at all; `owner_slot.slot_group` is set; `onAcquire` for every member before the group serves | `runtime.ts` (`acquireWantedGroup`, `rehomeGroup`, `resumeGroup`), `PgStore.acquireGroup/rehomeGroup` | `slot-group.test.ts` (7); cell: 2 tests |
| 5 | Checkpoint store: seal under the partition's log key, SHA-256 digest, own region only, idempotent by (kind, partition, seq), `DIGEST_MISMATCH` with an alert, retention of the last 3 and 48 h (`prune`). `putCheckpoint`/`getCheckpoint` with `checkpoints:`. `S3ObjectStore` on an S3-compatible store (the region's Ceph RGW): `open` refuses a bucket whose location constraint is not the process's region (`OTHER_REGION`); listings follow continuation tokens; a missing key (`NoSuchKey` or 404) is `undefined`; other S3 errors pass through; a bad answer is `BAD_RESPONSE`. It uses a subset of the S3 API (`S3Api`, the shape of the AWS SDK v3 `S3` client); the package has no S3 client dependency | `checkpoint/store.ts` (`MemoryObjectStore`, `FileObjectStore`), `checkpoint/s3.ts` (`S3ObjectStore`) | `checkpoint.test.ts` (65: the object-store and checkpoint suites also run on `S3ObjectStore` over the S3 double of `test/support.ts`, with pages of 2 keys), `s3-object-store.test.ts` (7), `timing-runtime.test.ts` |
| 6 | `platform_timing` versions written by placement to all 64 shards in one transaction (`writeTimingVersion`); `tsBefore` bounds from the version read in the batch; timing alarms A-T1 … A-T5 (`TimingAlarms`), the timing probe driver (`TimingProbe`), placement's loop that raises each episode on the alert stream and writes the fast-attack version (`TimingController`, `busAlertSink`) | `placement/timing.ts`, `placement/timing-controller.ts` | `timing.test.ts` (44), `timing-runtime.test.ts` (3); cell: `timing.test.ts` (3), DT-10 |
| 7 | Gateway tiers: one pool per tier; 400 ms per-tier timeout on the renewal, the epoch read and the session poll; a 2.5 s client-side limit on every other statement except COMMIT (15 s backstop); a breaker per tier after 3 timeouts (or `open()` on an outside signal); a batch that times out is abandoned and starts again on the next tier; idle connections kept on every tier | `store/tiers.ts`, `store/pg.ts`, `batch/execute.ts`, `testing/fault-proxy.ts` | `offset-tiers.test.ts` (2), `store-tiers.test.ts` (10: the PgStore tier loop with pool doubles); cell: the tier test |
| 8 | Owner-host offset check every second; level A (above 40 ms): stop taking slots and hand the slots off; level D (above 50 ms on 3 samples): revoke the session at once, stop serving, `onGiveUp`. `now().boundMs` is the last bound | `offset.ts`, `runtime.ts` (`offsetCheck`) | `offset-tiers.test.ts` (5); cell: DT-09 |

## Exit criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | DT-09 (owner-host part) and DT-10 pass | **Met by unit test**; cell part: integration proof written, not run (manual). Note on DT-09 (issue 6) | Unit: `DT-10 raising δ_x_cfg …` (`timing-runtime.test.ts`), the 64-shard write and refusal tests (`timing.test.ts`), `DT-09 an owner host whose offset bound exceeds 50 ms gives up its session within 3 s (in-memory database clock)`. Integration (not run): `DT-10 on the cell …`, `DT-10 placement writes a new platform_timing version to all 64 shards in one transaction`, `DT-10 a reader never sees mixed platform_timing versions …`, `DT-10 a refused platform_timing version changes no row`, `DT-09 (owner-host part) on the cell …`. An earlier run reported about 2.0 s from the first sample above 50 ms, 2.9 s from the clock change |
| 2 | DT-28 (in-region): a killed link-kind holder is replaced by its hot standby within 5 s with no reload beyond the last pushed batch | **Met by unit test** (in-region part); cell part: integration proof written, not run (manual) | Unit: `should take no slot while the holder lives, … take over with no catch-up row when the holder dies (DT-28 at the unit level)` and the 4 other `standby.test.ts` tests. Integration (not run): `DT-28 (in-region) on the cell …` (an earlier run: served 3.2–3.4 s after the kill, `catchUpRows` 0). Unit, over gRPC on loopback: `should keep the hot standby current from gRPC pushes alone and let it take over with no catch-up row when the holder dies`. The integration test still pushes in process (written, not run (manual)). The cross-region part is I4 |
| 3 | A slot group is always taken in one transaction or not at all, under the Jepsen harness | **Manual proof owed: needs the Jepsen harness (S-PLAT-I1 item 16)** | No Jepsen harness exists (I1 item 16 is open). A person runs the proof when the harness exists. In its place: unit `should keep both members of every slot under one session at every observation when two group processes contend across seeded pauses`, fault injection `should change neither row when the group transaction fails after its first member update …`, and integration (not run) `C01 §3.1 slot groups on the cell: two group processes contend …` and `… a group with one member held by another live session is not taken at all`. Not proven: network partitions, crashes inside the transaction on a real node, 24 h runs |
| 4 | A self-outboxed test kind with three streams passes CP-8 and CP-9 (same clauses as in I1) | **Met by unit/contract test**; cell part: integration proof written, not run (manual) | Unit: `C01 CP-8 self-outboxed …`, `C01 CP-9 self-outboxed …` (3 tests). Integration (not run): `C01 CP-8 self-outboxed on the cell …`, `C01 CP-9 self-outboxed on the cell …`. "Across a move" stays I3 |
| 5 | A second-lane batch never carries a partition of the first lane's batch; per-partition seq stays contiguous (CP-1 re-run with the second lane on) | **Met by unit/contract test**; cell part: integration proof written, not run (manual) | Unit: `C01 CP-1 with the second lane on: across seeded load, a pause and a takeover …` (3 seeds), `should keep a partition in the first lane's batch out of the second lane …`, `should carry only calls marked lane second …`. Integration (not run): `C01 CP-1 with the second lane on, on the cell …` |
| 6 | With the gateway tier of one facility cut by the fault proxy, renewals reach the next tier within one 400 ms timeout and no session lapses | **Tier switch met by unit test**; the fault-proxy and no-lapse proof: integration proof written, not run (manual) | Unit (`store-tiers.test.ts`, PgStore with pool doubles): `should give up a cut tier after one 400 ms per-tier timeout and renew on the next tier at once …` (tier 0 given up in 400–450 ms, tier 1 tried within 20 ms, the cut client discarded), the breaker after 3 renewals, a refused connection, a revoked session, a database error (no next tier, no breaker count), all tiers silent, the session poll and `beginBatch` on the next tier, and the epoch read. Integration (not run): `should reach the next gateway tier within one 400 ms timeout and let no session lapse when the gateway tier of one facility is cut by the fault proxy` (a local TCP proxy per tier; checks no lapse in the database and in the holder's view, appends go on, the breaker of tier 0 opens) |

Defect found and fixed in this run: a stalled epoch read (`PgBatchTxn.readFence`) had two timers, the 400 ms per-tier
limit and the 2.5 s statement limit, and each one counted a timeout. So one stalled read counted 2 of the 3 timeouts that
open a tier's breaker. Test: `should count one timeout, not two, when one epoch read does not answer, also after the
2.5 s statement limit has passed`. Fix: the epoch read uses the per-tier limit as its only limit.

The plan also names RK13 (`δ_x` tail): A-T2 and A-T3 automation is done (`TimingController`); SP4 measures p99.9.

## Review 68 (test review of S-PLAT-I2)

Review: `docs/reviews/68-test-review-platform-S-PLAT-I2.md` (INADEQUATE: 3 Blocker, 14 Major, 6 Minor). Each test was
written first. The 10 surviving mutants of the review (M1 … M10) and the other "no test fails" changes of TR-7, TR-8,
TR-9, TR-11, TR-12, TR-14, TR-16, TR-19, TR-20 and TR-22 were made again by hand: each one now makes
`npm run -s test:platform` fail (24 mutants, 24 killed). No mutant is left in the tree.

Code defects found and fixed:

1. **TR-1.** A push to the hot standby had `advances = true` in two cases where a committed batch with a lower `ts` was
   not pushed yet: an Ambiguous batch resolved as committed while the other lane had a batch in flight, and any batch
   that committed while an Ambiguous batch of the slot was not resolved. The standby then moved `complete` past the
   other batch and dropped its push; the takeover catch-up did not read it again. Now a push advances only when no
   batch of the slot is in flight on the other lane and no Ambiguous batch of the slot is unresolved (`Lane.unresolved`).
2. **TR-7.** At offset level A, the slots of a slot group were released one member kind at a time, in separate
   transactions. Now `OwnerStore.releaseGroup` frees every member in one transaction (`MemoryStore`, `PgStore`). A
   hand-off that fails is tried again on the next renewal tick while the level stays A.
3. **TR-7.** A hot standby never took a free slot, so it did not take the slots that its holder handed off at level A.
   Now a standby takes a free slot that somebody held before (epoch above 0); it never takes a slot nobody has held.
4. **TR-14.** When the relay could not derive the events of a log row, the error stopped the bus delivery with no
   record of it. Now the relay halts (`OutboxRelay.halted`): it publishes nothing of the row, writes no progress and
   commits no offset after it, so no closure passes the row.

| ID | Severity | State | Tests, change |
|---|---|---|---|
| TR-1 | Blocker | Fixed (code defect 1) | `standby.test.ts`: `should keep every committed row in the standby memory and send advances false …`, `should push an Ambiguous batch resolved as committed with advances false …`, `should push with advances false while an Ambiguous batch of the slot is not resolved` |
| TR-2 | Blocker | Fixed (test only) | `timing-runtime.test.ts`: `DT-10 should refuse a confirm whose ts equals D − τ, and commit one whose ts is 1 ns before D − τ` (stepped clock) |
| TR-3 | Blocker | Fixed in the 12 I2 test files | Stepped clocks (`steppedClock` in `test/support.ts`) for the store and the runtime; session expiry by a clock step; waits for events with a timeout (`until`, counts of renewals, standby polls, offset samples, emitter passes, committed offsets); mock timers in `store-tiers.test.ts`; DT-09 counts samples (level D on the third sample, 2 × `OFFSET.intervalMs`); the slot-group loop is a seeded list of rounds. Not in scope: the I1 files `feeds`, `report`, `runtime-core`, `additions` still sleep |
| TR-4 | Major | Fixed (test only) | `second-lane.test.ts`: `should never start an exclusive or firstStatement call on the second lane …` |
| TR-5 | Major | Fixed (test only) | `second-lane.test.ts`: `should keep queue order of one partition when an ordinary call of it waits …` |
| TR-6 | Major | Fixed (test only) | CP-1 loop: lost COMMIT answers (both outcomes), one revocation and re-home, a pause and a takeover; `checkLog` asserts strictly increasing `ts` per partition from batch to batch (commit order) |
| TR-7 | Major | Fixed (code defects 2, 3) | `slot-group.test.ts`: `should hand off slot i of every member in one transaction or not at all …`; `standby.test.ts`: `should let the hot standby take the slots that its holder handed off …` |
| TR-8 | Major | Fixed (test only) | `store-tiers.test.ts`: 4 tests of `PgStore.acquireGroup` and `rehomeGroup` with a scripted client (`BEGIN`, `UPDATE`, `ROLLBACK`/`COMMIT`) |
| TR-9 | Major | Fixed (test only) | `batch-tiers.test.ts`: one timeout ⇒ a fresh attempt commits, the first transaction discarded with no ROLLBACK; two ⇒ `retry` |
| TR-10 | Major | Fixed (test only) | `offset-tiers.test.ts`: bounds of exactly 40 ms and 50 ms |
| TR-11 | Major | Fixed (test only) | `offset-tiers.test.ts`: `should take no slot for 10 min after the bound returns within 40 ms …` (+599,999 ms, +600,000 ms) |
| TR-12 | Major | Fixed (test only) | `offset-tiers.test.ts`: `should serve a slot whose acquisition committed but whose answer was lost …` |
| TR-13 | Major | Fixed (test only) | `timing.test.ts`: τ = 200 accepted |
| TR-14 | Major | Fixed (code defect 4) | `self-outboxed.test.ts`: `EMIT_MISMATCH` for fewer and more events; the relay halts with no record and no progress; `INDEX_MISMATCH`; an unknown producer fills nothing |
| TR-15 | Major | Fixed (test only) | `self-outboxed.test.ts`: `should refuse to construct a self-outboxed runtime when a stream is report-gated` |
| TR-16 | Major | Fixed (test only) | `store-tiers.test.ts`: `should wait for a slow renewal past 400 ms when the store has one tier` |
| TR-17 | Major | Fixed (test only) | `standby-property.test.ts`: 400 seeds × 300 steps against an oracle (two lanes, Ambiguous batches, push loss and reorder, tail reads). It fails at once when the model's holder always sends `advances = true` (shown once) |
| TR-18 | Minor | Fixed | Refusal codes: `SelfOutboxedError` (`EMIT_MISMATCH`, `NO_OUTBOX`, `INDEX_MISMATCH`, `INVALID_DECLARATION` with `details`), `SlotGroupError` (`GROUP_PARTNER`, `GROUP_SLOT_COUNT`, `GROUP_MEMBER_FLAG`, `GROUP_START_ORDER`), `CheckpointError` `NO_CHECKPOINT_STORE`; tests assert `code` |
| TR-19 | Minor | Fixed (test only) | `timing.test.ts`: `deltaXMs` 300.5, `tauMs` NaN, `deltaXMs` −1 refused; ε = 0 accepted |
| TR-20 | Minor | Fixed (test only) | `standby.test.ts`: 10,000 pushes buffered, the 10,001st drops 1 |
| TR-21 | Minor | Fixed in the I2 test files | `Closers` in `afterEach` (`test/support.ts`): runtimes, relays, consumers, emitters, servers; gates are opened before the runtimes stop; runtime tests have a timeout |
| TR-22 | Minor | Fixed | `fault-proxy.test.ts` (loopback echo server); `FaultProxy.droppedBytes` counts the bytes of a cut link |
| TR-23 | Minor | Fixed | Exact values: the checkpoint reference, `tailRows` 1, the slot-group epoch (1 + rounds) |

## Review 72 (fix verification of S-PLAT-I2)

Review 72 (`docs/reviews/72-fix-verification-platform-S-PLAT-I2.md`) verified the Review 68 fixes and found 3 new gaps
in the fix code. Each is closed with tests only (no change in `src/`). Each mutant was made by hand and killed.

| ID | Severity | State | Tests, change | Mutant killed |
|---|---|---|---|---|
| N-1 | Major | Fixed (test only) | `standby.test.ts`: `should push with advances false while an Ambiguous batch of the slot is not resolved` now appends one more batch after the resolution and asserts `advances` true | `runtime.ts` drop `lane.unresolved -= 1` |
| N-2 | Major | Fixed (test only) | `standby.test.ts`: `should take no free slot that nobody has held when the standby starts before its holder (RFC-006 §4.7 rule 1)`: 3 acquisition ticks, no slot held, no `acquireFree` call, each row still free at epoch 0 | `runtime.ts` `if (this.standbyTail && r.epoch === 0n) continue` → `if (false) continue` |
| N-3 | Major | Fixed (test only) | `store-tiers.test.ts` (scripted client, now with parameters): `PgStore.releaseGroup` frees each member in one transaction with the WHERE `kind = $1 AND slot = $2 AND session_id = $3 AND epoch = $4` and the member's parameters; revokes the session in the same transaction when `keepSession` is false; rolls back when the second member UPDATE fails | `pg.ts` `releaseGroup` WHERE without `session_id = $3`; without `epoch = $4`; without both |
| M2, M10 | — | Fail fast | `second-lane.test.ts`: the two tests use `commitBackstopMs: 1_000`, so a failed assertion ends in about 1.3 s, not at the 15 s commit backstop when the runtime stops | M2, M10 fail in about 1.25 s |

## Design issues found (for C01 v1.1 errata and RFC-006)

1. **Byte-identical copies of derived events** (C01 §3.5 D3 vs RFC-006 §3.5). A self-outboxed kind has no outbox row, so
   the relay, the gap fill and the holder's direct publish each seal the event. With fresh nonces the copies differ and
   every relay copy is a FEED_CONTENT_CONFLICT. Here: `Sealer.sealDerived`, a deterministic (synthetic-IV) seal of
   derived events. Proposal: C13 (RFC-005) offers a deterministic seal for derived events, or D3 compares opened
   plaintext for self-outboxed streams.
2. **Gap fill of a self-outboxed producer needs the log key** (C01 §2.3 gap-fill role "through the stream index", §2.5
   says only the relay holds the log key). Proposal: RFC-005's key-release policy names the gap-fill reader too, or the
   relay serves gap fill.
3. **Emit functions are not in the declaration** (C01 §2.2 has `emitFn: { version }` only). Here a runtime option
   `emitFns: { stream: { version: fn } }`; the holder refuses an entry whose declared events differ from what the emit
   function derives. A self-outboxed kind also cannot send notifications or report markers (no outbox). Proposal:
   state both in C01 §2.2.
4. **No standby interface in C01 §2.4.** RFC-006 §4.4 says the standby applies rows "to its memory exactly as the holder
   did", but `OwnerHooks` has no hook for it. Here an optional runtime option `standby: { apply(rows) }`. A push carries
   `prevTs` and `advances` (false while the other lane has a batch in flight) so the standby knows which rows are
   complete. Proposal: C01 v1.1 adds the hook and the push fields.
5. **Handoff needs a named successor** (RFC-006 §4.2, §6.2 level A). Nothing tells an owner host its successor. Here level
   A frees the slots at their own epoch (no revocation; a slot group in one transaction) and other processes take them
   as free slots; a hot standby takes a free slot that was held before (epoch above 0). The process takes slots again
   after 10 min within bound (RFC-006 §6.3 states that rule only for database nodes).
6. **DT-09's 3 s and §6.2's three samples a second.** The third sample above 50 ms comes up to 3 s after the clock
   changes, so the give-up write lands just after 3 s in the worst case. Proposal: DT-09 counts from the first sample
   above 50 ms, or §6.2 samples every 900 ms.
7. **When does an open breaker close?** RFC-006 §4.7 does not say. Here half-open after 10 s (est.), and one timeout
   opens it again. A statement that timed out on one tier may still have committed (an acquisition): the runtime adopts
   slots that already name its session. With one tier only (no `tiers` option) the 400 ms limit is not used, because
   there is no next tier and it would only drop slow but good renewals (the dev cell has round trips above 400 ms
   under load); the statement timeout applies.
8. **A-T3 values.** RFC-006 §6.4 gives δ_x_cfg ≈ 235 ms and τ ≈ 335 ms after the deadline lane is on, as estimates. The
   controller only turns the lane on and keeps δ_x_cfg and τ. **A-T4** "any request pending at D" needs an input from the
   account owner (RFC-002). Cleared alerts and the subject of a cell-wide alarm are not defined (C01 §2.10). The
   episode seq is a counter until placement has a log. `TIMING.ackBudgetMs` is 200 (POL-04).
9. **Checkpoint details** (RFC-006 §12.11): no reference format (here `ckpt:<region>:<kind>:<hex>:<seq>`), the seal
   epoch (0), who calls `prune` ("the history service"), and `getCheckpoint(reference)` cannot check the digest that
   the owner recorded in its entry.
10. **Second-lane enablement is read per tick.** C01 §8 says owners never cache `platform_timing` across batches; that is
    kept for τ (the batch reads its own shard). The lane choice must be made before a batch starts, so it uses the row
    read at the last renewal tick (at most 500 ms old).
11. **The standby push wire format and the checkpoint region check are not in a contract.** RFC-006 §4.4 says
    "over gRPC" only. Here `share.owner.standby.v1.Standby/Push` (client stream, see `standby/grpc.ts`), the queue limit
    (1,024, est.) and the reconnect backoff (100 ms to 1 s, est.). RFC-006 §12.11 says "its own region only" but does not
    map a platform region to a Ceph zonegroup: here the bucket's location constraint must equal the region name.
    RFC-006 §12.11 also says the runtime compresses checkpoints; `CheckpointStore` does not compress, and a 1 to 2 GB
    checkpoint goes in one PUT (no multipart upload).

## Remaining work

- Exit 3: manual proof owed: needs the Jepsen harness (S-PLAT-I1 item 16); a 24 h run.
- Integration-only parts of exits 1, 2, 4, 5 and 6: written, not run (manual).
- Production wiring: mTLS credentials (RFC-005) for `GrpcStandbyServer` and `GrpcStandbyChannel` (the default is
  insecure, for tests); an AWS SDK v3 `S3` client for the region's Ceph RGW given to `S3ObjectStore.open` (the dev
  cell has no object store; `FileObjectStore` stands in there). The I1b status readers still push in process.
- Timing probes need the account and link owners (`TimingRoundTripPort`); the alert service is I6.
- Two hot standbys per link slot (in-region and cross-region): the cross-region one and `standby_grace` are I4.
- The C08 issues of I1 (row-level security) are unchanged.
- The offset check is opt-in (`offsetCheck`); production wiring must turn it on in every owner, status reader and relay process.
- A person runs the I2 integration tests on the dev cell (`REQUIRE_DEV_CELL=1 npm run test:platform:integration`)
  before the merge; this run did not run them.
