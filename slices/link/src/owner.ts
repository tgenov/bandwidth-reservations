/**
 * The link schedule owner on the C01 runtime (RFC-001 §7.2, §8), parts I1 … I5.
 *
 * - The C02 link hold port: `hold`, `convert`, `release`, `query`. Each command comes with its C01
 *   `CommandEnvelope`. The owner checks the routing, calls `admitCommand`, and queues the command for
 *   its link. The gRPC transport (C02 "Transport") is not in I2: a server maps each call to these methods.
 * - The C02 link availability query: `availability`, `fitRanges`. They read the committed state between
 *   batches. They are advisory and write nothing.
 * - One batch at a time for each link. A batch decides all its queued commands in `decide(ctx)` at the
 *   batch commit timestamp, and the owner answers only after `Committed` (C02 "Answered once durable").
 *   An entry that records a final state of a request also writes its `link_request` row (RFC-001 §4.4, §7.1).
 * - The C02 link waiting port (I3): each notice of an entry is a C01 notification row in the outbox, written in the
 *   batch transaction (the runtime relays it), and pushed with `onNotify` after the commit. A pending scan
 *   continues in `Tick` entries, in the same batch, before the next command (RFC-001 §4.3).
 * - Before a batch, the owner reads the `link_request` row of each command whose request record has gone
 *   from memory, so the repeat gets the recorded answer (C02 provider test 3).
 * - Yields (I5): `markWaiting` and `yieldAnswer` are commands as `hold`. A `YIELD_REQUEST` is a notice as above. The
 *   owner sends each open yield request again with the same claim, every `yieldResendMs`, from a C01 timer of the
 *   link, until an entry ends it (C02 "YIELD_REQUEST"). A rebuild arms the timer again (C02 `onAdopt`).
 * - The deployment command `deployPolicy` writes a `Policy(version, parameters)` entry (RFC-001 §7.3).
 * - Hooks: `onAcquire` and `onAdopt` rebuild the link by replay of its log. The replay compares each
 *   recorded outcome (RFC-001 §7.4). The first batch after a new epoch writes `Takeover(epoch)`.
 */
import type {
  AppendResult, AuditFields, CommandEnvelope, Epoch, EntryInput, Generation, HlcTs, InboundNotification, NotificationOut,
  OwnerHooks, OwnerRuntime, PartitionKey, ProjectionWrite, RoutingRefusal, Seq, SlotNo, WriterFence,
} from '@share/owner-runtime';
import { encodeJson, hex, hlcAddMs, hlcToWallMs, slotOfPartition, utf8 } from '@share/owner-runtime';
import type {
  AvailabilityQuery, AvailabilityReply, BodyOf, ConvertCmd, Fence, FitRangesQuery, FitRangesReply, HoldCmd, LinkCommand, LinkId,
  LinkOp, LinkStamp, MarkWaitingCmd, QueryCmd, QueryReply, ReleaseCmd, ReplyOf, RequestId, WaitingNotification, YieldAnswerCmd,
} from './c02.ts';
import { requestKey } from './c02.ts';
import { declaration, ENTRY, LINK_KIND } from './declaration.ts';
import type { LoggedEntry, LogReader } from './log-source.ts';
import {
  DEFAULT_POLICY, fenceBelow, LinkState, type Decision, type InitCmd, type LinkPolicy, type Outcome, type PolicyCmd,
  type RequestRecord, type WaitingNotice,
} from './state.ts';

/**
 * The payload of every log entry. It holds the command and its recorded outcome (RFC-001 §7.3). An entry that
 * records a final state of a request also holds the request record (`record`), which its `link_request` row
 * names (§4.4). An entry that changes waiters also holds its notices (`notices`) and the final records of the
 * waiters that its scan refused (`records`). A replay compares the notices too (§7.4).
 */
export type LoggedPayload =
  | { v: 1; op: 'init'; init: InitCmd; outcome: Outcome }
  | { v: 1; op: 'takeover'; epoch: Epoch; generation: Generation; outcome: Outcome }
  | { v: 1; op: 'policy'; policy: LinkPolicy; outcome: Outcome }
  | { v: 1; op: 'tick'; outcome: Outcome; notices?: WaitingNotice[]; records?: RequestRecord[] }
  | {
    v: 1; op: LinkOp; body: LinkCommand['body']; outcome: Outcome; sender: SenderRef; record?: RequestRecord;
    notices?: WaitingNotice[]; records?: RequestRecord[];
  };

/** The owner kind of the account owner, which receives the waiting-port notifications (C02). */
export const ACCOUNT_KIND = 'account';

/** The table of the `request` projection (RFC-001 §7.1 `link_request`). */
export const LINK_REQUEST_TABLE = 'link_request';

/**
 * A record that can leave memory within this time from now is read from `link_request` before the batch.
 * A batch commits well within it, so the record that the batch needs is in memory or read (RFC-001 §4.4).
 */
const RECALL_MARGIN_MS = 60_000;

