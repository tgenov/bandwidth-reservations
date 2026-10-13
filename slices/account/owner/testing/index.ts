/**
 * @share/account-owner/testing: doubles and fixtures for the account owner (AM-I1).
 *
 * - `AccountTestRuntime`: the S-PLAT runtime double plus a trace of committed entries for P2-S92 and a
 *   never-back `reportUpTo`. The double itself (S-PLAT I1b) moves the report position with each commit
 *   (`autoReport`) and fails `displacementRead` on a C02 displacement marker of any attempt.
 * - `LinkDouble`: the C02 provider behaviour of a link schedule owner for AM-I1: `hold` with checks (1) to (7)
 *   (TOMBSTONED, the recorded state or MISMATCH, DEADLINE_PASSED, INVALID, NO_FIT, HELD(1), IN_FLIGHT);
 *   `convert` gives CONVERTED; `release` gives RELEASED. The C02 contract suite runs it beside the real link owner.
 * - `IdentityDouble`: the C08 §B catch-up: a snapshot without `since` (or with one older than 7 days), else the
 *   status events at or after `since`.
 * - Fixtures: the C06 catalogue and the movement feed (one M1).
 */
import type {
  AppendCall, AppendOptions, AppendResult, CommandEnvelope, HlcTs, PartitionKey, RoutingRefusal, SlotNo,
} from '@share/owner-runtime';
import { compareHlc, hex, utf8 } from '@share/owner-runtime';
import { RuntimeDouble, feedEvent, type RuntimeDoubleOptions } from '@share/owner-runtime/testing';
import type {
  ConvertCmd, ConvertReply, CounterOffer, HoldCmd, HoldReply, LinkHoldPort, RefusalReason, ReleaseCmd, ReleaseReply,
} from '../src/contracts/c02.ts';
import type { CatalogueEvent, MovementPosted } from '../src/contracts/c06.ts';
import { MOVEMENT_FEED_TOPIC } from '../src/contracts/c06.ts';
import type { CatchUpAnswer, CatchUpRequest, IdentityCatchUp, PrincipalContext, SnapshotAccount, SnapshotKey } from '../src/contracts/c08.ts';
import type { BookRequest, C10Answer } from '../src/contracts/c10.ts';
import { CatalogueCache } from '../src/booking/catalogue.ts';
import { accountDeclaration } from '../src/booking/declaration.ts';
import { AccountOwner } from '../src/booking/owner.ts';
import { StatusReader } from '../src/booking/status.ts';
import { fundsModule } from '../src/funds/module.ts';
import type { FundsWithKeyStatus } from '../src/booking/owner.ts';

// ---------------- Runtime ----------------

/** `autoReport` (default true) is the double's own: the report position follows each commit. */
export type AccountTestRuntimeOptions = RuntimeDoubleOptions;

export class AccountTestRuntime extends RuntimeDouble {
  /** Committed entries and link commands in order: "commit:<kind>:<request>" and "<command>:<request>". */
  readonly events: string[] = [];

  constructor(opts: AccountTestRuntimeOptions = {}) {
    super({ declaration: accountDeclaration(), ...opts });
  }

  override async append(call: AppendCall, opts?: AppendOptions): Promise<AppendResult> {
    const r = await super.append(call, opts);
    if (r.r === 'Committed') {
      for (const e of this.log(call.partition).filter((x) => x.seq >= r.seqFrom && x.seq <= r.seqTo)) {
        const booking = (e.entry.payload as { booking?: { request?: string } } | undefined)?.booking;
        this.events.push(`commit:${e.entry.kind}:${booking?.request ?? ''}`);
      }
    }
    return r;
  }

  /** Move the slot's report position up to `ts` (never back). */
  reportUpTo(slot: SlotNo, ts: HlcTs): void {
    const cur = this.reportPosition(slot);
    if (cur === undefined || compareHlc(cur, ts) < 0) this.setReportPosition(slot, ts);
  }
}

// ---------------- Link double (C02 provider behaviour) ----------------

