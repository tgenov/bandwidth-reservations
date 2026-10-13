/**
 * C02 provider suite, the link hold port subset of S-LINK I1 and AM-I1: `hold`, `convert` and `release`.
 * Tests come from C02 "Conformance tests", provider side 1 to 4. They run against the real link owner and
 * against the account slice's link double.
 *
 * The S-LINK I2 part (the counter-offer, `query` and the link availability query) runs only for a subject
 * registered with `{ i2: true }`, and the S-LINK I4 part (`hold` check (4), V1 … V6) only for one registered
 * with `{ i4: true }`. For another subject, the suite registers a PENDING entry for each part
 * (contracts/suites/ISSUES.md, "Known double gaps").
 *
 * The S-LINK I3 part (provider tests 1 `WAITING`, 4 "a grant keeps the attempt", 13 first two items) runs only
 * for a subject registered with `{ i2: true, i3: true }` that gives its notifications. Else a PENDING entry.
 *
 * The S-LINK I5 part (provider tests 4 "yield_accept replies with attempt + 1", "a stale attempt or claim gets
 * STALE_ATTEMPT", "the end of a hold attempt closes every claim on it", and 5 "yield claims") runs only for a subject
 * registered with `{ i2: true, i3: true, i5: true }` that provides `markWaiting` and `yieldAnswer`. Else a PENDING entry.
 *
 * The types are copied from C02 "Schema" (the subset that the tests use). They are structurally the same
 * as the types of each slice, so each slice can give its own port.
 */
import assert from 'node:assert/strict';
import type { CommandEnvelope, Epoch, Generation, HlcTs, PartitionKey, RoutingRefusal, Seq } from '@share/owner-runtime';
import { test } from 'node:test';
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

export interface C02CounterOffer {
  largestRateMbps: number;
  earliest: { window: C02Window } | { none: true } | { notFoundBefore: number };
}
export interface C02QueryCmd { link: string; receiverPartition: string; request: C02RequestId }
export type C02QueryReply = (C02LinkStamp & {
  state: 'UNSEEN' | 'HELD' | 'WAITING' | 'DISPLACED' | 'REFUSED' | 'RELEASED' | 'CONVERTED';
  attempt?: number; aheadDeadline?: number;
  refusal?: { reason: C02RefusalReason; counterOffer?: C02CounterOffer; retryAfterMs?: number };
  tombstoneUntil?: number;
  openYieldClaims?: { claim: Seq; olderRequest: C02RequestId }[];
}) | RoutingRefusal | C02Error;
export interface C02MarkWaitingCmd { link: string; receiverPartition: string; request: C02RequestId; waiting: boolean; position: Seq }
export type C02MarkWaitingReply = (C02LinkStamp & { result: 'APPLIED' | 'IGNORED_OLDER' }) | RoutingRefusal | C02Error;
export interface C02YieldAnswerCmd {
  link: string; receiverPartition: string; request: C02RequestId; attempt: number; claim: Seq; answer: 'yield_accept' | 'yield_refuse';
}
export type C02AcceptReply = (C02LinkStamp & (
  | { result: 'ACCEPTED'; newWaiterAttempt: number } | { result: 'REFUSED_RECORDED' } | { result: 'STALE_ATTEMPT' }
)) | RoutingRefusal | C02Error;
export interface C02AvailabilityQuery { link: string; receiverPartition: string; window: C02Window; rateMbps: number }
export type C02AvailabilityReply = (C02LinkStamp & { asOfSeq: Seq; offer: C02CounterOffer }) | RoutingRefusal | C02Error;
export interface C02FitRangesQuery { link: string; receiverPartition: string; rateMbps: number; from: number; until: number; k: number }
export type C02FitRangesReply = (C02LinkStamp & { asOfSeq: Seq; ranges: C02Window[]; continueFrom: number | null })
  | RoutingRefusal | C02Error;

