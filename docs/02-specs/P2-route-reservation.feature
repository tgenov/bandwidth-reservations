# Spec for P2: booking, changing and ending route reservations, all or nothing.
# Problem statement: ../01-discovery/P2-route-reservation.md
# Terms: glossary.md. Policies: policy-register.md.
#
# Tags: @P2-Snn is the scenario's stable ID; @need-P2-Nn is the need it serves; @POL-nn a
# policy it depends on. Conformance (design, tests, status) is kept in conformance.md.
#
# A booking on one link is a route of one leg (POL-05). Window validity is P1's rule
# (P1-S19, P1-S20) and applies to every booking. Times are HH:MM in UTC; windows are
# half-open. Values in examples are illustrations; a policy parameter's value is its
# POL default.

Feature: Booking, changing and ending route reservations, all or nothing

  As a buyer of bandwidth
  I want to book every leg of a route as one purchase and get one definite outcome
  So that I get the whole path or nothing, and am never charged for half a route

  As an agent operator
  I want the marketplace to enforce the limits I set on each agent key
  So that an agent cannot book or hold more than I allow without a human in the loop

  As a supplier or partner
  I want capacity set aside for an unfinished request to come back within a known time
  So that a request that never completes does not stop me selling that capacity

  As the business owner of the marketplace
  I want the rule that decides who wins under contention to be a setting
  So that I can change it without changing how bookings work

  Rule: A route is confirmed on every leg or on none

    Background:
      Given a route over Share links L1 and L2 and partner link P, each with a capacity of 10 Mbps

    @P2-S01 @need-P2-N1
    Scenario: A route whose every leg fits is confirmed on every leg
      Given every leg has room for 4 Mbps for [10:00, 20:00)
      When a buyer books the route at 4 Mbps for [10:00, 20:00)
      Then the booking is confirmed
      And a reservation of 4 Mbps for [10:00, 20:00) exists on L1, L2 and P

    @P2-S02 @need-P2-N1 @need-P2-N4 @POL-10
    Scenario: A route with a leg that does not fit is rejected, naming that leg, and holds nothing
      Given L2 has a confirmed reservation of 8 Mbps for [10:00, 15:00)
      When a buyer books the route at 5 Mbps for [12:00, 18:00)
      Then the booking is rejected naming L2 as the blocking link
      And no capacity is held for the request on L1, L2 or P

    @P2-S03 @need-P2-N1 @need-P2-N7
    Scenario: Confirmed is never reported before every leg, the partner's included, is secured
      Given the partner has not yet confirmed its leg of a pending route booking
      When the buyer asks for the booking's status
      Then the status is pending

    @P2-S04 @need-P2-N1 @need-P2-N5
    Scenario Outline: Whatever fails, a route never ends booked on some legs only
      Given a route booking is in progress
      When <failure>
      Then the booking ends either confirmed on every leg or holding nothing on any leg

      Examples:
        | failure                                                  |
        | a partner call fails                                     |
        | a partner call times out after the partner did the work  |
        | Share's booking process crashes and restarts             |
        | the booking's deadline passes                            |

    @P2-S05 @need-P2-N1 @POL-07 @POL-16
    Scenario: A confirmed route is withdrawn only under the supply-loss and suspension policies
      Given a confirmed route reservation
      When any number of other bookings, failures and restarts occur
      Then the reservation stays confirmed unless it is revoked under POL-07 or released under POL-16, or its account changes or ends it

  Rule: Every request is answered within ack_budget, finally if possible, otherwise as pending

    @P2-S06 @need-P2-N2 @POL-04
    Scenario: Every booking request gets a response within ack_budget
      When a buyer sends any booking request
      Then a response arrives within `ack_budget` (POL-04)

    @P2-S07 @need-P2-N2 @POL-04
    Scenario: A request whose outcome is known within ack_budget gets its final outcome
      Given a booking on one Share link that has room
      When a buyer books it
      Then the response within `ack_budget` (POL-04) is the final outcome, confirmed

    @P2-S08 @need-P2-N2 @POL-04
    Scenario: A request whose outcome is not yet known is pending, and the outcome can be polled with its idempotency key
      Given a route booking whose partner leg answers slowly
      When a buyer books it
      Then the response within `ack_budget` (POL-04) is pending
      And polling with the request's idempotency key returns the outcome once it is known

    @P2-S09 @need-P2-N2 @POL-04
    Scenario: A buyer who registered a webhook is sent the outcome
      Given the buyer has registered a webhook
      And a booking of theirs was answered pending
      When the booking's outcome is known
      Then the outcome is sent to the webhook, signed, and retried until acknowledged for up to `webhook_retry` (POL-04)

    @P2-S10 @need-P2-N2
    Scenario: An outcome never changes once reported
      Given a booking request has been reported confirmed, rejected, invalid or failed
      When the buyer asks for its status at any later time
      Then the same outcome is reported

  Rule: A request has its outcome by its deadline

    @P2-S11 @need-P2-N3 @POL-26
    Scenario: A request without a deadline gets the default deadline
      When a buyer books a route without stating a deadline
      Then the request's deadline is `route_deadline_default` (POL-26) after it was received

    @P2-S12 @need-P2-N3 @POL-26
    Scenario: A deadline beyond the maximum is invalid
      When a buyer books a route with a deadline longer than `route_deadline_max` (POL-26)
      Then the request is invalid and holds nothing

    @P2-S13 @need-P2-N3 @POL-26
    Scenario: A request still without an outcome at its deadline fails and holds nothing
      Given a route booking whose partner has not answered
      When the request's deadline passes
      Then the booking fails with the reason that its deadline passed
      And no capacity is held for it on any leg

    @P2-S14 @need-P2-N3 @POL-26
    Scenario: Capacity held for a request that is not confirmed is available again by its deadline
      Given a pending route booking holds capacity on its legs
      When the request ends rejected or failed, for any reason
      Then that capacity is available to other buyers no later than the request's deadline

  Rule: When requests compete, at least one that can be served wins, and nobody waits forever

    Background:
      Given a Share link L with a capacity of 10 Mbps and no reservations

    @P2-S15 @need-P2-N4 @POL-02
    Scenario: Competing requests that can each be served alone do not all lose
      Given several buyers book 8 Mbps on L for [10:00, 11:00) at the same time
      When every booking has its outcome
      Then exactly one of them is confirmed

    @P2-S16 @need-P2-N4 @POL-02
    Scenario: Under the request_age rule the earlier request wins
      Given `priority_rule` is `request_age` (POL-02)
      And booking X for 8 Mbps on L for [10:00, 11:00) was received before booking Y for the same
      When X and Y compete for that capacity
      Then X is confirmed and Y is rejected

    @P2-S17 @need-P2-N4 @POL-05
    Scenario: A request that waits is rejected for no fit only if it does not fit on committed capacity
      Given a booking on L that did not ask not to wait
      When it is rejected for no fit
      Then at the moment of rejection its window did not fit alongside the committed rate on L

    @P2-S18 @need-P2-N4 @POL-05 @POL-10
    Scenario: A request that asks not to wait is rejected at once with retry_after when capacity it needs is in flight
      Given a pending request in flight holds 8 Mbps on L for [10:00, 11:00)
      When another buyer books 8 Mbps on L for [10:00, 11:00) with `wait = false` (POL-05)
      Then the booking is rejected at once with a `retry_after` of the in-flight request's remaining deadline

    @P2-S19 @need-P2-N4
    Scenario: Crossed requests settle without waiting for capacity holds to time out
      Given request A has capacity held on link L1 and needs link L2
      And request B has capacity held on L2 and needs L1
      And neither fits while the other holds its capacity
      When both proceed at the same time
      Then both have their outcomes before either deadline passes
      And at least one of them is confirmed

    @P2-S20 @need-P2-N4 @POL-05 @POL-26
    Scenario: A contended request waits, pending, and is confirmed if the capacity in flight is released within its deadline
      Given a pending request in flight holds 8 Mbps on L for [10:00, 11:00)
      And another buyer books 8 Mbps on L for [10:00, 11:00) without asking not to wait
      When the in-flight request ends without confirmation before the second booking's deadline (POL-26)
      Then the second booking is confirmed

    @P2-S52 @need-P2-N4 @POL-05 @POL-10
    Scenario: A waiting request whose capacity is then confirmed to the request ahead of it is rejected with a counter-offer
      Given a pending request in flight holds 8 Mbps on L for [10:00, 11:00)
      And another buyer's booking of 8 Mbps on L for [10:00, 11:00) is waiting for it
      When the in-flight request is confirmed
      Then the waiting booking is rejected for no fit, with the counter-offer of POL-10

    @P2-S21 @need-P2-N4 @POL-02
    Scenario: Changing the priority rule does not change the outcome of uncontended requests
      Given a booking that competes with no other request
      When it is decided under any value of `priority_rule` (POL-02)
      Then its outcome is the same

  Rule: A request interrupted by Share's own failure resumes if it still can, otherwise fails cleanly

    @P2-S22 @need-P2-N5 @POL-03
    Scenario: An interrupted request that can still finish within its deadline is resumed
      Given a route booking is in progress
      When Share's booking process crashes and restarts with enough of the deadline left to finish
      Then the booking reaches its outcome as if there had been no crash
      And the buyer sees one outcome

    @P2-S23 @need-P2-N5 @POL-03
    Scenario: An interrupted request that cannot finish within its deadline fails, releases everything and says why
      Given a route booking is in progress
      When Share's booking process crashes and does not restart before the deadline
      Then the booking fails with a reason saying it was interrupted by an internal failure
      And no capacity is held for it on any leg

  Rule: Retrying a request with the same idempotency key never books twice

    @P2-S24 @need-P2-N6
    Scenario: The same request sent twice at once is booked once
      When a buyer sends the same booking request twice at the same time with the same idempotency key
      Then both responses report the same request and outcome
      And one reservation exists

    @P2-S25 @need-P2-N6
    Scenario: A retry after the outcome returns the original outcome, even after a restart
      Given a booking request was confirmed
      And Share's booking process has restarted since
      When the buyer retries the request with the same idempotency key
      Then the response is the original outcome
      And still one reservation exists

    @P2-S26 @need-P2-N6
    Scenario: A different request under a key already used is refused
      Given a buyer booked a route at 3 Mbps with idempotency key "k1"
      When the same account sends a booking at 4 Mbps with key "k1"
      Then the second request is refused as a reuse of the key for a different request
      And the first request is unaffected

    @P2-S27 @need-P2-N6
    Scenario: A retry while the request is pending returns its current status
      Given a booking request with key "k2" is pending
      When the buyer retries it with key "k2"
      Then the response is pending for that same request, and no second request is started

  Rule: Partner legs are booked safely

    Background:
      Given a route over Share link L1 and partner link P

    @P2-S28 @need-P2-N7
    Scenario: Retried partner calls never book the partner twice
      Given the partner fails some calls, times out after doing the work on others and is slow at random
      When route bookings over P are made, confirmed and released
      Then Share's record of bookings on P matches the partner's record

    @P2-S29 @need-P2-N7 @need-P2-N1
    Scenario: Share never confirms a leg the partner has not confirmed
      Given the partner never confirmed its leg of a route booking
      When the booking has its outcome
      Then the outcome is not confirmed

    @P2-S30 @need-P2-N7
    Scenario: A transient partner refusal does not end the request before its deadline
      Given the partner says it cannot take the leg right now
      When the request is still within its deadline
      Then the request is neither rejected nor failed because of that answer alone

    @P2-S31 @need-P2-N7 @POL-10
    Scenario: A definite partner refusal rejects the route, naming the partner link
      When the partner says the leg does not fit
      Then the booking is rejected naming P as the blocking link
      And no capacity is held for it on any leg

    @P2-S32 @need-P2-N7
    Scenario: Share's record of partner bookings is reconciled with the partner
      Given Share's record of bookings on P differs from the partner's record
      When the bookings on P are reconciled with the partner
      Then each difference is reported to operations for resolution

  Rule: A partner without holds is booked last, at most once per route, at Share's risk

    Background:
      Given partner link Q belongs to a partner without holds

    @P2-S33 @need-P2-N7 @POL-28
    Scenario: A partner without holds is booked only after every other leg and the funds are secured
      Given a route over Share link L1 and Q
      When L1 cannot be secured, or the funds hold cannot be taken
      Then Q is never booked for that request

    @P2-S34 @need-P2-N7 @POL-28
    Scenario: A route with two legs on partners without holds is refused
      Given a route over Q and another partner link without holds
      When a buyer books the route
      Then the request is refused before anything is held, stating that a route may include at most one such leg

    @P2-S35 @need-P2-N7 @POL-28
    Scenario: A failure after the partner without holds was booked cancels it at Share's cost
      Given a route over Share link L1 and Q, and Q has been booked for a request
      When a later step of that request fails
      Then Share cancels the booking on Q
      And the buyer is not charged for the failed request

    @P2-S36 @need-P2-N7 @POL-26 @POL-28
    Scenario: A partner whose holds are too short is booked as a partner without holds
      Given partner link S holds capacity for less than `route_deadline_max` plus `commit_margin` (POL-26)
      When a buyer books a route over S and Q
      Then the request is refused before anything is held, stating that a route may include at most one leg without holds

    @P2-S37 @need-P2-N7 @need-P2-N1
    Scenario: A route over two partners with holds of different lengths is all or nothing
      Given a route over partner links P1 and P2, whose holds last different lengths of time, each long enough for the request's deadline
      When the booking has its outcome
      Then it is confirmed on both or holds nothing on either

  Rule: Funds and limits are checked before a reservation is confirmed

    @P2-S38 @need-P2-N8 @POL-15 @POL-10
    Scenario: A booking the account cannot fund is rejected, stating the top-up needed
      Given an account whose headroom is less than the funds hold a booking needs (POL-15)
      When the account books it
      Then the booking is rejected for insufficient funds, stating the top-up needed: the funds hold less the headroom
      And nothing is held for it

    @P2-S39 @need-P2-N8 @POL-25
    Scenario: A booking beyond an agent key's spending limit is rejected
      Given an agent key whose funds held plus charges accrued by its bookings in the current `key_spend_period` would exceed its `key_spend_limit` (POL-25) with a new booking
      When the key makes the booking
      Then the booking is rejected stating that the key's spending limit would be exceeded

    @P2-S40 @need-P2-N8 @POL-25
    Scenario Outline: A booking beyond a limit on capacity in flight is rejected
      Given the Mbps in requests of the <holder> not yet decided is at its <limit> (POL-25)
      When the <holder> makes another booking
      Then the booking is rejected stating that the <holder>'s limit on capacity in flight is reached

      Examples:
        | holder    | limit                    |
        | agent key | `key_inflight_limit`     |
        | account   | `account_inflight_limit` |

    @P2-S41 @need-P2-N8 @POL-25
    Scenario: Requests from an agent key above its rate limit are refused
      Given an agent key that has reached its `key_rate_limit` (POL-25)
      When the key sends another request
      Then the request is refused stating the rate limit and when the key may send again

    @P2-S42 @need-P2-N8 @POL-16
    Scenario: A suspended account cannot book
      Given an account that is suspended (POL-16)
      When the account makes a booking
      Then the booking is rejected stating that the account is suspended and the top-up that would resume it

  Rule: A reservation is changed or ended as one unit, without risk to what the buyer already has

    Background:
      Given it is 10:00:30
      And a confirmed reservation R of 4 Mbps for [09:00, 18:00) on a route over Share links L1 and L2, each with a capacity of 10 Mbps

    @P2-S43 @need-P2-N9 @POL-08
    Scenario: A cancellation takes effect at the next minute boundary on every leg
      When the account cancels R
      Then R ends at 10:01
      And from 10:01 its capacity on L1 and L2 is available to other buyers

    @P2-S44 @need-P2-N9 @POL-08
    Scenario: Shortening cancels the remaining part
      When the account shortens R to end at 12:00
      Then R ends at 12:00
      And from 12:00 its capacity on L1 and L2 is available to other buyers

    @P2-S45 @need-P2-N9 @POL-08
    Scenario: An extension is admitted for the added period only
      Given L2 has 6 Mbps confirmed for another buyer for [18:00, 20:00)
      When the account extends R to end at 20:00
      Then the extension is confirmed, and R ends at 20:00

    @P2-S46 @need-P2-N9 @POL-08
    Scenario: A rejected extension leaves the reservation as it was
      Given L2 has 8 Mbps confirmed for another buyer for [18:00, 20:00)
      When the account extends R to end at 20:00
      Then the extension is rejected naming L2
      And R is unchanged, at 4 Mbps for [09:00, 18:00)

    @P2-S47 @need-P2-N9 @POL-08
    Scenario: A rate increase is admitted for the difference only, and a rejection leaves the reservation as it was
      Given L1 has 4 Mbps confirmed for another buyer for [09:00, 18:00)
      When the account increases R to 8 Mbps
      Then the increase is rejected naming L1
      And R is unchanged, at 4 Mbps for [09:00, 18:00)

    @P2-S48 @need-P2-N9 @POL-08
    Scenario: A rate decrease takes effect at the next minute boundary
      When the account decreases R to 1 Mbps
      Then R is 1 Mbps from 10:01
      And from 10:01 the 3 Mbps released on L1 and L2 is available to other buyers

    @P2-S49 @need-P2-N9 @POL-08
    Scenario: A change to part of a route is refused
      When the account asks to cancel R on L2 only
      Then the request is refused, stating that a route is changed or cancelled as one unit
      And R is unchanged

    @P2-S50 @need-P2-N9 @POL-08
    Scenario: A partner leg's minimum term and cancellation fee are shown at booking
      Given a route with a partner leg that imposes a minimum term and a cancellation fee
      When a buyer is shown the price of a booking on it
      Then the price shows the minimum term and the cancellation fee

  Rule: Operations can see requests in trouble

    @P2-S51 @need-P2-N10
    Scenario: A failed request is visible to operations with its reason
      Given a booking request that failed
      When operations looks for requests in trouble
      Then the request is listed with its reason and the leg concerned

    @P2-S53 @need-P2-N10 @need-P2-N3 @POL-26
    Scenario: A request still pending after its deadline plus commit_margin raises an operational alert
      When a booking request is still pending after its deadline plus `commit_margin` (POL-26)
      Then operations is alerted, with the request, the leg concerned and how long it has been pending
