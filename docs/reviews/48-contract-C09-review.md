# Review 48. Adversarial security re-review of contract C09 (personal-data store)

| | |
|---|---|
| Under review | [C09](../04-delivery/contracts/C09-personal-data-store.md), version 1.0-draft.2 (mode: contract; focus: security), after [review 36](36-contract-C09-review.md) (REJECT, Blocker R36-01) |
| Authority | Requirements at `requirements-v1.10` (POL-19, POL-32; P3-S71, P3-S75, P4-S118, X1-S12, X1-S13, X1-S27, X1-S31, X1-S34, X1-S37, X1-S39, X1-S42, X1-S43, X1-S46); RFC-000 revision 4.4 (A11; §8 rows: personal-data store, payout destination, operator check, read grant) |
| Contract sections read | RFC-005 rev 5 (§3.7, §7.5, §7.6, §10, §13, §14, §15, C12, C13, C15, C16); RFC-003 rev 5 + erratum 5.1 (§3.3 steps 1–6 and crash table, §8 rows); RFC-006 rev 6 (§3.2, §14.4, §15 notifier channels, DT-25, RK27); RFC-004 rev 5 only through C16 |
| Settled list | S-M1 … S-M4 and S-G1 … S-G3 binding; D-36-1 … D-36-5 binding; the orchestrator accepts the erasure bound min(r + 23, e + 14) days. One finding is about a consequence of a settled point, not the point itself: R48-02 (how R36-17 implements S-G1) |
| Tools | `python3 tools/check_specs.py`: no problems (473 scenarios). `python3 tools/impact.py coverage C09`: `KeyError: 'C09'` (no contract slices), so I checked the 12 cited scenario IDs by hand with `rg`: all exist, none dangling. X1-S13 ("support … erase a person's personal data" refused) is relied on by the new envelope check but not cited (R48-17) |

## Verdict

**REJECT** (revise; a fix verification of the findings below is enough, not a full
re-review). The review finds **1 Blocker, 7 Majors and 16 Minors** (24 findings).

All 31 findings of review 36 are addressed in the text, and 24 are resolved outright.
Seven resolutions bring in new defects or are incomplete (table below). The Blocker is
new in draft.2: a case note survives the erasure of a subject it names, against RFC-005,
X1-S34 and X1-S39 (R48-01). The Majors fall into four groups:

- **What survives an erasure or expiry**: the S-G1 comparison hash (R48-02) and how the
  payload key layers nest (R48-08).
- **Restore**: `reapply` does not rebuild tombstones, erased ranges or idempotency
  records (R48-03), and mutable-item versions dead-end after a restore (R48-04).
- **The erase envelope check** cannot be built as specified and does not bind the scope
  (R48-05).
- **Shape**: `erasure_executed` outgrows a Kafka message on the single-partition feed
  (R48-06), and the documents behind non-user and legal requests have no working put path
  and the wrong readers (R48-07).

### Review 36 resolution check

| R36 | Status | Note |
|---|---|---|
| 01 (Blocker) | Resolved | The console can put only `case_note`. Write-once `payout_destination_details` closes the redirect. The "onboarding, through identity" row cannot be enforced by workload identity (R48-17) |
| 02 | Resolved, new defect | Versioning works, but dead-ends after a restore (R48-04). The ordering of identity's commit and its put is unstated (R48-19) |
| 03 | Resolved | Purpose → kinds table, grant roles, rate limits. The limits sit at or below the stated load (R48-15) |
| 04 | Resolved, regresses on restore | `reapply` does not rewrite subject tombstones (R48-03) |
| 05 | Resolved | — |
| 06 | Mostly resolved | `reapply` semantics are incomplete (R48-03); the fence and the trust in the tooling (R48-13); one outbox partition is assumed (R48-12) |
| 07 | Resolved | Deletion is triggered by the event, not by state (R48-14) |
| 08 | Resolved | The imbalance and overshoot claims are wrong (R48-16) |
| 09 | Resolved | Batched erase writes the ranges too late (R48-10); a resend after a supplier-scope erasure is kept again (R48-21) |
| 10 | Resolved (bound accepted) | HSM usage-end mechanics and coalescing of forced rotations (R48-11) |
| 11, 12, 14, 21, 22, 24, 26, 28, 29, 31 | Resolved | — |
| 13 | Partly | The RFC-000 erratum list misses changed payloads and arguments (R48-20) |
| 15 | Resolved | Erased-range timing (R48-10) |
| 16 | Mostly | `caller` body field and malformed-input refusal (R48-17) |
| 17 | **Resolved by an unsafe mechanism** | A plain SHA-256 under an escrowed column key (R48-02) |
| 18 | Resolved, ambiguous | The wrap nesting is not stated (R48-08) |
| 19 | Resolved | The reason-code source is misnamed (R48-18) |
| 20 | **Not implementable as written** | R48-05 |
| 23 | Resolved | Residual when a lost cluster comes back (R48-22) |
| 25 | Resolved, new defect | "Tagged **only** with erased subjects" (R48-01); document kinds (R48-07) |
| 27 | Resolved | Event size (R48-06) |
| 30 | Resolved | Rate and rotation gaps (R48-15) |

