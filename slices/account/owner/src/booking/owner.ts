/**
 * The account owner kind (RFC-002 rev 6 booking module + RFC-004 rev 6 Part A funds module), AM-I1.
 *
 * AM-I1 path (S-ACCT-S-MONEY plan): C10 `book` for one Share leg → E1 with the C05 funds hold →
 * C02 `hold` (only after E1 commits) → `HELD` → E5 (decision row, fence `ts < D − τ`, `iam_fresh`,
 * one displacement read) → C02 `convert` with the attempt from `HELD` → outcome reported. The funds
 * hold becomes the reservation's hold in E5.
 *
 * Rules that the code keeps (RFC-002 §2.1, §2.4, §2.5):
 * - The funds module is called decisively only inside `decide(ctx)`, at the commit timestamp `ctx.ts`.
 * - `decide` is pure over the state before the batch. It can run again on a restart.
 * - Nothing goes to a participant, and no answer goes to the edge, before the entry commits.
 * - Each reply and each command from memory is immediately after a valid `leaseValid` (C01 CC-7).
 */
import { createHash, createHmac } from 'node:crypto';
import type {
  AppendCall, AppendResult, AuditFields, CommandEnvelope, Condition, EntryInput, Epoch, FeedEvent, Generation, HeadRow,
  HlcTs, InboundNotification, OwnerHooks, OwnerRuntime, PartitionKey, ProjectionWrite, RoutingRefusal, RowRef, SlotNo,
  AcquisitionKind, BatchContext,
} from '@share/owner-runtime';
import { compareHlc, decodeJson, encodeJson, hex, utf8 } from '@share/owner-runtime';
import type { Ask, Ctx, F1, F4, FundsModule, FundsState, Input, Outcomes, RulesVersion, Schedule, Verdict } from '../contracts/c05.ts';
import type {
  ConvertCmd, ConvertReply, CounterOffer as C02CounterOffer, HoldCmd, HoldReply, LinkHoldPort, ReleaseCmd, ReleaseReply,
  RequestId as C02RequestId,
} from '../contracts/c02.ts';
import { LINK_KIND, displacementRequestBytes, isRoutingRefusal } from '../contracts/c02.ts';
import type { Confirmed, OutcomeEvent, OutcomeReason } from '../contracts/c04.ts';
import { MOVEMENT_FEED_TOPIC, type MovementPosted } from '../contracts/c06.ts';
import type { CatchUpAnswer, IdentityCatchUp, PrincipalContext, SnapshotAccount } from '../contracts/c08.ts';
import type { BookRequest, C10Answer, ReasonCode, RequestStatus } from '../contracts/c10.ts';
import { C10_PARAMS } from '../contracts/c10.ts';
import { DEFAULT_RULES, balanceOf, emptyFundsState, fundsModule, rulesVersionOf, snapshotDiffers } from '../funds/module.ts';
import { ACCOUNT_KIND, ENTRY, TABLE } from './declaration.ts';
import type { CatalogueCache } from './catalogue.ts';
import {
  addUtcMonths, hlcAtNs, isoMinuteC04, isoMinuteC10, isoMs, minuteOfC10, minuteOfTs, parts, picoToMicroDecimal, toC05,
  wallMs,
} from '../time.ts';

// ---------- Parameters ----------

export const OWNER_PARAMS = {
  /** iam_fresh_max (RFC-002 §1.3). */
  iamFreshMaxNs: 45_000_000_000n,
  /** Lock timeout of the displacement read (RFC-002 §2.5, J-14). */
  displacementLockTimeoutMs: 10,
  /** Retries of one append for Retry, Ambiguous, Moving, Overloaded and unknown results. */
  appendRetries: 8,
  /** Retries of one C02 command for routing refusals. */
  commandRetries: 10,
  /** The link-rules policy version recorded at intake (C13; one version in AM-I1). */
  linkPolicyVersion: 1n,
} as const;

const FAMILY = 'booking_change';
const IDEM_DIGEST_SECRET = 'dev-idempotency-digest-key';

// ---------- Types ----------

export interface FundsWithKeyStatus extends FundsModule {
  keyStatus(s: FundsState, key: string): 'active' | 'revoked' | 'absent';
}

export interface AccountOwnerDeps {
  runtime: OwnerRuntime;
  links: LinkHoldPort;
  identity: IdentityCatchUp;
  catalogue: CatalogueCache;
  funds?: FundsWithKeyStatus;
  rules?: RulesVersion;
  /** Monotonic ms clock for the ack rule. Default: performance.now. */
  monoMs?: () => number;
  /** Instrumentation for C01 CC-7 (a reply from memory). */
  onReply?: (label: string) => void;
}

export interface BookCall {
  principal: PrincipalContext;
  key: string;
  body: BookRequest;
  /** Monotonic ms at which the edge received the submission. */
  receivedAtMono: number;
}

type RequestState = 'composing' | 'undecided' | 'confirmed' | 'rejected' | 'invalid' | 'failed';

interface LegState { link: string; leg: string; attempt?: number; state: 'requested' | 'held' | 'refused' | 'converted' | 'released' }

/** A booking request, as the owner holds it in memory. Fields after `state` are set by entries. */
export interface Req {
  account: string;
  key: string;
  fingerprint: string;
  principal: string;
  principalKind: string;
  keyId?: string;
  body: BookRequest;
  routeId: string;
  product: string;
  start: bigint;
  end: bigint | null;
  rateMbps: number;
  wait: boolean;
  deadlineMs: number;
  receiptMinute: bigint;
  legs: LegState[];
  state: RequestState;
  seq?: bigint;
  intakeTs?: HlcTs;
  D?: number;
  Dc?: number;
  tauMs?: number;
  price?: { priceVersion: string; pico: bigint };
  reason?: ReasonCode;
  amounts?: RequestStatus['amounts'];
  counterOffer?: RequestStatus['counter_offer'];
  reservationId?: string;
  e5Seq?: bigint;
  decidedTs?: HlcTs;
  releasesDurableTs?: HlcTs;
  decisionFormed: boolean;
  pendingSent: boolean;
  waiters: Array<() => void>;
}

interface IdemEntry { principal: string; fingerprint: string; req: Req; intake: Promise<'ok' | C10Answer> }

interface Acct {
  account: string;
  partition: PartitionKey;
  funds: FundsState;
  requests: Map<string, Req>;
  idem: Map<string, IdemEntry>;
  feedSeen: Set<string>;
  lane: Promise<unknown>;
}

export interface OperationalAlertRecord { code: string; account?: string; detail?: string }

type AppendOutcome =
  | { kind: 'committed'; ts: HlcTs; seqFrom: bigint; seqTo: bigint }
  | { kind: 'conditionFailed'; which: string }
  | { kind: 'unavailable'; retryAfterS: number; why: string }
  | { kind: 'slotLost' };

const ROUTING_RETRY_CODES = new Set(['STALE_EPOCH', 'NOT_OWNER', 'MOVED', 'MOVING', 'STOPPED', 'OVERLOADED', 'UNAVAILABLE']);

// ---------- The owner ----------

export class AccountOwner implements OwnerHooks {
  readonly alerts: OperationalAlertRecord[] = [];
  private readonly rt: OwnerRuntime;
  private readonly links: LinkHoldPort;
  private readonly identity: IdentityCatchUp;
  private readonly catalogue: CatalogueCache;
  private readonly funds: FundsWithKeyStatus;
  private readonly rules: RulesVersion;
  private readonly monoMs: () => number;
  private readonly onReplyHook: ((label: string) => void) | undefined;
  private readonly accounts = new Map<string, Acct>();
  private readonly iamFresh = new Map<SlotNo, bigint>();
  private readonly movedOut = new Set<string>();
  private insideDecide = false;