/** The C01 timer key of the re-send of the open yield requests of a link. */
export const YIELD_RESEND_TIMER = 'yield-resend';

export interface SenderRef { kind: string; partition: PartitionKey; generation: Generation; epoch: Epoch }

export interface LinkAlert { kind: string; link: LinkId; request?: string; detail?: string }

export interface LinkOwnerOptions {
  /** Reads the log of a link for a rebuild. See `log-source.ts`. */
  readLog: LogReader;
  /** Links to rebuild at once in `onAcquire`. Other links are rebuilt at their first command. */
  links?: LinkId[];
  /** The most commands in one batch of one link (RFC-001 §7.2 `link_batch_max`). */
  maxBatch?: number;
  /** How many times a batch is proposed again after `Retry`, `Ambiguous` or an unknown result. */
  retries?: number;
  /** Called after `leaseValid` and just before each reply (CC-7 instrumentation). */
  onReply?: (label: string) => void;
  /** Called for each alert. I7 sends alerts on `link.alert.v1`. */
  onAlert?: (a: LinkAlert) => void;
  /** Called for each answered decision, in the order of decision (test instrumentation, T-01, T-03). */
  onDecided?: (d: DecidedRecord) => void;
  /**
   * The push of a waiting-port notification after its batch commits (RFC-001 §7.2 step 4: gRPC to the account
   * owner). The transport is not in I3. The relay of the outbox row is the guaranteed path (C02 "Delivery").
   */
  onNotify?: (n: NotificationOut) => void;
  /**
   * The interval of the re-send of an unanswered yield request, with the same claim (C02 "YIELD_REQUEST"; est. 1 s,
   * as the other C02 re-sends). The runtime calls `onTimer` when it is due.
   */
  yieldResendMs?: number;
}

/** One decision as the owner made it: the command, its outcome, the batch ts and the entry sequence. */
export interface DecidedRecord { link: LinkId; command: LinkCommand | InitCmd | PolicyCmd; outcome: Outcome; ts: HlcTs; seq?: Seq }

type Pending =
  | { t: 'cmd'; cmd: LinkCommand; sender: SenderRef; resolve: (r: unknown) => void; recalled?: RequestRecord }
  | { t: 'init'; init: InitCmd; resolve: (r: unknown) => void }
  | { t: 'policy'; policy: PolicyCmd; resolve: (r: unknown) => void };

interface LinkMemory {
  link: LinkId;
  partition: PartitionKey;
  slot: SlotNo;
  state: LinkState;
  /** The state must be rebuilt from the log before the next decision. */
  rebuild: 'none' | 'catchUp' | 'full';
  /** The epoch of the last entry in the log, as the state knows it. */
  lastEntryEpoch: Epoch | undefined;
  /** A replay found an outcome difference. The link decides nothing (RFC-001 §7.4). */
  stopped: boolean;
  queue: Pending[];
  chain: Promise<void>;
}

const AUDIT: AuditFields = {
  schema: 'audit.v1',
  principal: { principal_id: 'link_owner', kind: 'service', tenant: 'share' },
  decided_at: 'commit',
  policy_version: 1,
};

export class LinkOwner implements OwnerHooks {
  readonly alerts: LinkAlert[] = [];
  /** The number of request records read from `link_request` (a repeat after the record left memory). */
  recalledRecords = 0;
  private readonly rt: OwnerRuntime;
  private readonly o: Required<Pick<LinkOwnerOptions, 'maxBatch' | 'retries' | 'yieldResendMs'>> & LinkOwnerOptions;
  private readonly links = new Map<string, LinkMemory>();

  constructor(rt: OwnerRuntime, opts: LinkOwnerOptions) {
    this.rt = rt;
    this.o = { maxBatch: 1_000, retries: 3, yieldResendMs: 1_000, ...opts };
  }

  // ---------------- C02 link hold port ----------------

  hold(env: CommandEnvelope, body: HoldCmd): Promise<ReplyOf['hold']> {
    return this.command('hold', env, body);
  }

  convert(env: CommandEnvelope, body: ConvertCmd): Promise<ReplyOf['convert']> {
    return this.command('convert', env, body);
  }

  release(env: CommandEnvelope, body: ReleaseCmd): Promise<ReplyOf['release']> {
    return this.command('release', env, body);
  }

  /** C02 `mark_waiting` (link waiting port). */
  markWaiting(env: CommandEnvelope, body: MarkWaitingCmd): Promise<ReplyOf['mark_waiting']> {
    return this.command('mark_waiting', env, body);
  }

  /** C02 `yield_accept` and `yield_refuse` (outcome and expiry port). */
  yieldAnswer(env: CommandEnvelope, body: YieldAnswerCmd): Promise<ReplyOf['yield']> {
    return this.command('yield', env, body);
  }

