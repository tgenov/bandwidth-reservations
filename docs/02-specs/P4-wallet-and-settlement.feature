# Spec for P4: wallet, funds holds, ledger and supplier settlement.
# Problem statement: ../01-discovery/P4-wallet-and-settlement.md
# Terms: glossary.md. Policies: policy-register.md.
#
# Tags: @P4-Snn is the scenario's stable ID; @need-P4-Nn is the need it serves; @POL-nn a
# policy it depends on. Conformance (design, tests, status) is kept in conformance.md.
#
# Starts where P3 ends: P3 produces each charge and amendment; this spec covers money
# entering wallets, funds held for reservations, headroom, suspension, the ledger, the
# split and payouts. Amounts are USD unless a scenario says otherwise; "micro-USD" is
# 10^-6 USD. Prices and weights in examples are illustrations; a policy parameter's value
# is its POL default.

Feature: Wallet, funds holds, ledger and supplier settlement

  As a buyer
  I want each top-up credited exactly once and a headroom figure I can spend against
  So that I never lose a payment and know what I can book

  As a supplier on a route
  I want my share of every charge, by a published rule, paid weekly
  So that I earn the same whatever order the traffic records arrived in, and can check it

  As the marketplace's finance team
  I want books that always balance, a history nobody can rewrite and daily reconciliation
  So that every balance can be explained and audited

  As network operations
  I want to be told reliably when an account's standing changes
  So that usage-priced traffic is blocked and unblocked at the edge on time

  Rule: A top-up changes the wallet exactly once

    @P4-S01 @need-P4-N1
    Scenario: Repeated and reordered notifications change the wallet once per transaction
      Given the payment provider sends these notifications for account "b1":
        | provider reference | type      | amount       |
        | MP1                | completed | 5.000000 USD |
        | MP2                | completed | 3.000000 USD |
        | MP2                | reversed  | 3.000000 USD |
      When each notification is delivered three times, in any order
      Then the ledger balance of "b1" is 5.000000 USD

    @P4-S02 @need-P4-N1 @need-P4-N13 @POL-21
    Scenario: A reversal arriving before its payment is held and matched
      Given the ledger balance of "b1" is 0 USD
      When the provider delivers "MP2 reversed 3.000000 USD" for "b1"
      And within 72 h delivers "MP2 completed 3.000000 USD" for "b1"
      Then the ledger balance of "b1" is 0 USD

    @P4-S03 @need-P4-N13 @POL-21
    Scenario: A reversal whose payment does not arrive within 72 h is escalated, never applied
      Given the provider delivered "MP3 reversed 2.000000 USD" for "b1", and "MP3 completed" never arrived
      When 72 h pass
      Then the ledger balance of "b1" is unchanged by the reversal
      And the reversal is escalated to operations for reconciliation with the payment partner

    @P4-S04 @need-P4-N1
    Scenario: A redelivery whose contents differ from the original moves no money and is reported
      Given "MP1 completed 5.000000 USD" for "b1" has been applied
      When the provider delivers "MP1 completed 9.000000 USD" for "b1"
      Then the ledger balance of "b1" is unchanged
      And the mismatch is reported for reconciliation

    @P4-S05 @need-P4-N1
    Scenario Outline: A malformed notification moves no money
      When the provider delivers a notification with <defect>
      Then it is rejected as malformed
      And no money moves

      Examples:
        | defect                                                                  |
        | an unknown type                                                         |
        | an amount that is not a positive whole number of the currency's smallest unit |
        | an amount of zero                                                       |
        | no provider reference                                                   |
        | no account                                                              |
        | a time that is not a time                                               |

  Rule: A top-up in another currency is credited in USD at the rate shown

    @P4-S06 @need-P4-N2 @POL-20
    Scenario: A KES top-up is credited at the rate shown before the buyer confirmed
      Given buyer "b1" was shown a rate of 0.0077 USD per KES before confirming a top-up of 1,000 KES
      When the provider notifies the completed top-up of 1,000 KES
      Then "b1" is credited 7.700000 USD
      And the conversion is recorded with its rate

    @P4-S07 @need-P4-N2 @POL-11
    Scenario: A provider amount converts exactly into micros
      When a top-up of 12.34 USD is credited
      Then the wallet is credited exactly 12,340,000 micro-USD

  Rule: Funds are held for the coverage window of each reservation

    Background:
      Given `coverage_window` is 24 h (POL-15 default)
      And a guaranteed product priced at 2 micro-USD per Mbps-minute
      And buyer account "b1" with a ledger balance of 1.000000 USD and no funds held

    @P4-S08 @need-P4-N3 @POL-15
    Scenario: Confirming a reservation holds funds for the coverage window, without charging them
      When "b1" is confirmed an open-ended reservation of 100 Mbps
      Then 0.288000 USD is held for it, 24 h of its charges
      And the ledger balance of "b1" is still 1.000000 USD

    @P4-S09 @need-P4-N3 @POL-15
    Scenario: A reservation shorter than the coverage window is held in full
      When "b1" is confirmed a reservation of 100 Mbps for 2 h
      Then 0.024000 USD is held for it, the whole reservation

    @P4-S10 @need-P4-N3 @POL-15
    Scenario: Charges accrue against the hold, and the hold rolls forward
      Given "b1" holds funds for an open-ended reservation of 100 Mbps
      When one minute's charge of 200 micro-USD is posted
      Then the ledger balance of "b1" falls by 200 micro-USD
      And the funds held still cover the next 24 h of the reservation's charges

    @P4-S11 @need-P4-N3 @POL-15 @POL-08
    Scenario: The unused hold is released when a reservation ends early
      Given "b1" holds funds for an open-ended reservation of 100 Mbps
      When the reservation is cancelled
      Then from the minute the cancellation takes effect no funds are held for it

    @P4-S12 @need-P4-N3
    Scenario: A booking that is not confirmed holds no funds
      When a booking by "b1" ends rejected, invalid or failed
      Then no funds are held for it

    @P4-S13 @need-P4-N3 @POL-15 @POL-18
    Scenario: A credit-limit account is not held, but its coverage counts against its headroom
      Given account "e1" has a `credit_limit` (POL-15) and no balance
      When "e1" is confirmed a reservation
      Then no funds are held for it
      And its headroom is reduced by the reservation's charges for the coverage window

    @P4-S14 @need-P4-N3 @POL-15
    Scenario: A credit-limit account is invoiced monthly for its posted charges
      Given account "e1" has a `credit_limit` (POL-15)
      When a calendar month ends
      Then "e1" is invoiced for the charges and amendments posted to it in that month

  Rule: The buyer sees available headroom, itemised

    @P4-S15 @need-P4-N4 @POL-18
    Scenario: The headline figure is available headroom, net of funds held and usage exposure
      Given account "b1" has a ledger balance of 1.000000 USD, 0.288000 USD held, a usage exposure of 0.012000 USD and no credit limit
      When "b1" asks for its balance
      Then the headline figure is 0.700000 USD of available headroom

    @P4-S16 @need-P4-N4 @POL-18
    Scenario: The answer itemises balance, holds, accrued charges and estimated unposted usage
      When "b1" asks for its balance
      Then the answer shows its ledger balance, funds held, charges accrued but not yet posted, and an estimate of usage not yet posted

    @P4-S17 @need-P4-N4
    Scenario: The ledger balance shown equals the ledger
      When "b1" asks for its balance
      Then the ledger balance shown equals the sum of "b1"'s ledger entries at that moment

    @P4-S55 @need-P4-N4 @POL-25 @POL-18
    Scenario Outline: An agent key sees its own headroom, the lower of the account's headroom and its remaining spending limit
      Given account "b1" has an available headroom of <account> USD
      And an agent key of "b1" with a `key_spend_limit` of <limit> USD has spent <spent> USD in the current `key_spend_period` (POL-25)
      When the key asks for its balance
      Then the headline figure is <key> USD of headroom for that key

      Examples:
        | account | limit | spent | key |
        | 10.00   | 5.00  | 1.00  | 4.00 |
        | 3.00    | 5.00  | 1.00  | 3.00 |

  Rule: Suspension follows a stated cause, keeps reservations for a grace period, and reverses on funds

    Background:
      Given `suspension_grace` is equal to `coverage_window` (POL-16 default)

    @P4-S18 @need-P4-N5 @POL-16 @POL-18
    Scenario Outline: An account is suspended when its headroom would fall below zero
      Given account "<account>" is <kind>
      When <cause>
      Then "<account>" is suspended

      Examples:
        | account | kind                                    | cause                                                         |
        | b1      | prepaid, holding funds for reservations | its headroom cannot cover rolling the funds hold forward      |
        | b1      | prepaid, holding funds for reservations | its usage exposure exceeds what is left of its headroom       |
        | e1      | a credit-limit account (POL-15)         | its usage exposure exceeds what is left of its headroom       |

    @P4-S19 @need-P4-N5 @POL-14 @POL-16 @POL-18
    Scenario: Suspension comes before any account can owe more than its headroom allows
      Given any account, prepaid or with a credit limit
      When its usage-priced traffic grows
      Then it is suspended no later than the moment its headroom (POL-18), net of usage exposure, would fall below zero

    @P4-S20 @need-P4-N5 @POL-16
    Scenario: A suspended account's reservations keep their capacity during the grace
      Given account "b1" is suspended with confirmed reservations
      When less than `suspension_grace` has passed
      Then its reservations are still confirmed and keep their capacity

    @P4-S21 @need-P4-N5 @POL-16
    Scenario: A suspended account's usage-priced traffic is blocked
      When account "b1" is suspended
      Then network operations is told to block "b1"'s usage-priced traffic at the edge

    @P4-S22 @need-P4-N5 @POL-16
    Scenario: Funds arriving within the grace resume the account automatically
      Given account "b1" is suspended
      When a top-up within `suspension_grace` lets the hold roll forward
      Then "b1" is active again, with no request from the buyer
      And network operations is told to unblock its usage-priced traffic

    @P4-S23 @need-P4-N5 @POL-16
    Scenario: At the end of the grace the reservations are released and the buyer is told
      Given account "b1" is suspended
      When `suspension_grace` passes without funds
      Then "b1"'s reservations are released, and their capacity is available to other buyers
      And the buyer is told which reservations were released and why

    @P4-S24 @need-P4-N5 @POL-16
    Scenario: The buyer is warned when headroom falls below low_balance_warning
      Given account "b1" holds an open-ended reservation whose charges for one coverage window are 0.288000 USD
      When its headroom falls below 0.072000 USD, the `low_balance_warning` (POL-16 default: a quarter of one coverage window's charges)
      Then the buyer is warned, with the top-up that would avoid suspension

  Rule: Network operations always knows an account's standing

    @P4-S25 @need-P4-N6
    Scenario: Each change of standing is notified at least once, and repeats change nothing
      When account "b1"'s standing changes
      Then network operations is notified of the new standing at least once
      And receiving the same notification again changes nothing

    @P4-S26 @need-P4-N6
    Scenario: The current standing can be asked for at any time
      When network operations asks for account "b1"'s standing
      Then the answer is its current standing and since when

    @P4-S27 @need-P4-N6
    Scenario: Enforcement later than its target is reported
      Given account "b1" was suspended
      When its usage-priced traffic is not blocked within the enforcement target (X2)
      Then the late enforcement is reported to operations and finance

  Rule: Money is conserved and history cannot be rewritten

    @P4-S28 @need-P4-N7
    Scenario: Every money movement and the whole ledger sum to zero
      When any top-ups, charges, amendments, holds, payouts and reversals are posted
      Then every money movement sums to zero
      And the sum of all entries in the ledger is zero

    @P4-S29 @need-P4-N7
    Scenario: No money movement can be altered or removed by anyone
      Given a posted money movement
      When any principal, operators included, tries to alter or remove it
      Then the attempt is refused and recorded
      And the movement is unchanged

    @P4-S30 @need-P4-N7
    Scenario: A correction is a new money movement that refers to the one it corrects
      Given a posted money movement that turns out to be wrong
      When it is corrected
      Then a new money movement is posted, referring to the original
      And the original is unchanged

    @P4-S31 @need-P4-N7 @POL-20
    Scenario: Every amount carries its currency, and a money movement is in one currency
      When any money movement is posted
      Then every entry in it carries a currency, and all its entries are in the same currency

  Rule: Each charge is split exactly and fairly, by the published rule

    Background:
      Given route "R1" is split between these parties by weight:
        | party            | weight |
        | supplier A       | 3000   |
        | supplier B       | 3333   |
        | supplier C       | 2167   |
        | Share commission | 1500   |

    @P4-S32 @need-P4-N8
    Scenario: Shares add up exactly to the charge
      When any whole number of micro-USD is split among the parties of "R1"
      Then the shares add up to exactly that number

    @P4-S33 @need-P4-N8
    Scenario: A larger charge never lowers any party's share
      When any two charges, one larger than the other, are split among the parties of "R1"
      Then no party's share of the larger is smaller than its share of the smaller

    @P4-S34 @need-P4-N8
    Scenario: The split depends only on the amount and the weights
      When the same amount is split among the same weights, at any time and in any context
      Then the shares are the same

    @P4-S35 @need-P4-N8 @POL-12
    Scenario Outline: Shares follow the Webster rule
      Given parties "a", "b" and "c" with weights 31, 76 and 70
      When <amount> micro-USD is split among them
      Then "a", "b" and "c" receive <a>, <b> and <c> micro-USD

      Examples:
        | amount | a | b  | c  |
        | 31     | 6 | 13 | 12 |
        | 32     | 6 | 14 | 12 |

    @P4-S36 @need-P4-N8 @POL-12
    Scenario: Share's commission loses every tie
      Given supplier "s" and Share's commission each with weight 1
      When 1 micro-USD is split between them
      Then supplier "s" receives 1 micro-USD and Share's commission receives 0

    @P4-S37 @need-P4-N8 @POL-12
    Scenario: Cumulative deviation from exact proportions is reported per party per payout period
      When a payout period ends
      Then each party is shown the total by which its shares in the period differ from its exact proportions

  Rule: Late charges settle exactly like on-time ones

    @P4-S38 @need-P4-N9
    Scenario: Every account ends at the split of each minute's final total, whatever the arrival order
      Given any set of flow records for several reservations and minutes
      When they are delivered once each in order and settled
      And separately delivered in any order, partly repeated and partly after their minute was charged, and settled
      Then every account's ledger balance is the same in both cases

    @P4-S39 @need-P4-N9
    Scenario: A late-traffic amendment never reduces any party's amount and never credits the buyer
      When any late-traffic amendment is settled
      Then the buyer's wallet is debited and no party is debited

  Rule: Suppliers can check what they are owed

    @P4-S40 @need-P4-N10 @POL-12
    Scenario: A supplier's statement shows each share and the rule and weights that produced it
      When supplier A asks for its statement for a period
      Then each charge's share is shown with the charge, the weights, and the published rule and tie order
      And every share can be recomputed from what the statement shows

  Rule: Supplier earnings are final, except for the supplier's own errors

    @P4-S41 @need-P4-N11 @POL-23
    Scenario: A correction caused by Share's error is borne by Share in full
      Given a charge of 100.000000 USD on "R1" was posted and split, Share's commission share being 15.000000 USD
      When a price correction caused by Share's error reduces it by 40.000000 USD
      Then the buyer is credited 40.000000 USD
      And the whole 40.000000 USD is borne from Share's own account, though it exceeds the commission on that charge
      And no supplier's balance changes

    @P4-S42 @need-P4-N11 @POL-22 @POL-23
    Scenario: A supplier-caused error creates a supplier debt, with its reason visible
      Given supplier A was paid for a charge
      When a correction caused by supplier A's error reduces that charge
      Then supplier A owes the reduction of its share as a supplier debt
      And its statement shows the debt and its reason

    @P4-S56 @need-P4-N11 @POL-17
    Scenario: Excess carried despite policing is paid to the supplier by Share, not by the buyer
      Given P3 found 1 GB of excess carried on a product without burst for buyer "b1", on supplier A's link
      When it is settled
      Then supplier A is credited its share of 1 GB at `usage_price` (POL-17) from Share's own account
      And "b1"'s wallet is not debited for it

  Rule: Payouts are weekly, exact and made once

    Background:
      Given `payout_frequency` is weekly and `payout_minimum` is 50 USD (POL-22 defaults)

    @P4-S43 @need-P4-N12 @POL-22
    Scenario: A supplier owed at least the minimum is paid at the weekly payout
      Given supplier A is owed 120.000000 USD
      When the weekly payout runs
      Then a payout of 120.00 USD to supplier A is issued

    @P4-S44 @need-P4-N12 @POL-22
    Scenario: A balance below the minimum carries forward
      Given supplier A is owed 30.000000 USD
      When the weekly payout runs
      Then no payout is issued to supplier A
      And supplier A is still owed 30.000000 USD

    @P4-S45 @need-P4-N12 @POL-22
    Scenario: A payout is complete only when the transfer is confirmed
      Given a payout of 120.00 USD to supplier A has been issued
      When the transfer fails or is not confirmed
      Then supplier A is still owed 120.000000 USD

    @P4-S46 @need-P4-N12
    Scenario: A payout run that is repeated or retried pays each supplier at most once
      When the same weekly payout run is executed more than once
      Then each supplier is paid at most once for that run

    @P4-S47 @need-P4-N12 @POL-11
    Scenario: A payout is rounded down to the provider's minor unit and the residue carries forward
      Given supplier A is owed 120.004567 USD
      When the weekly payout runs to a provider whose minor unit is the cent
      Then a payout of 120.00 USD is issued
      And supplier A is still owed 0.004567 USD

    @P4-S48 @need-P4-N12 @POL-22
    Scenario: A supplier debt is netted against later payouts
      Given supplier A has a supplier debt of 15.000000 USD
      And supplier A then earns 80.000000 USD
      When the weekly payout runs
      Then a payout of 65.00 USD to supplier A is issued

    @P4-S49 @need-P4-N12 @POL-22
    Scenario: A supplier debt open for more than 90 days is invoiced
      Given supplier A has had a supplier debt for more than 90 days
      When the debt is reviewed
      Then supplier A is invoiced for it

    @P4-S50 @need-P4-N12 @POL-20
    Scenario: A supplier paid in another currency is converted at payout at the shown rate
      Given supplier A is paid in KES
      When a payout to supplier A is issued
      Then it is converted at the rate shown for that payout, and the rate is recorded

  Rule: Reversals and bad debt are borne by Share, never by suppliers

    @P4-S51 @need-P4-N13 @POL-21
    Scenario: A reversal after the top-up was spent is applied at once and suspends the account if headroom goes negative
      Given account "b1" spent a top-up of 5.000000 USD
      When the provider reverses that top-up
      Then the reversal is applied at once
      And "b1" is suspended because its headroom is negative

    @P4-S52 @need-P4-N13 @POL-21
    Scenario: A negative balance is collected from the next top-up
      Given account "b1" has a ledger balance of -2.000000 USD after a reversal
      When "b1" tops up 5.000000 USD
      Then its ledger balance is 3.000000 USD

    @P4-S53 @need-P4-N13 @POL-21 @POL-23
    Scenario: A negative balance not recovered within 90 days is written off at Share's cost
      Given account "b1" has had a negative ledger balance for 90 days
      When the balance is written off
      Then the loss is borne by Share
      And no supplier's balance changes

  Rule: The books are reconciled with the payment partner daily

    @P4-S54 @need-P4-N14 @POL-24
    Scenario: Differences found in the daily reconciliation are reported
      Given the ledger and the payment partner's records for a day differ
      When the daily reconciliation runs
      Then each difference is reported to finance for resolution
