# 76. Test review: `platform` (`platform/runtime`, `platform/migrate`, `contracts/suites` C01), increment S-PLAT-I3

Scope: commits `26008b6` and `f3f6cfb` on top of `main` `91717d0` (`git diff 91717d0..HEAD`). Code:
`platform/runtime/src/{runtime,fencing,hlc,api,index}.ts`, `src/batch/attempt.ts`, `src/placement/{moves,integrity-stop*,pg-integrity-stop,slot-map-service,pg-slot-map-store,probe-set,slot-map}.ts`,
`src/report/report.ts`, `src/status/reader.ts`, `src/store/{memory,pg,types}.ts`, `testing/index.ts`, `platform/migrate/src/{grants,generate}.ts`,
`contracts/suites/src/c01.ts`. Tests: the 14 new or changed unit and contract files. I read the four integration files for hygiene only.

Authority: `docs/process/engineering.md`, `docs/04-delivery/plan/S-PLAT.md` §S-PLAT-I3, `docs/04-delivery/contracts/C01-platform.md`
§3.3, §3.7, §10.1, `docs/04-delivery/contracts/C08-identity-and-access.md` §K, `platform/STATUS-I3.md`.

Orchestrator decisions in force (not findings): DT-42, TLA+, Jepsen, DT-41 on the dev cell, every cell part and the 1.0.0 release are
"manual proof owed / deferred".

## Verdict

**INADEQUATE.** 3 Blocker, 7 Major, 6 Minor.

The integrity stop service, the gRPC codec, the restore-role grants and policies, the slot map service and its seeded property test are
strong: exact refusal codes, must-not checks ("nothing is written"), and exact values. The I2 CP-1 flake fix has a test that fails
without the fix (mutant M1 killed). The weak parts are in the runtime side of the move protocol: two contract clauses have no test
(CP-13 "old rows open in B", CP-5 "a displacement marker written before the move is found"), one CP-5 test uses the wall clock, and
two stop-related guards survive a mutant.

## Gates

