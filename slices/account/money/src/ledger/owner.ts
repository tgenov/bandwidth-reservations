/**
 * The ledger owner (RFC-004 §B1, C06 §7 … §9) on the C01 runtime. One `post` is one `append` in the home
 * partition. The decision runs inside the posting transaction (`decide`), on the rows it declares. The ledger
 * answers only after `Committed` (X2-S14). It keeps no state in memory: every row is read in the transaction.
 */
import {
  decodeJson, encodeJson, slotOfPartition, utf8,
  type AppendResult, type AuditFields, type CommandEnvelope, type DecideResult, type EntryInput, type Epoch, type Generation,
  type OwnerHooks, type OwnerRuntime, type PartitionKey, type ProjectionWrite, type RoutingRefusal, type RowRef, type SlotNo,
} from '@share/owner-runtime';
import type { PostMovementRequest, PostMovementResponse } from '../contracts/c06.ts';
import { DEFAULT_PARTITION_COUNT, ledgerPartitionOfBuyer } from './accounts.ts';
import {
  decidePost, readsOf,
  type BalanceRecord, type ChainRecord, type Decision, type LedgerAlert, type LedgerReads, type LineRecord, type MovementRefRecord,
  type WeightsSource,
} from './decide.ts';
import { LEDGER_DEV_SLOT_COUNT, LEDGER_ENTRY, LEDGER_STREAM, LEDGER_TABLE } from './declaration.ts';
import { digestOf } from '../money.ts';

/** One call of the posting port (C06 §8). The principal is the caller's workload identity, never the body. */
export interface PostCall {
  /** The ledger partition that the caller routed to (the home of the movement). */
  partition: string;
  principal: string;
  request: PostMovementRequest;
  /** C01 §2.4 routed command: the sender's (generation, epoch), checked by `admitCommand` (C01 CC-5). */
  envelope?: CommandEnvelope;
}

/** The C06 answer, or a C01 routing refusal of the command envelope (C01 §2.4). */
export type LedgerAnswer = PostMovementResponse | { result: 'routing'; refusal: RoutingRefusal };

export interface LedgerOptions {
  weights: WeightsSource;
  partitionCount?: number;
  slotCount?: number;
  /** Re-runs of one post on `Retry`, `Ambiguous`, `ConditionFailed` or an unknown result (same identity). */
  maxReruns?: number;
  /**
   * Appends in flight for each slot. The runtime puts every pending call of a slot in one batch transaction,
   * and a `decide` call counts as one entry of no size (C01 §3.2), so this bounds the work of one transaction
   * (RFC-004 §B10: "about 1 to 3" movements a batch). Default 4.
   */
  maxAppendsPerSlot?: number;
  onAlert?: (a: LedgerAlert) => void;
}

const rowRef = (table: string, key: Record<string, unknown>): RowRef => ({ table, key });

/** The key columns of the ledger's rows. */
export const ledgerRows = {
  balance: (p: PartitionKey, ledgerAccount: string): RowRef => rowRef(LEDGER_TABLE.balance, { partition: p, ledger_account: ledgerAccount }),
  line: (p: PartitionKey, lineKey: string): RowRef => rowRef(LEDGER_TABLE.line, { partition: p, line_key: lineKey }),
  movementRef: (p: PartitionKey, movementRef: string): RowRef => rowRef(LEDGER_TABLE.movementRef, { partition: p, ref_digest: digestOf({ movementRef }) }),
  chain: (p: PartitionKey): RowRef => rowRef(LEDGER_TABLE.chain, { partition: p }),
};

/** The `record` column of a ledger row, decoded. */
export function recordOf<T>(row: unknown): T | undefined {
  if (row === undefined || row === null || typeof row !== 'object') return undefined;
  const r = (row as Record<string, unknown>)['record'];
  return r instanceof Uint8Array ? (decodeJson(r) as T) : undefined;
}

function audit(principal: string): AuditFields {
  return { schema: 'audit.v1', principal: { principal_id: principal, kind: 'workload', tenant: { kind: 'none' } }, decided_at: 'commit', policy_version: 1 };
}