  constructor(deps: AccountOwnerDeps) {
    this.rt = deps.runtime;
    this.links = deps.links;
    this.identity = deps.identity;
    this.catalogue = deps.catalogue;
    this.funds = deps.funds ?? fundsModule;
    this.rules = deps.rules ?? DEFAULT_RULES;
    this.monoMs = deps.monoMs ?? (() => performance.now());
    this.onReplyHook = deps.onReply;
  }

  /** Subscribe to the inputs. Call once, after the runtime has the hooks. */
  start(): void {
    this.rt.onReport((slot) => this.pumpSlot(slot));
    this.rt.subscribe(MOVEMENT_FEED_TOPIC, { positions: [] }, 'committed', (e) => this.onMovement(e));
  }

  /** True while `decide(ctx)` runs (C05 H1 instrumentation). */
  get deciding(): boolean {
    return this.insideDecide;
  }

  // ---------------- C01 hooks ----------------

  async onAcquire(slot: SlotNo, _epoch: Epoch, _kind: AcquisitionKind): Promise<void> {
    // C05 "Identity-freshness watermark": unset after any acquisition until the catch-up commits.
    this.iamFresh.delete(slot);
    await this.catchUp(slot);
  }

  onRelease(slot: SlotNo, _reason: 'staleEpoch' | 'handedOff' | 'taken' | 'shutdown'): void {
    this.iamFresh.delete(slot);
  }

  onReportable(slot: SlotNo): void {
    this.pumpSlot(slot);
  }

  onMovedOut(partition: PartitionKey): void {
    this.movedOut.add(hex(partition));
  }

  async onAdopt(partition: PartitionKey, _generation: Generation): Promise<void> {
    this.movedOut.delete(hex(partition));
  }

  async onNotification(_n: InboundNotification): Promise<void> {
    // The C02 waiting port (GRANTED, DISPLACED, WAITING_NOTICE) comes in ACCT-I8 and ACCT-I10.
  }

  // ---------------- Identity freshness ----------------

  /** Pull a catch-up without `since` (a snapshot, C08 S-G1) and apply it as F4 entries. */
  async catchUp(slot: SlotNo): Promise<boolean> {
    const ans: CatchUpAnswer = await this.identity.catchUp({ account_slot: slot });
    if (ans.kind !== 'snapshot') {
      if (ans.kind === 'events') this.alert('CATCH_UP_EVENTS_NOT_IN_AM_I1');
      return false;
    }
    for (const st of ans.state) {
      const acct = this.accountOf(st.account);
      if (this.rt.slotOf(acct.partition).slot !== slot) continue;
      const f4 = snapshotF4(st, ans.position);
      if (!snapshotDiffers(acct.funds, f4)) continue;
      const r = await this.enqueue(acct, () => this.appendFundsEntry(acct, ENTRY.F4, `F4|${st.account}|${ans.position}`, f4, []));
      if (r.kind !== 'committed') return false;
    }
    // Wall nanoseconds = µs × 10³ (C05 V53-4).
    this.iamFresh.set(slot, ans.read_timestamp * 1_000n);
    return true;
  }

  // ---------------- Feeds ----------------

  /** The ledger movement feed, by-buyer view (C06 §9), applied as F1. Exactly once by feed identity (C01 CC-6). */
  private async onMovement(e: FeedEvent): Promise<void> {
    const m = decodeJson(e.value) as MovementPosted;
    const account = m.buyer?.account ?? m.home.account;
    if (!account || !m.buyer) { this.alert('MOVEMENT_WITHOUT_BUYER'); return; }
    const acct = this.accountOf(account);
    const feed = { source: MOVEMENT_FEED_TOPIC, partition: m.eventId.partition, seq: BigInt(m.eventId.streamSeq) };
    const id = `${feed.source}|${feed.partition}|${feed.seq}`;
    if (acct.feedSeen.has(id)) return;
    acct.feedSeen.add(id);
    const f1: F1 = {
      kind: 'F1',
      ledgerPos: { ledgerPartition: m.position.ledgerPartition, sequence: BigInt(m.position.sequence), commitTs: toC05(m.position.commitTs as HlcTs) },
      feed: [feed],
      movements: m.lines.filter((l) => l.outcome === 'posted').map((l) => ({ movementKind: l.kind, amount: BigInt(l.amount ?? '0'), sourceRef: m.movementRef })),
      balance: BigInt(m.buyer.balanceAfter),
      writtenOffOwed: BigInt(m.buyer.writtenOffOwedAfter),
      postedThrough: { exceptions: [] },
      feesPosted: [],
    };
    const checkpoint: RowRef = { table: TABLE.feedCheckpoint, key: { account: acct.partition, source: feed.source, feed_partition: feed.partition, feed_seq: feed.seq } };
    const r = await this.enqueue(acct, () => this.appendFundsEntry(acct, ENTRY.F1, `F1|${id}`, f1,
      [{ kind: 'rowAbsent', row: checkpoint, label: 'newFeed' }],
      [{ table: TABLE.feedCheckpoint, op: 'upsert', key: checkpoint.key, row: { ...(checkpoint.key as object) } }]));
    if (r.kind !== 'committed' && !(r.kind === 'conditionFailed' && r.which === 'newFeed')) acct.feedSeen.delete(id);
  }

  // ---------------- C10 book ----------------

  /** C10 `book` as the edge forwards it (RFC-002 §3.1). `account` is the partition the edge routed to. */
  async book(account: string, call: BookCall): Promise<C10Answer> {
    const acct = this.accountOf(account);
    const slot = this.slotOf(acct);
    const refused = this.checkPrincipal(acct, call.principal);
    if (refused) return refused;
    if (this.movedOut.has(hex(acct.partition))) return { http: 503, body: { error: 'temporarily_unavailable' }, retryAfterS: 1 };
    // Step 2: rate limits (ACCT-I7 adds the windows) and the revocation read (JR-1).
    const rc = this.funds.rateCheck({} as never, BigInt(wallMs(this.rt.now().ts)), principalCtx(call.principal, account));
    if (rc.kind === 'NotAccepted') {
      if (rc.reason === 'revoked') return unauthenticated();
      return { http: 429, body: { error: 'not_accepted', code: 'rate_limited', retry_after_ms: Number(rc.retryAfterMs) } };
    }
    // Step 3: the idempotency lookup in the projected state, before every check that can create a request.
    const fingerprint = fingerprintOf(call.body);
    const known = acct.idem.get(call.key);
    if (known) {
      if (known.principal !== call.principal.principal_id) return keyReuse('key_reuse_other_principal');
      if (known.fingerprint !== fingerprint) return keyReuse('key_reuse_different_request');
      const r = await known.intake;
      if (r !== 'ok') return r;
      return this.answerWithin(acct, known.req, call.receivedAtMono);
    }
    // C10 check 4: AM-I1 issues no quote, so every cited quote_id is not parseable (404, nothing recorded).
    if (call.body.quote_id !== undefined) return { http: 404, body: { error: 'not_found' } };
    // Step 4: validation, then compose the intake (composed one at a time, in arrival order).
    const req = this.newReq(acct, call, fingerprint);
    const invalid = this.validate(req);
    let resolveIntake!: (v: 'ok' | C10Answer) => void;
    const intake = new Promise<'ok' | C10Answer>((res) => { resolveIntake = res; });
    acct.idem.set(call.key, { principal: req.principal, fingerprint, req, intake });
    const r = await this.enqueue(acct, () => this.appendIntake(acct, req, call.principal, invalid));
    if (r.kind !== 'committed') {
      // Not durable: no answer can say pending. The key is not consumed; the client retries with it.
      acct.idem.delete(call.key);
      const ans = this.unavailable(r);
      resolveIntake(ans);
      return ans;
    }
    resolveIntake('ok');
    if (req.state === 'undecided') void this.workflow(acct, req).catch((err: unknown) => this.alert('WORKFLOW_FAILED', account, String(err)));
    return this.answerWithin(acct, req, call.receivedAtMono);
  }

