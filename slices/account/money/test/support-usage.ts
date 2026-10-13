/** Builders of the MONEY-I3 tests: routes of the P4 examples, a test world with them, and short forms of batches. */
import type { ChargeLine, LineAck, MovementPosted, SourceRef, SplitWeights } from '../src/index.ts';
import { TOPIC } from '../src/index.ts';
import { MINUTE_0, chargeLine, moneyWorld, reservationBatch, reservationLine, usageBatch, type MoneyWorld } from '../testing/index.ts';

const AT = { effectiveFrom: '2026-10-01T00:00:00Z', announcedAt: '1760000000000000000.0000000009' };
/** P4-S75: parties a, b and Share's commission with weights 31, 76 and 70. */
export const R31: SplitWeights = { entityType: 'split_weights', route: 'R31', weightsVersion: 'w31', ...AT,
  legs: [{ link: 'La', supplier: 'a', weight: 31 }, { link: 'Lb', supplier: 'b', weight: 76 }], commissionWeight: 70 };
/** P4-S85: supplier s with weight 3 and Share's commission with weight 1. */
export const R4: SplitWeights = { entityType: 'split_weights', route: 'R4', weightsVersion: 'w4', ...AT,
  legs: [{ link: 'Ls', supplier: 's', weight: 3 }], commissionWeight: 1 };
/** R1 with a second weights version (C06 D4: an amendment keeps the version of its original). */
export const R1_V2: SplitWeights = { entityType: 'split_weights', route: 'R1', weightsVersion: 'w1b', ...AT,
  legs: [{ link: 'L1', supplier: 'A', weight: 1 }, { link: 'L2', supplier: 'B', weight: 1 }, { link: 'L3', supplier: 'C', weight: 1 }], commissionWeight: 1 };

/** The money world with the routes of the catalogue fixture and R31, R4, R1 w1b. */
export async function usageWorld(): Promise<MoneyWorld> {
  const w = await moneyWorld();
  for (const x of [R31, R4, R1_V2]) w.weights.apply(x);
  return w;
}

let batchNo = 1000;
/** A new batch id. */
export const nextId = (): string => `rating-1:0:${++batchNo}:0`;

/** Balances by ledger account, without zero balances, as strings. */
export function balancesOf(w: MoneyWorld): Record<string, string> {
  return Object.fromEntries([...w.balances()].filter(([, v]) => v !== 0n).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v.toString()]));
}

/** The reservation SourceRef. */
export const resRef = (r: string, minute = MINUTE_0, seq = 0): Extract<SourceRef, { kind: 'reservation' }> =>
  ({ kind: 'reservation', reservation: r, minute, seq });

/** Post one reservation original through settlement. */
export async function original(w: MoneyWorld, account: string, r: string, amount: bigint, over: Partial<ChargeLine> = {}, minute = MINUTE_0): Promise<LineAck[]> {
  return w.settle(reservationBatch(nextId(), account, minute, [reservationLine(account, r, minute, amount, over)]));
}

/** Post one usage batch through settlement. */
export async function usage(w: MoneyWorld, account: string, lines: ChargeLine[], id = nextId()): Promise<LineAck[]> {
  return w.settle(usageBatch(id, account, lines));
}

/** A reservation amendment `prior → next` of r (seq `seq`) with `reason` and the other fields of `over`. */
export function resAmend(account: string, r: string, seq: number, prior: bigint, next: bigint, over: Partial<ChargeLine>): ChargeLine {
  return chargeLine(account, resRef(r, MINUTE_0, seq), 'reservation', prior, next, { reservation: r, ...over });
}

/** The movement events in order. */
export function movementsOf(w: MoneyWorld): MovementPosted[] {
  return w.events<MovementPosted>(TOPIC.movements).map((e) => e.event);
}

/** The entries of each line of the last movement, as "account amount" strings. */
export function lastEntries(w: MoneyWorld): string[][] {
  const mv = movementsOf(w).at(-1)!;
  const stored = w.rt.log(new TextEncoder().encode(mv.position.ledgerPartition))
    .map((e) => (e.entry.payload as { movement?: { movementId: string; lines: Array<{ entries: Array<{ ledgerAccount: string; amount: string }> }> } }).movement)
    .find((m) => m?.movementId === mv.movementId)!;
  return stored.lines.map((l) => l.entries.map((e) => `${e.ledgerAccount} ${e.amount}`));
}

/**
 * The test oracle of the Webster split (RFC-004 §B3.2): give the units one at a time to the party with the
 * largest w / (2s + 1), ties to the earliest party; Share's commission is the last party. It shares no code with
 * the provider. Returns the share of each party by name ('commission' for Share's commission).
 */
export function refSplit(n: bigint, w: Pick<SplitWeights, 'legs' | 'commissionWeight'>): Map<string, bigint> {
  const names: string[] = [];
  const weights: bigint[] = [];
  for (const l of w.legs) {
    const i = names.indexOf(l.supplier);
    if (i < 0) { names.push(l.supplier); weights.push(BigInt(l.weight)); } else weights[i] = weights[i]! + BigInt(l.weight);
  }
  names.push('commission');
  weights.push(BigInt(w.commissionWeight));
  const s = weights.map(() => 0n);
  for (let u = 0n; u < n; u++) {
    let best = 0;
    for (let i = 1; i < s.length; i++) if (weights[i]! * (2n * s[best]! + 1n) > weights[best]! * (2n * s[i]! + 1n)) best = i;
    s[best] = s[best]! + 1n;
  }
  return new Map(names.map((p, i) => [p, s[i]!]));
}
