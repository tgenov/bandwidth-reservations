/**
 * Attribution stage A (RFC-003 §4.1, §4.2; C11 Part II and Part III consumer, Part IV producer).
 *
 * I1 scope: accepted records of `batch` hand-off events; spread over minutes (POL-13); bind
 * only at a covered binding position (C11 F57-01); classes attachment and best-effort (a
 * reservation binding gives class reservation, which rating holds in I1). A part with no
 * binding, or with an uncovered bind time, waits in memory (the pending-binding hold). The
 * quarantine at the end of the hold, probe classes and finance attribution come in I14, I15.
 */
import type {
  BatchContext, Epoch, FeedEvent, Generation, HlcTs, InboundNotification, OwnerHooks, OwnerRuntime, PartitionKey,
  ProjectionWrite, SlotNo,
} from '@share/owner-runtime';
import { decodeJson, hlcToWallMs, slotOfPartition, utf8 } from '@share/owner-runtime';
import {
  FeedCursor, SerialQueue, TOPIC_BINDINGS, TOPIC_HANDOFF, appendWithPolicy, eventDigest, floorMin, identityOf,
  lastMinuteEnd, MINUTE_MS, observationPointEqual, serviceAudit, serviceTagEqual,
  type AcceptedRecord, type AlertSink, type BindingFact, type ExactBytes, type ForwardedBinding, type HandoffEvent,
  type ObservationPoint, type ObservationPointFact, type Part, type PartBatch, type ProvisioningEvent,
} from '@share/rate-common';
import type { CatalogueReplica } from '../catalogue/replica.ts';
import { TOPIC_CATALOGUE } from '../catalogue/declaration.ts';
import { ATTR_A_ENTRY, attrADeclaration } from '../declarations.ts';

/** One part of a record in one minute (POL-13), before it is bound. */
export interface SpreadPart { minuteMs: number; bytes: ExactBytes; bindTimeMs: number }

/**
 * Spread a record over its active minutes (RFC-003 §4.2 step 2). If e = s, all bytes go to
 * floor_min(s). Otherwise the part in minute m has bytes b × t_m / (e − s), with t_m the
 * milliseconds of [s, e) ∩ [m, m + 60 s). The fractions are exact and not reduced.
 */
export function spread(startMs: number, endMs: number, bytes: bigint): SpreadPart[] {
  if (endMs === startMs) return [{ minuteMs: floorMin(startMs), bytes: { num: bytes.toString(), den: '1' }, bindTimeMs: startMs }];
  const out: SpreadPart[] = [];
  const d = BigInt(endMs - startMs);
  for (let m = floorMin(startMs); m < endMs; m += MINUTE_MS) {
    const t = Math.min(endMs, m + MINUTE_MS) - Math.max(startMs, m);
    if (t <= 0) continue;
    out.push({ minuteMs: m, bytes: { num: (bytes * BigInt(t)).toString(), den: d.toString() }, bindTimeMs: Math.max(startMs, m) });
  }
  return out;
}

interface FactRecord { seq: bigint; fact: BindingFact | ObservationPointFact }

interface ExporterState {
  bindingSeq: bigint;
  coverageMs: number | undefined;
  facts: FactRecord[];
  held: HeldPart[];
}

interface HeldPart {
  record: AcceptedRecord;
  acceptedAtMs: number;
  part: SpreadPart;
  why: 'coverage' | 'no binding' | 'ambiguous binding' | 'product unknown';
}

type BindResult =
  | { r: 'bound'; part: Part }
  | { r: 'non-egress' }
  | { r: 'wait'; why: HeldPart['why'] };

export interface StageAOptions {
  catalogue: CatalogueReplica;
  alerts?: AlertSink;
  sleep?: (ms: number) => Promise<void>;
  /**
   * The stage A watermark for one destination partition of the hand-off topic (RFC-003 §4.2).
   * RFC-003 puts it on a heartbeat topic every 1 s. The C01 runtime has no publish for a
   * message that is not a log entry, so I1 gives it to this callback.
   */
  onWatermark?: (destinationPartition: number, watermarkMs: number) => void;
}

export class StageAOwner implements OwnerHooks {
  private readonly rt: OwnerRuntime;
  private readonly opts: StageAOptions;
  private readonly queue = new SerialQueue();
  private readonly handoff = new FeedCursor<HandoffEvent>();
  private readonly bindings = new FeedCursor<ProvisioningEvent>();
  private readonly exporters = new Map<string, ExporterState>();
  private readonly destSeqs = new Map<string, bigint>();
  /** Counts of the `processed` entries, for tests and reports. */
  readonly counts = { bound: 0, nonEgress: 0, held: 0 };

