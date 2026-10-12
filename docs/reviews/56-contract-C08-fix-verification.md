# Review 56. Fix verification of C08 identity and access (1.1-draft) against review 46

| | |
|---|---|
| Under review | [C08](../04-delivery/contracts/C08-identity-and-access.md) 1.1-draft, its "Review 46 resolution" table, Settled S-M1 … S-G4 (as amended) and Consumer obligations. Focus: security |
| Review record | [Review 46](46-contract-C08-review.md): R46-01 … R46-28 (2 Blockers, 10 Majors, 16 Minors), D1 … D5, RQ46-1, AR46-1, AR46-2 |
| Alignment | [Fix verification 53](53-contract-C05-fix-verification.md) V53-3 (C08 §B and C-02 to state C05 S-2) and V53-4 (µs → HLC rule); [C05](../04-delivery/contracts/C05-funds-and-standing.md) "Identity-freshness watermark", F4 row, S-2 |
| Authority | `requirements-v1.10`; RFC-000 rev. 4.4; RFC-005 rev. 5 (§7.6, §13 `operator_read_limit`, T-29); RFC-006 rev. 6 §13.2 (truncation row-level-security policy) |
| Accepted by the orchestrator (not re-opened) | Snapshot always for a new holder; refusals recorded by `audit_append`; 24 h certificate validity; 200 reads per hour; 20-target breadth alert (est.) |
| Tools | `python3 tools/check_specs.py`: no problems (473 scenarios). `python3 tools/impact.py coverage C08`: still `KeyError: 'C08'` (the tool has no contract slices, as in review 46). The scenario IDs cited by the new tests P-12 … P-18 and the extended C-tests all already appear in C08's "Scenarios relied on"; none are dangling |

## Verification

### Per finding

