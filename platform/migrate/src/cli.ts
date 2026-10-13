#!/usr/bin/env node
/** owner-migrate <declaration-module.ts> [--print] — exports `declaration` (or default) as an OwnerDeclaration. */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { OwnerDeclaration } from '@share/owner-runtime';
import { kindMigration, platformMigration } from './generate.ts';
import { applyMigrations } from './apply.ts';
import { assertClearColumns } from './clear-columns.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  process.stderr.write('usage: owner-migrate <declaration-module> [--print] [--no-presplit]\n');
  process.exit(2);
}
const mod = await import(pathToFileURL(resolve(file)).href) as { declaration?: OwnerDeclaration; default?: OwnerDeclaration };
const decl = mod.declaration ?? mod.default;
if (!decl) throw new Error(`${file} exports no declaration`);
const kind = kindMigration(decl, { presplit: !args.includes('--no-presplit') });
assertClearColumns(decl, kind.statements);   // C01 CP-13 schema lint, before printing or applying
const migrations = [platformMigration(), kind];
if (args.includes('--print')) {
  for (const m of migrations) process.stdout.write(`-- ${m.id}\n${m.statements.join(';\n\n')};\n\n`);
} else {
  const url = process.env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';
  process.stdout.write(`${JSON.stringify(await applyMigrations(url, migrations))}\n`);
}
