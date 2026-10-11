# P4. Wallet, funds holds, ledger and supplier settlement

## Context

Buyers pay with no term commitment and no setup fee. Money enters through a prepaid
wallet that the buyer tops up with a mobile-money or card payment (M-Pesa, Stripe, Adyen
and similar), held for Share by a licensed payment partner (POL-24). The payment provider
tells the marketplace about each payment asynchronously, by payment notification. Prices,
wallets and the ledger are in USD; a top-up in another currency is converted at top-up at
a rate shown to the buyer (POL-20).

A guaranteed reservation is priced per Mbps-minute reserved (POL-01), so its charges are
known at admission. "No upfront payment" means no pre-purchase of the whole term
(POL-15): admission instead requires funds for a rolling **coverage window** of the
reservation's charges. Those funds are **held** in the wallet, not charged; charges then
accrue minute by minute against them, and the hold rolls forward. Vetted accounts may
instead have a credit limit, settled by monthly invoice. One headroom rule applies to every
account, prepaid or credit-limit: headroom is the balance minus funds held minus usage
exposure, plus any credit limit (POL-18). When headroom would fall below zero, because the
hold cannot roll forward or usage exposure exceeds what is left, the account is suspended, keeps its reservations for a grace period funded by
the hold already taken, and resumes automatically if funds arrive (POL-16).

Charges come from [P3](P3-rating-and-metering.md), one per reservation-minute and per
account's usage-priced traffic in a minute, with amendments. Every charge is owed onward
to the suppliers whose links make up the route, with Share keeping a commission. A route
such as Nairobi → Mombasa → Marseille can cross three or more suppliers' links, so one
charge has several payees. Suppliers are promised central billing and weekly automated
payouts (POL-22), and their earnings are final once a charge is posted: Share bears buyer
credit risk (POL-23). That makes the marketplace the party that holds buyers' money, owes
suppliers theirs, and has to show at any moment who is owed what and why.

## Who is affected

| Who | What they need |
|---|---|
| Buyer (people, enterprises, AI agents) | A top-up credited exactly once and quickly; a headline figure they can spend against; to know before they are suspended, and to be resumed without asking. |
| Agent operator | Spending limits per agent key (`key_spend_limit` per `key_spend_period`, POL-25) that the marketplace enforces. |
| Supplier | Their share of every charge, by a published rule they can check, paid out weekly; earnings not taken back except for their own errors, with a reason they can see. |
| Marketplace finance | Books that balance at all times, a history that cannot be rewritten, daily reconciliation with the payment partner, and known worst-case losses. |
| Compliance | Buyer funds held through a licensed partner; records kept for the retention period. |
| Network operations | Told reliably when an account's standing changes, so usage-priced traffic can be blocked or unblocked at the edge. |
| Support | Explain a balance, a hold, a suspension or a reversal to a buyer. |
| Booking (P2) | Whether the account's headroom covers a new funds hold, answered within the booking's `ack_budget`. |

## The problem

Payment notifications are delivered more than once, out of order (a reversal before the
payment it reverses) and late. Every money movement takes money from one account and gives
it to others, and if a movement can be half-written or edited afterwards the books stop
adding up. A charge is a whole number of micros divided among several parties in fixed
proportions; the parts must add up exactly, so some are rounded up and others down, and
late traffic raises a minute's total after it was first split. Funds held for reservations
must stay consistent with the charges accruing against them as reservations start, change
and end. A buyer can spend a top-up that is later reversed. And a supplier's balance must
depend only on the traffic, the prices and the weights, never on when the records arrived.

## Needs

Scenarios in [`02-specs/P4-wallet-and-settlement.feature`](../02-specs/P4-wallet-and-settlement.feature)
cite the need they serve with a tag `@need-P4-Nn`.

