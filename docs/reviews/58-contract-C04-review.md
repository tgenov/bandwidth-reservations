# Review 58. Re-review of contract C04 (reservation feeds), version 2

| | |
|---|---|
| Under review | [C04](../04-delivery/contracts/C04-reservation-feeds.md), version 2 (draft, commit c540ea2). Mode: contract. Focus: money and concurrency |
| Review record | [Review 43](43-contract-C04-review.md) (REJECT: B-01, M-01 … M-07, m-01 … m-15, D-1 … D-6, RQ-1, RQ-2, AI-43-1 … AI-43-3) |
| Authority | `requirements-v1.10` (POL-07, POL-08, POL-16, POL-23, POL-28, POL-30; the scenarios C04 cites). RFC-000 rev. 4.4 §8 rows "Request outcome feed", "Reservation lifecycle feed", "Reservation command port", and errata C4-1 … C4-7 |
| Contract sections read | RFC-002 rev. 5 (§1.3 `nb`, §2.2 E11, §9.4, §9.6, §9.7). C01 draft 1 (§2.5 headers and `ReportMarker`, §3.1 acquisition, §3.4 report position, §3.5 gate, §5 idempotency). C02 1.0.0-draft.2 (`cut_target` case table, idempotency row). C03 v2.1 (rule 3, rule 5, CT-3.7). [Review 52](52-contract-C03-fix-verification.md) (V52-1, V52-2) |
| Binding inputs | The orchestrator accepts release lateness `nb(ts) − nb(grace_end)` (m-01 deviation). The `ReportMarker` extension is owed by C01. Both are applied as given |
| Tools | `python3 tools/check_specs.py`: no problems (473 scenarios). `python3 tools/impact.py coverage C04`: not a slice (contracts are not in `slices.json`), so it does not apply. Every scenario ID C04 cites exists (checked with `rg` against the feature files) |

## Verdict

**ACCEPT WITH CHANGES.** The review finds 0 Blockers, 3 Majors and 9 Minors.

All 23 findings and the 6 decisions of review 43 are resolved as the resolution table
states (see [Verification of review 43](#verification-of-review-43)). The cut-revision text
matches C03 v2.1 rule 3 and review 52 V52-1 (4) and V52-2 word for word.

There are three new Majors:

- **N-01.** The B-01 mechanism depends on the notifier receiving the first covering
  marker. C01's consumer runtime drops any marker at or below the last one it has seen. A
  republished or relayed predecessor marker that arrives after the new holder's marker is
  therefore dropped, and the webhook is lost.
- **N-02.** `prevReportPosition` after `adopt` takes the value from the source slot's
  chain, which corrupts the "first covering marker" test in the destination slot.
- **N-03.** An offer-scoped target that arrives once the offer is Final with
  `move_at > t_eff` is never applied by C04. C02 answers `APPLIED` for it. The holder is
  billed at the uncut rate.

Each fix is a local edit of a few lines in C04, plus one C01 erratum line. No re-review
round is needed if the fixes are applied as proposed. A fix verification is enough.

### Traces run

1. **B-01 trace 1 (pending at 180 ms, reportable at 185 ms).**
   - E5 commits with `answered_pending = false`.
   - `pending` is sent at 180 ms.
   - The report position passes at 185 ms. The next marker, M1 (`prev` < `ts(E5)` ≤
     `rp`), lists q.
   - The notifier holds q under the gate and waits for M1, which lists q, so the webhook
     is sent.
   - **Passes.**
2. **B-01 trace 2 (crash after `pending`, before the marker commits).**
   - `owner_slot.report_through` is still below `ts(E5)`.
   - The new holder's first marker lists every covered event above it, q included.
   - **Passes** (an extra webhook at most).
3. **Trace 2 variant: the marker commits, then the holder dies before the direct
   publish.**
   - The predecessor A commits M1 (`rp = P1`, lists q) and dies before publishing it.
   - The new holder B has `prev = P1`. It writes M_B (`prev` P1, `rp` P2) after
     `read_lease` + ε (500 ms) and publishes it directly.
   - A's rows, M1 included, reach Kafka by takeover republish (up to 30 s of rows at
     5,000 rows/s, C01 §3.5) or by the relay (seconds). Either way, M1 can land **after**
     M_B on the slot's Kafka partition.
   - C01 §5: a report marker "at or below the last" is ignored. M1 is dropped.
   - q passes the gate on M_B. With `answered_pending = false`, the first covering marker
     never reaches the notifier.
   - Result: no webhook, or a wait with no end. **Fails P2-S09 (N-01).** The same happens
     whenever an idempotent producer gives up on M1 and still delivers M2 directly.
4. **`adopt` of partition X from slot A into slot B.**
   - Slot B's last marker is at `rp` 100. A's last `report_through` is 150.
   - C04 sets B's next marker `prev` = 150. A B-slot event q at `ts` 120, answered
     `pending`, is first covered by that marker. The notifier, though, reads `prev` 150 ≥
     120 and waits for an earlier "first" marker that does not exist.
   - With A's position below B's, the marker relists events B already reported, which
     sends unpromised webhooks.
   - **Fails P2-S09 (N-02).**
5. **Late acceptance with `move_at > t_eff`.**
   - The offer is accepted after the `ReductionEffective` entry, so C03 sends an
     offer-scoped target.
   - The move becomes Final, writing `moved` at the full rate (the target is not yet
     recorded), with `move_at` = `t_eff` + 5 min.
   - The offer-scoped target arrives. C04's Cut section gives `offer_cut_kept` ("any other
     offer-scoped target is applied, if ever, only in `moved`"). `moved` is already
     written, so the cut is never applied.
   - C02's row "`offer` set, offer Final to this link → applied as a normal cut →
     `APPLIED`" disagrees, and so does C04's own "Move and cuts" bullet (a cut from
     `max(t_eff, move_at)`).
   - Result: rating accrues the full rate from `move_at` on capacity the link cut, against
     POL-07 and POL-23. **N-03.**
