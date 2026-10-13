/**
 * Agent and supplier bearer keys (RFC-005 §2.1): `shk_<key id>_<secret><check>` (or `ssk_`).
 *
 * - key id: 32 lowercase hex characters (Id128, random);
 * - secret: 256-bit random, 43 base64url characters; Share keeps only SHA-256(secret);
 * - check: one character of CHECK_ALPHABET, from SHA-256 of the text before it.
 * RFC-005 names a check digit but no contract fixes its algorithm. This is the I1 choice.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { b64url } from './jcs.ts';

const CHECK_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const TOKEN = /^(shk|ssk)_([0-9a-f]{32})_([A-Za-z0-9_-]{43})([0-9a-z])$/;

export interface ParsedKey { prefix: 'shk' | 'ssk'; key_id: string; secret: Uint8Array }

function checkChar(body: string): string {
  const d = createHash('sha256').update(body, 'utf8').digest();
  return CHECK_ALPHABET[(d[0] ?? 0) % CHECK_ALPHABET.length] ?? '0';
}

export function verifierOf(secret: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(secret).digest());
}

/** Mint a new key. The caller shows `token` once and keeps only `verifier`. */
export function mintKey(prefix: 'shk' | 'ssk' = 'shk'): { key_id: string; token: string; verifier: Uint8Array } {
  const key_id = randomBytes(16).toString('hex');
  const secret = new Uint8Array(randomBytes(32));
  const body = `${prefix}_${key_id}_${b64url(secret)}`;
  return { key_id, token: body + checkChar(body), verifier: verifierOf(secret) };
}

/** Pipeline step 3 (RFC-005 §2.2): parse and check digit. `undefined` = malformed. */
export function parseKey(token: string): ParsedKey | undefined {
  const m = TOKEN.exec(token);
  if (!m) return undefined;
  const [, prefix, key_id, secret64, check] = m;
  if (!prefix || !key_id || !secret64 || !check) return undefined;
  if (checkChar(`${prefix}_${key_id}_${secret64}`) !== check) return undefined;
  const secret = new Uint8Array(Buffer.from(secret64, 'base64url'));
  if (secret.byteLength !== 32) return undefined;
  return { prefix: prefix as 'shk' | 'ssk', key_id, secret };
}

/** Constant-time comparison of SHA-256(secret) with a stored verifier (RFC-005 §2.1). */
export function secretMatches(secret: Uint8Array, verifier: Uint8Array): boolean {
  const v = verifierOf(secret);
  return v.byteLength === verifier.byteLength && timingSafeEqual(v, verifier);
}
