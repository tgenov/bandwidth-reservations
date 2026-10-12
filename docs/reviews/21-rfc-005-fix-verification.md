# Review 21. Verification of RFC-005 revision 3 against review 16

| | |
|---|---|
| Under review | [RFC-005](../03-rfcs/RFC-005-security-and-tenancy.md), Draft, revision 3 ("Revision 3 resolution") |
| Review record | [Review 16](16-rfc-005-review.md): R5-01 … R5-28, decisions D-1 … D-9 |
| Authority | `requirements-v1.7` (POL-19, POL-32 and its administrator rows, X1-S39), [RFC-000](../03-rfcs/RFC-000-architecture.md) revision 4.1 (A1, A11, §8 personal-data store row, AI5-11) |
| Scope | Only the passages each finding names, and the authority passages they rely on. Not a re-review |
| Coverage | `python3 tools/impact.py coverage S-SEC`: primary 39, uncited 0, dangling 0 |

## Verdict

**ACCEPT WITH CHANGES.** 24 of 28 findings and 8 of 9 decisions are verified as fixed. Four
defects remain, all in revision 3's new mechanisms (V-1 … V-4). Each one is a precise local
edit of a few lines, so the orchestrator may apply them directly without another review
round.

## Verification by finding

| Finding | Result | Notes (re-traced) |
|---|---|---|
| R5-01 | Verified | §3.7 bound from the request. Worst case traced: `e` ≤ `r` + 10; `s_h` ≤ `e` < `s_h+1` ≤ `e` + 7; h destroyed at `s_h+1` + 7 ≤ `e` + 14 → 24 days; h − 1 by `e` + 7. `gc.ttlseconds` ≤ 1 h covers `AS OF SYSTEM TIME`; Raft and SSTable copies are bounded by destruction; the rewrap is conditional on the key row, so an erased subject is never rewrapped. Backups (7 days, no revision history) never outlive their generation, as RFC-000 AI5-11 requires. C12, DT-15, RK-13, Benefits and §13 are consistent |
| R5-02 | **Defect V-1** | The *pass on* command, own-data intake, operator path, `requested_at`, `request_ref` check in identity, removal of "legal requirement", X1-S39 in Satisfies, Traceability and DT-20 are all present and match POL-19 and POL-32 v1.7. The own-data channel is forgeable by the console (V-1) |
| R5-03 | Verified | Header, Requirements issues (RQ5-11 and RQ5-12 resolved), Architecture issues (AI5-8 … AI5-11 resolved), "(v1.7)" Traceability rows |
| R5-04 | Verified | `put_payload` in C12 and §4.4. Layered wrap (tenant payload keys under `KEK_PD,g`; outer `X_d`). Expiry reaches every copy by day d + `dispute_window` + 7. D-4 erasure by deleting the tenant payload key. DT-21 |
| R5-05 | Verified | Pull after 20 s without Kafka (applied about `t0` + 26 s); confirm guard at 45 s when identity is also unreachable; DT-1 has no takeover. The pull replaces the review's identity → owner call, with a reason in Competition and AI-R5-4 |
| R5-06 | Verified | Sessions and serials are in the replica under the 30 s invariant; connections close on revocation; start from a snapshot; DT-1 |
| R5-07 | **Defects V-2, V-3** | Signing client, owner-signed summaries, digest over action, role and `not_after`, owner commit time vs `not_after` − ε, WebAuthn rules, out-of-band confirmation, S5, T-9, DT-8: present. The counter rule breaks legitimate actions (V-2). The cancellation receipt can be issued after the owner's check (V-3) |
| R5-08 | Verified | §7.6 read grants; the reader verifies and appends to audit before answering; limits and breadth alerts; §4.4 rows; DT-24 |
| R5-09 | Verified | Keys by purpose (§5.4 table); authenticity claims replaced by grants, ACLs and the chain (§4.4, T-25); "the verifier" removed (§9.3 layer 3: no payload key) |
| R5-10 | Verified | HKDF sub-keys per (key, epoch, session), random nonces, a new sub-key at 2³¹. Arithmetic checked: 10⁴/s × 2.6×10⁶ s ≈ 2.6×10¹⁰ ≈ 12 sub-keys a month. DT-22 |
| R5-11 | Verified | Every application table sealed with version in the associated data; no clear column relates two tenants; the edge is fed by a signed stream with version monotonicity; system ranges secret-free; T-24's residual stated; DT-11, DT-16 |
| R5-12 | Verified | §3.1 Reads, §4.4 † rows, C6 `visibility`, C14, C15, AI-R5-1; "this RFC adds none" (SQL grants) |
| R5-13 | Verified | C1 obligations, C3 provisional key, §4.3, T-33, DT-25 |
| R5-14 | Verified | No `KEK_PD` escrow (§10 Escrow); destruction on every member and HSM backup, attested (§3.7) |
| R5-15 | Verified | Row-level security with a stored-procedure fallback (RK-18); changefeed tampering is an incident; `SENSITIVE_ACCESS` routed to audit |
| R5-16 | Verified | Dummy verifier; 5 ms floor; T-41; DT-23 |
| R5-17 | Verified | §3.2; §5.2 row |
| R5-18 | Verified | §6.1, C6, DT-7 |
| R5-19 | Verified | (a) per-attempt timestamp; (b) global unicast and port 443 only, generic error; (c) *rotate now*; (d) validation, encoding, `fetch_rate_limit` |
| R5-20 | Verified | §5.4 residual; keys generated from day 25; RK-9 |
| R5-21 | Verified | Full replica; §3.1 sizing (2 GB, about 13,000 heartbeats/s); Competition |
| R5-22 | Verified | Write-path refusal plus a sampling scanner with its own release |
| R5-23 | Verified | §7.1 approver set, vetting binding, shared-authenticator alert, T-31 |
| R5-24 | Verified | Edge signatures dropped; edge workload identity in `audit.principal`. Side effect: see V-1 |
| R5-25 | Verified | T-34 … T-39; second verifier (§9.3) |
| R5-26 | **Defect V-4** | §3.8 onboarding recovery, re-verification, notice and 24 h hold are present. The objection channel the hold relies on does not exist |
| R5-27 | Verified | Benefits, Competition (no backups; exclusion lists; revision 2 rows), RK-13 (*Assumed*) |
| R5-28 | Verified | §8.3, C8 |
| D-1 … D-6, D-8, D-9 | Verified | As applied above (§13 parameters, §3.7, §10, §3.2, §3.3, §7.6, §8.3) |
| D-7 | See V-4 | |

