/**
 * S-LINK I4 validity tests (exit criteria 1 to 3): T-05, the scenarios P1-S18, P1-S19, P1-S20 and P1-S74, and
 * the `Policy(version, parameters)` entry (RFC-001 §2, §4.1 check (4), §7.3). The account owner is the
 * recorded stub. Capacity 10 Mbps. The stub's clock starts at 09:00 on 2 March 2026 unless a test sets it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hlcToWallMs, utf8 } from '@share/owner-runtime';
import type { RuntimeDouble } from '@share/owner-runtime/testing';
import { DEFAULT_POLICY, ENTRY, LinkOwner, requestKey, type HoldReply, type LinkPolicy, type WaitingNotification } from '../src/index.ts';
import { AccountStub, doubleLogReader, harness, M, resultOf } from './support.ts';

const NOW = M(9);
/** The selling horizon of a request received at 09:00 on 2 March 2026: 09:00 on 2 March 2027. */
const H = Date.UTC(2027, 2, 2, 9) / 60_000;
const minuteOf = (y: number, mo: number, d: number, hh: number, mm: number): number => Date.UTC(y, mo - 1, d, hh, mm) / 60_000;
const logLength = (h: Awaited<ReturnType<typeof harness>>): number => h.rt.log(utf8(h.link)).length;
/** The reply to a deployment without the link stamp. */
async function deploy(h: Awaited<ReturnType<typeof harness>>, p: LinkPolicy, link = h.link): Promise<unknown> {
  const { linkFence: _f, linkSeq: _s, ...rest } = await h.owner.deployPolicy(link, p) as unknown as Record<string, unknown>;
  return rest;
}

async function confirmedAt(h: Awaited<ReturnType<typeof harness>>, rate: number, start: number, end: number | null): Promise<string> {
  const b = await h.stub.book({ rate, window: { start, end } });
  return b.convert ? resultOf(b.convert) : resultOf(b.hold);
}

// ---------------- P1-S19: a malformed request is invalid ----------------

const S19: Array<[number, number, number | null, string, string]> = [
  [8, NOW + 60, NOW + 60, 'V3', 'empty'],
  [8, NOW + 120, NOW + 60, 'V3', 'backwards'],
  [8, NOW - 1, NOW + 60, 'V4', 'starts before the current minute'],
  [8, NOW + 60.5, NOW + 120, 'V2', 'starts off a minute boundary'],
  [8, NOW + 60, NOW + 120.5, 'V2', 'ends off a minute boundary'],
  [8, H, H + 60, 'V5', 'starts at the end of the selling horizon'],
  [8, H - 10, H + 10, 'V6', 'ends beyond the selling horizon'],
  [8, H + 5, null, 'V5', 'open-ended, starting beyond the horizon'],
  [0, NOW + 60, NOW + 120, 'V1', 'a rate below rate_min'],
  [-1, NOW + 60, NOW + 120, 'V1', 'a negative rate'],
  [1.5, NOW + 60, NOW + 120, 'V1', 'a rate that is not a whole number of Mbps'],
];

for (const [rate, start, end, rule, label] of S19) {
  test(`P1-S19 a malformed request is invalid, not a capacity answer, and holds no capacity: ${label}`, async () => {
    const h = await harness();
    const cmd = h.stub.holdCmd({ rate, window: { start, end } });
    const r = await h.stub.hold(cmd);
    assert.deepEqual({ ...r, linkFence: undefined, linkSeq: undefined },
      { result: 'REFUSED', reason: { invalid: rule }, linkFence: undefined, linkSeq: undefined });
    assert.equal(h.owner.stateOf(h.link)?.holdsInOrder().length, 0, 'no hold');
    assert.equal(h.owner.stateOf(h.link)?.occAll.size, 0, 'no capacity held');
    assert.deepEqual(h.owner.stateOf(h.link)?.recordState(cmd.request),
      { state: 'REFUSED', madeBy: 'hold', tombstoneUntil: cmd.deadline + 60_000 }, 'a refusal records a tombstone');
    assert.deepEqual(await h.stub.hold(cmd), r, 'a repeat gets the recorded refusal');
  });
}

// ---------------- P1-S20: the edge of what is sold is valid ----------------