  /**
   * C02 `query`: the state of the request at the link. A read; it writes no entry. The record comes from
   * memory, or from `link_request` when it has gone from memory.
   */
  query(env: CommandEnvelope, body: QueryCmd): Promise<QueryReply> {
    return this.read(env, body, async (mem, ts) => {
      const recalled = mem.state.queryNeedsRecall(body.request) ? await this.recall(mem, body.request) : undefined;
      return mem.state.query(body.request, ts, recalled);
    });
  }

  /**
   * C02 `availability(window, rate)`: the largest rate and the earliest window beside committed and held
   * capacity, as of `asOfSeq`. The horizon starts at the owner's present minute. Advisory; it writes nothing.
   */
  availability(env: CommandEnvelope, body: AvailabilityQuery): Promise<AvailabilityReply> {
    if (!validRate(body.rateMbps) || !validWindow(body.window)) return Promise.resolve(this.invalidQuery(body.link));
    return this.read(env, body, async (mem, ts) => ({
      asOfSeq: mem.state.appliedSeq,
      offer: mem.state.availability(body.window, body.rateMbps, Math.floor(hlcToWallMs(ts) / 60_000)),
    }));
  }

  /** C02 `fit_ranges(rate, from, until, k)`, as of `asOfSeq`. Advisory; it writes nothing. */
  fitRanges(env: CommandEnvelope, body: FitRangesQuery): Promise<FitRangesReply> {
    if (!validRate(body.rateMbps) || !Number.isSafeInteger(body.from) || !Number.isSafeInteger(body.until)
      || !Number.isSafeInteger(body.k) || body.k < 1) return Promise.resolve(this.invalidQuery(body.link));
    return this.read(env, body, async (mem) => ({
      asOfSeq: mem.state.appliedSeq, ...mem.state.fitRanges(body.rateMbps, body.from, body.until, body.k),
    }));
  }

  /**
   * C02 gives the availability query no error for a malformed question. The owner answers `UNAVAILABLE` and
   * alerts `INVALID_QUERY` (S-LINK I2 design issue DI-3).
   */
  private invalidQuery(link: LinkId): { code: 'UNAVAILABLE' } {
    this.alert({ kind: 'INVALID_QUERY', link });
    return { code: 'UNAVAILABLE' };
  }

  /**
   * Serve a read on the committed state of the link, between batches (RFC-001 §4.2, §7.3). It is routed and
   * fenced as a command (C02 "Common rules"), and answered after `leaseValid` (C01 CC-7).
   */
  private async read<T extends object>(env: CommandEnvelope, body: { link: LinkId; receiverPartition: string; request?: RequestId },
    fn: (mem: LinkMemory, ts: HlcTs) => Promise<T>): Promise<(LinkStamp & T) | RoutingRefusal | { code: 'UNKNOWN_LINK' }> {
    const refusal = this.route(env, body);
    if (refusal) return refusal as RoutingRefusal | { code: 'UNKNOWN_LINK' };
    const mem = this.memory(body.link);
    let reply: (LinkStamp & T) | RoutingRefusal | { code: 'UNKNOWN_LINK' } = { code: 'UNAVAILABLE' };
    await this.serialise(mem, async () => {
      if (mem.rebuild !== 'none') await this.rebuild(mem);
      if (mem.stopped) { reply = { code: 'STOPPED' }; return; }
      if (mem.state.link === undefined) { reply = { code: 'UNKNOWN_LINK' }; return; }
      const value = await fn(mem, this.rt.now().ts);
      if (!this.rt.leaseValid(mem.slot).valid) { reply = { code: 'NOT_OWNER' }; return; }
      this.o.onReply?.(`read:${body.request ? requestKey(body.request) : mem.link}`);
      const linkFence = { generation: this.rt.generation(mem.partition), epoch: this.rt.epoch(mem.slot) };
      reply = { linkFence, linkSeq: mem.state.appliedSeq, ...value };
    }).catch((e: unknown) => {
      this.alert({ kind: 'READ_FAILED', link: mem.link, detail: String(e) });
      reply = { code: 'UNAVAILABLE' };
    });
    return reply;
  }

  /** The record of a request from its `link_request` row and the log row that the row names (RFC-001 §4.4). */
  private async recall(mem: LinkMemory, request: RequestId): Promise<RequestRecord | undefined> {
    const rows = await this.rt.consistentRead((tx) => tx.query<{ seq: unknown }>(
      `SELECT seq FROM ${LINK_REQUEST_TABLE} WHERE link_id = $1 AND request_part = $2 AND request_seq = $3`,
      [mem.link, request.partition, request.seq]), 'present');
    const row = rows[0];
    if (!row) return undefined;
    const seq = BigInt(String(row.seq));
    const entry = (await this.o.readLog(mem.partition, seq - 1n)).find((e) => e.seq === seq);
    const payload = entry?.payload as { record?: RequestRecord; records?: RequestRecord[] } | undefined;
    const key = requestKey(request);
    // The entry's own record, or the record of a waiter that its scan refused (I3).
    const record = [payload?.record, ...(payload?.records ?? [])].find((r) => r !== undefined && requestKey(r.request) === key);
    if (!record) {
      this.alert({ kind: 'REQUEST_ROW_WITHOUT_RECORD', link: mem.link, request: requestKey(request), detail: `seq ${seq}` });
      return undefined;
    }
    this.recalledRecords += 1;
    return record;
  }

