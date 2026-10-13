# 66. Test review: slice S-RATE, increment S-RATE-I3

| | |
|---|---|
| Package | `slices/rate` (`common/`, `rating-owner/`) |
| Increment | S-RATE-I3. Spread and exact usage lines (`docs/04-delivery/plan/S-RATE.md` §S-RATE-I3) |
| Base | `main` at `d281d81`, plus the uncommitted I3 changes (`stage-a.ts`, `spread-and-lines.test.ts`, `ela.property.test.ts`, `STATUS.md`) |
| Scenarios | P3-S18, P3-S19, P3-S21, P3-S48, P3-S51, P3-S52 |
| Exit criteria | 1. six scenarios. 2. ELA property test (RFC-003 §9). 3. C06 CT-R1 on two routes |

## Verdict

**INADEQUATE.** 2 Blocker, 6 Major, 5 Minor.

The scenario tests and the ELA property test are good. The ELA property test has an independent
rational reference, fixed seeds, the seed in each failure message, and crafted sums at 1/P < 10⁻¹⁸.
But two money breaks in the line key and the price lookup survive: the fixture has only one product
and only `usage_price` versions. The Stryker `mutate` list does not include the I3 code, so the
mutation score does not show these breaks.

## Tool results

| Tool | Result |
|---|---|
| `npm run -s test:rate` | 57 pass, 0 fail. No flaky test seen in three runs (the suite also ran in `conformance.py` and in the Stryker dry run) |
| `python3 tools/conformance.py --scripts test:rate` | P3-S18, P3-S19, P3-S21, P3-S48, P3-S51, P3-S52: all `met` |
| Wall clock, sleep, `Math.random` | None in tests. `Date.parse` and `new Date(m)` always have an argument. `realSleep` in `common/src/append.ts:31` is only the default; the world injects `noSleep` |
| Integration tests | None for this slice yet (plan puts the first ones in I2 and I4). Not applicable |

## Stryker summary

`npm run mutation:rate` ran to the end (4 min). It restored the files (`git status` is the same as before the run).

| File | Score | Killed | Timeout | Survived | No coverage |
|---|---|---|---|---|---|
| `common/src/ela.ts` | 72.73 % | 62 | 2 | 24 | 0 |
| `common/src/time.ts` | 76.19 % | 32 | 0 | 10 | 0 |
| **All** | **73.85 %** | 94 | 2 | 34 | 0 |

17 of the 34 survivors are equivalent (list at the end). Without them the score is 96 / 113 = 85.0 %.

The `mutate` list has only `ela.ts` and `time.ts`. It does not have the I3 logic: `spread` and
`flowTooLong` (`rating-owner/src/attribution/stage-a.ts`), `usagePriceAt` and `weightsAt`
(`rating-owner/src/catalogue/replica.ts`), and `lineKey`, `chargeOf`, `closeDue`
(`rating-owner/src/rating/owner.ts`). I did the mutation analysis of these files by hand (TR-1, TR-2, TR-4).

## Findings

