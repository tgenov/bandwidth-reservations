# 54. Contract re-review: C02 link hold (draft.2)

Date: 2026-10-12. Mode: contract. Focus: concurrency.
Under review: `docs/04-delivery/contracts/C02-link-hold.md` version 1.0.0-draft.2, which
follows [review 42](42-contract-C02-review.md) (REJECT of draft.1).
Authority: `requirements-v1.10` (P1, P2 features, policy register). RFC-000 revision 4.4
§8: the rows for the link hold port, link waiting port, outcome and expiry port, link
availability query, link displacement read and reservation command port, plus "Revision 4.4
errata" C4-1 to C4-7. Contract sections only of RFC-001 rev. 5 (§11) and RFC-002 rev. 5
(§13, with §2.2 E3, §5.7 and §9.2/§9.3 where §13 points to them). For the revision rule's
cross-check: C03 v2.1 (rule 3, V52-1, V52-2) and C04 v2 ("Cut", PL-3, PL-4).

Tools:
- `tools/check_specs.py`: NO PROBLEMS (473 scenarios).
- `tools/impact.py coverage S-LINK`: primary 84, uncited 1 (**P1-S84**), dangling 0.
- Every P1, P2 and POL ID that C02 cites exists at `requirements-v1.10`.

## Verdict

**REJECT** (draft.2). There is 1 Blocker, 5 Majors and 8 Minors.

Review 42's findings are applied as the "Review 42 resolution" table states (see
"Review 42 findings: status"). Two are only partly closed:
- B1's sequencing rule leaves `convert` and `offer_move_at` out of the per-leg order.
- M1's yield claims still lose a re-ask in one ordering.

The new Blocker is in B1's own family. On every leg, `convert` creates parts, but it is
not in the one-outstanding-change sequence. So an `end_leg` or `reduce_parts` that
overtakes a delayed `convert` is lost, and the part `convert` then creates is never
ended. This happens on an ordinary "confirm, then cancel at once" (common for AI agents)
and on P2-S94 row 2. The capacity is stranded until the part's window ends, or for ever
for an open-ended part. The buyer is meanwhile told the capacity is free.

The other issues:
- the sending rule does not say which leg-change errors count as answered, so a queue can
  stall;
- `STALE_CHANGE` is reachable after every account-owner takeover, so "a defect" pages on
  routine deploys;
- a yield re-ask can be lost when the waiting mark arrives before the refusal;
- the revision rule is undefined when covered parts change, which C03 allows;
- C02's "offer Final" row disagrees with C03 V52-2 and C04.

No path to **oversell** was found. Every lost or reordered message lowers occupancy late
or never, and never raises it above `C_ref`.

## Review 42 findings: status

| Finding | Status in draft.2 |
|---|---|
| B1 | Resolved for `end_leg`/`reduce_parts`. **Incomplete**: `convert` and `offer_move_at` are outside the sequence (new B1). Contradiction with the idempotency row (new M2) |
| M1 | Applied. One ordering still loses the re-ask (new M3). Claims on ended attempts are not closed (m1) |
| M2 | Applied. Batch replies cannot carry a per-target `Moved` or generation (m3) |
| M3 | Applied. The `UNKNOWN_*`-while-unanswered branch is unreachable under the rule; harmless (part of M1) |
| M4 | Applied. A late `offer_hold` after the tombstone expires is not refused (m4) |
| M5, M7, m2, m4 to m12 | Resolved |
| M6 | Applied. Two errata are missing (m5) |
| m1 | Resolved in C02. RFC-002 §13.2's "a marker for an earlier attempt is ignored" is not listed as an erratum (m5) |
| m3 | Resolved. A `cut_target` `MISMATCH` stalls `REDUCTION_FINAL` (m7) |
| R39-01 | Applied in substance. V52-1's text is not verbatim (m6). V52-2 is not applied (M5) |

## Findings

