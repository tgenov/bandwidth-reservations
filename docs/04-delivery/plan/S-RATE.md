# S-RATE delivery plan: metering, attribution, rating and catalogue

| | |
|---|---|
| Slice | **S-RATE** (`docs/process/slices.json`): primary spec P3, RFC-003 |
| Authority | [RFC-003](../../03-rfcs/RFC-003-rating-and-metering.md) revision 6, treated as accepted. [RFC-000](../../03-rfcs/RFC-000-architecture.md) revision 4.5 for components and substrate. Requirements at `requirements-v1.11`: [P3-rating-and-metering.feature](../../02-specs/P3-rating-and-metering.feature), P3-S01 … P3-S78 (78 scenarios; `python3 tools/impact.py coverage S-RATE`: 78 primary, 0 uncited, 0 dangling) |
| Frozen contracts | [C01](../contracts/C01-platform.md) v1, [C03](../contracts/C03-link-schedule.md) v2.4, [C04](../contracts/C04-reservation-feeds.md) v2.3.1, [C05](../contracts/C05-funds-and-standing.md) v1, [C06](../contracts/C06-usage-and-charges.md) v1, [C08](../contracts/C08-identity-and-access.md) v1.2, [C09](../contracts/C09-personal-data-store.md) v1.1, [C11](../contracts/C11-metering-ingress.md) v1.0.0, [C12](../contracts/C12-partner-port.md) v1. RFC-003 cites C08 v1.1. C08 v1.2 adds only four-eyes credit limits, which this slice does not use |
| Substrate | CockroachDB at 2 + 2 + 1, NestJS owners on the C01 owner runtime, Kafka (RFC-000 §5.5). Every owner kind of this slice is a single-writer state machine over an insert-only log table |
| Prior art | `billing/` (NestJS, Kafka, Postgres), as the Tests column of [conformance.md](../../02-specs/conformance.md) cites it (§3) |
| Status | Draft plan |

## 1. Scope

This slice delivers every P3 scenario (78). It also delivers the RFC-003 part of X2-S02,
X2-S04, X2-S09, X2-S10, X2-S11, X2-S12, X2-S13, X2-S14, X2-S19, X2-S20, X2-S22 and X2-S23.
Those X2 parts are exit measurements of the increments (§7). RFC-006 owns the rest of each
X2 scenario.

These are not in this slice: settlement, the ledger and F3 (the lateness bound) (RFC-004);
the account owner (RFC-002); sealing and the history service (RFC-006); the operator
console and the personal-data store (RFC-005); provisioning (external). This slice uses them
only through frozen contracts.

## 2. Components and owners

Owners are roles, not persons. The owner runs the component in production and approves
changes to the contracts it provides.

| Component (RFC-003) | Responsibility | Owner | Log table | Provides | Consumes |
|---|---|---|---|---|---|
| Metering ingestion (§3) | Accept each flow record durably, give it one outcome and a 7-year identity, acknowledge it after two-region commit, keep it as evidence. Keep a non-conforming payload out of every log | Metering team | `ingest_log` (self-outboxed) | C11 Part I, Part II; drop alert and drop report on the C01 alert feed | C01, C08 (principal context), C09 (`put_payload`, `withdraw_payload`, `digest_key`) |
| Attribution stage A (§4.1, §4.2, §4.4) | Spread each record over its minutes, bind each part at a covered binding position, classify it, route it to its account. Quarantine what it cannot attribute. Apply finance attributions and reversals. Negate and replace superseded records | Attribution team | `attr_a_log` | C11 Part IV; C06 §10 quarantine report; C08 target summary `quarantine_item`; stage A watermark | C11 Part II, Part III; C06 §2 (probe designations); C08 |
| Attribution stage B (§4.3) | Append each part batch of an account once. Keep the attachment set. Hold T4 violations | Attribution team | `attr_b_log` | In-process hand-off to rating (slot group) | C11 Part IV |
| Rating (§5) | Turn reservation history, attributed parts and prices into reservation, usage, fee and cost lines and their amendments, exactly once. Publish unposted usage. Report breaches | Rating team. The rating team also runs the stage B + rating slot group process | `rating_log` | C06 §3, §5, §6, §11, §13 | C01 (runtime, slot map), C03, C04, C06 §2, §4, §7, §9, C08 |
| Catalogue (§6) | Hold products, routes, prices, corrections, split weights, partner terms, `usage_rate_cap`, `policy_parameters` and probe designations. Enforce the write rules | Catalogue team. Commercial and finance set the data | `catalogue_log` | C06 §2 `catalogue.v1`; C08 target summaries | C04 (locked-price read model), C08, C01 |
| Evidence segment layout (§3.7) | Fix what a sealed segment holds for the evidence query | Metering team (layout). RFC-006 history serves the query | — | C06 §12 (with RFC-006) | C01 history query |
| Slice test harness | Contract stubs (§4), end-to-end runs, the time-scaled policy profile, fixtures | Slice test lead | — | — | — |

## 3. Existing code (prior art)

The conformance matrix cites two prototype test files for P3. It marks each citation
*prior evidence, to be re-validated*. No P3 scenario is `met`.

What the cited tests show about the prototype:

- Identity is `(exporterId, sequence)` as sent. C11 identity (exporter, domain, epoch,
  extended sequence) replaces it.
- A record has one `eventTime` and charges one minute. POL-13 spreads a record over its
  active minutes (RFC-003 D28 is not carried forward).
- The minute lock (D26) serialises ingestion and rating. RFC-003 replaces it with a serial
  state machine per account.
- The Kafka test computes the expected charge with round-half-up
  (`(bytes × 10,000 + 5 × 10⁸) / 10⁹`). POL-11 rounds down once.
- Rating writes journals and entries in the same Postgres database. The ledger is now
  RFC-004's. Rating sends charge lines through C06.
- A price correction claws back a paid supplier. POL-23 now makes Share bear it, except a
  supplier's own reduction.
- One transaction per record (the throughput test logs records/s only).

Decision: do not extend `billing/`. Build the five owner kinds as new NestJS modules on the
C01 runtime. Port the test generators and oracles, not the services. When a new test
passes, cite it in the conformance Tests column and remove the prior-evidence citation.

| Prior test (conformance citation) | Scenarios cited | Disposition | Increment |
|---|---|---|---|
| `billing/test/rating.test.ts` › "seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery" | P3-S14, P3-S15, P3-S32, P3-S33 | Port the seeded generator and the in-order versus chaos oracle. Change: C11 identities, spread records, floor rounding, totals read from the C06 charge-line feed, not from wallet journals. Move the "D19 monotone split" check to RFC-004 | I2 (S14), I4 (S15, S32, S33) |
| `billing/test/rating.test.ts` › "concurrent ingestion and rating lose no record (the minute lock)" and "a record that races its minute being rated is still charged (forced interleaving)" | P3-S17 | Retire. Replace with the closure race test of RFC-003 §9: records injected around the closing entry | I4 |
| `billing/test/rating.test.ts` › "a late record is priced at the rate of its own event time, not of its arrival" | P3-S20, P3-S32 | Port the case. Use a flow interval, not an event time; expect a `late_traffic` amendment or a late original | I4 |
| `billing/test/kafka.e2e.test.ts` › "duplicated records on Kafka are ingested once and rated into a balanced ledger" | P3-S14, P3-S15 | Reuse the end-to-end harness pattern (real Kafka, topic set-up, `waitFor`). Records enter through C11 Part I (gRPC), not a Kafka topic. Change the expected charge to floor rounding | I1, I2 |

