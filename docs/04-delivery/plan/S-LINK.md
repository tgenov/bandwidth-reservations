# S-LINK delivery plan: link schedule and admission

| | |
|---|---|
| Slice | S-LINK (primary spec P1, 85 scenarios) |
| Status | Draft for C5 plan review |
| Authority | [RFC-001](../../03-rfcs/RFC-001-link-admission.md) revision 6 (taken as accepted). Frozen contracts: [C01](../contracts/C01-platform.md) v1, [C02](../contracts/C02-link-hold.md) v1.0.0, [C03](../contracts/C03-link-schedule.md) v2.4, [C06](../contracts/C06-usage-and-charges.md) v1, [C08](../contracts/C08-identity-and-access.md) v1.2. Requirements at tag `requirements-v1.11` ([P1 feature](../../02-specs/P1-link-admission.feature)). [RFC-000](../../03-rfcs/RFC-000-architecture.md) revision 4.5 |
| Prior code | `src/tree.ts`, `src/links.ts`, `src/sql.ts`, `src/routes.ts`, `src/partner.ts`, `schema.sql` and the tests that `docs/02-specs/conformance.md` cites (§3) |
| Language | ASD-STE100 Simplified Technical English |

## 1. Rules for this plan

1. Each increment is small and can ship alone to the integration environment. "Ship"
   means: all exit criteria of this increment and of every earlier increment pass, and
   nothing that the increment ships gives a wrong answer. A function that is not built
   yet gives an explicit error (for example `UNAVAILABLE`). It never gives a wrong
   answer.
2. An increment depends only on frozen contracts or on earlier increments of this slice.
   Each other dependency is a blocker. §4 lists the blockers by name.
3. S-LINK is the first slice to build. Thus the first increments give the parts that
   S-ACCT needs first: the hold port (I1 … I6), the feed (I7) and failover (I8).
4. A P1 scenario usually starts at the buyer and goes through the account owner (S-ACCT).
   This slice proves the **link part** of the scenario at the C02 and C03 boundary. A
   **recorded account-owner stub** replays the C02 consumer side. A **supplier and console
   stub** sends the C03 supply commands. The scenario is put in the increment where the
   link part is complete. The account owner proves its part with its C02 consumer tests.
   The joint traces of C02 "Joint tests" run again with the real account owner at C6.
5. Until S-PLAT delivers a C01 part, the team uses a **C01 runtime double** that passes
   C01 §10.2 CC-1 … CC-8. Each exit criterion that names "the runtime" must then pass
   again on the real C01 runtime before the increment is complete.
6. Figures marked "est." come from RFC-001 §9. A spike (§5) replaces a figure before the
   increment that it gates.
7. Milestones. **M1, booking path** (I1 … I9): S-ACCT can integrate. **M2, supply path**
   (I10 … I15): suppliers and operators can change capacity. **M3, design load** (I16).
   No production log exists before M1. The team discards integration-environment logs
   when I7 adds feed events to the entries.

## 2. Components and owners

RFC-001 defines two components: the **link schedule owner** (one partition per Share
link, §1) and the **link registry** (the link part of the catalogue, §10). The table
splits the link schedule owner into its modules. One team builds and runs both
components.

| Component or module | Responsibilities (RFC-001) | Owner (role) |
|---|---|---|
| **Link schedule owner: occupancy trees** | Sparse augmented B+tree by minute, fanout 32, fields `sum`, `maxpref`, `minpref`, `carry`; typed-array arenas; generations for pinned copies; queries `prefix`, `value`, `peak`, `first_above`, `first_at_or_below`, `last_above`, `conflicts`; three trees `occ_firm`, `occ_all`, `occ_commit` (§3.1, §3.2) | Link owner team |
| **Link schedule owner: apply state machine** | Entries of §7.3 and their apply; holds, waiters, attempts, yields, tombstones, request records; capacity profile as levels; displacement; reductions, caps and steps; offer holds; invariants I1 … I6; determinism and step budgets (§3.3, §3.4, §4, §5, §7.3, §7.4) | Link owner team |
| **Link schedule owner: ports** | C02 provider: link hold port, link waiting port, outcome and expiry port (link side), availability query, displacement table. C02 sender: `expire_if_undecided`, `offer_outcome_if_lapsed`, `cut_target`. C03 provider: `LinkSupply` commands and the link schedule feed (§11.1) | Link owner team |
| **Link schedule owner: projections** | `link_request`, `link_displacement`, `link_reduction_cut`, `link_projection`; outage flags and notices; reduction projection; slices, coalescing, standby offload (§5.4, §5.7, §7.1, §7.5) | Link owner team |
| **Link schedule owner: runtime integration** | Owner declaration; hooks `onAcquire`, `onRelease`, `onMovedOut`, `onAdopt`; timers; hot-standby push and gap fill; checkpoints; `Compact`; alert episodes (§7.1, §7.2, §7.6, §8, §11.1) | Link owner team |
| **Link schedule owner: identity duties** | C08 receiver checks on supplier principals; operator envelope checks and `operator_check`; target summaries for `link` targets; read-grant reader for `read_link_schedule`; policy feed and key-certification stream (§5) | Link owner team |
| **Link registry** | Owner kind for link records: `register_link`, `retire_link` (two steps), `set_probe`, `get_link`, registry feed by `(link_id, version)` (§10) | Link owner team |
| **Test harness** | Per-minute oracle, level oracle, greedy-cut oracle, recorded account-owner stub, supplier and console stub, fault injection, load rig (§12) | Link test lead |

Components of other slices that this slice consumes: the C01 owner runtime, placement,
relay, closure emitter, history, checkpoint store and the notifier (S-PLAT); identity
and access, the console, audit and the C13 encryption library (S-SEC); the account
owner (S-ACCT), for joint tests only.

## 3. Existing code and what happens to it

The conformance matrix cites these tests as *prior evidence, to be re-validated*:
`test/tree.test.ts` (P1-S01 … S04, S06, S21, S23), `test/sql.test.ts` (P1-S02, S04, S05,
S18), `test/concurrency.test.ts` (P1-S13) and `test/routes.test.ts` (P1-S13). None of
them proves a scenario of `requirements-v1.11`. This plan replaces each with a test of
the new owner. The team does not edit `conformance.md` before C6.

| File | What it is | Decision |
|---|---|---|
| `src/tree.ts` | Dense segment tree over a fixed horizon; `sum` and `maxpref`; `Float64Array`; `checkWindow` | **Keep as reference, do not extend.** The monoid is the one RFC-001 keeps (D11). The new tree is sparse, has no horizon, and adds `minpref`, `carry` and generations. `tree.ts` is the baseline in SP1 and the fallback of risk R1-4 (dense ring tree for a hot link) |
| `src/links.ts` | `LinkBook`: two trees (confirmed, total), three outcomes, wound-wait, holds that expire by TTL, pinned holds, `Date.now` | **Retire.** The two-tree idea becomes `occ_firm` and `occ_all`, and the order "no fit on committed, then fit beside holds" stays. Wound-wait, TTL expiry, pinning and wall-clock decisions are rejected by RFC-001 (Competition; A8, A9) |
| `src/sql.ts`, `schema.sql` | Postgres link-row lock as the authority; `READ COMMITTED` | **Retire.** RFC-001 rejects the row lock as the authority (Competition, D12). The substrate is CockroachDB through C01 |
| `src/routes.ts`, `src/partner.ts`, `schema-routes.sql` | Route saga coordinator and simulated partner | **Not S-LINK.** These are S-ACCT's prior art (RFC-002). S-LINK does not change them |
| `test/helpers.ts` | `ArrayOracle` (one cell per minute), seeded `rng` (mulberry32), `percentile` | **Reuse.** The per-minute oracle of T-01 extends `ArrayOracle` with holds, three occupancies and capacity levels. `rng` seeds every property test |
| `test/tree.test.ts`, `test/links.test.ts`, `test/sql.test.ts`, `test/concurrency.test.ts` | Tests of the files above | **Port the cases, not the code.** I1 and I4 write the cases again (touching windows, exact fit, A/B peak, year-long, open-ended) against the new tree and the C02 port, with scenario IDs in their names |

