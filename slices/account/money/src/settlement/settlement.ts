/**
 * Settlement of charge-line batches (RFC-004 §B3.1, C06 "Charge-line batches", "Settlement mapping", "Ledger
 * posting port"). It maps each line by the C06 mapping table to one posting rule of RFC-004 §B2, builds the
 * entries, and posts each batch as one movement to the home partition: a reservation batch as one M4 (a bad
 * line is excluded), a usage batch whole or not at all (C06 D1). It holds work in one queue for each account
 * and commits its Kafka offset at the low-water mark of the batches not yet answered. A restarted or standby
 * instance reads those batches again; the ledger's dedup makes that safe.
 */
import type { CommandEnvelope } from '@share/owner-runtime';
import {
  MOVEMENT_LINE_LIMIT, RESERVATION_BATCHES_IN_FLIGHT,
  type ChargeLine, type ChargeLineBatch, type LineAck, type PostLine, type PostMovementRequest, type PostMovementResponse,
  type PostingAck, type SourceRef, type SplitWeights,
} from '../contracts/c06.ts';
import { isSourceRef, lineKeyDigest, parseMicro, seqOf, sourceRefDigest } from '../money.ts';
import { WeightsError } from '../webster.ts';
import { ledgerPartitionOfBuyer, DEFAULT_PARTITION_COUNT } from '../ledger/accounts.ts';
import type { LineRecord, WeightsSource } from '../ledger/decide.ts';
import type { LedgerAnswer, PostCall } from '../ledger/owner.ts';
import {
  holdingOfRecord, inReservationBatch, needsWeights, postingOf, ruleOf, type LineFacts, type Posting, type Rule,
} from '../ledger/templates.ts';
import { DeviationAccumulator, weekOf, type SplitPosted } from './deviation.ts';

/** The posting port as settlement calls it (gRPC to the owner of the home partition in production). */
export interface LedgerPort {
  post(call: PostCall): Promise<LedgerAnswer>;
}

/** The ledger's state of a line key (a status read of the ledger's line projection). */
export interface LineStateReader {
  lineState(partition: string, ref: SourceRef): Promise<LineRecord | undefined>;
}

/** Time for settlement: the clock and delayed work. Tests use a manual scheduler. */
export interface Scheduler {
  nowMs(): number;
  after(ms: number, fn: () => void): void;
}

export type SettlementAlertCode =
  | 'BATCH_OVER_LIMIT' | 'LINE_INVALID' | 'BATCH_REFUSED' | 'MOVEMENT_REFUSED' | 'LEDGER_STOPPED' | 'WEIGHTS_UNKNOWN'
  | 'INTEGRITY_ALERT' | 'UNEXPECTED_ANSWER' | 'POST_FAILED';
export interface SettlementAlert { code: SettlementAlertCode; account: string; batchId: string; detail: string }

export interface SettlementOptions {
  ledger: LedgerPort;
  weights: WeightsSource;
  scheduler: Scheduler;
  /** Direct publish on `settlement.posting-acks.v1` (C06 §7): refusals and settlement's own exclusions. */
  publishAcks(ack: PostingAck): Promise<void>;
  /** Commit the next offset to read of one Kafka partition (C06 M8: the low-water mark). */
  commitOffset(kafkaPartition: number, nextOffset: bigint): Promise<void>;
  /** The ledger's line states (default: `ledger`, if it can read them). Needed for amendments (C06 D2). */
  lineStates?: LineStateReader;
  /** The deviation accumulator of this buyer partition (RFC-004 §B3.5). */
  deviation?: DeviationAccumulator;
  /** The payout period of a posting time (default: the UTC week, Monday first). */
  periodOf?: (postingTime: string) => string;
  partitionCount?: number;
  /** The workload identity of this instance (C06 §8 "Principal"). */
  principal?: string;
  /** Identity of this instance on its direct publishes. */
  instance?: { name: string; generation: number; epoch: number };
  /** The command envelope of a posting-port call, if the transport carries one (C01 §2.4). */
  envelope?: (partition: string, movementRef: string) => CommandEnvelope | undefined;
  onAlert?: (a: SettlementAlert) => void;
}