for (const [rate, start, end, label] of [
  [8, NOW, NOW + 60, 'starts in the current minute'],
  [8, H - 10, H, 'ends exactly at the selling horizon'],
  [2, H - 1, null, 'open-ended from the last sellable minute'],
] as Array<[number, number, number | null, string]>) {
  test(`P1-S20 a window that reaches the edge of what is sold is valid: ${label}`, async () => {
    const h = await harness();
    assert.equal(await confirmedAt(h, rate, start, end), 'CONVERTED');
  });
}

// ---------------- P1-S74: calendar months in UTC from the minute of receipt ----------------

for (const [receivedMs, end, outcome, label] of [
  [Date.UTC(2026, 2, 31, 10, 0, 20), minuteOf(2027, 3, 31, 10, 0), 'CONVERTED', 'ends at the selling horizon from 10:00'],
  [Date.UTC(2026, 2, 31, 10, 0, 20), minuteOf(2027, 3, 31, 10, 1), 'REFUSED:{"invalid":"V6"}', 'ends one minute beyond it'],
  [Date.UTC(2028, 1, 29, 10, 0, 20), minuteOf(2029, 2, 28, 10, 0), 'CONVERTED', '2029 has no 29 February: the horizon ends on the last day of that month'],
  [Date.UTC(2028, 1, 29, 10, 0, 20), minuteOf(2029, 2, 28, 10, 1), 'REFUSED:{"invalid":"V6"}', 'ends one minute beyond the clamped horizon'],
] as Array<[number, number, string, string]>) {
  test(`P1-S74 the selling horizon is measured in calendar months, in UTC, from the minute of receipt: ${label}`, async () => {
    const h = await harness({ startMs: receivedMs });
    const eleven = Math.floor(receivedMs / 3_600_000) * 60 + 60;
    assert.equal(await confirmedAt(h, 2, eleven, end), outcome);
  });
}

// ---------------- P1-S18: a request that was not confirmed leaves the link as if never made ----------------

test('P1-S18 a request that was not confirmed leaves the link as if it had never been made: rejected for insufficient funds', async () => {
  const h = await harness();
  // The account owner rejects it before E1, so no hold reaches the link. It releases every leg (RFC-002).
  const r = h.stub.holdCmd({ rate: 4, window: { start: M(10), end: M(11) } });
  assert.equal(resultOf(await h.stub.release(h.stub.releaseCmd(r.request, r.deadline, 'REJECTED'))), 'RELEASED');
  assert.equal(await confirmedAt(h, 10, M(10), M(11)), 'CONVERTED');
});

test('P1-S18 a request that was not confirmed leaves the link as if it had never been made: failed', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 4, window: { start: M(10), end: M(11) } });
  assert.equal(resultOf(await h.stub.hold(r)), 'HELD');
  assert.equal(resultOf(await h.stub.release(h.stub.releaseCmd(r.request, r.deadline, 'FAILED'))), 'RELEASED');
  assert.equal(await confirmedAt(h, 10, M(10), M(11)), 'CONVERTED');
});

test('P1-S18 a request that was not confirmed leaves the link as if it had never been made: invalid', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 4, window: { start: M(10), end: H + 60 } });
  assert.equal(resultOf(await h.stub.hold(r)), 'REFUSED:{"invalid":"V6"}');
  assert.equal(await confirmedAt(h, 10, M(10), M(11)), 'CONVERTED');
});

// ---------------- T-05: judged on the carried receipt minute ----------------

test('T-05 a hold that reaches the link one minute boundary after receipt is judged on its receipt minute', async () => {
  const h = await harness({ startMs: Date.UTC(2026, 2, 31, 10, 0, 20) });
  const m0 = minuteOf(2026, 3, 31, 10, 0);
  const atReceipt = h.stub.holdCmd({ rate: 2, window: { start: m0, end: m0 + 60 }, deadlineInMs: 120_000 });
  const toHorizon = h.stub.holdCmd({ rate: 2, window: { start: m0 + 60, end: minuteOf(2027, 3, 31, 10, 0) }, deadlineInMs: 120_000 });
  const pastHorizon = h.stub.holdCmd({ rate: 2, window: { start: m0 + 60, end: minuteOf(2027, 3, 31, 10, 1) }, deadlineInMs: 120_000 });
  h.rt.advance(60_000);   // the link's present minute is now 10:01
  assert.equal(resultOf(await h.stub.hold(atReceipt)), 'HELD', 's = m0 is valid, although s is before the link\'s present minute');
  assert.equal(resultOf(await h.stub.hold(toHorizon)), 'HELD');
  assert.equal(resultOf(await h.stub.hold(pastHorizon)), 'REFUSED:{"invalid":"V6"}', 'H comes from m0, not from the link\'s present minute');
  const fresh = h.stub.holdCmd({ rate: 2, window: { start: m0, end: m0 + 60 } });
  assert.equal(resultOf(await h.stub.hold(fresh)), 'REFUSED:{"invalid":"V4"}', 'received at 10:01, so 10:00 is before its receipt minute');
});