/**
 * The record of a request at the link (RFC-001 §3.3 "Request records"). `madeBy` tells a hold record from a
 * release tombstone (C02 `hold` check 1 against check 2).
 */
interface HoldRec {
  madeBy: 'hold' | 'release';
  cmd: HoldCmd | undefined; digest: string; attempt: number;
  state: 'held' | 'converted' | 'released' | 'refused';
  /** The decision that a repeat of the hold gets (C02 "Idempotency": the recorded state). */
  reply: HoldReply;
  convert?: { digest: string; part: string };
  tombstoneUntil?: number;
}

const LINK_FENCE = { generation: 0, epoch: 1n };
/** C02 "Timeouts": release_grace = 1 min. */
const RELEASE_GRACE_MS = 60_000;
/** V1: rate_min (RFC-001 §2), 1 Mbps. */
const RATE_MIN_MBPS = 1;

export class LinkDouble implements LinkHoldPort {
  readonly calls: Array<{ op: 'hold' | 'convert' | 'release'; env: CommandEnvelope; cmd: HoldCmd | ConvertCmd | ReleaseCmd }> = [];
  private readonly capacity = new Map<string, number>();
  private readonly records = new Map<string, HoldRec>();
  private readonly refusals: Array<RoutingRefusal> = [];
  private readonly rt: AccountTestRuntime;
  private seq = 0n;
  /** Called after a HELD reply is recorded and before it is returned (a test hook, e.g. to displace the hold). */
  afterHold: ((cmd: HoldCmd) => void) | undefined;
  /** Delay of each `hold` reply in ms (the command is recorded at once). */
  holdDelayMs = 0;

  constructor(rt: AccountTestRuntime) {
    this.rt = rt;
  }

  addLink(link: string, capacityMbps: number): this {
    this.capacity.set(link, capacityMbps);
    return this;
  }

  /** The next commands answer these routing refusals, in order. */
  scriptRefusal(...r: RoutingRefusal[]): this {
    this.refusals.push(...r);
    return this;
  }

  /** A capacity-lowering transaction displaced the hold of `request` at `attempt` (writes the marker row). */
  displace(link: string, request: { partition: PartitionKey; seq: bigint }, attempt: number): void {
    this.rt.putDisplacementMarker(utf8(link), requestBytes(request), attempt);
  }

  holdsOf(link: string): HoldRec[] {
    return [...this.records.values()].filter((r) => r.cmd?.link === link);
  }

  /** C02 `hold`: checks (1) … (7) in the order of C02 "Link hold port". Waiting (check 8) is not in AM-I1. */
  async hold(env: CommandEnvelope, cmd: HoldCmd): Promise<HoldReply> {
    this.record('hold', env, cmd);
    if (this.holdDelayMs > 0) await new Promise((r) => setTimeout(r, this.holdDelayMs));
    const refusal = this.refusals.shift();
    if (refusal) return refusal;
    const cap = this.capacity.get(cmd.link);
    if (cap === undefined) return { code: 'UNKNOWN_LINK' };
    const k = reqKey(cmd.link, cmd.request);
    const digest = digestOf(cmd);
    const prev = this.records.get(k);
    // (1) A record that a release made: TOMBSTONED, with no digest check.
    if (prev?.madeBy === 'release') return { ...this.stamp(), result: 'REFUSED', reason: 'TOMBSTONED' };
    // (2) A record that a hold made: the recorded state, or MISMATCH for another body.
    if (prev) return prev.digest === digest ? { ...prev.reply, ...this.stamp() } : { code: 'MISMATCH' };
    // (3) ts ≥ D_c.
    if (this.nowMs() >= cmd.commitFence) return this.refuse(k, cmd, digest, { result: 'REFUSED', reason: 'DEADLINE_PASSED' });
    // (4) Validity, the structural rules.
    const invalid = structurallyInvalid(cmd);
    if (invalid) return this.refuse(k, cmd, digest, { result: 'REFUSED', reason: { invalid } });
    // (5) No fit on committed capacity (occ_firm): NO_FIT with a counter-offer.
    const firm = this.maxOccupancy(cmd.link, cmd.window, ['converted']);
    if (firm + cmd.rateMbps > cap) {
      return this.refuse(k, cmd, digest, { result: 'REFUSED', reason: 'NO_FIT',
        counterOffer: { largestRateMbps: Math.max(0, cap - firm), earliest: { none: true } } });
    }
    // (6) Fit beside every hold (occ_all): HELD at attempt 1.
    if (this.maxOccupancy(cmd.link, cmd.window, ['held', 'converted']) + cmd.rateMbps <= cap) {
      const reply: HoldReply = { ...this.stamp(), result: 'HELD', attempt: 1 };
      this.records.set(k, { madeBy: 'hold', cmd, digest, attempt: 1, state: 'held', reply });
      this.afterHold?.(cmd);
      return reply;
    }
    // (7) Only capacity in flight blocks it and wait = false: IN_FLIGHT, retry after the latest blocker's deadline.
    if (!cmd.wait) {
      return this.refuse(k, cmd, digest, { result: 'REFUSED', reason: 'IN_FLIGHT', retryAfterMs: this.retryAfterMs(cmd) });
    }
    throw new Error('LinkDouble: hold check (8), WAITING, is not in AM-I1; set wait = false or give the link enough capacity');
  }

