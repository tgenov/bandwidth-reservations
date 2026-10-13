# S-ACCT + S-MONEY status

Plan: [S-ACCT-S-MONEY.md](../../docs/04-delivery/plan/S-ACCT-S-MONEY.md). Delivered increments are in
[done.txt](../../docs/04-delivery/plan/done.txt).

## Packages

| Package | Path | Increment | Contents |
|---|---|---|---|
| `@share/account-owner` | `owner/` | AM-I1 | Account owner kind: booking module and funds-and-standing module |
| `@share/booking-api` | `booking-api/` | AM-I1 | Booking API on the edge |
| `@share/money` | `money/` | MONEY-I2, MONEY-I3 | Ledger owner kind `ledger`, settlement of reservation and usage batches, posting templates M4 … M13, M23 and abandon postings, Webster split, deviation report. Details: [money/STATUS-MONEY-I2.md](money/STATUS-MONEY-I2.md) and the MONEY-I3 section below |

Run: `npm run -s typecheck:account`, `npm run -s test:account`, `npm run -s test:contracts`. The globs
`slices/account/*/test/*.test.ts` and the `money/**/*.ts` include of `tsconfig.json` take every package.
Integration and measurement (by hand only, dev cell): `npm run test:account:integration`, `npm run measure`.

## Increments

| Increment | State | Notes |
|---|---|---|
| AM-I1 | Done | In `done.txt` |
| MONEY-I2 | Built, not committed. Waits for review and merge | Exit criteria (1) … (5) met in `test:account` and `test:contracts`. Exit criterion (6), the X2-S13 measurement at the SP4 rate, is not met on the shared dev cell (see below) |
| MONEY-I3 | Built, not committed. Waits for review and merge | Exit criteria (1) … (5) met in `test:account` and `test:contracts`. Exit criterion (6), the X2-S13 usage measurement, is a manual proof owed (see the MONEY-I3 section) |

## MONEY-I2 exit criteria

| # | Criterion | State | Proof |
|---|---|---|---|
| 1 | B13 "Webster property test" and the §B3.2 worked examples (P4-S35, P4-S36, P4-S73, P4-S102) | Met | `money/test/webster.property.test.ts`, `money/test/webster.test.ts` |
| 2 | C06 CT-L1 (reservation rows), CT-L3, CT-L5, CT-L7, CT-L8, CT-L9 | Met | `money/test/ledger.test.ts`, `money/test/settlement.test.ts`, `money/test/contract.c06.test.ts` (`runC06ReservationSuite` on the real ledger) |
| 3 | C06 CT-C1 on the reservation fixtures | Met | `money/test/settlement.test.ts` |
| 4 | C01 CC-1 … CC-8 for the ledger kind; no UPDATE or DELETE grant on the movement table (P4-S29) | Met | `money/test/ledger-c01.test.ts`, `money/test/ledger.test.ts`. The grants job on CockroachDB is in `money/test/integration/ledger-crdb.test.ts` (by hand) |
| 5 | Two currencies, a line that does not sum to zero, a zero amount: refused, nothing moves (P4-S28, P4-S31) | Met | `money/test/ledger.test.ts`, `money/test/ledger.property.test.ts` |
| 6 | X2-S13 (acknowledged within 2 min at p99 at the SP4 rate on one partition) and X2-S14 (no answer before durable) | Not met on the dev cell. X2-S14 holds by construction and has a test (`C01 CC-1`) | `money/test/integration/measure.test.ts` (`MONEY_MEASURE=1`, by hand). The run did not complete on the loaded, shared dev cell. Needs SP4 on a quiet cluster |

## Money invariants and their property tests

| Invariant | Property test |
|---|---|
| Every movement and the whole ledger sum to zero; balances equal a replay of the log | `ledger.property.test.ts` `P4-S28 every money movement sums to zero …` |
| A line key is charged once, at the amount of its first accepted send, whatever is sent again (resend, changed line, new batch id); the parties get exactly the charged amounts | `ledger.property.test.ts` `C06 CT-L5 a line key is charged once …` |
| The Webster split equals the one-unit-at-a-time reference, sums exactly to the charge, is monotone, and does not depend on call order | `webster.property.test.ts` `B13: …`, `P4-S32`, `P4-S33`, `P4-S34` |

Each property test was shown once to fail when the code is broken on purpose (see
`money/STATUS-MONEY-I2.md`).

## Changes outside the slice (MONEY-I2)

1. `platform/runtime/src/store/pg.ts`: batched reads and multi-row UPSERTs. Only the CockroachDB path uses it
   (integration and measurement). The unit, property and contract tests do not need it. S-PLAT reviews it;
   S-PLAT-I2 also changes this file.
