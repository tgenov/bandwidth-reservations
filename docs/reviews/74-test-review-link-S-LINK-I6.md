# 74. Test review: slices/link, S-LINK-I6 (changes to confirmed legs)

| | |
|---|---|
| Increment | S-LINK-I6 (`docs/04-delivery/plan/S-LINK.md`) |
| Change set | `git diff 91717d0..8ada271` (worktree `.claude/worktrees/s-link-i6`, branch `build/s-link-i6`) |
| Package | `slices/link`, and the I6 part of `contracts/suites/src/c02.ts` |
| Contracts | C02 v1.0.0: `end_leg`, `reduce_parts`, `convert` with `clippedAt`; provider tests 6, 7 and 8 (the two `INVALID(applies)` cases); joint traces |
| Date | 2026-10-13 |

## Verdict

**ADEQUATE WITH CHANGES.** No Blocker. 1 Major. 7 Minor.

Capacity correctness of the leg changes is well covered. `end_leg` and `reduce_parts` never raise a rate: the
named DI-33 test, the property run (`setRate` asserts `v <= old` from the log rows), and the final per-minute
comparison of `occ_firm` and `occ_all` with the oracle prove it. The oracle computes the rates per minute, apart
from `legs.ts`. No test hides capacity behaviour that contradicts C02 or RFC-001. The deviations from the letter of
C02 (DI-31 … DI-37) are written in `slices/link/STATUS.md`, and the tests show them openly. The changes to
`scenarios.test.ts`, `property.counteroffer.test.ts` and `property.ts` remove or weaken no assertion: they narrow
types and change failure messages only. In `support.ts`, the oracle adds the clip only when the leg has a later
`end_leg`, so the I1 … I4 outcomes do not change.

The one Major: no test sends a leg change whose append fails (`MOVING` and the other routing results) and then
sends it again. The rollback of the leg record is correct by reading, but no test proves it.

## Tool results

