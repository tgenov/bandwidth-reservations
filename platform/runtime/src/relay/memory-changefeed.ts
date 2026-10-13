/**
 * A changefeed stand-in for unit tests: every outbox row a MemoryStore commits is written to `cdc.<kind>` in
 * the CockroachDB JSON form (envelope wrapped, BYTES as "\\x<hex>"), and `resolve()` writes a resolved
 * timestamp to every `cdc.<kind>` partition, as a changefeed does.
 */
import type { HlcTs } from '../api.ts';
import { hex } from '../bytes.ts';
import { compareHlc } from '../hlc.ts';
import type { MemoryBus } from '../feed/memory-bus.ts';
import { cdcTopic } from '../feed/wire.ts';
import type { MemoryStore } from '../store/memory.ts';
import type { OutboxRowWrite } from '../store/types.ts';

const b = (x: Uint8Array): string => `\\x${hex(x)}`;

export class MemoryChangefeed {
  private readonly bus: MemoryBus;
  private readonly kind: string;
  private last: HlcTs | undefined;
  private queue: Promise<void> = Promise.resolve();
  paused = false;
  private held: Array<{ row: OutboxRowWrite; ts: HlcTs }> = [];

  constructor(store: MemoryStore, bus: MemoryBus, kind: string, partitions = 1) {
    this.bus = bus;
    this.kind = kind;
    void bus.ensureTopic(cdcTopic(kind), partitions);
    store.commitListeners.push((k, w) => {
      if (k !== kind) return;
      for (const row of w.outbox) this.held.push({ row, ts: w.ts });
      if (!this.paused) this.flush();
    });
  }

  /** Write the held rows (a paused changefeed holds rows back, as a lagging one does). */
  flush(): void {
    const rows = this.held.splice(0);
    for (const { row, ts } of rows) {
      if (this.last === undefined || compareHlc(ts, this.last) > 0) this.last = ts;
      const after = {
        slot: row.slot, partition: b(row.partition), stream: row.stream, stream_seq: Number(row.streamSeq), n: row.n, topic: row.topic,
        msg_key: b(row.msgKey), headers: b(row.headers), payload: b(row.payload), ts: `@TS@`, generation: row.generation, epoch: Number(row.epoch),
      };
      // The DECIMAL ts goes in as a bare JSON number, exactly as CockroachDB writes it.
      const text = JSON.stringify({ after, updated: ts }).replace('"@TS@"', ts);
      const key = new Uint8Array(Buffer.from(JSON.stringify([row.slot, b(row.partition), row.stream, Number(row.streamSeq), row.n])));
      this.queue = this.queue.then(() => this.bus.produce(cdcTopic(this.kind), [{ key, value: new Uint8Array(Buffer.from(text)) }]));
    }
  }

  /** Write a delete event (a TTL or manual delete), which the relay must drop. */
  async writeDelete(): Promise<void> {
    await this.queue;
    await this.bus.produce(cdcTopic(this.kind), [{ key: new Uint8Array(Buffer.from('[]')), value: new Uint8Array(Buffer.from('{"after": null, "updated": "1.0000000000"}')) }]);
  }

  /** Resolved timestamp = the newest row written so far, on every partition (or only `partitions`). */
  async resolve(at?: HlcTs, partitions?: number[]): Promise<HlcTs | undefined> {
    await this.queue;
    const R = at ?? this.last;
    if (R === undefined) return undefined;
    const n = await this.bus.partitionCount(cdcTopic(this.kind));
    const value = new Uint8Array(Buffer.from(`{"resolved":"${R}"}`));
    for (let k = 0; k < n; k++) {
      if (partitions && !partitions.includes(k)) continue;
      await this.bus.produce(cdcTopic(this.kind), [{ key: null, value, partition: k }]);
    }
    return R;
  }
}
