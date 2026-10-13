/**
 * C06 v1 (frozen): the schema parts that S-RATE I1 produces or consumes.
 * Names, fields and units are copied from C06 §1 … §8. Money is integer micro-USD as a
 * decimal string; prices are integer pico-USD as a decimal string. No float is used.
 */
import { createHash } from 'node:crypto';
import { isMinute } from './time.ts';

export type MicroUsd = string;
export type PicoUsd = string;
export type DbTs = string;
export type Minute = string;
export type Seq = string;
export type AccountId = string;
export type ProductId = string;
export type RouteId = string;
export type ReservationId = string;
export type LinkId = string;
export type SupplierId = string;
export type ExporterId = string;
export type FeeId = string;
export type RequestId = string;
export type ReductionId = string;

export interface EventId { partition: string; stream: string; streamSeq: Seq; generation: number; epoch: number }

/** C05 v1 `LogPosition`; `sequence` is a decimal string in JSON. */
export interface LogPosition { partition: AccountId; sequence: Seq }

export interface LedgerPosition { ledgerPartition: string; sequence: Seq; commitTs: DbTs }
export interface RatingPosition { ratingPartition: string; generation: number; seq: Seq }
export interface CataloguePosition { resolvedTs: DbTs }

export type Cause = { kind: 'share' } | { kind: 'supplier'; supplier: SupplierId } | { kind: 'other' };
export type BatchId = string;

// ---------- §2 catalogue ----------

export type CatalogueEntity =
  | { entityType: 'product'; productId: ProductId; kind: 'guaranteed' | 'best_effort'; permitsBurst: boolean }
  | { entityType: 'route'; routeId: RouteId; legs: LinkId[]; equivalentPathOf?: RouteId }
  | { entityType: 'price_version'; product: ProductId; route: RouteId;
      priceKind: 'reservation_price' | 'usage_price'; priceVersion: string; price: PicoUsd;
      effectiveFrom: Minute; announcedAt: DbTs; oeEffective?: Minute }
  | { entityType: 'split_weights'; route: RouteId; weightsVersion: string; effectiveFrom: Minute; announcedAt: DbTs;
      legs: Array<{ link: LinkId; supplier: SupplierId; weight: number }>; commissionWeight: number };

export interface CatalogueEvent {
  type: 'CatalogueEvent'; schemaVersion: 1;
  eventId: EventId;
  entityVersion: Seq;
  committedAt: DbTs;
  principal: string;
  approver?: string;
  reason?: string;
  body: CatalogueEntity;
}

/** The entity id part of the catalogue key `<entityType>:<entityId>`. */
export function entityKey(e: CatalogueEntity): string {
  switch (e.entityType) {
    case 'product': return `product:${e.productId}`;
    case 'route': return `route:${e.routeId}`;
    case 'price_version': return `price_version:${e.priceVersion}`;
    case 'split_weights': return `split_weights:${e.weightsVersion}`;
  }
}

// ---------- §3 unposted usage ----------

export interface UnpostedUsageFigure {
  type: 'UnpostedUsageFigure'; schemaVersion: 1;
  eventId: EventId;
  account: AccountId;
  ratingPosition: RatingPosition;
  ledgerPositionX: LedgerPosition;
  inFlightUsageBatch?: BatchId;
  products: Array<{ product: ProductId; unpostedUsage: MicroUsd; usageReduction?: MicroUsd }>;
  accruedReservationUnposted?: MicroUsd;
  publishedAt: DbTs;
}

// ---------- §4 usage applied ----------

export interface UsageApplied {
  type: 'UsageApplied'; schemaVersion: 1;
  eventId: EventId;
  account: AccountId;
  appliedThrough: RatingPosition;
  appliedTs: DbTs;
  entry: LogPosition;
  inFlightUsageBatch?: BatchId;
}

// ---------- §5 charge lines ----------

export type LineKind = 'reservation' | 'usage' | 'fee' | 'share_borne_fee' | 'carried_excess' | 'dearer_path';
export const LINE_KINDS: readonly LineKind[] = ['reservation', 'usage', 'fee', 'share_borne_fee', 'carried_excess', 'dearer_path'];