Coordination rule: `routes.ts` imports `links.ts` and `tree.ts`. The team puts the new
owner in its own package path. It deletes `links.ts`, `tree.ts`, `sql.ts` and
`schema.sql` only after the S-ACCT plan retires `routes.ts`.

## 4. Dependencies outside this slice and blockers

### 4.1 S-PLAT: minimum C01 subset, by name

The S-PLAT plan is not written yet. Thus each row is a **blocker** until S-PLAT plans it.
The C01 runtime double (§1 rule 5) lets work start before it.

| Name | C01 parts | Needed by |
|---|---|---|
| **PLAT-A** (I1 minimum) | Owner declaration and the migration tool for kind `link` (§2.2); `link_log` and `link_head` with the `chain` column, `owner_session`, `owner_slot`, `platform_timing`, owner grants (§2.3); `OwnerRuntime.append` in the static and the `decide` form with declared `reads` (§2.4); results `Committed`, `ConditionFailed`, `Retry`, `StaleEpoch`, `Ambiguous` with the resolution steps (§3.1, §3.2); one batch transaction in flight per slot lane (§3.2); `leaseValid`, `epoch`, `generation`, `admitCommand`, `now` (§2.4); `OwnerHooks.onAcquire`, `onRelease`; sessions, expiry acquisition and the takeover-entry rule (§3.1); `route` for the link kind with a fixed slot count; `CommandEnvelope` and `RoutingRefusal` as gRPC metadata (§2.4); column encryption binding with a development key provider (§3.12); a CockroachDB cluster for development | SP4, I1 |
| **PLAT-B** | Projection declarations with `rowTtl` and `deletable`; projection writes in `append` (§2.2, §2.4) | I2 |
| **PLAT-C** | Outbox for point-to-point notifications (`NotificationOut`), relay, `onNotification`, gap-fill roles (§2.3, §3.5) | I3 |
| **PLAT-D** | Streams with `emitFn`, the Kafka relay for `link.schedule.v1` and `link.alert.v1`, per-topic producer ACL (§2.5, §3.5); closure emitter with `closedPerLink` and `onClosed` (§3.6); alert episodes and `cleared` (§3.11); history query with `bitemporalQueries` and the sealer (§3.9) | I7 |
| **PLAT-E** | `timer`, `cancelTimer` (§3.7); `putCheckpoint`, `getCheckpoint`; standby role and two standbys per link slot; handoff and re-home (§3.1); move protocol with `onMovedOut`, `onAdopt`, `Moving`, `Moved` (§3.3); integrity stop with `Stopped` (§3.2); `Overloaded` | I8 |
| **PLAT-F** | `AppendOptions.exclusive`, `firstStatement`, `abandonBeforeCommitMs`; batch retry on the same transaction that keeps its intents (`batch_retries`); `displacementRead` condition for the account kind, or a harness that does the same read; a 2 + 2 + 1 cluster (R1, R2, R3) | SP3, I11 |
| **PLAT-G** | 2 + 2 + 1 cluster at design size with the R3 non-voter; region-wide lease move; disaster mode; load generators; RFC-006 notifier that consumes `AFFECTED_NOTICE` | SP2, SP4 (cluster), I12 (notifier, end-to-end only), I16 |

### 4.2 S-SEC: C08 parts

C08 v1.2 is frozen. The S-SEC plan delivers its parts in S-SEC-I1 (`audit_append`,
key-certification stream), S-SEC-I2 (principal context complete, policy feed), S-SEC-I3
(operator envelope, `operator_check`, target summary) and S-SEC-I5 (read grant). Until
then, S-LINK uses the C08 contract doubles and golden vectors that S-SEC publishes.
These are blockers for the exit of I9 only (named **SEC-A**). SP5 needs the feed-key
sealing of the C13 library (named **SEC-B**).

### 4.3 Blockers that are not deliveries

| # | Blocker | Effect | Plan meanwhile |
|---|---|---|---|
| BL-1 | No S-PLAT plan exists. PLAT-A … PLAT-G are not scheduled | I1 cannot complete its exit on the real runtime | Build on the C01 runtime double. Ask the orchestrator to plan PLAT-A first |
| BL-2 | **The link-registry feed and `get_link` have no frozen contract.** RFC-001 §10 and §11.1 define them. RFC-000 §8 has no row for them, and C01 … C12 do not freeze them. RFC-002, RFC-003, RFC-004, RFC-005 and RFC-006 consume them (C06 settled C06-M14 points to "RFC-001's link-registry feed") | Other slices cannot build consumers of the registry feed against a frozen schema. I9's consumer-facing exit criterion is blocked | I9 builds the registry to RFC-001 §10. The team proposes a contract for the registry feed and `get_link` to the orchestrator (C4) |

## 5. Spikes

RFC-001 marks these estimates as ones the design depends on. Each spike gives one
measurement and one decision. A spike must close before the increment that it gates.

| Spike | Measurement | Decision it unlocks | Starts after | Gates |
|---|---|---|---|---|
| **S-LINK-SP1** Occupancy tree in V8 (R1-4, R1-9, R1-10) | p50 and p99 of `add`, `peak`, `first_above`, `conflicts` at 530,000 keys per tree (est. 10 to 40 µs per entry); memory of three trees (est. 80 MB) and of 10 M parts (est. 1 GB); GC pauses with typed-array arenas against plain objects; copy cost while a generation is pinned (est. 50 MB/s). Baseline: `src/tree.ts` (dense ring tree) | Sparse B+tree for every link, or the dense ring tree above a change-point threshold, or a native module behind the same interface. The per-entry cost figure in I1's exit | Now | I1 |
| **S-LINK-SP2** One event loop at the hottest link (R1-7, R1-3, R1-2) | Entries per second of the apply with serialisation, encryption and gRPC on the event loop and on worker threads (est. 20,000/s and 40,000/s); share of holds answered `WAITING` in the design mix (est. 1 to 5%); worst flash-crowd scan (est. 7,500 waiters) | Serialisation and encryption on worker threads, yes or no. Whether to ask for a second in-flight batch per hot link (C01 v1 excludes lane (c); a new C01 version is then necessary) | I3 | I16 |
| **S-LINK-SP3** Capacity-lowering transaction on 2 + 2 + 1 (R1-1, T-12) | Retries per capacity-decrease transaction while confirms read the markers, at the hottest link's design load (about 190 holds in flight) and in a flash crowd; that a restart keeps its intents; lock waits of the confirm reads | Marker intents first, as designed (target: at most one retry), or the fallback: a floating timestamp, or confirms on that link paused for one commit | I1 | I11 |
| **S-LINK-SP4** Hottest link tail range and `link_request` volume (R1-11, R1-13) | One range under about 50 transactions/s, 150 log rows per batch, 3 MB/s; `link_request` at 2,500 rows/s with a 24 h row TTL (est. 216 M rows, 10 GB per copy) | One log row per entry (C01 as frozen), or one row per batch (needs a C01 change: an issue to the orchestrator); `link_request` kept, or post-expiry repeats answered from history | I1 | I16 |
| **S-LINK-SP5** Notice size and flag projection throughput (C03 PT-9, R1-5) | Mean encoded and sealed `AFFECTED_NOTICE` value (budget 200 B); flag projection time and Kafka arrival for 100,000 reservations (budget 15 s at p99) | The C03 split (link 15 s, notifier 40 s, margin 5 s) or C03's binding fallback (300 B; 20 s, 35 s, 5 s) | I7 | I12 |

RFC-000's spike R1 (latency budget, owned by S-PLAT) needs a NestJS link owner on the
single-link path. The I1 owner is that owner.

