import pg from 'pg';
import { readFileSync } from 'node:fs';

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/bw';

export function pool(max = 10): pg.Pool {
  return new pg.Pool({ connectionString: DATABASE_URL, max });
}

export async function resetSchema(db: pg.Pool): Promise<void> {
  await db.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
}

// Peak usage over [s, e) from the facts, via their impulses. Only facts that
// overlap the window contribute; every one of them that started at or before s
// is still active at s, so the running sum of their impulses is the true usage
// for every t in [s, e). Usage only rises at change points, so the peak is the
// usage at s or at a change point strictly inside (s, e). An end impulse at
// exactly s is not an overlapping fact at all: half-open intervals.
const PEAK_SQL = `
  WITH overlapping AS (
    SELECT start_time, end_time, reserved_mbps
      FROM reservations
     WHERE link_id = $1
       AND ($3::timestamptz IS NULL OR start_time < $3)
       AND (end_time IS NULL OR end_time > $2)
  ), impulses AS (
    SELECT start_time AS t, reserved_mbps AS delta FROM overlapping
    UNION ALL
    SELECT end_time, -reserved_mbps FROM overlapping WHERE end_time IS NOT NULL
  ), points AS (
    SELECT t, SUM(delta) AS delta FROM impulses GROUP BY t
  ), running AS (
    SELECT t, SUM(delta) OVER (ORDER BY t) AS usage FROM points
  )
  SELECT GREATEST(
    COALESCE((SELECT usage FROM running WHERE t <= $2 ORDER BY t DESC LIMIT 1), 0),
    COALESCE((SELECT MAX(usage) FROM running
               WHERE t > $2 AND ($3::timestamptz IS NULL OR t < $3)), 0)
  )::int AS peak`;

export type SqlDecision = { ok: true } | { ok: false; peak: number };

export type Request = { linkId: number; start: Date; end: Date | null; mbps: number };

type Options = { lock: boolean; sleepSeconds?: number };

async function admitWith(db: pg.Pool, r: Request, opts: Options): Promise<SqlDecision> {
  const c = await db.connect();
  try {
    await c.query('BEGIN'); // READ COMMITTED: each statement sees what committed before it
    const link = await c.query(
      `SELECT capacity_mbps FROM links WHERE id = $1${opts.lock ? ' FOR UPDATE' : ''}`,
      [r.linkId],
    );
    const capacity: number = link.rows[0].capacity_mbps;
    const { rows } = await c.query(PEAK_SQL, [r.linkId, r.start, r.end]);
    const peak: number = rows[0].peak;
    if (peak + r.mbps > capacity) {
      await c.query('ROLLBACK');
      return { ok: false, peak };
    }
    if (opts.sleepSeconds) await c.query('SELECT pg_sleep($1)', [opts.sleepSeconds]);
    await c.query(
      'INSERT INTO reservations (link_id, start_time, end_time, reserved_mbps) VALUES ($1, $2, $3, $4)',
      [r.linkId, r.start, r.end, r.mbps],
    );
    await c.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

// The link row is the mutex for its schedule: every writer locks it first.
export const admit = (db: pg.Pool, r: Request) => admitWith(db, r, { lock: true });

// Deliberately broken: check-then-insert with no lock. Two transactions can
// both see room and both insert.
export const admitUnsafe = (db: pg.Pool, r: Request, sleepSeconds = 0) =>
  admitWith(db, r, { lock: false, sleepSeconds });

// The invariant, checked from the facts alone: the running total of all
// impulses on the link never exceeds its capacity.
export async function maxUsage(db: pg.Pool, linkId: number): Promise<number> {
  const { rows } = await db.query(
    `WITH impulses AS (
       SELECT start_time AS t, reserved_mbps AS delta FROM reservations WHERE link_id = $1
       UNION ALL
       SELECT end_time, -reserved_mbps FROM reservations WHERE link_id = $1 AND end_time IS NOT NULL
     ), points AS (SELECT t, SUM(delta) AS delta FROM impulses GROUP BY t)
     SELECT COALESCE(MAX(usage), 0)::int AS max_usage
       FROM (SELECT SUM(delta) OVER (ORDER BY t) AS usage FROM points) u`,
    [linkId],
  );
  return rows[0].max_usage;
}

export async function createLink(db: pg.Pool, id: number, capacity: number): Promise<void> {
  await db.query('INSERT INTO links (id, capacity_mbps) VALUES ($1, $2)', [id, capacity]);
}
