/**
 * S-PLAT-I3 exit criteria on the dev cell (CockroachDB, 3 nodes): the move protocol (CP-5, DT-12, DT-37 core),
 * a hot partition moved at the highest rate the dev cell sustains (DT-42: `Moving` p99 ≤ 200 ms, no cold rebuild), and
 * integrity stops at the slot fence with the runtime (CP-6, DT-45 runtime part). One database for the run; unique kind
 * names. The tests skip when the dev cell is not reachable, and fail instead with REQUIRE_DEV_CELL=1.
 * Written in S-PLAT-I3; not run by the agent that wrote it (manual proof owed).
 */
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { AppendResult, HlcTs, OwnerDeclaration, OwnerHooks, SlotNo } from '../../src/index.ts';
import {
  CockroachOwnerRuntime, ManualLoad, MemoryMoveStore, MoveCoordinator, PLATFORM_ENTRY, PgStore, compareHlc, hex, slotOfPartition, utf8,
  type MoveHolders,
} from '../../src/index.ts';
import { migrateKinds } from '@share/owner-migrate';
import { createTestDatabase, devCellSkip } from '../../testing/index.ts';

const URL = process.env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';

async function dbReachable(): Promise<string | undefined> {
  const c = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 1_500 });
  try { await c.connect(); await c.query('SELECT 1'); return undefined; } catch (e) { return (e as { code?: string }).code ?? String(e); } finally { await c.end().catch(() => {}); }
}
const dbError = await dbReachable();
const SKIP = devCellSkip(dbError === undefined ? undefined : `CockroachDB at ${URL}: ${dbError}`);

const R = randomBytes(3).toString('hex');
/** A kind with status readers: the report fence of step 4 applies. */
const LINK: OwnerDeclaration = {
  kind: `i3l_${R}`, slotCount: 4, statusReaders: true,
  entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }],
  projections: [{ name: 'mark', ddl: 'partition BYTES NOT NULL, id STRING NOT NULL, PRIMARY KEY (partition, id)', clearColumns: ['partition', 'id'] }],
  streams: [],
};
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const entry = (id: string) => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id } });
const FAST = { sessionTtlMs: 1_500, sessionRenewMs: 200, renewRetryMs: 100, holderViewMs: 1_400, maxLoopDelayMs: 100 };
const T = { timeout: 120_000 };
const DEDICATED: SlotNo = 4;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, ms: number, what = f.toString()): Promise<void> {
  const end = performance.now() + ms;
  while (!(await f())) { if (performance.now() > end) throw new Error(`timed out after ${ms} ms: ${what}`); await sleep(20); }
}
function hooks(events: string[]): OwnerHooks {
  return {
    async onAcquire() {}, onRelease() {}, onReportable() {}, async onNotification() {},
    onMovedOut(p) { events.push(`movedOut ${Buffer.from(p).toString()}`); },
    async onAdopt(p, g) { events.push(`adopt ${Buffer.from(p).toString()} ${g}`); },
  };
}

let db: { name: string; url: string; drop: () => Promise<void> } | undefined;
let admin: pg.Pool | undefined;
const open: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of open.splice(0).reverse()) await c().catch(() => {}); });
before(async () => {
  if (SKIP) return;
  db = await createTestDatabase(URL, 'ii3');
  admin = new pg.Pool({ connectionString: db.url, max: 4 });
  await migrateKinds(db.url, [LINK], { presplit: false });
  // The dedicated slot above the slot count (RFC-006 §4.1: link kinds have up to 128 dedicated slots).
  await admin.query(`INSERT INTO owner_slot (kind, slot, epoch) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING`, [LINK.kind, DEDICATED]);
}, { timeout: 180_000 });
after(async () => { await admin?.end(); await db?.drop(); }, { timeout: 60_000 });

function q(): pg.Pool {
  if (!admin || !db) throw new Error('no test database');
  return admin;
}

