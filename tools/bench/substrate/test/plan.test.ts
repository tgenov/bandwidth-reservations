import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { reverseBits20 } from '../../../../platform/runtime/src/home.ts';
import type { Call } from '../src/lane.ts';
import { homeKeyOf, partitionKey, planWrites, type HeadState } from '../src/plan.ts';

const SIZES = { logBytes: 20, outboxBytes: 30, projectionBytes: 10 };
const FILLER = new Uint8Array(64).map((_, i) => i);
const BATCH_ID = new Uint8Array(16).fill(9);
const call = (partition: number, entries: number, requestSeq: number): Call => ({ intendedMs: 0, partition, entries, bytes: 100, requestSeq: BigInt(requestSeq) });

function chainOf(prev: Uint8Array, seq: bigint, payload: Uint8Array): Uint8Array {
  const s = Buffer.alloc(8);
  s.writeBigUInt64BE(seq);
  return new Uint8Array(createHash('sha256').update(prev).update(s).update(payload).digest());
}

describe('partition keys and home keys (RFC-006 §3.7; platform/runtime/src/home.ts)', () => {
  it('should put the home keys of one slot in one contiguous range starting at reverse(slot)', () => {
    const base = reverseBits20(5);
    const keys = Array.from({ length: 1_024 }, (_, i) => homeKeyOf(5, i, 1_024));
    for (const k of keys) assert.ok(k >= base && k < base + 1_024, `home key ${k} outside [${base}, ${base + 1_024})`);
    assert.equal(new Set(keys).size, 1_024);
  });

  it('should wrap to the first home when a slot has more partitions than homes', () => {
    assert.equal(homeKeyOf(5, 1_024, 1_024), homeKeyOf(5, 0, 1_024));
  });

  it('should give distinct partition keys across slots and indices', () => {
    const seen = new Set<string>();
    for (let s = 0; s < 4; s++) for (let i = 0; i < 300; i++) seen.add(Buffer.from(partitionKey(s, i)).toString('hex'));
    assert.equal(seen.size, 1_200);
  });
});

describe('planWrites (the writes of RFC-006 §4.3)', () => {
  const heads = new Map<number, HeadState>([[0, { seq: 10n, chain: new Uint8Array(32).fill(7), streamSeq: 4n }]]);
  const w = planWrites({
    slot: 2, slots: 1_024, epoch: 3n, ts: '1700000000000000000.0000000001', batchId: BATCH_ID,
    calls: [call(0, 2, 100), call(1, 1, 101), call(0, 1, 102)], heads, filler: FILLER, sizes: SIZES, marker: null,
  });

  it('should continue each partition sequence from its head and start a new partition at 1', () => {
    assert.deepEqual(w.log.map((r) => [Buffer.from(r.partition).toString('hex'), r.seq]), [
      [Buffer.from(partitionKey(2, 0)).toString('hex'), 11n],
      [Buffer.from(partitionKey(2, 0)).toString('hex'), 12n],
      [Buffer.from(partitionKey(2, 1)).toString('hex'), 1n],
      [Buffer.from(partitionKey(2, 0)).toString('hex'), 13n],
    ]);
  });

  it('should chain each entry to the one before it in its partition', () => {
    const p = FILLER.subarray(0, 20);
    const c11 = chainOf(new Uint8Array(32).fill(7), 11n, p);
    const c12 = chainOf(c11, 12n, p);
    assert.deepEqual(w.log.map((r) => r.chain), [c11, c12, chainOf(new Uint8Array(32), 1n, p), chainOf(c12, 13n, p)]);
  });

  it('should upsert one head row per partition with the batch id, the last seq, chain and stream position', () => {
    assert.deepEqual(w.heads.map((h) => ({ homeKey: h.homeKey, seq: h.seq, streams: Buffer.from(h.streams).toString(), batchId: h.batchId, epoch: h.epoch, adopted: h.adopted })), [
      { homeKey: homeKeyOf(2, 0, 1_024), seq: 13n, streams: '{"outcome":"6"}', batchId: BATCH_ID, epoch: 3n, adopted: true },
      { homeKey: homeKeyOf(2, 1, 1_024), seq: 1n, streams: '{"outcome":"1"}', batchId: BATCH_ID, epoch: 3n, adopted: true },
    ]);
    assert.deepEqual(w.heads[0]?.chain, w.log[3]?.chain);
  });

  it('should write one outbox row and one projection row per call with the configured sizes', () => {
    assert.deepEqual(w.outbox.map((o) => [o.streamSeq, o.payload.byteLength]), [[5n, 30], [1n, 30], [6n, 30]]);
    assert.deepEqual(w.projections.map((p) => p.body.byteLength), [10, 10, 10]);
    assert.equal(new Set(w.projections.map((p) => Buffer.from(p.requestId).toString('hex'))).size, 3);
    assert.equal(w.ts, '1700000000000000000.0000000001');
    assert.equal(w.marker, null);
    assert.ok(w.log.every((r) => r.epoch === 3n && r.slot === 2 && r.payload.byteLength === 20));
  });

  it('should add the slot marker row on partition "" and the owner_slot update when a marker is due (§4.6)', () => {
    const m = planWrites({
      slot: 2, slots: 1_024, epoch: 3n, ts: '5', batchId: BATCH_ID, calls: [call(0, 1, 1)], heads: new Map(),
      filler: FILLER, sizes: SIZES, marker: { markerSeq: 8n },
    });
    assert.deepEqual(m.marker, { reportThrough: '5', markerSeq: 8n });
    assert.deepEqual(m.outbox.map((o) => [o.partition.byteLength, o.stream, o.streamSeq]), [[partitionKey(2, 0).byteLength, 'outcome', 1n], [0, 'marker', 8n]]);
  });

  it('should refuse a filler shorter than the largest row', () => {
    assert.throws(() => planWrites({
      slot: 0, slots: 1, epoch: 1n, ts: '1', batchId: BATCH_ID, calls: [call(0, 1, 1)], heads: new Map(),
      filler: new Uint8Array(10), sizes: SIZES, marker: null,
    }), RangeError);
  });
});
