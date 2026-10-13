import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OwnerDeclaration } from '@share/owner-runtime';
import type { GrantOptions, GrantsQueryable } from '../src/index.ts';
import { checkGrants, expectedPrivileges, grantMigration, platformMigration } from '../src/index.ts';

const T = { timeout: 10_000 };

const canary: OwnerDeclaration = {
  kind: 'canary', slotCount: 8,
  entryKinds: [{ kind: 1, name: 'incremented', schemaVersions: [1], retention: 'ops' }],
  projections: [{ name: 'request', ddl: 'partition BYTES NOT NULL, request STRING NOT NULL, PRIMARY KEY (partition, request)', clearColumns: [] }],
  streams: [{ name: 'counter', topic: 'canary.counter.v1', key: 'partition', emitFn: { version: 1 }, closure: 'none', consumers: [] }],
};
const ingx: OwnerDeclaration = {
  kind: 'ingx', slotCount: 4, selfOutboxed: true, statusReaders: true,
  entryKinds: [{ kind: 1, name: 'row', schemaVersions: [1], retention: '7y' }],
  projections: [],
  streams: [{ name: 'handoff', topic: 'ingx.handoff.v1', key: 'partition', emitFn: { version: 1 }, closure: 'resolved', consumers: ['attr'] }],
};

const predicate = (kind: string, table: string): string =>
  `EXISTS (SELECT 1 FROM placement_integrity_stops s WHERE s.kind = '${kind}' AND s.partition = ${table}.partition AND s.state = 'stopped')`;
const restorePolicies = (kind: string, table: string): string[] => [
  `DROP POLICY IF EXISTS restore_only_stopped ON ${table}`,
  `CREATE POLICY restore_only_stopped ON ${table} AS PERMISSIVE FOR ALL TO restore USING (${predicate(kind, table)}) WITH CHECK (${predicate(kind, table)})`,
  `DROP POLICY IF EXISTS restore_confined ON ${table}`,
  `CREATE POLICY restore_confined ON ${table} AS RESTRICTIVE FOR ALL TO restore USING (${predicate(kind, table)}) WITH CHECK (${predicate(kind, table)})`,
];
const writePolicy = (table: string, role: string): string[] => [
  `DROP POLICY IF EXISTS ${table}_write_${role} ON ${table}`,
  `CREATE POLICY ${table}_write_${role} ON ${table} FOR ALL TO ${role} USING (true) WITH CHECK (true)`,
];
const readPolicy = (table: string, role: string): string[] => [
  `DROP POLICY IF EXISTS ${table}_read_${role} ON ${table}`,
  `CREATE POLICY ${table}_read_${role} ON ${table} FOR SELECT TO ${role} USING (true)`,
];
const forced = (table: string): string[] => [`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`];

const restorePrivileges = (decls: OwnerDeclaration[], opts: GrantOptions): Array<[string, string[]]> =>
  [...(expectedPrivileges(decls, opts).get('restore') ?? new Map<string, Set<string>>())].map(([t, p]) => [t, [...p].sort()]);

test('C01 CP-6 should grant restore SELECT, INSERT, UPDATE on each log and head and SELECT on placement_integrity_stops when row-level security is on', T, () => {
  assert.deepEqual(restorePrivileges([canary, ingx], { rowLevelSecurity: true }), [
    ['placement_integrity_stops', ['SELECT']],
    ['canary_log', ['INSERT', 'SELECT', 'UPDATE']],
    ['canary_head', ['INSERT', 'SELECT', 'UPDATE']],
    ['ingx_log', ['INSERT', 'SELECT', 'UPDATE']],
    ['ingx_head', ['INSERT', 'SELECT', 'UPDATE']],
  ]);
  const st = grantMigration([canary], { rowLevelSecurity: true }).statements;
  assert.ok(st.includes('CREATE ROLE IF NOT EXISTS restore'));
  assert.deepEqual(st.filter((s) => / TO restore$/.test(s) && s.startsWith('GRANT')), [
    'GRANT SELECT ON TABLE placement_integrity_stops TO restore',
    'GRANT INSERT, SELECT, UPDATE ON TABLE canary_log, canary_head TO restore',
  ]);
});

test('C01 CP-6 should grant restore no privilege on a log or head (fail closed) when row-level security is off', T, () => {
  assert.deepEqual(restorePrivileges([canary, ingx], {}), [['placement_integrity_stops', ['SELECT']]]);
  const st = grantMigration([canary]).statements;
  assert.deepEqual(st.filter((s) => /\brestore\b/.test(s)), [
    'CREATE ROLE IF NOT EXISTS restore',
    'GRANT SELECT ON TABLE placement_integrity_stops TO restore',
  ]);
});

