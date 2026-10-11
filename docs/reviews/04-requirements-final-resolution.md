# Resolution of the final requirements gates A and B

| | |
|---|---|
| Resolves | [Final gate A](04-requirements-final-gate-a.md) (FA-01 to FA-13: P1, P2, X1; PASS WITH FIXES) and [final gate B](04-requirements-final-gate-b.md) (FB-01 to FB-12: P3, P4, X2; PASS WITH FIXES) |
| Decisions recorded | Final gate A D-1 to D-4 and final gate B D1 to D9 (13), plus one decision this resolution needed (E-1). Each is written into its register entry as the current rule and has its own "Final gate: …" row in the register's Amendments table |
| Files changed | `02-specs/policy-register.md`; all six `.feature` files; all six problem statements in `01-discovery/`; `02-specs/glossary.md`; `02-specs/conformance.md` (regenerated); `README.md` (tag rule, under D-3); this record |
| Not read | Code, `03-rfcs/`, `04-delivery/`, `history/` |
| Date | 2026-10-11 |

## Outcome

Every finding is resolved, and the mechanical checks pass with no problems. The baseline has
**365 scenarios**: P1 53, P2 98, P3 60, P4 104, X1 30 and X2 20. Eight scenarios are new, and
no ID was renumbered, reused or removed. New IDs continue each file's numbering: P2-S95 to
S98, P4-S103 and S104, and X2-S19 and S20. Each sits in the Rule it belongs to.

Three fixes go beyond the gate reports' proposals or depart from them. Each is explained
in its row below:

- **FB-04.** The proposed measure had the wrong sign for supplier debts.
- **FB-02.** The new case is a scenario of its own, not a row of P4-S90.
- **FA-06.** One more tag that the extended term list requires.

## Final gate A

| ID | Resolution |
|---|---|
| FA-01 | Applied under D-1. The completion margin (`commit_margin` with a partner leg, `ack_budget` otherwise) is defined once, in POL-02 and in the glossary ("Completion margin"). The guarantee's scope now reads "whose deadline, less its completion margin, outlasts the outcome of the request ahead" in POL-02, the glossary "Contention guarantee", P2-N4 (need and measure), P2 C4 and the P1 priority-rule constraint. POL-26 cross-refers to it. New scenario **P2-S95** `@need-P2-N4 @POL-02 @POL-05 @POL-26`. B, over L and partner link P with a 30 s deadline, may not begin committing after 20 s. A fails at 25 s, so B is not confirmed. B has failed as of its deadline with "deadline passed while waiting" and `retry_after` 0 s (E-1), and nothing is held |
| FA-02 | Applied under D-2. The phrase "holds, or has booked for a request not yet decided, overlapping capacity at that partner" is now in POL-02 (partner refusals and failure losses), the glossary "Waiting" and "Contention guarantee", and P2-N4 (need and measure). New sibling scenario **P2-S96** `@need-P2-N4 @need-P2-N7 @POL-02 @POL-05 @POL-28`, in the partner-without-holds Rule. B is refused at Q because of A's final-only booking while A is undecided, and B waits. If A then fails, Share cancels A's booking and asks the partner again for B, within B's deadline |
| FA-03 | P2-S28 now reads "Then after reconciliation (POL-28) Share's record of bookings on P matches the partner's record". The file parses (see the checks) |
| FA-04 | Applied under D-4. X1-N7 now reads as proposed, and POL-08 is added to its policy list. X1-S27 is tagged `@POL-08`. Its row 2 result now states the D-4 rule: the cancellation is "b1"'s own change (POL-08), with "b1"'s fees and charges, and is recorded as an operator action with the request |
| FA-05 | P2-N9 now reads "at or before the next minute boundary", which agrees with POL-08 and P2-S84 row 3 |
| FA-06 | Tags added as proposed: P1-S47 `@POL-08`; P2-S37 `@POL-26 @POL-28`; P2-S94 `@POL-05`; X1-S02 `@POL-25`; X1-S13 `@POL-30`; X1-S14 `@POL-07 @POL-16 @POL-30`. The three terms are added to the term list in `README.md` and to the mechanical check. **Beyond the proposal:** with "cancellation fee" → POL-08 in the list, P4-S57 (row "settlement of a cancellation fee") also needed `@POL-08`, which is now added |
| FA-07 | New scenario **P2-S97** `@need-P2-N4 @POL-02 @POL-05`. In the crossing of P2-S19, D (8 Mbps on L2, received after B) also waits. When A ends without confirmation, B is confirmed and D is rejected for no fit |
| FA-08 | New Outline **P2-S98** `@need-P2-N8 @POL-25`. The account's largest confirmed reservation is 200 Mbps, so its limit is max(1,000, 10 × 200) = 2,000 Mbps. Row 1: 1,500 + 500 = 2,000, not rejected. Row 2: 2,000 + 1 > 2,000, rejected for the account's limit on capacity in flight. Both rows exceed the floor of 1,000 Mbps, so they exercise the scaling term |
| FA-09 | The glossary `retry_after` now has the third use. The value is the remaining deadline of the request ahead, or zero if that request already has its outcome (E-1) |
| FA-10 | The glossary "Account administrator" now includes giving or withdrawing consent to identify the account to a named supplier (POL-33) |
| FA-11 | X1-N3 now reads "every new booking or status submission with it is not accepted, and any other request refused, within 60 s" |
| FA-12 | POL-26: the duplicated Decision bullet is deleted and the paragraph after the table is kept. In its place, POL-26 now says that `commit_margin` is also the completion margin of POL-02 |
| FA-13 | X1-S22 has two new rows: a principal of "s2" records the restoration of an unplanned outage, and a principal of buyer "b1" announces a permanent reduction. Each is refused as if the link did not exist. The title now names restorations too |

