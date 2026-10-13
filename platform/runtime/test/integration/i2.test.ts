/**
 * S-PLAT-I2 exit criteria on the dev cell (CockroachDB, 3 nodes): slot groups under contention (3), the hot
 * standby takeover DT-28 in-region (2), CP-1 with the second lane on (5), DT-10 and DT-09 owner-host part (1),
 * and the gateway tier failover through a fault proxy (6). One database for the run; unique kind names. The
 * tests skip when the dev cell is not reachable, and fail instead with REQUIRE_DEV_CELL=1. They never stop or
 * recreate the dev cell's containers: the fault proxy is a local TCP proxy.
 */
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { AppendResult, OpenedLogRow, OwnerDeclaration, OwnerHooks, SlotNo } from '../../src/index.ts';
import {
  CockroachOwnerRuntime, ManualLoad, PgStore, compareHlc, hex, hlcAddMs, hlcFromWallMs, slotOfPartition, utf8, writeTimingVersion,
} from '../../src/index.ts';
import { migrateKinds } from '@share/owner-migrate';
import { FaultProxy, createTestDatabase, devCellSkip } from '../../testing/index.ts';

const URL = process.env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';
/** A second node of the dev cell (the next gateway tier). */
const URL2 = process.env['DATABASE_URL_2'] ?? 'postgresql://root@localhost:26258/defaultdb?sslmode=disable';

async function dbReachable(): Promise<string | undefined> {
  const c = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 1_500 });
  try { await c.connect(); await c.query('SELECT 1'); return undefined; } catch (e) { return (e as { code?: string }).code ?? String(e); } finally { await c.end().catch(() => {}); }
}
const dbError = await dbReachable();
const SKIP = devCellSkip(dbError === undefined ? undefined : `CockroachDB at ${URL}: ${dbError}`);

const R = randomBytes(3).toString('hex');
const decl = (kind: string, extra: Partial<OwnerDeclaration> = {}): OwnerDeclaration => ({
  kind, slotCount: 4, entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }], projections: [], streams: [], ...extra,
});
const ATTR = decl(`ia_${R}`, { slotGroupWith: `ir_${R}` });
const RATING = decl(`ir_${R}`, { slotGroupWith: `ia_${R}` });
/** One kind for the single-kind tests: each test frees its slots at the end (afterEach stops its runtimes). */
const LINK = decl(`il_${R}`);
const LANE = LINK;
const TIMING_KIND = LINK;
const TIER = LINK;
const SKEW = LINK;
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const entry = (id: string) => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id } });
const FAST = { sessionTtlMs: 1_500, sessionRenewMs: 200, renewRetryMs: 100, holderViewMs: 1_400, maxLoopDelayMs: 100 };
/** C01 §7 production values (DT-28 and the tier test measure against them). */
const PROD = { sessionTtlMs: 3_000, sessionRenewMs: 500, renewRetryMs: 100, holderViewMs: 2_900, maxLoopDelayMs: 200 };
const T = { timeout: 120_000 };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, ms: number, what = f.toString()): Promise<void> {
  const end = Date.now() + ms;
  while (!(await f())) { if (Date.now() > end) throw new Error(`timed out after ${ms} ms: ${what}`); await sleep(20); }
}
function hooks(events: string[] = []): OwnerHooks {
  return {
    async onAcquire(slot, epoch, how) { events.push(`acquire ${slot} ${epoch} ${how}`); },
    onRelease(slot, reason) { events.push(`release ${slot} ${reason}`); },
    onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {},
  };
}

let db: { name: string; url: string; drop: () => Promise<void> } | undefined;
let admin: pg.Pool | undefined;
const open: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of open.splice(0).reverse()) await c().catch(() => {}); });
before(async () => {
  if (SKIP) return;
  db = await createTestDatabase(URL, 'ii2');
  admin = new pg.Pool({ connectionString: db.url, max: 4 });
  await migrateKinds(db.url, [ATTR, RATING, LINK], { presplit: false });
}, { timeout: 180_000 });
after(async () => { await admin?.end(); await db?.drop(); }, { timeout: 60_000 });

function url(): string {
  if (!db) throw new Error('no test database');
  return db.url;
}
function store(o: Partial<ConstructorParameters<typeof PgStore>[0]> = {}): PgStore {
  const s = new PgStore({ connectionString: url(), ...o });
  open.push(() => s.close());
  return s;
}
function q(): pg.Pool {
  if (!admin) throw new Error('no admin pool');
  return admin;
}
function track(rt: CockroachOwnerRuntime): CockroachOwnerRuntime {
  open.push(() => rt.stop());
  return rt;
}

