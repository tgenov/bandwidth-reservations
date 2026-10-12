# Requirements amendments from revision 2 of the detailed RFCs

| | |
|---|---|
| Resolves | The new "Requirements issues" of revision 2 of RFC-001 (`RQ-R1-13`, `RQ-R1-14`), RFC-002 (`B-RQ-9`), RFC-003 (`RQ3-13` to `RQ3-15`), RFC-004 (`RQ4-10` to `RQ4-12`), RFC-005 (`RQ5-11`, `RQ5-12`) and RFC-006 (`RQ6-1` to `RQ6-3`) |
| Decisions applied | Coordinator decisions (binding) for all 16 issues. Each is written into its register entry as a current rule, with a "RFC revision 2: …" row in the register's Amendments table (13 rows) |
| Files changed | `02-specs/policy-register.md`; all six `.feature` files; the P1, P3, P4, X1 and X2 problem statements in `01-discovery/`; `02-specs/glossary.md`; `02-specs/conformance.md` (regenerated); this record |
| Not read | Code, `history/` |
| Not edited | `03-rfcs/` |
| Date | 2026-10-12 |

## Outcome

16 issues, all amended as current rules. The baseline now has **448 scenarios** (was 437):
P1 78, P2 116, P3 73, P4 113, X1 39, X2 29. No ID was renumbered, reused or removed. The
11 new IDs continue each file's numbering:

- **P1-S76 to P1-S78**;
- **P3-S71 to P3-S73**;
- **P4-S111 to P4-S113**;
- **X1-S39**;
- **X2-S29**.

Retitled: P1-S14, P1-S40, P1-S67, X1-S36, X2-S27. Amended in place without a new title:
P3-S37, P4-S15 and P4-S16 (the recomputed lateness bound; P3-S37 also gains `@POL-13`),
X1-S12 and X1-S13 (an erasure row each). The P1 Rule "A permanent increase of a link's
capacity is sellable from the next minute boundary" is now "Every rise in a link's sellable
capacity takes effect from the first minute boundary at or after its record".

Needs: still 67, none new. Amended: P1-N1, P1-N2, P1-N8, P3-N7, P3-N10, P4-N5, P4-N13,
P4-N14, P4-N17, X1-N7, X1-N11, X2-N1, and one new X1 constraint marked *Assumed*
(`erasure_max`, legal to confirm per market). New parameters: **`erasure_max`** (POL-19,
30 days) and **`disaster_probe_minutes`** (POL-06, 5 consecutive minutes). There are now 50.
No new policy entry. New glossary terms: *Account slot*, *Record template*; defined inside
existing entries: *displacement record* (*Affected reservation*), *erasure* and *escrowed
copy* (*Personal data*), *measured fields* and *attribution keys* (*Flow record*),
*uncovered negative balance* (*Write-off*).

## Decisions by issue

All are coordinator decisions. "Where" lists the register entry first, then needs (N),
scenarios (S) and glossary (G).

