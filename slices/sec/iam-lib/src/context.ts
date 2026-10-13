/**
 * C1 library: the principal context of C08 §A, its wire bytes (gRPC metadata "x-share-principal-bin",
 * JCS bytes), the receiver preconditions (C08 §A, consumer test C-01) and the audit field set (§J).
 */
import { jcs, jcsText, without } from './jcs.ts';
import { sameTenant } from './policy.ts';
import { DOMAINS } from './sign.ts';
import type { CertStore } from './certs.ts';
import {
  IDENTITY_CERT_OWNER_KIND,
  type AuditFields, type EpochMicros, type KeyLimits, type PrincipalContext, type SignedKeyRecord, type Tenant,
} from './types.ts';

/** `context_ttl` = 60 s from `received_at` (C08 "Timeouts"). */
export const CONTEXT_TTL_MICROS = 60_000_000n;
export const CONTEXT_METADATA_KEY = 'x-share-principal-bin';

export function encodeContext(ctx: PrincipalContext): Uint8Array {
  return jcs(ctx);
}

function big(v: unknown, field: string): bigint {
  if (typeof v !== 'string' || !/^-?\d+$/.test(v)) throw new Error(`context: ${field} is not a decimal string`);
  return BigInt(v);
}
function bigOrNull(v: unknown, field: string): bigint | null {
  return v === null ? null : big(v, field);
}

function reviveLimits(o: Record<string, unknown>): KeyLimits {
  return {
    key_spend_limit_micro_usd: bigOrNull(o['key_spend_limit_micro_usd'], 'key_spend_limit_micro_usd'),
    key_inflight_limit_mbps: bigOrNull(o['key_inflight_limit_mbps'], 'key_inflight_limit_mbps'),
    key_rate_limit_per_s: Number(o['key_rate_limit_per_s']),
  };
}

/** Parse context bytes. Throws on a malformed context (the receiver then refuses it). */
export function decodeContext(bytes: Uint8Array): PrincipalContext {
  const o = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
  if (o['schema'] !== 'principal.v1') throw new Error('context: unknown schema');
  const auth = o['auth'] as Record<string, unknown>;
  const ctx = {
    ...o,
    auth: { ...auth, at: big(auth['at'], 'auth.at') },
    received_at: big(o['received_at'], 'received_at'),
    expires_at: big(o['expires_at'], 'expires_at'),
  } as unknown as PrincipalContext;
  const kr = o['key_record'] as Record<string, unknown> | undefined;
  if (kr) {
    ctx.key_record = {
      ...kr,
      committed_at: big(kr['committed_at'], 'key_record.committed_at'),
      limits: reviveLimits(kr['limits'] as Record<string, unknown>),
    } as unknown as SignedKeyRecord;
  }
  return ctx;
}

/** The receiver's applied state of one key, from the push or catch-up (C08 §B). */
export interface AppliedKey { version: number; status: 'active' | 'revoked'; limits?: KeyLimits }

export interface ReceiverEnv {
  /** The mTLS peer's workload identity. */
  peerWorkload: string;
  /** Peers allowed to send this command (RFC-005 §4.4; the edge for external principals). */
  allowlist: ReadonlySet<string>;
  now: EpochMicros;
  /** The tenant of the partition the command is for. */
  partitionTenant: Tenant;
  certs: CertStore;
  /** `route("identity", tenant).slot`. */
  identitySlotOf(tenant: Tenant): number;
  /** The applied state of the context's key, if the push or catch-up brought it. */
  appliedKey?: AppliedKey;
  /** The highest policy version this receiver has applied. */
  policyVersionApplied: number;
}

export type ContextVerdict =
  | { ok: true; ctx: PrincipalContext; limits?: KeyLimits; provisional: boolean }
  | { ok: false; answer: 'peer_refused' | 'unauthenticated' | 'not_found' | 'temporarily_unavailable'; reason: string };

/**
 * C08 §A receiver preconditions. An invalid context never reaches an effect; there is no fallback identity.
 * A key record that does not verify, or whose key is applied as revoked, or whose version is lower than the
 * applied one, is ignored; with no other source for the key, the answer is "unauthenticated" (C10 401).
 */