  /**
   * Register a link with its capacity and policy (the `Init` entry, by fixture command in I1).
   * The registry (I9) replaces this.
   */
  async register(link: LinkId, capacityMbps: number, policy: LinkPolicy = DEFAULT_POLICY): Promise<Outcome | RoutingRefusal> {
    const mem = this.memory(link);
    return new Promise((resolve) => {
      mem.queue.push({ t: 'init', init: { link, capacityMbps, policy }, resolve: resolve as (r: unknown) => void });
      this.pump(mem);
    });
  }

  /**
   * The configuration deployment of a policy version (RFC-001 §2, §7.3): the `Policy(version, parameters)`
   * entry. The answer comes after the batch commits. C02 does not freeze this command: it has no envelope.
   */
  async deployPolicy(link: LinkId, policy: LinkPolicy): Promise<Outcome | RoutingRefusal> {
    const mem = this.memory(link);
    return new Promise((resolve) => {
      mem.queue.push({ t: 'policy', policy: { link, policy: structuredClone(policy) }, resolve: resolve as (r: unknown) => void });
      this.pump(mem);
    });
  }

  /** The state of a link in memory (for queries of later increments and for tests). */
  stateOf(link: LinkId): LinkState | undefined {
    return this.links.get(link)?.state;
  }

  /** Wait until every queued command of every link is answered. */
  async idle(): Promise<void> {
    for (;;) {
      const chains = [...this.links.values()].map((m) => m.chain);
      await Promise.all(chains);
      if ([...this.links.values()].every((m) => m.queue.length === 0)) return;
    }
  }

  private async command<O extends LinkOp>(op: O, env: CommandEnvelope, body: BodyOf<O>): Promise<ReplyOf[O]> {
    const refusal = this.route(env, body);
    if (refusal) return refusal as ReplyOf[O];
    const mem = this.memory(body.link);
    const sender: SenderRef = {
      kind: env.sender.kind, partition: env.sender.partition, generation: env.sender.generation, epoch: env.sender.epoch,
    };
    return new Promise((resolve) => {
      // The body is copied: the log entry keeps it, and the caller can change its own object.
      const cmd = { op, body: structuredClone(body) } as LinkCommand;
      mem.queue.push({ t: 'cmd', cmd, sender, resolve: resolve as (r: unknown) => void });
      this.pump(mem);
    });
  }

  /** C02 "Common rules": routing and fencing (C01 §3.8). Returns a refusal or undefined. */
  private route(env: CommandEnvelope, body: { link: LinkId; receiverPartition: string }): ReplyOf['hold'] | undefined {
    if (body.receiverPartition !== body.link) return { code: 'UNKNOWN_LINK' };
    const partition = utf8(body.link);
    const slot = slotOfPartition(partition, declaration.slotCount);
    if (env.routedTo.kind !== LINK_KIND || env.routedTo.slot !== slot) return { code: 'NOT_OWNER' };
    if (!this.rt.leaseValid(slot).valid) return { code: 'NOT_OWNER' };
    const current = this.rt.epoch(slot);
    if (env.routedTo.epoch !== current) return { code: 'STALE_EPOCH', current };
    const generation = this.rt.generation(partition);
    if (env.routedTo.generation !== generation) return { code: 'MOVED', slot, generation };
    const fence: WriterFence = { generation: env.sender.generation, epoch: env.sender.epoch };
    const sender = { kind: env.sender.kind, partition: env.sender.partition };
    const admit = this.rt.admitCommand(sender, fence);
    if (!admit.admit) return { code: 'STALE_SENDER', recorded: admit.recorded };
    // The link also keeps the sender fences that it applied (RFC-001 §3.3), so the check holds after
    // a rebuild even when the runtime does not rebuild its high-water (C01 R47-24).
    const recorded = this.links.get(body.link)?.state.fenceOf(senderKey(sender.kind, sender.partition));
    if (recorded && fenceBelow(fence, recorded)) return { code: 'STALE_SENDER', recorded };
    return undefined;
  }

  // ---------------- C01 hooks ----------------

  async onAcquire(slot: SlotNo, _epoch: Epoch): Promise<void> {
    for (const link of this.o.links ?? []) this.memory(link);
    const work: Promise<void>[] = [];
    for (const mem of this.links.values()) {
      if (mem.slot !== slot) continue;
      mem.rebuild = 'full';
      work.push(this.serialise(mem, () => this.rebuild(mem)));
    }
    await Promise.all(work);
  }

  onRelease(slot: SlotNo): void {
    for (const mem of this.links.values()) if (mem.slot === slot) mem.rebuild = 'full';
  }

  onReportable(_slot: SlotNo): void {}