  constructor(rt: OwnerRuntime, opts: StageAOptions) {
    this.rt = rt;
    this.opts = opts;
    rt.subscribe(TOPIC_HANDOFF, { positions: [] }, 'committed', (e) => this.queue.run(() => this.onHandoff(e)));
    rt.subscribe(TOPIC_BINDINGS, { positions: [] }, 'committed', (e) => this.queue.run(() => this.onBinding(e)));
    rt.subscribe(TOPIC_CATALOGUE, { positions: [] }, 'committed', async (e) => { opts.catalogue.applyFeedEvent(e); });
    rt.onResolved(TOPIC_CATALOGUE, (_d, R) => opts.catalogue.onResolved(R));
    // Fire and forget: onResolved does not wait (C01 §3.5); the step only reads state and calls onWatermark.
    rt.onResolved(TOPIC_HANDOFF, (dest, R) => { void this.queue.run(async () => this.onHandoffResolved(dest, R)); });
  }

  idle(): Promise<void> {
    return this.queue.idle();
  }

  // ---------- C01 hooks ----------
  async onAcquire(_s: SlotNo, _e: Epoch): Promise<void> {}
  onRelease(slot: SlotNo): void {
    for (const k of [...this.exporters.keys()]) if (slotOfPartition(utf8(k), attrADeclaration.slotCount) === slot) this.exporters.delete(k);
  }
  onReportable(): void {}
  onMovedOut(p: PartitionKey): void {
    this.exporters.delete(Buffer.from(p).toString('utf8'));
  }
  async onAdopt(_p: PartitionKey, _g: Generation): Promise<void> {}
  async onNotification(_n: InboundNotification): Promise<void> {}

  private ex(exporterId: string): ExporterState {
    let s = this.exporters.get(exporterId);
    if (!s) { s = { bindingSeq: 0n, coverageMs: undefined, facts: [], held: [] }; this.exporters.set(exporterId, s); }
    return s;
  }

  /** The parts that wait in the pending-binding hold (for tests). */
  heldParts(exporterId: string): number {
    return this.exporters.get(exporterId)?.held.length ?? 0;
  }

  // ---------- Part II consumer ----------

  private async onHandoff(e: FeedEvent): Promise<void> {
    const ev = decodeJson(e.value) as HandoffEvent;
    const key = `handoff|${ev.exporterId}`;
    const digest = eventDigest(e);
    const ready = this.handoff.offer(key, BigInt(ev.handoffSeq), ev, digest);
    if (this.handoff.isBlocked(key)) {
      this.opts.alerts?.raise({ owner: 'attr_a', kind: 'FEED_CONTENT_CONFLICT', detail: `${TOPIC_HANDOFF} ${ev.exporterId}` });
      return;
    }
    for (const r of ready) {
      const ok = await this.applyHandoff(r.item, r.digest);
      if (!ok) return;
      this.handoff.commit(key, r.seq, r.digest);
    }
  }

  private async applyHandoff(ev: HandoffEvent, digest: string): Promise<boolean> {
    if (ev.body.kind !== 'batch') {
      // C11 versioning: an unknown body kind stops the partition and alerts. Other kinds come after I1.
      this.opts.alerts?.raise({ owner: 'attr_a', kind: 'HANDOFF_KIND_NOT_IN_I1', detail: ev.body.kind });
      return false;
    }
    const st = this.ex(ev.exporterId);
    const candidates: HeldPart[] = [];
    for (const rec of ev.body.accepted) {
      for (const part of spread(rec.fields.flowStartMs, rec.fields.flowEndMs, BigInt(rec.fields.bytes))) {
        candidates.push({ record: rec, acceptedAtMs: ev.acceptedAtMs, part, why: 'coverage' });
      }
    }
    return this.processEntry(ev.exporterId, st, candidates, [], {
      handoffSeq: ev.handoffSeq, ingestLogSeq: ev.logSeq, applied: { key: `handoff|${ev.exporterId}`, seq: ev.handoffSeq, digest },
    }, identityOf('attr_a.processed', ev.exporterId, ev.handoffSeq));
  }

  private onHandoffResolved(dest: number, R: HlcTs): void {
    // The watermark advances only from resolved markers (C11 Part II), and only when no
    // hand-off event waits for a gap.
    if (this.handoff.hasPending()) return;
    this.opts.onWatermark?.(dest, hlcToWallMs(R));
  }

  // ---------- Part III consumer ----------

  private async onBinding(e: FeedEvent): Promise<void> {
    const ev = decodeJson(e.value) as ProvisioningEvent;
    const key = `bindings|${ev.exporterId}`;
    const digest = eventDigest(e);
    const ready = this.bindings.offer(key, BigInt(ev.bindingSeq), ev, digest);
    for (const r of ready) {
      const ok = await this.applyBinding(r.item, r.digest);
      if (!ok) return;
      this.bindings.commit(key, r.seq, r.digest);
    }
  }

