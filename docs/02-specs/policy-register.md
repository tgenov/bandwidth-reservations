# Policy register

Business policy that the specs depend on. Specs state mechanism and refer to these
policies by ID (`POL-nn`) and their named parameters; changing a policy or a parameter
value must not require a change of mechanism.

**Status of every entry: Decided (provisional).** The decisions were made by the design
team from public information about the market and about Share (see the
[company profile](../01-discovery/company-profile.md)), to unblock the design. The
business must ratify them. Each entry answers a Decision question from the
[requirements review](../reviews/01-requirements-review.md) (`D-nn` there, `R-nn` the
finding).

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
| POL-01 | Pricing model | Pay per reservation: per Mbps-minute reserved, accrued per minute, no minimum term |
| POL-02 | Contention | The oldest request wins; the priority rule is configuration, the invariants are not |
| POL-03 | Interrupted route requests | Resume within the deadline; otherwise fail, release, notify |
| POL-04 | Buyer interaction | Final answer if ready within the budget; otherwise "pending", then poll or webhook |
| POL-05 | Authority over a link | One schedule owner per link; a single-link booking is a one-leg route |
| POL-06 | Non-functional targets | 99.99% admission; ×50 design load; RPO 0 for money and reservations |
| POL-07 | Loss of supply | Never revoke silently; stop new sales at once; SLA credits; planned works are booked |
| POL-08 | Changing a reservation | Cancel or shorten any time; extend or increase by a new admission of the difference |
| POL-09 | Selling horizon | Rolling 12 months; open-ended bookings guaranteed as the horizon rolls |
| POL-10 | Rejections | Actionable counter-offers; never disclose other buyers |
| POL-11 | Money unit and rounding | Micros per currency; round charges down; residues carried, never taken |
| POL-12 | Splitting revenue | Monotone, unbiased rule (Webster); Share loses ties; rule published |
| POL-13 | Multi-minute flows | Exporters cut flows at 60 s; longer flows are spread evenly |
| POL-14 | Late usage | Billed whenever it arrives; breaches of the lateness bound are reported |
| POL-15 | Funds at admission | Hold a rolling coverage window of charges; vetted accounts get credit limits |
| POL-16 | Suspension | Keep reservations for a grace period equal to the coverage window, then release; resume automatically |
| POL-17 | Unmatched traffic | Kept always; over-rate traffic is policed; unattributable traffic is quarantined |
| POL-18 | Balance shown | Available headroom, with balance, held funds and accrued charges itemised |
| POL-19 | History | Bitemporal: every reservation change, who and when, kept 7 years |
| POL-20 | Currency | USD settlement; conversion at top-up and payout at a shown rate |
| POL-21 | Reversals and refunds | Reversals in scope now; withdrawals later; SLA credits are service credit |
| POL-22 | Payouts | Weekly, on confirmed transfer, with a minimum amount |
| POL-23 | Bad debt | Share bears buyer credit risk; supplier earnings are final once charged |
| POL-24 | Regulation | Hold funds through a licensed payment partner |
| POL-25 | AI-agent controls | In scope now: per-key spending and in-flight limits, rate limits |
| POL-26 | Route deadline | Chosen per request, default 30 s, maximum 60 s |
| POL-27 | Price changes | On minute boundaries only; a booked reservation keeps its price |
| POL-28 | Partners without holds | Booked last; at most one per route; Share bears the cancellation cost |
| POL-29 | Idempotency | Per account; a different principal is refused; 24 h for bookings, 7 years for money |
| POL-30 | Termination by Share | Only for fraud, legal order or network abuse, recorded |
| POL-31 | Reserved rate precision | Whole Mbps, at least 1 Mbps |

---

## POL-01. Pricing model: pay per reservation

*Answers D-01 (R-02).*

**Decision.** Guaranteed products are priced per **Mbps-minute reserved**. The charge
accrues minute by minute for as long as the reservation is active, whether or not
traffic crosses it. There is no minimum term and no setup fee. Usage-based pricing (per
GB) applies only to products with no guarantee (best-effort IP transit, CDN traffic) and
to burst above a reservation where the product permits it (POL-17).

| Parameter | Default |
|---|---|
| `reservation_price` | Per product and route, in micro-USD per Mbps-minute |
| `billing_granularity` | 1 minute; part minutes are charged as whole minutes |
| `minimum_term` | None (one minute), unless a partner leg imposes one (POL-08) |
| `usage_price` | Per GB, best-effort products and permitted burst only |

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

**Consequence for the design.** Metering stops being the primary revenue path. It bills
best-effort products and burst, and supplies evidence for SLA delivery (Problem 6).

## POL-02. Contention: the oldest request wins

*Answers D-02 (R-04).*

**Decision.** When requests compete for the same capacity, the request that arrived
first has priority (`priority_rule = request_age`). The rule is a configuration of the
admission component, changed by deployment, not per request. Whatever the rule, these
invariants are fixed: capacity is never oversold; when requests compete, at least one
wins; no request waits forever.

