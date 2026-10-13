/**
 * The gRPC transport of the standby push (RFC-006 §4.4; plan S-PLAT-I2 work item 2).
 *
 * The holder pushes every `Committed` batch to its hot standbys over gRPC "without waiting for an acknowledgement".
 * One client stream per (holder process, standby process), as for status readers (RFC-006 §4.6). The holder side
 * (`GrpcStandbyChannel`) is a `StandbyChannel`: `push` never blocks and never throws. A push that cannot go (the
 * stream queue is full, the stream broke, the channel is closed) is dropped; the standby's follower-read tail
 * (`standby_poll`) gives the missing rows, and `StandbyTail` applies a push only when its seq continues. The
 * standby side (`GrpcStandbyServer`) gives each push, in stream order, to the standby runtime's `standbyChannel()`.
 *
 * The wire format is protobuf (proto3), encoded here by hand:
 *
 *   package share.owner.standby.v1;
 *   service Standby { rpc Push(stream StandbyPush) returns (PushAck); }
 *   message StandbyPush { string kind = 1; uint32 slot = 2; uint64 epoch = 3; string ts = 4; string prev_ts = 5;
 *                         bool advances = 6; repeated LogRow rows = 7; }
 *   message LogRow { uint32 slot = 1; bytes partition = 2; uint64 seq = 3; uint32 generation = 4; uint64 epoch = 5;
 *                    uint32 kind = 6; uint32 schema_v = 7; bytes identity = 8; bytes emits = 9; bytes audit = 10;
 *                    uint32 retention = 11; bytes key_id = 12; bytes payload = 13; bytes chain = 14; }
 *   message PushAck { uint64 received = 1; }
 *
 * The payload of a row stays sealed under the partition's log key on the wire (C01 §3.12).
 */
import grpc from '@grpc/grpc-js';
import type { ChannelCredentials, ClientWritableStream, ServerCredentials, ServerReadableStream, sendUnaryData } from '@grpc/grpc-js';
import { hlc } from '../hlc.ts';
import type { LogRowWrite } from '../store/types.ts';
import type { StandbyChannel, StandbyPush } from './tail.ts';

/** The gRPC method path of the push stream. */
export const STANDBY_PUSH_PATH = '/share.owner.standby.v1.Standby/Push';

/** Pushes queued on one stream (not yet taken by HTTP/2) before the next push is dropped (est.). */
export const STANDBY_PUSH_QUEUE_MAX = 1_024;

/** The refusal codes of the push decoder. */
export type StandbyCodecErrorCode = 'TRUNCATED' | 'MALFORMED' | 'BAD_TS';