The other tests in those files (Alabama paradox, supplier claw-back, unbalanced journals,
wallet request-reply, suspend event) test RFC-004 or RFC-002 behaviour. They are not in
this slice.

## 4. Test doubles and test profile

**Rule.** From I1, every increment runs on the real C01 runtime (blocker B-1). Each other
contract is stubbed only by its frozen conformance tests and their fixtures.

| Contract | Stub | Built from |
|---|---|---|
| C11 Part I (exporters) | Reference exporter simulator | C11 tests 14, 15 |
| C11 Part III (provisioning) | Binding producer that passes the published validator | C11 test 22 |
| C08 | Edge principal context; `operator_check`; target-summary key; read grant; audit append | C08 P-01, P-05, P-12, C-01, C-04, C-07, C-08 |
| C09 | Personal-data store | C09 provider tests 1 … 6 |
| C04 | Lifecycle feed producer with closure markers | C04 PL-1 … PL-9, PC-4, PC-6 fixtures |
| C03 | Link schedule feed producer with `CLOSED` markers | C03 PT-4 … PT-8 fixtures |
| C05, C06 §4 | Account owner: applies figures, sends `UsageApplied`, serves `usage_applied_since` | C06 CT-A1, CT-A2, CT-A5; C05 Q5 |
| C06 §7, §9 | Settlement and ledger: posting acknowledgements, ledger movement feed | C06 CT-L1 … CT-L10 |
| F3 (RFC-004) | Lateness-bound reference computation | C05 P7, P14; C06 CT-C4 |

If a provider has not recorded its fixtures yet, the slice test lead builds the stub from
the contract's schema and worked examples. The stub is replaced when the recorded
fixtures arrive (risk P-5).

**Time-scaled policy profile.** `price_notice` and `dispute_window` are 30 days.
`policy_parameters` is data that only a deployment writes (C06-M7). Test deployments set
`price_notice` and `dispute_window` to short values. All other parameters keep their
policy values. Each scenario with a 30-day parameter (P3-S07, P3-S27, P3-S57, P3-S64,
P3-S66, P3-S69, P3-S70, P3-S78) has two tests:

1. a unit test of the boundary function with the literal timestamps of the scenario;
2. an end-to-end test with the scaled profile, against commit timestamps.

## 5. Spikes

The RFC marks these estimates as ones the design depends on. Each spike runs on the C01
runtime and the 2 + 2 + 1 test cluster. Each spike may reuse the measurements of the
RFC-000 R1 spike (RFC-000 R1, R18, R19) where they apply.

| Spike | Estimate (RFC-003) | Measurement | Decision it unlocks | Done before |
|---|---|---|---|---|
| **S-RATE-SP1** ELA size and floor cost | About 50 denominators and 450 B for each usage line; about 110 MB for each rating slot; floor cost (§2, §5.11; R3-19, R3-11) | Distinct reduced denominators for each usage line and ELA bytes, on a flow mix that follows POL-13 (production sample, else the RFC §9 synthetic mix). `bigint` floor time p50 and p99 for each line, at 50 entries and at the worst case (120,000) | `amendment_hot_window` (1 h, or 15 min if ELA bytes are above 2 × est.). Rating memory for each slot | I4 starts |
| **S-RATE-SP2** Ingestion slot throughput and range sets | About 33 commits a second for each slot at 30 ms, about 140 records a transaction, about 4,300 transactions a second, acknowledgement about 85 ms p99; range sets of a few MB for each slot (§3.5, §3.6; R3-1, R3-12, R3-23) | Commit time p99 of a slot batch transaction against record count; acknowledgement p99; 10⁹ records with 1% reordering and 0.01% identity-bearing rejects: intervals, memory, chunk rows; kill the holder in a transaction and compare range-set rows with the log | Slot count (128), flush interval and size (20 ms, 256 KB), chunk size (256 intervals), in-memory window (24 h) | I2 exit |
| **S-RATE-SP3** Closure marker lag | Reservation minute closed 3 to 5 s after its end; usage line margin about 42 s (§5.6, §5.12; R3-5, R3-13) | Lag from the minute end to the per-destination resolved marker on `account.lifecycle.v1`, `link.schedule.v1` and the stage A watermark, through the C01 closure emitter. p50 and p99, steady and during a range-lease move | `usage_close_margin` (15 s or less). Confirm the X2-S13 design points | I4 exit, I8 exit |

## 6. Increments

Increments are in dependency order. An increment may start when its dependencies are done.
Increments with no dependency between them can run in parallel (for example I6 and I17
after I2). Each increment is shippable: it adds behaviour without a break in the earlier
increments' scenarios.

### S-RATE-I1. Walking skeleton

| | |
|---|---|
| Goal | One flow record goes in through C11 Part I. Rating charges it as one usage line. Settlement acknowledges the line through C06. All runs on the real C01 runtime |
| Components | All five owner kinds, at minimum scope. Ingestion: IPFIX, one exporter and domain, one epoch, outcome "accepted" only, `ingest_log` self-outboxed with the hand-off stream. Stage A: a record inside one minute, bind at a covered position, classes attachment and best-effort. Stage B: append, producer watermark. Rating: integer bytes, usage closure by time bound and stage A watermark, one usage line, one figure, publish before emit, one usage batch, `posted` acknowledgement. Catalogue: product, route and `usage_price` from a deployment fixture, on `catalogue.v1` with resolved markers |
| Contracts introduced | C11 v1.0.0 Part I (subset), Part II, Part IV. C06 v1 §2 (subset), §3, §5 (usage batches) |
| Contracts consumed | C01 v1 (owner runtime, slot batch transactions, self-outboxed log and relay, closure emitter, slot groups, account slot map). C11 v1.0.0 Part III. C06 v1 §4, §7. C08 v1.2 §A (principal context) |
| Scenarios | P3-S25 |
| Exit criteria | 1. P3-S25 passes end to end: 1 GB of attachment-class traffic at 12:30 gives one usage line of 10,000 micro-USD. The figure counts 10,000 in `U` until the `posted` acknowledgement, then 0. 2. With the direct publish of `ingest_log` and of the stage A outbox stopped, the relay path alone gives the same line (C11 test 12, first clause). 3. C01 CC-1, CC-6 and CC-8 pass for the five owner kinds. 4. C06 CT-R1 passes for each emitted message (schema, canonical `SourceRef` vectors). C06 CT-R4 first clause passes (no gated usage batch before `UsageApplied`). 5. C11 test 1 passes: no acknowledgement before two-region durability (X2-S14). 6. Baseline recorded (no target yet): acknowledgement p99, acceptance-to-counted p99 |
| Dependencies | C01 v1, C06 v1, C08 v1.2, C11 v1.0.0. **Blocker B-1** |

