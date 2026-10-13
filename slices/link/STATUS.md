# S-LINK status: link schedule owner (`@share/link-owner`)

Plan: [docs/04-delivery/plan/S-LINK.md](../../docs/04-delivery/plan/S-LINK.md). Authority: RFC-001, C02 v1.0.0, C01 v1.

Run: `npm run typecheck:link`, `npm run test:link`, `REQUIRE_DEV_CELL=1 npm run test:link:integration`,
`npm run measure` (wall-clock bounds), `npm run mutation:link` (Stryker).

## Increments

| Increment | State | Scenarios met (owning slice S-LINK) |
|---|---|---|
| S-LINK-I1 Walking skeleton: hold, convert and release on one link | Delivered (`eb7895f`) | P1-S01 … S06, S08 … S10, S13, S14, S37, S77 |
| S-LINK-I2 Counter-offers, request records and the availability query | Built, not committed | P1-S12, S15, S16, S17, S38, S39, S70, S73 |
| S-LINK-I3 Waiting, grants and the waiting port | Built, not committed; manual proofs owed (see S-LINK-I3) | P1-S07, S11, S34 |
| S-LINK-I4 Validity and the rolling horizon | Built, not committed (one manual proof owed) | P1-S18, S19, S20, S21, S22, S23, S74 |
| S-LINK-I5 Yields, claims and waiting marks | Built, not committed | None of P1 (plan §7). Link parts of P2-S15, S19, S58, S59, S60, S87, S88, S97, S118 (plan §8) |

## S-LINK-I2

### What it adds

| Part | Where |
|---|---|
| Tree queries `last_above` ("for ever" or null), `nextKey`; `firstAbove`/`firstAtOrBelow` take the known value at t, so a jump costs one descent (RFC-001 §3.2) | `src/occupancy.ts` |
| Counter-offer: largest rate (0 below `rate_min`), earliest window by run jumps within the horizon of `m0` (POL-09 calendar months), open-ended by `last_above`; per-refusal `counteroffer_steps` and per-batch `counteroffer_batch_steps`; per-batch cache keyed by (start, length, rate, horizon) and the `occ_all` change counter; `fit_ranges` (RFC-001 §4.2) | `src/counteroffer.ts` |
| Policy fields `sellingHorizonMonths`, `counterofferSteps` (512), `counterofferBatchSteps` (4,096) in `Init` | `src/state.ts` |
| `NO_FIT` and `IN_FLIGHT` refusals carry the counter-offer beside `occ_all` (C02 checks (5), (7)) | `src/state.ts` |
| `beginBatch(ts)`: resets the budget and the cache, and removes final records from memory at D + release_grace (journaled). A replay calls it at each new `ts` | `src/state.ts`, `src/owner.ts` |
| Request records: held records stay for the life of the hold; final records leave memory at D + release_grace. The entry that records a final state writes the `link_request` row (row TTL 24 h after D) and carries the record in its payload | `src/state.ts`, `src/owner.ts` |
| Before a batch, the owner reads `link_request` and the named log row for a command whose record has gone (`needsRecall`); a repeat gets the recorded answer, with no entry | `src/owner.ts` |
| C02 `query`, `availability`, `fit_ranges`: reads between batches, routed and fenced, `leaseValid` before the reply, `asOfSeq` | `src/owner.ts` |

### Exit criteria

| # | Criterion | State | Proving tests |
|---|---|---|---|
| 1 | T-04 against the oracle | Met | `T-04 counter-offers equal the per-minute oracle on a dense schedule with …` (3 budget variants × 12 seeds, rollback and decide again); `T-04 counter-offers equal the oracle with the step bound and the batch budget when 50 clients send 4 seeds × 1,500 commands`; the I1 property run now checks every counter-offer too; `T-04 a replay of the log decides as the live batches when the batch budget binds` and `T-04 a replay after a takeover decides as the live batch when the batch budget binds` (equal outcomes on two machines of different speed: the outcome depends on the log, not on time); `T-04 the batch cache is made invalid by a hold between two refusals …`; `T-04 a retry after a takeover returns the recorded counter-offer …`; `T-04 a retry 24 h less 1 min after D returns the recorded counter-offer from link_request`; dev cell: `should give counter-offers, answer query and availability, and answer a repeat from link_request …` |
| 2 | C02 provider test 3, last case | Met | `C02 provider test 3: when the record in memory is gone, link_request answers a repeat of each operation` (unit) and the dev-cell test above |
| 3 | P1-S17 schema check | Met | `P1-S17 a rejection and an availability answer disclose nothing about other buyers (schema check)` |
| 4 | Measurement: 512-step refusal ≤ 1 ms, 4,096-step batch ≤ 5 ms | Met on this machine (p99 0.42 ms and 2.3 ms at 530,000 keys) | `measurement: a refusal at the 512-step bound and a batch at the 4,096-step budget at 530,000 keys` (`npm run measure`) |

The oracle (`MinuteOracle` in `test/support.ts`) has one cell per minute. It finds the earliest window by
brute force and by the jump search over the cells, and throws if they differ. The jump search counts the
steps for the budgets and the cache. A deliberate break (a cache that ignores the change counter; a batch
budget that is not charged) makes the T-04 property tests fail.

Contract suite: `runC02ProviderSuite(…, { i2: true })` adds the counter-offer, `query` and availability
tests. The account link double does not have them yet: a PENDING entry shows it (`contracts/suites/ISSUES.md`).

### Gates (2026-10-13)

First build: `npm run check` green; `REQUIRE_DEV_CELL=1 npm run test:link:integration` 2 pass, twice;
`npm run conformance`: 32 met (was 24), the eight I2 scenarios met, no regression.

After the review 67 fixes (agent run, contract and double based only): `npm run typecheck:link` clean;
`npx eslint slices/link` clean; `npm run test:link` 110 tests, 108 pass, 0 fail, 2 skipped (the two
measurements, `LINK_MEASURE` not set); `npm run test:contracts` 67 pass, 0 fail. Not run by the agent: the
integration tests, `npm run measure`, `npm run check`, Stryker. A person runs them before the merge.

Mutation: the first-build score (98.98 %) is not valid. It counted 656 timeouts on a loaded machine as kills.
Review 67 measured killed-only: `counteroffer.ts` 78.7 %, `state.ts` about 75 %. A new Stryker run on an idle
machine is necessary (`mutate` now also has the I2 parts of `owner.ts`; the command now also runs
`counteroffer*.test.ts`, `property.counteroffer.test.ts` and `contract.c02.test.ts`). Report killed-only.

