# P2. Reserving a route across several providers' links, all or nothing

## Context

A buyer on the marketplace does not want capacity on one link; it wants a **path**: "the
path, the performance, how long they need it". A path such as
Nairobi → Mombasa → Djibouti → Marseille is a chain of links, and each link may belong to a
different infrastructure provider. Share claims 16 such providers and 7 subsea cables (see
the [company profile](company-profile.md)).

[P1](P1-link-admission.md) answers whether one link can take a reservation without
overselling, within 200 ms. P2 is the step above it: booking capacity on every link of a
route, for the same window and the same rate, as one purchase.

Some links on a route are run by Share. Others are managed in a partner's own system, for
example a subsea cable operator's. Share cannot take part in that system's transactions,
the partner knows nothing about Share's internal rules for who goes first, and its API
fails, times out and responds slowly.

## Who is affected

| Who | How |
|---|---|
| **Buyers** (builders, enterprises, AI agents calling the API) | A path that is booked on some links but not others is useless to them and may still be billed. They need one definite answer for the whole route. AI agents retry fast and often. |
| **Suppliers and partners** | Their capacity is sold through Share. Capacity tied up by a purchase that never completes is capacity they cannot sell to anyone else. |
| **Share** | Revenue is lost when a buyer who could have been served is turned away. Reputation is lost when capacity is sold that cannot be delivered; that is what sank the bandwidth exchanges of around 2000. |
| **The business owners of the marketplace** | They decide what the marketplace optimises for when buyers compete. Engineering has to give them that choice instead of making it for them. |

## The problem

1. **All or nothing across systems Share does not own.** A route is booked on every one of
   its links or on none. There is no single transaction that spans Share's links and a
   partner's, so the booking necessarily happens in steps, and any step can fail after
   earlier ones succeeded.
2. **Capacity in flight.** While a route request is in progress, the capacity it is
   about to take must not be sold to someone else, or the same link is sold twice. Yet the
   request may still fail, and then that capacity must become available again, even if the
   process handling the request has died.
3. **Competing buyers.** Two requests may want the same capacity at the same time. Turning
   one away because of the other's unfinished request is a lost sale if the other request
   then fails. Telling the buyer to "retry later" does not help: nothing guarantees the
   buyer retries, and the capacity may end up unsold.
4. **Crossed routes.** Two route requests can each get part of what the other needs and
   then wait on each other. If neither gives way, both can run out of time and both buyers
   lose, even though one of them could have been served.
5. **Unreliable partners.** A partner call can fail before doing anything, can do the work
   and lose the answer, or can be slow. A blind retry must not book twice; giving up must
   not leave capacity tied up at the partner forever.
6. **Crashes mid-booking.** The process booking a route can die at any point. After it
   restarts, every route must end up either fully booked or not booked at all, never
   partly booked, and never booked on a link that was not actually secured.
7. **Client retries.** Clients retry after timeouts. The same request sent twice must not
   create two bookings; a different request sent under the same idempotency key must not
   silently get the first one's answer.

### What the business owns

When a request fits only if some other in-progress request fails, what should happen is
not a technical question; it is a question of **what the marketplace is optimising for**.
The candidate objectives are for the business to rank:

| Objective | Pulls towards |
|---|---|
| Never oversell | A fixed constraint every option must respect, not something to trade off |
| Sell as much capacity as possible | Making the request wait rather than turning it away |
| Fast, definite answers for buyers | Turning the request away with a "retry after" time |
| Value of the request | Priority rules, e.g. a whole route beating a single-link request |

The system must let the business choose and change this without the booking itself
changing. One requirement is already set by the business: **when buyers compete for the
same link, at least one of them walks away with a reservation**, as long as the capacity
remains. This rules out "reject with retry after" as the default behaviour.

## Constraints and assumptions

