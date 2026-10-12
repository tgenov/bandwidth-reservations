# Review 32. Fix verification of RFC-001 Link schedule and admission (revision 5)

| | |
|---|---|
| Under review | [RFC-001](../03-rfcs/RFC-001-link-admission.md), Draft, revision 5 ("Revision 5 resolution" table) |
| Review record | [Review 26](26-rfc-001-review.md): R26-01 … R26-18, decisions D1 … D5, RFC-001's side of JI-1 … JI-7 |
| Rebase | `requirements-v1.9` ([review 28](28-requirements-amendments-from-c3-round-2.md): POL-07, P1-S81 … S83, glossary *Committed rate*); RFC-000 revision 4.3 |
| Joint interfaces checked | [RFC-002](../03-rfcs/RFC-002-booking-coordination.md) revision 5 (§9.6 offer state table, §9.7 cut targets, §13 link hold and waiting port rows, B-AI-13); [RFC-003](../03-rfcs/RFC-003-rating-and-metering.md) revision 5 (§5.6 closed time and the two holds, link schedule feed row) |
| Tools | `impact.py coverage S-LINK`: primary 83, uncited 0, dangling 0 |
| Scope | Confirmation only: the passages each finding names, the authority they rely on, and the joint interfaces named in the brief |

## Verification

### Verdict

**ACCEPT WITH CHANGES.** 17 of 18 findings, D1 … D5 and RFC-001's side of JI-1 … JI-7
are fixed and hold when re-traced. Four defects remain. Each is a precise local edit of a
few lines, so the orchestrator may apply them directly without another round:

- V-1 (Major): R26-01's per-leg cap also caps parts added after the cut.
- V-2 (Major): leg-change form and order do not match RFC-002 revision 5.
- V-3 (Major if left, joint with RFC-003): offer-scoped reservations stall closure.
- V-4 (Minor): the maintenance trim frees the current minute at once.

V-5 (Minor, joint) needs a one-sentence change in RFC-003 and none in RFC-001.

### Findings

| ID | Status | Re-trace and notes |
|---|---|---|
| R26-01 | **Defect (V-1)** | The lifecycle is now complete for every case in review 26: cancel before or after, a target composed lower, offer released, late move, two reductions, and `NOT_APPLIED` withdrawal (§5.4 case table, §5.4 "Cut-target answers"). (link, reduction) is named and checked (§4.5). But the cap is per **leg** over every part (§3.1 `occ_commit` row, §3.3 "Cut caps", §5.4 "Decided cuts are caps"), and with `APPLIED` it "stays as record" in force. A part added to the leg later is capped too. That reopens R26-01's effect. See V-1 |
| R26-02 | Verified | §5.7: flags use `occ_commit` less the projected cuts from `T_eff`, taken from the projection's generation `E + L_R`. P1-S82 traced: before `T_eff`, 8 ≤ min(10, 9). From `T_eff`, 4 + 2 = 6 ≤ min(6, 9). Nothing flagged. P1-S79 still flags A and B (6 > 5). §3.1 row (c) is now consistent |
| R26-03 | Verified | Maintenance is outside `occ_commit` (§3.1, §5.3, I4, I6). It is trimmed after the parts: newest first, by the largest excess from `T_eff`, uniform, cancelled at its whole rate, the supplier told (§5.4). That matches POL-07 lines 633–640 and review 28's amender decisions 1 and 2, with the notice delay on large links stated as R1-14. P1-S81: 9 gives `M` = 1, so the booking is cut to 1 Mbps. 8 gives `M` = 2, so it is cancelled. Neither A nor B is cut. P1-S83: 8 ≤ 9, nothing flagged. A reduction to 0 finishes. One side effect is V-4 |
| R26-04 | Verified | `cut_target(…, parts, [(from, r)…] \| none, offer?)` with the pieces equal to `K_{L,R}` (§5.4, §11.2). RFC-002 §9.7 composes per minute and per covered part. `CUT_TARGET_INEXACT` is gone. The Benefits claim is restored |
| R26-05 | Verified | Cut-set rows `link_reduction_cut` are written during the notice and frozen by `ReductionEffective(R, q, size, digest)`. Steps copy their parts as input. Vanished parts are decided 0. §8 has a successor row and T-10 a case |
| R26-06 | Verified | Candidates are restricted to the excess ranges. Re-runs are limited to the previous cut set (the monotonicity argument holds), coalesced, run on the standby above 100,000 parts, and pinned memory is sized (§5.4, §7.5, §9, R1-17) |
| R26-07 | Verified | `A_s` applies facts in record order, with `min` for reductions (§3.1). Review 26's pair gives 10 at 09:30 and 12 from 09:31 |
| R26-08 | Verified | `displace` leaves out holds displaced earlier, and placeholders are insert-only (§5.1, marker lifecycle) |
| R26-09 | Verified | A scan-pending range holds the queue through `Tick` continuations in the same batch (§4.3) |
| R26-10 | Verified | The tombstone made by a release is tested first, and digests are compared only with hold records (§4.1, T-09) |
| R26-11 | Verified | Only outages whose level is below the committed rate are named as causes (§5.7) |
| R26-12 | Verified | 2,500 + 1,575 + 175 + 250 = 4,500. Cold path: 5 + 5…10 + 2…5 + 2.5…10 ≈ 15–30 s. 1 M entries at 10–40 µs = 10–40 s. Both are counted against `release_grace`. Backstop lag is about 1.5 s |
| R26-13 | Verified | Recorded as the second closed-time exception, with past flags recomputed and notified (§4.5, §5.7 table, §11.1) |
| R26-14 | Verified | Causes (e) and (f) are in §7.2 step 5, with a §8 row and T-12. Abandonment at 250 ms is below the 1 s target |
| R26-15 | Verified | `offer_hold` is checked segment by segment over the parts' ends (§5.6) |
| R26-16 | Verified | The moving mark is dropped. The dated `end_leg` is sent only once the move is final (§5.4, §5.6) |
| R26-17 | Verified | T-20 and T-22 cells are correct (the extra cells in T-15 are escaped `\|`). Risks run R1-1 … R1-17 in order |
| R26-18 | Verified | The Benefits claims are qualified or now true. The push wording names the remaining causes |
| D1, D2 | Verified | As R26-03 and R26-02 |
| D3 | Verified | As R26-04 |
| D4 | Verified | `offer_accept` and the old-leg `end_leg` are sent only once the move is final (§5.6, §11.2). RFC-002 §9.6 does the same: "Final" row, and "Failed" sends `offer_release` only |
| D5 | Verified on the target | The `offer?` field, `KEPT_FOR_OFFER`, and the cap that moves with `offer_accept` or goes with `offer_release` (§5.4, §5.6). Its closure side is V-3 |
| JI-1, JI-2 | Verified | Attempts as RFC-000 4.3 states. RFC-002 §13 records the attempt carried and sends `convert(request, attempt, …)` |
| JI-3 | Verified | As D4 |
| JI-4 | Verified | As D5 |
| JI-5 | Verified | A second, lower target for the same key (§5.4). RFC-002 §9.7 takes the per-minute `min` |
| JI-6 | Verified (RFC-001 side) | No change is needed here. RFC-006 is to align and is not checked in this record |
| JI-7 | Verified | `nb(decision time)`, strictly after, for `offer_accept` and `offer_move_at`. A late accept is applied as decided. This matches RFC-002 §1.3 `nb` and the §9.6 "Final" row (`move_at = max(m_req, nb(ts))`) |
| `requirements-v1.9` | Verified | Satisfies P1-S01 … S83. P1-S81, S82 and S83 are traced above. Coverage: 83 primary, 0 uncited, 0 dangling |

