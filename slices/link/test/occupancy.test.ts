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

test('should equal the per-minute array for every query when the tree gets random pulses (seeded)', () => {
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
        const fb = tree.firstAtOrBelow(s, theta);
        let wantB: number | null = null;
        for (let t = s; t < N + 5; t++) if ((v[t] as number) <= theta) { wantB = t; break; }
        assert.equal(fb, wantB, `firstAtOrBelow(${s}, ${theta}) seed ${seed}`);
        const tail = v[N + 4] as number;
        let wantLast: number | 'forever' | null = null;
        if (tail > theta) wantLast = 'forever';
        else for (let t = N + 4; t >= 0; t--) if ((v[t] as number) > theta) { wantLast = t; break; }
        assert.equal(tree.lastAbove(theta), wantLast, `lastAbove(${theta}) seed ${seed}`);
        const keys = tree.entries().map(([k]) => k);
        assert.equal(tree.nextKey(s), keys.find((k) => k > s) ?? null, `nextKey(${s}) seed ${seed}`);
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

test('should undo every impulse since the last commit when the tree rolls back', () => {
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

test('should give the peak of the P1-S01 worked example of RFC-001 §3.2 (7 Mbps at [10:00, 11:00), ask [10:30, 11:30)) when the tree holds it', () => {
  const tree = new OccupancyTree();
  tree.add(600, 660, 7);
  assert.equal(tree.peak(630, 690), 7);
  assert.ok(tree.peak(630, 690) + 3 <= 10);
  assert.ok(tree.peak(630, 690) + 4 > 10);
});

test('should not overlap touching windows (P1-S04) and count an open-ended entry for ever when the tree holds them', () => {
  const tree = new OccupancyTree();
  tree.add(600, 660, 10);
  assert.equal(tree.peak(660, 720), 0);
  assert.equal(tree.peak(540, 600), 0);
  tree.add(1_000, null, 3);
  assert.equal(tree.value(10_000_000), 3);
  assert.equal(tree.peak(2_000, null), 3);
});

test('should give lastAbove "forever" when the value after the last key is above θ, and null when no minute is above θ', () => {
  const tree = new OccupancyTree();
  assert.equal(tree.lastAbove(0), null, 'an empty tree is never above 0');
  tree.add(100, 200, 5);
  assert.equal(tree.lastAbove(4), 199);
  assert.equal(tree.lastAbove(5), null);
  tree.add(150, null, 2);
  assert.equal(tree.lastAbove(1), 'forever');
  assert.equal(tree.lastAbove(2), 199);
  assert.equal(tree.lastAbove(6), 199);
  assert.equal(tree.lastAbove(7), null);
});

test('should count every update in the change counter, and not count a zero pulse, when the tree changes', () => {
  const tree = new OccupancyTree();
  const c0 = tree.changeCounter;
  tree.add(10, 20, 0);
  assert.equal(tree.changeCounter, c0);
  tree.add(10, 20, 3);
  assert.equal(tree.changeCounter, c0 + 2);
  tree.add(30, null, 1);
  assert.equal(tree.changeCounter, c0 + 3);
  tree.commit();
  tree.add(40, 50, 1);
  tree.rollback();
  assert.ok(tree.changeCounter > c0 + 3, 'a rollback is a change too');
});
