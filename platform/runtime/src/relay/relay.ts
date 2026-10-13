/**
 * The changefeed relay of one owner kind (C01 §3.5, §2.5; plan S-PLAT-I1 item 7, I2 item 3).
 *
 * A self-outboxed kind (RFC-006 §3.5) has no outbox: its changefeed runs on `<kind>_log`, and the relay
 * (option `derive`) opens each log row with the kind's log key and derives its events by the declared emit
 * functions. This relay therefore holds the log key (C01 §2.5, R47-19).
 *
 * One changefeed per outbox table writes every outbox row to `cdc.<kind>`. The relay reads `cdc.<kind>`,
 * drops delete events, re-keys each row to its own topic (key = msg_key, clear headers, sealed payload as
 * stored) and produces it with acks=all. When a `cdc.<kind>` partition gives a resolved timestamp R, every
 * row of that partition with ts ≤ R is already acknowledged, so the relay then writes
 * RelayProgress { cdcPartition, resolved: R } to the compacted topic `relay.progress.<kind>`.
 */
import type pg from 'pg';
import type { HlcTs, OwnerDeclaration } from '../api.ts';
import { encodeJson, fromHex } from '../bytes.ts';
import type { Sealer } from '../sealer.ts';
import type { LogRowWrite } from '../store/types.ts';
import { deriveEvents, type EmitFunctions } from '../selfout/derive.ts';
import { assertIdentifier, tableNames } from '../declaration.ts';
import { compareHlc, hlc } from '../hlc.ts';
import type { BusRecord, BusSubscription, FeedBus } from '../feed/bus.ts';
import { cdcTopic, encodeRelayProgress, outboxHeadersToKafka, relayProgressTopic } from '../feed/wire.ts';

/** One outbox row as the changefeed gives it. */
export interface CdcOutboxRow {
  slot: number; partition: Uint8Array; stream: string; streamSeq: bigint; n: number; topic: string;
  msgKey: Uint8Array; headers: Uint8Array; payload: Uint8Array; ts: HlcTs; generation: number; epoch: bigint;
}

export type CdcMessage = { type: 'row'; row: CdcOutboxRow } | { type: 'delete' } | { type: 'resolved'; resolved: HlcTs };

/** One `cdc.<kind>` message of a self-outboxed kind's log changefeed. */
export type CdcLogMessage = { type: 'log'; row: LogRowWrite & { ts: HlcTs } } | { type: 'delete' } | { type: 'resolved'; resolved: HlcTs };

/** CockroachDB JSON encodes BYTES as "\\x<hex>". */
function bytesOf(v: unknown): Uint8Array {
  const s = String(v ?? '');
  return s.startsWith('\\x') ? fromHex(s.slice(2)) : new Uint8Array(Buffer.from(s, 'base64'));
}

/** JSON.parse that keeps every number as its source text (DECIMAL ts and INT8 must not lose digits). */
function parseExact(text: string): unknown {
  return JSON.parse(text, function (this: unknown, _k: string, v: unknown, ctx?: { source?: string }) {
    return typeof v === 'number' && ctx?.source !== undefined ? ctx.source : v;
  } as (this: unknown, key: string, value: unknown) => unknown);
}

/** Parse one `cdc.<kind>` message (envelope wrapped, with `updated` and `resolved` options). */
export function parseCdcMessage(value: Uint8Array | null): CdcMessage | undefined {
  if (!value) return { type: 'delete' };
  const m = parseExact(Buffer.from(value).toString('utf8')) as Record<string, unknown>;
  if (typeof m['resolved'] === 'string') return { type: 'resolved', resolved: hlc(m['resolved']) };
  if (!('after' in m)) return undefined;
  const a = m['after'] as Record<string, unknown> | null;
  if (a === null) return { type: 'delete' };
  return {
    type: 'row',
    row: {
      slot: Number(a['slot']), partition: bytesOf(a['partition']), stream: String(a['stream']), streamSeq: BigInt(String(a['stream_seq'])),
      n: Number(a['n']), topic: String(a['topic']), msgKey: bytesOf(a['msg_key']), headers: bytesOf(a['headers']),
      payload: bytesOf(a['payload']), ts: hlc(String(a['ts'])), generation: Number(a['generation']), epoch: BigInt(String(a['epoch'])),
    },
  };
}