### S-RATE-I2. Record identity, deduplication and outcomes

| | |
|---|---|
| Goal | Each received record gets exactly one durable outcome. Its identity is stable for 7 years, across wraps, restarts and redelivery |
| Components | Metering ingestion: identity for IPFIX and NetFlow v9; epochs (`epoch_jitter`), context table, 24 h context memo; wrap anchors; range-set chunks in the batch transaction; NetFlow v9 exception set; duplicate entries with digest; asynchronous content check and `identity-conflict` entries; each C11 `RejectReason` with its reject key; export format fixed for each exporter; options-template rule; insert-only grants. Export-clock gap monitor (R3-2). Epoch-set safeguard alert (R3-23). Stage A: forwards `identity-conflict` events; their quarantine comes in I15 |
| Temporary rule | Until I17, ingestion does not commit or acknowledge a batch that holds a non-conforming payload. The exporter resends it. So no personal data reaches a log (RFC-000 A11). I17 removes this rule |
| Contracts introduced | C11 v1.0.0 Part I (full, except non-conforming payloads, corrections and supersessions) |
| Contracts consumed | C01 v1, C08 v1.2 (credentials, revocation) |
| Scenarios | P3-S14, P3-S16, P3-S28, P3-S29, P3-S31, P3-S50 |
| Exit criteria | 1. The six scenarios pass. 2. C11 tests 2, 3, 4 (a … g), 5, 6 (template refusal, direction and interface rules; not the marker scan) and 13 pass. 3. An UPDATE or DELETE on `ingest_log` by any application role fails. The console stub records a refused attempt (P3-S31). 4. The SP2 decisions are applied. Acknowledgement p99 ≤ 1 s at the SP2 peak load for each slot (X2-S14, X2-S18 limit). 5. The prior-evidence Kafka test is re-run as an I2 test through C11 Part I with floor rounding |
| Dependencies | I1, SP2 |

### S-RATE-I3. Spread and exact usage lines

| | |
|---|---|
| Goal | Spread each record over its active minutes. Price each usage line exactly and round it down once |
| Components | Stage A: spread (half-open minutes, `e = s` case, exact fractions), alert for a record longer than `flow_active_timeout` + 60 s. Rating: exact line accumulator (ELA) with `bigint`; line formula; price of the line's own minute; one line for each (account, product, route, minute) |
| Contracts introduced | — (C11 Part IV `Part` carries exact fractions from I1) |
| Contracts consumed | C06 v1 §2 (price versions) |
| Scenarios | P3-S18, P3-S19, P3-S21, P3-S48, P3-S51, P3-S52 |
| Exit criteria | 1. The six scenarios pass. 2. The ELA property test of RFC-003 §9 passes: random records, spreads and negated parts against an independent rational reference; every floor equal, sums within 10⁻¹⁸ of an integer included. 3. C06 CT-R1 vectors pass for lines on two routes |
| Dependencies | I1 |

### S-RATE-I4. Late traffic and amendments by total

| | |
|---|---|
| Goal | Close each usage line once. Amend a closed line by its new total when late records arrive. The total does not depend on order |
| Components | Rating: usage closure with `usage_close_margin` and the 45 s stalled-watermark bound; emitted total `E`; amendment sequence; `amendment_interval` batching; late originals (`original`, `triggerRef`); closed-line ELA kept for `amendment_hot_window`, then read back from `rating_log`; lateness from the last minute end |
| Contracts introduced | C06 v1 §5 (amendments: `amount`, `newTotal`, `priorTotal`, `reason` `late_traffic`) |
| Contracts consumed | C06 v1 §7 |
| Scenarios | P3-S15, P3-S17, P3-S20, P3-S32, P3-S33, P3-S35 |
| Exit criteria | 1. The six scenarios pass. 2. Order independence (RFC-003 §9): one record set in order, and shuffled with 30% duplicates and 20% after closure, gives equal posted totals for each line. This is the port of the prior seeded test. 3. Closure race (RFC-003 §9): records injected around the closing entry under load are each in the original or in an amendment, exactly once. 4. A stalled stage A partition: usage lines close at the bound + 45 s; late records become amendments (R3-6). 5. An amendment of a line older than `amendment_hot_window` reads the line back from `rating_log`. 6. P3-S35: for a minute with an original and two amendments, the charge-line feed carries each with its reason and emission time; the settlement stub (C06 CT-L7 fixture) shows each posting time. 7. X2-S13: usage line posted ≤ 300 s after the minute end, at steady load on the test cluster (design 258 s) |
| Dependencies | I3, SP1, SP3 |

### S-RATE-I5. Posting acknowledgements and exactly-once emission

| | |
|---|---|
| Goal | Each line reaches the ledger once, whatever repeats, refusals and restarts occur |
| Components | Rating: each exclusion reason (re-base on `content_conflict` and `prior_total_mismatch`; `out_of_sequence`; `invalid` parks; `batch_refused` into a new usage batch named in a new figure; `batch_over_limit` splits); `k + 1` only after `k` is `posted`; one sequence for each line key in a usage batch; movement limit `L` = 5,000; parking alerts (C06-M11); `resolve_parked` (finance envelope, `admitCommand`); re-emission after a takeover |
| Contracts introduced | C06 v1 §13 (`resolve_parked`) |
| Contracts consumed | C06 v1 §7; C08 v1.2 (operator envelope, `operator_check`); C01 v1 (`CommandEnvelope`, `admitCommand`) |
| Scenarios | P3-S12 |
| Exit criteria | 1. P3-S12 passes: a minute charged several times, at the same time and in sequence, charges each record once. 2. C06 CT-R3 (usage batches), CT-R7, CT-R8, CT-R12, CT-C2 and CT-C5 pass. 3. C01 CC-5 passes as a receiver. 4. Restart test, first half (RFC-003 §9): kill rating holders in a batch and in an emission, and stop the direct publish; no line is missing or posted twice |
| Dependencies | I4 |

### S-RATE-I6. Catalogue writes and price rules