export function checkContext(bytes: Uint8Array, env: ReceiverEnv): ContextVerdict {
  if (!env.allowlist.has(env.peerWorkload)) return { ok: false, answer: 'peer_refused', reason: 'peer_not_allowed' };
  let ctx: PrincipalContext;
  try {
    ctx = decodeContext(bytes);
  } catch (e) {
    return { ok: false, answer: 'unauthenticated', reason: `malformed: ${(e as Error).message}` };
  }
  if (env.now > ctx.expires_at) return { ok: false, answer: 'unauthenticated', reason: 'expired' };
  if (!sameTenant(ctx.tenant, env.partitionTenant)) return { ok: false, answer: 'not_found', reason: 'tenant_not_partition' };
  if (ctx.policy_version > env.policyVersionApplied) {
    return { ok: false, answer: 'temporarily_unavailable', reason: 'policy_version_not_applied' };
  }
  if (ctx.kind !== 'agent_key' && ctx.kind !== 'supplier_key') return { ok: true, ctx, provisional: false };

  const applied = env.appliedKey;
  if (applied?.status === 'revoked') return { ok: false, answer: 'unauthenticated', reason: 'key_applied_revoked' };
  const kr = ctx.key_record;
  const recordUsable = kr !== undefined && keyRecordValid(ctx, kr, env) === undefined
    && (applied === undefined || kr.version >= applied.version);
  if (applied?.status === 'active') {
    return { ok: true, ctx, ...(applied.limits ? { limits: applied.limits } : {}), provisional: false };
  }
  if (!recordUsable || !kr) {
    return { ok: false, answer: 'unauthenticated', reason: kr ? `key_record_${keyRecordValid(ctx, kr, env) ?? 'lower_version'}` : 'no_key_record' };
  }
  // The record's limits govern this request only (provisional, in memory) until the push brings the key.
  return { ok: true, ctx, limits: kr.limits, provisional: true };
}

/** Why a key record is not valid for this context and partition, or `undefined` when it is valid. */
export function keyRecordValid(ctx: PrincipalContext, kr: SignedKeyRecord, env: ReceiverEnv): string | undefined {
  if (kr.key_id !== ctx.key_id) return 'key_id_mismatch';
  if (kr.status !== 'active') return 'not_active';
  if (!sameTenant(kr.tenant, env.partitionTenant)) return 'tenant_not_partition';
  if (kr.identity_slot !== env.identitySlotOf(kr.tenant)) return 'wrong_identity_slot';
  const v = env.certs.verify(DOMAINS.keyRecord, without(kr, 'signature'), kr.signature, {
    purpose: 'identity_record', owner_kind: IDENTITY_CERT_OWNER_KIND, slot: kr.identity_slot, epoch: kr.epoch,
    validAt: { committed_at: kr.committed_at },
  }, env.now);
  return v.ok ? undefined : v.reason;
}

/** The C08 §J field set a receiver copies from the context into the `audit` column (C08 §A "Outcomes"). */
export function auditFromContext(ctx: PrincipalContext): AuditFields {
  return {
    schema: 'audit.v1',
    principal: {
      principal_id: ctx.principal_id, kind: ctx.kind, tenant: ctx.tenant,
      ...(ctx.key_id === undefined ? {} : { key_id: ctx.key_id }),
      ...(ctx.session_id === undefined ? {} : { session_id: ctx.session_id }),
      ...(ctx.cert_serial === undefined ? {} : { cert_serial: ctx.cert_serial }),
      edge_workload: ctx.edge_workload,
    },
    received_at: ctx.received_at,
    request_id: ctx.request_id,
    decided_at: 'commit',
    policy_version: ctx.policy_version,
    iam_position: ctx.iam_position,
  };
}

/** The field set of an internal service (an owner applying a feed, a fixture command). */
export function internalAudit(workload: string, policy_version = 1): AuditFields {
  return {
    schema: 'audit.v1',
    principal: { principal_id: 'internal_service', kind: 'internal_service', tenant: { kind: 'none' }, edge_workload: workload },
    decided_at: 'commit',
    policy_version,
  };
}

/** Debug text of a context (JCS); never logged with keys or secrets, as the context carries neither. */
export function contextText(ctx: PrincipalContext): string {
  return jcsText(ctx);
}
