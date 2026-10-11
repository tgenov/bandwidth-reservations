# Review 04, final gate B: adversarial gate review of P3, P4 and X2

| | |
|---|---|
| Scope in depth | `01-discovery/P3-rating-and-metering.md`, `P4-wallet-and-settlement.md`, `X2-non-functional-targets.md` and their `.feature` files |
| Skimmed for boundaries | P1, P2, X1 features (money, holds, equivalent paths, operator actions, insufficient-funds and key-spending rows) |
| Read as binding | `02-specs/policy-register.md` (consolidated, including round 6), `02-specs/glossary.md`, `docs/README.md`, gate B round 2 (`03-requirements-gate-b.md`) and its resolution (`03-requirements-gate-resolution.md`) |
| Deliberately not read | Code, `03-rfcs/`, `04-delivery/`, `history/` |
| Date | 2026-10-11 |
| Stance | Adversarial. On PASS the baseline becomes authoritative. Business questions are decided here (see "Decisions taken"), never left open |

## Verdict

**PASS WITH FIXES.** GB2-01, the round-2 Blocker, is closed. The signed invariant and the
safeguarding rule hold on every row of P4-S90 and S91, and they hold after write-offs,
repayments, duplicate payouts and orphan reversals as well. All 24 GB2 findings are
closed in the specs, and the register now states one current rule per entry.

I recomputed every Examples row and worked figure in P3, P4 and X2, plus the money rows of
P2, and every one is correct. I also checked traffic mechanically: 357 scenarios, one ID
each, no duplicates, every need cited, every `@need-` tag and `@POL-` tag valid, and every
policy named in a step, Examples table or Background tagged. Every glossary-term tag is
present, every Outline placeholder resolves, no plain Scenario has Examples, the
conformance matrix lists every ID, and no implementation terms leak into the specs.

Nothing found makes the core mechanism unsatisfiable. Five Majors are contradictions or
false statements in binding text that a conforming design would trip over:

- the timeliness bound ignores region loss (FB-01);
- the partner-matching rule alerts on the deposits the safeguarding rule requires (FB-02);
- the "so funds cover every positive balance" corollary is false while payouts are in flight (FB-03);
- "zero double payouts" cannot be met under P4-S95 (FB-04);
- the equivalent-path difference makes Share pay its own commission (FB-05).

Each has a text-only fix that is decided below. No new mechanism is needed. If the fixes
are applied as written, this gate needs no further round. A spot check of the named
scenarios is enough.

## Counts

| Severity | Count |
|---|---|
| Blocker | 0 |
| Major | 5 |
| Minor | 7 |
| **Total** | **12** |
| Decisions taken | 9 |

## Closure of round-2 findings (GB2-01 to GB2-24)

| GB2 | Status | Evidence |
|---|---|---|
| 01 | Closed | POL-24, P4-N14, P4-S54 row 1, S90 (4 rows), S91. Rechecked: 4.25 = −5 + 4.25 + 5; 8.5 = −10 + 8.5 + 10; 0 = 0 + 120 + 0 − 120; 100 = 50 + 35 + 15; S91 0 = −5 + 4.25 + 0.75 with 0.75 < 5 receivable. The corollary wording is FB-03 |
| 02, 03 | Closed | Glossary "Key spending", "Resume amount" |
| 04 | Closed | P2-S38 (0.088000 / 1.088000, both rows give headroom 0.200000), S75 (0.000460 / 1.000460) |
| 05 | Closed | P4-S92 (−1 − 0.288 + 5 = 3.712), S93 (4.712) |
| 06 | Closed | P4-S94 three rows; S53, S83 |
| 07 | Closed | P4-S95. The P4-N12 measure now contradicts it (FB-04) |
| 08 | Closed | POL-06 table, X2-N1, X2-S18. Probe side effects are FB-09 |
| 09 | Closed for node and zone loss | X2-S10, S13. Region loss is still open (FB-01) |
| 10 | Closed | P3-S44 row 4, S58; P4-S60 row 5, S77 row 5 |
| 11 | Closed | P4-S96, S97 (0.212000 left, −0.288000 = min(fee, coverage)) |
| 12 | Closed | P3-S59, P4-S77 row 2. The commission share is FB-05 |
| 13 | Closed | P4-S56 (3,000 / 3,333 / 2,167, commission not posted) |
| 14 | Closed | P4-S102. Recomputed: priorities s 2, t 2, Share 1 give 1/0/0, 1/1/0, 1/1/1, 2/1/1 |
| 15 | Closed | P4-S68 row 5, S98 |
| 16 | Closed | POL-11, P3-S60, glossary |
| 17 | Closed | P4-S57 (12 rows), S99, S100. One input is still missing (FB-10) |
| 18 | Closed | X1-S12 finance rows |
| 19 | Closed | Glossary; P4-N3 "is resized" |
| 20 | Closed | Mechanical check above |
| 21, 22, 23, 24 | Closed | P4-S70; P3-S37, P2-S39; README convention; P4-S101. The grace shortfall in S101 is FB-08 |
| Round-2 "not fully resolved" | Closed | The register is consolidated (no superseded paragraphs). Payout and reporting RTOs are decided (round 6) and in X2-N5 and X2-S10 |

