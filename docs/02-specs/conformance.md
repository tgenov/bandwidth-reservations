# Conformance matrix

This matrix records, for every scenario in `02-specs/*.feature`, which design element
satisfies it, which tests show it, and whether it is met. It is filled in at the
**conformance stage, after design**: the RFCs are being rewritten to satisfy the
requirements, and the code will then be changed to conform. Until then every row is
`not assessed` and every Design cell is `TBD`.

The `.feature` files never carry verification status, test names or defect notes; they
live only here. Status values, once assessed: `met`, `partly met` (for example met on one
path only), `not met`. A scenario met only on some paths is never `met`.

Tests marked *prior evidence, to be re-validated* are the citations the previous baseline
gave for a scenario whose meaning is unchanged. They show what the prototype once checked;
they do not establish conformance. Generators, seeds, client counts and fault rates used by
such tests belong in the test plan, not in the scenario.

## Matrix

| Scenario | Title | Design | Tests | Status |
|---|---|---|---|---|
| P1-S01 | A booking is confirmed exactly when the peak leaves room for it | TBD | `test/tree.test.ts` › "exact fit to capacity is admitted, one more Mbps is not" *(prior evidence, to be re-validated)* | not assessed |
| P1-S02 | Reservations that never coexist do not add up | TBD | `test/tree.test.ts` › "A/B: summing overlaps would reject, the peak admits" *(prior evidence, to be re-validated)*<br>`test/sql.test.ts` › "SQL: touching intervals and the A/B example" *(prior evidence, to be re-validated)* | not assessed |
| P1-S03 | A booking needs room, not a completely free gap | TBD | `test/tree.test.ts` › "exact fit to capacity is admitted, one more Mbps is not" *(prior evidence, to be re-validated)* | not assessed |
| P1-S04 | Back-to-back bookings each get the whole link | TBD | `test/tree.test.ts` › "touching intervals [a, b) and [b, c) do not overlap" *(prior evidence, to be re-validated)*<br>`test/sql.test.ts` › "SQL: touching intervals and the A/B example" *(prior evidence, to be re-validated)* | not assessed |
| P1-S05 | Every decision agrees with a minute-by-minute check of the schedule | TBD | `test/sql.test.ts` › "property: tree, SQL and brute-force array agree on every decision" *(prior evidence, to be re-validated)* | not assessed |
| P1-S06 | A year-long booking is checked at every minute of its window | TBD | `test/tree.test.ts` › "a year-long booking is two point updates" *(prior evidence, to be re-validated)* | not assessed |
| P1-S07 | Capacity held for a pending request is not sold to anyone else | TBD | — | not assessed |
| P1-S08 | Capacity held for a request that ends without confirmation is available again | TBD | — | not assessed |
| P1-S09 | Confirming a pending request does not count its capacity twice | TBD | — | not assessed |
| P1-S10 | A single-link booking is decided against capacity confirmed for routes | TBD | — | not assessed |
| P1-S11 | A single-link booking blocked only by capacity in flight is confirmed if that capacity is released in time | TBD | — | not assessed |
| P1-S12 | A single-link booking still blocked by capacity in flight after ack_budget is rejected with retry_after | TBD | — | not assessed |
| P1-S13 | Concurrent bookings never oversell the link | TBD | `test/concurrency.test.ts` › "safe admission never oversells a hot link under 50 concurrent clients" *(prior evidence, to be re-validated)*<br>`test/routes.test.ts` › "randomised contention (seed 11/12/13): never oversold, competitors never all lose, all sagas finish" *(prior evidence, to be re-validated)* | not assessed |
| P1-S14 | Concurrent decisions are those of some one-at-a-time order | TBD | — | not assessed |
| P1-S15 | A rejection states the largest rate that fits the requested window | TBD | — | not assessed |
| P1-S16 | A rejection states the earliest window of the requested length that fits the requested rate | TBD | — | not assessed |
| P1-S17 | A rejection discloses nothing about other buyers | TBD | — | not assessed |
| P1-S18 | A request that was not confirmed leaves the link as if it had never been made | TBD | `test/sql.test.ts` › "SQL: touching intervals and the A/B example" *(prior evidence, to be re-validated)*<br>`test/sql.test.ts` › "property: tree, SQL and brute-force array agree on every decision" *(prior evidence, to be re-validated)* | not assessed |
| P1-S19 | A malformed window is invalid, not a capacity answer | TBD | — | not assessed |
| P1-S20 | A window that reaches the edge of what is sold is valid | TBD | — | not assessed |
| P1-S21 | An open-ended reservation takes its rate at every minute up to the horizon | TBD | `test/tree.test.ts` › "open-ended reservation blocks the rest of the horizon" *(prior evidence, to be re-validated)* | not assessed |
| P1-S22 | Minutes that become sellable are taken by the open-ended reservation before any new sale | TBD | — | not assessed |
| P1-S23 | A booking that ends where an open-ended reservation starts gets the whole link | TBD | `test/tree.test.ts` › "open-ended reservation blocks the rest of the horizon" *(prior evidence, to be re-validated)* | not assessed |
| P1-S24 | New bookings are decided against the reduced capacity at once | TBD | — | not assessed |
| P1-S25 | Reservations that no longer fit stay confirmed and are flagged as affected | TBD | — | not assessed |
| P1-S26 | The holders of affected reservations and network operations are told | TBD | — | not assessed |
| P1-S27 | Restored capacity is sellable again | TBD | — | not assessed |
| P1-S28 | Maintenance that fits on free capacity is booked | TBD | — | not assessed |
| P1-S29 | Maintenance that needs committed capacity is rejected | TBD | — | not assessed |
| P1-S30 | Maintenance booked with less than the required notice is rejected | TBD | — | not assessed |
| P1-S31 | An affected reservation is moved to an equivalent path when one exists | TBD | — | not assessed |
| P1-S32 | Without an equivalent path, the newest reservations are revoked first, with notice | TBD | — | not assessed |
| P1-S33 | The schedule as known at a past time includes reservations changed since | TBD | — | not assessed |
| P2-S01 | A route whose every leg fits is confirmed on every leg | TBD | `test/routes.test.ts` › "a route across our links and the partner is confirmed; every leg becomes a fact" *(prior evidence, to be re-validated)* | not assessed |
| P2-S02 | A route with a leg that does not fit is rejected, naming that leg, and holds nothing | TBD | `test/routes.test.ts` › "a leg that cannot fit rejects the route, names the link, and releases every hold" *(prior evidence, to be re-validated)* | not assessed |
| P2-S03 | Confirmed is never reported before every leg, the partner's included, is secured | TBD | — | not assessed |
| P2-S04 | Whatever fails, a route never ends booked on some legs only | TBD | — | not assessed |
| P2-S05 | A confirmed route is withdrawn only under the supply-loss and suspension policies | TBD | — | not assessed |
| P2-S06 | Every booking request gets a response within ack_budget | TBD | — | not assessed |
| P2-S07 | A request whose outcome is known within ack_budget gets its final outcome | TBD | — | not assessed |
| P2-S08 | A request whose outcome is not yet known is pending, and the outcome can be polled with its idempotency key | TBD | — | not assessed |
| P2-S09 | A buyer who registered a webhook is sent the outcome | TBD | — | not assessed |
| P2-S10 | An outcome never changes once reported | TBD | — | not assessed |
| P2-S11 | A request without a deadline gets the default deadline | TBD | — | not assessed |
| P2-S12 | A deadline beyond the maximum is invalid | TBD | — | not assessed |
| P2-S13 | A request still without an outcome at its deadline fails and holds nothing | TBD | — | not assessed |
| P2-S14 | Capacity held for a request that is not confirmed is available again by its deadline | TBD | — | not assessed |
| P2-S15 | Competing requests that can each be served alone do not all lose | TBD | `test/routes.test.ts` › "randomised contention (seed 11/12/13): never oversold, competitors never all lose, all sagas finish" *(prior evidence, to be re-validated)* | not assessed |
| P2-S16 | Under the request_age rule the earlier request wins | TBD | — | not assessed |
| P2-S17 | A request is rejected for no fit only if it does not fit on committed capacity | TBD | — | not assessed |
| P2-S18 | A request rejected because capacity it needs is in flight is told when to retry | TBD | — | not assessed |
| P2-S19 | Crossed requests settle without waiting for capacity holds to time out | TBD | `test/routes.test.ts` › "crossed sagas: priority tickets resolve the deadlock at once (D17)" *(prior evidence, to be re-validated)* | not assessed |
| P2-S20 | A buyer who keeps retrying a request that fits is eventually confirmed | TBD | — | not assessed |
| P2-S21 | Changing the priority rule does not change the outcome of uncontended requests | TBD | — | not assessed |
| P2-S22 | An interrupted request that can still finish within its deadline is resumed | TBD | — | not assessed |
| P2-S23 | An interrupted request that cannot finish within its deadline fails, releases everything and says why | TBD | — | not assessed |
| P2-S24 | The same request sent twice at once is booked once | TBD | `test/routes.test.ts` › "idempotency: retries with the same key never book twice" *(prior evidence, to be re-validated)* | not assessed |
| P2-S25 | A retry after the outcome returns the original outcome, even after a restart | TBD | `test/routes.test.ts` › "idempotency: retries with the same key never book twice" *(prior evidence, to be re-validated)* | not assessed |
| P2-S26 | A different request under a key already used is refused | TBD | `test/routes.test.ts` › "idempotency: retries with the same key never book twice" *(prior evidence, to be re-validated)* | not assessed |
| P2-S27 | A retry while the request is pending returns its current status | TBD | — | not assessed |
| P2-S28 | Retried partner calls never book the partner twice | TBD | `test/routes.test.ts` › "randomised contention (seed 11/12/13): never oversold, competitors never all lose, all sagas finish" *(prior evidence, to be re-validated)* | not assessed |
| P2-S29 | Share never confirms a leg the partner has not confirmed | TBD | — | not assessed |
| P2-S30 | A transient partner refusal does not end the request before its deadline | TBD | — | not assessed |
| P2-S31 | A definite partner refusal rejects the route, naming the partner link | TBD | — | not assessed |
| P2-S32 | Share's record of partner bookings is reconciled with the partner | TBD | — | not assessed |
| P2-S33 | A partner without holds is booked only after every other leg and the funds are secured | TBD | — | not assessed |
| P2-S34 | A route with two legs on partners without holds is refused | TBD | — | not assessed |
| P2-S35 | A failure after the partner without holds was booked cancels it at Share's cost | TBD | — | not assessed |
| P2-S36 | A partner whose holds are too short is booked as a partner without holds | TBD | — | not assessed |
| P2-S37 | A route over two partners with holds of different lengths is all or nothing | TBD | — | not assessed |
| P2-S38 | A booking the account cannot fund is rejected, stating the top-up needed | TBD | — | not assessed |
| P2-S39 | A booking beyond an agent key's spending limit is rejected | TBD | — | not assessed |
| P2-S40 | A booking beyond a limit on capacity in flight is rejected | TBD | — | not assessed |
| P2-S41 | Requests from an agent key above its rate limit are refused | TBD | — | not assessed |
| P2-S42 | A suspended account cannot book | TBD | — | not assessed |
| P2-S43 | A cancellation takes effect at the next minute boundary on every leg | TBD | — | not assessed |
| P2-S44 | Shortening cancels the remaining part | TBD | — | not assessed |
| P2-S45 | An extension is admitted for the added period only | TBD | — | not assessed |
| P2-S46 | A rejected extension leaves the reservation as it was | TBD | — | not assessed |
| P2-S47 | A rate increase is admitted for the difference only, and a rejection leaves the reservation as it was | TBD | — | not assessed |
| P2-S48 | A rate decrease takes effect at the next minute boundary | TBD | — | not assessed |
| P2-S49 | A change to part of a route is refused | TBD | — | not assessed |
| P2-S50 | A partner leg's minimum term and cancellation fee are shown at booking | TBD | — | not assessed |
| P2-S51 | A request in trouble is visible to operations with its reason | TBD | — | not assessed |
| P3-S01 | An active minute accrues whether or not traffic crosses it | TBD | — | not assessed |
| P3-S02 | A part minute is charged as a whole minute | TBD | — | not assessed |
| P3-S03 | There is no minimum term | TBD | — | not assessed |
| P3-S04 | Accrual stops at the minute a cancellation takes effect | TBD | — | not assessed |
| P3-S05 | A rate decrease is accrued at the new rate from its effective minute | TBD | — | not assessed |
| P3-S06 | A reservation keeps the price it was booked at | TBD | — | not assessed |
| P3-S07 | An open-ended reservation's price changes only after price_notice | TBD | — | not assessed |
| P3-S08 | A revoked reservation accrues nothing after the revocation takes effect | TBD | — | not assessed |
| P3-S09 | A suspended account's reservation accrues during the grace, and not after its release | TBD | — | not assessed |
| P3-S10 | A reservation affected by an unplanned outage keeps accruing and is marked for credit | TBD | — | not assessed |
| P3-S11 | A partner cancellation fee is charged only if it was shown at booking | TBD | — | not assessed |
| P3-S12 | A minute is charged once however many charging runs overlap | TBD | — | not assessed |
| P3-S13 | Charging that starts afresh, or after losing its place, charges every record not yet charged, once | TBD | — | not assessed |
| P3-S14 | A record delivered twice is counted once | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" *(prior evidence, to be re-validated)*<br>`billing/test/kafka.e2e.test.ts` › "duplicated records on Kafka are ingested once and rated into a balanced ledger" *(prior evidence, to be re-validated)* | not assessed |
| P3-S15 | Any delivery order, duplication and lateness gives the same charges as in-order delivery | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" *(prior evidence, to be re-validated)*<br>`billing/test/kafka.e2e.test.ts` › "duplicated records on Kafka are ingested once and rated into a balanced ledger" *(prior evidence, to be re-validated)* | not assessed |
| P3-S16 | A repeat of a record already charged causes no amendment | TBD | — | not assessed |
| P3-S17 | A record arriving while its minute is being charged is neither lost nor counted twice | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › concurrent ingestion and rating lose no record (the minute lock)" *(prior evidence, to be re-validated)*<br>`billing/test/rating.test.ts` › "rating and ledger (D18–D20) › a record that races its minute being rated is still charged (forced interleaving)" *(prior evidence, to be re-validated)* | not assessed |
| P3-S18 | A record within one minute belongs to that minute; minutes are half-open | TBD | — | not assessed |
| P3-S19 | A record spanning several whole minutes is spread evenly across them | TBD | — | not assessed |
| P3-S20 | A late record is priced at the price of its own minute | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › a late record is priced at the rate of its own event time, not of its arrival" *(prior evidence, to be re-validated)* | not assessed |
| P3-S21 | A charge is computed exactly and rounded once, down to the micro | TBD | — | not assessed |
| P3-S22 | Traffic within the reserved rate is covered by the reservation's accrual | TBD | — | not assessed |
| P3-S23 | Permitted burst is billed at usage_price for the excess only | TBD | — | not assessed |
| P3-S24 | Traffic above the reserved rate on a product without burst is kept and reported | TBD | — | not assessed |
| P3-S25 | Attributable traffic outside an active reservation is billed at usage_price and counts toward exposure | TBD | — | not assessed |
| P3-S26 | Traffic that cannot be attributed is quarantined, not billed, and reported | TBD | — | not assessed |
| P3-S27 | Quarantined traffic is charged, and its supplier paid, only if attributed within dispute_window | TBD | — | not assessed |
| P3-S28 | A record that cannot be read is kept with its reason and not charged | TBD | — | not assessed |
| P3-S29 | A record that cannot be read does not delay the records behind it | TBD | — | not assessed |
| P3-S30 | A kept record that is corrected is charged once | TBD | — | not assessed |
| P3-S31 | An accepted record is never altered or removed | TBD | — | not assessed |
| P3-S32 | A late record for a charged minute adds an amendment and leaves the charge as it was | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › a late record is priced at the rate of its own event time, not of its arrival" *(prior evidence, to be re-validated)*<br>`billing/test/rating.test.ts` › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" *(prior evidence, to be re-validated)* | not assessed |
| P3-S33 | Late traffic never decreases a charge | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" *(prior evidence, to be re-validated)* | not assessed |
| P3-S34 | A price correction is an amendment, in either direction, with who made it and why | TBD | — | not assessed |
| P3-S35 | A buyer can see, for any minute, the original charge and every amendment with its reason | TBD | — | not assessed |
| P3-S36 | Recomputing any period gives exactly the recorded charges and amendments | TBD | — | not assessed |
| P3-S37 | The business can see each account's exposure | TBD | — | not assessed |
| P3-S38 | A record later than max_lateness is still charged and reported as a breach | TBD | — | not assessed |
| P3-S39 | Accepted records can be retrieved by reservation, link and minute | TBD | — | not assessed |
| P4-S01 | Repeated and reordered notifications change the wallet once per transaction | TBD | `billing/test/wallet.test.ts` › "payment webhooks (D19 wallet) › repeated and out-of-order webhooks credit the wallet exactly once" *(prior evidence, to be re-validated)* | not assessed |
| P4-S02 | A reversal arriving before its payment is held and matched | TBD | — | not assessed |
| P4-S03 | A reversal whose payment does not arrive within 72 h is applied | TBD | — | not assessed |
| P4-S04 | A redelivery whose contents differ from the original moves no money and is reported | TBD | — | not assessed |
| P4-S05 | A malformed notification moves no money | TBD | `billing/test/wallet.test.ts` › "payment webhooks (D19 wallet) › malformed webhooks are rejected by the validation pipe" *(prior evidence, to be re-validated)* | not assessed |
| P4-S06 | A KES top-up is credited at the rate shown before the buyer confirmed | TBD | — | not assessed |
| P4-S07 | A provider amount converts exactly into micros | TBD | — | not assessed |
| P4-S08 | Confirming a reservation holds funds for the coverage window, without charging them | TBD | — | not assessed |
| P4-S09 | A reservation shorter than the coverage window is held in full | TBD | — | not assessed |
| P4-S10 | Charges accrue against the hold, and the hold rolls forward | TBD | — | not assessed |
| P4-S11 | The unused hold is released when a reservation ends early | TBD | — | not assessed |
| P4-S12 | A booking that is not confirmed holds no funds | TBD | — | not assessed |
| P4-S13 | A credit-limit account is not held but its commitments count against its limit | TBD | — | not assessed |
| P4-S14 | A credit-limit account is invoiced monthly for its posted charges | TBD | — | not assessed |
| P4-S15 | The headline figure is available headroom | TBD | — | not assessed |
| P4-S16 | The answer itemises balance, holds, accrued charges and estimated unposted usage | TBD | — | not assessed |
| P4-S17 | The ledger balance shown equals the ledger | TBD | `billing/test/kafka.e2e.test.ts` › "request-reply: @MessagePattern answers a wallet balance query over Kafka" *(prior evidence, to be re-validated)* | not assessed |
| P4-S18 | An account whose hold cannot roll forward is suspended | TBD | — | not assessed |
| P4-S19 | A credit-limit account is suspended before charges plus exposure would exceed its limit | TBD | — | not assessed |
| P4-S20 | A suspended account's reservations keep their capacity during the grace | TBD | — | not assessed |
| P4-S21 | A suspended account's usage-priced traffic is blocked | TBD | — | not assessed |
| P4-S22 | Funds arriving within the grace resume the account automatically | TBD | — | not assessed |
| P4-S23 | At the end of the grace the reservations are released and the buyer is told | TBD | — | not assessed |
| P4-S24 | The buyer is warned before suspension | TBD | — | not assessed |
| P4-S25 | Each change of standing is notified at least once, and repeats change nothing | TBD | — | not assessed |
| P4-S26 | The current standing can be asked for at any time | TBD | — | not assessed |
| P4-S27 | Enforcement later than its target is reported | TBD | — | not assessed |
| P4-S28 | Every money movement and the whole ledger sum to zero | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" *(prior evidence, to be re-validated)*<br>`billing/test/wallet.test.ts` › "payment webhooks (D19 wallet) › repeated and out-of-order webhooks credit the wallet exactly once" *(prior evidence, to be re-validated)*<br>`billing/test/rating.test.ts` › "rating and ledger (D18–D20) › the database refuses unbalanced journals and edits to the ledger" *(prior evidence, to be re-validated)* | not assessed |
| P4-S29 | No money movement can be altered or removed by anyone | TBD | — | not assessed |
| P4-S30 | A correction is a new money movement that refers to the one it corrects | TBD | — | not assessed |
| P4-S31 | Every amount carries its currency, and a money movement is in one currency | TBD | — | not assessed |
| P4-S32 | Shares add up exactly to the charge | TBD | `billing/test/split.test.ts` › "split (D20) › shares always sum exactly to the amount" *(prior evidence, to be re-validated)* | not assessed |
| P4-S33 | A larger charge never lowers any party's share | TBD | `billing/test/split.test.ts` › "split (D20) › house-monotone: a larger amount never lowers any share" *(prior evidence, to be re-validated)* | not assessed |
| P4-S34 | The split depends only on the amount and the weights | TBD | — | not assessed |
| P4-S35 | Shares follow the Webster rule | TBD | — | not assessed |
| P4-S36 | Share's commission loses every tie | TBD | — | not assessed |
| P4-S37 | Cumulative deviation from exact proportions is reported per party per payout period | TBD | — | not assessed |
| P4-S38 | Every account ends at the split of each minute's final total, whatever the arrival order | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" *(prior evidence, to be re-validated)* | not assessed |
| P4-S39 | A late-traffic amendment never reduces any party's amount and never credits the buyer | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" *(prior evidence, to be re-validated)*<br>`billing/test/rating.test.ts` › "rating and ledger (D18–D20) › late usage never claws back a supplier, even where largest remainder would (Alabama paradox)" *(prior evidence, to be re-validated)* | not assessed |
| P4-S40 | A supplier's statement shows each share and the rule and weights that produced it | TBD | — | not assessed |
| P4-S41 | A correction caused by Share's error comes out of Share's commission | TBD | — | not assessed |
| P4-S42 | A supplier-caused error creates a supplier debt, with its reason visible | TBD | — | not assessed |
| P4-S43 | A supplier owed at least the minimum is paid at the weekly payout | TBD | — | not assessed |
| P4-S44 | A balance below the minimum carries forward | TBD | — | not assessed |
| P4-S45 | A payout is complete only when the transfer is confirmed | TBD | — | not assessed |
| P4-S46 | A payout run that is repeated or retried pays each supplier at most once | TBD | — | not assessed |
| P4-S47 | A payout is rounded down to the provider's minor unit and the residue carries forward | TBD | — | not assessed |
| P4-S48 | A supplier debt is netted against later payouts | TBD | — | not assessed |
| P4-S49 | A supplier debt open for more than 90 days is invoiced | TBD | — | not assessed |
| P4-S50 | A supplier paid in another currency is converted at payout at the shown rate | TBD | — | not assessed |
| P4-S51 | A reversal after the top-up was spent is applied at once and suspends the account if headroom goes negative | TBD | — | not assessed |
| P4-S52 | A negative balance is collected from the next top-up | TBD | — | not assessed |
| P4-S53 | A negative balance not recovered within 90 days is written off at Share's cost | TBD | — | not assessed |
| P4-S54 | Differences found in the daily reconciliation are reported | TBD | — | not assessed |
| X1-S01 | An unauthenticated request changes nothing and reveals nothing | TBD | — | not assessed |
| X1-S02 | Another account's data cannot be read, and its existence is not revealed | TBD | — | not assessed |
| X1-S03 | Another account's reservation cannot be changed | TBD | — | not assessed |
| X1-S04 | A supplier sees only its own links and settlements | TBD | — | not assessed |
| X1-S05 | An agent key acts only for the account that issued it | TBD | — | not assessed |
| X1-S06 | A revoked agent key is refused | TBD | — | not assessed |
| X1-S07 | An operation by an agent key records the key | TBD | — | not assessed |
| X1-S08 | The same idempotency key used by two accounts gives two independent requests | TBD | — | not assessed |
| X1-S09 | An idempotency key reveals nothing about another account's request | TBD | — | not assessed |
| X1-S10 | A notification not proven authentic moves no money and is recorded | TBD | — | not assessed |
| X1-S11 | A webhook can be verified as coming from Share and unaltered | TBD | — | not assessed |
| X1-S12 | An operator with a permitting role can act on an account, and the action is recorded with its reason | TBD | — | not assessed |
| X1-S13 | An operator without a permitting role is refused | TBD | — | not assessed |
| X1-S14 | Every change to money or capacity records the principal and the time | TBD | — | not assessed |
| X1-S15 | An audit record cannot be altered or removed | TBD | — | not assessed |
| X2-S01 | Availability per capability | TBD | — | not assessed |
| X2-S02 | Ingestion may lag but never loses an accepted record | TBD | — | not assessed |
| X2-S03 | Admission sustains the design load, on the hottest link too, within its latency targets | TBD | — | not assessed |
| X2-S04 | Metering keeps up with the design volume of traffic | TBD | — | not assessed |
| X2-S05 | A single-link booking gets its final answer within ack_budget, whatever the booking's length | TBD | — | not assessed |
| X2-S06 | A route booking is acknowledged within ack_budget and has its outcome within its deadline | TBD | — | not assessed |
| X2-S07 | A top-up is credited within 10 s of the provider's notification | TBD | — | not assessed |
| X2-S08 | Suspension is enforced within 60 s of the decision | TBD | — | not assessed |
| X2-S09 | An acknowledged fact survives any single failure | TBD | — | not assessed |
| X2-S10 | Recovery time per capability | TBD | — | not assessed |
| X2-S11 | Records can be retrieved up to the end of the retention period | TBD | — | not assessed |

