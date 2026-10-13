/**
 * How the owner reads its own log to rebuild a link (RFC-001 §7.4, §8; C01 §3.1 "Rebuilding a partition").
 *
 * Runtime API gap: C01 v1 `OwnerRuntime` gives no operation that returns the opened log entries of a
 * partition. The owner must read `link_log` by SQL through `consistentRead` and open each sealed payload
 * itself with the C01 §3.12 binding. This module keeps that work in one place. The runtime double gives
 * its log through `RuntimeDouble.log()`; the tests use that.
 */
import type { Epoch, HlcTs, OwnerRuntime, PartitionKey, Seq } from '@share/owner-runtime';
import { DevSealer, decodeJson, hlc, slotOfPartition, type Sealer } from '@share/owner-runtime';
import { declaration, LINK_KIND } from './declaration.ts';

export interface LoggedEntry { seq: Seq; ts: HlcTs; epoch: Epoch; kind: number; payload: unknown }

/** Returns the entries of a partition with seq > `after`, in sequence order. */
export type LogReader = (partition: PartitionKey, after: Seq) => Promise<LoggedEntry[]>;

/** One row of `link_log` as the database stores it (C01 §2.3). */
export interface SealedLogRow {
  slot: number; partition: Uint8Array; seq: bigint; epoch: bigint; kind: number; ts: HlcTs; payload: Uint8Array;
}

/** Open the sealed payload of a log row (the seal context of the runtime, C01 §3.12). */
export function openLogRow(row: SealedLogRow, sealer: Sealer = new DevSealer()): LoggedEntry {
  const plain = sealer.open(row.payload, {
    ownerKind: LINK_KIND, table: `${LINK_KIND}_log`,
    primaryKey: { slot: row.slot, partition: row.partition, seq: row.seq },
    seqOrVersion: row.seq, epoch: row.epoch, rowKind: `entry:${row.kind}`,
  });
  return { seq: row.seq, ts: row.ts, epoch: row.epoch, kind: row.kind, payload: decodeJson(plain) };
}

/** A log reader on the CockroachDB runtime: a present-time consistent read of `link_log` by (partition, seq). */
export function sqlLogReader(rt: OwnerRuntime, sealer: Sealer = new DevSealer()): LogReader {
  return async (partition, after) => rt.consistentRead(async (tx) => {
    // The text columns have other names, so that ORDER BY sorts the INT8 column, not its text.
    const rows = await tx.query<{ slot: number; seq_s: string; epoch_s: string; kind: number; ts_s: string; payload: Uint8Array }>(
      `SELECT slot, seq::STRING AS seq_s, epoch::STRING AS epoch_s, kind, ts::STRING AS ts_s, payload
         FROM ${LINK_KIND}_log WHERE partition = $1 AND seq > $2 ORDER BY seq`,
      [Buffer.from(partition), after.toString()],
    );
    return rows.map((r) => openLogRow({
      slot: Number(r.slot ?? slotOfPartition(partition, declaration.slotCount)), partition, seq: BigInt(r.seq_s),
      epoch: BigInt(r.epoch_s), kind: Number(r.kind), ts: hlc(r.ts_s), payload: new Uint8Array(r.payload),
    }, sealer));
  }, 'present');
}
