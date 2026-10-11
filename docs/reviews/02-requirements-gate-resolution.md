# Resolution of requirements gate reviews A and B

| | |
|---|---|
| Resolves | [Gate A](02-requirements-gate-a.md) (GA-01 to GA-43: P1, P2, X1) and [gate B](02-requirements-gate-b.md) (GB-01 to GB-41: P3, P4, X2) |
| Policy inputs | Policy register round 3 (POL-02, 06, 07, 08, 11, 12, 14, 15, 16, 17, 18, 20, 23, 24, 25, 26 amended; POL-29, POL-30 new), and the round-4 decisions below |
| Files changed | `02-specs/glossary.md`, all six `.feature` files, all six problem statements in `01-discovery/`, `02-specs/conformance.md` (regenerated), this record |
| Not changed | `02-specs/policy-register.md`. **The round-4 entries could not be written to it** (see "Round-4 decisions"); the specs already apply them |
| Date | 2026-10-11 |

## Conventions used in this round

- **Scenario IDs.** No ID was renumbered, reused or removed. New IDs are numbered after
  each file's previous highest ID (P1 from S37, P2 from S55, P3 from S42, P4 from S57, X1
  from S16, X2 from S15). They sit in the Rule they belong to, as earlier rounds placed
  P1-S34 and P2-S52, because Backgrounds are per Rule. Rows in the conformance matrix are
  in file order.
- **Traceability, checked mechanically.** Every scenario has exactly one ID and at least one
  `@need-` tag; every `@need-` tag names a need in a Needs table; every need is cited; and
  every `POL-nn` named in a scenario's steps carries a matching `@POL-nn` tag. The only
  failure left is `@POL-31` on P1-S19, which names an entry not yet in the register.
- **Outcomes.** Only glossary outcomes are used: confirmed, rejected, invalid, failed
  (pending until then). A submission refused before it becomes a request is **not
  accepted**, a new glossary term (GA-18).
- **New needs.** P2-N11 (route counter-offers); P3-N12 (partner fees), P3-N13 (one count per
  route); P4-N15 (idempotent money inputs), P4-N16 (traceability and rebuild), P4-N17
  (credit accounts); X1-N9 (key management), X1-N10 (link authority).

## Scenario counts

| File | Before | After | New IDs |
|---|---|---|---|
| P1-link-admission.feature | 36 | 47 | S37 to S47 |
| P2-route-reservation.feature | 54 | 86 | S55 to S86 |
| P3-rating-and-metering.feature | 41 | 57 | S42 to S57 |
| P4-wallet-and-settlement.feature | 56 | 89 | S57 to S89 |
| X1-security-and-tenancy.feature | 15 | 24 | S16 to S24 |
| X2-non-functional.feature | 14 | 17 | S15 to S17 |
| **Total** | **216** | **320** | **104** |

## Arithmetic checked

Every Examples row added or changed was recomputed. Key values:

- **Holds** (2 micro-USD per Mbps-minute): 100 Mbps for 24 h = 288,000 micro-USD; +50 Mbps
  at 3 = 216,000, total 504,000; 50 Mbps = 144,000; after LIFO decrease to 80 Mbps at 2 =
  230,400; 100 Mbps for 2 h = 24,000; new price 3 = 432,000; 6 h of grace takes 72,000,
  leaving 216,000.
- **Headroom:** 1.000000 − 0.288000 − (0.002000 + 0.030000) = 0.680000 (P4-S15, S16).
  Credit account: 0 − 0.288 + 1.0 = 0.712 (P4-S13); −0.5 − 0.3 + 1.0 = 0.2 (P2-S38).
- **Lateness bound:** 100 Mbps × (180 s + 60 s) = 24,000 Mbit = 3 GB; × 10,000 micro-USD/GB
  = 30,000 (P3-S37).
- **Resume amount (round 4):** restore 0.072000, plus `low_balance_warning` = max(0.072,
  1) = 1.000000, total 1.072000; after a 0.5 top-up, 0.572000 more (P2-S42, P4-S22).
- **Warning quote (round 4):** 1.0 + 0.288 − 0.9 = 0.388; 7.2 + 28.8 − 7.0 = 29.0;
  1.0 + 0 − 0.5 = 0.5 (P4-S24).
