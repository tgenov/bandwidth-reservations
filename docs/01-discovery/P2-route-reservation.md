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
| P2-N2 | **A fast, uniform answer** (POL-04). Every booking request gets a response within `ack_budget`: final if the outcome is known by then, otherwise pending, with the outcome later by polling with the idempotency key, by webhook, or both. Each request ends with exactly one outcome from the glossary, decided at one point in time; a status read may lag that decision by at most `status_staleness`, reporting pending until it reflects it, and never reports another outcome; while the decision record is unavailable, before or at the deadline, it reports pending or the decided outcome, never another, until the record is available again (at most 1 min after it became unavailable, and up to `release_grace` after the deadline when unavailable at it), and once the outcome was reported, the outcome (POL-04, POL-26). An outcome other than confirmed is reported only once the Share-link capacity it frees is durably released: within `status_staleness` of the decision, or within `release_grace` of it while the schedule owner of a Share link it holds is failing over (POL-04). Once reported, an outcome is reported by every later status read (POL-04). A submission that is refused before it becomes a request (rate limits, key reuse) is *not accepted* and has none. | Every response within `ack_budget`; every request ends with one outcome, which never changes once reported; no status read reports an outcome other than the one decided, even while the decision record is unavailable, and every status read from `status_staleness` after the decision reports it (from the record's return when the decision record was unavailable: at most 1 min after it became unavailable before the deadline, at most `release_grace` after the deadline when unavailable at it; from at most `release_grace` after the decision when a non-confirmed outcome waits for a release on a link whose schedule owner is failing over); no outcome reported while capacity it frees is still held; no status read reports pending after the request's outcome was reported. |
| P2-N3 | **A bounded wait** (POL-26, POL-08, POL-28). A request has a deadline chosen by the buyer, at least `route_deadline_min` (and `commit_margin` more with a partner leg) and at most `route_deadline_max`. It has its outcome by its deadline: a request with a partner leg does not begin committing later than deadline − `commit_margin`, and one without a partner leg not later than deadline − `ack_budget`; a request not confirmed by its deadline has failed as of its deadline, whatever Share's own state, and a confirmation counts only if decided before its deadline; no confirmation is ever decided after the deadline, though one decided in time may become known up to `release_grace` after it if Share's record of the request's decision was unavailable at the deadline (POL-26). Capacity held on Share links is free from the moment the outcome is reported (its release durable before then, POL-04), and at the latest at the deadline; if the decision record is unavailable at the deadline (at it, or at any time in the last `ack_budget` before it), it is released within `release_grace` after the deadline instead, unless a confirmation decided in time makes it the reservation's, and operations is alerted; if the link's schedule owner is failing over at the deadline, it is likewise released within `release_grace` after the deadline (POL-26). Capacity held at a partner is released by the deadline: Share sets every partner hold to expire at the request's deadline, so it lapses then by itself even if Share is unavailable, and at the deadline Share also releases every hold the request still has, partner holds included. A partner that cannot accept a hold expiry set by Share, or whose holds cannot last `route_deadline_max` + `commit_margin`, is a partner without holds (POL-26, POL-28). A partner booking (a leg the partner has confirmed, at a partner with or without holds) for a request left without Share's confirmation is cancelled at once, at Share's cost (POL-28, POL-08). A buyer may withdraw a pending request; it fails as "withdrawn" and releases what it holds. | No request without an outcome at its deadline, even across an outage of Share's booking process; no request with a partner leg beginning to commit after its deadline less `commit_margin`, and none without one after its deadline less `ack_budget`; no confirmation decided at or after its deadline, and none known later than `release_grace` after its deadline; for a request that is not confirmed, no capacity held on a Share link once its outcome is reported, or later than `release_grace` after its deadline when Share's record of its decision was unavailable at the deadline or the link's schedule owner was failing over then; no partner hold after its deadline; every partner booking for a request left without Share's confirmation cancelled at once, at Share's cost (this booking is not a hold, and is the only partner capacity a request that is not confirmed can keep past its deadline). |
| P2-N4 | **Fair contention** (POL-02, POL-05). Contention alone never makes every competitor lose, for requests that wait (the default) and whose deadline, less their completion margin (`commit_margin` with a partner leg, `ack_budget` otherwise), outlasts the outcome of the request ahead of them (POL-02). A request that fits only if a request in flight fails waits, pending, within its own deadline; the priority rule orders waiting requests; a request that holds capacity and is not waiting is not pre-empted; a younger request that holds capacity an older waiting request needs, and is itself waiting, releases that capacity and waits, which breaks a pairwise crossing and every longer cycle (POL-02). A partner's definite refusal while another Share request holds, or has booked for a request not yet decided, overlapping capacity at that partner is contention Share caused: the refused request waits within its deadline, as on a Share link, and asks again when that hold or booking resolves (a partner booking for a request that is not confirmed resolves when Share has cancelled it) (POL-02, POL-28). A request is rejected for no fit only if it does not fit on committed capacity. A buyer who asks not to wait (`wait = false`) is rejected at once with `retry_after` (the latest remaining deadline among the requests in flight holding what it needs, on one link or several legs, POL-05) and the POL-10 counter-offer computed beside the capacity in flight; it, and a request whose deadline, less its completion margin, ends before the outcome it waits on, are outside the guarantee, and a waiter failed at its deadline is told "deadline passed while waiting" with a `retry_after` (with several requests ahead, the latest of their remaining deadlines, POL-02). A request takes no capacity hold before its funds hold or credit hold (POL-25). A loss caused by failure leaves nothing held and tells the buyer why. The priority rule can be changed without changing uncontended outcomes. | Under any contention: among waiting requests whose deadlines, less their completion margins, outlast the outcome ahead, never all lose; no waiting request is rejected while its window fits on committed capacity; no set of waiting requests, two or more, stays blocked on each other's holds until a deadline; no request is rejected because of a partner refusal caused by another Share request's hold or undecided booking; every path where all competitors lose is one of the excluded ones, with nothing held and a reason given. |
| P2-N5 | **Recovery from Share's own faults** (POL-03). A request interrupted by a failure of Share's booking process resumes if it can still finish within its deadline; otherwise it fails, releases everything and the buyer is told why. | After any crash and restart, every request ends with one outcome, and no route is partly booked. |
| P2-N6 | **Retries never book twice** (POL-29). Idempotency keys are scoped to the account and identify their request for `idempotency_retention` (24 h). The same request (same route, window, rate, product and `wait` setting; for a change, the same reservation, kind of change, new end or new rate, and `wait` setting) sent again by the same principal is booked or applied once and gets the same answer; a retry while the request is pending gets its current status; a reuse of the key for a different request, or by a different principal of the account, is not accepted and learns nothing. | Zero duplicate bookings from client retries; zero answers to a reused key that reveal or change the first request. |
| P2-N7 | **Partners are booked safely.** Share never confirms a leg the partner has not confirmed; partner retries never book twice; a transient partner refusal does not end the request before its deadline; a partner call with an unknown result is reconciled for that booking at once, by idempotent re-query; every partner is fully reconciled daily, by 12:00 UTC on D + 1, each mismatch alerting operations; a partner booking with no Share reservation behind it is cancelled at Share's cost, and a Share reservation the partner lacks is treated as affected by an unplanned outage on that leg (POL-28); a partner without holds is booked last, at most one per route (POL-28); any partner booking, at a partner with or without holds, left without Share's confirmation (a later step fails, the request is withdrawn or its deadline passes) is cancelled at once, and Share bears the cost (POL-28, POL-08). | Share's record of every partner booking matches the partner's after reconciliation; every mismatch alerted by 12:00 UTC on D + 1; no buyer charged for a partner booking Share does not record; no route through a partner ends partly booked or charged to the buyer for a failed booking. |
| P2-N8 | **Funds and limits are checked at admission** (POL-15, POL-25, POL-16). A request or change is confirmed only if the account's headroom covers its funds hold (or, for a credit-limit account, its credit hold), the agent key's headroom covers it (the lower of the account's headroom and `key_spend_limit` less the key's spending in `key_spend_period`, which counts the charges and holds of the parts the key booked or added, never another principal's, POL-25), and the key and account stay within `key_inflight_limit` and `account_inflight_limit` (never below `account_inflight_floor`; capacity in flight counted once per request at its reserved rate). Submissions above `key_rate_limit`, `account_rate_limit` or `key_poll_limit` are not accepted. A suspended account cannot book or add to a reservation, and a request not yet decided when its account is suspended is not confirmed; a request decided before the suspension keeps its outcome, even while a status read still shows it pending (POL-04). Concurrent requests by one account or key are checked one at a time, in the order received, each funds, key-headroom and capacity-in-flight check counting the holds of the requests then in flight; a request refused because of such a hold stays refused even if that request later fails, so two concurrent requests may both fail where a strictly serial run would have let one succeed (POL-25). Revoking a key fails its requests not yet decided. A request takes no capacity hold until its funds hold or credit hold is taken, and both are released at its outcome if it is not confirmed (POL-25). A negative key headroom blocks new bookings and additions by that key only. Each rejection says which limit and, for funds, two amounts: the minimum payment to be confirmed (hold less headroom), and that minimum plus `low_balance_warning` (POL-10). | No reservation or addition confirmed without its hold or beyond a key's or account's limits, however many requests arrive at once; every concurrent outcome equals that of checking the requests one at a time in the order received; no capacity held for a request without its funds hold; every such rejection states its reason and, for funds, both amounts. |
| P2-N9 | **A reservation can be changed or ended as one unit** (POL-08). Cancel or shorten at any time, from the next minute boundary; extend or increase the rate, from the next minute boundary to the end, by deciding only the difference against capacity, never putting the existing part at risk; decrease from the next minute boundary, most recent part first; no change to part of a route. A change is decided like a new booking (capacity, funds, key headroom, limits); a suspended account may cancel, shorten or decrease, but not extend or increase. Changes to one reservation are applied one at a time in arrival order, except that a cancellation is never delayed by a pending change, which then fails; a shortening whose new end is at or before the next minute boundary is a cancellation, and any other shortening is ordered with the other changes. Changes over partner legs follow the partner's terms shown at booking, and stay all or nothing: a decrease over a partner leg whose shown terms do not allow one is rejected, stating the rule, and a shortening into a partner's minimum term incurs its shown fee as a cancellation would (POL-08). Partner minimum terms, cancellation fees and whether a leg can be decreased are shown at booking. | Every change takes effect at a minute boundary not before the next one; no rejected change alters the existing reservation; capacity released by a change is available to others from its effective time; concurrent changes end in the state of some one-at-a-time order. |
| P2-N10 | **Operations can see requests in trouble.** Failed requests are visible to operations with their reason; a request still pending at its deadline raises an alert, since by design it cannot happen, and so does a request whose decision record is unavailable at its deadline (POL-26). | Every failed request can be found with its reason and the leg concerned; every request pending at its deadline, and every request whose decision record is unavailable at its deadline, alerts. |
| P2-N11 | **A route rejection is a counter-offer for the whole route** (POL-10). It names the link that blocked it and states, as far as computable, the largest rate that fits every leg for the requested window and the earliest window of the requested length, starting at or after the requested start (POL-10), that fits the requested rate on every leg, within the selling horizon. | Every route rejection for no fit carries the blocking link and a counter-offer that fits every leg. |

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
| C3 | Every request is answered within `ack_budget` (200 ms at p99), final or pending; a route's final outcome comes by its deadline (default 30 s, at most 60 s, at least 1 s, or 11 s with a partner leg). | *Decided* (POL-04, POL-26) |
| C4 | When buyers compete for the same capacity, at least one of them ends up with a reservation while the capacity remains. Scoped by policy: contention alone never makes every competitor lose, for requests that wait and whose deadline, less their completion margin (`commit_margin` with a partner leg, `ack_budget` otherwise), outlasts the outcome ahead of them; losses caused by failures are not contention losses. | *Confirmed* (business statement, mock interview); scope *Decided* (POL-02) |
| C5 | The oldest request wins under contention; the rule is deployment configuration. It orders waiting requests; a younger waiting request releases capacity an older waiting request needs (crossings and longer cycles); it never pre-empts a request that holds capacity and is not waiting. A request blocked only by capacity in flight, or refused by a partner because of another Share request's hold there, waits within its deadline unless it asks not to (`wait = false`). | *Decided* (POL-02, POL-05) |
| C6 | Partner systems cannot join Share's transactions and do not understand Share's priority rule. They admit first come, first served. | *Assumed* |
| C7 | Partner APIs fail, time out after doing the work, and are slow, at random. Every partner call is idempotent by a key the caller supplies. | *Assumed* |
| C8 | Most partners can set capacity aside for a limited time, then confirm or release it; a confirmation after that time has lapsed is answered as unknown, not silently accepted. Some partners can only book immediately and finally. A partner counts as offering holds only if its holds can last `route_deadline_max` + `commit_margin` and it accepts a hold expiry time set by Share, which Share sets to the request's deadline. | *Assumed*; handling *Decided* (POL-26, POL-28) |
| C9 | A partner can say it cannot take a request right now (transient) or that it cannot fit it (definitive), but cannot queue a request and call back. | *Assumed* |
| C10 | Clients send an idempotency key with every booking request and may retry with it at any time; a key identifies its request for 24 h; a reuse by another principal of the account is not accepted. | *Assumed*; scope and retention *Decided* (POL-29) |
| C11 | Time is discrete (minutes); windows are half-open and may be open-ended; the selling horizon is P1's. Rates are whole Mbps. | *Assumed* / *Decided* (POL-09, POL-31) |
| C12 | Share's booking process can crash at any point; what it has recorded survives. | *Assumed* |
| C13 | The route (which links, in which order) is chosen before the request arrives. | *Assumed* |
| C14 | A typical route mixes Share's links with at least one partner link; Nairobi and Mombasa are live, Djibouti and Marseille are next. | *Confirmed* (Share's public footprint claim) / *Inferred* (the mix) |
| C15 | Partner legs are the most likely to fail a booking, being the least reliable and the ones Share cannot prioritise. | *Inferred* |
| C16 | A route is one unit: no change to part of it (POL-08). A partner leg may impose a minimum term or cancellation fee, shown at booking and charged as a cancellation fee; the funds hold is the larger of the coverage and that fee. The added part of an extension or rate increase is priced at the price in force when the change is made; the existing part keeps its price. | *Decided* (POL-08, POL-27) |
| C17 | Limits above the key: `account_rate_limit` (200 requests/s), `account_max_keys` (100), `key_poll_limit` (20 polls/s); polls do not count toward booking limits, retries do. Key revocation takes effect for new requests within 60 s. | *Decided* (POL-25) |
| C18 | Hold-squatting across many accounts is bounded by money, not by KYC tiers: a request takes no capacity hold until its funds hold or credit hold is taken. | *Decided* (POL-25) |
| C19 | Partners are reconciled per booking at once when a call's result is unknown, and fully every day by 12:00 UTC on D + 1; mismatches are resolved at Share's cost. | *Decided* (POL-28) |
| C20 | A request not confirmed by its deadline has failed as of its deadline, whatever Share's state; committing begins no later than the deadline less the completion margin (`commit_margin` with a partner leg, `ack_budget` otherwise), and a confirmation counts only if decided before the deadline, becoming known at most `release_grace` after the deadline if the decision record was unavailable; a Share-link hold is released at the deadline, or within `release_grace` (1 min) after it if the decision record is unavailable then or the link's schedule owner is failing over, and is free once the outcome is reported, which for an outcome other than confirmed is once its releases are durable (within `status_staleness` of the decision, or `release_grace` during a schedule owner's failover); a partner's hold expires at the deadline, at the expiry Share set for it; a partner booking left without Share's confirmation is cancelled at once at Share's cost (POL-28). Each outcome is decided at one point; status reads lag it by at most `status_staleness` (1 s), never contradict it, and never report pending once the outcome was reported. | *Decided* (POL-26, POL-04, POL-28) |

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
commit margin and when outcomes exist (POL-26: by the deadline); who "never all
lose" covers and how crossings and pre-emption work (POL-02); idempotency scope,
retention and sameness (POL-29); change mechanics, rate increases, decreases, suspended
accounts and withdrawal (POL-08); key spending, revocation and limits above the
key (POL-25); capacity in flight per request (POL-25); a
cancellation racing a pending change (POL-08); minimum deadline (POL-26); rate precision (POL-31); contention cycles, partner refusals caused by
Share's own holds, and what a request outside the guarantee gets back (POL-02);
partner reconciliation interval and who resolves a mismatch (POL-28); accounts
per actor and hold-squatting (POL-25: no capacity hold before the funds hold,
whatever the number of accounts); the outcome when Share is down past a deadline
(POL-26); Share-link holds when the decision record is unavailable at the deadline
(POL-26: released within `release_grace`); partner bookings left without Share's
confirmation (POL-28: cancelled at once, at Share's cost); the counter-offer's earliest window and the insufficient-funds quote
(POL-10).

1. **Several partners per route in practice.** How often does a route cross more than one
   partner, and do their holds cover `route_deadline_max` plus `commit_margin`?
