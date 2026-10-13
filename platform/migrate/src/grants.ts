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
 */
import type pg from 'pg';
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

export const ownerRole = (kind: string): string => assertIdentifier(kind);
export const standbyRole = (kind: string): string => assertIdentifier(`standby_${kind}`);
export const gapfillRole = (consumer: string, producer: string): string => assertIdentifier(`gapfill_${consumer}_${producer}`);
export const gapfillView = (producer: string, consumer: string): string => assertIdentifier(`${producer}_outbox_gapfill_${consumer}`);

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

/** Every privilege C01 §2.3 gives, for these declarations. */
export function expectedPrivileges(decls: OwnerDeclaration[]): PrivilegeMap {
  const m: PrivilegeMap = new Map();
  for (const d of decls) {
    const t = tableNames(d.kind);
    const role = ownerRole(d.kind);
    const projections = d.projections.map((p) => t.projection(p.name));
    add(m, role, t.log, ['SELECT', 'INSERT']);
    add(m, role, t.outbox, ['SELECT', 'INSERT']);
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
    for (const x of [t.log, t.head, t.outbox, ...projections, ...PLATFORM_TABLES]) add(m, standbyRole(d.kind), x, ['SELECT']);
    const consumers = new Set(d.streams.flatMap((s) => s.consumers));
    for (const c of consumers) add(m, gapfillRole(c, d.kind), gapfillView(d.kind, c), ['SELECT']);
  }
  return m;
}

const list = (xs: Iterable<string>): string => [...xs].join(', ');

/** Roles, views, the stops function, grants and (optionally) row-level security. Idempotent. */
export function grantMigration(decls: OwnerDeclaration[], opts: GrantOptions = {}): Migration {
  const st: string[] = [];
  const expected = expectedPrivileges(decls);
  const roles = new Set<string>([...expected.keys(), 'placement']);
  for (const r of roles) st.push(`CREATE ROLE IF NOT EXISTS ${assertIdentifier(r)}`);
  for (const d of decls) {
    for (const c of new Set(d.streams.flatMap((s) => s.consumers))) {
      const topics = consumerTopics(d, c).map((x) => `'${x.replace(/'/g, "''")}'`);
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
  }
  return { id: `grants-${decls.map((d) => d.kind).sort().join('-')}-v1`, statements: st };
}

export interface ConformanceReport {
  violations: string[];
  warnings: string[];
}

type Queryable = Pick<pg.Client, 'query'> | Pick<pg.Pool, 'query'>;

function ownerOfTable(decls: OwnerDeclaration[], table: string): OwnerDeclaration | undefined {
  // The longest kind prefix wins (kinds may share a prefix).
  return [...decls].sort((a, b) => b.kind.length - a.kind.length).find((d) => table.startsWith(`${d.kind}_`));
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

/** The grants conformance job (CP-2c, CP-11): every difference from C01 §2.3 is a violation. */
export async function checkGrants(db: Queryable, decls: OwnerDeclaration[]): Promise<ConformanceReport> {
  const violations: string[] = [];
  const warnings: string[] = [];
  for (const d of decls) for (const e of validateDeclaration(d)) violations.push(`declaration ${d.kind}: ${e}`);
  const expected = expectedPrivileges(decls);
  const roles = [...new Set([...expected.keys(), 'placement'])];
  const r = await db.query(
    `SELECT grantee, table_name, privilege_type FROM information_schema.table_privileges
      WHERE table_schema = 'public' AND grantee = ANY($1::STRING[])`, [roles]);
  const inScope = (table: string): boolean =>
    (PLATFORM_TABLES as readonly string[]).includes(table) || OTHER_PLATFORM_TABLES.includes(table) || ownerOfTable(decls, table) !== undefined;
  const actual: PrivilegeMap = new Map();
  for (const row of r.rows as Array<Record<string, unknown>>) {
    const table = String(row['table_name']);
    if (!inScope(table)) continue;
    add(actual, String(row['grantee']), table, [String(row['privilege_type']).toUpperCase() as Privilege]);
  }
  for (const [role, tables] of actual) {
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
  if (major < 2502) {
    warnings.push('row-level security is not available (CockroachDB < 25.2): owner_session/owner_slot UPDATE is not confined to the role\'s kind (C01 §2.3, R47-18; SP3 fallback open)');
  }
  return { violations, warnings };
}
