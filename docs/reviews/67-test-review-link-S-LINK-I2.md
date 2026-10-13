# 67. Test review: `slices/link`, increment S-LINK-I2

Scope: the uncommitted S-LINK-I2 changes against `main` `d281d81`. These are `slices/link/src/{counteroffer,occupancy,state,owner,c02,index}.ts`, the tests in `slices/link/test/` (including `integration/link-i2-crdb.test.ts`), and `contracts/suites/src/c02.ts`.
Authority: `docs/process/engineering.md`, `docs/04-delivery/plan/S-LINK.md` §S-LINK-I2, `docs/04-delivery/contracts/C02-link-hold.md`.

## Verdict

**ADEQUATE WITH CHANGES.** 0 Blocker, 6 Major, 10 Minor.

The scenario tests and the T-04 oracle tests are strong on the main path. They do not cover these parts: the horizon (POL-09), the `fit_ranges` bounds, the open-ended availability path, the batch boundaries on the owner's replay, and three owner error paths. The builder's mutation score of 98.98 % is not valid. Most of the 656 timeouts were survivors or real kills that the overload hid (see below).

## Gates

| Gate | Result |
|---|---|
| `npm run -s test:link` | 93 tests: 91 pass, 0 fail, 2 skipped (the two measurements, `LINK_MEASURE` is not set). I ran it twice. Both runs were green. |
| `python3 tools/conformance.py --scripts test:link` | No script error. P1-S12, S15, S16, S17, S38, S39, S70, S73 are all `met`. |
| Stryker | See the next section. |

## Mutation testing

### What I ran

1. I ran Stryker again on a copy of the worktree in the scratchpad, so the worktree was never changed in place. The config copy had `timeoutMS` 90,000, `timeoutFactor` 1.5 and a command that stops at the first failure (first `✖`). The machine load was 120 to 220 on 8 cores. One mutant took 2 to 3.5 min, so a full run would take about 7 h. I stopped that run in the scratch copy. The instrumented sources stayed in the copy.
2. I used the instrumented copy with the builder's mutant IDs (I checked that the IDs match, for example id 51 = `counteroffer.ts:50 't + length >= h'`). I ran each selected mutant by hand with `__STRYKER_ACTIVE_MUTANT__=<id>` on the same six test files, with a 600 s limit per mutant:
   - all 84 non-killed mutants of `counteroffer.ts` (75 Timeout and 9 Survived);
   - 40 of the 362 Timeout mutants of `state.ts`, picked at random with seed `20261013`.
3. `owner.ts` is not in the `mutate` list. I made 7 manual mutants of its I2 parts and ran the full link suite on each (`contract.c02.test.ts` included).

### Results (killed-only; a timeout is not a kill)

| File | Mutants | Builder: killed / timeout / survived | Sample result | Killed-only score |
|---|---|---|---|---|
| `counteroffer.ts` | 141 | 57 / 75 / 9 | Of the 75 timeouts: 54 killed, 19 survived, 2 hang (infinite loop). The 9 survivors still survive. | **78.7 %** (111/141), exact. With the hangs counted as detected: 80.1 %. |
| `state.ts` (lines 186–489, 514–518) | 404 | 42 / 362 / 0 | Of 40 sampled timeouts: 29 killed, 11 survived (72.5 %) | **about 75 %** (42 + 0.725 × 362 ≈ 304/404), estimate; the 95 % interval is about 61 to 89 % |
| `occupancy.ts` | 339 | 120 / 219 / 0 | Not sampled (mostly I1 code) | at least 35 % (120/339) |
| All | 884 | 219 / 656 / 9 | | Confirmed kills: 302/884 = **34.2 %** (lower bound). Estimate with the sample rates: about 75 to 80 % for `counteroffer.ts` + `state.ts` |

Manual `owner.ts` mutants:

| Id | Change | Result |
|---|---|---|
| O1 | `owner.ts:499` `e.ts !== batchTs` → `true` (a new batch for each replayed entry) | SURVIVED |
| O2 | `owner.ts:518` remove `restoreRecord(p.record)` | killed (`should extend the tombstone …`) |
| O3 | `owner.ts:182` `if (mem.stopped)` → `if (false)` in `read()` | SURVIVED |
| O4 | `owner.ts:207` remove the `REQUEST_ROW_WITHOUT_RECORD` alert | SURVIVED |
| O5 | `owner.ts:569` remove `Number.isSafeInteger(w.end) &&` | SURVIVED |
| O6 | `state.ts:236` `needsRecall` → `return true` (every hold reads `link_request`) | SURVIVED |
| O7 | `owner.ts:499` remove the replay `beginBatch` line | SURVIVED |

