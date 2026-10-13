/**
 * PgSlotMapStore on the dev cell (C01 §2.3 placement tables; S-PLAT-I3 work item 6). One database for the run. The
 * test skips when the dev cell is not reachable, and fails instead with REQUIRE_DEV_CELL=1.
 */
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { SlotMapVersion } from '../../src/api.ts';
import { utf8 } from '../../src/bytes.ts';
import { hlc } from '../../src/hlc.ts';
import { PgSlotMapStore } from '../../src/placement/pg-slot-map-store.ts';
import { SlotMapError, type DoublingState } from '../../src/placement/slot-map-service.ts';
import { migrateKinds } from '@share/owner-migrate';
import { createTestDatabase, devCellSkip } from '../../testing/index.ts';
import { Closers } from '../support.ts';

const URL = process.env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';

async function dbReachable(): Promise<string | undefined> {
  const c = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 1_500 });
  try { await c.connect(); await c.query('SELECT 1'); return undefined; } catch (e) { return (e as { code?: string }).code ?? String(e); } finally { await c.end().catch(() => {}); }
}
const dbError = await dbReachable();
const SKIP = devCellSkip(dbError === undefined ? undefined : `CockroachDB at ${URL}: ${dbError}`);

let db: { name: string; url: string; drop: () => Promise<void> } | undefined;
const closers = new Closers();
afterEach(async () => { await closers.closeAll(); });
before(async () => {
  if (SKIP) return;
  db = await createTestDatabase(URL, 'islotmap');
  await migrateKinds(db.url, [], { presplit: false });
}, { timeout: 120_000 });
after(async () => { await db?.drop(); }, { timeout: 60_000 });

function store(): PgSlotMapStore {
  if (!db) throw new Error('no test database');
  const pool = new pg.Pool({ connectionString: db.url, max: 2 });
  closers.add(() => pool.end());
  return new PgSlotMapStore({ pool });
}

test('should record a map version, its override rows and a split ack in the placement tables and read them back', { skip: SKIP, timeout: 60_000 }, async () => {
  const s = store();
  await s.ensure();
  await s.ensure();
  const p0 = utf8('probe-0');
  const a = utf8('account-a');
  const v1: SlotMapVersion = {
    version: 1n, slotCount: 2, splitState: {}, overrides: [], probeAccounts: [{ slot: 0, account: p0 }, { slot: 1, account: utf8('probe-1') }],
    publishedAt: hlc('1800000000000000000.0000000001'),
  };
  const v2: SlotMapVersion = {
    version: 2n, slotCount: 4, previousCount: 2, splitState: { 0: 'splitting', 1: 'unsplit' },
    overrides: [{ account: a, slot: 1, reason: 'reslot' as const }, { account: p0, slot: 0, reason: 'probe_pin' as const }]
      .sort((x, y) => Buffer.compare(Buffer.from(x.account), Buffer.from(y.account))),
    probeAccounts: [], publishedAt: hlc('1800000000000000001.0000000000'),
  };
  const v3: SlotMapVersion = { ...v2, version: 3n, splitState: { 0: 'split', 1: 'unsplit' }, publishedAt: hlc('1800000000000000002.0000000000') };
  await s.insertVersion(v1);
  await s.insertVersion(v2);
  await s.insertVersion(v3);
  await s.insertVersion({ ...v2 });
  await assert.rejects(s.insertVersion({ ...v2, slotCount: 8 }), (e: unknown) => e instanceof SlotMapError && e.code === 'VERSION_CONFLICT');
  assert.deepEqual(await s.versions(), [v1, v2, v3]);

  await s.putProbeAccount({ slot: 0, account: p0, designatedIn: 1n, limitState: 'pending' });
  await s.putProbeAccount({ slot: 0, account: p0, designatedIn: 1n, limitState: 'applied' });
  assert.deepEqual(await s.probeAccounts(), [{ slot: 0, account: p0, designatedIn: 1n, limitState: 'applied' }]);

  assert.equal(await s.splitAck(0, 2n), undefined);
  await s.putSplitAck({ slot: 0, mapVersion: 2n, epoch: 1n, ackedAt: hlc('1800000000000000003.0000000000'), upperHalf: [a] });
  await s.putSplitAck({ slot: 0, mapVersion: 2n, epoch: 2n, ackedAt: hlc('1800000000000000004.0000000000'), upperHalf: [a, utf8('account-b')] });
  assert.deepEqual(await s.splitAck(0, 2n),
    { slot: 0, mapVersion: 2n, epoch: 2n, ackedAt: hlc('1800000000000000004.0000000000'), upperHalf: [a, utf8('account-b')] });

  const req = { requestId: utf8('r1'), op: 'reslot' as const, digest: new Uint8Array(32).fill(1), answer: utf8('{"accepted":true}') };
  await s.putRequest(req);
  await s.putRequest({ ...req, answer: utf8('other') });
  assert.deepEqual(await s.request(utf8('r1')), req);
  assert.equal(await s.request(utf8('r2')), undefined);

  assert.equal(await s.doubling(), undefined);
  const st: DoublingState = {
    requestId: 'aa', fromCount: 2, toCount: 4, phase: 'split', overrideVersion: 2n, limitVersion: 3n, newProbes: [], f9Done: [],
    slots: [{ slot: 0, state: 'splitting', splittingVersion: 2n, moved: ['aa'], needsListing: false }],
  };
  await s.putDoubling(st);
  assert.deepEqual(await s.doubling(), st);
});
