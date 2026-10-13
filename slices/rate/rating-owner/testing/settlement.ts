/**
 * The settlement and ledger double: the provider side of C06 §7 (posting acknowledgement) and
 * §8 (ledger posting port), built from the C06 schema and semantics (plan §4, risk P-5). It does
 * not use the code of the RFC-004 team.
 *
 * It implements the parts that rating's I1 output reaches: the mapping row "usage, seq 0,
 * original → M5", whole usage batches (D1), dedup of each line by its canonical SourceRef
 * (M2), `priorTotal` and sequence checks, `lineCount`, and the posted acknowledgement with the
 * ledger position. Fault injection: refuse a batch whole, or exclude a line.
 */
import { hlc } from '@share/owner-runtime';
import {
  canonicalSourceRefBytes, checkChargeLineBatch, lineKeyOf, sourceRefDigest,
  type ChargeLine, type ChargeLineBatch, type LedgerPosition, type LineAck, type MovementKind, type PostMovementRequest,
  type PostMovementResponse, type PostingAck, type SourceRef,
} from '@share/rate-common';
import { createHash } from 'node:crypto';
import type { CatalogueReplica } from '../src/catalogue/replica.ts';
import { TOPIC_CHARGES, TOPIC_POSTING_ACKS } from '../src/declarations.ts';
import type { Bus } from './bus.ts';

export interface MovementRecord {
  movementId: string;
  movementRef: string;
  position: LedgerPosition;
  home: { account: string };
  batch?: { id: string; kind: 'reservation' | 'usage'; whole?: boolean };
  lines: Array<{ lineRef: SourceRef; kind: MovementKind; amount: string; postedTotal: string;
    entries: Array<{ ledgerAccount: string; amount: string }> }>;
}

interface PostedLine { digest: string; content: string; total: bigint; seq: number; position: LedgerPosition; movementId: string }

/** The ledger: one partition for each buyer home (here `L:<account>`), insert-only movements. */
export class LedgerDouble {
  readonly movements: MovementRecord[] = [];
  private readonly bySourceRef = new Map<string, PostedLine>();
  private readonly lineTotals = new Map<string, { total: bigint; lastSeq: number; position: LedgerPosition; movementId: string }>();
  private readonly answers = new Map<string, { digest: string; answer: PostMovementResponse }>();
  private readonly seqs = new Map<string, bigint>();
  private readonly listeners: Array<(m: MovementRecord) => void> = [];
  private logical = 0;
  readonly integrityAlerts: string[] = [];
  private readonly clock: () => number;

  constructor(clock: () => number) {
    this.clock = clock;
  }

  onMovement(l: (m: MovementRecord) => void): void {
    this.listeners.push(l);
  }

  static home(account: string): string {
    return `L:${account}`;
  }

