/** Micro-USD strings, the canonical SourceRef encoding of C06 "Conventions" (fixed vectors), and the split-weights replica. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SplitWeightsReplica, canonicalSourceRef, isSourceRef, lineKeyDigest, parseMicro, sourceRefDigest } from '../src/index.ts';
import { catalogueSplitWeights } from '../testing/index.ts';

test('should read only canonical signed integer strings as micro-USD, never a float', () => {
  assert.deepEqual(['0', '-600', '9007199254740993', '1500'].map(parseMicro), [0n, -600n, 9_007_199_254_740_993n, 1_500n]);
  for (const bad of ['-0', '01', '1.5', '1e3', ' 1', '', '+1', 1, null]) assert.equal(parseMicro(bad), undefined, String(bad));
});

test('should encode a SourceRef as the kind tag and its fields in schema order, each with a u32 big-endian length (fixed vectors)', () => {
  const r = { kind: 'reservation', reservation: 'r-1', minute: '2026-10-12T09:00:00Z', seq: 0 } as const;
  assert.equal(Buffer.from(canonicalSourceRef(r)).toString('hex'),
    '0000000b7265736572766174696f6e00000003722d3100000014323032362d31302d31325430393a30303a30305a0000000130');
  assert.equal(sourceRefDigest(r), '74cbb8ce881086c02121f171be62d9b932e23858697faaea7fb0482239291d2c');
  assert.equal(sourceRefDigest({ kind: 'usage', account: 'b1', product: 'best-effort', route: 'R1', minute: '2026-10-12T09:01:00Z', seq: 12 }),
    '04b5f16fd47cb9c03b33dcfaeafecb375a60b7d8dbdb75eb946c1f1812bface8');
  assert.equal(sourceRefDigest({ kind: 'fee', reservation: 'r-1', feeId: 'f-1' }), 'a444ebd48a67dc08675a6ad090df11ab11a86ed2757571797102d8f69eb60d26');
});

test('should give one line key to every amendment sequence of a line, and a different one to another line', () => {
  const a = { kind: 'reservation', reservation: 'r-1', minute: '2026-10-12T09:00:00Z', seq: 0 } as const;
  assert.equal(lineKeyDigest(a), lineKeyDigest({ ...a, seq: 3 }));
  assert.notEqual(lineKeyDigest(a), lineKeyDigest({ ...a, minute: '2026-10-12T09:01:00Z' }));
  assert.notEqual(sourceRefDigest(a), sourceRefDigest({ ...a, seq: 1 }));
});

test('should accept only SourceRefs of a known kind with fields of the right type', () => {
  assert.equal(isSourceRef({ kind: 'reservation', reservation: 'r', minute: '2026-10-12T09:00:00Z', seq: 0 }), true);
  for (const bad of [
    { kind: 'reservation', reservation: 'r', minute: '2026-10-12T09:00:30Z', seq: 0 },
    { kind: 'reservation', reservation: 'r', minute: '2026-10-12T09:00:00Z', seq: -1 },
    { kind: 'reservation', reservation: '', minute: '2026-10-12T09:00:00Z', seq: 0 },
    { kind: 'reservation', reservation: 'r', minute: '2026-10-12T09:00:00Z', seq: '0' },
    { kind: 'other', reservation: 'r' }, null, 'r-1',
  ]) assert.equal(isSourceRef(bad), false, JSON.stringify(bad));
});

test('should keep each split-weights version as first applied, and report a second, different body for the same version', () => {
  const w = new SplitWeightsReplica();
  const [r1] = catalogueSplitWeights();
  w.apply(r1!);
  w.apply(structuredClone(r1!));
  assert.deepEqual(w.conflicts, []);
  w.apply({ ...r1!, commissionWeight: 1 });
  assert.equal(w.find('R1', 'w1')?.commissionWeight, 1500);
  assert.deepEqual(w.conflicts, [JSON.stringify(['R1', 'w1'])]);
  assert.equal(w.find('R1', 'w2'), undefined);
});
