# 63. Fix verification: C06 Usage and charges (draft 4), focus money

| | |
|---|---|
| Artefact | `docs/04-delivery/contracts/C06-usage-and-charges.md`, version 1, draft 4 (commit 8bd8a1b) |
| Review record | [55](55-contract-C06-review.md): M1 … M9, m1 … m17, D5 … D7; plus the coordinator's C05 v1 `LedgerPosition` row |
| Mode, focus | Fix verification; money. Cross-check against frozen C05 v1 (`LogPosition`, `LedgerPosition`, `usage_applied_since`, dedup keys, F2/F3 inputs) |
| Pinned against | `requirements-v1.10` (specs unchanged in the worktree); RFC-000 rev. 4.4 §8; RFC-003 rev. 5 + 5.1; RFC-004 rev. 5 + 5.1 (§A2, §A3, §A4 F1, §A6, §B1.3); RFC-002 rev. 5; C05 v1 (frozen) |
| Tools | `check_specs.py`: no problems (473 scenarios). `impact.py coverage C06`: `KeyError: 'C06'` (the tool takes slices, not contracts). Every scenario ID C06 cites exists exactly once at v1.10 |

## Verification

### Verdict

**ACCEPT WITH CHANGES.** All nine Majors, all 17 Minors, D5 … D7 and the coordinator's
`LedgerPosition` row are present, and they do not break a review-44 resolution. Seven
defects remain; each is listed below with its fix. One (V63-4) is a
money defect in D5's `abandon` path, and its fix needs an orchestrator choice. The other six
are precise local edits of a few lines each, so the orchestrator can apply them directly.

### Figures recomputed

| Figure | Recomputed | Result |
|---|---|---|
| Price encoding | 1.5 µUSD = 1.5 × 10⁶ pUSD → `"1500000"` | OK |
| CT-R5 (P3-S37) | 0.2 GB × 10,000 = 2,000 | OK |
| Λ, span | 180 + 60 + 60 + 10 + 60 + 60 = 430 s; back 430 − 60 = 370 s; ahead 60 s. `rto_adm` is now a constant (D6); the sum is unchanged | OK |
| CT-C4 | 100 Mbps × 430 s = 43,000 Mb = 5.375 GB × 10,000 = 53,750; + 2,000 = 55,750 | OK |
| Cap decrease + edge (m6) | Old cap in span while `ts − 370 < effectiveFrom` → `effectiveFrom + 370`; edge late ≤ 60 s → traffic at the old cap until `effectiveFrom + 60`, in the bound until `+ 60 + 370 = + 430 s` | OK (CT-C4 "430 s") |
| CT-R6 / CT-L2 (P4-S117) | Σw = 10,000. split(1,500) = 450 / 499.95 / 325.05 / 225 → 450/500/325/225; split(900) = 270 / 299.97 / 195.03 / 135 → 270/300/195/135; Δ = −180/−200/−130/−90, Σ −600; `B:b1 +600` | OK; names fixed (m16) |
| C06-M9 | −split(600) = −(180 / 199.98 / 130.02 / 90) → −180/−200/−130/−90 | OK |
| Usage budget | 60 + 180 + 15 = 255 → 45 s left; 60 + 180 + 45 = 285 → 15 s left; 2 + 0.05 + 0.06 + 0.05 + 0.06 + 0.2 = 2.42 ≈ 2.5 s; 15 − 2.5 = 12.5 ("about 12 s") | OK, est. |
| m15 | ⌈17,000 / 5,000⌉ = 4 cycles × 2.5 s = 10 s (≤ 45 s typical; 10 of 15 s at the hard bound) | OK, est. |
| Reservation posting | 1 M / 5,000 = 200 batches; 200 / 8 × 0.2 s = 5 s (contract says ≈ 10 s, conservative); 120 − 5 − 10 = 105 ("about 100 s") | OK, est. |
| Freshness (m13) | `effectiveFrom ≥ ceil_min(announcedAt + 60)` ⇒ `announcedAt ≤ effectiveFrom − 60 ≤ T − 60 ≤ resolvedTs` when the cache is within 60 s | OK |

### C05 v1 consistency

| Item | C05 v1 | C06 draft 4 | Result |
|---|---|---|---|
| `UsageApplied.entry` | `LogPosition { partition: AccountId; sequence: bigint }` (l. 95) | Imported unchanged; JSON `sequence` as a decimal string (l. 63, 110, 227) | Match |
| `LedgerPosition` | `{ ledgerPartition: string; sequence: bigint; commitTs }` (l. 99) | `{ ledgerPartition; sequence: Seq; commitTs: DbTs }` (l. 118–122). No `partition`/`seq` left on a ledger position | Match |
| Rating dedup key | (account, `appliedThrough`) (l. 662, 680) | Same (l. 232, 601, 913) | Match |
| Gap recovery | Replay, then `usage_applied_since { accountPartition, afterStreamSeq }` (l. 473–476) | Same names (l. 234, 606, 1021) | Match |
| F2 `Δ_b` | `inFlight?: { batch; reduction: Micros }`: **one** reduction (l. 296) | `usageReduction` **per product** (l. 207) | **Mismatch**, V63-7 |
| F3 input | `rtoAdm: Millis` per product (l. 300) | No `rtoAdm` source; it is a constant (D6) | **Gap**, V63-7 |

