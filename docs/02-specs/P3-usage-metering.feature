# P3. Metering and rating pay-per-use traffic
#
# Problem statement: ../01-discovery/P3-usage-metering.md
# Design:            ../03-rfcs/RFC-003-usage-metering.md
#
# Conventions: every scenario has a stable ID tag and is tagged @verified (with a
# "Verified by" comment naming the test as file › "describe › test") or @unverified.
# Money is in micros (1e-6 of the currency unit). 1 GB is 10^9 bytes.
# Wallet balances, ledger entries and the supplier split are specified in P4.

Feature: Metering and rating pay-per-use traffic

  As a buyer paying per use
  I want every flow record to be counted exactly once, however it is delivered
  So that I am never charged twice for the same traffic, nor allowed to use traffic unbilled

  As a buyer
  I want each flow's bytes to fall in one well-defined minute
  So that the same traffic is always billed the same way

  As a buyer and as a supplier
  I want usage to be priced at the price in force when it happened, not when it was reported
  So that a late report cannot change what the traffic costs

  As a buyer
  I want late usage to appear as a visible amendment to my bill
  So that a charge I have already seen never silently changes

  As Share
  I want charging a minute and ingesting its records to be safe to run at the same time
  So that no record is ever left uncharged or charged twice

  As Share's risk owner
  I want to know the most each customer can owe beyond their charges, and to suspend them before it is exceeded
  So that the loss from usage reported late is bounded and chosen by policy

  As Share
  I want records that cannot be billed to be rejected without disturbing billing
  So that one bad record neither corrupts charges nor stops the meter

  As Share
  I want flow records published on Kafka to become charges with no manual step in between
  So that the meter runs from the network to the bill

  Rule: Every flow record is counted exactly once

    Background:
      Given a route priced at 10,000 micros per GB
      And a reservation "res1" for customer "c1" on that route

    @P3-S01 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" (seeds 11, 12, 13)
    # Verified by: billing/test/kafka.e2e.test.ts › "duplicated records on Kafka are ingested once and rated into a balanced ledger"
    Scenario: A duplicated record is counted once
      Given a flow record from exporter "e1" with sequence 7 for "res1"
      When the record is delivered twice
      Then the record is stored once
      And its bytes are charged once

    @P3-S02 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" (seeds 11, 12, 13)
    Scenario: Shuffled, duplicated and late delivery gives the same charges as in-order delivery
      Given a set of 200 flow records across three reservations and 40 minutes
      When the records are delivered once each in event-time order and every minute is charged
      And the same records are separately delivered in random order with 30% of them delivered twice, while minutes are being charged
      Then both deliveries produce the same charge for every reservation and minute
      And both deliveries produce the same balance on every account

    @P3-S03 @unverified
    Scenario: Raw flow records cannot be changed or removed
      Given a stored flow record
      When anything attempts to update or delete it
      Then the attempt is refused
      And the record is unchanged

  Rule: Usage belongs to one well-defined billing minute

    @P3-S04 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › a late record is priced at the rate of its own event time, not of its arrival"
    Scenario: A flow's bytes belong to the minute in which the flow ended
      Given flow records for "res1" that ended at 12:05:10 and at 12:05:50
      When the records are charged
      Then both records are charged in the minute starting 12:05

    @P3-S05 @unverified
    Scenario Outline: Minutes are half-open: a flow ending exactly on a minute boundary belongs to the minute that starts there
      Given a flow record for "res1" that ended at <end time>
      When the record is charged
      Then it is charged in the minute starting <minute>

      Examples:
        | end time     | minute |
        | 12:05:59.999 | 12:05  |
        | 12:06:00.000 | 12:06  |

    @P3-S06 @verified
    # Verified by: billing/test/kafka.e2e.test.ts › "duplicated records on Kafka are ingested once and rated into a balanced ledger"
    Scenario: Each minute is charged on its total bytes, rounded once
      Given many flow records for the same reservation and minute
      When the minute is charged
      Then the charge is the minute's total bytes times the price, rounded half up to the nearest micro
      And the total charged across all minutes equals the sum of those per-minute charges

    @P3-S07 @unverified
    Scenario: A minute is not charged until the watermark has passed its end
      Given a flow record for "res1" that ended at 12:05:30
      When the rating watermark is 12:05:59
      Then the minute starting 12:05 is not charged
      When the rating watermark reaches 12:06:00
      Then the minute starting 12:05 is charged

  Rule: Usage is priced at the time the traffic happened

    Background:
      Given a route priced at 10,000 micros per GB until 12:20
      And priced at 13,000 micros per GB from 12:20
      And a reservation "res1" for customer "c1" on that route

    @P3-S08 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › a late record is priced at the rate of its own event time, not of its arrival"
    Scenario: A late record is priced at the rate of its own time
      Given 1 GB of usage in the minute starting 12:05 and 1 GB in the minute starting 12:25
      And both minutes have been charged
      When a record of 1 GB that ended at 12:05:50 arrives after both minutes have been charged
      Then the minute starting 12:05 is charged 20,000 in total, at the old price
      And the minute starting 12:25 is charged 13,000, at the new price

    @P3-S09 @unverified
    Scenario: A price change in the middle of a minute applies from the next whole minute
      Given the price changes to 13,000 micros per GB at 12:20:30
      When 1 GB of usage in the minute starting 12:20 is charged
      Then it is charged at 10,000 micros per GB, the price in force at the start of that minute

    @P3-S10 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › a price correction claws back a paid supplier, netted against the next payout"
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › the database refuses unbalanced journals and edits to the ledger" (charges cannot be edited)
    Scenario: Correcting a wrong price re-rates the minutes it applied to
      Given 10 GB in a charged minute at 10,000 micros per GB, so the customer was charged 100,000
      When the price for that period is corrected to 5,000 micros per GB
      And the affected minutes are re-rated
      Then the customer's total charge for that minute becomes 50,000
      And the difference is recorded as a correction, not by changing the original charge

  Rule: Late usage amends charges by appending corrections

    Background:
      Given a route priced at 10,000 micros per GB
      And a reservation "res1" for customer "c1" on that route

    @P3-S11 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › a late record is priced at the rate of its own event time, not of its arrival"
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" (seeds 11, 12, 13)
    Scenario: A record for an already-charged minute produces a correction straight away
      Given the minute starting 12:05 has been charged
      When a new record that ended in that minute arrives
      Then a correction for the difference is recorded at once
      And the minute's total charge equals the charge for all of its records

    @P3-S12 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" (seeds 11, 12, 13)
    Scenario: Late usage only ever increases what the customer is charged
      Given records arriving late, duplicated and out of order
      When they are charged and corrected
      Then every correction caused by late records debits the customer's wallet
      And no correction caused by late records credits it

    @P3-S13 @unverified
    Scenario: A duplicate of an already-charged record causes no correction
      Given the minute starting 12:05 has been charged, including the record from exporter "e1" with sequence 7
      When that record is delivered again
      Then no correction is recorded

  Rule: Charging a minute is safe while its records are still arriving

    Background:
      Given a route priced at 10,000 micros per GB
      And reservations for two customers on that route

    @P3-S14 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › concurrent ingestion and rating lose no record (the minute lock)"
    Scenario: Concurrent ingestion and rating lose no record
      Given 400 flow records
      When eight ingestion workers deliver them while minutes are being charged continuously
      Then every account ends with the same balance as when the records are ingested first and charged afterwards

    @P3-S15 @verified
    # Verified by: billing/test/rating.test.ts › "rating and ledger (D18–D20) › a record that races its minute being rated is still charged (forced interleaving)"
    Scenario: A record stored while its minute is being charged is still charged
      Given 1 GB of usage for customer "c1" in the minute starting 12:00
      And a second record of 1 GB for that minute is being stored
      When the minute is charged before that second record has finished being stored
      Then customer "c1" is charged for 2 GB, 20,000 in total

    @P3-S16 @unverified
    Scenario: Two raters charging the same minute charge it once
      Given the minute starting 12:05 has records and has not been charged
      When two rating runs charge it at the same time
      Then the minute is charged once
      And the other run skips it

  Rule: What a customer can owe beyond their charges is bounded

    # Exposure = current price × reserved rate × (metering lag + enforcement lag).
    # With 2,000 Mbps reserved, 180 s metering lag and 60 s enforcement lag at
    # 10,000 micros per GB: 2,000 Mbps × 240 s = 60 GB, so exposure is 600,000.

    Background:
      Given a route priced at 10,000 micros per GB
      And a reservation "res1" for customer "c1" of 2,000 Mbps on that route
      And a metering lag of 180 seconds and an enforcement lag of 60 seconds

    @P3-S17 @verified
    # Verified by: billing/test/wallet.test.ts › "exposure bound (D19) › reserve policy: suspends once when balance falls to the exposure, resumes after a top-up"
    Scenario: Exposure is computed from the reserved rate and the lags
      When the customer's standing is computed
      Then their exposure is 600,000

    @P3-S18 @verified
    # Verified by: billing/test/wallet.test.ts › "exposure bound (D19) › reserve policy: suspends once when balance falls to the exposure, resumes after a top-up"
    Scenario: Under the reserve policy, the customer is suspended once when the balance falls to the exposure
      Given the "reserve" policy, where available headroom is the balance minus the exposure
      And customer "c1" has a balance of 1,000,000
      When 30 GB of usage is charged
      Then no suspend event is emitted
      When a further 10 GB of usage is charged
      Then exactly one "customer.suspend" event is emitted for "c1", with available headroom 0
      When a further 5 GB of usage is charged during the lag window
      Then that usage is still charged
      And no second suspend event is emitted

    @P3-S19 @verified
    # Verified by: billing/test/wallet.test.ts › "exposure bound (D19) › reserve policy: suspends once when balance falls to the exposure, resumes after a top-up"
    Scenario: A top-up that restores headroom emits a resume event
      Given customer "c1" is suspended under the "reserve" policy
      When a top-up restores positive headroom
      Then exactly one "customer.resume" event is emitted for "c1"
      # Whether traffic is actually resumed on that event is a business policy.

    @P3-S20 @verified
    # Verified by: billing/test/wallet.test.ts › "exposure bound (D19) › credit-limit policy: suspends when the balance reaches minus the limit"
    Scenario: Under the credit-limit policy, the customer is suspended when the balance reaches minus the limit
      Given the "credit_limit" policy with a limit of 200,000
      And customer "c1" has a balance of 100,000
      When 25 GB of usage is charged
      Then no suspend event is emitted
      When a further 5 GB of usage is charged, bringing the balance to -200,000
      Then exactly one suspend event is emitted

    @P3-S21 @verified
    # Verified by: billing/test/wallet.test.ts › "exposure bound (D19) › reserve policy: admission is refused when a new reservation would leave no headroom"
    Scenario: A new reservation is refused when its exposure would leave no headroom
      Given the "reserve" policy
      And customer "c1" has a balance of 1,000,000 and "res1" already accounts for 600,000 of exposure
      When the customer asks to reserve 500 Mbps more on the route
      Then the reservation is allowed
      When the customer asks to reserve 2,000 Mbps more on the route
      Then the reservation is refused

    @P3-S22 @unverified
    # Not met today: every admission check sent over Kafka gets an error reply. Known defect,
    # fix pending (RFC-003, "Modules and transport"; docs/04-delivery/contracts.md C25).
    Scenario: Admission is answered over Kafka request-reply
      Given the "reserve" policy
      When the reservation service sends an admission check for customer "c1", the route and 2,000 Mbps on "billing.admission-check"
      Then it receives a reply saying whether the reservation is allowed and the available headroom in micros

    @P3-S23 @verified
    # Verified by: billing/test/kafka.e2e.test.ts › "fire-and-forget: the suspend event reaches Kafka"
    Scenario: Suspend events are published to Kafka
      Given the "credit_limit" policy with a limit of 0
      And customers "c1" and "c2" have been charged into a negative balance
      Then a "customer.suspend" event for each of "c1" and "c2" is published on Kafka

  Rule: Malformed flow records are rejected without disturbing billing

    @P3-S24 @unverified
    Scenario Outline: A malformed record is not stored and not charged
      When a flow record arrives with <defect>
      Then it is not stored
      And nothing is charged for it

      Examples:
        | defect                                 |
        | no exporter ID                         |
        | a negative sequence number             |
        | a negative byte count                  |
        | a byte count that is not an integer    |
        | an event time that is not a valid time |
        | a reservation ID that does not exist   |

    @P3-S25 @unverified
    Scenario: A malformed record does not stop the records behind it
      Given a malformed flow record on a partition of the "flow-records" topic
      And valid flow records after it on the same partition
      When the records are consumed
      Then the valid records are stored and charged
      And the malformed record is set aside where it can be inspected

  Rule: Flow records on Kafka become charges with no manual step

    @P3-S26 @verified
    # Verified by: billing/test/kafka.e2e.test.ts › "duplicated records on Kafka are ingested once and rated into a balanced ledger"
    Scenario: Records published on Kafka, with duplicates, are ingested once and charged exactly
      Given two reservations priced at 10,000 micros per GB
      And 3,000 unique flow records over 10 minutes, keyed by exporter, on a 3-partition "flow-records" topic
      When the records are published in random order with about 20% of them published twice
      Then exactly 3,000 flow records are stored
      And once the minutes are charged, the ledger balances
      And the total charged equals the per-minute charges computed from the unique records

    @P3-S27 @unverified
    Scenario: A new consumer group starts from the oldest record
      Given flow records already on the "flow-records" topic
      When billing starts with a consumer group that has no committed offsets
      Then it consumes the topic from the oldest record, not the newest
