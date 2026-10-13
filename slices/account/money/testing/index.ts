/**
 * @share/money/testing: fixtures and a test world for the ledger and settlement. The C06 fixtures are recorded
 * messages of the frozen contract (catalogue split weights, CT-R reservation batches); they are not in a
 * production image. The world runs the real ledger and settlement on the C01 runtime double.
 */
import { readFileSync } from 'node:fs';
import { RuntimeDouble } from '@share/owner-runtime/testing';
import type { ChargeLine, ChargeLineBatch, LineAck, PostMovementRequest, PostingAck, SplitWeights } from '../src/contracts/c06.ts';
import { TOPIC } from '../src/contracts/c06.ts';
import { SplitWeightsReplica } from '../src/catalogue.ts';
import { ledgerDeclaration, LEDGER_TABLE } from '../src/ledger/declaration.ts';
import { LedgerOwner, recordOf, type LedgerAnswer } from '../src/ledger/owner.ts';
import type { BalanceRecord } from '../src/ledger/decide.ts';
import { ledgerPartitionOfBuyer } from '../src/ledger/accounts.ts';
import { Settlement, type LedgerPort, type Scheduler, type SettlementOptions } from '../src/settlement/settlement.ts';

/** Virtual time: `advance` runs the work that is due, in time order. */
export class ManualScheduler implements Scheduler {
  private now: number;
  private readonly due: Array<{ at: number; n: number; fn: () => void }> = [];
  private n = 0;

  constructor(startMs = 0) {
    this.now = startMs;
  }

  nowMs(): number {
    return this.now;
  }

  after(ms: number, fn: () => void): void {
    this.n += 1;
    this.due.push({ at: this.now + ms, n: this.n, fn });
  }

  /** Move the clock forward by `ms` and run each piece of work that is due. */
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      this.due.sort((a, b) => a.at - b.at || a.n - b.n);
      const next = this.due[0];
      if (!next || next.at > until) break;
      this.due.shift();
      this.now = Math.max(this.now, next.at);
      next.fn();
    }
    this.now = until;
  }

  /** The number of pieces of work that wait. */
  pending(): number {
    return this.due.length;
  }
}

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;

/** C06 §2 catalogue fixture: the split weights of routes R1, R2 and R3. */
export function catalogueSplitWeights(): SplitWeights[] {
  return fixture<{ events: Array<{ body: SplitWeights }> }>('catalogue-split-weights.json').events.map((e) => e.body);
}

/**
 * C06 CT-R fixture of usage batches (CT-R6, CT-R9, CT-R10, CT-R12, CT-R13) of account u1, with the golden ledger
 * after the five batches are posted (CT-C1). The golden ledger comes from an independent oracle.
 */
export function ctrUsageBatches(): { batches: ChargeLineBatch[]; golden: Record<string, string> } {
  return fixture('ct-r-usage-batches.json');
}

/** C06 CT-R fixture: four reservation batches and the golden ledger after they are posted (CT-C1). */
export function ctrReservationBatches(): { batches: ChargeLineBatch[]; golden: Record<string, string> } {
  return fixture('ct-r-reservation-batches.json');
}

/** A replica that holds the catalogue fixture. */
export function weightsFixture(): SplitWeightsReplica {
  const w = new SplitWeightsReplica();
  for (const x of catalogueSplitWeights()) w.apply(x);
  return w;
}

export const MINUTE_0 = '2026-10-12T09:00:00Z';

/** One reservation original as rating emits it (C06 §5). */
export function reservationLine(account: string, reservation: string, minute: string, amount: bigint,
  over: Partial<ChargeLine> = {}): ChargeLine {
  return {
    sourceRef: { kind: 'reservation', reservation, minute, seq: 0 }, lineKind: 'reservation', account, reservation,
    product: 'guaranteed', route: 'R1', weightsVersion: 'w1', minute, payer: 'account', amount: amount.toString(),
    newTotal: amount.toString(), priorTotal: '0', reason: 'original', priceCatalogue: { resolvedTs: '1760000000000000000.0000000002' },
    ...over,
  };
}

