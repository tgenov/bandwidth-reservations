# Resolution of review 01 (requirements baseline)

| | |
|---|---|
| Review | [01-requirements-review.md](01-requirements-review.md), findings R-01 to R-46 |
| Policies applied | [Policy register](../02-specs/policy-register.md), POL-01 to POL-28 (decided, provisional) |
| Date | 2026-10-11 |
| Scope of change | `01-discovery/`, `02-specs/`, `README.md`. RFCs, delivery docs and history not read or changed; they are pending revision. |

## What changed overall

- **Problem set.** P1 is now the link's schedule (admission, capacity in flight, horizon,
  supply loss, history). P2 is every booking (a single link is a one-leg route, POL-05),
  plus the reservation lifecycle (POL-08), funds and agent-key limits at admission, and
  partners. P3 is re-scoped by POL-01 from "metering is the revenue path" to **rating**:
  accrual of reservations per Mbps-minute, usage-priced traffic (best effort, burst,
  out-of-reservation), and metered traffic as SLA evidence. It was renamed
  `P3-rating-and-metering`. P4 adds funds holds for the coverage window (POL-15), headroom
  (POL-18), suspension (POL-16), payouts, reversals and reconciliation. Two cross-cutting
  sets were added: **X1** security, tenancy and audit, and **X2** non-functional targets.
  They are numbered X, not P5/P6, because the company profile and POL-07/POL-21 already use
  "Problem 5/6" for provisioning and SLA.
- **Needs tables.** Each problem statement has a Needs table (`Pn-Nk`, need plus success
  measure). Every scenario cites its needs with `@need-` tags, and traceability is checked
  mechanically in both directions.
- **Specs** rewritten as observable needs. All verification metadata moved to
  [`02-specs/conformance.md`](../02-specs/conformance.md), with an old-to-new ID mapping for
  all 101 previous scenarios.
- New [glossary](../02-specs/glossary.md); README conventions rewritten.

Scenario counts: P1 36, P2 54, P3 41, P4 56, X1 15, X2 14 (216 in total; previously 101). These include the propagation of the policy amendments (last section).

## Findings

