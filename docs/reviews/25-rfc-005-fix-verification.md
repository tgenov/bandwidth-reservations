# Review 25. Verification of RFC-005 revision 4 (rebase on requirements-v1.8 and RFC-000 4.2)

| | |
|---|---|
| Under review | [RFC-005](../03-rfcs/RFC-005-security-and-tenancy.md), Draft, revision 4 ("Revision 4 resolution"; "Revision 3 resolution" rows R5-01 … R5-28 and 3.1: V-1 … V-4) |
| Review record | [Review 16](16-rfc-005-review.md) (R5-01 … R5-28, D-1 … D-9); [review 21](21-rfc-005-fix-verification.md) (V-1 … V-4) |
| Authority | `requirements-v1.8`: POL-19 (Erasure, *Who asks*, *Complete in every copy*, non-conforming payloads), POL-32 (compliance row, administrator rows, onboarding and workforce rows, *Account recovery*), X1-S15, X1-S40 … X1-S43, P3-S71; [RFC-000](../03-rfcs/RFC-000-architecture.md) revision 4.2 (A1, A11, §3 interaction table, §8 rows: catch-up, edge stream, operator check, erasure-request intake and recovery objection, personal-data store; errata AI-R5-1 … AI-R5-4, AI3-13) |
| Scope | The passages each finding and each rebase item names, and the authority passages they rely on. Not a re-review |
| Coverage | `python3 tools/impact.py coverage S-SEC`: primary 43, uncited 0, dangling 0 |

## Verdict

**ACCEPT WITH CHANGES.** No regression of R5-01 … R5-28 or V-1 … V-4. The rebase meets
X1-S15, X1-S40 … X1-S43 and P3-S71 against v1.8 and RFC-000 rev 4.2, with one defect in
the new recovery-hold text (W-1) and two wording defects (W-2, W-3). Each fix is a local
edit of a few lines, so the orchestrator may apply them directly without another round.

## Rebase items (v1.8, RFC-000 rev 4.2)

| Item | Result | Notes (re-traced) |
|---|---|---|
| X1-S15 (outline) | Verified | §9.3: the first row is refused and recorded (layer 1, `SENSITIVE_ACCESS` to audit). For the second row, detection comes from the chain, the checkpoints written once in two domains, and the second verifier. The new reader table answers an altered or missing range as such, never as the record or as a silent gap. T-18 residual, DT-9 |
| X1-S40 | Verified, **defect W-1** | §3.8 entries, `prior_admins`, `hold_until`, conditional `recovery_cancelled` / `recovery_confirmed` (first commit wins). Crash: a late `recovery_confirmed` only extends the restrictions, and an objection after `hold_until` is refused. Rows 1–5 traced: remove refused; keys, endpoint and consent refused; add user allowed; u1 (prior administrator, right never removable by the held administrator) cancels at 20:00; final at 10:00. D-10 holds rights granted during the hold. §4.2 row, DT-26. The hold still lets a held administrator silence an objector through erasure (W-1) |
| X1-S41 | Verified | §3.3 case table maps all four rows to an identity entry and an edge effect, ≤ 31 s with connections closed. DT-1 covers each case |
| X1-S42 | Verified, **defect W-2** (wording) | Five channels (§3.7). A non-user request is *to verify*, refused with the sender told. A request by another user or by a key is refused and recorded (§4.2 rows, C12 errors). An operator's request goes through workforce administration. Bucket scope for (exporter, hour) is a superset of the named days. The supplier is told. DT-27 |
| X1-S43 | Verified | Four-eyes action with `order_ref`. Identity records the request at the commit that applies the approved envelope (`requested_at`), deduplicated by `action_id`. A pending request lapses at `approval_expiry` with nothing recorded. With no legal reference it is refused by the console's reason list and by identity. V-3's serialisation applies unchanged. DT-28 |
| P3-S71 | Verified | Three key layers: account payload key, bucket key per (exporter, UTC hour), and `X_d`, which is never escrowed or backed up and is destroyed by d + `dispute_window` + 7 days (at most one day early). A covering erasure deletes keys at `e`, and every copy is unreadable within 24 days of the record. The rewrap is conditional on the key row existing. A put racing an erase is serialised, and a new bucket key version serves later puts. Consistent with RFC-000 §8 (put / get / erase / expire, per-bucket expiry at put). The difference from §8's erase wording is raised as AI-R5-5 |
| RFC-000 4.2 (AI-R5-1 … AI-R5-4) | Verified | §3.1 Reads, §4.4 † rows, C3, C12, C14, C15 match the §8 rows: catch-up after 20 s and confirm within 45 s; edge stream with 31 s refusal; `operator_check` with single use and `cancel` serialised; edge → identity intake and objection, idempotent; console read-only on `open_requests` |

