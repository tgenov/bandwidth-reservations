# Review 31. Fix verification of RFC-002 and RFC-004 (revision 5), joint

| | |
|---|---|
| Under review | [RFC-002](../03-rfcs/RFC-002-booking-coordination.md) Draft rev. 5 (S-ACCT) and [RFC-004](../03-rfcs/RFC-004-wallet-and-settlement.md) Draft rev. 5 (S-MONEY) |
| Findings verified | [Review 18](18-rfc-002-004-joint-review.md) J-01 … J-20, D-1 … D-6 (no regression); [review 23](23-rfc-002-004-fix-verification.md) V-1 … V-5; [review 26](26-rfc-001-review.md) joint items JI-1 … JI-5, JI-7 (RFC-002's side; JI-6 is RFC-006's) and D3 … D5; the rev. 5 joint interfaces (F1, F2, F4, F5, F6, F7, F11; set-scoped credit-limit envelopes; the slot-level identity watermark; split reservation batches; payout destination via C16) |
| Mode | Confirmation only: each item's named passages (RFC-002 §1.3, §2.2 … §2.4, §4.3, §5.1 … §5.3, §7.3, §9.1, §9.4, §9.6, §9.7, §13.2, resolution tables; RFC-004 §A2 … §A5, §A10, §A11, §B2 M4, §B3.1, §B7.1, §B12, resolution tables) and the authority they rely on |
| Authority | `requirements-v1.9` (POL-07, POL-08, POL-25, POL-27, POL-32; `price_notice` 30 days, `coverage_window` 24 h); [RFC-000](../03-rfcs/RFC-000-architecture.md) rev. 4.3 (§3 identity row, §6 reservation charge lines, §8 identity push and catch-up, charge-line feed, posting port; errata AI4-11, AI4-12, AI-26-1 … AI-26-3); RFC-005 rev. 5 §7.3, §7.4 (envelope, check 6), C16; RFC-001 working draft (for residual joint mismatches only) |
| Tools | `impact.py coverage S-ACCT`: primary 117, uncited 0, dangling 0. `impact.py coverage S-MONEY`: primary 116, uncited 0, dangling 0. `check_specs.py`: no problems (468 scenarios) |

## Verdict

- **RFC-002: ACCEPT WITH CHANGES.** One defect (K-3, one phrase of §2.4, shared with
  RFC-004) and one sentence of §7.3 (K-1).
- **RFC-004: ACCEPT WITH CHANGES.** Three defects, K-1 … K-3, all at the new set-scoped
  credit-limit interface and the `Schedule` signature.

Every defect is a precise local edit of one to three lines. The orchestrator may apply them
directly instead of running another round. Every J-*, D-* and V-* fix still holds, and
RFC-002's side of JI-1 … JI-5 and JI-7 is resolved. Two residual RFC-001 mismatches are
recorded below as joint items, not as RFC-002 defects.

## Review 23 defects (RFC-004)

| ID | Result | Where checked | Notes (re-trace) |
|---|---|---|---|
| V-1 | Verified | §A5.2 item 3 | An extension is funded at `ρ̂ = max ρ⁺` over `[e⁻ − 1 min, e⁺)` for every added minute. Extend-after-increase gives 300 µ/min, not 0 |
| V-2 | Verified | §A5.2 example | Fixed window `[10:00, 12:00)`, `H_r = 24,000`, `h = 12,000`. The table recomputes: 36,000 / 24,000 / 12,000 |
| V-3 | Verified (option a) | §A5.2 item 3 and first two rows, §A5.3, §B13, summary item 1 | Minutes after a recorded step are priced at the stepped price at intake. A step recorded between intake and decision cannot reach the hold window, because `price_notice` (30 days) is longer than `coverage_window` (24 h), so "only posting drift" is now true. RFC-002 §2.4 item 8 says the same |
| V-4 | Verified | §A4 E11 row, §A6 "Reservation ends" | The cut and revocation exception at `T_eff` matches RFC-002 §2.2 E11. RFC-002's "never before `nb(ts)`" is stricter than RFC-004's "never before `ts`", so the two do not conflict |
| V-5 | Verified | §A3 probe paragraph, §A11 | 820 per region, 1,640 in all, about 3,800 entries/s, matching RFC-002 §14 and RFC-000 4.3 B-AI-12 |

## Review 18 findings and decisions: regression check

