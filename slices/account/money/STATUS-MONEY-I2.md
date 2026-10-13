# S-MONEY MONEY-I2 status: ledger and settlement of reservation batches

Plan: [S-ACCT-S-MONEY.md §6 MONEY-I2](../../../docs/04-delivery/plan/S-ACCT-S-MONEY.md). Contracts: C06 v1
§7, §8, §9 (provided), §5 and §2 (consumed); C01 v1. RFC-004 Part B §B1, §B2 (M1, M4), §B3.1, §B3.2.

The work is not committed.

## Package

| Package | Path | Contents |
|---|---|---|
| `@share/money` | `slices/account/money/` | `src/webster.ts`: the Webster split (§B3.2) and the parties of a route. `src/money.ts`: micro-USD strings, the canonical `SourceRef` encoding and its digest. `src/catalogue.ts`: split-weights replica (C06 §2). `src/ledger/`: the ledger owner kind `ledger` (declaration, accounts and principals, the pure decision of one `post`, the owner on the C01 runtime). `src/settlement/`: settlement of reservation batches and its timer scheduler. `testing/`: C06 fixtures (catalogue split weights, CT-R reservation batches with the golden ledger), a manual scheduler and a test world on the runtime double |

The package is in the S-ACCT + S-MONEY slice directory. `test:account`, `typecheck:account` and the
pre-commit hook take it with no change. New scripts: `test:account:integration` (also in `test:integration`),
`mutation:money`, and `MONEY_MEASURE=1 npm run -s test:account:integration` in `npm run measure`.

## Exit criteria

| # | Criterion | Status | Tests |
|---|---|---|---|
| 1 | B13 "Webster property test", with the §B3.2 worked examples | Met | `webster.property.test.ts`: `B13: Webster property test: …` (one-unit-at-a-time oracle, monotone, tie order, legs of one supplier), `P4-S32` (2), `P4-S33`, `P4-S34`. `webster.test.ts`: `P4-S35` (2 rows), `P4-S36`, `P4-S73` (3 rows), `P4-S102` (4 rows), the §B2 worked splits |
| 2 | C06 CT-L1 (reservation rows), CT-L3 (reservation batch), CT-L5, CT-L7, CT-L8, CT-L9 | Met | `ledger.test.ts` (`C06 CT-L1` ×2, `CT-L3` ×2, `CT-L5` ×5, `CT-L7` ×2, `CT-L8` ×2), `settlement.test.ts` (`C06 CT-L9`), `contract.c06.test.ts` (`runC06ReservationSuite` on the real ledger: CT-L1 ×2, CT-L3, CT-L4 (1), CT-L5 ×3, CT-L6) |
| 3 | C06 CT-C1 on the reservation fixtures | Met | `settlement.test.ts` `C06 CT-C1 …` (each batch also sent three times); `integration/ledger-crdb.test.ts` `C06 CT-C1 on the dev cell …` |
| 4 | C01 CC-1 … CC-8 for the ledger kind; the grants job finds no UPDATE or DELETE on the movement table (P4-S29) | Met | `ledger-c01.test.ts` `C01 CC-1` … `CC-8`; `ledger.test.ts` `P4-S29 …`; `integration/ledger-crdb.test.ts` `P4-S29 on the dev cell …` (CP-11 job clean; `SET ROLE ledger` cannot UPDATE or DELETE `ledger_log`) |
| 5 | Two currencies, a line that does not sum to zero and a zero amount are refused and move nothing (P4-S28, P4-S31) | Met | `ledger.test.ts` `P4-S28 …` ×2, `P4-S31 …` ×2, `P4-S71 …`; `ledger.property.test.ts` `P4-S28 every money movement sums to zero …` (random batches, redeliveries, conflicts, top-ups; replay oracle) |
| 6 | Measurement X2-S13, X2-S14 at the SP4 rate on one partition | Not met on the dev cell (X2-S14 part met) | `integration/measure.test.ts` `measurement: …` (`MONEY_MEASURE=1`) |

`accounts.test.ts` has the parser, principal, class and home tests.

Scenarios with a passing test in `test:account`: P4-S28, P4-S29, P4-S31, P4-S32, P4-S33, P4-S34, P4-S35,
P4-S36, P4-S71, P4-S73, P4-S102.

The money property tests fail at once when the code is broken on purpose. This was shown once: a take-back
tie rule changed from "latest" to "earliest" fails three B13 tests; a dropped commission share with the
sum check removed fails the P4-S28 property.