test('T-05 a request received at hh:mm:59.98 whose intake commits after the boundary is valid from hh:mm', async () => {
  const receivedMs = Date.UTC(2026, 2, 31, 10, 0, 59, 980);
  const h = await harness({ startMs: receivedMs });
  const m0 = minuteOf(2026, 3, 31, 10, 0);
  const cmd = h.stub.holdCmd({ rate: 2, window: { start: m0, end: m0 + 30 } });
  assert.equal(cmd.receiptMinute, m0);
  h.rt.advance(30);   // the intake entry commits at 10:01:00.010: request_age is after the boundary
  cmd.requestAge = h.rt.now().ts;
  assert.equal(Math.floor(hlcToWallMs(cmd.requestAge) / 60_000), m0 + 1);
  assert.equal(resultOf(await h.stub.hold(cmd)), 'HELD');
  const before = h.stub.holdCmd({ rate: 2, window: { start: m0 - 1, end: m0 + 30 } });
  before.receiptMinute = m0;
  assert.equal(resultOf(await h.stub.hold(before)), 'REFUSED:{"invalid":"V4"}');
});

test('T-05 the rules are checked in the order V1 … V6, and the first rule that fails is the reason', async () => {
  const h = await harness();
  const cases: Array<[number, number, number | null, string]> = [
    [0, H + 60.5, H, 'V1'],          // fails V1, V2, V3, V5, V6
    [8, H + 60.5, H, 'V2'],          // fails V2, V3, V5, V6
    [8, NOW - 10, NOW - 20, 'V3'],   // fails V3, V4
    [8, NOW - 10, H + 10, 'V4'],     // fails V4, V6
    [8, H + 1, H + 10, 'V5'],        // fails V5, V6
  ];
  for (const [rate, start, end, rule] of cases) {
    assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate, window: { start, end } }))), `REFUSED:{"invalid":"${rule}"}`, `${rate} [${start}, ${end})`);
  }
});

test('T-05 a receipt minute that is not a whole minute fails V4', async () => {
  const h = await harness();
  const cmd = h.stub.holdCmd({ rate: 2, window: { start: NOW + 60, end: NOW + 120 } });
  cmd.receiptMinute = NOW + 0.5;
  assert.equal(resultOf(await h.stub.hold(cmd)), 'REFUSED:{"invalid":"V4"}');
});

test('T-05 a receipt minute beyond the date range fails V5', async () => {
  const h = await harness();
  const m0 = 2 ** 52;
  const cmd = h.stub.holdCmd({ rate: 2, window: { start: m0, end: m0 + 60 } });
  cmd.receiptMinute = m0;
  assert.equal(resultOf(await h.stub.hold(cmd)), 'REFUSED:{"invalid":"V5"}');
});

test('T-05 a refusal for no fit is decided only after validity: an invalid request that also does not fit is INVALID', async () => {
  const h = await harness();
  assert.equal(await confirmedAt(h, 10, NOW, H), 'CONVERTED');
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 1, window: { start: H - 10, end: H + 10 } }))), 'REFUSED:{"invalid":"V6"}');
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 1, window: { start: H - 10, end: H } }))), 'REFUSED:"NO_FIT"');
});

test('T-05 a refusal at ts ≥ D_c comes before validity', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 0, window: { start: NOW - 1, end: NOW }, deadlineInMs: 400 });
  assert.equal(resultOf(await h.stub.hold(r)), 'REFUSED:"DEADLINE_PASSED"');
});

test('should refuse DEADLINE_PASSED before UNAVAILABLE when a hold with an unapplied version comes at or after D_c', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 2, window: { start: M(10), end: M(11) }, policyVersion: 9n, deadlineInMs: 400 });
  assert.equal(resultOf(await h.stub.hold(r)), 'REFUSED:"DEADLINE_PASSED"');
});

