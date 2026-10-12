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
link is a route of one leg. This problem is about the schedule of a Share link: what fits,
what is held, what is recorded, how far ahead it is sold, and what happens when the link
itself loses capacity. Booking several legs as one unit, partner links, the buyer's
interaction with a booking request, and changing or ending a reservation are
[P2](P2-route-reservation.md).

## Who is affected

| Who | How |
|---|---|
| Buyers (builders, AI agents, enterprises) | Need a definite answer and, when rejected, an alternative they can act on without a human. AI agents send many fast, repeated requests. |
| Suppliers (link owners) | Want as much of their capacity sold as possible; every request wrongly rejected is lost revenue. Need planned works to take only capacity that is free. |
| Share | Carries the guarantee. An oversold link is a promise that cannot be kept, credits owed and lost trust. |
| Network operations and provisioning | Build what was sold; need to know at once when a link's capacity falls and which reservations are affected, and may record an outage they detect. |
| Operations and support | Explain any decision after the fact from what was recorded. |
| Finance | Settles with suppliers and handles disputes and SLA claims from the known-at history. |

## The problem

The schedule of a link is partial, overlapping capacity that varies minute by minute.
Bookings may last a minute, a year, or have no end. A few hot links attract most of the
requests, so many requests contend for the same capacity at the same moment, and every
answer is wanted within a tight budget. Some of the capacity on a link is set aside for
route requests that are still in progress and may yet fail. And the link itself can lose
capacity: a fault, planned works, a supplier reducing or withdrawing it, sometimes while
requests are still in progress on it.

## Needs

Each need is stated with the success measure that shows it is met. Scenarios in
[`02-specs/P1-link-admission.feature`](../02-specs/P1-link-admission.feature) cite the
need they serve with a tag `@need-P1-Nn`.