`ledger.property.test.ts` `C06 CT-L5 a line key is charged once …` compares each buyer balance, the party credits and
the posted lines with an oracle of first accepted amounts, over random batches, resends, changed lines and new batch ids.
It fails when the ledger's duplicate, prior-total and sequence checks are removed (a resend is charged again).

## Measurement

Exit criterion 6 is **not met** on the dev cell. `MONEY_MEASURE=1 npm run measure` at the SP4 rate (27
movements/s of 300 lines on one partition) does not complete: batch transactions meet the 2 s statement
timeout (`ledger_line` UPSERTs of 200 rows took 0.6 … 1.5 s; point reads 0.2 … 2 s) and the 1 s
idle-in-transaction timeout ("i/o timeout"), and then the runtime fails a ROLLBACK on the closed connection
("Connection terminated unexpectedly", an S-PLAT error path that is not mapped to `Retry`). Lower loads (3
movements/s of 100 or 300 lines) failed the same way. During the runs the machine load average was 55 … 121
and one CockroachDB node ran at about 165 % CPU, because other agents share the dev cell. One 300-line post
alone commits in about 0.8 s, and the CT-C1 integration test (four batches) passes. The figure for X2-S13 must
come from SP4 on a quiet cluster (D-11, D-12).

X2-S14 ("no answer before the movement is durable") holds by construction and is tested: the ledger answers
only from a `Committed` append (`C01 CC-1`: no answer and no event for every other result); the integration
test checks each answer against `ledger_log`. The dev cell has one region, so `Committed` there is not
two-region durable.

## Mutation testing

`npm run mutation:money` (`tools/mutation/money.stryker.json`) mutates `webster.ts`, `money.ts`,
`ledger/accounts.ts`, `ledger/decide.ts` and `settlement/settlement.ts` (1,657 mutants). On the loaded machine
one test run took 40 s, so the full run was not finished. A scoped run on `webster.ts`, `money.ts` and
`ledger/accounts.ts` (435 mutants) gave a score of 93.56 % (396 killed, 11 timed out, 28 survived: webster.ts 89.19 %, money.ts 92.90 %, accounts.ts 97.04 %). Most survivors in webster.ts change only error texts or are equivalent (the order of the take-back scan). `decide.ts` and `settlement.ts` have no score yet; run `npm run mutation:money` on a quiet machine.

## Changes outside the package

1. `platform/runtime/src/store/pg.ts` (S-PLAT to review). `readRows` reads the rows of one table with BYTES or
   STRING keys in one statement (chunks of 500), and the projection writes of a batch go as multi-row UPSERTs
   (chunks of 200), the last write of a row winning. Before this, a 300-line movement made about 620
   statements and did not commit inside the 2 s abandon bound. Test:
   `platform/runtime/test/integration/cockroach.test.ts` "should read many declared rows …".
2. `contracts/suites`: `runC06ReservationSuite` and `C06_SUITE_WEIGHTS`; the PENDING entry now names MONEY-I3
   (usage batches); `ISSUES.md` CS-6 (answered), CS-7, CS-8.
3. `tools/eslint/plugin.js`: a test title may start with `B13: ` (plan §1 rule 7 names "B13: <name>" as test IDs).
4. Root `package.json`: the workspace and the scripts above. `tools/mutation/money.stryker.json`.

## Design issues