export type SourceRef =
  | { kind: 'reservation'; reservation: ReservationId; minute: Minute; seq: number }
  | { kind: 'usage'; account: AccountId; product: ProductId; route: RouteId; minute: Minute; seq: number }
  | { kind: 'fee'; reservation: ReservationId; feeId: FeeId }
  | { kind: 'residue_fee'; request: RequestId; partnerLink: LinkId; feeId: FeeId }
  | { kind: 'carried_excess'; account: AccountId; product: ProductId; route: RouteId; minute: Minute; seq: number }
  | { kind: 'dearer_path'; reservation: ReservationId; minute: Minute; seq: number };

export type Reason =
  | 'original' | 'late_traffic' | 'price_correction' | 'quarantine_attribution'
  | 'attribution_reversed' | 'late_pol07_cut' | 'corrected_record' | 'superseding_record' | 're_rate';
export const REASONS: readonly Reason[] = ['original', 'late_traffic', 'price_correction', 'quarantine_attribution',
  'attribution_reversed', 'late_pol07_cut', 'corrected_record', 'superseding_record', 're_rate'];

export interface ChargeLine {
  sourceRef: SourceRef;
  lineKind: LineKind;
  account: AccountId;
  reservation?: ReservationId;
  product?: ProductId;
  route?: RouteId;
  weightsVersion?: string;
  payee?: { supplier: SupplierId; partnerLink: LinkId };
  minute?: Minute;
  payer: 'account' | 'share';
  abandon?: { actionId: string };
  amount: MicroUsd;
  newTotal: MicroUsd;
  priorTotal: MicroUsd;
  reason: Reason;
  reasonDetails?: Record<string, string>;
  cause?: Cause;
  triggerRef?: string;
  lateCut?: { link: LinkId; reduction: ReductionId; extensionChunk: number };
  priceCatalogue: CataloguePosition;
  feeId?: FeeId;
}

export interface ChargeLineBatch {
  type: 'ChargeLineBatch'; schemaVersion: 1;
  eventId: EventId;
  batch: { id: BatchId; kind: 'reservation' | 'usage'; account: AccountId; minute?: Minute; gated: boolean; lineCount: number };
  lines: ChargeLine[];
  emittedAt: DbTs;
}

/** The movement limit L (RFC-004 §B10). */
export const MOVEMENT_LIMIT = 5_000;

// ---------- §7 posting acknowledgement ----------

export type LineAck =
  | { sourceRef: SourceRef; outcome: 'posted'; duplicate: boolean; position: LedgerPosition; movementId: string;
      postedAmount: MicroUsd; postedTotal: MicroUsd }
  | { sourceRef: SourceRef; outcome: 'excluded';
      reason: 'content_conflict' | 'prior_total_mismatch' | 'out_of_sequence' | 'invalid' | 'batch_refused' | 'batch_over_limit';
      conflictOf?: string; ledgerPostedTotal?: MicroUsd; ledgerLastSeq?: number; ledgerPosition?: LedgerPosition };

export interface PostingAck {
  type: 'PostingAck'; schemaVersion: 1;
  eventId: EventId;
  account: AccountId;
  batchId: BatchId;
  lines: LineAck[];
}

// ---------- §8 ledger posting port ----------

export type MovementKind = 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'M8' | 'M9' | 'M10' | 'M11' | 'M12'
  | 'M13' | 'M14' | 'M15' | 'M16' | 'M17' | 'M18' | 'M19' | 'M20' | 'M21' | 'M22' | 'M23';

export interface PostMovementRequest {
  movementRef: string;
  operatorEnvelope?: unknown;
  cause: string;
  currency: 'USD';
  batch?: { id: BatchId; kind: 'reservation' | 'usage'; lineCount: number };
  conditionalOn?: LedgerPosition;
  lines: Array<{
    kind: MovementKind;
    lineRef?: SourceRef | string;
    lineKind?: LineKind;
    payer?: 'account' | 'share';
    payee?: { supplier: SupplierId; partnerLink: LinkId };
    reason?: Reason;
    cause?: Cause;
    lateCut?: { link: LinkId; reduction: ReductionId; extensionChunk: number };
    triggerRef?: string;
    abandon?: { actionId: string };
    amendmentSeq?: number;
    priorTotal?: MicroUsd;
    newTotal?: MicroUsd;
    split?: { route: RouteId; weightsVersion: string; mode: 'normal' | 'own'; explicitShares?: Array<{ party: string; amount: MicroUsd }> };
    entries: Array<{ ledgerAccount: string; amount: MicroUsd }>;
  }>;
}

