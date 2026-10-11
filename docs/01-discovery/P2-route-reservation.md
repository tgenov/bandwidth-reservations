# P2. Booking, changing and ending route reservations, all or nothing

## Context

A buyer on the marketplace does not want capacity on one link; it wants a **path**: "the
path, the performance, how long they need it". A path such as
Nairobi → Mombasa → Djibouti → Marseille is a route of several legs, and each leg may
belong to a different infrastructure provider. Share claims 16 such providers and 7 subsea
cables (see the [company profile](company-profile.md)).

[P1](P1-link-admission.md) decides whether one link's schedule can take a request. P2 is
the booking itself: securing every leg of a route, for the same window and reserved rate,
as one purchase; telling the buyer the outcome; and later changing or ending the
reservation as one unit. Every booking goes this way. A booking on one link is a route of
one leg (POL-05).

Some legs are Share links. Others are partner links, managed in a partner's own system,
for example a subsea cable operator's. Share cannot take part in that system's
transactions, the partner knows nothing of Share's priority rule, and its API fails, times
out and responds slowly. Some partners can set capacity aside for a time before confirming;
others can only book immediately and finally.

Admission also needs money: a reservation is confirmed only if the account can fund a
rolling coverage window of its charges (POL-15), and agent keys are bound by their own
limits (POL-25). The funds hold itself is [P4](P4-wallet-and-settlement.md); the booking
outcome that depends on it is here.

## Who is affected

| Who | How |
|---|---|
| **Buyers** (builders, enterprises, AI agents calling the API) | A path booked on some legs but not others is useless and may be charged. They need one definite outcome per request, fast, in a form a program can act on. AI agents retry fast and often. |
| **Agent operators** | Need hard limits on what an agent key can book and hold, enforced without a human in the loop. |
| **Suppliers and partners** | Their capacity is sold through Share. Capacity tied up by a request that never completes is capacity they cannot sell. Partners' own operations handle Share's holds, confirmations and cancellations. |
| **Share** | Loses revenue when a buyer who could have been served is turned away, and reputation when it sells what it cannot deliver. Bears partner cancellation costs it did not show the buyer (POL-08, POL-28). |
| **The business owners of the marketplace** | Decide who wins under contention (POL-02) and can change the rule without changing the booking. |
| **Operations and support** | Handle requests that failed or are taking long, and explain each outcome to the buyer. |

## The problem

There is no single transaction that spans Share's links and a partner's, so a route is
booked in steps, and any step can fail after earlier ones succeeded. While a request is in
progress, the capacity it is about to take must not be sold to anyone else, yet the request
may still fail, and then that capacity must come back even if the process handling it has
died. Two requests may want the same capacity at once, and two route requests can each
take part of what the other needs. Partner calls can fail before doing anything, do the
work and lose the answer, or be slow. Clients retry after timeouts. And once booked, a
reservation must be changeable without putting at risk the part the buyer already has.

## Needs

Scenarios in [`02-specs/P2-route-reservation.feature`](../02-specs/P2-route-reservation.feature)
cite the need they serve with a tag `@need-P2-Nn`.

