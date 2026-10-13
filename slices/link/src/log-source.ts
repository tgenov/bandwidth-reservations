/**
 * How the owner reads its own log to rebuild a link (RFC-001 §7.4, §8; C01 §3.1 "Rebuilding a partition").
 *
 * The runtime gives the opened log of a partition through `readLog(partition, fromSeq)` (S-PLAT I1b): it reads
 * the rows by (partition, seq) across the slots the partition lived in, opens each sealed payload and unwraps
 * the sender-fence envelope (R47-24). The owner must not open `link_log` rows itself: a row with a sender
 * fence holds `{ $payload, $senderFence }`, not the entry payload. The runtime double gives its log through
 * `RuntimeDouble.log()`; the unit tests use that.
 */
import type { Epoch, HlcTs, PartitionKey, Seq } from '@share/owner-runtime';

export interface LoggedEntry { seq: Seq; ts: HlcTs; epoch: Epoch; kind: number; payload: unknown }

/** Returns the entries of a partition with seq > `after`, in sequence order. */
export type LogReader = (partition: PartitionKey, after: Seq) => Promise<LoggedEntry[]>;

/** The part of the runtime that reads opened log rows (CockroachOwnerRuntime.readLog). */
export interface OpenedLogSource {
  readLog(partition: PartitionKey, fromSeq?: Seq): Promise<Array<{ seq: Seq; ts: HlcTs; epoch: Epoch; kind: number; payload: unknown }>>;
}

/** A log reader on the C01 runtime core (any store): the runtime's opened rows with seq > `after`. */
export function runtimeLogReader(rt: OpenedLogSource): LogReader {
  return async (partition, after) => (await rt.readLog(partition, after + 1n))
    .map((r) => ({ seq: r.seq, ts: r.ts, epoch: r.epoch, kind: r.kind, payload: r.payload }));
}
