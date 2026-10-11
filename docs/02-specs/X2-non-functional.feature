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

  Rule: Each capability meets its availability target, measured by probes from outside the region

    @X2-S01 @need-X2-N1 @POL-06
    Scenario Outline: Availability per capability
      When the availability of <capability> is measured in each region over a calendar month, as the share of available minutes (X2-N1)
      Then it is at least <target>

      Examples:
        | capability                            | target                |
        | the admission API                     | 99.99%                |
        | usage ingestion                       | 99.99%                |
        | the wallet                            | 99.9%                 |
        | payouts                               | 99.9%                 |
        | reporting and statements              | 99.9%                 |

    @X2-S16 @need-X2-N1 @POL-06
    Scenario Outline: A minute is available only if at least 90% of its probes succeed
      Given a capability probed at least every 10 s from at least two locations outside the region
      When in one minute <succeeded> of its <probes> probes get a correct answer within the capability's per-probe limit (X2-S18)
      Then the minute counts as <counted>

      Examples:
        | probes | succeeded | counted     | case                                         |
        | 12     | 11        | available   | 91.7%                                        |
        | 12     | 10        | unavailable | 83.3%                                        |
        | 12     | 12        | available   | every probe succeeds, during planned maintenance too |

    @X2-S18 @need-X2-N1 @POL-06 @POL-18
    Scenario Outline: Each capability is probed by its own operation, against its own per-probe limit
      When <capability> is probed
      Then the probe asks for <operation>
      And it succeeds only if it gets a correct answer within <limit>

      Examples:
        | capability               | operation                                   | limit  |
        | the admission API        | a single-link booking answer                | 200 ms |
        | usage ingestion          | a flow record acknowledged as accepted      | 1 s    |
        | the wallet               | a balance and headroom answer               | 200 ms |
        | payouts                  | a payout's status                           | 1 s    |
        | reporting and statements | one day's statement                         | 2 s    |

    @X2-S20 @need-X2-N1 @POL-06 @POL-18
    Scenario Outline: Probes run end to end as a designated probe account, without business side effects
      Given the designated Share probe account, with its designated probe links and exporters in the region (POL-06)
      When a probe <action>
      Then it is handled on the same path as any buyer's or exporter's
      And nothing it does is rated, settled, shown in a supplier report or reported as quarantined traffic

      Examples:
        | action                                                       |
        | books a single probe link, with its funds hold               |
        | sends a flow record from a probe exporter and it is accepted |
        | asks for the probe account's balance and headroom            |

    @X2-S02 @need-X2-N1 @need-X2-N4 @POL-06
    Scenario: Ingestion may lag but never loses an accepted record
      Given usage ingestion is behind the arriving records
      When it catches up
      Then every record accepted before and during the lag has been processed

  Rule: The system sustains the design load

    @X2-S03 @need-X2-N2 @POL-06
    Scenario: Admission sustains the design load, on the hottest link too, within its latency targets
      Given admission requests at 25,000 per second overall, of which 2,500 per second are on one link
      And 80% of them single-link bookings and 20% routes, of which 70% fit
      When the load is sustained for one hour
      Then every latency target in X2-S05, X2-S15 and X2-S06 is met

    @X2-S04 @need-X2-N2 @POL-06
    Scenario: Metering keeps up with the design volume of traffic
      Given traffic at about 2.25 PB per day, 50 times 45 TB per day, as flow records of 100 KB on average
      And records arriving at about 260,000 per second on average, with peaks of 600,000 per second
      When the load is sustained for one hour
      Then the timeliness targets of X2-S13 are met throughout

  Rule: Each operation meets its latency target under the design load

    @X2-S05 @need-X2-N3 @POL-06 @POL-04
    Scenario Outline: A single-link booking is answered, final or pending, within ack_budget, whatever the booking's length
      Given the design load
      When buyers book single links for windows of <length>
      Then the 99th percentile time to an answer, final or pending, is at most 200 ms

      Examples:
        | length      |
        | one minute  |
        | one day     |
        | 12 months   |
        | open-ended  |

    @X2-S15 @need-X2-N3 @POL-06 @POL-04
    Scenario: A single-link booking on a link with no capacity in flight gets its final answer within ack_budget
      Given the design load
      When buyers book single Share links on which no capacity is in flight
      Then the 99th percentile time to a final answer is at most 200 ms

    @X2-S06 @need-X2-N3 @POL-06 @POL-04 @POL-26
    Scenario: A route booking is acknowledged within ack_budget and has its outcome by its deadline
      Given the design load
      When buyers book routes
      Then the 99th percentile time to the first response is at most 200 ms
      And every request has its outcome by its deadline

    @X2-S07 @need-X2-N3 @POL-06 @POL-18
    Scenario: A top-up is credited within 10 s of the provider's notification
      Given payment notifications at their design peak of 1,000 per second
      When notifications for completed top-ups arrive
      Then the 99th percentile time from notification to credited headroom is at most 10 s

    @X2-S17 @need-X2-N3 @POL-06 @POL-16
    Scenario: A change of standing reaches network operations within standing_notice_time of the decision
      When an account is suspended or resumed
      Then network operations has the new standing within `standing_notice_time` (POL-06: 10 s) of the decision

    @X2-S08 @need-X2-N3 @POL-06 @POL-16
    Scenario: Suspension is enforced within 60 s of the decision
      When an account is suspended
      Then its usage-priced traffic is blocked at the edge within 60 s of the decision, network operations' part being what remains after `standing_notice_time`

    @X2-S13 @need-X2-N3 @POL-06 @POL-14
    Scenario Outline: Charges are posted within their timeliness target, and never later than recovery allows
      When the charges for the minutes of a calendar month are posted
      Then for at least 99.99% of those minutes, leaving out minutes affected by a declared region disaster (X2-S19), <charge> is posted to the ledger within <target> of the minute's end
      And every such charge for a minute not affected by a declared region disaster is posted within <bound> of the minute's end: the target plus the 5-minute recovery time of rating and posting on the loss of a node or zone (X2-S10)

      Examples:
        | charge                                                          | target                          | bound                  |
        | a reservation's accrual for the minute                          | 2 min                           | 7 min                  |
        | usage-priced traffic whose records arrive within `max_lateness` | `max_lateness` (POL-14) + 2 min | `max_lateness` + 7 min |

    @X2-S19 @need-X2-N3 @need-X2-N4 @POL-06 @POL-14
    Scenario Outline: On a declared region disaster, the affected minutes' charges are posted within their target plus the regional recovery time
      Given a region is lost, the loss is declared a disaster, and rating and posting recovers within its 1 h regional recovery time (X2-S10)
      When the charges for the minutes affected by the disaster are posted
      Then those minutes are left out of the 99.99% measurement of charge timeliness
      And every <charge> for them is posted within <bound> of the minute's end: its target plus 1 h
      And no charge for them is lost or posted twice

      Examples:
        | charge                                                          | bound                       |
        | reservation accrual                                             | 1 h 2 min                   |
        | usage-priced charge whose records arrive within `max_lateness` (POL-14) | `max_lateness` + 1 h 2 min |

  Rule: No acknowledged fact is ever lost

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
    Scenario: No acknowledged fact is lost on the loss of a region
      Given confirmed reservations, money movements, payment events and accepted usage records have been acknowledged
      When a whole region fails and service is recovered elsewhere
      Then every acknowledged fact is present and unchanged

    @X2-S14 @need-X2-N4 @POL-06
    Scenario Outline: A fact is acknowledged only once it is durable in two regions
      When <fact> is recorded
      Then it is acknowledged to <party> only after it is durable in two regions

      Examples:
        | fact                       | party                       |
        | a confirmed reservation    | the buyer                   |
        | a payment notification     | the payment provider        |
        | a posted money movement    | the service that posted it  |
        | an accepted usage record   | its sender                  |

  Rule: Each capability recovers within its target

    @X2-S10 @need-X2-N5 @POL-06
    Scenario Outline: Recovery time per capability and failure scope
      When <capability> loses <scope>
      Then it answers correctly again within <target>

      Examples:
        | capability               | scope                        | target |
        | admission                | a node or zone               | 1 min  |
        | usage ingestion          | a node or zone               | 1 min  |
        | rating and posting       | a node or zone               | 5 min  |
        | the wallet               | a node or zone               | 5 min  |
        | payouts                  | a node or zone               | 15 min |
        | reporting and statements | a node or zone               | 30 min |
        | admission                | a region (declared disaster) | 1 h    |
        | usage ingestion          | a region (declared disaster) | 1 h    |
        | rating and posting       | a region (declared disaster) | 1 h    |
        | the wallet               | a region (declared disaster) | 1 h    |
        | payouts                  | a region (declared disaster) | 1 h    |
        | reporting and statements | a region (declared disaster) | 1 h    |

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