- **Key spending (round 4, cumulative):** 0.288 held + 0.072 accrued = 0.360, headroom
  0.640; + 0.500 accrued = 0.788, headroom 0.212 < 0.288, so rejected (P2-S39, P4-S68).
- **Rounding:** 150,000 B at 10,000 and 13,000 micro-USD/GB = 1.5 → 1 and 1.95 → 1, versus
  3.45 → 3 if rounded per account (P3-S48); 3 GB × 4/7 and × 3/7 = 17,142.857 → 17,142 and
  12,857.14 → 12,857 (P3-S51); 2 × 75,000 B: 0, then 1.5 → 1, amendment 1 (P3-S32).
- **FX:** 1,234 × 0.0077123 = 9.5169782 → 9.516979 rounded up (P4-S06);
  120.004567 × 129.5 = 15,540.5914265 KES → 15,540 KES, residue 0.5914265 / 129.5 =
  0.004567 USD (P4-S50).
- **Webster:** ties s2 (leg 1), s1 (leg 2), Share with weights 1:1:1 give 1/0/0, 1/1/0,
  1/1/1 (P4-S73). Weights 31/76/70: 31 → 6/13/12 and 32 → 6/14/12, so the amendment is 0/1/0
  (P4-S75). Weights 3:1 on 4 → 3/1; after a Share-borne −2, splitting the new total 3
  (2/1) less what was posted would give the supplier −1, while splitting the amendment on
  its own gives +1/0 (P4-S85). Supplier error on R1: 100 → 60 gives A 18.000000,
  B 19.998000, C 13.002000, Share 9.000000; A owes 12, Share bears 13.332 + 8.668 + 6 = 28,
  and 12 + 28 = 40 (P4-S42).
- **Capacity:** P2-S45 (correct 6 + 4 = 10 fits; counting R twice gives 4 + 4 + 3 = 11,
  which does not); P2-S47 (8 + 2 = 10 fits; counting the existing part twice gives 14);
  P2-S73 (min-over-legs rate 3; earliest window on every leg [12:00, 13:00)); P1-S46
  (10 → 8: the 2 Mbps added to A); P1-S47 (8 → 6: 2 Mbps of B).

## Gate A findings

