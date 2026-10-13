/** Key-certification stream (C08 §N) and the certificate rules of C08 §C, the I1 part of P-15. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CertStore, DOMAINS, b64url, generateKeyPair, signObject, type CertRequirement } from '@share/iam-lib';
import { DevKeyService } from '../src/index.ts';

function setup() {
  let now = 1_700_000_000_000_000n;
  const ks = new DevKeyService(() => now);
  const store = new CertStore(ks.rootPublicKey);
  const pair = generateKeyPair();
  const cert = ks.certify({ key_id: 'k1', purpose: 'identity_record', owner_kind: 'identity', slot: 3, epoch: '2', public_key: pair.publicKey });
  const sync = (): void => { for (const m of ks.read(store.head)) assert.ok(store.apply(m)); };
  sync();
  const obj = { identity_slot: 3, committed_at: now };
  const sig = { key_id: 'k1', sig: b64url(signObject(DOMAINS.edgeRecord, obj, pair.privateKey)) };
  const req: CertRequirement = { purpose: 'identity_record', owner_kind: 'identity', slot: 3, epoch: '2', validAt: { committed_at: now } };
  return { ks, store, cert, obj, sig, req, sync, advance: (us: bigint) => { now += us; }, now: () => now };
}

test('C08 P-15 (I1 part): a record verifies only under an unrevoked certificate of its slot, purpose and epoch', () => {
  const s = setup();
  assert.ok(s.store.verify(DOMAINS.edgeRecord, s.obj, s.sig, s.req, s.now()).ok);
  assert.deepEqual(s.store.verify(DOMAINS.edgeRecord, s.obj, s.sig, { ...s.req, slot: 4 }, s.now()), { ok: false, reason: 'wrong_slot' });
  assert.deepEqual(s.store.verify(DOMAINS.edgeRecord, s.obj, s.sig, { ...s.req, purpose: 'owner_summary' }, s.now()), { ok: false, reason: 'wrong_purpose' });
  assert.deepEqual(s.store.verify(DOMAINS.edgeRecord, s.obj, s.sig, { ...s.req, epoch: '1' }, s.now()), { ok: false, reason: 'wrong_epoch' });
  assert.deepEqual(s.store.verify(DOMAINS.keyRecord, s.obj, s.sig, s.req, s.now()), { ok: false, reason: 'bad_signature' }, 'domain separation');
  // Past not_after for an object checked at `now`.
  assert.deepEqual(s.store.verify(DOMAINS.edgeRecord, s.obj, s.sig, { ...s.req, validAt: { committed_at: s.cert.not_after + 1n } }, s.now()),
    { ok: false, reason: 'outside_validity' });
});

test('C08 P-15 (I1 part): after a revocation is applied, and after 30 s of cert-stream silence, every object is refused', () => {
  const s = setup();
  s.advance(31_000_000n);
  assert.deepEqual(s.store.verify(DOMAINS.edgeRecord, s.obj, s.sig, s.req, s.now()), { ok: false, reason: 'cert_stream_stale' });
  s.sync();
  assert.ok(s.store.verify(DOMAINS.edgeRecord, s.obj, s.sig, s.req, s.now()).ok);
  s.ks.revoke('k1', 'test');
  s.sync();
  assert.deepEqual(s.store.verify(DOMAINS.edgeRecord, s.obj, s.sig, s.req, s.now()), { ok: false, reason: 'revoked' });
});

test('cert stream: a message not signed by the certification root is refused and alerted', () => {
  const s = setup();
  const other = new DevKeyService(() => s.now());
  const forged = other.read('0').find((m) => 'heartbeat' in m);
  assert.ok(forged);
  assert.equal(s.store.apply(forged), false);
  assert.equal(s.store.alerts.length, 1);
});
