/**
 * S-PLAT-I2 work item 7 and exit criterion (6) at the unit level: the PgStore tier loop of the renewal, the
 * session poll and the batch's epoch read (RFC-006 §4.7; C01 §7). Each tier is a pool double; a cut tier is a
 * gateway that accepts the connection and never answers.
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { PARAMS, PgStore, TierTimeout } from '../src/index.ts';

type Answer = { rows: Array<Record<string, unknown>>; rowCount: number };
type Behaviour = 'silent' | 'refused' | ((sql: string) => Promise<Answer>);

interface TierDouble {
  pool: pg.Pool;
  connects: number;
  sql: string[];
  /** The argument of each release: an Error discards the client. */
  releases: Array<Error | undefined>;
}

function tier(b: Behaviour): TierDouble {
  const d: TierDouble = { pool: undefined as never, connects: 0, sql: [], releases: [] };
  const client = {
    query(sql: string): Promise<Answer> {
      d.sql.push(sql);
      if (b === 'silent' || b === 'refused') return new Promise<Answer>(() => { /* a cut gateway never answers */ });
      return b(sql);
    },
    release(e?: Error): void { d.releases.push(e); },
  };
  const pool = {
    connect(): Promise<typeof client> {
      d.connects += 1;
      if (b === 'refused') return Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      return Promise.resolve(client);
    },
    on(): void { /* no idle errors */ },
  };
  // A double of the two pg.Pool methods the tier loop uses; any other method is absent and throws.
  d.pool = pool as unknown as pg.Pool;
  return d;
}

const renewed = (): Promise<Answer> => Promise.resolve({ rows: [], rowCount: 1 });

function store(...tiers: TierDouble[]): PgStore {
  return new PgStore({ connectionString: 'postgresql://unused', pools: tiers.map((t) => t.pool) });
}

test('should give up a cut tier after one 400 ms per-tier timeout and renew on the next tier at once when the gateway tier of one facility is cut', async () => {
  assert.equal(PARAMS.tierTimeoutMs, 400);
  const cut = tier('silent');
  const next = tier(renewed);
  const s = store(cut, next);
  assert.equal(await s.renewSession(3, 'sess-1', 6_000), true);
  const [onCut, onNext, ...rest] = s.tierTrace;
  assert.deepEqual(rest, []);
  assert.ok(onCut && onNext);
  assert.deepEqual([onCut.op, onCut.tier, onCut.ok], ['renewal', 0, false]);
  assert.deepEqual([onNext.op, onNext.tier, onNext.ok], ['renewal', 1, true]);
  const onTier0 = onCut.endMs - onCut.startMs;
  assert.ok(onTier0 >= 400 && onTier0 <= 450, `tier 0 was given up after ${Math.round(onTier0)} ms`);
  assert.ok(onNext.startMs - onCut.endMs <= 20, `tier 1 was tried ${Math.round(onNext.startMs - onCut.endMs)} ms later`);
  assert.equal(cut.releases.length, 1);
  assert.ok(cut.releases[0] instanceof Error, 'the client of the cut tier is discarded, not returned to the pool');
  assert.deepEqual(next.releases, [undefined]);
  assert.match(next.sql[0] ?? '', /^UPDATE owner_session SET expires_at/);
  assert.equal(s.tiers.isOpen(0), false, 'one timeout does not open the breaker');
});

test('should open the cut tier\'s breaker after 3 renewals that time out on it, and then renew on the next tier with no attempt on the cut one', async () => {
  const cut = tier('silent');
  const next = tier(renewed);
  const s = store(cut, next);
  for (let i = 0; i < 3; i++) assert.equal(await s.renewSession(0, 'sess-1', 6_000), true);
  assert.equal(s.tiers.isOpen(0), true);
  assert.deepEqual(s.tiers.order(), [1, 0]);
  const connectsOnCut = cut.connects;
  const t0 = performance.now();
  assert.equal(await s.renewSession(0, 'sess-1', 6_000), true);
  assert.ok(performance.now() - t0 < 100, 'no per-tier timeout is spent on an open tier');
  assert.equal(cut.connects, connectsOnCut, 'no connection to the cut tier while its breaker is open');
  assert.deepEqual(s.tierTrace.slice(-1).map((x) => [x.tier, x.ok]), [[1, true]]);
});

