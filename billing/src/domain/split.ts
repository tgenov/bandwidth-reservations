// Splits an integer amount between parties in proportion to integer weights,
// so the shares always sum exactly to the amount.
//
// Method: D'Hondt (Jefferson), not largest remainder. Largest remainder suffers
// the Alabama paradox: raising the amount by one can LOWER a party's share.
// Charges grow when late records arrive (D19), and each minute's split is
// recomputed from its new total, so a non-monotone method would claw money
// back from a supplier on ordinary late usage. D'Hondt is house-monotone:
// raising the amount never lowers anyone's share.

export interface Party {
  account: string;
  weight: number;
}

/** Shares for `amount`, keyed by account. Ties go to the earlier account name. */
export function split(amount: bigint, parties: Party[]): Map<string, bigint> {
  if (amount < 0n) {
    // Negative amounts only arise as differences, never as totals.
    throw new Error('split amount must be non-negative');
  }
  const ps = [...parties].sort((a, b) => (a.account < b.account ? -1 : 1));
  const weights = ps.map((p) => BigInt(p.weight));
  const total = weights.reduce((s, w) => s + w, 0n);
  if (total <= 0n) throw new Error('split needs a positive total weight');

  // floor(amount * w / W) is exactly the D'Hondt state after its jump points
  // up to amount/W, so it is a valid prefix of the sequential process.
  const shares = weights.map((w) => (amount * w) / total);
  let left = amount - shares.reduce((s, x) => s + x, 0n);

  // At most (parties - 1) units remain. Each goes to the party with the
  // smallest next jump point (share + 1) / weight; compare by cross-multiplying.
  while (left > 0n) {
    let best = 0;
    for (let i = 1; i < ps.length; i++) {
      if ((shares[i] + 1n) * weights[best] < (shares[best] + 1n) * weights[i]) best = i;
    }
    shares[best] += 1n;
    left -= 1n;
  }
  return new Map(ps.map((p, i) => [p.account, shares[i]]));
}
