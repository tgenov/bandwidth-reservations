/**
 * Metering ingestion (RFC-003 §3; C11 Part I, I1 subset).
 *
 * I1 scope: IPFIX only; export messages only (no corrections, no supersessions); one wrap
 * (k = 0). Each record gets one outcome: accepted, duplicate or rejected. The batch
 * acknowledgement goes out only after `Committed`, which C01 §3.2 defines as durable in two
 * regions (X2-S14). A batch that holds a non-conforming payload, or anything else outside the
 * I1 subset, is not committed and not acknowledged: the exporter resends it (plan §6 I2,
 * temporary rule). So no payload of that kind gets to a log.
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  AcquisitionKind, AppendCall, BatchContext, Epoch, Generation, InboundNotification, OwnerHooks, OwnerRuntime,
  PartitionKey, ProjectionWrite, SlotNo,
} from '@share/owner-runtime';
import { hlcToWallMs, slotOfPartition, utf8 } from '@share/owner-runtime';
import {
  RATE_PARAMS, appendWithPolicy, identityOf, type AlertSink, type Batch, type BatchAck, type EdgeFrame,
  type ExporterOwner, type Hello, type LoggedContext, type MessageAck, type RecordIdentity, type RejectKey,
  type RejectReason, type RejectedRecord,
} from '@share/rate-common';
import { INGEST_ENTRY, ingestDeclaration } from './declaration.ts';
import { emitHandoff, type BatchEntryPayload } from './emit.ts';
import { decodeItem, recordFields, type DecodedItem } from './ipfix.ts';

/** The C08 §A principal context fields that ingestion reads. The edge forwards the context with each batch. */
export interface EdgePrincipal {
  schema: 'principal.v1';
  principal_id: string;
  kind: string;
  tenant: { kind: 'supplier'; supplier: string } | { kind: 'account'; account: string } | { kind: 'none' };
  cert_serial?: string;
  probe: boolean;
  edge_region: 'R1' | 'R2';
}

/** What the edge knows about the TLS session: the principal context and the certificate's `device_cert.exporter`. */
export interface EdgeContext { principal: EdgePrincipal; exporterId?: string }

interface EpochRow { epoch: number; initTimeMs: number }
type Interval = [bigint, bigint];

interface ExporterState {
  format?: 'ipfix' | 'netflow-v9';
  epochs: Map<number, EpochRow[]>;
  ranges: Map<string, Interval[]>;
  contexts: Map<string, bigint>;
}