| # | Where | Conflict | What MONEY-I2 does | Proposed resolution |
|---|---|---|---|---|
| D-1 | RFC-004 §B1.3; plan exit (4); C01 §2.3 | RFC-004 names the movement table `ledger_movement`. C01 makes the log table of kind `ledger` `ledger_log` | `ledger_log` is the movement table (one entry for each movement); the grants tests check it | RFC-004 erratum: "`ledger_movement` is the C01 log table `ledger_log`" |
| D-2 | C06 §8; RFC-004 §B1.2; P4-S31 | RFC-004: every entry carries the currency. C06 §8 entries have no currency | Each stored entry is tagged with the movement currency. A request entry may name `currency`; another currency than the movement's is refused `invalid` | C06 minor version: optional `currency` on an entry |
| D-3 | C06 §5 (original `amount ≥ 0`); RFC-004 §B1.2 (non-zero amounts; nil line only M23) | A 0 µ reservation original cannot be posted. If settlement excludes it `invalid`, rating parks it, and `p_r` cannot pass the minute | Settlement excludes it `invalid` with an alert | C06 erratum: a reservation original is > 0 (rating emits no 0 µ line), or a nil M4 line that records the key |
| D-4 | C06 §9 `lines[].amount` | The sign is not stated | Charge lines: the charge (`newTotal − priorTotal`, positive is a debit to the buyer). M1: the buyer credit (as the AM-I1 fixture) | C06 erratum that states the sign for each kind |
| D-5 | C06 §8; RFC-004 §B2 M1 | M1's split `r = min(x, W)` is made at append; the port carries the caller's entries | The caller sends `X −x`, `B +x`; the ledger posts `B +(x − r)` and `SH:repayments +r` | C06 erratum: the M1 request form |
| D-6 | C06 §8 "records the refusal"; V63-2 | Only `refused_batch` and `over_limit` answers are stored with the digest. A stored `invalid`, `principal` or `wrong_home` answer would stop the retry after a fix (D5) | Movement-level refusals are log entries (audit), not the recorded answer. So movement sequences can have gaps (CS-7) | C06 erratum: say which refusals are the recorded answer, and that `sequence` can have gaps |
| D-7 | C06 §9 views; C01 §2.2 stream keys | A view copy has "the same EventId"; C01 gives each stream its own `stream_seq` and keys a stream by an event field | The body `eventId` is the full feed's; each copy has `view_key` (CS-8) | C06 minor version: name `view_key` |
| D-8 | C06 §8 | The ledger has no split weights for a line (its catalogue replica lags). C06 has no answer for this | `refused` `invalid`, not recorded, alert `WEIGHTS_UNKNOWN`; settlement holds and tries again after 30 s | C06: name the case (for example `unavailable`) |
| D-9 | C01 §10.3 errata (R47-10 c); RFC-004 §B3.1 | Posting-port commands carry a `CommandEnvelope` with the sender's (generation, epoch). Settlement is a consumer with a hot standby, not an owner kind, so it has no fence | The ledger checks an envelope when one is given (CC-5). Settlement sends none | RFC-004: give settlement a fence (for example its consumer-group generation), or exempt it |
| D-10 | C06 "Conventions" | Not clear if the `kind` tag has a length prefix in the canonical `SourceRef` | Prefixed, as `@share/rate-common` does; fixed vectors in `money.test.ts` | C06: add a fixed vector |
| D-11 | C01 §3.2 (S-PLAT runtime) | The runtime puts every pending call of a slot in one batch; a `decide` call counts as one entry of no size, so one transaction can carry tens of 300-line movements and pass the 2 s statement timeout and the 1 s idle-in-transaction timeout | The ledger keeps at most `maxAppendsPerSlot` (4) appends in flight for each slot (RFC-004 §B10: "about 1 to 3" movements a batch) | S-PLAT: size a `decide` call by its declared reads, or let the owner give a size |
| D-12 | RFC-004 §B10 (est. 21 KB for a 600-line movement) | The C06 §9 event has every line field, and the views copy it (by buyer, each supplier, each external account) | A 300-line movement is about 380 KB of JSON before sealing (log payload, line rows and five event copies) | SP4: measure; a compact segment layout (R4-B1) and smaller view copies |

## Remaining work

1. Reservation-line watermarks (RFC-000 §4.4, RFC-004 §B1.4, §B10). The ledger keeps one row for each line
   key (`ledger_line`), which is the exception set in its most general form. The compact layout (one
   watermark for each reservation, plus exceptions, and the sealed segments for old lines) waits for SP4
   and for history's ledger segments.
2. SP4 (partition count). The count is a parameter (`partitionCount`, default 128 est.).
3. Usage batches, amendments, fees, cost lines and abandon postings (MONEY-I3). Until then settlement leaves a
   usage batch, or a reservation batch with an `abandon` line, unanswered with an alert, below the low-water
   mark; the ledger refuses other kinds than M1 and M4 `invalid` (not recorded).
4. Transport: the gRPC posting port, the Kafka consumer of `rating.charge-lines.v1` (decryption with the
   feed key) and the direct publisher of `settlement.posting-acks.v1`. Settlement and the ledger take them as
   injected interfaces. The operational alert stream `ledger.alert.v1` (alerts are in memory and a callback).
5. Cut records (MONEY-I26), the deviation report (§B3.5), the ledger's catalogue feed subscription.
6. The rate slice's settlement double does not run `runC06ReservationSuite` yet (S-RATE).
