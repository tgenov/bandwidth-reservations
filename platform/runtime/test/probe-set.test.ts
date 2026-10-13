/** The probe-account set digest and the signed summary (C01 §2.7 ProbeSetSummary; RFC-006 §7.1; C08 S-M3). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hex, utf8 } from '../src/bytes.ts';
import {
  DevSummarySigner, probeSetDigest, probeSetSummaryBytes, signProbeSetSummary, sortProbeSet, verifyProbeSetSummary,
} from '../src/placement/probe-set.ts';

const T = { timeout: 5_000 };

test('should digest the probe set as SHA-256 over the sorted (slot int32 BE, account) pairs', T, () => {
  const set = [{ slot: 2, account: utf8('b') }, { slot: 0, account: utf8('zz') }, { slot: 2, account: utf8('a') }, { slot: 256, account: utf8('c') }];
  const want = createHash('sha256').update(Buffer.from('00000000' + '7a7a' + '00000002' + '61' + '00000002' + '62' + '00000100' + '63', 'hex')).digest();
  assert.equal(hex(probeSetDigest(set)), want.toString('hex'));
  assert.deepEqual(sortProbeSet(set).map((m) => [m.slot, Buffer.from(m.account).toString()]), [[0, 'zz'], [2, 'a'], [2, 'b'], [256, 'c']]);
  assert.equal(hex(probeSetDigest([])), createHash('sha256').digest('hex'));
});

test('should sign the domain tag, mapVersion int64 BE, slotCount int32 BE, probeAccountCount int32 BE and the digest', T, () => {
  const digest = new Uint8Array(32).fill(0xab);
  const b = probeSetSummaryBytes({ mapVersion: 0x0102030405060708n, slotCount: 0x10000, probeAccountCount: 7, setDigest: digest });
  assert.equal(hex(b), hex(utf8('placement.probe_set_summary.v1')) + '00' + '0102030405060708' + '00010000' + '00000007' + 'ab'.repeat(32));
});

test('should verify a summary signed by the dev signer and refuse it under another key', T, () => {
  const signer = new DevSummarySigner({ seed: new Uint8Array(32).fill(1), keyId: 'dev-1' });
  const other = new DevSummarySigner({ seed: new Uint8Array(32).fill(2) });
  const s = signProbeSetSummary(5n, 8, [{ slot: 0, account: utf8('p0') }], signer);
  assert.deepEqual({ v: s.mapVersion, n: s.slotCount, c: s.probeAccountCount, k: s.keyId }, { v: 5n, n: 8, c: 1, k: 'dev-1' });
  assert.equal(s.signature.byteLength, 64);
  assert.equal(verifyProbeSetSummary(s, signer.publicKey()), true);
  assert.equal(verifyProbeSetSummary(s, other.publicKey()), false);
  assert.equal(verifyProbeSetSummary(s, new Uint8Array(5)), false, 'a malformed key does not verify');
  assert.match(other.keyId, /^dev-ed25519-[0-9a-f]{16}$/);
  assert.deepEqual(new DevSummarySigner({ seed: new Uint8Array(32).fill(1) }).publicKey(), signer.publicKey(), 'the key is fixed by the seed');
});

test('should refuse a dev signer seed that is not 32 bytes', T, () => {
  assert.throws(() => new DevSummarySigner({ seed: new Uint8Array(31) }), { message: 'DevSummarySigner: the seed must be 32 bytes, not 31' });
});
