# P1. Capacity admission on one link without overselling

## Context

Share sells bandwidth on network links through an API: the buyer names the path, the
performance and how long they need it, and pays per use (see the
[company profile](company-profile.md), Problem 1 in its ranked table). The unit sold is
not a whole link but a slice of one: for example 2 Gbps of a 10 Gbps link, for a time
window. Many buyers hold slices of the same link at the same time, and their windows
overlap in arbitrary ways.

Every sale is an admission decision: given what the link has already sold, does this new
request fit for every minute of its window? The bandwidth exchanges of around 2000 failed
above all because they sold capacity that could not be physically delivered. An admission
decision that is wrong in the generous direction is therefore the failure this business
cannot afford.

This problem covers a single link. Reserving a route across several links is
[P2](P2-route-reservation.md).

## Who is affected

| Who | How |
|---|---|
| Buyers (builders, AI agents, enterprises) | Need a definite confirm or reject quickly enough to call synchronously, and a reason they can act on when rejected. AI agents in particular send many fast, repeated requests. |
| Suppliers (link owners) | Want as much of their capacity sold as possible; every request wrongly rejected is lost revenue. |
| Share | Carries the SLA. An oversold link means a promise that cannot be kept, credits owed, and damage to trust in the marketplace. |
| Operations and support | Need to explain any decision after the fact from what was recorded. |

## The problem

Decide, for a request of `b` Mbps over a time window on a link of capacity `C`, whether
the link can carry it at every instant of that window alongside everything already sold,
and record the outcome, so that:

1. **The link is never oversold.** At no instant may the total of accepted reservations
   exceed the link's capacity. This must hold when many requests for the same link arrive
   at once.
2. **Requests that fit are accepted.** Existing reservations take only part of the link
   and overlap one another legitimately. A request fits if the *highest* total usage at
   any single instant of its window leaves room for it; it must not be rejected because
   reservations that never coexist would together exceed the capacity, nor because there
   is no completely free gap.
3. **Rejections are correct and useful.** A rejection must state a true reason: how much is
   already in use, and which parts of the window are too full.
4. **The answer is fast whatever the booking length.** A booking may last minutes, a year,
   or have no end at all; the cost of deciding must not grow with its length to the point
   of missing the latency budget.
5. **Only facts are recorded.** What the system remembers as sold must be exactly the
   accepted reservations. A request that was rejected, or that failed partway, must never
   hold capacity.
6. **Malformed requests are distinguished from full links.** A window that is empty,
   backwards, or outside the period the system sells is the caller's error, not a capacity
   answer, and must never be silently accepted.

The hard part is the combination: partial, overlapping capacity that varies minute by
minute; bookings of unbounded length; heavy skew towards a few hot links where
concurrent requests contend for the same capacity; and a tight synchronous latency budget.

## Constraints and assumptions

| Constraint | Status |
|---|---|
| The unit sold is partial capacity on a link for a time window (e.g. 2 Gbps of 10 Gbps). | *Assumed* |
| Time resolution is one minute; windows start and end on any minute. | *Assumed* |
| Windows are half-open: a booking for [10:00, 11:00) does not occupy 11:00, so back-to-back bookings can each use the full link. | *Assumed* |
| Windows may be open-ended, lasting until cancelled. | *Assumed* |
| Bookings may be long, up to a year or more (about 525,600 minutes). | *Assumed* |
| Admission is synchronous: the buyer receives confirm or reject, p99 ≤ 200 ms. | *Assumed* |
| Load is about 500 requests/s globally, heavily skewed to a few hot links. | *Assumed* |
| Overselling is never acceptable. | *Assumed* |
| Strict first-come-first-served is not required, but no request may starve. | *Assumed* |
| Confirmed reservations are never revoked by the system. | *Assumed* |
| Rejections must carry a correct reason. | *Assumed* |
| Request ordering is already lost before any shared store sees it: load balancers, application instances and connection pools all reorder requests. | *Inferred* |
| Never overselling is core to Share's business, given why earlier bandwidth exchanges failed. | *Inferred* (company profile) |
| The stack is TypeScript and PostgreSQL. | *Confirmed* (job listing) |
| A link's capacity is fixed for the purposes of this problem. | *Assumed* |

## Success measures

| Measure | Target |
|---|---|
| Oversold instants, checked from the recorded facts alone | Zero, including under many concurrent requests on one hot link |
| Agreement with a brute-force minute-by-minute check | Every decision, on randomised request sequences |
| Admission latency under hot-link contention | p99 ≤ 200 ms |
| Decision cost for long and open-ended bookings | Does not grow with booking length |
| Rejection reasons | State the usage that blocks the request and every sub-range of the window that is too full |
| Rejected or failed requests holding capacity | None |
| Out-of-range windows accepted | None; each is reported as an error |

## Out of scope

- Reservations across several links (routes) and holds during a multi-step reservation:
  [P2](P2-route-reservation.md).
- Metering actual traffic and billing for it: [P3](P3-usage-metering.md).
- Payment, wallets and supplier payouts: [P4](P4-wallet-and-settlement.md).
- Choosing which link or route to offer (routing).
- Pricing.
- Provisioning the connection on the network once a reservation is admitted.
- Changes to a link's capacity over time (supply changes).

## Open questions

1. **Hot-link throughput.** How skewed is the load in practice: what request rate does the
   single hottest link see, and does contention on that one link fit inside the latency
   budget?
2. **Cancellation.** How is a reservation cancelled or shortened, who may do it, and must
   the original reservation remain visible in the record after it is cancelled?
3. **History.** Is it enough to know what is reserved now, or must the system also answer
   what was known to be reserved at an earlier moment (for audits, disputes and SLA
   claims)?
4. **Horizon.** How far ahead may a window start, and what does "open-ended" mean for
   capacity planning beyond that point?
5. **Supply changes.** When a link's capacity is reduced, for maintenance or a fault,
   what happens to reservations that no longer fit, given that confirmed reservations are
   never revoked?
6. **Rejection reason format.** What exactly does a buyer, or an AI agent, need in a
   rejection to choose a different window or a smaller amount?
