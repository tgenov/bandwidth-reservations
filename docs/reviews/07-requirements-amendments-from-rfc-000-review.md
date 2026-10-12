# Requirements amendments from the RFC-000 review

| | |
|---|---|
| Resolves | The requirements issues RQ-1 to RQ-4 and decision D3 of the [RFC-000 review](06-rfc-000-review.md) ("Requirements issues", "Decisions taken"), plus the coordinator's decision on the serving-region topology |
| Decisions applied | As decided by the coordinator. Each is written into its register entry as the current rule, and has its own "RFC-000 review: …" row in the register's Amendments table |
| Files changed | `02-specs/policy-register.md`; `02-specs/P1-link-admission.feature`, `P2-route-reservation.feature`, `P4-wallet-and-settlement.feature`, `X2-non-functional.feature`; `01-discovery/P1-link-admission.md`, `P2-route-reservation.md`, `P3-rating-and-metering.md`, `X2-non-functional-targets.md`; `02-specs/glossary.md`; `02-specs/conformance.md` (regenerated); this record |
| Not read | Code, `history/` |
| Not edited | `03-rfcs/` (RFC-000 is being revised separately) |
| Date | 2026-10-12 |

## Outcome

All four issues, decision D3 and the topology are now current rules. The mechanical checks
find no new problems (see below). The coordinator's later decision on the open point
(equivalent paths with a partner leg) is also applied, as are RQ-5 and RQ-6, raised by
the revised RFC-000. The baseline now has **387 scenarios**: P1 61, P2 106, P3 62, P4 104,
X1 30 and X2 24. Thirteen scenarios are new. No ID was renumbered, reused or
removed. The new IDs continue each file's numbering:

- **P1-S54 to P1-S61**;
- **P2-S104 to P2-S106**;
- **X2-S23 and X2-S24**.

There is one new parameter, `release_grace` (POL-26, 1 min). There are two new glossary
terms, "Decision record" and "Declared region disaster". The number of needs is unchanged
at 66.

## Changes by issue

### RQ-1. Share-link holds when the decision record is unavailable at the deadline (POL-26, P2-N3)

Decision: on Share links, holds are released at the request's deadline. If the decision
record is unavailable at the deadline, they are released within `release_grace` (1 min)
after it. A request is never confirmed after its deadline.

| Where | Change |
|---|---|
| POL-26 | The bullet "holds must expire on their own" is replaced by "Holds end at the deadline", which has three cases. (1) On a Share link, the hold is released at the deadline, or within `release_grace` after it if Share's record of the request's decision is unavailable then. The request has still failed as of its deadline, and the case alerts. (2) A partner hold lapses at the deadline by itself, as before. (3) A partner booking is cancelled at once (RQ-2). A request is never confirmed after its deadline. The parameter `release_grace` = 1 min is added. The bullet "Share also releases every hold at the deadline" now names the exception. The Why and the Rejected list are extended |
| Summary | The POL-26 line is updated |
| P2-N3 | The need and its measure now say: no request is confirmed after its deadline; no Share-link hold is kept later than `release_grace` after the deadline when the decision record was unavailable; no partner hold is kept after the deadline; and every partner booking left without Share's confirmation is cancelled at once (RQ-2). The heading cites POL-28 |
| P2-N10 | A request whose decision record is unavailable at its deadline alerts |
| P2 C20 | States the release rule and `release_grace` |
| P1-N3, P1-N7 | Each states the exception, with `release_grace`, in the need and in its measure |
| Glossary | "Outcome": a request is never confirmed after its deadline. "Capacity hold": the Share-link exception, and that a partner's confirmed leg is a booking, not a hold. New term "Decision record" |
| P2-S23 | The last Then now reads "no capacity at a partner after its deadline, or on a Share link later than `release_grace` after it" |
| P2-S93 | A Given is added: "the request's decision record is available at its deadline" |
| P2-S101 | The Then is split: nothing is held at P from the deadline, and nothing on L1 later than `release_grace` after it |
| P1-S08, P1-S18 | The Given is qualified with "its decision record being available when it ends", and `@POL-26` is added |
| New | **P2-S104** `@need-P2-N3 @need-P2-N10 @POL-26 @POL-04`: a request whose decision record is unavailable at its deadline has failed as of it and is never confirmed. Its Share-link holds are released within `release_grace`, and operations is alerted |
| New | **P1-S54** `@need-P1-N7 @need-P1-N3 @POL-26`: the same exception, seen on one link. The capacity is free again at most `release_grace` after the deadline |

### RQ-2. A partner booking left without Share's confirmation (POL-28, POL-26)

Decision: a partner booking, at a partner of any type, with or without holds, that is left
without a Share confirmation is cancelled at once, at Share's cost.