| ID | Result | Notes |
|---|---|---|
| J-01, D-1 | Holds | §2.4 item 8, §9.2 and RFC-004 §A5.2/§A5.3 are unchanged except for V-1 … V-3 |
| J-02, D-2 | Holds | §9.1 gives each part its key. A move keeps each part's key and age (§9.4, §9.6) |
| J-03 | Holds | §1.3 and §2.1 put every time-dependent figure at `ts`, including `iam_fresh` and the E11 effective minute |
| J-04 | Holds | One F11 entry per (account, price version), with its E11, on both sides |
| J-05, J-06, D-4 | Holds | §7.3 and RFC-004 §A4 gate and F6 are unchanged |
| J-07, D-3 | Holds | A move is now recorded when it becomes Final (D4), with `move_at = max(m_req, nb(ts))`. If it is late, the delay is recorded and the holder told. No E11 has an effective minute before `ts` except a POL-07 cut at `T_eff` |
| J-08, J-19 | Holds | Cut E11s from a deep reduction add about 1 entry per slot per second for about a minute (§9.7 sizing, 17,000 / 16,384). That is a transient rise of about 15% over the 6.8 entries/s steady figure. It belongs under RB-16's thin margin (observation, not a defect) |
| J-09 … J-11, J-13, J-16 … J-18, J-20, D-5 | Holds | Not touched by revision 5 |
| J-12, D-6 | Holds | §2.4 `standing`, §5.5 step 1, S14 |
| J-14 | Holds | §2.5 savepoint with a 10 ms lock timeout |
| J-15 | Holds | §9.4: a cut fails nothing, and a move fails only a change in progress on removed legs. Under D4 this applies at Final |

## Review 26 joint items (RFC-002's side)

| ID | Result | Where checked | Notes (re-trace) |
|---|---|---|---|
| JI-1 | Verified | §4.3 table and text, §5.1 answers and state messages, §5.2 grants, §5.3, §5.6 | P1-S78 row 2 after a grant: `GRANTED(n)` keeps n, `DISPLACED(n)` carries n, and E5 compares the marker's n with the recorded n, so it sees the marker. A stale lower attempt changes nothing. The owner never numbers an attempt. RFC-001 §4.3 (draft) agrees |
| JI-2 | Verified | §5.7, §12.1, §13.2 | `convert(request, attempt, reservation, part, T_dec)`, re-sent on takeover with the attempt `query` returns. This matches RFC-000 4.3 §3 (AI-26-1) |
| JI-3, D4 | Verified | §9.6 state table and diagram, §9.4 row, §2.2 E11/E13 | A partner failure at acceptance leads to *Failed* with `offer_release`, and the old legs are untouched. With P1-S52's partial cut, B keeps 2 Mbps. `offer_accept` and the old legs' `end_leg` are sent only after E13 *final* |
| JI-4, D5 | Verified | §9.6 "Cuts and the move", §9.7 `KEPT_FOR_OFFER` | An offer-scoped target is applied only at Final, from `max(T_eff, move_at)`, and dropped otherwise |
| JI-5 | Verified | §9.7 recording table, S16 | A later target is taken as the per-minute `min` with the earlier one. A higher piece is ignored and alerted |
| JI-7 | Verified | §1.3 `nb`, §9.6 "`move_at` and the link's check" | RFC-001 (draft) §5.6 and §11.1 now check `nb(decision time)` and apply a late acceptance as decided, so the two sides meet |
| D3 (AI-26-2, AI-26-3) | Verified | §9.1, §9.7 `compose`, leg changes | For one target the result is exact. Composition is monotone and order-independent. Changes are absolute pieces ordered by change id, and `NOT_APPLIED` lets the link withdraw a decided removal (R26-01 (i)) |

## Joint interfaces (revision 5)

| Interface | Result | Notes |
|---|---|---|
| F1, F2, F6, F7, F11 registry | Meets | RFC-002 §2.3 and §2.4 items 11 … 13 against RFC-004 §A4 and JR-9: five F7 variants, three F6 variants, the ledger-position gate, F11 with its E11 in one entry |
| F4 and the slot-level identity watermark | Meets | RFC-002 §1.3, §2.3, §2.4 (watermark row, item 14), §5.6 and S9 against RFC-004 §A2 `id_ts`, §A4 F4, JR-11, §B12 and RFC-000 4.3 §3/§8 (AI4-11). Every heartbeat and catch-up advances the watermark, F4 is written only on a status change, and after a takeover the watermark is unset (stale) and fails the gate |
| F5 and set-scoped credit-limit envelopes | **Defects K-1, K-2** | The shape matches on both sides (one envelope per member, `member` outside the digest, once per (`action_id`, account)). Membership is checked against current F9 rather than the signed set at version v, the check order is reversed, and the KYB retry path cannot work under RFC-005 §7.4 |
| Split reservation batches (AI4-12) | Meets | RFC-004 §B2 M4, §B3.1, §B10, §B12 posting port and §A11 match RFC-000 4.3 §6 and §8. A reservation's line for one minute is in one batch, so per-movement F1 posted-through summaries stay per reservation. The arithmetic checks: 100,000 / 60 ≈ 1,700/s; 200 batches a minute ≈ 3.3/s; total about 4,400/s |
| Payout destination via C16 | Meets | RFC-004 §B7.1 and §B12 (consumed) match RFC-005 C16: `payout_destination(supplier, at)` at `T_w`, reference and version on the instruction, details never logged, a change applying from the next run, errors as stated. RFC-000 §8 has no row yet. RFC-005 raises this as AI-R5-8, so it is not RFC-004's to fix |
| Cut part rates into the funds `Schedule` | **Defect K-3** | RFC-002 parts carry a current rate that varies by minute after cuts. RFC-004's `Part{rate, …}` holds a single rate |

