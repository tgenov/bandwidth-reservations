import type { OwnerDeclaration } from './api.ts';
import { isPowerOfTwo } from './home.ts';

const IDENT = /^[a-z][a-z0-9_]*$/;
const TOPIC = /^[a-z][a-z0-9_]*\.[a-z0-9_.-]+\.v[0-9]+$/;

export function isIdentifier(s: string): boolean {
  return IDENT.test(s);
}

export function assertIdentifier(s: string): string {
  if (!IDENT.test(s)) throw new Error(`not a safe SQL identifier: ${JSON.stringify(s)}`);
  return s;
}

export const tableNames = (kind: string) => ({
  log: `${kind}_log`,
  head: `${kind}_head`,
  outbox: `${kind}_outbox`,
  streamIndex: `${kind}_stream_index`,
  projection: (name: string) => `${kind}_${name}`,
});

/** Primary-key column list of a projection DDL body or CREATE TABLE statement, lower-cased. */
export function projectionKeyColumns(ddl: string): string[] {
  const m = /PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(ddl);
  if (!m || m[1] === undefined) return [];
  return m[1].split(',').map((c) => c.trim().split(/\s+/)[0]?.toLowerCase() ?? '').filter((c) => c.length > 0);
}

/** Errors in a declaration that the runtime and the migration tool both refuse (C01 §2.2, R47-01). */
export function validateDeclaration(d: OwnerDeclaration): string[] {
  const errors: string[] = [];
  if (!isIdentifier(d.kind)) errors.push(`kind ${d.kind} is not an identifier`);
  if (!isPowerOfTwo(d.slotCount)) errors.push(`slotCount ${d.slotCount} is not a power of two`);
  const kinds = new Set<number>();
  for (const e of d.entryKinds) {
    if (!Number.isInteger(e.kind) || e.kind < -32768 || e.kind > 32767) errors.push(`entry kind ${e.kind} is not int16`);
    if (kinds.has(e.kind)) errors.push(`entry kind ${e.kind} declared twice`);
    kinds.add(e.kind);
    if (e.schemaVersions.length === 0) errors.push(`entry kind ${e.name} has no schema version`);
  }
  for (const p of d.projections) {
    if (!isIdentifier(p.name)) errors.push(`projection ${p.name} is not an identifier`);
    const key = projectionKeyColumns(p.ddl);
    if (key.length === 0) errors.push(`projection ${p.name} declares no PRIMARY KEY`);
    // C01 §2.2, R47-01: a key beginning with `slot` is rejected.
    if (key[0] === 'slot') errors.push(`projection ${p.name}: key begins with slot (R47-01)`);
    if (key[0] === 'home_key' && key[1] !== 'partition') errors.push(`projection ${p.name}: home_key must be followed by partition`);
  }
  const names = new Set<string>();
  for (const s of d.streams) {
    if (names.has(s.name)) errors.push(`stream ${s.name} declared twice`);
    names.add(s.name);
    if (!TOPIC.test(s.topic) || !s.topic.startsWith(`${d.kind}.`)) errors.push(`stream ${s.name}: topic ${s.topic} is not <kind>.<feed>.v<n>`);
  }
  if (d.selfOutboxed) errors.push('selfOutboxed kinds are I2 (C01 §2.3 stream index); not supported in I1a');
  return errors;
}

export function assertDeclaration(d: OwnerDeclaration): void {
  const errors = validateDeclaration(d);
  if (errors.length > 0) throw new Error(`invalid OwnerDeclaration ${d.kind}:\n  ${errors.join('\n  ')}`);
}

export function retentionCode(d: OwnerDeclaration, entryKind: number): number {
  const e = d.entryKinds.find((k) => k.kind === entryKind);
  if (!e) throw new Error(`entry kind ${entryKind} is not declared by ${d.kind}`);
  return e.retention === 'ops' ? 1 : 0;
}
