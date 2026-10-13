/**
 * C11 v1.0.0 (frozen): metering ingress types. Names, fields and units are copied from C11
 * "Common types", Part I, Part II, Part III and Part IV. Every field is required unless it
 * is marked optional.
 */

import type { AccountId, ExporterId, LinkId, ProductId, ReservationId, RouteId, SupplierId } from './c06.ts';

export type CertSerial = string;
export type U64 = string;
export type I64 = string;
export type HlcTs = string;
export type EpochMs = number;
export type ExactBytes = { num: I64; den: U64 };

export type ExporterOwner = { kind: 'supplier'; supplierId: SupplierId } | { kind: 'share' };
export type Direction = 'ingress' | 'egress';
export type ExportFormat = 'ipfix' | 'netflow-v9';

export type ServiceTag = {
  vlan?: { outer: number; inner?: number };
  mplsLabel?: number;
  vrf?: string;
};

export type ObservationPoint = {
  exporterId: ExporterId;
  observationDomain: number;
  ifIndex: number;
  direction: Direction;
};

export type RecordIdentity =
  | { format: 'ipfix'; exporterId: ExporterId; observationDomain: number; epoch: number; extSeq: U64 }
  | { format: 'netflow-v9'; exporterId: ExporterId; observationDomain: number; epoch: number; packetExtSeq: U64; index: number };

export type RawRef = { exporterId: ExporterId; logSeq: U64; message: number; record: number };

export type RejectKey =
  | { kind: 'positioned'; exporterId: ExporterId; observationDomain: number; epoch: number | null;
      messageSeq: U64; exportTimeS: number; set: number; record: number; byteOffset: number }
  | { kind: 'digest'; exporterId: ExporterId; keyedDigest: string };

export type DerivedIdentity =
  | { kind: 'record'; id: RecordIdentity }
  | { kind: 'correction'; rejectKey: RejectKey; sub: number }
  | { kind: 'version'; original: DerivedIdentity; v: number }
  | { kind: 'conflict'; identity: RecordIdentity; conflictingRawRef: RawRef };

export type RecordFields = {
  observationDomain: number;
  ifIndex: number;
  direction: Direction;
  serviceTag: ServiceTag;
  flowStartMs: EpochMs;
  flowEndMs: EpochMs;
  bytes: I64;
  packets?: U64;
};

// ---------- Part I ----------

export type Hello = { protocolVersion: 1; exportFormat: ExportFormat; softwareId?: string };
export type Batch = { batchNo: U64; items: BatchItem[] };
export type ExportItem = { message: Uint8Array; context: Uint8Array };
export type BatchItem = { exportMessage: ExportItem } | { correction: unknown } | { supersession: unknown };
export type ExporterFrame = { hello: Hello } | { batch: Batch };

export type Welcome = {
  protocolVersion: 1; exporterId: ExporterId; owner: ExporterOwner; certSerial: CertSerial; sessionId: string;
  region: 'R1' | 'R2'; maxBatchBytes: number; ingestRetryTimeoutMs: number; serverTimeMs: EpochMs;
};
export type Credit = { windowBatches: number; windowBytes: number };

export type RejectReason =
  | 'no exporter' | 'no template' | 'no sequence number' | 'no epoch' | 'negative byte count'
  | 'end time before its start time' | 'missing flow times' | 'flow time in the future'
  | 'missing attribution key' | 'missing byte count' | 'unparseable';

export type TemplateRefusal = { templateId: number; observationDomain: number; reason: string };
export type RejectedRecord = { rejectKey: RejectKey; rawRef: RawRef; identity?: RecordIdentity; reason: RejectReason };

export type MessageAck = {
  accepted: number;
  duplicates: number;
  acceptedIdentities: RecordIdentity[];
  rejected: RejectedRecord[];
  templateRefusals: TemplateRefusal[];
};
export type ItemAck = { message: MessageAck };
export type BatchAck = { batchNo: U64; committedAt: { commitTs: HlcTs; acceptedAtMs: EpochMs }; items: ItemAck[] };
export type SessionNotice = { kind: 'credential-revoked' | 'draining' | 'protocol-error' | 'waiting'; detail?: string };
export type EdgeFrame = { welcome: Welcome } | { credit: Credit } | { ack: BatchAck } | { notice: SessionNotice };

// ---------- Part II ----------

export type LoggedContext = { contextHash: string; firstLoggedIn?: U64; context?: Uint8Array };

export type AcceptedRecord = { identity: RecordIdentity; rawRef: RawRef; fields: RecordFields; exportTimeS: number };

