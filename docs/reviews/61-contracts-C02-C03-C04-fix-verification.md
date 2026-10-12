# Review 61. Joint fix verification of C02 draft.3, C03 v2.3 and C04 v2.2

| | |
|---|---|
| Under review | [C02](../04-delivery/contracts/C02-link-hold.md) 1.0.0-draft.3 ("Review 54 resolution"); [C03](../04-delivery/contracts/C03-link-schedule.md) v2.3 ("Review 52 resolution", incl. the review 58 N-03 and C02 draft.3 rows); [C04](../04-delivery/contracts/C04-reservation-feeds.md) v2.2 ("Review 58 resolution") |
| Review records | [Review 54](54-contract-C02-review.md) (B1, M1 … M5, m1 … m8, D1 … D5); [review 52](52-contract-C03-fix-verification.md) (V52-1 … V52-4); [review 58](58-contract-C04-review.md) (N-01 … N-12, D58-1 … D58-4) |
| Authority | `requirements-v1.10` (P1-S78, P1-S84, P2-S43, P2-S44, P2-S48, P2-S94, P4-S117); RFC-000 rev. 4.4 §8 and C4-1 … C4-7; RFC-001 … RFC-003 rev. 5 (contract sections only, as cited by the reviews) |
| Binding inputs | Orchestrator: contracts freeze with RFC errata owed. C02's "not tagged until the RFCs cite P1-S84" gate (review 54 m8) is overridden |
| Focus | Concurrency and money; the four shared rules stated alike in all three contracts |
| Tools | `python3 tools/impact.py coverage S-LINK`: primary 84, uncited 1 (P1-S84), dangling 0. `coverage S-MONEY`: primary 118, uncited 2 (P4-S117, P4-S118), dangling 0. Both unchanged; the citations are RFC errata owed (allowed by the binding input). `tools/check_specs.py`: NO PROBLEMS (473 scenarios) |

## Verification

### Shared rules across the three contracts

| Rule | C02 draft.3 | C03 v2.3 | C04 v2.2 | Result |
|---|---|---|---|---|
| Revision rule: higher revision always writes a cut (`APPLIED(none)` included); lower or equal writes nothing, never supersedes; repeat → recorded reply, never-recorded lower → highest recorded reply echoing its own revision; release at highest applied revision | "Revisions (C4-2, R39-01, V52-1)", case table rows 1–4, Idempotency `cut_target`, Settled C4-2 | Rule 3 (verbatim V52-1 text), rule 3 `hold_2` release, `CUT_DECIDED` idempotency row | "Cut" (Higher / Lower or equal revisions), "Releasing `hold_2`", Idempotency `cut`, PL-3, CR-2 | **Same rule, verbatim** in the operative text. Stale copies remain in C03's Status RFC-002 erratum and CT-3.3 (V61-3) |
| Covered parts fixed at revision 1; later revisions only drop ended parts; adding a part → `MISMATCH` | "Covered parts (review 54 M4, D4)", `CutTargetCmd.parts`, case table row 3, Settled D4 | Rule 3 "Covered parts", schema l. 239–240, `CUT_DECIDED` row, idempotency row, PT-6, Status (vii) | "Covered parts", `Cut.covered_parts` | **Equivalent.** "Covered parts changed" is gone from every operative C03 passage (the Review 39 resolution row R39-01 keeps it as history) |
| Offer-scoped target on a Final offer, link on the new path → normal cut from `max(t_eff, move_at)` | Two "offer Final" case-table rows plus the "together" sentence; Settled V52-2/D5 | Rule 5 sub-bullet "Offer-scoped target for a Final offer"; CT-3.7; Status RFC-002 and C02/C04 errata | "Offer-scoped targets (N-03)", entry table, `OfferCutKept`, "Move and cuts", PL-3, PL-4 | **Equivalent** in substance. Wording residues: C02's `move_at ≤ T_eff` row lacks "this link on the new path" and overlaps the "Final to another path" row; C03 rule 5's main parenthetical still says "Final with `move_at ≤ T_eff`" (V61-4) |
| Per-(reservation, leg) one outstanding command: `convert`, `offer_accept`, then `end_leg`/`reduce_parts`/`offer_move_at` by change id | "Leg-command sequencing", link hold port rows, "Leg-command replies", Settled C4-3 | Not restated (C03 is the feed; its P1-S84 row orders `offer_accept` → `reduce_parts`, consistent) | Not restated (account-owner entries, not leg commands) | Owned by C02 alone, not contradicted. **But C02's ordering of a `convert` against a lower-id leg change is wrong (V61-1)** |