| Where | Change |
|---|---|
| POL-28 | New bullet: any partner booking left without Share's confirmation is cancelled at once, at Share's cost. It applies to every partner leg, because a partner with holds confirms its leg before Share decides. The Why is extended |
| POL-26 | Covered by the third case of "Holds end at the deadline" (above) |
| POL-08 | The "Withdraw a pending request" row and the Share-pays list now cover a partner booking at a partner with or without holds, not only a final-only leg |
| POL-02 | The partner-refusal rule's example of an undecided booking now includes a partner's confirmation of a held leg before Share's decision. Without this, a refusal caused by such a booking would not count as contention |
| Summary | The POL-08 and POL-28 lines are updated |
| P2-N3, P2-N7, P2 C20 | State the rule. P2-N7's measure now covers every partner, not only partners without holds. P2-N4's note on when a booking resolves now says "a partner booking" |
| P3-N12 | Share pays the fee when a partner booking left without its confirmation is cancelled, at a partner with or without holds |
| Glossary | "Waiting": "a partner booking", where it said "a final-only booking" |
| P4-S77 | The first Examples row now reads "the cancellation of a partner booking left without Share's confirmation, at a partner with or without holds (POL-28)" |
| New | **P2-S105** `@need-P2-N7 @need-P2-N3 @POL-28 @POL-08 @POL-26`. P is a partner with holds, and it has confirmed its leg. A later failure, a withdrawal, or the deadline passing then cancels the booking on P at once, at Share's cost, and the buyer is not charged. It is an outline with one row per event |

### RQ-3. Latency during a declared region disaster (POL-06, X2)

Decision: during a declared region disaster the latency targets are suspended. RPO 0 for
acknowledged facts still applies.

| Where | Change |
|---|---|
| POL-06 | New bullet. From the declaration until the lost region is restored or replaced, the latency targets (every "Latency, …" row) are not measured. These still apply: RPO 0, acknowledgement only once a fact is durable in two regions, outcomes by the deadline (POL-26), and the reporting of breaches of the usage exposure bound (POL-14). The serving-region bullet defines how long a declared region disaster lasts. The Why is extended |
| Summary | The POL-06 line is updated |
| X2-N3, X2-N4 | X2-N3 states the suspension. X2-N4 states that its rules still apply during a disaster |
| Glossary | New term "Declared region disaster" |
| New | **X2-S23** `@need-X2-N3 @need-X2-N4 @POL-06 @POL-26`. During a declared disaster, answers are left out of every latency target (X2-S05, S15, S06, S07, S22, S17 and S08). Outcomes still come by the deadline, and facts are still acknowledged only once durable in two regions, with none lost |

### RQ-4. A firm equivalent-path offer (POL-07)

Decision: an equivalent-path offer is firm. Its capacity is held for `offer_window`.

| Where | Change |
|---|---|
| POL-07 | Step 3 adds "The offer is firm". While the offer is open (at most `offer_window`), the path's capacity is held for the reservation, at its full rate on every leg, from the offer to the reservation's end. The hold is Share's own, with no funds hold, and costs the buyer nothing before the move. For new sales it counts as committed. It becomes the reservation's on acceptance, and is released at once on a decline or lapse. The Why and the Rejected list are extended |
| Summary | The POL-07 line is updated |
| P1-N2, P1-N8, P1 constraints | State the firm offer and that its capacity counts as committed |
| Glossary | "Equivalent path" states the firm offer. "Committed rate" includes capacity held for an open equivalent-path offer |
| New | **P1-S55** `@need-P1-N8 @need-P1-N1 @POL-07`: the offer is firm, its capacity held while it is open and sold to no one else, and the buyer is not charged for it before moving |
| New | **P1-S56** `@need-P1-N8 @need-P1-N2 @POL-07 @POL-10`: a request that fits only without the held capacity is rejected at once with a counter-offer, not left waiting |
| New | **P1-S57** `@need-P1-N8 @POL-07`: on acceptance the held capacity becomes the reservation's; on a decline or lapse it is released at once. It is an outline |
| P1-S55, P1-S57 | The Given now states that the path's every leg is a Share link (see the follow-up below) |

#### Follow-up: equivalent paths with a partner leg (coordinator decision on the open point)

Decision: (1) all-Share equivalent paths are offered first, as firm offers. (2) A path with
a partner leg is offered only when no all-Share path exists; it is firm on its Share legs,
and the partner leg is booked only at acceptance. (3) If that booking fails, the outcome
is as for a declined offer, and the buyer is offered any other equivalent path still
available. The buyer is told at offer time that the partner leg is confirmed only at
acceptance.

