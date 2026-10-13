/**
 * C08 v1.2 (frozen): identity and access. Only the parts the account owner uses in AM-I1:
 * §A principal context and §B catch-up. Field names are copied from C08 "Schema".
 */

export type EpochMicros = bigint;
export type Id128 = string;
export type PrincipalId = Id128;
export type KeyId = string;
export type AccountId = string;
export type IdentitySlot = number;
export type AccountSlot = number;
export type Bytes = string;

export type Tenant =
  | { kind: 'account'; account: AccountId }
  | { kind: 'supplier'; supplier: string }
  | { kind: 'none' };

export type PrincipalKind =
  | 'account_user' | 'agent_key' | 'supplier_user' | 'supplier_key' | 'operator'
  | 'probe' | 'payment_provider' | 'payment_partner' | 'payout_provider'
  | 'partner_system' | 'exporter' | 'network_operations' | 'internal_service'
  | 'onboarding' | 'workforce_administration';

export interface Ed25519Signature { key_id: string; sig: Bytes }

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
  session_id?: Id128;
  cert_serial?: string;
  auth: { method: 'oidc_token' | 'agent_key' | 'supplier_key' | 'mtls_cert' | 'workload_cert' | 'provider_verifier'; at: EpochMicros };
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

export interface CatchUpRequest { account_slot: AccountSlot; since?: EpochMicros }

export interface SnapshotKey { key_id: KeyId; version: number; status: 'active' | 'revoked'; limits: KeyLimits; probe: boolean }
export interface SnapshotAccount {
  account: AccountId;
  keys: SnapshotKey[];
  kyb: { status: 'passed' | 'failed' | 'withdrawn' | 'none'; version: number };
}

export type CatchUpAnswer =
  | { kind: 'events'; events: unknown[] /* IdentityStatusEvent: AM-I9 */; read_timestamp: EpochMicros }
  | { kind: 'snapshot'; state: SnapshotAccount[]; position: EpochMicros; read_timestamp: EpochMicros }
  | { kind: 'temporarily_unavailable' };

/** The identity catch-up query (C08 §B, gRPC). The account owner is the caller. */
export interface IdentityCatchUp {
  catchUp(req: CatchUpRequest): Promise<CatchUpAnswer>;
}
