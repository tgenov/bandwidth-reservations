/**
 * MONEY-I3 exit criterion 6 (X2-S13): usage lines are posted within `max_lateness` + 120 s of their minute's end
 * at p99 at the test load, and a refused usage batch costs one gated cycle (est. 2.5 s, RFC-004 R4-B11). C06
 * "Timeouts and deadlines": at the hard close bound (285 s after the minute's end) 15 s remain, so the time from
 * emission to `posted` must be at most 15 s at p99. The usage batches go through settlement to the real ledger on
 * the C01 runtime and the dev cell. It runs only with MONEY_MEASURE=1 (`npm run measure`), by hand: a wall-clock
 * bound fails on a loaded machine. MONEY_MEASURE_STRICT=0 reports the numbers without the bounds.
 * MONEY_MEASURE_SECONDS sets the run length (default 20 s), MONEY_MEASURE_USAGE_RATE the usage batches a second
 * (default 20) and MONEY_MEASURE_USAGE_LINES the lines a batch (default 100).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { CockroachOwnerRuntime, ManualLoad, MemoryPublisher, PgStore, slotOfPartition, systemClock, utf8 } from '@share/owner-runtime';
import { migrateKinds } from '@share/owner-migrate';
import { createTestDatabase, devCellSkip } from '@share/owner-runtime/testing';
import {
  LEDGER_DEV_SLOT_COUNT, LedgerOwner, Settlement, TimerScheduler, ledgerDeclaration, ledgerPartitionOfBuyer,
  type ChargeLine, type LedgerAnswer, type PostCall, type PostingAck,
} from '../../src/index.ts';
import { chargeLine, usageBatch, usageRef, weightsFixture } from '../../testing/index.ts';

const URL = process.env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';
const enabled = process.env['MONEY_MEASURE'] === '1';
const strict = process.env['MONEY_MEASURE_STRICT'] !== '0';
const SECONDS = Number(process.env['MONEY_MEASURE_SECONDS'] ?? '20');
const RATE = Number(process.env['MONEY_MEASURE_USAGE_RATE'] ?? '20');
const LINES = Number(process.env['MONEY_MEASURE_USAGE_LINES'] ?? '100');
/** C06 "Timeouts and deadlines": 300 s − 285 s (the hard close bound). */
const POST_BOUND_MS = 15_000;
/** RFC-004 R4-B11 (est.): one gated cycle. */
const CYCLE_MS = 2_500;

async function dbReachable(): Promise<string | undefined> {
  const c = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 1_500 });
  try { await c.connect(); await c.query('SELECT 1'); return undefined; } catch (e) { return (e as { code?: string }).code ?? String(e); } finally { await c.end().catch(() => {}); }
}

const SKIP = !enabled ? 'set MONEY_MEASURE=1 (npm run measure)' : devCellSkip((await dbReachable()) === undefined ? undefined : `CockroachDB at ${URL}`);
const FAST = { sessionTtlMs: 1_500, sessionRenewMs: 200, renewRetryMs: 100, holderViewMs: 1_400, maxLoopDelayMs: 100 };

function accountsOnOnePartition(n: number): string[] {
  const target = ledgerPartitionOfBuyer('u-0');
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) if (ledgerPartitionOfBuyer(`u-${i}`) === target) out.push(`u-${i}`);
  return out;
}

const minuteAt = (m: number): string => new Date(Date.UTC(2026, 9, 12, 9, 0) + m * 60_000).toISOString().replace('.000Z', 'Z');

