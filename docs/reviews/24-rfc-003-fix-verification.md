# Review 24. Fix verification of RFC-003 revision 4 (slice S-RATE)

| | |
|---|---|
| Under review | [RFC-003](../03-rfcs/RFC-003-rating-and-metering.md), Draft, revision 4 |
| Against | [Review 19](19-rfc-003-review.md) (F3-01 … F3-20, D-19-1 … D-19-8, RQ-19-1 … RQ-19-5, AI-19-1, AI-19-2) |
| Authority | Requirements at tag `requirements-v1.8` (POL-08, POL-14, POL-23; P3-S63, P3-S74; P4-S115, P4-S116); [RFC-000](../03-rfcs/RFC-000-architecture.md) revision 4.2 (§6, §8, Revision 4.2 errata AI-19-1, AI-19-2) |
| Consumed contracts read | RFC-004 rev 4: F2, `LB` (§A3), M4, M12, M13, M23, batch kinds, movement limit, posting port, movement feed; RFC-005 rev 4 C12 (`put_payload`) |
| Scope | Only the passages each finding names, plus the authority they rely on. No re-review |
| Tools | `impact.py coverage S-RATE`: primary 74 (P3-S74 added by v1.8), uncited 0, dangling 0 |

## Verification

**Verdict: ACCEPT WITH CHANGES.** All 20 findings are present and correct against v1.8 and
RFC-000 4.2. Two defects remain, plus one nit. All are precise local edits, so the
orchestrator may apply them directly without another round.

### Per finding

| ID | Result | Notes (re-trace) |
|---|---|---|
| F3-01 | Verified, with **V-1** | §5.5 "Amending a cost line": upward pays the increment, a downward amendment from a supplier's own exporter is that supplier's debt (P4-S116 row 2: 3,000 − 1,500 = 1,500), any other downward amendment posts nothing (P4-S116 row 1). The source reference has an amendment sequence (§5.8). Re-traced the review's P3-S41 path: 10,000 → 5,000 by a `usage_price` correction posts nothing. Suppliers are not debited. **But** the "later rise" rule disagrees with RFC-004's M23 (V-1) |
| F3-02 | Verified | §5.5 dearer path: the difference is taken against the price as booked (rules 1 to 3, no correction). A correction of the buyer's price amends only the buyer's line. Re-traced P4-S115: buyer 4 → 3, difference stays 8 − 4 = 4, no supplier paid again. The review's 400-for-300 trace now gives 300. Matches POL-23 v1.8 and RFC-004 M13 |
| F3-03 | Verified | §5.2 rule 4 applies `min(corrected, rules 1 to 3)`. §6.3 validates against the effective price: after a move to 1.5, 1.8 is refused; after an open-ended re-price 2 → 3, 2.5 is accepted. The read model carries moves and open-endedness and uses the shared pricing module. A lagging read model is still safe by the `min` |
| F3-04 | Verified | §5.8 has two streams. Reservation batches are ungated, at most `L`, up to 8 in flight, in per-reservation minute order, and post as M4. Usage batches are at most `L`, gated when they hold a usage line, one in flight, and post whole. §5.9's exactness bullets re-trace: the only usage posting between X and P belongs to the in-flight gated usage batch, and it is posted whole, so `Δ_b` is removed exactly once. Matches RFC-000 §8 4.2 and RFC-004 batch kinds (M4 per reservation batch, usage batch never split, over-limit refused whole) |
| F3-05 | Verified | §5.4 table: a plain fee is never charged on a shorten to a later end (P3-S63 third row). A minimum-term fee is charged on a shorten inside the term. A §9 fee test row was added |
| F3-06 | Verified (D-19-2 superseded) | Follows v1.8 POL-08 and P3-S74. Booked window ends inside the term and the offer showed the fee: account charged 500,000. Fee not shown: Share-borne and alerted. An extension avoids the fee, and a fee ID is never charged twice. The §9 test covers the 10-day, 30-day, extended and shortened cases |
| F3-07 | Verified | §5.2 "Route and weights after a move", §6.1 route registration, §7 lifecycle `moved` carries the catalogue route ID. Matches RFC-000 §8 4.2 and RFC-004 M4 and M13 |
| F3-08 | Verified | Rating no longer publishes LB (§5.9, §7). The definition is RFC-004's: `Λ` = 430 s, span `[now − 370 s, now + 60 s]`. P3-S37: 100 Mbps × 430 s = 5.375 GB × 10,000 = 53,750; + 2,000 = 55,750 (recomputed). RFC-004 §A3 and test row 649 agree |
| F3-09 | Verified | §5.9 and the §7 unposted-usage row cover the attachment set and every product with a line not fully posted. A §9 test was added |
| F3-10 | Verified | §5.9: finance-attributed parts are excluded from breaches and from the X2-S22 measure. Pending-binding parts are still reported |
| F3-11 | Verified | §5.2 "Effective minutes are the lifecycle feed's": a late end takes the next boundary, the minutes stand, and accrual ends at the end entry's minute without waiting for a confirming event |
| F3-12 | Verified, with nit **V-3** | Benefits (Timeliness), §5.12 and R3-9 are aligned: about 6 s to emit and about 1 min to post (RFC-004 §B3.1). Closure waits for no owner's failover |
| F3-13 | Verified | §5.10 takes sequences and modes from the ledger, emits originals where nothing is posted, and emits one amendment per remaining trigger. RFC-004's movement feed carries the modes |
| F3-14 | Verified | §5.7 "An excluded line": `E` and the sequence are re-based on the acknowledged posted total, and the next amendment restates to `C` |
| F3-15 | Verified | §5.2 rule 3 and D-19-8: the path price is fixed, and "its price" follows the lock and notified changes. Price-step events are authoritative and are checked against `oe_effective` |
| F3-16 | Verified | 1 / 30 ms ≈ 33 per slot; × 128 ≈ 4,300/s; 600,000 / 4,300 ≈ 140 records (14 KB raw, 5 KB compressed). Hot exporter: 50,000 / 33 ≈ 1,500 records, 150 KB raw, about 50 KB compressed. Total 4,300 + 2,600 + 8,500 + 8,500 ≈ 24,000/s (§1.2, R3-12) |
| F3-17 | Verified | §2: 8 B per entry × 50, about 450 B, marked est. §5.11: 61 M × 450 B ≈ 27.5 GB, / 256 ≈ 107 MB per slot. 18,000 lines/s × 450 B ≈ 8 MB/s. §9 measures denominators per line (R3-19) |
| F3-18 | Verified | §2 uses `bigint` exact floors only, on close, change and publication. The interval path is gone from §9, Benefits, Competition and R3-11 |
| F3-19 | Verified | §5.8 "A very large account": 200 batches a minute, 8 in flight, about 0.2 s each, so about 5 s of posting per minute ("within about 10 s"). Usage: 17,000 lines a minute ≈ 4 batches. Matches RFC-004's transaction-size row |
| F3-20 | Verified (alternative fix), with **V-2** | `record_id` now includes the identity or raw reference, so identical payloads from different receipts are different items with their own receipt-day expiry. A resend reuses the first put's bucket, and the entry records the bucket the store names. Works only if the store returns the bucket (V-2) |

