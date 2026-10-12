# C08. Identity and access

| | |
|---|---|
| Contract ID | C08 |
| Version | 1.1-draft (revised per [review 46](../../reviews/46-contract-C08-review.md)) |
| Status | **Draft, for fix verification of review 46.** Mismatches M1 … M6 and gaps G1 … G4 settled by the orchestrator (see "Settled"); review 46's findings applied (see "Review 46 resolution"); the RFC errata they imply are listed under "Consumer obligations" |
| Provider | Identity and access, with the operator console, audit and webhook signing (RFC-005 revision 5: §2, §3.1–§3.3, §3.6, §3.7 erasure requests, §3.8, §4, §6, §7, §8.3, §9, §10, §11 C1–C6, C8, C10, C14, C15); the **key service** (RFC-005 §10) for the key-certification stream (§N). Integrity stop: semantics RFC-005, honoured by RFC-006's owner runtime and placement |
| Consumers | **Edge gateway** (RFC-005 specifies it: C1 issuer, C14, erasure intake and recovery objection). **Account owner** (RFC-002 rev. 5 booking module; RFC-004 rev. 5 Part A funds module): C1, C2, C3 push and catch-up, envelope, operator check, target summary, read grant (status replicas), audit field set. **Link schedule owner and link registry** (RFC-001 rev. 5): C1, C2, envelope, operator check, target summary, read grant, audit field set. **Catalogue, rating, metering ingestion, attribution** (RFC-003 rev. 5 + erratum 5.1): C1, envelope, operator check, target summary, read grant, audit field set. **Payments, payouts, ledger, reconciliation, reporting** (RFC-004 rev. 5 + erratum 5.1): C1, envelope, operator check, target summary, read grant, audit field set, supplier visibility (reporting). **RFC-006 rev. 6**: owner runtime and placement (integrity stop and resume, restore role, `chain`, audit changefeed, placement's target summaries), notifier (endpoint feed and query, signed webhook, supplier visibility for supplier notices), history and retention (audit changefeed, sealed segments), provisioning feed (supplier visibility), status replicas (read grants). **Operator console** (RFC-005): envelope issuer, `cancel`, `open_requests`, target-summary relay. **Buyers and suppliers**: signed webhook receivers |
| Transport | In-process library: principal context, `decide`, reference functions. gRPC metadata over mTLS: principal context. **Kafka event** (from identity's transactional outbox through the changefeed relay, RFC-000 §5.5): identity status push, endpoint feed, policy feed; audit changefeed `cdc.audit.<kind>` (CDC projection). **gRPC query**: `catch_up`, `visibility`, `target_summary`, `open_requests`, `get_endpoint`, `get_policy`. **gRPC server stream**: `edge_stream`; `cert_stream` (key service). **gRPC command**: `operator_check`, `cancel`, `record_erasure_request`, `object_to_recovery`, every operator command carrying an envelope, `integrity_stop`, `integrity_resume`, `integrity_report`, `audit_append`. **Outbound HTTPS POST**: signed webhook. **No database read across owners** (RFC-000 A1): nobody reads identity's tables; the restore role's row-level-security predicate over audit's `integrity_stops` is a database-enforced policy, not an owner read |
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
8. **Distribution of what every verifier trusts**: the policy feed (matrix, catalogue,
   reason codes, allowlist, read types) and the key-certification stream (signing-key
   certificates and their revocations) (§N).

## Schema

Units: durations in **ms** unless named in s, h or days; timestamps as **epoch
microseconds UTC** (`EpochMicros`, a `bigint`, a decimal string in JSON), commit, resolved
and read timestamps being the database's HLC wall time **floored** to the microsecond;
money in **micro-USD** (`int64`); capacity in **Mbps** (`int64`); rates per second. Every
identifier is pseudonymous (A11): no field of this contract carries a name, e-mail address,
phone number or document. Byte strings are base64url without padding in JSON. Field names
are the wire names; protobuf messages mirror these types one to one. **One exception**: in
the outbound webhook body (§M), `occurred_at` is a JSON **integer** of epoch microseconds
(below 2⁵³ until about the year 2255), for receivers' convenience (review 46 D4).

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
type IdentitySlot = number;          // 0 … iam_slots − 1 (256, est., RFC-005 §13)
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
type PolicyVersion = number;        // the version of an applied PolicyBundle (§N)

type Ed25519Signature = {            // identity record-signing key or owner summary-signing key
  key_id: string;                    // names the certified key (below)
  sig: Bytes;                        // 64 bytes over the canonical bytes of the signed object
};

// A record-signing or summary-signing key, certified by the key service per lease epoch (RFC-005 §10).
// Delivered, with its revocations, only on the key-certification stream (§N). A certificate carries
// no revocation flag of its own: revocation is a separate signed message on that stream.
type SigningKeyCert = {
  key_id: string;
  purpose: "identity_record" | "owner_summary" | "placement_summary";
  owner_kind: string;                // "identity" for record keys
  slot: number;                      // must equal the signed object's slot
  epoch: string;                     // int64 lease epoch; epochs are monotonic per (owner_kind, slot)
  public_key: Bytes;                 // 32 bytes
  not_before: EpochMicros;
  not_after: EpochMicros;            // not_before + cert_validity (24 h, est.); renewed while the epoch lasts
  key_service_sig: Bytes;            // under the key-service certification root, domain "share-key-cert-v1"
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
  identity_slot: IdentitySlot;       // slot_of(key_id) = this; must equal route("identity", tenant).slot
  epoch: string;                     // the lease epoch whose certificate signed it
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
declare function decide(ctx: PrincipalContext, op: Operation, res: Resource, policy: PolicyBundle): Decision;

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
  actor:
    | { kind: "administrator"; principal_id: PrincipalId }
    | { kind: "onboarding" }
    | { kind: "share_security"; reason: "secret_leak_report" | "credential_compromise" }
    | { kind: "recovery"; recovery_ref: RecoveryRef }      // rights or keys changed by a recovery's cancel
    | { kind: "workforce_administration" }
    | { kind: "operator"; principal_id: PrincipalId; action_id: ActionId };
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
// since omitted: a new lease holder (iam_fresh unset) → always a snapshot (R46-07).
// since = the caller's iam_fresh (inclusive): a running holder → events, or a snapshot if older than retention.
type CatchUpRequest = { account_slot: AccountSlot; since?: EpochMicros };
type CatchUpAnswer =
  | { kind: "events"; events: IdentityStatusEvent[]; read_timestamp: EpochMicros }
  | { kind: "snapshot";                                          // no since, or since older than the 7-day retention (S-G1)
      state: { account: AccountId;
               keys: { key_id: KeyId; version: number; status: "active" | "revoked"; limits: KeyLimits; probe: boolean }[];  // every key not yet past revocation retention
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
  epoch: string;                     // the lease epoch that committed it; its certificate signs it
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
  epoch: string;                     // the sender's lease epoch
  head: string;                      // int64 position, returned by the read below
  sent_at: EpochMicros;              // the HLC timestamp of the consistent read of the slot's head row that
                                     // returned head: every record committed at or before sent_at has position ≤ head
  signature: Ed25519Signature;       // domain "share-edge-heartbeat-v1", under the certificate of epoch
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
  | { kind: "set"; set: SetDescriptor }
  // R46-09 (names to be confirmed with RFC-003 and RFC-004 at C5; the JCS bytes are fixed here):
  | { kind: "account_product"; account: AccountId; product: string }          // set_usage_rate_cap; catalogue
  | { kind: "supplier_terms"; supplier: SupplierId; product?: string }       // set_split_weight; catalogue
  | { kind: "partner"; partner_link: string }                                // record_partner_terms; catalogue
  | { kind: "charge"; account: AccountId; charge_id: Id128 }                 // correct_price; catalogue and rating
  | { kind: "quarantine_item"; item_id: Id128 };                             // attribute_quarantine, reverse_attribution

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
  | { kind: "applied"; position: { partition: string; seq: string };
      result?: { request_ref: RequestRef; requested_at: EpochMicros } }   // compliance-recorded erasure requests
  | { kind: "refused"; check: EnvelopeCheck }
  | { kind: "refused_by_rule"; rule: string }      // an owner's own rule after a valid envelope (e.g. kyb_not_vetted)
  | { kind: "temporarily_unavailable" };           // operator check unreachable, partition Stopped or Moving

type EnvelopeCheck =
  | "digest_or_type"        // check 1: recomputed digest, action type accepted, role, reason code
  | "assertion"             // check 2: WebAuthn rules
  | "operator_check"        // check 3: role now, credential active, unused, not cancelled
  | "four_eyes"             // check 4: approver same role, different person
  | "not_after"             // check 5: own ts > not_after − ε, or not_after > own ts + approval_expiry + ε
  | "target_version"        // check 6: stale target_version
  | "out_of_scope"          // check 6: target not in this partition; set-scoped: member not this partition or not a member
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
| `set_split_weight` (target `supplier_terms`) | commercial | **yes** | catalogue |
| `record_partner_terms` (target `partner`) | commercial | no | catalogue |
| `register_link`, `retire_link` | commercial | no | link registry (and link owner for retire) |
| `correct_price` (target `charge`) | finance | no | catalogue and rating |
| `attribute_quarantine`, `reverse_attribution` (target `quarantine_item`) | finance | no | attribution and quarantine |
| `set_credit_limit`, `remove_credit_limit` | finance | no | account owner |
| `set_credit_limit` with target `set` | finance | no (S-M2) | each member's account owner, one envelope per member |
| `set_usage_rate_cap` (target `account_product`) | finance | no | catalogue |
| `resolve_payout_escalation` | finance | no | payouts |
| `resolve_reversal_escalation` | finance | no | payments |
| `terminate_compliance` (optional `withhold_notice` with `order_ref`) | compliance | **yes** | account owner |
| `disclose_identity` | compliance | **yes** | identity and access (registry) |
| `end_disclosure` | compliance | no | identity and access |
| `record_non_user_erasure_request` | compliance | no | identity and access |
| `refuse_erasure_request` | compliance | no | identity and access |
| `open_legal_requirement_erasure` (`order_ref` required) | compliance | **yes** | identity and access |
| `erase` (cites `request_ref`; non-user: `verification_note_ref`) | compliance | no | identity and access |

Read types (§H) are a **closed list carried in the policy bundle** (`read_types`, §N), each
with its role and target kinds: `read_account` (support), `read_link_schedule`
(network_operations), `read_audit` (compliance), and one `prep_<action_type>` per action,
in that action's role and with its target kind. The table above is the policy at version 1;
later versions change it through the policy feed without changing this contract.

### §F. Operator check and cancellation (RFC-005 C15)

```ts
// Identity is the only source of each operator credential's public key and of its binding to one
// operator (registered by workforce administration, RFC-005 §7.1). Nobody else stores operator keys.
type OperatorCheckRequest = {
  subject: { kind: "action"; action_id: ActionId } | { kind: "grant"; grant_id: GrantId };
  digest: Bytes;                     // 32 bytes, recomputed by the caller
  signers: { operator: PrincipalId; assertion: WebAuthnAssertion }[];   // the full assertions (R46-01)
  consume: boolean;                  // true for owners and readers; false only from the console (approval-time read)
};
type OperatorCheckAnswer =
  | { kind: "answer";
      per_signer: { operator: PrincipalId;
                    credential_id: Bytes;
                    assertion: "valid" | "invalid";       // identity's own verification, before any consumption
                    public_key: Bytes;                     // COSE_Key bytes, so the caller re-verifies (check 2)
                    alg: number;                           // COSE algorithm identifier (-7 ES256, -8 EdDSA)
                    registered_origin: string;             // the signing client's origin for this credential
                    role: OperatorRole | null; person: PersonId;
                    credential_status: "active" | "revoked" | "unknown";   // unknown unless registered TO operator
                    counter: number;                       // from authenticator_data
                    unused: boolean }[];                   // false iff (credential, counter) consumed under ANOTHER identifier
      cancelled: boolean;
      checked_at: EpochMicros }
  | { kind: "digest_conflict" }                    // the action_id is bound to a different digest at identity
  | { kind: "temporarily_unavailable" };           // callers refuse (S4)

type CancelRequest = {
  action: CanonicalAction;           // identity recomputes the digest from these three
  role: OperatorRole;
  not_after: EpochMicros;
  requester_original: Signer;        // the requester's assertion over the action's digest
  cancel_assertion: Signer;          // challenge = SHA-256( E("share-cancel-v1") ‖ E(digest) ); same person
};
type CancelAnswer =
  | { kind: "receipt"; action_id: ActionId; digest: Bytes; cancelled_at: EpochMicros;
      signature: Ed25519Signature }                // identity-signed, domain "share-cancel-receipt-v1"
  | { kind: "too_late" }                           // "already applied or applying"; no receipt
  | { kind: "refused"; check: "assertion" | "not_requester" | "digest_conflict" }
  | { kind: "temporarily_unavailable" };
```

### §G. Target summary (RFC-005 C4, §7.3)

```ts
type TargetSummaryRequest = {
  target: Target;
  authority:
    | { kind: "read_grant"; grant: ReadGrant }
    | { kind: "console_session"; operator: PrincipalId; role: OperatorRole; session_id: SessionId;
        action_id: ActionId; action_type: ActionType };     // S-G3 with D3: unsigned, purpose-bound, audited
};
type SignedTargetSummary = {
  owner_kind: string; slot: number; epoch: string;
  target: Target;
  target_version: string;                      // the version the owner re-checks at apply (check 6)
  body: unknown;                               // owner-specific (below)
  as_of: EpochMicros;
  signature: Ed25519Signature;                 // owner summary-signing key, domain "share-target-summary-v1"
};
type TargetSummaryAnswer = SignedTargetSummary | { kind: "not_found" }
  | { kind: "refused"; reason: "target_kind_mismatch" | "role_mismatch" | "read_limit" | "read_grant" }
  | { kind: "temporarily_unavailable" };
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
  read_type: string;                 // one of the policy bundle's read_types (§N)
  target: Target                     // exactly one target
        | { kind: "subject"; subject: PrincipalId }
        | { kind: "payload"; record_id: unknown }       // C09 RecordId
        | { kind: "audit_scope"; scope: unknown };
  reason: string;                    // reason code
  not_after: EpochMicros;            // signing time + read_grant_ttl (1 h)
  webauthn: { credential_id: Bytes; authenticator_data: Bytes; client_data_json: Bytes; signature: Bytes };
};
// grant digest = SHA-256( E("share-read-grant-v2") ‖ E(grant_id) ‖ E(operator) ‖ E(read_type) ‖ E(JCS(target))
//                         ‖ E(role) ‖ E(reason) ‖ U64(not_after) )      // v2 adds E(operator) (R46-01)

type ReadGrantRefusal = "assertion" | "operator_check" | "not_after" | "target_out_of_grant"
                      | "read_limit" | "role_not_allowed" | "unknown_read_type";
```

### §I. Erasure-request intake and recovery objection (RFC-000 §8; RFC-005 §3.7, §3.8, C12)

```ts
// edge → identity, gRPC, with the user's principal context (C1) and its access token.
type RecordErasureRequest = {
  context: PrincipalContext;
  access_token: string;              // the ES256 JWT, verified by identity itself
  idempotency_key: string;           // ≤ 255 bytes
  subject?: PrincipalId;             // if present must equal the token's principal_id (else other_subject);
                                     // context.principal_id must equal the token's principal_id (else invalid_token)
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
`EnvelopeAnswer`, with `applied.result` carrying `{ request_ref, requested_at }` for the first two.

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

// Audit append (non-owner sources and readers of read grants), gRPC → audit. Caller allowlist (§J):
// readers of read grants and summary-serving owners, console, edge, notifier, secrets service, key service,
// personal-data store, identity, break-glass and database audit channels (RFC-005 §4.4).
// `source` is NOT a payload field: audit sets it from the caller's mTLS workload identity (R46-11).
type AuditAppend = { source_ref: string; record: AuditFields & { event: string } };
type AuditAppendAnswer = { kind: "appended"; source: string; position: { partition: string; seq: string } }
                       | { kind: "refused"; reason: "caller_not_allowed" | "source_ref_conflict" }   // conflict paged to security
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
type IntegrityStop   = { kind: string /* owner kind name */; partition: Bytes; detection_ref: DetectionRef };
type IntegrityResume = { kind: string; partition: Bytes; detection_ref: DetectionRef;
                         checkpoint: { root: Bytes; at: EpochMicros } };   // the checkpoint re-verified against
// owner runtime → audit, gRPC (R46-12): the runtime never stops on its own authority; it reports and
// holds the partition locally (append refused, answered "temporarily unavailable") until audit's stop is acked.
type IntegrityReport = { kind: string; partition: Bytes; seq: string;
                         observed_chain: Bytes; expected_chain: Bytes; reporter: "batch_head_check" | "takeover_replay" };
type IntegrityReportAnswer = { kind: "accepted"; detection_ref: DetectionRef } | { kind: "temporarily_unavailable" };
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
-- owner_kind is the owner kind NAME (e.g. 'account'), distinct from the numeric row kind of AuditCdcEvent.kind.
CREATE TABLE audit.integrity_stops (
  owner_kind      STRING   NOT NULL,
  partition       BYTES    NOT NULL,
  detection_ref   BYTES    NOT NULL CHECK (length(detection_ref) = 16),   -- DetectionRef (Id128)
  opened_at       TIMESTAMPTZ NOT NULL,
  acknowledged_at TIMESTAMPTZ NULL,      -- set when the runtime answers `stopped`; required by the policy (R46-18)
  closed_at       TIMESTAMPTZ NULL,      -- set by audit BEFORE it sends integrity_resume (S-M5)
  PRIMARY KEY (owner_kind, partition, detection_ref)
);
GRANT SELECT ON audit.integrity_stops TO restore_role;   -- needed by the policy subquery; nothing else

-- For every owner kind <kind>, on <kind>_log AND <kind>_head (names fully qualified, R46-02):
ALTER TABLE <kind>_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE <kind>_log  FORCE  ROW LEVEL SECURITY;      -- applies to the table owner too
ALTER TABLE <kind>_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE <kind>_head FORCE  ROW LEVEL SECURITY;

CREATE POLICY restore_only_stopped ON <kind>_log FOR ALL TO restore_role
  USING      (EXISTS (SELECT 1 FROM audit.integrity_stops s
                      WHERE s.owner_kind = '<kind>'
                        AND s.partition = <kind>_log.partition
                        AND s.acknowledged_at IS NOT NULL AND s.closed_at IS NULL))
  WITH CHECK (EXISTS (SELECT 1 FROM audit.integrity_stops s
                      WHERE s.owner_kind = '<kind>'
                        AND s.partition = <kind>_log.partition
                        AND s.acknowledged_at IS NOT NULL AND s.closed_at IS NULL));

CREATE POLICY restore_only_stopped ON <kind>_head FOR ALL TO restore_role
  USING      (EXISTS (SELECT 1 FROM audit.integrity_stops s
                      WHERE s.owner_kind = '<kind>'
                        AND s.partition = <kind>_head.partition
                        AND s.acknowledged_at IS NOT NULL AND s.closed_at IS NULL))
  WITH CHECK (EXISTS (SELECT 1 FROM audit.integrity_stops s
                      WHERE s.owner_kind = '<kind>'
                        AND s.partition = <kind>_head.partition
                        AND s.acknowledged_at IS NOT NULL AND s.closed_at IS NULL));

-- restore_role: SELECT, INSERT, UPDATE, DELETE on <kind>_log and <kind>_head only, granted only inside a
-- break-glass session (two approvers, break_glass_ttl 4 h) while audit has an open, acknowledged stop;
-- holds no application key; revoked at the session's end. Every other role's policies are unchanged
-- (application roles: insert-only on logs; the truncation role: its watermark policy, RFC-006 §13.2).
```

### §L. Webhook endpoints and signing secrets (RFC-005 C8, §8.3)

```ts
// Kafka topic "iam.endpoints.v1"; key = tenant; payload sealed under the topic's feed key (C13);
// consumed by the notifier only.
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
  wrapped: Bytes;                    // 32-byte secret wrapped under a key released only to the notifier's
                                     // delivery-worker workload (R46-19)
  key_ref: string;
  active_from: EpochMicros;
  sign_until: EpochMicros | null;    // previous secret after an overlap rotation: the NEW secret's active_from
                                     // + webhook_retry (24 h); after rotate now: the new secret's active_from; null = current
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
webhook-id: <delivery id>            (stable for every attempt of this fixed notice set; for a delivery of one notice, = its event_id)
webhook-timestamp: <integer seconds since epoch, set afresh on every attempt>
webhook-signature: v1,<base64 HMAC-SHA256(secret, webhook-id "." webhook-timestamp "." body)>[ v1,<…under the previous secret>]

[ { "event_id": "<notice event identity>", "type": "<notice kind>", "occurred_at": <integer epoch µs>, "data": { … } }, … ]
```

- Body: a JSON array of **1 … 100** notices, all of **one tenant** (the endpoint's), in
  stream order per reservation. `data` is defined by the source feed's contract (RFC-002
  outcome and lifecycle feeds, RFC-001 and RFC-004 supplier-facing feeds); it carries only
  its own event's fields, nothing about another tenant.
- Secret format given to the receiver: `whsec_` ‖ base64(32 bytes) (Standard Webhooks).
- Several signatures are space-separated; during an overlap rotation both are present for
  `webhook_retry` (24 h); after *rotate now* only the new one.

### §N. Policy feed and key-certification stream (R46-04, R46-05; AR46-2)

```ts
// Identity's policy partition → edge, every owner, readers, console. Kafka topic "iam.policy.v1" (one key,
// "policy"), sealed (C13); plus gRPC get_policy(version) for start-up and gaps. Identity-signed.
type PolicyBundle = {
  schema: "iam.policy.v1";
  policy_version: number;            // strictly increasing
  matrix: { operation: Operation;    // RFC-005 §4.2 rows
            allow: { principal_kind: PrincipalKind; requires_administrator?: boolean;
                     scope: "own_tenant" | "own_key" | "probe_links_only" | "own_supplier_links" }[];
            refused_recorded: PrincipalKind[] }[];                 // kinds answered refused(right), recorded
  catalogue: { action_type: ActionType; role: OperatorRole; four_eyes: boolean;
               receiver: string /* owner kind */; target_kinds: string[];
               reason_codes: string[]; flags_allowed: string[] }[];
  read_types: { read_type: string; role: OperatorRole; target_kinds: string[]; reader: string[] }[];
  allowlist: { receiver: string; command: string; callers: string[] /* workload identities */ }[];
  limits: { operator_read_limit_per_h: number; breadth_alert_targets_per_h: number };
  committed_at: EpochMicros;
  signature: Ed25519Signature;       // identity record-signing key of the policy partition's slot,
                                     // domain "share-policy-v1"; matrix_digest = SHA-256(JCS(bundle without signature))
};
type GetPolicy = { version?: number };            // omitted = latest
type GetPolicyAnswer = PolicyBundle | { kind: "not_found" } | { kind: "temporarily_unavailable" };

// Key service → edge, every owner, readers, console signing client: gRPC server stream over mTLS.
type CertStreamRequest = { from_position: string };   // "0" = from the latest snapshot
type CertStreamMessage =
  | { cert: SigningKeyCert; position: string }
  | { revocation: { key_id: string; revoked_at: EpochMicros; reason: string;
                    key_service_sig: Bytes /* domain "share-key-revoke-v1" */ }; position: string }
  | { heartbeat: { head: string; sent_at: EpochMicros; key_service_sig: Bytes /* "share-cert-heartbeat-v1" */ } };
// The certification root's public key is installed in every receiver's image; root rotation is a new major.
```

## Semantics per operation and message

### §A. Principal context and `decide`

- **Issued** by the edge only after authentication (RFC-005 §2.2), with the credential's
  tenant; sent only by an edge workload over mTLS, or by the console with an envelope.
- **Receiver preconditions**: the mTLS peer is on the allowlist for this command (RFC-005
  §4.4; an edge for external principals); `now ≤ expires_at`; for a tenant-scoped command,
  `tenant` is the partition's, else answer `not_found`; for a key, `key_record.signature`
  verifies under the certificate of (`identity`, `key_record.identity_slot`,
  `key_record.epoch`) from the key-certification stream (§N: unexpired, unrevoked, slot
  equal to `route("identity", tenant).slot`), and `key_record.tenant` names the
  **partition's tenant** (the account for an agent key, the supplier for a supplier key); the record's `limits` govern **this request only**
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
- **`decide`** is pure over a `PolicyBundle` (§N): `deny` unless a matrix row permits; an
  owner that has a newer policy version than the context's decides with the newer one; a
  receiver that has **not yet applied** the context's `policy_version` answers "temporarily
  unavailable" (it fetches the bundle with `get_policy`), never deciding with an older one.

### §B. Identity status push and catch-up

- **Push**: every committed key or KYB entry produces one `IdentityStatusEvent` in the same
  transaction (outbox), published keyed by account; `IdentityStatusResolved` to every topic
  partition every 1 s.
- **Application** (consumer: RFC-004 Part A F4, read by RFC-002): an F4 entry **only for an
  actual status change**. The **only** dedupe rule is: an event whose `source` was already
  applied is ignored; otherwise per key the highest `version` wins and per account the
  highest KYB `version` wins. `committed_at` is **not unique** (one identity batch commits
  several events at one timestamp) and is never a dedupe key (R46-08; the RFC-004 `id_ts`
  skip rule is withdrawn, as in C05);
  `key_revoked` is terminal. On applying `key_revoked`, the booking module ends every
  undecided request of the key "key revoked" (P2-S72) and refuses later intakes with it as
  unauthenticated; decided requests are unchanged (P2-S103).
- **Freshness watermark** (consumer-owned, the **booking module's**, S-M6): per account
  slot, in the lease holder's memory,
  `iam_fresh = max( min over the identity-push topic partitions feeding the slot of the
  latest resolved timestamp applied, read_timestamp of the last catch-up )`, advanced by
  every resolved marker and every catch-up, event or not; never written to an entry;
  **unset after any takeover** until the first marker or catch-up. **Applied-only rule**
  (as C05): a resolved marker on a topic partition counts toward `iam_fresh` only once
  every event at or below it on that partition has been committed as F4 or found to be no
  change, never when the marker is merely read. A confirm commits
  only if its `ts ≤ iam_fresh + 45 s`; unset fails the check.
- **`catch_up(account_slot, since?)`**: identity answers by a consistent read at the present
  timestamp; `read_timestamp` = that read's timestamp. Preconditions: caller is the account
  owner's workload. **`since` is defined** (R46-07): a **new lease holder** (`iam_fresh`
  unset) calls **without** `since` and always receives a `snapshot`, before deciding
  anything (about 6 accounts a slot, est., so the answer is small); a **running holder**
  with `iam_fresh` set calls with `since = iam_fresh` (inclusive) and receives every push
  event of the slot's accounts with `committed_at ≥ since`, when `now − iam_fresh > 20 s`,
  every 5 s until fresh. Every event at or below `iam_fresh` is already applied (applied-only
  rule), so nothing between the two paths is skipped. The answer is applied in one entry
  (none if no status change) and sets `iam_fresh` to `read_timestamp`.
- **Snapshot** (S-G1, and every new holder): the current status of every key and the KYB
  status of every account of the slot from one consistent read, with its `position`
  (= `read_timestamp`); also answered when `since` is older than the 7-day retention. The
  funds module (F4) applies it in one entry as each account's full applied state (an F4 for
  each actual difference, keys absent from the snapshot unchanged), the booking module sets
  `iam_fresh` to `position`, and push events at or below `position` are then no-ops by the
  version rule.
- **Errors**: `temporarily_unavailable` (retry at the pull period; the 45 s gate keeps the
  slot safe).
- **KYB** (C10): `kyb_status` events; the account owner records the applied KYB status with
  `iam_fresh` on each credit-limit check (refusal `kyb_not_vetted`, P4-S82).

### §C. Identity edge stream

- `edge_stream(identity_slot, from_position)` streams every `CredentialRecord` committed
  after `from_position` in commit order, then a `Heartbeat` every 1 s, each sent only after
  every record up to its `head`. A starting edge loads the latest `EdgeSnapshot` and
  streams from its position; it serves nothing until every slot is fresh.
- **Heartbeat fencing** (R46-03): `sent_at` is the HLC timestamp of the consistent read of
  the slot's head row that returned `head`, so every record committed at or before
  `sent_at` has position ≤ `head`. A heartbeat is sent only while the sender holds the
  slot's lease, and only if `sent_at` < its lease expiry − `max_offset`; a holder that cannot
  read the head row (paused, partitioned, deposed) sends nothing.
- **Edge invariant**: per slot, `fresh_s` = `sent_at` of the last heartbeat whose head it
  has applied; a credential of slot s authenticates only while `now − fresh_s ≤ 30 s`
  (`edge_staleness_max`), otherwise "temporarily unavailable". The edge rejects and alerts
  on a heartbeat whose `sent_at` is lower than one already applied for the slot, or whose
  `epoch` is older than one already seen for the slot. It applies a record only if its
  `version` is higher than held (a replay or rollback is ignored and alerted), and only
  under the certificate of the record's own `epoch` (§N; epochs monotonic per slot), never
  a record of an epoch older than one it has applied at a lower position.
- **Certificates** (R46-04): every signature (records, heartbeats, snapshots, key records in
  contexts, target summaries, cancel receipts, policy bundles) verifies only under a
  certificate from the key-certification stream (§N) that is within `not_before …
  not_after`, not revoked, and whose `slot` equals the signed object's slot. A receiver
  refuses objects under a revoked certificate as soon as it applies the revocation, and
  refuses **every** object under any certificate once its last cert-stream heartbeat is
  older than `edge_staleness_max` (30 s), so a revocation takes effect everywhere within
  31 s. `slot_of(key_id)` is the `identity_slot` of the key's edge record (edge) or of the
  key record in the context (owners), which must equal `route("identity", tenant).slot`.
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
  identity hidden** (references still shown). Notices to suppliers never reveal identity,
  so the **notifier does not call `visibility`** (R46-22); callers are reporting and the
  provisioning feed.
- `unref` results are used only if the reservation has a leg on a link of the calling
  supplier; otherwise `not_found`, on the same path and timing as any miss.

### §E. Operator action envelope

An owner applies an operator command only if **all** checks hold, else answers `refused`
with the failed check, numbered as below (the owner records the refusal, §Idempotency,
and the console records it too). The checks are numbered by the catalogue but **run in
this order**, so local checks never burn assertions (R46-13): 1, 4 (on the envelope's
fields), 5, the partition test of 6, then 3 (the call to identity), then 2, then 4 again
(on identity's answer), then the `target_version` test of 6 (re-read at apply).

1. it recomputes `digest` itself; `action_type` is one it accepts in its applied policy
   bundle (§N); `role` is the catalogue's role for it; `reason_code` is in its closed list;
2. each assertion verifies **under the `public_key`, `alg` and `registered_origin` that
   identity returned for that signer in check 3**: `type` = `webauthn.get`, `challenge` =
   digest, `origin` = `registered_origin`, `rpIdHash` = SHA-256 of Share's operator RP ID,
   UP and UV flags set, signature valid. The owner never takes a key from the envelope.
   Identity has verified the same assertion before consuming (§F), so a forgery needs both
   identity and the owner to be compromised (review 46 D1);
3. `operator_check` (§F, `consume: true`, the full assertions) answers for each signer:
   `assertion` = `valid`, `credential_status` = `active` (registered **to that
   operator**), `role` = envelope `role`, `unused` = true, and `cancelled` = false; a
   `digest_conflict` answer fails this check;
4. four-eyes actions: `approver` present, same role, `person` ≠ requester's `person`, using
   identity's `person` and `role` per signer (and the envelope's values beforehand, which
   must agree);
5. its own transaction timestamp ≤ `not_after − ε` (ε = `max_offset`, 100 ms), and
   `not_after` ≤ its own timestamp + `approval_expiry` (72 h) + ε (upper bound, D5);
6. the target lies in its own partition (else `out_of_scope`), and `target_version` is
   current in its own state; for a **set-scoped** action instead:
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

- **Key source** (R46-01): identity is the only holder of each operator credential's
  public key, algorithm, registered origin and binding to one operator and person
  (registered by workforce administration). It returns them in every answer so that the
  caller verifies check 2 itself; `credential_status` is `unknown` for a credential not
  registered to the named `operator`.
- **`operator_check`**, answered by identity in its operator partition at the present
  timestamp. It first **verifies every assertion** (the §E check 2 rules against its own
  key, origin and `rpIdHash`, challenge = the request's `digest`); for an `invalid`
  assertion it consumes nothing and answers `assertion` = `invalid`. On the first call for
  an `action_id` or `grant_id` it binds that identifier to its `digest`; a later call with
  another digest under the same identifier answers `digest_conflict`. With `consume: true`
  and every assertion valid it consumes each `(credential_id, counter)` under the
  `action_id` or `grant_id` (a conditional entry on the digest's state: open → consumed);
  `unused` = false only if the pair is already consumed under **another** identifier;
  repeating the same call is idempotent (second and later members of a set-scoped action
  answer `unused` = true). A counter lower than the credential's highest seen is not refused
  but alerts workforce administration. Consumed pairs are kept until
  max(`not_after`, consumption + 72 h) (R46-14).
  `consume: false` is accepted only from the console's workload and consumes nothing.
- **`cancel`** (R46-06, review 46 D2) carries the signed action: identity recomputes the
  digest from `action`, `role` and `not_after`, verifies `requester_original` over it (as
  in `operator_check`), binds `action_id` → (digest, requester person) if not yet bound
  (else the bound digest must match: `digest_conflict`), verifies `cancel_assertion`, and
  accepts it only if the cancel credential is registered to the **same person** as the
  original requester (`not_requester` otherwise; any other operator, the approver included,
  is refused). Cancel is serialised with `operator_check` on the same digest: if open, it commits
  the cancellation and returns an identity-signed `receipt`, and every later check answers
  `cancelled` = true; if an owner's check has consumed it, it answers **`too_late`** with
  no receipt. For a set-scoped action, a cancel after the first member's check is
  `too_late` for the whole set.
- **Unavailable**: owners and readers refuse the operator command or read (S4); nothing
  else is affected.

### §G. Target summary

The owner answers for one target, from its own state, signed by its summary-signing key
for (owner kind, slot, epoch), including the `target_version` it will re-check at apply.
The signing client verifies the signature (key service certification) and shows the
summary beside the action; the console cannot alter it. A request is authenticated by the
operator's **console session** (principal and role, `console_session` authority), is
unsigned, and is accepted only from the console's workload (S-G3), with these
**compensating controls** (review 46 D3): `action_id` and `action_type` are mandatory; the
owner refuses `target_kind_mismatch` when the target kind is not one of the action type's
`target_kinds` in its policy bundle, and `role_mismatch` when `role` is not the action's
role; summaries under session authority count against `operator_read_limit` per operator,
and the owner raises the breadth alert past `breadth_alert_targets_per_h` (§N); and the
owner **appends the request to audit** (§J append: operator, role, session, `action_id`,
`action_type`, target, time) **before answering**; no audit append, no answer.
Exploratory reads need a read grant, which is the alternative authority (then §H
applies). `not_found` for an unknown target.
Owners that serve it: every owner that accepts operator actions (account owner, link
schedule owner and registry, catalogue, attribution, payouts, payments, identity and
access, placement); "Consumer obligations" lists each one's duties.

### §H. Read grant

The reader (reporting, status replicas, link owner, catalogue, audit query service,
personal-data store) verifies the grant's assertion by the §E rule 2 over the grant
digest, calls `operator_check` (`subject: grant`, `consume: true`) once per grant and then
every `operator_check_cache` (60 s) while the grant is in use, re-verifies the assertion
under identity's returned key (as §E check 2), checks `now ≤ not_after` and `not_after ≤
now + read_grant_ttl + ε` (D5), that `read_type` is in its policy bundle's `read_types`
for the grant's `role` and target kind, answers **only within the one target**, enforces
`operator_read_limit` per operator, and **appends the read to audit** (§J append: operator,
role, target, grant, time) **before answering**. Any failed check: refused with the
`ReadGrantRefusal`, and the refusal recorded.

### §I. Erasure-request intake and recovery objection

- **`record_erasure_request`**, edge only. Identity verifies the token itself (ES256
  signature, expiry, session active in **its own** state, a user principal, not a key,
  the token's principal = `context.principal_id` (else `invalid_token`), and = `subject` if
  given), records the request in the subject's account or
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
  head's `chain` with its own on every batch and on takeover. On a mismatch the runtime
  **does not stop the partition on its own authority** (R46-12): it holds the partition
  locally (`append` refused, owners answer "temporarily unavailable") and sends
  `integrity_report` to audit, which records an `integrity_violation` with a new
  `detection_ref`, opens its `integrity_stops` row and sends `integrity_stop`; from the
  `stopped` acknowledgement the §K path (restore role, re-verification, resume) applies.
  The local hold persists across the holder's restart (it is re-derived from the head check
  on takeover) and is lifted only by `integrity_resume`. No application role may update or
  delete a log row.
- **Audit changefeed**: per log table, the CDC projection of `AuditCdcEvent`, delete
  events included, resolved every 10 s, to `cdc.audit.<kind>`, consumed only by audit,
  which checks continuity, single sight of every key, deletes only at or below the
  sealed-through watermark, and keeps the first-seen `(seq, chain, ts)` and head.
- **Append** (R46-11): `audit_append(source_ref, record)` → position, acknowledged once
  committed in audit's own chained log; **`source` is set by audit from the caller's mTLS
  workload identity**, and a caller not on the policy allowlist is refused
  `caller_not_allowed`; idempotent by (`source`, `source_ref`); the same key with
  different content is refused `source_ref_conflict` and **paged to security**; records
  are never altered.
- **Readers** never accept an altered record or a gap: the audit query answers a broken
  range as "record altered or missing at partition p, sequences n … m, detected at t".

### §K. Integrity stop and resume

- On a detection, audit appends `integrity_violation(kind, partition, seq range, layer,
  detection_ref)`, opens its `integrity_stops` row, and sends `integrity_stop` (also after an
  `integrity_report`, §J). The runtime acknowledges `stopped` **once the stop is durable** in
  placement's `integrity_stops`
  projection (read by every holder on acquisition, resume and `adopt`, and pushed to the
  current holder). From then, under **every** lease holder, across takeovers and moves,
  `append` for the partition answers `Stopped`; owners answer callers "temporarily
  unavailable"; nothing is decided.
- On `stopped`, audit sets `acknowledged_at` on its row. The **restore role**, only in a
  break-glass session with two approvers, writes back stored ciphertext only into
  partitions whose stop is acknowledged and not closed (row-level security above, on
  `<kind>_log` and `<kind>_head`, forced), so it can never race a live writer; it holds no
  application key and is revoked at the session's end.
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
- The notifier learns endpoints from the feed (sealed, C13); its **delivery workers** (the
  workload that sets each attempt's timestamp and computes the HMAC, R46-19) unwrap
  secrets with the key service under their own key-release entry, keep them **in memory
  only**, and may query one endpoint by identifier. It picks endpoints
  **only** by the event's tenant derived from the event's clear partition (account; or
  for link-partitioned topics, the link's supplier in the catalogue at the event's
  position), never from the payload.

### §M. Signed webhook

- **Notifier** (RFC-006): forms a delivery of up to 100 notices of **one** endpoint's
  tenant (checked again by the worker); the **delivery worker computes the HMAC itself**,
  in process, with the endpoint secret it holds in memory (no remote signing service,
  S-M3), **per attempt** with a fresh `webhook-timestamp`. A `webhook-id` names one fixed
  set of notices and is reused for every attempt of that set; for a delivery of a single
  notice it equals that notice's `event_id` (RFC-005 §8.3, kept by D4); notices regrouped
  on retry form a **new** delivery with a **new** `webhook-id` (S-M4). It resolves the host
  itself, accepts only global unicast addresses (RFC-005 §8.3 exclusion list), connects to
  the checked address **with SNI set to the URL's host and the TLS certificate verified
  against that host** (R46-23), follows no redirects,
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
| Policy feed (+ `get_policy`) | At least once; apply only a higher `policy_version` | One key | Total |
| Key-certification stream | Every certificate and revocation after `from_position`, or heartbeats withheld | — | Key-service order |
| Audit changefeed | At least once (CDC), delete events included | Partition | Per partition |
| Operator commands, operator check, cancel, erasure intake, objection, integrity stop/resume/report, audit append | Synchronous; retried by the caller with the same identity until answered; exactly-once effect | — | Per action digest (check vs cancel serialised in identity's operator partition); per account (objection vs hold expiry) |
| Signed webhook | At least once per notice | Endpoint | Per reservation in stream order; a delivery waits only for its predecessor's first attempt to **start**; no order across requests |

## Idempotency

| Operation | Key | Duplicate | Same key, different content |
|---|---|---|---|
| Status push event (consumer) | (`identity_partition`, `seq`); then per-key `version`, per-account KYB `version`. `committed_at` is not unique and never a key | No effect; highest version wins | Impossible (identity's log) |
| Catch-up snapshot (consumer) | Per-key and KYB `version` | Lower or equal versions no-op | — |
| Policy bundle | `policy_version` | Ignored | Same version, different digest: refused, alerted |
| Certificate, revocation | `key_id`; revocation terminal | Ignored | Refused, alerted |
| `catch_up` | — (a read) | Safe to repeat | — |
| Edge records | (record key, `version`) | Lower or equal version ignored, alerted if lower | — |
| Endpoint events | (`endpoint_id`, `version`) | Ignored | — |
| Administrator commands (identity) | (tenant, idempotency key), 24 h | First answer, **except a secret**: "secret already issued", never the secret | Refused, as a reuse of the key for a different command (POL-29 by analogy) |
| Operator envelope at an owner | `action_id`; set-scoped (`action_id`, partition) | The recorded answer: an applied action's entry, or a **refusal the owner recorded** by `audit_append` (`source_ref` = `refusal:<action_id>:<partition>`) and answers again unchanged (R46-17); `temporarily_unavailable` is never recorded and is re-evaluated | Digest differs under the same `action_id`: refused `digest_or_type`; a money-moving `action_id` is the source reference (POL-29, P4-S99): a different principal is refused |
| `operator_check` | (`action_id` or `grant_id`, (credential, counter)); identifier bound to its first digest | Idempotent, `unused` = true | Same pair under another identifier: `unused` = false; other digest under the same identifier: `digest_conflict` |
| `cancel` | (`action_id`, digest) | Same receipt, or `too_late` | Digest not the one bound to `action_id`: `refused digest_conflict` |
| `record_erasure_request` | (subject, idempotency key), 24 h | The first `request_ref` and `requested_at` | Cannot arise (the subject is part of the key); a token whose principal differs from the context's is `invalid_token` |
| `object_to_recovery` | (principal, idempotency key), 24 h | The first answer | Other `recovery_ref`: `idempotency_key_reused` |
| Compliance-recorded erasure | `action_id` | The first `request_ref` | As envelope |
| `integrity_stop` / `integrity_resume` | `detection_ref` | The same acknowledgement | Other `kind`/`partition` under one `detection_ref`: refused, alerted |
| `audit_append` | (`source` from mTLS, `source_ref`) | The first position | Refused `source_ref_conflict`, paged to security |
| `integrity_report` | (`kind`, `partition`, `seq`, `observed_chain`) | The same `detection_ref` | — |
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
| Endpoint feed contents | Identity | Notifier only (topic ACL); secret unwrap only by the notifier's delivery-worker workload |
| Webhook signature | Notifier's delivery worker, per attempt, with RFC-005's format | Receivers |
| Operator credentials' public keys, origins, operator and person bindings | Identity (from workforce administration) | Returned in `operator_check` answers only |
| Policy bundle | Identity (policy partition) | Edge, every owner, readers, console |
| Signing-key certificates and revocations | Key service | Edge, every owner, readers, console signing client |

Topic ACLs: one producer (identity's relay) for `iam.status.v1`, `iam.endpoints.v1` and `iam.policy.v1`; one
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
| `approval_expiry` | 72 h (`not_after` = request time + 72 h; owners refuse `not_after` beyond own ts + 72 h + ε); consumed pairs kept until max(`not_after`, consumption + 72 h) | Owners (check 5); identity |
| ε in check 5 | `max_offset`, 100 ms | Owners |
| `read_grant_ttl`; `operator_check_cache` | 1 h (also the upper bound on a grant's `not_after`); 60 s | Readers |
| `operator_read_limit`; breadth alert | 200 reads or session summaries per operator per hour; alert past 20 distinct targets per operator per hour (both est., confirm at C5; carried in the policy bundle) | Readers; summary-serving owners |
| Certificate validity; cert-stream staleness | `not_after` = `not_before` + 24 h (est.); refuse everything once the last cert heartbeat (1 s) is older than 30 s | Key service; every receiver |
| Heartbeat lease margin | `sent_at` < lease expiry − `max_offset` (100 ms) | Identity |
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
| `integrity_report` per-call deadline | 5 s (est.; confirm at C5); the runtime keeps its local hold and retries until accepted | Owner runtime |
| `get_policy` per-call deadline | 2 s (est.; confirm at C5); a miss → "temporarily unavailable" for contexts of the unapplied version | Every receiver |

## Versioning and compatibility

- Every message carries `schema` with a major version (`principal.v1`, `iam.status.v1`,
  `operator-envelope.v1`, `audit.v1`, …); topics and gRPC services are named by major.
- **Additive changes** (a new optional field, a new event `body.kind`, a new refusal code,
  a new `action_type`) keep the major. Consumers ignore unknown fields; treat an unknown
  event kind as no status change (alerted); treat an unknown refusal as refused; owners
  refuse an `action_type` they do not know (`digest_or_type`).
- **Signed and digested structures** (key records, edge records, heartbeats, envelope
  digest, grant digest, cancel challenge, receipts, target summaries, policy bundles,
  certificates, chain): any change to
  their canonical bytes or domain strings is a **new major**, with the old one accepted
  for at least `approval_expiry` (72 h) for envelopes and grants, and for the chain never
  (the chain is `share-chain-v1` for the 7-year retention; a v2 would start at a new
  generation boundary, both verified).
- Policy versions (`policy_version`) change the permission matrix, catalogue, reason
  codes, allowlist, read types and limits through the policy feed without changing this
  contract; every decision records the version it used. The grant digest is already at
  `share-read-grant-v2` in this draft (R46-01); nothing has shipped under v1.
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
| P-01 | Golden vectors: JCS bytes, envelope digest (one per `Target` kind, the five R46-09 kinds included), grant digest v2, cancel challenge, policy bundle digest, certificate signature, chain genesis and links (incl. after a move and a retried batch), webhook signature (single-notice `webhook-id` = `event_id`), under fixed inputs published with this contract | X1-S11, X1-S15 |
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
| P-12 | `operator_check` with an assertion whose signature is wrong consumes nothing and answers `invalid`; the pair stays usable by the real action; a credential of operator A named under operator B answers `credential_status` = `unknown`; a second call with another digest under the same `action_id` answers `digest_conflict` (R46-01) | X1-S26, X1-S32 |
| P-13 | `cancel` by a different operator (another person, the approver included) with a valid own assertion → `not_requester`, no receipt; by the requester's person → receipt (R46-06) | X1-S32 |
| P-14 | Heartbeat fencing: holder paused past its lease expiry, successor commits a revocation at `t`; edges still connected to the old holder get no heartbeat with `sent_at` past its lease and refuse the credential by `t` + 31 s; a heartbeat with lower `sent_at` or older epoch is rejected and alerted (R46-03) | X1-S06, X1-S41 |
| P-15 | Certificates: a record signed under a revoked certificate is refused by every edge and owner within 31 s of the revocation; with the cert stream silent for 30 s every receiver refuses; a certificate past `not_after`, or whose slot differs from the record's, is refused (R46-04) | X1-S06 |
| P-16 | `catch_up` without `since` returns a snapshot of every account of the slot at its `position`; with `since` older than 7 days, a snapshot too (S-G1, R46-07) | X1-S06, P2-S72 |
| P-17 | `audit_append` naming another source in its payload is recorded under the caller's mTLS identity; a pre-claimed `source_ref` of another source does not block it; a same-source same-key different record is refused and pages security (R46-11) | X1-S15 |
| P-18 | Policy: a bundle at version n+1 reaches every receiver; a context with version n+1 at a receiver still at n answers "temporarily unavailable" until `get_policy` applies it (R46-05) | X1-S12, X1-S13 |

**Consumers**

| # | Side | Test | Scenarios |
|---|---|---|---|
| C-01 | Every owner | Contexts: expired, from a non-allowlisted peer, tenant ≠ partition, forged or lower-version key record → no effect (`not_found` or ignored), recorded where §A says; principal fields copied into `audit` (DT-4, DT-25) | X1-S02 … S05, X1-S07 |
| C-02 | Account owner (RFC-002/004) | Two events of one account at one `committed_at` (one identity batch) → both applied; a new holder calls `catch_up` without `since` and applies the snapshot before deciding; a resolved marker does not advance `iam_fresh` while an earlier event on its partition is unapplied (R46-07, R46-08); push event replayed and duplicated by catch-up → one F4; heartbeat-only traffic → no entry, `iam_fresh` advances; after takeover no confirm before the first marker or catch-up; with push and catch-up both silent, no confirm after `iam_fresh` + 45 s; revocation ends undecided requests "key revoked" and leaves decided ones (DT-1, DT-2) | X1-S06, P2-S72, P2-S103 |
| C-03 | Account owner | Credit limit refused `kyb_not_vetted` until a `kyb_status passed` is applied | P4-S82 |
| C-04 | Every owner that accepts operator actions | Check 2 verified with identity's returned key only (an envelope carrying another key changes nothing); an expired or misrouted envelope is refused before `operator_check` and consumes nothing (R46-13); `not_after` beyond own ts + 72 h + ε refused (D5); a target outside the partition → `out_of_scope`; a repeated refused `action_id` gets the recorded refusal (R46-17); the DT-8 matrix: missing, reused, same-person, other-role assertion; wrong challenge, origin, `rpIdHash`, no UV; after `not_after − ε`; cancelled; stale `target_version`; a field changed after signing → refused with the named check; a four-eyes action with interleaved read grants (higher counters) → applied | X1-S12, X1-S13, X1-S26, X1-S31, X1-S32 |
| C-05 | Account owner | Set-scoped credit limit: one `action_id`, applied once per member, `member` ≠ partition → `out_of_scope`; a non-probe account → `out_of_scope` before `kyb_not_vetted`; a refused member not re-applied under the same `action_id` (DT-32; membership by own F9, even with placement past v, S-M1) | X2-S24 |
| C-06 | Account owner | `withhold_notice` accepted only on an approved compliance termination with `order_ref`; network-abuse termination proceeds with the withhold refused and recorded (DT-19) | X1-S17, X1-S36 |
| C-07 | Every owner with operator actions; placement; identity | `target_summary` signature verifies under the certified summary key; its `target_version` is the one check 6 compares; under `console_session`: missing `action_id` or `action_type` refused, target kind not matching the action → `target_kind_mismatch`, past `operator_read_limit` → `read_limit` and breadth alert, and **with the audit append failing, no answer** (D3) | X1-S31, X1-S32 |
| C-08 | Every reader (reporting, status replicas, link owner, catalogue, audit query, store) | No grant, expired grant, out-of-target read → refused and recorded; with a grant the reader's audit append commits before the answer (DT-24) | X1-S13, X1-S27, X1-S31 |
| C-09 | Reporting, provisioning feed | `visibility` unavailable → every identity hidden; no reuse of an answer across views; `registry_timestamp` recorded | X1-S28, X1-S30 |
| C-10 | Owner runtime and database (RFC-006) | `integrity_stop` → `Stopped` under every holder across a takeover and a move until `integrity_resume`; with partition P1 of kind k stopped and acknowledged, a restore-role write to P2 of kind k (log and head) is refused; before `acknowledged_at`, a write to P1 is refused too; the policies hold for the table owner (FORCE) (R46-02, R46-18; DT-45, RFC-005 DT-31) | X1-S15 |
| C-11 | Owner runtime | Every committed log row's `chain` matches the golden recomputation; a head `chain` mismatch holds the partition locally and sends `integrity_report`; audit's stop follows with a `detection_ref`, and only `integrity_resume` lifts the hold (R46-12) | X1-S15 |
| C-12 | Notifier (RFC-006) | Endpoint chosen from the event's clear partition only; deliveries ≤ 100 notices, one tenant; fresh timestamp per attempt; a pinned-address connection whose certificate does not match the URL's host is refused (R46-23); the overlap's previous secret signs until the new secret's `active_from` + 24 h; DNS-rebinding to a private address refused at delivery; down endpoint: first attempt within `affected_notice_time` (DT-10, DT-23) | X1-S11, X1-S24, P1-S75, P2-S09 |
| C-13 | Edge (RFC-005 §2.2) | Unauthenticated answers identical in bytes and timing class (DT-23, DT-3); stale slot → "temporarily unavailable"; erasure and objection forwarded with the user's token only | X1-S01 … S04 |

## Settled

The orchestrator's binding decisions on the mismatches (M) and gaps (G) raised in this
contract's first draft. The reading below is the contract; the RFC text that differs is an
erratum listed under "Consumer obligations".

| # | Point | Settled reading | Erratum |
|---|---|---|---|
| S-M1 | Set-scoped membership test (check 6) | RFC-005's: `member` = the owner's partition and the account's **own applied probe flag** (RFC-004 F9 `excluded`); the signed slot-map version v is recorded in `audit` (`set_version`) only, never checked (as C07 S1). `out_of_scope` before `kyb_not_vetted` | RFC-002 §7.3, §13.1; RFC-004 §A3, F5, §B12 drop "a member of the signed set at slot-map version v" |
| S-M2 | Four eyes on the set-scoped probe credit limit | None; one out-of-band confirmation per set-scoped action | RFC-006 §7.1 drops "four-eyes approval" (the requester's signing client shows placement's signed summary) |
| S-M3 | Who computes the webhook HMAC | The notifier, in process, with the secret it holds in memory, in RFC-005's format. **Amended by review 46 (R46-19)**: the notifier's **delivery worker** holds the secrets and computes the HMAC, under its own key-release entry | RFC-006 §15 "signed by RFC-005's signing service" and "RFC-005 signs the delivery" → "signed by the delivery worker in RFC-005's format"; RFC-006 §7.1 "signed by placement's key through RFC-005's signing service" → "signed by placement's summary-signing key" (R46-21); RFC-005 §8.3, §10 key release to the delivery worker |
| S-M4 | `webhook-id` across retries | Reused for every attempt of one fixed notice set; a regrouped retry is a new delivery with a new `webhook-id`; receivers deduplicate per `event_id`; a single-notice delivery's `webhook-id` = its `event_id` (kept, D4) | RFC-005 §8.3 "a retry carries the same notices under the same `webhook-id`" → as settled |
| S-M5 | Two `integrity_stops` stores | Audit's table is authoritative and the restore role's row-level-security predicate; placement's projection is what the runtime honours; audit **closes** its row before sending `integrity_resume` | RFC-005 §9.3 and RFC-006 §12.2, §14.3 state the ordering |
| S-M6 | Where `iam_fresh` lives | The booking module's, in owner memory: `max(min over the identity-push partitions feeding the slot of the latest resolved timestamp applied, last catch-up read timestamp)`; unset after takeover. **Amended by review 46 (R46-07)**: "applied" per C05's applied-only rule | RFC-005 C3 and §3.3 ("F4 keeps" / "funds module keeps") → booking module; RFC-004 §A2, F4, JR-11 state that F4 neither holds nor advances it (R46-08) |
| S-G1 | `catch_up` with `since` older than retention | Answer a current-state `snapshot` of the slot's accounts with its `position`. **Amended by review 46 (R46-07)**: a new lease holder always asks for the snapshot (no `since`); a running holder uses `since = iam_fresh` | RFC-005 C3 adds the snapshot answer and the `since` rule; RFC-004 F4 applies the snapshot (R46-08); RFC-002 §5.6 takes it before deciding |
| S-G2 | Owners' summary, check and reader duties | Listed per RFC under "Consumer obligations" | As listed there |
| S-G3 | Authority of a target-summary request | The operator's console session (principal and role), unsigned, audited by the owner. **Amended by review 46 D3**: purpose-bound (mandatory `action_id` and `action_type`, target kind must match), counted against `operator_read_limit`, breadth-alerted, audited before answering | RFC-002 §13.1 "read grant or envelope request" → "console session, purpose-bound, audited"; RFC-005 §7.3, §7.6 state it; every summary-serving owner (Consumer obligations) |
| S-G4 | Per-call deadlines | Set in "Timeouts and deadlines", marked (est.), confirmed at C5 | — |

## Consumer obligations

Each owner's duties under this contract, per RFC; where the RFC does not yet say so, the
line is an **erratum** for that RFC (S-G2, the settled points and review 46). Duties common
to every owner that serves target summaries (review 46 D3, R46-10): accept only from the
console's workload; under `console_session` require `action_id` and `action_type`, refuse a
target kind or role that does not match the action, count against `operator_read_limit`,
raise the breadth alert, and **append the request to audit before answering**. Duties
common to every owner that applies envelopes: run the checks in §E's order, verify check 2
only under identity's returned key, enforce the `not_after` upper bound, refuse targets
outside the partition, record refusals by `audit_append` (R46-17). Every receiver applies
the policy feed and the key-certification stream (§N).

| RFC | Component | Target summary (§G) | Operator check and envelope (§E, §F) | Read grant (§H) | Other | Erratum needed |
|---|---|---|---|---|---|---|
| RFC-001 rev. 5 | Link schedule owner; link registry | Serve for `link` targets (schedule, capacity, registration state; `target_version` = the link log's last sequence), with the common summary duties, **audit append before answering** | Verify envelopes for `record_outage`, `record_restoration`, `register_link`, `retire_link`; call `operator_check` at apply | Reader for `read_link_schedule`: verify, check every 60 s, audit append before answering | C1 receiver checks (key record names the partition's tenant: the supplier); `audit` field set; `Stopped` and the local hold from the runtime | **Yes**: summary serving with audit-before-answer, `operator_check` at apply, read-grant reader duties, policy feed and cert stream (§11.1 names only principal, envelope, audit record) |
| RFC-002 rev. 5 | Account owner (booking); status replicas | Serve for `account` and `reservation` (stated, §13.1), with the common summary duties, **audit append before answering** | Verify for `act_at_documented_request`, `terminate_network_abuse`, `terminate_compliance`, `set_credit_limit`/`remove_credit_limit` incl. set-scoped (stated) | Status replicas as readers (stated, §8.2) | Own `iam_fresh` with the applied-only rule (S-M6); new holder takes the snapshot before deciding, running holder `since = iam_fresh` (S-G1, R46-07) | **Yes**: S-M1 (drop the version-v membership test), S-G3 with D3 (summary authority, purpose binding, audit-before-answer), R46-07 (`since`, applied-only rule), check order and key source (R46-01, R46-13) |
| RFC-003 rev. 5 + 5.1 | Catalogue; rating; attribution and quarantine | Serve for `product_route`, `account_product`, `supplier_terms`, `partner`, `charge`, `quarantine_item` (R46-09), with the common summary duties, **audit append before answering** | Verify for `set_price`, `set_split_weight` (four eyes), `record_partner_terms`, `correct_price`, `set_usage_rate_cap`, `attribute_quarantine`, `reverse_attribution`; call `operator_check` at apply | Catalogue as reader (preparatory reads); evidence reads via C09 | `audit` field set; `Stopped` | **Yes**: summary serving with audit-before-answer and the new target kinds, `operator_check` at apply, read-grant duties (§8 names only the envelope) |
| RFC-004 rev. 5 + 5.1 | Funds module (Part A); payments; payouts; reporting | Payouts (`payout`), payments (`reversal`) serve summaries with the common duties, **audit append before answering**; account summaries are RFC-002's | Verify for `set_credit_limit` (with RFC-002), `resolve_payout_escalation`, `resolve_reversal_escalation`; call `operator_check` at apply | Reporting as reader for `read_account`; reporting calls `visibility` per supplier view, hides all on failure, records `registry_timestamp` | F4: apply push events only for actual changes, dedupe by `source` then version, **apply the S-G1 snapshot** | **Yes**: S-M1 (§A3, F5, §B12); **F4 drops "skips any event at or below `id_ts`"** in favour of `source` and version, and applies the snapshot (R46-08, S-G1; consistent with C05 review 45 M3); **§A2, F4, JR-11: F4 neither holds nor advances `iam_fresh`** (S-M6); summary serving with audit-before-answer and `operator_check` for payouts and payments; reporting's read-grant and `visibility` duties |
| RFC-006 rev. 6 | Owner runtime; placement; notifier; provisioning feed; history | Placement serves `probeSetSummary(v)` and the region-disaster target (stated), with the common summary duties, **audit append before answering** | Placement verifies `declare_region_disaster`/`end_region_disaster` (four eyes) and **calls `operator_check` at apply** (R46-27) | — | Runtime: `chain`, audit changefeed, `integrity_stop`/`resume` → `Stopped` (stated); **on a head-chain mismatch, local hold and `integrity_report` to audit, no stop of its own** (R46-12); database: the forced RLS policies of §K and `acknowledged_at`. Notifier: endpoint feed, the **delivery worker** holds secrets and computes the HMAC per attempt, one tenant per delivery, new `webhook-id` on regroup, SNI and hostname verification on the pinned address; **no `visibility` call** (R46-22). Provisioning feed calls `visibility`, hides on failure | **Yes**: S-M2 (§7.1), S-M3 with R46-19 and R46-21 (§15 "signed by RFC-005's signing service" and "RFC-005 signs the delivery"; §7.1 "through RFC-005's signing service"), S-M4 (§15), S-M5 (§12.2, §14.3 ordering), R46-12 (§12.2 report path), R46-02 and R46-18 (§13.2 DDL), placement's `operator_check` |
| RFC-005 rev. 5 (provider) | Identity, console, audit, edge, key service | Identity serves summaries for `registry_entry`, `data_subject`, `erasure_request`, `exporter_credential`, `exporters_period` (R46-27), with the common duties, **audit append before answering** | Identity verifies envelopes for `disclose_identity`, `end_disclosure`, `issue_share_exporter_credential`, `revoke_share_exporter_credential`, `record_non_user_erasure_request`, `refuse_erasure_request`, `open_legal_requirement_erasure`, `erase`, calling its own `operator_check` at apply | Audit query service and personal-data store as readers (stated) | `operator_check` returns keys and verifies before consuming (R46-01); `cancel` carries the signed action (R46-06); heartbeat fencing (R46-03); key-certification stream (R46-04); policy feed (R46-05); `audit_append` source from mTLS (R46-11); `integrity_report` intake (R46-12) | **Yes**: S-M4 (§8.3), S-M5 (§9.3), S-M6 (C3, §3.3), S-G1 and R46-07 (C3 snapshot and `since`), S-G3 with D3 (§7.3, §7.6), R46-01, R46-03 … R46-06, R46-11, R46-12 (C4, C5, C14, C15, §10); grant digest v2 (§7.6); key release to the notifier's delivery worker (§8.3, §10) |

Raised upstream by review 46, not decided here: **AR46-2** (RFC-000 §8 row for the policy
and key-certification feed, owner RFC-005), **AR46-1** (§8 "Signed webhook" consumers:
buyers and suppliers), **RQ46-1** (X1-S11 and X1-S24 supplier examples). This contract
specifies §N now so both sides can build; the RFC-000 row only names it.

## Review 46 resolution

| Finding | Severity | Change in 1.1-draft | Where |
|---|---|---|---|
| R46-01 | Blocker | Identity is the only source of each operator credential's public key, origin and operator and person binding; `operator_check` takes the full assertions, verifies them before consuming, binds the identifier to its digest, returns `public_key`, `alg`, `registered_origin`, `assertion`; `unknown` unless registered to the operator; owners and readers re-verify check 2 with that key only; grant digest v2 adds `E(operator)` | §E, §F, §H schema and semantics; Ownership; P-01, P-12, C-04 |
| R46-02 | Blocker | Policies qualified (`<kind>_log.partition`, `<kind>_head.partition`), a head policy written out, `ENABLE` and `FORCE ROW LEVEL SECURITY`, `GRANT SELECT` on `audit.integrity_stops` to `restore_role` | §K DDL; C-10 |
| R46-03 | Major | Heartbeat carries `epoch`; `sent_at` = HLC timestamp of the consistent head-row read that returned `head`; sent only under the lease with `sent_at` < expiry − `max_offset`; edges reject decreasing `sent_at` or older epochs | §C; P-14 |
| R46-04 | Major | Certificate gets `not_after`, loses the self-asserted `revoked`; key-certification stream with revocations and heartbeats; refusal within 31 s; slot and epoch matching; `slot_of(key_id)` defined; key records carry `identity_slot` and `epoch`; AR46-2 noted | Common types, §A, §C, §N; P-15 |
| R46-05 | Major | Policy feed (`iam.policy.v1` plus `get_policy`) with a typed `PolicyBundle` (matrix, catalogue, reason codes, read types, allowlist, limits); unapplied version → "temporarily unavailable" | §A, §N; P-18 |
| R46-06 | Major | `cancel` carries the action, role, `not_after` and the requester's original assertion; identity enforces same person, binds `action_id` → digest; `unknown_action` replaced by `digest_conflict` | §F; Idempotency; P-13 |
| R46-07 | Major | `since` defined: a new holder takes a snapshot (no `since`), a running holder uses `since = iam_fresh`; applied-only rule for resolved markers, as C05; S-G1 and S-M6 amended | §B; Settled; C-02, P-16 |
| R46-08 | Major | Dedupe by `source` then per-key and KYB `version` only; `committed_at` not unique; RFC-004 errata (drop the `id_ts` skip, apply the snapshot, F4 holds no freshness) | §B; Idempotency; Consumer obligations; C-02 |
| R46-09 | Major | Target kinds `account_product`, `supplier_terms`, `partner`, `charge`, `quarantine_item`, each with its receiver; golden vectors | §E; Consumer obligations; P-01 |
| R46-10 | Major | D3 compensating controls: mandatory `action_id` and `action_type`, kind and role match, read limit, breadth alert, audit before answering; duty in every summary-serving obligations row | §G; Consumer obligations; C-07 |
| R46-11 | Major | `source` set from the caller's mTLS identity, allowlist, idempotency per (`source`, `source_ref`), conflict refused and paged | §J; Idempotency; P-17 |
| R46-12 | Major | Runtime never stops on its own: local hold plus `integrity_report` to audit, which opens the stop with a `detection_ref`; resume path as §K | §J, §K; Idempotency; C-11; RFC-006 obligation |
| R46-13 | Minor | Check order: 1, 4, 5, partition test of 6, then 3, 2, 4, `target_version`; target outside the partition → `out_of_scope` | §E; C-04 |
| R46-14 | Minor | Upper bounds on `not_after` at owners and readers; consumed pairs kept until max(`not_after`, consumption + 72 h) | §E, §F, §H; Timeouts |
| R46-15 | Minor | `applied.result` carries `request_ref`, `requested_at` | §E, §I |
| R46-16 | Minor | Idempotency row fixed; token principal must equal the context's | §I; Idempotency |
| R46-17 | Minor | Owners record refusals by `audit_append` and answer them again | Idempotency; C-04 |
| R46-18 | Minor | `acknowledged_at` required by the policy; `detection_ref BYTES(16)`; `owner_kind` named apart from the numeric row kind | §K |
| R46-19 | Minor | The notifier's delivery worker holds secrets and computes the HMAC; key release to it | §L, §M; Ownership; S-M3 |
| R46-20 | Minor | `sign_until` = the new secret's `active_from` + `webhook_retry` | §L |
| R46-21 | Minor | RFC-006 erratum adds §15 "RFC-005 signs the delivery" and §7.1's placement-summary sentence | S-M3; Consumer obligations |
| R46-22 | Minor | Notifier's `visibility` duty dropped | §D; C-09; Consumer obligations |
| R46-23 | Minor | Endpoint feed sealed (C13); SNI and hostname verification on the pinned address | §L, §M; C-12 |
| R46-24 | Minor | D4: `occurred_at` stays a JSON integer (units exception stated); single-notice `webhook-id` = `event_id` kept | Schema units, §M; S-M4 |
| R46-25 | Minor | `actor` gains `share_security`, `recovery`, `workforce_administration`, `operator`; key record names "the partition's tenant" | §B, §A |
| R46-26 | Minor | `iam_slots` 256 marked est.; `operator_read_limit` and breadth alert initial values (est.); read types a closed list in the policy bundle | Common types, §E, §N; Timeouts |
| R46-27 | Minor | RFC-005 row filled (identity's summaries and envelopes); placement calls `operator_check` at apply | Consumer obligations |
| R46-28 | Minor | Tests added: P-12 … P-18; C-02, C-04, C-07, C-10, C-11, C-12 extended | Conformance tests |
| RQ46-1, AR46-1, AR46-2 | — | Recorded as raised upstream; §N specified here meanwhile | Consumer obligations (last paragraph) |
