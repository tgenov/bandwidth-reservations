# 69. Test review: slices/link, S-LINK-I4 (validity and the rolling horizon)

| | |
|---|---|
| Increment | S-LINK-I4 (`docs/04-delivery/plan/S-LINK.md`) |
| Change set | `git diff 7b805e4..e92e8a1` (worktree `agent-a8dc7bad5ee9531e2`) |
| Package | `slices/link`, and the I4 part of `contracts/suites/src/c02.ts` |
| Contracts | C02 v1.0.0 `hold` check (4), provider test 1 (V1 … V6 with the P1-S74 calendar cases) |
| Date | 2026-10-13 |

## Verdict

**ADEQUATE WITH CHANGES.** No Blocker. 4 Major. 7 Minor.

## Tool results

| Tool | Result |
|---|---|
| `npm run -s test:link` | 155 tests: 153 pass, 0 fail, 2 skipped (the two `LINK_MEASURE` measurements). Not flaky in 7 runs (5 of them with a manual mutant). |
| `npm run -s test:contracts` | 81 tests: 77 pass, 0 fail, 4 todo (PENDING double gaps, including the account link double's I4 part). |
| `python3 tools/conformance.py` | P1-S18, P1-S19, P1-S20, P1-S21, P1-S22, P1-S23 and P1-S74 are all "met". |

## Stryker summary

Stryker did not run. The brief forbids it, and `reports/mutation/link.json` does not exist. The grade comes
from reading and from 5 manual mutants, each run with `npm run -s test:link` and then restored
(`git status` is clean except this file).

| Manual mutant | Result |
|---|---|
| `state.ts:598` `atLeast(p.releaseGraceMs, 0)` → `atLeast(p.releaseGraceMs, 1)` | **Survived** (TR-4) |
| `state.ts:599` `atLeast(p.counterofferBatchSteps, 1)` → `atLeast(p.counterofferBatchSteps, 0)` | **Survived** (TR-4) |
| `state.ts:392` counter-offer `rules.rateMinMbps` → `this.policy.rateMinMbps` | **Survived** (TR-2) |
| `state.ts:340-341` policy-version check moved above checks (1) … (3) | Killed (I1 property run, T-04 property run) |
| `state.ts:340-341` policy-version check moved above check (3) only | Killed (I1 property run, T-04 property run), but by no named test (TR-7) |

Read-only grade of the main breaks in `invalidRule` (`state.ts:579-592`):

| Break | Killing test |
|---|---|
| V1 `<` → `<=` (rate = `rate_min`) | `should write one Policy entry …` (rate 1 at v1, rate 2 at v2 are `HELD`) |
| V1 safe-integer guard dropped | `P1-S19 … a rate that is not a whole number of Mbps` |
| V2 start or end guard dropped | `P1-S19 … starts off a minute boundary`, `… ends off a minute boundary` |
| V3 `<=` → `<` | `P1-S19 … empty` |
| V4 `<` → `<=` (s = m0) | `P1-S20 … starts in the current minute`, `T-05 a request received at hh:mm:59.98 …` |
| V4 compares with the minute of `ts`, not `m0` | `T-05 a hold that reaches the link one minute boundary after receipt …`, T-05 property (link up to 90 s after receipt) |
| V4 whole-minute guard on `m0` dropped | `T-05 a receipt minute that is not a whole minute fails V4` |
| V5 `!(s < H)` → `s > H` | `P1-S19 … starts at the end of the selling horizon` |
| V6 `>` → `>=` | `P1-S20 … ends exactly at the selling horizon`, P1-S74 `CONVERTED` rows |
| Month-end clamp removed or off by one minute | P1-S74 rows (31 March, 29 February), C02 P1-S74 suite case, T-05 property |
| Rule order changed | `T-05 the rules are checked in the order V1 … V6 …` |
| `applyPolicy`: `setScalar('policy', p)` dropped or condition flipped | `should keep every applied version …`, `should rebuild every policy version …` |
| `applyPolicy`: digest compare flipped | `should answer a repeated deployment …`, `should refuse a deployment … (MISMATCH …)` |
| Owner replay branch `op === 'policy'` dropped | `should rebuild every policy version by replay …` |
| `UNAVAILABLE` writes an entry or a record | `should answer UNAVAILABLE and write no log entry …` (log length, record, `occAll`) |

## Changes to earlier tests

All changes are test data or new checks. No assertion is removed or made weaker.

| File | Change | Grade |
|---|---|---|
| `test/support.ts` | `harness({ startMs })`, `HoldArgs.policyVersion` (default `1n`), `MinuteOracle.deploy`, `oracleInvalid`. The oracle now judges V1 … V6 and the policy version. Before, it judged only V1 (hard-coded `< 1`) and V3. | Stronger. The oracle is written apart from `invalidRule` (own whole-number test, own horizon `oracleHorizon`). |
| `test/property.ts` | 10 % of holds break one rule or carry version 9. The log filter skips `policy` entries. New check (5): each `INVALID` entry has `tombstoneUntil = D + release_grace`. | Stronger. Checks (1) … (4) are unchanged. |
| `test/property.test.ts` | The runtime-core run uses the present minute of its real clock as `base`. A new assertion: V1 … V6 and `UNAVAILABLE` each occur. | Data change and a new assertion. |
| `test/counteroffer.unit.test.ts` | `holdAt` has `receiptMinute: 1000` (was the 2026 minute). | Data only. The horizon is still far after every window in the file, so each counter-offer value stays the same. |
| `test/integration/link-crdb.test.ts` | Windows from the present minute of the real clock. | Data only. The weak `includes([...])` assertion at line 80 is from I1, not from this change. |
| `test/contract.c02.test.ts` | `{ i4: true }` | Turns on the I4 part. |

## Findings

| ID | Severity | Location | Finding | Failing-mutant example | Proposed test |
|---|---|---|---|---|---|
| TR-1 | Major | `tools/mutation/link.stryker.json:5, 13-18` | The Stryker config is stale after I4. (a) The `mutate` ranges do not include `invalidRule` (`state.ts:579-592`) or `wellFormedPolicy` (`state.ts:595-600`). (b) The range `state.ts:514-518` was `atOrAfterMs` (check (3), `DEADLINE_PASSED`). It now points to `availability()`, and `atOrAfterMs` is at `state.ts:552-556`, out of range. The `owner.ts` ranges also moved. (c) The command runs none of the I4 test files (`validity.test.ts`, `horizon.test.ts`, `property.validity.test.ts`). A person who runs `mutation:link` gets false survivors in `applyPolicy` and no grade for V4 … V6. | `state.ts:587` `start < h` → `start <= h`: Stryker never makes this mutant. `state.ts:555` `>=` → `>` in `atOrAfterMs`: no longer mutated. | Not a test. Update the ranges to the current line numbers (or mutate the whole of `state.ts` and the `owner.ts` apply functions), and add the three I4 test files to `commandRunner.command`. |
| TR-2 | Major | `src/state.ts:390-393`; `test/validity.test.ts:225-234` | DI-17 says the counter-offer takes `rate_min` from the hold's policy version. No test checks it: in the only test with two versions, `largestRateMbps` is 0 for both, and the property runs use one version only. | `state.ts:392` `rules.rateMinMbps` → `this.policy.rateMinMbps` (survived, run). | `should give the counter-offer largest rate by rate_min of the policy version that the hold carries`: deploy V2 (`rateMinMbps: 2`), fill the window to 9 Mbps, then a hold with `policyVersion: 1n`, rate 5 → `assert.deepEqual(counterOffer.largestRateMbps, 1)`; the same hold with `policyVersion: 2n` and rate 5 → `largestRateMbps === 0`. |
| TR-3 | Major | `contracts/suites/src/c02.ts:301-321` | C02 provider test 1 says "A query after each refusal shows a tombstone". The I4 part does not query after the `INVALID(rule)` refusals. Its name says "hold nothing", but no assertion shows that nothing is held (the 7 invalid windows at 1 or 1.5 Mbps fit beside the 3 edge holds in 10 Mbps, so the edge assertions pass also when the invalid holds hold capacity). The account link double will be graded by this suite. A double that holds capacity for an invalid hold, or records no tombstone, passes. | A provider whose check (4) returns the refusal but also adds the window to `occ_all`, or writes no record: all I4 contract cases stay green. | In the same test, after each case: `assert.deepEqual(outcome(await query(s)(env(s, cmd), {link, receiverPartition, request: cmd.request})), { state: 'REFUSED', refusal: { reason: { invalid: rule } }, tombstoneUntil: cmd.deadline + RELEASE_GRACE_MS })`. Before the edge loop: a hold of `C02_SUITE_CAPACITY` Mbps on `[m0 − 1, m0 + 121)` → `{ result: 'HELD', attempt: 1 }`, then release it. |
| TR-4 | Major | `src/state.ts:595-600`; `test/validity.test.ts:272-286` | `wellFormedPolicy` has a lower bound for each parameter. The test has one value below each bound, but no valid policy with a parameter at its bound. Thus the bound can move by one in the "accept" direction for `counterofferBatchSteps` and `requestRecordTtlMs`, and in the "refuse" direction for every parameter. | `state.ts:598` `atLeast(p.releaseGraceMs, 0)` → `1` (survived, run); `state.ts:599` `atLeast(p.counterofferBatchSteps, 1)` → `0` (survived, run). | `should apply a policy with every parameter at its lower bound`: deploy `{ version: '6', releaseGraceMs: 0, requestRecordTtlMs: 1, rateMinMbps: 1, sellingHorizonMonths: 1, counterofferSteps: 1, counterofferBatchSteps: 1 }` → `{ result: 'POLICY_APPLIED', version: '6' }`. Add `{ counterofferBatchSteps: 0 }` and `{ requestRecordTtlMs: 0 }` to the `bad` list (→ `{ code: 'INVALID_POLICY' }`). |
| TR-5 | Minor | `test/property.validity.test.ts:57` | For a valid hold the test accepts `HELD` or `NO_FIT`. The state is empty for each case (rollback), so the outcome is known exactly. | A valid hold of 5 Mbps refused `NO_FIT` passes this test (other tests kill it). | `assert.equal(got, rate > 10 ? 'REFUSED:"NO_FIT"' : 'HELD', msg)`. |
| TR-6 | Minor | `test/validity.test.ts:288-291` | The `UNKNOWN_LINK` deployment test has no must-not assertion: no log entry and no alert. | `state.ts:284` `entry: false` → `entry: true` on `UNKNOWN_LINK`: a Policy entry goes to the log of `L-none`. | Add `assert.equal(h.rt.log(utf8('L-none')).length, 0)` and `assert.deepEqual(h.owner.alerts, [])`. |
| TR-7 | Minor | `src/state.ts:340-341` | The place of the `UNAVAILABLE` check (after (3), before (4); DI-18) is killed only by the I1 and T-04 property runs, by chance of the random mix. No named test states it. | Check moved above (3): only property runs go red (run). | `should refuse DEADLINE_PASSED before UNAVAILABLE when a hold with an unapplied version comes at or after D_c`: `holdCmd({ policyVersion: 9n, deadlineInMs: 400 })` → `REFUSED:"DEADLINE_PASSED"`. And a repeat of a recorded hold with `policyVersion: 9n` → `{ code: 'MISMATCH' }`. |
| TR-8 | Minor | `src/state.ts:294`; `src/owner.ts:237, 494`; `src/state.ts:598` | Cheap mutants with no test: (a) the version compare is `BigInt`; a string compare passes all tests, because no version has two digits. (b) `deployPolicy` clones the policy; no test changes the caller's object after the deploy. (c) `onReply` key `policy:<link>` is not asserted. (d) `typeof p.version === 'string'` dropped: an untyped version `5` is accepted. | (a) `BigInt(p.version) > BigInt(this.policy.version)` → `p.version > this.policy.version`. (c) `` `${p.t}:` `` → `` `init:` ``. | (a) deploy `'9'`, then `'10'`, then check `policy.version === '10'`. (b) change `V2.rateMinMbps` after the deploy, then hold v2 rate 1 → `REFUSED:{"invalid":"V1"}`. (c) with `onReply: (l) => rt.recordReply(l)`, assert that the recorded replies include `policy:L1`. (d) `{ version: 5 as unknown as string }` → `INVALID_POLICY`. |
| TR-9 | Minor | `src/state.ts:587-588` | `!(s < H)` exists so that an `H` out of the Date range (NaN) fails V5. No test sends a receipt minute that large. | `!(start < h)` → `start >= h`: a hold with `receiptMinute: 2 ** 52` passes V5 and V6 (NaN compares false). | `T-05 a receipt minute beyond the date range fails V5`: `receiptMinute = 2 ** 52`, window `[2 ** 52, 2 ** 52 + 60)` → `REFUSED:{"invalid":"V5"}`. |
| TR-10 | Minor | `test/integration/link-i4-crdb.test.ts:29-38, 46-54` | `waitFor` polls with `sleep(50)` and reads `Date.now()` for its time limit. §5 asks for an event or a promise. The resources close in `finally`, not in `afterEach` (§6); the effect is the same here. The I1 file has the same pattern. | — | Wait for the `onAcquire` hook with a promise and a timeout. Move `close` and `db.drop` to `afterEach`. |
| TR-11 | Minor | `test/validity.test.ts:31-58` and `contracts/suites/src/c02.ts:301-321` | The V1 … V6 rows are checked twice against the real link owner, at the scenario level and at the contract level. | — | Keep the contract test (the plan asks for it). The scenario test can keep its must-not checks (no hold, `occAll` empty, tombstone) and drop the rows that the contract test has. |

## Checks with no finding

- **Time.** No wall clock in `src/` (the apply reads `ts` and `m0`). Unit and property tests use the runtime double's stepped clock. The I1 runtime-core property run uses the core's real clock only for `base`; the oracle reads `m0` from each command, so the result does not depend on the time.
- **Randomness.** `property.validity.test.ts`, `property.ts` use the seeded `rng`; each failure message prints the seed.
- **Error paths.** `UNAVAILABLE`, `INVALID_POLICY`, `MISMATCH` (policy), `UNKNOWN_LINK` (deploy), `POLICY_APPLIED`, each `INVALID(V1 … V6)` and the alerts `POLICY_MISMATCH` and `INVALID_POLICY` each have a test with exact equality.
- **Must-not.** `UNAVAILABLE`: no log entry, no record, nothing held, and in a batch only the other hold's entry. A repeated deployment: no entry, no alert. MISMATCH and INVALID_POLICY: no entry. P1-S19: no hold, `occAll` empty.
- **Property tests.** Exit criterion 4 (each invalid hold gets `INVALID` and a tombstone; each rule and `UNAVAILABLE` occur) is in `property.ts` check (5). T-05 and T-06 have seeded properties against independent oracles. P1-N1 (never oversell) holds from the log rows after each entry.
- **Names.** Every new test name starts with a scenario ID (P1-S18 … P1-S23, P1-S74), a test ID of the plan (T-05, T-06), a contract test ID (`C02 1`), or `should … when …`.
- **Exit criterion 3 on the dev cell** is "written, not run (manual proof owed)" by the orchestrator decision. The unit tests on the double stand in for it and are adequate.

## Equivalent mutants dropped

- `state.ts:294` `>` → `>=` in `applyPolicy`: an equal version returns earlier (the `known` branch), so this line never sees an equal version.
- `state.ts:284` `this.link === undefined ||` dropped: `cmd.link !== this.link` is also true when `this.link` is undefined.
- `state.ts:333` (check (2) before the policy check) for a recorded hold with the same body: every recorded hold has a version that the link has applied, and versions are never removed, so the order gives the same answer.
