/**
 * Feed events of a self-outboxed kind (RFC-006 §3.5; C01 §2.2, §2.3, R47-19).
 *
 * A self-outboxed kind has no outbox table. Its relay reads the log table's changefeed, opens each row with
 * the kind's log key, and derives each event with the stream's declared, versioned emit function. The
 * holder's direct publish and the gap fill derive the same event the same way. All copies of one event must
 * be byte-identical (C01 §3.5 D3), so the event is sealed with `Sealer.sealDerived` (a nonce derived from
 * the input), not with a fresh nonce.
 */
import type { HlcTs, OpenedLogRow, OwnerDeclaration, SlotNo, StreamSeq } from '../api.ts';
import { bytesEqual, decodeJson, encodeJson, hex } from '../bytes.ts';
import { FENCE_KEY, PAYLOAD_KEY } from '../batch/attempt.ts';
import { tableNames } from '../declaration.ts';
import type { Sealer } from '../sealer.ts';
import type { LogRowWrite } from '../store/types.ts';

/** What an emit function sees of one log entry. */
export interface EmitInput {
  partition: Uint8Array; seq: bigint; ts: HlcTs; kind: number; schemaV: number; identity: Uint8Array; payload: unknown;
}

/** An emit function: the events of one stream that one entry produces, in order (often zero or one). */
export type EmitFunction = (entry: EmitInput) => unknown[];

/** stream name → emit function version → function. The declaration names the version in use (C01 §2.2 `emitFn`). */
export type EmitFunctions = Record<string, Record<number, EmitFunction>>;

/** The refusal codes of a self-outboxed kind (C01 §2.2, §2.3, §3.5; RFC-006 §3.5). */
export type SelfOutboxedErrorCode =
  /** The emit function gives other events than the entry declares, or another number of events than the row records. */
  | 'EMIT_MISMATCH'
  /** A notification on a self-outboxed kind: it has no outbox. */
  | 'NO_OUTBOX'
  /** The stream index names a log row that derives no event of that (stream, stream_seq). */
  | 'INDEX_MISMATCH'
  /** The declaration and the emit functions do not match (`details` lists each problem). */
  | 'INVALID_DECLARATION';

/** An error of a self-outboxed kind. `code` is the refusal; `details` lists the problems of a declaration. */
export class SelfOutboxedError extends Error {
  readonly code: SelfOutboxedErrorCode;
  readonly details: string[];
  constructor(code: SelfOutboxedErrorCode, message: string, details: string[] = []) {
    super(`${code}: ${message}`);
    this.name = 'SelfOutboxedError';
    this.code = code;
    this.details = details;
  }
}

/** Errors when a self-outboxed declaration and its emit functions do not match. Empty when they match. */
export function emitFunctionErrors(decl: OwnerDeclaration, fns: EmitFunctions | undefined): string[] {
  if (!decl.selfOutboxed) return [];
  const errors: string[] = [];
  for (const s of decl.streams) {
    if (fns?.[s.name]?.[s.emitFn.version] === undefined) errors.push(`stream ${s.name}: no emit function version ${s.emitFn.version}`);
    if (s.reportGated) errors.push(`stream ${s.name}: a self-outboxed kind has no outbox, so no report-gated stream (C01 §3.4 rule 7)`);
  }
  if (decl.statusReaders) errors.push('a self-outboxed kind has no outbox, so no report markers (statusReaders)');
  return errors;
}

/** The emit function in use for a stream. */
export function emitFunction(decl: OwnerDeclaration, fns: EmitFunctions, stream: string): EmitFunction {
  const s = decl.streams.find((x) => x.name === stream);
  const fn = s ? fns[stream]?.[s.emitFn.version] : undefined;
  if (!s || !fn) throw new Error(`${decl.kind}: no emit function for stream ${stream}`);
  return fn;
}

/** The fields of one event record that do not come from the event body. */
export interface EventPlace {
  slot: SlotNo; partition: Uint8Array; stream: string; streamSeq: StreamSeq; generation: number; epoch: bigint; ts: HlcTs;
  entryKind: number; schemaV: number;
}

/** One event as the outbox row, the relay and the direct publish carry it. */
export interface EventRecord {
  topic: string;
  msgKey: Uint8Array;
  /** Clear headers as strings (partition in hex), the outbox `headers` JSON form. */
  headers: Record<string, string>;
  payload: Uint8Array;
}

function slotKey(slot: SlotNo): Uint8Array {
  const b = Buffer.alloc(4); b.writeInt32BE(slot, 0);
  return new Uint8Array(b);
}

function fieldKey(event: unknown, field: string): Uint8Array {
  const v = event !== null && typeof event === 'object' ? (event as Record<string, unknown>)[field] : undefined;
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return new Uint8Array(Buffer.from(v, 'utf8'));
  if (v === undefined) throw new Error(`event has no key field ${field}`);
  return encodeJson(v);
}

/**
 * Builds the record of one event (C01 §2.5 headers; key per the stream's declared key). `derived` seals with
 * `sealDerived` (self-outboxed kinds); otherwise with a fresh nonce (an outbox row is the one copy).
 */
