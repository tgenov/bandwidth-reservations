# Policy register

Business policy that the specs depend on. Specs state mechanism and refer to these
policies by ID (`POL-nn`) and their named parameters; changing a policy or a parameter
value must not require a change of mechanism.

**Status of every entry: Decided (provisional).** The decisions were made by the design
team from public information about the market and about Share (see the
[company profile](../01-discovery/company-profile.md)), to unblock the design. The
business must ratify them. Each entry answers a Decision question from the
[requirements review](../reviews/01-requirements-review.md) (`D-nn` there, `R-nn` the
finding), and later questions from the requirements gates (`GA-nn`, `GB-nn`, gate A
`D-nn`, gate B `Dn`) and the final gates (final gate A `D-n`, final gate B `Dn`), and
issues the [architecture overview](../03-rfcs/RFC-000-architecture.md) raised against the
requirements (`RI-n`), and the requirements issues raised by the
[review of that overview](../reviews/06-rfc-000-review.md) (`RQ-n`, with its decision D3), continued by the revised overview (RQ-5, RQ-6) and by
the [second review of that overview](../reviews/08-rfc-000-review-2.md) (RQ-7 to RQ-11,
finding A0R-05).

**How to read an entry.** Each entry states the **current** rule, self-contained: the
decision as rules, its parameters with their current defaults, why, and the alternatives
rejected. Where a later round changed an earlier decision, only the later one is stated.
How each entry got here is recorded in the [Amendments](#amendments) table at the end;
the provenance line under each heading lists the questions it answers.

## Market position the policies follow from

- **Share does not oversubscribe.** An admitted reservation removes that capacity from
  inventory whether or not traffic crosses it. Incumbent carriers oversubscribe and sell
  the gap between reserved and used; Share sells the guarantee.
- **The competition is term contracts and slow provisioning.** In the markets Share
  serves, capacity is bought on monthly-to-multi-year commitments with weeks of lead
  time. NaaS platforms (Megaport, PacketFabric, Equinix Fabric) price provisioned
  capacity per hour or month. Share's edge is **granularity and lead time**: a path
  bought through an API, for minutes, with no term.
- **Carrier neutrality.** An open-access marketplace must treat buyers and suppliers
  without discrimination, and must be trusted by suppliers to settle fairly.
- **Buyers include AI agents.** They act fast and repeatedly, and need machine-readable
  answers, hard spending limits and no human in the loop.
- **East African payments are prepaid and mobile-first** (M-Pesa). Wholesale capacity is
  priced in USD.

## Summary

| ID | Topic | Decision in one line |
|---|---|---|
| POL-01 | Pricing model | Pay per reservation: per Mbps-minute reserved, accrued per minute, no minimum term; usage pricing only for best-effort, burst and traffic outside a reservation |
| POL-02 | Contention | The oldest request wins; a waiting younger holder yields; contention alone never makes every competitor lose, for waiters whose deadline less their completion margin outlasts the outcome ahead; refusals caused by Share's own holds or undecided partner bookings are contention |
| POL-03 | Interrupted route requests | Resume within the deadline; otherwise fail, release, notify |
| POL-04 | Buyer interaction | An answer within `ack_budget`: final if ready, otherwise `pending`, then poll or webhook; each outcome is decided at one point, and a status read lags it by at most `status_staleness`, never contradicting it; an outcome other than confirmed is reported only once its Share-link releases are durable, within `status_staleness` of the decision (`release_grace` while a link's schedule owner is failing over); pending while the decision record is unavailable, before or at the deadline (at most 1 min, or up to `release_grace` past the deadline), unless the outcome was already reported; capacity is free from the moment the outcome is reported |
| POL-05 | Authority over a link | One schedule owner per link; a single-link booking is a one-leg route; contended requests wait unless `wait = false` |
| POL-06 | Non-functional targets | 99.99% admission and ingestion, 99.9% wallet, payouts, reporting, in each serving region; funds holds and headroom checks for bookings held to admission's targets; ×50 design load; RPO 0; RTO per capability (1 min to 30 min on node or zone loss, 1 h on region loss); a declared region disaster is outside the availability, latency and timeliness measurements, while RPO 0 still applies; the assumed topology, and its go-live condition of diverse fibre paths, are in X2's constraints; probes use a designated account, on a credit limit set by finance, with no business side effects |
| POL-07 | Loss of supply | Never revoke silently; stop new sales at once; an outage affects only the minutes it overcommits, all holders alike; maintenance on free capacity only; permanent reductions by notice, newest Mbps first, with a firm equivalent-path offer at the lower price, all-Share paths first, its Share-leg capacity held for `offer_window` and any partner leg booked at acceptance |
| POL-08 | Changing a reservation | Cancel or shorten any time; extend or increase by a new admission of the difference; decrease last in, first out; partner fees go wholly to the partner; Share pays to cancel a partner booking left without its confirmation |
| POL-09 | Selling horizon | Rolling 12 months; open-ended bookings guaranteed as the horizon rolls |
| POL-10 | Rejections | Actionable counter-offers from the requested start; two top-up amounts; never disclose other buyers |
| POL-11 | Money unit and rounding | Micros per currency; each charge line rounded down once; fees exact; residues carried, never taken |
| POL-12 | Splitting revenue | Webster per route; Share loses ties, then leg order; one party per supplier; rule published |
| POL-13 | Multi-minute flows | Exporters cut flows at 60 s; longer flows are spread evenly |
| POL-14 | Late usage | Billed whenever it arrives; exposure bounded by `usage_rate_cap` over lateness, attribution lag and enforcement time; breaches of the bound are reported |
| POL-15 | Funds at admission | Hold a rolling coverage window (or the partner fee, if larger, while it applies); vetted accounts get credit limits, invoices written off 90 days after due |
| POL-16 | Suspension | Suspend below zero headroom; keep reservations for a funded grace period, then release; resume automatically at `low_balance_warning` headroom and overdue invoices paid |
| POL-17 | Unmatched traffic | Kept always; over-rate traffic is policed; carried excess paid by Share; unattributable traffic is quarantined |
| POL-18 | Balance shown | Available headroom, with balance, held funds, accrued charges and the two parts of usage exposure itemised; unposted usage counts records accepted by ingestion |
| POL-19 | History | Bitemporal: every reservation change, who and when, kept 7 years |
| POL-20 | Currency | USD settlement; conversion at top-up (rounded up) and payout (rounded down) at a shown rate; each FX difference against the partner's USD amount posted to Share's own account |
| POL-21 | Reversals and refunds | Reversals in scope now; write-offs stay owed and keep the account suspended until repaid; withdrawals later; SLA credits are service credit |
| POL-22 | Payouts | Weekly, on confirmed transfer, with a minimum amount; never instructed twice; a transfer the provider executes twice is recovered as debt |
| POL-23 | Bad debt | Share bears buyer credit risk and its own errors; supplier earnings are final once charged |
| POL-24 | Regulation | Hold funds through a licensed payment partner; daily signed reconciliation matching every partner transaction, Share's own deposits and withdrawals included, payments received but not yet posted and payouts executed but not yet confirmed each counted in flight; Share's own balance covers the receivables it funds (a treasury obligation, never a gate on movements) |
| POL-25 | AI-agent controls | Administrator-set per-key spending and in-flight limits, rate limits; funds held before capacity |
| POL-26 | Route deadline | Chosen per request, 1 s to 60 s (11 s with a partner leg), default 30 s; failed as of the deadline if not confirmed; committing begins no later than the deadline less the completion margin (`commit_margin` with a partner leg, `ack_budget` otherwise); confirmed only by a decision timestamped before the deadline, which may become known up to `release_grace` after the deadline if the decision record was unavailable; Share-link holds released at the deadline, or within `release_grace` after it if the decision record is unavailable then or a link's schedule owner is failing over; a partner's hold expires at the deadline by itself |
| POL-27 | Price changes | On minute boundaries only; a booked reservation keeps its price; open-ended ones change with notice |
| POL-28 | Partners without holds | Includes partners whose holds are too short or cannot be set to expire at the deadline; booked last; at most one per route; any partner booking left without Share's confirmation, with or without holds, is cancelled at once at Share's cost; reconciled at once and daily |
| POL-29 | Idempotency | Per account; a different principal is refused; 24 h for bookings, 7 years for money |
| POL-30 | Termination by Share | On Share's own decision, only for fraud, legal order or network abuse, recorded; support acting at an account's request is the account's own change |
| POL-31 | Reserved rate precision | Whole Mbps, at least 1 Mbps |
| POL-32 | Operator roles | Support, network operations, finance, compliance; four eyes on fraud and legal-order terminations and on identity disclosure |
| POL-33 | Supplier visibility | Reservation and opaque reference only; buyer identity only with an administrator's per-supplier consent or under a legal order |

---

## POL-01. Pricing model: pay per reservation

*Answers D-01 (R-02).*

**Decision.**
- Guaranteed products are priced per **Mbps-minute reserved**. The charge accrues minute
  by minute for as long as the reservation is active, whether or not traffic crosses it.
- There is no minimum term and no setup fee, unless a partner leg imposes a minimum term
  or cancellation fee (POL-08).
- Usage-based pricing (per GB, `usage_price`) applies only to: products with no
  guarantee (best-effort IP transit, CDN traffic); burst above a reservation where the
  product permits it; and traffic attributable to an account but outside an active
  reservation (POL-17).
- Metering is not the primary revenue path. It bills best-effort products, burst and
  traffic outside a reservation, and supplies evidence for SLA delivery (Problem 6).

| Parameter | Default |
|---|---|
| `reservation_price` | Per product and route, in micro-USD per Mbps-minute |
| `billing_granularity` | 1 minute; part minutes are charged as whole minutes |
| `minimum_term` | None (one minute), unless a partner leg imposes one (POL-08) |
| `usage_price` | Per product and route, per GB. Every product carries one, guaranteed products included (POL-17) |

**Why.** Without oversubscription, a reservation consumes inventory, and the supplier's
cost (fixed capacity) follows inventory, not bytes. Pricing usage instead would make
idle reservations free capacity held at the supplier's expense, invite hoarding
(especially by agents booking open-ended "just in case"), and put the metering pipeline
on the critical path of revenue. A reservation's charge is known at admission, so money
can be held exactly as capacity is held (POL-15). "Pay for what you use" still holds:
what is used is time on guaranteed capacity, bought by the minute.

**Rejected.** Pure pay-per-usage (hoarding, supplier idle risk, revenue exposed to
metering); minimum charges per period (a commitment by another name); idle-release
(revokes a guarantee the buyer paid for).

## POL-02. Contention: the oldest request wins

*Answers D-02 (R-04); gate A D-01, D-02, D-12; final gate A D-1, D-2; RFC-000 review RQ-2; RFC-000 review 2 RQ-7.*

**Decision.**
- When requests compete for the same capacity, the request that arrived first has
  priority (`priority_rule` = `request_age`). The rule is a configuration of the
  admission component, changed by deployment, not per request.
- Whatever the rule, these invariants are fixed: capacity is never oversold; when
  requests compete, at least one wins; no request waits forever.
- The priority rule orders requests that are **waiting**, and resolves conflicts over
  held capacity:
  - A younger request that holds capacity an older request is waiting for, and is
    itself waiting, releases that capacity and waits within its own deadline. It keeps
    its place among waiters. A **crossing** (two requests each holding capacity the
    other needs) is the two-request case: the older keeps what it holds and the younger
    releases its conflicting holds and waits. Longer cycles are broken the same way,
    without being detected as cycles.
  - A holder that is not waiting is never pre-empted: a request that holds capacity it
    needs and waits for nothing else keeps it, even against an older request.
- **Guarantee: contention alone never makes every competitor lose.** It covers requests
  that wait (`wait` = true, the default) and whose deadline, less their completion
  margin, outlasts the outcome of the request ahead of them.
  - A request's **completion margin** is the time it keeps inside its deadline to be
    confirmed: it may not begin committing later than its deadline less its completion
    margin (POL-26). It is `commit_margin` (POL-26) for a request with a partner leg,
    `ack_budget` (POL-04) otherwise. It is not a parameter of its own.
  - A request that opts out (`wait = false`), or whose deadline, less its completion
    margin, ends before the outcome it waits on, has excluded itself.
- **Partner refusals.** When a partner definitely refuses a leg while another Share
  request holds overlapping capacity at that partner, or has booked overlapping capacity
  there for a request not yet decided (a final-only booking at a partner without holds,
  or a partner's confirmation of a held leg before Share's decision, POL-28), the
  refusal is treated as contention. The refused request waits within its
  deadline, as on a Share link, until that request's outcome and, if it is not
  confirmed, Share's cancellation of its partner booking; then it asks the partner
  again. Other definite refusals by a partner still reject.
- Losses caused by failures (a partner's refusal not caused by Share's own hold or
  undecided booking, a partner fault, a deadline expired after a fault) are not
  contention losses; for them the guarantee is that nothing is left held and the buyer
  is told why.
- **What a request that drops out gets back.**
  - A waiter not confirmed by its deadline has failed as of its deadline (POL-26), with
    the reason "deadline passed while waiting" and a `retry_after` equal to the remaining
    deadline of the request ahead of it at that moment, or zero if that request already
    has its outcome.
  - A `wait = false` rejection carries the `retry_after` of POL-05 and the POL-10
    counter-offer, computed beside the capacity in flight.

| Parameter | Default |
|---|---|
| `priority_rule` | `request_age` |
| `wait` | Per request; true by default |

**Why.** Age is predictable and explainable, cannot be bought or gamed, and is
non-discriminatory, which a carrier-neutral marketplace needs. Letting every waiting
younger holder yield breaks every cycle at once without detecting cycles across links;
the cost is that a waiting request can give up a hold that was not in a cycle, but it
keeps its place. Treating refusals caused by Share's own holds, or by its final-only
bookings for undecided requests, as contention keeps the guarantee wherever Share caused
the contention, at the cost of extra partner calls and longer waits on hot partner links;
Share's risk is unchanged, since POL-28 already makes it bear the cancellation. Scoping
the guarantee by the completion margin reuses margins the buyer already accepts, so a
waiter is never promised an outcome it has no time left to complete; the excluded slice
of deadlines grows by at most `commit_margin` on partner routes. Agents get a
deterministic rule and a machine-actionable next step without the guarantee being
stretched.

**Rejected.** Value-based priority (invites gaming: inflating size or duration to win);
customer tiers (a two-class market at odds with standardised pricing).

## POL-03. Interrupted route requests: resume within the deadline

*Answers D-03 (R-05).*

**Decision.** If Share's booking process fails while a route request is in progress,
the request resumes automatically if it can still finish within its deadline (POL-26).
Otherwise it fails, everything it held is released, and the buyer is told why. Either
way the buyer sees one outcome per request. A request not confirmed by its deadline has
failed as of its deadline, whatever Share's state (POL-26).

**Why.** The buyer did nothing wrong; failing their request for an internal fault
shifts Share's reliability problem onto them. The deadline bounds how long capacity
stays in flight.

## POL-04. Buyer interaction: synchronous when ready, otherwise pending

*Answers D-04 (R-06); architecture review RI-3; RFC-000 revision RQ-5, RQ-6; RFC-000 review 2 RQ-7, RQ-8, RQ-10; RFC-000 revision 3 RQ-12.*

**Decision.**
- Every booking request gets an answer, final or `pending`, within `ack_budget`.
- If the outcome is known by then (typical for single links, and expected whenever no
  capacity is in flight), the answer is final.
- Otherwise it is `pending`, and the buyer learns the outcome by polling with the
  idempotency key (POL-29), by webhook if they registered one, or both. Polls are
  limited by `key_poll_limit` (POL-25).
- **One decision per request.** Each request's outcome is decided at one point in time.
  Until then the request is pending; from then on its outcome is fixed. Whether a
  request was still pending when something else happened (its account's suspension,
  its agent key's revocation, its withdrawal, its deadline) is judged against that
  point: an event after the decision does not change the outcome, even while a status
  read still shows the request pending.
- **Status reads.** A status read (a poll, a retry with the idempotency key, or any
  other answer that reports a request's status) may lag the decision by at most
  `status_staleness`. Within that time it may still report `pending`; it never reports
  an outcome other than the one decided, and from `status_staleness` after the decision
  it reports the outcome. There are two exceptions, below. Both apply only to a request
  whose outcome has not yet been reported:
  - **Releases not yet durable.** An outcome other than confirmed is reported only once
    its Share-link releases are durable (next bullet). While the schedule owner (POL-05)
    of a Share link the request holds is failing over, that may take longer than
    `status_staleness`: the outcome is then reported within `release_grace` (POL-26)
    of the decision, and status reads report `pending` until then.
  - **Decision record unavailable, before or at the deadline.** While a request's
    decision record is unavailable (its account's record is failing over), before or at
    the request's deadline, a status read reports `pending`, even beyond
    `status_staleness` after the decision, until the record is available again: at most
    admission's recovery time (1 min, POL-06) after it became unavailable, and, when it
    is unavailable at the deadline, at most `release_grace` after the deadline (POL-26).
    It never reports an outcome other than the one decided.
- **A reported outcome stays reported.** Once a request's outcome has been reported,
  every later status read reports it, whatever the state of its decision record or of
  its links' schedule owners; neither exception above ever turns it back into
  `pending`.
- **Capacity is free once the outcome is reported.** An outcome other than confirmed is
  reported only once the release of the Share-link capacity it frees is durable: within
  `status_staleness` of the decision, or within `release_grace` of it while the schedule
  owner of a Share link the request holds is failing over. That capacity is free for
  other buyers from the moment the outcome is reported, not from the instant of the
  decision.

| Parameter | Default |
|---|---|
| `ack_budget` | 200 ms at p99 |
| `webhook_retry` | Exponential backoff for 24 h, at least once, signed |
| `status_staleness` | 1 s |

**Why.** API clients and agents need a fast, uniform answer; routes across partners
cannot always finish in 200 ms; polling and webhooks are the conventions of every
asynchronous payments and provisioning API. Deciding each outcome at one point gives
every rule that asks "was it still pending?" one answer. Letting a status read lag the
decision by a bounded second, never contradicting it, lets the decision and the status
a buyer reads be kept apart without making any answer wrong. Reporting an outcome only
once its releases are durable means no buyer or competitor sees an outcome while the
capacity it frees is still held; the release follows the decision by milliseconds, so
nothing measurable is lost. While a link's schedule owner is failing over, its release
cannot be durable within `status_staleness`, so reporting waits for it, for at most
`release_grace` (admission's 1 min recovery time, POL-06); nobody can book that link
meanwhile, so nothing is lost commercially, and the alternative, reporting before the
release is durable, would show a buyer free capacity that is still held. A reported
outcome never reverts to `pending`, because a buyer or agent may already have acted on
it (POL-29 retries return the same answer). A decision record that fails over before the
deadline has the same problem as one unavailable at it: a decision in flight at the
failure becomes known only once the record is available again, so no status read can
report it within `status_staleness`; `pending` is the only answer that is never wrong,
and admission's recovery time bounds it.

## POL-05. Authority over a link: one schedule owner

*Answers D-05 (R-07).*

**Decision.**
- Each link's schedule has exactly one owner at a time; every booking on that link,
  single-link or route, goes through it. A single-link booking is a route of one leg.
- A request that fits only if an in-progress request fails keeps waiting, up to its own
  deadline (POL-26), under the priority rule of POL-02. If it is not decided within
  `ack_budget`, the buyer gets `pending` (POL-04).
- A buyer who asks not to wait (`wait = false`) is instead rejected at once with a
  `retry_after` equal to the in-flight request's remaining deadline, and the POL-10
  counter-offer.

**Why.** Two authorities over one schedule cannot both guarantee "never oversell". A
uniform model gives single links and routes the same priority rule (POL-02). Waiting by
default, not rejecting, is what makes "at least one competitor wins" hold: a rejected
buyer may never retry.

**Rejected.** Rejecting contended requests by default (breaks "at least one competitor
wins").

## POL-06. Non-functional targets

*Answers D-06 (R-10); GB-23, GB-39; gate B D6, D7; round 6; final gate B D1, D9; architecture review RI-2, RI-4, RI-5; RFC-000 review RQ-3, D3; RFC-000 review 2 A0R-05.*

**Availability.**

| Capability | Availability per calendar month, per serving region | Per-probe operation and limit |
|---|---|---|
| Admission API | 99.99% | A single-link booking answer (final or `pending`), 200 ms |
| Usage ingestion | 99.99%; ingestion may lag but must not lose an accepted record | A record acknowledged as accepted, 1 s |
| Wallet | 99.9% (about 43 min a month) | A balance and headroom answer, 200 ms (it gates admission) |
| Payouts | 99.9% (about 43 min a month) | A payout-status answer, 1 s; probed through their interfaces |
| Reporting and statements | 99.9% (about 43 min a month) | One day's statement, 2 s |
| Rating and posting | No availability target of its own; judged by charge timeliness | — |

- **Availability** is the share of minutes in a calendar month in which the service
  answers correctly within its latency target, measured by synthetic probes from outside
  the region.
- **An available minute:** each capability is probed at least every 10 s from at least
  two locations outside the region (at least 12 probes a minute). A probe succeeds if it
  gets a correct answer within its operation's per-probe limit. A minute is available if
  at least 90% of its probes succeed. Planned maintenance is not excluded.
- Every target is per **serving region**: each region whose edge answers buyers,
  suppliers, exporters or payment providers. A region that only keeps copies of state
  and answers none of them has no targets of its own. The topology assumed today (two
  serving regions and a third region that only keeps copies) is stated in X2's
  constraints, with its go-live condition: physically diverse fibre paths between the
  regions, verified before production. Node or zone loss is transparent and counts against availability. Region
  loss is a declared disaster, outside the availability measurement. A **declared region
  disaster** lasts from its declaration until the lost region is restored or replaced.
- **Funds holds and headroom checks for bookings are part of admission.** The funds
  hold (or credit hold) and the headroom check that a booking or change needs are part
  of the admission capability, and meet its targets (99.99%, RTO 1 min on node or zone
  loss), whatever the wallet's own targets. The wallet's targets apply to its other
  operations, such as balance answers, top-ups and statements.
- **Probes have no side effects on the business.** Probes act as a designated Share
  probe account, on designated probe links and exporters provisioned in every serving
  region.
  Their bookings, holds and records run end to end through the real path, but they are
  excluded from rating, settlement, supplier reports and quarantine reports.
- **The probe account books on credit.** It is a Share-internal account with a
  `credit_limit` (POL-15) set by an operator in finance (POL-32); being Share's own, it
  counts as having passed know-your-business checks. Its credit holds are real and gate
  its bookings as any account's do, but it is never invoiced, since nothing it does is
  rated.

**Recovery and durability.**

| Capability | RTO on loss of a node or zone | RTO on loss of a region (declared disaster) |
|---|---|---|
| Admission | 1 min | 1 h |
| Usage ingestion | 1 min | 1 h |
| Rating and posting | 5 min | 1 h |
| Wallet | 5 min | 1 h |
| Payouts | 15 min | 1 h |
| Reporting and statements | 30 min | 1 h |

- The payouts and reporting RTOs on node or zone loss lie within their 99.9% monthly
  budget (about 43 min).
- **Durability (RPO): 0** for every acknowledged fact (reservations, the ledger, payment
  events, accepted usage records), on loss of a node, a zone or a region. A fact is
  acknowledged only once it is durable in two regions.

**Load, latency and timeliness.**

| Target | Value |
|---|---|
| Admission throughput (design) | 25,000 requests/s overall (×50 of 500/s); 2,500/s on the hottest link |
| Metered traffic (design) | ×50 of 45 TB/day, about 2.25 PB/day |
| Provisional design load, until exporter data exists | Flow records at an assumed mean of 100 KB of traffic per record: about 260,000 records/s average, 600,000/s peak. Payment notifications: 1,000/s peak. Admission mix: 80% single-link, 20% routes; 70% of requests fit. All four are to be replaced by measurements before production |
| Latency, single-link booking | p99 ≤ 200 ms to an answer, final or `pending` (POL-04); a final answer is expected within it when no capacity is in flight |
| Latency, route booking | p99 ≤ 200 ms to acknowledgement; final outcome within the request deadline (POL-26) |
| Latency, top-up to credited balance | p99 ≤ 10 s from the payment provider's notification |
| Latency, accepted record to headroom | A usage-priced record accepted by usage ingestion counts in its account's unposted usage, and so in its headroom (POL-18), within `attribution_lag_max` (10 s, POL-14) of its acceptance. Met when at least 99.99% of a month's minutes have every record accepted in them counted within that time, minutes affected by a declared region disaster left out; a record counted later is reported as a breach of the usage exposure bound (POL-14) |
| Latency, suspension decision to enforcement | ≤ 60 s: `standing_notice_time` for the marketplace to deliver the standing change, the remaining 50 s for network operations |
| Charge timeliness | A minute's reservation charge is posted within 2 min of the minute's end; usage-priced charges within `max_lateness` + 2 min. Met when at least 99.99% of a month's minutes have their charges posted within target, and every charge is posted within the node-or-zone RTO plus the target (at worst 7 min for a reservation charge after a zone loss). On a declared region disaster, the affected minutes are outside the 99.99% measurement, and each of their charges is posted within its target plus the 1 h regional RTO (at worst 1 h 2 min for a reservation charge); the RPO stays 0, so no charge is lost or posted twice |
| Retention | Ledger, payment events, reservation history and raw usage: 7 years |

- **During a declared region disaster the latency targets are suspended.** From the
  declaration until the lost region is restored or replaced, the latency targets above
  (every "Latency, …" row) are not measured. Everything else still applies: RPO 0, with a
  fact acknowledged only once it is durable in two regions; every request has its
  outcome by its deadline (POL-26); a breach of the usage exposure bound is still
  reported (POL-14). Availability and charge timeliness during the disaster are treated
  as stated above.

| Parameter | Default |
|---|---|
| `standing_notice_time` | 10 s |

**Why.** These adopt the company profile's figures (99.99%, ×50) and the assumed
current load. Probing from outside, without excluding maintenance, is honest to buyers
and easy to audit, and forces maintenance without downtime. A designated probe account
measures the real path without selling capacity, moving money or alarming suppliers, at
the cost of provisioning probe links in every serving region. The wallet answer is held to
the booking budget because a booking depends on it; for the same reason the funds holds
and headroom checks a booking needs are held to admission's availability and recovery,
since a booking cannot be answered without them. Scoping targets to serving regions
measures what buyers, suppliers and exporters reach, not regions that only keep copies.
Suspending the latency targets during a declared region disaster accepts slower answers
while one region is lost: keeping every fact durable in two regions then forces every
write to reach the remaining far region, and keeping RPO 0 matters more than the 200 ms
target. A credit limit lets the probe account exercise the real funds path with no money
movements.
Bounding the time from a record's acceptance to its effect on headroom makes the usage
exposure bound (POL-14) cover the whole interval in which traffic is carried but not yet
counted. Giving ingestion admission's RTO and
judging rating by timeliness removes the conflict between recovery and timeliness
without making rating as costly as admission. Judging timeliness on a region disaster as
availability is judged accepts charges up to about an hour late after a declared
disaster, rather than making rating meet admission's regional RTO. Splitting the enforcement time gives each
side a target it alone controls. Seven years covers the record-retention rules common
across the planned markets; legal must confirm it per market (POL-24).

## POL-07. Loss of supply: never revoke silently

*Answers D-07 (R-11); GA-08, GA-15, GA-33; gate A D-04, D-05, D-10; gate B D10; final gate B D5; RFC-000 review RQ-4.*

**Decision.**

*Who may act.* Only the link's own supplier may book maintenance on it, announce a
permanent reduction or otherwise change the link's capacity. The supplier, or an
operator in network operations (POL-32), may record an unplanned outage and its
restoration.

*Any fall in capacity.* When a link's capacity falls, new sales on it stop at once at
the reduced capacity. A reservation is never revoked silently.

*Unplanned outage.*
- Confirmed reservations are not revoked. Affected reservations are flagged as affected
  and SLA credits apply automatically (Problem 6).
- The reduced capacity applies from the outage's record until its restoration,
  open-ended. New sales on the link are decided against it, so long-dated sales on the
  link pause until restoration.
- Reservations are affected at the minutes where the capacity committed exceeds the
  reduced capacity, and at those minutes every reservation on the link is affected (no
  newest-first). An outage that leaves capacity at or above what is committed affects
  none.
- Holders of reservations active when the outage is recorded, and network operations,
  are told within `affected_notice_time` of the record. The holder of a reservation that
  starts during the outage is told within `affected_notice_time` of its start. Holders
  and network operations are told again on restoration.

*Planned maintenance.*
- Planned maintenance must be booked by the supplier as a reservation against the link,
  at least `maintenance_notice` ahead, so it can only take capacity that is free.
- Maintenance bookings accrue nothing and are excluded from rating and settlement.
- Works that need sold capacity are not bookable as maintenance. The supplier waits for
  capacity to free, or announces a permanent reduction with `revocation_notice`. Works
  carried out anyway are recorded as an unplanned outage on the link, attributed to the
  supplier for SLA purposes (Problem 6).

*Permanent reduction* (supplier exit, contract end).
1. The supplier must keep the capacity for `revocation_notice`; the reduction takes
   effect when the notice ends. New sales stop at once at the reduced capacity.
2. Only reservations that would otherwise not fit are affected: just enough, in Mbps,
   newest first, to fit the reduced capacity. Each added part (POL-08) has its own age.
   The newest part is reduced in rate only as far as needed, and revoked if it reaches
   0. A holder whose reservation is reduced may cancel it without any fee (POL-08).
3. Each affected buyer is offered an **equivalent path**: the same endpoints and rate,
   latency and SLA class no worse. It is offered for the whole reservation at its full
   rate, even when only part of it is affected. Finding equivalent paths belongs to
   routing, which is out of scope here; this policy fixes only the terms of the offer.
   **Which path is offered.** An equivalent path whose every leg is a Share link is
   offered first. A path with a partner leg is offered only when no such all-Share path
   exists.
   **The offer is firm on Share legs.** While it is open (until it is accepted, declined
   or lapses, at most `offer_window`), the capacity of every Share leg of the path is
   held for the reservation: its full rate, from when the offer is made to the
   reservation's end. A partner leg is not held: it is booked only when the offer is
   accepted, and the buyer is told when the offer is made that the partner leg is
   confirmed only at acceptance.
   - If that partner booking fails, the outcome is as for a declined offer (step 7: the
     affected Mbps are removed when `revocation_notice` ends, with no charge for what is
     removed), the capacity held on the path's Share legs is released at once, and the
     buyer is offered any other equivalent path still available, on these same terms.
   - The hold is Share's, made for the offer, not a booking request's: it needs no
     funds hold of its own, since the buyer pays no more than the original price
     (step 4), and it costs the buyer nothing until the move.
   - For new sales on the path's links, the held capacity counts as committed: a request
     that fits only without it is rejected with a counter-offer (POL-10), not left
     waiting for it.
   - On acceptance (and, on a path with a partner leg, once the partner has confirmed
     its booking) it becomes the reservation's capacity on the path. On a decline or a
     lapse it is released at once.
4. The buyer pays the lower of the original price and the new path's price. The new
   path's parties are split on what is charged (POL-12). Only when the new path is
   dearer does Share bear the difference (POL-23): the difference is split by Webster
   among the new path's parties (POL-12), each supplier is paid its share from Share's
   own account, and the commission share is not posted.
5. The buyer may decline. The offer lapses after `offer_window`; no answer counts as
   declined.
6. An accepted offer moves the whole reservation, which takes over the equivalent path
   when the notice ends; the buyer may ask to move earlier, from a minute boundary it
   chooses.
7. On a declined or lapsed offer, only the affected Mbps are removed (reduced or
   revoked), when the notice ends, with no charge for the remaining period of what is
   removed.

| Parameter | Default |
|---|---|
| `maintenance_notice` | 14 calendar days |
| `revocation_notice` | 30 days |
| `offer_window` | 7 days |
| `affected_notice_time` | 60 s |

**Why.** The guarantee is the product; the 2000-era exchanges failed by selling what
could not be delivered. On an outage the network cannot choose whose packets drop, so
every holder at an overcommitted minute is affected alike, and only those minutes count
(no false alarms); on a permanent reduction Share does choose, so newest first, in Mbps,
keeps the most capacity sold and the most of each guarantee, and the buyer can walk
away. Maintenance on free capacity only keeps buyer guarantees and notice terms intact,
and the supplier bears the consequences of its own works. Offering the whole reservation
keeps a route one unit at one rate. A firm offer is one the buyer can act on without
racing other buyers for the path, at the cost of up to `offer_window` of unsold capacity
on the path, a rare event that only a supplier's exit triggers; counting the held
capacity as committed means no buyer waits on it for an answer that may take days.
Offering all-Share paths first, and booking a partner leg only at acceptance, means Share
never pays for up to 7 days of partner capacity on a speculative offer; the cost is that
such an offer is firm on Share legs only, which the buyer is told when it is made.
Charging the lower price means Share never profits
from a supplier's exit, which supports carrier neutrality. Paying the suppliers' shares
of a dearer path's difference, without a commission share, pays them as if the buyer had
paid, with no circular movement to Share itself. The 60 s notice matches the
enforcement target.

**Rejected.** Pro-rata degradation (breaks every buyer's guarantee to spare one);
newest-first on an unplanned outage (the network cannot choose); an equivalent-path offer
subject to availability (the path could be gone when the buyer accepts).

## POL-08. Changing a reservation

*Answers D-08 (R-12); GA-12, GB-10; gate B D8; final gate A D-4; RFC-000 review RQ-2.*

| Change | Rule |
|---|---|
| Cancel | Any time; takes effect at the next minute boundary after it is made; charges stop then. An earlier change to the reservation still pending fails with "reservation ended" |
| Shorten | Any time, as a cancellation of the remaining part |
| Extend, or increase the rate | A new admission of the difference only; the existing part is never at risk. The added part is priced at the price in force when the change is made; the existing part keeps its price (POL-27). An increase applies from the next minute boundary to the end of the reservation; a rate that differs over sub-windows is a separate reservation |
| Decrease the rate | Any time, from the next minute boundary. Removes the most recently added part first (last in, first out) |
| Renew | An extension |
| Part of a route | Not allowed; a route is one unit. Cancel and book again. A change or cancellation of a route applies to every leg; partner legs follow the partner's terms shown at booking |
| Withdraw a pending request | It fails as "withdrawn" and releases what it holds; a partner leg already booked for it, at a partner with or without holds, is cancelled at once at Share's cost (POL-28) |

**Admission of a change.**
- A change is admitted like a new booking: capacity, funds (the hold grows with the
  coverage of the added part), key headroom and limits (POL-25).
- A suspended account may cancel, shorten or decrease, but not extend or increase.
- A change made by a support operator at the account's documented request (POL-32) is
  the account's own change under this policy: the account's fee rules apply (it pays a
  shown partner fee), and it is recorded as an operator action. It is never a
  termination (POL-30).
- Changes to one reservation are applied one at a time, in arrival order; each is
  checked against the reservation as left by the previous one. Arrival order applies
  only among changes that do not end the reservation; a cancellation is never queued
  behind them.

**Partner fees.**
- A partner leg may impose a minimum term or a cancellation fee. It is shown in the
  price at booking and charged on cancellation; a minimum term is charged on early
  cancellation as a cancellation fee. Share absorbs partner fees it did not show.
- The funds hold at admission is the larger of the coverage and that fee, while the fee
  could still be charged (POL-15).
- Who pays the fee:
  - the buyer, on its own cancellation, when reservations are released after suspension
    (POL-16), and on a termination by Share (POL-30);
  - Share, when a reservation is revoked (POL-07), when the holder of a reservation whose
    rate was cut under POL-07 cancels (that exit stays free to the buyer), and when a
    partner booking is left without Share's confirmation, because the request is
    withdrawn or fails after a partner leg was booked, at a partner with or without
    holds (POL-28).
- A cancellation fee goes wholly to the partner that imposed it: not split, no
  commission. It is posted as a fee charge line (POL-11).

- A shorten whose new end is at or before the next minute boundary (including an end
  already past) is a cancellation, effective at the next minute boundary. Any other
  shorten does not end the reservation and is ordered with other changes by arrival.

**Why.** No term is the product's main promise. Admitting only the difference keeps
modifications as safe as new bookings. The buyer's right to stop paying at the next
minute is absolute; a pending change loses nothing it had. A fee follows the conduct
that caused it: the buyer's own cancellation, non-payment or misconduct, or Share's
decision to revoke or cut. The fee compensates the partner's commitment, so Share does
not profit from a cancellation.

## POL-09. Selling horizon

*Answers D-09 (R-13).*

**Decision.** Share sells up to `selling_horizon` ahead, rolling. An open-ended
reservation is guaranteed continuously: as the horizon rolls forward, its capacity is
carried forward before any new sale can take it. It ends only when cancelled (POL-08)
or revoked (POL-07).

| Parameter | Default |
|---|---|
| `selling_horizon` | 12 months |

**Why.** An open-ended booking is a subscription; buyers expect it not to lapse.

## POL-10. Rejections are counter-offers

*Answers D-10 (R-14); gate A D-03; gate B D2.*

**Decision.** A rejection states, as far as can be computed within the budget:
- the largest rate that fits the requested window;
- the earliest window of the requested length that fits the requested rate, starting at
  or after the requested start, within the selling horizon (an earlier free slot is not
  offered);
- for a route, the link that blocked it;
- `retry_after`, when capacity is held by an in-flight request (POL-05), or the request
  ahead of a waiter whose deadline passed (POL-02);
- for insufficient funds, two amounts to top up: the minimum for the booking to be
  confirmed (hold − headroom), and that minimum plus `low_balance_warning`, the amount
  that also avoids an immediate low-balance state (POL-16).

A `wait = false` rejection carries the counter-offer, computed beside the capacity in
flight (POL-02). A rejection never discloses other buyers' identity, individual
reservations or usage.

**Why.** Agents act on machine-readable alternatives; a rejection that proposes what
does fit turns into a sale. Searching from the requested start matches what the buyer
asked for and makes answers deterministic. The two amounts give an agent the exact
minimum it can act on, plus the amount that does not lead to suspension a minute later.

**Rejected.** Searching for the earliest window from now.

## POL-11. Money unit and rounding

*Answers D-11 (R-17); gate B D14.*

**Decision.**
- Amounts are integers in **micros** (10⁻⁶) of the currency's major unit, always tagged
  with the currency (POL-20).
- **A charge line is the unit rounded once.** There are three kinds:
  - a reservation line: one reservation for one minute;
  - a usage line: one account and product on one route for one minute (usage-priced
    traffic);
  - a fee line: one fee (a cancellation fee or partner minimum term, POL-08) for one
    reservation.
- A reservation or usage line is computed exactly and rounded once, **down** to the
  micro (in the buyer's favour).
- A fee line's amount is the exact shown amount in micros (no rounding). It is not split
  (POL-08) and is posted once, by its source reference (POL-29).
- An amendment to a charge line is the line's exact new total rounded down once, less
  what was already charged for that line; amendments are split the same way (POL-12).
- At top-up, the provider's amount converts exactly (in USD; a conversion from another
  currency follows POL-20).
- At payout, amounts are rounded down to the provider's minor unit and the residue stays
  in the payee's account for the next payout; Share never keeps residues.

**Why.** At micro precision, rounding in the buyer's favour costs nothing material and
is a trust signal; carrying residues makes cumulative payouts exact. Treating a fee as a
charge line reuses the charge-line machinery while keeping it wholly the partner's.

## POL-12. Splitting revenue among parties

*Answers D-12 (R-18); GB-04; gate B D12.*

**Decision.**
- Each charge is split among the parties on the route (suppliers and Share's commission)
  by an apportionment rule that must be:
  - **exact:** shares sum to the charge;
  - **monotone:** when a minute's total grows (late usage, POL-14), no party's share
    falls;
  - **unbiased:** it does not systematically favour large or small parties.
- The rule is **Webster (Sainte-Laguë)**. The split is per route: a usage charge line is
  always for one route (POL-11).
- Ties are broken in a fixed published order: **Share's commission loses** to every
  supplier; among suppliers, in route leg order, first leg first.
- A supplier with several legs on one route is one party, with its legs' weights summed;
  its tie position is that of its first leg.
- Amendments: after a correction borne by Share or by a supplier at fault (POL-23), each
  later amendment to that line is split on its own; every other amendment is split as
  the split of the new total less the shares already posted.
- A cancellation fee is not split (POL-08).
- The rule and tie order are published to suppliers. Cumulative deviation from exact
  proportions is reported per party per payout period (a duplicate-payout debt does not
  count in it, POL-22).

**Why.** Suppliers must trust a neutral settler. A divisor rule that favours large
parties systematically favours the largest share, often Share's own commission. Webster
is monotone and unbiased. Splitting an amendment on its own after a correction keeps
every share of a late-traffic increase non-negative, for a small reported deviation.
Treating a supplier as one party is deterministic, and it cannot game the split by
listing a link as two legs.

**Rejected.** Divisor rules that favour large parties; quota-capped methods (at micro
precision the per-minute deviation is immaterial, so they add complexity without
benefit).

## POL-13. Flows that span several minutes

*Answers D-13 (R-19).*

**Decision.** Exporters must cut flows at minute boundaries (active timeout ≤
`flow_active_timeout`), so a record's bytes belong to one minute. A record that still
spans several minutes is spread across the minutes it was active in proportion to the
seconds it was active in each, each part at its own minute's price.

| Parameter | Default |
|---|---|
| `flow_active_timeout` | 60 s |

**Why.** Consistent with assuming a reliable, well-configured source. Spreading is the
only fallback that is fair across price changes and reservation boundaries. Under
POL-01 this affects only usage-priced traffic.

## POL-14. Late usage

*Answers D-14 (R-20); GB-05; architecture review RI-2.*

**Decision.**
- A usage record is billed whenever it arrives; late records are never dropped (they
  are owed to a supplier).
- `max_lateness` is the lateness the exposure bound assumes; records later than it are
  billed and also reported as bound breaches.
- Price rises cannot occur within the window, because a booked reservation keeps its
  price (POL-27) and best-effort prices change only with notice.
- `usage_rate_cap` is a per-account, per-product rate, policed at the edge, that bounds
  all of an account's usage-priced traffic on a product (burst plus traffic with no
  reserved rate). There is one lateness bound per account and product.
- `attribution_lag_max` is the time from a record's acceptance by usage ingestion to its
  effect on headroom, as unposted usage (POL-18). It is a timeliness target of POL-06;
  a record whose effect comes later is reported as a breach of the bound, like a record
  later than `max_lateness`.
- The lateness part of usage exposure (POL-18) = `usage_rate_cap` × (`max_lateness` +
  `attribution_lag_max` + the 60 s suspension-to-enforcement target of POL-06) × the
  product's highest `usage_price` on any route. It covers usage-priced traffic carried
  but not yet counted in headroom: traffic whose record has not yet arrived, traffic in
  records accepted but not yet counted, and traffic carried between the suspension
  decision and its enforcement.
- Under a credit limit, the limit includes the unmetered window: suspend early rather
  than lose beyond the limit.

| Parameter | Default |
|---|---|
| `max_lateness` | 180 s |
| `usage_rate_cap` | Set at onboarding per account and product; 100 Mbps by default |
| `attribution_lag_max` | 10 s |

At the defaults the bound covers 180 s + 10 s + 60 s = 250 s at `usage_rate_cap`: at
100 Mbps, 3.125 GB.

**Why.** Late traffic is still owed to a supplier. One number bounds Share's risk per
account; more burst means a higher cap agreed at onboarding. Using the highest price is
conservative, by at most the price spread between routes. A record reaches headroom only
after it is attributed and priced; adding that propagation time to the bound keeps
headroom from being overstated while it is under way.

## POL-15. Funds at admission

*Answers D-15 (R-21); GB-06; gate B D9.*

**Decision.**
- "No upfront payment" means no setup fees, no term commitment and no pre-purchase of
  the whole term.
- Admission requires funds for a rolling `coverage_window` of the reservation's charges
  (or the whole reservation, if shorter). These funds are **held** in the wallet, not
  charged. Charges then accrue per minute against the held funds, and the hold rolls
  forward.
- A request takes no capacity hold until its funds hold (or credit hold) is taken
  (POL-25).
- **Future reservations:** the hold for the first coverage window is taken at admission
  and kept until the reservation starts, then rolls forward as usual.
- **Partner fees:** while a partner's cancellation fee or minimum term (POL-08) could
  still be charged, the hold is max(coverage, fee); after the minimum term it is the
  coverage. At release, the fee is charged against what is left of the hold, and any
  shortfall becomes a negative balance under POL-21 and POL-23.
- Refusing a booking for insufficient funds is acceptable; the rejection states the
  amount to top up (POL-10).
- **Credit-limit accounts.** Accounts that have passed know-your-business checks may
  instead have a credit limit, set by an operator in finance (POL-32), settled by monthly
  invoice.
  - Admission takes a **credit hold** for the coverage window, counted as funds held in
    the headroom formula (POL-18).
  - Invoices are due in `invoice_terms`; unpaid after that, the account is suspended
    under POL-16, and resumes only when every overdue invoice is paid and the POL-16
    headroom rule holds.
  - An unpaid invoice is written off 90 days after its due date, at Share's cost, with
    the consequences of POL-21: it stays recorded as owed, the account stays suspended
    until it is repaid, and the account loses its credit limit and books prepaid until
    re-vetted.

| Parameter | Default |
|---|---|
| `coverage_window` | 24 h |
| `credit_limit` | Per vetted account; none by default |
| `invoice_terms` | 30 days |

**Why.** Prepaid is the regional norm. Holding a short window, not the term, keeps the
no-upfront promise while bounding Share's risk to one window. Holding the larger of
coverage and fee only while the fee applies means buyers are never held twice for
partner routes, and Share's loss is bounded by min(fee, coverage) per reservation.

## POL-16. Suspension and resumption

*Answers D-16 (R-22); GB-21, GB-37; gate B D3; final gate B D8.*

**Decision.**
- **Suspension.** An account is suspended when its headroom (POL-18) would fall below
  zero: the coverage hold cannot roll forward (including when a price change needs a
  larger hold, POL-27), or usage exposure exceeds what is left. A credit-limit account is
  also suspended when an invoice is unpaid after `invoice_terms` (POL-15), and any
  account when a reversal makes its headroom negative (POL-21).
- **Warning.** A warning is sent once per crossing below `low_balance_warning`. It
  quotes the top-up that brings headroom to `low_balance_warning` plus one coverage
  window's charges.
- **While suspended:** no new bookings, extensions or increases (cancel, shorten and
  decrease remain allowed, POL-08); existing reservations keep their capacity for
  `suspension_grace` and keep accruing charges against the hold already taken;
  usage-priced traffic is blocked at the edge. Enforcement follows the 60 s target of
  POL-06.
- When a reversal leaves the balance below the funds held, reservations are still kept
  for the full `suspension_grace`; Share bears up to one coverage window (POL-23).
- When a price change needs a larger hold than the account can cover (POL-27), the hold
  grows at suspension by whatever headroom remains, and the reservations keep their
  capacity for the full `suspension_grace`. Any accrual beyond the hold becomes a
  negative balance under POL-21 and POL-23; Share's loss is bounded by the hold growth
  the headroom did not cover.
- **Resumption.** A suspended account resumes automatically, within the grace period,
  when, with every reservation's full coverage hold restored, its headroom is at least
  `low_balance_warning`. The suspension notice, and any rejection while suspended,
  quotes the **resume amount** that achieves that.
  - An account suspended for an overdue invoice resumes only when every overdue invoice
    is paid **and** the headroom rule holds. Headroom alone never resumes it.
  - After a write-off, the account stays suspended until a top-up repays the written-off
    amount (POL-21).
- **After the grace period** the reservations are released and the buyer is told. This
  is intended: a termination caused by non-payment, announced at suspension, and
  distinct from the supply-side withdrawals of POL-07. The buyer pays any shown partner
  fee (POL-08).

| Parameter | Default |
|---|---|
| `suspension_grace` | Equal to `coverage_window` (24 h), so the grace is funded by the hold already taken, except for a price-change shortfall (POL-27) or a reversal (POL-21) |
| `low_balance_warning` | max(a quarter of one coverage window's charges (6 h at the default), 1 USD), so an account without reservations is still warned |

**Why.** A grace period funded by the existing hold costs Share nothing, apart from the
small, bounded shortfalls after a reversal or a price change, which keep the grace
uniform for every buyer. Automatic
resumption suits self-serve and agent buyers. Resuming at `low_balance_warning` rather
than zero costs at least 1 USD more, but the account is not suspended again at the next
minute. One warning per crossing, quoting about one more window of runway, avoids
repeated alerts. Requiring overdue invoices to be paid enforces credit terms: an
enterprise that pays late loses its reservations after the grace.

**Rejected.** Resuming at zero headroom (re-suspends at the next minute).

## POL-17. Traffic that does not match a reservation

*Answers D-17 (R-24); gate B D11.*

**Decision.** Every usage record is kept. Every guaranteed product carries a
`usage_price`, used for attributable traffic outside a reservation and for what Share
pays a supplier for carried excess, even when the product does not permit burst.
- **Above the reserved rate.** Traffic above the reserved rate is measured per minute:
  bytes in the minute beyond reserved rate × 60 s. It is policed at the edge.
  - Where the product permits burst, it is carried best effort on capacity that is
    otherwise idle, and billed at `usage_price`, within `usage_rate_cap` (POL-14).
  - Where it does not, the excess is dropped and not billed.
  - If policing fails and excess is carried anyway, it is not billed to the buyer (the
    failure is Share's). Share pays the suppliers for it from Share's own account: the
    charge the traffic would have made at `usage_price` is split by Webster among the
    route's parties, each supplier is paid its share, and the commission share is not
    posted (POL-23). The failure is raised as an incident.
- **Outside an active reservation.** Traffic attributable to the account but outside an
  active reservation is billed at `usage_price` and counts toward exposure.
- **Unattributable.** Traffic that cannot be attributed is quarantined, not billed, and
  reported to operations and the supplier. If an operator in finance (POL-32) attributes
  it within `dispute_window`, it is billed to the buyer at the price of the traffic's
  minute, and the supplier is paid. After the window, neither.
- **One count per route.** When legs report different byte counts for the same traffic,
  the egress (delivered) count is billed to the buyer, and suppliers are paid their split
  of that charge.

| Parameter | Default |
|---|---|
| `dispute_window` | 30 days |

**Why.** Without oversubscription, burst may only use capacity no one reserved. A
policing failure is Share's, so suppliers are paid as if the buyer had paid, without
circular movements.

## POL-18. The balance a buyer sees

*Answers D-18 (R-27); GB-05; architecture review RI-2.*

**Decision.**
- The headline figure is **available headroom**: balance minus held funds minus usage
  exposure (plus any credit limit). The same headroom governs admission (POL-15) and
  suspension (POL-16) for every account, prepaid or credit-limit. An agent key is shown
  its key headroom instead (POL-25).
- **Usage exposure** has two parts: unposted usage, and the lateness bound (POL-14).
- **Unposted usage** = usage-priced traffic in records accepted by usage ingestion but
  not yet posted, at each minute's price. A record counts in it within
  `attribution_lag_max` of its acceptance (POL-14, POL-06), and until its charge is
  posted.
- The response itemises the ledger balance, held funds, charges accrued but not yet
  posted, and the two parts of usage exposure. Charges accrued but not yet posted stay
  within funds held until posted; they are itemised for information, not deducted twice.

**Why.** Agents decide on headroom; finance reconciles on the itemised figures.
Unposted usage computed from records accepted is exact and reproducible; the part not
yet counted (records not yet arrived, or accepted but not yet counted) is bounded by
POL-14.

## POL-19. History

*Answers D-19 (R-29).*

**Decision.** Every change to a reservation is recorded with who made it and when, and
the system can answer "what was known to be reserved on this link at time T" for any
past T. Kept for 7 years (POL-06).

**Why.** SLA claims, billing disputes and supplier settlement all need it; auditability
is part of a neutral settler's credibility.

## POL-20. Currency

*Answers D-20 (R-31); final gate B D7.*

**Decision.**
- Prices, wallets and the ledger are in **USD**. Every amount is still tagged with its
  currency, so more can be added.
- A top-up in another currency (for example KES by M-Pesa) is converted at top-up, at
  the payment partner's rate, which is shown before the buyer confirms. It converts at
  the shown rate, rounded up to the micro (in the buyer's favour).
- A shown rate is valid for `fx_quote_validity`. A payment arriving later is credited at
  the partner's rate at notification, and that rate is shown on the statement.
- Suppliers are paid in USD, or converted at payout at the shown rate, rounded down to
  the provider's minor unit; the residue, converted back at the same rate, is carried in
  USD.
- Share carries no FX risk between charge and payout.
- Funds at the payment partner are taken in USD as the partner reports them. For each
  converted top-up or payout, the difference between the micros credited or debited and
  the partner's reported USD amount is posted to Share's own account as an **FX
  difference**, positive or negative (POL-24).

| Parameter | Default |
|---|---|
| `fx_quote_validity` | 15 min |

**Why.** Wholesale capacity in the region is priced in USD. A single settlement
currency keeps the ledger simple. Posting each FX difference to Share's own account
keeps the reconciliation exact to the micro; Share absorbs sub-cent differences both
ways, while the buyer still gets the shown rate rounded up and the supplier the shown
rate rounded down.

## POL-21. Reversals, refunds and credits

*Answers D-21 (R-32); gate B D4.*

| Item | Decision | Scope |
|---|---|---|
| Reversal (chargeback) after the top-up was spent | Applied at once; the account is suspended if headroom goes negative (POL-16); collected from the next top-up; written off if not recovered within 90 days of the reversal | Now |
| Reversal arriving before its completion | Held pending, matched by provider reference, for up to 72 h. If its completion has not arrived by then, it is not applied to the wallet (nothing was credited); it is escalated to operations for reconciliation with the payment partner, and resolved by an operator in finance (POL-32) | Now |
| Write-off (of a reversal, or of an invoice under POL-15) | Automatic, at Share's cost: the loss is booked to Share, but the written-off amount stays recorded as owed. The account stays suspended (no bookings) until a top-up repays it; that repayment goes to Share's own account, and the account then resumes by the usual rule (POL-16). After an invoice write-off the account also loses its credit limit and books prepaid until an operator in finance re-vets it and sets one again | Now |
| Withdrawal of unused balance | On request, to the original payment method, net of provider fees | Later; requirement recorded |
| SLA credits | Service credit in the wallet, not withdrawable | Later (Problem 6) |

**Why.** Applying a reversal that has no completion would debit money never credited.
Keeping the written-off amount owed protects Share against chargeback and non-payment
abuse; a returning buyer must settle first, which is fair because the debt was its own.

**Rejected.** Applying an orphan reversal to the wallet.

## POL-22. Payouts

*Answers D-22 (R-33); GB-15; gate B D5; final gate B D4.*

| Parameter | Default |
|---|---|
| `payout_frequency` | Weekly |
| `payout_minimum` | 50 USD; smaller balances carry forward |
| `payout_confirmation_timeout` | 7 days |

**Decision.**
- A payout is complete when the bank or mobile-money transfer is confirmed, not when
  instructed. Payouts are rounded down to the provider's minor unit (POL-11) and
  converted as POL-20.
- An amount in an instructed payout is in no other payout until it is confirmed or
  finally failed. After a final failure, it goes into the next run under a new reference.
  A payout already instructed is never instructed again for the same amounts (POL-29).
- **What "never paid twice" promises.** The marketplace never instructs the same amount
  twice: no repeated run, instruction or confirmation pays it again. A provider can
  still execute a transfer twice (for example one it had reported as finally failed);
  that is recovered as a "duplicate payout" debt, below, and the supplier's earnings are
  untouched.
- A confirmation after a reported failure is escalated, and the amount is not re-paid
  while that is open. No answer within `payout_confirmation_timeout` is escalated, never
  re-instructed. Escalations are resolved by an operator in finance (POL-32).
- **Supplier debt** is netted against later payouts, and invoiced if open more than
  90 days. It arises from supplier-caused errors (POL-23) and from duplicate payouts.
- **A duplicate payout** is recovered as a supplier debt marked "duplicate payout", by
  the same path: netted against the next payouts and invoiced if open more than 90 days.
  It is shown on the statement as "duplicate payout", never as an earnings reduction,
  and it does not count in the deviation report (POL-12).

**Why.** Weekly payouts are much faster than carrier wholesale terms (often 30–90 days)
and are a reason for suppliers to list. A supplier may wait an extra week after a
failure, but is never instructed a payment twice and never loses earnings. No system
can prevent a provider's false final-failure report, so that case is promised as a
recovery, not as an impossibility; Share carries the recovery risk until the debt is
netted or invoiced. The duplicate-payout path
reuses the debt path, and keeps the supplier's earnings history clean, because the error
was a transfer, not its own.

## POL-23. Bad debt

*Answers D-23 (R-34); GB-12; gate B D11; final gate B D5.*

**Decision.**
- Share bears buyer credit risk. A supplier's earnings are final once a charge is
  posted.
- Corrections that reduce a charge because of a Share error are borne by Share in full,
  from Share's own account, even where they exceed the commission earned on that charge.
  Supplier earnings are never reduced for a Share error.
- **Price corrections** are made by an operator in finance (POL-32), in both directions,
  within `dispute_window` (POL-17), with the cause (Share, a supplier, "other") and the
  reason recorded. A price locked at booking (POL-27) can only be corrected downwards.
- When a correction is caused by one supplier's error, each share is recomputed by
  splitting the corrected total: the supplier at fault owes its own reduction (as
  supplier debt, POL-22); Share bears every other party's reduction, so no other
  supplier's earnings fall.
- A downward correction with cause "other" is borne by Share.
- Every cost Share bears is paid from Share's own account to the supplier concerned, as
  its own ledger movement: a partner cancellation (POL-28), an equivalent-path price
  difference (POL-07), an unshown partner fee or one Share pays under POL-08, carried
  excess (POL-17).
- A Share-borne usage-priced payment (carried excess) is split as the Webster split,
  among the route's parties, of the charge the traffic would have made. An
  equivalent-path price difference (POL-07) is split the same way, as the Webster split
  of the difference among the new path's parties. In both, each supplier is paid its
  share from Share's own account, and the commission share is not posted.

**Why.** Central billing is the supplier proposition: the supplier sells capacity, Share
collects. Under POL-15, the risk is bounded by one coverage window per buyer. Cause
"other" costs Share at most what
`dispute_window` allows. Suppliers are paid as if the buyer had paid, with no circular
movements.

## POL-24. Regulation

*Answers D-24 (R-37); GB-19; gate B D1; final gate B D2, D3, D6, D7; RFC-000 review 2 RQ-11.*

**Decision.**
- Share holds buyer funds through a licensed payment partner (safeguarded or trust
  accounts), not on its own balance sheet.
- Know-your-business checks for credit-limit accounts; buyer know-your-customer tiers
  follow the partner's. KYC tiers are not relied on as a control on hold-squatting
  (POL-25).
- **Daily reconciliation** proves:
  1. Funds at the partner = Σ buyer balances, **signed** (a negative balance is a
     receivable Share has funded) + Σ supplier balances, signed (net of supplier debts)
     + Share's own balance at the partner (commission and Share's own deposits, less
     costs, write-offs, withdrawals and FX differences, POL-20) − payouts the partner
     has executed and the ledger has not yet confirmed (each matched to its partner
     debit) + payments the partner has received and reported and the ledger has not yet
     posted (top-ups and invoice payments, each matched to its partner credit). Funds at
     the partner are taken in USD as the partner reports them (POL-20).
  2. Every provider transaction in the partner's report matches exactly one ledger
     movement of one of these kinds, and the reverse: a top-up, an invoice payment, a
     reversal, a payout, a supplier-debt payment, or a movement of Share's own funds (a
     deposit or a withdrawal). Each is recorded in the ledger with its source reference
     (POL-29). A payment counted in (1) as received and not yet posted is matched to its
     partner credit there, and to its ledger movement once posted.
- Provider settlement reports and bank statements are reconciled daily under the same
  rule. Any difference is an operational alert.
- Day D is reconciled by 12:00 UTC on D + 1; a reconciliation not completed by then is
  an operational alert.
- **Safeguarding rule.** Share's own balance must never be below zero, and must always
  cover the receivables it funds (negative buyer balances and supplier debts), so the
  funds at the partner always cover every positive buyer and supplier balance, less
  payouts the partner has executed and the ledger has not yet confirmed, plus payments
  the partner has received and the ledger has not yet posted.
  - It is an obligation on Share's treasury, checked by the daily reconciliation, where
    a breach is an operational alert. No movement owed to a buyer or supplier is ever
    refused or delayed because of it, and the system never cures it: only Share adding
    funds does.
  - Treasury records each deposit or withdrawal of Share's own funds in the ledger
    before the reconciliation of its day.

**Requires legal confirmation per market** (in Kenya, the National Payment System Act
regime), including the 7-year retention of POL-06.

**Why.** Every micro at the partner is accounted for, and safeguarded money never funds
another buyer's debt. The cost is that Share must pre-fund its own losses: chargebacks
and up to two months of credit-account charges. Matching Share's own deposits and
withdrawals, invoice payments and supplier-debt payments makes them auditable movements
rather than unexplained differences. An in-flight payout is money that has already left,
not a shortfall; symmetrically, a payment the partner has received and the ledger has not
yet posted (a top-up near the cut is posted up to 10 s later, POL-06) is money that has
arrived, not a surplus, so neither makes a daily cut show a difference. Making the rule a treasury obligation, not a gate, keeps supplier
earnings final and never blocks a buyer on Share's treasury; a breach is visible within a
day.

**Rejected.** An invariant over positive buyer balances only, without Share's own
balance (it cannot hold once commission, FX differences and negative balances exist);
a gate that refuses movements while Share's own balance is short (it would make supplier
earnings non-final).

## POL-25. Controls for AI agents

*Answers D-25 (R-39); GA-21, GB-22; gate A D-07; gate B D13; round 6.*

**Decision.** In scope now, owned by P2 (booking) and P4 (money).
- **Keys.** API keys per agent, scoped to an account. Only an account administrator
  issues, changes and revokes keys and sets or raises their limits. An agent key cannot
  change its own limits, create keys, raise any limit, or give consent to be shown to a
  supplier (POL-33).
- **Revocation** takes effect within 60 s for new requests. The key's pending requests
  (those not yet decided, POL-04) fail with the reason "key revoked" and release what
  they hold; confirmed reservations are unaffected.
- **Spending limit.** A spending limit per key per period, enforced at admission as part
  of headroom: key headroom = min(account headroom, `key_spend_limit` − key spending in
  the period), shown to that key as its headroom.
- **Key spending** is cumulative over the period: the charges accrued in the period by
  the key's reservations (covered by a hold or not, including reservations that have
  since ended), plus the funds currently held for their future charges, each minute
  counted once.
- **Negative key headroom** blocks new bookings and additions (extensions, increases) by
  that key only. It never ends, suspends or reduces reservations, and the account's other
  keys are unaffected.
- **Capacity in flight** (Mbps in requests not yet decided) is limited per key and per
  account, counted per request at its reserved rate.
- **No squatting.** A request takes no capacity hold until its funds hold or credit hold
  is taken; both are released at its outcome if it is not confirmed. KYC tiers are not
  relied on.
- **Rate limits** per key and per account; polls are limited separately and do not count
  toward booking limits; retries do.
- Concurrent bookings by one account or key are checked against headroom and limits as
  if applied one at a time: their combined effect never exceeds either.

| Parameter | Default |
|---|---|
| `key_spend_limit` | Set per key by an account administrator; none by default |
| `key_spend_period` | One calendar day, UTC |
| `key_inflight_limit` | Set per key; none by default |
| `account_inflight_limit` | max(`account_inflight_floor`, 10 × the account's largest confirmed reservation), in Mbps |
| `account_inflight_floor` | 1,000 Mbps |
| `key_rate_limit` | 50 requests/s per key |
| `account_rate_limit` | 200 booking requests/s, across every key and user |
| `account_max_keys` | 100 |
| `key_poll_limit` | 20 status polls/s per key |

**Why.** "AI agents" are named buyers; a hard limit is the only control that works
without a human in the loop. A cumulative limit bounds a day's spending, as an agent
operator expects; counting only uncovered charges would let short bookings made one
after another escape it. Blocking only new commitments keeps the limit a hard gate
without revoking guarantees the operator already approved. Taking funds before capacity
makes squatting cost real prepaid money in every account, whatever the number of
accounts, at the cost of briefly tying up a buyer's funds while a request is blocked on
capacity.

**Rejected.** Key spending as held funds plus only the charges the holds did not cover
(short sequential bookings escape it); relying on KYC tiers against squatting.

## POL-26. Route deadline

*Answers D-26 (R-42); GA-36; gate A D-11; final gate A D-1; architecture review RI-1; RFC-000 review RQ-1, RQ-2; RFC-000 revision RQ-5; RFC-000 review 2 RQ-7, RQ-8.*

**Decision.**
- A route request carries a deadline chosen by the buyer, from `route_deadline_min` to
  `route_deadline_max`, `route_deadline_default` if none is given. A request with a
  partner leg needs a deadline of at least `route_deadline_min` + `commit_margin`
  (11 s). A shorter, zero or negative deadline is invalid.
- Every outcome exists by the request's deadline. Each request keeps its completion
  margin (POL-02) inside its deadline for committing:
  - a request with a partner leg does not begin committing later than deadline −
    `commit_margin`;
  - a request without one does not begin committing later than deadline −
    `ack_budget` (POL-04).

  `commit_margin` applies only to requests with a partner leg.
- A request not confirmed by its deadline has failed as of its deadline, whatever
  Share's state, and later status reports that.
- **When a confirmation can be decided.** A request is confirmed only by a decision
  whose entry in its decision record is timestamped before its deadline. No
  confirmation is ever decided at or after the deadline. A confirmation decided in time
  may become known (reported) after the deadline only if the decision record was
  unavailable at the deadline, and at most `release_grace` after it; until then status
  reads report `pending` (POL-04).
- **Holds end at the deadline.** For a request not confirmed by its deadline:
  - On a Share link, the capacity held for it is released at the deadline. If Share's
    record of the request's decision (POL-04) is unavailable at the deadline, or the
    link's schedule owner (POL-05) is failing over then, the capacity is released
    within `release_grace` after the deadline instead, and the failed outcome is
    reported once that release is durable (POL-04). The request has still failed as of
    its deadline, unless a confirmation was decided in time (as above), in which case
    the capacity is the reservation's. When the decision record is unavailable at the
    deadline, the case is an operational alert.
  - At a partner, its hold lapses at the deadline by itself (below).
  - A partner booking for it (a leg the partner has confirmed, at a partner with or
    without holds) is cancelled at once, at Share's cost (POL-28).
- A request still pending at its deadline is an operational alert: by design it cannot
  happen.
- The completion margin is also what scopes the contention guarantee for a waiter
  (POL-02): `commit_margin` with a partner leg, `ack_budget` otherwise.

| Parameter | Default |
|---|---|
| `route_deadline_default` | 30 s |
| `route_deadline_min` | 1 s |
| `route_deadline_max` | 60 s |
| `commit_margin` | 10 s |
| `release_grace` | 1 min |

- A partner counts as offering holds only if both are true:
  - its holds can last at least `route_deadline_max` + `commit_margin`; and
  - it accepts an absolute expiry time for a hold, set by Share when the hold is taken.

  Otherwise it is a partner without holds (POL-28).
- Share sets every partner hold to expire at the request's deadline. So capacity held
  at a partner lapses at the deadline by itself, even if Share is unavailable then.
  Share also releases, at the request's deadline, every hold the request still has,
  partner holds included (a Share-link hold within `release_grace` if the decision
  record is unavailable then, or the link's schedule owner is failing over then, as
  above).

**Why.** Fast single-link agents keep short deadlines; nobody can choose a deadline that
could never be met. Failing as of the deadline means capacity is never stranded by an
outage of Share's own booking process; the price is that holds must expire on their own.
A partner hold expires on its own at the deadline only if Share can set its expiry; a
partner that cannot is booked as final-only (POL-28), at Share's risk, rather than let
its hold outlive the deadline whenever Share is down. A Share-link hold can be released
safely only once the request is known not to be confirmed; while Share's record of the
decision is unavailable that cannot be known, so the hold is kept, for at most
`release_grace` (admission's 1 min recovery time on node or zone loss, POL-06), rather
than risk a release followed by a confirmation, which would oversell the link. The
request is never decided confirmed after its deadline. No design can bound when an entry
proposed before the deadline becomes durable, so a confirmation decided in time may
become known only after the deadline, while the decision record is unavailable; it is
kept rather than voided, because voiding it could contradict a confirmation already
reported (POL-04), and status reads say `pending`, never a wrong outcome, meanwhile.
The completion margin bounds when committing may begin, not when the confirmation is
decided: a partner route that begins committing by deadline − `commit_margin` has that
margin for the partner's confirmation, and is confirmed by any decision timestamped
before the deadline. Fencing the confirmation at deadline − `commit_margin` as well would
leave the margin no purpose. A Share-link release can be durable only once its link's
schedule owner can record it, so while that owner is failing over the release, like the
report of the failed outcome (POL-04), waits for it, for at most `release_grace`.
A partner booking confirmed for a
request that is then not confirmed is the same residue POL-28 accepts for partners
without holds, and is handled the same way.

**Rejected.** A confirmation fence at the deadline less the completion margin (a
partner route could begin committing at deadline − `commit_margin` but never be
confirmed after it); a margin after the deadline (deadline plus `commit_margin`), which left
outcomes undecided at the deadline; releasing a Share-link hold at the deadline whatever
the state of the decision record (a confirmation could follow the release).

## POL-27. Price changes

*Answers D-27 (R-44); gate B D16; final gate B D8.*

**Decision.**
- Prices change only on minute boundaries.
- A booked reservation keeps the price it was booked at for its life; an added part is
  priced at the price in force when it is added (POL-08). A locked price can only be
  corrected downwards (POL-23).
- An open-ended reservation's price may change with `price_notice`. Best-effort usage
  prices change with the same notice.
- If a price change grows a reservation's hold beyond what the account can cover, the
  price still takes effect, and the account is suspended as for a failed roll-forward
  (POL-16), after the usual low-balance warning. At suspension the hold grows by
  whatever headroom remains; the reservation keeps its capacity for the full
  `suspension_grace`, and any accrual beyond the hold becomes a negative balance under
  POL-21 and POL-23 (POL-16).

| Parameter | Default |
|---|---|
| `price_notice` | 30 days |

**Why.** A price locked at booking is part of the guarantee, and it removes the
mid-minute and mid-window pricing questions. A buyer facing a price change had
`price_notice` and a warning, so the lock rules need no exception.

## POL-28. Partners without holds

*Answers D-28 (R-46); gate A D-06; architecture review RI-1; RFC-000 review RQ-2.*

**Decision.**
- A partner leg that can only be booked immediately and finally, or whose holds do not
  meet POL-26 (too short, or no expiry set by Share), is booked last, after every other
  leg is held and funds are held.
- A route may include at most one such leg.
- If a later step fails, or the request is withdrawn, Share cancels the partner booking
  and bears its cost.
- **Any partner booking left without Share's confirmation** is cancelled at once, at
  Share's cost (POL-08). This applies to every partner leg, at a partner with holds or
  without: a partner with holds confirms its leg before Share's decision (Share never
  confirms a leg the partner has not confirmed), so a failure, a withdrawal or the
  deadline after that point leaves a partner booking behind a request that is not
  confirmed, as a later step's failure does for a partner without holds.
- Commercially, holds are preferred as a listing condition.
- **Reconciliation with partners.** Any partner call with an unknown result is
  reconciled for that booking at once, by idempotent re-query. Every partner is fully
  reconciled daily, by 12:00 UTC on D + 1 (as POL-24). Each mismatch alerts operations.
  - A partner booking with no Share reservation behind it is cancelled at Share's cost.
  - A Share reservation that the partner lacks is treated as affected by an unplanned
    outage on that leg (POL-07), and its holder is told.

**Why.** Booked last, a final-only leg is committed only when everything else is
secured, so the buyer still gets all or nothing; Share bears the cost if it fails after
that point. The partner is confirmed before Share decides, on every partner leg, so the
same residue exists for partners with holds; cancelling it at once, at Share's cost,
keeps the buyer whole and bounds how long a partner holds capacity for a request that
was not confirmed. Two such legs cannot be made all-or-nothing. Reconciliation bounds
divergence, and the buyer is never charged for Share's or the partner's error, at the
cost of a daily batch per partner and the occasional partner fee Share pays.

## POL-29. Idempotency

*Answers GA-23, GA-24 (requirements gate A); final gate B FB-10.*

**Decision.**
- Idempotency keys are scoped per account. A reuse of a key by a different principal of
  the same account (another agent key or user) is refused, not answered with the other
  principal's outcome.
- A key identifies its request for `idempotency_retention`. "The same request" means the
  same route, window, rate, product and `wait` setting; a reuse with any of these
  different is refused.
- Every money-moving input (payment notifications, invoice payments, transfer
  confirmations and failure reports, payout instructions, operator corrections and
  attributions, resolutions of money escalations, write-offs, postings of charges,
  amendments, fee lines, costs Share bears and supplier debts, and movements of Share's
  own funds) is idempotent by its own source reference, under the same rules.
- A payout already instructed is never instructed again for the same amounts (a failed
  amount goes into a later run under a new reference, POL-22); a repeated transfer
  confirmation has no further effect.

| Parameter | Default |
|---|---|
| `idempotency_retention` | 24 h for booking requests; the 7-year retention (POL-06) for money-moving inputs |

## POL-30. Termination by Share

*Answers GA-09 (requirements gate A); GB-10; final gate A D-4.*

**Decision.**
- Besides the account's own request, POL-07 and POL-16, Share may end a reservation only
  for a closed list of reasons: fraud, a sanctions or legal order, or abuse of the
  network (for example attack traffic). The closed list applies only to ends on Share's
  own decision. A support operator ending a reservation at the account's documented
  request makes the account's own change (POL-08, POL-32), not a termination.
- A termination for network abuse is taken by one operator in network operations, at
  once. A termination for fraud or a sanctions or legal order is taken by an operator in
  compliance with a second compliance operator's approval (POL-32).
- Notice is given where the law allows; charges stop at termination; charges already
  accrued are not refunded; the buyer pays any shown partner cancellation fee (POL-08).
- Each termination records the reason and the operator.

**Why.** The fee and the accrued charges follow from the buyer's own conduct, as on a
POL-16 release. Keeping support's account-requested actions outside the list lets
support serve accounts that cannot use the API, while Share's power to end reservations
on its own decision stays closed.

## POL-31. Reserved rate precision

*Answers GA-36 (requirements gate A).*

**Decision.** A reserved rate is a whole number of Mbps, at least `rate_min`; zero,
negative and fractional rates are invalid.

| Parameter | Default |
|---|---|
| `rate_min` | 1 Mbps |

**Why.** Simple to sell, price and check; demand below 1 Mbps is served by best-effort
products.

## POL-32. Operator roles

*Answers gate A D-09; gate B D15; round 6; final gate A D-4.*

**Decision.** Every operator acts under exactly one role, and each action belongs to
exactly one role. Every operator action is recorded with the operator, the role, the
reason and the time.

| Role | Actions |
|---|---|
| Support | Reads; acts on an account only at the account's documented request. Such an action is the account's own (for example a cancellation under POL-08, with the account's fees and charges), never a termination (POL-30) |
| Network operations | Records unplanned outages and restorations (POL-07); terminates for network abuse (POL-30), one operator, at once |
| Finance | Price corrections, with their cause (POL-23); attribution of quarantined traffic (POL-17); setting or removing a credit limit, only on an account that has passed know-your-business checks (KYB) (POL-15), including re-vetting after an invoice write-off (POL-21); resolving money escalations: escalated payouts (POL-22) and escalated reversals (POL-21). Each with a reason |
| Compliance | Terminates for fraud or a sanctions or legal order (POL-30), with a second compliance operator's approval; discloses a buyer's identity to a supplier under a legal order that requires it (POL-33), with a second compliance operator's approval, recorded with the order |

**Why.** Clear accountability, and four eyes on the irreversible actions that are not
urgent (terminations for fraud or legal order, identity disclosure). Abuse can still be
stopped by one operator at once. One control model covers every operator action that
moves or unlocks money.

## POL-33. What suppliers see of buyers

*Answers gate A D-08; round 6.*

**Decision.**
- A supplier sees, for each reservation on its link, the reservation's rate, window and
  endpoints, and an opaque per-reservation reference, used for no other reservation, for
  provisioning.
- A supplier does not see the buyer's account identity, or anything that links a
  reservation to the buyer's other reservations, unless the buyer consents or a legal
  order requires it.
- **Consent** is given by an account administrator of the buyer, per named supplier,
  and is recorded. It can be withdrawn, which takes effect for future views. An agent
  key cannot give it (POL-25).
- **Disclosure under a legal order** is a compliance action that needs a second
  compliance operator's approval, and is recorded with the order (POL-32).

**Why.** Carrier neutrality and discretion, and suppliers cannot take buyers
off-platform. Provisioning works on the reference. Consent per named supplier, by an
administrator, keeps disclosure a deliberate account decision that an agent cannot make.

---

## Amendments

| Date | Change | Reason |
|---|---|---|
| 2026-10-11 | POL-05: contended requests wait within their deadline and go `pending`; immediate rejection only with `wait = false` | Rejecting by default broke "at least one competitor wins" |
| 2026-10-11 | POL-08: the added part of an extension is priced at the current price | Conflict with POL-27 |
| 2026-10-11 | POL-07: terms of an equivalent-path offer; buyer may decline | Undefined |
| 2026-10-11 | POL-16, POL-18: one headroom rule including usage exposure for all accounts; `low_balance_warning`; release after grace confirmed as intended | Prepaid usage exposure had no rule |
| 2026-10-11 | POL-25: spending defined; parameters named | Undefined |
| 2026-10-11 | POL-21: an orphan reversal is escalated, never applied | Would debit money never credited |
| 2026-10-11 | POL-23: Share bears its own errors in full | Undefined beyond the commission |
| 2026-10-11 | POL-13: spread in proportion to seconds active | Two readings |
| 2026-10-11 | POL-17: dropped excess is not billed | Undefined |
| 2026-10-11 | POL-26: `commit_margin` = 10 s; stuck-request alert | No value |
| 2026-10-11 | POL-06: failure scopes for RPO/RTO; per-region scope; charge timeliness | Undefined |
| 2026-10-11 | POL-17: carried excess on a non-burst product is not billed; Share pays the supplier and raises an incident | Undefined |
| 2026-10-11 | POL-25: key headroom defined; `account_inflight_floor` = 1,000 Mbps | A new account could never book |
| 2026-10-11 | POL-06: RPO 0 on region loss too; acknowledge only when durable in two regions | Money acknowledged to a payment provider is not redelivered, so it cannot be lost |
| 2026-10-11 | Round 3 (requirements gate A and B): amendments to POL-02, 06, 07, 08, 11, 12, 14, 15, 16, 17, 18, 20, 23, 24, 25, 26; new POL-29 (idempotency) and POL-30 (termination by Share). Each amendment is in its entry, marked "Amended (round 3)" | 34 policy questions from the gate reviews |
| 2026-10-11 | Round 4 (POL-06): An available minute: each capability is probed at least every 10 s from at least two locations outside the region (≥ 12 probes a minute) | GB-23 |
| 2026-10-11 | Round 4 (POL-06): The 60 s from suspension to enforcement is split: `standing_notice_time` = 10 s for the marketplace to deliver the standing change, the remaining 50 s for network operations | GB-39 |
| 2026-10-11 | Round 4 (POL-07): On an unplanned outage every reservation on the link is affected | GA-33 |
| 2026-10-11 | Round 4 (POL-07): The supplier, or an operator in network operations, may record an unplanned outage and its restoration; only the supplier books maintenance or announces a permanent reduction | GA-15 |
| 2026-10-11 | Round 4 (POL-07): "Just enough" is in Mbps: the newest part is reduced in rate only as far as needed (revoked if it reaches 0), and its holder may then cancel without any fee | GA-08 |
| 2026-10-11 | Round 4 (POL-07): `affected_notice_time` = 60 s, to tell holders and network operations of affected reservations, and again on restoration | GA-33 |
| 2026-10-11 | Round 4 (POL-07): An accepted equivalent path takes over when the notice ends; the buyer may ask to move earlier, from a minute boundary it chooses | GA-08 |
| 2026-10-11 | Round 4 (POL-08): A cancellation takes effect at the next boundary after it is made; an earlier change still pending fails "reservation ended" | GA-12 |
| 2026-10-11 | Round 4 (POL-08): On a POL-30 termination the buyer pays any shown cancellation fee, as on a POL-16 release | GB-10 |
| 2026-10-11 | Round 4 (POL-08): A cancellation fee goes wholly to the partner that imposed it: not split, no commission | GB-10 |
| 2026-10-11 | Round 4 (POL-12): After a correction borne by Share or by a supplier at fault, each later amendment to that line is split on its own; every other amendment is split as the split of the new total less the shares posted | GB-04 |
| 2026-10-11 | Round 4 (POL-14): `usage_rate_cap` bounds all of an account's usage-priced traffic on a product (burst plus traffic with no reserved rate); one lateness bound per account and product | GB-05 |
| 2026-10-11 | Round 4 (POL-14): The lateness bound uses the product's highest `usage_price` on any route | GB-05 |
| 2026-10-11 | Round 4 (POL-15): An unpaid invoice is written off 90 days after its due date, at Share's cost | GB-06 |
| 2026-10-11 | Round 4 (POL-16): A suspended account resumes when, with every full coverage hold restored, its headroom is at least `low_balance_warning` | GB-21 |
| 2026-10-11 | Round 4 (POL-16): A warning is sent once per crossing below `low_balance_warning` and quotes the top-up that brings headroom to `low_balance_warning` plus one coverage window's charges | GB-37 |
| 2026-10-11 | Round 4 (POL-18): Unposted usage = usage-priced traffic in records received but not yet posted, at each minute's price | GB-05 |
| 2026-10-11 | Round 4 (POL-22): An amount in an instructed payout is in no other payout until it is confirmed or finally failed | GB-15 |
| 2026-10-11 | Round 4 (POL-23): A downward correction with cause "other" is borne by Share | GB-12 |
| 2026-10-11 | Round 4 (POL-24): The invariant includes Share's own balance at the partner: funds held = positive buyer balances + supplier amounts owed and not paid out + Share's own balance there (commission less costs, write-offs and FX round-ups) | GB-19 |
| 2026-10-11 | Round 4 (POL-24): Day D is reconciled by 12:00 UTC on D + 1; one not completed by then is an operational alert | GB-19 |
| 2026-10-11 | Round 4 (POL-25): Key spending is cumulative over the period: charges accrued in the period by the key's reservations (covered by a hold or not), plus funds currently held for their future charges, each minute counted once | GA-21, GB-22 |
| 2026-10-11 | Round 4 (POL-26): `commit_margin` applies only to requests with a partner leg | GA-36 |
| 2026-10-11 | Round 4 (POL-31): A reserved rate is a whole number of Mbps, at least `rate_min` = 1 Mbps; zero, negative and fractional rates are invalid | GA-36 |
| 2026-10-11 | Round 5 (POL-02): How are contention cycles of three or more requests broken? | gate A D-01 |
| 2026-10-11 | Round 5 (POL-02): Is a partner's definite refusal caused by Share's own in-flight hold at that partner a contention loss? | gate A D-02 |
| 2026-10-11 | Round 5 (POL-02): What does a request that drops out of the contention guarantee get back? | gate A D-12 |
| 2026-10-11 | Round 5 (POL-10): Earliest window in a counter-offer: from now, or from the requested start? | gate A D-03 |
| 2026-10-11 | Round 5 (POL-10): What payment does an insufficient-funds rejection quote? | gate B D2 |
| 2026-10-11 | Round 5 (POL-07): Which reservations does an unplanned outage affect, and for how long? | gate A D-04 |
| 2026-10-11 | Round 5 (POL-07): What can a supplier do about maintenance that needs sold capacity? | gate A D-05 |
| 2026-10-11 | Round 5 (POL-07): When part of a reservation is affected by a permanent reduction, what is the equivalent path offered for? | gate A D-10 |
| 2026-10-11 | Round 5 (POL-07): What does a buyer pay on a cheaper equivalent path? | gate B D10 |
| 2026-10-11 | Round 5 (POL-28): Partner reconciliation interval and who resolves a mismatch | gate A D-06 |
| 2026-10-11 | Round 5 (POL-25): How is hold-squatting across many accounts bounded? | gate A D-07 |
| 2026-10-11 | Round 5 (POL-25): What does a negative key headroom do? | gate B D13 |
| 2026-10-11 | Round 5 (POL-33): What may a supplier see of buyers on its link? | gate A D-08 |
| 2026-10-11 | Round 5 (POL-32): Which operator roles exist? | gate A D-09 |
| 2026-10-11 | Round 5 (POL-32): Who may set credit limits and resolve money escalations? | gate B D15 |
| 2026-10-11 | Round 5 (POL-26): What is a request's outcome when Share is down past its deadline? | gate A D-11 |
| 2026-10-11 | Round 5 (POL-24): What exactly must the daily reconciliation prove? | gate B D1 |
| 2026-10-11 | Round 5 (POL-16): When does an account suspended for an overdue invoice resume? | gate B D3 |
| 2026-10-11 | Round 5 (POL-21): What follows a write-off? | gate B D4 |
| 2026-10-11 | Round 5 (POL-22): How is a "duplicate payout" debt recovered? | gate B D5 |
| 2026-10-11 | Round 5 (POL-06): What operation and latency does each availability probe use? | gate B D6 |
| 2026-10-11 | Round 5 (POL-06): How do billing recovery and charge timeliness fit together? | gate B D7 |
| 2026-10-11 | Round 5 (POL-08): Who pays a partner fee when a holder whose rate was cut under POL-07 cancels? | gate B D8 |
| 2026-10-11 | Round 5 (POL-15): How does a fee hold behave over time and at release? | gate B D9 |
| 2026-10-11 | Round 5 (POL-23): How is a Share-borne usage-priced payment split? | gate B D11 |
| 2026-10-11 | Round 5 (POL-12): How is a supplier with several legs on one route split? | gate B D12 |
| 2026-10-11 | Round 5 (POL-11): Is a cancellation fee a charge line? | gate B D14 |
| 2026-10-11 | Round 5 (POL-27): What happens if a grown hold on a price change cannot be covered? | gate B D16 |
| 2026-10-11 | Round 6 (POL-33): a buyer's consent to be shown to a supplier is given by an account administrator, per named supplier, recorded, and can be withdrawn for future views; an agent key cannot give it | Who may consent, and how, was undefined |
| 2026-10-11 | Round 6 (POL-32, POL-33): disclosing a buyer's identity to a supplier under a legal order is a compliance action needing a second compliance operator's approval, recorded with the order | No role or control for disclosure |
| 2026-10-11 | Round 6 (POL-06): RTO on node or zone loss of 15 min for payouts and 30 min for reporting and statements, within their 99.9% monthly budget (about 43 min) | No recovery target for payouts or reporting |
| 2026-10-11 | Consolidated: each entry states the current rule; history above | Stacked round amendments were hard to read and partly superseded |
| 2026-10-11 | POL-08: a shorten to the next minute boundary is a cancellation; POL-26: Share releases partner holds at the deadline | Left unstated by consolidation |
| 2026-10-11 | POL-08: a shorten to an end at or before the next minute boundary is a cancellation; POL-26: hold-length test restated unambiguously | Spec cleanup found the gaps |
| 2026-10-11 | Final gate: POL-02, POL-26: the contention guarantee covers a waiter whose deadline, less its completion margin (`commit_margin` with a partner leg, `ack_budget` otherwise), outlasts the outcome ahead; no new parameter | Final gate A D-1 (FA-01): the guarantee and POL-26 contradicted each other at the boundary |
| 2026-10-11 | Final gate: POL-02: a partner refusal caused by Share's final-only booking, at a partner without holds, for a request not yet decided is contention; the refused request waits for that request's outcome and the booking's cancellation, then asks again | Final gate A D-2 (FA-02): a contention path Share caused was outside the guarantee |
| 2026-10-11 | Final gate: tag convention (README, not a policy): a Rule Background contributes only the `POL-nn` it names explicitly; the glossary-term rule applies to a scenario's own steps and Examples | Final gate A D-3: needed to check tags mechanically |
| 2026-10-11 | Final gate: POL-08, POL-30, POL-32: a support operator's cancellation at the account's documented request is the account's own change (its fees apply), recorded as an operator action; POL-30's closed list applies only to ends on Share's own decision | Final gate A D-4 (FA-04) |
| 2026-10-11 | Final gate: POL-06: on a declared region disaster the affected minutes are outside the 99.99% timeliness measurement, and each of their charges is posted within its target plus the 1 h regional RTO | Final gate B D1 (FB-01): timeliness contradicted the 1 h regional RTO |
| 2026-10-11 | Final gate: POL-24: reconciliation matches top-ups, invoice payments, reversals, payouts, supplier-debt payments and movements of Share's own funds (deposits, withdrawals), each a recorded ledger movement | Final gate B D2 (FB-02): pre-funding deposits and invoice payments would have alerted |
| 2026-10-11 | Final gate: POL-24: the safeguarding corollary holds less payouts the partner has executed and the ledger has not yet confirmed | Final gate B D3 (FB-03): false while a payout was in flight |
| 2026-10-11 | Final gate: POL-22: "never paid twice" means never instructed twice; a transfer the provider executes twice is recovered as a "duplicate payout" debt | Final gate B D4 (FB-04): unmeetable as worded |
| 2026-10-11 | Final gate: POL-07, POL-23: a dearer equivalent path's difference is split by Webster among the new path's parties; each supplier is paid its share from Share's own account; the commission share is not posted | Final gate B D5 (FB-05): Share paid commission to itself |
| 2026-10-11 | Final gate: POL-24: Share's own balance never below zero is a treasury obligation checked by the daily reconciliation; no movement owed to a buyer or supplier is refused or delayed because of it | Final gate B D6 (FB-06): gate or obligation was undefined |
| 2026-10-11 | Final gate: POL-20, POL-24: funds at the partner are taken in USD as the partner reports them; each converted top-up's or payout's difference is posted to Share's own account as an FX difference | Final gate B D7 (FB-07): the invariant could not balance to the micro |
| 2026-10-11 | Final gate: POL-16, POL-27: when a price change's hold cannot fund the whole grace, the hold grows by the remaining headroom, the reservation keeps its capacity for the full grace, and any further accrual becomes a negative balance | Final gate B D8 (FB-08): "always funded" was false |
| 2026-10-11 | Final gate: POL-06: probes act as a designated Share probe account on designated probe links and exporters, excluded from rating, settlement, supplier reports and quarantine reports | Final gate B D9 (FB-09): probes had business side effects |
| 2026-10-11 | Final gate: POL-02: a waiter failed as of its deadline gets a `retry_after` of the remaining deadline of the request ahead at that moment, or zero if that request already has its outcome | Final resolution E-1: needed for the FA-01 scenario, where the request ahead ends before the waiter's deadline |
| 2026-10-11 | Final gate fixes (no new rule): POL-06 probe operation "a balance and headroom answer" (FB-12); POL-29 idempotency list completed, including resolutions of money escalations (FB-10); POL-26 duplicated hold-length bullet removed (FA-12) | Final gates A and B |
| 2026-10-11 | Architecture review: RI-1 (POL-26, POL-28): a partner counts as offering holds only if its holds can last at least `route_deadline_max` + `commit_margin` and it accepts an absolute hold expiry set by Share at hold time; Share sets it to the request's deadline; a partner that cannot is a partner without holds | RFC-000 RI-1: a partner hold outlived the deadline while Share was down, so "no capacity held after its deadline on any leg" (P2-N3) could not be met |
| 2026-10-11 | Architecture review: RI-2 (POL-14, POL-18, POL-06): unposted usage counts records accepted by usage ingestion; the lateness bound adds `attribution_lag_max` (10 s), the time from a record's acceptance to its effect on headroom; a timeliness target for it; later records reported as breaches. At the defaults the bound grows from 240 s to 250 s of `usage_rate_cap` | RFC-000 RI-2: the propagation from acceptance to headroom had no bound |
| 2026-10-11 | Architecture review: RI-3 (POL-04, POL-25): each request's outcome is decided at one point, against which "still pending" is judged (a key's revocation fails only requests not yet decided); a status read lags the decision by at most `status_staleness` (1 s) and never reports an outcome contrary to it | RFC-000 RI-3: "pending when suspended" had two readings once the decision and its status are kept apart |
| 2026-10-11 | Architecture review: RI-4 (POL-06): the funds holds and headroom checks a booking needs are part of the admission capability (99.99%, RTO 1 min), whatever the wallet's own targets | RFC-000 RI-4: sizing could have followed the wallet's looser targets |
| 2026-10-11 | Architecture review: RI-5 (POL-06): "per region" means each serving region, one whose edge answers buyers, suppliers, exporters or payment providers | RFC-000 RI-5: "region" was undefined for state spanning three regions |
| 2026-10-12 | RFC-000 review: RQ-1 (POL-26): on a Share link, capacity held for a request not confirmed is released at its deadline, or within `release_grace` (1 min) after it if Share's record of the request's decision is unavailable at the deadline (an operational alert); a request is never confirmed after its deadline; partner holds unchanged | RFC-000 review RQ-1: an all-or-nothing commit cannot also release every Share-link hold at the deadline while the decision record has no quorum without risking a release followed by a confirmation |
| 2026-10-12 | RFC-000 review: RQ-2 (POL-28, POL-26, POL-08, POL-02): a partner booking left without Share's confirmation, at a partner with or without holds, is cancelled at once at Share's cost; POL-08's Share-pays list and POL-02's partner-refusal rule cover it | RFC-000 review RQ-2: a partner with holds is confirmed before Share's decision, so a failure after that point left a partner booking that no rule covered |
| 2026-10-12 | RFC-000 review: RQ-3 (POL-06): during a declared region disaster, from its declaration until the lost region is restored or replaced, the latency targets are not measured; RPO 0 and acknowledgement only once durable in two regions still apply | RFC-000 review RQ-3: after a region loss every commit must reach the remaining far region, so `ack_budget` at p99 cannot hold |
| 2026-10-12 | RFC-000 review: RQ-4 (POL-07): an equivalent-path offer is firm: the path's capacity is held for the reservation while the offer is open (at most `offer_window`), as Share's own hold with no funds hold, counted as committed for new sales, and released at once on a decline or lapse | RFC-000 review RQ-4: whether the offered path's capacity was held was unstated |
| 2026-10-12 | RFC-000 review: D3 (POL-06): the probe account is a Share-internal account with a `credit_limit` set by finance, counted as vetted and never invoiced; the assumed topology of serving regions is stated in X2's constraints | RFC-000 review decision D3; the coordinator's topology decision |
| 2026-10-12 | RFC-000 review: RQ-4 follow-up (POL-07): all-Share equivalent paths are offered first, as firm offers; a path with a partner leg is offered only when no all-Share path exists, firm on its Share legs, its partner leg booked only at acceptance (the buyer told so at offer time); if that booking fails, the outcome is as for a declined offer and any other equivalent path still available is offered | Coordinator decision on the open point of review 07: no partner hold lasts `offer_window` |
| 2026-10-12 | RFC-000 revision: RQ-5 (POL-26, POL-04): a request is confirmed only by a decision whose entry is timestamped before its deadline less its completion margin; no confirmation is decided after the deadline; one decided in time may become known up to `release_grace` after the deadline if the decision record was unavailable, status reads reporting `pending` until then | RFC-000 revision RQ-5: no consensus log bounds when a proposed entry becomes durable, so "never confirmed after the deadline" read as "never known after it" could not be guaranteed |
| 2026-10-12 | RFC-000 revision: RQ-6 (POL-04): an outcome other than confirmed is reported only once the release of the Share-link capacity it frees is durable; that capacity is free from the moment the outcome is reported, not from the instant of the decision | RFC-000 revision RQ-6: with the decision in the account's log and holds in other links' logs, the release cannot be the same instant as the decision |
| 2026-10-12 | RFC-000 review 2: RQ-7 (POL-26, POL-02, POL-04): a request is confirmed only by a decision whose entry is timestamped before its deadline; the completion margin bounds when committing may begin: a request with a partner leg does not begin committing later than deadline − `commit_margin`, one without a partner leg not later than deadline − `ack_budget`; this replaces "timestamped before the deadline less the completion margin" | RFC-000 review 2 RQ-7: a partner route could begin committing at deadline − `commit_margin` yet had to be confirmed before it, leaving no time for the partner's confirmation |
| 2026-10-12 | RFC-000 review 2: RQ-8 (POL-04, POL-26): an outcome other than confirmed is reported only once its Share-link releases are durable, within `status_staleness` of the decision normally and within `release_grace` of it while the schedule owner of a Share link it holds is failing over; a Share-link hold is likewise released within `release_grace` after the deadline while that link's schedule owner is failing over then | RFC-000 review 2 RQ-8: while a link's schedule owner fails over, its release cannot be durable within `status_staleness`, so the requirement forbade both reporting the outcome and not reporting it |
| 2026-10-12 | RFC-000 review 2: RQ-10 (POL-04): the exception "status reads report `pending` while the decision record is unavailable at the deadline" never applies to an outcome already reported; a reported outcome is reported by every later status read | RFC-000 review 2 RQ-10: a `pending` answer could follow a reported outcome, against "an outcome never changes once reported" |
| 2026-10-12 | RFC-000 review 2: RQ-11 (POL-24): the reconciliation invariant adds payments the partner has received and reported and the ledger has not yet posted, each matched to its partner credit, symmetric with payouts executed but not yet confirmed; the safeguarding rule likewise | RFC-000 review 2 RQ-11: a top-up near the cut, posted seconds later, would have made every daily cut show a difference and alert |
| 2026-10-12 | RFC-000 review 2: A0R-05 (POL-06, X2 constraints): the assumed topology gains a go-live condition, *Assumed*: R1 Nairobi has at least two physically diverse fibre paths, one of them to R3 Johannesburg not via Mombasa, and R2 Mombasa likewise, one of them to R3 not via Nairobi; a go-live condition (production gate), not a design target | RFC-000 review 2 A0R-05: one Nairobi–Mombasa cut could isolate Nairobi from Johannesburg too |
| 2026-10-12 | RFC-000 revision 3: RQ-12 (POL-04): the status-read exception for an unavailable decision record applies before or at the deadline: while a request's decision record is failing over, a status read of an outcome not yet reported may report `pending` beyond `status_staleness`, until the record is available again, at most admission's 1 min recovery time after it became unavailable (and at most `release_grace` after the deadline when unavailable at it); never a wrong outcome, never after a reported outcome (RQ-10 stands) | RFC-000 revision 3 RQ-12: a decision in flight when an account's record fails over before the deadline becomes known only after the failover, so no status read could report it within `status_staleness` |