test('measurement: usage batches are posted within max_lateness + 120 s of their minute at p99 (15 s from emission at the hard close bound), and a refused usage batch costs one gated cycle',
  { skip: SKIP, timeout: 600_000 }, async () => {
  const db = await createTestDatabase(URL, 'itest_money_usage_measure');
  const store = new PgStore({ connectionString: db.url });
  const decl = ledgerDeclaration();
  const accounts = accountsOnOnePartition(16);
  const slot = slotOfPartition(utf8(ledgerPartitionOfBuyer(accounts[0]!)), LEDGER_DEV_SLOT_COUNT);
  const scheduler = new TimerScheduler();
  let rt: CockroachOwnerRuntime | undefined;
  try {
    await migrateKinds(db.url, [decl], { presplit: false });
    rt = new CockroachOwnerRuntime({ declaration: decl, store, slots: [slot], publisher: new MemoryPublisher(), load: new ManualLoad(), testing: { sessionTimings: FAST } });
    const ledger = new LedgerOwner(rt, { weights: weightsFixture() });
    await rt.start(ledger);
    const startWait = systemClock();
    while (!rt.heldSlots().includes(slot)) {
      if (systemClock() - startWait > 15_000) throw new Error('slot not acquired');
      await new Promise((r) => setTimeout(r, 50));
    }
    const emitted = new Map<string, number>();
    const latencies: number[] = [];
    const answered = new Map<string, (ack: PostingAck | 'committed') => void>();
    const port = {
      post: async (call: PostCall): Promise<LedgerAnswer> => {
        const a = await ledger.post(call);
        if (a.result === 'committed') {
          latencies.push(systemClock() - emitted.get(call.request.movementRef)!);
          answered.get(call.request.movementRef)?.('committed');
        }
        return a;
      },
      lineState: ledger.lineState.bind(ledger),
    };
    const settlement = new Settlement({ ledger: port, weights: weightsFixture(), scheduler, commitOffset: async () => {},
      publishAcks: async (ack) => { answered.get(ack.batchId)?.(ack); } });
    // Load: each account emits one usage batch at a time (C06: one in flight), originals then late traffic.
    const total = SECONDS * RATE;
    const t0 = systemClock();
    let offset = 0n;
    for (let i = 0; i < total; i++) {
      const due = t0 + (i * 1_000) / RATE;
      const wait = due - systemClock();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const account = accounts[i % accounts.length]!;
      const round = Math.floor(i / accounts.length);
      const lines: ChargeLine[] = Array.from({ length: LINES }, (_, k) => chargeLine(account, usageRef(account, 'R1', minuteAt(round), 0, `p-${k}`), 'usage', 0n, 1_000n + BigInt(k), { product: `p-${k}` }));
      const b = usageBatch(`rating-u:0:${i}:0`, account, lines);
      emitted.set(b.batch.id, systemClock());
      settlement.receive({ partition: 0, offset: offset++ }, b);
    }
    await settlement.idle();
    latencies.sort((x, y) => x - y);
    const p = (q: number): number => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!;

    // One gated cycle: a batch refused for a content conflict, then rating's re-emission without the problem line.
    const account = accounts[0]!;
    const changed = chargeLine(account, usageRef(account, 'R1', minuteAt(0), 0, 'p-0'), 'usage', 0n, 1n, { product: 'p-0' });
    const fresh = chargeLine(account, usageRef(account, 'R1', minuteAt(10_000), 0), 'usage', 0n, 5n);
    const c0 = systemClock();
    const refused = usageBatch('rating-u:0:refused:0', account, [changed, fresh]);
    const gotRefusal = new Promise<PostingAck | 'committed'>((resolve) => answered.set(refused.batch.id, resolve));
    emitted.set(refused.batch.id, c0);
    settlement.receive({ partition: 0, offset: offset++ }, refused);
    assert.notEqual(await gotRefusal, 'committed');
    const again = usageBatch('rating-u:0:again:0', account, [fresh]);
    const gotPosted = new Promise<PostingAck | 'committed'>((resolve) => answered.set(again.batch.id, resolve));
    emitted.set(again.batch.id, systemClock());
    settlement.receive({ partition: 0, offset: offset++ }, again);
    assert.equal(await gotPosted, 'committed');
    const cycle = systemClock() - c0;
    console.log(`# MONEY-I3 measurement: ${latencies.length} usage batches × ${LINES} lines on one partition; emission → posted p50 ${p(0.5)} ms, ` +
      `p99 ${p(0.99)} ms, max ${latencies.at(-1)} ms; refused batch and its re-emission ${cycle} ms`);
    assert.ok(latencies.length >= total, 'every usage batch is posted');
    if (strict) {
      assert.ok(p(0.99) <= POST_BOUND_MS, `p99 ${p(0.99)} ms > ${POST_BOUND_MS} ms (X2-S13 at the hard close bound)`);
      assert.ok(cycle <= CYCLE_MS, `a refused usage batch cost ${cycle} ms > ${CYCLE_MS} ms (R4-B11)`);
    }
  } finally {
    scheduler.close();
    await rt?.stop();
    await store.close();
    await db.drop();
  }
});
