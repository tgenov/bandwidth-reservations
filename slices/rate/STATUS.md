# S-RATE status

Plan: [docs/04-delivery/plan/S-RATE.md](../../docs/04-delivery/plan/S-RATE.md). All owners run on the C01
runtime double (`@share/owner-runtime/testing`). Other slices are contract doubles in
`rating-owner/testing/`.

| Package | Path | Contents |
|---|---|---|
| `@share/rate-common` | `common/` | C06 and C11 types, C06 CT-R1 schema checks, canonical `SourceRef`, ELA (RFC-003 §2), time helpers, append policy, feed cursor, alerts |
| `@share/ingestion` | `ingestion/` | Metering ingestion (IPFIX, one exporter, outcome "accepted"), `ingest_log` self-outboxed, hand-off events. Reference exporter in `testing/` |
| `@share/rating-owner` | `rating-owner/` | Catalogue (fixture writes, lead times), attribution stage A and stage B, rating (usage lines, closure, late-traffic amendments by total, late originals, figure, gated usage batches, posting acks). World, bus, account-owner and settlement doubles in `testing/` |

Run: `npm run typecheck:rate`, `npm run test:rate`, `npm run mutation:rate` (by hand; 66.9% after I1; 73.85% for `ela.ts` and `time.ts` in review 66). The `mutate` list now also has `stage-a.ts`, `catalogue/replica.ts` and `rating/owner.ts`; the score of this wider list is not recorded yet. Integration: `npm run test:rate:integration` (by hand, on the dev cell); its one test is a measurement and runs only with `RATE_MEASURE=1` (`npm run measure`).

## Increments

| Increment | State | Scenarios met | Proof |
|---|---|---|---|
| I1 Walking skeleton | Done | P3-S25 | `rating-owner/test/walking-skeleton.test.ts`, `owners.test.ts`, `contract.c06.test.ts` |
| I2 Record identity, deduplication and outcomes | Not started | — | — |
| I3 Spread and exact usage lines | Done (uncommitted); review 66 findings TR-1 … TR-13 fixed | P3-S18, P3-S19, P3-S21, P3-S48, P3-S51, P3-S52 | `rating-owner/test/spread-and-lines.test.ts`, `rating-owner/test/ela.property.test.ts`, `rating-owner/test/owners.test.ts`, `common/test/common.test.ts` |
| I4 Late traffic and amendments by total | Built. Review 73 (test review) findings fixed, except TR-11 (open, Minor). Exit criteria 1 … 6 met on the doubles; 7 written, not run (manual proof owed). SP1 and SP3 not done | P3-S15, P3-S17, P3-S20, P3-S32 (row 1 met, row 2 blocked by spec conflict), P3-S33, P3-S35 | `rating-owner/test/late-traffic.test.ts`, `rating-owner/test/order.property.test.ts`, `rating-owner/test/contract.c06.test.ts`, `rating-owner/test/integration/usage-timeliness.test.ts` (not run) |

### I3 exit criteria

1. The six scenarios pass end to end: exporter → ingestion → stage A → stage B → rating → settlement double.
2. The ELA property test (RFC-003 §9) passes: random records (some with e = s, some longer than
   `flow_active_timeout` + 60 s, bytes up to 2^62), their spreads and negated copies, in a shuffled order,
   against an independent `bigint` rational reference. Every floor is equal at five prices. Crafted sums
   at X = N ± 1/P, with P > 10^18 the product of four primes ≤ 120,000, floor to N and N − 1. Seeds are
   fixed; `RATE_ELA_SEED=<n>` runs one seed again. A failure message names the seed.
   The test fails when `floorDiv` truncates, and when `spread` adds one byte to a part (checked once).
3. C06 CT-R1 vectors pass for lines on two routes (schema checks and the fixed canonical `SourceRef` hex).

What I3 added to I1 code: the stage A alert `FLOW_TOO_LONG` (`flowTooLong`) for a record longer than
`flow_active_timeout` + 60 s, raised only after the stage A entry commits (one alert when the hand-off
comes again). The record is still spread. Rating checks each part of a part batch (C11 Part IV: `num` a
signed integer, `den` a positive integer). A batch with a bad part is not applied, writes no entry and
raises `INVALID_PART` (review 66 TR-6). Spread, the ELA, the line formula, the price of
the line's own minute and one line for each (account, product, route, minute) were in I1 code; I3 adds
their scenario and property tests.