test('C01 CP-6 should give restore no grant on audit\'s stops table and no DELETE when generating grants', T, () => {
  for (const opts of [{}, { rowLevelSecurity: true }]) {
    const st = grantMigration([canary, ingx], opts).statements;
    assert.deepEqual(st.filter((s) => /(^|[^_])integrity_stops|audit_integrity_stops/.test(s)), []);
    assert.deepEqual(st.filter((s) => / TO restore$/.test(s) && /DELETE/.test(s)), []);
  }
});

test('C01 CP-6 should force row-level security on log and head with restore_only_stopped and restore_confined over placement_integrity_stops, and keep each granted role working, when row-level security is on', T, () => {
  const st = grantMigration([canary], { rowLevelSecurity: true }).statements;
  assert.deepEqual(st.filter((s) => /\bcanary_(log|head)\b/.test(s) && /POLICY|ROW LEVEL SECURITY/.test(s)), [
    ...forced('canary_log'),
    ...writePolicy('canary_log', 'canary'),
    ...readPolicy('canary_log', 'history_sealer'),
    ...readPolicy('canary_log', 'standby_canary'),
    ...restorePolicies('canary', 'canary_log'),
    ...forced('canary_head'),
    ...writePolicy('canary_head', 'canary'),
    ...readPolicy('canary_head', 'standby_canary'),
    ...restorePolicies('canary', 'canary_head'),
  ]);
});

test('should add read policies for status_reader and the gap-fill roles of a self-outboxed log when row-level security is on', T, () => {
  const st = grantMigration([ingx], { rowLevelSecurity: true }).statements;
  assert.deepEqual(st.filter((s) => /\bingx_(log|head)\b/.test(s) && /POLICY|ROW LEVEL SECURITY/.test(s)), [
    ...forced('ingx_log'),
    ...writePolicy('ingx_log', 'ingx'),
    ...readPolicy('ingx_log', 'history_sealer'),
    ...readPolicy('ingx_log', 'status_reader'),
    ...readPolicy('ingx_log', 'standby_ingx'),
    ...readPolicy('ingx_log', 'gapfill_attr_ingx'),
    ...restorePolicies('ingx', 'ingx_log'),
    ...forced('ingx_head'),
    ...writePolicy('ingx_head', 'ingx'),
    ...readPolicy('ingx_head', 'status_reader'),
    ...readPolicy('ingx_head', 'standby_ingx'),
    ...restorePolicies('ingx', 'ingx_head'),
  ]);
});

test('C01 CP-6 should name one role in every policy, never PUBLIC, and confine only restore with a restrictive policy when row-level security is on', T, () => {
  const policies = grantMigration([canary, ingx], { rowLevelSecurity: true }).statements.filter((s) => s.startsWith('CREATE POLICY'));
  // owner_session and owner_slot: 2 tables × 2 kinds × 2; canary: 5 + 4; ingx: 7 + 5.
  assert.equal(policies.length, 8 + 9 + 12);
  for (const p of policies) {
    const role = / TO (\w+) /.exec(p)?.[1];
    assert.ok(role !== undefined && role.toLowerCase() !== 'public', p);
  }
  assert.deepEqual(policies.filter((p) => p.includes('RESTRICTIVE')).map((p) => / TO (\w+) /.exec(p)?.[1]), ['restore', 'restore', 'restore', 'restore']);
});

test('should add fenced_slots, resumed_at, resume_fenced_slots and incident_decision_ref, nullable, to placement_integrity_stops when migrating the platform', T, () => {
  const st = platformMigration().statements;
  const create = st.find((s) => s.startsWith('CREATE TABLE IF NOT EXISTS placement_integrity_stops'));
  assert.ok(create !== undefined);
  const cols = ['fenced_slots INT4[] NULL', 'resumed_at DECIMAL NULL', 'resume_fenced_slots INT4[] NULL', 'incident_decision_ref BYTES NULL'];
  for (const c of cols) assert.ok(create.includes(c), c);
  assert.deepEqual(st.filter((s) => s.startsWith('ALTER TABLE placement_integrity_stops')),
    cols.map((c) => `ALTER TABLE placement_integrity_stops ADD COLUMN IF NOT EXISTS ${c}`));
});

// The grants conformance job against a database double.

interface PolicyRow { tablename: string; policyname: string; permissive: string; roles: string; cmd: string; qual: string; with_check: string }
interface FakeState {
  privileges: Array<{ table_schema: string; grantee: string; table_name: string; privilege_type: string }>;
  policies: PolicyRow[];
  forced: string[];
  version: string;
}