// ---------------- exit criterion (3): slot groups ----------------

/** One buyer partition in each slot. */
const BUYER: Uint8Array[] = [];
for (let i = 0; BUYER.filter(Boolean).length < 4; i++) { const p = utf8(`buyer-${i}`); const s = slotOfPartition(p, 4); BUYER[s] ??= p; }

async function groupProcess(slots: SlotNo[], events: string[] = []) {
  const s = store();
  const member = track(new CockroachOwnerRuntime({ declaration: RATING, store: s, slots, load: new ManualLoad(), slotGroupMember: true, testing: { sessionTimings: FAST } }));
  const leader = track(new CockroachOwnerRuntime({ declaration: ATTR, store: s, slots, load: new ManualLoad(), slotGroup: { members: [member] }, testing: { sessionTimings: FAST } }));
  await member.start(hooks(events));
  await leader.start(hooks(events));
  return { leader, member };
}

/** Slots whose two member rows differ in session or epoch (empty when every group is whole). */
async function brokenGroups(): Promise<string[]> {
  const r = await q().query<{ slot: number; a: string | null; b: string | null; ea: string; eb: string }>(
    `SELECT a.slot, a.session_id::STRING AS a, b.session_id::STRING AS b, a.epoch::STRING AS ea, b.epoch::STRING AS eb
       FROM owner_slot AS a JOIN owner_slot AS b ON b.kind = $2 AND b.slot = a.slot WHERE a.kind = $1`, [ATTR.kind, RATING.kind]);
  return r.rows.filter((x) => x.a !== x.b || x.ea !== x.eb).map((x) => `slot ${x.slot}: ${x.a}/${x.ea} vs ${x.b}/${x.eb}`);
}

test('C01 §3.1 slot groups on the cell: two group processes contend across seeded pauses; slot i of both kinds is always under one session and one epoch', { ...T, skip: SKIP }, async () => {
  const seed = 4242;
  let x = seed;
  const rnd = (): number => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; };
  const a = await groupProcess([0, 1, 2, 3]);
  await until(() => a.leader.heldSlots().length === 4 && a.member.heldSlots().length === 4, 10_000);
  const b = await groupProcess([0, 1, 2, 3]);
  const procs = [a, b];
  const paused = [false, false];
  const end = Date.now() + 15_000;
  let observations = 0;
  let commits = 0;
  while (Date.now() < end) {
    const i = rnd() < 0.5 ? 0 : 1;
    const p = procs[i];
    if (p && rnd() < 0.25) { if (paused[i]) p.leader.resumeRenewalsForTest(); else p.leader.pauseRenewalsForTest(); paused[i] = !paused[i]; }
    for (const [gi, g] of procs.entries()) {
      if (paused[gi]) continue;                      // a paused process proposes nothing (its view may have ended)
      for (const s of g.member.heldSlots()) {
        const part = BUYER[s] as Uint8Array;
        const r = await Promise.race([g.member.append({ partition: part, entries: [entry(`${observations}-${s}-${R}`)] }), sleep(1_000).then(() => undefined)]);
        if (r?.r === 'Committed') commits += 1;
      }
    }
    assert.deepEqual(await brokenGroups(), [], `seed ${seed}`);
    observations += 1;
    await sleep(Math.floor(rnd() * 300));
  }
  for (const [i, p] of procs.entries()) if (paused[i]) p.leader.resumeRenewalsForTest();
  // A pause past session_ttl of whichever holds slot 0: the other takes its groups by expiry.
  const holderOf0 = procs.find((g) => g.leader.heldSlots().includes(0)) ?? a;
  const other = holderOf0 === a ? b : a;
  holderOf0.leader.pauseRenewalsForTest();
  await until(() => other.leader.heldSlots().includes(0) && other.member.heldSlots().includes(0), 10_000, 'takeover of slot 0');
  holderOf0.leader.resumeRenewalsForTest();
  assert.deepEqual(await brokenGroups(), [], `seed ${seed}`);
  const epochs = await q().query<{ e: string }>(`SELECT max(epoch)::STRING AS e FROM owner_slot WHERE kind = $1`, [ATTR.kind]);
  assert.ok(BigInt(epochs.rows[0]?.e ?? '0') >= 2n, `seed ${seed}: at least one takeover happened`);
  assert.ok(observations >= 5 && commits > 0, `seed ${seed}: ${observations} observations, ${commits} commits`);
  assert.deepEqual(await brokenGroups(), []);
});

