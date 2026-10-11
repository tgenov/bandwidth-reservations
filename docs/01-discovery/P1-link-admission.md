# P1. Selling capacity on one link without overselling

## Context

Share sells bandwidth on network links through an API: the buyer names the path, the
performance and how long they need it (see the [company profile](company-profile.md),
Problem 1 in its ranked table). The unit sold is not a whole link but a slice of one, for
example 2 Gbps of a 10 Gbps link, for a window. Many buyers hold slices of the same link
at once, and their windows overlap in arbitrary ways. Guaranteed capacity is priced per
Mbps-minute reserved (POL-01), so a confirmed reservation takes that capacity out of
inventory whether or not traffic crosses it. Share does not oversubscribe.

Every sale is a decision about one link's schedule: given everything already confirmed,
and everything set aside for requests still in progress, does this request fit at every
minute of its window? The bandwidth exchanges of around 2000 failed above all because they
sold capacity that could not be delivered. A decision that is wrong in the generous
direction is the failure this business cannot afford.

Each link's schedule has exactly one owner, and every booking on that link, whether for
the link alone or as one leg of a route, is decided by it (POL-05). A booking on a single
link is a route of one leg. This problem is about the link's schedule: what fits, what is
held, what is recorded, how far ahead it is sold, and what happens when the link itself
loses capacity. Booking several legs as one unit, the buyer's interaction with a booking
request, and changing or ending a reservation are [P2](P2-route-reservation.md).

## Who is affected

| Who | How |
|---|---|
| Buyers (builders, AI agents, enterprises) | Need a definite answer and, when rejected, an alternative they can act on without a human. AI agents send many fast, repeated requests. |
| Suppliers (link owners) | Want as much of their capacity sold as possible; every request wrongly rejected is lost revenue. Need planned works to take only capacity that is free. |
| Share | Carries the guarantee. An oversold link is a promise that cannot be kept, credits owed and lost trust. |
| Network operations and provisioning | Build what was sold; need to know at once when a link's capacity falls and which reservations are affected. |
| Operations and support | Explain any decision after the fact from what was recorded. |
| Finance | Settles with suppliers and handles disputes and SLA claims from the known-at history. |

## The problem

The schedule of a link is partial, overlapping capacity that varies minute by minute.
Bookings may last a minute, a year, or have no end. A few hot links attract most of the
requests, so many requests contend for the same capacity at the same moment, and every
answer is wanted within a tight budget. Some of the capacity on a link is set aside for
route requests that are still in progress and may yet fail. And the link itself can lose
capacity: a fault, planned works, a supplier reducing or withdrawing it.

## Needs

Each need is stated with the success measure that shows it is met. Scenarios in
[`02-specs/P1-link-admission.feature`](../02-specs/P1-link-admission.feature) cite the
need they serve with a tag `@need-P1-Nn`.

| ID | Need | Success measure |
|---|---|---|
| P1-N1 | **The link is never oversold.** At no minute may the committed rate plus the capacity held for pending requests exceed the link's capacity, however many requests arrive at once. | Zero oversold minutes, checked from the recorded schedule alone, under any concurrent load. |
| P1-N2 | **Requests that fit are confirmed.** Existing reservations take only part of the link and legitimately overlap. A request fits if the peak at any single minute of its window leaves room for it; it must not be turned away because reservations that never coexist would together exceed the capacity, nor because there is no completely free gap. | Every decision agrees with a minute-by-minute check of the schedule; under concurrent load every decision equals the one that would have been made had the requests arrived one at a time in some order. |
| P1-N3 | **One schedule per link.** Single-link and route bookings on the same link are decided against the same schedule and the same priority rule (POL-02, POL-05). Capacity held for a pending request is not sold to anyone else, and comes back when that request does not end confirmed. | No booking is decided against a view of the link that omits confirmed reservations or capacity holds; a single-link booking blocked only by capacity in flight waits within its deadline (pending after `ack_budget`), or with `wait = false` is rejected at once with `retry_after` (POL-05). |
| P1-N4 | **Rejections are actionable and discreet.** A rejection tells the buyer what they can get instead (POL-10), and discloses nothing about other buyers. | Every rejection on a link carries the largest rate that fits the window and the earliest window that fits the rate, as far as computable; none reveals another buyer's identity, reservations or traffic. |
| P1-N5 | **Malformed windows are errors, not capacity answers.** A window that is empty, backwards, in the past or beyond the selling horizon is the caller's error and is never silently confirmed. | No malformed window is confirmed or rejected; each is reported as invalid and holds nothing. |
| P1-N6 | **Open-ended and long reservations are guaranteed as sold.** The marketplace sells up to `selling_horizon` ahead (POL-09). An open-ended reservation is guaranteed continuously: as the horizon rolls forward, its capacity is carried forward before any new sale can take it. Long bookings are checked at every minute. | An open-ended reservation's reserved rate is available to it at every minute until it is cancelled or revoked; no new sale ever takes it. |
| P1-N7 | **Only facts are recorded.** What the link has sold is exactly its confirmed reservations. A request that was rejected, failed or found invalid holds no capacity once it has its outcome. | No rejected, failed or invalid request holds capacity after its outcome. |
| P1-N8 | **Loss of supply never revokes a guarantee silently** (POL-07). New sales stop at once at the reduced capacity; affected reservations are identified and their holders and operations told; planned works are booked ahead on free capacity only; on a permanent reduction each affected buyer is offered an equivalent path on the POL-07 terms, and reservations not moved are revoked newest first with notice. | After any capacity reduction, no sale exceeds the reduced capacity; every affected reservation is flagged and its holder told; no planned works take committed capacity. |
| P1-N9 | **Decisions can be explained after the fact** (POL-19). The system can say what was known to be reserved on a link at any past time. | For any link and any past time T, the schedule as known at T can be retrieved, including reservations changed or cancelled since. |

