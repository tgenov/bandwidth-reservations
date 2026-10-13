/**
 * Ledger accounts (RFC-004 §B1.1), the posting principals and the kinds each may post (§B2 "Posted by"),
 * the account classes each kind may touch (§B1.2 "Validation at append"), and the home partition (§B1.3).
 */
import { createHash } from 'node:crypto';
import type { MovementKind } from '../contracts/c06.ts';

export type LedgerAccount =
  | { cls: 'buyer'; account: string }
  | { cls: 'supplier'; supplier: string; sub: 'earn' | 'debt' }
  | { cls: 'share'; category: ShareCategory }
  | { cls: 'external'; partner: string; provider: string };

/** Share's own categories (RFC-004 §B1.1). */
export const SHARE_CATEGORIES = ['commission', 'costs', 'corrections', 'write-offs', 'repayments', 'fx', 'treasury'] as const;
export type ShareCategory = typeof SHARE_CATEGORIES[number];

const PART = /^[^:\s]+$/;

/** The ledger account named by `B:<acct>`, `S:<sup>:earn|debt`, `SH:<category>` or `X:<partner>:<provider>`. */
export function parseLedgerAccount(name: unknown): LedgerAccount | undefined {
  if (typeof name !== 'string') return undefined;
  const p = name.split(':');
  if (!p.every((x) => PART.test(x))) return undefined;
  if (p[0] === 'B' && p.length === 2) return { cls: 'buyer', account: p[1]! };
  if (p[0] === 'S' && p.length === 3 && (p[2] === 'earn' || p[2] === 'debt')) return { cls: 'supplier', supplier: p[1]!, sub: p[2] };
  if (p[0] === 'SH' && p.length === 2 && (SHARE_CATEGORIES as readonly string[]).includes(p[1]!)) {
    return { cls: 'share', category: p[1] as ShareCategory };
  }
  if (p[0] === 'X' && p.length === 3) return { cls: 'external', partner: p[1]!, provider: p[2]! };
  return undefined;
}

export const buyerAccount = (account: string): string => `B:${account}`;
export const supplierEarn = (supplier: string): string => `S:${supplier}:earn`;
export const shareAccount = (category: ShareCategory): string => `SH:${category}`;

/** The posting principals (C06 §8 "Principal"). */
export const POSTING_PRINCIPALS = ['settlement', 'payments', 'payouts', 'receivables', 'reconciliation'] as const;
export type PostingPrincipal = typeof POSTING_PRINCIPALS[number];

/** RFC-004 §B2 "Posted by": the kinds each principal may post. */
const KINDS_OF: Record<PostingPrincipal, readonly MovementKind[]> = {
  settlement: ['M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12', 'M13', 'M23'],
  payments: ['M1', 'M2', 'M3', 'M14', 'M20', 'M22'],
  payouts: ['M15', 'M16', 'M17', 'M22'],
  receivables: ['M18', 'M19'],
  reconciliation: ['M21'],
};

/** True if `principal` (the caller's workload identity) may post a movement of `kind`. */
export function mayPost(principal: string, kind: MovementKind): boolean {
  return (POSTING_PRINCIPALS as readonly string[]).includes(principal) && KINDS_OF[principal as PostingPrincipal].includes(kind);
}

/** The kinds that the ledger posts (MONEY-I2: M1, M4; MONEY-I3: M5 … M13, M23). The other kinds come in later increments. */
export const KINDS_IN_THIS_INCREMENT: readonly MovementKind[] = ['M1', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12', 'M13', 'M23'];

const isBuyer = (a: LedgerAccount): boolean => a.cls === 'buyer';
const isEarn = (a: LedgerAccount): boolean => a.cls === 'supplier' && a.sub === 'earn';
const isDebt = (a: LedgerAccount): boolean => a.cls === 'supplier' && a.sub === 'debt';
const isShare = (a: LedgerAccount, c: ShareCategory): boolean => a.cls === 'share' && a.category === c;

/** True if an entry of `kind` may touch the account (RFC-004 §B1.2 "Validation at append", the §B2 templates). */
export function classAllowed(kind: MovementKind, a: LedgerAccount): boolean {
  switch (kind) {
    case 'M1': return isBuyer(a) || a.cls === 'external' || isShare(a, 'repayments');
    case 'M4': case 'M5': case 'M6': case 'M7': return isBuyer(a) || isEarn(a) || isShare(a, 'commission');
    case 'M8': return isBuyer(a) || isShare(a, 'corrections');
    case 'M9': return isBuyer(a) || isDebt(a) || isShare(a, 'corrections');
    case 'M10': return isBuyer(a) || isEarn(a);
    case 'M11': case 'M12': case 'M13': return isEarn(a) || isShare(a, 'costs');
    case 'M23': return isEarn(a) || isDebt(a) || isShare(a, 'costs');
    default: return false;
  }
}

/** Ledger partitions (RFC-004 §B1.3, est. 128; SP4 measures). */
export const DEFAULT_PARTITION_COUNT = 128;

/**
 * The ledger partition of a buyer home (RFC-000 §2 rule 1, RFC-004 §B1.3): 1 + (the first 4 bytes of
 * SHA-256("B:<account>"), big-endian) mod the partition count. The result is "1" … "<count>".
 */
export function ledgerPartitionOfBuyer(account: string, count = DEFAULT_PARTITION_COUNT): string {
  const d = createHash('sha256').update(buyerAccount(account)).digest();
  return String(1 + (d.readUInt32BE(0) % count));
}