| ID | Severity | Location | Finding | Failing-mutant example | Proposed test |
|---|---|---|---|---|---|
| TR-1 | Blocker | `rating-owner/src/catalogue/replica.ts:52` | The price lookup filters by product and by `priceKind`. No test has a second product on the same route, or a `reservation_price` version. If a filter is lost, a usage line gets the price of another product, or a price per Mbps-minute in place of a price per GB. This is a wrong charge. | `replica.ts:52` delete `p.product !== product \|\|`; `replica.ts:52` delete `p.priceKind !== 'usage_price' \|\|` | Unit test `should give the usage_price of the asked product and kind when the route has other products and a reservation_price`. Replica with `be`/r1 `usage_price` 10,000 GB from 2026-10-02, `be2`/r1 `usage_price` 13,000 GB from 2026-10-05, `be`/r1 `reservation_price` `"1500000"` from 2026-10-08. `assert.deepEqual(r.usagePriceAt('be','r1',at('12:05')), { price: 10_000_000_000n, priceVersion: 'pv-r1-10000' })` and `assert.deepEqual(r.usagePriceAt('be2','r1',at('12:05')), { price: 13_000_000_000n, priceVersion: 'pv-be2-r1-13000' })`. The later `effectiveFrom` of the other versions is necessary: with an equal date the first version wins and the mutant survives |
| TR-2 | Blocker | `rating-owner/src/rating/owner.ts:78` | The plan says "one line for each (account, product, route, minute)". The test `should give one line for each (account, product, route, minute) …` changes only the minute; P3-S48 changes only the route. No test has two products in one minute. If the line key loses the product, the bytes of two products go into one line at one price. | `owner.ts:78` `` `${product}\|${route}\|${minuteMs}` `` → `` `${route}\|${minuteMs}` `` | Component test `should give one line for each product when two products of the account carry traffic on one route in one minute`. Bind `a1`/`be` on VLAN 100 and `a1`/`be2` on VLAN 300, both on r1. 1 GB each in 12:05. `assert.deepEqual(lines.map(l => [l.product, l.route, l.amount, l.reasonDetails.priceVersion]), [['be','r1','10000','pv-r1-10000'], ['be2','r1','13000','pv-be2-r1-13000']])` |
| TR-3 | Major | `tools/mutation/rate.stryker.json:10` | The `mutate` list does not include the code that I3 adds or tests: `stage-a.ts` (`spread`, `flowTooLong`), `catalogue/replica.ts`, `rating/owner.ts`. The reported 73.85 % does not measure I3. TR-1, TR-2 and TR-4 are in this gap. | Each mutant of TR-1, TR-2, TR-4 | Add `slices/rate/rating-owner/src/attribution/stage-a.ts`, `…/catalogue/replica.ts` and `…/rating/owner.ts` to `mutate` (or a `mutate` range for `spread`, `flowTooLong`, `usagePriceAt`, `weightsAt`, `lineKey`, `chargeOf`, `closeDue`). Run again and record the score per file |
| TR-4 | Major | `rating-owner/src/attribution/stage-a.ts:41` | The bind time of a part in a minute after the first is `max(s, m)`. No test asserts `bindTimeMs` of a second part. `owners.test.ts:20` maps only `minuteMs` and `bytes`. The property test reads only `minuteMs` and `bytes`. If the bind time is always `s`, a binding that starts at a minute boundary inside the record is not used. The bytes go to the wrong account, or wait. | `stage-a.ts:41` `bindTimeMs: Math.max(startMs, m)` → `bindTimeMs: startMs` | In `owners.test.ts`: `should bind each part at the later of the record start and the minute start when a record crosses minutes`: `assert.deepEqual(spread(at('12:05:30'), at('12:07:00'), 3n*GB).map(p => p.bindTimeMs), [at('12:05:30'), at('12:06:00')])` |
| TR-5 | Major | `common/src/time.ts:20` | `lastMinuteEnd` with e = s exactly on a minute start has no test. `common.test.ts:33` uses 10:00:10, where `ceilMin(e)` and `floorMin(s) + 60 s` are equal. The mutant gives the end of the last minute 60 s too early. Stage A writes it to each part (`stage-a.ts:287`), and I4 computes lateness from it. | `time.ts:20` `endMs > startMs` → `endMs >= startMs` (also `→ true`) | In `common.test.ts`: `assert.equal(lastMinuteEnd(Date.parse('2026-10-12T12:05:00Z'), Date.parse('2026-10-12T12:05:00Z')), Date.parse('2026-10-12T12:06:00Z'))` |
| TR-6 | Major | `common/src/ela.ts:28`, `common/src/ela.ts:35` | Two refusals have no test: `floorDiv` with a divisor ≤ 0, and `addFraction` with a denominator ≤ 0. `addFraction` gets `BigInt(p.bytes.den)` from a C11 `Part` (`rating/owner.ts:285`), so the guard protects a feed input. Without the guard, den = −7 gives a wrong accumulator and no error. | `ela.ts:35` `den <= 0n` → `den < 0n`; `ela.ts:35` → `false`; `ela.ts:28` `b <= 0n` → `false` | In `common.test.ts`: `assert.throws(() => addFraction(emptyEla(), 1n, 0n), { message: 'ELA: the denominator must be positive' })`, the same for `-7n`; `assert.throws(() => floorDiv(7n, 0n), { message: 'floorDiv: the divisor must be positive' })`, the same for `-2n`. Also decide (and test) what rating does with a `Part` whose `den` is `"0"` or negative |
| TR-7 | Major | `common/src/ela.ts:87`, `rating-owner/src/rating/owner.ts:196`, `owner.ts:328`, `owner.ts:459` | No test reads the persisted accumulator. `elaToJson` writes the ELA to the `rating` line projection, to the `usage_closed` entry (`elaS`, `elaR`) and to `lineSig`. If it returns `{}`, every test still passes. The line projection then has no bytes, and `lineSig` does not see a change of bytes, so the projection write is skipped. | `ela.ts:87` `return { S: ela.S.toString(), r }` → `return {}` | In P3-S51: read the `usage_closed` entry of `a1` for 12:05 from the runtime double and `assert.deepEqual(entry.lines[0], { product: 'be', route: 'r1', amount: '17142', elaS: '1714285714', elaR: '{"7":"2"}' })`; read the line projection row and `assert.deepEqual(row.line.ela, { S: '1714285714', r: { '7': '2' } })` |
| TR-8 | Major | `common/src/time.ts:29`, `time.ts:32`, `common/src/c06-schema.ts:65`, `common/src/c06.ts:243` | `isMinute` is the `Minute` check of the C06 CT-R1 schema checker and of the canonical `SourceRef`. No test gives it a bad value. `isMinute → true` survives, so the CT-R1 test cannot fail on a bad `minute`. | `time.ts:32` `return MINUTE_RE.test(s) && …` → `return true`; `&&` → `\|\|`; `time.ts:29` delete `^`; delete `$` | In `common.test.ts`, `C06 CT-R1 should refuse a line whose minute is not a C06 Minute`: for each of `'2026-10-12T12:05:30Z'`, `'x2026-10-12T12:05:00Z'`, `'2026-10-12T12:05:00Zx'`, `'2026-13-45T12:05:00Z'`, `assert.deepEqual(checkChargeLineBatch(batchWithMinute(v)), ['<path>.minute'])` (the exact path of the first line) and `assert.throws(() => canonicalSourceRefBytes({ ...ref, minute: v }), { message: \`SourceRef.minute is not a Minute: ${v}\` })` |
| TR-9 | Minor | `rating-owner/src/attribution/stage-a.ts:172` | The `FLOW_TOO_LONG` alert is raised only after the entry commits, "so a retried step does not alert twice". No test asserts this. No test sends a too-long record twice (both publish paths) and asserts one alert. | `stage-a.ts:172` `if (ok)` → `if (true)` | In P3-S19 (12:05:00 to 12:08:00), deliver each hand-off twice (as in C01 CC-6) and `assert.equal(w.alerts.alerts.filter(a => a.kind === 'FLOW_TOO_LONG').length, 1)` |
| TR-10 | Minor | `rating-owner/test/spread-and-lines.test.ts:204`, `:107` | The test `should alert when a record is longer than …` tests only the pure function `flowTooLong`; it does not check an alert. The name is not correct. P3-S19 checks only the first word of `detail`. | — | Rename to `should be true for flowTooLong when the active interval is longer than flow_active_timeout + 60 s, and false at exactly that length`. In P3-S19 assert the full `detail`: `` `e1 ${JSON.stringify(identity)} 180000 ms` `` |
| TR-11 | Minor | `common/test/common.test.ts:14-17` | The P3-S21 and P3-S51 values (1.5 → 1, 0.99999 → 0, 120,000/7 → 17,142) are checked at the unit level with scenario IDs in comments, and again at their owning component level in `spread-and-lines.test.ts`. Same check at two levels. | — | Keep the unit asserts as ELA formula checks without scenario IDs in comments, or delete them (the property test covers the formula) |
| TR-12 | Minor | `common/src/ela.ts:86`, `ela.ts:90-93` | Seven sort mutants in `elaToJson` survive. They are equivalent only while each denominator is below 2³² − 1 (JavaScript then lists integer keys in increasing order). `elaFromJson` has no caller in `src/`. | `ela.ts:86` sort comparator → `() => undefined` | `assert.deepEqual(Object.keys(elaToJson(addFraction(addFraction(emptyEla(), 1n, 4_294_967_311n), 1n, 3n)).r), ['3', '4294967311'])`. Delete `elaFromJson`, or test a round trip when I4 reads lines back from `rating_log` |
| TR-13 | Minor | `common/src/time.ts:25`, `time.ts:36` | The guards of `minuteIso` (not a minute start) and `parseMinute` (not a C06 Minute) have no test. `parseMinute` reads catalogue `effectiveFrom` (I6). | `time.ts:25` `minuteMs % MINUTE_MS !== 0` → `false`; `time.ts:36` → `false` | `assert.throws(() => minuteIso(Date.parse('2026-10-12T12:05:01Z')), { message: '1791806701000 is not a minute start' })` (use the exact number); `assert.throws(() => parseMinute('2026-10-12T12:05:30Z'), { message: 'not a C06 Minute: 2026-10-12T12:05:30Z' })` |