### Per finding

| ID | Result | Notes |
|---|---|---|
| **Review 54 (C02)** | | |
| B1 | **Defect (V61-1)** | Present: sequence, `offer_move_at.changeId`, takeover order, `clippedAt` backstop, tests consumer 3 / provider 7 / joint. Re-traced P2-S43 (confirm, then cancel, `convert` → `MOVING`): `end_leg` waits for `CONVERTED`; L ends p1 at 10:01. Holds. P2-S94 row 2 and P2-S44: shorten waits for p3's `convert`; p3 ends at 12:00. Holds. P2-S48: `reduce_parts(p3)` waits for `CONVERTED`. Holds. `offer_move_at` waits for `ACCEPTED`. Holds. **Fails** for an added part whose E5 is *above* an applied `end_leg` (shorten, then extend): see V61-1 |
| M1 | Verified | Reply table covers every `LegChangeReply`, `ConvertReply` and `OfferReply` variant; retry only for routing refusals / no reply; unreachable M3 branch removed. No queue can stall |
| M2 | Verified | Link rule order (applied id → recorded reply; above → apply; lower never-applied → `STALE_CHANGE`); idempotency row matches; post-takeover `STALE_CHANGE` logged, unexplained one alerted. Re-traced review 54's E11a/E11b takeover: E11a re-send gets recorded `CHANGED`, no page |
| M3 | Verified | Refusal recorded with mark set raises a new claim; tests cover "mark, then refuse" |
| M4 | Verified | See shared-rules table. Re-traced review 54's example: rev 2 adding p3 → `MISMATCH`, nothing written; p3 (converted after `T_eff`) is never covered. See V61-5 for one clarification on "ended" |
| M5 | Verified, with V61-4 wording | Both rows give E11 *cut* → `APPLIED`; C04 and C03 now match (N-03) |
| m1 – m7 | Verified | m1 port invariant; m2 E3 records claim; m3 per-item envelope and reply; m4 check (0); m5 errata (c)–(f); m6 verbatim text; m7 `MISMATCH` counts for `REDUCTION_FINAL` |
| m8 | **Superseded (V61-2)** | Overridden by the orchestrator: freeze with RFC errata owed. Status and Scenarios still state the gate |
| **Review 52 (C03)** | | |
| V52-1 | Verified, with V61-3 | Rule 3 carries the exact text; C02 and C04 carry it. Residue: Status RFC-002 erratum and CT-3.3 keep the pre-V52-1 wording |
| V52-2 | Verified (superseded by N-03) | All three now use "Final, link on the new path, from `max(t_eff, move_at)`" |
| V52-3 | Verified | 200 B budget, `notice_id` dropped, PT-9 size check, fallback 20 + 35 + 5 s |
| V52-4 | Verified in C03; **defect in C04 (V61-6)** | CT-3.4 and rule 5 agree on "(link, reduction) and the target revision"; C04's "Late extension" bullet still keys by the extension chunk |
| Review 58 N-03 (C03 side) | Verified, with V61-4 | Rule 5 sub-bullet and CT-3.7 |
| **Review 58 (C04)** | | |
| N-01 | Verified | Notifier keeps every marker by (slot, epoch, `reportPosition`, `chunk.part`); monotone drop only for the gate; `gap_timeout` → outbox/history → send (D58-1); C01 and AI-58-1 errata |
| N-02 | Verified | Same-slot chain; only an acquisition lists everything; PO-3 `adopt` case |
| N-03 | Verified | Re-traced review 58 trace 5 (`move_at` = `t_eff` + 5 min, target after the move's entry): E11 *cut* from `move_at`, C02 `APPLIED`, C04 `cut`, C03 rule 5 amends closed minutes (offer-scoped → no `hold_2`, rule 4). Rating no longer bills the uncut rate. PL-4 case present |
| N-04 … N-12 | Verified | As the resolution table states (N-04 `target_version`; N-05 one shown fee per leg; N-06 POL-08 fees only; N-07 least `ended.effective`; N-08 retry to answer; N-09 derived identity; N-10 transient not recorded; N-11 notice kinds; N-12 5,000-id chunks) |

### Scenario traces

- **P1-S78.** Row 1: the confirm does not see the displacement record; E5 commits;
  `convert` is first in its leg's sequence, so not delayed by B1's rule; the link flags
  the part, alerts `CONFIRMED_AFTER_REDUCTION`. Row 2: rejected for no fit. Holds.
- **P1-S84.** Row 1 (accept D+29, `move_at` ≤ `T_eff`): targets are decided at the
  `ReductionEffective` entry, after E13 final, so L's target gets `NOT_APPLIED(left_link)`
  (C02), `cut` `left_link` (C04), and `hold_2` releases on it (C03). Row 2 (accept D+32):
  `moved` carries the 2 Mbps cut rate with `applies`; on each new leg `offer_accept` →
  `ACCEPTED` → `reduce_parts`; C03 emits `LEG_CONFIRMED` then `LEG_CHANGED`; the held
  2 Mbps are freed at `move_at`. Holds. Offer-scoped variant (reduced link on the offer
  path, Final before the target): N-03 rule, holds.
- **P2-S43, P2-S44, P2-S48, P2-S94 (both rows).** Hold as stated in B1 above, except the
  shorten-then-extend ordering (V61-1).
- **P4-S117.** A late cut (extension member, or offer-scoped on a Final offer) on closed
  minutes: C03 rule 5 and C04 CR-3 amend down with "late POL-07 cut"; not a correction.
  Holds in C03; C04's amendment key is stale (V61-6).

### Defects and fixes

- **V61-1 (Major; money and concurrency; C02 "Leg-command sequencing" items 1–3,
  "Additional rules", "After a takeover"; link hold port `convert` backstop; `ConvertCmd`;
  Settled C4-3).** A part added by a change whose E5 is **above** a leg's `end_leg` is
  destroyed. Trace (shorten, then extend; an AI agent):
  1. E11 seq 100 shortens R to 12:00; `end_leg(L, from 12:00)` → `CHANGED`.
  2. E5 seq 105 extends R to 20:00, adding p3 `[12:00, 20:00)`; `convert(p3)` is sent
     after that `CHANGED`, as the rule requires.
  3. The backstop fires ("the leg already has an applied `end_leg`"): p3 is clipped to
     12:00, i.e. empty, and `CONVERT_AFTER_END` is alerted.
  4. L counts nothing for R on `[12:00, 20:00)` and can sell it to another buyer
     (oversell), while the account owner and rating charge R for 4 Mbps.

  The takeover order fails the same way the other way round: with E11 100 still without
  E12 and `convert(p3)` pending, "pending `convert`s first" creates p3, and the re-sent
  `end_leg(from 12:00)` then ends "every part of the leg", p3 included.
  *Fix (a few lines):*
  - Order every leg command by its deciding entry's sequence: a `convert` takes the
    position of the E5 that created the part; `offer_accept` that of its E13 final;
    leg changes their change id. Replace items 1–3 and "Additional rules" bullet 1 by this
    rule, and use the same order after a takeover (not "pending `convert`s first").
  - `ConvertCmd` gains `createdBy: ChangeId` (the E5's (account partition, sequence)).
  - Backstop: clip only when an applied `end_leg` has a change id **above** `createdBy`.
  - Settled C4-3 row and a joint test "shorten, then extend: L holds p3 `[12:00, 20:00)`",
    also across a takeover.
- **V61-2 (Minor; C02 Status, "Pinned to", Scenarios POL-07 bullet, Settled V52-2 row).**
  Replace the m8 freeze gate with "freezes with RFC errata owed: RFC-001 and RFC-002 cite
  P1-S84 (orchestrator)". Update "C03 v2.1 and C04 v2" to "C03 v2.3 and C04 v2.2". Mark
  the C04 and C03 errata in the Settled V52-2/D5 and D4 rows as applied.
- **V61-3 (Minor; C03 Status RFC-002 erratum; CT-3.3 "Stale arrival").** Both keep the
  wording V52-1 (1) replaced. Status: replace "a revision at or below the highest recorded
  answered with its recorded answer and writing nothing" with rule 3's text ("a repeat of
  a recorded (key, revision) answered with its recorded reply; a lower revision never
  recorded answered with the highest recorded revision's reply, echoing its own revision;
  neither writes an entry or a `cut`, neither ever supersedes"). CT-3.3: "RFC-002 answers
  with revision 2's reply, echoing revision 1, and writes nothing". Also update "to be
  tagged only once C02 and C04 carry the same revision rule" and "Status stays Draft until
  …": they now do.
- **V61-4 (Minor; C02 case-table row "`offer` set, offer Final, `move_at ≤ T_eff`"; C03
  rule 5 main parenthetical).** C02: add "with this link on the new path" to that row, so
  it no longer overlaps the "Final to another path" row. C03: replace "because the offer
  was Final with `move_at ≤ T_eff`" with "because the offer was Final with the link on
  the new path". Optionally mark the C03 Review 39 resolution rows R39-01 and R39-03 as
  "superseded by v2.3 / N-03".
- **V61-5 (Minor; money; covered-parts rule in C02, C03 rule 3, C04 "Covered parts").**
  "Ended" is undefined. If a part with an applied end after `t_eff` (e.g. shortened to
  12:00, `t_eff` 11:00) is dropped from revision 2, a "targets in force" composition
  (C02) could unbind it for `[11:00, 12:00)` and raise its rate. Add to all three: "A part
  is ended when it has no minute at or after the revision's first piece. Dropping it
  never raises its rate: the recorded target keeps binding it to its end." (C04's
  `target` = per-minute `min` over every revision already implies this.)
- **V61-6 (Minor; money; C04 "Effective-time closure", "Late extension" bullet).** It
  still keys the amendment by "the extension chunk from C03's `REDUCTION_EFFECTIVE`",
  while C03 rule 5 / CT-3.4 (V52-4) use "(link, reduction) and the target revision" and
  apply to **any** late lifecycle `cut`. An offer-scoped late cut (N-03) has no extension
  chunk, so its amendment has no defined key. *Fix:* rename the bullet "Late cuts", say
  "any `cut` (or `ended(revoked)`) covering already-closed minutes", and replace "the
  extension chunk from C03's `REDUCTION_EFFECTIVE`" with "the target revision" (as CR-3
  already reads).

No earlier fix in the three resolution tables is broken by these edits. V61-1 keeps every
review 54 trace passing: each of them orders E5 before E11 by sequence.

## Verdict

**ACCEPT WITH CHANGES.** All findings of reviews 54 (C02), 52 and 58 N-03 (C03) and 58
(C04) are applied; the four shared rules read alike, verbatim or equivalent, in the
operative text. Six defects: one Major (V61-1, C02 `convert` order and backstop for parts
added after a lower-id `end_leg`; oversell and overcharge) and five Minors (V61-2 to V61-6,
stale wording and pins). Every defect is a precise local edit of a few lines; the
orchestrator may apply them directly instead of another round. With them applied, C02,
C03 and C04 can be tagged together, RFC errata owed (P1-S84 and P4-S117 citations).