  private newReq(acct: Acct, call: BookCall, fingerprint: string): Req {
    const b = call.body;
    const route = this.catalogue.routeOf(b.legs);
    const req: Req = {
      account: acct.account, key: call.key, fingerprint, principal: call.principal.principal_id,
      principalKind: call.principal.kind, body: b,
      routeId: route?.routeId ?? '', product: b.product_id,
      start: minuteOfC10(b.window.start) ?? -1n,
      end: b.window.end === null ? null : (minuteOfC10(b.window.end) ?? -1n),
      rateMbps: b.rate_mbps, wait: b.wait ?? true,
      deadlineMs: b.deadline_ms ?? C10_PARAMS.deadlineDefaultMs,
      receiptMinute: BigInt(Math.floor(wallMs(this.rt.now().ts) / 60_000)),
      legs: b.legs.map((link, i) => ({ link, leg: `leg${i}`, state: 'requested' })),
      state: 'composing', decisionFormed: false, pendingSent: false, waiters: [],
    };
    if (call.principal.key_id !== undefined) req.keyId = call.principal.key_id;
    return req;
  }

  /** C10 checks 1 and 2 (RFC-002 §3.2). Returns the reason code of an invalid request, or undefined. */
  private validate(req: Req): ReasonCode | undefined {
    const b = req.body;
    const route = this.catalogue.routeOf(b.legs);
    if (b.legs.length === 0 || new Set(b.legs).size !== b.legs.length || !route) return 'unknown_route';
    for (const l of b.legs) if (!this.catalogue.link(l)) return 'unknown_route';
    if (!this.catalogue.productSold(b.product_id, route.routeId)) return 'product_not_on_route';
    if (req.start < 0n || req.end === -1n) return 'invalid_window';
    if (req.end !== null && req.end <= req.start) return 'invalid_window';
    if (req.start < req.receiptMinute) return 'invalid_window';
    const horizon = BigInt(Math.floor(addUtcMonths(Number(req.receiptMinute) * 60_000, 12) / 60_000));
    if (req.start >= horizon || (req.end !== null && req.end > horizon)) return 'beyond_selling_horizon';
    if (!Number.isInteger(b.rate_mbps) || b.rate_mbps < C10_PARAMS.rateMinMbps) return 'invalid_rate';
    for (const l of b.legs) if (b.rate_mbps > (this.catalogue.link(l)?.capacityMbps ?? 0)) return 'invalid_rate';
    if (!Number.isInteger(req.deadlineMs) || req.deadlineMs < C10_PARAMS.deadlineMinMs || req.deadlineMs > C10_PARAMS.deadlineMaxMs) return 'invalid_deadline';
    return undefined;
  }

  /** C08 §A receiver checks and RFC-002 §3.1 step 2 (C08 C-01). */
  private checkPrincipal(acct: Acct, ctx: PrincipalContext): C10Answer | undefined {
    const nowUs = BigInt(wallMs(this.rt.now().ts)) * 1_000n;
    if (ctx.schema !== 'principal.v1' || nowUs > ctx.expires_at) return unauthenticated();
    if (ctx.tenant.kind !== 'account' || ctx.tenant.account !== acct.account) return { http: 404, body: { error: 'not_found' } };
    if (ctx.kind === 'agent_key' || ctx.kind === 'probe') {
      if (!ctx.key_id) return unauthenticated();
      const rec = ctx.key_record;
      if (rec && (rec.key_id !== ctx.key_id || rec.tenant.kind !== 'account' || rec.tenant.account !== acct.account)) return unauthenticated();
      const st = this.funds.keyStatus(acct.funds, ctx.key_id);
      if (st === 'revoked') return unauthenticated();
      // A key not yet applied by F4 (a provisional key, C05 S-1) is AM-I9.
      if (st === 'absent') return unauthenticated();
    } else if (ctx.kind !== 'account_user') {
      return { http: 403, body: { error: 'refused', right: 'booking.submit' } };
    }
    return undefined;
  }

  // ---------------- Appends ----------------

  /** One batch in flight per partition: appends of one account run one after the other. */
  private enqueue<T>(acct: Acct, fn: () => Promise<T>): Promise<T> {
    const run = acct.lane.then(fn, fn);
    acct.lane = run.catch(() => undefined);
    return run;
  }

  /** C01 §3.2 result handling, the same identities on every retry (C01 CC-1). */
  private async appendWithRetry(acct: Acct, build: () => AppendCall): Promise<AppendOutcome> {
    for (let i = 0; i < OWNER_PARAMS.appendRetries; i++) {
      const r: AppendResult = await this.rt.append(build());
      switch (r.r) {
        case 'Committed':
          return { kind: 'committed', ts: r.ts, seqFrom: r.seqFrom, seqTo: r.seqTo };
        case 'ConditionFailed':
          return { kind: 'conditionFailed', which: r.which };
        case 'StaleEpoch':
          return { kind: 'slotLost' };
        case 'Stopped':
          return { kind: 'unavailable', retryAfterS: 1, why: 'stopped' };
        case 'Moved':
          return { kind: 'unavailable', retryAfterS: 1, why: 'moved' };
        case 'Overloaded':
          await sleep(Math.min(r.retryAfterMs, 100));
          continue;
        case 'Retry': case 'Ambiguous': case 'Moving':
          // Not known to be committed. The next attempt has the same identities, and its conditions find
          // an entry that did commit (RFC-002 §2.1 "reloads before deciding again").
          continue;
        default:
          // C01 §8: an unknown result is Retry, with an alert.
          this.alert('UNKNOWN_APPEND_RESULT', acct.account, (r as { r: string }).r);
          continue;
      }
    }
    return { kind: 'unavailable', retryAfterS: 1, why: 'retries exhausted' };
  }

  /** E9 (first entry of an epoch in the partition) and F10 (rules version) before the batch's own entries. */
  private prelude(acct: Acct, ctx: BatchContext, entries: EntryInput[], funds: FundsState): { seq: bigint; funds: FundsState } {
    const head: HeadRow = ctx.head(acct.partition);
    let seq = head.seq;
    const epoch = this.rt.epoch(this.slotOf(acct));
    if (head.exists && head.epoch !== epoch) {
      seq += 1n;
      entries.push(entry(ENTRY.E9, `E9|${acct.account}|${epoch}`, internalAudit(), { booking: { epoch: epoch.toString(), holder: 'account-owner' } }));
    }
    if (rulesVersionOf(funds) !== this.rules) {
      seq += 1n;
      const input: Input = { kind: 'F10', rules: this.rules };
      const fctx: Ctx = { pos: { partition: acct.account, sequence: seq }, ts: toC05(ctx.ts), rules: this.rules };
      const applied = this.funds.apply(funds, fctx, input);
      if (applied.kind !== 'Applied') throw new Error('F10 deferred');
      funds = applied.state;
      entries.push(entry(ENTRY.F10, `F10|${acct.account}|${this.rules}`, internalAudit(), { funds: { input, rules: this.rules, outcomes: applied.outcomes } }));
    }
    return { seq, funds };
  }

  private async appendFundsEntry(acct: Acct, kind: number, identity: string, input: F1 | F4, conditions: Condition[], projections: ProjectionWrite[] = []): Promise<AppendOutcome> {
    let staged: FundsState | undefined;
    const r = await this.appendWithRetry(acct, () => ({
      partition: acct.partition,
      conditions,
      decide: (ctx) => this.inDecide(() => {
        const entries: EntryInput[] = [];
        const pre = this.prelude(acct, ctx, entries, acct.funds);
        const seq = pre.seq + 1n;
        const fctx: Ctx = { pos: { partition: acct.account, sequence: seq }, ts: toC05(ctx.ts), rules: this.rules };
        const applied = this.funds.apply(pre.funds, fctx, input);
        if (applied.kind !== 'Applied') return null;
        staged = applied.state;
        entries.push(entry(kind, identity, internalAudit(), { funds: { input, rules: this.rules, outcomes: applied.outcomes } }));
        return { entries, projections: [...projections, this.fundsRow(acct, applied.state)] };
      }),
    }));
    if (r.kind === 'committed' && staged) acct.funds = staged;
    return r;
  }

