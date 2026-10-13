/**
 * @share/sec-test-owner — the I1 test owner (plan S-SEC I1 "Test owner"). NOT a production component.
 *
 * A small owner kind on the C01 runtime that is the reference consumer of C08 for S-ACCT and S-MONEY:
 * - accepts principal contexts as C08 §A says (C-01) and copies the principal into the `audit` column;
 * - applies the identity status push as C08 §B and C05 S-1, S-2 say: dedupe by `source`, then per-key
 *   `version`; `key_revoked` is terminal; resolved markers come from `onResolved` on the closure topic.
 */
import type {
  AppendCall, AppendResult, Epoch, FeedEvent, Generation, HlcTs, InboundNotification, OwnerDeclaration, OwnerHooks,
  OwnerRuntime, PartitionKey, SlotNo,
} from '@share/owner-runtime';
import { decodeJson, slotOfPartition } from '@share/owner-runtime';
import {
  CONTEXT_METADATA_KEY, CertStore, auditFromContext, checkContext, decide, hlcToMicros, internalAudit, toRuntimeAudit,
  type AppliedKey, type IdentityStatusEvent, type PolicyBundle, type Tenant, type UnsignedPolicyBundle,
} from '@share/iam-lib';
import type { AuditClient } from '@share/audit';
import { MATRIX_ROW, type OwnerAnswer, type OwnerCommand } from '@share/edge-auth';

export const TEST_KIND = 'sectest';
export const STATUS_TOPIC = 'iam.status.v1';
export const ENTRY = { command: 1, keyStatus: 2 } as const;

export const declaration: OwnerDeclaration = {
  kind: TEST_KIND,
  slotCount: 16,
  entryKinds: [
    { kind: ENTRY.command, name: 'command_applied', schemaVersions: [1], retention: '7y' },
    { kind: ENTRY.keyStatus, name: 'key_status_applied', schemaVersions: [1], retention: '7y' },
  ],
  projections: [
    { name: 'key_state', ddl: 'partition BYTES NOT NULL, key_id STRING NOT NULL, version INT8 NOT NULL, status STRING NOT NULL, PRIMARY KEY (partition, key_id)',
      clearColumns: ['partition', 'key_id', 'version', 'status'] },
    { name: 'applied_source', ddl: 'partition BYTES NOT NULL, source STRING NOT NULL, PRIMARY KEY (partition, source)',
      clearColumns: ['partition', 'source'] },
    { name: 'request', ddl: 'partition BYTES NOT NULL, idempotency_key STRING NOT NULL, seq INT8 NOT NULL, PRIMARY KEY (partition, idempotency_key)',
      clearColumns: ['partition', 'idempotency_key', 'seq'] },
  ],
  streams: [],
};

const T = { keyState: `${TEST_KIND}_key_state`, appliedSource: `${TEST_KIND}_applied_source`, request: `${TEST_KIND}_request` };

