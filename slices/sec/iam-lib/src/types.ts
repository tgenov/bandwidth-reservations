/**
 * C08 v1.2 (frozen) types that S-SEC I1 uses. Names and fields are copied from C08 §A, §B, §C, §J and §N.
 * Timestamps are epoch microseconds UTC as bigint (C08 "Units"); in JSON they are decimal strings.
 */

export type EpochMicros = bigint;
export type Id128 = string;
export type PrincipalId = Id128;
export type AccountId = string;
export type SupplierId = string;
export type KeyId = string;
export type SessionId = Id128;
export type CertSerial = string;
export type IdentitySlot = number;
export type AccountSlot = number;
/** base64url without padding. */
export type Bytes = string;

export type Tenant =
  | { kind: 'account'; account: AccountId }
  | { kind: 'supplier'; supplier: SupplierId }
  | { kind: 'none' };

export type PrincipalKind =
  | 'account_user' | 'agent_key' | 'supplier_user' | 'supplier_key' | 'operator'
  | 'probe' | 'payment_provider' | 'payment_partner' | 'payout_provider'
  | 'partner_system' | 'exporter' | 'network_operations' | 'internal_service'
  | 'onboarding' | 'workforce_administration';

export type OperatorRole = 'support' | 'network_operations' | 'commercial' | 'finance' | 'compliance';

export interface Ed25519Signature {
  key_id: string;
  sig: Bytes;
}

export interface SigningKeyCert {
  key_id: string;
  purpose: 'identity_record' | 'owner_summary' | 'placement_summary';
  owner_kind: string;
  slot: number;
  epoch: string;
  public_key: Bytes;
  not_before: EpochMicros;
  not_after: EpochMicros;
  key_service_sig: Bytes;
}

// ---------- §A ----------

export interface KeyLimits {
  key_spend_limit_micro_usd: bigint | null;
  key_inflight_limit_mbps: bigint | null;
  key_rate_limit_per_s: number;
}

export interface SignedKeyRecord {
  key_id: KeyId;
  identity_slot: IdentitySlot;
  epoch: string;
  tenant: Tenant;
  status: 'active' | 'revoked';
  limits: KeyLimits;
  version: number;
  committed_at: EpochMicros;
  probe: boolean;
  signature: Ed25519Signature;
}

export interface PrincipalContext {
  schema: 'principal.v1';
  principal_id: PrincipalId;
  kind: PrincipalKind;
  tenant: Tenant;
  rights: { administrator: boolean };
  key_id?: KeyId;
  session_id?: SessionId;
  cert_serial?: CertSerial;
  auth: {
    method: 'oidc_token' | 'agent_key' | 'supplier_key' | 'mtls_cert' | 'workload_cert' | 'provider_verifier';
    at: EpochMicros;
  };
  iam_position: { identity_slot: IdentitySlot; head: string };
  key_record?: SignedKeyRecord;
  probe: boolean;
  request_id: Id128;
  received_at: EpochMicros;
  edge_region: 'R1' | 'R2';
  edge_workload: string;
  expires_at: EpochMicros;
  policy_version: number;
}

export type Operation = string;
export interface Resource { kind: string; id?: string; tenant?: Tenant }

export type Decision =
  | { result: 'permit'; policy_version: number }
  | { result: 'not_found'; policy_version: number }
  | { result: 'refused'; right: string; policy_version: number }
  | { result: 'unauthenticated'; policy_version: number };

// ---------- §B ----------

export type StatusActor =
  | { kind: 'administrator'; principal_id: PrincipalId }
  | { kind: 'onboarding' }
  | { kind: 'share_security'; reason: 'secret_leak_report' | 'credential_compromise' }
  | { kind: 'recovery'; recovery_ref: Id128 }
  | { kind: 'workforce_administration' }
  | { kind: 'operator'; principal_id: PrincipalId; action_id: Id128 };

export type StatusBody =
  | { kind: 'key_issued'; key_id: KeyId; version: number; limits: KeyLimits; probe: boolean }
  | { kind: 'key_limits_changed'; key_id: KeyId; version: number; limits: KeyLimits }
  | { kind: 'key_revoked'; key_id: KeyId; version: number }
  | { kind: 'kyb_status'; status: 'passed' | 'failed' | 'withdrawn'; version: number };

