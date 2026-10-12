# Review 52. Fix verification of C03 link-schedule (version 2) against review 39

| | |
|---|---|
| Under review | [C03](../04-delivery/contracts/C03-link-schedule.md), version 2 draft (working copy), its "Review 39 resolution" table and Status errata list |
| Review record | [Review 39](39-contract-C03-review.md): R39-01 (Blocker) … R39-21, D39-1 … D39-6, RQ-39-1, AI-39-1, AI-39-2 |
| Authority | `requirements-v1.10`; RFC-000 rev. 4.4 (C4-1, C4-2); RFC-001 rev. 5 (§9 sizing rows); RFC-002 rev. 5; RFC-003 rev. 5 + erratum 5.1; RFC-006 rev. 6. Neighbour drafts read for the revision rule: [C02](../04-delivery/contracts/C02-link-hold.md) 1.0.0-draft.1 (`cut_target` section), [C04](../04-delivery/contracts/C04-reservation-feeds.md) ("Cut", "Releasing `hold_2`", Idempotency row `cut`, PL-3) |
| Tools | `python3 tools/impact.py coverage S-LINK`: primary 84, uncited 1 (P1-S84), dangling 0. `S-MONEY`: primary 118, uncited 2 (P4-S117, P4-S118), dangling 0. Unchanged from review 39, as expected: the citations are RFC errata owed (RFC-001 (xi); RFC-003 late-cut rule), and C03 now cites P1-S84 and P4-S117 itself |

## Verification

### Per finding