  /** E1 or E1′ (RFC-002 §2.2, §3.1 step 4): validation result, `admit` at `ts`, D and D_c at `ts`. */
  private async appendIntake(acct: Acct, req: Req, principal: PrincipalContext, invalid: ReasonCode | undefined): Promise<AppendOutcome> {
    const idemRow: RowRef = { table: TABLE.idempotency, key: { account: acct.partition, family: FAMILY, idem_key: req.key } };
    let staged: { funds: FundsState; seq: bigint; ts: HlcTs; D: number; Dc: number; tau: number; price?: { priceVersion: string; pico: bigint };
      state: RequestState; reason?: ReasonCode; amounts?: RequestStatus['amounts'] } | undefined;
    const r = await this.appendWithRetry(acct, () => ({
      partition: acct.partition,
      conditions: [{ kind: 'rowAbsent', row: idemRow, label: 'newKey' }],
      decide: (ctx) => this.inDecide(() => {
        const entries: EntryInput[] = [];
        const pre = this.prelude(acct, ctx, entries, acct.funds);
        const seq = pre.seq + 1n;
        let funds = pre.funds;
        const ts = ctx.ts;
        const tau = ctx.timing.tauMs;
        const D = wallMs(ts) + req.deadlineMs;
        const Dc = D - tau;
        const audit = principalAudit(principal);
        const requestId = { partition: acct.account, sequence: seq };
        let state: RequestState = 'undecided';
        let reason: ReasonCode | undefined = invalid;
        let amounts: RequestStatus['amounts'] | undefined;
        let fundsPayload: unknown;
        let checkedHeadroom = 0n;
        // Check 4, terms shown: the price in force at ts is locked (POL-27). No partner leg, so no quote is needed.
        const price = invalid ? undefined : this.catalogue.priceAt(req.product, req.routeId, minuteOfTs(ts));
        if (!invalid && !price) reason = 'product_not_on_route';
        if (reason) {
          state = 'invalid';
        } else {
          const ask = this.askOf(req, requestId, ts, price!.price);
          const fctx: Ctx = { pos: requestId, ts: toC05(ts), rules: this.rules };
          const verdict: Verdict = this.funds.admit(funds, fctx, ask);
          const applied = this.funds.apply(funds, fctx, { kind: 'Intake', request: requestId, ask, verdict });
          if (applied.kind !== 'Applied') return null;
          funds = applied.state;
          fundsPayload = { call: 'admit', ask, verdict, rules: this.rules, outcomes: applied.outcomes };
          if (verdict.kind === 'Refuse') {
            state = 'rejected';
            ({ reason, amounts } = refusalOf(verdict));
            checkedHeadroom = verdict.checked.headroom;
          }
        }
        const record = {
          request: `${acct.account}:${seq}`, key: req.key, fingerprint: req.fingerprint, principal: req.principal,
          keyId: req.keyId ?? null, kind: 'book', legs: req.legs.map((l) => ({ link: l.link, kind: 'share' })),
          route: req.routeId, product: req.product, window: { start: req.start, end: req.end }, rateMbps: req.rateMbps,
          wait: req.wait, D, requestAge: ts, Dc, tauMs: tau, receiptMinute: req.receiptMinute,
          policyVersion: OWNER_PARAMS.linkPolicyVersion,
          lockedPrice: price ? { priceVersion: price.priceVersion, pico: price.price, cataloguePosition: this.catalogue.resolvedTs } : null,
          quoteId: null,
          ...(state === 'undecided' ? {} : { outcome: state, reason }),
        };
        const kind = state === 'undecided' ? ENTRY.E1 : ENTRY.E1p;
        const e = entry(kind, `E1|${acct.account}|${req.key}`, audit, { booking: record, ...(fundsPayload ? { funds: fundsPayload } : {}) });
        const projections: ProjectionWrite[] = [
          { table: TABLE.idempotency, op: 'upsert', key: idemRow.key, row: { ...(idemRow.key as object), request_seq: seq, fingerprint: utf8(req.fingerprint), principal: req.principal, expires_at: isoMs(wallMs(ts) + C10_PARAMS.idempotencyRetentionMs) } },
          this.requestRow(acct, seq, state, record, ts),
          this.fundsRow(acct, funds),
        ];
        if (state !== 'undecided') {
          projections.push(decisionRow(acct, seq, seq));
          e.emits = [{ stream: 'outcome', event: this.outcomeEvent(acct, req, seq, seq, ts, state, outcomeReason(state, reason!, amounts, req, checkedHeadroom)) }];
          if (req.pendingSent) e.pendingAnswered = utf8(`${acct.account}:${seq}`);
        }
        entries.push(e);
        staged = { funds, seq, ts, D, Dc, tau, state, ...(price ? { price: { priceVersion: price.priceVersion, pico: price.price } } : {}),
          ...(reason ? { reason } : {}), ...(amounts ? { amounts } : {}) };
        return { entries, projections };
      }),
    }));
    if (r.kind === 'conditionFailed' && r.which === 'newKey') {
      // The key is already in the committed index: an earlier attempt did commit. Reload it (CT-P04 basis).
      return this.reloadRequest(acct, req, idemRow);
    }
    if (r.kind !== 'committed' || !staged) return r;
    acct.funds = staged.funds;
    req.seq = staged.seq; req.intakeTs = staged.ts; req.D = staged.D; req.Dc = staged.Dc; req.tauMs = staged.tau;
    if (staged.price) req.price = staged.price;
    req.state = staged.state;
    if (staged.reason) req.reason = staged.reason;
    if (staged.amounts) req.amounts = staged.amounts;
    if (staged.state !== 'undecided') { req.decidedTs = staged.ts; req.releasesDurableTs = staged.ts; }
    acct.requests.set(staged.seq.toString(), req);
    this.changed(acct, req);
    return r;
  }

  /** Read the committed idempotency and request rows inside the transaction, and adopt them. */
  private async reloadRequest(acct: Acct, req: Req, idemRow: RowRef): Promise<AppendOutcome> {
    let found: Record<string, unknown> | undefined;
    await this.rt.append({ partition: acct.partition, reads: [idemRow], decide: (ctx) => { found = ctx.read(idemRow) as Record<string, unknown> | undefined; return null; } });
    if (!found) return { kind: 'unavailable', retryAfterS: 1, why: 'reload' };
    const seq = BigInt(found['request_seq'] as bigint);
    const reqRow: RowRef = { table: TABLE.request, key: { account: acct.partition, request_seq: seq } };
    let row: Record<string, unknown> | undefined;
    await this.rt.append({ partition: acct.partition, reads: [reqRow], decide: (ctx) => { row = ctx.read(reqRow) as Record<string, unknown> | undefined; return null; } });
    if (!row) return { kind: 'unavailable', retryAfterS: 1, why: 'reload' };
    const rec = decodeJson(row['record'] as Uint8Array) as Record<string, unknown>;
    req.seq = seq; req.intakeTs = rec['requestAge'] as HlcTs; req.D = Number(rec['D']); req.Dc = Number(rec['Dc']); req.tauMs = Number(rec['tauMs']);
    req.state = (rec['outcome'] as RequestState | undefined) ?? 'undecided';
    if (rec['reason']) req.reason = rec['reason'] as ReasonCode;
    if (req.state !== 'undecided') { req.decidedTs = row['decided_ts'] as HlcTs; req.releasesDurableTs = req.decidedTs; }
    acct.requests.set(seq.toString(), req);
    this.changed(acct, req);
    return { kind: 'committed', ts: req.intakeTs, seqFrom: seq, seqTo: seq };
  }

