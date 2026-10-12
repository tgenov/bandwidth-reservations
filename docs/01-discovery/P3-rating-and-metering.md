# P3. Rating reservations and metered traffic

## Context

Guaranteed products are priced per **Mbps-minute reserved** (POL-01): a reservation's
charge accrues minute by minute for as long as it is active, whether or not traffic
crosses it, with no minimum term and no setup fee. Its price is locked at booking
(POL-27); a part added later keeps the price in force when it was added (POL-08). This
charge is known when the reservation is confirmed, which is why funds can be held for it
at admission (POL-15, [P4](P4-wallet-and-settlement.md)).

Traffic is still measured and, for some of it, billed. Best-effort products (IP transit,
CDN traffic) are priced per GB, and so is burst above a reservation where the product
permits it, and traffic an account sends outside an active reservation (POL-17). Every
guaranteed product carries a `usage_price` for these cases. Every byte measured is also
evidence of what was delivered, which the SLA work (Problem 6 in the company profile)
depends on.

The network reports traffic as flow records: one record per flow, saying how many bytes
passed between a start time and an end time. Records reach billing some time after the
traffic happened, and may arrive more than once. On a route of several legs, several
exporters may report the same traffic. Turning charges into money movements, splitting
them between suppliers and Share, and holding funds are P4. This problem ends at a
charge, and every amendment to it, for each **charge line** (POL-11): one reservation for
one minute; one account and product on one route for one minute of usage-priced
traffic; or one partner cancellation fee for one reservation (POL-08, POL-11),
charged at exactly its shown amount and not split.

The business position, stated plainly:

- **Reservation charges are known in advance**; usage-priced traffic is known only after the
  fact, so an account can always have sent more usage-priced traffic than it has been
  charged for. That amount, the usage exposure, is bounded by policy (POL-14) and counts
  against headroom for every account (POL-18).
- **Late traffic only ever increases a charge; a price correction can move it either way.**
  Either way, a charge already made is never rewritten; it is amended.
- **Late records are billed whenever they arrive** (POL-14). They are owed to a supplier.

## Who is affected

| Who | How |
|---|---|
| Buyers (builders, AI agents, enterprises) | Pay for reserved time on guaranteed capacity, and per GB for best-effort traffic and burst. Need a bill they can check, and one that does not change for unexplained reasons. |
| Suppliers on the route | Are paid from these charges; a missed accrual or unmetered traffic is lost revenue. Are told of traffic on their links that cannot be attributed. |
| Share finance and risk | Need to know the worst case each account can owe beyond its charges, and when the assumptions behind it were broken. |
| Network operations | Are the source of the flow records; configure exporters; police traffic above reserved rates and above `usage_rate_cap`. |
| Support | Explain to a buyer why a past minute's charge changed. |
| SLA work (Problem 6) | Uses the metered traffic as evidence of what was delivered. |

## The problem

Accruing reservation charges is simple per minute but must be exactly once, across every
change to a reservation's life: start, rate changes, cancellation, suspension, revocation,
termination. Metering is harder. Records arrive more than once, late and out of order,
possibly after the minute they belong to has been charged, and while it is being charged.
Several legs report the same traffic with different counts. A flow can last several
minutes. Prices change over time and must be applied by when the traffic happened, not
when it was reported. Some records are unreadable, and some traffic cannot be matched to a
reservation or even to an account. Share reports about 45 TB of traffic a day, and the
rebuild targets about 50 times that.

## Needs

Scenarios in [`02-specs/P3-rating-and-metering.feature`](../02-specs/P3-rating-and-metering.feature)
cite the need they serve with a tag `@need-P3-Nn`.

