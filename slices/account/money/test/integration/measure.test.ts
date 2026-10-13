/**
 * MONEY-I2 exit criterion 6 (X2-S13, X2-S14): at the SP4 rate on one ledger partition (est. 27 movements/s and
 * 8,000 lines/s, RFC-004 §B10), every reservation batch is acknowledged `posted` within 2 min of its emission
 * at p99, and no answer leaves before its movement is committed. The batches go through settlement to the real
 * ledger on the C01 runtime and the dev cell. It runs only with MONEY_MEASURE=1 (`npm run measure`), because a
 * wall-clock bound fails on a loaded machine. MONEY_MEASURE_STRICT=0 reports the numbers without the bound.
 * MONEY_MEASURE_SECONDS sets the run length (default 20 s); MONEY_MEASURE_RATE (movements/s, default 27) and
 * MONEY_MEASURE_LINES (lines a movement, default 300) set a lower load to characterise a slow dev cell; the
 * bound applies only at the SP4 rate. The dev cell has one region: "committed" here is
 * the runtime's `Committed`, which is two-region durable only on a two-region cluster.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { CockroachOwnerRuntime, ManualLoad, MemoryPublisher, PgStore, slotOfPartition, systemClock, utf8 } from '@share/owner-runtime';
import { migrateKinds } from '@share/owner-migrate';
import { createTestDatabase, devCellSkip } from '@share/owner-runtime/testing';
import {
  LEDGER_DEV_SLOT_COUNT, LedgerOwner, Settlement, TimerScheduler, ledgerDeclaration, ledgerPartitionOfBuyer,
  type ChargeLineBatch, type LedgerAnswer, type PostCall,
} from '../../src/index.ts';
import { reservationBatch, reservationLine, weightsFixture } from '../../testing/index.ts';

const URL = process.env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';
const enabled = process.env['MONEY_MEASURE'] === '1';
const strict = process.env['MONEY_MEASURE_STRICT'] !== '0';
const SECONDS = Number(process.env['MONEY_MEASURE_SECONDS'] ?? '20');
const SP4_MOVEMENTS_PER_S = 27;
const SP4_LINES_PER_MOVEMENT = 300;
const MOVEMENTS_PER_S = Number(process.env['MONEY_MEASURE_RATE'] ?? SP4_MOVEMENTS_PER_S);
const LINES_PER_MOVEMENT = Number(process.env['MONEY_MEASURE_LINES'] ?? SP4_LINES_PER_MOVEMENT);
const AT_SP4 = MOVEMENTS_PER_S >= SP4_MOVEMENTS_PER_S && LINES_PER_MOVEMENT >= SP4_LINES_PER_MOVEMENT;
const BOUND_MS = 120_000;

async function dbReachable(): Promise<string | undefined> {
  const c = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 1_500 });
  try { await c.connect(); await c.query('SELECT 1'); return undefined; } catch (e) { return (e as { code?: string }).code ?? String(e); } finally { await c.end().catch(() => {}); }
}

const SKIP = !enabled ? 'set MONEY_MEASURE=1 (npm run measure)' : devCellSkip((await dbReachable()) === undefined ? undefined : `CockroachDB at ${URL}`);
const FAST = { sessionTtlMs: 1_500, sessionRenewMs: 200, renewRetryMs: 100, holderViewMs: 1_400, maxLoopDelayMs: 100 };

/** Accounts whose home is one ledger partition, so that the whole load falls on it. */
function accountsOnOnePartition(n: number): string[] {
  const target = ledgerPartitionOfBuyer('m-0');
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) if (ledgerPartitionOfBuyer(`m-${i}`) === target) out.push(`m-${i}`);
  return out;
}

function minuteAt(m: number): string {
  return new Date(Date.UTC(2026, 9, 12, 9, 0) + m * 60_000).toISOString().replace('.000Z', 'Z');
}

