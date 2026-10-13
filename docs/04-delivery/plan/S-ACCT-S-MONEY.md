# S-ACCT and S-MONEY delivery plan: the account owner, partner adapters and money

| | |
|---|---|
| Slice | Joint slice S-ACCT + S-MONEY. Primary specs P2 (122 scenarios) and P4 (120 scenarios). The two slices share one component, the account owner (RFC-000 §2) |
| Status | Draft for C5 plan review |
| Authority | [RFC-002](../../03-rfcs/RFC-002-booking-coordination.md) revision 6 and [RFC-004](../../03-rfcs/RFC-004-wallet-and-settlement.md) revision 6 (both taken as accepted). Frozen contracts: [C01](../contracts/C01-platform.md) v1, [C02](../contracts/C02-link-hold.md) v1.0.0, [C03](../contracts/C03-link-schedule.md) v2.4, [C04](../contracts/C04-reservation-feeds.md) v2.3.1, [C05](../contracts/C05-funds-and-standing.md) v1, [C06](../contracts/C06-usage-and-charges.md) v1, [C07](../contracts/C07-receivables-and-payouts.md) v1.2, [C08](../contracts/C08-identity-and-access.md) v1.2, [C09](../contracts/C09-personal-data-store.md) v1.1 (reporting only), [C10](../contracts/C10-booking-api.md) v1.0.0, [C12](../contracts/C12-partner-port.md) v1. C11 does not apply. Requirements at tag `requirements-v1.11`. [RFC-000](../../03-rfcs/RFC-000-architecture.md) revision 4.5 |
| Prior code | `src/` (route saga, simulated partner) and `billing/` (ledger, wallet, exposure, split). Prior art only. §4 states what this plan keeps and what it replaces |
| Language | ASD-STE100 Simplified Technical English |

## 1. Rules for this plan

1. Each increment is small and can ship alone.
2. An increment depends only on frozen contracts or on earlier increments of this plan.
3. Increment numbers are one sequence for the three prefixes. The number gives the
   dependency order. `AM` is joint work in the account owner (booking module and funds
   module). `ACCT` is booking, partner adapters and status reads. `MONEY` is the ledger,
   settlement, payments, receivables, reconciliation, payouts and statements. Teams work
   in parallel. A `MONEY` increment does not wait for an `ACCT` increment with a lower
   number unless its dependency row names it.
4. The money increments that let S-RATE post its charge lines (C06 §5, §7, §8, §9) and
   receive the usage-applied acknowledgement (C06 §4) come first: MONEY-I2, MONEY-I3,
   AM-I5 and AM-I6.
5. Many scenarios need a component of another slice (the link owner, the edge, identity,
   rating, the notifier). For these, this plan proves its part with a **contract double**
   of that component. The double replays the frozen contract. The other slice proves its
   part with its own tests of the same contract. The scenario is placed in the increment
   where the part of this plan is complete. When the real component is available, the
   team runs the exit criterion again against it.
6. "Fixture" means recorded messages of a frozen contract, replayed by a test. A fixture is
   not in a production image. A build lint makes sure of this.
7. Contract test IDs are those of the frozen contracts: C01 "CC-n", C02 consumer tests by
   number ("C02-C n") and joint tests by name, C04 "PO-n", "PL-n", "PC-n", C05 "Pn", "Hn",
   "Qn", C06 "CT-…", C07 "Pn", "Kn", C08 "C-nn", C10 "CT-Pnn", C12 "§10.1 n", "§10.2 n".
   RFC design tests are "T-n" (RFC-002 §15) and "B13: <name>" (RFC-004 §B13).

## 2. Components and owners

| Component | Responsibilities (RFC) | Owner (role) |
|---|---|---|
| **Account owner service**, booking module | One writer per account slot on the C01 runtime. Account log, entry kinds E1 … E16, batch transactions evaluated at the commit timestamp, decision row (RFC-002 §2). Intake, idempotency families, validation, quotes (§3). Request state machine and workflow: holds, waiting, yields, confirm, fence, expiry, withdrawal (§4 … §7). Reporting gate, outcome feed with markers, `answered_pending` (§8). Reservations, change queue, leg-command queues, cut targets, offers and moves, termination, release after grace (§9). Takeover and recovery (§12). Target summary (C08 §G) | Booking team |
| **Funds-and-standing module** (library in the account owner) | Pure, deterministic module of C05: `rateCheck`, `admit`, `apply`, `due`, `answer`, `standing`. Funds entry kinds F1 … F11. Holds, headroom, key spending by segment, capacity in flight, lateness bound, standing machine, resume amount, warnings, price notices (RFC-004 §A1 … §A11) | Wallet team |
| **Status readers** for the account kind | Read rules 1 … 4 of RFC-002 §8.2 on the C01 status-reader runtime. Status reads, headroom and balance query, standing query, `usage_applied_since`, operator reads with read grants | Booking team (status rules), Wallet team (headroom and standing answers) |
| **Partner adapters** and **partner drivers** | One adapter per partner link on the C01 runtime: journal J1 … J11, partner port (C12 §2.1), classification, fences and epochs, tombstones, waiter queue, unknown results, daily reconciliation and its feed (RFC-002 §10). One driver per partner (C12 §2.2) | Partner integrations team |
| **Ledger** | Owner kind by ledger partition. Movement record, validation, deduplication, posting templates M1 … M23, posting port (C06 §8), posting acknowledgement in its outbox (C06 §7), movement feed and views (C06 §9), cut records at one database timestamp (RFC-004 §B1, §B2) | Ledger team |
| **Settlement** | Consumer by buyer account, with a hot standby. Charge-line batches to movements, Webster split, isolation for each account, deviation report (RFC-004 §B3) | Ledger team |
| **Payments** | Owner kind by (provider, transaction reference). Payment notification ingress (C07 op 3), binding, conversion, orphan reversals, escalations (RFC-004 §B4) | Payments team |
| **Receivables** | Owner kind by account. Invoices, overdue, write-offs, negative episodes, invoice-status feed (C07 op 1) (RFC-004 §B5) | Finance engineering team |
| **Reconciliation** | Owner kind by day. Daily proof, matching, in-flight terms, partner reports (C07 op 4c) (RFC-004 §B6) | Finance engineering team |
| **Payouts** | Owner kind by supplier. Weekly runs, lots, instructions, transfer reports, escalations, supplier debts (C07 op 4a, 4b; op 5 consumer) (RFC-004 §B7) | Payouts team |
| **Reporting and statements** | Read models only. Buyer and supplier statements (RFC-004 §B8) | Reporting team |

The account owner is one component with two modules. The Booking team runs the service.
The Wallet team owns the funds library and its rules versions (F10). An `AM` increment
has both teams.

**Components of other slices that this plan consumes.** S-PLAT: the C01 owner runtime,
placement and the account slot map, status-reader runtime, relay and closure emitter,
timers, alert stream, history, notifier, probes. S-SEC: edge gateway (C10 transport and
C08 §A principal context), identity push and catch-up (C08 §B), operator envelope,
`operator_check`, target-summary signing client, read grants, authenticity verifier,
payout destination (C07 op 5), `visibility`, key release. S-LINK: link schedule owner
(C02, C03). S-RATE: catalogue (C06 §2), charge-line feed (C06 §5), unposted-usage feed
(C06 §3), and rating as consumer of the lifecycle feed, the posting acknowledgement and
the usage-applied acknowledgement. Network operations: standing feed consumer and
enforcement acknowledgement (C05). Routing: equivalent-path source (C12 §2.4).

## 3. Dependency on S-PLAT: minimum C01 subset

Every owner kind of this plan (account, adapter, ledger, payments, receivables,
reconciliation, payouts) runs on the C01 v1 runtime. The S-PLAT plan must deliver these
C01 parts, by name, before the increment shown. Until S-PLAT delivers a part, the team
uses a C01 runtime double that passes C01 §10.2 CC-1 … CC-8. Each exit criterion is then
run again on the real runtime.

| C01 part (by name) | Needed by |
|---|---|
| Owner declaration (§2.2) and the migration tool | AM-I1 (account kind), MONEY-I2 (ledger kind), ACCT-I15 (adapter kind), MONEY-I12, MONEY-I25, MONEY-I26, MONEY-I27 (their kinds) |
| Log table, head row, projection and outbox schema (§2.3) | AM-I1 |
| Per-owner SQL roles from workload certificates; platform read roles; grants conformance job (CP-11) (§2.3) | AM-I1, MONEY-I2 |
| `OwnerRuntime.append` with `decide(ctx)`, declared `reads` and conditions, `ctx.ts` read inside the transaction; `AppendResult` `Committed`, `ConditionFailed`, `Retry`, `StaleEpoch`, `Overloaded` (§2.4, §3.2) | AM-I1 |
| `displacementRead` condition with the savepoint and lock timeout (§2.4) | AM-I1 |
| Hooks `onAcquire`, `onRelease`, `onNotification`; `leaseValid`, `epoch`, `generation`, `now`, `timing` (§2.4, §3.1) | AM-I1 |
| Outbox, relay to Kafka, wire format, event identity (partition, stream, `stream_seq`), per-topic producer ACL (§2.5, §3.5) | AM-I1 |
| Closure emitter on the owner's feeds (§3.6) | AM-I1 (lifecycle feed closure for S-RATE) |
| `ReportMarker`, report position, `onReportable` (§3.4) | AM-I1 |
| `CommandEnvelope`, `RoutingRefusal`, `admitCommand`; `route`, `slotOf` with `headDecides`; account slot map read (§2.4, §2.7, §3.8) | AM-I1 |
| Column encryption binding to RFC-005 C13 (§3.12) | AM-I1 |
| Status-reader runtime: read leases, `leasedRead`, `isMovedOut`, `replicaRule3Check`; `EntryInput.pendingAnswered` (§2.4, §3.4) | ACCT-I4 |
| `onResolved` and closure topics of consumed feeds (§3.6) | ACCT-I7 (catalogue), AM-I9 (identity push), MONEY-I25 (movement feed) |
| `timer`, `cancelTimer` (§3.7) | ACCT-I8 |
| Operational alert stream `<kind>.alert.v1` (§2.10, §3.11) | ACCT-I8 |
| `AppendResult` `Moved`, `Moving`, `Stopped`, `Ambiguous` with the 15 s `COMMIT` backstop and the resolution read; hooks `onMovedOut`, `onAdopt`; splitting slots, `ackSplitting`, `listPartitions` (§3.1, §3.3, §3.8) | AM-I23 |
| Integrity stop as seen by an owner (`Stopped`) (§2.6) | AM-I23 |
| History query (§2.8) | AM-I23 (P4-S72 rebuild) |
| Probe designation, `probeAccountSet`, `probeSetSummary` (§2.7, §2.9, §3.10) | AM-I24 |
| Historical read at one database timestamp after the closed timestamp; MVCC window of 4 h for ledger tables (§10.3) | MONEY-I26 |

## 4. Prior code

The conformance matrix ([conformance.md](../../02-specs/conformance.md)) cites only
*prior evidence, to be re-validated* for this slice. No scenario is `met`. This table
states what happens to each cited file and test. A scenario is delivered only by the new
test named in its increment.

