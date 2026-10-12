# P4. Wallet, funds holds, ledger and supplier settlement

## Context

Buyers pay with no term commitment and no setup fee. Money enters through a prepaid
wallet that the buyer tops up with a mobile-money or card payment (M-Pesa, Stripe, Adyen
and similar), held for Share by a licensed payment partner (POL-24). The payment provider
tells the marketplace about each payment asynchronously, by payment notification. Prices,
wallets and the ledger are in USD; a top-up in another currency is converted at top-up at
a rate shown to the buyer, rounded up to the micro (POL-20).

A guaranteed reservation is priced per Mbps-minute reserved (POL-01), so its charges are
known at admission. "No upfront payment" means no pre-purchase of the whole term
(POL-15): admission instead requires funds for a rolling **coverage window** of the
reservation's charges (or a partner cancellation fee, if larger, while that fee could
still be charged). Those funds are **held**
in the wallet, not charged; charges then accrue minute by minute against them, and the
hold rolls forward. A reservation that starts in the future has its first window held at
admission. Vetted accounts may instead have a credit limit: they take **credit holds** of
the same size, and are invoiced monthly. One headroom rule applies to every account,
prepaid or credit-limit: headroom is the balance minus funds held (credit holds included)
minus usage exposure, plus any credit limit (POL-18). When headroom would fall below zero,
because the hold cannot roll forward or usage exposure exceeds what is left, or when an
invoice is unpaid after its terms, the account is suspended, keeps its reservations for a
grace period funded by the hold already taken, and resumes automatically if enough funds
arrive (POL-16); an account suspended for an overdue invoice resumes only once every
overdue invoice is paid.

Charges come from [P3](P3-rating-and-metering.md), one per charge line (POL-11: one
reservation for one minute, one account and product on one route for one minute of
usage-priced traffic, or one cancellation fee for one reservation), with amendments. Every charge is owed onward to the suppliers whose
links make up its route, with Share keeping a commission. A route such as
Nairobi → Mombasa → Marseille can cross three or more suppliers' links, so one charge has
several payees. Suppliers are promised central billing and weekly automated payouts
(POL-22), and their earnings are final once a charge is posted: Share bears buyer credit
risk and every cost it causes (POL-23). That makes the marketplace the party that holds
buyers' money, owes suppliers theirs, and has to show at any moment who is owed what and
why.

## Who is affected

| Who | What they need |
|---|---|
| Buyer (people, enterprises, AI agents) | A top-up credited exactly once and quickly; a headline figure they can spend against; to know before they are suspended, and how much resumes them; to be resumed without asking. |
| Agent operator | Spending limits per agent key (`key_spend_limit` per `key_spend_period`, POL-25) that the marketplace enforces. |
| Supplier | Their share of every charge, by a published rule they can check, paid out weekly, never instructed twice (a transfer the provider executes twice is recovered, not taken from earnings) and never lost; earnings not taken back except for their own errors, with a reason they can see. |
| Marketplace finance | Books that balance at all times, a history that cannot be rewritten, daily reconciliation with the payment partner, providers and banks, and known worst-case losses. |
| Compliance | Buyer funds held through a licensed partner; credit only for vetted accounts; records kept for the retention period. |
| Network operations | Told reliably when an account's standing changes, so usage-priced traffic can be blocked or unblocked at the edge. |
| Support | Explain a balance, a hold, a suspension or a reversal to a buyer. |
| Booking (P2) | Whether the account's headroom covers a new hold, answered within the booking's `ack_budget`. |

## The problem

Payment notifications are delivered more than once, out of order (a reversal before the
payment it reverses) and late. Every money movement takes money from one account and gives
it to others, and if a movement can be half-written or edited afterwards the books stop
adding up. A charge is a whole number of micros divided among several parties in fixed
proportions; the parts must add up exactly, so some are rounded up and others down, and
late traffic raises a minute's total after it was first split. Funds held for reservations
must stay consistent with the charges accruing against them as reservations start, change
and end, and with many agents of one account booking at once. A buyer can spend a top-up
that is later reversed. Payouts are in flight for days, and transfer confirmations repeat
or contradict failures. And a supplier's balance must depend only on the traffic, the
prices and the weights, never on when the records arrived.

## Needs

