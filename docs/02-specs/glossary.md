# Glossary

The terms used in the problem statements (`01-discovery/`), the specs (`02-specs/`) and
the [policy register](policy-register.md). Every requirement uses a term only in the sense
given here. Where an older document used a different word, the word it replaces is shown
as *replaces …*.

## Conventions for units and time

| Quantity | Convention |
|---|---|
| Rate | Mbps (10⁶ bits per second). Gbps is written only in prose, as 1 Gbps = 1,000 Mbps. |
| Volume of traffic | GB = 10⁹ bytes. |
| Money | An amount always carries its currency, for example `12.50 USD`. Exact amounts are given in **micros** where precision matters: `1 USD = 1,000,000 micro-USD`. |
| Time of day | `HH:MM` or `HH:MM:SS` in UTC on one calendar day, unless a scenario says otherwise. |
| Window | Half-open: `[10:00, 11:00)` includes 10:00 and excludes 11:00. |
| Durations | Written with their unit (`30 s`, `24 h`, `12 months`). |

## People and parties

| Term | Meaning |
|---|---|
| **Account** | The entity that pays or is paid: a buyer account or a supplier account. Reservations, booking requests, the wallet, agent keys and statements belong to an account. *Replaces "customer" where the paying entity is meant.* |
| **Buyer** | A person, an enterprise or an AI agent acting for a buyer account. *Replaces "client" and "customer" where the person or agent is meant.* |
| **Agent key** | A credential an account issues to an AI agent or other automated client. It acts only for that account, and carries its own `key_spend_limit` per `key_spend_period`, `key_inflight_limit` and `key_rate_limit` (POL-25). |
| **Key spending** | Funds held plus charges accrued by the bookings an agent key made in the current `key_spend_period` (POL-25). |
| **Key headroom** | The headroom shown to and enforced for an agent key: the lower of the account's headroom and `key_spend_limit` less key spending (POL-25). |
| **Agent operator** | The person at a buyer account who issues agent keys and sets their limits. |
| **Principal** | Whoever performs an operation, once authenticated: an account user, an agent key, a supplier user, an operator or an internal service. |
| **Operator** | A member of Share's staff acting under a role (support, network operations, finance). |
| **Supplier** | An infrastructure provider whose links are sold through the marketplace and who is paid a share of the charges for them. |
| **Partner** | A supplier whose link's schedule is kept in the partner's own system, not Share's. A link of this kind is a **partner link**; a link whose schedule Share keeps is a **Share link**. |
| **Partner without holds** | A partner that can only book immediately and finally, and cannot set capacity aside for a time first. A partner whose holds last less than `route_deadline_max` plus `commit_margin` is treated as one (POL-26, POL-28). |
| **Payment provider** | The service a buyer pays through (M-Pesa, Stripe, Adyen and similar). It notifies the marketplace of payments by **payment notification**. |
| **Payment partner** | The licensed institution that holds buyer funds for Share (POL-24). |
| **Network operations** | The team and systems that act on the network: police traffic, block it at the edge, provision connections. |

## Capacity and booking

