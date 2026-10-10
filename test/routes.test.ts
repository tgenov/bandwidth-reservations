import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { LinkBook } from '../src/links.ts';
import { PartnerLink, type PartnerConfirm } from '../src/partner.ts';
import { Coordinator, recover, resetRoutesSchema, type RouteRequest, type RouteResult } from '../src/routes.ts';
import { maxUsage } from '../src/sql.ts';
import { rng, percentile } from './helpers.ts';

const ADMIN_URL = 'postgres://postgres:postgres@localhost:55432/bw';
const P2_URL = process.env.P2_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/p2';

const N = 7 * 24 * 60; // one week of minutes
const CAPACITY = 10;
const PARTNER = 1;
const OWN = [2, 3, 4, 5, 6];
const LINKS = [PARTNER, ...OWN];

let db: pg.Pool;

before(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'p2'");
  if (exists.rowCount === 0) await admin.query('CREATE DATABASE p2');
  await admin.end();
  db = new pg.Pool({ connectionString: P2_URL, max: 40 });
});

after(async () => {
  await db.end();
});

type World = { coord: Coordinator; partner: PartnerLink; random: () => number };

const OPTS = { holdTtlMs: 1500, deadlineMs: 20_000 };
const FAULTS = { failRate: 0.1, timeoutRate: 0.1, maxLatencyMs: 15 };

async function world(seed: number, extra: Partial<Parameters<typeof recover>[3]> = {}): Promise<World> {
  await resetRoutesSchema(db);
  for (const id of LINKS) await db.query('INSERT INTO links (id, capacity_mbps) VALUES ($1, $2)', [id, CAPACITY]);
  const random = rng(seed);
  const partner = new PartnerLink(PARTNER, CAPACITY, N, rng(seed + 1000), FAULTS);
  const books = OWN.map((id) => new LinkBook(id, CAPACITY, N));
  const coord = new Coordinator(db, books, partner, { ...OPTS, random, ...extra });
  return { coord, partner, random };
}

const allBooks = (w: World) => [...w.coord.books.values(), w.partner.book];

async function factsWithinCapacity(): Promise<void> {
  for (const id of LINKS) assert.ok((await maxUsage(db, id)) <= CAPACITY, `facts oversell link ${id}`);
}

test('a route across our links and the partner is confirmed; every leg becomes a fact', async () => {
  const w = await world(1);
  const r = await w.coord.reserve({ idemKey: 'k1', links: [PARTNER, 2, 3], s: 0, e: 600, mbps: 4 });
  assert.equal(r.status, 'confirmed');
  const facts = await db.query('SELECT link_id FROM reservations ORDER BY link_id');
  assert.deepEqual(facts.rows.map((f) => Number(f.link_id)), [1, 2, 3]);
  for (const b of allBooks(w)) assert.equal(b.holds.size, 0, 'no holds left behind');
  assert.equal(w.coord.books.get(2)!.confirmed.peak(0, 600), 4);
  assert.equal(w.partner.book.confirmed.peak(0, 600), 4);
});

test('a leg that cannot fit rejects the route, names the link, and releases every hold', async () => {
  const w = await world(2);
  assert.equal((await w.coord.reserve({ idemKey: 'a', links: [3], s: 0, e: 600, mbps: 8 })).status, 'confirmed');
  const r = await w.coord.reserve({ idemKey: 'b', links: [PARTNER, 2, 3], s: 300, e: 900, mbps: 5 });
  assert.deepEqual(r, { status: 'rejected', sagaId: (r as any).sagaId, linkId: 3, conflicts: [[300, 600]] });
  for (const b of allBooks(w)) assert.equal(b.holds.size, 0);
  assert.equal(w.partner.book.total.peak(0, N), 0, 'the partner hold was compensated');
});