test('C01 §3.1 slot groups on the cell: a group with one member held by another live session is not taken at all', { ...T, skip: SKIP }, async () => {
  const s = store();
  const foreign = track(new CockroachOwnerRuntime({ declaration: RATING, store: s, slots: [], load: new ManualLoad(), testing: { sessionTimings: FAST } }));
  await foreign.start(hooks());
  // The foreign live session takes rating slot 2 alone (an operator mistake the group must survive).
  await q().query(`UPDATE owner_slot SET session_id = NULL WHERE kind IN ($1, $2)`, [ATTR.kind, RATING.kind]);
  await q().query(`UPDATE owner_slot SET session_id = $1, epoch = epoch + 1 WHERE kind = $2 AND slot = 2`, [foreign.sessionId(), RATING.kind]);
  const before = (await q().query<{ e: string }>(`SELECT epoch::STRING AS e FROM owner_slot WHERE kind = $1 AND slot = 2`, [ATTR.kind])).rows[0]?.e;
  const g = await groupProcess([1, 2]);
  await until(() => g.leader.heldSlots().includes(1), 10_000);
  await sleep(1_000);
  assert.deepEqual([g.leader.heldSlots(), g.member.heldSlots()], [[1], [1]]);
  const row = (await q().query<{ s: string | null; e: string }>(`SELECT session_id::STRING AS s, epoch::STRING AS e FROM owner_slot WHERE kind = $1 AND slot = 2`, [ATTR.kind])).rows[0];
  assert.deepEqual(row, { s: null, e: before }, 'attr slot 2 untouched: no part of the group was taken');
  await g.leader.stop();
  await q().query(`UPDATE owner_slot SET session_id = NULL WHERE kind IN ($1, $2)`, [ATTR.kind, RATING.kind]);
});

// ---------------- exit criterion (2): DT-28 in-region ----------------

test('DT-28 (in-region) on the cell: a killed link-kind holder is replaced by its hot standby within 5 s with no reload beyond the last pushed batch', { ...T, skip: SKIP }, async () => {
  const holder = track(new CockroachOwnerRuntime({ declaration: LINK, store: store(), slots: [0, 1, 2, 3], load: new ManualLoad(), testing: { sessionTimings: PROD } }));
  await holder.start(hooks());
  await until(() => holder.heldSlots().length === 4, 10_000);
  const standbyMem = new Map<string, string[]>();
  const apply = (rows: OpenedLogRow[]): void => {
    for (const r of rows) standbyMem.set(hex(r.partition), [...(standbyMem.get(hex(r.partition)) ?? []), (r.payload as { id: string }).id]);
  };
  const events: string[] = [];
  const standby = track(new CockroachOwnerRuntime({ declaration: LINK, store: store(), slots: [0, 1, 2, 3], load: new ManualLoad(),
    standby: { apply, pollMs: 250 }, testing: { sessionTimings: PROD } }));
  await standby.start(hooks(events));
  holder.attachStandby('in-region', standby.standbyChannel());
  const links = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'].map((l) => utf8(`${R}-${l}`));
  const holderMem = new Map<string, string[]>();
  // Pushed batches for 7 s: longer than the follower-read lag, so the standby's tail meets the push chain.
  const end = Date.now() + 7_000;
  for (let i = 0; Date.now() < end; i++) {
    const p = links[i % links.length] as Uint8Array;
    const r = await holder.append({ partition: p, entries: [entry(`${hex(p)}-${i}`)] });
    assert.equal(r.r, 'Committed');
    holderMem.set(hex(p), [...(holderMem.get(hex(p)) ?? []), `${hex(p)}-${i}`]);
    await sleep(40);
  }
  await until(() => [...holderMem].every(([k, v]) => (standbyMem.get(k) ?? []).length === v.length), 5_000, 'the standby holds the last pushed batch');
  assert.deepEqual(standby.heldSlots(), [], 'the standby holds no slot while the holder lives');
  // Kill the holder: no renewal, no release, no further work.
  holder.pauseRenewalsForTest();
  const killed = Date.now();
  let served: number | undefined;
  const p = links[0] as Uint8Array;
  await until(async () => {
    if (!standby.heldSlots().includes(slotOfPartition(p, 4))) return false;
    const r = await standby.append({ partition: p, entries: [entry(`${hex(p)}-after`)] });
    if (r.r === 'Committed') { served = Date.now(); return true; }
    return false;
  }, 10_000, 'the standby serves');
  const tookMs = (served ?? Infinity) - killed;
  await until(() => standby.heldSlots().length === 4 && events.filter((e) => e.startsWith('acquire')).length === 4, 5_000, 'every slot taken');
  assert.ok(tookMs <= 5_000, `the standby served ${tookMs} ms after the kill (DT-28: within 5 s)`);
  assert.equal(standby.standbyStats()?.catchUpRows, 0, 'no reload from the log beyond the last pushed batch');
  for (const [k, v] of holderMem) assert.deepEqual(standbyMem.get(k), v, `memory of ${k} equals the holder's`);
  assert.equal(events.filter((e) => e.startsWith('acquire') && e.endsWith('expiry')).length, 4);
  console.log(`# DT-28: takeover served ${tookMs} ms after the kill; pushed rows ${standby.standbyStats()?.pushedRows}, tail rows ${standby.standbyStats()?.tailRows}`);
});

