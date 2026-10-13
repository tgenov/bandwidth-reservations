/**
 * Grants, roles and the grants conformance job (C01 §2.3 "Grants" and "Named platform read roles", R47-18,
 * V59-3; CP-11; plan S-PLAT-I1 items 1 and 2).
 *
 * CockroachDB 24.3 (the dev cell) has no row-level security and no column privileges. So:
 * - `rowLevelSecurity: true` adds the policies that confine owner_session / owner_slot UPDATE to the role's
 *   kind (CockroachDB 25.2 or later). Without it the job reports a warning: a cross-kind write is not prevented.
 * - Placement gets no UPDATE on owner_slot. It changes `stops_version` only through the SECURITY DEFINER
 *   function `placement_set_stops_version(kind, slot)` (the column-grant fallback).
 * - A gap-fill role reads a view `<producer>_outbox_gapfill_<consumer>` that keeps only the consumer's topics
 *   (the fallback for row-level security on `topic`).
 * - The break-glass role `restore` (C01 §2.3, R47-28; C08 §K, CC-2, V56-1; plan S-PLAT-I3 item 11, CI6-1) writes
 *   `<kind>_log` and `<kind>_head` only with `rowLevelSecurity: true`: forced row-level security and the policies
 *   `restore_only_stopped` (permissive) and `restore_confined` (restrictive) over placement's
 *   `placement_integrity_stops`. Without row-level security it gets no write grant (fail closed) and the job warns.
 */
import type { OwnerDeclaration } from '@share/owner-runtime';
import { assertIdentifier, tableNames, validateDeclaration } from '@share/owner-runtime';
import type { Migration } from './generate.ts';

export type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

/** role → table (or view) → privileges. */
export type PrivilegeMap = Map<string, Map<string, Set<Privilege>>>;

export interface GrantOptions {
  /** CockroachDB ≥ 25.2: add the row-level security policies by kind. */
  rowLevelSecurity?: boolean;
}

export const PLATFORM_TABLES = ['owner_session', 'owner_slot', 'platform_timing', 'placement_integrity_stops'] as const;
/** Platform tables some roles get (in scope of the conformance job). */
const OTHER_PLATFORM_TABLES = ['owner_slot_position'];
export const STOPS_FUNCTION = 'placement_set_stops_version';
/** The break-glass restore role (C01 §2.3, R47-28). */
export const RESTORE_ROLE = 'restore';
/** Names of audit's own stops table (the detection record, C08 §K CC-2): the restore role has no grant on it (CI6-1). */
const AUDIT_STOPS_TABLES = ['integrity_stops', 'audit_integrity_stops'];

/** The restore role's predicate on `table` of `kind`: a `stopped` row in placement's table for the row's partition (C08 §K). */
export function restorePredicate(kind: string, table: string): string {
  return `EXISTS (SELECT 1 FROM placement_integrity_stops s WHERE s.kind = '${assertIdentifier(kind)}' AND s.partition = ${assertIdentifier(table)}.partition AND s.state = 'stopped')`;
}

export const ownerRole = (kind: string): string => assertIdentifier(kind);
export const standbyRole = (kind: string): string => assertIdentifier(`standby_${kind}`);
export const gapfillRole = (consumer: string, producer: string): string => assertIdentifier(`gapfill_${consumer}_${producer}`);
export const gapfillView = (producer: string, consumer: string): string => assertIdentifier(`${producer}_outbox_gapfill_${consumer}`);
/** The gap-fill view of a self-outboxed producer (C01 §2.3: "a self-outboxed log through its stream index"). */
export const logGapfillView = (producer: string, consumer: string): string => assertIdentifier(`${producer}_log_gapfill_${consumer}`);

function add(m: PrivilegeMap, role: string, table: string, privs: Privilege[]): void {
  let r = m.get(role);
  if (!r) { r = new Map(); m.set(role, r); }
  let t = r.get(table);
  if (!t) { t = new Set(); r.set(table, t); }
  for (const p of privs) t.add(p);
}