  onMovedOut(partition: PartitionKey): void {
    const mem = this.links.get(Buffer.from(partition).toString('utf8'));
    if (mem) mem.rebuild = 'full';
    this.rt.cancelTimer(partition, YIELD_RESEND_TIMER);
  }

  /**
   * A C01 timer of a link partition is due (the runtime's `onTimer`). For `YIELD_RESEND_TIMER`: send each open yield
   * request of the link again, with the same claim and content, after `leaseValid` (C01 CC-7), and arm the timer again.
   * After an append that did not commit, the state must catch up first: the timer does that, so the re-sends go on
   * when no later command comes (C02 "YIELD_REQUEST": an unanswered request is sent again; S-LINK I5 DI-25). If the
   * catch-up fails, the timer is armed again and the link alerts `TIMER_FAILED`.
   */
  async onTimer(partition: PartitionKey, key: string): Promise<void> {
    const mem = this.links.get(Buffer.from(partition).toString('utf8'));
    if (key !== YIELD_RESEND_TIMER || !mem) return;
    await this.serialise(mem, async () => {
      if (!this.rt.leaseValid(mem.slot).valid) return;
      if (mem.rebuild !== 'none') await this.rebuild(mem);
      if (mem.stopped || !this.rt.leaseValid(mem.slot).valid) return;
      const fence = { generation: this.rt.generation(mem.partition), epoch: this.rt.epoch(mem.slot) };
      for (const y of mem.state.openYieldRequests()) {
        this.o.onNotify?.(this.notification(mem.link, {
          request: y.request, account: y.account, attempt: y.attempt, kind: 'YIELD_REQUEST', claim: y.claim, olderRequest: y.olderRequest,
        }, y.claim, fence));
      }
      this.armYieldResend(mem);
    }).catch((e: unknown) => {
      this.alert({ kind: 'TIMER_FAILED', link: mem.link, detail: String(e) });
      this.rt.timer(mem.partition, YIELD_RESEND_TIMER, hlcAddMs(this.rt.now().ts, this.o.yieldResendMs));
    });
  }

  /** Arm the re-send timer of a link if it has an open yield request; else cancel it. */
  private armYieldResend(mem: LinkMemory): void {
    if (mem.state.openYieldRequests().length > 0) {
      this.rt.timer(mem.partition, YIELD_RESEND_TIMER, hlcAddMs(this.rt.now().ts, this.o.yieldResendMs));
    } else {
      this.rt.cancelTimer(mem.partition, YIELD_RESEND_TIMER);
    }
  }

  async onAdopt(partition: PartitionKey, _g: Generation): Promise<void> {
    const mem = this.memory(Buffer.from(partition).toString('utf8'));
    mem.rebuild = 'full';
    await this.serialise(mem, () => this.rebuild(mem));
  }

  async onNotification(_n: InboundNotification): Promise<void> {
    // I1 consumes no notification. The outcome and expiry port (I8) arrives here.
  }

  // ---------------- per-link queue and batches ----------------

  private memory(link: LinkId): LinkMemory {
    let mem = this.links.get(link);
    if (!mem) {
      const partition = utf8(link);
      mem = {
        link, partition, slot: slotOfPartition(partition, declaration.slotCount), state: new LinkState(),
        rebuild: 'full', lastEntryEpoch: undefined, stopped: false, queue: [], chain: Promise.resolve(),
      };
      this.links.set(link, mem);
    }
    return mem;
  }

  private serialise(mem: LinkMemory, fn: () => Promise<void>): Promise<void> {
    const next = mem.chain.then(fn, fn);
    mem.chain = next.catch(() => {});
    return next;
  }

  private pump(mem: LinkMemory): void {
    void this.serialise(mem, () => this.drain(mem));   // fire and forget: drain() alerts BATCH_FAILED and answers each call
  }

  private async drain(mem: LinkMemory): Promise<void> {
    while (mem.queue.length > 0) {
      const batch = mem.queue.splice(0, this.o.maxBatch);
      try {
        if (mem.rebuild !== 'none') await this.rebuild(mem);
        await this.recallFor(mem, batch);
        await this.runBatch(mem, batch);
      } catch (e) {
        mem.state.rollback();
        mem.rebuild = mem.rebuild === 'full' ? 'full' : 'catchUp';
        this.alert({ kind: 'BATCH_FAILED', link: mem.link, detail: String(e) });
        for (const p of batch) p.resolve({ code: 'UNAVAILABLE' });
      }
    }
  }

  /** Read the `link_request` record of each command that can need it (`LinkState.needsRecall`). */
  private async recallFor(mem: LinkMemory, batch: Pending[]): Promise<void> {
    const nowMs = hlcToWallMs(this.rt.now().ts);
    for (const p of batch) {
      if (p.t !== 'cmd' || p.recalled || !mem.state.needsRecall(p.cmd, nowMs, RECALL_MARGIN_MS)) continue;
      const rec = await this.recall(mem, p.cmd.body.request);
      if (rec) p.recalled = rec;
    }
  }