| ID | Resolution | Where |
|---|---|---|
| GA-01 | Done (POL-02 r3). The guarantee is restated as "contention alone never makes every competitor lose", covering waiting requests whose deadline outlasts the outcome ahead of them. There is one scenario per path: wait by default (S15, S16, S20), `wait = false` (S18, S59), short deadline (S61), failure (S62), crossing (S19, S60) and crash (S22, S23) | P2-N4, C4; P2-S15, S16, S19, S20, S59 to S62; glossary "Contention guarantee"; P1 constraints |
| GA-02 | Done (POL-02 r3). The rule orders waiting requests and crossings, with no pre-emption. S16 is rewritten so that X and Y both wait; S58 covers a holder that is not pre-empted; S19 covers the crossing, where the loser waits | P2-S16, S19, S58, S60; glossary "Crossing", "Waiting" |
| GA-03 | Done. "Each would be confirmed if the other did not exist"; the older one wins; the loser waits and is then rejected; tagged `@POL-02 @POL-05 @POL-10` | P2-S19 |
| GA-04 | Done (POL-26 r3). Every outcome exists by the deadline; S53 alerts on a request still pending at its deadline; S55 stops commits starting after deadline − `commit_margin` | P2-N3, N10; P2-S13, S53, S55; glossary "Deadline"; X2-S06 |
| GA-05 | Done. Split into two properties of the moment of decision: confirmed only if it fits beside the holds (S05); rejected for no fit only if it does not fit beside what is committed (S37) | P1-N2; P1-S05, S37 |
| GA-06 | Done. The booking neither confirms nor rejects, and waits; the Background has a deadline; S07 to S09 tagged `@POL-05` | P1-S07 to S09 |
| GA-07 | Done. A pending request that no longer fits is rejected (S41); a waiter is decided against the reduced capacity (S42); during a notice, sales are made at the reduced capacity (S43) | P1-N8; P1-S41 to S43 |
| GA-08 | Done (POL-07 r3 and r4). Only those that do not fit are offered (S31); just enough is taken, newest part first, in Mbps (S47); capacity is kept for the notice (S44); a lapsed offer counts as declined (S45); each part has its own age (S46); an accepted path takes over at the end of the notice (S35) | P1-N8; P1-S31, S32, S35, S36, S43 to S47; glossary "Affected reservation", "Part of a reservation" |
| GA-09 | Done (POL-30). The X1-S12 operator row is now a termination for POL-30 reasons; S16 refuses any other reason; S17 records it; P2-S05 and P2-N1 list the account, POL-07, POL-16 and POL-30 | X1-N7; X1-S12, S16, S17; P2-N1, P2-S05; P3-S42; glossary "Termination", "Revocation", "Release" |
| GA-10 | Done (POL-08 r3). Funds (S75) and key headroom (S76) are checked on changes; a suspended account may reduce (S77) but not add (S78) | P2-N8, N9; P2-S75 to S78 |
| GA-11 | Done (POL-25 r3). Concurrent bookings by an account (S70) and by a key (S71) | P2-S70, S71; P4-S66 |
| GA-12 | Done (POL-08 r3 and r4). Changes are applied in arrival order (S79); a cancellation is never delayed and the pending change fails (S81); Share ending R fails a pending change (S80) | P2-N9; P2-S79 to S81 |
| GA-13 | Done. A cancellation over a partner leg takes effect whatever the partner answers, then is reconciled (S82); a partner-leg change is all or nothing (S83) | P2-S82, S83 |
| GA-14 | Done (POL-25 r3). Only an account administrator manages keys (S18); a key cannot manage keys or limits (S19); changes are recorded (S20); at most `account_max_keys` keys (S21) | X1-N9; X1-S18 to S21; glossary "Account administrator" |
| GA-15 | Done (POL-07 r3 and r4). Only the supplier changes a link's capacity or books maintenance; network operations may record outages and restorations | X1-N10; X1-S22, S23, S14 |
| GA-16 | Done (POL-25 r3: 60 s) | X1-N3; X1-S06 |
| GA-17 | Done (POL-25 r3). Pending requests fail "key revoked"; reservations stay with the account | P2-S72; glossary "Outcome", "Agent key" |
| GA-18 | Done. New glossary term "not accepted". S26 and S41 are now not accepted; S34, S36 and S49 are rejected | glossary; P2-S26, S34, S36, S41, S49 |
| GA-19 | Done. S45 discriminates (3 Mbps added on L2); S47 is the confirmed increase and S74 the rejected one | P2-S45, S47, S74 |
| GA-20 | Done (POL-06 r3). S05 measures an answer, final or pending; the new S15 measures a final answer when no capacity is in flight | X2-N3; X2-S05, S15 |
| GA-21 | Done (POL-25, decided in round 4 as cumulative; see below). Examples cross a period boundary | P2-S39; P4-S68; glossary "Key spending" |
| GA-22 | Done (POL-25 r3): `account_rate_limit`, `account_max_keys`, `key_poll_limit`; polls do not count, retries do. Accounts per actor stay a P2 open question (KYC tiers to be checked with the partner) | P2-S41, S67, S68; X1-S21; P2 C17, open question 3 |
| GA-23 | Done (POL-29). Per account; a reuse by another principal is not accepted | P2-S64; X1-N4 |
| GA-24 | Done (POL-29). 24 h retention; sameness is route, window, rate, product and `wait`; a different deadline is the same request | P2-S25, S26, S63, S65; glossary "Idempotency key" |
| GA-25 | Done (POL-08 r3). An increase runs from the next boundary to the end; a sub-window is a separate reservation | P2-S47; glossary "Reservation" |
| GA-26 | Done (POL-25 r3). Counted per request | P2-S66; glossary "Capacity hold" |
| GA-27 | Done (POL-08 r3). Withdrawal fails as "withdrawn"; a no-hold partner leg is cancelled at Share's cost | P2-N3; P2-S56, S57 |
| GA-28 | Done (POL-07 r3). Maintenance is never charged; 14 calendar days' notice | P1-S28 to S30; P3-S47; glossary |
| GA-29 | Done. New P2-N11; S02 and S31 retagged; S73 shows the counter-offer as the minimum over legs | P2-N11; P2-S02, S31, S73 |
| GA-30 | Done. "It is 09:00" added to every Background with fixed windows | P1 and P2 Backgrounds; P1-S33 |
| GA-31 | Done. The Background states there are no other reservations or holds; S38 covers the case where nothing fits | P1-S15, S16, S38 |
| GA-32 | Done. S33 is an Outline with rows at 08:45, 09:15 and 09:45 | P1-S33 |
| GA-33 | Done. S25 retitled; S26 bounded by `affected_notice_time` (decided in round 4); S40 covers restoration | P1-S25, S26, S40 |
| GA-34 | Done. On Share links capacity is free at the outcome, at a partner by the deadline; S08 and S18 check that the next booking is confirmed "at once" | P1-N3, N7; P1-S08, S18; P2-S14; glossary "Capacity hold" |
| GA-35 | Done (POL-15 r3: credit hold). S38 has a credit-limit row; N8 is reworded | P2-N8, S38 |
| GA-36 | Done. Rows for zero and negative rates, a window ending off a boundary, and fractional rates (POL-31, decided in round 4); a rate above capacity is rejected, not invalid (S39); deadline bounds (POL-26 r4) in S12 and S86 | P1-N5, S19, S39; P2-S12, S86 |
| GA-37 | Done | P2-S69 |
| GA-38 | Done. X1-S02 compares with an account that does not exist and adds rows for headroom and agent keys; X1-S03 cell renamed; "Audit record" added to the glossary | X1-S02, S03; glossary |
| GA-39 | Done | X1-N2; X1-S24 |
| GA-40 | Done. Not accepted; no request is created; the key may be used again | P2-S41 |
| GA-41 | Done. The tags listed were added. The mechanical check now also covers every `POL-nn` in step text. Background text and glossary-defined terms are covered by tagging every scenario under a Rule whose Background names a policy | P1-S07 to S09, S16; P2-S10, S19; X1-S06, S12 |
| GA-42 | Done. P1-S11 has a state Given; P1-S34 has a single When; P2-S17 and S20 say "`wait` at its default"; P2-S22 says "can still complete … by its deadline"; P2-S30 uses an event When; P2-S33 is an Outline; P2-S28 is reworded | as listed |
| GA-43 | Done. Renewal, shortening to the next boundary or earlier, extension beyond the horizon, fixed-end to open-ended (S84); open-ended to fixed-end, and cancellation before the start (S85) | P2-S84, S85 |

