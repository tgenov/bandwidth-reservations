# S-SEC delivery plan: security and tenancy

| | |
|---|---|
| Slice | S-SEC (primary spec X1, 49 scenarios) |
| Status | Draft for C5 plan review |
| Authority | [RFC-005](../../03-rfcs/RFC-005-security-and-tenancy.md) revision 6 (taken as accepted). Frozen contracts: [C01](../contracts/C01-platform.md) v1, [C08](../contracts/C08-identity-and-access.md) v1.2, [C09](../contracts/C09-personal-data-store.md) v1.1, [C07](../contracts/C07-receivables-and-payouts.md) v1.2, [C10](../contracts/C10-booking-api.md) v1.0.0, [C05](../contracts/C05-funds-and-standing.md) v1, [C03](../contracts/C03-link-schedule.md) v2.4, [C04](../contracts/C04-reservation-feeds.md) v2.3.1, [C06](../contracts/C06-usage-and-charges.md) v1, [C11](../contracts/C11-metering-ingress.md) v1.0.0. Requirements at tag `requirements-v1.11`. [RFC-000](../../03-rfcs/RFC-000-architecture.md) revision 4.5 |
| Prior code | None |
| Language | ASD-STE100 Simplified Technical English |

## 1. Rules for this plan

1. Each increment is small and can ship alone.
2. An increment depends only on frozen contracts or on earlier increments of this slice.
3. The first increments give the parts that other slices need first. The order is:
   principal context, key records and the push, the operator envelope and
   `operator_check`, then the personal-data store `put` and `get`.
4. Many X1 scenarios need an owner of another slice (the account owner, the link owner,
   the ledger). For these, this slice proves its part with a **contract double** of that
   owner. The double replays the frozen contract. The other slice proves its part with its
   consumer test of the same contract (named in the exit criteria). The scenario is placed
   in the increment where the S-SEC part is complete.
5. "Fixture command" means a test-only internal command, accepted only from the test
   workload identity. It is not in production images. A build lint makes sure of this.
   I1 and I2 use it to create and revoke keys before the administrator commands exist (I7).

## 2. Components and owners

| Component | Responsibilities (RFC-005) | Owner (role) |
|---|---|---|
| **Edge gateway** | TLS 1.3 and mTLS; pre-authentication shedding; credential parse; authentication from the in-memory edge replica; principal context (C1); coarse authorisation (C2); advisory rate counters; the exact poll limiter; forward once by C01 `route`/`slotOf`; uniform "unauthenticated" and "not found" answers; edge payment ingress; logs without idempotency keys (§2.2, §2.3, §5.3, §8.1) | Edge team |
| **Identity and access** | Single writer of principals, users, sessions, keys, rights, consent, endpoints, KYB status, erasure requests, recoveries, operator identities, policy and payout destinations (§3.1). Serves the edge stream (C14), the identity status push and catch-up (C3), `visibility` (C6), the endpoint feed and query (C8), `operator_check` and `cancel` (C15), the erasure intake and `open_requests` (C12), the policy feed (C17), the payout destination query (C16) | Identity team |
| **Personal-data store** | The only place for personal data. `put`, `get`, `lookup_login`, `tag_note`, `put_payload`, `withdraw_payload`, `erase`, expiry, store events feed, restore by `reapply` (§3.7, C12, C09) | Identity team |
| **Operator console and approvals**, with the **signing client** | Operator sessions; the action catalogue by role; the request and approval state machine; four eyes; `not_after`; cancellation; documented requests; read grants; target summaries shown to the signer (§7) | Console team |
| **Audit** | Audit append log (`audit_append`); chain and continuity verification; checkpoints in two trust domains; second verifier; integrity stop and resume; audit query; truncation watermark (§9) | Audit team |
| **Key service and secrets service** | HSM front end; key release by policy; key-certification stream (C17); digest keys; EKM endpoint for backups; secrets store (§10) | Key management team |
| **Shared security libraries** | C1/C2 library (context and `decide`); C13 column encryption (`seal`, `open`); webhook signing library (C8); authenticity verifier library (C7) | Identity team (C1, C2, C8), Key management team (C13), Edge team (C7) |

Components of other slices that this slice consumes: the C01 owner runtime, placement,
relay and closure emitter, history and the notifier (S-PLAT); the account owner (S-ACCT,
S-MONEY); the link owner (S-LINK); metering ingestion and the catalogue (S-RATE); payouts
(S-MONEY).

## 3. Dependency on S-PLAT: minimum C01 subset

S-SEC builds every owner (identity, console, audit, key service, secrets service) on the
C01 v1 runtime. The S-PLAT plan must deliver these C01 parts, by name, before the
increment shown. Until S-PLAT delivers a part, the team uses a C01 runtime double that
passes C01 §10.2 CC-1 … CC-8. Each exit criterion is then run again on the real runtime.

