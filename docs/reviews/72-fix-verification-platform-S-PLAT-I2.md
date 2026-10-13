# 72. Fix verification: `platform` (`platform/runtime`), increment S-PLAT-I2

Scope: the fix commit `f536ea0` ("S-PLAT I2: fix review 68 findings") against review 68
(`docs/reviews/68-test-review-platform-S-PLAT-I2.md`, INADEQUATE: TR-1 … TR-3 Blocker, TR-4 … TR-17 Major,
TR-18 … TR-23 Minor) and the "Review 68" table in `platform/STATUS-I2.md`. This is a focused verification, not a full
review.

Authority: `docs/process/engineering.md` §4, §5; `docs/04-delivery/plan/S-PLAT.md` §S-PLAT-I2;
`docs/03-rfcs/RFC-006-availability-and-operations.md` §4.2, §4.4, §4.7, §6.2, §6.3, §7.1; C01 §3.1, §3.2.

## Verdict

**FIXES VERIFIED.** All 23 findings of review 68 are CLOSED. All 10 surviving mutants of review 68 (M1 … M10) are now
killed. The other "no test fails" changes of review 68 are killed. Each of the 4 code changes in `f536ea0` has a test
that fails without it. No test was deleted and no assertion was weakened.

The fix code adds 3 new gaps (N-1 … N-3, Major). They are not regressions of review 68. Close them before the
increment is marked done.

## Gates