### Review 67 (test review) findings

| Finding | State | Proving tests or note |
|---|---|---|
| TR-1 (Major) replay batch boundaries | Fixed | `T-04 a replay after a takeover decides as the live batch when the batch budget binds` (two refusal batches; kills O1 and O7 by hand) |
| TR-2 (Major) selling horizon | Fixed | `should limit the earliest window to the selling horizon …`, `should clamp the horizon …`, `should not reuse a cached earliest window when two refusals have other horizons`, `P1-S38 a window that fits only after the selling horizon …` |
| TR-3 (Major) `fit_ranges` bounds | Fixed | `should stop fit_ranges at the step bound …`, `should cut a range at until …`, `should give no range when the schedule is full for ever …` |
| TR-4 (Major) open-ended availability | Fixed | `should answer open-ended availability from the requested start …` |
| TR-5 (Major) owner read error paths | Fixed | `should answer STOPPED to query, availability and fit_ranges …`, `should answer UNAVAILABLE and alert READ_FAILED once …`, `should alert REQUEST_ROW_WITHOUT_RECORD …` (kill O3, O4) |
| TR-6 (Major) no `link_request` read before `D_c` | Fixed | `should not read link_request when new holds arrive before their D_c` (owner), `should read link_request for a hold only when …` (unit) (kill O6) |
| TR-7, TR-8, TR-9, TR-10, TR-11 (Minor) | Fixed | Malformed-query cases (kill O5); prune schedule; `deadline_at` after a later D; second `Init`, `UNKNOWN_LINK`, leg part; batch budget steps left |
| TR-14, TR-15, TR-16 (Minor) | Fixed | `close` on a failed start and `waitFor` with a time limit; busy wait removed, the replay test uses the owner; `owner.ts` in `mutate`, `--test-timeout` on `test:link` |
| TR-12 (Minor) duplicate checks slice / suite | Open | Keep or remove the slice copies: a decision for the reviewer |
| TR-13 (Minor) `C02 availability` is not a C02 test ID | Open | C02 lists provider tests 1 … 9 only. A C02 test ID for the availability query is necessary (contract owner) |

### Design issues found

| Id | Where | Conflict | Proposed resolution |
|---|---|---|---|
| DI-1 | C02 "Link availability query"; RFC-001 §4.2 | `availability` returns the earliest window "within the horizon", but `AvailabilityQuery` has no receipt minute `m0`, and the horizon is defined from `m0` (§2) | The link uses its present minute. C02 minor version: add `receiptMinute` to `AvailabilityQuery`, or state "from the link's present minute" |
| DI-2 | RFC-001 §4.2 cache | The cache key is (window start, length, rate). The horizon H depends on `m0`, so two requests with the same key and other receipt minutes can need other answers | The key also has H. RFC-001 erratum |
| DI-3 | C02 availability query errors | No error for a malformed question (rate not an integer, `end ≤ start`, `k < 1`) | The link answers `UNAVAILABLE` and alerts `INVALID_QUERY`. C02 minor version: an `INVALID` error for the queries |
| DI-4 | RFC-001 §4.2 estimates | 512 jumps "about 1 ms" and 4,096 jumps "about 5 ms" do not agree (4,096 = 8 × 512) | Measured 0.42 ms and 2.3 ms: both bounds hold. State the cost per jump in the RFC |
| DI-5 | RFC-001 §4.4, §7.1 `link_request` | The row names "the log sequence of the final record". A repeat after a refusal then a release, or after a conversion, needs the hold digest and the refusal with its counter-offer, which that one entry does not hold | The entry that records a final state carries the request record in its (sealed) payload. RFC-001 erratum |
| DI-6 | C01 §3.1 `readLog` (CS-2) | `readLog(partition, fromSeq)` has no upper bound, so the read of one named row reads the log tail from that row | C01 v1.1: `readLog(partition, fromSeq, toSeq)` |
| DI-7 | RFC-001 §4.4 | To keep reads off the hold path, the link reads `link_request` for a hold only near or after its `D_c`. A hold with the same identity and a later D (a defect) after the record has gone is held, not `MISMATCH` | Accept (defect path), or the RFC states the rule |
| DI-8 | RFC-001 §3.3 | "Request records … until D + release_grace" does not say what happens to a request that is still held then. I1 dropped it at D + 24 h | A held record stays for the life of its hold. RFC-001 erratum |
| DI-9 | RFC-001 §7.2 step 5 | The `link_request` read is a present-time, high-priority read (`consistentRead('present')`). It can push a batch that writes the same row | Rare (a repeat that races its own final entry). Note in the RFC, or a C01 read mode with normal priority |

### Left for later increments

- Waiting (`WAITING`, `aheadDeadline` in `query`), grants and the waiting port: I3. `wait = true` that must wait still answers `UNAVAILABLE`.
- Validity V4 … V6 and the `Policy` entry: I4 (done, see the S-LINK-I4 section).
- `query` fields `displacedBy`, `openYieldClaims`: I5, I11.
- The `link_request` row TTL is declared and created (`ttl_expiration_expression`); its removal is not tested (the database job runs hourly).
- The prune scan is linear in the records in memory, and runs only when the earliest due record is due (`nextPruneAt`). A heap by expiry is for SP4/I16.
- The account link double has no I2 part (account slice).

## S-LINK-I3

### What it adds

| Part | Where |
|---|---|
| `hold` check (8): `wait = true` that only capacity in flight blocks registers a waiter at attempt 1 and answers `WAITING(1, aheadDeadline)`, the latest D of the blockers. No yields (I5). The waiter holds nothing and reserves nothing (POL-05) | `src/state.ts` |
| Waiters in priority order: `request_age`, ties by request identity (`comparePriority`); a sorted key list with journaled insert and remove | `src/state.ts` |
| The scan (RFC-001 §4.3) in each release of a hold and each conversion, over the waiters that overlap the range, in priority order: skip at or after `D_c`; `WAITER_REFUSED(NO_FIT, counterOffer)` with a tombstone if no fit on `occ_firm`; `GRANTED` at the same attempt if fit on `occ_all`; else a new `WAITING_NOTICE` if the latest blocker changed | `src/state.ts` |
| Policy field `scanSteps` (1,024). A scan that the budget stops is pending (`scanCursor`); `tick` continues it. The owner writes `Tick` entries in the same batch, before the next command | `src/state.ts`, `src/owner.ts` |
| Request record state `WAITING` (kept for the life of the waiter). A repeat of the hold gets the present recorded state (`WAITING` with the last notified deadline, then `HELD(1)` after a grant, or the waiter refusal). `query` answers `WAITING` with attempt and `aheadDeadline`. `convert` of a waiter answers `NO_HOLD` (alerted) | `src/state.ts` |
| Notices: each entry logs its notices (`notices`) and the final records of the waiters that its scan refused (`records`); the scan's refusal writes the `link_request` row of the waiter; the recall reads that record from the entry. A replay compares the notices too | `src/owner.ts` |
| Waiting-port notifications: C01 notification rows in the batch (`DecideResult.notifications`, relayed by the runtime), and the push after commit (`onNotify`, after `leaseValid`). Body: the C02 `WaitingNotification` with the link stamp of the entry | `src/owner.ts`, `src/c02.ts` |