  private async runBatch(mem: LinkMemory, batch: Pending[]): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      if (mem.rebuild !== 'none') await this.rebuild(mem);
      if (mem.stopped) { for (const p of batch) p.resolve({ code: 'STOPPED' }); return; }

      const epoch = this.rt.epoch(mem.slot);
      const takeover = mem.lastEntryEpoch !== undefined && mem.lastEntryEpoch < epoch;
      let decisions: Decision[] = [];
      let seqs: Array<Seq | undefined> = [];
      let entries: EntryInput[] = [];
      let projections: ProjectionWrite[] = [];
      let notifications: NotificationOut[] = [];
      let decidedAt: HlcTs | undefined;
      const result: AppendResult = await this.rt.append({
        partition: mem.partition,
        decide: (ctx) => {
          // A restart re-runs decide at a new ts: start again from the committed state.
          mem.state.rollback();
          mem.state.beginBatch(ctx.ts);
          decisions = []; seqs = []; entries = []; projections = []; notifications = []; decidedAt = ctx.ts;
          let seq = ctx.head(mem.partition).seq;
          const generation = ctx.head(mem.partition).generation;
          const fence: Fence = { generation, epoch };
          /** The notices, the other final records and the request rows of one entry. */
          const effects = (d: Decision, at: Seq): void => {
            for (const n of d.notices ?? []) notifications.push(this.notification(mem.link, n, at, fence));
            for (const r of d.finals ?? []) projections.push(requestRow(mem.link, r, at));
          };
          if (takeover) {
            seq += 1n;
            entries.push(this.entry(ENTRY.Takeover, `takeover:${generation}:${epoch}`,
              { v: 1, op: 'takeover', epoch, generation, outcome: { result: 'TAKEOVER' } }));
            mem.state.advance(seq, ctx.ts);
          }
          for (const p of batch) {
            const d = p.t === 'init' ? mem.state.init(p.init)
              : p.t === 'policy' ? mem.state.applyPolicy(p.policy)
                : mem.state.decide(p.cmd, ctx.ts, seq + 1n, p.recalled);
            decisions.push(d);
            if (!d.entry) { seqs.push(undefined); continue; }
            seq += 1n;
            seqs.push(seq);
            mem.state.advance(seq, ctx.ts);
            if (p.t === 'init') {
              entries.push(this.entry(ENTRY.Init, `init:${p.init.link}`, { v: 1, op: 'init', init: p.init, outcome: d.outcome }));
            } else if (p.t === 'policy') {
              entries.push(this.entry(ENTRY.Policy, `policy:${p.policy.policy.version}`,
                { v: 1, op: 'policy', policy: p.policy.policy, outcome: d.outcome }));
            } else {
              mem.state.recordFence(senderKey(p.sender.kind, p.sender.partition), p.sender);
              entries.push(this.commandEntry(p.cmd, p.sender, d));
              if (d.final) projections.push(requestRow(mem.link, d.final, seq));
              effects(d, seq);
            }
            // A scan that the step budget stopped continues in Tick entries before the next command (RFC-001 §4.3).
            while (mem.state.scanPending) {
              const t = mem.state.tick(ctx.ts, seq + 1n);
              seq += 1n;
              mem.state.advance(seq, ctx.ts);
              entries.push(this.entry(ENTRY.Tick, `tick:${mem.link}:${seq}`, {
                v: 1, op: 'tick', outcome: t.outcome, ...(t.notices ? { notices: t.notices } : {}), ...(t.finals ? { records: t.finals } : {}),
              }));
              effects(t, seq);
            }
          }
          // No entry: every command is answered from the committed state, and nothing is written.
          return entries.length === 0 ? null : { entries, projections, notifications };
        },
      });

