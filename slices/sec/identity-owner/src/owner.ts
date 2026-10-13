/**
 * The identity owner (RFC-005 §3.1), S-SEC I1 part: key records, the identity status push (C08 §B, through
 * the outbox as `emits`), the edge stream with signed heartbeats (C08 §C) and `get_policy` with one static
 * bundle (C08 §N).
 */
import type {
  AppendResult, Epoch, Generation, InboundNotification, OwnerHooks, OwnerRuntime, PartitionKey, SlotNo,
} from '@share/owner-runtime';
import { hex, slotOfPartition } from '@share/owner-runtime';
import {
  DOMAINS, IDENTITY_CERT_OWNER_KIND, b64url, generateKeyPair, hlcToMicros, internalAudit, policyV1, signObject,
  tenantPartition, tenantText, toRuntimeAudit,
  type CredentialRecord, type Ed25519KeyPair, type EdgeStreamMessage, type Heartbeat, type IdentityStatusEvent,
  type KeyLimits, type PolicyBundle, type SignedKeyRecord, type SigningKeyCert, type StatusActor, type Tenant,
} from '@share/iam-lib';
import type { KeyCertifier } from '@share/key-service';
import { ENTRY, IAM_KIND, IAM_SLOTS } from './declaration.ts';

export const DEFAULT_LIMITS: KeyLimits = { key_spend_limit_micro_usd: null, key_inflight_limit_mbps: null, key_rate_limit_per_s: 50 };

export type KeyCommandAnswer =
  | { ok: true; key_id: string; version: number; changed: boolean }
  | { ok: false; reason: 'not_found' | 'temporarily_unavailable' | 'not_owner' | 'retry_later' };

interface Signer { epoch: Epoch; keyId: string; pair: Ed25519KeyPair; cert: SigningKeyCert }
interface KeyRow { version: number; status: 'active' | 'revoked'; verifier: Uint8Array; limits: KeyLimits; probe: boolean; tenant: string }
interface StreamItem { position: bigint; msg: Extract<EdgeStreamMessage, { record: unknown }> }

export interface IdentityOwnerOptions {
  runtime: OwnerRuntime;
  certifier: KeyCertifier;
  /** The workload identity of this identity process (recorded in audit fields). */
  workload?: string;
  alert?: (message: string) => void;
  /** Wait before a retry (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

const KEY_TABLE = `${IAM_KIND}_key`;
const POLICY_PARTITION = new Uint8Array(Buffer.from('policy', 'utf8'));

export class IdentityOwner implements OwnerHooks {
  private readonly rt: OwnerRuntime;
  private readonly certifier: KeyCertifier;
  private readonly workload: string;
  private readonly alert: (m: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly signers = new Map<SlotNo, Signer>();
  private readonly streams = new Map<SlotNo, StreamItem[]>();

  constructor(o: IdentityOwnerOptions) {
    this.rt = o.runtime;
    this.certifier = o.certifier;
    this.workload = o.workload ?? 'spiffe://share/iam/holder';
    this.alert = o.alert ?? ((m) => console.error(`iam: ${m}`));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAttempts = o.maxAttempts ?? 6;
  }

  // ---------------- hooks ----------------

  async onAcquire(slot: SlotNo, epoch: Epoch): Promise<void> {
    this.newSigner(slot, epoch);
    // TODO(I2): rebuild the slot's edge-stream records from the log, and take a snapshot (C08 §C).
    if (!this.streams.has(slot)) this.streams.set(slot, []);
  }
  onRelease(slot: SlotNo): void {
    this.signers.delete(slot);
    this.streams.delete(slot);
  }
  onReportable(): void {}
  onMovedOut(): void {}
  async onAdopt(_p: PartitionKey, _g: Generation): Promise<void> {}
  async onNotification(_n: InboundNotification): Promise<void> {}

  /** The record-signing key of a slot for the current lease epoch, certified by the key service (RFC-005 §10). */
  private signerFor(slot: SlotNo): Signer {
    const epoch = this.rt.epoch(slot);
    const s = this.signers.get(slot);
    return s && s.epoch === epoch ? s : this.newSigner(slot, epoch);
  }

  private newSigner(slot: SlotNo, epoch: Epoch): Signer {
    const pair = generateKeyPair();
    const keyId = `identity-${slot}-${epoch}-${b64url(pair.publicKey).slice(0, 8)}`;
    const cert = this.certifier.certify({
      key_id: keyId, purpose: 'identity_record', owner_kind: IDENTITY_CERT_OWNER_KIND, slot, epoch: epoch.toString(),
      public_key: pair.publicKey,
    });
    const s: Signer = { epoch, keyId, pair, cert };
    this.signers.set(slot, s);
    return s;
  }

  slotOf(partition: PartitionKey): SlotNo {
    return slotOfPartition(partition, IAM_SLOTS);
  }

  // ---------------- key commands ----------------

