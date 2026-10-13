/**
 * The protobuf codec of placement's integrity stop (C01 §2.6), encoded by hand (proto3). It does not import the
 * gRPC library, so it is usable and testable alone. The schema:
 *
 *   package share.placement.v1;
 *   message StopRequest   { string kind = 1; bytes partition = 2; bytes detection_ref = 3; }
 *   message ResumeRequest { string kind = 1; bytes partition = 2; bytes detection_ref = 3; bytes checkpoint = 4;
 *                           bytes incident_decision_ref = 5; }
 *   message StopAck { enum State { STOPPED = 0; RESUMED = 1; } State state = 1; string enforced_at = 2;
 *                     repeated int32 fenced_slots = 3; }
 *
 * An empty `incident_decision_ref` means "not given" (proto3 has no presence for bytes).
 */
import type { SlotNo } from '../api.ts';
import { hlc } from '../hlc.ts';
import type { ResumeRequest, StopAck, StopRequest } from './integrity-stop.ts';

/** The refusal codes of the integrity stop decoder. */
export type IntegrityStopCodecErrorCode = 'TRUNCATED' | 'MALFORMED' | 'BAD_TS' | 'MISSING_FIELD';
/** All codec refusal codes. */
export const INTEGRITY_STOP_CODEC_ERROR_CODES: readonly IntegrityStopCodecErrorCode[] = ['TRUNCATED', 'MALFORMED', 'BAD_TS', 'MISSING_FIELD'];

/** A message that does not decode. */
export class IntegrityStopCodecError extends Error {
  readonly code: IntegrityStopCodecErrorCode;
  constructor(code: IntegrityStopCodecErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'IntegrityStopCodecError';
    this.code = code;
  }
}

// ---------------- protobuf wire format ----------------

const VARINT = 0;
const FIXED64 = 1;
const LEN = 2;
const FIXED32 = 5;
const U32_MAX = 0xffff_ffffn;
const U64_MAX = (1n << 64n) - 1n;
const I32_MAX = 0x7fff_ffff;
const UTF8_IN = new TextDecoder('utf-8', { fatal: true });
const UTF8_OUT = new TextEncoder();

class Writer {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;
  private add(b: Uint8Array): void { this.chunks.push(b); this.size += b.byteLength; }
  varint(v: bigint): this {
    const out: number[] = [];
    let x = v;
    while (x >= 0x80n) { out.push(Number(x & 0x7fn) | 0x80); x >>= 7n; }
    out.push(Number(x));
    this.add(Uint8Array.from(out));
    return this;
  }
  uint(field: number, v: bigint | number, max: bigint): this {
    const b = BigInt(v);
    if (b < 0n || b > max) throw new RangeError(`field ${field}: ${b} is out of range`);
    this.varint(BigInt(field << 3 | VARINT));
    return this.varint(b);
  }
  bytes(field: number, b: Uint8Array): this {
    this.varint(BigInt(field << 3 | LEN));
    this.varint(BigInt(b.byteLength));
    this.add(b);
    return this;
  }
  text(field: number, s: string): this { return this.bytes(field, UTF8_OUT.encode(s)); }
  finish(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) { out.set(c, at); at += c.byteLength; }
    return out;
  }
}

class Reader {
  private pos = 0;
  private readonly buf: Uint8Array;
  // A plain Uint8Array view, so `slice` copies (Buffer.slice gives a view of a pooled buffer) and fields are Uint8Array.
  constructor(buf: Uint8Array) { this.buf = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength); }
  done(): boolean { return this.pos >= this.buf.byteLength; }
  varint(): bigint {
    let v = 0n;
    for (let i = 0; i < 10; i++) {
      const b = this.buf[this.pos++];
      if (b === undefined) throw new IntegrityStopCodecError('TRUNCATED', 'the bytes end inside a varint');
      v |= BigInt(b & 0x7f) << BigInt(7 * i);
      if ((b & 0x80) === 0) {
        if (v > U64_MAX) throw new IntegrityStopCodecError('MALFORMED', 'a varint is above 2^64 - 1');
        return v;
      }
    }
    throw new IntegrityStopCodecError('MALFORMED', 'a varint is longer than 10 bytes');
  }
  tag(): { field: number; wire: number } {
    const t = this.varint();
    if (t > U32_MAX) throw new IntegrityStopCodecError('MALFORMED', 'a field tag is out of range');
    return { field: Number(t >> 3n), wire: Number(t & 7n) };
  }
  bytes(): Uint8Array {
    const n = this.varint();
    if (n > BigInt(this.buf.byteLength - this.pos)) throw new IntegrityStopCodecError('TRUNCATED', 'the bytes end inside a field');
    const out = this.buf.slice(this.pos, this.pos + Number(n));
    this.pos += Number(n);
    return out;
  }
  skip(wire: number): void {
    const by = wire === FIXED64 ? 8 : wire === FIXED32 ? 4 : -1;
    if (wire === VARINT) { this.varint(); return; }
    if (wire === LEN) { this.bytes(); return; }
    if (by < 0) throw new IntegrityStopCodecError('MALFORMED', `wire type ${wire} is not supported`);
    if (this.pos + by > this.buf.byteLength) throw new IntegrityStopCodecError('TRUNCATED', 'the bytes end inside a fixed field');
    this.pos += by;
  }
}