**Why.** Age is predictable and explainable, cannot be bought or gamed, and is
non-discriminatory, which a carrier-neutral marketplace needs. Value-based priority
invites gaming (inflating size or duration to win); customer tiers create a two-class
market at odds with standardised pricing.

**Amended (round 3).** The priority rule orders requests that are **waiting**, and resolves
**crossings** (two requests each holding capacity the other needs): the older keeps what
it holds and the younger releases its conflicting holds and waits, within its own
deadline. A request that already holds capacity it needs, with no crossing, keeps it; an
older request does not pre-empt it.

The guarantee is: **contention alone never makes every competitor lose.** It covers
requests that wait (the default) and whose deadline outlasts the outcome of the request
ahead of them. A request that opts out (`wait = false`), or chooses a deadline shorter
than the outcome it waits on, has excluded itself. Losses caused by failures (a partner's
refusal or fault, an expired deadline after a fault) are not contention losses; for them
the guarantee is that nothing is left held and the buyer is told why.

## POL-03. Interrupted route requests: resume within the deadline

*Answers D-03 (R-05).*

**Decision.** If Share's booking process fails while a route request is in progress,
the request resumes automatically if it can still finish within its deadline (POL-26).
Otherwise it fails, everything it held is released, and the buyer is told why. Either
way the buyer sees one outcome per request.

**Why.** The buyer did nothing wrong; failing their request for an internal fault
shifts Share's reliability problem onto them. The deadline bounds how long capacity
stays in flight.

## POL-04. Buyer interaction: synchronous when ready, otherwise pending

*Answers D-04 (R-06).*

**Decision.** Every booking request gets a response within `ack_budget`. If the
outcome is known by then (typical for single links), the response is final. Otherwise
it is `pending`, and the buyer learns the outcome by polling with the idempotency key,
by webhook if they registered one, or both.

| Parameter | Default |
|---|---|
| `ack_budget` | 200 ms at p99 |
| `webhook_retry` | Exponential backoff for 24 h, at least once, signed |

**Why.** API clients and agents need a fast, uniform answer; routes across partners
cannot always finish in 200 ms; polling and webhooks are the conventions of every
asynchronous payments and provisioning API.

## POL-05. Authority over a link: one schedule owner

*Answers D-05 (R-07).*

**Decision.** Each link's schedule has exactly one owner at a time; every booking on
that link, single-link or route, goes through it. A single-link booking is a route of
one leg. A request that fits only if an in-progress request fails keeps waiting, up to
its own deadline (POL-26); if it is not decided within `ack_budget`, the buyer gets
`pending` (POL-04). A buyer who asks not to wait (`wait = false`) is instead rejected at
once with a `retry_after` equal to the in-flight request's remaining deadline.

**Why.** Two authorities over one schedule cannot both guarantee "never oversell". A
uniform model gives single links and routes the same priority rule (POL-02). Waiting by
default, not rejecting, is what makes "at least one competitor wins" hold: a rejected
buyer may never retry.

## POL-06. Non-functional targets

*Answers D-06 (R-10).*

| Target | Value |
|---|---|
| Availability, admission API | 99.99% per calendar month, per region |
| Availability, usage ingestion | 99.99%; ingestion may lag but must not lose an accepted record |
| Availability, wallet, payouts, reporting | 99.9% |
| Admission throughput (design) | 25,000 requests/s overall (×50 of 500/s); 2,500/s on the hottest link |
| Metered traffic (design) | ×50 of 45 TB/day, about 2.25 PB/day; flow-record rate to be sized from exporter data |
| Latency, single-link booking | p99 ≤ 200 ms to a final answer |
| Latency, route booking | p99 ≤ 200 ms to acknowledgement; final outcome within the request deadline (POL-26) |
| Latency, top-up to credited balance | p99 ≤ 10 s from the payment provider's notification |
| Latency, suspension decision to enforcement | ≤ 60 s |
| Availability scope | Every target is per region |
| Durability (RPO) | 0 for every acknowledged fact (reservations, the ledger, payment events, accepted usage records), on loss of a node, a zone or a region. A fact is acknowledged only once it is durable in two regions |
| Recovery (RTO) | On loss of a node or zone: 5 min for admission, 15 min for billing and wallet. On loss of a region: 1 h |
| Charge timeliness | A minute's reservation charge is posted within 2 min of the minute's end; usage-priced charges within `max_lateness` + 2 min |
| Retention | Ledger, payment events, reservation history and raw usage: 7 years |

**Why.** These adopt the company profile's figures (99.99%, ×50) and the assumed
current load. Seven years covers the record-retention rules common across the planned
markets; legal must confirm it per market (POL-24).