  async convert(env: CommandEnvelope, cmd: ConvertCmd): Promise<ConvertReply> {
    this.record('convert', env, cmd);
    const refusal = this.refusals.shift();
    if (refusal) return refusal;
    const rec = this.records.get(reqKey(cmd.link, cmd.request));
    if (!rec || rec.state === 'released' || rec.state === 'refused') return { code: 'NO_HOLD' };
    if (rec.state === 'converted') {
      // A duplicate gets CONVERTED again; the same identity with another body gets MISMATCH (C02 "Idempotency").
      return rec.attempt === cmd.attempt && rec.convert?.digest === digestOf(cmd)
        ? { ...this.stamp(), result: 'CONVERTED', part: rec.convert.part } : { code: 'MISMATCH' };
    }
    if (rec.attempt !== cmd.attempt) return { code: 'MISMATCH' };
    rec.state = 'converted';
    rec.convert = { digest: digestOf(cmd), part: cmd.part };
    rec.reply = { ...this.stamp(), result: 'CONVERTED', part: cmd.part };
    this.rt.removeDisplacementMarker(utf8(cmd.link), requestBytes(cmd.request));   // the entry that ends the attempt deletes the marker
    return { ...this.stamp(), result: 'CONVERTED', part: cmd.part };
  }

  async release(env: CommandEnvelope, cmd: ReleaseCmd): Promise<ReleaseReply> {
    this.record('release', env, cmd);
    const refusal = this.refusals.shift();
    if (refusal) return refusal;
    const k = reqKey(cmd.link, cmd.request);
    const rec = this.records.get(k);
    const until = cmd.deadline + RELEASE_GRACE_MS;
    if (!rec) {
      this.records.set(k, { madeBy: 'release', cmd: undefined, digest: '', attempt: 0, state: 'released',
        reply: { ...this.stamp(), result: 'RELEASED' }, tombstoneUntil: until });
    } else if (rec.state === 'held') {
      rec.state = 'released';
      rec.reply = { ...this.stamp(), result: 'RELEASED' };
      rec.tombstoneUntil = until;
    } else {
      rec.tombstoneUntil = until;
    }
    this.rt.removeDisplacementMarker(utf8(cmd.link), requestBytes(cmd.request));
    return { ...this.stamp(), result: 'RELEASED', tombstoneUntil: until };
  }

  /** Each refusal records the request with a tombstone until D + release_grace (C02 `hold`). */
  private refuse(k: string, cmd: HoldCmd, digest: string,
    d: { result: 'REFUSED'; reason: RefusalReason; counterOffer?: CounterOffer; retryAfterMs?: number }): HoldReply {
    const reply: HoldReply = { ...this.stamp(), ...d };
    this.records.set(k, { madeBy: 'hold', cmd, digest, attempt: 0, state: 'refused', reply, tombstoneUntil: cmd.deadline + RELEASE_GRACE_MS });
    return reply;
  }

