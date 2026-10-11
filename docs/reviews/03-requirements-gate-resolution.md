# Resolution of requirements gate reviews A and B, round 2

| | |
|---|---|
| Resolves | [Gate A round 2](03-requirements-gate-a.md) (GA2-01 to GA2-23: P1, P2, X1; PASS WITH FIXES) and [gate B round 2](03-requirements-gate-b.md) (GB2-01 to GB2-24: P3, P4, X2; FAIL on GB2-01) |
| Policy inputs | Policy register round 5: "Amended (round 5)" paragraphs on POL-02, 06, 07, 08, 10, 11, 12, 15, 16, 21, 22, 23, 24, 25, 26, 27, 28; new POL-32 (operator roles) and POL-33 (what suppliers see). These are the gate reports' "Decisions taken" (gate A D-01 to D-12, gate B D1 to D16) |
| Files changed | All six `.feature` files; all six problem statements in `01-discovery/`; `02-specs/glossary.md`; `02-specs/conformance.md` (regenerated); `README.md` (tag and Examples conventions); `reviews/02-requirements-gate-resolution.md` (stale lines corrected); this record |
| Not changed | `02-specs/policy-register.md` (already updated for round 5). Two further decisions this revision needed are listed under "Round-6 decisions for the register" and are applied in the specs |
| Date | 2026-10-11 |

## Conventions used in this round

- **Scenario IDs.** No ID was renumbered, reused or removed. New IDs continue each file's
  numbering (P1 from S48, P2 from S87, P3 from S58, P4 from S90, X1 from S25, X2 from S18)
  and sit in the Rule they belong to. X1-S13 became an Outline under the same ID (one
  row per role); X1-S01 and X1-S12 gained a column.
- **Policy tags, checked mechanically.** The check now covers, for every scenario: one ID;
  at least one `@need-` tag naming a need that exists; every need cited; IDs unique;
  every `@POL-nn` in the register; every `POL-nn` named in the steps, the Examples **or
  the Rule's Background** tagged (GA2-17, GB2-20); and every policy that defines a
  glossary term the steps use ("headroom" → POL-18, "suspended" → POL-16, "waits" →
  POL-05, "insufficient funds" → POL-15, "counter-offer" → POL-10) tagged. Every Outline
  placeholder has its column; no plain Scenario has Examples. All checks pass on the 353
  scenarios. The convention is written into `README.md`.
- **Explanatory Examples columns** (`case`, `why`, `parts left`) are kept and the
  convention recorded in `README.md`: one trailing column used in no step, documentation
  only (GB2-23).
- **Amounts** use the POL defaults throughout: 2 micro-USD per Mbps-minute in P4 and in
  P3's reservation Rule, `coverage_window` 24 h, `low_balance_warning` = max(a quarter of
  one window's charges, 1 USD).

## Scenario counts

| File | Before | After | New IDs |
|---|---|---|---|
| P1-link-admission.feature | 47 | 53 | S48 to S53 |
| P2-route-reservation.feature | 86 | 92 | S87 to S92 |
| P3-rating-and-metering.feature | 57 | 60 | S58 to S60 |
| P4-wallet-and-settlement.feature | 89 | 102 | S90 to S102 |
| X1-security-and-tenancy.feature | 24 | 28 | S25 to S28 |
| X2-non-functional.feature | 17 | 18 | S18 |
| **Total** | **320** | **353** | **33** |

66 needs, all cited. No need was added; several needs and success measures were
reworded (P1-N1, N4, N8; P2-N3, N4, N7, N8, N11; P3-N1, N5, N12; P4-N3, N4, N5, N8, N11 to
N15, N17; X1-N2, N7, N10; X2-N1, N3, N5).

## Arithmetic checked

Every Examples row and worked figure added or changed was recomputed.

- **Reconciliation (P4-S90, S91):** −5.000000 + 4.250000 + 5.000000 − 0 = 4.250000;
  −10.000000 + 8.500000 + 10.000000 = 8.500000; 0 + 120.000000 + 0 − 120.000000 = 0;
  50.000000 + 35.000000 + 15.000000 = 100.000000 (supplier balances 50 and −15). S91:
  −5.000000 + 4.250000 + 0.750000 = 0, the identity holds, but 0.750000 < 5.000000
  receivable, so the safeguarding alert fires.