/** Parse one `cdc.<kind>` message of a log table changefeed (a self-outboxed kind, RFC-006 §3.5). */
export function parseCdcLogMessage(value: Uint8Array | null): CdcLogMessage | undefined {
  if (!value) return { type: 'delete' };
  const m = parseExact(Buffer.from(value).toString('utf8')) as Record<string, unknown>;
  if (typeof m['resolved'] === 'string') return { type: 'resolved', resolved: hlc(m['resolved']) };
  if (!('after' in m)) return undefined;
  const a = m['after'] as Record<string, unknown> | null;
  if (a === null) return { type: 'delete' };
  return {
    type: 'log',
    row: {
      slot: Number(a['slot']), partition: bytesOf(a['partition']), seq: BigInt(String(a['seq'])), generation: Number(a['generation']),
      epoch: BigInt(String(a['epoch'])), kind: Number(a['kind']), schemaV: Number(a['schema_v']), ts: hlc(String(a['ts'])),
      identity: bytesOf(a['identity']), emits: bytesOf(a['emits']), audit: bytesOf(a['audit']), retention: Number(a['retention']),
      keyId: bytesOf(a['key_id']), payload: bytesOf(a['payload']), chain: bytesOf(a['chain']),
    },
  };
}

/** What the relay of a self-outboxed kind needs to derive events: the log key (in the sealer) and the emit functions. */
export interface RelayDerivation {
  declaration: OwnerDeclaration;
  sealer: Sealer;
  emitFns: EmitFunctions;
}