| Term | Meaning |
|---|---|
| **Link** | A connection with a fixed **capacity** in Mbps that is sold in slices. |
| **Schedule** | Everything that occupies a link's capacity, minute by minute: confirmed reservations and capacity holds. |
| **Schedule owner** | The single authority that decides every booking on a link, single-link or route (POL-05). There is exactly one at a time per link. |
| **Route** | One or more links, in order, booked for the same window at the same reserved rate, as one unit. A booking on a single link is a route of one leg (POL-05). |
| **Leg** | One link of a route. |
| **Reservation** | A confirmed right to carry traffic up to a reserved rate on every leg of a route during a window. A reservation is created, changed and ended as one unit (POL-08). |
| **Reserved rate** | The rate, in Mbps, that a reservation guarantees. *Replaces "usage" when used of reserved capacity.* |
| **Committed rate** | On one link at one minute: the sum of the reserved rates of the confirmed reservations on it. |
| **Peak** | The highest committed rate, or committed rate plus capacity held, at any minute of a window. |
| **Booking request** | A buyer's request to create or change a reservation. It carries an idempotency key and a deadline, and ends with exactly one outcome. |
| **Outcome** | What a booking request ends as: **confirmed** (every leg secured; the reservation exists), **rejected** (it does not fit, or funds or limits do not allow it; the rejection is a counter-offer), **invalid** (the request itself is malformed; it is neither confirmed nor rejected), or **failed** (it could not be completed for another reason, such as its deadline passing; it holds nothing). Until it has an outcome, a request is **pending**. *Replaces "admitted", "allowed", "refused", "fails as an invalid window".* |
| **Capacity hold** | Capacity set aside on a link for a pending booking request. It counts against the link's capacity, and lasts no longer than the request's deadline. **Capacity in flight** is the Mbps in requests not yet decided, limited per key and per account by `key_inflight_limit` and `account_inflight_limit`, the latter never below `account_inflight_floor` (POL-25). *Replaces "hold" where it meant capacity.* |
| **Funds hold** | Money in a wallet set aside, not charged, to cover a reservation's charges for the coverage window (POL-15). It reduces headroom, not the ledger balance. |
| **Coverage window** | The period of future charges that a funds hold covers: `coverage_window` (POL-15), or the whole reservation if shorter. The hold rolls forward as charges accrue. |
| **Deadline** | The time by which a booking request must have its outcome. Chosen per request, within `route_deadline_max` (POL-26). A request still pending after its deadline plus `commit_margin` raises an operational alert. |
| **Waiting** | A request that fits only if a request in flight ends without confirmation waits, pending, within its own deadline (POL-05). A buyer can ask not to wait (`wait = false`) and is then rejected at once with `retry_after`. |
| **`ack_budget`** | The time within which every booking request receives a response, final or pending (POL-04). |
| **`retry_after`** | In the immediate rejection of a request that asked not to wait (`wait = false`) and needs capacity held for another request in flight: that request's remaining deadline, after which the capacity is either confirmed or released (POL-05). |
| **Counter-offer** | The content of a rejection that tells the buyer what they can get instead (POL-10). |
| **Idempotency key** | A key the buyer chooses for a booking request. Requests from the same account with the same key are the same request. Keys are scoped to the account. |
| **Window** | The period a reservation covers, `[start, end)`, at minute resolution, or `[start, open)` for an **open-ended** reservation that lasts until cancelled. |
| **Minute boundary** | The start of a whole minute (`HH:MM:00`). |
| **Selling horizon** | How far ahead the marketplace sells: a rolling `selling_horizon` from now (POL-09). *Replaces "horizon" and "booking horizon".* |
| **Affected reservation** | A confirmed reservation on a link whose capacity has fallen below what is committed on it (POL-07). |
| **Revocation** | Ending a confirmed reservation by Share's decision. It happens only under POL-07 (permanent reduction, when no equivalent path is accepted) or POL-16 (release at the end of suspension grace, a termination for non-payment). |
| **Equivalent path** | On a permanent reduction, the path offered to an affected buyer: the same endpoints and rate, latency and SLA class no worse, at the original price; the buyer may decline (POL-07). |
| **Planned maintenance booking** | A supplier's reservation against its own link that takes the capacity it will need for planned works (POL-07). |
| **Known-at history** | The record that answers "what was known to be reserved on this link at time T", for any past T (POL-19). |

## Pricing, metering and charges

