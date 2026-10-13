/**
 * The settlement mapping table (C06 "Charge-line batches", "Settlement mapping"; RFC-004 §B3.1) and the
 * posting templates of RFC-004 §B2 for the charge, amendment, fee and cost lines (M4 … M13, M23 and the
 * abandon postings, C06 V63-4). Settlement uses them to build the entries of a line. The ledger uses the same
 * functions to check the entries that it gets (C06 §8 per-line check 2). Both are pure.
 */
import type { Cause, LateCut, LineKind, MovementKind, Reason, SourceRef, SplitWeights } from '../contracts/c06.ts';
import { micro, seqOf } from '../money.ts';
import { COMMISSION_PARTY, partiesOf, websterSplit, type Party } from '../webster.ts';
import { buyerAccount, shareAccount, supplierEarn } from './accounts.ts';

/** The facts of one line that the mapping and the templates read (C06 §5 `ChargeLine`, §8 port line). */
export interface LineFacts {
  ref: SourceRef;
  lineKind: LineKind;
  payer: 'account' | 'share';
  payee?: { supplier: string; partnerLink: string } | undefined;
  reason: Reason;
  cause?: Cause | undefined;
  lateCut?: LateCut | undefined;
  abandon?: { actionId: string } | undefined;
  priorTotal: bigint;
  newTotal: bigint;
  route?: string | undefined;
  weightsVersion?: string | undefined;
}

/**
 * One row of the mapping table. `charge`: M4 or M5. `amend`: M6 (normal mode) or M7 (own mode). `borne`: M8.
 * `fault`: M9. `fee`: M10. `share_fee`: M11. `cost`: M12 or M13. `cost_amend`: M23. `abandon_original` and
 * `abandon_up`: the Share-paid postings of an abandoned line (kind M12).
 */
export type Rule =
  | 'charge' | 'amend' | 'borne' | 'fault' | 'fee' | 'share_fee' | 'cost' | 'cost_amend' | 'abandon_original' | 'abandon_up';

/** The mode of a line (RFC-004 §B3.3): normal (each party holds split(total)) or own (explicit shares). */
export type LineMode = 'normal' | 'own';

/** What the ledger knows of a posted line: its mode and what each party holds from it. */
export interface LineHolding {
  postedTotal: bigint;
  mode: LineMode;
  /** Party (supplier name or `commission`) → micro-USD that the party holds from the line. */
  shares: Map<string, bigint>;
}

/** The result of a template: the movement kind, the entries, and the line after the posting. */
export interface Posting {
  kind: MovementKind;
  entries: Array<{ ledgerAccount: string; amount: string }>;
  /** True for an M23 line that moves no money (a nil line, RFC-004 §B1.2). */
  nil: boolean;
  after: LineHolding;
  /** The Webster split that the posting used, for the deviation report (RFC-004 §B3.5); absent if none. */
  split?: { n: bigint; parties: Party[]; change: bigint[]; commission: boolean };
}

export type Mapped = { rule: Rule } | { invalid: string };

const UP_USAGE: readonly Reason[] = ['late_traffic', 'quarantine_attribution', 'corrected_record', 'price_correction', 'superseding_record', 're_rate'];
const DOWN_BORNE_USAGE: readonly Reason[] = ['price_correction', 'superseding_record', 'attribution_reversed'];
const DOWN_FAULT_USAGE: readonly Reason[] = ['price_correction', 'superseding_record'];
const REF_KIND: Record<LineKind, ReadonlyArray<SourceRef['kind']>> = {
  reservation: ['reservation'], usage: ['usage'], fee: ['fee'], share_borne_fee: ['fee', 'residue_fee'],
  carried_excess: ['carried_excess'], dearer_path: ['dearer_path'],
};

const isShareOrOther = (c: Cause | undefined): boolean => c?.kind === 'share' || c?.kind === 'other';