## Design issues (I3)

1. **C11 `ExactBytes.num` is `I64`.** Stage A sends `b × t_m / (e − s)` not reduced (C11 allows this).
   `b` is a U64 octet count and `t_m` is up to 60,000, so `num` can exceed 2^63 − 1. Real flows stay
   far below (100 Gbit/s for 120 s × 60,000 ≈ 9 × 10^16). Proposed: a C11 erratum that `num` is an
   unbounded signed decimal, or that stage A reduces the fraction and a record over the bound is rejected.
2. **RFC-003 §2 ELA size.** "`d ≤ 120,000` and `r_d` fits 32 bits" is true only for records within
   `flow_active_timeout` + 60 s. §4.2 step 2 spreads longer records too, so `d` can be larger. The code
   uses `bigint`, so nothing breaks. Proposed: RFC-003 §2 says "at most 120,000 for conforming records".
3. **Recipient of the long-record alert.** RFC-003 §4.2 says "its exporter is alerted" but names no feed
   or recipient. I3 raises `FLOW_TOO_LONG` (owner `attr_a`, exporter in the detail) on the alert sink.
   Proposed: the C01 alert feed to network operations, with the exporter and its owner.
4. **Usage line of 0 micro-USD.** RFC-003 and C06 do not say if a closed usage line with charge 0
   (P3-S21, 99,999 bytes) is emitted. The ledger refuses zero amounts (C06 "amounts are non-zero").
   Rating closes it with emitted total 0 and sends nothing. I4 must decide how a late amendment of
   such a line is numbered (an original with `seq` 0, or an amendment). Proposed: RFC-003 §5.6 says a
   line closed at 0 is not emitted, and a later non-zero total is its original (`seq` 0).

### I4 exit criteria

| # | Criterion | State | Proof |
|---|---|---|---|
| 1 | The six scenarios pass | Met on the doubles, except P3-S32: row 1 met, row 2 blocked by spec conflict (design issue (I4) 1) | `late-traffic.test.ts` (`P3-S17`, `P3-S20`, `P3-S32` row 1, `P3-S35`; row 2 in `should post a late original at seq 0 when a line closed at 0 gets late traffic (P3-S32 row 2 conflicts with C06 m5)`), `order.property.test.ts` (`P3-S15`, `P3-S33`, 4 seeds each) |
| 2 | Order independence: in order, and shuffled with 30% repeats and 20% after closure, give equal posted totals | Met | `order.property.test.ts`: 24 random records a seed (spread over 12:16 … 12:22 across the 12:20 price change, some with e = s, bytes up to 2^32) through exporter → ingestion → stage A → stage B → rating → settlement double, twice. Each posted line total equals the other run and an independent `bigint` rational reference. Seeds 1, 2, 3, 20261013; `RATE_ORDER_SEED=<n>` runs one seed. Checked once: the test fails when late parts of a closed line are not amended |
| 3 | Closure race: records around the closing entry are each in the original or in an amendment, exactly once | Met on the runtime double | `P3-S17 …`: four records a second from 12:10:05 to 12:10:25 (closing entry at 12:10:15). The original equals the parts in `inputs` entries before the `usage-closed` entry; the amendment the rest; the ledger total all. Checked once: the test fails when amendments ignore `amendment_interval` |
| 4 | Stalled stage A partition: lines close at the bound + 45 s; later records become amendments (R3-6) | Met | `should close the usage lines at the bound + 45 s …`. The close timer is armed again at the hard bound when the margin passes (a fix: before I4 a stalled minute closed only on another input). Checked once: the test fails without the re-arm |
| 5 | An amendment of a line older than `amendment_hot_window` reads the line back | Met (see design issue (I4) 2) | `should read a line closed more than amendment_hot_window …`: the append declares the read of the line row; E and X come from it |
| 6 | P3-S35: the feed carries the original and two amendments with reason and emission time; the settlement double (CT-L7 fixture) shows each posting time | Met | `P3-S35 …`; the ledger double records `reason`, `triggerRef` and the posting time of each movement line |
| 7 | X2-S13: usage line posted ≤ 300 s after the minute's end at steady load (design 258 s) | Written, not run (manual proof owed) | `rating-owner/test/integration/usage-timeliness.test.ts`, `RATE_MEASURE=1 npm run test:rate:integration` on the dev cell. Rating on the real C01 runtime and CockroachDB; the account owner and settlement are stand-ins on a `MemoryBus` |

