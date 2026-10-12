# Spec for P1: selling capacity on one link without overselling.
# Problem statement: ../01-discovery/P1-link-admission.md
# Terms: glossary.md. Policies: policy-register.md.
#
# Tags: @P1-Snn is the scenario's stable ID; @need-P1-Nn is the need it serves (one or
# more); @POL-nn is a policy it depends on. Conformance (design, tests, status) is kept in
# conformance.md, never here.
#
# Every link in this file is a Share link: its schedule is kept by Share. Partner links
# are P2. Times are HH:MM in UTC on one day; windows are half-open, [start, end). "now" is
# the current minute boundary and "H" is the end of the selling horizon
# (now + selling_horizon). Rates and windows in the examples are illustrations; a value
# that is a policy parameter is the POL default.

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
      And it is 09:00
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
      Given a confirmed reservation of 5 Mbps on the link for [09:00, 20:00)
      When a buyer books 5 Mbps on the link for [10:00, 11:00)
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

    @P1-S05 @need-P1-N1 @need-P1-N2 @POL-05
    Scenario: A booking is confirmed only if the link has room for it, beside every hold, when it is confirmed
      Given any schedule of confirmed reservations and capacity holds on the link
      When any booking on the link is confirmed
      Then at the moment it was confirmed, at every minute of its window, the committed rate plus the capacity held for other requests plus its rate was at most the link's capacity

    @P1-S37 @need-P1-N2 @POL-05
    Scenario: A booking is rejected for no fit only if it does not fit beside what is committed
      Given any schedule of confirmed reservations and capacity holds on the link
      When any booking on the link is rejected for no fit
      Then at the moment it was rejected, at some minute of its window, the committed rate plus its rate exceeded the link's capacity

    @P1-S06 @need-P1-N2 @need-P1-N6 @POL-09
    Scenario: A year-long booking is checked at every minute of its window
      Given a confirmed reservation of 4 Mbps on the link for the next 12 months
      And a confirmed reservation of 6 Mbps on the link for one hour in the sixth month
      When a buyer books 1 Mbps on the link for the next 12 months except their first and last 10 minutes
      Then the booking is rejected

  Rule: Capacity held for a pending request counts against the link

    Background:
      Given a link with a capacity of 10 Mbps
      And it is 09:00
      And the link has no reservations
      And a pending booking request holds 6 Mbps on the link for [10:00, 11:00), with 20 s of its deadline left

    @P1-S07 @need-P1-N1 @need-P1-N3 @POL-05
    Scenario: Capacity held for a pending request is not sold to anyone else; the next booking waits
      When another buyer books 5 Mbps on the link for [10:00, 11:00), with `wait` at its default
      Then that booking is neither confirmed nor rejected while the pending request holds its capacity
      And it waits, pending, within its own deadline (POL-05)

    @P1-S08 @need-P1-N3 @need-P1-N7 @POL-05 @POL-26 @POL-04
    Scenario Outline: Capacity held for a request that ends without confirmation is free again at once
      Given the pending request ends <outcome>, its decision record being available when it ends (POL-26), and the outcome is reported (POL-04)
      When another buyer books 10 Mbps on the link for [10:00, 11:00)
      Then that booking is confirmed at once, without waiting

      Examples:
        | outcome  |
        | rejected |
        | failed   |

    @P1-S09 @need-P1-N3 @POL-05
    Scenario: Confirming a pending request does not count its capacity twice
      Given the pending request is confirmed
      When another buyer books 4 Mbps on the link for [10:00, 11:00)
      Then that booking is confirmed

  Rule: Every booking on a link is decided against the same schedule

    Background:
      Given a link with a capacity of 10 Mbps
      And it is 09:00
      And the link has no reservations

    @P1-S10 @need-P1-N3 @POL-05
    Scenario: A single-link booking is decided against capacity confirmed for routes
      Given a route reservation with a leg on the link is confirmed at 6 Mbps for [10:00, 11:00)
      When a buyer books 5 Mbps on the link alone for [10:00, 11:00)
      Then the booking is rejected

    @P1-S11 @need-P1-N3 @POL-05 @POL-26
    Scenario: A single-link booking blocked only by capacity in flight waits, and is confirmed if that capacity is released within its deadline
      Given a route request in flight holds 6 Mbps on the link for [10:00, 11:00)
      And a single-link booking of 5 Mbps on the link for [10:00, 11:00) is waiting for it
      When the route request ends without confirmation before the single-link booking's deadline (POL-26)
      Then the single-link booking is confirmed

    @P1-S12 @need-P1-N3 @need-P1-N4 @POL-05 @POL-10
    Scenario: A single-link booking that asks not to wait is rejected at once with retry_after
      Given a route request in flight holds 6 Mbps on the link for [10:00, 11:00), with 20 s of its deadline left
      When a buyer books 5 Mbps on the link alone for [10:00, 11:00) with `wait = false` (POL-05)
      Then the booking is rejected at once with a `retry_after` of the route request's remaining deadline
      And with the counter-offer of POL-10 computed beside the capacity in flight: 4 Mbps is the largest rate that fits [10:00, 11:00), and [11:00, 12:00) is the earliest one-hour window at or after 10:00 that fits 5 Mbps

    @P1-S34 @need-P1-N3 @POL-05 @POL-04
    Scenario: A single-link booking still waiting after ack_budget is answered pending
      Given a route request in flight holds 6 Mbps on the link for [10:00, 11:00), with 20 s of its deadline left
      When a buyer books 5 Mbps on the link alone for [10:00, 11:00), with `wait` at its default
      Then the response to the single-link booking within `ack_budget` (POL-04) is pending

  Rule: Concurrent bookings are decided as if one at a time

    @P1-S13 @need-P1-N1
    Scenario: Concurrent bookings never oversell the link
      Given any number of buyers booking the same link at the same time
      When every booking has its outcome
      Then no booking was confirmed that, at the moment it was confirmed, left the committed rate plus the capacity held above the link's capacity then in force, at any minute of its window

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
      And apart from what a scenario adds, the link has no other reservations or capacity held

    @P1-S15 @need-P1-N4 @POL-10
    Scenario: A rejection states the largest rate that fits the requested window
      When a buyer books 5 Mbps on the link for [10:00, 11:00)
      Then the booking is rejected stating that 2 Mbps is the largest rate that fits [10:00, 11:00)

    @P1-S16 @need-P1-N4 @POL-10 @POL-09
    Scenario: A rejection states the earliest window of the requested length that fits the requested rate
      When a buyer books 5 Mbps on the link for [10:00, 11:00)
      Then the booking is rejected stating that [12:00, 13:00) is the earliest one-hour window within the selling horizon that fits 5 Mbps

    @P1-S17 @need-P1-N4 @POL-10
    Scenario: A rejection discloses nothing about other buyers
      When a buyer books 5 Mbps on the link for [10:00, 11:00)
      Then the rejection identifies no other account, no other reservation and no traffic

    @P1-S38 @need-P1-N4 @POL-10 @POL-09
    Scenario: When nothing fits, the rejection says so
      Given a confirmed open-ended reservation of 2 Mbps on the link from 10:00
      When a buyer books 9 Mbps on the link for [10:00, 11:00)
      Then the booking is rejected stating that 0 Mbps is the largest rate that fits [10:00, 11:00)
      And stating that no one-hour window within the selling horizon fits 9 Mbps

  Rule: Only confirmed reservations hold capacity once a request has its outcome

    Background:
      Given a link with a capacity of 10 Mbps
      And it is 09:00
      And the link has no reservations

    @P1-S18 @need-P1-N7 @POL-15 @POL-26
    Scenario Outline: A request that was not confirmed leaves the link as if it had never been made
      Given a booking request for 4 Mbps on the link for [10:00, 11:00) ended <outcome>, its decision record being available when it ended (POL-26)
      When a buyer books 10 Mbps on the link for [10:00, 11:00)
      Then the booking is confirmed at once

      Examples:
        | outcome                           |
        | rejected for insufficient funds   |
        | failed                            |
        | invalid                           |

    @P1-S54 @need-P1-N7 @need-P1-N3 @POL-26
    Scenario: A request failed at its deadline while its decision record is unavailable frees its capacity on the link within release_grace
      Given a pending booking request holds 4 Mbps on the link for [10:00, 11:00)
      And its decision record becomes unavailable before its deadline and stays unavailable until after it
      When its deadline arrives
      Then the request has failed as of its deadline (POL-26), and it is never confirmed
      And from `release_grace` (POL-26: 1 min) after its deadline at the latest, a buyer's booking of 10 Mbps on the link for [10:00, 11:00) is confirmed at once

  Rule: A request must be well formed: its window within the selling horizon, its rate a whole number of Mbps

    Background:
      Given a link with a capacity of 10 Mbps
      And the link has no reservations
      And a selling horizon of `selling_horizon` (POL-09), ending at H

    @P1-S19 @need-P1-N5 @POL-09 @POL-31
    Scenario Outline: A malformed request is invalid, not a capacity answer
      When a buyer books <rate> Mbps on the link for a window from <start> to <end>
      Then the request is invalid, neither confirmed nor rejected, and holds no capacity

      Examples:
        | rate | start          | end              | case                                      |
        | 8    | now + 1 h      | now + 1 h        | empty                                     |
        | 8    | now + 2 h      | now + 1 h        | backwards                                 |
        | 8    | now - 1 min    | now + 1 h        | starts before the current minute          |
        | 8    | now + 1 h 30 s | now + 2 h        | starts off a minute boundary              |
        | 8    | now + 1 h      | now + 2 h 30 s   | ends off a minute boundary                |
        | 8    | H              | H + 1 h          | starts at the end of the selling horizon  |
        | 8    | H - 10 min     | H + 10 min       | ends beyond the selling horizon           |
        | 8    | H + 5 min      | open             | open-ended, starting beyond the horizon   |
        | 0    | now + 1 h      | now + 2 h        | a rate below `rate_min` (POL-31)          |
        | -1   | now + 1 h      | now + 2 h        | a negative rate                           |
        | 1.5  | now + 1 h      | now + 2 h        | a rate that is not a whole number of Mbps |

    @P1-S20 @need-P1-N5 @POL-09
    Scenario Outline: A window that reaches the edge of what is sold is valid
      When a buyer books <rate> Mbps on the link for a window from <start> to <end>
      Then the booking is confirmed

      Examples:
        | rate | start      | end       | case                                       |
        | 8    | now        | now + 1 h | starts in the current minute               |
        | 8    | H - 10 min | H         | ends exactly at the selling horizon        |
        | 2    | H - 1 min  | open      | open-ended from the last sellable minute   |

    @P1-S39 @need-P1-N5 @need-P1-N4 @POL-10 @POL-09
    Scenario: A rate above the link's capacity is rejected with a counter-offer, not invalid
      When a buyer books 11 Mbps on the link for [now + 1 h, now + 2 h)
      Then the booking is rejected stating that 10 Mbps is the largest rate that fits that window

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

    @P1-S23 @need-P1-N2 @need-P1-N6 @POL-09
    Scenario: A booking that ends where an open-ended reservation starts gets the whole link
      When a buyer books 10 Mbps on the link for [now, now + 1 h)
      Then the booking is confirmed

  Rule: An unplanned loss of capacity stops new sales at once but never revokes a reservation

    Background:
      Given a link with a capacity of 10 Mbps
      And it is 09:00
      And confirmed reservations A and B, each of 4 Mbps on the link for [09:00, 12:00)

    @P1-S24 @need-P1-N8 @need-P1-N1 @POL-07
    Scenario: New bookings are decided against the reduced capacity at once
      When an unplanned outage reduces the link's capacity to 6 Mbps
      Then a booking of 1 Mbps on the link for [10:00, 11:00) is rejected

    @P1-S25 @need-P1-N8 @POL-07
    Scenario: Every reservation is affected at the minutes where the committed rate exceeds the reduced capacity, and stays confirmed
      When an unplanned outage reduces the link's capacity to 6 Mbps
      Then A and B are still confirmed
      And A and B are both flagged as affected (POL-07) at every minute of their windows from the outage until its restoration, none of them chosen before the other

    @P1-S26 @need-P1-N8 @POL-07
    Scenario: The holders of affected reservations and network operations are told within affected_notice_time
      When an unplanned outage reduces the link's capacity to 6 Mbps
      Then within `affected_notice_time` (POL-07) of the reduction being recorded, the holders of A and B and network operations are told which reservations are affected and from when

    @P1-S27 @need-P1-N8 @POL-07
    Scenario: Restored capacity is sellable again
      Given an unplanned outage has reduced the link's capacity to 6 Mbps
      When the link's capacity is restored to 10 Mbps
      Then a booking of 2 Mbps on the link for [10:00, 11:00) is confirmed

    @P1-S40 @need-P1-N8 @POL-07
    Scenario: When capacity is restored, the affected flag ends and the holders are told
      Given an unplanned outage has reduced the link's capacity to 6 Mbps, and A and B are flagged as affected
      When the link's capacity is restored to 10 Mbps
      Then A and B are no longer affected from the minute of the restoration
      And within `affected_notice_time` (POL-07) their holders and network operations are told

    @P1-S48 @need-P1-N8 @POL-07
    Scenario: An outage that leaves capacity at or above what is committed affects no reservation
      When an unplanned outage reduces the link's capacity to 9 Mbps
      Then neither A nor B is flagged as affected
      And no holder is told of an affected reservation

    @P1-S49 @need-P1-N8 @need-P1-N1 @POL-07 @POL-10
    Scenario: While an outage lasts, bookings far ahead are decided against the reduced capacity too
      Given an unplanned outage has reduced the link's capacity to 6 Mbps and has not been restored
      When a buyer books 7 Mbps on the link for [10:00, 11:00) on a day one month ahead, when nothing is reserved on it
      Then the booking is rejected, stating that 6 Mbps is the largest rate that fits that window

    @P1-S50 @need-P1-N8 @POL-07
    Scenario: A reservation that starts during an outage is flagged at the minutes it is affected, and its holder is told when it starts
      Given a confirmed reservation C of 2 Mbps on the link for [10:00, 13:00)
      When an unplanned outage reduces the link's capacity to 6 Mbps at 09:00, and is not restored before 13:00
      Then C is flagged as affected for [10:00, 12:00), where 10 Mbps are committed, and not for [12:00, 13:00), where 2 Mbps are
      And C's holder is told within `affected_notice_time` (POL-07) of 10:00, the start of C, while the holders of A and B are told within `affected_notice_time` of the outage being recorded

    @P1-S41 @need-P1-N8 @need-P1-N1 @POL-07 @POL-05 @POL-10
    Scenario: A pending request that no longer fits the reduced capacity is rejected, not confirmed
      Given a pending booking request holds 2 Mbps on the link for [10:00, 11:00)
      When an unplanned outage reduces the link's capacity to 6 Mbps
      Then the pending request is rejected for no fit, with the counter-offer of POL-10
      And it holds no capacity on the link

    @P1-S42 @need-P1-N8 @need-P1-N1 @POL-07 @POL-05
    Scenario: A waiting request is decided against the reduced capacity
      Given a pending booking request holds 2 Mbps on the link for [10:00, 11:00)
      And a booking of 1 Mbps on the link for [10:00, 11:00) is waiting for it
      When an unplanned outage reduces the link's capacity to 6 Mbps
      Then the waiting booking is rejected for no fit, and is never confirmed into capacity the link no longer has

  Rule: Planned maintenance is booked ahead by the link's supplier, on free capacity only

    Background:
      Given a link with a capacity of 10 Mbps
      And a confirmed reservation of 8 Mbps on the link for [10:00, 12:00) on day D
      And day D is at least `maintenance_notice` (POL-07: 14 calendar days) ahead

    @P1-S28 @need-P1-N8 @POL-07
    Scenario: Maintenance that fits on free capacity is booked
      When the link's supplier books planned maintenance taking 2 Mbps for [10:00, 12:00) on day D
      Then the maintenance booking is confirmed

    @P1-S29 @need-P1-N8 @POL-07
    Scenario: Maintenance that needs committed capacity is rejected
      When the link's supplier books planned maintenance taking 4 Mbps for [10:00, 12:00) on day D
      Then the maintenance booking is rejected, stating that the supplier may wait for capacity to become free, or announce a permanent reduction with `revocation_notice` (POL-07)

    @P1-S30 @need-P1-N8 @POL-07
    Scenario: Maintenance booked with less than the required notice is rejected
      When the link's supplier books planned maintenance taking 2 Mbps for [10:00, 12:00) on a day 13 calendar days ahead
      Then the maintenance booking is rejected, stating the notice required, `maintenance_notice` (POL-07)

    @P1-S51 @need-P1-N8 @POL-07
    Scenario: Works carried out on sold capacity anyway are an unplanned outage attributed to the supplier
      Given the supplier's maintenance booking taking 4 Mbps for [10:00, 12:00) on day D was rejected
      When at 10:00 on day D the supplier's works reduce the link's capacity to 6 Mbps
      Then the reduction is recorded as an unplanned outage on the link, attributed to the supplier for SLA purposes (Problem 6)
      And the reservation of 8 Mbps stays confirmed and is flagged as affected

  Rule: A permanent reduction keeps the capacity for the notice, then moves, reduces or revokes only what no longer fits, newest first

    Background:
      Given a link with a capacity of 10 Mbps
      And it is 09:00 on day D
      And a confirmed open-ended reservation A of 4 Mbps on the link
      And a confirmed open-ended reservation B of 4 Mbps on the link, confirmed after A

    @P1-S31 @need-P1-N8 @POL-07
    Scenario: Only the buyer who would otherwise not fit is offered an equivalent path, on the terms of POL-07
      Given an equivalent path exists for B
      When the link's supplier announces a permanent reduction of its capacity to 4 Mbps
      Then the holder of B is offered the equivalent path: the same endpoints and rate, latency and SLA class no worse, at the lower of B's original price and the path's price
      And the offer is open for `offer_window` (POL-07)
      And the holder of A is offered nothing, because A fits the reduced capacity

    @P1-S35 @need-P1-N8 @POL-07
    Scenario: An accepted offer moves the reservation to the equivalent path, at the lower of its original price and the path's price, when the notice ends
      Given the holder of B has been offered an equivalent path after a permanent reduction to 4 Mbps announced on day D
      When the holder accepts the offer
      Then from the end of `revocation_notice` (POL-07) after the announcement, B continues on the equivalent path at the lower of its original price and the path's price
      And A stays confirmed on the link
      And no reservation on the link is revoked

    @P1-S36 @need-P1-N8 @POL-07
    Scenario: A declined offer means revocation when the notice ends
      Given the holder of B has been offered an equivalent path after a permanent reduction to 4 Mbps announced on day D
      When the holder declines the offer
      Then B is revoked when `revocation_notice` (POL-07) after the announcement has passed, and not before
      And A stays confirmed

    @P1-S45 @need-P1-N8 @POL-07
    Scenario: An offer not answered within offer_window counts as declined
      Given the holder of B has been offered an equivalent path after a permanent reduction to 4 Mbps announced on day D
      When `offer_window` (POL-07) passes without an answer
      Then the offer has lapsed as declined
      And B is revoked when `revocation_notice` after the announcement has passed

    @P1-S32 @need-P1-N8 @POL-07
    Scenario: Without an equivalent path, the newest reservation is revoked when the notice ends
      Given no equivalent path exists for A or B
      When the link's supplier announces a permanent reduction of its capacity to 4 Mbps
      Then B is revoked when `revocation_notice` (POL-07) after the announcement has passed
      And A stays confirmed
      And the holder of B is told when the revocation takes effect

    @P1-S43 @need-P1-N8 @need-P1-N1 @POL-07
    Scenario: During the notice, new sales are decided against the reduced capacity
      Given the link's supplier announced a permanent reduction of its capacity to 4 Mbps on day D
      When a buyer books 1 Mbps on the link for [10:00, 11:00) on day D + 1
      Then the booking is rejected, although the link still carries 10 Mbps until the notice ends

    @P1-S44 @need-P1-N8 @POL-07
    Scenario: A reservation to be revoked keeps its capacity until the notice ends
      Given the link's supplier announced a permanent reduction of its capacity to 4 Mbps on day D, and no equivalent path exists for B
      When less than `revocation_notice` (POL-07) has passed since the announcement
      Then B is still confirmed at 4 Mbps on the link, with its capacity

    @P1-S46 @need-P1-N8 @POL-07 @POL-08
    Scenario: Each added part of a reservation has its own age
      Given A was increased by 2 Mbps after B was confirmed
      And no equivalent path exists for A or B
      When the link's supplier announces a permanent reduction of its capacity to 8 Mbps
      Then only the 2 Mbps added to A are affected, and B is not
      And when `revocation_notice` (POL-07) has passed, A is 4 Mbps and B is still 4 Mbps

    @P1-S47 @need-P1-N8 @POL-07 @POL-08
    Scenario: Only just enough Mbps are taken from the newest part, and its holder may then cancel without fee
      Given no equivalent path exists for A or B
      When the link's supplier announces a permanent reduction of its capacity to 6 Mbps
      Then only 2 Mbps of B are affected
      And when `revocation_notice` (POL-07) has passed, B is 2 Mbps and A is still 4 Mbps
      And the holder of B is told that it may cancel B without any cancellation fee

    @P1-S52 @need-P1-N8 @POL-07
    Scenario Outline: When part of a reservation is affected, the equivalent path is offered for all of it
      Given an equivalent path exists for B
      And the link's supplier announced a permanent reduction of its capacity to 6 Mbps, which affects only 2 Mbps of B
      When the holder of B <answer> the offer of the equivalent path for all 4 Mbps of B
      Then from the end of `revocation_notice` (POL-07) after the announcement, <result>
      And A stays confirmed at 4 Mbps on the link

      Examples:
        | answer   | result                                                                  |
        | accepts  | all 4 Mbps of B continue on the equivalent path, and B holds nothing on the link |
        | declines | B stays on the link at 2 Mbps, only the affected 2 Mbps being removed    |

    @P1-S53 @need-P1-N8 @POL-07
    Scenario: The holder of an accepted offer may move before the notice ends, from a minute boundary it chooses
      Given the holder of B accepted an equivalent path after a permanent reduction to 4 Mbps announced on day D
      When the holder asks to move from 10:00 on day D + 10, before `revocation_notice` (POL-07) has passed
      Then from 10:00 on day D + 10 B is on the equivalent path, at the lower of its original price and the path's price
      And from that minute B holds no capacity on the link

    @P1-S55 @need-P1-N8 @need-P1-N1 @POL-07
    Scenario: An equivalent-path offer is firm: the path's capacity is held for the reservation while the offer is open
      Given an equivalent path exists for B, every leg of it a Share link
      When the link's supplier announces a permanent reduction of its capacity to 4 Mbps
      Then the holder of B is offered the equivalent path for `offer_window` (POL-07)
      And from the offer until it is accepted, declined or lapses, 4 Mbps are held for B on every leg of the path, for the rest of B
      And no capacity on the path is sold to anyone else while it is held for B
      And the holder of B is not charged for the held capacity before B moves

    @P1-S56 @need-P1-N8 @need-P1-N2 @POL-07 @POL-10
    Scenario: Capacity held for an open equivalent-path offer counts as committed for new sales
      Given the holder of B has been offered an equivalent path after a permanent reduction to 4 Mbps announced on day D, and the offer is open
      And link M of that path has a capacity of 10 Mbps, with 6 Mbps confirmed for [10:00, 11:00) on day D + 1 besides the 4 Mbps held for B
      When a buyer books 1 Mbps on M for [10:00, 11:00) on day D + 1, with `wait` at its default
      Then the booking is rejected at once with a counter-offer (POL-10), and is not left waiting for the offer's answer

    @P1-S57 @need-P1-N8 @POL-07
    Scenario Outline: The capacity held for an equivalent-path offer becomes the reservation's on acceptance, and is released at once otherwise
      Given the holder of B has been offered an equivalent path, every leg of it a Share link, after a permanent reduction to 4 Mbps announced on day D, and 4 Mbps are held for B on every leg of the path
      When <answer>
      Then <result>

      Examples:
        | answer                                            | result                                                                                         |
        | the holder accepts the offer                      | the 4 Mbps on the path become B's capacity on the path, and are not released                    |
        | the holder declines the offer                     | the 4 Mbps held on the path are released at once, and can be sold to other buyers               |
        | `offer_window` (POL-07) passes without an answer  | the offer lapses as declined, and the 4 Mbps held on the path are released at once              |

    @P1-S58 @need-P1-N8 @POL-07
    Scenario: An equivalent path over Share links only is offered before one with a partner leg
      Given two equivalent paths exist for B: one whose every leg is a Share link, and one with a partner leg
      When the link's supplier announces a permanent reduction of its capacity to 4 Mbps
      Then the holder of B is offered the path whose every leg is a Share link (POL-07)
      And the path with a partner leg is not offered

    @P1-S59 @need-P1-N8 @POL-07
    Scenario: A path with a partner leg is offered only when no all-Share path exists, firm on its Share legs only
      Given the only equivalent path for B runs over Share link M and partner link P
      When the link's supplier announces a permanent reduction of its capacity to 4 Mbps
      Then the holder of B is offered that path for `offer_window` (POL-07), and told that the leg on P is confirmed only at acceptance
      And 4 Mbps are held for B on M while the offer is open
      And nothing is held or booked for B at P while the offer is open

    @P1-S60 @need-P1-N8 @POL-07
    Scenario: Accepting an offer with a partner leg books that leg, and the reservation moves when it is confirmed
      Given the holder of B has been offered the equivalent path over Share link M and partner link P after a permanent reduction to 4 Mbps announced on day D, and 4 Mbps are held for B on M
      When the holder accepts the offer, and the partner confirms the booking of 4 Mbps on P for B
      Then the 4 Mbps on M and the booking on P are B's capacity on the path
      And from the end of `revocation_notice` (POL-07) after the announcement, B continues on the path at the lower of its original price and the path's price

    @P1-S61 @need-P1-N8 @POL-07
    Scenario: If the partner leg cannot be booked at acceptance, the outcome is as for a declined offer, and any other path still available is offered
      Given the holder of B has been offered the equivalent path over Share link M and partner link P after a permanent reduction to 4 Mbps announced on day D, and 4 Mbps are held for B on M
      When the holder accepts the offer, and the booking of 4 Mbps on P for B fails
      Then the 4 Mbps held for B on M are released at once
      And B is revoked when `revocation_notice` (POL-07) after the announcement has passed, as for a declined offer, with no charge for the removed period
      And the holder of B is offered any other equivalent path for B still available, on the same terms

  Rule: What was known to be reserved at any past time can be retrieved

    @P1-S33 @need-P1-N9 @POL-19
    Scenario Outline: The schedule as known at a past time includes reservations changed since
      Given at 09:00 a reservation R of 6 Mbps on a link was confirmed for [10:00, 12:00)
      And at 09:30:20 R was cancelled, with effect from 09:31
      And it is now 13:00
      When operations asks for the link's schedule as known at <time>
      Then it shows <known>

      Examples:
        | time  | known                                        |
        | 08:45 | no reservation R                             |
        | 09:15 | R confirmed at 6 Mbps for [10:00, 12:00)     |
        | 09:45 | R cancelled with effect from 09:31           |