| ID | Resolution | Where |
|---|---|---|
| R-01 | Every `@verified`/`@unverified` tag, `# Verified by` comment and defect note removed from the `.feature` files; the convention removed from the README. Conformance matrix created with Scenario · Design (TBD) · Tests · Status (`not assessed`); prior citations carried over only where the meaning is unchanged, marked "prior evidence, to be re-validated". Citations R-01 flagged as naming unrelated tests (old P3-S04, P3-S06, P4-S07, P4-S13) were not carried. Old P4-S18's "less than n micros" bound was dropped; the bound is now the POL-12 rule (P4-S35) with deviation reported (P4-S37). The matrix sits in `02-specs/` (as the brief asked), not `04-delivery/` as the review suggested. | All features; `conformance.md`; README |
| R-02 | POL-01 applied: reservations accrue per Mbps-minute whether or not traffic crosses them. | P3 statement and P3-N1; P3-S01 to S11 |
| R-03 | P2 rewritten around observable needs (P2-N1 to N10). Holds, commit point, tickets, wound-wait, wake-ups and the three-outcome protocol removed; the old scenarios are mapped as "(removed), moved to RFC-002" with the need-level scenario that replaces each. | P2 feature; conformance mapping |
| R-04 | POL-02 applied: the priority rule is the named parameter `priority_rule`; its default is illustrated (P2-S16); the invariants hold whatever the rule (P2-S15, S17, S19, S20); changing it leaves uncontended outcomes unchanged (P2-S21). | P2-N4 |
| R-05 | POL-03 applied: resume within the deadline, otherwise fail, release and say why. | P2-S22, P2-S23 |
| R-06 | POL-04 applied: a response within `ack_budget`, final or pending; poll by idempotency key; signed webhook with retries; one outcome, never changed. Routes keep their deadline (POL-26) for the final outcome. | P2-S06 to S10; X2-S06 |
| R-07 | POL-05 applied: one schedule owner per link; every booking is a route of ≥1 leg; capacity in flight counts against the link; P1's "never holds capacity" restated as "holds nothing once it has its outcome", with capacity back by the deadline. Single-link versus in-flight route outcome per amended POL-05: wait within the deadline, pending after `ack_budget`, immediate rejection with `retry_after` only with `wait = false`. | P1-N3, P1-N7; P1-S07 to S12, S34; P2-S14 |
| R-08 | Buyer-visible outcomes defined (pending, confirmed, rejected, invalid, failed) in the glossary. Confirmed is never reported before every leg is secured (P2-S03, P2-S29); it is never withdrawn except under POL-07/POL-16 (P2-S05); outcomes never change (P2-S10). "Commit point" removed. | Glossary; P2 |
| R-09 | Split into "at least one wins" (P2-S15) and "a waiting request is rejected for no fit only if it did not fit on committed capacity" (P2-S17). Per amended POL-05, contended requests wait and are confirmed if the capacity in flight is released (P2-S20), or rejected with a counter-offer if it is confirmed (P2-S52); `wait = false` gives immediate rejection with `retry_after` (P2-S18). | P2-N4 |
| R-10 | POL-06 targets turned into X2 needs, each with a measurement method, and scenarios for availability (per region), load, latency, charge timeliness (X2-S13), RPO 0 for every failure scope with two-region durability before acknowledgement (X2-S09, S12, S14), RTO per failure scope (X2-S10) and retention. Old P1-S09's test-rig numbers replaced by the design load. | X2 statement and feature |
| R-11 | POL-07 applied: new sales stop at reduced capacity; unplanned outage keeps reservations, flagged and announced; planned maintenance booked ahead on free capacity only; permanent reduction offers an equivalent path on the POL-07 terms (accepted or declined), otherwise revokes newest first with notice; accrual and SLA marking in P3. "Capacity is fixed" removed from P1 constraints. | P1-N8; P1-S24 to S32, S35, S36; P3-S08, S10 |
| R-12 | POL-08 applied: cancel, shorten, extend, increase, decrease, no change to part of a route, partner fees shown at booking; accrual follows changes, the added part of an extension at the current price; holds released; authorisation of changes in X1. | P2-S43 to S50; P3-S04, S05, S11, S40; P4-S11; X1-S03 |
| R-13 | "Horizon" replaced by **selling horizon** (`selling_horizon`, POL-09) in glossary and specs; open-ended reservations are carried forward as the horizon rolls. The one-day Background removed. | P1-N6; P1-S19 to S23 |
| R-14 | POL-10 applied: largest rate that fits; earliest window; blocking link for routes; `retry_after`; top-up needed; no disclosure of other buyers. Old "peak usage" and sub-range reporting dropped (POL-10 does not require them). | P1-S12, S15 to S17; P2-S02, S18, S31, S38 |
| R-15 | Harness numbers removed; properties restated as universal ("any schedule", "any delivery order", "any amount", "any concurrent load"). "In memory" assertions deleted. The conformance matrix says that generators, seeds and counts belong in the test plan. | P1-S05, S13, S14; P2-S15, S28; P3-S15; P4-S32, S33, S38 |
| R-16 | Kafka topics, partitions, offsets, HTTP paths and codes, JSON fields, SQL and error strings removed; each restated as its need (charging starts afresh exactly once, P3-S13; minute charged once whatever the overlap, P3-S12; balance equals ledger, P4-S17; nothing can alter money, P4-S29). The mechanical check rejects these terms in the specs. | P3, P4 features |
| R-17 | POL-11 applied: micros tagged with currency; charges rounded once, down; exact conversion at top-up; payout rounded down to the provider's unit, residue carried. | P3-S21; P4-S07, S47; glossary |
| R-18 | POL-12 applied: exact, monotone and deterministic properties kept; the rule is Webster (illustrated with POL-12's rule, P4-S35); Share's commission loses ties (P4-S36); cumulative deviation reported (P4-S37); rule published on statements (P4-S40). The prototype's worked numbers moved out (to RFC-004). | P4-N8 |
| R-19 | POL-13 applied: bytes belong to the minutes in which the flow was active; multi-minute records spread across them in proportion to the seconds active in each (amended POL-13), each part at its own minute's price; minutes half-open. Under POL-01 this affects only usage-priced traffic. | P3-S18, S19; P3 constraints |
| R-20 | POL-14 and amended POL-18 applied: the exposure formula removed; usage exposure (estimate of unposted usage-priced traffic plus the `max_lateness` bound) is visible per account (P3-S37) and deducted from headroom for every account (P4-S15); records later than `max_lateness` are billed and reported as breaches (P3-S38); late enforcement reported (P4-S27); every account is suspended before headroom would fall below zero (P4-S18, P4-S19). | P3-N10; P4-N4, N5 |
| R-21 | POL-15 applied: the funds hold for the coverage window at admission (P4-S08 to S13), and its refusal in the booking with the top-up needed (P2-S38), within `ack_budget` (X2-S05). The internal policy identifiers `reserve`/`credit_limit` removed; credit limit is a per-account parameter (P4-S13, S14). "No upfront payment" re-marked as interpreted by POL-15. | P2-N8; P4-N3 |
| R-22 | POL-16 applied: reservations kept and accruing for `suspension_grace`, then released and the buyer told (confirmed as intended by the amended POL-16); automatic resumption. The duplicate open question was removed from both P3 and P4. Suspension is owned by P4. | P4-S18 to S23; P3-S09 |
| R-23 | "Exactly one event" replaced by at-least-once notification with harmless repeats (P4-S25), queryable standing (P4-S26), enforcement within the X2 target (X2-S08) with lateness reported (P4-S27), and a warning below `low_balance_warning` (P4-S24, amended POL-16). | P4-N5, N6 |
| R-24 | POL-17 applied and the contradiction fixed: no record is ever discarded; unreadable records are kept with their reason and can be replayed; over-rate (dropped and not billed, P3-S24; carried despite policing, kept and reported, P3-S41), burst, out-of-reservation and unattributable traffic each have a rule; quarantined traffic is reported and the supplier paid only if it is attributed within `dispute_window`. | P3-N6, N7; P3-S22 to S30 |
| R-25 | Boundary enforced: P3 outputs charges and amendments only (P3-S15 on charges; balances in P4-S38); the late-amendment sign rule restated as "never reduces any party, never credits the buyer" (P4-S39); suspension assigned to P4. | P3, P4 statements and features |
| R-26 | Reworded: "Late traffic only ever increases a charge; a price correction can move it either way." | P3 Context; glossary "Amendment" |
| R-27 | POL-18 applied: headline available headroom, net of funds held and usage exposure, itemised; one rule for admission and suspension. P4's buyer need reworded accordingly. | P4-N4; P4-S15 to S17 |
| R-28 | Added recomputation (P3-S36), buyer view of the original charge and amendments with reasons (P3-S35), support explanation via recorded reasons and operators (P3-S34, X1-S12), and the supplier statement with rule and weights (P4-S40). | P3-N8, N9; P4-N10 |
| R-29 | POL-19 applied: known-at history (P1-S33); actor and time on every change (X1-S14); 7-year retention (X2-S11). | P1-N9; X1-N8; X2-N6 |
| R-30 | X1 added: authentication, account isolation without existence disclosure, agent-key scope and revocation, idempotency keys scoped per account, notification authenticity, webhook verifiability, operator roles with reasons, immutable audit. The scenarios use explicit accounts. | X1 statement and feature |
| R-31 | POL-20 applied: USD for prices, wallets and ledger; conversion at top-up and payout at the shown rate; every amount carries a currency; one currency per money movement. | P4-S06, S31, S50; glossary units |
| R-32 | POL-21 applied: reversal after spend (P4-S51 to S53); reversal before its completion held up to 72 h (P4-S02), and escalated, never applied, if its payment never arrives (P4-S03, amended POL-21). Withdrawals and SLA credits listed as out of scope ("later") with their requirement recorded. | P4-N13; P4 Out of scope |
| R-33 | POL-22 applied: weekly payout, minimum, complete only on confirmed transfer, at most once per run, netting, invoicing after 90 days. "Paid" is defined as a confirmed transfer, which replaces the review's interim "instruction issued". | P4-S43 to S50 |
| R-34 | POL-23 applied: Share bears the loss; supplier earnings final; Share-error corrections borne by Share in full, even beyond the commission (amended POL-23); write-offs leave suppliers unchanged. | P4-S41, S53 |
| R-35 | Solutions removed from the problem statements ("cost does not grow with length" became a latency need in X2-S05; "ordering is lost" and "second code path" rationale removed; P3's batch framing removed). Statuses corrected: the stack is no longer listed as Confirmed; double-entry ledger is *Assumed (secondary source)*; old C5 (now C4) is *Confirmed (business statement)*. The README defines Confirmed, Decided, Assumed and Inferred. | All statements; README |
| R-36 | Stakeholders added: P1 network operations and provisioning, finance; P2 agent operators, partners' operations, support and operations; P3 network operations as policing and exporter owner, SLA work; P4 agent operators, compliance, network operations, support. Failed and stuck requests visible to operations (P2-S51). | "Who is affected" in all statements |
| R-37 | POL-24 applied as constraints (licensed partner, KYB for credit accounts) and daily reconciliation (P4-S54). Legal confirmation remains with the business. | P4-N14; X1 constraints |
| R-38 | Glossary added and applied: "reserved rate" versus "traffic" (no "usage" for capacity); outcomes confirmed, rejected, invalid, pending, failed; "buyer" (person or agent) versus "account" (payer); one time notation; units; route pricing (per product and route, `reservation_price`) versus per-party split weights. | `glossary.md`; all features |
| R-39 | POL-25 applied with its named parameters (`key_spend_limit`, `key_spend_period`, `key_inflight_limit`, `account_inflight_limit`, `key_rate_limit`; spending = funds held plus charges accrued by the key's bookings in the period) (P2-S39 to S41); key scoping and revocation (X1-S05, S06). Expiring quotes listed as out of scope. Abuse cases (hold-squatting, flooding, churn, key probing) are covered by the in-flight limits, rate limits, `ack_budget`-bounded holds and X1-S09. | P2-N8; X1-N3, N4 |
| R-40 | Gherkin cleaned: one Feature per file; Backgrounds per Rule only; every scenario has When and Then; no "may" or "woken" steps; old P1-S01 and S03 merged; P2 has supplier and business-owner stories; technology stories rewritten as needs; P4's weights Background moved under the split Rule; P2 defaults moved out of a header comment into steps that name the parameters. | All features |
| R-41 | One invalid-window table, owned by P1 and applying to every booking (P1-S19); one defect per row (P1-S19, P3-S28, P4-S05); wire-format rows ("+5", "1e6") moved to the interface contract; the requirement is "not a positive whole number of the currency's smallest unit". Zero is rejected (it is not positive); whether providers send zero-amount pings is left open (P4 open question 2). | P1-S19; P4-S05 |
| R-42 | POL-26 applied: a deadline per request, `route_deadline_default`, `route_deadline_max`, `commit_margin`, capacity back by the deadline; a request still pending after deadline plus `commit_margin` raises an alert. | P2-S11 to S14, S36, S53 |
| R-43 | Added one-at-a-time equivalence (P1-S14). No starvation: a contended request waits within its deadline and is confirmed when the capacity in flight is released (P2-S20, amended POL-05), and has its outcome by its deadline (P2-S13). | P1-N2; P2-N3, N4 |
| R-44 | POL-27 applied: prices change on minute boundaries only, so the mid-minute scenario was removed as moot; price lock (P3-S06) and `price_notice` (P3-S07) added. | P3-N1, N5 |
| R-45 | C1 restated: Share never confirms a leg the partner has not confirmed (P2-S29); reconciliation with the partner, with mismatches reported (P2-S32). | P2-N7 |
| R-46 | POL-28 applied: partner without holds booked last (P2-S33), at most one per route (P2-S34), cancelled at Share's cost (P2-S35), short-hold partners treated as without holds (P2-S36); two partners with holds of different lengths (P2-S37). | P2-N7 |

## Not done, or done differently, with reasons

1. **Conformance matrix location.** Placed at `02-specs/conformance.md` as instructed, not at
   `04-delivery/conformance.md` as R-01 suggested. It is still outside every `.feature` file.
2. **Design-level acceptance tests were not written into the RFCs** (R-03, cross-cutting
   recommendation 2). The RFCs were out of scope for this change. The mapping table marks each
   removed scenario "moved to RFC-002/004" so the RFC rewrite can pick them up.
3. **`04-delivery/contracts.md` was not updated** with the transport details and wire formats
   removed from the specs (R-16, R-41). It is pending revision.
4. **`seams.md` was not created** (cross-cutting recommendation 7). Each seam is assigned
   instead in the problem statements: the funds check outcome to P2, the funds hold to P4,
   suspension to P4, single-link versus route to P1 (POL-05), and accrual on lifecycle
   changes to P3.
5. *(Resolved by the amended POL-06.)* Charge timeliness now has a target and a scenario
   (X2-S13).
6. **RFC-003 still links to the old P3 file name** (`P3-usage-metering.md`). It was not edited,
   because RFCs were out of scope; it will break until RFC-003 is rewritten.
7. *(Resolved by the amended POL-25.)* The specs now use the register's parameter names.

## Policy ambiguities found in the first pass, and how the amendments were propagated

The thirteen ambiguities reported in the first pass were resolved by the business in the
amended policy register (see its Amendments table). Each was propagated as follows.

| # | Ambiguity | Amended policy | Propagated to |
|---|---|---|---|
| 1 | POL-05 waiting versus "reject with retry after" | POL-05: contended requests wait within their deadline and go pending; `wait = false` for immediate rejection | P1-S11, S12, new P1-S34; P2-S17, S18, S20, new P2-S52; P1-N3, P2-N4, P2 C5; glossary "Waiting", "`retry_after`"; P2 open question 1 removed |
| 2 | Price of an extension | POL-08: the added part at the current price | New P3-S40; P3-N1; P2 C16; P2 open question 4 removed |
| 3 | Equivalent path | POL-07: same endpoints and rate, latency and SLA class no worse, original price; buyer may decline | P1-S31 rewritten, new P1-S35, S36; P1-N8; glossary "Equivalent path"; P1 open question 2 removed |
| 4 | Prepaid usage exposure | POL-16, POL-18: one headroom rule including usage exposure for all accounts | P4-S13, S15, S18 (now an Outline), S19; P3-S25, S37; P4-N4, N5; glossary "Headroom", "Usage exposure", "Suspension"; P4 open question 5 removed |
| 5 | Key spending | POL-25: funds held plus charges accrued; parameters named | P2-S39 to S41; P2-N8; glossary "Agent key", "Key spending", "Capacity hold"; P4 open question 4 removed |
| 6 | Orphan reversal | POL-21: escalated, never applied | P4-S03 rewritten; P4-N13; glossary "Reversal"; P4 open question 6 removed |
| 7 | Share error beyond the commission | POL-23: borne by Share in full | P4-S41 rewritten with an example exceeding the commission; P4-N11; P4 open question 7 removed |
| 8 | "Spread evenly" | POL-13: in proportion to seconds active | P3-S19 (now an Outline with a partial-minute row); P3-N4; P3 open question 5 removed |
| 9 | Over-rate traffic without burst | POL-17: dropped excess not billed | P3-S24 rewritten; carried-despite-policing case kept as new P3-S41; P3 open question 4 replaced (see below) |
| 10 | Commit margin | POL-26: `commit_margin` = 10 s; stuck-request alert | P2-S36; P2-S51 simplified, new P2-S53; P2-N10; P2 open question 3 removed |
| 11 | RPO/RTO failure scope; per-region scope | POL-06: node/zone versus region; every target per region | X2-S01, S09, S10, new X2-S12; X2-N1, N4, N5; X2 open questions 1 and 5 removed |
| 12 | Warning threshold; stuck requests | POL-16 `low_balance_warning`; POL-26 alert | P4-S24 rewritten with `low_balance_warning`; P2-S53; P4 open question 3 removed |
| 13 | POL-16 release versus "never revoked" | POL-16: release after grace confirmed as intended | Glossary "Revocation"; P4 constraints. No scenario change (P2-S05 already allowed it) |

Also from the amended POL-06: charge timeliness, new X2-S13 (tagged to P3-N2 as well); P3
and X2 open questions on it removed.

## Ambiguities found while propagating, and their resolution

The four questions raised while propagating were settled in the policy register (the last
three rows of its Amendments table) and propagated as follows.

| # | Question | Amended policy | Propagated to |
|---|---|---|---|
| 1 | Excess carried despite policing on a product without burst | POL-17: not billed to the buyer; Share pays the supplier at `usage_price`; incident raised | P3-S41 rewritten; new P4-S56; P3-N6, P4-N11, P3 constraints; P3 open question 4 removed |
| 2 | An agent key's headroom | POL-25: key headroom = min(account headroom, `key_spend_limit` − key spending), shown to the key | New P4-S55; P2-S39 restated on key headroom; P2-N8, P4-N4; glossary "Key headroom"; P4 open question 4 removed |
| 3 | `account_inflight_limit` for a new account | POL-25: never below `account_inflight_floor` (1,000 Mbps) | New P2-S54; P2-N8; glossary "Capacity hold"; P2 open question 3 removed |
| 4 | Regional loss of acknowledged money | POL-06: RPO 0 on region loss too; acknowledged only once durable in two regions | X2-S12 rewritten (RPO 0); new X2-S14; X2-N4; X2 open question 3 removed |

No new ambiguities were found in this pass.
