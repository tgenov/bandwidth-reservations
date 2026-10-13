/**
 * The Webster (Sainte-Laguë) split of RFC-004 §B3.2 (POL-12). It is exact, monotone and deterministic, and it
 * equals the result of giving the units one at a time to the party with the largest w / (2s + 1).
 */
import type { SplitWeights } from './contracts/c06.ts';

/** The party name of Share's commission. It is always the last party (POL-12). */
export const COMMISSION_PARTY = 'commission';

/** One party of a route, in tie order. */
export interface Party { party: string; weight: bigint }

/** Weights that the catalogue must never publish (C06 §2: positive integers). */
export class WeightsError extends Error {}

function positiveWeight(w: number, what: string): bigint {
  if (!Number.isSafeInteger(w) || w <= 0) throw new WeightsError(`${what}: weight ${w} is not a positive integer`);
  return BigInt(w);
}

/**
 * The parties of a route (RFC-004 §B3.2): one for each supplier, with the weights of its legs summed, at the
 * position of its first leg; then Share's commission.
 */
export function partiesOf(w: Pick<SplitWeights, 'legs' | 'commissionWeight'>): Party[] {
  if (w.legs.length === 0) throw new WeightsError('a route has no leg');
  const out: Party[] = [];
  const at = new Map<string, number>();
  for (const leg of w.legs) {
    if (leg.supplier === COMMISSION_PARTY) throw new WeightsError(`supplier name ${COMMISSION_PARTY} is reserved`);
    const weight = positiveWeight(leg.weight, `leg ${leg.link}`);
    const i = at.get(leg.supplier);
    if (i === undefined) {
      at.set(leg.supplier, out.length);
      out.push({ party: leg.supplier, weight });
    } else {
      out[i] = { party: leg.supplier, weight: out[i]!.weight + weight };
    }
  }
  out.push({ party: COMMISSION_PARTY, weight: positiveWeight(w.commissionWeight, 'commission') });
  return out;
}

/**
 * `split(n, parties)` of RFC-004 §B3.2. `n` is a non-negative amount in micro-USD. The result has one share for
 * each party, in the order of `parties`. Comparisons use cross products of bigints, never a division.
 */
export function websterSplit(n: bigint, parties: readonly Party[]): bigint[] {
  if (n < 0n) throw new RangeError(`split of a negative amount ${n}`);
  if (parties.length === 0) throw new RangeError('split among no party');
  let total = 0n;
  for (const p of parties) {
    if (p.weight <= 0n) throw new RangeError(`party ${p.party}: weight ${p.weight} is not positive`);
    total += p.weight;
  }
  // The rounding state: round(n·w/W) with halves up. It is the sequential state for its own sum.
  const s = parties.map((p) => (2n * n * p.weight + total) / (2n * total));
  let given = s.reduce((a, b) => a + b, 0n);
  while (given < n) {
    // Give the next unit to the largest w/(2s+1); a tie goes to the earliest party.
    let best = 0;
    for (let i = 1; i < parties.length; i++) {
      if (parties[i]!.weight * (2n * s[best]! + 1n) > parties[best]!.weight * (2n * s[i]! + 1n)) best = i;
    }
    s[best] = s[best]! + 1n;
    given += 1n;
  }
  while (given > n) {
    // Take back the last unit given: the smallest w/(2s−1) among s > 0; a tie takes from the latest party.
    let worst = -1;
    for (let i = 0; i < parties.length; i++) {
      if (s[i]! === 0n) continue;
      if (worst < 0 || parties[i]!.weight * (2n * s[worst]! - 1n) <= parties[worst]!.weight * (2n * s[i]! - 1n)) worst = i;
    }
    s[worst] = s[worst]! - 1n;
    given -= 1n;
  }
  return s;
}

/** The split with the party name of each share. */
export function splitShares(n: bigint, parties: readonly Party[]): Array<{ party: string; amount: bigint }> {
  return websterSplit(n, parties).map((amount, i) => ({ party: parties[i]!.party, amount }));
}