for (const seed of [11, 12, 13]) {
  test(`randomised contention (seed ${seed}): never oversold, competitors never all lose, all sagas finish`, async () => {
    const w = await world(seed);
    const r = w.random;
    const requests: RouteRequest[] = Array.from({ length: 60 }, (_, i) => {
      const own = OWN.filter(() => r() < 0.5);
      const links = [...(r() < 0.5 ? [PARTNER] : []), ...(own.length ? own : [OWN[i % OWN.length]])];
      const s = Math.floor(r() * 600);
      return { idemKey: `s${seed}-${i}`, links, s, e: s + 30 + Math.floor(r() * 270), mbps: 1 + Math.floor(r() * 5) };
    });

    // Sample the invariant while sagas run: confirmed + held never exceeds capacity.
    let worst = 0;
    const sampler = setInterval(() => {
      for (const b of allBooks(w)) worst = Math.max(worst, b.peakUsage());
    }, 1);

    const started = Date.now();
    const timings: number[] = [];
    const results: RouteResult[] = await Promise.all(
      requests.map(async (q) => {
        const t0 = performance.now();
        const res = await w.coord.reserve(q);
        timings.push(performance.now() - t0);
        return res;
      }),
    );
    clearInterval(sampler);

    assert.ok(worst <= CAPACITY, `oversold in memory: ${worst}`);
    await factsWithinCapacity();

    // All terminate with a definite answer: no deadlock, no deadline failures.
    const counts: Record<string, number> = {};
    for (const x of results) counts[x.status] = (counts[x.status] ?? 0) + 1;
    assert.equal((counts.confirmed ?? 0) + (counts.rejected ?? 0), requests.length, JSON.stringify(counts));

    // D16: nobody is turned away from capacity that is in fact free. Confirmed
    // reservations only grow, so a rejected request must still not fit at the end.
    const book = (id: number) => (id === PARTNER ? w.partner.book : w.coord.books.get(id)!);
    results.forEach((x, i) => {
      if (x.status !== 'rejected') return;
      const q = requests[i];
      const fitsEverywhere = q.links.every((l) => book(l).confirmed.peak(q.s, q.e!) + q.mbps <= CAPACITY);
      assert.ok(!fitsEverywhere, `lost opportunity: ${q.idemKey} rejected but fits now`);
    });

    // In-memory confirmed state agrees with the facts in Postgres.
    for (const id of LINKS) {
      assert.equal(Math.max(0, book(id).confirmed.peak(0, N)), await maxUsage(db, id), `link ${id} drifted from facts`);
      assert.equal(book(id).holds.size, 0, `holds left on link ${id}`);
    }

    // No starvation: restarts are bounded by the number of older competitors.
    const restarts = results.filter((x) => x.status === 'confirmed').map((x: any) => x.restarts);
    const maxRestarts = Math.max(0, ...restarts);
    assert.ok(maxRestarts < requests.length, `max restarts ${maxRestarts}`);
    assert.ok(w.coord.stats.waits > 0 && w.coord.stats.wounds > 0, 'contention exercised waits and wounds');
    const dbRestarts = await db.query('SELECT max(restarts)::int AS m, sum(restarts)::int AS s FROM sagas');

    console.log(
      `seed ${seed}: ${JSON.stringify(counts)} in ${Date.now() - started} ms; ` +
        `saga p50 ${percentile(timings, 50).toFixed(1)} ms, p99 ${percentile(timings, 99).toFixed(1)} ms; ` +
        `restarts max ${dbRestarts.rows[0].m}, total ${dbRestarts.rows[0].s}; ` +
        `waits ${w.coord.stats.waits}, wounds ${w.coord.stats.wounds}; partner calls ${w.partner.calls}`,
    );
  });
}

test('coordinator crash before the commit decision: holds expire and capacity comes back', async () => {
  const w = await world(21, { crashAt: 'after-first-hold', holdTtlMs: 300 });
  const r = await w.coord.reserve({ idemKey: 'c1', links: [PARTNER, 2, 3], s: 0, e: 600, mbps: 10 });
  assert.equal(r.status, 'crashed');

  const coord = await recover(db, w.partner, N, { ...OPTS, holdTtlMs: 300, random: w.random });
  const saga = await db.query("SELECT status FROM sagas WHERE idem_key = 'c1'");
  assert.equal(saga.rows[0].status, 'failed');
  assert.ok(w.partner.book.total.peak(0, 600) > 0, 'the abandoned partner hold is still there until it expires');

  await new Promise((res) => setTimeout(res, 350));
  const again = await coord.reserve({ idemKey: 'c2', links: [PARTNER, 2, 3], s: 0, e: 600, mbps: 10 });
  assert.equal(again.status, 'confirmed', 'full capacity is available again after expiry');
  await factsWithinCapacity();
});

