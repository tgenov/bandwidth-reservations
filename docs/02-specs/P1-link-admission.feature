# Spec for P1: capacity admission on one link without overselling.
# Problem statement: docs/01-discovery/P1-link-admission.md
# Design: docs/03-rfcs/RFC-001-link-admission.md
#
# Times are minutes. "HH:MM" is an offset from the start of the horizon, so on a
# one-day horizon the bookable minutes are 00:00 up to (not including) 24:00.
# Every window is half-open: [start, end) includes start and excludes end.
#
# The system has two admission paths that must agree: an in-memory one and one backed
# by the database. Where a scenario is only verified on one of them, the comment says so.

Feature: Capacity admission on one link without overselling

  As a buyer of bandwidth
  I want a definite confirm or reject for a slice of a link's capacity over a time window
  So that I can rely on every confirmed reservation actually being deliverable

  As a supplier selling capacity through the marketplace
  I want every request that fits to be accepted, and my link never oversold
  So that I sell as much capacity as possible without breaking any promise

  Background:
    Given a link with capacity 10 Mbps
    And a bookable horizon of one day at minute resolution
    And no reservations on the link

  # --- The admission rule: peak concurrent usage ---------------------------------------

  @P1-S01 @verified
  # Verified by: test/tree.test.ts › "exact fit to capacity is admitted, one more Mbps is not"
  Scenario: A request that brings peak usage exactly to capacity is admitted; one more Mbps is not
    Given a reservation of 7 Mbps for [00:00, 01:00)
    When a buyer requests 3 Mbps for [00:30, 01:30)
    Then the request is admitted
    When a buyer requests 1 Mbps for [00:59, 01:01)
    Then the request is rejected

  @P1-S02 @verified
  # Verified by: test/tree.test.ts › "A/B: summing overlaps would reject, the peak admits"
  # Verified by: test/sql.test.ts › "SQL: touching intervals and the A/B example"
  Scenario: Admission uses the peak at any instant, not the sum of every overlapping reservation
    Given a reservation A of 8 Mbps for [14:00, 14:30)
    And a reservation B of 8 Mbps for [15:00, 16:00)
    When a buyer requests 2 Mbps for [14:00, 16:00)
    Then the request is admitted
    And the usage at 14:45 is 2 Mbps

  @P1-S03 @verified
  # Verified by: test/tree.test.ts › "exact fit to capacity is admitted, one more Mbps is not"
  Scenario: Partial reservations may overlap; a request needs room, not a free gap
    Given a reservation of 7 Mbps for [00:00, 01:00)
    When a buyer requests 3 Mbps for [00:30, 01:30)
    Then the request is admitted
    And the usage at 00:45 is 10 Mbps

  @P1-S04 @verified
  # Verified by: test/tree.test.ts › "touching intervals [a, b) and [b, c) do not overlap"
  # Verified by: test/sql.test.ts › "SQL: touching intervals and the A/B example"
  Scenario: Back-to-back bookings each get the whole link
    Given a reservation of 10 Mbps for [10:00, 11:00)
    When a buyer requests 10 Mbps for [11:00, 12:00)
    Then the request is admitted
    And the usage at 10:59 is 10 Mbps
    And the usage at 11:00 is 10 Mbps
    And the usage at 12:00 is 0 Mbps

  @P1-S05 @verified
  # Verified by: test/sql.test.ts › "property: tree, SQL and brute-force array agree on every decision"
  Scenario: Every decision matches a minute-by-minute check
    Given a link with capacity 50 Mbps and a horizon of 240 minutes
    When 150 random requests are made, of 1 to 20 Mbps, some of them open-ended
    Then each request is admitted exactly when every minute of its window has room for it
    And "room" means the usage already admitted plus the requested amount is at most 50 Mbps
    And this holds for every one of 8 different random sequences

  # --- Open-ended and long bookings -----------------------------------------------------

  @P1-S06 @verified
  # Verified by: test/tree.test.ts › "open-ended reservation blocks the rest of the horizon"
  # Verified by: test/sql.test.ts › "SQL: touching intervals and the A/B example"
  Scenario: An open-ended reservation holds capacity for the rest of the horizon
    Given a reservation of 6 Mbps starting at 20:00 with no end
    Then the usage at 23:59 is 6 Mbps
    When a buyer requests 5 Mbps for [23:00, 23:30)
    Then the request is rejected
    When a buyer requests 1 Mbps starting at 00:00 with no end
    Then the request is rejected

  @P1-S07 @verified
  # Verified by: test/tree.test.ts › "open-ended reservation blocks the rest of the horizon"
  Scenario: A booking that ends where an open-ended reservation starts gets the whole link
    Given a reservation of 6 Mbps starting at 20:00 with no end
    When a buyer requests 10 Mbps for [00:00, 20:00)
    Then the request is admitted

  @P1-S08 @verified
  # Verified by: test/tree.test.ts › "a year-long booking is two point updates"
  Scenario: Year-long bookings are checked as precisely as short ones
    Given a link with capacity 10 Mbps and a horizon of one year at minute resolution
    And a reservation of 4 Mbps for the whole year
    When a buyer requests 6 Mbps for one hour starting at the middle of the year
    Then the request is admitted
    When a buyer requests 1 Mbps for the whole year except its first and last 10 minutes
    Then the request is rejected
    And the peak usage over the year is 10 Mbps

  @P1-S09 @unverified
  # Not verified: test/concurrency.test.ts › "in-memory tree latency" and
  # "safe admission never oversells a hot link under 50 concurrent clients" measure and
  # print latencies, but neither asserts a bound.
  Scenario: Admission answers within the latency budget whatever the booking length
    Given a hot link receiving requests from 50 concurrent clients
    And requests whose windows last from one minute to a year
    When the requests are admitted or rejected
    Then the 99th percentile time to answer is at most 200 ms

  # --- Concurrency ----------------------------------------------------------------------

  @P1-S10 @verified
  # Verified by: test/concurrency.test.ts › "safe admission never oversells a hot link under 50 concurrent clients"
  # The negative control, test/concurrency.test.ts › "unsafe admission (no link lock) oversells",
  # shows the same load does oversell when admissions are not serialised per link.
  Scenario: Concurrent requests on a hot link never oversell it
    Given a link with capacity 100 Mbps
    When 50 clients concurrently send 20 requests each, of 5 to 30 Mbps
    And the request windows overlap heavily inside a two-hour span
    Then at least one request is admitted
    And the usage recorded on the link never exceeds 100 Mbps at any instant

  # --- Rejections -----------------------------------------------------------------------

  @P1-S11 @verified
  # Verified by: test/tree.test.ts › "exact fit to capacity is admitted, one more Mbps is not"
  # Verified by: test/sql.test.ts › "SQL: touching intervals and the A/B example"
  Scenario: A rejection reports the peak usage already reserved in the window
    Given a reservation A of 8 Mbps for [16:40, 17:10)
    And a reservation of 2 Mbps for [16:40, 18:40)
    When a buyer requests 1 Mbps for [16:50, 17:00)
    Then the request is rejected
    And the rejection reports a peak usage of 10 Mbps

  @P1-S12 @verified
  # Verified by: test/tree.test.ts › "rejection names every conflicting sub-range"
  # Verified by: test/tree.test.ts › "exact fit to capacity is admitted, one more Mbps is not"
  # In-memory path only. The database path reports the peak but not the sub-ranges.
  Scenario: A rejection names every sub-range of the window that is too full
    Given a reservation of 9 Mbps for [01:40, 01:50)
    And a reservation of 9 Mbps for [03:20, 03:25)
    When a buyer requests 2 Mbps for [00:50, 05:00)
    Then the request is rejected
    And the rejection reports a peak usage of 9 Mbps
    And the rejection names exactly the sub-ranges [01:40, 01:50) and [03:20, 03:25)

  # --- Malformed windows ----------------------------------------------------------------

  @P1-S13 @verified
  # Verified by: test/tree.test.ts › "requests outside the horizon are refused, not silently admitted"
  # In-memory path only. The database path has no horizon; it refuses only an end that is
  # not after the start.
  Scenario Outline: A window outside the horizon, empty or backwards is an error, not a rejection
    When a buyer requests 8 Mbps for a window starting at <start> and ending at <end>
    Then the request fails as an invalid window
    And it is neither admitted nor rejected
    And no capacity is reserved

    Examples:
      | start                  | end      | case                          |
      | 24:00                  | 24:10    | starts at the horizon's end   |
      | 24:05                  | no end   | open-ended, beyond horizon    |
      | 1 minute before 00:00  | 00:10    | starts before the horizon     |
      | 23:50                  | 24:10    | ends beyond the horizon       |
      | 00:10                  | 00:10    | empty window                  |
      | 00:20                  | 00:10    | backwards window              |

  @P1-S14 @verified
  # Verified by: test/tree.test.ts › "requests outside the horizon are refused, not silently admitted"
  Scenario Outline: Windows that reach the edge of the horizon are valid
    When a buyer requests <mbps> Mbps for a window starting at <start> and ending at <end>
    Then the request is admitted

    Examples:
      | start | end    | mbps | case                                   |
      | 23:50 | 24:00  | 8    | ends exactly at the horizon            |
      | 23:59 | no end | 2    | open-ended from the last bookable minute |

  # --- What is recorded -----------------------------------------------------------------

  @P1-S15 @verified
  # Verified by: test/sql.test.ts › "SQL: touching intervals and the A/B example"
  # (after three rejected requests, each of which would have pushed usage to 11 Mbps,
  # the peak usage computed from the recorded reservations is still 10 Mbps)
  # Also exercised by: test/sql.test.ts › "property: tree, SQL and brute-force array agree on every decision"
  Scenario: Only accepted reservations are recorded; a rejected request holds no capacity
    Given a reservation of 10 Mbps for [00:00, 01:00)
    When a buyer requests 1 Mbps for [00:59, 01:01)
    Then the request is rejected
    And the peak usage computed from the recorded reservations is still 10 Mbps
    And later decisions are made as if the rejected request had never been made

  # --- Cancellation ---------------------------------------------------------------------

  @P1-S16 @unverified
  # Not verified: cancellation is not implemented, and no test exercises it.
  Scenario: Cancelling a reservation releases its capacity from then on
    Given a reservation R of 6 Mbps starting at 20:00 with no end
    When R is cancelled with effect from 22:00
    Then a buyer requesting 10 Mbps for [22:00, 23:00) is admitted
    And a buyer requesting 5 Mbps for [21:00, 22:00) is rejected
    And the record still shows that R was reserved from 20:00, and when it was cancelled
