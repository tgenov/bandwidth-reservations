import type { OwnerDeclaration, ProjectionWrite, RowRef } from './api.ts';
import { stableStringify } from './bytes.ts';
import { assertIdentifier, tableNames } from './declaration.ts';

/** Canonical identity of a row reference (table + key), used for batch-local overlays and maps. */
export function rowId(ref: RowRef): string {
  return `${ref.table}|${stableStringify(ref.key)}`;
}

export type KeyObject = Record<string, unknown>;

export function keyObject(ref: { table: string; key: unknown }): KeyObject {
  const k = ref.key;
  if (k === null || typeof k !== 'object' || Array.isArray(k) || k instanceof Uint8Array) {
    throw new Error(`row key of ${ref.table} must be an object of column → value`);
  }
  for (const c of Object.keys(k)) assertIdentifier(c);
  return k as KeyObject;
}

/** Tables an owner may name in RowRef / ProjectionWrite: its projections and its head (C01 §3.2). */
export function resolveTable(d: OwnerDeclaration, table: string): { kind: 'projection' | 'head'; deletable: boolean } {
  const t = tableNames(d.kind);
  if (table === t.head) return { kind: 'head', deletable: false };
  const p = d.projections.find((x) => t.projection(x.name) === table);
  if (!p) throw new Error(`${table} is not a table of owner kind ${d.kind}`);
  return { kind: 'projection', deletable: p.deletable === true };
}

/** Preconditions of C01 §3.2: projection writes only on declared projections, delete only if deletable. */
export function checkProjectionWrite(d: OwnerDeclaration, w: ProjectionWrite): void {
  const r = resolveTable(d, w.table);
  if (r.kind !== 'projection') throw new Error(`${w.table}: owners write the head only through append`);
  if (w.op === 'delete' && !r.deletable) throw new Error(`${w.table} is not declared deletable (C01 §2.2)`);
  keyObject(w);
  if (w.op === 'upsert') {
    const row = w.row;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${w.table}: upsert needs a row object`);
    for (const c of Object.keys(row)) assertIdentifier(c);
  }
}
