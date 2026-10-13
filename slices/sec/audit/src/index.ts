/**
 * @share/audit — audit's append log, S-SEC I1 part (C08 §J "Append", R46-11; test P-17).
 *
 * `audit_append(source_ref, record)` → position, acknowledged once committed in audit's own chained log. The
 * owner runtime writes the chain (C08 §J); `verifyAuditChain` re-computes it from the C08 text (iam-lib).
 */
import { createHash } from 'node:crypto';
import type {
  AppendResult, Epoch, Generation, InboundNotification, OwnerDeclaration, OwnerHooks, OwnerRuntime, PartitionKey, SlotNo,
} from '@share/owner-runtime';
import { hex } from '@share/owner-runtime';
import {
  internalAudit, jcs, toRuntimeAudit, verifyChains,
  type AuditAppend, type AuditAppendAnswer, type ChainedRow,
} from '@share/iam-lib';

export const AUDIT_KIND = 'audit';
export const ENTRY_APPENDED = 1;

export const declaration: OwnerDeclaration = {
  kind: AUDIT_KIND,
  slotCount: 16,
  entryKinds: [{ kind: ENTRY_APPENDED, name: 'appended', schemaVersions: [1], retention: '7y' }],
  projections: [
    {
      // Idempotency by (source, source_ref); the partition is the source.
      name: 'source_ref',
      ddl: 'partition BYTES NOT NULL, source_ref STRING NOT NULL, seq INT8 NOT NULL, digest BYTES NOT NULL, '
        + 'PRIMARY KEY (partition, source_ref)',
      clearColumns: ['partition', 'source_ref', 'seq', 'digest'],
    },
  ],
  streams: [],
};

const SOURCE_REF_TABLE = `${AUDIT_KIND}_source_ref`;

export interface AuditClient {
  /** The caller's workload identity comes from mTLS; in process it is passed here. */
  append(callerWorkload: string, req: AuditAppend): Promise<AuditAppendAnswer>;
}

export interface AuditServiceOptions {
  runtime: OwnerRuntime;
  /** Caller allowlist (C08 §J; from the policy bundle in I2). */
  allowlist: ReadonlySet<string>;
  /** Page security (a `source_ref_conflict`). */
  page: (message: string) => void;
  alert?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

interface SourceRefRow { seq: bigint; digest: Uint8Array }

export function sourcePartition(source: string): PartitionKey {
  return new Uint8Array(Buffer.from(`source/${source}`, 'utf8'));
}

export class AuditService implements OwnerHooks, AuditClient {
  private readonly o: AuditServiceOptions;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(o: AuditServiceOptions) {
    this.o = o;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async onAcquire(_s: SlotNo, _e: Epoch): Promise<void> {}
  onRelease(): void {}
  onReportable(): void {}
  onMovedOut(): void {}
  async onAdopt(_p: PartitionKey, _g: Generation): Promise<void> {}
  async onNotification(_n: InboundNotification): Promise<void> {}

  async append(callerWorkload: string, req: AuditAppend): Promise<AuditAppendAnswer> {
    if (!this.o.allowlist.has(callerWorkload)) return { kind: 'refused', reason: 'caller_not_allowed' };
    // `source` is set from the caller's mTLS identity, never from the payload (R46-11).
    const source = callerWorkload;
    const partition = sourcePartition(source);
    const ref = { table: SOURCE_REF_TABLE, key: { partition, source_ref: req.source_ref } };
    const digest = new Uint8Array(createHash('sha256').update(jcs(req.record)).digest());
    const identity = new Uint8Array(Buffer.from(`append:${req.source_ref}`, 'utf8'));
    const attempts = this.o.maxAttempts ?? 6;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let existing: SourceRefRow | undefined;
      const r: AppendResult = await this.o.runtime.append({
        partition,
        reads: [ref],
        decide: (ctx) => {
          existing = ctx.read(ref) as SourceRefRow | undefined;
          if (existing) return null;
          const seq = ctx.head(partition).seq + 1n;
          return {
            entries: [{ kind: ENTRY_APPENDED, schemaV: 1, identity,
              audit: toRuntimeAudit(internalAudit(source, req.record.policy_version)),
              payload: { source, source_ref: req.source_ref, record: jcs(req.record) } }],
            projections: [{ table: SOURCE_REF_TABLE, op: 'upsert', key: { partition, source_ref: req.source_ref }, row: { seq, digest } }],
          };
        },
      });
      switch (r.r) {
        case 'Committed':
          return { kind: 'appended', source, position: { partition: hex(partition), seq: r.seqFrom.toString() } };
        case 'ConditionFailed': {
          const e = existing as SourceRefRow | undefined;
          if (!e) return { kind: 'temporarily_unavailable' };
          if (Buffer.compare(Buffer.from(e.digest), Buffer.from(digest)) === 0) {
            return { kind: 'appended', source, position: { partition: hex(partition), seq: e.seq.toString() } };
          }
          this.o.page(`audit_append source_ref_conflict: source ${source}, source_ref ${req.source_ref}`);
          return { kind: 'refused', reason: 'source_ref_conflict' };
        }
        case 'Stopped': case 'StaleEpoch': case 'Moved':
          return { kind: 'temporarily_unavailable' };
        case 'Retry': case 'Ambiguous': case 'Moving':
          await this.sleep(20 * (attempt + 1));
          continue;
        case 'Overloaded':
          await this.sleep(r.retryAfterMs);
          continue;
        default:
          this.o.alert?.(`unknown AppendResult ${(r as { r: string }).r}; treated as Retry (C01 §8)`);
          continue;
      }
    }
    return { kind: 'temporarily_unavailable' };
  }
}

/** A stored log row of any kind, as the audit changefeed or a restore check reads it. */
export interface StoredLogRow {
  partition: Uint8Array; seq: bigint; slot: number; generation: number; epoch: bigint; kind: number; schemaV: number;
  identity: Uint8Array; emits: Uint8Array; retention: number; keyId: Uint8Array; audit: Uint8Array; payload: Uint8Array;
  chain: Uint8Array;
}

/** Re-compute the C08 §J chain of stored log rows of one owner kind. */
export function verifyAuditChain(kindName: string, rows: StoredLogRow[]): ReturnType<typeof verifyChains> {
  const chained: ChainedRow[] = rows.map((r) => ({
    kindName, partition: r.partition, seq: r.seq, slot: r.slot, generation: r.generation, epoch: r.epoch,
    entryKind: r.kind, schemaV: r.schemaV, identity: r.identity, emits: r.emits, retention: r.retention,
    keyId: r.keyId, audit: r.audit, payload: r.payload, chain: r.chain,
  }));
  return verifyChains(chained);
}
