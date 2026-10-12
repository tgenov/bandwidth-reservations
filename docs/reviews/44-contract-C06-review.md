# 44. Contract review: C06 Usage and charges (draft 2), focus money

| | |
|---|---|
| Artefact | `docs/04-delivery/contracts/C06-usage-and-charges.md`, version 1, draft 2 (C06-M1 … C06-M12 settled) |
| Mode, focus | Contract; money |
| Pinned against | `requirements-v1.10`; RFC-000 revision 4.4 §8 (Catalogue, Unposted-usage feed, Usage-applied acknowledgement, Charge-line feed, Posting acknowledgement, Quarantine and breach report feeds, Evidence query, Ledger posting port, Ledger movement feed); RFC-003 rev. 5 + erratum 5.1 (§2, §5.4 … §5.10, §6, §7, §8); RFC-004 rev. 5 + erratum 5.1 (§A3, §A4, §B1 … §B3, §B9, §B10, §B12); RFC-002 rev. 5 (§13.1, §13.2) |
| Tools | `check_specs.py`: no problems (473 scenarios). `impact.py coverage` does not take contracts; every scenario ID C06 cites was checked and exists exactly once at v1.10 |

## Verdict

**ACCEPT WITH CHANGES.** No Blocker; 10 Major, 15 Minor.

Every worked figure checks out (below). The settled points C06-M1 … C06-M12 are in the
schema, but **C06-M12 (wholeness) does not hold on every path**. Settlement's own mapping
exclusion (`movement_refused`/`invalid`) is per line. Two sequences of one line in a usage
batch have no defined meaning. Dependants of a parked line are re-emitted into a refusal
loop. Three money fields that the RFCs need are missing from the wire:
- `priorTotal`/`newTotal` on the posting port;
- the fee payee;
- per-line amounts on the movement feed.

The errata list for M12 is also incomplete. All of these are local edits; none changes the
design.

## Figures rechecked

| Figure | Recomputed | Result |
|---|---|---|
| Price encoding: 1.5 µ per Mbps-minute | 1.5 × 10⁶ pico = `"1500000"` | OK |
| CT-R5, P3-S37: 0.2 GB at 10,000 µ/GB | 2,000 µ | OK |
| Lateness window | 180 + 60 + 60 + 10 + 60 + 60 = 430 s; span 430 − 60 = 370 s back, 60 s ahead | OK |
| CT-C4: lateness bound (LB) and exposure | 100 Mbps × 430 s = 43,000 Mb = 5.375 GB × 10,000 = 53,750; + 2,000 = 55,750 | OK |
| P4-S16 headline | 1.000000 − 0.288000 − 0.055750 = 0.656250 | OK |
| CT-R6 / CT-L2, P4-S117 | 100 × 15 = 1,500; 60 × 15 = 900; Δ = −600. split(1,500) = 450/500/325/225; split(900) = 270/300/195/135 (3000·900/10⁴ = 270, 3333·0.09 = 299.97 → 300, 2167·0.09 = 195.03 → 195, 135; Σ = 900). Differences −180/−200/−130/−90, Σ −600, B +600 | OK; matches P4-S117 |
| C06-M9: own-mode cut posts −split(−Δ) | −split(600) = −180/−200/−130/−90 | OK (sign consistent with M6) |
| CT-R9: P4-S110 dearer path | ⌊3 × 2.7⌋ − ⌊3 × 1.5⌋ = 8 − 4 = 4 | OK |
| CT-R9: P4-S115 | ⌊3 × 1.0⌋ = 3; amendment 3 − 4 = −1, cause Share (M8) | OK |
| Usage close bound | m + 60 + 60 + 180 + 45 = m + 345 s, which is 285 s after the minute's end | OK; but see F08 |
| Acceptance → counted | 0.3 + 0.06 + 2 + 0.05 + 0.06 = 2.47 ≈ 2.5 s (est.) | OK, marked est. |
| Freshness argument | A version effective by `T + 60 s` has `announcedAt + 60 ≤ ceil_min(announcedAt + 60) ≤ effectiveFrom ≤ T + 60`, so `announcedAt ≤ T`. A cache at most 60 s behind `ts` therefore holds every version effective at `ts` | OK |

Unmarked estimates: `post` per-call deadline 2 s is marked est. All other figures are
marked or derived.

## Findings