test('should answer MISMATCH, not UNAVAILABLE, when a repeat of a recorded hold carries an unapplied version', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 2, window: { start: M(10), end: M(11) } });
  assert.equal(resultOf(await h.stub.hold(r)), 'HELD');
  assert.deepEqual(await h.stub.hold({ ...r, policyVersion: 9n }), { code: 'MISMATCH' });
});

// ---------------- exit criterion 3: the Policy entry and the policy version ----------------

const V2: LinkPolicy = { ...DEFAULT_POLICY, version: '2', rateMinMbps: 2, sellingHorizonMonths: 6 };
/** Six calendar months after 09:00 on 2 March 2026. */
const H6 = Date.UTC(2026, 8, 2, 9) / 60_000;

test('should answer UNAVAILABLE and write no log entry when a hold carries a policy version that the link has not applied', async () => {
  const h = await harness();
  const before = logLength(h);
  const cmd = h.stub.holdCmd({ rate: 2, window: { start: M(10), end: M(11) }, policyVersion: 2n });
  assert.deepEqual(await h.stub.hold(cmd), { code: 'UNAVAILABLE' });
  assert.equal(logLength(h), before, 'no entry');
  assert.equal(h.owner.stateOf(h.link)?.recordState(cmd.request), undefined, 'no record, no tombstone');
  assert.equal(h.owner.stateOf(h.link)?.occAll.size, 0, 'nothing held');
  // The account owner sends the hold again once the link has applied the version.
  assert.deepEqual(await deploy(h, V2), { result: 'POLICY_APPLIED', version: '2' });
  assert.equal(resultOf(await h.stub.hold(cmd)), 'HELD');
});

test('should answer UNAVAILABLE in a batch with other holds and write entries for the other holds only', async () => {
  const h = await harness();
  const before = logLength(h);
  const unknown = h.stub.holdCmd({ rate: 2, window: { start: M(10), end: M(11) }, policyVersion: 7n, account: 'u' });
  const known = h.stub.holdCmd({ rate: 2, window: { start: M(10), end: M(11) }, account: 'k' });
  const [ru, rk] = await Promise.all([h.stub.hold(unknown), h.stub.hold(known)]);
  assert.deepEqual(ru, { code: 'UNAVAILABLE' });
  assert.equal(resultOf(rk), 'HELD');
  const added = h.rt.log(utf8(h.link)).slice(before);
  assert.deepEqual(added.map((e) => e.entry.kind), [ENTRY.Hold]);
});

test('should write one Policy entry and judge each hold by the rules of the policy version that it carries', async () => {
  const h = await harness();
  const before = logLength(h);
  assert.deepEqual(await deploy(h, V2), { result: 'POLICY_APPLIED', version: '2' });
  const added = h.rt.log(utf8(h.link)).slice(before);
  assert.deepEqual(added.map((e) => e.entry.kind), [ENTRY.Policy]);
  assert.deepEqual((added[0]?.entry.payload as { policy: unknown }).policy, V2);
  const w = { start: M(10), end: M(11) };
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 1, window: w, policyVersion: 1n }))), 'HELD', 'version 1 keeps rate_min 1');
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 1, window: w, policyVersion: 2n }))), 'REFUSED:{"invalid":"V1"}', 'version 2 has rate_min 2');
  const long = { start: M(12), end: H6 + 1 };
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 2, window: long, policyVersion: 2n }))), 'REFUSED:{"invalid":"V6"}', 'version 2 sells 6 months');
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 2, window: { start: M(12), end: H6 }, policyVersion: 2n }))), 'HELD');
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 2, window: long, policyVersion: 1n }))), 'HELD', 'version 1 sells 12 months');
});

