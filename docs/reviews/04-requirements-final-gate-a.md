# Review 04, final gate A: P1, P2 and X1 before the baseline becomes authoritative

| | |
|---|---|
| Scope in depth | `01-discovery/P1-link-admission.md`, `P2-route-reservation.md`, `X1-security-and-tenancy.md` and their `.feature` files |
| Skimmed for boundaries | P3, P4, X2 (features: accrual, fees, key headroom, latency and deadline scenarios) |
| Also read | `README.md`, the consolidated policy register (binding), the glossary, review 03 gate A and the review 03 resolution record |
| Deliberately not read | Code, `03-rfcs/`, `04-delivery/`, `history/` |
| Date | 2026-10-11 |
| Ground rule | A business decision is never a blocker. Where one is still needed it is taken below ("Decisions taken"), and the fix cites it. FAIL is reserved for defects that make the baseline unsatisfiable, self-contradictory or arithmetically wrong and that a rewording under a decision cannot repair |

## Verdict

**PASS WITH FIXES.** Every GA2 finding is closed, and the consolidated register is coherent.
Arithmetic is correct on every Examples row and worked figure in scope. Traceability passes
a mechanical check: 357 scenarios with unique IDs, 66 needs all cited, no dangling `@need-`
tag, every `@POL-nn` in the register, and every `POL-nn` named in a step, an Examples table
or a Rule Background tagged. The specs contain no implementation leakage.

The baseline can become authoritative once the five Major findings below are fixed. Each
fix is a rewording, a tag or one scenario, under the decisions below:

- The contention guarantee's scope, "whose deadline outlasts the outcome ahead", cannot be
  met at its boundary. A waiter needs time after that outcome to finish, and with a partner
  leg it must start committing by deadline − `commit_margin` (FA-01, D-1).
- One contention path that Share causes is still outside the guarantee: a final-only
  partner booking made for a request that is not yet decided (FA-02, D-2).
- One scenario is not valid Gherkin (FA-03).
- Two needs contradict a scenario or the register (FA-04, FA-05).

## Summary of counts

| Severity | Count |
|---|---|
| Blocker | 0 |
| Major | 5 |
| Minor | 8 |
| **Total** | **13** |
| Decisions taken | 4 |

## Closure of GA2 findings

All 23 are closed as the resolution record claims. I checked each one against the current
text:

- GA2-01: P2-S87 and S88, glossary "Crossing".
- GA2-02: P2-S31 and S89.
- GA2-03: P1-N1 and P1-S13.
- GA2-04: POL-10, and P2-S73 recomputed.
- GA2-05: P1-S48 to S50, P1-N8 and the glossary.
- GA2-06 and GA2-07: the glossary.
- GA2-08: P1-S29 and S51; P2-S32 and S90 to S92; X1-S26 to S28. The remaining open
  questions are measurements only.
- GA2-09 and GA2-10: P1-S52 and S53.
- GA2-11: P3-S44.
- GA2-12: P2-S23.
- GA2-13: P2-S61, P1-S12 and P2-S18.
- GA2-14 to GA2-16: the glossary.
- GA2-17: the tags.
- GA2-18: X1-S01, S05 and S06, and the P2 "decided against capacity" wording.
- GA2-19 to GA2-21: P2-S31, P2-S39 and S53, X1-S25 and the X1-S22 title.
- GA2-23: P2-S28.

GA2-22 corrects `reviews/02-requirements-gate-resolution.md`, which is outside this gate's
read list. It was not re-verified, and it does not affect the baseline.

The "Not fully resolved" items in the review 03 resolution are now closed by the
consolidated register:

- The register no longer contains superseded text.
- The round-6 decisions are in POL-32 and POL-33.
- POL-06 now gives RTOs for payouts and for reporting.

## Findings

