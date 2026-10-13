/**
 * C06 v1 (frozen): the parts that the ledger and settlement use in MONEY-I2. Names are copied from C06
 * "Schema" §1, §2 (split weights), §5 (charge-line feed), §7 (posting acknowledgement), §8 (ledger posting
 * port) and §9 (ledger movement feed). Money is a signed decimal integer string of micro-USD.
 */

/** Signed decimal integer, micro-USD (C06 "Conventions"). */
export type MicroUsd = string;
/** HLC "<wall-ns>.<logical>". */
export type DbTs = string;
/** "YYYY-MM-DDTHH:MM:00Z". */
export type Minute = string;
/** Non-negative decimal integer. */
export type Seq = string;

export interface EventId { partition: string; stream: string; streamSeq: Seq; generation: number; epoch: number }

export interface LedgerPosition {
  /** Ledger partition (1 … 128, plus Share sub-partitions). */
  ledgerPartition: string;
  /** Partition log sequence; "0" = nothing posted yet. */
  sequence: Seq;
  /** Commit timestamp of the movement at `sequence`. */
  commitTs: DbTs;
}

export type Cause =
  | { kind: 'share' }
  | { kind: 'supplier'; supplier: string }
  | { kind: 'other' };

/** C06 §2 `split_weights`. */
export interface SplitWeights {
  entityType: 'split_weights';
  route: string;
  weightsVersion: string;
  effectiveFrom: Minute;
  announcedAt: DbTs;
  legs: Array<{ link: string; supplier: string; weight: number }>;
  commissionWeight: number;
}

/** C06 §5. */
export type SourceRef =
  | { kind: 'reservation'; reservation: string; minute: Minute; seq: number }
  | { kind: 'usage'; account: string; product: string; route: string; minute: Minute; seq: number }
  | { kind: 'fee'; reservation: string; feeId: string }
  | { kind: 'residue_fee'; request: string; partnerLink: string; feeId: string }
  | { kind: 'carried_excess'; account: string; product: string; route: string; minute: Minute; seq: number }
  | { kind: 'dearer_path'; reservation: string; minute: Minute; seq: number };

export const LINE_KINDS = ['reservation', 'usage', 'fee', 'share_borne_fee', 'carried_excess', 'dearer_path'] as const;
export type LineKind = typeof LINE_KINDS[number];

export const REASONS = [
  'original', 'late_traffic', 'price_correction', 'quarantine_attribution', 'attribution_reversed', 'late_pol07_cut',
  'corrected_record', 'superseding_record', 're_rate',
] as const;
export type Reason = typeof REASONS[number];

export interface LateCut { link: string; reduction: string; extensionChunk: number }

export interface ChargeLine {
  sourceRef: SourceRef;
  lineKind: LineKind;
  account: string;
  reservation?: string;
  product?: string;
  route?: string;
  weightsVersion?: string;
  payee?: { supplier: string; partnerLink: string };
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
  lateCut?: LateCut;
  priceCatalogue: { resolvedTs: DbTs };
  feeId?: string;
}

export interface ChargeLineBatch {
  type: 'ChargeLineBatch'; schemaVersion: 1;
  eventId: EventId;
  batch: { id: string; kind: 'reservation' | 'usage'; account: string; minute?: Minute; gated: boolean; lineCount: number };
  lines: ChargeLine[];
  emittedAt: DbTs;
}

export const EXCLUSION_REASONS = [
  'content_conflict', 'prior_total_mismatch', 'out_of_sequence', 'invalid', 'batch_refused', 'batch_over_limit',
] as const;
export type ExclusionReason = typeof EXCLUSION_REASONS[number];

export type LineAck =
  | { sourceRef: SourceRef; outcome: 'posted'; duplicate: boolean; position: LedgerPosition; movementId: string;
      postedAmount: MicroUsd; postedTotal: MicroUsd }
  | { sourceRef: SourceRef; outcome: 'excluded'; reason: ExclusionReason; conflictOf?: string;
      ledgerPostedTotal?: MicroUsd; ledgerLastSeq?: number; ledgerPosition?: LedgerPosition };

export interface PostingAck {
  type: 'PostingAck'; schemaVersion: 1;
  eventId: EventId;
  account: string;
  batchId: string;
  lines: LineAck[];
}

export const MOVEMENT_KINDS = [
  'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12', 'M13', 'M14', 'M15', 'M16', 'M17', 'M18',
  'M19', 'M20', 'M21', 'M22', 'M23',
] as const;
export type MovementKind = typeof MOVEMENT_KINDS[number];