function want(wire: number, expected: number, field: number): void {
  if (wire !== expected) throw new IntegrityStopCodecError('MALFORMED', `field ${field} has wire type ${wire}, not ${expected}`);
}
function text(b: Uint8Array, field: number): string {
  try { return UTF8_IN.decode(b); } catch { throw new IntegrityStopCodecError('MALFORMED', `field ${field} is not UTF-8`); }
}
/** An int32 slot number: the varint's low 32 bits as a signed value; a slot is never negative. */
function slot(v: bigint): SlotNo {
  const n = Number(BigInt.asIntN(32, v));
  if (n < 0) throw new IntegrityStopCodecError('MALFORMED', `fenced slot ${n} is negative`);
  return n;
}

/** Encodes a `StopRequest`. */
export function encodeStopRequest(r: StopRequest): Uint8Array {
  return new Writer().text(1, r.kind).bytes(2, r.partition).bytes(3, r.detectionRef).finish();
}

/** Encodes a `ResumeRequest`. An absent incident decision is not written. */
export function encodeResumeRequest(r: ResumeRequest): Uint8Array {
  const w = new Writer().text(1, r.kind).bytes(2, r.partition).bytes(3, r.detectionRef).bytes(4, r.checkpoint);
  if (r.incidentDecisionRef !== undefined && r.incidentDecisionRef.byteLength > 0) w.bytes(5, r.incidentDecisionRef);
  return w.finish();
}

function decodeRequest(buf: Uint8Array): ResumeRequest {
  const e = new Uint8Array();
  const r: ResumeRequest = { kind: '', partition: e, detectionRef: e, checkpoint: e };
  const rd = new Reader(buf);
  while (!rd.done()) {
    const { field, wire } = rd.tag();
    switch (field) {
      case 1: want(wire, LEN, field); r.kind = text(rd.bytes(), field); break;
      case 2: want(wire, LEN, field); r.partition = rd.bytes(); break;
      case 3: want(wire, LEN, field); r.detectionRef = rd.bytes(); break;
      case 4: want(wire, LEN, field); r.checkpoint = rd.bytes(); break;
      case 5: { want(wire, LEN, field); const b = rd.bytes(); if (b.byteLength > 0) r.incidentDecisionRef = b; else delete r.incidentDecisionRef; break; }
      default: rd.skip(wire);
    }
  }
  if (r.kind === '') throw new IntegrityStopCodecError('MISSING_FIELD', 'kind is empty');
  if (r.detectionRef.byteLength === 0) throw new IntegrityStopCodecError('MISSING_FIELD', 'detection_ref is empty');
  return r;
}

/** Decodes a `StopRequest`. Unknown fields are skipped. An empty kind or detection_ref is `MISSING_FIELD`. */
export function decodeStopRequest(buf: Uint8Array): StopRequest {
  const r = decodeRequest(buf);
  return { kind: r.kind, partition: r.partition, detectionRef: r.detectionRef };
}

/** Decodes a `ResumeRequest`. Unknown fields are skipped. An empty kind or detection_ref is `MISSING_FIELD`. */
export function decodeResumeRequest(buf: Uint8Array): ResumeRequest {
  return decodeRequest(buf);
}

/** Encodes a `StopAck`; `fenced_slots` is packed. */
export function encodeStopAck(a: StopAck): Uint8Array {
  const w = new Writer().uint(1, a.state === 'STOPPED' ? 0 : 1, 1n).text(2, a.enforcedAt);
  if (a.fencedSlots.length > 0) {
    const packed = new Writer();
    for (const s of a.fencedSlots) {
      if (!Number.isInteger(s) || s < 0 || s > I32_MAX) throw new RangeError(`fenced slot ${s} is out of range`);
      packed.varint(BigInt(s));
    }
    w.bytes(3, packed.finish());
  }
  return w.finish();
}

/** Decodes a `StopAck`. Accepts `fenced_slots` packed and unpacked. An unknown state is `MALFORMED`. */
export function decodeStopAck(buf: Uint8Array): StopAck {
  let state: StopAck['state'] = 'STOPPED';
  let at = '';
  const fencedSlots: SlotNo[] = [];
  const rd = new Reader(buf);
  while (!rd.done()) {
    const { field, wire } = rd.tag();
    switch (field) {
      case 1: {
        want(wire, VARINT, field);
        const v = rd.varint();
        if (v > 1n) throw new IntegrityStopCodecError('MALFORMED', `state ${v} is not STOPPED or RESUMED`);
        state = v === 0n ? 'STOPPED' : 'RESUMED';
        break;
      }
      case 2: want(wire, LEN, field); at = text(rd.bytes(), field); break;
      case 3:
        if (wire === VARINT) { fencedSlots.push(slot(rd.varint())); break; }
        want(wire, LEN, field);
        { const p = new Reader(rd.bytes()); while (!p.done()) fencedSlots.push(slot(p.varint())); }
        break;
      default: rd.skip(wire);
    }
  }
  if (at === '') throw new IntegrityStopCodecError('BAD_TS', 'enforced_at is empty');
  let enforcedAt: StopAck['enforcedAt'];
  try { enforcedAt = hlc(at); } catch { throw new IntegrityStopCodecError('BAD_TS', `enforced_at "${at}" is not an HLC timestamp`); }
  return { state, enforcedAt, fencedSlots };
}