// ---------------- exit criterion (5): second lane ----------------

test('C01 CP-1 with the second lane on, on the cell: no second-lane batch carries a partition of the first lane\'s batch; per-partition seq contiguous and ts never back', { ...T, skip: SKIP }, async () => {
  await writeTimingVersion(q(), { epsilonMs: 100, deltaXMs: 320, tauMs: 420, secondLane: { [LANE.kind]: { account: true } } });
  const rt = track(new CockroachOwnerRuntime({ declaration: LANE, store: store(), slots: [0, 1, 2, 3], load: new ManualLoad(), testing: { sessionTimings: FAST } }));
  await rt.start(hooks());
  await until(() => rt.heldSlots().length === 4, 10_000);
  await sleep(500);                                  // a renewal tick reads the new platform_timing version
  const parts: Uint8Array[] = [];
  for (let i = 0; parts.length < 8; i++) { const p = utf8(`${R}-lane-${i}`); if (slotOfPartition(p, 4) === 0) parts.push(p); }
  const all: Array<Promise<AppendResult>> = [];
  for (let i = 0; i < 160; i++) {
    all.push(rt.append({ partition: parts[i % parts.length] as Uint8Array, entries: [entry(`lane-${i}`)] }));
    if (i % 10 === 0) await sleep(2);
  }
  const results = await Promise.all(all);
  assert.ok(results.every((r) => r.r === 'Committed'), JSON.stringify(results.filter((r) => r.r !== 'Committed').slice(0, 3)));
  for (const s of rt.batchesStarted) assert.deepEqual(s.partitions.filter((p) => s.otherInFlight.includes(p)), [], `a ${s.lane} batch carried a partition in the other lane`);
  const second = rt.batchesStarted.filter((s) => s.lane === 'second').length;
  assert.ok(second > 0, 'the second lane ran');
  const rows = await q().query<{ p: string; seq: string; ts: string }>(`SELECT encode(partition, 'hex') AS p, seq::STRING AS seq, ts::STRING AS ts FROM ${LANE.kind}_log AS l WHERE encode(l.partition, 'escape') LIKE $1 ORDER BY l.partition, l.seq`, [`${R}-lane-%`]);
  const by = new Map<string, Array<{ seq: bigint; ts: string }>>();
  for (const r of rows.rows) by.set(r.p, [...(by.get(r.p) ?? []), { seq: BigInt(r.seq), ts: r.ts }]);
  assert.equal(rows.rows.length, 160);
  for (const [p, list] of by) {
    list.forEach((r, i) => assert.equal(r.seq, BigInt(i + 1), `${p} seq contiguous`));
    for (let i = 1; i < list.length; i++) assert.ok(compareHlc(list[i - 1]?.ts as never, list[i]?.ts as never) <= 0, `${p} ts never back`);
  }
  console.log(`# second lane: ${rt.batchesStarted.length} batches, ${second} on the second lane`);
  await writeTimingVersion(q(), { epsilonMs: 100, deltaXMs: 320, tauMs: 420, secondLane: {} });
});

// ---------------- exit criterion (1): DT-10 and DT-09 ----------------

