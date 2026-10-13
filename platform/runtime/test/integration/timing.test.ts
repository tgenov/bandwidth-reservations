/**
 * Integration tests of placement's timing writer on the dev cell (RFC-006 §6.4; C01 §2.3; plan S-PLAT-I2 work
 * item 6). They skip with a message when CockroachDB is not reachable at DATABASE_URL, and fail instead with
 * REQUIRE_DEV_CELL=1.
 */
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { applyMigrations, platformMigration } from '@share/owner-migrate';
import { createTestDatabase, devCellSkip } from '../../testing/dev-cell.ts';
import { TimingVersionRefused, readTimingVersion, writeTimingVersion, type TimingVersion } from '../../src/placement/timing.ts';

const URL = process.env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';

async function dbReachable(): Promise<string | undefined> {
  const c = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 1_500 });
  try { await c.connect(); await c.query('SELECT 1'); return undefined; } catch (e) { return (e as { code?: string }).code ?? String(e); } finally { await c.end().catch(() => {}); }
}

const dbError = await dbReachable();
const SKIP = devCellSkip(dbError === undefined ? undefined : `CockroachDB at ${URL}: ${dbError}`);

/** Each test has a hard timeout, so that a hang fails fast. */
const T = { timeout: 120_000 };

let db: { name: string; url: string; drop: () => Promise<void> } | undefined;
before(async () => {
  if (SKIP) return;
  db = await createTestDatabase(URL, 'itiming');
  await applyMigrations(db.url, [platformMigration()]);
}, T);
after(async () => { await db?.drop(); }, T);

/** Every pool that a test opens. afterEach closes them, also when an assertion fails. */
const open: pg.Pool[] = [];
afterEach(async () => {
  for (const p of open.splice(0)) await p.end().catch(() => {});
});

function pool(): pg.Pool {
  if (db === undefined) throw new Error('no test database');
  const p = new pg.Pool({ connectionString: db.url, max: 4 });
  open.push(p);
  return p;
}

type Row = { shard: number; version: string; epsilon_ms: number; delta_x_ms: number; tau_ms: number; second_lane: unknown };

async function allRows(p: pg.Pool, asOf?: string): Promise<Row[]> {
  if (asOf !== undefined && !/^\d+\.\d+$/.test(asOf)) throw new Error(`not an HLC timestamp: ${asOf}`);
  const aost = asOf === undefined ? '' : ` AS OF SYSTEM TIME '${asOf}'`;
  return (await p.query<Row>(
    `SELECT shard, version::STRING AS version, epsilon_ms, delta_x_ms, tau_ms, second_lane FROM platform_timing${aost} ORDER BY shard`)).rows;
}

async function hlcNow(p: pg.Pool): Promise<string> {
  return (await p.query<{ t: string }>('SELECT cluster_logical_timestamp()::STRING AS t')).rows[0]?.t ?? '';
}

/** The versions in one read of all 64 rows. */
const versionsOf = (rows: Row[]): string[] => [...new Set(rows.map((r) => r.version))];

test('DT-10 placement writes a new platform_timing version to all 64 shards in one transaction', { ...T, skip: SKIP }, async () => {
  const p = pool();
  const initial = await allRows(p);
  assert.equal(initial.length, 64);
  const start = BigInt(versionsOf(initial)[0] ?? '0');
  assert.deepEqual(versionsOf(initial), [start.toString()]);

  const v: TimingVersion = { epsilonMs: 100, deltaXMs: 340, tauMs: 440, secondLane: { account: { deadline: true }, link: { deadline: true } } };
  assert.equal(await writeTimingVersion(p, v), start + 1n);
  const rows = await allRows(p);
  assert.equal(rows.length, 64);
  assert.deepEqual(rows.map((r) => r.shard), Array.from({ length: 64 }, (_, i) => i));
  for (const r of rows) {
    assert.deepEqual({ version: r.version, e: r.epsilon_ms, d: r.delta_x_ms, t: r.tau_ms, lane: r.second_lane },
      { version: (start + 1n).toString(), e: 100, d: 340, t: 440, lane: { account: { deadline: true }, link: { deadline: true } } });
  }
  assert.deepEqual(await readTimingVersion(p, 37),
    { version: start + 1n, epsilonMs: 100, deltaXMs: 340, tauMs: 440, secondLane: { account: { deadline: true }, link: { deadline: true } } });
});

test('DT-10 a reader never sees mixed platform_timing versions while placement writes new ones', { ...T, skip: SKIP }, async () => {
  const p = pool();
  const reader = pool();
  const t0 = await hlcNow(p);
  const writes = 6;
  let writing = true;
  const presentReads: string[][] = [];
  const readLoop = (async () => {
    while (writing) presentReads.push(versionsOf(await allRows(reader)));
  })();
  const written: bigint[] = [];
  try {
    for (let i = 0; i < writes; i++) {
      written.push(await writeTimingVersion(p, { epsilonMs: 100, deltaXMs: 300 + i * 10, tauMs: 400 + i * 10, secondLane: {} }));
    }
  } finally {
    writing = false;
    await readLoop;
  }
  const t1 = await hlcNow(p);
  assert.equal(presentReads.length > 0, true);
  for (const r of presentReads) assert.equal(r.length, 1, `mixed versions in one read: ${r.join(', ')}`);

  // Read at timestamps spread over the whole write period: each read is of one version.
  const from = BigInt(t0.split('.')[0] ?? '0');
  const to = BigInt(t1.split('.')[0] ?? '0');
  const steps = 200n;
  const seen = new Set<string>();
  for (let k = 0n; k <= steps; k++) {
    const at = `${from + ((to - from) * k) / steps}.0000000000`;
    const vs = versionsOf(await allRows(reader, at));
    assert.equal(vs.length, 1, `mixed versions as of ${at}: ${vs.join(', ')}`);
    seen.add(vs[0] ?? '');
  }
  const last = written[written.length - 1];
  assert.ok(last !== undefined);
  assert.equal(seen.has(last.toString()), true);
  assert.equal(seen.has((last - BigInt(writes)).toString()), true);
  assert.equal(seen.size > 2, true);
});

test('DT-10 a refused platform_timing version changes no row', { ...T, skip: SKIP }, async () => {
  const p = pool();
  const initial = await allRows(p);
  await assert.rejects(writeTimingVersion(p, { epsilonMs: 100, deltaXMs: 360, tauMs: 460, secondLane: {} }),
    (e: unknown) => e instanceof TimingVersionRefused && e.code === 'TAU_ABOVE_CAP');
  await assert.rejects(writeTimingVersion(p, { epsilonMs: 100, deltaXMs: 360, tauMs: 440, secondLane: {} }),
    (e: unknown) => e instanceof TimingVersionRefused && e.code === 'TAU_BELOW_EPSILON_PLUS_DELTA_X');
  assert.deepEqual(await allRows(p), initial);
});