      switch (result.r) {
        case 'Committed':
          mem.state.commit();
          if (entries.length > 0) mem.lastEntryEpoch = epoch;
          this.answer(mem, batch, decisions, seqs, decidedAt as HlcTs);
          this.push(mem, notifications);
          this.armYieldResend(mem);
          return;
        case 'ConditionFailed':
          if (result.which === 'decide' && entries.length === 0) {
            mem.state.rollback();
            this.answer(mem, batch, decisions, seqs, decidedAt as HlcTs);
            return;
          }
          mem.state.rollback();
          mem.rebuild = 'catchUp';
          if (attempt < this.o.retries) continue;
          return this.refuseAll(batch, { code: 'UNAVAILABLE' });
        case 'Retry':
        case 'Ambiguous':
          // Not known to be committed: catch up from the log, then propose the same commands again.
          // The identities make this safe: a command that did commit gets its recorded state.
          mem.state.rollback();
          mem.rebuild = 'catchUp';
          if (attempt < this.o.retries) continue;
          return this.refuseAll(batch, { code: 'UNAVAILABLE' });
        case 'Moving':
          mem.state.rollback(); mem.rebuild = 'catchUp';
          return this.refuseAll(batch, { code: 'MOVING', retryAfterMs: 100 });
        case 'Moved':
          mem.state.rollback(); mem.rebuild = 'full';
          return this.refuseAll(batch, { code: 'MOVED', slot: result.slot, generation: result.generation });
        case 'StaleEpoch':
          mem.state.rollback(); mem.rebuild = 'full';
          return this.refuseAll(batch, { code: 'STALE_EPOCH', current: this.rt.epoch(mem.slot) });
        case 'Stopped':
          mem.state.rollback(); mem.rebuild = 'catchUp';
          return this.refuseAll(batch, { code: 'STOPPED' });
        case 'Overloaded':
          mem.state.rollback(); mem.rebuild = 'catchUp';
          return this.refuseAll(batch, { code: 'OVERLOADED', retryAfterMs: result.retryAfterMs });
        default: {
          // C01 §8: an unknown result is Retry, with an alert.
          mem.state.rollback();
          mem.rebuild = 'catchUp';
          this.alert({ kind: 'UNKNOWN_APPEND_RESULT', link: mem.link, detail: String((result as { r: unknown }).r) });
          if (attempt < this.o.retries) continue;
          return this.refuseAll(batch, { code: 'UNAVAILABLE' });
        }
      }
    }
  }

  /** Answer each command of a committed batch. CC-7: `leaseValid` comes immediately before each reply. */
  private answer(mem: LinkMemory, batch: Pending[], decisions: Decision[], seqs: Array<Seq | undefined>, ts: HlcTs): void {
    const linkFence = { generation: this.rt.generation(mem.partition), epoch: this.rt.epoch(mem.slot) };
    batch.forEach((p, i) => {
      const d = decisions[i] as Decision;
      const seq = seqs[i];
      const command = p.t === 'cmd' ? p.cmd : p.t === 'init' ? p.init : p.policy;
      this.o.onDecided?.({ link: mem.link, command, outcome: d.outcome, ts, ...(seq === undefined ? {} : { seq }) });
      if (d.alert) {
        const request = p.t === 'cmd' ? requestKey(p.cmd.body.request) : undefined;
        this.alert({ kind: d.alert, link: mem.link, ...(request ? { request } : {}) });
      }
      if (!this.rt.leaseValid(mem.slot).valid) { p.resolve({ code: 'NOT_OWNER' }); return; }
      this.o.onReply?.(p.t === 'cmd' ? `${p.cmd.op}:${requestKey(p.cmd.body.request)}` : `${p.t}:${mem.link}`);
      const out = d.outcome;
      if ('result' in out) {
        const stamp: LinkStamp = { linkFence, linkSeq: seqs[i] ?? d.recordedSeq ?? mem.state.appliedSeq };
        p.resolve({ ...stamp, ...out });
      } else {
        p.resolve(out);
      }
    });
  }

  /** Push the notifications of a committed batch (RFC-001 §7.2 step 4). `leaseValid` comes first (C01 CC-7). */
  private push(mem: LinkMemory, notifications: NotificationOut[]): void {
    if (notifications.length === 0 || !this.o.onNotify || !this.rt.leaseValid(mem.slot).valid) return;
    for (const n of notifications) this.o.onNotify(n);
  }

  /**
   * A waiting-port notice as a C01 notification row (RFC-001 §7.1 `link_outbox`; C02 `WaitingNotification`). The
   * C02 identity (link, request, attempt, kind) is in the body. The C01 id is the same for the push and the relay.
   * A `WAITING_NOTICE` is sent again with new content under the same C02 identity, so its C01 subject also has the
   * log sequence: else the outbox keeps only the first copy (S-LINK I3 design issue DI-10). The C02 identity of a
   * `YIELD_REQUEST` also has the claim, so its C01 subject has the claim too.
   */
  private notification(link: LinkId, n: WaitingNotice, seq: Seq, fence: Fence): NotificationOut {
    const { account, ...content } = n;
    const extra = n.kind === 'WAITING_NOTICE' ? `|${seq}` : n.kind === 'YIELD_REQUEST' ? `|claim:${n.claim}` : '';
    const subject = `${link}|${requestKey(n.request)}${extra}`;
    const body: WaitingNotification = { linkFence: fence, linkSeq: seq, link, ...content };
    return { to: { kind: ACCOUNT_KIND, partition: account }, id: { subject: utf8(subject), attempt: n.attempt, kind: n.kind }, body };
  }

  private refuseAll(batch: Pending[], refusal: RoutingRefusal): void {
    for (const p of batch) p.resolve(refusal);
  }

  // ---------------- rebuild by replay (RFC-001 §7.4, §8) ----------------

  private async rebuild(mem: LinkMemory): Promise<void> {
    if (mem.rebuild === 'full') {
      mem.state = new LinkState();
      mem.lastEntryEpoch = undefined;
      mem.stopped = false;
    }
    const entries = await this.o.readLog(mem.partition, mem.state.appliedSeq);
    let batchTs = mem.state.appliedTs;
    for (const e of entries) {
      // All entries of one batch have its ts. A new ts starts a new batch, as when the entry was decided.
      if (e.ts !== batchTs) { mem.state.beginBatch(e.ts); batchTs = e.ts; }
      if (!this.replay(mem, e)) {
        mem.stopped = true;
        break;
      }
    }
    mem.state.commit();
    mem.rebuild = 'none';
    // C02 `onAdopt`: the new holder re-arms the open yield requests, with their claims.
    if (!mem.stopped) this.armYieldResend(mem);
  }

  /** Apply one logged entry again and compare the outcome with the recorded one. */
  private replay(mem: LinkMemory, e: LoggedEntry): boolean {
    const p = e.payload as LoggedPayload;
    let d: Decision;
    if (p.op === 'init') d = mem.state.init(p.init);
    else if (p.op === 'policy') d = mem.state.applyPolicy({ link: mem.link, policy: p.policy });
    else if (p.op === 'takeover') d = { outcome: { result: 'TAKEOVER' }, entry: true };
    else if (p.op === 'tick') d = mem.state.tick(e.ts, e.seq);
    else {
      d = mem.state.decide({ op: p.op, body: p.body } as LinkCommand, e.ts, e.seq);
      mem.state.recordFence(senderKey(p.sender.kind, p.sender.partition), p.sender);
      if (p.record) mem.state.restoreRecord(p.record);
    }
    mem.state.advance(e.seq, e.ts);
    mem.lastEntryEpoch = e.epoch;
    const notices = 'notices' in p ? p.notices ?? [] : [];
    if (!d.entry || hex(encodeJson(d.outcome)) !== hex(encodeJson(p.outcome))
      || hex(encodeJson(d.notices ?? [])) !== hex(encodeJson(notices))) {
      this.alert({ kind: 'OUTCOME_MISMATCH_ON_REPLAY', link: mem.link, detail: `seq ${e.seq}` });
      return false;
    }
    return true;
  }

  // ---------------- entries ----------------

  private entry(kind: number, identity: string, payload: LoggedPayload): EntryInput {
    return { kind, schemaV: 1, identity: utf8(identity), audit: AUDIT, payload };
  }

  private commandEntry(cmd: LinkCommand, sender: SenderRef, d: Decision): EntryInput {
    const key = requestKey(cmd.body.request);
    const kind = ENTRY_OF[cmd.op](cmd);
    // A release can write a second entry only to extend its tombstone, so its identity has D. A request has one
    // mark entry for each position, and one answer entry for each (attempt, claim, kind).
    const identity = cmd.op === 'release' ? `release:${key}:${cmd.body.deadline}`
      : cmd.op === 'mark_waiting' ? `mark:${key}:${cmd.body.position}`
        : cmd.op === 'yield' ? `${cmd.body.answer}:${key}:${cmd.body.attempt}:${cmd.body.claim}` : `${cmd.op}:${key}`;
    const e = this.entry(kind, identity, {
      v: 1, op: cmd.op, body: cmd.body, outcome: d.outcome, sender, ...(d.final ? { record: d.final } : {}),
      ...(d.notices ? { notices: d.notices } : {}), ...(d.finals ? { records: d.finals } : {}),
    });
    e.senderFence = sender;
    e.audit = { ...AUDIT, on_behalf_of: { account: hex(sender.partition), request_ref: key } };
    return e;
  }

  private alert(a: LinkAlert): void {
    this.alerts.push(a);
    this.o.onAlert?.(a);
  }
}