export interface IdentityStatusEvent {
  schema: 'iam.status.v1';
  account: AccountId;
  source: { identity_partition: string; seq: string };
  committed_at: EpochMicros;
  actor: StatusActor;
  body: StatusBody;
}

export interface IdentityStatusResolved {
  schema: 'iam.status.resolved.v1';
  topic_partition: number;
  resolved: EpochMicros;
}

// ---------- §C ----------

export type CredentialBody =
  | { kind: 'agent_key' | 'supplier_key'; key_id: KeyId; verifier_sha256: Bytes; tenant: Tenant;
      limits: KeyLimits; status: 'active' | 'revoked'; probe: boolean }
  | { kind: 'policy_version'; policy_version: number; matrix_digest: Bytes };

export interface CredentialRecord {
  identity_slot: IdentitySlot;
  epoch: string;
  position: string;
  committed_at: EpochMicros;
  version: number;
  body: CredentialBody;
  signature: Ed25519Signature;
}

export interface Heartbeat {
  identity_slot: IdentitySlot;
  epoch: string;
  head: string;
  sent_at: EpochMicros;
  signature: Ed25519Signature;
}

/**
 * C08 §C `EdgeStreamMessage`, with one ADDITIVE optional field: `key_record`.
 * Contract issue (see slices/sec/STATUS-I1.md): C08 §A says the edge puts an identity-signed
 * `SignedKeyRecord` in the context, but no C08 message carries one to the edge. The field is on the
 * unsigned stream message, so the signed `CredentialRecord` bytes do not change.
 */
export type EdgeStreamMessage =
  | { record: CredentialRecord; key_record?: SignedKeyRecord }
  | { heartbeat: Heartbeat };

// ---------- §J ----------

export interface AuditFields {
  schema: 'audit.v1';
  principal: { principal_id: PrincipalId | 'internal_service'; kind: PrincipalKind; tenant: Tenant;
               key_id?: KeyId; session_id?: SessionId; cert_serial?: CertSerial; edge_workload?: string };
  on_behalf_of?: { account: AccountId; request_ref: Id128 };
  cause?: { rule: string; trigger: { partition: string; seq: string } };
  received_at?: EpochMicros;
  request_id?: Id128;
  decided_at: 'commit';
  policy_version: number;
  iam_position?: { identity_slot: IdentitySlot; head: string };
  old?: unknown;
  new?: unknown;
}

export interface AuditAppend { source_ref: string; record: AuditFields & { event: string } }
export type AuditAppendAnswer =
  | { kind: 'appended'; source: string; position: { partition: string; seq: string } }
  | { kind: 'refused'; reason: 'caller_not_allowed' | 'source_ref_conflict' | 'read_limit' }
  | { kind: 'temporarily_unavailable' };

// ---------- §N ----------

export interface PolicyBundle {
  schema: 'iam.policy.v1';
  policy_version: number;
  matrix: Array<{
    operation: Operation;
    allow: Array<{ principal_kind: PrincipalKind; requires_administrator?: boolean;
                   scope: 'own_tenant' | 'own_key' | 'probe_links_only' | 'own_supplier_links' }>;
    refused_recorded: PrincipalKind[];
  }>;
  catalogue: unknown[];
  read_types: unknown[];
  allowlist: Array<{ receiver: string; command: string; callers: string[] }>;
  limits: { operator_read_limit_per_h: number; breadth_alert_targets_per_h: number };
  committed_at: EpochMicros;
  slot: IdentitySlot;
  signature: Ed25519Signature;
}

export type CertStreamMessage =
  | { cert: SigningKeyCert; position: string }
  | { revocation: { key_id: string; revoked_at: EpochMicros; reason: string; key_service_sig: Bytes }; position: string }
  | { heartbeat: { head: string; sent_at: EpochMicros; key_service_sig: Bytes } };

/** C08 fixes "identity" as the certificate `owner_kind` of record keys; C01 names the owner kind `iam`. */
export const IDENTITY_CERT_OWNER_KIND = 'identity';
