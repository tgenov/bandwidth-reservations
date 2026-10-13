/**
 * Settlement of reservation batches (RFC-004 §B3.1, C06 "Charge-line batches", "Ledger posting port"). It
 * maps each batch to one M4 with the Webster split, posts it to the home partition, and holds work in one
 * queue for each account. It commits its Kafka offset at the low-water mark of the batches not yet answered.
 * A restarted or standby instance reads those batches again; the ledger's dedup makes that safe.
 */
import type { CommandEnvelope } from '@share/owner-runtime';
import {
  MOVEMENT_LINE_LIMIT, RESERVATION_BATCHES_IN_FLIGHT,
  type ChargeLine, type ChargeLineBatch, type LineAck, type PostLine, type PostMovementRequest, type PostingAck, type SplitWeights,
} from '../contracts/c06.ts';
import { isSourceRef, parseMicro, sourceRefDigest } from '../money.ts';
import { WeightsError } from '../webster.ts';
import { ledgerPartitionOfBuyer, DEFAULT_PARTITION_COUNT } from '../ledger/accounts.ts';
import { m4Entries, type WeightsSource } from '../ledger/decide.ts';
import type { LedgerAnswer, PostCall } from '../ledger/owner.ts';

/** The posting port as settlement calls it (gRPC to the owner of the home partition in production). */
export interface LedgerPort {
  post(call: PostCall): Promise<LedgerAnswer>;
}

/** Time for settlement: the clock and delayed work. Tests use a manual scheduler. */
export interface Scheduler {
  nowMs(): number;
  after(ms: number, fn: () => void): void;
}

export type SettlementAlertCode =
  | 'BATCH_OVER_LIMIT' | 'LINE_INVALID' | 'MOVEMENT_REFUSED' | 'LEDGER_STOPPED' | 'WEIGHTS_UNKNOWN' | 'USAGE_BATCH_NOT_IN_MONEY_I2'
  | 'ABANDON_NOT_IN_MONEY_I2' | 'INTEGRITY_ALERT' | 'UNEXPECTED_ANSWER' | 'POST_FAILED';
export interface SettlementAlert { code: SettlementAlertCode; account: string; batchId: string; detail: string }

export interface SettlementOptions {
  ledger: LedgerPort;
  weights: WeightsSource;
  scheduler: Scheduler;
  /** Direct publish on `settlement.posting-acks.v1` (C06 §7): refusals and settlement's own exclusions. */
  publishAcks(ack: PostingAck): Promise<void>;
  /** Commit the next offset to read of one Kafka partition (C06 M8: the low-water mark). */
  commitOffset(kafkaPartition: number, nextOffset: bigint): Promise<void>;
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
  heldUntilMs: number | undefined;
  /** After a hold, one batch tries first; the others start when it is answered. */
  probing: boolean;
}

type Prepared =
  | { kind: 'post'; request: PostMovementRequest; excluded: LineAck[] }
  | { kind: 'answered'; acks: LineAck[] }
  | { kind: 'defer'; code: SettlementAlertCode; detail: string }
  | { kind: 'hold'; code: SettlementAlertCode; detail: string };

/** True if the line is the C06 mapping row "reservation, seq 0, original → M4" of this batch. */
function lineProblem(l: ChargeLine, b: ChargeLineBatch['batch']): string | undefined {
  if (l === null || typeof l !== 'object') return 'not an object';
  if (l.lineKind !== 'reservation') return `lineKind ${String(l.lineKind)} in a reservation batch`;
  if (!isSourceRef(l.sourceRef) || l.sourceRef.kind !== 'reservation') return 'sourceRef is not a reservation SourceRef';
  if (l.sourceRef.seq !== 0) return 'an amendment in a reservation batch';
  if (l.reason !== 'original') return `reason ${String(l.reason)} on a seq 0 line`;
  if (l.cause !== undefined || l.lateCut !== undefined || l.payee !== undefined) return 'cause, lateCut or payee on an original';
  if (l.payer !== 'account') return `payer ${String(l.payer)}`;
  if (l.account !== b.account) return `account ${String(l.account)} in the batch of ${b.account}`;
  if (l.minute !== b.minute || l.sourceRef.minute !== b.minute) return `minute ${String(l.minute)} in the batch of ${String(b.minute)}`;
  if (typeof l.route !== 'string' || l.route.length === 0 || typeof l.weightsVersion !== 'string' || l.weightsVersion.length === 0) {
    return 'no route or weights version';
  }
  const amount = parseMicro(l.amount);
  const total = parseMicro(l.newTotal);
  const prior = parseMicro(l.priorTotal);
  if (amount === undefined || total === undefined || prior === undefined) return 'an amount is not an integer string';
  if (prior !== 0n || amount !== total) return 'an original has priorTotal 0 and amount = newTotal';
  // RFC-004 §B1.2: amounts are non-zero; only M23 has a nil line. A zero original cannot be posted.
  if (amount <= 0n) return `amount ${amount}: an M4 line needs a positive charge`;
  return undefined;
}