## 6. Increments

Each increment lists the contracts it introduces (as provider) and consumes, with
versions. Test IDs: RFC-001 §12 "T-n"; C02 "provider test n" (C02 "Conformance tests");
C03 "PT-n"; C01 "CC-n"; C08 "C-n".

### S-LINK-I1. Walking skeleton: hold, convert and release on one link

| | |
|---|---|
| Goal | One Share link with a registered capacity sells through C02 `hold`, `convert` and `release` on the C01 runtime, and never oversells (P1-N1). A property test proves it |
| Components | Occupancy trees (`occ_firm`, `occ_all`; `add`, `value`, `peak`, `conflicts`). Apply state machine: entries `Init` (by fixture command, with the initial policy), `Takeover`, `Hold`, `Convert`, `Release`; request records and tombstones in memory. Ports: C02 gRPC server for `hold`, `convert`, `release`. Runtime integration: owner declaration for `link_log` and `link_head`; `onAcquire` rebuilds by replay of the log and compares each recorded outcome (§7.4). Test harness: per-minute oracle, recorded account-owner stub |
| Contracts introduced | C02 v1.0.0, part: `hold` checks (1), (2) with `MISMATCH`, (3), (5) and (7) without a counter-offer, (6); `convert` (no clip, no displacement); `release` |
| Contracts consumed | C01 v1 (PLAT-A) |
| Known limit | `wait = true` is not supported. The stub sends `wait = false` only. I3 removes this limit. No buyer traffic before M1 |
| Scenarios delivered | P1-S01, P1-S02, P1-S03, P1-S04, P1-S05, P1-S06, P1-S08, P1-S09, P1-S10, P1-S13, P1-S14, P1-S37, P1-S77 |
| Exit criteria | (1) **Property test** (T-01 part, T-02, T-03): 8 seeds × 2,000 commands (`hold`, `convert`, `release`) from 50 concurrent stub clients, through gRPC and the runtime. Each outcome is equal to the per-minute oracle applied in log order. After each entry, `occ_all` ≤ `C_ref` at every minute, computed again from the log rows alone. A `wait = false` refusal stays refused after the release of its blocker. (2) A scenario test for each scenario above passes as a recorded trace at the C02 boundary. (3) T-09 passes (release before hold answers `TOMBSTONED` with no digest check; duplicates; convert without hold answers `NO_HOLD`; hold at `D_c`). (4) C02 provider test 1 (cases `TOMBSTONED`, repeat after release, `ts ≥ D_c`, `NO_FIT`, `IN_FLIGHT`), 2, 3 (duplicate, `MISMATCH`, changed envelope is a duplicate), 4 (`convert` with another attempt gets `MISMATCH`). (5) C01 CC-1 (on the double), CC-5 receiver side, CC-7, CC-8. (6) Stop the owner process. A new holder rebuilds by replay, finds no outcome difference, and answers a repeated command with its recorded reply. (7) **Measurement**: the apply cost of one `hold` does not depend on the window length: p99 ≤ 40 µs (est.; SP1 sets the figure) for windows of 1 min, 1 day, 12 months and open-ended, at 530,000 keys. This is the link part of X2-S05 "whatever the booking's length". (8) Criteria (1), (3), (5) and (6) pass again on the real C01 runtime |
| Dependencies | SP1. Frozen C01, C02. PLAT-A (blocker BL-1) |

### S-LINK-I2. Counter-offers, request records and the availability query

| | |
|---|---|
| Goal | Each refusal carries the POL-10 counter-offer beside held capacity. A repeat after the memory record has gone gets the same answer. RFC-002 can ask the link for availability |
| Components | Trees: `minpref`, `first_above`, `first_at_or_below`, `last_above`, change counter. Apply: largest rate and earliest window with `counteroffer_steps` and `counteroffer_batch_steps` (from the policy of `Init`), the per-batch cache keyed by the change counter. Projections: `link_request` (24 h row TTL). Ports: `query`; `availability`, `fit_ranges` |
| Contracts introduced | C02 v1.0.0: counter-offer on `NO_FIT` and `IN_FLIGHT`; `query`; link availability query |
| Contracts consumed | C01 v1 (PLAT-B) |
| Scenarios delivered | P1-S12, P1-S15, P1-S16, P1-S17, P1-S38, P1-S39, P1-S70, P1-S73 |
| Exit criteria | (1) T-04 passes: counter-offers equal the oracle, with open-ended requests, a schedule full for ever, several blockers, the step bound and the batch budget (equal outcomes on two machines of different speed), the cache made invalid by a hold between two refusals, and a retry after a takeover and after 24 h less 1 min that returns the recorded counter-offer. (2) C02 provider test 3, last case (`link_request` answers a repeat). (3) P1-S17: a schema check shows that no refusal or availability answer carries an account, a reservation or traffic. (4) **Measurement**: one refusal at the 512-step bound ≤ 1 ms, one batch at the 4,096-step budget ≤ 5 ms (est.). This keeps counter-offers off the link part of X2-S05 |
| Dependencies | I1. PLAT-B |

### S-LINK-I3. Waiting, grants and the waiting port

| | |
|---|---|
| Goal | A request with `wait = true` that only capacity in flight blocks waits. Released capacity goes to the oldest waiter that it fits, in the entry that frees it |
| Components | Apply: waiters in `priority_rule` order (`request_age`, ties by request identity); the scan with `scan_steps` and `Tick` continuations that hold the link's queue; `GRANTED` at the same attempt; `WAITING_NOTICE` with the latest blocker deadline; `WAITER_REFUSED` with a counter-offer; waiters past `D_c` skipped. Ports: notifications as outbox rows, pushed and relayed |
| Contracts introduced | C02 v1.0.0: `hold` check (8) `WAITING` (no yields yet); link waiting port `WAITING_NOTICE`, `GRANTED`, `WAITER_REFUSED` |
| Contracts consumed | C01 v1 (PLAT-C) |
| Scenarios delivered | P1-S07, P1-S11, P1-S34 |
| Exit criteria | (1) T-07 passes (no yield parts). (2) T-08b passes: a `GRANTED` lost on the push and relayed later is applied; duplicates by (request, attempt, kind) have no effect; `query` restores a lost notice. (3) C02 provider tests 1 (`WAITING`), 4 (a grant keeps the attempt), 13 (first two items). (4) The property test of I1 runs with `wait = true` and waiters, against the oracle extended with POL-05 waiting. (5) **Measurement**: a scan of 1,024 waiters ≤ 1 ms; a flash crowd of 7,500 waiters completes in at most 8 continuations (≈ 8 ms, est.). This is the link part of X2-S05 "final or pending" |
| Dependencies | I2. PLAT-C |

### S-LINK-I4. Validity and the rolling horizon

| | |
|---|---|
| Goal | The link checks V1 … V6 against the receipt minute and the policy version, as a defence, and open-ended reservations hold as the horizon rolls |
| Components | Apply: `Policy(version, parameters)` entries from a deployment command; rules V1 … V6; the calendar-month horizon in UTC with the month-end clamp; `UNAVAILABLE` for a policy version not yet applied; every version that a live request can carry kept |
| Contracts introduced | C02 v1.0.0: `hold` check (4) `INVALID(rule)`. The `hold` decision table is now complete except checks (7) and (8) with yields (I5) |
| Contracts consumed | C06 v1 (C06-M14, AI-55-1: no `link_rules` entity; the rules are policy parameters) |
| Scenarios delivered | P1-S18, P1-S19, P1-S20, P1-S21, P1-S22, P1-S23, P1-S74 |
| Exit criteria | (1) T-05 and T-06 pass. (2) C02 provider test 1 (V1 … V6 with the calendar cases of P1-S74). (3) A hold with an unapplied policy version gets `UNAVAILABLE` and the log has no entry for it. (4) The I1 property test runs with invalid requests mixed in; each gets `INVALID` and a tombstone |
| Dependencies | I2 |

