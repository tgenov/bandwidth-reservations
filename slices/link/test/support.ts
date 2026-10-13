/**
 * Test harness of S-LINK I1 (S-LINK plan §2 "Test harness"):
 * - a seeded random generator (mulberry32, as the prior `test/helpers.ts`);
 * - the runtime double with the link owner attached;
 * - the recorded account-owner stub, which sends C02 commands with C01 envelopes;
 * - the per-minute oracle (T-01), one cell per minute, for hold, convert and release.
 */
import type { CommandEnvelope, HlcTs, OwnerRuntime, PartitionKey } from '@share/owner-runtime';
import { hlcToWallMs, utf8 } from '@share/owner-runtime';
import { RuntimeDouble } from '@share/owner-runtime/testing';
import type {
  ConvertCmd, ConvertReply, HoldCmd, HoldReply, LinkCommand, Outcome, ReleaseCmd, ReleaseReply, RequestId, Window,
} from '../src/index.ts';
import { declaration, digest, LINK_KIND, LinkOwner, requestKey, wallNs, type DecidedRecord, type LinkOwnerOptions, type LogReader } from '../src/index.ts';

// ---------------- random ----------------

export function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

// ---------------- time ----------------

/** The scenarios say "it is 09:00" on one UTC day. The double's clock starts there. */
export const DAY_MS = Date.UTC(2026, 2, 2);
export const START_MS = DAY_MS + 9 * 3_600_000;
export const DAY_MIN = DAY_MS / 60_000;
/** The minute index of hh:mm on the scenario day. */
export const M = (hh: number, mm = 0): number => DAY_MIN + hh * 60 + mm;

// ---------------- harness on the runtime double ----------------

export interface Harness {
  rt: RuntimeDouble;
  owner: LinkOwner;
  decided: DecidedRecord[];
  link: string;
  stub: AccountStub;
}

export function doubleLogReader(rt: RuntimeDouble): LogReader {
  return async (partition, after) => rt.log(partition)
    .filter((e) => e.seq > after)
    .map((e) => ({ seq: e.seq, ts: e.ts, epoch: e.epoch, kind: e.entry.kind, payload: e.entry.payload }));
}

export async function harness(opts: { link?: string; capacity?: number; owner?: Partial<LinkOwnerOptions> } = {}): Promise<Harness> {
  const link = opts.link ?? 'L1';
  const rt = new RuntimeDouble({ declaration, startMs: START_MS });
  const decided: DecidedRecord[] = [];
  const owner = new LinkOwner(rt, {
    readLog: doubleLogReader(rt),
    onReply: (l) => rt.recordReply(l),
    onDecided: (d) => decided.push(d),
    ...opts.owner,
  });
  rt.attach(owner);
  const r = await owner.register(link, opts.capacity ?? 10);
  if (!('result' in r) || r.result !== 'INITIALISED') throw new Error(`register failed: ${JSON.stringify(r)}`);
  return { rt, owner, decided, link, stub: new AccountStub(rt, owner, link) };
}

// ---------------- recorded account-owner stub ----------------

let seqCounter = 1n;

export interface HoldArgs {
  rate: number; window: Window; wait?: boolean;
  /** Remaining deadline in ms from the runtime's present time. Default 20 s. */
  deadlineInMs?: number;
  account?: string; request?: RequestId; leg?: string;
}

/**
 * The C02 consumer side, as the account owner would send it (S-LINK plan §1 rule 4). Each command has
 * a C01 envelope routed by `route()`. The stub keeps the commands it sent, so a test can send one again.
 */
export class AccountStub {
  readonly rt: OwnerRuntime;
  readonly owner: LinkOwner;
  readonly link: string;
  generation = 0;
  epoch = 1n;

  constructor(rt: OwnerRuntime, owner: LinkOwner, link: string) {
    this.rt = rt; this.owner = owner; this.link = link;
  }

  newRequest(account = 'b1'): RequestId {
    seqCounter += 1n;
    return { partition: utf8(account), seq: seqCounter };
  }

  envelope(account: string | PartitionKey, overrides: Partial<CommandEnvelope['routedTo']> = {}): CommandEnvelope {
    const partition = utf8(this.link);
    const route = this.rt.route(LINK_KIND, partition);
    const acct = typeof account === 'string' ? utf8(account) : account;
    return {
      routedTo: { kind: LINK_KIND, slot: route.slot, generation: route.generation, epoch: route.epoch, ...overrides },
      sender: { kind: 'account', partition: acct, generation: this.generation, epoch: this.epoch },
      identity: utf8(`env:${Math.random()}`),
    };
  }