test('should move to the next tier at once and count a timeout when a tier refuses the connection', async () => {
  const down = tier('refused');
  const next = tier(renewed);
  const s = store(down, next);
  const t0 = performance.now();
  assert.equal(await s.renewSession(0, 'sess-1', 6_000), true);
  assert.ok(performance.now() - t0 < 100, 'a refused connection does not wait for the per-tier timeout');
  assert.deepEqual(s.tierTrace.map((x) => [x.tier, x.ok]), [[0, false], [1, true]]);
  assert.deepEqual(s.tiers.events.filter((e) => e.tier === 0).map((e) => e.event), ['timeout']);
});

test('should return false and try no other tier when the renewal answers that the session is revoked', async () => {
  const first = tier(() => Promise.resolve({ rows: [], rowCount: 0 }));
  const next = tier(renewed);
  const s = store(first, next);
  assert.equal(await s.renewSession(0, 'sess-1', 6_000), false);
  assert.equal(next.connects, 0);
});

test('should throw the database error and try no other tier when a tier answers the renewal with an error', async () => {
  const failing = tier(() => Promise.reject(Object.assign(new Error('restart transaction'), { code: '40001' })));
  const next = tier(renewed);
  const s = store(failing, next);
  await assert.rejects(s.renewSession(0, 'sess-1', 6_000), (e: unknown) => (e as { code?: unknown }).code === '40001');
  assert.equal(next.connects, 0, 'a database error is not a gateway failure');
  assert.deepEqual(s.tiers.events, [], 'a database error does not count toward the breaker');
});

test('should throw TierTimeout of the last tier when no tier answers the renewal', async () => {
  const s = store(tier('silent'), tier('silent'));
  await assert.rejects(s.renewSession(0, 'sess-1', 6_000), (e: unknown) => e instanceof TierTimeout && e.tier === 1);
  assert.deepEqual(s.tierTrace.map((x) => [x.tier, x.ok]), [[0, false], [1, false]]);
});

test('should poll the session on the next tier when the first tier is cut', async () => {
  const cut = tier('silent');
  const next = tier(() => Promise.resolve({ rows: [{ slot: 2, session_id: 'sess-9', epoch: '4', expired: false, revoked: false }], rowCount: 1 }));
  const s = store(cut, next);
  assert.deepEqual(await s.listSlots('k', [2]), [{ slot: 2, sessionId: 'sess-9', epoch: 4n, sessionExpired: false, sessionRevoked: false }]);
  assert.deepEqual(s.tierTrace.map((x) => [x.tier, x.ok]), [[0, false], [1, true]]);
});

test('should begin the batch on the next tier when BEGIN on the first tier does not answer within the per-tier timeout', async () => {
  const cut = tier('silent');
  const next = tier(() => Promise.resolve({ rows: [], rowCount: 0 }));
  const s = store(cut, next);
  await s.beginBatch();
  assert.deepEqual(cut.sql, ['BEGIN']);
  assert.deepEqual(next.sql, ['BEGIN', 'SAVEPOINT cockroach_restart']);
  assert.ok(cut.releases[0] instanceof Error, 'the client of the cut tier is discarded');
  assert.deepEqual(s.tiers.events, [{ tier: 0, event: 'timeout' }]);
});

test('should abandon the batch with TierTimeout and count a timeout on its tier when the epoch read does not answer within the per-tier timeout', async () => {
  let n = 0;
  const cutAfterBegin = tier(() => (++n <= 2 ? Promise.resolve({ rows: [], rowCount: 0 }) : new Promise<Answer>(() => { /* cut */ })));
  const s = store(cutAfterBegin, tier(renewed));
  const tx = await s.beginBatch();
  await assert.rejects(tx.readFence('k', 0), (e: unknown) => e instanceof TierTimeout && e.tier === 0);
  assert.deepEqual(s.tiers.events, [{ tier: 0, event: 'timeout' }]);
});

test('should count one timeout, not two, when one epoch read does not answer, also after the 2.5 s statement limit has passed', async (t) => {
  t.after(() => mock.timers.reset());
  let n = 0;
  const cutAfterBegin = tier(() => (++n <= 2 ? Promise.resolve({ rows: [], rowCount: 0 }) : new Promise<Answer>(() => { /* cut */ })));
  const s = store(cutAfterBegin, tier(renewed));
  const tx = await s.beginBatch();
  mock.timers.enable({ apis: ['setTimeout'] });
  const read = tx.readFence('k', 0);
  const refused = assert.rejects(read, (e: unknown) => e instanceof TierTimeout && e.tier === 0);
  mock.timers.tick(PARAMS.tierTimeoutMs);
  await refused;
  mock.timers.tick(PARAMS.statementTimeoutMs + 500);
  await Promise.resolve();
  assert.deepEqual(s.tiers.events, [{ tier: 0, event: 'timeout' }]);
});
