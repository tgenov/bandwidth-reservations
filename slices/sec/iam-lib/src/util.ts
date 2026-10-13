import type { HlcTs } from '@share/owner-runtime';
import type { EpochMicros, Tenant } from './types.ts';

/** C08 "Units": an HLC timestamp floored to the microsecond. */
export function hlcToMicros(ts: HlcTs): EpochMicros {
  const wall = ts.split('.')[0] ?? '0';
  return BigInt(wall) / 1000n;
}

/** The identity partition of a tenant (identity is partitioned by tenant, RFC-005 §3.1). */
export function tenantPartition(t: Tenant): Uint8Array {
  const s = t.kind === 'account' ? `account/${t.account}` : t.kind === 'supplier' ? `supplier/${t.supplier}` : 'none';
  return new Uint8Array(Buffer.from(s, 'utf8'));
}
