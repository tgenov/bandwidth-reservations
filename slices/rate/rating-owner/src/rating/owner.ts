/**
 * Rating (RFC-003 §5; C06 §3, §5 producer; C06 §4, §7 consumer), I1 … I4 scope.
 *
 * - Usage lines of attachment-class and best-effort parts (POL-17, RFC-003 §5.3), one line for
 *   each (account, product, route, minute), exact by the ELA, charged ⌊price × X / 10^15⌋ (POL-11).
 * - Usage closure by the time bound and the stage A watermark, by the 45 s bound when a stage A
 *   partition stalls (RFC-003 §5.6). The closing entry fixes the original: a part applied after it is
 *   in an amendment (P3-S17).
 * - Amendments by total (RFC-003 §5.7): `late_traffic` amendments of `C − E`, at most one for each line in
 *   `amendment_interval`, sequence `k + 1` only after `k` is posted; a line closed with no posting gets its
 *   late original. Closed lines stay in memory for `amendment_hot_window`; an older line is read back.
 * - The unposted-usage figure U(X), at most one for each account in 2 s (C06 §3).
 * - One gated usage batch in flight; publish before emit (C06 §4); posted only on `posted` (C06 §7).
 *
 * Each step is one entry. The owner computes the next state in `decide` from a copy, and keeps it
 * only after `Committed` (C01 §3.2).
 */
import type {
  BatchContext, EntryInput, Epoch, FeedEvent, Generation, InboundNotification, OwnerHooks, OwnerRuntime,
  PartitionKey, ProjectionWrite, RowRef, SlotNo,
} from '@share/owner-runtime';
import { decodeJson, hlcFromWallMs, hlcToWallMs, utf8 } from '@share/owner-runtime';
import {
  MOVEMENT_LIMIT, RATE_PARAMS, SerialQueue, addFraction, appendWithPolicy, elaFromJson, elaToJson, emptyEla, identityOf, minuteIso,
  serviceAudit, sourceRefDigest, usageCharge,
  type AlertSink, type BatchId, type ExactBytes, type ChargeLine, type ChargeLineBatch, type Ela, type LedgerPosition, type Part, type PostingAck,
  type RatingPosition, type SourceRef, type UnpostedUsageFigure, type UsageApplied,
} from '@share/rate-common';
import type { CatalogueReplica } from '../catalogue/replica.ts';
import { TOPIC_CATALOGUE } from '../catalogue/declaration.ts';
import type { RatingSink, StageBInput } from '../attribution/stage-b.ts';
import { RATING_ENTRY, TOPIC_POSTING_ACKS, TOPIC_USAGE_APPLIED } from '../declarations.ts';

export interface UsageLine {
  product: string;
  route: string;
  minuteMs: number;
  ela: Ela;
  closed: boolean;
  /** E: the emitted total, or null before the original is emitted. */
  emitted: string | null;
  /** P_X: the total that settlement acknowledged as posted. */
  posted: string;
  postedPosition?: LedgerPosition;
  weightsVersion?: string;
  priceVersion?: string;
  priceCatalogue?: string;
  batchId?: BatchId;
  /** The charge that the usage-closed entry recorded: the amount of the original. */
  original?: string;
  closedAtMs?: number;
  /** The sequence of the last line emitted for the line key; −1 before the first. */
  seq: number;
  /** The line as the usage batch in flight holds it, until its acknowledgement. */
  pending?: PendingLine;
  /** The late records applied to the closed line since its last amendment was formed. */
  late?: { sinceMs: number; records: string[] };
}

/** A line in a usage batch. Sequence 0 is the original or the late original; a sequence above 0 is a late-traffic amendment. */
export interface PendingLine {
  seq: number;
  amount: string;
  newTotal: string;
  priorTotal: string;
  /** The late records that caused it (JSON of each C11 derived identity); absent for an original. */
  records?: string[];
}

interface InFlight {
  batchId: BatchId;
  lineKeys: string[];
  /** The rating position of the first figure that names the batch and counts its lines. */
  namedAt?: { generation: number; seq: string };
  emitted: boolean;
  answered: Record<string, 'posted' | 'excluded'>;
}

export interface AccountState {
  lines: Record<string, UsageLine>;
  attrBSeq: string;
  dueMinutes: number[];
  attached: Record<string, true>;
  inFlight?: InFlight;
  appliedThrough?: { generation: number; seq: string };
  lastFigure?: { atMs: number; key: string };
  figureDue: boolean;
  ledgerX: LedgerPosition;
  usageBatchCount: number;
  /** The last minute that a usage-closed entry closed (usage minutes close in increasing order, RFC-003 §5.6). */
  closedThroughMs?: number;
}