| ID | Severity | Location | Finding | Fix |
|---|---|---|---|---|
| FA-01 | Major | POL-02 "Guarantee"; POL-26 (`commit_margin`); glossary "Contention guarantee"; P2-N4 (need and measure); P2 C4; P1 constraints row on the priority rule | The guarantee covers a waiter "whose deadline outlasts the outcome of the request ahead". Take waiter B with a partner leg, behind A on a Share link. If A fails after B's deadline − `commit_margin` but before B's deadline, POL-26 forbids B to begin committing, so B fails, and both lose on a path the guarantee covers. A Share-only waiter has the same problem in principle: if A fails an instant before B's deadline, B cannot take its holds and confirm in zero time. The guarantee and POL-26 contradict each other at this boundary, and P2-N4's measure ("never all lose") cannot be met as worded. | Apply D-1. In POL-02, the glossary, P2-N4, C4 and the P1 constraint, replace "whose deadline outlasts the outcome of the request ahead of them" with "whose deadline, less its completion margin, outlasts the outcome of the request ahead of them". Define the completion margin once, in POL-02 and the glossary: `commit_margin` for a request with a partner leg, `ack_budget` otherwise. Add a P2 scenario under the contention Rule: B over L and partner link P with a 30 s deadline waits behind A; A fails 25 s into B's deadline (after deadline − `commit_margin`); B fails with "deadline passed while waiting" and a `retry_after`, as outside the guarantee. Tag `@P2-S95 @need-P2-N4 @POL-02 @POL-05 @POL-26`. |
| FA-02 | Major | POL-02 "Partner refusals"; POL-28; glossary "Waiting", "Contention guarantee"; P2-N4; P2-S89 | The rule that turns a partner refusal into contention applies only while another Share request "holds" capacity at the partner. At a partner without holds (POL-28), Share's booking for request A is final, not a hold, yet A is still undecided and Share cancels that booking if a later step of A fails (P2-S35). B, refused by the partner because of A's booking, is rejected (P2-S31). If A then fails, both lose, on contention that Share itself caused. This is the GA2-02 gap at a partner without holds. | Apply D-2. In POL-02, the glossary "Waiting" and "Contention guarantee", and P2-N4, write "holds, or has booked for a request not yet decided, overlapping capacity at that partner". Add an Examples row, or a sibling scenario to P2-S89, over partner link Q of a partner without holds. Tag `@POL-02 @POL-05 @POL-28`. |
| FA-03 | Major | P2-S28 | The step reads "Then, after reconciliation (POL-28), …". A Gherkin step keyword must be followed by a space, so "Then," does not parse as a step. The file is not valid Gherkin, and P2-S28 has no `Then`. | "Then after reconciliation (POL-28) Share's record of bookings on P matches the partner's record". |
| FA-04 | Major | X1-N7 ("An operator may end a reservation only by termination for a POL-30 reason"); X1-S27 row 2; POL-32 Support | X1-S27 has a support operator cancel a reservation of "b1" at "b1"'s documented request, as POL-32 allows. X1-N7 says flatly that an operator may end a reservation only by a POL-30 termination. The need contradicts the scenario and the register. | Apply D-4. X1-N7: "On Share's own decision, an operator may end a reservation only by termination for a POL-30 reason. A support operator acting at the account's documented request makes the account's own change (POL-08), with the account's fees and charges." Add `@POL-08` to X1-S27. |
| FA-05 | Major | P2-N9 ("a shortening whose new end is the next minute boundary is a cancellation, and any other shortening is ordered with the other changes"); POL-08; P2-S84 row 3 | POL-08 makes a shortening to an end "at or before the next minute boundary (including an end already past)" a cancellation. P2-S84 row 3 (shorten to 10:00 at 10:30) agrees with POL-08. P2-N9 makes every other shortening, the past-end case included, an ordered change, and so contradicts both. | P2-N9: "a shortening whose new end is at or before the next minute boundary is a cancellation, and any other shortening is ordered with the other changes". |
| FA-06 | Minor | P1-S47; P2-S37; P2-S94; X1-S02; X1-S13; X1-S14 | Policy tags are missing under the README rule (a policy named in a step, or one that defines a glossary term the steps use). P1-S47 uses "cancellation fee" → POL-08. P2-S37 names `route_deadline_max` + `commit_margin` and is under the partner-without-holds Background → POL-26, POL-28. P2-S94 uses "waiting" → POL-05, as its twin P2-S81 does. X1-S02 uses "an agent key's headroom" → POL-25. X1-S13 uses "terminate" → POL-30. X1-S14 uses "revokes, releases or terminates a reservation" → POL-07, POL-16, POL-30. | Add `@POL-08` to P1-S47; `@POL-26 @POL-28` to P2-S37; `@POL-05` to P2-S94; `@POL-25` to X1-S02; `@POL-30` to X1-S13; `@POL-07 @POL-16 @POL-30` to X1-S14. Add "cancellation fee" → POL-08, "key headroom" → POL-25 and "revoked / released / terminated" (of a reservation) → POL-07 / 16 / 30 to the mechanical term list. |
| FA-07 | Minor | POL-02 ("It keeps its place among waiters"); glossary "Crossing" | The rule that a yielding request keeps its place among waiters has no scenario. P2-S88 only orders B ahead of C, which is younger anyway. | Add a P2 scenario: in the crossing of P2-S19, a request D for 8 Mbps on L2, received after B, also waits. When A ends without confirmation, B is confirmed, not D. Tag `@need-P2-N4 @POL-02 @POL-05`. |
| FA-08 | Minor | POL-25 `account_inflight_limit` = max(`account_inflight_floor`, 10 × the largest confirmed reservation) | Only the floor is exercised (P2-S54, S66). The scaling term has no scenario, although it is observable. | Add a row or scenario: an account whose largest confirmed reservation is 200 Mbps may have 2,000 Mbps in flight; a further request beyond that is rejected for the account's limit on capacity in flight. Tag `@need-P2-N8 @POL-25`. |
| FA-09 | Minor | Glossary "`retry_after`" | It defines two of the three uses: the `wait = false` rejection (POL-05) and the rate limit (POL-25). It omits the waiter failed at its deadline, whose `retry_after` is the remaining deadline of the request ahead (POL-02, P2-S61). The term is used in that third sense too. | Add: "Also, for a waiter failed with 'deadline passed while waiting', the remaining deadline of the request ahead of it (POL-02)." |
| FA-10 | Minor | Glossary "Account administrator" ("Only an account administrator can do these things") | It omits the administrator's sole right to consent to identify the account to a named supplier (POL-33, X1-N9, X1-S29). | Append: "…and to give or withdraw consent to identify the account to a named supplier (POL-33)." |
| FA-11 | Minor | X1-N3 ("every new request with it is refused within 60 s") | The need says "refused". For booking and status submissions the glossary term is "not accepted", which X1-S06 uses. | "…every new booking or status submission with it is not accepted, and any other request refused, within 60 s…". |
| FA-12 | Minor | POL-26, the last Decision bullet and the paragraph after the parameter table | The hold-length test ("a partner whose holds last less than `route_deadline_max` plus `commit_margin` is treated as a partner without holds") is stated twice in one entry. The two statements agree, but they invite drift. | Keep the post-table paragraph (the restatement the amendment log names) and delete the duplicated Decision bullet. |
| FA-13 | Minor | X1-N10; X1-S22 | X1-N10 limits the recording of a restoration to the supplier or network operations. No row tests anyone else recording one, and no row tests a buyer announcing a permanent reduction. | Add X1-S22 rows: a principal of "s2" records a restoration; a principal of buyer "b1" announces a permanent reduction. Both are refused as if the link did not exist. |