| ID | Need | Success measure |
|---|---|---|
| P4-N1 | **A top-up changes the wallet exactly once**, however many times and in whatever order its notifications arrive. A redelivery with different contents moves no money and is reported. A malformed notification moves no money. | Each provider transaction changes the wallet once; no malformed or conflicting notification moves money. |
| P4-N2 | **Top-ups convert at the shown rate** (POL-20, POL-11). A top-up in another currency is credited in USD at the payment partner's rate shown to the buyer before they confirmed, converted exactly. | Every converted top-up credited at the rate shown, exactly. |
| P4-N3 | **Funds are held for the coverage window** (POL-15). Confirming a reservation holds funds for `coverage_window` of its charges, or the whole reservation if shorter; charges accrue against the hold and the hold rolls forward; unused holds are released when a reservation ends or changes. A credit-limit account is not held but counted against its limit. | At every moment, each prepaid account's funds held equal the coverage still required by its reservations. |
| P4-N4 | **The buyer sees available headroom, itemised** (POL-18). The headline is ledger balance minus funds held minus usage exposure, plus any credit limit; the same headroom governs admission and suspension for every account; the answer itemises the ledger balance, funds held, charges accrued but not yet posted, and an estimate of unposted usage. The ledger balance shown equals the ledger. | Every balance answer is consistent with the ledger and the holds. |
| P4-N5 | **Suspension is predictable and reversible** (POL-16, POL-14). An account, prepaid or credit-limit, is suspended when its headroom would fall below zero: its hold cannot roll forward, or its usage exposure exceeds what is left. While suspended it cannot book, its reservations keep their capacity and accrue for `suspension_grace`, and its usage-priced traffic is blocked. Funds within the grace resume it automatically; after it, its reservations are released and it is told. The buyer is warned when headroom falls below `low_balance_warning`. | No suspension without the stated cause; every account resumed or released by the end of its grace. |
| P4-N6 | **Network operations always knows an account's standing.** Each change of standing is notified at least once; repeats change nothing; the current standing can be asked for at any time. | No standing change unnotified; enforcement within the X2 target, with lateness reported. |
| P4-N7 | **Money is conserved and history is fixed.** Every money movement sums to zero, and so does the ledger; no movement can be altered or removed by anyone, operators included; corrections are new movements; every amount carries its currency. | Ledger sums to zero at every moment; zero altered or removed movements. |
| P4-N8 | **Each charge is split exactly and fairly** (POL-12). Shares sum exactly to the charge; no party's share falls when a minute's total grows; the split depends only on the amount and the weights; the rule is Webster with Share's commission losing every tie; the rule and tie order are published; cumulative deviation from exact proportions is reported per party per payout period. | Every split exact, monotone, deterministic and by the published rule. |
| P4-N9 | **Late charges settle like on-time ones.** A supplier's balance depends only on the traffic, the prices and the weights, not on the order or timing in which records arrived; a late-traffic amendment never reduces any party's amount or credits the buyer. | Identical balances for any arrival order and timing. |
| P4-N10 | **Suppliers can check what they are owed.** A supplier can see, for any period, each charge's share and the rule and weights that produced it. | Every share on a statement can be recomputed from what the statement shows. |
| P4-N11 | **Supplier earnings are final** (POL-23, POL-22). A correction caused by Share's error is borne by Share in full, from its own account, even beyond the commission on that charge; only a supplier-caused error creates a supplier debt, netted against later payouts with its reason visible. | No supplier balance reduced except by a supplier-caused error, with its reason. |
| P4-N12 | **Payouts are weekly, exact and once** (POL-22, POL-11, POL-20). A supplier owed at least `payout_minimum` is paid weekly in USD (or converted at the shown rate); smaller balances carry forward; a payout is complete only when the transfer is confirmed; a repeated or retried payout run pays at most once; rounding residues stay with the payee. | Zero double payouts; cumulative payouts equal cumulative earnings less residues still carried. |
| P4-N13 | **Reversals and bad debt are handled by rule** (POL-21, POL-23). A reversal after the top-up was spent is applied at once, suspends the account if headroom goes negative, is collected from the next top-up and is written off after 90 days at Share's cost. A reversal arriving before its payment is held pending for up to 72 h, matched by provider reference; if its payment never arrives it is escalated to operations for reconciliation with the payment partner, never applied. | Every reversal ends matched, collected, written off or escalated by its rule; no write-off charged to a supplier. |
| P4-N14 | **The books reconcile with the money** (POL-24). The ledger is reconciled with the payment partner daily, and differences are reported for resolution. | Every daily reconciliation completed, with every difference reported. |

Latency of crediting a top-up and of enforcement, availability and retention are owned by
[X2](X2-non-functional-targets.md). Authenticity of payment notifications, who may see which
balances and statements, and audit of operator actions are owned by
[X1](X1-security-and-tenancy.md).

## Constraints and assumptions