/** Topics of the producer's streams that name `consumer`. */
function consumerTopics(d: OwnerDeclaration, consumer: string): string[] {
  return d.streams.filter((s) => s.consumers.includes(consumer)).map((s) => s.topic);
}

/** Every privilege C01 §2.3 gives, for these declarations. The restore role writes only with row-level security. */
export function expectedPrivileges(decls: OwnerDeclaration[], opts: GrantOptions = {}): PrivilegeMap {
  const m: PrivilegeMap = new Map();
  for (const d of decls) {
    const t = tableNames(d.kind);
    const role = ownerRole(d.kind);
    const projections = d.projections.map((p) => t.projection(p.name));
    add(m, role, t.log, ['SELECT', 'INSERT']);
    if (!d.selfOutboxed) add(m, role, t.outbox, ['SELECT', 'INSERT']);
    add(m, role, t.head, ['SELECT', 'INSERT', 'UPDATE']);
    for (const p of d.projections) {
      add(m, role, t.projection(p.name), ['SELECT', 'INSERT', 'UPDATE', ...(p.deletable ? ['DELETE' as const] : [])]);
      for (const r of p.readableBy ?? []) add(m, assertIdentifier(r.role), t.projection(p.name), ['SELECT']);
    }
    for (const pt of PLATFORM_TABLES) add(m, role, pt, ['SELECT']);
    add(m, role, 'owner_session', ['INSERT', 'UPDATE']);
    add(m, role, 'owner_slot', ['UPDATE']);
    if (d.selfOutboxed) add(m, role, t.streamIndex, ['SELECT', 'INSERT']);
    if (d.slotPositions) add(m, role, 'owner_slot_position', ['SELECT', 'INSERT', 'UPDATE']);
    // Named platform read roles.
    add(m, 'history_sealer', t.log, ['SELECT']);
    if (d.statusReaders) {
      for (const x of [t.log, t.head, ...projections, 'owner_session', 'owner_slot']) add(m, 'status_reader', x, ['SELECT']);
    }
    if (d.streams.some((s) => s.closure === 'closedPerLink')) add(m, 'closure_emitter', t.head, ['SELECT']);
    const own = d.selfOutboxed ? [t.log, t.head, t.streamIndex] : [t.log, t.head, t.outbox];
    for (const x of [...own, ...projections, ...PLATFORM_TABLES]) add(m, standbyRole(d.kind), x, ['SELECT']);
    const consumers = new Set(d.streams.flatMap((s) => s.consumers));
    for (const c of consumers) add(m, gapfillRole(c, d.kind), d.selfOutboxed ? logGapfillView(d.kind, c) : gapfillView(d.kind, c), ['SELECT']);
    // Break-glass restore (R47-28): SELECT on placement's table for the policy subquery. No DELETE (RFC-006 §13.2).
    add(m, RESTORE_ROLE, 'placement_integrity_stops', ['SELECT']);
    if (opts.rowLevelSecurity) for (const x of [t.log, t.head]) add(m, RESTORE_ROLE, x, ['SELECT', 'INSERT', 'UPDATE']);
  }
  return m;
}

const list = (xs: Iterable<string>): string => [...xs].join(', ');

/** A permissive policy that keeps a granted role working on a table with forced row-level security. */
function rolePolicy(table: string, role: string, write: boolean): string[] {
  const name = `${table}_${write ? 'write' : 'read'}_${role}`;
  return [
    `DROP POLICY IF EXISTS ${name} ON ${table}`,
    write
      ? `CREATE POLICY ${name} ON ${table} FOR ALL TO ${role} USING (true) WITH CHECK (true)`
      : `CREATE POLICY ${name} ON ${table} FOR SELECT TO ${role} USING (true)`,
  ];
}