| | |
|---|---|
| Goal | Operators set catalogue entities through C08 envelopes. The catalogue enforces each write rule |
| Components | Catalogue: products; routes; price series with `announced_at`, `effective_from`, `oe_effective`; split weights; partner terms; `account_product_terms` (`usage_rate_cap`); `policy_parameters` (deployment only); probe designations of links, exporters and the probe supplier (no probe accounts). Four eyes for prices and weights, with the preconditions checked again at application. Target summaries `product_route`, `account_product`, `supplier_terms`, `partner`. Audit append before each answer. A repeated `action_id` gets the recorded outcome |
| Contracts introduced | C06 v1 §2 (full) |
| Contracts consumed | C08 v1.2 (§E envelope, §F `operator_check`, §G target summary); C01 v1 |
| Scenarios | P3-S69, P3-S76 |
| Exit criteria | 1. P3-S69: a `usage_price` version with less than `price_notice` lead is refused at approval, for each of the three kinds of traffic. 2. P3-S76: a cap version with `effectiveFrom` before `ceil_min(recordedAt + 60 s)` is refused and never on the feed; the four rows give 53,750, 26,875, 53,750 and 107,500 from the F3 reference (§4) fed with this catalogue's events. 3. C06 CT-R2 passes; CT-C6 third clause passes (only the catalogue writes `catalogue.v1`). 4. C08 C-04 and C-07 pass for the catalogue. 5. Validation parts of X1-S12 and X1-S31: a price or weight approved by its requester, and an action by another role, are refused and recorded |
| Dependencies | I1. **Blocker B-3** for the route-leg check only: I6 ships without that check, and adds it when the link-registry feed is frozen |

### S-RATE-I7. Usage exposure, publish before emit and breach reports

| | |
|---|---|
| Goal | Each account's unposted usage reaches the account owner within `attribution_lag_max`, exact against the ledger balance. Breaches of the bound's assumptions are reported |
| Components | Rating: figures for each product of the attachment set and each product with a line not fully posted; `U(X)`, `X`, the in-flight usage batch and `Δ_b`; 2 s coalescing; publish before emit with the maximum `appliedThrough`; gap recovery by replay, then `usage_applied_since`; accrued reservation charges (information); attribution-lag and lateness breaches; the X2-S22 measure for each minute and serving region; consumer-lag alert for each partition (R3-14). Stage B: attachment set by valid time |
| Contracts introduced | C06 v1 §3 (full), §11 (breach report feed) |
| Contracts consumed | C06 v1 §4; C05 v1 (`usage_applied_since`, S-4) |
| Scenarios | P3-S37, P3-S38, P3-S61, P3-S62, P3-S68 |
| Exit criteria | 1. The five scenarios pass. P3-S37: `U` = 2,000 (C06 CT-R5); with the F3 reference (§4), lateness bound 53,750 and exposure 55,750. 2. C06 CT-R4 (full) and the rating side of CT-A5 pass. C11 test 24, first sentence, passes. 3. Publish before emit and exact pairing (RFC-003 §9): delay `UsageApplied` and the ledger movement feed independently; no usage posting reaches the ledger before its figure is applied; headroom equals the exact value at each applied pair (with the C06 CT-C3 fixtures). 4. Attribution lag (RFC-003 §9): stop a stage B holder for 15 s; each record accepted meanwhile is reported with its exporter and lag. 5. X2-S22: acceptance to counted p99 ≤ 10 s at steady load (design 2.5 s), and ≤ 10 s with one takeover |
| Dependencies | I5, I6 |

### S-RATE-I8. Reservation accrual and reservation batches

| | |
|---|---|
| Goal | Each active minute of a reservation gives one reservation line, from the lifecycle feed, closed only on per-destination markers |
| Components | Rating: reservation model (parts, rates over effective intervals, locked prices, ends and end causes); effective minutes from the lifecycle feed (three early-effective events; release at `nb(ts)`; least `effective` of two ends); last-in-first-out check and alert; reservation closure on the lifecycle marker and `CLOSED(t, feed_seq)` of each Share link (no reductions yet); `feed_seq` gaps; per-reservation accrual watermark; reservation batches ≤ `L`, up to 8 in flight, minute order for each reservation; C04 consumer rules (ignored kinds, `rating_ignorable`, stop on an unknown kind or a conflicting identity); probe accounts from the slot map only, `account_is_probe` checked |
| Contracts introduced | C06 v1 §5 (reservation batches) |
| Contracts consumed | C04 v2.3.1 (`account.lifecycle.v1`); C03 v2.4 (`CLOSED`, `feed_seq`); C01 v1 (account slot map) |
| Scenarios | P3-S01, P3-S02, P3-S03, P3-S04, P3-S05, P3-S06, P3-S09, P3-S40, P3-S42, P3-S45, P3-S46 |
| Exit criteria | 1. The eleven scenarios pass. 2. C04 CR-1 and CR-6 pass. C03 CT-3.5 passes. C06 CT-R3 (5,001 lines in a minute give two reservation batches with disjoint reservations) and CT-C6 (probe accounts only from the slot map) pass. 3. Closure on resolved markers (RFC-003 §9): kill the account owner stub, then the link owner stub, during a minute; reservation lines still close within 10 s of the minute end. 4. X2-S13: reservation line posted ≤ 2 min after the minute end (design: emitted in about 6 s). 5. X2-S20: probe accounts give no line and no figure |
| Dependencies | I5, SP3 |

### S-RATE-I9. Reductions, POL-07 cuts and affected marks

| | |
|---|---|
| Goal | Hold closure for open reductions. Accrue cut rates. Amend minutes that a late cut covers. Publish affected marks |
| Components | Rating: `hold_1` and `hold_2` from `CAPACITY_CHANGED`, `REDUCTION_EFFECTIVE` chunks, `REDUCTION_SET_EXTENDED`, `CUT_DECIDED` revisions and `REDUCTION_FINAL`; cut part rates checked against the `min` of targets for each minute; `late_pol07_cut` amendments; hold alert after 60 s (R3-18) and liveness alarm after 1 h; affected marks from `AFFECTED_CHANGED` and `partner_leg_affected`; maintenance gives no line |
| Contracts introduced | C06 v1 §6 (`rating.affected-marks.v1`); C06 v1 §5 `lateCut` (under the CI3-1 reading) |
| Contracts consumed | C03 v2.4 (full consumer side); C04 v2.3.1 (`cut`, `ended(revoked)`, `partner_leg_affected`) |
| Scenarios | P3-S08, P3-S10, P3-S47, P3-S58 |
| Exit criteria | 1. The four scenarios pass. 2. C03 CT-3.1, CT-3.2, CT-3.3, CT-3.4, CT-3.6, CT-3.7 and CT-3.8 pass. C04 CR-2, CR-3 and CR-7 (accrual part) pass. 3. C06 CT-R6 passes under the CI3-1 reading (risk P-1). 4. Closure under an open reduction (RFC-003 §9): final step delayed 30 s; affected minutes held, then emitted at the cut rate in minute order; other reservations of the account close on time; no affected minute at the old rate. 5. A `partner_leg_affected` event marks the leg affected from `from`, source `partner_leg`, and does not lower a charge (CI3-3 reading) |
| Dependencies | I8 |