### Exit criteria

| # | Criterion | State | Proving tests |
|---|---|---|---|
| 1 | T-07 (no yield parts) | Met (double and in-memory runtime core). Dev cell: written, not run (manual proof owed) | `P1-S07 …`, `P1-S11 …`, `P1-S34 …`; `T-07 released capacity goes to the oldest waiter …`, `T-07 waiters with the same request_age …`, `T-07 a younger waiter that fits …`, `T-07 wait = false is refused IN_FLIGHT …`, `T-07 a waiter is refused NO_FIT … when the request ahead converts` (also the recall from `link_request`), `T-07 a waiter at or after its D_c is skipped …`, `T-07 a waiter one millisecond before its D_c is granted`, `T-07 scan budget: Tick continuations complete the scan before the next command …`, `T-07 the scan counts only the waiters that overlap …`, `T-07 a release of a waiter …`, `T-07 a repeat of a waiting hold …`, `T-07 a waiter whose latest blocker changes …`, `T-07 … open-ended …`; `should replay waiters, grants and Tick continuations … after a takeover`; dev cell: `test/integration/link-i3-crdb.test.ts` |
| 2 | T-08b | Met at the C02 boundary (consumer stub with the C02 rules). The Kafka relay on the dev cell: manual proof owed (the integration test checks the outbox rows and the push, not Kafka) | `C02 provider test 13 / T-08b a GRANTED lost on the push and relayed after a newer WAITING_NOTICE …`, `T-08b query restores a lost notice …` |
| 3 | C02 provider tests 1 (`WAITING`), 4 (a grant keeps the attempt), 13 (first two items) | Met | Suite `runC02ProviderSuite(…, { i2: true, i3: true })`: `C02 1 … WAITING(1, aheadDeadline …)`, `C02 4 … a grant keeps the attempt …`, `C02 13 … GRANTED is relayed …`; at the owner: `C02 provider test 13 the identity and the content are the same on the relay and on the push`, `C02 provider test 1: wait = true … WAITING(1) …` |
| 4 | I1 property test with `wait = true` and waiters, against the oracle extended with POL-05 waiting | Met | `T-07 the P1-N1 properties and the POL-05 waiting oracle hold when 50 clients send 6 seeds × 1,500 commands …`, `T-07 the waiting oracle holds when the scan budget binds (scan_steps 1) …`, `should keep the P1-N1 properties and the waiting oracle on the real C01 runtime core …` |
| 5 | Measurement: scan of 1,024 waiters ≤ 1 ms; flash crowd of 7,500 waiters in ≤ 8 continuations (≈ 8 ms) | Step count: met (the release entry and 7 Ticks, one batch). Wall-clock: written, not run (manual proof owed) | `should complete the scan of a flash crowd of 7,500 waiters in the release entry and 7 Tick continuations, in one batch`; `measurement: a scan of 1,024 waiters and a flash crowd of 7,500 waiters in 8 scan parts` (`npm run measure`) |

The oracle (`MinuteOracle`) keeps its own waiter list in priority order (`oraclePriority`, written apart from
`comparePriority`) and scans with no step budget: the `Tick` continuations are in the same batch before the next
command, so the result is the same. The property run compares every notice of the log, in order, with the
oracle's, and checks P1-N1 after each grant from the log rows alone. Deliberate breaks, run once: a grant check
with `C_ref + 1`, and a reversed priority comparator. Each makes the three property tests and the T-07 order
tests fail.

I1 test changed: `C02 provider test 1: wait = true where it would wait answers UNAVAILABLE in I1 …` asserted the
I1 placeholder (S-LINK plan §1 rule 1). I3 replaces that behaviour, so the test now asserts `WAITING(1, D)` and one
`Hold` entry.

### Gates (2026-10-13, agent run, contract and double based only)

`npm run typecheck:link` clean; `npm run typecheck:contracts` clean; `npx eslint slices/link contracts` clean;
`npm run test:link` 139 tests, 136 pass, 0 fail, 3 skipped (the three measurements, `LINK_MEASURE` not set);
`npm run test:contracts` 81 tests, 78 pass, 0 fail, 3 todo (PENDING entries). Not run by the agent: the
integration tests (`link-i3-crdb.test.ts`: written, not run), `npm run measure`, `npm run check`, Stryker.
A person runs them before the merge.

### Review 70 (test review) findings

Each listed mutant was checked by hand (edit, `npm run -s test:link`, restore; `git diff slices/link/src` is empty).