| ID | Need | Success measure |
|---|---|---|
| P2-N1 | **All or nothing.** A route is confirmed on every leg or on none, whatever fails along the way. "Confirmed" is never reported before every leg, the partner's included, is secured; and once confirmed, the system never withdraws it except under POL-07 or POL-16. | No route ever ends booked on some legs and not others; no confirmation is reported early or withdrawn outside POL-07 and POL-16. |
| P2-N2 | **A fast, uniform answer** (POL-04). Every request gets a response within `ack_budget`: final if the outcome is known by then, otherwise pending, with the outcome later by polling with the idempotency key, by webhook, or both. Each request ends with exactly one outcome. | Every response within `ack_budget`; every request ends with one outcome, which never changes once reported. |
| P2-N3 | **A bounded wait** (POL-26). A request has a deadline chosen by the buyer within `route_deadline_max`. It has its outcome by then, and any capacity it held comes back by then. | No request without an outcome after its deadline; no capacity held for a request after its deadline unless that request was confirmed. |
| P2-N4 | **Fair contention** (POL-02, POL-05). When requests compete, at least one that can be served is confirmed. A request that fits only if a request in flight fails waits, pending, within its own deadline, and is confirmed if that capacity is released; it is rejected for no fit only if it does not fit on committed capacity. A buyer who asks not to wait (`wait = false`) is rejected at once with `retry_after`. Crossed requests settle without waiting for capacity holds to time out; the priority rule can be changed without changing uncontended outcomes. | Under any contention: never all competitors lose; no request that waits is rejected while its window fits on committed capacity; crossed requests have their outcomes before any deadline would otherwise expire them. |
| P2-N5 | **Recovery from Share's own faults** (POL-03). A request interrupted by a failure of Share's booking process resumes if it can still finish within its deadline; otherwise it fails, releases everything and the buyer is told why. | After any crash and restart, every request ends with one outcome, and no route is partly booked. |
| P2-N6 | **Retries never book twice.** The same request sent twice by the same account is booked once and gets the same answer; a different request under a key already used by the same account is refused; a retry while the request is pending gets its current status. | Zero duplicate bookings from client retries; zero silent answers to a reused key. |
| P2-N7 | **Partners are booked safely.** Share never confirms a leg the partner has not confirmed; partner retries never book twice; a transient partner refusal does not end the request before its deadline; Share's record of partner bookings is reconciled with the partner; a partner without holds is booked last, at most one per route, and Share cancels it and bears the cost if a later step fails (POL-28). | Share's record of every partner booking matches the partner's after reconciliation; no route through a partner without holds ends partly booked or charged to the buyer for a failed booking. |
| P2-N8 | **Funds and limits are checked at admission** (POL-15, POL-25, POL-16). A request is confirmed only if the account can fund its funds hold, the agent key's `key_spend_limit` for its `key_spend_period` allows it (spending is funds held plus charges accrued by the key's bookings in the period), and the key and account stay within `key_inflight_limit`, `account_inflight_limit` and `key_rate_limit` (POL-25). A suspended account cannot book. Each refusal says which limit and, for funds, how much to top up. | No reservation confirmed without its funds hold or beyond a key's limits; every such refusal states its reason and, for funds, the top-up needed. |
| P2-N9 | **A reservation can be changed or ended as one unit** (POL-08). Cancel or shorten at any time, from the next minute boundary; extend or increase the rate by admitting only the difference, never putting the existing part at risk; decrease the rate from the next minute boundary; no change to part of a route. Partner minimum terms and cancellation fees are shown at booking. | Every change takes effect at a minute boundary not before the next one; no rejected change alters the existing reservation; capacity released by a change is available to others from its effective time. |
| P2-N10 | **Operations can see requests in trouble.** Failed requests are visible to operations with their reason; a request still pending after its deadline plus `commit_margin` raises an alert, since by design it cannot happen (POL-26). | Every failed request can be found with its reason and the leg concerned; every overdue pending request alerts. |

Latency and throughput targets are owned by [X2](X2-non-functional-targets.md); who may
book, change and see which requests, and the scoping of idempotency keys to accounts, by
[X1](X1-security-and-tenancy.md).

## Constraints and assumptions

"Confirmed" means stated in a primary source: the job listing or the business statement
made in the mock interview. "Decided" means set in the [policy register](../02-specs/policy-register.md).

