/**
 * The probe-account set summary (C01 §2.7 `ProbeSetSummary`, §3.8, §3.10; RFC-006 §7.1; C08 S-M3).
 *
 * setDigest = SHA-256 over the sorted pairs (slot int32 big-endian ‖ account bytes) of probeAccountSet(v).
 * C01 says that the signature covers "the four fields" but does not define the signed bytes. This module signs:
 *   "placement.probe_set_summary.v1" ‖ 0x00 ‖ mapVersion int64 BE ‖ slotCount int32 BE ‖ probeAccountCount int32 BE
 *   ‖ setDigest (32 bytes).
 * The domain tag keeps a summary signature from being valid for other data that the same key signs.
 * The production signer is RFC-005's signing service; `DevSummarySigner` is an Ed25519 key for tests and the dev cell.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import type { MapVersion, SlotNo } from '../api.ts';
import { concat, hex, toBuffer, utf8 } from '../bytes.ts';

/** C01 §2.7: the signed target summary of the probe-account set of one map version. */
export interface ProbeSetSummary {
  mapVersion: MapVersion; slotCount: number; probeAccountCount: number;
  /** SHA-256 over the sorted [(slot int32 BE, account bytes)] of probeAccountSet(v). */
  setDigest: Uint8Array;
  /** Placement's summary-signing key, over `probeSetSummaryBytes` of the four fields above. */
  signature: Uint8Array;
  keyId: string;
}

/** One member of a probe-account set: the probe account of one account slot. */
export interface ProbeMember { slot: SlotNo; account: Uint8Array }

/** Placement's summary-signing key (RFC-005 signing service; C08 S-M3). */
export interface SummarySigner {
  readonly keyId: string;
  sign(bytes: Uint8Array): Uint8Array;
}

const DOMAIN = concat([utf8('placement.probe_set_summary.v1'), new Uint8Array([0])]);
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** A copy of the set in digest order: by slot, then by account bytes. */
export function sortProbeSet(set: ProbeMember[]): ProbeMember[] {
  return [...set].sort((a, b) => a.slot - b.slot || Buffer.compare(toBuffer(a.account), toBuffer(b.account)));
}

/** C01 §2.7 setDigest: SHA-256 over the sorted (slot int32 BE ‖ account bytes) pairs. */
export function probeSetDigest(set: ProbeMember[]): Uint8Array {
  const h = createHash('sha256');
  for (const m of sortProbeSet(set)) {
    const slot = Buffer.alloc(4);
    slot.writeInt32BE(m.slot);
    h.update(slot);
    h.update(m.account);
  }
  return new Uint8Array(h.digest());
}

/** The bytes that the summary signature covers (this module's definition; C01 does not define them). */
export function probeSetSummaryBytes(f: { mapVersion: MapVersion; slotCount: number; probeAccountCount: number; setDigest: Uint8Array }): Uint8Array {
  const b = Buffer.alloc(16);
  b.writeBigInt64BE(f.mapVersion, 0);
  b.writeInt32BE(f.slotCount, 8);
  b.writeInt32BE(f.probeAccountCount, 12);
  return concat([DOMAIN, new Uint8Array(b), f.setDigest]);
}

/** Builds and signs the summary of one probe-account set. */
export function signProbeSetSummary(mapVersion: MapVersion, slotCount: number, set: ProbeMember[], signer: SummarySigner): ProbeSetSummary {
  const fields = { mapVersion, slotCount, probeAccountCount: set.length, setDigest: probeSetDigest(set) };
  return { ...fields, signature: signer.sign(probeSetSummaryBytes(fields)), keyId: signer.keyId };
}

/** True when the signature of `summary` is valid for the four fields under the raw 32-byte Ed25519 public key. */
export function verifyProbeSetSummary(summary: ProbeSetSummary, publicKey: Uint8Array): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, toBuffer(publicKey)]), format: 'der', type: 'spki' });
    return verify(null, probeSetSummaryBytes(summary), key, summary.signature);
  } catch {
    return false;
  }
}

/** A development Ed25519 summary signer from a fixed 32-byte seed (tests and the dev cell; not RFC-005's service). */
export class DevSummarySigner implements SummarySigner {
  readonly keyId: string;
  private readonly key: KeyObject;

  constructor(o: { seed: Uint8Array; keyId?: string }) {
    if (o.seed.byteLength !== 32) throw new Error(`DevSummarySigner: the seed must be 32 bytes, not ${o.seed.byteLength}`);
    this.key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, toBuffer(o.seed)]), format: 'der', type: 'pkcs8' });
    this.keyId = o.keyId ?? `dev-ed25519-${hex(this.publicKey()).slice(0, 16)}`;
  }

  /** The raw 32-byte Ed25519 public key. */
  publicKey(): Uint8Array {
    const der = createPublicKey(this.key).export({ format: 'der', type: 'spki' });
    return new Uint8Array(der.subarray(der.length - 32));
  }

  sign(bytes: Uint8Array): Uint8Array {
    return new Uint8Array(sign(null, bytes, this.key));
  }
}