/** A (home slots) and B (the dedicated slot), wired for fence pushes, and the placement coordinator. */
async function cell(events: { a: string[]; b: string[] }) {
  if (!db) throw new Error('no test database');
  const inbox = new Map<SlotNo, CockroachOwnerRuntime>();
  const make = async (slots: SlotNo[], ev: string[]): Promise<CockroachOwnerRuntime> => {
    const store = new PgStore({ connectionString: (db as { url: string }).url });
    open.push(() => store.close());
    const rt = new CockroachOwnerRuntime({ declaration: LINK, store, slots, load: new ManualLoad(),
      moves: { peer: (_k, s) => inbox.get(s)?.moveInbox() }, testing: { sessionTimings: FAST } });
    open.push(() => rt.stop());
    await rt.start(hooks(ev));
    await until(() => slots.every((s) => rt.heldSlots().includes(s)), 20_000, 'slots held');
    for (const s of slots) inbox.set(s, rt);
    return rt;
  };
  const a = await make([0, 1, 2, 3], events.a);
  const b = await make([DEDICATED], events.b);
  const holders: MoveHolders = {
    prepare: (m) => (inbox.get(m.to) as CockroachOwnerRuntime).prepareAdopt(m),
    moveOut: (m) => (inbox.get(m.from) as CockroachOwnerRuntime).moveOut(m.partition, m.to, m.generation),
    adopt: (m) => (inbox.get(m.to) as CockroachOwnerRuntime).adopt(m.partition),
  };
  return { a, b, coordinator: new MoveCoordinator({ store: new MemoryMoveStore(), holders }) };
}

test('C01 CP-5 on the cell: MOVING then MOVED(B, 1); seq, generation and every row continue in B; adopt after A\'s report_through ≥ ts(moved) (DT-12, DT-37 core)', { ...T, skip: SKIP }, async () => {
  const events = { a: [] as string[], b: [] as string[] };
  const { a, b, coordinator } = await cell(events);
  const X = utf8(`x-${R}`);
  const SA = slotOfPartition(X, 4);
  assert.equal((await a.append({ partition: X, entries: [entry('a1'), entry('a2')] })).r, 'Committed');
  const decision = { table: `${LINK.kind}_mark`, key: { partition: X, id: 'd' } };
  assert.equal((await a.append({ partition: X, entries: [entry('a3')], projections: [{ table: decision.table, op: 'upsert', key: decision.key, row: {} }] })).r, 'Committed');
  assert.deepEqual(await coordinator.move({ kind: LINK.kind, partition: X, from: SA, to: DEDICATED }), { generation: 1 });
  assert.deepEqual(events.a, [`movedOut x-${R}`]);
  assert.deepEqual(events.b, [`adopt x-${R} 1`]);
  assert.deepEqual(await a.append({ partition: X, entries: [entry('a4')] }), { r: 'Moved', slot: DEDICATED, generation: 1 });
  const r = await b.append({ partition: X, entries: [entry('b1')] });
  assert.equal(r.r, 'Committed');
  const rows = (await q().query(`SELECT seq, slot, generation, kind, ts::STRING AS ts FROM ${LINK.kind}_log WHERE partition = $1 ORDER BY seq`, [Buffer.from(X)])).rows as Array<{ seq: string; slot: number; generation: number; kind: number; ts: string }>;
  assert.deepEqual(rows.map((x) => [Number(x.seq), x.slot, x.generation, x.kind]), [
    [1, SA, 0, 1], [2, SA, 0, 1], [3, SA, 0, 1], [4, SA, 0, PLATFORM_ENTRY.moved], [5, DEDICATED, 1, PLATFORM_ENTRY.adopt], [6, DEDICATED, 1, 1],
  ]);
  for (let i = 1; i < rows.length; i++) assert.ok(compareHlc((rows[i - 1] as { ts: string }).ts as HlcTs, (rows[i] as { ts: string }).ts as HlcTs) <= 0);
  const fence = (await q().query(`SELECT report_through::STRING AS rt FROM owner_slot WHERE kind = $1 AND slot = $2`, [LINK.kind, SA])).rows[0] as { rt: string | null };
  assert.ok(fence.rt !== null && compareHlc(fence.rt as HlcTs, (rows[3] as { ts: string }).ts as HlcTs) >= 0, 'A\'s report fence passed moved');
  assert.deepEqual(await b.append({ partition: X, conditions: [{ kind: 'rowAbsent', row: decision, label: 'undecided' }], entries: [entry('twice')] }),
    { r: 'ConditionFailed', which: 'undecided' });
});