## Arithmetic verified (summary)

- **P3.** S01–S07 and S40–S46 accruals. S46 LIFO: 80 Mbps gives 160. S58 gives 8 and then
  4. S59 dearer: 200 charged, difference 100; cheaper: 100. S48: 1.5 → 1 and 1.95 → 1.
  S49 9,800. S51: 120,000/7 → 17,142 and 90,000/7 → 12,857. S52 5,000 / 6,500. S21 three
  rows. S23 1.75 − 0.75 GB → 10,000. S54 0.75 GB covered. S53 5,000. S32 amendments 10,000
  and 1. S34 −50,000. S55 +20,000. S56 −100 or refused. S37: 2,000 + 30,000 (100 Mbps ×
  240 s = 3 GB) = 32,000.
- **P4.** S06 FX: 9.5169782 → 9.516979. S58 7.600000. S07 12,340,000. Holds S08, S09, S59,
  S60 (0.504000, 0.144000, 0.230400, 0.024000, 0.144000), S62 0.432000, S63, S96. S13
  headroom 0.712000. S15 and S16 0.680000. S55. S68 five rows. S64 0.216000. S22 resume
  1.072000 and 0.572000 short. S24 quotes 0.388000, 29.000000, 0.500000. S70 −4.700000,
  loss 4.988000. S97, S101 (growth 0.144000 > 0.100000). S35 Webster 6/13/12 and 6/14/12
  (Hamilton would give 5/14/13, so the row discriminates). S36, S73, S102. S75 0/1/0. S85
  (split on its own gives s 1; split of the new total would push s down, so the rule
  matters). S41. S42: 12 + 13.332 + 8.668 + 6 = 40. S56. S47, S48, S50: 15,540.5914265 KES
  → 15,540, residue 0.004567 USD. S52, S94, S92, S93, S90, S91.
- **X2.** S16 11/12 = 91.7% and 10/12 = 83.3%. S13 bounds 2 + 5 = 7 min. Node and zone RTOs
  fit their monthly budgets. Rating's 5-minute RTO leaves at most about 3 minutes late
  (minutes ending in the first 3 minutes of the outage), which is under 4.03 minutes, the
  0.01% of a 28-day month. One full-RTO event therefore fits the 99.99% timeliness target.

## Findings