  private async applyBinding(ev: ProvisioningEvent, digest: string): Promise<boolean> {
    const st = this.ex(ev.exporterId);
    const f = ev.fact;
    const seq = BigInt(ev.bindingSeq);
    const applied = { key: `bindings|${ev.exporterId}`, seq: ev.bindingSeq, digest };
    if (f.kind === 'heartbeat') {
      // A heartbeat is not a fact and is not logged; it advances the position (C11 Part III).
      st.bindingSeq = seq;
      st.coverageMs = Math.max(st.coverageMs ?? f.coversThroughMs, f.coversThroughMs);
      return this.release(ev.exporterId, st, applied);
    }
    if (f.kind === 'correction') {
      this.opts.alerts?.raise({ owner: 'attr_a', kind: 'CORRECTION_FACT_NOT_IN_I1', detail: f.supersedesFactId });
      return false;
    }
    // T1: every op.exporterId in a fact equals the key.
    const op = f.kind === 'binding' ? f.key.op : f.op;
    if (op.exporterId !== ev.exporterId) {
      this.opts.alerts?.raise({ owner: 'attr_a', kind: 'T1_VIOLATION', detail: ev.exporterId });
      return false;
    }
    const forwards: Array<{ account: string; binding: ForwardedBinding }> = [];
    if (f.kind === 'binding') {
      forwards.push({ account: f.accountId, binding: {
        exporterId: ev.exporterId, bindingSeq: ev.bindingSeq, bindingId: f.bindingId, retracted: false,
        productId: f.productId, routeId: f.routeId, reservationId: f.reservationId, direction: f.key.op.direction,
        egress: f.egress, ...(f.egressGroup === undefined ? {} : { egressGroup: f.egressGroup }),
        op: f.key.op, validFromMs: f.validFromMs, validToMs: f.validToMs,
      } });
    }
    const ok = await this.processEntry(ev.exporterId, st, [], forwards, { bindingSeq: ev.bindingSeq, fact: f, applied },
      identityOf('attr_a.fact', ev.exporterId, ev.bindingSeq), ATTR_A_ENTRY.bindingFact);
    if (!ok) return false;
    st.facts.push({ seq, fact: f });
    st.bindingSeq = seq;
    return this.release(ev.exporterId, st, applied);
  }

  /** Try the held parts again after the binding position moved. */
  private async release(exporterId: string, st: ExporterState, applied: { key: string; seq: string; digest: string }): Promise<boolean> {
    if (st.held.length === 0) return true;
    const held = st.held;
    return this.processEntry(exporterId, st, held, [], { released: true, bindingSeq: st.bindingSeq.toString(), applied },
      identityOf('attr_a.release', exporterId, st.bindingSeq.toString(), String(st.coverageMs)), ATTR_A_ENTRY.processed, true);
  }

  // ---------- bind and classify ----------

  private bind(exporterId: string, st: ExporterState, h: HeldPart): BindResult {
    const f = h.record.fields;
    const tb = h.part.bindTimeMs;
    // Bind only at a covered position (C11 F57-01).
    if (st.coverageMs === undefined || st.coverageMs < tb) return { r: 'wait', why: 'coverage' };
    const op: ObservationPoint = { exporterId, observationDomain: f.observationDomain, ifIndex: f.ifIndex, direction: f.direction };
    const latest = new Map<string, BindingFact>();
    for (const x of st.facts) if (x.fact.kind === 'binding') latest.set(x.fact.bindingId, x.fact);
    const matches = [...latest.values()].filter((b) => observationPointEqual(b.key.op, op) && serviceTagEqual(b.key.serviceTag, f.serviceTag)
      && b.validFromMs <= tb && (b.validToMs === null || tb < b.validToMs));
    if (matches.length === 0) return { r: 'wait', why: 'no binding' };
    if (matches.length > 1) return { r: 'wait', why: 'ambiguous binding' };
    const b = matches[0] as BindingFact;
    if (!b.egress) return { r: 'non-egress' };
    let cls: Part['class'];
    if (b.reservationId !== null) cls = 'reservation';
    else {
      const kind = this.opts.catalogue.productKind(b.productId);
      if (kind === undefined) return { r: 'wait', why: 'product unknown' };
      cls = kind === 'best_effort' ? 'best-effort' : 'attachment';
    }
    // The observation point → link mapping in force at the bind time (none gives linkId null, D41-6).
    let linkId: string | null = null;
    let opSeq = -1n;
    for (const x of st.facts) {
      if (x.fact.kind !== 'observation-point') continue;
      const o = x.fact;
      if (observationPointEqual(o.op, op) && o.validFromMs <= tb && (o.validToMs === null || tb < o.validToMs) && x.seq > opSeq) {
        opSeq = x.seq; linkId = o.linkId;
      }
    }
    if (linkId === null) this.opts.alerts?.raise({ owner: 'attr_a', kind: 'NO_LINK_MAPPING', detail: JSON.stringify(op) });
    return { r: 'bound', part: {
      recordIdentity: { kind: 'record', id: h.record.identity },
      bindingPosition: st.bindingSeq.toString(),
      acceptedAtMs: h.acceptedAtMs,
      lastMinuteEndMs: lastMinuteEnd(f.flowStartMs, f.flowEndMs),
      minuteMs: h.part.minuteMs,
      bytes: h.part.bytes,
      class: cls,
      accountId: b.accountId, productId: b.productId, routeId: b.routeId, reservationId: b.reservationId,
      op, linkId,
    } };
  }