## Checks that pass

- **P3-S18.** The four examples assert the exact map of charged minutes, so a part in the next
  minute is a failure. The end 12:06:00 and the start 12:06:00 examples kill a closed minute end.
  Each example asserts no alert.
- **P3-S19, P3-S51, P3-S52.** Exact amounts for each minute. P3-S51 also asserts the exact ELA
  `{ S: 1714285714n, r: { 7: 2n } }`. P3-S52 kills `from > minuteMs` → `from >= minuteMs` and
  the `from > best` direction in `usagePriceAt` (12:20 gets 13,000 and `pv-r1-13000`).
- **P3-S21.** The 0 micro-USD example asserts the must-not: no charge line, line closed, emitted `'0'`, `U` = 0.
- **P3-S48.** Kills a lost `route` filter in `usagePriceAt` and `weightsAt` (exact `priceVersion` and `weightsVersion` per route).
- **ELA property test (exit criterion 2).** Independent reference (`refSpread`, `refFloor` by
  correction, reduced rationals). 5 seeds × 200 rounds; negated copies; shuffle; order and merge
  checks; shape invariant `0 < r_d < d`. Crafted sums at X = N ± 1/P with P > 10¹⁸ floor to N and
  N − 1. Each failure message has the seed and `RATE_ELA_SEED=<n>`. It kills the arithmetic mutants
  of `spread` (numerator, denominator, minute loop) and of `floorDiv` and `addFraction`.
