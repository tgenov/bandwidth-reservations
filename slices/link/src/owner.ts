/**
 * The link schedule owner on the C01 runtime (RFC-001 §7.2, §8), part I1.
 *
 * - The C02 link hold port: `hold`, `convert`, `release`. Each command comes with its C01
 *   `CommandEnvelope`. The owner checks the routing, calls `admitCommand`, and queues the command for
 *   its link. The gRPC transport (C02 "Transport") is not in I1: a server maps each call to these methods.
 * - One batch at a time for each link. A batch decides all its queued commands in `decide(ctx)` at the
 *   batch commit timestamp, and the owner answers only after `Committed` (C02 "Answered once durable").
 * - Hooks: `onAcquire` and `onAdopt` rebuild the link by replay of its log. The replay compares each
 *   recorded outcome (RFC-001 §7.4). The first batch after a new epoch writes `Takeover(epoch)`.
 */
import type {
  AppendResult, AuditFields, CommandEnvelope, Epoch, EntryInput, Generation, HlcTs, InboundNotification, OwnerHooks,
  OwnerRuntime, PartitionKey, RoutingRefusal, Seq, SlotNo, WriterFence,
} from '@share/owner-runtime';
import { encodeJson, hex, slotOfPartition, utf8 } from '@share/owner-runtime';
import type {
  BodyOf, ConvertCmd, HoldCmd, LinkCommand, LinkId, LinkOp, LinkStamp, ReleaseCmd, ReplyOf,
} from './c02.ts';
import { requestKey } from './c02.ts';
import { declaration, ENTRY, LINK_KIND } from './declaration.ts';
import type { LoggedEntry, LogReader } from './log-source.ts';
import { DEFAULT_POLICY, fenceBelow, LinkState, type Decision, type InitCmd, type LinkPolicy, type Outcome } from './state.ts';

/** The payload of every log entry of I1. It holds the command and its recorded outcome (RFC-001 §7.3). */
export type LoggedPayload =
  | { v: 1; op: 'init'; init: InitCmd; outcome: Outcome }
  | { v: 1; op: 'takeover'; epoch: Epoch; generation: Generation; outcome: Outcome }
  | { v: 1; op: LinkOp; body: LinkCommand['body']; outcome: Outcome; sender: SenderRef };

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
}

/** One decision as the owner made it: the command, its outcome, the batch ts and the entry sequence. */
export interface DecidedRecord { link: LinkId; command: LinkCommand | InitCmd; outcome: Outcome; ts: HlcTs; seq?: Seq }