## Defects

| ID | Location | Failure | Fix |
|---|---|---|---|
| K-1 | RFC-004 §A4 F5 apply rule and §B12 credit-limit command ("`excluded` on, F9; otherwise `out_of_scope`"); RFC-002 §7.3 ("a designated probe account (applied F9)"; "`out_of_scope` … checked after `kyb_not_vetted`") | **(a)** The signature covers "designated probe accounts at slot-map version v". RFC-005 §7.4 check 6 requires `member` to be in the set **at v** (C9). Both RFCs instead check current F9. So a probe account designated by a later re-slotting would accept an envelope for v that its operators never signed for it. This contradicts RFC-004 §A3's own rule that "a later re-slotting needs a new set-scoped action". **(b)** Membership is part of envelope check 6, which runs before any funds rule. RFC-002 checks `out_of_scope` after `kyb_not_vetted`. A misrouted envelope to a non-member without KYB is then answered `kyb_not_vetted`, which invites a retry | RFC-004 §A4 F5 and §B12: "`member` is this account and the account is designated (`excluded`, F9) **and a member of the set at slot-map version v** (C9, RFC-005 §7.4 check 6); otherwise `out_of_scope`, checked with the envelope, before the KYB rule". RFC-002 §7.3: replace "applied F9" with "applied F9 and a member at version v (C9)", and "checked after `kyb_not_vetted`" with "checked with the envelope, before `kyb_not_vetted`" |
| K-2 | RFC-004 §B12 credit-limit command, "Ordering" sentence ("may be retried under the same envelope after KYB, as a new attempt with a fresh `action_id` derived from the action and the attempt") | `action_id` is inside the signed digest (RFC-005 §7.4, T-9), so a fresh `action_id` is not "the same envelope". Identity's operator check (C15) would also refuse the assertions as consumed under another `action_id`. The member's `kyb_not_vetted` refusal is recorded and deduplicated per (`action_id`, account), so a same-`action_id` retry only returns the refusal again. The stated retry path cannot succeed | Replace the sentence with: "a member refused `kyb_not_vetted` stays refused under that action; it is covered, after KYB, by a new set-scoped action (as for a probe account a re-slotting adds, §A3). RFC-006's provisioning order (KYB before the action) makes this rare" |
| K-3 | RFC-004 §A10 `Schedule = { parts: [Part{rate, …}] … }`; RFC-002 §2.4 `admit` row ("the reservation's schedule … with its locked prices and price steps") | RFC-002 §9.1 and §9.7 give each part a **current rate as minute pieces** after the POL-07 targets in force (D3). The E11 cause "cut" passes the resulting schedule to `apply(ReservationChanged)`. RFC-004's `Part` has one scalar `rate`, so the funds module cannot represent a part whose rate steps at `T_eff`. Minutes between `p_r` and `T_eff` (posting lag) and any later pieces would then be held, and counted to keys, at the wrong rate | RFC-004 §A10: `Part{rate: [(from, Mbps)…] /* current rate as minute pieces after cuts, RFC-002 §9.1, §9.7 */, locked_price, price_steps, interval}`, and in §A2 note that `cov_r`, `e_{r,k}(m)` and `ρ⁺(m)` read the part's rate at `m`. RFC-002 §2.4 `admit` and `apply` rows: add "each part's current rate as minute pieces (§9.7)" |

No fix breaks an entry of either RFC's revision 4 or revision 5 resolution table. K-1 and
K-2 touch only the set-scoped form. K-3 changes a signature only, not a rule.

## Residual RFC-001 mismatches (joint items, not RFC-002 defects)

RFC-001 is being revised in parallel (working-tree draft read). These need RFC-001 to
change, or RFC-000 4.4's B-AI-13 to settle them.

| ID | Where they disagree | Effect | Resolution |
|---|---|---|---|
| JI-8 | RFC-002 §9.3 (decrease row) and §9.7 send a buyer **decrease** as `reduce_parts` in the absolute minute-piece form, ordered by change id. RFC-001 §4.5's command table still takes cause decrease as a decrement `[(part, Mbps)] from T` | If each side builds to its own text, a decrease is applied as a decrement of an absolute rate (over-reduction), or refused | RFC-001 §4.5: one `reduce_parts` form, absolute pieces, for both causes (B-AI-13) |
| JI-9 | Parameter order of `cut_target`: RFC-002 §9.4 and §9.7 `(link, reduction, reservation, pieces \| none, parts, offer?)`; RFC-001 §5.4 and §11.1 `(link, reduction, reservation, parts, pieces \| none, offer?)` | Cosmetic, but these are contract signatures | Fix the order once in B-AI-13 and copy it to both RFCs |

JI-6 (RFC-006 §3.7) is outside this slice.