export function eventRecord(decl: OwnerDeclaration, sealer: Sealer, at: EventPlace, event: unknown, derived: boolean): EventRecord {
  const stream = decl.streams.find((s) => s.name === at.stream);
  if (!stream) throw new Error(`stream ${at.stream} is not declared by ${decl.kind}`);
  const keyId = sealer.keyId(stream.topic);
  const ctx = {
    ownerKind: decl.kind, table: tableNames(decl.kind).outbox,
    primaryKey: { slot: at.slot, partition: at.partition, stream: at.stream, streamSeq: at.streamSeq, n: 0 },
    seqOrVersion: at.streamSeq, epoch: at.epoch, rowKind: `event:${at.stream}`,
  };
  let payload: Uint8Array;
  if (derived) {
    if (!sealer.sealDerived) throw new Error('a self-outboxed kind needs a sealer with sealDerived');
    payload = sealer.sealDerived(encodeJson(event), ctx);
  } else {
    payload = sealer.seal(encodeJson(event), ctx);
  }
  const msgKey = stream.key === 'slot' ? slotKey(at.slot) : typeof stream.key === 'object' ? fieldKey(event, stream.key.field) : at.partition;
  const headers: Record<string, string> = {
    partition: hex(at.partition), stream: at.stream, stream_seq: at.streamSeq.toString(),
    generation: String(at.generation), epoch: at.epoch.toString(), ts: at.ts,
    kind: String(at.entryKind), schema_v: String(at.schemaV), key_id: hex(keyId),
    ...(stream.key === 'slot' ? { slot: String(at.slot) } : {}),
  };
  return { topic: stream.topic, msgKey, headers, payload };
}

/** Opens a log row's payload (without the sender-fence envelope) and audit (C01 §3.12). */
export function openLogRow(decl: OwnerDeclaration, sealer: Sealer, r: LogRowWrite & { ts: HlcTs }): OpenedLogRow {
  const t = tableNames(decl.kind);
  const ctx = { ownerKind: decl.kind, table: t.log, primaryKey: { slot: r.slot, partition: r.partition, seq: r.seq }, seqOrVersion: r.seq, epoch: r.epoch };
  let payload = decodeJson(sealer.open(r.payload, { ...ctx, rowKind: `entry:${r.kind}` }));
  let senderFence: OpenedLogRow['senderFence'];
  if (payload !== null && typeof payload === 'object' && PAYLOAD_KEY in (payload as Record<string, unknown>)) {
    const env = payload as Record<string, unknown>;
    senderFence = env[FENCE_KEY] as OpenedLogRow['senderFence'];
    payload = env[PAYLOAD_KEY];
  }
  const audit = decodeJson(sealer.open(r.audit, { ...ctx, rowKind: 'audit' }));
  const emits = (decodeJson(r.emits) as Array<[string, string]>).map(([s, n]) => [s, BigInt(n)] as [string, StreamSeq]);
  return {
    slot: r.slot, partition: r.partition, seq: r.seq, generation: r.generation, epoch: r.epoch, kind: r.kind, schemaV: r.schemaV,
    ts: r.ts, identity: r.identity, emits, retention: r.retention, payload, audit, chain: r.chain, ...(senderFence ? { senderFence } : {}),
  };
}

/**
 * The events of one self-outboxed log row, derived by the emit functions (RFC-006 §3.5): one record for each
 * (stream, stream_seq) of the row's `emits`, in order. Throws when the emit function gives a different number
 * of events than the row recorded for a stream.
 */
export function deriveEvents(decl: OwnerDeclaration, sealer: Sealer, fns: EmitFunctions, r: LogRowWrite & { ts: HlcTs }): EventRecord[] {
  const row = openLogRow(decl, sealer, r);
  const input: EmitInput = { partition: row.partition, seq: row.seq, ts: row.ts, kind: row.kind, schemaV: row.schemaV, identity: row.identity, payload: row.payload };
  const byStream = new Map<string, unknown[]>();
  const used = new Map<string, number>();
  const out: EventRecord[] = [];
  for (const [stream, streamSeq] of row.emits) {
    let events = byStream.get(stream);
    if (!events) { events = emitFunction(decl, fns, stream)(input); byStream.set(stream, events); }
    const i = used.get(stream) ?? 0;
    used.set(stream, i + 1);
    if (i >= events.length) throw new SelfOutboxedError('EMIT_MISMATCH', `${decl.kind} seq ${row.seq}: emit function of ${stream} gave ${events.length} events; the row records more`);
    out.push(eventRecord(decl, sealer, {
      slot: row.slot, partition: row.partition, stream, streamSeq, generation: row.generation, epoch: row.epoch, ts: row.ts,
      entryKind: row.kind, schemaV: row.schemaV,
    }, events[i], true));
  }
  for (const [stream, events] of byStream) {
    if ((used.get(stream) ?? 0) !== events.length) throw new SelfOutboxedError('EMIT_MISMATCH', `${decl.kind} seq ${row.seq}: emit function of ${stream} gave ${events.length} events; the row records ${used.get(stream) ?? 0}`);
  }
  return out;
}

/**
 * The holder's check before it writes a self-outboxed entry: the events the entry declares must be exactly
 * what the emit functions derive from it, else the relay and the gap fill would publish other events.
 */
export function checkDeclaredEvents(decl: OwnerDeclaration, fns: EmitFunctions, input: EmitInput, emits: Array<{ stream: string; event: unknown }>): void {
  const streams = [...new Set(emits.map((e) => e.stream))];
  for (const s of streams) {
    const want = emitFunction(decl, fns, s)(input).map(encodeJson);
    const got = emits.filter((e) => e.stream === s).map((e) => encodeJson(e.event));
    if (want.length !== got.length || want.some((w, i) => !bytesEqual(w, got[i] as Uint8Array))) {
      throw new SelfOutboxedError('EMIT_MISMATCH', `${decl.kind}: the events of stream ${s} are not what emit function version ${decl.streams.find((x) => x.name === s)?.emitFn.version} derives from the entry`);
    }
  }
  for (const s of decl.streams) {
    if (streams.includes(s.name)) continue;
    if (emitFunction(decl, fns, s.name)(input).length > 0) throw new SelfOutboxedError('EMIT_MISMATCH', `${decl.kind}: the entry declares no event of stream ${s.name}, but its emit function derives one`);
  }
}
