/** The deviation report of RFC-004 §B3.5 (P4-S37): each party's signed total deviation from exact proportions in a payout period. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviationReport, weekOf, type MovementPosted, type PartyDeviation } from '../src/index.ts';
import { TOPIC } from '../src/index.ts';
import { MINUTE_0, chargeLine, reservationBatch, reservationLine, usageBatch, usageRef, weightsFixture } from '../testing/index.ts';
import { int, rng, seedNote, seeds } from './support.ts';
import { refSplit, usageWorld } from './support-usage.ts';

const W = weightsFixture();
const fraction = (d: PartyDeviation): [string, string] => [d.party, `${d.numerator}/${d.denominator}`];

test('P4-S37 each party is shown, for the payout period, the signed total by which its shares differ from its exact proportions', async () => {
  const w = await usageWorld();
  const b = reservationBatch('rating-1:0:1:0', 'b1', MINUTE_0, [
    reservationLine('b1', 'r-1', MINUTE_0, 1_500n), reservationLine('b1', 'r-2', MINUTE_0, 7n, { route: 'R2', weightsVersion: 'w2' }),
  ]);
  for (let i = 0; i < 3; i++) await w.settle(structuredClone(b));
  const period = weekOf(w.events<MovementPosted>(TOPIC.movements)[0]!.event.postingTime);
  // R1 1,500 = 450/500/325/225 of weights 3000/3333/2167/1500: B +500/10000, C −500/10000. R2 7 = 3/2/2 of 1/1/1: A +2/3, D −1/3, commission −1/3.
  assert.deepEqual(deviationReport(w.settlement.deviation.periodTotals(period)).map(fraction),
    [['A', '2/3'], ['B', '1/20'], ['C', '-1/20'], ['D', '-1/3'], ['commission', '-1/3']]);
  assert.deepEqual(w.settlement.deviation.periodTotals('2026-01-05'), [], 'another period has no deviation');
});

test('P4-S37 a cost line counts only the suppliers it pays; Share\'s commission share is not posted, so it has no deviation from it', async () => {
  const w = await usageWorld();
  await w.settle(usageBatch('rating-1:0:2:0', 'b1', [chargeLine('b1', { kind: 'carried_excess', account: 'b1', product: 'p', route: 'R2', minute: MINUTE_0, seq: 0 },
    'carried_excess', 0n, 7n, { route: 'R2', weightsVersion: 'w2', product: 'p' })]));
  const period = weekOf(w.events<MovementPosted>(TOPIC.movements)[0]!.event.postingTime);
  assert.deepEqual(deviationReport(w.settlement.deviation.periodTotals(period)).map(fraction), [['A', '2/3'], ['D', '-1/3']]);
});

test('should give the UTC Monday of the week of a posting time as its payout period', () => {
  assert.equal(weekOf(`${BigInt(Date.UTC(2026, 9, 12, 9, 0)) * 1_000_000n}.0000000000`), '2026-10-12');
  assert.equal(weekOf(`${BigInt(Date.UTC(2026, 9, 18, 23, 59)) * 1_000_000n}.0000000003`), '2026-10-12');
  assert.equal(weekOf(`${BigInt(Date.UTC(2026, 9, 19, 0, 0)) * 1_000_000n}.0000000000`), '2026-10-19');
});

test('P4-S37 the reported deviation of each party equals Σ (split(T)_i − T·w_i / W) over the final totals of the lines, for random originals and late traffic', async () => {
  const routes: Array<[string, string]> = [['R1', 'w1'], ['R2', 'w2'], ['RP', 'wp'], ['R3', 'w3']];
  for (const seed of seeds(15, 701)) {
    const r = rng(seed);
    const w = await usageWorld();
    const finals: Array<[string, string, bigint]> = [];
    let n = 0;
    for (let i = 0; i < int(r, 1, 6); i++) {
      const [route, wv] = routes[int(r, 0, routes.length - 1)]!;
      const ref = usageRef('b1', route, new Date(Date.UTC(2026, 9, 12, 9, i)).toISOString().replace('.000Z', 'Z'));
      let total = BigInt(int(r, 1, 5_000));
      await w.settle(usageBatch(`rating-1:0:${seed}-${n++}:0`, 'b1', [chargeLine('b1', ref, 'usage', 0n, total, { route, weightsVersion: wv })]));
      for (let seq = 1; seq <= int(r, 0, 3); seq++) {
        const next = total + BigInt(int(r, 1, 2_000));
        await w.settle(usageBatch(`rating-1:0:${seed}-${n++}:0`, 'b1', [chargeLine('b1', { ...ref, seq }, 'usage', total, next, { route, weightsVersion: wv })]));
        total = next;
      }
      finals.push([route, wv, total]);
    }
    // The oracle: an exact rational per party, num/den, from the one-unit-at-a-time split of each final total.
    const want = new Map<string, { num: bigint; den: bigint }>();
    for (const [route, wv, T] of finals) {
      const weights = W.find(route, wv)!;
      const sum = BigInt(weights.commissionWeight) + weights.legs.reduce((a, l) => a + BigInt(l.weight), 0n);
      for (const [p, s] of refSplit(T, weights)) {
        const wi = p === 'commission' ? BigInt(weights.commissionWeight) : weights.legs.filter((l) => l.supplier === p).reduce((a, l) => a + BigInt(l.weight), 0n);
        const cur = want.get(p) ?? { num: 0n, den: 1n };
        want.set(p, { num: cur.num * sum + (s * sum - T * wi) * cur.den, den: cur.den * sum });
      }
    }
    const period = weekOf(w.events<MovementPosted>(TOPIC.movements)[0]!.event.postingTime);
    const got = deviationReport(w.settlement.deviation.periodTotals(period));
    assert.deepEqual(got.map((d) => d.party).sort(), [...want.keys()].sort(), seedNote(seed));
    for (const d of got) {
      const x = want.get(d.party)!;
      assert.equal(d.numerator * x.den, x.num * d.denominator, `${seedNote(seed)}: ${d.party} ${d.numerator}/${d.denominator} ≠ ${x.num}/${x.den}`);
      assert.ok(d.denominator > 0n, seedNote(seed));
    }
  }
});
