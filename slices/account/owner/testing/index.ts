/**
 * @share/account-owner/testing: doubles and fixtures for the account owner (AM-I1).
 *
 * - `AccountTestRuntime`: the S-PLAT runtime double with three additions that AM-I1 needs and the
 *   double does not have: (1) the report position follows each commit (the status readers are I1b);
 *   (2) a C02 displacement marker of any attempt fails the `displacementRead` condition;
 *   (3) a trace of committed entries for P2-S92.
 * - `LinkDouble`: the C02 provider behaviour of a link schedule owner for AM-I1: `hold` gives HELD(1)
 *   or REFUSED(NO_FIT) with a tombstone; `convert` gives CONVERTED; `release` gives RELEASED.
 * - `IdentityDouble`: the C08 §B catch-up, snapshot answers only.
 * - Fixtures: the C06 catalogue and the movement feed (one M1).
 */
import type {
  AppendCall, AppendOptions, AppendResult, CommandEnvelope, HlcTs, PartitionKey, RoutingRefusal, SlotNo,
} from '@share/owner-runtime';
import { compareHlc, hex, slotOfPartition, utf8 } from '@share/owner-runtime';
import { RuntimeDouble, feedEvent, type RuntimeDoubleOptions } from '@share/owner-runtime/testing';
import type {
  ConvertCmd, ConvertReply, HoldCmd, HoldReply, LinkHoldPort, ReleaseCmd, ReleaseReply,
} from '../src/contracts/c02.ts';
import type { CatalogueEvent, MovementPosted } from '../src/contracts/c06.ts';
import { MOVEMENT_FEED_TOPIC } from '../src/contracts/c06.ts';
import type { CatchUpAnswer, CatchUpRequest, IdentityCatchUp, PrincipalContext, SnapshotAccount } from '../src/contracts/c08.ts';
import type { BookRequest, C10Answer } from '../src/contracts/c10.ts';
import { CatalogueCache } from '../src/booking/catalogue.ts';
import { accountDeclaration } from '../src/booking/declaration.ts';
import { AccountOwner } from '../src/booking/owner.ts';
import { StatusReader } from '../src/booking/status.ts';
import { fundsModule } from '../src/funds/module.ts';
import type { FundsWithKeyStatus } from '../src/booking/owner.ts';

// ---------------- Runtime ----------------

export interface AccountTestRuntimeOptions extends RuntimeDoubleOptions {
  /** Advance the report position to each commit at once (default true). */
  autoReport?: boolean;
}

export class AccountTestRuntime extends RuntimeDouble {
  /** Committed entries and link commands in order: "commit:<kind>:<request>" and "<command>:<request>". */
  readonly events: string[] = [];
  /** C02 link_displacement rows: key (link, request bytes) → attempt. */
  readonly markers = new Map<string, number>();
  autoReport: boolean;

  constructor(opts: AccountTestRuntimeOptions = {}) {
    super({ declaration: accountDeclaration(), ...opts });
    this.autoReport = opts.autoReport ?? true;
  }

  override async append(call: AppendCall, opts?: AppendOptions): Promise<AppendResult> {
    for (const c of call.conditions ?? []) {
      // C02 "Link displacement read": a row present with ANY attempt means no E5.
      if (c.kind === 'displacementRead' && this.markers.has(markerKey(c.link, c.request))) {
        const result: AppendResult = { r: 'ConditionFailed', which: c.label };
        this.appends.push({ call, opts, result });
        this.trace.push({ t: 'append', partition: hex(call.partition), result: result.r });
        return result;
      }
    }
    const r = await super.append(call, opts);
    if (r.r === 'Committed') {
      for (const e of this.log(call.partition).filter((x) => x.seq >= r.seqFrom && x.seq <= r.seqTo)) {
        const booking = (e.entry.payload as { booking?: { request?: string } } | undefined)?.booking;
        this.events.push(`commit:${e.entry.kind}:${booking?.request ?? ''}`);
      }
      if (this.autoReport) this.reportUpTo(slotOfPartition(call.partition, this.slotCount), r.ts);
    }
    return r;
  }

  /** Move the slot's report position up to `ts` (never back). */
  reportUpTo(slot: SlotNo, ts: HlcTs): void {
    const cur = this.reportPosition(slot);
    if (cur === undefined || compareHlc(cur, ts) < 0) this.setReportPosition(slot, ts);
  }
}

