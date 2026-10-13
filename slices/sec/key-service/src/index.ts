/**
 * @share/key-service — minimal key service of S-SEC I1 (RFC-005 §10; C08 §N key-certification stream,
 * purpose `identity_record` only).
 *
 * DEV ONLY: the certification root is an Ed25519 key made in this process's memory at start. It is never
 * written to disk. The production key service keeps the root in the HSM (S-PLAT B1, SP4).
 */
import {
  DOMAINS, b64url, generateKeyPair, signObject,
  type CertStreamMessage, type Ed25519KeyPair, type EpochMicros, type SigningKeyCert,
} from '@share/iam-lib';

/** `not_after` = `not_before` + `cert_validity` (24 h, est.; C08 "Timeouts"). */
export const CERT_VALIDITY_MICROS = 86_400_000_000n;

export interface CertifyRequest {
  key_id: string;
  purpose: SigningKeyCert['purpose'];
  owner_kind: string;
  slot: number;
  epoch: string;
  public_key: Uint8Array;
}

/** What an owner needs from the key service to get a record-signing key certified. */
export interface KeyCertifier {
  certify(req: CertifyRequest): SigningKeyCert;
}

export class DevKeyService implements KeyCertifier {
  private readonly root: Ed25519KeyPair = generateKeyPair();
  private readonly log: Array<Exclude<CertStreamMessage, { heartbeat: unknown }>> = [];
  private readonly now: () => EpochMicros;

  constructor(now: () => EpochMicros) {
    this.now = now;
  }

  /** The certification root's public key, as installed in every receiver's image. */
  get rootPublicKey(): Uint8Array {
    return this.root.publicKey;
  }

  certify(req: CertifyRequest): SigningKeyCert {
    const not_before = this.now();
    const unsigned: Omit<SigningKeyCert, 'key_service_sig'> = {
      key_id: req.key_id, purpose: req.purpose, owner_kind: req.owner_kind, slot: req.slot, epoch: req.epoch,
      public_key: b64url(req.public_key), not_before, not_after: not_before + CERT_VALIDITY_MICROS,
    };
    const cert: SigningKeyCert = { ...unsigned, key_service_sig: b64url(signObject(DOMAINS.keyCert, unsigned, this.root.privateKey)) };
    this.log.push({ cert, position: String(this.log.length + 1) });
    return cert;
  }

  revoke(key_id: string, reason: string): void {
    const unsigned = { key_id, revoked_at: this.now(), reason };
    const key_service_sig = b64url(signObject(DOMAINS.keyRevoke, unsigned, this.root.privateKey));
    this.log.push({ revocation: { ...unsigned, key_service_sig }, position: String(this.log.length + 1) });
  }

  /** `cert_stream(from_position)`: every certificate and revocation after the position, then one heartbeat. */
  read(fromPosition: string): CertStreamMessage[] {
    const from = Number(BigInt(fromPosition));
    const head = String(this.log.length);
    const unsigned = { head, sent_at: this.now() };
    const heartbeat = { ...unsigned, key_service_sig: b64url(signObject(DOMAINS.certHeartbeat, unsigned, this.root.privateKey)) };
    return [...this.log.slice(from), { heartbeat }];
  }
}
