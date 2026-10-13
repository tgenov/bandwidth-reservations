/** Micro-USD as C06 writes it: a signed decimal integer string, never a float (C06 "Conventions"). */
import { createHash } from 'node:crypto';
import { encodeJson } from '@share/owner-runtime';
import type { MicroUsd, SourceRef } from './contracts/c06.ts';

const SIGNED_INT = /^-?(0|[1-9][0-9]*)$/;

/** The amount of a C06 money string, or undefined if the string is not a canonical signed integer. */
export function parseMicro(s: unknown): bigint | undefined {
  if (typeof s !== 'string' || !SIGNED_INT.test(s) || s === '-0') return undefined;
  return BigInt(s);
}

/** The C06 money string of an amount. */
export function micro(n: bigint): MicroUsd {
  return n.toString();
}

/** SHA-256 of a deterministic JSON form of a value (key order does not change it), as hex. */
export function digestOf(value: unknown): string {
  return createHash('sha256').update(encodeJson(value)).digest('hex');
}

/** The fields of each SourceRef kind in schema order (C06 §5). */
const FIELDS: Record<SourceRef['kind'], readonly string[]> = {
  reservation: ['reservation', 'minute', 'seq'],
  usage: ['account', 'product', 'route', 'minute', 'seq'],
  fee: ['reservation', 'feeId'],
  residue_fee: ['request', 'partnerLink', 'feeId'],
  carried_excess: ['account', 'product', 'route', 'minute', 'seq'],
  dearer_path: ['reservation', 'minute', 'seq'],
};

const MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;

/** True if the value is a SourceRef of a known kind with every field of the right type. */
export function isSourceRef(v: unknown): v is SourceRef {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const fields = typeof r['kind'] === 'string' ? FIELDS[r['kind'] as SourceRef['kind']] : undefined;
  if (!fields) return false;
  for (const f of fields) {
    const x = r[f];
    if (f === 'seq') { if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) return false; }
    else if (f === 'minute') { if (typeof x !== 'string' || !MINUTE.test(x)) return false; }
    else if (typeof x !== 'string' || x.length === 0) return false;
  }
  return true;
}

function encode(values: string[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const s of values) {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length, 0);
    parts.push(len, b);
  }
  return new Uint8Array(Buffer.concat(parts));
}

function values(ref: SourceRef, withSeq: boolean): string[] {
  const r = ref as unknown as Record<string, unknown>;
  const out: string[] = [ref.kind];
  for (const f of FIELDS[ref.kind]) {
    if (f === 'seq' && !withSeq) continue;
    out.push(f === 'seq' ? String(r[f] as number) : String(r[f]));
  }
  return out;
}

/**
 * The canonical SourceRef encoding (C06 "Conventions"): the kind tag, then the fields in schema order, each
 * with a u32 big-endian length prefix; integers as decimal strings with no leading zeros.
 */
export function canonicalSourceRef(ref: SourceRef): Uint8Array {
  return encode(values(ref, true));
}

/** SHA-256 of the canonical encoding, as hex: the ledger's dedup key of one line posting (C06 M2). */
export function sourceRefDigest(ref: SourceRef): string {
  return createHash('sha256').update(canonicalSourceRef(ref)).digest('hex');
}

/** The amendment sequence of a SourceRef (0 for the kinds that have none: fees). */
export function seqOf(ref: SourceRef): number {
  return 'seq' in ref ? ref.seq : 0;
}

/** SHA-256 (hex) of the line key: the canonical encoding without the amendment sequence (RFC-004 §B1.4). */
export function lineKeyDigest(ref: SourceRef): string {
  return createHash('sha256').update(encode(['line', ...values(ref, false)])).digest('hex');
}