  private askOf(req: Req, request: { partition: string; sequence: bigint }, ts: HlcTs, pico: bigint): Ask {
    const ask: Ask = {
      request, principal: req.principal, kind: 'New',
      scheduleAfter: this.scheduleOf(req, ts, pico),
      mbps: BigInt(req.rateMbps),
    };
    if (req.keyId !== undefined) ask.key = req.keyId;
    return ask;
  }

  private scheduleOf(req: Req, ts: HlcTs, pico: bigint): Schedule {
    const interval = { start: req.start, end: req.end };
    const seg = { part: 'part1', interval, principal: req.principal, ...(req.keyId !== undefined ? { key: req.keyId } : {}) };
    return {
      parts: [{ part: 'part1', rate: [{ from: req.start, mbps: BigInt(req.rateMbps) }], lockedPrice: pico, interval, age: toC05(ts) }],
      priceSteps: [],
      segments: [seg],
      end: req.end,
    };
  }

  // ---------------- Workflow ----------------

  /** RFC-002 §5.1, §5.4, §5.6, §5.7 for one Share leg. */
  private async workflow(acct: Acct, req: Req): Promise<void> {
    if (req.legs.length !== 1) {
      this.alert('MULTI_LEG_ROUTE_NOT_IN_AM_I1', acct.account);
      return;
    }
    const leg = req.legs[0]!;
    const reply = await this.command<HoldReply>(acct, leg.link, `hold|${acct.account}:${req.seq}|${leg.leg}`, (env) => this.links.hold(env, this.holdCmd(acct, req, leg)));
    if (reply === undefined) return;
    if (isRoutingRefusal(reply)) {
      this.alert(`HOLD_${reply.code}`, acct.account);
      return;
    }
    if (reply.result === 'HELD') {
      leg.attempt = reply.attempt; leg.state = 'held';
      await this.confirm(acct, req);
    } else if (reply.result === 'REFUSED' && reply.reason === 'NO_FIT') {
      leg.state = 'refused';
      // The refusal records a tombstone and is this leg's release acknowledgement (C02), so E7 records it.
      await this.end(acct, req, 'no_fit', reply.counterOffer, true);
    } else {
      // WAITING, IN_FLIGHT, DEADLINE_PASSED, TOMBSTONED and INVALID come in ACCT-I8 and ACCT-I10.
      this.alert(`HOLD_REPLY_NOT_IN_AM_I1:${JSON.stringify(reply.result)}`, acct.account);
    }
  }

  private holdCmd(acct: Acct, req: Req, leg: LegState): HoldCmd {
    return {
      link: leg.link, receiverPartition: leg.link,
      request: this.c02Request(acct, req), account: acct.partition, leg: leg.leg, holdKind: { kind: 'booking' },
      rateMbps: req.rateMbps, window: { start: Number(req.start), end: req.end === null ? null : Number(req.end) },
      deadline: req.D!, commitFence: req.Dc!, requestAge: req.intakeTs!, wait: req.wait,
      receiptMinute: Number(req.receiptMinute), policyVersion: OWNER_PARAMS.linkPolicyVersion,
    };
  }

  private c02Request(acct: Acct, req: Req): C02RequestId {
    return { partition: acct.partition, seq: req.seq! };
  }

  /** E5 (RFC-002 §5.6). The decision row, the fence, `iam_fresh` and the displacement read are conditions. */
  private async confirm(acct: Acct, req: Req): Promise<void> {
    const slot = this.slotOf(acct);
    for (let round = 0; round < 3; round++) {
      let fresh = this.iamFresh.get(slot);
      if (fresh === undefined) {
        // An unset watermark fails the check (C05). Pull the catch-up, then try again.
        await this.catchUp(slot);
        fresh = this.iamFresh.get(slot);
        if (fresh === undefined) { this.alert('IDENTITY_STALE', acct.account); return; }
      }
      const r = await this.enqueue(acct, () => this.appendConfirm(acct, req, fresh!));
      if (r.kind === 'committed') {
        await this.convert(acct, req);
        return;
      }
      if (r.kind === 'conditionFailed') {
        if (r.which === 'lockTimeout') continue;                       // J-14: only this E5 moves to the next batch
        if (r.which === 'iamFresh') { this.iamFresh.delete(slot); continue; }
        if (r.which.startsWith('displacement:')) {
          // A marker of any attempt: the reduction committed first. No E5 (C02-C 7, first row).
          await this.end(acct, req, 'no_fit', undefined, false);
          return;
        }
        if (r.which === 'fence') { this.alert('CONFIRM_FENCE_PASSED', acct.account); return; }   // expiry: ACCT-I8
        this.alert(`CONFIRM_CONDITION_${r.which}`, acct.account);
        return;
      }
      this.alert(`CONFIRM_${r.kind}`, acct.account);
      return;
    }
  }

  private async appendConfirm(acct: Acct, req: Req, iamFreshNs: bigint): Promise<AppendOutcome> {
    const reqSeq = req.seq!;
    const dRow = decisionRow(acct, reqSeq, 0n);
    const fenceNs = BigInt(req.D! - req.tauMs!) * 1_000_000n;
    const conditions: Condition[] = [
      { kind: 'rowAbsent', row: { table: dRow.table, key: dRow.key }, label: 'undecided' },
      { kind: 'tsBefore', bound: () => hlcAtNs(fenceNs), label: 'fence' },
      // ts ≤ iam_fresh + 45 s, in wall nanoseconds (C05): strictly before the next nanosecond.
      { kind: 'tsBefore', bound: () => hlcAtNs(iamFreshNs + OWNER_PARAMS.iamFreshMaxNs + 1n), label: 'iamFresh' },
      ...req.legs.map((l, i): Condition => ({
        kind: 'displacementRead', link: utf8(l.link), request: displacementRequestBytes(this.c02Request(acct, req)),
        attempt: l.attempt ?? 0, lockTimeoutMs: OWNER_PARAMS.displacementLockTimeoutMs, label: `displacement:${i}`,
      })),
    ];
    let staged: { funds: FundsState; seq: bigint; reservation: string } | undefined;
    const r = await this.appendWithRetry(acct, () => ({
      partition: acct.partition,
      conditions,
      decide: (ctx) => this.inDecide(() => {
        // The account must be active for a request that adds something (P2-S69). Suspension is AM-I11.
        if (this.funds.standing(acct.funds).standing !== 'active') return null;
        const entries: EntryInput[] = [];
        const pre = this.prelude(acct, ctx, entries, acct.funds);
        const seq = pre.seq + 1n;
        const reservation = `rsv-${acct.account}-${seq}`;
        const requestId = { partition: acct.account, sequence: reqSeq };
        const schedule = this.scheduleOf(req, req.intakeTs!, req.price!.pico);
        const fctx: Ctx = { pos: { partition: acct.account, sequence: seq }, ts: toC05(ctx.ts), rules: this.rules };
        const input: Input = { kind: 'Decided', request: requestId, outcome: { kind: 'Confirmed', reservation, schedule } };
        const applied = this.funds.apply(pre.funds, fctx, input);
        if (applied.kind !== 'Applied') return null;
        req.decisionFormed = true;
        const record = {
          request: `${acct.account}:${reqSeq}`, legs: req.legs.map((l) => ({ link: l.link, leg: l.leg, attempt: l.attempt })),
          ts: ctx.ts, tauMs: req.tauMs, iamFresh: hlcAtNs(iamFreshNs), checks: { standing: 'active', withdrawn: false },
          reservation: { id: reservation, route: req.routeId, product: req.product, window: { start: req.start, end: req.end },
            parts: [{ part: 'part1', rateMbps: req.rateMbps, principal: req.principal, key: req.keyId ?? null }] },
        };
        const e = entry(ENTRY.E5, `E5|${acct.account}:${reqSeq}`, internalAudit(req), { booking: record, funds: { input, rules: this.rules, outcomes: applied.outcomes } });
        e.emits = [
          { stream: 'outcome', event: this.outcomeEvent(acct, req, seq, reqSeq, ctx.ts, 'confirmed', { code: 'confirmed' }, reservation) },
          { stream: 'lifecycle', event: this.confirmedEvent(acct, req, seq, ctx.ts, reservation) },
        ];
        if (req.pendingSent) e.pendingAnswered = utf8(`${acct.account}:${reqSeq}`);
        entries.push(e);
        staged = { funds: applied.state, seq, reservation };
        const projections: ProjectionWrite[] = [
          decisionRow(acct, reqSeq, seq),
          this.requestRow(acct, reqSeq, 'confirmed', record, ctx.ts),
          { table: TABLE.reservation, op: 'upsert', key: { account: acct.partition, reservation }, row: { account: acct.partition, reservation, record: encodeJson(record.reservation) } },
          this.fundsRow(acct, applied.state),
        ];
        return { entries, projections };
      }),
    }));
    if (r.kind === 'committed' && staged) {
      acct.funds = staged.funds;
      req.state = 'confirmed'; req.decidedTs = r.ts; req.e5Seq = staged.seq; req.reservationId = staged.reservation;
      this.changed(acct, req);
    }
    return r;
  }