test('coordinator crash after the commit decision: recovery rolls forward', async () => {
  const w = await world(22, { crashAt: 'after-commit-decision' });
  const r = await w.coord.reserve({ idemKey: 'c3', links: [PARTNER, 2, 3], s: 0, e: 600, mbps: 7 });
  assert.equal(r.status, 'crashed');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM reservations')).rows[0].n, 0);

  const coord = await recover(db, w.partner, N, { ...OPTS, random: w.random });
  const saga = await db.query("SELECT status FROM sagas WHERE idem_key = 'c3'");
  assert.equal(saga.rows[0].status, 'confirmed');
  const facts = await db.query('SELECT link_id FROM reservations ORDER BY link_id');
  assert.deepEqual(facts.rows.map((f) => Number(f.link_id)), [1, 2, 3]);
  assert.equal(coord.books.get(2)!.confirmed.peak(0, 600), 7);
  assert.equal(w.partner.book.confirmed.peak(0, 600), 7);
  assert.equal(coord.books.get(2)!.holds.size, 0);

  // The recovered coordinator sees the confirmed capacity.
  const more = await coord.reserve({ idemKey: 'c4', links: [2], s: 0, e: 600, mbps: 4 });
  assert.equal(more.status, 'rejected');
});

test('idempotency: retries with the same key never book twice', async () => {
  const w = await world(31);
  const q = { idemKey: 'same', links: [PARTNER, 4], s: 0, e: 120, mbps: 3 };
  const [a, b] = await Promise.all([w.coord.reserve(q), w.coord.reserve(q)]);
  assert.deepEqual(a, b);
  assert.equal(a.status, 'confirmed');

  // A later retry, e.g. after a client timeout, from a fresh coordinator.
  const fresh = await recover(db, w.partner, N, { ...OPTS, random: w.random });
  assert.deepEqual(await fresh.reserve(q), a);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM reservations')).rows[0].n, 2, 'one fact per leg');
  assert.equal(w.partner.book.confirmed.peak(0, 120), 3);

  await assert.rejects(fresh.reserve({ ...q, mbps: 4 }), /reused for a different request/);
  await assert.rejects(w.coord.reserve({ ...q, mbps: 4 }), /reused for a different request/);
});

// Two sagas that order the same two links in opposite directions. Existing
// reservations make link 2 the busier one for A's window and link 3 the busier
// one for B's, so A holds 2 then wants 3 while B holds 3 then wants 2.
async function crossedSagas(woundWait: boolean) {
  await resetRoutesSchema(db);
  for (const id of LINKS) await db.query('INSERT INTO links (id, capacity_mbps) VALUES ($1, $2)', [id, CAPACITY]);
  const books = OWN.map((id) => new LinkBook(id, CAPACITY, N, { woundWait }));
  const partner = new PartnerLink(PARTNER, CAPACITY, N, rng(1), FAULTS);
  // Barrier: both sagas choose their link order before either takes a hold.
  let ready = 0;
  let release!: () => void;
  const bothOrdered = new Promise<void>((r) => (release = r));
  const beforeHold = async (_saga: number, index: number) => {
    if (index !== 0 || ready >= 2) return;
    if (++ready === 2) release();
    await bothOrdered;
  };
  const coord = new Coordinator(db, books, partner, { holdTtlMs: 1000, deadlineMs: 20_000, random: rng(2), beforeHold });
  coord.books.get(2)!.addConfirmed(0, 50, 4);
  coord.books.get(3)!.addConfirmed(100, 150, 4);
  const t0 = Date.now();
  const [a, b] = await Promise.all([
    coord.reserve({ idemKey: 'A', links: [2, 3], s: 0, e: 100, mbps: 6 }),
    coord.reserve({ idemKey: 'B', links: [2, 3], s: 50, e: 150, mbps: 6 }),
  ]);
  return { a, b, elapsed: Date.now() - t0, coord };
}

test('crossed sagas: priority tickets resolve the deadlock at once (D17)', async () => {
  const { a, b, elapsed, coord } = await crossedSagas(true);
  assert.equal(a.status, 'confirmed', 'the older saga wins');
  assert.equal(b.status, 'rejected', 'the younger restarts and finds the capacity truly gone');
  assert.ok(coord.stats.wounds >= 1);
  assert.ok(elapsed < 500, `took ${elapsed} ms`);
  console.log(`crossed sagas with tickets: ${elapsed} ms, wounds ${coord.stats.wounds}`);
});

