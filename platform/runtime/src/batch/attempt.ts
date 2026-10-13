import { randomBytes } from 'node:crypto';
import type {
  AppendCall, AppendOptions, AppendResult, BatchContext, DecideResult, Epoch, HeadRow, HlcTs, NotificationOut,
  OwnerDeclaration, ProjectionWrite, RowRef, SlotNo, TimingSnapshot,
} from '../api.ts';
import { bytesEqual, encodeJson, hex } from '../bytes.ts';
import { chainGenesis, chainNext } from '../chain.ts';
import { retentionCode, tableNames } from '../declaration.ts';
import { StaleEpochSignal } from '../errors.ts';
import { compareHlc } from '../hlc.ts';
import { homeKey } from '../home.ts';
import { checkProjectionWrite, rowId } from '../rowref.ts';
import type { Sealer } from '../sealer.ts';
import type { BatchTxn, BatchWrites, LogRowWrite, OutboxRowWrite, StoredHead } from '../store/types.ts';
import { PARAMS } from '../params.ts';

/** Per-slot state the holder keeps between batches. */
export interface SlotHolding {
  slot: SlotNo;
  epoch: Epoch;
  sessionId: string;
  /** stops_version last seen by the fence read; null forces a stops read (after an acquisition). */
  stopsVersion: bigint | null;
  /** hex(partition) → open stop detection_ref, or null when known not stopped at stopsVersion. */
  stops: Map<string, Uint8Array | null>;
  /** hex(partition) → the chain this process last committed (C08 §J head comparison). */
  chains: Map<string, Uint8Array>;
  /** Partitions held locally after a chain mismatch (C08 §J, RFC-006 §3.7). */
  integrityHolds: Set<string>;
}

export interface PendingCall {
  call: AppendCall;
  opts: AppendOptions;
}

export interface OutboxMessage {
  topic: string; key: Uint8Array; headers: Record<string, string | Buffer>; value: Uint8Array;
}

export type CallVerdict =
  | { kind: 'result'; result: AppendResult; committed: boolean }
  | { kind: 'error'; error: Error };

export interface AttemptPlan {
  ts: HlcTs;
  timing: TimingSnapshot;
  batchId: Uint8Array;
  verdicts: CallVerdict[];
  writes: BatchWrites;
  publish: OutboxMessage[];
  anyCommit: boolean;
  /** Partitions whose calls committed (for Ambiguous resolution). */
  partitions: Uint8Array[];
  senderFences: Array<NonNullable<import('../api.ts').EntryInput['senderFence']>>;
  /** Entries that make a report marker due (C01 §3.4): reportWanted, or an event on a reportGated stream.
   *  `pending` is the entry's pendingAnswered (C04 v2.1). All carry the batch's ts. */
  reportDue: Array<{ pending?: Uint8Array }>;
}

export interface AttemptEnv {
  decl: OwnerDeclaration;
  sealer: Sealer;
  holding: SlotHolding;
  /** Called once per decide run (tests count restarts). */
  onDecide?: () => void;
}

const DELETED = Symbol('deleted');

function wireHead(h: StoredHead | undefined, partition: Uint8Array): HeadRow {
  if (!h) {
    return { exists: false, partition, slot: 0, generation: 0, adopted: true, seq: 0n, ts: null, epoch: 0n, streams: {}, chain: new Uint8Array(32) };
  }
  return { exists: true, partition: h.partition, slot: h.slot, generation: h.generation, adopted: h.adopted, seq: h.seq,
    ts: h.ts, epoch: h.epoch, streams: { ...h.streams }, chain: h.chain };
}

function conditionRows(call: AppendCall): RowRef[] {
  const out: RowRef[] = [];
  for (const c of call.conditions ?? []) if (c.kind === 'rowAbsent' || c.kind === 'rowPresent') out.push(c.row);
  return out;
}

function notificationId(n: NotificationOut): string {
  return `${Buffer.from(n.id.subject).toString('base64')}:${n.id.attempt}:${n.id.kind}`;
}

/** 31-bit n for a notification row (C01 §2.3 leaves n's rule open; see STATUS-I1a.md). */
function notificationN(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return (h >>> 1) & 0x7fffffff;
}

/** Keys of the sealed payload envelope of an entry with a sender fence (opened by readLog). */
export const PAYLOAD_KEY = '$payload';
export const FENCE_KEY = '$senderFence';