## Final gate B

| ID | Resolution |
|---|---|
| FB-01 | Applied under D1. POL-06 charge timeliness now covers a declared region disaster. The affected minutes are outside the 99.99% measurement, and each of their charges is posted within its target plus the 1 h regional RTO (1 h 2 min, or `max_lateness` + 1 h 2 min). The RPO stays 0. The same wording is in X2-N3. X2-S13 now leaves out minutes affected by a declared region disaster and bounds the others by the node-or-zone RTO. New Outline **X2-S19** `@need-X2-N3 @need-X2-N4 @POL-06 @POL-14` covers the regional bound (2 min + 1 h) and asserts that no charge is lost or posted twice. It is a separate scenario rather than an X2-S13 row because its 99.99% step differs |
| FB-02 | Applied under D2. The matched kinds are a top-up, invoice payment, reversal, payout, supplier-debt payment, or movement of Share's own funds (deposit or withdrawal). They are listed in POL-24 item 2, P4-N14, the glossary "Reconciliation" and P4-S54 rows 2 and 3. POL-24 adds that treasury records each deposit or withdrawal before its day's reconciliation. **Better than the proposal:** the proposed P4-S90 row does not fit that Outline's numeric columns. The case is instead new Outline **P4-S104** `@need-P4-N14 @POL-24 @POL-29`, with four rows: a deposit of Share's own funds (4.250000), a commission withdrawal, an invoice payment and a supplier-debt payment. Each matches one ledger movement and raises no alert |
| FB-03 | Applied under D3. The corollary now ends "less payouts the partner has executed and the ledger has not yet confirmed". It is changed in POL-24, P4-N14 and the glossary "Reconciliation". P4-S90 row 3 now agrees: funds of 0 cover 120 − 120 |
| FB-04 | Applied under D4. POL-22 has a new bullet saying what "never paid twice" promises (never instructed twice), and its Why text, summary line and the glossary "Payout" and "Supplier debt" are aligned. P4 "Who is affected" (supplier) and the P4-N12 measure are restated. **Corrected:** the proposed measure said payouts equal earnings "less … open supplier debts". The sign is wrong. A duplicate payout or a supplier-fault debt is money paid that is owed back, so payouts exceed earnings by it. The measure now reads "less residues still carried and amounts in flight, plus open supplier debts (amounts paid that are owed back)" |
| FB-05 | Applied under D5. Only a dearer path's difference is borne by Share. It is split by Webster among the new path's parties, each supplier is paid its share from Share's own account, and the commission share is not posted. This is in POL-07 step 4, POL-23 (the same split rule as carried excess) and the glossary "Equivalent path". P3-S59 has a `difference` column, and its Then step reads "Share pays the equivalent path's suppliers their shares of the Webster split of <difference> micro-USD a minute …, with no commission share posted". P4-S77 row 2 now pays each supplier its share of the Webster split. Both are now tagged `@POL-12` |
| FB-06 | Applied under D6. POL-24 makes the safeguarding rule a treasury obligation, checked by the daily reconciliation. No movement owed to a buyer or supplier is refused or delayed because of it, and the system never cures a breach. The rule is also stated in P4-N14 and the glossary "Share's own account". P4-S91 has a new step asserting that no movement is refused or delayed |
| FB-07 | Applied under D7. POL-20 replaces "FX round-ups" with the FX difference rule, and POL-24 item 1 takes funds in USD as the partner reports them. P4-N14 is updated, and the glossary has a new "FX difference" term. New Outline **P4-S103** `@need-P4-N2 @need-P4-N14 @POL-20 @POL-24` covers the top-up of P4-S06 row 2 (credited 9.516979). If the partner reports 9.520000, the FX difference is +0.003021; if it reports 9.510000, it is −0.006979. The reconciliation is exact to the micro |
| FB-08 | Applied under D8. POL-16 has a new bullet on the price-change shortfall, and its `suspension_grace` note now reads "funded by the hold already taken, except for a price-change shortfall (POL-27) or a reversal (POL-21)". POL-27's last bullet is extended. P4-S101 has new Then steps: the hold grows by the 0.100000 headroom to 0.388000, the reservation keeps its capacity for the full `suspension_grace`, and the 0.044000 shortfall (0.432000 − 0.388000) becomes a negative balance under POL-21 and POL-23. The scenario is now also tagged `@POL-21 @POL-23` |
| FB-09 | Applied under D9. Probe rules are in POL-06 (availability), X2-N1 (need) and the glossary "Available minute". New Outline **X2-S20** `@need-X2-N1 @POL-06 @POL-18` has three rows: a probe booking with its funds hold, a probe flow record, and a balance and headroom answer. Each runs on the real path and is not rated, settled, shown in a supplier report or reported as quarantined |
| FB-10 | "Resolutions of money escalations" is added to POL-29's list, which is now completed to match P4-N15 and P4-S57. It is also in P4-N15 and is a new P4-S57 row. "Movement of Share's own funds" (from D2) is added to all three as well. The glossary "Source reference" now lists the same inputs as P4-N15 |
| FB-11 | The P3 constraint now reads "see open question 2" |
| FB-12 | POL-06 now says "A balance and headroom answer", matching X2-N1, X2-S18 and P4-S15 |