/** The link hold port as a sender calls it. The C01 envelope travels beside the body. */
export interface C02HoldPort {
  hold(env: CommandEnvelope, cmd: C02HoldCmd): Promise<C02HoldReply>;
  convert(env: CommandEnvelope, cmd: C02ConvertCmd): Promise<C02ConvertReply>;
  release(env: CommandEnvelope, cmd: C02ReleaseCmd): Promise<C02ReleaseReply>;
  /** C02 `query` (S-LINK I2). */
  query?(env: CommandEnvelope, cmd: C02QueryCmd): Promise<C02QueryReply>;
  /** C02 link availability query (S-LINK I2). */
  availability?(env: CommandEnvelope, q: C02AvailabilityQuery): Promise<C02AvailabilityReply>;
  fitRanges?(env: CommandEnvelope, q: C02FitRangesQuery): Promise<C02FitRangesReply>;
  /** C02 `mark_waiting` (S-LINK I5). */
  markWaiting?(env: CommandEnvelope, cmd: C02MarkWaitingCmd): Promise<C02MarkWaitingReply>;
  /** C02 `yield_accept` and `yield_refuse` (S-LINK I5). */
  yieldAnswer?(env: CommandEnvelope, cmd: C02YieldAnswerCmd): Promise<C02AcceptReply>;
}

/** Which parts beyond the I1 subset a subject provides. */
export interface C02SuiteOptions {
  /** The counter-offer on NO_FIT and IN_FLIGHT, `query`, `availability` and `fit_ranges` (S-LINK I2). */
  i2?: boolean;
  /** `hold` check (8) `WAITING`, grants and the waiting port notifications (S-LINK I3). Needs `i2` and `notifications`. */
  i3?: boolean;
  /** `hold` check (4): V1 … V6 against the receipt minute m0, with the calendar cases of P1-S74 (S-LINK I4). */
  i4?: boolean;
  /** `YIELD_REQUEST`, `mark_waiting`, `yield_accept` and `yield_refuse` (S-LINK I5). Needs `i3`. */
  i5?: boolean;
}

/** The capacity (Mbps) of the one link that every C02 subject registers. */
export const C02_SUITE_CAPACITY = 10;
/** POL-04, POL-26: a tombstone lasts until D + release_grace (1 min). */
const RELEASE_GRACE_MS = 60_000;
/** C02 "Timeouts": D_c = D − τ for a request with no partner leg (τ about 420 ms). */
const TAU_MS = 420;
/** POL-09 `selling_horizon`: 12 calendar months. */
const SELLING_HORIZON_MONTHS = 12;

/** The minute index of a UTC date and time (month 1 … 12). */
function utcMinute(y: number, mo: number, d: number, hh: number, mm: number): number {
  return Date.UTC(y, mo - 1, d, hh, mm) / 60_000;
}

/**
 * The selling horizon H of a request received at minute m0 (RFC-001 §2, POL-09): the same UTC time of day on
 * the same calendar date `months` later, or on the last day of that month if it has no such date.
 */
function horizonOf(m0: number, months: number): number {
  const d = new Date(m0 * 60_000);
  const y = d.getUTCFullYear() + Math.floor((d.getUTCMonth() + months) / 12);
  const mo = (d.getUTCMonth() + months) % 12;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return Date.UTC(y, mo, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes()) / 60_000;
}

export interface C02Subject extends Closable {
  port: C02HoldPort;
  /** The link id. The link is registered with capacity `C02_SUITE_CAPACITY` and policy rate_min 1 Mbps. */
  link: string;
  /** A C01 envelope routed to the link holder, from the account partition with this sender fence. */
  envelope(account: PartitionKey, sender?: { generation: Generation; epoch: Epoch }): CommandEnvelope;
  /** The provider's present time (ms since the Unix epoch). */
  nowMs(): number;
  /**
   * The link waiting port notifications so far (S-LINK I3): the copies pushed after commit and the copies
   * relayed from the outbox, in order. Each copy is a C01 notification with a C02 `WaitingNotification` body.
   */
  notifications?(): { pushed: C02NotificationCopy[]; relayed: C02NotificationCopy[] };
}