/** Forced row-level security on `<kind>_log` and `<kind>_head`, a policy for each granted role, and the restore policies. */
function logHeadSecurity(d: OwnerDeclaration, expected: PrivilegeMap): string[] {
  const t = tableNames(d.kind);
  const st: string[] = [];
  for (const table of [t.log, t.head]) {
    // FORCE: the policies hold for the table owner too (C08 C-10).
    st.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    for (const [role, tables] of expected) {
      const privs = tables.get(table);
      if (role === RESTORE_ROLE || !privs) continue;
      st.push(...rolePolicy(table, role, [...privs].some((p) => p !== 'SELECT')));
    }
    if (d.selfOutboxed && table === t.log) {
      for (const c of new Set(d.streams.flatMap((s) => s.consumers))) st.push(...rolePolicy(table, gapfillRole(c, d.kind), false));
    }
    // V56-1: a permissive and a restrictive policy with the same predicate; only restore, never TO PUBLIC.
    const p = restorePredicate(d.kind, table);
    st.push(
      `DROP POLICY IF EXISTS restore_only_stopped ON ${table}`,
      `CREATE POLICY restore_only_stopped ON ${table} AS PERMISSIVE FOR ALL TO ${RESTORE_ROLE} USING (${p}) WITH CHECK (${p})`,
      `DROP POLICY IF EXISTS restore_confined ON ${table}`,
      `CREATE POLICY restore_confined ON ${table} AS RESTRICTIVE FOR ALL TO ${RESTORE_ROLE} USING (${p}) WITH CHECK (${p})`,
    );
  }
  return st;
}

/** Roles, views, the stops function, grants and (optionally) row-level security. Idempotent. */
export function grantMigration(decls: OwnerDeclaration[], opts: GrantOptions = {}): Migration {
  const st: string[] = [];
  const expected = expectedPrivileges(decls, opts);
  const roles = new Set<string>([...expected.keys(), 'placement']);
  for (const r of roles) st.push(`CREATE ROLE IF NOT EXISTS ${assertIdentifier(r)}`);
  for (const d of decls) {
    for (const c of new Set(d.streams.flatMap((s) => s.consumers))) {
      const topics = consumerTopics(d, c).map((x) => `'${x.replace(/'/g, "''")}'`);
      if (d.selfOutboxed) {
        // Only the consumer's streams: the index row names the stream, and the join gives the log row.
        const streams = d.streams.filter((s) => s.consumers.includes(c)).map((s) => `'${s.name.replace(/'/g, "''")}'`);
        const t = tableNames(d.kind);
        st.push(`CREATE OR REPLACE VIEW ${logGapfillView(d.kind, c)} AS
  SELECT si.stream, si.stream_seq, l.slot, l.partition, l.seq, l.generation, l.epoch, l.kind, l.schema_v, l.ts, l.identity, l.emits,
         l.audit, l.retention, l.key_id, l.payload, l.chain
    FROM ${t.streamIndex} AS si JOIN ${t.log} AS l ON l.partition = si.partition AND l.seq = si.seq
   WHERE si.stream IN (${streams.join(', ')})`);
        continue;
      }
      st.push(`CREATE OR REPLACE VIEW ${gapfillView(d.kind, c)} AS
  SELECT slot, partition, stream, stream_seq, n, topic, msg_key, headers, payload, ts, generation, epoch
    FROM ${tableNames(d.kind).outbox} WHERE topic IN (${topics.join(', ')})`);
    }
  }
  // V59-3 fallback: placement changes only stops_version, through this function (no column privileges in 24.3).
  st.push(`CREATE OR REPLACE FUNCTION ${STOPS_FUNCTION}(k STRING, s INT4) RETURNS INT8 LANGUAGE SQL SECURITY DEFINER AS $$
  UPDATE owner_slot SET stops_version = stops_version + 1 WHERE kind = k AND slot = s RETURNING stops_version
$$`);
  st.push(`REVOKE EXECUTE ON FUNCTION ${STOPS_FUNCTION}(STRING, INT4) FROM public`);
  st.push(`GRANT EXECUTE ON FUNCTION ${STOPS_FUNCTION}(STRING, INT4) TO placement`);
  for (const [role, tables] of expected) {
    const byPrivs = new Map<string, string[]>();
    for (const [table, privs] of tables) {
      const k = [...privs].sort().join(', ');
      byPrivs.set(k, [...(byPrivs.get(k) ?? []), assertIdentifier(table)]);
    }
    for (const [privs, tables2] of byPrivs) st.push(`GRANT ${privs} ON TABLE ${list(tables2)} TO ${role}`);
  }
  if (opts.rowLevelSecurity) {
    // CockroachDB ≥ 25.2 (R47-18): session and slot updates confined to the role's kind.
    for (const table of ['owner_session', 'owner_slot']) {
      st.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      for (const d of decls) {
        const r = ownerRole(d.kind);
        st.push(`DROP POLICY IF EXISTS ${table}_read_${r} ON ${table}`);
        st.push(`CREATE POLICY ${table}_read_${r} ON ${table} FOR SELECT TO ${r} USING (true)`);
        st.push(`DROP POLICY IF EXISTS ${table}_write_${r} ON ${table}`);
        st.push(`CREATE POLICY ${table}_write_${r} ON ${table} FOR ALL TO ${r} USING (kind = '${d.kind}') WITH CHECK (kind = '${d.kind}')`);
      }
    }
    // CockroachDB ≥ 25.2 (R47-28): the restore role writes only partitions with an open stop.
    for (const d of decls) st.push(...logHeadSecurity(d, expected));
  }
  return { id: `grants-${decls.map((d) => d.kind).sort().join('-')}-v1`, statements: st };
}