### Defects

| ID | Severity | Location | Failure | Fix |
|---|---|---|---|---|
| V-1 | Major | §3.1 `occ_commit` row and the paragraph after the table; §3.3 "Cut caps"; §5.4 "Decided cuts are caps", first sentence and the `APPLIED` row; §4.5 the `CUT_TARGET_UNMET` check | The cap `K_{L,R}` applies to `min(Σ` **every** `part's rate, cap)` of the leg, from `T_eff`, open-ended, and stays in force after `APPLIED`. An increase or extension admitted later is a **new part on the same leg** (§4.5: "a new part with its own age on conversion"). It is sold against the reduced `K_s` but is then masked in `occ_commit`. Trace: B is cut 4 → 2 (cap 2); A ends; B is increased by 3. Sales count 5, but `occ_commit` counts min(5, 2) = 2. A later outage to 4 flags nothing (2 ≤ 4, truly 5 > 4), and a later reduction's excess is 3 too low. That is R26-01's silent under-flag and oversell. `CUT_TARGET_UNMET` also fires falsely, because the leg's rate is now above the cap. RFC-002 §9.7 says the opposite: "each [target] binds only its covered parts … a part added after a target … is not covered by it and not capped by it" (B-AI-13 (a)) | Make the cap bind the **covered parts** only: the leg's parts at the deciding entry, which are the `parts` the target carries. The leg's contribution is `min(Σ covered parts' rates, every cap covering them) + Σ uncovered parts' rates`. Apply the `CUT_TARGET_UNMET` check to the covered parts only. Add to T-14: an increase and an extension on a capped leg after `APPLIED` count in full |
| V-2 | Major | §4.5 table (the `reduce_parts` row for cause decrease) and the paragraph after it; §11.1 `reduce_parts` and `end_leg` rows (Input, Idempotency) | (a) RFC-002 revision 5 sends **every** `reduce_parts`, a decrease included, in §9.7's absolute form ("each changed part's rate from `nb(ts)` (§9.7's absolute form, cause decrease)", §8 change table, §13). RFC-001 reads a decrease as `[(part, Mbps)]` amounts to subtract: a decrease 4 → 3 sent as rate 3 would leave 1. (b) RFC-001 applies change-id order to POL-07 changes only. A stale absolute `reduce_parts` (a POL-07 cut, change id 5, whose gRPC push was lost and later relayed by Kafka) that arrives after the holder's cancelling `end_leg` (id 6) is still applied. It sets the part's rate from `T_eff` again, so a cancelled reservation's occupancy reappears. RFC-002 §13 describes ordering in general terms ("a `reduce_parts` older than the last applied for the (reservation, leg) without effect") | Accept the absolute minute-piece form for cause decrease as well (drop the decrement form). Apply **every** leg change of a (reservation, leg) (`end_leg` of any cause and `reduce_parts` of any cause) in change-id order. Answer a lower id after a higher one `STALE_CHANGE` with no effect. Clip absolute pieces to the part's current window. Add the stale-after-cancel case to T-15 |
| V-3 | Major if left (joint: RFC-001 / RFC-002 / RFC-003) | §5.4 "At `T_eff` the affected set is fixed" ("offer parts count for the offer's reservation"); §11.1 closed-time rule (2) | A reservation whose only parts in `C_q` are **offer parts** on M enters `A_R`. RFC-003 §5.6 then holds `hold_2` until the reservation's cut appears in its lifecycle as a **cut** event (E11). RFC-002 §9.7 records an offer-scoped target in **E13** against the offer and answers `KEPT_FOR_OFFER`, with no E11 cut. So nothing releases `hold_2` until a move. If the offer is declined or lapses, nothing ever releases it. The reservation's rating from `T_eff` stalls on its own path, which M's cut does not touch (D5), and breaks X2-S13's 2 min target | In RFC-001 (preferred, local): leave reservations whose cut parts in `C_q` are only offer parts out of `A_R` for the closure holds (they still receive their offer-scoped `cut_target`; `CUT_DECIDED` marks them offer-scoped). Their rate changes only through a move, which RFC-002 records before `move_at`. Alternatively RFC-002 emits a lifecycle `cut` event "kept for offer" that RFC-003 accepts as releasing `hold_2` |
| V-4 | Minor | §5.4 "Maintenance is cut to fit" ("its rate is lowered … over `W ∩ [T_eff, ∞)` in `occ_firm` and `occ_all` … and the waiter scan runs over the freed range") | The trim is decided at a step at `ts ≥ T_eff`, often in a later minute on a large link, and frees capacity for sales at once, the current minute included. POL-07 *Every rise in sellable capacity* says the cancellation of a maintenance booking takes effect "from the first minute boundary at or after" its record. §5.3's `cancel_maintenance` follows that rule as a pending effect | Release the trimmed or cancelled pulse from `occ_firm` and `occ_all` from `max(T_eff, ceil_minute(ts))` as a pending capacity effect, as §5.3 does. The earlier minutes change only in history. Add the case to T-20 |
| V-5 | Minor (joint: RFC-003 to change) | RFC-003 §5.6, the paragraph after the holds table; RFC-001 §5.4 final step and §11.1 rule (1) | RFC-003 states that the reservations a late extension adds "cannot have closed past `T_eff`, since the extension precedes the link's next `CLOSED` marker past it". That is false. `hold_1` lifts once the last of the `n` chunks is held. RFC-001 publishes those chunks "no later than the last decision", that is, before the final excess check. The reservations the extension adds are not in `A_R`, so they close past `T_eff` at the old rate before the extension cuts them. This happens only on a projection defect, which is alerted with `REDUCTION_SET_EXTENDED` | RFC-003: rate the extension's cut of minutes already closed as a correction (amending), not by the hold. No RFC-001 change is needed. The alternative, where RFC-001 holds the last chunk until the final check, would hold every reservation on the link for the length of the steps and is not recommended |

### Joint interfaces: summary

- **RFC-002 revision 5.** These match:
  - `cut_target` fields `parts`, pieces or `none`, and `offer?`
  - the answers `APPLIED`, `NOT_APPLIED(ended | left_link | unknown)` and `KEPT_FOR_OFFER`, and withdrawal of a cap that was not applied
  - `(link, reduction)` named on POL-07 changes
  - `offer_accept` and the old-leg `end_leg` sent only on a final move
  - `nb(decision time)`
  - attempt echoes on grants, `convert`, and the acknowledgements of `yield_accept` and `displacement_accept`

  Two mismatches are RFC-001's to fix: V-1 (cap scope against covered parts) and V-2
  (decrease form and change ordering). V-3 is shared.

  A wording point, not a defect: RFC-002 §9.7 still says the link "withdraws its
  decided-but-unapplied removal" when a pair is named. Under RFC-001's caps, nothing is
  withdrawn on `APPLIED`. The behaviour is the same.

- **RFC-003 revision 5.** These match:
  - `CLOSED(t, feed_seq)` as the per-destination minimum
  - `CAPACITY_CHANGED(reduction announced)`
  - the chunks of `REDUCTION_EFFECTIVE` and the two holds
  - `CUT_DECIDED` with minute pieces and a revision, used as a check only
  - `REDUCTION_FINAL`
  - maintenance cuts not used as rating input

  RFC-003 needs to change for V-5 (one sentence), and for V-3 if the RFC-002 alternative is
  chosen.
