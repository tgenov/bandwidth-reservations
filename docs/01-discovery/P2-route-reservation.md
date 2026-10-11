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

Admission also needs money: a reservation, or a change that adds to one, is confirmed only
if the account's headroom covers its funds hold (or credit hold) for a rolling coverage
window (POL-15), and agent keys are bound by their own limits (POL-25). The hold itself is
[P4](P4-wallet-and-settlement.md); the booking outcome that depends on it is here.

## Who is affected

| Who | How |
|---|---|
| **Buyers** (builders, enterprises, AI agents calling the API) | A path booked on some legs but not others is useless and may be charged. They need one definite outcome per request, fast, in a form a program can act on. AI agents retry fast and often, in parallel, from many keys. |
| **Agent operators** | Need hard limits on what an agent key can book, hold and spend, enforced without a human in the loop, and a key that stops working within a known time when revoked. |
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
work and lose the answer, or be slow. Clients retry after timeouts, and many agents of one
account act at once. And once booked, a reservation must be changeable without putting at
risk the part the buyer already has, even while other changes to it are in progress.

## Needs

Scenarios in [`02-specs/P2-route-reservation.feature`](../02-specs/P2-route-reservation.feature)
cite the need they serve with a tag `@need-P2-Nn`.

| ID | Need | Success measure |
|---|---|---|
| P2-N1 | **All or nothing.** A route is confirmed on every leg or on none, whatever fails along the way. "Confirmed" is never reported before every leg, the partner's included, is secured; and once confirmed, the reservation ends or changes only at its account's request (POL-08) or by Share's decision under POL-07 (revocation), POL-16 (release) or POL-30 (termination). | No route ever ends booked on some legs and not others; no confirmation is reported early; no reservation is withdrawn other than by its account, POL-07, POL-16 or POL-30. |
| P2-N2 | **A fast, uniform answer** (POL-04). Every booking request gets a response within `ack_budget`: final if the outcome is known by then, otherwise pending, with the outcome later by polling with the idempotency key, by webhook, or both. Each request ends with exactly one outcome from the glossary; a submission that is refused before it becomes a request (rate limits, key reuse) is *not accepted* and has none. | Every response within `ack_budget`; every request ends with one outcome, which never changes once reported. |
| P2-N3 | **A bounded wait** (POL-26, POL-08). A request has a deadline chosen by the buyer, at least `route_deadline_min` (and `commit_margin` more with a partner leg) and at most `route_deadline_max`. It has its outcome by its deadline: a request with a partner leg does not begin committing later than deadline − `commit_margin`. Capacity held on Share links is free the moment the outcome is reached; capacity held at a partner is released by the deadline. A buyer may withdraw a pending request; it fails as "withdrawn" and releases what it holds. | No request without an outcome at its deadline; no capacity held for a request after its outcome on Share links, or after its deadline at a partner, unless that request was confirmed. |
| P2-N4 | **Fair contention** (POL-02, POL-05). Contention alone never makes every competitor lose, for requests that wait (the default) and whose deadline outlasts the outcome of the request ahead of them. A request that fits only if a request in flight fails waits, pending, within its own deadline; the priority rule orders waiting requests; a request already holding capacity is not pre-empted; in a crossing the older keeps its holds and the younger releases its conflicting holds and waits. A request is rejected for no fit only if it does not fit on committed capacity. A buyer who asks not to wait (`wait = false`) is rejected at once with `retry_after`; it, and a request that chose a deadline shorter than the outcome it waits on, are outside the guarantee. A loss caused by failure leaves nothing held and tells the buyer why. The priority rule can be changed without changing uncontended outcomes. | Under any contention: among waiting requests whose deadlines outlast the outcome ahead, never all lose; no waiting request is rejected while its window fits on committed capacity; crossings are resolved before any deadline would otherwise expire them; every path where all competitors lose is one of the excluded ones, with nothing held. |
| P2-N5 | **Recovery from Share's own faults** (POL-03). A request interrupted by a failure of Share's booking process resumes if it can still finish within its deadline; otherwise it fails, releases everything and the buyer is told why. | After any crash and restart, every request ends with one outcome, and no route is partly booked. |
| P2-N6 | **Retries never book twice** (POL-29). Idempotency keys are scoped to the account and identify their request for `idempotency_retention` (24 h). The same request (same route, window, rate, product and `wait` setting) sent again by the same principal is booked once and gets the same answer; a retry while the request is pending gets its current status; a reuse of the key for a different request, or by a different principal of the account, is not accepted and learns nothing. | Zero duplicate bookings from client retries; zero answers to a reused key that reveal or change the first request. |
| P2-N7 | **Partners are booked safely.** Share never confirms a leg the partner has not confirmed; partner retries never book twice; a transient partner refusal does not end the request before its deadline; Share's record of partner bookings is reconciled with the partner; a partner without holds is booked last, at most one per route, and Share cancels it and bears the cost if a later step fails (POL-28). | Share's record of every partner booking matches the partner's after reconciliation; no route through a partner without holds ends partly booked or charged to the buyer for a failed booking. |
| P2-N8 | **Funds and limits are checked at admission** (POL-15, POL-25, POL-16). A request or change is confirmed only if the account's headroom covers its funds hold (or, for a credit-limit account, its credit hold), the agent key's headroom covers it (the lower of the account's headroom and `key_spend_limit` less the key's spending in `key_spend_period`, POL-25 as amended in round 4), and the key and account stay within `key_inflight_limit` and `account_inflight_limit` (never below `account_inflight_floor`; capacity in flight counted once per request at its reserved rate). Submissions above `key_rate_limit`, `account_rate_limit` or `key_poll_limit` are not accepted. A suspended account cannot book or add to a reservation, and a request still pending when its account is suspended is not confirmed. Concurrent requests by one account or key are decided as if one at a time. Revoking a key fails its pending requests. Each rejection says which limit and, for funds, how much to pay. | No reservation or addition confirmed without its hold or beyond a key's or account's limits, however many requests arrive at once; every such rejection states its reason and, for funds, the amount needed. |
| P2-N9 | **A reservation can be changed or ended as one unit** (POL-08). Cancel or shorten at any time, from the next minute boundary; extend or increase the rate, from the next minute boundary to the end, by admitting only the difference, never putting the existing part at risk; decrease from the next minute boundary, most recent part first; no change to part of a route. A change is admitted like a new booking (capacity, funds, key headroom, limits); a suspended account may cancel, shorten or decrease, but not extend or increase. Changes to one reservation are applied one at a time in arrival order, except that a cancellation is never delayed by a pending change, which then fails. Changes over partner legs follow the partner's terms shown at booking, and stay all or nothing. Partner minimum terms and cancellation fees are shown at booking. | Every change takes effect at a minute boundary not before the next one; no rejected change alters the existing reservation; capacity released by a change is available to others from its effective time; concurrent changes end in the state of some one-at-a-time order. |
| P2-N10 | **Operations can see requests in trouble.** Failed requests are visible to operations with their reason; a request still pending at its deadline raises an alert, since by design it cannot happen (POL-26). | Every failed request can be found with its reason and the leg concerned; every request pending at its deadline alerts. |
| P2-N11 | **A route rejection is a counter-offer for the whole route** (POL-10). It names the link that blocked it and states, as far as computable, the largest rate that fits every leg for the requested window and the earliest window of the requested length that fits the requested rate on every leg, within the selling horizon. | Every route rejection for no fit carries the blocking link and a counter-offer that fits every leg. |