- **Insufficient-funds quote (P2-S38, S75):** 0.288000 − 0.200000 = 0.088000, + 1.000000 =
  1.088000; 0.000960 − 0.000500 = 0.000460, + 1.000000 = 1.000460. `low_balance_warning`
  is 1 USD in both (a quarter window is 0.072000 or less).
- **Overdue invoice (P4-S92, S93):** −1.000000 − 0.288000 + 5.000000 = 3.712000 ≥ 1;
  after paying 1.000000: 0 − 0.288000 + 5.000000 = 4.712000.
- **After a write-off (P4-S94):** 4.000000 all to Share, 0.700000 still owed; 5.700000 −
  4.700000 = 1.000000 = `low_balance_warning` with no reservations; 11.000000 − 10.000000
  = 1.000000.
- **Fee hold (P4-S96, S97):** coverage 100 × 1,440 × 2 = 288,000 micro-USD; at release
  0.500000 − 0.288000 = 0.212000 left, 0.212000 − 0.500000 = −0.288000 = min(fee,
  coverage).
- **Price change not covered (P4-S101):** 0.388000 − 0.288000 = 0.100000 headroom; new hold
  100 × 1,440 × 3 = 432,000, growth 0.144000 > 0.100000; accrual 100 × 3 = 300.
- **Rate cut (P4-S60 row 5, P3-S58):** 50 × 1,440 × 2 = 144,000; 4 × 2 = 8 and 2 × 2 = 4.
- **Equivalent path (P3-S59):** dearer: 100 × 2 = 200 charged, Share pays 100 × (3 − 2) =
  100; cheaper: 100 × 1 = 100, Share pays 0.
- **Key spending (P4-S68 row 5, S98):** 0.800000 + 0.288000 = 1.088000; key headroom
  min(10, 1.000000 − 1.088000) = −0.088000.