  /** C06 §8 `post`, for charge batches. Answers only after "commit" (here: in memory). */
  post(req: PostMovementRequest, account: string): PostMovementResponse {
    const digest = createHash('sha256').update(JSON.stringify(req)).digest('hex');
    const prior = this.answers.get(req.movementRef);
    if (prior) {
      if (prior.digest !== digest) this.integrityAlerts.push(`movementRef ${req.movementRef} with a different digest`);
      return prior.digest === digest ? prior.answer : ({ ...prior.answer, integrityAlert: true } as PostMovementResponse);
    }
    if (req.batch && req.lines.length !== req.batch.lineCount) return { result: 'refused', reason: 'invalid', detail: 'lineCount' };
    for (const l of req.lines) {
      const sum = l.entries.reduce((n, e) => n + BigInt(e.amount), 0n);
      if (sum !== 0n || l.entries.some((e) => e.amount === '0')) return { result: 'refused', reason: 'invalid', detail: 'entries' };
    }
    const problems: Array<{ lineRef: SourceRef; problem: 'conflict' | 'prior_total_mismatch' | 'out_of_sequence' | 'invalid';
      of?: string; ledgerPostedTotal?: string; ledgerLastSeq?: number; ledgerPosition?: LedgerPosition }> = [];
    const outcomes: Array<'posted' | 'duplicate'> = [];
    for (const l of req.lines) {
      const ref = l.lineRef as SourceRef;
      const d = sourceRefDigest(ref);
      const content = contentOf(l);
      const seen = this.bySourceRef.get(d);
      if (seen) {
        if (seen.content === content) { outcomes.push('duplicate'); continue; }
        this.integrityAlerts.push(`content conflict on ${d}`);
        // C06 §7: rating re-bases on ledgerPostedTotal and puts the posting at ledgerPosition for P_X.
        problems.push({ lineRef: ref, problem: 'conflict', of: seen.movementId, ledgerPostedTotal: seen.total.toString(), ledgerLastSeq: seen.seq,
          ledgerPosition: seen.position });
        continue;
      }
      const lt = this.lineTotals.get(lineKeyOf(ref));
      const seq = 'seq' in ref ? ref.seq : 0;
      if (BigInt(l.priorTotal ?? '0') !== (lt?.total ?? 0n)) {
        problems.push({ lineRef: ref, problem: 'prior_total_mismatch', ledgerPostedTotal: (lt?.total ?? 0n).toString(), ledgerLastSeq: lt?.lastSeq ?? -1,
          ...(lt ? { of: lt.movementId, ledgerPosition: lt.position } : {}) });
        continue;
      }
      if (seq !== (lt ? lt.lastSeq + 1 : 0)) { problems.push({ lineRef: ref, problem: 'out_of_sequence' }); continue; }
      outcomes.push('posted');
    }
    if (problems.length > 0) {
      // D1: a usage batch is refused whole; nothing is posted.
      const answer: PostMovementResponse = { result: 'refused_batch', lines: problems };
      this.answers.set(req.movementRef, { digest, answer });
      return answer;
    }
    const home = LedgerDouble.home(account);
    const seq = (this.seqs.get(home) ?? 0n) + 1n;
    this.seqs.set(home, seq);
    this.logical += 1;
    const position: LedgerPosition = { ledgerPartition: home, sequence: seq.toString(),
      commitTs: hlc(`${BigInt(this.clock()) * 1_000_000n}.${String(this.logical).padStart(10, '0')}`) };
    const movementId = `${home}/${seq}`;
    const lines: MovementRecord['lines'] = [];
    req.lines.forEach((l, i) => {
      const ref = l.lineRef as SourceRef;
      if (outcomes[i] === 'posted') {
        const d = sourceRefDigest(ref);
        const total = BigInt(l.newTotal ?? '0');
        this.bySourceRef.set(d, { digest: d, content: contentOf(l), total, seq: 'seq' in ref ? ref.seq : 0, position, movementId });
        this.lineTotals.set(lineKeyOf(ref), { total, lastSeq: 'seq' in ref ? ref.seq : 0, position, movementId });
        lines.push({ lineRef: ref, kind: l.kind, amount: l.entries.find((e) => e.ledgerAccount.startsWith('B:'))?.amount ?? '0',
          postedTotal: total.toString(), entries: l.entries });
      }
    });
    const m: MovementRecord = { movementId, movementRef: req.movementRef, position, home: { account }, lines,
      ...(req.batch ? { batch: { id: req.batch.id, kind: req.batch.kind, ...(req.batch.kind === 'usage' ? { whole: true } : {}) } } : {}) };
    this.movements.push(m);
    const answer: PostMovementResponse = {
      result: 'committed', movementId, postingTime: position.commitTs, position, whole: req.batch?.kind === 'usage' ? true : undefined,
      lines: req.lines.map((l, i) => {
        const ref = l.lineRef as SourceRef;
        if (outcomes[i] === 'duplicate') {
          const seen = this.bySourceRef.get(sourceRefDigest(ref)) as PostedLine;
          return { lineRef: ref, outcome: 'duplicate' as const, of: seen.movementId, ledgerPosition: seen.position };
        }
        return { lineRef: ref, outcome: 'posted' as const };
      }),
    } as PostMovementResponse;
    this.answers.set(req.movementRef, { digest, answer });
    for (const fn of this.listeners) fn(m);
    return answer;
  }

  postedTotal(ref: SourceRef): bigint | undefined {
    return this.bySourceRef.get(sourceRefDigest(ref))?.total;
  }
}

/** The fields the ledger compares (C06 §8 "Per-line checks" step 1). */
function contentOf(l: PostMovementRequest['lines'][number]): string {
  return JSON.stringify([l.lineKind, l.entries.find((e) => e.ledgerAccount.startsWith('B:'))?.amount, l.newTotal, l.priorTotal,
    l.payer, l.payee, l.split?.route, l.split?.weightsVersion, l.reason, l.cause, l.lateCut, l.triggerRef]);
}

/** Settlement: consumes charge-line batches, posts each as one movement, publishes the acknowledgements. */
export class SettlementDouble {
  readonly received: ChargeLineBatch[] = [];
  readonly schemaErrors: string[] = [];
  readonly requests: PostMovementRequest[] = [];
  /** Fault injection: the next batch is answered with these line acknowledgements instead of a post. */
  private readonly scripted: Array<(b: ChargeLineBatch) => LineAck[]> = [];
  private ackSeq = 0n;
  private readonly bus: Bus;
  private readonly catalogue: CatalogueReplica;
  readonly ledger: LedgerDouble;

  constructor(bus: Bus, catalogue: CatalogueReplica, ledger: LedgerDouble) {
    this.bus = bus;
    this.catalogue = catalogue;
    this.ledger = ledger;
    bus.on(TOPIC_CHARGES, (ev) => this.onBatch(ev as ChargeLineBatch));
  }

  scriptAcks(fn: (b: ChargeLineBatch) => LineAck[]): void {
    this.scripted.push(fn);
  }

  /** The mapping row (C06 "Settlement mapping"); I1 output reaches only the M5 row. */
  static movementKind(l: ChargeLine): MovementKind | 'invalid' {
    const seq = 'seq' in l.sourceRef ? l.sourceRef.seq : 0;
    if (l.lineKind === 'usage' && seq === 0 && l.reason === 'original' && l.payer === 'account' && !l.cause && !l.abandon) return 'M5';
    return 'invalid';
  }