- **C06 CT-R1 (exit criterion 3).** Two routes; `checkChargeLineBatch` gives `[]`; settlement
  double has no schema errors; exact canonical `SourceRef` hex. (TR-8: the checker itself is not proven to refuse.)
- **flowTooLong boundary.** `s + 120,000` false and `s + 120,001` true kill `>` → `>=` and a lost `+ MINUTE_MS`.

## Equivalent mutants dropped

- `ela.ts:20` `a < 0n` → `a <= 0n`: −0n equals 0n.
- `ela.ts:21` `b < 0n` → `false`, → `b <= 0n`, `-b` → `+b`: every caller gives b > 0 (`addFraction` after its guard, `elaFraction` with d > 1), so the branch never runs.
- `ela.ts:30` `a < 0n` → `a <= 0n`: when a = 0, `a % b !== 0n` is false.
- `ela.ts:40` `d === 1n` → `false`, and the block → `{}`: the general path with d = 1 adds `n` to `S` and deletes key `'1'`; the result is the same.
- `ela.ts:65` `den / gcd(den, db)` → `den * gcd(den, db)`: the denominator is a multiple of the lcm; the fraction value is the same, and every user compares by value or floors it.
- `ela.ts:86` (7 sort mutants): JavaScript lists integer keys below 2³² − 1 in increasing order whatever the sort; cheap to kill (TR-12).
- `ela.ts:90`, `ela.ts:93` (`elaFromJson`): no caller in `src/` (TR-12).
- Manual, `stage-a.ts:39` `m < endMs` → `m <= endMs`, and `t <= 0` → `t < 0`: for m in the loop, t > 0 always, and at m = e, t = 0 is skipped by `continue`.

