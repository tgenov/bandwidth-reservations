# Review 78. Fix verification of RFC-006 erratum 7.1, draft 2 (slice S-PLAT)

| | |
|---|---|
| Under review | [RFC-006](../03-rfcs/RFC-006-availability-and-operations.md), revision 7, erratum 7.1 draft 2 (commit `a97ce8c`; `git diff 1e36321 a97ce8c`) |
| Against | [Review 77](77-rfc-006-erratum-7.1-review.md) (R77-01 … R77-20, D-77-1 … D-77-4); earlier RFC-006 fixes for regression (C01 R47-12, R1-1, M1, R6-03, AI3-9 takeover time) |
| Authority | Requirements at `requirements-v1.11` (POL-04, POL-06, POL-26, X2-S03, X2-S10); RFC-000 revision 4.5; C01 v1 (§2.4, §3.2, §7, CP-2, R47-12) |
| Coordinator-accepted deviations | R77-02: `n_cap` = `batch_time_budget` / `ĉ` on the per-entry part only. R77-08: the 1 s limit on admitted-call wait is rejected. R77-17: no per-kind seed |
| Scope | The "Draft 2 resolution" table and the passages it names: §3.6, §4.3 (size limits, crash points, `Retry` and `Overloaded` rows), §4.7 rule 5, §11, §12.10, §16, §22.1 "Overload recovery", DT-50, RK38, Competition, CI6-5, CI6-6, CI-R1-4, CI-B-3, "Erratum 7.1". No re-review |
| Tools | `python3 tools/impact.py coverage S-PLAT`: primary 33, uncited 0, dangling 0. `python3 -I tools/overload_model.py` run as committed; extra runs of the same model listed below. Only RFC-006 and `tools/overload_model.py` change: no contract and no other RFC is edited |

## Verification

**Verdict: ACCEPT WITH CHANGES (not closed).** Draft 2 fixes both Blockers and every
Minor. The rule set recovers in the model as stated. One Major remains: the rewritten
§22.1 exit criteria for run (b) (and run (d)) fail on the model's own output, as R77-08
(a) found for (a′) in draft 1. Five Minors remain. No earlier fix regresses. **Each
remaining defect is a precise local edit of a few lines in §22.1, the "Erratum 7.1" model
table, §4.7 rule 5a and the model script. The orchestrator may apply them directly
without another round.**

### Extra model runs (same script, same rules; reviewer's runs)

| Run | Result |
|---|---|
| (b) as §22.1 states it: 0.8 `C` (355/s), `c` 10× in 10 to 20 s, to 120 s | Goodput 0 in seconds 21 and 22, after the restore (batches started in the slowdown run up to the 2 s abandon budget). 5 abandons. 18 state changes, the last at 61.1 s (41 s after the restore). During the slowdown about 19/s against a capacity of about 44/s. Same shape with CI6-5 (20 changes, 46 callers give up) |
| Case 7 as committed (0.45 `C`) | A second entry at 24.96 s and release at 25.6 s: after "the restore + 2 s" |
| (a′) to 93 s, as §22.1 states it | Last state change 56.1 s. From 65 s: 306 to 390 a second, about 355/s per window of 20 batch durations. Criteria (1) to (4) hold |
| (a) with 20% noise, 10 seeds | 6 state changes in 5 seeds, **8** in 5 seeds (limit 6) |
| (a′) with 20% noise, 5 seeds | 18 to 22 state changes (limit 24) |

### Findings

