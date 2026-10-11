# Spec for P3: rating reservations and metered traffic.
# Problem statement: ../01-discovery/P3-rating-and-metering.md
# Terms: glossary.md. Policies: policy-register.md.
#
# Tags: @P3-Snn is the scenario's stable ID; @need-P3-Nn is the need it serves; @POL-nn a
# policy it depends on. Conformance (design, tests, status) is kept in conformance.md.
#
# This spec ends at charges and amendments. Money movements, funds holds, headroom and
# suspension are P4. Amounts are USD; "micro-USD" is 10^-6 USD; 1 GB is 10^9 bytes.
# Prices in examples are illustrations, not POL defaults (POL-01 sets prices per product
# and route). Times are HH:MM:SS in UTC; minutes are half-open.

Feature: Rating reservations and metered traffic

  As a buyer of guaranteed capacity
  I want to be charged for each minute I hold a reservation, at the price I booked
  So that my bill is known in advance and follows every change I make

  As a buyer of best-effort traffic or burst
  I want every byte counted exactly once and priced as of when it was carried
  So that late or repeated reports never change what my traffic costs

  As a buyer and as Share support
  I want every change to a past charge to be a separate amendment with its reason
  So that a charge I have seen never silently changes, and every change can be explained

  As a supplier
  I want every accrual and every metered byte on my links to be charged, or reported if it cannot be
  So that I am paid for all the capacity and traffic I deliver

  As Share's risk owner
  I want to see each account's exposure, and to know when the assumptions behind it were broken
  So that the loss from usage-priced traffic not yet charged is bounded

  Rule: Every minute a reservation is active accrues its reserved rate at its booked price

    Background:
      Given a guaranteed product on a route with a `reservation_price` (POL-01) of 2 micro-USD per Mbps-minute

    @P3-S01 @need-P3-N1 @POL-01
    Scenario: An active minute accrues whether or not traffic crosses it
      Given a confirmed reservation of 100 Mbps for [10:00, 11:00) on the route
      And no traffic crosses it
      When the minute [10:05, 10:06) has passed
      Then the reservation has accrued 200 micro-USD for that minute

    @P3-S02 @need-P3-N1 @POL-01
    Scenario: A part minute is charged as a whole minute
      Given a reservation of 100 Mbps on the route starting now was confirmed at 10:05:40
      When the minute [10:05, 10:06) has passed
      Then the reservation has accrued 200 micro-USD for that minute

    @P3-S03 @need-P3-N1 @POL-01
    Scenario: There is no minimum term
      Given a confirmed reservation of 100 Mbps for [10:00, 10:01) on the route
      When the reservation has ended
      Then it has accrued 200 micro-USD in total

    @P3-S04 @need-P3-N1 @POL-08
    Scenario: Accrual stops at the minute a cancellation takes effect
      Given a confirmed reservation of 100 Mbps for [10:00, 12:00) on the route
      When it is cancelled with effect from 10:30
      Then it accrues for each minute of [10:00, 10:30) and for no minute after

    @P3-S05 @need-P3-N1 @POL-08
    Scenario: A rate decrease is accrued at the new rate from its effective minute
      Given a confirmed reservation of 100 Mbps for [10:00, 12:00) on the route
      When its rate is decreased to 50 Mbps with effect from 10:30
      Then each minute of [10:30, 12:00) accrues 100 micro-USD

    @P3-S06 @need-P3-N1 @POL-27
    Scenario: A reservation keeps the price it was booked at
      Given a confirmed reservation of 100 Mbps for [10:00, 12:00) on the route
      When the route's `reservation_price` changes to 3 micro-USD per Mbps-minute from 11:00
      Then each minute of [11:00, 12:00) still accrues 200 micro-USD

    @P3-S07 @need-P3-N1 @POL-27
    Scenario: An open-ended reservation's price changes only after price_notice
      Given a confirmed open-ended reservation of 100 Mbps on the route
      When a new `reservation_price` of 3 micro-USD per Mbps-minute is announced at time T
      Then the reservation accrues at the booked price until T plus `price_notice` (POL-27)
      And at the new price from then on

    @P3-S08 @need-P3-N1 @POL-07
    Scenario: A revoked reservation accrues nothing after the revocation takes effect
      Given a confirmed open-ended reservation on the route is revoked under a permanent reduction (POL-07)
      When the revocation takes effect
      Then the reservation accrues for no minute from then on

    @P3-S09 @need-P3-N1 @POL-16
    Scenario: A suspended account's reservation accrues during the grace, and not after its release
      Given a confirmed open-ended reservation of an account that is suspended (POL-16)
      When `suspension_grace` passes without funds and the reservation is released
      Then the reservation accrued for every minute of the grace
      And it accrues for no minute after its release

    @P3-S10 @need-P3-N1 @POL-07
    Scenario: A reservation affected by an unplanned outage keeps accruing and is marked for credit
      Given a confirmed reservation on the route is flagged as affected by an unplanned outage (POL-07)
      When the minutes of the outage pass
      Then the reservation accrues for each of them
      And each of those minutes is marked as affected, for SLA credit (Problem 6)

    @P3-S11 @need-P3-N1 @POL-08
    Scenario Outline: A partner cancellation fee is charged only if it was shown at booking
      Given a reservation over a partner leg with a cancellation fee that <shown> at booking
      When the reservation is cancelled
      Then the account is <charged>

      Examples:
        | shown        | charged                         |
        | was shown    | charged the fee as shown        |
        | was not shown| not charged any cancellation fee |

  Rule: Each reservation-minute and each record is charged exactly once

    @P3-S12 @need-P3-N2
    Scenario: A minute is charged once however many charging runs overlap
      Given the minute [10:05, 10:06) has accruals and traffic not yet charged
      When several charging runs charge it at the same time
      Then each accrual and each record in it is charged once

    @P3-S13 @need-P3-N2
    Scenario: Charging that starts afresh, or after losing its place, charges every record not yet charged, once
      Given flow records have been received, some of them charged and some not
      When charging starts with no record of where it had got to
      Then every record not yet charged is charged once
      And no record already charged is charged again

  Rule: Usage-priced traffic is counted exactly once, whatever the delivery

    Background:
      Given a best-effort product on a route with a `usage_price` (POL-01) of 10,000 micro-USD per GB
      And an account "a1" sending traffic on it

    @P3-S14 @need-P3-N3
    Scenario: A record delivered twice is counted once
      Given a flow record from exporter "e1" with sequence 7 for "a1"
      When the record is delivered twice
      Then its bytes are charged once

    @P3-S15 @need-P3-N3
    Scenario: Any delivery order, duplication and lateness gives the same charges as in-order delivery
      Given any set of flow records
      When they are delivered once each, in order of when the traffic happened
      And separately delivered in any order, with any of them repeated and any of them after their minute was charged
      Then both deliveries give the same total charge for every account and minute

    @P3-S16 @need-P3-N3
    Scenario: A repeat of a record already charged causes no amendment
      Given the minute [12:05, 12:06) has been charged, including the record from exporter "e1" with sequence 7
      When that record is delivered again
      Then no amendment is made

    @P3-S17 @need-P3-N3 @need-P3-N2
    Scenario: A record arriving while its minute is being charged is neither lost nor counted twice
      Given the minute [12:05, 12:06) is being charged
      When a record for that minute arrives during the charging
      Then the record's bytes are in that minute's total charge exactly once

  Rule: A record's bytes belong to the minutes in which its flow was active

    Background:
      Given a best-effort product on a route with a `usage_price` (POL-01) of 10,000 micro-USD per GB
      And an account "a1" sending traffic on it

    @P3-S18 @need-P3-N4 @POL-13
    Scenario Outline: A record within one minute belongs to that minute; minutes are half-open
      Given a flow record for "a1" of a flow active from <start> to <end>
      When the record is charged
      Then its bytes are charged in the minute [<minute>, <next>)

      Examples:
        | start    | end      | minute   | next     |
        | 12:05:10 | 12:05:50 | 12:05:00 | 12:06:00 |
        | 12:05:30 | 12:06:00 | 12:05:00 | 12:06:00 |
        | 12:06:00 | 12:06:20 | 12:06:00 | 12:07:00 |

    @P3-S19 @need-P3-N4 @POL-13
    Scenario: A record spanning several whole minutes is spread evenly across them
      Given a flow record for "a1" of 3 GB for a flow active from 12:05:00 to 12:08:00
      When the record is charged
      Then 1 GB is charged in each of the minutes starting 12:05, 12:06 and 12:07

  Rule: Traffic is priced at the price in force in the minute it happened

    Background:
      Given a best-effort product on a route with a `usage_price` of 10,000 micro-USD per GB until 12:20
      And a `usage_price` of 13,000 micro-USD per GB from 12:20, announced with `price_notice` (POL-27)
      And an account "a1" sending traffic on it

    @P3-S20 @need-P3-N5 @POL-27
    Scenario: A late record is priced at the price of its own minute
      Given the minutes starting 12:05 and 12:25 have been charged
      When a record of 1 GB for "a1" for a flow active in the minute starting 12:05 arrives
      Then it is charged 10,000 micro-USD, at the price in force in that minute

    @P3-S21 @need-P3-N5 @POL-11
    Scenario Outline: A charge is computed exactly and rounded once, down to the micro
      Given the minute starting 12:05 carried <bytes> bytes of "a1"'s traffic
      When the minute is charged
      Then the charge is <charge> micro-USD

      Examples:
        | bytes      | charge | exact value  |
        | 1000000000 | 10000  | 10000        |
        | 150000     | 1      | 1.5          |
        | 99999      | 0      | 0.99999      |

  Rule: Each kind of traffic is billed by its rule

    Background:
      Given a guaranteed product on a route, with a `usage_price` (POL-01) of 10,000 micro-USD per GB for burst
      And a confirmed reservation of 100 Mbps on the route for account "a1"

    @P3-S22 @need-P3-N6 @POL-01 @POL-17
    Scenario: Traffic within the reserved rate is covered by the reservation's accrual
      Given the product does not permit burst
      When "a1" carries 0.75 GB on the reservation in one minute
      Then no charge for usage-priced traffic is made for that minute

    @P3-S23 @need-P3-N6 @POL-17
    Scenario: Permitted burst is billed at usage_price for the excess only
      Given the product permits burst
      When "a1" carries 1.75 GB on the reservation in one minute, 1 GB more than 100 Mbps for 60 s
      Then a charge of 10,000 micro-USD for usage-priced traffic is made for that minute, for the 1 GB of burst

    @P3-S24 @need-P3-N6 @need-P3-N7 @POL-17
    Scenario: Traffic above the reserved rate on a product without burst is kept and reported
      Given the product does not permit burst
      When records show "a1" carrying more than 100 Mbps for 60 s in one minute
      Then the records are kept
      And the excess is reported to network operations as traffic that should have been policed

    @P3-S25 @need-P3-N6 @POL-17
    Scenario: Attributable traffic outside an active reservation is billed at usage_price and counts toward exposure
      When records show traffic attributable to "a1" in a minute outside any active reservation of "a1"
      Then it is charged at `usage_price` (POL-01)
      And it counts toward "a1"'s exposure until it is charged

    @P3-S26 @need-P3-N6 @POL-17
    Scenario: Traffic that cannot be attributed is quarantined, not billed, and reported
      When a record arrives for traffic that cannot be attributed to any account
      Then it is quarantined and not charged
      And it is reported to operations and to the supplier of the link it crossed

    @P3-S27 @need-P3-N6 @POL-17
    Scenario Outline: Quarantined traffic is charged, and its supplier paid, only if attributed within dispute_window
      Given traffic on a supplier's link was quarantined
      When it is attributed to account "a1" <when>
      Then <result>

      Examples:
        | when                                | result                                                       |
        | within `dispute_window` (POL-17)    | it is charged to "a1" and the supplier's share is credited   |
        | after `dispute_window` (POL-17)     | the supplier is not credited for it                          |

  Rule: No record is silently discarded

    @P3-S28 @need-P3-N7
    Scenario Outline: A record that cannot be read is kept with its reason and not charged
      When a flow record arrives with <defect>
      Then it is kept with the reason "<defect>"
      And nothing is charged for it

      Examples:
        | defect                                 |
        | no exporter                            |
        | no sequence number                     |
        | a negative byte count                  |
        | a byte count that is not a whole number |
        | a start or end time that is not a time |
        | an end time before its start time      |

    @P3-S29 @need-P3-N7
    Scenario: A record that cannot be read does not delay the records behind it
      Given a record that cannot be read arrives before valid records from the same exporter
      When the records are received
      Then the valid records are charged as if the unreadable one had not arrived

    @P3-S30 @need-P3-N7
    Scenario: A kept record that is corrected is charged once
      Given a record that could not be read was kept with its reason
      When a corrected version of it is submitted, any number of times
      Then its bytes are charged once

    @P3-S31 @need-P3-N7
    Scenario: An accepted record is never altered or removed
      Given an accepted flow record
      When any principal, operators included, tries to alter or remove it
      Then the attempt is refused and recorded
      And the record is unchanged

  Rule: Past charges are amended, never rewritten, and every amendment is explained

    Background:
      Given a best-effort product on a route with a `usage_price` (POL-01) of 10,000 micro-USD per GB
      And an account "a1" sending traffic on it

    @P3-S32 @need-P3-N8
    Scenario: A late record for a charged minute adds an amendment and leaves the charge as it was
      Given the minute starting 12:05 was charged 10,000 micro-USD for "a1"
      When a late record of 1 GB for that minute arrives
      Then an amendment of 10,000 micro-USD with the reason "late traffic" is made for that minute
      And the original charge is still 10,000 micro-USD

    @P3-S33 @need-P3-N8
    Scenario: Late traffic never decreases a charge
      Given any records arriving late, repeated and out of order
      When they are charged
      Then every amendment they cause increases the charge it amends

    @P3-S34 @need-P3-N8 @POL-27
    Scenario: A price correction is an amendment, in either direction, with who made it and why
      Given 10 GB of "a1"'s traffic in a charged minute at 10,000 micro-USD per GB, charged 100,000 micro-USD
      When an authorised operator corrects the price for that minute to 5,000 micro-USD per GB, giving a reason
      Then an amendment of minus 50,000 micro-USD is made for that minute, recording the operator and the reason
      And the original charge is still 100,000 micro-USD

    @P3-S35 @need-P3-N8
    Scenario: A buyer can see, for any minute, the original charge and every amendment with its reason
      Given a minute of "a1" has an original charge and two amendments
      When "a1" asks for that minute's charges
      Then the original charge and both amendments are shown, each with its reason and time

  Rule: Every charge can be reproduced from what was stored

    @P3-S36 @need-P3-N9
    Scenario: Recomputing any period gives exactly the recorded charges and amendments
      Given any period for which charges and amendments have been made
      When the period is recomputed from the stored records, the reservation history and the price history
      Then the recomputed charges and amendments equal the recorded ones

  Rule: Exposure is visible, and breaches of its assumptions are reported

    @P3-S37 @need-P3-N10 @POL-14
    Scenario: The business can see each account's exposure
      Given an account with usage-priced traffic
      When finance asks for the account's exposure
      Then it is given as the most the account can owe for usage-priced traffic not yet charged, assuming `max_lateness` (POL-14) and the enforcement time in X2

    @P3-S38 @need-P3-N10 @POL-14
    Scenario: A record later than max_lateness is still charged and reported as a breach
      When a record arrives later than `max_lateness` (POL-14) after the end of its minute
      Then it is charged like any late record
      And it is reported as a breach of the exposure bound, with its exporter and lateness

  Rule: Accepted records are kept as evidence of what was delivered

    @P3-S39 @need-P3-N11
    Scenario: Accepted records can be retrieved by reservation, link and minute
      Given accepted flow records within the retention period (X2)
      When operations or the SLA work asks for the traffic of a reservation, or on a link, in a range of minutes
      Then every accepted record for that reservation or link in those minutes is returned
