# Review 60. Fix verification of C09 personal-data store (1.0-draft.3) against review 48

| | |
|---|---|
| Under review | [C09](../04-delivery/contracts/C09-personal-data-store.md) 1.0-draft.3: its "Review 48 resolution" table, the passages each row names, "Settled", "Review 36 resolution" (regression check) and "Consumer obligations". Focus: security |
| Review record | [Review 48](48-contract-C09-review.md): R48-01 … R48-24 (1 Blocker, 7 Majors, 16 Minors), D-48-1 … D-48-5, RQ-48-1, AI-48-1 … AI-48-3 |
| Joint change | [C11](../04-delivery/contracts/C11-metering-ingress.md) F41-15: `RecordId` mapping as in C11 1.0.0-draft.2 (commit 336d7a8). The mapping is unchanged in C11 draft.3 |
| Authority | `requirements-v1.10` (X1-S13, X1-S34, X1-S39, X1-S42); RFC-000 rev. 4.4; RFC-005 rev. 5 (§3.7 non-user verification and execution); RFC-003 rev. 5 + erratum 5.1; RFC-006 rev. 6 |
| Accepted by the orchestrator (not re-opened) | Cap sharing by lending the unused share each second (R48-16); rate limits at about 2.5 × the estimated peak (R48-15); the erasure bound min(r + 23, e + 14) days, e + 7 after a forced rotation |
| Tools | `python3 tools/check_specs.py`: no problems (473 scenarios). `python3 tools/impact.py coverage C09`: still `KeyError: 'C09'` (the tool has no contract slices). I checked the 13 scenario IDs in "Scenarios relied on" by hand with `rg`: all are defined in `docs/02-specs`, and none is dangling. X1-S13 is now cited (R48-17) |

## Verification

### Per finding

