# S-SEC I1 status: walking skeleton

Built on the C01 runtime double (`@share/owner-runtime/testing`). Nothing under `platform/` changed.

| Package | Path | Contents |
|---|---|---|
| `@share/iam-lib` | `iam-lib/` | C08 v1.2 types; JCS and E(); Ed25519 with domains; `CertStore` (§N, §C certificate rules); `decide` + fixed v1 bundle; context encode/decode, receiver check (C-01), audit field set; key token format; C08 §J chain reference; P-01 golden vectors (`golden/c08-p01-i1.json`) |
| `@share/key-service` | `key-service/` | Dev key service: in-memory root, `identity_record` certificates, revocations, cert stream with heartbeats |
| `@share/identity-owner` | `identity-owner/` | Owner kind `iam`: issue/revoke key, push via `emits` on `iam.status.v1` (closure `resolved`), edge stream with signed records, key records and heartbeats, `get_policy`. Fixture only in `./testing` |
| `@share/edge-auth` | `edge-auth/` | Edge replica (§C invariants) and gateway (steps 3, 4, 5, 6, 8, 9; uniform 401 after a 5 ms floor) |
| `@share/audit` | `audit/` | `audit_append` (allowlist, source from mTLS identity, idempotency, conflict page) and chain verification |
| `@share/sec-test-owner` | `test-owner/` | Test owner: C-01 receiver, audit column from the context, push consumer, `onResolved` |

Run: `npm run typecheck:sec`, `npm run test:sec`; measurements: `SEC_MEASURE=1 node --test slices/sec/edge-auth/test/measure.test.ts`.

## Runtime API gaps (for S-PLAT)

1. `AuditFields` stand-in: `principal.tenant: string`, `principal.kind: string`, `received_at: number`. C08 §J has `Tenant`, `PrincipalKind`, `EpochMicros`. Mapped by `toRuntimeAudit`.
2. There is no slot-wide commit sequence. C08 §C needs `position` in commit order within the identity slot. I1 counts `Committed` answers per slot (one batch in flight per slot).
3. `RuntimeDouble` calls no `onAcquire` for its start slots. The identity owner makes the signer when it first needs it.
4. `RuntimeDouble.route(kind, …)` for another kind uses the caller's slot count. `identitySlotOf` uses `slotOfPartition(…, 256)` directly.
5. `RuntimeDouble` writes no `chain`, its `consistentRead` returns no rows, and it has no relay or closure emitter. Chain checks run on `CockroachOwnerRuntime` + `MemoryStore`. The skeleton harness simulates the relay and the 1 s resolved markers.
6. The runtime cannot rebuild the edge stream from the log on takeover. This is TODO(I2).

## Contract issues

1. C08 §A says the edge puts an identity-signed `SignedKeyRecord` in the context. No C08 message delivers one to the edge. I1 adds an optional `key_record` to the unsigned `EdgeStreamMessage`.
2. C08 says the owner kind is "identity" (`route("identity", …)`, cert `owner_kind`). C01 says `iam`, and topics must be `<kind>.…`. I1 uses `iam` for the runtime and "identity" in certificates.
3. C08 fixes JCS, E() and domain strings, but not how the domain joins the signed bytes. I1 uses `UTF-8(domain) ‖ E(JCS)`, published in the P-01 vectors.
4. The `agent_key` edge record has no `principal_id`. I1 uses the key id as the principal identifier.
5. No contract fixes the check-digit algorithm of `shk_` keys.