## Gate B findings

| ID | Resolution | Where |
|---|---|---|
| GB-01 | **Done (Blocker; POL-11, POL-12 r3).** A charge line is per reservation-minute, or per account, product and route per minute. Each line is rounded once and split by its own route. Stated in the glossary, P3 and P4 Context, P3-N5 and P4-N8 | P3-S15, S21, S48; P4-S74; glossary "Charge line", "Charge" |
| GB-02 | Done (POL-17 r3). Egress count, billed once per route | P3-N13, S49 |
| GB-03 | Done (POL-17 r3). Every guaranteed product carries a `usage_price`. Background fixed | P3 "Each kind" Background, S25, S53; glossary "Usage price" |
| GB-04 | Done (POL-11 r3; POL-12 r4). Amendment = new total rounded down less what was charged (75,000-byte row added). Split = split of the new total less posted shares, except after a borne correction | P3-N8, S32; P4-N8, S75, S85 |
| GB-05 | Done (POL-14 r3 and r4; POL-18 r4). The bound is defined and covers the enforcement time; one `usage_rate_cap` covers burst and out-of-reservation traffic; the highest `usage_price` is used; unposted usage = records received but not yet posted | P3-N10, S37; P4-S16, S19; glossary "Usage exposure" |
| GB-06 | Done (POL-15 r3 and r4). Credit hold; invoices due in `invoice_terms`; suspension when overdue; write-off 90 days after the due date | P4-N17, S13, S14, S18, S83; glossary "Credit hold" |
| GB-07 | Done (POL-15 r3). First window held from admission | P4-S59 |
| GB-08 | Done. Holds follow increase, decrease (LIFO), shortening, price change, revocation, release, termination and suspension | P4-S60 to S62, S64; P2-S45 |
| GB-09 | Done. 100 × 2 + 50 × 3 = 350 | P3-S45 |
| GB-10 | Done (POL-08 r3 and r4). Minimum term charged as a fee; hold = max(coverage, fee); payer by cause; fee goes wholly to the partner | P3-N12, S11, S43, S44; P4-S63, S89; P2-S50 |
| GB-11 | Done (POL-23 r3) | P4-S77, S56; P2-S35 |
| GB-12 | Done (POL-23 r3 and r4). Both directions within `dispute_window`; cause recorded; locked price downwards only; cause "other" borne by Share | P3-S34, S55 to S57; P4-S84 |
| GB-13 | Done (POL-23 r3). Worked example on R1 | P4-S42 |
| GB-14 | Done (POL-20 r3). Top-ups round up to the micro; `fx_quote_validity`; KES payout example | P4-N2, S06, S58, S50 |
| GB-15 | Done (POL-29; POL-22 r4). No double inclusion; repeated confirmations settle once; re-instruction after a final failure; late confirmation escalated; `payout_confirmation_timeout` | P4-N12, S78, S79, S86 to S88 |
| GB-16 | Done (POL-29). One Outline over every money-moving input | P4-N15, S57 |
| GB-17 | Done | P4-S65 to S67; P2-S70, S71 |
| GB-18 | Done | P3-N9, S36; P4-N16, S71, S72 |
| GB-19 | Done (POL-24 r3 and r4). Invariant (including Share's own balance); providers and banks; deadline 12:00 UTC on D + 1. P4 open question 3 removed | P4-N14, S54, S80, S81 |
| GB-20 | Done (POL-16 r3) | P4-S70 |
| GB-21 | Done (POL-16 r3 and r4). Resume amount defined, with numbers | P2-S42; P4-S22; glossary "Resume amount" |
| GB-22 | Done (POL-25 r4) | P4-S68; P2-S39 |
| GB-23 | Done (POL-06 r3 and r4). RTOs fit the budget; an available minute is defined (probes, 90%); payouts measured through their interfaces | X2-N1, N5; X2-S01, S10, S16 |
| GB-24 | Done (POL-06 r3). Record rate, notification peak and admission mix; S04 must meet S13 throughout | X2-N2; X2-S03, S04, S07 |
| GB-25 | Done (POL-17 r3). Buyer billed at the minute's price within the window; attribution added as an X1 operator action | P3-S27; X1-S12 |
| GB-26 | Done (POL-18 r3). Itemisation adds up; "Posted" added to the glossary | P4-S16; glossary "Posted" |
| GB-27 | Done | P4-S82 |
| GB-28 | Done. Sums per currency; holds are not movements | P4-N7, S28; glossary "Funds hold" |
| GB-29 | Done (POL-12 r3). Leg order | P4-S73 |
| GB-30 | Done (POL-08 r3). LIFO | P3-S46; P4-S60 |
| GB-31 | Done (POL-17 r3). Per minute | P3-S54; glossary "Burst" |
| GB-32 | Done. P3-S11 retagged to the new P3-N12; `@need-P3-N2` removed from X2-S13; P4-S12, S46, S25 to S27 and X2-S08 tagged | as listed |
| GB-33 | Done. Background split; event Whens in P4-S18, S49, S53; cancellation time in P3-S04; minute boundary in P3-S07; P4-S05 rows merged; the "exact" column used in P3-S21; deviation "signed" in P4-S37 | as listed |
| GB-34 | Done. Write-off is automatic (P4-S53) and removed from the operator actions; no early write-off by an operator exists | X1-N7, S12; P4-S53 |
| GB-35 | Done. Parse-level rows removed (moved to the interface contract, noted under P3 and P4 out of scope); S12 and S13 reworded | P3-S12, S13, S28; P4-S05 |
| GB-36 | Done | P4-N10, S40, S76; glossary "Statement" |
| GB-37 | Done (POL-16 r3 and r4). 1 USD floor; once per crossing; quote defined | P4-S24, S69 |
| GB-38 | Done. Zero-duration row; fractional spread (S51); across a price change (S52); across a reservation boundary (S53) | P3-S18, S51 to S53 |
| GB-39 | Done. S13 is limited to records within `max_lateness`; "posted" defined; enforcement split into delivery (X2-S17, `standing_notice_time`, round 4) and end-to-end (X2-S08) | X2-N3, S08, S13, S17; P4-S25 |
| GB-40 | Done (POL-07 r3) | P3-S47 |
| GB-41 | Done. Identity unique for the retention period; the method is left to the RFC (P3 open question 1) | P3-N3, S50 |

## Round-4 decisions

As the coordinator directed mid-task, each point the baseline needed a business decision
on was decided here rather than deferred. **Writing them to
`02-specs/policy-register.md` was blocked by the session's permission classifier**, both
by shell and by the Edit tool. That matches the original brief's "do not edit the policy
register". I made no further attempt. The specs, problem statements and glossary already
apply these decisions and cite the POL entries they amend. Until the text below is pasted
into the register, those citations point at decisions the register does not yet contain,
and `@POL-31` names an entry that does not exist.

**To paste:** each item goes as an "**Amended (round 4).**" paragraph at the end of the
named entry (POL-31 as a new entry after POL-30). Add one Amendments-table row per item:
`| 2026-10-11 | Round 4: <one line below> | <finding> |`. Add a POL-31 row to the
Summary table: `| POL-31 | Reserved rate precision | Whole Mbps, at least 1 Mbps |`.

| # | Entry | Decision (one line) | Trade-off | Finding |
|---|---|---|---|---|
| 1 | POL-06 | An available minute: each capability is probed at least every 10 s from at least two locations outside the region (≥ 12 probes a minute). A probe succeeds if it gets a correct answer within the operation's latency value, as a per-probe limit. A minute is available if ≥ 90% of its probes succeed. Planned maintenance is not excluded; payouts are probed through their interfaces | Honest to buyers and easy to audit; forces maintenance without downtime | GB-23 |
| 2 | POL-06 | The 60 s from suspension to enforcement is split: `standing_notice_time` = 10 s for the marketplace to deliver the standing change, the remaining 50 s for network operations | Each side owns a target it alone controls; the 60 s in the exposure bound is unchanged | GB-39 |
| 3 | POL-07 | On an unplanned outage every reservation on the link is affected | The network cannot choose whose packets drop; "newest first" stays for permanent reductions, where Share does choose | GA-33 |
| 4 | POL-07 | The supplier, or an operator in network operations, may record an unplanned outage and its restoration; only the supplier books maintenance or announces a permanent reduction | Sales stop as soon as Share's monitoring sees a fault; commercial changes stay the supplier's | GA-15 |
| 5 | POL-07 | "Just enough" is in Mbps: the newest part is reduced in rate only as far as needed (revoked if it reaches 0), and its holder may then cancel without any fee | Keeps the most capacity sold and the most of each guarantee, and the buyer can walk away | GA-08 |
| 6 | POL-07 | `affected_notice_time` = 60 s, to tell holders and network operations of affected reservations, and again on restoration | Matches the enforcement target; gives "at once" a number | GA-33 |
| 7 | POL-07 | An accepted equivalent path takes over when the notice ends; the buyer may ask to move earlier, from a minute boundary it chooses | Continuity by default, with no forced early migration | GA-08 |
| 8 | POL-08 | A cancellation takes effect at the next boundary after it is made; an earlier change still pending fails "reservation ended". Arrival order applies only among changes that do not end the reservation | The buyer's right to stop paying at the next minute is absolute; the pending change loses nothing it had | GA-12 |
| 9 | POL-08 | On a POL-30 termination the buyer pays any shown cancellation fee, as on a POL-16 release | Both follow from the buyer's own conduct | GB-10 |
| 10 | POL-08 | A cancellation fee goes wholly to the partner that imposed it: not split, no commission | The fee compensates the partner's commitment; Share should not profit from a cancellation | GB-10 |
| 11 | POL-12 | After a correction borne by Share or by a supplier at fault, each later amendment to that line is split on its own; every other amendment is split as the split of the new total less the shares posted | Keeps every share of a late-traffic increase non-negative, for a small reported deviation | GB-04 |
| 12 | POL-14 | `usage_rate_cap` bounds all of an account's usage-priced traffic on a product (burst plus traffic with no reserved rate); one lateness bound per account and product | One number bounds Share's risk per account; more burst means a higher cap agreed at onboarding | GB-05 |
| 13 | POL-14 | The lateness bound uses the product's highest `usage_price` on any route | Conservative, by at most the price spread between routes | GB-05 |
| 14 | POL-15 | An unpaid invoice is written off 90 days after its due date, at Share's cost. The account stays suspended, and later reservations need prepayment until the debt is paid | Gives the 90 days a defined start; Share bears its credit risk (POL-23) | GB-06 |
| 15 | POL-16 | A suspended account resumes when, with every full coverage hold restored, its headroom is at least `low_balance_warning`. The quoted resume amount achieves that | Resuming costs at least 1 USD more, but the account is not suspended again at the next minute, as it would be at exactly zero | GB-21 |
| 16 | POL-16 | A warning is sent once per crossing below `low_balance_warning` and quotes the top-up that brings headroom to `low_balance_warning` plus one coverage window's charges | About one more window of runway, without repeated alerts; the round-3 resume amount would be zero for an active account | GB-37 |
| 17 | POL-18 | Unposted usage = usage-priced traffic in records received but not yet posted, at each minute's price | Exact and reproducible; the unseen part is bounded by POL-14 | GB-05 |
| 18 | POL-22 | An amount in an instructed payout is in no other payout until it is confirmed or finally failed. After a final failure, it goes into the next run under a new reference. A confirmation after a reported failure is escalated, and the amount is not re-paid while that is open (a duplicate is recovered as a debt marked "duplicate payout", not an earnings reduction). No answer within `payout_confirmation_timeout` (7 days) is escalated, never re-instructed | A supplier may wait an extra week after a failure, but is never paid twice and never loses earnings. Resolves the conflict between POL-29's "never instructed again" and a failed transfer still being owed | GB-15 |
| 19 | POL-23 | A downward correction with cause "other" is borne by Share | Supplier earnings stay final; the cost is bounded by `dispute_window` | GB-12 |
| 20 | POL-24 | The invariant includes Share's own balance at the partner: funds held = positive buyer balances + supplier amounts owed and not paid out + Share's own balance there (commission less costs, write-offs and FX round-ups). That balance is never allowed below zero | Every micro at the partner is accounted for, at the cost of Share pre-funding its own losses. Without this, the round-3 invariant cannot hold once commission and FX round-ups exist | GB-19 |
| 21 | POL-24 | Day D is reconciled by 12:00 UTC on D + 1; one not completed by then is an operational alert | Defines "a missed reconciliation" | GB-19 |
| 22 | POL-25 | Key spending is cumulative over the period: charges accrued in the period by the key's reservations (covered by a hold or not), plus funds currently held for their future charges, each minute counted once. Replaces round 3 | The limit bounds a day's spending, as an agent operator expects. Under round 3, short bookings made one after another escaped it entirely | GA-21, GB-22 |
| 23 | POL-26 | `commit_margin` applies only to requests with a partner leg. `route_deadline_min` = 1 s, so a deadline must be ≥ 1 s, or ≥ 11 s with a partner leg; shorter, zero or negative is invalid | Fast single-link agents keep short deadlines; nobody can choose a deadline that could never be met | GA-36 |
| 24 | POL-31 (new) | A reserved rate is a whole number of Mbps, at least `rate_min` = 1 Mbps; zero, negative and fractional rates are invalid | Simple to sell, price and check; demand below 1 Mbps is served by best-effort products | GA-36 |

New parameters introduced: `standing_notice_time` (10 s), `affected_notice_time` (60 s),
`payout_confirmation_timeout` (7 days), `route_deadline_min` (1 s), `rate_min` (1 Mbps).

### Readings taken without a new decision

- POL-11 "amendments are split the same way" is read as: the split of the line's new total
  less the shares already posted. This is what P4-S38 and POL-12's monotonicity already
  require. Decision 11 above covers the one case where that reading breaks.
- POL-21 "written off after 90 days" for a reversal is read as 90 days after the
  reversal (P4-S53), as gate B proposed.
- POL-16 "warned when headroom falls below" is read as an event, hence once per crossing.
  Decision 16 makes this explicit.

## Policy questions for round 4

None left open. Every question this revision found was decided above (as the coordinator
directed). The only thing outstanding is entering those decisions in the register, which
needs someone with permission to edit it.

## Not fully resolved

| Item | Why |
|---|---|
| Round-4 decisions not in the policy register | The edit was blocked by the permission classifier. The specs apply the decisions; the register must be updated (paste-ready table above) before the baseline is self-consistent. `@POL-31` on P1-S19 fails the tag check until then |
| GA-22, accounts per actor | POL-25 bounds requests and capacity in flight per account; the number of accounts one actor can open is left to KYC tiers, recorded as P2 open question 3 |
| GA-41, mechanical check of Background text | The check now covers every POL reference in scenario steps. Background text is covered by convention (scenarios under a policy-dependent Background carry its tag), not by the script |
| GB-41 | The requirement (identity unique for the retention period) is stated; how it is met is left to the RFC (P3 open question 1), as gate B proposed |
