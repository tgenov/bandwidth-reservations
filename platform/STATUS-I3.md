# S-PLAT I3 status

Increment: S-PLAT-I3 "Moves, splitting and integrity stops" (`docs/04-delivery/plan/S-PLAT.md` §5). Package version stays
`1.0.0-alpha.1`: the 1.0.0 release waits for the manual proofs below (exit 5). Every addition to the C01 v1 surface is
optional (`AppendOptions.slot`, `ReaderChannel.movedOut`/`adopted`), so C01 v1 consumers do not change.

Checks (this run, 2026-10-13): `npm run -s typecheck` passes (all workspaces); `npm run -s test:platform` 434 pass, 0 fail
(three runs after the last change); `npm run -s test:contracts` 93 pass, 0 fail, 3 todo (`PENDING real provider` entries of
other slices); `npx eslint platform contracts` is clean. `npm run check` and `npm run ci` were not run (engineering.md §2).

Environment: `@grpc/grpc-js` (a dependency since I2) was not in this worktree's `node_modules`, so every platform test
failed at import. The worktree now has the symlink `node_modules/@grpc` → `.claude/worktrees/s-rate-i4/node_modules/@grpc`,
the same link that the other worktrees use. No package or lock file changed; no dependency was added.

Integration tests: **written, not run (manual proof owed)**. A person runs `REQUIRE_DEV_CELL=1 npm run
test:platform:integration` on the dev cell. The I3 files: `platform/runtime/test/integration/i3.test.ts` (database `ii3_…`),
`integrity-stop.test.ts` (`iistop_…`), `slot-map.test.ts` (`islotmap_…`) and `platform/migrate/test/integration/restore-role.test.ts`
(`irestore_…`, skips below CockroachDB 25.2: no row-level security).

## Work items

| # | Work item | Where | Tests |
|---|---|---|---|
| 1 | Move protocol steps 2 to 6 in the runtime: `prepareAdopt` (route the partition to B, pre-warm from its rows by (partition, seq)), `moveOut` (`moved` entry, head `slot = B, generation = g+1, adopted = false`, `onMovedOut`, timers cancelled, readers told), report fence (a marker is due for `moved`; the marker's `report_through` is pushed to B's holder), `adopt` (fence by push or by a bounded read of `owner_slot(kind, A)` after 100 ms; rows above the pre-warm; `adopt` entry conditional on the head; stops re-read; `onAdopt` after the admitCommand marks are rebuilt), step 6 report hold. Placement steps 1 and 7: `MoveCoordinator` (`placement_partition_moves` prewarm → moved → adopted → done, routing published after adopt, `MOVE_CUTOVER` page after 1 s) | `runtime.ts`, `batch/attempt.ts` (`PLATFORM_ENTRY`), `report/report.ts`, `placement/moves.ts`, `store/memory.ts`, `store/pg.ts` (`pendingMovesFrom`, `readReportThrough`) | `moves.test.ts` (15), `placement-moves.test.ts` (5), C01 suite CP-5 (real runtime and double); cell: `i3.test.ts` |
| 2 | V59-7: the successor of A finds unadopted heads whose `moved` row A wrote and pushes its first marker to B | `runtime.ts` (`findPendingMoves`) | `C01 CP-5 A's holder killed after moved …` |
| 3 | Head checks `Moving`, `Moved(slot, generation)`; status readers answer a moved partition by rule 4 (`isMovedOut`) and read an adopted one at max(P_grant, adoptTs) | `batch/attempt.ts`, `status/reader.ts` | `moves.test.ts`, `status-moves.test.ts` (2) |
| 4 | `STALE_SENDER(recorded)` sender rule (D4), `STALE_SENDER_UNMOVED` flag | `fencing.ts` (`staleSenderAction`) | `C01 CC-5 STALE_SENDER (D4) …` |
| 5 | Hot-link trigger: above 200 requests a second over a full 10 min window, once until it cools | `placement/moves.ts` (`HotPartitionDetector`) | 1 test |
| 6 | Slot map service: overrides, `reslot` and its 5 refusals, `doubleSlotCount` in the §3.8 order 1–7, lazy splits 16 at a time, `ackSplitting` (once per (slot, version, epoch), later epoch replaces), `listPartitions` re-ask after a takeover, `slotGroup`. Holder side: creation only in the slot the map gives (V59-2: a splitting upper half in s + n), `ackSplitting` after the batches in flight end, `listPartitionsFor` (NOT_OWNER, NOT_ACKED), `AppendOptions.slot` | `placement/slot-map-service.ts`, `placement/pg-slot-map-store.ts`, `runtime.ts` (`applyMap`, `ackSplit`, `listPartitionsFor`, `creationSlot`), `placement/slot-map.ts` (`onVersion`) | `slot-map-service.test.ts` (28), `slot-map-property.test.ts` (300 seeds), `stops-split.test.ts` (2 CP-10); cell: `slot-map.test.ts` (store only) |
| 7 | Probe-account steps of the doubling against fakes of identity (B4), the account owner (F9, C05) and finance (C07); `probeAccountSet(v)` (also a pending version), `probeSetSummary(v)` signed (dev Ed25519 signer) and `verifyProbeSetSummary` | `placement/slot-map-service.ts`, `placement/probe-set.ts` | CP-10 tests in `slot-map-service.test.ts`, `probe-set.test.ts` (4) |
| 8 | Topic partition growth on doubling: `accountTopicPartitions(2n)` given to `growTopics` after the 2n version (est.; SP2 decides) | `placement/slot-map-service.ts` | 1 test |
| 9 | `Stop`/`Resume`: one transaction (stop row, `stops_version` +1 on every fenced slot: both during a move, s and s + n for `headDecides`), `StopAck` after commit, `enforced_at` = commit ts, idempotent by `detection_ref`, `CONFLICT`, `NOT_STOPPED`, `HEAD_MISMATCH`, `PERMISSION_DENIED`; gRPC `share.placement.v1.IntegrityStop` (hand-coded protobuf); Pg store through `placement_set_stops_version` | `placement/integrity-stop*.ts`, `placement/pg-integrity-stop.ts` | `integrity-stop.test.ts` (34, 16 `C01 CP-6`), `integrity-stop-codec.test.ts` (4), `integrity-stop-grpc.test.ts` (9); cell: `integrity-stop.test.ts` |
| 10 | Runtime: `Stopped` from a changed `stops_version` (a Stop restarts a batch in flight: the memory store now validates `stops_version` like the database's serialisable order), stops read on acquisition, local hold and `integrity_report` on a head-chain mismatch (sent once, retried until accepted; only audit's stop then resume lifts the hold) | `batch/attempt.ts`, `runtime.ts` (`reportIntegrity`), `store/memory.ts` | `stops-split.test.ts` (5 CP-6), C01 suite CP-6 (both subjects); cell: `i3.test.ts` |
| 11 | Restore role: SELECT/INSERT/UPDATE on log and head only with row-level security; FORCE; permissive `restore_only_stopped` and restrictive `restore_confined` on placement's table; permissive policies for every other role; conformance job checks; new nullable columns of `placement_integrity_stops` | `migrate/src/grants.ts`, `migrate/src/generate.ts` | `restore-role.test.ts` (21); cell: `restore-role.test.ts` |
| 12 | TLA+ model and Jepsen harness with moves, fence, splitting and stops | — | **Open** (the I1 model and harness do not exist yet, S-PLAT-I1 items 15, 16) |

