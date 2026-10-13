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
import { hex } from '../bytes.ts';

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