## Mapping from the previous baseline

Every scenario ID of the previous baseline (old IDs), and where its meaning went. "(removed)"
means the scenario specified a design or transport, not a need; its mechanism belongs to the
RFC that chooses it, and the need it served is covered by the scenarios named in the note.

| Old ID | New ID(s) | Note |
|---|---|---|
| P1-S01 | P1-S01 | Unchanged |
| P1-S02 | P1-S02 | Unchanged |
| P1-S03 | P1-S01, P1-S03 | Duplicate Given/When of S01 merged into P1-S01; the "room, not a free gap" meaning kept as P1-S03 with its own example |
| P1-S04 | P1-S04 | Unchanged; usage assertions replaced by booking outcomes |
| P1-S05 | P1-S05 | Restated as a universal invariant; harness numbers moved to the test plan |
| P1-S06 | P1-S21 | Restated against the rolling selling horizon (POL-09) |
| P1-S07 | P1-S23 | Unchanged in meaning |
| P1-S08 | P1-S06 | Unchanged in meaning; "peak usage" assertion removed |
| P1-S09 | X2-S05 | Moved to the NFR spec; test-rig numbers replaced by the POL-06 design load |
| P1-S10 | P1-S13, P1-S14 | "At least one admitted" replaced by never-oversold (S13) and one-at-a-time equivalence (S14) |
| P1-S11 | P1-S15 | Changed: peak usage replaced by the POL-10 counter-offer |
| P1-S12 | P1-S15, P1-S16 | Changed: sub-ranges not required by POL-10; replaced by largest rate and earliest window |
| P1-S13 | P1-S19 | Changed: rolling selling horizon, past and off-boundary starts; one defect per row |
| P1-S14 | P1-S20 | Changed: rolling selling horizon |
| P1-S15 | P1-S18 | Generalised to rejected, failed and invalid requests |
| P1-S16 | P2-S43, P1-S33 | Changed: cancellation per POL-08 (P2); history per POL-19 (P1) |
| P2-S01 | P2-S01 | Unchanged; "no hold left" (internal state) removed |
| P2-S02 | P2-S02 | Unchanged in meaning |
| P2-S03 | P1-S19 | Window validity owned by P1 for every booking |
| P2-S04 | P1-S07, P1-S09 | Hold mechanics moved to RFC-002; the need (capacity in flight counts, is not counted twice) stated in P1 |
| P2-S05 | P1-S04 | Covered by back-to-back bookings |
| P2-S06 | (removed) | Hold idempotency is design; moved to RFC-002. Need covered by P2-S24 to P2-S28 |
| P2-S07 | P2-S14 | Hold lapse is design; need stated as "capacity back by the deadline" (POL-26) |
| P2-S08 | P1-S07, P2-S17, P2-S18 | Three-outcome protocol moved to RFC-002 |
| P2-S09 | P2-S06, P2-S08, P2-S09 | Changed per POL-04 |
| P2-S10 | P2-S13 | Unchanged in meaning |
| P2-S11 | (removed) | Wake-ups are design; moved to RFC-002. Need covered by P2-S14, P2-S20 |
| P2-S12 | (removed) | As P2-S11 |
| P2-S13 | P2-S15, P2-S17 | Split per R-09: at least one wins (S15), rejected only if no fit (S17) |
| P2-S14 | P2-S16 | Wound-wait moved to RFC-002; the POL-02 rule stated as outcome |
| P2-S15 | (removed) | Commit-point protection is design; need covered by P2-S05 |
| P2-S16 | P2-S19 | Restated as a need: crossed requests settle before deadlines |
| P2-S17 | P2-S20 | Restated as a need: retries are eventually confirmed |
| P2-S18 | P2-S28 | Restated: Share's record matches the partner's |
| P2-S19 | P2-S30 | "Short random pause" removed |
| P2-S20 | P2-S31 | Unchanged in meaning |
| P2-S21 | (removed) | Partner hold lapse recovery is design; need covered by P2-S04 |
| P2-S22 | P2-S22, P2-S23 | Changed per POL-03: resume within the deadline, else fail |
| P2-S23 | P2-S22 | Changed per POL-03 |
| P2-S24 | (removed) | Design; need covered by P2-S04, P2-S23 |
| P2-S25 | (removed) | Design; need covered by P2-S04 |
| P2-S26 | (removed) | Design; need covered by P2-S04, P2-S23 |
| P2-S27 | (removed) | Design; need covered by P2-S04 |
| P2-S28 | P2-S24 | Unchanged |
| P2-S29 | P2-S25 | Unchanged |
| P2-S30 | P2-S26, X1-S08 | Unchanged within an account; cross-account case added in X1 |
| P2-S31 | P2-S27 | Restated without multi-process detail |
| P2-S32 | P1-S13, P2-S04 | Restated as invariants; "in memory" and sampling removed |
| P3-S01 | P3-S14 | Unchanged |
| P3-S02 | P3-S15 | Restated on charges only (balances are P4-S38) |
| P3-S03 | P3-S31 | Extended to every principal, attempts recorded |
| P3-S04 | P3-S18 | Changed per POL-13: minutes in which the flow was active |
| P3-S05 | P3-S18 | Changed per POL-13 |
| P3-S06 | P3-S21 | Changed per POL-11: rounded down |
| P3-S07 | (removed) | Watermark is design; charge timeliness has no POL-06 target (X2 open question 2) |
| P3-S08 | P3-S20 | Unchanged in meaning |
| P3-S09 | (removed) | Moot under POL-27: prices change only on minute boundaries |
| P3-S10 | P3-S34 | Changed: authorised, with operator and reason; either direction |
| P3-S11 | P3-S32 | Unchanged in meaning |
| P3-S12 | P3-S33 | Restated on charges (wallet is P4) |
| P3-S13 | P3-S16 | Unchanged |
| P3-S14 | P3-S17 | Restated as a need; worker counts removed |
| P3-S15 | P3-S17 | Merged into P3-S17 |
| P3-S16 | P3-S12 | Restated as a need |
| P3-S17 | P3-S37 | Changed: exposure formula moved to RFC; visibility required (POL-14) |
| P3-S18 | P4-S18 | Changed per POL-15/16: suspension when the hold cannot roll forward |
| P3-S19 | P4-S22 | Changed per POL-16: automatic resumption within grace |
| P3-S20 | P4-S19 | Changed per POL-14: the limit includes exposure |
| P3-S21 | P2-S38 | Changed per POL-15: funds hold at admission; owned by P2/P4 |
| P3-S22 | (removed) | Transport; the funds check is P2-S38 within ack_budget |
| P3-S23 | P4-S25 | Changed: at-least-once notification to network operations |
| P3-S24 | P3-S28, P3-S25, P3-S26 | Changed: kept with reason, never discarded; unknown reservation per POL-17 |
| P3-S25 | P3-S29 | Transport removed |
| P3-S26 | P3-S14, P3-S15 | Transport removed |
| P3-S27 | P3-S13 | Restated as a need |
| P4-S01 | P4-S01 | Unchanged; HTTP codes and "applied" counts removed |
| P4-S02 | P4-S02 | Changed per POL-21: held pending up to 72 h |
| P4-S03 | P4-S05 | One defect per row |
| P4-S04 | P4-S05 | Row "an amount of zero" |
| P4-S05 | P4-S04 | Unchanged |
| P4-S06 | X1-S10 | Moved to X1 |
| P4-S07 | P4-S17 | Transport removed; headroom per POL-18 in P4-S15, P4-S16 |
| P4-S08 | P4-S17 | Transport removed |
| P4-S09 | P4-S28 | Unchanged |
| P4-S10 | P4-S28 | Database detail removed |
| P4-S11 | P4-S29 | Changed: any principal, attempts recorded |
| P4-S12 | P4-S29 | As P4-S11 |
| P4-S13 | P4-S32, P4-S35 | Split rule per POL-12 |
| P4-S14 | P4-S39 | Restated per R-25 |
| P4-S15 | P4-S38 | Unchanged |
| P4-S16 | (removed) | Worked example of one method; moved to RFC-004. Webster example is P4-S35 |
| P4-S17 | P4-S32 | Unchanged |
| P4-S18 | P4-S35, P4-S37 | Changed per POL-12: Webster, with deviation reported |
| P4-S19 | P4-S33 | Restated as universal |
| P4-S20 | (removed) | Folded into P4-S33 |
| P4-S21 | P4-S39 | Merged with the late-amendment property |
| P4-S22 | P4-S34, P4-S36 | Changed per POL-12: Share loses ties |
| P4-S23 | P4-S43 | Changed per POL-22 |
| P4-S24 | P4-S42, P4-S48 | Changed per POL-22/23: debt only from supplier error |
| P4-S25 | P4-S05 | Wire format moved to the interface contract |
| P4-S26 | P4-S31 | Changed per POL-20 |

New scenarios with no predecessor: every new ID not listed in the second column above.