### S-LINK-I5. Yields, claims and waiting marks

| | |
|---|---|
| Goal | A younger holder that waits yields to an older waiter. Crossings and cycles break with no detection |
| Components | Apply: `mark_waiting` by position (`IGNORED_OLDER`); `request_yields` with the sufficiency rule on a speculative generation; yield claims identified by `ClaimSeq`; re-send with the same claim; `yield_accept` (attempt + 1, same age and window), `yield_refuse` (ends only its claim; new claim when the mark is set); end of a hold attempt ends every claim on it; a holder that starts to wait later yields |
| Contracts introduced | C02 v1.0.0: `YIELD_REQUEST`, `mark_waiting`, `yield_accept`, `yield_refuse` |
| Contracts consumed | C01 v1 (PLAT-C) |
| Scenarios delivered | None of P1. Link parts of P2 scenarios (§8) |
| Exit criteria | (1) T-08 passes. (2) C02 provider tests 4 (`yield_accept` replies with attempt + 1; stale attempt or claim gets `STALE_ATTEMPT`; end of an attempt closes its claims and stops their re-sends) and 5 (both orders). (3) The C02 joint traces P2-S19 and P2-S87, in the orders "refuse, then mark" and "mark, then refuse", pass against the stub |
| Dependencies | I3 |

### S-LINK-I6. Changes to confirmed legs

| | |
|---|---|
| Goal | The link applies cancellations, shortenings, decreases, extensions and increases in one sequence per leg, with a recorded reply for each change id |
| Components | Apply: `EndLeg`, `ReduceParts` (absolute minute pieces, clipped to the part's window); recorded reply per applied change id; `STALE_CHANGE`; `INVALID(applies)`; the `convert` clip by `createdBy`; a hold of kind `change` as a new part with its own age; a late change applied as decided; the scan over the freed range |
| Contracts introduced | C02 v1.0.0: `end_leg`, `reduce_parts`, `convert` with `clippedAt`, `CONVERT_AFTER_END` |
| Contracts consumed | — |
| Scenarios delivered | None of P1. Link parts of P2 scenarios (§8) |
| Exit criteria | (1) C02 provider tests 6, 7 and 8 (the two `INVALID(applies)` cases). (2) C02 joint traces against the stub: "shorten, then extend" keeps p3 `[12:00, 20:00)`; P2-S119 with a late `convert`; a decrease and an end on one leg in both orders. (3) The I1 property test runs with leg changes; the oracle and invariant I1 still agree |
| Dependencies | I1, I3 |

### S-LINK-I7. Schedule feed, alerts and known-at history

| | |
|---|---|
| Goal | Every fact reaches consumers on `link.schedule.v1` in `feed_seq` order with a per-link closed time. Alerts go only to `link.alert.v1`. History answers "as known at" |
| Components | Ports: `emitFn` v1 for `LEG_CONFIRMED` and `LEG_CHANGED`; `feed_seq` in the head row; stream declarations with `closedPerLink`; alert stream with episodes and `cleared`; `Alert` entry; the `ALERT` feed event as a history copy with the episode id (CI-R1-2). Runtime integration: bitemporal declarations (valid time; known time `T_dec` or decision time) for `schedule_as_known_at` and `schedule_as_recorded_at` |
| Contracts introduced | C03 v2.4: schedule feed, kinds `LEG_CONFIRMED`, `LEG_CHANGED`, `ALERT` |
| Contracts consumed | C01 v1 (PLAT-D) |
| Scenarios delivered | P1-S33 |
| Exit criteria | (1) T-16 passes: `schedule_as_known_at` rebuilt from sealed segments equals the state at each position, with P1-S33's three times. (2) C03 PT-5 (`CLOSED`). (3) `feed_seq` stays contiguous with no reuse across a takeover (the move part is in I8, the reduction part in I14). (4) Each alert kind of I1 … I6 (`NO_HOLD`, `MISMATCH`, `CONVERT_AFTER_END`, `OUTCOME_MISMATCH_ON_REPLAY`, `BATCH_RETRIES`) is one episode on `link.alert.v1` with `cleared`, and never pages from the schedule feed |
| Dependencies | I6. PLAT-D |

### S-LINK-I8. Deadlines, expiry, takeover, standbys and moves

| | |
|---|---|
| Goal | No hold outlives its outcome. An owner change or a move of the link loses no fact and is fast |
| Components | Runtime integration: timers; `expire_if_undecided` every 1 s from `ts ≥ D` with the hold kept and `UNDECIDED_PAST_DEADLINE` alerted; two hot standbys fed by push, gap fill by bounded span, follower-read backstop; checkpoints every 10 min or 1 M entries (250,000 above 1,000 entries/s) and the `Checkpoint` entry; daily `Compact`; the cold path; hooks `onMovedOut`, `onAdopt`; `MOVING`, `MOVED`, `STOPPED`; `STALE_SENDER` per C01 D4; handoff, re-home, `Ambiguous` |
| Contracts introduced | C02 v1.0.0: outcome and expiry port, link side (`expire_if_undecided`) |
| Contracts consumed | C01 v1 (PLAT-E) |
| Scenarios delivered | P1-S54, P1-S62 |
| Exit criteria | (1) T-10 passes, except the reduction and notice items (I14, I12). (2) T-17 passes: the same log on two builds and on a standby gives equal outcomes and equal checkpoint digests. (3) C02 provider test 12. (4) C01 CC-2, CC-3, CC-4, CC-5 (sender side). (5) C03 PT-4, move part: `feed_seq` contiguous across a move. (6) **Measurement**: takeover with a hot standby ≤ 5 s at p99 (est.); cold rebuild of a hottest-link-sized state (10 M parts, 250,000-entry tail) ≤ 30 s, of any other link ≤ 60 s. These meet admission's 1 min recovery time for a node or zone (X2-S10) and `release_grace` (P1-S62) |
| Dependencies | I7. PLAT-E |

### S-LINK-I9. Link registry, supply-command frame, authority and retirement

| | |
|---|---|
| Goal | Commercial operators register and retire links. Only the right principals reach a link's supply commands. A link that is being retired sells nothing new |
| Components | Link registry: owner kind, `register_link`, `retire_link` (`closing`, emptiness report, `retired`), `set_probe`, `get_link`, registry feed. Apply: `Registry(version, change)` entries; `Init` from the registry; `LINK_CLOSING`, `LINK_RETIRED`, `UNKNOWN_LINK` with no tombstone; no grant after `closing`. Ports: `LinkSupply` frame (header, key, idempotency by (link, tenant, key) before the envelope checks, `UNKNOWN_LINK` with the same timing as a link that does not exist, `FORBIDDEN_ROLE`, `ENVELOPE_REFUSED(check)`, `UNAVAILABLE` above the applied registry version). Operations not built yet answer `UNAVAILABLE`. Identity duties: C08 C1 receiver checks, envelope checks in §E order, `operator_check` at apply, audit field set, target summaries with `target_version` = registry version (CI-R1-1) and audit append before the answer, read-grant reader for `read_link_schedule` (check again every 60 s), policy feed and key-certification stream |
| Contracts introduced | C02 v1.0.0: `UNKNOWN_LINK`, `LINK_CLOSING`, `LINK_RETIRED`. C03 v2.4: supply-command frame, refusals and idempotency. Registry feed and `get_link` to RFC-001 §10 (no C-id, BL-2) |
| Contracts consumed | C08 v1.2 (SEC-A); C01 v1 `subscribe` for the registry, policy and key-certification feeds |
| Scenarios delivered | None of P1. Link parts of P2-S120, X1-S13, X1-S14, X1-S22, X1-S23, X1-S31 (§8) |
| Exit criteria | (1) T-19 passes. (2) T-22 passes, except the offer-hold item (I15) and the maintenance item (I10). (3) C03 PT-1: another supplier's principal and a buyer get `UNKNOWN_LINK` with the same latency distribution as a link that does not exist (two-sample test, p > 0.05); network operations gets `FORBIDDEN_ROLE` on maintenance, reduction and increase. (4) C03 PT-3. (5) C08 C-01, C-04, C-07, C-08 pass against S-SEC's doubles, then against S-SEC. (6) C01 CC-6 for the registry, policy and key-certification feeds. (7) A hold on a `closing` link gets `LINK_CLOSING`, and `query` then answers `UNSEEN`. (8) **Blocked by BL-2**: the registry feed schema is frozen and the consumer tests of S-ACCT and S-RATE run against it |
| Dependencies | I4, I8. SEC-A. BL-2 for criterion (8) |

### S-LINK-I10. Planned maintenance

| | |
|---|---|
| Goal | A supplier books and cancels maintenance on free capacity, with the notice that POL-07 requires |
| Components | Apply: pending capacity effects in a heap by boundary; a `Tick` proposed at a boundary; `Maintenance` (notice by UTC calendar date, `NEEDS_COMMITTED`, `IN_FLIGHT` with `retry_after`, never in the committed rate); `MaintenanceCancel` from `ceil_minute(ts)`; `LINK_CLOSING` on a `closing` link. Ports: `book_maintenance`, `cancel_maintenance`; `CAPACITY_CHANGED` (maintenance, maintenance cancelled) |
| Contracts introduced | C03 v2.4: `book_maintenance`, `cancel_maintenance`; `CAPACITY_CHANGED` for maintenance |
| Contracts consumed | — |
| Scenarios delivered | P1-S28, P1-S29, P1-S30, P1-S66, P1-S67 |
| Exit criteria | (1) T-13 passes, except the outage and reduction items (I12, I14). (2) T-20, maintenance-cancellation rows: a cancellation recorded exactly on a boundary takes effect in its own entry; a booking under way frees only `[b, e)`. (3) C03 PT-3 for the two operations. (4) T-22, maintenance item |
| Dependencies | I7, I9 |

### S-LINK-I11. Capacity levels, outages, increases and displacement

| | |
|---|---|
| Goal | Outages, restorations and increases change what the link sells, as levels, in any order. A hold that no longer fits is displaced, never released by the link |
| Components | Trees: `occ_commit`. Apply: capacity profile (`A_s`, `A_p`, `A_now`, `K_s`, `K_p`), profile differencing, deficit impulses against `C_ref`; `Outage` (a level, `attribution`), `Restoration` (whole or to a level; by the supplier or network operations), `Increase`; rises as pending effects; capacity-lowering entries alone in their transaction, placeholder markers as the first statement, abandoned before `COMMIT` after 250 ms; `displace`; `DISPLACED`; `displacement_accept`; a converted displaced hold alerted `CONFIRMED_AFTER_REDUCTION`; markers deleted with their attempt. Projections: `link_displacement` (deletable; select grant for the account role). Identity duties: envelopes for `record_outage` and `record_restoration` |
| Contracts introduced | C03 v2.4: `record_outage`, `record_restoration`, `record_increase`; `CAPACITY_CHANGED` for these. C02 v1.0.0: `DISPLACED`, `displacement_accept`, link displacement read (provider side) |
| Contracts consumed | C01 v1 (PLAT-F); C08 v1.2 (SEC-A) |
| Scenarios delivered | P1-S24, P1-S27, P1-S41, P1-S42, P1-S49, P1-S51, P1-S69, P1-S76, P1-S80 |
| Exit criteria | (1) T-21 passes for outages, restorations and increases (reductions in I13), against the level oracle, review 17's cases (a), (b) through an outage, (d). (2) T-20 restoration and increase rows. (3) T-12 passes on a real 2 + 2 + 1 cluster: both race orders; a second capacity decrease leaves an earlier marker and its hold out of its test; the owner stopped inside a capacity-lowering transaction after its first statement. (4) C02 provider tests 4 (`displacement_accept` replies attempt + 1), 10 and 13 (`DISPLACED` never for a waiter). (5) C03 PT-2 for the P1-S76 and P1-S80 tables. (6) **Measurement**: at the hottest link's design load and in a flash crowd, each capacity-decrease transaction has at most one retry, and its restart keeps its intents (SP3 target, R1-1) |
| Dependencies | SP3, I8, I10. PLAT-F, SEC-A |

### S-LINK-I12. Affected flags and notices

| | |
|---|---|
| Goal | Every reservation is flagged at exactly the minutes where the committed rate exceeds the capacity in force. Holders and network operations get a notice in time, also across a failover |
| Components | Projections: the flag projection on a pinned generation, slices ≤ 2 ms, coalesced runs, `link_projection` checkpoint rows, standby offload above 100,000 parts, 512 MB pin cap; conflicts of the committed rate against each `K_p` piece; due times; due-now notices first. Ports: `AFFECTED_CHANGED`, `AFFECTED_NOTICE`, restoration notices; flag of a converted displaced hold with its notice written at once; late changes re-notified; the failover allowance read from `Takeover` and `adopt` entries |
| Contracts introduced | C03 v2.4: `AFFECTED_CHANGED`, `AFFECTED_NOTICE` |
| Contracts consumed | C01 v1 (PLAT-D; PLAT-G notifier for end-to-end checks only) |
| Scenarios delivered | P1-S25, P1-S26, P1-S40, P1-S48, P1-S50, P1-S63, P1-S72, P1-S75, P1-S78, P1-S83, P1-S85 |
| Exit criteria | (1) T-11 passes, except P1-S82 (I14). (2) T-10, failover item: a failover between an outage's record and its notices, warm and cold; the successor writes the due-now notices first. (3) T-12, converted-hold item. (4) C03 PT-9: outage to 0 with 100,000 active reservations; every due-now `AFFECTED_NOTICE` is on Kafka within 15 s at p99 (10 s at 50,000), before any future-due notice or `AFFECTED_CHANGED` of the run; mean value ≤ 200 B, or the SP5 fallback (300 B, 20 s). (5) With PLAT-G: the notifier tells holders within `affected_notice_time` (60 s), or 120 s across a failover (C03 CT-6.1 runs on S-PLAT's side) |
| Dependencies | SP5, I8, I11. PLAT-D |

