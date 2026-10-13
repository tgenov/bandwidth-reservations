/**
 * C2 library: the pure `decide` of C08 §A over a `PolicyBundle` of C08 §N, and the fixed version-1
 * bundle of S-SEC I1 (book and status rows of RFC-005 §4.2 only). I2 adds the full matrix.
 */
import { jcs, without } from './jcs.ts';
import type { Decision, Operation, PolicyBundle, PrincipalContext, Resource, Tenant } from './types.ts';
import { createHash } from 'node:crypto';

/** Permission-matrix row identifiers of I1. */
export const OPS = {
  /** "Book, change, cancel, withdraw (own account)". */
  bookingSubmit: 'booking.submit',
  /** "Status of own requests; own reservations; balance and headroom". */
  bookingStatus: 'booking.status',
} as const;

export type UnsignedPolicyBundle = Omit<PolicyBundle, 'signature'>;

/** The fixed version-1 bundle (plan S-SEC I1). Identity signs it when it serves `get_policy`. */
export function policyV1(slot: number, committed_at: bigint): UnsignedPolicyBundle {
  return {
    schema: 'iam.policy.v1',
    policy_version: 1,
    matrix: [
      {
        operation: OPS.bookingSubmit,
        allow: [
          { principal_kind: 'account_user', scope: 'own_tenant' },
          { principal_kind: 'agent_key', scope: 'own_tenant' },
          { principal_kind: 'probe', scope: 'probe_links_only' },
        ],
        refused_recorded: [],
      },
      {
        operation: OPS.bookingStatus,
        allow: [
          { principal_kind: 'account_user', scope: 'own_tenant' },
          { principal_kind: 'agent_key', scope: 'own_tenant' },
          { principal_kind: 'probe', scope: 'own_tenant' },
        ],
        refused_recorded: [],
      },
    ],
    catalogue: [],
    read_types: [],
    allowlist: [],
    limits: { operator_read_limit_per_h: 200, breadth_alert_targets_per_h: 20 },
    committed_at,
    slot,
  };
}

/** matrix_digest = SHA-256(JCS(bundle without signature)) (C08 §N). */
export function matrixDigest(bundle: PolicyBundle | UnsignedPolicyBundle): Uint8Array {
  const unsigned = 'signature' in bundle ? without(bundle, 'signature') : bundle;
  return new Uint8Array(createHash('sha256').update(jcs(unsigned)).digest());
}

export function sameTenant(a: Tenant, b: Tenant): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'account' && b.kind === 'account') return a.account === b.account;
  if (a.kind === 'supplier' && b.kind === 'supplier') return a.supplier === b.supplier;
  return a.kind === 'none';
}

/**
 * C08 §A `decide`. Pure: the same inputs give the same answer everywhere.
 * Order (RFC-005 §2.3): a resource outside the principal's tenant is `not_found`, before any check of
 * rights, so the answer is the same as for a resource that does not exist. Then deny unless a row permits.
 */
export function decide(ctx: PrincipalContext, op: Operation, res: Resource, policy: PolicyBundle | UnsignedPolicyBundle): Decision {
  const v = policy.policy_version;
  if (ctx.schema !== 'principal.v1') return { result: 'unauthenticated', policy_version: v };
  if (res.tenant && !sameTenant(res.tenant, ctx.tenant)) return { result: 'not_found', policy_version: v };
  const row = policy.matrix.find((r) => r.operation === op);
  const allow = row?.allow.filter((a) => a.principal_kind === ctx.kind) ?? [];
  for (const a of allow) {
    if (a.requires_administrator && !ctx.rights.administrator) continue;
    switch (a.scope) {
      case 'own_tenant':
        return { result: 'permit', policy_version: v };
      case 'own_key':
        if (res.id !== undefined && res.id === ctx.key_id) return { result: 'permit', policy_version: v };
        return { result: 'not_found', policy_version: v };
      case 'probe_links_only':
        // The edge permits by kind; the owner checks the link with C2 (C10 R40-25).
        if (ctx.probe) return { result: 'permit', policy_version: v };
        break;
      case 'own_supplier_links':
        if (ctx.tenant.kind === 'supplier') return { result: 'permit', policy_version: v };
        break;
    }
  }
  return { result: 'refused', right: op, policy_version: v };
}
