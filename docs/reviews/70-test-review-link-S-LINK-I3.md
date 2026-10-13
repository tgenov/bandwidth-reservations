# 70. Test review: slices/link, S-LINK-I3 (waiting, grants and the waiting port)

Scope: commit `fead7ff` on top of `7b805e4` (`git diff 7b805e4..HEAD`). Package `slices/link` and the I3 part of
`contracts/suites/src/c02.ts`. Authority: S-LINK plan §S-LINK-I3, C02 v1.0.0 ("Link waiting port", "Conformance
tests" provider 1, 4, 13), `docs/process/engineering.md`.

## Verdict

**ADEQUATE WITH CHANGES.** No Blocker. 4 Major, 4 Minor.

The I3 scenarios and the exit criteria have strong tests. The waiting oracle catches most breaks in the scan. But
three manual mutants survive in the owner and in the priority order, and the Stryker configuration does not
cover the I3 code.

## Tool results

| Check | Result |
|---|---|
| `npm run -s test:link` | 139 tests: 136 pass, 0 fail, 3 skipped (the three measurements, `LINK_MEASURE` not set) |
| `npm run -s test:contracts` | 81 tests: 78 pass, 0 fail, 3 todo (registered PENDING entries) |
| `python3 tools/conformance.py --json` | P1-S07, P1-S11, P1-S34: `met`. No errors |

## Stryker summary

Stryker did not run (the brief does not allow it). `reports/mutation/link.json` does not exist. The adequacy grade
comes from reading and from 6 manual mutants, each checked with `npm run -s test:link` and then restored
(`git diff` shows no source change).

| # | Mutant | Result | Killed by |
|---|---|---|---|
| M1 | `state.ts:460` remove the undo of the `waitOrder` insert | Killed | `T-04 counter-offers equal the per-minute oracle …` (3 variants), `T-04 a replay of the log decides as the live batches …` |
| M2 | `owner.ts:401` remove `notifications = []` from the decide restart | **Survived** | none (TR-1) |
| M3 | `owner.ts:583` remove the notice comparison of the replay | **Survived** | none (TR-2) |
| M4 | `state.ts:242` `isLive(r)` → `r.state === 'HELD'` (waiter record leaves memory at D + grace) | Killed | both `T-07 … waiting oracle …` property tests |
| M5 | `state.ts:516` `> this.cRef` → `>= this.cRef` (waiter NO_FIT on `occ_firm`) | Killed | T-04 property tests and both `T-07 … waiting oracle …` property tests |
| M6 | `state.ts:747` reverse the request-sequence tie of `comparePriority` | **Survived** | none (TR-3) |

Manual kill rate: 3 of 6. The other important breaks, killed by reading:

| Break | Killed by |
|---|---|
| `scan` `steps >= scanSteps` → `>` | `T-07 scan budget: Tick continuations …` (entry kinds and `linkSeq` per grant) |
| `scan` overlap filter removed, or moved after the step count | `T-07 the scan counts only the waiters that overlap the freed range` (no `Tick`) |
| cursor `after: last` → the next waiter | `T-07 scan budget …` (all five grants) |
| `scanCursor` not cleared | every scan test (the owner `Tick` loop does not end; `--test-timeout`) |
| `examine` D_c guard `atOrAfterMs` → after only, or removed | `T-07 a waiter at or after its D_c is skipped …` (ts = D_c exactly) and `T-07 a waiter one millisecond before its D_c is granted` |
| `occAll.peak + rate <= cRef` → `<` | `should complete the scan of a flash crowd …` (exactly 10 grants; the tenth fits exactly) |
| `aheadDeadline === w.aheadDeadline` guard removed | both `T-07 … waiting oracle …` property tests (the oracle sends a notice only on a change) |
| `grant` without `occAll.add` | `P1-S11 …` (`occAll.peak` = 5) and the P1-N1 check of the property run |
| `refuseWaiter` without `finals.push` | `T-07 a waiter is refused NO_FIT …` (`link_request` row at the converting entry, then the recall) |
| convert without its `scan` | `T-07 a waiter is refused NO_FIT … when the request ahead converts` |
| release without its `scan` | `P1-S11 …` |
| release of a waiter without `removeWaiter` | `T-07 a release of a waiter ends it …` (`waitersInOrder()` = `[]`) |
| `convert` of a waiter → `TOMBSTONED` | `T-07 a repeat of a waiting hold … a convert of a waiter gets NO_HOLD` (exact code and alert) |
| recall reads only `payload.record` | `T-07 a waiter is refused NO_FIT …` (`recalledRecords + 1` and the exact refusal) |
| push without `leaseValid` | `should push no notification when the lease is not valid …` |
| `WAITING_NOTICE` C01 subject without the sequence | `T-07 a waiter whose latest blocker changes …` (3 distinct ids) |
| `compareHlc` order reversed; partition tie reversed | `T-07 released capacity goes to the oldest waiter …`; `T-07 waiters with the same request_age …` |

## Checks the orchestrator asked for

(a) **The replaced I1 test.** `port.test.ts:89`, `C02 provider test 1: wait = true where it would wait answers
WAITING(1) and writes one Hold entry (I3 replaces the I1 UNAVAILABLE)`, replaces the I1 `UNAVAILABLE` test. It
asserts the new behaviour: the result `WAITING`, attempt 1, `aheadDeadline` = the blocker D, one more log entry,
and that entry is `Hold`. The old must-not ("records nothing") changes to the new must ("writes one `Hold`"). The
"fits, so `HELD`" line stays. The oracle line `if (b.wait) return UNAVAILABLE` (`support.ts`) is replaced by the
POL-05 waiting model, not removed. The PENDING entry in `contracts/suites/ISSUES.md` moves to "Known double gaps".
No assertion is lost.

(b) **Changes to earlier tests.** No assertion became weaker.
- `property.ts`: every earlier check stays (each decision equals the oracle; log sequences and outcomes; P1-N1 after
  each entry from the log rows; one `Hold` and one `Convert` entry per request). `Tick` entries are excluded only
  from the command-entry list. New checks: the logged notices equal the oracle's in order (exact hex compare), and
  each notice names a request that waits. `waitShare` defaults to 0, so `property.test.ts` (I1) runs as before.
- `support.ts`: `latestBlocker` is a refactor with the same arithmetic. The oracle adds waiters, `scan` and
  `NO_HOLD`. `harness` adds `pushed`.
- `port.test.ts`: see (a). `contract.c02.test.ts`: adds `notifications` and `i3: true`. `measure.test.ts`: adds a
  measurement only (`Date.UTC` with arguments, `process.hrtime` for the figure only: not a wall-clock finding).

## Findings

| ID | Severity | Location | Finding | Failing-mutant example | Proposed test |
|---|---|---|---|---|---|
| TR-1 | Major | `slices/link/src/owner.ts:401`; no test | No test has a decide restart (`scriptRestarts`) in a batch that grants, refuses or notifies a waiter, or writes `Tick` entries. The reset of the notification list, the rollback of `waiters`, `waitOrder` and `scanCursor` on a restart, and the `Tick` sequence numbers after a restart have no owner-level test. A restart that keeps the notices of the first run sends a `GRANTED` that the committed run did not make. | `owner.ts:401` remove `notifications = [];` (M2): 136 pass | `should send each notice once when decide restarts in a batch that grants waiters and writes Tick entries`: `scanSteps: 1`, two waiters, `h.rt.scriptRestarts(2)`, release the blocker. `assert.deepEqual(relayed(h).map(notice), [ {…GRANTED w0, linkSeq: s}, {…GRANTED w1, linkSeq: s + 1n} ])`; `assert.equal(h.pushed.length, 2)`; `assert.deepEqual(kinds(h).slice(before), [ENTRY.Release, ENTRY.Tick])`; `assert.equal(stateOf().scanPending, false)` |
| TR-2 | Major | `slices/link/src/owner.ts:581-583` | The replay compares the logged notices (RFC-001 §7.4), but no test shows that a changed notice stops the link. `should replay waiters, grants and Tick continuations …` checks only a clean replay (`alerts` = `[]`). | `owner.ts:583` `hex(encodeJson(d.notices ?? [])) !== hex(encodeJson(notices))` → `false` (M3): 136 pass | `should stop the link (OUTCOME_MISMATCH_ON_REPLAY) when a recorded notice changed on rebuild`: grant a waiter, then in the release entry set `payload.notices[0].kind = 'WAITING_NOTICE'` (outcome unchanged), take over with a new owner. `assert.ok(owner2.alerts.some((x) => x.kind === 'OUTCOME_MISMATCH_ON_REPLAY'))`; the next hold answers `STOPPED` |
| TR-3 | Major | `slices/link/src/state.ts:747`; `test/waiting.test.ts:126` | The last tie of the priority order (same `request_age`, same account partition, by request sequence) has no test. The unit test covers only the partition tie. The property run never makes two equal ages (`holdCmd` uses `rt.now()`), so the oracle's sequence tie is never used. The grant goes to the wrong waiter. | `state.ts:747` reverse the sequence comparison (M6): 136 pass | `T-07 waiters with the same request_age and the same account are granted in the order of their request sequence`: two waiters of account `a`, both `aged(…, t0)`, sent with the higher seq first, capacity for one. `assert.deepEqual(relayed(h).filter(GRANTED).map(key), [requestKey(lowSeq.request)])`; `assert.equal((await query(h, highSeq.request))['state'], 'WAITING')` |
| TR-4 | Major | `tools/mutation/link.stryker.json:5,13-18` | The Stryker configuration is the I2 one. The `mutate` line ranges of `state.ts` and `owner.ts` now point at other code (`state.ts` grew by about 200 lines; `514-518` is now the middle of `examine`), and most of the I3 code (`scan`, `grant`, `refuseWaiter`, `tick`, `comparePriority`, `push`, `notification`, the `Tick` loop) is not in `mutate`. The command does not run `waiting.test.ts` or `property.waiting.test.ts`. A Stryker run cannot grade I3, and its score would not be valid. | any I3 mutant, for example `state.ts:537` remove `this.removeWaiter(key)` in `grant`, is not generated | Update `mutate` to the I3 ranges of `state.ts` (waiters, scan, `comparePriority`) and `owner.ts` (`effects`, `Tick` loop, `push`, `notification`, recall, replay compare). Add `slices/link/test/waiting.test.ts` and `slices/link/test/property.waiting.test.ts` to the command. Report killed-only, as review 67 asked |
| TR-5 | Minor | `contracts/suites/src/c02.ts` test `13`; `test/waiting.test.ts:396` | C02 provider test 13, item 1 ("a `GRANTED` lost on the push and relayed late still gets applied") is not in the shared suite. Only the slice test `T-08b a GRANTED lost on the push …` proves it, and its name has no C02 test ID. The suite test `13` covers item 2 only. | — | In the suite: `C02 13 notifications: a GRANTED lost on the push is relayed after a newer notice of another request`, with a consumer inbox by the C02 rules: `assert.deepEqual(inbox.of(w), ['GRANTED'])` after delivery of the newer notice, then the late relay. Or name the slice test `C02 provider test 13 / T-08b …` |
| TR-6 | Minor | `slices/link/src/state.ts:643` | `liveRecord` keeps a `WAITING` record live after `expiresAt` (D + 24 h). No test sends a repeat of a waiting hold after D + 24 h. A break makes the repeat a new hold and inserts the waiter key again in `waitOrder`. Reach is small in I3 (expiry is I8). | `state.ts:643` `!isLive(rec)` → `rec.state !== 'HELD'` | `should answer a repeat of a waiting hold with the recorded WAITING after D + 24 h`: `h.rt.advance(D + 86_400_000 - now)`; `assert.deepEqual([body(again), seqOf(again)], [body(first), seqOf(first)])`; `assert.equal(stateOf().waitersInOrder().length, 1)` |
| TR-7 | Minor | `test/waiting.test.ts:419`, `test/port.test.ts:89` and suite tests `1`, `4`, `13` | The same checks run at two levels: C02 provider test 1 `WAITING` and test 13 identity (push = relay) are in the shared suite and again in the slice tests. Same pattern as review 67 TR-12 (open). | — | Keep one copy at the contract level, or keep the slice copies only for the parts that the suite does not check (the fence and the `to` partition) |
| TR-8 | Minor | `slices/link/src/state.ts:527`; `test/waiting.test.ts:298` | The must-not "no new `WAITING_NOTICE` when the latest blocker does not change" has no explicit unit assertion. Only the property oracle checks it (it kills the break). | `state.ts:527` remove `if (aheadDeadline === w.aheadDeadline) return;` (killed by the property run only) | `T-07 a waiter whose latest blocker does not change gets no new WAITING_NOTICE`: blockers b1 (D 10 s) and b2 (D 40 s); release b1 (b2 is still the latest). `assert.deepEqual(h.rt.notificationsSent, [])`; `assert.deepEqual(h.pushed, [])` |

## Equivalent mutants dropped

- `state.ts` `Math.max(latestBlockerDeadline(…), 0)` in check (8) and in `examine` → no `Math.max`: equivalent. Both
  places run only when `occ_firm` fits and `occ_all` does not, so a hold overlaps a conflict range and the value is ≥ 0.
- `state.ts` `latestBlockerDeadline` `h.deadline <= latest` → `<`: equivalent; it only skips a hold that cannot raise the maximum.
- `state.ts` `examine` refuse check before the grant check (order swapped): equivalent; no fit on `occ_firm` implies no fit on `occ_all`.
- `state.ts` `tick` with no cursor (`entry: false`): equivalent; the owner calls `tick` only when `scanPending`, and a replay calls it only for a logged `Tick`, which always has a cursor.
- `state.ts` `grant` `attempt: w.attempt` → `attempt: 1`: equivalent in I3; every waiter is at attempt 1 until yields (I5).
- `owner.ts` `notification` subject with the sequence for `GRANTED` and `WAITER_REFUSED` too: equivalent in I3; each is sent once per attempt, so the outbox identity does not collide.
- `owner.ts` `push` guard `notifications.length === 0`: equivalent; the loop does nothing on an empty list.

## Notes (not findings)

- Exit criterion 5 (wall clock) and the dev-cell and Kafka parts of criteria 1 and 2 are "written, not run (manual
  proof owed)", as the orchestrator decided. The stand-in tests (flash crowd step count, the T-08b consumer stub, the
  in-memory C01 core property run) are graded above.
- The random tests are seeded (seeds 41 … 46, 51 … 53, 61), and each failure message prints the seed.
- `link-i3-crdb.test.ts` has a timeout (180 s), its own database (`createTestDatabase`, dropped in `finally`), and
  closes both runtimes in `finally`, also on a failed start. Its `waitFor` poll has a time limit (accepted in review 67 TR-15).
- No wall clock and no sleep in the unit tests: they use `h.rt.advance` and `rt.now()`.
