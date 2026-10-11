# P4. Wallet, ledger and supplier revenue split
# Problem statement: docs/01-discovery/P4-wallet-and-settlement.md
# Design:            docs/03-rfcs/RFC-004-wallet-and-settlement.md
#
# Starts where P3 ends: P3 decides when a (reservation, minute) is charged and what its
# total is; this spec covers how money enters wallets, how every charge is split and
# recorded, and how suppliers are paid.
#
# Money in these scenarios is in micros (10⁻⁶ of the currency unit): 1 unit of currency = 1,000,000 micros.

Feature: Wallet, ledger and supplier revenue split

  As a buyer
  I want my prepaid top-ups credited exactly once and my balance always accurate
  so that I am charged only for what I use and never lose a payment

  As a supplier on a route
  I want my exact share of every charge, regular or late, paid out automatically
  so that I earn the same whatever order the usage records arrived in

  As the marketplace's finance team
  I want books that always balance and a history nobody can rewrite
  so that every balance can be explained and audited

  Background:
    Given route "R1" is split between these parties by weight:
      | account       | weight |
      | supplier:A    | 3000   |
      | supplier:B    | 3333   |
      | supplier:C    | 2167   |
      | revenue:share | 1500   |

  Rule: A payment notification changes the wallet exactly once

    @P4-S01 @verified
    # Verified by: billing/test/wallet.test.ts › "payment webhooks (D19 wallet) › repeated and out-of-order webhooks credit the wallet exactly once"
    Scenario: Repeated deliveries credit the wallet once
      Given the payment provider sends these notifications for customer "c1":
        | provider transaction | type      | amount micros |
        | MP1                  | completed | 5000000       |
        | MP2                  | completed | 3000000       |
        | MP2                  | reversed  | 3000000       |
      When each notification is delivered three times in a shuffled order
      Then every delivery is answered with HTTP 200
      And exactly 3 deliveries are reported as "applied"
      And the wallet of "c1" holds 5000000 micros
      And every journal in the ledger balances

    @P4-S02 @unverified
    # The test for P4-S01 shuffles with a fixed seed whose order never puts the MP2
    # reversal before the MP2 completion, so this ordering is not exercised.
    Scenario: A reversal that arrives before its completion gives the same balance
      Given the wallet of "c1" holds 0 micros
      When the provider delivers "MP2 reversed 3000000" for "c1"
      And then delivers "MP2 completed 3000000" for "c1"
      Then the wallet of "c1" holds 0 micros

    @P4-S03 @verified
    # Verified by: billing/test/wallet.test.ts › "payment webhooks (D19 wallet) › malformed webhooks are rejected by the validation pipe"
    Scenario: A malformed notification is rejected
      When the provider delivers a notification with type "refunded", amount "-5" and occurred-at "x"
      Then the response is HTTP 400

    @P4-S04 @unverified
    Scenario: A notification with a zero amount is rejected as a client error
      When the provider delivers "MP7 completed 0" for "c1"
      Then the response is HTTP 400
      And no journal is posted

    @P4-S05 @unverified
    Scenario: A redelivery whose contents differ from the original is not silently accepted
      Given "MP1 completed 5000000" for "c1" has been applied
      When the provider delivers "MP1 completed 9000000" for "c1"
      Then the wallet of "c1" still holds 5000000 micros
      And the mismatch is reported for reconciliation instead of being answered as a duplicate

    @P4-S06 @unverified
    Scenario: A notification that the provider did not sign is rejected
      When a notification arrives without a valid provider signature
      Then the response is HTTP 401
      And no journal is posted

  Rule: Wallet balances can be queried and match the ledger

    @P4-S07 @verified
    # Verified by: billing/test/wallet.test.ts › "payment webhooks (D19 wallet) › repeated and out-of-order webhooks credit the wallet exactly once"
    Scenario: Balance over HTTP
      Given the wallet of "c1" holds 5000000 micros
      When a client requests GET /wallets/c1
      Then the response has balanceMicros "5000000"

    @P4-S08 @verified
    # Verified by: billing/test/kafka.e2e.test.ts › "request-reply: @MessagePattern answers a wallet balance query over Kafka"
    Scenario: Balance by request-reply over Kafka
      When a service sends {"customerId": "c1"} on topic "wallet.balance" and waits for the reply
      Then the reply has customerId "c1"
      And the reply's balanceMicros equals the sum of the ledger entries for "wallet:c1"

  Rule: The books always balance and cannot be rewritten

    @P4-S09 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery"
    # Verified by: billing/test/wallet.test.ts › "payment webhooks (D19 wallet) › repeated and out-of-order webhooks credit the wallet exactly once"
    Scenario: Every journal and the whole ledger sum to zero
      Given charges, corrections and top-ups have been posted
      Then every journal's entries sum to zero
      And the sum of all entries in the ledger is zero

    @P4-S10 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › the database refuses unbalanced journals and edits to the ledger"
    Scenario: The database refuses an unbalanced journal
      Given a transaction writes a journal with entries "wallet:x +100" and "clearing -99"
      When the transaction commits
      Then the commit fails with "does not balance"

    @P4-S11 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › the database refuses unbalanced journals and edits to the ledger"
    Scenario: The database refuses to update a journal
      Given a journal has been stored
      When anyone updates it directly in the database
      Then the update fails with "append-only"

    @P4-S12 @unverified
    Scenario Outline: The database refuses other edits to the ledger
      Given a balanced journal with entries has been stored
      When anyone runs <statement> directly in the database
      Then the statement fails with "append-only"

      Examples:
        | statement              |
        | an UPDATE on entries   |
        | a DELETE on entries    |
        | a DELETE on journals   |

  Rule: Every charge, regular or late, is split and posted the same way

    @P4-S13 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › a price correction claws back a paid supplier, netted against the next payout"
    Scenario: A charge debits the wallet and credits each party by weight
      When reservation "res1" of customer "c1" on route "R1" is charged 100000 micros for one minute
      Then "supplier:A", with 30% of the route's weight, is credited 30000 micros

    @P4-S14 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery"
    Scenario: A correction for late usage only ever adds to what each party is owed
      Given minutes have been charged and late usage then arrives for them
      When the corrections are posted
      Then in every correction the wallet entry is negative
      And every other entry is positive

    @P4-S15 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery"
    Scenario: Each account ends at the split of the minute's final total, whatever the arrival order
      Given a set of usage records for several reservations and minutes
      When they are delivered once each in usage-time order and rated
      And they are separately delivered shuffled, partly duplicated and partly after their minute was charged
      Then every account balance is the same in both cases
      And each minute's total charge is the same in both cases

    @P4-S16 @unverified
    # P4-S15 covers this through its outcome; no test inspects an individual correction.
    Scenario: A correction posts the difference between the new split and the split already posted
      Given parties "a", "b" and "c" with weights 31, 76 and 70
      And a minute was charged 31 micros and posted as a 5, b 14, c 12
      When late usage raises the minute's total to 32 micros
      Then a correction is posted that credits "c" 1 micro and debits the wallet 1 micro
      And "a" and "b" are not in the correction

  Rule: The split of a charge is exact, proportional and never shrinks as the total grows

    @P4-S17 @verified
    # Verified by: billing/test/split.test.ts › "split (D20) › shares always sum exactly to the amount"
    Scenario: Shares add up exactly to the charge
      When any whole number of micros is split among the route's parties
      Then the shares add up to exactly that number of micros

    @P4-S18 @verified
    # Verified by: billing/test/split.test.ts › "split (D20) › each share is within one unit of its exact proportion"
    # The test name says "one unit"; its assertion is the bound below.
    Scenario: Each share stays close to its exact proportion
      When an amount is split among n parties
      Then each share differs from amount × weight / total weight by less than n micros

    @P4-S19 @verified
    # Verified by: billing/test/split.test.ts › "split (D20) › house-monotone: a larger amount never lowers any share"
    Scenario: A larger amount never lowers any share
      When amounts from 0 to 20000 micros are split among the route's parties
      Then no party's share for an amount is smaller than its share for the amount one less

    @P4-S20 @verified
    # Verified by: billing/test/split.test.ts › "split (D20) › largest remainder is NOT monotone (the Alabama paradox), which is why it was rejected"
    Scenario: The split avoids the Alabama paradox
      Given parties "a", "b" and "c" with weights 31, 76 and 70
      When 31 micros and then 32 micros are split among them
      Then the share of "a" for 32 micros is not smaller than its share for 31 micros

    @P4-S21 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › late usage never claws back a supplier, even where largest remainder would (Alabama paradox)"
    Scenario: Late usage never lowers a supplier's balance
      Given route "R2" is split between "supplier:a", "supplier:b" and "supplier:c" with weights 31, 76 and 70
      And a minute on "R2" has been charged 31 micros
      When late usage raises that minute's charge to 32 micros
      Then the wallet has been debited 32 micros in total
      And the balance of "supplier:a" is not lower than before the late usage

    @P4-S22 @unverified
    Scenario: The split is deterministic and ties go to the earlier account name
      Given two parties have equal claim to the last remaining micro
      When the amount is split
      Then the micro goes to the party whose account name sorts first
      And splitting the same amount with the same weights always gives the same shares

  Rule: Suppliers are paid what they are owed, and debts are netted

    @P4-S23 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › a price correction claws back a paid supplier, netted against the next payout"
    Scenario: A payout run pays each supplier its positive balance
      Given "supplier:A" has earned 30000 micros
      When a payout run executes
      Then "supplier:A" is paid 30000 micros

    @P4-S24 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › a price correction claws back a paid supplier, netted against the next payout"
    Scenario: A clawed-back supplier is not paid until later earnings cover the debt
      Given "supplier:A" was paid 30000 micros
      And a price correction lowered what it earned to 15000 micros
      Then the balance of "supplier:A" is -15000 micros
      When a payout run executes
      Then "supplier:A" is not paid
      When "supplier:A" then earns another 30000 micros and a payout run executes
      Then "supplier:A" is paid 15000 micros
      And the balance of "supplier:A" is 0 micros

  Rule: Money is whole micros, in one currency per account

    @P4-S25 @unverified
    Scenario Outline: A notification amount that is not a whole positive number of micros is rejected
      When the provider delivers a notification with amount "<amount>"
      Then the response is HTTP 400

      Examples:
        | amount |
        | 1.5    |
        | -5     |
        | +5     |
        | 1e6    |

    @P4-S26 @unverified
    # Not implemented: the ledger has no currency on accounts or entries.
    Scenario: A journal never mixes currencies
      Given the wallet of "c1" holds KES and "supplier:A" is paid in USD
      When a charge for "c1" on a route through "supplier:A" is posted
      Then every journal's entries are in one currency
      And the conversion between currencies is recorded as its own balanced movement at a recorded rate
