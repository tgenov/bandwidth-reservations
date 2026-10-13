/**
 * S-PLAT-I3 work item 9 on the dev cell (CockroachDB): placement's Stop through `PgIntegrityStopStore`, connected
 * as the `placement` role. The Stop changes `stops_version` only through `placement_set_stops_version` (V59-3;
 * placement has no UPDATE on `owner_slot`), and the row's `at` is the ack's `enforced_at` (C01 §3.2). One database
 * for the run. The test skips when the dev cell is not reachable, and fails instead with REQUIRE_DEV_CELL=1.
 */
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { OwnerDeclaration } from '../../src/index.ts';
import { hlc, slotOfPartition, utf8 } from '../../src/index.ts';
import { IntegrityStopService, placementSlotLocator, type HeadInspector } from '../../src/placement/integrity-stop.ts';
import { PgIntegrityStopStore } from '../../src/placement/pg-integrity-stop.ts';
import { migrateKinds } from '@share/owner-migrate';
import { createTestDatabase, devCellSkip } from '../../testing/index.ts';
import { Closers } from '../support.ts';

const URL_ROOT = process.env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';

async function dbReachable(): Promise<string | undefined> {
  const c = new pg.Client({ connectionString: URL_ROOT, connectionTimeoutMillis: 1_500 });
  try { await c.connect(); await c.query('SELECT 1'); return undefined; } catch (e) { return (e as { code?: string }).code ?? String(e); } finally { await c.end().catch(() => {}); }
}
const dbError = await dbReachable();
const SKIP = devCellSkip(dbError === undefined ? undefined : `CockroachDB at ${URL_ROOT}: ${dbError}`);

const R = randomBytes(3).toString('hex');
const DECL: OwnerDeclaration = {
  kind: `istop_${R}`, slotCount: 4, entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }], projections: [], streams: [],
};
const T = { timeout: 120_000 };
/** A head inspector double: a Stop never reads a head. */
const NO_HEADS: HeadInspector = { headChainAt: async () => { throw new Error('NO_HEADS double: a Stop must not read a head'); } };

let db: { name: string; url: string; drop: () => Promise<void> } | undefined;
let admin: pg.Pool | undefined;
const closers = new Closers();
afterEach(() => closers.closeAll());
before(async () => {
  if (SKIP) return;
  db = await createTestDatabase(URL_ROOT, 'iistop');
  admin = new pg.Pool({ connectionString: db.url, max: 2 });
  await migrateKinds(db.url, [DECL], { presplit: false, grants: true });
  // Placement's own table grants come with the placement kind (not declared here); the stop path needs these.
  await admin.query('ALTER ROLE placement WITH LOGIN');
  await admin.query('GRANT SELECT, INSERT, UPDATE ON TABLE placement_integrity_stops TO placement');
  await admin.query('GRANT SELECT ON TABLE placement_partition_moves TO placement');
}, { timeout: 180_000 });
after(async () => { await admin?.end(); await db?.drop(); }, { timeout: 60_000 });

function q(): pg.Pool {
  if (!admin) throw new Error('no admin pool');
  return admin;
}
/** A pool that connects as the `placement` role (insecure dev cell: no password). */
function placementPool(): pg.Pool {
  if (!db) throw new Error('no test database');
  const u = new URL(db.url);
  u.username = 'placement';
  const pool = new pg.Pool({ connectionString: u.toString(), max: 2 });
  closers.add(() => pool.end());
  return pool;
}
async function stopsVersion(slot: number): Promise<bigint> {
  const r = await q().query<{ v: string }>('SELECT stops_version::STRING AS v FROM owner_slot WHERE kind = $1 AND slot = $2', [DECL.kind, slot]);
  return BigInt(r.rows[0]?.v ?? '-1');
}

test('C01 CP-6 a Stop on the cell bumps stops_version through placement_set_stops_version and the row at equals enforced_at', { ...T, skip: SKIP }, async () => {
  const pool = placementPool();
  const denied = await pool.query('UPDATE owner_slot SET stops_version = stops_version + 1 WHERE kind = $1 AND slot = 0', [DECL.kind])
    .then(() => 'NO_ERROR', (e: { code?: string }) => e.code);
  assert.equal(denied, '42501', 'placement has no UPDATE on owner_slot (V59-3)');
  const partition = utf8(`p-${R}`);
  const slot = slotOfPartition(partition, DECL.slotCount);
  const before0 = await stopsVersion(slot);
  const svc = new IntegrityStopService({
    store: new PgIntegrityStopStore({ pool }), locator: placementSlotLocator({ slotCounts: { [DECL.kind]: DECL.slotCount } }), heads: NO_HEADS,
  });
  const detectionRef = utf8(`det-${R}`);
  const ack = await svc.stop({ workload: 'audit' }, { kind: DECL.kind, partition, detectionRef });
  assert.equal(ack.state, 'STOPPED');
  assert.deepEqual(ack.fencedSlots, [slot]);
  assert.equal(await stopsVersion(slot), before0 + 1n);
  const row = await q().query<{ at: string; state: string; fenced_slots: number[] }>(
    'SELECT at::STRING AS at, state, fenced_slots FROM placement_integrity_stops WHERE kind = $1 AND partition = $2 AND detection_ref = $3',
    [DECL.kind, Buffer.from(partition), Buffer.from(detectionRef)]);
  assert.equal(row.rows.length, 1);
  assert.equal(hlc(row.rows[0]?.at ?? ''), ack.enforcedAt);
  assert.equal(row.rows[0]?.state, 'stopped');
  assert.deepEqual(row.rows[0]?.fenced_slots.map(Number), [slot]);
  assert.deepEqual(await svc.stop({ workload: 'audit' }, { kind: DECL.kind, partition, detectionRef }), ack, 'the same Stop gives the same StopAck');
  assert.equal(await stopsVersion(slot), before0 + 1n);
});
