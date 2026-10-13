/**
 * S-PLAT-I3 item 11 on the dev cell (C01 CP-6 last clause, C08 C-10, RFC-006 DT-45): the break-glass role `restore`
 * writes `<kind>_log` and `<kind>_head` only for a partition with a `stopped` row in placement_integrity_stops, and
 * the forced row-level security holds for the table owner too. One database for the run. The tests skip when the
 * dev cell is not reachable (fail with REQUIRE_DEV_CELL=1), and skip when the database has no row-level security
 * (CockroachDB below 25.2).
 */
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { OwnerDeclaration } from '@share/owner-runtime';
import { createTestDatabase, devCellSkip } from '@share/owner-runtime/testing';
import { checkGrants, migrateKinds } from '../../src/index.ts';

const URL = process.env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';

/** The server version as major × 100 + minor, or the connection error code. */
async function probe(): Promise<{ error?: string; version?: number }> {
  const c = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 1_500 });
  try {
    await c.connect();
    const v = await c.query<{ v: string }>('SELECT version() AS v');
    const m = /v(\d+)\.(\d+)/.exec(v.rows[0]?.v ?? '');
    return { version: m ? Number(m[1]) * 100 + Number(m[2]) : 0 };
  } catch (e) {
    return { error: (e as { code?: string }).code ?? String(e) };
  } finally {
    await c.end().catch(() => {});
  }
}
const cell = await probe();
const UNREACHABLE = devCellSkip(cell.error === undefined ? undefined : `CockroachDB at ${URL}: ${cell.error}`);
const NO_RLS = !UNREACHABLE && (cell.version ?? 0) < 2502
  ? `the database has no row-level security (CockroachDB ${cell.version ?? 0} < 25.2): the restore path is not available (fail closed)`
  : false;
if (NO_RLS) console.log(`# SKIP integration: ${NO_RLS}`);
const SKIP = UNREACHABLE || NO_RLS;
const T = { timeout: 60_000, skip: SKIP };

const R = randomBytes(3).toString('hex');
const KIND = `irs_${R}`;
const LOG = `${KIND}_log`;
const HEAD = `${KIND}_head`;
const OWNER = `irs_owner_${R}`;
const DECL: OwnerDeclaration = {
  kind: KIND, slotCount: 4, entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }], projections: [], streams: [],
};

let db: { name: string; url: string; drop: () => Promise<void> } | undefined;
let admin: pg.Pool | undefined;
const open: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of open.splice(0).reverse()) await c().catch(() => {}); });
before(async () => {
  if (SKIP) return;
  db = await createTestDatabase(URL, 'irestore');
  admin = new pg.Pool({ connectionString: db.url, max: 4 });
  await migrateKinds(db.url, [DECL], { presplit: false, grants: { rowLevelSecurity: true } });
}, { timeout: 180_000 });
after(async () => { await admin?.end(); await db?.drop(); }, { timeout: 60_000 });

function pool(): pg.Pool {
  if (!admin) throw new Error('no test database');
  return admin;
}
/** A connection with `SET ROLE role`; afterEach resets and releases it. */
async function as(role: string): Promise<pg.PoolClient> {
  const c = await pool().connect();
  open.push(async () => { await c.query('RESET ROLE').catch(() => {}); c.release(); });
  await c.query(`SET ROLE ${role}`);
  return c;
}
const partition = (name: string): Buffer => Buffer.from(`${name}_${R}`);
const LOG_INSERT = `INSERT INTO ${LOG} (slot, partition, seq, generation, epoch, kind, schema_v, ts, identity, emits, audit, retention, key_id, payload, chain)
  VALUES (0, $1, $2, 1, 1, 1, 1, 1, '\\x00', '\\x00', '\\x00', 0, '\\x00', '\\x00', $3)`;
const HEAD_INSERT = `INSERT INTO ${HEAD} (home_key, partition, slot, generation, seq, ts, epoch, streams, chain, batch_id)
  VALUES ($1, $2, 0, 1, 1, 1, 1, '\\x00', '\\x00', '\\x00')`;
const chain = Buffer.alloc(32, 7);
let homeKey = 0;
const nextHomeKey = (): number => ++homeKey;

async function stop(p: Buffer, ref: string): Promise<void> {
  await pool().query(`INSERT INTO placement_integrity_stops (kind, partition, detection_ref, state, at) VALUES ($1, $2, $3, 'stopped', 1)`,
    [KIND, p, Buffer.from(ref)]);
}
async function resume(p: Buffer): Promise<void> {
  await pool().query(`UPDATE placement_integrity_stops SET state = 'resumed', resumed_at = 2 WHERE kind = $1 AND partition = $2`, [KIND, p]);
}
const refusedByPolicy = (e: unknown): boolean => (e as { code?: string }).code === '42501';
const payloadOf = async (p: Buffer): Promise<string | undefined> =>
  (await pool().query<{ payload: Buffer }>(`SELECT payload FROM ${LOG} WHERE partition = $1 AND seq = 1`, [p])).rows[0]?.payload.toString('hex');

