import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { ExposureService } from '../src/exposure/exposure.service';
import { TOPICS } from '../src/exposure/events';
import { RatingService } from '../src/rating/rating.service';
import {
  DB_URL, assertBooksBalance, at, balances, resetSchema, rng, seedReservation, seedRoute,
  testApp,
} from './harness';

let pool: Pool;
beforeAll(() => {
  pool = new Pool({ connectionString: DB_URL });
});
afterAll(() => pool.end());

describe('payment webhooks (D19 wallet)', () => {
  let app: INestApplication;
  beforeAll(async () => ({ app } = await testApp({ EXPOSURE_POLICY: 'credit_limit' })));
  afterAll(() => app.close());

  test('repeated and out-of-order webhooks credit the wallet exactly once', async () => {
    await resetSchema();
    const events = [
      { providerTxnId: 'MP1', type: 'completed', customerId: 'c1', amountMicros: '5000000', occurredAt: at(0) },
      { providerTxnId: 'MP2', type: 'completed', customerId: 'c1', amountMicros: '3000000', occurredAt: at(1) },
      { providerTxnId: 'MP2', type: 'reversed', customerId: 'c1', amountMicros: '3000000', occurredAt: at(2) },
    ];
    const r = rng(7);
    // Each event delivered three times, in random order: reversals can overtake completions.
    const deliveries = [...events, ...events, ...events].sort(() => r() - 0.5);
    const results: string[] = [];
    for (const e of deliveries) {
      const res = await request(app.getHttpServer()).post('/webhooks/payments').send(e).expect(200);
      results.push(res.body.result);
    }
    expect(results.filter((x) => x === 'applied')).toHaveLength(3);
    expect((await balances(pool))['wallet:c1']).toBe('5000000');
    await assertBooksBalance(pool);

    const wallet = await request(app.getHttpServer()).get('/wallets/c1').expect(200);
    expect(wallet.body.balanceMicros).toBe('5000000');
  });

  test('malformed webhooks are rejected by the validation pipe', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/payments')
      .send({ providerTxnId: 'MP9', type: 'refunded', customerId: 'c1', amountMicros: '-5', occurredAt: 'x' })
      .expect(400);
  });
});

// Reserved 2,000 Mbps for 180 s metering lag + 60 s enforcement lag
// = 60 GB, at 10,000 micros per GB = 600,000 micros of exposure.
const EXPOSURE = 600_000n;

async function setup(app: INestApplication, topup: string) {
  await resetSchema();
  await seedRoute(pool, { priceMicrosPerGb: 10_000, effectiveFrom: at(-60) });
  await seedReservation(pool, 'res1', 'c1', 2000);
  await request(app.getHttpServer()).post('/webhooks/payments').send({
    providerTxnId: 'T1', type: 'completed', customerId: 'c1', amountMicros: topup, occurredAt: at(0),
  }).expect(200);
}

async function use(app: INestApplication, seq: number, gb: number, minute: number) {
  const rating = app.get(RatingService);
  await rating.ingest({ exporterId: 'e1', sequence: seq, reservationId: 'res1', bytes: gb * 1e9, eventTime: at(minute, 1) });
  await rating.rateUpTo(at(minute + 1));
}

describe('exposure bound (D19)', () => {
  test('reserve policy: suspends once when balance falls to the exposure, resumes after a top-up', async () => {
    const { app, events } = await testApp({
      EXPOSURE_POLICY: 'reserve', METERING_LAG_SECONDS: '180', ENFORCEMENT_LAG_SECONDS: '60',
    });
    try {
      await setup(app, '1000000');
      const exposure = app.get(ExposureService);
      expect((await exposure.standing('c1')).exposure).toBe(EXPOSURE);

      await use(app, 1, 30, 0); // −300,000 → balance 700,000, available 100,000
      expect(events.of(TOPICS.suspend)).toHaveLength(0);

      await use(app, 2, 10, 1); // −100,000 → available exactly 0: no headroom left
      expect(events.of(TOPICS.suspend)).toEqual([
        { topic: TOPICS.suspend, payload: { customerId: 'c1', available: '0' } },
      ]);

      await use(app, 3, 5, 2); // still in the lag window: charged, but no second event
      expect(events.of(TOPICS.suspend)).toHaveLength(1);

      await request(app.getHttpServer()).post('/webhooks/payments').send({
        providerTxnId: 'T2', type: 'completed', customerId: 'c1', amountMicros: '500000', occurredAt: at(3),
      }).expect(200);
      expect(events.of(TOPICS.resume)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  test('reserve policy: admission is refused when a new reservation would leave no headroom', async () => {
    const { app } = await testApp({
      EXPOSURE_POLICY: 'reserve', METERING_LAG_SECONDS: '180', ENFORCEMENT_LAG_SECONDS: '60',
    });
    try {
      await setup(app, '1000000'); // res1 already holds 600,000 of exposure
      const exposure = app.get(ExposureService);
      expect((await exposure.canAdmit('c1', 'R1', 500)).allowed).toBe(true); // +150,000
      expect((await exposure.canAdmit('c1', 'R1', 2000)).allowed).toBe(false); // +600,000
    } finally {
      await app.close();
    }
  });

  test('credit-limit policy: suspends when the balance reaches minus the limit', async () => {
    const { app, events } = await testApp({ EXPOSURE_POLICY: 'credit_limit', CREDIT_LIMIT_MICROS: '200000' });
    try {
      await setup(app, '100000');
      await use(app, 1, 25, 0); // −250,000 → balance −150,000, available 50,000
      expect(events.of(TOPICS.suspend)).toHaveLength(0);
      await use(app, 2, 5, 1); // −50,000 → balance −200,000, available 0
      expect(events.of(TOPICS.suspend)).toHaveLength(1);
      await assertBooksBalance(pool);
    } finally {
      await app.close();
    }
  });
});