/** Message key from a declared event field (C01 v1.1 erratum: a stream key may be a declared field). */
function fieldKey(event: unknown, field: string): Uint8Array {
  const v = event !== null && typeof event === 'object' ? (event as Record<string, unknown>)[field] : undefined;
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return new Uint8Array(Buffer.from(v, 'utf8'));
  if (v === undefined) throw new Error(`event has no key field ${field}`);
  return encodeJson(v);
}

function slotKey(slot: SlotNo): Uint8Array {
  const b = Buffer.alloc(4); b.writeInt32BE(slot, 0);
  return new Uint8Array(b);
}

/**
 * One attempt of the slot batch (RFC-006 §4.3; C01 §3.2): every read precedes every write; `decide`
 * runs at ctx.ts; a failed call writes nothing and never aborts another. Re-run in full on every restart.
 */
export async function runAttempt(tx: BatchTxn, env: AttemptEnv, calls: PendingCall[]): Promise<AttemptPlan> {
  const { decl, holding } = env;
  const kind = decl.kind;
  const t = tableNames(kind);
  const firstStatement = calls.length === 1 ? calls[0]?.opts.firstStatement : undefined;
  let ts: HlcTs | undefined;
  if (firstStatement && firstStatement.length > 0) {
    for (const w of firstStatement) checkProjectionWrite(decl, w);
    ts = await tx.firstStatement(firstStatement);
  }

  // The fence (C01 §3.2): epoch and session must be mine; a new stops_version re-reads the stops.
  const fence = await tx.readFence(kind, holding.slot);
  if (!fence || fence.epoch !== holding.epoch || fence.sessionId !== holding.sessionId) {
    throw new StaleEpochSignal(holding.slot);
  }
  const timing = await tx.readTiming(holding.slot % PARAMS.timingShards);
  const partitions = uniquePartitions(calls.map((c) => c.call.partition));
  const stops = new Map(holding.stopsVersion === fence.stopsVersion ? holding.stops : []);
  const unknownStops = partitions.filter((p) => !stops.has(hex(p)));
  if (unknownStops.length > 0) {
    const open = await tx.readStops(kind, unknownStops);
    for (const p of unknownStops) stops.set(hex(p), open.get(hex(p)) ?? null);
  }
  holding.stopsVersion = fence.stopsVersion;
  holding.stops = stops;

  const heads = await tx.readHeads(kind, partitions);
  const refs = calls.flatMap((c) => [...conditionRows(c.call), ...(c.call.reads ?? [])]);
  const rows = refs.length > 0 ? await tx.readRows(refs) : new Map<string, unknown>();
  const displacement = new Map<string, boolean | 'lockTimeout'>();
  const displacementRows = new Map<string, { attempt: number; row: unknown }>();
  for (const c of calls) {
    for (const cond of c.call.conditions ?? []) {
      if (cond.kind !== 'displacementRead') continue;
      const r = await tx.readDisplacement(cond);
      if (r === 'lockTimeout') displacement.set(cond.label, 'lockTimeout');
      else {
        // C02 / P1-S78: a marker row for (link, request) with ANY attempt fails the condition (no E5 commit).
        const marker = markerOf(r.row);
        displacement.set(cond.label, marker === undefined);
        if (marker) displacementRows.set(cond.label, marker);
      }
    }
  }
  if (ts === undefined) ts = await tx.readTs();
  // C08 §C: a slot-wide commit sequence, read in the batch and advanced by each committed entry.
  let slotPos: bigint | undefined;
  if (decl.slotPositions) {
    if (!tx.readSlotPosition) throw new Error('slotPositions needs a store with readSlotPosition');
    slotPos = await tx.readSlotPosition(kind, holding.slot);
  }
  const startPos = slotPos;
  const streamIndex: NonNullable<BatchWrites['streamIndex']> = [];

  const batchId = new Uint8Array(randomBytes(16));
  const overlay = new Map<string, unknown>();
  const working = new Map<string, StoredHead>();
  const verdicts: CallVerdict[] = [];
  const log: LogRowWrite[] = [];
  const outbox: OutboxRowWrite[] = [];
  const projections: ProjectionWrite[] = [];  // firstStatement writes already ran with the ts read
  const publish: OutboxMessage[] = [];
  const senderFences: AttemptPlan['senderFences'] = [];
  const committedPartitions = new Map<string, Uint8Array>();
  const reportDue: AttemptPlan['reportDue'] = [];

  const readRow = (ref: RowRef): unknown | undefined => {
    const id = rowId(ref);
    if (overlay.has(id)) {
      const v = overlay.get(id);
      return v === DELETED ? undefined : v;
    }
    return rows.get(id);
  };

  for (const pc of calls) {
    const { call } = pc;
    const key = hex(call.partition);
    const stop = stops.get(key);
    if (stop) { verdicts.push({ kind: 'result', result: { r: 'Stopped', detectionRef: stop }, committed: false }); continue; }
    if (holding.integrityHolds.has(key)) {
      // TODO(S-PLAT-I1 rest, C08 §J integrity_report): send integrity_report to audit; Stopped carries audit's detection_ref.
      verdicts.push({ kind: 'result', result: { r: 'Stopped', detectionRef: new Uint8Array() }, committed: false });
      continue;
    }
    const dbHead = heads.get(key);
    const head = working.get(key) ?? dbHead;
    if (head && head.slot !== holding.slot) {
      verdicts.push({ kind: 'result', result: head.adopted ? { r: 'Moved', slot: head.slot, generation: head.generation } : { r: 'Moving' }, committed: false });
      continue;
    }
    if (head && !head.adopted) {
      // TODO(I3, C01 §3.3): the `adopt` call itself is exempt.
      verdicts.push({ kind: 'result', result: { r: 'Moving' }, committed: false });
      continue;
    }
    // C08 §J: compare the head's chain with the holder's memory; a mismatch holds the partition locally.
    const mem = holding.chains.get(key);
    if (!working.has(key) && dbHead && mem && !bytesEqual(mem, dbHead.chain)) {
      holding.integrityHolds.add(key);
      verdicts.push({ kind: 'result', result: { r: 'Stopped', detectionRef: new Uint8Array() }, committed: false });
      continue;
    }

    const conditionResults: Record<string, boolean | 'lockTimeout'> = {};
    let failed: string | undefined;
    let failedLabel: string | undefined;
    for (const c of call.conditions ?? []) {
      let ok: boolean | 'lockTimeout';
      if (c.kind === 'rowAbsent') ok = readRow(c.row) === undefined;
      else if (c.kind === 'rowPresent') ok = readRow(c.row) !== undefined;
      else if (c.kind === 'tsBefore') ok = compareHlc(ts, c.bound(timing)) < 0;
      else ok = displacement.get(c.label) ?? true;
      conditionResults[c.label] = ok;
      if (ok !== true) { failed = ok === 'lockTimeout' ? 'lockTimeout' : c.label; failedLabel = c.label; break; }
    }
    if (failed !== undefined) {
      const marker = failedLabel !== undefined && failed !== 'lockTimeout' ? displacementRows.get(failedLabel) : undefined;
      verdicts.push({ kind: 'result', result: { r: 'ConditionFailed', which: failed, ...(marker ? { displacement: marker } : {}) }, committed: false });
      continue;
    }

    let decided: DecideResult | null;
    try {
      if (call.decide) {
        const allowed = new Set([...conditionRows(call), ...(call.reads ?? [])].map(rowId));
        const ctx: BatchContext = {
          ts, timing, conditionResults, ...(slotPos !== undefined ? { slotPosition: slotPos + 1n } : {}),
          head: (p) => wireHead(working.get(hex(p)) ?? heads.get(hex(p)), p),
          read: (ref) => {
            // C01 R47-11: ctx.read serves only declared reads and condition rows.
            if (!allowed.has(rowId(ref))) throw new Error(`ctx.read of an undeclared row ${rowId(ref)}`);
            return readRow(ref);
          },
        };
        env.onDecide?.();
        decided = call.decide(ctx);
      } else {
        decided = { entries: call.entries ?? [], projections: call.projections ?? [], notifications: call.notifications ?? [] };
      }
      if (decided === null) { verdicts.push({ kind: 'result', result: { r: 'ConditionFailed', which: 'decide' }, committed: false }); continue; }
      for (const w of decided.projections ?? []) checkProjectionWrite(decl, w);
      for (const e of decided.entries) retentionCode(decl, e.kind);
      for (const e of decided.entries) for (const em of e.emits ?? []) {
        if (!decl.streams.some((s) => s.name === em.stream)) throw new Error(`stream ${em.stream} is not declared by ${kind}`);
      }
    } catch (error) {
      verdicts.push({ kind: 'error', error: error instanceof Error ? error : new Error(String(error)) });
      continue;
    }

    // Commit this call into the batch.
    const base: StoredHead = head ?? {
      homeKey: homeKey(call.partition), partition: call.partition, slot: holding.slot, generation: 0, adopted: true,
      seq: 0n, ts, epoch: holding.epoch, streams: {}, chain: chainGenesis(kind, call.partition), batchId,
    };
    const next: StoredHead = { ...base, streams: { ...base.streams }, epoch: holding.epoch, batchId };
    const seqFrom = next.seq + 1n;
    const posFrom = slotPos !== undefined ? slotPos + 1n : undefined;
    const streamSeqs: Record<string, [bigint, bigint]> = {};
    for (const entry of decided.entries) {
      next.seq += 1n;
      const emits: Array<[string, string]> = [];
      for (const em of entry.emits ?? []) {
        const streamSeq = (next.streams[em.stream] ?? 0n) + 1n;
        next.streams[em.stream] = streamSeq;
        emits.push([em.stream, streamSeq.toString()]);
        const r = streamSeqs[em.stream];
        streamSeqs[em.stream] = r ? [r[0], streamSeq] : [streamSeq, streamSeq];
        const stream = decl.streams.find((s) => s.name === em.stream);
        if (!stream) throw new Error(`stream ${em.stream} vanished`);
        const keyId = env.sealer.keyId(stream.topic);
        const pk = { slot: holding.slot, partition: call.partition, stream: em.stream, streamSeq, n: 0 };
        const payload = env.sealer.seal(encodeJson(em.event), {
          ownerKind: kind, table: t.outbox, primaryKey: pk, seqOrVersion: streamSeq, epoch: holding.epoch, rowKind: `event:${em.stream}`,
        });
        const msgKey = stream.key === 'slot' ? slotKey(holding.slot) : typeof stream.key === 'object' ? fieldKey(em.event, stream.key.field) : call.partition;
        if (decl.selfOutboxed) streamIndex.push({ partition: call.partition, stream: em.stream, streamSeq, seq: next.seq });
        const headers: Record<string, string> = {
          partition: hex(call.partition), stream: em.stream, stream_seq: streamSeq.toString(),
          generation: String(next.generation), epoch: holding.epoch.toString(), ts,
          kind: String(entry.kind), schema_v: String(entry.schemaV), key_id: hex(keyId),
          ...(stream.key === 'slot' ? { slot: String(holding.slot) } : {}),
        };
        // C01 §3.4 rule 7: the outcome id stays in the database copy of the headers only (never on Kafka).
        const dbHeaders = stream.reportGated ? { ...headers, outcome_id: hex(entry.pendingAnswered ?? entry.identity) } : headers;
        outbox.push({ slot: holding.slot, partition: call.partition, stream: em.stream, streamSeq, n: 0, topic: stream.topic,
          msgKey, headers: encodeJson(dbHeaders), payload, generation: next.generation, epoch: holding.epoch, ifAbsent: false });
        publish.push({ topic: stream.topic, key: msgKey, headers: kafkaHeaders(headers, call.partition), value: payload });
      }
      const keyId = env.sealer.keyId(t.log);
      const pk = { slot: holding.slot, partition: call.partition, seq: next.seq };
      const sealCtx = { ownerKind: kind, table: t.log, primaryKey: pk, seqOrVersion: next.seq, epoch: holding.epoch };
      // R47-24: a sender fence is kept in the sealed payload envelope, so a takeover can rebuild admitCommand.
      const plain = entry.senderFence ? { [PAYLOAD_KEY]: entry.payload, [FENCE_KEY]: entry.senderFence } : entry.payload;
      const payload = env.sealer.seal(encodeJson(plain), { ...sealCtx, rowKind: `entry:${entry.kind}` });
      const audit = env.sealer.seal(encodeJson(entry.audit), { ...sealCtx, rowKind: 'audit' });
      const emitsBytes = encodeJson(emits);
      const retention = retentionCode(decl, entry.kind);
      // C08 §J: chained after sealing, over the stored ciphertexts; recomputed on every attempt.
      next.chain = chainNext(next.chain, {
        kindName: kind, partition: call.partition, seq: next.seq, slot: holding.slot, generation: next.generation,
        epoch: holding.epoch, entryKind: entry.kind, schemaV: entry.schemaV, identity: entry.identity, emits: emitsBytes,
        retention, keyId, audit, payload,
      });
      log.push({ slot: holding.slot, partition: call.partition, seq: next.seq, generation: next.generation, epoch: holding.epoch,
        kind: entry.kind, schemaV: entry.schemaV, identity: entry.identity, emits: emitsBytes, audit, retention, keyId,
        payload, chain: next.chain });
      next.ts = ts;
      if (entry.senderFence) senderFences.push(entry.senderFence);
      // C01 §3.4: a marker is due once the report position passes this entry; pendingAnswered goes in its list.
      const wanted = decl.entryKinds.find((k) => k.kind === entry.kind)?.reportWanted === true;
      const gated = (entry.emits ?? []).some((em) => decl.streams.find((s) => s.name === em.stream)?.reportGated === true);
      if (wanted || gated) reportDue.push(entry.pendingAnswered ? { pending: entry.pendingAnswered } : {});
    }
    for (const n of decided.notifications ?? []) {
      const id = notificationId(n);
      const keyId = env.sealer.keyId(`${kind}.notifications.v1`);
      const nn = notificationN(id);
      const payload = env.sealer.seal(encodeJson({ to: n.to, id: n.id, body: n.body }), {
        ownerKind: kind, table: t.outbox, primaryKey: { slot: holding.slot, partition: call.partition, stream: '', streamSeq: 0n, n: nn },
        seqOrVersion: 0n, epoch: holding.epoch, rowKind: 'notification',
      });
      const headers: Record<string, string> = {
        partition: hex(call.partition), notification_id: id, generation: String(next.generation), epoch: holding.epoch.toString(),
        ts, kind: n.id.kind, schema_v: '1', key_id: hex(keyId),
      };
      // Topic for notifications is not named by C01 §2.5; `<kind>.notifications.v1`, keyed by the receiving partition (§4).
      const topic = `${kind}.notifications.v1`;
      outbox.push({ slot: holding.slot, partition: call.partition, stream: '', streamSeq: 0n, n: nn, topic, msgKey: n.to.partition,
        headers: encodeJson(headers), payload, generation: next.generation, epoch: holding.epoch, ifAbsent: true });
      publish.push({ topic, key: n.to.partition, headers: kafkaHeaders(headers, call.partition), value: payload });
    }
    for (const w of decided.projections ?? []) {
      overlay.set(rowId({ table: w.table, key: w.key }), w.op === 'delete' ? DELETED : w.row);
      projections.push(w);
    }
    if (!head) next.ts = ts;
    // R47-14: every committing call upserts its head with this batch's batch_id.
    working.set(key, next);
    committedPartitions.set(key, call.partition);
    let slotPositions: [bigint, bigint] | undefined;
    if (slotPos !== undefined && posFrom !== undefined) {
      slotPos += BigInt(decided.entries.length);
      if (decided.entries.length > 0) slotPositions = [posFrom, slotPos];
    }
    verdicts.push({ kind: 'result', committed: true,
      result: { r: 'Committed', seqFrom, seqTo: next.seq, ts, streamSeqs, ...(slotPositions ? { slotPositions } : {}) } });
  }

  const anyCommit = verdicts.some((v) => v.kind === 'result' && v.committed);
  return {
    ts, timing, batchId, verdicts, anyCommit, publish, senderFences, reportDue,
    partitions: [...committedPartitions.values()],
    writes: { ts, log, outbox, heads: [...working.values()], projections,
      ...(streamIndex.length > 0 ? { streamIndex } : {}),
      ...(slotPos !== undefined && slotPos !== startPos ? { slotPosition: { slot: holding.slot, position: slotPos } } : {}) },
  };
}

function kafkaHeaders(h: Record<string, string>, partition: Uint8Array): Record<string, string | Buffer> {
  return { ...h, partition: Buffer.from(partition) };
}

/** The displacement marker of a read row (undefined when no row): its attempt and the row as read. */
function markerOf(row: unknown): { attempt: number; row: unknown } | undefined {
  if (row === undefined || row === null) return undefined;
  const a = typeof row === 'object' ? (row as Record<string, unknown>)['attempt'] : undefined;
  return { attempt: Number(a ?? 0), row };
}

function uniquePartitions(ps: Uint8Array[]): Uint8Array[] {
  const m = new Map<string, Uint8Array>();
  for (const p of ps) m.set(hex(p), p);
  return [...m.values()];
}
