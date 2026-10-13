/**
 * Shared test helpers of the runtime package.
 */
import type { S3Api } from '../src/checkpoint/s3.ts';
import type { AppendResult, OverloadStats, OwnerDeclaration as SimDecl, OwnerHooks as SimHooks } from '../src/index.ts';
import { CockroachOwnerRuntime as SimRuntime, ManualLoad as SimLoad, MemoryPublisher as SimPublisher, utf8 as simUtf8 } from '../src/index.ts';
import type { BatchTxn, BatchWrites } from '../src/store/types.ts';
import { MemoryStore } from '../testing/index.ts';

/** An S3 error as the AWS SDK v3 gives it: a name and the HTTP status. */
export function s3Error(name: string, httpStatusCode: number): Error & { $metadata: { httpStatusCode: number } } {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}

type S3Method = keyof S3Api;

/**
 * An S3 double: one bucket in memory, with the S3 behaviour that `S3ObjectStore` relies on. `LastModified` is the
 * double's clock at the write. A listing is in key order (UTF-8 bytes), at most `maxKeys` per page, with a
 * continuation token. A missing key on `getObject` is `NoSuchKey` (404); `deleteObject` of a missing key succeeds.
 * `fail[method]` makes the next call of that method throw the given error.
 */
export class S3Double implements S3Api {
  readonly calls: Record<S3Method, number> = { putObject: 0, getObject: 0, listObjectsV2: 0, deleteObject: 0, getBucketLocation: 0 };
  readonly fail: Partial<Record<S3Method, Error>> = {};
  private readonly objects = new Map<string, { body: Uint8Array; lastModified: Date }>();
  private readonly bucket: string;
  private readonly location: string;
  private readonly clock: () => number;
  private readonly maxKeys: number;

  constructor(o: { bucket: string; location: string; clock: () => number; maxKeys?: number }) {
    this.bucket = o.bucket;
    this.location = o.location;
    this.clock = o.clock;
    this.maxKeys = o.maxKeys ?? 1_000;
  }

  private enter(m: S3Method, bucket: string): void {
    this.calls[m] += 1;
    const e = this.fail[m];
    if (e) { delete this.fail[m]; throw e; }
    if (bucket !== this.bucket) throw s3Error('NoSuchBucket', 404);
  }

  async putObject(i: { Bucket: string; Key: string; Body: Uint8Array }): Promise<unknown> {
    this.enter('putObject', i.Bucket);
    this.objects.set(i.Key, { body: new Uint8Array(i.Body), lastModified: new Date(this.clock()) });
    return {};
  }

  async getObject(i: { Bucket: string; Key: string }): Promise<{ Body?: { transformToByteArray(): Promise<Uint8Array> } }> {
    this.enter('getObject', i.Bucket);
    const o = this.objects.get(i.Key);
    if (!o) throw s3Error('NoSuchKey', 404);
    const copy = new Uint8Array(o.body);
    return { Body: { transformToByteArray: async () => copy } };
  }

  async listObjectsV2(i: { Bucket: string; Prefix: string; ContinuationToken?: string }): Promise<{
    Contents?: Array<{ Key?: string; LastModified?: Date }>; IsTruncated?: boolean; NextContinuationToken?: string;
  }> {
    this.enter('listObjectsV2', i.Bucket);
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(i.Prefix))
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .filter((k) => i.ContinuationToken === undefined || Buffer.compare(Buffer.from(k), Buffer.from(i.ContinuationToken, 'base64')) > 0);
    const page = keys.slice(0, this.maxKeys);
    const truncated = keys.length > page.length;
    const last = page[page.length - 1];
    return {
      ...(page.length > 0 ? { Contents: page.map((k) => ({ Key: k, LastModified: new Date(this.objects.get(k)?.lastModified ?? 0) })) } : {}),
      IsTruncated: truncated,
      ...(truncated && last !== undefined ? { NextContinuationToken: Buffer.from(last).toString('base64') } : {}),
    };
  }

  async deleteObject(i: { Bucket: string; Key: string }): Promise<unknown> {
    this.enter('deleteObject', i.Bucket);
    this.objects.delete(i.Key);
    return {};
  }

  async getBucketLocation(i: { Bucket: string }): Promise<{ LocationConstraint?: string }> {
    this.enter('getBucketLocation', i.Bucket);
    return { LocationConstraint: this.location };
  }
}

