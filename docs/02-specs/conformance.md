# Conformance matrix

This matrix records, for every scenario in `02-specs/*.feature`, which design element
satisfies it, which tests show it, and whether it is met. It is filled in at the
**conformance stage, after design**: the RFCs are being rewritten to satisfy the
requirements, and the code will then be changed to conform. Until then every row is
`not assessed` and every Design cell is `TBD`.

The matrix is regenerated whenever scenarios change; it reflects the specs as aligned
with the consolidated [policy register](policy-register.md) of 2026-10-11 (see also the
requirements-gate resolution records [02](../reviews/02-requirements-gate-resolution.md)
and [03](../reviews/03-requirements-gate-resolution.md), the final-gate resolution
record [04](../reviews/04-requirements-final-resolution.md), and the amendments from the
architecture review [05](../reviews/05-requirements-amendments-from-architecture.md)). Rows are in file order, which is Rule order; new IDs are numbered after each
file's previous highest ID.

The `.feature` files never carry verification status, test names or defect notes; they
live only here. Status values, once assessed: `met`, `partly met` (for example met on one
path only), `not met`. A scenario met only on some paths is never `met`.

Tests marked *prior evidence, to be re-validated* are the citations the previous baseline
gave for a scenario with the same ID. They show what the prototype once checked; they do
not establish conformance, and where the scenario's meaning has changed since (for
example P2-S15, P2-S16 and P2-S19 under POL-02) they may no longer apply.
Generators, seeds, client counts and fault rates used by such tests belong in the test
plan, not in the scenario.

## Matrix

