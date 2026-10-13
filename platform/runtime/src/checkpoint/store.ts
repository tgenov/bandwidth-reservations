/**
 * Checkpoint store (RFC-006 §12.11; C01 putCheckpoint/getCheckpoint, §3.12, §5).
 * A checkpoint is sealed under the partition's log key and written to the object store of the
 * writer's own region only. A read reads only the reader's own region.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OwnerKind, PartitionKey, Seq } from '../api.ts';
import { bytesEqual, hex } from '../bytes.ts';
import { systemClock, type WallClock } from '../clock.ts';
import type { SealContext, Sealer } from '../sealer.ts';

/** Retention of checkpoints (RFC-006 §12.11): the last 3 of each partition and at least 48 h. */
export const CHECKPOINT = { keepLast: 3, keepMs: 48 * 3_600_000 } as const;

/** The parts of an S3-compatible object store of one region that the checkpoint store uses. */
export interface ObjectStore {
  /** Writes the object. The store records the time of the write from its clock. */
  put(key: string, body: Uint8Array): Promise<void>;
  /** Reads the object, or gives undefined when it does not exist. */
  get(key: string): Promise<Uint8Array | undefined>;
  /** Lists the objects whose key starts with `prefix`, in no specified order. */
  list(prefix: string): Promise<Array<{ key: string; writtenAtMs: number }>>;
  /** Deletes the object. A missing object is not an error. */
  delete(key: string): Promise<void>;
}

/** In-memory object store for unit tests. */
export class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, { body: Uint8Array; writtenAtMs: number }>();
  private readonly wallMs: WallClock;
  constructor(opts: { wallMs?: WallClock } = {}) {
    this.wallMs = opts.wallMs ?? systemClock;
  }
  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, { body: new Uint8Array(body), writtenAtMs: this.wallMs() });
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    const o = this.objects.get(key);
    return o === undefined ? undefined : new Uint8Array(o.body);
  }
  async list(prefix: string): Promise<Array<{ key: string; writtenAtMs: number }>> {
    return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, writtenAtMs: o.writtenAtMs }));
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const OBJECT_FILE = 'o-';
const META_FILE = 'm-';

function isNotFound(e: unknown): boolean {
  return e instanceof Error && 'code' in e && e.code === 'ENOENT';
}

/**
 * Object store in one directory on disk: the dev cell stand-in for the region's Ceph/S3.
 * Each key is one file (name `o-` + percent-encoded key) and one metadata file (`m-` + the same)
 * that holds the time of the write from the injected clock, not the file time.
 */
export class FileObjectStore implements ObjectStore {
  private readonly dir: string;
  private readonly wallMs: WallClock;
  private tmpNo = 0;
  constructor(opts: { dir: string; wallMs?: WallClock }) {
    this.dir = opts.dir;
    this.wallMs = opts.wallMs ?? systemClock;
  }
  // encodeURIComponent encodes '/', ':' and '%'; the prefix makes '.' and '..' safe file names.
  private path(prefix: string, key: string): string {
    return join(this.dir, prefix + encodeURIComponent(key));
  }
  private async writeAtomic(path: string, data: Uint8Array | string): Promise<void> {
    const tmp = join(this.dir, `t-${process.pid}-${this.tmpNo++}`);
    await writeFile(tmp, data);
    await rename(tmp, path);
  }
  async put(key: string, body: Uint8Array): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.writeAtomic(this.path(META_FILE, key), JSON.stringify({ writtenAtMs: this.wallMs() }));
    await this.writeAtomic(this.path(OBJECT_FILE, key), body);
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.path(OBJECT_FILE, key)));
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw e;
    }
  }
  async list(prefix: string): Promise<Array<{ key: string; writtenAtMs: number }>> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    const out: Array<{ key: string; writtenAtMs: number }> = [];
    for (const name of names) {
      if (!name.startsWith(OBJECT_FILE)) continue;
      const key = decodeURIComponent(name.slice(OBJECT_FILE.length));
      if (!key.startsWith(prefix)) continue;
      const meta: unknown = JSON.parse(await readFile(this.path(META_FILE, key), 'utf8'));
      if (meta === null || typeof meta !== 'object' || !('writtenAtMs' in meta) || typeof meta.writtenAtMs !== 'number') {
        throw new Error(`FileObjectStore: bad metadata for key ${key}`);
      }
      out.push({ key, writtenAtMs: meta.writtenAtMs });
    }
    return out;
  }
  async delete(key: string): Promise<void> {
    await rm(this.path(OBJECT_FILE, key), { force: true });
    await rm(this.path(META_FILE, key), { force: true });
  }
}

