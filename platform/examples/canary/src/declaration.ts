import type { OwnerDeclaration } from '@share/owner-runtime';

/** The canary reference owner kind (RFC-006 §18.5): one counter per partition. */
export const declaration: OwnerDeclaration = {
  kind: 'canary',
  slotCount: 16,
  entryKinds: [
    { kind: 1, name: 'incremented', schemaVersions: [1], retention: 'ops' },
    { kind: 2, name: 'takeover', schemaVersions: [1], retention: 'ops' },
  ],
  projections: [
    {
      name: 'counter',
      ddl: 'partition BYTES NOT NULL, value INT8 NOT NULL, PRIMARY KEY (partition)',
      clearColumns: ['partition', 'value'],
    },
    {
      name: 'applied',   // idempotency: one row per applied command identity (A6)
      ddl: 'partition BYTES NOT NULL, identity BYTES NOT NULL, seq INT8 NOT NULL, PRIMARY KEY (partition, identity)',
      clearColumns: ['partition', 'identity', 'seq'],
    },
  ],
  streams: [
    { name: 'counter', topic: 'canary.counter.v1', key: 'partition', emitFn: { version: 1 }, closure: 'none', consumers: [] },
  ],
};

export default declaration;
