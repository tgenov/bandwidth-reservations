/**
 * Attribution stage B (RFC-003 §4.3; C11 Part IV consumer).
 *
 * It appends each part batch of an account once: a batch at or below the producer watermark
 * of its stage A partition is dropped, and a gap waits. It keeps the attachment set from the
 * forwarded binding facts. After `Committed` it gives the batch to rating in process (the
 * stage B and rating slots are one slot group). The T4 check comes in I14.
 */
import type {
  BatchContext, Epoch, FeedEvent, Generation, InboundNotification, OwnerHooks, OwnerRuntime, PartitionKey, SlotNo,
} from '@share/owner-runtime';
import { decodeJson, utf8 } from '@share/owner-runtime';
import {
  FeedCursor, SerialQueue, TOPIC_PARTS, appendWithPolicy, eventDigest, identityOf, serviceAudit,
  type AlertSink, type ForwardedBinding, type Part, type PartBatch,
} from '@share/rate-common';
import { ATTR_B_ENTRY } from '../declarations.ts';

/** What stage B gives to rating after each committed `parts` entry (the in-process hand-off, RFC-003 §4.3). */
export interface StageBInput {
  account: string;
  /** The `attr_b_log` sequence of the entry: rating records it in its `inputs` entry. */
  attrBSeq: string;
  parts: Part[];
  bindingFacts: ForwardedBinding[];
}

export interface RatingSink { applyParts(input: StageBInput): Promise<void> }

export interface StageBOptions { rating: RatingSink; alerts?: AlertSink; sleep?: (ms: number) => Promise<void> }

export class StageBOwner implements OwnerHooks {
  private readonly rt: OwnerRuntime;
  private readonly opts: StageBOptions;
  private readonly queue = new SerialQueue();
  private readonly cursor = new FeedCursor<PartBatch>();
  /** Account to the attachment set: (exporter, bindingId) to the forwarded binding. */
  private readonly attachment = new Map<string, Map<string, ForwardedBinding>>();

  constructor(rt: OwnerRuntime, opts: StageBOptions) {
    this.rt = rt;
    this.opts = opts;
    rt.subscribe(TOPIC_PARTS, { positions: [] }, 'committed', (e) => this.queue.run(() => this.onPartBatch(e)));
  }

  idle(): Promise<void> {
    return this.queue.idle();
  }

  async onAcquire(_s: SlotNo, _e: Epoch): Promise<void> {}
  onRelease(_s: SlotNo): void {}
  onReportable(): void {}
  onMovedOut(p: PartitionKey): void {
    this.attachment.delete(Buffer.from(p).toString('utf8'));
  }
  async onAdopt(_p: PartitionKey, _g: Generation): Promise<void> {}
  async onNotification(_n: InboundNotification): Promise<void> {}

  /** The products attached for the account in the minute (valid time, C11 F41-11). */
  attachedProducts(account: string, minuteMs: number): string[] {
    const set = new Set<string>();
    for (const b of this.attachment.get(account)?.values() ?? []) {
      if (!b.retracted && b.validFromMs < minuteMs + 60_000 && (b.validToMs === null || minuteMs < b.validToMs)) set.add(b.productId);
    }
    return [...set].sort();
  }

  private async onPartBatch(e: FeedEvent): Promise<void> {
    const pb = decodeJson(e.value) as PartBatch;
    const account = pb.feedId.accountId;
    const key = `${account}|${pb.feedId.stageAPartition}`;
    const digest = eventDigest(e);
    const ready = this.cursor.offer(key, BigInt(pb.destSeq), pb, digest);
    if (this.cursor.isBlocked(key)) {
      this.opts.alerts?.raise({ owner: 'attr_b', kind: 'PART_BATCH_CONFLICT', detail: key });
      return;
    }
    for (const r of ready) {
      const seq = await this.append(r.item, r.digest);
      if (seq === undefined) return;
      this.cursor.commit(key, r.seq, r.digest);
      const att = this.attachment.get(account) ?? new Map<string, ForwardedBinding>();
      for (const b of r.item.bindingFacts) att.set(`${b.exporterId}|${b.bindingId}`, b);
      this.attachment.set(account, att);
      await this.opts.rating.applyParts({ account, attrBSeq: seq.toString(), parts: r.item.parts, bindingFacts: r.item.bindingFacts });
    }
  }

  private async append(pb: PartBatch, digest: string): Promise<bigint | undefined> {
    const account = pb.feedId.accountId;
    const partition = utf8(account);
    let seq: bigint | undefined;
    const out = await appendWithPolicy(this.rt, {
      partition,
      decide: (ctx: BatchContext) => {
        seq = ctx.head(partition).seq + 1n;
        return {
          entries: [{ kind: ATTR_B_ENTRY.parts, schemaV: 1, audit: serviceAudit('attr_b'),
            identity: identityOf('attr_b.parts', account, pb.feedId.stageAPartition, pb.destSeq),
            // The checkpoint of the applied event with its digest (C01 §3.5, CC-6).
            payload: { batch: pb, applied: { stageAPartition: pb.feedId.stageAPartition, destSeq: pb.destSeq, digest } } }],
          projections: [
            { table: 'attr_b_producer_watermark', op: 'upsert', key: { partition, stage_a_partition: pb.feedId.stageAPartition }, row: { dest_seq: BigInt(pb.destSeq) } },
            ...pb.bindingFacts.map((b) => ({ table: 'attr_b_attachment', op: 'upsert' as const,
              key: { partition, exporter_id: b.exporterId, binding_id: b.bindingId }, row: { binding: b } })),
          ],
        };
      },
    }, undefined, { owner: 'attr_b', ...(this.opts.alerts ? { alerts: this.opts.alerts } : {}), ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}) });
    return out.ok ? seq : undefined;
  }
}