What I4 added: the closing entry fixes the original (`original` on the line); a part applied after it marks the
line late. Late records of a line give at most one `late_traffic` amendment in `amendment_interval` (60 s), as an
`amendment` entry with the new ELA, `C − E` restating the total, the next sequence, the record identities and the
original's `weightsVersion`; sequence `k + 1` only after `k` is posted, one sequence of a line key in a batch. A
late part for a closed minute with no saved line makes a late original. Closed, fully posted lines leave memory
after `amendment_hot_window` (1 h); an older line is read back from its `rating_usage_line` row. A late part that
would lower a line raises `LATE_TRAFFIC_DOWNWARD` and emits nothing. The `LATE_TRAFFIC_NOT_IN_I1` alert is gone.
The settlement double maps `late_traffic` amendments to M6 (`split(newTotal) − split(priorTotal)`), takes
reservation batches (M4, per-line exclusion, the movement limit) and runs `runC06ReservationSuite` (closes the
`contracts/suites/ISSUES.md` row of review 71 TR-14). Since review 73 (TR-4) M4, M5 and M6 all use the Webster split of
RFC-004 §B3.2, and the ledger double checks each M4, M5 and M6 line against its template and each amendment against
the weights version of its original (C06 §8 check 2, D4).

## Design issues (I4)

1. **A late amendment of a line closed at 0 (P3-S32 second row). P3-S32: row 1 met, row 2 blocked by spec conflict.**
   RFC-003 §5.6/§5.7 (and P3-S32 row 2) conflict with C06 m5: the C06 contract owner must decide
   (`contracts/suites/ISSUES.md` CS-10). The scenario and RFC-003 §5.7 say "an amendment
   of 1 with the reason late traffic". Rating records it so in its `amendment` entry (seq 0, reason `late_traffic`).
   But the ledger has no posting of the line key, and C06 refuses a zero original ("amounts are non-zero") and an
   amendment whose predecessor is not posted (`out_of_sequence`). So on the charge-line feed the line is its late
   original: seq 0, reason `original`, `reasonDetails.trigger = late_traffic` with the record identities, and the
   first record identity in `triggerRef` (C06 m5), posted as M5. This answers design issue (I3) 4 as proposed there.
   Proposed: RFC-003 §5.6/§5.7 erratum that a line closed at 0 is not emitted and its first non-zero total is its
   late original; P3-S32 row 2 then reads "a charge of 1 for late traffic". Rating keeps this behaviour, the only output
   that C06 permits. Its test (review 73 TR-5) does not carry the scenario ID, and asserts what the feed and the ledger
   show: the M5 original of 1 with the record identity in `triggerRef`, and no amendment.
2. **Read-back source.** RFC-003 §5.11 says an old line "reads its last entry from `rating_log`". Rating reads the
   `rating_usage_line` row of the line, which the same transaction as the line's last entry writes (a declared
   read, C01 R47-11). It holds the same ELA and emitted total, without a scan of the account's log. Proposed:
   RFC-003 §5.11 names the line row as the index of the last entry.
3. **`triggerRef` of a late original from late traffic.** C06 §5 lists "the correction, attribution, reversal or
   superseded record" as triggers, not late records. Rating puts the first late record identity there. Proposed:
   C06 m5 adds late records.
4. **Downward late parts.** In I4 every part is non-negative, so late traffic only raises a line (P3-S33). A
   negated part (supersession, I16) on a closed line would lower it with no cause; rating alerts and emits nothing
   until I16 gives `superseding_record` with its cause. The negative part stays in the line's ELA (review 73 TR-8, pinned
   by the test), so a later upward late record is netted against it. I16 must decide to keep or drop the part.
8. **A late original with no price or weights for its minute.** Rating raises `NO_PRICE_OR_WEIGHTS` once for the
   line and holds its late records. The line arms no timer; the next late record of the line tries again, with no
   second alert. Before review 73 (TR-6) the `amend` timer fired again on each tick and wrote an alert and an empty
   `amendment` entry each time. RFC-003 names no rule for this alert; once for each line follows the "first drop"
   rule of §3.3. A catalogue correction does not wake a held line; a re-rate (later increment) owns that.