**Amended (round 3).** - **Node or zone loss is transparent.** Admission RTO ≤ 1 min; billing and
  wallet ≤ 5 min. Region loss is a declared disaster, outside the availability
  measurement, with RTO 1 h and RPO 0.
- **Availability** is the share of minutes in a calendar month in which the service
  answers correctly within its latency target, measured by synthetic probes from outside
  the region.
- **Provisional design load until exporter data exists:** flow records at an assumed
  mean of 100 KB of traffic per record, i.e. about 260,000 records/s average for
  2.25 PB/day; design for 600,000/s peak. Payment notifications: 1,000/s peak. Admission
  mix: 80% single-link, 20% routes; 70% of requests fit. All four are to be replaced by
  measurements before production.
- X2's 200 ms target for a single-link booking is to an answer, final or `pending`
  (POL-04); a final answer is expected within it when no capacity is in flight.

**Amended (round 4).**
- An available minute: each capability is probed at least every 10 s from at least two locations outside the region (≥ 12 probes a minute). A probe succeeds if it gets a correct answer within the operation's latency value, as a per-probe limit. A minute is available if ≥ 90% of its probes succeed. Planned maintenance is not excluded; payouts are probed through their interfaces *Trade-off:* Honest to buyers and easy to audit; forces maintenance without downtime. (GB-23)
- The 60 s from suspension to enforcement is split: `standing_notice_time` = 10 s for the marketplace to deliver the standing change, the remaining 50 s for network operations *Trade-off:* Each side owns a target it alone controls; the 60 s in the exposure bound is unchanged. (GB-39)

## POL-07. Loss of supply: never revoke silently

*Answers D-07 (R-11).*

**Decision.**
- When a link's capacity falls, new sales on it stop at once at the reduced capacity.
- **Unplanned outage:** confirmed reservations are not revoked; they are flagged as
  affected and SLA credits apply automatically (Problem 6).
- **Planned maintenance** must be booked by the supplier as a reservation against the
  link, at least `maintenance_notice` ahead, so it can only take capacity that is free.
- **Permanent reduction** (supplier exit, contract end): each affected buyer is
  offered an **equivalent path**: the same endpoints and rate, latency and SLA class no
  worse, at the original price (Share bears any difference). The buyer may decline.
  Reservations not re-routed are revoked newest first, with `revocation_notice` and no
  charge for the remaining period. Finding equivalent paths belongs to routing, which is
  out of scope here; this policy fixes only the terms of the offer.

| Parameter | Default |
|---|---|
| `maintenance_notice` | 10 business days |
| `revocation_notice` | 30 days |

**Why.** The guarantee is the product; the 2000-era exchanges failed by selling what
could not be delivered. Pro-rata degradation breaks every buyer's guarantee to spare
one.

**Amended (round 3).** Mechanics of a permanent reduction:
1. The supplier must keep the capacity for `revocation_notice`; the reduction takes
   effect when the notice ends. New sales stop at once at the reduced capacity.
2. Only reservations that would otherwise not fit are affected: just enough, newest
   first, to fit the reduced capacity. Each added part (POL-08) has its own age.
3. An equivalent-path offer goes to each affected buyer and lapses after `offer_window`;
   no answer counts as declined. A declined or lapsed offer means revocation at the end
   of the notice.
4. Planned maintenance bookings accrue nothing and are excluded from rating and
   settlement. Only the link's own supplier may book maintenance or change the link's
   capacity.

| Parameter | Default |
|---|---|
| `offer_window` | 7 days |
| `maintenance_notice` | 14 calendar days (replaces 10 business days) |

**Amended (round 4).**
- On an unplanned outage every reservation on the link is affected *Trade-off:* The network cannot choose whose packets drop; "newest first" stays for permanent reductions, where Share does choose. (GA-33)
- The supplier, or an operator in network operations, may record an unplanned outage and its restoration; only the supplier books maintenance or announces a permanent reduction *Trade-off:* Sales stop as soon as Share's monitoring sees a fault; commercial changes stay the supplier's. (GA-15)
- "Just enough" is in Mbps: the newest part is reduced in rate only as far as needed (revoked if it reaches 0), and its holder may then cancel without any fee *Trade-off:* Keeps the most capacity sold and the most of each guarantee, and the buyer can walk away. (GA-08)
- `affected_notice_time` = 60 s, to tell holders and network operations of affected reservations, and again on restoration *Trade-off:* Matches the enforcement target; gives "at once" a number. (GA-33)
- An accepted equivalent path takes over when the notice ends; the buyer may ask to move earlier, from a minute boundary it chooses *Trade-off:* Continuity by default, with no forced early migration. (GA-08)

## POL-08. Changing a reservation

*Answers D-08 (R-12).*

| Change | Rule |
|---|---|
| Cancel | Any time; takes effect at the next minute boundary; charges stop then |
| Shorten | Any time, as a cancellation of the remaining part |
| Extend, or increase the rate | A new admission of the difference only; the existing part is never at risk. The added part is priced at the price in force when the change is made; the existing part keeps its price (POL-27) |
| Decrease the rate | Any time, from the next minute boundary |
| Renew | An extension |
| Part of a route | Not allowed; a route is one unit. Cancel and book again |