2. `contracts/suites`: `runC06ReservationSuite`, `C06_SUITE_WEIGHTS`; the C06 PENDING entry now names
   MONEY-I3; `ISSUES.md` CS-6, CS-7, CS-8.
3. `tools/eslint/plugin.js`: test titles can start with `B13: `.
4. Root `package.json`: the `slices/account/money` workspace, `test:account:integration`, `mutation:money`,
   and `measure`. `tools/mutation/money.stryker.json`.

## Open design issues

D-1 … D-12 in [money/STATUS-MONEY-I2.md](money/STATUS-MONEY-I2.md) go to the RFC and contract owners.

## MONEY-I2 delivery decision (2026-10-13)

MONEY-I2 is delivered with exit criteria 1 to 5 met by unit, property and contract tests.
Exit criterion 6 (X2-S13: a 300-line movement commits within 2 s at the SP4 rate) is a
**manual proof owed**. Local testing is contract and double based only, so no agent runs it.
A person runs the integration measurement on a quiet dev cell and records the result here.

## MONEY-I3: usage batches, amendments, corrections, fees and cost lines

Plan: [S-ACCT-S-MONEY.md MONEY-I3](../../docs/04-delivery/plan/S-ACCT-S-MONEY.md). Contracts: C06 v1 §7, §8, §9
complete (provided), §5 and §2 (consumed). RFC-004 Part B §B2 (M4 … M13, M23), §B3.1, §B3.3, §B3.5.

The work is not committed.

### Components

| File | Contents |
|---|---|
| `money/src/ledger/templates.ts` | The C06 settlement mapping table (`ruleOf`) and the RFC-004 §B2 templates (`postingOf`): M4, M5, M6 (normal mode), M7 (own mode), M8, M9, M10, M11, M12, M13, M23 (nil line when nothing moves), abandon postings. Settlement builds the entries with them; the ledger checks the entries against them (C06 §8 check 2) |
| `money/src/ledger/decide.ts`, `owner.ts`, `accounts.ts` | Every `lineKind`; amendment sequence per line key; `priorTotal` check; `content_conflict` with `ledgerPostedTotal`, `ledgerLastSeq`, `ledgerPosition`; derived references (AI4-1); `lateCut` stored as given (CI4-3); line mode and shares per line; a usage batch committed whole or refused whole (`refused_batch`, the recorded answer); `lineState` read for settlement |
| `money/src/settlement/settlement.ts` | Usage batches (one in flight per account), `prepareUsageBatch`, `batch_refused` and `batch_over_limit` for usage batches, direct acknowledgements of exclusions, abandon lines in reservation batches |
| `money/src/settlement/deviation.ts` | The deviation report of RFC-004 §B3.5 for each party and payout period |
| `money/testing/` | CT-R usage fixture (CT-R6, CT-R9, CT-R10, CT-R12, CT-R13) with the golden ledger; line and batch builders; catalogue double for operator price corrections (P4-S99); split weights of the path route RP (R1, R2, R3 unchanged) |

### Exit criteria

| # | Criterion | State | Proof |
|---|---|---|---|
| 1 | C06 CT-L1 (all rows), CT-L2, CT-L3 (usage batch), CT-L4, CT-L6, CT-L10 | Met | `money/test/usage.test.ts` (`C06 CT-L1` ×4, `CT-L2`, `CT-L3`, `CT-L4 (1)` … `(4)`, `CT-L5` ×2, `CT-L6`, `CT-L7` ×2, `CT-L10`); `money/test/contract.c06.test.ts` (`runC06ProviderSuite` on the real ledger: CT-L1 ×2, CT-L4 ×3, CT-L5 ×2, CT-L6) |
| 2 | C06 CT-C1 on every CT-R fixture | Met | `usage.test.ts` `C06 CT-C1 … usage fixtures …` (each batch also three times); `settlement.test.ts` `C06 CT-C1 …` (reservation fixtures) |
| 3 | B13 "Order independence", "Per-line dedup", "Cost-line amendments", "Batch kinds" and "Usage batches whole" | Met | `money/test/usage.property.test.ts`: `P4-S38 B13: Order independence …`, `C06 CT-L5 B13: Per-line dedup …`, `P4-S116 B13: Cost-line amendments …`, `P3-S61 B13: Batch kinds and Usage batches whole …` |
| 4 | §B2 worked examples for M6 … M13 and M23 (P4-S41, P4-S42, P4-S56, P4-S75, P4-S85, P4-S89, P4-S110, P4-S115, P4-S116) | Met | `usage.test.ts` (one test for each scenario, exact micro-USD amounts) |
| 5 | P4-S99 against the catalogue double: the second "C1" moves no money | Met | `usage.test.ts` `P4-S99 …` |
| 6 | Measurement: usage lines posted within `max_lateness` + 120 s of their minute's end at p99 (X2-S13); a refused usage batch costs one gated cycle (est. 2.5 s, R4-B11) | **Manual proof owed** | `money/test/integration/usage-measure.test.ts` (`MONEY_MEASURE=1 npm run measure`, by hand on a quiet dev cell). Written, not run: local testing is contract and double based only. A person runs it and records the result here |