| ID | Result | Notes |
|---|---|---|
| R48-01 (Blocker) | Verified | `erase` Effect deletes "every note tagged with any erased subject, also when other tags are live". `DestroyedKeys.notes` lists the notes, and `reapply` deletes them. Re-trace of trace 1 (note [u1, u2], u1 erased, grant targeting u2): the note is deleted at the batch commit, so the grant gets `not_found` (test 10). A `tag_note` racing the erase serialises on the subject's key row and is `refused(subject_erased)`. RQ-48-1 is recorded |
| R48-02 | Verified | Idempotency row and S-G1: HMAC-SHA-256 under the item's bucket key, compared only while the key is in memory, with no HSM call. Re-trace of trace 2: after the bucket key is deleted, the stored MAC is keyed under a destroyed key in every copy, so it cannot be enumerated. Test 4 covers backups too |
| R48-03 | Verified, with **V60-2** | Restore step 5 now writes subject tombstones, erased ranges, the `request_ref` record and withdrawal tombstones. Re-trace of trace 3 for a completed erasure: the post-restore put is `refused(subject_erased)`, the put in the period is `not_kept(erased)`, and the re-drive answers from the record (test 29). An erasure that is mid-batch at the fence is not covered (V60-2) |
| R48-04 | Verified, with **V60-5** | `Refused.current_version`, the re-base rule, AS OF given to identity (step 6), and test 29. A delayed old retry is still refused, because `version` must be above the current version. The rolled-back value is served until re-entry (V60-5) |
| R48-05 | Verified, with **V60-4** | `EraseEnvelope` carries the signed fields and the assertions. The store checks the request_ref and scope equality, recomputes the digest, and runs C4 and C15 with role compliance (X1-S13), once, then records the result. Re-trace of trace 5 (genuine envelope for another request): `request_ref` and scope are signed, so the check fails. Re-drive after `not_after`: answered from the record. Residual stated. Recording a failed check is ambiguous (V60-4) |
| R48-06 | Verified | Range encoding with `through_serial`, parts written with the batches, and the last part carries `store_commit`. Size check: a part is at most 524,288 B; with the Kafka record and batch overhead (about 100 B, key `"pds"`), that is about half of `max.message.bytes` 1,048,576. Trace 6 (100 exporters): about one range per exporter, about 100 B each, about 10 KB, so one part. Stated in Schema, the feed section, Timeouts, and tests 18 and 30. Advisory A-1 below |
| R48-07 | Verified, with **V60-6** | The console puts both document kinds (store-minted ID, write-once, `client_ref`, 0 or more tags). There is an identity-only `tag_note`. The purpose table limits the documents to compliance. AI-48-2, and tests 7 and 9. One stale comment on `verification_ref` (V60-6) |
| R48-08 | Verified | put_payload "Key layers are nested" states both wraps and the outer-only rewrap. Test 16 |
| R48-09 | Verified | The key row is read in each `get` and `put_payload` transaction. Invalidation is hygiene, so an erase does not wait. Re-trace of trace 8 (partitioned instance with a cached key): the row read after `store_commit` finds no key row, so nothing is served or wrapped |
| R48-10 | Verified | The first batch writes the tombstones and erased ranges. Test 13 |
| R48-11 | Verified | Destruction is scheduled at the new `s_h+1` + 7 days, there is coalescing, e = the rotation start, and the deadline is r + 23 days − 1 h. Timeouts row and test 14 |
| R48-12 | Verified | One `"pds"` partition with a dense sequence. It includes identity's attestation entries. `EventId` is typed accordingly |
| R48-13 | Verified, with **V60-3** | `reapply(restore_id, from_as_of, through)`, the store reads the feed itself, and the ACL is updated (D-48-4). The fence is set before RESTORE. But the "all store instances stopped" fence option conflicts with steps 3 and 5 (V60-3) |
| R48-14 | Verified | The state-based sweep runs daily and after each restore (expire, Timeouts, test 6) |
| R48-15 | Verified (accepted values) | Identity 5,000/s against a 2,000/s peak. Login is limited per source at the edge, with a 5,000/s store backstop. There is an unwrap budget of 5,000/s per cluster. The lookup also uses the previous index key during a recompute. Test 11 keeps the equal-latency check (no R36-30 regression) |
| R48-16 | **Defect V60-1** | The lending scheme is accepted. But its claim that "the global caps are never exceeded" is false as written |
| R48-17 | Verified | The caller comes from the workload identity, `invalid_request` is added, the onboarding row is merged into identity's, and X1-S13 is cited |
| R48-18 | Verified | `ReasonCode` cites RFC-005 §7.2 and §3.1. "No escrow" is limited to the store's keys, and digest keys are escrowed |
| R48-19 | Verified | Commit, then put. The lease holder re-drives, and `get` gives the previous version meanwhile. Test 8 |
| R48-20 | Verified, with **V60-6** | The RFC-000 §8 list now has `payload_withdrawn(record_id, day, was)`, parts with `destroyed`, `received_at` on withdraw, the envelope, the `case_note` purpose and `tag_note`. RFC-006 gets the wording and `max.message.bytes`. Restore step 6's new RFC-006 obligation is missing (V60-6) |
| R48-21 | Verified | Supplier and account scopes get ranges [earliest bucket hour, `store_commit` + 1 h). Re-trace: a resend of a pre-erasure batch falls in the range (`not_kept(erased)`). Once a range is swept (end + 1 h + `max_offset`), validation (T − 1 h) refuses the same `received_at` |
| R48-22 | Verified | Destroyed before it serves, attestation to audit, residual named |
| R48-23 | Verified | The account layer is marked reserved, test 16 is conditional, and the range retention is shortened |
| R48-24 | Verified | Tests 4, 6, 8, 10, 13, 14, 16, 18 and 29 cover each item that review 48 listed |
| C11 F41-15 (joint) | Verified | C09 `RecordId.ref` identity = {`observation_domain`, `exporter_epoch`, `sequence`, `index?`} and raw = {`partition`, `log_seq`, `index`}, field for field as the C11 draft.2 mapping comment (`epoch` → `exporter_epoch`, `extSeq | packetExtSeq` → `sequence`, NetFlow v9 `index`). Test 23. Advisory A-3 |

### Review 36 regression check

No regression found in R36-01 … R36-31. The following were re-checked against the new text:

- R36-04: tombstones are now written in the first batch and by `reapply`. `tag_note` also refuses on a tombstone.
- R36-05: "Known outcomes only" is unchanged.
- R36-08: no counter row. Lending is in memory.
- R36-17: still no HSM call.
- R36-27: `through_serial` makes the range encoding exact for the set fixed at the first batch.
- R36-30: equal latency is kept and tested during a recompute.

V60-2 qualifies the R36-06 and R36-15 claim "each part once … also after a restore".

### Defects

All are Minor. Each is a precise local edit of a few lines.