## Decisions and where they landed

| Decision | Register | Specs and glossary |
|---|---|---|
| Final gate A D-1 (completion margin scopes the guarantee) | POL-02 Guarantee and Why; POL-26 cross-reference; Summary POL-02 | P2-N4, P2 C4, P1 priority-rule constraint; glossary "Completion margin", "Contention guarantee"; P2-S95 |
| Final gate A D-2 (an undecided final-only booking causes contention) | POL-02 Partner refusals, failure losses and Why; Summary POL-02 | P2-N4; glossary "Waiting", "Contention guarantee"; P2-S96 |
| Final gate A D-3 (a Background contributes only the POL it names) | Amendments row (a spec convention, not a policy) | `README.md` tag rule; the mechanical check |
| Final gate A D-4 (support at the account's request is the account's own change) | POL-08 Admission of a change; POL-30 Decision and Why; POL-32 Support row; Summary POL-30 | X1-N7; glossary "Termination"; X1-S27 |
| Final gate B D1 (region disaster and timeliness) | POL-06 Charge timeliness and Why; Summary POL-06 | X2-N3; X2-S13, X2-S19 |
| Final gate B D2 (the kinds of partner transaction matched) | POL-24 item 1, item 2 and Why; Summary POL-24 | P4-N14; glossary "Reconciliation"; P4-S54, P4-S104 |
| Final gate B D3 (safeguarding while payouts are in flight) | POL-24 Safeguarding rule | P4-N14; glossary "Reconciliation"; P4-S90 row 3 (unchanged, now consistent) |
| Final gate B D4 (never instructed twice) | POL-22 Decision and Why; Summary POL-22 | P4-N12, P4 "Who is affected"; glossary "Payout", "Supplier debt"; P4-S95 (unchanged, now consistent) |
| Final gate B D5 (equivalent-path difference) | POL-07 step 4 and Why; POL-23 | glossary "Equivalent path"; P3-S59, P4-S77 |
| Final gate B D6 (safeguarding is not a gate) | POL-24 Safeguarding rule, Why, Rejected; Summary POL-24 | P4-N14; glossary "Share's own account"; P4-S91 |
| Final gate B D7 (FX differences) | POL-20 Decision and Why; POL-24 item 1; Summary POL-20 | P4-N14; glossary "FX difference", "Reconciliation", "Share's own account"; P4-S103 |
| Final gate B D8 (price-change shortfall in the grace) | POL-16 Decision, `suspension_grace` note, Why; POL-27 | P4-S101 |
| Final gate B D9 (probe account) | POL-06 Availability and Why; Summary POL-06 | X2-N1; glossary "Available minute"; X2-S20 |
| **E-1 (new, taken here)** | POL-02 "What a request that drops out gets back"; Amendments row | glossary `retry_after`; P2-S95 |

