# Spec for X2: non-functional targets (cross-cutting; inherited by P1-P4).
# Problem statement: ../01-discovery/X2-non-functional-targets.md (with the measurement
# method for each target)
# Terms: glossary.md. Policies: policy-register.md.
#
# Tags: @X2-Snn is the scenario's stable ID; @need-X2-Nn is the need it serves; @POL-nn a
# policy it depends on. Conformance (design, tests, status) is kept in conformance.md.
#
# Every value in the Examples tables is the POL-06 default (or POL-04, POL-26 where
# stated). "The design load" is the X2-N2 profile.

Feature: Non-functional targets

  As a buyer or AI agent
  I want answers fast enough to call synchronously, from a service that is up
  So that I can build on the marketplace

  As Share finance and compliance
  I want no acknowledged reservation, money movement, payment event or accepted record ever lost, and records kept 7 years
  So that the books and the schedule can always be trusted and audited

  Rule: Each capability meets its availability target

    @X2-S01 @need-X2-N1 @POL-06
    Scenario Outline: Availability per capability
      When the availability of <capability> is measured in each region over a calendar month
      Then it is at least <target>

      Examples:
        | capability                            | target                |
        | the admission API                     | 99.99%                |
        | usage ingestion                       | 99.99%                |
        | the wallet                            | 99.9%                 |
        | payouts                               | 99.9%                 |
        | reporting and statements              | 99.9%                 |

    @X2-S02 @need-X2-N1 @need-X2-N4 @POL-06
    Scenario: Ingestion may lag but never loses an accepted record
      Given usage ingestion is behind the arriving records
      When it catches up
      Then every record accepted before and during the lag has been processed

  Rule: The system sustains the design load

    @X2-S03 @need-X2-N2 @POL-06
    Scenario: Admission sustains the design load, on the hottest link too, within its latency targets
      Given admission requests at 25,000 per second overall, of which 2,500 per second are on one link
      When the load is sustained for one hour
      Then every latency target in X2-S05 and X2-S06 is met

    @X2-S04 @need-X2-N2 @POL-06
    Scenario: Metering keeps up with the design volume of traffic
      Given traffic at about 2.25 PB per day, 50 times 45 TB per day
      When the load is sustained for one hour
      Then the delay between a record's arrival and its being charged does not grow

  Rule: Each operation meets its latency target under the design load

    @X2-S05 @need-X2-N3 @POL-06 @POL-04
    Scenario Outline: A single-link booking gets its final answer within ack_budget, whatever the booking's length
      Given the design load
      When buyers book single links for windows of <length>
      Then the 99th percentile time to a final answer is at most 200 ms

      Examples:
        | length      |
        | one minute  |
        | one day     |
        | 12 months   |
        | open-ended  |

    @X2-S06 @need-X2-N3 @POL-06 @POL-04 @POL-26
    Scenario: A route booking is acknowledged within ack_budget and has its outcome within its deadline
      Given the design load
      When buyers book routes
      Then the 99th percentile time to the first response is at most 200 ms
      And every request has its outcome within its deadline

    @X2-S07 @need-X2-N3 @POL-06
    Scenario: A top-up is credited within 10 s of the provider's notification
      When payment notifications for completed top-ups arrive under the design load
      Then the 99th percentile time from notification to credited headroom is at most 10 s

    @X2-S08 @need-X2-N3 @POL-06
    Scenario: Suspension is enforced within 60 s of the decision
      When an account is suspended
      Then its usage-priced traffic is blocked at the edge within 60 s of the decision

    @X2-S13 @need-X2-N3 @need-P3-N2 @POL-06 @POL-14
    Scenario Outline: Charges are posted within their timeliness target
      When a minute ends with <charge>
      Then that charge is posted within <target> of the minute's end

      Examples:
        | charge                                  | target                                  |
        | a reservation's accrual for the minute  | 2 min                                   |
        | usage-priced traffic                    | `max_lateness` (POL-14) + 2 min         |

  Rule: No acknowledged fact is lost beyond its recovery point

    @X2-S09 @need-X2-N4 @POL-06
    Scenario Outline: An acknowledged fact survives the loss of a node or a zone
      Given <fact> has been acknowledged
      When a node or a whole zone of the region fails and the system recovers
      Then <fact> is present and unchanged

      Examples:
        | fact                          |
        | a confirmed reservation       |
        | a posted money movement       |
        | a received payment event      |
        | an accepted usage record      |

    @X2-S12 @need-X2-N4 @POL-06
    Scenario: On the loss of a region, at most the last minute of acknowledged facts can be lost
      Given confirmed reservations, money movements, payment events and accepted usage records acknowledged in a region
      When the whole region fails and service is recovered elsewhere
      Then every fact acknowledged more than 1 min before the failure is present and unchanged

  Rule: Each capability recovers within its target

    @X2-S10 @need-X2-N5 @POL-06
    Scenario Outline: Recovery time per capability and failure scope
      When <capability> loses <scope>
      Then it answers correctly again within <target>

      Examples:
        | capability  | scope           | target |
        | admission   | a node or zone  | 5 min  |
        | billing     | a node or zone  | 15 min |
        | the wallet  | a node or zone  | 15 min |
        | admission   | a region        | 1 h    |
        | billing     | a region        | 1 h    |
        | the wallet  | a region        | 1 h    |

  Rule: Records are kept for the retention period

    @X2-S11 @need-X2-N6 @POL-06 @POL-19
    Scenario Outline: Records can be retrieved up to the end of the retention period
      Given <record> is 7 years old, less one day
      When it is asked for
      Then it is returned unchanged

      Examples:
        | record                                |
        | a ledger money movement               |
        | a payment event                       |
        | a reservation change in the history   |
        | an accepted usage record              |
