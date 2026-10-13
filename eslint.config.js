// ESLint: a small set of rules that matter for this code (docs/process/engineering.md).
// Scope: the workspaces under platform/, slices/ and contracts/. The older top-level src/, test/ and
// billing/ code is outside the engineering standard and is not linted.
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import local from './tools/eslint/plugin.js';

const root = import.meta.dirname;

/** Workspace package names by owner: the slice name, or 'platform' / 'contracts' (as tools/check_boundaries.py). */
function packagesByOwner() {
  const ws = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces;
  const out = new Map();
  for (const w of ws) {
    const name = JSON.parse(fs.readFileSync(path.join(root, w, 'package.json'), 'utf8')).name;
    const parts = w.split('/');
    const owner = parts[0] === 'slices' ? parts[1] : parts[0];
    if (!out.has(owner)) out.set(owner, []);
    out.get(owner).push(name);
  }
  return out;
}

const owners = packagesByOwner();
const slices = [...owners.keys()].filter((o) => o !== 'platform' && o !== 'contracts');

/** A no-restricted-imports block that bans the packages of the given slices. */
function banSlices(files, banned, why) {
  const names = banned.flatMap((s) => owners.get(s));
  return {
    files,
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: names.flatMap((n) => [n, `${n}/*`]), message: `${why} (engineering.md §3; tools/check_boundaries.py).` }],
      }],
    },
  };
}

const TS = ['platform/**/*.ts', 'slices/**/*.ts', 'contracts/**/*.ts'];
const TEST_FILES = ['**/test/**/*.ts', '**/testing/**/*.ts', 'contracts/suites/src/**/*.ts'];

export default defineConfig(
  { ignores: ['**/node_modules/**', 'billing/**', 'src/**', 'test/**', '**/*.d.ts', '**/*.js'] },
  {
    files: TS,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: root },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { '@typescript-eslint': tseslint.plugin, local },
    rules: {
      // A dropped promise is a lost commit or a leaked session.
      // node:test runs a registered test whether or not its promise is awaited, so test()/it()/describe() are safe.
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite'] }],
      }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      'no-console': 'error',
    },
  },
  // Slice boundaries: a slice imports no other slice; the platform and the contract suites import no slice.
  ...slices.map((s) => banSlices([`slices/${s}/**/*.ts`], slices.filter((o) => o !== s), `slice '${s}' must not import another slice`)),
  banSlices(['platform/**/*.ts'], slices, 'the platform must not import a slice'),
  banSlices(['contracts/**/*.ts'], slices, 'the contract suites must not import a slice'),
  // engineering.md §5: code never reads the wall clock directly. The runtime's clock module is the one place.
  {
    files: ['**/src/**/*.ts'],
    ignores: ['platform/runtime/src/clock.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'Do not read the wall clock: use the injected clock (platform/runtime/src/clock.ts; engineering.md §5).' },
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'Do not read the wall clock: use the injected clock (platform/runtime/src/clock.ts; engineering.md §5).' },
      ],
    },
  },
  // Test files: console is allowed; every test asserts; test names follow engineering.md §7.
  { files: [...TEST_FILES, 'platform/examples/**/*.ts'], rules: { 'no-console': 'off' } },
  {
    files: ['**/*.test.ts'],
    rules: { 'local/test-asserts': 'error', 'local/test-name': 'warn' },
  },
);
