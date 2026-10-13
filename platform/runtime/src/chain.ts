import { createHash } from 'node:crypto';
import { toBuffer } from './bytes.ts';

/** Inputs of one chain link: the stored columns of a `<kind>_log` row (C08 §J). `ts` is not covered. */
export interface ChainRow {
  kindName: string; partition: Uint8Array; seq: bigint; slot: number; generation: number; epoch: bigint;
  entryKind: number; schemaV: number; identity: Uint8Array; emits: Uint8Array; retention: number;
  keyId: Uint8Array; audit: Uint8Array; payload: Uint8Array;
}

function e(b: Uint8Array): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(b.byteLength, 0);
  return Buffer.concat([len, toBuffer(b)]);
}
function u(width: 2 | 4 | 8, v: number | bigint): Buffer {
  const out = Buffer.alloc(width);
  if (width === 8) out.writeBigUInt64BE(BigInt.asUintN(64, BigInt(v)), 0);
  else if (width === 4) out.writeUInt32BE(Number(v) >>> 0, 0);
  else out.writeUInt16BE(Number(v) & 0xffff, 0);
  return out;
}
const str = (s: string): Buffer => e(Buffer.from(s, 'utf8'));

/** chain_0 = SHA-256("share-chain-v1-genesis" ‖ E(kind name) ‖ E(partition)) (C08 §J). */
export function chainGenesis(kindName: string, partition: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256')
    .update('share-chain-v1-genesis').update(str(kindName)).update(e(partition)).digest());
}

/** chain_n per C08 §J, over the stored (sealed) column bytes. */
export function chainNext(prev: Uint8Array, r: ChainRow): Uint8Array {
  return new Uint8Array(createHash('sha256')
    .update('share-chain-v1').update(toBuffer(prev))
    .update(str(r.kindName)).update(e(r.partition))
    .update(u(8, r.seq)).update(u(4, r.slot)).update(u(4, r.generation)).update(u(8, r.epoch))
    .update(u(2, r.entryKind)).update(u(2, r.schemaV))
    .update(e(r.identity)).update(e(r.emits)).update(u(2, r.retention))
    .update(e(r.keyId)).update(e(r.audit)).update(e(r.payload))
    .digest());
}