| Scenario | Title | Design | Tests | Status |
|---|---|---|---|---|
| P1-S01 | A booking is confirmed exactly when the peak leaves room for it | TBD | `test/tree.test.ts` › "exact fit to capacity is admitted, one more Mbps is not" *(prior evidence, to be re-validated)* | not assessed |
| P1-S02 | Reservations that never coexist do not add up | TBD | `test/tree.test.ts` › "A/B: summing overlaps would reject, the peak admits" *(prior evidence, to be re-validated)*<br>`test/sql.test.ts` › "SQL: touching intervals and the A/B example" *(prior evidence, to be re-validated)* | not assessed |
| P1-S03 | A booking needs room, not a completely free gap | TBD | `test/tree.test.ts` › "exact fit to capacity is admitted, one more Mbps is not" *(prior evidence, to be re-validated)* | not assessed |
| P1-S04 | Back-to-back bookings each get the whole link | TBD | `test/tree.test.ts` › "touching intervals [a, b) and [b, c) do not overlap" *(prior evidence, to be re-validated)*<br>`test/sql.test.ts` › "SQL: touching intervals and the A/B example" *(prior evidence, to be re-validated)* | not assessed |
| P1-S05 | A booking is confirmed only if the link has room for it, beside every hold, when it is confirmed | TBD | `test/sql.test.ts` › "property: tree, SQL and brute-force array agree on every decision" *(prior evidence, to be re-validated)* | not assessed |
| P1-S37 | A booking is rejected for no fit only if it does not fit beside what is committed | TBD | — | not assessed |
| P1-S06 | A year-long booking is checked at every minute of its window | TBD | `test/tree.test.ts` › "a year-long booking is two point updates" *(prior evidence, to be re-validated)* | not assessed |
| P1-S07 | Capacity held for a pending request is not sold to anyone else; the next booking waits | TBD | — | not assessed |
| P1-S08 | Capacity held for a request that ends without confirmation is free again at once | TBD | — | not assessed |
| P1-S09 | Confirming a pending request does not count its capacity twice | TBD | — | not assessed |
| P1-S10 | A single-link booking is decided against capacity confirmed for routes | TBD | — | not assessed |
| P1-S11 | A single-link booking blocked only by capacity in flight waits, and is confirmed if that capacity is released within its deadline | TBD | — | not assessed |
| P1-S12 | A single-link booking that asks not to wait is rejected at once with retry_after | TBD | — | not assessed |
| P1-S34 | A single-link booking still waiting after ack_budget is answered pending | TBD | — | not assessed |
| P1-S13 | Concurrent bookings never oversell the link | TBD | `test/concurrency.test.ts` › "safe admission never oversells a hot link under 50 concurrent clients" *(prior evidence, to be re-validated)*<br>`test/routes.test.ts` › "randomised contention (seed 11/12/13): never oversold, competitors never all lose, all sagas finish" *(prior evidence, to be re-validated)* | not assessed |
| P1-S14 | Concurrent decisions are those of some one-at-a-time order | TBD | — | not assessed |
| P1-S15 | A rejection states the largest rate that fits the requested window | TBD | — | not assessed |
| P1-S16 | A rejection states the earliest window of the requested length that fits the requested rate | TBD | — | not assessed |
| P1-S17 | A rejection discloses nothing about other buyers | TBD | — | not assessed |
| P1-S38 | When nothing fits, the rejection says so | TBD | — | not assessed |
| P1-S18 | A request that was not confirmed leaves the link as if it had never been made | TBD | `test/sql.test.ts` › "SQL: touching intervals and the A/B example" *(prior evidence, to be re-validated)*<br>`test/sql.test.ts` › "property: tree, SQL and brute-force array agree on every decision" *(prior evidence, to be re-validated)* | not assessed |
| P1-S19 | A malformed request is invalid, not a capacity answer | TBD | — | not assessed |
| P1-S20 | A window that reaches the edge of what is sold is valid | TBD | — | not assessed |
| P1-S39 | A rate above the link's capacity is rejected with a counter-offer, not invalid | TBD | — | not assessed |
| P1-S21 | An open-ended reservation takes its rate at every minute up to the horizon | TBD | `test/tree.test.ts` › "open-ended reservation blocks the rest of the horizon" *(prior evidence, to be re-validated)* | not assessed |
| P1-S22 | Minutes that become sellable are taken by the open-ended reservation before any new sale | TBD | — | not assessed |
| P1-S23 | A booking that ends where an open-ended reservation starts gets the whole link | TBD | `test/tree.test.ts` › "open-ended reservation blocks the rest of the horizon" *(prior evidence, to be re-validated)* | not assessed |
| P1-S24 | New bookings are decided against the reduced capacity at once | TBD | — | not assessed |
| P1-S25 | Every reservation is affected at the minutes where the committed rate exceeds the reduced capacity, and stays confirmed | TBD | — | not assessed |
| P1-S26 | The holders of affected reservations and network operations are told within affected_notice_time | TBD | — | not assessed |
| P1-S27 | Restored capacity is sellable again | TBD | — | not assessed |
| P1-S40 | When capacity is restored, the affected flag ends and the holders are told | TBD | — | not assessed |
| P1-S48 | An outage that leaves capacity at or above what is committed affects no reservation | TBD | — | not assessed |
| P1-S49 | While an outage lasts, bookings far ahead are decided against the reduced capacity too | TBD | — | not assessed |
| P1-S50 | A reservation that starts during an outage is flagged at the minutes it is affected, and its holder is told when it starts | TBD | — | not assessed |
| P1-S41 | A pending request that no longer fits the reduced capacity is rejected, not confirmed | TBD | — | not assessed |
| P1-S42 | A waiting request is decided against the reduced capacity | TBD | — | not assessed |
| P1-S28 | Maintenance that fits on free capacity is booked | TBD | — | not assessed |
| P1-S29 | Maintenance that needs committed capacity is rejected | TBD | — | not assessed |
| P1-S30 | Maintenance booked with less than the required notice is rejected | TBD | — | not assessed |
| P1-S51 | Works carried out on sold capacity anyway are an unplanned outage attributed to the supplier | TBD | — | not assessed |
| P1-S31 | Only the buyer who would otherwise not fit is offered an equivalent path, on the terms of POL-07 | TBD | — | not assessed |
| P1-S35 | An accepted offer moves the reservation to the equivalent path, at the lower of its original price and the path's price, when the notice ends | TBD | — | not assessed |
| P1-S36 | A declined offer means revocation when the notice ends | TBD | — | not assessed |
| P1-S45 | An offer not answered within offer_window counts as declined | TBD | — | not assessed |
| P1-S32 | Without an equivalent path, the newest reservation is revoked when the notice ends | TBD | — | not assessed |
| P1-S43 | During the notice, new sales are decided against the reduced capacity | TBD | — | not assessed |
| P1-S44 | A reservation to be revoked keeps its capacity until the notice ends | TBD | — | not assessed |
| P1-S46 | Each added part of a reservation has its own age | TBD | — | not assessed |
| P1-S47 | Only just enough Mbps are taken from the newest part, and its holder may then cancel without fee | TBD | — | not assessed |
| P1-S52 | When part of a reservation is affected, the equivalent path is offered for all of it | TBD | — | not assessed |
| P1-S53 | The holder of an accepted offer may move before the notice ends, from a minute boundary it chooses | TBD | — | not assessed |
| P1-S33 | The schedule as known at a past time includes reservations changed since | TBD | — | not assessed |
| P2-S01 | A route whose every leg fits is confirmed on every leg | TBD | `test/routes.test.ts` › "a route across our links and the partner is confirmed; every leg becomes a fact" *(prior evidence, to be re-validated)* | not assessed |
| P2-S02 | A route with a leg that does not fit is rejected, naming that leg, and holds nothing | TBD | `test/routes.test.ts` › "a leg that cannot fit rejects the route, names the link, and releases every hold" *(prior evidence, to be re-validated)* | not assessed |
| P2-S03 | Confirmed is never reported before every leg, the partner's included, is secured | TBD | — | not assessed |
| P2-S04 | Whatever fails, a route never ends booked on some legs only | TBD | — | not assessed |
| P2-S05 | A confirmed route ends only at its account's request or by Share's decision under the supply-loss, suspension and termination policies | TBD | — | not assessed |
| P2-S06 | Every booking request gets a response within ack_budget | TBD | — | not assessed |
| P2-S07 | A request whose outcome is known within ack_budget gets its final outcome | TBD | — | not assessed |
| P2-S08 | A request whose outcome is not yet known is pending, and the outcome can be polled with its idempotency key | TBD | — | not assessed |
| P2-S09 | A buyer who registered a webhook is sent the outcome | TBD | — | not assessed |
| P2-S10 | An outcome never changes once reported | TBD | — | not assessed |
| P2-S99 | A status read never contradicts the decided outcome, and reflects it within status_staleness | TBD | — | not assessed |
| P2-S11 | A request without a deadline gets the default deadline | TBD | — | not assessed |
| P2-S12 | A deadline outside its bounds is invalid | TBD | — | not assessed |
| P2-S86 | A deadline at the edge of its bounds is valid | TBD | — | not assessed |
| P2-S13 | A request whose partner never answers has failed by its deadline and holds nothing | TBD | — | not assessed |
| P2-S55 | A request with a partner leg does not begin committing later than its deadline less commit_margin | TBD | — | not assessed |
| P2-S14 | Capacity held for a request that is not confirmed is free on Share links at once, and at a partner by the deadline | TBD | — | not assessed |
| P2-S93 | Share releases every hold of a request at its deadline, a partner hold included | TBD | — | not assessed |
| P2-S100 | Share sets a partner hold to expire at the request's deadline | TBD | — | not assessed |
| P2-S101 | Capacity held at a partner lapses at the deadline even when Share is unavailable then | TBD | — | not assessed |
| P2-S56 | A buyer may withdraw a pending request | TBD | — | not assessed |
| P2-S57 | Withdrawing a request after its partner leg without holds was booked cancels that leg at Share's cost | TBD | — | not assessed |
| P2-S15 | Competing requests that wait do not all lose | TBD | `test/routes.test.ts` › "randomised contention (seed 11/12/13): never oversold, competitors never all lose, all sagas finish" *(prior evidence, to be re-validated)* | not assessed |
| P2-S16 | Under the request_age rule, the oldest waiting request gets capacity that is released | TBD | — | not assessed |
| P2-S58 | A request already holding capacity is not pre-empted by an older one | TBD | — | not assessed |
| P2-S17 | A request that waits is rejected for no fit only if it does not fit on committed capacity | TBD | — | not assessed |
| P2-S18 | A request that asks not to wait is rejected at once with retry_after when capacity it needs is in flight | TBD | — | not assessed |
| P2-S59 | A request that asked not to wait is outside the contention guarantee | TBD | — | not assessed |
| P2-S61 | A request whose deadline is shorter than the outcome it waits on is outside the contention guarantee | TBD | — | not assessed |
| P2-S95 | A waiter with a partner leg whose deadline, less commit_margin, has passed when the request ahead fails is outside the contention guarantee | TBD | — | not assessed |
| P2-S62 | Losses caused by failures leave nothing held and tell each buyer why | TBD | — | not assessed |
| P2-S19 | In a crossing, the older request keeps its holds and the younger releases its conflicting holds and waits | TBD | `test/routes.test.ts` › "crossed sagas: priority tickets resolve the deadlock at once (D17)" *(prior evidence, to be re-validated)* | not assessed |
| P2-S60 | The younger request of a crossing is confirmed if the older then ends without confirmation | TBD | — | not assessed |
| P2-S87 | A cycle of three waiting requests is broken, and the oldest is confirmed before any deadline | TBD | — | not assessed |
| P2-S88 | In a broken cycle, the next oldest is confirmed if the oldest then ends without confirmation | TBD | — | not assessed |
| P2-S97 | A request that yields in a crossing keeps its place among waiters | TBD | — | not assessed |
| P2-S20 | A contended request waits, pending, and is confirmed if the capacity in flight is released within its deadline | TBD | — | not assessed |
| P2-S52 | A waiting request whose capacity is then confirmed to the request ahead of it is rejected with a counter-offer | TBD | — | not assessed |
| P2-S21 | Changing the priority rule does not change the outcome of uncontended requests | TBD | — | not assessed |
| P2-S22 | An interrupted request that can still finish within its deadline is resumed | TBD | — | not assessed |
| P2-S23 | An interrupted request that cannot finish within its deadline fails, releases everything and says why | TBD | — | not assessed |
| P2-S24 | The same request sent twice at once is booked once | TBD | `test/routes.test.ts` › "idempotency: retries with the same key never book twice" *(prior evidence, to be re-validated)* | not assessed |
| P2-S25 | A retry after the outcome returns the original outcome, even after a restart | TBD | `test/routes.test.ts` › "idempotency: retries with the same key never book twice" *(prior evidence, to be re-validated)* | not assessed |
| P2-S26 | A different request under a key already used is not accepted | TBD | `test/routes.test.ts` › "idempotency: retries with the same key never book twice" *(prior evidence, to be re-validated)* | not assessed |
| P2-S63 | A retry that differs only in its deadline is the same request | TBD | — | not assessed |
| P2-S64 | A key reused by another principal of the same account is not accepted, and learns nothing | TBD | — | not assessed |
| P2-S65 | After idempotency_retention a key identifies a new request | TBD | — | not assessed |
| P2-S27 | A retry while the request is pending returns its current status | TBD | — | not assessed |
| P2-S28 | Retried partner calls never book the partner twice | TBD | `test/routes.test.ts` › "randomised contention (seed 11/12/13): never oversold, competitors never all lose, all sagas finish" *(prior evidence, to be re-validated)* | not assessed |
| P2-S29 | Share never confirms a leg the partner has not confirmed | TBD | — | not assessed |
| P2-S30 | A transient partner refusal does not end the request before its deadline | TBD | — | not assessed |
| P2-S31 | A definite partner refusal rejects the route, naming the partner link, when no other Share request holds capacity there | TBD | — | not assessed |
| P2-S89 | A partner refusal while Share's own request holds overlapping capacity at that partner is contention: the refused request waits and asks again | TBD | — | not assessed |
| P2-S32 | Every partner is fully reconciled daily, and each mismatch alerts operations | TBD | — | not assessed |
| P2-S90 | A partner call whose result is unknown is reconciled for that booking at once | TBD | — | not assessed |
| P2-S91 | A mismatch found in reconciliation is resolved without charging the buyer for it | TBD | — | not assessed |
| P2-S33 | A partner without holds is booked only after every other leg and the funds are secured | TBD | — | not assessed |
| P2-S34 | A route with two legs on partners without holds is rejected before anything is held | TBD | — | not assessed |
| P2-S35 | A failure after the partner without holds was booked cancels it at Share's cost | TBD | — | not assessed |
| P2-S96 | A partner refusal caused by Share's own booking for an undecided request is contention: the refused request waits and asks again | TBD | — | not assessed |
| P2-S36 | A partner whose holds are too short counts as a partner without holds | TBD | — | not assessed |
| P2-S102 | A partner that does not accept a hold expiry set by Share counts as a partner without holds | TBD | — | not assessed |
| P2-S37 | A route over two partners with holds of different lengths is all or nothing | TBD | — | not assessed |
| P2-S38 | A booking the account cannot fund is rejected, stating the payment needed | TBD | — | not assessed |
| P2-S39 | A booking beyond an agent key's spending limit is rejected; key spending is counted over the period | TBD | — | not assessed |
| P2-S40 | A booking beyond a limit on capacity in flight is rejected | TBD | — | not assessed |
| P2-S54 | A new account can have capacity in flight up to account_inflight_floor | TBD | — | not assessed |
| P2-S66 | Capacity in flight is counted once per request, at its reserved rate, whatever the number of legs | TBD | — | not assessed |
| P2-S98 | The account's limit on capacity in flight grows with its largest confirmed reservation | TBD | — | not assessed |
| P2-S41 | Booking requests above a rate limit are not accepted, and the key may be used again | TBD | — | not assessed |
| P2-S67 | Status polls above key_poll_limit are not accepted | TBD | — | not assessed |
| P2-S68 | Status polls do not count toward booking rate limits; retries do | TBD | — | not assessed |
| P2-S42 | A suspended account cannot book, and is told the amount that would resume it | TBD | — | not assessed |
| P2-S69 | A request not yet decided when its account is suspended is not confirmed | TBD | — | not assessed |
| P2-S70 | Concurrent bookings by one account are funded as if decided one at a time | TBD | — | not assessed |
| P2-S71 | Concurrent bookings by one agent key never together exceed its limits | TBD | — | not assessed |
| P2-S92 | A request holds no capacity until its funds hold is taken | TBD | — | not assessed |
| P2-S72 | Revoking an agent key fails its pending requests and leaves its reservations with the account | TBD | — | not assessed |
| P2-S103 | An event after a request's decision does not change its outcome, even while its status still reads pending | TBD | — | not assessed |
| P2-S73 | A route counter-offer fits every leg, not only the blocking one | TBD | — | not assessed |
| P2-S43 | A cancellation takes effect at the next minute boundary on every leg | TBD | — | not assessed |
| P2-S44 | Shortening cancels the remaining part | TBD | — | not assessed |
| P2-S45 | An extension is decided against capacity for the added period only | TBD | — | not assessed |
| P2-S46 | A rejected extension leaves the reservation as it was | TBD | — | not assessed |
| P2-S47 | A rate increase is decided against capacity for the difference only, from the next minute boundary to the end | TBD | — | not assessed |
| P2-S74 | A rejected rate increase leaves the reservation as it was | TBD | — | not assessed |
| P2-S48 | A rate decrease takes effect at the next minute boundary | TBD | — | not assessed |
| P2-S49 | A change to part of a route is rejected | TBD | — | not assessed |
| P2-S50 | A partner leg's minimum term and cancellation fee are shown at booking | TBD | — | not assessed |
| P2-S75 | An extension the account cannot fund is rejected, stating the payment needed, and the reservation is unchanged | TBD | — | not assessed |
| P2-S76 | A change beyond the agent key's headroom is rejected and the reservation is unchanged | TBD | — | not assessed |
| P2-S77 | A suspended account can still reduce what it has | TBD | — | not assessed |
| P2-S78 | A suspended account cannot add to a reservation | TBD | — | not assessed |
| P2-S79 | Concurrent changes to one reservation are applied one at a time, in arrival order | TBD | — | not assessed |
| P2-S81 | A cancellation is never delayed by a pending change, which then fails | TBD | — | not assessed |
| P2-S94 | A shortening to the next minute boundary is a cancellation; any other shortening waits its turn | TBD | — | not assessed |
| P2-S80 | A change still pending when its reservation is ended by Share is not confirmed | TBD | — | not assessed |
| P2-S82 | A cancellation over a partner leg takes effect for the buyer whatever the partner answers | TBD | — | not assessed |
| P2-S83 | An extension or increase over a partner leg is confirmed on every leg or leaves the reservation unchanged | TBD | — | not assessed |
| P2-S84 | Renewals, short shortenings and extensions past the horizon follow the change rules | TBD | — | not assessed |
| P2-S85 | An open-ended reservation can be given an end, or cancelled before it starts | TBD | — | not assessed |
| P2-S51 | A failed request is visible to operations with its reason | TBD | — | not assessed |
| P2-S53 | A request still pending at its deadline raises an operational alert | TBD | — | not assessed |
| P3-S01 | An active minute accrues whether or not traffic crosses it | TBD | — | not assessed |
| P3-S02 | A part minute is charged as a whole minute | TBD | — | not assessed |
| P3-S03 | There is no minimum term | TBD | — | not assessed |
| P3-S04 | Accrual stops at the minute a cancellation takes effect | TBD | — | not assessed |
| P3-S05 | A rate decrease is accrued at the new rate from its effective minute | TBD | — | not assessed |
| P3-S06 | A reservation keeps the price it was booked at | TBD | — | not assessed |
| P3-S07 | An open-ended reservation's price changes only after price_notice, at a minute boundary | TBD | — | not assessed |
| P3-S08 | A revoked reservation accrues nothing after the revocation takes effect | TBD | — | not assessed |
| P3-S09 | A suspended account's reservation accrues during the grace, and not after its release | TBD | — | not assessed |
| P3-S10 | A reservation affected by an unplanned outage keeps accruing and is marked for credit | TBD | — | not assessed |
| P3-S40 | An extension's added part accrues at the price in force when it was made; the existing part keeps its price | TBD | — | not assessed |
| P3-S42 | A terminated reservation accrues nothing after its termination, and what it accrued stands | TBD | — | not assessed |
| P3-S45 | A rate increase's added part accrues at the price in force when it was made | TBD | — | not assessed |
| P3-S46 | A decrease removes the most recently added part first | TBD | — | not assessed |
| P3-S47 | A planned maintenance booking accrues nothing and is excluded from rating and settlement | TBD | — | not assessed |
| P3-S58 | A reservation whose rate is cut under a permanent reduction accrues at the cut rate from the end of the notice | TBD | — | not assessed |
| P3-S59 | A reservation moved to an equivalent path accrues at the lower of its original price and the new path's price | TBD | — | not assessed |
| P3-S11 | A partner cancellation fee is charged only if it was shown at booking | TBD | — | not assessed |
| P3-S43 | A partner minimum term is charged as a cancellation fee on early cancellation | TBD | — | not assessed |
| P3-S44 | Who pays a shown cancellation fee depends on who ended the reservation early | TBD | — | not assessed |
| P3-S60 | A cancellation fee is a charge line of its own, charged at exactly its shown amount and once | TBD | — | not assessed |
| P3-S12 | A minute is charged once however charging is repeated | TBD | — | not assessed |
| P3-S13 | Charging that is interrupted or restarted charges every record not yet charged, once | TBD | — | not assessed |
| P3-S14 | A record delivered twice is counted once | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" *(prior evidence, to be re-validated)*<br>`billing/test/kafka.e2e.test.ts` › "duplicated records on Kafka are ingested once and rated into a balanced ledger" *(prior evidence, to be re-validated)* | not assessed |
| P3-S15 | Any delivery order, duplication and lateness gives the same charges as in-order delivery | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" *(prior evidence, to be re-validated)*<br>`billing/test/kafka.e2e.test.ts` › "duplicated records on Kafka are ingested once and rated into a balanced ledger" *(prior evidence, to be re-validated)* | not assessed |
| P3-S16 | A repeat of a record already charged causes no amendment | TBD | — | not assessed |
| P3-S17 | A record arriving while its minute is being charged is neither lost nor counted twice | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › concurrent ingestion and rating lose no record (the minute lock)" *(prior evidence, to be re-validated)*<br>`billing/test/rating.test.ts` › "rating and ledger (D18–D20) › a record that races its minute being rated is still charged (forced interleaving)" *(prior evidence, to be re-validated)* | not assessed |
| P3-S50 | A record from an exporter whose sequence numbers restarted is not mistaken for an earlier record | TBD | — | not assessed |
| P3-S48 | One account's traffic on two routes in the same minute gives two charge lines, each rounded once | TBD | — | not assessed |
| P3-S49 | Traffic reported by several legs is billed once, at the egress count | TBD | — | not assessed |
| P3-S18 | A record within one minute belongs to that minute; minutes are half-open | TBD | — | not assessed |
| P3-S19 | A record spanning several minutes is spread in proportion to the seconds active in each | TBD | — | not assessed |
| P3-S51 | A proportion that is not a whole number of bytes is priced exactly, and each minute's charge rounded once | TBD | — | not assessed |
| P3-S20 | A late record is priced at the price of its own minute | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › a late record is priced at the rate of its own event time, not of its arrival" *(prior evidence, to be re-validated)* | not assessed |
| P3-S21 | A charge is computed exactly and rounded once, down to the micro | TBD | — | not assessed |
| P3-S52 | A record spread across a price change prices each part at its own minute's price | TBD | — | not assessed |
| P3-S22 | Traffic within the reserved rate is covered by the reservation's accrual | TBD | — | not assessed |
| P3-S23 | Permitted burst is billed at usage_price for the excess only | TBD | — | not assessed |
| P3-S54 | Burst is measured per minute, not per second | TBD | — | not assessed |
| P3-S24 | Traffic above the reserved rate on a product without burst is dropped and not billed | TBD | — | not assessed |
| P3-S41 | Excess carried despite policing on a product without burst is not billed to the buyer, and raises an incident | TBD | — | not assessed |
| P3-S25 | Attributable traffic outside an active reservation is billed at usage_price and counts toward usage exposure | TBD | — | not assessed |
| P3-S53 | A record spread across the end of a reservation is covered for the minute inside it and billed for the minute outside | TBD | — | not assessed |
| P3-S26 | Traffic that cannot be attributed is quarantined, not billed, and reported | TBD | — | not assessed |
| P3-S27 | Quarantined traffic is billed, and its supplier paid, only if attributed within dispute_window | TBD | — | not assessed |
| P3-S28 | A record that cannot be used is kept with its reason and not charged | TBD | — | not assessed |
| P3-S29 | A record that cannot be used does not delay the records behind it | TBD | — | not assessed |
| P3-S30 | A kept record that is corrected is charged once | TBD | — | not assessed |
| P3-S31 | An accepted record is never altered or removed | TBD | — | not assessed |
| P3-S32 | A late record for a charged minute adds an amendment, computed on the line's new total, and leaves the charge as it was | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › a late record is priced at the rate of its own event time, not of its arrival" *(prior evidence, to be re-validated)*<br>`billing/test/rating.test.ts` › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" *(prior evidence, to be re-validated)* | not assessed |
| P3-S33 | Late traffic never decreases a charge | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" *(prior evidence, to be re-validated)* | not assessed |
| P3-S34 | A price correction lowering a price is an amendment, with who made it, the cause and the reason | TBD | — | not assessed |
| P3-S55 | A price correction raising a best-effort price is an amendment upward | TBD | — | not assessed |
| P3-S56 | A reservation price locked at booking can only be corrected downwards | TBD | — | not assessed |
| P3-S57 | A price correction after dispute_window is refused | TBD | — | not assessed |
| P3-S35 | A buyer can see, for any minute, the original charge and every amendment with its reason | TBD | — | not assessed |
| P3-S36 | Recomputing any period gives exactly the recorded charges and amendments | TBD | — | not assessed |
| P3-S37 | The business can see each account's usage exposure, in its two parts | TBD | — | not assessed |
| P3-S38 | A record later than max_lateness is still charged and reported as a breach | TBD | — | not assessed |
| P3-S61 | An accepted record counts in unposted usage from within attribution_lag_max of its acceptance until it is posted | TBD | — | not assessed |
| P3-S62 | A record counted in unposted usage later than attribution_lag_max after its acceptance is reported as a breach | TBD | — | not assessed |
| P3-S39 | Accepted records can be retrieved by reservation, link and minute | TBD | — | not assessed |
| P4-S01 | Repeated and reordered notifications change the wallet once per transaction | TBD | `billing/test/wallet.test.ts` › "payment webhooks (D19 wallet) › repeated and out-of-order webhooks credit the wallet exactly once" *(prior evidence, to be re-validated)* | not assessed |
| P4-S02 | A reversal arriving before its payment is held and matched | TBD | — | not assessed |
| P4-S03 | A reversal whose payment does not arrive within 72 h is escalated, never applied | TBD | — | not assessed |
| P4-S04 | A redelivery whose contents differ from the original moves no money and is reported | TBD | — | not assessed |
| P4-S05 | A malformed notification moves no money | TBD | `billing/test/wallet.test.ts` › "payment webhooks (D19 wallet) › malformed webhooks are rejected by the validation pipe" *(prior evidence, to be re-validated)* | not assessed |
| P4-S57 | Every money-moving input moves money once, however often it is delivered or submitted | TBD | — | not assessed |
| P4-S99 | A source reference reused by a different principal is refused and moves no money | TBD | — | not assessed |
| P4-S100 | A money-moving input redelivered long after the booking retention still moves nothing | TBD | — | not assessed |
| P4-S06 | A KES top-up is credited at the rate shown before the buyer confirmed, rounded up to the micro | TBD | — | not assessed |
| P4-S103 | The difference between the micros credited and the partner's USD amount is posted to Share's own account | TBD | — | not assessed |
| P4-S58 | A payment arriving after fx_quote_validity is credited at the partner's rate at notification | TBD | — | not assessed |
| P4-S07 | A provider amount in USD converts exactly into micros | TBD | — | not assessed |
| P4-S08 | Confirming a reservation holds funds for the coverage window, without charging them | TBD | — | not assessed |
| P4-S09 | A reservation shorter than the coverage window is held in full | TBD | — | not assessed |
| P4-S59 | A reservation that starts in the future has its first window held from admission until it starts | TBD | — | not assessed |
| P4-S10 | Charges accrue against the hold, and the hold rolls forward | TBD | — | not assessed |
| P4-S60 | The hold follows every change to the reservation | TBD | — | not assessed |
| P4-S11 | The unused hold is released when a reservation ends early | TBD | — | not assessed |
| P4-S61 | The hold is released when Share ends a reservation | TBD | — | not assessed |
| P4-S62 | An open-ended reservation's hold is resized when its new price takes effect | TBD | — | not assessed |
| P4-S63 | The hold is the larger of the coverage and a partner cancellation fee | TBD | — | not assessed |
| P4-S96 | The fee part of a hold ends with the partner's minimum term | TBD | — | not assessed |
| P4-S12 | A booking that is not confirmed holds no funds | TBD | — | not assessed |
| P4-S13 | A credit-limit account's reservation takes a credit hold, counted as funds held | TBD | — | not assessed |
| P4-S14 | A credit-limit account is invoiced monthly for its posted charges, due in invoice_terms | TBD | — | not assessed |
| P4-S66 | Holds for concurrent bookings never together exceed what headroom allowed | TBD | — | not assessed |
| P4-S15 | The headline figure is available headroom, net of funds held and usage exposure | TBD | — | not assessed |
| P4-S16 | The itemised answer adds up to the headline | TBD | — | not assessed |
| P4-S17 | The ledger balance shown equals the ledger | TBD | `billing/test/kafka.e2e.test.ts` › "request-reply: @MessagePattern answers a wallet balance query over Kafka" *(prior evidence, to be re-validated)* | not assessed |
| P4-S55 | An agent key sees its own headroom, the lower of the account's headroom and its remaining spending limit | TBD | — | not assessed |
| P4-S68 | A key's spending is counted over the period, each minute once | TBD | — | not assessed |
| P4-S98 | A negative key headroom blocks only that key's new bookings and additions | TBD | — | not assessed |
| P4-S18 | An account is suspended when its headroom would fall below zero, or its invoice is overdue | TBD | — | not assessed |
| P4-S19 | Suspension comes before any account can owe more than its headroom allows | TBD | — | not assessed |
| P4-S20 | A suspended account's reservations keep their capacity during the grace | TBD | — | not assessed |
| P4-S64 | During suspension the hold does not roll forward; charges are taken from it | TBD | — | not assessed |
| P4-S21 | A suspended account's usage-priced traffic is blocked | TBD | — | not assessed |
| P4-S22 | A top-up of at least the resume amount resumes the account automatically | TBD | — | not assessed |
| P4-S23 | At the end of the grace the reservations are released and the buyer is told | TBD | — | not assessed |
| P4-S24 | The buyer is warned when headroom falls below low_balance_warning, with the top-up quoted | TBD | — | not assessed |
| P4-S69 | The buyer is warned once per crossing, not repeatedly | TBD | — | not assessed |
| P4-S70 | After a reversal leaves the hold unfunded, reservations are still kept for the full grace, at Share's risk | TBD | — | not assessed |
| P4-S65 | A top-up racing a suspension ends in the standing the final headroom implies | TBD | — | not assessed |
| P4-S97 | At release, a shown cancellation fee is charged against what is left of the hold, and any shortfall is a negative balance | TBD | — | not assessed |
| P4-S101 | A price change whose larger hold the headroom cannot cover still takes effect, and the account is suspended as for a failed roll-forward | TBD | — | not assessed |
| P4-S25 | Each change of standing is delivered at least once, within standing_notice_time, and repeats change nothing | TBD | — | not assessed |
| P4-S26 | The current standing can be asked for at any time | TBD | — | not assessed |
| P4-S27 | Enforcement later than its target is reported | TBD | — | not assessed |
| P4-S28 | Every money movement, and the ledger in each currency, sums to zero | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" *(prior evidence, to be re-validated)*<br>`billing/test/wallet.test.ts` › "payment webhooks (D19 wallet) › repeated and out-of-order webhooks credit the wallet exactly once" *(prior evidence, to be re-validated)*<br>`billing/test/rating.test.ts` › "rating and ledger (D18–D20) › the database refuses unbalanced journals and edits to the ledger" *(prior evidence, to be re-validated)* | not assessed |
| P4-S29 | No money movement can be altered or removed by anyone | TBD | — | not assessed |
| P4-S30 | A correction is a new money movement that refers to the one it corrects | TBD | — | not assessed |
| P4-S31 | Every amount carries its currency, and a money movement is in one currency | TBD | — | not assessed |
| P4-S71 | Every money movement refers to the fact that caused it | TBD | — | not assessed |
| P4-S72 | Any account's past balance, holds and headroom can be rebuilt from recorded facts | TBD | — | not assessed |
| P4-S32 | Shares add up exactly to the charge | TBD | `billing/test/split.test.ts` › "split (D20) › shares always sum exactly to the amount" *(prior evidence, to be re-validated)* | not assessed |
| P4-S33 | A larger charge never lowers any party's share | TBD | `billing/test/split.test.ts` › "split (D20) › house-monotone: a larger amount never lowers any share" *(prior evidence, to be re-validated)* | not assessed |
| P4-S34 | The split depends only on the amount and the weights | TBD | — | not assessed |
| P4-S35 | Shares follow the Webster rule | TBD | — | not assessed |
| P4-S36 | Share's commission loses every tie | TBD | — | not assessed |
| P4-S73 | Ties among suppliers are broken in route leg order, first leg first | TBD | — | not assessed |
| P4-S102 | A supplier with several legs on a route is one party, its legs' weights summed, in the tie position of its first leg | TBD | — | not assessed |
| P4-S74 | Each usage charge line is split among the parties of its own route | TBD | — | not assessed |
| P4-S75 | An amendment is split as the split of the line's new total less the shares already posted | TBD | — | not assessed |
| P4-S85 | After a correction borne by Share, a later amendment to the same line is split on its own | TBD | — | not assessed |
| P4-S37 | Cumulative deviation from exact proportions is reported per party per payout period | TBD | — | not assessed |
| P4-S38 | Every account ends at the split of each line's final total, whatever the arrival order | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" *(prior evidence, to be re-validated)* | not assessed |
| P4-S39 | A late-traffic amendment never reduces any party's amount and never credits the buyer | TBD | `billing/test/rating.test.ts` › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" *(prior evidence, to be re-validated)*<br>`billing/test/rating.test.ts` › "rating and ledger (D18–D20) › late usage never claws back a supplier, even where largest remainder would (Alabama paradox)" *(prior evidence, to be re-validated)* | not assessed |
| P4-S40 | A supplier's statement shows each share, how it was produced, and everything else that moved its balance | TBD | — | not assessed |
| P4-S76 | A buyer's statement shows every movement of its money, with reasons and rates | TBD | — | not assessed |
| P4-S41 | A correction caused by Share's error is borne by Share in full | TBD | — | not assessed |
| P4-S84 | A correction whose cause is "other" is borne by Share, as for a Share error | TBD | — | not assessed |
| P4-S42 | A supplier-caused error makes only that supplier owe its own reduction | TBD | — | not assessed |
| P4-S56 | Excess carried despite policing is paid to the route's suppliers by Share, split as the buyer's charge would have been | TBD | — | not assessed |
| P4-S77 | Every cost Share bears is paid from Share's own account to the supplier concerned | TBD | — | not assessed |
| P4-S89 | A cancellation fee charged to a buyer goes wholly to the partner that imposed it | TBD | — | not assessed |
| P4-S43 | A supplier owed at least the minimum is paid at the weekly payout | TBD | — | not assessed |
| P4-S44 | A balance below the minimum carries forward | TBD | — | not assessed |
| P4-S45 | A payout is complete only when the transfer is confirmed | TBD | — | not assessed |
| P4-S78 | An amount in an unconfirmed payout is in no other payout | TBD | — | not assessed |
| P4-S79 | A transfer confirmation delivered more than once settles once | TBD | — | not assessed |
| P4-S86 | After a final failure, the amount is paid in the next weekly run under a new instruction | TBD | — | not assessed |
| P4-S87 | A confirmation arriving after a reported failure is escalated, and the amount is not paid again while it is open | TBD | — | not assessed |
| P4-S95 | A late confirmation of a transfer already re-instructed after its final failure becomes a duplicate-payout debt | TBD | — | not assessed |
| P4-S88 | A payout neither confirmed nor failed within payout_confirmation_timeout is escalated, not reissued | TBD | — | not assessed |
| P4-S46 | A payout run that is repeated or retried pays each supplier at most once | TBD | — | not assessed |
| P4-S47 | A payout is rounded down to the provider's minor unit and the residue carries forward | TBD | — | not assessed |
| P4-S48 | A supplier debt is netted against later payouts | TBD | — | not assessed |
| P4-S67 | A supplier debt posted while a payout is being prepared is netted exactly once | TBD | — | not assessed |
| P4-S49 | A supplier debt open for more than 90 days is invoiced | TBD | — | not assessed |
| P4-S50 | A supplier paid in another currency is converted at the shown rate, rounded down, with the residue carried in USD | TBD | — | not assessed |
| P4-S51 | A reversal after the top-up was spent is applied at once and suspends the account if headroom goes negative | TBD | — | not assessed |
| P4-S52 | A negative balance is collected from the next top-up | TBD | — | not assessed |
| P4-S53 | A negative balance not recovered within 90 days of the reversal is written off automatically, at Share's cost | TBD | — | not assessed |
| P4-S94 | After a write-off the account stays suspended until a top-up repays Share, and then resumes by the usual rule | TBD | — | not assessed |
| P4-S82 | A credit limit can be set only on an account that has passed know-your-business checks | TBD | — | not assessed |
| P4-S83 | An invoice unpaid 90 days after its due date is written off at Share's cost | TBD | — | not assessed |
| P4-S92 | An account suspended for an overdue invoice stays suspended whatever its headroom | TBD | — | not assessed |
| P4-S93 | Paying every overdue invoice resumes the account, if the headroom rule also holds | TBD | — | not assessed |
| P4-S54 | The daily reconciliation proves what must agree, and reports every difference | TBD | — | not assessed |
| P4-S90 | Funds at the partner equal the signed balances, less payouts executed but not yet confirmed, and no alert is raised | TBD | — | not assessed |
| P4-S91 | Share's own balance below the receivables it funds is an alert, even when the sums agree | TBD | — | not assessed |
| P4-S104 | Every kind of partner transaction is matched to one ledger movement, and raises no alert | TBD | — | not assessed |
| P4-S80 | Provider settlement reports and bank statements are reconciled daily by the same rule | TBD | — | not assessed |
| P4-S81 | A reconciliation not completed by 12:00 UTC on the next day is an operational alert | TBD | — | not assessed |
| X1-S01 | An unauthenticated request changes nothing and reveals nothing | TBD | — | not assessed |
| X1-S02 | Another account's data cannot be read, and its existence is not revealed | TBD | — | not assessed |
| X1-S03 | Another account's reservation cannot be changed | TBD | — | not assessed |
| X1-S04 | A supplier sees only its own links and settlements | TBD | — | not assessed |
| X1-S28 | A supplier sees the reservations on its link, but not who holds them | TBD | — | not assessed |
| X1-S30 | Withdrawn consent stops the supplier seeing the buyer's identity from then on | TBD | — | not assessed |
| X1-S24 | A webhook goes only to its own account's endpoint and carries nothing about another account | TBD | — | not assessed |
| X1-S05 | An agent key acts only for the account that issued it | TBD | — | not assessed |
| X1-S06 | A revoked agent key is refused within 60 s of its revocation | TBD | — | not assessed |
| X1-S07 | An operation by an agent key records the key | TBD | — | not assessed |
| X1-S18 | An account administrator issues, changes and revokes keys and sets their limits | TBD | — | not assessed |
| X1-S19 | An agent key cannot manage keys or limits, its own or another's | TBD | — | not assessed |
| X1-S29 | Only an account administrator can consent to identify the account to a supplier | TBD | — | not assessed |
| X1-S25 | An account user who is not an account administrator cannot manage keys or limits | TBD | — | not assessed |
| X1-S20 | Every change to an agent key or its limits records who made it and when | TBD | — | not assessed |
| X1-S21 | An account cannot have more than account_max_keys keys | TBD | — | not assessed |
| X1-S08 | The same idempotency key used by two accounts gives two independent requests | TBD | — | not assessed |
| X1-S09 | An idempotency key reveals nothing about another account's request | TBD | — | not assessed |
| X1-S22 | Nobody but the link's supplier books maintenance, announces a permanent reduction or records an outage or its restoration on it, network operations aside | TBD | — | not assessed |
| X1-S23 | Network operations may record an outage and its restoration, but not commercial changes | TBD | — | not assessed |
| X1-S10 | A notification not proven authentic moves no money and is recorded | TBD | — | not assessed |
| X1-S11 | A webhook can be verified as coming from Share and unaltered | TBD | — | not assessed |
| X1-S12 | An operator in the role that owns an action can take it, and the action is recorded with its reason | TBD | — | not assessed |
| X1-S13 | An operator is refused any action that belongs to another role | TBD | — | not assessed |
| X1-S16 | An operator cannot end a reservation for a reason outside POL-30 | TBD | — | not assessed |
| X1-S17 | A termination is recorded with its reason and operator, and the holder is told where the law allows | TBD | — | not assessed |
| X1-S26 | A termination for fraud or a legal order takes effect only with a second compliance operator's approval | TBD | — | not assessed |
| X1-S27 | Support reads, and acts on an account only at its documented request | TBD | — | not assessed |
| X1-S14 | Every change to money or capacity records the principal and the time | TBD | — | not assessed |
| X1-S15 | An audit record cannot be altered or removed | TBD | — | not assessed |
| X2-S01 | Availability per capability | TBD | — | not assessed |
| X2-S16 | A minute is available only if at least 90% of its probes succeed | TBD | — | not assessed |
| X2-S18 | Each capability is probed by its own operation, against its own per-probe limit | TBD | — | not assessed |
| X2-S20 | Probes run end to end as a designated probe account, without business side effects | TBD | — | not assessed |
| X2-S21 | The funds holds and headroom checks bookings need are held to admission's targets, not the wallet's | TBD | — | not assessed |
| X2-S02 | Ingestion may lag but never loses an accepted record | TBD | — | not assessed |
| X2-S03 | Admission sustains the design load, on the hottest link too, within its latency targets | TBD | — | not assessed |
| X2-S04 | Metering keeps up with the design volume of traffic | TBD | — | not assessed |
| X2-S05 | A single-link booking is answered, final or pending, within ack_budget, whatever the booking's length | TBD | — | not assessed |
| X2-S15 | A single-link booking on a link with no capacity in flight gets its final answer within ack_budget | TBD | — | not assessed |
| X2-S06 | A route booking is acknowledged within ack_budget and has its outcome by its deadline | TBD | — | not assessed |
| X2-S07 | A top-up is credited within 10 s of the provider's notification | TBD | — | not assessed |
| X2-S22 | An accepted record is counted in headroom within attribution_lag_max of its acceptance | TBD | — | not assessed |
| X2-S17 | A change of standing reaches network operations within standing_notice_time of the decision | TBD | — | not assessed |
| X2-S08 | Suspension is enforced within 60 s of the decision | TBD | — | not assessed |
| X2-S13 | Charges are posted within their timeliness target, and never later than recovery allows | TBD | — | not assessed |
| X2-S19 | On a declared region disaster, the affected minutes' charges are posted within their target plus the regional recovery time | TBD | — | not assessed |
| X2-S09 | An acknowledged fact survives the loss of a node or a zone | TBD | — | not assessed |
| X2-S12 | No acknowledged fact is lost on the loss of a region | TBD | — | not assessed |
| X2-S14 | A fact is acknowledged only once it is durable in two regions | TBD | — | not assessed |
| X2-S10 | Recovery time per capability and failure scope | TBD | — | not assessed |
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
| P2-S08 | P1-S07, P2-S17, P2-S18, P2-S20 | Three-outcome protocol moved to RFC-002; waiting per POL-05 (amended) stated as outcomes |
| P2-S09 | P2-S06, P2-S08, P2-S09 | Changed per POL-04 |
| P2-S10 | P2-S13 | Unchanged in meaning |
| P2-S11 | (removed) | Wake-ups are design; moved to RFC-002. Need covered by P2-S14, P2-S20 |
| P2-S12 | (removed) | As P2-S11 |
| P2-S13 | P2-S15, P2-S17 | Split per R-09: at least one wins (S15), rejected only if no fit (S17) |
| P2-S14 | P2-S16 | Wound-wait moved to RFC-002; the POL-02 rule stated as outcome |
| P2-S15 | (removed) | Commit-point protection is design; need covered by P2-S05 |
| P2-S16 | P2-S19 | Restated as a need: crossed requests settle before deadlines |
| P2-S17 | P2-S20 | Restated per POL-05 (amended): a waiting request is confirmed when the capacity in flight is released |
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
| P3-S18 | P4-S18 | Changed per POL-16/18: suspension when headroom would fall below zero |
| P3-S19 | P4-S22 | Changed per POL-16: automatic resumption within grace |
| P3-S20 | P4-S18, P4-S19 | Changed per POL-16/18: one headroom rule, including usage exposure, for every account |
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