  /** The remaining deadline of the latest hold that overlaps the window (RFC-001 §4.1). */
  private retryAfterMs(cmd: HoldCmd): number {
    let latest = -1;
    for (const r of this.records.values()) {
      if (r.state !== 'held' || !r.cmd || r.cmd.link !== cmd.link || !overlaps(r.cmd.window, cmd.window)) continue;
      if (r.cmd.deadline > latest) latest = r.cmd.deadline;
    }
    return latest < 0 ? 0 : Math.max(0, latest - this.nowMs());
  }

  private nowMs(): number {
    return Number(BigInt(this.rt.now().ts.split('.')[0] ?? '0') / 1_000_000n);
  }

  private record(op: 'hold' | 'convert' | 'release', env: CommandEnvelope, cmd: HoldCmd | ConvertCmd | ReleaseCmd): void {
    // Synchronous, before any await: the C01 CC-7 trace sees the command right after its leaseValid.
    this.rt.trace.push({ t: 'command', to: env.routedTo.kind, partition: hex(env.sender.partition) });
    this.rt.events.push(`${op}:${Buffer.from(cmd.request.partition).toString('utf8')}:${cmd.request.seq}`);
    this.calls.push({ op, env, cmd });
  }

  /** The link stamp: the link fence and the position in the link log, which grows with each reply. */
  private stamp(): { linkFence: typeof LINK_FENCE; linkSeq: bigint } {
    this.seq += 1n;
    return { linkFence: LINK_FENCE, linkSeq: this.seq };
  }

  private maxOccupancy(link: string, w: { start: number; end: number | null }, states: Array<HoldRec['state']>): number {
    const live = [...this.records.values()].filter((r): r is HoldRec & { cmd: HoldCmd } =>
      r.cmd !== undefined && r.cmd.link === link && states.includes(r.state));
    const hi = w.end ?? Number.MAX_SAFE_INTEGER;
    const points = new Set<number>([w.start]);
    for (const r of live) { if (r.cmd.window.start > w.start && r.cmd.window.start < hi) points.add(r.cmd.window.start); }
    let max = 0;
    for (const m of points) {
      let occ = 0;
      for (const r of live) if (r.cmd.window.start <= m && (r.cmd.window.end === null || m < r.cmd.window.end)) occ += r.cmd.rateMbps;
      if (occ > max) max = occ;
    }
    return max;
  }
}

/** The body digest (C02 "Digest": the body only, never the envelope). */
function digestOf(body: object): string {
  return JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? hex(v) : v));
}

function structurallyInvalid(b: HoldCmd): 'V1' | 'V2' | 'V3' | undefined {
  if (!Number.isSafeInteger(b.rateMbps) || b.rateMbps < RATE_MIN_MBPS) return 'V1';
  if (!Number.isSafeInteger(b.window.start) || (b.window.end !== null && !Number.isSafeInteger(b.window.end))) return 'V2';
  if (b.window.end !== null && b.window.end <= b.window.start) return 'V3';
  return undefined;
}

function overlaps(a: { start: number; end: number | null }, b: { start: number; end: number | null }): boolean {
  return (a.end === null || a.end > b.start) && (b.end === null || b.end > a.start);
}

function reqKey(link: string, r: { partition: PartitionKey; seq: bigint }): string {
  return `${link}|${hex(r.partition)}|${r.seq}`;
}

/** C01 displacementRead `request` bytes: request_part ‖ U64BE(request_seq). */
function requestBytes(r: { partition: PartitionKey; seq: bigint }): Uint8Array {
  const rb = new Uint8Array(r.partition.byteLength + 8);
  rb.set(r.partition, 0);
  new DataView(rb.buffer).setBigUint64(r.partition.byteLength, r.seq);
  return rb;
}

