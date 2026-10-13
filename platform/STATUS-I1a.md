# S-PLAT I1a status

**types+double ready**

- `@share/owner-runtime` (1.0.0-alpha.1): the C01 v1 §2.1, §2.2, §2.4, §2.5, §2.7 (SlotOfAnswer), §2.10 types are in
  `platform/runtime/src/api.ts` and exported from the package root.
- `@share/owner-runtime/testing`: `RuntimeDouble` (implements `OwnerRuntime`), `CommandPeerDouble`, `RESULTS`,
  `REFUSALS`, `UNKNOWN_RESULT`, `UNKNOWN_REFUSAL`, `feedEvent`. Self-test `platform/runtime/test/double-cc.test.ts`
  drives CC-1 … CC-8.
- Run: `npm run typecheck:platform`, `node --test platform/runtime/test/double-cc.test.ts` (Node 22.6+ type stripping).

Types C01 names but does not define (`AuditFields` from C08 §J, `HeadRow`, `InboundNotification`, `ReadTx`,
`FeedCheckpoint`, `OperatorEnvelope`) are minimal stand-ins, marked in `api.ts`.

Steps 3–8 (migrations, CockroachDB runtime core, direct publish, canary, dev cell, integration tests) follow.

## Update: steps 3–8 done (I1a complete; integration tests unrun)

- `platform/migrate/` (`@share/owner-migrate`): idempotent C01 §2.3 DDL from an `OwnerDeclaration` (log + partition
  index, head with `adopted`/`batch_id`, outbox with 26 h TTL / 25 h GC, projections with row TTL, `owner_session`
  sharded 64, `owner_slot` with `stops_version`/`report_through`/`marker_seq`, `platform_timing` × 64,
  `placement_integrity_stops`; pre-splits). CLI `owner-migrate <decl.ts> [--print]`.
- Runtime core `CockroachOwnerRuntime` + `PgStore`: sessions (renew 500 ms, holder's view, `leaseValid` 200 ms margin,
  free and expiry acquisition with revocation, re-home, resume), per-slot lane (one batch in flight, size limits,
  exclusive), batch transaction (fence, stops, heads, conditions incl. `displacementRead`, `decide` per attempt,
  seal + C08 §J chain, log/head/outbox/projections in one txn), retry protocol (5 restarts + 1 fresh ⇒ Retry),
  2 s abandon, 15 s backstop ⇒ Ambiguous, resolution by `batch_id`, `Overloaded` from loop shedding/admission.
- Direct publish: `KafkaPublisher` (`@platformatic/kafka` since E-001, idempotent, acks=all). Canary kind: `platform/examples/canary/`.
- Dev cell: `platform/dev/docker-compose.yml`, `npm run dev:up` / `dev:down`.
- Tests: `npm run test:platform` (29 pass), `npm run test:platform:integration` (10; skip without the dev cell).

TODO(I1b), each marked in code with its C01 section: relay + changefeeds (§3.5), closure emitter (§3.6), report
position/markers/read leases/`onReportable` (§3.4), status readers (§2.4), consumer runtime with gap fill
(`subscribe`, `onMarker`, §3.5), Kafka ACLs (§2.5), grants/roles (§2.3), placement feed for `route` (§3.8),
`integrity_report` (C08 §J), admitCommand rebuild from the log (R47-24), standbys (§3.1), TLA+, Jepsen.
