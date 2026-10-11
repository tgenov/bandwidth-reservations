import { split, Party } from '../src/domain/split';
import { chargeMicros } from '../src/domain/money';
import { rng } from './harness';

const parties: Party[] = [
  { account: 'supplier:A', weight: 3000 },
  { account: 'supplier:B', weight: 3333 },
  { account: 'supplier:C', weight: 2167 },
  { account: 'revenue:share', weight: 1500 },
];

const sum = (m: Map<string, bigint>) => [...m.values()].reduce((s, x) => s + x, 0n);

// Largest remainder, the method the brief suggested, kept here to show why it was rejected.
function largestRemainder(amount: bigint, ps: Party[]) {
  const W = BigInt(ps.reduce((s, p) => s + p.weight, 0));
  const base = ps.map((p) => (amount * BigInt(p.weight)) / W);
  const rem = ps.map((p, i) => amount * BigInt(p.weight) - base[i] * W);
  let left = amount - base.reduce((s, x) => s + x, 0n);
  const order = ps.map((_, i) => i).sort((i, j) => (rem[j] > rem[i] ? 1 : rem[j] < rem[i] ? -1 : i - j));
  for (const i of order) if (left-- > 0n) base[i] += 1n;
  return new Map(ps.map((p, i) => [p.account, base[i]]));
}

describe('split (D20)', () => {
  test('shares always sum exactly to the amount', () => {
    const r = rng(1);
    for (let i = 0; i < 5000; i++) {
      const amount = BigInt(Math.floor(r() * 1e9));
      expect(sum(split(amount, parties))).toBe(amount);
    }
  });

  test('each share is within one unit of its exact proportion', () => {
    const r = rng(2);
    for (let i = 0; i < 2000; i++) {
      const amount = BigInt(Math.floor(r() * 1e7));
      const s = split(amount, parties);
      for (const p of parties) {
        const exact = (Number(amount) * p.weight) / 10_000;
        expect(Math.abs(Number(s.get(p.account)) - exact)).toBeLessThan(parties.length);
      }
    }
  });

  test('house-monotone: a larger amount never lowers any share', () => {
    for (let amount = 0n; amount < 20_000n; amount++) {
      const now = split(amount, parties);
      const next = split(amount + 1n, parties);
      for (const p of parties) expect(next.get(p.account)! >= now.get(p.account)!).toBe(true);
    }
  });

  test('largest remainder is NOT monotone (the Alabama paradox), which is why it was rejected', () => {
    // Found by search: raising the amount from 31 to 32 takes a unit away from 'a'.
    const ps: Party[] = [
      { account: 'a', weight: 31 }, { account: 'b', weight: 76 }, { account: 'c', weight: 70 },
    ];
    expect(largestRemainder(31n, ps).get('a')).toBe(6n);
    expect(largestRemainder(32n, ps).get('a')).toBe(5n);
    // D'Hondt on the same weights never takes anything away.
    for (let amount = 0n; amount < 500n; amount++) {
      for (const p of ps) {
        expect(split(amount + 1n, ps).get(p.account)! >= split(amount, ps).get(p.account)!).toBe(true);
      }
    }
  });

  test('charge rounds half up to the nearest micro', () => {
    expect(chargeMicros(500_000_000n, 1n)).toBe(1n); // exactly half a micro
    expect(chargeMicros(499_999_999n, 1n)).toBe(0n);
    expect(chargeMicros(15_000_000_000n, 10_000n)).toBe(150_000n); // 15 GB at 0.01/GB
  });
});
