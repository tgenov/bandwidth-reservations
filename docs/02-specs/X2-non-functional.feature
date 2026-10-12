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
      When the availability of <capability> is measured in each serving region over a calendar month, as the share of available minutes (X2-N1)
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

    @X2-S30 @need-X2-N1 @POL-06
    Scenario Outline: A minute of admission or the wallet is unavailable when every probe one account slot got failed, however few, or when it was not probed as required
      Given <capability> in a serving region, every account slot of which is to be probed at least 3 times a minute from at least two locations (POL-06)
      When in one minute <what>
      Then the minute counts as <counted> for <capability>

      Examples:
        | capability        | what                                                                                                                         | counted     |
        | the admission API | 99% of its probes succeed, and account slot 17 had 3 probes, from two locations, none of which got a correct answer within `slot_probe_limit` (POL-06: 1 s) | unavailable |
        | the admission API | 99% of its probes succeed, and account slot 17 had 3 probes, from two locations, each answered correctly in 400 ms, slower than the 200 ms per-probe limit but within `slot_probe_limit` | available |
        | the wallet        | 99% of its probes succeed, and account slot 17 had 3 probes, from two locations, 2 of which failed                            | available   |
        | the admission API | 99% of its probes succeed, and account slot 17 had only 2 probes, both failing, so it is a failing slot-minute however few its probes | unavailable |
        | the admission API | 99% of its probes succeed, and account slot 17 had no probe at all, a probing fault, while every other slot was probed as required | available   |
        | the admission API | 11 probes are made, all from one location, and all succeed                                                                   | unavailable |

    @X2-S33 @need-X2-N1 @POL-06
    Scenario Outline: An account slot probed short in a minute is a probing fault, alerted to network operations
      Given admission in a serving region, every account slot of which is to be probed at least 3 times a minute from at least two locations (POL-06)
      When in one minute account slot 17 <probed>
      Then network operations is alerted to a probing fault for slot 17 in that minute
      And the shortfall alone does not make the minute unavailable

      Examples:
        | probed                                                   |
        | gets no probe at all                                     |
        | gets 2 probes, from two locations, both answered correctly |
        | gets 3 probes, all from one location, all answered correctly |

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
    Scenario Outline: Probes run end to end as designated probe accounts, without business side effects
      Given the designated Share probe accounts, with the designated probe links of the designated Share probe supplier and the designated probe exporters in the region (POL-06)
      When a probe <action>
      Then it is handled on the same path as any buyer's or exporter's
      And nothing it does is rated, settled, shown in a supplier report or reported as quarantined traffic

      Examples:
        | action                                                       |
        | books a single probe link, with its funds hold               |
        | sends a flow record from a probe exporter and it is accepted |
        | asks for the probe account's balance and headroom            |
        | asks for the status of a payout to the probe supplier        |

    @X2-S24 @need-X2-N1 @POL-06 @POL-15 @POL-32
    Scenario: Each probe account books on a credit limit set by finance, and is never invoiced
      Given a designated Share probe account has a `credit_limit` (POL-15) set by an operator in finance (POL-32)
      When a probe books a single probe link
      Then a real credit hold is taken for the booking against the probe account's `credit_limit`, as for any account
      And the probe account is never invoiced

    @X2-S27 @need-X2-N1 @POL-06
    Scenario: Enough probe accounts are designated that every account slot of admission and the wallet is probed
      Given the designated Share probe accounts (POL-06)
      When admission and the wallet are probed in a serving region over a minute
      Then every account slot of admission and of the wallet is asked by at least 3 probes, from at least two locations
      And no probe account is a buyer's account

    @X2-S21 @need-X2-N1 @need-X2-N5 @POL-06 @POL-15 @POL-18
    Scenario Outline: The funds holds and headroom checks bookings need are held to admission's targets, not the wallet's
      When the funds holds and headroom checks that bookings and changes need are measured for <measure>, in each serving region
      Then they meet admission's <target>, whatever the wallet's own <wallet>

      Examples:
        | measure                                              | target | wallet |
        | availability per calendar month (X2-S01)             | 99.99% | 99.9%  |
        | recovery time on the loss of a node or zone (X2-S10) | 1 min  | 5 min  |

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
      Then the timeliness targets of X2-S13 and X2-S22 are met throughout

  Rule: Each operation meets its latency target under the design load

    @X2-S05 @need-X2-N3 @POL-06 @POL-04
    Scenario Outline: A single-link booking is answered, final or pending, within ack_budget, whatever the booking's length
      Given the design load
      When buyers book single links for windows of <length>
      Then in each serving region, over each calendar month, the 99th percentile time to an answer, final or pending, is at most 200 ms

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
      Then in each serving region, over each calendar month, the 99th percentile time to a final answer is at most 200 ms

    @X2-S06 @need-X2-N3 @POL-06 @POL-04 @POL-26
    Scenario: A route booking is acknowledged within ack_budget and has its outcome by its deadline
      Given the design load
      When buyers book routes
      Then in each serving region, over each calendar month, the 99th percentile time to the first response is at most 200 ms
      And every request has its outcome by its deadline

    @X2-S07 @need-X2-N3 @POL-06 @POL-18
    Scenario: A top-up is credited within 10 s of the provider's notification
      Given payment notifications at their design peak of 1,000 per second
      When notifications for completed top-ups arrive
      Then in each serving region, over each calendar month, the 99th percentile time from notification to credited headroom is at most 10 s

    @X2-S22 @need-X2-N3 @POL-06 @POL-14 @POL-18
    Scenario: An accepted record is counted in headroom within attribution_lag_max of its acceptance
      Given the design load
      When usage-priced flow records are accepted by usage ingestion over a calendar month
      Then for at least 99.99% of the month's minutes, leaving out minutes affected by a declared region disaster, every record accepted in the minute is counted in its account's unposted usage, and so in its headroom, within `attribution_lag_max` (POL-14: 10 s) of its acceptance
      And every record counted later is reported as a breach of the usage exposure bound (POL-14)

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

    @X2-S23 @need-X2-N3 @need-X2-N4 @POL-06 @POL-26
    Scenario: During a declared region disaster the latency targets are suspended, and no acknowledged fact may be lost
      Given a region is lost, and the loss is declared a disaster
      When requests, notifications and records are handled for as long as the disaster lasts, from the loss the system recorded until its declared end
      Then they are left out of the measurement of every latency target (X2-S05, X2-S15, X2-S06, X2-S07, X2-S22, X2-S17 and X2-S08)
      And every request still has its outcome by its deadline (POL-26)
      And every fact is acknowledged only once it is durable in two regions, and no acknowledged fact is lost

    @X2-S25 @need-X2-N1 @need-X2-N3 @POL-06 @POL-32
    Scenario Outline: A region disaster, and its end, take effect only once declared with evidence and approved by a second operator
      Given a region is lost
      When <declaration>
      Then <result>

      Examples:
        | declaration                                                                                                   | result                                                                                  |
        | an operator in network operations declares a disaster with its evidence, and a second network operations operator approves it | the disaster is declared, recorded with both operators, the reason and the evidence (POL-32) |
        | an operator in network operations declares a disaster, and no second operator has approved it                 | no disaster is declared, and every minute still counts against every target              |
        | an operator in any other role declares a disaster                                                             | it is refused and recorded, and no disaster is declared                                  |

    @X2-S26 @need-X2-N1 @need-X2-N3 @POL-06
    Scenario: A declared region disaster counts from the loss the system recorded, not from its declaration
      Given the system recorded the loss of a region at 10:00
      And the disaster was declared and approved at 10:20, the declaration stating the loss as 09:40
      When the month's availability, latency and timeliness are measured
      Then the disaster's minutes start at 10:00, the loss the system recorded, until its declared end (POL-06)
      And the minutes from 09:40 to 10:00 count against every target as usual

    @X2-S28 @need-X2-N1 @POL-06
    Scenario: A region loss that is never declared a disaster counts against every target
      Given a region was lost from 10:00 to 10:20, and no disaster was declared
      When the month's availability, latency and timeliness are measured
      Then every minute from 10:00 to 10:20 counts against every target, in each serving region (POL-06)

    @X2-S29 @need-X2-N1 @need-X2-N3 @POL-06 @POL-32
    Scenario Outline: A region with no recorded loss may be declared a disaster on probe evidence, counted from the first failing probe minute
      Given the system recorded no loss of region "R1"
      And admission's probes in "R1" failed in every minute from the one starting 10:00 to the one starting <last>, each minute with at least 12 probes from at least two locations of which fewer than 90% succeeded
      When an operator in network operations declares a disaster for "R1" at 10:20, citing that probe evidence, and a second network operations operator approves it (POL-32)
      Then <result>

      Examples:
        | last  | result                                                                                                                                                  |
        | 10:04 | the disaster is declared, and its minutes start at 10:00, the first failing probe minute, until its declared end (POL-06)                                |
        | 10:03 | the declaration is refused, the probes having failed for fewer than `disaster_probe_minutes` (POL-06: 5) consecutive minutes, and every minute counts against every target |

    @X2-S31 @need-X2-N1 @need-X2-N3 @POL-06 @POL-32
    Scenario Outline: A declared disaster counts from the earlier of the recorded loss and a run of probe evidence leading up to it
      Given admission's probes in region "R1" failed in every minute from the one starting <first> to the one starting 10:05, each minute with at least 12 probes from at least two locations of which fewer than 90% succeeded
      And the system recorded the loss of "R1" at 10:06
      When the disaster is declared and approved at 10:20 (POL-32)
      Then the disaster's minutes start at <start>, until its declared end (POL-06)

      Examples:
        | first | start | case                                                                                 |
        | 10:00 | 10:00 | six measured failing minutes lead up to the loss, at least `disaster_probe_minutes` (POL-06: 5) |
        | 10:03 | 10:06 | three measured failing minutes are fewer than `disaster_probe_minutes`, so the recorded loss counts |

    @X2-S32 @need-X2-N1 @need-X2-N3 @POL-06 @POL-32
    Scenario Outline: A minute in which admission was not probed as required is unavailable, but is not probe evidence for a disaster
      Given the system recorded no loss of region "R1"
      And admission's probes in "R1" failed in every minute from the one starting 10:00 to the one starting 10:04, each with at least 12 probes from at least two locations of which fewer than 90% succeeded, except the minute starting 10:02, in which <probing>
      When an operator in network operations declares a disaster for "R1" at 10:20, citing that probe evidence, and a second network operations operator approves it (POL-32)
      Then <result>

      Examples:
        | probing                                                       | result                                                                                                                                                         |
        | 12 probes from two locations were made and 3 succeeded        | the disaster is declared, and its minutes start at 10:00 (POL-06)                                                                                               |
        | only 8 probes were made, none succeeding                      | the declaration is refused, the minute starting 10:02 not being evidence, and every minute counts against every target, that one as unavailable (POL-06)       |
        | 12 probes were made from one location only, none succeeding   | the declaration is refused, the minute starting 10:02 not being evidence, and every minute counts against every target, that one as unavailable (POL-06)       |

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