| ID | Severity | Location | Finding | Fix |
|---|---|---|---|---|
| FB-01 | Major | POL-06 "Charge timeliness"; X2-N3; X2-S13 ("every such charge is posted within … the target plus the 5-minute recovery time"); against X2-S10 region rows and X2-N1 | X2-S10 allows rating and posting a 1-hour recovery on a declared region disaster. X2-S13 requires *every* charge within 7 min (reservation) or `max_lateness` + 7 min. Region loss is excluded from availability, but timeliness has no such exclusion. So a conforming 1-hour regional recovery breaks X2-S13, and the baseline contradicts itself in an event it allows. | Apply D1. In POL-06, X2-N3 and X2-S13, add: "On a declared region disaster, the affected minutes are outside the 99.99% measurement, and each of their charges is posted within its target plus the 1 h regional RTO." Add an X2-S13 Examples row or a new scenario for that bound (2 min + 1 h). |
| FB-02 | Major | POL-24 item 2; P4-N14 (3); P4-S54 rows 2–4; against the safeguarding rule, P4-S90 rows 1–2 ("4.250000 it added"), P4-S57 "invoice payment notification", POL-22 supplier-debt invoices | The partner-matching rule requires every provider transaction to match "exactly one ledger top-up, reversal or payout". The safeguarding rule obliges Share to deposit its own money at the partner (S90 rows 1 and 2), and credit-limit invoices and supplier-debt invoices are paid in. None of these is a top-up, a reversal or a payout. A conforming system therefore alerts on every pre-funding deposit and every invoice payment. Commission that Share withdraws from the partner has the same problem. | Apply D2. Replace the list with "a ledger top-up, invoice payment, reversal, payout, supplier-debt payment, or movement of Share's own funds (deposit or withdrawal)" in POL-24, P4-N14, the glossary "Reconciliation" and P4-S54. Add a P4-S90 row: Share deposits 4.250000 USD, it matches one movement of Share's own funds, and no alert is raised. |
| FB-03 | Major | POL-24 "Safeguarding rule" ("so the funds at the partner always cover every positive buyer and supplier balance"); P4-N14 (2); glossary "Reconciliation"; against P4-S90 row 3 | Row 3 has funds at the partner of 0 and a positive supplier balance of 120 (the payout is executed but not confirmed), and expects no alert. The stated consequence is false whenever a payout is in flight. A design that implements the corollary as its alert test contradicts row 3. | Apply D3. Restate the corollary as "so the funds at the partner always cover every positive buyer and supplier balance, less payouts the partner has executed and the ledger has not yet confirmed". The obligation itself (Share's own balance ≥ receivables) is unchanged. |
| FB-04 | Major | P4-N12 measure ("Zero double payouts"); POL-22 summary "never paid twice"; P4 "Who is affected" (supplier "never twice"); against P4-S95, POL-22 duplicate-payout rule | P4-S95 describes the provider executing a transfer it had reported as finally failed, after the re-run paid the amount. The supplier is then paid twice, and the policy recovers it as a debt. No system can prevent a provider's false final-failure report, so "zero double payouts" cannot be met under the baseline's own scenario. | Apply D4. Restate the P4-N12 measure as "No amount instructed twice by the marketplace (repeated run, instruction or confirmation); every transfer the provider executes twice is recovered as a 'duplicate payout' debt; cumulative payouts equal cumulative earnings less residues carried, amounts in flight and open supplier debts". Read POL-22's "never paid twice" the same way, as never *instructed* twice. |
| FB-05 | Major | POL-07 step 4 ("Share pays the difference, to the new path's parties"); P3-S59 ("Share pays 100 micro-USD a minute to the equivalent path's parties"); P4-S77 row 2 ("the parties of the equivalent path, split by their weights") | The parties of a split include Share's commission (POL-12). As written, Share pays a commission share of the difference to itself, a circular movement. That conflicts with the rule POL-23 sets for the analogous carried-excess cost: no commission share posted, no circular movements. P3-S59's "pays 100" is then wrong by the commission share. | Apply D5. In POL-07 step 4, POL-23, P3-S59 and P4-S77 row 2: "the difference is split by Webster among the new path's parties; each supplier is paid its share from Share's own account; the commission share is not posted". Change P3-S59's column to "difference" and its Then step to "Share pays the suppliers' shares of <difference> micro-USD a minute". |
| FB-06 | Minor | POL-24 "Share's own balance is never allowed below zero"; against POL-23 (Share bears costs in full from its own account), P4-S41, S56, S77 | Read as a system gate, the rule would refuse or delay a cost POL-23 says Share bears in full, and supplier earnings would then not be final. Read as an obligation on treasury, it needs no gate. The register does not say which reading applies. The resolution record's reading (the alert only, the system never cures it) is not in the register. | Apply D6. Add to POL-24: "It is an obligation on Share's treasury, checked by the daily reconciliation (P4-S91). No movement owed to a buyer or supplier is refused or delayed because of it." |
| FB-07 | Minor | POL-20 ("FX round-ups are part of Share's own balance"), POL-24 item 1; P4-S06 row 2 | P4-S06 row 2 credits 9.516979 USD against an exact 9.5169782. The 0.0000008 round-up cannot be represented in micros. What the partner actually holds for that transaction is in the partner's own unit, and it may not be USD (KES before conversion). As written, item 1 cannot balance exactly, and nothing says which movement carries the difference. | Apply D7. Add to POL-20 and POL-24: "Funds at the partner are taken in USD as the partner reports them. For each converted top-up or payout, the difference between the micros credited or debited and the partner's reported USD amount is posted as an FX difference to Share's own account, positive or negative." Add a P4 scenario showing the difference posted for S06 row 2. |
| FB-08 | Minor | POL-16 parameter note ("so the grace is always funded"); POL-27 last bullet; P4-S101 | In S101 the old hold of 0.288000 at the new 300 micro-USD a minute funds only 16 h of the 24 h grace. The account had 0.100000 of headroom, which the baseline neither moves into the hold nor mentions. "Always funded" is false, and what accrues once the hold runs out is undefined. | Apply D8. Add a Then step to P4-S101: the hold grows by the 0.100000 the headroom allows (to 0.388000); the reservation keeps its capacity for the full grace; the 0.044000 shortfall (0.432000 − 0.388000) becomes a negative balance under POL-21 and POL-23. Qualify the POL-16 note as "always funded, except a price-change shortfall (POL-27) or a reversal (POL-21)". |
| FB-09 | Minor | POL-06 per-probe operations; X2-N1, X2-S18; against P3-S26 (unattributable traffic reported to the supplier), P3-N2, P1 capacity, P4 holds | A probe "single-link booking answer" every 10 s from two locations books real capacity and takes funds holds. A probe "flow record acknowledged as accepted" is either billed or quarantined and reported to a supplier 12 times a minute. As written, the measurement method would create side effects the baseline forbids or reports. | Apply D9. Add to POL-06 and X2-N1: probes act as a designated Share probe account on designated probe links and exporters. Their bookings and records are real end to end, but excluded from rating, settlement, supplier reports and quarantine reports. |
| FB-10 | Minor | POL-29 list; P4-N15; P4-S57; glossary "Source reference" | A finance operator resolving a money escalation can move money: marking an escalated payout confirmed or failed, or settling an orphan reversal (X1-S12 rows). That input is in none of the idempotency lists. The glossary "Source reference" also lists only four kinds of input and omits fee lines, which POL-29 includes. | Add "resolution of a money escalation" to POL-29, P4-N15 and as a P4-S57 row. Align the glossary "Source reference" with P4-N15's list. |
| FB-11 | Minor | P3 Constraints, row "A record can be attributed…" ("see open question 3") | It points to an open question that does not exist: the list has only questions 1 and 2. | Change it to "see open question 2". |
| FB-12 | Minor | X2-N1 and X2-S18 ("a balance and headroom answer") vs POL-06 ("A balance or headroom answer") | The two texts give different probe operations: "and" needs both items in one answer, "or" accepts either. | Use "a balance and headroom answer" in POL-06. It matches the headline answer of P4-S15. |

## Register ↔ spec fidelity

Every observable rule in POL-01, 06, 11 to 24, 27 and 29 has at least one scenario. No
scenario contradicts the register except as listed above (FB-01 to FB-05, FB-08). These
items have no scenario because they are not observable or are deferred, and that is
correct:

- POL-14, "price rises cannot occur within the window" (it follows from POL-27);
- POL-21, withdrawals and SLA credits (deferred until later);
- POL-24, legal confirmation per market.

The FX round-up line (POL-20) is observable but has no scenario (FB-07). Idempotency was
checked for every money-moving input: notifications, invoice payments, confirmations and
failure reports, payout instructions and runs, corrections, attributions, write-offs,
postings of charges, amendments and fees, Share-borne costs and supplier debts. The only
gap is FB-10.

## Decisions taken

| # | Question | Decision | Trade-off |
|---|---|---|---|
| D1 | How is charge timeliness judged on a declared region disaster? (FB-01) | As for availability: the affected minutes are outside the 99.99% measurement. Each of their charges is still posted within its target plus the 1 h regional RTO, and the RPO stays 0, so nothing is lost or double-charged | Buyers' charges may lag by up to about an hour after a region loss, which a disaster declaration already accepts. Rating does not have to meet admission's regional RTO |
| D2 | Which partner transactions does reconciliation match? (FB-02) | Top-ups, invoice payments, reversals, payouts, supplier-debt payments, and movements of Share's own funds (deposits and withdrawals). Each is recorded as a ledger movement with a source reference and matched to exactly one ledger movement | Pre-funding and commission withdrawals become auditable, recorded movements instead of unexplained differences. Treasury must record every deposit before the next day's reconciliation |
| D3 | What does the safeguarding rule guarantee while payouts are in flight? (FB-03) | Funds at the partner cover every positive buyer and supplier balance, less payouts the partner has executed and the ledger has not yet confirmed. The obligation (Share's own balance ≥ receivables) is unchanged | Exact under every reconciliation row. An in-flight payout is money that has already left, not a shortfall |
| D4 | What does "never paid twice" promise? (FB-04) | The marketplace never instructs the same amount twice. A transfer the provider executes twice (a false final-failure report) is recovered as a "duplicate payout" debt (POL-22) | The promise is one the system can keep. The supplier's earnings are untouched, and Share carries the recovery risk until the debt is netted or invoiced |
| D5 | Who is paid the price difference of a dearer equivalent path? (FB-05) | The Webster split of the difference among the new path's parties. Each supplier is paid its share from Share's own account, and the commission share is not posted, as for carried excess (POL-23) | No circular movements, and suppliers on the new path are paid as if the buyer had paid. Share earns commission only on what the buyer pays |
| D6 | Is "Share's own balance never below zero" a gate? (FB-06) | No. It is a treasury obligation, checked by the daily reconciliation (P4-S91). No movement owed to a buyer or supplier is ever refused or delayed because of it | Supplier earnings stay final and buyers are never blocked by Share's treasury. A breach is visible within a day and cured only by Share adding funds |
| D7 | How are FX differences between micros and the partner's amounts booked? (FB-07) | Funds at the partner are taken in USD as the partner reports them. For each converted top-up or payout, the difference between the micros credited or debited and the partner's reported USD amount is posted to Share's own account as an FX difference, positive or negative | The invariant stays exact to the micro. Share absorbs sub-cent FX differences both ways. The buyer still gets the shown rate rounded up, and the supplier the shown rate rounded down |
| D8 | What happens when the hold after a price change cannot fund the whole grace? (FB-08) | At suspension the hold grows by whatever headroom remains, and the reservations keep their capacity for the full `suspension_grace`. Any accrual beyond the hold becomes a negative balance under POL-21 and POL-23. Share's loss is bounded by the hold growth less the headroom | The guarantee and the grace stay uniform. Share's exposure is small and bounded, and the buyer had `price_notice` and a warning |
| D9 | How do availability probes avoid side effects? (FB-09) | Probes act as a designated Share probe account, on designated probe links and exporters. Their bookings, holds and records run end to end, but they are excluded from rating, settlement, supplier reports and quarantine reports | Probes measure the real path without selling capacity, moving money or alarming suppliers. Probe links must be provisioned in every region |