| ID | Severity | Location | Finding | Proposed change |
|---|---|---|---|---|
| F01 | Major | Settlement mapping ("Any other combination … `movement_refused`/`invalid`"); Ledger posting port (`whole`); C06-M12 | An unmappable line (unknown or inconsistent reason, cause or sign) is excluded **per line** by settlement before the post. In a usage batch the ledger never sees that line, so it commits the rest with `whole = true`. The account owner then sets `U = U(X) − Δ_b`, and `Δ_b` includes the unposted line, so exposure is understated and headroom overstated until the next figure. This breaks P3-S61 ("stays counted … until its charge is posted") and contradicts "a committed usage-batch movement is always `whole`". The ledger cannot detect it, because it only knows the lines it was sent | Apply C06-M12 to settlement's own exclusions: if any line of a usage batch is unmappable, settlement posts nothing. It acknowledges that line `movement_refused`/`invalid` and every other line `batch_refused`, and rating re-emits them as for M12. Also add `lineCount` to `PostMovementRequest.batch`; the ledger sets `whole` only if the posted plus duplicate lines equal it, and refuses otherwise (defence in depth). Add a CT-L4 row |
| F02 | Major | Charge-line batches ("Lines"); Posting acknowledgement (`out_of_sequence`); C06-M5 | Three gaps in ordering: (1) M5 serialises amendments only for **reservation** lines. A usage, cost or late-original line can have sequences k and k+1 in the same usage batch (for example a price correction and a late-traffic amendment due together), and the contract does not say whether a predecessor posted earlier in the same movement counts. If it does not, the batch is refused whole for `out_of_sequence`. If rating then re-composes deterministically, the batch loops. Settlement also has to know the mode after k (M8 enters own mode, so k+1 is M7). (2) "On `out_of_sequence` rating re-emits after the predecessor's acknowledgement": if the predecessor was acknowledged `excluded`/`movement_refused` (parked for an operator, C06-M11), the dependant is re-emitted at once and refuses every following usage batch whole, each time with an alert | Decision D2: a usage batch carries **at most one sequence per line key**. Extend M5 to every line: sequence k+1 is emitted only once k is acknowledged **posted**. A line whose predecessor is parked (`movement_refused`) is parked with it, counted in `U`, and listed with it in daily reconciliation. Add a CT-L6 row for the same-batch case |
| F03 | Major | §7 `PostMovementRequest.lines` | The port carries no `newTotal`/`priorTotal` (or `T_old`/`T_new`). The ledger therefore cannot detect `prior_total_mismatch` (C06-M3), which the port's `refused_batch` claims to return. It also cannot check that the M6 entries equal `split(T_new) − split(T_posted)`. A wrong `priorTotal` from rating then posts wrong supplier shares silently | Add `priorTotal` and `newTotal` (MicroUsd) to every amendment line of the request. The ledger refuses the line `prior_total_mismatch` when `priorTotal ≠` its posted total, and refuses `invalid` when the entries do not equal the template for the stated totals and mode |
| F04 | Major | §5 `ChargeLine`, `SourceRef` `fee`; mapping rows M10, M11 | M10 and M11 credit `partner S:earn +fee`, but a fee line names no payee. `SourceRef.fee` is only (reservation, feeId). Settlement has no lifecycle feed and must never derive parties from the reservation (RFC-004 §B3.1). So it cannot post a fee without guessing. `route` and `weightsVersion` are also mandatory on fee lines (and on residue fees, which may have no route), where they are meaningless (fees are not split) | Add `payee: { supplier: SupplierId; partnerLink: LinkId }`, required iff `lineKind ∈ {fee, share_borne_fee}` (RFC-003 §5.4 already has the partner link from the lifecycle feed). Make `route`/`weightsVersion` absent for fee kinds. Add a CT-L1 row |
| F05 | Major | §8 `MovementPosted.lines` | Lines carry no amount. Shares appear only in own mode or for cost lines. Three consumers need per-line money: (a) F1 adds `a_{r,k}(m)`, the **posted** charge per reservation-minute, to key spending (RFC-004 §A3, POL-25 hard cap), and amendments and corrections change it; (b) the cold re-rate reads "posted total" per line (RFC-003 §5.10 step 2); (c) reporting and statements show each line's postings and reasons per minute (P3-S35) and each supplier's share. None of these is derivable from `partyTotals` | Add per line `amount` (buyer side, signed), `postedTotal` after the line, and, for normal mode, enough to recompute shares (`weightsVersion` is already there, so state that shares are `split(postedTotal)`). Add a CT-L7 check that F1 and KP reproduce from the feed |
| F06 | Major | §2 `split_weights`; Catalogue "Routes and weights" | Weights have `effectiveFrom` but, unlike prices, no lead-time or no-retroactivity rule (RFC-003 §6.1 validates only "non-negative"). A version approved after its `effectiveFrom` relabels minutes already posted. An amendment of such a minute then carries a different `weightsVersion` from the original's, so M6's `split(T_new) − split(T_old)` no longer moves parties to their split of the final total. It can debit a party that holds nothing, breaking P4-S38 and P4-S39 monotonicity. RFC-003 also allows weight 0 ("non-negative") where the contract and RFC-004 say positive | `effectiveFrom ≥ ceil_min(announcedAt + 60 s)`, refused at approval, as for prices. Weights are positive integers. An amendment always carries the `weightsVersion` its line's original was posted with (the ledger holds it, so it refuses a mismatch as `invalid`). Erratum to RFC-003 §6.1 |
| F07 | Major | §2 `account_product_terms` (no `effectiveFrom`), `policy_parameters`; "Exposure parameters" | The lateness bound (LB) inputs other than price have no timing rule. If finance lowers `usage_rate_cap` (or a `policy_parameters` version lowers `maxLatenessS` and so on), F3 lowers LB at once while up to 370 s of traffic carried at the old cap is still uncounted, so headroom is overstated. If finance raises the cap and the edge polices from the catalogue before F3's step, traffic flows above the cap LB assumes. The writer and approval of `policy_parameters` are also unspecified, though it can change `price_notice` and `dispute_window` | Decision D3: give `account_product_terms` an `effectiveFrom` minute with lead ≥ 60 s. The edge applies the new cap from `effectiveFrom`. F3 uses, like `hp*`, the **maximum** cap (and the maximum Λ) in force over `[ts − (Λ − 60 s), ts + 60 s]`, so an increase enters 60 s early and a decrease leaves 370 s late. `policy_parameters` is written only by the role that owns the policy, four-eyes, with the same lead. Requirements issue RQ-44-1 |
| F08 | Major | Timeouts table, "Posting … within the X2-S13 timeliness target (2 min from closure)" | X2-S13 measures from the **minute's end**: reservation 2 min, usage `max_lateness` + 2 min = 300 s. The usage close bound is already 285 s after the minute's end, so "2 min from closure" allows 405 s and would let a conforming implementation miss X2-S13. At the hard bound only **15 s** remain for figure coalescing (≤ 2 s), F2 and the acknowledgement, emission and the post. A settlement takeover (about 5 s, est.), a relay hop (about 1 s per hop) or one `refused_batch` re-emission (a new figure, about 2.5 s or more) all fit only singly | State the budgets from the minute's end: reservation ≤ 120 s; usage ≤ 300 s. Typical close is 255 s, leaving 45 s; at the 285 s hard bound, 15 s. Itemise the 15 s (est.) and state that a refusal or a takeover at the hard bound may exceed it, counted against the 99.99% target. Alternatively lower the hard close margin from 45 s to about 35 s |
| F09 | Major | "Consumer obligations" | The errata for C06-M12 and M3 are incomplete. Each text below still says a usage batch posts with an excluded line and is "not whole": RFC-003 §5.9 (last exactness bullet), §5.8 (the exclusion sentence) and §7 (the charge-line row, affected marks inside reservation batches); RFC-004 §A4 F2 ("a batch posted with an excluded line is not reduced"), §B3.1 (`whole` column "True unless a line is excluded"; "Restarts … neither refused") and §B9 (row "Line excluded and reported; the rest of the movement posted"). RFC-004 §B12's `post` signature also lacks `refused_batch`, `unavailable`, and the per-line totals of F03. RFC-004 §B12 offers per-supplier and per-external-kind movement views that C06 does not define (F20) | Add these sections to the RFC-003 and RFC-004 rows. Add RFC-003 and RFC-004 handling of `unavailable` (`moving`, `stopped`) per C4-7 |
| F10 | Major | §2 `probe_designation` (subject `account`); Ownership | Probe **accounts** are designated by placement's account slot map, "the single source of truth … none keeps a mapping of its own" (RFC-000 §8, B-AI-10). The catalogue adds a second, independently writable flag for accounts. C06 names no writer for it (RFC-003 §6.1 says "as RFC-006 states"). Rating skips accounts flagged as probe (no lines, no figures), so a divergence leaves a buyer's traffic unrated, or a probe account rated | Account designations on `catalogue.v1` are a projection written only by RFC-006 placement from the slot map (a third writer kind, like link-registry rows), never by a console command. Architecture issue AI-44-1 |
| F11 | Minor | Idempotency (`ChargeLineBatch`/movement) | (a) "Ledger returns the first movement's answer" does not cover the same `BatchId` with **different** lines, which could happen on generation reuse after a cold rebuild. (b) It does not say that `refused_batch` and `over_limit` answers are recorded. If they are not, a redelivered refused batch can later commit lines rating has re-emitted elsewhere (the `out_of_sequence` line once its predecessor posts) | The ledger stores the movement's content digest with its answer. The same `movementRef` with a different digest is answered `refused`/`invalid` and raises an integrity alert. `refused_batch` and `over_limit` answers are recorded and returned on repeat |
| F12 | Minor | Topics (`settlement.posting-acks.v1`, producer Settlement); Transport ("from the producer's transactional outbox") | RFC-004 §B1.3 writes the posting answer in the **ledger's** outbox, and settlement has no outbox. Refusals and settlement's mapping exclusions commit nothing anywhere, so the "outbox" guarantee does not hold for them | Name the producer: the ledger outbox for committed movements; settlement's direct publish, at least once before its offset commit, for refusals and exclusions. Restrict the ACL accordingly |
| F13 | Minor | `ledger.movements.by-buyer.v1` ("buyer movements only") vs "exactly the movements homed at that buyer"; CT-L7 | A usage batch of only cost lines or Share-borne fees (M11 … M13, M23) is homed at the buyer but touches no `B:`. If the view drops it and rating takes `X` at its position, F2 waits for the account's next movement (an F2 lag beyond `attribution_lag_max`) | The view is every movement whose home is the buyer, whatever accounts it touches. Make CT-L7's filter that |
| F14 | Minor | Posting acknowledgement ("the next amendment restates the ledger to `C`") | The reason and cause of the restating amendment after a re-base are unspecified. If rating labels it `re_rate` (Share, M8, C06-M8), a downward supplier-fault correction (M9) refused for `prior_total_mismatch` is borne by Share instead of supplier `f` | The restating amendment carries the reason and cause of the trigger that produced the offending line; only a cold re-rate's residual uses `re_rate` |
| F15 | Minor | Posting acknowledgement; C06-M4 | A `content_conflict` on a fee or Share-borne fee line has no resolution: fees are never amended and the fee key has no sequence, so a re-base by `ledgerLastSeq` is meaningless | A fee conflict is parked as for `movement_refused` (alerted, listed in reconciliation, operator via M22), never re-based |
| F16 | Minor | Mapping table | Accepts combinations rating never produces: reservation lines with `late_traffic`, `quarantine_attribution` or `corrected_record`, and an upward `price_correction` of a reservation line (RFC-003 §6.3 allows only downward). "Settlement never guesses" is then only partly true | Restrict reservation amendments to {`price_correction` < 0, `late_pol07_cut`, `re_rate`}. Everything else is `invalid` (with F01's whole refusal) |
| F17 | Minor | Idempotency (`ChargeLine` "same contents"); `SourceRef` | Neither the fields compared for "same contents" nor a canonical encoding of `SourceRef` (the ledger dedups by digest for 7 years) is defined. A re-emission that differs only in `reasonDetails` or `priceCatalogue`, or a different JSON key order after a code change, refuses a usage batch whole with an integrity alert | Compare only (lineKind, amount, newTotal, priorTotal, payer, payee, route, weightsVersion, reason, cause, lateCut). Define a canonical byte encoding of `SourceRef` (fixed field order, decimal strings) |
| F18 | Minor | §7 `PostMovementRequest.principal` | The principal is a body field. The ledger must take it from the authenticated caller (RFC-005), otherwise any posting caller can claim settlement's or reconciliation's kinds | The principal is taken from the mTLS or workload identity; the field, if kept, must equal it, else `principal` refusal |
| F19 | Minor | Excluded `LineAck` (C06-M2) | It carries `ledgerPostedTotal` but no ledger position. Rating cannot place the conflicting posting in `P_X(L)` for a given `X` | Add `ledgerPosition` of the last posting of the line |
| F20 | Minor | Topics | RFC-004 §B12 promises per-supplier (payouts, settlement's supplier partition) and per-external-kind (reconciliation) views. C06 defines only full and by-buyer | Add them or drop them by RFC-004 erratum. State which, and add them to F09 |
| F21 | Minor | §2 Catalogue | `oeEffective` has no prose (it should say that it is when open-ended reservations take the version, and what drives F11). RFC-002 §13.2 also consumes "link validity rules and their policy version" from the catalogue, which no entity carries | Add one sentence for `oeEffective` (RFC-003 §6.2). Add the link-rules entity or point to the contract that carries it |
| F22 | Minor | CT-C4; CT-R6 | CT-C4 says "a price rise **announced** inside the next 60 s raises it at once". A `usage_price` rise is announced 30 days ahead, so this should read "**effective** within the next 60 s". CT-R6 cites P3-S58 (an on-time cut, 4 → 2 Mbps), which does not cover a late cut | Fix the wording. Cite P4-S117 only |
| F23 | Minor | Consumer obligations, last paragraph | C4-7 is taken by C06 ("surfaces as `unavailable`"), but no RFC-003 or RFC-004 erratum states the caller's handling (retry `moving`; `stopped` means alert and hold, no tight loop) | Add to both rows |
| F24 | Minor | Delivery and ordering, `UsageApplied` | Ordering is by `streamSeq`, while idempotency is keyed `(account, appliedThrough)`. A redelivered older acknowledgement must not lower rating's gate | Rating keeps the maximum `appliedThrough`; an older one is a no-op (state it) |
| F25 | Minor | RFC-000 §8 posting-port row | RFC-000 lists consumers "Settlement, payments, payouts"; C06 and RFC-004 §B12 add receivables (M18, M19) and reconciliation (M21) | Architecture issue AI-44-2 |

## Settled points: consistency check

| Point | Applied in schema and semantics | Gap |
|---|---|---|
| M1 `appliedTs` | Yes | — |
| M2 re-base fields | Yes | F19 (no position); F15 (fees) |
| M3 totals | On the feed | Not on the port (F03) |
| M4 fee key, never amended | Yes | Payee missing (F04) |
| M5 reservation amendment after ack | Yes | Not extended to other lines (F02) |
| M6 `AffectedMark` | Yes | RFC-003 §5.8 and §7 erratum (F09) |
| M7 `policy_parameters` | Entity added | Writer, lead and decrease rule (F07) |
| M8 downward re-rate | Yes | Re-base reason (F14) |
| M9 own-mode cut | Yes; numbers check | — |
| M10 `EventId` | Yes | — |
| M11 parked lines | Yes | Dependants not parked (F02) |
| M12 wholeness | Port, acknowledgement, CT-L4 | Settlement exclusions (F01); recorded refusals (F11); errata (F09) |

## Decisions taken

- **D1 (F01).** Any line of a usage batch that cannot be posted, for whatever reason, refuses
  the batch whole. That reason is a ledger conflict, a mismatch, sequence, settlement's
  mapping or size. Only the offending lines carry their own reason; the rest are
  `batch_refused`. This is the one rule that keeps `whole` true by construction. It costs
  only a re-emission on a defect path.
- **D2 (F02).** There is at most one sequence per line key in a usage batch, and each next
  sequence waits for the previous one to be acknowledged **posted**. Defining
  intra-movement chaining in the ledger was rejected: it costs ledger complexity (mode
  changes mid-movement) to save a few seconds on a rare path. Each amendment keeps exactly
  one reason, as RFC-003 §5.7 requires.
- **D3 (F07).** A change to `usage_rate_cap` or to a lateness parameter takes effect at a
  minute at least 60 s after it is recorded. The edge polices from that minute. F3 counts the
  higher of the old and new values over the bound's span, exactly as for the price. A buyer
  whose cap is lowered keeps the old exposure for about 6 min. That is cheap for the buyer,
  and it keeps Share's risk at the policy's bound.
- **D4 (F06).** Split weights take the price rule: at least 1 min lead, never retroactive. A
  mistaken weight is fixed going forward only. Its past effect is visible in the deviation
  report (RFC-004 §B3.5), and finance can settle it by an M22 if it chooses.

## Requirements issues

- **RQ-44-1 (POL-14).** The policy defines the lateness bound at "`usage_rate_cap`" without
  saying which value applies across a change of the cap (or of `max_lateness`,
  `attribution_lag_max` or `flow_active_timeout`). Proposed amendment to POL-14's "Which
  price" bullet: "**Which cap and window.** The highest `usage_rate_cap`, and the longest
  window, in force at any time in the bound's span. A cap change takes effect on a minute
  boundary at least the enforcement target after it is recorded."

## Architecture issues

- **AI-44-1 (RFC-000 §8, "Probe designation and exclusion" and "Account slot map").** Probe
  accounts have two sources: the catalogue flag and the slot map. Proposed amendment: "Probe
  **accounts** are designated only by placement's account slot map. The catalogue carries
  them as a read-only projection written by placement. Probe links, suppliers and exporters
  stay catalogue facts set as RFC-006 states."
- **AI-44-2 (RFC-000 §8, Ledger posting port).** Add receivables (M18, M19) and reconciliation
  (M21) to the consumers. Replace "each line balanced and deduplicated on its own" with
  "each line balanced and deduplicated on its own; a usage batch is posted whole or not at
  all (C06-M12)". In the movement-feed row, note that `whole` is then always true for a
  committed usage-batch movement and kept as a check.