## Resolution

Fixed in the same worktree, not committed. Test files: `rating-owner/test/spread-and-lines.test.ts` (S&L),
`rating-owner/test/owners.test.ts` (OWN), `common/test/common.test.ts` (COM).

| ID | Fix | Test |
|---|---|---|
| TR-1 | Unit test of the replica with a second product and a `reservation_price` on r1, both with a later `effectiveFrom`. The world fixture also has them (`be2`/r1 13,000; `be`/r1 `reservation_price`) | OWN `should give the usage_price of the asked product and kind when the route has other products and a reservation_price` |
| TR-2 | Two products of a1 on r1 in 12:05; the `be2` flow is sent first, so the batch order comes from the sort | S&L `should give one line for each product when two products of the account carry traffic on one route in one minute` |
| TR-3 | `tools/mutation/rate.stryker.json` mutates `stage-a.ts`, `catalogue/replica.ts` and `rating/owner.ts` too. The score of the wider list is not recorded yet: a person runs `npm run mutation:rate` and records the score for each file | — |
| TR-4 | Bind time of the second part | OWN `should bind each part at the later of the record start and the minute start when a record crosses minutes` |
| TR-5 | e = s on a minute start | COM `should make minutes half-open and in C06 Minute form when converting time` |
| TR-6 | Both refusals tested. **Code defect fixed:** rating threw from `addFraction` on a part with `den` ≤ 0 (the step failed with no alert). `RatingOwner.applyParts` now checks each part with `exactBytesValid` (signed integer over a positive integer, C11 Part IV); a bad batch is not applied, raises `INVALID_PART` and writes no entry | COM `should refuse a denominator or a divisor that is not positive when the ELA adds or floors`; OWN `should alert and apply nothing when a part batch holds a part whose bytes are not an integer over a positive integer` |
| TR-7 | P3-S51 reads the `usage_closed` entries of 12:05 and 12:06 (`elaS`, `elaR`) and the `rating_usage_line` projection row (`ela`, `posted`) | S&L `P3-S51 …` |
| TR-8 | Four bad minutes against the CT-R1 checker (exact error list) and the canonical `SourceRef` | COM `C06 CT-R1 should refuse a line and a SourceRef whose minute is not a C06 Minute` |
| TR-9 | The first stage A append is `Stopped`; the hand-off comes again on the relay; one alert with the full detail | S&L `should alert FLOW_TOO_LONG once when the first append of the stage A entry is refused and the hand-off comes again on the relay` |
| TR-10 | Renamed; P3-S19 asserts the full `detail` | S&L `should be true for flowTooLong when …`; S&L `P3-S19 … 12:05:00 to 12:08:00 …` |
| TR-11 | Scenario IDs removed from the unit asserts; the asserts stay as formula checks | COM `should compute the usage charge as ⌊price × X / 10^15⌋ …` |
| TR-12 | Sort order with five denominators, four above 2³² − 2, in an order that the mutant `() => -1` breaks; round trip through `elaFromJson` (kept for I4) | COM `should write the ELA entries in increasing denominator order and read the same accumulator back when saving it` |
| TR-13 | Both guards | COM `should refuse a time that is not a minute start, and a string that is not a C06 Minute, when converting minutes` |

Further tests for survivors of the wider run: OWN `should take the latest effectiveFrom at or before the minute when price and weight versions arrive out of order`, OWN `should keep the latest resolved timestamp and the product kinds when the replica applies the feed`, S&L `should not close or emit a minute, and should alert, when a line of the minute has no usage_price for its product and route`. P3-S48 sends the r2 flow first (batch sort by route).