/**
 * Waits until `f` is true (engineering.md §5: wait for a condition, with a timeout). It checks the condition
 * every few ms and fails after `ms` with `what` in the message.
 */
export async function until(f: () => boolean | Promise<boolean>, ms = 5_000, what = f.toString()): Promise<void> {
  let expired = false;
  const timer = setTimeout(() => { expired = true; }, ms);
  try {
    while (!(await f())) {
      if (expired) throw new Error(`timed out after ${ms} ms: ${what}`);
      await new Promise((r) => setTimeout(r, 2));
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Lets other pending steps run `n` times (a yield of the event loop, not a wait for time). */
export async function yieldTurns(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

/** A stepped wall clock (engineering.md §5): it moves only when the test steps it. */
export function steppedClock(start = 1_800_000_000_000): { now: () => number; step: (ms: number) => void } {
  let t = start;
  return { now: () => t, step: (ms) => { t += ms; } };
}

/** A seeded generator (engineering.md §5): put the seed in every failure message. */
export function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; };
}

/** Closes what a test opened, also when the test fails: register with `add`, call `closeAll` in `afterEach`. */
export class Closers {
  private readonly fns: Array<() => Promise<void>> = [];
  add(fn: () => Promise<void>): void { this.fns.push(fn); }
  async closeAll(): Promise<void> {
    for (const fn of this.fns.splice(0).reverse()) { try { await fn(); } catch { /* already closed */ } }
  }
}

/** A store that counts the calls of `method` (tests wait for a number of renewals or session polls). */
export function countCalls<T extends object>(store: T, method: keyof T & string): { count: () => number } {
  let n = 0;
  const real = (store[method] as unknown as (...a: unknown[]) => unknown).bind(store);
  (store as Record<string, unknown>)[method] = (...a: unknown[]) => { n += 1; return real(...a); };
  return { count: () => n };
}

// ---------------- overload simulation (RFC-006 §4.7 rule 5, §22.1 caller model, DT-50) ----------------


/** A seeded uniform generator in [0, 1) (mulberry32): the `retryAfterMs` jitter of a simulation. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** One phase of open-loop load: first sends at `ratePerS` until `untilMs`. */
export interface SimPhase { untilMs: number; ratePerS: number }

/** One write of a batch transaction in a simulation. */
export interface SimWrite { startMs: number; ms: number; ids: string[]; abandoned: boolean }

/** The result of one simulation run. */
export interface SimRun {
  endMs: number;
  /** First-send time of each call, in order. */
  firstSends: number[];
  /** Commit instants and the calls each committed. */
  commits: Array<{ at: number; calls: number }>;
  writes: SimWrite[];
  retries: number; overloaded: number; gaveUp: number;
  /** Retry answers per call id. */
  retryIds: Set<string>;
  freshAttempts: Array<{ calls: number }>;
  stats: OverloadStats;
}

const SIM_DECL: SimDecl = {
  kind: 'canary', slotCount: 1,
  entryKinds: [{ kind: 1, name: 'incremented', schemaVersions: [1], retention: 'ops' }],
  projections: [], streams: [],
};
const SIM_AUDIT = { schema: 'audit.v1', principal: { principal_id: 'internal_service', kind: 'service', tenant: 'share' },
  decided_at: 'commit', policy_version: 1 } as const;
const SIM_HOOKS: SimHooks = {
  async onAcquire() {}, onRelease() {}, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {},
};

/**
 * One slot of the real runtime core over the in-memory store with database time. A batch that starts at `s` with
 * `n` log rows takes `dbMs(n, s)`; the stepped clock carries it, and calls that arrive meanwhile join the queue at
 * their own arrival instants. A write longer than the abandon budget stops at the budget + 1 ms (the abandon).
 * §22.1 caller model: re-send `retryAfterMs` after `Overloaded`, at once after `Retry`, give up 30 s after the first
 * send. No call is re-sent after the end. No real time passes.
 */
export async function simulate(o: {
  phases: SimPhase[]; dbMs: (rows: number, startMs: number) => number; rules?: boolean; seed?: number; partitions?: number;
}): Promise<SimRun> {
  const abandonMs = 2_000;
  let now = 0;
  const clock = (): number => now;
  const endMs = o.phases[o.phases.length - 1]?.untilMs ?? 0;
  const arrivals: Array<{ at: number; id: number }> = [];
  let from = 0;
  for (const p of o.phases) {
    for (let t = from; t < p.untilMs; t += 1_000 / p.ratePerS) arrivals.push({ at: t, id: arrivals.length });
    from = p.untilMs;
  }
  const first = arrivals.map((a) => a.at);
  const resends: Array<{ at: number; id: number }> = [];
  const commits: Array<{ at: number; calls: number }> = [];
  const writes: SimWrite[] = [];
  const retryIds = new Set<string>();
  let next = 0;
  let inRuntime = 0;
  let retries = 0;
  let overloaded = 0;
  let gaveUp = 0;
  let idle: (() => void) | undefined;
  let rt: SimRuntime | undefined;

  const send = (id: number): void => {
    if (now - (first[id] ?? 0) > 30_000) { gaveUp += 1; return; }
    inRuntime += 1;
    const sentAt = now;
    rt?.append({ partition: simUtf8(`p-${id % (o.partitions ?? 64)}`), entries: [{ kind: 1, schemaV: 1, identity: simUtf8(`c-${id}`), audit: SIM_AUDIT, payload: { id } }] })
      .then((r: AppendResult) => {
        inRuntime -= 1;
        if (r.r === 'Retry' || r.r === 'Overloaded') {
          if (r.r === 'Retry') { retries += 1; retryIds.add(`c-${id}`); } else overloaded += 1;
          const at = r.r === 'Overloaded' ? sentAt + r.retryAfterMs : now;
          if (at < endMs) resends.push({ at, id });
        } else if (r.r !== 'Committed') {
          throw new Error(`unexpected append result ${r.r}`);
        }
        if (inRuntime === 0) idle?.();
      }, (e: unknown) => { throw e; });
  };
  /** Steps the clock to `target`, sending each call at its own instant on the way. */
  const advance = (target: number): void => {
    for (;;) {
      resends.sort((a, b) => a.at - b.at);
      const a = arrivals[next];
      const r = resends[0];
      const due = Math.min(a?.at ?? Infinity, r?.at ?? Infinity);
      if (due > target || due >= endMs) break;
      now = Math.max(now, due);
      if (a && a.at === due) { next += 1; send(a.id); } else if (r) { resends.shift(); send(r.id); }
    }
    now = Math.max(now, target);
  };

  class TimedStore extends MemoryStore {
    override async beginBatch(): Promise<BatchTxn> {
      const tx = await super.beginBatch();
      let wrote = 0;
      const write = tx.write.bind(tx);
      const commit = tx.commit.bind(tx);
      tx.write = async (kind: string, w: BatchWrites): Promise<void> => {
        await write(kind, w);
        wrote = w.log.length;
        const startMs = now;
        const d = o.dbMs(w.log.length, startMs);
        const ms = Math.min(d, abandonMs + 1);
        writes.push({ startMs, ms, ids: w.log.map((l) => new TextDecoder().decode(l.identity)), abandoned: d > abandonMs });
        advance(startMs + ms);
      };
      tx.commit = async (backstopMs: number): Promise<void> => {
        await commit(backstopMs);
        commits.push({ at: now, calls: wrote });
      };
      return tx;
    }
  }

  const store = new TimedStore();
  store.seedSlots(SIM_DECL.kind, SIM_DECL.slotCount);
  rt = new SimRuntime({
    declaration: SIM_DECL, store, slots: [0], publisher: new SimPublisher(), load: new SimLoad(),
    testing: { batchNowMs: clock, random: seeded(o.seed ?? 1), overloadControl: o.rules !== false },
  });
  await rt.start(SIM_HOOKS);
  let stats: OverloadStats | undefined;
  try {
    for (;;) {
      advance(now);
      if (inRuntime > 0) {
        await new Promise<void>((r) => { idle = r; });
        idle = undefined;
        continue;
      }
      const due = Math.min(arrivals[next]?.at ?? Infinity, ...resends.map((r) => r.at));
      if (due === Infinity || due >= endMs) break;
      now = Math.max(now, due);
    }
    stats = rt.overloadStats(0);
  } finally {
    await rt.stop();
  }
  if (!stats) throw new Error('slot 0 not held at the end of the run');
  return { endMs, firstSends: first, commits, writes, retries, overloaded, gaveUp, retryIds, freshAttempts: rt.freshAttempts, stats };
}
