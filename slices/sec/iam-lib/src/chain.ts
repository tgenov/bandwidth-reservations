/**
 * Reference implementation of the C08 §J chain, written from the contract text only. Audit uses it to
 * verify the chain that the owner runtime writes; the P-01 golden vectors come from it.
 *
 * chain_0 = SHA-256("share-chain-v1-genesis" ‖ E(kind name) ‖ E(partition))
 * chain_n = SHA-256("share-chain-v1" ‖ chain_{n−1} ‖ E(kind name) ‖ E(partition) ‖ U64(seq) ‖ U32(slot)
 *                   ‖ U32(generation) ‖ U64(epoch) ‖ U16(kind) ‖ U16(schema_v) ‖ E(identity) ‖ E(emits)
 *                   ‖ U16(retention) ‖ E(key_id) ‖ E(audit) ‖ E(payload))
 */
import { createHash } from 'node:crypto';
import { frame } from './jcs.ts';

export interface ChainInput {
  kindName: string; partition: Uint8Array; seq: bigint; slot: number; generation: number; epoch: bigint;
  entryKind: number; schemaV: number; identity: Uint8Array; emits: Uint8Array; retention: number;
  keyId: Uint8Array; audit: Uint8Array; payload: Uint8Array;
}

const enc = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

function uint(width: 2 | 4 | 8, v: number | bigint): Uint8Array {
  const b = Buffer.alloc(width);
  const n = BigInt(v);
  if (n < 0n || n >= 1n << BigInt(width * 8)) throw new Error(`U${width * 8} out of range: ${n}`);
  if (width === 8) b.writeBigUInt64BE(n);
  else if (width === 4) b.writeUInt32BE(Number(n));
  else b.writeUInt16BE(Number(n));
  return new Uint8Array(b);
}

/** Signed int16 entry kinds are written as their two's-complement U16. */
const u16kind = (k: number): Uint8Array => uint(2, k < 0 ? k + 0x10000 : k);

export function genesis(kindName: string, partition: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256')
    .update(enc('share-chain-v1-genesis')).update(frame(enc(kindName))).update(frame(partition)).digest());
}

export function link(prev: Uint8Array, r: ChainInput): Uint8Array {
  if (prev.byteLength !== 32) throw new Error('chain value has 32 bytes');
  const h = createHash('sha256').update(enc('share-chain-v1')).update(prev)
    .update(frame(enc(r.kindName))).update(frame(r.partition))
    .update(uint(8, r.seq)).update(uint(4, r.slot)).update(uint(4, r.generation)).update(uint(8, r.epoch))
    .update(u16kind(r.entryKind)).update(uint(2, r.schemaV))
    .update(frame(r.identity)).update(frame(r.emits)).update(uint(2, r.retention))
    .update(frame(r.keyId)).update(frame(r.audit)).update(frame(r.payload));
  return new Uint8Array(h.digest());
}

export interface ChainedRow extends ChainInput { chain: Uint8Array }

export interface ChainBreak { partitionHex: string; seq: bigint; reason: 'gap' | 'mismatch' }

/**
 * Verify every partition's chain from genesis. Rows of one partition must start at seq 1 and have no gap
 * (a reader never accepts a gap, C08 §J). Answers the first break of each partition.
 */
export function verifyChains(rows: ChainedRow[]): { ok: boolean; checked: number; breaks: ChainBreak[] } {
  const byPartition = new Map<string, ChainedRow[]>();
  for (const r of rows) {
    const k = Buffer.from(r.partition).toString('hex');
    const list = byPartition.get(k) ?? [];
    list.push(r);
    byPartition.set(k, list);
  }
  const breaks: ChainBreak[] = [];
  let checked = 0;
  for (const [k, list] of byPartition) {
    list.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    const first = list[0];
    if (!first) continue;
    let prev = genesis(first.kindName, first.partition);
    let expectSeq = 1n;
    for (const r of list) {
      if (r.seq !== expectSeq) { breaks.push({ partitionHex: k, seq: expectSeq, reason: 'gap' }); break; }
      const want = link(prev, r);
      checked++;
      if (Buffer.compare(Buffer.from(want), Buffer.from(r.chain)) !== 0) {
        breaks.push({ partitionHex: k, seq: r.seq, reason: 'mismatch' });
        break;
      }
      prev = want;
      expectSeq++;
    }
  }
  return { ok: breaks.length === 0, checked, breaks };
}
