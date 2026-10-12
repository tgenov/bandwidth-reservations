# Review 29. Fix verification of RFC-003 revision 5 (slice S-RATE)

| | |
|---|---|
| Under review | [RFC-003](../03-rfcs/RFC-003-rating-and-metering.md), Draft, revision 5 (reopened from Accepted, revision 4) |
| Against | [Review 19](19-rfc-003-review.md) (F3-01 … F3-20) and [fix verification 24](24-rfc-003-fix-verification.md) (V-1 … V-3), for regression; the rebase onto `requirements-v1.9` ([review 28](28-requirements-amendments-from-c3-round-2.md): RQ3-17, P3-S71 reworded, new P3-S75) and RFC-000 revision 4.3 ("Revision 4.3 errata", RFC-003 row); the interface with RFC-005 revision 5 C12 |
| Authority | POL-19 *A record payload that does not conform* (v1.9); P3-S71, P3-S75; RFC-000 4.3 errata (AI3-14, AI-26-2, AI-27-3, AI4-12, B-AI-11); RFC-005 rev 5 §3.7 `put_payload` / `withdraw_payload` rows, C12, §10 digest keys |
| Scope | Revision 5 resolution table and the passages it names (§1.1, §1.2, §3.3, §3.4, §5.5, §7, §8, §9, R3-13, R3-20, R3-21, RQ3-17, AI3-14, AI3-15), plus review 24's V-rows. No re-review |
| Tools | `impact.py coverage S-RATE`: primary 75 (P3-S75 added by v1.9), uncited 0, dangling 0. `check_specs.py`: 468 scenarios, no problems |

## Verification

**Verdict: ACCEPT WITH CHANGES.** No regression of review 19 or review 24. The v1.9 rebase,
the RFC-000 4.3 interface points and the RFC-005 rev 5 C12 interface are present and
correct. One minor defect and two nits remain. All are precise local edits, so the
orchestrator may apply them directly without another round.

### Regression check (reviews 19 and 24)

| ID | Result | Notes |
|---|---|---|
| F3-01 … F3-20 | Verified, unchanged | Revision 5 touches none of their passages except §5.8's AI4-12 citation (§5.8 size row: several disjoint reservation batches per account minute, each one movement), which matches F3-04 and F3-19 as verified in review 24. F3-20 is now backed by the provider: RFC-005 C12 rev 5 names the bucket in `kept(bucket)`, the first put's for a repeated `record_id` |
| V-1 | Verified | §5.5 `C > E` row: "M23: each supplier paid up to its share of `C` less what it already holds". Following paragraph restated, stale interface sentence replaced by "as RFC-004's M12, M13 (sequence 0) and M23 references carry it". R3-20: "None: M23 … never re-paid". §9 cost-line test: "nothing to B and C, A repaid its 1,500 (M23)". Re-traced: 10,000 → 5,000 (Share cause, nothing posted) → 10,000 gives B 0, as RFC-004 M23 |
| V-2 | Verified | §3.3 step 2: the kept answer names the bucket, the first put's for a repeat, and the entry records the bucket the store names. RFC-005 C12 rev 5 now promises it, so the interface point is closed |
| V-3 | Verified | R3-13: 258 s |

### Rebase and interfaces

