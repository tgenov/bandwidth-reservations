import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { stableStringify, toBuffer, utf8 } from './bytes.ts';

/** Associated data bound into every seal (C01 §3.12). */
export interface SealContext {
  ownerKind: string; table: string; primaryKey: unknown; seqOrVersion: bigint; epoch: bigint; rowKind: string;
}

/** C01 §3.12 binding of RFC-005 C13. The real library replaces DevSealer (plan B1). */
export interface Sealer {
  keyId(table: string): Uint8Array;
  /** Compresses, then seals with fresh nonces (so every retry reseals, C01 §3.12). */
  seal(plain: Uint8Array, ctx: SealContext): Uint8Array;
  open(sealed: Uint8Array, ctx: SealContext): Uint8Array;
  /**
   * Seals with a nonce derived from the key, the context and the plain bytes (a synthetic IV), so the same
   * input always gives the same bytes. For events that a self-outboxed kind's relay and gap fill derive
   * from a log row: every copy of one event must be byte-identical (C01 §3.5 D3). Not in C13 (see STATUS-I2.md).
   */
  sealDerived?(plain: Uint8Array, ctx: SealContext): Uint8Array;
}

function aad(ctx: SealContext, keyId: Uint8Array): Buffer {
  return Buffer.from(stableStringify({ ...ctx, keyId }), 'utf8');
}

/** Dev-only sealer: AES-256-GCM under a key derived from a fixed dev secret. Never for production. */
export class DevSealer implements Sealer {
  private readonly key: Buffer;
  constructor(secret = 'share-dev-sealer-not-for-production') {
    this.key = createHash('sha256').update(secret).digest();
  }
  keyId(table: string): Uint8Array {
    return utf8(`dev:${table}`);
  }
  seal(plain: Uint8Array, ctx: SealContext): Uint8Array {
    return this.sealWith(randomBytes(12), plain, ctx);
  }
  sealDerived(plain: Uint8Array, ctx: SealContext): Uint8Array {
    const iv = createHmac('sha256', this.key).update(aad(ctx, this.keyId(ctx.table))).update(toBuffer(plain)).digest().subarray(0, 12);
    return this.sealWith(iv, plain, ctx);
  }
  private sealWith(iv: Buffer, plain: Uint8Array, ctx: SealContext): Uint8Array {
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(aad(ctx, this.keyId(ctx.table)));
    const body = Buffer.concat([c.update(deflateRawSync(toBuffer(plain))), c.final()]);
    return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), body]));
  }
  open(sealed: Uint8Array, ctx: SealContext): Uint8Array {
    const b = toBuffer(sealed);
    const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    d.setAAD(aad(ctx, this.keyId(ctx.table)));
    d.setAuthTag(b.subarray(12, 28));
    return new Uint8Array(inflateRawSync(Buffer.concat([d.update(b.subarray(28)), d.final()])));
  }
}
