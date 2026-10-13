/**
 * S-LINK I3 on the real C01 runtime and the dev cell (exit criteria 1 to 3 again, plan §1 rule 5): waiters,
 * grants in priority order in the entry that frees the capacity, `Tick` continuations in the same batch, the
 * waiting-port notifications as outbox rows (one row for each notice, also for each WAITING_NOTICE copy), the
 * push with the same identity, `query` as the reconcile path, and a rebuild by a new holder with equal outcomes
 * and notices. The tests skip with a message when CockroachDB is not reachable at DATABASE_URL
 * (`npm run dev:up`), and fail instead with REQUIRE_DEV_CELL=1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import {
  CockroachOwnerRuntime, hlcToWallMs, ManualLoad, MemoryPublisher, PgStore, slotOfPartition, utf8, type HlcTs, type NotificationOut,
} from '@share/owner-runtime';
import { migrateKinds } from '@share/owner-migrate';
import { createTestDatabase, devCellSkip } from '@share/owner-runtime/testing';
import { declaration, DEFAULT_POLICY, LinkOwner, requestKey, runtimeLogReader, type LoggedPayload, type WaitingNotification } from '../../src/index.ts';
import { AccountStub, resultOf } from '../support.ts';

const URL = process.env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';

async function dbReachable(): Promise<string | undefined> {
  const c = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 1_500 });
  try { await c.connect(); await c.query('SELECT 1'); return undefined; } catch (e) { return (e as { code?: string }).code ?? String(e); } finally { await c.end().catch(() => {}); }
}

const dbError = await dbReachable();
const SKIP = devCellSkip(dbError === undefined ? undefined : `CockroachDB at ${URL}: ${dbError}`);

const FAST = { sessionTtlMs: 1_500, sessionRenewMs: 200, renewRetryMs: 100, holderViewMs: 1_400, maxLoopDelayMs: 100 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for a condition, with a time limit. */
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

async function start(url: string, link: string) {
  const store = new PgStore({ connectionString: url });
  const slot = slotOfPartition(utf8(link), declaration.slotCount);
  const publisher = new MemoryPublisher();
  const rt = new CockroachOwnerRuntime({ declaration, store, slots: [slot], publisher, load: new ManualLoad(),
    testing: { sessionTimings: FAST } });
  const pushed: NotificationOut[] = [];
  const owner = new LinkOwner(rt, { readLog: runtimeLogReader(rt), links: [link], onNotify: (n) => pushed.push(n) });
  const close = async () => { await rt.stop(); await store.close(); };
  try {
    await rt.start(owner);
    await waitFor(() => rt.heldSlots().includes(slot), 8_000, `slot ${slot} acquired`);
  } catch (e) {
    await close();
    throw e;
  }
  return { rt, owner, publisher, pushed, close };
}

test('should wait, grant in priority order with Tick continuations, and send each notice as an outbox row when run on the real runtime on the dev cell', { skip: SKIP, timeout: 180_000 }, async () => {
  const db = await createTestDatabase(URL, 'itest_link_i3');
  try {
    await migrateKinds(db.url, [declaration], { presplit: false });
    await waitersAndGrants(db.url);
  } finally {
    await db.drop();
  }
});

async function waitersAndGrants(url: string): Promise<void> {
  const link = `itest-i3-${randomBytes(4).toString('hex')}`;
  const policy = { ...DEFAULT_POLICY, scanSteps: 2 };
  const a = await start(url, link);
  let closed = false;
  try {
    assert.equal(resultOf(await a.owner.register(link, 10, policy)), 'INITIALISED');
    const stub = new AccountStub(a.rt, a.owner, link);
    const base = Math.floor(hlcToWallMs(a.rt.now().ts) / 60_000) + 60;
    const W = { start: base, end: base + 60 };
    const blocker = stub.holdCmd({ rate: 10, window: W, account: 'blk', deadlineInMs: 60_000 });
    assert.equal(resultOf(await stub.hold(blocker)), 'HELD');
    const t0 = hlcToWallMs(a.rt.now().ts);
    const waiters = [0, 1, 2, 3, 4].map((i) => ({
      ...stub.holdCmd({ rate: 1, window: W, wait: true, account: `w${i}`, deadlineInMs: 60_000 }),
      requestAge: `${BigInt(t0 - 10 + i) * 1_000_000n}.0000000000` as HlcTs,
    }));
    for (const w of [...waiters].reverse()) assert.equal(resultOf(await stub.hold(w)), 'WAITING');

    const later = stub.holdCmd({ rate: 5, window: W, account: 'later', deadlineInMs: 60_000 });
    const [rel, held] = await Promise.all([stub.release(stub.releaseCmd(blocker.request, blocker.deadline)), stub.hold(later)]);
    assert.equal(resultOf(rel), 'RELEASED');
    assert.equal(resultOf(held), 'HELD');
    const relSeq = (rel as { linkSeq: bigint }).linkSeq;
    assert.equal((held as { linkSeq: bigint }).linkSeq, relSeq + 3n, 'two Tick entries come before the later hold');

    const log = await runtimeLogReader(a.rt)(utf8(link), 0n);
    assert.deepEqual(log.filter((e) => e.seq > relSeq && e.seq < relSeq + 3n).map((e) => (e.payload as LoggedPayload).op), ['tick', 'tick']);

    const grants = a.pushed.map((n) => n.body as WaitingNotification);
    assert.deepEqual(grants.map((n) => [requestKey(n.request), n.kind]), waiters.map((w) => [requestKey(w.request), 'GRANTED']));
    const rows = a.publisher.sent.filter((m) => m.topic === 'link.notifications.v1');
    assert.equal(rows.length, waiters.length, 'one outbox row for each notice');

    for (const w of waiters) {
      const q = await a.owner.query(stub.envelope(w.account), { link, receiverPartition: link, request: w.request });
      assert.equal((q as { state?: string }).state, 'HELD');
      assert.equal((q as { attempt?: number }).attempt, 1);
    }

    await a.close();
    closed = true;
    const b = await start(url, link);
    try {
      assert.deepEqual(b.owner.alerts.filter((x) => x.kind === 'OUTCOME_MISMATCH_ON_REPLAY'), [], 'the replay gives the same outcomes and notices');
      assert.deepEqual(b.owner.stateOf(link)?.holdsInOrder().map((h) => requestKey(h.request)),
        [...waiters, later].map((w) => requestKey(w.request)));
    } finally {
      await b.close();
    }
  } finally {
    if (!closed) await a.close();
  }
}