A probe test in the scratch copy kills O1. It sets a policy of 2 steps per refusal and 3 per batch, sends two refusals in one batch, and then a takeover. On the original code the probe passes. With O1, `owner2.alerts` is `[{ kind: 'OUTCOME_MISMATCH_ON_REPLAY', detail: 'seq 11' }]`, so after the takeover the link is `STOPPED`.

## Findings

| ID | Severity | Location | Finding | Failing-mutant example | Proposed test |
|---|---|---|---|---|---|
| TR-1 | Major | `src/owner.ts:497-499` | The owner's replay starts a new counter-offer batch at each new `ts`, but no test covers this when the batch budget binds. The T-04 "two machines" test checks a copy of this logic in the test file (`property.counteroffer.test.ts:103-115`), not the owner's `rebuild`. If this breaks, a takeover finds an outcome difference and stops the link (`OUTCOME_MISMATCH_ON_REPLAY`, then `STOPPED`). | `owner.ts:499 'e.ts !== batchTs' → 'true'` (O1); line removed (O7) | `T-04 a replay after a takeover decides as the live batch when the batch budget binds`: harness with `{ counterofferSteps: 2, counterofferBatchSteps: 3 }`. Confirm 8 Mbps on [10:00, 10:30), [10:40, 11:10), [11:20, 11:50), [12:00, 12:30). In one batch (`Promise.all`, `rt.appends.length === n + 1`), send 5 Mbps holds for [10:00, 11:00) and [10:05, 11:05). Then a takeover. `assert.deepEqual(owner2.alerts, [])` and `assert.deepEqual(body(repeatB), body(liveB))` |
| TR-2 | Major | `src/counteroffer.ts:43`, `:50`, `:90-97`; `src/state.ts:345`; `src/owner.ts:146` | The selling horizon (POL-09) never limits a result in any test. The property domain is 600 min against a 12-month horizon. In P1-S38 and P1-S39 the `none` comes from a schedule that is full for ever, not from the horizon. `horizonMinute` (month-end clamp), the `h` part of the cache key (DI-2) and the availability `m0` are not tested. 12 mutants survive. | `counteroffer.ts:50 't + length > h' → 't + length >= h'` (id 51) and `→ false` (id 50); `:43 't < h' → 't <= h'` (id 38); `:95 Math.min → Math.max` (id 121); `:96 '/ 60_000' → '* 60_000'` (id 122) | `should limit the earliest window to the selling horizon when the free capacity starts near it`: tree `add(100, 200, 10)`, cRef 10, b 5. `earliest(t,10,100,50,5,250,512).value` deep-equals `{ window: { start: 200, end: 250 } }`. With h 249 it is `{ none: true }`. Open-ended with h 201 gives `{ window: { start: 200, end: null } }`; with h 200 it gives `{ none: true }`. `should clamp the horizon to the last day of the month when the date does not exist`: `horizonMinute(Date.UTC(2026,2,31)/60000, 1) === Date.UTC(2026,3,30)/60000`; 2027-01-31 → 2027-02-28; 2028-01-31 → 2028-02-29. I checked all these values on the current code. Also an owner-level P1-S38 case where the window fits only after `receiptMinute` + 12 months |
| TR-3 | Major | `src/counteroffer.ts:74-79` | The `fit_ranges` step bound and the clamp at `until` are not tested. The bound is 512, and no test finds more than 4 ranges. No test has a conflict that starts after `until` inside a range, and no test has a schedule that is full for ever after `from`. 6 mutants survive. | `:74 'steps >= limit' → 'steps > limit'` (id 95); `:75 'steps += 1' → 'steps -= 1'` (id 98); `:79 'y >= until' → false` (id 113: the range goes past `until`); `:77 'x === null' → false` (id 102) | `should stop fit_ranges at the step bound and give where to continue`: tree with `add(10*i, 10*i+5, 10)` for i = 0…3, cRef 10, b 5. `fitRanges(f,10,5,0,100,10,2)` deep-equals `{ ranges: [{start:5,end:10},{start:15,end:20}], continueFrom: 20 }` (checked). Add `fitRanges(f,10,5,0,12,10,9)` → the last range `{start:5,end:10}` and `continueFrom: null`; for a conflict that starts after `until`, the range ends at `until`. For a tree that is full for ever from t, the result is `{ ranges: [], continueFrom: null }` |
| TR-4 | Major | `src/counteroffer.ts:42` | The open-ended availability path is not tested when the last minute above θ is before or at `s`, or when nothing is above θ. A refusal always has a conflict at or after `s`, so only `availability` reaches this path. A wrong answer here can give a window that starts before the requested start. 6 mutants survive. | `:42 'last === null \|\| last + 1 < s' → 'last === null && last + 1 < s'` (id 27); `'last + 1 < s' → false` (ids 28, 30); `'last + 1' → 'last - 1'` (id 33) | `should answer open-ended availability from the requested start when the last conflict is before it`: tree `add(100,200,10)`, `earliest(t,10,300,null,5,10**9,512).value` deep-equals `{ window: { start: 300, end: null } }`. With s = 199: `{ window: { start: 200, end: null } }` (checked). On an empty tree: `{ window: { start: s, end: null } }` |
| TR-5 | Major | `src/owner.ts:182`, `:189-191`, `:205-208` | These owner error paths for the reads have no test: `STOPPED` for `query`/`availability`/`fit_ranges` on a stopped link, `READ_FAILED` with `UNAVAILABLE` when a read throws (for example, `consistentRead` fails during a `query` recall), and `REQUEST_ROW_WITHOUT_RECORD` when the `link_request` row names an entry with no `record`. | `owner.ts:182 'if (mem.stopped)' → 'if (false)'` (O3); remove the alert at `:207` (O4) | `should answer STOPPED to query and availability when the link stopped on replay`: as in `port.test.ts:284`, then `assert.deepEqual(await owner2.query(env, q), { code: 'STOPPED' })`. `should answer UNAVAILABLE and alert READ_FAILED when the link_request read fails`: make `rt.consistentRead` throw. `assert.deepEqual(reply, { code: 'UNAVAILABLE' })` and `alerts.map(a => a.kind)` includes `'READ_FAILED'` exactly once. `should alert REQUEST_ROW_WITHOUT_RECORD when the named log row has no record`: delete `payload.record` from the logged entry, then a repeat. `assert.deepEqual(alerts.at(-1), { kind: 'REQUEST_ROW_WITHOUT_RECORD', link, request, detail: 'seq <n>' })` |
| TR-6 | Major | `src/state.ts:233-237` | No test asserts the must-not: a hold before `D_c` with no record in memory must not read `link_request`. This keeps the read off the hold path (RFC-001 §7.2 step 5, DI-7). A break adds one high-priority read to every new hold, and no test goes red. | `state.ts:236` `→ return true` (O6) | `should not read link_request for a new hold before its D_c`: count `rt.consistentRead` calls (or `owner.recalledRecords` plus a read counter on the double). Send 10 new holds. `assert.equal(reads, 0)`. Also unit level: `assert.equal(st.needsRecall(holdBeforeDc, now, 60_000), false)` and `true` when `now + 60_000 >= commitFence` |
| TR-7 | Minor | `src/owner.ts:153-154`, `:569` | The `INVALID_QUERY` test does not cover a non-integer `window.end`, `end < start`, or a non-integer `k`. | `owner.ts:569` remove `Number.isSafeInteger(w.end) &&` (O5) | Add `availability(h,{start:H(10),end:H(10)+0.5},5)` and `{start:H(11),end:H(10)}` → `{ code: 'UNAVAILABLE' }`; `fitQuery(h,5,H(9),H(16),1.5)` → `{ code: 'UNAVAILABLE' }`; the alert count goes up by 3 |
| TR-8 | Minor | `src/state.ts:210`, `:223` | The prune schedule (`nextPruneAt`) is not tested. Outcomes do not change (recall covers them), but memory can keep final records longer than D + release_grace. | `:210 'until < this.nextPruneAt' → true` (id 489); `:223 'until < next' → false` (id 503) | `should remove each final record at its own D + release_grace when two records are due at other times`: records A (D+1 min) and B (D+5 min). After a batch at A's time, A is gone and B stays. After a batch at B's time, `recordState(B) === undefined` and `st.nextPruneAt === Infinity` |
| TR-9 | Minor | `src/state.ts:415`; `src/owner.ts:559` | The record `deadline` after a release with a later D is not asserted. It sets `deadline_at`, which is the `link_request` row TTL. A smaller value removes the row before `expiresAt`. | `:415 Math.max → Math.min` (id 773) | In `should extend the tombstone …`, assert the `deadline_at` of the `link_request` row equals `new Date(later).toISOString()` |
| TR-10 | Minor | `src/state.ts:256`, `:269`, `:388` (I1 code in the mutate range) | A second `init` writing no entry, the state-level `UNKNOWN_LINK`, and the content of a leg part have no assertion. | id 531 (`:256 → false`), id 536 (`entry: true`), id 554 (`'UNKNOWN_LINK' → ""`), id 748 (part `{}`) | `should not write a second Init entry when the link is registered again`: `assert.deepEqual(st.init(cmd), { outcome: { result: 'INITIALISED' }, entry: false })`. State `decide` on another link → `{ outcome: { code: 'UNKNOWN_LINK' }, entry: false }`. `partsInOrder()` deep-equals the expected part after a convert |
| TR-11 | Minor | `src/counteroffer.ts:116-118`; `src/state.ts:198` | `stepsLeft` / `counterofferStepsLeft` are asserted only in the skipped measurement test. | id 124 (getter body `{}`) | In the T-04 cache test: `assert.equal(h.owner.stateOf(link)?.counterofferStepsLeft, …)` after a refusal at unit level (`4_096 - steps`) |
| TR-12 | Minor | `test/counteroffer.test.ts:219-231` and `contracts/suites/src/c02.ts` "C02 1 query: …"; `counteroffer.test.ts:47`, `:129` and suite "C02 1 hold: REFUSED(NO_FIT) and REFUSED(IN_FLIGHT) carry …" | The same check is made twice at the same level (owner on the runtime double). | — | Keep the suite test for the contract and remove the slice copy, or keep only the scenario-specific values |
| TR-13 | Minor | `contracts/suites/src/c02.ts` `t('availability', …)`; `test/counteroffer.test.ts:295`, `:343`, `:360`, `:375`, `:207`, `:413`; comments at `:158`, `:177`; `integration/link-i2-crdb.test.ts:67`, `:73`, `:82`, `:96`, `:106` | `C02 availability` is not a contract test ID (C02 lists provider tests 1 to 9). Several `should …` names have no `when …`. Some comments tell the story of the test (§7). | — | Rename to `C02 1 [..] availability …` or ask for a C02 test ID. Use `should … when …`. Remove the story comments |
| TR-14 | Minor | `test/integration/link-i2-crdb.test.ts:37-40`, `:98` | `start()` asserts the slot acquisition before it returns `close`. If the assertion fails, the runtime and the `PgStore` stay open. The wait for D + release_grace is a `sleep(100)` loop on the wall clock. It is bounded, but it is a sleep. | — | Create `close` before the acquire wait and call it in a `finally` on failure. Wait for the condition with a helper that has a timeout (or a runtime test clock if C01 gives one) |
| TR-15 | Minor | `test/property.counteroffer.test.ts:109-110` | The "slow machine" uses a `performance.now()` busy wait. The apply reads no clock, so the wait can kill no mutant. The test replays with its own copy of the owner's batch rule (see TR-1). | — | Remove the busy wait. Test the owner's `rebuild` instead (TR-1) |
| TR-16 | Minor | `tools/mutation/link.stryker.json`; `package.json` `test:link` | `owner.ts` (read, recall, replay batching) is not in `mutate`. `contract.c02.test.ts` is not in the mutation command. With `timeoutMS` 15,000 on a loaded machine, timeouts hide survivors: 19 of the 75 `counteroffer.ts` timeouts survive. Two mutants hang (ids 47, 82: the loop body is removed), and `test:link` has no `--test-timeout`, so a hang does not fail fast. | — | Add the I2 parts of `owner.ts` to `mutate`. Report killed-only scores. Run Stryker on an idle machine. Add `--test-timeout` to `test:link` |

