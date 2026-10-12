# C08. Identity and access

| | |
|---|---|
| Contract ID | C08 |
| Version | 1.0-draft |
| Status | **Draft, for contract review.** Mismatches M1 … M6 and gaps G1 … G4 settled by the orchestrator (see "Settled"); the RFC errata they imply are listed under "Consumer obligations" |
| Provider | Identity and access, with the operator console, audit and webhook signing (RFC-005 revision 5: §2, §3.1–§3.3, §3.6, §3.7 erasure requests, §3.8, §4, §6, §7, §8.3, §9, §10, §11 C1–C6, C8, C10, C14, C15). Integrity stop: semantics RFC-005, honoured by RFC-006's owner runtime and placement |
| Consumers | **Edge gateway** (RFC-005 specifies it: C1 issuer, C14, erasure intake and recovery objection). **Account owner** (RFC-002 rev. 5 booking module; RFC-004 rev. 5 Part A funds module): C1, C2, C3 push and catch-up, envelope, operator check, target summary, read grant (status replicas), audit field set. **Link schedule owner and link registry** (RFC-001 rev. 5): C1, C2, envelope, operator check, target summary, read grant, audit field set. **Catalogue, rating, metering ingestion, attribution** (RFC-003 rev. 5 + erratum 5.1): C1, envelope, operator check, target summary, read grant, audit field set. **Payments, payouts, ledger, reconciliation, reporting** (RFC-004 rev. 5 + erratum 5.1): C1, envelope, operator check, target summary, read grant, audit field set, supplier visibility (reporting). **RFC-006 rev. 6**: owner runtime and placement (integrity stop and resume, restore role, `chain`, audit changefeed, placement's target summaries), notifier (endpoint feed and query, signed webhook, supplier visibility for supplier notices), history and retention (audit changefeed, sealed segments), provisioning feed (supplier visibility), status replicas (read grants). **Operator console** (RFC-005): envelope issuer, `cancel`, `open_requests`, target-summary relay. **Buyers and suppliers**: signed webhook receivers |
| Transport | In-process library: principal context, `decide`, reference functions. gRPC metadata over mTLS: principal context. **Kafka event** (from identity's transactional outbox through the changefeed relay, RFC-000 §5.5): identity status push, endpoint feed; audit changefeed `cdc.audit.<kind>` (CDC projection). **gRPC query**: `catch_up`, `visibility`, `target_summary`, `open_requests`, `get_endpoint`. **gRPC server stream**: `edge_stream`. **gRPC command**: `operator_check`, `cancel`, `record_erasure_request`, `object_to_recovery`, every operator command carrying an envelope, `integrity_stop`, `integrity_resume`, `audit_append`. **Outbound HTTPS POST**: signed webhook. **No database read across owners** (RFC-000 A1): nobody reads identity's tables; the restore role's row-level-security predicate over audit's `integrity_stops` is a database-enforced policy, not an owner read |
| Pinned to | `requirements-v1.10`; RFC-000 revision 4.4 (§8 rows: principal and authorisation context; identity status push and catch-up; identity edge stream; supplier visibility; operator check; target summary; read grant; erasure-request intake and recovery objection; operator action envelope; audit record; integrity stop; webhook endpoints and signing secrets; signed webhook; "Revision 4.4 errata" AI-R5-7); RFC-005 revision 5; RFC-001 revision 5; RFC-002 revision 5; RFC-003 revision 5 with erratum 5.1; RFC-004 revision 5 with erratum 5.1; RFC-006 revision 6 |

Not in this contract: the personal-data store (C09), authenticity of money-moving inputs
(RFC-005 C7), probe designation (C9, owned by RFC-006), supplier authority on supply
commands (C11, RFC-001's check), column encryption (C13), payout destination (C16), and
the substrate conventions (log-table schema, truncation role, owner leases; RFC-006).
Those are referenced where this contract leans on them.

## Purpose

Identity and access is the only writer of principals, credentials, rights, roles, consent,
webhook endpoints and erasure requests (RFC-000 §2). Nobody reads its tables (A1); every
other component gets identity state through the owner-served streams, feeds and queries
below, and every owner proves the authority for an effect in the same row as the effect.
This contract fixes, for both sides:

1. **Who is calling**: the principal context every external call carries, and the pure
   authorisation decision anyone can recompute (§A).
2. **Credential state at the edge and at the account owner**: the edge stream with its
   signed heartbeats and 31 s refusal invariant (§C); the identity status push with its
   resolved timestamps and the catch-up query, from which the account owner keeps a
   slot-level freshness watermark and confirms only within 45 s of it (§B).
3. **Who may see a buyer's identity**: the per-view consent check (§D).
4. **Operator power**: the signed envelope and read grant, identity's single-use operator
   check and cancellation, and owner-signed target summaries (§E–§H).
5. **Erasure-request intake and recovery objection** from the user's own session (§I).
6. **The audit record**: the field set, the hash chain, the audit changefeed, the append
   log, and the integrity stop and restore after a detection (§J, §K).
7. **Outbound webhooks**: endpoint registrations and secrets to the notifier, and the
   signature buyers and suppliers verify (§L, §M).

## Schema

Units: durations in **ms** unless named in s, h or days; timestamps as **epoch
microseconds UTC** (`EpochMicros`, a `bigint`, a decimal string in JSON), commit, resolved
and read timestamps being the database's HLC wall time **floored** to the microsecond;
money in **micro-USD** (`int64`); capacity in **Mbps** (`int64`); rates per second. Every
identifier is pseudonymous (A11): no field of this contract carries a name, e-mail address,
phone number or document. Byte strings are base64url without padding in JSON. Field names
are the wire names; protobuf messages mirror these types one to one.

### Common types

```ts
type EpochMicros = bigint;
type Id128 = string;                 // 128-bit random, 32 lowercase hex; never reused, never derived from personal data
type PrincipalId = Id128;
type PersonId = Id128;               // operator's person identifier (bound to a vetting record)
type AccountId = string;
type SupplierId = string;
type KeyId = string;                 // the <key id> of shk_<key id>_<secret> / ssk_…
type SessionId = Id128;
type CertSerial = string;            // device-CA certificate serial, hex
type EndpointId = Id128;
type ActionId = Id128;
type GrantId = Id128;
type RequestRef = Id128;             // erasure request
type RecoveryRef = Id128;
type DetectionRef = Id128;
type IdentitySlot = number;          // 0 … iam_slots − 1 (256)
type AccountSlot = number;           // placement's account slot map (RFC-006)
type Bytes = string;                 // base64url

type Tenant =
  | { kind: "account"; account: AccountId }
  | { kind: "supplier"; supplier: SupplierId }
  | { kind: "none" };                // operators, providers, internal services

type PrincipalKind =
  | "account_user" | "agent_key" | "supplier_user" | "supplier_key" | "operator"
  | "probe" | "payment_provider" | "payment_partner" | "payout_provider"
  | "partner_system" | "exporter" | "network_operations" | "internal_service"
  | "onboarding" | "workforce_administration";

type OperatorRole = "support" | "network_operations" | "commercial" | "finance" | "compliance";
type ActionType = string;            // one of the §E catalogue's action_type values
type PolicyVersion = { version: number; matrix: unknown };   // identity's policy partition (RFC-005 §3.1)

type Ed25519Signature = {            // identity record-signing key or owner summary-signing key
  key_id: string;                    // names the certified key (below)
  sig: Bytes;                        // 64 bytes over the canonical bytes of the signed object
};

// A record-signing or summary-signing key, certified by the key service per lease epoch (RFC-005 §10).
type SigningKeyCert = {
  key_id: string;
  purpose: "identity_record" | "owner_summary" | "placement_summary";
  owner_kind: string;                // "identity" for record keys
  slot: number;
  epoch: string;                     // int64 lease epoch
  public_key: Bytes;                 // 32 bytes
  not_before: EpochMicros;
  revoked: boolean;                  // a revoked certification makes every record under it refused
  key_service_sig: Bytes;            // key service's signature over the fields above
};
```

**Canonical bytes.** Every signed or digested object is encoded as **RFC 8785 JSON
Canonicalization Scheme (JCS)** of the object without its signature field, then framed as
`E(x)` = 4-byte big-endian length ‖ bytes, the same framing as the chain (§J). Domain
strings below separate the uses. This encoding is fixed by this contract (RFC-005 says
"canonical" without naming one); both sides must produce identical bytes.

### §A. Principal context and authorisation decision (RFC-005 C1, C2)

```ts
type KeyLimits = {
  key_spend_limit_micro_usd: bigint | null;   // per key_spend_period (one UTC day); null = none (POL-25)
  key_inflight_limit_mbps: bigint | null;     // null = none
  key_rate_limit_per_s: number;               // default 50
};

// Identity-signed key record, carried in the context for an agent or supplier key.
type SignedKeyRecord = {
  key_id: KeyId;
  tenant: Tenant;                    // the issuing account (agent key) or supplier (supplier key)
  status: "active" | "revoked";
  limits: KeyLimits;
  version: number;                   // strictly increasing per key
  probe: boolean;
  signature: Ed25519Signature;       // over JCS, domain "share-key-record-v1"
};

type PrincipalContext = {
  schema: "principal.v1";
  principal_id: PrincipalId;
  kind: PrincipalKind;
  tenant: Tenant;                    // the credential's tenant, never taken from the request (S2)
  rights: { administrator: boolean };
  key_id?: KeyId;
  session_id?: SessionId;
  cert_serial?: CertSerial;
  auth: { method: "oidc_token" | "agent_key" | "supplier_key" | "mtls_cert" | "workload_cert"
                 | "provider_verifier"; at: EpochMicros };
  iam_position: { identity_slot: IdentitySlot; head: string };   // replica freshness the edge used
  key_record?: SignedKeyRecord;      // present for agent_key and supplier_key
  probe: boolean;
  request_id: Id128;
  received_at: EpochMicros;          // edge receipt
  edge_region: "R1" | "R2";
  edge_workload: string;             // the edge node's workload identity
  expires_at: EpochMicros;           // received_at + context_ttl (60 s)
  policy_version: number;
};
// Carried as gRPC binary metadata "x-share-principal-bin" (JCS bytes). Not signed by the edge:
// the receiver authenticates the edge by its mTLS workload identity (R5-24).

type Operation = string;             // a permission-matrix row identifier (RFC-005 §4.2), e.g. "booking.submit"
type Resource = { kind: string; id?: string; tenant?: Tenant };

type Decision =
  | { result: "permit"; policy_version: number }
  | { result: "not_found"; policy_version: number }
  | { result: "refused"; right: string; policy_version: number }
  | { result: "unauthenticated"; policy_version: number };

// Library, pure: same inputs and policy version give the same answer everywhere.
declare function decide(ctx: PrincipalContext, op: Operation, res: Resource, policy: PolicyVersion): Decision;

// Opaque references (RFC-005 §6.1), a library whose keys are released only to reporting,
// notifier and provisioning feed: v ‖ AES-128_{K(supplier, v)}(reservation_id).
declare function ref(supplier: SupplierId, reservation_id: Id128): Bytes;        // 1 byte v + 16 bytes
declare function ref_line(supplier: SupplierId, line_id: Id128): Bytes;
declare function unref(supplier: SupplierId, r: Bytes): Id128 | "not_found";
```

### §B. Identity status push and catch-up (RFC-005 C3, C10)

```ts
// Kafka topic "iam.status.v1"; key = account; payload sealed under the topic's feed key (C13).
type IdentityStatusEvent = {
  schema: "iam.status.v1";
  account: AccountId;
  source: { identity_partition: string; seq: string };   // int64; the idempotency identity
  committed_at: EpochMicros;
  actor: { kind: "administrator"; principal_id: PrincipalId } | { kind: "onboarding" };
  body:
    | { kind: "key_issued"; key_id: KeyId; version: number; limits: KeyLimits; probe: boolean }
    | { kind: "key_limits_changed"; key_id: KeyId; version: number; limits: KeyLimits }
    | { kind: "key_revoked"; key_id: KeyId; version: number }            // terminal
    | { kind: "kyb_status"; status: "passed" | "failed" | "withdrawn"; version: number };
};

// Resolved marker, emitted to every topic partition every resolved_interval (1 s), event or not.
type IdentityStatusResolved = {
  schema: "iam.status.resolved.v1";
  topic_partition: number;
  resolved: EpochMicros;             // every row committed at or before it has been emitted
};

// gRPC query, identity → answered by a consistent read at the present timestamp.
type CatchUpRequest = { account_slot: AccountSlot; since: EpochMicros };   // inclusive
type CatchUpAnswer =
  | { kind: "events"; events: IdentityStatusEvent[]; read_timestamp: EpochMicros }
  | { kind: "snapshot";                                          // since older than the 7-day retention (S-G1)
      state: { account: AccountId;
               keys: { key_id: KeyId; version: number; status: "active" | "revoked"; limits: KeyLimits; probe: boolean }[];
               kyb: { status: "passed" | "failed" | "withdrawn" | "none"; version: number } }[];
      position: EpochMicros;                                     // = read_timestamp of the consistent read
      read_timestamp: EpochMicros }
  | { kind: "temporarily_unavailable" };
```

### §C. Identity edge stream (RFC-005 C14)

```ts
// gRPC server stream from the identity slot's lease holder, to edge workloads only.
type EdgeStreamRequest = { identity_slot: IdentitySlot; from_position: string };   // int64 head; "0" = from snapshot start

type CredentialRecord = {            // every record identity-signed, domain "share-edge-record-v1"
  identity_slot: IdentitySlot;
  position: string;                  // int64, commit order within the slot
  version: number;                   // per record key; the edge applies only higher versions
  body:
    | { kind: "agent_key" | "supplier_key"; key_id: KeyId; verifier_sha256: Bytes; tenant: Tenant;
        limits: KeyLimits; status: "active" | "revoked"; probe: boolean }
    | { kind: "session"; session_id: SessionId; principal_id: PrincipalId; principal_kind: PrincipalKind;
        tenant: Tenant; administrator: boolean; status: "active" | "ended" }
    | { kind: "device_cert"; serial: CertSerial; exporter?: string; tenant: Tenant;
        principal_kind: "exporter" | "probe" | "network_operations"; status: "active" | "revoked" }
    | { kind: "endpoint_tenant"; endpoint_id: EndpointId; tenant: Tenant; status: "active" | "removed" }
    | { kind: "policy_version"; policy_version: number; matrix_digest: Bytes };
  signature: Ed25519Signature;
};

type Heartbeat = {                   // every stream_heartbeat (1 s), only after every record up to head
  identity_slot: IdentitySlot;
  head: string;                      // int64 position
  sent_at: EpochMicros;              // identity's clock (database clock domain)
  signature: Ed25519Signature;       // domain "share-edge-heartbeat-v1"
};

type EdgeStreamMessage = { record: CredentialRecord } | { heartbeat: Heartbeat };

// Snapshot per slot every snapshot_interval (10 min), in object storage, sealed under the edge stream key:
type EdgeSnapshot = { identity_slot: IdentitySlot; position: string; records: CredentialRecord[];
                      taken_at: EpochMicros; signature: Ed25519Signature };
```

### §D. Supplier visibility (RFC-005 C6)

```ts
type VisibilityRequest = {
  supplier: SupplierId;
  accounts: AccountId[];             // buyer accounts in the view
  reservations: { reservation_id: Id128; account: AccountId }[];
};
type VisibilityAnswer =
  | { kind: "answer";
      per_reservation: { reservation_id: Id128;
                         decision: { kind: "reveal"; account: AccountId;
                                     basis: { kind: "consent"; entry_seq: string }
                                          | { kind: "disclosure"; order_ref: string; entry_seq: string } }
                                 | { kind: "hide" } }[];
      registry_timestamp: EpochMicros }
  | { kind: "temporarily_unavailable" };   // caller hides every identity
```

### §E. Operator action envelope (RFC-005 C4, §7.4)

```ts
type SetDescriptor = { kind: "designated_probe_accounts"; slot_map_version: number };

type Target =
  | { kind: "account"; account: AccountId }
  | { kind: "reservation"; account: AccountId; reservation_id: Id128 }
  | { kind: "link"; link_id: string }
  | { kind: "product_route"; product: string; route_id: string }
  | { kind: "payout"; payout_id: Id128 }
  | { kind: "reversal"; reversal_id: Id128 }
  | { kind: "registry_entry"; supplier: SupplierId; account?: AccountId; order_ref?: string }
  | { kind: "data_subject"; subject: PrincipalId }
  | { kind: "erasure_request"; request_ref: RequestRef }
  | { kind: "exporters_period"; exporters: string[]; from: EpochMicros; to: EpochMicros }
  | { kind: "exporter_credential"; exporter: string }
  | { kind: "region"; region: "R1" | "R2" }
  | { kind: "set"; set: SetDescriptor };

type CanonicalAction = {             // what the signing client renders and digests
  action_id: ActionId;
  action_type: ActionType;           // §E catalogue below
  target: Target;
  target_version: string;            // owner's version from the signed target summary; for a set, String(v)
  flags: Record<string, unknown>;    // action-specific (withhold_notice, disclosure scope and end, …)
  scope?: unknown;
  amounts?: { amount_micro_usd?: bigint; usage_rate_cap?: unknown };
  reason_code: string;               // from the action's closed list
  refs: { order_ref?: string; request_ref?: RequestRef; note_ref?: Id128; note_sha256?: Bytes;
          verification_note_ref?: Id128 };
};

type WebAuthnAssertion = {
  credential_id: Bytes;
  authenticator_data: Bytes;         // contains rpIdHash, flags (UP, UV) and the signature counter
  client_data_json: Bytes;           // type "webauthn.get", challenge = digest, origin = signing client
  signature: Bytes;
};

type Signer = { principal_id: PrincipalId; person: PersonId; assertion: WebAuthnAssertion };

type OperatorEnvelope = {
  schema: "operator-envelope.v1";
  action: CanonicalAction;
  role: OperatorRole;
  not_after: EpochMicros;            // request time + approval_expiry (72 h), fixed by the requester's signing client
  requester: Signer;
  approver?: Signer;                 // four-eyes actions only
  member?: AccountId;                // set-scoped actions only; OUTSIDE the digest
  console_epoch: string;             // informational, never trusted
  issued_at: EpochMicros;            // informational, never trusted
};

// digest = SHA-256( E("share-action-v1") ‖ E(JCS(action)) ‖ E(role) ‖ U64(not_after) )

type EnvelopeAnswer =
  | { kind: "applied"; position: { partition: string; seq: string } }
  | { kind: "refused"; check: EnvelopeCheck }
  | { kind: "refused_by_rule"; rule: string }      // an owner's own rule after a valid envelope (e.g. kyb_not_vetted)
  | { kind: "temporarily_unavailable" };           // operator check unreachable, partition Stopped or Moving

type EnvelopeCheck =
  | "digest_or_type"        // check 1: recomputed digest, action type accepted, role, reason code
  | "assertion"             // check 2: WebAuthn rules
  | "operator_check"        // check 3: role now, credential active, unused, not cancelled
  | "four_eyes"             // check 4: approver same role, different person
  | "not_after"             // check 5: own ts > not_after − ε
  | "target_version"        // check 6: stale target_version
  | "out_of_scope"          // check 6, set-scoped: member not this partition, or not a member of the set
  | "withhold_not_allowed"; // withhold_notice on any action type but the compliance termination
```

**Action catalogue** (RFC-005 §7.2; the receiver accepts only its own rows):

| `action_type` | Role | Four eyes | Receiver |
|---|---|---|---|
| `act_at_documented_request` | support | no | account owner |
| `record_outage`, `record_restoration` | network_operations | no | link schedule owner |
| `terminate_network_abuse` | network_operations | no | account owner |
| `declare_region_disaster`, `end_region_disaster` | network_operations | **yes** | placement (RFC-006) |
| `issue_share_exporter_credential`, `revoke_share_exporter_credential` | network_operations | no | identity and access |
| `set_price` | commercial | **yes** | catalogue |
| `set_split_weight` | commercial | **yes** | catalogue |
| `record_partner_terms` | commercial | no | catalogue |
| `register_link`, `retire_link` | commercial | no | link registry (and link owner for retire) |
| `correct_price` | finance | no | catalogue and rating |
| `attribute_quarantine`, `reverse_attribution` | finance | no | attribution and quarantine |
| `set_credit_limit`, `remove_credit_limit` | finance | no | account owner |
| `set_credit_limit` with target `set` | finance | no (S-M2) | each member's account owner, one envelope per member |
| `set_usage_rate_cap` | finance | no | catalogue |
| `resolve_payout_escalation` | finance | no | payouts |
| `resolve_reversal_escalation` | finance | no | payments |
| `terminate_compliance` (optional `withhold_notice` with `order_ref`) | compliance | **yes** | account owner |
| `disclose_identity` | compliance | **yes** | identity and access (registry) |
| `end_disclosure` | compliance | no | identity and access |
| `record_non_user_erasure_request` | compliance | no | identity and access |
| `refuse_erasure_request` | compliance | no | identity and access |
| `open_legal_requirement_erasure` (`order_ref` required) | compliance | **yes** | identity and access |
| `erase` (cites `request_ref`; non-user: `verification_note_ref`) | compliance | no | identity and access |

Read types (§H): `read_account` (support), `read_link_schedule` (network_operations),
`read_audit` (compliance), and each action's preparatory read in its role.

### §F. Operator check and cancellation (RFC-005 C15)

```ts
type OperatorCheckRequest = {
  subject: { kind: "action"; action_id: ActionId } | { kind: "grant"; grant_id: GrantId };
  digest: Bytes;                     // 32 bytes
  signers: { operator: PrincipalId; credential_id: Bytes; counter: number }[];
  consume: boolean;                  // true for owners and readers; false only from the console (approval-time read)
};
type OperatorCheckAnswer =
  | { kind: "answer";
      per_signer: { operator: PrincipalId; role: OperatorRole | null; person: PersonId;
                    credential_status: "active" | "revoked" | "unknown";
                    unused: boolean }[];           // false iff (credential, counter) consumed under ANOTHER identifier
      cancelled: boolean;
      checked_at: EpochMicros }
  | { kind: "temporarily_unavailable" };           // callers refuse (S4)

type CancelRequest = {
  action_id: ActionId;
  digest: Bytes;
  requester: Signer;                 // assertion challenge = SHA-256( E("share-cancel-v1") ‖ E(digest) )
};
type CancelAnswer =
  | { kind: "receipt"; action_id: ActionId; digest: Bytes; cancelled_at: EpochMicros;
      signature: Ed25519Signature }                // identity-signed, domain "share-cancel-receipt-v1"
  | { kind: "too_late" }                           // "already applied or applying"; no receipt
  | { kind: "refused"; check: "assertion" | "not_requester" | "unknown_action" }
  | { kind: "temporarily_unavailable" };
```

### §G. Target summary (RFC-005 C4, §7.3)

```ts
type TargetSummaryRequest = {
  target: Target;
  authority:
    | { kind: "read_grant"; grant: ReadGrant }
    | { kind: "console_session"; operator: PrincipalId; role: OperatorRole; session_id: SessionId;
        action_id?: ActionId; action_type?: ActionType };   // S-G3: unsigned; the owner audits the request
};
type SignedTargetSummary = {
  owner_kind: string; slot: number; epoch: string;
  target: Target;
  target_version: string;                      // the version the owner re-checks at apply (check 6)
  body: unknown;                               // owner-specific (below)
  as_of: EpochMicros;
  signature: Ed25519Signature;                 // owner summary-signing key, domain "share-target-summary-v1"
};
type TargetSummaryAnswer = SignedTargetSummary | { kind: "not_found" } | { kind: "temporarily_unavailable" };
```

Owner bodies fixed by consumer RFCs: account owner (RFC-002 §13.1) `{ standing, reservations[] }`
for an account, `{ legs[], parts[], end }` for a reservation, `target_version` the sequence of
its last change; placement (RFC-006 §12.7) for a `set`: `probeSetSummary(v) = { mapVersion,
slotCount, probeAccountCount, setDigest }`, signed by placement's key. Other owners: see "Consumer obligations".

### §H. Read grant (RFC-005 C4, §7.6)

```ts
type ReadGrant = {                   // field names shared with C09
  grant_id: GrantId;
  operator: PrincipalId;
  role: OperatorRole;
  read_type: string;                 // §E read types
  target: Target                     // exactly one target
        | { kind: "subject"; subject: PrincipalId }
        | { kind: "payload"; record_id: unknown }       // C09 RecordId
        | { kind: "audit_scope"; scope: unknown };
  reason: string;                    // reason code
  not_after: EpochMicros;            // signing time + read_grant_ttl (1 h)
  webauthn: { credential_id: Bytes; authenticator_data: Bytes; client_data_json: Bytes; signature: Bytes };
};
// grant digest = SHA-256( E("share-read-grant-v1") ‖ E(grant_id) ‖ E(read_type) ‖ E(JCS(target))
//                         ‖ E(role) ‖ E(reason) ‖ U64(not_after) )

type ReadGrantRefusal = "assertion" | "operator_check" | "not_after" | "target_out_of_grant"
                      | "read_limit" | "role_not_allowed";
```

### §I. Erasure-request intake and recovery objection (RFC-000 §8; RFC-005 §3.7, §3.8, C12)

```ts
// edge → identity, gRPC, with the user's principal context (C1) and its access token.
type RecordErasureRequest = {
  context: PrincipalContext;
  access_token: string;              // the ES256 JWT, verified by identity itself
  idempotency_key: string;           // ≤ 255 bytes
  subject?: PrincipalId;             // if present must equal the token's principal_id (else other_subject)
};
type RecordErasureAnswer =
  | { kind: "recorded"; request_ref: RequestRef; requested_at: EpochMicros }   // identity's commit
  | { kind: "refused"; reason: "key_principal" | "other_subject" | "invalid_token" | "idempotency_key_reused" }
  | { kind: "temporarily_unavailable" };

type ObjectToRecovery = {
  context: PrincipalContext;
  access_token: string;
  recovery_ref: RecoveryRef;
  idempotency_key: string;
};
type ObjectionAnswer =
  | { kind: "cancelled"; recovery_ref: RecoveryRef; cancelled_at: EpochMicros }
  | { kind: "no_recovery_in_hold" }            // unknown recovery, or hold already ended
  | { kind: "refused"; reason: "not_prior_administrator" | "held_administrator" | "key_principal"
                             | "invalid_token" | "idempotency_key_reused" }
  | { kind: "temporarily_unavailable" };

// console → identity, gRPC query (read only).
type OpenRequestsQuery = { scope: "compliance_queue" | "documented_requests"; tenant?: Tenant };
type OpenRequest = {
  request_ref: RequestRef; subject: PrincipalId;
  channel: "administrator_pass_on" | "user_own" | "workforce" | "non_user" | "legal_requirement";
  requested_at: EpochMicros;
  status: "held" | "to_verify" | "open" | "executing";
};
type OpenRequestsAnswer = { requests: OpenRequest[] /* oldest first */ } | { kind: "temporarily_unavailable" };
```

Compliance-recorded requests use envelopes (§E): `record_non_user_erasure_request`
(`note_ref`, exporters, period → status *to verify*), `open_legal_requirement_erasure`
(four eyes, `order_ref` required), `refuse_erasure_request`, `erase`. Their answer is
`EnvelopeAnswer`, with `applied` carrying `{ request_ref, requested_at }` for the first two.

### §J. Audit record (RFC-005 C5, §9.2, §9.3)

```ts
// The sealed `audit` column of every row that changes money, capacity, a link, a key, a user or right,
// a role, a consent or disclosure, a policy setting, an endpoint, an erasure request, a standing,
// a reservation or a request, or applies an operator action. Pseudonymous identifiers only.
type AuditFields = {
  schema: "audit.v1";
  principal: { principal_id: PrincipalId | "internal_service"; kind: PrincipalKind; tenant: Tenant;
               key_id?: KeyId; session_id?: SessionId; cert_serial?: CertSerial; edge_workload?: string };
  on_behalf_of?: { account: AccountId; request_ref: Id128 };          // support at a documented request
  operator?: { role: OperatorRole; reason_code: string; order_ref?: string; request_ref?: Id128;
               note_ref?: Id128; note_sha256?: Bytes; approver?: PrincipalId; envelope_digest: Bytes;
               action_id: ActionId; member?: AccountId; set_version?: number /* signed v, recorded only (S-M1) */ };
  cause?: { rule: string /* "POL-nn" */; trigger: { partition: string; seq: string } };
  received_at?: EpochMicros; request_id?: Id128;
  decided_at: "commit";              // the row's own ts; not duplicated in the column
  policy_version: number; iam_position?: { identity_slot: IdentitySlot; head: string };
  old?: unknown; new?: unknown;      // configured values only (limits, prices, weights, rights)
};
// Audit record identifier: (owner kind, partition, seq).

// Audit append (non-owner sources and readers of read grants), gRPC → audit.
type AuditAppend = { source: string; source_ref: string; record: AuditFields & { event: string } };
type AuditAppendAnswer = { kind: "appended"; position: { partition: string; seq: string } }
                       | { kind: "temporarily_unavailable" };

// Audit changefeed per log table: topic "cdc.audit.<kind>", key = partition, consumed by audit only.
type AuditCdcEvent = {
  slot: number; partition: Bytes; seq: string; generation: number; epoch: string; kind: number;
  chain: Bytes; ts: string /* HLC decimal */; op: "insert" | "update" | "delete";
};
```

Chain column (RFC-005 §9.3 layer 4, RFC-006 §3.7; DDL is RFC-006's, these columns are this
contract's):

```sql
-- on every <kind>_log
chain BYTES NOT NULL CHECK (length(chain) = 32)
-- on every <kind>_head
chain BYTES
```

```text
chain_0 = SHA-256("share-chain-v1-genesis" ‖ E(kind name) ‖ E(partition))
chain_n = SHA-256("share-chain-v1" ‖ chain_{n−1} ‖ E(kind name) ‖ E(partition) ‖ U64(seq) ‖ U32(slot)
                  ‖ U32(generation) ‖ U64(epoch) ‖ U16(kind) ‖ U16(schema_v) ‖ E(identity) ‖ E(emits)
                  ‖ U16(retention) ‖ E(key_id) ‖ E(audit) ‖ E(payload))
E(x) = U32 big-endian length ‖ bytes; U… big-endian fixed width; audit and payload are the stored ciphertexts;
emits, identity and key_id are the stored column bytes; ts is not covered.
```

### §K. Integrity stop and resume, restore role (RFC-000 §8 rev. 4.4 AI-R5-7; RFC-005 C5, §9.3, §10; RFC-006 §12.2, §14.3)

```ts
// audit → owner runtime (RFC-006), gRPC; caller allowlist: audit only.
type IntegrityStop   = { kind: string; partition: Bytes; detection_ref: DetectionRef };
type IntegrityResume = { kind: string; partition: Bytes; detection_ref: DetectionRef;
                         checkpoint: { root: Bytes; at: EpochMicros } };   // the checkpoint re-verified against
type IntegrityAck =
  | { kind: "stopped"; recorded_at: EpochMicros }   // durable in placement's integrity_stops projection
  | { kind: "resumed"; recorded_at: EpochMicros }
  | { kind: "unknown_stop" }                        // resume naming no open stop
  | { kind: "temporarily_unavailable" };
// Owner runtime result while stopped: append(...) → Stopped (RFC-006 §12.2), answered by owners as
// "temporarily unavailable".
```

```sql
-- Audit's table (written only by audit's role): the restore role's predicate.
CREATE TABLE audit.integrity_stops (
  kind          STRING NOT NULL,
  partition     BYTES  NOT NULL,
  detection_ref UUID   NOT NULL,
  opened_at     TIMESTAMPTZ NOT NULL,
  closed_at     TIMESTAMPTZ NULL,        -- set by audit before it sends integrity_resume (S-M5)
  PRIMARY KEY (kind, partition, detection_ref)
);
-- On every <kind>_log and <kind>_head: the restore role reaches only partitions with an open stop.
CREATE POLICY restore_only_stopped ON <kind>_log FOR ALL TO restore_role
  USING      (EXISTS (SELECT 1 FROM audit.integrity_stops s
                      WHERE s.kind = '<kind>' AND s.partition = partition AND s.closed_at IS NULL))
  WITH CHECK (EXISTS (SELECT 1 FROM audit.integrity_stops s
                      WHERE s.kind = '<kind>' AND s.partition = partition AND s.closed_at IS NULL));
-- restore_role: granted only inside a break-glass session (two approvers, break_glass_ttl 4 h) while
-- audit has an open stop; holds no application key; revoked at the session's end.
```

### §L. Webhook endpoints and signing secrets (RFC-005 C8, §8.3)

```ts
// Kafka topic "iam.endpoints.v1"; key = tenant; consumed by the notifier only.
type EndpointEvent = {
  schema: "iam.endpoints.v1";
  endpoint_id: EndpointId;
  tenant: Tenant;                    // account or supplier; never "none"
  version: number;                   // per endpoint; apply only higher
  committed_at: EpochMicros;
  body:
    | { kind: "registered" | "changed"; url: string /* https, port 443 */; notice_kinds: string[];
        secrets: WrappedSecret[] }
    | { kind: "rotated"; mode: "overlap" | "rotate_now"; secrets: WrappedSecret[] }
    | { kind: "removed" };
};
type WrappedSecret = {
  secret_id: string;
  wrapped: Bytes;                    // 32-byte secret wrapped under a key released only to the notifier
  key_ref: string;
  active_from: EpochMicros;
  sign_until: EpochMicros | null;    // previous secret after an overlap rotation: active_from + webhook_retry (24 h); null = current
};
// gRPC query, notifier → identity.
type GetEndpoint = { endpoint_id: EndpointId };
type GetEndpointAnswer = (EndpointEvent & { body: { kind: "registered" } }) | { kind: "not_found" }
                       | { kind: "temporarily_unavailable" };
```

### §M. Signed webhook (RFC-005 §8.3; RFC-006 §15)

```http
POST <endpoint url>                  (HTTPS, port 443, no redirects followed)
content-type: application/json
webhook-id: <delivery id>            (stable for every attempt of this delivery)
webhook-timestamp: <integer seconds since epoch, set afresh on every attempt>
webhook-signature: v1,<base64 HMAC-SHA256(secret, webhook-id "." webhook-timestamp "." body)>[ v1,<…under the previous secret>]

[ { "event_id": "<notice event identity>", "type": "<notice kind>", "occurred_at": <EpochMicros>, "data": { … } }, … ]
```

- Body: a JSON array of **1 … 100** notices, all of **one tenant** (the endpoint's), in
  stream order per reservation. `data` is defined by the source feed's contract (RFC-002
  outcome and lifecycle feeds, RFC-001 and RFC-004 supplier-facing feeds); it carries only
  its own event's fields, nothing about another tenant.
- Secret format given to the receiver: `whsec_` ‖ base64(32 bytes) (Standard Webhooks).
- Several signatures are space-separated; during an overlap rotation both are present for
  `webhook_retry` (24 h); after *rotate now* only the new one.

## Semantics per operation and message

### §A. Principal context and `decide`

- **Issued** by the edge only after authentication (RFC-005 §2.2), with the credential's
  tenant; sent only by an edge workload over mTLS, or by the console with an envelope.
- **Receiver preconditions**: the mTLS peer is on the allowlist for this command (RFC-005
  §4.4; an edge for external principals); `now ≤ expires_at`; for a tenant-scoped command,
  `tenant` is the partition's, else answer `not_found`; for a key, `key_record.signature`
  verifies under a certified, unrevoked identity record-signing key and `key_record.tenant`
  names the partition's account; the record's `limits` govern **this request only**
  (provisional, in memory) until the push or catch-up brings the key; a record whose key is
  applied as revoked, or whose `version` is lower than the applied one, is ignored.
- **Outcomes**: the receiver copies `principal`, `received_at`, `request_id`,
  `policy_version` and `iam_position` into the `audit` column of every row the command
  causes. It never widens what the context allows.
- **Errors**: an invalid context never reaches an effect; there is no fallback identity.
  Answers to the outside are those of RFC-005 §2.3: one `unauthenticated` (floor 5 ms after
  receipt), one `not_found` identical to a genuine miss, `refused(right)` only within the
  principal's own tenant (recorded by the owner), `temporarily unavailable` when the
  replica is stale.
- **`decide`** is pure: `deny` unless a matrix row permits; an owner that has a newer policy
  version than the context's decides with the newer one.

### §B. Identity status push and catch-up

- **Push**: every committed key or KYB entry produces one `IdentityStatusEvent` in the same
  transaction (outbox), published keyed by account; `IdentityStatusResolved` to every topic
  partition every 1 s.
- **Application** (consumer: RFC-004 Part A F4, read by RFC-002): an F4 entry **only for an
  actual status change**, idempotent by `source`; per key the highest `version` wins;
  `key_revoked` is terminal. On applying `key_revoked`, the booking module ends every
  undecided request of the key "key revoked" (P2-S72) and refuses later intakes with it as
  unauthenticated; decided requests are unchanged (P2-S103).
- **Freshness watermark** (consumer-owned, the **booking module's**, S-M6): per account
  slot, in the lease holder's memory,
  `iam_fresh = max( min over the identity-push topic partitions feeding the slot of the
  latest resolved timestamp applied, read_timestamp of the last catch-up )`, advanced by
  every resolved marker and every catch-up, event or not; never written to an entry;
  **unset after any takeover** until the first marker or catch-up. A confirm commits
  only if its `ts ≤ iam_fresh + 45 s`; unset fails the check.
- **`catch_up(account_slot, since)`**: identity answers by a consistent read at the present
  timestamp of every push event for accounts of the slot with `committed_at ≥ since`, and
  `read_timestamp` = that read's timestamp. Preconditions: caller is the account owner's
  workload. Called by a new lease holder **before deciding anything**, and by any holder
  when `now − iam_fresh > 20 s`, every 5 s until fresh. The answer is applied in one entry
  (none if no status change) and sets `iam_fresh` to `read_timestamp`.
- **`since` older than the 7-day retention** (S-G1): identity answers a `snapshot`, the
  current status of every key and the KYB status of every account of the slot from one
  consistent read, with its `position` (= `read_timestamp`). The caller applies it in one
  entry as the account's full applied state (F4 for each actual difference), sets
  `iam_fresh` to `position`, and resumes the push from there.
- **Errors**: `temporarily_unavailable` (retry at the pull period; the 45 s gate keeps the
  slot safe).
- **KYB** (C10): `kyb_status` events; the account owner records the applied KYB status with
  `iam_fresh` on each credit-limit check (refusal `kyb_not_vetted`, P4-S82).

### §C. Identity edge stream

- `edge_stream(identity_slot, from_position)` streams every `CredentialRecord` committed
  after `from_position` in commit order, then a `Heartbeat` every 1 s, each sent only after
  every record up to its `head`. A starting edge loads the latest `EdgeSnapshot` and
  streams from its position; it serves nothing until every slot is fresh.
- **Edge invariant**: per slot, `fresh_s` = `sent_at` of the last heartbeat whose head it
  has applied; a credential of slot s authenticates only while `now − fresh_s ≤ 30 s`
  (`edge_staleness_max`), otherwise "temporarily unavailable". The edge applies a record
  only if its `version` is higher than held (a replay or rollback is ignored and alerted),
  and verifies every signature under a certified, unrevoked key for (identity, slot, epoch).
- **Revocation**: on applying a revoked key, ended session, removed administrator right or
  revoked certificate, the edge closes every established connection and stream that the
  credential authenticated. Guarantee: a record committed at `t` is delivered, or every
  heartbeat after `t` is withheld, so the edge refuses the slot's credentials by `t + 31 s`.
- **Errors**: stream broken → reconnect from the last applied position; the 30 s invariant
  bounds what is served meanwhile.

### §D. Supplier visibility

- One call **per view**, never cached across views; identity reads the supplier's registry
  partition by a consistent read at the present timestamp and answers `reveal` (with its
  consent or disclosure basis) or `hide` per reservation, with `registry_timestamp`.
- A view started after a withdrawal is acknowledged hides the buyer (X1-S30). A disclosure
  reveals only within its scope and while `registry_timestamp` is before its end and any
  *disclosure ended* (X1-S35).
- **Caller obligations**: record `registry_timestamp` (and `order_ref` for a disclosure)
  with the view; on `temporarily_unavailable` or any error, serve the view with **every
  identity hidden** (references still shown); notices to suppliers never reveal identity.
- `unref` results are used only if the reservation has a leg on a link of the calling
  supplier; otherwise `not_found`, on the same path and timing as any miss.

### §E. Operator action envelope

An owner applies an operator command only if **all** hold, else answers `refused` with the
first failed check (and the console records the refusal):

1. it recomputes `digest` itself; `action_type` is one it accepts; `role` is the
   catalogue's role for it; `reason_code` is in its closed list;
2. each assertion verifies: `type` = `webauthn.get`, `challenge` = digest, `origin` = the
   signing client's registered origin, `rpIdHash` = SHA-256 of Share's operator RP ID, UP
   and UV flags set, signature valid under the credential's public key;
3. `operator_check` (§F, `consume: true`) answers for each signer: `role` = envelope
   `role`, `credential_status` = `active`, `unused` = true, and `cancelled` = false;
4. four-eyes actions: `approver` present, same role, `person` ≠ requester's `person`;
5. its own transaction timestamp ≤ `not_after − ε` (ε = `max_offset`, 100 ms);
6. `target_version` is current in its own state; for a **set-scoped** action instead:
   `member` = its own partition, the account is a member of the set in its own state, and
   it has not applied this `action_id` for this partition. **Membership** is the owner's
   own applied probe flag (RFC-004 F9 `excluded`); the signed slot-map version v is **not
   checked**, only recorded in the entry's `audit` (S-M1).

Then it applies the action in an entry carrying the envelope's fields in `audit`, and
answers `applied` with the row position. `withhold_notice` is accepted only on
`terminate_compliance` with `order_ref` and an approver; on any other type the owner
refuses `withhold_not_allowed`, except `terminate_network_abuse`, which takes effect with
the withhold request refused and recorded (X1-S36). Sending is synchronous and retried by
the console with the same `action_id` until answered. A **set-scoped** action is one
envelope per member under one `action_id`; a refused member is **not retried** under that
`action_id` (its assertions are consumed); a new signed action is needed. The action has
no four eyes (S-M2), and the notifier sends **one** out-of-band confirmation per
set-scoped action, with its counts of members applied and refused, not one per member.

### §F. Operator check and cancel

- **`operator_check`**, answered by identity in its operator partition at the present
  timestamp. With `consume: true` it consumes each `(credential_id, counter)` under the
  `action_id` or `grant_id` (a conditional entry on the digest's state: open → consumed);
  `unused` = false only if the pair is already consumed under **another** identifier;
  repeating the same call is idempotent (second and later members of a set-scoped action
  answer `unused` = true). A counter lower than the credential's highest seen is not refused
  but alerts workforce administration. Consumed pairs are kept 72 h (`approval_expiry`).
  `consume: false` is accepted only from the console's workload and consumes nothing.
- **`cancel`** is serialised with `operator_check` on the same digest: if open, it commits
  the cancellation and returns an identity-signed `receipt`, and every later check answers
  `cancelled` = true; if an owner's check has consumed it, it answers **`too_late`** with
  no receipt. For a set-scoped action, a cancel after the first member's check is
  `too_late` for the whole set. Only the action's requester may cancel (`not_requester`).
- **Unavailable**: owners and readers refuse the operator command or read (S4); nothing
  else is affected.

### §G. Target summary

The owner answers for one target, from its own state, signed by its summary-signing key
for (owner kind, slot, epoch), including the `target_version` it will re-check at apply.
The signing client verifies the signature (key service certification) and shows the
summary beside the action; the console cannot alter it. A request is authenticated by the
operator's **console session** (principal and role, `console_session` authority), is
unsigned, is accepted only from the console's workload, and the owner **appends it to
audit** (§J append: operator, role, target, time) before answering (S-G3); a read grant is
the alternative authority for a read's preparatory summary. `not_found` for an unknown target.
Owners that serve it: every owner that accepts operator actions (account owner, link
schedule owner and registry, catalogue, attribution, payouts, payments, identity and
access, placement); "Consumer obligations" lists each one's duties.

### §H. Read grant

The reader (reporting, status replicas, link owner, catalogue, audit query service,
personal-data store) verifies the grant's assertion by the §E rule 2 over the grant
digest, calls `operator_check` (`subject: grant`, `consume: true`) once per grant and then
every `operator_check_cache` (60 s) while the grant is in use, checks `now ≤ not_after`
and the role's right to the `read_type`, answers **only within the one target**, enforces
`operator_read_limit` per operator, and **appends the read to audit** (§J append: operator,
role, target, grant, time) **before answering**. Any failed check: refused with the
`ReadGrantRefusal`, and the refusal recorded.

### §I. Erasure-request intake and recovery objection

- **`record_erasure_request`**, edge only. Identity verifies the token itself (ES256
  signature, expiry, session active in **its own** state, a user principal, not a key,
  `principal_id` = `subject` if given), records the request in the subject's account or
  supplier partition with status *open*, and sets `requested_at` to its own commit, which
  starts `erasure_max` (30 days). Refusals (recorded, nothing erased): `key_principal`
  (agent or supplier key), `other_subject`, `invalid_token`. The console never records a
  user's own request.
- **`object_to_recovery`**, edge only. Identity verifies the token as above, that the
  principal is in the recovery's `prior_admins` and still an administrator, then commits
  `recovery_cancelled` in the account's serial order if the recovery is still in its hold
  (24 h). `recovery_cancelled` and `recovery_confirmed` are conditional entries of one
  partition: the first committed wins; an objection committed before `hold_until` always
  cancels. After the hold, or for an unknown recovery: `no_recovery_in_hold`. By any other
  user or a key, or a held administrator: `refused` (recorded).
- **`open_requests`**: read-only queue (status *held*, *to verify*, *open*, *executing*),
  oldest first.
- **Compliance-recorded requests**: by envelope only (§E); `requested_at` is identity's
  commit in every case; a legal-requirement action left pending records nothing and lapses
  at `approval_expiry`; without `order_ref` it is refused by the console and by identity.

### §J. Audit record

- **Owners**: every row of the kinds listed in the `AuditFields` comment carries the field set, sealed (C13); the
  owner runtime's `append` computes `chain` after sealing and before commit, in the batch
  transaction, recomputes it on every retry, writes the head's `chain`, and compares the
  head's `chain` with its own on every batch and on takeover; a mismatch stops the
  partition and raises an incident. No application role may update or delete a log row.
- **Audit changefeed**: per log table, the CDC projection of `AuditCdcEvent`, delete
  events included, resolved every 10 s, to `cdc.audit.<kind>`, consumed only by audit,
  which checks continuity, single sight of every key, deletes only at or below the
  sealed-through watermark, and keeps the first-seen `(seq, chain, ts)` and head.
- **Append**: `audit_append(source, source_ref, record)` → position, acknowledged once
  committed in audit's own chained log; idempotent by `source_ref`; never altered.
- **Readers** never accept an altered record or a gap: the audit query answers a broken
  range as "record altered or missing at partition p, sequences n … m, detected at t".

### §K. Integrity stop and resume

- On a detection, audit appends `integrity_violation(kind, partition, seq range, layer,
  detection_ref)`, opens its `integrity_stops` row, and sends `integrity_stop`. The runtime
  acknowledges `stopped` **once the stop is durable** in placement's `integrity_stops`
  projection (read by every holder on acquisition, resume and `adopt`, and pushed to the
  current holder). From then, under **every** lease holder, across takeovers and moves,
  `append` for the partition answers `Stopped`; owners answer callers "temporarily
  unavailable"; nothing is decided.
- The **restore role**, only in a break-glass session with two approvers, writes back
  stored ciphertext into partitions with an open stop (row-level security above), holds no
  application key, and is revoked at the session's end.
- Audit re-verifies the partition end to end and sends `integrity_resume` **only** if the
  chain re-verifies and the restored head equals **audit's first-seen head** (sequence and
  chain); otherwise the partition stays stopped, and a resume with lost rows happens only
  by a **recorded incident decision** (compliance and platform security), never
  automatically. Rows that cannot be recovered are never re-created.
- **Errors**: `unknown_stop` on a resume with no open stop (no effect); a stop for an
  already stopped `detection_ref` answers `stopped` again.

### §L. Webhook endpoints and secrets

- Registered, changed, removed and rotated only by an administrator of the tenant (RFC-005
  §3.2), refused for a held administrator during `recovery_hold` (register or change);
  registration validates the URL (HTTPS, port 443) and answers "endpoint not accepted"
  alike for every failure cause. The secret is shown once to the administrator.
- The notifier learns endpoints from the feed, unwraps secrets with the key service, keeps
  them **in memory only**, and may query one endpoint by identifier. It picks endpoints
  **only** by the event's tenant derived from the event's clear partition (account; or
  for link-partitioned topics, the link's supplier in the catalogue at the event's
  position), never from the payload.

### §M. Signed webhook

- **Notifier** (RFC-006): forms a delivery of up to 100 notices of **one** endpoint's
  tenant (checked again by the worker), **computes the HMAC itself**, in process, with the
  endpoint secret it holds in memory (no remote signing service, S-M3), **per attempt**
  with a fresh `webhook-timestamp`. A `webhook-id` names one fixed set of notices and is
  reused for every attempt of that set; notices regrouped on retry form a **new** delivery
  with a **new** `webhook-id` (S-M4). It resolves the host itself, accepts only global unicast addresses
  (RFC-005 §8.3 exclusion list), connects to the checked address, follows no redirects,
  from the dedicated egress. A notice is *told* when its delivery is **first attempted**
  (and it is in the notice list). Retries: exponential from 1 s, cap 1 h, jitter, for
  `webhook_retry` (24 h); connect timeout 2 s, response timeout 5 s.
- **Receiver** (buyer or supplier, X1-S11): recompute the HMAC with the secret Share gave,
  compare in constant time, reject a `webhook-timestamp` older than 5 min, deduplicate by
  `webhook-id` and **by each notice's `event_id`** (delivery is at least once).

## Delivery and ordering

| Mechanism | Guarantee | Partition key | Ordering scope |
|---|---|---|---|
| Identity status push | At least once; exactly-once effect by `source` | Account | Per account (commit order); resolved markers per topic partition |
| `catch_up` | Consistent read; at-least-once overlap with the push, deduplicated by `source` | — | Commit order within the answer |
| Edge stream | Every record after `from_position`, in commit order, or heartbeats withheld | Identity slot | Per slot |
| Endpoint feed | At least once; apply by `version` | Tenant | Per tenant |
| Audit changefeed | At least once (CDC), delete events included | Partition | Per partition |
| Operator commands, operator check, cancel, erasure intake, objection, integrity stop/resume, audit append | Synchronous; retried by the caller with the same identity until answered; exactly-once effect | — | Per action digest (check vs cancel serialised in identity's operator partition); per account (objection vs hold expiry) |
| Signed webhook | At least once per notice | Endpoint | Per reservation in stream order; a delivery waits only for its predecessor's first attempt to **start**; no order across requests |

## Idempotency

| Operation | Key | Duplicate | Same key, different content |
|---|---|---|---|
| Status push event (consumer) | (`identity_partition`, `seq`) | No effect; highest key `version` wins | Impossible (identity's log) |
| `catch_up` | — (a read) | Safe to repeat | — |
| Edge records | (record key, `version`) | Lower or equal version ignored, alerted if lower | — |
| Endpoint events | (`endpoint_id`, `version`) | Ignored | — |
| Administrator commands (identity) | (tenant, idempotency key), 24 h | First answer, **except a secret**: "secret already issued", never the secret | Refused, as a reuse of the key for a different command (POL-29 by analogy) |
| Operator envelope at an owner | `action_id`; set-scoped (`action_id`, partition) | The recorded answer | Digest differs under the same `action_id`: refused `digest_or_type`; a money-moving `action_id` is the source reference (POL-29, P4-S99): a different principal is refused |
| `operator_check` | (`action_id` or `grant_id`, (credential, counter)) | Idempotent, `unused` = true | Same pair under another identifier: `unused` = false |
| `cancel` | (`action_id`, digest) | Same receipt, or `too_late` | Digest not the action's: `refused unknown_action` |
| `record_erasure_request` | (subject, idempotency key), 24 h | The first `request_ref` and `requested_at` | `subject` differs from the first: `idempotency_key_reused` |
| `object_to_recovery` | (principal, idempotency key), 24 h | The first answer | Other `recovery_ref`: `idempotency_key_reused` |
| Compliance-recorded erasure | `action_id` | The first `request_ref` | As envelope |
| `integrity_stop` / `integrity_resume` | `detection_ref` | The same acknowledgement | Other `kind`/`partition` under one `detection_ref`: refused, alerted |
| `audit_append` | `source_ref` | The first position | Refused, alerted (records are never altered) |
| Signed webhook (receiver) | `event_id` per notice; `webhook-id` per delivery | Receiver ignores | — |

For administrator commands, erasure intake, objection and audit append, RFC-005 states
only the key; the "same key, different content" behaviour in those rows is this
contract's reading.

## Ownership

| Data | Writer | Readers |
|---|---|---|
| Principals, sessions, keys, rights, KYB as recorded, endpoints and secrets, erasure requests, recoveries, consent and disclosure registry, operator identities, roles, consumed assertions, cancellations, policy | Identity and access only (its own log tables, owner lease per identity slot) | Nobody by SQL (A1); through §B, §C, §D, §F, §I, §L only |
| Principal context | Edge | The receiving owner, for that request |
| Applied key and KYB status (F4) | Account owner (funds module) | Booking module |
| `iam_fresh` | Account owner (booking module), memory only | Itself |
| Envelope, approvals, console log | Operator console | Owners (the envelope), audit |
| Target summary | Each owner, of its own state | Signing client, via the console relay |
| `audit` column and `chain` | Each owner, through the owner runtime's `append` | Audit (changefeed, index), history (sealing), owners (replay) |
| Audit append log, `integrity_stops` (audit), sealed-through watermark | Audit only | Audit query service; the database for row-level security |
| Placement's `integrity_stops` projection | Owner runtime and placement on audit's command | Every lease holder |
| Restored log rows | Restore role (break-glass), stopped partitions only | Owners after resume |
| Endpoint feed contents | Identity | Notifier only (topic ACL); secret unwrap only by the notifier's workload |
| Webhook signature | Notifier, per attempt, with RFC-005's format | Receivers |

Topic ACLs: one producer (identity's relay) for `iam.status.v1` and `iam.endpoints.v1`; one
producer per kind for `cdc.audit.<kind>` and audit as its only consumer.

## Timeouts and deadlines

| Item | Value | Who enforces |
|---|---|---|
| `context_ttl` | 60 s from `received_at` | Receiver of a principal context |
| `unauth_floor` | Unauthenticated answers no earlier than 5 ms after receipt | Edge |
| `stream_heartbeat`; `edge_staleness_max` | 1 s; 30 s (worst case 31 s with clock offset) | Identity; edge |
| `snapshot_interval` | 10 min | Identity |
| `resolved_interval` | 1 s | Identity's relay |
| `iam_pull_after`; `iam_pull_period`; `iam_fresh_max` | 20 s; 5 s; 45 s | Account owner |
| Revocation bound | 60 s every credential (X1-N3, POL-25); alarm at 30 s staleness (`revocation_alarm`) | Edge, account owner; RFC-006 monitoring |
| `catch_up` retention | Events kept 7 days; older `since` answered by a snapshot | Identity (S-G1) |
| `approval_expiry` | 72 h (`not_after` = request time + 72 h); consumed pairs kept 72 h | Owners (check 5); identity |
| ε in check 5 | `max_offset`, 100 ms | Owners |
| `read_grant_ttl`; `operator_check_cache` | 1 h; 60 s | Readers |
| `recovery_hold` | 24 h | Identity |
| Erasure intake and objection idempotency; administrator commands | 24 h | Identity |
| `erasure_max` | 30 days from `requested_at` | Identity, compliance |
| Webhook: connect, response, retry, receiver tolerance | 2 s, 5 s, backoff 1 s … 1 h for 24 h, 5 min | Notifier; receiver |
| `break_glass_ttl` | 4 h | Platform security |
| Audit changefeed resolved; stall alarm; job watch | 10 s; 2 min; 10 s | RFC-006 relay; audit |
| `operator_check` per-call deadline | 500 ms (est.; confirm at C5); a miss is `temporarily_unavailable` → refuse the command or read (S4) | Owners, readers |
| `cancel` per-call deadline | 2 s (est.; confirm at C5); a miss shows no receipt, the signing client tells the operator to raise it | Signing client via console |
| `visibility` per-call deadline | 300 ms (est.; confirm at C5); a miss → every identity hidden in that view | Reporting, notifier, provisioning feed |
| `catch_up` per-call deadline | 2 s (est.; confirm at C5); a miss → retry at `iam_pull_period`; the 45 s gate keeps the slot safe | Account owner |
| `target_summary` per-call deadline | 2 s (est.; confirm at C5); a miss → the signing client shows nothing and nothing is signed | Console relay, signing client |
| `record_erasure_request`, `object_to_recovery` per-call deadline | 2 s (est.; confirm at C5); a miss → the user retries with the same idempotency key | Edge |
| `integrity_stop`/`integrity_resume` per-call deadline | 5 s (est.; confirm at C5); audit retries until acknowledged | Audit |

## Versioning and compatibility

- Every message carries `schema` with a major version (`principal.v1`, `iam.status.v1`,
  `operator-envelope.v1`, `audit.v1`, …); topics and gRPC services are named by major.
- **Additive changes** (a new optional field, a new event `body.kind`, a new refusal code,
  a new `action_type`) keep the major. Consumers ignore unknown fields; treat an unknown
  event kind as no status change (alerted); treat an unknown refusal as refused; owners
  refuse an `action_type` they do not know (`digest_or_type`).
- **Signed and digested structures** (key records, edge records, heartbeats, envelope
  digest, grant digest, cancel challenge, receipts, target summaries, chain): any change to
  their canonical bytes or domain strings is a **new major**, with the old one accepted
  for at least `approval_expiry` (72 h) for envelopes and grants, and for the chain never
  (the chain is `share-chain-v1` for the 7-year retention; a v2 would start at a new
  generation boundary, both verified).
- Policy versions (`policy_version`) change the permission matrix without changing this
  contract; every decision records the version it used.
- A producer upgrade is deployed before consumers rely on a new field; removal or
  renaming needs a new major run in parallel until every consumer has moved.

## Scenarios relied on

`requirements-v1.10`:

- **X1**: X1-S01, X1-S02, X1-S03, X1-S04, X1-S05, X1-S06, X1-S07, X1-S08, X1-S09, X1-S11,
  X1-S12, X1-S13, X1-S14, X1-S15, X1-S16, X1-S17, X1-S18, X1-S19, X1-S20, X1-S21, X1-S22,
  X1-S23, X1-S24, X1-S25, X1-S26, X1-S27, X1-S28, X1-S29, X1-S30, X1-S31, X1-S32, X1-S33,
  X1-S34 (audit records unchanged by erasure), X1-S35, X1-S36, X1-S37 (pseudonymous
  fields), X1-S38, X1-S39, X1-S40, X1-S41, X1-S42, X1-S43, X1-S44, X1-S45. Not relied on
  here: X1-S10 (C7), X1-S46 (C16).
- **P2**: P2-S09 (signed outcome webhook), P2-S64 and P2-S113 (principal identity for
  idempotency), P2-S72 and P2-S103 (revocation via the push).
- **P1**: P1-S75 (told with a down endpoint).
- **P4**: P4-S82 (KYB on the push before a credit limit), P4-S99 (`action_id` as source
  reference, principal compared).
- **X2**: X2-S24 (set-scoped probe credit limits).

## Conformance tests

Each side runs its own; "P" tests run against the provider with consumer doubles, "C"
tests against each consumer with a provider double that replays recorded provider
messages. Design tests of RFC-005 §15 (DT-n) and RFC-006 (DT-n) cited where they are the
same test.

**Provider (identity, console, audit, edge, signing library)**

| # | Test | Scenarios |
|---|---|---|
| P-01 | Golden vectors: JCS bytes, envelope digest, grant digest, cancel challenge, chain genesis and links (incl. after a move and a retried batch), webhook signature, under fixed inputs published with this contract | X1-S11, X1-S15 |
| P-02 | Every key and KYB commit yields exactly one `IdentityStatusEvent` with its `source`; resolved markers every 1 s on every partition with no traffic; `catch_up(slot, since)` returns every event with `committed_at ≥ since` and a `read_timestamp` ≥ every returned `committed_at` | X1-S06, P2-S72 |
| P-03 | Edge stream: no heartbeat whose `head` precedes an unsent record; with the stream cut just before a revocation at `t0`, an edge refuses the credential from `t0` + 31 s; each X1-S41 case closes connections (DT-1) | X1-S06, X1-S41 |
| P-04 | `visibility` after an acknowledged withdrawal hides, across a leaseholder move (DT-6); a disclosure reveals only its scope until its end (DT-18) | X1-S28, X1-S30, X1-S35 |
| P-05 | `operator_check`: same call twice → `unused` true both; same (credential, counter) under another `action_id` → false; lower counter accepted with an alert; `cancel` vs consuming check at every interleaving: exactly one of receipt or consume, later checks `cancelled` or `too_late` (DT-8) | X1-S26, X1-S32 |
| P-06 | `record_erasure_request`: a key → `key_principal`; another subject → `other_subject`; a console- or edge-supplied context without a valid token records nothing; retry with the same key returns the same `request_ref` and `requested_at` (DT-20, DT-27) | X1-S39, X1-S42 |
| P-07 | `object_to_recovery` vs hold expiry raced: exactly one of `recovery_cancelled` or `recovery_confirmed`; objections by a non-prior administrator, held administrator, key, after `hold_until` change nothing and are recorded (DT-26, DT-29) | X1-S40, X1-S44, X1-S45 |
| P-08 | Endpoint feed: register, overlap rotate, rotate now, remove produce events with increasing `version`; a held administrator's registration is refused; registration refusals are indistinguishable (DT-10) | X1-S18, X1-S24, X1-S40 |
| P-09 | Audit: an UPDATE or DELETE above the watermark through break-glass is detected from the changefeed before the next checkpoint; a query over the range answers "record altered or missing"; an `integrity_stop` is sent with a fresh `detection_ref` (DT-9, DT-31) | X1-S15 |
| P-10 | Audit sends `integrity_resume` only when the restored head equals the first-seen head; with a row lost, no resume is sent; its `integrity_stops` row is closed before the resume | X1-S15 |
| P-11 | Signing library: a delivery of 100 notices of one tenant verifies at a receiver double with the given secret; a body mixing tenants is refused by the library; both signatures present during overlap, one after rotate now | X1-S11, X1-S24 |

**Consumers**

| # | Side | Test | Scenarios |
|---|---|---|---|
| C-01 | Every owner | Contexts: expired, from a non-allowlisted peer, tenant ≠ partition, forged or lower-version key record → no effect (`not_found` or ignored), recorded where §A says; principal fields copied into `audit` (DT-4, DT-25) | X1-S02 … S05, X1-S07 |
| C-02 | Account owner (RFC-002/004) | Push event replayed and duplicated by catch-up → one F4; heartbeat-only traffic → no entry, `iam_fresh` advances; after takeover no confirm before the first marker or catch-up; with push and catch-up both silent, no confirm after `iam_fresh` + 45 s; revocation ends undecided requests "key revoked" and leaves decided ones (DT-1, DT-2) | X1-S06, P2-S72, P2-S103 |
| C-03 | Account owner | Credit limit refused `kyb_not_vetted` until a `kyb_status passed` is applied | P4-S82 |
| C-04 | Every owner that accepts operator actions | The DT-8 matrix: missing, reused, same-person, other-role assertion; wrong challenge, origin, `rpIdHash`, no UV; after `not_after − ε`; cancelled; stale `target_version`; a field changed after signing → refused with the named check; a four-eyes action with interleaved read grants (higher counters) → applied | X1-S12, X1-S13, X1-S26, X1-S31, X1-S32 |
| C-05 | Account owner | Set-scoped credit limit: one `action_id`, applied once per member, `member` ≠ partition → `out_of_scope`; a non-probe account → `out_of_scope` before `kyb_not_vetted`; a refused member not re-applied under the same `action_id` (DT-32; membership by own F9, even with placement past v, S-M1) | X2-S24 |
| C-06 | Account owner | `withhold_notice` accepted only on an approved compliance termination with `order_ref`; network-abuse termination proceeds with the withhold refused and recorded (DT-19) | X1-S17, X1-S36 |
| C-07 | Every owner with operator actions; placement | `target_summary` signature verifies under the certified summary key; its `target_version` is the one check 6 compares | X1-S32 |
| C-08 | Every reader (reporting, status replicas, link owner, catalogue, audit query, store) | No grant, expired grant, out-of-target read → refused and recorded; with a grant the reader's audit append commits before the answer (DT-24) | X1-S13, X1-S27, X1-S31 |
| C-09 | Reporting, notifier, provisioning feed | `visibility` unavailable → every identity hidden; no reuse of an answer across views; `registry_timestamp` recorded | X1-S28, X1-S30 |
| C-10 | Owner runtime (RFC-006) | `integrity_stop` → `Stopped` under every holder across a takeover and a move until `integrity_resume`; the restore role cannot write any partition without an open stop (DT-45, RFC-005 DT-31) | X1-S15 |
| C-11 | Owner runtime | Every committed log row's `chain` matches the golden recomputation; head `chain` mismatch stops the partition | X1-S15 |
| C-12 | Notifier (RFC-006) | Endpoint chosen from the event's clear partition only; deliveries ≤ 100 notices, one tenant; fresh timestamp per attempt; DNS-rebinding to a private address refused at delivery; down endpoint: first attempt within `affected_notice_time` (DT-10, DT-23) | X1-S11, X1-S24, P1-S75, P2-S09 |
| C-13 | Edge (RFC-005 §2.2) | Unauthenticated answers identical in bytes and timing class (DT-23, DT-3); stale slot → "temporarily unavailable"; erasure and objection forwarded with the user's token only | X1-S01 … S04 |

## Settled

The orchestrator's binding decisions on the mismatches (M) and gaps (G) raised in this
contract's first draft. The reading below is the contract; the RFC text that differs is an
erratum listed under "Consumer obligations".

| # | Point | Settled reading | Erratum |
|---|---|---|---|
| S-M1 | Set-scoped membership test (check 6) | RFC-005's: `member` = the owner's partition and the account's **own applied probe flag** (RFC-004 F9 `excluded`); the signed slot-map version v is recorded in `audit` (`set_version`) only, never checked (as C07 S1). `out_of_scope` before `kyb_not_vetted` | RFC-002 §7.3, §13.1; RFC-004 §A3, F5, §B12 drop "a member of the signed set at slot-map version v" |
| S-M2 | Four eyes on the set-scoped probe credit limit | None; one out-of-band confirmation per set-scoped action | RFC-006 §7.1 drops "four-eyes approval" (the requester's signing client shows placement's signed summary) |
| S-M3 | Who computes the webhook HMAC | The notifier, in process, with the secret it holds in memory, in RFC-005's format | RFC-006 §15 "signed by RFC-005's signing service" → "signed by the notifier in RFC-005's format" |
| S-M4 | `webhook-id` across retries | Reused for every attempt of one fixed notice set; a regrouped retry is a new delivery with a new `webhook-id`; receivers deduplicate per `event_id` | RFC-005 §8.3 "a retry carries the same notices under the same `webhook-id`" → as settled |
| S-M5 | Two `integrity_stops` stores | Audit's table is authoritative and the restore role's row-level-security predicate; placement's projection is what the runtime honours; audit **closes** its row before sending `integrity_resume` | RFC-005 §9.3 and RFC-006 §12.2, §14.3 state the ordering |
| S-M6 | Where `iam_fresh` lives | The booking module's, in owner memory: `max(min over the identity-push partitions feeding the slot of the latest resolved timestamp, last catch-up read timestamp)`; unset after takeover | RFC-005 C3 and §3.3 ("F4 keeps" / "funds module keeps") → booking module |
| S-G1 | `catch_up` with `since` older than retention | Answer a current-state `snapshot` of the slot's accounts with its `position` | RFC-005 C3 adds the snapshot answer |
| S-G2 | Owners' summary, check and reader duties | Listed per RFC under "Consumer obligations" | As listed there |
| S-G3 | Authority of a target-summary request | The operator's console session (principal and role), unsigned, audited by the owner | RFC-002 §13.1 "read grant or envelope request" → "console session, audited"; RFC-005 §7.3 states it |
| S-G4 | Per-call deadlines | Set in "Timeouts and deadlines", marked (est.), confirmed at C5 | — |

## Consumer obligations

Each owner's duties under this contract, per RFC; where the RFC does not yet say so, the
line is an **erratum** for that RFC (S-G2 and the settled points above).

| RFC | Component | Target summary (§G) | Operator check and envelope (§E, §F) | Read grant (§H) | Other | Erratum needed |
|---|---|---|---|---|---|---|
| RFC-001 rev. 5 | Link schedule owner; link registry | Serve for `link` targets (schedule, capacity, registration state; `target_version` = the link log's last sequence) | Verify envelopes for `record_outage`, `record_restoration`, `register_link`, `retire_link`; call `operator_check` at apply | Reader for `read_link_schedule`: verify, check every 60 s, audit append before answering | C1 receiver checks; `audit` field set; `Stopped` from the runtime | **Yes**: summary serving, `operator_check` at apply, read-grant reader duties are not stated (§11.1 names only principal, envelope, audit record) |
| RFC-002 rev. 5 | Account owner (booking); status replicas | Serve for `account` and `reservation` (stated, §13.1) | Verify for `act_at_documented_request`, `terminate_network_abuse`, `terminate_compliance`, `set_credit_limit`/`remove_credit_limit` incl. set-scoped (stated) | Status replicas as readers (stated, §8.2) | Own `iam_fresh` (S-M6); push and catch-up application incl. snapshot (S-G1) | **Yes**: S-M1 (drop the version-v membership test), S-G3 (summary authority), S-G1 snapshot handling |
| RFC-003 rev. 5 + 5.1 | Catalogue; rating; attribution and quarantine | Serve for `product_route`, split weights, partner terms, quarantine items | Verify for `set_price`, `set_split_weight` (four eyes), `record_partner_terms`, `correct_price`, `set_usage_rate_cap`, `attribute_quarantine`, `reverse_attribution`; call `operator_check` at apply | Catalogue as reader (preparatory reads); evidence reads via C09 | `audit` field set; `Stopped` | **Yes**: summary serving, `operator_check` at apply, read-grant duties not stated (§8 names only the envelope) |
| RFC-004 rev. 5 + 5.1 | Funds module (Part A); payments; payouts; reporting | Payouts (`payout`), payments (`reversal`) serve summaries; account summaries are RFC-002's | Verify for `set_credit_limit` (with RFC-002), `resolve_payout_escalation`, `resolve_reversal_escalation`; call `operator_check` at apply | Reporting as reader for `read_account`; reporting calls `visibility` per supplier view, hides all on failure, records `registry_timestamp` | Apply status push as F4 only for actual changes | **Yes**: S-M1 (§A3, F5, §B12); summary serving and `operator_check` for payouts and payments; reporting's read-grant and `visibility` duties |
| RFC-006 rev. 6 | Owner runtime; placement; notifier; provisioning feed; history | Placement serves `probeSetSummary(v)` and the region-disaster target (stated) | Placement verifies `declare_region_disaster`/`end_region_disaster` (four eyes) | — | Runtime: `chain`, audit changefeed, `integrity_stop`/`resume` → `Stopped` (stated); notifier: endpoint feed, HMAC per attempt, one tenant per delivery, new `webhook-id` on regroup; notifier and provisioning feed call `visibility`, hide on failure | **Yes**: S-M2 (§7.1), S-M3 and S-M4 (§15), S-M5 (§12.2, §14.3 ordering), `visibility` duties of notifier and provisioning feed |
| RFC-005 rev. 5 (provider) | Identity, console, audit, edge | — | — | Audit query service and personal-data store as readers (stated) | — | **Yes**: S-M4 (§8.3), S-M5 (§9.3), S-M6 (C3, §3.3), S-G1 (C3 snapshot), S-G3 (§7.3 session-authenticated, audited summary requests) |
