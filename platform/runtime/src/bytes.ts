export function hex(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');
}

export function fromHex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'hex'));
}

export function utf8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf8'));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

export function toBuffer(b: Uint8Array): Buffer {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts.map(toBuffer)));
}

/** JSON with bigint ("<n>n" tagged) and Uint8Array ({ $b: hex }) round-tripping. Deterministic key order. */
export function encodeJson(value: unknown): Uint8Array {
  return utf8(stableStringify(value));
}

export function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString('utf8'), (_k, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (typeof o['$b'] === 'string' && Object.keys(o).length === 1) return fromHex(o['$b']);
      if (typeof o['$n'] === 'string' && Object.keys(o).length === 1) return BigInt(o['$n']);
    }
    return v;
  });
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(v: unknown): unknown {
  if (typeof v === 'bigint') return { $n: v.toString() };
  if (v instanceof Uint8Array) return { $b: hex(v) };
  if (Array.isArray(v)) return v.map(normalise);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = normalise(x);
    }
    return out;
  }
  return v;
}
