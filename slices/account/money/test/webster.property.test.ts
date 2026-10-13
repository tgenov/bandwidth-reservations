/**
 * B13 "Webster property test" (RFC-004 §B13): for random weights and amounts, the split is exact, monotone
 * and deterministic, it equals the one-unit-at-a-time Webster reference, and ties follow the published order.
 * Seeded: a failure names its seed (PROPERTY_SEED=<n> runs it again).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMISSION_PARTY, partiesOf, websterSplit, type Party } from '../src/index.ts';
import { int, rng, seedNote, seeds } from './support.ts';

/**
 * The reference: give the n units one at a time, each to the party with the largest w / (2s + 1); a tie goes
 * to the party that is first in tie order. Exact rational comparison (cross products).
 */
function oneAtATime(n: bigint, parties: readonly Party[]): bigint[] {
  const s = parties.map(() => 0n);
  for (let u = 0n; u < n; u++) {
    let best = 0;
    for (let i = 1; i < parties.length; i++) {
      const wi = parties[i]!.weight;
      const wb = parties[best]!.weight;
      if (wi * (2n * s[best]! + 1n) > wb * (2n * s[i]! + 1n)) best = i;
    }
    s[best] = s[best]! + 1n;
  }
  return s;
}

const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

/** Random parties. Small weights make ties frequent; large weights test the 128-bit comparisons. */
function randomParties(r: () => number): Party[] {
  const count = int(r, 1, 7);
  const big = r() < 0.2;
  return Array.from({ length: count }, (_, i) => ({
    party: i === count - 1 ? COMMISSION_PARTY : `s${i}`,
    weight: big ? BigInt(int(r, 1, 2_000_000_000)) * BigInt(int(r, 1, 2_000_000_000)) : BigInt(int(r, 1, r() < 0.5 ? 3 : 10_000)),
  }));
}

const R1: Party[] = [
  { party: 'A', weight: 3000n }, { party: 'B', weight: 3333n }, { party: 'C', weight: 2167n }, { party: COMMISSION_PARTY, weight: 1500n },
];

test('B13: Webster property test: the split equals the one-unit-at-a-time Webster reference, for random weights and amounts', () => {
  for (const seed of seeds(400)) {
    const r = rng(seed);
    for (let k = 0; k < 10; k++) {
      const parties = randomParties(r);
      const n = BigInt(int(r, 0, r() < 0.7 ? 60 : 3_000));
      assert.deepEqual(websterSplit(n, parties), oneAtATime(n, parties), `${seedNote(seed)}: n ${n}, weights ${parties.map((x) => x.weight).join('/')}`);
    }
  }
});

test('B13: Webster property test: split(n + 1) is split(n) plus one unit, for random weights and amounts up to 400', () => {
  for (const seed of seeds(60, 1_000)) {
    const r = rng(seed);
    const parties = randomParties(r);
    let prev = websterSplit(0n, parties);
    for (let n = 1n; n <= 400n; n++) {
      const next = websterSplit(n, parties);
      const diff = next.map((x, i) => x - prev[i]!);
      assert.ok(diff.every((d) => d === 0n || d === 1n) && sum(diff) === 1n, `${seedNote(seed)}: n ${n} ${prev.join('/')} → ${next.join('/')}`);
      prev = next;
    }
  }
});

test('B13: Webster property test: equal weights get the units in the published tie order, the commission last', () => {
  for (const seed of seeds(100, 2_000)) {
    const r = rng(seed);
    const w = BigInt(int(r, 1, 9));
    const count = int(r, 2, 6);
    const parties = Array.from({ length: count }, (_, i) => ({ party: i === count - 1 ? COMMISSION_PARTY : `s${i}`, weight: w }));
    const n = BigInt(int(r, 0, 40));
    const shares = websterSplit(n, parties);
    const base = n / BigInt(count);
    const extra = Number(n % BigInt(count));
    assert.deepEqual(shares, parties.map((_, i) => base + (i < extra ? 1n : 0n)), `${seedNote(seed)}: n ${n}, ${count} parties of weight ${w}`);
  }
});

test('B13: Webster property test: legs of one supplier form one party at its first leg, for random routes', () => {
  for (const seed of seeds(200, 3_000)) {
    const r = rng(seed);
    const suppliers = ['x', 'y', 'z'];
    const legs = Array.from({ length: int(r, 1, 6) }, (_, i) => ({ link: `L${i}`, supplier: suppliers[int(r, 0, 2)]!, weight: int(r, 1, 5) }));
    const commissionWeight = int(r, 1, 5);
    const parties = partiesOf({ legs, commissionWeight });
    const order = [...new Set(legs.map((l) => l.supplier))];
    assert.deepEqual(parties.map((x) => x.party), [...order, COMMISSION_PARTY], seedNote(seed));
    for (const x of parties.slice(0, -1)) {
      assert.equal(x.weight, BigInt(legs.filter((l) => l.supplier === x.party).reduce((a, l) => a + l.weight, 0)), seedNote(seed));
    }
    assert.equal(parties.at(-1)!.weight, BigInt(commissionWeight), seedNote(seed));
  }
});

test('P4-S32 shares add up exactly to the charge, for any whole number of micro-USD split among the parties of R1', () => {
  for (const seed of seeds(200, 4_000)) {
    const r = rng(seed);
    for (let k = 0; k < 25; k++) {
      const n = r() < 0.5 ? BigInt(int(r, 0, 100_000)) : BigInt(int(r, 0, 2_000_000_000)) * BigInt(int(r, 1, 4_000_000));
      assert.equal(sum(websterSplit(n, R1)), n, `${seedNote(seed)}: n ${n}`);
    }
  }
});

test('P4-S32 shares add up exactly to the charge, for random weights and amounts', () => {
  for (const seed of seeds(200, 5_000)) {
    const r = rng(seed);
    for (let k = 0; k < 25; k++) {
      const parties = randomParties(r);
      const n = BigInt(int(r, 0, 2_000_000_000)) * BigInt(int(r, 1, 1_000));
      const s = websterSplit(n, parties);
      assert.equal(sum(s), n, `${seedNote(seed)}: n ${n}`);
      assert.ok(s.every((x) => x >= 0n), seedNote(seed));
    }
  }
});

test('P4-S33 a larger charge never lowers any party\'s share among the parties of R1', () => {
  for (const seed of seeds(200, 6_000)) {
    const r = rng(seed);
    for (let k = 0; k < 25; k++) {
      const a = BigInt(int(r, 0, 50_000_000));
      const b = a + BigInt(int(r, 1, r() < 0.5 ? 3 : 5_000_000));
      const sa = websterSplit(a, R1);
      const sb = websterSplit(b, R1);
      assert.ok(sb.every((x, i) => x >= sa[i]!), `${seedNote(seed)}: split(${a}) ${sa.join('/')} vs split(${b}) ${sb.join('/')}`);
    }
  }
});

test('P4-S34 the split depends only on the amount and the weights: the same inputs in any order of calls give the same shares', () => {
  for (const seed of seeds(50, 7_000)) {
    const r = rng(seed);
    const cases = Array.from({ length: 30 }, () => ({ parties: randomParties(r), n: BigInt(int(r, 0, 1_000_000)) }));
    const first = cases.map((c) => websterSplit(c.n, c.parties));
    const order = cases.map((_, i) => i).sort(() => r() - 0.5);
    for (const i of order) {
      const c = cases[i]!;
      const copy = c.parties.map((x) => ({ ...x }));
      assert.deepEqual(websterSplit(c.n, copy), first[i], seedNote(seed));
    }
  }
});