type Pending =
  | { t: 'cmd'; cmd: LinkCommand; sender: SenderRef; resolve: (r: unknown) => void }
  | { t: 'init'; init: InitCmd; resolve: (r: unknown) => void };

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
  private readonly rt: OwnerRuntime;
  private readonly o: Required<Pick<LinkOwnerOptions, 'maxBatch' | 'retries'>> & LinkOwnerOptions;
  private readonly links = new Map<string, LinkMemory>();

  constructor(rt: OwnerRuntime, opts: LinkOwnerOptions) {
    this.rt = rt;
    this.o = { maxBatch: 1_000, retries: 3, ...opts };
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
        await this.runBatch(mem, batch);
      } catch (e) {
        mem.state.rollback();
        mem.rebuild = mem.rebuild === 'full' ? 'full' : 'catchUp';
        this.alert({ kind: 'BATCH_FAILED', link: mem.link, detail: String(e) });
        for (const p of batch) p.resolve({ code: 'UNAVAILABLE' });
      }
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
      let decidedAt: HlcTs | undefined;
      const result: AppendResult = await this.rt.append({
        partition: mem.partition,
        decide: (ctx) => {
          // A restart re-runs decide at a new ts: start again from the committed state.
          mem.state.rollback();
          decisions = []; seqs = []; entries = []; decidedAt = ctx.ts;
          let seq = ctx.head(mem.partition).seq;
          const generation = ctx.head(mem.partition).generation;
          if (takeover) {
            seq += 1n;
            entries.push(this.entry(ENTRY.Takeover, `takeover:${generation}:${epoch}`,
              { v: 1, op: 'takeover', epoch, generation, outcome: { result: 'TAKEOVER' } }));
            mem.state.advance(seq, ctx.ts);
          }
          for (const p of batch) {
            const d = p.t === 'init' ? mem.state.init(p.init) : mem.state.decide(p.cmd, ctx.ts, seq + 1n);
            decisions.push(d);
            if (!d.entry) { seqs.push(undefined); continue; }
            seq += 1n;
            seqs.push(seq);
            mem.state.advance(seq, ctx.ts);
            if (p.t === 'init') {
              entries.push(this.entry(ENTRY.Init, `init:${p.init.link}`, { v: 1, op: 'init', init: p.init, outcome: d.outcome }));
            } else {
              mem.state.recordFence(senderKey(p.sender.kind, p.sender.partition), p.sender);
              entries.push(this.commandEntry(p.cmd, p.sender, d.outcome));
            }
          }
          // No entry: every command is answered from the committed state, and nothing is written.
          return entries.length === 0 ? null : { entries };
        },
      });

      switch (result.r) {
        case 'Committed':
          mem.state.commit();
          if (entries.length > 0) mem.lastEntryEpoch = epoch;
          mem.state.prune(result.ts);
          this.answer(mem, batch, decisions, seqs, decidedAt as HlcTs);
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
      this.o.onDecided?.({ link: mem.link, command: p.t === 'cmd' ? p.cmd : p.init, outcome: d.outcome, ts, ...(seq === undefined ? {} : { seq }) });
      if (d.alert) {
        const request = p.t === 'cmd' ? requestKey(p.cmd.body.request) : undefined;
        this.alert({ kind: d.alert, link: mem.link, ...(request ? { request } : {}) });
      }
      if (!this.rt.leaseValid(mem.slot).valid) { p.resolve({ code: 'NOT_OWNER' }); return; }
      this.o.onReply?.(p.t === 'cmd' ? `${p.cmd.op}:${requestKey(p.cmd.body.request)}` : `init:${mem.link}`);
      const out = d.outcome;
      if ('result' in out) {
        const stamp: LinkStamp = { linkFence, linkSeq: seqs[i] ?? d.recordedSeq ?? mem.state.appliedSeq };
        p.resolve({ ...stamp, ...out });
      } else {
        p.resolve(out);
      }
    });
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
    for (const e of entries) {
      if (!this.replay(mem, e)) {
        mem.stopped = true;
        break;
      }
    }
    mem.state.commit();
    mem.rebuild = 'none';
  }

  /** Apply one logged entry again and compare the outcome with the recorded one. */
  private replay(mem: LinkMemory, e: LoggedEntry): boolean {
    const p = e.payload as LoggedPayload;
    let d: Decision;
    if (p.op === 'init') d = mem.state.init(p.init);
    else if (p.op === 'takeover') d = { outcome: { result: 'TAKEOVER' }, entry: true };
    else {
      d = mem.state.decide({ op: p.op, body: p.body } as LinkCommand, e.ts, e.seq);
      mem.state.recordFence(senderKey(p.sender.kind, p.sender.partition), p.sender);
    }
    mem.state.advance(e.seq, e.ts);
    mem.lastEntryEpoch = e.epoch;
    if (!d.entry || hex(encodeJson(d.outcome)) !== hex(encodeJson(p.outcome))) {
      this.alert({ kind: 'OUTCOME_MISMATCH_ON_REPLAY', link: mem.link, detail: `seq ${e.seq}` });
      return false;
    }
    return true;
  }

  // ---------------- entries ----------------

  private entry(kind: number, identity: string, payload: LoggedPayload): EntryInput {
    return { kind, schemaV: 1, identity: utf8(identity), audit: AUDIT, payload };
  }

  private commandEntry(cmd: LinkCommand, sender: SenderRef, outcome: Outcome): EntryInput {
    const key = requestKey(cmd.body.request);
    const kind = cmd.op === 'hold' ? ENTRY.Hold : cmd.op === 'convert' ? ENTRY.Convert : ENTRY.Release;
    // A release can write a second entry only to extend its tombstone, so its identity has D.
    const identity = cmd.op === 'release' ? `release:${key}:${cmd.body.deadline}` : `${cmd.op}:${key}`;
    const e = this.entry(kind, identity, { v: 1, op: cmd.op, body: cmd.body, outcome, sender });
    e.senderFence = sender;
    e.audit = { ...AUDIT, on_behalf_of: { account: hex(sender.partition), request_ref: key } };
    return e;
  }

  private alert(a: LinkAlert): void {
    this.alerts.push(a);
    this.o.onAlert?.(a);
  }
}

export function senderKey(kind: string, partition: PartitionKey): string {
  return `${kind}|${hex(partition)}`;
}
