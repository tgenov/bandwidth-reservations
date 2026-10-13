/**
 * S-LINK I6 on the real C01 runtime and the dev cell: `EndLeg` and `ReduceParts` entries in the real (sealed) link
 * log with their change ids (bigint and bytes in the payload), the convert clip, the recorded reply of an applied
 * change id and `STALE_CHANGE` after a rebuild by replay in a new owner process, with no outcome difference. The test
 * skips with a message when CockroachDB is not reachable at DATABASE_URL (`npm run dev:up`), and fails instead with
 * REQUIRE_DEV_CELL=1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { CockroachOwnerRuntime, hlcToWallMs, ManualLoad, MemoryPublisher, PgStore, slotOfPartition, utf8 } from '@share/owner-runtime';
import { migrateKinds } from '@share/owner-migrate';
import { createTestDatabase, devCellSkip } from '@share/owner-runtime/testing';
import type { ConvertCmd, EndLegCmd, HoldCmd, ReducePartsCmd } from '../../src/index.ts';
import { declaration, ENTRY, LinkOwner, runtimeLogReader } from '../../src/index.ts';
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

test('should write EndLeg and ReduceParts entries, clip a late convert, and rebuild the recorded change replies when run on the real runtime on the dev cell', { skip: SKIP, timeout: 180_000 }, async () => {
  const db = await createTestDatabase(URL, 'itest_link_i6');
  try {
    await migrateKinds(db.url, [declaration], { presplit: false });
    await legChanges(db.url);
  } finally {
    await db.drop();
  }
});

async function legChanges(url: string): Promise<void> {
  const link = `itest-i6-${randomBytes(4).toString('hex')}`;
  const account = utf8('acct-i6');
  const a = await start(url, link);
  let closed = false;
  try {
    assert.equal(resultOf(await a.owner.register(link, 10)), 'INITIALISED');
    const stub = new AccountStub(a.rt, a.owner, link);
    const readLog = () => runtimeLogReader(a.rt)(utf8(link), 0n);
    const m0 = Math.floor(hlcToWallMs(a.rt.now().ts) / 60_000);
    const changeId = (seq: bigint) => ({ partition: account, seq });
    const part = (hold: HoldCmd, name: string, createdBy: bigint): ConvertCmd => ({ ...stub.convertCmd(hold, 1, name), reservation: 'R', createdBy: changeId(createdBy) });
    const base = { link, receiverPartition: link, reservation: 'R', leg: 'leg-1' };
    // Each command carries the receipt minute m0, so that a minute boundary during the test changes nothing.
    const at = (c: HoldCmd): HoldCmd => ({ ...c, receiptMinute: m0 });

    // R: p1 4 Mbps on [m0 + 60, m0 + 180).
    const p1 = at(stub.holdCmd({ rate: 4, window: { start: m0 + 60, end: m0 + 180 }, account: 'acct-i6', deadlineInMs: 60_000 }));
    assert.equal(resultOf(await stub.hold(p1)), 'HELD');
    assert.equal(resultOf(await stub.convert(part(p1, 'p1', 50n))), 'CONVERTED');
    // An extension p2 3 Mbps on [m0 + 120, m0 + 240), held; its convert comes after a later end_leg (the clip).
    const p2 = { ...at(stub.holdCmd({ rate: 3, window: { start: m0 + 120, end: m0 + 240 }, account: 'acct-i6', deadlineInMs: 60_000 })),
      holdKind: { kind: 'change' as const, reservation: 'R' } };
    assert.equal(resultOf(await stub.hold(p2)), 'HELD');

    const reduce: ReducePartsCmd = { ...base, changeId: changeId(100n), cause: 'DECREASE', parts: [{ part: 'p1', pieces: [{ from: m0 + 90, rateMbps: 2 }] }], decisionTime: a.rt.now().ts };
    const end: EndLegCmd = { ...base, changeId: changeId(110n), fromMinute: m0 + 150, cause: 'SHORTEN', decisionTime: a.rt.now().ts };
    const r1 = await stub.reduceParts(reduce);
    const r2 = await stub.endLeg(end);
    assert.equal(resultOf(r1), 'CHANGED');
    assert.equal(resultOf(r2), 'CHANGED');
    const conv = part(p2, 'p2', 105n);
    const clipped = await stub.convert(conv);
    assert.deepEqual([resultOf(clipped), (clipped as { clippedAt?: number }).clippedAt], ['CONVERTED', m0 + 150]);
    assert.ok(a.owner.alerts.some((x) => x.kind === 'CONVERT_AFTER_END'));

    const log = await readLog();
    const kinds = log.map((e) => e.kind);
    assert.ok(kinds.includes(ENTRY.ReduceParts) && kinds.includes(ENTRY.EndLeg), `entries ${kinds.join(',')}`);
    const endEntry = log.find((e) => e.kind === ENTRY.EndLeg);
    assert.deepEqual((endEntry?.payload as { body: EndLegCmd }).body.changeId, end.changeId, 'the change id round-trips through the sealed payload');

    const occ = (o: LinkOwner) => [m0 + 89, m0 + 90, m0 + 120, m0 + 149, m0 + 150].map((t) => o.stateOf(link)?.occAll.value(t));
    const before = occ(a.owner);
    assert.deepEqual(before, [4, 2, 5, 5, 0]);

    // Stop the owner process; a new holder rebuilds by replay and answers the repeats from the recorded replies.
    await a.close();
    closed = true;
    const b = await start(url, link);
    try {
      assert.deepEqual(b.owner.alerts.filter((x) => x.kind === 'OUTCOME_MISMATCH_ON_REPLAY'), []);
      const stub2 = new AccountStub(b.rt, b.owner, link);
      assert.equal(resultOf(await stub2.endLeg(end)), 'CHANGED');
      assert.equal(resultOf(await stub2.reduceParts(reduce)), 'CHANGED');
      assert.equal(resultOf(await stub2.endLeg({ ...end, changeId: changeId(109n) })), 'STALE_CHANGE');
      const again = await stub2.convert(conv);
      assert.deepEqual([resultOf(again), (again as { clippedAt?: number }).clippedAt], ['CONVERTED', m0 + 150]);
      assert.deepEqual(occ(b.owner), before);
    } finally {
      await b.close();
    }
  } finally {
    if (!closed) await a.close();
  }
}
