# Requirements amendments from the second RFC-000 review

| | |
|---|---|
| Resolves | The requirements issues RQ-7 to RQ-11 and finding A0R-05 of the [second RFC-000 review](08-rfc-000-review-2.md) ("Requirements issues", "Findings") |
| Decisions applied | As decided by the coordinator (binding). Each is written into its register entry as the current rule, with its own "RFC-000 review 2: …" row in the register's Amendments table (RQ-9 changes a scenario only, so it has no row) |
| Files changed | `02-specs/policy-register.md`; `02-specs/P1-link-admission.feature`, `P2-route-reservation.feature`, `P4-wallet-and-settlement.feature`; `01-discovery/P1-link-admission.md`, `P2-route-reservation.md`, `P4-wallet-and-settlement.md`, `X2-non-functional-targets.md`; `02-specs/glossary.md`; `02-specs/conformance.md` (regenerated); this record |
| Not read | Code, `history/` |
| Not edited | `03-rfcs/` (revised in parallel) |
| Date | 2026-10-12 |

## Outcome

All five issues and A0R-05 are now current rules. The mechanical checks find no new
problems (see below). The baseline now has **392 scenarios**: P1 62, P2 110, P3 62, P4
104, X1 30 and X2 24. Five scenarios are new. No ID was renumbered, reused or removed.
The new IDs continue each file's numbering:

- **P1-S62**;
- **P2-S107 to P2-S110**.

There is no new parameter and no new policy entry. The number of needs is unchanged at
66. There is no new glossary term; "failing over" is defined within *Schedule owner*.

## Changes by issue

### RQ-7. The confirm fence is the deadline; the completion margin bounds when committing begins (POL-26, POL-02, POL-04)

Decision: a request is confirmed only by a decision entry timestamped before its deadline.
A request with a partner leg may not begin committing later than deadline −
`commit_margin`; a request without one may not begin later than deadline − `ack_budget`.
This replaces "timestamped before the deadline less the completion margin".

| Where | Change |
|---|---|
| POL-26 | The "every outcome exists by the deadline" bullet now states both commit-begin fences, with `ack_budget` for a request without a partner leg. "When a confirmation can be decided" now fences the confirmation at the deadline itself ("no confirmation is ever decided at or after the deadline"). The `commit_margin` bullet on the contention guarantee now speaks of the completion margin. The Why explains that the margin bounds when committing begins, so the partner's confirmation has the whole margin. The Rejected list adds the old fence |
| POL-02 | The completion margin is redefined as the time a request keeps inside its deadline to be confirmed: it may not begin committing later than deadline less the margin. Its values and its role in scoping the guarantee are unchanged |
| POL-04 | Provenance only (the margin uses `ack_budget`) |
| Summary | The POL-26 line is updated |
| P2-N3 | The need and its measure state both commit-begin fences and the confirm fence at the deadline |
| P2 C20 | States the rule |
| Glossary | *Outcome* and *Decision record*: confirmed only by a decision before the deadline. *Deadline*: both commit-begin fences. *Completion margin*: redefined as above; a confirmation still counts if decided at any time before the deadline |
| P2-S104 | The Given now reads "no confirmation of the request was decided before its deadline (POL-26)" |
| P2-S106 | The Given now reads "timestamped before its deadline (POL-26)" |
| P2-S22 | "less `commit_margin` with a partner leg" now reads "less its completion margin: `commit_margin` with a partner leg, `ack_budget` otherwise" |
| New | **P2-S109** `@need-P2-N3 @POL-26`: a partner route that begins committing at 19 s, before its 20 s fence, and whose partner confirms at 27 s, is confirmed by a decision before its 30 s deadline |
| New | **P2-S110** `@need-P2-N3 @POL-26 @POL-04`: a Share-only route with a 5 s deadline that resumes at 4.9 s, after its fence of 4.8 s (5 s − `ack_budget`), does not begin committing, is not confirmed, and has failed as of its deadline, holding nothing from it |

### RQ-8. Reporting waits for durable releases, within `release_grace` during a schedule owner's failover (POL-04, POL-26)