| Prior code | What it is | Decision |
|---|---|---|
| `src/routes.ts` (`Coordinator`, `recover`) | Route saga with wound-wait, pinned holds, holds that expire by TTL, one coordinator process, Postgres `sagas` and `holds` tables | Replace. RFC-002 Competition rejects wound-wait, hold leases and one coordinator. Keep two ideas: the commit point becomes E5; the crash hooks (`crashAt`) become the pattern for T3 fault injection (AM-I23) |
| `src/partner.ts` (`PartnerLink`) | Simulated partner: fails before work, times out after work, slow; idempotent by key | Keep as the base of the scripted fake driver of C12 §10.1 (ACCT-I15). Add absolute expiry, `query`, `queryRef`, `amend`, future-dated `cancel`, `listDay` and clock skew up to `σ_p` |
| `test/routes.test.ts` › "a route across our links and the partner is confirmed; every leg becomes a fact" (P2-S01) | Saga test | Retire. ACCT-I8 delivers P2-S01 |
| `test/routes.test.ts` › "a leg that cannot fit rejects the route, names the link, and releases every hold" (P2-S02) | Saga test | Port the case to ACCT-I8 |
| `test/routes.test.ts` › "randomised contention (seed 11/12/13) …" (P2-S15, P2-S28) | Seeded random contention with an oversell sampler | Keep the generator and the sampler as harness for T2 (ACCT-I10) and the chaos test of C12 §10.1 16 (ACCT-I18). Its wound-wait expectations are retired |
| `test/routes.test.ts` › "crossed sagas: priority tickets resolve the deadlock at once (D17)" (P2-S19) | Wound-wait test | Retire. POL-02 forbids pre-emption of a holder that is not waiting. ACCT-I10 delivers P2-S19 |
| `test/routes.test.ts` › "idempotency: retries with the same key never book twice" (P2-S24, P2-S25, P2-S26) | Key reuse test | Port to CT-P03, CT-P05 (ACCT-I7) and CT-P04 (AM-I23) |
| `billing/src/domain/split.ts` | D'Hondt split, ties by account name | Replace with the Webster split of RFC-004 §B3.2 (tie order by leg, commission last). Keep `billing/test/split.test.ts` ("shares always sum exactly", "house-monotone") as property harness, with the one-unit-at-a-time Webster oracle (MONEY-I2) |
| `billing/src/domain/money.ts` | Charges rounded half up | Replace. POL-11: a charge line is rounded down once; a top-up conversion is rounded up (MONEY-I3, MONEY-I12) |
| `billing/src/ledger/ledger.service.ts`, `billing/schema.sql` | One `journals`/`entries` table, triggers for balance and append-only, `payoutRun` by full scan | Replace with the partitioned ledger owner kind (MONEY-I2). CockroachDB has no triggers in this design: insert-only is by grants (C01 CP-11), and balance is a validation rule at append. `payoutRun` is replaced by payouts (MONEY-I26) |
| `billing/src/wallet/*` | Webhook at `/webhooks/payments`, dedup by (transaction, type), Kafka request-reply for the balance | Replace with payments ingress (C07 op 3) behind the edge and the verifier (MONEY-I12). The balance is the C05 headroom query on status readers (AM-I5) |
| `billing/test/wallet.test.ts` › "repeated and out-of-order webhooks credit the wallet exactly once" (P4-S01, P4-S28); › "malformed webhooks are rejected by the validation pipe" (P4-S05) | Dedup and validation tests | Keep the permutation harness for B13 "Payments in any order" (MONEY-I12). Rewrite the expectations for bindings, `mismatch_recorded` and `malformed` (422, no binding) |
| `billing/test/kafka.e2e.test.ts` › "request-reply: … wallet balance query over Kafka" (P4-S17) | Kafka request-reply | Retire. AM-I5 delivers P4-S17 with the C05 query |
| `billing/test/rating.test.ts` › "seed %i: duplicates, shuffling and late records give the same ledger …" (P4-S28, P4-S38, P4-S39); › "late usage never claws back a supplier … (Alabama paradox)" (P4-S39) | Order independence over a single journal table | Keep the seeds and the shuffle harness for B13 "Order independence" (MONEY-I3), on the Webster split and the per-line dedup |
| `billing/src/exposure/*` | Headroom as balance less exposure, `suspensions` table, Kafka suspend and resume events, Kafka admission check | Replace with the funds module (C05) in the account owner and the standing feed `account.standing.v1` (AM-I1, AM-I6, AM-I11) |
| `billing/` NestJS modules and Kafka plumbing | Service scaffolding | Keep as scaffolding for the money owner kinds on the C01 runtime |

## 5. Spikes

The RFCs mark these estimates as ones the design depends on. Each spike starts at once,
in parallel with AM-I1 and MONEY-I2. Each spike gives measurements and one decision.
SP1 and SP2 run in the R1 spike environment of S-PLAT (RFC-000 R1, RFC-006).

| Spike | Measurement | Decision it unlocks | Gates |
|---|---|---|---|
| **AM-SP1** Account step and lanes (RFC-002 §14, RB-16, RB-18; RFC-004 R4-B8; RFC-000 R23) | Batching wait `W_a` and the account step at p99 (two two-region transactions per single-link booking) at about 16,384 slots and about 112,000 entries/s (est.); rate of pushed transactions with in-transaction evaluation (est. 0.1 ms per entry); single-link final answer from R1, R2 and the R2 probe (est. 176, 186, 196 ms) | Second lane per slot on or off: on if the account step exceeds 50 ms at p99. The slot count (est. 16,384) | ACCT-I4 (latency baseline), AM-I29 |
| **AM-SP2** Deadline path (RFC-002 §1.3, §6, RB-12; J-14) | `δ_x` at p99.9 per topology state (expiry commit, release notice, release commit at a link); commit-timestamp margin against the owner clock; cost of the displacement point read under a savepoint with a 10 ms lock timeout (est. 1 to 2 ms) | Configured `τ` (est. 420 ms, cap 450 ms) and `δ_x_cfg` (est. 320 ms); the lock timeout value | ACCT-I8 |
| **ACCT-SP3** Partner measurements (RFC-002 RB-1, RB-2; C12 F11, m13) | For each first partner sandbox: hold latency, clock offset bound and `σ_p`, expiry granularity, call capacity per second, answer classes | Classification with or without holds; whether the 11 s minimum deadline holds for that partner; the adapter's rate limit for each partner | ACCT-I15 |
| **MONEY-SP4** Ledger posting and cuts (RFC-004 §B10, R4-B2) | Commit time and size of a 600-line movement and of a 5,000-line movement; dedup watermark rows touched; posts per partition (est. 27 movements/s, 8,000 lines/s); a cut read `AS OF SYSTEM TIME T` of about 130,000 balance rows after the closed timestamp passes `T` | Ledger partition count (est. 128) and Share sub-partitions (est. 16); that the 5,000-line limit fits one transaction; the cut job schedule inside the 4 h MVCC window | MONEY-I2 (partition count), MONEY-I26 (cut job) |

## 6. Increments

Each increment lists the contracts it introduces (as provider) and consumes, with
versions. "Doubles" names the contract doubles the exit criteria use.

### AM-I1. Walking skeleton: book one single-link route, admit with funds, hold and convert on one link, report, hold funds

| | |
|---|---|
| Goal | Prove the main path end to end on the C01 runtime. A buyer books one single-link route through C10 `book`. The account owner admits it with a C05 funds hold. It sends a C02 `hold`, gets `HELD`, commits E5 and sends `convert`. The outcome is reported. The funds hold becomes the reservation's hold |
| Components | Account owner service (account kind declaration; E1, E5, E9; decision row; idempotency row for a new key and for the same key and fingerprint; intake checks for one Share leg; deadline default; `D`, `D_c`, the confirm fence `ts < D − τ`; `iam_fresh` set by a snapshot catch-up; one displacement read in E5; `convert` with the attempt from `HELD`; reservation record with one part, its principal and key; outcome event; lifecycle event `confirmed`). Funds module (C05 types; `admit` for `New`, check 1 and check 4 only; `apply(Intake)`, `apply(Decided)`; `standing`; F1 for a balance from a movement; F4 snapshot for an active key; F10). The C01 runtime parts of §3 for AM-I1 |
| Contracts introduced | C10 v1.0.0 `book` (single Share leg, answer `200 confirmed`). C04 v2.3.1 request outcome event `confirmed` and lifecycle event `confirmed`, with runtime markers. C05 v1 module interface (the subset above) |
| Contracts consumed | C01 v1 (AM-I1 rows of §3). C02 v1.0.0 `hold`, `convert`, displacement read. C06 v1 §2 catalogue (route price), §9 movement feed by-buyer view (one M1). C08 v1.2 §A principal context, §B `catch_up` without `since` |
| Doubles | Edge double that builds a C08 §A context (or S-SEC-I1). C02 link-owner stub. C08 identity double for the snapshot. C06 catalogue fixture and a movement-feed fixture with one M1 of 1.000000 USD |
| Scenarios delivered | P2-S11, P2-S92, P4-S08, P4-S09, P4-S59 |
| Exit criteria | (1) A `POST book` for one Share leg with no capacity in flight answers `200 confirmed` with a reservation id. The link stub records `hold`, then `convert` with the attempt that `HELD` carried. (2) P4-S08, P4-S09 and P4-S59 pass: after E5, `H_r = R_r` (288,000 µ, 24,000 µ, and the first window of a future start). (3) P2-S92 passes: an instrumented trace shows that no `hold` leaves before E1 commits. (4) P2-S11 passes: a request with no deadline has `D = ts + route_deadline_default`. (5) C05 H1 passes. C05 P1 passes on the entry kinds present. (6) C01 CC-1, CC-6, CC-7 and CC-8 pass for the account kind. (7) C02-C 7, first row (a present marker of any attempt means no E5), passes. (8) C08 C-01 passes. (9) C04 PL-1 passes for the E5 row; the outcome event has its identity (partition, stream, `stream_seq`) and a covering marker. (10) Count: a single-link booking costs two account-log transactions |
| Dependencies | Frozen C01, C02, C04, C05, C06, C08, C10. S-PLAT: the AM-I1 rows of §3 (or the C01 double) |

### MONEY-I2. Ledger and settlement of reservation batches: S-RATE can post