| Tool | Result |
|---|---|
| `npm run -s test:link` | 254 tests: 251 pass, 0 fail, 3 skipped (the `LINK_MEASURE` measurements). Green in 7 runs (6 of them with a manual mutant that some other test killed or that left the rest green). |
| `npm run -s test:contracts` | 98 tests: 94 pass, 0 fail, 4 todo (PENDING double gaps, one new for the account link double's I6 part). |
| `python3 tools/conformance.py` | No regression: P1 31 met. I6 delivers no P1 scenario. P2: 4 met, 19 partly met (the link parts of the I6 P2 scenarios have named tests). |

## Stryker summary

Stryker did not run. The brief forbids it, and `reports/mutation/link.json` does not exist. The grade comes from
reading and from 6 manual mutants on `slices/link/src/state.ts`. Each mutant ran with `npm run -s test:link`,
then the file was restored (`cmp` with the copy is equal; `git status` shows only this file).

| Manual mutant | Result |
|---|---|
| M1 `state.ts:762` the `STALE_CHANGE` check (rule 3) moved above the partition check (rule 4): the literal C02 rule order | Killed only by the two property runs in `property.legs.test.ts` (TR-4) |
| M2 `state.ts:762` the `STALE_CHANGE` check moved above `INVALID(applies)` and the malformed checks | Killed only by the two property runs (TR-4) |
| M3 `state.ts:795` `effective = Math.min(…)` → `Math.max(…)` (late minute of a `reduce_parts` with more than one part) | **Survived** (TR-2) |
| M4 `state.ts:666` a convert sets the leg owner to the account of its own hold (`{ ...leg, owner: hexOf(h.account), … }`) | **Survived** (TR-3) |
| M5 `state.ts:791` `freed(w.end, …)` → `freed(p.window.start, …)` (the `end_leg` scan covers the whole part) | Killed only by the first property run, not by the named scan test (TR-8) |
| M6 `state.ts:657` no `occ_all` clip for an open-ended hold (`h.window.end !== null && …`) | Killed by the first property run |

Read-only grade of the main breaks:

| Break | Killing test |
|---|---|
| `legs.ts:84` raise check `>` → `>=` | `should refuse INVALID(pieces) when a reduce_parts raises a rate …` (the piece equal to the present rate is `CHANGED`) |
| `state.ts:772` raise check dropped | Same test; property runs (`setRate` asserts no raise) |
| `legs.ts:65` clip of pieces at the window end dropped | `C02 6 reduce_parts: absolute pieces are clipped …` (asserts the stored pieces) |
| `legs.ts:66` `Math.max(p.from, w.start)` dropped | Same test (`occ` at 08:59 is 0) |
| `state.ts:657` `occ_all` clip of the hold dropped | `C02 7 a convert whose createdBy is below …` (`occ_all` at 15:00 is 0) |
| `state.ts:993` clip by every `end_leg` (any `createdBy`) | `C02 7 … above … is not clipped`; `C02 joint shorten, then extend …` |
| `state.ts:993` clip takes the latest end (`<` → `>`) | `C02 7 the clip takes the earliest end …` (16:00, not 17:00) |
| `state.ts:752` body digest compare dropped | `C02 6 an applied change id with another body gets MISMATCH …` |
| `state.ts:754` `recordedSeq` dropped | `C02 6 … recorded CHANGED …` (`seqOf(again) === seqOf(r1)`) |
| `state.ts:756` partition check dropped | `C02 6 a change id of another account partition gets MISMATCH …` |
| `state.ts:757` `applies` check: `!==` → `===`, or dropped | `C02 8 …` (both tests, all causes, empty list) |
| `state.ts:758` `fromMinute` check dropped | `should refuse INVALID(pieces) and INVALID(fromMinute) …` |
| `legs.ts:50` each malformed-piece condition | Same test (six piece lists, a part named twice, no part) |
| `state.ts:763` `STALE_CHANGE` writes an entry, or applies | `C02 6 … STALE_CHANGE(lastApplied) …` (occupancy and entry count, all causes) |
| `state.ts:766` `UNKNOWN_PART` check dropped | `should answer UNKNOWN_PART …` (the code throws on the missing part) |
| `state.ts:773` `UNKNOWN_REDUCTION` check dropped | `should answer UNKNOWN_REDUCTION …` |
| `state.ts:805` scan after a leg change dropped | `should give the capacity that an end_leg frees …`, `… a reduce_parts frees …`, property runs |
| `state.ts:807` `atOrAfterMs` → strict after | `should not alert LATE_CHANGE …` (10:01:00.000 is late) |
| `replaceContribution` writes only `occ_firm` | Every `occ` assertion in `legs.test.ts` |

## Findings

| ID | Severity | Location | Finding | Failing-mutant example | Proposed test |
|---|---|---|---|---|---|
| TR-1 | Major | `slices/link/src/state.ts:793`, `:803`, `:828` (`replaceContribution` `setIn`); `slices/link/test/legs.test.ts` (no case) | No test sends `end_leg` or `reduce_parts` with a failed append (`MOVING`, `STALE_EPOCH`, `STOPPED`, `Retry`), then sends it again. After `Moving` the owner calls `rollback()` and does only a catch-up rebuild, so an unjournaled write to the leg record or to a part stays in memory. Then the re-send gets the recorded `CHANGED` with no entry, and the trees keep the capacity (the leg never ends; the freed capacity of P2-S43 is not free). C02 names this case as a joint trace ("Shorten, then cut on one leg, with the first call answered `MOVING`"); the `end_leg` half is in I6 scope. Only `convert` has a `MOVING` test | `state.ts:803` `this.setIn(this.legs, lk, {…lastApplied…})` → `this.legs.set(lk, {…})`; or `state.ts:793` the same for `ends` (a phantom end then clips a later `convert`) | `C02 joint shorten answered MOVING: the re-sent end_leg ends the leg at 12:00, with one EndLeg entry`: `h.rt.scriptAppend(RESULTS.Moving())`; `assert.equal(resultOf(await endLeg(h, e)), 'MOVING')`; `assert.deepEqual(occ(h, [M(12)]), [[M(12), 4, 4]])`; `assert.deepEqual(outcome(await endLeg(h, e)), { result: 'CHANGED' })`; `assert.deepEqual(occ(h, [M(11, 59), M(12)]), [[M(11, 59), 4, 4], [M(12), 0, 0]])`; `assert.equal(logKinds(h).filter((k) => k === ENTRY.EndLeg).length, 1)`. The same for `reduce_parts` (`occ` at 10:01 is 1 after the re-send), and a `convert` of a hold of kind change with `createdBy` below the failed change id that gets `{ result: 'CONVERTED', part: 'p3' }` with no `clippedAt` |
| TR-2 | Minor | `slices/link/src/state.ts:795` | The late minute of a `reduce_parts` with more than one part (DI-34: the least first `from`) has no test. Each `LATE_CHANGE` test names one part | `state.ts:795` `Math.min` → `Math.max` (M3, survived) | `should alert LATE_CHANGE when the least first from of a reduce_parts with two parts has started`: parts p1 from 10:01 and p2 from 12:00, `ts` 10:01:00.000; `assert.deepEqual(h.owner.alerts.map((a) => a.kind), ['LATE_CHANGE'])` |
| TR-3 | Minor | `slices/link/src/state.ts:664-666` | The owner of a leg is the account of the hold of its first converted part (DI-37). No test converts a second part from a hold of another account, so the rule "the first part sets the owner" is not pinned | `state.ts:666` `{ ...leg, parts: … }` → `{ ...leg, owner: hexOf(h.account), parts: … }` (M4, survived) | `should keep the owner of the first part when a later part of the leg comes from a hold of another account (DI-37)`: convert p2 of R from a hold of account `other`; `assert.deepEqual(await endLeg(h, endLegCmd(h, { change: 100n, from: M(12), account: 'other' })), { code: 'MISMATCH' })`; `assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 101n, from: M(12) }))), { result: 'CHANGED' })` |
| TR-4 | Minor | `slices/link/src/state.ts:744-773`; `slices/link/test/support.ts` (`MinuteOracle.legChange`) | The check order of DI-35 has no named test that sends a command that breaks two checks. Only the property runs kill a reorder (M1, M2), and the oracle copies the link's order and its freed-range formula, so a shared design error is not visible. M1 is the literal C02 rule order (rule 3 before rule 4); DI-35 changes it, and the C02 note and the RFC-001 erratum are owed | `state.ts:762` `STALE_CHANGE` check above `state.ts:756` (M1) or above `state.ts:757` (M2): no named test fails | `should apply the DI-35 check order when a command breaks two checks`: after change 100 is applied, a change 99 of partition `other` gets `{ code: 'MISMATCH' }`; a change 99 with cause `POL07` and no `applies` gets `{ code: 'INVALID', field: 'applies' }`; a change 99 with pieces `[]` gets `{ code: 'INVALID', field: 'pieces' }`; a change 99 that names `p-none` gets `STALE_CHANGE(100)`; a change 101 that names `p-none` and raises p1 gets `{ code: 'UNKNOWN_PART' }` |
| TR-5 | Minor | `slices/link/test/legs.test.ts:208`, `:216`, `:226`, `:236`, `:245` | Five test names start with `C02 6`, but C02 provider test 6 has three items only (an applied lower id, a stale id, pieces clipped). These five prove rule 4 (with DI-35), the idempotency row "same key, different body", "sets, never decrements", and the joint trace "an account-owner takeover between two changes of one leg". The ID is not exact for them | — | Rename: `C02 joint an account-owner takeover between two changes of one leg: the change sent again gets its recorded CHANGED …` for `:245`; `should …` names for `:208`, `:216`, `:226` (cite DI-35 and DI-37), `:236` |
| TR-6 | Minor | `slices/link/test/legs.test.ts:187` | The `STALE_CHANGE` link stamp is checked only as `typeof … === 'bigint'`. The value is not asserted | `state.ts:763` add `recordedSeq: 0n` to the `STALE_CHANGE` decision: no test fails | In the same test: `assert.equal(seqOf(r), h.rt.log(utf8(h.link)).at(-1)?.seq)` (the stamp is the applied head; no entry) |
| TR-7 | Minor | `slices/link/test/legs.test.ts:236-243`, `:372-378` | Must-not: the tests of `MISMATCH` for another body and of `UNKNOWN_REDUCTION` assert the alert and the occupancy, but not "no entry". The shared `refuse` helper is proved elsewhere, so only a per-site change survives | `state.ts:773` `return refuse(…)` → `return { outcome: { code: 'UNKNOWN_REDUCTION' }, entry: true }` | Add `const entries = logKinds(h).length` before the command and `assert.equal(logKinds(h).length, entries)` after it, in both tests |
| TR-8 | Minor | `slices/link/test/legs.test.ts:424-434` | `should scan only the waiters that overlap the freed range of an end_leg` cannot see whether the waiter was examined: the waiter does not fit in either case, and its blocker does not change. M5 passes it (only the property run kills M5) | `state.ts:791` `freed(w.end, …)` → `freed(p.window.start, …)` (M5) | Use the scan-step count, as `T-07 the scan counts only the waiters that overlap the freed range` does: with `scanSteps: 1` and two waiters only in `[10:30, 11:00)`, assert no `Tick` entry after the `end_leg` (`assert.deepEqual(logKinds(h).slice(-1), [ENTRY.EndLeg])`) |

## Other checks (no finding)

- **Refusal codes.** Every code of `legChange` has a test with exact equality: `UNKNOWN_RESERVATION` (`:254`),
  `MISMATCH` partition and body (`:226`, `:236`), `INVALID(applies)` both cases and the empty list (`:349`,
  `:359`), `INVALID(fromMinute)` and `INVALID(pieces)` malformed (`:285`), `INVALID(pieces)` raise (`:273`),
  `STALE_CHANGE(lastApplied)` for all eight causes (`:173`), `UNKNOWN_PART` (`:263`), `UNKNOWN_REDUCTION` (`:372`).
  `MOVING` for a leg change: TR-1.
- **Property test.** Seeded (`rng(seed * 7919 + c)`), the seed is in every failure message, 30 % leg changes with
  gaps, repeats, changed bodies, foreign partitions, `applies` errors, unknown parts, raises, malformed values and
  late converts. The coverage assertions prove that every leg outcome, clips and grants occur.
- **Time.** No wall clock in `src/` or in the unit tests; the tests advance the runtime double's clock. The dev-cell
  test polls slot acquisition with a time limit (`waitFor`, 8 s), the pattern that review 67 accepted.
- **Integration hygiene.** `link-i6-crdb.test.ts` has `timeout: 180_000`, its own database (`createTestDatabase`,
  dropped in `finally`), and closes each runtime and store in `finally`, also when the start fails. It is written,
  not run (manual proof owed, orchestrator decision).
- **Contract suite.** `runC02ProviderSuite(…, { i6: true })` runs provider tests 6 (three items), 7 and 8 (two
  items) against the real link owner. The account link double has a PENDING entry in `contracts/suites/ISSUES.md`.
  Test 8 items 3 and 4 are for I13 and I14.
- **Earlier tests.** The changes to `scenarios.test.ts:141`, `property.counteroffer.test.ts:92` and
  `property.ts` keep every assertion.

## Equivalent mutants dropped

- `state.ts:762` `<=` → `<`: an equal sequence of the owner partition is the same change id, which rule 1 answers first.
- `state.ts:993` `e.seq > createdBy.seq` → `>=`: an E5 and an E11 never have the same (partition, sequence).
- `legs.ts:91` `end >= w.end` → `end > w.end`: the new window equals the old one, so the net impulse is 0 and the freed range is empty.
- `legs.ts:82` `w.start` removed from the points of `raises`: `old` and the `setPieces` result both start at `w.start`, so a piece `from` is at that point already.
- `owner.ts:402` `!('request' in p.cmd.body)` guard removed: `needsRecall` returns `false` for a leg change before it reads the body.