### S-LINK-I13. Permanent reduction: the notice period

| | |
|---|---|
| Goal | A supplier announces a permanent reduction. Sales stop at once at the reduced capacity. RFC-002 learns which reservations the reduction cuts, and the set follows the schedule during the notice |
| Components | Apply: `ReductionAnnounce` (alone in its transaction; `A_s` from `floor_minute(ts)`; `A_p` from `T_eff`; displacement); an increase during the notice raises `L_R`. Projections: reduction projection (greedy, newest first, on a speculative generation; runs in `T_eff` order; coalesced; bounded by the previous cut set; standby offload); `link_reduction_cut` rows written as diffs. Ports: `announce_reduction`; `CAPACITY_CHANGED(reduction announced)`; `REDUCTION_AFFECTED` |
| Contracts introduced | C03 v2.4: `announce_reduction`, `CAPACITY_CHANGED(reduction announced)`, `REDUCTION_AFFECTED` |
| Contracts consumed | C08 v1.2 (supplier principal checks) |
| Scenarios delivered | P1-S31, P1-S43, P1-S44, P1-S58 |
| Exit criteria | (1) T-14, notice-period items: the projection equals the full greedy oracle; it runs again when the schedule changes during the notice; later runs over the previous cut set equal a full run. (2) T-21 complete: reductions valid against `A_now` whatever the outages; an increase pending and a reduction recorded after it in the same minute raise no minute. (3) `REDUCTION_AFFECTED` diffs: a cut of 0 removes a row (input of C03 CT-2.1) |
| Dependencies | I11, I12 |

### S-LINK-I14. Permanent reduction: effect, cuts and cut targets