/** C06 "Ledger posting port": `stopped` and movement-level refusals are retried not more often than every 30 s (est.). */
export const HOLD_RETRY_MS = 30_000;
/** `moving` and `not_owner`: tries at once, then after this wait. */
export const REROUTE_WAIT_MS = 20;
const BACKOFF_MIN_MS = 100;
const BACKOFF_MAX_MS = 5_000;
const AT_ONCE = 3;

interface Item {
  src: { partition: number; offset: bigint };
  batch: ChargeLineBatch;
  /** Settlement's own exclusions are published (at least once, before the offset passes the batch). */
  excludedPublished: boolean;
  attempts: number;
}

interface AccountQueue {
  queue: Item[];
  inFlight: number;
  /** C06 "Charge-line batches": one usage batch in flight for each account. */
  usageInFlight: boolean;
  heldUntilMs: number | undefined;
  /** After a hold, one batch tries first; the others start when it is answered. */
  probing: boolean;
}

/** What settlement sends for one line: the port line and the split it posts (for the deviation report). */
interface Planned { line: PostLine; split: SplitPosted | undefined; route: string | undefined; weightsVersion: string | undefined }

type Prepared =
  | { kind: 'post'; request: PostMovementRequest; excluded: LineAck[]; planned: Planned[] }
  | { kind: 'answered'; acks: LineAck[]; code?: SettlementAlertCode; detail?: string }
  | { kind: 'hold'; code: SettlementAlertCode; detail: string };

const isRecord = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object';

/** The facts of a charge line for the mapping table, or the reason it cannot be read (C06 §5). */
export function chargeFacts(l: ChargeLine): LineFacts | string {
  if (!isRecord(l)) return 'not an object';
  if (!isSourceRef(l.sourceRef)) return 'sourceRef is not a C06 SourceRef';
  const amount = parseMicro(l.amount);
  const total = parseMicro(l.newTotal);
  const prior = parseMicro(l.priorTotal);
  if (amount === undefined || total === undefined || prior === undefined) return 'an amount is not an integer string';
  if (amount !== total - prior) return 'amount ≠ newTotal − priorTotal';
  if (typeof l.lineKind !== 'string' || typeof l.reason !== 'string' || (l.payer !== 'account' && l.payer !== 'share')) return 'lineKind, reason or payer';
  return {
    ref: l.sourceRef, lineKind: l.lineKind, payer: l.payer, payee: l.payee, reason: l.reason, cause: l.cause, lateCut: l.lateCut,
    abandon: l.abandon, priorTotal: prior, newTotal: total, route: l.route, weightsVersion: l.weightsVersion,
  };
}

/** The port line of a charge line and its posting (C06 §8: the stored fields of M1, review 55). */
function portLine(l: ChargeLine, f: LineFacts, p: Posting): PostLine {
  return {
    kind: p.kind, lineRef: l.sourceRef, lineKind: f.lineKind, payer: f.payer,
    ...(f.payee !== undefined ? { payee: f.payee } : {}), reason: f.reason,
    ...(f.cause !== undefined ? { cause: f.cause } : {}), ...(f.lateCut !== undefined ? { lateCut: f.lateCut } : {}),
    ...(l.triggerRef !== undefined ? { triggerRef: l.triggerRef } : {}), ...(f.abandon !== undefined ? { abandon: f.abandon } : {}),
    amendmentSeq: seqOf(f.ref), priorTotal: l.priorTotal, newTotal: l.newTotal,
    ...(f.route !== undefined && f.weightsVersion !== undefined ? { split: { route: f.route, weightsVersion: f.weightsVersion, mode: p.after.mode } } : {}),
    entries: p.entries,
  };
}