| | |
|---|---|
| Goal | Give S-RATE a ledger that posts its reservation charge-line batches, answers on the posting acknowledgement and publishes every movement |
| Components | Ledger (owner kind with the SP4 partition count; movement record of §B1.2; validation at append; insert-only by grants; digest chain `prev`; reservation-line watermarks and the reference index; canonical `SourceRef`; movement digest; M4; M1 from the payments principal; posting port; posting answer in the outbox; movement feed with views by buyer, by supplier and by external account). Settlement (consumer of reservation batches; M4 with the Webster split; weights version from the line; queue for each account; offset at the low-water mark; restarts; hot standby; `batch_over_limit`). Webster split library |
| Contracts introduced | C06 v1 §7 posting acknowledgement (`posted`, `duplicate`, `excluded` for reservation batches), §8 ledger posting port, §9 movement feed and its views |
| Contracts consumed | C06 v1 §5 charge-line feed (reservation batches), §2 catalogue (split weights). C01 v1 |
| Doubles | C06 CT-R fixtures of reservation batches; catalogue fixture with split weights |
| Scenarios delivered | P4-S28, P4-S29, P4-S31, P4-S32, P4-S33, P4-S34, P4-S35, P4-S36, P4-S71, P4-S73, P4-S102 |
| Exit criteria | (1) B13 "Webster property test" passes, with the worked examples of §B3.2 (P4-S35, P4-S36, P4-S73, P4-S102). (2) C06 CT-L1 (reservation rows), CT-L3 (reservation batch), CT-L5, CT-L7, CT-L8 and CT-L9 pass. (3) C06 CT-C1 passes on the reservation fixtures. (4) C01 CC-1 … CC-8 pass for the ledger kind. The C01 grants job finds no UPDATE or DELETE grant on `ledger_movement` for any role (P4-S29). (5) A movement in two currencies, a line that does not sum to zero and a zero amount are refused and move nothing (P4-S28, P4-S31). (6) Measurement: at the SP4 rate on one partition, every reservation batch is acknowledged `posted` within 2 min of emission at p99 (X2-S13), and no answer goes before the movement is durable in two regions (X2-S14) |
| Dependencies | Frozen C01, C06. SP4 (partition count). S-PLAT: the MONEY-I2 rows of §3 (or the C01 double) |

### MONEY-I3. Usage batches, amendments, corrections, fees and cost lines

| | |
|---|---|
| Goal | Post every line kind that rating emits, so that S-RATE can run its usage path, corrections, fees and cost lines end to end |
| Components | Settlement (usage batches posted whole or not at all; the C06 mapping table; `refused_batch`, `batch_refused`, `batch_over_limit` for usage batches; exclusions acknowledged directly; deviation report of §B3.5). Ledger (M5 … M13, M23, nil lines, abandon postings; amendment sequence per line key; `priorTotal` checks; content conflict with `ledgerPostedTotal`; derived references, AI4-1; `lateCut` stored as given, CI4-3) |
| Contracts introduced | C06 v1 §7 complete, §8 complete (every `lineKind`), §9 complete |
| Contracts consumed | C06 v1 §5 (usage batches, amendments, fees, cost lines), §2 catalogue |
| Doubles | C06 CT-R fixtures (CT-R6, CT-R9, CT-R10, CT-R12, CT-R13); a catalogue double for an operator price correction with source reference "C1" |
| Scenarios delivered | P4-S30, P4-S37, P4-S38, P4-S39, P4-S41, P4-S42, P4-S56, P4-S74, P4-S75, P4-S77, P4-S84, P4-S85, P4-S89, P4-S99, P4-S110, P4-S115, P4-S116 |
| Exit criteria | (1) C06 CT-L1 (all rows), CT-L2, CT-L3 (usage batch), CT-L4, CT-L6 and CT-L10 pass. (2) C06 CT-C1 passes on every CT-R fixture. (3) B13 "Order independence", "Per-line dedup", "Cost-line amendments", "Batch kinds" and "Usage batches whole" pass. (4) The worked examples of §B2 pass for M6 … M13 and M23 (P4-S41, P4-S42, P4-S56, P4-S75, P4-S85, P4-S89, P4-S110, P4-S115, P4-S116). (5) P4-S99 passes against the catalogue double: the second "C1" moves no money. (6) Measurement: usage lines are posted within `max_lateness` + 120 s of their minute's end at p99 at the test load (X2-S13). A refused usage batch costs one gated cycle (est. 2.5 s, R4-B11) |
| Dependencies | MONEY-I2. Frozen C06 |

### ACCT-I4. Reporting: status readers, `pending`, outcome feed and markers

| | |
|---|---|
| Goal | Every booking request gets an answer within `ack_budget`: final if the outcome is reportable, else `pending`. Polls get the outcome from status readers and never a contrary one |
| Components | Account owner service (sync answer gate; `pending` only for a committed intake; `pendingAnswered` on the entry; outcome event fields; markers with `prevReportPosition`, `pendingAnswered`, chunks; read leases). Status readers (rules 1 … 4; unknown key answered "no such request" only after a consistent read; principal context checked again; `NOT_FOUND`). C10 `status` |
| Contracts introduced | C10 v1.0.0 `status`, `202 pending`. C04 v2.3.1 request outcome feed complete for E5 and E1′, markers as C04 extends C01 |
| Contracts consumed | C01 v1 (status-reader runtime, `pendingAnswered`) |
| Doubles | C02 link stub that delays `HELD`; notifier double for the marker gate |
| Scenarios delivered | P2-S06, P2-S07, P2-S08, P2-S10, P2-S27, P2-S99 |
| Exit criteria | (1) C04 PO-1 (E5 and E1′ paths), PO-3 (steady state) and PO-5 pass. (2) C10 CT-P01 passes functionally: `200 confirmed` when the outcome is reportable in time. (3) A slow `HELD` gives `202 pending`; a poll then reads `pending` and later the outcome, never the reverse (P2-S08, P2-S27, P2-S99, P2-S10). (4) C01 CC-7 passes for read-lease grants. (5) Measurement (baseline, not the final target): single-link final answer at p99 in one region at 10% of the design load, against the 200 ms `ack_budget` (X2-S05, X2-S15). The full-load figure is AM-I29's. Status reads reflect the decided outcome within `status_staleness` (P2-S99) |
| Dependencies | AM-I1. Frozen C01, C04, C10. S-PLAT: the ACCT-I4 row of §3 |

### AM-I5. Ledger movements applied in the account, and the headroom query

| | |
|---|---|
| Goal | The account owner applies the real ledger feed. The funds hold rolls forward as minutes are posted. Buyers read their balance and headroom |
| Components | Funds module (F1 from the by-buyer view, dedup by (view key, `EventId`); `p_r`; roll-forward `H_r = R_r`; `KP_k` from per-line `amount` and `postedTotal`; Draining rule for an ended reservation). Account owner service (F1 composed from the feed; feed position in the entry). Status readers (C05 headroom and balance query: position, `evaluatedAt`, headline, items `Bal`, `F`, `A`, `CL`; `NOT_FOUND` for another tenant or a supplier) |
| Contracts introduced | C05 v1 headroom and balance query (without `U` and `LB`, which AM-I6 adds) |
| Contracts consumed | C06 v1 §9 movement feed by-buyer view (from MONEY-I2) |
| Scenarios delivered | P4-S10, P4-S17 |
| Exit criteria | (1) C06 CT-A4 passes. (2) C05 Q4 passes for the fields present. (3) C06 CT-C3 passes on the movement fixtures. (4) C05 P8 passes for invariant A-1 while active, with postings that lag. (5) P4-S10 passes: a posted minute lowers `Bal` by 200 µ and `H_r` stays 288,000 µ. P4-S17 passes: the balance shown equals the ledger at the stated position. (6) Measurement: the headroom answer from a status reader within 200 ms at p99 (X2-S18). An M1 committed in the ledger is applied by F1 in about 0.3 s (est.), inside X2-S07's 10 s |
| Dependencies | AM-I1, ACCT-I4, MONEY-I2. Frozen C05, C06 |

### AM-I6. Unposted usage, the lateness bound and the usage-applied acknowledgement

| | |
|---|---|
| Goal | Give S-RATE the usage-applied acknowledgement it gates usage batches on. Headroom counts usage exposure `U + LB` |
| Components | Funds module (F2 with the gate on `X` and `Δ_b` for each product; F3 schedules of cap, windows and highest price; `LB` integer formula; F7 *exposure step* with deferral; headroom items `U`, `LB`). Account owner service (F2 and F3 composed from the feeds; `UsageApplied` in the F2 outbox row; F2 apply-lag alert). Status readers (`usage_applied_since`) |
| Contracts introduced | C06 v1 §4 usage-applied acknowledgement (`account.usage-applied.v1`), C05 v1 gap recovery query |
| Contracts consumed | C06 v1 §3 unposted-usage feed, §2 catalogue (`account_product_terms`, `policy_parameters`, `usage_price`) |
| Doubles | C06 unposted-usage and catalogue fixtures |
| Scenarios delivered | P4-S15, P4-S16 |
| Exit criteria | (1) C06 CT-A1, CT-A2, CT-A5, CT-C3 (all orders), CT-C4 and CT-C5 pass. (2) C05 P7, P10, P14, Q4 (complete) and Q5 pass. C05 H3 passes for the F2 gate. (3) P4-S15 and P4-S16 pass: headline 656,250 µ; `LB` 53,750 µ; items add up. (4) Joint run with S-RATE when available: C06 CT-R4. (5) Measurement: an F2 is applied within 2 s of rating's figure at p99 (est.), and the apply-lag alert fires at `attribution_lag_max` (J-18). This is this plan's part of X2-S22 |
| Dependencies | AM-I5. Frozen C05, C06 |

### ACCT-I7. Intake validation, idempotency and rate limits

