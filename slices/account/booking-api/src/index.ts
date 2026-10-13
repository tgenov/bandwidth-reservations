/**
 * @share/booking-api: a minimal C10 v1.0.0 HTTP endpoint (AM-I1) with `book` and `status`.
 *
 * It plays the edge of RFC-005 for these two operations only: it authenticates the bearer
 * credential through an `EdgeIdentity` (an edge double until S-SEC delivers the edge), builds the
 * C08 §A principal context, refuses malformed input with `400 NotAccepted{malformed}` (nothing
 * recorded, key not consumed), and forwards the submission once to the account owner of the
 * credential's account. The owner gives the C10 answer; this file only writes it as HTTP.
 *
 * The gRPC hop from the edge to the owner is internal and not part of C10. In AM-I1 the owner is
 * in the same process.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  isValidIdempotencyKey, type AccountOwner, type BookRequest, type C10Answer, type PrincipalContext, type StatusReader,
} from '@share/account-owner';

/** RFC-005 §13: no unauthenticated answer before 5 ms after arrival. */
export const UNAUTH_FLOOR_MS = 5;
const CONTEXT_TTL_US = 60_000_000n;
const MAX_BODY_BYTES = 64 * 1024;

/** The edge's view of a credential. `undefined` for every unauthenticated cause. */
export interface EdgeIdentity {
  resolve(authorization: string | undefined, nowMs: number): PrincipalContext | undefined;
}

export interface Credential { account: string; principalId: string; kind: 'agent_key' | 'account_user'; keyId?: string }

/** An edge double: fixed bearer tokens. A token is `shk_<key id>_<secret>` for an agent key. */
export class StaticEdgeIdentity implements EdgeIdentity {
  private readonly tokens: Map<string, Credential>;
  constructor(tokens: Record<string, Credential>) {
    this.tokens = new Map(Object.entries(tokens));
  }

  resolve(authorization: string | undefined, nowMs: number): PrincipalContext | undefined {
    const m = /^Bearer (\S+)$/.exec(authorization ?? '');
    const cred = m ? this.tokens.get(m[1]!) : undefined;
    if (!cred) return undefined;
    const now = BigInt(Math.floor(nowMs)) * 1_000n;
    const ctx: PrincipalContext = {
      schema: 'principal.v1', principal_id: cred.principalId, kind: cred.kind,
      tenant: { kind: 'account', account: cred.account }, rights: { administrator: false },
      auth: { method: cred.kind === 'agent_key' ? 'agent_key' : 'oidc_token', at: now },
      iam_position: { identity_slot: 0, head: '1' }, probe: false,
      request_id: randomUUID().replaceAll('-', ''), received_at: now,
      edge_region: 'R1', edge_workload: 'booking-api-dev', expires_at: now + CONTEXT_TTL_US, policy_version: 1,
    };
    if (cred.keyId !== undefined) ctx.key_id = cred.keyId;
    return ctx;
  }
}

export interface BookingApiOptions {
  owner: AccountOwner;
  reader: StatusReader;
  identity: EdgeIdentity;
  /** Wall clock in ms for the principal context. Default: Date.now. */
  wallMs?: () => number;
  /** Monotonic clock in ms for the ack rule. Default: performance.now. */
  monoMs?: () => number;
}

export function createBookingApi(o: BookingApiOptions): Server {
  const wallMs = o.wallMs ?? (() => Date.now());
  const monoMs = o.monoMs ?? (() => performance.now());
  return createServer((req, res) => {
    const receivedAtMono = monoMs();
    handle(o, req, res, receivedAtMono, wallMs).catch(() => {
      send(res, { http: 503, body: { error: 'temporarily_unavailable' }, retryAfterS: 1 });
    });
  });
}

async function handle(o: BookingApiOptions, req: IncomingMessage, res: ServerResponse, receivedAtMono: number, wallMs: () => number): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://edge');
  const isBook = req.method === 'POST' && url.pathname === '/v1/bookings';
  const statusMatch = req.method === 'GET' ? /^\/v1\/requests\/([^/]+)$/.exec(url.pathname) : null;
  if (!isBook && !statusMatch) {
    await drain(req);
    return send(res, { http: 404, body: { error: 'not_found' } });
  }
  const ctx = o.identity.resolve(req.headers.authorization, wallMs());
  if (!ctx || ctx.tenant.kind !== 'account') {
    await drain(req);
    // Timers can fire a little early, so wait again until the floor has passed.
    for (let wait = UNAUTH_FLOOR_MS - (performance.now() - receivedAtMono); wait > 0; wait = UNAUTH_FLOOR_MS - (performance.now() - receivedAtMono)) {
      await new Promise((r) => setTimeout(r, Math.ceil(wait)));
    }
    return send(res, { http: 401, body: { error: 'unauthenticated' } });
  }
  const account = ctx.tenant.account;
  if (statusMatch) {
    const key = decodeURIComponent(statusMatch[1]!);
    if (!isValidIdempotencyKey(key)) return send(res, malformed());
    return send(res, o.reader.status(account, ctx, key));
  }
  const key = header(req, 'idempotency-key');
  const raw = await readBody(req);
  if (key === undefined || !isValidIdempotencyKey(key) || raw === undefined) return send(res, malformed());
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return send(res, malformed()); }
  const body = asBookRequest(parsed);
  if (!body) return send(res, malformed());
  return send(res, await o.owner.book(account, { principal: ctx, key, body, receivedAtMono }));
}

/** C10 "Malformed or invalid": JSON types, required fields and enums. Rules are the owner's (E1′). */
export function asBookRequest(v: unknown): BookRequest | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o['legs']) || !o['legs'].every((l) => typeof l === 'string')) return undefined;
  const w = o['window'];
  if (typeof w !== 'object' || w === null || Array.isArray(w)) return undefined;
  const win = w as Record<string, unknown>;
  if (typeof win['start'] !== 'string' || !(typeof win['end'] === 'string' || win['end'] === null)) return undefined;
  if (typeof o['rate_mbps'] !== 'number' || !Number.isFinite(o['rate_mbps'])) return undefined;
  if (typeof o['product_id'] !== 'string') return undefined;
  if (o['wait'] !== undefined && typeof o['wait'] !== 'boolean') return undefined;
  if (o['deadline_ms'] !== undefined && !Number.isInteger(o['deadline_ms'])) return undefined;
  if (o['quote_id'] !== undefined && typeof o['quote_id'] !== 'string') return undefined;
  const b: BookRequest = {
    legs: o['legs'] as string[], window: { start: win['start'], end: win['end'] as string | null },
    rate_mbps: o['rate_mbps'], product_id: o['product_id'],
  };
  if (o['wait'] !== undefined) b.wait = o['wait'] as boolean;
  if (o['deadline_ms'] !== undefined) b.deadline_ms = o['deadline_ms'] as number;
  if (o['quote_id'] !== undefined) b.quote_id = o['quote_id'] as string;
  return b;
}

function malformed(): C10Answer {
  return { http: 400, body: { error: 'not_accepted', code: 'malformed' } };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.byteLength;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function drain(req: IncomingMessage): Promise<void> {
  for await (const _ of req) { /* discard */ }
}

function send(res: ServerResponse, a: C10Answer): void {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if ('retryAfterS' in a && a.retryAfterS !== undefined) headers['retry-after'] = String(a.retryAfterS);
  res.writeHead(a.http, headers);
  res.end(JSON.stringify(a.body));
}