  /**
   * One `processed` (or `binding-fact`) entry: bind the candidate parts, keep the others in the
   * hold, and write one PartBatch for each destination account as outbox rows.
   */
  private async processEntry(exporterId: string, st: ExporterState, candidates: HeldPart[],
    forwards: Array<{ account: string; binding: ForwardedBinding }>, info: Record<string, unknown>, identity: Uint8Array,
    entryKind: number = ATTR_A_ENTRY.processed, isRelease = false): Promise<boolean> {
    const byAccount = new Map<string, { parts: Part[]; bindingFacts: ForwardedBinding[] }>();
    const stillHeld: HeldPart[] = [];
    let nonEgress = 0;
    for (const h of candidates) {
      const r = this.bind(exporterId, st, h);
      if (r.r === 'bound') {
        const a = byAccount.get(r.part.accountId) ?? { parts: [], bindingFacts: [] };
        a.parts.push(r.part);
        byAccount.set(r.part.accountId, a);
      } else if (r.r === 'non-egress') nonEgress += 1;
      else stillHeld.push({ ...h, why: r.why });
    }
    for (const f of forwards) {
      const a = byAccount.get(f.account) ?? { parts: [], bindingFacts: [] };
      a.bindingFacts.push(f.binding);
      byAccount.set(f.account, a);
    }
    if (isRelease && byAccount.size === 0 && nonEgress === 0) {
      st.held = stillHeld;
      return true; // Nothing changed: no entry.
    }
    const partition = utf8(exporterId);
    const slot = this.rt.route('attr_a', partition).slot;
    const accounts = [...byAccount.keys()].sort();
    const out = await appendWithPolicy(this.rt, {
      partition,
      decide: (ctx: BatchContext) => {
        const head = ctx.head(partition);
        const logSeq = head.seq + 1n;
        const emits = accounts.map((acct) => {
          const a = byAccount.get(acct) as { parts: Part[]; bindingFacts: ForwardedBinding[] };
          const destSeq = (this.destSeqs.get(`${exporterId}|${acct}`) ?? 0n) + 1n;
          const batch: PartBatch = {
            schemaVersion: 1,
            feedId: { stageAPartition: exporterId, ownerEpoch: Number(this.rt.epoch(slot)), logSeq: logSeq.toString(), accountId: acct },
            destSeq: destSeq.toString(), commitTs: ctx.ts, parts: a.parts, bindingFacts: a.bindingFacts,
          };
          return { stream: 'parts', event: batch };
        });
        const projections: ProjectionWrite[] = accounts.map((acct) => ({
          table: 'attr_a_dest_seq', op: 'upsert' as const, key: { partition, account: acct },
          row: { dest_seq: (this.destSeqs.get(`${exporterId}|${acct}`) ?? 0n) + 1n },
        }));
        projections.push({ table: 'attr_a_position', op: 'upsert', key: { partition },
          row: { handoff_seq: this.handoff.position(`handoff|${exporterId}`), binding_seq: st.bindingSeq } });
        return {
          entries: [{ kind: entryKind, schemaV: 1, identity, audit: serviceAudit('attr_a'),
            payload: { ...info, bindingPosition: st.bindingSeq.toString(), boundByAccount: accounts.map((a) => [a, byAccount.get(a)?.parts.length ?? 0]),
              nonEgress, held: stillHeld.map((h) => ({ identity: h.record.identity, minuteMs: h.part.minuteMs, why: h.why })) },
            emits }],
          projections,
        };
      },
    }, undefined, { owner: 'attr_a', ...(this.opts.alerts ? { alerts: this.opts.alerts } : {}), ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}) });
    if (!out.ok) return false;
    for (const acct of accounts) this.destSeqs.set(`${exporterId}|${acct}`, (this.destSeqs.get(`${exporterId}|${acct}`) ?? 0n) + 1n);
    st.held = isRelease ? stillHeld : [...st.held, ...stillHeld];
    this.counts.bound += accounts.reduce((n, a) => n + (byAccount.get(a)?.parts.length ?? 0), 0);
    this.counts.nonEgress += nonEgress;
    this.counts.held = [...this.exporters.values()].reduce((n, s) => n + s.held.length, 0);
    return true;
  }
}