## Equivalent mutants dropped

- `counteroffer.ts:41` ids 19, 21 (`last === 'forever'` → false / `""`): `t` becomes the string `"forever1"`, `t < h` is false, so the result is still `{ none: true }` with 1 step. This is equivalent by accident and is brittle; an explicit check is cheap.
- `counteroffer.ts:42` id 26 (`last === null` → false): `null + 1 < s` is true for every real minute, so `t = s` as before.
- `counteroffer.ts:42` id 31 (`last + 1 < s` → `<=`): when `last + 1 === s`, both branches give `s`.
- `counteroffer.ts:79` id 114 (`y >= until` → `y > until`): when `y === until`, both give `end = until`.
- `state.ts:458` ids 839, 841 (`rec.madeBy === 'release'` → false / `""`): a record that a release made has `state: 'RELEASED'`, so the last branch returns the same `{ state: 'RELEASED', tombstoneUntil }`.
- `state.ts:316` id 625 (`madeBy: 'hold'` → `""`): `madeBy` is only compared with `'release'`.
- `state.ts:363` id 681 (`latest = -1` → `+1`): every deadline is an epoch-ms value far above 1.
- `occupancy.ts` `lastAbove` `this.root !== NIL` (not sampled): with no root, `total = carry`, and the `'forever'` branch already returned.
