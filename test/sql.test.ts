import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { UsageTree } from '../src/tree.ts';
import { admit, createLink, maxUsage, pool, resetSchema } from '../src/sql.ts';
import { ArrayOracle, at, rng } from './helpers.ts';

const db = pool();
before(() => resetSchema(db));
after(() => db.end());

test('SQL: touching intervals and the A/B example', async () => {
  await createLink(db, 1, 10);
  const r = (s: number, e: number | null, mbps: number) =>
    admit(db, { linkId: 1, start: at(s), end: e === null ? null : at(e), mbps });

  assert.deepEqual(await r(0, 60, 10), { ok: true });
  assert.deepEqual(await r(60, 120, 10), { ok: true }); // [0,60) and [60,120) touch
  assert.equal((await r(59, 61, 1)).ok, false);

  const h = (x: number) => 1000 + x; // fresh window
  assert.ok((await r(h(0), h(30), 8)).ok); // A
  assert.ok((await r(h(60), h(120), 8)).ok); // B
  assert.ok((await r(h(0), h(120), 2)).ok); // peak is 8, not 16
  assert.deepEqual(await r(h(10), h(20), 1), { ok: false, peak: 10 });

  assert.ok((await r(5000, null, 4)).ok); // open-ended
  assert.equal((await r(9000, 9001, 7)).ok, false);
  assert.ok((await r(9000, 9001, 6)).ok);
  assert.equal(await maxUsage(db, 1), 10);
});

test('property: tree, SQL and brute-force array agree on every decision', async () => {
  const N = 240;
  const CAPACITY = 50;
  for (let seed = 1; seed <= 8; seed++) {
    const linkId = 100 + seed;
    await createLink(db, linkId, CAPACITY);
    const rand = rng(seed);
    const tree = new UsageTree(N);
    const oracle = new ArrayOracle(N);
    let admitted = 0;
    for (let i = 0; i < 150; i++) {
      const s = Math.floor(rand() * N);
      const openEnded = rand() < 0.05;
      const e = openEnded ? null : s + 1 + Math.floor(rand() * Math.min(60, N - s));
      const mbps = 1 + Math.floor(rand() * 20);
      const expected = oracle.admit(s, e, mbps, CAPACITY);
      const fromTree = tree.admit(s, e, mbps, CAPACITY).ok;
      const fromSql = (await admit(db, { linkId, start: at(s), end: e === null ? null : at(e), mbps })).ok;
      const where = `seed ${seed} step ${i}: [${s}, ${e}) ${mbps} Mbps`;
      assert.equal(fromTree, expected, `tree vs oracle, ${where}`);
      assert.equal(fromSql, expected, `SQL vs oracle, ${where}`);
      if (expected) admitted++;
    }
    assert.ok(admitted > 10 && admitted < 150, `seed ${seed} should mix accepts and rejects (${admitted})`);
    assert.ok((await maxUsage(db, linkId)) <= CAPACITY);
  }
});