/** The mapping row of a line of a batch, or why the line is invalid (C06 "Settlement mapping"). */
function mapInBatch(l: ChargeLine, b: ChargeLineBatch['batch']): { facts: LineFacts; rule: Rule } | string {
  const f = chargeFacts(l);
  if (typeof f === 'string') return f;
  const m = ruleOf(f);
  if ('invalid' in m) return m.invalid;
  if (l.account !== b.account) return `account ${String(l.account)} in the batch of ${b.account}`;
  if (inReservationBatch(f, m.rule) !== (b.kind === 'reservation')) return `a ${f.lineKind} line of rule ${m.rule} in a ${b.kind} batch`;
  if (b.kind === 'reservation' && f.ref.kind === 'reservation' && (l.minute !== b.minute || f.ref.minute !== b.minute)) {
    return `minute ${String(l.minute)} in the batch of ${String(b.minute)}`;
  }
  return { facts: f, rule: m.rule };
}

/** The split weights of a line, `undefined` if the line has no route, or a hold when the replica lacks weights a rule needs. */
function weightsOf(f: LineFacts, rule: Rule, weights: WeightsSource): SplitWeights | undefined | { hold: string } {
  if (f.route === undefined || f.weightsVersion === undefined) return undefined;
  const w = weights.find(f.route, f.weightsVersion);
  if (!w && needsWeights(rule)) return { hold: `no split weights ${f.route}/${f.weightsVersion}` };
  return w;
}

function overLimit(batch: ChargeLineBatch): LineAck[] {
  return batch.lines.map((l) => ({ sourceRef: l.sourceRef, outcome: 'excluded', reason: 'batch_over_limit' }));
}

/** Map one reservation batch to its request, or to settlement's own answer (C06 mapping table, V63-1, V63-3). */
export function prepareReservationBatch(batch: ChargeLineBatch, weights: WeightsSource): Prepared {
  const b = batch.batch;
  if (batch.lines.length > MOVEMENT_LINE_LIMIT) {
    return { kind: 'answered', acks: overLimit(batch), code: 'BATCH_OVER_LIMIT', detail: `${batch.lines.length} lines` };
  }
  const excluded: LineAck[] = [];
  const planned: Planned[] = [];
  const seen = new Set<string>();
  for (const l of batch.lines) {
    let m = mapInBatch(l, b);
    if (typeof m !== 'string') {
      const d = sourceRefDigest(m.facts.ref);
      if (seen.has(d)) m = 'the SourceRef is twice in the batch';
      seen.add(d);
    }
    if (typeof m === 'string') {
      excluded.push({ sourceRef: l?.sourceRef, outcome: 'excluded', reason: 'invalid' });
      continue;
    }
    const w = weightsOf(m.facts, m.rule, weights);
    if (w !== undefined && 'hold' in w) return { kind: 'hold', code: 'WEIGHTS_UNKNOWN', detail: w.hold };
    let p: Posting | { invalid: string };
    try {
      p = postingOf(m.rule, m.facts, b.account, undefined, w);
    } catch (e) {
      if (e instanceof WeightsError) return { kind: 'hold', code: 'WEIGHTS_UNKNOWN', detail: e.message };
      throw e;
    }
    if ('invalid' in p) { excluded.push({ sourceRef: l.sourceRef, outcome: 'excluded', reason: 'invalid' }); continue; }
    planned.push({ line: portLine(l, m.facts, p), split: p.split, route: m.facts.route, weightsVersion: m.facts.weightsVersion });
  }
  if (planned.length === 0) return { kind: 'answered', acks: excluded };
  return {
    kind: 'post', excluded, planned,
    request: {
      // P4-S71: the movement refers to the charge-line batch that caused it.
      movementRef: b.id, cause: `charge-line batch ${b.id}`, currency: 'USD',
      // C06 V63-1: rating's lineCount less the lines that settlement excluded; never a count of what is sent.
      batch: { id: b.id, kind: 'reservation', lineCount: b.lineCount - excluded.length },
      lines: planned.map((x) => x.line),
    },
  };
}

