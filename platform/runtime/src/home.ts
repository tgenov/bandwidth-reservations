import { createHash } from 'node:crypto';
import type { PartitionKey, SlotNo } from './api.ts';
import { PARAMS } from './params.ts';

const HOME_BITS = PARAMS.homeSpaceBits;
const HOME_MASK = (1 << HOME_BITS) - 1;

/**
 * home = hash(partition) mod 2^20 (C01 §2.3, RFC-006 §3.7). C01 does not fix the hash; this runtime
 * uses the first 4 bytes of SHA-256(partition), big-endian. Every slice must route with this function.
 */
export function home(partition: PartitionKey): number {
  const d = createHash('sha256').update(partition).digest();
  return d.readUInt32BE(0) & HOME_MASK;
}

/** home_key = the 20-bit reversal of home (R33-06): a slot's homes form one contiguous key range. */
export function reverseBits20(h: number): number {
  let r = 0;
  for (let i = 0; i < HOME_BITS; i++) r |= ((h >>> i) & 1) << (HOME_BITS - 1 - i);
  return r;
}

export function homeKey(partition: PartitionKey): number {
  return reverseBits20(home(partition));
}

/** Fixed map of I1: slot = home mod slotCount (no overrides, no moves; C01 §3.8). */
export function slotOfPartition(partition: PartitionKey, slotCount: number): SlotNo {
  return home(partition) % slotCount;
}

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}
