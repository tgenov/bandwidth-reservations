/**
 * Gap fill (C01 §3.5): the consumer runtime reads missing feed events from the producer's outbox through
 * its `gapfill_<consumer>_<producer>` role, by (partition, stream, stream_seq), wherever the partition's
 * slot was. The same read answers the D3 content-conflict check: the database copy wins.
 */
import type pg from 'pg';
import type { HlcTs, SlotNo } from '../api.ts';
import { assertIdentifier, tableNames } from '../declaration.ts';
import { hlc } from '../hlc.ts';
import type { MemoryStore } from '../store/memory.ts';
import { encodeJson, hex } from '../bytes.ts';
import type { LogRowWrite } from '../store/types.ts';
import type { RelayDerivation } from '../relay/relay.ts';
import { deriveEvents } from '../selfout/derive.ts';

export interface GapFillRow {
  slot: SlotNo;
  streamSeq: bigint;
  ts: HlcTs;
  /** The outbox `headers` JSON. */
  headers: Uint8Array;
  /** The sealed payload as stored (byte-identical to every published copy). */
  payload: Uint8Array;
}

export interface GapFillSource {
  /** Rows of (partition, stream) with from ≤ stream_seq ≤ to, in stream_seq order. */
  read(producerKind: string, partition: Uint8Array, stream: string, from: bigint, to: bigint): Promise<GapFillRow[]>;
}

export interface PgGapFillOptions {
  /** Pool connected as the gap-fill role (a dev cell may use root). */
  pool: Pick<pg.Pool, 'query'>;
  /** The relation to read: the role's view (`<producer>_outbox_gapfill_<consumer>`) or the outbox table. */
  relation?: (producerKind: string) => string;
  /** 'follower' (C01 §2.3: follower read) or 'present' (tests on a cell with a long closed-timestamp lag). */
  read?: 'follower' | 'present';
}

export class PgGapFill implements GapFillSource {
  private readonly o: PgGapFillOptions;
  constructor(o: PgGapFillOptions) {
    this.o = o;
  }

  async read(producerKind: string, partition: Uint8Array, stream: string, from: bigint, to: bigint): Promise<GapFillRow[]> {
    const rel = assertIdentifier(this.o.relation?.(producerKind) ?? tableNames(producerKind).outbox);
    const aost = (this.o.read ?? 'follower') === 'follower' ? ' AS OF SYSTEM TIME follower_read_timestamp()' : '';
    const r = await this.o.pool.query(
      `SELECT slot, stream_seq, ts::STRING AS ts, headers, payload FROM ${rel}${aost}
        WHERE partition = $1 AND stream = $2 AND stream_seq BETWEEN $3 AND $4 AND n = 0 ORDER BY stream_seq`,
      [Buffer.from(partition), stream, from.toString(), to.toString()]);
    return (r.rows as Array<Record<string, unknown>>).map((x) => ({
      slot: Number(x['slot']), streamSeq: BigInt(String(x['stream_seq'])), ts: hlc(String(x['ts'])),
      headers: new Uint8Array(x['headers'] as Buffer), payload: new Uint8Array(x['payload'] as Buffer),
    }));
  }
}

/** Gap fill from MemoryStore outboxes (unit tests). */
export class MemoryGapFill implements GapFillSource {
  private readonly stores: Map<string, MemoryStore>;
  /** Number of reads, for tests. */
  reads = 0;
  constructor(stores: Record<string, MemoryStore>) {
    this.stores = new Map(Object.entries(stores));
  }

  async read(producerKind: string, partition: Uint8Array, stream: string, from: bigint, to: bigint): Promise<GapFillRow[]> {
    this.reads += 1;
    const s = this.stores.get(producerKind);
    if (!s) return [];
    return s.outbox
      .filter((o) => hex(o.partition) === hex(partition) && o.stream === stream && o.streamSeq >= from && o.streamSeq <= to && o.n === 0)
      .sort((a, b) => (a.streamSeq < b.streamSeq ? -1 : 1))
      .map((o) => ({ slot: o.slot, streamSeq: o.streamSeq, ts: o.ts, headers: o.headers, payload: o.payload }));
  }
}

/** A self-outboxed producer's log rows found by `<kind>_stream_index` (C01 §2.3, R47-19). */
export interface StreamIndexReader {
  /** Log rows of (partition, stream) with from ≤ stream_seq ≤ to, each with that stream_seq, in stream_seq order. */
  rows(producerKind: string, partition: Uint8Array, stream: string, from: bigint, to: bigint): Promise<Array<{ streamSeq: bigint; row: LogRowWrite & { ts: HlcTs } }>>;
}