### Findings

| ID | Status | Note |
|---|---|---|
| M1 | Verified | The port line has `lineKind`, `payer`, `payee`, `reason`, `cause`, `lateCut`, `triggerRef` (l. 353–360). They are stored, compared (l. 782–789) and published (l. 405–410). The cold re-rate reads `triggerRef` (l. 851–853). CT-L5 (cause conflict) and CT-L7 are extended. `amount` is in the compared set but not on the port; it is `newTotal − priorTotal`, so this is acceptable |
| M2 | Verified | Order stated (l. 780–799). A redelivered amendment is found by its `SourceRef` (which has `seq`) before the sequence and `priorTotal` checks. CT-L4(1) has the amendment case |
| M3 | Verified, with V63-1 | A reservation batch with a settlement exclusion now posts. But the port's `lineCount` is defined so that the check cannot fail (V63-1) |
| M4 | Verified, with V63-2 | The committed case is correct (l. 915, `integrityAlert`, CT-L5). The uncommitted case can stall an account forever (V63-2) |
| M5 / D5 | Verified, with V63-4, V63-5 | Movement-level refusals are held, not parked (l. 810–814). `resolve_parked` is defined (§13, l. 751–757, CT-R12). `abandon` does not release the funds hold of a fee or a reservation original (V63-4). `re_emit` of a reservation original has no valid batch (V63-5) |
| M6 / D7 | Verified | One writer for `catalogue.v1` (l. 74, 494). No link rows, no account designation (l. 174–175). One relayed owner kind for each topic with markers (l. 88–89). CT-C6 |
| M7 / D6 | Verified | Deployment only (l. 503–506, 927). No role split. `rtoAdmS` removed; the two 60 s terms are constants (l. 544–546). See V63-7 for C05's `rtoAdm` field |
| M8 | Verified | Holds for each account, offset at the low-water mark, restart safe by dedup (l. 821–828). It covers `overloaded` and movement-level refusals. CT-L9. Rating re-sends unacknowledged batches (l. 893), so the 3-day retention does not lose a long-held batch |
| M9 | Verified | See the C05 table |
| C05 `LedgerPosition` | Verified | See the C05 table |
| m1 | Verified | l. 330–331, 710–712 |
| m2 | Verified, with V63-3 | Per-line `problem` (l. 376). "A reservation batch over `L` is refused whole and split again" is stated (l. 627–628, CT-L3), but no rule produces its acknowledgement (V63-3) |
| m3 | Verified | l. 728–731. Every re-based restatement has a mapping row: upward `re_rate` M6/M7, downward `re_rate` cause share M8, cost lines M23 |
| m4 | Verified, with V63-6 | The coverage list omits the reservation **original** (V63-6) |
| m5 | Verified | l. 269, 647–649, 668, CT-R13 |
| m6 | Verified | l. 555–560, 945, CT-C4 |
| m7 | Verified | l. 167, 539–540, CT-C4 |
| m8 | Verified | `policyVersion` (l. 168); tie rule (l. 151, 518–519); CT-R2 |
| m9 | Verified | `link` and `link_rules` are gone; AI-55-1 |
| m10 | Verified | l. 79 "No", l. 1213–1214 |
| m11 | Verified | l. 93–95, 840, 897, 909, CT-L7 |
| m12 | Verified | `rating.affected-marks.v1`, 7 days, reporting (l. 78, 700–702) |
| m13 | Verified | l. 530–531 |
| m14 | Verified | l. 561–563 |
| m15 | Verified | l. 952 |
| m16 | Verified | CT-L2 |
| m17 | Verified | l. 434, 444, 861–862 |

### Defects