Decision: an outcome other than confirmed is reported only once its Share-link releases
are durable: within `status_staleness` of the decision normally, and within
`release_grace` of it while a link's schedule owner is failing over.

| Where | Change |
|---|---|
| POL-04 | The status-read bullet now has two exceptions, both only for an outcome not yet reported: "Releases not yet durable" (this decision) and "Decision record unavailable at the deadline" (as before). "Capacity is free once the outcome is reported" states both bounds. The Why gives the reason: nobody can book the link while its owner fails over, so nothing is lost commercially, and reporting before the release is durable would show held capacity as free |
| POL-26 | The Share-link case of "Holds end at the deadline", and the bullet "Share also releases …", add "or the link's schedule owner is failing over then": the hold is released within `release_grace` after the deadline, and the failed outcome is reported once that release is durable. The alert stays limited to the decision-record case. The Why is extended |
| Summary | The POL-04 and POL-26 lines are updated |
| P2-N2 | The need and its measure state both bounds |
| P2-N3 | The need and its measure state the deadline case |
| P2 C20 | States the rule |
| P1-N3, P1-N7 | State both bounds |
| Glossary | *Schedule owner* defines **failing over** (from the loss of the current owner until a new one has taken over the link's schedule). *Capacity hold* and *Status read* state the rule |
| P2-S99 | The last Then adds the exception for a non-confirmed outcome while a link's schedule owner fails over (P2-S107) |
| P2-S93 | The Given adds "and the schedule owner of L1 is not failing over then" |
| P1-S18 | The Given adds "and its outcome was reported (POL-04)", and `@POL-04` is added |
| New | **P2-S107** `@need-P2-N2 @need-P2-N3 @POL-04 @POL-26 @POL-08`, an outline with one row per event (a withdrawal; the deadline). While L1's schedule owner fails over, status reads report pending until the releases are durable, the failed outcome is reported within `release_grace` of the decision, and L1's capacity is free from the moment it is reported |
| New | **P1-S62** `@need-P1-N7 @need-P1-N3 @POL-04 @POL-26 @POL-08`: the same on one link, for a withdrawal |

### RQ-9. P1-S54 agrees with P2-S106

| Where | Change |
|---|---|
| P1-S54 | The Given "And no confirmation of the request was decided before its deadline (POL-26)" is added, as P2-S104 has it |

### RQ-10. A reported outcome never reverts to pending (POL-04)

Decision: the exception "status reads report `pending` while the decision record is
unavailable" never applies to an outcome already reported.

| Where | Change |
|---|---|
| POL-04 | Both exceptions apply only to a request whose outcome has not yet been reported. New bullet, "A reported outcome stays reported": every later status read reports it, whatever the state of the decision record or of the links' schedule owners. The Why is extended |
| Summary | The POL-04 line is updated |
| P2-N2, P2 C20 | State the rule; P2-N2's measure adds "no status read reports pending after the request's outcome was reported" |
| Glossary | *Status read* states it |
| New | **P2-S108** `@need-P2-N2 @POL-04`: a request reported rejected before its deadline, whose decision record is then unavailable across the deadline, is reported rejected by every later status read, never pending |

### RQ-11. In-flight incoming payments in the reconciliation (POL-24, P4-N14)

Decision: the invariant includes payments the partner has received and reported but the
ledger has not yet posted, each matched to its partner credit, symmetric with payouts
executed but not yet confirmed.

| Where | Change |
|---|---|
| POL-24 | Invariant (1) adds "+ payments the partner has received and reported and the ledger has not yet posted (top-ups and invoice payments, each matched to its partner credit)". Rule (2) adds that such a payment is matched to its partner credit there, and to its ledger movement once posted. The safeguarding rule adds "plus payments the partner has received and the ledger has not yet posted". The Why is extended |
| Summary | The POL-24 line is updated |
| P4-N14 | Parts (1), (2) and (3), and the measure, state the same |
| Glossary | *Reconciliation* states the same |
| P4-S54 | Row 1 adds the new term. A row is added: a payment counted as received and not yet posted matches no credit in the partner's report |
| P4-S90 | Retitled "… less payouts executed but not yet confirmed, plus payments received but not yet posted, and no alert is raised". A Given and a `<received>` column are added, and the equation becomes `<partner> = <buyers> + <suppliers> + <share> - <in flight> + <received>` |

**Arithmetic.** Every P4-S90 row was recomputed against the new equation.

| Row | partner | buyers + suppliers + share − in flight + received | Result |
|---|---|---|---|
| 1 (existing) | 4.250000 | −5.000000 + 4.250000 + 5.000000 − 0 + 0 | 4.250000, unchanged |
| 2 (existing) | 8.500000 | −10.000000 + 8.500000 + 10.000000 − 0 + 0 | 8.500000, unchanged |
| 3 (existing) | 0.000000 | 0 + 120.000000 + 0 − 120.000000 + 0 | 0.000000, unchanged |
| 4 (existing) | 100.000000 | 50.000000 + 35.000000 + 15.000000 − 0 + 0 | 100.000000, unchanged |
| 5 (new) | 25.000000 | 0 + 0 + 0 − 0 + 25.000000 | 25.000000: a top-up received before the cut, posted after it |
| 6 (new) | 95.000000 | 50.000000 + 120.000000 + 0 − 100.000000 + 25.000000 | 95.000000: a payout and an invoice payment both in flight |

P4-S91 (0.000000 = −5.000000 + 4.250000 + 0.750000) has no payment or payout in flight,
so it is unchanged. P4-S103 is unchanged: its top-up is posted.

### A0R-05. Fibre diversity as a go-live condition (X2 constraints, POL-06)

Decision: R1 Nairobi has at least two physically diverse fibre paths, one of them to R3
Johannesburg not via Mombasa; R2 Mombasa likewise to R3. It is a go-live condition, not a
design target.

| Where | Change |
|---|---|
| X2 constraints | New row, marked *Assumed; a production gate*. R1 has at least two physically diverse fibre paths, one of them to R3 not via Mombasa; R2 likewise has at least two, one of them to R3 not via Nairobi. Production does not start until Share verifies it. The design may rely on it but does not have to provide it. "Out of scope" points to it |
| POL-06 | The serving-region bullet says the topology's go-live condition is stated in X2's constraints. No rule depends on it |
| Summary | The POL-06 line is updated |
| Glossary | *Serving region* states the go-live condition |
| Scenarios | None. This is an assumption and a gate, not behaviour |

## RQ-12, from RFC-000 revision 3

This issue comes from the "Requirements issues" section of RFC-000 revision 3 (only that
section was read). The coordinator decided it; the decision is binding. It has an
Amendments row, "RFC-000 revision 3: RQ-12 …". It was applied after v1.4 (392
scenarios), so the baseline is now **393 scenarios** (P2 111). The new ID is
**P2-S111**.

Decision: the POL-04 status-read exception is extended to "before or at the deadline".
While an account's decision record is failing over (bounded by admission's 1 min RTO), a
status read of an outcome not yet reported may report `pending` beyond
`status_staleness`. It never reports a wrong outcome, and never `pending` after an outcome
already reported (RQ-10 stands).