export interface RatingOptions {
  catalogue: CatalogueReplica;
  /** The home ledger partition of the buyer (C06 `LedgerPosition.ledgerPartition`). */
  homeLedgerPartition: (account: string) => string;
  /** The destination partitions of the hand-off topic; the watermark is the minimum over them. */
  handoffPartitions?: number;
  alerts?: AlertSink;
  sleep?: (ms: number) => Promise<void>;
}

const lineKey = (product: string, route: string, minuteMs: number): string => `${product}|${route}|${minuteMs}`;

const LINE_TABLE = 'rating_usage_line';

const lineRow = (account: string, product: string, route: string, minuteMs: number): RowRef =>
  ({ table: LINE_TABLE, key: { partition: utf8(account), product, route, minute: minuteMs } });

function cmpPos(a: { generation: number; seq: string }, b: { generation: number; seq: string }): number {
  if (a.generation !== b.generation) return a.generation < b.generation ? -1 : 1;
  const x = BigInt(a.seq); const y = BigInt(b.seq);
  return x === y ? 0 : x < y ? -1 : 1;
}

const max0 = (x: bigint): bigint => (x > 0n ? x : 0n);

export class RatingOwner implements OwnerHooks, RatingSink {
  private readonly rt: OwnerRuntime;
  private readonly opts: RatingOptions;
  private readonly queue = new SerialQueue();
  private readonly accounts = new Map<string, AccountState>();
  private readonly watermarks = new Map<number, number>();

  constructor(rt: OwnerRuntime, opts: RatingOptions) {
    this.rt = rt;
    this.opts = opts;
    rt.subscribe(TOPIC_CATALOGUE, { positions: [] }, 'committed', async (e) => { opts.catalogue.applyFeedEvent(e); });
    rt.onResolved(TOPIC_CATALOGUE, (_d, R) => opts.catalogue.onResolved(R));
    rt.subscribe(TOPIC_USAGE_APPLIED, { positions: [] }, 'committed', (e) => this.queue.run(() => this.onUsageApplied(e)));
    rt.subscribe(TOPIC_POSTING_ACKS, { positions: [] }, 'committed', (e) => this.queue.run(() => this.onPostingAck(e)));
  }

  idle(): Promise<void> {
    return this.queue.idle();
  }

  /** A copy of the account state (for tests and reports). */
  stateOf(account: string): AccountState | undefined {
    const s = this.accounts.get(account);
    return s ? structuredClone(s) : undefined;
  }

  // ---------- C01 hooks ----------
  async onAcquire(_s: SlotNo, _e: Epoch): Promise<void> {}
  onRelease(_s: SlotNo): void {}
  onReportable(): void {}
  onMovedOut(p: PartitionKey): void {
    this.accounts.delete(Buffer.from(p).toString('utf8'));
  }
  async onAdopt(_p: PartitionKey, _g: Generation): Promise<void> {}
  async onNotification(_n: InboundNotification): Promise<void> {}

  /** C01 §3.7: a timer fired. The owner appends an entry if it is still due. */
  onTimer(partition: PartitionKey, key: string): void {
    const account = Buffer.from(partition).toString('utf8');
    // The runtime does not wait for a timer step (C01 §3.7), so a failed step is raised as an alert, not lost.
    this.queue.run(async () => {
      if (key === 'figure') {
        await this.step(account, RATING_ENTRY.inputs, `figure:${this.nowMs()}`, (next) => (next.figureDue ? { applied: [], figureOnly: true } : null));
        await this.maybeEmit(account);
      } else if (key === 'amend') await this.formAmendments(account);
      else await this.closeDue(account);
    }).catch((e: unknown) => this.opts.alerts?.raise({ owner: 'rating', kind: 'STEP_FAILED', detail: `timer ${key} ${account}: ${String(e)}` }));
  }

  /** The stage A watermark of one destination partition of the hand-off topic (RFC-003 §4.2). */
  onStageAWatermark(destinationPartition: number, watermarkMs: number): Promise<void> {
    return this.queue.run(async () => {
      const cur = this.watermarks.get(destinationPartition) ?? -Infinity;
      if (watermarkMs > cur) this.watermarks.set(destinationPartition, watermarkMs);
      for (const account of [...this.accounts.keys()]) await this.closeDue(account);
    });
  }

  private watermarkMin(): number {
    const n = this.opts.handoffPartitions ?? 1;
    let min = Infinity;
    for (let p = 0; p < n; p++) min = Math.min(min, this.watermarks.get(p) ?? -Infinity);
    return min;
  }