| ID | Location | Failure | Fix |
|---|---|---|---|
| V60-1 | put_payload **Caps**, the global-budget bullet; test 3 | "Each instance starts each window with 1/N. Each second, an instance lends its unused share of the last window." Then the lender also starts the next window with its full 1/N. Trace: in window w, instance A is saturated and B … H are idle (875 unused). In w + 1, A gets 125 + 875, and B … H each start with 125. A burst on B … H in w + 1 admits up to 1,875 puts in total, against the 1,000/s cap. So "the global caps are never exceeded" does not hold | State that a lender gives its unused share **out of its next window's allowance**: it starts that window with 1/N minus what it lent, so the sum of allowances in every window is the global cap. Test 3 adds: in the window after lending, a burst on the lenders keeps the total ≤ 1,000 puts and ≤ 4,194,304 B |
| V60-2 | Restore step 5 ("`erasure_executed` (all parts)"); Idempotency `erase` row ("one set of parts per `request_ref`, also after a restore") | (a) The fence stops an erase that is mid-batch. If the backup predates its first batch, `reapply` sees parts 1 … k but not all of them. As written, it applies nothing. The re-drive then finds no `request_ref` record, so it runs the **envelope check again**. After `not_after` or `approval_expiry`, that check refuses, which is R48-05 (3) again. The re-drive also re-executes and emits a second set of parts for the same `request_ref`. (b) If the backup falls between batches, the resume re-emits parts already published, with new `event_id`s. (c) The step says `reapply` writes "the envelope check result", but no event carries it | `reapply` applies each `erasure_executed` part as it reads it: it deletes the listed keys, and from part 1 it writes the tombstones, the erased ranges and the `request_ref` record, marked "envelope checked" (an event exists only if the check passed; the operator is in audit) with progress through the last part read. A re-drive resumes from that record and numbers new parts after the last published one. Consumers deduplicate parts by (`request_ref`, `part`). Test 29 adds: a restore across a mid-batch erase, re-driven after `not_after`, completes with no envelope re-check and no duplicate part number |
| V60-3 | Restore step 2 ("a control row in identity's own tables, **or all store instances stopped**") | With every instance stopped, nothing can rewrap (step 3) or serve `reapply` (step 5). Also, `refused(not_restoring)` needs a fence that a store instance can read | Keep only the control row outside `pds`. Instances read it: while it is set, they serve only `reapply` and the rewrap, and give every other operation `temporarily_unavailable` |
| V60-4 | erase, **Envelope check** step 4 and the sentence after it | "Records the result", followed by "a duplicate or a re-drive … gets its answer from that record", makes a failed first check permanent. A corrected envelope for the same `request_ref` (for example, a replaced expired approval) is refused for ever, or answered `scope_conflict` | Record only a passing check (result and operator). A failing check is audited and records nothing, so a later call with a valid envelope is checked afresh |
| V60-5 | put **Stale answer and re-base**; `lookup_login`; `get` for `notice_delivery` | After a restore, a `login_identifier` or `contact` that the user changed since the backup is served at its old value until the next change. The blind index finds the principal by the removed identifier, and notices go to the removed address, which may be the one the user dropped because it was compromised. "Records an alert and re-bases at the next change" leaves that window open with no bound | Identity does not act on content whose `found.version` is below its own projected version. It holds the notice and asks the user to re-enter. `LookupLoginAnswer.principal` also carries the matched item's `version`. Identity refuses a login matched on a superseded version, then asks for re-entry. Test 29 adds this check |
| V60-6 | Schema `EraseEnvelope.verification_ref` comment; Consumer obligations, RFC-006 bullet | (1) "The verification's case note": under D-48-2, the evidence is an `erasure_request_document`, not a case note readable by support. (2) Restore step 6 ("give the restore's AS OF time to identity", R48-04) is a new restore-tooling duty, and it is missing from the RFC-006 errata list | (1) "The note ID of the request's `erasure_request_document` (the evidence the verification cites)". (2) Add "the restore's AS OF time given to identity before the fence is removed (R48-04)" to the RFC-006 bullet |

### Advisories (no change required)

- **A-1 (R48-06).** `max.message.bytes` limits a record **batch**. State that the relay's producer keeps `batch.size` ≤ 524,288 B and `max.request.size` ≥ 1,048,576 B. Then two near-limit parts never share a batch above the topic limit.
- **A-2.** `EraseAnswer.destroyed` returns the whole set in one gRPC answer, not in parts. With range encoding it stays small. An unusual subject with about 10⁵ tagged notes would reach gRPC's 4 MiB default.
- **A-3.** C11 types `epoch` as `number` and `extSeq` as `U64`. C09 types `exporter_epoch` and `sequence` as `string`. The mapping needs the JSON decimal-string rule from C09's Units to be read as covering them. It is stated for timestamps only.

## Verdict

**ACCEPT WITH CHANGES.** All 24 findings and the joint C11 change are present. No review 36 fix regresses. Six Minor defects remain (V60-1 … V60-6). Each is a precise local edit of a few lines, so the orchestrator may apply them directly, without another verification round.