export class LedgerOwner implements OwnerHooks {
  readonly alerts: LedgerAlert[] = [];
  private readonly rt: OwnerRuntime;
  private readonly weights: WeightsSource;
  readonly partitionCount: number;
  private readonly slotCount: number;
  private readonly maxReruns: number;
  private readonly onAlert: ((a: LedgerAlert) => void) | undefined;
  private readonly movedOut = new Set<string>();
  private readonly maxAppendsPerSlot: number;
  private readonly gates = new Map<SlotNo, { active: number; waiting: Array<() => void> }>();

  constructor(rt: OwnerRuntime, opts: LedgerOptions) {
    this.rt = rt;
    this.weights = opts.weights;
    this.partitionCount = opts.partitionCount ?? DEFAULT_PARTITION_COUNT;
    this.slotCount = opts.slotCount ?? LEDGER_DEV_SLOT_COUNT;
    this.maxReruns = opts.maxReruns ?? 3;
    this.maxAppendsPerSlot = opts.maxAppendsPerSlot ?? 4;
    this.onAlert = opts.onAlert;
  }

  /** The home partition of a buyer's movements. */
  partitionOf(account: string): string {
    return ledgerPartitionOfBuyer(account, this.partitionCount);
  }

  /** C06 §8 `post`. */
  async post(call: PostCall): Promise<LedgerAnswer> {
    const pk = utf8(call.partition);
    const slot = slotOfPartition(pk, this.slotCount);
    // C01 CC-7: an answer that is not from a committed append comes only after a valid lease check.
    if (!this.rt.leaseValid(slot).valid) return { result: 'unavailable', why: 'not_owner' };
    // C01 CC-2: after onMovedOut, the partition takes no entry; callers retry on the new route.
    if (this.movedOut.has(call.partition)) return { result: 'unavailable', why: 'moving' };
    let senderFence: EntryInput['senderFence'];
    if (call.envelope) {
      const s = call.envelope.sender;
      const admit = this.rt.admitCommand({ kind: s.kind, partition: s.partition }, { generation: s.generation, epoch: s.epoch });
      if (!admit.admit) return { result: 'routing', refusal: { code: 'STALE_SENDER', recorded: admit.recorded } };
      senderFence = { kind: s.kind, partition: s.partition, generation: s.generation, epoch: s.epoch };
    }
    const { lineKeys, accounts } = readsOf(call.request);
    const reads: RowRef[] = [
      ledgerRows.movementRef(pk, String(call.request.movementRef)), ledgerRows.chain(pk),
      ...lineKeys.map((k) => ledgerRows.line(pk, k)), ...accounts.map((a) => ledgerRows.balance(pk, a)),
    ];
    await this.enter(slot);
    try {
      return await this.append(call, pk, slot, reads, senderFence);
    } finally {
      this.leave(slot);
    }
  }

  private async enter(slot: SlotNo): Promise<void> {
    let g = this.gates.get(slot);
    if (!g) { g = { active: 0, waiting: [] }; this.gates.set(slot, g); }
    if (g.active < this.maxAppendsPerSlot) { g.active += 1; return; }
    await new Promise<void>((resolve) => g.waiting.push(resolve));
  }

  private leave(slot: SlotNo): void {
    const g = this.gates.get(slot);
    if (!g) return;
    const next = g.waiting.shift();
    if (next) next(); else g.active -= 1;
  }

  private async append(call: PostCall, pk: PartitionKey, slot: SlotNo, reads: RowRef[], senderFence: EntryInput['senderFence']): Promise<LedgerAnswer> {
    const epoch = Number(this.rt.epoch(slot));
    for (let run = 0; run <= this.maxReruns; run++) {
      let decision: Decision | undefined;
      const result: AppendResult = await this.rt.append({
        partition: pk, reads,
        decide: (ctx) => {
          const head = ctx.head(pk);
          const read: LedgerReads = {
            movementRef: recordOf<MovementRefRecord>(ctx.read(reads[0]!)),
            chain: recordOf<ChainRecord>(ctx.read(reads[1]!)),
            line: (k) => recordOf<LineRecord>(ctx.read(ledgerRows.line(pk, k))),
            balance: (a) => recordOf<BalanceRecord>(ctx.read(ledgerRows.balance(pk, a))),
          };
          decision = decidePost({
            partition: call.partition, principal: call.principal, request: call.request, ts: ctx.ts, seq: head.seq + 1n,
            streams: head.streams, generation: head.generation, epoch, weights: this.weights, partitionCount: this.partitionCount,
          }, read);
          return this.writes(pk, decision, call, senderFence);
        },
      });
      switch (result.r) {
        case 'Committed':
          for (const a of decision?.alerts ?? []) this.alert(a);
          if (!decision) throw new Error('Committed without a decision');
          return decision.response;
        case 'Retry': case 'Ambiguous': case 'ConditionFailed':
          continue;
        case 'Moving': return { result: 'unavailable', why: 'moving' };
        case 'Moved': case 'StaleEpoch': return { result: 'unavailable', why: 'not_owner' };
        case 'Stopped': return { result: 'unavailable', why: 'stopped' };
        case 'Overloaded': return { result: 'unavailable', why: 'overloaded' };
        default:
          // C01 §8: an unknown result is a Retry, with an alert.
          this.alert({ code: 'MOVEMENT_REFUSED', partition: call.partition, movementRef: String(call.request.movementRef),
            detail: `UNKNOWN_APPEND_RESULT ${String((result as { r: unknown }).r)}` });
          continue;
      }
    }
    return { result: 'unavailable', why: 'overloaded' };
  }