/** A push that does not decode. */
export class StandbyCodecError extends Error {
  readonly code: StandbyCodecErrorCode;
  constructor(code: StandbyCodecErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'StandbyCodecError';
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
const UTF8_IN = new TextDecoder('utf-8', { fatal: true });
const UTF8_OUT = new TextEncoder();

class Writer {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;
  private add(b: Uint8Array): void { this.chunks.push(b); this.size += b.byteLength; }
  private varint(v: bigint): void {
    const out: number[] = [];
    let x = v;
    while (x >= 0x80n) { out.push(Number(x & 0x7fn) | 0x80); x >>= 7n; }
    out.push(Number(x));
    this.add(Uint8Array.from(out));
  }
  uint(field: number, v: bigint | number, max: bigint): this {
    const b = BigInt(v);
    if (b < 0n || b > max) throw new RangeError(`field ${field}: ${b} is out of range`);
    this.varint(BigInt(field << 3 | VARINT));
    this.varint(b);
    return this;
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
      if (b === undefined) throw new StandbyCodecError('TRUNCATED', 'the bytes end inside a varint');
      v |= BigInt(b & 0x7f) << BigInt(7 * i);
      if ((b & 0x80) === 0) {
        if (v > U64_MAX) throw new StandbyCodecError('MALFORMED', 'a varint is above 2^64 - 1');
        return v;
      }
    }
    throw new StandbyCodecError('MALFORMED', 'a varint is longer than 10 bytes');
  }
  tag(): { field: number; wire: number } {
    const t = this.varint();
    if (t > U32_MAX) throw new StandbyCodecError('MALFORMED', 'a field tag is out of range');
    return { field: Number(t >> 3n), wire: Number(t & 7n) };
  }
  bytes(): Uint8Array {
    const n = this.varint();
    if (n > BigInt(this.buf.byteLength - this.pos)) throw new StandbyCodecError('TRUNCATED', 'the bytes end inside a field');
    const out = this.buf.slice(this.pos, this.pos + Number(n));
    this.pos += Number(n);
    return out;
  }
  skip(wire: number): void {
    const by = wire === FIXED64 ? 8 : wire === FIXED32 ? 4 : -1;
    if (wire === VARINT) { this.varint(); return; }
    if (wire === LEN) { this.bytes(); return; }
    if (by < 0) throw new StandbyCodecError('MALFORMED', `wire type ${wire} is not supported`);
    if (this.pos + by > this.buf.byteLength) throw new StandbyCodecError('TRUNCATED', 'the bytes end inside a fixed field');
    this.pos += by;
  }
}

function want(wire: number, expected: number, field: number): void {
  if (wire !== expected) throw new StandbyCodecError('MALFORMED', `field ${field} has wire type ${wire}, not ${expected}`);
}
function u32(v: bigint, field: number): number {
  if (v > U32_MAX) throw new StandbyCodecError('MALFORMED', `field ${field} does not fit uint32`);
  return Number(v);
}
function text(b: Uint8Array, field: number): string {
  try { return UTF8_IN.decode(b); } catch { throw new StandbyCodecError('MALFORMED', `field ${field} is not UTF-8`); }
}
function ts(b: Uint8Array, field: number): StandbyPush['ts'] {
  const s = text(b, field);
  try { return hlc(s); } catch { throw new StandbyCodecError('BAD_TS', `field ${field} "${s}" is not an HLC timestamp`); }
}

function encodeRow(r: LogRowWrite): Uint8Array {
  return new Writer()
    .uint(1, r.slot, U32_MAX).bytes(2, r.partition).uint(3, r.seq, U64_MAX).uint(4, r.generation, U32_MAX)
    .uint(5, r.epoch, U64_MAX).uint(6, r.kind, U32_MAX).uint(7, r.schemaV, U32_MAX).bytes(8, r.identity)
    .bytes(9, r.emits).bytes(10, r.audit).uint(11, r.retention, U32_MAX).bytes(12, r.keyId).bytes(13, r.payload)
    .bytes(14, r.chain).finish();
}

function decodeRow(buf: Uint8Array): LogRowWrite {
  const e = new Uint8Array();
  const r: LogRowWrite = { slot: 0, partition: e, seq: 0n, generation: 0, epoch: 0n, kind: 0, schemaV: 0, identity: e, emits: e,
    audit: e, retention: 0, keyId: e, payload: e, chain: e };
  const rd = new Reader(buf);
  const BYTES = { 2: 'partition', 8: 'identity', 9: 'emits', 10: 'audit', 12: 'keyId', 13: 'payload', 14: 'chain' } as const;
  const U32 = { 1: 'slot', 4: 'generation', 6: 'kind', 7: 'schemaV', 11: 'retention' } as const;
  while (!rd.done()) {
    const { field, wire } = rd.tag();
    if (field in BYTES) { want(wire, LEN, field); r[BYTES[field as keyof typeof BYTES]] = rd.bytes(); continue; }
    if (field in U32) { want(wire, VARINT, field); r[U32[field as keyof typeof U32]] = u32(rd.varint(), field); continue; }
    if (field === 3 || field === 5) { want(wire, VARINT, field); r[field === 3 ? 'seq' : 'epoch'] = rd.varint(); continue; }
    rd.skip(wire);
  }
  return r;
}

/** Encodes a push as the protobuf message `StandbyPush`. */
export function encodeStandbyPush(p: StandbyPush): Uint8Array {
  const w = new Writer().text(1, p.kind).uint(2, p.slot, U32_MAX).uint(3, p.epoch, U64_MAX).text(4, p.ts).text(5, p.prevTs)
    .uint(6, p.advances ? 1 : 0, 1n);
  for (const r of p.rows) w.bytes(7, encodeRow(r));
  return w.finish();
}

/** Decodes the protobuf message `StandbyPush`. Unknown fields are skipped (proto3). Throws `StandbyCodecError`. */
export function decodeStandbyPush(buf: Uint8Array): StandbyPush {
  const p: StandbyPush = { kind: '', slot: 0, epoch: 0n, ts: hlc('0'), prevTs: hlc('0'), advances: false, rows: [] };
  const rd = new Reader(buf);
  while (!rd.done()) {
    const { field, wire } = rd.tag();
    switch (field) {
      case 1: want(wire, LEN, field); p.kind = text(rd.bytes(), field); break;
      case 2: want(wire, VARINT, field); p.slot = u32(rd.varint(), field); break;
      case 3: want(wire, VARINT, field); p.epoch = rd.varint(); break;
      case 4: want(wire, LEN, field); p.ts = ts(rd.bytes(), field); break;
      case 5: want(wire, LEN, field); p.prevTs = ts(rd.bytes(), field); break;
      case 6: want(wire, VARINT, field); p.advances = rd.varint() !== 0n; break;
      case 7: want(wire, LEN, field); p.rows.push(decodeRow(rd.bytes())); break;
      default: rd.skip(wire);
    }
  }
  return p;
}

interface PushAck { received: bigint }
const encodeAck = (a: PushAck): Buffer => Buffer.from(new Writer().uint(1, a.received, U64_MAX).finish());
function decodeAck(buf: Buffer): PushAck {
  const rd = new Reader(buf);
  const a: PushAck = { received: 0n };
  while (!rd.done()) {
    const { field, wire } = rd.tag();
    if (field === 1) { want(wire, VARINT, field); a.received = rd.varint(); } else rd.skip(wire);
  }
  return a;
}
const serializePush = (p: StandbyPush): Buffer => Buffer.from(encodeStandbyPush(p));

// ---------------- holder side ----------------

/** Counts of a holder's push channel to one standby. */
export interface GrpcStandbyChannelStats {
  /** Pushes written to a stream. */
  sent: number;
  /** Pushes not sent: the queue was full or the channel was closed. */
  dropped: number;
  /** Streams opened. */
  streams: number;
  /** Streams that ended with an error (their queued pushes are lost; the tail covers them). */
  streamsFailed: number;
}

/** Options of a `GrpcStandbyChannel`. */
export interface GrpcStandbyChannelOptions {
  /** `host:port` of the standby process. */
  address: string;
  /** Channel credentials. Default: insecure (in-process tests). Production uses mTLS (RFC-005). */
  credentials?: ChannelCredentials;
  /** Queued pushes per stream before a push is dropped. Default `STANDBY_PUSH_QUEUE_MAX`. */
  maxQueued?: number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * The holder's push channel to one standby process over gRPC (one client stream). Give it to the holder with
 * `attachStandby`. `push` never waits and never throws (RFC-006 §4.4).
 */
export class GrpcStandbyChannel implements StandbyChannel {
  readonly stats: GrpcStandbyChannelStats = { sent: 0, dropped: 0, streams: 0, streamsFailed: 0 };
  private readonly client: grpc.Client;
  private readonly maxQueued: number;
  private readonly log: (msg: string, fields?: Record<string, unknown>) => void;
  private stream: ClientWritableStream<StandbyPush> | undefined;
  private closed = false;

