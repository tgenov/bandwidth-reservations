# Review 23. Fix verification of RFC-002 and RFC-004 (revision 4), joint

| | |
|---|---|
| Under review | [RFC-002](../03-rfcs/RFC-002-booking-coordination.md) Draft rev. 4 (S-ACCT) and [RFC-004](../03-rfcs/RFC-004-wallet-and-settlement.md) Draft rev. 4 (S-MONEY) |
| Findings verified | [Review 18](18-rfc-002-004-joint-review.md) J-01 … J-20, D-1 … D-6, Q-1 … Q-3, A-1 … A-3; [review 19](19-rfc-003-review.md) F3-01, F3-02, F3-04, F3-07, F3-08 (RFC-004's settlement side) |
| Mode | Confirmation only: each finding's named passages, the authority they rely on, and the joint interface (RFC-002 §2.3, §2.4, §7.3, §9.2, §9.4 against RFC-004 §A2 … §A10, §B2, §B3.1, §B5, §B12) |
| Authority | `requirements-v1.8` (POL-06, POL-07, POL-08, POL-14, POL-16, POL-25, POL-27; P2-S117, P4-S108, P4-S114, P4-S115, P4-S116, X2-S15, X2-S27); [RFC-000](../03-rfcs/RFC-000-architecture.md) rev. 4.2 (§3 budget, §8 lifecycle-feed closure (1) and (2), invoice-status feed, credit-limit command, AI-17-3, AI-17-5, AI-19-1, AI-19-2, R23) |
| Tools | `impact.py coverage S-ACCT`: primary 117, uncited 0, dangling 0. `impact.py coverage S-MONEY`: primary 116, uncited 0, dangling 0. `check_specs.py`: no problems (462 scenarios) |

## Verdict

- **RFC-002: ACCEPT.** Every finding it owns or shares is present, correct and consistent with RFC-000 rev. 4.2.
- **RFC-004: ACCEPT WITH CHANGES.** Five defects, V-1 to V-5. Each is a precise local edit of one to three lines. The orchestrator may apply them directly instead of running another round.

## Review 18 findings

| ID | Result | Where checked | Notes (re-trace) |
|---|---|---|---|
| J-01 | **Verified, with V-1 to V-3** | RFC-002 §2.2 E1/E5, §2.4 `admit` and item 8, §9.2, T6; RFC-004 §A5.2, §A5.3, §A10 `Ask.ahead`, JR-5, §B13 | The extend-after-increase trace now holds the envelope (36,000), binds `R(after) − R(before)` at E5 and releases the excess (12,000 if the increase fails); no suspension. The extend-after-shorten case, held for [14:00, 20:00), holds. The joint `Ask` fields match on both sides. Defects: the normative `ρ⁺` rule gives 0 beyond the current end (V-1); the example is internally inconsistent (V-2); the "only posting drift" claim misses a price step (V-3) |
| J-02 | Verified | RFC-002 §1.2, §9.1, §2.4 item 9, T9; RFC-004 §A2 segments, §A3 `KS_k`/`KP_k`/`H_{r,k}`, §A7 P2-S117 rows, §B13 | K2 increasing K1's reservation now counts to K2. P2-S117 rows 1 and 2 recompute (288,000; 144,000). Rounding is upward, so the cap is never understated. The fee is attributed to the booking key, as stated |
| J-03 | Verified | RFC-002 §1.3, §2.1, §2.5 step 2–3, §3.1 step 4, T3; RFC-004 §A10 "Time", JR-7 | `ts` is read first, then the batch is evaluated in sequence order. A push re-evaluates the whole batch, and an E1 may become E1′ and the reverse. Both RFCs state the same rule. The push across 00:00 UTC and across a fee-term end is in T3 |
| J-04 | Verified | RFC-002 §2.3 F11, §9.4 price-change row, JR-4, T15, P4-S108 row; RFC-004 §A4 F11/E11, §A10 call site, JR-4, §A11 | One entry per (account, price version), holding F11 and one E11 with `PriceTookEffect` for each reservation, idempotent. Both sides match, and P4-S108 recomputes (top-up 44,000) |
| J-05 | Verified | RFC-002 §2.3 F5/F6, §7.3, §12.2 S11, §13.1, §13.2, T14; RFC-004 §A4 gate, F5, F6, §B5, §B9, §B12; RFC-000 §3, §8 rows | The write-off-before-`W` trace: the F6 and F5 are held until the F1 reaches `P_e`, and the held rows survive takeover (S11). No transient resume. Matches RFC-000 A-1, and §3 now names receivables |
| J-06 | Verified | RFC-004 §A4 F1 (removes the M19's invoice from `OD`), F6 *written off*, §B5 write-off row and `I`, §A7 P4-S94 e1, P4-S111, P4-S114 row 2; RFC-002 §2.3 | `W` and `OD` change in the same F1. P4-S111: `x − r` goes to I2 only. P4-S94 e1 resumes after 11.0. P4-S114 row 2 recomputes (2,500,000) |
| J-07 | Verified for RFC-002; **V-4** in RFC-004 | RFC-002 §2.2 E11, §2.5 step 3, §9.4 "When the entry is written", §12.2 S12, T15; RFC-000 §8 lifecycle closure (1), (2), AI-17-3 | Moves and price steps are recorded when known, and a late cause takes the next boundary and alerts. Revocation now goes through cut targets effective at `T_eff`, under RFC-000's closure-holding exception (2). The original overcharge trace (owner down across 10:00) no longer closes 10:00 at the full rate, because rating's closure stays at `T_eff` while the reduction is open. RFC-004's text still describes revocation as recorded ahead and never before `ts` (V-4) |
| J-08 | Verified | RFC-002 §1.3 `W_a`, §2.5, §8.1, §14, Benefits, RB-16, T8; RFC-000 §3 table, R19, R23, AI-17-5 | About 16,384 slots, 6.8 entries/s per slot (about 112,000/s ÷ 16,384), occupancy about 0.11. The figures 176 / 186 / 196 ms, and the hottest link +10 ms, equal RFC-000 rev. 4.2's budget. The thin margin is tracked as RB-16 / R23, and the second lane is the fallback |
| J-09 | Verified | RFC-004 §A2 `fee_state_r`, §A3 fee part, §A4 F1 (`charged`), §A6 shorten rows; RFC-002 §2.2 E11, §9.5 | A fee posted by M10 is never held again |
| J-10 | Verified | RFC-002 §2.3 F7, §2.4 item 13, §2.5 step 3; RFC-004 §A4 F7, §A10 `apply` → `Deferred`, JR-9 | |
| J-11 | Verified | RFC-004 §A3 probe paragraph | Every `apply` re-evaluates `H_r` at `ctx.ts`, and the hold is Closed at `end_r`. KYB is provisioned through F4 before F5. Probe sizing disagrees with RFC-002 (V-5) |
| J-12 | Verified | RFC-002 §2.4 `standing`, §5.5 step 1, §12.2 S14; RFC-004 §A10 call site, JR-10 | |
| J-13 | Verified | (a) five F7 variants on both sides; (b) `rate_check(…, now, …)` on both; (c) E1′ carries the `Ask`, the verdict and its amounts (RFC-002 §2.2, RFC-004 §A4); (d) a suspension ends only undecided additions (RFC-002 §2.3 F1, §7.2; RFC-004 §A10) | |
| J-14 | Verified | RFC-002 §2.5 step 3 (savepoint, 10 ms lock timeout), §5.6, §12.2 S10 | One E5 is deferred; the slot does not stall |
| J-15 | Verified | RFC-002 §9.4 bullets, §13.1 command-port row, T6 | A cut or a price step fails nothing. A move fails only a change in progress on the removed legs. An ending fails everything (P2-S80). The envelope of a change left queued after a cut is still an upper bound, because a cut only lowers `ρ⁺` (RFC-004 resolution row) |
| J-16 | Verified | RFC-004 §B5 invoice-payment row | `x − r` |
| J-17 | Verified | RFC-002 §2.2 E1, §3.2 "Price freshness", B-AI-11 | Versions are published at least 60 s ahead, and the cache is within 60 s of `ts`. Together these mean every version in force at `ts` is in the cache |
| J-18 | Verified | RFC-002 §12.2 S8, §13.2 alert; RFC-004 §A3 (`rto_adm` in `Λ`), §A7 argument, §B12 | The 430 s bound per v1.8 Q-1 |
| J-19 | Verified | RFC-002 Benefits `ack_budget` row, §8.1 | Restated to J-08's figures |
| J-20 | Verified | RFC-004 §A3 `RA`/`RH`, §A5.1 check 1, §A7 P4-S114, §A10 `ResumeQuote`; RFC-002 §2.2 E1′, §7.2 | The quote is itemised as `W`, each overdue invoice, then `RH` |
| D-1 … D-6 | Verified | As J-01, J-02, J-07, J-06, J-20, J-12 | D-3 is realised for moves and price changes. For revocations it is replaced by RFC-000 rev. 4.2's closure-holding rule (2), which reaches the same buyer outcome |
| Q-1 … Q-3, A-1 … A-3 | Verified | Resolved in v1.8 (POL-14, POL-25, POL-16) and RFC-000 rev. 4.2 (§3, §8); cited in both RFCs' resolved tables | |

## Review 19 settlement points (RFC-004)

| ID | Result | Where checked | Notes |
|---|---|---|---|
| F3-01 | Verified | §B2 M23, M12/M13 references with amendment sequence 0, §B1.2 nil line, §B3.1 input contract, §B9 | P4-S116 rows 1 and 2 recompute: nil line; `S:A:debt −1,500`, `SH:costs +1,500`, balanced |
| F3-02 | Verified | §B2 M13 "as booked", §B3.4, §B12 | P4-S115: buyer 3, Share 1 + 4, path suppliers 8 in total, nothing paid twice |
| F3-04 | Verified | §B3.1 batch-kinds table, oversized usage batch refused; §B1.2; §A4 F1/F2 (`whole` and `Δ_b` over usage batches only); §B10 | Matches RFC-000 AI-19-1 |
| F3-07 | Verified | §B2 M4/M13 (the route the line carries), §B3.1 "Routes after a move"; RFC-002 §9.4 move row (catalogue route ID; non-catalogue paths refused) | The joint interface matches (AI-19-2) |
| F3-08 | Verified | §A3 one `LB` definition with span `[ts − 370 s, ts + 60 s]`, §A4 F3, F7 *exposure step*, §A7 examples | `LB` 53,750; the decrease steps at 12:06:10 and an increase at 11:59:00, as computed. Rating no longer publishes `LB` |

## Defects

All are in RFC-004 and all are local edits.

| ID | Location | Failure | Fix |
|---|---|---|---|
| V-1 | §A5.2, "The envelope", items 1 and 3 | `ρ⁺(m)` is defined as the charge rate of `r` *at* `m`. For an extension, `m ∈ [e⁻, E)` lies at or after the end that some outcome leaves, where that rate is 0, so the normative rule funds an extension with 0 and reproduces J-01. The example (300 µ/min) and RFC-002 §9.2 ("the largest rate any outcome leaves") use the intended reading | Item 3, extension: "it is at most `ρ̂ = max ρ⁺` over `[e⁻ − 1 min, e⁺)` (the highest rate any outcome can carry past its end, since an extension continues every part active at the end) for every `m ∈ [e⁻, E)`." |
| V-2 | §A5.2, "Example (J-01's trace)" | The example says "Open-ended `r`" with `H_r = 288,000` and the increase's `h = 144,000` (24 h coverage), then extends "a 2 h window [10:00, 12:00)". An open-ended reservation has no end to extend, and a 2 h window holds 24,000. The `x` figures (36,000 / 24,000 / 12,000) are right only for the fixed window | Replace the first sentence with: "`r`: 100 Mbps at 2 µ over `[10:00, 12:00)`, `H_r = 24,000`. An increase by 50 Mbps at 2 µ over the window is queued (`h = 12,000`). Behind it, an extension to 14:00 is submitted at 10:00." The table is unchanged |
| V-3 | §A5.3, second paragraph ("can now come only from posting drift"); revision 4 summary item 1; §B13 simulation row ("never a shortfall at a decision beyond posting drift") | `cov_r` prices minutes at the current price until F7 *price effective* (§A6). A price step whose tick commits between a request's intake and its decision (open-ended `r`: a new booking, or an increase, queued or not) makes `R(after) − R(before)` exceed `h_q`. The claim is then false, and the simulation, which includes price changes, would report it | Either (a) in §A5.2 item 3 and the first two rows, price each minute at or after a recorded step's effective minute at the stepped price when it is higher (the excess is released at the decision anyway), or (b) amend the sentence to "only from posting drift or a price step taking effect between intake and decision (POL-27, announced `price_notice` ahead, so not by surprise), both handled as a failed roll-forward", and add "or a price step" to the §B13 row and summary item 1. (a) keeps invariant A-2's wording intact |
| V-4 | §A4 E11 row ("revocation due … never before the entry's `ts`"); §A6 "Reservation ends" row ("An end recorded ahead of its minute (revocation due, A-3)") | RFC-002 rev. 4 implements revocation and every POL-07 cut as a cut target sent at or after `T_eff` and effective at `T_eff`, which is before `ts` (RFC-002 §2.2 E11, §9.4; RFC-000 §8 closure (2), AI-17-3). RFC-004 still states that every E11's effective minute is at or after `ts` and that revocations are recorded ahead. The joint E11 contract therefore disagrees on its one exception. Funds are unaffected: rating holds the closure at `T_eff`, so `p_r ≤ T_eff` and `apply` recomputes `R_r` from the new schedule | E11 row: replace "(…: revocation due, a move at the offer's move time, a price change on its announcement; never before the entry's `ts`)" with "(…: a move at the offer's move time, a price change on its announcement; never before the entry's `ts`, except a POL-07 cut or revocation, effective at its `T_eff`, RFC-000 §8 (2), whose minutes rating has not closed)". §A6 row: replace "(revocation due, A-3)" with "(a move or a future shorten, A-3)" |
| V-5 | §A3 probe paragraph ("about 3 × 16,384 / 60 ≈ 820 entries/s across all slots (est., about 3% …)"); §A11 "Probe accounts" row ("up to about 820 probe entries/s in all") | X2-S27 requires 3 probes per slot per minute **in each serving region**. RFC-002 §14 and B-AI-12 give 820 probe bookings/s per region, 1,640/s in all, and about 3,800 entries/s. RFC-004 calls the per-region booking rate "entries/s across all slots" and so understates the account-log load by a factor of about 4.6 | §A3: "about 820 probe bookings a second per serving region, 1,640 in all, about 3,800 account-log entries a second (est., RFC-002 §14)". §A11 row: "up to about 1,640 probe bookings/s (about 3,800 entries/s) in all (est.)" |

No fix breaks an entry of either RFC's revision 3 resolution table. The checks covered:

- B-RQ-9: the partner-confirm exception is still removed, and J-12 only adds a check on the projected state.
- RQ6-2 and B-AI-10: the probes per slot now come from placement's map.
- RQ5-12: `withhold_notice` is still only in the termination envelope.
- RFC-004's rev. 3 rows that J-09 and F3-04 touch were re-read in §A6 and §B3.1.