| ID | Result | Notes |
|---|---|---|
| R39-01 | **Defect (V52-1)** | Inside C03 the fix holds. Rule 3 releases on the highest applied revision (D39-1). Every higher revision writes a `cut`, `APPLIED(none)` included. A revision ≥ 2 is sent only when it is strictly lower somewhere or its covered parts changed. CT-3.3 covers both traces, and Trace A re-traces clean. Trace B (stale revision 1 after revision 2): rule 3 says a lower revision "is answered with its recorded answer", but in Trace B revision 1 was **never recorded** (its push failed), so there is no recorded answer to give. The neighbour drafts do **not** carry the same rule. In C02, "A lower revision received after a higher one is recorded … its reply follows the case table" sends it through the "new revision → E11, `APPLIED`" row. In C04, "One event is written for each target received … supersedes", "a repeat of a target with the same content emits nothing", and the idempotency key is (link, reduction, reservation) with no revision. As drafted, C02 + C04 still reproduce both Trace A and Trace B. C03's Status lists the C04 erratum but not C02 |
| R39-02 | Verified | `REDUCTION_FINAL` follows every `CutAnswer` and any extension caused by a withdrawn cap; `answers_recorded`; the invariant; ordering item 6; PT-6 with `NOT_APPLIED(unknown)`; RFC-001 erratum (v); AI-39-2. Re-trace: the extension after `NOT_APPLIED(unknown)` now precedes `REDUCTION_FINAL`, so M2's "seen before" sees revision 2, and rule 5 amends any closed minutes |
| R39-03 | **Defect (V52-2)** | C03 has (a), (c), PT-6 and CT-3.7, and re-traced, B is now either a member or amended. But (b) changes the account-owner semantics on the C04 feed: an offer-scoped target with a Final offer writes a lifecycle `cut`. C04 says "An offer-scoped target emits `offer_cut_kept`, never `cut`" (Cut; PL-3), and C02's case table has no "offer Final, `move_at ≤ T_eff`" row. The Status lists (b) only under RFC-002 |
| R39-04 | Verified | `of` replaced by `last` on `REDUCTION_EFFECTIVE`; rule 2, PT-6, PT-8 and the empty-set reading updated. (`REDUCTION_AFFECTED.of` remains. That is correct, because a projection run's output size is known when it is committed) |
| R39-05 | Verified | `AFFECTED_NOTICE` is the only trigger; `AFFECTED_CHANGED` comment and feed row; restoration recipients defined; CT-6.1; RFC-006 erratum listed |
| R39-06 | **Defect (V52-3)** | Split arithmetic: 15 + 40 + 5 = 60 s, correct. Hottest-link chain: 100,000 × 10 µs = 1 s; 100,000 × 200 B = 20 MB at 2 to 3 MB/s = 6.7 to 10 s; + 2 to 3 s ⇒ 9.7 to 14 s, which the contract states as "10 to 14 s"; ≤ 15 s. At 50,000: 10 MB ⇒ 3.3 to 5 s, + ≤ 1 s + 2 to 3 s = 6 to 9 s ≤ 10 s. Correct. Due-now first, PT-9 and the takeover exclusion with RQ-39-1 are present. **RFC-006's notifier erratum (40 s) is listed** in Status, and CT-6.1 tests 40 s. The defect is the **200 B per notice**, which is below review 39's own 300 B per-part row estimate. The per-reservation notice is self-contained: base (`link_id`, `feed_seq`, `log_seq`, generation, epoch, HLC `ts`), reservation, leg, `notice_id` (link + log_seq + reservation), parts with ranges, causes, `notice_due`, recipients, plus ciphertext overhead. That is at least the size of the per-part row. At 300 B the chain is 30 MB ⇒ 10 to 15 s + 1 + 2 to 3 = **13 to 19 s**, which breaks the 15 s link share |
| R39-07 | Verified | Lookup first, no re-check; check 6 above → `UNAVAILABLE`, below → `ENVELOPE_REFUSED(6)`; idempotency row; PT-3; RFC-001 erratum (i) |
| R39-08 | Verified, with V52-1/V52-2 | RFC-001 (i) … (xi), RFC-002, RFC-003 (including the "extension chunk" wording), RFC-006, C04, RFC-000 and RQ-39-1 are all listed. Still missing: C02 (V52-1) and C04 for R39-03 (b) (V52-2) |
| R39-09 | Verified | Half-open `[from, to)` |
| R39-10 | Verified | Symbol table; worked case re-checked (`A_now` 6 → 8; `L_R` = `A_p(T_eff)` = 8) |
| R39-11 | Verified | `free_from: null`, `freed_rate: 0` for fully cut or ended; a partly cut booking frees the remaining rate |
| R39-12 | Verified | CT-3.1 gap and duplicate |
| R39-13 | Verified | Stop and page, matching C04's feed rule |
| R39-14 | Verified | No new success results in v1 (D39-6) |
| R39-15 | Verified | (est.) marks; cold-rebuild give-up and safe manual retry |
| R39-16 | Verified | `sender` = component only; `STALE_SENDER` is not in `SupplyError` |
| R39-17 | Verified | `system:reduction`, `role` typed as the union |
| R39-18 | Verified | Full current set; `[]` = no longer affected |
| R39-19 | Verified | RFC-006 sections pinned directly; freeze with or after C01. `contracts.md` still lists "C03 SQL admission" (lines 31, 132, 280). C03 records this as "to be marked superseded", which is acceptable as a stated obligation |
| R39-20 | **Defect (V52-4, minor)** | The P1-S84 row, rule 7 and CT-3.8 are present. But rule 5 says the amendment carries "(link, reduction) and the target revision", while CT-3.4 tests "(link, reduction, extension)". The test and the rule name different keys |
| R39-21 | Verified | Kept, with the reason; skipped by the clear `kind` header |
| D39-1 … D39-6 | Verified | D39-1 rule 3 / M2; D39-2 `REDUCTION_FINAL` row; D39-3 feed rows; D39-4 idempotency row; D39-5 "Either side may restore"; D39-6 Versioning |

No earlier resolution was broken. M1 and M2 still read as settled, and the "Readings
adopted" are unchanged except for the `last` and `AFFECTED_NOTICE` readings, which are
consistent.

### Defects and fixes

- **V52-1 (R39-01; C03 rule 3, Status; C02 "Revisions (C4-2)" and case table; C04
  "Cut", Idempotency row `cut`, PL-3).** The revision rule is not identical across the
  three drafts, and C03's wording has no answer for a never-recorded lower revision.
  *Fix:*
  - (1) In C03 rule 3, replace "A revision at or below the highest recorded one is answered
    with its recorded answer" with "A repeat of a recorded (key, revision) is answered with
    its recorded reply. A lower revision that was never recorded is answered with the
    highest recorded revision's reply, echoing its own revision. Neither writes an entry or
    a `cut`, and neither ever supersedes."
  - (2) Add **C02** to the Status errata, with the same text.
  - (3) Apply the same text to C02's "Revisions" bullet. Replace "A lower revision received
    after a higher one is recorded …", and make the case-table row "new revision" read
    "a revision above the highest recorded".
  - (4) In C04:
    - "Cut": every revision above the highest recorded writes one `cut`, `APPLIED(none)`
      included. A revision at or below it writes nothing and never supersedes.
    - Idempotency key: (link, reduction, reservation, `target_revision`).
    - PL-3: same rule.

  Each item is a local edit of a few lines.
- **V52-2 (R39-03 (b); C03 Status; C04 "Cut" and PL-3; C02 case table).** *Fix:*
  - In the C03 Status, add R39-03 (b) under C04 and C02.
  - In C04, add "except an offer-scoped target whose offer is Final with `move_at ≤ t_eff`
    and the link on the new path: applied as a normal cut and emitted as `cut`".
  - In C02's case table, add the row "`offer` set, offer Final, `move_at ≤ T_eff` →
    E11 cause *cut* → `APPLIED`".

  Each is a one-line edit.
- **V52-3 (R39-06; Timeouts "Affected notice budget"; PT-9).** The 200 B notice size is
  unjustified and load-bearing. *Fix (keeps the accepted 15 + 40 + 5 split):*
  - State 200 B as a **budget** on the encoded, encrypted Kafka value of `AFFECTED_NOTICE`.
  - Drop `notice_id` from the payload, because it is derivable from (`link_id`, `log_seq`,
    `reservation`), already present. The notifier deduplicates on that triple.
  - Add to PT-9: "mean `AFFECTED_NOTICE` value ≤ 200 B".

  If the budget cannot be met, use 300 B and re-split to link 20 s, notifier 35 s, margin
  5 s (RFC-006 erratum 35 s). That is three lines.
- **V52-4 (R39-20/R39-03 (c); CT-3.4 vs rule 5).** *Fix:* change CT-3.4's "(link,
  reduction, extension)" to "(link, reduction) and the target revision", matching rule 5.
  That is one line.

## Verdict

**ACCEPT WITH CHANGES.** 17 findings and all 6 decisions are verified. There are 4
defects (V52-1 … V52-4), and every one is a precise local edit of a few lines in C03,
C02 and C04. The orchestrator may apply them directly instead of running another round.
`contract-C03-v1` should be tagged only together with the C02/C04 edits of V52-1 and
V52-2, because otherwise the Blocker's Trace A and Trace B remain open on the account-owner
side.
