# 55. Contract re-review: C06 Usage and charges (draft 3), focus money

| | |
|---|---|
| Artefact | `docs/04-delivery/contracts/C06-usage-and-charges.md`, version 1, draft 3 (commit 1c8f321) |
| Mode, focus | Contract; money. Re-review after [44](44-contract-C06-review.md) (full rewrite) |
| Pinned against | `requirements-v1.10`; RFC-000 rev. 4.4 §8 (Catalogue, Unposted-usage feed, Usage-applied acknowledgement, Charge-line feed, Posting acknowledgement, Quarantine and breach feeds, Evidence query, Ledger posting port, Ledger movement feed, Probe designation, substrate conventions incl. closure emitter and C4-7); RFC-003 rev. 5 + 5.1 (§2, §5.4 … §5.10, §6, §7, §8); RFC-004 rev. 5 + 5.1 (§A3, §A4, §B1 … §B3, §B9, §B10, §B12); RFC-001 rev. 5 §10; RFC-002 rev. 5 §13.2 (catalogue row); C05 v0.2; C01 (M11) |
| Tools | `check_specs.py`: no problems (473 scenarios). `impact.py coverage` does not take contracts (`KeyError: 'C06'`); every scenario ID C06 cites was checked and exists exactly once at v1.10 |

## Verdict

**ACCEPT WITH CHANGES.** No Blocker; 9 Major, 17 Minor.

Every review-44 finding has a textual resolution and every worked figure checks out. The
rewrite does introduce new defects, most of them where the new rules meet each other:

- The posting port does not carry the fields that the ledger is told to compare and to
  publish.
- The per-line checks reject the idempotent repeats that CT-L4(1) requires.
- The `lineCount` check refuses every reservation batch from which settlement excluded a
  line.
- A digest mismatch on a committed movement produces contradictory acknowledgements.
- Parked lines have no way out.
- Three writers share `catalogue.v1`, which defeats both closure and the ACLs.
- `policy_parameters` gets operator writers that POL-32 never created.
- A `stopped` hold blocks unrelated accounts.
- `UsageApplied.entry` disagrees with C05 v0.2.

All of these are local edits to the contract. None changes the design.

## Figures rechecked

| Figure | Recomputed | Result |
|---|---|---|
| Price encoding | 1.5 µ/Mbps-min = 1.5 × 10⁶ pico = `"1500000"` | OK |
| CT-R5, P3-S37 | 0.2 GB × 10,000 µ/GB = 2,000 | OK |
| Λ and span | 180 + 60 + 60 + 10 + 60 + 60 = 430 s; span back 430 − 60 = 370 s, ahead 60 s | OK |
| CT-C4 | 100 Mbps × 430 s = 43,000 Mb = 5.375 GB × 10,000 = 53,750; + 2,000 = 55,750 | OK |
| CT-C4 cap change | Old cap stays in the span while `ts − 370 < effectiveFrom`, so until `effectiveFrom + 370 s`; a raise enters when `ts + 60 ≥ effectiveFrom` | OK. The product of the per-factor maxima is ≥ the maximum of the products, so it is safe (conservative) |
| CT-R6 / CT-L2, P4-S117 | 100 × 15 = 1,500; 60 × 15 = 900; split(1,500) with weights 3000/3333/2167/1500 gives quotas 450 / 499.95 / 325.05 / 225, which Webster rounds to 450/500/325/225; split(900) gives 270 / 299.97 / 195.03 / 135, rounded to 270/300/195/135; differences −180/−200/−130/−90, Σ −600; buyer +600 | OK; matches P4-S117 lines 732–733 |
| C06-M9 | −split(600) = −180/−200/−130/−90 | OK |
| CT-R9 | P4-S110: ⌊8.1⌋ − ⌊4.5⌋ = 4; P4-S115: ⌊3.0⌋ = 3, amendment −1, cause share | OK |
| Usage posting budget | Close 60 + 180 + 15 = 255 s after minute end (45 s left of 300); hard 60 + 180 + 45 = 285 s (15 s left); path 2 + 0.05 + 0.06 + 0.05 + 0.06 + 0.2 = 2.42 ≈ 2.5 s, leaving ≈ 12.5 s | OK, marked est. See m15 for accounts above `L` |
| Reservation posting | 200 batches / 8 in flight × 0.2 s ≈ 5 s (contract says ≈ 10 s, as RFC-003; conservative); 120 − 5 − 10 ≈ 105 s ("about 100 s") | OK |
| Acceptance → counted | 0.3 + 0.06 + 2 + 0.05 + 0.06 = 2.47 ≈ 2.5 s | OK, est. |
| Freshness | `effectiveFrom ≥ ceil_min(announcedAt + 60) ⇒ announcedAt ≤ effectiveFrom − 60`. A version effective by `T` was announced by `T − 60`, and a cache within 60 s holds it | OK; the prose wording is off (m13) |