export interface RelayOptions {
  bus: FeedBus;
  kind: string;
  /** Consumer group of the relay instances of the kind (default `<kind>-relay`). */
  groupId?: string;
  /** Set for a self-outboxed kind: the changefeed is on the log table and events are derived. */
  derive?: RelayDerivation;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export class OutboxRelay {
  private readonly o: RelayOptions;
  private sub: BusSubscription | undefined;
  /** Counters for tests and metrics. */
  readonly stats = { rows: 0, deletesDropped: 0, progress: 0 };
  private readonly lastProgress = new Map<number, HlcTs>();

  constructor(o: RelayOptions) {
    assertIdentifier(o.kind);
    this.o = o;
  }

  async start(): Promise<void> {
    this.sub = await this.o.bus.subscribe({
      groupId: this.o.groupId ?? `${this.o.kind}-relay`, topics: [cdcTopic(this.o.kind)], fromBeginning: true,
      onRecord: (r) => this.onRecord(r),
    });
  }

  async stop(): Promise<void> {
    await this.sub?.stop();
    this.sub = undefined;
  }

  private async onRecord(r: BusRecord): Promise<void> {
    const d = this.o.derive;
    const m = d ? parseCdcLogMessage(r.value) : parseCdcMessage(r.value);
    if (!m) return;
    if (m.type === 'delete') {
      // C01 §3.5: the outbox is transport; a delete (TTL, the truncator, or manual) is not an event (RFC-006 §3.5).
      this.stats.deletesDropped += 1;
      return;
    }
    if (m.type === 'row') {
      await this.o.bus.produce(m.row.topic, [{ key: m.row.msgKey, value: m.row.payload, headers: outboxHeadersToKafka(m.row.headers) }]);
      this.stats.rows += 1;
      return;
    }
    if (m.type === 'log') {
      if (!d) return;
      // Records of one row in emits order; produce awaits each, so progress below stays after its rows.
      for (const e of deriveEvents(d.declaration, d.sealer, d.emitFns, m.row)) {
        await this.o.bus.produce(e.topic, [{ key: e.msgKey, value: e.payload, headers: outboxHeadersToKafka(encodeJson(e.headers)) }]);
        this.stats.rows += 1;
      }
      return;
    }
    // Every earlier row of this cdc partition is acknowledged (the produce calls above were awaited in order).
    const last = this.lastProgress.get(r.partition);
    if (last === undefined || compareHlc(m.resolved, last) > 0) {
      await this.o.bus.produce(relayProgressTopic(this.o.kind), [{
        key: new Uint8Array(Buffer.from(String(r.partition))),
        value: encodeRelayProgress({ cdcPartition: r.partition, resolved: m.resolved }),
      }]);
      this.lastProgress.set(r.partition, m.resolved);
      this.stats.progress += 1;
    }
    await this.sub?.commit(r.topic, r.partition, r.offset + 1n);
  }
}

// ---------------- changefeed management (CockroachDB) ----------------

export interface ChangefeedOptions {
  /** The table of the changefeed: the outbox (default), or the log of a self-outboxed kind (RFC-006 §3.5). */
  table?: 'outbox' | 'log';
  /** Kafka sink as the database nodes reach it, e.g. kafka://kafka1:19092 in the dev cell. */
  sinkUri: string;
  /** Start position for a re-created changefeed (no gap: the relay progress of the old one). */
  cursor?: HlcTs;
  resolvedEvery?: string;
}

export function changefeedStatement(kind: string, o: ChangefeedOptions): string {
  const t = assertIdentifier(o.table === 'log' ? tableNames(kind).log : tableNames(kind).outbox);
  const sep = o.sinkUri.includes('?') ? '&' : '?';
  const sink = `${o.sinkUri}${sep}topic_name=${encodeURIComponent(cdcTopic(kind))}`;
  if (/'/.test(sink)) throw new Error('sink URI must not contain a quote');
  const opts = [
    'updated', `resolved = '${o.resolvedEvery ?? '1s'}'`, `min_checkpoint_frequency = '${o.resolvedEvery ?? '1s'}'`,
    `kafka_sink_config = '{"RequiredAcks": "ALL", "Flush": {"Frequency": "50ms"}}'`,
    ...(o.cursor ? [`cursor = '${hlc(o.cursor)}'`] : []),
  ];
  return `CREATE CHANGEFEED FOR TABLE ${t} INTO '${sink}' WITH ${opts.join(', ')}`;
}

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.Client, 'query'>;

/** Running changefeed jobs of the kind's outbox table. */
export async function changefeedJobs(db: Queryable, kind: string, table: 'outbox' | 'log' = 'outbox'): Promise<Array<{ jobId: string; status: string }>> {
  const t = table === 'log' ? tableNames(kind).log : tableNames(kind).outbox;
  const r = await db.query(
    `SELECT job_id::STRING AS job_id, status FROM [SHOW CHANGEFEED JOBS]
      WHERE status IN ('running', 'paused', 'pending') AND description LIKE $1`, [`%FOR TABLE ${t} INTO%topic_name=${encodeURIComponent(cdcTopic(kind))}%`]);
  return (r.rows as Array<Record<string, unknown>>).map((x) => ({ jobId: String(x['job_id']), status: String(x['status']) }));
}

/** Create the kind's changefeed unless one runs (one changefeed per outbox table). */
export async function ensureChangefeed(db: Queryable, kind: string, o: ChangefeedOptions): Promise<string> {
  const jobs = await changefeedJobs(db, kind, o.table);
  if (jobs[0]) return jobs[0].jobId;
  const r = await db.query(changefeedStatement(kind, o));
  return String((r.rows[0] as Record<string, unknown>)['job_id']);
}

export async function cancelChangefeeds(db: Queryable, kind: string, table: 'outbox' | 'log' = 'outbox'): Promise<void> {
  for (const j of await changefeedJobs(db, kind, table)) await db.query(`CANCEL JOB ${BigInt(j.jobId).toString()}`);
}