  holdCmd(a: HoldArgs): HoldCmd {
    const account = a.account ?? 'b1';
    const request = a.request ?? this.newRequest(account);
    const now = hlcToWallMs(this.rt.now().ts);
    const deadline = now + (a.deadlineInMs ?? 20_000);
    return {
      link: this.link, receiverPartition: this.link, request, account: utf8(account), leg: a.leg ?? 'leg-1',
      holdKind: { kind: 'booking' }, rateMbps: a.rate, window: a.window, deadline, commitFence: deadline - 420,
      requestAge: this.rt.now().ts, wait: a.wait ?? false, receiptMinute: Math.floor(now / 60_000), policyVersion: 1n,
    };
  }

  hold(cmd: HoldCmd, env?: CommandEnvelope): Promise<HoldReply> {
    return this.owner.hold(env ?? this.envelope(cmd.account), cmd);
  }

  convertCmd(hold: HoldCmd, attempt = 1, part = `p-${requestKey(hold.request)}`): ConvertCmd {
    return {
      link: this.link, receiverPartition: this.link, request: hold.request, attempt,
      reservation: `r-${requestKey(hold.request)}`, leg: hold.leg, part,
      createdBy: { partition: hold.account, seq: hold.request.seq + 1000n }, decisionTime: this.rt.now().ts,
    };
  }

  convert(cmd: ConvertCmd, env?: CommandEnvelope): Promise<ConvertReply> {
    return this.owner.convert(env ?? this.envelope(cmd.request.partition), cmd);
  }

  releaseCmd(request: RequestId, deadline: number, reason: ReleaseCmd['reason'] = 'REJECTED'): ReleaseCmd {
    return { link: this.link, receiverPartition: this.link, request, deadline, reason, decisionTime: this.rt.now().ts };
  }

  release(cmd: ReleaseCmd, env?: CommandEnvelope): Promise<ReleaseReply> {
    return this.owner.release(env ?? this.envelope(cmd.request.partition), cmd);
  }

  /** Book and confirm: hold, then convert. Returns the hold reply and the convert reply. */
  async book(a: HoldArgs): Promise<{ hold: HoldReply; convert?: ConvertReply; cmd: HoldCmd }> {
    const cmd = this.holdCmd(a);
    const hold = await this.hold(cmd);
    if ('result' in hold && hold.result === 'HELD') return { hold, convert: await this.convert(this.convertCmd(cmd)), cmd };
    return { hold, cmd };
  }
}

export function resultOf(r: unknown): string {
  if (typeof r === 'object' && r !== null) {
    const o = r as Record<string, unknown>;
    if ('result' in o) return o['result'] === 'REFUSED' ? `REFUSED:${JSON.stringify(o['reason'])}` : String(o['result']);
    if ('code' in o) return String(o['code']);
  }
  return JSON.stringify(r);
}

// ---------------- per-minute oracle (T-01) ----------------

interface OracleRequest {
  madeBy: 'hold' | 'release';
  state: 'HELD' | 'REFUSED' | 'RELEASED' | 'CONVERTED';
  holdDigest?: string; holdOutcome?: Outcome; convertDigest?: string; convertAttempt?: number; convertOutcome?: Outcome;
  rate?: number; window?: Window; deadline?: number; tombstoneUntil?: number;
}

/**
 * One cell per minute over [0, n) minutes from `base`. Open-ended windows end at n. Every window of a
 * test lies in [base, base + n), so the value after n is at most the value at n − 1 (all pulses ≥ 0).
 */
export class MinuteOracle {
  readonly firm: Int32Array;
  readonly all: Int32Array;
  private readonly req = new Map<string, OracleRequest>();
  readonly base: number;
  readonly n: number;
  readonly capacity: number;
  readonly releaseGraceMs: number;
  constructor(base: number, n: number, capacity: number, releaseGraceMs = 60_000) {
    this.base = base; this.n = n; this.capacity = capacity; this.releaseGraceMs = releaseGraceMs;
    this.firm = new Int32Array(n);
    this.all = new Int32Array(n);
  }

  private span(w: Window): [number, number] {
    return [w.start - this.base, (w.end ?? this.base + this.n) - this.base];
  }

  private peak(arr: Int32Array, w: Window): number {
    const [s, e] = this.span(w);
    let p = -Infinity;
    for (let t = s; t < e; t++) if ((arr[t] as number) > p) p = arr[t] as number;
    return p;
  }

  private addTo(arr: Int32Array, w: Window, b: number): void {
    const [s, e] = this.span(w);
    for (let t = s; t < e; t++) arr[t] = (arr[t] as number) + b;
  }

