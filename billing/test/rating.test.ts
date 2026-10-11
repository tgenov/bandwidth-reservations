import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { Db } from '../src/database/database.module';
import { LedgerService } from '../src/ledger/ledger.service';
import { FlowRecord, RatingService } from '../src/rating/rating.service';
import {
  DB_URL, assertBooksBalance, at, balances, resetSchema, rng, seedReservation, seedRoute, testApp,
} from './harness';

let app: INestApplication;
let pool: Pool;
let rating: RatingService;
let ledger: LedgerService;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL });
  ({ app } = await testApp());
  rating = app.get(RatingService);
  ledger = app.get(LedgerService);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function fresh() {
  await resetSchema();
  await seedRoute(pool, { priceMicrosPerGb: 10_000, effectiveFrom: at(-60) });
  // A price change mid-stream, so late records must be priced by event time.
  await seedRoute(pool, { priceMicrosPerGb: 13_000, effectiveFrom: at(20) });
  await seedReservation(pool, 'res1', 'c1');
  await seedReservation(pool, 'res2', 'c1');
  await seedReservation(pool, 'res3', 'c2');
}

function records(seed: number, n: number): FlowRecord[] {
  const r = rng(seed);
  const seq: Record<string, number> = {};
  return Array.from({ length: n }, () => {
    const exporterId = `e${1 + Math.floor(r() * 3)}`;
    seq[exporterId] = (seq[exporterId] ?? 0) + 1;
    return {
      exporterId,
      sequence: seq[exporterId],
      reservationId: `res${1 + Math.floor(r() * 3)}`,
      bytes: Math.floor(r() * 5e9),
      eventTime: at(Math.floor(r() * 40), Math.floor(r() * 60)),
    };
  });
}