| ID | Result | Notes |
|---|---|---|
| R46-01 (Blocker) | Verified, with V56-5 | `OperatorCheckRequest.signers[]` carries full assertions. Identity verifies them before consuming, returns `public_key`, `alg` and `registered_origin`, and answers `unknown` unless the credential is registered to the named operator. Check 2 uses only identity's key. The grant digest is v2 with `E(operator)`. Re-trace T4 (forged `set_price` with a captured credential ID): there is no valid assertion, so identity answers `invalid` and the owner's check 2 fails too. Re-trace T5 (pre-consuming counters under bogus `action_id`s): with an invalid assertion nothing is consumed. One residual: binding the identifier to its digest is not conditioned on valid assertions (V56-5) |
| R46-02 (Blocker) | **Defect V56-1** | The policies are qualified, `ENABLE` and `FORCE` are present, the head policy is written out, and `GRANT SELECT` is given. T7 re-traced against the policy alone: P2 is refused. But with RLS forced, permissive policies combine by OR. C08 leaves "every other role's policies unchanged", and RFC-006 §13.2 writes the truncation policy as applying "whoever runs it". So the restore role inherits any unscoped permissive policy, and confinement depends on text that C08 does not control |
| R46-03 | Verified | `epoch`. `sent_at` is the HLC timestamp of the head-row read. Heartbeats are sent only under the lease, with `sent_at` < expiry − `max_offset`. The edge rejects a decreasing `sent_at` or an older epoch. Re-trace (holder GC-paused past expiry, successor revokes at `t`): the old holder's next head read has an HLC time past its expiry, so it sends no heartbeat. `fresh_s` stops, and the edge refuses by `t` + 31 s. P-14 covers this |
| R46-04 | **Defects V56-2, V56-3** | `not_after`, the stream with revocations and heartbeats, 31 s refusal, slot and epoch matching, and `slot_of` are all present. Two holes remain. Receivers never check the certificate's `purpose` and `owner_kind` against the object (V56-2). The 24 h `not_after`, checked at verification, invalidates every durable record of an ended epoch (V56-3) |
| R46-05 | Verified (slot naming in V56-2) | `PolicyBundle` is typed and signed, delivered by `iam.policy.v1` and `get_policy`, and applied only at higher versions. A context at an unapplied version gets "temporarily unavailable" (P-18). The bundle names no `slot`, so its certificate slot check is undefined (covered by V56-2's fix) |
| R46-06 | Verified | `CancelRequest` carries the action, role, `not_after` and `requester_original`. Identity recomputes the digest and requires the same person. `digest_conflict` replaces `unknown_action`. Re-trace T6 (a colleague, or the approver, cancels): `not_requester`, no receipt (P-13) |
| R46-07 | Verified, with V56-7 | `since` is defined: a new holder takes a snapshot, and a running holder uses `since = iam_fresh` (inclusive). T2 re-traced: the new holder no longer picks `since` from F4, so nothing older is skipped. The applied-only rule is stated |
| R46-08 | Verified | Dedupe is by `source`, then per-key and KYB `version`. `committed_at` is stated as not unique. The RFC-004 erratum drops the `id_ts` skip and applies the snapshot. T3 re-traced (two events at one `committed_at`): both are applied (C-02) |
| R46-09 | Verified | Five target kinds, each with a receiver and a catalogue row. P-01 has golden vectors per kind |
| R46-10 | Verified as written; **Defect V56-4** (D3 control) | `action_id` and `action_type` are mandatory, kind and role are matched, audit-before-answer is required (C-07), and the duty appears in every summary-serving row. The counting is a problem. The read limit and breadth alert are counted by each owner per console-supplied `operator`. T12 re-traced against a partitioned account owner: each account partition sees about one read per operator, so neither the 200 limit nor the 20-target alert ever fires |
| R46-11 | Verified | `source` comes from mTLS, there is an allowlist, idempotency is keyed by (`source`, `source_ref`), and a conflict is refused and paged (P-17). A forger can no longer pre-claim another source's key |
| R46-12 | Verified | The runtime holds locally and sends `integrity_report`. Audit opens the stop with a `detection_ref`. The hold is re-derived on takeover and lifted only by resume. T8 re-traced: a stop row exists, the restore path is reachable, and the resume is defined (C-11) |
| R46-13 | Verified | Check order is 1, 4, 5, partition test of 6, then 3, 2, 4, `target_version`. A misrouted or expired envelope consumes nothing (C-04). `out_of_scope` covers a target outside the partition |
| R46-14 | Verified | Owners enforce the upper bound `ts + approval_expiry + ε`, and readers enforce `now + read_grant_ttl + ε`. Identity keeps consumed pairs until max(`not_after`, consumption + 72 h) |
| R46-15 | Verified | `applied.result` is present |
| R46-16 | Verified | The idempotency row is fixed. Token principal = `context.principal_id`, else `invalid_token` |
| R46-17 | Verified | Owners record refusals by `audit_append` (`source_ref` = `refusal:<action_id>:<partition>`) and answer them again. `temporarily_unavailable` is never recorded (as accepted) |
| R46-18 | Verified | `acknowledged_at` is in both predicates. `detection_ref` is 16 bytes. `owner_kind` is named apart from the numeric row kind. C-10 covers the case before acknowledgement |
| R46-19 | Verified | The delivery worker holds the secrets and computes the HMAC under its own key release. The §L and §M text, Ownership and S-M3 agree |
| R46-20 | Verified | `sign_until` = the new secret's `active_from` + `webhook_retry`. C-12 covers it |
| R46-21 | Verified | The S-M3 erratum and the RFC-006 row carry both sentences |
| R46-22 | Verified in §D and obligations; **Defect V56-6** | Two references to the notifier remain stale |
| R46-23 | Verified | The endpoint feed is sealed. SNI and hostname verification on the pinned address are required (C-12) |
| R46-24 | Verified (D4) | The integer `occurred_at` exception is stated under Units. Single-notice `webhook-id` = `event_id` is kept (P-01) |
| R46-25 | Verified | `actor` has the four new kinds. §A says "partition's tenant" |
| R46-26 | Verified | 256 is marked est. The limits are initial values (est.) carried in the bundle. Read types are a closed list |
| R46-27 | Verified | The RFC-005 row is filled in. Placement calls `operator_check` at apply |
| R46-28 | Verified | Every test the finding names is present (P-12 … P-16, C-02, C-07, C-10) |
| D1 … D5 | Verified, except D3's counting locus (V56-4) | — |
| RQ46-1, AR46-1, AR46-2 | Verified | Recorded as raised upstream |

### Alignment with C05 (fix verification 53, V53-3 and V53-4)

| Point | Result |
|---|---|
| `R_applied(p)` applied with no gap; a marker merely read counts for nothing | Present (§B freshness bullet; S-M6 amended) |
| A catch-up counts only once its F4 commits (at once if no change) | Present in the freshness bullet. The `catch_up` bullet still says "sets `iam_fresh` to `read_timestamp`" with no commit condition (V56-7) |
| After acquisition, set only by a committed catch-up or snapshot, or once every partition has reported | Present. But "before deciding anything" in the `catch_up` bullet makes the snapshot a precondition that C05 S-2 and H4 do not have (V56-7) |
| The snapshot revokes applied keys absent from it (`KEY_ABSENT_FROM_SNAPSHOT`) | Present (§B Snapshot) |
| C-02 updated | Present: gap, uncommitted catch-up, absent key, µs/HLC gate |
| µs → HLC rule | Present under Units: `t × 10³ ≤ ts.wallNanos`, gate `ts.wallNanos ≤ iam_fresh × 10³ + 45 × 10⁹`. This matches V53-4's proposed text. Flooring to µs only lowers resolved, read and commit times, and the `since` comparison is inclusive, so it is safe. **C05 has not yet applied V53-4** (its Units still give only the ms rule). That is a C05 edit, not a C08 defect |

### Defects

| ID | Finding | Location | Failure | Fix |
|---|---|---|---|---|
| V56-1 | R46-02 | §K DDL and the closing comment ("Every other role's policies are unchanged") | With `FORCE ROW LEVEL SECURITY`, every policy on `<kind>_log` and `<kind>_head` applies to every role it names. Permissive policies are combined by OR. RFC-006 §13.2's truncation policy applies "whoever runs it" (no `TO`). The owner runtime's role also needs a permissive policy once RLS is forced, and the easy way to write one is unscoped. Any such unscoped permissive policy also admits `restore_role`. For example, the truncation policy would let the restore role DELETE rows ≤ watermark in any unstopped partition of any kind (DT-45 broken), and an application `USING (true)` policy would undo the confinement entirely | Add a restrictive policy for the restore role on both tables: `CREATE POLICY restore_confined ON <kind>_log AS RESTRICTIVE FOR ALL TO restore_role USING (<same EXISTS>) WITH CHECK (<same EXISTS>)` (and on `<kind>_head`). Replace the closing comment with: "every other policy on these tables names its role (`TO <owner_role>` for the runtime's SELECT/INSERT, and head UPDATE; `FOR DELETE TO truncator` for §13.2); none is `TO PUBLIC`". Add the scoping to the RFC-006 erratum (§13.2). C-10 gains: "the restore role cannot delete a row ≤ watermark in an unstopped partition" |
| V56-2 | R46-04 (and R46-05) | §C "Certificates" bullet; `PolicyBundle`; `CancelAnswer.receipt` | A receiver checks a certificate's validity, revocation and slot, but not its `purpose` or `owner_kind`. A summary-signing key leaked from any owner (for example catalogue, slot s) can therefore sign a `CredentialRecord` or `SignedKeyRecord` for identity slot s, which an edge or owner accepts. That is full impersonation of every key in that slot, the very outcome R46-04 was meant to contain. Separately, `PolicyBundle` and the cancel receipt carry no slot, so their "slot equals" check is undefined | In §C add: "…and whose `purpose` and `owner_kind` match the object: `identity_record`/`identity` for key records, edge records, heartbeats, edge snapshots, policy bundles and cancel receipts; `owner_summary` with the summary's `owner_kind`; `placement_summary` for placement's". Give `PolicyBundle` and the receipt a `slot` (the policy partition's and the operator partition's identity slot) inside the signed bytes. P-15 gains: "a record signed under a valid `owner_summary` certificate of the same slot is refused" |
| V56-3 | R46-04 | `SigningKeyCert.not_after`; §C "Certificates" bullet; `CredentialRecord`; `SignedKeyRecord` | Every signature must verify under a certificate "within `not_before … not_after`" at verification time, and a certificate is renewed only "while the epoch lasts". After a takeover, the old epoch's certificates expire within 24 h. Every edge record and `SignedKeyRecord` committed under an earlier epoch (most agent and supplier keys, sessions and device certificates) then fails verification at edges, at a cold-starting edge's snapshot load, and at owners. That is a slot-wide outage 24 h after any takeover, or an implementer who skips `not_after` and so loses R46-04's expiry | Add `committed_at: EpochMicros` to the signed body of `CredentialRecord` and `SignedKeyRecord`. State: "for credential records and key records, `not_after` is checked against the record's `committed_at` (the key could sign then); revocation is checked now; for heartbeats, snapshots, summaries, receipts and policy bundles, validity is checked now". P-15 gains: "a record of epoch e−1 remains accepted 25 h after a takeover; after its certificate is revoked it is refused within 31 s" |
| V56-4 | R46-10 (D3) | §G compensating controls; §H; `AuditAppendAnswer`; Timeouts `operator_read_limit` row | `operator_read_limit` and the breadth alert are counted by each summary-serving owner, keyed on the `operator` in an unsigned `console_session`. Owners are partitioned (the account owner per account). A compromised console that spreads reads across partitions, or across operator IDs, stays under 200 reads and 20 targets at every counter, so the control behind S-G3's residual risk never fires (T12) | Count where every such read already passes, which is audit: "audit counts `console_session` summary appends per operator and per console workload per hour; past `operator_read_limit` it refuses the append with `read_limit` (the owner then answers `refused read_limit`: no append, no answer), and it raises the breadth alert past `breadth_alert_targets_per_h` distinct targets per operator and in total". Add `"read_limit"` to `AuditAppendAnswer.refused.reason`. Change the Timeouts enforcer to "audit (session summaries); readers (grants)". C-07 keeps its case, now driven by audit's refusal |
| V56-5 | R46-01, R46-06 | §F `operator_check` bullet ("On the first call … it binds that identifier to its `digest`") | The binding is not conditioned on valid assertions. A call with an invalid assertion, or a `consume: false` call, under a pending action's `action_id` and a wrong digest fixes the binding. The real action's check, and the requester's `cancel`, then answer `digest_conflict`. This lets an allowlisted caller block an action without a hardware touch, against R46-01's "an invalid call has no effect" | Change to "it binds that identifier to its `digest` only on a call whose every assertion is `valid`; a call with any invalid assertion binds and consumes nothing". P-12 gains: "an invalid call under a pending `action_id` with another digest leaves the real check unaffected" |
| V56-6 | R46-22 | Header "Consumers" (notifier "supplier visibility for supplier notices"); Timeouts row `visibility` ("Reporting, notifier, provisioning feed") | Both still oblige the notifier to call `visibility`, which contradicts §D and the RFC-006 row | Drop "supplier visibility for supplier notices" from the header and "notifier" from the Timeouts row |
| V56-7 | R46-07; V53-3 | §B `catch_up` bullet | (a) "The answer … sets `iam_fresh` to `read_timestamp`" has no commit condition. This is the old wording V53-3 named, and it contradicts the freshness bullet. (b) "before deciding anything" makes the snapshot a precondition for a new holder. C05 S-2 and H4 allow confirming once every partition has reported. The two consumer texts disagree on when a new holder may confirm | (a) "…and, once that entry commits (at once if it carries no change), sets `iam_fresh` to `read_timestamp`". (b) Replace "before deciding anything" with "at once on acquisition; until a catch-up or snapshot entry commits or every partition has reported, nothing is confirmed (C05 S-2)". Alternatively, if the snapshot is to be a hard precondition, raise the same rule against C05 S-2 and H4 |

## Verdict

**ACCEPT WITH CHANGES.** Both Blocker fixes are present and re-trace correctly against
their own traces (T4, T5, T7). The Majors and Minors are applied, and the C05 alignment
(V53-3, V53-4) holds, apart from the two wording points in V56-7. There are seven
concrete defects:

- Three are security Majors: V56-1 (forced RLS lets unscoped permissive policies widen the
  restore role), V56-2 (certificate purpose not checked, so a summary key can forge
  identity records), and V56-3 (24 h expiry, checked at verification, breaks durable
  records after a takeover).
- One is a Major in a compensating control: V56-4 (read limit and breadth alert counted
  per owner partition).
- Three are Minors: V56-5, V56-6 and V56-7.

Each fix is a precise local edit of a few lines (V56-2 and V56-3 each add one signed
field), so the orchestrator may apply them directly instead of running another round.