### Traces run

1. **Support note about two people, one erased.** A support operator puts note n tagged
   [u1, u2]. u1's request is executed. Under draft.2, erase deletes only "case notes
   tagged only with erased subjects", so n survives. A support grant targeting u2 then
   reads n, which holds u1's personal data, with no end date. **Fails** X1-S34 ("can no
   longer be recovered from anything Share holds") and X1-S39. It also contradicts
   RFC-005 §3.7 step 2, §7.5 ("Erasing a subject destroys the notes tagged with it") and
   C12's scope. R48-01.
2. **A kept payload resent with identical bytes, then erased by supplier scope.** The
   repeat-put check reads the comparison hash, a plain SHA-256 of the plaintext sealed
   under the store's C13 column key. The erasure deletes the bucket key and, within 24 h,
   the rows. But C13 data keys are kept 7 years with their KEKs escrowed 3-of-5 (RFC-005
   §10). So the SHA-256 stays decryptable wherever the ciphertext lingers: uncompacted SSTs
   and Raft logs on all five voters (R3 included), and backups up to 7 days old.
   RFC-005's bound for those copies rests on destroying `KEK_PD,h` and `X_d`, and neither
   covers this hash. RFC-003 §3.3 itself says why a plain hash of a short record holding
   an address is reversible. **Fails** P3-S71 and X1-S42 ("can no longer be recovered
   from any copy"). R48-02.
3. **Restore from a 3-day-old backup across an erasure of u1 and an `exporters_period`
   erasure of x1 [D, D+3).** `reapply` deletes u1's keys and the listed bucket keys, but
   step 5 says it deletes keys "with their tombstones" and "with the erased ranges". So,
   after unfencing:
   - a console case note tagged u1 is accepted, and u1 has a fresh subject key;
   - a put of x1 with `received_at` in D+3 is kept under a new bucket-key version.

   If identity's `erasure_executed` entry had not committed before the restore (crash
   between steps 2 and 3 of RFC-005 §3.7), the re-drive finds no `request_ref` record and
   executes again. It emits a second `erasure_executed` with a later `store_commit`, which
   breaks "one per `request_ref`". **Fails** R36-04 and R36-09 after any restore. R48-03.
4. **u1 changes its contact after a restore.** Identity's projection says the current
   version is v5. The restored store holds v3. The put carries `expected_version` v5, and
   the store answers `refused(stale)` on every attempt. The contract's remedy ("identity …
   asks for re-entry") produces the same refusal. **Fails** liveness for every mutable
   item touched since the backup, `login_identifier` included. R48-04.
5. **Compromised or defective identity calls `erase(request_ref = R_victim, scope = u2)`
   with the `action_id` and digest of a genuine compliance envelope for another request.**
   The store calls C15 with (`action_id`, digest). C15 needs the signer tuples, which
   `EraseRequest` does not carry. If it were called, it would confirm that a compliance
   operator signed *that* digest. The store never recomputes the digest from
   (`request_ref`, scope), so nothing ties the signature to what is erased. **The defence
   in depth is void.** And a legitimate re-drive more than 72 h later (consumed pairs
   forgotten, `not_after` past) is refused (`envelope_invalid`), which strands the request
   in *executing* past `erasure_max`. R48-05.
