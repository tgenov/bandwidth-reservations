/**
 * Canonical bytes of C08 ("Canonical bytes"): RFC 8785 JSON Canonicalization Scheme (JCS), and the
 * frame E(x) = 4-byte big-endian length ‖ bytes.
 *
 * Mapping of values that JSON does not have (C08 "Units"):
 * - bigint (EpochMicros, int64 money and capacity) → decimal string;
 * - Uint8Array → base64url without padding.
 * A field with the value `undefined` is not written (the field is absent).
 */

export function b64url(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64url');
}

export function fromB64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

function ser(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      // RFC 8785 §3.2.2.3: the ECMAScript number serialisation, which JSON.stringify uses.
      if (!Number.isFinite(v)) throw new Error('JCS: a number must be finite');
      return JSON.stringify(v);
    case 'bigint':
      return JSON.stringify(v.toString());
    case 'string':
      return JSON.stringify(v);
    case 'object': {
      if (v instanceof Uint8Array) return JSON.stringify(b64url(v));
      if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : ser(x))).join(',')}]`;
      const o = v as Record<string, unknown>;
      // RFC 8785 §3.2.3: sort the property names by their UTF-16 code units (the default JS sort).
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${ser(o[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`JCS: cannot encode a value of type ${typeof v}`);
  }
}

/** JCS text of a value. */
export function jcsText(value: unknown): string {
  return ser(value);
}

/** JCS bytes (UTF-8) of a value. */
export function jcs(value: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(ser(value), 'utf8'));
}

/** E(x) = U32 big-endian length ‖ bytes (C08 "Canonical bytes" and §J). */
export function frame(b: Uint8Array): Uint8Array {
  const out = Buffer.alloc(4 + b.byteLength);
  out.writeUInt32BE(b.byteLength, 0);
  out.set(b, 4);
  return new Uint8Array(out);
}

/** A copy of `obj` without the named field (the signature field of a signed object). */
export function without<T extends object, K extends keyof T>(obj: T, field: K): Omit<T, K> {
  const copy = { ...obj };
  delete copy[field];
  return copy;
}