### S-RATE-I10. Price corrections

| | |
|---|---|
| Goal | Finance corrects a price within `dispute_window`. Rating amends each line concerned, with the operator, cause and reason |
| Components | Catalogue: correction command (role finance; window against the commit timestamp; a reservation price only downward against its effective price; repeat by source reference); locked-price read model of the lifecycle feed; the pricing module shared with rating. Rating: corrections applied as `min(corrected, effective)` for a reservation price; `price_correction` amendments; paced fan-out and progress report (R3-7) |
| Contracts introduced | C06 v1 §2 (price corrections); C08 target summary `charge` (with rating) |
| Contracts consumed | C04 v2.3.1 (read model); C08 v1.2 |
| Scenarios | P3-S34, P3-S55, P3-S56, P3-S57, P3-S70 |
| Exit criteria | 1. The five scenarios pass, each as a literal-time unit test and as a scaled end-to-end test (§4). P3-S70: 10:00:59 on day D + 30 accepted, 10:01 refused. 2. C06 CT-R10 passes. 3. A route correction over the whole scaled `dispute_window` amends each line; no usage batch holds more than `L` lines; reservation and usage originals still meet X2-S13; progress is reported to the operator |
| Dependencies | I6, I8 |

### S-RATE-I11. Moves, open-ended re-pricing and dearer-path cost lines

| | |
|---|---|
| Goal | Charge a moved reservation at the lower price and label its lines with the path's route. Re-price open-ended reservations at `oe_effective`. Emit the dearer-path cost line |
| Components | Rating: `moved` (route ID, shown path price, part rates from `move_at`); `price_step` checked against the catalogue's `oe_effective`, alert on a mismatch; rules 1 to 4 of RFC-003 §5.2; price as booked; dearer-path cost lines with route and weights version; cost-line source references with amendment sequence |
| Contracts introduced | C06 v1 §5 (cost lines `dearer_path`) |
| Contracts consumed | C04 v2.3.1 (`moved`, `price_step`); C06 v1 §2 (`oeEffective`) |
| Scenarios | P3-S07, P3-S59, P3-S64 |
| Exit criteria | 1. The three scenarios pass (P3-S07 as a literal-time unit test and a scaled end-to-end test). 2. C04 CR-5 passes. C06 CT-R9 rows P4-S110 (dearer path `"4"`, route = the path) and P4-S115 (buyer amendment `"-1"`, cause share, no dearer-path amendment) pass. 3. Moves test (RFC-003 §9): a reservation correction to 1.8 after a move to a path at 1.5 is refused; when it races the move, it is applied as `min` |
| Dependencies | I10 |

### S-RATE-I12. Fee lines

| | |
|---|---|
| Goal | Charge each shown fee by the POL-08 rules, once, to the party the lifecycle feed names |
| Components | Rating: fee and Share-borne fee lines from `ShownFee`, `FeeDue` on `ended`, `shortened` and `moved.fees_due`; check against the RFC-003 §5.4 tables and alert on a mismatch; one `fee` entry for each fee ID; `payee`; residue fees from `pol28_residue`; any `FeeDue` with payer `share` gives a Share-borne line (CI3-4 reading) |
| Contracts introduced | C06 v1 §5 (`fee`, `share_borne_fee`) |
| Contracts consumed | C04 v2.3.1 |
| Scenarios | P3-S11, P3-S43, P3-S44, P3-S60, P3-S63, P3-S74 |
| Exit criteria | 1. The six scenarios pass. 2. C04 CR-4 and CR-7 (fee part) pass. C06 CT-R11 passes. 3. Fees test (RFC-003 §9): shortens into and past a minimum term, then a cancellation, give one fee line at most; a plain fee on a shorten gives none; 10-day and 30-day windows on a 30-day term; a 10-day window extended to 40 days gives none; shortened to 5 days, charged once at the shorten. 4. A residue event (C04 PL-9 fixture) gives one Share-borne line keyed by the request |
| Dependencies | I8 |

### S-RATE-I13. Reservation traffic by the POL-17 rule

| | |
|---|---|
| Goal | Apply POL-17 for each reservation minute: covered, burst, excess or outside |
| Components | Rating: ELA of a reservation's egress bytes for each minute; `A = rate × 7,500,000`; burst to the usage line; excess as a carried-excess cost line and an incident on the C01 alert feed for each reservation and run of minutes; outside an active reservation to the usage line; tenancy check T2 |
| Contracts introduced | C06 v1 §5 (cost lines `carried_excess`) |
| Contracts consumed | C01 v1 (alert feed) |
| Scenarios | P3-S22, P3-S23, P3-S24, P3-S41, P3-S53, P3-S54 |
| Exit criteria | 1. The six scenarios pass. 2. C11 test 26 (T2) passes. 3. P3-S41: one incident for each reservation and run of consecutive excess minutes, updated while it lasts (R3-3) |
| Dependencies | I8, I11 |

### S-RATE-I14. Egress, attachment and tenancy in attribution

| | |
|---|---|
| Goal | Bill each traffic once, at its egress. Enforce the tenancy invariants |
| Components | Stage A: egress flag and egress groups; non-egress parts counted only; probe class (exporter, link or account); T1 and T3; parts with no link attributed and alerted; binding facts kept in `attr_a_log` and state rebuilt from it; feed-lag alert after 1 day. Stage B: attachment set from forwarded facts (old and new account); T4 hold, release and drop |
| Contracts introduced | — (C11 Part IV binding-fact forwarding, full) |
| Contracts consumed | C11 v1.0.0 Part III (full) |
| Scenarios | P3-S49, P3-S67 |
| Exit criteria | 1. P3-S49 (9,800 micro-USD for the 0.98 GB egress) and P3-S67 (1.0 GB at the hand-off) pass. 2. C11 tests 18 (binding and stale-binding clauses), 19, 21, 24 (second sentence) and 25 pass. 3. X2-S20: records of a probe exporter or a probe supplier's link never reach rating |
| Dependencies | I7 |

### S-RATE-I15. Quarantine, finance attribution and reversal

