/**
 * S-PLAT-I2 work item 5: the checkpoint store's object store on an S3-compatible store (RFC-006 §12.11: the Ceph
 * object store of the process's own region). The S3 side is a double (`test/support.ts`). The object-store and
 * checkpoint suites of checkpoint.test.ts also run on S3ObjectStore.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8 } from '../src/bytes.ts';
import { S3ObjectStore, S3ObjectStoreError } from '../src/checkpoint/s3.ts';
import { S3Double, s3Error } from './support.ts';

const T0 = 1_760_000_000_000;
const TIMEOUT = { timeout: 5_000 };
const BUCKET = 'ckpt-r1';

function double(maxKeys?: number, location = 'R1'): S3Double {
  return new S3Double({ bucket: BUCKET, location, clock: () => T0, ...(maxKeys === undefined ? {} : { maxKeys }) });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { if (e instanceof S3ObjectStoreError) return e.code; throw e; }
  return 'NO_ERROR';
}

test('should open on a bucket of its own region and refuse with OTHER_REGION a bucket of another region', TIMEOUT, async () => {
  const own = double();
  const store = await S3ObjectStore.open({ client: own, bucket: BUCKET, region: 'R1' });
  await store.put('k', utf8('v'));
  assert.deepEqual(await store.get('k'), utf8('v'));
  const other = double(undefined, 'R2');
  assert.equal(await codeOf(S3ObjectStore.open({ client: other, bucket: BUCKET, region: 'R1' })), 'OTHER_REGION');
  assert.equal(other.calls.getBucketLocation, 1);
  assert.equal(other.calls.putObject, 0, 'no write to another region');
});

test('should refuse with OTHER_REGION a bucket with no location constraint when its own region is named', TIMEOUT, async () => {
  const s3 = double(undefined, '');
  assert.equal(await codeOf(S3ObjectStore.open({ client: s3, bucket: BUCKET, region: 'R1' })), 'OTHER_REGION');
});

test('should list every key of the prefix across pages when the listing is truncated', TIMEOUT, async () => {
  const s3 = double(2);
  const store = new S3ObjectStore({ client: s3, bucket: BUCKET });
  for (let i = 1; i <= 5; i++) await store.put(`p/${i}`, utf8(String(i)));
  await store.put('q/1', utf8('x'));
  const listed = await store.list('p/');
  assert.deepEqual(listed, [1, 2, 3, 4, 5].map((i) => ({ key: `p/${i}`, writtenAtMs: T0 })));
  assert.equal(s3.calls.listObjectsV2, 3, 'pages of 2, 2 and 1');
});

test('should give undefined for a missing object whether S3 names it NoSuchKey or answers only 404', TIMEOUT, async () => {
  const s3 = double();
  const store = new S3ObjectStore({ client: s3, bucket: BUCKET });
  assert.equal(await store.get('none'), undefined);
  s3.fail.getObject = s3Error('NotFound', 404);
  assert.equal(await store.get('none'), undefined);
});

test('should pass on every other S3 error unchanged when a call fails', TIMEOUT, async () => {
  const s3 = double();
  const store = new S3ObjectStore({ client: s3, bucket: BUCKET });
  const denied = s3Error('AccessDenied', 403);
  for (const [m, call] of [
    ['getObject', () => store.get('k')], ['putObject', () => store.put('k', utf8('v'))],
    ['listObjectsV2', () => store.list('')], ['deleteObject', () => store.delete('k')],
  ] as const) {
    s3.fail[m] = denied;
    await assert.rejects(call(), (e) => e === denied, m);
  }
  assert.equal(await store.get('k'), undefined, 'the failed put wrote nothing');
});

test('should refuse with BAD_RESPONSE an answer without a body, a listing entry without key or time, and a truncated listing without a token', TIMEOUT, async () => {
  const s3 = double();
  const store = new S3ObjectStore({ client: s3, bucket: BUCKET });
  s3.getObject = async () => ({});
  assert.equal(await codeOf(store.get('k')), 'BAD_RESPONSE');
  s3.listObjectsV2 = async () => ({ Contents: [{ Key: 'a' }], IsTruncated: false });
  assert.equal(await codeOf(store.list('')), 'BAD_RESPONSE');
  s3.listObjectsV2 = async () => ({ Contents: [{ LastModified: new Date(T0) }], IsTruncated: false });
  assert.equal(await codeOf(store.list('')), 'BAD_RESPONSE');
  s3.listObjectsV2 = async () => ({ Contents: [], IsTruncated: true });
  assert.equal(await codeOf(store.list('')), 'BAD_RESPONSE');
});

test('should keep its own copy of the bytes when the caller changes the buffer after put', TIMEOUT, async () => {
  const store = new S3ObjectStore({ client: double(), bucket: BUCKET });
  const b = utf8('abc');
  await store.put('k', b);
  b[0] = 0x7a;
  assert.deepEqual(await store.get('k'), utf8('abc'));
});