export type BatchBody = {
  kind: 'batch';
  session: { sessionId: string; region: 'R1' | 'R2'; certSerial: CertSerial };
  format: ExportFormat;
  contexts: LoggedContext[];
  accepted: AcceptedRecord[];
  duplicates: Array<{ identity: RecordIdentity; digest64: string }>;
  rejected: Array<{ rawRef: RawRef; identity?: RecordIdentity; reason: RejectReason }>;
};

export type HandoffEvent = {
  schemaVersion: 1;
  exporterId: ExporterId;
  handoffSeq: U64;
  logSeq: U64;
  commitTs: HlcTs;
  acceptedAtMs: EpochMs;
  owner: ExporterOwner;
  certSerial: CertSerial;
  /** I1 produces only `batch` bodies; other kinds are C11 Part II and come in I2, I15, I16. */
  body: BatchBody | { kind: 'correction' | 'supersession' | 'identity-conflict'; [k: string]: unknown };
};

// ---------- Part III ----------

export type ObservationPointFact = {
  kind: 'observation-point'; factId: string; op: ObservationPoint; linkId: LinkId | null;
  validFromMs: EpochMs; validToMs: EpochMs | null;
};

export type BindingFact = {
  kind: 'binding'; factId: string; bindingId: string;
  key: { op: ObservationPoint; serviceTag: ServiceTag };
  validFromMs: EpochMs; validToMs: EpochMs | null;
  accountId: AccountId; productId: ProductId; routeId: RouteId; reservationId: ReservationId | null;
  egress: boolean; egressGroup?: string;
};

export type CorrectionFact = { kind: 'correction'; supersedesFactId: string; replacement: BindingFact | ObservationPointFact | null };
export type Heartbeat = { kind: 'heartbeat'; coversThroughMs: EpochMs };

export type ProvisioningEvent = {
  schemaVersion: 1;
  exporterId: ExporterId;
  bindingSeq: U64;
  recordedAtMs: EpochMs;
  fact: ObservationPointFact | BindingFact | CorrectionFact | Heartbeat;
};

export type PartitionHeartbeatEvent = {
  schemaVersion: 1; kind: 'partition-heartbeat'; partition: number; partitionSeq: U64;
  recordedAtMs: EpochMs; coversThroughMs: EpochMs;
};

// ---------- Part IV ----------

export type ForwardedBinding = {
  exporterId: ExporterId; bindingSeq: U64; bindingId: string; retracted: boolean;
  productId: ProductId; routeId: RouteId; reservationId: ReservationId | null;
  direction: Direction; egress: boolean; egressGroup?: string;
  op: ObservationPoint; validFromMs: EpochMs; validToMs: EpochMs | null;
};

export type PartClass = 'reservation' | 'attachment' | 'best-effort';

export type Part = {
  recordIdentity: DerivedIdentity;
  bindingPosition: U64;
  acceptedAtMs: EpochMs;
  lastMinuteEndMs: EpochMs;
  minuteMs: EpochMs;
  bytes: ExactBytes;
  class: PartClass;
  accountId: AccountId;
  productId: ProductId;
  routeId: RouteId;
  reservationId: ReservationId | null;
  op: ObservationPoint;
  linkId: LinkId | null;
  reason?: 'superseding record' | 'quarantine attribution' | 'attribution reversed';
  cause?: ExporterOwner;
  sourceRef?: string;
  reversedSourceRef?: string;
};

export type PartBatch = {
  schemaVersion: 1;
  feedId: { stageAPartition: ExporterId; ownerEpoch: number; logSeq: U64; accountId: AccountId };
  destSeq: U64;
  commitTs: HlcTs;
  parts: Part[];
  bindingFacts: ForwardedBinding[];
};

/** Service-tag equality is member-wise; an absent member equals only an absent member (C11). */
export function serviceTagEqual(a: ServiceTag, b: ServiceTag): boolean {
  const va = a.vlan; const vb = b.vlan;
  const vlanEq = va === undefined || vb === undefined ? va === vb : va.outer === vb.outer && va.inner === vb.inner;
  return vlanEq && a.mplsLabel === b.mplsLabel && a.vrf === b.vrf;
}

export function observationPointEqual(a: ObservationPoint, b: ObservationPoint): boolean {
  return a.exporterId === b.exporterId && a.observationDomain === b.observationDomain
    && a.ifIndex === b.ifIndex && a.direction === b.direction;
}

/** The C11 topics. */
export const TOPIC_HANDOFF = 'ingestion.handoff.v1';
export const TOPIC_BINDINGS = 'provisioning.bindings.v1';
export const TOPIC_PARTS = 'attribution.parts.v1';
