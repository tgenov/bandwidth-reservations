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

/** Mock timers (engineering.md §5): the per-tier timeouts fire only when the test moves the time. */
function mockTime(t: { after: (fn: () => void) => void }): void {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
}

/** Lets every pending promise step run (setImmediate is not mocked). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** The state of a promise after the pending steps ran, with no move of the time. */
async function stateOf<T>(p: Promise<T>): Promise<{ done: true; value: T } | { done: false } | { done: true; error: unknown }> {
  let out: { done: true; value: T } | { done: false } | { done: true; error: unknown } = { done: false };
  p.then((value) => { out = { done: true, value }; }, (error: unknown) => { out = { done: true, error }; });
  await flush();
  return out;
}

/** Lets the pending steps run (so their timers are set), moves the mocked time by `ms`, then lets the steps run again. */
async function tick(ms: number): Promise<void> {
  await flush();
  mock.timers.tick(ms);
  await flush();
}

test('should give up a cut tier after one 400 ms per-tier timeout and renew on the next tier at once when the gateway tier of one facility is cut', async (t) => {
  mockTime(t);
  assert.equal(PARAMS.tierTimeoutMs, 400);
  const cut = tier('silent');
  const next = tier(renewed);
  const s = store(cut, next);
  const renewal = s.renewSession(3, 'sess-1', 6_000);
  await tick(PARAMS.tierTimeoutMs - 1);
  assert.equal(next.connects, 0, 'tier 1 is not tried before the per-tier timeout of tier 0');
  assert.deepEqual(await stateOf(renewal), { done: false });
  await tick(1);
  assert.equal(next.connects, 1, 'tier 1 is tried at the per-tier timeout, with no further wait');
  assert.deepEqual(await stateOf(renewal), { done: true, value: true });
  assert.deepEqual(s.tierTrace.map((x) => [x.op, x.tier, x.ok]), [['renewal', 0, false], ['renewal', 1, true]]);
  assert.equal(cut.releases.length, 1);
  assert.ok(cut.releases[0] instanceof Error, 'the client of the cut tier is discarded, not returned to the pool');
  assert.deepEqual(next.releases, [undefined]);
  assert.match(next.sql[0] ?? '', /^UPDATE owner_session SET expires_at/);
  assert.equal(s.tiers.isOpen(0), false, 'one timeout does not open the breaker');
});

test('should open the cut tier\'s breaker after 3 renewals that time out on it, and then renew on the next tier with no attempt on the cut one', async (t) => {
  mockTime(t);
  const cut = tier('silent');
  const next = tier(renewed);
  const s = store(cut, next);
  for (let i = 0; i < 3; i++) {
    const renewal = s.renewSession(0, 'sess-1', 6_000);
    await tick(PARAMS.tierTimeoutMs);
    assert.equal(await renewal, true);
  }
  assert.equal(s.tiers.isOpen(0), true);
  assert.deepEqual(s.tiers.order(), [1, 0]);
  const connectsOnCut = cut.connects;
  assert.deepEqual(await stateOf(s.renewSession(0, 'sess-1', 6_000)), { done: true, value: true }, 'no per-tier timeout is spent on an open tier');
  assert.equal(cut.connects, connectsOnCut, 'no connection to the cut tier while its breaker is open');
  assert.deepEqual(s.tierTrace.slice(-1).map((x) => [x.tier, x.ok]), [[1, true]]);
});