// ---------------- Identity double (C08 §B) ----------------

/** C08 §B: `catch_up` with `since` covers the push events of the last 7 days; an older `since` gets a snapshot. */
const PUSH_RETENTION_MICROS = 7n * 24n * 3_600n * 1_000_000n;

/** An `IdentityStatusEvent` (C08 §B) as the double records it for `catch_up` with `since`. */
export interface IdentityDoubleEvent {
  schema: 'iam.status.v1'; account: string; source: { identity_partition: string; seq: string }; committed_at: bigint;
  actor: { kind: 'onboarding' };
  body: { kind: 'key_issued'; key_id: string; version: number; limits: SnapshotKey['limits']; probe: boolean }
    | { kind: 'key_limits_changed'; key_id: string; version: number; limits: SnapshotKey['limits'] }
    | { kind: 'key_revoked'; key_id: string; version: number };
}

export class IdentityDouble implements IdentityCatchUp {
  readonly requests: CatchUpRequest[] = [];
  readonly accounts = new Map<string, SnapshotAccount>();
  /** Every status change that `addKey` made, in commit order. */
  readonly events: IdentityDoubleEvent[] = [];
  unavailable = false;
  private readonly rt: RuntimeDouble;
  constructor(rt: RuntimeDouble) {
    this.rt = rt;
  }

  /** Set a key's status, as a committed identity entry would (one status event for each change). */
  addKey(account: string, keyId: string, version = 1, status: 'active' | 'revoked' = 'active'): void {
    const a = this.accounts.get(account) ?? { account, keys: [], kyb: { status: 'none', version: 0 } };
    const prev = a.keys.find((k) => k.key_id === keyId);
    a.keys = a.keys.filter((k) => k.key_id !== keyId);
    const key: SnapshotKey = { key_id: keyId, version, status, limits: { key_spend_limit_micro_usd: null, key_inflight_limit_mbps: null, key_rate_limit_per_s: 50 }, probe: false };
    a.keys.push(key);
    this.accounts.set(account, a);
    const body: IdentityDoubleEvent['body'] = status === 'revoked' ? { kind: 'key_revoked', key_id: keyId, version }
      : prev ? { kind: 'key_limits_changed', key_id: keyId, version, limits: key.limits }
      : { kind: 'key_issued', key_id: keyId, version, limits: key.limits, probe: false };
    this.events.push({ schema: 'iam.status.v1', account, source: { identity_partition: `iam-${account}`, seq: String(this.events.length + 1) },
      committed_at: this.nowMicros(), actor: { kind: 'onboarding' }, body });
  }

  /** C08 §B: no `since`, or a `since` older than the retention, gives a snapshot; else the events at or after `since`. */
  async catchUp(req: CatchUpRequest): Promise<CatchUpAnswer> {
    this.requests.push(req);
    if (this.unavailable) return { kind: 'temporarily_unavailable' };
    const nowUs = this.nowMicros();
    const inSlot = (account: string): boolean => this.rt.slotOf(utf8(account)).slot === req.account_slot;
    if (req.since !== undefined && req.since >= nowUs - PUSH_RETENTION_MICROS) {
      const since = req.since;
      return { kind: 'events', events: structuredClone(this.events.filter((e) => e.committed_at >= since && inSlot(e.account))), read_timestamp: nowUs };
    }
    const state = [...this.accounts.values()].filter((a) => inSlot(a.account));
    return { kind: 'snapshot', state: structuredClone(state), position: nowUs, read_timestamp: nowUs };
  }

  private nowMicros(): bigint {
    return BigInt(Date.parse(isoOfHlc(this.rt.now().ts))) * 1_000n;
  }
}

function isoOfHlc(ts: HlcTs): string {
  const wall = BigInt(ts.split('.')[0] ?? '0');
  return new Date(Number(wall / 1_000_000n)).toISOString();
}

// ---------------- Fixtures ----------------