A partner leg may impose a minimum term or cancellation fee; it is shown in the price at
booking time and charged on cancellation. Share absorbs partner fees it did not show.

**Why.** No term is the product's main promise. Admitting only the difference keeps
modifications as safe as new bookings.

**Amended (round 3).** - A rate increase applies from the next minute boundary to the end of the
  reservation. A rate that differs over sub-windows is a separate reservation.
- A decrease removes the most recently added part first (last in, first out).
- A change is admitted like a new booking: capacity, funds (the hold grows with the
  coverage of the added part), key headroom and limits. A suspended account may cancel,
  shorten or decrease, but not extend or increase.
- Changes to one reservation are applied one at a time, in arrival order; each is
  checked against the reservation as left by the previous one.
- A change or cancellation of a route applies to every leg; partner legs follow the
  partner's terms shown at booking.
- A partner's minimum term is charged on early cancellation as a cancellation fee,
  shown at booking. The funds hold at admission is the larger of the coverage and that
  fee. When reservations are released after suspension (POL-16) the buyer pays the fee;
  when revoked (POL-07), Share pays it.
- A buyer may withdraw a pending request: it fails as "withdrawn" and releases what it
  holds; a final-only partner leg already booked is cancelled at Share's cost (POL-28).

**Amended (round 4).**
- A cancellation takes effect at the next boundary after it is made; an earlier change still pending fails "reservation ended". Arrival order applies only among changes that do not end the reservation *Trade-off:* The buyer's right to stop paying at the next minute is absolute; the pending change loses nothing it had. (GA-12)
- On a POL-30 termination the buyer pays any shown cancellation fee, as on a POL-16 release *Trade-off:* Both follow from the buyer's own conduct. (GB-10)
- A cancellation fee goes wholly to the partner that imposed it: not split, no commission *Trade-off:* The fee compensates the partner's commitment; Share should not profit from a cancellation. (GB-10)

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

*Answers D-10 (R-14).*

**Decision.** A rejection states, as far as can be computed within the budget:
- the largest rate that fits the requested window;
- the earliest window of the requested length that fits the requested rate, within the
  selling horizon;
- for a route, the link that blocked it;
- `retry_after`, when capacity is held by an in-flight request (POL-05);
- for insufficient funds, the amount to top up (POL-15).

It never discloses other buyers' identity, individual reservations or usage.

**Why.** Agents act on machine-readable alternatives; a rejection that proposes what
does fit turns into a sale.

## POL-11. Money unit and rounding

*Answers D-11 (R-17).*

**Decision.** Amounts are integers in **micros** (10⁻⁶) of the currency's major unit,
always tagged with the currency (POL-20). A charge is computed exactly and rounded once,
**down** to the micro (in the buyer's favour). At top-up, the provider's amount converts
exactly. At payout, amounts are rounded down to the provider's minor unit and the
residue stays in the payee's account for the next payout; Share never keeps residues.

**Why.** At micro precision, rounding in the buyer's favour costs nothing material and
is a trust signal; carrying residues makes cumulative payouts exact.

**Amended (round 3).** **The unit rounded once** is a charge line: one reservation (or, for
usage-priced traffic, one account and product on one route) for one minute. An amendment
to a charge line is the line's exact new total rounded down once, less what was already
charged for that line; amendments are split the same way (POL-12).

## POL-12. Splitting revenue among parties

*Answers D-12 (R-18).*

**Decision.** Each charge is split among the parties on the route (suppliers and Share's
commission) by an apportionment rule that must be:
- **exact:** shares sum to the charge;
- **monotone:** when a minute's total grows (late usage, POL-14), no party's share falls;
- **unbiased:** it does not systematically favour large or small parties.

The rule is **Webster (Sainte-Laguë)**. Ties are broken in a fixed published order in
which **Share's commission loses** to every supplier. The rule and order are published
to suppliers. Cumulative deviation from exact proportions is reported per party per
payout period.

**Why.** Suppliers must trust a neutral settler. A divisor rule that favours large
parties systematically favours the largest share, often Share's own commission. Webster
is monotone and unbiased. At micro precision the per-minute deviation is immaterial, so
quota-capped methods add complexity without benefit.

**Amended (round 3).** Ties among suppliers are broken in route leg order, first leg first; Share's
commission loses to every supplier. The split is per route: a usage charge line is
always for one route (POL-11).

**Amended (round 4).**
- After a correction borne by Share or by a supplier at fault, each later amendment to that line is split on its own; every other amendment is split as the split of the new total less the shares posted *Trade-off:* Keeps every share of a late-traffic increase non-negative, for a small reported deviation. (GB-04)

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
POL-01 this affects only usage-priced products and burst.

## POL-14. Late usage

*Answers D-14 (R-20).*

**Decision.** A usage record is billed whenever it arrives; late records are never
dropped (they are owed to a supplier). `max_lateness` is the lateness the exposure bound
assumes; records later than it are billed and also reported as bound breaches. Price
rises cannot occur within the window, because a booked reservation keeps its price
(POL-27) and best-effort prices change only with notice. Under a credit limit, the limit
includes the unmetered window: suspend early rather than lose beyond the limit.

| Parameter | Default |
|---|---|
| `max_lateness` | 180 s |

**Amended (round 3).** Usage exposure's lateness part = `usage_rate_cap` × (`max_lateness` + the
suspension-to-enforcement target of POL-06) × `usage_price`, where `usage_rate_cap` is
a per-account, per-product rate policed at the edge for traffic with no reserved rate.

