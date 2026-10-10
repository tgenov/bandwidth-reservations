import { INestApplication } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { Kafka, logLevel } from 'kafkajs';
import { Pool } from 'pg';
import { firstValueFrom } from 'rxjs';
import { TOPICS } from '../src/exposure/events';
import { createApp } from '../src/main';
import { RatingService } from '../src/rating/rating.service';
import { DB_URL, assertBooksBalance, at, resetSchema, rng, seedReservation, seedRoute } from './harness';

const BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:59092').split(',');
const RUN = `e2e-${Date.now()}`;
const kafka = new Kafka({ clientId: 'billing-e2e', brokers: BROKERS, logLevel: logLevel.NOTHING });

let app: INestApplication;
let pool: Pool;
let rpc: ClientKafka;

async function recreateTopics() {
  const admin = kafka.admin();
  await admin.connect();
  const topics = [
    TOPICS.flowRecords, TOPICS.suspend, TOPICS.resume,
    TOPICS.walletBalance, `${TOPICS.walletBalance}.reply`,
    TOPICS.admissionCheck, `${TOPICS.admissionCheck}.reply`,
  ];
  const existing = await admin.listTopics();
  const stale = topics.filter((t) => existing.includes(t));
  if (stale.length) await admin.deleteTopics({ topics: stale });
  // Deletion is asynchronous on the broker; retry creation until it sticks.
  for (let i = 0; i < 20; i++) {
    try {
      await admin.createTopics({
        waitForLeaders: true,
        topics: topics.map((topic) => ({ topic, numPartitions: topic === TOPICS.flowRecords ? 3 : 1 })),
      });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  await admin.disconnect();
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL });
  await resetSchema();
  await seedRoute(pool, { priceMicrosPerGb: 10_000, effectiveFrom: at(-60) });
  await seedReservation(pool, 'res1', 'c1');
  await seedReservation(pool, 'res2', 'c2');
  await recreateTopics();

  // The real hybrid app, real Kafka producer included. A fresh consumer group per run.
  Object.assign(process.env, { KAFKA_GROUP_ID: RUN, EXPOSURE_POLICY: 'credit_limit', CREDIT_LIMIT_MICROS: '0' });
  app = await createApp();
  await app.startAllMicroservices();
  await app.init();

  rpc = new ClientKafka({
    client: { clientId: `${RUN}-rpc`, brokers: BROKERS },
    consumer: { groupId: `${RUN}-rpc` },
  });
  // Request-reply needs the client to listen on "<topic>.reply" before sending.
  rpc.subscribeToResponseOf(TOPICS.walletBalance);
  await rpc.connect();
}, 120_000);

afterAll(async () => {
  await rpc?.close();
  await app?.close();
  await pool?.end();
});

test('duplicated records on Kafka are ingested once and rated into a balanced ledger', async () => {
  const r = rng(5);
  const unique = Array.from({ length: 3000 }, (_, i) => ({
    exporterId: `e${i % 3}`,
    sequence: Math.floor(i / 3) + 1,
    reservationId: r() < 0.5 ? 'res1' : 'res2',
    bytes: Math.floor(r() * 2e9),
    eventTime: at(Math.floor(r() * 10), Math.floor(r() * 60)).toISOString(),
  }));
  const deliveries = [...unique, ...unique.filter(() => r() < 0.2)].sort(() => r() - 0.5);

  const producer = kafka.producer();
  await producer.connect();
  const t = performance.now();
  // Keyed by exporter, so one exporter's records stay on one partition.
  for (let i = 0; i < deliveries.length; i += 500) {
    await producer.send({
      topic: TOPICS.flowRecords,
      messages: deliveries.slice(i, i + 500).map((d) => ({ key: d.exporterId, value: JSON.stringify(d) })),
    });
  }
  await producer.disconnect();

  await waitFor(async () => {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM flow_records`);
    return rows[0].n === unique.length;
  }, 90_000);
  const seconds = (performance.now() - t) / 1000;
  console.log(
    `kafka ingest: ${deliveries.length} deliveries (${unique.length} unique) in ${seconds.toFixed(1)} s ` +
      `= ${Math.round(deliveries.length / seconds)} deliveries/s`,
  );

  await app.get(RatingService).rateUpTo(at(11));
  await assertBooksBalance(pool);

  // Expected charge from the unique records, minute by minute, at 10,000 per GB.
  const perMinute = new Map<string, bigint>();
  for (const u of unique) {
    const key = `${u.reservationId}|${u.eventTime.slice(0, 16)}`;
    perMinute.set(key, (perMinute.get(key) ?? 0n) + BigInt(u.bytes));
  }
  let expected = 0n;
  for (const bytes of perMinute.values()) expected += (bytes * 10_000n + 500_000_000n) / 1_000_000_000n;
  const { rows } = await pool.query(
    `SELECT (-SUM(amount))::text AS charged FROM entries WHERE account LIKE 'wallet:%'`,
  );
  expect(BigInt(rows[0].charged)).toBe(expected);
}, 120_000);

test('request-reply: @MessagePattern answers a wallet balance query over Kafka', async () => {
  const reply = await firstValueFrom(rpc.send(TOPICS.walletBalance, { customerId: 'c1' }));
  const { rows } = await pool.query(`SELECT SUM(amount)::text AS b FROM entries WHERE account = 'wallet:c1'`);
  expect(reply).toMatchObject({ customerId: 'c1', balanceMicros: rows[0].b });
}, 30_000);

test('fire-and-forget: the suspend event reaches Kafka', async () => {
  // Both customers have negative balances under a zero credit limit.
  const consumer = kafka.consumer({ groupId: `${RUN}-suspend` });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPICS.suspend, fromBeginning: true });
  const seen = new Set<string>();
  await consumer.run({
    eachMessage: async ({ message }) => {
      seen.add(JSON.parse(message.value!.toString()).customerId);
    },
  });
  await waitFor(async () => seen.has('c1') && seen.has('c2'));
  await consumer.disconnect();
}, 60_000);