## Defects

| # | Finding | Location | Failure | Fix |
|---|---|---|---|---|
| V-1 | R5-02 (T-40) | §3.7 channel table, row 2 (l. 412); §4.4 row "`record_erasure_request` … ← Console" (l. 613); C12 "Erasure requests" (l. 1569); claim at l. 444–446; T-40; AI-R5-1 ("console → identity erasure-request intake") | Since R5-24, principal contexts are unsigned. Identity accepts `record_erasure_request(context, intake_ref, intake_time)` from the console and trusts the context the console supplies. A compromised console can therefore record an "own-data" erasure request for any user subject. One honest compliance operator then executes it from the queue, and the owner-signed summary shows a genuine-looking open request. So "neither a console compromise nor one compliance operator can erase a subject who has not asked" is false. Also, the console commits the intake before forwarding, and the forward has no stated retry, so a crash between the two starts an `erasure_max` clock that identity never sees | Route the erasure kind of documented request **edge → identity** directly. §4.4: "Identity and access: `record_erasure_request` ← Edge (with a user principal context)". Identity checks that the kind is a user and that subject = the context's `principal_id`, and sets `requested_at` to **its own commit**. The console sees the request only through `open_requests`. Update §7.5 (one sentence), C12, the §3.7 row and AI-R5-1. A compromised edge remains T-33's residual. (Alternative: the console forwards the user's identity-signed access token, which identity verifies (signature, expiry, active session, `principal_id` = subject), and the forward is retried from the console's outbox until acknowledged) |
| V-2 | R5-07 | §7.4 check 3 (l. 1056–1058); C15 (l. 1611–1613); C4 "counter" | "Refuses a counter not higher than the last recorded for the credential" refuses legitimate actions. A requester signs a four-eyes action (counter n), which waits up to `approval_expiry` for approval. Meanwhile the requester signs read grants (n + 1, …), which readers record through C15. At apply, the requester's assertion has counter n, which is lower than the recorded counter, so the owner refuses. The same happens to any single-operator action whose send is overtaken by another signature | Replace monotonicity with **single use**. Identity refuses an assertion whose (credential, counter) has already been consumed under another `action_id` or `grant_id`, keeping consumed pairs for `approval_expiry`. A counter lower than the credential's highest recorded counter is alerted (possible cloned authenticator), not refused. Optionally include `action_id` in the canonical action, so a digest cannot be re-sent under a new identifier. Update DT-8 ("reused (same counter)" stays valid) |
| V-3 | R5-07 (X1-S32) | §7.3 "Expiry and cancellation" (l. 994–1000); C15 `cancel` (l. 1613–1614) | Identity does not order `cancel` against `operator_check`. An owner can pass the operator check, the requester can then obtain a cancellation receipt, and the owner then commits. The action then takes effect after a cancellation whose receipt the operator holds, contrary to the §7.3, §7.4, S5 and Benefits claims | C15: `cancel` and `operator_check` are serialised in identity's operator partition. Once the digest's assertion is consumed, `cancel` answers "too late: already applied or applying", with no receipt. An `operator_check` of a cancelled digest answers `cancelled`. Add one line to §7.3 saying the signing client shows "too late" |
| V-4 | R5-26 (D-7) | §3.8 (l. 531–534); §4.2; §7.5 | The recovery hold can be cancelled by "any existing administrator's or user's objection made through the marketplace as a request to support". But the §7.5 intake records only requests that C2 `decide` permits (a change the principal may itself make), plus own-data erasure. No §4.2 row permits an objection, so it is refused at intake. That is the same gap R5-02(b) found for erasure. The hold therefore has no working objection path | Add a §4.2 row: "Object to a pending account recovery of own account or supplier (§3.8)": account administrator and user, supplier administrator and user: yes; keys: refused, recorded. Then either add it to §7.5 as a third accepted kind forwarded to identity, or (simpler, and consistent with V-1) make it an edge → identity command. Identity cancels the recovery in the account's serial order and alerts onboarding. Also reflow l. 533 (the paragraph runs together on one line) |

All four fixes are local and touch at most a few lines in each named place. No other
finding or earlier fix is affected: V-1 narrows R5-12's intake flow without adding a SQL
read; V-2 and V-3 change only C15's semantics; V-4 adds one matrix row.
