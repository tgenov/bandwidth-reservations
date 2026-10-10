import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { UsageTree } from '../src/tree.ts';
import { admit, admitUnsafe, createLink, maxUsage, pool, resetSchema, type Request } from '../src/sql.ts';
import { at, percentile, rng } from './helpers.ts';

const CLIENTS = 50;
const PER_CLIENT = 20;
const CAPACITY = 100;

const db = pool(CLIENTS);
before(() => resetSchema(db));
after(() => db.end());

// One hot link, heavily overlapping windows inside a two-hour span.
function requests(linkId: number, seed: number): Request[] {
  const rand = rng(seed);
  return Array.from({ length: CLIENTS * PER_CLIENT }, () => {
    const s = Math.floor(rand() * 90);
    return { linkId, start: at(s), end: at(s + 10 + Math.floor(rand() * 30)), mbps: 5 + Math.floor(rand() * 26) };
  });
}

async function hammer(rs: Request[], run: (r: Request) => Promise<{ ok: boolean }>) {
  const latencies: number[] = [];
  let accepted = 0;
  await Promise.all(
    Array.from({ length: CLIENTS }, async (_, c) => {
      for (const r of rs.slice(c * PER_CLIENT, (c + 1) * PER_CLIENT)) {
        const t0 = performance.now();
        if ((await run(r)).ok) accepted++;
        latencies.push(performance.now() - t0);
      }
    }),
  );
  return { accepted, p50: percentile(latencies, 50), p99: percentile(latencies, 99) };
}

const fmt = (ms: number) => `${ms.toFixed(2)} ms`;

test('safe admission never oversells a hot link under 50 concurrent clients', async () => {
  await createLink(db, 1, CAPACITY);
  const r = await hammer(requests(1, 42), (q) => admit(db, q));
  const peak = await maxUsage(db, 1);
  console.log(`safe:   ${r.accepted}/${CLIENTS * PER_CLIENT} accepted, peak ${peak}/${CAPACITY} Mbps, p50 ${fmt(r.p50)}, p99 ${fmt(r.p99)}`);
  assert.ok(peak <= CAPACITY);
  assert.ok(r.accepted > 0);
});

test('unsafe admission (no link lock) oversells', async () => {
  const runs = [];
  for (const [i, sleep] of [[0, 0], [1, 0.005]] as const) {
    const linkId = 10 + i;
    await createLink(db, linkId, CAPACITY);
    const r = await hammer(requests(linkId, 42), (q) => admitUnsafe(db, q, sleep));
    const peak = await maxUsage(db, linkId);
    console.log(`unsafe (pg_sleep ${sleep}s): ${r.accepted} accepted, peak ${peak}/${CAPACITY} Mbps${peak > CAPACITY ? ' — OVERSOLD' : ''}`);
    runs.push(peak);
  }
  assert.ok(runs.some((p) => p > CAPACITY), 'expected the lock-free variant to oversell');
});

test('in-memory tree latency', () => {
  const YEAR = 365 * 24 * 60;
  const tree = new UsageTree(YEAR);
  const rand = rng(7);
  const latencies: number[] = [];
  for (let i = 0; i < 100_000; i++) {
    const s = Math.floor(rand() * YEAR);
    const e = Math.min(YEAR, s + 1 + Math.floor(rand() * YEAR)); // up to a year long
    const t0 = performance.now();
    tree.admit(s, e, 1 + Math.floor(rand() * 10), 1_000_000);
    latencies.push(performance.now() - t0);
  }
  console.log(`tree:   100000 admits on a one-year minute domain, p50 ${(percentile(latencies, 50) * 1000).toFixed(1)} µs, p99 ${(percentile(latencies, 99) * 1000).toFixed(1)} µs`);
});
