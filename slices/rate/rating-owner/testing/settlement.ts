/**
 * The settlement and ledger double: the provider side of C06 §7 (posting acknowledgement) and
 * §8 (ledger posting port), built from the C06 schema and semantics (plan §4, risk P-5). It does
 * not use the code of the RFC-004 team.
 *
 * It implements the parts that rating's output reaches and the reservation-batch suite: the mapping
 * rows "reservation, seq 0, original → M4", "usage, seq 0, original → M5" and "usage, seq > 0,
 * late_traffic, amount > 0 → M6"; whole usage batches (D1) and per-line exclusion in reservation
 * batches; dedup of each line by its canonical SourceRef (M2); `priorTotal` and sequence checks;
 * `lineCount`; the movement limit (V63-3); the M4 template by the Webster split of RFC-004 §B3.2; and
 * the posted acknowledgement with the ledger position. Fault injection: refuse a batch whole, or
 * exclude a line.
 */
import { hlc } from '@share/owner-runtime';
import {
  MOVEMENT_LIMIT, canonicalSourceRefBytes, checkChargeLineBatch, lineKeyOf, sourceRefDigest,
  type CatalogueEntity, type ChargeLine, type ChargeLineBatch, type LedgerPosition, type LineAck, type LineProblem, type MovementKind,
  type PostMovementRequest, type PostMovementResponse, type PostingAck, type Reason, type SourceRef,
} from '@share/rate-common';
import { createHash } from 'node:crypto';
import type { CatalogueReplica } from '../src/catalogue/replica.ts';
import { TOPIC_CHARGES, TOPIC_POSTING_ACKS } from '../src/declarations.ts';
import type { Bus } from './bus.ts';

type SplitWeights = Extract<CatalogueEntity, { entityType: 'split_weights' }>;

export interface MovementRecord {
  movementId: string;
  movementRef: string;
  position: LedgerPosition;
  home: { account: string };
  batch?: { id: string; kind: 'reservation' | 'usage'; whole?: boolean };
  lines: Array<{ lineRef: SourceRef; kind: MovementKind; amount: string; postedTotal: string; reason?: Reason; triggerRef?: string;
    entries: Array<{ ledgerAccount: string; amount: string }> }>;
}

interface PostedLine { digest: string; content: string; total: bigint; seq: number; position: LedgerPosition; movementId: string }

type Problem = { lineRef: SourceRef; problem: LineProblem; of?: string; ledgerPostedTotal?: string; ledgerLastSeq?: number;
  ledgerPosition?: LedgerPosition };

/**
 * The Webster split of RFC-004 §B3.2: the rounding state round(n·w_i/W), halves up, then units added to the
 * largest w_i/(2s_i + 1) (ties: earliest) or taken from the smallest w_i/(2s_i − 1) (ties: latest). Parties
 * are in tie order: suppliers by their first leg, Share's commission last.
 */
export function websterSplit(n: bigint, weights: bigint[]): bigint[] {
  const W = weights.reduce((a, b) => a + b, 0n);
  const s = weights.map((w) => (2n * n * w + W) / (2n * W));
  let sum = s.reduce((a, b) => a + b, 0n);
  while (sum < n) {
    let best = 0;
    for (let i = 1; i < s.length; i++) {
      if ((weights[i] as bigint) * (2n * (s[best] as bigint) + 1n) > (weights[best] as bigint) * (2n * (s[i] as bigint) + 1n)) best = i;
    }
    s[best] = (s[best] as bigint) + 1n;
    sum += 1n;
  }
  while (sum > n) {
    let pick = -1;
    for (let i = 0; i < s.length; i++) {
      if ((s[i] as bigint) === 0n) continue;
      if (pick < 0 || (weights[i] as bigint) * (2n * (s[pick] as bigint) - 1n) <= (weights[pick] as bigint) * (2n * (s[i] as bigint) - 1n)) pick = i;
    }
    s[pick] = (s[pick] as bigint) - 1n;
    sum -= 1n;
  }
  return s;
}

/** The parties of a weights version in tie order: one per supplier (legs summed), then the commission. */
function parties(w: SplitWeights): Array<{ ledgerAccount: string; weight: bigint }> {
  const bySupplier = new Map<string, bigint>();
  for (const l of w.legs) bySupplier.set(l.supplier, (bySupplier.get(l.supplier) ?? 0n) + BigInt(l.weight));
  return [...[...bySupplier].map(([s, weight]) => ({ ledgerAccount: `S:${s}:earn`, weight })),
    { ledgerAccount: 'SH:commission', weight: BigInt(w.commissionWeight) }];
}

