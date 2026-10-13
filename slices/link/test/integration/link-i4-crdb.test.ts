/**
 * S-LINK I4 on the real C01 runtime and the dev cell: the `Policy(version, parameters)` entry in the real
 * (sealed) link log, `UNAVAILABLE` with no log row for an unapplied policy version, V1 … V6 against the
 * receipt minute, an open-ended reservation at the horizon, and a rebuild by replay of the Policy entries
 * with no outcome difference. The test skips with a message when CockroachDB is not reachable at
 * DATABASE_URL (`npm run dev:up`), and fails instead with REQUIRE_DEV_CELL=1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { CockroachOwnerRuntime, hlcToWallMs, ManualLoad, MemoryPublisher, PgStore, slotOfPartition, utf8 } from '@share/owner-runtime';
import { migrateKinds } from '@share/owner-migrate';
import { createTestDatabase, devCellSkip } from '@share/owner-runtime/testing';
import { declaration, DEFAULT_POLICY, ENTRY, horizonMinute, LinkOwner, runtimeLogReader } from '../../src/index.ts';
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

test('should write Policy entries, judge holds by their policy version and receipt minute, and rebuild them when run on the real runtime on the dev cell', { skip: SKIP, timeout: 180_000 }, async () => {
  const db = await createTestDatabase(URL, 'itest_link_i4');
  try {
    await migrateKinds(db.url, [declaration], { presplit: false });
    await policyAndValidity(db.url);
  } finally {
    await db.drop();
  }
});

async function policyAndValidity(url: string): Promise<void> {
  const link = `itest-i4-${randomBytes(4).toString('hex')}`;
  const v2 = { ...DEFAULT_POLICY, version: '2', rateMinMbps: 2, sellingHorizonMonths: 6 };
  const a = await start(url, link);
  let closed = false;
  try {
    assert.equal(resultOf(await a.owner.register(link, 10)), 'INITIALISED');
    const stub = new AccountStub(a.rt, a.owner, link);
    const readLog = () => runtimeLogReader(a.rt)(utf8(link), 0n);

    // An unapplied version: UNAVAILABLE, and no log row.
    const early = stub.holdCmd({ rate: 2, window: { start: Math.floor(hlcToWallMs(a.rt.now().ts) / 60_000) + 60, end: null }, policyVersion: 2n, deadlineInMs: 60_000 });
    const rowsBefore = (await readLog()).length;
    assert.deepEqual(await stub.hold(early), { code: 'UNAVAILABLE' });
    assert.equal((await readLog()).length, rowsBefore, 'no log row');

    // The Policy entry in the real log; the hold sent again is judged by version 2.
    assert.equal(resultOf(await a.owner.deployPolicy(link, v2)), 'POLICY_APPLIED');
    const log = await readLog();
    assert.equal(log.at(-1)?.kind, ENTRY.Policy);
    assert.deepEqual((log.at(-1)?.payload as { policy: unknown }).policy, v2);
    assert.equal(resultOf(await stub.hold(early)), 'HELD');

    const m0 = Math.floor(hlcToWallMs(a.rt.now().ts) / 60_000);
    const h12 = horizonMinute(m0, 12);
    const h6 = horizonMinute(m0, 6);
    // Each command carries the receipt minute m0, so that a minute boundary during the test changes nothing.
    const at = (c: ReturnType<typeof stub.holdCmd>) => ({ ...c, receiptMinute: m0 });
    const replies: Array<[ReturnType<typeof stub.holdCmd>, string]> = [];
    for (const [cmd, want] of [
      [at(stub.holdCmd({ rate: 1, window: { start: m0 + 60, end: m0 + 120 }, policyVersion: 2n })), 'REFUSED:{"invalid":"V1"}'],
      [at(stub.holdCmd({ rate: 2, window: { start: m0 + 60, end: h6 + 1 }, policyVersion: 2n })), 'REFUSED:{"invalid":"V6"}'],
      [at(stub.holdCmd({ rate: 1, window: { start: m0 - 1, end: m0 + 60 }, policyVersion: 1n })), 'REFUSED:{"invalid":"V4"}'],
      [at(stub.holdCmd({ rate: 1, window: { start: h12, end: null }, policyVersion: 1n })), 'REFUSED:{"invalid":"V5"}'],
      // The open-ended reservation of 2 Mbps (early) and 4 Mbps here take their rates up to the horizon.
      [at(stub.holdCmd({ rate: 4, window: { start: h12 - 1, end: null }, policyVersion: 1n })), 'HELD'],
      [at(stub.holdCmd({ rate: 5, window: { start: h12 - 30, end: h12 }, policyVersion: 1n })), 'REFUSED:"IN_FLIGHT"'],
    ] as Array<[ReturnType<typeof stub.holdCmd>, string]>) {
      const r = resultOf(await stub.hold(cmd));
      assert.equal(r, want, `[${cmd.window.start}, ${cmd.window.end}) v${cmd.policyVersion}`);
      replies.push([cmd, r]);
    }

    // Stop the owner process; a new holder rebuilds by replay, with the Policy entries, and answers the repeats.
    await a.close();
    closed = true;
    const b = await start(url, link);
    try {
      assert.deepEqual(b.owner.alerts.filter((x) => x.kind === 'OUTCOME_MISMATCH_ON_REPLAY'), []);
      const stub2 = new AccountStub(b.rt, b.owner, link);
      for (const [cmd, r] of replies) assert.equal(resultOf(await stub2.hold(cmd)), r);
      assert.equal(b.owner.stateOf(link)?.policy.version, '2');
      const fresh = stub2.holdCmd({ rate: 1, window: { start: m0 + 600, end: m0 + 660 }, policyVersion: 2n });
      assert.equal(resultOf(await stub2.hold(fresh)), 'REFUSED:{"invalid":"V1"}', 'version 2 after the rebuild');
    } finally {
      await b.close();
    }
  } finally {
    if (!closed) await a.close();
  }
}