/** Map one reservation batch to its M4 request, or to settlement's own answer (C06 mapping table, V63-1, V63-3). */
export function prepareReservationBatch(batch: ChargeLineBatch, weights: WeightsSource): Prepared {
  const b = batch.batch;
  if (batch.lines.length > MOVEMENT_LINE_LIMIT) {
    return { kind: 'answered', acks: batch.lines.map((l) => ({ sourceRef: l.sourceRef, outcome: 'excluded', reason: 'batch_over_limit' })) };
  }
  if (batch.lines.some((l) => l?.abandon !== undefined)) return { kind: 'defer', code: 'ABANDON_NOT_IN_MONEY_I2', detail: 'abandon posting (MONEY-I3)' };
  const excluded: LineAck[] = [];
  const lines: PostLine[] = [];
  const seen = new Set<string>();
  for (const l of batch.lines) {
    let problem = lineProblem(l, b);
    if (problem === undefined) {
      const d = sourceRefDigest(l.sourceRef);
      if (seen.has(d)) problem = 'the SourceRef is twice in the batch';
      seen.add(d);
    }
    if (problem !== undefined) {
      excluded.push({ sourceRef: l.sourceRef, outcome: 'excluded', reason: 'invalid' });
      continue;
    }
    let w: SplitWeights | undefined;
    w = weights.find(l.route!, l.weightsVersion!);
    if (!w) return { kind: 'hold', code: 'WEIGHTS_UNKNOWN', detail: `no split weights ${l.route}/${l.weightsVersion}` };
    let entries: Array<{ ledgerAccount: string; amount: string }>;
    try {
      entries = m4Entries(b.account, parseMicro(l.amount)!, w);
    } catch (e) {
      if (e instanceof WeightsError) return { kind: 'hold', code: 'WEIGHTS_UNKNOWN', detail: e.message };
      throw e;
    }
    lines.push({
      kind: 'M4', lineRef: l.sourceRef, lineKind: 'reservation', payer: 'account', reason: 'original', amendmentSeq: 0,
      priorTotal: l.priorTotal, newTotal: l.newTotal, split: { route: l.route!, weightsVersion: l.weightsVersion!, mode: 'normal' },
      ...(l.triggerRef !== undefined ? { triggerRef: l.triggerRef } : {}),
      entries,
    });
  }
  if (lines.length === 0) return { kind: 'answered', acks: excluded };
  return {
    kind: 'post', excluded,
    request: {
      // P4-S71: the movement refers to the charge-line batch that caused it.
      movementRef: b.id, cause: `charge-line batch ${b.id}`, currency: 'USD',
      // C06 V63-1: rating's lineCount less the lines that settlement excluded; never a count of what is sent.
      batch: { id: b.id, kind: 'reservation', lineCount: b.lineCount - excluded.length },
      lines,
    },
  };
}

export class Settlement {
  readonly alerts: SettlementAlert[] = [];
  /** The offset committed for each Kafka partition. */
  readonly committed = new Map<number, bigint>();
  private readonly o: SettlementOptions;
  private readonly principal: string;
  private readonly partitionCount: number;
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
  }

  /** One record of `rating.charge-lines.v1` that is a charge-line batch. It never waits on the ledger. */
  receive(src: { partition: number; offset: bigint }, batch: ChargeLineBatch): void {
    this.track(src);
    const account = batch.batch.account;
    let q = this.accounts.get(account);
    if (!q) { q = { queue: [], inFlight: 0, heldUntilMs: undefined, probing: false }; this.accounts.set(account, q); }
    if (batch.batch.kind !== 'reservation') {
      // MONEY-I3 posts usage batches. Until then a usage batch stays unanswered, below the low-water mark.
      this.alert({ code: 'USAGE_BATCH_NOT_IN_MONEY_I2', account, batchId: batch.batch.id, detail: 'usage batch held unanswered' });
      return;
    }
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
      const item = q.queue.shift()!;
      q.inFlight += 1;
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

  private async settle(account: string, q: AccountQueue, item: Item): Promise<void> {
    const b = item.batch.batch;
    let retryIn: number | undefined;
    let held = false;
    try {
      const p = prepareReservationBatch(item.batch, this.o.weights);
      if (p.kind === 'defer') {
        this.alert({ code: p.code, account, batchId: b.id, detail: p.detail });
        return;
      }
      if (p.kind === 'hold') {
        this.alert({ code: p.code, account, batchId: b.id, detail: p.detail });
        held = true;
        this.hold(account, q, item, HOLD_RETRY_MS);
        return;
      }
      if (p.kind === 'answered') {
        if (p.acks.some((a) => a.outcome === 'excluded' && a.reason === 'batch_over_limit')) {
          this.alert({ code: 'BATCH_OVER_LIMIT', account, batchId: b.id, detail: `${item.batch.lines.length} lines` });
        }
        await this.publish(account, b.id, p.acks);
        this.answered(item.src);
        return;
      }
      if (p.excluded.length > 0 && !item.excludedPublished) {
        this.alert({ code: 'LINE_INVALID', account, batchId: b.id, detail: `${p.excluded.length} line(s) excluded invalid` });
        await this.publish(account, b.id, p.excluded);
        item.excludedPublished = true;
      }
      const partition = ledgerPartitionOfBuyer(account, this.partitionCount);
      const envelope = this.o.envelope?.(partition, p.request.movementRef);
      const answer = await this.o.ledger.post({ partition, principal: this.principal, request: p.request, ...(envelope ? { envelope } : {}) });
      switch (answer.result) {
        case 'committed':
          q.probing = false;
          if (answer.integrityAlert) this.alert({ code: 'INTEGRITY_ALERT', account, batchId: b.id, detail: 'the ledger answered with integrityAlert' });
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
          this.alert({ code: 'UNEXPECTED_ANSWER', account, batchId: b.id, detail: 'refused_batch for a reservation batch' });
          held = true;
          this.hold(account, q, item, HOLD_RETRY_MS);
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
      if (retryIn !== undefined) {
        if (retryIn === 0) q.queue.unshift(item);
        else { held = true; this.hold(account, q, item, retryIn); }
      }
      if (!held) this.pump(account);
    }
  }
}
