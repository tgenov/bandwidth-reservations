/**
 * The rows one slot batch writes (RFC-006 §4.3; C01 §2.3): log entries with a per-partition `seq` and `chain`, one
 * outbox row per call (its outcome event), one head upsert per partition with the batch's `batch_id` (R47-14), one
 * projection row per call, and the slot's marker when one is due (§4.6). Pure: the caller gives the heads read in
 * the same attempt, so a restart recomputes every row (§4.3: "recomputed on every retry").
 */
import { createHash } from 'node:crypto';
import { reverseBits20 } from '../../../../platform/runtime/src/home.ts';
import type { Call } from './lane.ts';

/** The synthetic owner kind. Its tables have the account kind's names and shapes. */
export const KIND = 'account';
const HOME_SPACE = 2 ** 20;
const ZERO_CHAIN = new Uint8Array(32);

/** A partition key: 'p' ‖ int32 BE slot ‖ int32 BE index. */
export function partitionKey(slot: number, index: number): Uint8Array {
  const b = Buffer.alloc(9);
  b.write('p', 0, 'latin1');
  b.writeUInt32BE(slot, 1);
  b.writeUInt32BE(index, 5);
  return new Uint8Array(b);
}

/**
 * The head key of partition `index` of `slot`: home = slot + j × slots, so slot = home mod slots as in the fixed
 * slot map (platform/runtime/src/home.ts slotOfPartition); home_key = reverse20(home), so a slot's partitions lie
 * in one contiguous key range (RFC-006 §3.7). Synthetic keys stand in for hash(partition).
 */
export function homeKeyOf(slot: number, index: number, slots: number): number {
  const homesPerSlot = HOME_SPACE / slots;
  return reverseBits20(slot + (index % homesPerSlot) * slots);
}

/** The head of one partition as read in the attempt. */
export interface HeadState {
  seq: bigint;
  chain: Uint8Array;
  /** The partition's last `stream_seq` on the outcome stream. */
  streamSeq: bigint;
}

export interface Sizes {
  logBytes: number;
  outboxBytes: number;
  projectionBytes: number;
}

export interface LogRow {
  slot: number; partition: Uint8Array; seq: bigint; generation: number; epoch: bigint; kind: number; schemaV: number;
  identity: Uint8Array; emits: Uint8Array; audit: Uint8Array; retention: number; keyId: Uint8Array; payload: Uint8Array; chain: Uint8Array;
}

export interface OutboxRow {
  slot: number; partition: Uint8Array; stream: string; streamSeq: bigint; n: number; topic: string;
  msgKey: Uint8Array; headers: Uint8Array; payload: Uint8Array; generation: number; epoch: bigint;
}

export interface HeadRow {
  homeKey: number; partition: Uint8Array; slot: number; generation: number; adopted: boolean; seq: bigint;
  epoch: bigint; streams: Uint8Array; chain: Uint8Array; batchId: Uint8Array;
}

export interface ProjectionRow {
  partition: Uint8Array; requestId: Uint8Array; state: string; body: Uint8Array;
}

export interface BatchWrites {
  ts: string;
  log: LogRow[];
  outbox: OutboxRow[];
  heads: HeadRow[];
  projections: ProjectionRow[];
  /** owner_slot.report_through and marker_seq when the batch carries a marker (§4.6). */
  marker: { reportThrough: string; markerSeq: bigint } | null;
}

/** The request id of a call: int32 BE slot ‖ uint64 BE requestSeq. */
export function requestIdOf(slot: number, call: Call): Uint8Array {
  const b = Buffer.alloc(12);
  b.writeUInt32BE(slot, 0);
  b.writeBigUInt64BE(call.requestSeq, 4);
  return new Uint8Array(b);
}

function chainNext(prev: Uint8Array, seq: bigint, payload: Uint8Array): Uint8Array {
  const s = Buffer.alloc(8);
  s.writeBigUInt64BE(seq);
  return new Uint8Array(createHash('sha256').update(prev).update(s).update(payload).digest());
}

const EMPTY = new Uint8Array(0);
const enc = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

/** See the module comment. `filler` gives the row bodies and must be at least as long as the largest size. */
export function planWrites(o: {
  slot: number; slots: number; epoch: bigint; ts: string; batchId: Uint8Array; calls: Call[];
  heads: ReadonlyMap<number, HeadState>; filler: Uint8Array; sizes: Sizes; marker: { markerSeq: bigint } | null;
}): BatchWrites {
  const need = Math.max(o.sizes.logBytes, o.sizes.outboxBytes, o.sizes.projectionBytes);
  if (o.filler.byteLength < need) throw new RangeError(`filler of ${o.filler.byteLength} bytes is shorter than the largest row (${need})`);
  const logPayload = o.filler.subarray(0, o.sizes.logBytes);
  const state = new Map<number, HeadState>();
  const order: number[] = [];
  const out: BatchWrites = { ts: o.ts, log: [], outbox: [], heads: [], projections: [], marker: null };
  for (const c of o.calls) {
    let h = state.get(c.partition);
    if (!h) {
      h = o.heads.get(c.partition) ?? { seq: 0n, chain: ZERO_CHAIN, streamSeq: 0n };
      order.push(c.partition);
    }
    const partition = partitionKey(o.slot, c.partition);
    let { seq, chain } = h;
    for (let e = 0; e < c.entries; e++) {
      seq += 1n;
      chain = chainNext(chain, seq, logPayload);
      out.log.push({
        slot: o.slot, partition, seq, generation: 1, epoch: o.epoch, kind: 1, schemaV: 1, identity: requestIdOf(o.slot, c),
        emits: EMPTY, audit: EMPTY, retention: 1, keyId: EMPTY, payload: logPayload, chain,
      });
    }
    const streamSeq = h.streamSeq + 1n;
    const requestId = requestIdOf(o.slot, c);
    out.outbox.push({
      slot: o.slot, partition, stream: 'outcome', streamSeq, n: 0, topic: `${KIND}.outcome.v1`, msgKey: partition,
      headers: enc(`{"outcome_id":"${Buffer.from(requestId).toString('hex')}"}`), payload: o.filler.subarray(0, o.sizes.outboxBytes),
      generation: 1, epoch: o.epoch,
    });
    out.projections.push({ partition, requestId, state: 'decided', body: o.filler.subarray(0, o.sizes.projectionBytes) });
    state.set(c.partition, { seq, chain, streamSeq });
  }
  for (const p of order) {
    const h = state.get(p) as HeadState;
    out.heads.push({
      homeKey: homeKeyOf(o.slot, p, o.slots), partition: partitionKey(o.slot, p), slot: o.slot, generation: 1, adopted: true,
      seq: h.seq, epoch: o.epoch, streams: enc(`{"outcome":"${h.streamSeq}"}`), chain: h.chain, batchId: o.batchId,
    });
  }
  if (o.marker) {
    // §4.6 and C01 V59-6: the marker row is on the slot's partition '' and owner_slot carries the position.
    out.outbox.push({
      slot: o.slot, partition: EMPTY, stream: 'marker', streamSeq: o.marker.markerSeq, n: 0, topic: `${KIND}.outcome.v1`,
      msgKey: EMPTY, headers: enc('{}'), payload: o.filler.subarray(0, o.sizes.outboxBytes), generation: 1, epoch: o.epoch,
    });
    out.marker = { reportThrough: o.ts, markerSeq: o.marker.markerSeq };
  }
  return out;
}