export type LineProblem = 'conflict' | 'prior_total_mismatch' | 'out_of_sequence' | 'invalid';

export type PostMovementResponse =
  | { result: 'committed'; movementId: string; postingTime: DbTs; position: LedgerPosition;
      lines: Array<{ lineRef?: SourceRef | string; outcome: 'posted' | 'duplicate' | 'excluded'; problem?: LineProblem;
        of?: string; ledgerPostedTotal?: MicroUsd; ledgerLastSeq?: number; ledgerPosition?: LedgerPosition }>;
      whole?: boolean; integrityAlert?: boolean }
  | { result: 'refused'; reason: 'invalid' | 'wrong_home' | 'principal' | 'stale' | 'over_limit'; detail: string; integrityAlert?: boolean }
  | { result: 'refused_batch';
      lines: Array<{ lineRef: SourceRef; problem: LineProblem; of?: string; ledgerPostedTotal?: MicroUsd;
        ledgerLastSeq?: number; ledgerPosition?: LedgerPosition }>;
      integrityAlert?: boolean }
  | { result: 'unavailable'; why: 'not_owner' | 'moving' | 'stopped' | 'overloaded' };

// ---------- canonical SourceRef encoding (C06 Conventions) ----------

/** The fields of each SourceRef kind, in schema order. */
const SOURCE_REF_FIELDS: Record<SourceRef['kind'], string[]> = {
  reservation: ['reservation', 'minute', 'seq'],
  usage: ['account', 'product', 'route', 'minute', 'seq'],
  fee: ['reservation', 'feeId'],
  residue_fee: ['request', 'partnerLink', 'feeId'],
  carried_excess: ['account', 'product', 'route', 'minute', 'seq'],
  dearer_path: ['reservation', 'minute', 'seq'],
};

function decimal(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  throw new Error(`not a non-negative integer: ${String(v)}`);
}

/**
 * The canonical bytes of a SourceRef: the kind tag first, then the fields in schema order.
 * Each field is UTF-8 with a u32 big-endian length prefix. Integers are decimal strings with
 * no leading zeros; minutes are in `Minute` form.
 */
export function canonicalSourceRefBytes(ref: SourceRef): Uint8Array {
  const fields = SOURCE_REF_FIELDS[ref.kind];
  if (!fields) throw new Error(`unknown SourceRef kind ${(ref as { kind: string }).kind}`);
  const values: string[] = [ref.kind];
  const rec = ref as unknown as Record<string, unknown>;
  for (const f of fields) {
    const v = rec[f];
    if (f === 'seq') values.push(decimal(v));
    else if (f === 'minute') {
      if (typeof v !== 'string' || !isMinute(v)) throw new Error(`SourceRef.minute is not a Minute: ${String(v)}`);
      values.push(v);
    } else {
      if (typeof v !== 'string') throw new Error(`SourceRef.${f} is not a string`);
      values.push(v);
    }
  }
  const parts: Buffer[] = [];
  for (const s of values) {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length, 0);
    parts.push(len, b);
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** SHA-256 of the canonical bytes, lower-case hex. */
export function sourceRefDigest(ref: SourceRef): string {
  return createHash('sha256').update(canonicalSourceRefBytes(ref)).digest('hex');
}

/** The line key: the SourceRef without its amendment sequence. */
export function lineKeyOf(ref: SourceRef): string {
  const { seq: _seq, ...rest } = ref as SourceRef & { seq?: number };
  return JSON.stringify(rest, Object.keys(rest).sort());
}

// ---------- integer strings ----------

const SIGNED_INT = /^-?(0|[1-9][0-9]*)$/;
const UNSIGNED_INT = /^(0|[1-9][0-9]*)$/;

export function isMicroUsd(s: unknown): s is MicroUsd {
  return typeof s === 'string' && SIGNED_INT.test(s) && s !== '-0';
}

export function isPicoUsd(s: unknown): s is PicoUsd {
  return typeof s === 'string' && UNSIGNED_INT.test(s);
}

export function isSeq(s: unknown): s is Seq {
  return typeof s === 'string' && UNSIGNED_INT.test(s);
}

export function isDbTs(s: unknown): s is DbTs {
  return typeof s === 'string' && /^\d+\.\d+$/.test(s);
}
