/**
 * C08 provider suite, the parts that the account slice consumes: §A the principal context that the edge
 * builds for an agent key, and §B the identity status push and `catch_up`. Tests come from C08 "Conformance
 * tests" (P-02, P-16) and from the §A schema rules.
 *
 * A subject gives each part it provides. A real provider names a part that it does not provide yet as pending,
 * and the suite registers a visible PENDING entry for it. A double gives only the parts that it stands in for.
 *
 * The types are copied from C08 "Schema" (the subset that the tests use).
 */
import assert from 'node:assert/strict';
import { isPending, pendingProvider, subjectTest, type Closable, type Pending, type SubjectFactory } from './support.ts';

// ---------- C08 "Schema" (subset) ----------

export type C08Tenant = { kind: 'account'; account: string } | { kind: 'supplier'; supplier: string } | { kind: 'none' };
export interface C08KeyLimits { key_spend_limit_micro_usd: bigint | null; key_inflight_limit_mbps: bigint | null; key_rate_limit_per_s: number }

export interface C08SignedKeyRecord {
  key_id: string; identity_slot: number; epoch: string; tenant: C08Tenant; status: 'active' | 'revoked';
  limits: C08KeyLimits; version: number; committed_at: bigint; probe: boolean; signature: { key_id: string; sig: string };
}

export interface C08PrincipalContext {
  schema: 'principal.v1'; principal_id: string; kind: string; tenant: C08Tenant; rights: { administrator: boolean };
  key_id?: string; auth: { method: string; at: bigint }; iam_position: { identity_slot: number; head: string };
  key_record?: C08SignedKeyRecord; probe: boolean; request_id: string; received_at: bigint;
  edge_region: 'R1' | 'R2'; edge_workload: string; expires_at: bigint; policy_version: number;
}

export interface C08StatusEvent {
  schema: 'iam.status.v1'; account: string; source: { identity_partition: string; seq: string }; committed_at: bigint;
  actor: { kind: string };
  body: { kind: 'key_issued'; key_id: string; version: number; limits: C08KeyLimits; probe: boolean }
    | { kind: 'key_limits_changed'; key_id: string; version: number; limits: C08KeyLimits }
    | { kind: 'key_revoked'; key_id: string; version: number }
    | { kind: 'kyb_status'; status: string; version: number };
}

export interface C08SnapshotAccount {
  account: string;
  keys: Array<{ key_id: string; version: number; status: 'active' | 'revoked'; limits: C08KeyLimits; probe: boolean }>;
  kyb: { status: string; version: number };
}
export interface C08CatchUpRequest { account_slot: number; since?: bigint }
export type C08CatchUpAnswer =
  | { kind: 'events'; events: unknown[]; read_timestamp: bigint }
  | { kind: 'snapshot'; state: C08SnapshotAccount[]; position: bigint; read_timestamp: bigint }
  | { kind: 'temporarily_unavailable' };

/** C08 §A: context_ttl = 60 s. */
const CONTEXT_TTL_MICROS = 60_000_000n;
/** C08 §B: the push retention that `catch_up` with `since` covers (7 days). */
const RETENTION_MICROS = 7n * 24n * 3_600n * 1_000_000n;

export interface C08Subject extends Closable {
  /** Issue an active agent key of the account (identity's key command, or the double's set-up). Gives the key id. */
  issueKey(account: string): Promise<string>;
  /** Revoke the key (`key_revoked` is terminal). */
  revokeKey(account: string, keyId: string): Promise<void>;
  /** Move the provider's clock forward. */
  advance(ms: number): Promise<void>;
  /** The provider's present time in µs. */
  nowMicros(): bigint;
  /** §A: the context that the edge forwards for a request with this active key. */
  context?: (account: string, keyId: string) => Promise<C08PrincipalContext>;
  /** §B push: every `IdentityStatusEvent` committed so far, in commit order. */
  pushed?: () => C08StatusEvent[];
  /** §B `catch_up`, with the account slot of an account. */
  catchUp?: { call(req: C08CatchUpRequest): Promise<C08CatchUpAnswer>; accountSlot(account: string): number };
}

/**
 * Register the C08 provider suite. `parts` names the parts that the subjects of `make` provide, so the suite
 * can register their tests before it makes a subject; a pending part gives its PENDING entry.
 */
