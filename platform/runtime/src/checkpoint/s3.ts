/**
 * The checkpoint store's object store on an S3-compatible store (RFC-006 §12.11: the Ceph object store of the
 * process's own region; plan S-PLAT-I2 work item 5).
 *
 * `S3ObjectStore` uses a subset of the S3 API (`S3Api`), shaped as the AWS SDK v3 `S3` client, so a process gives
 * it an SDK client for its region's Ceph RGW endpoint. This package has no S3 client dependency.
 */
import type { ObjectStore } from './store.ts';

/** The subset of the S3 API that `S3ObjectStore` uses (the shape of the AWS SDK v3 `S3` client). */
export interface S3Api {
  putObject(input: { Bucket: string; Key: string; Body: Uint8Array }): Promise<unknown>;
  getObject(input: { Bucket: string; Key: string }): Promise<{ Body?: { transformToByteArray(): Promise<Uint8Array> } }>;
  listObjectsV2(input: { Bucket: string; Prefix: string; ContinuationToken?: string }): Promise<{
    Contents?: Array<{ Key?: string; LastModified?: Date }>; IsTruncated?: boolean; NextContinuationToken?: string;
  }>;
  deleteObject(input: { Bucket: string; Key: string }): Promise<unknown>;
  getBucketLocation(input: { Bucket: string }): Promise<{ LocationConstraint?: string }>;
}

/** The refusal codes of `S3ObjectStore`. */
export type S3ObjectStoreErrorCode = 'OTHER_REGION' | 'BAD_RESPONSE';

/** An error of `S3ObjectStore`. S3 errors other than a missing key pass through unchanged. */
export class S3ObjectStoreError extends Error {
  readonly code: S3ObjectStoreErrorCode;
  constructor(code: S3ObjectStoreErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'S3ObjectStoreError';
    this.code = code;
  }
}

/** Options of an `S3ObjectStore`. */
export interface S3ObjectStoreOptions {
  client: S3Api;
  /** The checkpoint bucket of the process's own region. */
  bucket: string;
}

function isMissing(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === 'NoSuchKey') return true;
  const meta = '$metadata' in e ? e.$metadata : undefined;
  return typeof meta === 'object' && meta !== null && 'httpStatusCode' in meta && meta.httpStatusCode === 404;
}

/**
 * An `ObjectStore` on one S3 bucket. `writtenAtMs` is the store's `LastModified` (the time of the write from the
 * store's clock; S3 gives whole seconds, which is enough for the 48 h retention).
 */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Api;
  private readonly bucket: string;

  constructor(o: S3ObjectStoreOptions) {
    this.client = o.client;
    this.bucket = o.bucket;
  }

  /**
   * Opens the store after a check that the bucket is in `region` (RFC-006 §12.11: a checkpoint is written to and
   * read from the process's own region only). The bucket's location constraint must equal `region`.
   */
  static async open(o: S3ObjectStoreOptions & { region: string }): Promise<S3ObjectStore> {
    const loc = (await o.client.getBucketLocation({ Bucket: o.bucket })).LocationConstraint ?? '';
    if (loc !== o.region) throw new S3ObjectStoreError('OTHER_REGION', `bucket ${o.bucket} is in "${loc}", this process is in ${o.region}`);
    return new S3ObjectStore(o);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.client.putObject({ Bucket: this.bucket, Key: key, Body: new Uint8Array(body) });
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    let out: Awaited<ReturnType<S3Api['getObject']>>;
    try {
      out = await this.client.getObject({ Bucket: this.bucket, Key: key });
    } catch (e) {
      if (isMissing(e)) return undefined;
      throw e;
    }
    if (out.Body === undefined) throw new S3ObjectStoreError('BAD_RESPONSE', `no body for ${key}`);
    return new Uint8Array(await out.Body.transformToByteArray());
  }

  async list(prefix: string): Promise<Array<{ key: string; writtenAtMs: number }>> {
    const found: Array<{ key: string; writtenAtMs: number }> = [];
    let token: string | undefined;
    do {
      const page = await this.client.listObjectsV2({ Bucket: this.bucket, Prefix: prefix, ...(token === undefined ? {} : { ContinuationToken: token }) });
      for (const c of page.Contents ?? []) {
        if (c.Key === undefined || c.LastModified === undefined) throw new S3ObjectStoreError('BAD_RESPONSE', 'a listing entry has no key or no time');
        found.push({ key: c.Key, writtenAtMs: c.LastModified.getTime() });
      }
      if (page.IsTruncated === true && page.NextContinuationToken === undefined) {
        throw new S3ObjectStoreError('BAD_RESPONSE', 'a truncated listing has no continuation token');
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return found;
  }

  async delete(key: string): Promise<void> {
    await this.client.deleteObject({ Bucket: this.bucket, Key: key });
  }
}
