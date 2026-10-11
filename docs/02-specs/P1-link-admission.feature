# Spec for P1: selling capacity on one link without overselling.
# Problem statement: ../01-discovery/P1-link-admission.md
# Terms: glossary.md. Policies: policy-register.md.
#
# Tags: @P1-Snn is the scenario's stable ID; @need-P1-Nn is the need it serves (one or
# more); @POL-nn is a policy it depends on. Conformance (design, tests, status) is kept in
# conformance.md, never here.
#
# Times are HH:MM in UTC on one day; windows are half-open, [start, end). "now" is the
# current minute boundary and "H" is the end of the selling horizon (now + selling_horizon).
# Rates and windows in the examples are illustrations; a value that is a policy parameter
# is the POL default.

Feature: Selling capacity on one link without overselling

  As a buyer of bandwidth
  I want a definite answer for a slice of a link's capacity over a window
  So that every reservation I am told is confirmed can actually be delivered

  As a supplier selling capacity through the marketplace
  I want every request that fits to be confirmed, and my link never oversold
  So that I sell as much of my capacity as possible without breaking a promise

  As Share operations
  I want to know which reservations a loss of capacity affects, and what was reserved at any past time
  So that I can act on every affected reservation and explain every decision

  Rule: A request fits if the link has room for it at every minute of its window

    Background:
      Given a link with a capacity of 10 Mbps
      And the link has no reservations

    @P1-S01 @need-P1-N2
    Scenario Outline: A booking is confirmed exactly when the peak leaves room for it
      Given a confirmed reservation of 7 Mbps on the link for [10:00, 11:00)
      When a buyer books <rate> Mbps on the link for [<start>, <end>)
      Then the booking is <outcome>

      Examples:
        | rate | start | end   | outcome   | case                                 |
        | 3    | 10:30 | 11:30 | confirmed | brings the peak exactly to capacity  |
        | 4    | 10:30 | 11:30 | rejected  | one Mbps more than the room left     |

    @P1-S02 @need-P1-N2
    Scenario: Reservations that never coexist do not add up
      Given a confirmed reservation of 8 Mbps on the link for [14:00, 14:30)
      And a confirmed reservation of 8 Mbps on the link for [15:00, 16:00)
      When a buyer books 2 Mbps on the link for [14:00, 16:00)
      Then the booking is confirmed

    @P1-S03 @need-P1-N2
    Scenario: A booking needs room, not a completely free gap
      Given a confirmed reservation of 5 Mbps on the link for [08:00, 20:00)
      When a buyer books 5 Mbps on the link for [09:00, 10:00)
      Then the booking is confirmed

    @P1-S04 @need-P1-N2
    Scenario Outline: Back-to-back bookings each get the whole link
      Given a confirmed reservation of 10 Mbps on the link for [10:00, 11:00)
      When a buyer books 10 Mbps on the link for [<start>, <end>)
      Then the booking is confirmed

      Examples:
        | start | end   | case                                    |
        | 11:00 | 12:00 | starts where the reservation ends       |
        | 09:00 | 10:00 | ends where the reservation starts       |

    @P1-S05 @need-P1-N2
    Scenario: Every decision agrees with a minute-by-minute check of the schedule
      Given any schedule of confirmed reservations and capacity holds on the link
      When a buyer books any rate for any valid window
      Then the booking is confirmed if and only if, at every minute of the window, the committed rate plus the capacity held plus the requested rate is at most the link's capacity

    @P1-S06 @need-P1-N2 @need-P1-N6
    Scenario: A year-long booking is checked at every minute of its window
      Given a confirmed reservation of 4 Mbps on the link for the next 12 months
      And a confirmed reservation of 6 Mbps on the link for one hour in the sixth month
      When a buyer books 1 Mbps on the link for the next 12 months except their first and last 10 minutes
      Then the booking is rejected

  Rule: Capacity held for a pending request counts against the link

    Background:
      Given a link with a capacity of 10 Mbps
      And the link has no reservations
      And a pending booking request holds 6 Mbps on the link for [10:00, 11:00)

    @P1-S07 @need-P1-N1 @need-P1-N3
    Scenario: Capacity held for a pending request is not sold to anyone else
      When another buyer books 5 Mbps on the link for [10:00, 11:00)
      Then that booking is not confirmed while the pending request still holds its capacity

    @P1-S08 @need-P1-N3 @need-P1-N7
    Scenario Outline: Capacity held for a request that ends without confirmation is available again
      Given the pending request ends <outcome>
      When another buyer books 10 Mbps on the link for [10:00, 11:00)
      Then that booking is confirmed

      Examples:
        | outcome  |
        | rejected |
        | failed   |

    @P1-S09 @need-P1-N3
    Scenario: Confirming a pending request does not count its capacity twice
      Given the pending request is confirmed
      When another buyer books 4 Mbps on the link for [10:00, 11:00)
      Then that booking is confirmed

  Rule: Every booking on a link is decided against the same schedule

    Background:
      Given a link with a capacity of 10 Mbps
      And the link has no reservations

    @P1-S10 @need-P1-N3 @POL-05
    Scenario: A single-link booking is decided against capacity confirmed for routes
      Given a route reservation with a leg on the link is confirmed at 6 Mbps for [10:00, 11:00)
      When a buyer books 5 Mbps on the link alone for [10:00, 11:00)
      Then the booking is rejected

    @P1-S11 @need-P1-N3 @POL-05 @POL-26
    Scenario: A single-link booking blocked only by capacity in flight waits, and is confirmed if that capacity is released within its deadline
      Given a route request in flight holds 6 Mbps on the link for [10:00, 11:00)
      And a buyer books 5 Mbps on the link alone for [10:00, 11:00)
      When the route request ends without confirmation before the single-link booking's deadline (POL-26)
      Then the single-link booking is confirmed

    @P1-S12 @need-P1-N3 @need-P1-N4 @POL-05 @POL-10
    Scenario: A single-link booking that asks not to wait is rejected at once with retry_after
      Given a route request in flight holds 6 Mbps on the link for [10:00, 11:00), with 20 s of its deadline left
      When a buyer books 5 Mbps on the link alone for [10:00, 11:00) with `wait = false` (POL-05)
      Then the booking is rejected at once with a `retry_after` of the route request's remaining deadline

    @P1-S34 @need-P1-N3 @POL-05 @POL-04
    Scenario: A single-link booking still waiting after ack_budget is answered pending
      Given a route request in flight holds 6 Mbps on the link for [10:00, 11:00)
      When a buyer books 5 Mbps on the link alone for [10:00, 11:00) and the route request is still in flight after `ack_budget` (POL-04)
      Then the response to the single-link booking is pending

  Rule: Concurrent bookings are decided as if one at a time

    @P1-S13 @need-P1-N1
    Scenario: Concurrent bookings never oversell the link
      Given any number of buyers booking the same link at the same time
      When every booking has its outcome
      Then at no moment did the committed rate plus the capacity held exceed the link's capacity at any minute

    @P1-S14 @need-P1-N2
    Scenario: Concurrent decisions are those of some one-at-a-time order
      Given any number of buyers booking the same link at the same time
      When every booking has its outcome
      Then there is an order of those bookings in which deciding them one at a time gives every one of them the same outcome

  Rule: A rejection tells the buyer what they can get instead, and nothing about anyone else

    Background:
      Given a link with a capacity of 10 Mbps
      And it is 10:00
      And a confirmed reservation of 8 Mbps on the link for [10:00, 12:00)

    @P1-S15 @need-P1-N4 @POL-10
    Scenario: A rejection states the largest rate that fits the requested window
      When a buyer books 5 Mbps on the link for [10:00, 11:00)
      Then the booking is rejected stating that 2 Mbps is the largest rate that fits [10:00, 11:00)

    @P1-S16 @need-P1-N4 @POL-10
    Scenario: A rejection states the earliest window of the requested length that fits the requested rate
      When a buyer books 5 Mbps on the link for [10:00, 11:00)
      Then the booking is rejected stating that [12:00, 13:00) is the earliest one-hour window within the selling horizon that fits 5 Mbps

    @P1-S17 @need-P1-N4 @POL-10
    Scenario: A rejection discloses nothing about other buyers
      When a buyer books 5 Mbps on the link for [10:00, 11:00)
      Then the rejection identifies no other account, no other reservation and no traffic

  Rule: Only confirmed reservations hold capacity once a request has its outcome

    Background:
      Given a link with a capacity of 10 Mbps
      And the link has no reservations

    @P1-S18 @need-P1-N7
    Scenario Outline: A request that was not confirmed leaves the link as if it had never been made
      Given a booking request for 4 Mbps on the link for [10:00, 11:00) ended <outcome>
      When a buyer books 10 Mbps on the link for [10:00, 11:00)
      Then the booking is confirmed

      Examples:
        | outcome                           |
        | rejected for insufficient funds   |
        | failed                            |
        | invalid                           |

  Rule: A window must be well formed and within the selling horizon

    Background:
      Given a link with a capacity of 10 Mbps
      And the link has no reservations
      And a selling horizon of `selling_horizon` (POL-09), ending at H

    @P1-S19 @need-P1-N5 @POL-09
    Scenario Outline: A malformed window is invalid, not a capacity answer
      When a buyer books 8 Mbps on the link for a window from <start> to <end>
      Then the request is invalid, neither confirmed nor rejected, and holds no capacity

      Examples:
        | start            | end              | case                                      |
        | now + 1 h        | now + 1 h        | empty                                     |
        | now + 2 h        | now + 1 h        | backwards                                 |
        | now - 1 min      | now + 1 h        | starts before the current minute          |
        | now + 1 h 30 s   | now + 2 h        | starts off a minute boundary              |
        | H                | H + 1 h          | starts at the end of the selling horizon  |
        | H - 10 min       | H + 10 min       | ends beyond the selling horizon           |
        | H + 5 min        | open             | open-ended, starting beyond the horizon   |

    @P1-S20 @need-P1-N5 @POL-09
    Scenario Outline: A window that reaches the edge of what is sold is valid
      When a buyer books <rate> Mbps on the link for a window from <start> to <end>
      Then the booking is confirmed

      Examples:
        | rate | start      | end       | case                                       |
        | 8    | now        | now + 1 h | starts in the current minute               |
        | 8    | H - 10 min | H         | ends exactly at the selling horizon        |
        | 2    | H - 1 min  | open      | open-ended from the last sellable minute   |

  Rule: An open-ended reservation is guaranteed as the selling horizon rolls forward

    Background:
      Given a link with a capacity of 10 Mbps
      And a selling horizon of `selling_horizon` (POL-09), ending at H
      And a confirmed open-ended reservation of 6 Mbps on the link from now + 1 h

    @P1-S21 @need-P1-N6 @POL-09
    Scenario: An open-ended reservation takes its rate at every minute up to the horizon
      When a buyer books 5 Mbps on the link for [H - 30 min, H)
      Then the booking is rejected

    @P1-S22 @need-P1-N6 @POL-09
    Scenario: Minutes that become sellable are taken by the open-ended reservation before any new sale
      Given the selling horizon has rolled forward by one day
      When a buyer books 5 Mbps on the link for the last hour of the new selling horizon
      Then the booking is rejected

    @P1-S23 @need-P1-N2 @need-P1-N6
    Scenario: A booking that ends where an open-ended reservation starts gets the whole link
      When a buyer books 10 Mbps on the link for [now, now + 1 h)
      Then the booking is confirmed

  Rule: An unplanned loss of capacity stops new sales but never revokes a reservation

    Background:
      Given a link with a capacity of 10 Mbps
      And it is 09:00
      And confirmed reservations A and B, each of 4 Mbps on the link for [10:00, 12:00)

    @P1-S24 @need-P1-N8 @POL-07
    Scenario: New bookings are decided against the reduced capacity at once
      When an unplanned outage reduces the link's capacity to 6 Mbps
      Then a booking of 1 Mbps on the link for [10:00, 11:00) is rejected

    @P1-S25 @need-P1-N8 @POL-07
    Scenario: Reservations that no longer fit stay confirmed and are flagged as affected
      When an unplanned outage reduces the link's capacity to 6 Mbps
      Then A and B are still confirmed
      And A and B are flagged as affected reservations

    @P1-S26 @need-P1-N8 @POL-07
    Scenario: The holders of affected reservations and network operations are told
      When an unplanned outage reduces the link's capacity to 6 Mbps
      Then the holders of A and B and network operations are told which reservations are affected and from when

    @P1-S27 @need-P1-N8 @POL-07
    Scenario: Restored capacity is sellable again
      Given an unplanned outage has reduced the link's capacity to 6 Mbps
      When the link's capacity is restored to 10 Mbps
      Then a booking of 2 Mbps on the link for [10:00, 11:00) is confirmed

  Rule: Planned maintenance is booked ahead, on free capacity only

    Background:
      Given a link with a capacity of 10 Mbps
      And a confirmed reservation of 8 Mbps on the link for [10:00, 12:00) on day D
      And day D is at least `maintenance_notice` (POL-07) ahead

    @P1-S28 @need-P1-N8 @POL-07
    Scenario: Maintenance that fits on free capacity is booked
      When the link's supplier books planned maintenance taking 2 Mbps for [10:00, 12:00) on day D
      Then the maintenance booking is confirmed

    @P1-S29 @need-P1-N8 @POL-07
    Scenario: Maintenance that needs committed capacity is rejected
      When the link's supplier books planned maintenance taking 4 Mbps for [10:00, 12:00) on day D
      Then the maintenance booking is rejected

    @P1-S30 @need-P1-N8 @POL-07
    Scenario: Maintenance booked with less than the required notice is rejected
      When the link's supplier books planned maintenance taking 2 Mbps for a day less than `maintenance_notice` (POL-07) ahead
      Then the maintenance booking is rejected, stating the notice required

  Rule: A permanent reduction offers an equivalent path, or revokes the newest first, with notice

    Background:
      Given a link with a capacity of 10 Mbps
      And a confirmed open-ended reservation A of 4 Mbps on the link
      And a confirmed open-ended reservation B of 4 Mbps on the link, confirmed after A

    @P1-S31 @need-P1-N8 @POL-07
    Scenario: An affected buyer is offered an equivalent path on the terms of POL-07
      Given an equivalent path exists for B
      When the link's supplier permanently reduces its capacity to 6 Mbps
      Then the holder of B is offered the equivalent path: the same endpoints and rate, latency and SLA class no worse, at B's original price

    @P1-S35 @need-P1-N8 @POL-07
    Scenario: An accepted offer moves the reservation to the equivalent path at its original price
      Given the holder of B has been offered an equivalent path after a permanent reduction
      When the holder accepts the offer
      Then B continues on the equivalent path at its original price
      And A stays confirmed on the link

    @P1-S36 @need-P1-N8 @POL-07
    Scenario: A declined offer is treated as no equivalent path
      Given the holder of B has been offered an equivalent path after a permanent reduction
      When the holder declines the offer
      Then B is revoked with effect no earlier than `revocation_notice` (POL-07) from the announcement

    @P1-S32 @need-P1-N8 @POL-07
    Scenario: Without an equivalent path, the newest reservations are revoked first, with notice
      Given no equivalent path exists for A or B
      When the link's supplier permanently reduces its capacity to 6 Mbps
      Then B is revoked with effect no earlier than `revocation_notice` (POL-07) from the announcement
      And A stays confirmed
      And the holder of B is told when the revocation takes effect

  Rule: What was known to be reserved at any past time can be retrieved

    @P1-S33 @need-P1-N9 @POL-19
    Scenario: The schedule as known at a past time includes reservations changed since
      Given at 09:00 a reservation R of 6 Mbps on a link was confirmed for [10:00, 12:00)
      And at 09:30 R was cancelled
      When operations asks for the link's schedule as known at 09:15
      Then it shows R confirmed at 6 Mbps for [10:00, 12:00)
