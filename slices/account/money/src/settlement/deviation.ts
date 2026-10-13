/**
 * The deviation report of RFC-004 §B3.5 (P4-S37, POL-12). For each line split by Webster, each party's
 * deviation is `s_i − n·w_i/W`. Settlement's buyer partitions keep the exact integer `Σ (s_i·W − n·w_i)` for
 * each (party, payout period, route, weights version) and send the period totals to settlement's supplier
 * partition. The supplier partition reports, for each party and period, the signed sum `Σ total / W` in
 * micro-USD as an exact fraction.
 */
import { COMMISSION_PARTY, type Party } from '../webster.ts';

/** The accumulated deviation of one party for one (period, route, weights version), in units of µ/W. */
export interface DeviationRow { party: string; period: string; route: string; weightsVersion: string; total: bigint; weightSum: bigint }

/** One line's split as a template posted it: `change_i` to each party of a total change `n`. */
export interface SplitPosted { n: bigint; parties: Party[]; change: bigint[]; commission: boolean }

/** A buyer partition's accumulator. A movement is counted once, also when its answer comes again. */
export class DeviationAccumulator {
  private readonly rows = new Map<string, DeviationRow>();
  private readonly counted = new Set<string>();

  /** Count the line `line` of movement `movementId`. Parties that the posting does not pay (Share's commission on a cost line) are not counted. */
  record(movementId: string, line: number, period: string, route: string, weightsVersion: string, split: SplitPosted): void {
    const id = `${movementId}#${line}`;
    if (this.counted.has(id)) return;
    this.counted.add(id);
    const W = split.parties.reduce((a, p) => a + p.weight, 0n);
    split.parties.forEach((p, i) => {
      if (p.party === COMMISSION_PARTY && !split.commission) return;
      const k = JSON.stringify([p.party, period, route, weightsVersion]);
      const cur = this.rows.get(k) ?? { party: p.party, period, route, weightsVersion, total: 0n, weightSum: W };
      this.rows.set(k, { ...cur, total: cur.total + split.change[i]! * W - split.n * p.weight });
    });
  }

  /** The totals of one period, as sent to the supplier partition. */
  periodTotals(period: string): DeviationRow[] {
    return [...this.rows.values()].filter((r) => r.period === period).map((r) => ({ ...r }));
  }
}

/** One party's deviation in one period: `numerator / denominator` micro-USD, reduced, with the denominator > 0. */
export interface PartyDeviation { party: string; period: string; numerator: bigint; denominator: bigint }

const abs = (x: bigint): bigint => (x < 0n ? -x : x);
function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a);
  let y = abs(b);
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** The supplier partition's report: for each (party, period), `Σ total / W` over routes and weights versions, exact. */
export function deviationReport(rows: readonly DeviationRow[]): PartyDeviation[] {
  const sums = new Map<string, { party: string; period: string; num: bigint; den: bigint }>();
  for (const r of rows) {
    const k = JSON.stringify([r.party, r.period]);
    const cur = sums.get(k) ?? { party: r.party, period: r.period, num: 0n, den: 1n };
    const num = cur.num * r.weightSum + r.total * cur.den;
    const den = cur.den * r.weightSum;
    const g = gcd(num, den) || 1n;
    sums.set(k, { ...cur, num: num / g, den: den / g });
  }
  return [...sums.values()]
    .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : a.party < b.party ? -1 : a.party > b.party ? 1 : 0))
    .map((s) => ({ party: s.party, period: s.period, numerator: s.num, denominator: s.den }));
}

/** The payout period of a posting time (HLC "<wall-ns>.<logical>"): the UTC Monday of its week, "YYYY-MM-DD" (RFC-004 §B1.3). */
export function weekOf(postingTime: string): string {
  const ms = Number(BigInt(postingTime.split('.')[0] ?? '0') / 1_000_000n);
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}