export interface ConformanceReport {
  violations: string[];
  warnings: string[];
}

/** What the conformance job needs of a database connection (`pg.Client` and `pg.Pool` fit). */
export interface GrantsQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** One row-level-security policy, as the catalogue shows it. */
interface Policy { table: string; name: string; permissive: string; roles: string[]; cmd: string; qual: string; withCheck: string }

/** Policies and forced tables in schema public (CockroachDB ≥ 25.2). */
async function readRowLevelSecurity(db: GrantsQueryable): Promise<{ policies: Policy[]; forced: Set<string> }> {
  const field = (row: unknown, k: string): string => {
    const v: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, k) : undefined;
    return v === null || v === undefined ? '' : String(v);
  };
  const p = await db.query(`SELECT tablename, policyname, permissive, array_to_string(roles, ',') AS roles, cmd, qual, with_check
    FROM pg_catalog.pg_policies WHERE schemaname = 'public'`);
  const c = await db.query(`SELECT c.relname FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity`);
  return {
    policies: p.rows.map((r) => ({
      table: field(r, 'tablename'), name: field(r, 'policyname'), permissive: field(r, 'permissive').toUpperCase(),
      roles: field(r, 'roles').split(',').filter((x) => x !== ''), cmd: field(r, 'cmd').toUpperCase(),
      qual: field(r, 'qual'), withCheck: field(r, 'with_check'),
    })),
    forced: new Set(c.rows.map((r) => field(r, 'relname'))),
  };
}

/** True when `table` of `kind` has forced row-level security and both restore policies over placement's stops (C08 §K). */
function restoreConfined(rls: { policies: Policy[]; forced: Set<string> }, kind: string, table: string): boolean {
  const tests = (e: string): boolean => e.includes('placement_integrity_stops') && e.includes(`'${kind}'`) && e.includes(`'stopped'`);
  const has = (name: string, permissive: string): boolean => rls.policies.some((p) =>
    p.table === table && p.name === name && p.permissive === permissive && p.cmd === 'ALL'
    && p.roles.length === 1 && p.roles[0] === RESTORE_ROLE && tests(p.qual) && tests(p.withCheck));
  return rls.forced.has(table) && has('restore_only_stopped', 'PERMISSIVE') && has('restore_confined', 'RESTRICTIVE');
}

function ownerOfTable(decls: OwnerDeclaration[], table: string): OwnerDeclaration | undefined {
  // The longest kind prefix wins (kinds may share a prefix).
  return [...decls].sort((a, b) => b.kind.length - a.kind.length).find((d) => table.startsWith(`${d.kind}_`));
}