| ID | Severity | Location | Failure | Fix |
|---|---|---|---|---|
| V63-1 | Minor (money) | §8 `batch.lineCount` comment (l. 348); Validation (l. 777–779); CT-L4(4) | "The number of lines that settlement sends in this request" makes `lines.length = lineCount` true by definition. The ledger can no longer catch a settlement defect that drops a line from a usage batch. That batch commits `whole`, F1 reports `b`, and F2 subtracts the `Δ_b` that includes the dropped (unposted) line. Headroom is then overstated by that line's amount, which breaks the exactness that F01/D1 protect | Define the port value as **rating's `batch.lineCount` minus the number of lines that settlement excluded** (zero for a usage batch). Settlement copies it from the `ChargeLineBatch`; it never counts what it sends. Keep `lines.length = lineCount`. CT-L4(4): settlement that drops a usage line is refused `invalid` |
| V63-2 | Minor | Idempotency row `ChargeLineBatch`/movement, "not committed" case (l. 915); CT-L5; RFC-004 §B1.4 erratum (l. 1157–1158) | The ledger records `refused_batch`. Settlement crashes before it publishes the acknowledgements, and a settlement deploy changes the composition. The re-post (same `BatchId`, new digest) gets `refused`/`invalid`. That is a movement-level refusal, so it is held and retried every 30 s. But the recorded digest is permanent, so no deploy ends the hold. The account's in-flight usage batch is never acknowledged, so posting for that account stops (X2-S13) and `U` grows | For an **uncommitted** recorded answer with a different digest, return the **recorded answer** (`refused_batch` lines, or `over_limit`) with `integrityAlert: true` and an integrity alert. Nothing moved, so this is safe. Settlement publishes those acknowledgements, and rating re-emits under a new `BatchId` as usual. Change l. 915, CT-L5 and the §B1.4 erratum to match |
| V63-3 | Minor | Reservation batch over `L` (l. 627–628); Size (l. 655–659); Producers (l. 706–712); CT-L3 | Only the usage-batch size check says that settlement acknowledges each line `batch_over_limit`. For a reservation batch, the ledger's `over_limit` is a movement-level `refused`. It is not in the held list (l. 810–811), and no rule says who acknowledges the lines. So rating never learns that it must split the batch, and its reservation lines for `m + 1` wait forever | In Size: "If **any charge batch** is larger, settlement refuses it whole, posts nothing, acknowledges each line `excluded`/`batch_over_limit` directly, and sends an alert." In Producers, add `batch_over_limit` to settlement's direct acknowledgements |
| V63-4 | **Major (money)** | Exit from parking, `abandon` (l. 755–757); §13; CT-R12; RFC-004 §A3/§A6 | `abandon` removes a line from `U` only. A parked **fee** (`invalid`, for example a missing `payee`) is never posted, so no F1 sets `fee_state_r = charged`. RFC-004 §A2/§A3 releases a fee hold only that way, so `fee_due` is held forever. A parked **reservation original** is never posted, so `p_r` stops at that minute (the watermark with exceptions, RFC-004 §B1 l. 995), and `cov(p_r, …)` (Draining included) keeps that minute held forever. Both break D5 ("buyers are never left with permanently reduced headroom") | The orchestrator must choose. **Recommended:** `abandon` is executed as a posting. Rating emits the line key (same `SourceRef`, next `seq`) with `payer: share`, reason `re_rate`, and `triggerRef` = `actionId`, and settlement maps it to a Share-borne movement (M11 for fee kinds; a cause-share M8-style row for reservation and usage lines). The ledger records the key, so F1 sets `charged` or advances `p_r`, and the `posted` acknowledgement removes the line from `U`. This also gives reconciliation a movement to close. **Alternative:** add an account-owner input that releases the hold on an abandon. That is an RFC-002/RFC-004 change and a C05 erratum |
| V63-5 | Minor | `re_emit` (l. 753–754); originals in increasing minutes (l. 645) | `re_emit` puts every parked line "into the next usage batches". A reservation original (seq 0, `original`) maps only to M4 "one per reservation batch". In a usage batch it is invalid and is parked again. Its minute is also out of order after later minutes have posted | "`re_emit`: a parked reservation original goes in its own reservation batch (new `BatchId`), as an exception to the increasing-minute rule; every other line goes in the next usage batches, in sequence." Add the case to CT-R12 |
| V63-6 | Minor | Headroom coverage of parked lines (l. 745–750) | The list omits the reservation original, which is the line kind that a reservation batch can exclude as `invalid` | Add: "a reservation original stays in the reservation hold, because `p_r` does not pass an unposted minute (RFC-004 §A3, §A6)" |
| V63-7 | Minor (cross-contract) | Consumer obligations; Upstream issues; C05 v1 l. 296, 300 | Frozen C05's F2 carries one `reduction`, but C06's `Δ_b` is per product, and `U[product] = U(X) − Δ_b` needs it per product. With two usage products in one batch, C05 cannot record the figure exactly. Separately, C05's F3 input `rtoAdm` has no catalogue source after D6 | Add a C05 erratum row under Consumer obligations: (a) F2 `inFlight: { batch; reductions: { product; reduction }[] }`, from C06's `usageReduction`; (b) the account owner fills F3 `rtoAdm` with the formula constant 60,000 ms (or C05 removes the field). C05's status line already lists errata owed, so this is an erratum, not a re-freeze |

Nit (no verdict effect): CT-L1 cites P4-S41, P4-S42 and P4-S89, which are missing from
"Scenarios relied on". Add them.

### Local-edit note

V63-1, V63-2, V63-3, V63-5, V63-6 and V63-7 are precise local edits (a few lines each, plus
matching CT and erratum lines). The orchestrator may apply them directly. V63-4 needs a
decision (recommended option above). After that decision, its text is about five lines in
"Exit from parking", one mapping row, and CT-R12. A further full round is not needed.
