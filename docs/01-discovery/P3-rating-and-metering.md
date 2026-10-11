# P3. Rating reservations and metered traffic

## Context

Guaranteed products are priced per **Mbps-minute reserved** (POL-01): a reservation's
charge accrues minute by minute for as long as it is active, whether or not traffic
crosses it, with no minimum term and no setup fee. Its price is locked at booking
(POL-27). This charge is known when the reservation is confirmed, which is why funds can
be held for it at admission (POL-15, [P4](P4-wallet-and-settlement.md)).

Traffic is still measured and, for some of it, billed. Best-effort products (IP transit,
CDN traffic) are priced per GB, and so is burst above a reservation where the product
permits it, and traffic an account sends outside an active reservation (POL-17). Every
byte measured is also evidence of what was delivered, which the SLA work (Problem 6 in the
company profile) depends on.

The network reports traffic as flow records: one record per flow, saying how many bytes
passed between a start time and an end time. Records reach billing some time after the
traffic happened, and may arrive more than once. Turning charges into money movements,
splitting them between suppliers and Share, and holding funds are P4. This problem ends at
a charge, and every amendment to it, for each reservation-minute and for each account's
usage-priced traffic in each minute.

The business position, stated plainly:

- **Reservation charges are known in advance**; usage-priced traffic is known only after the
  fact, so an account can always have sent more usage-priced traffic than it has been
  charged for. That amount, the exposure, must be known and bounded (POL-14).
- **Late traffic only ever increases a charge; a price correction can move it either way.**
  Either way, a charge already made is never rewritten; it is amended.
- **Late records are billed whenever they arrive** (POL-14). They are owed to a supplier.

## Who is affected

| Who | How |
|---|---|
| Buyers (builders, AI agents, enterprises) | Pay for reserved time on guaranteed capacity, and per GB for best-effort traffic and burst. Need a bill they can check, and one that does not change for unexplained reasons. |
| Suppliers on the route | Are paid from these charges; a missed accrual or unmetered traffic is lost revenue. Are told of traffic on their links that cannot be attributed. |
| Share finance and risk | Need to know the worst case each account can owe beyond its charges, and when the assumptions behind it were broken. |
| Network operations | Are the source of the flow records; configure exporters; police traffic above reserved rates. |
| Support | Explain to a buyer why a past minute's charge changed. |
| SLA work (Problem 6) | Uses the metered traffic as evidence of what was delivered. |

## The problem

Accruing reservation charges is simple per minute but must be exactly once, across every
change to a reservation's life: start, rate changes, cancellation, suspension, revocation.
Metering is harder. Records arrive more than once, late and out of order, possibly after
the minute they belong to has been charged, and while it is being charged. A flow can last
several minutes. Prices change over time and must be applied by when the traffic happened,
not when it was reported. Some records are unreadable, and some traffic cannot be matched
to a reservation or even to an account. Share reports about 45 TB of traffic a day, and the
rebuild targets about 50 times that.

## Needs

Scenarios in [`02-specs/P3-rating-and-metering.feature`](../02-specs/P3-rating-and-metering.feature)
cite the need they serve with a tag `@need-P3-Nn`.

| ID | Need | Success measure |
|---|---|---|
| P3-N1 | **Reservations accrue exactly what was sold** (POL-01, POL-08, POL-27). Every minute a reservation is active accrues reserved rate × its booked reservation price, whether or not traffic crosses it; a part minute is a whole minute; there is no minimum term; accrual follows every change to the reservation from its effective minute and stops when it ends, is cancelled, is revoked or is released. | For any reservation history, the accruals equal a minute-by-minute recomputation from that history and the booked price. |
| P3-N2 | **Each minute is charged once.** However many charging runs overlap, restart or start afresh, every reservation-minute and every record is charged exactly once. | Zero missing or duplicated accruals and record charges under overlapping, restarted and fresh charging. |
| P3-N3 | **Usage-priced traffic is counted exactly once, whatever the delivery.** Duplicated, shuffled and late delivery gives the same charges as delivering each record once, in order; no record is lost or counted twice while its minute is being charged. | Identical charges for any delivery order, duplication and lateness. |
| P3-N4 | **Traffic belongs to well-defined minutes** (POL-13). A record's bytes are assigned to the minutes in which the flow was active, the same way every time; minutes are half-open. | The same record is always assigned to the same minutes. |
| P3-N5 | **Traffic is priced as it happened** (POL-27, POL-11). A record is priced at the usage price in force in the minute its traffic happened, whenever it arrives; each charge is computed exactly and rounded once, down to the micro. | Every late record priced at the price of its own minute; every charge equal to its exact value rounded down. |
| P3-N6 | **Each kind of traffic is billed by its rule** (POL-17). Traffic within a reservation's reserved rate is covered by its accrual; permitted burst and attributable traffic outside an active reservation are billed at `usage_price`; unattributable traffic is quarantined, not billed, and reported. | Every metered byte falls under exactly one rule, and quarantined traffic is reported to operations and the supplier. |
| P3-N7 | **No record is silently discarded.** Every record received is kept: a record that cannot be read is kept with its reason, does not delay the records behind it, and can be billed once corrected. Accepted records are never altered or removed. | Every received record can be found later, with its outcome; none is ever changed. |
| P3-N8 | **Past charges are amended, never rewritten, and every amendment is explained.** Late traffic only increases a charge; an authorised price correction can move it either way; each amendment is a separate entry with its reason. A buyer can see, for any minute, the original charge and every amendment; support can explain each. | No charge is ever modified in place; every amendment carries a reason and, for price corrections, who made it. |
| P3-N9 | **Every charge can be reproduced.** Recomputing any period from the stored records, the reservation history and the price history gives exactly the recorded charges and amendments. | Recomputation matches for any period. |
| P3-N10 | **Exposure is visible and its assumptions are policed** (POL-14). For every account the business can see the worst case owed for usage-priced traffic not yet charged; records later than `max_lateness` are still billed and reported as breaches of the bound. | Exposure visible for every account; every record later than `max_lateness` reported. |
| P3-N11 | **Metered traffic is evidence.** Accepted records can be retrieved by reservation, link and minute for as long as they are retained, for delivery evidence and disputes. | Every accepted record retrievable for the retention period (X2). |