| ID | Result | Re-trace |
|---|---|---|
| R77-01 | Verified | §4.7 5a: entry on the minimum sojourn > 500 ms for 1 s; release on the expected sojourn ≤ 500 ms at a take or a batch end, with no idle and no hold. 500 ms is above the 400 ms per-entry budget, so a slot that drains at full rate releases. Model case 1: 2 changes (2.8 s, 5.7 s), 200/s every second from 11 s, no zero second. `retryAfterMs` uses full jitter over the expected drain of `q` + `k`. §11 takeover row corrected |
| R77-02 | Verified (accepted deviation) | 5b caps only the per-entry part; the fixed cost is never capped. A fixed point exists for every `F` < 1,600 ms. Model case 2: 287 to 431 a second, mean 297/s, 0 changes, the same as rules off. Fixed-cost case is in §22.1 (b′) and DT-50 (2) |
| R77-03 | Verified | The batch-duration measure is removed. Model case 4 (+800 ms per batch for 0.5 s): no entry |
| R77-04 | Verified | "Not a sample" excludes `exclusive` and lower-budget batches and abandons, per-tier batches and second-lane deadline batches. Only a default-budget abandon is a censored sample |
| R77-05 | Verified, with D-78-1 | Per-tier batches are not samples; §16 does not page the 1% condition in a declared topology state, a node not live, or 60 s after a takeover, move or split; 5 min still pages. §11 rows updated. Run (d) added, but its exit window has the defect of D-78-1 |
| R77-06 | Verified | CI6-5 has the consumer obligation. CI-R1-4 and CI-B-3 are recorded under the owner prefixes, with the next free numbers (CI-R1-1 … 3 and CI-B-1 … 2 exist), and RFC-006 does not edit them. Runtime defence: admission check first (about 2 µs), 500 immediate answers per slot per 100 ms, then a tick; 25,000 × 2 µs = 50 ms bound is correct |
| R77-07 | Verified | v1 behaviour: one fresh attempt with the first `n_cap` calls, the rest at the head of the queue in order with their enqueue times; `Retry` only if that attempt is abandoned too. Switch `abandon_fresh_attempt`. Status line, §3.6 timeouts row, §4.3 crash points and `Retry` row, §12.10 agree. The fresh attempt carries a prefix of a queue prefix, so per-partition order holds |
| R77-08 | **Defect** (D-78-1, D-78-2, D-78-3) | Caller model, `T_d`, per-window goodput and per-`T_d` state-change limits are added, and DT-50 asserts per second. (a) and (a′) now pass their own criteria. Run (b) and (d) do not (D-78-1). The (a) limit has no margin for noise (D-78-2). **Rejected part (1 s wait limit): the reason holds.** POL-04's 200 ms is met by the edge's `pending` answer, not by the commit; with no deadline dropping (coordinator D4), calls queued in the 1 s entry interval must wait for the drain, so the limit could not pass; the wait is reported |
| R77-09 | Verified | Floor 1 call; 16 only filters the no-spread `ĉ` |
| R77-10 | Verified | 400 / 0.2 = 2,000, the hard cap; sizing about 1 kB per slot, 24 MB in total |
| R77-11 | Verified | §12.10: new, memory backstop, 10 to 40 MB per slot |
| R77-12 | Verified | §3.6 admission control row |
| R77-13 | Verified | One queue and one sojourn per slot; fit and `n_cap` per lane; no second-lane deadline samples |
| R77-14 | Verified | Safety argument reworded; DT-50 (6) |
| R77-15 | Verified | 5c: roll back, update `ĉ`, act, answer. An abandon does not change 5a's state, so no answer precedes a state change |
| R77-16 | Verified | Samples while overloaded change nothing until the release |
| R77-17 | Verified; **rejected part: the reason holds** | 60 s age-out. With no estimate only the hard caps apply; at worst one batch at the hard cap is abandoned and its censored sample sizes the fresh attempt (for `c` = 2 ms: `n_cap` about 400, about 850 ms). A per-kind seed could be wrong in either direction |
| R77-18 | Verified | §12.10 and §16 mark each value est. and name the run that sets it |
| R77-19 | Verified | Competition rows for adaptive concurrency, token bucket, client retry budgets |
| R77-20 | Verified | §4.3 `Overloaded` row names `moved`, `adopt` (head) and `exclusive` (tail) |

### Regression check

C01 R47-12 (`Overloaded` never for exhausted retries or an abandon): kept in the §4.3 row.
R1-1 (restarts keep intents) and the fresh attempt after 40001: unchanged, whole batch.
M1 (`COMMIT` never aborted blind) and the `Ambiguous` rule: unchanged. R6-03 and the
takeover time (§4.4, 3.3 to 3.8 s, p99 ≤ 5 s): unchanged. No regression.

### Specific points

1. **Case 3 (takeover on the hottest link): not a Blocker.** The takeover criterion
   (§4.4, §22.1, AI3-9, DT-28: p99 ≤ 5 s) is measured to serving, and that stays 3.3 to
   3.8 s. The 7 s figure is the drain of the backlog of the takeover, and the model gives
   **the same goodput with rule 5 off** (4,000 a second while draining), so the figure is
   a property of revision 7, now stated, not a cost of the erratum. X2-S10 (admission RTO
   1 min, measured to probes succeeding again) holds with a wide margin. POL-06's
   failing-slot-minute rule applies to account slots, and the hottest link is a link
   slot. POL-04's 200 ms answer is the edge's `pending`. The 0.43 s shed window is inside
   the §16 60 s post-takeover suppression. The figure is conservative: in the model the
   8,750 re-proposed calls commit in queue order by about 2.2 s after the takeover (about
   5.5 to 6 s after the loss); the queue is empty at about 3.5 s. No change needed.
2. **Case 6: consistent.** N is stated: at most 2 per 5 s of `T_d`, 24 for (a′). The model
   gives 20 (18 to 22 with noise), none after 56.1 s, and run to 93 s it meets criterion
   (2) from 65 s. Goodput stays at about capacity (mean 445/s). But (a) has no margin
   (D-78-2), and the committed table runs case 6 only to 60 s (D-78-3).