Runtime double (`@share/owner-runtime/testing`): `prepareAdopt`, `adopt` that continues the source double's log and seq
in one `DoubleWorld`, `moveOut` cancels the partition's timers, `AppendOptions.slot`. The C01 suite (`runC01ProviderSuite`)
has two new tests, CP-5 and CP-6, and the subject has `events`, `moves` and `stops` drivers; both the real runtime and the
double pass them.

## Exit criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | C01 CP-2 (all results), CP-5, CP-6, CP-9 (all clauses), CP-10, CP-13 (all clauses, dev sealer); CP-1, CP-7, CP-7a, CP-8 again with moves and stops in the fault mix | **Partly met by unit/contract test; cell part written, not run (manual proof owed); part open** | Met (unit/contract): CP-2 `Moved`, `Moving`, `Stopped` from the real runtime; CP-5 (every clause, `moves.test.ts`, suite); CP-6 (runtime and placement clauses; restore-role clause by the migration and its conformance job); CP-10 (placement and holder clauses, property test); CP-13 "a moved partition's old rows open in B by key_id" (B's pre-warm opens A's rows). Cell (written, not run): `i3.test.ts`, `integrity-stop.test.ts`, `restore-role.test.ts`. **Open**: CP-9 "gaps filled within gap_timeout across a move" has no test of its own (gap fill reads by partition since I1); CP-1, CP-7, CP-7a, CP-8 with moves and stops in the fault mix are not re-run |
| 2 | DT-08 (with moves), DT-12, DT-37, DT-41 (64 → 128 on the dev cell under load), DT-45 | **DT-12, DT-37, DT-45 met by unit test; cell part written, not run (manual proof owed); DT-08 with moves and DT-41 open** | DT-12: `DT-12 a receiver …`, CP-5 seq/generation tests. DT-37: CP-5 tests (fence, rule 4, rowAbsent after a takeover, successor push). DT-45: CP-6 tests (runtime, placement, restore role). DT-41: the doubling runs on fakes only; no dev-cell run with account owners exists (needs the account owner, identity provisioning B4, finance) |
| 3 | DT-42 on the dev cell: `Moving` at most 200 ms p99, no cold rebuild | **Written, not run (manual proof owed)** | `DT-42 on the cell …` in `i3.test.ts` (20 moves under load). Unit: pre-warm test (no cold rebuild) |
| 4 | TLC and 24 h of the Jepsen harness find no violation | **Open (manual proof owed)** | No TLA+ model and no Jepsen harness exist (S-PLAT-I1 items 15, 16) |
| 5 | `@share/owner-runtime` 1.0.0 published; the double has the same API | **Open** (the double: met) | The version stays `1.0.0-alpha.1` until exits 1 to 4 have their manual proofs |