6. **Supplier with 100 exporters erased.** `destroyed.bucket_keys` has up to 100 × 912 =
   91,200 entries. At about 60 to 80 B each in protobuf or JSON, that is **5 to 7 MB**,
   above Kafka's default `max.message.bytes` (1,048,588 B). The relay cannot publish it, and
   the feed's single partition (key `"pds"`) blocks every later event behind it: pruner
   backstop, restore cutoff and `store_outbox_head` waits. R48-06.
7. **Non-user request (X1-S42).** RFC-005 §3.7 and §7.2 have the console put the written
   request and its identity evidence **as a case note**, then record the request. That is
   when identity mints the `subject_id`. C09 requires `tags` ≥ 1 on a case note and offers
   no subject to tag. Its own `erasure_request_document` kind is identity-only, and no flow
   puts it. As a case note, the evidence is readable by **support** under purpose
   `case_note`, against D-36-1. R48-07.
8. **Put racing a supplier-scope erasure.** Instance A has bucket key v1 of
   (x1, 14:00) cached. The erase deletes v1 and must invalidate "on every instance before
   it answers". If A is partitioned from the others but reaches the database, either:
   - the erase blocks until A answers (liveness); or
   - it answers, and A's `get` of a payload in (x1, 14:00) is served from the cache after
     `store_commit`, if `get` uses the cache without reading the key row.

   R48-09.
9. **Ambiguous put, then withdrawal** (review 36 trace 1, rerun on draft.2): safe. "Known
   outcomes only", the withdrawal tombstone and serialisable ordering hold.
10. **Late erasure at e = r + 20 days** (accepted bound): a forced rotation starts at
    e + δ, and h is destroyed at e + δ + 7 = r + 27 + δ. That passes. At e = r + 23 the
    bound is r + 30 + δ, not r + 30 (R48-11, Minor).

## Findings

