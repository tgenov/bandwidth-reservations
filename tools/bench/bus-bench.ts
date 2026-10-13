/**
 * FeedBus client bench (E-001 §10): the runtime's KafkaBus (@platformatic/kafka) against the kafkajs
 * baseline on the dev cell. `npm run bench:bus` runs the default (platformatic, throughput).
 *
 *   BUS_CLIENT=platformatic|kafkajs node tools/bench/bus-bench.ts                  throughput run
 *   BUS_CLIENT=platformatic|kafkajs BUS_MODE=idle node tools/bench/bus-bench.ts    idle CPU run
 *
 * Throughput: produce RECORDS keyed 200-byte records with acks=all in batches of 100 to a new
 * 6-partition topic, then consume them all with one group member, one awaited record at a time,
 * with a commit every 100 records. Idle: a connected producer and consumer on an idle topic for
 * IDLE_MS; the result is the CPU time of the process in that period. One JSON line on stdout.
 */
import { randomBytes } from 'node:crypto';
import { Admin } from '@platformatic/kafka';
import { partitionForKey, type FeedBus } from '../../platform/runtime/src/feed/bus.ts';
import { KafkaBus } from '../../platform/runtime/src/feed/kafka-bus.ts';
import { KafkajsBus } from './kafkajs-bus.ts';

const CLIENT = process.env['BUS_CLIENT'] ?? 'platformatic';
const MODE = process.env['BUS_MODE'] ?? 'throughput';
const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
const RECORDS = Number(process.env['RECORDS'] ?? 20_000);
const BATCH = 100;
const PARTITIONS = 6;
const VALUE_BYTES = 200;
const COMMIT_EVERY = 100;
const IDLE_MS = Number(process.env['IDLE_MS'] ?? 30_000);
const RUN = `${CLIENT}-${randomBytes(4).toString('hex')}`;

function makeBus(clientId: string): FeedBus {
  if (CLIENT === 'kafkajs') return new KafkajsBus({ brokers: BROKERS, clientId });
  if (CLIENT === 'platformatic') return new KafkaBus({ brokers: BROKERS, clientId });
  throw new Error(`BUS_CLIENT must be platformatic or kafkajs, not ${CLIENT}`);
}

const ms = (ns: bigint): number => Number(ns) / 1e6;
const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};
const cpuMs = (c: NodeJS.CpuUsage): number => (c.user + c.system) / 1000;
const sleep = (t: number): Promise<void> => new Promise((r) => setTimeout(r, t));

async function throughput(): Promise<Record<string, unknown>> {
  const bus = makeBus(`bench-${RUN}`);
  const topic = `bench.${RUN}`;
  await bus.ensureTopic(topic, PARTITIONS);
  const keys = Array.from({ length: RECORDS }, (_, i) => Buffer.from(`key-${i}-${RUN}`));
  const value = randomBytes(VALUE_BYTES);

  const lat: number[] = [];
  const p0 = process.hrtime.bigint();
  for (let i = 0; i < RECORDS; i += BATCH) {
    const b0 = process.hrtime.bigint();
    await bus.produce(topic, keys.slice(i, i + BATCH).map((key) => ({ key, value, headers: { seq: String(i) } })));
    lat.push(ms(process.hrtime.bigint() - b0));
  }
  const produceMs = ms(process.hrtime.bigint() - p0);

  let seen = 0;
  let wrongPartition = 0;
  let firstAt: bigint | undefined;
  const next = new Map<number, bigint>();
  let done!: () => void;
  const all = new Promise<void>((r) => { done = r; });
  const c0 = process.hrtime.bigint();
  const sub = await bus.subscribe({
    groupId: `bench-group-${RUN}`, topics: [topic], fromBeginning: true,
    onRecord: async (r) => {
      firstAt ??= process.hrtime.bigint();
      await Promise.resolve();
      if (r.key && r.partition !== partitionForKey(r.key, PARTITIONS)) wrongPartition += 1;
      next.set(r.partition, r.offset + 1n);
      seen += 1;
      if (seen % COMMIT_EVERY === 0) {
        for (const [p, o] of next) await sub.commit(topic, p, o);
      }
      if (seen === RECORDS) done();
    },
  });
  await all;
  const c1 = process.hrtime.bigint();
  await sub.stop();
  const committed = await bus.committedOffsets(`bench-group-${RUN}`, topic);
  await bus.close();
  const consumeMs = ms(c1 - c0);
  const steadyMs = ms(c1 - (firstAt ?? c0));
  return {
    client: CLIENT, mode: MODE, records: RECORDS,
    produceRecPerS: Math.round(RECORDS / (produceMs / 1000)),
    consumeRecPerS: Math.round(RECORDS / (consumeMs / 1000)),
    consumeSteadyRecPerS: Math.round(RECORDS / (steadyMs / 1000)),
    groupJoinMs: Math.round(consumeMs - steadyMs),
    batchP50Ms: +pct(lat, 50).toFixed(2), batchP99Ms: +pct(lat, 99).toFixed(2),
    wrongPartition,
    committedTotal: [...committed.values()].reduce((a, b) => a + b, 0n).toString(),
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    cpuMs: Math.round(cpuMs(process.cpuUsage())),
  };
}

async function idle(): Promise<Record<string, unknown>> {
  const bus = makeBus(`bench-idle-${RUN}`);
  const topic = `bench.idle.${RUN}`;
  await bus.ensureTopic(topic, 1);
  let got = 0;
  const sub = await bus.subscribe({ groupId: `bench-idle-${RUN}`, topics: [topic], fromBeginning: true, onRecord: async () => { got += 1; } });
  await bus.produce(topic, [{ key: Buffer.from('k'), value: Buffer.from('v') }]);
  while (got === 0) await sleep(50);
  await sleep(2_000);
  const before = process.cpuUsage();
  await sleep(IDLE_MS);
  const used = process.cpuUsage(before);
  await sub.stop();
  await bus.close();
  return { client: CLIENT, mode: MODE, idleMs: IDLE_MS, idleCpuMs: Math.round(cpuMs(used)), rssMB: Math.round(process.memoryUsage().rss / 1048576) };
}

/** Delete the topics of this run, so that the bench leaves nothing on the broker. */
async function deleteTopics(topics: string[]): Promise<void> {
  const admin = new Admin({ clientId: `bench-cleanup-${RUN}`, bootstrapBrokers: BROKERS });
  try { await admin.deleteTopics({ topics }); } finally { await admin.close(); }
}

const out = MODE === 'idle' ? await idle() : await throughput();
await deleteTopics([MODE === 'idle' ? `bench.idle.${RUN}` : `bench.${RUN}`]);
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
