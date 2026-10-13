/**
 * Wire forms of C01 §2.5: feed headers, report markers, closure markers, relay progress.
 * An outbox row keeps its headers as JSON (partition in hex); Kafka gets them as clear headers with the
 * partition as raw bytes. The platform-only key `outcome_id` stays in the database (§3.4 rule 7).
 */
import { createHash } from 'node:crypto';
import type { ClosedMarker, Epoch, FeedEvent, FeedHeaders, HlcTs, RelayProgress, ReportMarker, ResolvedMarker, SlotNo, StreamSeq } from '../api.ts';
import { decodeJson, encodeJson, fromHex, hex } from '../bytes.ts';
import type { SealContext } from '../sealer.ts';
import { tableNames } from '../declaration.ts';
import type { BusRecord } from './bus.ts';

/** Header keys that never leave the database. */
const DB_ONLY_HEADERS = new Set(['outcome_id']);

/** Outbox `headers` JSON → Kafka headers (partition as raw bytes; database-only keys removed). */
export function outboxHeadersToKafka(headersJson: Uint8Array): Record<string, string | Uint8Array> {
  const h = decodeJson(headersJson) as Record<string, string>;
  const out: Record<string, string | Uint8Array> = {};
  for (const [k, v] of Object.entries(h)) {
    if (DB_ONLY_HEADERS.has(k)) continue;
    out[k] = k === 'partition' ? fromHex(v) : String(v);
  }
  return out;
}

/** Outbox `headers` JSON → FeedHeaders (for gap fill and the conflict read). */
export function outboxHeadersToFeed(headersJson: Uint8Array): FeedHeaders {
  return kafkaHeadersToFeed(outboxHeadersToKafka(headersJson));
}

function kafkaHeadersToFeed(h: Record<string, string | Uint8Array>): FeedHeaders {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(h)) {
    if (k === 'partition') out[k] = typeof v === 'string' ? new Uint8Array(Buffer.from(v, 'utf8')) : v;
    else out[k] = typeof v === 'string' ? v : Buffer.from(v).toString('utf8');
  }
  out['partition'] ??= new Uint8Array();
  return out as unknown as FeedHeaders;
}

/** A bus record as the FeedEvent that `subscribe` handlers get. */
export function recordToFeedEvent(r: BusRecord): FeedEvent {
  return { headers: kafkaHeadersToFeed(r.headers), value: r.value ?? new Uint8Array() };
}

/** SHA-256 (hex) of the event's ciphertext: the digest an owner checkpoints with (partition, stream, stream_seq). */
export function feedEventDigest(e: FeedEvent | Uint8Array): string {
  const v = e instanceof Uint8Array ? e : e.value;
  return createHash('sha256').update(v).digest('hex');
}

export function isMarkerEvent(e: FeedEvent): boolean {
  return e.headers.report_through !== undefined;
}

/**
 * Associated data of a report marker's seal. The consumer builds the same context from the clear headers
 * (topic kind, slot, stream, stream_seq, epoch), so it can open the marker.
 */
export function markerSealContext(kind: string, slot: SlotNo, stream: string, streamSeq: StreamSeq, epoch: Epoch): SealContext {
  return {
    ownerKind: kind, table: tableNames(kind).outbox,
    primaryKey: { slot, partition: new Uint8Array(), stream, streamSeq, n: 0 },
    seqOrVersion: streamSeq, epoch, rowKind: 'marker',
  };
}

export function encodeMarker(m: ReportMarker): Uint8Array {
  return encodeJson(m);
}

export function decodeMarker(b: Uint8Array): ReportMarker {
  const m = decodeJson(b) as ReportMarker;
  return { ...m, epoch: BigInt(m.epoch), pendingAnswered: m.pendingAnswered.map((x) => new Uint8Array(x)) };
}

/** Owner kind of a topic `<kind>.<feed>.v<n>` (C01 §2.5). */
export function topicKind(topic: string): string {
  return topic.split('.')[0] ?? topic;
}

export function closureTopic(dataTopic: string): string {
  return `${dataTopic}.closure`;
}

export type ClosureMessage = { type: 'resolved'; m: ResolvedMarker } | { type: 'closed'; m: ClosedMarker };

export function encodeClosure(c: ClosureMessage): Uint8Array {
  return encodeJson(c);
}

export function decodeClosure(b: Uint8Array): ClosureMessage {
  return decodeJson(b) as ClosureMessage;
}

export function encodeRelayProgress(p: RelayProgress): Uint8Array {
  return encodeJson(p);
}

export function decodeRelayProgress(b: Uint8Array): RelayProgress {
  return decodeJson(b) as RelayProgress;
}

export function relayProgressTopic(kind: string): string {
  return `relay.progress.${kind}`;
}

export function cdcTopic(kind: string): string {
  return `cdc.${kind}`;
}

/** Key of a report marker for onMarker de-duplication (N-01): (slot, epoch, reportPosition, chunk.part). */
export function markerKey(m: ReportMarker): string {
  return `${m.slot}|${m.epoch}|${m.reportPosition}|${m.chunk.part}`;
}

export function hexKey(partition: Uint8Array, stream: string): string {
  return `${hex(partition)}|${stream}`;
}

export type { HlcTs };