| Finding | State | Proving tests or note |
|---|---|---|
| TR-1 (Major) decide restart with notices and `Tick` entries | Fixed | `should send each notice once when decide restarts in a batch that grants waiters and writes Tick entries` (`scanSteps: 1`, two waiters, `scriptRestarts(2)`; exact relayed notices, push = relay, `[Release, Tick]`, no scan pending). Kills M2 (`owner.ts:401` without `notifications = []`) |
| TR-2 (Major) replay notice comparison | Fixed | `should stop the link (OUTCOME_MISMATCH_ON_REPLAY) when a recorded notice changed on rebuild` (one alert, the next hold gets `STOPPED`). Kills M3 (`owner.ts:583` notice comparison → `false`) |
| TR-3 (Major) request-sequence tie of the priority order | Fixed | `T-07 waiters with the same request_age and the same account are granted in the order of their request sequence`. The I3 property run (`waitShare` > 0) now gives 30 % of the holds the `request_age` of the client's last hold, so equal ages occur (the I1 run is unchanged). M6 (`state.ts:747` reversed) is killed by the unit test and by two property tests |
| TR-4 (Major) Stryker configuration | Fixed | `tools/mutation/link.stryker.json`: `mutate` has the I3 ranges of `state.ts` (records, waiters, scan, `tick`, `comparePriority`, `isLive`, `overlaps`) and `owner.ts` (ports and recall, `recallFor`, the `decide` closure with `effects` and the `Tick` loop, `push`, `notification`, rebuild and replay, `requestRow`). The command also runs `waiting.test.ts` and `property.waiting.test.ts`. Stryker not run (a person runs it; report killed-only) |
| TR-5 (Minor) C02 provider test 13 item 1 has no C02 test ID | Fixed | The slice test is now `C02 provider test 13 / T-08b a GRANTED lost on the push …`. The shared suite still has item 2 only |
| TR-6 (Minor) repeat of a waiting hold after D + 24 h | Fixed | `should answer a repeat of a waiting hold with the recorded WAITING after D + 24 h, and keep one waiter`. Kills `state.ts:643` `!isLive(rec)` → `rec.state !== 'HELD'` |
| TR-7 (Minor) duplicate checks slice / suite | Open | Same decision as review 67 TR-12: a decision for the reviewer |
| TR-8 (Minor) no new `WAITING_NOTICE` when the latest blocker does not change | Fixed | `T-07 a waiter whose latest blocker does not change gets no new WAITING_NOTICE` (no relay, no push, no logged notice). Kills `state.ts:527` without the guard (also the three property tests) |

Gates after the fixes: `npm run -s typecheck:link`, `typecheck:contracts` and `npx eslint slices/link contracts` clean;
`npm run -s test:link` 144 tests, 141 pass, 0 fail, 3 skipped (measurements); `npm run -s test:contracts` 81 tests,
78 pass, 0 fail, 3 todo.

### Design issues found

| Id | Where | Conflict | Proposed resolution |
|---|---|---|---|
| DI-10 | C01 §2.3 notification rows; C02 "Link waiting port" | The runtime writes a notification row `ifAbsent` by (subject, attempt, kind). C02 sends a `WAITING_NOTICE` again with new content under the same C02 identity (highest `linkSeq` wins), so the outbox keeps only the first copy | The link puts the log sequence in the C01 subject of a `WAITING_NOTICE` only. The C02 identity stays in the body. C01 or C02 note: the C01 id of a state message that changes content includes the sequence |
| DI-11 | RFC-001 §4.3 scan | The scan sets a waiter's notice when it examines it. A younger waiter granted later in the same scan (or a new hold at check (6), or a grant outside the range) can become a later blocker, so the notified deadline can be too early until the next scan or `query` | Accept (the 5 s `query` reconcile and the next scan correct it), or the RFC computes the notices after the grants of the scan |
| DI-12 | C02 `convert`; RFC-001 §4.4 | No reply is stated for a `convert` of a request that waits (it holds nothing) | The link answers `NO_HOLD` and alerts. C02 note |
| DI-13 | RFC-001 §4.3, §7.4 | `scan_steps` is "an algorithm constant", but a replay needs the value of the log | `scanSteps` is in the policy of `Init` now; the `Policy` entry (I4) carries it |

### Left for later increments

- Yields, claims, `mark_waiting` (I5); `openYieldClaims` in `query` (I5); `DISPLACED` (I11).
- Expiry requests for waiters after D (I8). A waiter after `D_c` stays registered until its account owner releases it.
- The gRPC push transport: `onNotify` is the hook.
- Scans after capacity rises (restoration, increase, offer release, leg changes): with those entries (I6, I12 … I15).
- The scan copies the waiter keys of the range; an interval index of waiters is for SP4/I16.
- The account link double has no I2 and no I3 part (account slice).

## S-LINK-I4

### What it adds

