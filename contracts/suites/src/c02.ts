/**
 * C02 provider suite, the link hold port subset of S-LINK I1 and AM-I1: `hold`, `convert` and `release`.
 * Tests come from C02 "Conformance tests", provider side 1 to 4. They run against the real link owner and
 * against the account slice's link double.
 *
 * The types are copied from C02 "Schema" (the subset that the tests use). They are structurally the same
 * as the types of each slice, so each slice can give its own port.
 */
import assert from 'node:assert/strict';
import type { CommandEnvelope, Epoch, Generation, HlcTs, PartitionKey, RoutingRefusal, Seq } from '@share/owner-runtime';
import { bytes, subjectTest, tsAtMs, type Closable, type SubjectFactory } from './support.ts';

// ---------- C02 "Schema" (subset) ----------

export interface C02Window { start: number; end: number | null }
export interface C02RequestId { partition: PartitionKey; seq: Seq }
export interface C02LinkStamp { linkFence: { generation: Generation; epoch: Epoch }; linkSeq: Seq }
export type C02Error = { code: 'MISMATCH' } | { code: 'UNKNOWN_LINK' } | { code: 'LINK_CLOSING' } | { code: 'LINK_RETIRED' };
export type C02RefusalReason = 'NO_FIT' | 'IN_FLIGHT' | 'DEADLINE_PASSED' | 'TOMBSTONED'
  | { invalid: 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' };

export interface C02HoldCmd {
  link: string; receiverPartition: string;
  request: C02RequestId; account: PartitionKey; leg: string; holdKind: { kind: 'booking' } | { kind: 'change'; reservation: string };
  rateMbps: number; window: C02Window; deadline: number; commitFence: number; requestAge: HlcTs; wait: boolean;
  receiptMinute: number; policyVersion: Seq;
}
export type C02HoldReply = (C02LinkStamp & (
  | { result: 'HELD'; attempt: number }
  | { result: 'WAITING'; attempt: number; aheadDeadline: number }
  | { result: 'REFUSED'; reason: C02RefusalReason; counterOffer?: unknown; retryAfterMs?: number }
  | { result: 'RELEASED' } | { result: 'CONVERTED'; part: string }
)) | RoutingRefusal | C02Error;

export interface C02ConvertCmd {
  link: string; receiverPartition: string;
  request: C02RequestId; attempt: number; reservation: string; leg: string; part: string;
  createdBy: C02RequestId; decisionTime: HlcTs;
}
export type C02ConvertReply = (C02LinkStamp & { result: 'CONVERTED'; part: string; clippedAt?: number })
  | { code: 'NO_HOLD' } | { code: 'TOMBSTONED' } | RoutingRefusal | C02Error;

export interface C02ReleaseCmd {
  link: string; receiverPartition: string;
  request: C02RequestId; deadline: number; reason: 'WITHDRAWN' | 'EXPIRED' | 'REJECTED' | 'FAILED' | 'ENDED'; decisionTime: HlcTs;
}
export type C02ReleaseReply = (C02LinkStamp & { result: 'RELEASED'; tombstoneUntil: number }) | RoutingRefusal | C02Error;

/** The link hold port as a sender calls it. The C01 envelope travels beside the body. */
export interface C02HoldPort {
  hold(env: CommandEnvelope, cmd: C02HoldCmd): Promise<C02HoldReply>;
  convert(env: CommandEnvelope, cmd: C02ConvertCmd): Promise<C02ConvertReply>;
  release(env: CommandEnvelope, cmd: C02ReleaseCmd): Promise<C02ReleaseReply>;
}

/** The capacity (Mbps) of the one link that every C02 subject registers. */
export const C02_SUITE_CAPACITY = 10;
/** POL-04, POL-26: a tombstone lasts until D + release_grace (1 min). */
const RELEASE_GRACE_MS = 60_000;
/** C02 "Timeouts": D_c = D − τ for a request with no partner leg (τ about 420 ms). */
const TAU_MS = 420;

export interface C02Subject extends Closable {
  port: C02HoldPort;
  /** The link id. The link is registered with capacity `C02_SUITE_CAPACITY` and policy rate_min 1 Mbps. */
  link: string;
  /** A C01 envelope routed to the link holder, from the account partition with this sender fence. */
  envelope(account: PartitionKey, sender?: { generation: Generation; epoch: Epoch }): CommandEnvelope;
  /** The provider's present time (ms since the Unix epoch). */
  nowMs(): number;
}

// ---------- builders ----------

let requestSeq = 0n;

interface HoldArgs { account?: string; request?: C02RequestId; rate: number; window?: C02Window; wait?: boolean; deadlineInMs?: number }

function holdCmd(s: C02Subject, a: HoldArgs): C02HoldCmd {
  const now = s.nowMs();
  const account = bytes(a.account ?? 'b1');
  const receiptMinute = Math.floor(now / 60_000);
  const deadline = now + (a.deadlineInMs ?? 20_000);
  requestSeq += 1n;
  return {
    link: s.link, receiverPartition: s.link, request: a.request ?? { partition: account, seq: requestSeq }, account, leg: 'leg-1',
    holdKind: { kind: 'booking' }, rateMbps: a.rate, window: a.window ?? { start: receiptMinute + 60, end: receiptMinute + 120 },
    deadline, commitFence: deadline - TAU_MS, requestAge: tsAtMs(now) as HlcTs, wait: a.wait ?? false, receiptMinute, policyVersion: 1n,
  };
}

function convertCmd(s: C02Subject, h: C02HoldCmd, attempt = 1, part = 'p1'): C02ConvertCmd {
  return {
    link: s.link, receiverPartition: s.link, request: h.request, attempt, reservation: `r-${h.request.seq}`, leg: h.leg, part,
    createdBy: { partition: h.account, seq: h.request.seq + 1000n }, decisionTime: tsAtMs(s.nowMs()) as HlcTs,
  };
}

function releaseCmd(s: C02Subject, request: C02RequestId, deadline: number): C02ReleaseCmd {
  return { link: s.link, receiverPartition: s.link, request, deadline, reason: 'REJECTED', decisionTime: tsAtMs(s.nowMs()) as HlcTs };
}

/** The decision of a reply without the link stamp (the stamp is checked on its own). */
function outcome(r: object): Record<string, unknown> {
  const { linkFence: _f, linkSeq: _s, ...rest } = r as Record<string, unknown>;
  return rest;
}

function stamp(r: object): C02LinkStamp {
  assert.ok('linkSeq' in r && 'linkFence' in r, `reply has no link stamp: ${JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`);
  return r as C02LinkStamp;
}

/** Register the C02 provider suite against the subjects that `make` creates. */
export function runC02ProviderSuite(name: string, make: SubjectFactory<C02Subject>): void {
  const t = (id: string, behaviour: string, body: (s: C02Subject) => Promise<void>): void =>
    subjectTest('C02', id, name, behaviour, make, body);
  const C = C02_SUITE_CAPACITY;
  const env = (s: C02Subject, h: { account: PartitionKey } | C02RequestId): CommandEnvelope =>
    s.envelope('account' in h ? h.account : h.partition);

  t('1', 'hold: a fit beside every hold gives HELD(1) with the link stamp', async (s) => {
    const h = holdCmd(s, { rate: C });
    const r = await s.port.hold(env(s, h), h);
    assert.deepEqual(outcome(r), { result: 'HELD', attempt: 1 });
    assert.equal(typeof stamp(r).linkSeq, 'bigint');
    assert.equal(typeof stamp(r).linkFence.epoch, 'bigint');
  });

  t('1', 'hold: no fit on committed capacity gives REFUSED(NO_FIT)', async (s) => {
    const a = holdCmd(s, { rate: C });
    assert.equal(outcome(await s.port.hold(env(s, a), a))['result'], 'HELD');
    assert.equal(outcome(await s.port.convert(env(s, a), convertCmd(s, a)))['result'], 'CONVERTED');
    const b = holdCmd(s, { account: 'b2', rate: 1 });
    const r = outcome(await s.port.hold(env(s, b), b));
    assert.deepEqual([r['result'], r['reason']], ['REFUSED', 'NO_FIT']);
  });

  t('1', 'hold: blocked only by capacity in flight and wait = false gives REFUSED(IN_FLIGHT) with the remaining deadline of the latest blocker', async (s) => {
    const a = holdCmd(s, { rate: C - 2, deadlineInMs: 20_000 });
    const b = holdCmd(s, { account: 'b2', rate: 2, deadlineInMs: 25_000 });
    assert.equal(outcome(await s.port.hold(env(s, a), a))['result'], 'HELD');
    assert.equal(outcome(await s.port.hold(env(s, b), b))['result'], 'HELD');
    const c = holdCmd(s, { account: 'b3', rate: 1, wait: false });
    const r = outcome(await s.port.hold(env(s, c), c));
    assert.deepEqual([r['result'], r['reason'], r['retryAfterMs']], ['REFUSED', 'IN_FLIGHT', b.deadline - s.nowMs()]);
  });

  t('1', 'hold: ts ≥ D_c gives REFUSED(DEADLINE_PASSED), and nothing is held', async (s) => {
    const late = holdCmd(s, { rate: C, deadlineInMs: TAU_MS - 1 });
    assert.deepEqual(outcome(await s.port.hold(env(s, late), late)), { result: 'REFUSED', reason: 'DEADLINE_PASSED' });
    const next = holdCmd(s, { account: 'b2', rate: C });
    assert.deepEqual(outcome(await s.port.hold(env(s, next), next)), { result: 'HELD', attempt: 1 });
  });

  t('1', 'hold: a rate below rate_min is INVALID(V1); a window with end ≤ start is INVALID(V3)', async (s) => {
    const v1 = holdCmd(s, { rate: 0 });
    assert.deepEqual(outcome(await s.port.hold(env(s, v1), v1)), { result: 'REFUSED', reason: { invalid: 'V1' } });
    const m = Math.floor(s.nowMs() / 60_000) + 60;
    const v3 = holdCmd(s, { rate: 1, window: { start: m, end: m } });
    assert.deepEqual(outcome(await s.port.hold(env(s, v3), v3)), { result: 'REFUSED', reason: { invalid: 'V3' } });
  });

  t('1', 'hold: a record that a release made gives REFUSED(TOMBSTONED) with no digest check', async (s) => {
    const h = holdCmd(s, { rate: 1 });
    const rel = await s.port.release(env(s, h), releaseCmd(s, h.request, h.deadline));
    assert.deepEqual(outcome(rel), { result: 'RELEASED', tombstoneUntil: h.deadline + RELEASE_GRACE_MS });
    assert.deepEqual(outcome(await s.port.hold(env(s, h), h)), { result: 'REFUSED', reason: 'TOMBSTONED' });
    const changed = { ...h, rateMbps: 2 };
    assert.deepEqual(outcome(await s.port.hold(env(s, h), changed)), { result: 'REFUSED', reason: 'TOMBSTONED' });
  });

  t('1', 'hold: a held, then released request answers RELEASED to a repeat, and the release frees the capacity', async (s) => {
    const h = holdCmd(s, { rate: C });
    assert.equal(outcome(await s.port.hold(env(s, h), h))['result'], 'HELD');
    assert.deepEqual(outcome(await s.port.release(env(s, h), releaseCmd(s, h.request, h.deadline))),
      { result: 'RELEASED', tombstoneUntil: h.deadline + RELEASE_GRACE_MS });
    assert.deepEqual(outcome(await s.port.hold(env(s, h), h)), { result: 'RELEASED' });
    const other = holdCmd(s, { account: 'b2', rate: C });
    assert.deepEqual(outcome(await s.port.hold(env(s, other), other)), { result: 'HELD', attempt: 1 });
  });

  t('2', 'arrival order: holds that arrive in the reverse of their receipt order are decided in arrival order; a repeat gets its first verdict', async (s) => {
    const early = holdCmd(s, { account: 'a1', rate: C });
    const late = holdCmd(s, { account: 'a2', rate: C });
    const first = await s.port.hold(env(s, late), late);
    const second = await s.port.hold(env(s, early), early);
    assert.deepEqual(outcome(first), { result: 'HELD', attempt: 1 });
    assert.deepEqual([outcome(second)['result'], outcome(second)['reason']], ['REFUSED', 'IN_FLIGHT']);
    assert.ok(stamp(first).linkSeq < stamp(second).linkSeq, 'the link log orders the first arrival first');
    assert.deepEqual(outcome(await s.port.hold(env(s, early), early)), outcome(second));
    assert.deepEqual(outcome(await s.port.hold(env(s, late), late)), outcome(first));
  });

  t('3', 'idempotency: a duplicate of each operation gets the recorded reply', async (s) => {
    const h = holdCmd(s, { rate: 4 });
    const held = outcome(await s.port.hold(env(s, h), h));
    assert.deepEqual(outcome(await s.port.hold(env(s, h), h)), held);
    const refusedCmd = holdCmd(s, { account: 'b2', rate: C });
    const refused = outcome(await s.port.hold(env(s, refusedCmd), refusedCmd));
    assert.equal(refused['result'], 'REFUSED');
    assert.deepEqual(outcome(await s.port.hold(env(s, refusedCmd), refusedCmd)), refused, 'a refusal is recorded by the hold, not as a release tombstone');
    const conv = convertCmd(s, h, 1, 'p-9');
    assert.deepEqual(outcome(await s.port.convert(env(s, h), conv)), { result: 'CONVERTED', part: 'p-9' });
    assert.deepEqual(outcome(await s.port.convert(env(s, h), conv)), { result: 'CONVERTED', part: 'p-9' });
    assert.deepEqual(outcome(await s.port.hold(env(s, h), h)), { result: 'CONVERTED', part: 'p-9' });
    const other = holdCmd(s, { account: 'b3', rate: 1 });
    const rel = releaseCmd(s, other.request, other.deadline);
    const r1 = outcome(await s.port.release(env(s, other), rel));
    assert.deepEqual(outcome(await s.port.release(env(s, other), rel)), r1);
  });

  t('3', 'idempotency: the same identity with a changed body gets MISMATCH, and nothing changes', async (s) => {
    const h = holdCmd(s, { rate: 4 });
    assert.equal(outcome(await s.port.hold(env(s, h), h))['result'], 'HELD');
    assert.deepEqual(await s.port.hold(env(s, h), { ...h, rateMbps: 6 }), { code: 'MISMATCH' });
    const fits = holdCmd(s, { account: 'b2', rate: C - 4 });
    assert.deepEqual(outcome(await s.port.hold(env(s, fits), fits)), { result: 'HELD', attempt: 1 }, 'the held rate is still 4');
    assert.deepEqual(outcome(await s.port.convert(env(s, h), convertCmd(s, h, 1, 'p1'))), { result: 'CONVERTED', part: 'p1' });
    assert.deepEqual(await s.port.convert(env(s, h), convertCmd(s, h, 1, 'p2')), { code: 'MISMATCH' });
    assert.deepEqual(outcome(await s.port.hold(env(s, h), h)), { result: 'CONVERTED', part: 'p1' });
  });

  t('3', 'idempotency: the same body with a changed envelope (a new sender epoch) is a duplicate', async (s) => {
    const h = holdCmd(s, { rate: 4 });
    const first = outcome(await s.port.hold(s.envelope(h.account, { generation: 0, epoch: 1n }), h));
    assert.deepEqual(outcome(await s.port.hold(s.envelope(h.account, { generation: 0, epoch: 2n }), h)), first);
  });

  t('4', 'attempts: a grant keeps attempt 1; convert with another attempt gets MISMATCH and the hold stays', async (s) => {
    const h = holdCmd(s, { rate: 4 });
    assert.deepEqual(outcome(await s.port.hold(env(s, h), h)), { result: 'HELD', attempt: 1 });
    assert.deepEqual(await s.port.convert(env(s, h), convertCmd(s, h, 2)), { code: 'MISMATCH' });
    assert.deepEqual(outcome(await s.port.convert(env(s, h), convertCmd(s, h, 1))), { result: 'CONVERTED', part: 'p1' });
  });

  t('4', 'convert of a request that the link never saw gets NO_HOLD', async (s) => {
    const h = holdCmd(s, { rate: 1 });
    assert.deepEqual(await s.port.convert(env(s, h), convertCmd(s, h)), { code: 'NO_HOLD' });
  });
}