const V25 = 'CockroachDB CCL v25.2.1 (aarch64-unknown-linux-gnu)';
const V24 = 'CockroachDB CCL v24.3.5 (aarch64-unknown-linux-gnu)';
const RLS_WARNING = 'row-level security is not available (CockroachDB < 25.2): owner_session/owner_slot UPDATE is not confined to the role\'s kind (C01 §2.3, R47-18; SP3 fallback open)';
const RESTORE_WARNING = 'the restore path is not available: restore has no write grant on any log or head table without row-level security (C01 §2.3, R47-28; fail closed, needs CockroachDB 25.2 or later)';
const unconfined = (table: string, privs: string): string =>
  `CP-6 (R47-28): restore has ${privs} on ${table} without the policies restore_only_stopped (permissive) and restore_confined (restrictive) over placement_integrity_stops, with row-level security enabled and forced`;

function fakeDb(s: FakeState): GrantsQueryable {
  return {
    async query(text: string) {
      if (text.includes('information_schema.table_privileges')) return { rows: s.privileges };
      if (text.includes('SHOW GRANTS ON FUNCTION')) return { rows: [{ grantee: 'placement', privilege_type: 'EXECUTE' }] };
      if (text.includes('version()')) return { rows: [{ v: s.version }] };
      if (text.includes('pg_policies')) return { rows: s.policies };
      if (text.includes('pg_class')) return { rows: s.forced.map((relname) => ({ relname })) };
      throw new Error(`database double: query not set up: ${text}`);
    },
  };
}

const policy = (table: string, name: string, permissive: 'PERMISSIVE' | 'RESTRICTIVE', o: Partial<PolicyRow> = {}): PolicyRow => ({
  tablename: table, policyname: name, permissive, roles: 'restore', cmd: 'ALL',
  qual: predicate('canary', table), with_check: predicate('canary', table), ...o,
});

/** The database as `grantMigration([canary], opts)` leaves it. */
function cleanState(rls: boolean): FakeState {
  const privileges: FakeState['privileges'] = [];
  for (const [grantee, tables] of expectedPrivileges([canary], { rowLevelSecurity: rls })) {
    for (const [table_name, privs] of tables) for (const p of privs) privileges.push({ table_schema: 'public', grantee, table_name, privilege_type: p });
  }
  const tables = rls ? ['canary_log', 'canary_head'] : [];
  return {
    privileges,
    policies: tables.flatMap((t) => [policy(t, 'restore_only_stopped', 'PERMISSIVE'), policy(t, 'restore_confined', 'RESTRICTIVE')]),
    forced: tables,
    version: rls ? V25 : V24,
  };
}

const RLS = { rowLevelSecurity: true };
const grant = (s: FakeState, table_schema: string, table_name: string, privilege_type: string, grantee = 'restore'): FakeState =>
  ({ ...s, privileges: [...s.privileges, { table_schema, grantee, table_name, privilege_type }] });

test('C01 CP-11 the conformance job reports no violation and no warning when grants and restore policies are as generated with row-level security', T, async () => {
  assert.deepEqual(await checkGrants(fakeDb(cleanState(true)), [canary], RLS), { violations: [], warnings: [] });
});

test('C01 CP-11 the conformance job reports no violation and warns that the restore path is not available when row-level security is off', T, async () => {
  assert.deepEqual(await checkGrants(fakeDb(cleanState(false)), [canary]), { violations: [], warnings: [RLS_WARNING, RESTORE_WARNING] });
});

test('C01 CP-11 the conformance job fails when restore has a write grant on a log table and row-level security is off', T, async () => {
  const s = grant(cleanState(false), 'public', 'canary_log', 'INSERT');
  assert.deepEqual((await checkGrants(fakeDb(s), [canary])).violations, [unconfined('canary_log', 'INSERT')]);
});

test('C01 CP-11 the conformance job fails when restore_confined is missing on a head table', T, async () => {
  const s = cleanState(true);
  s.policies = s.policies.filter((p) => !(p.tablename === 'canary_head' && p.policyname === 'restore_confined'));
  assert.deepEqual((await checkGrants(fakeDb(s), [canary], RLS)).violations, [unconfined('canary_head', 'INSERT, UPDATE')]);
});

test('C01 CP-11 the conformance job fails when restore_only_stopped is missing on a log table', T, async () => {
  const s = cleanState(true);
  s.policies = s.policies.filter((p) => !(p.tablename === 'canary_log' && p.policyname === 'restore_only_stopped'));
  assert.deepEqual((await checkGrants(fakeDb(s), [canary], RLS)).violations, [unconfined('canary_log', 'INSERT, UPDATE')]);
});

