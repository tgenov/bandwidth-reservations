import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { BILLING_EVENTS, EventPublisher } from '../src/exposure/events';

export const DB_URL =
  process.env.BILLING_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/billing';

export async function resetSchema(): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL });
  await pool.query(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  await pool.end();
}

/** Records emitted events instead of sending them to Kafka. */
export class FakeEvents implements EventPublisher {
  sent: { topic: string; payload: any }[] = [];
  async emit(topic: string, payload: object) {
    this.sent.push({ topic, payload });
  }
  of(topic: string) {
    return this.sent.filter((e) => e.topic === topic);
  }
}

/**
 * The real AppModule with one provider swapped: DI makes the Kafka producer a
 * replaceable detail. Config is read from process.env when the module loads,
 * so set env before calling this.
 */
export async function testApp(env: Record<string, string> = {}) {
  Object.assign(process.env, env);
  const events = new FakeEvents();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(BILLING_EVENTS)
    .useValue(events)
    .compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: ['error'] });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  await app.init();
  return { app, events };
}

/** Deterministic PRNG (mulberry32) so failures reproduce from the seed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const T0 = new Date('2026-01-01T12:00:00Z');
export const at = (minutes: number, seconds = 0) =>
  new Date(T0.getTime() + minutes * 60_000 + seconds * 1000);

/**
 * Route R1: Nairobi → Mombasa → Marseille over suppliers A, B and C, with Share
 * taking a commission. Weights are basis points of each charge.
 */
export async function seedRoute(
  pool: Pool,
  opts: { priceMicrosPerGb?: number; effectiveFrom?: Date; version?: number } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO rates (route_id, effective_from, version, price_micros_per_gb)
     VALUES ('R1', $1, $2, $3) RETURNING id`,
    [opts.effectiveFrom ?? at(-60), opts.version ?? 1, opts.priceMicrosPerGb ?? 10_000],
  );
  const rateId = rows[0].id;
  await pool.query(
    `INSERT INTO rate_splits (rate_id, account, weight) VALUES
       ($1, 'supplier:A', 3000), ($1, 'supplier:B', 3333), ($1, 'supplier:C', 2167),
       ($1, 'revenue:share', 1500)`,
    [rateId],
  );
  return rateId;
}

export async function seedReservation(pool: Pool, id: string, customer: string, mbps = 2000) {
  await pool.query(
    `INSERT INTO reservations (id, customer_id, route_id, reserved_mbps) VALUES ($1, $2, 'R1', $3)`,
    [id, customer, mbps],
  );
}

export async function balances(pool: Pool): Promise<Record<string, string>> {
  const { rows } = await pool.query<{ account: string; b: string }>(
    `SELECT account, SUM(amount)::text AS b FROM entries GROUP BY account ORDER BY account`,
  );
  return Object.fromEntries(rows.map((r) => [r.account, r.b]));
}

/** Every journal sums to zero, so the whole ledger does too. */
export async function assertBooksBalance(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ unbalanced: string; total: string }>(
    `SELECT (SELECT count(*) FROM (SELECT journal_id FROM entries GROUP BY journal_id
                                   HAVING SUM(amount) <> 0) u)::text AS unbalanced,
            (SELECT COALESCE(SUM(amount), 0) FROM entries)::text AS total`,
  );
  expect(rows[0]).toEqual({ unbalanced: '0', total: '0' });
}