### E-1: `retry_after` when the request ahead has already ended

**Question.** D-1 keeps the existing outcome for a waiter outside the guarantee: it fails
"deadline passed while waiting" and gets a `retry_after` equal to the remaining deadline of
the request ahead. FA-01's own case breaks that value. A, the request ahead, ends at 25 s,
before B's 30 s deadline. So at B's deadline A has no remaining deadline.

**Decision.** The waiter still fails as of its deadline (POL-26). Its `retry_after` is the
remaining deadline of the request ahead at that moment, or **zero** if that request already
has its outcome.

**Trade-off.** It keeps one deterministic rule and adds no new failure point. An agent
reads zero as "retry now": the capacity has been decided and may be free. The alternative
was to fail a partner-leg waiter as soon as it passes deadline − `commit_margin`, which
would release its holds up to 10 s earlier. It was rejected for this baseline because it
adds a second failure time and reason to the outcome model, for a gain on a rare path. It
can be revisited without changing the mechanism.

## Spot checks against the register (fixed scenarios), with arithmetic recomputed

- **P2-S95.** The deadline is 30 s and `commit_margin` 10 s, so B cannot begin committing after 20 s. A fails at 25 s, which is after 20 s and before 30 s. B is outside the guarantee (POL-02, POL-26). `retry_after` is 0 under E-1.
- **P2-S96.** Agrees with POL-02 partner refusals (an undecided final-only booking) and POL-28 (Share cancels a not-confirmed final-only booking).
- **P2-S97.** Agrees with POL-02 ("It keeps its place among waiters"). B is older than D, so B wins.
- **P2-S98.** max(1,000, 10 × 200) = 2,000 Mbps. 1,500 + 500 = 2,000 ≤ 2,000, so it is not rejected. 2,000 + 1 = 2,001 > 2,000, so it is rejected.
- **P2-S28.** Parses, and agrees with POL-28 reconciliation.
- **P2-S84 row 3 and P2-N9.** Both agree with POL-08 (at or before the next boundary).
- **X1-S27 row 2.** Agrees with POL-08, POL-30 and POL-32 under D-4.
- **X1-S22 new rows.** Agree with POL-07 "Who may act".
- **X2-S13 and X2-S19.**
  - 2 min + 5 min = 7 min.
  - 2 min + 1 h = 1 h 2 min.
  - `max_lateness` + 2 min + 1 h = `max_lateness` + 1 h 2 min.
  - Both agree with POL-06.
- **X2-S18.** Uses "balance and headroom", as POL-06 now does.
- **X2-S20.** Agrees with the POL-06 probe rule.
- **P3-S59.**
  - Dearer path: 100 Mbps × 3 = 300 micro-USD a minute against 100 × 2 = 200. The buyer accrues min(200, 300) = 200, and the difference is 300 − 200 = 100.
  - Cheaper path: 100 × 1 = 100, so the accrual is 100 and the difference 0.
  - The difference is split by Webster, with the commission share not posted (POL-07, POL-23).