test('should move to the next tier at once and count a timeout when a tier refuses the connection', async (t) => {
  mockTime(t);
  const down = tier('refused');
  const next = tier(renewed);
  const s = store(down, next);
  assert.deepEqual(await stateOf(s.renewSession(0, 'sess-1', 6_000)), { done: true, value: true }, 'a refused connection does not wait for the per-tier timeout');
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

test('should throw TierTimeout of the last tier when no tier answers the renewal', async (t) => {
  mockTime(t);
  const s = store(tier('silent'), tier('silent'));
  const renewal = s.renewSession(0, 'sess-1', 6_000);
  const refused = assert.rejects(renewal, (e: unknown) => e instanceof TierTimeout && e.tier === 1);
  await tick(PARAMS.tierTimeoutMs);
  await tick(PARAMS.tierTimeoutMs);
  await refused;
  assert.deepEqual(s.tierTrace.map((x) => [x.tier, x.ok]), [[0, false], [1, false]]);
});

test('should wait for a slow renewal past 400 ms when the store has one tier', async (t) => {
  mockTime(t);
  const slow = tier(() => new Promise<Answer>((r) => setTimeout(() => r({ rows: [], rowCount: 1 }), 600)));
  const s = store(slow);
  const renewal = s.renewSession(0, 'sess-1', 6_000);
  await tick(PARAMS.tierTimeoutMs);
  assert.deepEqual(await stateOf(renewal), { done: false }, 'one tier: no per-tier timeout at 400 ms');
  await tick(200);
  assert.deepEqual(await stateOf(renewal), { done: true, value: true });
  assert.deepEqual(s.tiers.events, []);
});

test('should poll the session on the next tier when the first tier is cut', async (t) => {
  mockTime(t);
  const cut = tier('silent');
  const next = tier(() => Promise.resolve({ rows: [{ slot: 2, session_id: 'sess-9', epoch: '4', expired: false, revoked: false }], rowCount: 1 }));
  const s = store(cut, next);
  const poll = s.listSlots('k', [2]);
  await tick(PARAMS.tierTimeoutMs);
  assert.deepEqual(await poll, [{ slot: 2, sessionId: 'sess-9', epoch: 4n, sessionExpired: false, sessionRevoked: false }]);
  assert.deepEqual(s.tierTrace.map((x) => [x.tier, x.ok]), [[0, false], [1, true]]);
});

test('should begin the batch on the next tier when BEGIN on the first tier does not answer within the per-tier timeout', async (t) => {
  mockTime(t);
  const cut = tier('silent');
  const next = tier(() => Promise.resolve({ rows: [], rowCount: 0 }));
  const s = store(cut, next);
  const begun = s.beginBatch();
  await tick(PARAMS.tierTimeoutMs);
  await begun;
  assert.deepEqual(cut.sql, ['BEGIN']);
  assert.deepEqual(next.sql, ['BEGIN', 'SAVEPOINT cockroach_restart']);
  assert.ok(cut.releases[0] instanceof Error, 'the client of the cut tier is discarded');
  assert.deepEqual(s.tiers.events, [{ tier: 0, event: 'timeout' }]);
});

test('should abandon the batch with TierTimeout and count a timeout on its tier when the epoch read does not answer within the per-tier timeout', async (t) => {
  mockTime(t);
  let n = 0;
  const cutAfterBegin = tier(() => (++n <= 2 ? Promise.resolve({ rows: [], rowCount: 0 }) : new Promise<Answer>(() => { /* cut */ })));
  const s = store(cutAfterBegin, tier(renewed));
  const tx = await s.beginBatch();
  const refused = assert.rejects(tx.readFence('k', 0), (e: unknown) => e instanceof TierTimeout && e.tier === 0);
  await tick(PARAMS.tierTimeoutMs);
  await refused;
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

// ---------------- slot groups on PgStore (RFC-006 §4.2, §7.1): one transaction or nothing ----------------

/** One tier whose client answers each statement from `answer` and logs it. */
function scripted(answer: (sql: string) => Answer) {
  const log: string[] = [];
  const t = tier((sql) => { log.push(sql); return Promise.resolve(answer(sql)); });
  return { s: store(t), log };
}

/** The verb of each statement, with the table of an UPDATE (`UPDATE owner_slot`). */
const verbs = (log: string[]): string[] => log.map((sql) => {
  const w = sql.trim().split(/\s+/);
  return w[0] === 'UPDATE' ? `UPDATE ${w[1]}` : (w[0] ?? '');
});

/** UPDATE owner_slot answers one row for the first `rows` member updates, then none. */
function memberRows(rows: number, sessionRows = 1): (sql: string) => Answer {
  let n = 0;
  return (sql) => {
    if (sql.startsWith('UPDATE owner_session')) return { rows: Array.from({ length: sessionRows }, () => ({ session_id: 'old' })), rowCount: sessionRows };
    if (sql.includes('UPDATE owner_slot')) return ++n <= rows ? { rows: [{ epoch: '5' }], rowCount: 1 } : { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
}

const MEMBERS = [{ kind: 'attr_b', slot: 2 }, { kind: 'rating', slot: 2 }];

test('should roll back the group transaction and return undefined when the second member UPDATE of a free group returns no row', async () => {
  const { s, log } = scripted(memberRows(1));
  assert.equal(await s.acquireGroup(MEMBERS, 'sess-new', 'attr_b+rating:2', null), undefined);
  assert.deepEqual(verbs(log), ['BEGIN', 'UPDATE owner_slot', 'UPDATE owner_slot', 'ROLLBACK']);
});

test('should take every member in one committed transaction when each member UPDATE returns a row', async () => {
  const { s, log } = scripted(memberRows(2));
  assert.deepEqual(await s.acquireGroup(MEMBERS, 'sess-new', 'attr_b+rating:2', null), [{ kind: 'attr_b', slot: 2, epoch: 5n }, { kind: 'rating', slot: 2, epoch: 5n }]);
  assert.deepEqual(verbs(log), ['BEGIN', 'UPDATE owner_slot', 'UPDATE owner_slot', 'COMMIT']);
});

test('should update no slot row and return undefined when the old session of a group is neither expired nor revoked', async () => {
  const { s, log } = scripted(memberRows(2, 0));
  assert.equal(await s.acquireGroup(MEMBERS, 'sess-new', 'attr_b+rating:2', { shard: 3, sessionId: 'old' }), undefined);
  assert.deepEqual(verbs(log), ['BEGIN', 'UPDATE owner_session', 'ROLLBACK']);
});

test('should roll back the group re-home and return undefined when the second member UPDATE returns no row', async () => {
  const { s, log } = scripted(memberRows(1));
  assert.equal(await s.rehomeGroup(MEMBERS.map((m) => ({ ...m, epoch: 4n })), 'old', 'sess-new'), undefined);
  assert.deepEqual(verbs(log), ['BEGIN', 'UPDATE owner_slot', 'UPDATE owner_slot', 'ROLLBACK']);
});
