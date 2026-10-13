/**
 * S-PLAT-I3 work item 9: the protobuf codec of placement's integrity stop (C01 §2.6): field numbers, packed
 * fenced_slots, unknown fields and every decoder refusal code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8 } from '../src/bytes.ts';
import { hlc } from '../src/hlc.ts';
import type { ResumeRequest, StopAck, StopRequest } from '../src/placement/integrity-stop.ts';
import {
  IntegrityStopCodecError, decodeResumeRequest, decodeStopAck, decodeStopRequest, encodeResumeRequest, encodeStopAck, encodeStopRequest,
} from '../src/placement/integrity-stop-codec.ts';

const T = { timeout: 10_000 };
const TS0 = hlc('1800000000000000000.0000000000');
const stopReq: StopRequest = { kind: 'hlink', partition: utf8('link-7'), detectionRef: utf8('det-1') };
const resumeReq = (over: Partial<ResumeRequest> = {}): ResumeRequest => ({ ...stopReq, checkpoint: utf8('cp'), ...over });

test('should give back the same messages when requests and acks are encoded and decoded', T, () => {
  assert.deepEqual(decodeStopRequest(encodeStopRequest(stopReq)), stopReq);
  const full = resumeReq({ incidentDecisionRef: utf8('inc') });
  assert.deepEqual(decodeResumeRequest(encodeResumeRequest(full)), full);
  assert.deepEqual(decodeResumeRequest(encodeResumeRequest(resumeReq())), resumeReq());
  const ack: StopAck = { state: 'RESUMED', enforcedAt: hlc('1800000000000000000.0000000042'), fencedSlots: [0, 3, 2_147_483_647] };
  assert.deepEqual(decodeStopAck(encodeStopAck(ack)), ack);
  const none: StopAck = { state: 'STOPPED', enforcedAt: TS0, fencedSlots: [] };
  assert.deepEqual(decodeStopAck(encodeStopAck(none)), none);
});

test('should write the C01 §2.6 field numbers and a packed fenced_slots when an ack is encoded', T, () => {
  const bytes = encodeStopAck({ state: 'RESUMED', enforcedAt: hlc('1.0000000002'), fencedSlots: [1, 300] });
  const at = utf8('1.0000000002');
  assert.deepEqual([...bytes], [0x08, 1, 0x12, at.byteLength, ...at, 0x1a, 3, 1, 0xac, 0x02]);
  assert.deepEqual([...encodeStopRequest({ kind: 'k', partition: utf8('p'), detectionRef: utf8('d') })], [0x0a, 1, 0x6b, 0x12, 1, 0x70, 0x1a, 1, 0x64]);
});

test('should accept unpacked fenced_slots and skip unknown fields when an ack is decoded', T, () => {
  const at = utf8('5.0000000000');
  const bytes = new Uint8Array([0x12, at.byteLength, ...at, 0x18, 2, 0x18, 7, 0x7a, 1, 9]);
  assert.deepEqual(decodeStopAck(bytes), { state: 'STOPPED', enforcedAt: hlc('5'), fencedSlots: [2, 7] });
});

function codecCode(f: () => unknown): string {
  try { f(); } catch (e) { if (e instanceof IntegrityStopCodecError) return e.code; throw e; }
  return 'NO_ERROR';
}

test('should refuse with codec codes when a message does not decode', T, () => {
  const at = utf8('5.0000000000');
  assert.equal(codecCode(() => decodeStopRequest(new Uint8Array([0x0a, 5, 0x6b]))), 'TRUNCATED');
  assert.equal(codecCode(() => decodeStopRequest(new Uint8Array([0x0a]))), 'TRUNCATED');
  assert.equal(codecCode(() => decodeStopRequest(new Uint8Array([0x08, 1]))), 'MALFORMED');
  assert.equal(codecCode(() => decodeStopRequest(new Uint8Array([0x0a, 1, 0xff, 0x1a, 1, 0x64]))), 'MALFORMED');
  assert.equal(codecCode(() => decodeStopRequest(new Uint8Array([0x0b]))), 'MALFORMED');
  assert.equal(codecCode(() => decodeStopRequest(new Uint8Array(11).fill(0xff))), 'MALFORMED');
  assert.equal(codecCode(() => decodeStopRequest(new Uint8Array([0x7d, 1, 2]))), 'TRUNCATED');
  assert.equal(codecCode(() => decodeStopRequest(encodeStopRequest({ ...stopReq, kind: '' }))), 'MISSING_FIELD');
  assert.equal(codecCode(() => decodeResumeRequest(encodeResumeRequest(resumeReq({ detectionRef: new Uint8Array() })))), 'MISSING_FIELD');
  assert.equal(codecCode(() => decodeStopAck(new Uint8Array([0x08, 2, 0x12, at.byteLength, ...at]))), 'MALFORMED');
  assert.equal(codecCode(() => decodeStopAck(new Uint8Array([0x12, 3, 0x61, 0x62, 0x63]))), 'BAD_TS');
  assert.equal(codecCode(() => decodeStopAck(new Uint8Array([0x08, 0]))), 'BAD_TS');
  const minusOne = [0x18, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
  assert.equal(codecCode(() => decodeStopAck(new Uint8Array([0x12, at.byteLength, ...at, ...minusOne]))), 'MALFORMED');
  assert.throws(() => encodeStopAck({ state: 'STOPPED', enforcedAt: TS0, fencedSlots: [-1] }), RangeError);
});