/** C06 D1: a usage batch with a line that cannot be posted is refused whole: the line `invalid`, every other line `batch_refused`. */
function refusedWhole(batch: ChargeLineBatch, invalid: Set<number>): LineAck[] {
  return batch.lines.map((l, i) => ({ sourceRef: l?.sourceRef, outcome: 'excluded', reason: invalid.has(i) ? 'invalid' : 'batch_refused' }));
}

/**
 * Map one usage batch to its request (C06 D1, D2), or to settlement's own answer. `states` reads the ledger's
 * state of a line key: an amendment is posted by the mode of its line and what each party holds.
 */
export async function prepareUsageBatch(batch: ChargeLineBatch, weights: WeightsSource,
  states: (ref: SourceRef) => Promise<LineRecord | undefined>): Promise<Prepared> {
  const b = batch.batch;
  if (batch.lines.length > MOVEMENT_LINE_LIMIT) {
    return { kind: 'answered', acks: overLimit(batch), code: 'BATCH_OVER_LIMIT', detail: `${batch.lines.length} lines` };
  }
  const invalid = new Set<number>();
  const mapped: Array<{ facts: LineFacts; rule: Rule } | undefined> = [];
  const keys = new Set<string>();
  batch.lines.forEach((l, i) => {
    const m = mapInBatch(l, b);
    if (typeof m === 'string') { invalid.add(i); mapped.push(undefined); return; }
    // C06 D2: not more than one sequence of a line key in a usage batch.
    const k = lineKeyDigest(m.facts.ref);
    if (keys.has(k)) invalid.add(i);
    keys.add(k);
    mapped.push(m);
  });
  if (invalid.size > 0) {
    return { kind: 'answered', acks: refusedWhole(batch, invalid), code: 'LINE_INVALID', detail: `${invalid.size} line(s) invalid; the batch is refused whole` };
  }
  const planned: Planned[] = [];
  for (const [i, l] of batch.lines.entries()) {
    const { facts, rule } = mapped[i]!;
    const w = weightsOf(facts, rule, weights);
    if (w !== undefined && 'hold' in w) return { kind: 'hold', code: 'WEIGHTS_UNKNOWN', detail: w.hold };
    const record = seqOf(facts.ref) > 0 ? await states(facts.ref) : undefined;
    let p: Posting | { invalid: string };
    try {
      p = postingOf(rule, facts, b.account, record ? holdingOfRecord(record, w) : undefined, w);
    } catch (e) {
      if (e instanceof WeightsError) return { kind: 'hold', code: 'WEIGHTS_UNKNOWN', detail: e.message };
      throw e;
    }
    if ('invalid' in p) {
      return { kind: 'answered', acks: refusedWhole(batch, new Set([i])), code: 'LINE_INVALID', detail: `line ${i}: ${p.invalid}; the batch is refused whole` };
    }
    planned.push({ line: portLine(l, facts, p), split: p.split, route: facts.route, weightsVersion: facts.weightsVersion });
  }
  return {
    kind: 'post', excluded: [], planned,
    request: {
      movementRef: b.id, cause: `charge-line batch ${b.id}`, currency: 'USD',
      // C06 V63-1: settlement excludes no line of a usage batch, so lineCount is rating's.
      batch: { id: b.id, kind: 'usage', lineCount: b.lineCount },
      lines: planned.map((x) => x.line),
    },
  };
}

