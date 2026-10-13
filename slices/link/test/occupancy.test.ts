/**
 * The occupancy tree against a per-minute array (RFC-001 §3.2; T-01 part). The cases of the prior
 * `test/tree.test.ts` are written again here: touching windows, exact fit, A/B peak, open-ended.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OccupancyTree } from '../src/index.ts';
import { int, rng } from './support.ts';

const N = 400;

function brute(tree: OccupancyTree): Int32Array {
  const v = new Int32Array(N + 5);
  let run = 0;
  const imp = new Map(tree.entries());
  for (let t = 0; t < v.length; t++) { run += imp.get(t) ?? 0; v[t] = run; }
  return v;
}

test('tree: random pulses, every query equals the per-minute array (seeded)', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = rng(seed);
    const tree = new OccupancyTree();
    const pulses: Array<[number, number | null, number]> = [];
    for (let step = 0; step < 300; step++) {
      if (pulses.length > 0 && r() < 0.35) {
        const [s, e, b] = pulses.splice(int(r, 0, pulses.length - 1), 1)[0] as [number, number | null, number];
        tree.add(s, e, -b);
      } else {
        const s = int(r, 0, N - 2);
        const e = r() < 0.1 ? null : int(r, s + 1, N);
        const b = int(r, 1, 9);
        tree.add(s, e, b);
        pulses.push([s, e, b]);
      }
      if (step % 10 !== 0) continue;
      const v = brute(tree);
      for (let q = 0; q < 8; q++) {
        const s = int(r, 0, N - 1);
        const e = r() < 0.2 ? null : int(r, s + 1, N + 4);
        let peak = -Infinity;
        for (let t = s; t < (e ?? N + 5); t++) peak = Math.max(peak, v[t] as number);
        assert.equal(tree.peak(s, e), peak, `peak [${s},${e}) seed ${seed}`);
        assert.equal(tree.value(s), v[s]);
        const theta = int(r, 0, 20);
        const fa = tree.firstAbove(s, theta);
        let want: number | null = null;
        for (let t = s; t < N + 5; t++) if ((v[t] as number) > theta) { want = t; break; }
        if (want === null && (v[N + 4] as number) > theta) want = N + 4;
        assert.equal(fa, want, `firstAbove(${s}, ${theta})`);
        const ranges = tree.conflicts(s, e, theta);
        const end = e ?? N + 5;
        for (let t = s; t < end; t++) {
          const inRange = ranges.some((g) => t >= g.start && (g.end === null || t < g.end));
          assert.equal(inRange, (v[t] as number) > theta, `conflicts at ${t}`);
        }
      }
    }
  }
});

test('tree: rollback undoes every impulse since the last commit', () => {
  const tree = new OccupancyTree();
  tree.add(10, 20, 5);
  tree.commit();
  const before = JSON.stringify(tree.entries());
  tree.add(15, 30, 3);
  tree.add(10, 20, -5);
  tree.add(5, null, 1);
  tree.rollback();
  assert.equal(JSON.stringify(tree.entries()), before);
  assert.equal(tree.peak(0, null), 5);
});

test('tree: P1-S01 worked example of RFC-001 §3.2 (7 Mbps at [10:00, 11:00), ask [10:30, 11:30))', () => {
  const tree = new OccupancyTree();
  tree.add(600, 660, 7);
  assert.equal(tree.peak(630, 690), 7);
  assert.ok(tree.peak(630, 690) + 3 <= 10);
  assert.ok(tree.peak(630, 690) + 4 > 10);
});

test('tree: P1-S04 touching windows do not overlap; open-ended counts for ever', () => {
  const tree = new OccupancyTree();
  tree.add(600, 660, 10);
  assert.equal(tree.peak(660, 720), 0);
  assert.equal(tree.peak(540, 600), 0);
  tree.add(1_000, null, 3);
  assert.equal(tree.value(10_000_000), 3);
  assert.equal(tree.peak(2_000, null), 3);
});
