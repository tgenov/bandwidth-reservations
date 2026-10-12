# Requirements amendments from the detailed RFCs

| | |
|---|---|
| Resolves | The "Requirements issues" of RFC-001 (`RQ-R1-1` to `RQ-R1-12`), RFC-002 (`B-RQ-1` to `B-RQ-8`), RFC-003 (`RQ3-1` to `RQ3-12`), RFC-004 (`RQ4-1` to `RQ4-9`), RFC-005 (`RQ5-1` to `RQ5-10`) and RFC-006 (`RQ-A` to `RQ-F`), and RQ-13 of the revised RFC-000 |
| Decisions applied | Coordinator decisions (binding) for RQ4-1/B-RQ-1, RQ-R1-1/B-RQ-2, RQ5-8 and RQ-13; every other issue decided here. Each is written into its register entry as a current rule, with a "Detailed RFCs: …" row in the register's Amendments table (39 rows) |
| Files changed | `02-specs/policy-register.md`; all six `.feature` files; all six problem statements in `01-discovery/` (not the company profile); `02-specs/glossary.md`; `02-specs/conformance.md` (regenerated); this record |
| Not read | Code, `history/` |
| Not edited | `03-rfcs/` (RFC-000 is revised in parallel) |
| Date | 2026-10-12 |

## Outcome

58 issues: 56 are amended as current rules, and 2 needed no requirements change (RQ3-12,
RQ4-9; see the last section). The baseline now has **437 scenarios** (was 393): P1 75,
P2 116, P3 70, P4 110, X1 38, X2 28. No ID was renumbered, reused or removed. The 44 new
IDs continue each file's numbering:

- **P1-S63 to P1-S75**;
- **P2-S112 to P2-S116**;
- **P3-S63 to P3-S70**;
- **P4-S105 to P4-S110**;
- **X1-S31 to X1-S38**;
- **X2-S25 to X2-S28**.

Retitled: P1-S14, P1-S40, P1-S41, P2-S70, P2-S111, P3-S30, X1-S18, X2-S20, X2-S24.

Needs: 67 (was 66). The new need is **X1-N11** (personal data erasable without breaking the
audit). New parameters: **`approval_expiry`** (POL-32, 72 h) and **`settlement_lag_max`**
(POL-24, 7 days). There are now 48. No new policy entry; POL-32 gains a fifth operator role,
**commercial**. New glossary terms: *Supplier administrator*, *Personal data* (with
*pseudonymous identifier* under *Principal*), *Told*; *documented request* is defined under
*Operator*, *now* under *Selling horizon*, and *unavailable at the deadline* under
*Decision record*.

## Decisions by issue

"Coord." marks a binding coordinator decision. "Where" lists the register entry first, then
needs (N), scenarios (S) and glossary (G).

### RFC-001 Link schedule and admission