| | |
|---|---|
| Goal | At `T_eff` the affected set is fixed and durable. Cuts are decided in bounded steps, as caps, newest part first, never more than POL-07 needs. Each reservation gets one exact cut target. Maintenance is cut to fit after the reservations |
| Components | Apply: `Tick` at `T_eff`; `ReductionEffective` (freeze `C_q`, digest, deferral); `ReductionStep` (500 parts); caps with their covered parts; capped contributions in `occ_commit`; projected cuts in the flag projection; the final excess check and extensions; revisions; `CutAnswer` and cap withdrawal; maintenance cut to fit, newest booking first, freed from `max(T_eff, ceil_minute(ts))`; the reduction final; `CUT_TARGET_UNMET`, `UNKNOWN_REDUCTION`. Ports: `cut_target` sender (synchronous gRPC, batches ≤ 500, ≤ 64 calls in flight per destination slot, sent again from state until the reply is recorded, also after `onAdopt`); `REDUCTION_EFFECTIVE` chunks, `REDUCTION_SET_EXTENDED`, `CUT_DECIDED`, `REDUCTION_FINAL`, `CAPACITY_CHANGED(maintenance cut)` |
| Contracts introduced | C02 v1.0.0: `cut_target` (sender) and its replies. C03 v2.4: `REDUCTION_EFFECTIVE`, `REDUCTION_SET_EXTENDED`, `CUT_DECIDED`, `REDUCTION_FINAL`, maintenance cut |
| Contracts consumed | C02 v1.0.0 reservation command port (`cut_target` reply from RFC-002, by the stub) |
| Scenarios delivered | P1-S32, P1-S36, P1-S45, P1-S46, P1-S47, P1-S64, P1-S65, P1-S79, P1-S81, P1-S82 |
| Exit criteria | (1) T-14 passes, except the offer-part items (I15): steps over `C_q` equal the full greedy at `T_eff`; minute-piece targets equal a per-minute oracle; the cap cases of R26-01; V-1; a projection made short on purpose gives `REDUCTION_SET_EXTENDED` and a second, lower target. (2) T-13: P1-S81's two rows; a reduction to 0 with maintenance finishes. (3) T-11, P1-S82 item. (4) T-10, reduction item: the owner stopped between `ReductionEffective` and the final step; the successor gives the same `A_R` chunks and targets. (5) T-20: a maintenance trim decided after `T_eff` frees sales from `max(T_eff, ceil_minute(ts))`. (6) C02 provider tests 8 (all) and 9. (7) C03 PT-2 complete, PT-4 complete, PT-6 (offer items in I15), PT-7, PT-8. (8) **Measurement**: a 100,000-part cut set is decided in about 200 steps, and maintenance-cut notices are due at the deciding step (R1-8, R1-14 measured, not changed) |
| Dependencies | I13, I8 |

### S-LINK-I15. Equivalent-path offer holds and moves

| | |
|---|---|
| Goal | An offer is firm on its Share legs. Acceptance moves the reservation with its original ages. A move that becomes final after the cut keeps the cut rate |
| Components | Apply: `OfferHold` (the combined step function by segment; `TOMBSTONED` at `lapse_at` and after a recorded `offer_release`; `LINK_CLOSING`), offer parts in all three occupancies with original ages; `OfferAccept` (`move_at ≥ nb(decision time)`; late ones applied as decided); `OfferMoveAt` (in the leg's change-id sequence); `OfferRelease` (tombstone until `lapse_at + release_grace`, also for an offer not seen); offer-scoped caps that move with acceptance or go with release; P1-S84's `reduce_parts` cause `POL07` naming another link's pairs. Ports: `offer_outcome_if_lapsed` every 1 s; `OFFER_AFFECTED` |
| Contracts introduced | C02 v1.0.0: `offer_hold`, `offer_accept`, `offer_move_at`, `offer_release`, `offer_outcome_if_lapsed`. C03 v2.4: `OFFER_AFFECTED` |
| Contracts consumed | — |
| Scenarios delivered | P1-S35, P1-S52, P1-S53, P1-S55, P1-S56, P1-S57, P1-S59, P1-S60, P1-S61, P1-S68, P1-S71, P1-S84 |
| Exit criteria | (1) T-15 passes. (2) T-14, offer-part items: a reservation cut only in offer parts is outside `A_R` and gets an offer-scoped target (V-3). (3) T-22, offer-hold item. (4) C02 provider test 11. (5) C03 PT-6, offer items. (6) C02 joint traces against the stub: P1-S52 with accept, decline and a failed partner leg; P1-S84 row 2 with `reduce_parts` before `offer_accept`; both "offer Final" rows |
| Dependencies | I14, I12 |

### S-LINK-I16. Design load, the hottest link and region loss

| | |
|---|---|
| Goal | The link owner meets its part of the latency budget at ×50 load on the hottest link, and loses no acknowledged fact when a region goes |
| Components | Runtime integration: the hottest link on its own slot; the SP2 and SP4 decisions applied (worker threads; log row layout); disaster mode. Test harness: load rig with the POL-06 mix |
| Contracts introduced | — |
| Contracts consumed | C01 v1 (PLAT-G) |
| Scenarios delivered | None of P1. Link parts of X2-S03, X2-S05, X2-S06, X2-S15, X2-S23 (§8) |
| Exit criteria | (1) **T-18**: 2,500 requests/s on one link for 1 h, POL-06 mix, on the 2 + 2 + 1 cluster with one owner and two standbys fed by push. **Link step** (`W_l` + commit + apply) p99 ≤ 65 ms on the hottest link's own slot and ≤ 50 ms on a shared slot (RFC-001 §9: the link part of X2-S05 and X2-S15's 200 ms). (2) Apply ceiling ≥ 20,000 entries/s on one event loop, ≥ 4 × the 4,500 entries/s design point (X2-S03). (3) Batch retries counted by cause: none from standbys, history or audit. (4) Event-loop use, GC pauses, projection lag, batch size and the share answered `WAITING` are recorded, and their alert thresholds are set from the figures. (5) A reduction to half announced at design load: its projection runs on the standby, the owner's link-step p99 changes by ≤ 5 ms, and pinned memory stays ≤ 512 MB. (6) Region R1 lost: leases move to R2; commits through R3 are about 75 ms at p99 (est.); no acknowledged fact is lost (X2-S23, X2-S12, X2-S14). (7) The end-to-end X2-S05, X2-S06 and X2-S15 percentiles are measured jointly with S-ACCT and S-PLAT's probes. This increment gives the link part |
| Dependencies | SP2, SP4, I15. PLAT-G |

## 7. Scenario map: every P1 scenario in exactly one increment

