/**
 * The dev cell gate for integration tests (engineering standard §6). On a laptop, a test skips with a clear
 * message when the dev cell is not reachable. With `REQUIRE_DEV_CELL=1` (the local `npm run ci`), an
 * unreachable dev cell is a failure, so a run that tested nothing cannot pass.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { systemClock, type WallClock } from '../src/clock.ts';

/** True when the environment requires the dev cell (`REQUIRE_DEV_CELL=1`). */
export function devCellRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['REQUIRE_DEV_CELL'] === '1';
}

/**
 * Gives the `skip` value for a test that needs the dev cell. `unreachable` is undefined when the dev cell
 * answers, else the reason it does not. Returns false when the dev cell answers. Returns the skip message
 * when it does not. Throws when `REQUIRE_DEV_CELL=1` and the dev cell does not answer.
 */
export function devCellSkip(unreachable: string | undefined, env: NodeJS.ProcessEnv = process.env): string | false {
  if (unreachable === undefined) return false;
  const reason = `dev cell not reachable: ${unreachable} (run \`npm run dev:up\`)`;
  if (devCellRequired(env)) throw new Error(`REQUIRE_DEV_CELL=1 and the ${reason}`);
  console.log(`# SKIP integration: ${reason}`);
  return reason;
}

const HOUR_MS = 3_600_000;
const PREFIX = /^[a-z][a-z0-9_]*$/;

/** `<prefix>_<wall ms>_<suffix>`: one database per test run (engineering standard §6). */
export function testDatabaseName(prefix: string, nowMs: number, suffix: string): string {
  if (!PREFIX.test(prefix)) throw new Error(`test database prefix must match [a-z][a-z0-9_]*: ${prefix}`);
  return `${prefix}_${Math.floor(nowMs)}_${suffix}`;
}

/** The databases of earlier runs with this prefix that are more than one hour old. */
export function staleTestDatabases(names: string[], prefix: string, nowMs: number): string[] {
  const own = new RegExp(`^${prefix}_(\\d+)_[a-z0-9]+$`);
  return names.filter((n) => {
    const m = own.exec(n);
    return m !== null && nowMs - Number(m[1]) > HOUR_MS;
  });
}

/** The connection string with its database replaced. */
export function databaseUrl(baseUrl: string, database: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

/**
 * Creates this run's own database on the dev cell and drops the databases of earlier runs with the
 * same prefix that are more than one hour old. `drop` removes this run's database; call it at the end.
 */
export async function createTestDatabase(baseUrl: string, prefix: string, o: { wallMs?: WallClock } = {}):
  Promise<{ name: string; url: string; drop: () => Promise<void> }> {
  const nowMs = (o.wallMs ?? systemClock)();
  const name = testDatabaseName(prefix, nowMs, randomBytes(3).toString('hex'));
  const admin = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = new pg.Client({ connectionString: baseUrl });
    await c.connect();
    try { return await fn(c); } finally { await c.end(); }
  };
  await admin(async (c) => {
    const rows = (await c.query<{ database_name: string }>('SELECT database_name FROM [SHOW DATABASES]')).rows;
    for (const stale of staleTestDatabases(rows.map((r) => r.database_name), prefix, nowMs)) {
      await c.query(`DROP DATABASE IF EXISTS ${stale} CASCADE`);
    }
    await c.query(`CREATE DATABASE ${name}`);
  });
  return { name, url: databaseUrl(baseUrl, name), drop: () => admin(async (c) => { await c.query(`DROP DATABASE IF EXISTS ${name} CASCADE`); }) };
}