/** The restore role's grants against C01 §2.3 and C08 §K: no DELETE, nothing on audit's table, writes only when confined. */
function restoreViolations(decls: OwnerDeclaration[], grants: Array<{ schema: string; table: string; priv: Privilege }>,
  expected: PrivilegeMap, rls: { policies: Policy[]; forced: Set<string> }, inScope: (table: string) => boolean): string[] {
  const out: string[] = [];
  const kindOf = new Map<string, string>();
  for (const d of decls) { const t = tableNames(d.kind); kindOf.set(t.log, d.kind); kindOf.set(t.head, d.kind); }
  const unconfined = new Map<string, Set<Privilege>>();
  for (const g of grants) {
    const audit = AUDIT_STOPS_TABLES.includes(g.table);
    if (audit) out.push(`CP-6 (CI6-1): restore has ${g.priv} on audit's table ${g.schema}.${g.table}; its predicate is placement_integrity_stops`);
    if (g.priv === 'DELETE') out.push(`CP-6 (R47-28): restore has DELETE on ${g.schema}.${g.table}`);
    if (audit || g.priv === 'DELETE' || g.schema !== 'public') continue;
    const kind = kindOf.get(g.table);
    if (kind !== undefined && g.priv !== 'SELECT' && !restoreConfined(rls, kind, g.table)) {
      unconfined.set(g.table, (unconfined.get(g.table) ?? new Set<Privilege>()).add(g.priv));
      continue;
    }
    if (inScope(g.table) && !expected.get(RESTORE_ROLE)?.get(g.table)?.has(g.priv)) {
      out.push(`privilege not in C01 §2.3: ${g.priv} on ${g.table} to ${RESTORE_ROLE}`);
    }
  }
  for (const [table, privs] of unconfined) {
    out.push(`CP-6 (R47-28): restore has ${[...privs].sort().join(', ')} on ${table} without the policies restore_only_stopped (permissive) and restore_confined (restrictive) over placement_integrity_stops, with row-level security enabled and forced`);
  }
  return out;
}

/** Why an unexpected privilege breaks C01 §2.3 (the CP-11 cases first). */
function classify(decls: OwnerDeclaration[], role: string, table: string, priv: Privilege): string {
  const owner = ownerOfTable(decls, table);
  const isOwnerRole = decls.some((d) => ownerRole(d.kind) === role);
  if (owner && table === tableNames(owner.kind).log && (priv === 'UPDATE' || priv === 'DELETE')) {
    return `CP-11: ${priv} on log table ${table} by ${role}`;
  }
  if (owner && priv === 'DELETE' && owner.projections.some((p) => tableNames(owner.kind).projection(p.name) === table && !p.deletable)) {
    return `CP-11: DELETE on projection ${table} that is not declared deletable (role ${role})`;
  }
  if (role === 'placement' && table === 'owner_slot' && priv === 'UPDATE') {
    return `CP-11 (V59-3): placement may change only stops_version, through ${STOPS_FUNCTION}; it has UPDATE on owner_slot`;
  }
  if (isOwnerRole && owner && ownerRole(owner.kind) !== role && priv === 'SELECT') {
    return `CP-11: cross-owner SELECT on ${table} by ${role} not listed in C01 §2.3 (readableBy)`;
  }
  if (isOwnerRole && (table === 'owner_session' || table === 'owner_slot') && priv === 'DELETE') {
    return `CP-11: ${priv} on ${table} by ${role}`;
  }
  return `privilege not in C01 §2.3: ${priv} on ${table} to ${role}`;
}

/**
 * The grants conformance job (CP-2c, CP-11; CP-6 restore clause, DT-45): every difference from C01 §2.3 is a violation.
 * `opts` must be the options the grants were generated with.
 */