3. **Cases 7 and 8: recovery is not correctly bounded (D-78-1).** Rules off stays at 0/s
   to the end and fails criterion (2), so the criteria catch the collapse. With rules on,
   goodput during the slowdown is about the reduced capacity at 0.45 `C`, and about 43% of
   it at 0.8 `C`. But the criterion judges (b) from "the restore + 2 s" with no `T_d`.
   The slowdown leaves a backlog of about 10 s × (λ − `C_slow`) that drains at `C` − λ.
   At 0.45 `C` the model re-enters at 24.96 s; at 0.8 `C`, as §22.1 states run (b), it
   has zero seconds at 21 and 22 s, 5 abandons and state changes to 61 s. The design
   recovers (capacity loss, not collapse), but the criterion fails it.
4. **Model against RFC text: matches**, with these exceptions. (i) `shed_answer_burst` is
   not modelled (immaterial: the deferral adds at most 100 ms to a return delay of at
   least 250 ms). (ii) The 60 s age-out of samples is not modelled (no lane is idle 60 s
   in any case). (iii) The model's expected sojourn with no estimate is 500 ms (so the slot
   releases); the RFC defines `D` for that case but not the release test (D-78-4).
   (iv) "at most 5,000 ms" caps `D`, so `retryAfterMs` ≤ 5,250 ms; the resolution row
   says "at most 5 s" (D-78-5). Entry (minimum sojourn, run of 1 s), release (expected
   sojourn ≤ 500 ms at take or batch end, not at the entering take), sample definition,
   fit, censored sample, probe, `n_cap`, full jitter, and 5c order all match.
5. **Issues: scoped right.** CI6-5 proposes the C01 text and keeps C01 v1 governing until
   C4. CI6-6 covers the head-of-queue `moved` and `adopt`. CI-R1-4 and CI-B-3 are under
   the owner slices' prefixes and RFC-006 does not edit RFC-001 or RFC-002. No contract
   file changes. Note: §22.1's caller model re-sends at once after `Retry`, which is
   stricter than CI6-5's random delay; acceptable as the worst case.

### Remaining defects

| ID | Severity | Location | Failure | Fix |
|---|---|---|---|---|
| D-78-1 | Major | §22.1 "Overload recovery" criteria (1) to (4) for runs (b) and (d); "Erratum 7.1" intro ("from the restore + 2 s in cases 7 and 8") and case 7 row | Run (b) as specified (0.8 `C`) fails criterion (1) (zero seconds at 21 and 22 s), (2) (entries to 61 s), and (4) (5 abandons, about 2%). Case 7 at 0.45 `C` fails (2) (entry at 24.96 s). The cause is the backlog of the slowdown, which the criterion does not count. Run (d) has the same gap: its `E` is not defined | For (b) and (d): `E` = calls offered during the slowdown (lease wait) above `C_slow`, the capacity measured under it (as `C_F`); judge (2) from the restore (lease return) + `T_d` + 2 s; (1) also exempts the first `abandonBeforeCommitMs` (2 s) after the restore; (3) at most 2 state changes per 5 s of `T_d` for (b) and (d); (4) count abandons outside the slowdown and its first 2 s after. Report goodput during the slowdown against `C_slow`. Run model case 7 at 355/s to 120 s and quote it as the (b) expectation |
| D-78-2 | Minor | §22.1 criterion (3), "6 in (a)" | The deterministic model gives exactly 6; with 20% noise, 5 of 10 seeds give 8. A real run would fail for noise, not for a defect | "at most 2 for each 5 s of `T_d`, plus 2 (8 in (a), 26 in (a′))", or judge the median of 5 runs |
| D-78-3 | Minor | "Erratum 7.1" model table, case 6; `tools/overload_model.py` case 6 | The model runs (a′) to 60 s, but §22.1 runs it to 93 s and judges (2) from 65 s, so the table does not show (2) | Set `end=93000` (and `ph` to 93 s) in case 6 and add "from 65 s: 306 to 390 a second, about 355/s per 20-batch window; last state change 56.1 s" |
| D-78-4 | Minor | §4.7 rule 5a "Expected sojourn" row | Not defined when the lane has no estimate (`ĉ` unset); the model uses 500 ms, so the slot releases at once | Add: "With no estimate, the expected sojourn is 500 ms (the target), as for `D`" (the model's rule), or define the release as the queue being empty and change `drain_ms` for the release test |
| D-78-5 | Minor | "Draft 2 resolution" R77-01 row; review brief | "at most 5 s" for `retryAfterMs`, but 5a and §12.10 cap `D` at 5,000 ms, so `retryAfterMs` ≤ 5,250 ms | Write "`D` at most 5,000 ms (`retryAfterMs` at most 5,250 ms)" in the resolution row and in 5a |
