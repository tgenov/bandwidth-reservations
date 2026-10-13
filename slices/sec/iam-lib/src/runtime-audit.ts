/**
 * Map the C08 §J field set to the stand-in `AuditFields` type of `@share/owner-runtime`.
 *
 * Runtime API gap (STATUS-I1.md): the runtime's stand-in has `principal.tenant: string`,
 * `principal.kind: string` and `received_at: number`, where C08 §J has a `Tenant` object, a
 * `PrincipalKind` and `EpochMicros` (bigint). This mapping is reversible: tenant → "account:<id>",
 * "supplier:<id>" or "none"; received_at → a number of µs (exact below 2^53, until about 2255).
 */
import type { AuditFields as RuntimeAuditFields } from '@share/owner-runtime';
import type { AuditFields, Tenant } from './types.ts';

export function tenantText(t: Tenant): string {
  return t.kind === 'account' ? `account:${t.account}` : t.kind === 'supplier' ? `supplier:${t.supplier}` : 'none';
}

export function tenantFromText(s: string): Tenant {
  if (s.startsWith('account:')) return { kind: 'account', account: s.slice('account:'.length) };
  if (s.startsWith('supplier:')) return { kind: 'supplier', supplier: s.slice('supplier:'.length) };
  return { kind: 'none' };
}

export function toRuntimeAudit(a: AuditFields): RuntimeAuditFields {
  const { principal, received_at, ...rest } = a;
  return {
    ...rest,
    principal: { ...principal, tenant: tenantText(principal.tenant) },
    ...(received_at === undefined ? {} : { received_at: Number(received_at) }),
  };
}