| Where | Change |
|---|---|
| POL-07 | Step 3 now has "Which path is offered" and "The offer is firm on Share legs". The partner leg is booked at acceptance, and the buyer is told so when the offer is made. A failed booking counts as a declined offer (step 7), releases the Share legs' held capacity at once, and leads to an offer of any other equivalent path still available, on the same terms. The capacity becomes the reservation's on acceptance, once the partner has confirmed. The Why is extended |
| Summary, Amendments | The POL-07 line is updated. A row "RFC-000 review: RQ-4 follow-up" is added |
| P1-N8, P1 constraints | State the order of offers and the partner-leg rule |
| Glossary | "Equivalent path" states the order, firmness on Share legs only, and the partner leg booked at acceptance |
| New | **P1-S58** `@need-P1-N8 @POL-07`: an all-Share path is offered before a path with a partner leg |
| New | **P1-S59** `@need-P1-N8 @POL-07`: a path with a partner leg is offered only when no all-Share path exists. It is held on its Share leg only, and the buyer is told that the partner leg is confirmed only at acceptance |
| New | **P1-S60** `@need-P1-N8 @POL-07`: acceptance books the partner leg, and once the partner confirms it, the reservation moves when the notice ends |
| New | **P1-S61** `@need-P1-N8 @POL-07`: a failed partner booking at acceptance releases the Share-leg hold at once. The reservation is revoked at the notice's end, with no charge for the removed period, and any other path still available is offered |

### D3. The probe account's funds (POL-06)

Decision: the probe account has a credit limit set by finance.

| Where | Change |
|---|---|
| POL-06 | New bullet. The probe account is Share-internal, with a `credit_limit` set by an operator in finance. Being Share's own, it counts as having passed know-your-business checks. Its credit holds are real, and it is never invoiced, since nothing it does is rated |
| Summary | The POL-06 line is updated |
| X2-N1 | States the rule |
| Glossary | "Available minute" and "Credit limit" state it |
| New | **X2-S24** `@need-X2-N1 @POL-06 @POL-15 @POL-32`: a probe booking takes a real credit hold against the probe account's `credit_limit`, set by finance, and the probe account is never invoiced |

### Serving regions (POL-06, X2)

Decision: the serving regions are R1 Nairobi and R2 Mombasa, both Share's own data
centres. R3 GCP Johannesburg is the third voting region.

| Where | Change |
|---|---|
| X2 constraints | New row, marked *Assumed*. R1 and R2 serve, and every per-region target applies to them. R3 votes on and keeps copies of state, but answers no buyer, supplier, exporter or payment provider, so it has no targets of its own. The design depends on this topology. "Out of scope" now points to it, and leaves only placement within the regions to the RFCs |
| POL-06 | The serving-region bullet says that the assumed topology is stated in X2's constraints. No rule depends on the region names |
| Glossary | "Serving region" names the assumed topology |
| Scenarios | None. This is an assumption, not behaviour |

## RQ-5 and RQ-6, from the revised RFC-000

These two issues come from the "Requirements issues" section of the revised RFC-000 (only
that section was read). The coordinator decided them; the decisions are binding. Each has
an Amendments row, "RFC-000 revision: RQ-n …".

### RQ-5. A confirmation decided in time may become known after the deadline (POL-26, POL-04)

Decision: a request is confirmed only by a decision entry timestamped before the deadline
less the completion margin. Such a confirmation may become known (reported) up to
`release_grace` after the deadline if the decision record was unavailable, and until then
status reads report pending. No confirmation is ever decided after the deadline.

| Where | Change |
|---|---|
| POL-26 | New bullet, "When a confirmation can be decided". It states the rule, with the completion margin of POL-02 (`commit_margin` with a partner leg, `ack_budget` otherwise). It replaces "a request is never confirmed after its deadline". The Share-link case of "Holds end at the deadline" adds that a confirmation decided in time makes the hold the reservation's. The Why gives the reason: no consensus log bounds when a proposed entry becomes durable, and voiding the entry could contradict a confirmation already reported |
| POL-04 | Status reads gain one exception: while the decision record is unavailable at the deadline, they report `pending` until it is available again, at most `release_grace` after the deadline |
| Summary | The POL-04 and POL-26 lines are updated |
| P2-N2, P2-N3, P2 C20 | Each states the rule; the measures are updated to match |
| Glossary | "Outcome", "Decision record" and "Status read" state the rule |
| P2-S99 | The last Then makes an exception for an unavailable decision record (P2-S106) |
| P2-S104 | A Given is added: "no confirmation of the request was decided before its deadline less its completion margin" |
| New | **P2-S106** `@need-P2-N3 @need-P2-N2 @need-P2-N10 @POL-26 @POL-04`. A confirmation is decided in time, and the decision record then becomes unavailable across the deadline. When the record returns, within `release_grace`, the request is confirmed and its holds are its reservation. Status reads report pending until then, never failed, and operations is alerted |

### RQ-6. Capacity is free from the moment the outcome is reported (POL-04)

