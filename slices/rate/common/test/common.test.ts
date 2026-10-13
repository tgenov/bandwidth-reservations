import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESULTS, RuntimeDouble } from '@share/owner-runtime/testing';
import { utf8 } from '@share/owner-runtime';
import {
  FeedCursor, MemoryAlerts, addFraction, appendWithPolicy, canonicalSourceRefBytes, checkChargeLineBatch, elaFromJson,
  elaToJson, emptyEla, floorDiv, lastMinuteEnd, minuteIso, parseMinute, usageCharge, serviceAudit,
  type ChargeLineBatch, type SourceRef,
} from '../src/index.ts';

const GB_PRICE_10000 = 10_000_000_000n; // 10,000 micro-USD per GB in pico-USD

test('should compute the usage charge as ⌊price × X / 10^15⌋ with exact bigint arithmetic (POL-11 / RFC-003 §2) when charging', () => {
  assert.equal(usageCharge(addFraction(emptyEla(), 1_000_000_000n, 1n), GB_PRICE_10000), 10_000n);
  assert.equal(usageCharge(addFraction(emptyEla(), 150_000n, 1n), GB_PRICE_10000), 1n);
  assert.equal(usageCharge(addFraction(emptyEla(), 99_999n, 1n), GB_PRICE_10000), 0n);
  assert.equal(usageCharge(addFraction(emptyEla(), 3_000_000_000n * 40n, 70n), GB_PRICE_10000), 17_142n);
});

test('should not depend on the order of the adds, and cancel negated parts (P3-N3), when the ELA adds', () => {
  const parts: Array<[bigint, bigint]> = [[1_000n * 7n, 13n], [5n, 3n], [-2_000n, 7n], [999n, 1n], [11n, 120_000n]];
  const a = parts.reduce((e, [n, d]) => addFraction(e, n, d), emptyEla());
  const b = [...parts].reverse().reduce((e, [n, d]) => addFraction(e, n, d), emptyEla());
  assert.deepEqual(a, b);
  const c = parts.reduce((e, [n, d]) => addFraction(addFraction(e, n, d), -n, d), emptyEla());
  assert.deepEqual(c, emptyEla());
  assert.equal(floorDiv(-7n, 2n), -4n);
});

test('should make minutes half-open and in C06 Minute form when converting time', () => {
  assert.equal(minuteIso(Date.parse('2026-10-12T12:30:00Z')), '2026-10-12T12:30:00Z');
  assert.equal(lastMinuteEnd(Date.parse('2026-10-12T10:00:00Z'), Date.parse('2026-10-12T10:02:00Z')), Date.parse('2026-10-12T10:02:00Z'));
  assert.equal(lastMinuteEnd(Date.parse('2026-10-12T10:00:10Z'), Date.parse('2026-10-12T10:00:10Z')), Date.parse('2026-10-12T10:01:00Z'));
  // e = s on a minute start: the record was active in that minute, so its last minute ends 60 s later.
  assert.equal(lastMinuteEnd(Date.parse('2026-10-12T12:05:00Z'), Date.parse('2026-10-12T12:05:00Z')), Date.parse('2026-10-12T12:06:00Z'));
});

test('should refuse a time that is not a minute start, and a string that is not a C06 Minute, when converting minutes', () => {
  assert.throws(() => minuteIso(Date.parse('2026-10-12T12:05:01Z')), { message: `${Date.parse('2026-10-12T12:05:01Z')} is not a minute start` });
  assert.throws(() => parseMinute('2026-10-12T12:05:30Z'), { message: 'not a C06 Minute: 2026-10-12T12:05:30Z' });
  assert.equal(parseMinute('2026-10-12T12:05:00Z'), Date.parse('2026-10-12T12:05:00Z'));
});

test('should refuse a denominator or a divisor that is not positive when the ELA adds or floors', () => {
  for (const d of [0n, -7n]) assert.throws(() => addFraction(emptyEla(), 1n, d), { message: 'ELA: the denominator must be positive' });
  for (const d of [0n, -2n]) assert.throws(() => floorDiv(7n, d), { message: 'floorDiv: the divisor must be positive' });
  assert.equal(floorDiv(7n, 1n), 7n);
});

test('should write the ELA entries in increasing denominator order and read the same accumulator back when saving it', () => {
  // Denominators above 2^32 − 2 are not array-index keys, so only the sort puts them in order.
  const e = [[1n, 4_294_967_357n], [1n, 4_294_967_377n], [2n, 4_294_967_311n], [1n, 4_294_967_371n], [1n, 3n], [10n, 1n]]
    .reduce((acc, [n, d]) => addFraction(acc, n as bigint, d as bigint), emptyEla());
  assert.deepEqual(Object.keys(elaToJson(e).r), ['3', '4294967311', '4294967357', '4294967371', '4294967377']);
  assert.deepEqual(elaToJson(e), { S: '10', r: { 3: '1', 4294967311: '2', 4294967357: '1', 4294967371: '1', 4294967377: '1' } });
  assert.deepEqual(elaFromJson(elaToJson(e)), e);
});