## Earlier fixes (regression check)

| Finding | Result | Notes |
|---|---|---|
| R5-01, R5-14 | Verified | The bound from the request is unchanged and now covers every channel (`r` = identity's commit, a legal requirement's apply commit included, as POL-19 sets). The 24-day table and the destruction scope are intact |
| R5-02 | Verified | Superseded by the five-channel design. The "legal requirement" channel is restored only with four eyes, as v1.8 requires (D-3 withdrawn, recorded in Competition) |
| R5-03 | Verified | Header, Builds on, Requirements and Architecture issues, and "(v1.8)" Traceability rows are on `requirements-v1.8` and rev 4.2 |
| R5-04 | Verified | Per-supplier payload key replaced by bucket keys (finer, the same mechanism). `put_payload` now takes the exporter. D-4 coverage is extended, not narrowed |
| R5-05, R5-06 | Verified | §3.3 unchanged in mechanism. D-6 references now cite X1-N3 and X1-S41 |
| R5-07 … R5-13, R5-15 … R5-25, R5-27, R5-28 | Verified | Untouched by revision 4 except the routing source in §2.2 step 8 (the account slot map, B-AI-10) and the notice list in §8.3 (POL-04). Neither affects these fixes |
| R5-26, D-7 | Verified | §3.8 rewritten for v1.8 (only prior administrators object). See W-1 |
| V-1 | Verified | Rev 4 adds only operator-signed compliance envelopes and administrator commands as new recording paths. The console still records no user request. The claim in §3.7, l. 517–524 is re-traced: a compliance-only record reaches named payload buckets only, and a legal-requirement request needs four eyes. T-40 and DT-20 hold |
| V-2, V-3 | Verified | C15 unchanged. X1-S43's four-eyes envelope goes through the same single-use and cancel serialisation |
| V-4 | Verified | The objection path exists (edge → identity, §4.2 row, §4.4 row), now restricted to `prior_admins` per POL-32 v1.8. DT-26 |

## Defects

| # | Item | Location | Failure | Fix |
|---|---|---|---|---|
| W-1 | X1-S40, RQ-R5-8 / D-10 (rebase) | §3.8 "During the hold", l. 646–648 ("passing on an erasure request" listed as allowed); §3.2 Held administrators, l. 257–265; T-43; DT-26 | A held administrator, possibly the takeover attacker, may pass on a "user's own" erasure request for any user, including each member of `prior_admins`. The pass-on channel is trusted (status *open*), and one compliance operator may execute it within days. Erasure deletes the user's blind-index row (§3.7, *Login lookup*), so the prior administrator can no longer sign in by identifier and cannot object. Its contact details are also destroyed, so later notices do not reach it. This defeats the hold's purpose ("cannot silence an objector") irreversibly, and a cancellation cannot undo it | Keep the pass-on allowed (POL-32: "its other administrator actions are allowed") but defer its effect. §3.8: "An erasure request passed on by a held administrator is recorded with status *held*. It becomes *open* at `recovery_confirmed`, and at `recovery_cancelled` it is refused, recorded, and its subject told. `requested_at` stays at its record." The bound still holds: execution within 10 days of the record still gives ≤ 24 days. Add *held* to the §3.7 state diagram and to `open_requests` statuses. Add "or erase through a pass-on" to T-43's mitigations, and add "a held administrator's pass-on is not executable until the hold ends; cancelled with the recovery" to DT-26. Optionally add the sentence to RQ-R5-8's proposed POL-32 text |
| W-2 | X1-S42 (rebase) | T-42 (l. 1906) | "A non-user request reaches only payload buckets …, never a user's, operator's or contact's items" contradicts §3.7 row 4 and §3.2. A non-user request passed on by an administrator for a registered contact also erases the contact's items. What §3.7 l. 520 actually limits is the **compliance-recorded** request | Reword: "A non-user request **recorded by compliance** reaches only the payload buckets of the exporters and hours it names, never a user's, operator's or contact's items" |
| W-3 | Need (rebase) | Need list, l. 58–76 | The new item 9 (account recovery) sits between items 7 and 8 | Move the item 9 paragraph after item 8, or renumber it 8 and the substrate item 9 |

Nit, not a defect: §4.4 l. 776 and Competition l. 2053 cite "A1 rev 4.1". The rule as now
stated (every other input owner-served) is A1 rev 4.2, as §3.1 l. 213 cites.

All three fixes are local and touch at most a few lines in each named place. None affects
another finding or an earlier fix. W-1 changes no channel, no clock and no contract
signature, only the status of one kind of recorded request.