| | |
|---|---|
| Goal | Keep unattributable traffic in quarantine. Report it. Charge it only when finance attributes it within `dispute_window`. Reverse a mistaken attribution at Share's cost |
| Components | Stage A: pending-binding hold (`binding_grace`); quarantine reasons "no binding", "domain not of exporter", "ambiguous binding", "identity conflict"; quarantine entries with link and supplier; attribution and reversal commands (finance envelope, window, repeat by source reference, 7-year reference store); target summary `quarantine_item`; quarantine volume alert for each link (R3-4). Rating: `quarantine_attribution` late originals and amendments; `attribution_reversed` amendments, cause Share; finance-attributed parts excluded from attribution-lag breaches |
| Contracts introduced | C06 v1 §10 (`rating.quarantine-report.v1`, under the CI3-2 reading) |
| Contracts consumed | C08 v1.2; C11 v1.0.0 Part III (observation-point facts) |
| Scenarios | P3-S26, P3-S27, P3-S65, P3-S77 |
| Exit criteria | 1. The four scenarios pass (P3-S27 as a literal-time unit test and a scaled end-to-end test). 2. C11 test 18 (hold and quarantine clauses, F57-10) passes. An identity conflict is quarantined under its conflict identity (C11 S-2). 3. C06 CT-R13 passes. 4. Attribution and reversal test (RFC-003 §9): attribute, reverse, attempt to attribute again, repeat each command, once at the window boundary. 5. Unposted usage beyond the attachment set (RFC-003 §9): an attribution to a product the account does not attach is counted in `U` until posted and raises no attribution-lag breach. 6. The supplier view of the report shows only the supplier's links; an entry with no link goes to the exporter's owner (CI3-2 reading) |
| Dependencies | I14. **Blocker B-3** for the supplier of a link |

### S-RATE-I16. Corrected records and superseding records