  private alert(a: LedgerAlert): void {
    this.alerts.push(a);
    this.onAlert?.(a);
  }

  /** The log entry, projections and feed events of one decision. */
  private writes(pk: PartitionKey, d: Decision, call: PostCall, senderFence: EntryInput['senderFence']): DecideResult {
    const fence = senderFence ? { senderFence } : {};
    if (d.kind === 'answer') return { entries: [] };
    if (d.kind === 'refuse') {
      const projections: ProjectionWrite[] = d.record ? [this.row(ledgerRows.movementRef(pk, d.record.movementRef), d.record)] : [];
      const entry: EntryInput = {
        kind: LEDGER_ENTRY.refusal, schemaV: 1, identity: utf8(`refusal|${d.refusal.movementRef}|${d.refusal.requestDigest}|${d.refusal.reason}`),
        audit: audit(call.principal), payload: { refusal: d.refusal }, ...fence,
      };
      return { entries: [entry], projections };
    }
    const emits: NonNullable<EntryInput['emits']> = [
      { stream: LEDGER_STREAM.movements, event: d.event },
      ...d.buyers.map((b) => ({ stream: LEDGER_STREAM.byBuyer, event: { ...d.event, view_key: b } })),
      ...d.suppliers.map((s) => ({ stream: LEDGER_STREAM.bySupplier, event: { ...d.event, view_key: s } })),
      ...d.externals.map((x) => ({ stream: LEDGER_STREAM.byExternal, event: { ...d.event, view_key: x } })),
      ...(d.ack ? [{ stream: LEDGER_STREAM.postingAcks, event: d.ack }] : []),
    ];
    const entry: EntryInput = {
      kind: LEDGER_ENTRY.movement, schemaV: 1, identity: utf8(`movement|${d.movement.movementRef}`), audit: audit(call.principal),
      payload: { movement: d.movement }, emits, ...fence,
    };
    const projections: ProjectionWrite[] = [
      this.row(ledgerRows.movementRef(pk, d.record.movementRef), d.record),
      this.row(ledgerRows.chain(pk), d.chain),
      ...[...d.lines].map(([k, r]) => this.row(ledgerRows.line(pk, k), r)),
      ...[...d.balances].map(([a, r]) => ({ ...this.row(ledgerRows.balance(pk, a), r), row: { ...(ledgerRows.balance(pk, a).key as object), balance: BigInt(r.balance), record: encodeJson(r) } })),
    ];
    return { entries: [entry], projections };
  }

  private row(ref: RowRef, record: unknown): ProjectionWrite {
    return { table: ref.table, op: 'upsert', key: ref.key, row: { ...(ref.key as object), record: encodeJson(record) } };
  }

  // ---------------- C01 hooks ----------------

  async onAcquire(_slot: SlotNo, _epoch: Epoch): Promise<void> {
    // The ledger keeps no memory of a partition: each post reads its rows in the transaction (C01 CC-3).
  }

  onRelease(_slot: SlotNo): void {}

  onReportable(_slot: SlotNo): void {}

  onMovedOut(partition: PartitionKey): void {
    this.movedOut.add(Buffer.from(partition).toString('utf8'));
  }

  async onAdopt(partition: PartitionKey, _generation: Generation): Promise<void> {
    this.movedOut.delete(Buffer.from(partition).toString('utf8'));
  }

  async onNotification(): Promise<void> {}
}