Performance targets for admission (latency whatever the booking length, throughput on the
hottest link) are owned by [X2](X2-non-functional-targets.md). Who may book, change and see
what is owned by [X1](X1-security-and-tenancy.md).

## Constraints and assumptions

"Confirmed" means stated in a primary source: the job listing or the business statement
made in the mock interview. "Decided" means set in the [policy register](../02-specs/policy-register.md).

| Constraint | Status |
|---|---|
| The unit sold is partial capacity on a link for a window (for example 2 Gbps of 10 Gbps). | *Assumed* |
| Time resolution is one minute; windows start and end on minute boundaries. | *Assumed* |
| Windows are half-open: a booking for [10:00, 11:00) does not occupy 11:00, so back-to-back bookings can each use the whole link. | *Assumed* |
| Windows may be open-ended, lasting until cancelled. | *Assumed* |
| Share sells up to `selling_horizon` (12 months) ahead, rolling; open-ended reservations are guaranteed as the horizon rolls. | *Decided* (POL-09) |
| Overselling is never acceptable. Share does not oversubscribe. | *Assumed*; *Decided* (POL-01 market position) |
| Each link has one schedule owner; a single-link booking is a route of one leg. | *Decided* (POL-05) |
| A request blocked only by capacity in flight waits within its own deadline; with `wait = false` it is rejected at once with `retry_after`. | *Decided* (POL-05) |
| When requests compete, the oldest wins (`priority_rule = request_age`); whatever the rule, capacity is never oversold, at least one competitor wins, and no request waits forever. | *Decided* (POL-02) |
| Confirmed reservations are revoked only under POL-07 (permanent reduction) or POL-16 (end of suspension grace). | *Decided* (POL-07, POL-16) |
| A link's capacity can fall; planned works are booked as reservations against the link. | *Decided* (POL-07) |
| Never overselling is core to Share's business, given why earlier bandwidth exchanges failed. | *Inferred* (company profile) |

## Out of scope

- Booking several legs as one unit, the buyer's interaction with a request, idempotency,
  partners, and changing or ending a reservation: [P2](P2-route-reservation.md).
- Charging for reservations and traffic: [P3](P3-rating-and-metering.md).
- Funds holds, wallets and supplier payouts: [P4](P4-wallet-and-settlement.md).
- Choosing which link or route to offer (routing), including finding the equivalent path
  that POL-07 offers on a permanent reduction. This problem fixes only the terms of the
  offer (POL-07) and what happens when it is accepted or declined.
- How prices are set (pricing policy).
- Provisioning the connection on the network once a reservation is confirmed (Problem 5 in
  the company profile).
- SLA credits for affected reservations (Problem 6 in the company profile). This problem
  only identifies and announces the affected reservations.

## Open questions

Answered by the policy register and removed: cancellation and its effective time
(POL-08, now in P2); history (POL-19); horizon (POL-09); supply changes (POL-07);
rejection content (POL-10); single-link requests against in-flight routes (POL-05, as
amended: they wait within their deadline unless `wait = false`); what counts as an
equivalent path on a permanent reduction, and whether the buyer must accept it (POL-07,
as amended: same endpoints and rate, latency and SLA class no worse, original price; the
buyer may decline).
The hottest-link load is set as a design target by POL-06 (2,500 requests/s), though its
real value is still to be measured.

1. **Measured skew.** POL-06 sets 2,500 requests/s on the hottest link as the design load.
   What does the real distribution of requests across links look like, and does it stay
   within that figure as markets are added?
2. **Planned maintenance that cannot fit.** If a supplier needs to take capacity that is
   already sold, POL-07 allows planned works only on free capacity. What is the supplier's
   recourse: a permanent reduction with `revocation_notice`, or waiting for capacity to
   free?
