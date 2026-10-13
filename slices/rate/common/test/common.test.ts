import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESULTS, RuntimeDouble } from '@share/owner-runtime/testing';
import { utf8 } from '@share/owner-runtime';
import {
  FeedCursor, MemoryAlerts, addFraction, appendWithPolicy, emptyEla, floorDiv, lastMinuteEnd, minuteIso, usageCharge,
  serviceAudit,
} from '../src/index.ts';

const GB_PRICE_10000 = 10_000_000_000n; // 10,000 micro-USD per GB in pico-USD

test('POL-11 / RFC-003 §2: usage charge is ⌊price × X / 10^15⌋ with exact bigint arithmetic', () => {
  assert.equal(usageCharge(addFraction(emptyEla(), 1_000_000_000n, 1n), GB_PRICE_10000), 10_000n); // P3-S25
  assert.equal(usageCharge(addFraction(emptyEla(), 150_000n, 1n), GB_PRICE_10000), 1n); // 1.5 → 1 (P3-S21)
  assert.equal(usageCharge(addFraction(emptyEla(), 99_999n, 1n), GB_PRICE_10000), 0n); // 0.99999 → 0 (P3-S21)
  // 3 GB × 40/70 at 10,000: 17,142.857… → 17,142 (P3-S51)
  assert.equal(usageCharge(addFraction(emptyEla(), 3_000_000_000n * 40n, 70n), GB_PRICE_10000), 17_142n);
});

test('ELA: the result does not depend on the order of the adds, and negated parts cancel (P3-N3)', () => {
  const parts: Array<[bigint, bigint]> = [[1_000n * 7n, 13n], [5n, 3n], [-2_000n, 7n], [999n, 1n], [11n, 120_000n]];
  const a = parts.reduce((e, [n, d]) => addFraction(e, n, d), emptyEla());
  const b = [...parts].reverse().reduce((e, [n, d]) => addFraction(e, n, d), emptyEla());
  assert.deepEqual(a, b);
  const c = parts.reduce((e, [n, d]) => addFraction(addFraction(e, n, d), -n, d), emptyEla());
  assert.deepEqual(c, emptyEla());
  assert.equal(floorDiv(-7n, 2n), -4n);
});

test('time: minutes are half-open and C06 Minute form', () => {
  assert.equal(minuteIso(Date.parse('2026-10-12T12:30:00Z')), '2026-10-12T12:30:00Z');
  assert.equal(lastMinuteEnd(Date.parse('2026-10-12T10:00:00Z'), Date.parse('2026-10-12T10:02:00Z')), Date.parse('2026-10-12T10:02:00Z'));
  assert.equal(lastMinuteEnd(Date.parse('2026-10-12T10:00:10Z'), Date.parse('2026-10-12T10:00:10Z')), Date.parse('2026-10-12T10:01:00Z'));
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