  /** C02 `convert` with the attempt that `HELD` carried, in the leg's queue at the E5's position (§5.7). */
  private async convert(acct: Acct, req: Req): Promise<void> {
    for (const leg of req.legs) {
      const cmd: ConvertCmd = {
        link: leg.link, receiverPartition: leg.link, request: this.c02Request(acct, req), attempt: leg.attempt!,
        reservation: req.reservationId!, leg: leg.leg, part: 'part1',
        createdBy: { partition: acct.partition, seq: req.e5Seq! }, decisionTime: req.decidedTs!,
      };
      const reply = await this.command<ConvertReply>(acct, leg.link, `convert|${acct.account}:${req.seq}|${leg.leg}`, (env) => this.links.convert(env, cmd));
      if (reply && 'result' in reply && reply.result === 'CONVERTED') leg.state = 'converted';
      else if (reply) this.alert(`CONVERT_${'code' in reply ? reply.code : 'UNKNOWN'}`, acct.account);
    }
  }

  /** E7 (RFC-002 §2.2): rejected. `releasesInHand` is true when every Share leg has acknowledged. */
  private async end(acct: Acct, req: Req, reason: ReasonCode, co: C02CounterOffer | undefined, releasesInHand: boolean): Promise<void> {
    const reqSeq = req.seq!;
    const dRow = decisionRow(acct, reqSeq, 0n);
    if (co) {
      req.counterOffer = {
        largest_rate_mbps: co.largestRateMbps,
        earliest_window: 'window' in co.earliest ? { start: isoMinuteC10(BigInt(co.earliest.window.start)), end: co.earliest.window.end === null ? null : isoMinuteC10(BigInt(co.earliest.window.end)) } : null,
        blocking_link: { link_id: req.legs[0]!.link, leg_index: 0 },
        share_legs_only: false,
      };
    }
    let staged: FundsState | undefined;
    const r = await this.enqueue(acct, () => this.appendWithRetry(acct, () => ({
      partition: acct.partition,
      conditions: [{ kind: 'rowAbsent', row: { table: dRow.table, key: dRow.key }, label: 'undecided' }],
      decide: (ctx) => this.inDecide(() => {
        const entries: EntryInput[] = [];
        const pre = this.prelude(acct, ctx, entries, acct.funds);
        const seq = pre.seq + 1n;
        const requestId = { partition: acct.account, sequence: reqSeq };
        const fctx: Ctx = { pos: { partition: acct.account, sequence: seq }, ts: toC05(ctx.ts), rules: this.rules };
        const input: Input = { kind: 'Decided', request: requestId, outcome: { kind: 'NotConfirmed' } };
        const applied = this.funds.apply(pre.funds, fctx, input);
        if (applied.kind !== 'Applied') return null;
        req.decisionFormed = true;
        const record = { request: `${acct.account}:${reqSeq}`, outcome: 'rejected', reason, blockingLink: req.legs[0]!.link,
          counterOffer: req.counterOffer ?? null, releasesDurable: releasesInHand };
        const e = entry(ENTRY.E7, `E7|${acct.account}:${reqSeq}`, internalAudit(req), { booking: record, funds: { input, rules: this.rules, outcomes: applied.outcomes } });
        if (releasesInHand) {
          e.emits = [{ stream: 'outcome', event: this.outcomeEvent(acct, req, seq, reqSeq, ctx.ts, 'rejected', outcomeReason('rejected', reason, undefined, req)) }];
          if (req.pendingSent) e.pendingAnswered = utf8(`${acct.account}:${reqSeq}`);
        }
        entries.push(e);
        staged = applied.state;
        return { entries, projections: [decisionRow(acct, reqSeq, seq), this.requestRow(acct, reqSeq, 'rejected', record, ctx.ts), this.fundsRow(acct, applied.state)] };
      }),
    })));
    if (r.kind !== 'committed' || !staged) { this.alert(`END_${r.kind}`, acct.account); return; }
    acct.funds = staged;
    req.state = 'rejected'; req.reason = reason; req.decidedTs = r.ts;
    if (releasesInHand) { req.releasesDurableTs = r.ts; this.changed(acct, req); return; }
    this.changed(acct, req);
    // Request-scoped release to every Share leg of the intake, then E8 once every leg has acknowledged (§5.7).
    for (const leg of req.legs) {
      const cmd: ReleaseCmd = { link: leg.link, receiverPartition: leg.link, request: this.c02Request(acct, req), deadline: req.D!, reason: 'REJECTED', decisionTime: req.decidedTs };
      const reply = await this.command<ReleaseReply>(acct, leg.link, `release|${acct.account}:${req.seq}|${leg.leg}`, (env) => this.links.release(env, cmd));
      if (reply && 'result' in reply && reply.result === 'RELEASED') leg.state = 'released';
    }
    if (req.legs.some((l) => l.state !== 'released')) { this.alert('RELEASE_INCOMPLETE', acct.account); return; }
    const e8 = await this.enqueue(acct, () => this.appendWithRetry(acct, () => ({
      partition: acct.partition,
      decide: (ctx) => this.inDecide(() => {
        const entries: EntryInput[] = [];
        const pre = this.prelude(acct, ctx, entries, acct.funds);
        const e = entry(ENTRY.E8, `E8|${acct.account}:${reqSeq}`, internalAudit(req), { booking: { request: `${acct.account}:${reqSeq}`, legs: req.legs.map((l) => l.link), complete: true } });
        e.emits = [{ stream: 'outcome', event: this.outcomeEvent(acct, req, pre.seq + 1n, reqSeq, req.decidedTs!, 'rejected', outcomeReason('rejected', reason, undefined, req)) }];
        if (req.pendingSent) e.pendingAnswered = utf8(`${acct.account}:${reqSeq}`);
        entries.push(e);
        return { entries };
      }),
    })));
    if (e8.kind === 'committed') { req.releasesDurableTs = e8.ts; this.changed(acct, req); }
  }