test('measurement: at the SP4 rate on one ledger partition every reservation batch is acknowledged posted within 2 min at p99, and no answer leaves before its commit',
  { skip: SKIP, timeout: 600_000 }, async () => {
  const db = await createTestDatabase(URL, 'itest_money_measure');
  const pool = new pg.Pool({ connectionString: db.url, max: 4 });
  const store = new PgStore({ connectionString: db.url });
  const decl = ledgerDeclaration();
  const accounts = accountsOnOnePartition(8);
  const partition = ledgerPartitionOfBuyer(accounts[0]!);
  const slot = slotOfPartition(utf8(partition), LEDGER_DEV_SLOT_COUNT);
  const scheduler = new TimerScheduler();
  let rt: CockroachOwnerRuntime | undefined;
  try {
    await migrateKinds(db.url, [decl], { presplit: false });
    rt = new CockroachOwnerRuntime({ declaration: decl, store, slots: [slot], publisher: new MemoryPublisher(), load: new ManualLoad(),
      testing: { sessionTimings: FAST },
      ...(process.env['MONEY_MEASURE_LOG'] === '1' ? { log: (m: string, f?: Record<string, unknown>) => console.log(`# runtime: ${m} ${JSON.stringify(f ?? {}, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`) } : {}) });
    const ledger = new LedgerOwner(rt, { weights: weightsFixture() });
    await rt.start(ledger);
    const startWait = systemClock();
    while (!rt.heldSlots().includes(slot)) {
      if (systemClock() - startWait > 15_000) throw new Error('slot not acquired');
      await new Promise((r) => setTimeout(r, 50));
    }
    const emitted = new Map<string, number>();
    const latencies: number[] = [];
    let notCommitted = 0;
    let checked = 0;
    const port = {
      post: async (call: PostCall): Promise<LedgerAnswer> => {
        const a = await ledger.post(call);
        if (a.result === 'committed') {
          latencies.push(systemClock() - emitted.get(call.request.movementRef)!);
          if (latencies.length % 10 === 0) {
            checked += 1;
            const r = await pool.query('SELECT 1 FROM ledger_log WHERE partition = $1 AND seq = $2', [Buffer.from(partition), a.position.sequence]);
            if (r.rowCount !== 1) notCommitted += 1;
          }
        }
        return a;
      },
    };
    const settlement = new Settlement({ ledger: port, weights: weightsFixture(), scheduler, publishAcks: async () => {}, commitOffset: async () => {} });
    const total = SECONDS * MOVEMENTS_PER_S;
    const t0 = systemClock();
    for (let i = 0; i < total; i++) {
      const due = t0 + (i * 1_000) / MOVEMENTS_PER_S;
      const wait = due - systemClock();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const account = accounts[i % accounts.length]!;
      const minute = minuteAt(Math.floor(i / accounts.length));
      const lines = Array.from({ length: LINES_PER_MOVEMENT }, (_, k) => reservationLine(account, `${account}-r-${k}`, minute, 1_500n + BigInt(k)));
      const b: ChargeLineBatch = reservationBatch(`rating-m:0:${i}:0`, account, minute, lines);
      emitted.set(b.batch.id, systemClock());
      settlement.receive({ partition: 0, offset: BigInt(i) }, b);
    }
    await settlement.idle();
    const elapsedS = (systemClock() - t0) / 1_000;
    latencies.sort((x, y) => x - y);
    const p = (q: number): number => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!;
    console.log(`# MONEY-I2 measurement: ${latencies.length} batches × ${LINES_PER_MOVEMENT} lines on partition ${partition} in ${elapsedS.toFixed(1)} s ` +
      `(offered ${MOVEMENTS_PER_S} movements/s, ${MOVEMENTS_PER_S * LINES_PER_MOVEMENT} lines/s); emission → posted p50 ${p(0.5)} ms, p99 ${p(0.99)} ms, max ${latencies.at(-1)} ms; ` +
      `answers checked against the log ${checked}, not committed ${notCommitted}`);
    assert.equal(latencies.length, total, 'every batch is acknowledged posted');
    assert.equal(notCommitted, 0, 'no answer before the commit (X2-S14)');
    if (strict && AT_SP4) assert.ok(p(0.99) <= BOUND_MS, `p99 ${p(0.99)} ms > ${BOUND_MS} ms (X2-S13)`);
  } finally {
    scheduler.close();
    await rt?.stop();
    await store.close();
    await pool.end();
    await db.drop();
  }
});