## Decisions taken

| # | Question | Decision | Trade-off |
|---|---|---|---|
| D-1 | How much of a waiter's deadline must remain, after the outcome ahead, for the contention guarantee to cover it? (FA-01) | The waiter's **completion margin**: `commit_margin` with a partner leg, `ack_budget` otherwise. A waiter is covered if the outcome ahead comes before its deadline less that margin. Otherwise it is outside the guarantee and fails with "deadline passed while waiting" and a `retry_after`, as now. No new parameter | It reuses margins the buyer already accepts: a partner-leg request already reserves `commit_margin`, and `ack_budget` is the time Share commits to decide a fitting single-link request. Agents keep a deterministic rule. The excluded slice of deadlines grows by at most 10 s for partner routes |
| D-2 | Is a refusal caused by Share's own final-only booking at a partner without holds, for a request not yet decided, contention? (FA-02) | Yes, as for a hold (POL-02 partner refusals). The refused request waits within its deadline until that request's outcome, and Share's cancellation of the partner booking if the request is not confirmed, then asks the partner again | Keeps the guarantee wherever Share caused the contention. The cost is a longer wait and an extra partner call on the rare path where the request fails after its final-only leg was booked. Share's risk is unchanged: POL-28 already makes Share bear that cancellation |
| D-3 | Does the glossary-term tag rule reach terms used only in a Rule's Background? (reading needed to check FA-06) | No. A Background contributes the `POL-nn` it names explicitly. The glossary-term rule applies to a scenario's own steps and Examples. So "headroom and key headroom cover every change" in the P2 change Rule's Background does not require `@POL-18 @POL-25` on every scenario in that Rule | Keeps the tag set meaningful (each tag marks behaviour the scenario exercises) and the mechanical check stable. A policy assumed only in setup is still traceable through the scenarios that exercise it |
| D-4 | Is a support operator's cancellation at the account's documented request a Share termination? (FA-04) | No. It is the account's own change under POL-08: the account's fee rules apply (it pays a shown partner fee) and it is recorded as an operator action under POL-32. POL-30's closed list applies only to ends on Share's own decision | It matches POL-30's "besides the account's own request" and POL-32's support role. Support can still serve accounts that cannot use the API, and Share's power to end reservations on its own decision stays closed |