| Item | Result | Notes (re-trace) |
|---|---|---|
| RQ3-17 (v1.9) | Verified | Requirements issues row marked resolved with the restriction reading. §3.3 opening paragraph, §1.1 and the §7 ingestion row: identity, keyed digest and reason always; payload only in the erasable store, if kept; dropped beyond caps or when not taken in time; counted and reported. Matches POL-19 v1.9 and review 28 decision 6 (caps are design parameters) |
| P3-S71 (reworded) | Verified, with **W-1** | Steps 1 to 3 keep identity, keyed digest and reason and nothing more; "if kept" only in the store; expiry and erasure unchanged. §9 non-conforming-payload test retained. W-1 is the one path that records no keyed digest |
| P3-S75 (new) | Verified, with **W-1** | Both Examples rows map to keep outcomes: cap (count, byte or 64 KB size) gives `not kept(cap)` and "dropped: cap". The store not in time gives `not kept(late)` and "dropped: not taken in time", or no answer and "unanswered, withdrawal pending" followed by `withdraw_payload`. Counting is derived from `batch` entries. Re-traced the crash points: a takeover before the hour's `drop-count` rebuilds the counters from the checkpoint plus later `batch` entries and checks the log before writing (one per exporter and hour). The "no batch of the hour after its `drop-count`" argument holds because commit timestamps are monotone per partition and the hour is the commit hour. A takeover before a withdrawal is answered rebuilds the pending set from `batch` entries without a `withdrawn` entry. The interim existence of a lost-answer item until the withdrawal is answered is stated as R3-21, as the coordinator's AI3-15 accepts. §9 drop test covers 50/s over the cap, 70 KB, a stalled store, a lost answer and a takeover at the hour's end |
| `keep_by` arithmetic | Verified | `keep_by` = issue + 500 − 100 = issue + 400 ms. The store commits only at a timestamp ≤ issue + 300 ms. The caller stops at `keep_by` + ε = issue + 500 ms = `pd_put_timeout`, inside the 1 s acknowledgement (X2-N4). §3.3 step 2 table, step 3 and §8 agree. A put whose transaction runs past its timestamp is closed by the withdrawal, because the withdrawal's serialisable read pushes it above `keep_by` − ε, where it fails |
| RFC-005 rev 5 C12 | Verified, with nit **W-2** | Signature `put_payload(record_id, exporter, supplier, account?, received_at, keep_by, payload) → kept(bucket) \| not kept(cap) \| not kept(late)`. `withdraw_payload(record_id) → withdrawn(was kept \| was absent)` with tombstone to the receipt day's expiry. Byte caps of 256 KB/s per exporter and 4 MB/s overall, 64 KB a payload. `digest_key(exporter) → (version, key)`. These are identical in §3.3, §7 (Personal-data store and Key service rows), §8 and §1.2 to RFC-005 §3.7 and C12. The `late-kept` interim is gone (no occurrence). W-2: the header's "Builds on" still cites revision 4 |
| RFC-000 4.3 AI3-14 | Verified | Architecture issues row resolved. §1.1 and §3.3 cite §8's names ("no template", "unparseable"). The §8 erratum for `keep_by` and `withdraw_payload` is correctly marked pending under RFC-005's AI-R5-6 |
| RFC-000 4.3 AI-26-2, AI-27-3, AI4-12, B-AI-11 | Verified | AI-26-2: cut events carry (link, reduction), the target as minute pieces or `none`, and the part rates (§5.1, §5.2, §7 lifecycle row), and `hold_2` waits for the applied target (§5.6 table). AI-27-3: per-destination markers only (§1.1, §4.2, §5.6, §6.4, §7). AI4-12: §5.8 and §7 charge-line row. B-AI-11: §6.2, §6.4, §7 catalogue row |
| RFC-006 rev 4 | Verified | `ingest_log` self-outboxed with three named streams (§3.4, §7). Slot groups are stage B *i* with rating *i* (§7 substrate row) |

### Defects

| # | Severity | Location | Failure | Fix |
|---|---|---|---|---|
| W-1 | Minor (requirements; local edit) | §3.3 step 1, last sentences: "A fetch that fails leaves the batch waiting at most `pd_put_timeout`, then the payload is rejected with identity and reason, digest marked unavailable, alerted" | This path records **no keyed digest**, but P3-S71 and P3-S75 require the record kept of every non-conforming payload to hold "its identity, its keyed digest and the reason". It also leaves `record_id` undefined, because `record_id` contains the digest, so no put is possible. Nor is it any of step 3's four keep outcomes, so step 6's count from `batch` entries misses it, against P3-S75 "counted … and reported". It is reachable after every takeover, because the cache is memory-only and a new lease holder fetches on first use | Make the digest mandatory. (a) Fetch the current version for each exporter of the slot when the lease is taken. At a rotation, keep signing with the cached version until the new one is fetched (old versions stay valid for 7 years, RFC-005 §10). (b) If no version is cached and the fetch fails, do not commit or acknowledge that batch: the exporter retransmits it verbatim (§3.1), the wait is alerted, and only that exporter partition waits until the key service answers. Add a crash row "key service unavailable at first use" and a risk row. If the coordinator prefers ingestion never to wait, the alternative is a fifth keep outcome "dropped: digest unavailable", counted in `drop-count` and raised as an RQ against P3-S71 and P3-S75 |
| W-2 | Nit | Header, "Builds on" row: "The personal-data store's interface is RFC-005 revision 4's (C12, `put_payload` with the exporter, …, as RFC-000 4.3 §8 states it)" | Stale. §3.3, §7 and the Revision 5 resolution rely on RFC-005 **revision 5** C12 (`keep_by`, `not kept(late)`, `withdraw_payload`, byte caps, `digest_key`), which goes beyond RFC-000 4.3 §8 (erratum pending, AI-R5-6) | "The personal-data store's and digest key's interface is RFC-005 revision 5's (C12: `put_payload` with the exporter and `keep_by`, `not kept(cap \| late)`, `withdraw_payload`, `digest_key`; RFC-000 §8 erratum pending under AI-R5-6)" |
| W-3 | Nit | §3.3 crash table, row "After the commit, before the acknowledgement": "a repeated put, answered with the first bucket" | Correct only if the first put was kept. After a withdrawal, RFC-005 C12 answers a tombstoned `record_id` with `not kept(late)`, and after a cap drop the repeat is a new decision | "a repeated put, answered as the store now holds it (kept with the first bucket; `not kept(late)` once withdrawn), and recorded with that outcome" |

Note for the coordinator (not an RFC-003 defect): RFC-005 §3.7's `withdraw_payload` row
names the caller's record "**not kept: store unavailable**", while RFC-003 §3.3 and §3.4 name
it "dropped: unanswered, withdrawal pending". The semantics agree: no answer by `keep_by` + ε.
RFC-005 should adopt RFC-003's label at its next edit. RFC-000 §8 still carries the
4.3 signature without `keep_by` or `withdraw_payload` (AI-R5-6, pending).