test('crossed sagas without tickets: deadlocked until the holds expire', async () => {
  const { a, b, elapsed, coord } = await crossedSagas(false);
  assert.ok(elapsed >= 1000, `took ${elapsed} ms: expected to wait out the 1000 ms hold TTL`);
  assert.equal(coord.stats.wounds, 0);
  console.log(`crossed sagas without tickets: ${elapsed} ms, results ${a.status}/${b.status}, restarts ${coord.stats.restarts}`);
});

// A partner whose first confirm finds the hold gone, as if it had expired just
// before we confirmed. Later confirms behave normally.
class ExpiringPartner extends PartnerLink {
  expiredOnce = false;
  async confirm(key: string): Promise<PartnerConfirm> {
    if (!this.expiredOnce) {
      this.expiredOnce = true;
      this.book.release(key);
      return 'unknown-hold';
    }
    return super.confirm(key);
  }
}

const NO_FAULTS = { failRate: 0, timeoutRate: 0, maxLatencyMs: 1 };

// Links [PARTNER, 2, 3]: attempt 1 calls beforeHold for indexes 0, 1, 2, then the
// partner reports 'unknown-hold' after the commit decision and the saga restarts.
// Attempt 2 calls index 0 (the partner is held again), then index 1: crash there,
// before any of our links is held again.
async function crashWhileReholding() {
  await resetRoutesSchema(db);
  for (const id of LINKS) await db.query('INSERT INTO links (id, capacity_mbps) VALUES ($1, $2)', [id, CAPACITY]);
  const partner = new ExpiringPartner(PARTNER, CAPACITY, N, rng(41), NO_FAULTS);
  const books = OWN.map((id) => new LinkBook(id, CAPACITY, N));
  let calls = 0;
  let coord!: Coordinator;
  const beforeHold = async () => {
    if (++calls === 5) coord.crash();
  };
  coord = new Coordinator(db, books, partner, { ...OPTS, random: rng(42), beforeHold });
  const r = await coord.reserve({ idemKey: 'pc1', links: [PARTNER, 2, 3], s: 0, e: 600, mbps: 6 });
  assert.equal(r.status, 'crashed');
  assert.equal(calls, 5, 'crashed during the second attempt');
  assert.equal(coord.stats.restarts, 1, 'restarted once, after the commit decision');
  return partner;
}

const factLinks = async () =>
  (await db.query('SELECT link_id FROM reservations ORDER BY link_id')).rows.map((f) => Number(f.link_id));

test('crash while re-holding after a post-commit restart: the saga fails and nothing is booked', async () => {
  const partner = await crashWhileReholding();
  const coord = await recover(db, partner, N, { ...OPTS, random: rng(43) });
  assert.deepEqual(await factLinks(), [], 'no leg is booked without a hold');
  const saga = await db.query("SELECT status FROM sagas WHERE idem_key = 'pc1'");
  assert.equal(saga.rows[0].status, 'failed');
  for (const id of [2, 3]) assert.equal(coord.books.get(id)!.total.peak(0, N), 0, `link ${id} is free`);
});

test('recovery refuses to roll forward a committing saga whose holds are incomplete', async () => {
  const partner = await crashWhileReholding();
  // Defence in depth: force the inconsistent state the old bug produced.
  await db.query("UPDATE sagas SET status = 'committing' WHERE idem_key = 'pc1'");
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    await recover(db, partner, N, { ...OPTS, random: rng(44) });
  } finally {
    console.error = original;
  }
  assert.deepEqual(await factLinks(), [], 'no partial facts');
  const saga = await db.query("SELECT status, result FROM sagas WHERE idem_key = 'pc1'");
  assert.equal(saga.rows[0].status, 'failed');
  assert.match(saga.rows[0].result.reason, /missing holds/);
  assert.equal(errors.length, 1, 'the inconsistency is reported loudly');
  assert.equal(partner.book.total.peak(0, N), 0, 'the orphaned partner hold is released');
});

test('routes outside the horizon are refused before any saga starts', async () => {
  const w = await world(51);
  await assert.rejects(w.coord.reserve({ idemKey: 'far', links: [2], s: N, e: N + 60, mbps: 1 }), RangeError);
  await assert.rejects(w.coord.reserve({ idemKey: 'far2', links: [2], s: N - 10, e: N + 10, mbps: 1 }), RangeError);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sagas')).rows[0].n, 0);
});