test('DT-10 on the cell: raising δ_x_cfg writes a new platform_timing version; a confirm whose ts is at or after D − τ under the new version is refused', { ...T, skip: SKIP }, async () => {
  await writeTimingVersion(q(), { epsilonMs: 100, deltaXMs: 320, tauMs: 420, secondLane: {} });
  const rt = track(new CockroachOwnerRuntime({ declaration: TIMING_KIND, store: store(), slots: [0, 1, 2, 3], load: new ManualLoad(), testing: { sessionTimings: FAST } }));
  await rt.start(hooks());
  await until(() => rt.heldSlots().length === 4, 10_000);
  const p = utf8(`${R}-acct`);
  // The deadline D is 435 ms after the database's time: with τ = 420, D − τ is 15 ms ahead; with τ = 450, 15 ms behind.
  const confirm = async (id: string, tauExpected: number): Promise<AppendResult> => {
    const now = (await q().query<{ t: string }>('SELECT cluster_logical_timestamp()::STRING AS t')).rows[0]?.t as string;
    const D = hlcAddMs(hlcFromWallMs(Number(BigInt(now.split('.')[0] ?? '0') / 1_000_000n)), 435);
    return rt.append({ partition: p, conditions: [{ kind: 'tsBefore', bound: (t) => { assert.equal(t.tauMs, tauExpected); return hlcAddMs(D, -t.tauMs); }, label: 'ts < D − τ' }],
      entries: [entry(id)] });
  };
  assert.equal((await confirm('before', 420)).r, 'Committed');
  const v = await writeTimingVersion(q(), { epsilonMs: 100, deltaXMs: 350, tauMs: 450, secondLane: {} });
  assert.ok(v >= 2n);
  assert.deepEqual(await confirm('after', 450), { r: 'ConditionFailed', which: 'ts < D − τ' }, 'the confirm reads the new version in its own transaction');
  const n = (await q().query<{ n: number }>(`SELECT count(*)::INT4 AS n FROM ${TIMING_KIND.kind}_log WHERE identity = $1`, [Buffer.from('after')])).rows[0]?.n;
  assert.equal(n, 0);
  await writeTimingVersion(q(), { epsilonMs: 100, deltaXMs: 320, tauMs: 420, secondLane: {} });
});

test('DT-09 (owner-host part) on the cell: an owner host whose offset bound exceeds 50 ms gives up its session within 3 s', { ...T, skip: SKIP }, async () => {
  let skewMs = 0;
  let gaveUp = 0;
  let measured: number | undefined;
  const rt = track(new CockroachOwnerRuntime({ declaration: SKEW, store: store(), slots: [0, 1, 2, 3], load: new ManualLoad(),
    wallMs: () => Date.now() - skewMs, offsetCheck: { onGiveUp: () => { gaveUp += 1; }, onSample: (smp) => { if (skewMs > 0 && smp.boundMs > 50) measured ??= Date.now(); } },
    testing: { sessionTimings: PROD } }));
  await rt.start(hooks());
  await until(() => rt.heldSlots().length === 4, 10_000);
  await sleep(1_100);
  const revoked = async (): Promise<boolean> => (await q().query<{ r: boolean }>('SELECT revoked AS r FROM owner_session WHERE session_id = $1', [rt.sessionId()])).rows[0]?.r === true;
  assert.equal(await revoked(), false, 'within bound on the dev cell: nothing happens');
  skewMs = 60;                                       // the host's clock falls 60 ms behind the database's
  const start = Date.now();
  await until(revoked, 6_000, 'the session is given up');
  const done = Date.now();
  await until(() => gaveUp === 1, 2_000, 'onGiveUp');
  // RFC-006 §6.2: three consecutive samples, one a second. Measured from the first sample above 50 ms, the
  // give-up is two samples later; from the clock's change it adds up to one sample interval (STATUS-I2.md issue).
  assert.ok(measured !== undefined);
  assert.ok(done - measured <= 3_000, `gave up the session ${done - measured} ms after the first sample above 50 ms (DT-09: within 3 s)`);
  console.log(`# DT-09: ${done - start} ms from the clock change, ${done - measured} ms from the first sample above 50 ms`);
  assert.equal(gaveUp, 1);
  assert.deepEqual(rt.heldSlots(), []);
});

// ---------------- exit criterion (6): gateway tiers ----------------