| Scenario | Increment |
|---|---|
| P1-S01 | I1 |
| P1-S02 | I1 |
| P1-S03 | I1 |
| P1-S04 | I1 |
| P1-S05 | I1 |
| P1-S06 | I1 |
| P1-S07 | I3 |
| P1-S08 | I1 |
| P1-S09 | I1 |
| P1-S10 | I1 |
| P1-S11 | I3 |
| P1-S12 | I2 |
| P1-S13 | I1 |
| P1-S14 | I1 |
| P1-S15 | I2 |
| P1-S16 | I2 |
| P1-S17 | I2 |
| P1-S18 | I4 |
| P1-S19 | I4 |
| P1-S20 | I4 |
| P1-S21 | I4 |
| P1-S22 | I4 |
| P1-S23 | I4 |
| P1-S24 | I11 |
| P1-S25 | I12 |
| P1-S26 | I12 |
| P1-S27 | I11 |
| P1-S28 | I10 |
| P1-S29 | I10 |
| P1-S30 | I10 |
| P1-S31 | I13 |
| P1-S32 | I14 |
| P1-S33 | I7 |
| P1-S34 | I3 |
| P1-S35 | I15 |
| P1-S36 | I14 |
| P1-S37 | I1 |
| P1-S38 | I2 |
| P1-S39 | I2 |
| P1-S40 | I12 |
| P1-S41 | I11 |
| P1-S42 | I11 |
| P1-S43 | I13 |
| P1-S44 | I13 |
| P1-S45 | I14 |
| P1-S46 | I14 |
| P1-S47 | I14 |
| P1-S48 | I12 |
| P1-S49 | I11 |
| P1-S50 | I12 |
| P1-S51 | I11 |
| P1-S52 | I15 |
| P1-S53 | I15 |
| P1-S54 | I8 |
| P1-S55 | I15 |
| P1-S56 | I15 |
| P1-S57 | I15 |
| P1-S58 | I13 |
| P1-S59 | I15 |
| P1-S60 | I15 |
| P1-S61 | I15 |
| P1-S62 | I8 |
| P1-S63 | I12 |
| P1-S64 | I14 |
| P1-S65 | I14 |
| P1-S66 | I10 |
| P1-S67 | I10 |
| P1-S68 | I15 |
| P1-S69 | I11 |
| P1-S70 | I2 |
| P1-S71 | I15 |
| P1-S72 | I12 |
| P1-S73 | I2 |
| P1-S74 | I4 |
| P1-S75 | I12 |
| P1-S76 | I11 |
| P1-S77 | I1 |
| P1-S78 | I12 |
| P1-S79 | I14 |
| P1-S80 | I11 |
| P1-S81 | I14 |
| P1-S82 | I14 |
| P1-S83 | I12 |
| P1-S84 | I15 |
| P1-S85 | I12 |

Count per increment: I1 13, I2 8, I3 3, I4 7, I5 0, I6 0, I7 1, I8 2, I9 0, I10 5, I11 9,
I12 11, I13 4, I14 10, I15 12, I16 0. Total 85.

## 8. Link parts of other slices' scenarios

RFC-001 §13 gives the link part of these scenarios. Their primary slice proves each
scenario. Each link part is in exactly one increment.

| Scenario (primary slice) | Link part | Increment |
|---|---|---|
| P2-S14 (S-ACCT) | Request-scoped release and tombstone | I1 |
| P2-S55 (S-ACCT) | `D_c` taken as given; refusal at `ts ≥ D_c` | I1 |
| P2-S56 (S-ACCT) | Release of a withdrawn request | I1 |
| P2-S92 (S-ACCT) | A hold counts only from its own entry | I1 |
| P2-S110 (S-ACCT) | Refusal at `ts ≥ D_c` | I1 |
| P2-S112 (S-ACCT, S-MONEY) | `IN_FLIGHT` decided at the link | I1 |
| P2-S02 (S-ACCT) | The refusal names this link by being its answer | I2 |
| P2-S18 (S-ACCT) | `IN_FLIGHT` with `retry_after` and counter-offer | I2 |
| P2-S73 (S-ACCT) | `availability`, `fit_ranges` | I2 |
| P2-S16 (S-ACCT) | Released capacity to the oldest waiter, in the freeing entry | I3 |
| P2-S17 (S-ACCT) | No-fit refusal only on `occ_firm` | I3 |
| P2-S20 (S-ACCT) | Waiter granted on release | I3 |
| P2-S21 (S-ACCT) | Priority comparator used only between conflicting requests | I3 |
| P2-S52 (S-ACCT) | `WAITER_REFUSED` with counter-offer | I3 |
| P2-S61 (S-ACCT) | Latest blocker deadline in `WAITING_NOTICE` | I3 |
| P2-S62 (S-ACCT) | Release ends everything; refusal reasons recorded | I3 |
| P2-S95 (S-ACCT) | Waiter past `D_c` skipped | I3 |
| P2-S116 (S-ACCT) | `WAITING_NOTICE` re-sent when the latest blocker changes | I3 |
| P2-S15 (S-ACCT) | Yields break contention | I5 |
| P2-S19 (S-ACCT) | Crossing: the younger waiting holder yields | I5 |
| P2-S58 (S-ACCT) | A holder without the mark is never asked | I5 |
| P2-S59 (S-ACCT) | `wait = false`: no waiter, no yields | I5 |
| P2-S60 (S-ACCT) | Younger re-granted after the older ends | I5 |
| P2-S87 (S-ACCT) | Three-cycle broken by yields | I5 |
| P2-S88 (S-ACCT) | Next oldest granted after the oldest ends | I5 |
| P2-S97 (S-ACCT) | A yielder keeps its place (same age, attempt + 1) | I5 |
| P2-S118 (S-ACCT) | A holder that starts to wait later yields | I5 |
| P2-S43 (S-ACCT) | `end_leg` cause `CANCEL` from the next boundary | I6 |
| P2-S44 (S-ACCT) | `end_leg` cause `SHORTEN` | I6 |
| P2-S45 (S-ACCT) | Extension as a new admission of the difference | I6 |
| P2-S46 (S-ACCT) | A rejected extension leaves the parts as they were | I6 |
| P2-S47 (S-ACCT) | Increase as a new admission of the difference | I6 |
| P2-S48 (S-ACCT) | `reduce_parts` cause `DECREASE`, named parts | I6 |
| P2-S74 (S-ACCT) | A rejected increase leaves the parts as they were | I6 |
| P2-S79 (S-ACCT) | One sequence per leg, by change id | I6 |
| P2-S80 (S-ACCT) | A pending change released when its reservation ends | I6 |
| P2-S81 (S-ACCT) | A cancellation applied before a later change | I6 |
| P2-S84 (S-ACCT) | Changes past the horizon follow the change rules | I6 |
| P2-S85 (S-ACCT) | An open-ended leg given an end | I6 |
| P2-S94 (S-ACCT) | A shortening to the next boundary as an end | I6 |
| P2-S119 (S-ACCT) | `convert` clip by `createdBy` | I6 |
| P2-S13 (S-ACCT) | Hold kept until the outcome arrives | I8 |
| P2-S93 (S-ACCT) | Every hold released by the outcome at `D` | I8 |
| P2-S101 (S-ACCT) | Expiry requests while Share is unavailable | I8 |
| P2-S104 (S-ACCT) | Hold kept; expiry requests; release within `release_grace` | I8 |
| P2-S106 (S-ACCT) | A late-known confirmation converts the kept hold | I8 |
| P2-S107 (S-ACCT) | Releases durable across the link's failover | I8 |
| P2-S114 (S-ACCT) | Hold kept when the record was unavailable within `ack_budget` | I8 |
| P2-S120 (S-ACCT) | `LINK_CLOSING`, no tombstone, no counter-offer | I9 |
| X1-S13 (S-SEC) | Registry role check: network operations refused | I9 |
| X1-S14 (S-SEC) | Supply facts record principal, role and reason (C03 PT-1 relies on it; RFC-001 §13 does not list it) | I9 |
| X1-S22 (S-SEC) | `UNKNOWN_LINK` for other principals | I9 |
| X1-S23 (S-SEC) | `FORBIDDEN_ROLE` for network operations on commercial changes | I9 |
| X1-S31 (S-SEC) | Commercial registers and retires links | I9 |
| P4-S117 (S-MONEY) | Revisions, `CUT_DECIDED`, `REDUCTION_FINAL` for late cuts | I14 |
| X2-S03 (S-PLAT) | Hottest link at 2,500 requests/s | I16 |
| X2-S05 (S-PLAT) | Link step p99 whatever the length | I16 |
| X2-S06 (S-PLAT) | Link step of route legs | I16 |
| X2-S15 (S-PLAT) | Link step on links with no capacity in flight | I16 |
| X2-S23 (S-PLAT) | No acknowledged link fact lost in a region disaster | I16 |

## 9. Contract tests by increment

