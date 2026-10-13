import type {
  AppendResult, AuditFields, Epoch, Generation, InboundNotification, OwnerHooks, OwnerRuntime, PartitionKey, SlotNo,
} from '@share/owner-runtime';
import { hex, slotOfPartition, utf8 } from '@share/owner-runtime';
import { declaration } from './declaration.ts';

const AUDIT: AuditFields = {
  schema: 'audit.v1', principal: { principal_id: 'internal_service', kind: 'service', tenant: 'share' },
  decided_at: 'commit', policy_version: 1,
};

export type IncrementAnswer =
  | { ok: true; value: bigint; duplicate: boolean }
  | { ok: false; reason: 'unavailable' | 'retryLater' | 'notOwner' };

function asBigInt(v: unknown): bigint {
  return typeof v === 'bigint' ? v : BigInt(String(v ?? 0));
}

function readValue(row: unknown): bigint {
  return row && typeof row === 'object' ? asBigInt((row as Record<string, unknown>)['value']) : 0n;
}

/** The canary owner: `increment(partition, id)` adds one, once per id (C01 §3.2 result handling). */
export class CanaryOwner implements OwnerHooks {
  private readonly rt: OwnerRuntime;
  private readonly takeoverDue = new Set<string>();
  readonly held = new Set<SlotNo>();

  constructor(rt: OwnerRuntime) {
    this.rt = rt;
  }

  async onAcquire(slot: SlotNo, _epoch: Epoch): Promise<void> {
    this.held.add(slot);
  }
  onRelease(slot: SlotNo): void {
    this.held.delete(slot);
  }
  onReportable(): void {}
  onMovedOut(): void {}
  async onAdopt(partition: PartitionKey, _g: Generation): Promise<void> {
    this.takeoverDue.add(hex(partition));
  }
  async onNotification(_n: InboundNotification): Promise<void> {}

  async increment(partition: PartitionKey, id: string, attempts = 5): Promise<IncrementAnswer> {
    const identity = utf8(`increment:${id}`);
    const counter = { table: 'canary_counter', key: { partition } };
    const applied = { table: 'canary_applied', key: { partition, identity } };
    for (let i = 0; i < attempts; i++) {
      let duplicate = false;
      const r: AppendResult = await this.rt.append({
        partition,
        reads: [counter, applied],
        decide: (ctx) => {
          if (ctx.read(applied) !== undefined) { duplicate = true; return null; }
          const value = readValue(ctx.read(counter)) + 1n;
          return {
            entries: [{ kind: 1, schemaV: 1, identity, audit: AUDIT, payload: { id, value },
              emits: [{ stream: 'counter', event: { id, value } }] }],
            projections: [
              { table: 'canary_counter', op: 'upsert', key: { partition }, row: { value } },
              { table: 'canary_applied', op: 'upsert', key: { partition, identity }, row: { seq: ctx.head(partition).seq + 1n } },
            ],
          };
        },
      });
      switch (r.r) {
        case 'Committed':
          return { ok: true, value: await this.current(partition), duplicate: false };
        case 'ConditionFailed':
          if (duplicate) return { ok: true, value: await this.current(partition), duplicate: true };
          return { ok: false, reason: 'retryLater' };
        case 'Stopped':
          return { ok: false, reason: 'unavailable' };
        case 'StaleEpoch': case 'Moved':
          return { ok: false, reason: 'notOwner' };
        case 'Moving': case 'Retry': case 'Ambiguous': case 'Overloaded':
          await new Promise((res) => setTimeout(res, 20 * (i + 1)));
          continue;
        default:
          // C01 §8: an unknown result is Retry plus an alert.
          console.error(`canary: unknown AppendResult ${(r as { r: string }).r}`);
          continue;
      }
    }
    return { ok: false, reason: 'retryLater' };
  }

  /** The committed value (a present-time consistent read). */
  async current(partition: PartitionKey): Promise<bigint> {
    return this.rt.consistentRead(async (tx) => {
      const rows = await tx.query('SELECT value FROM canary_counter WHERE partition = $1', [partition]);
      return readValue(rows[0]);
    }, 'present');
  }

  slotOf(partition: PartitionKey): SlotNo {
    return slotOfPartition(partition, declaration.slotCount);
  }
}