6. **Cut revisions** (PL-3 sequence: 1, 2 equal, 3, then a relayed 1, then a mismatch).
   - Three `cut` events.
   - `hold_2` releases at revision 3.
   - The stale revision 1 writes nothing.
   - **Passes**, and matches C03 rule 3.
7. **Release after grace.**
   - `nb` is strictly-next (RFC-002 §1.3). With `grace_end` = 10:00:00.000,
     `nb(grace_end)` = 10:01.
   - F7 at 10:00:00.3 gives `nb(ts)` = 10:01 and `delay_min` = 0.
   - F7 at 10:01:00.2 gives `delay_min` = 1, which is alerted.
   - The "0 within the minute containing `grace_end`" claim holds. The extra minute
     10:00 to 10:01 is accrued, which is the accepted deviation.
8. **`terminate`, reply lost, and the retry arrives after `not_after`.**
   - The identity lookup comes first, so the retry returns `TERMINATED`. **Passes.**
   - But C04 also says the console stops retrying at `not_after` − ε (N-08).
9. **Withheld termination with an Accepted offer, a queued extension, and a decrease
   decided by E11 whose E12 commits after the termination.**
   - Every event the termination causes carries `withheld_by`.
   - The decrease's outcome (E12) is not caused by the termination and reveals nothing
     about it.
   - **Passes.**
10. **Fees.**
    - Shorten into a minimum term (fee F), then the window ends inside it: F is due once.
      **Passes.**
    - A leg with both a plain fee and a minimum term (P2-S50): two `ShownFee`s share one
      `fee_id` (N-05).
11. **Window-end deferral.** PL-8 re-traced. **Passes.** A cancel arriving between the old
    window end and the renewal's decision ends the reservation at `nb(ts)` and fails the
    renewal. No part covers the gap, so nothing accrues. Acceptable.

## Verification of review 43