  /** Issue an agent key. The caller minted the key; identity keeps only the verifier (RFC-005 §2.1). */
  async issueKey(cmd: { tenant: Tenant; key_id: string; verifier: Uint8Array; limits?: KeyLimits; probe?: boolean;
                        actor: StatusActor; caller: string }): Promise<KeyCommandAnswer> {
    const partition = tenantPartition(cmd.tenant);
    const keyRef = { table: KEY_TABLE, key: { partition, key_id: cmd.key_id } };
    const limits = cmd.limits ?? DEFAULT_LIMITS;
    const probe = cmd.probe ?? false;
    const identity = new Uint8Array(Buffer.from(`issue:${cmd.key_id}`, 'utf8'));
    let existing: KeyRow | undefined;
    return this.keyCommand(partition, cmd.key_id, {
      partition,
      conditions: [],
      reads: [keyRef],
      decide: (ctx) => {
        existing = ctx.read(keyRef) as KeyRow | undefined;
        if (existing) return null;
        const row: KeyRow = { version: 1, status: 'active', verifier: cmd.verifier, limits, probe, tenant: tenantText(cmd.tenant) };
        const event = this.event(cmd.tenant, partition, ctx.head(partition).seq + 1n, hlcToMicros(ctx.ts), cmd.actor,
          { kind: 'key_issued', key_id: cmd.key_id, version: 1, limits, probe });
        return {
          entries: [{ kind: ENTRY.keyIssued, schemaV: 1, identity, audit: toRuntimeAudit(internalAudit(cmd.caller)),
            payload: { key_id: cmd.key_id, tenant: tenantText(cmd.tenant), version: 1, limits, probe, verifier: cmd.verifier },
            emits: [{ stream: 'status', event }] }],
          projections: [{ table: KEY_TABLE, op: 'upsert', key: { partition, key_id: cmd.key_id }, row: { ...row } }],
        };
      },
    }, () => existing ? { ok: true, key_id: cmd.key_id, version: existing.version, changed: false } : undefined,
    (r) => this.recordCommitted(partition, cmd.key_id, cmd.tenant,
      { version: 1, status: 'active', verifier: cmd.verifier, limits, probe, tenant: tenantText(cmd.tenant) }, r));
  }

  /** Revoke an agent key. `key_revoked` is terminal (C08 §B). */
  async revokeKey(cmd: { tenant: Tenant; key_id: string; actor: StatusActor; caller: string }): Promise<KeyCommandAnswer> {
    const partition = tenantPartition(cmd.tenant);
    const keyRef = { table: KEY_TABLE, key: { partition, key_id: cmd.key_id } };
    const identity = new Uint8Array(Buffer.from(`revoke:${cmd.key_id}`, 'utf8'));
    let existing: KeyRow | undefined;
    let next: KeyRow | undefined;
    return this.keyCommand(partition, cmd.key_id, {
      partition,
      reads: [keyRef],
      decide: (ctx) => {
        existing = ctx.read(keyRef) as KeyRow | undefined;
        if (!existing || existing.status === 'revoked') return null;
        next = { ...existing, status: 'revoked', version: existing.version + 1 };
        const event = this.event(cmd.tenant, partition, ctx.head(partition).seq + 1n, hlcToMicros(ctx.ts), cmd.actor,
          { kind: 'key_revoked', key_id: cmd.key_id, version: next.version });
        return {
          entries: [{ kind: ENTRY.keyRevoked, schemaV: 1, identity, audit: toRuntimeAudit(internalAudit(cmd.caller)),
            payload: { key_id: cmd.key_id, version: next.version }, emits: [{ stream: 'status', event }] }],
          projections: [{ table: KEY_TABLE, op: 'upsert', key: { partition, key_id: cmd.key_id }, row: { ...next } }],
        };
      },
    }, () => {
      if (!existing) return { ok: false, reason: 'not_found' };
      return { ok: true, key_id: cmd.key_id, version: existing.version, changed: false };
    }, (r) => (next ? this.recordCommitted(partition, cmd.key_id, cmd.tenant, next, r) : 0));
  }

  private event(tenant: Tenant, partition: PartitionKey, seq: bigint, committed_at: bigint, actor: StatusActor,
                body: IdentityStatusEvent['body']): IdentityStatusEvent {
    if (tenant.kind !== 'account') throw new Error('I1 issues agent keys of buyer accounts only');
    return { schema: 'iam.status.v1', account: tenant.account, source: { identity_partition: hex(partition), seq: seq.toString() },
      committed_at, actor, body };
  }