const REF: SourceRef = { kind: 'usage', account: 'a1', product: 'p1', route: 'r1', minute: '2026-10-12T12:05:00Z', seq: 0 };

function batchWithMinute(minute: string): ChargeLineBatch {
  return {
    type: 'ChargeLineBatch', schemaVersion: 1,
    eventId: { partition: 'a1', stream: 'charges', streamSeq: '1', generation: 0, epoch: 1 },
    batch: { id: 'a1:0:1:0', kind: 'usage', account: 'a1', gated: true, lineCount: 1 },
    lines: [{ sourceRef: REF, lineKind: 'usage', account: 'a1', product: 'p1', route: 'r1', weightsVersion: 'w1', minute,
      payer: 'account', amount: '1', newTotal: '1', priorTotal: '0', reason: 'original', reasonDetails: { priceVersion: 'pv1' },
      priceCatalogue: { resolvedTs: '1.0000000000' } }],
    emittedAt: '2.0000000000',
  };
}

test('C06 CT-R1 should refuse a line and a SourceRef whose minute is not a C06 Minute', () => {
  assert.deepEqual(checkChargeLineBatch(batchWithMinute('2026-10-12T12:05:00Z')), []);
  for (const v of ['2026-10-12T12:05:30Z', 'x2026-10-12T12:05:00Z', '2026-10-12T12:05:00Zx', '2026-13-45T12:05:00Z']) {
    assert.deepEqual(checkChargeLineBatch(batchWithMinute(v)), ['lines[0].minute', 'lines[0]: the usage SourceRef does not agree with the line'], v);
    assert.throws(() => canonicalSourceRefBytes({ ...REF, minute: v }), { message: `SourceRef.minute is not a Minute: ${v}` });
  }
});

test('C01 CC-1: every AppendResult gets the caller action of C01 §3.2, with the same identities', async () => {
  const rt = new RuntimeDouble({ slotCount: 16 });
  const alerts = new MemoryAlerts();
  const sleep = async (): Promise<void> => {};
  const call = { partition: utf8('p'), entries: [{ kind: 1, schemaV: 1, identity: utf8('id-1'), audit: serviceAudit('t'), payload: {} }] };
  const policy = { owner: 't', alerts, sleep };
  rt.scriptAppend(RESULTS.Retry(), RESULTS.Ambiguous(), RESULTS.Moving(), RESULTS.Overloaded(1), RESULTS.Unknown());
  const ok = await appendWithPolicy(rt, call, undefined, { ...policy, attempts: 6 });
  assert.equal(ok.ok, true);
  assert.ok(rt.appends.every((a) => a.call === call), 'each retry has the same identities');
  assert.equal(alerts.of('UNKNOWN_APPEND_RESULT').length, 1);
  rt.scriptAppend(RESULTS.ConditionFailed('x'));
  assert.deepEqual(await appendWithPolicy(rt, call, undefined, policy), { ok: false, why: 'conditionFailed', which: 'x' });
  rt.scriptAppend(RESULTS.Stopped());
  assert.deepEqual(await appendWithPolicy(rt, call, undefined, policy), { ok: false, why: 'stopped' });
  rt.scriptAppend(RESULTS.StaleEpoch());
  assert.equal((await appendWithPolicy(rt, call, undefined, policy)).ok, false);
  rt.scriptAppend(RESULTS.Moved(3, 2));
  const moved = await appendWithPolicy(rt, call, undefined, policy);
  assert.ok(!moved.ok && moved.why === 'notOwner');
  rt.scriptAppend(RESULTS.Retry(), RESULTS.Retry());
  const gaveUp = await appendWithPolicy(rt, call, undefined, { ...policy, attempts: 2 });
  assert.ok(!gaveUp.ok && gaveUp.why === 'notKnownCommitted');
});

test('C01 CC-6: the feed cursor applies in order, drops repeats, waits on gaps, and blocks on a content conflict', () => {
  const c = new FeedCursor<string>();
  assert.deepEqual(c.offer('k', 2n, 'b', 'd2'), []);
  const r = c.offer('k', 1n, 'a', 'd1');
  assert.deepEqual(r.map((x) => x.item), ['a', 'b']);
  for (const x of r) c.commit('k', x.seq, x.digest);
  assert.deepEqual(c.offer('k', 1n, 'a', 'd1'), []);
  assert.equal(c.isBlocked('k'), false);
  assert.deepEqual(c.offer('k', 2n, 'B', 'other'), []);
  assert.equal(c.isBlocked('k'), true);
});