Unmarked estimates: none. The 2 s `post` deadline and the 30 s `stopped` cadence are marked
est.

## Review 44 resolution: verified

| R44 | Resolved? | Note |
|---|---|---|
| F01 | Yes for usage batches | The `lineCount` check regresses reservation batches (M3) |
| F02, D2 | Yes | — |
| F03 | Yes | Totals are on the port, but the other compared fields are not (M1) |
| F04 | Yes | — |
| F05 | Schema yes; source no | The ledger cannot populate `reason`, `cause`, `lateCut` or `payee` (M1) |
| F06, D4 | Yes | — |
| F07, D3 | Lead and maximum rule: yes | The writer split is invented (M7) |
| F08 | Yes | — |
| F09 | Yes | — |
| F10 | Partly | Projection kept, and "or from this projection" re-opens two sources (M6, m14) |
| F11 | Yes | The digest-mismatch answer on a committed movement is wrong (M4) |
| F12 | Yes | `PostingAck` schema still says "every line answered" in one message (m1) |
| F13, F15, F16, F18, F19, F22, F23, F24, F25 | Yes | — |
| F14 | Yes | No valid reason for restating a conflicted original (m3) |
| F17 | Fields named and encoding defined | The fields are not on the port (M1) |
| F20 | Yes | Dedup across view keys (m11) |
| F21 | `oeEffective` yes | `link_rules` is undefined (m9) |

## Author's additions judged

| Addition | Keep? | Reason |
|---|---|---|
| `stopped` retried at most every 30 s (est.) | **Keep** | C4-7 obliges each caller to state its handling, and a cadence is needed. Isolation is missing (M8) |
| `policy_parameters` writers split by parameter | **Remove** | No requirement or RFC basis: POL-32 gives no role these actions, and RFC-003 §8 reads POL values "as configured". It creates an unowned money power (M7, D6) |
| By-supplier and by-external views | **Keep** | RFC-004 §B12 lists them. Fix dedup per view key (m11) |
| `link_rules` entity | **Keep the slot, define or point** | RFC-002 §13.2 consumes "link validity rules and their policy version" from the catalogue. But the body is `unknown`, RFC-001 §10 defines no such entity and no writer command (m9) |
| Canonical `SourceRef` encoding | **Keep** | The ledger dedups by digest for 7 years (RFC-004 §B1.4), so a fixed encoding is required |
| Account `probe_designation` projection written by placement (from R44) | **Drop** (cheaper) | Display can read the slot map (C01 M11). The projection adds a third topic writer (M6) |

## Findings

