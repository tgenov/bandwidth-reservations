# S-ACCT + S-MONEY status

Plan: [S-ACCT-S-MONEY.md](../../docs/04-delivery/plan/S-ACCT-S-MONEY.md). Delivered increments are in
[done.txt](../../docs/04-delivery/plan/done.txt).

## Packages

| Package | Path | Increment | Contents |
|---|---|---|---|
| `@share/account-owner` | `owner/` | AM-I1 | Account owner kind: booking module and funds-and-standing module |
| `@share/booking-api` | `booking-api/` | AM-I1 | Booking API on the edge |
| `@share/money` | `money/` | MONEY-I2 | Ledger owner kind `ledger`, settlement of reservation batches, Webster split. Details: [money/STATUS-MONEY-I2.md](money/STATUS-MONEY-I2.md) |

Run: `npm run -s typecheck:account`, `npm run -s test:account`, `npm run -s test:contracts`. The globs
`slices/account/*/test/*.test.ts` and the `money/**/*.ts` include of `tsconfig.json` take every package.
Integration and measurement (by hand only, dev cell): `npm run test:account:integration`, `npm run measure`.

## Increments

| Increment | State | Notes |
|---|---|---|
| AM-I1 | Done | In `done.txt` |
| MONEY-I2 | Built, not committed. Waits for review and merge | Exit criteria (1) … (5) met in `test:account` and `test:contracts`. Exit criterion (6), the X2-S13 measurement at the SP4 rate, is not met on the shared dev cell (see below) |

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
