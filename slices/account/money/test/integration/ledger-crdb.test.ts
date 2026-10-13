/**
 * MONEY-I2 on the real C01 runtime and the dev cell: the grants job on `ledger_log` (P4-S29), the CT-R fixtures
 * through settlement to the golden ledger in CockroachDB (CT-C1, P4-S28), a repeat after an owner restart, and
 * the answer only after the commit. The tests skip with a message when CockroachDB is not reachable at
 * DATABASE_URL (`npm run dev:up`), and fail instead with REQUIRE_DEV_CELL=1. Each run has its own database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { CockroachOwnerRuntime, ManualLoad, MemoryPublisher, PgStore, slotOfPartition, utf8 } from '@share/owner-runtime';
import { checkGrants, migrateKinds } from '@share/owner-migrate';
import { createTestDatabase, devCellSkip } from '@share/owner-runtime/testing';
import {
  LEDGER_DEV_SLOT_COUNT, LedgerOwner, Settlement, TimerScheduler, ledgerDeclaration, ledgerPartitionOfBuyer,
  type LedgerAnswer, type PostCall, type PostingAck,
} from '../../src/index.ts';
import { ctrReservationBatches, weightsFixture } from '../../testing/index.ts';

const URL = process.env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';

async function dbReachable(): Promise<string | undefined> {
  const c = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 1_500 });
  try { await c.connect(); await c.query('SELECT 1'); return undefined; } catch (e) { return (e as { code?: string }).code ?? String(e); } finally { await c.end().catch(() => {}); }
}

const dbError = await dbReachable();
const SKIP = devCellSkip(dbError === undefined ? undefined : `CockroachDB at ${URL}: ${dbError}`);
const FAST = { sessionTtlMs: 1_500, sessionRenewMs: 200, renewRetryMs: 100, holderViewMs: 1_400, maxLoopDelayMs: 100 };
const DECL = ledgerDeclaration();
const ACCOUNTS = ['b1', 'b2'];
const SLOTS = [...new Set(ACCOUNTS.map((a) => slotOfPartition(utf8(ledgerPartitionOfBuyer(a)), LEDGER_DEV_SLOT_COUNT)))];

/** Wait for a condition, with a bound (engineering.md §5: never a fixed sleep as the wait). */
async function until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function startLedger(url: string) {
  const store = new PgStore({ connectionString: url });
  const rt = new CockroachOwnerRuntime({ declaration: DECL, store, slots: SLOTS, publisher: new MemoryPublisher(), load: new ManualLoad(),
    testing: { sessionTimings: FAST } });
  const ledger = new LedgerOwner(rt, { weights: weightsFixture() });
  await rt.start(ledger);
  await until('ledger slots acquired', () => SLOTS.every((s) => rt.heldSlots().includes(s)));
  return { rt, ledger, close: async () => { await rt.stop(); await store.close(); } };
}

async function balances(pool: pg.Pool): Promise<Record<string, string>> {
  const r = await pool.query<{ ledger_account: string; balance: string }>(
    'SELECT ledger_account, sum(balance)::STRING AS balance FROM ledger_balance GROUP BY ledger_account HAVING sum(balance) <> 0 ORDER BY ledger_account');
  return Object.fromEntries(r.rows.map((x) => [x.ledger_account, x.balance]));
}

test('P4-S29 on the dev cell: the C01 grants job finds no UPDATE or DELETE grant on ledger_log for any role, and the ledger role cannot alter a movement', { skip: SKIP, timeout: 120_000 }, async () => {
  const db = await createTestDatabase(URL, 'itest_money_grants');
  const pool = new pg.Pool({ connectionString: db.url, max: 2 });
  try {
    await migrateKinds(db.url, [DECL], { presplit: false, grants: true });
    const report = await checkGrants(pool, [DECL]);
    assert.deepEqual(report.violations, []);
    const grants = await pool.query<{ grantee: string; privilege_type: string }>(
      "SELECT grantee, privilege_type FROM information_schema.table_privileges WHERE table_schema = 'public' AND table_name = 'ledger_log'");
    assert.ok(grants.rows.length > 0, 'the log table has grants');
    assert.deepEqual(grants.rows.filter((g) => ['UPDATE', 'DELETE'].includes(g.privilege_type.toUpperCase()) && g.grantee !== 'admin' && g.grantee !== 'root'), []);
    const c = await pool.connect();
    try {
      await c.query('SET ROLE ledger');
      await assert.rejects(c.query('UPDATE ledger_log SET payload = payload WHERE false'), (e: { code?: string }) => e.code === '42501');
      await assert.rejects(c.query('DELETE FROM ledger_log WHERE false'), (e: { code?: string }) => e.code === '42501');
    } finally {
      await c.query('RESET ROLE').catch(() => {});
      c.release();
    }
  } finally {
    await pool.end();
    await db.drop();
  }
});