| Where | Change |
|---|---|
| POL-04 | The exception "Decision record unavailable at the deadline" becomes "Decision record unavailable, before or at the deadline". While the record is failing over, a status read reports `pending`, even beyond `status_staleness`, until the record is available again: at most admission's recovery time (1 min, POL-06) after it became unavailable, and at most `release_grace` after the deadline when it is unavailable at the deadline. It never reports another outcome. It still applies only to an outcome not yet reported. The Why is extended |
| Summary | The POL-04 line is updated |
| P2-N2 | The need and its measure state the extended exception |
| Glossary | *Status read* states it |
| P2-S99 | The last Then's exception now reads "unavailable, before (P2-S111) or at its deadline (P2-S106)" |
| New | **P2-S111** `@need-P2-N2 @POL-04 @POL-06`. An outcome is decided at 5 s, and the decision record is then unavailable for 20 s, before the outcome is reported and before the 30 s deadline. Every status read meanwhile reports pending, even beyond `status_staleness`, never another outcome. The outcome is reported once the record returns, within 1 min of it becoming unavailable |
| Conformance | One row added (P2-S111), in file order after P2-S107 |

Checks: re-run as above against the committed v1.4 tree. The output is identical apart
from the counts (393 scenarios, 393 unique IDs, 66 needs all cited, 46 parameters, the
conformance matrix at 393 rows).

