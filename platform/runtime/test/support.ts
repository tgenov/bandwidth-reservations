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