| # | Constraint or assumption | Status |
|---|---|---|
| C1 | Never oversell any link, Share's or a partner's. | *Assumed* (marketplace requirement from the design interview) |
| C2 | A route is booked on every link or on none; partial bookings are never visible to the buyer or written as reservations. | *Assumed* |
| C3 | Whole-route requests are allowed to be eventually consistent. Their latency budget is **seconds up to about a minute**, much looser than P1's 200 ms for a single link. Setting up the physical connection takes minutes anyway. | *Assumed* |
| C4 | Single-link requests keep P1's promise of a synchronous answer within 200 ms (p99). | *Assumed* |
| C5 | When buyers compete for the same capacity, at least one of them ends up with a reservation while the capacity remains. | *Assumed* (stated as a business requirement) |
| C6 | Strict first-come-first-served is not required, but confirmed reservations are never revoked, rejections carry a correct reason, and no request starves. | *Assumed* (carried over from P1) |
| C7 | Partner systems cannot join Share's transactions and do not understand Share's priority rules. They admit first come, first served. | *Assumed* |
| C8 | Partner APIs fail, time out after doing the work, and are slow, at random. Every partner call is idempotent by a key the caller supplies. | *Assumed* |
| C9 | A partner can put capacity on hold for a limited time, then confirm or release it. A confirm after the hold has lapsed is answered "unknown hold", not silently accepted. | *Assumed* |
| C10 | A partner reports "busy" (fits on its confirmed capacity but not with its current holds) or "no fit" (definitive), but cannot queue a request and call back. | *Assumed* |
| C11 | Clients send an idempotency key with every route request and may retry with it at any time. | *Assumed* |
| C12 | Time is discrete (minutes) and every link has a fixed booking horizon; windows are half-open and may be open-ended. | *Assumed* (carried over from P1) |
| C13 | The process that books routes can crash at any point; the database survives. | *Assumed* |
| C14 | The route (which links, in which order) is already chosen when the request arrives. | *Assumed* |
| C15 | A typical route mixes Share's links with at least one partner link; Nairobi and Mombasa are live, Djibouti and Marseille are next. | *Confirmed* (Share's public footprint claim) / *Inferred* (the mix) |
| C16 | Partner capacity is the link most likely to fail a booking, because it is the least reliable and the one Share cannot prioritise. | *Inferred* |

## Success measures

| Measure | Target |
|---|---|
| Oversold links (Share's and partners'), at any instant and in the stored reservations | Never |
| Routes booked on some links but not others | Never |
| Requests turned away while the capacity they asked for was in fact free | Never |
| Requests that end without a definite answer (confirmed or rejected) | None, under contention and partner faults |
| Answer time for a whole route | Within the route budget (about a minute), with partners failing and timing out |
| Crossed routes | Resolved without waiting for in-flight capacity to time out |
| Duplicate bookings from client or partner retries | Never |
| State after a crash and restart | Every route fully booked or not booked; capacity tied up by abandoned requests comes back within its time limit |
| Rejection reason | Names the link that could not fit and the minutes in conflict |

## Out of scope

- Choosing the route (path finding under latency and bandwidth limits). The request names
  its links.
- Admission on a single link: that is [P1](P1-link-admission.md).
- Provisioning the connection on the network once it is booked (Problem 5 in the company
  profile).
- Pricing, metering and billing the route ([P3](P3-usage-metering.md),
  [P4](P4-wallet-and-settlement.md)).
- How a partner admits capacity internally.

## Open questions

1. **The ranking of objectives.** Which of the objectives above wins, and in which
   situations, is for the business to decide. Only the "at least one competitor wins"
   requirement is settled.
2. **Single-link requests that run into an in-progress route.** A single-link request is
   promised an answer in 200 ms. What it should get when it fits only if a route's
   unfinished request fails is a policy question that is still open.
3. **What the buyer sees while a route is in progress.** Which request states are exposed,
   and whether the final answer arrives by webhook, by polling with the idempotency key,
   or both.
4. **Requests caught by a crash.** Should a request that was still in progress when the
   booking process died be resumed, or is failing it acceptable to buyers?
5. **Several partners on one route.** How often does a route cross more than one partner's
   system, and do those partners offer holds long enough to cover the whole booking?
6. **Partners without holds.** Some partners may only offer an immediate, final booking.
   How should such links be handled?
7. **Sharing links between P1 and P2.** Single-link and whole-route bookings land on the
   same links; who is the single authority for a link's schedule when both are live?