/** The mapping row of a line (C06 "Settlement mapping"). Every other combination is invalid. */
export function ruleOf(f: LineFacts): Mapped {
  const kinds = REF_KIND[f.lineKind];
  if (!kinds) return { invalid: `lineKind ${String(f.lineKind)} is not a C06 line kind` };
  if (!kinds.includes(f.ref.kind)) return { invalid: `a ${f.lineKind} line with a ${f.ref.kind} SourceRef` };
  const seq = seqOf(f.ref);
  const amount = f.newTotal - f.priorTotal;
  if (amount === 0n && !(f.lineKind === 'carried_excess' || f.lineKind === 'dearer_path')) return { invalid: 'amount 0' };
  if (f.newTotal < 0n || f.priorTotal < 0n) return { invalid: 'a negative total' };
  if ((f.reason === 'late_pol07_cut') !== (f.lateCut !== undefined)) return { invalid: 'lateCut is present if and only if the reason is late_pol07_cut' };
  if (f.abandon !== undefined && f.payer !== 'share') return { invalid: 'an abandon posting has payer share' };
  if (seq === 0) {
    if (f.reason !== 'original') return { invalid: `reason ${f.reason} on a seq 0 line` };
    if (f.priorTotal !== 0n) return { invalid: 'an original has priorTotal 0' };
    if (f.cause !== undefined) return { invalid: 'a cause on an original' };
    if (amount <= 0n) return { invalid: `amount ${amount}: an original needs a positive charge` };
  } else if (f.reason === 'original') {
    return { invalid: 'reason original on an amendment' };
  }

  if (f.lineKind === 'fee' || f.lineKind === 'share_borne_fee') {
    if (f.payee === undefined) return { invalid: 'a fee kind with no payee' };
    if (f.route !== undefined || f.weightsVersion !== undefined) return { invalid: 'a fee kind with a route or weights' };
    if (seq !== 0) return { invalid: 'a fee kind is never amended' };
    if (f.abandon !== undefined) return { rule: 'share_fee' };
    if (f.lineKind === 'fee') return f.payer === 'account' ? { rule: 'fee' } : { invalid: 'a fee has payer account' };
    return f.payer === 'share' ? { rule: 'share_fee' } : { invalid: 'a Share-borne fee has payer share' };
  }
  if (f.payee !== undefined) return { invalid: 'a payee on a line that is not a fee kind' };
  if (!f.route || !f.weightsVersion) return { invalid: 'no route or weights version' };

  if (f.lineKind === 'carried_excess' || f.lineKind === 'dearer_path') {
    if (f.payer !== 'share') return { invalid: 'a cost line has payer share' };
    if (seq === 0) return { rule: 'cost' };
    return amount === 0n ? { invalid: 'amount 0' } : { rule: 'cost_amend' };
  }

  // reservation and usage lines
  if (f.abandon !== undefined) {
    if (seq === 0) return { rule: 'abandon_original' };
    return amount > 0n ? { rule: 'abandon_up' } : { rule: 'borne' };
  }
  if (f.payer !== 'account') return { invalid: `payer ${f.payer} on a ${f.lineKind} line` };
  if (seq === 0) return { rule: 'charge' };
  if (f.lineKind === 'reservation') {
    if (f.reason === 'late_pol07_cut') {
      return amount < 0n && f.cause === undefined ? { rule: 'amend' } : { invalid: 'a late POL-07 cut is downward and has no cause' };
    }
    if (f.reason === 'price_correction' && amount < 0n) {
      if (isShareOrOther(f.cause)) return { rule: 'borne' };
      if (f.cause?.kind === 'supplier') return { rule: 'fault' };
      return { invalid: 'a downward price correction with no cause' };
    }
    if (f.reason === 're_rate' && amount > 0n && f.cause === undefined) return { rule: 'amend' };
    if (f.reason === 're_rate' && amount < 0n && f.cause?.kind === 'share') return { rule: 'borne' };
    return { invalid: `a reservation amendment with reason ${f.reason}, amount ${amount} and cause ${f.cause?.kind ?? 'none'}` };
  }
  if (amount > 0n) return UP_USAGE.includes(f.reason) ? { rule: 'amend' } : { invalid: `an upward usage amendment with reason ${f.reason}` };
  if (f.reason === 're_rate') return f.cause?.kind === 'share' ? { rule: 'borne' } : { invalid: 'a downward re_rate has cause share' };
  if (DOWN_BORNE_USAGE.includes(f.reason) && isShareOrOther(f.cause)) return { rule: 'borne' };
  if (DOWN_FAULT_USAGE.includes(f.reason) && f.cause?.kind === 'supplier') return { rule: 'fault' };
  return { invalid: `a downward usage amendment with reason ${f.reason} and cause ${f.cause?.kind ?? 'none'}` };
}

/** True if the rule needs the split weights of the line's route. */
export function needsWeights(rule: Rule): boolean {
  return rule !== 'fee' && rule !== 'share_fee' && rule !== 'borne';
}

/** True if the line is a reservation original (charge or abandon): it goes only in a reservation batch (C06 V63-5). */
export function inReservationBatch(f: LineFacts, rule: Rule): boolean {
  return f.lineKind === 'reservation' && (rule === 'charge' || rule === 'abandon_original');
}

const partyAccount = (party: string): string => (party === COMMISSION_PARTY ? shareAccount('commission') : supplierEarn(party));
const debtAccount = (supplier: string): string => `S:${supplier}:debt`;