| Issue | Decision | Trade-off | Where |
|---|---|---|---|
| RQ-R1-1 | Coord. A request whose confirmation was already being decided (it had begun committing, POL-26) when a capacity reduction is recorded may complete. Its reservation is then affected like any confirmed one (flagged, holder told, SLA credits, in a permanent reduction's affected set), and network operations is alerted. Every request decided after the record is decided against the reduced capacity | No re-check of every hold at every decision (that would cost each booking a round trip). In exchange, rare millisecond-wide confirmations above the reduced capacity, each one credited and alerted | POL-07 *Any fall in capacity*; P1-N1, P1-N8; S: P1-S05, P1-S13, P1-S41, P1-S42 amended, **P1-S63**; G *Affected reservation* |
| RQ-R1-2 | An outage takes effect from the start of the minute in which it is recorded. Flags end, and capacity is sellable again, from the first minute boundary at or after the restoration's record | The holder gets every part minute; a restored part minute stays unsold | POL-07 *Unplanned outage*; P1-N8; S: P1-S40 (10:30:20 → 10:31); G *Affected reservation* |
| RQ-R1-3 | The affected set is recomputed whenever the schedule changes during the notice. A newly affected holder is offered a path at once; an offer once made stays open for its `offer_window`. What is removed is decided when the notice ends and is never more than then required | Nothing is removed that need not be; an offer can stay open for a reservation that no longer needs it | POL-07 step 2; P1-N8; **P1-S64** |
| RQ-R1-4 | A part is cut by the largest excess it meets at any minute of its window, after newer parts' cuts | Rates stay uniform (POL-08), at the cost of cutting more than a per-minute cut would at some minutes | POL-07 step 2; P1-N8; **P1-S65** (excess 1/3 Mbps → B cut by 3, to 1 Mbps); G |
| RQ-R1-5 | Maintenance fits only beside committed and held capacity. If only holds block it, it is rejected with `retry_after`, not queued. The supplier may cancel its own maintenance, freeing the capacity from the next minute boundary | It never takes capacity a pending request may confirm; retrying weeks ahead costs the supplier nothing | POL-07 *Planned maintenance*; P1-N8, X1-N10; **P1-S66**, **P1-S67**; X1-S22 row; G *Planned maintenance booking*, *`retry_after`* |
| RQ-R1-6 | Capacity held for an open offer counts as committed during an outage but is not flagged. The offer stays open and firm, and its holder is told within `affected_notice_time`. Once moved, the reservation is affected like any other | The buyer keeps a firm choice, with full information | POL-07; P1-N8; **P1-S68**; G *Affected reservation* |
| RQ-R1-7 | An operator in the new **commercial** role registers a link (with its capacity) and retires it once nothing is reserved, held, offered or booked as maintenance on it. A permanent increase is the supplier's own action and is sellable from the first minute boundary at or after its record | One more role to staff; links never vanish under reservations | POL-07 *Who may act*, *Permanent increase*; POL-32; X1-N10; **P1-S69**, X1-S22, X1-S23, X1-S13 rows, **X1-S31**; G *Link*, *Supplier* |
| RQ-R1-8 | For window rules, "now" is the minute boundary at or before the request's receipt. `selling_horizon` is 12 calendar months in UTC, ending on the last day of the month when the date does not exist | One horizon per request, whatever the decision time | POL-09; P1-N5, P1 constraints; **P1-S74**; G *Selling horizon* |
| RQ-R1-9 | Every counter-offer (no-fit rejections included) is computed beside committed and held capacity | Taking it confirms at once; it may understate what a later release would free | POL-10; P1-N4; **P1-S73**; G *Counter-offer* |
| RQ-R1-10 | With several blockers, `retry_after` is the latest of their remaining deadlines | A retry is never wasted, though it may come later than the first release | POL-05, POL-02, POL-10; P1-N4, P2-N4; **P1-S70**, **P2-S116**; G *`retry_after`* |
| RQ-R1-11 | Each part of a reservation moved to an equivalent path keeps its original age there | A buyer moved at Share's request is never made newest; later buyers on the path rank behind it | POL-07 step 6; P1-N8; **P1-S71**; G *Part of a reservation*, *Equivalent path* |
| RQ-R1-12 | Holders and network operations are told, within `affected_notice_time`, whenever a reservation's affected minutes change during an outage | The SLA position stays exact, for a few more notices | POL-07; P1-N8; **P1-S72**; G *Affected reservation* |

### RFC-002 Account owner and booking coordination

| Issue | Decision | Trade-off | Where |
|---|---|---|---|
| B-RQ-1 | Coord. (with RQ4-1) Funds, key-headroom and capacity-in-flight checks, and link checks, run one at a time in arrival order, each counting the holds then in place. Outcomes need only match that sequence, so two concurrent requests may both fail where a strictly serial run would have let one succeed | No request waits on another's outcome before its check; a rare double refusal that is retried at once | POL-25, POL-05; P1-N2, P2-N8, P4-N3; S: P1-S14, P2-S70, P4-S66 amended, **P2-S112**; G *Capacity hold* |
| B-RQ-2 | Coord. As RQ-R1-1. The RFC's "within `status_staleness`" bound was not adopted, because the request's deadline already bounds it | As RQ-R1-1 | As RQ-R1-1 |
| B-RQ-3 | *Rejected* includes a request a booking rule of POL-08 or POL-28 does not allow; the rejection states the rule | Names what the scenarios already did; no behaviour change | G *Outcome* |
| B-RQ-4 | As RQ-R1-10 | As RQ-R1-10 | As RQ-R1-10 |
| B-RQ-5 | A change request is the same request when it has the same reservation, kind of change, new end or new rate, and `wait`, from the same principal | Change retries are safe; a changed retry needs a new key | POL-29; P2-N6; **P2-S113**; G *Idempotency key* |
| B-RQ-6 | "Unavailable at the deadline" includes a decision record that was unavailable at any time in the last `ack_budget` before the deadline | Releases may become durable up to `release_grace` late in that case; the link is never oversold | POL-26; P2-N3; **P2-S114**; G *Decision record* |
| B-RQ-7 (and RFC-000 RQ-13) | Coord. (RQ-13) While the decision record is unavailable, a status read of an outcome not yet reported may report `pending` or the decided outcome, never a contrary one, and never `pending` once the outcome was reported | Buyers may learn the outcome sooner; no extra round trip on every report | POL-04; P2-N2; S: P2-S111 retitled and amended, P2-S106 ("pending or confirmed, never failed"); G *Status read* |
| B-RQ-8 | A decrease over a partner leg whose shown terms do not allow one is **rejected**, stating the rule; the buyer may cancel instead. The RFC's proposal, that Share keep paying the partner, was not adopted | The RFC's proposal would leave Share paying open-endedly for partner capacity the buyer dropped. The buyer was shown the terms at booking, and can still cancel | POL-08; P2-N9; **P2-S115**, P2-S50 amended; POL-32 (commercial records the term) |

### RFC-003 Rating and metering

| Issue | Decision | Trade-off | Where |
|---|---|---|---|
| RQ3-1 | Commercial sets `reservation_price` and `usage_price` and the split weights, each with four eyes, and records partner terms. Finance sets `usage_rate_cap` | A new role and approvals; no unowned power over prices | POL-32, POL-01, POL-12, POL-14, POL-27; X1-N7; **X1-S31**, X1-S12/S13 rows; G *Operator* |
| RQ3-2 | Only the exporter that produced a record submits a corrected version, under its own credential. No operator path | Operators can never create traffic; a supplier fixes its own exporter | POL-23, POL-32; P3-N7, P3-N9; P3-S30 amended |
| RQ3-3 | Finance may reverse a mistaken attribution within `dispute_window`. The buyer's charge goes to zero as a correction with cause Share, the supplier keeps its payment, and the traffic is not attributed again. The RFC's "first attribution wins" was not adopted | Under the RFC's rule a wrongly charged buyer could not be refunded. Here Share bears its own error, and the supplier is never paid twice | POL-17, POL-23, POL-32; P3-N6; **P3-S65**, X1-S12 row; G *Quarantine* |
| RQ3-4 | A shorten whose new end falls inside a partner's minimum term incurs the shown fee, paid as for a cancellation | The same conduct carries the same fee | POL-08; P3-N12, P2-N9; **P3-S63**; G *Cancellation fee* |
| RQ3-5 | A notified price change of an open-ended reservation applies to every part, parts added later included, from its effective minute | One price per reservation, as the buyer was told | POL-27; P3-N1; **P3-S64** |
| RQ3-6 | Every `dispute_window` runs from the end of the traffic's or charge's minute | One date per minute | POL-17; P3-N6; **P3-S70**; G *Quarantine* |
| RQ3-7 | If the last leg is a partner link Share does not meter, the egress count is the count at the hand-off to that partner | Bills the last count Share can stand behind | POL-17; P3-N13; **P3-S67**; G *Traffic* |
| RQ3-8 | The dearer-path difference per minute is the path's charge, computed exactly and rounded down once, less the buyer's charge | Exact and reproducible | POL-07 step 4, POL-23; **P4-S110**; G *Equivalent path* |
| RQ3-9 | Lateness is counted from the end of the last minute a record was active in | A long record is not late merely for being long | POL-14; P3-N10; **P3-S68**; G *Lateness* |
| RQ3-10 | Every `usage_price` (best-effort, burst, traffic outside a reservation) changes only with `price_notice` | Keeps the exposure bound sound; less pricing agility for Share | POL-14, POL-27; **P3-S69**; G *Usage price* |
| RQ3-11 | Within `dispute_window` of the original's last minute, an exporter may submit a corrected version of a wrong accepted record, which supersedes it for charging; the original is kept. The resulting amendment is borne by whoever's exporter erred | Overbilled buyers are made whole; the erring party pays | POL-23; P3-N7, P3-N8; **P3-S66** |
| RQ3-12 | No change; see below | — | — |

### RFC-004 Wallet, ledger and settlement

| Issue | Decision | Trade-off | Where |
|---|---|---|---|
| RQ4-1 | Coord. As B-RQ-1. The RFC's wording for P4-S66 was adopted | As B-RQ-1 | POL-25; P4-N3; P4-S66, **P2-S112** |
| RQ4-2 | From the minute a reservation ends, nothing is held for its later charges. Unposted earlier charges, and any fee due, stay held until posted | Accrued charges stay within funds held | POL-15; P4-N3; P4-S11, P4-S61; G *Funds hold* |
| RQ4-3 | Any other negative balance is written off 90 days after it arose | Every debt has a clock | POL-21; P4-N13; **P4-S107**; G *Write-off* |
| RQ4-4 | In-flight terms are counted per transaction at the partner's USD amount, so an FX difference posted after the cut is not a difference | — | POL-24; P4-N14; **P4-S109**; G *Reconciliation* |
| RQ4-5 | The receivable Share funds is a supplier's net negative balance | Makes the safeguarding corollary true | POL-24; P4-N14; G *Reconciliation* |
| RQ4-6 | A top-up to a credit-limit account with an overdue invoice pays its overdue invoices first, oldest first. The RFC's reading ("no") was not adopted | Under the RFC's reading, a buyer who topped up to resume would stay suspended. Here they resume, and Share collects its oldest receivable first | POL-15, POL-16; P4-N5, P4-N17; **P4-S105**; G *Resume amount* |
| RQ4-7 | A third in-flight term: payments the ledger has posted that the partner has not yet received. Each alerts if not received within `settlement_lag_max` (7 days) | Card-like providers can be used without daily false alerts; Share bears settlement risk, bounded by the alert | POL-24 (new parameter); P4-N14; **P4-S106**, P4-S54 row; G *Reconciliation* |
| RQ4-8 | Goes beyond the RFC's "confirm the reading". A price notice states the hold the new price needs and, if headroom would not cover it, the top-up that would. At the effective minute, the low-balance warning comes before or with the suspension notice | The buyer gets the whole notice period to act | POL-27; **P4-S108** |
| RQ4-9 | No change; see below | — | — |

### RFC-005 Security and tenancy

| Issue | Decision | Trade-off | Where |
|---|---|---|---|
| RQ5-1 | The endpoints a supplier sees are its own link's termination points. Usage-priced shares are shown by an opaque charge-line reference | Suppliers can still provision; a buyer's site no longer links its reservations | POL-33; X1-N2; X1-S28 amended; G *Reservation reference*, *Statement* |
| RQ5-2 | A read needed to prepare an action belongs to that action's role and is recorded. Reading the audit trail is a compliance read | Support is not a back door to every record | POL-32; X1-N7; **X1-S31**, X1-S13 row; G *Audit record* |
| RQ5-3 | A legal-order disclosure has the order's scope (by default, the buyer's reservations on that supplier's links). It lasts to the order's end date or until compliance ends it (one operator). The buyer is told only if compliance records that the order allows | Disclosure is bounded; the buyer is usually not told | POL-33, POL-32; X1-N2; **X1-S35** |
| RQ5-4 | `approval_expiry` (72 h). The requester may cancel; preconditions are rechecked at approval | Stale requests cannot take effect; approvers must act within 3 days | POL-32 (new parameter); X1-N7; **X1-S32** |
| RQ5-5 | Account administrators manage users, administrator rights (at least one kept) and webhook endpoints. Supplier administrators manage supplier users, credentials and endpoints | Every redirecting power stays with the account | POL-32; X1-N9; X1-S18, X1-S19, X1-S25 rows, **X1-S33**, **X1-S38**; G *Account administrator*, *Supplier administrator* |
| RQ5-6 | Role grants, administrator rights, consents, policy settings and webhook endpoints are attributable. Vetting stays out of scope | — | POL-19; X1-N8, X1 out of scope; X1-S14 amended; G *Audit record* |
| RQ5-7 | The holder is always told of a termination, unless compliance, with four eyes, records a legal order forbidding it | Told by default; withholding needs evidence and two people | POL-30, POL-32; **X1-S36**, X1-S17 amended; G *Termination* |
| RQ5-8 | Coord. Personal data is never in logs or audit; principals are recorded by pseudonymous identifiers. Personal data is held apart and erasable so it cannot be recovered (for example by destroying its key). Financial and audit records keep the pseudonym for 7 years | Erasure and an immutable audit both hold; raw records show no names | POL-19, POL-24; new **X1-N11**, X1 constraints; **X1-S34**, **X1-S37**; G *Principal*, *Personal data*, *Audit record* |
| RQ5-9 | A documented request is one made through the marketplace by an authenticated principal of the account who may make that change, and recorded | Off-channel requests are refused | POL-32, POL-08; X1-N7; X1-S27 rows; G *Operator* |
| RQ5-10 | A withdrawal stops all new disclosure. Reservations confirmed after it are unlinkable; references already seen stay as they are | Promises only what Share can keep | POL-33; X1-N2; X1-S30 amended; G *Reservation reference* |

### RFC-006 Availability and operations

| Issue | Decision | Trade-off | Where |
|---|---|---|---|
| RQ-A | Network operations declares a region disaster, and its end, with reason and evidence, approved by a second network operations operator | Guards a self-serving action; the declaration may come slightly later, but under RQ-B that costs nothing | POL-06, POL-32; X2-N1; **X2-S25**, **X1-S31**; G *Declared region disaster* |
| RQ-B | The disaster counts from the loss as the system recorded it, not from the declaration. A loss never declared counts against every target | The figure does not depend on operator speed and cannot be backdated | POL-06; X2-N1, X2-N3; **X2-S26**, **X2-S28**, X2-S23 amended |
| RQ-C | Several designated probe accounts, spread so that every part of admission and the wallet serving accounts is probed, plus a designated probe supplier owning the probe links | A representative measurement, and a payouts probe at all | POL-06; X2-N1; X2-S20 (row added), X2-S24, **X2-S27**; G *Available minute* |
| RQ-D | Every percentile target is per calendar month and per serving region | One figure per region per month; a bad hour can hide in a good month | POL-06; X2-N3; X2-S05, S06, S07, S15 amended |
| RQ-E | A principal has been told once the notice is recorded in its account's notice list and its first delivery attempted, within the time; delivery is then retried for `webhook_retry` | Share answers for what it controls | POL-04; P1-N8; **P1-S75**; G *Told* |
| RQ-F | Go-live condition: two diverse Nairobi–Mombasa paths, plus one path from each serving region to Johannesburg not via the other, all four pairwise without shared risk | A stricter production gate, matching the design's cut analysis | POL-06; X2 constraints; G *Serving region* |

## Choices made in applying the decisions

1. **"Already being decided" is "had begun committing"** (POL-26's existing term), so
   RQ-R1-1 adds no new state. It is bounded by the request's deadline.
2. **Link capacity checks follow the same arrival-order rule** (POL-05) as the funds and
   limit checks (POL-25), since the coordinator's decision covers P1-S14.
3. **Commercial is a new role, not a finance duty.** Finance corrects prices, so if it also
   set them, one role would both make and correct the same mistakes.
4. **POL-32 also names the non-operator owners** (account administrator, supplier
   administrator, a supplier's users, an exporter), so that every action has exactly one
   owner.
5. **RQ-13** arrived during this work and is the same rule as B-RQ-7. It shares B-RQ-7's
   Amendments row and is cited in POL-04's provenance.

## Mechanical checks

The checks used the official Cucumber parser (`@cucumber/gherkin` 42.0.1) and the same
check script as record 09, run over the parsed features, the register, the glossary, the
problem statements and the conformance matrix. The conformance matrix was regenerated: 44
rows added, 9 retitled, none removed, and every existing Design, Tests and Status cell kept.

| Check | Result |
|---|---|
| Every `.feature` parses as Gherkin (one Feature; Backgrounds and scenarios only in Rules) | 6 of 6 |
| Every scenario has a `When` and a `Then`; no step starts with punctuation | Pass |
| Outline placeholders have columns; at most one unused column, and it is last; no plain Scenario with Examples | Pass |
| Scenario IDs: one per scenario, unique, prefixed by file | 437 IDs, 437 unique |
| Every `@need-` tag names a need; every need cited | 67 needs, all cited |
| Every `@POL-nn` exists (33 entries); every `POL-nn` named in a title, steps, Examples or Rule Background is tagged | Pass |
| Every backticked identifier is a register parameter or defined value | Pass (48 parameters, 2 new) |
| Register: every `POL-nn` reference exists; no round markers inside entries | Pass |
| Conformance: one row per scenario, in file order, titles matching | 437 rows |

The only remaining output is the same false positives the baseline produced: file paths and
tag notation in backticks, the glossary's window notation, and "horizon" in P1-S19's
Examples, which has been there since before this work. The arithmetic in the new scenarios
was checked by hand:

| Scenario | Arithmetic |
|---|---|
| P1-S65 | Excess over 7 Mbps is 8 − 7 = 1 Mbps outside E's window and 10 − 7 = 3 Mbps within it. B is cut by 3, to 1 Mbps |
| P1-S70 | 10 − 8 held = 2 Mbps |
| P1-S73 | 10 − 8 − 1 = 1 Mbps |
| P3-S64 | 150 Mbps × 3 micro-USD = 450 micro-USD a minute |
| P3-S66 | 1 GB × 10,000 = 10,000 micro-USD; amendment 10,000 − 20,000 = −10,000 micro-USD |
| P4-S105 | Balance −1 + 1.5 = 0.5 USD; headroom 0.5 + 5 − 0.288 = 5.212 USD |
| P4-S108 | Hold 100 × 3 × 1,440 = 0.432 USD; needs 0.144 USD more; top-up 0.144 − 0.100 = 0.044 USD |
| P4-S110 | Buyer ⌊3 × 1.5⌋ = 4; path ⌊3 × 2.7⌋ = 8; Share bears 8 − 4 = 4 micro-USD |
| P4-S106 | 100 − 20 = 80 USD |
| POL-14 bound | Unchanged: 250 s at 100 Mbps = 3.125 GB |

## No requirements change: RFC readings, not requirements defects

- **RQ3-12** (unposted usage "until posted, and no longer"). The requirement is exact as it
  stands. The RFC already meets it by pairing the unposted-usage figure with the ledger
  position it was computed at. Without that pairing, the design would double-count; that
  is an obligation on the design, not a tolerance the requirement should allow. The
  requirement is unchanged.
- **RQ4-9** (key spending, each minute counted once, with posting lag). The RFC's reading,
  posted charges in the period plus current holds, is what POL-25 already says. Nothing
  is ambiguous, so the requirement is unchanged.

Also partly RFC-side: **RQ-R1-6, RQ-R1-11 and RQ-R1-12**. RFC-001 handed these to RFC-002
or RFC-006 instead of raising them as requirements gaps. They are requirements gaps, and
they are now decided in POL-07.