## What passed

- **Arithmetic** (rechecked every row):
  - P1:
    - S01: 7 + 3 = 10; 7 + 4 = 11.
    - S02, S03.
    - S06: 4 + 6 + 1 = 11.
    - S07: 6 + 5 > 10, while 0 + 5 ≤ 10, so the request waits rather than being rejected.
    - S09: 6 + 4.
    - S10: 6 + 5.
    - S12: 10 − 6 = 4; [11:00, 12:00).
    - S15: 2.
    - S16: [12:00, 13:00).
    - S38: 10 − 8 − 2 = 0; 8 < 9 for ever.
    - S39: 10.
    - S21: 6 + 5 > 10.
    - S23.
    - S24: 8 + 1 > 6.
    - S27: 8 + 2 = 10.
    - S41: 8 + 2 > 6.
    - S42: 8 + 1 > 6.
    - S48: 9 ≥ 8.
    - S49: 6.
    - S50: 4 + 4 + 2 = 10 > 6, then 2 ≤ 6.
    - S28 to S30, S51.
    - S43: 8 > 4.
    - S46: the added 2 Mbps.
    - S47: 8 → 6, so B goes to 2.
    - S52.
    - S33: cancelled at 09:30:20, effective 09:31.
  - P2:
    - S18: 2; [11:00, 12:00).
    - S19, S87, S88: the cycle unwinds as stated.
    - S38: 0.488 − 0.288 = 0.2; −0.5 − 0.3 + 1.0 = 0.2; 0.088 and 1.088.
    - S39 and P4-S68: 0.288, 0.360, 0.360, 0.788; −0.088.
    - S42: 0.072 + 1.000 = 1.072.
    - S45: 6 + 4 = 10.
    - S46: 8 + 4 > 10.
    - S47: 2 + 8 = 10.
    - S74: 4 + 8 > 10.
    - S48: 3 Mbps released.
    - S54: 800 ≤ 1,000. S66: 1,000 ≤ 1,000.
    - S73: 3 Mbps; [12:00, 13:00).
    - S75: 4 × 120 × 2 = 960 micro-USD; 460; 1,000,460.
    - S84 and S94: shortening to 10:01 or 10:00 at 10:00:30 is a cancellation.
    - S37: 60 + 10 = 70 s.
  - X1-S06: 10:00:00 + 60 s.
  - P3:
    - S04: 10:29:20 → 10:30.
    - S07: first boundary at or after +30 days.
    - S40, S42.
    - S45: 100 × 2 + 50 × 3 = 350.
    - S46: 80 × 2 = 160.
    - S58: 8 → 4.
    - S59: 200/100 and 100/0.
  - P4-S55: min(10, 4) = 4; min(3, 4) = 3.
  - Register:
    - 6 × 2 = 12 probes a minute.
    - 10 + 50 = 60 s.
    - ×50 of 500/s = 25,000/s.
    - 2.25 PB/day ÷ 100 KB ≈ 260,000 records/s.
    - 2 + 5 = 7 min.
    - One quarter of 24 h = 6 h.
  - Glossary: 100 Mbps for one minute = 0.75 GB.