/** The entry kind of each command (RFC-001 §7.3). */
const ENTRY_OF: { [O in LinkOp]: (cmd: Extract<LinkCommand, { op: O }>) => number } & Record<LinkOp, (cmd: LinkCommand) => number> = {
  hold: () => ENTRY.Hold,
  convert: () => ENTRY.Convert,
  release: () => ENTRY.Release,
  mark_waiting: () => ENTRY.MarkWaiting,
  yield: (cmd) => (cmd.op === 'yield' && cmd.body.answer === 'yield_accept' ? ENTRY.YieldAccept : ENTRY.YieldRefuse),
};

/**
 * The `link_request` row of a final request record (RFC-001 §7.1): keyed by (link, request), it names the
 * entry that recorded the final state. The row-level TTL removes it 24 h after D (`deadline_at`).
 */
function requestRow(link: LinkId, r: RequestRecord, seq: Seq): ProjectionWrite {
  return {
    table: LINK_REQUEST_TABLE, op: 'upsert',
    key: { link_id: link, request_part: r.request.partition, request_seq: r.request.seq },
    row: { seq, deadline_at: new Date(r.deadline).toISOString() },
  };
}

function validRate(b: number): boolean {
  return Number.isSafeInteger(b) && b >= 0;
}

function validWindow(w: { start: number; end: number | null }): boolean {
  return Number.isSafeInteger(w.start) && (w.end === null || (Number.isSafeInteger(w.end) && w.end > w.start));
}

export function senderKey(kind: string, partition: PartitionKey): string {
  return `${kind}|${hex(partition)}`;
}
