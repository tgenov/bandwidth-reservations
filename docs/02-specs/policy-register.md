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
one leg. A request that fits only if an in-progress request fails waits up to
`ack_budget`; then it is rejected with a `retry_after` equal to the in-flight request's
remaining deadline.

**Why.** Two authorities over one schedule cannot both guarantee "never oversell". A
uniform model gives single links and routes the same priority rule (POL-02).

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
| Durability (RPO) | 0 for reservations, the ledger, payment events and accepted usage records |
| Recovery (RTO) | 5 min for admission; 15 min for billing and wallet |
| Retention | Ledger, payment events, reservation history and raw usage: 7 years |

**Why.** These adopt the company profile's figures (99.99%, ×50) and the assumed
current load. Seven years covers the record-retention rules common across the planned
markets; legal must confirm it per market (POL-24).

## POL-07. Loss of supply: never revoke silently

*Answers D-07 (R-11).*

**Decision.**
- When a link's capacity falls, new sales on it stop at once at the reduced capacity.
- **Unplanned outage:** confirmed reservations are not revoked; they are flagged as
  affected and SLA credits apply automatically (Problem 6).
- **Planned maintenance** must be booked by the supplier as a reservation against the
  link, at least `maintenance_notice` ahead, so it can only take capacity that is free.
- **Permanent reduction** (supplier exit, contract end): affected reservations are
  re-routed if an equivalent path exists; otherwise revoked newest first, with
  `revocation_notice` and no charge for the remaining period.

| Parameter | Default |
|---|---|
| `maintenance_notice` | 10 business days |
| `revocation_notice` | 30 days |

**Why.** The guarantee is the product; the 2000-era exchanges failed by selling what
could not be delivered. Pro-rata degradation breaks every buyer's guarantee to spare
one.

## POL-08. Changing a reservation

*Answers D-08 (R-12).*

| Change | Rule |
|---|---|
| Cancel | Any time; takes effect at the next minute boundary; charges stop then |
| Shorten | Any time, as a cancellation of the remaining part |
| Extend, or increase the rate | A new admission of the difference only; the existing part is never at risk |
| Decrease the rate | Any time, from the next minute boundary |
| Renew | An extension |
| Part of a route | Not allowed; a route is one unit. Cancel and book again |

A partner leg may impose a minimum term or cancellation fee; it is shown in the price at
booking time and charged on cancellation. Share absorbs partner fees it did not show.

**Why.** No term is the product's main promise. Admitting only the difference keeps
modifications as safe as new bookings.

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

## POL-13. Flows that span several minutes

*Answers D-13 (R-19).*

**Decision.** Exporters must cut flows at minute boundaries (active timeout ≤
`flow_active_timeout`), so a record's bytes belong to one minute. A record that still
spans several minutes is spread evenly across the minutes it was active, each at its own
price.

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

## POL-16. Suspension and resumption

*Answers D-16 (R-22).*

**Decision.** An account is suspended when the coverage hold cannot roll forward (or a
credit limit would be exceeded). While suspended: no new bookings; existing reservations
keep their capacity for `suspension_grace` and keep accruing charges against the hold
already taken; usage-priced traffic is blocked at the edge. If funds arrive within the
grace period, the account resumes automatically. After it, the reservations are released
and the buyer is told.

| Parameter | Default |
|---|---|
| `suspension_grace` | Equal to `coverage_window` (24 h), so the grace is always funded |

**Why.** A grace period funded by the existing hold costs Share nothing. Automatic
resumption suits self-serve and agent buyers.

## POL-17. Traffic that does not match a reservation

*Answers D-17 (R-24).*

**Decision.** Every usage record is kept.
- Traffic above the reserved rate is policed at the edge. Where the product permits
  burst, it is carried best effort on capacity that is otherwise idle, and billed at
  `usage_price`.
- Traffic attributable to the account but outside an active reservation is billed at
  `usage_price` and counts toward exposure.
- Traffic that cannot be attributed is quarantined, not billed, and reported to
  operations and the supplier. The supplier is paid for it only if it is attributed
  within `dispute_window`.

| Parameter | Default |
|---|---|
| `dispute_window` | 30 days |

**Why.** Without oversubscription, burst may only use capacity no one reserved.

## POL-18. The balance a buyer sees

*Answers D-18 (R-27).*

**Decision.** The headline figure is **available headroom**: balance minus held funds
(plus any credit limit). The response itemises the ledger balance, held funds, charges
accrued but not yet posted, and an estimate of unposted usage.

**Why.** Agents decide on headroom; finance reconciles on the itemised figures.

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

## POL-21. Reversals, refunds and credits

*Answers D-21 (R-32).*

| Item | Decision | Scope |
|---|---|---|
| Reversal (chargeback) after the top-up was spent | Applied at once; the account is suspended if headroom goes negative (POL-16); collected from the next top-up; written off after 90 days | Now |
| Reversal arriving before its completion | Held pending, matched by provider reference, for up to 72 h; then applied | Now |
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

## POL-23. Bad debt

*Answers D-23 (R-34).*

**Decision.** Share bears buyer credit risk. A supplier's earnings are final once a
charge is posted. Corrections that reduce a charge because of a Share error come out of
Share's commission, not supplier earnings.

**Why.** Central billing is the supplier proposition: the supplier sells capacity, Share
collects. Under POL-15, the risk is bounded by one coverage window per buyer.

## POL-24. Regulation

*Answers D-24 (R-37).*

**Decision.** Share holds buyer funds through a licensed payment partner (safeguarded
or trust accounts), not on its own balance sheet. Know-your-business checks for
credit-limit accounts; buyer know-your-customer tiers follow the partner's. Funds are
reconciled with the partner daily.

**Requires legal confirmation per market** (in Kenya, the National Payment System Act
regime).

## POL-25. Controls for AI agents

*Answers D-25 (R-39).*

**Decision.** In scope now, owned by P2 (booking) and P4 (money):
- API keys per agent, scoped to an account;
- a spending limit per key per period, enforced at admission as part of headroom;
- a maximum of capacity in flight per key and per account;
- rate limits per key.

**Why.** "AI agents" are named buyers; a hard limit is the only control that works
without a human in the loop.

## POL-26. Route deadline

*Answers D-26 (R-42).*

**Decision.** A route request carries a deadline chosen by the buyer, within
`route_deadline_max`. A partner whose holds last less than `route_deadline_max` plus a
commit margin is treated as a partner without holds (POL-28).

| Parameter | Default |
|---|---|
| `route_deadline_default` | 30 s |
| `route_deadline_max` | 60 s |

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