export async function checkGrants(db: GrantsQueryable, decls: OwnerDeclaration[], opts: GrantOptions = {}): Promise<ConformanceReport> {
  const violations: string[] = [];
  const warnings: string[] = [];
  for (const d of decls) for (const e of validateDeclaration(d)) violations.push(`declaration ${d.kind}: ${e}`);
  const expected = expectedPrivileges(decls, opts);
  const roles = [...new Set([...expected.keys(), 'placement', RESTORE_ROLE])];
  // Every schema: the restore role must have no grant on audit's table, wherever it is (CI6-1).
  const r = await db.query(
    `SELECT table_schema, grantee, table_name, privilege_type FROM information_schema.table_privileges
      WHERE grantee = ANY($1::STRING[])`, [roles]);
  const inScope = (table: string): boolean =>
    (PLATFORM_TABLES as readonly string[]).includes(table) || OTHER_PLATFORM_TABLES.includes(table) || ownerOfTable(decls, table) !== undefined;
  const actual: PrivilegeMap = new Map();
  const restoreGrants: Array<{ schema: string; table: string; priv: Privilege }> = [];
  for (const row of r.rows as Array<Record<string, unknown>>) {
    const schema = String(row['table_schema']);
    const table = String(row['table_name']);
    const priv = String(row['privilege_type']).toUpperCase() as Privilege;
    if (String(row['grantee']) === RESTORE_ROLE) restoreGrants.push({ schema, table, priv });
    if (schema !== 'public' || !inScope(table)) continue;
    add(actual, String(row['grantee']), table, [priv]);
  }
  for (const [role, tables] of actual) {
    if (role === RESTORE_ROLE) continue; // checked below, with the policies
    for (const [table, privs] of tables) {
      for (const p of privs) {
        if (!expected.get(role)?.get(table)?.has(p)) violations.push(classify(decls, role, table, p));
      }
    }
  }
  for (const [role, tables] of expected) {
    for (const [table, privs] of tables) {
      for (const p of privs) if (!actual.get(role)?.get(table)?.has(p)) violations.push(`missing: ${p} on ${table} to ${role}`);
    }
  }
  // The stops function: placement may execute it, nobody else (public included).
  try {
    const f = await db.query(`SELECT grantee, privilege_type FROM [SHOW GRANTS ON FUNCTION ${STOPS_FUNCTION}]`);
    const execs = (f.rows as Array<Record<string, unknown>>).filter((x) => String(x['privilege_type']).toUpperCase() === 'EXECUTE').map((x) => String(x['grantee']));
    if (!execs.includes('placement')) violations.push(`missing: EXECUTE on ${STOPS_FUNCTION} to placement`);
    for (const g of execs) if (!['placement', 'admin', 'root'].includes(g)) violations.push(`CP-11 (V59-3): ${g} may execute ${STOPS_FUNCTION}`);
  } catch (e) {
    violations.push(`${STOPS_FUNCTION} is missing: ${(e as Error).message}`);
  }
  const v = await db.query('SELECT version() AS v');
  const m = /v(\d+)\.(\d+)/.exec(String((v.rows[0] as Record<string, unknown>)['v']));
  const major = m ? Number(m[1]) * 100 + Number(m[2]) : 0;
  const rls = major >= 2502 ? await readRowLevelSecurity(db) : { policies: [], forced: new Set<string>() };
  violations.push(...restoreViolations(decls, restoreGrants, expected, rls, inScope));
  for (const p of rls.policies) {
    if (p.roles.includes('public')) violations.push(`CP-6 (V56-1): policy ${p.name} on ${p.table} is TO PUBLIC`);
  }
  if (major < 2502) {
    warnings.push('row-level security is not available (CockroachDB < 25.2): owner_session/owner_slot UPDATE is not confined to the role\'s kind (C01 §2.3, R47-18; SP3 fallback open)');
  }
  if (!opts.rowLevelSecurity) {
    warnings.push('the restore path is not available: restore has no write grant on any log or head table without row-level security (C01 §2.3, R47-28; fail closed, needs CockroachDB 25.2 or later)');
  }
  return { violations, warnings };
}
