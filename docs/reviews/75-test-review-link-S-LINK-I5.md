# 75. Test review: slices/link, S-LINK-I5 (yields, claims and waiting marks)

Change set: `git diff 91717d0..27b001a` on `build/s-link-i5` (`slices/link`, `contracts/suites/src/c02.ts`).
Authority: `docs/process/engineering.md`; S-LINK plan §6 S-LINK-I5; C02 (`docs/04-delivery/contracts/C02-link-hold.md`);
RFC-001 §4.3.

## Verdict

**INADEQUATE.** 1 Blocker, 4 Major, 8 Minor.

The capacity properties are well protected. No yield can oversell: the only path that adds a pulse after a yield is
the grant check of the scan. The property run checks P1-N1 from the log rows after each entry, and this check does
not use the oracle. Every refusal and stale code of I5 has a test with an exact assertion. The gaps are these:

- The new property run on the C01 runtime core uses the system clock.
- The owner's re-send timer is not tested beyond one re-send, and it is not tested after a failed append.
- No test makes an append fail (or restarts `decide`) on a `mark_waiting` or a yield answer, so the rollback of the
  I5 state is not proven.
- DI-23 (an accepted claim stays live with no open request) has no test.

## Gates

| Gate | Result |
|---|---|
| `npm run -s test:link` | 239 tests, 236 pass, 0 fail, 3 skipped (the measurements) |
| `npm run -s test:contracts` | 97 tests, 94 pass, 0 fail, 3 todo (PENDING entries, one is the account link double's I5 part) |
| `python3 tools/conformance.py` | I5 delivers no P1 scenario (plan §7). No I5 row is missing |

## Stryker summary

Stryker did not run. The brief does not permit it. `reports/mutation/link.json` does not exist. The new ranges in
`tools/mutation/link.stryker.json` include `state.ts:262-932` and `owner.ts:352-385`. They do not include
`owner.ts:523` (`armYieldResend` after a commit) (see TR-13).

Manual mutants. Each was run once with `npm run -s test:link` and then restored:

| # | Mutant | Result |
|---|---|---|
| M1 | `owner.ts:373` remove `this.armYieldResend(mem)` in `onTimer` (the timer is not armed again) | **Survived** (TR-2) |
| M2 | `owner.ts:355` remove `cancelTimer` in `onMovedOut` | **Survived** (near-equivalent, TR-6) |
| M3 | `state.ts:809` remove the conflict-range filter of the candidates | Killed, only by the two property runs (TR-8) |
| M4 | `state.ts:764` remove `a.claim === b.claim` from the recorded-answer lookup | Killed, only by the two property runs (TR-8) |
| M5 | `state.ts:832` remove `h.window.end` from the sufficiency cuts | Killed (property runs and `T-08 a younger waiter outside the claimed ranges …`) |
| M6 | `state.ts:747` remove the "open request from this waiter" skip in `markWaiting` | **Survived** (TR-7) |

Read-only grading of the other important breaks. Each break is followed by the test that kills it:

- `state.ts:740` `<=` → `<`: `should apply mark_waiting only above …` (the same position).
- `state.ts:737/739` alert on a final record: `should answer IGNORED_OLDER … and write nothing` (`alerts.length === 1`).
- `state.ts:768` remove `!y`: `C02 provider test 4 yield_accept replies …` (claim `c + 1`).
- `state.ts:777` remove `rec.mark?.waiting`: `C02 provider test 5 / T-08 refusal, then mark …` (no new claim).
- `state.ts:782` remove `keep`: `T-08 review 17 loop: with yields sufficient …` (Y1 is granted again, so the notices are not `[]`).
- `state.ts:784` `+ 1` → `+ 0`: every accept test (`newWaiterAttempt: 2`).
- `state.ts:805` (DI-26) `atOrAfterMs` boundary: `T-08 commit fence …` and `T-08 a waiter one millisecond before its D_c …`.
- `state.ts:807` `comparePriority(h, b) > 0` → `< 0`: `T-08 a holder that is older than the waiter is never asked …`.
- `state.ts:811` remove `mustInclude`: property runs.
- `state.ts:816` remove `y.claim === this.seq` (DI-21): `P2-S15 link part …`.
- `state.ts:836` `>` → `>=`: `T-08 review 17 loop: with yields sufficient …` (10 − 6 + 6 = 10 = C_ref).
- `state.ts:846` remove the claim check or the range check: the review 17 loop test and `T-08 a younger waiter outside the claimed ranges …`.
- `endClaimsOfWaiter` in `grant` and in `release`: `T-08 a waiter that is granted ends its claim …` and `T-08 the release of a waiter ends its claim …`.
- `endClaimsOnAttempt` in `convert` and in `release`: `C02 provider test 4 the end of a hold attempt (convert|release) …`.
- `owner.ts:609` the `|claim:` subject: every test that reads the claim from the relay (`lastClaim` in the refusal-then-mark traces).
- `owner.ts:640` re-arm in `onAdopt`: `should replay marks … and re-arm the open yield requests`.

## Capacity, oracle and focus points

- **P1-N1 (a yield never oversells).** Adequate. `property.ts` subtracts the pulse of each `ACCEPTED` entry and adds a
  pulse only for `HELD` and `GRANTED`. It asserts `occ_all ≤ C_ref` at each minute after each entry, from the log
  rows alone. The run uses 6 fixed seeds (71 … 76) and a core seed (81). Each failure message prints the seed.
- **Oracle independence.** Partial. `YieldOracle` uses a different representation: cells per minute, conflict
  minutes and sufficiency per minute. The link uses a segment tree, ranges and cut pieces. Thus the oracle checks the
  arithmetic independently (M3, M4 and M5 were killed by it). But the oracle copies the rule choices of the code one
  for one, often in the same statement order: DI-21 (`y.waiter === x.key || y.claim === seq`), DI-22 (IGNORED_OLDER
  for unseen and final), DI-23 (the accepted claim stays), DI-24 (the whole claim ends) and DI-26 (`D_c`). A
  misreading of RFC-001 §4.3 in these rules cannot show as a difference (TR-12).
- **Refusal and stale paths.** All present and exact. `STALE_ATTEMPT`: an unopened claim, a wrong attempt, a waiter,
  an unseen request, a refusal after an accept, after a `convert`, after a `release`, after the release of a waiter,
  and an ended claim. Each test asserts that no entry is written and that occupancy does not change. `IGNORED_OLDER`:
  the same position, an older position, an unseen request (with the alert), a final request, and no entry.
- **Re-sends after a failed append.** Not tested (TR-3, TR-4). This is the same gap that review 74 found in I6. Also,
  by reading, `onTimer` returns at `mem.rebuild !== 'none'` (`owner.ts:366`) and does not arm the timer again. After
  any non-`Committed` result (`Moving`, `Overloaded`, `Stopped`, `StaleEpoch`, `Moved`, retries exhausted),
  `runBatch` sets `rebuild` to `catchUp` or `full`. Thus the re-sends of the open `YIELD_REQUEST`s stop until a later
  command commits. C02 "YIELD_REQUEST" says that the link sends an unanswered request again. On an idle link only the
  5 s `query` reconcile of the account owner covers the gap. A test would show this.

## Design issues DI-21 … DI-27: do the tests hide a conflict with C02 or RFC-001?

| DI | Test that fixes the behaviour | Judgement |
|---|---|---|
| DI-21 | `P2-S15 link part …` asserts one request ("(DI-21)") | Deviates from RFC-001 §4.3 ("raises a new claim **for each one** that has no open claim") and from C02 ("one or more open claims for each holder attempt"). The test states it openly. Liveness only, no capacity effect. Keep it, and change it when C02 resolves CS-11 (TR-11) |
| DI-22 | `should answer IGNORED_OLDER to a mark for a request …` | No conflict. C02 "Idempotency" allows `IGNORED_OLDER or APPLIED`. The account owner sends a mark only where it holds |
| DI-23 | No test | RFC-001 §4.3 says both "an accepted yield … ends every claim on that attempt" and "ends every **other** claim". The code keeps the accepted claim. The review 17 loop test needs this while another request of the claim is open. The case with no open request (the claim blocks younger waiters until its waiter ends) is not tested (TR-5) |
| DI-24 | `C02 provider test 4 the release of one holder ends the whole claim …` | Agrees with RFC-001 §4.3 ("the claim ends when … the holder's attempt ends") |
| DI-25 | `C02 provider test 4 … (convert) … its re-sends stop` (one re-send) | The interval is not in C02. The repeated cadence and the re-send after a failure are not tested (TR-2, TR-3) |
| DI-26 | `T-08 commit fence …` and `T-08 … one millisecond before its D_c …` | An extension of RFC-001 (the scan already skips such a waiter). The boundary is pinned on both sides. No conflict |
| DI-27 | `T-08 review 17 loop …` asserts no notice after the accept | Not a conflict with C02. But the `aheadDeadline` 0 of the yielder in `query` is not asserted, so DI-27 is not visible in a test (TR-10) |

## Findings

| ID | Severity | Location | Finding | Failing-mutant example | Proposed test |
|---|---|---|---|---|---|
| TR-1 | Blocker | `test/property.yields.test.ts:52-56` | The run on the real C01 runtime core builds `CockroachOwnerRuntime` with no `wallMs`, so the runtime uses `systemClock`. The D_c checks (`deadlineInMs` 300 … 30,000, DI-26) then depend on the speed of the machine. The run cannot be reproduced from seed 81 (engineering §5: "Tests use a fixed or a stepped clock"). The same pattern is in `property.test.ts:77` and `property.waiting.test.ts:60` (I1, I4) | Any break in the D_c branch of `requestYields` (`state.ts:805`) is found or not found depending on timing | Pass `wallMs: stepped` (a clock that the run advances) to `CockroachOwnerRuntime`, and compute `base` from it. Keep the name. Assert `res.counts['STALE_ATTEMPT'] > 0` and `res.counts['ACCEPTED'] > 0` with the seed in the message |
| TR-2 | Major | `src/owner.ts:373`; `test/yields.test.ts` `C02 provider test 4 … (convert) …` | Only one re-send is asserted. A link that sends an open request again once and then stops passes every test. C02: "the link sends an unanswered request again with the same claim" | M1: remove `this.armYieldResend(mem)` in `onTimer`. Survived | `should send each open yield request again every yieldResendMs when no entry answers it`: after the claim, `advance(1_000)` three times. Assert that `pushed` gets 3 copies, each `deepEqual` to the first push, and that `rt.timersOf(partition)` is `[{ key: 'yield-resend', atTs: now + 1 s }]` |
| TR-3 | Major | `src/owner.ts:366`, `src/owner.ts:517-566` | No test fires the re-send timer after a failed append. By reading, after any non-`Committed` result `onTimer` returns at `rebuild !== 'none'` and does not arm the timer again, so the re-sends stop on an idle link (see "Focus points"). This is a probable defect | Replace `return` at `owner.ts:366` with "catch up, then send and arm again". No test sees a difference | `should go on sending the open yield requests when an append fails with OVERLOADED`: open claim c; `rt.scriptAppend(RESULTS.Overloaded(50))`; send an unrelated hold (expect `OVERLOADED`); `advance(1_000)` twice. Assert 2 more `YIELD_REQUEST` pushes with `claim === c`. Repeat for `MOVING` and `STOPPED` |
| TR-4 | Major | `src/state.ts:225-236, 857-874`; `test/port.test.ts` CC-1 | No test makes an append fail (or restarts `decide`) on `mark_waiting`, `yield_accept` or `yield_refuse`. CC-1 checks only `occAll` after a failed `hold`. The rollback of `claims`, `yieldReqs`, `mark` and `answers` is not proven. A re-send after `MOVING` must get `ACCEPTED`, not `STALE_ATTEMPT` | `state.ts:860` `this.deleteIn(this.claims, ck)` → `this.claims.delete(ck)` (not journaled): a failed `yield_refuse` leaves the claim ended in memory. No test fails | `should leave the claims, the requests and the mark unchanged when the append of a yield answer fails with MOVING, and accept the re-send`: for each of `yield_accept`, `yield_refuse`, `mark_waiting`, `scriptAppend(RESULTS.Moving())`. Assert the reply `{ code: 'MOVING', retryAfterMs: 100 }`, `openYieldRequests()` and `query(y).openYieldClaims` equal to the values before, `occAll.peak(W) === 8`, then the re-send gives `{ result: 'ACCEPTED', newWaiterAttempt: 2 }`. Also one case with `rt.scriptRestarts(2)` |
| TR-5 | Major | `src/state.ts:782-783` (DI-23) | After `yield_accept`, the accepted claim stays live with no open request. If its waiter still does not fit (a new hold took the free capacity), the claim keeps a younger waiter in its ranges from a grant until the older waiter ends. No test asserts this, and no test asserts the opposite | Add after `state.ts:783`: "end the claim `y` if it has no other open request". All tests pass (the review 17 loop test keeps a second open request) | `T-08 an accepted claim with no open request keeps a younger waiter in its ranges from a grant until its older waiter ends (DI-23)`: Y (younger, marked) holds 8, O waits for 8, claim c; Z holds 2 after c; Y accepts. Assert that O is not granted, a younger waiter V (rate 2, inside the ranges) gets no `GRANTED` after a release that frees 2. Then release O and assert `GRANTED` for V in that entry |
| TR-6 | Minor | `src/owner.ts:355` | The cancel in `onMovedOut` (C02: "`onMovedOut` cancels those timers") is not asserted. It is near-equivalent because `onMovedOut` also sets `rebuild = 'full'`, and `onTimer` then sends nothing | M2. Survived | In the replay test, after `h.rt.release(slot)` / `onMovedOut`, assert `rt.timersOf(utf8(link))` has no `yield-resend` key |
| TR-7 | Minor | `src/state.ts:747` | The skip "this waiter has an open request on this holder attempt" in `markWaiting` is not tested. It changes the result only when another marked holder became a candidate without a request from the waiter (for example by a grant outside the waiter's window) | M6. Survived | `should raise no new claim when a holder sets its mark again and the waiter has an open request on it`: mark positions 1, 2 (false), 3 (true) with claim c1 open. Assert the relayed `YIELD_REQUEST`s stay `[c1]` and `openYieldRequests()` is unchanged |
| TR-8 | Minor | `src/state.ts:764, 809` | Two rules are killed only by the property runs, with no named unit test: (a) a marked younger holder outside the conflict ranges is not asked; (b) a second answer of the same kind with another claim is not the recorded reply | M3, M4 (killed only by the property runs) | (a) `T-08 a marked younger holder outside the conflict ranges is not asked`: assert `yieldRequests(h)` is `[]`. (b) Refuse c1 (mark set, so c2 is raised), then refuse c2. Assert `{ result: 'REFUSED_RECORDED' }` with `linkSeq` greater than that of c1, and a new log entry |
| TR-9 | Minor | `test/yields.test.ts:507, 522, 537`; `test/property.yields.test.ts:52` | Four names start with `should` but have no `when <condition>` (engineering §7) | — | For example, `should answer IGNORED_OLDER and write no entry when a mark names a request that is unseen or final` |
| TR-10 | Minor | `test/yields.test.ts` review 17 loop test (DI-27) | The test asserts that the yielder gets no notice after `ACCEPTED`. It does not assert the yielder's `query` state while it is inside the live claim, so the DI-27 effect (`aheadDeadline` 0) is not visible | — | Add `assert.deepEqual(await query(h.stub, y1.request), { state: 'WAITING', attempt: 2, aheadDeadline: 0 })` after `a1`, with the message "DI-27" |
| TR-11 | Minor | `test/yields.test.ts:142-143` (DI-21) | The test asserts behaviour that deviates from RFC-001 §4.3 "for each one". The message names DI-21, but the test name does not | — | Add "(DI-21, open)" to the test name, so that the C02 resolution of CS-11 finds it |
| TR-12 | Minor | `test/oracle.yields.ts:36-150` | The oracle copies the rule choices (DI-21 … DI-26) from the code in the same order. It is independent in representation only | — | Add one oracle-free check from the log rows to `property.ts`: no `GRANTED` to a waiter that is younger than an older waiter with an unended claim whose `YIELD_REQUEST` holder windows overlap its window; each `ACCEPTED` names a `(holder, attempt, claim)` of an earlier `YIELD_REQUEST` that no later entry has ended |
| TR-13 | Minor | `tools/mutation/link.stryker.json`; `contracts/suites/src/c02.ts:528-601` | (a) `owner.ts:523` (arm after commit) is outside the mutate ranges. (b) The C02 suite's I5 part does not check "its re-sends stop", the `release` end of an attempt, or "`yield_accept` ends every other claim", so the account double will meet less than provider test 4 lists. The owner tests duplicate the suite tests at the same level | — | (a) Add `owner.ts:517-525` to the ranges. (b) Add to the suite, behind an optional `advance(ms)` on `C02Subject`: "the end of a hold attempt (release) closes every claim on it, and its re-sends stop". Assert no new `YIELD_REQUEST` push after `advance(5_000)` |

## Equivalent mutants dropped

- `state.ts:746` `comparePriority(o.cmd, h) >= 0` → `> 0`: two different requests never compare equal.
- `state.ts:807` `comparePriority(h, b) > 0` → `>= 0`: the same reason.
- `state.ts:743` remove `b.waiting` from `b.waiting && h`: `requestYields` keeps only holders whose mark is `true`, and `mustInclude` is this holder, whose mark was just cleared, so nothing is raised.
- `state.ts:768` remove `!h` or `h.attempt !== b.attempt`: an open request `y` exists only for the present attempt of a held request (the key of `y` has the attempt, and every end of an attempt deletes its requests).
- `state.ts:764` remove `a.attempt === b.attempt`: a claim is raised on one attempt only, so the claim decides the attempt.
- `state.ts:844` remove `c.waiter === key`: for its own claim `comparePriority` is 0, which is not `< 0`.
- `state.ts:831` `m > start` → `m >= start`: `start` is already in the set.

## Notes

- `test/support.ts:116` uses `Math.random()` for an envelope identity. This is from before I5 and does not change a
  decision.
- The joint traces drive the link with the recorded stub in the test. The run with the real account owner is at C6
  (plan §1 rule 4). This agrees with exit criterion 3.
- The worktree had no `@grpc/grpc-js` (STATUS "Environment"). The suites passed in this run.