/** The refusal codes of the checkpoint store. */
export type CheckpointErrorCode = 'DIGEST_MISMATCH' | 'NOT_FOUND' | 'OTHER_REGION' | 'BAD_REFERENCE';

/** An error of the checkpoint store. `code` is the refusal (C01 §5 row putCheckpoint; RFC-006 §12.11). */
export class CheckpointError extends Error {
  readonly code: CheckpointErrorCode;
  constructor(code: CheckpointErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CheckpointError';
    this.code = code;
  }
}

/** The alert that the checkpoint store raises on a digest mismatch (C01 §5). */
export interface CheckpointAlert { alertKind: 'DIGEST_MISMATCH'; reference: string; detail: string }

/** Options of a CheckpointStore. */
export interface CheckpointStoreOptions {
  /** The region of this process. Writes and reads use only this region's object store. */
  region: string;
  /** The object store of `region`. */
  objects: ObjectStore;
  /** Seals under the partition's log key (C01 §3.12). */
  sealer: Sealer;
  /** The clock for retention. */
  wallMs?: WallClock;
  /** Receives a DIGEST_MISMATCH alert. */
  alert?: (a: CheckpointAlert) => void;
}

const DIGEST_BYTES = 32;
const NAME = /^[^:]+$/;
const PART_HEX = /^(?:[0-9a-f]{2})+$/;
const SEQ = /^(?:0|[1-9][0-9]*)$/;

interface Ref { region: string; kind: string; partHex: string; seq: bigint }

function sha256(b: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(b).digest());
}

function parseRef(reference: string): Ref | undefined {
  const parts = reference.split(':');
  if (parts.length !== 5) return undefined;
  const [tag, region, kind, partHex, seq] = parts;
  if (tag !== 'ckpt' || region === undefined || kind === undefined || partHex === undefined || seq === undefined) return undefined;
  if (!NAME.test(region) || !NAME.test(kind) || !PART_HEX.test(partHex) || !SEQ.test(seq)) return undefined;
  return { region, kind, partHex, seq: BigInt(seq) };
}

/**
 * The checkpoint store of one region (RFC-006 §12.11). The stored object is the SHA-256 digest of the
 * plain bytes (32 bytes), then the sealed bytes. The reference is `ckpt:<region>:<kind>:<hex partition>:<seq>`.
 */
export class CheckpointStore {
  private readonly region: string;
  private readonly objects: ObjectStore;
  private readonly sealer: Sealer;
  private readonly wallMs: WallClock;
  private readonly alertFn: (a: CheckpointAlert) => void;

  constructor(opts: CheckpointStoreOptions) {
    if (!NAME.test(opts.region)) throw new CheckpointError('BAD_REFERENCE', `region "${opts.region}" is empty or has ':'`);
    this.region = opts.region;
    this.objects = opts.objects;
    this.sealer = opts.sealer;
    this.wallMs = opts.wallMs ?? systemClock;
    this.alertFn = opts.alert ?? (() => {});
  }

  /** Seals and writes a checkpoint to this region; returns once written. Idempotent by (kind, partition, seq) (C01 §5). */
  async put(kind: OwnerKind, partition: PartitionKey, seq: Seq, bytes: Uint8Array): Promise<{ reference: string; digest: Uint8Array }> {
    const partHex = hex(partition);
    if (!NAME.test(kind) || !PART_HEX.test(partHex) || seq < 0n) {
      throw new CheckpointError('BAD_REFERENCE', `cannot form a reference from kind "${kind}", partition "${partHex}", seq ${seq}`);
    }
    const ref: Ref = { region: this.region, kind, partHex, seq };
    const reference = this.reference(ref);
    const digest = sha256(bytes);
    const key = this.key(ref);
    const existing = await this.objects.get(key);
    if (existing !== undefined) {
      if (existing.byteLength >= DIGEST_BYTES && bytesEqual(existing.subarray(0, DIGEST_BYTES), digest)) return { reference, digest };
      throw this.mismatch(reference, 'a checkpoint with other bytes exists for this (kind, partition, seq)');
    }
    const sealed = this.sealer.seal(bytes, this.context(ref));
    const body = new Uint8Array(DIGEST_BYTES + sealed.byteLength);
    body.set(digest, 0);
    body.set(sealed, DIGEST_BYTES);
    await this.objects.put(key, body);
    return { reference, digest };
  }

