# Spec for P2: booking, changing and ending route reservations, all or nothing.
# Problem statement: ../01-discovery/P2-route-reservation.md
# Terms: glossary.md. Policies: policy-register.md.
#
# Tags: @P2-Snn is the scenario's stable ID; @need-P2-Nn is the need it serves; @POL-nn a
# policy it depends on. Conformance (design, tests, status) is kept in conformance.md.
#
# A booking on one link is a route of one leg (POL-05). Window and rate validity are P1's
# rule (P1-S19, P1-S20) and apply to every booking and change. Times are HH:MM in UTC;
# windows are half-open. Outcomes are the glossary's: confirmed, rejected, invalid,
# failed (pending until then); a submission refused before it becomes a request is "not
# accepted". Values in examples are illustrations; a policy parameter's value is its POL
# default. Amounts are USD; "micro-USD" is 10^-6 USD.

Feature: Booking, changing and ending route reservations, all or nothing

  As a buyer of bandwidth
  I want to book every leg of a route as one purchase and get one definite outcome
  So that I get the whole path or nothing, and am never charged for half a route

  As an agent operator
  I want the marketplace to enforce the limits I set on each agent key
  So that an agent cannot book, hold or spend more than I allow without a human in the loop

  As a supplier or partner
  I want capacity set aside for an unfinished request to come back within a known time
  So that a request that never completes does not stop me selling that capacity

  As the business owner of the marketplace
  I want the rule that decides who wins under contention to be a setting
  So that I can change it without changing how bookings work

  Rule: A route is confirmed on every leg or on none

    Background:
      Given a route over Share links L1 and L2 and partner link P, each with a capacity of 10 Mbps
      And it is 09:00

    @P2-S01 @need-P2-N1
    Scenario: A route whose every leg fits is confirmed on every leg
      Given every leg has room for 4 Mbps for [10:00, 20:00)
      When a buyer books the route at 4 Mbps for [10:00, 20:00)
      Then the booking is confirmed
      And a reservation of 4 Mbps for [10:00, 20:00) exists on L1, L2 and P

    @P2-S02 @need-P2-N1 @need-P2-N11 @POL-10
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

    @P2-S05 @need-P2-N1 @POL-07 @POL-08 @POL-16 @POL-30
    Scenario: A confirmed route ends only at its account's request or by Share's decision under the supply-loss, suspension and termination policies
      Given a confirmed route reservation
      When any number of other bookings, failures and restarts occur
      Then the reservation stays confirmed unless its account changes or ends it (POL-08), or Share revokes it (POL-07), releases it (POL-16) or terminates it (POL-30)

  Rule: Every request is answered within ack_budget, finally if possible, otherwise as pending

    @P2-S06 @need-P2-N2 @POL-04
    Scenario: Every booking request gets a response within ack_budget
      When a buyer sends any booking request
      Then a response arrives within `ack_budget` (POL-04)

    @P2-S07 @need-P2-N2 @POL-04
    Scenario: A request whose outcome is known within ack_budget gets its final outcome
      Given a booking on one Share link that has room, with no capacity in flight on it
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

    @P2-S10 @need-P2-N2 @POL-04 @POL-29
    Scenario: An outcome never changes once reported
      Given a booking request has been reported confirmed, rejected, invalid or failed
      When the buyer asks for its status at any later time within `idempotency_retention` (POL-29)
      Then the same outcome is reported

    @P2-S99 @need-P2-N2 @POL-04
    Scenario: A status read never contradicts the decided outcome, and reflects it within status_staleness
      Given a booking request's outcome has been decided
      When the buyer reads its status at any time after the decision
      Then the status read reports either pending or the decided outcome, never another outcome
      And every status read from `status_staleness` (POL-04) after the decision reports the decided outcome

  Rule: A request has its outcome by its deadline

    @P2-S11 @need-P2-N3 @POL-26
    Scenario: A request without a deadline gets the default deadline
      When a buyer books a route without stating a deadline
      Then the request's deadline is `route_deadline_default` (POL-26) after it was received

    @P2-S12 @need-P2-N3 @POL-26
    Scenario Outline: A deadline outside its bounds is invalid
      When a buyer books a route <route> with a deadline of <deadline>
      Then the request is invalid and holds nothing

      Examples:
        | route                          | deadline | case                                                       |
        | over Share links L1 and L2     | 61 s     | longer than `route_deadline_max`                           |
        | over Share links L1 and L2     | 0 s      | zero                                                       |
        | over Share links L1 and L2     | -5 s     | negative                                                   |
        | over Share links L1 and L2     | 0.5 s    | shorter than `route_deadline_min`                          |
        | over Share link L1 and partner link P | 10 s | shorter than `commit_margin` plus `route_deadline_min` |

    @P2-S86 @need-P2-N3 @POL-26
    Scenario Outline: A deadline at the edge of its bounds is valid
      When a buyer books a route <route> with a deadline of <deadline>
      Then the request is not invalid

      Examples:
        | route                                 | deadline |
        | over Share links L1 and L2            | 1 s      |
        | over Share link L1 and partner link P | 11 s     |
        | over Share link L1 and partner link P | 60 s     |

    @P2-S13 @need-P2-N3 @POL-26
    Scenario: A request whose partner never answers has failed by its deadline and holds nothing
      Given a route booking whose partner has not answered
      When the request's deadline arrives
      Then by its deadline the booking has failed, with the reason that its deadline passed
      And no capacity is held for it on any leg

    @P2-S55 @need-P2-N3 @POL-26
    Scenario: A request with a partner leg does not begin committing later than its deadline less commit_margin
      Given a route booking over Share link L1 and partner link P whose partner had not answered by its deadline less `commit_margin` (POL-26)
      When the partner then answers that the leg fits
      Then the booking is not confirmed
      And by its deadline it has failed, with the reason that its deadline passed, and holds nothing on L1 or P

    @P2-S14 @need-P2-N3 @need-P2-N7 @POL-26
    Scenario: Capacity held for a request that is not confirmed is free on Share links at once, and at a partner by the deadline
      Given a pending route booking over Share link L1 and partner link P holds capacity on both
      When the request ends rejected or failed, for any reason
      Then its capacity on L1 is available to other buyers from the moment of the outcome
      And its capacity held at P is released no later than the request's deadline

    @P2-S93 @need-P2-N3 @need-P2-N7 @POL-26
    Scenario: Share releases every hold of a request at its deadline, a partner hold included
      Given a pending route booking over Share link L1 and partner link P, with a deadline of 30 s, holds capacity on both
      And the request's decision record is available at its deadline
      When the request's deadline arrives and it has not been confirmed
      Then the request has failed as of its deadline
      And at its deadline Share releases its hold on L1 and its hold at P, without waiting for either to lapse by itself

    @P2-S100 @need-P2-N3 @need-P2-N7 @POL-26
    Scenario: Share sets a partner hold to expire at the request's deadline
      Given a route booking over Share link L1 and partner link P, with a deadline of 30 s, is pending
      When Share takes a hold at P for it
      Then the hold at P is set to expire at the request's deadline (POL-26)

    @P2-S101 @need-P2-N3 @need-P2-N7 @POL-26
    Scenario: Capacity held at a partner lapses at the deadline even when Share is unavailable then
      Given a pending route booking over Share link L1 and partner link P, with a deadline of 30 s, holds capacity on both
      And Share's booking process becomes unavailable before the deadline and stays unavailable until after it
      When the request's deadline arrives
      Then the request has failed as of its deadline
      And from its deadline no capacity is held for it at P
      And no capacity is held for it on L1 later than `release_grace` (POL-26) after its deadline

    @P2-S104 @need-P2-N3 @need-P2-N10 @POL-26 @POL-04
    Scenario: A request whose decision record is unavailable at its deadline is never confirmed, and its Share-link holds are released within release_grace
      Given a pending route booking over Share links L1 and L2, with a deadline of 30 s, holds capacity on both
      And the request's decision record becomes unavailable before its deadline and stays unavailable until after it
      When the request's deadline arrives
      Then the request has failed as of its deadline (POL-26), and it is never confirmed, even once its decision record is available again
      And its holds on L1 and L2 are released no later than `release_grace` (POL-26: 1 min) after its deadline
      And operations is alerted, with the request and the legs concerned

    @P2-S56 @need-P2-N3 @POL-08
    Scenario: A buyer may withdraw a pending request
      Given a booking request of the buyer is pending and holds capacity
      When the buyer withdraws it
      Then the request fails with the reason "withdrawn"
      And it holds nothing on any leg

    @P2-S57 @need-P2-N3 @need-P2-N7 @POL-08 @POL-28
    Scenario: Withdrawing a request after its partner leg without holds was booked cancels that leg at Share's cost
      Given a pending route booking over Share link L1 and partner link Q of a partner without holds, and Q has been booked for it
      When the buyer withdraws the request
      Then the request fails with the reason "withdrawn"
      And Share cancels the booking on Q, bearing its cost (POL-28)
      And the buyer is not charged for the request

  Rule: When requests compete, contention alone never makes every waiting competitor lose, and nobody waits beyond its deadline

    Background:
      Given a Share link L with a capacity of 10 Mbps and no reservations
      And it is 09:00

    @P2-S15 @need-P2-N4 @POL-02 @POL-05 @POL-26
    Scenario: Competing requests that wait do not all lose
      Given several buyers book 8 Mbps on L for [10:00, 11:00) at the same time, each with `wait` at its default and the default deadline
      And no request ends for any reason other than contention
      When every booking has its outcome
      Then exactly one of them is confirmed
      And every other is rejected for no fit

    @P2-S16 @need-P2-N4 @POL-02 @POL-05
    Scenario: Under the request_age rule, the oldest waiting request gets capacity that is released
      Given `priority_rule` is `request_age` (POL-02)
      And a request Z holds 8 Mbps on L for [10:00, 11:00)
      And bookings X and Y for 8 Mbps on L for [10:00, 11:00) are both waiting for it, X received before Y
      When Z ends without confirmation
      Then X is confirmed
      And Y is rejected for no fit

    @P2-S58 @need-P2-N4 @POL-02 @POL-05
    Scenario: A request already holding capacity is not pre-empted by an older one
      Given `priority_rule` is `request_age` (POL-02)
      And a route request X needs 8 Mbps on L for [10:00, 11:00) and is still securing an earlier leg
      And a single-link request Y, received after X, holds 8 Mbps on L for [10:00, 11:00)
      When X reaches L
      Then Y keeps its capacity held on L
      And X waits, pending, within its own deadline

    @P2-S17 @need-P2-N4 @POL-05
    Scenario: A request that waits is rejected for no fit only if it does not fit on committed capacity
      Given a booking on L with `wait` at its default
      When it is rejected for no fit
      Then at the moment of rejection its window did not fit beside the committed rate on L

    @P2-S18 @need-P2-N4 @POL-05 @POL-10
    Scenario: A request that asks not to wait is rejected at once with retry_after when capacity it needs is in flight
      Given a pending request in flight holds 8 Mbps on L for [10:00, 11:00)
      When another buyer books 8 Mbps on L for [10:00, 11:00) with `wait = false` (POL-05)
      Then the booking is rejected at once with a `retry_after` of the in-flight request's remaining deadline
      And with the counter-offer of POL-10 computed beside the capacity in flight: 2 Mbps is the largest rate that fits [10:00, 11:00), and [11:00, 12:00) is the earliest one-hour window at or after 10:00 that fits 8 Mbps

    @P2-S59 @need-P2-N4 @POL-02 @POL-05
    Scenario: A request that asked not to wait is outside the contention guarantee
      Given a request A holds 8 Mbps on L for [10:00, 11:00)
      And a booking B of 8 Mbps on L for the same window, made with `wait = false`, was rejected at once with `retry_after`
      When A then fails
      Then B is still rejected
      And no reservation of that capacity exists, and nothing is held for A or B

    @P2-S61 @need-P2-N4 @POL-02 @POL-26 @POL-05
    Scenario: A request whose deadline is shorter than the outcome it waits on is outside the contention guarantee
      Given a route request A holds 8 Mbps on L for [10:00, 11:00), and its partner leg answers slowly
      And a booking B of 8 Mbps on L for the same window waits for it, with a deadline of 5 s
      When B's deadline passes before A has its outcome, and A then fails
      Then B has failed with the reason "deadline passed while waiting" and a `retry_after` of A's remaining deadline at that moment (POL-02)
      And neither A nor B is confirmed, and nothing is held for either

    @P2-S95 @need-P2-N4 @POL-02 @POL-05 @POL-26
    Scenario: A waiter with a partner leg whose deadline, less commit_margin, has passed when the request ahead fails is outside the contention guarantee
      Given a request A holds 8 Mbps on L for [10:00, 11:00)
      And a booking B of 8 Mbps over L and partner link P for the same window waits for it, with a deadline of 30 s, so it may not begin committing after 20 s, its deadline less `commit_margin` (POL-26)
      When A fails 25 s into B's deadline
      Then B is not confirmed
      And B has failed as of its deadline with the reason "deadline passed while waiting" and a `retry_after` of 0 s, A having already had its outcome (POL-02)
      And nothing is held for A or B on any leg

    @P2-S62 @need-P2-N4 @POL-02 @POL-05
    Scenario: Losses caused by failures leave nothing held and tell each buyer why
      Given requests A and B compete for 8 Mbps on L for [10:00, 11:00), A holding it and B waiting
      When A fails because its partner leg faults, and B then fails because its own partner leg faults
      Then neither A nor B is confirmed
      And nothing is held for either on any leg
      And each buyer is told the reason its request failed

    @P2-S19 @need-P2-N4 @POL-02 @POL-05 @POL-10
    Scenario: In a crossing, the older request keeps its holds and the younger releases its conflicting holds and waits
      Given `priority_rule` is `request_age` (POL-02)
      And Share links L1 and L2, each with a capacity of 10 Mbps
      And request A, received before request B, holds 8 Mbps on L1 and needs 8 Mbps on L2 for [10:00, 11:00)
      And request B holds 8 Mbps on L2 and needs 8 Mbps on L1 for [10:00, 11:00)
      And each would be confirmed if the other did not exist
      When both proceed at the same time
      Then B releases its capacity held on L2 and waits, pending, within its own deadline
      And A is confirmed before either deadline passes
      And B is then rejected for no fit, with the counter-offer of POL-10

    @P2-S60 @need-P2-N4 @POL-02 @POL-05
    Scenario: The younger request of a crossing is confirmed if the older then ends without confirmation
      Given requests A and B crossed on L1 and L2 as in P2-S19, and B has released its hold on L2 and is waiting
      When A ends without confirmation for a reason of its own, within B's deadline
      Then B is confirmed

    @P2-S87 @need-P2-N4 @POL-02 @POL-05 @POL-10
    Scenario: A cycle of three waiting requests is broken, and the oldest is confirmed before any deadline
      Given `priority_rule` is `request_age` (POL-02)
      And Share links L1, L2 and L3, each with a capacity of 10 Mbps
      And requests A, B and C, received in that order, each for 8 Mbps for [10:00, 11:00): A over L1 and L2, B over L2 and L3, C over L3 and L1
      And A holds 8 Mbps on L1 and waits for L2, B holds L2 and waits for L3, and C holds L3 and waits for L1
      When they proceed
      Then B releases its hold on L2 and C its hold on L3, because each is waiting and holds what an older waiting request needs, and both wait, pending, within their own deadlines
      And A is confirmed before any of their deadlines passes
      And B and C are then rejected for no fit, with the counter-offer of POL-10

    @P2-S88 @need-P2-N4 @POL-02 @POL-05
    Scenario: In a broken cycle, the next oldest is confirmed if the oldest then ends without confirmation
      Given requests A, B and C in a cycle on L1, L2 and L3 as in P2-S87, B and C having released their holds and waiting
      When A ends without confirmation for a reason of its own, within B's deadline
      Then B is confirmed
      And C is rejected for no fit

    @P2-S97 @need-P2-N4 @POL-02 @POL-05
    Scenario: A request that yields in a crossing keeps its place among waiters
      Given requests A and B crossed on L1 and L2 as in P2-S19, B having released its hold on L2 and waiting, and A holding 8 Mbps on L1 and L2
      And a request D for 8 Mbps on L2 for [10:00, 11:00), received after B, is also waiting
      When A ends without confirmation for a reason of its own, within B's and D's deadlines
      Then B is confirmed
      And D is rejected for no fit

    @P2-S20 @need-P2-N4 @POL-05 @POL-26
    Scenario: A contended request waits, pending, and is confirmed if the capacity in flight is released within its deadline
      Given a pending request in flight holds 8 Mbps on L for [10:00, 11:00)
      And another buyer's booking of 8 Mbps on L for [10:00, 11:00), with `wait` at its default, is waiting for it
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

    @P2-S22 @need-P2-N5 @POL-03 @POL-26
    Scenario: An interrupted request that can still finish within its deadline is resumed
      Given a route booking is in progress
      When Share's booking process crashes and restarts while the request can still complete its remaining steps by its deadline (less `commit_margin` with a partner leg, POL-26)
      Then the booking reaches its outcome as if there had been no crash
      And the buyer sees one outcome

    @P2-S23 @need-P2-N5 @POL-03 @POL-26
    Scenario: An interrupted request that cannot finish within its deadline fails, releases everything and says why
      Given a route booking is in progress
      When Share's booking process crashes and does not restart before the deadline
      Then the request has failed as of its deadline (POL-26), with a reason saying it was interrupted by an internal failure
      And any status asked for after the restart reports that outcome
      And no capacity is held for it at a partner after its deadline, or on a Share link later than `release_grace` (POL-26) after it

  Rule: Retrying a request with the same idempotency key never books twice

    @P2-S24 @need-P2-N6 @POL-29
    Scenario: The same request sent twice at once is booked once
      When a buyer sends the same booking request twice at the same time with the same idempotency key
      Then both responses report the same request and outcome
      And one reservation exists

    @P2-S25 @need-P2-N6 @POL-29
    Scenario: A retry after the outcome returns the original outcome, even after a restart
      Given a booking request was confirmed less than `idempotency_retention` (POL-29) ago
      And Share's booking process has restarted since
      When the buyer retries the request with the same idempotency key
      Then the response is the original outcome
      And still one reservation exists

    @P2-S26 @need-P2-N6 @POL-29
    Scenario Outline: A different request under a key already used is not accepted
      Given a buyer booked a route at 3 Mbps for [10:00, 11:00) with idempotency key "k1"
      When the same principal sends a booking with key "k1" that differs only in its <field>
      Then the second submission is not accepted, as a reuse of the key for a different request
      And the first request is unaffected

      Examples:
        | field         |
        | route         |
        | window        |
        | rate          |
        | product       |
        | `wait` setting |

    @P2-S63 @need-P2-N6 @POL-29
    Scenario: A retry that differs only in its deadline is the same request
      Given a buyer booked a route with idempotency key "k4" and a deadline of 30 s
      When the same principal sends the same booking with key "k4" and a deadline of 20 s
      Then the response is that of the first request
      And no second request is started

    @P2-S64 @need-P2-N6 @need-X1-N4 @POL-29
    Scenario: A key reused by another principal of the same account is not accepted, and learns nothing
      Given agent key K1 of account "b1" sent a booking request with idempotency key "k5"
      When agent key K2 of "b1" sends the same booking with idempotency key "k5"
      Then K2's submission is not accepted, as a reuse of the key by another principal
      And the answer reveals nothing of K1's request or its outcome
      And K1's request is unaffected

    @P2-S65 @need-P2-N6 @POL-29
    Scenario: After idempotency_retention a key identifies a new request
      Given a booking with idempotency key "k6" was made more than `idempotency_retention` (POL-29) ago
      When the same account sends a different booking with key "k6"
      Then it is decided as a new request on its own merits

    @P2-S27 @need-P2-N6 @POL-29
    Scenario: A retry while the request is pending returns its current status
      Given a booking request with key "k2" is pending
      When the buyer retries it with key "k2"
      Then the response is pending for that same request, and no second request is started

  Rule: Partner legs are booked safely

    Background:
      Given a route over Share link L1 and partner link P
      And it is 09:00

    @P2-S28 @need-P2-N7 @POL-28
    Scenario: Retried partner calls never book the partner twice
      Given the partner fails some calls, times out after doing the work on others and is slow at random
      When any number of route bookings over P are made and each has its outcome, and some confirmed ones are later cancelled
      Then after reconciliation (POL-28) Share's record of bookings on P matches the partner's record

    @P2-S29 @need-P2-N7 @need-P2-N1
    Scenario: Share never confirms a leg the partner has not confirmed
      Given the partner never confirmed its leg of a route booking
      When the booking has its outcome
      Then the outcome is not confirmed

    @P2-S30 @need-P2-N7
    Scenario: A transient partner refusal does not end the request before its deadline
      Given a route booking over P is pending
      When the partner answers that it cannot take the leg right now, and the request's deadline has not passed
      Then the request is still pending, neither rejected nor failed because of that answer

    @P2-S31 @need-P2-N7 @need-P2-N11 @POL-10 @POL-02
    Scenario: A definite partner refusal rejects the route, naming the partner link, when no other Share request holds capacity there
      Given a buyer's booking of the route is pending
      And no other Share request holds capacity at P overlapping its window
      When the partner says the leg does not fit
      Then the booking is rejected naming P as the blocking link
      And no capacity is held for it on any leg

    @P2-S89 @need-P2-N4 @need-P2-N7 @POL-02 @POL-05
    Scenario: A partner refusal while Share's own request holds overlapping capacity at that partner is contention: the refused request waits and asks again
      Given another Share request A holds 8 Mbps at P for [10:00, 11:00)
      And a buyer's booking B of 8 Mbps over L1 and P for [10:00, 11:00) is pending, with `wait` at its default
      When the partner says B's leg does not fit, while A's hold at P overlaps B's window
      Then B is not rejected, and waits, pending, within its own deadline, as on a Share link
      And once A's hold at P is confirmed or released, Share asks the partner for B's leg again, within B's deadline

    @P2-S105 @need-P2-N7 @need-P2-N3 @POL-28 @POL-08 @POL-26
    Scenario Outline: A partner booking left without Share's confirmation is cancelled at once, at Share's cost, whatever the partner
      Given a pending route booking over L1 and P, a partner with holds
      And the partner has confirmed its leg on P for the request, which Share has not yet confirmed
      When <event>
      Then the request is not confirmed
      And Share cancels the booking on P at once, bearing its cost (POL-28)
      And the buyer is not charged for the request

      Examples:
        | event                                                   |
        | a later step of the request fails                       |
        | the buyer withdraws the request                         |
        | the request's deadline passes before Share confirms it  |

    @P2-S32 @need-P2-N7 @POL-28
    Scenario: Every partner is fully reconciled daily, and each mismatch alerts operations
      Given Share's record of bookings on P for day D differs from the partner's record
      When the bookings on P are reconciled with the partner
      Then each difference is reported to operations by 12:00 UTC on D + 1 (POL-28)

    @P2-S90 @need-P2-N7 @POL-28 @POL-29
    Scenario: A partner call whose result is unknown is reconciled for that booking at once
      When Share's call to book a request's leg on P times out without an answer
      Then Share asks the partner at once for that booking's state, under the same idempotency key (POL-28)
      And Share's record of that booking follows the partner's answer

    @P2-S91 @need-P2-N7 @need-P2-N1 @POL-28 @POL-23 @POL-07
    Scenario Outline: A mismatch found in reconciliation is resolved without charging the buyer for it
      When the reconciliation with the partner finds <mismatch>
      Then <resolution>
      And operations is alerted

      Examples:
        | mismatch                                                      | resolution                                                                                         |
        | a booking on P with no Share reservation behind it            | Share cancels it at its own cost (POL-23), and no buyer is charged for it                           |
        | a Share reservation whose leg on P the partner does not have  | the reservation is treated as affected by an unplanned outage on P (POL-07), and its holder is told |

  Rule: A partner without holds is booked last, at most once per route, at Share's risk

    Background:
      Given partner link Q belongs to a partner without holds

    @P2-S33 @need-P2-N7 @POL-28 @POL-15
    Scenario Outline: A partner without holds is booked only after every other leg and the funds are secured
      Given a route over Share link L1 and Q
      When <step> cannot be secured
      Then Q is never booked for that request

      Examples:
        | step                         |
        | the capacity on L1           |
        | the funds hold (POL-15)      |

    @P2-S34 @need-P2-N7 @POL-28
    Scenario: A route with two legs on partners without holds is rejected before anything is held
      Given a route over Q and another partner link without holds
      When a buyer books the route
      Then the booking is rejected before anything is held, stating that a route may include at most one such leg

    @P2-S35 @need-P2-N7 @POL-28 @POL-23
    Scenario: A failure after the partner without holds was booked cancels it at Share's cost
      Given a route over Share link L1 and Q, and Q has been booked for a request
      When a later step of that request fails
      Then Share cancels the booking on Q, bearing its cost (POL-23)
      And the buyer is not charged for the failed request

    @P2-S96 @need-P2-N4 @need-P2-N7 @POL-02 @POL-05 @POL-28
    Scenario: A partner refusal caused by Share's own booking for an undecided request is contention: the refused request waits and asks again
      Given a request A of 8 Mbps over Share link L1 and Q for [10:00, 11:00) is pending, and Q has been booked for it (POL-28)
      And a buyer's booking B of 8 Mbps over Share link L2 and Q for [10:00, 11:00) is pending, with `wait` at its default
      When the partner says B's leg does not fit, while A's booking on Q overlaps B's window and A is not yet decided
      Then B is not rejected, and waits, pending, within its own deadline (POL-02)
      And if A then fails, once Share has cancelled A's booking on Q (POL-28), Share asks the partner for B's leg again, within B's deadline

    @P2-S36 @need-P2-N7 @POL-26 @POL-28
    Scenario: A partner whose holds are too short counts as a partner without holds
      Given partner link S holds capacity for less than `route_deadline_max` plus `commit_margin` (POL-26)
      When a buyer books a route over S and Q
      Then the booking is rejected before anything is held, stating that a route may include at most one leg without holds

    @P2-S102 @need-P2-N7 @POL-26 @POL-28
    Scenario: A partner that does not accept a hold expiry set by Share counts as a partner without holds
      Given partner link S holds capacity for at least `route_deadline_max` plus `commit_margin` (POL-26), but does not accept a hold expiry set by Share
      When a buyer books a route over S and Q
      Then the booking is rejected before anything is held, stating that a route may include at most one leg without holds

    @P2-S37 @need-P2-N7 @need-P2-N1 @POL-26 @POL-28
    Scenario: A route over two partners with holds of different lengths is all or nothing
      Given a route over partner links P1 and P2, whose holds last different lengths of time, each lasting at least `route_deadline_max` + `commit_margin` (70 s at the defaults)
      When the booking has its outcome
      Then it is confirmed on both or holds nothing on either

  Rule: Funds and limits are checked before a reservation is confirmed

    @P2-S38 @need-P2-N8 @POL-15 @POL-18 @POL-10 @POL-16
    Scenario Outline: A booking the account cannot fund is rejected, stating the payment needed
      Given <account>, which leaves a headroom of 0.200000 USD (POL-18)
      When the account books a reservation whose funds hold, or credit hold, would be 0.288000 USD (POL-15)
      Then the booking is rejected for insufficient funds, stating a payment of 0.088000 USD to be confirmed (the hold less the headroom), and of 1.088000 USD to also reach `low_balance_warning` (POL-10, POL-16)
      And nothing is held for it

      Examples:
        | account                                                                                                   |
        | a prepaid account with a ledger balance of 0.488000 USD and 0.288000 USD of funds held                     |
        | a credit-limit account with a `credit_limit` of 1.000000 USD, a ledger balance of -0.500000 USD and 0.300000 USD of credit holds |

    @P2-S39 @need-P2-N8 @POL-25 @POL-18
    Scenario Outline: A booking beyond an agent key's spending limit is rejected; key spending is counted over the period
      Given account "b1" has a headroom of 10.000000 USD
      And agent key K of "b1" has a `key_spend_limit` of 1.000000 USD per `key_spend_period` (POL-25: one calendar day, UTC)
      And K's only current reservation, an open-ended one booked in the previous period, has 0.288000 USD of funds held
      And K's reservations, including any that have ended, accrued <today> USD of charges in the current period and <before> USD in the previous one
      When K books a reservation whose funds hold would be 0.288000 USD
      Then K's spending is <spending> USD and its key headroom <headroom> USD
      And the booking is <outcome>

      Examples:
        | today    | before   | spending | headroom | outcome                                                           |
        | 0.000000 | 0.000000 | 0.288000 | 0.712000 | confirmed                                                         |
        | 0.072000 | 0.000000 | 0.360000 | 0.640000 | confirmed                                                         |
        | 0.072000 | 0.500000 | 0.360000 | 0.640000 | confirmed                                                         |
        | 0.500000 | 0.000000 | 0.788000 | 0.212000 | rejected, stating that the key's spending limit would be exceeded |

    @P2-S40 @need-P2-N8 @POL-25
    Scenario Outline: A booking beyond a limit on capacity in flight is rejected
      Given the Mbps in requests of the <holder> not yet decided is at its <limit> (POL-25)
      When the <holder> makes another booking
      Then the booking is rejected stating that the <holder>'s limit on capacity in flight is reached

      Examples:
        | holder    | limit                    |
        | agent key | `key_inflight_limit`     |
        | account   | `account_inflight_limit` |

    @P2-S54 @need-P2-N8 @POL-25
    Scenario: A new account can have capacity in flight up to account_inflight_floor
      Given an account with no confirmed reservation
      When it books 800 Mbps, within `account_inflight_floor` (POL-25 default 1,000 Mbps)
      Then the booking is not rejected for the account's limit on capacity in flight

    @P2-S66 @need-P2-N8 @POL-25
    Scenario: Capacity in flight is counted once per request, at its reserved rate, whatever the number of legs
      Given an account with no confirmed reservation and nothing in flight
      When it books a route of three legs at 1,000 Mbps
      Then the booking is not rejected for the account's limit on capacity in flight, which counts it as 1,000 Mbps

    @P2-S98 @need-P2-N8 @POL-25
    Scenario Outline: The account's limit on capacity in flight grows with its largest confirmed reservation
      Given an account whose largest confirmed reservation is 200 Mbps, so its `account_inflight_limit` is 2,000 Mbps, ten times that, above `account_inflight_floor` (POL-25)
      And it has <in flight> Mbps in requests not yet decided
      When it books <rate> Mbps
      Then the booking <result>

      Examples:
        | in flight | rate | result                                                                          | why                 |
        | 1,500     | 500  | is not rejected for the account's limit on capacity in flight                  | 1,500 + 500 = 2,000 |
        | 2,000     | 1    | is rejected stating that the account's limit on capacity in flight is reached | 2,000 + 1 > 2,000   |

    @P2-S41 @need-P2-N8 @POL-25
    Scenario Outline: Booking requests above a rate limit are not accepted, and the key may be used again
      Given the <holder> has reached its <limit> (POL-25)
      When it sends another booking request with a new idempotency key
      Then the submission is not accepted, stating the rate limit and when it may send again
      And no request is created, and the idempotency key may be used again

      Examples:
        | holder                                    | limit                                |
        | agent key                                 | `key_rate_limit` (50 requests/s)     |
        | account, across all its keys and users    | `account_rate_limit` (200 requests/s) |

    @P2-S67 @need-P2-N8 @POL-25
    Scenario: Status polls above key_poll_limit are not accepted
      Given an agent key has made 20 status polls in the current second, its `key_poll_limit` (POL-25)
      When it polls again
      Then the poll is not accepted, stating when it may poll again

    @P2-S68 @need-P2-N8 @POL-25
    Scenario Outline: Status polls do not count toward booking rate limits; retries do
      When an agent key sends <submission>
      Then it <counts> toward `key_rate_limit` and `account_rate_limit` (POL-25)

      Examples:
        | submission                                   | counts       |
        | a status poll                                | does not count |
        | a retry of a booking request with its key    | counts       |

    @P2-S42 @need-P2-N8 @POL-16 @POL-18
    Scenario: A suspended account cannot book, and is told the amount that would resume it
      Given account "b1" is suspended (POL-16), with one open-ended reservation whose full coverage hold is 0.288000 USD
      And "b1" has a ledger balance of 0.216000 USD, 0.216000 USD of funds held and no usage exposure
      When "b1" makes a booking
      Then the booking is rejected stating that the account is suspended
      And stating that a top-up of 1.072000 USD would resume it: 0.072000 USD to restore the full hold and 1.000000 USD to reach `low_balance_warning`

    @P2-S69 @need-P2-N8 @POL-16
    Scenario: A request not yet decided when its account is suspended is not confirmed
      Given a booking request of account "b1" is pending, its outcome not yet decided
      When "b1" is suspended before the request has its outcome
      Then the request is rejected, stating that the account is suspended and the resume amount (POL-16)
      And it holds nothing

    @P2-S70 @need-P2-N8 @POL-15 @POL-25 @POL-18
    Scenario: Concurrent bookings by one account are funded as if decided one at a time
      Given any number of booking requests by one account, from any of its users and agent keys, at the same time
      When every request has its outcome
      Then the holds of those confirmed never together exceeded the account's headroom
      And there is an order of the requests in which deciding them one at a time gives every one of them the same outcome

    @P2-S71 @need-P2-N8 @POL-25 @POL-18
    Scenario: Concurrent bookings by one agent key never together exceed its limits
      Given any number of booking requests by one agent key at the same time
      When every request has its outcome
      Then the holds of those confirmed never together exceeded the key's headroom
      And the key's capacity in flight never exceeded its `key_inflight_limit` (POL-25)

    @P2-S92 @need-P2-N8 @need-P2-N4 @POL-25 @POL-15 @POL-05 @POL-18
    Scenario: A request holds no capacity until its funds hold is taken
      Given a Share link L with a capacity of 10 Mbps and no reservations
      And account "b1" whose headroom does not cover the funds hold of a booking of 8 Mbps on L for [10:00, 11:00)
      When "b1" makes that booking, and at the same moment another buyer, whose headroom covers it, books 8 Mbps on L for the same window
      Then "b1"'s booking is rejected for insufficient funds, never having held capacity on L
      And the other buyer's booking is decided without waiting for "b1"'s

    @P2-S72 @need-P2-N8 @need-X1-N3 @POL-25
    Scenario: Revoking an agent key fails its pending requests and leaves its reservations with the account
      Given agent key K of account "b1" has a pending booking request and a confirmed reservation
      When an account administrator of "b1" revokes K
      Then the pending request fails with the reason "key revoked" and holds nothing
      And the confirmed reservation is unaffected and stays with "b1"

    @P2-S103 @need-P2-N8 @need-P2-N3 @need-P2-N2 @POL-04 @POL-16 @POL-25 @POL-08
    Scenario Outline: An event after a request's decision does not change its outcome, even while its status still reads pending
      Given a booking request of account "b1", sent with agent key K, has been decided confirmed
      And a status read of it still reports pending, within `status_staleness` (POL-04) of the decision
      When <event>
      Then the request stays confirmed
      And every status read of it from `status_staleness` after the decision reports confirmed

      Examples:
        | event                                               |
        | "b1" is suspended (POL-16)                          |
        | an account administrator of "b1" revokes K (POL-25) |
        | the buyer withdraws the request (POL-08)            |

  Rule: A route rejection says what the buyer can get instead on every leg

    Background:
      Given a route over Share links L1 and L2, each with a capacity of 10 Mbps
      And it is 09:00
      And L1 has a confirmed reservation of 7 Mbps for [10:00, 11:00)
      And L2 has a confirmed reservation of 8 Mbps for [11:00, 12:00)
      And apart from these, L1 and L2 have no reservations or capacity held

    @P2-S73 @need-P2-N11 @POL-10 @POL-09
    Scenario: A route counter-offer fits every leg, not only the blocking one
      When a buyer books the route at 5 Mbps for [10:00, 11:00)
      Then the booking is rejected naming L1 as the blocking link
      And stating that 3 Mbps is the largest rate that fits [10:00, 11:00) on every leg
      And stating that [12:00, 13:00) is the earliest one-hour window within the selling horizon that fits 5 Mbps on every leg

  Rule: A reservation is changed or ended as one unit, without risk to what the buyer already has

    Background:
      Given it is 10:00:30
      And a confirmed reservation R of 4 Mbps for [09:00, 18:00) on a route over Share links L1 and L2, each with a capacity of 10 Mbps
      And R's account is active, and its headroom and key headroom cover every change below unless the scenario says otherwise

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
    Scenario: An extension is decided against capacity for the added period only
      Given L2 has 3 Mbps confirmed for another buyer for [09:00, 18:00)
      And L2 has 6 Mbps confirmed for another buyer for [18:00, 20:00)
      When the account extends R to end at 20:00
      Then the extension is confirmed, and R ends at 20:00

    @P2-S46 @need-P2-N9 @POL-08
    Scenario: A rejected extension leaves the reservation as it was
      Given L2 has 8 Mbps confirmed for another buyer for [18:00, 20:00)
      When the account extends R to end at 20:00
      Then the extension is rejected naming L2
      And R is unchanged, at 4 Mbps for [09:00, 18:00)

    @P2-S47 @need-P2-N9 @POL-08
    Scenario: A rate increase is decided against capacity for the difference only, from the next minute boundary to the end
      Given L1 has 2 Mbps confirmed for another buyer for [09:00, 18:00)
      When the account increases R to 8 Mbps
      Then the increase is confirmed
      And R is 8 Mbps from 10:01 to 18:00, and 4 Mbps before 10:01

    @P2-S74 @need-P2-N9 @POL-08
    Scenario: A rejected rate increase leaves the reservation as it was
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
    Scenario: A change to part of a route is rejected
      When the account asks to cancel R on L2 only
      Then the change is rejected, stating that a route is changed or cancelled as one unit
      And R is unchanged

    @P2-S50 @need-P2-N9 @POL-08
    Scenario: A partner leg's minimum term and cancellation fee are shown at booking
      Given a route with a partner leg that imposes a minimum term and a cancellation fee
      When a buyer is shown the price of a booking on it
      Then the price shows the minimum term and the cancellation fee

    @P2-S75 @need-P2-N9 @need-P2-N8 @POL-08 @POL-15 @POL-10 @POL-01 @POL-16 @POL-18
    Scenario: An extension the account cannot fund is rejected, stating the payment needed, and the reservation is unchanged
      Given the route's `reservation_price` is 2 micro-USD per Mbps-minute
      And the account's headroom is 0.000500 USD
      When the account extends R to end at 20:00, whose added part needs a funds hold of 0.000960 USD (4 Mbps for 120 minutes)
      Then the extension is rejected for insufficient funds, stating a payment of 0.000460 USD to be confirmed, and of 1.000460 USD to also reach `low_balance_warning` (POL-10, POL-16)
      And R is unchanged, at 4 Mbps for [09:00, 18:00)

    @P2-S76 @need-P2-N9 @need-P2-N8 @POL-08 @POL-25 @POL-18
    Scenario: A change beyond the agent key's headroom is rejected and the reservation is unchanged
      Given the change is made by an agent key whose key headroom is less than the funds hold its added part needs
      When the key increases R to 8 Mbps
      Then the increase is rejected stating that the key's spending limit would be exceeded
      And R is unchanged

    @P2-S77 @need-P2-N9 @POL-08 @POL-16
    Scenario Outline: A suspended account can still reduce what it has
      Given R's account is suspended (POL-16)
      When the account <change>
      Then <result>

      Examples:
        | change                      | result                  |
        | cancels R                   | R ends at 10:01         |
        | shortens R to end at 12:00  | R ends at 12:00         |
        | decreases R to 1 Mbps       | R is 1 Mbps from 10:01  |

    @P2-S78 @need-P2-N9 @POL-08 @POL-16
    Scenario Outline: A suspended account cannot add to a reservation
      Given R's account is suspended (POL-16)
      When the account <change>
      Then the change is rejected, stating that the account is suspended and the resume amount
      And R is unchanged

      Examples:
        | change                     |
        | extends R to end at 20:00  |
        | increases R to 8 Mbps      |

    @P2-S79 @need-P2-N9 @POL-08
    Scenario: Concurrent changes to one reservation are applied one at a time, in arrival order
      Given any number of changes to R that do not end it, sent at the same time by different principals of the account
      When every change has its outcome
      Then each was decided against R as left by the change before it in arrival order
      And R ends in the state that applying them one at a time in that order gives

    @P2-S81 @need-P2-N9 @POL-08 @POL-05
    Scenario: A cancellation is never delayed by a pending change, which then fails
      Given an extension of R to 20:00 is pending, waiting for capacity in flight on L2
      When the account cancels R
      Then R ends at 10:01
      And the extension fails with the reason "reservation ended" and holds nothing

    @P2-S94 @need-P2-N9 @POL-08 @POL-05
    Scenario Outline: A shortening to the next minute boundary is a cancellation; any other shortening waits its turn
      Given an extension of R to 20:00 is pending, waiting for capacity in flight on L2
      When the account shortens R to end at <end>
      Then <result>

      Examples:
        | end   | result                                                                                                                  |
        | 10:01 | R ends at 10:01, as a cancellation, without waiting for the extension, which fails with the reason "reservation ended" and holds nothing |
        | 12:00 | the shortening is decided after the extension, in arrival order, against R as the extension leaves it, and R then ends at 12:00 |

    @P2-S80 @need-P2-N9 @POL-07 @POL-16 @POL-30
    Scenario Outline: A change still pending when its reservation is ended by Share is not confirmed
      Given an extension of R to 20:00 is pending
      When R is <ended> before the extension has its outcome
      Then the extension fails with the reason "reservation ended" and holds nothing
      And no capacity is confirmed for R after it ended

      Examples:
        | ended                                              |
        | revoked at the end of `revocation_notice` (POL-07) |
        | released at the end of `suspension_grace` (POL-16) |
        | terminated by Share (POL-30)                       |

    @P2-S82 @need-P2-N9 @need-P2-N7 @POL-08
    Scenario: A cancellation over a partner leg takes effect for the buyer whatever the partner answers
      Given a confirmed reservation R2 over Share link L1 and partner link P
      And the partner's API fails or times out when Share cancels the leg on P
      When the account cancels R2
      Then R2 ends at 10:01 on every leg, and its charges stop then (P3)
      And Share keeps cancelling the leg on P until the partner confirms, and its record of P is then reconciled with the partner's

    @P2-S83 @need-P2-N9 @need-P2-N1 @POL-08 @POL-28
    Scenario: An extension or increase over a partner leg is confirmed on every leg or leaves the reservation unchanged
      Given a confirmed reservation R2 over Share link L1 and partner link P
      When the account extends or increases R2, and any step on any leg fails
      Then the change is either confirmed on L1 and P, or R2 is unchanged on both

    @P2-S84 @need-P2-N9 @POL-08 @POL-09
    Scenario Outline: Renewals, short shortenings and extensions past the horizon follow the change rules
      When the account <change>
      Then <result>

      Examples:
        | change                                        | result                                                                       |
        | renews R for two more hours                   | the renewal is decided as an extension of R to 20:00, against capacity for [18:00, 20:00) only |
        | shortens R to end at 10:01                    | R ends at 10:01, as a cancellation                                           |
        | shortens R to end at 10:00                    | R ends at 10:01, as a cancellation from the next minute boundary             |
        | extends R to end beyond the selling horizon   | the change is invalid, and R is unchanged                                    |
        | makes R open-ended                            | it is decided as an extension of R from 18:00, against capacity for the added part only |

    @P2-S85 @need-P2-N9 @POL-08
    Scenario Outline: An open-ended reservation can be given an end, or cancelled before it starts
      Given a confirmed open-ended reservation R3 of 4 Mbps on L1 and L2 from 12:00
      When the account <change>
      Then <result>

      Examples:
        | change                     | result                                                        |
        | sets R3 to end at 14:00    | R3 ends at 14:00, as a shortening                              |
        | cancels R3                 | R3 is cancelled from 10:01, before it starts, and never accrues |

  Rule: Operations can see requests in trouble

    @P2-S51 @need-P2-N10
    Scenario: A failed request is visible to operations with its reason
      Given a booking request that failed
      When operations looks for requests in trouble
      Then the request is listed with its reason and the leg concerned

    @P2-S53 @need-P2-N10 @need-P2-N3 @POL-26
    Scenario: A request still pending at its deadline raises an operational alert
      When a booking request's deadline arrives while it is still pending (POL-26)
      Then operations is alerted, with the request, the leg concerned and how long it has been pending