| | |
|---|---|
| Goal | Let only the producing exporter correct a rejected record or supersede an accepted one, within its deadline. Charge the result once, in the original's disposition |
| Components | Ingestion: correction checks in C11 order (idempotency first, deadline from the earlier of the last minute end and the first receipt, receipt bound, domain); corrected-key index; supersession checks against the original (measured fields only, within the original's minutes, version order); refused attempts recorded. Stage A: negate the replaced version, spread the new one in the original's disposition for each minute. Rating: `corrected_record` and `superseding_record` amendments; downward cause = the exporter's owner; cost-line amendment rules (RFC-003 §5.5) |
| Contracts introduced | C11 v1.0.0 Part I (correction and supersession messages), Part II (`correction`, `supersession` rows) |
| Contracts consumed | C08 v1.2 (certificate serial, principal) |
| Scenarios | P3-S30, P3-S66, P3-S72, P3-S73, P3-S78 |
| Exit criteria | 1. The five scenarios pass (P3-S66 and P3-S78 as literal-time unit tests and scaled end-to-end tests). 2. C11 tests 10, 11 and 20 pass. 3. RFC-003 §9 tests "Corrections and supersessions", "Supersession scope" and "Supersession dispositions" pass. 4. C06 CT-R9 rows P4-S116 pass: carried excess lowered by a Share exporter's version (cause share), by supplier A's exporter's version (cause A), and by a `usage_price` correction |
| Dependencies | I2, I10, I13, I15 |

### S-RATE-I17. Non-conforming payloads

| | |
|---|---|
| Goal | Reject a non-conforming payload. Keep only its identity, keyed digest and reason in the log. Put the payload only in the erasable store, if the store takes it in time. Count and report each drop |
| Components | Ingestion: keyed digest with `digest_key` (fetched at lease acquisition, version recorded); `put_payload` with `keep_by`; four keep outcomes and "unanswered, withdrawal pending"; `withdraw_payload` with retries and `withdrawn` entries; one pending head batch when no key is cached; `drop-alert` and `drop-count` streams of `ingest_log`; pending-withdrawal alert after 10 min. Removes the I2 temporary rule |
| Contracts introduced | C11 v1.0.0 Part I (non-conforming payloads, `notice{waiting}`); drop alert and drop report on the C01 alert feed |
| Contracts consumed | C09 v1.1; C01 v1 (alert feed) |
| Scenarios | P3-S71, P3-S75 |
| Exit criteria | 1. P3-S71 and P3-S75 pass. 2. C11 tests 6 (marker scan of each topic, table, log and trace), 7, 8 and 9 pass. 3. C09 consumer tests pass: unanswered puts withdrawn; `not_kept(erased)`; `received_at` on the withdrawal; the recorded key version in the dispute check. 4. RFC-003 §9 tests "Non-conforming payloads" and "Drops counted and reported" pass against the C09 stub; erasure and expiry are checked through C09 provider fixtures 4 and 6. 5. Conforming batches and the ingestion probe are acknowledged within 1 s while the store is unavailable (X2-S18) |
| Dependencies | I2 |

### S-RATE-I18. Reproducibility and cold re-rate

| | |
|---|---|
| Goal | Recompute any period exactly from retained inputs. Rebuild a rating partition without its log and charge nothing twice |
| Components | Rating: continuous re-rater on sampled account-days, alert on a difference; on-demand recomputation; cold re-rate from inputs in commit-timestamp order and the ledger movement feed (skip triggers by `triggerRef`, residual `re_rate`: upward with no cause, downward with cause Share) |
| Contracts introduced | — |
| Contracts consumed | C06 v1 §9 (`ledger.movements.v1`) |
| Scenarios | P3-S13, P3-S36 |
| Exit criteria | 1. P3-S13 and P3-S36 pass. 2. The re-rater finds zero difference over a seeded run with each trigger kind (late traffic, corrections, attributions, reversals, supersessions, late cuts, moves, fees). 3. Restart test, second half (RFC-003 §9): cold re-rate after the partition log is removed; no line missing or posted twice. 4. The `re_rate` part of C06 CT-R7 passes |
| Dependencies | I9, I11, I12, I16 |

### S-RATE-I19. Evidence segments and the evidence query

| | |
|---|---|
| Goal | Retrieve every accepted record of a reservation or a link over a minute range, with its versions |
| Components | Metering: segment content (sort order, block statistics, sparse identity index, each outcome, contexts). Evidence query semantics over the binding history and the segment index. Read grant and audit before the answer |
| Contracts introduced | C06 v1 §12 (with RFC-006 history) |
| Contracts consumed | C01 v1 (history query); C08 v1.2 (read grant) |
| Scenarios | P3-S39 |
| Exit criteria | 1. P3-S39 passes for a reservation and for a link, with superseded versions shown. 2. A non-conforming reject shows only identity, keyed digest, key version and reason. 3. C08 C-08 passes for the evidence reader. 4. X2-S11: records retrieved across the live tail and the archive boundary (C01 CP-12 run as a consumer check) |
| Dependencies | I2, I14, I16. **Blocker B-2** |

### S-RATE-I20. Hot standbys, moves and the design-load proof

| | |
|---|---|
| Goal | Show the availability, recovery and timeliness targets at the design load |
| Components | All owner kinds: hot standbys in the other Kenyan region; slot-group takeover; `onMovedOut`, `onAdopt` (a hot exporter moved to its own slot); `Stopped`; checkpoints every 10 s |
| Contracts introduced | — |
| Contracts consumed | C01 v1 (move protocol, integrity stop) |
| Scenarios | — (each P3 scenario is placed in I1 … I19) |
| Exit criteria | 1. C01 CC-2, CC-3, CC-4 and CC-7 pass for each owner kind. 2. X2-S10: takeover p99 about 5 s (est.); within 1 min for usage ingestion and the 5 min ceiling for rating and posting. 3. X2-S09, X2-S12: no accepted record lost at the loss of a node, a zone or a region. X2-S02: ingestion lags but loses nothing while credit runs out. 4. X2-S13 at the design profile: reservation lines ≤ 2 min, usage lines ≤ 300 s; ≤ 7 min and + 5 min after a zone loss. 5. X2-S22 ≤ 10 s at the design profile. 6. X2-S19, X2-S23: in a declared disaster, minutes posted within target + 1 h, none lost or posted twice. 7. X2-S04: with RFC-006's load test (600,000 records/s for 1 h, 1 M reservation lines/s), transaction rates are within RFC-003 §1.2 (R3-12) and rating memory for each slot is within the SP1 figure |
| Dependencies | I1 … I19. **Blocker B-1** (load-test rig and 2 + 2 + 1 topology) |

## 7. Scenario map

Each P3 scenario maps to exactly one increment. Check:
`rg -o '^\| P3-S[0-9]+' docs/04-delivery/plan/S-RATE.md | sort | uniq -d` (no duplicates) and
compare `rg -o '@P3-S[0-9]+' docs/02-specs/P3-rating-and-metering.feature` with the rows
(no orphans).

| Scenario | Increment | RFC-003 section |
|---|---|---|
| P3-S01 | S-RATE-I8 | §2, §5.2 |
| P3-S02 | S-RATE-I8 | §5.2 |
| P3-S03 | S-RATE-I8 | §5.2 |
| P3-S04 | S-RATE-I8 | §5.2 |
| P3-S05 | S-RATE-I8 | §5.2 |
| P3-S06 | S-RATE-I8 | §5.2 |
| P3-S07 | S-RATE-I11 | §5.2, §6.2 |
| P3-S08 | S-RATE-I9 | §5.2, §5.6 |
| P3-S09 | S-RATE-I8 | §5.2 |
| P3-S10 | S-RATE-I9 | §5.2 |
| P3-S11 | S-RATE-I12 | §5.4 |
| P3-S12 | S-RATE-I5 | §5.6, §5.8 |
| P3-S13 | S-RATE-I18 | §5.8, §5.10 |
| P3-S14 | S-RATE-I2 | §3.3, §3.5 |
| P3-S15 | S-RATE-I4 | §2, §5.7 |
| P3-S16 | S-RATE-I2 | §3.5, §5.7 |
| P3-S17 | S-RATE-I4 | §5.6 |
| P3-S18 | S-RATE-I3 | §4.2 |
| P3-S19 | S-RATE-I3 | §4.2 |
| P3-S20 | S-RATE-I4 | §5.3, §5.7 |
| P3-S21 | S-RATE-I3 | §2 |
| P3-S22 | S-RATE-I13 | §5.3 |
| P3-S23 | S-RATE-I13 | §5.3 |
| P3-S24 | S-RATE-I13 | §5.3 |
| P3-S25 | S-RATE-I1 | §5.3, §5.9 |
| P3-S26 | S-RATE-I15 | §4.2, §4.4 |
| P3-S27 | S-RATE-I15 | §4.4, §5.7 |
| P3-S28 | S-RATE-I2 | §3.3 |
| P3-S29 | S-RATE-I2 | §3.3 |
| P3-S30 | S-RATE-I16 | §3.3 |
| P3-S31 | S-RATE-I2 | §3.3 |
| P3-S32 | S-RATE-I4 | §5.7 |
| P3-S33 | S-RATE-I4 | §5.7 |
| P3-S34 | S-RATE-I10 | §6.3, §5.7 |
| P3-S35 | S-RATE-I4 | §5.7 |
| P3-S36 | S-RATE-I18 | §5.10 |
| P3-S37 | S-RATE-I7 | §5.9 |
| P3-S38 | S-RATE-I7 | §2, §5.9 |
| P3-S39 | S-RATE-I19 | §3.7 |
| P3-S40 | S-RATE-I8 | §5.2 |
| P3-S41 | S-RATE-I13 | §5.5 |
| P3-S42 | S-RATE-I8 | §5.2 |
| P3-S43 | S-RATE-I12 | §5.4 |
| P3-S44 | S-RATE-I12 | §5.4 |
| P3-S45 | S-RATE-I8 | §5.2 |
| P3-S46 | S-RATE-I8 | §5.2 |
| P3-S47 | S-RATE-I9 | §5.2 |
| P3-S48 | S-RATE-I3 | §5.3, §2 |
| P3-S49 | S-RATE-I14 | §4.1, §4.2, §5.3 |
| P3-S50 | S-RATE-I2 | §3.2 |
| P3-S51 | S-RATE-I3 | §2, §4.2 |
| P3-S52 | S-RATE-I3 | §5.3, §4.2 |
| P3-S53 | S-RATE-I13 | §5.3 |
| P3-S54 | S-RATE-I13 | §5.3 |
| P3-S55 | S-RATE-I10 | §6.3, §5.7 |
| P3-S56 | S-RATE-I10 | §6.3, §5.2 |
| P3-S57 | S-RATE-I10 | §6.3 |
| P3-S58 | S-RATE-I9 | §5.2, §5.6 |
| P3-S59 | S-RATE-I11 | §5.2, §5.5 |
| P3-S60 | S-RATE-I12 | §5.4, §5.8 |
| P3-S61 | S-RATE-I7 | §5.9 |
| P3-S62 | S-RATE-I7 | §5.9 |
| P3-S63 | S-RATE-I12 | §5.4 |
| P3-S64 | S-RATE-I11 | §5.2, §6.2 |
| P3-S65 | S-RATE-I15 | §4.4, §5.7 |
| P3-S66 | S-RATE-I16 | §3.3, §4.2, §5.7 |
| P3-S67 | S-RATE-I14 | §4.1 |
| P3-S68 | S-RATE-I7 | §2, §5.6, §5.9 |
| P3-S69 | S-RATE-I6 | §6.2 |
| P3-S70 | S-RATE-I10 | §2, §6.3 |
| P3-S71 | S-RATE-I17 | §3.3, §3.4 |
| P3-S72 | S-RATE-I16 | §3.1, §3.3 |
| P3-S73 | S-RATE-I16 | §4.2, §4.4 |
| P3-S74 | S-RATE-I12 | §5.4 |
| P3-S75 | S-RATE-I17 | §3.3, §3.4 |
| P3-S76 | S-RATE-I6 | §5.9, §6.1 |
| P3-S77 | S-RATE-I15 | §3.3, §4.2, §4.4 |
| P3-S78 | S-RATE-I16 | §3.3 |

Count for each increment: I1 1, I2 6, I3 6, I4 6, I5 1, I6 2, I7 5, I8 11, I9 4, I10 5,
I11 3, I12 6, I13 6, I14 2, I15 4, I16 5, I17 2, I18 2, I19 1, I20 0. Total 78.

**X2 parts (measurements, not in the one-to-one check):** X2-S14 (I1, I2); X2-S18 (I2,
I17); X2-S13 (I4, I8, I10, I20); X2-S22 (I7, I20); X2-S20 (I8, I14); X2-S11 (I19); X2-S02,
X2-S04, X2-S09, X2-S10, X2-S12, X2-S19, X2-S23 (I20).

## 8. Risks

### 8.1 RFC-003 risks

| RFC risk | Disposition | Work item or reason |
|---|---|---|
| R3-1 Load figures are estimates | Work item | SP2, SP3; the design profile for RFC-006's load test (I20) |
| R3-2 Exporter clocks | Work item | I2: monitor the export-to-acceptance gap for each exporter; reject `flow time in the future` |
| R3-3 Byte accounting versus policing | Work item, partly accepted | I13: excess incidents surface a mismatch. The octet layer is fixed in the delivery contract with network operations, outside this slice |
| R3-4 Provisioning lag | Work item | I1 and I14: bind only at a covered position. I15: `binding_grace` and the quarantine volume alert for each link |
| R3-5 Resolved-marker lag | Work item | SP3 |
| R3-6 Stalled stage A partition | Work item | I4 exit criterion 4 (45 s bound) |
| R3-7 Correction fan-out | Work item | I10 exit criterion 3 (pacing, progress) |
| R3-8 Very old usage lines | Accepted | Rare under the reliable-source assumption. I4 reads lines back from `rating_log`; I18 reads from history segments |
| R3-9 Publish before emit couples posting | Work item | I7 exit criteria 2 and 3; measured in I20 |
| R3-10 Storage over 7 years | Accepted | RFC-006 owns sealing and storage cost. I19 fixes only the segment content |
| R3-11 `bigint` floor CPU | Work item | SP1 |
| R3-12 Database transaction rate | Work item | SP2 and the RFC-000 R1 spike; I20 exit criterion 7 |
| R3-13 Usage line margin | Work item | SP3; I4 exit criterion 7; I20 exit criterion 4 |
| R3-14 Kafka consumer lag | Work item | I7: lag alert for each partition; I20 |
| R3-15 Payload expiry depends on the store's keys | Accepted here | RFC-005 holds the expiry keys. I17 checks expiry only through C09 provider fixtures |
| R3-16 Non-conforming flood | Work item | I17: caps, drops counted and reported |
| R3-17 Larger lateness bound | Accepted | Decided by the requirements (Q-1, v1.8). Finance can lower `usage_rate_cap` |
| R3-18 Closure held by an open reduction | Work item | I9: alert after 60 s, liveness alarm after 1 h |
| R3-19 ELA size | Work item | SP1 |
| R3-20 A cost-line correction reversed by a later one | Accepted | No exposure: RFC-004 M23 never pays a party twice |
| R3-21 Withdrawal pending while the store is down | Work item | I17: retries, rebuild after takeover, alert after 10 min |
| R3-22 Partition stalled on its digest key | Work item | I17: C11 test 7; keys fetched at lease acquisition |
| R3-23 Epoch sets grow with drift | Work item | SP2; I2 safeguard alert |
| R3-24 T4 or T2 hold | Work item | I13 (T2), I14 (T4): counted in `U`, alerted, dropped at `dispute_window` |

### 8.2 Contract defects (CI3-1 … CI3-4)

These do not block. Each increment uses the reading that RFC-003 adopts. If the contract
owner amends the contract, the increment changes to the amended form.

| # | Defect | Reading used | Risk to the plan | Increment |
|---|---|---|---|---|
| P-1 (CI3-1) | C06 `lateCut` names an `extensionChunk`. C03, C04 and RFC-000 key a late cut by (link, reduction) and the target revision. A cut from a Final offer has no extension chunk | `extensionChunk` = the extension number of the set that listed the reservation (0 for any other path); `targetRevision` in `reasonDetails` | C06 CT-R6, C03 CT-3.4 and C04 CR-3 expect the revision in the key; a test harness that reads `lateCut` strictly can fail. Settlement's posting does not change (the key is the `SourceRef`) | I9 |
| P-2 (CI3-2) | C06 quarantine report has no reason `domain_not_of_exporter`, and `link` and `supplier` are required | Publish the reason as text; for an entry with no link, `link` = `""` and `supplier` = the exporter's owner | A strict schema check (CT-R1) or a consumer can refuse the event. P3-S77's report to the owner depends on the supplier filter | I15 |
| P-3 (CI3-3) | C04 `partner_leg_affected` has no delivered figures; C12 S1 says rating charges only the delivered figures | Mark the leg affected from `from`; charge the part rates of the lifecycle feed; never lower a charge by itself | If the requirements owner decides that the buyer pays only for delivered figures, the account owner must send a rate change. Rating already charges it exactly; no rework expected | I9 |
| P-4 (CI3-4) | C04 `shortened` carries only the buyer's minimum-term fee; C12 S1 makes Share bear a plain fee on a shorten without amend | Emit a Share-borne line from any `FeeDue` with payer `share` | Until C04 carries it, the plain fee reaches Share's books only through C12 reconciliation. No P3 scenario fails; the cost line is missing | I12 |

### 8.3 Plan risks

| # | Risk | Mitigation |
|---|---|---|
| P-5 | Provider fixtures for C03, C04, C06 CT-A and CT-L are not recorded yet | Build stubs from the contract schemas and worked examples (§4); replace them when recorded fixtures arrive; re-run the consumer tests then |
| P-6 | 30-day parameters (`price_notice`, `dispute_window`) cannot be waited for, and commit timestamps cannot be moved | Time-scaled policy profile and literal-time unit tests (§4) |
| P-7 | The prototype's rounding, minute lock, single-minute records and in-service ledger can leak into new code through ported tests | Port only generators and oracles (§3); review each ported test against POL-11, POL-13 and C06 |
| P-8 | I2 holds back acknowledgement of batches with a non-conforming payload until I17 | I17 depends only on I2 and runs in parallel; no production release before I17 |

## 9. Blockers

These are needs outside the frozen contracts and this slice's increments.

| # | Blocker | Needed by | Owner |
|---|---|---|---|
| B-1 | A running C01 v1 owner runtime: owner leases, slot batch transactions, self-outboxed log with relay, closure emitter and closure topics, slot groups, account slot map, alert feed, move protocol; a 2 + 2 + 1 CockroachDB test topology; the load-test rig. No S-PLAT plan exists yet in `docs/04-delivery/plan/` | I1 (and so every increment), SP2, SP3, I20 | S-PLAT (RFC-006) |
| B-2 | A running C01 history service (sealing of `ingest_log`, history query across the archive boundary) | I19 | S-PLAT (RFC-006) |
| B-3 | No frozen contract for RFC-001's link-registry feed (link rows, supplier, retired state). C06 says link rows stay on that feed | I6 (route-leg check only), I15 (supplier of a quarantined entry's link) | S-LINK (RFC-001) and the contracts owner |