| Parameter | Default |
|---|---|
| `usage_rate_cap` | Set at onboarding per account and product; 100 Mbps by default |

**Amended (round 4).**
- `usage_rate_cap` bounds all of an account's usage-priced traffic on a product (burst plus traffic with no reserved rate); one lateness bound per account and product *Trade-off:* One number bounds Share's risk per account; more burst means a higher cap agreed at onboarding. (GB-05)
- The lateness bound uses the product's highest `usage_price` on any route *Trade-off:* Conservative, by at most the price spread between routes. (GB-05)

## POL-15. Funds at admission

*Answers D-15 (R-21).*

**Decision.** "No upfront payment" means no setup fees, no term commitment and no
pre-purchase of the whole term. Admission requires funds for a rolling
`coverage_window` of the reservation's charges (or the whole reservation, if shorter):
these funds are **held** in the wallet, not charged. Charges then accrue per minute
against the held funds, and the hold rolls forward. Accounts vetted by know-your-business
checks may instead have a credit limit, settled by monthly invoice. Refusing a booking
for insufficient funds is acceptable; the rejection states the top-up needed (POL-10).

| Parameter | Default |
|---|---|
| `coverage_window` | 24 h |
| `credit_limit` | Per vetted account; none by default |

**Why.** Prepaid is the regional norm. Holding a short window, not the term, keeps the
no-upfront promise while bounding Share's risk to one window.

**Amended (round 3).** - **Future reservations:** the hold for the first coverage window is taken at
  admission and kept until the reservation starts, then rolls forward as usual.
- **Credit-limit accounts:** admission takes a **credit hold** for the coverage window,
  counted as funds held in the headroom formula (POL-18). Invoices are due in
  `invoice_terms`; unpaid after that, the account is suspended under POL-16; unpaid
  debt is written off after 90 days (POL-21).

| Parameter | Default |
|---|---|
| `invoice_terms` | 30 days |

**Amended (round 4).**
- An unpaid invoice is written off 90 days after its due date, at Share's cost. The account stays suspended, and later reservations need prepayment until the debt is paid *Trade-off:* Gives the 90 days a defined start; Share bears its credit risk (POL-23). (GB-06)

## POL-16. Suspension and resumption

*Answers D-16 (R-22).*

**Decision.** An account is suspended when its headroom (POL-18) would fall below zero:
the coverage hold cannot roll forward, or usage exposure exceeds what is left. The
buyer is warned when headroom falls below `low_balance_warning`. While suspended: no new bookings; existing reservations
keep their capacity for `suspension_grace` and keep accruing charges against the hold
already taken; usage-priced traffic is blocked at the edge. If funds arrive within the
grace period, the account resumes automatically. After it, the reservations are released
and the buyer is told.

| Parameter | Default |
|---|---|
| `suspension_grace` | Equal to `coverage_window` (24 h), so the grace is always funded |
| `low_balance_warning` | Headroom below a quarter of one coverage window's charges (6 h at the default) |

Releasing reservations after the grace period is intended. It is a termination caused
by non-payment, announced at suspension, and distinct from the supply-side withdrawals
of POL-07.

**Why.** A grace period funded by the existing hold costs Share nothing. Automatic
resumption suits self-serve and agent buyers.

**Amended (round 3).** - A suspended account resumes when its headroom is at least zero with every
  reservation's full coverage hold restored. A warning or suspension notice quotes that
  amount.
- When a reversal leaves the balance below the funds held, reservations are still kept
  for the full `suspension_grace`; Share bears up to one coverage window (POL-23).