test('should reach the next gateway tier within one 400 ms timeout and let no session lapse when the gateway tier of one facility is cut by the fault proxy', { ...T, skip: SKIP }, async () => {
  const u1 = new globalThis.URL(URL);
  const u2 = new globalThis.URL(URL2);
  const p1 = await FaultProxy.start({ host: u1.hostname, port: Number(u1.port || 26257) });
  const p2 = await FaultProxy.start({ host: u2.hostname, port: Number(u2.port || 26258) });
  const s = store({ tiers: [p1.url(url()), p2.url(url())] });
  // Closed before the store: a pool cannot end a connection that a cut proxy holds silent.
  open.push(() => p1.close(), () => p2.close());
  const rt = track(new CockroachOwnerRuntime({ declaration: TIER, store: s, slots: [0, 1, 2, 3], load: new ManualLoad(), testing: { sessionTimings: PROD } }));
  await rt.start(hooks());
  await until(() => rt.heldSlots().length === 4, 10_000);
  const expiries: Array<{ at: number; expires: number }> = [];
  let lapses = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      // The holder's view of its session (a slot can be gated meanwhile, e.g. while an Ambiguous COMMIT is resolved).
      if (!rt.sessionViewLive()) lapses += 1;
      const r = await q().query<{ e: string; n: string }>(
        `SELECT (extract(epoch FROM expires_at) * 1000)::INT8::STRING AS e, (extract(epoch FROM now()) * 1000)::INT8::STRING AS n
           FROM owner_session WHERE session_id = $1`, [rt.sessionId()]);
      const row = r.rows[0];
      if (row) {
        const e = Number(row.e);
        if (e - Number(row.n) <= 0) lapses += 1;
        if (expiries.at(-1)?.expires !== e) expiries.push({ at: Date.now(), expires: e });
      }
      await sleep(20);
    }
  })();
  await sleep(2_500);
  p1.cut();
  const cutAt = Date.now();
  const cutPerf = performance.now();
  // Appends go on through the next tier (the epoch read times out on tier 0 and the batch restarts there).
  const part = utf8(`${R}-tier`);
  let committed = 0;
  const end = Date.now() + 6_000;
  while (Date.now() < end) {
    const r = await Promise.race([rt.append({ partition: part, entries: [entry(`t-${committed}-${Date.now()}`)] }), sleep(20_000).then(() => 'hung' as const)]);
    assert.notEqual(r, 'hung', 'an append after the cut never waits for the cut tier');
    if (r !== 'hung' && r.r === 'Committed') committed += 1;
    await sleep(100);
  }
  sampling = false;
  await sampler;
  const afterCut = expiries.filter((x) => x.at >= cutAt);
  assert.ok(afterCut.length >= 3, `renewals went on after the cut (${afterCut.length})`);
  const first = afterCut[0];
  const lastBefore = expiries.filter((x) => x.at < cutAt).at(-1);
  assert.ok(first && lastBefore, 'renewals before and after the cut');
  // The first renewal attempt that met the cut tier: it gave up tier 0 after one 400 ms per-tier timeout and went
  // straight on to tier 1. (Whether tier 1 answers within 400 ms depends on the dev cell's load; the no-lapse check
  // below covers the renewals that follow.)
  const tries = s.tierTrace.filter((x) => x.op === 'renewal' && x.endMs >= cutPerf);
  const failed = tries.find((x) => x.tier === 0 && !x.ok);
  assert.ok(failed, 'a renewal met the cut tier');
  const next = tries.find((x) => x.startMs >= failed.endMs);
  assert.ok(next && next.tier === 1, 'the same renewal went on to tier 1');
  // An attempt that started before the cut can end early on tier 0; the bound is its end minus the cut.
  const onTier0 = failed.endMs - Math.max(failed.startMs, cutPerf);
  assert.ok(onTier0 <= 400 + 50, `tier 0 was given up after ${Math.round(onTier0)} ms`);
  assert.ok(next.startMs - failed.endMs <= 20, `tier 1 was tried ${Math.round(next.startMs - failed.endMs)} ms later`);
  const before = expiries.filter((x) => x.at < cutAt);
  const gap = first.expires - lastBefore.expires;
  const normal = Math.max(...before.slice(1).map((x, i) => x.expires - (before[i] as { expires: number }).expires));
  assert.equal(lapses, 0, 'no session lapse: neither in the database nor in the holder\'s view');
  assert.ok(committed >= 10, `appends committed through the next tier (${committed})`);
  assert.ok(s.tiers.isOpen(0), 'the breaker of the cut tier is open after 3 timeouts');
  assert.deepEqual(s.tiers.order()[0], 1);
  console.log(`# tiers: renewal across the cut ${gap} ms (slowest before ${normal} ms); ${committed} appends committed`);
  p1.heal();
});