/** 2026-10-12T09:00:00Z: "it is 09:00" (P4 background). */
export const NINE_AM_MS = Date.UTC(2026, 9, 12, 9, 0, 0);
export const PRODUCT = 'guaranteed';
/** 2 micro-USD per Mbps-minute (P4 background), in pico-USD. */
export const PRICE_PICO = 2_000_000n;

let catalogueSeq = 0;
function catalogueEvent(body: CatalogueEvent['body']): CatalogueEvent {
  catalogueSeq += 1;
  return {
    type: 'CatalogueEvent', schemaVersion: 1,
    eventId: { partition: 'catalogue', stream: 'catalogue', streamSeq: String(catalogueSeq), generation: 0, epoch: 1 },
    entityVersion: '1', committedAt: `${BigInt(NINE_AM_MS - 3_600_000) * 1_000_000n}.0000000000`, principal: 'commercial-1', body,
  };
}

/** One product, and one single-link route for each link, at 2 µ per Mbps-minute. */
export function catalogueFixture(links: Array<{ link: string; capacityMbps: number }>): CatalogueCache {
  const c = new CatalogueCache();
  c.apply(catalogueEvent({ entityType: 'product', productId: PRODUCT, kind: 'guaranteed', permitsBurst: false }));
  for (const l of links) {
    c.setLink({ linkId: l.link, capacityMbps: l.capacityMbps, probe: false });
    c.apply(catalogueEvent({ entityType: 'route', routeId: `route-${l.link}`, legs: [l.link] }));
    c.apply(catalogueEvent({ entityType: 'price_version', product: PRODUCT, route: `route-${l.link}`, priceKind: 'reservation_price',
      priceVersion: 'pv-1', price: PRICE_PICO.toString(), effectiveFrom: '2026-01-01T00:00:00Z', announcedAt: '0.0000000000' }));
  }
  return c;
}

/** A movement-feed event (C06 §9, by-buyer view) with one M1 top-up and the balance after it. */
export function movementM1(account: string, seq: number, amountMicros: bigint, balanceAfter: bigint): ReturnType<typeof feedEvent> {
  const m: MovementPosted = {
    type: 'MovementPosted', schemaVersion: 1,
    eventId: { partition: 'ledger-1', stream: 'movements', streamSeq: String(seq), generation: 0, epoch: 1 },
    movementId: `ledger-1:${seq}`,
    position: { ledgerPartition: 'ledger-1', sequence: String(seq), commitTs: `${BigInt(NINE_AM_MS - 60_000 + seq) * 1_000_000n}.0000000000` },
    postingTime: `${BigInt(NINE_AM_MS - 60_000 + seq) * 1_000_000n}.0000000000`,
    movementRef: `topup-${account}-${seq}`,
    home: { account }, kinds: ['M1'], cause: 'top_up', currency: 'USD',
    partyTotals: [{ ledgerAccount: `B:${account}`, amount: amountMicros.toString() }],
    lines: [{ kind: 'M1', outcome: 'posted', nil: false, amount: amountMicros.toString() }],
    buyer: { account, balanceAfter: balanceAfter.toString(), writtenOffOwedAfter: '0' },
  };
  return feedEvent({ partition: utf8('ledger-1'), stream: 'movements', streamSeq: BigInt(seq), event: m });
}

/**
 * A C08 principal context for an agent key of the account, as the edge builds it, with the identity-signed
 * key record that C08 §A requires for an agent key. The signature is a placeholder: the account owner does
 * not verify it in AM-I1.
 */