| ID | Need | Success measure |
|---|---|---|
| P3-N1 | **Reservations accrue exactly what was sold** (POL-01, POL-08, POL-27). Every minute a reservation is active accrues, for each of its parts, reserved rate × that part's price, whether or not traffic crosses it; a part minute is a whole minute; there is no minimum term; accrual follows every change from its effective minute (an added part, by extension or rate increase, at the price in force when the change was made; a decrease removes the most recent part first; a rate cut under a permanent reduction applies from the end of the notice; a reservation moved to an equivalent path accrues at the lower of its original price and the new path's price, Share paying any difference, POL-07; an open-ended reservation's notified price change applies to every part from its effective minute, POL-27) and stops when it ends, is cancelled, revoked, released or terminated. A planned maintenance booking accrues nothing (POL-07). | For any reservation history, the accruals equal a minute-by-minute recomputation from that history and the prices of its parts. |
| P3-N2 | **Each charge line is charged once.** However charging is repeated, interrupted or restarted, every reservation-minute and every record is charged exactly once. | Zero missing or duplicated accruals and record charges under any repetition, interruption or restart of charging. |
| P3-N3 | **Usage-priced traffic is counted exactly once, whatever the delivery.** Duplicated, shuffled and late delivery gives the same charges as delivering each record once, in order; no record is lost or counted twice while its minute is being charged. A record's identity (exporter and sequence number, or whatever the design adds) is unique for the retention period, whatever the exporter's counters do. | Identical charges for any delivery order, duplication and lateness; no record ever mistaken for another. |
| P3-N4 | **Traffic belongs to well-defined minutes** (POL-13). A record's bytes are assigned to the minutes in which the flow was active, in proportion to the seconds active in each, the same way every time; minutes are half-open. | The same record is always assigned to the same minutes, in the same proportions. |
| P3-N5 | **Traffic is priced as it happened** (POL-27, POL-11). A record is priced at the usage price in force in the minute its traffic happened, whenever it arrives. Each charge line (one reservation for one minute; one account and product on one route for one minute) is computed exactly and rounded once, down to the micro; a cancellation-fee line is its exact shown amount, with no rounding. | Every late record priced at the price of its own minute; every charge equal to its charge line's exact value rounded down. |
| P3-N6 | **Each kind of traffic is billed by its rule** (POL-17). Traffic is above the reserved rate when the bytes in a minute exceed reserved rate × 60 s. Traffic within the reserved rate is covered by the accrual; excess on a product without burst is not billed to the buyer, whether dropped at the edge or carried because policing failed (then Share pays the supplier, P4, and an incident is raised); permitted burst and attributable traffic outside an active reservation are billed at the product's `usage_price`; unattributable traffic is quarantined, not billed, and reported, and if attributed within `dispute_window` (from the end of its minute) it is billed at the price of its minute (and its supplier paid); after that, never; a mistaken attribution reversed by finance within `dispute_window` leaves the buyer charged nothing for it, at Share's cost, the supplier keeping what it was paid (POL-17). | Every metered byte falls under exactly one rule, and quarantined traffic is reported to operations and the supplier. |
| P3-N7 | **No record is silently discarded.** Every record received is kept: a record that cannot be used is kept with its reason, does not delay the records behind it, and can be billed once corrected. Accepted records are never altered or removed. A received payload that does not conform to the record template is rejected; its identity, keyed digest and reason are always kept, and nothing more of it outside the erasable personal-data store; the payload itself, if kept (keeping it is not required: caps and a slow store may drop it, each drop counted), is kept only in that store, and is gone from every copy, backups and escrow included, by `dispute_window` + 7 days after receipt, or earlier once an erasure request covering it is executed (POL-19). Only the exporter that produced a record submits a corrected version of it, under its own credential; a corrected version of an accepted record whose contents were wrong supersedes it for charging if submitted within `dispute_window` of the end of the original's last minute, the original kept beside it; it may change only measured fields (bytes, packets, times within the original's minutes), never the record's identity or attribution keys, and one of a quarantined record is itself quarantined (POL-23). | Every received record can be found later, with its outcome; none is ever changed; no record's contents submitted or corrected by anyone but its exporter; no superseding record that changed an identity or attribution key; no non-conforming payload outside the erasable store, or recoverable from any copy after its deadline. |
| P3-N8 | **Past charges are amended, never rewritten, and every amendment is explained** (POL-11, POL-23). An amendment is the charge line's exact new total, rounded down once, less what was already charged for it. Late traffic only increases a charge. A price correction may move it either way, within `dispute_window`, with its cause (Share, a supplier, other) and reason recorded; a price locked at booking can only be corrected downwards. A superseding record from an exporter amends each charge line it changes, a downward amendment borne by the supplier whose exporter erred or by Share for its own (POL-23). Each amendment is a separate entry with its reason. A buyer can see, for any minute, the original charge and every amendment; support can explain each. | No charge is ever modified in place; every amendment equals the rule above and carries a reason and, for price corrections, who made it and the cause. |
| P3-N9 | **Every charge can be reproduced.** Recomputing any period from the stored records (corrected versions submitted by their exporters included), the reservation history, the price history and every recorded operator decision (price corrections, quarantine attributions and their reversals, fees shown at booking) and standing change gives exactly the recorded charges and amendments. | Recomputation matches for any period. |
| P3-N10 | **Usage exposure is visible and its assumptions are policed** (POL-14, POL-18). For every account the business can see its usage exposure in two parts: unposted usage (usage-priced traffic in records accepted by usage ingestion but not yet posted, POL-18), in which a record counts within `attribution_lag_max` of its acceptance and until its charge is posted, and the lateness bound, `usage_rate_cap` × (`max_lateness` + `flow_active_timeout` + 60 s of minute granularity + `attribution_lag_max` + admission's 60 s recovery time + the 60 s enforcement target) × the product's highest `usage_price` in force over the bound's span (the window less the enforcement target before now to the enforcement target after), one per account and product, covering burst and traffic with no reserved rate (POL-14). Records later than `max_lateness` (counted from the end of the last minute a record was active in, POL-14), and records counted later than `attribution_lag_max` after their acceptance, are still billed and reported as breaches of the bound. | Usage exposure visible for every account, equal to the rule; every accepted record counted in unposted usage from within `attribution_lag_max` of its acceptance until it is posted, except those reported as breaches; every record later than `max_lateness`, or counted later than `attribution_lag_max`, reported. |
| P3-N11 | **Metered traffic is evidence.** Accepted records can be retrieved by reservation, link and minute for as long as they are retained, for delivery evidence and disputes. | Every accepted record retrievable for the retention period (X2). |
| P3-N12 | **Partner cancellation fees are charged by rule** (POL-08). A fee, including a partner minimum term charged as one, is charged only if shown at booking; a plain cancellation fee is charged only on a cancellation, and a minimum-term fee on a cancellation inside the term, on a shorten whose new end falls inside it, or when the window the buyer booked ends inside it (the fee shown on the offer before booking); the buyer pays it when the buyer cancels early, shortens the reservation to an end inside the partner's minimum term, or booked a window that ends inside it, or when the reservation is released after suspension (POL-16) or terminated (POL-30); Share pays it when the reservation is revoked (POL-07), when its holder cancels it after its rate was cut under POL-07 (POL-08), when the fee was not shown, or when a partner booking left without Share's confirmation, at a partner with or without holds, is cancelled because its request was withdrawn or failed (POL-28). A fee is a charge line of its own: its exact shown amount, charged once by its source reference, not split; it goes wholly to the partner (P4). | Every fee charged to a buyer was shown at booking and is due under the rule; none charged otherwise; each charged once, at its shown amount. |
| P3-N13 | **Traffic on a route is billed once, at its delivered count** (POL-17). However many legs report the same traffic, it is billed once per route, at the egress (delivered) count (where the last leg is a partner link Share does not meter, the count at the hand-off to it), and suppliers are paid their split of that charge. | No route's traffic billed more than once; every route's usage charge equals its egress count priced. |

Throughput at the target scale, charge timeliness (POL-06: a minute's reservation charge
posted within 2 min of its end, and usage-priced charges for records within `max_lateness`
within `max_lateness` + 2 min, for at least 99.99% of a month's minutes; every charge
within that target plus the 5-minute recovery time of rating and posting; an accepted record counted in headroom within `attribution_lag_max`), durability of accepted records and retention are
owned by [X2](X2-non-functional-targets.md). Headroom, which includes usage exposure, and
suspension when it would fall below zero are owned by [P4](P4-wallet-and-settlement.md).
Authorisation of price corrections and quarantine attributions is owned by
[X1](X1-security-and-tenancy.md).

## Constraints and assumptions

"Confirmed" means stated in a primary source: the job listing or the business statement
made in the mock interview. "Decided" means set in the [policy register](../02-specs/policy-register.md).

| Item | Status |
|---|---|
| Guaranteed products are priced per Mbps-minute reserved, accrued per minute, no minimum term; usage pricing applies to best-effort products, permitted burst, attributable traffic outside a reservation and carried excess; every guaranteed product carries a `usage_price`. | *Decided* (POL-01, POL-17) |
| A booked reservation keeps its price for its life; an added part keeps the price in force when added; an open-ended reservation's price changes only with `price_notice`; prices change only on minute boundaries. | *Decided* (POL-27, POL-08) |
| A decrease removes the most recently added part first. | *Decided* (POL-08) |
| Exporters cut flows at `flow_active_timeout` (60 s); a record that still spans several minutes is spread across them in proportion to the seconds active in each, each part at its own minute's price. | *Decided* (POL-13) |
| Late records are billed whenever they arrive; `max_lateness` (180 s) is the lateness the exposure bound assumes; the bound is `usage_rate_cap` × (`max_lateness` + `attribution_lag_max` (10 s) + 60 s) × the product's highest `usage_price`, with `usage_rate_cap` (100 Mbps) policed at the edge for all usage-priced traffic of an account on a product; unposted usage counts records accepted by usage ingestion. | *Decided* (POL-14, POL-18) |
| Charges are computed exactly per charge line and rounded once, down to the micro, in USD; an amendment is the line's exact new total rounded down less what was charged. | *Decided* (POL-11, POL-20) |
| Traffic above the reserved rate is measured per minute and policed at the edge; permitted burst is carried best effort on idle capacity; where burst is not permitted the excess is dropped and not billed; excess carried despite policing is not billed to the buyer, Share pays the supplier at `usage_price` and raises an incident. | *Decided* (POL-17) |
| When legs report different counts for the same traffic, the egress count is billed. | *Decided* (POL-17) |
| Price corrections in both directions within `dispute_window`, with cause and reason; locked prices only downwards. | *Decided* (POL-23) |
| Planned maintenance bookings accrue nothing. | *Decided* (POL-07) |
| A rate cut under a permanent reduction applies from the end of the notice; a reservation on an equivalent path pays the lower of its original price and the new path's price, and the new path's parties are split on what is charged. | *Decided* (POL-07) |
| A cancellation fee is a third kind of charge line: its exact shown amount, not split, posted once by its source reference; Share pays it when it cut the holder's rate under POL-07. | *Decided* (POL-11, POL-08) |
| The source is reliable: no record is lost and export is 1:1 (unsampled). | *Assumed* |
| Every record is identified by its exporter plus a sequence number, as in NetFlow v9 / IPFIX; the identity must stay unique for the retention period (P3-N3). | *Assumed* (see open question 1) |
| Every record carries the bytes of one flow, its start time and its end time. | *Assumed* (POL-13 needs the start time) |
| Delivery to billing is at least once. | *Assumed* |
| Billing resolution is one minute. | *Assumed* (follows the minute resolution of reservations) |
| A record can be attributed to an account, a route and, where there is one, a reservation. | *Assumed* (see open question 2) |
| 45 TB of traffic a day today; the rebuild is for about 50× the current scale. | *Confirmed* (Share's claim; job listing); what "50×" measures is *Inferred* |
| No commits and no upfront payment. | *Confirmed* (Share's public product description), as interpreted by POL-15 |
| Money is exact: no floating point, reproducible from stored data. | *Assumed* |

## Out of scope

- Producing flow records on routers, sampling and router CPU cost.
- Money movements, the ledger, funds holds, headroom, splitting charges, payouts:
  [P4](P4-wallet-and-settlement.md). This problem starts from reservations, records and
  prices, and ends at charges and amendments.
- Deciding to suspend an account, and acting on it: [P4](P4-wallet-and-settlement.md) and
  network operations.
- How prices and split weights are set (pricing policy). This problem only applies them.
- Policing traffic on the network. This problem only bills and reports what was carried.
- Measuring delivered performance against SLAs, and SLA credits (Problem 6 in the company
  profile). This problem keeps the evidence.
- Parse-level rules for flow records (field formats, number syntax): the interface
  contract.

## Open questions

Answered by the policy register and removed: terminate at zero or allow a negative balance
(POL-15, POL-16; now P4); resumption after top-up (POL-16; now P4); how late a record can be
(POL-14); price rises during the unmetered window (POL-14, POL-27); long flows and how they
are spread (POL-13); unknown records (POL-17); over-rate traffic on a product without burst
(POL-17); charge timeliness (POL-06); the unit rounded once (POL-11: the charge
line); which count is billed across legs, the price for traffic outside a reservation, the
burst interval and quarantine billing (POL-17); the lateness bound (POL-14); price corrections (POL-23); rate-increase and decrease order
(POL-08); maintenance charging (POL-07); partner fees (POL-08); what "50×" means in records per second (POL-06: provisional
260,000 records/s average, 600,000/s peak, until measured); who pays a fee after a
POL-07 rate cut, whether a fee is a charge line, and the price on a cheaper or dearer
equivalent path (POL-08, POL-11, POL-07).

1. **Sequence numbers.** NetFlow and IPFIX sequence numbers are finite counters that wrap and
   may restart when an exporter restarts. P3-N3 requires a record's identity to stay unique
   for the 7-year retention; how (for example by adding the exporter's start time) is the
   RFC's choice.
2. **Attribution.** How is a record matched to an account, a route and a reservation: by
   interface, VLAN, address range? This decides what "unattributable" means in practice
   (POL-17).