export interface IngestOptions {
  alerts?: AlertSink;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

const T = {
  format: 'ingest_format', epoch: 'ingest_epoch', range: 'ingest_range_chunk', context: 'ingest_context',
} as const;

function digest64(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex').slice(0, 16);
}

function contains(intervals: Interval[] | undefined, x: bigint): boolean {
  return (intervals ?? []).some(([lo, hi]) => lo <= x && x <= hi);
}

function addPoint(intervals: Interval[], x: bigint): Interval[] {
  const all = [...intervals, [x, x] as Interval].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: Interval[] = [];
  for (const iv of all) {
    const lastIv = out[out.length - 1];
    if (lastIv && iv[0] <= lastIv[1] + 1n) lastIv[1] = iv[1] > lastIv[1] ? iv[1] : lastIv[1];
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

function ownerOf(p: EdgePrincipal): ExporterOwner {
  return p.tenant.kind === 'supplier' ? { kind: 'supplier', supplierId: p.tenant.supplier } : { kind: 'share' };
}

/** One record of a planned batch, before the log sequence is known. */
interface PlannedRecord {
  item: number;
  messageSeq: bigint;
  domain: number;
  epoch: number;
  outcome: 'accepted' | 'duplicate' | 'rejected';
  identity?: RecordIdentity;
  digest: string;
  reason?: RejectReason;
  rejectKey?: RejectKey;
  rawRef: { exporterId: string; message: number; record: number };
  accepted?: BatchEntryPayload['accepted'][number];
}

interface Plan {
  newEpochs: Array<{ domain: number } & EpochRow>;
  records: PlannedRecord[];
  items: BatchEntryPayload['items'];
  contexts: Array<{ hash: string; bytes: Uint8Array }>;
  firstBatch: boolean;
}

export type BatchAnswer = EdgeFrame[];

export class IngestOwner implements OwnerHooks {
  readonly kind = 'ingest';
  private readonly state = new Map<string, ExporterState>();
  private readonly held = new Set<SlotNo>();

  private readonly rt: OwnerRuntime;
  private readonly opts: IngestOptions;

  constructor(rt: OwnerRuntime, opts: IngestOptions = {}) {
    this.rt = rt;
    this.opts = opts;
    for (let s = 0; s < ingestDeclaration.slotCount; s++) this.held.add(s);
  }

  // ---------- C01 hooks ----------

  async onAcquire(slot: SlotNo, _epoch: Epoch, _kind: AcquisitionKind): Promise<void> {
    this.held.add(slot);
  }
  onRelease(slot: SlotNo): void {
    this.held.delete(slot);
    for (const k of [...this.state.keys()]) if (slotOfPartition(utf8(k), ingestDeclaration.slotCount) === slot) this.state.delete(k);
  }
  onReportable(): void {}
  onMovedOut(partition: PartitionKey): void {
    this.state.delete(Buffer.from(partition).toString('utf8'));
  }
  async onAdopt(_p: PartitionKey, _g: Generation): Promise<void> {}
  async onNotification(_n: InboundNotification): Promise<void> {}

  // ---------- Part I sessions ----------

  /** Session open (C11 Part I): a `device_cert` of kind exporter or probe that names an exporter. */
  openSession(edge: EdgeContext): IngestSession | { refused: true; reason: string } {
    const k = edge.principal.kind;
    if ((k !== 'exporter' && k !== 'probe') || !edge.exporterId) return { refused: true, reason: 'not an exporter credential' };
    return new IngestSession(this, edge);
  }

  exporterState(exporterId: string): ExporterState {
    let s = this.state.get(exporterId);
    if (!s) { s = { epochs: new Map(), ranges: new Map(), contexts: new Map() }; this.state.set(exporterId, s); }
    return s;
  }

  /** The export format recorded for the exporter, if any (D57-5). */
  formatOf(exporterId: string): 'ipfix' | 'netflow-v9' | undefined {
    return this.state.get(exporterId)?.format;
  }

  /** Validate, log and acknowledge one batch (C11 Part I "Batch" and "Acknowledgement"). */
  async ingestBatch(edge: EdgeContext, sessionId: string, batch: Batch): Promise<BatchAnswer> {
    const exporterId = edge.exporterId as string;
    const st = this.exporterState(exporterId);
    if (st.format !== undefined && st.format !== 'ipfix') return [{ notice: { kind: 'protocol-error', detail: 'export format' } }];
    const size = batch.items.reduce((n, it) => n + ('exportMessage' in it ? it.exportMessage.message.byteLength + it.exportMessage.context.byteLength : 0), 0);
    if (size > RATE_PARAMS.maxBatchBytes) return [{ notice: { kind: 'protocol-error', detail: 'batch too large' } }];

    const nowMs = hlcToWallMs(this.rt.now().ts);
    const planned = this.plan(exporterId, st, batch, nowMs);
    if ('outside' in planned) {
      // Not committed and not acknowledged: the exporter resends (plan §6 I2, temporary rule).
      this.opts.alerts?.raise({ owner: 'ingest', kind: 'BATCH_OUTSIDE_I1', detail: planned.outside });
      return [{ notice: { kind: 'waiting', detail: planned.outside } }];
    }
    const plan = planned;
    const partition = utf8(exporterId);
    const owner = ownerOf(edge.principal);
    const certSerial = edge.principal.cert_serial ?? '';
    const itemsDigest = createHash('sha256');
    for (const it of plan.items) itemsDigest.update(it.message);
    const identity = identityOf('ingest.batch', exporterId, sessionId, batch.batchNo, itemsDigest.digest('hex'));

    // Each message that has an accepted record writes one range chunk, keyed by its first sequence.
    const chunkKeys = new Map<string, { domain: number; epoch: number; lo: bigint }>();
    for (const r of plan.records) {
      if (r.outcome !== 'accepted') continue;
      chunkKeys.set(`${r.item}`, { domain: r.domain, epoch: r.epoch, lo: r.messageSeq });
    }
    const chunkRef = (c: { domain: number; epoch: number; lo: bigint }) =>
      ({ table: T.range, key: { partition, observation_domain: c.domain, epoch: c.epoch, lo: c.lo } });

    let final: { payload: BatchEntryPayload; logSeq: bigint; records: PlannedRecord[] } | undefined;
    const call: AppendCall = {
      partition,
      reads: [...chunkKeys.values()].map(chunkRef),
      decide: (ctx: BatchContext) => {
        const head = ctx.head(partition);
        // A chunk row that is already present means an earlier attempt of this message committed
        // (for example after Ambiguous): its records are duplicates now.
        const committedBefore = new Set<string>();
        for (const [item, c] of chunkKeys) if (ctx.read(chunkRef(c)) !== undefined) committedBefore.add(item);
        const records = plan.records.map((r) => (r.outcome === 'accepted' && committedBefore.has(`${r.item}`)
          ? { ...r, outcome: 'duplicate' as const } : r));
        const logSeq = head.seq + 1n + BigInt(plan.newEpochs.length);
        const contexts: LoggedContext[] = plan.contexts.map((c) => {
          const at = st.contexts.get(c.hash);
          return at === undefined ? { contextHash: c.hash, context: c.bytes } : { contextHash: c.hash, firstLoggedIn: at.toString() };
        });
        const payload: BatchEntryPayload = {
          exporterId, owner, certSerial, principalId: edge.principal.principal_id,
          session: { sessionId, region: edge.principal.edge_region, certSerial },
          format: 'ipfix', batchNo: batch.batchNo, contexts, items: plan.items,
          accepted: records.filter((r) => r.outcome === 'accepted').map((r) => r.accepted as BatchEntryPayload['accepted'][number]),
          duplicates: records.filter((r) => r.outcome === 'duplicate' && r.identity).map((r) => ({ identity: r.identity as RecordIdentity, digest64: r.digest })),
          rejected: records.filter((r) => r.outcome === 'rejected').map((r) => (r.identity
            ? { rawRef: r.rawRef, identity: r.identity, reason: r.reason as RejectReason }
            : { rawRef: r.rawRef, reason: r.reason as RejectReason })),
        };
        final = { payload, logSeq, records };
        const handoffSeq = (head.streams['handoff'] ?? 0n) + 1n;
        const event = emitHandoff(payload, { logSeq, ts: ctx.ts, handoffSeq });
        const audit = {
          schema: 'audit.v1' as const,
          principal: { principal_id: edge.principal.principal_id, kind: edge.principal.kind,
            tenant: edge.principal.tenant.kind === 'supplier' ? edge.principal.tenant.supplier : 'share', cert_serial: certSerial },
          decided_at: 'commit' as const, policy_version: 1,
        };
        const entries = [
          ...plan.newEpochs.map((e) => ({
            kind: INGEST_ENTRY.epochOpened, schemaV: 1, audit,
            identity: identityOf('ingest.epoch', exporterId, String(e.domain), String(e.epoch)),
            payload: { observationDomain: e.domain, epoch: e.epoch, initTimeMs: e.initTimeMs },
          })),
          { kind: INGEST_ENTRY.batch, schemaV: 1, identity, audit, payload,
            emits: [{ stream: 'handoff', event }] },
        ];
        const projections: ProjectionWrite[] = [];
        if (plan.firstBatch) projections.push({ table: T.format, op: 'upsert', key: { partition }, row: { format: 'ipfix' } });
        for (const e of plan.newEpochs) {
          projections.push({ table: T.epoch, op: 'upsert', key: { partition, observation_domain: e.domain, epoch: e.epoch }, row: { init_time_ms: e.initTimeMs } });
        }
        for (const [item, c] of chunkKeys) {
          if (committedBefore.has(item)) continue;
          const seqs = records.filter((r) => `${r.item}` === item && r.outcome === 'accepted')
            .map((r) => (r.identity && r.identity.format === 'ipfix' ? BigInt(r.identity.extSeq) : 0n));
          let ivs: Interval[] = [];
          for (const x of seqs) ivs = addPoint(ivs, x);
          projections.push({ ...chunkRef(c), op: 'upsert', row: { intervals: ivs.map(([a, b]) => [a.toString(), b.toString()]) } });
        }
        for (const c of contexts) {
          if (c.context) projections.push({ table: T.context, op: 'upsert', key: { partition, context_hash: c.contextHash }, row: { log_seq: logSeq, context: c.context } });
        }
        return { entries, projections };
      },
    };
    const out = await appendWithPolicy(this.rt, call, undefined,
      { owner: 'ingest', ...(this.opts.alerts ? { alerts: this.opts.alerts } : {}), ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
        ...(this.opts.attempts ? { attempts: this.opts.attempts } : {}) });
    if (!out.ok) {
      // No acknowledgement: an unacknowledged batch is the exporter's to resend (F41-08).
      if (out.why === 'stopped') return [{ notice: { kind: 'waiting', detail: 'temporarily unavailable' } }];
      if (out.why === 'notOwner') return [{ notice: { kind: 'draining' } }];
      return [];
    }
    const f = final as unknown as { payload: BatchEntryPayload; logSeq: bigint; records: PlannedRecord[] };
    // Apply to memory only after Committed (C01 §3.2).
    if (plan.firstBatch) st.format = 'ipfix';
    for (const e of plan.newEpochs) {
      const list = st.epochs.get(e.domain) ?? [];
      list.push({ epoch: e.epoch, initTimeMs: e.initTimeMs });
      st.epochs.set(e.domain, list);
    }
    for (const r of f.records) {
      if (r.outcome !== 'accepted' || !r.identity || r.identity.format !== 'ipfix') continue;
      const key = `${r.domain}:${r.epoch}`;
      st.ranges.set(key, addPoint(st.ranges.get(key) ?? [], BigInt(r.identity.extSeq)));
    }
    for (const c of f.payload.contexts) if (c.context) st.contexts.set(c.contextHash, f.logSeq);
    return [{ ack: this.ackOf(batch, plan, f, out.result.ts) }];
  }

  private ackOf(batch: Batch, plan: Plan, f: { logSeq: bigint; records: PlannedRecord[] }, ts: string): BatchAck {
    const items = plan.items.map((_it, i): { message: MessageAck } => {
      const recs = f.records.filter((r) => r.item === i);
      const rejected: RejectedRecord[] = recs.filter((r) => r.outcome === 'rejected').map((r) => {
        const base = { rejectKey: r.rejectKey as RejectKey, rawRef: { ...r.rawRef, logSeq: f.logSeq.toString() }, reason: r.reason as RejectReason };
        return r.identity ? { ...base, identity: r.identity } : base;
      });
      return { message: {
        accepted: recs.filter((r) => r.outcome === 'accepted').length,
        duplicates: recs.filter((r) => r.outcome === 'duplicate').length,
        acceptedIdentities: recs.filter((r) => r.outcome === 'accepted').map((r) => r.identity as RecordIdentity),
        rejected,
        templateRefusals: [],
      } };
    });
    return { batchNo: batch.batchNo, committedAt: { commitTs: ts, acceptedAtMs: hlcToWallMs(ts as never) }, items };
  }

  /** Decode and validate every item. Returns the plan, or why the batch is outside the I1 subset. */
  private plan(exporterId: string, st: ExporterState, batch: Batch, nowMs: number): Plan | { outside: string } {
    const epochs = new Map<number, EpochRow[]>();
    for (const [d, list] of st.epochs) epochs.set(d, [...list]);
    const ranges = new Map<string, Interval[]>();
    for (const [k, v] of st.ranges) ranges.set(k, v.map(([a, b]) => [a, b] as Interval));
    const newEpochs: Plan['newEpochs'] = [];
    const records: PlannedRecord[] = [];
    const items: Plan['items'] = [];
    const contexts = new Map<string, Uint8Array>();
    for (const [itemNo, it] of batch.items.entries()) {
      if (!('exportMessage' in it)) return { outside: 'corrections and supersessions are not in I1' };
      const { message, context } = it.exportMessage;
      const dec = decodeItem(message, context);
      if (!dec.ok) return { outside: `non-conforming payload (unparseable): ${dec.detail}` };
      const d: DecodedItem = dec.item;
      if (d.templateRefusals.length > 0 || d.noTemplateSets.length > 0) return { outside: 'non-conforming payload (no template)' };
      if (d.otherOptionsFields) return { outside: 'options fields that the logged context must cut (C11 F57-08) are not in I1' };
      const contextHash = createHash('sha256').update(context).digest('hex');
      contexts.set(contextHash, context);
      items.push({ message, contextHash });
      const domain = d.header.observationDomain;
      const q = BigInt(d.header.sequence);
      // The epoch rule (C11 F57-02): the lowest-numbered epoch within epoch_jitter, else a new epoch.
      let epoch: number | null = null;
      if (d.initTimesMs.length === 1) {
        const init = d.initTimesMs[0] as number;
        const list = epochs.get(domain) ?? [];
        const found = [...list].sort((a, b) => a.epoch - b.epoch).find((e) => Math.abs(e.initTimeMs - init) <= RATE_PARAMS.epochJitterMs);
        if (found) epoch = found.epoch;
        else {
          const next = list.reduce((m, e) => Math.max(m, e.epoch), 0) + 1;
          list.push({ epoch: next, initTimeMs: init });
          epochs.set(domain, list);
          newEpochs.push({ domain, epoch: next, initTimeMs: init });
          epoch = next;
        }
      }
      const initTimeMs = epoch === null ? undefined : (epochs.get(domain) ?? []).find((e) => e.epoch === epoch)?.initTimeMs;
      for (const rec of d.records) {
        const digest = digest64(message.subarray(rec.byteOffset, rec.byteOffset + rec.byteLength));
        const rawRef = { exporterId, message: itemNo, record: rec.index };
        const rejectKey: RejectKey = { kind: 'positioned', exporterId, observationDomain: domain, epoch,
          messageSeq: q.toString(), exportTimeS: d.header.exportTimeS, set: rec.set, record: rec.record, byteOffset: rec.byteOffset };
        if (epoch === null) {
          records.push({ item: itemNo, messageSeq: q, domain, epoch: 0, outcome: 'rejected', reason: 'no epoch', rejectKey, rawRef, digest });
          continue;
        }
        const identity: RecordIdentity = { format: 'ipfix', exporterId, observationDomain: domain, epoch, extSeq: (q + BigInt(rec.index)).toString() };
        const fields = recordFields(rec, initTimeMs);
        const base = { item: itemNo, messageSeq: q, domain, epoch, identity, rawRef, digest };
        if (!fields.ok) { records.push({ ...base, outcome: 'rejected', reason: fields.reason, rejectKey }); continue; }
        const f = fields.fields;
        if (f.flowEndMs > nowMs + RATE_PARAMS.futureSkewMaxMs) {
          records.push({ ...base, outcome: 'rejected', reason: 'flow time in the future', rejectKey });
          continue;
        }
        const key = `${domain}:${epoch}`;
        const ext = q + BigInt(rec.index);
        if (contains(ranges.get(key), ext)) { records.push({ ...base, outcome: 'duplicate' }); continue; }
        ranges.set(key, addPoint(ranges.get(key) ?? [], ext));
        const recordFieldsOut = {
          observationDomain: domain, ifIndex: f.ifIndex, direction: f.direction, serviceTag: f.serviceTag,
          flowStartMs: f.flowStartMs, flowEndMs: f.flowEndMs, bytes: f.bytes.toString(),
          ...(f.packets === undefined ? {} : { packets: f.packets.toString() }),
        };
        records.push({ ...base, outcome: 'accepted',
          accepted: { identity, rawRef, fields: recordFieldsOut, exportTimeS: d.header.exportTimeS } });
      }
    }
    return {
      newEpochs, records, items,
      contexts: [...contexts].map(([hash, bytes]) => ({ hash, bytes })),
      firstBatch: st.format === undefined,
    };
  }

  /** The partitions (exporter IDs) that this owner has state for. */
  exporters(): string[] {
    return [...this.state.keys()];
  }

  static partitionOf(exporterId: string): PartitionKey {
    return utf8(exporterId);
  }
}

/** One exporter session at the ingestion edge (C11 Part I). */
export class IngestSession {
  readonly sessionId = randomUUID();
  private hello: Hello | undefined;

  private readonly owner: IngestOwner;
  private readonly edge: EdgeContext;

  constructor(owner: IngestOwner, edge: EdgeContext) {
    this.owner = owner;
    this.edge = edge;
  }

  get exporterId(): string {
    return this.edge.exporterId as string;
  }

  /** `Hello` → `Welcome` and `Credit`, or a protocol error. */
  onHello(h: Hello, nowMs: number): EdgeFrame[] {
    if (h.protocolVersion !== 1) return [{ notice: { kind: 'protocol-error', detail: 'protocol version' } }];
    const recorded = this.owner.formatOf(this.exporterId);
    if (recorded !== undefined && recorded !== h.exportFormat) return [{ notice: { kind: 'protocol-error', detail: 'export format' } }];
    if (h.exportFormat !== 'ipfix') return [{ notice: { kind: 'protocol-error', detail: 'export format: only IPFIX in I1' } }];
    this.hello = h;
    return [
      { welcome: {
        protocolVersion: 1, exporterId: this.exporterId, owner: ownerOf(this.edge.principal),
        certSerial: this.edge.principal.cert_serial ?? '', sessionId: this.sessionId, region: this.edge.principal.edge_region,
        maxBatchBytes: RATE_PARAMS.maxBatchBytes, ingestRetryTimeoutMs: RATE_PARAMS.ingestRetryTimeoutMs, serverTimeMs: nowMs,
      } },
      { credit: { windowBatches: RATE_PARAMS.creditWindowBatches, windowBytes: RATE_PARAMS.creditWindowBytes } },
    ];
  }

  async onBatch(b: Batch): Promise<EdgeFrame[]> {
    if (!this.hello) return [{ notice: { kind: 'protocol-error', detail: 'batch before hello' } }];
    return this.owner.ingestBatch(this.edge, this.sessionId, b);
  }
}