| C01 part (by name) | Needed by |
|---|---|
| Owner declaration (§2.2) and the migration tool | I1 |
| Log table, head row, projection and outbox schema with the `chain` column (§2.3) | I1 |
| Per-owner SQL roles from workload certificates; platform read roles (§2.3) | I1 |
| `OwnerRuntime.append` (static form) with `AppendResult` `Committed`, `ConditionFailed`, `Retry`, `StaleEpoch`, `Overloaded` (§2.4, §3.2) | I1 |
| `OwnerHooks.onAcquire`, `onRelease`; `leaseValid`, `epoch`, `now`, `timing` (§2.4, §3.1) | I1 |
| `consistentRead(…, 'present')` (§2.4) | I1 |
| Outbox, relay to Kafka, wire format and per-topic producer ACL (§2.5, §3.5) | I1 |
| Closure emitter and closure topic `iam.status.v1.closure`; `onResolved`; `subscribe` (§3.6) | I1 |
| `route`, `slotOf` with `headDecides`; account slot map (§2.7, §3.8) | I1 |
| `CommandEnvelope`, `RoutingRefusal`, `admitCommand` (§2.4) | I1 |
| Column encryption binding to C13 (§3.12) | I1 |
| `decide` form of `append` with declared `reads` and conditions (§2.4) | I2 |
| `AppendResult` `Moved`, `Moving`, `Stopped`, `Ambiguous`; hooks `onMovedOut`, `onAdopt` (§3.3) | I2 |
| Probe designation from the slot map, `probeAccountSet`, `probeSetSummary` (§2.7, §2.9, §3.10) | I2 (probe flag), I4 (set-scoped action) |
| `timer`, `cancelTimer` (§3.7) | I4 |
| Operational alert stream `<kind>.alert.v1` (§2.10, §3.11) | I4 |
| History query as a read-grant reader (§2.8, §3.9) | I12 |
| Integrity stop service `Stop`/`Resume` with `StopAck` at the slot fence; `placement_integrity_stops`; restore role (§2.6, §2.3) | I11 |

## 4. Spikes

The RFC marks these estimates as ones the design depends on. Each spike starts at once,
in parallel with I1. Each spike gives one measurement and one decision.

| Spike | Measurement | Decision it unlocks | Gates |
|---|---|---|---|
| **S-SEC-SP1** Edge cost and timing floor (§2.2, §2.3, §3.1 sizing) | CPU per authenticated request (est. 20 µs); p99.9 of the work of each unauthenticated cause (malformed, unknown key, wrong secret, revoked); edge replica memory at 10⁷ keys (est. 2 GB); edge stream load at 256 slots × 50 edges (est. 13,000 messages/s) | Value of ‹unauth_floor› (5 ms est.); edge node size and count for 25,000 bookings/s and 100,000 polls/s (X2-S03); whether 10⁷ keys fit in one replica or need a key-count cap | I2 |
| **S-SEC-SP2** Identity slot takeover and key unwrap load (RK-9, RK-16) | Takeover time of one identity slot with a hot standby; time to unwrap every slot's keys at a region-wide failover, paced by slot priority | ‹iam_slots› (256 est.); ‹unwrap_rate_limit›; pacing order. Must meet admission's RTO 1 min (X2-S10) | I2 |
| **S-SEC-SP3** Row-level security and CDC queries on CockroachDB (RK-18, RK-24) | RLS policy that limits the truncation role to rows at or below the watermark and the restore role to stopped partitions; a CDC query changefeed with delete events per log table, its lag and cost | RLS or the fallback stored procedure owned by audit's role; projection changefeed or the full-row fallback (cost to RFC-006, R27-13) | I11 |
| **S-SEC-SP4** HSM and EKM operations (RK-9, RK-13, RK-22) | Cloud EKM latency and availability in `africa-south1`; weekly rewrap time for about 3×10⁵ bucket keys; generation destruction with attestation on four HSM clusters | Backup key path for the store; ‹kek_generation_period› 7 days holds; erasure bound min(`r` + 23, `e` + 14) days holds | I14, I15 |

## 5. Increments

Each increment lists the contracts it introduces (provider) and consumes, with versions.
Contract test IDs are those of the frozen contracts: C08 "P-n" (provider) and "C-n"
(consumer), C09 tests by number, C01 "CP-n"/"CC-n". Design tests are RFC-005 §15 "DT-n".

### S-SEC-I1. Walking skeleton: an agent key from the edge to an owner, with a push and an audit append