  private nowMs(): number {
    return hlcToWallMs(this.rt.now().ts);
  }

  private account(account: string): AccountState {
    let s = this.accounts.get(account);
    if (!s) {
      s = { lines: {}, attrBSeq: '0', dueMinutes: [], attached: {}, figureDue: false, usageBatchCount: 0,
        ledgerX: { ledgerPartition: this.opts.homeLedgerPartition(account), sequence: '0', commitTs: '0.0000000000' } };
      this.accounts.set(account, s);
    }
    return s;
  }

  // ---------- the state machine step ----------

  /**
   * One entry for the account. `build` changes `next` (a copy of the state) and returns the
   * entry payload; it may add emits. The figure goes into the same entry when it changed and
   * the 2 s interval allows it.
   */
  private async step(account: string, kind: number, identityKey: string,
    build: (next: AccountState, ctx: BatchContext, pos: { generation: number; seq: string }, emits: Array<{ stream: string; event: unknown }>) => Record<string, unknown> | null,
    reads: RowRef[] = [],
  ): Promise<boolean> {
    const partition = utf8(account);
    const slot = this.rt.route('rating', partition).slot;
    let committed: AccountState | undefined;
    const out = await appendWithPolicy(this.rt, {
      partition,
      ...(reads.length > 0 ? { reads } : {}),
      decide: (ctx) => {
        const head = ctx.head(partition);
        const next = structuredClone(this.account(account));
        const pos = { generation: head.generation, seq: (head.seq + 1n).toString() };
        const emits: Array<{ stream: string; event: unknown }> = [];
        const payload = build(next, ctx, pos, emits);
        if (payload === null) return null;
        const figure = this.figureOf(next, account, ctx, pos, head.streams, Number(this.rt.epoch(slot)));
        if (figure) emits.push({ stream: 'unposted', event: figure });
        committed = next;
        const projections: ProjectionWrite[] = Object.values(next.lines)
          .filter((l) => lineSig(l) !== lineSig(this.account(account).lines[lineKey(l.product, l.route, l.minuteMs)]))
          .map((l) => ({ table: 'rating_usage_line', op: 'upsert' as const,
            key: lineRow(account, l.product, l.route, l.minuteMs).key,
            row: { line: { ...l, ela: elaToJson(l.ela) } } }));
        const entry: EntryInput = { kind, schemaV: 1, identity: identityOf('rating', account, identityKey), audit: serviceAudit('rating'),
          payload: { ...payload, ...(figure ? { figure: { ratingPosition: figure.ratingPosition, products: figure.products } } : {}) },
          emits };
        return { entries: [entry], projections };
      },
    }, undefined, { owner: 'rating', ...(this.opts.alerts ? { alerts: this.opts.alerts } : {}), ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}) });
    if (!out.ok || !committed) return false;
    this.accounts.set(account, committed);
    this.armTimers(account, committed);
    return true;
  }

  private armTimers(account: string, s: AccountState): void {
    const partition = utf8(account);
    const now = this.nowMs();
    if (s.figureDue && s.lastFigure) this.rt.timer(partition, 'figure', hlcFromWallMs(s.lastFigure.atMs + RATE_PARAMS.exposurePublishIntervalMs));
    const first = [...s.dueMinutes].sort((a, b) => a - b)[0];
    if (first !== undefined) {
      const base = first + 60_000 + RATE_PARAMS.flowActiveTimeoutMs + RATE_PARAMS.maxLatenessMs;
      const at = now < base + RATE_PARAMS.usageCloseMarginMs ? base + RATE_PARAMS.usageCloseMarginMs : base + RATE_PARAMS.usageCloseBoundMs;
      this.rt.timer(partition, 'close', hlcFromWallMs(Math.max(at, now)));
    }
    const amendAt = Object.values(s.lines).filter((l) => l.late && !l.pending).map((l) => (l.late as { sinceMs: number }).sinceMs + RATE_PARAMS.amendmentIntervalMs);
    if (amendAt.length > 0) this.rt.timer(partition, 'amend', hlcFromWallMs(Math.max(Math.min(...amendAt), now)));
  }

  // ---------- the figure (C06 §3) ----------

  private figureOf(s: AccountState, account: string, ctx: BatchContext, pos: { generation: number; seq: string },
    streams: Record<string, bigint>, epoch: number): UnpostedUsageFigure | undefined {
    const products = new Set<string>(Object.keys(s.attached));
    const u = new Map<string, bigint>();
    const d = new Map<string, bigint>();
    const inB = new Set(s.inFlight?.lineKeys ?? []);
    for (const [k, l] of Object.entries(s.lines)) {
      const c = this.chargeOf(l);
      const p = BigInt(l.posted);
      if (c !== p) products.add(l.product);
      u.set(l.product, (u.get(l.product) ?? 0n) + max0(c - p));
      if (s.inFlight && inB.has(k) && s.inFlight.answered[k] !== 'posted') {
        const amount = BigInt(l.pending?.amount ?? '0');
        d.set(l.product, (d.get(l.product) ?? 0n) + max0(c - p) - max0(c - (p + amount)));
      }
    }
    const list = [...products].sort().map((product) => ({
      product, unpostedUsage: (u.get(product) ?? 0n).toString(),
      ...(s.inFlight ? { usageReduction: (d.get(product) ?? 0n).toString() } : {}),
    }));
    const key = JSON.stringify({ list, b: s.inFlight?.batchId ?? null, x: s.ledgerX.sequence });
    if (s.lastFigure?.key === key) { s.figureDue = false; return undefined; }
    const nowMs = hlcToWallMs(ctx.ts);
    if (s.lastFigure && nowMs < s.lastFigure.atMs + RATE_PARAMS.exposurePublishIntervalMs) { s.figureDue = true; return undefined; }
    s.lastFigure = { atMs: nowMs, key };
    s.figureDue = false;
    if (s.inFlight && !s.inFlight.namedAt) s.inFlight.namedAt = { ...pos };
    const ratingPosition: RatingPosition = { ratingPartition: account, generation: pos.generation, seq: pos.seq };
    return {
      type: 'UnpostedUsageFigure', schemaVersion: 1,
      eventId: { partition: account, stream: 'unposted', streamSeq: ((streams['unposted'] ?? 0n) + 1n).toString(), generation: pos.generation, epoch },
      account, ratingPosition, ledgerPositionX: { ...s.ledgerX },
      ...(s.inFlight ? { inFlightUsageBatch: s.inFlight.batchId } : {}),
      products: list,
      publishedAt: ctx.ts,
    };
  }

  /** ⌊V(L) / 10^6⌋ at the line's price; 0 while the minute has no price. */
  private chargeOf(l: UsageLine): bigint {
    const p = this.opts.catalogue.usagePriceAt(l.product, l.route, l.minuteMs);
    return p ? usageCharge(l.ela, p.price) : 0n;
  }

  // ---------- inputs from stage B (in process) ----------

  applyParts(input: StageBInput): Promise<void> {
    return this.queue.run(async () => {
      // C11 Part IV: bytes are { num, den } with num a signed integer and den > 0. A batch with
      // another value is not applied, so the account's input stops and an operator is alerted.
      const bad = input.parts.find((p) => !exactBytesValid(p.bytes));
      if (bad) {
        this.opts.alerts?.raise({ owner: 'rating', kind: 'INVALID_PART', detail: `attr_b ${input.attrBSeq}: bytes ${bad.bytes.num}/${bad.bytes.den}` });
        return;
      }
      this.evictCold(input.account);
      const ok = await this.step(input.account, RATING_ENTRY.inputs, `inputs:attr_b:${input.attrBSeq}`, (next, ctx) => {
        if (BigInt(input.attrBSeq) <= BigInt(next.attrBSeq)) return null; // applied before
        next.attrBSeq = input.attrBSeq;
        const nowMs = hlcToWallMs(ctx.ts);
        for (const b of input.bindingFacts) if (!b.retracted) next.attached[b.productId] = true;
        let counted = 0;
        let late = 0;
        for (const p of input.parts) {
          if (p.class === 'reservation') {
            this.opts.alerts?.raise({ owner: 'rating', kind: 'RESERVATION_CLASS_NOT_IN_I1', detail: p.reservationId ?? '' });
            continue;
          }
          const k = lineKey(p.productId, p.routeId, p.minuteMs);
          const line = next.lines[k] ?? this.lineOf(next, input.account, p, ctx, nowMs);
          line.ela = addFraction(line.ela, BigInt(p.bytes.num), BigInt(p.bytes.den));
          if (line.closed) {
            // RFC-003 §5.6: a part applied after the closing entry goes into an amendment (P3-S17).
            const records = line.late?.records ?? [];
            const id = JSON.stringify(p.recordIdentity);
            line.late = { sinceMs: line.late?.sinceMs ?? nowMs, records: records.includes(id) ? records : [...records, id] };
            late += 1;
          } else if (!next.dueMinutes.includes(p.minuteMs)) next.dueMinutes.push(p.minuteMs);
          next.lines[k] = line;
          counted += 1;
        }
        // The inputs entry records the position applied through and the open minutes whose closure timers it arms.
        return { applied: [{ feed: 'attr_b', seq: input.attrBSeq }], parts: counted, ...(late > 0 ? { late } : {}),
          dueMinutes: [...next.dueMinutes].sort((a, b) => a - b) };
      }, this.readsFor(input));
      if (ok) {
        await this.closeDue(input.account);
        await this.formAmendments(input.account);
      }
    });
  }

  /**
   * The line of a part that is not in memory. A part of a closed minute (RFC-003 §5.6) amends the line that its last
   * entry saved, read back from the line row when it is older than amendment_hot_window (RFC-003 §5.1, §5.11); with no
   * saved line, the part starts a late original. A part of an open minute starts a new line.
   */
  private lineOf(s: AccountState, account: string, p: Part, ctx: BatchContext, nowMs: number): UsageLine {
    const fresh: UsageLine = { product: p.productId, route: p.routeId, minuteMs: p.minuteMs, ela: emptyEla(), closed: false, emitted: null,
      posted: '0', seq: -1 };
    if (s.closedThroughMs === undefined || p.minuteMs > s.closedThroughMs) return fresh;
    const saved = ctx.read(lineRow(account, p.productId, p.routeId, p.minuteMs));
    if (isLineRow(saved)) return { ...saved.line, ela: elaFromJson(saved.line.ela) };
    return { ...fresh, closed: true, closedAtMs: nowMs, emitted: '0', original: '0' };
  }

  /** The line rows that the parts of a closed minute may need (declared reads, C01 R47-11). */
  private readsFor(input: StageBInput): RowRef[] {
    const s = this.accounts.get(input.account);
    const through = s?.closedThroughMs;
    if (through === undefined) return [];
    const out = new Map<string, RowRef>();
    for (const p of input.parts) {
      const k = lineKey(p.productId, p.routeId, p.minuteMs);
      if (p.class !== 'reservation' && p.minuteMs <= through && !s?.lines[k]) out.set(k, lineRow(input.account, p.productId, p.routeId, p.minuteMs));
    }
    return [...out.values()];
  }

  /**
   * Drop from memory each closed line older than amendment_hot_window that is fully posted, with nothing pending and no
   * late record (RFC-003 §5.1). Its row keeps the ELA and the emitted total of its last entry.
   */
  private evictCold(account: string): void {
    const s = this.accounts.get(account);
    if (!s) return;
    const now = this.nowMs();
    for (const [k, l] of Object.entries(s.lines)) {
      if (l.closed && l.closedAtMs !== undefined && now >= l.closedAtMs + RATE_PARAMS.amendmentHotWindowMs && !l.pending && !l.late
        && l.emitted !== null && BigInt(l.posted) === BigInt(l.emitted)) delete s.lines[k];
    }
  }

  // ---------- closure (RFC-003 §5.6) ----------

  private closable(minuteMs: number, nowMs: number): boolean {
    const base = minuteMs + 60_000 + RATE_PARAMS.flowActiveTimeoutMs + RATE_PARAMS.maxLatenessMs;
    if (nowMs < base + RATE_PARAMS.usageCloseMarginMs) return false;
    return this.watermarkMin() >= base || nowMs >= base + RATE_PARAMS.usageCloseBoundMs;
  }

  private async closeDue(account: string): Promise<void> {
    const s = this.accounts.get(account);
    if (!s) return;
    const now = this.nowMs();
    const due = [...s.dueMinutes].sort((a, b) => a - b).filter((m) => this.closable(m, now));
    for (const m of due) {
      const ok = await this.step(account, RATING_ENTRY.usageClosed, `usage-closed:${m}`, (next, ctx, pos) => {
        const closed: Array<Record<string, string>> = [];
        for (const [k, l] of Object.entries(next.lines)) {
          if (l.minuteMs !== m || l.closed) continue;
          const price = this.opts.catalogue.usagePriceAt(l.product, l.route, m);
          const weights = this.opts.catalogue.weightsAt(l.route, m);
          if (!price || !weights) {
            this.opts.alerts?.raise({ owner: 'rating', kind: 'NO_PRICE_OR_WEIGHTS', detail: k });
            return null;
          }
          l.closed = true;
          l.closedAtMs = hlcToWallMs(ctx.ts);
          l.priceVersion = price.priceVersion;
          l.weightsVersion = weights.weightsVersion;
          l.priceCatalogue = this.opts.catalogue.position().resolvedTs;
          const c = usageCharge(l.ela, price.price);
          // The closing entry fixes the original. A line of 0 micro-USD has nothing to post; its emitted total is 0.
          l.original = c.toString();
          if (c === 0n) l.emitted = '0';
          closed.push({ product: l.product, route: l.route, amount: c.toString(), ...elaFlat(l.ela) });
        }
        next.dueMinutes = next.dueMinutes.filter((x) => x !== m);
        next.closedThroughMs = Math.max(next.closedThroughMs ?? m, m);
        this.formBatch(next, account, pos, hlcToWallMs(ctx.ts), false);
        return { minute: minuteIso(m), lines: closed, inFlightUsageBatch: next.inFlight?.batchId ?? null };
      });
      if (!ok) break;
    }
    // A minute that is not closable yet keeps its timer: at the margin, then at the 45 s bound (RFC-003 §5.6).
    const after = this.accounts.get(account);
    if (after) this.armTimers(account, after);
    await this.maybeEmit(account);
  }

  // ---------- amendments (RFC-003 §5.7) ----------

  /** True when a closed line has late records whose amendment_interval has passed and its last sequence is posted. */
  private amendmentDue(l: UsageLine, nowMs: number): boolean {
    return l.closed && !l.pending && l.late !== undefined && l.emitted !== null && BigInt(l.posted) === BigInt(l.emitted)
      && nowMs >= l.late.sinceMs + RATE_PARAMS.amendmentIntervalMs;
  }

  /** Form a usage batch of the amendments that are due, in one `amendment` entry, when no usage batch is in flight. */
  private async formAmendments(account: string): Promise<void> {
    const s = this.accounts.get(account);
    if (!s || s.inFlight) return;
    const now = this.nowMs();
    if (Object.values(s.lines).some((l) => this.amendmentDue(l, now))) {
      await this.step(account, RATING_ENTRY.amendment, `amendment:${now}`, (next, ctx, pos) => {
        if (next.inFlight) return null;
        return this.formBatch(next, account, pos, hlcToWallMs(ctx.ts), true);
      });
    }
    const after = this.accounts.get(account);
    if (after) this.armTimers(account, after);
    await this.maybeEmit(account);
  }

  /**
   * Form the next usage batch when no batch is in flight (C06 §5): closed lines whose original is not emitted, and,
   * with `amendments`, the late-traffic amendments that are due. Each amendment restates the line's total: `C − E`
   * with `C = ⌊V_new / 10^6⌋` (RFC-003 §5.7). Only upward: a lower `C` is alerted and not emitted.
   */
  private formBatch(s: AccountState, account: string, pos: { generation: number; seq: string }, nowMs: number, amendments: boolean):
    { batchId: BatchId | null; lines: Array<Record<string, unknown>>; unchanged: string[]; downward: string[] } {
    const formed = { batchId: null as BatchId | null, lines: [] as Array<Record<string, unknown>>, unchanged: [] as string[], downward: [] as string[] };
    if (s.inFlight) return formed;
    const byMinute = ([, a]: [string, UsageLine], [, b]: [string, UsageLine]): number =>
      a.minuteMs - b.minuteMs || a.product.localeCompare(b.product) || a.route.localeCompare(b.route);
    const keys: string[] = [];
    for (const [k, l] of Object.entries(s.lines).filter(([, l]) => l.closed && l.emitted === null && !l.pending).sort(byMinute)) {
      if (keys.length >= MOVEMENT_LIMIT) break;
      const amount = l.original ?? '0';
      l.pending = { seq: 0, amount, newTotal: amount, priorTotal: '0' };
      keys.push(k);
    }
    if (amendments) {
      for (const [k, l] of Object.entries(s.lines).filter(([, l]) => this.amendmentDue(l, nowMs)).sort(byMinute)) {
        if (keys.length >= MOVEMENT_LIMIT) break;
        const late = l.late as { sinceMs: number; records: string[] };
        const c = this.chargeOf(l);
        const e = BigInt(l.emitted as string);
        if (c === e) { delete l.late; formed.unchanged.push(k); continue; }
        if (c < e) {
          // Late traffic never lowers a charge (P3-S33); a lower total needs a cause, which I16 gives.
          this.opts.alerts?.raise({ owner: 'rating', kind: 'LATE_TRAFFIC_DOWNWARD', detail: k });
          delete l.late;
          formed.downward.push(k);
          continue;
        }
        if (l.seq < 0) {
          // A late original takes the price and the weights of its own minute.
          const price = this.opts.catalogue.usagePriceAt(l.product, l.route, l.minuteMs);
          const weights = this.opts.catalogue.weightsAt(l.route, l.minuteMs);
          if (!price || !weights) { this.opts.alerts?.raise({ owner: 'rating', kind: 'NO_PRICE_OR_WEIGHTS', detail: k }); continue; }
          l.priceVersion = price.priceVersion;
          l.weightsVersion = weights.weightsVersion;
          l.priceCatalogue = this.opts.catalogue.position().resolvedTs;
        }
        l.pending = { seq: l.seq + 1, amount: (c - e).toString(), newTotal: c.toString(), priorTotal: e.toString(), records: late.records };
        delete l.late;
        keys.push(k);
        formed.lines.push({ product: l.product, route: l.route, minute: minuteIso(l.minuteMs), seq: l.pending.seq, amount: l.pending.amount,
          newTotal: l.pending.newTotal, priorTotal: l.pending.priorTotal, reason: 'late_traffic', records: late.records, ...elaFlat(l.ela) });
      }
    }
    if (keys.length === 0) return formed;
    // BatchId "<ratingPartition>:<generation>:<emittedSeq>:<index>". The figure must name the batch
    // before it is emitted, so the sequence is that of the entry that forms the batch.
    const batchId = `${account}:${pos.generation}:${pos.seq}:0`;
    for (const k of keys) (s.lines[k] as UsageLine).batchId = batchId;
    s.inFlight = { batchId, lineKeys: keys, emitted: false, answered: {} };
    s.usageBatchCount += 1;
    return { ...formed, batchId };
  }

  // ---------- publish before emit (C06 §4, §5) ----------

  private async onUsageApplied(e: FeedEvent): Promise<void> {
    const ua = decodeJson(e.value) as UsageApplied;
    const s = this.accounts.get(ua.account);
    if (!s) return;
    // Dedup by (account, appliedThrough); keep the maximum. An older one never lowers the gate.
    const at = { generation: ua.appliedThrough.generation, seq: ua.appliedThrough.seq };
    if (s.appliedThrough && cmpPos(at, s.appliedThrough) <= 0) return;
    s.appliedThrough = at;
    await this.maybeEmit(ua.account);
  }

  private async maybeEmit(account: string): Promise<void> {
    const s = this.accounts.get(account);
    const b = s?.inFlight;
    if (!s || !b || b.emitted || !b.namedAt || !s.appliedThrough || cmpPos(s.appliedThrough, b.namedAt) < 0) return;
    const slot = this.rt.route('rating', utf8(account)).slot;
    await this.step(account, RATING_ENTRY.emitted, `emitted:${b.batchId}`, (next, ctx, pos, emits) => {
      const nb = next.inFlight as InFlight;
      const lines: ChargeLine[] = nb.lineKeys.map((k) => chargeLineOf(account, next.lines[k] as UsageLine));
      nb.emitted = true;
      const batch: ChargeLineBatch = {
        type: 'ChargeLineBatch', schemaVersion: 1,
        eventId: { partition: account, stream: 'charges', streamSeq: ((ctx.head(utf8(account)).streams['charges'] ?? 0n) + 1n).toString(),
          generation: pos.generation, epoch: Number(this.rt.epoch(slot)) },
        batch: { id: nb.batchId, kind: 'usage', account, gated: true, lineCount: lines.length },
        lines,
        emittedAt: ctx.ts,
      };
      emits.push({ stream: 'charges', event: batch });
      return { stream: 'usage', batchId: nb.batchId, lines: lines.map((l) => ({ sourceRef: l.sourceRef, amount: l.amount })),
        appliedThrough: next.appliedThrough, usageReduction: 'in the figure that names the batch' };
    });
  }

  // ---------- posting acknowledgements (C06 §7) ----------

  private async onPostingAck(e: FeedEvent): Promise<void> {
    const ack = decodeJson(e.value) as PostingAck;
    const s = this.accounts.get(ack.account);
    const b = s?.inFlight;
    if (!s || !b || b.batchId !== ack.batchId) return; // an answer to a batch that is no longer in flight: no effect
    const byDigest = new Map(b.lineKeys.map((k) => {
      const l = s.lines[k] as UsageLine;
      return [sourceRefDigest(usageRefOf(ack.account, l, l.pending?.seq ?? 0)), k];
    }));
    const fresh = ack.lines.filter((la) => {
      const k = byDigest.get(sourceRefDigest(la.sourceRef));
      return k !== undefined && b.answered[k] === undefined;
    });
    if (fresh.length === 0) return; // (batchId, sourceRef) answered before: no effect
    const digests = fresh.map((la) => sourceRefDigest(la.sourceRef)).sort().join(',');
    await this.step(ack.account, RATING_ENTRY.posted, `posted:${ack.batchId}:${digests}`, (next, ctx, pos) => {
      const nb = next.inFlight as InFlight;
      const recorded: unknown[] = [];
      for (const la of fresh) {
        const k = byDigest.get(sourceRefDigest(la.sourceRef)) as string;
        const l = next.lines[k] as UsageLine;
        delete l.pending;
        if (la.outcome === 'posted') {
          // Marked posted only on `posted`; the total and the position go to P_X (C06 §7).
          nb.answered[k] = 'posted';
          l.posted = la.postedTotal;
          l.postedPosition = la.position;
          if (la.position.ledgerPartition === next.ledgerX.ledgerPartition && BigInt(la.position.sequence) > BigInt(next.ledgerX.sequence)) {
            next.ledgerX = { ...la.position };
          }
          recorded.push({ sourceRef: la.sourceRef, postedTotal: la.postedTotal, position: la.position, duplicate: la.duplicate });
        } else {
          // I1 does not re-emit or park; I5 does (C06 CT-C2). The line stays unposted and in U.
          nb.answered[k] = 'excluded';
          this.opts.alerts?.raise({ owner: 'rating', kind: 'LINE_EXCLUDED_NOT_IN_I1', detail: `${la.reason} ${k}` });
          recorded.push({ sourceRef: la.sourceRef, excluded: la.reason });
        }
      }
      if (nb.lineKeys.every((k) => nb.answered[k] !== undefined)) {
        delete next.inFlight;
        this.formBatch(next, ack.account, pos, hlcToWallMs(ctx.ts), false);
      }
      return { batchId: ack.batchId, lines: recorded };
    });
    await this.formAmendments(ack.account);
    await this.maybeEmit(ack.account);
  }
}