| Contract | Tests | Increment where the test is complete |
|---|---|---|
| C01 v1 consumer | CC-1, CC-7, CC-8 | I1 |
| | CC-5 receiver side | I1 |
| | CC-2, CC-3, CC-4, CC-5 sender side | I8 |
| | CC-6 | I9 |
| C02 v1.0.0 provider | 1 | I4 (yield parts of checks (7), (8) in I5) |
| | 2 | I1 |
| | 3 | I2 |
| | 4 | I11 (grant in I3, yield in I5) |
| | 5 | I5 |
| | 6, 7 | I6 |
| | 8 | I14 (first two items in I6) |
| | 9 | I14 |
| | 10 | I11 |
| | 11 | I15 |
| | 12 | I8 |
| | 13 | I11 (first two items in I3) |
| C03 v2.4 provider | PT-1, PT-3 | I9 (PT-3 for each operation in its increment) |
| | PT-2 | I14 (P1-S76, P1-S80 in I11) |
| | PT-4 | I14 (takeover in I7, move in I8) |
| | PT-5 | I7 |
| | PT-6 | I15 (all but offer items in I14) |
| | PT-7, PT-8 | I14 |
| | PT-9 | I12 |
| C06 v1 | No provider or consumer test. C06-M14 constrains I4 and I9 (no link rows on `catalogue.v1`, no `link_rules`) | I4, I9 |
| C08 v1.2 consumer | C-01, C-04, C-07, C-08 | I9 |

## 10. Risks

| # | Risk (source) | Treatment |
|---|---|---|
| R1-1 | Confirms across a reduction; a capacity-decrease transaction pushed and retried (RFC-001) | **Work item**: SP3 decides the design; I11 exit (3) and (6) measure retries. Fallback named in SP3 |
| R1-2 | Waiter scans under heavy contention (RFC-001) | **Work item**: scan budget and `Tick` continuations in I3; SP2 measures the worst flash crowd |
| R1-3 | Share answered `pending` on the hottest link is an estimate (RFC-001) | **Accepted**: the figure changes no design. SP2 and I16 record it |
| R1-4 | B+tree constants in V8 (RFC-001) | **Work item**: SP1. Fallback `src/tree.ts` (dense ring tree) or a native module behind one interface |
| R1-5 | Projection lag against the notice budget (RFC-001, C03) | **Work item**: SP5; I12 exit (4); forced slices after 1 s of lag; standby offload |
| R1-6 | Determinism across code releases (RFC-001) | **Work item**: replay outcome check from I1; algorithm versions in `Policy` entries from I4; T-17 in I8 |
| R1-7 | One link is a serial point; about 4× margin (RFC-001, RFC-000 R5, R19) | **Work item**: SP2 and I16 exit (2). Levers: worker threads; a second in-flight batch needs a new C01 version |
| R1-8 | Large reductions take steps after `T_eff`; rating waits for `A_R` (RFC-001) | **Accepted**: the delay is minutes at worst and only for `A_R` (review 17 D5). I14 measures it |
| R1-9 | Generation copies cost memory while pinned (RFC-001) | **Work item**: SP1 measures; the 512 MB pin cap in I12 and I14 |
| R1-10 | Event-loop stalls from GC or a long entry (RFC-001) | **Work item**: typed-array arenas (SP1); bounded entries; I16 records GC pauses and sets alerts |
| R1-11 | The hottest link's tail range takes every log insert (RFC-001) | **Work item**: SP4. A change to one row per batch needs a C01 change: issue to the orchestrator |
| R1-12 | Hottest-link single-link p99 about 191 ms from R1, 201 ms from R2 (RFC-001) | **Accepted**: the hottest link is not X2-S15's population; a late answer is `pending` (POL-04). I16 records it |
| R1-13 | `link_request` volume, about 216 M rows a day (RFC-001) | **Work item**: SP4; fallback answers post-expiry repeats from history |
| R1-14 | Maintenance-cut notices up to about 1 min after `T_eff` on the hottest link (RFC-001) | **Accepted** (RFC-001 Requirements issues, revision 5 reading). I14 exit (8) measures it |
| R1-15 | Cold rebuild of the hottest link, 15 to 30 s (RFC-001) | **Work item**: two standbys per slot and the checkpoint rule in I8; I8 exit (6) measures it |
| R1-16 | Kafka or outbox lag delays notices (RFC-001) | **Accepted**: the outbox keeps the rows and the changefeed relays them. I7 alerts lag against the 15 s budget |
| R1-17 | Standby projection depends on a current standby (RFC-001) | **Work item**: in I13 and I14, the owner writes standby output only if its state has passed the output's position, and computes the run itself if no standby is current |
| R1-18 | Notices across a cold failover, about 115 s of 120 s (RFC-001) | **Work item**: I12 exit (2) runs the cold path; due-now notices first |
| R1-19 | Waiters on a link that becomes `closing` (RFC-001, CI-R1-3) | **Accepted**: see CI-R1-3 |
| CI-R1-1 | C08 says `target_version` of a `link` target is the log's last sequence; C03 M1 and RFC-000 4.5 say the registry version (contract defect) | **Plan around it**: I9 uses the registry version in summaries and in check 6. I9 also runs C08 C-07 with S-SEC's double to show which form the console sends. The team asks the orchestrator for the C08 erratum. If the console sends the log sequence, most operator actions on a busy link fail check 6 with `ENVELOPE_REFUSED(6)` |
| CI-R1-2 | C01 puts alerts on `link.alert.v1`; C03 keeps an `ALERT` event on the schedule feed; one alert can page twice (contract defect) | **Plan around it**: I7 raises alerts only on `link.alert.v1`, and the `ALERT` feed event is a history copy with the episode id. The team asks the orchestrator for the C03 erratum and tells S-PLAT to alert only from `link.alert.v1` |
| CI-R1-3 | C02 gives the link no way to end a waiter registered before `closing` (contract defect) | **Plan around it**: I9 grants no waiter after `Registry(closing)`. The waiter holds nothing and stays until its account owner releases it or its deadline passes (at most 60 s). The team proposes the additive C02 minor version (`WAITER_REFUSED` with reason `LINK_CLOSING`) to the orchestrator |
| P-1 | S-PLAT's runtime is late (BL-1) | **Work item**: the C01 runtime double from I1; each exit criterion runs again on the real runtime |
| P-2 | Removal of `links.ts` and `tree.ts` breaks `routes.ts` (§3) | **Work item**: new code in its own path; old files stay until S-ACCT retires `routes.ts` |
| P-3 | The registry feed has no frozen contract (BL-2) | **Work item**: the team proposes a contract; I9 exit (8) waits for it |
| P-4 | The link owner and the account owner must apply one policy bundle under one `policyVersion` (RFC-001 §2, AI-55-1) | **Work item**: I4 takes `Policy` from one deployment command that S-ACCT also takes. A hold with an unknown version gets `UNAVAILABLE`, so a lag gives a retry, not a wrong verdict |
| P-5 | Scenario proofs at the C02 boundary depend on a correct account-owner stub | **Work item**: the stub replays traces recorded from C02's consumer tests. The C02 joint traces run again with the real account owner at C6 |
| P-6 | RFC-001's Status line still says "Draft, revision 6" | **Accepted** per the brief. If its fix verification changes the RFC, `tools/impact.py` lists the IDs to re-plan |

## 11. Mechanical checks

```sh
# 85 rows, 85 distinct IDs, each in one increment (§7):
rg -o '^\| (P1-S[0-9]{2}) \| I[0-9]+ \|$' -r '$1' docs/04-delivery/plan/S-LINK.md | sort | uniq -d   # expect nothing
rg -c '^\| P1-S[0-9]{2} \| I[0-9]+ \|$' docs/04-delivery/plan/S-LINK.md                            # expect 85
# every P1 scenario of the feature file is in §7:
diff <(rg -o '@(P1-S[0-9]{2})' -r '$1' docs/02-specs/P1-link-admission.feature | sort -u) \
     <(rg -o '^\| (P1-S[0-9]{2}) \| I' -r '$1' docs/04-delivery/plan/S-LINK.md | sort -u)        # expect no output
```