Latency and throughput targets are owned by [X2](X2-non-functional-targets.md); who may
book, change and see which requests, agent-key management and the scoping of idempotency
keys to accounts, by [X1](X1-security-and-tenancy.md).

## Constraints and assumptions

"Confirmed" means stated in a primary source: the job listing or the business statement
made in the mock interview. "Decided" means set in the [policy register](../02-specs/policy-register.md).

| # | Constraint or assumption | Status |
|---|---|---|
| C1 | Share never confirms more than a link can carry, on its own links or partners'. Share cannot guarantee a partner never oversells its own link; it guarantees only that it never confirms a leg the partner has not confirmed. | *Assumed* |
| C2 | A route is booked on every leg or on none; partial bookings are never visible to the buyer or recorded as reservations. | *Assumed* |
| C3 | Every request is answered within `ack_budget` (200 ms at p99), final or pending; a route's final outcome comes by its deadline (default 30 s, at most 60 s, at least 1 s, or 11 s with a partner leg). | *Decided* (POL-04, POL-26 rounds 3 and 4) |
| C4 | When buyers compete for the same capacity, at least one of them ends up with a reservation while the capacity remains. Scoped by policy: contention alone never makes every competitor lose, for requests that wait and whose deadline outlasts the outcome ahead of them; losses caused by failures are not contention losses. | *Confirmed* (business statement, mock interview); scope *Decided* (POL-02, round 3) |
| C5 | The oldest request wins under contention; the rule is deployment configuration. It orders waiting requests and resolves crossings (the older keeps its holds); it never pre-empts a request already holding capacity. A request blocked only by capacity in flight waits within its deadline unless it asks not to (`wait = false`). | *Decided* (POL-02, POL-05) |
| C6 | Partner systems cannot join Share's transactions and do not understand Share's priority rule. They admit first come, first served. | *Assumed* |
| C7 | Partner APIs fail, time out after doing the work, and are slow, at random. Every partner call is idempotent by a key the caller supplies. | *Assumed* |
| C8 | Most partners can set capacity aside for a limited time, then confirm or release it; a confirmation after that time has lapsed is answered as unknown, not silently accepted. Some partners can only book immediately and finally. | *Assumed*; handling *Decided* (POL-28) |
| C9 | A partner can say it cannot take a request right now (transient) or that it cannot fit it (definitive), but cannot queue a request and call back. | *Assumed* |
| C10 | Clients send an idempotency key with every booking request and may retry with it at any time; a key identifies its request for 24 h; a reuse by another principal of the account is not accepted. | *Assumed*; scope and retention *Decided* (POL-29) |
| C11 | Time is discrete (minutes); windows are half-open and may be open-ended; the selling horizon is P1's. Rates are whole Mbps. | *Assumed* / *Decided* (POL-09, POL-31) |
| C12 | Share's booking process can crash at any point; what it has recorded survives. | *Assumed* |
| C13 | The route (which links, in which order) is chosen before the request arrives. | *Assumed* |
| C14 | A typical route mixes Share's links with at least one partner link; Nairobi and Mombasa are live, Djibouti and Marseille are next. | *Confirmed* (Share's public footprint claim) / *Inferred* (the mix) |
| C15 | Partner legs are the most likely to fail a booking, being the least reliable and the ones Share cannot prioritise. | *Inferred* |
| C16 | A route is one unit: no change to part of it (POL-08). A partner leg may impose a minimum term or cancellation fee, shown at booking and charged as a cancellation fee; the funds hold is the larger of the coverage and that fee. The added part of an extension or rate increase is priced at the price in force when the change is made; the existing part keeps its price. | *Decided* (POL-08, POL-27) |
| C17 | Limits above the key: `account_rate_limit` (200 requests/s), `account_max_keys` (100), `key_poll_limit` (20 polls/s); polls do not count toward booking limits, retries do. Key revocation takes effect for new requests within 60 s. | *Decided* (POL-25, round 3) |

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
link (POL-05); the route deadline (POL-26); waiting on capacity in flight (POL-05); the
commit margin and when outcomes exist (POL-26, round 3: by the deadline); who "never all
lose" covers and how crossings and pre-emption work (POL-02, round 3); idempotency scope,
retention and sameness (POL-29); change mechanics, rate increases, decreases, suspended
accounts and withdrawal (POL-08, round 3); key spending, revocation and limits above the
key (POL-25, rounds 3 and 4); capacity in flight per request (POL-25, round 3); a
cancellation racing a pending change (POL-08, round 4); minimum deadline (POL-26,
round 4); rate precision (POL-31, round 4).

1. **Partner reconciliation interval.** How often must Share's record of partner bookings be
   reconciled with each partner, and who resolves a mismatch?
2. **Several partners per route in practice.** How often does a route cross more than one
   partner, and do their holds cover `route_deadline_max` plus `commit_margin`?
3. **Accounts per actor.** POL-25 bounds requests and capacity in flight per account, not
   per actor. Whether the KYC tiers of the payment partner (POL-24) bound how many accounts
   one actor can open, and so how far hold-squatting can be multiplied, is to be checked
   with the partner.
