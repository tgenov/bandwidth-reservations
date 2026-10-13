import type { OwnerDeclaration } from '@share/owner-runtime';
import { slotOfPartition } from '@share/owner-runtime';
import { tenantPartition, type Tenant } from '@share/iam-lib';

/** C01 names the identity owner kind `iam` (C01 §2.1); topics are `iam.<feed>.v<n>`. */
export const IAM_KIND = 'iam';
/** ‹iam_slots› (256, est., RFC-005 §13). */
export const IAM_SLOTS = 256;
export const STATUS_TOPIC = 'iam.status.v1';
export const STATUS_CLOSURE_TOPIC = 'iam.status.v1.closure';

export const ENTRY = { keyIssued: 1, keyRevoked: 2 } as const;

/** The identity owner kind, I1 part: key records and the identity status push (C08 §B). */
export const declaration: OwnerDeclaration = {
  kind: IAM_KIND,
  slotCount: IAM_SLOTS,
  entryKinds: [
    { kind: ENTRY.keyIssued, name: 'key_issued', schemaVersions: [1], retention: '7y' },
    { kind: ENTRY.keyRevoked, name: 'key_revoked', schemaVersions: [1], retention: '7y' },
  ],
  projections: [
    {
      name: 'key',
      ddl: 'partition BYTES NOT NULL, key_id STRING NOT NULL, version INT8 NOT NULL, status STRING NOT NULL, '
        + 'verifier BYTES NOT NULL, limits BYTES NOT NULL, probe BOOL NOT NULL, PRIMARY KEY (partition, key_id)',
      // The verifier and the limits stay sealed (C13); only keys and status are clear.
      clearColumns: ['partition', 'key_id', 'version', 'status', 'probe'],
    },
  ],
  streams: [
    {
      name: 'status', topic: STATUS_TOPIC, key: 'partition', emitFn: { version: 1 },
      // Resolved markers come from the closure emitter on iam.status.v1.closure (C01 §3.6; plan CI5-5).
      closure: 'resolved', consumers: ['account'],
    },
  ],
};

/** `route("identity", tenant).slot` with the C01 I1 fixed map (slot = home mod slotCount). */
export function identitySlotOf(t: Tenant): number {
  return slotOfPartition(tenantPartition(t), IAM_SLOTS);
}

export default declaration;