/** One reservation batch of `lines` (C06 §5), with a fixed batch id. */
export function reservationBatch(id: string, account: string, minute: string, lines: ChargeLine[], lineCount = lines.length): ChargeLineBatch {
  return {
    type: 'ChargeLineBatch', schemaVersion: 1,
    eventId: { partition: 'rating-1', stream: 'charges', streamSeq: id.split(':')[2] ?? '1', generation: 0, epoch: 1 },
    batch: { id, kind: 'reservation', account, minute, gated: false, lineCount },
    lines, emittedAt: '1760259603000000000.0000000000',
  };
}

/** One charge line of any kind as rating emits it (C06 §5): `amount = newTotal − priorTotal`. */
export function chargeLine(account: string, sourceRef: ChargeLine['sourceRef'], lineKind: ChargeLine['lineKind'], priorTotal: bigint,
  newTotal: bigint, over: Partial<ChargeLine> = {}): ChargeLine {
  const fee = lineKind === 'fee' || lineKind === 'share_borne_fee';
  const minute = 'minute' in sourceRef ? sourceRef.minute : undefined;
  return {
    sourceRef, lineKind, account,
    ...(fee ? {} : { route: 'R1', weightsVersion: 'w1' }), ...(minute !== undefined ? { minute } : {}),
    payer: lineKind === 'share_borne_fee' || lineKind === 'carried_excess' || lineKind === 'dearer_path' ? 'share' : 'account',
    amount: (newTotal - priorTotal).toString(), newTotal: newTotal.toString(), priorTotal: priorTotal.toString(),
    reason: ('seq' in sourceRef ? sourceRef.seq : 0) === 0 ? 'original' : 'late_traffic',
    priceCatalogue: { resolvedTs: '1760000000000000000.0000000002' },
    ...over,
  };
}

/** The SourceRef of a usage line (C06 §5). */
export function usageRef(account: string, route: string, minute: string, seq = 0, product = 'best-effort'): Extract<ChargeLine['sourceRef'], { kind: 'usage' }> {
  return { kind: 'usage', account, product, route, minute, seq };
}

/** One usage batch of `lines` (C06 §5), with a fixed batch id. */
export function usageBatch(id: string, account: string, lines: ChargeLine[], lineCount = lines.length): ChargeLineBatch {
  return {
    type: 'ChargeLineBatch', schemaVersion: 1,
    eventId: { partition: 'rating-1', stream: 'charges', streamSeq: id.split(':')[2] ?? '1', generation: 0, epoch: 1 },
    batch: { id, kind: 'usage', account, gated: lines.some((l) => l.lineKind === 'usage'), lineCount },
    lines, emittedAt: '1760259603000000000.0000000000',
  };
}

/**
 * A catalogue double for operator price corrections (C06 "Idempotency": a `price_correction` command is keyed by
 * its `sourceRef` for 7 years; a repeat returns the first result; the same key with other content or from another
 * principal is refused, AI4-1, P4-S99). The test emits rating's amendment line only for an accepted correction.
 */
export class CatalogueCorrectionsDouble {
  private readonly accepted = new Map<string, { principal: string; digest: string }>();
  /** Submit a correction by its operator source reference, its principal and its content. */
  submit(sourceRef: string, principal: string, content: unknown): { accepted: true } | { refused: 'source_ref_reused' } {
    const digest = JSON.stringify(content);
    const cur = this.accepted.get(sourceRef);
    if (cur) return cur.principal === principal && cur.digest === digest ? { accepted: true } : { refused: 'source_ref_reused' };
    this.accepted.set(sourceRef, { principal, digest });
    return { accepted: true };
  }
}