| ID | Severity | Location | Finding | Proposed change |
|---|---|---|---|---|
| M1 | Major | §7 `PostMovementRequest.lines`; Ledger posting port "Per-line outcomes"; §8 `MovementPosted.lines`; RFC-003 §5.10 | The port line carries only `kind`, `lineRef`, `amendmentSeq`, `priorTotal`, `newTotal`, `split` and `entries`. The ledger is told to compare content on `lineKind`, `payer`, `payee`, `reason`, `cause` and `lateCut`, and to publish `reason`, `cause`, `lateCut` and `payee` per line (F05, CT-L7, P3-S35 statements "with the reason"). None of these reach it. The cold re-rate skips triggers "matched by trigger reference" (RFC-003 §5.10 step 3), and `triggerRef` is neither on the port nor on the feed. So two lines that differ only in cause (M8 vs M9) dedup as identical, the feed's reason fields are empty, and a cold re-rate re-posts triggers already posted (P3-S13) | Add to each port line: `lineKind`, `payer`, `payee?`, `reason`, `cause?`, `lateCut?`, `triggerRef?`. Store them in the movement payload, compare them, and publish them (with `triggerRef`) on `MovementPosted.lines`. Add `triggerRef` to the cold re-rate's feed reads. Extend CT-L5 and CT-L7 |
| M2 | Major | Ledger posting port "Per-line checks" vs "Per-line outcomes"; CT-L4(1) | The checks are stated unconditionally. A redelivered posted amendment has `amendmentSeq` = the last posted (not one more), so it fails as `out_of_sequence`. Its `priorTotal` is below the posted total, so it fails as `prior_total_mismatch`. In a usage batch either one refuses the batch whole. Rating re-emits the same lines and the loop repeats. This contradicts CT-L4(1) | State the order: (1) look up the canonical `SourceRef`; on a hit with equal content the line is `duplicate`, and on different content `conflict`. (2) Only for a new reference, apply the `priorTotal`, sequence, weights and template checks. Add an amendment case to CT-L4(1) |
| M3 | Major | Validation "for a charge batch, `lines.length = batch.lineCount`"; Settlement mapping "In a reservation batch only the invalid line is excluded" | In a reservation batch, settlement drops an invalid line before the post, so `lines.length < lineCount`. The ledger then refuses the whole M4 as `invalid`. Every line is acknowledged `movement_refused` and parked, with its later minutes held behind it. One bad line strands a whole minute of an account's reservation charges (X2-S13) | Apply the equality only to usage batches. For reservation batches, send `excludedRefs` (lines dropped by settlement) and check `lines.length + excludedRefs.length = lineCount` |
| M4 | Major | Idempotency row `ChargeLineBatch`/movement; CT-L5 | "Same `movementRef`, different digest → `refused`/`invalid`" applies even when the first movement **committed**. Settlement re-composes from its offset after a restart, and a settlement deploy can change composition. Settlement then acknowledges `movement_refused` for lines whose `posted` acknowledgement the ledger outbox also publishes, from two producers in no defined order. Rating may park and alert lines that are posted, and park their dependants | If the reference has a **committed** answer, return that answer (lines deduplicated per line) and raise the integrity alert; never `refused`. Only an uncommitted (`refused_batch`/`over_limit`) recorded answer with a different digest is `invalid` |
| M5 | Major | Posting acknowledgement "Parked lines"; C06-M11; `refused` reasons `principal`, `wrong_home` | (a) There is no exit from parking. "Resolved by an operator" names no operation, and an M22 does not touch the line key, so a parked usage line stays in `U` forever. The buyer's headroom falls permanently, and every later sequence of the line is parked too. (b) A movement-level refusal (`principal`, `wrong_home`, which are deployment or config defects) acknowledges every line `movement_refused`, so one misconfiguration parks every line of every account. That is a liveness failure that needs millions of operator resolutions | D5: movement-level refusals are **not** parked. Settlement alerts and holds the batch, retrying as for `stopped`. Parking applies only to line-level `invalid` and fee conflicts. Add a rating operator command (finance, envelope, idempotent) `resolve_parked(line, action: re_emit \| abandon)`. `re_emit` re-enters the line and its dependants after a fix. `abandon` records a write-down so the line leaves `U`, and reconciliation closes it |
| M6 | Major | Topics `catalogue.v1` (three writers); `ResolvedMarker`; "Kafka ACLs … for its own entity types" | RFC-000 §8's closure emitter is **per relayed owner kind**. With three kinds on one topic, each publishes markers on the same partitions, and `ResolvedMarker` does not say whose they are. The account owner's freshness gate (B-AI-11) can pass on the link registry's marker while price rows lag, so it locks a superseded price. Kafka ACLs cannot restrict entity types inside a topic, so placement or the registry principal can publish `price_version` or `split_weights`, and settlement would split money by them | `catalogue.v1` is written by the RFC-003 catalogue only. Link rows stay on RFC-001's registry feed (RFC-001 §10, which C03 already consumes by `(link_id, version)`). Drop the account probe projection (D7). If a shared topic is kept: markers carry the writer kind, consumers gate on the minimum over kinds, and consumers verify that the body's feed key matches the writer kind for the entity type |
| M7 | Major | Semantics "Writers" `policy_parameters`; C06-M7 | The split (finance: `max_lateness`, `attribution_lag_max`, `dispute_window`, `rto_adm`; commercial: `price_notice`, `flow_active_timeout`) has no basis. POL-32 says each action belongs to exactly one role and lists none of these, and RFC-003 §8 reads POL values "as configured". `rtoAdmS` is a property of failover. Lowering it in the catalogue understates LB without making recovery faster. A commercial operator lowering `price_notice` overrides POL-27 | D6: `policy_parameters` versions are written only by a **deployment** (configuration release, like F10's rules version) carrying the policy-register values, with the ≥ 60 s lead. No console command writes them. `rto_adm` and the two 60 s terms are constants of the formula, not fields. Requirements changes go through the register |
| M8 | Major | Ledger posting port "`stopped` … hold the batch"; Delivery "Settlement commits its Kafka offset only after each batch is answered" | `stopped` lasts until audit resumes the partition, which can be hours. If settlement holds the batch inside its partition consumer, every other account on that Kafka partition stops posting: a breach of X2-S13 for unrelated buyers, and their `U` grows | Settlement isolates per account: a held account's batches wait in a per-account queue while other accounts proceed. The Kafka offset is committed at the low-water mark of unanswered batches, and a restart re-reads safely by dedup. Same for `overloaded` backoff. Add a CT-L case |
| M9 | Major | §4 `UsageApplied.entry`; Idempotency row `UsageApplied`; CT-A5 vs C05 v0.2 | C05 types `entry` as its `LogPosition { partition: AccountId; sequence }`. C06 has `{ accountPartition, generation, epoch, seq }`. C05's rating dedup key is "(account, `appliedThrough`)", while C06 uses `entry`. C05's `usage_applied_since` is keyed by `afterStreamSeq`, while CT-A5 says "from a given `entry`". The two frozen sides would implement different dedup and recovery | One definition: `entry: LogPosition` per C05 (add `generation` and `epoch` to C05's type if the log needs them, or drop them here). Dedup at rating by `eventId`, with the gate on maximum `appliedThrough`. CT-A5 recovers "after a given `eventId.streamSeq`". Fix C05's idempotency row to cite C06 |
| m1 | Minor | §6 `PostingAck.lines` "one per line of the batch, every line answered" | With two producers (F12), a reservation batch's answers arrive in two messages: posted lines from the ledger, settlement's exclusions direct | "A batch's lines are answered across one or more `PostingAck` messages; their union answers each line exactly once" |
| m2 | Minor | §7 committed `lines.outcome` | A reservation-batch line that fails `prior_total_mismatch` or the template has no per-line outcome (only posted, duplicate or conflict). `over_limit` for a reservation batch has no acknowledgement rule | Add `problem` per line to committed answers. State that a reservation batch over `L` is refused whole and re-split by rating |
| m3 | Minor | Posting acknowledgement re-base; F14 | A re-based `content_conflict` on an **original** has no trigger reason: "original" at `seq > 0` is invalid by the mapping, so the restatement would be parked. "The next amendment restates" waits for a new trigger, so a ledger total above `C` is never refunded | On re-base, emit the restatement at once if `C ≠ ledgerPostedTotal`. For a conflicted original, use `re_rate` (an upward one goes M6; a downward one is cause share, M8) |
| m4 | Minor | "A parked line stays unposted and counted in `U`" | `U` counts usage lines only. A parked fee stays held through `fee_state = open`, and parked reservation amendments and cost lines are not in headroom at all | Say which mechanism keeps each kind covered |
| m5 | Minor | Mapping row `usage, 0, original (or a late original)` | A late original created by a quarantine attribution or a superseding record (RFC-003 §5.6) may be labelled with that reason (P3-S27); the mapping would refuse it | "Every `seq 0` line has reason `original`; the trigger goes in `triggerRef`/`reasonDetails`" |
| m6 | Minor | D3; Network operations obligation | An edge whose catalogue replica lags past a cap **decrease** keeps policing the old cap after `effectiveFrom + 370 s`, when F3 has dropped it | Bound edge staleness (alarm at 60 s) and keep the old cap in F3 until `effectiveFrom + 370 s + edge staleness bound`, or have the edge acknowledge |
| m7 | Minor | `account_product_terms` | No rule for a product with no version yet (new account): the edge and F3 have no cap | The POL-14 default (100 Mbps) applies until the first version takes effect |
| m8 | Minor | §2 `policy_parameters`, `price_version` | `policy_parameters` has no entity id or version for the Kafka key and query. Two price versions with one `effectiveFrom` have no tie rule | Add `policyVersion`; "at most one version per (product, route, kind, effectiveFrom)" or latest `announcedAt` wins |
| m9 | Minor | §2 `link`, `link_rules` bodies `[k]: unknown` | A wire contract with untyped bodies. `link_rules` cites RFC-001 §10, which defines no such entity and no writer command | Type `link` per RFC-001 §10 (or point to the registry feed's contract, M6). Define `link_rules { policyVersion, effectiveFrom, rules }` and raise AI-55-1 for its owner |
| m10 | Minor | "Every topic also carries resolved markers" | The closure emitter cannot vouch for settlement's direct publishes on `settlement.posting-acks.v1` | Markers only on topics fed solely through the relay |
| m11 | Minor | Filtered views; Delivery `MovementPosted` "exactly-once effect by `EventId`" | A movement touching two suppliers appears under two keys with one `EventId`. A consumer deduping by `EventId` alone drops one supplier's copy | Dedup by (view key, `EventId`) |
| m12 | Minor | `AffectedMark`; Topics consumers of `rating.charge-lines.v1` | Reporting consumes marks but is not a listed consumer or ACL holder, and the topic keeps only 3 days | Add reporting, or move marks to their own 7-day topic |
| m13 | Minor | Freshness gate prose | "a cache through `T` cannot lock…" proves the wrong bound | "Every version effective by `T` was announced by `T − 60 s`, so a cache within 60 s holds it" |
| m14 | Minor | Probe designations "or from this projection, which is the same thing" | It lags the slot map, and C01 M11 says decisions use the slot map | Decisions use the slot map only |
| m15 | Minor | Timeouts, usage row | It assumes one usage batch. An account above `L` usage lines needs ⌈n/L⌉ sequential gated cycles (17,000 lines: 4 × ≈ 2.5 s ≈ 10 s, est.) of the 15 s at the hard bound | State it, or let such accounts' extra batches be counted against the target |
| m16 | Minor | CT-L2 | "`B +600`" (buyer) and "B −200" (supplier B) collide | Write `B:b1 +600` and `S:B:earn −200` |
| m17 | Minor | §9 `QuarantineAggregate.bytesByState: Seq` | Spread parts are rational (ELA), and the rounding is unstated | "Floor of the exact sum" |

## Decisions taken

- **D5 (M5).** Parking is for line-level defects only. Movement-level refusals hold and
  retry. Parked lines leave the parked state by a finance `resolve_parked` command, either
  `re_emit` or `abandon` (a written-down line leaves `U`, and reconciliation closes it).
  Buyers are never left with permanently reduced headroom by Share's defect. Share bears an
  abandoned charge.
- **D6 (M7).** Policy parameters change only by deployment of policy-register values, never
  by an operator. The formula's recovery and enforcement terms are constants. This costs
  agility, which the requirements never asked for, and removes an unowned power over
  exposure and notice.
- **D7 (M6).** `catalogue.v1` has one writer (the RFC-003 catalogue). The link registry
  keeps its own feed, and account probe designation is read from the slot map. This is
  cheaper than per-kind markers plus per-entity key checks.

## Requirements issues

None new. RQ-44-1 stands. D6 confirms that POL-32 gives no role the policy parameters,
which is the intended reading.

## Architecture issues

- **AI-55-1 (RFC-000 §8 Catalogue; RFC-001 §10).** RFC-002 consumes "link validity rules
  and their policy version" from the catalogue, but no RFC defines that entity or its
  writer. Proposed amendment: "Link validity rules are versioned with `policyVersion`, owned
  by RFC-001, published on the link registry feed by deployment, and recorded at intake (C02
  `policyVersion`)."
- **AI-55-2 (RFC-000 §8 substrate conventions, closure emitter).** A topic must have exactly
  one relayed owner kind if it carries closure markers. Proposed amendment: add "one relayed
  owner kind per topic that carries resolved markers".