| ID | Need | Success measure |
|---|---|---|
| P1-N1 | **The link is never oversold.** No confirmation is ever made that, at the moment it is made, leaves the committed rate plus the capacity held above the link's capacity at that time, at any minute of its window, however many requests arrive at once. Committed capacity can exceed a reduced capacity only through reservations confirmed before the reduction, and those are affected (POL-07). | Zero confirmations that exceeded the capacity in force when they were made, checked from the recorded schedule and capacity history alone, under any concurrent load. |
| P1-N2 | **Requests that fit are confirmed.** Existing reservations take only part of the link and legitimately overlap. A request fits if the peak at any single minute of its window leaves room for it; it must not be turned away because reservations that never coexist would together exceed the capacity, nor because there is no completely free gap. A request is confirmed only if, when it is confirmed, the committed rate plus the capacity held for other requests plus its rate fits at every minute; it is rejected for no fit only if the committed rate plus its rate does not fit at some minute. Capacity held for an open equivalent-path offer counts as committed (POL-07). | Every decision agrees with a minute-by-minute check of the schedule at the moment it was made; under concurrent load every decision equals the one that would have been made had the requests arrived one at a time in some order. |
| P1-N3 | **One schedule per link.** Single-link and route bookings on the same link are decided against the same schedule and the same priority rule (POL-02, POL-05). Capacity held for a pending request is not sold to anyone else, and is free again from the moment that request's outcome other than confirmed is reported (its release is durable before then, POL-04), except that a request failed as of its deadline while Share's record of its decision was unavailable frees it within `release_grace` after its deadline (POL-26). | No booking is decided against a view of the link that omits confirmed reservations or capacity holds; a booking blocked only by capacity in flight waits, pending, within its deadline (answered pending after `ack_budget`), or with `wait = false` is rejected at once with `retry_after` (POL-05). |
| P1-N4 | **Rejections are actionable and discreet.** A rejection tells the buyer what they can get instead (POL-10), and discloses nothing about other buyers. A rejection with `wait = false` carries the counter-offer too, computed beside the capacity in flight (POL-02). | Every rejection on a link carries the largest rate that fits the window and the earliest window of the requested length, starting at or after the requested start and within the selling horizon, that fits the rate (POL-10), or says that none does; none reveals another buyer's identity, reservations or traffic. |
| P1-N5 | **Malformed requests are errors, not capacity answers.** A window that is empty, backwards, off a minute boundary, in the past or beyond the selling horizon, and a rate that is not a whole number of Mbps of at least `rate_min` (POL-31), are the caller's error and never silently confirmed. A rate above the link's capacity is a capacity answer (a rejection), not an error. | No malformed request is confirmed or rejected; each is reported as invalid and holds nothing. |
| P1-N6 | **Open-ended and long reservations are guaranteed as sold.** The marketplace sells up to `selling_horizon` ahead (POL-09). An open-ended reservation is guaranteed continuously: as the horizon rolls forward, its capacity is carried forward before any new sale can take it. Long bookings are checked at every minute. | An open-ended reservation's reserved rate is available to it at every minute until it is cancelled, revoked, released or terminated; no new sale ever takes it. |
| P1-N7 | **Only facts are recorded.** What the link has sold is exactly its confirmed reservations. A request that was rejected, failed or found invalid holds no capacity on the link from the moment its outcome is reported, except that a request failed as of its deadline while Share's record of its decision was unavailable holds it for at most `release_grace` after its deadline (POL-26). | No rejected, failed or invalid request holds capacity on a Share link once its outcome is reported, or, when Share's record of its decision was unavailable at its deadline, later than `release_grace` after its deadline. |
| P1-N8 | **Loss of supply never revokes a guarantee silently** (POL-07). New sales, and requests still pending or waiting, are decided against the reduced capacity from the moment it is recorded. On an unplanned outage the reduced capacity applies from its record until its restoration, open-ended, for every window sold; a reservation is affected at the minutes where the committed rate exceeds the reduced capacity, every reservation at those minutes alike (no newest first), and an outage that leaves capacity at or above what is committed affects none (POL-07). Affected reservations are kept and flagged; holders active when the outage is recorded, and network operations, are told within `affected_notice_time`; the holder of a reservation that starts during the outage is told within `affected_notice_time` of its start; all are told again on restoration. Planned works are booked at least `maintenance_notice` ahead, on free capacity only; works that need sold capacity are not bookable as maintenance (the supplier waits, or announces a permanent reduction), and works carried out anyway are an unplanned outage attributed to the supplier. On a permanent reduction the supplier keeps the capacity for `revocation_notice`; only just enough Mbps, newest part first, are affected; each affected buyer is offered an equivalent path for the whole reservation, at the lower of its original price and the path's, for `offer_window`; all-Share paths are offered first, a path with a partner leg only when none exists; the offer is firm on Share legs: while it is open their capacity is held for the reservation, counted as committed for new sales, and released at once on a decline or lapse; a partner leg is booked only at acceptance (the buyer is told so), and if that booking fails the outcome is as for a declined offer and any other equivalent path still available is offered; an accepted path takes over when the notice ends or, at the holder's request, from an earlier minute boundary; what is not moved is reduced or revoked when the notice ends. | After any capacity reduction, no confirmation exceeds the reduced capacity; every affected reservation is flagged at exactly the minutes it is affected and its holder told within `affected_notice_time`; no reservation is flagged where capacity covers what is committed; no planned works take committed capacity; no reservation is revoked or reduced before its notice ends, or beyond what the reduced capacity requires. |
| P1-N9 | **Decisions can be explained after the fact** (POL-19). The system can say what was known to be reserved on a link at any past time. | For any link and any past time T, the schedule as known at T can be retrieved, including reservations changed or cancelled since. |

Performance targets for admission (latency whatever the booking length, throughput on the
hottest link) are owned by [X2](X2-non-functional-targets.md). Who may book, change and see
what, and who may record a change of a link's capacity, is owned by
[X1](X1-security-and-tenancy.md).

## Constraints and assumptions

"Confirmed" means stated in a primary source: the job listing or the business statement
made in the mock interview. "Decided" means set in the [policy register](../02-specs/policy-register.md).