5. **Which minute is closed for the account.** Rating takes the last minute that a `usage-closed` entry closed. A
   part for a minute after it, with no line yet, opens a line that the next closure emits as an ordinary original.
6. **Eviction is lazy.** A cold line leaves memory at the next input of its account, not at the hour's end. Memory
   of an idle account stays until its next input.
7. **Spikes.** SP1 (ELA size, `amendment_hot_window`) is a dependency of I4 and SP3 (closure marker lag,
   `usage_close_margin`) an exit item. Both need the dev cell and are not done; I4 uses the RFC estimates (1 h, 15 s).

## Review 73 (test review of I4)

| Finding | Severity | State | Fix |
|---|---|---|---|
| TR-1 | Blocker | Fixed | Tests `should emit no amendment and no charge line when a late record does not change the floor of the line …` (1 GB, then a late 50,000 bytes: no amendment, no post, no batch in flight; the next late 1 GB is seq 1) and `should emit nothing and keep no batch in flight when a line closed at 0 gets a late record that leaves its floor at 0`. The row 2 test asserts that the late original is acknowledged posted and no batch stays in flight. M1 killed (6 tests, also 2 property seeds since TR-10) |
| TR-2 | Major | Fixed | `P3-S17 …`: each figure that names the original's batch has `usageReduction` = the original's amount, also after late parts. `should emit amendment k + 1 …`: the last figure that names amendment 1's batch is `unpostedUsage 20000`, `usageReduction 10000`. M2 killed |
| TR-3 | Major | Fixed | `should keep an unposted closed line in memory and in U after amendment_hot_window when its original was excluded`. M5 killed |
| TR-4 | Major | Fixed | The settlement double uses the Webster split for M5 and M6; the ledger double checks the M4, M5 and M6 templates and the weights version of the original; the world and the usage-suite subject give the ledger double the weights. Four tests added to `runC06ReservationSuite` (usage lines on weights 3000/3333/2167/1500: M5 1,500 and M6 1,500 → 4,285 by hand-computed tables, settlement mapping, a floor template refused, another weights version refused); the real ledger passes them. A rate test with two known weights versions (CS-11). The read-back test asserts the M5 entries 3,000 / 1,285 (a floor split gives 2,999 / 1,286). The P3-S48 test pinned the floor split (`split(1)` all to the commission); it now expects the Webster split (the unit to the supplier) |
| TR-5 | Major (design) | Behaviour kept (orchestrator decision) | Test renamed `should post a late original at seq 0 when a line closed at 0 gets late traffic (P3-S32 row 2 conflicts with C06 m5)`; it asserts the M5 movement line (`original`, −1, total 1, `triggerRef`), `postedTotal(seq 0) = 1`, no seq 1. P3-S32: row 1 met, row 2 blocked by spec conflict (design issue (I4) 1, ISSUES.md CS-10) |
| TR-6 | Major | Fixed (code defect) | Failing test first: the alert came on each timer tick. Now one alert for each line, the line is held and arms no timer; the next late record tries again. M7 (no `!weights` check), M8 (alert each try), M9 (held line due), M10 (held line arms the timer) killed |
| TR-7 | Minor | Fixed | `P3-S35 …` asserts the first `amendment` entry at exactly 12:12:00. M6 killed |
| TR-8 | Minor | Fixed | The downward test asserts ELA S = 500,000,000; the choice is in design issue (I4) 4 |
| TR-9 | Minor | Fixed | Exact `triggerRef` and record identities (canonical JSON, sorted keys) in the late-original, row 1 and row 2 tests |
| TR-10 | Minor | Fixed | One record in four has bytes in [1, 200,000) |
| TR-11 | Minor | Open | A reservation batch whose every line is excluded still commits an empty movement in the ledger double. C06 does not state the answer for this case; left for the C06 owner |
| TR-12 | Minor | Fixed | Renamed `should emit amendment k + 1 of a line in its own usage batch only when amendment k is acknowledged posted` |

Mutants checked by hand (edit, `npm run -s test:rate`, restore): M1 … M6 of the review, M7 … M10 on the TR-6 fix, and
on the doubles D1 (no template check), D2 (no weights-of-the-original check), D3 (M6 entries as M5) and D4 (a floor
split with the remainder to the commission). All 14 killed.

## Remaining work

- I2, I5 … I20 (plan §6).
- SP1 and SP3 on the dev cell; then run the X2-S13 measurement of I4 (exit criterion 7).