  constructor(o: GrpcStandbyChannelOptions) {
    // A lost push costs at most one standby_poll (250 ms) plus the follower-read lag (RFC-006 §4.4), so the
    // channel reconnects soon after the standby comes back (est.).
    this.client = new grpc.Client(o.address, o.credentials ?? grpc.credentials.createInsecure(), {
      'grpc.initial_reconnect_backoff_ms': 100, 'grpc.max_reconnect_backoff_ms': 1_000,
    });
    this.maxQueued = o.maxQueued ?? STANDBY_PUSH_QUEUE_MAX;
    this.log = o.log ?? (() => {});
  }

  push(p: StandbyPush): void {
    if (this.closed) { this.stats.dropped += 1; return; }
    const s = this.stream ?? this.open();
    if (s.writableLength >= this.maxQueued) { this.stats.dropped += 1; return; }
    s.write(p);
    this.stats.sent += 1;
  }

  /** Ends the stream and closes the connection. Later pushes are dropped. */
  async close(): Promise<void> {
    this.closed = true;
    const s = this.stream;
    this.stream = undefined;
    s?.end();
    this.client.close();
  }

  private open(): ClientWritableStream<StandbyPush> {
    const s: ClientWritableStream<StandbyPush> = this.client.makeClientStreamRequest<StandbyPush, PushAck>(
      STANDBY_PUSH_PATH, serializePush, decodeAck, (err) => {
        if (this.stream === s) this.stream = undefined;
        if (err && !this.closed) {
          this.stats.streamsFailed += 1;
          this.log('standby push stream failed', { code: err.code, details: err.details });
        }
      });
    this.stream = s;
    this.stats.streams += 1;
    return s;
  }
}

// ---------------- standby side ----------------

/** Options of a `GrpcStandbyServer`. */
export interface GrpcStandbyServerOptions {
  /** The standby runtime's push channel (`CockroachOwnerRuntime.standbyChannel()`). */
  channel: StandbyChannel;
  /** Server credentials. Default: insecure (in-process tests). Production uses mTLS (RFC-005). */
  credentials?: ServerCredentials;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/** The standby process's gRPC endpoint for its holders' push streams. */
export class GrpcStandbyServer {
  private readonly server = new grpc.Server();
  private readonly channel: StandbyChannel;
  private readonly credentials: ServerCredentials;
  private readonly log: (msg: string, fields?: Record<string, unknown>) => void;