  /** split(amount) by the weights of the version (floor for each supplier, the remainder to commission). */
  private split(l: ChargeLine): Array<{ ledgerAccount: string; amount: string }> {
    const w = this.catalogue.weightsVersion(l.weightsVersion ?? '');
    const amount = BigInt(l.amount);
    if (!w) return [];
    const total = BigInt(w.legs.reduce((n, x) => n + x.weight, 0) + w.commissionWeight);
    const shares = w.legs.map((x) => ({ ledgerAccount: `S:${x.supplier}:earn`, amount: (amount * BigInt(x.weight)) / total }));
    const rest = amount - shares.reduce((n, s) => n + s.amount, 0n);
    return [...shares, { ledgerAccount: 'SH:commission', amount: rest }]
      .filter((s) => s.amount !== 0n).map((s) => ({ ledgerAccount: s.ledgerAccount, amount: s.amount.toString() }));
  }

  private async onBatch(b: ChargeLineBatch): Promise<void> {
    this.received.push(b);
    this.schemaErrors.push(...checkChargeLineBatch(b));
    for (const l of b.lines) canonicalSourceRefBytes(l.sourceRef);
    const scripted = this.scripted.shift();
    if (scripted) { await this.publishAck(b, scripted(b)); return; }
    const invalid = b.lines.filter((l) => SettlementDouble.movementKind(l) === 'invalid' || !this.catalogue.weightsVersion(l.weightsVersion ?? ''));
    if (invalid.length > 0 && b.batch.kind === 'usage') {
      await this.publishAck(b, b.lines.map((l) => (invalid.includes(l)
        ? { sourceRef: l.sourceRef, outcome: 'excluded' as const, reason: 'invalid' as const }
        : { sourceRef: l.sourceRef, outcome: 'excluded' as const, reason: 'batch_refused' as const })));
      return;
    }
    const req: PostMovementRequest = {
      movementRef: b.batch.id, cause: `charge batch ${b.batch.id}`, currency: 'USD',
      batch: { id: b.batch.id, kind: b.batch.kind, lineCount: b.batch.lineCount },
      lines: b.lines.map((l) => ({
        kind: SettlementDouble.movementKind(l) as MovementKind, lineRef: l.sourceRef, lineKind: l.lineKind, payer: l.payer,
        reason: l.reason, amendmentSeq: 'seq' in l.sourceRef ? l.sourceRef.seq : 0, priorTotal: l.priorTotal, newTotal: l.newTotal,
        split: { route: l.route as string, weightsVersion: l.weightsVersion as string, mode: 'normal' as const },
        entries: [{ ledgerAccount: `B:${l.account}`, amount: (-BigInt(l.amount)).toString() }, ...this.split(l)],
      })),
    };
    this.requests.push(req);
    const ans = this.ledger.post(req, b.batch.account);
    if (ans.result === 'committed') {
      // The ledger publishes these from its outbox (C06 §7); the double publishes them here.
      await this.publishAck(b, ans.lines.map((x, i): LineAck => {
        const l = b.lines[i] as ChargeLine;
        const pos = x.outcome === 'duplicate' && x.ledgerPosition ? x.ledgerPosition : ans.position;
        return { sourceRef: l.sourceRef, outcome: 'posted', duplicate: x.outcome === 'duplicate', position: pos,
          movementId: x.of ?? ans.movementId, postedAmount: l.amount,
          postedTotal: (this.ledger.postedTotal(l.sourceRef) ?? 0n).toString() };
      }));
    } else if (ans.result === 'refused_batch') {
      const bad = new Map(ans.lines.map((x) => [sourceRefDigest(x.lineRef), x]));
      await this.publishAck(b, b.lines.map((l): LineAck => {
        const p = bad.get(sourceRefDigest(l.sourceRef));
        if (!p) return { sourceRef: l.sourceRef, outcome: 'excluded', reason: 'batch_refused' };
        const reason = p.problem === 'conflict' ? 'content_conflict' as const : p.problem;
        return { sourceRef: l.sourceRef, outcome: 'excluded', reason,
          ...(p.of === undefined ? {} : { conflictOf: p.of }),
          ...(p.ledgerPostedTotal === undefined ? {} : { ledgerPostedTotal: p.ledgerPostedTotal }),
          ...(p.ledgerLastSeq === undefined ? {} : { ledgerLastSeq: p.ledgerLastSeq }),
          ...(p.ledgerPosition === undefined ? {} : { ledgerPosition: p.ledgerPosition }) };
      }));
    }
  }

  private async publishAck(b: ChargeLineBatch, lines: LineAck[]): Promise<void> {
    this.ackSeq += 1n;
    const ack: PostingAck = {
      type: 'PostingAck', schemaVersion: 1,
      eventId: { partition: b.batch.account, stream: 'posting_acks', streamSeq: this.ackSeq.toString(), generation: 0, epoch: 1 },
      account: b.batch.account, batchId: b.batch.id, lines,
    };
    await this.bus.publish(TOPIC_POSTING_ACKS, b.batch.account, 'posting_acks', ack);
  }
}