"Confirmed" means stated in a primary source: the job listing or the business statement
made in the mock interview. "Decided" means set in the [policy register](../02-specs/policy-register.md).

| Constraint or assumption | Status |
|---|---|
| Payment notifications are delivered at least once, possibly repeated, reordered or late. | *Assumed* (the company profile cites an earlier listing: "asynchronous M-Pesa webhooks that can repeat") |
| Each provider notification carries a transaction reference that is unique for that provider. | *Assumed* |
| The marketplace keeps a double-entry ledger. | *Assumed* (secondary source: the company profile's reading of an earlier listing) |
| Suppliers expect central billing and automated payouts. | *Confirmed* (company profile, from Share's website) |
| Prices, wallets and the ledger are in USD; every amount is tagged with its currency so more can be added. | *Decided* (POL-20) |
| Amounts are integers in micros; charges are rounded once, down; payout residues stay with the payee. | *Decided* (POL-11) |
| Funds are held for `coverage_window` (24 h) at admission; vetted accounts may have a `credit_limit` instead. | *Decided* (POL-15) |
| Suspension when headroom (including usage exposure) would fall below zero, for every account; warning below `low_balance_warning`; reservations kept for `suspension_grace` (equal to `coverage_window`), then released, which is intended; resumption is automatic. | *Decided* (POL-16, POL-18) |
| The split is Webster (Sainte-Laguë), Share's commission losing ties; the rule is published. | *Decided* (POL-12) |
| Each charge is divided by fixed weights per route and party; how the weights are set is pricing policy. | *Assumed* |
| Late traffic can only increase a minute's charge; decreases come only from price corrections. | *Inferred* from P3 (duplicates are removed by record ID) |
| Share bears buyer credit risk and its own errors in full; supplier earnings are final once a charge is posted. | *Decided* (POL-23) |
| Buyer funds are held through a licensed payment partner, reconciled daily. | *Decided* (POL-24), pending legal confirmation per market |
| Money is never represented as a floating-point number. | *Assumed* |

## Out of scope

- Rating: turning reservations, records and prices into charges and amendments
  ([P3](P3-rating-and-metering.md)). This problem starts from a charge.
- How split weights are chosen (by link price, distance or contract). Pricing policy.
- Moving money to suppliers' bank or mobile-money accounts (treasury), and supplier
  onboarding and KYB. This problem issues payouts and records their confirmation.
- Buyer KYC tiers: they follow the payment partner's (POL-24).
- **Withdrawal of unused balance** (POL-21: later). Requirement recorded for when it is
  brought in: on request, to the original payment method, net of provider fees.
- **SLA credits** (POL-21: later, with Problem 6). Requirement recorded: paid into the wallet
  as service credit, not withdrawable.
- Subscription lifecycle and renewals as a separate product: under POL-08 a renewal is an
  extension ([P2](P2-route-reservation.md)).
- Acting on the network to block traffic: network operations acts on the standing this
  problem announces.

## Open questions

Answered by the policy register and removed: currencies and FX risk (POL-20); smallest unit
and conversion (POL-11); payout frequency, minimum and clawback (POL-22); resumption after
top-up (POL-16); bad debt (POL-23); regulation (POL-24, pending legal confirmation); the
warning threshold (POL-16: `low_balance_warning`); spending by agent key (POL-25: funds held
plus charges accrued by the key's bookings in `key_spend_period`); usage exposure on prepaid
accounts (POL-16, POL-18: one headroom rule for all accounts); orphan reversals (POL-21:
escalated, never applied); Share-error corrections beyond the commission (POL-23: borne by
Share in full).

1. **Authentication per provider.** How each payment provider proves a notification is
   authentic (signature scheme, mutual TLS, callback verification) is for the interface
   contract; X1 requires only that unproven notifications move no money.
2. **Zero-amount notifications.** Do any providers send zero-amount notifications (for
   example verification pings)? The spec rejects any amount that is not positive.
3. **Reconciliation with providers other than the partner.** POL-24 reconciles daily with the
   payment partner. Are provider settlement reports (M-Pesa, Stripe) and bank statements
   also reconciled, and who resolves mismatches?
4. **Headroom of an agent key.** POL-25 enforces the key's spending limit "as part of
   headroom". When a key has both a `key_spend_limit` and its account has headroom, the spec
   refuses a booking that exceeds either; whether the key's remaining limit is also shown as
   that key's headroom (POL-18) is not stated.