export interface TestOwnerOptions {
  runtime: OwnerRuntime;
  certs: CertStore;
  /** Edge workloads allowed to send commands with a principal context (RFC-005 §4.4). */
  edgeAllowlist: ReadonlySet<string>;
  identitySlotOf(tenant: Tenant): number;
  policy: PolicyBundle | UnsignedPolicyBundle;
  /** Records refusals that have no row of their own (C08 §A "recorded where §A says"). */
  audit?: { client: AuditClient; workload: string };
  alert?: (m: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export class TestOwner implements OwnerHooks {
  private readonly o: TestOwnerOptions;
  private readonly rt: OwnerRuntime;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Applied key state per (account, key), from committed push entries (memory of the lease holder). */
  private readonly applied = new Map<string, AppliedKey>();
  /** The last resolved marker per topic partition (C08 §B; consumed through `onResolved`). */
  readonly resolved = new Map<number, HlcTs>();
  readonly resolvedLog: Array<{ partition: number; R: HlcTs }> = [];
  /** Push events applied, with the virtual time they were applied (for the I1 latency check). */
  readonly appliedEvents: Array<{ event: IdentityStatusEvent; appliedAt: HlcTs }> = [];

  constructor(o: TestOwnerOptions) {
    this.o = o;
    this.rt = o.runtime;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Subscribe to the push and its resolved markers. The runtime gives each event and marker once or more. */
  start(): void {
    this.rt.subscribe(STATUS_TOPIC, { positions: [] }, 'committed', (e) => this.onPush(e));
    this.rt.onResolved(STATUS_TOPIC, (p, R) => {
      const prev = this.resolved.get(p);
      if (prev !== undefined && prev >= R) return; // markers never go back; ignore one at or below the last
      this.resolved.set(p, R);
      this.resolvedLog.push({ partition: p, R });
    });
  }

  async onAcquire(_s: SlotNo, _e: Epoch): Promise<void> {
    // TODO(S-ACCT): rebuild applied key state with a catch-up snapshot (C08 §B, C-02); not in I1.
  }
  onRelease(slot: SlotNo): void {
    for (const k of [...this.applied.keys()]) {
      const account = k.split('|')[0] ?? '';
      if (this.slotOf(account) === slot) this.applied.delete(k);
    }
  }
  onReportable(): void {}
  onMovedOut(): void {}
  async onAdopt(_p: PartitionKey, _g: Generation): Promise<void> {}
  async onNotification(_n: InboundNotification): Promise<void> {}

  slotOf(account: string): SlotNo {
    return slotOfPartition(partitionOf(account), declaration.slotCount);
  }

  appliedKey(account: string, keyId: string): AppliedKey | undefined {
    return this.applied.get(`${account}|${keyId}`);
  }

  // ---------------- §A commands with a principal context ----------------

  async command(peerWorkload: string, metadata: Record<typeof CONTEXT_METADATA_KEY, Uint8Array>, cmd: OwnerCommand): Promise<OwnerAnswer> {
    const partition = partitionOf(cmd.account);
    const tenant: Tenant = { kind: 'account', account: cmd.account };
    const keyIdOf = (bytes: Uint8Array): string | undefined => {
      try { return (JSON.parse(Buffer.from(bytes).toString('utf8')) as { key_id?: string }).key_id; } catch { return undefined; }
    };
    const keyId = keyIdOf(metadata[CONTEXT_METADATA_KEY]);
    const appliedKey = keyId === undefined ? undefined : this.appliedKey(cmd.account, keyId);
    const v = checkContext(metadata[CONTEXT_METADATA_KEY], {
      peerWorkload, allowlist: this.o.edgeAllowlist, now: hlcToMicros(this.rt.now().ts), partitionTenant: tenant,
      certs: this.o.certs, identitySlotOf: this.o.identitySlotOf, policyVersionApplied: this.o.policy.policy_version,
      ...(appliedKey ? { appliedKey } : {}),
    });
    if (!v.ok) {
      await this.recordRefusal(peerWorkload, cmd, v.reason);
      return v.answer === 'peer_refused' ? { kind: 'unauthenticated' } : { kind: v.answer };
    }
    const ctx = v.ctx;
    const d = decide(ctx, MATRIX_ROW[cmd.op], { kind: 'account', tenant }, this.o.policy);
    if (d.result !== 'permit') {
      return d.result === 'refused' ? { kind: 'refused', right: d.right } : { kind: d.result };
    }
    if (cmd.op === 'status') {
      if (!this.rt.leaseValid(this.slotOf(cmd.account)).valid) return { kind: 'temporarily_unavailable' };
      return { kind: 'ok', body: { account: cmd.account, status: 'none' } };
    }
    const idem = cmd.idempotencyKey ?? ctx.request_id;
    const reqRef = { table: T.request, key: { partition, idempotency_key: idem } };
    const keyRef = { table: T.keyState, key: { partition, key_id: ctx.key_id ?? '' } };
    const identity = new Uint8Array(Buffer.from(`cmd:${idem}`, 'utf8'));
    let refusedInBatch = false;
    let duplicate: { seq: bigint } | undefined;
    const call: AppendCall = {
      partition,
      reads: [reqRef, keyRef],
      decide: (bctx) => {
        refusedInBatch = false;
        duplicate = bctx.read(reqRef) as { seq: bigint } | undefined;
        if (duplicate) return null;
        // In the batch: a key applied as revoked since the check refuses the command (C08 §B).
        const ks = bctx.read(keyRef) as { status: string } | undefined;
        if (ks?.status === 'revoked') { refusedInBatch = true; return null; }
        const seq = bctx.head(partition).seq + 1n;
        return {
          entries: [{ kind: ENTRY.command, schemaV: 1, identity, audit: toRuntimeAudit(auditFromContext(ctx)),
            payload: { op: cmd.op, account: cmd.account, key_id: ctx.key_id, idempotency_key: idem, body: cmd.body ?? null } }],
          projections: [{ table: T.request, op: 'upsert', key: { partition, idempotency_key: idem }, row: { seq } }],
        };
      },
    };
    const r = await this.appendWithRetry(call);
    if (r.r === 'Committed') return { kind: 'ok', body: { applied: cmd.op, seq: r.seqFrom.toString() } };
    if (r.r === 'ConditionFailed') {
      if (duplicate) return { kind: 'ok', body: { applied: cmd.op, seq: duplicate.seq.toString(), duplicate: true } };
      if (refusedInBatch) return { kind: 'unauthenticated' };
    }
    return { kind: 'temporarily_unavailable' };
  }

  private async recordRefusal(peerWorkload: string, cmd: OwnerCommand, reason: string): Promise<void> {
    if (!this.o.audit) return;
    const record = { ...internalAudit(this.o.audit.workload), event: 'context_refused',
      new: { reason, peer: peerWorkload, account: cmd.account, op: cmd.op } };
    await this.o.audit.client.append(this.o.audit.workload, { source_ref: `refusal:${cmd.account}:${cmd.idempotencyKey ?? cmd.op}:${reason}`, record });
  }

  // ---------------- §B the identity status push ----------------

  private async onPush(e: FeedEvent): Promise<void> {
    const ev = decodeJson(e.value) as IdentityStatusEvent & { committed_at: bigint | string };
    if (ev.schema !== 'iam.status.v1') { this.o.alert?.(`unknown schema ${String(ev.schema)}`); return; }
    const account = ev.account;
    if (!this.rt.leaseValid(this.slotOf(account)).valid) return; // another process holds the slot
    const partition = partitionOf(account);
    const source = `${ev.source.identity_partition}:${ev.source.seq}`;
    const srcRef = { table: T.appliedSource, key: { partition, source } };
    const body = ev.body;
    if (body.kind !== 'key_issued' && body.kind !== 'key_revoked') {
      this.o.alert?.(`event kind ${body.kind} treated as no status change (I1)`);
      return;
    }
    const keyRef = { table: T.keyState, key: { partition, key_id: body.key_id } };
    const next: AppliedKey = { version: body.version, status: body.kind === 'key_revoked' ? 'revoked' : 'active',
      ...(body.kind === 'key_issued' ? { limits: body.limits } : {}) };
    const identity = new Uint8Array(Buffer.from(`push:${source}`, 'utf8'));
    let changed = false;
    const r = await this.appendWithRetry({
      partition,
      reads: [srcRef, keyRef],
      decide: (bctx) => {
        changed = false;
        if (bctx.read(srcRef) !== undefined) return null;              // the only dedupe rule: source applied
        const cur = bctx.read(keyRef) as { version: number; status: string } | undefined;
        // Per key the highest version wins; revoked is terminal. No change ⇒ no entry.
        if (cur && (cur.status === 'revoked' || cur.version >= next.version)) return null;
        changed = true;
        return {
          entries: [{ kind: ENTRY.keyStatus, schemaV: 1, identity, audit: toRuntimeAudit(internalAudit('spiffe://share/sectest/holder')),
            payload: { source, key_id: body.key_id, version: next.version, status: next.status } }],
          projections: [
            { table: T.keyState, op: 'upsert', key: { partition, key_id: body.key_id }, row: { version: next.version, status: next.status } },
            { table: T.appliedSource, op: 'upsert', key: { partition, source }, row: {} },
          ],
        };
      },
    });
    if (r.r === 'Committed' && changed) {
      this.applied.set(`${account}|${body.key_id}`, next);
      this.appliedEvents.push({ event: { ...ev, committed_at: BigInt(ev.committed_at) }, appliedAt: this.rt.now().ts });
    }
  }

  /** C01 §3.2 result handling (CC-1) with the same identity on every retry. */
  private async appendWithRetry(call: AppendCall): Promise<AppendResult> {
    let last: AppendResult = { r: 'Retry' };
    for (let attempt = 0; attempt < 6; attempt++) {
      last = await this.rt.append(call);
      switch (last.r) {
        case 'Committed': case 'ConditionFailed': case 'Stopped': case 'StaleEpoch': case 'Moved':
          return last;
        case 'Overloaded':
          await this.sleep(last.retryAfterMs);
          continue;
        case 'Retry': case 'Ambiguous': case 'Moving':
          await this.sleep(20 * (attempt + 1));
          continue;
        default:
          this.o.alert?.(`unknown AppendResult ${(last as { r: string }).r}; treated as Retry (C01 §8)`);
          continue;
      }
    }
    return last;
  }
}

export function partitionOf(account: string): PartitionKey {
  return new Uint8Array(Buffer.from(account, 'utf8'));
}

