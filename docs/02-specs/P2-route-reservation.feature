# P2. Reserving a route across several providers' links, all or nothing.
# Problem statement: docs/01-discovery/P2-route-reservation.md
# Design: docs/03-rfcs/RFC-002-route-reservation.md
#
# Terms used below:
#   route        - a list of links booked for the same window [start, end) at the same rate
#   hold         - capacity set aside for an unfinished route request; it counts against
#                  capacity and lapses after a time limit unless confirmed
#   commit point - the moment a route request decides to complete; recorded durably
#   partner link - a link managed in a partner's system, which cannot join our transactions,
#                  ignores our priorities and fails, times out or is slow at random
#   ticket       - a route request's priority, fixed when the request first starts
#
# Unless a scenario says otherwise, every link has a capacity of 10 Mbps and windows are
# in minutes on the link's booking horizon.

Feature: Reserve a route across several providers' links, all or nothing

  As a buyer of bandwidth
  I want to book capacity on every link of a route as one purchase
  So that I get the whole path or nothing, and am never billed for half a route

  Rule: A route is booked on every link or on none

    @P2-S01 @verified
    # Verified by: test/routes.test.ts › "a route across our links and the partner is confirmed; every leg becomes a fact"
    Scenario: Every leg fits, so the route is confirmed on all of them
      Given a route over the partner link and two of our links
      And every link has room for 4 Mbps over minutes [0, 600)
      When a buyer requests the route for 4 Mbps over minutes [0, 600)
      Then the route is confirmed
      And there is one stored reservation per link of the route
      And each link's confirmed usage over [0, 600) is 4 Mbps
      And no hold is left on any link

    @P2-S02 @verified
    # Verified by: test/routes.test.ts › "a leg that cannot fit rejects the route, names the link, and releases every hold"
    Scenario: One leg cannot fit, so the route is rejected and nothing is kept
      Given link 3 has a confirmed reservation of 8 Mbps over minutes [0, 600)
      When a buyer requests the partner link, link 2 and link 3 for 5 Mbps over minutes [300, 900)
      Then the route is rejected
      And the rejection names link 3 and the conflicting minutes [300, 600)
      And no hold is left on any link, including the partner link

    @P2-S03 @verified
    # Verified by: test/routes.test.ts › "routes outside the horizon are refused before any saga starts"
    # Also: test/links.test.ts › "holds outside the horizon are refused, not silently granted"
    Scenario Outline: A window outside the booking horizon is a caller error, not a rejection
      Given a booking horizon of N minutes
      When a buyer requests a route over minutes [<start>, <end>)
      Then the request is refused as invalid
      And no route request is recorded and no capacity is held

      Examples:
        | start  | end    |
        | N      | N + 60 |
        | N - 10 | N + 10 |

  Rule: Capacity set aside for an unfinished request counts against capacity

    @P2-S04 @verified
    # Verified by: test/links.test.ts › "hold counts against total, confirm moves it to confirmed, release after confirm is a no-op"
    Scenario: A hold counts against capacity, and confirming it does not change total usage
      Given a link with no reservations
      When a route request holds 4 Mbps over minutes [0, 60)
      Then total usage over [0, 60) is 4 Mbps and confirmed usage is 0
      When the hold is confirmed
      Then confirmed usage over [0, 60) is 4 Mbps and total usage is still 4 Mbps
      And a later release of the same hold does not free the confirmed capacity

    @P2-S05 @verified
    # Verified by: test/links.test.ts › "touching windows do not conflict: [0, 60) and [60, 120)"
    Scenario: Windows that touch do not conflict
      Given a hold of 10 Mbps over minutes [0, 60)
      When another request asks for 10 Mbps over minutes [60, 120)
      Then it is held

    @P2-S06 @verified
    # Verified by: test/links.test.ts › "tryHold and release are idempotent by key"
    Scenario: Holding or releasing twice with the same key has the effect of doing it once
      When a request holds 6 Mbps over minutes [0, 60) with key "a" twice
      Then total usage over [0, 60) is 6 Mbps
      When the hold with key "a" is released twice
      Then total usage over [0, 60) is 0 Mbps

    @P2-S07 @verified
    # Verified by: test/links.test.ts › "unpinned holds expire and wake waiters; pinned holds do not expire"
    Scenario: A hold lapses after its time limit unless the request has passed its commit point
      Given a hold of 10 Mbps over minutes [0, 60) with a time limit of 100 ms
      And a hold of 10 Mbps over minutes [60, 120) whose request has passed its commit point
      When 100 ms pass
      Then a new request for 10 Mbps over [0, 60) is held
      And a new request for 1 Mbps over [60, 120) still has to wait

  Rule: Every request on a link gets one of three outcomes: hold, reject or wait

    @P2-S08 @verified
    # Verified by: test/links.test.ts › "three outcomes: hold, wait (fits only if holds release), reject (misses on confirmed)"
    Scenario Outline: The outcome depends on confirmed capacity and on held capacity
      Given a link with 6 Mbps confirmed over minutes [0, 60)
      And an older request holding 3 Mbps over minutes [0, 60)
      When a younger request asks for <mbps> Mbps over minutes [<start>, <end>)
      Then the outcome is <outcome>

      Examples:
        | mbps | start | end | outcome                                                                  |
        | 1    | 0     | 60  | held                                                                     |
        | 3    | 30    | 90  | wait, blocked by the older request                                       |
        | 5    | 30    | 90  | reject, with peak confirmed usage 6 Mbps and conflicting minutes [30, 60) |

    @P2-S09 @unverified
    Scenario: A request that must wait gets a quick "pending" answer and its result later
      Given a route request that fits only if another request's holds are released
      When the buyer submits it
      Then the buyer is told "pending" within 200 ms
      And the request is re-checked automatically when the blocking holds resolve
      And the buyer learns the final result by webhook or by polling with the idempotency key

    @P2-S10 @unverified
    Scenario: A request still unfinished at its deadline fails and gives back what it held
      Given a route request that keeps waiting on other requests' holds
      When its deadline passes
      Then it fails with the reason "deadline"
      And every hold it took is released

  Rule: Waiting requests are re-checked as soon as the capacity they wait for may have changed

    @P2-S11 @verified
    # Verified by: test/links.test.ts › "unpinned holds expire and wake waiters; pinned holds do not expire"
    Scenario: A waiting request is woken when a blocking hold lapses
      Given a request waiting on a link
      When a hold on that link lapses
      Then the waiting request is woken to re-check

    @P2-S12 @unverified
    # Exercised indirectly by the randomised contention tests in test/routes.test.ts,
    # which require every request to finish; no test checks the wake-up directly.
    Scenario Outline: A waiting request is woken when a blocking hold is released, confirmed or revoked
      Given a request waiting on a link because of another request's hold
      When that hold is <event>
      Then the waiting request is woken to re-check
      And after a confirmation the re-check may turn the wait into a definite rejection

      Examples:
        | event                         |
        | released                      |
        | confirmed                     |
        | revoked by an older request   |

  Rule: When buyers compete for the same capacity, at least one of them wins

    @P2-S13 @verified
    # Verified by: test/routes.test.ts › "randomised contention (seed 11): never oversold, competitors never all lose, all sagas finish"
    # Verified by: test/routes.test.ts › "randomised contention (seed 12): never oversold, competitors never all lose, all sagas finish"
    # Verified by: test/routes.test.ts › "randomised contention (seed 13): never oversold, competitors never all lose, all sagas finish"
    Scenario: No request is rejected while the capacity it asked for is free
      Given 60 concurrent route requests over the partner link and five of our links
      And the partner fails 10% of calls and times out on another 10%
      When every request has finished
      Then every rejected request still does not fit on the confirmed capacity of its links

  Rule: Crossed route requests never deadlock; the older request wins

    @P2-S14 @verified
    # Verified by: test/links.test.ts › "wound-wait: an older request wounds younger unpinned holds; a younger one waits"
    Scenario: An older request revokes a younger request's hold; a younger request waits
      Given a younger request holds 8 Mbps over minutes [0, 60)
      When an older request asks for 8 Mbps over minutes [0, 60)
      Then the younger request's hold is revoked and the younger request is told
      And the older request is held
      When an even younger request asks for 8 Mbps over minutes [0, 60)
      Then it waits and revokes nothing

    @P2-S15 @verified
    # Verified by: test/links.test.ts › "wound-wait: an older request wounds younger unpinned holds; a younger one waits"
    Scenario: A hold whose request has passed its commit point is never revoked
      Given a request that has passed its commit point holds 8 Mbps over minutes [0, 60)
      When an older request asks for 8 Mbps over minutes [0, 60)
      Then the older request waits
      And nothing is revoked

    @P2-S16 @verified
    # Verified by: test/routes.test.ts › "crossed sagas: priority tickets resolve the deadlock at once (D17)"
    # Contrast: test/routes.test.ts › "crossed sagas without tickets: deadlocked until the holds expire"
    Scenario: Two route requests that take the same two links in opposite orders
      Given request A holds link 2 and then needs link 3
      And request B holds link 3 and then needs link 2
      And neither can fit while the other holds its link
      When both proceed at the same time with holds that lapse after 1,000 ms
      Then the older of the two is confirmed
      And the younger starts again and is rejected because the capacity is truly gone
      And both finish in under 500 ms, well before any hold lapses

    @P2-S17 @unverified
    # The randomised contention tests in test/routes.test.ts only bound restarts by the
    # number of requests; no test checks that the ticket is kept across restarts.
    Scenario: A request that starts again keeps its priority, so it never starves
      Given a route request whose hold was revoked by an older request
      When it starts again
      Then it keeps the ticket it was given when it first started
      And it eventually becomes the oldest competing request and wins any collision

  Rule: Partner calls are retried safely, and partner answers are respected

    @P2-S18 @verified
    # Verified by: test/routes.test.ts › "randomised contention (seed 11): never oversold, competitors never all lose, all sagas finish"
    # Verified by: test/routes.test.ts › "randomised contention (seed 12): never oversold, competitors never all lose, all sagas finish"
    # Verified by: test/routes.test.ts › "randomised contention (seed 13): never oversold, competitors never all lose, all sagas finish"
    Scenario: Partner errors and timeouts are retried with the same key and never book twice
      Given the partner fails 10% of calls, times out after doing the work on another 10%, and is slow at random
      When route requests hold, confirm and release on the partner link
      Then the partner's confirmed usage matches the stored reservations for the partner link
      And no hold is left on the partner link

    @P2-S19 @unverified
    Scenario: A busy partner is asked again until it holds or the request's deadline passes
      Given the partner answers "busy" for a route request's leg
      When the request is processed
      Then the partner is asked again after a short random pause
      And the request is neither rejected nor failed because of the busy answer alone

    @P2-S20 @unverified
    Scenario: A partner "no fit" answer rejects the route
      Given the partner answers "no fit" for a route request's leg
      When the request is processed
      Then the route is rejected naming the partner link
      And every hold the request took is released

    @P2-S21 @verified
    # Verified by: test/routes.test.ts › "crash while re-holding after a post-commit restart: the saga fails and nothing is booked"
    Scenario: The partner's hold lapsed before confirmation, so the request starts again
      Given a route request over the partner link and two of our links has passed its commit point
      When the partner answers "unknown hold" to the confirmation
      Then the request is no longer recorded as past its commit point
      And it releases all its holds and holds again, starting with the partner link

  Rule: Before the commit point a request releases everything; after it, the request completes

    @P2-S22 @verified
    # Verified by: test/routes.test.ts › "coordinator crash before the commit decision: holds expire and capacity comes back"
    Scenario: A crash before the commit point fails the request, and its capacity comes back
      Given a route request for the full 10 Mbps holds its first leg
      When the booking process crashes and restarts
      Then the request is recorded as failed and is not resumed
      And its holds stay in place until they lapse
      And after they lapse a new request for the full 10 Mbps is confirmed

    @P2-S23 @verified
    # Verified by: test/routes.test.ts › "coordinator crash after the commit decision: recovery rolls forward"
    Scenario: A crash after the commit point completes the route on restart
      Given a route request over the partner link and two of our links has passed its commit point
      And no reservation has been stored yet
      When the booking process crashes and restarts
      Then the request is confirmed
      And there is one stored reservation per link of the route
      And the restarted process counts that capacity as confirmed and rejects requests that no longer fit

    @P2-S24 @verified
    # Verified by: test/routes.test.ts › "crash while re-holding after a post-commit restart: the saga fails and nothing is booked"
    Scenario: A crash while holding again after the partner's hold lapsed books nothing
      Given a route request went back to holding after the partner answered "unknown hold"
      And it holds the partner link again but none of our links
      When the booking process crashes and restarts
      Then the request is recorded as failed
      And no reservation is stored for any of its links
      And our links on the route are free

    @P2-S25 @verified
    # Verified by: test/routes.test.ts › "recovery refuses to roll forward a committing saga whose holds are incomplete"
    Scenario: A request recorded as past its commit point but missing holds is failed, not completed
      Given a request is recorded as past its commit point
      But it does not hold every link of its route
      When the booking process restarts
      Then no reservation is stored for any of its links
      And the request is recorded as failed with a reason naming the missing holds
      And the inconsistency is reported as an error exactly once
      And its orphaned holds, including the partner's, are released

    @P2-S26 @unverified
    Scenario: The partner's hold lapsed while the booking process was down
      Given a request is recorded as past its commit point and holds every link
      When the booking process restarts and the partner answers "unknown hold" to the confirmation
      Then the request is recorded as failed with the reason that the partner hold lapsed
      And all its holds are released and no reservation is stored

    @P2-S27 @unverified
    Scenario: A crash while storing the reservations stores all of them or none
      Given a request has every leg confirmed and is storing its reservations
      When the booking process crashes part-way through
      Then either every leg is stored and the request is recorded as confirmed, or no leg is stored and the request is still recorded as past its commit point

  Rule: Retrying a request with the same idempotency key never books twice

    @P2-S28 @verified
    # Verified by: test/routes.test.ts › "idempotency: retries with the same key never book twice"
    Scenario: The same request sent twice at once
      When a buyer sends the same route request twice concurrently with the same key
      Then both calls return the same result
      And the route is booked once

    @P2-S29 @verified
    # Verified by: test/routes.test.ts › "idempotency: retries with the same key never book twice"
    Scenario: The same request retried later, after a restart
      Given a route request was confirmed
      When the buyer retries it with the same key after the booking process restarted
      Then the retry returns the original result
      And there is still exactly one stored reservation per link

    @P2-S30 @verified
    # Verified by: test/routes.test.ts › "idempotency: retries with the same key never book twice"
    Scenario: The same key with different parameters is refused
      Given a route request for 3 Mbps was made with key "same"
      When a request for 4 Mbps is sent with key "same"
      Then it is refused with an error saying the key was reused for a different request
      And this holds both while the original request is known in memory and after a restart

    @P2-S31 @unverified
    Scenario: The same key while the original request is still unfinished elsewhere
      Given a route request with key "k" is recorded but has no result yet
      When a booking process that is not running that request receives the same request with key "k"
      Then it answers "pending" for that request

  Rule: No link is ever oversold

    @P2-S32 @verified
    # Verified by: test/routes.test.ts › "randomised contention (seed 11): never oversold, competitors never all lose, all sagas finish"
    # Verified by: test/routes.test.ts › "randomised contention (seed 12): never oversold, competitors never all lose, all sagas finish"
    # Verified by: test/routes.test.ts › "randomised contention (seed 13): never oversold, competitors never all lose, all sagas finish"
    Scenario: Randomised competing routes with a faulty partner never oversell
      Given 60 concurrent route requests with random links, windows and rates
      And the partner fails 10% of calls and times out on another 10%
      When every request has finished
      Then confirmed plus held usage never exceeded any link's capacity, sampled every millisecond
      And the stored reservations never exceed any link's capacity
      And every request ended confirmed or rejected
      And each link's confirmed usage in memory matches its stored reservations
      And no hold is left on any link
