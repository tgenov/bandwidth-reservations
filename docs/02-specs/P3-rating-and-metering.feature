# Spec for P3: rating reservations and metered traffic.
# Problem statement: ../01-discovery/P3-rating-and-metering.md
# Terms: glossary.md. Policies: policy-register.md.
#
# Tags: @P3-Snn is the scenario's stable ID; @need-P3-Nn is the need it serves; @POL-nn a
# policy it depends on. Conformance (design, tests, status) is kept in conformance.md.
#
# This spec ends at charges and amendments. Money movements, funds holds, headroom and
# suspension are P4. A charge is computed per charge line (POL-11): one reservation for one
# minute; one account and product on one route for one minute of usage-priced traffic; or
# one cancellation fee for one reservation (charged at exactly its shown amount, not split).
# Amounts are USD; "micro-USD" is 10^-6 USD; 1 GB is 10^9 bytes; at 100 Mbps a minute
# carries 0.75 GB. Prices in examples are illustrations, not POL defaults (POL-01 sets
# prices per product and route). Times are HH:MM:SS in UTC; minutes are half-open.

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
  I want to see each account's usage exposure, and to know when the assumptions behind it were broken
  So that the loss from usage-priced traffic not yet charged is bounded

  Rule: Every minute a reservation is active accrues each part's reserved rate at that part's price

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

    @P3-S04 @need-P3-N1 @POL-08 @POL-01
    Scenario: Accrual stops at the minute a cancellation takes effect
      Given a confirmed reservation of 100 Mbps for [10:00, 12:00) on the route
      When it is cancelled at 10:29:20
      Then the cancellation takes effect at 10:30
      And the reservation accrues for each minute of [10:00, 10:30) and for no minute after

    @P3-S05 @need-P3-N1 @POL-08 @POL-01
    Scenario: A rate decrease is accrued at the new rate from its effective minute
      Given a confirmed reservation of 100 Mbps for [10:00, 12:00) on the route
      When its rate is decreased to 50 Mbps with effect from 10:30
      Then each minute of [10:30, 12:00) accrues 100 micro-USD

    @P3-S06 @need-P3-N1 @POL-27 @POL-01
    Scenario: A reservation keeps the price it was booked at
      Given a confirmed reservation of 100 Mbps for [10:00, 12:00) on the route
      When the route's `reservation_price` changes to 3 micro-USD per Mbps-minute from 11:00
      Then each minute of [11:00, 12:00) still accrues 200 micro-USD

    @P3-S07 @need-P3-N1 @POL-27 @POL-01
    Scenario: An open-ended reservation's price changes only after price_notice, at a minute boundary
      Given a confirmed open-ended reservation of 100 Mbps on the route
      When a new `reservation_price` of 3 micro-USD per Mbps-minute is announced at 09:00:20 on day D
      Then the reservation accrues 200 micro-USD a minute until 09:01 on day D + 30 days, the first minute boundary at or after the announcement plus `price_notice` (POL-27)
      And 300 micro-USD a minute from then on

    @P3-S08 @need-P3-N1 @POL-07 @POL-01
    Scenario: A revoked reservation accrues nothing after the revocation takes effect
      Given a confirmed open-ended reservation on the route is revoked under a permanent reduction (POL-07)
      When the revocation takes effect
      Then the reservation accrues for no minute from then on

    @P3-S09 @need-P3-N1 @POL-16 @POL-01
    Scenario: A suspended account's reservation accrues during the grace, and not after its release
      Given a confirmed open-ended reservation of an account that is suspended (POL-16)
      When `suspension_grace` passes without funds and the reservation is released
      Then the reservation accrued for every minute of the grace
      And it accrues for no minute after its release

    @P3-S10 @need-P3-N1 @POL-07 @POL-01
    Scenario: A reservation affected by an unplanned outage keeps accruing and is marked for credit
      Given a confirmed reservation on the route is flagged as affected by an unplanned outage (POL-07)
      When the minutes of the outage pass
      Then the reservation accrues for each of them
      And each of those minutes is marked as affected, for SLA credit (Problem 6)

    @P3-S40 @need-P3-N1 @POL-08 @POL-27 @POL-01
    Scenario: An extension's added part accrues at the price in force when it was made; the existing part keeps its price
      Given a confirmed reservation of 100 Mbps for [10:00, 12:00) on the route, booked at 2 micro-USD per Mbps-minute
      And the route's `reservation_price` is now 3 micro-USD per Mbps-minute
      When the reservation is extended to end at 13:00
      Then each minute of [10:00, 12:00) accrues 200 micro-USD
      And each minute of [12:00, 13:00) accrues 300 micro-USD

    @P3-S42 @need-P3-N1 @POL-30 @POL-01
    Scenario: A terminated reservation accrues nothing after its termination, and what it accrued stands
      Given a confirmed reservation of 100 Mbps for [10:00, 12:00) on the route
      When Share terminates it at 10:15:30 for a reason in POL-30
      Then it accrues for each minute of [10:00, 10:16) and for no minute after
      And no charge already accrued is refunded

    @P3-S45 @need-P3-N1 @POL-08 @POL-27 @POL-01
    Scenario: A rate increase's added part accrues at the price in force when it was made
      Given a confirmed open-ended reservation of 100 Mbps on the route, booked at 2 micro-USD per Mbps-minute
      And the route's `reservation_price` is now 3 micro-USD per Mbps-minute
      When the reservation is increased to 150 Mbps at 10:29:20
      Then each minute from 10:30 accrues 350 micro-USD: 100 × 2 plus 50 × 3

    @P3-S46 @need-P3-N1 @POL-08 @POL-01
    Scenario Outline: A decrease removes the most recently added part first
      Given a confirmed open-ended reservation of 100 Mbps booked at 2 micro-USD per Mbps-minute, later increased by 50 Mbps at 3 micro-USD per Mbps-minute
      When its rate is decreased to <rate> Mbps
      Then each minute from the decrease's effective minute accrues <accrual> micro-USD

      Examples:
        | rate | accrual | parts left                       |
        | 100  | 200     | 100 Mbps at 2                    |
        | 80   | 160     | 80 Mbps at 2; the 3-priced part gone |

    @P3-S47 @need-P3-N1 @POL-07 @POL-01
    Scenario: A planned maintenance booking accrues nothing and is excluded from rating and settlement
      Given the supplier of a link on the route has booked planned maintenance taking 2 Mbps for [10:00, 12:00) (POL-07)
      When the minutes of the maintenance pass
      Then no accrual and no charge is made for the maintenance booking
      And it appears in no supplier's settlement (P4)

    @P3-S58 @need-P3-N1 @POL-01 @POL-07
    Scenario: A reservation whose rate is cut under a permanent reduction accrues at the cut rate from the end of the notice
      Given a confirmed open-ended reservation B of 4 Mbps on the route, to be cut to 2 Mbps when a permanent reduction's `revocation_notice` (POL-07) ends
      When the notice ends
      Then each minute of B before the end of the notice accrued 8 micro-USD
      And each minute from the end of the notice accrues 4 micro-USD: 2 Mbps × 2

    @P3-S59 @need-P3-N1 @POL-01 @POL-07 @POL-23 @POL-12
    Scenario Outline: A reservation moved to an equivalent path accrues at the lower of its original price and the new path's price
      Given a confirmed open-ended reservation of 100 Mbps on the route, booked at 2 micro-USD per Mbps-minute
      And its holder accepted an equivalent path whose `reservation_price` is <path price> micro-USD per Mbps-minute (POL-07)
      When the reservation has moved to the equivalent path
      Then each minute from the move accrues <accrual> micro-USD, split among the equivalent path's parties (P4)
      And Share pays the equivalent path's suppliers their shares of the Webster split of <difference> micro-USD a minute among the path's parties, from its own account, with no commission share posted (POL-23, POL-12, P4)

      Examples:
        | path price | accrual | difference | why                           |
        | 3          | 200     | 100        | 100 × 3 − 200: the path is dearer |
        | 1          | 100     | 0          | the path is cheaper; nothing to pay |

    @P3-S64 @need-P3-N1 @POL-27 @POL-08 @POL-01
    Scenario: A notified price change of an open-ended reservation applies to every part, one added after the announcement included
      Given an open-ended reservation of 100 Mbps booked at 2 micro-USD per Mbps-minute
      And a new price of 3 micro-USD per Mbps-minute for it was announced `price_notice` (POL-27) before 10:00
      And 50 Mbps were added to it after the announcement, at 2 micro-USD per Mbps-minute, the price then in force (POL-08)
      When the new price takes effect at 10:00
      Then from 10:00 the reservation accrues 450 micro-USD a minute: all 150 Mbps at 3 micro-USD per Mbps-minute

  Rule: A partner cancellation fee is charged only if shown at booking, and to the party the policy names

    @P3-S11 @need-P3-N12 @POL-08
    Scenario Outline: A partner cancellation fee is charged only if it was shown at booking
      Given a reservation over a partner leg with a cancellation fee that <shown> at booking
      When the account cancels the reservation
      Then the account is <charged>

      Examples:
        | shown         | charged                                               |
        | was shown     | charged the fee as shown                              |
        | was not shown | not charged any cancellation fee; Share pays it (P4)  |

    @P3-S43 @need-P3-N12 @POL-08
    Scenario Outline: A partner minimum term is charged as a cancellation fee on early cancellation
      Given a reservation over a partner leg with a minimum term of 30 days, shown at booking as a cancellation fee of 0.500000 USD
      When the account cancels the reservation <when> after it started
      Then <result>

      Examples:
        | when    | result                                        |
        | 2 days  | the account is charged 0.500000 USD           |
        | 31 days | the account is charged no cancellation fee    |

    @P3-S63 @need-P3-N12 @POL-08
    Scenario Outline: A shorten to a later end incurs a shown fee only if its new end falls inside a partner's minimum term
      Given a reservation over a partner leg with <terms> shown at booking, which started 2 days ago
      When the account shortens it to end <when> after it started
      Then <result>

      Examples:
        | terms                                                                    | when    | result                                      |
        | a minimum term of 30 days, charged as a cancellation fee of 0.500000 USD | 10 days | the account is charged 0.500000 USD         |
        | a minimum term of 30 days, charged as a cancellation fee of 0.500000 USD | 31 days | the account is charged no cancellation fee  |
        | a cancellation fee of 0.500000 USD and no minimum term                   | 10 days | the account is charged no cancellation fee  |

    @P3-S44 @need-P3-N12 @POL-08 @POL-07 @POL-16 @POL-30
    Scenario Outline: Who pays a shown cancellation fee depends on who ended the reservation early
      Given a reservation over a partner leg with a cancellation fee shown at booking
      When the reservation is <ended> within the partner's minimum term
      Then the fee is <payer>

      Examples:
        | ended                                                    | payer                                            |
        | released at the end of `suspension_grace` (POL-16)       | charged to the account                           |
        | terminated by Share (POL-30)                             | charged to the account                           |
        | revoked under a permanent reduction (POL-07)             | not charged to the account; Share pays it (P4)   |
        | cancelled by its account after its rate was cut under a permanent reduction (POL-07) | not charged to the account; Share pays it (P4) |

    @P3-S74 @need-P3-N12 @POL-08 @POL-11
    Scenario Outline: A booked window that ends inside a partner's minimum term incurs the fee shown on the offer
      Given a partner leg with a minimum term of 30 days, charged as a cancellation fee of 0.500000 USD
      And the offer for a reservation over it for a window of <window> showed <shown> before the account booked it
      When the reservation ends at its window's end
      Then <result>

      Examples:
        | window  | shown                                                  | result                                                                                     |
        | 10 days | that the fee of 0.500000 USD is charged when the window ends | the account is charged 0.500000 USD, as a charge line of its own that goes wholly to the partner (P4) |
        | 30 days | no fee                                                 | the account is charged no cancellation fee                                                 |

    @P3-S60 @need-P3-N12 @POL-08 @POL-11
    Scenario: A cancellation fee is a charge line of its own, charged at exactly its shown amount and once
      Given a reservation over a partner leg with a cancellation fee of 0.500000 USD shown at booking
      When the account cancels it within the partner's minimum term, and the cancellation is processed more than once
      Then one charge line for the fee is charged, of exactly 500,000 micro-USD, with no rounding
      And it is not split among the route's parties, and goes wholly to the partner (P4)

  Rule: Each charge line is charged exactly once

    @P3-S12 @need-P3-N2
    Scenario: A minute is charged once however charging is repeated
      Given the minute [10:05, 10:06) has accruals and traffic not yet charged
      When it is charged several times, at the same time or one after another
      Then each accrual and each record in it is charged once

    @P3-S13 @need-P3-N2
    Scenario: Charging that is interrupted or restarted charges every record not yet charged, once
      Given flow records have been received, some of them charged and some not
      When charging is interrupted and restarted with no record of where it had got to
      Then every record not yet charged is charged once
      And no record already charged is charged again

  Rule: Usage-priced traffic is counted exactly once, whatever the delivery

    Background:
      Given a best-effort product on a route with a `usage_price` (POL-01) of 10,000 micro-USD per GB
      And an account "a1" sending traffic on it

    @P3-S14 @need-P3-N3 @POL-01
    Scenario: A record delivered twice is counted once
      Given a flow record from exporter "e1" with sequence 7 for "a1"
      When the record is delivered twice
      Then its bytes are charged once

    @P3-S15 @need-P3-N3 @POL-01
    Scenario: Any delivery order, duplication and lateness gives the same charges as in-order delivery
      Given any set of flow records
      When they are delivered once each, in order of when the traffic happened
      And separately delivered in any order, with any of them repeated and any of them after their minute was charged
      Then both deliveries give the same total charge for every charge line

    @P3-S16 @need-P3-N3 @POL-01
    Scenario: A repeat of a record already charged causes no amendment
      Given the minute [12:05, 12:06) has been charged, including the record from exporter "e1" with sequence 7
      When that record is delivered again
      Then no amendment is made

    @P3-S17 @need-P3-N3 @need-P3-N2 @POL-01
    Scenario: A record arriving while its minute is being charged is neither lost nor counted twice
      Given the minute [12:05, 12:06) is being charged
      When a record for that minute arrives during the charging
      Then the record's bytes are in that minute's total charge exactly once

    @P3-S50 @need-P3-N3 @POL-01
    Scenario: A record from an exporter whose sequence numbers restarted is not mistaken for an earlier record
      Given the record from exporter "e1" with sequence 7 was charged
      And "e1" has since restarted its sequence numbers
      When a record for a different flow from "e1" with sequence 7 arrives
      Then it is charged as a new record

    @P3-S48 @need-P3-N5 @need-P3-N2 @POL-11 @POL-01
    Scenario: One account's traffic on two routes in the same minute gives two charge lines, each rounded once
      Given the product's `usage_price` is 10,000 micro-USD per GB on route "R1" and 13,000 micro-USD per GB on route "R2"
      When "a1" carries 150,000 bytes on "R1" and 150,000 bytes on "R2" in the minute starting 12:05
      Then "a1" is charged 1 micro-USD on "R1" (exactly 1.5) and 1 micro-USD on "R2" (exactly 1.95)
      And each charge is split by its own route's parties and weights (P4)

    @P3-S49 @need-P3-N13 @POL-17 @POL-01
    Scenario: Traffic reported by several legs is billed once, at the egress count
      Given a route of three legs whose exporters report the same traffic of "a1" in the minute starting 12:05
      And the legs report 1.00 GB, 0.99 GB and 0.98 GB, the last being where the traffic leaves the route
      When the minute is charged
      Then "a1" is charged once for that traffic, 9,800 micro-USD for 0.98 GB
      And the suppliers of the route are paid their split of that charge (P4)

    @P3-S67 @need-P3-N13 @POL-17 @POL-01
    Scenario: When a route's last leg is a partner link Share does not meter, the count at the hand-off to that partner is billed
      Given a route over Share link L1 and partner link P, which Share does not meter
      And in one minute L1 counts 1.1 GB of an account's usage-priced traffic entering it and 1.0 GB handed off to P
      When the minute is charged
      Then the account is charged once, for 1.0 GB, the count at the hand-off to P (POL-17)

  Rule: A record's bytes belong to the minutes in which its flow was active

    Background:
      Given a best-effort product on a route with a `usage_price` (POL-01) of 10,000 micro-USD per GB
      And an account "a1" sending traffic on it

    @P3-S18 @need-P3-N4 @POL-13 @POL-01
    Scenario Outline: A record within one minute belongs to that minute; minutes are half-open
      Given a flow record for "a1" of a flow active from <start> to <end>
      When the record is charged
      Then its bytes are charged in the minute [<minute>, <next>)

      Examples:
        | start    | end      | minute   | next     |
        | 12:05:10 | 12:05:50 | 12:05:00 | 12:06:00 |
        | 12:05:30 | 12:06:00 | 12:05:00 | 12:06:00 |
        | 12:06:00 | 12:06:20 | 12:06:00 | 12:07:00 |
        | 12:05:10 | 12:05:10 | 12:05:00 | 12:06:00 |

    @P3-S19 @need-P3-N4 @POL-13 @POL-01
    Scenario Outline: A record spanning several minutes is spread in proportion to the seconds active in each
      Given a flow record for "a1" of 3 GB for a flow active from <start> to <end>
      When the record is charged
      Then <split>

      Examples:
        | start    | end      | split                                                                               |
        | 12:05:00 | 12:08:00 | 1 GB is charged in each of the minutes starting 12:05, 12:06 and 12:07              |
        | 12:05:30 | 12:07:00 | 1 GB is charged in the minute starting 12:05 and 2 GB in the minute starting 12:06  |

    @P3-S51 @need-P3-N4 @need-P3-N5 @POL-13 @POL-11 @POL-01
    Scenario: A proportion that is not a whole number of bytes is priced exactly, and each minute's charge rounded once
      Given a flow record for "a1" of 3 GB for a flow active from 12:05:20 to 12:06:30
      When the record is charged
      Then the minute starting 12:05 is charged 17,142 micro-USD, exactly 120,000/7 (40 of 70 seconds)
      And the minute starting 12:06 is charged 12,857 micro-USD, exactly 90,000/7 (30 of 70 seconds)

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

    @P3-S21 @need-P3-N5 @POL-11 @POL-27
    Scenario Outline: A charge is computed exactly and rounded once, down to the micro
      Given the minute starting 12:05 carried <bytes> bytes of "a1"'s traffic
      When the minute is charged
      Then the charge, exactly <exact> micro-USD, is <charge> micro-USD

      Examples:
        | bytes      | exact   | charge |
        | 1000000000 | 10000   | 10000  |
        | 150000     | 1.5     | 1      |
        | 99999      | 0.99999 | 0      |

    @P3-S52 @need-P3-N4 @need-P3-N5 @POL-13 @POL-27
    Scenario: A record spread across a price change prices each part at its own minute's price
      When a record of 1 GB for "a1" for a flow active from 12:19:30 to 12:20:30 is charged
      Then the minute starting 12:19 is charged 5,000 micro-USD for 0.5 GB at 10,000
      And the minute starting 12:20 is charged 6,500 micro-USD for 0.5 GB at 13,000

    @P3-S69 @need-P3-N5 @POL-27 @POL-17
    Scenario Outline: A usage_price changes only after price_notice, whatever traffic it prices
      Given a product and route with a `usage_price` for <traffic>
      When a new `usage_price` for it is announced
      Then the new price takes effect at a minute boundary no earlier than `price_notice` (POL-27) after the announcement

      Examples:
        | traffic                                                             |
        | a best-effort product                                               |
        | burst on a guaranteed product that permits it                       |
        | attributable traffic outside a reservation on a guaranteed product  |

  Rule: Each kind of traffic is billed by its rule

    Background:
      Given a guaranteed product on a route, which carries a `usage_price` (POL-17) of 10,000 micro-USD per GB
      And a confirmed reservation of 100 Mbps on the route for account "a1" for [11:00, 12:00)

    @P3-S22 @need-P3-N6 @POL-01 @POL-17
    Scenario: Traffic within the reserved rate is covered by the reservation's accrual
      Given the product does not permit burst
      When "a1" carries 0.75 GB on the reservation in the minute starting 11:30
      Then no charge for usage-priced traffic is made for that minute

    @P3-S23 @need-P3-N6 @POL-17
    Scenario: Permitted burst is billed at usage_price for the excess only
      Given the product permits burst
      When "a1" carries 1.75 GB on the reservation in the minute starting 11:30, 1 GB more than 100 Mbps for 60 s
      Then a charge of 10,000 micro-USD for usage-priced traffic is made for that minute, for the 1 GB of burst

    @P3-S54 @need-P3-N6 @POL-17
    Scenario: Burst is measured per minute, not per second
      Given the product permits burst
      When "a1" carries 200 Mbps for 30 s and nothing for 30 s in the minute starting 11:30, 0.75 GB in all
      Then no charge for usage-priced traffic is made for that minute

    @P3-S24 @need-P3-N6 @POL-17
    Scenario: Traffic above the reserved rate on a product without burst is dropped and not billed
      Given the product does not permit burst
      When "a1" sends more than 0.75 GB in the minute starting 11:30 and the excess is dropped at the edge
      Then no charge for usage-priced traffic is made for that minute
      And the records for that minute are kept

    @P3-S41 @need-P3-N6 @need-P3-N7 @POL-17
    Scenario: Excess carried despite policing on a product without burst is not billed to the buyer, and raises an incident
      Given the product does not permit burst
      When records show "a1" carrying more than 0.75 GB in the minute starting 11:30
      Then the records are kept
      And no charge for the excess is made to "a1"
      And the policing failure is raised as an incident to network operations

    @P3-S25 @need-P3-N6 @POL-17 @POL-18
    Scenario: Attributable traffic outside an active reservation is billed at usage_price and counts toward usage exposure
      When records show 1 GB of traffic attributable to "a1" in the minute starting 12:30, outside any active reservation of "a1"
      Then it is charged 10,000 micro-USD, at the product's `usage_price` (POL-17)
      And it counts toward "a1"'s usage exposure (POL-18) until it is posted

    @P3-S53 @need-P3-N4 @need-P3-N6 @POL-13 @POL-17
    Scenario: A record spread across the end of a reservation is covered for the minute inside it and billed for the minute outside
      When a record of 1 GB for "a1" for a flow active from 11:59:30 to 12:00:30 is charged
      Then the 0.5 GB in the minute starting 11:59 is covered by the reservation's accrual
      And the 0.5 GB in the minute starting 12:00 is charged 5,000 micro-USD at `usage_price`

    @P3-S26 @need-P3-N6 @POL-17
    Scenario: Traffic that cannot be attributed is quarantined, not billed, and reported
      When a record arrives for traffic that cannot be attributed to any account
      Then it is quarantined and not charged
      And it is reported to operations and to the supplier of the link it crossed

    @P3-S77 @need-P3-N6 @need-P3-N7 @POL-17
    Scenario: A record from an observation domain not registered to its exporter is kept and quarantined, and charged only if finance attributes it
      When a record from exporter "e1" arrives from an observation domain that is not registered to "e1"
      Then it is kept with the reason "domain not of exporter"
      And its traffic is quarantined and not charged, unless an operator in finance attributes it to an account within `dispute_window` (POL-17)

    @P3-S27 @need-P3-N6 @POL-17
    Scenario Outline: Quarantined traffic is billed, and its supplier paid, only if attributed within dispute_window
      Given 1 GB of traffic in a minute on a supplier's link was quarantined, at a `usage_price` of 10,000 micro-USD per GB in that minute
      When an operator attributes it to account "a1" <when>
      Then <result>

      Examples:
        | when                              | result                                                                         |
        | within `dispute_window` (POL-17)  | "a1" is charged 10,000 micro-USD, at the price of the traffic's minute, and the supplier is paid its split (P4) |
        | after `dispute_window` (POL-17)   | "a1" is not charged, and the supplier is not paid for it                       |

    @P3-S65 @need-P3-N6 @POL-17 @POL-23
    Scenario: A mistaken attribution of quarantined traffic is reversed at Share's cost, and the supplier keeps what it was paid
      Given 1 GB of quarantined traffic, at a `usage_price` of 10,000 micro-USD per GB in its minute, was attributed to account "a1", which was charged 10,000 micro-USD, and its supplier was paid its split (P4)
      When an operator in finance reverses that attribution within `dispute_window` (POL-17), giving a reason
      Then "a1"'s charge for that traffic is amended to zero, by an amendment of -10,000 micro-USD with cause Share (POL-23)
      And the supplier keeps what it was paid, Share bearing it in full
      And the traffic cannot be attributed to any account again

  Rule: No record is silently discarded

    @P3-S28 @need-P3-N7
    Scenario Outline: A record that cannot be used is kept with its reason and not charged
      When a flow record arrives with <defect>
      Then it is kept with the reason "<defect>"
      And nothing is charged for it

      Examples:
        | defect                                 |
        | missing flow times                     |
        | missing attribution key                |
        | a negative byte count                  |
        | an end time before its start time      |

    @P3-S29 @need-P3-N7
    Scenario: A record that cannot be used does not delay the records behind it
      Given a record that cannot be used arrives before valid records from the same exporter
      When the records are received
      Then the valid records are charged as if the unusable one had not arrived

    @P3-S30 @need-P3-N7 @POL-23
    Scenario: A kept record that is corrected by its own exporter is charged once
      Given a record that could not be used was kept with its reason
      When the exporter that produced it submits a corrected version of it, any number of times
      Then its bytes are charged once
      And a corrected version submitted by any other principal, an operator included, is refused and recorded (POL-23)

    @P3-S78 @need-P3-N7 @POL-23 @POL-17
    Scenario Outline: A corrected version of a record that could not be used is charged only if it is submitted before its deadline
      Given a record from exporter "e1", active only in the minute starting 12:05 on day D, could not be used, and was first received at 12:07 on day D
      When "e1" submits a corrected version of it at <time>
      Then <result>

      Examples:
        | time                | result                                                                                                              |
        | 12:05 on day D + 30 | its bytes are charged once (POL-23)                                                                                  |
        | 12:06 on day D + 30 | it is refused as outside `dispute_window` (POL-17: 30 days from 12:06 on day D, the end of its last minute), recorded, and nothing is charged for it |

    @P3-S71 @need-P3-N7 @need-X1-N11 @POL-19 @POL-17
    Scenario: A payload that does not conform to the record template is rejected, and outside the erasable store only its identity, digest and reason are kept
      Given an exporter sends a payload that does not conform to the record template, declaring fields the template does not accept
      When usage ingestion receives it
      Then it is rejected, and nothing is charged for it
      And the logs and the record kept of it hold its identity, its keyed digest and the reason "does not conform to the record template", and nothing more of it
      And the payload itself, if it is kept, is kept only in the erasable personal-data store, keeping it not being required (POL-19)
      And it can no longer be recovered from any copy Share holds, backups and escrowed copies included, by `dispute_window` (POL-17) + 7 days after its receipt, or earlier, once an erasure request covering it is executed (POL-19)

    @P3-S75 @need-P3-N7 @need-X1-N11 @POL-19
    Scenario Outline: A non-conforming payload that is not kept still leaves its identity, keyed digest and reason, and is counted
      Given an exporter sends a payload that does not conform to the record template
      And <condition>
      When usage ingestion receives it
      Then it is rejected, and nothing is charged for it
      And the payload is not kept anywhere (POL-19)
      And the logs and the record kept of it hold its identity, its keyed digest and the reason "does not conform to the record template"
      And it is counted among the payloads not kept, and the count is reported to network operations

      Examples:
        | condition                                                                      |
        | keeping it would exceed the caps the design states on payloads kept from that exporter |
        | the erasable personal-data store does not take it in time                      |

    @P3-S31 @need-P3-N7
    Scenario: An accepted record is never altered or removed
      Given an accepted flow record
      When any principal, operators included, tries to alter or remove it
      Then the attempt is refused and recorded
      And the record is unchanged

    @P3-S66 @need-P3-N7 @need-P3-N8 @POL-23 @POL-17 @POL-11
    Scenario Outline: A corrected version of an accepted record, from its own exporter within dispute_window, supersedes it for charging
      Given an accepted record of 2 GB of usage-priced traffic of account "a1" in one minute, at a `usage_price` of 10,000 micro-USD per GB, charged 20,000 micro-USD
      And the exporter that produced it is <owner>'s
      When that exporter submits a corrected version of the record, of 1 GB, <when> after the end of that minute
      Then <result>
      And the original record is kept, unaltered

      Examples:
        | owner                     | when                             | result                                                                                                     |
        | the route's only supplier | within `dispute_window` (POL-17) | "a1"'s charge is amended by -10,000 micro-USD (POL-11), the supplier owing its own reduction as a supplier debt (POL-23) |
        | Share                     | within `dispute_window` (POL-17) | "a1"'s charge is amended by -10,000 micro-USD (POL-11), borne by Share in full (POL-23)                    |
        | the route's only supplier | after `dispute_window` (POL-17)  | the charge is not amended                                                                                  |

    @P3-S72 @need-P3-N7 @POL-23 @POL-17
    Scenario Outline: A superseding record may change only measured fields, never the record's identity or attribution keys
      Given an accepted record of 2 GB of usage-priced traffic of account "a1", active only in the minute starting 12:05
      When its own exporter submits, within `dispute_window` (POL-17), a corrected version of it that <change>
      Then <result>

      Examples:
        | change                                                                    | result                                                 |
        | changes its bytes to 1 GB, and its packets                                | it supersedes the original for charging (POL-23)       |
        | moves its end time within the minute starting 12:05                       | it supersedes the original for charging (POL-23)       |
        | moves its start and end times into the minute starting 12:07              | it is refused and recorded, and the original stands    |
        | changes a field by which its traffic is attributed to "a1" or to a reservation | it is refused and recorded, and the original stands |

    @P3-S73 @need-P3-N7 @need-P3-N6 @POL-23 @POL-17
    Scenario: A superseding record of a quarantined record is itself quarantined
      Given a record of 1 GB whose traffic could not be attributed to any account was quarantined (POL-17)
      When its own exporter submits a corrected version of it, of 0.5 GB, within `dispute_window` (POL-17)
      Then the corrected version is quarantined in the original's place (POL-23), and nothing is billed for either
      And the original is kept, unaltered

  Rule: Past charges are amended, never rewritten, and every amendment is explained

    Background:
      Given a best-effort product on a route with a `usage_price` (POL-01) of 10,000 micro-USD per GB
      And an account "a1" sending traffic on it
      And it is within `dispute_window` (POL-17) of the minutes below, unless a scenario says otherwise

    @P3-S32 @need-P3-N8 @POL-11 @POL-01 @POL-17
    Scenario Outline: A late record for a charged minute adds an amendment, computed on the line's new total, and leaves the charge as it was
      Given the minute starting 12:05 carried <on time> bytes of "a1"'s traffic and was charged <original> micro-USD
      When a late record of <late> bytes for that minute arrives
      Then an amendment of <amendment> micro-USD with the reason "late traffic" is made for that minute
      And the original charge is still <original> micro-USD

      Examples:
        | on time    | original | late       | amendment | why                                      |
        | 1000000000 | 10000    | 1000000000 | 10000     | 20,000 new total less 10,000 charged     |
        | 75000      | 0        | 75000      | 1         | exactly 1.5 new total, rounded to 1, less 0 |

    @P3-S33 @need-P3-N8 @POL-01 @POL-17
    Scenario: Late traffic never decreases a charge
      Given any records arriving late, repeated and out of order
      When they are charged
      Then every amendment they cause increases the charge it amends

    @P3-S34 @need-P3-N8 @POL-23 @POL-01 @POL-17
    Scenario: A price correction lowering a price is an amendment, with who made it, the cause and the reason
      Given 10 GB of "a1"'s traffic in a charged minute at 10,000 micro-USD per GB, charged 100,000 micro-USD
      When an authorised operator corrects the price for that minute to 5,000 micro-USD per GB, giving the cause "Share" and a reason
      Then an amendment of minus 50,000 micro-USD is made for that minute, recording the operator, the cause and the reason
      And the original charge is still 100,000 micro-USD

    @P3-S55 @need-P3-N8 @POL-23 @POL-01 @POL-17
    Scenario: A price correction raising a best-effort price is an amendment upward
      Given 10 GB of "a1"'s traffic in a charged minute at 10,000 micro-USD per GB, charged 100,000 micro-USD
      When an authorised operator corrects the price for that minute to 12,000 micro-USD per GB, giving a cause and a reason
      Then an amendment of 20,000 micro-USD is made for that minute, recording the operator, the cause and the reason

    @P3-S56 @need-P3-N8 @POL-23 @POL-27 @POL-01 @POL-17
    Scenario Outline: A reservation price locked at booking can only be corrected downwards
      Given a reservation of 100 Mbps booked at 2 micro-USD per Mbps-minute, whose minutes were charged 200 micro-USD each
      When an authorised operator corrects its price to <price> micro-USD per Mbps-minute for those minutes, giving a cause and a reason
      Then <result>

      Examples:
        | price | result                                                         |
        | 1     | an amendment of minus 100 micro-USD is made for each minute    |
        | 3     | the correction is refused, and no amendment is made            |

    @P3-S57 @need-P3-N8 @POL-23 @POL-17 @POL-01
    Scenario: A price correction after dispute_window is refused
      Given a charged minute of "a1" more than `dispute_window` (POL-17) ago
      When an authorised operator tries to correct its price
      Then the correction is refused, and no amendment is made

    @P3-S35 @need-P3-N8 @POL-01 @POL-17
    Scenario: A buyer can see, for any minute, the original charge and every amendment with its reason
      Given a minute of "a1" has an original charge and two amendments
      When "a1" asks for that minute's charges
      Then the original charge and both amendments are shown, each with its reason and time

    @P3-S70 @need-P3-N8 @POL-17 @POL-23 @POL-01
    Scenario Outline: dispute_window runs from the end of the minute the charge belongs to
      Given a charge of "a1" for the minute [10:00, 10:01) on day D
      When an operator in finance corrects its price at <when>
      Then the correction is <result>

      Examples:
        | when                    | result                             | case                                                                |
        | 10:00:59 on day D + 30  | made, as an amendment              | before 10:01 on day D + 30, `dispute_window` (POL-17: 30 days) after the minute's end |
        | 10:01 on day D + 30     | refused, and no amendment is made  | `dispute_window` has passed                                         |

  Rule: Every charge can be reproduced from what was recorded

    @P3-S36 @need-P3-N9
    Scenario: Recomputing any period gives exactly the recorded charges and amendments
      Given any period for which charges and amendments have been made
      When the period is recomputed from the stored records, the reservation history, the price history, every recorded operator decision with its reason (price corrections, quarantine attributions, corrected records, fees shown at booking) and every standing change
      Then the recomputed charges and amendments equal the recorded ones

  Rule: Usage exposure is visible, and breaches of its assumptions are reported

    @P3-S37 @need-P3-N10 @POL-14 @POL-18 @POL-06 @POL-13
    Scenario: The business can see each account's usage exposure, in its two parts
      Given account "a1" uses one best-effort product whose highest `usage_price` on any route is 10,000 micro-USD per GB
      And "a1"'s `usage_rate_cap` (POL-14) on it is 100 Mbps
      And records of 0.2 GB of "a1"'s usage-priced traffic have been accepted by usage ingestion but not yet posted
      When finance asks for "a1"'s usage exposure
      Then the unposted usage is 2,000 micro-USD, at 10,000 micro-USD per GB in those minutes
      And the lateness bound is 53,750 micro-USD: 100 Mbps for `max_lateness` (180 s) plus `flow_active_timeout` (60 s) plus 60 s of minute granularity plus `attribution_lag_max` (10 s) plus admission's 60 s recovery time (POL-06) plus the 60 s enforcement target, 430 s, 5.375 GB, at 10,000 micro-USD per GB
      And the usage exposure is 55,750 micro-USD

    @P3-S38 @need-P3-N10 @POL-14
    Scenario: A record later than max_lateness is still charged and reported as a breach
      When a record arrives later than `max_lateness` (POL-14) after the end of its minute
      Then it is charged like any late record
      And it is reported as a breach of the usage exposure bound, with its exporter and lateness

    @P3-S61 @need-P3-N10 @POL-14 @POL-18
    Scenario: An accepted record counts in unposted usage from within attribution_lag_max of its acceptance until it is posted
      Given account "a1" uses a best-effort product
      When usage ingestion accepts a flow record of "a1"'s usage-priced traffic
      Then within `attribution_lag_max` (POL-14) of its acceptance, its traffic is counted in "a1"'s unposted usage, and so in its headroom (POL-18)
      And it stays counted in unposted usage until its charge is posted, and no longer

    @P3-S62 @need-P3-N10 @POL-14
    Scenario: A record counted in unposted usage later than attribution_lag_max after its acceptance is reported as a breach
      When an accepted record is counted in its account's unposted usage later than `attribution_lag_max` (POL-14) after its acceptance
      Then it is reported as a breach of the usage exposure bound, with its exporter and attribution lag
      And it is charged like any other record

    @P3-S68 @need-P3-N10 @POL-14 @POL-13
    Scenario Outline: A record spread over several minutes is late only from the end of the last minute it was active in
      Given a flow record of usage-priced traffic active from 10:00:00 to 10:02:00
      When it arrives at <arrival>
      Then it is <outcome>

      Examples:
        | arrival  | outcome                                                       | case                                                      |
        | 10:04:50 | charged, and not reported as a breach                         | 170 s after 10:02, within `max_lateness` (POL-14: 180 s) |
        | 10:05:10 | charged, and reported as a breach of the usage exposure bound | 190 s after 10:02                                         |

    @P3-S76 @need-P3-N10 @POL-14 @POL-06
    Scenario Outline: After a change of usage_rate_cap, the lateness bound uses the highest cap in force over its span
      Given account "a1" uses one best-effort product whose highest `usage_price` on any route is 10,000 micro-USD per GB, with a `usage_rate_cap` (POL-14) of 100 Mbps
      And at 10:00:30 an operator in finance records a `usage_rate_cap` of <new> for it, which takes effect at 10:02:00, the first minute boundary at least the 60 s enforcement target after its record (POL-14)
      When finance asks for "a1"'s lateness bound at <time>
      Then it is <bound> micro-USD: <cap> for 430 s, <gb> GB, at 10,000 micro-USD per GB

      Examples:
        | new      | time     | cap      | gb     | bound   | case                                                                    |
        | 50 Mbps  | 10:05:00 | 100 Mbps | 5.375  | 53,750  | the span, 370 s back and 60 s ahead, still includes minutes at 100 Mbps |
        | 50 Mbps  | 10:10:00 | 50 Mbps  | 2.6875 | 26,875  | the span starts at 10:03:50, after the decrease took effect             |
        | 200 Mbps | 10:00:45 | 100 Mbps | 5.375  | 53,750  | the span ends at 10:01:45, before the increase takes effect             |
        | 200 Mbps | 10:01:30 | 200 Mbps | 10.75  | 107,500 | the span ends at 10:02:30, after the increase takes effect              |

  Rule: Accepted records are kept as evidence of what was delivered

    @P3-S39 @need-P3-N11
    Scenario: Accepted records can be retrieved by reservation, link and minute
      Given accepted flow records within the retention period (X2)
      When operations or the SLA work asks for the traffic of a reservation, or on a link, in a range of minutes
      Then every accepted record for that reservation or link in those minutes is returned
