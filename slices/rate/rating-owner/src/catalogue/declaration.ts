import type { OwnerDeclaration } from '@share/owner-runtime';

export const TOPIC_CATALOGUE = 'catalogue.v1';

export const CATALOGUE_ENTRY = { version: 1, checkpoint: 2 } as const;

/**
 * The catalogue owner kind (RFC-003 §6; C06 §2). One partition for each entity
 * (`<entityType>:<entityId>`). The only writer of `catalogue.v1` (C06 D7).
 * The topic is the C06 name; C01 §2.5 asks for `<kind>.<feed>.v<n>` (a contract issue).
 */
export const catalogueDeclaration: OwnerDeclaration = {
  kind: 'catalogue',
  slotCount: 16,
  entryKinds: [
    { kind: CATALOGUE_ENTRY.version, name: 'version', schemaVersions: [1], retention: '7y' },
    { kind: CATALOGUE_ENTRY.checkpoint, name: 'checkpoint', schemaVersions: [1], retention: 'ops' },
  ],
  projections: [
    { name: 'entity', ddl: 'partition BYTES NOT NULL, entity_version INT8 NOT NULL, body BYTES NOT NULL, PRIMARY KEY (partition)',
      clearColumns: ['partition', 'entity_version', 'body'] },
  ],
  streams: [
    { name: 'catalogue', topic: TOPIC_CATALOGUE, key: 'partition', emitFn: { version: 1 }, closure: 'resolved',
      consumers: ['account', 'attr_a', 'rating', 'settlement', 'funds'] },
  ],
};