| ID | Sev | Location | Finding | Proposed change |
|---|---|---|---|---|
| B1 | **Blocker** | Leg-change sequencing (sending rule); Link hold port `convert`, `end_leg`, `offer_move_at`; Delivery row 1; RFC-002 §5.7 (`convert` acknowledgements in memory, no entry) and §9.2 (the next change starts once the previous one is decided) | **`convert` creates parts on a leg but is not sequenced with that leg's changes, so a later `end_leg` or `reduce_parts` can be lost for good.** Trace A (P2-S43, an AI agent books and then cancels at once):<br>1. E5 commits for R, and `convert(p1)` to L meets `Moving` or `UNAVAILABLE`.<br>2. The cancel's E11 sends `end_leg(L, from nb(ts))`. Nothing is outstanding on (R, L), because `convert` is not a leg change, so it is sent at once and reaches L first.<br>3. L does not know R yet: `UNKNOWN_RESERVATION`, "a violation, alerted". The consumer's action is undefined (M1), and either way the change has had no effect.<br>4. `convert` arrives, and p1 becomes committed for its whole window.<br>5. E12 completes, so the buyer is told the capacity is free from 10:01. L still counts p1 until the window ends, or for ever if R is open-ended.<br>Trace B (P2-S94 row 2): an extension's E5 adds p3 `[18:00, 20:00)`, and its `convert` is delayed. The queued shorten's `end_leg(from 12:00)` overtakes it and ends p1 and p2. Then `convert` creates p3, and `[18:00, 20:00)` stays held on L while R is reported ended at 12:00 (P2-S44). With "make open-ended" (P2-S46), p3 is held for ever.<br>Trace C (P2-S48): an increase's `convert(p3)` is delayed, and the queued decrease's `reduce_parts(p3: …)` gets `UNKNOWN_PART`. The decrease is lost.<br>The same gap applies to **`offer_move_at`** on a new leg. Sent while `offer_accept` is unanswered, it can arrive first and fail (`UNKNOWN_OFFER`/`INVALID`). The old leg ends at T but the new leg starts at the old `move_at`, so the buyer is told it moved at T and has a gap on the new path.<br>After a takeover, the order between the "conversions pending" re-sends and the E11 re-sends is not stated either | Extend the sending rule. **"Per (reservation, leg), the sequence is: the `convert` that creates each of the leg's parts (the booking's, and every added part's), `offer_accept` on a new leg, then `end_leg`, `reduce_parts` and `offer_move_at` in change-id order. Each is sent only after the previous one is answered."** After a takeover, the new holder re-sends that leg's pending `convert`s before its E11s. Link backstop: a `convert` for a reservation whose leg already has an applied `end_leg` clips the new part to that end and alerts `CONVERT_AFTER_END`. Tests:<br>- consumer: "no leg change for (R, L) is sent while a `convert` on L for R is unanswered, including across a takeover";<br>- joint: "confirm, then cancel, with `convert` answered `Moving`: L ends p1 at 10:01";<br>- joint: P2-S94 row 2 with a delayed `convert`.<br>Erratum: RFC-002 §5.7, §9.7, §12.1. Architecture issue AI-54-1 |
| M1 | Major | Leg-change sequencing, "answered: `CHANGED`, a counted-as-answered error, or `STALE_CHANGE`"; `LegChangeReply`; Timeouts M3 row | **Which leg-change replies count as answered is not stated, so a leg's queue can stall, or a change can be dropped silently.** Counted as answered today: `CHANGED`, `STALE_CHANGE`, `UNKNOWN_LINK`/`LINK_RETIRED`, and `UNKNOWN_*` after `ACCEPTED` on a move. Not classified: `UNKNOWN_RESERVATION` and `UNKNOWN_PART` outside a move, `UNKNOWN_REDUCTION`, `INVALID(applies)`, `MISMATCH` (Common rules define `MISMATCH` only "for a request"), and `UNKNOWN_OFFER`/`INVALID` on `offer_accept` and `offer_move_at`. If they are retried, the queue for (R, L) is stuck for ever. A later cancel's `end_leg` is never sent, E12 never commits, and the cancel is never reported, which breaks P2-S81's "never delayed". If they are dropped, the change is lost without trace. The M3 row's "while that leg's `offer_accept` is unanswered" branch cannot happen under the rule; it confuses implementers | Add a reply table for leg changes and offer commands. Each row says "retry" (common re-route errors, `UNAVAILABLE`, `Moving`, `Stopped`) or "**answered, alerted as a defect, change counted for E12**" (every other error). After B1, `UNKNOWN_*` is reachable only by a defect. Delete the unreachable M3 branch. Test: "every error variant moves the queue on" |
| M2 | Major | Leg-change sequencing "`STALE_CHANGE` now signals a defect … a correct sender never meets it"; Link rule; Idempotency row `end_leg`/`reduce_parts` ("(link, change id) → the recorded reply"); provider test 6 | **`STALE_CHANGE` is reachable without a defect after every account-owner takeover, and the contract says two things about a lower duplicate.** Trace:<br>1. E11a (seq 100) touches legs L1 and L2. L1 answers `CHANGED`; L2's reply is lost.<br>2. Under the rule, E11b (seq 101) is then sent to L1 and applied there.<br>3. The holder is replaced. E11a has no E12, so the new holder re-sends E11a to L1, as "per leg in change-id order" requires.<br>4. L1's highest applied id is 101, so it answers `STALE_CHANGE`, and the account owner pages "protocol defect".<br>Account partitions change holders on every deploy, so the page is routine noise that hides real defects. The Idempotency row says a duplicate (link, change id) gets "the recorded reply", but the Link rule gives `STALE_CHANGE` to any lower id. The order of the two checks is undefined, and test 6 asserts the second | The link keeps the reply of **every** applied change id per (reservation, leg), not only the highest. A leg's changes are few and its life is bounded. Order of checks: (1) an id already applied gets its recorded reply, or `MISMATCH` if the body differs; (2) a lower, never-applied id gets `STALE_CHANGE`, which is now truly a defect. Fix test 6 and the RFC-001 §11.1 erratum to match. Cheaper alternative: the account owner does not alert `STALE_CHANGE` on a post-takeover re-send. Weaker: it hides a real loss in the same window |
| M3 | Major | Link waiting port, `YIELD_REQUEST` ("asks again with a new claim after a refusal, when a waiting hint for the holder arrives"); `mark_waiting`; provider test 5 | **The re-ask is lost when the waiting mark reaches the link before the refusal (POL-02 liveness).** Trace (P2-S19, review 42's RQ-42-2 case):<br>1. Y holds L2 and is Holding. L2 raises claim c1 for older X.<br>2. The account owner, with Y not Waiting, sends `yield_refuse(c1)`.<br>3. Y then starts waiting on another link (E2) and sends `mark_waiting(true)` to L2.<br>4. `mark_waiting` reaches L2 **first** (another call, or `yield_refuse` met `Moving`). c1 is still outstanding, so the link raises no new claim.<br>5. `yield_refuse(c1)` arrives and ends c1. No new hint follows, so no re-ask is made.<br>6. X waits until a deadline, and the crossing is broken only by expiry. X can lose to the younger Y, which breaks POL-02 and P2-S19's "A is confirmed before either deadline".<br>Test 5 covers only the order refuse, then mark | Rule: **"When the link records a refusal, it raises a new claim at once if the holder's mark is set and an older waiter is still blocked by that holder attempt."** This terminates: while the account owner is Waiting it accepts, and while it is not, its `mark_waiting(false)` (a position-ordered command) clears the mark. Add the reverse order to provider test 5 and to the joint P2-S19/P2-S87 test |
| M4 | Major | `CutTarget.parts` and `revision`; Semantics "Revisions"; case table row 3; C03 R39-01 (c) ("a revision ≥ 2 … or its covered parts changed"); RFC-000 §8 ("a part converted later … is neither counted nor capped") | **The revision rule is undefined when two revisions of one key cover different parts, and C03 explicitly allows that.** The account owner takes the per-minute `min` of the key's targets, and ignores and alerts a piece above the recorded target. Both compare rates over **different part sets**. Example:<br>- Rev 1 covers {p1} at 2 Mbps (p1 was 5).<br>- After T_eff, an increase p3 of 3 Mbps is admitted against the reduced capacity.<br>- An extension issues rev 2 at its own deciding entry, covering {p1, p3} at 4 Mbps (p1 to 1, p3 kept at 3).<br>- 4 > 2, so rev 2 is "ignored and alerted", and the target stays 2 over {p1, p3}.<br>- Oldest Mbps first, p1 gets 2 and p3 gets 0. A part admitted lawfully on reduced capacity is revoked (POL-07 harm to the buyer). p1 is not lowered to the link's 1 Mbps, so `CUT_TARGET_UNMET` is raised.<br>Rating then receives a `cut` that matches neither side | Decision D4: **a key's covered parts are fixed by revision 1**. A revision ≥ 2 carries the same `parts`; parts ended since may be dropped, and nothing is added. It is sent only when strictly lower at some minute. A revision whose `parts` add a part is answered `MISMATCH` and alerted. A part converted after `T_eff` is never covered (RFC-000 §8). C03 erratum: R39-01 (c) drops "or its covered parts changed", and PT-6 changes to match. Test: "rev 2 with an added part gets `MISMATCH`" |
| M5 | Major | `cut_target` case table, row "`offer` set, offer Final to this link"; C03 V52-2 ("offer Final, `move_at ≤ T_eff` → E11 cut → `APPLIED`"); C04 lines 342, 487, 537 (`offer_cut_kept` unless `move_at ≤ t_eff` and the link is on the new path) vs C04 PL-4 ("a move final after `t_eff` … the later `cut` lowers the moved parts") | **The three contracts disagree on an offer-scoped target whose offer went Final to this link with `move_at > T_eff` before the target arrived.** C02 writes an E11 cut and replies `APPLIED`. C04's "Cut" rule emits `offer_cut_kept` (an E13), which rating ignores. If C04's rule is built, the move's `moved` carries the full rate, and no `cut` reaches rating. The buyer is charged at the uncut rate from `move_at`, while the link carries the cut rate (overcharge; POL-07 and P1-S84 row 2 "continues … at 2 Mbps"). C03's status makes its freeze conditional on C02 carrying V52-2, which C02 does not | C02's row: **"`offer` set, offer Final with this link on the new path (any `move_at`): E11 cause *cut*, binding the moved parts from `max(T_eff, move_at)`; `APPLIED`."** C04 lines 342, 487, 537 and PL-3 drop the `move_at ≤ t_eff` condition, which PL-4 already assumes. C03 V52-2 is restated to match. One joint test per sub-case |
| m1 | Minor | `YIELD_REQUEST` comment "one outstanding per (request, attempt, claim)"; RFC-001 §11.1 "at most one outstanding per (request, attempt)"; Outcome port "`yield_accept` … removes that attempt's pulse" | Several claims can now be open on one holder attempt. Once one is accepted, the others name a stale attempt, which "changes nothing" at the account owner, so they are **never answered**. Nothing says the link closes them. A live claim keeps younger waiters out of the claimed range (review 42 M1), and the link re-arms it across takeovers for ever | "The entry that ends a hold attempt (accepted yield or displacement, convert, release) ends every claim on that attempt and stops its re-sends." Fix the schema comment. RFC-001 §11.1 erratum |
| m2 | Minor | Idempotency `yield_accept`; Settled M1 errata; RFC-002 §2.2 E3 | A takeover between E3 and `yield_accept` needs the claim to re-send the same identity. E3 records "the participant's yield request", not the claim. The M1 errata list RFC-002 §5.3 and §13.2, but not §2.2 | Erratum RFC-002 §2.2: E3 records the `claim` |
| m3 | Minor | `CutTargetBatchCmd`, `CutTargetBatchReply` | A batch for one account slot carries one `routedGeneration` and one envelope, but many account partitions, each with its own generation. `CutTargetReply` cannot express C01's `Moved`, `Moving` or `Stopped` for one target. So a re-slotted account fails the whole batch, or fails silently. Leg-change coalescing (up to 500 commands) has the same gap | Add a per-target `routedGeneration` to the batch, and per-item C01 `RoutingRefusal` to the batch replies |
| m4 | Minor | `offer_hold` decision order; Idempotency retention "until `lapse_at + release_grace`" | A delayed copy of `offer_hold` that arrives after the tombstone expires is decided on fit and may hold. The M-1 lapse backstop then releases it (seconds), so the gap is small | Add check (0): "`ts ≥ lapse_at`: `REFUSED(TOMBSTONED)`", mirroring `hold`'s `D_c` check |
| m5 | Minor | Settled, M6 errata column | Errata still missing: (a) RFC-002 §13.2 "a marker for an earlier attempt is ignored" (contradicts m1's "any attempt blocks E5"); (b) RFC-001 §11.1 `YIELD_REQUEST` "one outstanding per (request, attempt)"; (c) RFC-002 §2.2 E3 (m2); (d) B1's `convert` sequencing (RFC-002 §5.7) | Add them to the errata |
| m6 | Minor | Semantics "Revisions (C4-2, R39-01)" | C03 V52-1 asks for rule 3's text **verbatim**: "a repeat is the same (key, revision); a revision at or below the highest recorded … writes nothing **and never supersedes**". C02 omits "never supersedes" and "a never-recorded lower revision gets the highest recorded revision's reply, echoing its own revision" (C04 line 851) in that bullet | Copy the text verbatim |
| m7 | Minor | `cut_target` `MISMATCH` ("stops re-sending"); C03 `REDUCTION_FINAL` (every key has a `CutAnswer`) and `hold_2` | After a `MISMATCH`, no lifecycle `cut` exists at that revision, so rating's `hold_2` for the reservation never lifts, and whether `MISMATCH` counts toward `answers_recorded` is unstated | State that `MISMATCH` counts as the recorded answer for `REDUCTION_FINAL`, and that the reservation's `hold_2` waits on an operator decision (C03's R39-20 alarm) |
| m8 | Minor | Scenarios relied on; tool output | P1-S84 is still uncited by any RFC (`coverage S-LINK`: uncited 1). The contract records this as erratum M6 (g) | Keep as a freeze gate: C02 is not tagged until RFC-001 and RFC-002 cite P1-S84 |

### Traces that hold (no finding)

- **B1 of review 42 (shorten, then cut, with the first call `Moving`).** E11b waits for
  E11a's answer, so L ends the leg at 12:00 and then applies E11b, which changes nothing
  after 12:00. P2-S48 holds in both orders. The rule is safe across a takeover once M2 is
  applied.
- **P1-S84 row 2.** `reduce_parts` waits for `ACCEPTED`. The cut cap moves with
  `offer_accept`, and the move's E11 names the binding pairs.
- **Revision races.** Rev 2 recorded, then a stale rev 1: rev 1 gets the recorded reply,
  echoing revision 1 with `recordedRevision` 2. The link records a `CutAnswer` at
  revision 1 and stops re-sending, and the highest `recordedRevision` governs the cap.
  Rev 2 equal to rev 1 writes its E11 (`APPLIED([])`), so C03's `hold_2` lifts.
- **Offer stranding (M4).** Release before hold gives `TOMBSTONED`. A lost `HELD` reply
  is followed by `offer_release` to every leg, which frees the leg within the retry time.
- **Unavailable link (M5).** `UNKNOWN_LINK`/`LINK_RETIRED` on `release` completes E8, so
  `LINK_UNAVAILABLE` is reported and the funds hold is freed.
- **Displacement marker.** A present row of any attempt blocks E5. The marker is deleted
  with the attempt, the key is a single point, and the 10 ms lock timeout defers only
  that E5.
- **Arithmetic.**
  - About 17,000 targets/s for about a minute is about 1 M targets, each estimate marked.
    Spread over about 16,384 account slots, that is about 1 target/s per slot, well under
    64 × 500 in flight.
  - `τ` and `release_grace` match RFC-000.
  - Every unmarked figure is a policy parameter.

## Decisions taken

| # | Decision | Why |
|---|---|---|
| D1 | B1 is fixed by **extending the per-leg sequence to `convert` and `offer_move_at`**, plus a link-side clip of a late `convert` at the leg's applied end | It reuses review 42's rule: no wire change, one mechanism to test. The cost is one acknowledgement of delay on a change that follows a confirm. Buyers, AI agents included, then see "cancelled" mean "free", and suppliers lose no capacity |
| D2 | `STALE_CHANGE` is answered only for a **never-applied** lower id. An applied lower id gets its recorded reply (M2) | It keeps the defect alarm meaningful for an 11–50 person on-call team. The per-leg reply history is small and bounded by the leg's life |
| D3 | A refusal recorded while the mark is set triggers an immediate re-ask (M3) | It closes POL-02 for every message order. A loop is bounded by `mark_waiting(false)` |
| D4 | **Covered parts are fixed at revision 1**; later revisions only lower the rate (M4) | Comparing rates is only meaningful over one part set. It also honours RFC-000's "a part converted later is neither counted nor capped". A new reservation is still handled by an extension's revision 1. This needs C03 to drop R39-01 (c)'s "or covered parts changed" |
| D5 | An offer-scoped target on an offer Final to this link is a normal cut **whatever `move_at`** (M5) | P1-S84 row 2 requires the cut rate from the move. Otherwise rating overcharges the buyer. C04 PL-4 already assumes this |

## Requirements issues

| ID | Issue | Proposed amendment |
|---|---|---|
| RQ-42-1, RQ-42-2 | Still open (carried by C02 under Scenarios) | As review 42 |
| RQ-54-1 | No scenario covers a cancellation or decrease issued immediately after a confirmation or an added part (B1). P2-S43 and P2-S94 cover it only implicitly | Add a P2 scenario: "A reservation cancelled right after it is confirmed frees its capacity on every leg from the next boundary, even if the confirmation reached a link late" |

## Architecture issues

| ID | Issue | Proposed amendment |
|---|---|---|
| AI-54-1 | RFC-000 §8 (link hold port row, as AI-42-1 would amend it) orders only `end_leg` and `reduce_parts` per (reservation, leg). `convert` and the offer commands also create or move parts on a leg (B1) | The link hold port row should read: "per (reservation, leg), the account owner keeps one outstanding command among `convert`, `offer_accept`, `offer_move_at`, `end_leg` and `reduce_parts`, in that leg's creation and change-id order" |
| AI-54-2 | The C03, C04 and C02 rules for offer-scoped targets on a Final offer differ (M5). RFC-000 §8's reservation command port row says "applied only if the move becomes final", which does not fix the timing | Add a C4 freeze note: "an offer-scoped target on an offer Final with the link on the new path is applied as a normal cut from `max(T_eff, move_at)`" |