| Gate | Result |
|---|---|
| `npm run -s test:platform` | 439 tests, 439 pass, 0 fail (43 s). |
| `npm run -s test:contracts` | 96 tests: 93 pass, 0 fail, 3 todo (other slices' `PENDING real provider`). |
| `python3 tools/conformance.py` | No row for this increment. S-PLAT-I3 delivers no scenario (it contributes P2-S10, P2-S108, X1-S15). |
| Stryker | Not run. No `tools/mutation/*.stryker.json` covers `platform/`, `reports/mutation/` has no platform report, and the brief forbids it. |

## Mutation testing (manual)

I made 8 manual mutants. For each one I changed one line, ran `npm run -s test:platform`, and restored the file. At the end
`git status` shows only this review file.

| ID | Mutant | Result |
|---|---|---|
| M1 | `runtime.ts:997` remove `if (revoked !== undefined && revoked !== this.session.sessionId) return;` (the I2 CP-1 flake fix) | Killed: `should re-home each slot once when the renewal and an Ambiguous resolution both see the same revoked session` |
| M2 | `runtime.ts:1362` fence check `compareHlc(t, tsMoved) >= 0` → `> 0` | Killed, only by test timeouts (20 s, 60 s) |
| M3 | `runtime.ts:1396` `compareHlc(f.ts, through) <= 0` → `< 0` | Killed, only by test timeouts |
| M4 | `batch/attempt.ts:160` remove the adopt batch's re-read of the partition's stops | **Survived** (TR-4) |
| M5 | `runtime.ts:748` `this.rehome(sessionId)` → `this.rehome(this.session.sessionId)` | Survived; equivalent (see below) |
| M6 | `runtime.ts:1421` `creationSlot` → always `a.slot` | Killed: both `C01 CP-10` holder tests |
| M7 | `batch/attempt.ts:174` `if (open && bytesEqual(open, hold.detectionRef))` → `if (open)` | **Survived** (TR-5) |
| M8 | `batch/attempt.ts:399` remove `op?.op === 'moved' ||` (no marker due for `moved`) | Killed, only by test timeouts |

Score: 5 killed of 7 non-equivalent mutants (71 %). Three of the five kills are by a test timeout, not by an assertion (TR-14).

## Findings

| ID | Severity | Location | Finding | Failing-mutant example | Proposed test |
|---|---|---|---|---|---|
| TR-1 | Blocker | `test/moves.test.ts:244-254`; no file | Exit 1 asks for CP-13 "all clauses, dev sealer". No test name in the package starts with `C01 CP-13`. STATUS-I3 cites the pre-warm test for "a moved partition's old rows open in B by `key_id`", but that test asserts only the seq numbers (`got` = `['1','2','3']`). It does not assert that B opened the payload or the audit. The other CP-13 clauses (a row copied to another key, seq or epoch fails to open; no clear column outside the declared set) also have no named test. | `runtime.ts:1303` give the pre-warm hook rows with the sealed payload (skip `openLogRow`), or give B a `DevSealer` with another key: the test stays green. | `C01 CP-13 a moved partition's old rows open in B by key_id`: A and B with separate `DevSealer` instances; after `adopt`, `assert.deepEqual(prewarmed.map((r) => r.payload), [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }])` and `assert.deepEqual((await b.readLog(X)).map((r) => r.payload.id), ['a1', 'a2', 'a3', 'b1'])`. Plus `C01 CP-13 a row copied to another key, seq or epoch fails to open`: copy one log row's `payload` to another seq and assert `openLogRow` throws the exact sealer error. |
| TR-2 | Blocker | `test/moves.test.ts:183-196` | Real clock in a unit test (engineering §5): `performance.now()` at lines 188 and 190 and a real 400 ms wait. The assertion `s.at - adoptedAt >= WAIT - 5` can also fail falsely: the hold starts at the adopt commit (`runtime.ts:685`, `process.hrtime`), but `adoptedAt` is read after `adopt` returns (after `rebuildPartitionFences` and `onAdopt`). A slow machine gives a gap above 5 ms. Review 68 TR-3 closed this class of defect for I2; I3 brings it back. | `runtime.ts:685` `waitMs` → `waitMs - 50`: the test still passes on a fast machine. | Inject the monotonic clock of the step-6 hold (`testing.monotonic`), step it in the test: `assert.equal(compareHlc(b.reportPosition(B) ?? ZERO, e.ts), -1)` before the step of `WAIT` ms, and `>= 0` after it. No `performance.now`, no real wait. |
| TR-3 | Blocker | `test/moves.test.ts:198-210`; `contracts/suites/src/c01.ts:244-260` | CP-5 clause "a displacement marker written before the move is found" has no test (only the `rowAbsent` half of the clause is tested). This is the P1-S78 trace of C01 §3.3: a marker that B does not find lets the account owner write E5 for a hold that the link already displaced (capacity). | A store or runtime change that keys the displacement read by the current slot (for example `memory.ts` key `${slot}|${link}|${request}`) is not caught by any I3 test. | `C01 CP-5 a displacement marker written before the move is found after adopt and after a takeover of B`: write the marker in A (`firstStatement`/projection of C02), move X to B, adopt, take over B; `assert.deepEqual(await c.append({ partition: X, conditions: [{ kind: 'displacementRead', link: X, request, attempt: 1, lockTimeoutMs: 10, label: 'd' }], entries: [entry('x')] }), { r: 'ConditionFailed', which: 'd', displacement: { attempt: 1 } })`. Add it to `runC01ProviderSuite` so that the double passes it too. |
| TR-4 | Major | `src/batch/attempt.ts:160`; `test/stops-split.test.ts:79-95` | C01 §3.3 step 5: `adopt` "re-reads X's stops". Mutant M4 survives. The only CP-6 move test stops both slots, so B's `stops_version` changes and B drops its whole stop cache. The explicit re-read is never needed in a test. | M4: remove line 160. | `C01 CP-6 adopt re-reads the stops of X: a stop seen only at A's slot after moved makes adopt answer Stopped`: let B answer one call for X first (`Moving`, so B caches "no stop"), then `store.stopPartition(kind, SA, X, REF)` (A only); `assert.deepEqual(await b.adopt(X), { r: 'Stopped', detectionRef: REF })` and `assert.equal(head.adopted, false)`. |
| TR-5 | Major | `src/batch/attempt.ts:174`; `test/stops-split.test.ts:97-133` | C08 §J: only audit's stop **with the report's detection_ref**, then its resume, lifts a local hold. Mutant M7 survives: a stop of X with another detection_ref, opened and then resumed, also lifts the hold. | M7: `if (open && bytesEqual(open, hold.detectionRef))` → `if (open)`. | `should keep the local hold when another stop of the partition opens and resumes`: after the hold (report answered `REF`), `stopPartition(kind, SX, X, utf8('det-other'))`, append, `resumePartition`, restore the head; `assert.deepEqual(await rt.append(...), { r: 'Stopped', detectionRef: REF })` and the log stays `['a1']`. |
| TR-6 | Major | `src/batch/attempt.ts:243`; `src/runtime.ts:1338` | Two `adopt` calls for one partition both pass the runtime pre-check (line 1338 reads the head before either commits). Then only the batch guard at `attempt.ts:243` (`head.adopted`) stops a second `adopt` entry and a second `onAdopt`. No test calls `adopt` concurrently, so the batch guard is not tested (found by reading). | `attempt.ts:243` remove `head.adopted ||`: a second `adopt` entry commits with the same generation and `onAdopt` runs twice; all tests stay green. | `should commit one adopt and refuse the other when adopt is called twice at once`: `const [r1, r2] = await Promise.all([b.adopt(X), b.adopt(X)])`; `assert.deepEqual([r1.r, r2.r].sort(), ['Committed', 'ConditionFailed'])`, the `ConditionFailed` has `which: 'adopt'`, the log has exactly one `PLATFORM_ENTRY.adopt` row, and `evB.list` has one `adopt:` event. |
| TR-7 | Major | `contracts/suites/src/c01.ts:244-260` | The provider suite CP-5 (the test the double must also pass) checks "no entry of X commits in B before adopt" only by the return value `Moving`. It never reads the log, so a subject that answers `Moving` but records the entry passes. The seq check is `r.seqFrom > 2n`, not an exact value. | `testing/index.ts` `commitDefault`: record the entry in the log before it returns `Moving`: the suite stays green for the double. A seq that skips (`seqFrom` 10) also passes. | In the suite after the adopt and `b1`: `assert.deepEqual(identities(await s.readLog(P)), ['a1', 'a2', 'b1'])` (no `a3`, no `b0`), and `assert.equal(r.seqFrom, lastSeqBeforeMove + 1n + s.moves.platformEntries)` with `platformEntries` 2 for the real runtime (`moved`, `adopt`) and 0 for the double. |
| TR-8 | Major | `src/placement/moves.ts:141`; `test/placement-moves.test.ts:33-39, 119-142` | `MOVE_CUTOVER` after `move_cutover_max` (1 s): the manual scheduler ignores its `ms` argument, so the 1 s boundary is not asserted. Only `detail.maxMs` is checked, and that is the constant, not the delay that was scheduled. | `moves.ts:141` `schedule(maxMs, …)` → `schedule(0, …)` or `schedule(maxMs * 10, …)`: the test stays green. | Record `ms` in `manualScheduler` and `assert.deepEqual(sched.delays(), [1_000])` after `coord.move(...)` starts. |
| TR-9 | Major | `src/status/reader.ts:132`; `test/status-moves.test.ts:42-51` | R47-17 reads an adopted partition at `max(P_grant, adoptTs)`. The test has only `adoptTs > P_grant`. The other side of the max is not tested. | `reader.ts:132` `adopt !== undefined && compareHlc(adopt, l.pGrant) > 0 ? adopt : l.pGrant` → `adopt ?? l.pGrant`: the test stays green, and a reader then reads below `P_grant`. | `should read an adopted partition at P_grant when adoptTs is below P_grant`: `adopted(3, X, hlc('1799999999000000000.0000000000'))`; `assert.ok(sql[0]?.includes(\`with_min_timestamp('${ceilMicrosLiteral(P_GRANT)}'\`))`. |
| TR-10 | Major | `src/store/pg.ts:752-769`; `src/placement/pg-slot-map-store.ts` | The new `PgStore.pendingMovesFrom` (V59-7) and `PgStore.readReportThrough` (step 5 bounded read), and all of `PgSlotMapStore` (216 lines), have no unit test without a database. Only the integration files test them, and those were not run (manual proof owed). `PgIntegrityStopStore` shows the pattern: its SQL shape, rollback and 40001 retry are tested on a scripted pg double. | `pg.ts` `l.slot = $1` → `l.slot <> $1`, or `NOT h.adopted` → `h.adopted`, or remove `AS OF SYSTEM TIME with_min_timestamp(...)`: no unit test fails. | `should find the unadopted heads whose last row this slot wrote (V59-7) when the pg store is asked for pending moves`: scripted client; `assert.deepEqual(client.sql[0].params, [fromSlot])`, assert the `WHERE NOT h.adopted AND h.slot <> $1 AND l.slot = $1` text, and the decoded `[{ partition, to, ts }]`. The same for `readReportThrough` (`with_min_timestamp('${ceilMicrosLiteral(minTs)}'`, `null` for a NULL column) and for each `PgSlotMapStore` method. |
| TR-11 | Minor | `test/faultmix-moves.test.ts:91-130` | The CP-1 fault mix sends each append only to the holder that `where` names (line 115). It never sends a call to A after `moved`, or to the paused holder of slot 4 after the takeover. So "one writer per generation" is only checked for cooperative callers (`moves.test.ts` covers the A side once, outside the mix). Also the rng draws depend on move outcomes and on real session timers (lines 107-113, 123-129), so a run is not fully determined by the seed. | — | In the mix, with probability 0.1 send the append to a stale holder (the source slot or the paused process); assert the result is in `['Moving', 'Moved', 'StaleEpoch']` and that the identity is not in `store.log`. Draw every random value at the top of each iteration so that the draw sequence does not depend on outcomes. |
| TR-12 | Minor | `test/stops-split.test.ts:129, 132` | Only `.r === 'Stopped'` is asserted; the `detectionRef` of the result is not. | `attempt.ts` `hold.detectionRef ?? new Uint8Array()` → `new Uint8Array()`: these two assertions stay green (line 110 of the other test kills it). | `assert.deepEqual(r, { r: 'Stopped', detectionRef: REF })`. |
| TR-13 | Minor | `testing/index.ts:259`; `test/double-cc.test.ts:199-210` | The double's `moveOut` now cancels the partition's timers itself. The C01 suite has no timer clause, and `CC-2` cannot see the double's line because the owner's `onMovedOut` also cancels. The double API also differs from the runtime (`moveOut(partition, to)` with no generation and no result, `adopt` returns `void` and never refuses), while exit 5 says "the same API". | `testing/index.ts:259` removed: all tests stay green. | Add to `runC01ProviderSuite` CP-5: arm `timer(P, 'k', far)` before `moveOut` and `assert.deepEqual(s.runtime.timerKeys?.(P) ?? [], [])` after it; let both subjects pass it. |
| TR-14 | Minor | `test/moves.test.ts:146-173`; `test/faultmix-moves.test.ts:175-213` | M2, M3 and M8 are killed only by the 20 s and 60 s test timeouts. The failure message names a timeout, not the broken rule. | M2, M3, M8. | In the CP-5 fence tests use `fenceReadAfterMs: 60_000` and race the adopt with a bounded `until(…, 2_000, 'fence pushed')`, then `assert.equal(b.moveStats.fencesPushed, 1)`, so the failure names the missing push. |
| TR-15 | Minor | `test/faultmix-moves.test.ts:229` | `s.p === undefined \|\| compareHlc(s.p, s.ts) < 0`: when the report position is not set, the check passes with no evidence. | — | Make the slot reportable before the move and assert `s.p !== undefined` first. |
| TR-16 | Minor | `test/moves.test.ts:105-129` | "`onMovedOut` after the `moved` commit" is checked only after `moveOut` returns, not at the time of the hook. | `runtime.ts:681` call `onMovedOut` at enqueue time (before the commit): the test stays green. | In the hook, record the head row: `onMovedOut(p) { seen.push(store.heads.get(key)?.slot) }`; `assert.deepEqual(seen, [B])`. |

## Focus items of the brief

- **C01 move, stop and adopt results** (`Moved`, `Moving`, `Stopped`, `onMovedOut`, `onAdopt`): exact results on the real runtime
  (`moves.test.ts`, `stops-split.test.ts`) and in the suite on both subjects. Gaps: TR-3, TR-4, TR-6, TR-7, TR-16.
- **CP-2**: `Moved`, `Moving`, `Stopped` come from the real runtime. **CP-10**: strong (exact refusals, §3.8 order, 300-seed property
  test that prints the seed). **CP-13**: TR-1.
- **Epoch and generation fencing across moves**: `moveOut` generation and `noHead` refusals, `adopt` refusals, DT-12, `admitCommand`
  rebuild on adopt, `staleSenderAction` (all branches exact). Gap: TR-6.
- **Seeded fault mix**: seeded, the seed is in every failure message, no wall clock and no sleep. Gap: TR-11.
- **Double vs runtime on the C01 suite**: both pass the new CP-5 and CP-6. Gaps: TR-7, TR-13.
- **I2 CP-1 flake fix**: `should re-home each slot once …` fails without the fix (M1, epochs 3).
- **PgStore paths without a database**: `PgIntegrityStopStore` yes; `PgStore` move reads and `PgSlotMapStore` no (TR-10).
- **Restore role vs C08 §K**: the predicate, the permissive and restrictive policies, FORCE, no `TO PUBLIC`, no grant on audit's
  table and fail-closed without row-level security are all asserted exactly, and the conformance job has a test for each
  violation. The missing DELETE is a declared design issue (STATUS-I3 issue 10), not a test defect.
- **S-SEC-I2 exports**: `AppendResult` `Moving`/`Stopped`, `OwnerHooks.onMovedOut`/`onAdopt`, `AppendOptions.slot`,
  `RuntimeDouble.moveOut`/`prepareAdopt`/`adopt`/`stop`/`resume`, `DoubleWorld` and `c01MoveEvents` are exported and used by the
  contract suite on both subjects.
- **Integration hygiene** (read only): each file has a per-test timeout, `afterEach` closes runtimes and pools, `after` drops its own
  database (`ii3_`, `iistop_`, `islotmap_`, `irestore_`).

## Equivalent mutants dropped

- M5 (`runtime.ts:748`, session id read after the resolution read): the resolution runs while the lane is `running`, and the
  renewal's `rehome` waits for the lane (`waitIdle`). So the session cannot change between the read and the `rehome` call; both forms
  give the same id.