test('C01 CP-11 on the dev cell: the conformance job is clean with the restore policies when row-level security is on', T, async () => {
  assert.deepEqual(await checkGrants(pool(), [DECL], { rowLevelSecurity: true }), { violations: [], warnings: [] });
});

test('C01 CP-6 on the dev cell: the restore role cannot write the log or the head of a partition that is not stopped', T, async () => {
  const stopped = partition('a_stopped');
  const other = partition('a_other');
  await stop(stopped, `a_${R}`);
  await pool().query(LOG_INSERT, [other, 1, chain]);
  const c = await as('restore');
  await assert.rejects(c.query(LOG_INSERT, [other, 2, chain]), refusedByPolicy);
  await assert.rejects(c.query(HEAD_INSERT, [nextHomeKey(), other]), refusedByPolicy);
  const u = await c.query(`UPDATE ${LOG} SET payload = '\\x01' WHERE partition = $1`, [other]);
  assert.equal(u.rowCount, 0);
  assert.equal(await payloadOf(other), '00');
  assert.equal((await pool().query(`SELECT 1 FROM ${LOG} WHERE partition = $1 AND seq = 2`, [other])).rowCount, 0);
  assert.equal((await pool().query(`SELECT 1 FROM ${HEAD} WHERE partition = $1`, [other])).rowCount, 0);
});

test('C01 CP-6 on the dev cell: the restore role can write the log and the head of a stopped partition', T, async () => {
  const p = partition('b_stopped');
  await stop(p, `b_${R}`);
  await pool().query(LOG_INSERT, [p, 1, chain]);
  const c = await as('restore');
  await c.query(LOG_INSERT, [p, 2, chain]);
  await c.query(HEAD_INSERT, [nextHomeKey(), p]);
  const u = await c.query(`UPDATE ${LOG} SET payload = '\\x01' WHERE partition = $1 AND seq = 1`, [p]);
  assert.equal(u.rowCount, 1);
  assert.equal(await payloadOf(p), '01');
  assert.equal((await pool().query(`SELECT 1 FROM ${LOG} WHERE partition = $1 AND seq = 2`, [p])).rowCount, 1);
  assert.equal((await pool().query(`SELECT 1 FROM ${HEAD} WHERE partition = $1`, [p])).rowCount, 1);
});

test('C01 CP-6 on the dev cell: the restore role cannot write a partition after its stop is resumed', T, async () => {
  const p = partition('c_resumed');
  await stop(p, `c_${R}`);
  await pool().query(LOG_INSERT, [p, 1, chain]);
  await resume(p);
  const c = await as('restore');
  await assert.rejects(c.query(LOG_INSERT, [p, 2, chain]), refusedByPolicy);
  await assert.rejects(c.query(HEAD_INSERT, [nextHomeKey(), p]), refusedByPolicy);
  const u = await c.query(`UPDATE ${LOG} SET payload = '\\x01' WHERE partition = $1`, [p]);
  assert.equal(u.rowCount, 0);
  assert.equal(await payloadOf(p), '00');
});

test('C01 CP-6 on the dev cell: the restore role cannot delete a row, also in a stopped partition', T, async () => {
  const p = partition('d_stopped');
  await stop(p, `d_${R}`);
  await pool().query(LOG_INSERT, [p, 1, chain]);
  const c = await as('restore');
  await assert.rejects(c.query(`DELETE FROM ${LOG} WHERE partition = $1`, [p]), refusedByPolicy);
  assert.equal(await payloadOf(p), '00');
});

test('C01 CP-6 on the dev cell: the table owner is confined too, because row-level security is forced', T, async () => {
  const p = partition('e_other');
  await pool().query(LOG_INSERT, [p, 1, chain]);
  await pool().query(`CREATE USER IF NOT EXISTS ${OWNER}`);
  await pool().query(`GRANT CREATE ON SCHEMA public TO ${OWNER}`);
  await pool().query(`ALTER TABLE ${LOG} OWNER TO ${OWNER}`);
  await pool().query(`ALTER TABLE ${HEAD} OWNER TO ${OWNER}`);
  open.push(async () => {
    await pool().query(`ALTER TABLE ${LOG} OWNER TO root`);
    await pool().query(`ALTER TABLE ${HEAD} OWNER TO root`);
  });
  const c = await as(OWNER);
  await assert.rejects(c.query(LOG_INSERT, [p, 2, chain]), refusedByPolicy);
  await assert.rejects(c.query(HEAD_INSERT, [nextHomeKey(), p]), refusedByPolicy);
  assert.equal((await c.query(`SELECT 1 FROM ${LOG} WHERE partition = $1`, [p])).rowCount, 0);
  assert.equal((await pool().query(`SELECT 1 FROM ${LOG} WHERE partition = $1`, [p])).rowCount, 1);
});