export function markerKey(link: Uint8Array, request: Uint8Array): string {
  return `${hex(link)}|${hex(request)}`;
}

// ---------------- Link double (C02 provider behaviour) ----------------

interface HoldRec { cmd: HoldCmd; digest: string; attempt: number; state: 'held' | 'converted' | 'released' | 'refused'; reply: HoldReply }

const STAMP = { linkFence: { generation: 0, epoch: 1n }, linkSeq: 0n };

export class LinkDouble implements LinkHoldPort {
  readonly calls: Array<{ op: 'hold' | 'convert' | 'release'; env: CommandEnvelope; cmd: HoldCmd | ConvertCmd | ReleaseCmd }> = [];
  private readonly capacity = new Map<string, number>();
  private readonly records = new Map<string, HoldRec>();
  private readonly tombstones = new Map<string, number>();
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
    const rb = new Uint8Array(request.partition.byteLength + 8);
    rb.set(request.partition, 0);
    new DataView(rb.buffer).setBigUint64(request.partition.byteLength, request.seq);
    this.rt.markers.set(markerKey(utf8(link), rb), attempt);
  }

  holdsOf(link: string): HoldRec[] {
    return [...this.records.values()].filter((r) => r.cmd.link === link);
  }

  async hold(env: CommandEnvelope, cmd: HoldCmd): Promise<HoldReply> {
    this.record('hold', env, cmd);
    if (this.holdDelayMs > 0) await new Promise((r) => setTimeout(r, this.holdDelayMs));
    const refusal = this.refusals.shift();
    if (refusal) return refusal;
    const k = reqKey(cmd.link, cmd.request);
    if (this.tombstones.has(k)) return { ...this.stamp(), result: 'REFUSED', reason: 'TOMBSTONED' };
    const digest = JSON.stringify(cmd, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? hex(v) : v));
    const prev = this.records.get(k);
    if (prev) {
      if (prev.digest !== digest) return { code: 'MISMATCH' };
      if (prev.state === 'converted') return { ...this.stamp(), result: 'CONVERTED', part: 'part1' };
      if (prev.state === 'released') return { ...this.stamp(), result: 'RELEASED' };
      return prev.reply;
    }
    const cap = this.capacity.get(cmd.link);
    if (cap === undefined) return { code: 'UNKNOWN_LINK' };
    const occ = this.maxOccupancy(cmd.link, cmd.window.start, cmd.window.end);
    if (occ + cmd.rateMbps > cap) {
      const reply: HoldReply = { ...this.stamp(), result: 'REFUSED', reason: 'NO_FIT', counterOffer: { largestRateMbps: Math.max(0, cap - occ), earliest: { none: true } } };
      this.tombstones.set(k, cmd.deadline + 60_000);   // each refusal records a tombstone until D + release_grace
      this.records.set(k, { cmd, digest, attempt: 0, state: 'refused', reply });
      return reply;
    }
    const reply: HoldReply = { ...this.stamp(), result: 'HELD', attempt: 1 };
    this.records.set(k, { cmd, digest, attempt: 1, state: 'held', reply });
    this.afterHold?.(cmd);
    return reply;
  }

  async convert(env: CommandEnvelope, cmd: ConvertCmd): Promise<ConvertReply> {
    this.record('convert', env, cmd);
    const refusal = this.refusals.shift();
    if (refusal) return refusal;
    const rec = this.records.get(reqKey(cmd.link, cmd.request));
    if (!rec || rec.state === 'released' || rec.state === 'refused') return { code: 'NO_HOLD' };
    if (rec.attempt !== cmd.attempt) return { code: 'MISMATCH' };
    rec.state = 'converted';
    this.rt.markers.delete(markerKeyOf(cmd.link, cmd.request));   // the entry that ends the attempt deletes the marker
    return { ...this.stamp(), result: 'CONVERTED', part: cmd.part };
  }

  async release(env: CommandEnvelope, cmd: ReleaseCmd): Promise<ReleaseReply> {
    this.record('release', env, cmd);
    const refusal = this.refusals.shift();
    if (refusal) return refusal;
    const k = reqKey(cmd.link, cmd.request);
    const rec = this.records.get(k);
    if (rec && rec.state === 'held') rec.state = 'released';
    const until = cmd.deadline + 60_000;
    this.tombstones.set(k, until);
    this.rt.markers.delete(markerKeyOf(cmd.link, cmd.request));
    return { ...this.stamp(), result: 'RELEASED', tombstoneUntil: until };
  }

  private record(op: 'hold' | 'convert' | 'release', env: CommandEnvelope, cmd: HoldCmd | ConvertCmd | ReleaseCmd): void {
    // Synchronous, before any await: the C01 CC-7 trace sees the command right after its leaseValid.
    this.rt.trace.push({ t: 'command', to: env.routedTo.kind, partition: hex(env.sender.partition) });
    this.rt.events.push(`${op}:${Buffer.from(cmd.request.partition).toString('utf8')}:${cmd.request.seq}`);
    this.calls.push({ op, env, cmd });
  }

  private stamp(): typeof STAMP {
    this.seq += 1n;
    return { linkFence: STAMP.linkFence, linkSeq: this.seq };
  }

  private maxOccupancy(link: string, start: number, end: number | null): number {
    const live = [...this.records.values()].filter((r) => r.cmd.link === link && (r.state === 'held' || r.state === 'converted'));
    const hi = end ?? Number.MAX_SAFE_INTEGER;
    const points = new Set<number>([start]);
    for (const r of live) { if (r.cmd.window.start > start && r.cmd.window.start < hi) points.add(r.cmd.window.start); }
    let max = 0;
    for (const m of points) {
      let occ = 0;
      for (const r of live) if (r.cmd.window.start <= m && (r.cmd.window.end === null || m < r.cmd.window.end)) occ += r.cmd.rateMbps;
      if (occ > max) max = occ;
    }
    return max;
  }
}