  constructor(o: GrpcStandbyServerOptions) {
    this.channel = o.channel;
    this.credentials = o.credentials ?? grpc.ServerCredentials.createInsecure();
    this.log = o.log ?? (() => {});
    this.server.addService({
      push: {
        path: STANDBY_PUSH_PATH, requestStream: true, responseStream: false,
        requestSerialize: serializePush, requestDeserialize: (b: Buffer) => decodeStandbyPush(b),
        responseSerialize: encodeAck, responseDeserialize: decodeAck,
      },
    }, { push: (call: ServerReadableStream<StandbyPush, PushAck>, done: sendUnaryData<PushAck>) => this.onStream(call, done) });
  }

  /** Binds `address` (`host:port`, port 0 for any) and returns the bound port. */
  listen(address: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.bindAsync(address, this.credentials, (err, port) => { if (err) reject(err); else resolve(port); });
    });
  }

  /** Stops the server at once and cancels every open stream. */
  async close(): Promise<void> {
    this.server.forceShutdown();
  }

  private onStream(call: ServerReadableStream<StandbyPush, PushAck>, done: sendUnaryData<PushAck>): void {
    let received = 0n;
    call.on('data', (p: StandbyPush) => {
      received += 1n;
      try {
        this.channel.push(p);
      } catch (e) {
        // One push that does not apply leaves a seq gap; the follower-read tail fills it (RFC-006 §4.4).
        this.log('standby push apply failed', { kind: p.kind, slot: p.slot, error: String(e) });
      }
    });
    call.on('end', () => done(null, { received }));
    call.on('error', (e: Error) => this.log('standby push stream error', { error: String(e) }));
  }
}