| Issue | Decision | Trade-off | Where |
|---|---|---|---|
| RQ5-11, RQ6-1 | The data subject requests erasure through an administrator of its account (account or supplier administrator) or by a documented request to support. One compliance operator executes it, recorded with the request. It is complete in every copy (live store, backups, escrow) within `erasure_max` = 30 days of the request. Legal confirms the bound per market (*Assumed*) | Erasure has an owner, a path and a checkable bound; backups and escrowed keys must age out or be destroyed within 30 days, tighter than RFC-005's 44 and RFC-006's 35 | POL-19 (new parameter), POL-32 (compliance, both administrator rows); X1-N7, X1-N11, X1 constraints; S: **X1-S39**, X1-S12 and X1-S13 rows; G *Personal data*, *Operator* |
| RQ5-12 | Withholding a termination notice is decided as part of the termination action itself, approved with it; a later request to withhold is refused and the holder told | The only reading under which withholding can beat the 60 s notice; compliance must know of the order when it terminates | POL-30, POL-32; X1-N7; S: X1-S36 rewritten and retitled; G *Termination*, *Operator* |
| RQ3-13 | The lateness part of usage exposure = `usage_rate_cap` × (`max_lateness` + `flow_active_timeout` + 60 s of minute granularity + `attribution_lag_max` + the 60 s suspension-to-enforcement target) × the product's highest `usage_price`, lateness counted from the end of a record's last minute: 370 s at the defaults, matching RFC-003's derivation (decided in two steps; see the last-but-one section) | Covers traffic in a record still open at its exporter and in a record that straddles a minute boundary, at the cost of 120 s more of `usage_rate_cap` deducted from every account's headroom (15,000 micro-USD at P3-S37's price of 10,000 micro-USD per GB) | POL-14, POL-18; P3-N10; S: P3-S37, P4-S15, P4-S16 recomputed; G *Usage exposure* |
| RQ3-14 | A received payload that does not conform to the record template is rejected. The logs and the record kept of it hold only its identity, digest and reason. The payload itself is kept only in the erasable personal-data store, made unrecoverable on an erasure it falls under or `dispute_window` + 7 days after receipt, whichever comes first | No personal data reaches a log or record that cannot be erased; the payload stays available for a dispute, then goes | POL-19; P3-N7; S: **P3-S71**; G *Record template* |
| RQ3-15 | A superseding record may change only measured fields (bytes, packets, start and end times within the original's minutes), never the record's identity or attribution keys; one that tries is refused and recorded. A superseding record of a quarantined record is itself quarantined | An exporter cannot move traffic between accounts, reservations or minutes by "correcting" it; a record whose keys were wrong is never corrected by its exporter (RFC-003's reading, which let service keys change, was not adopted) | POL-23; P3-N7; S: **P3-S72**, **P3-S73**; G *Flow record*, *Quarantine* |
| RQ-R1-13 | Restorations, permanent increases and maintenance cancellations all take effect from the first minute boundary at or after they are recorded | One rule for every rise in sellable capacity; a cancellation recorded exactly on a boundary frees that minute | POL-07 (new *Every rise in sellable capacity*, maintenance bullet); P1-N8; S: **P1-S76**, P1-S67 and P1-S40 retitled; G *Planned maintenance booking* |
| RQ-R1-14 | "In the order received" for checks on a link is the order in which requests reach the link's schedule owner | The only order the link can see; requests from two accounts may be checked in the reverse of the order their accounts received them | POL-05; P1-N2; S: P1-S14 amended and retitled, **P1-S77**; G *Capacity hold* |
| B-RQ-9 | "Had begun committing when the reduction was recorded" is judged exactly, with no window, by whether the reduction's displacement record is visible to the transaction confirming the request | Exact and checkable from the records; a few more affected (credited, alerted) confirmations while the notice is in transit. RFC-002's bounded-window reading was not adopted | POL-07 *A confirmation already being decided*; P1-N1; S: **P1-S78**; G *Affected reservation* |
| RQ4-10 | A top-up repays a written-off amount first, then overdue invoices oldest first, then raises the balance (RFC-004's reading) | The older debt, already Share's loss, is repaid first; an overdue invoice stays overdue a little longer | POL-15, POL-21; P4-N5, P4-N17; S: **P4-S111**; G *Write-off*, *Resume amount* |
| RQ4-11 | The 90-day negative-balance clock runs only on N = max(0, −balance − invoiced and unpaid − charges posted since the last issue), from when N becomes greater than zero until it returns to zero (RFC-004's reading) | A credit-limit account's normal, invoiced negative balance is never written off by this clock; one more figure for receivables to keep | POL-21; P4-N13; S: **P4-S112**; G *Write-off* |
| RQ4-12 | A payment posted, not yet received and then reversed nets to zero with its reversal in the posted-not-received term, the two matched to each other, without an alert (RFC-004's reading) | No false alert for money that never reached the partner; the pair is matched to each other rather than to a partner transaction | POL-24; P4-N14; S: **P4-S113**; G *Reconciliation* |
| RQ6-2 | "Every part" of admission and the wallet serving accounts (X2-S27) means every account slot, each probed by at least one probe account every minute | No slot can fail unseen, at the cost of one probe account per slot (1,024 at RFC-006's design load) | POL-06; X2-N1; S: X2-S27 amended and retitled; G *Account slot*, *Available minute* |
| RQ6-3 | Network operations may declare a region disaster, with four eyes as before, on probe evidence (admission probes failing in that region for `disaster_probe_minutes`, 5, consecutive minutes) even with no recorded loss; the loss then counts from the first failing probe minute | A reachable but unusable region can be declared; up to five minutes of real failure leave the measurement on evidence the measurement itself produced. RFC-006's reading (only an unreachable region may be declared) was not adopted | POL-06, POL-32; X2-N1; S: **X2-S29**; G *Declared region disaster* |

## Choices made in applying the decisions

1. **"Failing" admission probes** means a minute that is not an available minute for
   admission in that region (fewer than 90% of its probes succeed), the measure POL-06
   already defines. A declaration with neither a recorded loss nor that evidence is
   refused (X2-S29's second row).
2. **The five minutes are a parameter**, `disaster_probe_minutes`, so that the specs name
   it rather than hard-coding it (README convention).
3. **`erasure_max` runs from the request**, not from its execution, so the operator's
   own delay counts within the bound.
4. **The administrator path covers supplier users too**: a supplier administrator passes on
   its users' erasure requests, as an account administrator does (POL-32).
5. **Attribution of a superseding record.** Since attribution keys cannot change, a
   superseding record of a record finance has attributed is charged to the same account,
   and one of a record whose attribution was reversed stays uncharged (POL-23). This
   follows from RQ3-15 and matches RFC-003's own reading.
6. **"Lateness counted from a record's last minute"** keeps POL-14's existing wording,
   from the *end* of that minute (P3-S68 unchanged).
7. **The displacement record** is named in the requirements (POL-07, glossary, P1-S78)
   because the coordinator's rule is stated in its terms. It is defined by what it
   records, not by how it is stored.

## RQ3-13: the window, decided in two steps

The first coordinator decision added one `flow_active_timeout` (310 s at the defaults).
This record then noted that RFC-003's RQ3-13 analysis needs more. A byte carried at τ can
be in a record whose last minute ends up to about 2 min after τ: a record of at most
`flow_active_timeout` that straddles a minute boundary ends in the next minute. With
lateness counted from the end of that minute, the window needed is 120 + 180 + 10 + 60 =
370 s, so 310 s left up to 60 s of traffic at the cap uncovered (0.75 GB at 100 Mbps).
The coordinator then decided to add one minute of minute-closure granularity. The bound
is now 180 + 60 + 60 + 10 + 60 = 370 s, which closes that gap and matches RFC-003's
derivation. POL-14, its Amendments row, the glossary, P3-N10, P3-S37, P4-S15 and P4-S16
state the final figure.

## Mechanical checks

The parser-based script of records 09 and 11 (`@cucumber/gherkin`) could not be run in this
session. The checks were run with a standard-library re-implementation of the same rules,
which reads the files' structure line by line rather than with the Cucumber parser. It
covers the same items, including Background placement, Examples tables and data tables. It
was run first on the committed baseline (`HEAD`), where it reproduced 437 scenarios, 67 needs,
33 entries and 48 parameters. The conformance matrix was regenerated: 11 rows added, 5
retitled, none removed, and every existing Design, Tests and Status cell kept.

| Check | Result |
|---|---|
| Every `.feature` has one Feature; Backgrounds and scenarios only in Rules; no stray lines | 6 of 6 |
| Every scenario has a `When` and a `Then`; no step starts with punctuation | Pass |
| Outline placeholders have columns; at most one unused column, and it is last; every row as wide as its header; no plain Scenario with Examples | Pass |
| Scenario IDs: one per scenario, unique, prefixed by file | 448 IDs, 448 unique |
| Every `@need-` tag names a need; every need cited | 67 needs, all cited |
| Every `@POL-nn` exists (33 entries); every `POL-nn` named in a title, steps, Examples or Rule Background is tagged | Pass |
| Every backticked identifier is a register parameter or defined value | Pass (50 parameters, 2 new) |
| Register: every `POL-nn` reference exists; no round markers inside entries | Pass |
| Conformance: one row per scenario, in file order, titles matching | 448 rows |

The only remaining output is five glossary-term hits that the baseline produced too, all
in scenarios this work did not touch and all a different sense of the word: P1-S56 ("not
left waiting" for an offer, not POL-05 waiting), P4-S107 (refers to P4-S97's fee), X1-S28
("termination points"), X1-S31 (a partner's recorded "cancellation fee" term) and X2-S23
(latency targets "suspended"). The arithmetic in the new and recomputed scenarios was
checked by hand:

| Scenario | Arithmetic |
|---|---|
| POL-14 bound | 180 + 60 + 60 + 10 + 60 = 370 s (was 250 s); 100 Mbps × 370 s = 37,000 Mb = 4.625 GB (was 3.125 GB) |
| P3-S37 | Lateness bound 4.625 × 10,000 = 46,250 micro-USD (was 31,250); usage exposure 2,000 + 46,250 = 48,250 (was 33,250) |
| P4-S15, P4-S16 | Lateness bound 0.046250 USD, usage exposure 0.002000 + 0.046250 = 0.048250 USD; headroom 1.000000 − 0.288000 − 0.048250 = 0.663750 USD (was 0.678750) |
| P1-S76 | 12 − 10 = 2 Mbps free from 09:31 in each row |
| P1-S77 | 10 − 8 = 2 Mbps: room for one of X and Y |
| P4-S111 | 2.000000 − 1.000000 (written off) − 0.500000 (I2) = 0.500000 USD to the balance |
| P4-S112 | max(0, 2.5 − 1.0 − 1.5) = 0; max(0, 3.0 − 1.0 − 1.5) = 0.5 USD |
| P4-S113 | +20.000000 − 20.000000 = 0 in the posted-not-received term |
| X2-S29 | Minutes starting 10:00 to 10:04 are 5 (declared); 10:00 to 10:03 are 4 (refused) |

No other scenario carries a figure that depends on the lateness bound. P4-S19 ("within its
lateness bound") states no amount.