| | |
|---|---|
| Goal | Prove the main path end to end. An agent key authenticates at the edge from the replica. The edge builds the principal context and forwards it on the C01 runtime to a test owner. Identity publishes the key on the identity status push. One owner consumes the push. Audit records one append |
| Components | Edge gateway (pipeline steps 1, 3, 4, 5, 8, 9; uniform unauthenticated answer with the floor); identity and access (one owner kind, key records by fixture command, edge stream with heartbeat, push outbox); key service (minimal: `identity_record` certificates and the key-certification stream); C1/C2 library (context; `decide` with a fixed version-1 bundle for book and status); C13 library (log, feed and edge-stream keys); audit (append log only) |
| Test owner | A small owner kind on the C01 runtime. It accepts contexts as C08 §A says, copies the principal into the `audit` column, and applies the push as C08 §B and C05 S-1, S-2 say. It is the reference consumer for S-ACCT and S-MONEY. It is not a production component |
| Contracts introduced | C08 v1.2: §A `PrincipalContext` and `decide`; §B events `issued` and `revoked` only, closure on `iam.status.v1.closure`; §C edge stream and signed heartbeat; §J `audit_append`; §N key-certification stream (purpose `identity_record` only) and `get_policy` (one static bundle) |
| Contracts consumed | C01 v1 (the I1 rows of §3); C10 v1.0.0 (the unauthenticated answer form) |
| Scenarios delivered | X1-S01, X1-S05, X1-S07 |
| Exit criteria | (1) X1-S01: every row passes at the edge; DT-23 shows the same latency distribution for malformed, unknown and wrong-secret credentials (two-sample test, p > 0.05). (2) X1-S05: DT-4 passes against the test owner. (3) X1-S07: C08 C-01 passes against the test owner; the committed row carries the key identifier and the account. (4) C08 P-17 passes. (5) C08 P-01 golden vectors are published for JCS bytes, certificate signature, chain genesis and chain links; S-PLAT can run them. (6) A fixture key issue reaches the test owner within 2 s; a resolved marker arrives on the closure topic every 1 s with no traffic. (7) C01 CC-1 and CC-8 pass for the identity kind. (8) Measurement: edge steps 3 to 6 take ≤ 1 ms at p99 on one node at 2,000 requests/s. This is inside the edge's 10 ms of RFC-000's budget for X2-S05 |
| Dependencies | Frozen C01, C08, C10. S-PLAT: the I1 rows of §3 (or the C01 double) |

### S-SEC-I2. Principal context, key records and the identity status push, complete

| | |
|---|---|
| Goal | Give S-ACCT, S-MONEY, S-LINK and S-RATE the final C1, C2, C3, C14 and C17 behaviour. They need no further change from this slice to authenticate keys and apply key status |
| Components | Identity and access (‹iam_slots› slots with hot standbys; `Moving`, `Stopped`, `onMovedOut`, `onAdopt`; snapshots each ‹snapshot_interval›; heartbeat fencing; supplier keys `ssk_`; KYB status from onboarding; probe flag from the slot map); edge gateway (freshness invariant ≤ ‹edge_staleness_max›; serves nothing until each slot is fresh; version rule; pre-authentication shedding; advisory counters; exact poll limiter; coarse authorisation from the full permission matrix); key service (revocations, 30 s staleness rule, record epochs); C1/C2 library (identity-signed key record in the context; `policy_version` rule; full §4.2 matrix including the C10 AI-40-2 rows); policy feed |
| Contracts introduced | C08 v1.2: §A complete; §B complete (`limits_changed`, `kyb_status`, `catch_up` with and without `since`, 7-day index); §C complete (snapshots, fencing); §N complete for `identity_record` (policy feed `iam.policy.v1`, bundle versions, revocations) |
| Contracts consumed | C01 v1 (the I2 rows of §3); C05 v1 S-1 … S-3 (consumer rules that the test owner follows); C10 v1.0.0 (edge routing, `MOVED`, `MOVING`, `Stopped` answers, keyed digests in logs) |
| Scenarios delivered | X1-S02, X1-S03, X1-S04, X1-S08, X1-S09 |
| Exit criteria | (1) DT-3 passes: "not found" for another account and for a missing resource is byte-identical, with the same latency distribution (p > 0.05). (2) X1-S03 and X1-S04 pass against owner doubles that run `decide` and the C08 C-01 checks. (3) X1-S08 and X1-S09 pass against an account-owner double; edge logs hold only keyed digests of idempotency keys. (4) C08 P-02, P-14, P-15, P-16 and P-18 pass. (5) C08 P-03 passes for keys: with the stream cut before a fixture revocation at `t0`, every edge refuses the key from `t0` + 31 s. (6) DT-25 and DT-16 pass against the test owner. (7) DT-12 passes (shared, P2-S67). (8) C01 CC-2 … CC-5 pass for the identity kind. (9) Measurement: at the SP1 node count, the fleet carries 25,000 bookings/s and 100,000 polls/s with edge steps 3 to 6 ≤ 1 ms at p99 (X2-S03, X2-S05). An identity slot takeover keeps that slot's credentials refused as "temporarily unavailable" for at most the SP2 figure, inside admission's RTO 1 min (X2-S10) |
| Dependencies | I1; SP1; SP2. S-PLAT: the I2 rows of §3 |

### S-SEC-I3. Operator envelope and operator check, one operator

