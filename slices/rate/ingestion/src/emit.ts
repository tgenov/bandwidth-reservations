/**
 * The versioned emit function of the hand-off stream (C11 Part II; RFC-006 §3.5).
 *
 * It derives one HandoffEvent from one `batch` row of `ingest_log` and the row's log metadata
 * only. The owner's direct publish and the changefeed relay both use it, so the two paths give
 * identical events.
 */
import type {
  AcceptedRecord, BatchBody, CertSerial, ExporterId, ExporterOwner, HandoffEvent, LoggedContext, RawRef,
  RecordIdentity, RejectReason,
} from '@share/rate-common';
import { hlcToWallMs, type HlcTs } from '@share/owner-runtime';

export const HANDOFF_EMIT_VERSION = 1;

/** The payload of a `batch` entry (RFC-003 §3.4), as I1 writes it. */
export interface BatchEntryPayload {
  exporterId: ExporterId;
  owner: ExporterOwner;
  certSerial: CertSerial;
  principalId: string;
  session: { sessionId: string; region: 'R1' | 'R2'; certSerial: CertSerial };
  format: 'ipfix';
  batchNo: string;
  contexts: LoggedContext[];
  /** The messages as received, in batch order, with the hash of the context of each. */
  items: Array<{ message: Uint8Array; contextHash: string }>;
  accepted: Array<Omit<AcceptedRecord, 'rawRef'> & { rawRef: Omit<RawRef, 'logSeq'> }>;
  duplicates: Array<{ identity: RecordIdentity; digest64: string }>;
  rejected: Array<{ rawRef: Omit<RawRef, 'logSeq'>; identity?: RecordIdentity; reason: RejectReason }>;
}

export interface LogRowMeta { logSeq: bigint; ts: HlcTs; handoffSeq: bigint }

export function emitHandoff(p: BatchEntryPayload, meta: LogRowMeta): HandoffEvent {
  const logSeq = meta.logSeq.toString();
  const body: BatchBody = {
    kind: 'batch',
    session: { ...p.session },
    format: p.format,
    contexts: p.contexts.map((c) => ({ ...c })),
    accepted: p.accepted.map((a) => ({ ...a, rawRef: { ...a.rawRef, logSeq } })),
    duplicates: p.duplicates.map((d) => ({ ...d })),
    rejected: p.rejected.map((r) => ({ ...r, rawRef: { ...r.rawRef, logSeq } })),
  };
  return {
    schemaVersion: 1,
    exporterId: p.exporterId,
    handoffSeq: meta.handoffSeq.toString(),
    logSeq,
    commitTs: meta.ts,
    acceptedAtMs: hlcToWallMs(meta.ts),
    owner: p.owner,
    certSerial: p.certSerial,
    body,
  };
}