  /** Reads, opens and verifies a checkpoint of this region (RFC-006 §12.11). The caller falls back on an error. */
  async get(reference: string): Promise<Uint8Array> {
    const ref = parseRef(reference);
    if (ref === undefined) throw new CheckpointError('BAD_REFERENCE', `malformed reference "${reference}"`);
    if (ref.region !== this.region) throw new CheckpointError('OTHER_REGION', `reference of region ${ref.region}, this is ${this.region}`);
    const stored = await this.objects.get(this.key(ref));
    if (stored === undefined) throw new CheckpointError('NOT_FOUND', `no object for ${reference}`);
    if (stored.byteLength < DIGEST_BYTES) throw this.mismatch(reference, 'stored object is shorter than a digest');
    let plain: Uint8Array;
    try {
      plain = this.sealer.open(stored.subarray(DIGEST_BYTES), this.context(ref));
    } catch {
      throw this.mismatch(reference, 'stored object does not open under the partition log key');
    }
    if (!bytesEqual(sha256(plain), stored.subarray(0, DIGEST_BYTES))) throw this.mismatch(reference, 'opened bytes do not match the stored digest');
    return plain;
  }

  /**
   * Deletes the checkpoints of one partition outside retention and returns their references.
   * Kept: the last `keepLast` by seq, and each one with age < `keepMs`. A checkpoint of age exactly
   * `keepMs` (48 h) is deleted: RFC-006 §12.11 requires "at least 48 h", and it has had 48 h.
   */
  async prune(kind: OwnerKind, partition: PartitionKey): Promise<string[]> {
    const partHex = hex(partition);
    const prefix = this.partitionPrefix(kind, partHex);
    const now = this.wallMs();
    const found: Array<{ key: string; seq: bigint; writtenAtMs: number }> = [];
    for (const o of await this.objects.list(prefix)) {
      const seq = o.key.slice(prefix.length);
      if (SEQ.test(seq)) found.push({ key: o.key, seq: BigInt(seq), writtenAtMs: o.writtenAtMs });
    }
    found.sort((a, b) => (a.seq < b.seq ? 1 : a.seq > b.seq ? -1 : 0));
    const deleted: string[] = [];
    for (const [i, o] of found.entries()) {
      if (i < CHECKPOINT.keepLast || now - o.writtenAtMs < CHECKPOINT.keepMs) continue;
      await this.objects.delete(o.key);
      deleted.push(this.reference({ region: this.region, kind, partHex, seq: o.seq }));
    }
    return deleted;
  }

  private mismatch(reference: string, detail: string): CheckpointError {
    this.alertFn({ alertKind: 'DIGEST_MISMATCH', reference, detail });
    return new CheckpointError('DIGEST_MISMATCH', `${reference}: ${detail}`);
  }

  private reference(r: Ref): string {
    return `ckpt:${r.region}:${r.kind}:${r.partHex}:${r.seq}`;
  }

  private partitionPrefix(kind: string, partHex: string): string {
    return `ckpt/${encodeURIComponent(kind)}/${partHex}/`;
  }

  private key(r: Ref): string {
    return `${this.partitionPrefix(r.kind, r.partHex)}${r.seq}`;
  }

  // C01 §3.12: checkpoints are sealed under the partition's log key.
  private context(r: Ref): SealContext {
    return {
      ownerKind: r.kind, table: `${r.kind}_log`,
      primaryKey: { partition: r.partHex, seq: r.seq.toString(), object: 'checkpoint' },
      seqOrVersion: r.seq, epoch: 0n, rowKind: 'checkpoint',
    };
  }
}
