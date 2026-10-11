# P4. Wallet, ledger and supplier revenue split

## Context

Buyers pay per use with no commitment and no upfront payment. Money enters through a
prepaid wallet that the buyer tops up with a mobile-money or card payment (M-Pesa, Stripe,
Adyen and similar). The payment provider tells the marketplace about each payment
asynchronously, by calling a webhook.

Usage is metered and rated into a charge for each reservation and minute (P3). Every
charge is drawn from the buyer's wallet and owed onward to the suppliers whose links make
up the route, with the marketplace keeping a commission. A route such as
Nairobi → Mombasa → Marseille can cross three or more suppliers' links, so one charge has
several payees.

Suppliers are promised central billing and automated payouts. That makes the marketplace
the party that holds buyers' money, owes suppliers theirs, and has to show at any moment
who is owed what and why.

Charges are not final when first posted. Usage records arrive late (P3), so a minute
that was already charged can grow afterwards, and a mistaken price can be corrected
later. Every amount owed to a supplier therefore has to stay correct as charges are
revised.

## Who is affected

| Who | What they need |
|---|---|
| Buyer (people, enterprises, AI agents) | A top-up is credited exactly once and quickly; the balance they see is the balance they have |
| Supplier | Their share of every charge, computed by a rule they can check, paid out automatically; amounts already earned are not taken back without a reason they can see |
| Marketplace finance | Books that balance at all times, a history that cannot be rewritten, and a way to reconcile with payment providers and banks |
| Services that consult the wallet | A balance answer they can wait on, for example before admitting a new reservation |

## The problem

1. **Payment notifications are unreliable.** The provider may deliver the same
   notification several times, deliver notifications out of order (a reversal before the
   payment it reverses), or deliver them late. A naive handler credits the wallet twice
   or loses a reversal.
2. **Webhooks come from outside.** Anything that can reach the endpoint can claim a
   payment was made. A malformed or forged notification must not move money.
3. **Money must be conserved.** Every movement takes money from one account and gives it
   to others. If the record of a movement can be half-written, or can be edited
   afterwards, the books stop adding up and nobody can say which number is right.
4. **One charge, several payees, indivisible units.** A charge is a whole number of the
   smallest money unit and has to be divided among suppliers and the commission in fixed
   proportions. The parts must add up exactly to the charge, so some parties are rounded
   up and others down.
5. **Charges change after the fact.** When late usage raises a minute's total, the split
   of that minute changes too. Two things can go wrong:
   - With some rounding rules a larger total gives one party a *smaller* share, so
     ordinary late usage would take money back from a supplier who may already have been
     paid.
   - If each late increment is divided on its own, the rounding of each piece adds up
     differently depending on how the usage was chunked, so a supplier's balance depends
     on the order and timing of record arrival rather than on the usage.
6. **Late charges must be treated like on-time charges.** Splitting a late charge must
   follow the same rule, the same rates and the same path as a regular charge. A second
   code path for corrections is a second set of bugs.
7. **Money can be owed back.** When a price was wrong and a minute is re-rated downward,
   a supplier who has already been paid owes money back. That debt has to be recovered,
   not lost.

## Constraints and assumptions

| Constraint or assumption | Status |
|---|---|
| Payment notifications are delivered at least once, possibly repeated, reordered or late | *Confirmed* (company profile: "asynchronous M-Pesa webhooks that can repeat") |
| Each provider notification carries a transaction ID that is unique for that provider | *Assumed* |
| The marketplace runs a double-entry ledger | *Confirmed* (company profile, Problem 4) |
| Suppliers expect central billing and automated payouts | *Confirmed* (company profile) |
| Several currencies are in play | *Confirmed* as a requirement (company profile); how they interact is not known |
| A late charge is split exactly like a regular charge | *Confirmed* (business statement: late billing is no different from regular billing when splitting payouts) |
| Each charge is divided by fixed weights per route and supplier, plus a commission | *Assumed*; how the weights are set is pricing policy |
| Late usage can only increase a minute's charge; decreases come from price corrections | *Inferred* from P3 (duplicates are removed by record ID) |
| Prepaid wallet; buyers do not pay upfront for a reservation | *Confirmed* (company profile: "no upfront payment") |
| Money is never represented as a floating-point number | *Assumed* |

## Success measures

- A provider notification, however many times or in whatever order it is delivered,
  changes the wallet exactly once.
- At every moment, every recorded money movement sums to zero, and so does the whole
  ledger.
- No recorded movement can be changed or removed; corrections are new movements.
- Each charge's shares add up exactly to the charge, in the smallest money unit.
- No supplier's share of a minute goes down because that minute's usage went up.
- A supplier's balance depends only on the usage, the rates and the weights, not on the
  order or timing in which usage records arrived.
- A supplier who owes money back is not paid until later earnings cover the debt.
- A balance query returns the same number the ledger holds.

## Out of scope

- Ingesting, deduplicating and rating usage records, choosing the rate by usage time,
  and the exposure bound that decides when a buyer is suspended. These are P3; this
  problem starts from a charge total for a reservation and minute.
- How split weights are chosen (by link price, distance or contract). Pricing policy.
- Moving money to suppliers' bank or mobile-money accounts (treasury), and supplier KYC
  and onboarding.
- Subscription lifecycle and renewals.
- Spending limits and quotes for AI-agent buyers.

## Open questions

1. Which currencies, and does a wallet hold one currency or several? Are suppliers paid in
   the buyer's currency, their own, or a settlement currency, and who carries the FX risk
   between a charge and a payout?
2. What is the smallest unit for each currency, and how is the internal unit converted at
   the provider boundary (M-Pesa amounts are whole shillings)?
3. How are payment notifications authenticated for each provider?
4. If a provider redelivers a notification with different contents under the same
   transaction ID, what should happen?
5. How often do payouts run, is there a minimum payout, and how long may a supplier's
   debt from a clawback stay open?
6. How is the ledger reconciled against provider settlement reports and bank statements,
   and who resolves mismatches?
7. When a suspended buyer tops up, is service resumed automatically? (Business policy.)
