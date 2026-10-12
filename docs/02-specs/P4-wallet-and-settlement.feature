# Spec for P4: wallet, funds holds, ledger and supplier settlement.
# Problem statement: ../01-discovery/P4-wallet-and-settlement.md
# Terms: glossary.md. Policies: policy-register.md.
#
# Tags: @P4-Snn is the scenario's stable ID; @need-P4-Nn is the need it serves; @POL-nn a
# policy it depends on. Conformance (design, tests, status) is kept in conformance.md.
#
# Starts where P3 ends: P3 produces each charge (one per charge line, POL-11: a
# reservation for one minute, an account and product on one route for one minute of
# usage-priced traffic, or one cancellation fee for one reservation) and amendment; this spec covers money entering wallets, funds and credit holds, headroom,
# suspension, the ledger, the split and payouts. Amounts are USD unless a scenario says
# otherwise; "micro-USD" is 10^-6 USD. At 2 micro-USD per Mbps-minute, 100 Mbps for 24 h is
# 0.288000 USD. Prices and weights in examples are illustrations; a policy parameter's
# value is its POL default.

Feature: Wallet, funds holds, ledger and supplier settlement

  As a buyer
  I want each top-up credited exactly once and a headroom figure I can spend against
  So that I never lose a payment and know what I can book

  As a supplier on a route
  I want my share of every charge, by a published rule, paid weekly and never twice
  So that I earn the same whatever order the traffic records arrived in, and can check it

  As the marketplace's finance team
  I want books that always balance, a history nobody can rewrite and daily reconciliation
  So that every balance can be explained and audited

  As network operations
  I want to be told reliably when an account's standing changes
  So that usage-priced traffic is blocked and unblocked at the edge on time

  Rule: A top-up changes the wallet exactly once

    @P4-S01 @need-P4-N1 @need-P4-N15 @POL-29
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
        | defect                                              |
        | an unknown type                                     |
        | an amount of zero or less                           |
        | an amount finer than the currency's smallest unit   |
        | no provider reference                               |
        | no account                                          |

    @P4-S57 @need-P4-N15 @POL-29 @POL-08
    Scenario Outline: Every money-moving input moves money once, however often it is delivered or submitted
      When the same <input> is delivered or submitted more than once, with the same source reference
      Then money moves once for it
      And every later copy has no further effect

      Examples:
        | input                                      |
        | payment notification                       |
        | invoice payment notification               |
        | transfer confirmation                      |
        | payout instruction                         |
        | operator price correction                  |
        | quarantine attribution                     |
        | write-off                                  |
        | posting of a charge or an amendment        |
        | transfer failure report                    |
        | movement for a cost Share bears            |
        | settlement of a cancellation fee           |
        | posting of a supplier debt                 |
        | resolution of a money escalation           |
        | movement of Share's own funds              |

    @P4-S99 @need-P4-N15 @POL-29
    Scenario: A source reference reused by a different principal is refused and moves no money
      Given an operator submitted a price correction with source reference "C1"
      When another operator submits a correction with source reference "C1"
      Then the second submission is refused, as a reuse of the source reference by another principal (POL-29)
      And no money moves for it, and the first correction is unaffected

    @P4-S100 @need-P4-N15 @need-P4-N1 @POL-29
    Scenario: A money-moving input redelivered long after the booking retention still moves nothing
      Given "MP1 completed 5.000000 USD" for "b1" was applied 400 days ago
      When the provider delivers it again
      Then no money moves
      And it is still identified by its source reference, kept for the 7-year retention of money-moving inputs, not the 24 h of booking requests (POL-29)

  Rule: A top-up in another currency is credited in USD at the rate that applies, rounded up to the micro

    @P4-S06 @need-P4-N2 @POL-20 @POL-11
    Scenario Outline: A KES top-up is credited at the rate shown before the buyer confirmed, rounded up to the micro
      Given buyer "b1" was shown a rate of <rate> USD per KES before confirming a top-up of <kes> KES
      When the provider notifies the completed top-up of <kes> KES within `fx_quote_validity` (POL-20)
      Then "b1" is credited <usd> USD, exactly <exact> USD rounded up to the micro
      And the conversion is recorded with its rate

      Examples:
        | rate      | kes   | exact     | usd      |
        | 0.0077    | 1,000 | 7.7       | 7.700000 |
        | 0.0077123 | 1,234 | 9.5169782 | 9.516979 |

    @P4-S103 @need-P4-N2 @need-P4-N14 @POL-20 @POL-24
    Scenario Outline: The difference between the micros credited and the partner's USD amount is posted to Share's own account
      Given buyer "b1" was credited 9.516979 USD for a top-up of 1,234 KES at a shown rate of 0.0077123 USD per KES (P4-S06)
      When the payment partner reports the funds it received for that top-up as <reported> USD
      Then an FX difference of <difference> USD is posted to Share's own account (POL-20)
      And the daily reconciliation finds the funds at the partner equal to the signed balances, to the micro (POL-24)

      Examples:
        | reported | difference | why                     |
        | 9.520000 | +0.003021  | 9.520000 - 9.516979     |
        | 9.510000 | -0.006979  | 9.510000 - 9.516979     |

    @P4-S58 @need-P4-N2 @POL-20
    Scenario: A payment arriving after fx_quote_validity is credited at the partner's rate at notification
      Given buyer "b1" was shown a rate of 0.0077 USD per KES at 10:00 for a top-up of 1,000 KES
      And the partner's rate at 10:20 is 0.0076 USD per KES
      When the provider notifies the completed top-up at 10:20, after `fx_quote_validity` (POL-20: 15 min)
      Then "b1" is credited 7.600000 USD
      And the statement shows the rate 0.0076 USD per KES, and that the shown rate had expired

    @P4-S07 @need-P4-N2 @POL-11
    Scenario: A provider amount in USD converts exactly into micros
      When a top-up of 12.34 USD is credited
      Then the wallet is credited exactly 12,340,000 micro-USD

  Rule: Funds are held for the coverage window of each reservation, and the hold follows the reservation

    Background:
      Given `coverage_window` is 24 h (POL-15 default)
      And a guaranteed product priced at 2 micro-USD per Mbps-minute
      And it is 09:00
      And buyer account "b1" with a ledger balance of 1.000000 USD and no funds held

    @P4-S08 @need-P4-N3 @POL-15
    Scenario: Confirming a reservation holds funds for the coverage window, without charging them
      When "b1" is confirmed an open-ended reservation of 100 Mbps from now
      Then 0.288000 USD is held for it, 24 h of its charges
      And the ledger balance of "b1" is still 1.000000 USD

    @P4-S09 @need-P4-N3 @POL-15
    Scenario: A reservation shorter than the coverage window is held in full
      When "b1" is confirmed a reservation of 100 Mbps for 2 h
      Then 0.024000 USD is held for it, the whole reservation

    @P4-S59 @need-P4-N3 @POL-15
    Scenario Outline: A reservation that starts in the future has its first window held from admission until it starts
      When "b1" is confirmed <reservation> starting in 30 days
      Then <held> USD is held for it from the moment it is confirmed until it starts
      And the ledger balance of "b1" is still 1.000000 USD

      Examples:
        | reservation                            | held     |
        | an open-ended reservation of 100 Mbps  | 0.288000 |
        | a reservation of 100 Mbps for 2 h      | 0.024000 |

    @P4-S10 @need-P4-N3 @POL-15
    Scenario: Charges accrue against the hold, and the hold rolls forward
      Given "b1" holds funds for an open-ended reservation of 100 Mbps
      When one minute's charge of 200 micro-USD is posted
      Then the ledger balance of "b1" falls by 200 micro-USD
      And the funds held still cover the next 24 h of the reservation's charges

    @P4-S60 @need-P4-N3 @POL-15 @POL-08 @POL-07
    Scenario Outline: The hold follows every change to the reservation
      Given "b1" has <reservation>, with its full hold
      When the reservation is <change>
      Then <held> USD is held for it

      Examples:
        | reservation                                                                    | change                                                       | held     |
        | an open-ended reservation of 100 Mbps from now                                 | increased by 50 Mbps when the price is 3 micro-USD per Mbps-minute | 0.504000 |
        | an open-ended reservation of 100 Mbps from now                                 | decreased to 50 Mbps                                         | 0.144000 |
        | an open-ended reservation of 100 Mbps from now, increased by 50 Mbps at 3 micro-USD per Mbps-minute | decreased to 80 Mbps, removing the most recent part first   | 0.230400 |
        | a reservation of 100 Mbps for [12:00, 22:00)                                   | shortened to end at 14:00                                    | 0.024000 |
        | an open-ended reservation of 100 Mbps from now                                 | cut to 50 Mbps when a permanent reduction's notice ends (POL-07) | 0.144000 |

    @P4-S11 @need-P4-N3 @POL-15 @POL-08
    Scenario: The unused hold is released when a reservation ends early
      Given "b1" holds funds for an open-ended reservation of 100 Mbps
      When the reservation is cancelled
      Then from the minute the cancellation takes effect no funds are held for its charges from then on
      And its charges for earlier minutes not yet posted stay held until they are posted, and the rest of the hold is released (POL-15)

    @P4-S61 @need-P4-N3 @POL-15 @POL-07 @POL-16 @POL-30
    Scenario Outline: The hold is released when Share ends a reservation
      Given "b1" holds funds for an open-ended reservation of 100 Mbps
      When the reservation is <ended>
      Then from the minute it ends no funds are held for its charges from then on
      And its charges for earlier minutes not yet posted, and any fee due, stay held until they are posted (POL-15)

      Examples:
        | ended                                              |
        | revoked at the end of `revocation_notice` (POL-07) |
        | released at the end of `suspension_grace` (POL-16) |
        | terminated by Share (POL-30)                       |

    @P4-S62 @need-P4-N3 @POL-15 @POL-27
    Scenario: An open-ended reservation's hold is resized when its new price takes effect
      Given "b1" holds 0.288000 USD for an open-ended reservation of 100 Mbps booked at 2 micro-USD per Mbps-minute
      When a new price of 3 micro-USD per Mbps-minute takes effect for it after `price_notice` (POL-27)
      Then 0.432000 USD is held for it

    @P4-S63 @need-P4-N3 @POL-15 @POL-08
    Scenario Outline: The hold is the larger of the coverage and a partner cancellation fee
      When "b1" is confirmed an open-ended reservation of 100 Mbps over a partner leg with a cancellation fee of <fee> USD shown at booking
      Then <held> USD is held for it

      Examples:
        | fee      | held     |
        | 0.500000 | 0.500000 |
        | 0.100000 | 0.288000 |

    @P4-S96 @need-P4-N3 @POL-15 @POL-08
    Scenario: The fee part of a hold ends with the partner's minimum term
      Given "b1" was confirmed an open-ended reservation of 100 Mbps over a partner leg with a minimum term of 30 days, shown at booking as a cancellation fee of 0.500000 USD, and has kept its account funded since
      And 0.500000 USD is held for it, the fee being larger than its coverage
      When the minimum term ends
      Then 0.288000 USD is held for it, its coverage alone (POL-15)

    @P4-S12 @need-P4-N3 @POL-15
    Scenario: A booking that is not confirmed holds no funds
      When a booking by "b1" ends rejected, invalid or failed
      Then no funds are held for it

    @P4-S13 @need-P4-N3 @need-P4-N17 @POL-15 @POL-18
    Scenario: A credit-limit account's reservation takes a credit hold, counted as funds held
      Given account "e1" has a `credit_limit` (POL-15) of 1.000000 USD, a ledger balance of 0 USD and nothing held
      When "e1" is confirmed an open-ended reservation of 100 Mbps from now
      Then a credit hold of 0.288000 USD is taken for it
      And the headroom of "e1" is 0.712000 USD

    @P4-S14 @need-P4-N17 @POL-15
    Scenario: A credit-limit account is invoiced monthly for its posted charges, due in invoice_terms
      Given account "e1" has a `credit_limit` (POL-15)
      When a calendar month ends
      Then "e1" is invoiced for the charges and amendments posted to it in that month
      And the invoice is due `invoice_terms` (POL-15: 30 days) after it is issued

    @P4-S66 @need-P4-N3 @POL-15 @POL-25 @POL-18
    Scenario: Holds for concurrent bookings never together exceed what headroom allowed
      Given any number of bookings and changes by "b1" and its agent keys at the same time
      When every one has its outcome
      Then the holds taken for those confirmed never together exceeded "b1"'s headroom, nor any key's headroom
      And they are the holds given by making their funds checks one at a time, in the order received, each counting the holds of the requests then in flight (POL-25)

  Rule: The buyer sees available headroom, itemised

    @P4-S15 @need-P4-N4 @POL-18
    Scenario: The headline figure is available headroom, net of funds held and usage exposure
      Given account "b1" has a ledger balance of 1.000000 USD, 0.288000 USD held, a usage exposure of 0.055750 USD and no credit limit
      When "b1" asks for its balance
      Then the headline figure is 0.656250 USD of available headroom

    @P4-S16 @need-P4-N4 @POL-18 @POL-14
    Scenario: The itemised answer adds up to the headline
      Given account "b1" has a ledger balance of 1.000000 USD, 0.288000 USD of funds held, unposted usage of 0.002000 USD, a lateness bound of 0.053750 USD and no credit limit
      And 0.000400 USD of its charges have accrued but are not yet posted
      When "b1" asks for its balance
      Then the answer shows the ledger balance 1.000000 USD, funds held 0.288000 USD, and usage exposure 0.055750 USD as unposted usage 0.002000 USD and lateness bound 0.053750 USD
      And it shows the 0.000400 USD accrued but not yet posted, for information, as within the funds held
      And the headline is 0.656250 USD: the ledger balance less the funds held less the usage exposure

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
        | account | limit | spent | key  |
        | 10.00   | 5.00  | 1.00  | 4.00 |
        | 3.00    | 5.00  | 1.00  | 3.00 |

    @P4-S68 @need-P4-N4 @POL-25 @POL-18
    Scenario Outline: A key's spending is counted over the period, each minute once
      Given account "b1" has a headroom of 10.000000 USD
      And agent key K of "b1" has a `key_spend_limit` of 1.000000 USD per `key_spend_period` (POL-25: one calendar day, UTC)
      And K's reservations have 0.288000 USD of funds held for their future charges
      And K's reservations, including any that have ended, accrued <today> USD of charges in the current period and <before> USD in the previous one
      When K asks for its balance
      Then K's spending is <spending> USD and its key headroom <headroom> USD

      Examples:
        | today    | before   | spending | headroom |
        | 0.000000 | 0.000000 | 0.288000 | 0.712000 |
        | 0.072000 | 0.000000 | 0.360000 | 0.640000 |
        | 0.072000 | 0.500000 | 0.360000 | 0.640000 |
        | 0.500000 | 0.000000 | 0.788000 | 0.212000 |
        | 0.800000 | 0.000000 | 1.088000 | -0.088000 |

    @P4-S98 @need-P4-N4 @POL-25 @POL-18 @POL-16
    Scenario: A negative key headroom blocks only that key's new bookings and additions
      Given account "b1" has a headroom of 10.000000 USD
      And agent key K of "b1" has a `key_spend_limit` of 1.000000 USD and has spent 1.088000 USD in the current `key_spend_period`, its own open-ended reservation having kept accruing, so its key headroom is -0.088000 USD (POL-25)
      When K books a reservation, or extends or increases one
      Then the booking or change is rejected, stating that the key's spending limit is exceeded
      And K's reservations are not ended, suspended or reduced, and keep accruing
      And "b1" stays active, and its other agent keys book within their own key headroom

  Rule: Suspension follows a stated cause, keeps reservations for a grace period, and reverses on funds

    Background:
      Given `suspension_grace` is equal to `coverage_window` (POL-16 default)

    @P4-S18 @need-P4-N5 @need-P4-N17 @POL-16 @POL-18 @POL-15
    Scenario Outline: An account is suspended when its headroom would fall below zero, or its invoice is overdue
      Given account "<account>" is <kind>
      When <event>
      Then "<account>" is suspended

      Examples:
        | account | kind                                    | event                                                                         |
        | b1      | prepaid, holding funds for reservations | a minute's charge is posted and its headroom cannot cover rolling the funds hold forward |
        | b1      | prepaid, holding funds for reservations | its usage exposure grows beyond what is left of its headroom                  |
        | e1      | a credit-limit account (POL-15)         | a minute's charge is posted and its headroom cannot cover rolling the credit hold forward |
        | e1      | a credit-limit account (POL-15)         | its usage exposure grows beyond what is left of its headroom                  |
        | e1      | a credit-limit account (POL-15)         | an invoice is still unpaid `invoice_terms` (POL-15) after it was issued      |

    @P4-S19 @need-P4-N5 @POL-14 @POL-16 @POL-18 @POL-06
    Scenario: Suspension comes before any account can owe more than its headroom allows
      Given any account, prepaid or with a credit limit, whose usage-priced traffic stays within its `usage_rate_cap` (POL-14)
      When its usage-priced traffic grows
      Then it is suspended no later than the moment its headroom (POL-18), net of usage exposure, would fall below zero
      And the traffic it can still carry until enforcement is within its lateness bound

    @P4-S20 @need-P4-N5 @POL-16
    Scenario: A suspended account's reservations keep their capacity during the grace
      Given account "b1" is suspended with confirmed reservations
      When less than `suspension_grace` has passed
      Then its reservations are still confirmed and keep their capacity

    @P4-S64 @need-P4-N5 @need-P4-N3 @POL-16 @POL-15
    Scenario: During suspension the hold does not roll forward; charges are taken from it
      Given account "b1" was suspended at 09:00 with one open-ended reservation of 100 Mbps at 2 micro-USD per Mbps-minute, and 0.288000 USD held for it
      When it is 15:00 and "b1" is still suspended
      Then 0.216000 USD is held for the reservation, the 0.072000 USD of charges since 09:00 having been taken from the hold

    @P4-S21 @need-P4-N5 @POL-16
    Scenario: A suspended account's usage-priced traffic is blocked
      When account "b1" is suspended
      Then network operations is told to block "b1"'s usage-priced traffic at the edge

    @P4-S22 @need-P4-N5 @POL-16
    Scenario Outline: A top-up of at least the resume amount resumes the account automatically
      Given account "b1" is suspended, with one open-ended reservation whose full coverage hold is 0.288000 USD
      And "b1" has a ledger balance of 0.216000 USD, 0.216000 USD of funds held and no usage exposure
      And its resume amount is 1.072000 USD: 0.072000 USD to restore the full hold and 1.000000 USD to reach `low_balance_warning` (POL-16)
      When "b1" tops up <top-up> USD within `suspension_grace`
      Then "b1" is <standing>

      Examples:
        | top-up   | standing                                                                       |
        | 1.072000 | active again, with no request from the buyer, and network operations is told to unblock its usage-priced traffic |
        | 0.500000 | still suspended, and told that 0.572000 USD more would resume it               |

    @P4-S23 @need-P4-N5 @POL-16
    Scenario: At the end of the grace the reservations are released and the buyer is told
      Given account "b1" is suspended
      When `suspension_grace` passes without the resume amount arriving
      Then "b1"'s reservations are released, and their capacity is available to other buyers
      And the buyer is told which reservations were released and why

    @P4-S24 @need-P4-N5 @POL-16 @POL-18
    Scenario Outline: The buyer is warned when headroom falls below low_balance_warning, with the top-up quoted
      Given account "b1" whose reservations' charges for one coverage window are <window> USD
      When its headroom falls from above <threshold> USD to <headroom> USD
      Then the buyer is warned that headroom is below `low_balance_warning` (POL-16), <threshold> USD
      And the warning quotes a top-up of <quote> USD: `low_balance_warning` plus one coverage window's charges, less the headroom

      Examples:
        | window    | threshold | headroom | quote     |
        | 0.288000  | 1.000000  | 0.900000 | 0.388000  |
        | 28.800000 | 7.200000  | 7.000000 | 29.000000 |
        | 0.000000  | 1.000000  | 0.500000 | 0.500000  |

    @P4-S69 @need-P4-N5 @POL-16 @POL-18
    Scenario: The buyer is warned once per crossing, not repeatedly
      Given account "b1" has been warned that its headroom fell below `low_balance_warning`
      When its headroom keeps falling, without rising above `low_balance_warning` again
      Then no further warning is sent
      And a new warning is sent only after headroom has risen above `low_balance_warning` and fallen below it again

    @P4-S70 @need-P4-N5 @need-P4-N13 @POL-16 @POL-21 @POL-23
    Scenario: After a reversal leaves the hold unfunded, reservations are still kept for the full grace, at Share's risk
      Given account "b1" has a ledger balance of 0.300000 USD and 0.288000 USD held for an open-ended reservation
      When the provider reverses a 5.000000 USD top-up that "b1" had already spent
      Then "b1"'s ledger balance is -4.700000 USD and it is suspended
      And its reservation keeps its capacity and accrues for the full `suspension_grace`
      And beyond the reversed amount, Share bears at most one coverage window of grace charges, 0.288000 USD, if the account does not pay (POL-23)

    @P4-S65 @need-P4-N5 @POL-16 @POL-18
    Scenario: A top-up racing a suspension ends in the standing the final headroom implies
      Given account "b1" is about to be suspended because its hold cannot roll forward
      When a top-up of at least the resume amount arrives at the same moment
      Then "b1" ends active, as it would had the two been applied one after the other in either order

    @P4-S97 @need-P4-N5 @need-P4-N13 @POL-16 @POL-15 @POL-08 @POL-21 @POL-23
    Scenario: At release, a shown cancellation fee is charged against what is left of the hold, and any shortfall is a negative balance
      Given account "b1" was suspended with a ledger balance of 0.500000 USD and 0.500000 USD held for its one reservation: open-ended, 100 Mbps at 2 micro-USD per Mbps-minute, over a partner leg whose cancellation fee of 0.500000 USD was shown at booking
      And the reservation is within the partner's minimum term
      When `suspension_grace` passes without funds and the reservation is released
      Then 0.288000 USD of charges were taken from the hold during the grace, leaving 0.212000 USD
      And the fee of 0.500000 USD is charged, leaving a ledger balance of -0.288000 USD
      And that negative balance is collected from the next top-up or written off (POL-21), at Share's cost (POL-23), Share's loss being at most the lower of the fee and the coverage

    @P4-S101 @need-P4-N5 @need-P4-N3 @POL-16 @POL-15 @POL-27 @POL-18 @POL-21 @POL-23
    Scenario: A price change whose larger hold the headroom cannot cover still takes effect, and the account is suspended as for a failed roll-forward
      Given account "b1" has a ledger balance of 0.388000 USD and 0.288000 USD held for one open-ended reservation of 100 Mbps booked at 2 micro-USD per Mbps-minute, a headroom of 0.100000 USD (POL-18)
      And "b1" was warned when its headroom fell below `low_balance_warning`
      And a new price of 3 micro-USD per Mbps-minute for it was announced `price_notice` (POL-27) ago
      When the new price takes effect, needing a hold of 0.432000 USD
      Then the reservation accrues 300 micro-USD a minute from then
      And "b1" is suspended, as when a hold cannot roll forward, because the 0.144000 USD more that the hold needs exceeds its headroom
      And the hold grows by the 0.100000 USD the headroom allows, to 0.388000 USD (POL-16)
      And the reservation keeps its capacity for the full `suspension_grace` (POL-16)
      And if "b1" does not resume, the 0.044000 USD of the grace's 0.432000 USD of charges beyond the hold becomes a negative balance under POL-21 and POL-23

    @P4-S108 @need-P4-N5 @POL-27 @POL-16 @POL-18
    Scenario: A price notice that the account's headroom would not cover states the top-up that would
      Given account "b1" has a headroom of 0.100000 USD (POL-18) and 0.288000 USD held for one open-ended reservation of 100 Mbps at 2 micro-USD per Mbps-minute
      When a new price of 3 micro-USD per Mbps-minute for it is announced, to take effect `price_notice` (POL-27) later
      Then the notice to "b1" states the new price and the hold of 0.432000 USD it will need
      And it states that "b1"'s headroom would not cover the 0.144000 USD more, and quotes a top-up of 0.044000 USD that would

  Rule: Network operations always knows an account's standing

    @P4-S25 @need-P4-N6 @POL-16 @POL-06
    Scenario: Each change of standing is delivered at least once, within standing_notice_time, and repeats change nothing
      When account "b1"'s standing changes
      Then network operations is notified of the new standing at least once, within `standing_notice_time` (POL-06) of the decision
      And receiving the same notification again changes nothing

    @P4-S26 @need-P4-N6 @POL-16
    Scenario: The current standing can be asked for at any time
      When network operations asks for account "b1"'s standing
      Then the answer is its current standing and since when

    @P4-S27 @need-P4-N6 @POL-16 @POL-06
    Scenario: Enforcement later than its target is reported
      Given account "b1" was suspended
      When its usage-priced traffic is not blocked within the suspension-to-enforcement target (POL-06, X2)
      Then the late enforcement is reported to operations and finance

  Rule: Money is conserved and history cannot be rewritten

    @P4-S28 @need-P4-N7 @POL-20
    Scenario: Every money movement, and the ledger in each currency, sums to zero
      When any top-ups, conversions, charges, amendments, payouts, reversals and write-offs are posted
      Then every money movement sums to zero
      And the sum of all entries in the ledger in each currency is zero
      And taking or releasing a funds hold or credit hold posts no money movement

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

    @P4-S71 @need-P4-N16 @POL-19
    Scenario: Every money movement refers to the fact that caused it
      When any money movement is posted
      Then it refers to its source: a charge or amendment, a payment notification, an invoice, a payout instruction or confirmation, or an operator action with its reason

    @P4-S72 @need-P4-N16 @POL-18 @POL-19
    Scenario: Any account's past balance, holds and headroom can be rebuilt from recorded facts
      Given any account and any past moment within the retention period
      When its ledger balance, funds held and headroom at that moment are rebuilt from the recorded facts
      Then they equal what the account was shown at that moment

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

    @P4-S73 @need-P4-N8 @POL-12
    Scenario Outline: Ties among suppliers are broken in route leg order, first leg first
      Given a route whose first leg is supplier "s2"'s and whose second leg is supplier "s1"'s, each with weight 1, and Share's commission with weight 1
      When <amount> micro-USD is split among them
      Then "s2", "s1" and Share's commission receive <s2>, <s1> and <share> micro-USD

      Examples:
        | amount | s2 | s1 | share |
        | 1      | 1  | 0  | 0     |
        | 2      | 1  | 1  | 0     |
        | 3      | 1  | 1  | 1     |

    @P4-S102 @need-P4-N8 @POL-12
    Scenario Outline: A supplier with several legs on a route is one party, its legs' weights summed, in the tie position of its first leg
      Given a route whose legs are, in order, supplier "s"'s with weight 1, supplier "t"'s with weight 2 and supplier "s"'s with weight 1, and Share's commission with weight 1
      When <amount> micro-USD is split among them
      Then "s", "t" and Share's commission receive <s>, <t> and <share> micro-USD, "s" being one party of weight 2 placed at leg 1

      Examples:
        | amount | s | t | share |
        | 1      | 1 | 0 | 0     |
        | 2      | 1 | 1 | 0     |
        | 3      | 1 | 1 | 1     |
        | 4      | 2 | 1 | 1     |

    @P4-S74 @need-P4-N8 @POL-11 @POL-12
    Scenario: Each usage charge line is split among the parties of its own route
      Given account "a1" has a usage charge line on route "R1" and another on route "R2" for the same minute
      When both are settled
      Then the charge on "R1" is split only among the parties of "R1", by their weights
      And the charge on "R2" only among the parties of "R2", by theirs

    @P4-S75 @need-P4-N8 @need-P4-N9 @POL-11 @POL-12
    Scenario: An amendment is split as the split of the line's new total less the shares already posted
      Given parties "a", "b" and "c" with weights 31, 76 and 70, whose shares of a charge line of 31 micro-USD were posted as 6, 13 and 12
      When an amendment of 1 micro-USD for late traffic is settled, making the line's total 32
      Then "a", "b" and "c" receive 0, 1 and 0 micro-USD of the amendment, leaving them at 6, 14 and 12

    @P4-S85 @need-P4-N8 @need-P4-N9 @POL-12 @POL-23
    Scenario: After a correction borne by Share, a later amendment to the same line is split on its own
      Given supplier "s" with weight 3 and Share's commission with weight 1, whose shares of a charge line of 4 micro-USD were posted as 3 and 1
      And a price correction caused by Share's error reduced the line by 2 micro-USD, borne by Share in full
      When an amendment of 1 micro-USD for late traffic is settled
      Then "s" receives 1 micro-USD of it and Share's commission 0
      And no party's amount falls

    @P4-S37 @need-P4-N8 @POL-12
    Scenario: Cumulative deviation from exact proportions is reported per party per payout period
      When a payout period ends
      Then each party is shown the signed total by which its shares in the period differ from its exact proportions

  Rule: Late charges settle exactly like on-time ones

    @P4-S38 @need-P4-N9
    Scenario: Every account ends at the split of each line's final total, whatever the arrival order
      Given any set of flow records for several reservations and minutes, with no borne corrections
      When they are delivered once each in order and settled
      And separately delivered in any order, partly repeated and partly after their minute was charged, and settled
      Then every account's ledger balance is the same in both cases

    @P4-S39 @need-P4-N9
    Scenario: A late-traffic amendment never reduces any party's amount and never credits the buyer
      When any late-traffic amendment is settled
      Then the buyer's wallet is debited and no party is debited

  Rule: Every account can check its statement

    @P4-S40 @need-P4-N10 @POL-12 @POL-22 @POL-23
    Scenario: A supplier's statement shows each share, how it was produced, and everything else that moved its balance
      When supplier A asks for its statement for a period
      Then each charge's share is shown with the charge, the weights, and the published rule and tie order
      And it shows each payout, each supplier debt with its reason, the residue carried, each amount Share paid it with its reason, and its deviation from exact proportions
      And every share can be recomputed from what the statement shows

    @P4-S76 @need-P4-N10 @POL-20 @POL-21
    Scenario: A buyer's statement shows every movement of its money, with reasons and rates
      When buyer "b1" asks for its statement for a period
      Then it shows each charge and amendment with its reason, each top-up with its conversion rate, each reversal and each write-off

  Rule: Supplier earnings are final, except for the supplier's own errors

    @P4-S41 @need-P4-N11 @POL-23
    Scenario: A correction caused by Share's error is borne by Share in full
      Given a charge of 100.000000 USD on "R1" was posted and split, Share's commission share being 15.000000 USD
      When a price correction with the cause "Share" reduces it by 40.000000 USD
      Then the buyer is credited 40.000000 USD
      And the whole 40.000000 USD is borne from Share's own account, though it exceeds the commission on that charge
      And no supplier's balance changes

    @P4-S84 @need-P4-N11 @POL-23
    Scenario: A correction whose cause is "other" is borne by Share, as for a Share error
      Given a charge on "R1" was posted and split
      When a price correction with the cause "other" reduces it
      Then the buyer is credited the reduction, borne from Share's own account
      And no supplier's balance changes

    @P4-S42 @need-P4-N11 @POL-22 @POL-23 @POL-12
    Scenario: A supplier-caused error makes only that supplier owe its own reduction
      Given a charge of 100.000000 USD on "R1" was posted and split as 30.000000 USD to supplier A, 33.330000 to B, 21.670000 to C and 15.000000 to Share's commission
      When a price correction caused by supplier A's error reduces the charge to 60.000000 USD
      Then the buyer is credited 40.000000 USD
      And supplier A owes 12.000000 USD as a supplier debt: its share of 60.000000 USD is 18.000000
      And Share bears B's reduction of 13.332000 USD, C's of 8.668000 USD and its own commission's of 6.000000 USD
      And the balances of B and C do not change
      And A's statement shows the debt and its reason

    @P4-S56 @need-P4-N11 @POL-17 @POL-23 @POL-12
    Scenario: Excess carried despite policing is paid to the route's suppliers by Share, split as the buyer's charge would have been
      Given route "R1" with supplier A weighted 3000, supplier B 3333, supplier C 2167 and Share's commission 1500
      And P3 found 1 GB of excess carried on "R1" for buyer "b1", on a product without burst whose `usage_price` (POL-17) is 10,000 micro-USD per GB
      When it is settled
      Then suppliers A, B and C are credited 3,000, 3,333 and 2,167 micro-USD from Share's own account, the Webster split of 10,000 micro-USD among the parties of "R1" (POL-12, POL-23), each as its own movement
      And no share is posted to Share's commission
      And "b1"'s wallet is not debited for it

    @P4-S77 @need-P4-N11 @POL-23 @POL-07 @POL-08 @POL-28 @POL-12
    Scenario Outline: Every cost Share bears is paid from Share's own account to the supplier concerned
      When Share bears <cost>
      Then a money movement from Share's own account to <payee> is posted, with its reason
      And it is shown on that supplier's statement
      And the buyer's charges are unchanged

      Examples:
        | cost                                                                                 | payee                                   |
        | the cancellation of a partner booking left without Share's confirmation, at a partner with or without holds (POL-28) | that partner |
        | the price difference of an accepted equivalent path dearer than the original price (POL-07) | each supplier of the equivalent path, its share of the Webster split of the difference among the path's parties (POL-12); the commission share is not posted |
        | a partner fee that was not shown at booking (POL-08)                                 | that partner                            |
        | a cancellation fee on a reservation revoked under POL-07                             | that partner                            |
        | a cancellation fee on a reservation its holder cancelled after its rate was cut under POL-07 (POL-08) | that partner                |

    @P4-S89 @need-P4-N11 @POL-08
    Scenario: A cancellation fee charged to a buyer goes wholly to the partner that imposed it
      Given buyer "b1" is charged a cancellation fee of 0.500000 USD shown at booking for partner P's leg of a route
      When the fee is settled
      Then partner P is credited 0.500000 USD
      And no other supplier and no commission receive any of it

    @P4-S110 @need-P4-N11 @POL-07 @POL-23 @POL-11
    Scenario: The difference Share bears on a dearer equivalent path is the path's charge rounded down once, less the buyer's charge
      Given a reservation of 3 Mbps moved to a dearer equivalent path, its buyer paying its original price of 1.5 micro-USD per Mbps-minute (POL-07)
      And the new path's price is 2.7 micro-USD per Mbps-minute
      When a minute of it is charged
      Then the buyer is charged 4 micro-USD, 4.5 rounded down once (POL-11)
      And Share bears 4 micro-USD: the path's 8.1 micro-USD rounded down once to 8, less the buyer's 4 (POL-23)

    @P4-S115 @need-P4-N11 @POL-23 @POL-07 @POL-11 @POL-32
    Scenario: A later correction of the buyer's price does not change the difference Share bore on a dearer path
      Given the minute of P4-S110 was charged, the buyer 4 micro-USD and Share bearing a difference of 4 micro-USD
      When an operator in finance (POL-32) corrects the buyer's price for that minute down to 1.0 micro-USD per Mbps-minute, with cause "Share" (POL-23)
      Then the buyer's charge for that minute is amended to 3 micro-USD, 3.0 rounded down once (POL-11)
      And the difference Share bore stays 4 micro-USD: the path's 8 less the buyer's charge as booked, 4
      And no supplier of the path is paid again

    @P4-S116 @need-P4-N11 @POL-23 @POL-17 @POL-22 @POL-12
    Scenario Outline: A cost Share has paid a supplier is final, except that supplier's own reduction when its exporter erred
      Given Share paid suppliers A, B and C 3,000, 3,333 and 2,167 micro-USD for 1 GB of excess carried on "R1", as in P4-S56
      When <exporter> submits a superseding record that lowers that excess to 0.5 GB, within `dispute_window` (POL-17)
      Then <result>

      Examples:
        | exporter                                       | result                                                                                                       |
        | the Share exporter that produced the record    | A, B and C keep what they were paid, and no movement is posted to any supplier (POL-23)                      |
        | supplier A's exporter that produced the record | A owes its own reduction, 1,500 micro-USD, as a supplier debt (POL-22): its share of 5,000 micro-USD is 1,500 (POL-12); B and C keep what they were paid |

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

    @P4-S78 @need-P4-N12 @POL-22 @POL-29
    Scenario: An amount in an unconfirmed payout is in no other payout
      Given a payout of 120.00 USD to supplier A was issued and is neither confirmed nor failed
      And supplier A has since earned 70.000000 USD
      When the next weekly payout runs
      Then a payout of 70.00 USD to supplier A is issued, and the 120.00 USD is not paid again

    @P4-S79 @need-P4-N12 @need-P4-N15 @POL-22 @POL-29
    Scenario: A transfer confirmation delivered more than once settles once
      Given a payout of 120.00 USD to supplier A was issued
      When its transfer confirmation is delivered three times
      Then the payout is complete, and what supplier A is owed fell by 120.000000 USD once

    @P4-S86 @need-P4-N12 @POL-22
    Scenario: After a final failure, the amount is paid in the next weekly run under a new instruction
      Given a payout of 120.00 USD to supplier A was reported failed by the provider as final
      When the next weekly payout runs
      Then the 120.00 USD is included in a new payout instruction with a new reference

    @P4-S87 @need-P4-N12 @POL-22
    Scenario: A confirmation arriving after a reported failure is escalated, and the amount is not paid again while it is open
      Given a payout of 120.00 USD to supplier A was reported failed
      When a confirmation of that transfer then arrives
      Then it is escalated to finance for reconciliation
      And the 120.00 USD is in no new payout while the escalation is open

    @P4-S95 @need-P4-N12 @need-P4-N11 @POL-22 @POL-29
    Scenario: A late confirmation of a transfer already re-instructed after its final failure becomes a duplicate-payout debt
      Given a payout of 120.00 USD to supplier A was reported failed as final, and the 120.00 USD was re-instructed and paid in the next weekly run
      When a confirmation of the original transfer arrives
      Then it is escalated to finance
      And supplier A has a supplier debt of 120.000000 USD marked "duplicate payout", netted against its next payouts and invoiced if open more than 90 days (POL-22)
      And its earnings are unchanged, its statement shows the debt as "duplicate payout", and the debt does not count in its deviation from exact proportions

    @P4-S88 @need-P4-N12 @POL-22
    Scenario: A payout neither confirmed nor failed within payout_confirmation_timeout is escalated, not reissued
      Given a payout of 120.00 USD to supplier A was issued
      When `payout_confirmation_timeout` (POL-22: 7 days) passes with neither a confirmation nor a failure
      Then the payout is escalated to finance
      And it is not instructed again automatically

    @P4-S46 @need-P4-N12 @POL-22 @POL-29
    Scenario: A payout run that is repeated or retried pays each supplier at most once
      When the same weekly payout run is executed more than once
      Then each supplier is paid at most once for that run

    @P4-S47 @need-P4-N12 @POL-11 @POL-22
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

    @P4-S67 @need-P4-N12 @POL-22
    Scenario: A supplier debt posted while a payout is being prepared is netted exactly once
      Given supplier A is owed 80.000000 USD and the weekly payout is being prepared
      When a supplier debt of 15.000000 USD for A is posted at the same moment
      Then the debt is netted either in this payout (65.00 USD) or in the next one, never in both and never lost

    @P4-S49 @need-P4-N12 @POL-22
    Scenario: A supplier debt open for more than 90 days is invoiced
      Given supplier A has a supplier debt
      When 90 days pass with the debt still open
      Then supplier A is invoiced for it

    @P4-S50 @need-P4-N12 @POL-20 @POL-11 @POL-22
    Scenario: A supplier paid in another currency is converted at the shown rate, rounded down, with the residue carried in USD
      Given supplier A is owed 120.004567 USD and is paid in KES by a provider whose minor unit is 1 KES
      And the rate shown for the payout is 129.5 KES per USD
      When the weekly payout runs
      Then a payout of 15,540 KES is issued, exactly 15,540.5914265 KES rounded down
      And supplier A is still owed 0.004567 USD, the residue of 0.5914265 KES converted back at the same rate
      And the rate is recorded

  Rule: Reversals and bad debt are borne by Share, never by suppliers

    @P4-S51 @need-P4-N13 @POL-21 @POL-18 @POL-16
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
    Scenario: A negative balance not recovered within 90 days of the reversal is written off automatically, at Share's cost
      Given account "b1" has had a negative ledger balance since a reversal
      When 90 days pass after the reversal without the balance being recovered
      Then the balance is written off automatically
      And the loss is borne by Share
      And the written-off amount stays recorded as owed by "b1"
      And no supplier's balance changes

    @P4-S94 @need-P4-N13 @need-P4-N5 @POL-21 @POL-15 @POL-16 @POL-18
    Scenario Outline: After a write-off the account stays suspended until a top-up repays Share, and then resumes by the usual rule
      Given account "<account>" had <owed> USD of <kind> written off, has no reservations, a ledger balance of 0.000000 USD and is suspended
      When "<account>" tops up <top-up> USD
      Then <repaid> USD of it goes to Share's own account, repaying the written-off amount (POL-21)
      And its ledger balance is <balance> USD
      And "<account>" is <standing>

      Examples:
        | account | owed      | kind                          | top-up    | repaid    | balance  | standing                                                                       |
        | b1      | 4.700000  | a negative balance after a reversal | 4.000000  | 4.000000  | 0.000000 | still suspended, with 0.700000 USD still owed, and cannot book            |
        | b1      | 4.700000  | a negative balance after a reversal | 5.700000  | 4.700000  | 1.000000 | active again, its headroom of 1.000000 USD reaching `low_balance_warning` (POL-16) |
        | e1      | 10.000000 | an unpaid invoice             | 11.000000 | 10.000000 | 1.000000  | active again as a prepaid account, with no credit limit (POL-15)            |

    @P4-S107 @need-P4-N13 @POL-21 @POL-15 @POL-23
    Scenario: A negative balance not caused by a reversal is written off 90 days after it arose
      Given account "b1"'s ledger balance became -0.288000 USD on day D, when a shown cancellation fee exceeded what was left of its hold at release (P4-S97)
      And no top-up has repaid it
      When 90 days have passed since day D
      Then the 0.288000 USD is written off automatically, at Share's cost (POL-23), and stays recorded as owed by "b1" (POL-21)
      And no supplier's balance changes

    @P4-S112 @need-P4-N13 @POL-21 @POL-15 @POL-23
    Scenario Outline: On a credit-limit account, the 90-day clock runs only on the negative balance no invoice covers
      Given credit-limit account "e1" has, since day D, a ledger balance of <balance>, with 1.000000 USD invoiced and unpaid (its write-off following POL-15) and 1.500000 USD of charges posted since its last invoice was issued
      When 90 days have passed since day D, its uncovered negative balance having stayed the same
      Then <result>

      Examples:
        | balance       | result                                                                                                                                                                         |
        | -2.500000 USD | nothing is written off under POL-21, the uncovered negative balance being max(0, 2.500000 - 1.000000 - 1.500000) = 0                                                           |
        | -3.000000 USD | the uncovered negative balance, max(0, 3.000000 - 1.000000 - 1.500000) = 0.500000 USD, is written off automatically, at Share's cost (POL-23), and stays recorded as owed by "e1" |

  Rule: Credit is given only to vetted accounts, and collected by rule

    @P4-S82 @need-P4-N17 @POL-15 @POL-24 @POL-32
    Scenario: A credit limit can be set only on an account that has passed know-your-business checks
      Given account "e2" has not passed know-your-business checks (POL-24)
      When an operator in the finance role (POL-32) tries to set a `credit_limit` for "e2"
      Then the attempt is refused and recorded, and "e2" has no credit limit

    @P4-S83 @need-P4-N17 @need-P4-N13 @POL-15 @POL-21 @POL-23 @POL-32 @POL-16
    Scenario: An invoice unpaid 90 days after its due date is written off at Share's cost
      Given credit-limit account "e1" has an invoice unpaid since its due date, and is suspended
      When 90 days pass after the due date
      Then the unpaid amount is written off at Share's cost, and stays recorded as owed by "e1"
      And "e1" loses its credit limit, and books prepaid until a finance operator sets one again (POL-32)
      And no supplier's balance changes

    @P4-S92 @need-P4-N17 @need-P4-N5 @POL-15 @POL-16 @POL-18
    Scenario: An account suspended for an overdue invoice stays suspended whatever its headroom
      Given credit-limit account "e1" has a `credit_limit` of 5.000000 USD, a ledger balance of -1.000000 USD, a credit hold of 0.288000 USD for its one open-ended reservation and no usage exposure
      And "e1" is suspended because an invoice of 1.000000 USD is unpaid `invoice_terms` after it was issued
      And with its full credit hold in place its headroom is 3.712000 USD, above `low_balance_warning` (1.000000 USD)
      When a minute's charge of "e1" is posted during the suspension
      Then "e1" is still suspended, because the invoice is still overdue (POL-16)

    @P4-S93 @need-P4-N17 @need-P4-N5 @POL-15 @POL-16 @POL-18
    Scenario: Paying every overdue invoice resumes the account, if the headroom rule also holds
      Given credit-limit account "e1" is suspended as in P4-S92, with one overdue invoice of 1.000000 USD
      When "e1" pays that invoice in full within `suspension_grace`
      Then "e1" is active again, with no request from the buyer, its ledger balance being 0.000000 USD and its headroom 4.712000 USD
      And network operations is told to unblock its usage-priced traffic

    @P4-S105 @need-P4-N17 @need-P4-N5 @POL-15 @POL-16 @POL-18 @POL-24
    Scenario: A top-up to an account with an overdue invoice pays that invoice first, and can resume the account
      Given credit-limit account "e1" is suspended as in P4-S92, with one overdue invoice of 1.000000 USD
      When "e1" tops up 1.500000 USD within `suspension_grace`
      Then 1.000000 USD of it pays the overdue invoice, recorded as an invoice payment (POL-24), and 0.500000 USD raises its ledger balance to 0.500000 USD
      And "e1" is active again, with no request from the buyer, its headroom being 5.212000 USD (POL-16)

    @P4-S111 @need-P4-N5 @need-P4-N13 @need-P4-N17 @POL-15 @POL-21 @POL-24 @POL-16
    Scenario: A top-up repays a written-off amount first, then overdue invoices oldest first, then raises the balance
      Given account "e1" is suspended, owing a written-off amount of 1.000000 USD from an invoice written off 90 days after its due date (POL-15)
      And invoice I2 of 0.500000 USD, issued to "e1" before that write-off, is overdue, and "e1"'s ledger balance is -0.500000 USD, with no other charges
      When "e1" tops up 2.000000 USD
      Then 1.000000 USD of it repays the written-off amount, to Share's own account (POL-21)
      And 0.500000 USD of it then pays I2, recorded as an invoice payment (POL-24), and the remaining 0.500000 USD raises its ledger balance to 0.500000 USD

    @P4-S114 @need-P4-N5 @need-P4-N17 @POL-16 @POL-15 @POL-21 @POL-18
    Scenario Outline: The resume amount is the least top-up that resumes the account, itemised
      Given <account>
      When "e1" is told the amount that would resume it
      Then the resume amount is <amount> USD, itemised as <items>

      Examples:
        | account                                                                                                                                                                                         | amount   | items                                                                                                                  |
        | credit-limit account "e1" is suspended as in P4-S92, with one overdue invoice of 1.000000 USD                                                                                                   | 1.000000 | the overdue invoice, 1.000000 USD, after whose payment headroom is 4.712000 USD and nothing more is needed (POL-16)    |
        | account "e1" is suspended as in P4-S111 before its top-up, owing the written-off amount of 1.000000 USD and I2 of 0.500000 USD, with no credit limit since the write-off (POL-15), and no reservations or usage exposure | 2.500000 | the written-off amount, 1.000000 USD; I2, 0.500000 USD; and 1.000000 USD to reach `low_balance_warning` (POL-16)        |

  Rule: The books are reconciled with the money daily

    @P4-S54 @need-P4-N14 @POL-24
    Scenario Outline: The daily reconciliation proves what must agree, and reports every difference
      Given for day D <difference>
      When the reconciliation of day D runs
      Then the difference is raised to finance as an operational alert

      Examples:
        | difference                                                                                                                              |
        | the funds held at the payment partner differ from the signed sum of buyer balances and supplier balances, plus Share's own balance there, less payouts the partner has executed that the ledger has not yet confirmed, plus payments the partner has received and reported that the ledger has not yet posted, less payments the ledger has posted that the partner has not yet received |
        | a payment counted as received by the partner and not yet posted by the ledger matches no credit in the partner's report                  |
        | a provider transaction in the partner's report matches no ledger top-up, invoice payment, reversal, payout, supplier-debt payment or movement of Share's own funds |
        | a ledger top-up, invoice payment, reversal, payout, supplier-debt payment or movement of Share's own funds matches no provider transaction in the partner's report |
        | a provider transaction matches more than one ledger movement                                                                            |

    @P4-S90 @need-P4-N14 @POL-24 @POL-21 @POL-15 @POL-22
    Scenario Outline: Funds at the partner equal the signed balances, less payouts executed but not yet confirmed, plus payments received but not yet posted, and no alert is raised
      Given at the end of day D the payment partner holds <partner> USD
      And buyer balances sum to <buyers> USD, supplier balances to <suppliers> USD and Share's own balance there is <share> USD, each signed
      And payouts the partner has executed that the ledger has not yet confirmed total <in flight> USD, each matched to its partner debit
      And payments the partner has received and reported that the ledger has not yet posted total <received> USD, each matched to its partner credit
      When the reconciliation of day D runs
      Then it finds <partner> = <buyers> + <suppliers> + <share> - <in flight> + <received>
      And no alert is raised

      Examples:
        | partner    | buyers     | suppliers  | share     | in flight  | received  | case                                                                                    |
        | 4.250000   | -5.000000  | 4.250000   | 5.000000  | 0.000000   | 0.000000  | a spent 5.000000 USD top-up reversed; Share's 0.750000 commission plus 4.250000 it added cover the 5.000000 owed |
        | 8.500000   | -10.000000 | 8.500000   | 10.000000 | 0.000000   | 0.000000  | a credit-limit account mid-cycle with 10.000000 USD posted; Share's 1.500000 commission plus 8.500000 it added cover it |
        | 0.000000   | 0.000000   | 120.000000 | 0.000000  | 120.000000 | 0.000000  | a 120.00 USD payout the partner has executed, not yet confirmed                          |
        | 100.000000 | 50.000000  | 35.000000  | 15.000000 | 0.000000   | 0.000000  | supplier balances of 50.000000 and -15.000000, a supplier debt that Share's balance covers |
        | 25.000000  | 0.000000   | 0.000000   | 0.000000  | 0.000000   | 25.000000 | a 25.00 USD top-up the partner received just before the cut, posted by the ledger after it |
        | 95.000000  | 50.000000  | 120.000000 | 0.000000  | 100.000000 | 25.000000 | a 100.00 USD payout executed, not yet confirmed, and a 25.00 USD invoice payment received, not yet posted |

    @P4-S91 @need-P4-N14 @POL-24 @POL-21 @POL-23
    Scenario: Share's own balance below the receivables it funds is an alert, even when the sums agree
      Given buyer "b1" spent a 5.000000 USD top-up, leaving suppliers owed 4.250000 USD and Share's commission 0.750000 USD, and the top-up was then reversed
      And Share has added nothing to its own balance at the partner, which holds 0.000000 USD
      When the reconciliation of day D runs
      Then it finds 0.000000 = -5.000000 + 4.250000 + 0.750000
      And it raises an operational alert that Share's own balance, 0.750000 USD, does not cover the 5.000000 USD receivable it funds, so the 4.250000 USD owed to suppliers is not covered by funds at the partner
      And no movement owed to a buyer or supplier is refused or delayed because of it (POL-24)

    @P4-S104 @need-P4-N14 @POL-24 @POL-29
    Scenario Outline: Every kind of partner transaction is matched to one ledger movement, and raises no alert
      Given on day D the payment partner reports <transaction>
      And the ledger records it as one <movement>, with its source reference (POL-29)
      When the reconciliation of day D runs
      Then the provider transaction matches that one ledger movement
      And no alert is raised for it

      Examples:
        | transaction                                                      | movement                                          |
        | a deposit of 4.250000 USD of Share's own funds                   | movement of Share's own funds (a deposit)         |
        | a withdrawal of 1.500000 USD of Share's commission               | movement of Share's own funds (a withdrawal)      |
        | a credit-limit account's payment of a 10.000000 USD invoice      | invoice payment                                   |
        | a supplier's payment of a 15.000000 USD supplier debt invoiced to it | supplier-debt payment                         |

    @P4-S106 @need-P4-N14 @POL-24
    Scenario Outline: A payment posted before the partner received it is counted in flight, and alerts only if not received within settlement_lag_max
      Given buyer "b1" was credited a top-up of 20.000000 USD that its payment provider notified before settling it to the payment partner
      And at the end of day D the partner has not yet received it and holds 80.000000 USD, while buyer balances sum to 100.000000 USD and supplier balances and Share's own balance to 0.000000 USD
      When the reconciliation of day D runs, <age> after the top-up was posted
      Then it finds 80.000000 = 100.000000 + 0.000000 - 20.000000, the top-up counted as posted and not yet received (POL-24)
      And <alert>

      Examples:
        | age    | alert                                                                                                        |
        | 2 days | no alert is raised                                                                                           |
        | 8 days | an operational alert is raised that the payment was not received within `settlement_lag_max` (POL-24: 7 days) |

    @P4-S113 @need-P4-N14 @POL-24 @POL-21
    Scenario: A payment posted before the partner received it, and reversed before it did, nets to zero and raises no alert
      Given buyer "b1" was credited a top-up of 20.000000 USD that its payment provider notified before settling it to the payment partner
      And the provider then reversed it, and the reversal was posted, before the partner received the payment
      When the reconciliation of that day, and of every later day, runs
      Then the top-up and its reversal net to zero in the payments posted and not yet received (POL-24)
      And they are matched to each other, with no partner transaction for either
      And no alert is raised for them, even once `settlement_lag_max` (POL-24) has passed

    @P4-S109 @need-P4-N14 @need-P4-N2 @POL-24 @POL-20
    Scenario: A payment received before the cut and posted after it, with its FX difference, is counted at the partner's USD amount and raises no alert
      Given the payment partner received a top-up of 1,234 KES for "b1" before the end of day D and reports it as 9.520000 USD
      And after the cut the ledger credits "b1" 9.516979 USD for it, and posts its FX difference of +0.003021 USD to Share's own account (POL-20)
      When the reconciliation of day D runs
      Then the top-up is counted as received and not yet posted at 9.520000 USD, the partner's amount (POL-24)
      And no alert is raised for it

    @P4-S80 @need-P4-N14 @POL-24
    Scenario Outline: Provider settlement reports and bank statements are reconciled daily by the same rule
      Given for day D <source> differs from the ledger
      When the reconciliation of day D runs
      Then each difference is raised to finance as an operational alert

      Examples:
        | source                                         |
        | a payment provider's settlement report         |
        | a bank statement                               |

    @P4-S81 @need-P4-N14 @POL-24
    Scenario: A reconciliation not completed by 12:00 UTC on the next day is an operational alert
      When it is 12:00 UTC on day D + 1 and the reconciliation of day D has not completed
      Then finance is alerted