| ID | Severity | Location | Finding | Proposed change |
|---|---|---|---|---|
| R48-01 | **Blocker** | erase Effect ("case notes tagged only with erased subjects"); get read grant ("any of its tagged subjects"); reapply | Draft.2 narrows RFC-005 §3.7 step 2, §7.5 and C12 ("the subject's items and tagged case notes"). A note naming an erased subject and a live one survives, and remains readable under a grant targeting the live subject. That is the erased person's free-text personal data kept indefinitely: it fails X1-S34 and X1-S39, and contradicts the provider RFC with no recorded decision | Delete **every** case note tagged with any erased subject (RFC-005). List the deleted note IDs in `DestroyedKeys` (`notes: SubjectId[]`) so `reapply` deletes exactly those. Tests 10 and 13: a note tagged [u1, u2] is `not_found` after u1's erasure, under a grant targeting u2. D-48-1 |
| R48-02 | Major | Idempotency `put_payload` (R36-17); S-G1 | The comparison value is a **plain SHA-256 of the plaintext**, sealed under the store's C13 column key. That key is neither a `KEK_PD` generation nor `X_d`: C13 data keys are kept 7 years and their KEKs escrowed (RFC-005 §10). The hash survives erasure and expiry in every copy whose bound depends on key destruction: uncompacted files and Raft logs on five voters (R3 included), and backups. A plain hash of a short payload is reversible by enumeration, which is the reason RFC-003 keys its digest. This breaks P3-S71 and X1-S42 for that derivative | Make the comparison value **HMAC-SHA-256 under the item's bucket key** (destroyed by erasure, and wrapped under `X_d`, so gone at expiry). Compare only when the bucket key is unwrapped in memory (open hour); otherwise answer the first bucket with no comparison and no alert, as for destroyed keys. Still no HSM call on the hot path. Test 4: after the bucket key's destruction, no stored value derived from the plaintext is readable with any key that is not destroyed (D-48-3) |
| R48-03 | Major | Restore step 5 (`reapply`); test 27 | `reapply` "deletes exactly what it names … with their tombstones … with the erased ranges". It must **write** state the act created, not only delete. Otherwise, after a restore: (a) puts to an erased subject or tag succeed (R36-04 undone); (b) payloads with `received_at` in an erased period are kept (R36-09 undone); (c) a re-driven `erase` finds no `request_ref` record, re-executes and emits a second `erasure_executed` with a later `store_commit`; (d) a re-driven `withdraw_payload` emits a second `payload_withdrawn`, possibly with the other `was` | `reapply` of `erasure_executed`: delete the listed keys, items, blind-index rows and notes (R48-01); **write** the subject tombstones and erased ranges; **write** the `request_ref` record (`store_commit`, `destroyed`), so a repeat answers the original. `reapply` of `payload_withdrawn`: delete the item; **write** the tombstone with `was` and `day`. Test 27 adds: after restore, a put to an erased subject is `refused(subject_erased)`; a put in an erased period is `not_kept(erased)`; a re-driven erase or withdrawal answers the original with no new event |
| R48-04 | Major | put mutable kinds (R36-02); Restore step 6 | After a restore, identity's known version is newer than the store's, so every later put of that item is `refused(stale)`, re-entry by the user included. This dead-ends contacts, names and login identifiers touched since the backup. No answer tells identity the store's current version | `refused(stale)` carries `current_version` (a pseudonymous log sequence, no data). After a restore, identity may re-base: a put with `expected_version` = the store's current, and `version` = the new change's sequence. Restore tooling publishes the restore's AS OF to identity, so identity alerts on and re-bases every item whose version is past it. Test 27: a change after restore succeeds (D-48-5) |
| R48-05 | Major | erase (R36-20); `EraseRequest.envelope`; Timeouts | (1) C15 `operator_check` needs the signers' (operator, credential, counter). `EraseRequest` carries only `action_id` and digest, so the check cannot be called. (2) The store never recomputes the digest from (`request_ref`, scope, action type), so any compliance envelope authorises any erase: no binding. (3) Re-drives and duplicates are checked again. After `approval_expiry` (72 h) or `not_after`, a legitimate re-drive is `refused(envelope_invalid)`, and the request is stuck in *executing* past `erasure_max`. (4) Unstated residual: C15 is answered by identity, so a compromised identity defeats it anyway | `envelope` carries the signed fields (action type, `action_id`, `request_ref`, scope, verification reference, `not_after`) and the assertions. The store recomputes the digest, verifies it by the C4 rules and C15 (role compliance), **once, at the first call for a `request_ref`**, and records the result with the request. Duplicates and re-drives are answered from that record with no re-check. State the residual (C15 served by identity; protects against a defective identity, not a compromised one). Test 13: an erase whose scope differs from the signed scope is refused; a re-drive after `not_after` completes |
| R48-06 | Major | `StoreEvent.erasure_executed`; `DestroyedKeys`; Delivery and ordering | One event per erasure, with every destroyed bucket key listed, reaches MB size for a multi-exporter supplier (RFC-005: up to exporters × 912 hours). That is above Kafka's 1 MB default. On a single-partition feed, an unpublishable event blocks every later one, and with them the pruner backstop and every restore (`store_outbox_head` never published) | Encode bucket keys as ranges: (exporter, `from_hour`, `to_hour`, key versions), which is nearly always one range per exporter. Also split an oversized set into `erasure_executed_part(request_ref, part, of)` events committed with their batches, the last carrying `store_commit`. Cap an event at 512 KiB (est.), and state the topic's `max.message.bytes`. Test: a 100-exporter supplier erasure is published and re-applied |
| R48-07 | Major | Item kinds; put callers; Purpose → kinds | RFC-005 §3.7, §7.2, §7.5 and C12 put the non-user written request with its identity evidence, and a legal order's document, **as console case notes** (`note_ref`). C09 makes `erasure_request_document` and `legal_order_document` identity-only kinds that no flow writes. As case notes: (a) they cannot be tagged with the not-yet-minted `subject_id` (`tags` ≥ 1); (b) support reads them under purpose `case_note`, against D-36-1 (documents compliance-only) | Let the console put `erasure_request_document` and `legal_order_document` like case notes (store-minted ID, write-once, `client_ref`), with `tags` ≥ 0. Add identity-only `tag_note(note_id, subject_id, request_ref)` used when identity records the request. They are readable only by compliance under `case_note`. Amend RFC-005 §7.5 and C12 to name the kinds (AI-48-2). Tests 7 and 9 (D-48-2) |
| R48-08 | Major | put_payload Effect (R36-18); Ownership Keys | "The item key is wrapped under the account payload key and the bucket key; the bucket key … under `X_d` … and under `KEK_PD,g`" can be read as **separate** wraps. Then deleting the account key, or destroying `X_d`, leaves another path to the item key: the erasure-by-account and expiry guarantees fail silently | State the nesting: item key stored as Wrap(bucket key, Wrap(account key, item key)) (the inner wrap only if `account`); bucket key stored only as Wrap(`KEK_PD,g`, Wrap(`X_d`, bucket key)); a generation rewrap touches only the outer layer. Tests: after `X_d`'s destruction, with the current `KEK_PD` available, no bucket key of day d unwraps; after an account key's deletion, with the bucket key present, the item key does not unwrap |
| R48-09 | Minor | Ownership Keys (bucket-key cache); erase | "Invalidated on every instance before an `erase` destroying them answers" makes erase wait on every instance (liveness under partition), or else lets a stale cache serve or wrap after `store_commit` | Every `get` and `put_payload` reads the key row (exists, version) in its transaction. The cache only saves the unwrap, so deletion takes effect at commit without invalidation. Invalidation becomes best-effort hygiene |
| R48-10 | Minor | erase Batching (R36-15) with `exporters_period` (R36-09) | The erased ranges are written in "the last batch" (with the event) or unstated. Between the first and last batch, a put with `received_at` in the period creates a new bucket-key version outside the fixed set, and escapes | Write erased ranges (and subject tombstones) in the **first** batch, with the fixed set |
| R48-11 | Minor | erase Bound (R36-10, D-36-4) | (1) A generation KEK's HSM usage end is fixed at creation (`s_h` + 14 days). A forced rotation must move h's usage end to (new `s_{h+1}`) + 7, or schedule destruction regardless; neither is stated. (2) One forced rotation per late erasure can mean many rotations in a backlog: coalesce (a rotation started after e covers e). (3) The bound is (rotation start) + 7 days, so "every execution up to r + 23" overshoots by the rewrap time δ (minutes) | State (1) and (2). Define e for the forced case as the forced rotation's start, with deadline r + 23 days − 1 h (est.). Bound accepted per the orchestrator |
| R48-12 | Minor | Restore step 4; Delivery and ordering (feed row); `StoreOutboxHeadAnswer` | `head: EventId` and "total order in commit order" hold only if every store event, the attestation entries included, is written to **one** identity outbox partition with a dense sequence. Withdrawals (from the store), erasures (request partitions) and attestations (identity's log) are written by different writers | State one outbox partition (`"pds"`) for all store events, sequence dense, or make `head` a vector of per-partition heads and drop the total-order claim |
| R48-13 | Minor | Restore steps 2, 5; `reapply` | (1) The fence's location is unstated. If it is a row in the restored tables, it comes back from the backup as "serving", and instances serve between RESTORE and fencing. (2) `reapply` executes whatever events the tooling passes, so a compromised restore tool can erase arbitrary subjects irreversibly | Hold the fence outside `pds` (identity control row, or instances stopped), set before RESTORE begins. Make `reapply(restore_id, from_as_of, through: EventId)`, with the store reading the feed itself (ACL added): cheaper and not forgeable by the tooling |
| R48-14 | Minor | expire; erase (row deletion) | Row deletion is worded as a reaction to events. Rows restored from a backup taken after `expiry_destroyed(d)` but before deletion are never deleted. They are unreadable, but they leak storage toward the S-M1 backstop | Make deletion a state-based sweep: every payload row of a day whose `expiry_destroyed` is committed, and every row whose bucket or account key row is absent. Run it daily and after every restore |
| R48-15 | Minor | get rate limits; lookup_login; Ownership Load | (1) The identity `get` limit (2,000/s) equals the stated peak (2,000/s), leaving no headroom. (2) `lookup_login` at 200/s caps logins far below a login-driven peak, and one global store-side limit lets credential stuffing lock out every login. (3) 2,000 HSM unwraps/s (one per subject read) against RFC-005's `unwrap_rate_limit` "from takeover load". (4) The blind index is recomputed at each generation change, so lookups during the rewrap miss | Set limits at about 2 to 3 × the estimated peak (est.). Shape `lookup_login` per source at the edge (`preauth_rate_limit`), with the store limit as a backstop. State the store's unwrap budget. Look up under the current and previous index key until the recompute completes |
| R48-16 | Minor | put_payload Caps (R36-08) | "Imbalance can refuse below the global cap (est. ≤ 1/N unused)" is wrong. With exporter routing and a fixed share of 125/s per instance, one instance holding 13 or more full-rate exporters refuses while seven idle, leaving up to (N − 1)/N unused. "At most 2× for one window" during a rebalance assumes routing views converge within 1 s | State the true bounds, or let instances lend unused share each second. Bound the overshoot by the membership-propagation time (est.), and have an instance refuse exporters it does not own |
| R48-17 | Minor | Schema `GetRequest.caller`; `RefusalCheck`; put caller table; Scenarios | (1) `caller` in the body duplicates the mTLS identity, and a mismatch is undefined. (2) No refusal exists for malformed input (empty `tags`, a digest not 64 hex characters, an unknown kind). (3) "Onboarding, through identity" has identity's workload identity, so the row is not enforceable. (4) X1-S13 is relied on but not cited | Derive the caller from the workload identity; on mismatch, `refused(caller_not_allowed)`. Add `invalid_request`. Merge onboarding's row into identity's, or give onboarding its own workload. Cite X1-S13 |
| R48-18 | Minor | `ReasonCode` (R36-19); Ownership Keys | (1) POL-32 has no reason list: the closed list is the action catalogue's, in identity's policy partition (RFC-005 §3.1, §7.2). (2) "Nothing escrowed" sits beside `digest_key`, whose keys **are** escrowed with the log KEKs (RFC-005 §10) | Cite RFC-005 §7.2's reason codes. Scope "nothing escrowed" to `KEK_PD`, index, expiry, subject, account and bucket keys |
| R48-19 | Minor | put mutable kinds | `version` = identity's log sequence implies commit, then put. A crash between them leaves identity naming a version the store lacks, and the re-drive is unstated. C16 uses put-then-commit for destinations, so the contract mixes two models | State that identity commits the change, then puts it, re-driven by the lease holder from entries with no `stored` record. `get` answers the previous version meanwhile |
| R48-20 | Minor | Consumer obligations (R36-13) | The RFC-000 §8 erratum omits: `payload_withdrawn(record_id, day, was)`; `erasure_executed(…, destroyed)`; `received_at` on `withdraw_payload`; erase's `envelope`; the `case_note` purpose. RFC-006 §14.4 still says "each item key wrapped under its receipt day's expiry key" (R36-18), and needs the topic message size (R48-06) | Add them to AI-36-1 and the RFC-006 list |
| R48-21 | Minor | put_payload; erase `supplier` scope (RQ-36-3) | A batch received before a supplier- or account-scope erasure, resent just after it with the item rows already deleted, is put with the resend's `received_at` and **kept afresh** under a new key version. That payload predates the request | For `supplier` and account scopes, also write an erased range per exporter [the earliest bucket hour in the set, `store_commit` + 1 h). This costs nothing more, and the validation window (1 h) bounds it |
| R48-22 | Minor | expire, lost HSM cluster (R36-23) | A cluster declared decommissioned still holds the KEKs and expiry keys if it is physically recovered or seized. The contract treats the declaration as destruction | State that a decommissioned cluster that reconnects is destroyed before serving, with its attestation appended. Name the residual (FIPS 140-3 level 3 tamper response, usage-end enforcement) |
| R48-23 | Minor | expiry/erase scope (over-engineering) | (1) The account payload key layer, `account?`, `account_payload_keys` and their `destroyed` list are unused: RFC-003 never sends `account`. (2) Erased ranges are kept until `to` + 37 days, but validation already refuses `received_at` < T − 1 h | Mark the account layer "reserved, unused by RFC-003" and test it only when a consumer sends `account`. Keep erased ranges until `to` + 1 h + `max_offset`: fewer rows, and a smaller `reapply` |
| R48-24 | Minor | Conformance tests | No test covers: `reapply` writing state (R48-03), the wrap nesting (R48-08), multi-tag notes (R48-01), event size (R48-06), re-drive after `not_after` (R48-05), post-restore puts (R48-04) | Add them, as listed in each finding |

## Decisions taken

- **D-48-1 (multi-subject notes, R48-01).** Erasing any tagged subject deletes the whole
  note, as RFC-005 §7.5 says.
  - The live subject loses the note. An operator re-writes what is still needed without
    the erased person.
  - Why: X1-S34 is unconditional, and partial redaction of free text cannot be done
    reliably.
- **D-48-2 (request and order documents, R48-07).** They are compliance-only documents,
  put by the console with store-minted IDs, and tagged by identity when it records the
  request.
  - Why: the evidence of a non-user's identity is the most sensitive item in the store,
    and support needs none of it.
- **D-48-3 (S-G1 comparison, R48-02).** The comparison is keyed under the bucket key and
  made only while the bucket key is in memory.
  - A repeat in a closed hour with different bytes goes undetected. That is a defect
    signal only, and RFC-003's keyed digest in `record_id` already makes it near
    impossible.
  - Why: no derivative of the payload may outlive its keys.
- **D-48-4 (restore, R48-13).** The store reads the feed itself, from the cutoff to the
  head. The tooling passes only the cutoff and the head.
- **D-48-5 (post-restore versions, R48-04).** Identity re-bases on the store's current
  version, and any change lost in the restore is re-entered by the user.
  - Why: identity holds no content to re-put, and a permanent `stale` is worse than one
    re-entry.
- **Erasure bound.** min(r + 23, e + 14) days, e + 7 after a forced rotation, as accepted
  by the orchestrator. R48-11 only makes the rotation mechanics explicit.

## Requirements issues

- **RQ-36-1, RQ-36-2 and RQ-36-3 remain open.** R48-07 and D-48-2 sharpen RQ-36-1: how
  long a non-user's identity evidence (now an `erasure_request_document`) is kept after
  the request is executed or refused.
- **RQ-48-1 (shared records, R48-01).** POL-19 does not say what happens to a record that
  holds two people's personal data when one asks for erasure.
  - Proposed: the whole record is erased, and the other person's data in it is lost. State
    this in POL-19 so that support knows that notes naming several people are fragile.

## Architecture issues

- **AI-48-1 (RFC-000 §8, personal-data store row).** Extend AI-36-1 with the payloads and
  arguments in R48-20, the range encoding or parts of `erasure_executed` (R48-06), and
  "one outbox partition for store events" (R48-12).
- **AI-48-2 (RFC-005 §3.7, §7.5, C12).** Name the document kinds (R48-07). Make the erase
  envelope carry its signed fields and assertions, checked once per `request_ref`
  (R48-05). Make the S-G1 comparison keyed under the bucket key (R48-02). State the wrap
  nesting (R48-08). Move a generation's HSM usage end on a forced rotation, and coalesce
  forced rotations (R48-11). Delete every case note tagged with an erased subject
  (unchanged; C09 must follow it, R48-01).
- **AI-48-3 (RFC-006 §14.4).** The restore fence held outside `pds`, and the store
  reading the feed itself during `reapply` (R48-13). The topic's `max.message.bytes`
  (R48-06). The wrap wording (R48-20). The state-based row sweep, also run after a
  restore (R48-14).