  /** Send one C02 command from memory: lease check immediately before the send (CC-7); routing refusals retried. */
  private async command<R>(acct: Acct, link: string, identity: string, send: (env: CommandEnvelope) => Promise<R | RoutingRefusal>): Promise<R | RoutingRefusal | undefined> {
    const slot = this.slotOf(acct);
    let last: R | RoutingRefusal | undefined;
    for (let i = 0; i < OWNER_PARAMS.commandRetries; i++) {
      const route = this.rt.route(LINK_KIND, utf8(link));
      const env: CommandEnvelope = {
        routedTo: { kind: LINK_KIND, slot: route.slot, generation: route.generation, epoch: route.epoch, ...(route.mapVersion !== undefined ? { mapVersion: route.mapVersion } : {}) },
        sender: { kind: ACCOUNT_KIND, partition: acct.partition, generation: this.rt.generation(acct.partition), epoch: this.rt.epoch(slot) },
        identity: utf8(identity),
      };
      if (!this.rt.leaseValid(slot).valid) return undefined;   // a deposed holder sends nothing; the new holder re-sends
      last = await send(env);
      if (!isRoutingRefusal(last) || !ROUTING_RETRY_CODES.has((last as RoutingRefusal).code)) return last;
      await sleep(Math.min(10 * (i + 1), 50));
    }
    return last;
  }

  // ---------------- Answers ----------------