  /** The outcome that the link must give for `cmd` at `ts`. */
  apply(cmd: LinkCommand, ts: HlcTs): Outcome {
    const key = requestKey(cmd.body.request);
    const rec = this.req.get(key);
    const tsNs = wallNs(ts);
    if (cmd.op === 'hold') {
      const b = cmd.body;
      if (rec?.madeBy === 'release') return { result: 'REFUSED', reason: 'TOMBSTONED' };
      if (rec) return rec.holdDigest === digest(b) ? rec.holdOutcome as Outcome : { code: 'MISMATCH' };
      const refuse = (o: Outcome): Outcome => {
        this.req.set(key, { madeBy: 'hold', state: 'REFUSED', holdDigest: digest(b), holdOutcome: o, tombstoneUntil: b.deadline + this.releaseGraceMs });
        return o;
      };
      if (tsNs >= BigInt(b.commitFence) * 1_000_000n) return refuse({ result: 'REFUSED', reason: 'DEADLINE_PASSED' });
      if (!Number.isSafeInteger(b.rateMbps) || b.rateMbps < 1) return refuse({ result: 'REFUSED', reason: { invalid: 'V1' } });
      if (b.window.end !== null && b.window.end <= b.window.start) return refuse({ result: 'REFUSED', reason: { invalid: 'V3' } });
      if (this.peak(this.firm, b.window) + b.rateMbps > this.capacity) return refuse({ result: 'REFUSED', reason: 'NO_FIT' });
      if (this.peak(this.all, b.window) + b.rateMbps <= this.capacity) {
        this.addTo(this.all, b.window, b.rateMbps);
        const o: Outcome = { result: 'HELD', attempt: 1 };
        this.req.set(key, { madeBy: 'hold', state: 'HELD', holdDigest: digest(b), holdOutcome: o, rate: b.rateMbps, window: b.window, deadline: b.deadline });
        return o;
      }
      if (b.wait) return { code: 'UNAVAILABLE' };
      // Blockers: holds that overlap a minute where all + b > capacity.
      const [s, e] = this.span(b.window);
      let latest = -1;
      for (const r of this.req.values()) {
        if (r.state !== 'HELD' || !r.window || r.deadline === undefined || r.deadline <= latest) continue;
        const [hs, he] = this.span(r.window);
        for (let t = Math.max(s, hs); t < Math.min(e, he); t++) {
          if ((this.all[t] as number) + b.rateMbps > this.capacity) { latest = r.deadline; break; }
        }
      }
      let retryAfterMs = 0;
      if (latest >= 0) {
        const ns = BigInt(latest) * 1_000_000n - tsNs;
        retryAfterMs = ns <= 0n ? 0 : Number((ns + 999_999n) / 1_000_000n);
      }
      return refuse({ result: 'REFUSED', reason: 'IN_FLIGHT', retryAfterMs });
    }
    if (cmd.op === 'convert') {
      const b = cmd.body;
      if (!rec) return { code: 'NO_HOLD' };
      if (rec.state === 'CONVERTED') {
        return rec.convertAttempt === b.attempt && rec.convertDigest === digest(b) ? rec.convertOutcome as Outcome : { code: 'MISMATCH' };
      }
      if (rec.state !== 'HELD') return { code: 'TOMBSTONED' };
      if (b.attempt !== 1) return { code: 'MISMATCH' };
      this.addTo(this.firm, rec.window as Window, rec.rate as number);
      const o: Outcome = { result: 'CONVERTED', part: b.part };
      Object.assign(rec, { state: 'CONVERTED', holdOutcome: { result: 'CONVERTED', part: b.part }, convertDigest: digest(b), convertAttempt: b.attempt, convertOutcome: o });
      return o;
    }
    const b = cmd.body;
    const until = b.deadline + this.releaseGraceMs;
    if (!rec) {
      this.req.set(key, { madeBy: 'release', state: 'RELEASED', tombstoneUntil: until });
      return { result: 'RELEASED', tombstoneUntil: until };
    }
    const newUntil = Math.max(rec.tombstoneUntil ?? 0, until);
    if (rec.state === 'HELD') {
      this.addTo(this.all, rec.window as Window, -(rec.rate as number));
      Object.assign(rec, { state: 'RELEASED', holdOutcome: { result: 'RELEASED' } });
    }
    rec.tombstoneUntil = newUntil;
    return { result: 'RELEASED', tombstoneUntil: newUntil };
  }

  maxAll(): number {
    let m = 0;
    for (const v of this.all) if (v > m) m = v;
    return m;
  }
}