export function runC08ProviderSuite(
  name: string, parts: { context?: true | Pending; pushed?: true | Pending; catchUp?: true | Pending }, make: SubjectFactory<C08Subject>,
): void {
  const t = (id: string, behaviour: string, body: (s: C08Subject) => Promise<void>): void =>
    subjectTest('C08', id, name, behaviour, make, body);

  if (isPending(parts.context)) pendingProvider('C08 §A', name, parts.context.pending, 'principal context for an agent key');
  else if (parts.context) {
    t('§A', 'an agent-key context has the credential tenant, the key id, a matching key record and expires 60 s after receipt', async (s) => {
      const keyId = await s.issueKey('b1');
      const ctx = await part(s.context)('b1', keyId);
      assert.equal(ctx.schema, 'principal.v1');
      assert.equal(ctx.kind, 'agent_key');
      assert.deepEqual(ctx.tenant, { kind: 'account', account: 'b1' });
      assert.equal(ctx.key_id, keyId);
      assert.equal(ctx.auth.method, 'agent_key');
      assert.deepEqual(ctx.rights, { administrator: false });
      assert.equal(ctx.probe, false);
      assert.ok(ctx.principal_id.length > 0 && ctx.request_id.length > 0 && ctx.edge_workload.length > 0);
      assert.ok(ctx.edge_region === 'R1' || ctx.edge_region === 'R2');
      assert.ok(Number.isInteger(ctx.policy_version) && ctx.policy_version >= 1);
      assert.equal(ctx.expires_at - ctx.received_at, CONTEXT_TTL_MICROS);
      assert.ok(ctx.received_at <= ctx.auth.at && ctx.auth.at < ctx.expires_at);
      const kr = ctx.key_record;
      assert.ok(kr, 'C08 §A: key_record is present for agent_key');
      assert.deepEqual([kr.key_id, kr.tenant, kr.status, kr.probe], [keyId, { kind: 'account', account: 'b1' }, 'active', false]);
      assert.ok(kr.version >= 1);
      assert.equal(kr.identity_slot, ctx.iam_position.identity_slot);
      assert.ok(kr.committed_at <= ctx.received_at);
      assert.ok(kr.signature.key_id.length > 0);
    });
  }

  if (isPending(parts.pushed)) pendingProvider('C08 §B', name, parts.pushed.pending, 'identity status push');
  else if (parts.pushed) {
    t('P-02', 'each key commit yields exactly one IdentityStatusEvent with its own source; a revocation with no change yields none', async (s) => {
      const keyId = await s.issueKey('b1');
      await s.advance(1_000);
      await s.revokeKey('b1', keyId);
      await s.revokeKey('b1', keyId);
      const ev = part(s.pushed)();
      assert.deepEqual(ev.map((e) => [e.schema, e.account, e.body.kind, 'key_id' in e.body ? e.body.key_id : '', e.body.version]),
        [['iam.status.v1', 'b1', 'key_issued', keyId, 1], ['iam.status.v1', 'b1', 'key_revoked', keyId, 2]]);
      assert.equal(new Set(ev.map((e) => `${e.source.identity_partition}|${e.source.seq}`)).size, 2);
      assert.ok((ev[0]?.committed_at ?? 0n) < (ev[1]?.committed_at ?? 0n));
    });
  }

  if (isPending(parts.catchUp)) pendingProvider('C08 §B', name, parts.catchUp.pending, 'catch_up with and without since');
  else if (parts.catchUp) {
    t('P-16', 'catch_up without since answers a snapshot of the slot: every key with its status and version, position = read_timestamp', async (s) => {
      const k1 = await s.issueKey('b1');
      const k2 = await s.issueKey('b1');
      await s.advance(1_000);
      await s.revokeKey('b1', k2);
      const cu = part(s.catchUp);
      const a = await cu.call({ account_slot: cu.accountSlot('b1') });
      assert.equal(a.kind, 'snapshot');
      if (a.kind !== 'snapshot') return;
      assert.equal(a.position, a.read_timestamp);
      const b1 = a.state.find((x) => x.account === 'b1');
      assert.ok(b1, 'the account of the slot is in the snapshot');
      const keys = new Map(b1.keys.map((k) => [k.key_id, [k.status, k.version]]));
      assert.deepEqual(keys.get(k1), ['active', 1]);
      assert.deepEqual(keys.get(k2), ['revoked', 2]);
    });

    t('P-16', 'catch_up with a since older than the 7-day retention answers a snapshot', async (s) => {
      await s.issueKey('b1');
      const cu = part(s.catchUp);
      const a = await cu.call({ account_slot: cu.accountSlot('b1'), since: s.nowMicros() - RETENTION_MICROS - 1_000_000n });
      assert.equal(a.kind, 'snapshot');
    });

    t('P-02', 'catch_up with a recent since answers the events with committed_at ≥ since, and read_timestamp ≥ each of them', async (s) => {
      const k1 = await s.issueKey('b1');
      await s.advance(5_000);
      const since = s.nowMicros();
      await s.advance(1_000);
      await s.revokeKey('b1', k1);
      const cu = part(s.catchUp);
      const a = await cu.call({ account_slot: cu.accountSlot('b1'), since });
      assert.equal(a.kind, 'events');
      if (a.kind !== 'events') return;
      const events = a.events as C08StatusEvent[];
      assert.deepEqual(events.map((e) => [e.account, e.body.kind, e.body.version]), [['b1', 'key_revoked', 2]]);
      for (const e of events) {
        assert.ok(e.committed_at >= since);
        assert.ok(a.read_timestamp >= e.committed_at);
      }
    });
  }
}

function part<T>(p: T | undefined): T {
  if (p === undefined) throw new Error('the subject does not provide this part, but the suite was told that it does');
  return p;
}
