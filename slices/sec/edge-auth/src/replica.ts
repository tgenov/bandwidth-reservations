/**
 * The edge replica of credential state (RFC-005 §3.3), fed by the identity edge stream (C08 §C).
 * In memory only; the edge keeps no authoritative state.
 */
import {
  CertStore, DOMAINS, IDENTITY_CERT_OWNER_KIND, fromB64url, without,
  type CredentialRecord, type EdgeStreamMessage, type Heartbeat, type EpochMicros, type SignedKeyRecord,
} from '@share/iam-lib';

/** `edge_staleness_max` (C08 "Timeouts"). */
export const EDGE_STALENESS_MAX_MICROS = 30_000_000n;

export interface KeyEntry {
  record: CredentialRecord & { body: { kind: 'agent_key' | 'supplier_key' } };
  verifier: Uint8Array;
  keyRecord: SignedKeyRecord | undefined;
}

interface SlotState {
  applied: bigint;        // highest position applied
  freshS: EpochMicros | undefined;
  lastSentAt: EpochMicros | undefined;
  maxEpoch: bigint;
}

export class EdgeReplica {
  private readonly certs: CertStore;
  private readonly keys = new Map<string, KeyEntry>();
  private readonly slots = new Map<number, SlotState>();
  readonly alerts: string[] = [];
  /** Keys whose established connections the edge must close (C08 §C "Revocation"). */
  readonly closed: string[] = [];

  constructor(certs: CertStore) {
    this.certs = certs;
  }

  private slot(s: number): SlotState {
    let st = this.slots.get(s);
    if (!st) { st = { applied: 0n, freshS: undefined, lastSentAt: undefined, maxEpoch: 0n }; this.slots.set(s, st); }
    return st;
  }

  /** The position to reconnect from. */
  position(slot: number): string {
    return this.slot(slot).applied.toString();
  }

  /** Apply messages of one slot's stream, in order. */
  apply(slot: number, messages: EdgeStreamMessage[], now: EpochMicros): void {
    const st = this.slot(slot);
    for (const m of messages) {
      if ('heartbeat' in m) this.applyHeartbeat(st, slot, m.heartbeat, now);
      else this.applyRecord(st, slot, m.record, m.key_record, now);
    }
  }

  private applyRecord(st: SlotState, slot: number, rec: CredentialRecord, kr: SignedKeyRecord | undefined, now: EpochMicros): void {
    if (rec.identity_slot !== slot) { this.alerts.push(`record of slot ${rec.identity_slot} on stream ${slot}`); return; }
    const epoch = BigInt(rec.epoch);
    const position = BigInt(rec.position);
    // Never a record of an epoch older than one applied at a lower position (C08 §C).
    if (epoch < st.maxEpoch) { this.alerts.push(`record of old epoch ${epoch} at slot ${slot}`); return; }
    const v = this.certs.verify(DOMAINS.edgeRecord, without(rec, 'signature'), rec.signature, {
      purpose: 'identity_record', owner_kind: IDENTITY_CERT_OWNER_KIND, slot, epoch: rec.epoch,
      validAt: { committed_at: rec.committed_at },
    }, now);
    if (!v.ok) { this.alerts.push(`record refused at slot ${slot}: ${v.reason}`); return; }
    if (position > st.applied) st.applied = position;
    if (epoch > st.maxEpoch) st.maxEpoch = epoch;
    const body = rec.body;
    if (body.kind !== 'agent_key' && body.kind !== 'supplier_key') return; // later increments
    const held = this.keys.get(body.key_id);
    if (held && held.record.version >= rec.version) {
      if (held.record.version > rec.version) this.alerts.push(`lower version of key ${body.key_id} ignored`);
      return;
    }
    this.keys.set(body.key_id, {
      record: rec as KeyEntry['record'], verifier: fromB64url(body.verifier_sha256),
      keyRecord: kr && kr.key_id === body.key_id && kr.version === rec.version ? kr : undefined,
    });
    if (body.status === 'revoked') this.closed.push(body.key_id);
  }

  private applyHeartbeat(st: SlotState, slot: number, hb: Heartbeat, now: EpochMicros): void {
    if (hb.identity_slot !== slot) { this.alerts.push(`heartbeat of slot ${hb.identity_slot} on stream ${slot}`); return; }
    const epoch = BigInt(hb.epoch);
    if (epoch < st.maxEpoch) { this.alerts.push(`heartbeat of old epoch ${epoch} at slot ${slot}`); return; }
    if (st.lastSentAt !== undefined && hb.sent_at < st.lastSentAt) { this.alerts.push(`heartbeat sent_at went back at slot ${slot}`); return; }
    const v = this.certs.verify(DOMAINS.edgeHeartbeat, without(hb, 'signature'), hb.signature, {
      purpose: 'identity_record', owner_kind: IDENTITY_CERT_OWNER_KIND, slot, epoch: hb.epoch, validAt: 'now',
    }, now);
    if (!v.ok) { this.alerts.push(`heartbeat refused at slot ${slot}: ${v.reason}`); return; }
    if (epoch > st.maxEpoch) st.maxEpoch = epoch;
    st.lastSentAt = hb.sent_at;
    // fresh_s advances only when every record up to the heartbeat's head is applied.
    if (BigInt(hb.head) <= st.applied) st.freshS = hb.sent_at;
  }

  /** Edge invariant: a credential of slot s authenticates only while now − fresh_s ≤ 30 s (C08 §C). */
  fresh(slot: number, now: EpochMicros): boolean {
    const f = this.slot(slot).freshS;
    return f !== undefined && now - f <= EDGE_STALENESS_MAX_MICROS && this.certs.fresh(now);
  }

  key(keyId: string): KeyEntry | undefined {
    return this.keys.get(keyId);
  }

  /** The record's certificate is still good now (refuse records under a revoked certificate, C08 §C). */
  recordStillCertified(e: KeyEntry, now: EpochMicros): boolean {
    const rec = e.record;
    return this.certs.verify(DOMAINS.edgeRecord, without(rec, 'signature'), rec.signature, {
      purpose: 'identity_record', owner_kind: IDENTITY_CERT_OWNER_KIND, slot: rec.identity_slot, epoch: rec.epoch,
      validAt: { committed_at: rec.committed_at },
    }, now).ok;
  }
}