/** What each party holds from a line that the ledger posted before (`undefined` for a new line key). */
function holdingOf(h: LineHolding | undefined): LineHolding {
  return h ?? { postedTotal: 0n, mode: 'normal', shares: new Map() };
}

/**
 * The holding of a stored line. A line that MONEY-I2 posted (M4) has no stored shares: in normal mode each party
 * holds `split(postedTotal)` (RFC-004 §B3.1 "State per line").
 */
export function holdingOfRecord(r: { postedTotal: string; mode: LineMode; shares?: Array<{ party: string; amount: string }> },
  weights: Pick<SplitWeights, 'legs' | 'commissionWeight'> | undefined): LineHolding {
  const postedTotal = BigInt(r.postedTotal);
  if (r.shares) return { postedTotal, mode: r.mode, shares: new Map(r.shares.map((s) => [s.party, BigInt(s.amount)])) };
  const shares = new Map<string, bigint>();
  if (weights && postedTotal >= 0n) {
    const parties = partiesOf(weights);
    websterSplit(postedTotal, parties).forEach((s, i) => shares.set(parties[i]!.party, s));
  }
  return { postedTotal, mode: r.mode, shares };
}

/** The stored form of a holding's shares, in party order. */
export function storedShares(h: LineHolding): Array<{ party: string; amount: string }> {
  return [...h.shares].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([party, amount]) => ({ party, amount: micro(amount) }));
}

class Entries {
  readonly list: Array<{ ledgerAccount: string; amount: string }> = [];
  add(account: string, amount: bigint): void {
    if (amount !== 0n) this.list.push({ ledgerAccount: account, amount: micro(amount) });
  }
}

/**
 * The RFC-004 §B2 posting of one line. `before` is the line as the ledger holds it (absent for a new line key).
 * `weights` are the split weights of the line's route and weights version (absent for the fee kinds and M8).
 * Returns `invalid` when the template cannot post the line (for example an M12 that moves nothing).
 */
