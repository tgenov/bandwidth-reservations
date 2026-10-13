/**
 * The edge gateway, S-SEC I1 part: RFC-005 §2.2 pipeline steps 1 (mTLS identity given by the caller), 3, 4, 5,
 * 6 (coarse, with the I1 bundle), 8 (forward once) and 9 (logs without keys), and the uniform unauthenticated
 * answer of §2.3 with the ‹unauth_floor›. Steps 2 and 7 (shedding, advisory counters, poll limiter) are I2.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { PartitionKey, SlotOfAnswer } from '@share/owner-runtime';
import {
  CONTEXT_METADATA_KEY, CONTEXT_TTL_MICROS, OPS, decide, encodeContext, parseKey, secretMatches,
  type EpochMicros, type Operation, type PolicyBundle, type PrincipalContext, type UnsignedPolicyBundle,
} from '@share/iam-lib';
import type { EdgeReplica } from './replica.ts';

/** ‹unauth_floor›: no unauthenticated answer earlier than 5 ms after the request arrived (RFC-005 §2.3). */
export const UNAUTH_FLOOR_MICROS = 5_000n;

export interface EdgeClock {
  nowMicros(): EpochMicros;
  /** Resolve at or after `t` (µs). */
  waitUntil(t: EpochMicros): Promise<void>;
}

const BASE_WALL_MICROS = BigInt(Date.now()) * 1000n;
const BASE_HR_NS = process.hrtime.bigint();

/** A monotonic wall clock: a timer for whole milliseconds, then a short spin (at most 1 ms) to the instant. */
export const wallClock: EdgeClock = {
  nowMicros: () => BASE_WALL_MICROS + (process.hrtime.bigint() - BASE_HR_NS) / 1000n,
  waitUntil: async (t) => {
    const remaining = t - wallClock.nowMicros();
    if (remaining > 1_000n) await new Promise((r) => setTimeout(r, Number(remaining / 1000n) - 1));
    while (wallClock.nowMicros() < t) { /* spin to the floor */ }
  },
};

export type EdgeOperation = 'book' | 'change' | 'cancel' | 'status' | 'balance' | 'statement' | 'issue_key';

/** Permission-matrix row of each operation (RFC-005 §4.2). Rows not in the I1 bundle are denied by `decide`. */
export const MATRIX_ROW: Record<EdgeOperation, Operation> = {
  book: OPS.bookingSubmit, change: OPS.bookingSubmit, cancel: OPS.bookingSubmit,
  status: OPS.bookingStatus, balance: OPS.bookingStatus, statement: 'statement.read', issue_key: 'key.issue',
};

export interface EdgeRequest {
  authorization?: string;
  operation: EdgeOperation;
  /** The account the call names in its path or body, if any. */
  account?: string;
  idempotencyKey?: string;
  body?: unknown;
}

export interface OwnerCommand { op: EdgeOperation; account: string; idempotencyKey?: string; body?: unknown }

export type OwnerAnswer =
  | { kind: 'ok'; body: unknown }
  | { kind: 'not_found' }
  | { kind: 'unauthenticated' }
  | { kind: 'refused'; right: string }
  | { kind: 'temporarily_unavailable' };

/** Forward once to the owner-lease holder of the slot (C01 `route`/`slotOf`; gRPC with mTLS in production). */
export interface Forwarder {
  forward(to: { slot: number; partition: PartitionKey }, metadata: Record<typeof CONTEXT_METADATA_KEY, Uint8Array>,
          peerWorkload: string, cmd: OwnerCommand): Promise<OwnerAnswer>;
}

export interface EdgeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  answeredAt: EpochMicros;
  forwarded: boolean;
}

export interface EdgeGatewayOptions {
  replica: EdgeReplica;
  policy: PolicyBundle | UnsignedPolicyBundle;
  /** Placement's account slot map, through C01 `slotOf`. */
  router: { slotOf(account: PartitionKey): SlotOfAnswer };
  forwarder: Forwarder;
  clock: EdgeClock;
  workload: string;
  region?: 'R1' | 'R2';
  /** Collect the time of steps 3 to 6 (ns), for the I1 measurement. */
  measure?: bigint[];
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const UNAUTH_BODY = '{"error":"unauthenticated"}';
/** A fixed verifier for unknown key identifiers, so the work is the same (RFC-005 §2.2 step 4). */
const DUMMY_VERIFIER = new Uint8Array(randomBytes(32));

export class EdgeGateway {
  private readonly o: EdgeGatewayOptions;
  /** HMAC-SHA-256 log-index key (dev: random per process; production: from the secrets service). */
  private readonly logKey = randomBytes(32);
  readonly logs: Array<Record<string, string>> = [];

  constructor(o: EdgeGatewayOptions) {
    this.o = o;
  }

