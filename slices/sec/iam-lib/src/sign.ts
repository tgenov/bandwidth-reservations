/**
 * Ed25519 signatures with C08 domain strings.
 *
 * Signed bytes: UTF-8(domain) ‖ E(JCS(object without its signature field)). C08 fixes JCS, E() and the
 * domain strings, but does not say how the domain joins the bytes. This library uses the same form as
 * the chain of C08 §J (domain bytes first, then framed fields). The P-01 golden vectors publish it.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { frame, jcs } from './jcs.ts';

export const DOMAINS = {
  keyCert: 'share-key-cert-v1',
  keyRevoke: 'share-key-revoke-v1',
  certHeartbeat: 'share-cert-heartbeat-v1',
  keyRecord: 'share-key-record-v1',
  edgeRecord: 'share-edge-record-v1',
  edgeHeartbeat: 'share-edge-heartbeat-v1',
  policy: 'share-policy-v1',
} as const;
export type Domain = (typeof DOMAINS)[keyof typeof DOMAINS];

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface Ed25519KeyPair {
  privateKey: KeyObject;
  /** Raw 32-byte public key. */
  publicKey: Uint8Array;
}

function rawPublic(pub: KeyObject): Uint8Array {
  const der = pub.export({ format: 'der', type: 'spki' });
  return new Uint8Array(der.subarray(der.byteLength - 32));
}

/** A fresh key pair. The private key stays in this process's memory only. */
export function generateKeyPair(): Ed25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: rawPublic(publicKey) };
}

/** A key pair from a 32-byte seed. Use it ONLY for published test vectors. */
export function keyPairFromSeed(seed: Uint8Array): Ed25519KeyPair {
  if (seed.byteLength !== 32) throw new Error('an Ed25519 seed has 32 bytes');
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return { privateKey, publicKey: rawPublic(createPublicKey(privateKey)) };
}

export function publicKeyObject(raw: Uint8Array): KeyObject {
  if (raw.byteLength !== 32) throw new Error('an Ed25519 public key has 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** The bytes that a signature covers. */
export function signingInput(domain: Domain, unsigned: unknown): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from(domain, 'utf8'), frame(jcs(unsigned))]));
}

export function signObject(domain: Domain, unsigned: unknown, privateKey: KeyObject): Uint8Array {
  return new Uint8Array(sign(null, signingInput(domain, unsigned), privateKey));
}

export function verifyObject(domain: Domain, unsigned: unknown, sig: Uint8Array, publicKey: Uint8Array): boolean {
  if (sig.byteLength !== 64) return false;
  try {
    return verify(null, signingInput(domain, unsigned), publicKeyObject(publicKey), sig);
  } catch {
    return false;
  }
}