Scenarios in [`02-specs/P4-wallet-and-settlement.feature`](../02-specs/P4-wallet-and-settlement.feature)
cite the need they serve with a tag `@need-P4-Nn`.

| ID | Need | Success measure |
|---|---|---|
| P4-N1 | **A top-up changes the wallet exactly once**, however many times and in whatever order its notifications arrive, for the 7-year retention (POL-29). A redelivery with different contents moves no money and is reported. A malformed notification moves no money. | Each provider transaction changes the wallet once; no malformed or conflicting notification moves money. |
| P4-N2 | **Top-ups convert at the shown rate** (POL-20, POL-11). A top-up in another currency is credited in USD at the payment partner's rate shown to the buyer before they confirmed, rounded up to the micro; a payment arriving after `fx_quote_validity` is credited at the partner's rate at notification, which the statement shows. | Every converted top-up credited at the rate that applies, rounded up to the micro. |
| P4-N3 | **Funds are held for the coverage window** (POL-15, POL-08). Confirming a reservation holds funds for `coverage_window` of its charges, or the whole reservation if shorter, or a partner cancellation fee if larger, but only while the fee could still be charged (after the minimum term the hold is the coverage, POL-15); a future reservation's first window is held from admission until it starts; charges accrue against the hold and the hold rolls forward, except while the account is suspended; the hold follows every change (it grows with an added part, shrinks with a decrease, a cut under POL-07 or a shortening, and is resized with a price change; a price change takes effect even when the larger hold cannot be covered, and the account is then suspended as for a failed roll-forward, POL-27) and is released when a reservation ends, is revoked, released or terminated: from the minute it ends nothing is held for its later charges, and its unposted earlier charges and any fee due stay held until posted (POL-15). A credit-limit account takes a credit hold of the same size, counted as funds held. Concurrent bookings and changes by one account or key are checked one at a time, in the order received, each counting the holds then in place; a request refused because of a hold that is later released stays refused (POL-25). | At every moment, each account's holds equal the coverage still required by its reservations, and never together exceed what its headroom allowed. |
| P4-N4 | **The buyer sees available headroom, itemised** (POL-18). The headline is ledger balance minus funds held minus usage exposure, plus any credit limit; the same headroom governs admission and suspension for every account; an agent key sees its own headroom, the lower of the account's headroom and its `key_spend_limit` less its spending in the period, counted cumulatively (POL-25); a negative key headroom blocks new bookings and additions by that key only, and never ends, suspends or reduces a reservation (POL-25); the answer itemises the ledger balance, funds held, usage exposure in its two parts (unposted usage; the lateness bound), and, for information, charges accrued but not yet posted (within funds held). The ledger balance shown equals the ledger. | Every balance answer is consistent with the ledger and the holds, and its items add up to the headline. |
| P4-N5 | **Suspension is predictable and reversible** (POL-16, POL-14, POL-15). An account is suspended when its headroom would fall below zero (its hold cannot roll forward, or its usage exposure exceeds what is left) or, for a credit-limit account, when an invoice is unpaid after `invoice_terms`. While suspended it cannot book, its reservations keep their capacity and accrue for `suspension_grace`, even when a reversal has left the hold unfunded, and its usage-priced traffic is blocked. A top-up of at least the resume amount (full holds restored and headroom at least `low_balance_warning`) resumes it automatically; an account suspended for an overdue invoice resumes only when every overdue invoice is paid and that headroom rule also holds (POL-16), a top-up paying its overdue invoices first, oldest first (POL-15); an account with a written-off amount still owed stays suspended until a top-up repays it (POL-21); after the grace its reservations are released and it is told; a shown cancellation fee is then charged against what is left of the hold, any shortfall becoming a negative balance (POL-15). The buyer is warned once each time headroom falls below `low_balance_warning` (at least 1 USD), with a quoted top-up. A top-up racing a suspension ends in the standing its final headroom implies. | No suspension without the stated cause; no resumption while an invoice is overdue or a written-off amount is unpaid; every account resumed or released by the end of its grace; every warning and suspension quotes the amount the policy defines. |
| P4-N6 | **Network operations always knows an account's standing.** Each change of standing is delivered at least once, within `standing_notice_time` (POL-06); repeats change nothing; the current standing can be asked for at any time. | No standing change undelivered; delivery within `standing_notice_time` and enforcement within the X2 target, with lateness reported. |
| P4-N7 | **Money is conserved and history is fixed.** Every money movement sums to zero in its one currency, and so does the ledger per currency; funds and credit holds are not movements; no movement can be altered or removed by anyone, operators included; corrections are new movements; every amount carries its currency. | Ledger sums to zero per currency at every moment; zero altered or removed movements. |
| P4-N8 | **Each charge is split exactly and fairly** (POL-12). Each charge line is split among the parties of its own route. Shares sum exactly to the charge; no party's share falls when a line's total grows; the split depends only on the amount and the weights; the rule is Webster, ties broken in route leg order, first leg first, with Share's commission after every supplier; a supplier with several legs on a route is one party, its legs' weights summed, in the tie position of its first leg (POL-12); the rule and tie order are published; an amendment is split as the split of the line's new total less the shares already posted, except after a borne correction, when it is split on its own; the signed cumulative deviation from exact proportions is reported per party per payout period. | Every split exact, monotone, deterministic and by the published rule. |
| P4-N9 | **Late charges settle like on-time ones.** A supplier's balance depends only on the traffic, the prices and the weights, not on the order or timing in which records arrived; a late-traffic amendment never reduces any party's amount or credits the buyer. | Identical balances for any arrival order and timing. |
| P4-N10 | **Every account can check its statement.** A supplier sees, for any period, each charge's share with the charge, the weights and the rule, payouts, supplier debts and their reasons, residues carried, amounts Share paid it and why, and its deviation; a buyer sees charges and amendments with reasons, top-ups with their conversion rates, reversals and write-offs. | Every share on a statement can be recomputed from what the statement shows; every movement of an account appears on its statement. |
| P4-N11 | **Supplier earnings are final** (POL-23, POL-22, POL-17). Excess carried because Share's policing failed is paid to the supplier at `usage_price` by Share, not the buyer. Every cost Share bears (a partner cancellation under POL-28, the price difference of a dearer equivalent path, an unshown partner fee, a fee on a reservation revoked or cut under POL-07, carried excess) is paid from Share's own account to the supplier concerned, as its own movement; a usage-priced cost such as carried excess is paid to the route's suppliers as the Webster split of the charge the traffic would have made, with no commission share posted (POL-23). A correction caused by Share's error, or with cause "other", is borne by Share in full, even beyond the commission; a correction caused by one supplier's error makes that supplier owe only its own reduction, as a supplier debt netted against later payouts, and Share bears every other party's reduction. A partner cancellation fee goes wholly to the partner. | No supplier balance reduced except by its own error, with its reason. |
| P4-N12 | **Payouts are weekly, exact and once** (POL-22, POL-11, POL-20, POL-29). A supplier owed at least `payout_minimum` is paid weekly in USD (or converted at the shown rate, rounded down to the provider's minor unit, the residue carried in USD); smaller balances carry forward; a payout is complete only when the transfer is confirmed; an amount in an unconfirmed payout is in no other payout; a repeated run, instruction or confirmation pays at most once; after a final failure the amount is paid in the next run; a confirmation after a reported failure, or no answer within `payout_confirmation_timeout`, is escalated, never re-paid automatically; a confirmation of a transfer already re-instructed makes a supplier debt marked "duplicate payout", netted and invoiced like any supplier debt, never an earnings reduction and not counted in the deviation (POL-22). | No amount instructed twice by the marketplace (repeated run, instruction or confirmation); every transfer the provider executes twice is recovered as a "duplicate payout" debt; cumulative payouts equal cumulative earnings less residues still carried and amounts in flight, plus open supplier debts (amounts paid that are owed back). |
| P4-N13 | **Reversals and bad debt are handled by rule** (POL-21, POL-23, POL-15). A reversal after the top-up was spent is applied at once, suspends the account if headroom goes negative, is collected from the next top-up and is written off automatically 90 days after the reversal, at Share's cost; beyond the reversed amount Share bears at most one coverage window of grace charges. A reversal arriving before its payment is held pending for up to 72 h, matched by provider reference; if its payment never arrives it is escalated to operations, never applied. An unpaid invoice is written off 90 days after its due date, at Share's cost; any other negative balance (a fee shortfall at release, accrual beyond a hold), 90 days after it arose (POL-21). After either write-off the amount stays recorded as owed; the account stays suspended until a top-up repays it, the repayment going to Share's own account; after an invoice write-off the account also loses its credit limit and books prepaid until a finance operator sets one again (POL-21, POL-32). | Every reversal and unpaid invoice ends matched, collected, written off or escalated by its rule; no write-off charged to a supplier; no written-off account books again before repaying. |
| P4-N14 | **The books reconcile with the money** (POL-24). Every day D is reconciled by 12:00 UTC on D + 1, with the payment partner, the payment providers' settlement reports and bank statements. It proves: (1) funds at the partner = the sum of buyer balances, **signed** (a negative balance is a receivable Share has funded) + the sum of supplier balances, signed (net of supplier debts) + Share's own balance there − payouts the partner has executed and the ledger has not yet confirmed, each matched to its partner debit, + payments (top-ups, invoice payments) the partner has received and reported and the ledger has not yet posted, each matched to its partner credit, − payments the ledger has posted and the partner has not yet received (a provider that notifies before settling), each matched to its partner credit once received and alerting if not received within `settlement_lag_max`, each in-flight term counted per transaction at the partner's USD amount so that an FX difference posted after the cut is no difference, with funds at the partner taken in USD as the partner reports them and each FX difference posted to Share's own account (POL-20); (2) the safeguarding rule: Share's own balance covers every receivable it funds (negative buyer balances, and negative supplier balances net of supplier debts), so funds at the partner cover every positive buyer and supplier balance, less payouts the partner has executed and the ledger has not yet confirmed, plus payments the partner has received and the ledger has not yet posted, less payments the ledger has posted and the partner has not yet received; the rule is a treasury obligation, and no movement owed to a buyer or supplier is refused or delayed because of it; (3) every provider transaction matches exactly one ledger movement (a top-up, invoice payment, reversal, payout, supplier-debt payment, or movement of Share's own funds, deposit or withdrawal), and the reverse, a payment received and not yet posted being matched to its ledger movement once posted. Any difference, a breach of the safeguarding rule, or a reconciliation not completed in time, is an operational alert. | Every daily reconciliation completed on time; every difference and every safeguarding breach alerted; no alert when the books and the money agree, negative balances, payouts in flight, payments received but not yet posted, payments posted but not yet received and FX differences posted after the cut included. |
| P4-N15 | **Every money-moving input moves money once** (POL-29). Payment notifications, transfer confirmations and failure reports, payout instructions, operator corrections, quarantine attributions, resolutions of money escalations, write-offs, invoice payments, movements for costs Share bears, cancellation-fee settlements, supplier-debt postings, movements of Share's own funds and the posting of each charge and amendment are idempotent by their source reference, for the 7-year retention; a reuse of a source reference by a different principal is refused. | Zero money moved twice by a repeated input. |
| P4-N16 | **Every movement can be traced, and the past rebuilt** (POL-19, POL-06). Every money movement refers to the fact that caused it (a charge, a notification, a payout confirmation, an operator action with its reason); the ledger balance, funds held and headroom of any account at any past moment can be rebuilt from recorded facts. | Every movement traced to its source; every rebuilt past figure equals what was shown at the time. |
| P4-N17 | **Credit is given only to vetted accounts, and collected by rule** (POL-15, POL-24). A `credit_limit` can be set, or removed, only by an operator in the finance role, with a reason, and set only on an account that has passed know-your-business checks (POL-32). A credit-limit account is invoiced monthly for its posted charges and amendments, due in `invoice_terms`; a payment against an invoice is credited once; an unpaid invoice suspends the account (POL-16), which resumes only when every overdue invoice is paid and the headroom rule holds, and is written off 90 days after its due date; a top-up to an account with an overdue invoice pays its overdue invoices first, oldest first (POL-15). | No credit limit on an unvetted account or set outside the finance role; no account resumed with an invoice overdue; every invoice paid, suspended on or written off by its rule. |

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
| Prices, wallets and the ledger are in USD; every amount is tagged with its currency so more can be added. Top-ups convert rounded up to the micro; payouts round down to the provider's minor unit, the residue carried in USD; a shown rate is valid for `fx_quote_validity` (15 min). | *Decided* (POL-20) |
| Amounts are integers in micros; charges are rounded once per charge line, down; payout residues stay with the payee. | *Decided* (POL-11) |
| Funds are held for `coverage_window` (24 h) at admission, or the partner fee if larger while it could still be charged; a future reservation's first window from admission; vetted accounts take credit holds instead, invoiced monthly, due in `invoice_terms` (30 days). At release a shown fee is charged against what is left of the hold; a shortfall is a negative balance. | *Decided* (POL-15, POL-08) |
| Suspension when headroom (including usage exposure) would fall below zero, or an invoice is overdue; warning below `low_balance_warning` (max of a quarter window, 1 USD), once per crossing; reservations kept for `suspension_grace` (equal to `coverage_window`) even after a reversal, then released, which is intended; resumption is automatic at the resume amount, but not while an invoice is overdue or a written-off amount is unpaid. A price change takes effect even if its larger hold cannot be covered; the account is then suspended. | *Decided* (POL-16, POL-18, POL-21, POL-27) |
| The split is Webster (Sainte-Laguë); ties among suppliers in route leg order; Share's commission loses ties; a supplier with several legs is one party; the rule is published. | *Decided* (POL-12) |
| Each charge is divided by fixed weights per route and party; how the weights are set is pricing policy. | *Assumed* |
| Late traffic can only increase a charge line; decreases come only from price corrections. | *Inferred* from P3 (duplicates are removed by record ID) |
| Share bears buyer credit risk and its own errors in full; supplier earnings are final once a charge is posted; supplier-caused corrections are owed only by the supplier at fault; a Share-borne usage-priced cost is split among the route's suppliers with no commission share. | *Decided* (POL-23) |
| A write-off is booked to Share but stays recorded as owed; the account stays suspended until a top-up repays it; an invoice write-off also removes the credit limit. | *Decided* (POL-21) |
| Credit limits are set, and money escalations resolved, only by an operator in the finance role, with a reason. | *Decided* (POL-32) |
| Buyer funds are held through a licensed payment partner, reconciled daily, with providers and banks, under a signed invariant and a safeguarding rule: Share pre-funds every receivable (negative buyer balances, supplier debts). | *Decided* (POL-24), pending legal confirmation per market |
| Payouts: weekly, minimum 50 USD, complete on confirmed transfer, never instructed twice for the same amounts; escalation after `payout_confirmation_timeout` (7 days); a duplicate is recovered as a "duplicate payout" supplier debt. | *Decided* (POL-22, POL-29) |
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
- Parse-level rules for notifications (field formats, time syntax): the interface contract.