| Part | Where |
|---|---|
| Validity V1 … V6 against the receipt minute `m0` that the hold carries, never against `ts`; the horizon H in calendar months in UTC with the month-end clamp (`horizonMinute`); the first rule that fails is the reason (C02 `hold` check (4), RFC-001 §2) | `src/state.ts` (`invalidRule`) |
| `Policy(version, parameters)` entry from the deployment command `deployPolicy` (RFC-001 §7.3). The link keeps every version. A newer version gives the link parameters from its entry on; an older version deployed later is kept, but does not become current. A repeat with the same parameters writes nothing; other parameters give `MISMATCH` (alert `POLICY_MISMATCH`); a malformed policy gives `INVALID_POLICY` (alerted). Replay applies the Policy entries again | `src/state.ts` (`applyPolicy`), `src/owner.ts` (`deployPolicy`, replay) |
| A hold with a policy version that the link has not applied gets `UNAVAILABLE` and writes no entry and no record (RFC-001 §2). The check comes after check (3) and before check (4) | `src/state.ts` |
| `rate_min` and `selling_horizon` (validity and the counter-offer horizon) come from the version that the hold carries. `release_grace`, the record TTL and the counter-offer step bounds come from the current version | `src/state.ts` |
| Contract suite: `runC02ProviderSuite(…, { i4: true })` adds C02 provider test 1 for check (4): V1 … V6 against `m0`, and the P1-S74 calendar cases on the carried receipt minute. The account link double has a PENDING entry (`contracts/suites/ISSUES.md`, "Known double gaps") | `contracts/suites/src/c02.ts` |
| Oracle: `MinuteOracle` judges V1 … V6 (`oracleInvalid`, apart from the link's code) and the policy version | `test/support.ts` |

### Exit criteria

| # | Criterion | State | Proving tests |
|---|---|---|---|
| 1 | T-05 and T-06 pass | Met | T-05: `T-05 validity V1 … V6 equals the oracle at calendar edges for 8 seeds × 4,000 holds` (property: month ends, 29 February, horizons of 1 … 24 months, windows at the edges of m0 and H, the hold up to 90 s after receipt); `T-05 a hold that reaches the link one minute boundary after receipt …`; `T-05 a request received at hh:mm:59.98 whose intake commits after the boundary is valid from hh:mm`; `T-05 the rules are checked in the order V1 … V6 …`; `T-05 a receipt minute that is not a whole minute fails V4`; `T-05 a refusal for no fit is decided only after validity …`; `T-05 a refusal at ts ≥ D_c comes before validity`. T-06: `T-06 as the horizon rolls by days and months, every decision equals the oracle and no sale takes an open-ended reservation's minutes (4 seeds × 300 commands)` (property, rolls up to 200 days, against `MinuteOracle`); `T-06 as ts advances by days and months, no new sale takes an open-ended reservation's minutes` |
| 2 | C02 provider test 1 (V1 … V6 with the calendar cases of P1-S74) | Met | `C02 1 [real link owner] hold: V1 … V6 against m0 give REFUSED(INVALID(rule)) …`; `C02 1 [real link owner] hold: the horizon is calendar months in UTC from the carried receipt minute m0 …` |
| 3 | A hold with an unapplied policy version gets `UNAVAILABLE` and the log has no entry for it | Met on the runtime double and the C01 runtime core; on the dev cell: written, not run (manual proof owed) | `should answer UNAVAILABLE and write no log entry when a hold carries a policy version that the link has not applied`; `should answer UNAVAILABLE in a batch with other holds and write entries for the other holds only`; the property runs below (on the double and on `CockroachOwnerRuntime` with the memory store). Dev cell: `test/integration/link-i4-crdb.test.ts` `should write Policy entries, judge holds by their policy version and receipt minute, and rebuild them when run on the real runtime on the dev cell` — **written, not run (manual proof owed)** |
| 4 | The I1 property test runs with invalid requests mixed in; each gets `INVALID` and a tombstone | Met | `should keep the P1-N1 properties when 50 clients send 8 seeds × 2,000 …` now mixes in 10 % holds that break V1 … V6 or carry an unapplied version; each outcome equals the oracle, each `INVALID` entry records a tombstone until D + release_grace (check (5) of `test/property.ts`), and every rule and `UNAVAILABLE` occur |

Scenario tests: `P1-S18 …` (insufficient funds, failed, invalid), `P1-S19 …` (the 11 rows), `P1-S20 …` (3 rows),
`P1-S21 …`, `P1-S22 …`, `P1-S23 …`, `P1-S74 …` (4 rows). Policy entry tests: `should write one Policy entry …`,
`should give the counter-offer within the horizon of the policy version that the hold carries`, `should keep every
applied version …`, `should answer a repeated deployment …`, `should refuse a deployment of an applied version
with other parameters …`, `should refuse a malformed policy …`, `should answer UNKNOWN_LINK to a deployment …`,
`should rebuild every policy version by replay of the Policy entries, with no outcome difference`.

Deliberate breaks (shown once, then reverted): V6 as `e > H + 1` makes the T-05 property, the P1-S74 tests,
the C02 P1-S74 suite case and two other tests fail. A no-fit check that reads `occ_firm` only for one day after
`m0` makes the T-06 property and the I1/I2 property runs fail.

### Changes to earlier tests (test data only; no assertion removed)

- `test/counteroffer.unit.test.ts` `holdAt`: the receipt minute is the window start (minute 1000). The old receipt
  minute (2026) made the 1970 window invalid (V4).
- `test/property.ts`: 10 % of the holds break a rule (exit criterion 4); the log check skips `policy` entries.
- `test/property.test.ts`: the run on the C01 runtime core (real clock) starts its windows at its present minute;
  the old base (2 March 2026) made every hold invalid (V4). The double run adds the coverage of V1 … V6 and
  `UNAVAILABLE`.
- `test/integration/link-crdb.test.ts` (I1, dev cell): the windows start at the present minute for the same
  reason. Not run by the agent.
- `test/support.ts`: `harness({ startMs })`, `HoldArgs.policyVersion`, and the oracle above.

### Gates (2026-10-13, agent run, contract and double based only)

`npm run typecheck:link` clean; `npm run typecheck:contracts` clean; `npx eslint slices/link contracts` clean;
`npm run test:link` 155 tests, 153 pass, 0 fail, 2 skipped (the two measurements, `LINK_MEASURE` not set);
`npm run test:contracts` 81 tests, 77 pass, 0 fail, 4 todo (the PENDING entries, now with the account link
double's I4 part). Not run by the agent: the integration tests (`link-crdb`, `link-i2-crdb`, `link-i4-crdb`),
`npm run measure`, `npm run check`, Stryker. A person runs them before the merge.

### Review 69 (test review) findings

| Finding | State | Proving tests or note |
|---|---|---|
| TR-1 (Major) stale Stryker config | Fixed | `tools/mutation/link.stryker.json`: ranges at the current lines (`state.ts:197-528` with `init` and `applyPolicy`, `state.ts:553-600` with `atOrAfterMs`, `invalidRule`, `wellFormedPolicy`; `owner.ts` ranges moved, `deployPolicy` added). The command runs `validity`, `horizon` and `property.validity`. Stryker not run |
| TR-2 (Major) counter-offer `rate_min` from the hold's version | Fixed | `should give the counter-offer largest rate by rate_min of the policy version that the hold carries` (kills `state.ts:392` → `this.policy.rateMinMbps`, by hand) |
| TR-3 (Major) C02 I4 part: tombstone and nothing held | Fixed | `C02 1 … V1 … V6 … hold nothing`: a query after each refusal (tombstone), and the full capacity is `HELD` beside the invalid holds. Kills by hand: an invalid refusal with no record, and a V6 refusal that holds capacity |
| TR-4 (Major) `wellFormedPolicy` lower bounds | Fixed | `should apply a policy with every parameter at its lower bound`; `counterofferBatchSteps: 0`, `requestRecordTtlMs: 0` in the `INVALID_POLICY` list (kill `releaseGraceMs ≥ 1`, `counterofferBatchSteps ≥ 0`, `requestRecordTtlMs ≥ 0`, by hand) |
| TR-5 (Minor) exact outcome of a valid hold | Fixed | `T-05 validity … 8 seeds × 4,000 holds`: `HELD` if rate ≤ 10, else `NO_FIT` |
| TR-6 (Minor) `UNKNOWN_LINK` deployment must-not | Fixed | `should answer UNKNOWN_LINK … and write and alert nothing` |
| TR-7 (Minor) place of the `UNAVAILABLE` check | Fixed | `should refuse DEADLINE_PASSED before UNAVAILABLE …`, `should answer MISMATCH, not UNAVAILABLE, …` (the mutant "above (3)" is killed by name) |
| TR-8 (Minor) cheap mutants | Fixed | `should compare policy versions as numbers …`, `should keep the deployed policy when the caller changes its object …`, `should record the reply to a deployment as policy:<link>`, version `5` (a number) in the `INVALID_POLICY` list. Each mutant killed by hand |
| TR-9 (Minor) H out of the date range | Fixed | `T-05 a receipt minute beyond the date range fails V5` (kills `!(start < h)` → `start >= h`, by hand) |
| TR-10 (Minor) `waitFor` polls; `close` in `finally` | Open | Integration test only (dev cell). The I1 file has the same pattern. A change for both files together |
| TR-11 (Minor) V1 … V6 rows checked twice | Open | Kept: the scenario rows also check must-not (no hold, `occAll` empty, tombstone). The same decision as review 67 TR-12 |

Gates after review 69: `npm run test:link` 163 tests, 161 pass, 0 fail, 2 skipped; `npm run test:contracts`
81 tests, 77 pass, 0 fail, 4 todo; `typecheck:link`, `typecheck:contracts`, `npx eslint slices/link contracts` clean.

### Merge with S-LINK-I3 (rebase on `7ff0d10`)

I3 and I4 were built in parallel. The rebase of I4 on I3 keeps the behaviour of both increments:

- **Check order on the hold path.** A hold with `wait = true` gets the `UNAVAILABLE` check (DI-18) and check (4)
  (V1 … V6) before check (8). A hold that breaks a rule is refused `INVALID(rule)` with a tombstone and does not
  wait. RFC-001 §4.1 and C02 give this order ((4) before (8)), so this is not a new design issue. Tests:
  `T-05 a hold with wait = true that breaks a rule is refused INVALID(rule) at check (4) and does not wait (check (8))`;
  `should answer UNAVAILABLE to a hold with wait = true that carries an unapplied version, and register no waiter`.
- **A waiter refused for no fit in a scan** gets the counter-offer by `rate_min` and `selling_horizon` of the policy
  version that the waiter carries (DI-17). The link keeps every version (DI-15), so that version is always there.
  Test: `should give a waiter refused for no fit the counter-offer by rate_min of the policy version that it carries`.
- **`scanSteps`** (I3) is a policy parameter. A `Policy` entry carries it (I3 DI-13); `wellFormedPolicy` refuses
  `scanSteps` < 1 (`INVALID_POLICY`). It is a step bound, so it comes from the current version (DI-17).
- **Property harness.** `propertyRun` keeps I3's `wait = true` share with equal `request_age` ties and I4's 10 %
  invalid holds together. An invalid hold with `wait = true` must be refused `INVALID(rule)`, as the oracle says.
- **Earlier test changed (test data only, no assertion removed).** `test/property.waiting.test.ts`, the run on the
  C01 runtime core: the windows start at the core's present minute (real clock), for the same reason as the I4
  change in `test/property.test.ts` (else every hold is V4-invalid and no notice occurs).
- **Design issue numbers.** I3 has DI-10 … DI-13. The I4 design issues are DI-14 … DI-20 (were DI-10 … DI-16 before
  the rebase; review 69 and the code comments use the new numbers).
- **Stryker** (`tools/mutation/link.stryker.json`, not run): the union of the I3 and I4 ranges at the merged lines
  (`state.ts:234-729`, `state.ts:760-826`; `owner.ts:153-236`, `253-260`, `388-395`, `410-463`, `543-560`,
  `568-610`, `642-656`). The command runs the I3 tests (`waiting`, `property.waiting`) and the I4 tests (`validity`,
  `horizon`, `property.validity`).

Gates after the rebase (2026-10-13, agent run): `npm run -s typecheck:link`, `typecheck:contracts` and
`npx eslint slices/link contracts` clean; `npm run -s test:link` 200 tests, 197 pass, 0 fail, 3 skipped (the
measurements); `npm run -s test:contracts` 84 tests, 80 pass, 0 fail, 4 todo (PENDING entries).

### Design issues found

| Id | Where | Conflict | Proposed resolution |
|---|---|---|---|
| DI-14 | RFC-001 §7.3 `Policy` "from configuration deployment" | No contract names the deployment command: its sender, envelope, authority and reply | I4 has `LinkOwner.deployPolicy(link, policy)`, with no envelope (as the `Init` fixture). A contract (C01 or a configuration contract) for the command |
| DI-15 | RFC-001 §2 "keeps every version that a live request can carry" | No rule says when a version can go | I4 keeps every version (a few per year). RFC-001: a version can go when it is superseded and the longest deadline plus the record TTL has passed |
| DI-16 | C02 `HoldCmd.receiptMinute`; RFC-001 §2 | No rule for a receipt minute that is not a whole minute | The link answers `INVALID(V4)` (`s ≥ m0` cannot be shown). C02 erratum: `Minute` is an integer, or name the rule |
| DI-17 | RFC-001 §2, §7.3 | "Parameters and algorithm version from this position" does not say which parameters come from the hold's version and which from the current `Policy` entry | `rate_min` and `selling_horizon` (validity and the counter-offer horizon H) from the hold's version; `release_grace`, the record TTL and the step bounds from the current version. RFC-001 erratum |
| DI-18 | RFC-001 §2, §4.1 | The `UNAVAILABLE` for an unapplied version has no place in the order of the checks | After check (3) (`D_c` needs no policy), before check (4). RFC-001 erratum |
| DI-19 | RFC-001 §7.3 | A version deployed after a newer one is not described | Kept for the holds that carry it; it does not become the current policy. RFC-001 erratum |
| DI-20 | C02 link availability query | `AvailabilityQuery` has no policy version (as DI-1 has no `m0`) | The link uses its current policy for H. Part of the C02 minor version of DI-1 |

## S-LINK-I5

### What it adds

| Part | Where |
|---|---|
| C02 types: `ClaimSeq`, `MarkWaitingCmd`/`MarkWaitingReply`, `YieldAnswerCmd`/`AcceptReply`, the `YIELD_REQUEST` notification, `QueryState.openYieldClaims`; the commands `mark_waiting` and `yield` in `LinkCommand` | `src/c02.ts` |
| `mark_waiting`: applied only above the last applied position of the request (`IGNORED_OLDER`, no entry, otherwise). The mark is in the request record. A mark that is set checks again, in its entry, each older waiter that the holder attempt blocks and that has no open request on it (P2-S118). A cleared mark ends no claim | `src/state.ts` (`markWaiting`) |
| `request_yields(w)` (RFC-001 §4.3): the candidates are the younger holders with the mark that overlap a conflict range of w. The link asks them only if their capacity and the free capacity let w fit (`yieldsSuffice`: the window is cut where the sum of the holders changes; no change to `occ_all`). One claim for each raising entry, identified by its sequence (`ClaimSeq`), over the conflict ranges of w at that time; one request on a holder attempt for each entry (DI-21). It runs at `hold` check (8), in the scan for a waiter that is still blocked (before its waiting notice), on a mark, and on a refusal with the mark set. Not for a waiter at or after its `D_c` (DI-26) | `src/state.ts` (`requestYields`) |
| The claim check of the scan: a waiter younger than an older waiter with a live claim whose ranges overlap its window is not granted (after the no-fit check, before the grant). A claim reserves nothing against new holds (POL-05) | `src/state.ts` (`insideOlderClaim`, `examine`) |
| `yield_accept`: removes the pulse, registers the holder as a waiter at attempt + 1 with the same command (same age and window, P2-S97), ends every other claim on the old attempt, and scans the freed range. The accepted claim stays live until its waiter ends (DI-23). Reply `ACCEPTED(newWaiterAttempt)` | `src/state.ts` (`yieldAnswer`) |
| `yield_refuse`: ends only its claim (all its requests); a new claim at once if the holder's mark is set and the older waiter is still blocked by that attempt (C02 review 54 M3). Reply `REFUSED_RECORDED` | `src/state.ts` |
| Each answer is recorded in the request record by (attempt, claim, kind): a repeat gets the recorded reply and its link sequence. An attempt or a claim that is not open gets `STALE_ATTEMPT` and writes nothing | `src/state.ts` |
| The end of claims: a waiter that is granted, refused or released ends its claims; `convert` and `release` of a holder end every claim with a request on that attempt (the whole claim, DI-24) | `src/state.ts` |
| `query` shows `openYieldClaims` (claim, older request) of the present hold attempt, by claim | `src/state.ts` |
| Owner: `markWaiting`, `yieldAnswer` (entries `MarkWaiting`, `YieldAccept`, `YieldRefuse`; identities `mark:<request>:<position>`, `<answer>:<request>:<attempt>:<claim>`). A `YIELD_REQUEST` is a notice (outbox row and push); its C01 subject has the claim. Re-send of each open request with the same claim and content, every `yieldResendMs` (1 s), from a C01 timer of the link (`onTimer`, `YIELD_RESEND_TIMER`); armed after each committed batch and after a rebuild (C02 `onAdopt`), cancelled when no request is open and in `onMovedOut` (DI-25) | `src/owner.ts` |
| Contract suite: `runC02ProviderSuite(…, { i5: true })` adds provider test 4 (yield parts) and provider test 5. The account link double has a PENDING entry (`contracts/suites/ISSUES.md`, CS-10, CS-11 and "Known double gaps") | `contracts/suites/src/c02.ts` |
| Oracle: `YieldOracle` (per minute, written apart from the link's code) extends `MinuteOracle` through hooks (`other`, `registered`, `claimBlocks`, `blocked`, `waiterEnded`, `holderEnded`) | `test/oracle.yields.ts`, `test/support.ts` |

### Exit criteria

| # | Criterion | State | Proving tests |
|---|---|---|---|
| 1 | T-08 passes | Met (runtime double; the property run also on the C01 runtime core with the memory store). The link part of "`retry_after` across several blockers and legs" is the latest blocker on this link (I1, I3: P1-S70, P2-S61); the other legs are the account owner's | `test/yields.test.ts`: crossings (`P2-S19 joint trace …`, `P2-S118 link part …`), three-cycles (`P2-S87 joint trace …`, `P2-S88 link part …`), no mark (`P2-S58 link part …`, `P2-S59 link part …`), commit fence (`T-08 commit fence …`, `T-08 a waiter one millisecond before its D_c …`), review 17's loop (`T-08 review 17 loop: O needs 6, Y holds 3 and 1 is free …`, `T-08 review 17 loop: with yields sufficient, a yielder is not granted again inside the live claim …`, `T-08 a younger waiter outside the claimed ranges is granted …`, `T-08 a claim reserves nothing against arrivals …`), attempts (`P2-S97 link part …`, `P2-S60 link part …`), claims (`T-08 claims: two older waiters have open claims on one holder attempt; a refusal ends only its claim`, `C02 provider test 5 / T-08 mark, then refusal …`, `C02 provider test 5 / T-08 refusal, then mark …`, `C02 provider test 4 the end of a hold attempt …`, `T-08 a waiter that is granted ends its claim …`), `P2-S15 link part …`; property: `T-08 the P1-N1 properties, the waiting oracle and the yield oracle hold when 50 clients send 6 seeds × 1,500 commands with marks and yield answers; a replay gives the same outcomes and notices`, `should keep the P1-N1 properties and the yield oracle on the real C01 runtime core …`; replay: `should replay marks, claims and yield answers … after a takeover, and re-arm the open yield requests` |
| 2 | C02 provider tests 4 (`yield_accept` replies with attempt + 1; stale attempt or claim gets `STALE_ATTEMPT`; end of an attempt closes its claims and stops their re-sends) and 5 (both orders) | Met | Suite `runC02ProviderSuite(…, { i2: true, i3: true, i4: true, i5: true })`: `C02 4 [real link owner] attempts: yield_accept replies ACCEPTED(attempt + 1) …`, `C02 4 … the end of a hold attempt (convert) closes every claim on it`, `C02 5 … refusal then mark …`, `C02 5 … mark then refusal …`, `C02 5 … yield_refuse(c1) ends only c1`. At the owner: `C02 provider test 4 yield_accept replies with attempt + 1 …`, `C02 provider test 4 the end of a hold attempt (convert) closes every claim on it, and its re-sends stop`, `… (release) …`, `C02 provider test 4 the release of one holder ends the whole claim …`, `C02 provider test 4 yield_accept ends every other claim on the old attempt`, `C02 provider test 5 / T-08 …` (2) |
| 3 | C02 joint traces P2-S19 and P2-S87, orders "refuse, then mark" and "mark, then refuse", against the stub | Met (recorded account-owner stub on two and three links of one owner; the run with the real account owner is at C6, plan §1 rule 4) | `P2-S19 joint trace (mark, then refusal) …`, `P2-S19 joint trace (refusal, then mark) …`, `P2-S87 joint trace (mark, then refusal) …`, `P2-S87 joint trace (refusal, then mark) …` |

No exit criterion of I5 needs the dev cell, so I5 adds no integration test.

The property run (`waitShare` 0.5, `yieldShare` 0.25, windows in the first 600 minutes) compares every outcome and every notice, in order, with `YieldOracle`, and checks from the log rows alone: P1-N1 after each entry (an accepted yield moves the pulse out of `occ_all`); each `YIELD_REQUEST` goes to a holder with the mark, for an older request that waits, with the claim of its entry (P2-S58); a mark entry is `APPLIED`. Over 6 seeds it has about 90 yield requests, with accepts, refusals, stale answers, applied and ignored marks. After each seed a new owner rebuilds the link by replay with no alert (invariant I5) and the same open requests. The I1 … I4 runs are unchanged: every new generator branch is guarded by `yieldShare` > 0, so their random sequences are the same.

Deliberate breaks (each shown once by hand, then reverted; `state.ts` is the same as before): no mark check (42 tests fail, the I1 … I4 property runs too); no claim check in the scan; no sufficiency rule; the accepted yield keeps its pulse; the attempt not incremented; `convert` keeps the claims; no new claim after a refusal with the mark set; `position <` in place of `≤`; `yield_accept` ends no other claim; `release` keeps the holder's claims; a grant keeps the waiter's claims; one request per holder attempt per entry not enforced; no `D_c` check in `request_yields`. Each makes a unit test or the property run fail (the three claim-end breaks first failed only the property run, so their unit tests were made stronger). `comparePriority(h, b) ≥ 0` in place of `> 0` is an equivalent mutant: two different requests never compare equal.

### Changes to earlier code and tests (no assertion removed)

- `src/state.ts`: `ActiveHold.cmd` (the hold command; an accepted yield registers it again). `comparePriority` takes any object with `requestAge` and `request`. Small hooks in `hold` check (8), `examine`, `grant`, `refuseWaiter`, `convert`, `release`, `query`.
- `src/owner.ts`: the entry kind table `ENTRY_OF`; the `YIELD_REQUEST` subject; the re-send timer after commit and rebuild.
- `test/support.ts`: `harness` gives the runtime double `owner.onTimer`. `MinuteOracle`: some members `protected`; `apply(cmd, ts, seq?)`; the attempt of each request (was always 1); the I5 hooks (no effect in `MinuteOracle`); `noticeForm` and `OracleNotice` have `claim` and `olderRequest`.
- `test/property.ts`: `yieldShare`, `yieldRequests`, `spread`; the yield steps; the log checks for `mark_waiting`, `yield` and `YIELD_REQUEST`. With `yieldShare` 0 the run is as before.
- `test/contract.c02.test.ts`: the real link owner registers `{ i5: true }`.
- `tools/mutation/link.stryker.json`: the ranges at the new lines (`state.ts:262-932`, `963-1028`; `owner.ts` ranges moved, and `352-385` (re-send timer) and `673-703` (entry identities, `ENTRY_OF`) added); the command also runs `yields.test.ts` and `property.yields.test.ts`. Stryker not run.

### Gates (2026-10-13, agent run, contract and double based only)

`npm run -s typecheck:link` clean; `npm run -s typecheck:contracts` clean; `npx eslint slices/link contracts` clean;
`npm run -s test:link` 239 tests, 236 pass, 0 fail, 3 skipped (the measurements, `LINK_MEASURE` not set);
`npm run -s test:contracts` 97 tests, 94 pass, 0 fail, 3 todo (PENDING entries). Not run by the agent: the integration
tests, `npm run measure`, `npm run check`, Stryker. A person runs them before the merge.

Environment: this worktree had no `@grpc/grpc-js` (added by S-PLAT I2 to `platform/runtime`), so every test failed at
load and `typecheck:link` reported errors in `platform/runtime/src/standby/grpc.ts`. The agent linked
`node_modules/@grpc` to the installed copy of another worktree (untracked; not a code change). A person runs
`npm ci` in each checkout.

### Design issues found

| Id | Where | Conflict | Proposed resolution |
|---|---|---|---|
| DI-21 | C02 `ClaimSeq`, `YIELD_REQUEST` identity (CS-11) | A claim is the sequence of the entry that raised it. One entry (a scan, a mark that checks several older waiters) can raise claims for more than one waiter. Two requests on one holder attempt from one entry would have the same identity (link, request, attempt, kind, claim) | One entry raises at most one request on a holder attempt, for the first waiter that it checks (priority order). The link keys a claim by (sequence, waiter). C02 note, or a claim identity of (sequence, index) |
| DI-22 | C02 `mark_waiting` (CS-10) | No reply is stated for a mark of a request that has no hold and no waiter at the link (not seen, or final) | `IGNORED_OLDER`, no entry; alert `MARK_WITHOUT_REQUEST` for a request not seen. C02 note |
| DI-23 | RFC-001 §4.3; C02 `yield_accept` | `yield_accept` ends every *other* claim on the attempt, so the accepted claim stays. If its waiter still does not fit (a new hold took the free capacity: a claim reserves nothing), the claim stays live with no open request and keeps younger waiters in its ranges from a grant until its waiter ends | Accept (bounded by the waiter's D), or RFC-001: a claim with no open request ends at the scan of the entry that answered it |
| DI-24 | C02 port invariants "ends every yield claim on that attempt"; RFC-001 §4.3 | For a claim with requests on more than one holder, it is not clear if the end of one holder attempt (`convert`, `release`) ends the requests on the other holders | The whole claim ends (RFC-001: "the claim ends when … the holder's attempt ends"); the scan of the same entry checks the waiter again from the start and can raise a new claim. C02 note |
| DI-25 | C02 "YIELD_REQUEST" re-send; C01 §2.4 hooks | No interval is stated for the re-send of an unanswered request. The C01 timer fires through the runtime option `onTimer`, which `OwnerHooks` does not list | 1 s (est., as the other C02 re-sends), as a push of the same identity and content (not a new outbox row). C02 parameter; C01 note: `onTimer` in `OwnerHooks` (as CS-2) |
| DI-26 | RFC-001 §4.3 `request_yields` | The scan skips a waiter at or after its `D_c`, but `request_yields` from a mark or a refusal has no such rule, so a holder could yield for a request that cannot commit | No yield request for a waiter at or after its `D_c`. RFC-001 erratum |
| DI-27 | RFC-001 §4.3; C02 `AcceptReply` | `ACCEPTED` has no `aheadDeadline`. The yielder's waiting notice comes from the scan, but the scan skips it while it is inside a live claim, so its `aheadDeadline` (and `query`) can be 0 until a later scan | Accept (the 5 s `query` reconcile and the next scan correct it; the blocker is older), or the accept entry sends the yielder's `WAITING_NOTICE` after its scan |

### Left for later increments

- `DISPLACED` and `displacement_accept` (I11), which share the attempt rule and the end of claims.
- Scans and yields after capacity rises (leg changes I6, I12 … I15): they use the same `scan`.
- The account link double has no I5 part (account slice; `contracts/suites/ISSUES.md`).
- The gRPC push transport: `onNotify` is the hook; the re-send uses it.