export function postingOf(rule: Rule, f: LineFacts, buyer: string, before: LineHolding | undefined,
  weights: Pick<SplitWeights, 'legs' | 'commissionWeight'> | undefined): Posting | { invalid: string } {
  const h = holdingOf(before);
  const delta = f.newTotal - f.priorTotal;
  const e = new Entries();
  const B = buyerAccount(buyer);
  const shares = new Map(h.shares);
  const need = (): Party[] => {
    if (!weights) throw new RangeError('split weights are needed for this rule');
    return partiesOf(weights);
  };
  const kindByLine = (reservationKind: MovementKind, usageKind: MovementKind): MovementKind =>
    f.lineKind === 'reservation' ? reservationKind : usageKind;

  switch (rule) {
    case 'charge': {
      // M4, M5: `B −a`; each party `+s_i`; `(s_i, s_c) = split(a)`.
      const parties = need();
      const s = websterSplit(f.newTotal, parties);
      e.add(B, -f.newTotal);
      parties.forEach((p, i) => { e.add(partyAccount(p.party), s[i]!); shares.set(p.party, s[i]!); });
      return { kind: kindByLine('M4', 'M5'), entries: e.list, nil: false, after: { postedTotal: f.newTotal, mode: 'normal', shares },
        split: { n: f.newTotal, parties, change: s, commission: true } };
    }
    case 'amend': {
      const parties = need();
      e.add(B, -delta);
      let change: bigint[];
      if (h.mode === 'normal') {
        // M6: each party `+[split(T_new) − split(T_old)]_i`.
        const next = websterSplit(f.newTotal, parties);
        const prev = websterSplit(f.priorTotal, parties);
        change = next.map((x, i) => x - prev[i]!);
      } else {
        // M7: each party `+split(Δ)_i` for Δ > 0, `−split(−Δ)_i` for Δ < 0 (C06-M9).
        const s = websterSplit(delta < 0n ? -delta : delta, parties);
        change = s.map((x) => (delta < 0n ? -x : x));
      }
      parties.forEach((p, i) => { e.add(partyAccount(p.party), change[i]!); shares.set(p.party, (shares.get(p.party) ?? 0n) + change[i]!); });
      return { kind: h.mode === 'normal' ? 'M6' : 'M7', entries: e.list, nil: false, after: { postedTotal: f.newTotal, mode: h.mode, shares },
        split: { n: delta, parties, change, commission: true } };
    }
    case 'borne': {
      // M8: `B +Δ`; `SH:corrections −Δ`; the parties keep their shares; the line enters own mode.
      if (delta >= 0n) return { invalid: 'an M8 is downward' };
      e.add(B, -delta);
      e.add(shareAccount('corrections'), delta);
      return { kind: 'M8', entries: e.list, nil: false, after: { postedTotal: f.newTotal, mode: 'own', shares } };
    }
    case 'fault': {
      // M9: `B +Δ`; `S:f:debt −d`, d = max(0, posted_f − split(T_new)_f); `SH:corrections −(Δ − d)`; own mode.
      if (delta >= 0n || f.cause?.kind !== 'supplier') return { invalid: 'an M9 is downward with cause supplier' };
      const parties = need();
      const f0 = f.cause.supplier;
      const i = parties.findIndex((p) => p.party === f0);
      const target = i < 0 ? 0n : websterSplit(f.newTotal, parties)[i]!;
      const posted = shares.get(f0) ?? 0n;
      const d = posted > target ? posted - target : 0n;
      e.add(B, -delta);
      e.add(debtAccount(f0), -d);
      e.add(shareAccount('corrections'), delta + d);
      if (d !== 0n) shares.set(f0, posted - d);
      return { kind: 'M9', entries: e.list, nil: false, after: { postedTotal: f.newTotal, mode: 'own', shares } };
    }
    case 'fee': {
      // M10: `B −fee`; the payee `S:earn +fee`; not split.
      e.add(B, -f.newTotal);
      e.add(supplierEarn(f.payee!.supplier), f.newTotal);
      shares.set(f.payee!.supplier, f.newTotal);
      return { kind: 'M10', entries: e.list, nil: false, after: { postedTotal: f.newTotal, mode: 'normal', shares } };
    }
    case 'share_fee': {
      // M11: `SH:costs −fee`; the payee `S:earn +fee`.
      e.add(shareAccount('costs'), -f.newTotal);
      e.add(supplierEarn(f.payee!.supplier), f.newTotal);
      shares.set(f.payee!.supplier, f.newTotal);
      return { kind: 'M11', entries: e.list, nil: false, after: { postedTotal: f.newTotal, mode: 'normal', shares } };
    }
    case 'cost':
    case 'abandon_original':
    case 'abandon_up': {
      // M12, M13 and the abandon postings: each supplier `S:earn +s_i`; `SH:costs −Σ s_i`; no commission share; B untouched.
      const parties = need();
      const next = websterSplit(f.newTotal, parties);
      const prev = rule === 'abandon_up' ? websterSplit(f.priorTotal, parties) : parties.map(() => 0n);
      const change = next.map((x, i) => (parties[i]!.party === COMMISSION_PARTY ? 0n : x - prev[i]!));
      let paid = 0n;
      parties.forEach((p, i) => {
        if (p.party === COMMISSION_PARTY) return;
        e.add(supplierEarn(p.party), change[i]!);
        paid += change[i]!;
        shares.set(p.party, (shares.get(p.party) ?? 0n) + change[i]!);
      });
      if (paid === 0n) return { invalid: 'the split pays no supplier: the posting moves nothing' };
      e.add(shareAccount('costs'), -paid);
      const kind: MovementKind = rule === 'cost' ? (f.lineKind === 'dearer_path' ? 'M13' : 'M12') : 'M12';
      return { kind, entries: e.list, nil: false, after: { postedTotal: f.newTotal, mode: h.mode, shares },
        split: { n: f.newTotal - (rule === 'abandon_up' ? f.priorTotal : 0n), parties, change, commission: false } };
    }
    case 'cost_amend': {
      // M23: δ_i = split(T_new)_i − paid_i. δ > 0: `S:i:earn +δ`. δ < 0 and cause supplier i: `S:i:debt δ`.
      // Otherwise nothing for i. `SH:costs` balances. No party moves: a nil line.
      const parties = need();
      const next = websterSplit(f.newTotal, parties);
      let sh = 0n;
      parties.forEach((p, i) => {
        if (p.party === COMMISSION_PARTY) return;
        const paid = shares.get(p.party) ?? 0n;
        const d = next[i]! - paid;
        if (d > 0n) { e.add(supplierEarn(p.party), d); sh -= d; shares.set(p.party, paid + d); }
        else if (d < 0n && f.cause?.kind === 'supplier' && f.cause.supplier === p.party) {
          e.add(debtAccount(p.party), d); sh -= d; shares.set(p.party, paid + d);
        }
      });
      e.add(shareAccount('costs'), sh);
      const mode: LineMode = delta < 0n ? 'own' : h.mode;
      return { kind: 'M23', entries: e.list, nil: e.list.length === 0, after: { postedTotal: f.newTotal, mode, shares } };
    }
  }
}