## Defect found and fixed in this run

The watched flaky test of STATUS-I2 (`C01 CP-1 with the second lane on …`, seed 11) failed once again: "each slot re-homed
once". Cause: the renewal and the `Ambiguous` resolution read can both see the same revoked session; each queued a re-home,
so the slots were re-homed twice (epoch 3). Test: `should re-home each slot once when the renewal and an Ambiguous resolution
both see the same revoked session` (failed with epochs 3, 3, 3, 3). Fix: a re-home names the session that was seen
revoked and does nothing when the process has a newer session.

## Design issues found (for C01 v1.1 errata and RFC-006)

1. **`moved` and `adopt` entries** (C01 §3.3) have no entry kind. Here the platform kinds −1 and −2, retention `7y`, audit
   by `platform_runtime`. They take a seq, so an owner's replay sees a gap; `readLog` and the standby `apply` leave them out
   (`readLog(…, { platform: true })` keeps them).
2. **`AppendCall` has no slot** (C01 §2.4). In a splitting slot or after a move, one process can hold both slots. Here the
   optional `AppendOptions.slot` (the `routedTo.slot` of the command). Without it the runtime uses its moves, the map and the
   home slot.
3. **The pre-warm has no hook** (C01 §2.4 `OwnerHooks`). Here the runtime option `moves.prewarm(partition, rows)`. A's
   holder does not push X's batches to B before `moved`; B reads the rows above its pre-warm in the adopt step.
4. **No channel for the report fence push** (C01 §3.3 step 4, V59-7). Here `MoveInbox.fence` (in process); a gRPC transport
   is not defined.
5. **`ReaderChannel` has no `moved`/`adopt` push** (C01 §3.3 "readers of A that applied moved"). Here optional `movedOut`
   and `adopted` on the channel.
6. **Placement has no head read** (C01 §2.3, A1), but `HEAD_MISMATCH` compares heads. Here a `HeadInspector` port.
7. **`integrity_report` transport and the end of a local hold** (C08 §J). Here the runtime option `integrityReport`; the
   hold ends when the stop with the report's `detection_ref` was seen open and is then not open.
8. **Slot map details** (C01 §2.3, §2.7, §3.8): the signed bytes of `probeSetSummary` (a domain tag added); no column for the
   ack's upper-half list, no request table, no doubling-progress table, no `previousCount` column (here extra tables of the
   Pg store); no precedence between the reslot refusals; `doubleSlotCount` and `ackSplitting` have no refusal type
   (`SlotMapError`); version 1 of the I1 fixed map has no probe accounts.
9. **Integrity stop details**: a second Stop after Resume answers the first STOPPED ack; a second Resume with other content is
   `CONFLICT`; no index on `detection_ref`; a fenced slot with no `owner_slot` row has no error code; two open stops of one
   partition keep one detection ref in the runtime's map.
10. **Restore role** (C08 §K vs RFC-006 §13.2): C08 gives DELETE, here none; the grant is static, not per break-glass
    session; without row-level security (CockroachDB 24.3, the dev cell) the restore role gets no write grant (fail closed).
11. **`MOVE_CUTOVER` raiser**: placement raises it from its coordinator; the episode needs placement's own log (C01 §2.10).

## Remaining work

- Manual proofs: the integration files above on the dev cell; DT-41 on the dev cell with account owners; TLA+ and Jepsen
  (exit 4); then release 1.0.0 (exit 5).
- CP-1, CP-7, CP-7a, CP-8 with moves and stops in the fault mix; a CP-9 gap-fill test across a move.
- gRPC transports for `HolderPlacementApi`, `PlacementApi`, the move steps and the fence push; mTLS for
  `GrpcIntegrityStopServer`.
- Placement's own kind grants on `placement_integrity_stops` and `placement_partition_moves` (`grantMigration`).
- Topic growth waits for SP2.