Scenarios with a passing test in `test:account`: P4-S30, P4-S37, P4-S38, P4-S39, P4-S41, P4-S42, P4-S56, P4-S74,
P4-S75, P4-S77, P4-S84, P4-S85, P4-S89, P4-S99, P4-S110, P4-S115, P4-S116 (all 17 of the plan). Also P3-S61 (B13 property test). P4-S57 stays with MONEY-I27 (review 71 TR-15).

### Money invariants and their property tests (MONEY-I3)

The oracles share no code with the provider (`test/support-usage.ts` `refSplit` is a one-unit-at-a-time Webster
reference). Each property test is seeded; a failure names its seed.

| Invariant | Property test |
|---|---|
| Late traffic in any order, partly repeated, gives the balances of delivery in order; a late-traffic amendment never debits a party (P4-S38, P4-S39); every movement and the ledger sum to zero (P4-S28) | `usage.property.test.ts` `P4-S38 B13: Order independence …` |
| Each line key is posted once, at its first accepted content, after crashes and re-composed batches; a changed line moves nothing | `C06 CT-L5 B13: Per-line dedup …` |
| In own mode (M7, M8, M9) the buyer holds −T_final; a supplier's fault debt is max(0, held_f − split(T_new)_f); no supplier gains on its own fault; Share bears the rest | `P4-S42 B13: Corrections in own mode …` |
| A supplier's holding of a cost line falls only by its own fault; Share never pays a party twice for one total; Share's costs equal what the suppliers hold | `P4-S116 B13: Cost-line amendments …` |
| A usage batch with a conflict, a sequence gap, an invalid line or more than 5,000 lines posts nothing; a reservation batch posts every good line; a duplicate never refuses a batch | `P3-S61 B13: Batch kinds and Usage batches whole …` |
| The reported deviation of each party equals Σ (split(T)_i − T·w_i / W) over the final line totals | `deviation.test.ts` `P4-S37 … for random originals and late traffic` |

Each was shown once to fail when the code is broken on purpose (2026-10-13): (a) M23 lets a supplier's holding
fall without its own fault: `P4-S116 B13` and two example tests fail; (b) M6 uses `split(Δ)` in normal mode:
`P4-S38 B13` and `P4-S37` fail; (c) the ledger posts a usage batch partly: `C06 CT-L5 B13`, `P3-S61 B13` and six
CT-L4, CT-L5, CT-L6 tests fail. The code was restored after each run.

### Review 71 (test review, INADEQUATE): fixes

The fixes add tests only. No code defect was found: the abandon-up posting (`templates.ts`, TR-3) pays each
supplier `split(newTotal)_i − split(priorTotal)_i`, as RFC-004 §B2 "Abandon posting" states. Each mutant below was
put in by hand, `npm run -s test:account` was run, and the file was restored (2026-10-13).