Decision: capacity is free from the moment the outcome is reported, and its release is
durable before the outcome is reported. It is not free from the instant of the decision.

| Where | Change |
|---|---|
| POL-04 | New bullet, "Capacity is free once the outcome is reported". The Why is extended |
| P1-N3, P1-N7, P2-N2, P2-N3 | "the moment it has its outcome" now reads "from the moment its outcome is reported", in the need and in its measure |
| Glossary | "Capacity hold" states the rule |
| P2-S14 | Retitled "… free on Share links once the outcome is reported, and at a partner by the deadline". A Then is added: the hold on L1 is durably released before the outcome is reported. The capacity is available from the moment the outcome is reported. `@POL-04` is added |
| P1-S08 | The Given adds "and the outcome is reported (POL-04)", and `@POL-04` is added |

## Choices made in applying the decisions

These follow from the decisions, or from the review's proposed wording. The coordinator
has accepted them.

1. **RQ-1 alert.** The case where the decision record is unavailable at the deadline
   raises an operational alert. This comes from the review's proposed wording for RQ-1,
   and matches POL-26's existing alert for a request still pending at its deadline. RQ-2
   adds no alert, because the coordinator's decision does not include one.
2. **How long a declared region disaster lasts** (RQ-3). It lasts from the declaration
   until the lost region is restored or replaced, as RQ-3 proposed. This also bounds the
   existing exemptions for availability and charge timeliness, which were left open
   before.
3. **Which latency targets are suspended** (RQ-3). Every "Latency, …" row of POL-06 is
   suspended, the suspension-to-enforcement target included. The deadline rule (POL-26),
   `status_staleness` (POL-04) and the reporting of breaches of the exposure bound are
   not latency targets, so they still apply.
4. **The scope of the offer's hold** (RQ-4). The hold runs from the offer to the
   reservation's end, so an early move (P1-S53) never depends on availability. It counts
   as committed for new sales; otherwise P2-N4 ("no waiting request is rejected while its
   window fits on committed capacity") would leave buyers waiting days for the offer's
   answer. It is Share's own hold with no funds hold, so it does not conflict with
   POL-25's rule of "no capacity hold before the funds hold". The coordinator's
   wording ("held for `offer_window`") is read as "while the offer is open".
5. **The probe account counts as having passed know-your-business checks** (D3). This is
   so that POL-15's rule that a credit limit needs a vetted account, and P4's scenario
   for it, need no exception.
6. **The topology replaces the review's D1.** The review assumed two South African
   regions with R3 in Nairobi. The coordinator's topology (R1 Nairobi, R2 Mombasa, R3 GCP
   Johannesburg) is the one recorded.

## Open point

None. The partner-leg question raised in the first version of this record was decided by
the coordinator, and is applied above ("Follow-up").

## Mechanical checks

The checks were run with the official Cucumber parser (`@cucumber/gherkin` 42.0.1,
installed in a scratch directory) and a script over the parsed documents, the register,
the glossary, the problem statements and the conformance matrix. The script that the
earlier records used was not available, so these checks were written again. They were run
first on the committed baseline (374 scenarios), and the amended tree gives exactly the
same output as the baseline. That leftover output is false positives of the rewritten
script, the same before and after: file paths and tag notation in backticks, the glossary's
window notation, and one match of "horizon" in P1-S19.

| Check | Result |
|---|---|
| Every `.feature` parses as Gherkin (one Feature; Backgrounds and scenarios only in Rules) | 6 of 6 |
| Every scenario has a `When` and a `Then`; no step text starts with punctuation | Pass |
| Every Outline placeholder has its column; at most one unused column, and it is the last; no plain Scenario with Examples | Pass |
| Scenario IDs: exactly one per scenario, unique, prefixed by its file | 387 IDs, 387 unique |
| Every `@need-` tag names a need in a Needs table; every need cited | 66 needs, all cited, no dangling tag |
| Every `@POL-nn` exists in the register (33 entries) | Pass |
| Every `POL-nn` named in a scenario's title, steps, Examples or Rule Background is tagged | Pass |
| Glossary-term rule on a scenario's own steps and Examples | No new findings |
| Every backticked identifier in the specs, problem statements and glossary is a register parameter or a register-defined value | Pass (46 parameters, including `release_grace`); no new findings |
| Register: no round markers inside entries; every `POL-nn` reference exists | Pass |
| Conformance: one row per scenario, in file order, titles matching | 387 rows: 13 added, one retitled (P2-S14), none removed, every existing Design, Tests and Status cell kept |

## Not changed

- RFC-000 and the other RFCs are not edited. Their "Requirements issues" sections can point
  to this record.
- No new policy entry was needed. Every rule fits an existing entry.
- Only one scenario title changed (P2-S14, for RQ-6). No arithmetic in any scenario depends on the new rules.