| # | Constraint or assumption | Status |
|---|---|---|
| C1 | Share never confirms more than a link can carry, on its own links or partners'. Share cannot guarantee a partner never oversells its own link; it guarantees only that it never confirms a leg the partner has not confirmed. | *Assumed* |
| C2 | A route is booked on every leg or on none; partial bookings are never visible to the buyer or recorded as reservations. | *Assumed* |
| C3 | Every request is answered within `ack_budget` (200 ms at p99), final or pending; a route's final outcome comes within its deadline (default 30 s, at most 60 s). | *Decided* (POL-04, POL-26) |
| C4 | When buyers compete for the same capacity, at least one of them ends up with a reservation while the capacity remains. | *Confirmed* (business statement, mock interview); *Decided* as an invariant (POL-02) |
| C5 | The oldest request wins under contention; the rule is deployment configuration. A request blocked only by capacity in flight waits within its deadline unless it asks not to (`wait = false`). | *Decided* (POL-02, POL-05) |
| C6 | Partner systems cannot join Share's transactions and do not understand Share's priority rule. They admit first come, first served. | *Assumed* |
| C7 | Partner APIs fail, time out after doing the work, and are slow, at random. Every partner call is idempotent by a key the caller supplies. | *Assumed* |
| C8 | Most partners can set capacity aside for a limited time, then confirm or release it; a confirmation after that time has lapsed is answered as unknown, not silently accepted. Some partners can only book immediately and finally. | *Assumed*; handling *Decided* (POL-28) |
| C9 | A partner can say it cannot take a request right now (transient) or that it cannot fit it (definitive), but cannot queue a request and call back. | *Assumed* |
| C10 | Clients send an idempotency key with every booking request and may retry with it at any time. | *Assumed* |
| C11 | Time is discrete (minutes); windows are half-open and may be open-ended; the selling horizon is P1's. | *Assumed* / *Decided* (POL-09) |
| C12 | Share's booking process can crash at any point; what it has recorded survives. | *Assumed* |
| C13 | The route (which links, in which order) is chosen before the request arrives. | *Assumed* |
| C14 | A typical route mixes Share's links with at least one partner link; Nairobi and Mombasa are live, Djibouti and Marseille are next. | *Confirmed* (Share's public footprint claim) / *Inferred* (the mix) |
| C15 | Partner legs are the most likely to fail a booking, being the least reliable and the ones Share cannot prioritise. | *Inferred* |
| C16 | A route is one unit: no change to part of it (POL-08). A partner leg may impose a minimum term or cancellation fee, shown at booking. The added part of an extension or rate increase is priced at the price in force when the change is made; the existing part keeps its price. | *Decided* (POL-08, POL-27) |

## Out of scope

- Choosing the route (path finding under latency and bandwidth limits). The request names
  its legs.
- Whether one link's schedule can take a request: [P1](P1-link-admission.md).
- Provisioning the connection on the network once it is booked (Problem 5 in the company
  profile).
- Charging for reservations and traffic ([P3](P3-rating-and-metering.md)); funds holds,
  headroom and suspension ([P4](P4-wallet-and-settlement.md)).
- How a partner admits capacity internally.
- Expiring quotes for AI-agent buyers. POL-25 brings limits into scope but not quotes;
  a price shown at booking is the price booked (POL-27).
- Negotiating holds with partners as a listing condition (POL-28: commercial, not system
  behaviour).

## Open questions

Answered by the policy register and removed: ranking of objectives (POL-02); single-link
requests against an in-progress route (POL-05); what the buyer sees (POL-04); requests
caught by a crash (POL-03); partners without holds (POL-28); the single authority for a
link (POL-05); the route deadline (POL-26); waiting on capacity in flight for any
request, single-link or route (POL-05 as amended: wait within the deadline, `wait = false`
for an immediate rejection); the commit margin (POL-26: `commit_margin` = 10 s); the price
of an extension (POL-08 as amended: the added part at the current price).

1. **Partner reconciliation interval.** How often must Share's record of partner bookings be
   reconciled with each partner, and who resolves a mismatch?
2. **Several partners per route in practice.** How often does a route cross more than one
   partner, and do their holds cover `route_deadline_max` plus `commit_margin`?
3. **`account_inflight_limit` for a new account.** POL-25's default is 10 × the account's
   largest confirmed reservation. An account with no confirmed reservation would then have a
   limit of zero and could never book. Is a floor intended?