test('C01 CP-11 the conformance job fails when a restore policy does not test a stop in placement_integrity_stops', T, async () => {
  for (const o of [{ qual: 'true' }, { with_check: 'true' }, { qual: predicate('canary', 'canary_log').replace('placement_integrity_stops', 'integrity_stops') },
    { with_check: predicate('canary', 'canary_log').replace("'stopped'", "'resumed'") }, { qual: predicate('other', 'canary_log') }]) {
    const s = cleanState(true);
    s.policies = s.policies.map((p) => (p.tablename === 'canary_log' && p.policyname === 'restore_confined' ? { ...p, ...o } : p));
    assert.deepEqual((await checkGrants(fakeDb(s), [canary], RLS)).violations, [unconfined('canary_log', 'INSERT, UPDATE')], JSON.stringify(o));
  }
});

test('C01 CP-11 the conformance job fails when restore_confined is permissive, not for all commands, or not for restore alone', T, async () => {
  for (const o of [{ permissive: 'PERMISSIVE' }, { cmd: 'UPDATE' }, { roles: 'restore,canary' }, { roles: 'canary' }]) {
    const s = cleanState(true);
    s.policies = s.policies.map((p) => (p.tablename === 'canary_head' && p.policyname === 'restore_confined' ? { ...p, ...o } : p));
    assert.deepEqual((await checkGrants(fakeDb(s), [canary], RLS)).violations, [unconfined('canary_head', 'INSERT, UPDATE')], JSON.stringify(o));
  }
});

test('C01 CP-11 the conformance job fails when row-level security on a log table is not forced', T, async () => {
  const s = cleanState(true);
  s.forced = ['canary_head'];
  assert.deepEqual((await checkGrants(fakeDb(s), [canary], RLS)).violations, [unconfined('canary_log', 'INSERT, UPDATE')]);
});

test('C01 CP-11 the conformance job fails when a policy is TO PUBLIC', T, async () => {
  const s = cleanState(true);
  s.policies = [...s.policies, { tablename: 'canary_log', policyname: 'canary_log_read_any', permissive: 'PERMISSIVE', roles: 'public', cmd: 'SELECT', qual: 'true', with_check: '' }];
  assert.deepEqual((await checkGrants(fakeDb(s), [canary], RLS)).violations, ['CP-6 (V56-1): policy canary_log_read_any on canary_log is TO PUBLIC']);
});

test('C01 CP-11 the conformance job fails when restore has a grant on audit\'s stops table', T, async () => {
  let s = grant(cleanState(true), 'audit', 'integrity_stops', 'SELECT');
  s = grant(s, 'public', 'audit_integrity_stops', 'SELECT');
  assert.deepEqual((await checkGrants(fakeDb(s), [canary], RLS)).violations, [
    'CP-6 (CI6-1): restore has SELECT on audit\'s table audit.integrity_stops; its predicate is placement_integrity_stops',
    'CP-6 (CI6-1): restore has SELECT on audit\'s table public.audit_integrity_stops; its predicate is placement_integrity_stops',
  ]);
});

test('C01 CP-11 the conformance job fails when restore has DELETE on any table', T, async () => {
  let s = grant(cleanState(true), 'public', 'canary_log', 'DELETE');
  s = grant(s, 'public', 'placement_partition_moves', 'DELETE');
  assert.deepEqual((await checkGrants(fakeDb(s), [canary], RLS)).violations, [
    'CP-6 (R47-28): restore has DELETE on public.canary_log',
    'CP-6 (R47-28): restore has DELETE on public.placement_partition_moves',
  ]);
});

test('should report a missing restore grant and a restore grant not in C01 §2.3 when the conformance job runs', T, async () => {
  let s = cleanState(true);
  s.privileges = s.privileges.filter((p) => !(p.grantee === 'restore' && p.table_name === 'placement_integrity_stops'));
  s = grant(s, 'public', 'canary_request', 'SELECT');
  assert.deepEqual((await checkGrants(fakeDb(s), [canary], RLS)).violations, [
    'missing: SELECT on placement_integrity_stops to restore',
    'privilege not in C01 §2.3: SELECT on canary_request to restore',
  ]);
});

test('should not read the policy catalogue and should fail a confined-looking restore write grant when the database has no row-level security', T, async () => {
  const s = { ...cleanState(true), version: V24 };
  assert.deepEqual(await checkGrants(fakeDb(s), [canary], RLS), {
    violations: [unconfined('canary_log', 'INSERT, UPDATE'), unconfined('canary_head', 'INSERT, UPDATE')],
    warnings: [RLS_WARNING],
  });
});