| ID | Result | Notes |
|---|---|---|
| B-01 | Resolved in design; **N-01 and N-02 found** | The marker field, the atomic `pending`/final decision, the takeover listing and the notifier rule are present in the schema, Semantics, PO-5, CN-1 and the errata. Its safety depends on the notifier seeing the first covering marker, which C01's marker idempotency prevents (N-01). The `adopt` wording is wrong (N-02) |
| M-01 | Verified | Reporting-entry table, PO-1 and the RFC-002 §8 erratum |
| M-02 | Verified | The text matches C03 v2.1 rule 3 and V52-1 (4) verbatim. Idempotency key includes `target_revision`. PL-3 and CR-2 updated |
| M-03 | Verified | `Moved.fees_due` with payer `share`. `fee_id` includes the path. PL-5, CR-4. See N-05 for a remaining collision inside one leg |
| M-04 | Verified | `withheld_by` on `PayloadBase`, PC-5, CN-2 |
| M-05 | Verified | `CommandEnvelope` identity, lookup before the checks, audit-only refusals, full `RoutingRefusal`. See N-09 for binding the identity to the envelope |
| M-06 | Verified | Three exceptions listed in Effective minutes, the guarantee, PL-6 and the RFC-003 erratum |
| M-07 | Verified | Deferral, PL-8, MM-5 |
| m-01 | Verified (accepted deviation) | Arithmetic re-checked in trace 7 |
| m-02 | Verified | C01 names and types used. Headers carry `report_through` |
| m-03 | Verified | C01 rule plus rating stops the partition, with a C01 erratum |
| m-04 | Verified | "New identity" wording |
| m-05 … m-08 | Verified | — |
| m-09 | Verified | RFC-004 and C05 rows. C05 is frozen at version 1, so the C05 row must go into its errata list (Decision D58-4) |
| m-10 … m-14 | Verified | — |
| m-15 | **Partly (N-04)** | "Last E11" leaves out E5 additions and the confirming E5, and PC-6 contradicts it |
| D-1 … D-6 | Verified | — |
| RQ-1, RQ-2, AI-43-1 … AI-43-3 | Carried as obligations | — |

V52-1 and V52-2 cross-check:

- C04 "Cut", the idempotency row, PL-3 and MM-3 carry the review 52 text.
- C02's case table still reads "offer Final to this link" **without** the `move_at ≤
  T_eff` condition, and the new-revision row is worded as V52-1 (3) requires. The
  narrower C04/C03 wording is the source of N-03.

## Findings

| ID | Severity | Location | Finding | Proposed change |
|---|---|---|---|---|
| N-01 | **Major** | Semantics "Webhooks and `pending`" (notifier rule, "whichever path brings it"); CN-1; Consumer obligations C01 row | C01 §5 makes a report marker idempotent by "(slot, position): ignored at or below the last", and C01 §3.5's `subscribe` applies that rule. The notifier rule needs the **first** covering marker, which can arrive after a later marker: after a takeover (the predecessor's committed but unpublished marker comes by republish or relay after the new holder's direct marker, trace 3), or when a direct publish of M1 fails and M2 succeeds. The runtime drops M1, so a buyer answered `pending` gets no webhook (P2-S09), or the notifier waits with no end. CN-1 states the intent, but no C01 erratum makes it possible | (a) C04: "For `account.outcome.v1` the notifier keeps every marker by (slot, epoch, `reportPosition`). The monotone drop applies only to the `reported` gate, never to `pending_answered`." (b) C01 erratum: §5 report-marker row, "ignored at or below the last **for the gate**; delivered to a marker handler regardless (outcome feed)". (c) CN-1: add the order M2 before M1 (relay or republish), which still gives exactly one webhook. (d) Notifier liveness: if the first covering marker is absent after `gap_timeout`, read it from the outbox or history like a feed gap (C01 §3.5). If it is still unobtainable, send the webhook (err towards an extra one) |
| N-02 | **Major** | Semantics "Markers" (`prevReportPosition` after `adopt`); "Webhooks and `pending`" (first marker after `adopt` lists everything); PO-3 | Markers are per **slot**. On `adopt`, the destination slot B keeps its holder and its own chain. C04 sets B's next `prev` to the **source** slot's `report_through`, which mixes two chains. If A's position is higher, B-slot events between the two are never seen as "first covered", and webhooks are missed (trace 4). If it is lower, events already reported are relisted, and unpromised webhooks go out. Listing every covered event is also unnecessary on `adopt`: C01's report fence (step 4) covers all of X's pre-move events in A's chain, and B knows its own `pending` answers | Delete "or `adopt`" from both bullets and from PO-3. `prevReportPosition` is always the previous marker of the **same slot** (`report_through` on that slot's partition `''`). The listing of every covered event applies only after an acquisition (expiry, handoff, re-home, resume). Add a PO-3 case: an `adopt` leaves B's chain contiguous and lists only `pending`-answered requests |
| N-03 | **Major** | Semantics "Cut" (offer-scoped targets) and "Move and cuts"; `OfferCutKept` comment; entry table row "E13 offer-scoped target"; PL-3; MM-3 | C04 applies an offer-scoped target as a `cut` only when the offer is Final **and `move_at ≤ t_eff`**. Every other one becomes `offer_cut_kept`, "applied, if ever, only in `moved`". For an offer made Final before its target arrives with `move_at > t_eff` (trace 5), `moved` is already written, so the cut is never applied. The holder is billed the uncut rate from `move_at` for capacity the link cut (POL-07; an overcharge needing a later correction under POL-23). The account owner's leg state also disagrees with the link's. C02 answers `APPLIED` for "offer Final to this link" whatever `move_at` is, and C04's own "Move and cuts" bullet says a later target lowers the moved parts from `max(t_eff, move_at)`. The two contracts give contradictory reported outcomes (C02 `APPLIED` against no `cut`). The `move_at ≤ t_eff` condition came from C03's R39-03 (b) case, but it is not the full rule | Replace the condition with: "an offer-scoped target whose offer is **Final and whose new path includes the link** is applied as a normal cut and emitted as `cut`, effective from `max(t_eff, move_at)`. One whose offer is not yet Final gives `offer_cut_kept`. One whose offer ended without moving to this link writes no lifecycle event (C02 `NOT_APPLIED(ended)`)." Apply this to Cut, the entry table, `OfferCutKept`, PL-3 and MM-3. Add a PL-4 case for `move_at > t_eff`. Ask C03 to widen rule 5's wording and CT-3.7 the same way (a C03 v2.1 erratum, wording only, because rule 4 holds nothing for offer-scoped targets) |
| N-04 | Minor | `OperatorEnvelope.target_version`; Semantics `terminate` check 6; PC-6 | It is defined as the "`Seq` of the reservation's last **E11** that changed its parts, window or legs". An addition is an **E5** (`part_added`), and a never-changed reservation has no E11, so check 6 is undefined for it. PC-6 says an addition bumps it. It is also unclear whether a cut E11 that changes nothing (`APPLIED(none)`, `not_applied`) bumps it | "`Seq` of the reservation's last entry that changed its parts, rates, window or legs: the confirming E5, an addition's E5, or such an E11. A cut E11 with `part_rates: []` does not bump it." Align PC-6 |
| N-05 | Minor | `FeeId`; `Leg.shown_fees: ShownFee[]`; Idempotency row "Fee" | `fee_id` is per leg, but a leg carries an array of shown fees. P2-S50 shows a leg imposing "a minimum term and a cancellation fee". Two fees on one leg share an ID, and "charged at most once per `fee_id`" drops the second, so the partner's fee goes unrecorded | Either `fee_id = "<reservation>/<path>/<leg index>/<kind>"`, or state "at most one `ShownFee` per leg" (a minimum term is itself charged as the cancellation fee, P3-S43) and type it `ShownFee \| null`. The second option is preferred (Decision D58-2) |
| N-06 | Minor | Semantics `terminate` "makes the shown fees due"; Release after grace "fees due" | Read literally, every shown fee becomes due, including a minimum-term fee whose term ended before termination. POL-08 and P3-S43 (31 days → no fee) make a minimum-term fee due only for an end inside the term | "makes due the fees POL-08 makes due for a cancellation at `effective` (the plain fee; a minimum-term fee only when `effective` < `term_end`), paid by the buyer". Same wording for release. Add the "after `term_end`" case to PC-4 and PL-5 |
| N-07 | Minor | Effective minutes, case 2; `Ended` | `ended(revoked)` is effective at the first all-zero minute. That minute can be **after** `nb(ts)` (one part kept until its end, later parts cut to 0). Until then the reservation still accrues. Whether the buyer may cancel earlier (POL-08's "absolute" right to stop paying at the next minute) is unstated, and if they do, the feed carries two `ended` events, whose precedence for rating is undefined | State it: a later ending change with an earlier effective minute is allowed and writes a second `ended`. Rating ends accrual at the **least** `ended.effective`, and fees follow the cause that took effect (a cut-affected cancel: Share). Add a CR case. Alternatively, write `shortened` and keep `ended(revoked)` for the all-zero-from-`t_eff` case |
| N-08 | Minor | Timeouts `terminate` row; Delivery table | "The console retries … until `not_after` − ε". A console that is still unanswered at that point has no outcome, even though the termination may have committed (Ambiguous or owner down). That leaves the console and audit unknown or contradictory. The lookup-first rule already makes a late retry safe | "The console retries with the same identity until it has an answer. A retry after `not_after` gets the recorded answer, or `REFUSED(not_after)`, which is then recorded." Add it to CC-1 |
| N-09 | Minor (security) | Semantics `terminate` "Identity" | Nothing binds `CommandEnvelope.identity` to the envelope's (`target.account`, `action_id`). A compromised or buggy console can send action Y's envelope under identity "A/X". The answer is then recorded under X, and X is permanently `REFUSED(digest)`. A compliance termination's `action_id` can be burned this way (denial of a four-eyes action) | The owner derives the identity from the envelope, or refuses with `REFUSED(digest)` **without recording** when `identity ≠ "<target.account>/<action_id>"` |
| N-10 | Minor | Semantics `terminate` step 2 and "REFUSED … recorded" | The refusal is recorded permanently for every check. If `operator_check` (C15) or assertion verification depends on a reachable identity service, a transient failure becomes a permanent refusal of a 72-hour four-eyes action | Transient check failures answer `ROUTING(UNAVAILABLE)` and are **not** recorded. Only definitive failures are recorded. State which checks can be transient |
| N-11 | Minor | "Holder notices" (`offer_*`); entry table row "E13 offer-scoped target" | `offer_*` also matches `offer_cut_kept`. C02 says the holder is told on `KEPT_FOR_OFFER`, but `OfferNotice.kind` does not include `offer_cut_kept`, so whether the notifier tells the holder is ambiguous | List the notice kinds explicitly. `offer_cut_kept` is a holder notice (C02: "the holder is told"). Add it to CN-3 |
| N-12 | Minor | `ReportMarker.pending_answered`; obligations "Sizing unchanged" | The list has no size bound. After an acquisition, or with readers stalled (exactly when `pending` is sent), it can hold thousands of `RequestId`s. For example, 5 s at 1,000 requests/s per slot (est.) at about 40 B each is about 200 KB, approaching Kafka's 1 MB default. "RFC-006 sizing unchanged" is an unmarked estimate | Cap one marker at N ids (for example 5,000, est.). Chunk overflow into consecutive markers with the same `reportPosition` and a `part`/`last` pair, and have the notifier treat the set as one marker. Mark the sizing claim (est.) |

Arithmetic and estimates:

- The 20 ms marker, the 2 s per-call deadline, the 2 to 3 s closure lag and the 1 s first
  webhook attempt are marked (est.).
- 60 s, 24 h, 25 h and 7 years match the register and RFC-006.
- The `delay_min` worked cases are re-derived in trace 7 and are correct.
- There are no money worked examples. Units (micro-USD strings, pico-USD per
  Mbps-minute) match RFC-003 §2.

Over-engineering: none material. `prevReportPosition` is needed for the first-covering
test. Recording audit-only refusals is cheap.

## Decisions taken

| # | Decision | Balance |
|---|---|---|
| D58-1 (N-01) | When the first covering marker cannot be obtained, the notifier sends the webhook | Buyers and agents never miss a promised outcome. An extra webhook is idempotent by `request` at the receiver |
| D58-2 (N-05) | At most one shown fee per leg. A minimum term is charged as that leg's cancellation fee | Matches P3-S43/S63/S74. Keeps `fee_id` stable and partners paid exactly |
| D58-3 (N-07) | A buyer may cancel a reservation whose revocation is scheduled later. Accrual ends at the earliest `ended.effective`, and Share pays the fee | Honours POL-08's absolute exit and POL-07's free exit after a cut |
| D58-4 (m-09) | C05 is frozen, so the C05 row stays an erratum owed against C05 version 1 (a C05 1.1), not a precondition for freezing C04 | Avoids blocking C04 on a frozen neighbour |

## Requirements issues

None new. RQ-1 and RQ-2 (review 43) remain open with the requirements owner.

## Architecture issues

| ID | Issue | Proposed amendment (RFC-000 §8) |
|---|---|---|
| AI-58-1 | The "Request outcome feed" row (as amended by AI-43-1) does not say that markers are delivered to the notifier in full, without the gate's monotone drop | Add "markers listing `pending`-answered requests are each delivered to the notifier; the gate's monotonicity applies only to the gate" |

## Errata to add to C04's obligations table

- **C01:** §5 report-marker row and §3.5 marker delivery (N-01).
- **C02:** none needed if N-03 is fixed as proposed. C02's row already matches.
- **C03 v2.1:** rule 5 and CT-3.7 wording widened to "Final, link on the new path" (N-03).
- **RFC-002 §9.4:** the `target_version` definition (N-04), identity binding and transient
  checks (N-09, N-10).