test('should give the counter-offer within the horizon of the policy version that the hold carries', async () => {
  const h = await harness();
  await deploy(h, V2);
  assert.equal(await confirmedAt(h, 10, M(10), H6 - 30), 'CONVERTED');
  const w = { start: M(10), end: M(11) };
  const v2 = await h.stub.hold(h.stub.holdCmd({ rate: 2, window: w, policyVersion: 2n })) as HoldReply & { counterOffer?: unknown };
  assert.deepEqual(v2.counterOffer, { largestRateMbps: 0, earliest: { none: true } }, 'the first free hour ends after the 6-month horizon');
  const v1 = await h.stub.hold(h.stub.holdCmd({ rate: 2, window: w, policyVersion: 1n })) as HoldReply & { counterOffer?: unknown };
  assert.deepEqual(v1.counterOffer, { largestRateMbps: 0, earliest: { window: { start: H6 - 30, end: H6 + 30 } } });
});

test('should give the counter-offer largest rate by rate_min of the policy version that the hold carries', async () => {
  const h = await harness();
  await deploy(h, V2);
  const w = { start: M(10), end: M(11) };
  assert.equal(await confirmedAt(h, 9, w.start, w.end), 'CONVERTED');
  const v1 = await h.stub.hold(h.stub.holdCmd({ rate: 5, window: w, policyVersion: 1n })) as HoldReply & { counterOffer?: { largestRateMbps: number } };
  assert.equal(resultOf(v1), 'REFUSED:"NO_FIT"');
  assert.equal(v1.counterOffer?.largestRateMbps, 1, 'version 1 has rate_min 1: 1 Mbps is free');
  const v2 = await h.stub.hold(h.stub.holdCmd({ rate: 5, window: w, policyVersion: 2n })) as HoldReply & { counterOffer?: { largestRateMbps: number } };
  assert.equal(resultOf(v2), 'REFUSED:"NO_FIT"');
  assert.equal(v2.counterOffer?.largestRateMbps, 0, 'version 2 has rate_min 2: 1 Mbps is below it');
});

test('should keep every applied version: a version deployed after a newer one is kept and does not become the current policy', async () => {
  const h = await harness();
  const v3: LinkPolicy = { ...DEFAULT_POLICY, version: '3', releaseGraceMs: 120_000 };
  assert.deepEqual(await deploy(h, v3), { result: 'POLICY_APPLIED', version: '3' });
  assert.deepEqual(await deploy(h, V2), { result: 'POLICY_APPLIED', version: '2' });
  assert.equal(h.owner.stateOf(h.link)?.policy.version, '3');
  for (const v of [1n, 2n, 3n]) {
    assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 2, window: { start: M(10), end: M(10, 1) }, policyVersion: v, account: `v${v}` }))), 'HELD');
  }
  // The current policy (version 3) gives the parameters of the link from its entry: release_grace 2 min.
  const r = h.stub.holdCmd({ rate: 2, window: { start: M(12), end: M(13) }, policyVersion: 1n });
  assert.equal(resultOf(await h.stub.hold(r)), 'HELD');
  const rel = await h.stub.release(h.stub.releaseCmd(r.request, r.deadline));
  assert.equal((rel as { tombstoneUntil?: number }).tombstoneUntil, r.deadline + 120_000);
});

test('should answer a repeated deployment of an applied version with POLICY_APPLIED and write nothing', async () => {
  const h = await harness();
  await deploy(h, V2);
  const before = logLength(h);
  assert.deepEqual(await deploy(h, { ...V2 }), { result: 'POLICY_APPLIED', version: '2' });
  assert.deepEqual(await deploy(h, DEFAULT_POLICY), { result: 'POLICY_APPLIED', version: '1' }, 'the Init policy is version 1');
  assert.equal(logLength(h), before);
  assert.deepEqual(h.owner.alerts, []);
});

test('should refuse a deployment of an applied version with other parameters (MISMATCH, alerted) and keep the first', async () => {
  const h = await harness();
  await deploy(h, V2);
  const before = logLength(h);
  assert.deepEqual(await deploy(h, { ...V2, rateMinMbps: 1 }), { code: 'MISMATCH' });
  assert.equal(logLength(h), before);
  assert.deepEqual(h.owner.alerts.map((a) => a.kind), ['POLICY_MISMATCH']);
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 1, window: { start: M(10), end: M(11) }, policyVersion: 2n }))), 'REFUSED:{"invalid":"V1"}');
});