- **P4-S54 and P4-S104.** Agree with POL-24 item 2.
- **P4-S57.** Agrees with POL-29, now listing escalation resolutions and movements of Share's own funds.
- **P4-S77 row 2.** Agrees with POL-07 step 4 and POL-23.
- **P4-S90.**
  - Row 3: 0 = 0 + 120 + 0 − 120, and the corollary holds (positive balances 120, less 120 in flight, = 0 ≤ 0 funds).
  - Rows 1, 2 and 4 are unchanged: 4.25 = −5 + 4.25 + 5; 8.5 = −10 + 8.5 + 10; 100 = 50 + 35 + 15.
- **P4-S91.** 0 = −5 + 4.25 + 0.75. The alert stands, and the new step agrees with D6.
- **P4-S101.**
  - New hold: 100 Mbps × 3 micro-USD × 1,440 min = 0.432000. Growth needed: 0.432000 − 0.288000 = 0.144000 > 0.100000 headroom, so the account is suspended.
  - The hold grows to 0.288000 + 0.100000 = 0.388000, and the headroom is then 0.388000 − 0.388000 = 0.
  - Shortfall over the grace: 0.432000 − 0.388000 = 0.044000.
  - The old hold alone covers 0.288000 / 0.000300 = 960 min (16 h), the original finding.
- **P4-S103.**
  - Exact credit: 1,234 × 0.0077123 = 9.5169782, rounded up to 9.516979.
  - Reported 9.520000: 9.520000 − 9.516979 = +0.003021.
  - Reported 9.510000: 9.510000 − 9.516979 = −0.006979.
  - In both, partner funds = buyer credit + FX difference, exactly.
- **P4-S95.** Unchanged, and now consistent with the P4-N12 measure and POL-22.

## Mechanical checks

The checks were run with the official Cucumber parser (`@cucumber/gherkin`, installed in a
scratch directory) and a script over the parsed documents, the register, the glossary, the
problem statements and the conformance matrix.

| Check | Result |
|---|---|
| Every `.feature` parses as Gherkin (one Feature; Backgrounds only in Rules) | 6 of 6. Before FA-03 was fixed, P2 failed at line 396 ("Then, after …") |
| Every scenario has a `When` and a `Then`; no step text starts with punctuation | Pass |
| Every Outline placeholder has its column; at most one unused column, and it is the last; no plain Scenario with Examples | Pass |
| Scenario IDs: exactly one per scenario, unique, prefixed by its file | 365 IDs, 365 unique |
| Every `@need-` tag names a need in a Needs table; every need cited | 66 needs, all cited, no dangling tag |
| Every `@POL-nn` exists in the register (33 entries) | Pass |
| Every `POL-nn` named in a scenario's title, steps, Examples or Rule Background is tagged | Pass |
| Glossary-term rule on own steps and Examples (D-3). Terms: headroom → 18, key headroom → 25, suspended → 16, waits/waiting → 05, insufficient funds → 15, counter-offer → 10, cancellation fee → 08, revoked → 07, released (of a reservation) → 16, terminate → 30 | Pass. Excluded as not the POL-05 sense: "`wait` setting", "without waiting for", "may wait for capacity" (a supplier) |
| Every backticked identifier in specs, problem statements and glossary is a register parameter or a register-defined value (`request_age`, `retry_after`, `wait`, `pending`) | Pass (43 parameters) |
| Register: no round markers inside entries; every `POL-nn` reference exists | Pass |
| Conformance: one row per scenario, in file order, none orphaned | 365 rows. 8 added, 1 title updated (X1-S22), none removed |

**For information only, not a README rule.** These scenarios name a parameter whose defining
policy is not tagged, although each is tagged with the policy that governs the behaviour:
`wait` (POL-02 table) in P1-S07, P1-S34, P2-S17, P2-S20 and P2-S26, all tagged POL-05 or
POL-29; `usage_price` (POL-01) in P3-S25, S27, S37 and S53 and P4-S56, tagged POL-17 or POL-23
(P3-S37, the lateness bound, POL-14); and `credit_limit` (POL-15) in X1-S13. Neither gate flagged them, and they are left
as they are.

## Further decisions

There is one: **E-1**, above. It is recorded in POL-02 and in the Amendments table. No
other point needed a business decision.
