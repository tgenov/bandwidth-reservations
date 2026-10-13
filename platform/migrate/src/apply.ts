import pg from 'pg';
import type { OwnerDeclaration } from '@share/owner-runtime';
import { kindMigration, platformMigration, type Migration } from './generate.ts';
import { grantMigration, type GrantOptions } from './grants.ts';
import { assertClearColumns } from './clear-columns.ts';

export interface ApplyReport { applied: Array<{ id: string; statements: number }> }

/** Apply migrations in order. Every statement is idempotent, so a re-run converges. */
export async function applyMigrations(connectionString: string, migrations: Migration[]): Promise<ApplyReport> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const applied: ApplyReport['applied'] = [];
    for (const m of migrations) {
      for (const sql of m.statements) await client.query(sql);
      await client.query(
        'UPSERT INTO platform_migrations (id, statements, applied_at) VALUES ($1, $2, now())', [m.id, m.statements.length]);
      applied.push({ id: m.id, statements: m.statements.length });
    }
    return { applied };
  } finally {
    await client.end();
  }
}

export async function migrateKinds(connectionString: string, declarations: OwnerDeclaration[],
  opts: { presplit?: boolean; grants?: boolean | GrantOptions } = {}): Promise<ApplyReport> {
  const kinds = declarations.map((d) => kindMigration(d, opts));
  // C01 CP-13 (RFC-005 RK-8): refuse a clear column outside the declared set before any statement runs.
  declarations.forEach((d, i) => assertClearColumns(d, kinds[i]?.statements ?? []));
  const ms = [platformMigration(), ...kinds];
  if (opts.grants) ms.push(grantMigration(declarations, typeof opts.grants === 'object' ? opts.grants : {}));
  return applyMigrations(connectionString, ms);
}