/** What each (reservation, minute) was charged in total, from the wallet side. */
async function minuteTotals() {
  const { rows } = await pool.query(
    `SELECT j.reservation_id, j.minute, SUM(e.amount)::text AS total
       FROM journals j JOIN entries e ON e.journal_id = j.id
      WHERE e.account LIKE 'wallet:%' GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  return rows.map((x) => `${x.reservation_id}@${x.minute.toISOString()}=${x.total}`);
}

describe('rating and ledger (D18–D20)', () => {
  test.each([11, 12, 13])(
    'seed %i: duplicates, shuffling and late records give the same ledger as in-order delivery',
    async (seed) => {
      const recs = records(seed, 200);

      // Baseline: every record once, in event-time order, then rate everything.
      await fresh();
      for (const rec of [...recs].sort((a, b) => +a.eventTime - +b.eventTime)) await rating.ingest(rec);
      await rating.rateUpTo(at(41));
      const want = { balances: await balances(pool), minutes: await minuteTotals() };
      await assertBooksBalance(pool);

      // Chaos: shuffled, 30% delivered twice, and the watermark advances while
      // records are still arriving, so many land after their minute is charged.
      await fresh();
      const r = rng(seed * 1000);
      const deliveries = [...recs, ...recs.filter(() => r() < 0.3)].sort(() => r() - 0.5);
      let watermark = 0;
      let corrected = 0;
      for (const rec of deliveries) {
        if ((await rating.ingest(rec)) === 'corrected') corrected++;
        if (r() < 0.2) {
          watermark = Math.min(41, watermark + Math.floor(r() * 8));
          await rating.rateUpTo(at(watermark));
        }
      }
      await rating.rateUpTo(at(41));

      expect({ balances: await balances(pool), minutes: await minuteTotals() }).toEqual(want);
      expect(corrected).toBeGreaterThan(20); // the late path really was exercised
      await assertBooksBalance(pool);

      // D19: a late record only ever adds to a charge. With a monotone split
      // that holds for every party, so no correction claws back a supplier.
      const { rows } = await pool.query(
        `SELECT e.account, e.amount::text FROM journals j JOIN entries e ON e.journal_id = j.id
          WHERE j.kind = 'correction'`,
      );
      for (const row of rows) {
        if (row.account.startsWith('wallet:')) expect(BigInt(row.amount) < 0n).toBe(true);
        else expect(BigInt(row.amount) > 0n).toBe(true);
      }
    },
  );

  test('concurrent ingestion and rating lose no record (the minute lock)', async () => {
    const recs = records(21, 400);
    await fresh();
    for (const rec of recs) await rating.ingest(rec);
    await rating.rateUpTo(at(41));
    const want = await balances(pool);

    // Eight ingest workers race a rating loop that keeps closing minutes.
    await fresh();
    const queue = [...recs].sort((a, b) => +a.eventTime - +b.eventTime);
    let done = false;
    const workers = Array.from({ length: 8 }, async () => {
      for (let rec = queue.shift(); rec; rec = queue.shift()) await rating.ingest(rec);
    });
    const rater = (async () => {
      for (let m = 0; !done; m = Math.min(41, m + 1)) await rating.rateUpTo(at(m));
    })();
    await Promise.all(workers);
    done = true;
    await rater;
    await rating.rateUpTo(at(41));
    expect(await balances(pool)).toEqual(want);
    await assertBooksBalance(pool);
  });

  test('a record that races its minute being rated is still charged (forced interleaving)', async () => {
    await fresh();
    await rating.ingest({ exporterId: 'e1', sequence: 1, reservationId: 'res1', bytes: 1e9, eventTime: at(0, 10) });

    // Pause ingest just after it asks "is this minute rated?", while its record
    // is inserted but not committed. Rating the minute in that gap is the race.
    const pool = app.get(Db).pool;
    const connect = pool.connect.bind(pool);
    let paused: Promise<void> | undefined;
    let release!: () => void;
    // pool.query() calls connect(callback); only the promise form (used by Db.tx) is wrapped.
    (pool as any).connect = async (cb?: any) => {
      if (cb) return connect(cb);
      const client: any = await connect();
      const query = client.query.bind(client);
      // Pass every argument through: pg-pool itself calls query(text, values, callback).
      client.query = async (...args: any[]) => {
        const out = await query(...args);
        const sql = args[0];
        if (typeof sql === 'string' && sql.includes('FROM minute_charges WHERE reservation_id') && !paused) {
          paused = new Promise((r) => (release = r));
          await Promise.race([paused, new Promise((r) => setTimeout(r, 300))]);
        }
        return out;
      };
      return client;
    };
    try {
      const late = rating.ingest({ exporterId: 'e1', sequence: 2, reservationId: 'res1', bytes: 1e9, eventTime: at(0, 50) });
      while (!paused) await new Promise((r) => setTimeout(r, 5));
      const rated = rating.rateUpTo(at(1)); // blocks on the minute lock if it is taken
      await new Promise((r) => setTimeout(r, 100));
      release();
      await Promise.all([late, rated]);
    } finally {
      (pool as any).connect = connect;
    }
    await rating.rateUpTo(at(1));
    expect((await balances(pool))['wallet:c1']).toBe('-20000'); // both GB charged
  });

  test('late usage never claws back a supplier, even where largest remainder would (Alabama paradox)', async () => {
    await resetSchema();
    // Weights from split.test.ts where largest remainder takes a unit away from
    // supplier:a when the amount rises from 31 to 32. 1,000,000 micros per GB
    // makes 31,000 bytes cost exactly 31 micros.
    const { rows } = await pool.query(
      `INSERT INTO rates (route_id, effective_from, price_micros_per_gb) VALUES ('R2', $1, 1000000) RETURNING id`,
      [at(-60)],
    );
    await pool.query(
      `INSERT INTO rate_splits VALUES ($1, 'supplier:a', 31), ($1, 'supplier:b', 76), ($1, 'supplier:c', 70)`,
      [rows[0].id],
    );
    await pool.query(`INSERT INTO reservations VALUES ('resA', 'c1', 'R2', 100)`);

    await rating.ingest({ exporterId: 'e1', sequence: 1, reservationId: 'resA', bytes: 31_000, eventTime: at(0, 5) });
    await rating.rateUpTo(at(1));
    const before = await ledger.balance('supplier:a');

    await rating.ingest({ exporterId: 'e1', sequence: 2, reservationId: 'resA', bytes: 1_000, eventTime: at(0, 40) });
    expect(await ledger.balance('wallet:c1')).toBe(-32n);
    expect(await ledger.balance('supplier:a')).toBeGreaterThanOrEqual(before);
    await assertBooksBalance(pool);
  });

  test('a late record is priced at the rate of its own event time, not of its arrival', async () => {
    await fresh();
    await rating.ingest({ exporterId: 'e1', sequence: 1, reservationId: 'res1', bytes: 1e9, eventTime: at(5, 10) });
    await rating.ingest({ exporterId: 'e1', sequence: 2, reservationId: 'res1', bytes: 1e9, eventTime: at(25, 0) });
    await rating.rateUpTo(at(30)); // minute 5 and minute 25 charged; the 13,000 price is now in force

    // Arrives long after the price change, for minute 5.
    expect(
      await rating.ingest({ exporterId: 'e1', sequence: 3, reservationId: 'res1', bytes: 1e9, eventTime: at(5, 50) }),
    ).toBe('corrected');

    const totals = await minuteTotals();
    expect(totals).toEqual([
      `res1@${at(5).toISOString()}=-20000`, // 2 GB at 10,000 per GB: the old price
      `res1@${at(25).toISOString()}=-13000`, // 1 GB at the new price
    ]);
    await assertBooksBalance(pool);
  });

  test('a price correction claws back a paid supplier, netted against the next payout', async () => {
    await resetSchema();
    await seedRoute(pool, { priceMicrosPerGb: 10_000, effectiveFrom: at(-60) });
    await seedReservation(pool, 'res1', 'c1');

    await rating.ingest({ exporterId: 'e1', sequence: 1, reservationId: 'res1', bytes: 10e9, eventTime: at(0, 30) });
    await rating.rateUpTo(at(1));
    const first = await ledger.payoutRun();
    expect(first.get('supplier:A')).toBe(30_000n); // 30% of 100,000

    // The price was wrong: version 2 at the same effective time halves it.
    await seedRoute(pool, { priceMicrosPerGb: 5_000, effectiveFrom: at(-60), version: 2 });
    await rating.rerate('R1', at(-60), at(60));
    expect(await ledger.balance('supplier:A')).toBe(-15_000n); // already paid 30,000, owed 15,000
    expect(await ledger.balance('wallet:c1')).toBe(-50_000n);

    // A negative balance is not paid, and later earnings net against it.
    expect((await ledger.payoutRun()).has('supplier:A')).toBe(false);
    await rating.ingest({ exporterId: 'e1', sequence: 2, reservationId: 'res1', bytes: 20e9, eventTime: at(1, 30) });
    await rating.rateUpTo(at(2));
    expect((await ledger.payoutRun()).get('supplier:A')).toBe(15_000n); // 30,000 earned − 15,000 owed
    expect(await ledger.balance('supplier:A')).toBe(0n);
    await assertBooksBalance(pool);
  });

  test('the database refuses unbalanced journals and edits to the ledger', async () => {
    await resetSchema();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query(`INSERT INTO journals (kind) VALUES ('topup') RETURNING id`);
      await c.query(`INSERT INTO entries VALUES ($1, 'wallet:x', 100), ($1, 'clearing', -99)`, [rows[0].id]);
      await expect(c.query('COMMIT')).rejects.toThrow(/does not balance/);
    } finally {
      c.release();
    }
    await pool.query(`INSERT INTO journals (kind) VALUES ('topup')`);
    await expect(pool.query(`UPDATE journals SET kind = 'payout'`)).rejects.toThrow(/append-only/);
  });

  test('throughput: direct ingestion (no Kafka)', async () => {
    await fresh();
    const recs = records(99, 3000);
    const t = performance.now();
    for (const rec of recs) await rating.ingest(rec);
    const perSecond = Math.round(recs.length / ((performance.now() - t) / 1000));
    console.log(`direct ingest: ${perSecond} records/s (sequential, one transaction each)`);
    expect(perSecond).toBeGreaterThan(0);
  });
});