| | |
|---|---|
| Goal | The account owner refuses bad intakes in C10's order, records them so a retry gets the same answer, and makes every retry the same request |
| Components | Account owner service (C10 check order: `unknown_route`, `product_not_on_route`, probe link rules, window and rate validity with the receipt minute, extension past the horizon; the booking-and-change family; fingerprints; key reuse by another principal; `idempotency_retention` by row-level TTL; catalogue freshness gate of 60 s; `onResolved` on the catalogue's closure topic). Funds module (`rateCheck` for key and account, soft counters, rebuilt after a takeover). Status readers (`409 key_reuse_other_principal`) |
| Contracts introduced | C10 v1.0.0 validation answers, `409` answers, `429` answers |
| Contracts consumed | C06 v1 §2 catalogue closure. C08 v1.2 §A. C01 v1 `onResolved` |
| Doubles | Edge double with `400 malformed` and the exact poll limiter (or S-SEC-I2) |
| Scenarios delivered | P2-S24, P2-S26, P2-S41, P2-S63, P2-S64, P2-S65, P2-S67, P2-S68 |
| Exit criteria | (1) C10 CT-P03, CT-P05, CT-P06, CT-P07, CT-P09, CT-P26 and CT-P29 pass. (2) C05 H5 passes. (3) C06 CT-A3 passes. (4) T5 passes for bookings. (5) P2-S67 passes against the S-SEC edge (S-SEC-I2) or its double: polls never reach the owner and are not counted by readers |
| Dependencies | ACCT-I4. Frozen C06, C08, C10 |

### ACCT-I8. Routes over Share links, and every outcome that is not a confirmation

| | |
|---|---|
| Goal | Book routes over several Share links all or nothing. End a request rejected, failed, expired or withdrawn with nothing held, and report it only once its releases are durable |
| Components | Account owner service (holds to every leg in parallel; E7 for no fit with the counter-offer from the link availability query; `wait = false` and `IN_FLIGHT` with `retry_after`; "link unavailable" for `UNKNOWN_LINK`, `LINK_CLOSING`, `LINK_RETIRED`, with no counter-offer; request-scoped `release` to every leg of the intake; E8 and the report gate; timers `D_c`, `D − τ`, `T_x`, `D`; E6 with its reason; E8 of an expired request at `ts ≥ D`; `expire_if_undecided` answer; E4 withdrawal and the pre-emptive withdrawal E1′; alerts). Funds module (release of `h_q` in the deciding entry) |
| Contracts introduced | C10 v1.0.0 `withdraw`; rejection bodies (`counter_offer`, `blocking_link`, `retry_after_ms`, `link_unavailable`). C04 v2.3.1 outcome events for E4, E6, E7, E1′ and E8 |
| Contracts consumed | C02 v1.0.0 `release`, link availability query, `expire_if_undecided`. C01 v1 `timer`, alert stream |
| Doubles | C02 link stub with two links; a console double that reads the outcome feed |
| Scenarios delivered | P2-S01, P2-S02, P2-S18, P2-S51, P2-S56, P2-S73, P2-S110, P2-S120, P2-S122, P4-S12 |
| Exit criteria | (1) C02-C 8, C02-C 9 (hold rows) and C02-C 11 pass. (2) C04 PO-1 (ending and E8 paths) and PO-4 pass. (3) C10 CT-P11 (rows without a waiter), CT-P12 (no-fit and `in_flight` rows), CT-P17 (Share-leg rows), CT-P24 and CT-P25 pass. (4) T11, T19 and T20 pass. (5) The configured `τ` and `δ_x_cfg` come from SP2. (6) Measurement: in 10⁵ requests at the deadline edge, no E5 commits with `ts ≥ D − τ` (P2-S110), and every Share-link release is durable by `D` at p99.9 (the Share part of P2-S93) |
| Dependencies | ACCT-I7. SP2. Frozen C02, C04, C10. S-PLAT: the ACCT-I8 rows of §3 |

### AM-I9. Funds admission complete, and key status from identity

| | |
|---|---|
| Goal | Every intake is checked in arrival order for standing, capacity in flight, funds and key spending, with the exact amounts stated. A revoked key stops at once and its undecided requests fail |
| Components | Funds module (`admit` checks 0 … 5 with `checked`; provisional key from a signed key record; inflight floor and the 10× rule; key spending by segment; E1′ refusal payload; F4 from push, catch-up and snapshot, dedup by (identity partition, sequence) and key version; a key absent from a snapshot is revoked as applied; `NotAccepted{revoked}`). Account owner service (endings "key revoked" in the F4 entry; `iam_fresh` from closure markers, applied and gap-free; catch-up after 20 s of silence; no E5 beyond `iam_fresh + 45 s`). Status readers (agent-key headline `kh_k`) |
| Contracts introduced | C05 v1 `admit` complete; E1′ funds payload |
| Contracts consumed | C08 v1.2 §B identity status push, closure topic, `catch_up` with and without `since`. C01 v1 `onResolved` |
| Doubles | C08 identity double (or S-SEC-I2) |
| Scenarios delivered | P2-S38, P2-S39, P2-S40, P2-S54, P2-S66, P2-S70, P2-S71, P2-S72, P2-S98, P2-S112, P4-S55, P4-S66, P4-S68, P4-S98 |
| Exit criteria | (1) C05 P2, P3, P6, P13, P15, H4 and H6 pass. (2) C08 C-01 (forged or lower-version key record) and C-02 pass. (3) C10 CT-P27 passes for the owner's part. (4) T9 (bookings only) and T13 pass. (5) B13 "Key spending by segment" passes for bookings. (6) Measurement: with Kafka blocked, a revocation is applied by catch-up within 60 s, and no E5 of the slot commits after `iam_fresh + 45 s` (this plan's part of X1-S06) |
| Dependencies | AM-I5, ACCT-I8. Frozen C05, C08 |

### ACCT-I10. Contention on Share links

| | |
|---|---|
| Goal | Requests that compete on Share links wait in age order and do not all lose. Every crossing and cycle breaks. A holder that is not waiting is never pre-empted |
| Components | Account owner service (E2 and `mark_waiting` hints with the log position; `GRANTED` keeps the attempt; `YIELD_REQUEST` with a claim; E3 and `yield_accept` or `yield_refuse`; a holder that starts to wait accepts the new claim; `DISPLACED` handled by whether E5 sees the marker; `WAITER_REFUSED`; `query` every 5 s for Holding and Waiting requests; attempts recorded, never numbered; E6 "deadline passed while waiting" with the latest blocker deadline) |
| Contracts introduced | None new. C02 v1.0.0 waiting-port commands as sender |
| Contracts consumed | C02 v1.0.0 link waiting port, `query`, displacement read |
| Doubles | C02 link stub with scripted notifications; recorded joint traces of C02 |
| Scenarios delivered | P2-S15, P2-S16, P2-S17, P2-S19, P2-S20, P2-S21, P2-S52, P2-S58, P2-S59, P2-S60, P2-S61, P2-S87, P2-S88, P2-S97, P2-S116, P2-S118 |
| Exit criteria | (1) C02-C 1, C02-C 2 and C02-C 7 (all rows) pass. (2) C02 joint tests for P2-S19 and P2-S87, in both orders "refuse, then mark" and "mark, then refuse", pass on recorded traces, and again with the S-LINK link owner when available. (3) T2 (Share links), T10 (rows without a partner leg), T17 and T21 pass. (4) C10 CT-P11 waiter row passes. (5) Measurement: yield entries per contended request on the hottest link double, for RB-3 |
| Dependencies | ACCT-I8. Frozen C02 |

### AM-I11. Standing: suspension, warnings, resumption and enforcement