  /**
   * C01 §3.2 result handling (CC-1): retry with the same identity on Retry, Ambiguous, Moving, Overloaded and on
   * an unknown result (with an alert); never answer success before Committed.
   */
  private async keyCommand(
    partition: PartitionKey, keyId: string, call: Parameters<OwnerRuntime['append']>[0],
    onConditionFailed: () => KeyCommandAnswer | undefined,
    onCommitted: (r: Extract<AppendResult, { r: 'Committed' }>) => number,
  ): Promise<KeyCommandAnswer> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      // C08 §C / V56-3: a record verifies only if its signing cert is valid at `committed_at`. Certify the slot's
      // key for the current epoch BEFORE the append, so `not_before` never postdates the commit it signs.
      this.signerFor(this.slotOf(partition));
      const r = await this.rt.append(call);
      switch (r.r) {
        case 'Committed':
          return { ok: true, key_id: keyId, version: onCommitted(r), changed: true };
        case 'ConditionFailed': {
          const a = onConditionFailed();
          if (a) return a;
          return { ok: false, reason: 'retry_later' };
        }
        case 'Stopped':
          return { ok: false, reason: 'temporarily_unavailable' };
        case 'StaleEpoch': case 'Moved':
          return { ok: false, reason: 'not_owner' };
        case 'Retry': case 'Ambiguous': case 'Moving':
          await this.sleep(20 * (attempt + 1));
          continue;
        case 'Overloaded':
          await this.sleep(r.retryAfterMs);
          continue;
        default:
          this.alert(`unknown AppendResult ${(r as { r: string }).r}; treated as Retry (C01 §8)`);
          await this.sleep(20 * (attempt + 1));
          continue;
      }
    }
    return { ok: false, reason: 'retry_later' };
  }

  /** After Committed: sign the edge record and the key record, in commit order of the slot (C08 §C). */
  private recordCommitted(partition: PartitionKey, keyId: string, tenant: Tenant, row: KeyRow,
                          r: Extract<AppendResult, { r: 'Committed' }>): number {
    const slot = this.slotOf(partition);
    const signer = this.signerFor(slot);
    const items = this.streams.get(slot) ?? [];
    this.streams.set(slot, items);
    // One batch is in flight per slot (C01 §3.2), so Committed answers arrive in commit order of the slot.
    // C01 gives no slot-wide sequence; the position is this holder's count (runtime API gap, STATUS-I1.md).
    const position = BigInt(items.length + 1);
    const committed_at = hlcToMicros(r.ts);
    const unsignedRecord: Omit<CredentialRecord, 'signature'> = {
      identity_slot: slot, epoch: signer.epoch.toString(), position: position.toString(), committed_at, version: row.version,
      body: { kind: 'agent_key', key_id: keyId, verifier_sha256: b64url(row.verifier), tenant, limits: row.limits,
              status: row.status, probe: row.probe },
    };
    const unsignedKeyRecord: Omit<SignedKeyRecord, 'signature'> = {
      key_id: keyId, identity_slot: slot, epoch: signer.epoch.toString(), tenant, status: row.status, limits: row.limits,
      version: row.version, committed_at, probe: row.probe,
    };
    items.push({
      position,
      msg: {
        record: { ...unsignedRecord, signature: { key_id: signer.keyId, sig: b64url(signObject(DOMAINS.edgeRecord, unsignedRecord, signer.pair.privateKey)) } },
        key_record: { ...unsignedKeyRecord, signature: { key_id: signer.keyId, sig: b64url(signObject(DOMAINS.keyRecord, unsignedKeyRecord, signer.pair.privateKey)) } },
      },
    });
    return row.version;
  }

  // ---------------- §C edge stream ----------------

  /**
   * `edge_stream(identity_slot, from_position)`, one poll: every record after `from_position` in commit order,
   * then one heartbeat sent only after them. A holder without a valid lease sends nothing (heartbeat fencing).
   */
  edgeStream(slot: SlotNo, fromPosition: string): EdgeStreamMessage[] {
    if (!this.rt.leaseValid(slot).valid) return [];
    const signer = this.signerFor(slot);
    const from = BigInt(fromPosition);
    const items = this.streams.get(slot) ?? [];
    const out: EdgeStreamMessage[] = items.filter((i) => i.position > from).map((i) => i.msg);
    const unsigned: Omit<Heartbeat, 'signature'> = {
      identity_slot: slot, epoch: signer.epoch.toString(), head: String(items.length),
      // TODO(I2): sent_at from the consistent read of the slot's head row (R46-03); the double gives `now`.
      sent_at: hlcToMicros(this.rt.now().ts),
    };
    out.push({ heartbeat: { ...unsigned, signature: { key_id: signer.keyId, sig: b64url(signObject(DOMAINS.edgeHeartbeat, unsigned, signer.pair.privateKey)) } } });
    return out;
  }

  // ---------------- §N get_policy ----------------

  /** `get_policy`: the one static bundle of I1, signed by the policy partition's slot key. */
  getPolicy(version?: number): PolicyBundle | { kind: 'not_found' } {
    if (version !== undefined && version !== 1) return { kind: 'not_found' };
    const slot = this.slotOf(POLICY_PARTITION);
    const signer = this.signerFor(slot);
    const unsigned = policyV1(slot, signer.cert.not_before);
    return { ...unsigned, signature: { key_id: signer.keyId, sig: b64url(signObject(DOMAINS.policy, unsigned, signer.pair.privateKey)) } };
  }
}
