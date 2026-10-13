/**
 * The Webster split of RFC-004 §B3.2: the worked examples as exact cases (P4-S35, P4-S36, P4-S73, P4-S102),
 * the §B2 worked examples that name a split, the parties of a route, and every refusal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMISSION_PARTY, WeightsError, partiesOf, splitShares, websterSplit, type Party } from '../src/index.ts';

const p = (...ws: Array<[string, number]>): Party[] => ws.map(([party, w]) => ({ party, weight: BigInt(w) }));
const split = (n: number, parties: Party[]): number[] => websterSplit(BigInt(n), parties).map(Number);

const R1 = p(['A', 3000], ['B', 3333], ['C', 2167], [COMMISSION_PARTY, 1500]);

test('P4-S35 parties a, b and c with weights 31, 76 and 70 get 6, 13 and 12 of 31 µ (rounding state 5/13/12, one unit added to a)', () => {
  assert.deepEqual(split(31, p(['a', 31], ['b', 76], ['c', 70])), [6, 13, 12]);
});

test('P4-S35 parties a, b and c with weights 31, 76 and 70 get 6, 14 and 12 of 32 µ (rounding state 6/14/13, one unit taken from c)', () => {
  assert.deepEqual(split(32, p(['a', 31], ['b', 76], ['c', 70])), [6, 14, 12]);
});

test('P4-S36 supplier s and Share commission, each weight 1: of 1 µ, s gets 1 and the commission 0 (the commission loses every tie)', () => {
  const parties = partiesOf({ legs: [{ link: 'L1', supplier: 's', weight: 1 }], commissionWeight: 1 });
  assert.deepEqual(parties.map((x) => x.party), ['s', COMMISSION_PARTY]);
  assert.deepEqual(split(1, parties), [1, 0]);
});

for (const [amount, s2, s1, share] of [[1, 1, 0, 0], [2, 1, 1, 0], [3, 1, 1, 1]] as const) {
  test(`P4-S73 first leg s2, second leg s1, commission, each weight 1: ${amount} µ gives s2 ${s2}, s1 ${s1}, commission ${share}`, () => {
    const parties = partiesOf({ legs: [{ link: 'L1', supplier: 's2', weight: 1 }, { link: 'L2', supplier: 's1', weight: 1 }], commissionWeight: 1 });
    assert.deepEqual(parties.map((x) => x.party), ['s2', 's1', COMMISSION_PARTY]);
    assert.deepEqual(split(amount, parties), [s2, s1, share]);
  });
}

for (const [amount, s, t, share] of [[1, 1, 0, 0], [2, 1, 1, 0], [3, 1, 1, 1], [4, 2, 1, 1]] as const) {
  test(`P4-S102 legs s (1), t (2), s (1) and commission (1): ${amount} µ gives s ${s}, t ${t}, commission ${share}; s is one party of weight 2 at leg 1`, () => {
    const parties = partiesOf({
      legs: [{ link: 'L1', supplier: 's', weight: 1 }, { link: 'L2', supplier: 't', weight: 2 }, { link: 'L3', supplier: 's', weight: 1 }],
      commissionWeight: 1,
    });
    assert.deepEqual(parties, p(['s', 2], ['t', 2], [COMMISSION_PARTY, 1]));
    assert.deepEqual(split(amount, parties), [s, t, share]);
  });
}

test('should give the RFC-004 §B2 worked splits for route weights 3000/3333/2167/1500 (the rows that split 100,000,000, 60,000,000, 10,000, 1,500 and 900 µ)', () => {
  assert.deepEqual(split(100_000_000, R1), [30_000_000, 33_330_000, 21_670_000, 15_000_000]);
  assert.deepEqual(split(60_000_000, R1), [18_000_000, 19_998_000, 13_002_000, 9_000_000]);
  assert.deepEqual(split(10_000, R1), [3_000, 3_333, 2_167, 1_500]);
  assert.deepEqual(split(1_500, R1), [450, 500, 325, 225]);
  assert.deepEqual(split(900, R1), [270, 300, 195, 135]);
});

test('should give the RFC-004 §B2 worked splits of 31 µ among 31/76/70 and of 4 µ and 1 µ among 3:1', () => {
  const abc = p(['a', 31], ['b', 76], ['c', 70]);
  assert.deepEqual(split(31, abc), [6, 13, 12]);
  assert.deepEqual(split(4, p(['s', 3], [COMMISSION_PARTY, 1])), [3, 1]);
  assert.deepEqual(split(1, p(['s', 3], [COMMISSION_PARTY, 1])), [1, 0]);
});

test('should give zero to every party when the amount is zero', () => {
  assert.deepEqual(split(0, R1), [0, 0, 0, 0]);
});

test('should name each share with its party when splitShares is used', () => {
  assert.deepEqual(splitShares(10_000n, R1), [
    { party: 'A', amount: 3_000n }, { party: 'B', amount: 3_333n }, { party: 'C', amount: 2_167n }, { party: COMMISSION_PARTY, amount: 1_500n },
  ]);
});

test('should keep a supplier at the position of its first leg and put the commission last when the legs are in any order', () => {
  const parties = partiesOf({
    legs: [{ link: 'L1', supplier: 'z', weight: 5 }, { link: 'L2', supplier: 'a', weight: 7 }, { link: 'L3', supplier: 'z', weight: 2 }],
    commissionWeight: 3,
  });
  assert.deepEqual(parties, p(['z', 7], ['a', 7], [COMMISSION_PARTY, 3]));
});

test('should refuse a negative amount', () => {
  assert.throws(() => websterSplit(-1n, R1), RangeError);
});

test('should refuse a list with no party', () => {
  assert.throws(() => websterSplit(5n, []), RangeError);
});

test('should refuse a party weight that is zero or negative', () => {
  assert.throws(() => websterSplit(5n, p(['a', 0], ['b', 1])), RangeError);
  assert.throws(() => websterSplit(5n, p(['a', -1], ['b', 1])), RangeError);
});

test('should refuse weights that are not positive integers when the parties of a route are made', () => {
  const cases = [
    { legs: [{ link: 'L1', supplier: 's', weight: 0 }], commissionWeight: 1 },
    { legs: [{ link: 'L1', supplier: 's', weight: 1.5 }], commissionWeight: 1 },
    { legs: [{ link: 'L1', supplier: 's', weight: 1 }], commissionWeight: 0 },
    { legs: [{ link: 'L1', supplier: 's', weight: 1 }], commissionWeight: -2 },
    { legs: [], commissionWeight: 1 },
    { legs: [{ link: 'L1', supplier: COMMISSION_PARTY, weight: 1 }], commissionWeight: 1 },
  ];
  for (const w of cases) assert.throws(() => partiesOf(w), WeightsError, JSON.stringify(w));
});