function reqKey(link: string, r: { partition: PartitionKey; seq: bigint }): string {
  return `${link}|${hex(r.partition)}|${r.seq}`;
}

function markerKeyOf(link: string, r: { partition: PartitionKey; seq: bigint }): string {
  const rb = new Uint8Array(r.partition.byteLength + 8);
  rb.set(r.partition, 0);
  new DataView(rb.buffer).setBigUint64(r.partition.byteLength, r.seq);
  return markerKey(utf8(link), rb);
}

// ---------------- Identity double (C08 §B) ----------------

export class IdentityDouble implements IdentityCatchUp {
  readonly requests: CatchUpRequest[] = [];
  readonly accounts = new Map<string, SnapshotAccount>();
  unavailable = false;
  private readonly rt: RuntimeDouble;
  constructor(rt: RuntimeDouble) {
    this.rt = rt;
  }

  addKey(account: string, keyId: string, version = 1, status: 'active' | 'revoked' = 'active'): void {
    const a = this.accounts.get(account) ?? { account, keys: [], kyb: { status: 'none', version: 0 } };
    a.keys = a.keys.filter((k) => k.key_id !== keyId);
    a.keys.push({ key_id: keyId, version, status, limits: { key_spend_limit_micro_usd: null, key_inflight_limit_mbps: null, key_rate_limit_per_s: 50 }, probe: false });
    this.accounts.set(account, a);
  }

  async catchUp(req: CatchUpRequest): Promise<CatchUpAnswer> {
    this.requests.push(req);
    if (this.unavailable) return { kind: 'temporarily_unavailable' };
    const nowUs = BigInt(Date.parse(isoOfHlc(this.rt.now().ts))) * 1_000n;
    const state = [...this.accounts.values()].filter((a) => this.rt.slotOf(utf8(a.account)).slot === req.account_slot);
    return { kind: 'snapshot', state: structuredClone(state), position: nowUs, read_timestamp: nowUs };
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

/** A C08 principal context for an agent key of the account, as the edge builds it. */
export function agentContext(account: string, keyId: string, nowMs: number, over: Partial<PrincipalContext> = {}): PrincipalContext {
  const nowUs = BigInt(nowMs) * 1_000n;
  return {
    schema: 'principal.v1', principal_id: `p-${keyId}`, kind: 'agent_key', tenant: { kind: 'account', account },
    rights: { administrator: false }, key_id: keyId,
    auth: { method: 'agent_key', at: nowUs }, iam_position: { identity_slot: 0, head: '1' }, probe: false,
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