export interface MoneyWorld {
  rt: RuntimeDouble;
  ledger: LedgerOwner;
  weights: SplitWeightsReplica;
  scheduler: ManualScheduler;
  settlement: Settlement;
  /** Acknowledgements that settlement published directly. */
  directAcks: PostingAck[];
  /** Offsets that settlement committed, in order. */
  commits: Array<{ partition: number; next: bigint }>;
  /** Every line acknowledgement of a batch: settlement's direct ones and the ledger's outbox ones. */
  acksFor(batchId: string): LineAck[];
  /** Events the ledger published on a topic, in order. */
  events<T = unknown>(topic: string): Array<{ partition: string; streamSeq: bigint; event: T }>;
  /** Balances by ledger account, summed over every partition. */
  balances(): Map<string, bigint>;
  /** Give one batch to settlement on Kafka partition 0 (or `src`) and wait until it has no post in flight. */
  settle(batch: ChargeLineBatch, src?: { partition: number; offset: bigint }): Promise<LineAck[]>;
  /** Post a request to the home partition of `account`. */
  post(account: string, request: PostMovementRequest, principal?: string): Promise<LedgerAnswer>;
  /** A new settlement instance (a restart or a standby): offsets as committed; nothing in memory. */
  restartSettlement(port?: LedgerPort): Settlement;
}

export interface MoneyWorldOptions {
  partitionCount?: number;
  /** The posting port that settlement calls (default: the ledger itself). */
  port?: (ledger: LedgerOwner) => LedgerPort;
  settlement?: Partial<SettlementOptions>;
}

/** The real ledger on the runtime double, the real settlement, the catalogue fixture and a manual scheduler. */
export async function moneyWorld(o: MoneyWorldOptions = {}): Promise<MoneyWorld> {
  const partitionCount = o.partitionCount ?? 128;
  const rt = new RuntimeDouble({ declaration: ledgerDeclaration() });
  const weights = weightsFixture();
  const ledger = new LedgerOwner(rt, { weights, partitionCount });
  await rt.start(ledger);
  const scheduler = new ManualScheduler(1_760_259_600_000);
  const directAcks: PostingAck[] = [];
  const commits: Array<{ partition: number; next: bigint }> = [];
  let offset = 0n;
  const make = (port: LedgerPort): Settlement => new Settlement({
    ledger: port, weights, scheduler, partitionCount, lineStates: ledger,
    publishAcks: async (a) => { directAcks.push(structuredClone(a)); },
    commitOffset: async (partition, next) => { commits.push({ partition, next }); },
    ...o.settlement,
  });
  const port = o.port ? o.port(ledger) : ledger;
  const w: MoneyWorld = {
    rt, ledger, weights, scheduler, settlement: make(port), directAcks, commits,
    acksFor: (batchId) => [
      ...directAcks.filter((a) => a.batchId === batchId).flatMap((a) => a.lines),
      ...rt.published.filter((p) => p.topic === TOPIC.postingAcks).map((p) => p.event as PostingAck)
        .filter((a) => a.batchId === batchId).flatMap((a) => a.lines),
    ],
    events: <T>(topic: string) => rt.published.filter((p) => p.topic === topic)
      .map((p) => ({ partition: Buffer.from(p.partition).toString('utf8'), streamSeq: p.streamSeq, event: p.event as T })),
    balances: () => {
      const out = new Map<string, bigint>();
      for (const { key, row } of rt.world.tableRows.get(LEDGER_TABLE.balance)?.values() ?? []) {
        const a = String(key['ledger_account']);
        out.set(a, (out.get(a) ?? 0n) + BigInt(recordOf<BalanceRecord>(row)?.balance ?? '0'));
      }
      return out;
    },
    settle: async (batch, src) => {
      w.settlement.receive(src ?? { partition: 0, offset: offset++ }, batch);
      await w.settlement.idle();
      return w.acksFor(batch.batch.id);
    },
    post: (account, request, principal = 'settlement') =>
      ledger.post({ partition: ledgerPartitionOfBuyer(account, partitionCount), principal, request, account }),
    restartSettlement: (p) => {
      w.settlement.stop();
      w.settlement = make(p ?? port);
      return w.settlement;
    },
  };
  return w;
}