/** The acknowledgement of a refused usage batch (C06 §7 "Refused usage batch"): each problem line its reason, the others `batch_refused`. */
function refusedBatchAcks(batch: ChargeLineBatch, answer: Extract<PostMovementResponse, { result: 'refused_batch' }>): LineAck[] {
  const problems = new Map(answer.lines.map((p) => [sourceRefDigest(p.lineRef), p]));
  return batch.lines.map((l): LineAck => {
    const p = problems.get(sourceRefDigest(l.sourceRef));
    if (!p) return { sourceRef: l.sourceRef, outcome: 'excluded', reason: 'batch_refused' };
    return {
      sourceRef: l.sourceRef, outcome: 'excluded', reason: p.problem === 'conflict' ? 'content_conflict' : p.problem,
      ...(p.of !== undefined ? { conflictOf: p.of } : {}),
      ...(p.ledgerPostedTotal !== undefined ? { ledgerPostedTotal: p.ledgerPostedTotal } : {}),
      ...(p.ledgerLastSeq !== undefined ? { ledgerLastSeq: p.ledgerLastSeq } : {}),
      ...(p.ledgerPosition !== undefined ? { ledgerPosition: p.ledgerPosition } : {}),
    };
  });
}

function isLineStateReader(x: unknown): x is LineStateReader {
  return isRecord(x) && typeof x['lineState'] === 'function';
}

export class Settlement {
  readonly alerts: SettlementAlert[] = [];
  /** The offset committed for each Kafka partition. */
  readonly committed = new Map<number, bigint>();
  /** The deviation accumulator of this instance (RFC-004 §B3.5). */
  readonly deviation: DeviationAccumulator;
  private readonly o: SettlementOptions;
  private readonly principal: string;
  private readonly partitionCount: number;
  private readonly lineStates: LineStateReader | undefined;
  private readonly accounts = new Map<string, AccountQueue>();
  private readonly unanswered = new Map<number, Map<bigint, number>>();
  private readonly highest = new Map<number, bigint>();
  private readonly active = new Set<Promise<void>>();
  private ackSeq = 0n;
  private stopped = false;

  constructor(o: SettlementOptions) {
    this.o = o;
    this.principal = o.principal ?? 'settlement';
    this.partitionCount = o.partitionCount ?? DEFAULT_PARTITION_COUNT;
    this.lineStates = o.lineStates ?? (isLineStateReader(o.ledger) ? o.ledger : undefined);
    this.deviation = o.deviation ?? new DeviationAccumulator();
  }

  /** One record of `rating.charge-lines.v1` that is a charge-line batch. It never waits on the ledger. */
  receive(src: { partition: number; offset: bigint }, batch: ChargeLineBatch): void {
    this.track(src);
    const account = batch.batch.account;
    let q = this.accounts.get(account);
    if (!q) { q = { queue: [], inFlight: 0, usageInFlight: false, heldUntilMs: undefined, probing: false }; this.accounts.set(account, q); }
    q.queue.push({ src, batch, excludedPublished: false, attempts: 0 });
    this.pump(account);
  }

  /** A record that is not a batch (for example a resolved marker): it needs no answer. */
  skip(src: { partition: number; offset: bigint }): void {
    this.track(src);
    this.answered(src);
  }

  /** True while the account's work is held (C06 M8). */
  isHeld(account: string): boolean {
    const q = this.accounts.get(account);
    return q?.heldUntilMs !== undefined;
  }