test('should refuse a malformed policy (INVALID_POLICY, alerted) and write nothing', async () => {
  const h = await harness();
  const before = logLength(h);
  const bad: Array<Partial<LinkPolicy>> = [
    { version: '' }, { version: '0' }, { version: '01' }, { version: '2a' },
    { rateMinMbps: 0 }, { rateMinMbps: 1.5 }, { sellingHorizonMonths: 0 }, { counterofferSteps: 0 },
    { counterofferBatchSteps: -1 }, { counterofferBatchSteps: 0 }, { releaseGraceMs: -1 }, { requestRecordTtlMs: 0.5 },
    { requestRecordTtlMs: 0 }, { version: 5 as unknown as string }, { scanSteps: 0 },
  ];
  for (const b of bad) {
    assert.deepEqual(await deploy(h, { ...DEFAULT_POLICY, version: '5', ...b }), { code: 'INVALID_POLICY' }, JSON.stringify(b));
  }
  assert.equal(logLength(h), before);
  assert.equal(h.owner.alerts.filter((a) => a.kind === 'INVALID_POLICY').length, bad.length);
  assert.deepEqual(await h.stub.hold(h.stub.holdCmd({ rate: 2, window: { start: M(10), end: M(11) }, policyVersion: 5n })), { code: 'UNAVAILABLE' });
});

test('should apply a policy with every parameter at its lower bound', async () => {
  const h = await harness();
  const low: LinkPolicy = {
    version: '6', releaseGraceMs: 0, requestRecordTtlMs: 1, rateMinMbps: 1, sellingHorizonMonths: 1, counterofferSteps: 1, counterofferBatchSteps: 1,
    scanSteps: 1,
  };
  assert.deepEqual(await deploy(h, low), { result: 'POLICY_APPLIED', version: '6' });
  assert.deepEqual(h.owner.alerts, []);
});

test('should answer UNKNOWN_LINK to a deployment for a link that is not registered, and write and alert nothing', async () => {
  const h = await harness();
  assert.deepEqual(await deploy(h, V2, 'L-none'), { code: 'UNKNOWN_LINK' });
  assert.equal(h.rt.log(utf8('L-none')).length, 0);
  assert.deepEqual(h.owner.alerts, []);
});

test('should compare policy versions as numbers: version 10 is newer than version 9', async () => {
  const h = await harness();
  await deploy(h, { ...DEFAULT_POLICY, version: '9' });
  await deploy(h, { ...DEFAULT_POLICY, version: '10' });
  assert.equal(h.owner.stateOf(h.link)?.policy.version, '10');
});

test('should keep the deployed policy when the caller changes its object after the deployment', async () => {
  const h = await harness();
  const p: LinkPolicy = { ...V2 };
  await deploy(h, p);
  p.rateMinMbps = 1;
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 1, window: { start: M(10), end: M(11) }, policyVersion: 2n }))), 'REFUSED:{"invalid":"V1"}');
});

test('should record the reply to a deployment as policy:<link>', async () => {
  const h = await harness();
  await deploy(h, V2);
  assert.ok(h.rt.trace.some((t) => t.t === 'reply' && t.label === `policy:${h.link}`));
});

test('should rebuild every policy version by replay of the Policy entries, with no outcome difference', async () => {
  const h = await harness();
  await deploy(h, V2);
  const v2Refused = h.stub.holdCmd({ rate: 1, window: { start: M(10), end: M(11) }, policyVersion: 2n });
  assert.equal(resultOf(await h.stub.hold(v2Refused)), 'REFUSED:{"invalid":"V1"}');
  const slot = h.rt.route('link', utf8(h.link)).slot;
  const rt = h.rt as RuntimeDouble;
  rt.release(slot, 'taken');
  const owner2 = new LinkOwner(rt, { readLog: doubleLogReader(rt), links: [h.link], onReply: (l) => rt.recordReply(l) });
  rt.attach(owner2);
  await rt.acquire(slot);
  assert.deepEqual(owner2.alerts, [], 'no outcome difference');
  assert.equal(owner2.stateOf(h.link)?.policy.version, '2');
  const stub2 = new AccountStub(rt, owner2, h.link);
  assert.equal(resultOf(await stub2.hold(v2Refused)), 'REFUSED:{"invalid":"V1"}');
  assert.equal(resultOf(await stub2.hold(stub2.holdCmd({ rate: 1, window: { start: M(10), end: M(11) }, policyVersion: 2n }))), 'REFUSED:{"invalid":"V1"}');
  assert.equal(resultOf(await stub2.hold(stub2.holdCmd({ rate: 1, window: { start: M(10), end: M(11) }, policyVersion: 1n }))), 'HELD');
});