| | |
|---|---|
| Goal | Standing changes only by rule and only by an entry. Network operations learns of every change within `standing_notice_time` |
| Components | Funds module (causes `headroom` and `written_off`; suspension with frozen holds; `RA` itemised with `headroom_after`; warnings once per crossing with `WQ`; resumption; F7 *enforcement check* at 60 s and 120 s; F8). Account owner service (endings of undecided additions in the same entry; reductions continue; standing feed from the outbox; standing query on status readers) |
| Contracts introduced | C05 v1 standing feed `account.standing.v1`, standing query, enforcement acknowledgement as receiver |
| Contracts consumed | C06 v1 §9 (top-ups as M1 on the feed) |
| Doubles | Network-operations stub; a payments double that posts M1 through the frozen C06 port |
| Scenarios delivered | P2-S42, P2-S69, P2-S103, P4-S19, P4-S20, P4-S21, P4-S22, P4-S24, P4-S25, P4-S26, P4-S27, P4-S64, P4-S65, P4-S69 |
| Exit criteria | (1) C05 P8, P9 (rows without invoices), P11, P12, H2 (suspension and revocation parts), Q1, Q2 and Q3 pass. (2) The §A7 worked examples pass for P4-S22, P4-S24, P4-S64. (3) P2-S103 passes for each row (suspension, revocation from AM-I9, withdrawal from ACCT-I8). (4) Measurement: a standing change is on the topic within 10 s of its entry on the owner path and on the relay path (X2-S17). The 60 s check raises `ENFORCEMENT_ACK_MISSING` (this plan's part of X2-S08) |
| Dependencies | AM-I6, AM-I9. Frozen C05, C06 |

### MONEY-I12. Payments

| | |
|---|---|
| Goal | Take every payment exactly once, whatever the provider's delivery order, and credit it within 10 s |
| Components | Payments (owner kind; event log; binding by (provider, transaction reference); orphan reversal with the 72 h timer; conversion with an FX quote or the partner rate; one reversal for each payment at its bound conversion; `unattributed` to the suspense queue; investigation stream for unproven notifications; postings M1, M2, M3, M20 from the outbox until acknowledged; escalation resolution M22 from a finance envelope). Ledger (M1 with `r = min(x, W)` at append; M3) |
| Contracts introduced | C07 v1.2 op 3 payment notification ingress |
| Contracts consumed | C06 v1 §8 posting port. C08 v1.2 §E envelope (escalation resolution). RFC-005 C7 verifier (through the edge) |
| Doubles | Edge payment ingress and verifier double (or S-SEC-I6); provider simulators |
| Scenarios delivered | P4-S01, P4-S02, P4-S03, P4-S04, P4-S05, P4-S06, P4-S07, P4-S51, P4-S52, P4-S58, P4-S70, P4-S100, P4-S119 |
| Exit criteria | (1) C07 P2, P2b and P3 pass. (2) B13 "Payments in any order" and "Reversals" pass. (3) C01 CC-1 … CC-8 pass for the payments kind. (4) P4-S51 and P4-S70 pass with AM-I11's standing. (5) Measurement: a top-up is applied by the account owner's F1 within 10 s of the notification at p99 (est. 0.2 to 0.3 s) (X2-S07). No 2xx or 4xx leaves before the event is durable in two regions, shown by a kill before commit (X2-S14) |
| Dependencies | MONEY-I2, AM-I11. Frozen C06, C07, C08 |

### ACCT-I13. Reductions: cancel, shorten, decrease, and the leg-command queues

| | |
|---|---|
| Goal | A buyer reduces or ends a reservation as one unit on every leg. Capacity is free from the stated minute. The change is reported only once every leg has applied it |
| Components | Account owner service (change fingerprints; change queue; ending changes never queued; E11 and E12 as reporting entries; one outstanding command per (reservation, leg) in deciding-entry order; `end_leg` and `reduce_parts` in absolute minute pieces; reply groups; window-end timer and E11 `window_end`; lifecycle events `shortened`, `rate_decreased`, `ended`, `leg_changes_durable`; webhooks for changes answered `pending`). Funds module (`apply(ReservationChanged)`; Draining; reductions allowed while suspended) |
| Contracts introduced | C10 v1.0.0 `change` (cancel, shorten, decrease, give an end). C04 v2.3.1 lifecycle events for E11 and E12 |
| Contracts consumed | C02 v1.0.0 `end_leg`, `reduce_parts`, leg-command replies |
| Doubles | C02 link stub; notifier double (C04 CN-1) |
| Scenarios delivered | P2-S09, P2-S43, P2-S44, P2-S48, P2-S49, P2-S77, P2-S85, P2-S113, P4-S11 |
| Exit criteria | (1) C02-C 3 and C02-C 4 pass. (2) C02 joint test "confirm, then cancel, with `convert` answered `MOVING`" passes on recorded traces. (3) C04 PL-1 (E11 and E12 rows) and PL-6 (window end) pass. (4) T23 passes for a booking and a change; C04 CN-1 runs green on the notifier double (P2-S09). (5) C10 CT-P08 passes for reductions (P2-S113) |
| Dependencies | ACCT-I8, AM-I11. Frozen C02, C04, C10 |

### AM-I14. Additions: extend, renew, increase, with worst-case funding

| | |
|---|---|
| Goal | A buyer adds to a reservation as a new admission of the difference. A queued addition is funded for the worst case of the changes ahead, so it never suspends the account by surprise |
| Components | Account owner service (additions as requests of their own with `kind = change`; holds for the added interval; E5 adds a part with its principal and key; queue in arrival order; window-end E11 deferred while an addition at the window end is undecided). Funds module (`Ask.change`, `Ask.ahead`; the envelope; excess released at E5; key spending by part) |
| Contracts introduced | C10 v1.0.0 `change` (extend, renew, make open-ended, increase) |
| Contracts consumed | C02 v1.0.0 `hold` with `kind = change`, `convert` |
| Scenarios delivered | P2-S45, P2-S46, P2-S47, P2-S74, P2-S75, P2-S76, P2-S78, P2-S79, P2-S81, P2-S84, P2-S94, P2-S117, P2-S119 |
| Exit criteria | (1) C05 P4 passes. (2) B13 "Hold invariant A-1" (queued changes) and "Key spending by segment" (complete) pass. (3) C04 PL-8 passes. (4) C10 CT-P08 (additions) and CT-P14 pass. (5) T6 (Share legs), T9 (complete) and T22 pass. (6) C02 joint tests "Shorten, then extend", "P2-S94 row 2 with a late `convert`" and "an increase then a decrease" pass on recorded traces |
| Dependencies | ACCT-I13. Frozen C02, C05, C10 |

### ACCT-I15. Partner adapter, partners with holds

| | |
|---|---|
| Goal | Book routes with a partner leg that offers holds, all or nothing, with every partner commit before `D − commit_margin` |
| Components | Partner adapter (owner kind; journal J1 … J4, J7 … J9; partner port; classification by `termsVersion`; `hold` with `expiresAt = D`; `confirm` journaled before `D_c − σ_p` and sent within `h_s`; late sends; `release`; tombstones; high-water per account partition with `release` exempt; transient retries until the fence; takeover rule F10; `outcome_confirmed`; `expire_if_undecided`). Fake driver (from `src/partner.ts`). Account owner service (§5.5: checks on the projected state; commit margin; deadline check with `σ_p`; E5 only after every partner confirm; partner cancellations at Share's cost on an ending) |
| Contracts introduced | C12 v1 §2.1 partner port (with-holds operations), §2.2 driver interface |
| Contracts consumed | C06 v1 §2 partner terms |
| Doubles | Fake driver of C12 §10.1 |
| Scenarios delivered | P2-S03, P2-S12, P2-S13, P2-S14, P2-S29, P2-S30, P2-S37, P2-S55, P2-S86, P2-S93, P2-S100, P2-S105, P2-S109 |
| Exit criteria | (1) C12 §10.1 tests 1, 2, 3, 4, 5, 6, 8, 15 and 18 pass. (2) C12 §10.2 tests 1, 3 and 4 pass. (3) C10 CT-P02 and CT-P13 pass. (4) T4 passes for partners with holds. T10 passes for the Committing rows (partner confirms sent, answered and unknown). (5) SP3 classification is applied for each first partner. (6) Measurement: a route with a partner leg is answered `pending` within 200 ms at p99 and has its outcome by its deadline (X2-S06). The partner keeps at least `commit_margin − τ` (est. 9.6 s) to answer a confirm |
| Dependencies | ACCT-I10, AM-I11. SP3. Frozen C06, C12. S-PLAT: the adapter-kind row of §3 |

### ACCT-I16. Partners without holds, contention at a partner, unknown results

| | |
|---|---|
| Goal | Book a partner without holds last and at most once per route. Treat a partner refusal caused by Share's own position as contention. Resolve every unknown result at once |
| Components | Partner adapter (J3 final booking; waiter queue by `priority_rule`; re-asks in priority order; yields of Share's own partner holds; `REFUSED(IN_FLIGHT)` for `wait = false`; J6 query on unknown; residue cancelled at Share's cost by the adapter; J5). Account owner service (`book_final` after every other leg, the funds hold and Share's checks; at most one leg without holds; withdrawal cancels a partner booking at Share's cost) |
| Contracts introduced | C12 v1 §2.1 partner port complete for bookings |
| Scenarios delivered | P2-S31, P2-S33, P2-S34, P2-S35, P2-S36, P2-S57, P2-S62, P2-S89, P2-S90, P2-S95, P2-S96, P2-S102 |
| Exit criteria | (1) C12 §10.1 tests 7, 9, 10 and 11 pass. (2) C12 §10.2 tests 2 and 5 pass. (3) C10 CT-P12 (partner rows) and CT-P17 (partner rows) pass. (4) T2 (partner legs) and T4 (complete) pass |
| Dependencies | ACCT-I15. Frozen C12 |

### ACCT-I17. Quotes, partner fees and changes on partner legs

| | |
|---|---|
| Goal | A buyer is never charged a partner fee it was not shown in a quote it cited. Changes on a partner leg follow the terms shown at booking |
| Components | Account owner service (C10 `quote`; the MAC token under a per-account-slot quote key; check 4 with `quote_required` and `terms_changed` with `requote`; terms locked in E1; `fees[]`; fee due and payer in E11; a decrease forbidden by shown terms rejected; partner `change` for a shorten or a decrease; partner `cancel` with `changeSeq` and `costBearer`). Funds module (fee part of the hold; F7 *fee term ended*). Partner adapter (J11 amend; booking sets; scheduled cancels; `changeSeq` order) |
| Contracts introduced | C10 v1.0.0 `quote`, `shown`, `fees[]`. C04 v2.3.1 fees on lifecycle events |
| Contracts consumed | C12 v1 `change`, `cancel`. C06 v1 §2 partner terms with `effectiveFrom` |
| Doubles | Key-release double for the quote key (see §8, blocker 2) |
| Scenarios delivered | P2-S50, P2-S82, P2-S83, P2-S115, P2-S121, P4-S63, P4-S96 |
| Exit criteria | (1) C10 CT-P15, CT-P16, CT-P20, CT-P20b, CT-P21, CT-P21b, CT-P22 and CT-P23 (quote and booking families) pass. (2) C12 §10.1 tests 12, 13 and 14 pass. C12 §10.2 tests 8 and 9 pass. (3) C04 PL-5 passes. (4) T18 passes. (5) P2-S121 rows 1, 2 and 3 pass. The row-4 test is written for the B-RQ-12 reading (a fee recorded at 09:00:30 is in force from 09:01:30; a booking at 09:01 citing Q1 is decided on Q1's terms; one at 09:02 is rejected with the 3.000000 USD fee). It is marked **pending** until the requirements amendment of B-RQ-12. (6) Measurement: a quote answers within 50 ms at p99 in the region and writes nothing to the lane |
| Dependencies | ACCT-I16, AM-I14. Frozen C04, C06, C10, C12. Blocker 2 (§8) for production use |

### ACCT-I18. Partner reconciliation and affected partner legs

| | |
|---|---|
| Goal | Every partner is reconciled each day. A booking the partner lacks, or has in part, is resolved without charging the buyer for it |
| Components | Partner adapter (J10 daily run; `listDay`; `DEFERRED`; mismatches PARTNER_ONLY, SHARE_ONLY, PARTNER_SHORT, PARTNER_EXCESS with their actions; reconciliation feed). Account owner service (`partner_leg_affected` on the reservation command port; E14 with `delivered`; the missing part as an outage; lifecycle event `partner_leg_affected`; E16 only when told, CI-B-1) |
| Contracts introduced | C12 v1 §2.3 partner reconciliation feed. C04 v2.3.1 `partner_leg_affected` |
| Contracts consumed | C12 v1 `partner_leg_affected` |
| Scenarios delivered | P2-S28, P2-S32, P2-S91 |
| Exit criteria | (1) C12 §10.1 tests 16 and 17 pass. C12 §10.2 test 6 passes. (2) T25 passes. (3) C04 PL-9 is marked **pending** until C12 adds `RESIDUE_CANCELLED` (CI-B-1). (4) Measurement: for a simulated day of the hottest partner link, every mismatch and `RUN_COMPLETED` are published by 12:00 UTC on the next day (P2-S32) |
| Dependencies | ACCT-I17. Frozen C04, C12 |

### AM-I19. Release after grace, termination and the operator side

| | |
|---|---|
| Goal | Share ends a reservation only by its policies. Operators act only through verified envelopes, and every refusal is recorded |
| Components | Funds module (F7 *grace ended* with `release_due`; fees due at release, paid by the buyer). Account owner service (E11 "released" in the F7 entry, effective `nb(ts)`, with `delay_min`; `terminate` in C04's order; E15 for refusals; `withhold_notice` and `withheld_by` on every event the termination causes; target summary served under a console session; read grants on status readers for operator reads) |
| Contracts introduced | C04 v2.3.1 reservation command port `terminate`. C08 v1.2 §G target summary (as owner) |
| Contracts consumed | C08 v1.2 §E envelope, §F `operator_check`, §H read grant |
| Doubles | Console and identity doubles (or S-SEC-I3, S-SEC-I12) |
| Scenarios delivered | P4-S23, P4-S97 |
| Exit criteria | (1) C04 PC-1 … PC-7 pass. (2) C05 H2 (grace part) and P8 (with release after grace) pass. (3) C08 C-04, C-06, C-07 and C-08 pass. (4) T12 passes. (5) The §A7 worked example for P4-S97 passes |
| Dependencies | ACCT-I17 (fees shown), AM-I11. Frozen C04, C05, C08 |

### ACCT-I20. Cut targets and revocation

| | |
|---|---|
| Goal | A reservation loses no more than a capacity reduction requires, on every leg, in any order of the links' targets |
| Components | Account owner service (`cut_target` reply after the E11 commits; revisions; composition by `min` for each minute, oldest Mbps kept first; `reduce_parts` and `end_leg` naming the (link, reduction) pairs applied; `ended(revoked)`; `cancelled_after_cut`; partner `change(cause = cut)` with `supportsAmend`; changes in the queue stay queued). Funds module (part rates as minute pieces; fees Share pays never drain the buyer's hold) |
| Contracts introduced | C02 v1.0.0 reservation command port `cut_target` (as receiver). C04 v2.3.1 lifecycle `cut` with `target_revision` |
| Contracts consumed | C03 v2.4 schedule feed (`CUT_DECIDED`, `REDUCTION_FINAL`) for alerts |
| Scenarios delivered | P2-S80, P4-S60, P4-S61 |
| Exit criteria | (1) C02-C 5 and C02-C 6 (rows without offers) pass. (2) C04 PL-2 and PL-3 pass. (3) C05 P5 passes. (4) T15 (cut rows) and T24 (rows without offers) pass. (5) C02 joint tests "a decrease and a cut on one leg, in both orders" and "shorten, then cut, with the first call answered `MOVING`" pass |
| Dependencies | AM-I14, AM-I19. Frozen C02, C03, C04 |

### ACCT-I21. Equivalent-path offers and moves

| | |
|---|---|
| Goal | A holder affected by a permanent reduction is offered an equivalent path, and the move is final only once every new leg is booked |
| Components | Account owner service (consumes `REDUCTION_AFFECTED`; asks the equivalent-path source; E13 states; `offer_hold`, `offer_accept`, `offer_move_at`, `offer_release`; partner booking at acceptance as a request of its own; offer answers in the offer-answer family; `cut_kept`; offer-scoped targets) |
| Contracts introduced | C10 v1.0.0 offer read, accept, decline, move earlier. C04 v2.3.1 `offer_*` and `moved` events |
| Contracts consumed | C02 v1.0.0 offer commands. C03 v2.4 `REDUCTION_AFFECTED`. C12 v1 §2.4 equivalent-path source |
| Doubles | Equivalent-path source double (see §8, blocker 3) |
| Scenarios delivered | None in P2 or P4. Contributes to P1-S31 … P1-S61 and P1-S84 (S-LINK) |
| Exit criteria | (1) C02-C 6 (offer rows), C02-C 9 (offer part) and C02-C 10 pass. (2) C04 PL-4 passes. (3) C10 CT-P19, CT-P23 (offer family) and CT-P28 pass. (4) C12 §10.2 test 7 and §10.4 pass. (5) T16 and T24 (offer rows) pass |
| Dependencies | ACCT-I20, ACCT-I16. Frozen C02, C03, C04, C10, C12 |

### AM-I22. Price changes

| | |
|---|---|
| Goal | A price change of an open-ended reservation is announced ahead with the hold it will need, and takes effect at its minute |
| Components | Account owner service (one entry per (account, price version): F11 and one price-change E11 with `PriceTookEffect` for each affected reservation; an open-ended booking after the announcement carries the step). Funds module (F11 notice with the top-up quote; F7 *price effective*; suspension when growth is not covered) |
| Contracts introduced | C04 v2.3.1 lifecycle `price_step` |
| Contracts consumed | C06 v1 §2 `reservation_price` versions with `oeEffective` |
| Scenarios delivered | P4-S62, P4-S101, P4-S108 |
| Exit criteria | (1) C04 PL-6 (price step) passes. (2) C05 P8 (with price changes) and P9 (P4-S101, P4-S108 rows) pass. (3) T15 (price rows) passes. (4) Measurement: a product-wide change for 100,000 accounts at one minute (about 1,700 entries/s, est.) stays inside the lane budget (R4-A6) |
| Dependencies | AM-I11, ACCT-I13. Frozen C04, C06 |

### AM-I23. Recovery, moves and stops

| | |
|---|---|
| Goal | The account owner and the adapters recover from every crash point without a route left part-booked, and status reads stay correct across every failover |
| Components | Account owner service (`onAcquire`: recovery queries, E9, re-sends in each leg's order, snapshot catch-up, reporting wait `read_lease + ε`; `Ambiguous` resolution; `Stopped` answers `503`; `onMovedOut`, `onAdopt`; splitting slots; `STALE_SENDER` rules; §6.4 when the decision record is unavailable at the deadline, with the alert; reason "interrupted by an internal failure"). Status readers (rules 3 and 4 under failover and after `moved`). Funds module (replay of every entry kind; rebuild from history) |
| Contracts introduced | None new |
| Contracts consumed | C01 v1 (AM-I23 rows of §3) |
| Scenarios delivered | P2-S04, P2-S22, P2-S23, P2-S25, P2-S53, P2-S101, P2-S104, P2-S106, P2-S107, P2-S108, P2-S111, P2-S114, P4-S72 |
| Exit criteria | (1) C01 CC-2, CC-3, CC-4 and CC-5 pass for the account and adapter kinds. (2) C05 P1 (every kind) and H7 pass. (3) C04 PO-2 and PO-3 (acquisition) pass. (4) C10 CT-P04, CT-P10 and CT-P30 pass. (5) C02-C 3 passes after a takeover; the C02 joint test "takeover between two changes of one leg" passes. (6) T1 (model check), T3 and T7 pass. (7) B13 "Funds replay determinism" and "Owner change under load" pass. (8) Measurement: a slot takeover finishes inside admission's RTO of 1 min at p99 (X2-S10). With S-PLAT, no acknowledged fact is lost on node, zone or region loss (X2-S09, X2-S12) |
| Dependencies | ACCT-I18, AM-I22, MONEY-I12. Frozen C01. S-PLAT: the AM-I23 rows of §3 |

### AM-I24. Credit limits and probe accounts

| | |
|---|---|
| Goal | Finance sets credit limits only on vetted accounts, with four eyes above the threshold. Every probe account books on its own credit limit |
| Components | Account owner service (credit-limit command in C07 op 2's order; set-scoped actions; `temporarily_unavailable{identity_stale}`; F9 from placement's slot map; `account_is_probe` on lifecycle events). Funds module (F5 *set* and *removed by operator*; credit holds; probe holds re-evaluated at `ctx.ts`) |
| Contracts introduced | C07 v1.2 op 2 credit-limit command (as receiver) |
| Contracts consumed | C08 v1.2 §E, §F. C01 v1 probe designation |
| Doubles | Console and identity doubles (or S-SEC-I4) |
| Scenarios delivered | P4-S13, P4-S82 |
| Exit criteria | (1) C07 K2, K2b, K2c, K2d and K3 pass. (2) C08 C-03, C-05 and C-14 pass. (3) C04 PL-7 and C06 CT-C6 pass. (4) T26 and B13 "Four eyes" pass |
| Dependencies | AM-I19, AM-I23. Frozen C01, C04, C06, C07, C08. S-PLAT: the AM-I24 row of §3 |

### MONEY-I25. Receivables, invoices and write-offs

| | |
|---|---|
| Goal | Credit-limit accounts are invoiced monthly. Overdue invoices suspend. Unpaid amounts are written off by rule, and the account owner applies each status change in ledger order |
| Components | Receivables (owner kind; issue at month end after the feed closure; overdue; top-up allocation oldest first; invoice payments; M18 conditional on its position; M19; negative episodes; invoice-status feed with `ledger_pos` and `decided_at`). Ledger (M18, M19; `W`). Account owner service (F5 and F6 held until F1 reaches `ledger_pos`; held rows move with the account). Funds module (`invoice` cause; `RA` with `W` and overdue invoices) |
| Contracts introduced | C07 v1.2 op 1 invoice-status feed |
| Contracts consumed | C06 v1 §9 movement feed and its closure |
| Scenarios delivered | P4-S14, P4-S18, P4-S53, P4-S83, P4-S92, P4-S93, P4-S94, P4-S105, P4-S107, P4-S111, P4-S112, P4-S114 |
| Exit criteria | (1) C07 P1, P1b, K1 and K1b pass. (2) C05 H3 (invoice gate) and P9 (complete) pass. (3) B13 "Invoice-status gate" and "Overdue-first allocation and write-off clocks" pass. (4) T14 passes. (5) C01 CC-1 … CC-8 pass for the receivables kind |
| Dependencies | AM-I24, MONEY-I12. Frozen C06, C07 |

### MONEY-I26. Payouts

| | |
|---|---|
| Goal | Suppliers are paid weekly, once, to the destination in force at the run's cut, with debts netted |
| Components | Ledger (cut job and cut record at one database timestamp). Payouts (owner kind; run at `T_w`; lots; instructions with `Idempotency-Key`; transfer reports; escalations; FX conversion with residue; supplier-debt register, netting and invoicing after 90 days; "late POL-07 cut" items; destination query; `DestinationVersionSettled`, CI4-1) |
| Contracts introduced | C07 v1.2 op 4a payout instruction, op 4b transfer reports (as receiver), `payout_schedule` |
| Contracts consumed | C07 v1.2 op 5 payout destination. C06 v1 §8, §9 |
| Doubles | Op 5 stub (or S-SEC-I13); payout provider simulators |
| Scenarios delivered | P4-S43, P4-S44, P4-S45, P4-S46, P4-S47, P4-S48, P4-S49, P4-S50, P4-S67, P4-S78, P4-S79, P4-S86, P4-S87, P4-S88, P4-S95, P4-S117, P4-S118 |
| Exit criteria | (1) C07 P4, P4b, P4c and K5 pass. (2) B13 "Payout lots", "Late POL-07 cut after payout" and "Payout destinations against a C16 stub" pass. (3) C01 CC-1 … CC-8 pass for the payouts kind. (4) Measurement: the cut job reads `T` within minutes of `T` and inside the 4 h MVCC window, at the SP4 row count (R4-B2) |
| Dependencies | MONEY-I3, MONEY-I25. SP4. Frozen C06, C07. S-PLAT: the MONEY-I26 row of §3 |

### MONEY-I27. Reconciliation

| | |
|---|---|
| Goal | Each day, prove by 12:00 UTC that the books equal the money, with payments and payouts in flight in both directions |
| Components | Reconciliation (owner kind by day; inputs of op 4c; signed invariant; safeguarding rule; matching by kind; in-flight terms `E`, `Rcv`, `Pnr`; alert for each provider above `provider_unreceived_alert`; 12:00 deadline alert). Payments (M14 on the partner's USD amount). Ledger (M21 from a treasury envelope) |
| Contracts introduced | C07 v1.2 op 4c partner reports (as receiver) |
| Contracts consumed | Cut records (MONEY-I26) |
| Scenarios delivered | P4-S54, P4-S57, P4-S80, P4-S81, P4-S90, P4-S91, P4-S103, P4-S104, P4-S106, P4-S109, P4-S113, P4-S120 |
| Exit criteria | (1) C07 P5 passes. (2) B13 "Cut consistency", "In-flight terms" and "Provider exposure" pass. (3) P4-S57 passes for every row. The rows "operator price correction" and "quarantine attribution" run against S-RATE's catalogue and attribution doubles. (4) Measurement: the run for day D completes by 12:00 UTC on D + 1 at about 20 M partner transactions (est.) (P4-S81) |
| Dependencies | MONEY-I26. Frozen C07 |

### MONEY-I28. Statements

| | |
|---|---|
| Goal | Every buyer and supplier sees a statement that anyone can check |
| Components | Reporting (read models from the ledger, settlement, payouts and payments feeds; supplier statement by opaque references through `visibility`; buyer statement; daily aggregates; names from the personal-data store at view time; read grants for operator reads) |
| Contracts introduced | None |
| Contracts consumed | C06 v1 §9. C08 v1.2 §D `visibility` and the reference library, §H read grant. C09 v1.1 `get` |
| Doubles | Identity and store doubles (or S-SEC-I5, S-SEC-I10) |
| Scenarios delivered | P4-S40, P4-S76 |
| Exit criteria | (1) C08 C-08 (reporting) and C-09 pass. (2) Measurement: one day's statement is served within 2 s (POL-06). Reporting is rebuilt from feeds and history within its 30 min RTO (X2-S10) |
| Dependencies | MONEY-I27. Frozen C06, C08, C09 |

### AM-I29. Design load and soak

| | |
|---|---|
| Goal | Show the design load and the latency targets on the full system, and that a confirmed reservation ends only by its causes |
| Components | Every component of this plan, with the SP1 decision applied (second lane on if needed) |
| Contracts introduced | None |
| Contracts consumed | None new |
| Scenarios delivered | P2-S05 |
| Exit criteria | (1) T8 passes: 25,000 requests/s with probes and funds entries (about 112,000 entries/s, est.), 200/s on one account, 100,000 polls/s, about 16,384 slots. (2) Measurement against X2: X2-S03 (design load, hottest link included); X2-S05 and X2-S15 (single-link answer within 200 ms at p99, final with no capacity in flight; est. 176, 186, 196 ms); X2-S06; X2-S18 (headroom answer within 200 ms); X2-S21; X2-S13 at the full ledger load (about 1 M lines/s). (3) A reduction to half on the hottest link at design load (RB-21): no oversell, nothing reportable waits on leg changes. (4) P2-S05 passes in a 24 h chaos run: no confirmed reservation ends except by its account, a revocation, a release after grace or a termination |
| Dependencies | AM-I23, AM-I24, MONEY-I28. SP1 |

## 7. Scenario map

Each P2 and P4 scenario is in exactly one increment. Check with:
`rg -o '^\| P[24]-S[0-9]+ ' docs/04-delivery/plan/S-ACCT-S-MONEY.md | sort | uniq -d` (no
output), and compare the sorted list with
`rg -o '@P2-S[0-9]+' docs/02-specs/P2-route-reservation.feature` and
`rg -o '@P4-S[0-9]+' docs/02-specs/P4-wallet-and-settlement.feature` (242 IDs).

| Scenario | Increment |
|---|---|
| P2-S01 | ACCT-I8 |
| P2-S02 | ACCT-I8 |
| P2-S03 | ACCT-I15 |
| P2-S04 | AM-I23 |
| P2-S05 | AM-I29 |
| P2-S06 | ACCT-I4 |
| P2-S07 | ACCT-I4 |
| P2-S08 | ACCT-I4 |
| P2-S09 | ACCT-I13 |
| P2-S10 | ACCT-I4 |
| P2-S11 | AM-I1 |
| P2-S12 | ACCT-I15 |
| P2-S13 | ACCT-I15 |
| P2-S14 | ACCT-I15 |
| P2-S15 | ACCT-I10 |
| P2-S16 | ACCT-I10 |
| P2-S17 | ACCT-I10 |
| P2-S18 | ACCT-I8 |
| P2-S19 | ACCT-I10 |
| P2-S20 | ACCT-I10 |
| P2-S21 | ACCT-I10 |
| P2-S22 | AM-I23 |
| P2-S23 | AM-I23 |
| P2-S24 | ACCT-I7 |
| P2-S25 | AM-I23 |
| P2-S26 | ACCT-I7 |
| P2-S27 | ACCT-I4 |
| P2-S28 | ACCT-I18 |
| P2-S29 | ACCT-I15 |
| P2-S30 | ACCT-I15 |
| P2-S31 | ACCT-I16 |
| P2-S32 | ACCT-I18 |
| P2-S33 | ACCT-I16 |
| P2-S34 | ACCT-I16 |
| P2-S35 | ACCT-I16 |
| P2-S36 | ACCT-I16 |
| P2-S37 | ACCT-I15 |
| P2-S38 | AM-I9 |
| P2-S39 | AM-I9 |
| P2-S40 | AM-I9 |
| P2-S41 | ACCT-I7 |
| P2-S42 | AM-I11 |
| P2-S43 | ACCT-I13 |
| P2-S44 | ACCT-I13 |
| P2-S45 | AM-I14 |
| P2-S46 | AM-I14 |
| P2-S47 | AM-I14 |
| P2-S48 | ACCT-I13 |
| P2-S49 | ACCT-I13 |
| P2-S50 | ACCT-I17 |
| P2-S51 | ACCT-I8 |
| P2-S52 | ACCT-I10 |
| P2-S53 | AM-I23 |
| P2-S54 | AM-I9 |
| P2-S55 | ACCT-I15 |
| P2-S56 | ACCT-I8 |
| P2-S57 | ACCT-I16 |
| P2-S58 | ACCT-I10 |
| P2-S59 | ACCT-I10 |
| P2-S60 | ACCT-I10 |
| P2-S61 | ACCT-I10 |
| P2-S62 | ACCT-I16 |
| P2-S63 | ACCT-I7 |
| P2-S64 | ACCT-I7 |
| P2-S65 | ACCT-I7 |
| P2-S66 | AM-I9 |
| P2-S67 | ACCT-I7 |
| P2-S68 | ACCT-I7 |
| P2-S69 | AM-I11 |
| P2-S70 | AM-I9 |
| P2-S71 | AM-I9 |
| P2-S72 | AM-I9 |
| P2-S73 | ACCT-I8 |
| P2-S74 | AM-I14 |
| P2-S75 | AM-I14 |
| P2-S76 | AM-I14 |
| P2-S77 | ACCT-I13 |
| P2-S78 | AM-I14 |
| P2-S79 | AM-I14 |
| P2-S80 | ACCT-I20 |
| P2-S81 | AM-I14 |
| P2-S82 | ACCT-I17 |
| P2-S83 | ACCT-I17 |
| P2-S84 | AM-I14 |
| P2-S85 | ACCT-I13 |
| P2-S86 | ACCT-I15 |
| P2-S87 | ACCT-I10 |
| P2-S88 | ACCT-I10 |
| P2-S89 | ACCT-I16 |
| P2-S90 | ACCT-I16 |
| P2-S91 | ACCT-I18 |
| P2-S92 | AM-I1 |
| P2-S93 | ACCT-I15 |
| P2-S94 | AM-I14 |
| P2-S95 | ACCT-I16 |
| P2-S96 | ACCT-I16 |
| P2-S97 | ACCT-I10 |
| P2-S98 | AM-I9 |
| P2-S99 | ACCT-I4 |
| P2-S100 | ACCT-I15 |
| P2-S101 | AM-I23 |
| P2-S102 | ACCT-I16 |
| P2-S103 | AM-I11 |
| P2-S104 | AM-I23 |
| P2-S105 | ACCT-I15 |
| P2-S106 | AM-I23 |
| P2-S107 | AM-I23 |
| P2-S108 | AM-I23 |
| P2-S109 | ACCT-I15 |
| P2-S110 | ACCT-I8 |
| P2-S111 | AM-I23 |
| P2-S112 | AM-I9 |
| P2-S113 | ACCT-I13 |
| P2-S114 | AM-I23 |
| P2-S115 | ACCT-I17 |
| P2-S116 | ACCT-I10 |
| P2-S117 | AM-I14 |
| P2-S118 | ACCT-I10 |
| P2-S119 | AM-I14 |
| P2-S120 | ACCT-I8 |
| P2-S121 | ACCT-I17 |
| P2-S122 | ACCT-I8 |
| P4-S01 | MONEY-I12 |
| P4-S02 | MONEY-I12 |
| P4-S03 | MONEY-I12 |
| P4-S04 | MONEY-I12 |
| P4-S05 | MONEY-I12 |
| P4-S06 | MONEY-I12 |
| P4-S07 | MONEY-I12 |
| P4-S08 | AM-I1 |
| P4-S09 | AM-I1 |
| P4-S10 | AM-I5 |
| P4-S11 | ACCT-I13 |
| P4-S12 | ACCT-I8 |
| P4-S13 | AM-I24 |
| P4-S14 | MONEY-I25 |
| P4-S15 | AM-I6 |
| P4-S16 | AM-I6 |
| P4-S17 | AM-I5 |
| P4-S18 | MONEY-I25 |
| P4-S19 | AM-I11 |
| P4-S20 | AM-I11 |
| P4-S21 | AM-I11 |
| P4-S22 | AM-I11 |
| P4-S23 | AM-I19 |
| P4-S24 | AM-I11 |
| P4-S25 | AM-I11 |
| P4-S26 | AM-I11 |
| P4-S27 | AM-I11 |
| P4-S28 | MONEY-I2 |
| P4-S29 | MONEY-I2 |
| P4-S30 | MONEY-I3 |
| P4-S31 | MONEY-I2 |
| P4-S32 | MONEY-I2 |
| P4-S33 | MONEY-I2 |
| P4-S34 | MONEY-I2 |
| P4-S35 | MONEY-I2 |
| P4-S36 | MONEY-I2 |
| P4-S37 | MONEY-I3 |
| P4-S38 | MONEY-I3 |
| P4-S39 | MONEY-I3 |
| P4-S40 | MONEY-I28 |
| P4-S41 | MONEY-I3 |
| P4-S42 | MONEY-I3 |
| P4-S43 | MONEY-I26 |
| P4-S44 | MONEY-I26 |
| P4-S45 | MONEY-I26 |
| P4-S46 | MONEY-I26 |
| P4-S47 | MONEY-I26 |
| P4-S48 | MONEY-I26 |
| P4-S49 | MONEY-I26 |
| P4-S50 | MONEY-I26 |
| P4-S51 | MONEY-I12 |
| P4-S52 | MONEY-I12 |
| P4-S53 | MONEY-I25 |
| P4-S54 | MONEY-I27 |
| P4-S55 | AM-I9 |
| P4-S56 | MONEY-I3 |
| P4-S57 | MONEY-I27 |
| P4-S58 | MONEY-I12 |
| P4-S59 | AM-I1 |
| P4-S60 | ACCT-I20 |
| P4-S61 | ACCT-I20 |
| P4-S62 | AM-I22 |
| P4-S63 | ACCT-I17 |
| P4-S64 | AM-I11 |
| P4-S65 | AM-I11 |
| P4-S66 | AM-I9 |
| P4-S67 | MONEY-I26 |
| P4-S68 | AM-I9 |
| P4-S69 | AM-I11 |
| P4-S70 | MONEY-I12 |
| P4-S71 | MONEY-I2 |
| P4-S72 | AM-I23 |
| P4-S73 | MONEY-I2 |
| P4-S74 | MONEY-I3 |
| P4-S75 | MONEY-I3 |
| P4-S76 | MONEY-I28 |
| P4-S77 | MONEY-I3 |
| P4-S78 | MONEY-I26 |
| P4-S79 | MONEY-I26 |
| P4-S80 | MONEY-I27 |
| P4-S81 | MONEY-I27 |
| P4-S82 | AM-I24 |
| P4-S83 | MONEY-I25 |
| P4-S84 | MONEY-I3 |
| P4-S85 | MONEY-I3 |
| P4-S86 | MONEY-I26 |
| P4-S87 | MONEY-I26 |
| P4-S88 | MONEY-I26 |
| P4-S89 | MONEY-I3 |
| P4-S90 | MONEY-I27 |
| P4-S91 | MONEY-I27 |
| P4-S92 | MONEY-I25 |
| P4-S93 | MONEY-I25 |
| P4-S94 | MONEY-I25 |
| P4-S95 | MONEY-I26 |
| P4-S96 | ACCT-I17 |
| P4-S97 | AM-I19 |
| P4-S98 | AM-I9 |
| P4-S99 | MONEY-I3 |
| P4-S100 | MONEY-I12 |
| P4-S101 | AM-I22 |
| P4-S102 | MONEY-I2 |
| P4-S103 | MONEY-I27 |
| P4-S104 | MONEY-I27 |
| P4-S105 | MONEY-I25 |
| P4-S106 | MONEY-I27 |
| P4-S107 | MONEY-I25 |
| P4-S108 | AM-I22 |
| P4-S109 | MONEY-I27 |
| P4-S110 | MONEY-I3 |
| P4-S111 | MONEY-I25 |
| P4-S112 | MONEY-I25 |
| P4-S113 | MONEY-I27 |
| P4-S114 | MONEY-I25 |
| P4-S115 | MONEY-I3 |
| P4-S116 | MONEY-I3 |
| P4-S117 | MONEY-I26 |
| P4-S118 | MONEY-I26 |
| P4-S119 | MONEY-I12 |
| P4-S120 | MONEY-I27 |

Contributions to scenarios of other slices (the primary slice places them; listed here
only to show where this plan gives its part): P1-S07, P1-S08, P1-S11, P1-S12, P1-S14,
P1-S34, P1-S70, P1-S73, P1-S74, P1-S77 (ACCT-I8, ACCT-I10); P1-S41, P1-S42, P1-S63, P1-S78
(ACCT-I10); P1-S46 (AM-I14); P1-S47 (ACCT-I20); P1-S31 … P1-S61, P1-S71, P1-S84
(ACCT-I21); P1-S54, P1-S62 (AM-I23); P3-S11, P3-S43, P3-S44, P3-S60, P3-S63, P3-S74
(ACCT-I17); P3-S12, P3-S13, P3-S27, P3-S61 (MONEY-I3); P3-S37, P3-S76 (AM-I6); X1-S05,
X1-S07, X1-S08, X1-S09 (AM-I1, ACCT-I7); X1-S06 (AM-I9); X1-S10 (MONEY-I12); X1-S16,
X1-S27, X1-S36 (AM-I19); X1-S28 (MONEY-I28); X1-S46 (MONEY-I26); X1-S49 (AM-I24); X2-S07
(MONEY-I12); X2-S08, X2-S17 (AM-I11); X2-S13 (MONEY-I2, MONEY-I3); X2-S14 (MONEY-I2,
MONEY-I12); X2-S18 (AM-I5); X2-S22 (AM-I6); X2-S10 (AM-I23); X2-S20, X2-S24, X2-S27
(AM-I24); X2-S03, X2-S05, X2-S06, X2-S15, X2-S21 (AM-I29).

## 8. Risks

### 8.1 Contract issues: plan around them, do not block

| Issue | Effect on this plan | Work item or acceptance |
|---|---|---|
| CI-B-1 (C04 m-11 and PL-9 need the account owner to record a late partner residue; C12 has no message that tells the owner) | E16 cannot be written. Late `pol28_residue` events are missing. Rating has no Share-cost line for a late residue | ACCT-I18 builds E16 behind a switch, fed by the proposed `RESIDUE_CANCELLED` result. C04 PL-9 stays **pending**. Operations sees the residue on the reconciliation feed and the alert meanwhile. When C12 adds the result, one small increment turns the switch on and runs PL-9 |
| CI-B-2 (C12 has no yield claim; on a partner leg, a holder that refused a yield cannot accept later for the same attempt) | P2-S118 holds on Share links (ACCT-I10). On a partner leg it holds only after the holder's own outcome | Accepted with RFC-002's reason: the adapter asks only holders it believes waiting, so the case is rare. ACCT-I16 tests the interim behaviour (the holder keeps its partner hold until its outcome; the older waiter is re-asked in priority order). When C12 adds the claim, add one increment |
| CI4-1 (no frozen contract carries "every payout to a destination version is final and reconciled" from payouts to identity) | Identity cannot know when to erase a payout destination's details (POL-19, X1-S46) | MONEY-I26 publishes `DestinationVersionSettled` as RFC-004 §B7.7 states, and keeps each version's details until then. The event is outside C07 v1.2 until the erratum. S-SEC-I16 is its consumer |
| CI4-2 (C05 `ResumeQuote` has no `headroom_after`; C10 and P4-S114 need it) | The resume quote states the headroom after it | AM-I11 adds `headroomAfter` as an optional, additive field (C05 versioning permits it). MONEY-I25 tests P4-S114 with it. Propose the C05 erratum |
| CI4-3 (C06 `lateCut` names its third field `extensionChunk`; C03, C04 and RFC-000 4.5 use the target revision) | The ledger could compare the wrong field | MONEY-I3 stores and compares `lateCut` as one opaque value. The third field carries the target revision. Propose the C06 rename as a coordinated minor version |

### 8.2 RFC risks

| Risk | Treatment |
|---|---|
| RB-1 (partner API capacity) | Spike SP3; adapter rate limit for each partner (ACCT-I15); overload is transient |
| RB-2 (partner clock skew and short deadlines) | Spike SP3; `σ_p` in partner terms; alarm by S-PLAT |
| RB-3 (yield churn) | Measured in ACCT-I10 |
| RB-4 (large accounts) | Row-level TTL (ACCT-I7); slot of its own (AM-I24 with placement) |
| RB-5 (co-dependency of RFC-002 and RFC-004 Part A) | `AM` increments with both teams; C05 is the one interface; T1 in AM-I23 |
| RB-7 (partner result unknown past `D − τ`) | Query at once and reconcile (ACCT-I16, ACCT-I18) |
| RB-8 (priority across accounts relies on clocks) | Accepted: safety does not depend on it; `ε` monitored by S-PLAT |
| RB-10 (counter-offer cost) | Measured in ACCT-I8: a rejection adds one parallel round trip (est. 5 to 10 ms) |
| RB-11 (complexity of the account owner) | T1 model check in AM-I23; the entry registry is closed; C01 CC-8 checks the declaration in every increment |
| RB-12 (confirm near its fence lost to a slow commit) | Accepted: safe by construction; counted as "deadline passed"; SP2 measures |
| RB-13 (inbound feeds on Kafka) | Catch-up after 20 s of silence and the 45 s gate (AM-I9) |
| RB-14 (status reads during a range-lease move) | T7 in AM-I23 |
| RB-15 (partner cancellations on displaced routes) | Counted as POL-28 residue; T10 runs in ACCT-I15 with ACCT-I10's displacement path |
| RB-16 (thin X2-S15 margin) | Spike SP1; second lane before go-live if needed; AM-I29 measures |
| RB-17 (the 45 s gate stops a slot when Kafka and identity are both unreachable) | Accepted: alarm at 30 s of staleness; catch-up every 5 s (AM-I9) |
| RB-18 (in-transaction evaluation lengthens batches) | Spike SP1; T3 and T8 |
| RB-19 (catalogue freshness gate) | ACCT-I7 (CT-A3); depends on S-RATE publishing versions 1 min ahead |
| RB-20 (probe load and noise) | AM-I24 and AM-I29 measure; lever: fewer slots and the second lane |
| RB-21 (fan-out of a deep reduction) | Coalesced and paced leg commands (ACCT-I20); AM-I29 runs a reduction to half at design load |
| RB-23 (quote key custody) | Fails safe (`terms_changed`); blocker 2 below; T18 in ACCT-I17 covers re-slotting and rotation |
| RB-24 (leg-command queues serialise decisions on one reservation) | Measured in T22 (AM-I14) and T8 (AM-I29) |
| RB-25 (late partner residues) | See CI-B-1 |
| RB-6, RB-9, RB-22 | Closed in the RFC. No work |
| R4-A1 (rating lag moves the hold window) | Accepted: headroom stays correct; S-PLAT monitors `now − p_r` |
| R4-A2 (non-determinism in the funds module) | C05 P1 from AM-I1 on; determinism lint; outcomes recorded and compared by every replay |
| R4-A3 (F2 volume) | Closed in the RFC (2 s interval). AM-I6 measures |
| R4-A4 (very large accounts) | Movement split at 5,000 lines (MONEY-I2); hot ranges split by the database |
| R4-A5 (430 s lateness bound) | Accepted by the requirements; the query itemises `LB` (AM-I6) |
| R4-A6 (product-wide price change) | AM-I22 measures |
| R4-A7 (the envelope over-holds) | Accepted: held at most until the decision (≤ 60 s) |
| R4-A8 (F2 applied late) | Apply-lag alert (AM-I6) |
| R4-B1 (segment encoding) | History's layout; S-PLAT's R1 spike measures. No work here |
| R4-B2 (cuts need the closed timestamp and the MVCC window) | Spike SP4; MONEY-I26 measures; a missed cut is re-derived from sealed segments |
| R4-B3 (report formats and times unknown) | MONEY-I27 assumes 06:00 UTC; the 12:00 alert covers lateness; external dependency 5 below |
| R4-B4 (payout providers without idempotency) | Listing condition; lots make a second execution a debt (MONEY-I26) |
| R4-B5 (safeguarding depends on treasury) | Alert within a day (MONEY-I27) |
| R4-B6 (quote linkage on top-ups) | The partner rate at notification applies without it (MONEY-I12) |
| R4-B7 (supplier statement volume) | Daily aggregates; drill-down from segments (MONEY-I28) |
| R4-B8 (pushed transactions retry) | Spike SP1 |
| R4-B9 (card-like providers) | `settlement_lag_max` alert (MONEY-I27) |
| R4-B10 (payout destination erasure signal) | See CI4-1 |
| R4-B11 (a refused usage batch costs one gated cycle) | Measured in MONEY-I3 |

### 8.3 Requirements and architecture issues

| Issue | Treatment |
|---|---|
| B-RQ-12 (when a recorded partner term is in force; P2-S121 row 4) | The business decision is kept: a partner-terms version takes effect at least 1 min after it is recorded. ACCT-I17 writes the row-4 test for that reading and marks it **pending** until the requirements amendment |
| B-AI-14 (custody of the quote key) | Blocker 2 below |
| B-AI-15 (lead time of partner terms) | The catalogue must publish partner-terms versions with `effectiveFrom` at least 1 min after their record. ACCT-I17 depends on it for P2-S121 rows 1 to 3 to be safe in production. S-RATE work item; see blocker 4 |

## 9. Blockers and external dependencies

No hard blocker for any increment to start. These items gate production use or one test:

1. **S-PLAT delivery of the C01 subset** (§3). The S-PLAT plan is not yet written. Each
   increment can start on the C01 double and must pass again on the real runtime.
2. **Quote key release (B-AI-14).** No frozen contract gives the account owner its
   per-account-slot quote key. RFC-005's key release must add this purpose. The S-SEC plan
   has no work item for it. ACCT-I17 is built and tested against a key-release double.
   Production quotes wait for S-SEC.
3. **Equivalent-path source (C12 §2.4).** Routing is out of scope in RFC-002 and no slice
   implements it. ACCT-I21 is built and tested against a double. Production offers wait
   for an owner of routing.
4. **Partner-terms lead time (B-AI-15).** C06 v1 CT-R2 checks lead times for prices,
   weights, caps and parameters, not partner terms. S-RATE must publish partner-terms
   versions at least 1 min ahead. Until then the P2-S121 row-4 test stays pending, and a
   partner-terms change can turn a valid quote into `terms_changed` (fails safe).
5. **External parties.** Partner sandboxes for each first driver (C12 §10.3, SP3);
   payment providers and the payment partner (C07 op 3, op 4c); payout providers (op 4a,
   4b); bank statement formats (R4-B3); network operations as consumer of the standing feed
   and sender of the enforcement acknowledgement (C05). Each increment uses simulators or
   stubs until the party is onboarded.
6. **Onboarding and workforce administration** are outside P2 and P4. KYB status (F4),
   finance roles (AM-I24) and treasury actions (MONEY-I27) use test drivers that send
   their commands from their workload identities.