/** One entry of a posting-port line. `currency` is not in C06 §8; see the ledger (RFC-004 §B1.2, P4-S31). */
export interface PostEntry { ledgerAccount: string; amount: MicroUsd; currency?: string }

export interface PostLine {
  kind: MovementKind;
  lineRef?: SourceRef | string;
  lineKind?: LineKind;
  payer?: 'account' | 'share';
  payee?: { supplier: string; partnerLink: string };
  reason?: Reason;
  cause?: Cause;
  lateCut?: LateCut;
  triggerRef?: string;
  abandon?: { actionId: string };
  amendmentSeq?: number;
  priorTotal?: MicroUsd;
  newTotal?: MicroUsd;
  split?: { route: string; weightsVersion: string; mode: 'normal' | 'own'; explicitShares?: Array<{ party: string; amount: MicroUsd }> };
  entries: PostEntry[];
}

export interface PostMovementRequest {
  movementRef: string;
  operatorEnvelope?: unknown;
  cause: string;
  currency: 'USD';
  batch?: { id: string; kind: 'reservation' | 'usage'; lineCount: number };
  conditionalOn?: LedgerPosition;
  lines: PostLine[];
}

export type LineProblem = 'conflict' | 'prior_total_mismatch' | 'out_of_sequence' | 'invalid';

export interface CommittedLine {
  lineRef?: SourceRef | string;
  outcome: 'posted' | 'duplicate' | 'excluded';
  problem?: LineProblem;
  of?: string;
  ledgerPostedTotal?: MicroUsd;
  ledgerLastSeq?: number;
  ledgerPosition?: LedgerPosition;
}

export type RefusalReason = 'invalid' | 'wrong_home' | 'principal' | 'stale' | 'over_limit';
export type UnavailableWhy = 'not_owner' | 'moving' | 'stopped' | 'overloaded';

export type PostMovementResponse =
  | { result: 'committed'; movementId: string; postingTime: DbTs; position: LedgerPosition; lines: CommittedLine[];
      whole?: boolean; integrityAlert?: boolean }
  | { result: 'refused'; reason: RefusalReason; detail: string; integrityAlert?: boolean }
  | { result: 'refused_batch';
      lines: Array<{ lineRef: SourceRef; problem: LineProblem; of?: string; ledgerPostedTotal?: MicroUsd; ledgerLastSeq?: number;
                     ledgerPosition?: LedgerPosition }>;
      integrityAlert?: boolean }
  | { result: 'unavailable'; why: UnavailableWhy };

export interface MovementLine {
  lineRef?: SourceRef | string;
  kind: MovementKind;
  amendmentSeq?: number;
  outcome: 'posted' | 'duplicate' | 'excluded';
  nil: boolean;
  lineKind?: LineKind;
  payer?: 'account' | 'share';
  amount?: MicroUsd;
  postedTotal?: MicroUsd;
  reason?: Reason;
  cause?: Cause;
  triggerRef?: string;
  abandon?: { actionId: string };
  lateCut?: LateCut;
  payee?: { supplier: string; partnerLink: string };
  split?: { route: string; weightsVersion: string; mode: 'normal' | 'own'; shares?: Array<{ party: string; amount: MicroUsd }> };
}

export interface MovementPosted {
  type: 'MovementPosted'; schemaVersion: 1;
  eventId: EventId;
  movementId: string;
  position: LedgerPosition;
  postingTime: DbTs;
  movementRef: string;
  home: { account?: string; supplier?: string; shareSubPartition?: number };
  kinds: MovementKind[];
  cause: string;
  currency: 'USD';
  partyTotals: Array<{ ledgerAccount: string; amount: MicroUsd }>;
  lines: MovementLine[];
  postedThrough?: Array<{ reservation: string; minute: Minute }>;
  feesPosted?: Array<{ reservation: string; feeId: string }>;
  batch?: { id: string; kind: 'reservation' | 'usage'; whole?: boolean };
  buyer?: { account: string; balanceAfter: MicroUsd; writtenOffOwedAfter: MicroUsd };
}

/** C06 "Topics". */
export const TOPIC = {
  charges: 'rating.charge-lines.v1',
  postingAcks: 'settlement.posting-acks.v1',
  movements: 'ledger.movements.v1',
  byBuyer: 'ledger.movements.by-buyer.v1',
  bySupplier: 'ledger.movements.by-supplier.v1',
  byExternal: 'ledger.movements.by-external.v1',
} as const;

/** C06 "Charge-line batches", "Size": the movement limit L. */
export const MOVEMENT_LINE_LIMIT = 5_000;
/** C06 "Charge-line batches": reservation batches in flight for each account. */
export const RESERVATION_BATCHES_IN_FLIGHT = 8;
