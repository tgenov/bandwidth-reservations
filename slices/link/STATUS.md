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
- Validity V4 … V6 and the `Policy` entry: I4. The horizon is in `counteroffer.ts` (`horizonMinute`) for I4 to use.
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
| 2 | T-08b | Met at the C02 boundary (consumer stub with the C02 rules). The Kafka relay on the dev cell: manual proof owed (the integration test checks the outbox rows and the push, not Kafka) | `T-08b a GRANTED lost on the push and relayed after a newer WAITING_NOTICE …`, `T-08b query restores a lost notice …` |
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