| Term | Meaning |
|---|---|
| **Product** | What is sold on a route. A **guaranteed product** is priced per reservation; a **best-effort product** (IP transit, CDN traffic) is priced per GB. A guaranteed product may **permit burst**. |
| **Mbps-minute** | One Mbps reserved for one minute. The unit of reservation pricing (POL-01). |
| **Reservation price** | `reservation_price` (POL-01): the price per Mbps-minute of a guaranteed product on a route. A reservation keeps the price it was booked at (POL-27). |
| **Usage price** | `usage_price` (POL-01): the price per GB of traffic on a best-effort product, and of permitted burst. |
| **Accrual** | A reservation's charge for one minute: reserved rate × reservation price, whether or not traffic crosses it. |
| **Traffic** | The bytes actually carried. *Replaces "usage" when used of bytes.* |
| **Usage-priced traffic** | Traffic billed per GB: on best-effort products, burst, and traffic attributable to an account outside an active reservation (POL-17). |
| **Burst** | Traffic above a reservation's reserved rate, on a product that permits it, carried best effort on otherwise idle capacity (POL-17). |
| **Flow record** | A report from the network of the bytes one flow carried between a start time and an end time. |
| **Exporter** | The network device that produces flow records. Each record is identified by its exporter and a sequence number. |
| **Lateness** | How long after the end of the minute it belongs to a flow record arrives. `max_lateness` (POL-14) is the lateness the exposure bound assumes. |
| **Quarantine** | Where traffic that cannot be attributed to an account is kept, unbilled, for attribution within `dispute_window` (POL-17). |
| **Rating** | Turning accruals and traffic into charges. |
| **Charge** | An amount owed by a buyer account for one reservation-minute, or for an account's usage-priced traffic in one minute. Computed exactly and rounded once, down to the micro (POL-11). |
| **Amendment** | A separate, visible change to a charge that has already been made, with its reason. Late traffic only ever increases a charge; a price correction can move it either way. |
| **Price correction** | An authorised change to a price that was set wrongly, applied to the minutes it affected through amendments. |
| **Usage exposure** | The estimate of usage-priced traffic carried but not yet posted, plus the bound for traffic that may still arrive within `max_lateness` (POL-18, POL-14). It is deducted from headroom for every account. *Replaces "exposure".* |

## Money

| Term | Meaning |
|---|---|
| **Micros** | Integer millionths (10⁻⁶) of a currency's major unit, always tagged with the currency (POL-11). |
| **Wallet** | A buyer account's prepaid money, held through the payment partner. |
| **Top-up** | A payment into a wallet. |
| **Reversal** | The payment provider taking back a top-up (a chargeback) (POL-21). A reversal whose payment never arrives within 72 h is escalated, never applied. |
| **Ledger** | The record of every money movement. |
| **Money movement** | A set of entries, all in one currency, that moves money between accounts and sums to zero. *Replaces "journal".* |
| **Ledger balance** | The sum of an account's ledger entries. |
| **Headroom** | Available headroom (POL-18): ledger balance minus funds held minus usage exposure, plus any credit limit. The headline figure a buyer sees, and the one rule that governs admission and suspension for every account. The buyer is warned when it falls below `low_balance_warning` (POL-16). |
| **Credit limit** | `credit_limit` (POL-15): an amount a vetted account may owe; such an account is settled by monthly invoice instead of funds holds. |
| **Standing** | Whether an account is **active** or **suspended**. |
| **Suspension** | The standing of an account whose headroom would fall below zero: its funds hold cannot roll forward, or its usage exposure exceeds what is left (POL-16). Lasts at most `suspension_grace` before its reservations are released. |
| **Commission** | Share's share of each charge. |
| **Split** | Dividing a charge among the parties on its route (suppliers and Share's commission) by their **weights**, under the published apportionment rule and tie order (POL-12). |
| **Payout** | Paying a supplier what it is owed. Complete only when the transfer is confirmed (POL-22). |
| **Supplier debt** | An amount a supplier owes back, arising only from a supplier-caused error (POL-22, POL-23); Share bears its own errors in full. It is netted against later payouts. |
| **Statement** | What an account can see of its own money: for a buyer, charges, amendments and their reasons; for a supplier, each share and the rule and weights that produced it. |
