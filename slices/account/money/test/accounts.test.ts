/** Ledger accounts, posting principals and account classes (RFC-004 §B1.1, §B1.2, §B2). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOVEMENT_KINDS, classAllowed, isSourceRef, ledgerPartitionOfBuyer, mayPost, parseLedgerAccount, type LedgerAccount } from '../src/index.ts';

test('should read each class of ledger account and refuse every other name', () => {
  assert.deepEqual(parseLedgerAccount('B:b1'), { cls: 'buyer', account: 'b1' });
  assert.deepEqual(parseLedgerAccount('S:A:earn'), { cls: 'supplier', supplier: 'A', sub: 'earn' });
  assert.deepEqual(parseLedgerAccount('S:A:debt'), { cls: 'supplier', supplier: 'A', sub: 'debt' });
  for (const c of ['commission', 'costs', 'corrections', 'write-offs', 'repayments', 'fx', 'treasury']) {
    assert.deepEqual(parseLedgerAccount(`SH:${c}`), { cls: 'share', category: c });
  }
  assert.deepEqual(parseLedgerAccount('X:p:prov'), { cls: 'external', partner: 'p', provider: 'prov' });
  for (const bad of ['B', 'B:', 'B:b1:x', 'b:b1', 'S:A', 'S:A:other', 'S:A:earn:x', 'SH:bonus', 'SH:commission:x', 'SH', 'X:p', 'X:p:q:r',
    'B:b 1', 'B: b1', ':B:b1', 'Q:x', '', 12, null, undefined]) {
    assert.equal(parseLedgerAccount(bad), undefined, String(bad));
  }
});

test('should let each posting principal post only the kinds of RFC-004 §B2 "Posted by", and no other caller post any kind', () => {
  const expected: Record<string, string[]> = {
    settlement: ['M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12', 'M13', 'M23'],
    payments: ['M1', 'M2', 'M3', 'M14', 'M20', 'M22'],
    payouts: ['M15', 'M16', 'M17', 'M22'],
    receivables: ['M18', 'M19'],
    reconciliation: ['M21'],
    rating: [], operator: [], '': [],
  };
  for (const [principal, kinds] of Object.entries(expected)) {
    assert.deepEqual(MOVEMENT_KINDS.filter((k) => mayPost(principal, k)), kinds, principal);
  }
});

test('should allow an M4 to touch only the buyer, supplier earnings and the commission, and an M1 only the buyer, an external account and repayments', () => {
  const accounts: Array<[string, LedgerAccount]> = [
    ['B', { cls: 'buyer', account: 'b' }], ['S:earn', { cls: 'supplier', supplier: 's', sub: 'earn' }],
    ['S:debt', { cls: 'supplier', supplier: 's', sub: 'debt' }], ['SH:commission', { cls: 'share', category: 'commission' }],
    ['SH:repayments', { cls: 'share', category: 'repayments' }], ['SH:costs', { cls: 'share', category: 'costs' }],
    ['X', { cls: 'external', partner: 'p', provider: 'q' }],
  ];
  const allowed = (kind: 'M1' | 'M4' | 'M5') => accounts.filter(([, a]) => classAllowed(kind, a)).map(([n]) => n);
  assert.deepEqual(allowed('M4'), ['B', 'S:earn', 'SH:commission']);
  assert.deepEqual(allowed('M1'), ['B', 'SH:repayments', 'X']);
  assert.deepEqual(allowed('M5'), [], 'no kind of a later increment');
});

test('should give a buyer one home partition in 1 … count', () => {
  const homes = Array.from({ length: 500 }, (_, i) => Number(ledgerPartitionOfBuyer(`b${i}`, 8)));
  assert.ok(homes.every((h) => Number.isInteger(h) && h >= 1 && h <= 8));
  assert.deepEqual([...new Set(homes)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(ledgerPartitionOfBuyer('b1'), ledgerPartitionOfBuyer('b1'));
  assert.equal(ledgerPartitionOfBuyer('b1', 1), '1');
});

test('should accept every SourceRef kind of C06 §5 with its fields, and refuse a missing or wrong field', () => {
  const m = '2026-10-12T09:00:00Z';
  const good = [
    { kind: 'reservation', reservation: 'r', minute: m, seq: 0 },
    { kind: 'usage', account: 'a', product: 'p', route: 'R', minute: m, seq: 3 },
    { kind: 'fee', reservation: 'r', feeId: 'f' },
    { kind: 'residue_fee', request: 'q', partnerLink: 'L', feeId: 'f' },
    { kind: 'carried_excess', account: 'a', product: 'p', route: 'R', minute: m, seq: 0 },
    { kind: 'dearer_path', reservation: 'r', minute: m, seq: 1 },
  ];
  for (const g of good) {
    assert.equal(isSourceRef(g), true, g.kind);
    for (const f of Object.keys(g).filter((k) => k !== 'kind')) {
      const { [f]: _gone, ...rest } = g as Record<string, unknown>;
      assert.equal(isSourceRef(rest), false, `${g.kind} without ${f}`);
    }
  }
  for (const bad of [
    { kind: 'usage', account: 'a', product: 'p', route: 'R', minute: '2026-10-12 09:00:00Z', seq: 0 },
    { kind: 'usage', account: 'a', product: 'p', route: 'R', minute: `x${m}`, seq: 0 },
    { kind: 'usage', account: 'a', product: 'p', route: 'R', minute: `${m}x`, seq: 0 },
    { kind: 'dearer_path', reservation: 'r', minute: m, seq: 1.5 },
    { kind: 'dearer_path', reservation: 'r', minute: m, seq: Number.MAX_SAFE_INTEGER + 2 },
    { kind: 'fee', reservation: 'r', feeId: '' },
    { kind: 'fee', reservation: 7, feeId: 'f' },
    { kind: 7 },
  ]) assert.equal(isSourceRef(bad), false, JSON.stringify(bad));
});