| Gate | Result |
|---|---|
| `npm run -s test:platform` | 296 tests, 296 pass, 0 fail (17 s). Was 269 at review 68. |
| `npm run -s test:contracts` | 78 tests: 75 pass, 0 fail, 3 todo (other slices' `PENDING real provider`). |
| Stryker | Not run (the brief forbids it; no `tools/mutation/*.stryker.json` covers `platform/`). |
| Manual mutants | 35 made by hand, one at a time; each file restored after its run. `git status` shows only this file. |

## Mutants re-applied

| ID | Mutant (current line) | Result | Killed by |
|---|---|---|---|
| M1 | `runtime.ts:584` advances arg → `true` | Killed (3 fail) | `standby.test.ts` "…advances false when the other lane has a batch in flight, also after takeover", "…Ambiguous batch resolved as committed…", "…while an Ambiguous batch of the slot is not resolved" |
| M2 | `runtime.ts:509` drop `!special &&` | Killed | `second-lane.test.ts` "should never start an exclusive or firstStatement call on the second lane…" (the assertion at line 141 fails; the test then ends at its 15 s timeout) |
| M3 | `batch/attempt.ts:219` `< 0` → `<= 0` | Killed | `timing-runtime.test.ts` "DT-10 should refuse a confirm whose ts equals D − τ…" |
| M4 | `placement/timing.ts:70` `<` → `<=` | Killed (2 fail) | `timing.test.ts` "should accept a timing version when tau equals the ack budget" |
| M5 | `batch/execute.ts:74` `if (false && e instanceof TierTimeout)` | Killed (2 fail) | `batch-tiers.test.ts` (one timeout ⇒ commit; two ⇒ `retry`) |
| M6 | `offset.ts:70` `>` → `>=` | Killed | `offset-tiers.test.ts` "should stay normal at a bound of exactly 40 ms…" |
| M7 | `offset.ts:65` `>` → `>=` | Killed | same test |
| M8 | `selfout/derive.ts:171` count-mismatch `throw` → `if (false) throw` | Killed (2 fail) | `self-outboxed.test.ts` "EMIT_MISMATCH … fewer or more events", relay halt test |
| M8b | `selfout/derive.ts:164` fewer-events `throw` → `if (false) throw` | Killed | `self-outboxed.test.ts` "EMIT_MISMATCH … fewer or more events" |
| M9 | `selfout/derive.ts:57` `if (s.reportGated)` → `if (false)` | Killed | `self-outboxed.test.ts` "…when a stream is report-gated" |
| M10 | `runtime.ts:510` `skip.add(k)` → `if (skip.has(k)) skip.add(k)` | Killed | `second-lane.test.ts` "should keep queue order of one partition…" (assertion at line 156) |
| TR-8a | `store/pg.ts:632` member `throw new GroupNotTaken()` → `if (false)` | Killed | `store-tiers.test.ts` "should roll back the group transaction…second member UPDATE…" |
| TR-8b | `store/pg.ts:622` `revoked.length !== 1` throw → `if (false)` | Killed | `store-tiers.test.ts` "should update no slot row…old session…neither expired nor revoked" |
| TR-11 | `runtime.ts:933` `resumeTakingAt = wallMs()` (no 10 min) | Killed | `offset-tiers.test.ts` "should take no slot for 10 min…" |
| TR-12 | `runtime.ts:842` adopt branch → `else if (false)` | Killed | `offset-tiers.test.ts` "should serve a slot whose acquisition committed but whose answer was lost…" |
| TR-14a | `consumer/gapfill.ts:109` `INDEX_MISMATCH` throw → `if (false)` | Killed | `self-outboxed.test.ts` "…INDEX_MISMATCH…unknown producer" |
| TR-14b | `consumer/gapfill.ts:105` unknown producer `return []` → `throw` | Killed | same test |
| TR-15 | `runtime.ts` `INVALID_DECLARATION` → `EMIT_MISMATCH` | Killed (2 fail) | `self-outboxed.test.ts` constructor refusals assert `code` |
| TR-16 | `store/pg.ts:426` `pools.length > 1` → `>= 1` | Killed | `store-tiers.test.ts` "should wait for a slow renewal past 400 ms when the store has one tier" |
| TR-19 | `placement/timing.ts:63` drop `deltaXMs` from the checked list | Killed | `timing.test.ts` "…delta x or tau is not a whole number of ms…" |
| TR-20 | `standby/tail.ts:81` `>` → `>=` | Killed | `standby.test.ts` "should buffer at most STANDBY_BUFFER_MAX pushes…" |
| TR-22 | `testing/fault-proxy.ts:45` `cut()` also destroys the sockets | Killed | `fault-proxy.test.ts` "should drop the bytes of a cut link and keep its sockets open…" |

## Code changes in `f536ea0` (check 2)

| Change | Conformance | Mutant | Result |
|---|---|---|---|
| 1. `Lane.unresolved`: a push advances only when no other-lane batch is in flight and no Ambiguous batch of the slot is unresolved (`runtime.ts:584`); the resolution pushes with `lane.running \|\| lane.secondRunning` (`runtime.ts:628`) | Conforms to RFC-006 §4.4 (a standby applies a push only if its seq continues; `complete` must not pass an unpushed committed row) and C01 §3.2 M1 (no batch starts until the resolution ends; a batch of the other lane can still be in flight) | drop `&& lane.unresolved === 0` | Killed ("…while an Ambiguous batch of the slot is not resolved") |
| | | resolution arg → `false` | Killed ("…Ambiguous batch resolved as committed with advances false…") |
| | | drop `lane.unresolved -= 1` (`runtime.ts:623`) | **Survived (N-1)** |
| 2. `OwnerStore.releaseGroup`: the level-A hand-off of a group in one transaction (`MemoryStore`, `PgStore`); retry on the next tick while the level stays A (`runtime.ts:827`) | Conforms to RFC-006 §4.2 ("a slot group is always in one transaction"; "slots of one group are handed off together"), §7.1, plan work item 4, and §4.2 crash points (R27-11: a slot still at its own epoch serves again and retries the hand-off). The hand-off frees the slot and names no successor; this is the I2 design that STATUS-I2 records, not a change of `f536ea0` | `MemoryStore.releaseGroup` frees each member in the loop (split) | Killed |
| | | `runtime.ts:954` `group.length > 1` → `false` (per-kind release) | Killed |
| | | drop the retry at `runtime.ts:827` | Killed |
| | | `PgStore.releaseGroup` WHERE without `session_id` and `epoch` | **Survived (N-3)** |
| 3. A hot standby takes a free slot with `epoch > 0` (`runtime.ts:839`) | Conforms to RFC-006 §4.7 rule 1 (a standby takes the slots of the one holder it pairs with) and §6.3 level A (the holder hands its slots off). The comment also says "it never takes a slot nobody has held" | `if (this.standbyTail) continue` (old code) | Killed ("…hot standby take the slots that its holder handed off…") |
| | | `if (false) continue` (standby takes an epoch-0 slot) | **Survived (N-2)** |
| 4. The relay halts on a row whose events cannot be derived (`relay.ts:150-157`) | Conforms to RFC-006 §3.5 and §5.3: no publish, no progress, no offset commit (the relay commits only on a `resolved` message, `relay.ts:180`, which a halted relay never reaches), so no closure passes the row | drop the `try`/`catch` | Killed (relay halt test) |
| | | drop `if (this.halted) … return` | Killed (relay halt test) |

## Findings of review 68

| ID | Severity | State | Reason |
|---|---|---|---|
| TR-1 | Blocker | CLOSED | M1 killed by 3 tests; the takeover test asserts both partitions in the standby memory. Code defect 1 fixed. |
| TR-2 | Blocker | CLOSED | M3 killed; the DT-10 test has `ts == D − τ` refused and `D − τ − 1 ns` committed. |
| TR-3 | Blocker | CLOSED | No `Date.now`, `performance.now`, `new Date()` or `sleep` in the I2 unit test files. `setTimeout` is only under `mock.timers` or in `support.ts` `until` (a condition wait with a timeout, §5). The I1 file `additions.test.ts` still has a `sleep(10)` poll loop; STATUS-I2 puts the I1 files out of scope. |
| TR-4 | Major | CLOSED | M2 killed. |
| TR-5 | Major | CLOSED | M10 killed. |
| TR-6 | Major | CLOSED | The CP-1 loop injects both lost-COMMIT outcomes and a revocation; `checkLog` asserts `compareHlc(prev, c.ts) < 0` per partition from batch to batch. |
| TR-7 | Major | CLOSED | Group hand-off in one transaction (code defect 2) and the standby takes handed-off slots (code defect 3); both killed by mutants. See N-2, N-3. |
| TR-8 | Major | CLOSED | 4 scripted-client tests of `PgStore.acquireGroup` and `rehomeGroup`; both review mutants killed. See N-3 for the new `releaseGroup`. |
| TR-9 | Major | CLOSED | M5 killed by 2 tests in `batch-tiers.test.ts`. |
| TR-10 | Major | CLOSED | M6 and M7 killed. |
| TR-11 | Major | CLOSED | Mutant killed; the test checks +599,999 ms and +600,000 ms on a stepped clock. |
| TR-12 | Major | CLOSED | Mutant killed. |
| TR-13 | Major | CLOSED | M4 killed. |
| TR-14 | Major | CLOSED | M8, M8b, both gap-fill mutants and both relay mutants killed; codes asserted by `code`. |
| TR-15 | Major | CLOSED | M9 killed. |
| TR-16 | Major | CLOSED | Mutant killed (mock timers). |
| TR-17 | Major | CLOSED | `standby-property.test.ts`: 400 seeds × 300 steps against an oracle of committed rows; each violation message starts with `seed N`. |
| TR-18 | Minor | CLOSED | `SelfOutboxedError`, `SlotGroupError`, `CheckpointError NO_CHECKPOINT_STORE`; tests assert `code` (for example `groupCode` in `slot-group.test.ts:28`). |
| TR-19 | Minor | CLOSED | Mutant killed. |
| TR-20 | Minor | CLOSED | Mutant killed. |
| TR-21 | Minor | CLOSED | `Closers` in `afterEach` in each I2 runtime test file; gates open before runtimes stop. |
| TR-22 | Minor | CLOSED | Mutant killed. |
| TR-23 | Minor | CLOSED | Exact values: `ckpt:r1:acct:${hex(utf8('L1'))}:40`, `tailRows` 1 and 0, slot-group epoch. |

## Check 4: no weakened assertion, no deleted test

- Test names before and after `f536ea0` (unit tests): 173 → 200. 2 names removed, both renamed and extended: the CP-1
  second-lane test (now with lost COMMIT answers and a revocation; "ts never back" became "ts strictly increasing") and
  the DT-28 unit test ("at the expiry").
- Each removed `assert` line has a replacement of the same or a stronger form. The wall-time checks (`took <= 3_000`,
  `onTier0` in 400 … 450 ms, `tookMs < 500`, `performance.now() - t0 < 100`) became sample counts, `connects` counts
  and `stateOf` checks under mock timers. `got.length === 0` after `sleep(20)` became `gotAtFirstRead === 0`. Regex
  assertions became `code` assertions. `>= 1` and `> 20` became exact values.
- One weak line: `offset-tiers.test.ts:166` `assert.ok((3 - 1) * OFFSET.intervalMs <= 3_000)` checks only constants. The
  test also asserts `above50AtD === 3`, which holds the DT-09 timing. Not a finding.

## New findings (in the fix code)

| ID | Severity | Location | Finding | Failing-mutant example | Proposed test |
|---|---|---|---|---|---|
| N-1 | Major | `src/runtime.ts:623` | No test checks that a push advances again after the Ambiguous batch is resolved. Without the decrement, every later push of the slot has `advances = false`; the standby `complete` stops; at takeover the catch-up reads every row since the Ambiguous batch (exit criterion 2: "no reload beyond the last pushed batch"). | `runtime.ts:623` drop `lane.unresolved -= 1`: 296/296 pass. | In `should push with advances false while an Ambiguous batch of the slot is not resolved`, after `recorded.length === 2`: append one more batch on the slot with no other lane in flight; `assert.equal(recorded[2]?.advances, true)`. |
| N-2 | Major | `src/runtime.ts:839` | No test checks that a hot standby does not take a free slot that nobody has held (epoch 0). RFC-006 §4.7 rule 1: a standby holds no slot until it takes over its holder's slots. | `runtime.ts:839` `if (this.standbyTail && r.epoch === 0n) continue` → `if (false) continue`: 296/296 pass. | `should take no free slot that nobody has held when the standby starts before its holder`: seed fresh slots (epoch 0), start the standby only, wrap `store.listSlots` to count calls and wait for 3 calls (`until`); `assert.deepEqual(standby.heldSlots(), [])` and `assert.equal(store.slotRow(kind, 0)?.epoch, 0n)`. |
| N-3 | Major | `src/store/pg.ts:642-651` | `PgStore.releaseGroup` (new in `f536ea0`) has no unit test. The group atomicity test runs on `MemoryStore.releaseGroup` only (the TR-8 pattern again). The `session_id` and `epoch` guards and the one transaction have no test. | `pg.ts:645` WHERE without `AND session_id = $3 AND epoch = $4`: 296/296 pass. A hand-off then frees a slot that another session took. | With the scripted client of `store-tiers.test.ts`: `should free every member in one transaction, guarded by session and epoch`: `assert.deepEqual(verbs(log), ['BEGIN', 'UPDATE', 'UPDATE', 'COMMIT'])` and each UPDATE has params `[kind, slot, 'sess-1', epoch]`; `should roll back and free no member when the second member UPDATE fails`: `['BEGIN', 'UPDATE', 'UPDATE', 'ROLLBACK']` and the call rejects. |

## Equivalent mutants dropped

None in this verification.