- **Webster (recomputed by program):** 10,000 among 3000/3333/2167/1500 gives exactly
  3,000/3,333/2,167/1,500 (P4-S56, commission share not posted). Supplier "s" on legs 1
  and 3 (weight 1 + 1), "t" on leg 2 (weight 2), Share 1: 1 → 1/0/0 (tie s–t broken at
  s's first leg), 2 → 1/1/0, 3 → 1/1/1, 4 → 2/1/1 (P4-S102). Counting "s" as two parties
  would give 3 → s 2, t 1, Share 0, so the rows discriminate.
- **Fee as a charge line (P3-S60):** 0.500000 USD = 500,000 micro-USD exactly.
- **Capacity:** P1-S12 10 − 6 = 4, first fitting hour [11:00, 12:00); P2-S18 10 − 8 = 2,
  [11:00, 12:00); P1-S48 9 ≥ 8 committed; P1-S49 7 > 6; P1-S50 4 + 4 + 2 = 10 > 6 for
  [10:00, 12:00), 2 ≤ 6 for [12:00, 13:00); P1-S51 8 > 6; P1-S52 8 → 6 takes 2 of B;
  P2-S87 after A is confirmed at 8 on L1 and L2, B (L2) and C (L1) need 8 + 8 > 10.
- **Timeliness (X2-S13):** 2 min + 5 min RTO = 7 min; `max_lateness` + 2 + 5.

P1's outage Background moved A and B to [09:00, 12:00) so that both are active when the
09:00 outage is recorded, as POL-07 round 5 requires for "told within
`affected_notice_time` of the record". S24, S27, S41 and S42 still hold with that change
(8 + 1 > 6; 8 + 2 = 10; 8 + 2 > 6; 8 + 2 + 1 > 10).

## Gate B findings (Blocker first)

| ID | Resolution | Where |
|---|---|---|
| GB2-01 | **Done (Blocker; POL-24 r5, D1).** The invariant is restated with signed buyer and supplier balances and payouts executed but not yet confirmed, plus the safeguarding rule. S54 row 1 restated. New S90 reconciles with no alert on the reversal numbers (5 / 4.25 / 0.75, Share pre-funding), a credit-limit account mid-cycle, a payout in flight and a supplier debt. New S91 alerts when Share's own balance does not cover the receivables it funds, although the sums agree. Glossary "Reconciliation", "Share's own account" | P4-N14; P4-S54, S90, S91; glossary |
| GB2-02 | Done. "Key spending" replaced by POL-25 r4's cumulative wording | glossary |
| GB2-03 | Done. "Resume amount" restated per POL-16 r4 (and r5: overdue invoices; written-off amounts) | glossary |
| GB2-04 | Done (POL-10 r5, D2). Two amounts: 0.088000 / 1.088000 and 0.000460 / 1.000460 | P2-S38, S75; P2-N8; glossary "Counter-offer" |
| GB2-05 | Done (POL-16 r5, D3). New S92 (stays suspended at 3.712000 headroom while the invoice is overdue) and S93 (paying it resumes) | P4-S92, S93; P4-N5, N17; glossary "Resume amount" |
| GB2-06 | Done (POL-21 r5, D4). New Outline S94 over both write-offs: stays suspended, a top-up first repays Share, then resumes by the POL-16 rule; after an invoice write-off, prepaid with no credit limit. S53 and S83 now say the amount stays owed; S83 removes the credit limit | P4-S53, S83, S94; P4-N13; glossary "Write-off", "Suspension" |
| GB2-07 | Done (POL-22 r5, D5). New S95 with the gate's text, netted and invoiced like any debt, shown as "duplicate payout", not in the deviation | P4-S95; P4-N12; glossary "Supplier debt", "Statement" |
| GB2-08 | Done (POL-06 r5, D6). Probe operation and per-probe limit per capability in X2-N1 and new X2-S18; X2-S16 refers to it | X2-N1, N3; X2-S16, S18; glossary "Available minute" |
| GB2-09 | Done (POL-06 r5, D7). X2-S10 rows "usage ingestion" (1 min) and "rating and posting" (5 min); X2-S13 restated: 99.99% of a month's minutes within target, every charge within target + 5 min | X2-N1, N3, N5; X2-S10, S13; P3 (timeliness paragraph) |
| GB2-10 | Done (POL-08 r5, D8). P3-S44 row (cancelled after a POL-07 cut: Share pays), P4-S77 row (Share pays the partner), P3-S58 (accrual 8 → 4 from the end of the notice), P4-S60 row (hold 0.144000) | P3-S44, S58; P4-S60, S77; P3-N1, N12; glossary "Cancellation fee" |
| GB2-11 | Done (POL-15 r5, D9). New S96 (fee part ends with the minimum term, hold 0.288000) and S97 (release: 0.212000 left, fee 0.500000, balance −0.288000 under POL-21 and POL-23) | P4-S96, S97; P4-N3, N5; glossary "Funds hold" |
| GB2-12 | Done (POL-07 r5, D10). New P3-S59 (dearer 3 → 200 charged, Share pays 100; cheaper 1 → 100 charged); P4-S77 row 2 limited to a dearer path; P1-S31, S35 offer the lower price | P3-S59; P4-S77; P1-S31, S35; glossary "Equivalent path" |
| GB2-13 | Done (POL-23 r5, D11). S56 restated on "R1": 3,000 / 3,333 / 2,167 micro-USD from Share's own account, no commission share | P4-S56; P4-N11; glossary "Split" |
| GB2-14 | Done (POL-12 r5, D12). Glossary "Split"; new P4-S102 makes the rule testable (weights summed, tie at the first leg) | glossary; P4-N8; P4-S102 |
| GB2-15 | Done (POL-25 r5, D13). P4-S68 row with spending 1.088000 and key headroom −0.088000; new S98: blocks only that key's bookings and additions, nothing ended, other keys unaffected | P4-S68, S98; P4-N4; P2-N8; glossary "Key headroom" |
| GB2-16 | Done (POL-11 r5, D14). Third kind of charge line in the glossary, P3 and P4 Context and header comments; new P3-S60 (exactly 500,000 micro-USD, once, not split) | glossary "Charge line", "Charge", "Cancellation fee"; P3, P4 Context; P3-N5, N12; P3-S60 |
| GB2-17 | Done. S57 rows: transfer failure report, Share-borne cost movement, cancellation-fee settlement, supplier-debt posting. New S99 (source reference reused by another principal: refused) and S100 (redelivery after 400 days moves nothing) | P4-N15; P4-S57, S99, S100 |
| GB2-18 | Done (POL-32, D15). X1-S12 rows for setting or removing a `credit_limit` and resolving payout and orphan-reversal escalations, all finance; P4-S82 names the finance role | X1-N7; X1-S12; P4-S82, S83; P4-N17; glossary "Credit limit" |
| GB2-19 | Done. Glossary `usage_rate_cap` (all usage-priced traffic), "Usage exposure" (highest price, unposted usage per POL-18 r4), "Write-off" (from the reversal or the due date), decimal KB/TB/PB; P4-N3 "is resized with a price change" | glossary; P4-N3 |
| GB2-20 | Done. `@POL-01`, `@POL-27`, `@POL-17` added to every P3 scenario under a Background naming them; `@POL-22` on P4-S47 and S50. The mechanical check now includes Backgrounds | P3 (30 scenarios); P4-S47, S50; README |
| GB2-21 | Done. "Beyond the reversed amount, Share bears at most one coverage window of grace charges, 0.288000 USD" | P4-S70; P4-N13 |
| GB2-22 | Done. P3-S37 states 10,000 micro-USD per GB for the unposted minutes; P2-S39 says "K's only current reservation" | P3-S37; P2-S39 |
| GB2-23 | Done by convention. The columns are kept and the convention recorded in the README | README |
| GB2-24 | Done (POL-27 r5, D16). New S101: the price takes effect (300 a minute), the 0.144000 growth exceeds the 0.100000 headroom, the account is suspended after its earlier warning | P4-S101; P4-N3, N5; glossary "Funds hold", "Suspension" |

## Gate A findings

| ID | Resolution | Where |
|---|---|---|
| GA2-01 | Done (POL-02 r5, D-01). Glossary "Crossing" restated as a younger waiting request holding what an older waiting request needs; P2-N4 measure: no set of waiting requests stays blocked on each other's holds. New S87 (three-way cycle on L1, L2, L3: B and C release, A confirmed before any deadline) and S88 (A fails, B confirmed, C rejected) | P2-N4, C5; P2-S87, S88; glossary "Crossing", "Contention guarantee"; P1 constraints |
| GA2-02 | Done (POL-02 r5, D-02). New S89: a partner refusal while another Share request holds overlapping capacity at P makes B wait and ask again. S31 now states that no other Share request holds capacity at P, and has a Given (GA2-19) | P2-N4, C5; P2-S31, S89; glossary "Waiting" |
| GA2-03 | Done. P1-N1 and its measure restated as a property of each confirmation at the moment it is made; P1-S13 likewise | P1-N1; P1-S13 |
| GA2-04 | Done (POL-10 r5, D-03). Earliest window at or after the requested start. P2-S73 now correct as written | P1-N4; P2-N11; glossary "Counter-offer" |
| GA2-05 | Done (POL-07 r5, D-04). Glossary, P1-N8 and P1-S25 align: affected at the minutes where committed > reduced capacity, all alike. New S48 (cut to 9 with 8 committed affects none), S49 (a booking a month ahead is rejected at 6 Mbps), S50 (C starting during the outage is flagged for [10:00, 12:00) only and told within `affected_notice_time` of its start). Background moved to [09:00, 12:00) so A and B are active at the record | P1-N8; P1-S25, S48 to S50; glossary "Affected reservation" |
| GA2-06 | Done (same fix as GB2-02); "Key headroom" aligned | glossary |
| GA2-07 | Done (same fix as GB2-03) | glossary |
| GA2-08 | Done. D-05: P1-S29 states both recourses, new P1-S51 (works done anyway are an unplanned outage attributed to the supplier). D-06: P2-S32 (daily, by 12:00 UTC on D + 1), new S90 (unknown result re-queried at once), new S91 (both mismatch kinds). D-07: new P2-S92 (no capacity hold before the funds hold). D-08: new X1-S28. D-09: X1-S12, S13 (role table), S16, S17, S23, new S26 (second compliance approval), new S27 (support). Open questions removed: P1 q2, P2 q1 and q3, X1 q1 and q2 | P1-S29, S51; P2-S32, S90 to S92; X1-S12, S13, S16, S17, S23, S26 to S28; P1, P2, X1 open questions |
| GA2-09 | Done (POL-07 r5, D-10). New P1-S52: accept moves all 4 Mbps; decline removes only the affected 2 Mbps | P1-S52; P1-N8; glossary "Equivalent path" |
| GA2-10 | Done. New P1-S53: moving early from a chosen minute boundary; B then holds nothing on the link | P1-S53 |
| GA2-11 | Done (same row as GB2-10) | P3-S44 |
| GA2-12 | Done (POL-26 r5, D-11). P2-S23: failed as of its deadline, later status reports it, nothing held after the deadline; tagged `@POL-26` | P2-S23; P2-N3, C20; glossary "Outcome", "Capacity hold" |
| GA2-13 | Done (POL-02 r5, D-12). P2-S61: "deadline passed while waiting" with a `retry_after`. P1-S12 and P2-S18 carry the counter-offer computed beside the capacity in flight | P1-S12; P2-S18, S61; P1-N4 |
| GA2-14 | Done. Glossary "Deadline" per POL-26 r4 (`route_deadline_min`; `commit_margin` only with a partner leg) | glossary |
| GA2-15 | Done. Glossary "Reservation" reworded as proposed | glossary |
| GA2-16 | Done (same fix as GB2-19) | glossary "Write-off" |
| GA2-17 | Done. Tags added: P1-S23, S39 `@POL-09`; P1-S18 `@POL-15`; P2-S61, S62, S81 `@POL-05`; P2-S75 `@POL-01`; P2-S42 `@POL-18`. The check was extended to Backgrounds and to policy-defined glossary terms, which found and fixed 16 more (headroom on P2-S39, S70, S71, S75, S76; P4-S24, S51, S65, S66, S68, S69, S94; X1-S02; X2-S07; suspended on P4-S51, S83) | as listed; README |
| GA2-18 | Done. X1-S01, S05, S06: booking and status submissions are "not accepted", other operations "refused". P2-S45, S47 titles and S84 rows: "decided against capacity" instead of "admitted"; P2-N9 likewise | X1-S01, S05, S06; P2-S45, S47, S84; P2-N9 |
| GA2-19 | Done | P2-S31 |
| GA2-20 | Done. "K's only current reservation"; P2-S53 When is an event | P2-S39, S53 |
| GA2-21 | Done. New X1-S25 (account user without the administrator right); X1-S22 retitled as proposed | X1-S22, S25 |
| GA2-22 | Done. Lines 8 and 21, the round-4 status paragraph, "Policy questions for round 4" and the GA-22 row of the round-3/4 record corrected, each marked as corrected after review 03 | `02-requirements-gate-resolution.md` |
| GA2-23 | Done. "Then, after reconciliation (POL-28), Share's record … matches" | P2-S28 |

## Gate decisions and where they are applied

| Decision | Register | Applied in |
|---|---|---|
| A D-01, D-02, D-12 | POL-02 r5 | P2-N4, C5; P2-S18, S31, S61, S87 to S89; P1-S12; glossary |
| A D-03; B D2 | POL-10 r5 | P1-N4; P2-N8, N11; P2-S38, S75; glossary "Counter-offer" |
| A D-04, D-05, D-10; B D10 | POL-07 r5 | P1-N8; P1-S25, S29, S31, S35, S48 to S53; P3-S59; P4-S77; glossary |
| A D-06 | POL-28 r5 | P2-N7, C19; P2-S28, S32, S90, S91 |
| A D-07; B D13 | POL-25 r5 | P2-N8, C18; P2-S92; P4-N4; P4-S68, S98; glossary |
| A D-08 | POL-33 | X1-N2; X1-S28; glossary "Reservation reference" |
| A D-09; B D15 | POL-32 | X1-N7, N10; X1-S12, S13, S16, S17, S23, S26, S27; P4-S82, S83; glossary "Operator" |
| A D-11 | POL-26 r5 | P2-N3, C20; P2-S23; glossary "Outcome", "Capacity hold" |
| B D1 | POL-24 r5 | P4-N14; P4-S54, S90, S91; glossary "Reconciliation" |
| B D3 | POL-16 r5 | P4-N5, N17; P4-S92, S93 |
| B D4 | POL-21 r5 | P4-N13; P4-S53, S83, S94; glossary "Write-off" |
| B D5 | POL-22 r5 | P4-N12; P4-S95 |
| B D6, D7 | POL-06 r5 | X2-N1, N3, N5; X2-S10, S13, S16, S18; P3 timeliness paragraph |
| B D8 | POL-08 r5 | P3-N12; P3-S44; P4-S77 |
| B D9 | POL-15 r5 | P4-N3, N5; P4-S96, S97; glossary "Funds hold" |
| B D11 | POL-23 r5 | P4-N11; P4-S56 |
| B D12 | POL-12 r5 | P4-N8; P4-S102; glossary "Split" |
| B D14 | POL-11 r5 | P3 and P4 Context; P3-N5, N12; P3-S60; glossary |
| B D16 | POL-27 r5 | P4-N3; P4-S101 |

## Round-6 decisions for the register

Two points the round-5 entries leave open were needed to write X1-S28 and X1-S12. Each is
decided here, applied in the specs, and is to be written to the register as a round-6
amendment.

| # | Entry | Decision | Trade-off |
|---|---|---|---|
| R6-1 | POL-33 | A buyer's consent to be identified to a supplier is given by an account administrator, per named supplier, recorded, and withdrawable for the future (a withdrawal hides the identity from later views; it does not recall what was already shown). An agent key cannot give it | Agents cannot leak the buyer's identity to suppliers on their own, and consent stays specific and auditable. Buyers who want direct supplier relationships must name each supplier |
| R6-2 | POL-32, POL-33 | Disclosing a buyer's identity to a supplier under a legal order is a compliance action, approved by a second compliance operator and recorded with the order, like a legal-order termination | One control for every irreversible legal-order action. A disclosure the law requires urgently waits for a second compliance operator |

Applied in: X1-N2, N7; X1-S12 (compliance row), X1-S18 (consent rows), X1-S28; glossary
"Reservation reference", "Operator".

### Readings taken without a new decision

- **D-01 at partner links.** Under D-02 a request can wait for capacity Share holds at a
  partner. D-01's "holds capacity an older request is waiting for" is read as covering
  those holds too, so a cycle through a partner link is broken the same way.
- **D1, a safeguarding breach.** It is an operational alert (P4-S91). The system never moves
  buyer or supplier money to cure it; Share cures it by adding to its own balance.
- **D9, "while the fee could still be charged"** is read as "within the partner's minimum
  term" (P4-S96).
- **D3, "every overdue invoice"** is shown with one overdue invoice (P4-S93); the need
  (P4-N5, N17) states the general rule.
- **D-07, release of the funds hold at a non-confirmed outcome** is already P4-S12; no new
  scenario was added for it.

## Not fully resolved

| Item | Why |
|---|---|
| Superseded text left in the register | The register keeps earlier paragraphs beside the round-5 ones that replace them: POL-07 r4 "every reservation on the link is affected" (refined by r5), POL-15 r4 "later reservations need prepayment until the debt is paid" (replaced by POL-21 r5: the account stays suspended), POL-16 r3 "headroom at least zero" (replaced in r4), POL-24 r3/r4 "positive buyer balances" (replaced in r5), POL-25 r3 key spending (replaced in r4). The specs follow the latest round everywhere. Marking the older paragraphs "superseded" is a register edit, outside this brief |
| Round-5 register wording | Several round-5 bullets are answers to the gate's questions without the question ("Yes. While another…", "Share, as for a revocation…", "It is one party…"). They are correct but hard to read on their own; restating them as rules is a register edit, outside this brief |
| Glossary-term tag check | It is a fixed list of terms with two exclusions for false positives ("wait for capacity to become free", "the `wait` setting"). A term not on the list is not checked |
| RTO for payouts and reporting | X2-N5 gives none; they are governed by their 99.9% availability target alone. Gate B did not raise it, and no scenario needs it, so it was not decided |
| Measurement questions | Still open, as gate A allowed: P1 measured skew; P2 several partners per route; P3 sequence numbers and attribution (RFC and interface); P4 provider authentication and zero-amount notifications (interface contract); X2 measured load and webhook load |