## Open questions

Answered by the policy register and removed: currencies and FX risk (POL-20); smallest unit
and conversion (POL-11, POL-20); payout frequency, minimum and clawback (POL-22);
resumption after top-up (POL-16); bad debt (POL-23); regulation (POL-24,
pending legal confirmation); the warning threshold and quote (POL-16);
spending by agent key (POL-25: cumulative); usage exposure on prepaid accounts
(POL-16, POL-18); orphan reversals (POL-21); Share-error corrections beyond the commission
(POL-23); an agent key's headroom (POL-25); future reservations and credit-limit accounts
(POL-15); partner fees (POL-08); price corrections and supplier
errors (POL-23); grace after a reversal (POL-16); ties among
suppliers (POL-12); accrued-but-unposted charges (POL-18); what
reconciliation proves and with whom (POL-24: signed balances, payouts in
flight, safeguarding); payouts in flight and duplicate payouts (POL-22);
resumption after an overdue invoice (POL-16); what follows a write-off
(POL-21); the fee hold over time and at release (POL-15); a negative
key headroom (POL-25); a price change the headroom cannot cover (POL-27); the split of Share-borne usage costs and of a supplier with several legs
(POL-23, POL-12); cancellation fees as charge lines (POL-11); who sets
credit limits and resolves money escalations (POL-32).

1. **Authentication per provider.** How each payment provider proves a notification is
   authentic (signature scheme, mutual TLS, callback verification) is for the interface
   contract; X1 requires only that unproven notifications move no money.
2. **Zero-amount notifications.** Do any providers send zero-amount notifications (for
   example verification pings)? The spec rejects any amount that is not positive.
