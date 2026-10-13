/**
 * S-LINK I2 on the real C01 runtime and the dev cell (exit criteria 1 to 3 again): counter-offers, `query`,
 * the availability query, the `link_request` row of each final record (with its row-level TTL), and a repeat
 * answered from that row after the memory record has gone and after a new holder rebuilds. The link has
 * release_grace = 1 s, so the memory record goes 1 s after D. The tests skip with a message when CockroachDB
 * is not reachable at DATABASE_URL (`npm run dev:up`), and fail instead with REQUIRE_DEV_CELL=1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { CockroachOwnerRuntime, hlcToWallMs, ManualLoad, MemoryPublisher, PgStore, slotOfPartition, utf8 } from '@share/owner-runtime';
import { migrateKinds } from '@share/owner-migrate';
import { createTestDatabase, devCellSkip } from '@share/owner-runtime/testing';
import { declaration, DEFAULT_POLICY, LinkOwner, runtimeLogReader } from '../../src/index.ts';
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
  const rt = new CockroachOwnerRuntime({ declaration, store, slots: [slot], publisher: new MemoryPublisher(), load: new ManualLoad(),
    testing: { sessionTimings: FAST } });
  const owner = new LinkOwner(rt, { readLog: runtimeLogReader(rt), links: [link] });
  const close = async () => { await rt.stop(); await store.close(); };
  try {
    await rt.start(owner);
    await waitFor(() => rt.heldSlots().includes(slot), 8_000, `slot ${slot} acquired`);
  } catch (e) {
    await close();
    throw e;
  }
  return { rt, owner, close };
}

test('should give counter-offers, answer query and availability, and answer a repeat from link_request when run on the real runtime on the dev cell', { skip: SKIP, timeout: 180_000 }, async () => {
  const db = await createTestDatabase(URL, 'itest_link_i2');
  try {
    await migrateKinds(db.url, [declaration], { presplit: false });
    await counterOffersAndRequestRows(db.url);
  } finally {
    await db.drop();
  }
});

async function counterOffersAndRequestRows(url: string): Promise<void> {
  const link = `itest-i2-${randomBytes(4).toString('hex')}`;
  const policy = { ...DEFAULT_POLICY, releaseGraceMs: 1_000 };
  const a = await start(url, link);
  let closed = false;
  try {
    assert.equal(resultOf(await a.owner.register(link, 10, policy)), 'INITIALISED');
    const stub = new AccountStub(a.rt, a.owner, link);
    const base = Math.floor(hlcToWallMs(a.rt.now().ts) / 60_000) + 60;
    const W = { start: base, end: base + 60 };
    const confirmed = await stub.book({ rate: 8, window: { start: base, end: base + 120 }, account: 'seller' });
    assert.equal(resultOf(confirmed.convert), 'CONVERTED');
    assert.equal(resultOf(await stub.hold(stub.holdCmd({ rate: 1, window: W, account: 'pending', deadlineInMs: 60_000 }))), 'HELD');

    const refused = stub.holdCmd({ rate: 5, window: W, deadlineInMs: 1_500 });
    const first = await stub.hold(refused);
    const offer = { largestRateMbps: 1, earliest: { window: { start: base + 120, end: base + 180 } } };
    assert.deepEqual((first as { counterOffer?: unknown }).counterOffer, offer);

    const q = await a.owner.query(stub.envelope('b1'), { link, receiverPartition: link, request: refused.request });
    assert.equal((q as { state?: string }).state, 'REFUSED');
    assert.deepEqual((q as { refusal?: { counterOffer?: unknown } }).refusal?.counterOffer, offer);
    const av = await a.owner.availability(stub.envelope('b1'), { link, receiverPartition: link, window: W, rateMbps: 5 });
    assert.deepEqual((av as { offer?: unknown }).offer, offer);
    const fr = await a.owner.fitRanges(stub.envelope('b1'), { link, receiverPartition: link, rateMbps: 5, from: base - 60, until: base + 180, k: 5 });
    assert.deepEqual((fr as { ranges?: unknown }).ranges, [{ start: base - 60, end: base }, { start: base + 120, end: base + 180 }]);

    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      const rows = (await c.query('SELECT seq::STRING AS seq FROM link_request WHERE link_id = $1 AND request_part = $2 AND request_seq = $3',
        [link, Buffer.from(refused.request.partition), refused.request.seq.toString()])).rows as Array<{ seq: string }>;
      assert.equal(rows.length, 1);
      assert.equal(BigInt(rows[0]?.seq ?? '0'), (first as { linkSeq: bigint }).linkSeq);
      const ddl = (await c.query('SHOW CREATE TABLE link_request')).rows as Array<{ create_statement: string }>;
      assert.match(ddl[0]?.create_statement ?? '', /ttl_expiration_expression/);
    } finally {
      await c.end();
    }

    const gone = refused.deadline + policy.releaseGraceMs;
    await waitFor(() => hlcToWallMs(a.rt.now().ts) >= gone, 10_000, 'D + release_grace');
    await stub.hold(stub.holdCmd({ rate: 1, window: { start: base + 600, end: base + 601 }, account: 'other' }));
    assert.equal(a.owner.stateOf(link)?.recordState(refused.request), undefined, 'the memory record is gone');
    const again = await stub.hold(refused);
    assert.deepEqual((again as { counterOffer?: unknown }).counterOffer, offer);
    assert.equal((again as { linkSeq: bigint }).linkSeq, (first as { linkSeq: bigint }).linkSeq);
    assert.equal(a.owner.recalledRecords, 1);

    await a.close();
    closed = true;
    const b = await start(url, link);
    try {
      assert.deepEqual(b.owner.alerts.filter((x) => x.kind === 'OUTCOME_MISMATCH_ON_REPLAY'), []);
      const afterTakeover = await new AccountStub(b.rt, b.owner, link).hold(refused);
      assert.equal(resultOf(afterTakeover), 'REFUSED:"NO_FIT"');
      assert.deepEqual((afterTakeover as { counterOffer?: unknown }).counterOffer, offer);
      assert.equal(b.owner.recalledRecords, 1, 'the new holder answers from link_request');
    } finally {
      await b.close();
    }
  } finally {
    if (!closed) await a.close();
  }
}