| Finding | Fix | Mutant now killed by |
|---|---|---|
| TR-1 (Blocker) | `usage.test.ts` `P4-S42 a correction caused by supplier a that lands below a's split in own mode …` (R31: 8 → 7 → 27 → 26) | `templates.ts` M9 `d = posted − target`: this test and `P4-S42 B13` |
| TR-2 (Blocker) | `C06 CT-L1 each other invalid row …`: `newTotal` −50 and `priorTotal` −10 after a posted 100; balances unchanged | remove `a negative total` |
| TR-3 (Blocker) | `C06 CT-L10 an abandon-up posting pays the suppliers only the increase …`: entries A 15, B 17, C 11, `SH:costs` −43; B:b1 −100 | abandon-up `prev` = 0 |
| TR-4 (Major) | `C06 CT-L1 each row …`: `quarantine_attribution`, `corrected_record`, `price_correction`, `superseding_record`, `re_rate` up (M6) | each reason removed from `UP_USAGE` (5 mutants) |
| TR-5 (Major) | `C06 CT-L1 each other invalid row …`: refusals at `templates.ts` 74, 87, 96, 98, 99 (route and weights version), 102, 112 | each guard removed (7 mutants) |
| TR-6 (Major) | `C06 CT-L1 the ledger refuses a usage request with two sequences of one line key …` (on the port) | `decide.ts` C06 D2 check removed |
| TR-7 (Major) | `C06 CT-L6 a usage line whose split mode or explicit shares are not the template's …`; the template's shares post | `split.mode` check removed; `explicitShares` check removed |
| TR-8 (Major) | `settlement.test.ts`: template refusal in a usage batch (`LINE_INVALID`), batch kind `refund`, no line-state reader (`POST_FAILED`), `refused_batch` for a reservation batch (`UNEXPECTED_ANSWER`, held) | each of the four branches removed |
| TR-9 (Major) | `C06 CT-L2 a late POL-07 cut of 1,200 to 600 in own mode posts M7 …`: exact entries, mode `own` | M7 downward shares reversed: this test and `P4-S42 B13` |
| TR-10 (Major) | `usage.property.test.ts` `P4-S42 B13: Corrections in own mode …` (20 seeds; R1, R31, R4; M6, M7 up and down, M8, M9) against an oracle with `refSplit` | TR-1 mutant (shown once) |
| TR-11 (Major) | `tools/mutation/money.stryker.json`: `templates.ts` and `deviation.ts` added to `mutate`. Stryker not run (a person runs it) | n/a |
| TR-12 (Minor) | Test renamed (`… and the batches behind it wait in order`). The fixed tick wait stays: it is a must-not check | open in part |
| TR-13 (Minor) | Exact reason and detail asserted | detail text changed |
| TR-14 (Minor) | `c06.ts` header, this file and `ISSUES.md` corrected; the C06 double gap names its owner (S-RATE) | n/a |
| TR-15 (Minor) | `P4-S57 B13` renamed `C06 CT-L5 B13`; P4-S57 stays with MONEY-I27 | n/a |
| TR-16 (Minor) | M23 mode `own` asserted in `P4-S116`; cost-line amendment of amount 0 and downward `re_rate` with cause supplier in CT-L1. The own-mode fraction in `P4-S37` is open | M23 mode, `templates.ts` 104, 124 |

Observation (not a finding of review 71): on an in-batch D2 refusal the ledger reports `ledgerPostedTotal`,
`ledgerLastSeq` and `ledgerPosition` of the earlier sequence in the same refused batch, not of the posted state.
The TR-6 test does not assert these fields. To be decided by the C06 owner.

### Changes outside the slice (MONEY-I3)

1. `contracts/suites/test/contract.c06.test.ts`: the C06 PENDING real-provider entry (MONEY-I3) is replaced by an
   export check. The real ledger runs `runC06ProviderSuite` and `runC06ReservationSuite` in
   `money/test/contract.c06.test.ts`.
2. `contracts/suites/ISSUES.md`: CS-9 (new), CS-7 (MONEY-I3 state), the C06 row removed from "Known provider
   gaps", and a C06 row in "Known double gaps" (the rate slice's settlement double does not run
   `runC06ReservationSuite`; owner S-RATE, review 71 TR-14).
3. No change in `platform/`.

### Design issues (MONEY-I3)

| # | Where | Conflict | What MONEY-I3 does | Proposed resolution |
|---|---|---|---|---|
| D-13 | C06 §8; RFC-000 §2 (home of a movement) | A usage batch of cost lines only (M12, M13, M23) touches no buyer account. The request alone does not name the home partition of the movement | Settlement names the buyer account it routed by (`PostCall.account`); the movement is in the by-buyer view of the causing buyer, whose balance it does not touch | C06 minor version: name the home account on the posting port |
| D-14 | C06 §8, V63-2; CS-7 | It is not stated if a refused usage batch takes a sequence of the partition log | `refused_batch` is the recorded answer of the `movementRef` (a projection row) and writes no log entry, so it takes no sequence | C06 erratum together with D-6 and CS-7 |
| D-15 | C06 §2; `runC06ProviderSuite` (CS-9) | The suite credits the whole charge to one supplier, but C06 §2 needs a positive commission weight | The subject route has weights 10⁹ : 1, so the commission gets 0 of every suite amount | Contract owner: state the weights of the suite subject, or let the suite build its entries from a split |
| D-16 | C06 §8 (D2: two sequences of one line key in one batch) | When the ledger refuses the second sequence, the refusal reports the earlier sequence's state, with a `ledgerPosition` that was never committed. Found during review 71 fixes; the TR-6 test does not assert these fields | None | Contract owner: state what a D2 refusal reports (no position, or the last committed one) |

D-1 … D-12 (MONEY-I2) are still open.

### Remaining work after MONEY-I3

1. Exit criterion 6: run `usage-measure.test.ts` by hand on a quiet dev cell (with SP4) and record the result.
2. The MONEY-I2 remaining work (watermarks, SP4, transport, cut records MONEY-I26, the catalogue feed
   subscription) is not changed by MONEY-I3. The deviation report is computed; its publication waits for the
   transport.