Throughput at the target scale, charge timeliness, durability of accepted records and
retention are owned by [X2](X2-non-functional-targets.md). Suspension, and enforcement
against an account whose exposure or funds run out, are owned by
[P4](P4-wallet-and-settlement.md). Authorisation of price corrections is owned by
[X1](X1-security-and-tenancy.md).

## Constraints and assumptions

"Confirmed" means stated in a primary source: the job listing or the business statement
made in the mock interview. "Decided" means set in the [policy register](../02-specs/policy-register.md).

| Item | Status |
|---|---|
| Guaranteed products are priced per Mbps-minute reserved, accrued per minute, no minimum term; usage pricing applies only to best-effort products and permitted burst. | *Decided* (POL-01) |
| A booked reservation keeps its price for its life; an open-ended reservation's price changes only with `price_notice`; prices change only on minute boundaries. | *Decided* (POL-27) |
| Exporters cut flows at `flow_active_timeout` (60 s); a record that still spans several minutes is spread evenly across them, each at its own price. | *Decided* (POL-13) |
| Late records are billed whenever they arrive; `max_lateness` (180 s) is the lateness the exposure bound assumes. | *Decided* (POL-14) |
| Charges are computed exactly and rounded once, down to the micro, in USD. | *Decided* (POL-11, POL-20) |
| Traffic above the reserved rate is policed at the edge; permitted burst is carried best effort on idle capacity. | *Decided* (POL-17) |
| The source is reliable: no record is lost and export is 1:1 (unsampled). | *Assumed* |
| Every record has a unique ID: the exporter plus a sequence number, as in NetFlow v9 / IPFIX. | *Assumed* (see open question 1) |
| Every record carries the bytes of one flow, its start time and its end time. | *Assumed* (POL-13 needs the start time) |
| Delivery to billing is at least once. | *Assumed* |
| Billing resolution is one minute. | *Assumed* (follows the minute resolution of reservations) |
| A record can be attributed to an account, and to a reservation where there is one. | *Assumed* (see open question 3) |
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

## Open questions

Answered by the policy register and removed: terminate at zero or allow a negative balance
(POL-15, POL-16; now P4); resumption after top-up (POL-16; now P4); how late a record can be
(POL-14); price rises during the unmetered window (POL-14, POL-27); long flows (POL-13);
unknown records (POL-17).

1. **Sequence numbers.** NetFlow and IPFIX sequence numbers are finite counters that wrap and
   may restart when an exporter restarts. Is the "unique ID" assumption safe over the
   7-year retention (POL-06)?
2. **What "50×" means in records per second.** POL-06 sets the design volume at about
   2.25 PB a day but leaves the flow-record rate "to be sized from exporter data".
3. **Attribution.** How is a record matched to an account and a reservation: by interface,
   VLAN, address range? This decides what "unattributable" means in practice (POL-17).
4. **Over-rate traffic on a product without burst.** POL-17 polices it at the edge and keeps
   every record, but does not say whether records showing it are billed. The spec requires
   only that they are kept and reported.
5. **"Spread evenly".** For a record spanning several minutes, POL-13 says the bytes are
   spread evenly across the minutes it was active. Equal shares per minute, or in proportion
   to the time active in each minute? They differ for a flow that starts or ends mid-minute.
6. **Charge timeliness.** How soon after a minute ends must its accruals and its usage-priced
   traffic first be charged? POL-06 sets no target; X2 records the gap.