  /** RFC-002 §8.1: final if reported in time, else `pending` at ack_budget less the edge's share. */
  private async answerWithin(acct: Acct, req: Req, receivedAtMono: number): Promise<C10Answer> {
    const ackAt = receivedAtMono + C10_PARAMS.ackBudgetMs - C10_PARAMS.edgeShareMs;
    for (;;) {
      if (this.isReported(acct, req)) return this.reply(acct, req, true);
      const remaining = ackAt - this.monoMs();
      if (remaining <= 0 && req.state !== 'composing') {
        if (!req.decisionFormed) req.pendingSent = true;
        return this.reply(acct, req, false);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.max(remaining, 1));
        req.waiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
  }

  private reply(acct: Acct, req: Req, final: boolean): C10Answer {
    const slot = this.slotOf(acct);
    if (!this.rt.leaseValid(slot).valid) return { http: 503, body: { error: 'temporarily_unavailable' }, retryAfterS: 1 };
    this.onReplyHook?.(`${final ? 'final' : 'pending'}:${acct.account}:${req.seq}`);
    const body = this.statusBody(req, final);
    return final ? { http: 200, body } : { http: 202, body };
  }

  /** The RequestStatus of a request. `final` false gives `pending` (C10 "Status-read guarantees"). */
  statusBody(req: Req, final: boolean): RequestStatus {
    const s: RequestStatus = {
      request_id: `${req.account}:${req.seq}`,
      idempotency_key: req.key,
      request_kind: 'booking',
      state: final ? (req.state as RequestStatus['state']) : 'pending',
      key_expires_at: isoMs(wallMs(req.intakeTs!) + C10_PARAMS.idempotencyRetentionMs),
    };
    if (req.D !== undefined && req.state !== 'invalid') s.deadline = isoMs(req.D);
    if (!final) return s;
    if (req.decidedTs) s.decided_at = isoMs(wallMs(req.decidedTs));
    if (req.state === 'confirmed') {
      s.reservation_id = req.reservationId!;
      s.shown = { price: { currency: 'USD', micros_per_mbps_minute: picoToMicroDecimal(req.price!.pico) }, price_version: req.price!.priceVersion, partner_legs: [] };
    } else {
      if (req.reason) s.reason = req.reason;
      if (req.state === 'invalid') s.rule = req.reason!;
      if (req.amounts) s.amounts = req.amounts;
      if (req.counterOffer) s.counter_offer = req.counterOffer;
      if (req.state === 'rejected' && req.price) s.shown = { price: { currency: 'USD', micros_per_mbps_minute: picoToMicroDecimal(req.price.pico) }, price_version: req.price.priceVersion, partner_legs: [] };
    }
    return s;
  }

  /** The reporting gate (RFC-002 §8): the deciding entry, and for a non-confirmed outcome its E8, at or below the report position. */
  isReported(acct: Acct, req: Req): boolean {
    if (!req.decidedTs) return false;
    const gateTs = req.state === 'confirmed' ? req.decidedTs : req.releasesDurableTs;
    if (!gateTs) return false;
    const p = this.rt.reportPosition(this.slotOf(acct));
    return p !== undefined && compareHlc(gateTs, p) <= 0;
  }

  // ---------------- Read side (status reader stand-in) ----------------

  /** The committed request under (account, booking-and-change family, key), or undefined. */
  committedRequest(account: string, key: string): Req | undefined {
    const acct = this.accounts.get(account);
    const e = acct?.idem.get(key);
    return e && e.req.seq !== undefined && e.req.state !== 'composing' ? e.req : undefined;
  }

  accountState(account: string): { funds: FundsState; partition: PartitionKey; slot: SlotNo } | undefined {
    const a = this.accounts.get(account);
    return a ? { funds: a.funds, partition: a.partition, slot: this.slotOf(a) } : undefined;
  }

  requestBySeq(account: string, seq: bigint): Req | undefined {
    return this.accounts.get(account)?.requests.get(seq.toString());
  }

  reportedFor(account: string, req: Req): boolean {
    const a = this.accounts.get(account);
    return a ? this.isReported(a, req) : false;
  }

  principalCheck(account: string, ctx: PrincipalContext): C10Answer | undefined {
    return this.checkPrincipal(this.accountOf(account), ctx);
  }

  // ---------------- Events ----------------

  private outcomeEvent(acct: Acct, req: Req, entrySeq: bigint, reqSeq: bigint, decidedTs: HlcTs, outcome: OutcomeEvent['outcome'], reason: OutcomeReason, reservation?: string): OutcomeEvent {
    return {
      account: acct.account, entry_seq: entrySeq, withheld_by: null,
      slot: this.slotOf(acct),
      request: `${acct.account}:${reqSeq}`,
      idempotency_key_digest: createHmac('sha256', IDEM_DIGEST_SECRET).update(`${acct.account}|${FAMILY}|${req.key}`).digest('hex'),
      principal: req.principal,
      request_kind: 'book', change_kind: null,
      reservation: reservation ?? null,
      outcome, reason,
      decided_ts: decidedTs,
      stated_time: isoMs(wallMs(decidedTs)),
      leg: reason.code === 'no_fit' ? 0 : null,
      answered_pending: req.pendingSent,
    };
  }

  private confirmedEvent(acct: Acct, req: Req, entrySeq: bigint, ts: HlcTs, reservation: string): Confirmed {
    const window = { start: isoMinuteC04(req.start), end: req.end === null ? null : isoMinuteC04(req.end) };
    const by = { principal: req.principal, key: req.keyId ?? null };
    return {
      account: acct.account, entry_seq: entrySeq, withheld_by: null,
      account_is_probe: false, reservation, change_id: null,
      kind: 'confirmed', route: req.routeId, product: req.product, path: '0',
      legs: req.legs.map((l, i) => ({ index: i, link: l.link, kind: 'share', shown_fee: null })),
      window,
      parts: [{
        part: 'part1', own_rate: req.rateMbps, window,
        locked_price: req.price!.pico.toString(), price_version: req.price!.priceVersion,
        catalogue_position: this.catalogue.resolvedTs, locked_at: req.intakeTs!, age: req.intakeTs!,
        request: `${acct.account}:${req.seq}`, added_by: by,
      }],
      decided_ts: ts, announced_price_steps: [], booked_by: by,
    };
  }

  // ---------------- Helpers ----------------

  private accountOf(account: string): Acct {
    let a = this.accounts.get(account);
    if (!a) {
      a = { account, partition: utf8(account), funds: emptyFundsState(), requests: new Map(), idem: new Map(), feedSeen: new Set(), lane: Promise.resolve() };
      this.accounts.set(account, a);
    }
    return a;
  }

  private slotOf(acct: Acct): SlotNo {
    return this.rt.slotOf(acct.partition).slot;
  }

  private inDecide<T>(fn: () => T): T {
    this.insideDecide = true;
    try { return fn(); } finally { this.insideDecide = false; }
  }

  private requestRow(acct: Acct, seq: bigint, state: RequestState, record: unknown, ts: HlcTs): ProjectionWrite {
    const key = { account: acct.partition, request_seq: seq };
    return { table: TABLE.request, op: 'upsert', key, row: { ...key, state, record: encodeJson(record), decided_ts: state === 'undecided' ? null : ts, expires_at: isoMs(wallMs(ts) + C10_PARAMS.idempotencyRetentionMs) } };
  }

  private fundsRow(acct: Acct, funds: FundsState): ProjectionWrite {
    const key = { account: acct.partition };
    return { table: TABLE.funds, op: 'upsert', key, row: { ...key, balance: balanceOf(funds), standing: this.funds.standing(funds).standing } };
  }

  private changed(acct: Acct, req: Req): void {
    const ws = req.waiters.splice(0);
    for (const w of ws) w();
    void acct;
  }

  private pumpSlot(slot: SlotNo): void {
    for (const a of this.accounts.values()) {
      if (this.slotOf(a) !== slot) continue;
      for (const r of a.requests.values()) if (r.waiters.length > 0) this.changed(a, r);
    }
  }

  private unavailable(r: AppendOutcome): C10Answer {
    if (r.kind === 'conditionFailed') this.alert(`INTAKE_CONDITION_${r.which}`);
    return { http: 503, body: { error: 'temporarily_unavailable' }, retryAfterS: r.kind === 'unavailable' ? r.retryAfterS : 1 };
  }

  private alert(code: string, account?: string, detail?: string): void {
    this.alerts.push({ code, ...(account !== undefined ? { account } : {}), ...(detail !== undefined ? { detail } : {}) });
  }
}

// ---------- Free functions ----------

function entry(kind: number, identity: string, audit: AuditFields, payload: unknown): EntryInput {
  return { kind, schemaV: 1, identity: utf8(identity), audit, payload };
}

function decisionRow(acct: Acct, reqSeq: bigint, decidedSeq: bigint): ProjectionWrite & { key: unknown } {
  const key = { account: acct.partition, request_seq: reqSeq };
  return { table: TABLE.decision, op: 'upsert', key, row: { ...key, decided_seq: decidedSeq } };
}

/** C08 §A outcomes: the principal fields are copied into `audit` of every row the command causes. */
function principalAudit(ctx: PrincipalContext): AuditFields {
  const principal: AuditFields['principal'] = {
    principal_id: ctx.principal_id, kind: ctx.kind,
    tenant: ctx.tenant.kind === 'account' ? ctx.tenant.account : ctx.tenant.kind,
    edge_workload: ctx.edge_workload,
  };
  if (ctx.key_id !== undefined) principal.key_id = ctx.key_id;
  if (ctx.session_id !== undefined) principal.session_id = ctx.session_id;
  return {
    schema: 'audit.v1', principal,
    received_at: Number(ctx.received_at), request_id: ctx.request_id,
    decided_at: 'commit', policy_version: ctx.policy_version,
    iam_position: { identity_slot: ctx.iam_position.identity_slot, head: ctx.iam_position.head },
  };
}

function internalAudit(req?: Req): AuditFields {
  const a: AuditFields = {
    schema: 'audit.v1', principal: { principal_id: 'account-owner', kind: 'internal_service', tenant: 'none' },
    decided_at: 'commit', policy_version: 1,
  };
  if (req && req.seq !== undefined) a.on_behalf_of = { account: req.account, request_ref: `${req.account}:${req.seq}` };
  return a;
}

function principalCtx(ctx: PrincipalContext, account: string): { principal: string; tenant: string; key?: string } {
  return { principal: ctx.principal_id, tenant: account, ...(ctx.key_id !== undefined ? { key: ctx.key_id } : {}) };
}

/** POL-29 sameness for a booking: legs in order, window, rate, product, `wait`. Not the deadline nor `quote_id`. */
export function fingerprintOf(b: BookRequest): string {
  const bytes = encodeJson({ legs: b.legs, window: b.window, rate: b.rate_mbps, product: b.product_id, wait: b.wait ?? true });
  return createHash('sha256').update(bytes).digest('hex');
}

function snapshotF4(st: SnapshotAccount, positionUs: bigint): Extract<F4, { source: 'snapshot' }> {
  return {
    kind: 'F4', source: 'snapshot',
    position: { wallNanos: positionUs * 1_000n, logical: 0 },
    keys: st.keys.map((k) => ({
      kind: 'key' as const, key: k.key_id, version: BigInt(k.version), status: k.status,
      ...(k.limits.key_spend_limit_micro_usd !== null ? { keySpendLimit: k.limits.key_spend_limit_micro_usd } : {}),
      ...(k.limits.key_inflight_limit_mbps !== null ? { keyInflightLimit: k.limits.key_inflight_limit_mbps } : {}),
      keyRateLimit: BigInt(k.limits.key_rate_limit_per_s),
    })),
    kyb: { kind: 'kyb', version: BigInt(st.kyb.version), status: st.kyb.status },
  };
}

const money = (m: bigint): { currency: 'USD'; micros: string } => ({ currency: 'USD', micros: m.toString() });

/** C10 reason and amounts of a `Refuse` verdict. The booking module passes the module's amounts through. */
function refusalOf(v: Extract<Verdict, { kind: 'Refuse' }>): { reason: ReasonCode; amounts?: RequestStatus['amounts'] } {
  const r = v.reason;
  switch (r.kind) {
    case 'InsufficientFunds':
      return { reason: 'insufficient_funds', amounts: { top_up_min: money(r.min), top_up_min_plus_low_balance_warning: money(r.minPlusLbw) } };
    case 'Suspended':
      return { reason: 'account_suspended', amounts: { resume: {
        total: money(r.ra.total), written_off: money(r.ra.writtenOff),
        overdue_invoices: r.ra.overdue.map((o) => ({ invoice_id: o.invoice, amount: money(o.unpaid) })),
        headroom_part: money(r.ra.headroomPart),
        ...(r.ra.headroomAfter !== undefined ? { headroom_after: money(r.ra.headroomAfter) } : {}),
      } } };
    case 'KeyInflight': return { reason: 'key_inflight_limit' };
    case 'AccountInflight': return { reason: 'account_inflight_limit' };
    case 'KeySpendLimit': return { reason: 'key_spend_limit' };
  }
}

function outcomeReason(state: RequestState, reason: ReasonCode, amounts?: RequestStatus['amounts'], req?: Req, headroom = 0n): OutcomeReason {
  if (state === 'invalid') return { code: 'invalid', rule: reason };
  if (reason === 'insufficient_funds' && amounts?.top_up_min) {
    // C04: `needed` is the hold x, `available` the headroom h that check 4 used; x − h is the top-up minimum.
    return { code: 'insufficient_funds', needed: (BigInt(amounts.top_up_min.micros) + headroom).toString(), available: headroom.toString() };
  }
  if (reason === 'no_fit' && req) {
    const co = req.counterOffer;
    return { code: 'no_fit', blocking_link: req.legs[0]!.link, counter_offer: {
      largest_rate: co?.largest_rate_mbps ?? 0,
      earliest_window: co?.earliest_window ? { start: co.earliest_window.start.replace('.000Z', 'Z'), end: co.earliest_window.end === null ? null : co.earliest_window.end.replace('.000Z', 'Z') } : null,
      share_legs_only: false } };
  }
  if (reason === 'account_suspended') return { code: 'account_suspended', resume_amount: amounts?.resume?.total.micros ?? '0', items: [] };
  return { code: 'limit', limit: reason };
}

function unauthenticated(): C10Answer {
  return { http: 401, body: { error: 'unauthenticated' } };
}

function keyReuse(code: 'key_reuse_other_principal' | 'key_reuse_different_request'): C10Answer {
  return { http: 409, body: { error: 'not_accepted', code } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type { Outcomes };
