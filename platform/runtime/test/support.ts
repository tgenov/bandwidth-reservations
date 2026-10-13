/**
 * Shared test helpers of the runtime package.
 */
import type { S3Api } from '../src/checkpoint/s3.ts';

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