  /** Resolves when no post is in flight. Held work stays held. */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active]);
  }

  /** Stop: no new post starts. In-flight posts end; their answers do not move the offset. */
  stop(): void {
    this.stopped = true;
  }

  private track(src: { partition: number; offset: bigint }): void {
    // The first record read on a partition is where the group's committed offset stood.
    if (!this.committed.has(src.partition)) this.committed.set(src.partition, src.offset);
    let m = this.unanswered.get(src.partition);
    if (!m) { m = new Map(); this.unanswered.set(src.partition, m); }
    m.set(src.offset, (m.get(src.offset) ?? 0) + 1);
    const h = this.highest.get(src.partition);
    if (h === undefined || src.offset > h) this.highest.set(src.partition, src.offset);
  }

  private answered(src: { partition: number; offset: bigint }): void {
    const m = this.unanswered.get(src.partition);
    if (!m) return;
    const n = (m.get(src.offset) ?? 0) - 1;
    if (n > 0) m.set(src.offset, n); else m.delete(src.offset);
    if (this.stopped) return;
    let low: bigint | undefined;
    for (const off of m.keys()) if (low === undefined || off < low) low = off;
    const next = low ?? (this.highest.get(src.partition) ?? -1n) + 1n;
    const cur = this.committed.get(src.partition);
    if (cur === undefined || next > cur) {
      this.committed.set(src.partition, next);
      this.run(this.o.commitOffset(src.partition, next));
    }
  }

  private alert(a: SettlementAlert): void {
    this.alerts.push(a);
    this.o.onAlert?.(a);
  }

  private run(p: Promise<void>): void {
    const t = p.catch((e: unknown) => {
      this.alert({ code: 'POST_FAILED', account: '', batchId: '', detail: e instanceof Error ? e.message : String(e) });
    }).finally(() => { this.active.delete(t); });
    this.active.add(t);
  }

  private pump(account: string): void {
    const q = this.accounts.get(account);
    if (!q || this.stopped) return;
    const limit = q.probing ? 1 : RESERVATION_BATCHES_IN_FLIGHT;
    while (q.heldUntilMs === undefined && q.inFlight < limit && q.queue.length > 0) {
      // C06: one usage batch in flight for each account; the queue keeps its order behind it.
      if (q.queue[0]!.batch.batch.kind === 'usage' && q.usageInFlight) break;
      const item = q.queue.shift()!;
      q.inFlight += 1;
      if (item.batch.batch.kind === 'usage') q.usageInFlight = true;
      this.run(this.settle(account, q, item));
    }
  }

  /** Hold the account and try the item again after `ms` (C06 M8: other accounts continue). */
  private hold(account: string, q: AccountQueue, item: Item, ms: number): void {
    q.queue.unshift(item);
    q.heldUntilMs = this.o.scheduler.nowMs() + ms;
    this.o.scheduler.after(ms, () => {
      q.heldUntilMs = undefined;
      q.probing = true;
      this.pump(account);
    });
  }

  private async publish(account: string, batchId: string, lines: LineAck[]): Promise<void> {
    if (lines.length === 0) return;
    this.ackSeq += 1n;
    const inst = this.o.instance ?? { name: 'settlement', generation: 0, epoch: 1 };
    await this.o.publishAcks({
      type: 'PostingAck', schemaVersion: 1,
      eventId: { partition: inst.name, stream: 'direct', streamSeq: this.ackSeq.toString(), generation: inst.generation, epoch: inst.epoch },
      account, batchId, lines,
    });
  }

  private async prepare(item: Item, partition: string): Promise<Prepared> {
    if (item.batch.batch.kind === 'reservation') return prepareReservationBatch(item.batch, this.o.weights);
    if (item.batch.batch.kind !== 'usage') {
      return { kind: 'answered', acks: refusedWhole(item.batch, new Set(item.batch.lines.map((_, i) => i))), code: 'LINE_INVALID',
        detail: `batch kind ${String(item.batch.batch.kind)}` };
    }
    const reader = this.lineStates;
    return prepareUsageBatch(item.batch, this.o.weights, async (ref) => {
      if (!reader) throw new Error('settlement has no reader of the ledger line states');
      return reader.lineState(partition, ref);
    });
  }

  /** RFC-004 §B3.5: count each line that the ledger posted with a Webster split. */
  private countDeviation(answer: Extract<PostMovementResponse, { result: 'committed' }>, planned: Planned[]): void {
    const period = (this.o.periodOf ?? weekOf)(answer.postingTime);
    answer.lines.forEach((l, i) => {
      const p = planned[i];
      if (l.outcome !== 'posted' || !p?.split || p.route === undefined || p.weightsVersion === undefined) return;
      this.deviation.record(answer.movementId, i, period, p.route, p.weightsVersion, p.split);
    });
  }

  private async settle(account: string, q: AccountQueue, item: Item): Promise<void> {
    const b = item.batch.batch;
    let retryIn: number | undefined;
    let held = false;
    try {
      const partition = ledgerPartitionOfBuyer(account, this.partitionCount);
      const p = await this.prepare(item, partition);
      if (p.kind === 'hold') {
        this.alert({ code: p.code, account, batchId: b.id, detail: p.detail });
        held = true;
        this.hold(account, q, item, HOLD_RETRY_MS);
        return;
      }
      if (p.kind === 'answered') {
        if (p.code) this.alert({ code: p.code, account, batchId: b.id, detail: p.detail ?? '' });
        await this.publish(account, b.id, p.acks);
        this.answered(item.src);
        return;
      }
      if (p.excluded.length > 0 && !item.excludedPublished) {
        this.alert({ code: 'LINE_INVALID', account, batchId: b.id, detail: `${p.excluded.length} line(s) excluded invalid` });
        await this.publish(account, b.id, p.excluded);
        item.excludedPublished = true;
      }
      const envelope = this.o.envelope?.(partition, p.request.movementRef);
      const answer = await this.o.ledger.post({
        partition, principal: this.principal, request: p.request, account, ...(envelope ? { envelope } : {}),
      });
      switch (answer.result) {
        case 'committed':
          q.probing = false;
          if (answer.integrityAlert) this.alert({ code: 'INTEGRITY_ALERT', account, batchId: b.id, detail: 'the ledger answered with integrityAlert' });
          this.countDeviation(answer, p.planned);
          this.answered(item.src);
          return;
        case 'refused':
          if (answer.reason === 'over_limit') {
            await this.publish(account, b.id, p.request.lines.map((l) => ({ sourceRef: l.lineRef as ChargeLine['sourceRef'], outcome: 'excluded', reason: 'batch_over_limit' })));
            this.answered(item.src);
            return;
          }
          this.alert({ code: 'MOVEMENT_REFUSED', account, batchId: b.id, detail: `${answer.reason}: ${answer.detail}` });
          held = true;
          this.hold(account, q, item, HOLD_RETRY_MS);
          return;
        case 'refused_batch':
          if (b.kind !== 'usage') {
            this.alert({ code: 'UNEXPECTED_ANSWER', account, batchId: b.id, detail: 'refused_batch for a reservation batch' });
            held = true;
            this.hold(account, q, item, HOLD_RETRY_MS);
            return;
          }
          q.probing = false;
          // C06 §7: settlement publishes the acknowledgement of a refused usage batch directly; rating re-emits.
          this.alert({ code: 'BATCH_REFUSED', account, batchId: b.id,
            detail: answer.lines.map((x) => x.problem).join(', ') + (answer.integrityAlert ? ' (integrityAlert)' : '') });
          await this.publish(account, b.id, refusedBatchAcks(item.batch, answer));
          this.answered(item.src);
          return;
        case 'routing':
          this.alert({ code: 'MOVEMENT_REFUSED', account, batchId: b.id, detail: `routing refusal ${answer.refusal.code}` });
          held = true;
          this.hold(account, q, item, HOLD_RETRY_MS);
          return;
        case 'unavailable':
          if (answer.why === 'stopped') {
            this.alert({ code: 'LEDGER_STOPPED', account, batchId: b.id, detail: 'integrity stop' });
            held = true;
            this.hold(account, q, item, HOLD_RETRY_MS);
            return;
          }
          item.attempts += 1;
          retryIn = answer.why === 'overloaded'
            ? Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(item.attempts - 1, 10))
            : item.attempts <= AT_ONCE ? 0 : REROUTE_WAIT_MS;
          return;
      }
    } catch (e) {
      item.attempts += 1;
      this.alert({ code: 'POST_FAILED', account, batchId: b.id, detail: e instanceof Error ? e.message : String(e) });
      retryIn = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(item.attempts - 1, 10));
    } finally {
      q.inFlight -= 1;
      if (b.kind === 'usage') q.usageInFlight = false;
      if (retryIn !== undefined) {
        if (retryIn === 0) q.queue.unshift(item);
        else { held = true; this.hold(account, q, item, retryIn); }
      }
      if (!held) this.pump(account);
    }
  }
}