- `low_balance_warning` = max(a quarter of one coverage window's charges, 1 USD), so an
  account without reservations is still warned.

**Amended (round 4).**
- A suspended account resumes when, with every full coverage hold restored, its headroom is at least `low_balance_warning`. The quoted resume amount achieves that *Trade-off:* Resuming costs at least 1 USD more, but the account is not suspended again at the next minute, as it would be at exactly zero. (GB-21)
- A warning is sent once per crossing below `low_balance_warning` and quotes the top-up that brings headroom to `low_balance_warning` plus one coverage window's charges *Trade-off:* About one more window of runway, without repeated alerts; the round-3 resume amount would be zero for an active account. (GB-37)

## POL-17. Traffic that does not match a reservation

*Answers D-17 (R-24).*

**Decision.** Every usage record is kept.
- Traffic above the reserved rate is policed at the edge. Where the product permits
  burst, it is carried best effort on capacity that is otherwise idle, and billed at
  `usage_price`. Where it does not, the excess is dropped and not billed. If policing fails and
  excess is carried anyway, it is still not billed to the buyer (the failure is Share's);
  Share pays the supplier for it at `usage_price` from its own account, and the failure
  is raised as an incident.
- Traffic attributable to the account but outside an active reservation is billed at
  `usage_price` and counts toward exposure.
- Traffic that cannot be attributed is quarantined, not billed, and reported to
  operations and the supplier. The supplier is paid for it only if it is attributed
  within `dispute_window`.

| Parameter | Default |
|---|---|
| `dispute_window` | 30 days |

**Why.** Without oversubscription, burst may only use capacity no one reserved.

**Amended (round 3).** - Every guaranteed product carries a `usage_price`, used for attributable traffic
  outside a reservation and for what Share pays a supplier for carried excess, even when
  the product does not permit burst.
- Traffic "above the reserved rate" is measured per minute: bytes in the minute beyond
  reserved rate × 60 s.
- Quarantined traffic attributed within `dispute_window` is billed to the buyer at the
  price of the traffic's minute, and the supplier is paid. After the window, neither.
- **One count per route.** When legs report different byte counts for the same traffic,
  the egress (delivered) count is billed to the buyer, and suppliers are paid their split
  of that charge.

## POL-18. The balance a buyer sees

*Answers D-18 (R-27).*

**Decision.** The headline figure is **available headroom**: balance minus held funds
minus usage exposure (plus any credit limit). **Usage exposure** is the estimate of
usage-priced traffic carried but not yet posted, plus the bound for `max_lateness`
(POL-14). The same headroom governs admission (POL-15) and suspension (POL-16) for every
account, prepaid or credit-limit. The response itemises the ledger balance, held funds, charges
accrued but not yet posted, and an estimate of unposted usage.

**Why.** Agents decide on headroom; finance reconciles on the itemised figures.

**Amended (round 3).** Charges accrued but not yet posted stay within funds held until posted; they
are itemised for information, not deducted twice. Usage exposure is itemised in its two
parts (unposted usage; the lateness bound).

**Amended (round 4).**
- Unposted usage = usage-priced traffic in records received but not yet posted, at each minute's price *Trade-off:* Exact and reproducible; the unseen part is bounded by POL-14. (GB-05)

## POL-19. History

*Answers D-19 (R-29).*

**Decision.** Every change to a reservation is recorded with who made it and when, and
the system can answer "what was known to be reserved on this link at time T" for any
past T. Kept for 7 years (POL-06).

**Why.** SLA claims, billing disputes and supplier settlement all need it; auditability
is part of a neutral settler's credibility.

## POL-20. Currency

*Answers D-20 (R-31).*

**Decision.** Prices, wallets and the ledger are in **USD**. A top-up in another
currency (for example KES by M-Pesa) is converted at top-up, at the payment partner's
rate, which is shown before the buyer confirms. Suppliers are paid in USD, or converted
at payout at the shown rate. Share carries no FX risk between charge and payout.

**Why.** Wholesale capacity in the region is priced in USD. A single settlement
currency keeps the ledger simple; the mechanism must still tag every amount with its
currency so more can be added.

**Amended (round 3).** - A top-up converts at the shown rate, rounded **up** to the micro (in the
  buyer's favour). A payout converts at the shown rate, rounded down to the provider's
  minor unit; the residue, converted back at the same rate, is carried in USD.
- A shown rate is valid for `fx_quote_validity`. A payment arriving later is credited at
  the partner's rate at notification, and that rate is shown on the statement.

| Parameter | Default |
|---|---|
| `fx_quote_validity` | 15 min |

## POL-21. Reversals, refunds and credits

*Answers D-21 (R-32).*

| Item | Decision | Scope |
|---|---|---|
| Reversal (chargeback) after the top-up was spent | Applied at once; the account is suspended if headroom goes negative (POL-16); collected from the next top-up; written off after 90 days | Now |
| Reversal arriving before its completion | Held pending, matched by provider reference, for up to 72 h. If its completion has not arrived by then, it is not applied to the wallet (nothing was credited); it is escalated to operations for reconciliation with the payment partner | Now |
| Withdrawal of unused balance | On request, to the original payment method, net of provider fees | Later; requirement recorded |
| SLA credits | Service credit in the wallet, not withdrawable | Later (Problem 6) |

## POL-22. Payouts

*Answers D-22 (R-33).*

| Parameter | Default |
|---|---|
| `payout_frequency` | Weekly |
| `payout_minimum` | 50 USD; smaller balances carry forward |
| Payout complete when | The bank or mobile-money transfer is confirmed, not when instructed |
| Supplier debt | Netted against later payouts; invoiced if open more than 90 days |

**Why.** Weekly payouts are much faster than carrier wholesale terms (often 30–90 days)
and are a reason for suppliers to list. Under POL-23, supplier debt arises only from
supplier-caused errors.

**Amended (round 4).**
- An amount in an instructed payout is in no other payout until it is confirmed or finally failed. After a final failure, it goes into the next run under a new reference. A confirmation after a reported failure is escalated, and the amount is not re-paid while that is open (a duplicate is recovered as a debt marked "duplicate payout", not an earnings reduction). No answer within `payout_confirmation_timeout` (7 days) is escalated, never re-instructed *Trade-off:* A supplier may wait an extra week after a failure, but is never paid twice and never loses earnings. Resolves the conflict between POL-29's "never instructed again" and a failed transfer still being owed. (GB-15)

## POL-23. Bad debt

*Answers D-23 (R-34).*

**Decision.** Share bears buyer credit risk. A supplier's earnings are final once a
charge is posted. Corrections that reduce a charge because of a Share error are borne by
Share in full, from Share's own account, even where they exceed the commission earned on
that charge. Supplier earnings are never reduced for a Share error.

**Why.** Central billing is the supplier proposition: the supplier sells capacity, Share
collects. Under POL-15, the risk is bounded by one coverage window per buyer.

**Amended (round 3).** - Price corrections are allowed in both directions within `dispute_window`,
  with the cause (Share, a supplier, other) and the reason recorded. A price locked at
  booking (POL-27) can only be corrected downwards.
- When a correction is caused by one supplier's error, each share is recomputed by
  splitting the corrected total: the supplier at fault owes its own reduction (as
  supplier debt, POL-22); Share bears every other party's reduction, so no other
  supplier's earnings fall.
- Every cost Share bears (a partner cancellation under POL-28, an equivalent-path price
  difference, an unshown partner fee, carried excess) is paid from Share's own account to
  the supplier concerned, as its own ledger movement.

**Amended (round 4).**
- A downward correction with cause "other" is borne by Share *Trade-off:* Supplier earnings stay final; the cost is bounded by `dispute_window`. (GB-12)

## POL-24. Regulation

*Answers D-24 (R-37).*

**Decision.** Share holds buyer funds through a licensed payment partner (safeguarded
or trust accounts), not on its own balance sheet. Know-your-business checks for
credit-limit accounts; buyer know-your-customer tiers follow the partner's. Funds are
reconciled with the partner daily.

**Requires legal confirmation per market** (in Kenya, the National Payment System Act
regime).

**Amended (round 3).** Daily reconciliation proves: (1) funds held at the partner equal the sum of
positive buyer balances plus supplier amounts owed and not yet paid out; and (2) every
provider transaction in the partner's report matches exactly one ledger top-up, reversal
or payout, and the reverse. Provider settlement reports and bank statements are
reconciled daily under the same rule. Any difference is an operational alert.

**Amended (round 4).**
- The invariant includes Share's own balance at the partner: funds held = positive buyer balances + supplier amounts owed and not paid out + Share's own balance there (commission less costs, write-offs and FX round-ups). That balance is never allowed below zero *Trade-off:* Every micro at the partner is accounted for, at the cost of Share pre-funding its own losses. Without this, the round-3 invariant cannot hold once commission and FX round-ups exist. (GB-19)
- Day D is reconciled by 12:00 UTC on D + 1; one not completed by then is an operational alert *Trade-off:* Defines "a missed reconciliation". (GB-19)

## POL-25. Controls for AI agents

*Answers D-25 (R-39).*

**Decision.** In scope now, owned by P2 (booking) and P4 (money):
- API keys per agent, scoped to an account;
- a spending limit per key per period, enforced at admission as part of headroom.
  Spending is funds held plus charges accrued by bookings the key made in the period;
- a maximum of capacity in flight (Mbps in requests not yet decided) per key and per
  account;
- rate limits per key.

| Parameter | Default |
|---|---|
| `key_spend_limit` | Set per key by the account; none by default |
| Key headroom | min(account headroom, `key_spend_limit` − key spending in the period); shown to that key as its headroom |
| `key_spend_period` | One calendar day, UTC |
| `key_inflight_limit` | Set per key; none by default |
| `account_inflight_limit` | max(`account_inflight_floor`, 10 × the account's largest confirmed reservation), in Mbps |
| `account_inflight_floor` | 1,000 Mbps |
| `key_rate_limit` | 50 requests/s per key |

**Why.** "AI agents" are named buyers; a hard limit is the only control that works
without a human in the loop.

**Amended (round 3).** - An agent key cannot change its own limits, create keys or raise any limit;
  only an account administrator can.
- Revoking a key takes effect within 60 s for new requests. Its pending requests fail
  with the reason "key revoked" and release what they hold; confirmed reservations are
  unaffected.
- **Key spending** in a period = funds held for the key's reservations + charges accrued
  in the period that those holds did not cover. Nothing is counted twice.
- Capacity in flight is counted per request, at its reserved rate.
- Account-level bounds across every key and user:

| Parameter | Default |
|---|---|
| `account_rate_limit` | 200 booking requests/s |
| `account_max_keys` | 100 |
| `key_poll_limit` | 20 status polls/s per key; polls do not count toward booking limits; retries do |

- Concurrent bookings by one account or key are checked against headroom and limits as
  if applied one at a time: their combined effect never exceeds either.

**Amended (round 4).**
- Key spending is cumulative over the period: charges accrued in the period by the key's reservations (covered by a hold or not), plus funds currently held for their future charges, each minute counted once. Replaces round 3 *Trade-off:* The limit bounds a day's spending, as an agent operator expects. Under round 3, short bookings made one after another escaped it entirely. (GA-21, GB-22)

## POL-26. Route deadline

*Answers D-26 (R-42).*

**Decision.** A route request carries a deadline chosen by the buyer, within
`route_deadline_max`. A partner whose holds last less than `route_deadline_max` plus a
commit margin is treated as a partner without holds (POL-28).

| Parameter | Default |
|---|---|
| `route_deadline_default` | 30 s |
| `route_deadline_max` | 60 s |
| `commit_margin` | 10 s |

A request still pending after its deadline plus `commit_margin` is an operational
alert: by design it cannot happen.

**Amended (round 3).** Every outcome exists by the request's deadline. `commit_margin` is reserved
inside the deadline: a request does not begin committing later than deadline −
`commit_margin`. A request still pending at its deadline is an operational alert.
(Replaces "deadline plus `commit_margin`".)

**Amended (round 4).**
- `commit_margin` applies only to requests with a partner leg. `route_deadline_min` = 1 s, so a deadline must be ≥ 1 s, or ≥ 11 s with a partner leg; shorter, zero or negative is invalid *Trade-off:* Fast single-link agents keep short deadlines; nobody can choose a deadline that could never be met. (GA-36)

## POL-27. Price changes

*Answers D-27 (R-44).*

**Decision.** Prices change only on minute boundaries. A booked reservation keeps the
price it was booked at for its life; an open-ended reservation's price may change with
`price_notice`. Best-effort usage prices change with the same notice.

| Parameter | Default |
|---|---|
| `price_notice` | 30 days |

**Why.** A price locked at booking is part of the guarantee, and it removes the
mid-minute and mid-window pricing questions.

## POL-28. Partners without holds

*Answers D-28 (R-46).*

**Decision.** A partner leg that can only be booked immediately and finally is booked
last, after every other leg is held and funds are held. A route may include at most one
such leg. If a later step fails, Share cancels the partner booking and bears its cost.
Commercially, holds are preferred as a listing condition.

**Why.** Booked last, a final-only leg is committed only when everything else is
secured, so the buyer still gets all or nothing; Share bears the cost if it fails after
that point. Two such legs cannot be made all-or-nothing.


## POL-29. Idempotency

*Answers GA-23, GA-24 (requirements gate A).*

**Decision.** Idempotency keys are scoped per account. A reuse of a key by a different
principal of the same account (another agent key or user) is refused, not answered with
the other principal's outcome. A key identifies its request for `idempotency_retention`.
"The same request" means the same route, window, rate, product and `wait` setting; a
reuse with any of these different is refused. Every money-moving input (payment
notifications, transfer confirmations, payout instructions, operator corrections) is
idempotent by its own source reference, under the same rules.

| Parameter | Default |
|---|---|
| `idempotency_retention` | 24 h for booking requests; the 7-year retention (POL-06) for money-moving inputs |

A payout already instructed is never instructed again for the same amounts; a repeated
transfer confirmation has no further effect.

## POL-30. Termination by Share

*Answers GA-09 (requirements gate A).*

**Decision.** Besides the account's own request, POL-07 and POL-16, Share may end a
reservation only for a closed list of reasons: fraud, a sanctions or legal order, or
abuse of the network (for example attack traffic). Notice is given where the law allows;
charges stop at termination; charges already accrued are not refunded. Each termination
records the reason and the operator.


## POL-31. Reserved rate precision

*Answers GA-36 (requirements gate A), decided in round 4.*

**Decision.** A reserved rate is a whole number of Mbps, at least `rate_min` = 1 Mbps; zero, negative and fractional rates are invalid

| Parameter | Default |
|---|---|
| `rate_min` | 1 Mbps |

**Why.** Simple to sell, price and check; demand below 1 Mbps is served by best-effort products.

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