  async handle(req: EdgeRequest): Promise<EdgeResponse> {
    const received = this.o.clock.nowMicros();
    const t0 = process.hrtime.bigint();
    const request_id = randomBytes(16).toString('hex');

    // Step 9 (in part): an idempotency key with no alphanumeric character is malformed.
    if (req.idempotencyKey !== undefined && !/[A-Za-z0-9]/.test(req.idempotencyKey)) {
      return this.answer(400, { error: 'not_accepted', code: 'malformed' }, false);
    }

    // Step 3: credential parse and check digit.
    const bearer = /^Bearer (\S+)$/.exec(req.authorization ?? '')?.[1];
    const parsed = bearer === undefined ? undefined : parseKey(bearer);
    if (!parsed || parsed.prefix !== 'shk') {
      // The same comparison work as for a known key, then the uniform answer.
      secretMatches(new Uint8Array(32), DUMMY_VERIFIER);
      return this.unauthenticated(received, request_id, req, t0);
    }

    // Step 4: authentication from the replica.
    const now = this.o.clock.nowMicros();
    const entry = this.o.replica.key(parsed.key_id);
    const ok = secretMatches(parsed.secret, entry ? entry.verifier : DUMMY_VERIFIER);
    if (!entry || !ok) return this.unauthenticated(received, request_id, req, t0);
    const rec = entry.record;
    const slot = rec.identity_slot;
    if (!this.o.replica.fresh(slot, now)) return this.temporarilyUnavailable(request_id, req, t0);
    if (rec.body.status !== 'active' || !this.o.replica.recordStillCertified(entry, now)) {
      return this.unauthenticated(received, request_id, req, t0);
    }
    const tenant = rec.body.tenant;
    if (tenant.kind !== 'account') return this.unauthenticated(received, request_id, req, t0);

    // Step 5: principal context (C08 §A), with the identity-signed key record.
    const ctx: PrincipalContext = {
      schema: 'principal.v1',
      // The edge record of an agent key carries no principal_id; the key id is the key principal's identifier.
      principal_id: parsed.key_id,
      kind: rec.body.probe ? 'probe' : 'agent_key',
      tenant,
      rights: { administrator: false },
      key_id: parsed.key_id,
      auth: { method: 'agent_key', at: now },
      iam_position: { identity_slot: slot, head: this.o.replica.position(slot) },
      ...(entry.keyRecord ? { key_record: entry.keyRecord } : {}),
      probe: rec.body.probe,
      request_id,
      received_at: received,
      edge_region: this.o.region ?? 'R1',
      edge_workload: this.o.workload,
      expires_at: received + CONTEXT_TTL_MICROS,
      policy_version: this.o.policy.policy_version,
    };

    // Step 6: coarse authorisation. A call naming another account gets the "not found" answer, not forwarded.
    const named = req.account === undefined ? tenant : { kind: 'account' as const, account: req.account };
    const d = decide(ctx, MATRIX_ROW[req.operation], { kind: 'account', tenant: named }, this.o.policy);
    this.o.measure?.push(process.hrtime.bigint() - t0);
    if (d.result === 'not_found') return this.done(404, { error: 'not_found' }, request_id, req, false);
    if (d.result === 'refused') return this.done(403, { error: 'refused', right: d.right }, request_id, req, false);
    if (d.result === 'unauthenticated') return this.unauthenticated(received, request_id, req);

    // Step 8: forward once to the holder of the principal's tenant's slot, never by an identifier in the request.
    const partition = new Uint8Array(Buffer.from(tenant.account, 'utf8'));
    const target = { slot: this.o.router.slotOf(partition).slot, partition };
    const a = await this.o.forwarder.forward(target, { [CONTEXT_METADATA_KEY]: encodeContext(ctx) }, this.o.workload, {
      op: req.operation, account: tenant.account,
      ...(req.idempotencyKey === undefined ? {} : { idempotencyKey: req.idempotencyKey }),
      ...(req.body === undefined ? {} : { body: req.body }),
    });
    switch (a.kind) {
      case 'ok': return this.done(200, a.body, request_id, req, true);
      case 'not_found': return this.done(404, { error: 'not_found' }, request_id, req, true);
      case 'refused': return this.done(403, { error: 'refused', right: a.right }, request_id, req, true);
      case 'temporarily_unavailable': return this.done(503, { error: 'temporarily_unavailable' }, request_id, req, true, { 'retry-after': '1' });
      case 'unauthenticated': return this.unauthenticated(received, request_id, req, undefined, true);
    }
  }

  /** RFC-005 §2.3: one answer for every cause, identical in status, body and headers, after the floor. */
  private async unauthenticated(received: EpochMicros, request_id: string, req: EdgeRequest, t0?: bigint, forwarded = false): Promise<EdgeResponse> {
    if (t0 !== undefined) this.o.measure?.push(process.hrtime.bigint() - t0);
    this.log(request_id, req, 401);
    await this.o.clock.waitUntil(received + UNAUTH_FLOOR_MICROS);
    return { status: 401, headers: { ...JSON_HEADERS }, body: UNAUTH_BODY, answeredAt: this.o.clock.nowMicros(), forwarded };
  }

  private temporarilyUnavailable(request_id: string, req: EdgeRequest, t0: bigint): EdgeResponse {
    this.o.measure?.push(process.hrtime.bigint() - t0);
    return this.done(503, { error: 'temporarily_unavailable' }, request_id, req, false, { 'retry-after': '1' });
  }

  private done(status: number, body: unknown, request_id: string, req: EdgeRequest, forwarded: boolean, extra: Record<string, string> = {}): EdgeResponse {
    this.log(request_id, req, status);
    return this.answer(status, body, forwarded, extra);
  }

  private answer(status: number, body: unknown, forwarded: boolean, extra: Record<string, string> = {}): EdgeResponse {
    return { status, headers: { ...JSON_HEADERS, ...extra }, body: JSON.stringify(body), answeredAt: this.o.clock.nowMicros(), forwarded };
  }

  /** Step 9: the edge never logs an idempotency key, only its keyed digest. It never logs a credential. */
  private log(request_id: string, req: EdgeRequest, status: number): void {
    const line: Record<string, string> = { request_id, op: req.operation, status: String(status) };
    if (req.idempotencyKey !== undefined) {
      line['idempotency_key_digest'] = createHmac('sha256', this.logKey).update(req.idempotencyKey).digest('base64url');
    }
    this.logs.push(line);
  }
}