| Constraint | Status |
|---|---|
| The unit sold is partial capacity on a link for a window (for example 2 Gbps of 10 Gbps). | *Assumed* |
| A reserved rate is a whole number of Mbps, at least `rate_min` (1 Mbps). | *Decided* (POL-31) |
| Time resolution is one minute; windows start and end on minute boundaries. | *Assumed* |
| Windows are half-open: a booking for [10:00, 11:00) does not occupy 11:00, so back-to-back bookings can each use the whole link. | *Assumed* |
| Windows may be open-ended, lasting until cancelled. | *Assumed* |
| Share sells up to `selling_horizon` (12 months) ahead, rolling; open-ended reservations are guaranteed as the horizon rolls. | *Decided* (POL-09) |
| Overselling is never acceptable. Share does not oversubscribe. | *Assumed*; *Decided* (POL-01 market position) |
| Each link has one schedule owner; a single-link booking is a route of one leg. | *Decided* (POL-05) |
| A request blocked only by capacity in flight waits within its own deadline; with `wait = false` it is rejected at once with `retry_after`. | *Decided* (POL-05) |
| The priority rule (`priority_rule = request_age`: oldest first) orders waiting requests; a younger request that is itself waiting releases capacity an older waiting request needs (which breaks crossings and longer cycles); a request already holding capacity it needs and not waiting is not pre-empted. Capacity is never oversold, contention alone never makes every waiting competitor lose whose deadline, less its completion margin (`commit_margin` with a partner leg, `ack_budget` otherwise), outlasts the outcome of the request ahead of it, and no request waits beyond its deadline. | *Decided* (POL-02) |
| Confirmed reservations end by Share's decision only under POL-07 (revocation), POL-16 (release) or POL-30 (termination). | *Decided* (POL-07, POL-16, POL-30) |
| A link's capacity can fall. Planned works are booked by the link's supplier at least 14 calendar days ahead and accrue nothing. Network operations may record an unplanned outage and its restoration; only the supplier books maintenance or announces a permanent reduction. | *Decided* (POL-07) |
| On an unplanned outage the reduced capacity applies until restoration, open-ended; reservations are affected at the minutes where the committed rate exceeds it, all alike, and an outage that leaves capacity at or above what is committed affects none. On a permanent reduction the capacity is kept for `revocation_notice`; just enough Mbps are affected, newest part first, each part with its own age; a reduced part may be cancelled without fee (Share pays any partner fee); the equivalent path is offered for the whole reservation at the lower of the original and the path's price; all-Share paths first; the offer is firm on Share legs, their capacity held while it is open and counted as committed; a partner leg is booked only at acceptance, a failed booking counting as a declined offer; offers lapse after `offer_window` (no answer is a refusal); an accepted path takes over when the notice ends, or earlier at the holder's request. | *Decided* (POL-07; POL-08) |
| Maintenance that needs sold capacity cannot be booked: the supplier waits for capacity to free, or announces a permanent reduction; works carried out anyway are recorded as an unplanned outage, attributed to the supplier for SLA purposes. | *Decided* (POL-07) |
| Holders of affected reservations and network operations are told within `affected_notice_time` (60 s) of the record, or of the reservation's start if it starts during the outage. | *Decided* (POL-07) |
| A counter-offer's earliest window starts at or after the requested start; a `wait = false` rejection carries the counter-offer computed beside the capacity in flight. | *Decided* (POL-10, POL-02) |
| Never overselling is core to Share's business, given why earlier bandwidth exchanges failed. | *Inferred* (company profile) |

## Out of scope

- Booking several legs as one unit, the buyer's interaction with a request, idempotency,
  partners, and changing or ending a reservation: [P2](P2-route-reservation.md).
- Charging for reservations and traffic: [P3](P3-rating-and-metering.md).
- Funds holds, wallets and supplier payouts: [P4](P4-wallet-and-settlement.md).
- Choosing which link or route to offer (routing), including finding the equivalent path
  that POL-07 offers on a permanent reduction. This problem fixes only the terms of the
  offer (POL-07) and what happens when it is accepted, declined or lapses.
- How prices are set (pricing policy).
- Provisioning the connection on the network once a reservation is confirmed (Problem 5 in
  the company profile).
- SLA credits for affected reservations (Problem 6 in the company profile). This problem
  only identifies and announces the affected reservations.

## Open questions

Answered by the policy register and removed: cancellation and its effective time
(POL-08, now in P2); history (POL-19); horizon (POL-09); supply changes (POL-07);
rejection content (POL-10); single-link requests against in-flight routes (POL-05);
equivalent paths and offers (POL-07); which reservations a permanent reduction
affects and when (POL-07); maintenance charging and notice calendar (POL-07: never charged, 14 calendar days); which reservations an outage affects, who may
record an outage, partial reduction, the notification bound and the time an accepted path
takes over (POL-07); rate precision (POL-31); how long an outage
reduces sellable capacity, which minutes it affects and when later holders are told,
the supplier's recourse for maintenance that cannot fit, and what a partly affected
reservation is offered (POL-07); where a counter-offer's earliest window may start
(POL-10).
The hottest-link load is set as a design target by POL-06 (2,500 requests/s), though its
real value is still to be measured.

1. **Measured skew.** POL-06 sets 2,500 requests/s on the hottest link as the design load.
   What does the real distribution of requests across links look like, and does it stay
   within that figure as markets are added?