| | |
|---|---|
| Goal | Give every owner that takes operator actions the verified envelope and `operator_check`. Single-operator actions work end to end |
| Components | Identity and access (operator partition: identities, one role each, WebAuthn keys and counters, grants by workforce administration, consumed assertions); console (operator sessions on Share's network, action catalogue by role and reason, refused attempts recorded); signing client (renders the target summary, computes the digest, signs on the authenticator); key service (`owner_summary` certificates); C1/C2 library (envelope verification order of §7.4) |
| Contracts introduced | C08 v1.2: §E envelope and `EnvelopeAnswer`; §F `operator_check` (consume, single use, `digest_conflict`); §G target summary under a console session; §N purpose `owner_summary` |
| Contracts consumed | C03 v2.4 M1 (supply-command envelope target), C07 v1.2 op 2 (credit-limit answers), C04 v2.3.1 (operator side of the reservation command port) |
| Scenarios delivered | X1-S13, X1-S16 |
| Exit criteria | (1) X1-S13: every row is refused and recorded through `audit_append`, against owner doubles. (2) X1-S16 passes against an account-owner double. (3) C08 P-05 (single-use part) and P-12 pass. (4) DT-8 rows for one operator pass against an owner double: reused assertion, other-role assertion, wrong challenge, origin or `rpIdHash`, no user verification, after `not_after`, stale `target_version`, changed field. (5) Golden vectors for the envelope digest (one per `Target` kind) are published (C08 P-01). (6) C08 C-04 and C-07 run green against the owner double; S-ACCT, S-MONEY and S-LINK can run them |
| Dependencies | I2 |

### S-SEC-I4. Four eyes, approval expiry, cancellation and the credit-limit threshold

| | |
|---|---|
| Goal | Complete the console's approval state machine and the owner-side four-eyes rules |
| Components | Console (pending requests, second approval by another person of the same role, lapse at `not_after`, alerts before lapse); identity (`cancel` serialised with consuming checks; identity-signed receipt; counter alert); policy bundle (`four_eyes_above_micro_usd` with history); signing client (shows limit in force, new limit and threshold); key service (`placement_summary` certificates, CI5-6 reading) |
| Contracts introduced | C08 v1.2: §F `cancel`; §E four-eyes fields; §N purpose `placement_summary` |
| Contracts consumed | C07 v1.2 op 2 (`four_eyes_required`); C05 v1 S-3 (credit-limit entry records `iam_fresh`); C01 v1 `timer`, alert stream, `probeSetSummary` |
| Scenarios delivered | X1-S26, X1-S32, X1-S49 |
| Exit criteria | (1) X1-S26 and X1-S32 pass against an account-owner double. (2) DT-36 passes against an account-owner double that follows C07 op 2; C08 C-14 runs green on that double. (3) C08 P-05 (cancel at every interleaving) and P-13 pass. (4) DT-8 passes in full. (5) DT-32 passes against a placement double and an account-owner double (shared, X2-S24) |
| Dependencies | I3. S-PLAT: `timer`, alert stream, probe set summary |

### S-SEC-I5. Personal-data store: put and get, and read grants at the store

| | |
|---|---|
| Goal | Give identity, the notifier, the console and reporting one store for personal data, with audited reads |
| Components | Personal-data store (own database; subject keys under `KEK_PD` generations; blind index; `put` with kinds, versions and write-once items; `get` by purpose; `lookup_login`; `tag_note`; caller allowlist); key service (generation keys, blind-index key); identity (read grant checks with `operator_check`) |
| Contracts introduced | C09 v1.1: `put`, `get`, `lookup_login`, `tag_note`; C08 v1.2 §H read grant (reader checks, grant digest v2) |
| Contracts consumed | C01 v1 (store as an owner kind); I3 `operator_check` |
| Scenarios delivered | None. This increment is an enabler for I7, I12, I13 and I15, and for the notifier (S-PLAT) and reporting (S-MONEY) |
| Exit criteria | (1) C09 provider tests 7, 8, 9, 11, 12, 17 and 25 pass. (2) DT-24 passes for the store: a console `get` without a grant is refused; with a grant, the store's audit append commits before the answer. (3) Every "not found" cause gives one byte-identical answer. (4) `put` is acknowledged only when durable in two regions (X2-S14 measurement on the store) |
| Dependencies | I3 |

### S-SEC-I6. Authenticity of money-moving inputs

| | |
|---|---|
| Goal | Payments, payouts and reconciliation act only on authentic inputs |
| Components | Edge payment ingress; authenticity verifier library (signature schemes, verify-by-fetch with ‹fetch_rate_limit›, ‹provider_timestamp_tolerance›); secrets service (provider credentials) |
| Contracts introduced | RFC-005 C7 `verify(provider, request)` (library; verdict form as RFC-005 C7) |
| Contracts consumed | C07 v1.2 ops 3 and 4 (inputs carried) |
| Scenarios delivered | X1-S10 |
| Exit criteria | (1) DT-13 passes against payments and payouts doubles that follow C07. (2) Measurement per provider: verification time at p99. For signed providers it leaves the top-up inside 10 s at p99 (X2-S07). Each provider without signatures is reported (RK-2) |
| Dependencies | I2 |

### S-SEC-I7. Account users, sessions and administrator key commands

| | |
|---|---|
| Goal | Account administrators manage users, rights and keys. Every key and session stops within 60 s of revocation |
| Components | Identity (authorisation server: OpenID Connect, password and second factor, WebAuthn for administrators, ES256 tokens, sessions, rotating refresh tokens; users with personal data in the store; administrator right; key issue, change and revoke; `account_max_keys` and last-administrator checks in the serial order; idempotency for 24 h; refused attempts recorded; ‹mgmt_rate_limit›); edge (sessions and token keys in the replica; connections closed on revocation). The fixture command is removed from the key path |
| Contracts introduced | C08 v1.2 §C session records; §B events from administrator commands |
| Contracts consumed | C09 v1.1 (`put`, `lookup_login`) through I5 |
| Scenarios delivered | X1-S06, X1-S19, X1-S20, X1-S21, X1-S38 |
| Exit criteria | (1) DT-1 passes for keys and for the account-user cases of X1-S41 (user removed, session ended, administrator right removed), against the test owner. (2) DT-5 passes. (3) X1-S19 and X1-S20 pass; each change records the administrator, time, old and new values. (4) C08 P-03 passes for sessions. (5) Measurement: revocation worst case ≤ 31 s at every edge; ≤ 26 s at the test owner without Kafka (RFC-005 §3.3) |
| Dependencies | I5 |

### S-SEC-I8. Webhook endpoints and signed webhooks

| | |
|---|---|
| Goal | Buyers and suppliers can verify every webhook. Each webhook goes only to its own tenant's endpoint |
| Components | Identity (register, change, remove endpoints; URL rules; secrets shown once; rotation overlap and *rotate now*; endpoint feed and query; endpoint → tenant in the edge replica); webhook signing library (per-attempt timestamp and signature, `webhook-id` per fixed notice set, one tenant per delivery); key service (secret release to the notifier's delivery worker only) |
| Contracts introduced | C08 v1.2 §L endpoint feed and query; §M signed webhook |
| Contracts consumed | C04 v2.3.1 (outcome feed, as the notifier uses it); C03 v2.4 (supplier notices) |
| Scenarios delivered | X1-S11, X1-S24, X1-S25 |
| Exit criteria | (1) C08 P-08 and P-11 pass. (2) DT-10 passes at registration; the delivery-time rows run against a notifier double. (3) Golden vectors for the webhook signature are published (C08 P-01). (4) C08 C-12 runs green against the notifier double; S-PLAT can run it (shared, P2-S09). (5) X1-S25 passes in every row, the self-grant row included |
| Dependencies | I7 |

### S-SEC-I9. Supplier administration, exporter credentials and supplier authority

| | |
|---|---|
| Goal | Supplier administrators manage their users, keys, exporters and endpoints. Only a link's supplier, or network operations for outages, changes the link |
| Components | Identity (supplier users and sessions, supplier administrator right, supplier keys, exporter credentials from the device CA with serials in the replica, supplier endpoints); edge (certificate serial check on every message, connection closed on revocation); C1/C2 library (C11 supplier authority check for the link owner); console (network-operations outage and restoration actions) |
| Contracts introduced | C08 v1.2 §C device-certificate records; RFC-005 C11 (library check) |
| Contracts consumed | C03 v2.4 M1 (supply commands, `ENVELOPE_REFUSED`); C11 v1.0.0 (exporter credential and context, as metering ingestion consumes them) |
| Scenarios delivered | X1-S22, X1-S23, X1-S33, X1-S41 |
| Exit criteria | (1) DT-1 passes for every X1-S41 case, the supplier-user and exporter cases included. (2) X1-S22 and X1-S23 pass against a link-owner double that follows C03 M1. (3) X1-S33 passes in every row. (4) C08 P-03 passes for device certificates |
| Dependencies | I4, I8 |

### S-SEC-I10. Supplier visibility, consent and legal-order disclosure

| | |
|---|---|
| Goal | A supplier sees its reservations by an opaque reference, and the buyer only with consent or a legal order |
| Components | Identity (consent registry by supplier; consent commands; disclosures from a compliance four-eyes envelope with scope and end; `visibility` by consistent read); secrets service (reference keys `K(supplier, v)`, `K_line(supplier, v)`); C6 library (`ref`, `ref_line` and inverses, released to reporting, the notifier and the provisioning feed only) |
| Contracts introduced | C08 v1.2 §D `visibility` and the reference library |
| Contracts consumed | C06 v1 (charge-line identifiers for `ref_line`) |
| Scenarios delivered | X1-S18, X1-S28, X1-S29, X1-S30, X1-S35 |
| Exit criteria | (1) DT-6, DT-7 and DT-18 pass. (2) C08 P-04 passes. (3) C08 C-09 runs green against a reporting double; S-MONEY can run it. (4) X1-S18 passes in every row: keys, users and rights (I7), endpoints (I8), consent (this increment) |
| Dependencies | I4, I8 |

### S-SEC-I11. Audit trail integrity

| | |
|---|---|
| Goal | Nobody can alter or remove a record without detection, and no reader accepts an altered range |
| Components | Audit (audit changefeed per log table to `cdc.audit.<kind>`; chain and continuity verifier; checkpoints each ‹checkpoint_interval› in two trust domains; monthly second verifier; changefeed watch; integrity stop and resume; first-seen head as of `enforced_at`; audit query with "record altered or missing"; truncation watermark); break-glass sessions recorded through audit; key service (audit checkpoint key) |
| Contracts introduced | C08 v1.2 §J complete (field set, chain, changefeed, query); §K integrity stop, resume, restore role rules |
| Contracts consumed | C01 v1 §2.6 integrity stop service, `placement_integrity_stops`, restore role |
| Scenarios delivered | X1-S14, X1-S15 |
| Exit criteria | (1) DT-9, DT-17 and DT-31 pass. (2) C08 P-09 and P-10 pass. (3) C08 C-10 and C-11 run green against the C01 runtime (with S-PLAT). (4) X1-S14 passes for identity's own entries and against owner doubles. (5) Measurement: an UPDATE through break-glass is detected before the next checkpoint (≤ 10 min). Audit query of one principal over 30 days answers inside the retrieval target of X2-S11 |
| Dependencies | I2; SP3. S-PLAT: integrity stop service and restore role |

### S-SEC-I12. Operator reads, documented requests and terminations

| | |
|---|---|
| Goal | Support reads only with a recorded grant and acts only at an account's documented request. Terminations follow POL-30 |
| Components | Console (read grants with ‹read_grant_ttl›; documented-request intake from the edge; case notes through `put` and `tag_note`; termination actions with the compliance withhold flag; actions not on one account: prices, link registration, disaster declaration, audit read); edge (documented-request rate limit; forward with the user's context) |
| Contracts introduced | C08 v1.2 §H for every reader (reporting, status replicas, link owner, catalogue, history, audit query) |
| Contracts consumed | C10 v1.0.0 (documented-request intake); C04 v2.3.1 (terminations); C06 v1 §12 (history evidence query as reader); C01 v1 history query |
| Scenarios delivered | X1-S17, X1-S27, X1-S31, X1-S36 |
| Exit criteria | (1) DT-19 and DT-24 pass against owner and reader doubles. (2) C08 C-06 and C-08 run green on the doubles; other slices can run them. (3) X1-S31 passes in every row, the compliance audit read included (I11) |
| Dependencies | I4, I5, I11. S-PLAT: history query |

### S-SEC-I13. Payout destination

| | |
|---|---|
| Goal | A supplier administrator changes the payout destination safely. Payouts read the version in force at a run's cut |
| Components | Identity (command in the order check, mint, put, commit, check again; holder `business` or a subject, RQ5-13; notice to every supplier administrator; query by serializable read above `at`) |
| Contracts introduced | C07 v1.2 op 5 (`PayoutDestinationAt`, `PayoutDestinationVersion`) as provider |
| Contracts consumed | C09 v1.1 `payout_destination_details` (write-once item) |
| Scenarios delivered | None in X1. Contributes to P4-S118 (S-MONEY) |
| Exit criteria | (1) DT-33 passes except the held-administrator rows (I17). (2) C09 test 26 passes against a payouts double. (3) Only payouts' principal gets an answer; others get `PERMISSION_DENIED` |
| Dependencies | I9 |

### S-SEC-I14. Non-conforming payloads, expiry and digest keys

| | |
|---|---|
| Goal | Metering ingestion keeps rejected payloads only in the erasable store, and they expire in every copy |
| Components | Personal-data store (`put_payload` with `keep_by`, caps by count and bytes, lending; `withdraw_payload`; bucket keys per (exporter, hour); day expiry keys `X_d`; store events feed `pds`); key service (`digest_key`) |
| Contracts introduced | C09 v1.1 `put_payload`, `withdraw_payload`, `digest_key`, expire, store events feed |
| Contracts consumed | C11 v1.0.0 (`RecordId`) |
| Scenarios delivered | None in X1. Contributes to P3-S71 and P3-S75 (S-RATE) |
| Exit criteria | (1) C09 provider tests 1 to 6, 16 and 18 pass. (2) DT-30 passes. (3) DT-21 expiry rows pass. (4) C09 tests 19 to 24 run green against an ingestion double; S-RATE can run them |
| Dependencies | I5, I9; SP4 |

### S-SEC-I15. Erasure requests and erasure

| | |
|---|---|
| Goal | An erasure runs only on a recorded request from a channel open to its subject. Every copy becomes unreadable inside `erasure_max` |
| Components | Identity (five channels: `record_erasure_request` from the edge, administrator pass-on, workforce administration, compliance non-user request, legal-requirement request with four eyes; `open_requests`); personal-data store (`erase` by subject, account payload key and bucket keys; generation rotation and destruction; forced rotation; `erasure_executed` events; restore fence and `reapply`); console (compliance queue and erase envelope) |
| Contracts introduced | C08 v1.2 §I erasure intake and `open_requests`; C09 v1.1 `erase`, restore |
| Contracts consumed | C09 store events feed (I14) |
| Scenarios delivered | X1-S12, X1-S34, X1-S39, X1-S42, X1-S43 |
| Exit criteria | (1) DT-15, DT-20, DT-21 (erasure rows), DT-27 and DT-28 pass. (2) C08 P-06 passes. (3) C09 provider tests 10, 13, 14 and 15 pass; test 29 runs green against a restore-tooling double. (4) X1-S12 passes in every row against owner doubles; the erasure row completes it. (5) Measurement: every copy is unreadable within min(`r` + 23, `e` + 14) days, with time compressed |
| Dependencies | I4, I12, I14; SP4 |

### S-SEC-I16. Deferred and retention erasures

| | |
|---|---|
| Goal | Erase what a request reaches: a shared note whole, a sole trader's payout destination after settlement, a non-user's evidence after `erasure_evidence_retention` |
| Components | Identity (deferred and retention work items in compliance's queue; `destination_cleared`); console (finance confirmation of settlement while CI5-2 is open); personal-data store (non-user evidence as `erasure_request_document`) |
| Contracts introduced | None new. Uses the CI5-1 … CI5-3 readings of RFC-005 (see §7) |
| Contracts consumed | C07 v1.2 op 5; C09 v1.1 `erase` |
| Scenarios delivered | X1-S47, X1-S48 |
| Exit criteria | (1) DT-34 and DT-35 pass under the adopted readings. (2) Each deferred or retention item shows in compliance's queue with its own `request_ref` and alert |
| Dependencies | I13, I15 |

### S-SEC-I17. Account recovery

| | |
|---|---|
| Goal | Only onboarding recovers an account. A prior administrator can object during `recovery_hold`. A held administrator cannot silence, spend through or redirect the account |
| Components | Identity (`recovery_granted` from onboarding; hold with timer; held administrators and held grants; `added_in_hold`; held pass-ons; `object_to_recovery` from the edge; confirm and cancel entries); edge (objection forwarded with the user's token) |
| Contracts introduced | C08 v1.2 §I recovery objection |
| Contracts consumed | C01 v1 `timer` |
| Scenarios delivered | X1-S40, X1-S44, X1-S45, X1-S46 |
| Exit criteria | (1) DT-26, DT-29 and the held rows of DT-33 pass. (2) C08 P-07 passes. (3) Lease loss during a hold behaves as RFC-005 §14 says |
| Dependencies | I9, I13, I15 |

### S-SEC-I18. No personal data outside the store

| | |
|---|---|
| Goal | Prove that no log, topic, trace or R3 file holds personal data or tenant plaintext |
| Components | Write-path refusal of free-text fields in every S-SEC owner; sampling scanner (‹scan_sample›); marker test harness |
| Contracts introduced | None |
| Contracts consumed | C01 v1 §3.12 (sealed columns) |
| Scenarios delivered | X1-S37 |
| Exit criteria | (1) DT-14 passes after a full functional run with marker data. (2) DT-11 passes on R3's replica files, system ranges and KRaft controller |
| Dependencies | I1 … I17 |

## 6. Scenario map

Each X1 scenario is in exactly one increment. Check with:
`rg -o '^\| X1-S[0-9]{2} ' docs/04-delivery/plan/S-SEC.md | sort | uniq -d` (no output) and
compare the sorted list with `rg -o '@X1-S[0-9]{2}' docs/02-specs/X1-security-and-tenancy.feature`.

| Scenario | Increment |
|---|---|
| X1-S01 | S-SEC-I1 |
| X1-S02 | S-SEC-I2 |
| X1-S03 | S-SEC-I2 |
| X1-S04 | S-SEC-I2 |
| X1-S05 | S-SEC-I1 |
| X1-S06 | S-SEC-I7 |
| X1-S07 | S-SEC-I1 |
| X1-S08 | S-SEC-I2 |
| X1-S09 | S-SEC-I2 |
| X1-S10 | S-SEC-I6 |
| X1-S11 | S-SEC-I8 |
| X1-S12 | S-SEC-I15 |
| X1-S13 | S-SEC-I3 |
| X1-S14 | S-SEC-I11 |
| X1-S15 | S-SEC-I11 |
| X1-S16 | S-SEC-I3 |
| X1-S17 | S-SEC-I12 |
| X1-S18 | S-SEC-I10 |
| X1-S19 | S-SEC-I7 |
| X1-S20 | S-SEC-I7 |
| X1-S21 | S-SEC-I7 |
| X1-S22 | S-SEC-I9 |
| X1-S23 | S-SEC-I9 |
| X1-S24 | S-SEC-I8 |
| X1-S25 | S-SEC-I8 |
| X1-S26 | S-SEC-I4 |
| X1-S27 | S-SEC-I12 |
| X1-S28 | S-SEC-I10 |
| X1-S29 | S-SEC-I10 |
| X1-S30 | S-SEC-I10 |
| X1-S31 | S-SEC-I12 |
| X1-S32 | S-SEC-I4 |
| X1-S33 | S-SEC-I9 |
| X1-S34 | S-SEC-I15 |
| X1-S35 | S-SEC-I10 |
| X1-S36 | S-SEC-I12 |
| X1-S37 | S-SEC-I18 |
| X1-S38 | S-SEC-I7 |
| X1-S39 | S-SEC-I15 |
| X1-S40 | S-SEC-I17 |
| X1-S41 | S-SEC-I9 |
| X1-S42 | S-SEC-I15 |
| X1-S43 | S-SEC-I15 |
| X1-S44 | S-SEC-I17 |
| X1-S45 | S-SEC-I17 |
| X1-S46 | S-SEC-I17 |
| X1-S47 | S-SEC-I16 |
| X1-S48 | S-SEC-I16 |
| X1-S49 | S-SEC-I4 |

Contributions to scenarios of other slices (the primary slice places them; listed here
only to show where this slice provides its part): P2-S09 (I8), P2-S64 and P2-S113 (I2),
P2-S67 (I2), P2-S72 and P2-S103 (I2, I7), P3-S71 and P3-S75 (I14), P4-S82 (I2, I3),
P4-S99 (I3), P4-S118 (I13), X2-S24 (I4), X2-S25 and X2-S29 (I12).

## 7. Risks

### 7.1 Contract issues (CI5-1 … CI5-6): plan around them, do not block

| Issue | Effect on this plan | Work item or acceptance |
|---|---|---|
| CI5-1 (C09 v1.1 has no item-scoped `erase`) | A sole trader's destination details cannot be erased alone without a subject tombstone | I16 keeps deferred destination erasures in compliance's queue, alerted, with `erasure_max` from settlement. When C09 v1.2 adds `ErasureScope.items`, add one increment to use it |
| CI5-2 (C07 has no settlement query for a destination) | Identity cannot learn when payouts to a destination are final and reconciled | I16 uses finance's confirmation in the console to start the deferred erasure. Replace it when C07 adds op 6 or a `destination_settled` event |
| CI5-3 (C08 §I has no `retention` or `deferred` channel; C09 says "no retention erase") | Retention erasures have no request channel | I16 records each item with its own `request_ref` linked to the original; one compliance operator runs the ordinary erase envelope |
| CI5-4 (C09 erased ranges end at `store_commit` + 1 h) | A payload in the hour after execution is not kept, against X1-S47's third row | Accepted: follow C09; evidence is lost, no personal data is kept. DT-34's payload row asserts the C09 behaviour and is marked as an open deviation until C09 changes |
| CI5-5 (C08 §B puts resolved markers on the data topic; C01 puts them on the closure topic) | Push consumers could look in the wrong place | Follow C01 from I1: markers on `iam.status.v1.closure` from the emitter, consumed by `onResolved` |
| CI5-6 (C01 names an RFC-005 "signing service" for `probeSetSummary`) | Placement's signature path is unclear | Follow C08: I4 certifies placement's own summary-signing key under purpose `placement_summary`. CP-10 on S-PLAT verifies it |

### 7.2 RFC risks

| Risk | Treatment |
|---|---|
| RK-1 (one invariant per side) | Work item in I2: the freshness invariant is in the edge library only, with no bypass path; DT-1 runs in continuous testing from I7; staleness exported and alarmed at 30 s |
| RK-2 (providers without signatures) | Work item in I6: measure each provider; report against X2-S07 |
| RK-3 (four-eyes availability) | Work item in I4: alert pending actions well before `not_after` |
| RK-4 (linkability beyond the reference) | Accepted: supplier views show only the POL-33 minimum (I10) |
| RK-5 (leaked reference key) | Work item in I10: release to three consumers only, reads audited, new version on demand |
| RK-6 (flood of refused attempts) | Work item in I2 and I7: pre-authentication shedding, aggregated recording, ‹mgmt_rate_limit› |
| RK-7 (social engineering of support) | Accepted with the RFC's reason: the attacker could make the change directly |
| RK-8 (duties of every owner and reader) | Work item: I1 to I5 publish golden vectors and run C08 C-01, C-04, C-07, C-08 on doubles; other slices run the same tests |
| RK-9, RK-16 (HSM dependence; identity on the authentication path) | Spikes SP2 and SP4 |
| RK-10 (clock dependence) | Accepted: all bounds are seconds or more, above `max_offset` |
| RK-11 (audit query cost) | Work item in I11: measure the query against X2-S11 |
| RK-12 (clear metadata) | Accepted with the RFC's reason |
| RK-13 (weekly HSM operations, 10-day execution) | Work item in I15: alarms at 7 days; SP4 measures the operations |
| RK-14 (untagged case notes) | Work item in I12 and I18: the console proposes subjects; the scanner flags untagged notes |
| RK-15 (database administrative surface) | Work item in I11: break-glass only, recorded; DT-9 |
| RK-17 (confirm guard stops a slot) | Accepted: aligns with the edge; monitored per slot by S-ACCT |
| RK-18, RK-24 (RLS; CDC queries) | Spike SP3 before I11 |
| RK-19 (signing client) | Work item in I3: separate build and signature |
| RK-20 (non-user verification by people) | Work item in I15: execution target 10 days, alert at 7 days |
| RK-21 (recovery costs a day) | Accepted: POL-32 accepts it |
| RK-22 (EKM dependence) | Spike SP4 |
| RK-23 (leaked digest key) | Work item in I14: two workload identities only, audited, yearly versions |
| RK-25 (deferred and retention erasures) | See CI5-1 … CI5-3 above |
| RK-26 (holder not named) | Work item in I13: the change form asks for the holder at every change (RQ5-13) |

## 8. Blockers and external dependencies

No hard blocker. These items do not stop any increment:

1. **S-PLAT delivery of the C01 subset** (§3). The S-PLAT plan is not yet written. Each
   increment can start on the C01 double and must pass again on the real runtime.
2. **Link-registry feed** (RFC-001 §10, link → supplier map) is not a frozen C4 contract.
   The edge's coarse tenant check for links waits for it. Until then the link owner's
   check under C03 M1 (with the C11 library, I9) gives X1-S22. The edge forwards supply
   commands to the link owner, which answers as for a link that does not exist.
3. **Onboarding and workforce administration** are outside X1. I2 (KYB), I3 (role grants)
   and I17 (recovery) use test drivers that send their commands from their workload
   identities.