/**
 * Gap fill from a self-outboxed producer (C01 §2.3 `gapfill_<consumer>_<producer>`: "a self-outboxed log
 * through its stream index"): reads the log row by the stream index and derives the event by the emit
 * function. The derived event is byte-identical to the relay's and the holder's copies (sealDerived), so the
 * D3 conflict read works. This reader needs the producer's log key (see STATUS-I2.md, C01 issue).
 */
export class LogDerivedGapFill implements GapFillSource {
  private readonly reader: StreamIndexReader;
  private readonly derive: Map<string, RelayDerivation>;
  /** Number of reads, for tests. */
  reads = 0;
  constructor(reader: StreamIndexReader, producers: RelayDerivation[]) {
    this.reader = reader;
    this.derive = new Map(producers.map((p) => [p.declaration.kind, p]));
  }

  async read(producerKind: string, partition: Uint8Array, stream: string, from: bigint, to: bigint): Promise<GapFillRow[]> {
    this.reads += 1;
    const d = this.derive.get(producerKind);
    if (!d) return [];
    const out: GapFillRow[] = [];
    for (const { streamSeq, row } of await this.reader.rows(producerKind, partition, stream, from, to)) {
      const rec = deriveEvents(d.declaration, d.sealer, d.emitFns, row)
        .find((e) => e.headers['stream'] === stream && e.headers['stream_seq'] === streamSeq.toString());
      if (!rec) throw new Error(`${producerKind}: the stream index names seq ${row.seq} for ${stream}/${streamSeq}, but the row derives no such event`);
      out.push({ slot: row.slot, streamSeq, ts: row.ts, headers: encodeJson(rec.headers), payload: rec.payload });
    }
    return out;
  }
}

/** StreamIndexReader over a MemoryStore (unit tests). */
export function memoryStreamIndex(store: MemoryStore): StreamIndexReader {
  return {
    async rows(kind, partition, stream, from, to) {
      return store.streamIndex
        .filter((x) => x.kind === kind && hex(x.partition) === hex(partition) && x.stream === stream && x.streamSeq >= from && x.streamSeq <= to)
        .sort((a, b) => (a.streamSeq < b.streamSeq ? -1 : 1))
        .flatMap((x) => {
          const row = store.log.find((l) => hex(l.partition) === hex(partition) && l.seq === x.seq);
          return row ? [{ streamSeq: x.streamSeq, row }] : [];
        });
    },
  };
}

/** StreamIndexReader on CockroachDB: a follower read (or present, for tests) of the index joined to the log. */
export function pgStreamIndex(pool: Pick<pg.Pool, 'query'>, read: 'follower' | 'present' = 'follower'): StreamIndexReader {
  return {
    async rows(kind, partition, stream, from, to) {
      const t = tableNames(kind);
      const aost = read === 'follower' ? ' AS OF SYSTEM TIME follower_read_timestamp()' : '';
      const r = await pool.query(
        `SELECT si.stream_seq, l.slot, l.partition, l.seq, l.generation, l.epoch, l.kind, l.schema_v, l.ts::STRING AS ts, l.identity,
                l.emits, l.audit, l.retention, l.key_id, l.payload, l.chain
           FROM ${assertIdentifier(t.streamIndex)} AS si JOIN ${assertIdentifier(t.log)} AS l ON l.partition = si.partition AND l.seq = si.seq${aost}
          WHERE si.partition = $1 AND si.stream = $2 AND si.stream_seq BETWEEN $3 AND $4 ORDER BY si.stream_seq`,
        [Buffer.from(partition), stream, from.toString(), to.toString()]);
      const b = (v: unknown): Uint8Array => new Uint8Array(v as Buffer);
      return (r.rows as Array<Record<string, unknown>>).map((x) => ({
        streamSeq: BigInt(String(x['stream_seq'])),
        row: {
          slot: Number(x['slot']), partition: b(x['partition']), seq: BigInt(String(x['seq'])), generation: Number(x['generation']),
          epoch: BigInt(String(x['epoch'])), kind: Number(x['kind']), schemaV: Number(x['schema_v']), ts: hlc(String(x['ts'])),
          identity: b(x['identity']), emits: b(x['emits']), audit: b(x['audit']), retention: Number(x['retention']), keyId: b(x['key_id']),
          payload: b(x['payload']), chain: b(x['chain']),
        },
      }));
    },
  };
}