## Choices made in applying the decisions

1. **RQ-7, the role of the completion margin.** POL-02's completion margin is redefined
   as the commit-begin fence, which keeps its values and its use in scoping the
   contention guarantee. A waiter is still promised an outcome only if its deadline,
   less its margin, outlasts the outcome ahead, so the guarantee's scope is unchanged.
2. **RQ-8 at the deadline.** The decision speaks of reporting. A failed-at-deadline
   outcome is decided at the deadline, so its Share-link release, which must be durable
   before the report, may come up to `release_grace` after the deadline while that
   link's schedule owner fails over. POL-26's "released at the deadline" and P2-S93 are
   given the matching exception. Without it they would contradict the decision.
3. **No alert for a failover.** POL-26's alert for an unavailable decision record is not
   extended to a schedule owner's failover, since the decision includes none.
4. **"Failing over" is defined in the glossary under *Schedule owner*,** not as a
   separate term, as the period from the loss of the current owner until a new one has
   taken over. It is bounded in practice by admission's 1 min RTO (POL-06), which is why
   `release_grace` covers it.
5. **RQ-11, matching rule (2).** A payment counted as received and not yet posted has no
   ledger movement at the cut. It is matched to its partner credit within the in-flight
   term, and to its ledger movement once posted. A counted payment with no partner
   credit is a difference (new P4-S54 row).
6. **A0R-05, "R2 likewise".** This is read as: R2 has at least two physically diverse
   fibre paths, one of them to R3 not via Nairobi.
7. **RQ-9 has no Amendments row,** since no policy changed.

## Mechanical checks

The checks were run with the official Cucumber parser (`@cucumber/gherkin` 42.0.1,
installed in a scratch directory) and a script over the parsed documents, the register,
the glossary, the problem statements and the conformance matrix. The script was run first
on the committed baseline (`HEAD`, 387 scenarios, extracted with `git archive`). The
amended tree gives the same output as the baseline, apart from the scenario counts. The
leftover output is false positives of the script, the same before and after: file paths
and tag notation in backticks, the glossary's time and window notation, and
`priority_rule = request_age`. A separate check of the glossary's replaced terms flags
"hold" in many baseline scenarios ("its hold on L1"). It flags the new P1-S62 in the same
way, for "its capacity hold", which is the glossary's own term.

| Check | Result |
|---|---|
| Every `.feature` parses as Gherkin (one Feature; Backgrounds and scenarios only in Rules) | 6 of 6 |
| Every scenario has a `When` and a `Then`; no step text starts with punctuation | Pass |
| Every Outline placeholder has its column; at most one unused column, and it is the last; no plain Scenario with Examples; no ragged rows | Pass (P2-S107, P4-S90 and P4-S54 included) |
| Scenario IDs: exactly one per scenario, unique, prefixed by its file | 392 IDs, 392 unique |
| Every `@need-` tag names a need in a Needs table; every need cited | 66 needs, all cited, no dangling tag |
| Every `@POL-nn` exists in the register (33 entries) | Pass |
| Every `POL-nn` named in a scenario's title, steps, Examples or Rule Background is tagged | Pass |
| Every backticked identifier in the specs, problem statements and glossary is a register parameter or a register-defined value | Pass (46 parameters, none new); no new findings |
| Register: every `POL-nn` reference exists | Pass |
| Conformance: one row per scenario, in file order, titles matching | 392 rows: 5 added (P1-S62, P2-S107 to P2-S110), one retitled (P4-S90), none removed, every existing Design, Tests and Status cell kept |

## Not changed

- RFC-000 and the other RFCs are not edited. Their "Requirements issues" sections can point
  to this record.
- No new policy entry or parameter was needed.
- P2-S55 and P2-S95 already state the commit-begin fence for partner routes, and are
  unchanged.