/** The M4 entries of a reservation line of `a` micro-USD: `B −a`, then each party's Webster share that is not 0. */
export function m4Entries(account: string, a: bigint, w: SplitWeights): Array<{ ledgerAccount: string; amount: string }> {
  const ps = parties(w);
  const shares = websterSplit(a, ps.map((p) => p.weight));
  return [{ ledgerAccount: `B:${account}`, amount: (-a).toString() },
    ...ps.flatMap((p, i) => (shares[i] === 0n ? [] : [{ ledgerAccount: p.ledgerAccount, amount: (shares[i] as bigint).toString() }]))];
}

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
  private readonly weightsOf: ((version: string) => SplitWeights | undefined) | undefined;

  /** `weightsOf` lets the ledger check M4 entries against the template of the line's weights (C06 §8 check 2). */
  constructor(clock: () => number, weightsOf?: (version: string) => SplitWeights | undefined) {
    this.clock = clock;
    this.weightsOf = weightsOf;
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
    if (req.lines.length > MOVEMENT_LIMIT) {
      // V63-3: refused whole; the answer is recorded and returned on a repeat.
      const answer: PostMovementResponse = { result: 'refused', reason: 'over_limit', detail: `${req.lines.length} lines > ${MOVEMENT_LIMIT}` };
      this.answers.set(req.movementRef, { digest, answer });
      return answer;
    }
    if (req.batch && req.lines.length !== req.batch.lineCount) return { result: 'refused', reason: 'invalid', detail: 'lineCount' };
    for (const l of req.lines) {
      const sum = l.entries.reduce((n, e) => n + BigInt(e.amount), 0n);
      if (sum !== 0n || l.entries.some((e) => e.amount === '0')) return { result: 'refused', reason: 'invalid', detail: 'entries' };
    }
    const reservation = req.batch?.kind === 'reservation';
    const problems = new Map<number, Problem>();
    const outcomes: Array<'posted' | 'duplicate' | 'excluded'> = [];
    req.lines.forEach((l, i) => {
      const ref = l.lineRef as SourceRef;
      const d = sourceRefDigest(ref);
      const seen = this.bySourceRef.get(d);
      if (seen) {
        if (seen.content === contentOf(l)) { outcomes.push('duplicate'); return; }
        this.integrityAlerts.push(`content conflict on ${d}`);
        // C06 §7: rating re-bases on ledgerPostedTotal and puts the posting at ledgerPosition for P_X.
        problems.set(i, { lineRef: ref, problem: 'conflict', of: seen.movementId, ledgerPostedTotal: seen.total.toString(), ledgerLastSeq: seen.seq,
          ledgerPosition: seen.position });
        outcomes.push('excluded');
        return;
      }
      const lt = this.lineTotals.get(lineKeyOf(ref));
      const seq = 'seq' in ref ? ref.seq : 0;
      if (BigInt(l.priorTotal ?? '0') !== (lt?.total ?? 0n)) {
        problems.set(i, { lineRef: ref, problem: 'prior_total_mismatch', ledgerPostedTotal: (lt?.total ?? 0n).toString(), ledgerLastSeq: lt?.lastSeq ?? -1,
          ...(lt ? { of: lt.movementId, ledgerPosition: lt.position } : {}) });
      } else if (seq !== (lt ? lt.lastSeq + 1 : 0)) {
        problems.set(i, { lineRef: ref, problem: 'out_of_sequence' });
      } else if (l.kind === 'M4' && this.weightsOf && !this.followsM4Template(l, account)) {
        problems.set(i, { lineRef: ref, problem: 'invalid' });
      }
      outcomes.push(problems.has(i) ? 'excluded' : 'posted');
    });
    if (problems.size > 0 && !reservation) {
      // D1: a usage batch is refused whole; nothing is posted.
      const answer: PostMovementResponse = { result: 'refused_batch', lines: [...problems.values()] };
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
      if (outcomes[i] !== 'posted') return;
      const ref = l.lineRef as SourceRef;
      const d = sourceRefDigest(ref);
      const total = BigInt(l.newTotal ?? '0');
      this.bySourceRef.set(d, { digest: d, content: contentOf(l), total, seq: 'seq' in ref ? ref.seq : 0, position, movementId });
      this.lineTotals.set(lineKeyOf(ref), { total, lastSeq: 'seq' in ref ? ref.seq : 0, position, movementId });
      lines.push({ lineRef: ref, kind: l.kind, amount: l.entries.find((e) => e.ledgerAccount.startsWith('B:'))?.amount ?? '0',
        postedTotal: total.toString(), ...(l.reason ? { reason: l.reason } : {}), ...(l.triggerRef ? { triggerRef: l.triggerRef } : {}),
        entries: l.entries });
    });
    const m: MovementRecord = { movementId, movementRef: req.movementRef, position, home: { account }, lines,
      ...(req.batch ? { batch: { id: req.batch.id, kind: req.batch.kind, ...(req.batch.kind === 'usage' ? { whole: true } : {}) } } : {}) };
    this.movements.push(m);
    const answer: PostMovementResponse = {
      result: 'committed', movementId, postingTime: position.commitTs, position, whole: req.batch?.kind === 'usage' ? true : undefined,
      lines: req.lines.map((l, i) => {
        const ref = l.lineRef as SourceRef;
        const p = problems.get(i);
        if (p) {
          return { lineRef: ref, outcome: 'excluded' as const, problem: p.problem,
            ...(p.of === undefined ? {} : { of: p.of }),
            ...(p.ledgerPostedTotal === undefined ? {} : { ledgerPostedTotal: p.ledgerPostedTotal }),
            ...(p.ledgerLastSeq === undefined ? {} : { ledgerLastSeq: p.ledgerLastSeq }),
            ...(p.ledgerPosition === undefined ? {} : { ledgerPosition: p.ledgerPosition }) };
        }
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

  private followsM4Template(l: PostMovementRequest['lines'][number], account: string): boolean {
    const w = l.split ? this.weightsOf?.(l.split.weightsVersion) : undefined;
    if (!w) return false;
    return JSON.stringify(l.entries) === JSON.stringify(m4Entries(account, BigInt(l.newTotal ?? '0'), w));
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

const seqOf = (l: ChargeLine): number => ('seq' in l.sourceRef ? l.sourceRef.seq : 0);

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

  /** The mapping rows (C06 "Settlement mapping") that rating's output and the suites reach; every other combination is invalid. */
  static movementKind(l: ChargeLine): MovementKind | 'invalid' {
    const seq = seqOf(l);
    const plain = l.payer === 'account' && !l.cause && !l.abandon;
    if (l.lineKind === 'reservation' && seq === 0 && l.reason === 'original' && plain) return 'M4';
    if (l.lineKind === 'usage' && seq === 0 && l.reason === 'original' && plain) return 'M5';
    if (l.lineKind === 'usage' && seq > 0 && l.reason === 'late_traffic' && BigInt(l.amount) > 0n && l.payer === 'account' && !l.abandon) return 'M6';
    return 'invalid';
  }

  /** split(amount) by the weights of the version (floor for each supplier, the remainder to commission). */
  private split(amount: bigint, weightsVersion: string): Map<string, bigint> {
    const w = this.catalogue.weightsVersion(weightsVersion);
    const out = new Map<string, bigint>();
    if (!w) return out;
    const total = BigInt(w.legs.reduce((n, x) => n + x.weight, 0) + w.commissionWeight);
    for (const x of w.legs) out.set(`S:${x.supplier}:earn`, (out.get(`S:${x.supplier}:earn`) ?? 0n) + (amount * BigInt(x.weight)) / total);
    out.set('SH:commission', amount - [...out.values()].reduce((n, s) => n + s, 0n));
    return out;
  }

  /** The entries of a line by its movement kind: M4 by the Webster template; M5 `split(amount)`; M6 `split(newTotal) − split(priorTotal)`. */
  private entries(l: ChargeLine, kind: MovementKind): Array<{ ledgerAccount: string; amount: string }> {
    const buyer = { ledgerAccount: `B:${l.account}`, amount: (-BigInt(l.amount)).toString() };
    if (kind === 'M4') {
      const w = this.catalogue.weightsVersion(l.weightsVersion ?? '');
      return w ? m4Entries(l.account, BigInt(l.amount), w) : [buyer];
    }
    const now = this.split(BigInt(kind === 'M6' ? l.newTotal : l.amount), l.weightsVersion ?? '');
    const before = kind === 'M6' ? this.split(BigInt(l.priorTotal), l.weightsVersion ?? '') : new Map<string, bigint>();
    return [buyer, ...[...now].map(([a, v]) => ({ ledgerAccount: a, amount: v - (before.get(a) ?? 0n) }))
      .filter((e) => e.amount !== 0n).map((e) => ({ ledgerAccount: e.ledgerAccount, amount: e.amount.toString() }))];
  }

  private async onBatch(b: ChargeLineBatch): Promise<void> {
    this.received.push(b);
    this.schemaErrors.push(...checkChargeLineBatch(b));
    for (const l of b.lines) canonicalSourceRefBytes(l.sourceRef);
    const scripted = this.scripted.shift();
    if (scripted) { await this.publishAck(b, scripted(b)); return; }
    if (b.lines.length > MOVEMENT_LIMIT) {
      // V63-3: settlement refuses any larger charge batch whole and acknowledges each line batch_over_limit directly.
      await this.publishAck(b, b.lines.map((l) => ({ sourceRef: l.sourceRef, outcome: 'excluded' as const, reason: 'batch_over_limit' as const })));
      return;
    }
    const invalid = b.lines.filter((l) => SettlementDouble.movementKind(l) === 'invalid' || !this.catalogue.weightsVersion(l.weightsVersion ?? ''));
    if (invalid.length > 0 && b.batch.kind === 'usage') {
      await this.publishAck(b, b.lines.map((l) => (invalid.includes(l)
        ? { sourceRef: l.sourceRef, outcome: 'excluded' as const, reason: 'invalid' as const }
        : { sourceRef: l.sourceRef, outcome: 'excluded' as const, reason: 'batch_refused' as const })));
      return;
    }
    // A reservation batch: settlement removes each invalid line, acknowledges it invalid and sends the others.
    const invalidAcks: LineAck[] = invalid.map((l) => ({ sourceRef: l.sourceRef, outcome: 'excluded', reason: 'invalid' }));
    const send = b.lines.filter((l) => !invalid.includes(l));
    if (send.length === 0) { await this.publishAck(b, invalidAcks); return; }
    const req: PostMovementRequest = {
      movementRef: b.batch.id, cause: `charge batch ${b.batch.id}`, currency: 'USD',
      batch: { id: b.batch.id, kind: b.batch.kind, lineCount: send.length },
      lines: send.map((l) => {
        const kind = SettlementDouble.movementKind(l) as MovementKind;
        return {
          kind, lineRef: l.sourceRef, lineKind: l.lineKind, payer: l.payer,
          reason: l.reason, amendmentSeq: seqOf(l), priorTotal: l.priorTotal, newTotal: l.newTotal,
          ...(l.triggerRef ? { triggerRef: l.triggerRef } : {}),
          split: { route: l.route as string, weightsVersion: l.weightsVersion as string, mode: 'normal' as const },
          entries: this.entries(l, kind),
        };
      }),
    };
    this.requests.push(req);
    const ans = this.ledger.post(req, b.batch.account);
    if (ans.result === 'committed') {
      // The ledger publishes these from its outbox (C06 §7); the double publishes them here.
      await this.publishAck(b, [...invalidAcks, ...ans.lines.map((x, i): LineAck => {
        const l = send[i] as ChargeLine;
        if (x.outcome === 'excluded') return excludedAck(l.sourceRef, x);
        const pos = x.outcome === 'duplicate' && x.ledgerPosition ? x.ledgerPosition : ans.position;
        return { sourceRef: l.sourceRef, outcome: 'posted', duplicate: x.outcome === 'duplicate', position: pos,
          movementId: x.of ?? ans.movementId, postedAmount: l.amount,
          postedTotal: (this.ledger.postedTotal(l.sourceRef) ?? 0n).toString() };
      })]);
    } else if (ans.result === 'refused_batch') {
      const bad = new Map(ans.lines.map((x) => [sourceRefDigest(x.lineRef), x]));
      await this.publishAck(b, b.lines.map((l): LineAck => {
        const p = bad.get(sourceRefDigest(l.sourceRef));
        return p ? excludedAck(l.sourceRef, p) : { sourceRef: l.sourceRef, outcome: 'excluded', reason: 'batch_refused' };
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

/** The excluded acknowledgement of a line problem (C06 §7: `conflict` is acknowledged `content_conflict`). */
function excludedAck(sourceRef: SourceRef, p: { problem?: LineProblem; of?: string; ledgerPostedTotal?: string; ledgerLastSeq?: number;
  ledgerPosition?: LedgerPosition }): LineAck {
  const reason = p.problem === 'conflict' ? 'content_conflict' as const : (p.problem ?? 'invalid');
  return { sourceRef, outcome: 'excluded', reason,
    ...(p.of === undefined ? {} : { conflictOf: p.of }),
    ...(p.ledgerPostedTotal === undefined ? {} : { ledgerPostedTotal: p.ledgerPostedTotal }),
    ...(p.ledgerLastSeq === undefined ? {} : { ledgerLastSeq: p.ledgerLastSeq }),
    ...(p.ledgerPosition === undefined ? {} : { ledgerPosition: p.ledgerPosition }) };
}
