/**
 * S-LINK I1 on the real C01 runtime and the dev cell (exit criterion 8: criteria 1, 3, 5 and 6 again).
 * The tests skip with a message when CockroachDB is not reachable at DATABASE_URL (`npm run dev:up`), and
 * fail instead with REQUIRE_DEV_CELL=1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { CockroachOwnerRuntime, ManualLoad, MemoryPublisher, PgStore, slotOfPartition, utf8 } from '@share/owner-runtime';
import { migrateKinds } from '@share/owner-migrate';
import { createTestDatabase, devCellSkip } from '@share/owner-runtime/testing';
import { declaration, LinkOwner, runtimeLogReader, type DecidedRecord } from '../../src/index.ts';
import { propertyRun } from '../property.ts';
import { AccountStub, M, resultOf } from '../support.ts';

const URL = process.env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';

async function dbReachable(): Promise<string | undefined> {
  const c = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 1_500 });
  try { await c.connect(); await c.query('SELECT 1'); return undefined; } catch (e) { return (e as { code?: string }).code ?? String(e); } finally { await c.end().catch(() => {}); }
}

const dbError = await dbReachable();
const SKIP = devCellSkip(dbError === undefined ? undefined : `CockroachDB at ${URL}: ${dbError}`);

const FAST = { sessionTtlMs: 1_500, sessionRenewMs: 200, renewRetryMs: 100, holderViewMs: 1_400, maxLoopDelayMs: 100 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function start(url: string, link: string, decided: DecidedRecord[]) {
  const store = new PgStore({ connectionString: url });
  const slot = slotOfPartition(utf8(link), declaration.slotCount);
  const rt = new CockroachOwnerRuntime({ declaration, store, slots: [slot], publisher: new MemoryPublisher(), load: new ManualLoad(),
    testing: { sessionTimings: FAST } });
  const owner = new LinkOwner(rt, { readLog: runtimeLogReader(rt), links: [link], onDecided: (d) => decided.push(d) });
  await rt.start(owner);
  for (let i = 0; i < 80 && !rt.heldSlots().includes(slot); i++) await sleep(100);
  assert.ok(rt.heldSlots().includes(slot), `slot ${slot} acquired`);
  return { rt, owner, store, slot, close: async () => { await rt.stop(); await store.close(); } };
}

test('should hold, convert, release, pass the T-09 cases and the property run, and rebuild when run on the real runtime on the dev cell', { skip: SKIP, timeout: 180_000 }, async () => {
  const db = await createTestDatabase(URL, 'itest_link');
  try {
    await migrateKinds(db.url, [declaration], { presplit: false });
    await holdConvertReleaseRebuild(db.url);
  } finally {
    await db.drop();
  }
});

async function holdConvertReleaseRebuild(url: string): Promise<void> {
  const link = `itest-${randomBytes(4).toString('hex')}`;
  const decided: DecidedRecord[] = [];
  const a = await start(url, link, decided);
  let closed = false;
  try {
    const reg = await a.owner.register(link, 10);
    assert.equal(resultOf(reg), 'INITIALISED');
    const stub = new AccountStub(a.rt, a.owner, link);
    const W = { start: M(10), end: M(11) };

    // Exit criterion 1 again: one seed, 400 commands from 20 clients (real clock, so no clock moves).
    const res = await propertyRun({ stub, decided, capacity: 10, base: M(0), readLog: () => runtimeLogReader(a.rt)(utf8(link), 0n) }, 21, 400, 20);
    assert.ok((res.counts['HELD'] ?? 0) > 0);

    // Exit criterion 3 again (T-09).
    const t = stub.holdCmd({ rate: 1, window: W });
    await stub.release(stub.releaseCmd(t.request, t.deadline));
    assert.equal(resultOf(await stub.hold({ ...t, rateMbps: 2 })), 'REFUSED:"TOMBSTONED"');
    assert.equal(resultOf(await stub.convert(stub.convertCmd(stub.holdCmd({ rate: 1, window: W })))), 'NO_HOLD');
    const late = stub.holdCmd({ rate: 1, window: W, deadlineInMs: 300 });
    assert.equal(resultOf(await stub.hold(late)), 'REFUSED:"DEADLINE_PASSED"');

    // Exit criterion 5 again: a sender below the recorded fence is refused.
    stub.epoch = 5n;
    const kept = stub.holdCmd({ rate: 1, window: { start: M(30), end: M(31) } });
    assert.ok(['HELD', 'REFUSED:"NO_FIT"', 'REFUSED:"IN_FLIGHT"'].includes(resultOf(await stub.hold(kept))));
    stub.epoch = 4n;
    assert.equal(resultOf(await stub.hold(stub.holdCmd({ rate: 1, window: W }))), 'STALE_SENDER');
    stub.epoch = 5n;
    const keptReply = await stub.hold(kept);

    // Exit criterion 6 again: stop the owner process; a new holder rebuilds by replay and answers the repeat.
    await a.close();
    closed = true;
    const b = await start(url, link, []);
    try {
      assert.deepEqual(b.owner.alerts.filter((x) => x.kind === 'OUTCOME_MISMATCH_ON_REPLAY'), []);
      const stub2 = new AccountStub(b.rt, b.owner, link);
      stub2.epoch = 5n;
      const again = await stub2.hold(kept);
      assert.equal(resultOf(again), resultOf(keptReply));
      stub2.epoch = 4n;
      assert.equal(resultOf(await stub2.hold(stub2.holdCmd({ rate: 1, window: W }))), 'STALE_SENDER', 'fence rebuilt from the log');
    } finally {
      await b.close();
    }
  } finally {
    if (!closed) await a.close();
  }
}