Requirements and architecture items: RQ-19-1 … RQ-19-5 match v1.8 POL-08, POL-14 and
POL-23, and P3-S63, P3-S74, P4-S115 and P4-S116. AI-19-1 and AI-19-2 match the RFC-000 4.2
errata. Earlier resolutions (rev 2 and rev 3 tables) are not broken by any of these fixes.

### Defects

| # | Severity | Location | Failure | Fix |
|---|---|---|---|---|
| V-1 | Major (money; local edit) | §5.5 cost-line amendment table, row `C > E` ("The increment, split and paid as the original (M12 or M13)"); the paragraph after it ("so a later rise … pays only the new value above `C`" and "which settlement's M12 and M13 references must carry too (interface point for RFC-004)"); §5.8 cost row parenthetical; R3-20; §9 cost-line test "(the increment paid)" | RFC-004 rev 4 posts every cost-line amendment as **M23**: `δ_i = split(T_new)_i − paid_i`, so a party that kept its share through a non-reclaimed reduction is paid nothing until the total passes what it holds. RFC-003 describes paying the split increment above `C`. Trace (P4-S116 row 1, then a rise): E = 10,000 (B paid 3,333), lowered to 5,000 with nothing posted, then back to 10,000. RFC-003 pays B a further 1,667, so B holds 5,000 for a 10,000 line. RFC-004 pays B 0. The rating-side description pays twice, which is the outcome F3-02 and D-19-3 forbid, and R3-20 records it as an accepted risk. RFC-004 has already added the amendment sequence (M12 and M13 at sequence 0, M23), so the "interface point" is stale | Posting column for `C > E`: "M23: each supplier paid up to its share of `C` less what it already holds (RFC-004)". Paragraph: "In every case `E` becomes `C`. A later rise pays a party only above what it already holds, so no party is paid twice (RFC-004 M23)". Replace the interface-point sentence with "as RFC-004's M12, M13 (sequence 0) and M23 references carry it". Delete R3-20, or restate it as "none: M23 never re-pays". §9: "then new excess back to 10,000: nothing to B and C, A repaid its 1,500" |
| V-2 | Minor (interface; local edit) | §3.3 Put, step 2: "A kept answer names the bucket the item is in … the entry records the bucket the store names" | RFC-005 rev 4 C12 and §3.7 define `put_payload`'s answer as kept or not kept only. No bucket is returned, so the F3-20 fix depends on a field the provider does not promise | Add to §3.3: "(interface point for RFC-005 C12: the kept answer names the payload bucket the item is filed in, the first put's for a repeated `record_id`)". List it in the Revision 4 resolution row for F3-20 |
| V-3 | Nit | R3-13 "design point is about 256 s" | §5.12 now gives about 258 s (margin 42 s) | Change 256 to 258 |

Note for the coordinator (not an RFC-003 defect): RFC-000 4.2 §6 and §8 (posting port)
say "one movement per account and minute" for reservation lines. RFC-003 §5.8 and RFC-004
M4 and §B10 split a minute above the 5,000-line limit into several reservation batches.
The RFC-000 wording should say "one movement per reservation batch (an account's minute,
or a part of it at most the movement limit)" at its next errata.
