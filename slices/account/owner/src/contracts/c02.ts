/**
 * C02 v1.0.0 (frozen): link hold port, consumer side. Only the commands AM-I1 sends:
 * `hold`, `convert` and `release`, with their replies. Names are copied from C02 "Schema".
 */
import type { CommandEnvelope, Epoch, Generation, HlcTs, PartitionKey, RoutingRefusal, Seq } from '@share/owner-runtime';

export type LinkId = string;
export type AccountPartition = PartitionKey;
export type Hlc = HlcTs;
export type EpochMs = number;
export type DurationMs = number;
export type Minute = number;
export type Mbps = number;

export interface LogRef { partition: AccountPartition; seq: Seq }
export type RequestId = LogRef;
export type ChangeId = LogRef;
export type ReservationId = string;
export type LegId = string;
export type PartId = string;
export type Attempt = number;

export interface Window { start: Minute; end: Minute | null }
export interface Fence { generation: Generation; epoch: Epoch }

export interface C02Body { link: LinkId; receiverPartition: string }
export interface LinkStamp { linkFence: Fence; linkSeq: Seq }

export type C02Error =
  | { code: 'MISMATCH' }
  | { code: 'UNKNOWN_LINK' }
  | { code: 'LINK_CLOSING' }
  | { code: 'LINK_RETIRED' };
export type Refusal = RoutingRefusal | C02Error;

export type HoldKind = { kind: 'booking' } | { kind: 'change'; reservation: ReservationId };

export interface HoldCmd extends C02Body {
  request: RequestId; account: AccountPartition; leg: LegId; holdKind: HoldKind;
  rateMbps: Mbps; window: Window;
  deadline: EpochMs;
  commitFence: EpochMs;
  requestAge: Hlc;
  wait: boolean;
  receiptMinute: Minute;
  policyVersion: Seq;
}

export interface CounterOffer {
  largestRateMbps: Mbps;
  earliest: { window: Window } | { none: true } | { notFoundBefore: Minute };
}

export type RefusalReason = 'NO_FIT' | 'IN_FLIGHT' | 'DEADLINE_PASSED' | 'TOMBSTONED'
  | { invalid: 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' };

export type HoldReply = (LinkStamp & (
  | { result: 'HELD'; attempt: Attempt }
  | { result: 'WAITING'; attempt: Attempt; aheadDeadline: EpochMs }
  | { result: 'REFUSED'; reason: RefusalReason; counterOffer?: CounterOffer; retryAfterMs?: DurationMs }
  | { result: 'RELEASED' } | { result: 'CONVERTED'; part: PartId }
)) | Refusal;

export interface ConvertCmd extends C02Body {
  request: RequestId; attempt: Attempt; reservation: ReservationId; leg: LegId; part: PartId;
  createdBy: ChangeId;
  decisionTime: Hlc;
}
export type ConvertReply = (LinkStamp & {
  result: 'CONVERTED'; part: PartId;
  clippedAt?: Minute;
}) | { code: 'NO_HOLD' } | { code: 'TOMBSTONED' } | Refusal;

export interface ReleaseCmd extends C02Body {
  request: RequestId; deadline: EpochMs;
  reason: 'WITHDRAWN' | 'EXPIRED' | 'REJECTED' | 'FAILED' | 'ENDED';
  decisionTime: Hlc;
}
export type ReleaseReply = (LinkStamp & { result: 'RELEASED'; tombstoneUntil: EpochMs }) | Refusal;

/** The link hold port as the account owner calls it. The C01 envelope travels beside the body. */
export interface LinkHoldPort {
  hold(env: CommandEnvelope, cmd: HoldCmd): Promise<HoldReply>;
  convert(env: CommandEnvelope, cmd: ConvertCmd): Promise<ConvertReply>;
  release(env: CommandEnvelope, cmd: ReleaseCmd): Promise<ReleaseReply>;
}

/** The link schedule owner kind (S-LINK plan, PLAT-A). */
export const LINK_KIND = 'link';

/** Encode a request id as C01's displacementRead `request`: request_part ‖ U64BE(request_seq). */
export function displacementRequestBytes(r: RequestId): Uint8Array {
  const out = new Uint8Array(r.partition.byteLength + 8);
  out.set(r.partition, 0);
  new DataView(out.buffer).setBigUint64(r.partition.byteLength, r.seq);
  return out;
}

export function isRoutingRefusal(x: unknown): x is RoutingRefusal | C02Error {
  return typeof x === 'object' && x !== null && 'code' in x && !('result' in x);
}
