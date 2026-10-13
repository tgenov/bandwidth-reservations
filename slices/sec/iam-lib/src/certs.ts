/**
 * Receiver side of the key-certification stream (C08 §N) and the certificate rules of C08 §C
 * ("Certificates", R46-04, V56-2, V56-3).
 */
import { fromB64url, without } from './jcs.ts';
import { DOMAINS, verifyObject, type Domain } from './sign.ts';
import type { CertStreamMessage, Ed25519Signature, EpochMicros, SigningKeyCert } from './types.ts';

/** `edge_staleness_max`: refuse every object once the last cert-stream heartbeat is older (C08 §C). */
export const CERT_STALENESS_MAX_MICROS = 30_000_000n;

export interface CertRequirement {
  purpose: SigningKeyCert['purpose'];
  owner_kind: string;
  slot: number;
  /** The epoch the object names (key records, edge records, heartbeats). */
  epoch?: string;
  /** V56-3: records check validity at `committed_at`; heartbeats and bundles check it at `now`. */
  validAt: { committed_at: EpochMicros } | 'now';
}

export type CertVerdict =
  | { ok: true; cert: SigningKeyCert }
  | { ok: false; reason: 'cert_stream_stale' | 'unknown_cert' | 'revoked' | 'wrong_purpose' | 'wrong_slot'
                       | 'wrong_epoch' | 'outside_validity' | 'bad_signature' };

export class CertStore {
  private readonly root: Uint8Array;
  private readonly certs = new Map<string, SigningKeyCert>();
  private readonly revoked = new Map<string, EpochMicros>();
  private lastHeartbeat: EpochMicros | undefined;
  private position = 0n;
  readonly alerts: string[] = [];

  constructor(rootPublicKey: Uint8Array) {
    this.root = rootPublicKey;
  }

  /** The last applied stream position (to reconnect from). */
  get head(): string {
    return this.position.toString();
  }

  /** Apply one stream message. Answer false and alert when the message does not verify. */
  apply(m: CertStreamMessage): boolean {
    if ('cert' in m) {
      const c = m.cert;
      if (!verifyObject(DOMAINS.keyCert, without(c, 'key_service_sig'), fromB64url(c.key_service_sig), this.root)) {
        this.alerts.push(`cert ${c.key_id}: bad key-service signature`);
        return false;
      }
      const held = this.certs.get(c.key_id);
      if (held && held.key_service_sig !== c.key_service_sig && held.public_key !== c.public_key) {
        this.alerts.push(`cert ${c.key_id}: same key_id, different content (refused)`);
        return false;
      }
      this.certs.set(c.key_id, c);
      this.advance(m.position);
      return true;
    }
    if ('revocation' in m) {
      const r = m.revocation;
      if (!verifyObject(DOMAINS.keyRevoke, without(r, 'key_service_sig'), fromB64url(r.key_service_sig), this.root)) {
        this.alerts.push(`revocation ${r.key_id}: bad key-service signature`);
        return false;
      }
      if (!this.revoked.has(r.key_id)) this.revoked.set(r.key_id, r.revoked_at); // terminal
      this.advance(m.position);
      return true;
    }
    const h = m.heartbeat;
    if (!verifyObject(DOMAINS.certHeartbeat, without(h, 'key_service_sig'), fromB64url(h.key_service_sig), this.root)) {
      this.alerts.push('cert heartbeat: bad key-service signature');
      return false;
    }
    if (this.lastHeartbeat === undefined || h.sent_at > this.lastHeartbeat) this.lastHeartbeat = h.sent_at;
    return true;
  }

  private advance(position: string): void {
    const p = BigInt(position);
    if (p > this.position) this.position = p;
  }

  /** True while the cert stream is fresh (C08 §C: refuse every object after 30 s of silence). */
  fresh(now: EpochMicros): boolean {
    return this.lastHeartbeat !== undefined && now - this.lastHeartbeat <= CERT_STALENESS_MAX_MICROS;
  }

  /** Verify a signature on `unsigned` under a certificate that meets `req`, at time `now`. */
  verify(domain: Domain, unsigned: unknown, signature: Ed25519Signature, req: CertRequirement, now: EpochMicros): CertVerdict {
    if (!this.fresh(now)) return { ok: false, reason: 'cert_stream_stale' };
    const cert = this.certs.get(signature.key_id);
    if (!cert) return { ok: false, reason: 'unknown_cert' };
    if (this.revoked.has(cert.key_id)) return { ok: false, reason: 'revoked' };
    if (cert.purpose !== req.purpose || cert.owner_kind !== req.owner_kind) return { ok: false, reason: 'wrong_purpose' };
    if (cert.slot !== req.slot) return { ok: false, reason: 'wrong_slot' };
    if (req.epoch !== undefined && cert.epoch !== req.epoch) return { ok: false, reason: 'wrong_epoch' };
    const at = req.validAt === 'now' ? now : req.validAt.committed_at;
    if (at < cert.not_before || at > cert.not_after) return { ok: false, reason: 'outside_validity' };
    if (!verifyObject(domain, unsigned, fromB64url(signature.sig), fromB64url(cert.public_key))) {
      return { ok: false, reason: 'bad_signature' };
    }
    return { ok: true, cert };
  }
}