/** A C01 point-to-point notification whose body is a C02 `WaitingNotification` (C02 "Link waiting port"). */
export interface C02NotificationCopy {
  to: { kind: string; partition: PartitionKey };
  id: { subject: Uint8Array; attempt: number; kind: string };
  body: C02LinkStamp & {
    link: string; request: C02RequestId; attempt: number; kind: string; aheadDeadline?: number; claim?: Seq; olderRequest?: C02RequestId;
  };
}

// ---------- builders ----------

let requestSeq = 0n;

interface HoldArgs {
  account?: string; request?: C02RequestId; rate: number; window?: C02Window; wait?: boolean; deadlineInMs?: number;
  /** The request_age as ms before the present time (S-LINK I5: it sets the priority order). Default 0. */
  ageMsAgo?: number;
}

function holdCmd(s: C02Subject, a: HoldArgs): C02HoldCmd {
  const now = s.nowMs();
  const account = bytes(a.account ?? 'b1');
  const receiptMinute = Math.floor(now / 60_000);
  const deadline = now + (a.deadlineInMs ?? 20_000);
  requestSeq += 1n;
  return {
    link: s.link, receiverPartition: s.link, request: a.request ?? { partition: account, seq: requestSeq }, account, leg: 'leg-1',
    holdKind: { kind: 'booking' }, rateMbps: a.rate, window: a.window ?? { start: receiptMinute + 60, end: receiptMinute + 120 },
    deadline, commitFence: deadline - TAU_MS, requestAge: tsAtMs(now - (a.ageMsAgo ?? 0)) as HlcTs, wait: a.wait ?? false, receiptMinute, policyVersion: 1n,
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
export function runC02ProviderSuite(name: string, make: SubjectFactory<C02Subject>, opts: C02SuiteOptions = {}): void {
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

  if (!opts.i4) {
    test(`C02 [${name}] PENDING (S-LINK I4 part): hold check (4), V1 … V6 against m0 with the calendar cases of P1-S74`,
      { todo: 'the subject does not provide the S-LINK I4 part (contracts/suites/ISSUES.md)' }, () => {});
  } else {
    t('1', 'hold: V1 … V6 against m0 give REFUSED(INVALID(rule)) and hold nothing; the edges of what is sold are HELD', async (s) => {
      const m0 = Math.floor(s.nowMs() / 60_000);
      const h = horizonOf(m0, SELLING_HORIZON_MONTHS);
      const cases: Array<[number, C02Window, string]> = [
        [1.5, { start: m0 + 60, end: m0 + 120 }, 'V1'],
        [1, { start: m0 + 60.5, end: m0 + 120 }, 'V2'],
        [1, { start: m0 + 60, end: m0 + 120.5 }, 'V2'],
        [1, { start: m0 - 1, end: m0 + 60 }, 'V4'],
        [1, { start: h, end: h + 60 }, 'V5'],
        [1, { start: h + 5, end: null }, 'V5'],
        [1, { start: h - 10, end: h + 10 }, 'V6'],
      ];
      for (const [rate, window, rule] of cases) {
        const cmd = holdCmd(s, { rate, window });
        const r = outcome(await s.port.hold(env(s, cmd), cmd));
        assert.deepEqual(r, { result: 'REFUSED', reason: { invalid: rule } }, `${rate} Mbps [${window.start}, ${window.end})`);
        assert.deepEqual(outcome(await s.port.hold(env(s, cmd), cmd)), r, 'a repeat gets the recorded refusal');
        assert.ok(s.port.query, 'the subject provides query (provider test 1: a query after each refusal)');
        assert.deepEqual(outcome(await s.port.query(env(s, cmd), { link: s.link, receiverPartition: s.link, request: cmd.request })),
          { state: 'REFUSED', refusal: { reason: { invalid: rule } }, tombstoneUntil: cmd.deadline + RELEASE_GRACE_MS }, `tombstone after ${rule}`);
      }
      // The invalid holds hold nothing: the full capacity fits beside them, where they overlap and up to H.
      for (const window of [{ start: m0, end: m0 + 121 }, { start: h - 10, end: h }]) {
        const full = holdCmd(s, { account: 'full', rate: C, window });
        assert.deepEqual(outcome(await s.port.hold(env(s, full), full)), { result: 'HELD', attempt: 1 }, `full capacity on [${window.start}, ${window.end})`);
        assert.equal(outcome(await s.port.release(env(s, full), releaseCmd(s, full.request, full.deadline)))['result'], 'RELEASED');
      }
      for (const window of [{ start: m0, end: m0 + 60 }, { start: h - 10, end: h }, { start: h - 1, end: null }]) {
        const cmd = holdCmd(s, { rate: 1, window });
        assert.deepEqual(outcome(await s.port.hold(env(s, cmd), cmd)), { result: 'HELD', attempt: 1 }, `[${window.start}, ${window.end})`);
      }
    });

    t('1', 'hold: the horizon is calendar months in UTC from the carried receipt minute m0, clamped to the month end (P1-S74)', async (s) => {
      const cases: Array<[number, number, string]> = [
        [utcMinute(2026, 3, 31, 10, 0), utcMinute(2027, 3, 31, 10, 0), 'HELD'],
        [utcMinute(2026, 3, 31, 10, 0), utcMinute(2027, 3, 31, 10, 1), 'V6'],
        [utcMinute(2028, 2, 29, 10, 0), utcMinute(2029, 2, 28, 10, 0), 'HELD'],
        [utcMinute(2028, 2, 29, 10, 0), utcMinute(2029, 2, 28, 10, 1), 'V6'],
      ];
      for (const [m0, end, want] of cases) {
        const cmd = { ...holdCmd(s, { rate: 2, window: { start: m0 + 60, end } }), receiptMinute: m0 };
        const r = outcome(await s.port.hold(env(s, cmd), cmd));
        assert.deepEqual(r, want === 'HELD' ? { result: 'HELD', attempt: 1 } : { result: 'REFUSED', reason: { invalid: want } },
          `received in minute ${new Date(m0 * 60_000).toISOString()}, ends ${new Date(end * 60_000).toISOString()}`);
      }
    });
  }

  if (!opts.i2) {
    test(`C02 [${name}] PENDING (S-LINK I2 part): counter-offer, query, availability and fit_ranges`,
      { todo: 'the subject does not provide the S-LINK I2 part (contracts/suites/ISSUES.md)' }, () => {});
    return;
  }

  const query = (s: C02Subject): NonNullable<C02HoldPort['query']> => {
    assert.ok(s.port.query, 'the subject provides query');
    return s.port.query.bind(s.port);
  };

  t('1', 'hold: REFUSED(NO_FIT) and REFUSED(IN_FLIGHT) carry the POL-10 counter-offer beside committed and held capacity', async (s) => {
    const m = Math.floor(s.nowMs() / 60_000) + 60;
    const w = { start: m, end: m + 60 };
    const a = holdCmd(s, { rate: C - 2, window: w });
    assert.equal(outcome(await s.port.hold(env(s, a), a))['result'], 'HELD');
    assert.equal(outcome(await s.port.convert(env(s, a), convertCmd(s, a)))['result'], 'CONVERTED');
    const pending = holdCmd(s, { account: 'b2', rate: 1, window: w });
    assert.equal(outcome(await s.port.hold(env(s, pending), pending))['result'], 'HELD');
    const noFit = holdCmd(s, { account: 'b3', rate: 5, window: w });
    assert.deepEqual(outcome(await s.port.hold(env(s, noFit), noFit)), {
      result: 'REFUSED', reason: 'NO_FIT', counterOffer: { largestRateMbps: 1, earliest: { window: { start: m + 60, end: m + 120 } } },
    });
    const inFlight = holdCmd(s, { account: 'b4', rate: 2, window: w, wait: false });
    const r = outcome(await s.port.hold(env(s, inFlight), inFlight));
    assert.deepEqual([r['reason'], r['counterOffer']], ['IN_FLIGHT', { largestRateMbps: 1, earliest: { window: { start: m + 60, end: m + 120 } } }]);
  });

  t('1', 'query: after each refusal the query shows the recorded refusal and a tombstone; an unseen request is UNSEEN', async (s) => {
    const a = holdCmd(s, { rate: C });
    assert.equal(outcome(await s.port.hold(env(s, a), a))['result'], 'HELD');
    for (const cmd of [holdCmd(s, { account: 'b2', rate: 1 }), holdCmd(s, { account: 'b3', rate: 1, deadlineInMs: TAU_MS - 1 })]) {
      const { result: _r, ...refusal } = outcome(await s.port.hold(env(s, cmd), cmd));
      const q = await query(s)(env(s, cmd), { link: s.link, receiverPartition: s.link, request: cmd.request });
      assert.deepEqual(outcome(q), { state: 'REFUSED', refusal, tombstoneUntil: cmd.deadline + RELEASE_GRACE_MS });
    }
    assert.deepEqual(outcome(await query(s)(env(s, a), { link: s.link, receiverPartition: s.link, request: a.request })), { state: 'HELD', attempt: 1 });
    const unseen = holdCmd(s, { account: 'b5', rate: 1 });
    assert.deepEqual(outcome(await query(s)(env(s, unseen), { link: s.link, receiverPartition: s.link, request: unseen.request })), { state: 'UNSEEN' });
  });

  t('availability', 'availability and fit_ranges answer beside held capacity, as of asOfSeq, and change nothing', async (s) => {
    assert.ok(s.port.availability && s.port.fitRanges, 'the subject provides the availability query');
    const m = Math.floor(s.nowMs() / 60_000) + 60;
    const a = holdCmd(s, { rate: C - 3, window: { start: m, end: m + 60 } });
    const held = await s.port.hold(env(s, a), a);
    const e = env(s, a);
    const av = await s.port.availability(e, { link: s.link, receiverPartition: s.link, window: { start: m, end: m + 60 }, rateMbps: 5 });
    assert.deepEqual(outcome(av), { asOfSeq: stamp(held).linkSeq, offer: { largestRateMbps: 3, earliest: { window: { start: m + 60, end: m + 120 } } } });
    const fr = await s.port.fitRanges(e, { link: s.link, receiverPartition: s.link, rateMbps: 5, from: m - 60, until: m + 120, k: 4 });
    assert.deepEqual(outcome(fr), { asOfSeq: stamp(held).linkSeq, ranges: [{ start: m - 60, end: m }, { start: m + 60, end: m + 120 }], continueFrom: null });
    const b = holdCmd(s, { account: 'b2', rate: 3, window: { start: m, end: m + 60 } });
    assert.deepEqual(outcome(await s.port.hold(env(s, b), b)), { result: 'HELD', attempt: 1 }, 'the query held nothing');
  });

  if (!opts.i3) {
    test(`C02 [${name}] PENDING (S-LINK I3 part): hold check (8) WAITING, grants and the waiting port notifications`,
      { todo: 'the subject does not provide the S-LINK I3 part (contracts/suites/ISSUES.md)' }, () => {});
    return;
  }

  const notes = (s: C02Subject): { pushed: C02NotificationCopy[]; relayed: C02NotificationCopy[] } => {
    assert.ok(s.notifications, 'the subject gives its waiting port notifications');
    return s.notifications();
  };
  const sameRequest = (a: C02RequestId, b: C02RequestId): boolean =>
    Buffer.from(a.partition).equals(Buffer.from(b.partition)) && a.seq === b.seq;

  t('1', 'hold: wait = true blocked only by capacity in flight gives WAITING(1, aheadDeadline = the latest blocker D), and a query shows WAITING', async (s) => {
    const a = holdCmd(s, { rate: C - 4, deadlineInMs: 20_000 });
    const b = holdCmd(s, { account: 'b2', rate: 4, deadlineInMs: 25_000 });
    assert.equal(outcome(await s.port.hold(env(s, a), a))['result'], 'HELD');
    assert.equal(outcome(await s.port.hold(env(s, b), b))['result'], 'HELD');
    const w = holdCmd(s, { account: 'b3', rate: 1, wait: true });
    assert.deepEqual(outcome(await s.port.hold(env(s, w), w)), { result: 'WAITING', attempt: 1, aheadDeadline: b.deadline });
    assert.deepEqual(outcome(await query(s)(env(s, w), { link: s.link, receiverPartition: s.link, request: w.request })),
      { state: 'WAITING', attempt: 1, aheadDeadline: b.deadline });
  });

  t('4', 'attempts: a grant keeps the attempt; the waiter is held at attempt 1 and converts at attempt 1', async (s) => {
    const a = holdCmd(s, { rate: C });
    assert.equal(outcome(await s.port.hold(env(s, a), a))['result'], 'HELD');
    const w = holdCmd(s, { account: 'b2', rate: 3, wait: true });
    assert.deepEqual(outcome(await s.port.hold(env(s, w), w))['attempt'], 1);
    await s.port.release(env(s, a), releaseCmd(s, a.request, a.deadline));
    assert.deepEqual(outcome(await query(s)(env(s, w), { link: s.link, receiverPartition: s.link, request: w.request })), { state: 'HELD', attempt: 1 });
    assert.deepEqual(outcome(await s.port.hold(env(s, w), w)), { result: 'HELD', attempt: 1 });
    assert.deepEqual(outcome(await s.port.convert(env(s, w), convertCmd(s, w, 1))), { result: 'CONVERTED', part: 'p1' });
  });

  t('13', 'notifications: a GRANTED is relayed with the identity (link, request, attempt, kind), and the push has the same identity and content', async (s) => {
    const a = holdCmd(s, { rate: C });
    assert.equal(outcome(await s.port.hold(env(s, a), a))['result'], 'HELD');
    const w = holdCmd(s, { account: 'b2', rate: 3, wait: true });
    await s.port.hold(env(s, w), w);
    const rel = await s.port.release(env(s, a), releaseCmd(s, a.request, a.deadline));
    const { pushed, relayed } = notes(s);
    const granted = relayed.filter((n) => n.body.kind === 'GRANTED' && sameRequest(n.body.request, w.request));
    assert.equal(granted.length, 1, 'one relayed GRANTED for the waiter');
    const g = granted[0] as C02NotificationCopy;
    assert.deepEqual([g.body.link, g.body.attempt, g.body.linkSeq], [s.link, 1, stamp(rel).linkSeq], 'the grant is in the entry that frees the capacity');
    assert.deepEqual([g.id.attempt, g.id.kind], [1, 'GRANTED']);
    assert.ok(Buffer.from(g.to.partition).equals(Buffer.from(w.account)), 'the relay key is the waiter account partition');
    const push = pushed.filter((n) => n.body.kind === 'GRANTED' && sameRequest(n.body.request, w.request));
    assert.deepEqual(push, granted, 'the push and the relay have the same identity and content');
  });

  if (!opts.i5) {
    test(`C02 [${name}] PENDING (S-LINK I5 part): YIELD_REQUEST, mark_waiting, yield_accept and yield_refuse`,
      { todo: 'the subject does not provide the S-LINK I5 part (contracts/suites/ISSUES.md)' }, () => {});
    return;
  }

  const yieldPort = (s: C02Subject): Required<Pick<C02HoldPort, 'markWaiting' | 'yieldAnswer'>> => {
    assert.ok(s.port.markWaiting && s.port.yieldAnswer, 'the subject provides mark_waiting and the yield answers');
    return { markWaiting: s.port.markWaiting.bind(s.port), yieldAnswer: s.port.yieldAnswer.bind(s.port) };
  };
  const mark = (s: C02Subject, r: C02RequestId, waiting: boolean, position: Seq): Promise<C02MarkWaitingReply> =>
    yieldPort(s).markWaiting(env(s, r), { link: s.link, receiverPartition: s.link, request: r, waiting, position });
  const answer = (s: C02Subject, r: C02RequestId, attempt: number, claim: Seq, a: C02YieldAnswerCmd['answer']): Promise<C02AcceptReply> =>
    yieldPort(s).yieldAnswer(env(s, r), { link: s.link, receiverPartition: s.link, request: r, attempt, claim, answer: a });
  const queryOf = async (s: C02Subject, r: C02RequestId): Promise<Record<string, unknown>> =>
    outcome(await query(s)(env(s, r), { link: s.link, receiverPartition: s.link, request: r }));
  /** The claims of the relayed YIELD_REQUESTs to `holder` for `older`, in order. */
  const claims = (s: C02Subject, holder: C02RequestId, older: C02RequestId): Seq[] =>
    notes(s).relayed.filter((n) => n.body.kind === 'YIELD_REQUEST' && sameRequest(n.body.request, holder)
      && n.body.olderRequest !== undefined && sameRequest(n.body.olderRequest, older)).map((n) => n.body.claim as Seq);
  /** Y (younger) holds 8 Mbps; O (older) waits for 8 Mbps on the same window. Y has no mark yet. */
  const crossing = async (s: C02Subject): Promise<{ y: C02HoldCmd; o: C02HoldCmd }> => {
    const y = holdCmd(s, { account: 'y', rate: 8, ageMsAgo: 1 });
    const o = holdCmd(s, { account: 'o', rate: 8, wait: true, ageMsAgo: 5, deadlineInMs: 25_000 });
    assert.deepEqual(outcome(await s.port.hold(env(s, y), y)), { result: 'HELD', attempt: 1 });
    assert.deepEqual(outcome(await s.port.hold(env(s, o), o)), { result: 'WAITING', attempt: 1, aheadDeadline: y.deadline });
    assert.deepEqual(claims(s, y.request, o.request), [], 'a holder without the mark is not asked (P2-S58)');
    return { y, o };
  };

  t('4', 'attempts: yield_accept replies ACCEPTED(attempt + 1) and a repeat gets the recorded reply; a stale attempt or claim gets STALE_ATTEMPT and changes nothing', async (s) => {
    const { y, o } = await crossing(s);
    const m = await mark(s, y.request, true, 1n);
    assert.deepEqual(outcome(m), { result: 'APPLIED' });
    const [c] = claims(s, y.request, o.request);
    assert.equal(c, stamp(m).linkSeq, 'the claim is the link-log sequence of the entry that raised it');
    assert.deepEqual(await queryOf(s, y.request), { state: 'HELD', attempt: 1, openYieldClaims: [{ claim: c, olderRequest: o.request }] });
    assert.deepEqual(outcome(await answer(s, y.request, 2, c as Seq, 'yield_accept')), { result: 'STALE_ATTEMPT' });
    assert.deepEqual(outcome(await answer(s, y.request, 1, (c as Seq) + 1n, 'yield_accept')), { result: 'STALE_ATTEMPT' });
    assert.deepEqual(await queryOf(s, o.request), { state: 'WAITING', attempt: 1, aheadDeadline: y.deadline }, 'a stale answer changes nothing');
    const acc = await answer(s, y.request, 1, c as Seq, 'yield_accept');
    assert.deepEqual(outcome(acc), { result: 'ACCEPTED', newWaiterAttempt: 2 });
    const again = await answer(s, y.request, 1, c as Seq, 'yield_accept');
    assert.deepEqual([outcome(again), stamp(again).linkSeq], [outcome(acc), stamp(acc).linkSeq], 'a repeat gets the recorded reply');
    assert.deepEqual(await queryOf(s, o.request), { state: 'HELD', attempt: 1 }, 'the older waiter is granted in the entry of the yield');
    assert.deepEqual(await queryOf(s, y.request), { state: 'WAITING', attempt: 2, aheadDeadline: o.deadline });
    await s.port.release(env(s, o), releaseCmd(s, o.request, o.deadline));
    assert.deepEqual(await queryOf(s, y.request), { state: 'HELD', attempt: 2 }, 'a grant keeps attempt 2');
    assert.deepEqual(await s.port.convert(env(s, y), convertCmd(s, y, 1)), { code: 'MISMATCH' });
    assert.deepEqual(outcome(await s.port.convert(env(s, y), convertCmd(s, y, 2))), { result: 'CONVERTED', part: 'p1' });
  });

  t('4', 'attempts: the end of a hold attempt (convert) closes every claim on it', async (s) => {
    const { y, o } = await crossing(s);
    await mark(s, y.request, true, 1n);
    const [c] = claims(s, y.request, o.request);
    assert.equal(outcome(await s.port.convert(env(s, y), convertCmd(s, y, 1)))['result'], 'CONVERTED');
    assert.deepEqual(outcome(await answer(s, y.request, 1, c as Seq, 'yield_accept')), { result: 'STALE_ATTEMPT' });
    assert.deepEqual(outcome(await answer(s, y.request, 1, c as Seq, 'yield_refuse')), { result: 'STALE_ATTEMPT' });
  });

  t('5', 'yield claims, refusal then mark: claim c1 is refused while the mark is clear, the mark is set, a new claim c2 is accepted, and the older waiter is granted', async (s) => {
    const { y, o } = await crossing(s);
    await mark(s, y.request, true, 1n);
    await mark(s, y.request, false, 2n);
    const [c1] = claims(s, y.request, o.request);
    assert.deepEqual(outcome(await answer(s, y.request, 1, c1 as Seq, 'yield_refuse')), { result: 'REFUSED_RECORDED' });
    assert.deepEqual(claims(s, y.request, o.request), [c1], 'no new claim while the mark is clear');
    const m = await mark(s, y.request, true, 3n);
    const c2 = claims(s, y.request, o.request)[1];
    assert.equal(c2, stamp(m).linkSeq);
    assert.deepEqual(outcome(await answer(s, y.request, 1, c2 as Seq, 'yield_accept')), { result: 'ACCEPTED', newWaiterAttempt: 2 });
    assert.deepEqual(await queryOf(s, o.request), { state: 'HELD', attempt: 1 });
  });

  t('5', 'yield claims, mark then refusal: the mark arrives while c1 is open, yield_refuse(c1) arrives, the link raises c2 at once, c2 is accepted', async (s) => {
    const { y, o } = await crossing(s);
    await mark(s, y.request, true, 1n);
    const [c1] = claims(s, y.request, o.request);
    const ref = await answer(s, y.request, 1, c1 as Seq, 'yield_refuse');
    assert.deepEqual(outcome(ref), { result: 'REFUSED_RECORDED' });
    const c2 = claims(s, y.request, o.request)[1];
    assert.equal(c2, stamp(ref).linkSeq, 'c2 is raised in the entry that records the refusal');
    assert.deepEqual(outcome(await answer(s, y.request, 1, c2 as Seq, 'yield_accept')), { result: 'ACCEPTED', newWaiterAttempt: 2 });
    assert.deepEqual(await queryOf(s, o.request), { state: 'HELD', attempt: 1 });
  });

  t('5', 'yield claims: yield_refuse(c1) ends only c1', async (s) => {
    const y = holdCmd(s, { account: 'y', rate: 8, ageMsAgo: 1 });
    assert.deepEqual(outcome(await s.port.hold(env(s, y), y)), { result: 'HELD', attempt: 1 });
    await mark(s, y.request, true, 1n);
    const o1 = holdCmd(s, { account: 'o1', rate: 8, wait: true, ageMsAgo: 9 });
    const o2 = holdCmd(s, { account: 'o2', rate: 5, wait: true, ageMsAgo: 5 });
    const h1 = await s.port.hold(env(s, o1), o1);
    const h2 = await s.port.hold(env(s, o2), o2);
    const [c1, c2] = [stamp(h1).linkSeq, stamp(h2).linkSeq];
    assert.deepEqual(await queryOf(s, y.request), {
      state: 'HELD', attempt: 1, openYieldClaims: [{ claim: c1, olderRequest: o1.request }, { claim: c2, olderRequest: o2.request }],
    }, 'two older waiters have open claims on one holder attempt');
    await mark(s, y.request, false, 2n);
    assert.deepEqual(outcome(await answer(s, y.request, 1, c1, 'yield_refuse')), { result: 'REFUSED_RECORDED' });
    assert.deepEqual(await queryOf(s, y.request), { state: 'HELD', attempt: 1, openYieldClaims: [{ claim: c2, olderRequest: o2.request }] });
  });
}