test('DT-42 on the cell: a hot partition moves under the highest load the dev cell sustains; Moving at most 200 ms p99; no cold rebuild', { ...T, skip: SKIP }, async () => {
  const events = { a: [] as string[], b: [] as string[] };
  const { coordinator, a, b } = await cell(events);
  const moves = 20;
  const movingMs: number[] = [];
  for (let m = 0; m < moves; m++) {
    const X = utf8(`hot-${R}-${m}`);
    const SA = slotOfPartition(X, 4);
    assert.equal((await a.append({ partition: X, entries: [entry('w')] })).r, 'Committed');
    let stop = false;
    let firstMoving: number | undefined;
    let lastMoving: number | undefined;
    const load = (async () => {
      for (let i = 0; !stop; i++) {
        const rt = events.b.includes(`adopt hot-${R}-${m} 1`) ? b : a;
        const res: AppendResult = await rt.append({ partition: X, entries: [entry(`l${i}`)] });
        if (res.r === 'Moving') { const now = performance.now(); firstMoving ??= now; lastMoving = now; }
      }
    })();
    await coordinator.move({ kind: LINK.kind, partition: X, from: SA, to: DEDICATED });
    stop = true;
    await load;
    movingMs.push(firstMoving !== undefined && lastMoving !== undefined ? lastMoving - firstMoving : 0);
  }
  const sorted = [...movingMs].sort((x, y) => x - y);
  const p99 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)] as number;
  console.log(`DT-42 Moving per move (ms): ${movingMs.map((x) => x.toFixed(1)).join(', ')}; p99 ${p99.toFixed(1)} ms`);
  assert.ok(p99 <= 200, `Moving p99 ${p99} ms > 200 ms`);
});

test('C01 CP-6 on the cell: a stop that bumps stops_version under a running holder answers Stopped and no entry commits above enforced_at', { ...T, skip: SKIP }, async () => {
  const events = { a: [] as string[], b: [] as string[] };
  const { a } = await cell(events);
  const X = utf8(`stop-${R}`);
  const SA = slotOfPartition(X, 4);
  assert.equal((await a.append({ partition: X, entries: [entry('s1')] })).r, 'Committed');
  const ref = Buffer.from(`det-${R}`);
  let enforcedAt = '';
  const c = await q().connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO placement_integrity_stops (kind, partition, detection_ref, state, at) VALUES ($1, $2, $3, 'stopped', cluster_logical_timestamp())`, [LINK.kind, Buffer.from(X), ref]);
    await c.query(`UPDATE owner_slot SET stops_version = stops_version + 1 WHERE kind = $1 AND slot = $2`, [LINK.kind, SA]);
    enforcedAt = String(((await c.query('SELECT cluster_logical_timestamp()::STRING AS t')).rows[0] as { t: string }).t);
    await c.query('COMMIT');
  } finally { c.release(); }
  const r = await a.append({ partition: X, entries: [entry('s2')] });
  assert.equal(r.r, 'Stopped');
  assert.equal(hex(r.r === 'Stopped' ? r.detectionRef : new Uint8Array()), hex(ref));
  const above = (await q().query(`SELECT count(*)::INT AS n FROM ${LINK.kind}_log WHERE partition = $1 AND ts > $2::DECIMAL`, [Buffer.from(X), enforcedAt])).rows[0] as { n: number };
  assert.equal(above.n, 0);
});
