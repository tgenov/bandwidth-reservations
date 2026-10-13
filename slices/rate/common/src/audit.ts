import type { AuditFields } from '@share/owner-runtime';
import { createHash } from 'node:crypto';

/** The audit fields of an entry that an S-RATE owner writes from a feed or a timer (C08 §J). */
export function serviceAudit(service: string): AuditFields {
  return {
    schema: 'audit.v1',
    principal: { principal_id: service, kind: 'internal_service', tenant: 'none' },
    decided_at: 'commit',
    policy_version: 1,
  };
}

/** A deterministic entry identity from its parts (C01 §3.2: every identity is deterministic). */
export function identityOf(...parts: string[]): Uint8Array {
  const h = createHash('sha256');
  for (const p of parts) h.update(Buffer.from(`${p.length}:${p}`, 'utf8'));
  return new Uint8Array(h.digest());
}