- **Register ↔ spec fidelity.** Every observable rule in the policies checked has a
  scenario except FA-07 and FA-08, and no scenario contradicts the register:
  - POL-02: oldest first; invariants; yielding; crossings and cycles; no pre-emption;
    partner refusals; failure losses; what a dropped request gets back.
  - POL-03; POL-04 (`ack_budget`, pending, polls, webhooks).
  - POL-05; POL-07 (every clause, P3-S08 to S10, S47, S58, S59 included).
  - POL-08 (every row and the partner-fee payers, P3-S11, S43, S44, S60 included).
  - POL-09; POL-10 (all five items and discretion).
  - POL-25 (keys, revocation, spending, negative key headroom, in flight, no squatting,
    rate and poll limits, concurrency, `account_max_keys`).
  - POL-26 (bounds, default, margin, failed as of the deadline, holds released, alert,
    short holds).
  - POL-28; POL-29; POL-30 (P3-S42 included); POL-31.
  - POL-32 (P4's know-your-business check included); POL-33 (consent, withdrawal, legal
    order).
- **Contention guarantee, every path.** The guarantee holds on every path except the
  boundary (FA-01) and the final-only partner booking (FA-02), under D-1 and D-2:
  - single-link and route waiters (P1-S07, S11; P2-S15, S16, S20, S52);
  - holders that are not waiting (S58);
  - crossings and cycles (S19, S60, S87, S88);
  - partner refusals caused by Share holds (S89);
  - `wait = false` (S18, S59) and short deadlines (S61), both excluded with a next step;
  - failures, with nothing held and a reason (S62, P1-S41, S42);
  - funds-before-capacity (S92);
  - withdrawal, key revocation, suspension and crash (S56, S72, S69, S22, S23).
- **Glossary.** Consistent with the register on every term used in scope, apart from
  FA-09 and FA-10: Outcome, Not accepted, Capacity hold, Funds hold, Deadline, Waiting,
  Crossing, Counter-offer, Key spending, Key headroom, Resume amount, Affected reservation,
  Equivalent path, Reservation, Cancellation fee.
- **Gherkin.** One `Feature` per file. Backgrounds only at Rule level. Every Outline
  placeholder has its column, at most one trailing documentation column, no plain Scenario
  with Examples, and every scenario has a `When` and a `Then` (except FA-03).
- **No implementation leakage.** No HTTP paths, status codes, tables, topics, data
  structures, algorithms or error strings in the in-scope problem statements or specs.
  The specs keep no verification metadata.