export function agentContext(account: string, keyId: string, nowMs: number, over: Partial<PrincipalContext> = {}): PrincipalContext {
  const nowUs = BigInt(nowMs) * 1_000n;
  return {
    schema: 'principal.v1', principal_id: `p-${keyId}`, kind: 'agent_key', tenant: { kind: 'account', account },
    rights: { administrator: false }, key_id: keyId,
    auth: { method: 'agent_key', at: nowUs }, iam_position: { identity_slot: 0, head: '1' }, probe: false,
    key_record: {
      key_id: keyId, identity_slot: 0, epoch: '1', tenant: { kind: 'account', account }, status: 'active',
      limits: { key_spend_limit_micro_usd: null, key_inflight_limit_mbps: null, key_rate_limit_per_s: 50 }, version: 1,
      committed_at: nowUs - 1_000_000n, probe: false, signature: { key_id: 'identity-double', sig: '' },
    },
    request_id: `r-${keyId}-${nowMs}`, received_at: nowUs, edge_region: 'R1', edge_workload: 'edge-r1-0',
    expires_at: nowUs + 60_000_000n, policy_version: 1,
    ...over,
  };
}

// ---------------- Harness ----------------

export interface HarnessAccount { account: string; balanceMicros: bigint; keys?: string[] }

export interface Harness {
  rt: AccountTestRuntime;
  links: LinkDouble;
  identity: IdentityDouble;
  catalogue: CatalogueCache;
  owner: AccountOwner;
  reader: StatusReader;
  replies: string[];
  book(account: string, key: string, body: BookRequest, keyId?: string): Promise<C10Answer>;
  status(account: string, key: string, keyId?: string): C10Answer;
  ctx(account: string, keyId?: string): PrincipalContext;
  nowMs(): number;
}

export interface HarnessOptions {
  accounts: HarnessAccount[];
  links?: Array<{ link: string; capacityMbps: number }>;
  funds?: FundsWithKeyStatus;
  autoReport?: boolean;
  startMs?: number;
}

/** Build the owner on the runtime double, apply each account's F4 snapshot (key) and F1 (balance). */
export async function harness(o: HarnessOptions): Promise<Harness> {
  const startMs = o.startMs ?? NINE_AM_MS;
  const rt = new AccountTestRuntime({ startMs, autoReport: o.autoReport ?? true });
  const linkList = o.links ?? [{ link: 'L1', capacityMbps: 1_000 }];
  const links = new LinkDouble(rt);
  for (const l of linkList) links.addLink(l.link, l.capacityMbps);
  const identity = new IdentityDouble(rt);
  const catalogue = catalogueFixture(linkList);
  const replies: string[] = [];
  const owner = new AccountOwner({
    runtime: rt, links, identity, catalogue, funds: o.funds ?? fundsModule,
    onReply: (label) => { rt.recordReply(label); replies.push(label); },
  });
  rt.attach(owner);
  owner.start();
  for (const a of o.accounts) for (const k of a.keys ?? ['k1']) identity.addKey(a.account, `${a.account}-${k}`);
  // An acquisition of each account slot: onAcquire pulls the snapshot and writes the F4 entries.
  const slots = new Set(o.accounts.map((a) => rt.slotOf(utf8(a.account)).slot));
  for (const s of slots) await rt.acquire(s, 'expiry');
  let seq = 0;
  for (const a of o.accounts) {
    if (a.balanceMicros === 0n) continue;
    seq += 1;
    await rt.deliver(MOVEMENT_FEED_TOPIC, movementM1(a.account, seq, a.balanceMicros, a.balanceMicros));
  }
  const reader = new StatusReader(owner, rt);
  const nowMs = (): number => Number(BigInt(rt.now().ts.split('.')[0] ?? '0') / 1_000_000n);
  const ctx = (account: string, keyId = `${account}-k1`): PrincipalContext => agentContext(account, keyId, nowMs());
  return {
    rt, links, identity, catalogue, owner, reader, replies, ctx, nowMs,
    book: (account, key, body, keyId) => owner.book(account, { principal: ctx(account, keyId), key, body, receivedAtMono: performance.now() }),
    status: (account, key, keyId) => reader.status(account, ctx(account, keyId), key),
  };
}

/** A C10 window from minute offsets relative to `baseMs` (end null: open-ended). */
export function windowAt(baseMs: number, startMin: number, endMin: number | null): BookRequest['window'] {
  const iso = (m: number): string => new Date(baseMs + m * 60_000).toISOString();
  return { start: iso(startMin), end: endMin === null ? null : iso(endMin) };
}