// ---------------- I3 with I4: validity and the policy version on the waiting path ----------------

test('T-05 a hold with wait = true that breaks a rule is refused INVALID(rule) at check (4) and does not wait (check (8))', async () => {
  const h = await harness();
  const blocker = h.stub.holdCmd({ rate: 10, window: { start: NOW, end: M(11) }, account: 'blocker' });
  assert.equal(resultOf(await h.stub.hold(blocker)), 'HELD');
  const v1 = h.stub.holdCmd({ rate: 0, window: { start: M(10), end: M(11) }, wait: true, account: 'v1' });
  const v4 = h.stub.holdCmd({ rate: 1, window: { start: NOW - 1, end: M(11) }, wait: true, account: 'v4' });
  const valid = h.stub.holdCmd({ rate: 1, window: { start: M(10), end: M(11) }, wait: true, account: 'valid' });
  assert.equal(resultOf(await h.stub.hold(v1)), 'REFUSED:{"invalid":"V1"}');
  assert.equal(resultOf(await h.stub.hold(v4)), 'REFUSED:{"invalid":"V4"}');
  assert.equal(resultOf(await h.stub.hold(valid)), 'WAITING', 'the same hold without the broken rule waits');
  const st = h.owner.stateOf(h.link);
  assert.deepEqual(st?.waitersInOrder().map((w) => requestKey(w.cmd.request)), [requestKey(valid.request)], 'the invalid holds do not wait');
  for (const r of [v1, v4]) assert.equal(st?.recordState(r.request)?.tombstoneUntil, r.deadline + DEFAULT_POLICY.releaseGraceMs, 'tombstone');
  assert.equal(resultOf(await h.stub.release(h.stub.releaseCmd(blocker.request, blocker.deadline))), 'RELEASED');
  assert.deepEqual(h.rt.notificationsSent.map((n) => [requestKey((n.body as WaitingNotification).request), (n.body as WaitingNotification).kind]),
    [[requestKey(valid.request), 'GRANTED']], 'only the valid waiter is granted');
});

test('should answer UNAVAILABLE to a hold with wait = true that carries an unapplied version, and register no waiter', async () => {
  const h = await harness();
  const blocker = h.stub.holdCmd({ rate: 10, window: { start: M(10), end: M(11) }, account: 'blocker' });
  assert.equal(resultOf(await h.stub.hold(blocker)), 'HELD');
  const before = logLength(h);
  const cmd = h.stub.holdCmd({ rate: 1, window: { start: M(10), end: M(11) }, wait: true, policyVersion: 2n });
  assert.deepEqual(await h.stub.hold(cmd), { code: 'UNAVAILABLE' });
  assert.equal(logLength(h), before, 'no entry');
  assert.deepEqual(h.owner.stateOf(h.link)?.waitersInOrder(), []);
  assert.equal(h.owner.stateOf(h.link)?.recordState(cmd.request), undefined, 'no record');
});

test('should give a waiter refused for no fit the counter-offer by rate_min of the policy version that it carries', async () => {
  const h = await harness();
  assert.deepEqual(await deploy(h, V2), { result: 'POLICY_APPLIED', version: '2' }, 'V2 (rate_min 2) is the current policy');
  const W = { start: M(10), end: M(11) };
  const ahead = h.stub.holdCmd({ rate: 9, window: W, account: 'ahead' });
  assert.equal(resultOf(await h.stub.hold(ahead)), 'HELD');
  const waiter = h.stub.holdCmd({ rate: 2, window: W, wait: true, policyVersion: 1n });
  assert.equal(resultOf(await h.stub.hold(waiter)), 'WAITING');
  assert.equal(resultOf(await h.stub.convert(h.stub.convertCmd(ahead))), 'CONVERTED');
  const sent = h.rt.notificationsSent.map((n) => n.body as WaitingNotification);
  assert.deepEqual(sent.map((n) => [requestKey(n.request), n.kind]), [[requestKey(waiter.request), 'WAITER_REFUSED']]);
  // 1 Mbps is free: version 1 (rate_min 1) offers it; version 2 (rate_min 2) would offer 0.
  assert.equal((sent[0] as { counterOffer?: { largestRateMbps: number } }).counterOffer?.largestRateMbps, 1);
});