/** The usage SourceRef of a line with an amendment sequence (C06 §5). */
function usageRefOf(account: string, l: UsageLine, seq: number): SourceRef {
  return { kind: 'usage', account, product: l.product, route: l.route, minute: minuteIso(l.minuteMs), seq };
}

/**
 * The charge line of a line in the batch; it sets E and the last sequence of the line. Sequence 0 is the original;
 * caused by late records it is the late original, with the trigger in `triggerRef` and `reasonDetails` (C06 m5).
 * A higher sequence is a `late_traffic` amendment with the record identities and the original's weights (C06 D4).
 */
function chargeLineOf(account: string, l: UsageLine): ChargeLine {
  const p = l.pending as PendingLine;
  l.emitted = p.newTotal;
  l.seq = p.seq;
  const records: Record<string, string> = p.records ? { records: `[${p.records.join(',')}]` } : {};
  const lateOriginal = p.seq === 0 && p.records !== undefined && p.records.length > 0;
  return {
    sourceRef: usageRefOf(account, l, p.seq), lineKind: 'usage', account, product: l.product, route: l.route,
    weightsVersion: l.weightsVersion as string, minute: minuteIso(l.minuteMs), payer: 'account',
    amount: p.amount, newTotal: p.newTotal, priorTotal: p.priorTotal, reason: p.seq === 0 ? 'original' : 'late_traffic',
    reasonDetails: { priceVersion: l.priceVersion ?? '', ...(lateOriginal ? { trigger: 'late_traffic' } : {}), ...records },
    ...(lateOriginal ? { triggerRef: p.records?.[0] as string } : {}),
    priceCatalogue: { resolvedTs: l.priceCatalogue ?? '0.0000000000' },
  };
}

/** A saved line row: the line with its ELA as decimal strings (the `rating_usage_line` projection). */
function isLineRow(x: unknown): x is { line: Omit<UsageLine, 'ela'> & { ela: { S: string; r: Record<string, string> } } } {
  if (typeof x !== 'object' || x === null || !('line' in x)) return false;
  const l: unknown = x.line;
  return typeof l === 'object' && l !== null && 'ela' in l && 'emitted' in l && 'posted' in l && 'seq' in l && 'closed' in l;
}

/** True when the exact bytes of a part are a signed integer over a positive integer (C11 Part IV). */
export function exactBytesValid(b: ExactBytes): boolean {
  return /^-?\d+$/.test(b.num) && /^\d+$/.test(b.den) && BigInt(b.den) > 0n;
}

function elaFlat(e: Ela): Record<string, string> {
  const j = elaToJson(e);
  return { elaS: j.S, elaR: JSON.stringify(j.r) };
}

function lineSig(l: UsageLine | undefined): string {
  return l === undefined ? '' : JSON.stringify({ ...l, ela: elaToJson(l.ela) });
}