test('C06 CT-C1 on the dev cell: the CT-R reservation fixtures through settlement give the golden ledger, which sums to zero (P4-S28); a repeat after an owner restart moves nothing', { skip: SKIP, timeout: 120_000 }, async () => {
  const db = await createTestDatabase(URL, 'itest_money_ledger');
  const pool = new pg.Pool({ connectionString: db.url, max: 2 });
  const scheduler = new TimerScheduler();
  let a: Awaited<ReturnType<typeof startLedger>> | undefined;
  try {
    await migrateKinds(db.url, [DECL], { presplit: false });
    a = await startLedger(db.url);
    const { batches, golden } = ctrReservationBatches();
    const answers: Array<{ answer: LedgerAnswer; rowsAtAnswer: number }> = [];
    const port = {
      post: async (call: PostCall): Promise<LedgerAnswer> => {
        const answer = await a!.ledger.post(call);
        // X2-S14: the movement row is committed when the answer leaves the ledger.
        const rows = answer.result === 'committed'
          ? (await pool.query('SELECT 1 FROM ledger_log WHERE partition = $1 AND seq = $2', [Buffer.from(call.partition), answer.position.sequence])).rowCount ?? 0
          : -1;
        answers.push({ answer, rowsAtAnswer: rows });
        return answer;
      },
    };
    const direct: PostingAck[] = [];
    const commits: bigint[] = [];
    const settlement = new Settlement({ ledger: port, weights: weightsFixture(), scheduler, publishAcks: async (x) => { direct.push(x); },
      commitOffset: async (_p, next) => { commits.push(next); } });
    batches.forEach((b, i) => settlement.receive({ partition: 0, offset: BigInt(i) }, b));
    await settlement.idle();
    assert.deepEqual(answers.map((x) => [x.answer.result, x.rowsAtAnswer]), batches.map(() => ['committed', 1]));
    assert.equal(direct.length, 0, "settlement excluded no line");
    assert.equal(commits.at(-1), 4n);
    const g = await balances(pool);
    assert.deepEqual(g, Object.fromEntries(Object.entries(golden).sort(([x], [y]) => (x < y ? -1 : 1))));
    assert.equal(Object.values(g).reduce((s, v) => s + BigInt(v), 0n), 0n);
    const logRows = Number((await pool.query<{ n: string }>('SELECT count(*)::STRING AS n FROM ledger_log')).rows[0]?.n);
    assert.equal(logRows, 4, 'one log entry for each movement');

    // The owner process stops; a new one serves the partitions from the database and answers the repeats.
    await a.close();
    a = await startLedger(db.url);
    const idOf = (x: LedgerAnswer): string => (x.result === 'committed' ? x.movementId : x.result);
    const byId = (xs: LedgerAnswer[]): LedgerAnswer[] => [...xs].sort((x, y) => (idOf(x) < idOf(y) ? -1 : 1));
    const first = byId(answers.slice(0, batches.length).map((x) => x.answer));
    const again = new Settlement({ ledger: port, weights: weightsFixture(), scheduler, publishAcks: async (x) => { direct.push(x); },
      commitOffset: async () => {} });
    batches.forEach((b, i) => again.receive({ partition: 0, offset: BigInt(i) }, structuredClone(b)));
    await again.idle();
    assert.deepEqual(byId(answers.slice(batches.length).map((x) => x.answer)), first, 'the recorded answers');
    assert.deepEqual(await balances(pool), g);
    assert.equal(Number((await pool.query<{ n: string }>('SELECT count(*)::STRING AS n FROM ledger_log')).rows[0]?.n), 4);
  } finally {
    scheduler.close();
    await a?.close();
    await pool.end();
    await db.drop();
  }
});
