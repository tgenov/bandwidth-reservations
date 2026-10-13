/**
 * S-LINK I6 tests: changes to confirmed legs (RFC-001 §4.4 clip backstop, §4.5; C02 `end_leg`, `reduce_parts`,
 * `convert` with `clippedAt`, "Leg-command sequencing", "Idempotency").
 * - C02 provider tests 6, 7 and 8 (the two `INVALID(applies)` cases) at the owner (exit criterion 1);
 * - the C02 joint traces against the recorded account-owner stub (exit criterion 2);
 * - the link parts of the P2 scenarios that S-LINK plan §8 puts in I6.
 *
 * The P2 background: it is 10:00:30, and R is a confirmed reservation of 4 Mbps for [09:00, 18:00) on L1 and L2,
 * each with a capacity of 10 Mbps. R was booked at 08:30, so its window was valid then (V4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8 } from '@share/owner-runtime';
import { RESULTS } from '@share/owner-runtime/testing';
import type { ConvertCmd, ConvertReply, EndLegCmd, HoldCmd, LegChangeReply, Piece, ReducePartsCmd, Window } from '../src/index.ts';
import { DEFAULT_POLICY, ENTRY, type LinkPolicy } from '../src/index.ts';
import { DAY_MS, decidedThen, harness, M, resultOf, type Harness } from './support.ts';

const ACCT = 'acct-r';
const C = 10;
/** 10:00:30 on the scenario day. */
const NOW_MS = DAY_MS + 10 * 3_600_000 + 30_000;

/** A harness at 08:30 on the scenario day. `book` runs there; then the clock goes to 10:00:30. */
async function at0830(link = 'L1', policy: LinkPolicy = DEFAULT_POLICY): Promise<Harness> {
  return harness({ link, capacity: C, policy, startMs: DAY_MS + 8 * 3_600_000 + 30 * 60_000 });
}

function toNow(h: Harness): void {
  h.rt.advance(NOW_MS - Number(h.rt.now().ts.split('.')[0]) / 1e6);
}

interface PartArgs {
  rate: number; window: Window; part: string; createdBy: bigint;
  reservation?: string; leg?: string; account?: string; kind?: 'booking' | 'change';
}

/** The hold and the convert of one part, as the account owner sends them. */
function partCmds(h: Harness, a: PartArgs): { hold: HoldCmd; convert: ConvertCmd } {
  const account = a.account ?? ACCT;
  const reservation = a.reservation ?? 'R';
  const base = h.stub.holdCmd({ rate: a.rate, window: a.window, account, leg: a.leg ?? 'leg-1' });
  const hold: HoldCmd = { ...base, holdKind: a.kind === 'change' ? { kind: 'change', reservation } : { kind: 'booking' } };
  const convert: ConvertCmd = {
    ...h.stub.convertCmd(hold, 1, a.part), reservation, createdBy: { partition: utf8(account), seq: a.createdBy },
  };
  return { hold, convert };
}

/** Hold and convert one part. Both must succeed (the convert is not clipped). */
async function confirm(h: Harness, a: PartArgs): Promise<{ hold: HoldCmd; convert: ConvertCmd }> {
  const c = partCmds(h, a);
  assert.equal(resultOf(await h.stub.hold(c.hold)), 'HELD');
  assert.deepEqual(outcome(await h.stub.convert(c.convert)), { result: 'CONVERTED', part: a.part });
  return c;
}

/** R: 4 Mbps for [09:00, 18:00), part p1, created by the E5 at sequence 50. The clock is then at 10:00:30. */
async function withR(link = 'L1', policy: LinkPolicy = DEFAULT_POLICY): Promise<Harness> {
  const h = await at0830(link, policy);
  await confirm(h, { rate: 4, window: { start: M(9), end: M(18) }, part: 'p1', createdBy: 50n });
  toNow(h);
  return h;
}

interface EndArgs {
  change: bigint; from: number; cause?: EndLegCmd['cause']; applies?: EndLegCmd['applies'];
  reservation?: string; leg?: string; account?: string;
}

function endLegCmd(h: Harness, a: EndArgs): EndLegCmd {
  const account = a.account ?? ACCT;
  return {
    link: h.link, receiverPartition: h.link, reservation: a.reservation ?? 'R', leg: a.leg ?? 'leg-1',
    changeId: { partition: utf8(account), seq: a.change }, fromMinute: a.from, cause: a.cause ?? 'CANCEL',
    ...(a.applies ? { applies: a.applies } : {}), decisionTime: h.rt.now().ts,
  };
}

interface ReduceArgs {
  change: bigint; parts: Array<[string, Piece[]]>; cause?: ReducePartsCmd['cause']; applies?: ReducePartsCmd['applies'];
  reservation?: string; leg?: string; account?: string;
}

function reduceCmd(h: Harness, a: ReduceArgs): ReducePartsCmd {
  const account = a.account ?? ACCT;
  return {
    link: h.link, receiverPartition: h.link, reservation: a.reservation ?? 'R', leg: a.leg ?? 'leg-1',
    changeId: { partition: utf8(account), seq: a.change }, cause: a.cause ?? 'DECREASE',
    parts: a.parts.map(([part, pieces]) => ({ part, pieces })), ...(a.applies ? { applies: a.applies } : {}),
    decisionTime: h.rt.now().ts,
  };
}

function endLeg(h: Harness, cmd: EndLegCmd, epoch?: bigint): Promise<LegChangeReply> {
  const env = h.stub.envelope(cmd.changeId.partition);
  if (epoch !== undefined) env.sender.epoch = epoch;
  return h.owner.endLeg(env, cmd);
}

function reduce(h: Harness, cmd: ReducePartsCmd, epoch?: bigint): Promise<LegChangeReply> {
  const env = h.stub.envelope(cmd.changeId.partition);
  if (epoch !== undefined) env.sender.epoch = epoch;
  return h.owner.reduceParts(env, cmd);
}

/** A reply without its link stamp. */
function outcome(r: unknown): Record<string, unknown> {
  const { linkFence: _f, linkSeq: _s, ...rest } = r as Record<string, unknown>;
  return rest;
}

function seqOf(r: unknown): bigint {
  return (r as { linkSeq: bigint }).linkSeq;
}

/** `occ_firm` and `occ_all` at each minute of `minutes`. */
function occ(h: Harness, minutes: number[]): Array<[number, number, number]> {
  const st = h.owner.stateOf(h.link);
  assert.ok(st);
  return minutes.map((t) => [t, st.occFirm.value(t), st.occAll.value(t)]);
}

function logKinds(h: Harness): number[] {
  return h.rt.log(utf8(h.link)).map((e) => e.entry.kind);
}

const CHANGED = { result: 'CHANGED' };
const stale = (seq: bigint) => ({ result: 'STALE_CHANGE', lastApplied: { partition: utf8(ACCT), seq } });

// ---------------- C02 provider test 6: change ids ----------------

const END_CAUSES: Array<EndLegCmd['cause']> = ['CANCEL', 'SHORTEN', 'RELEASE', 'TERMINATE', 'MOVE', 'POL07'];
const OTHER_LINK_PAIR = [{ link: 'L9', reduction: 7n }];

test('C02 6 end_leg, each cause: an applied lower change id sent again after a higher one gets its recorded CHANGED and changes nothing', async () => {
  for (const cause of END_CAUSES) {
    const h = await withR();
    const applies = cause === 'POL07' ? OTHER_LINK_PAIR : undefined;
    const first = endLegCmd(h, { change: 100n, from: M(15), cause, ...(applies ? { applies } : {}) });
    const r1 = await endLeg(h, first);
    assert.deepEqual(outcome(r1), CHANGED, cause);
    const r2 = await endLeg(h, endLegCmd(h, { change: 101n, from: M(12), cause, ...(applies ? { applies } : {}) }));
    assert.deepEqual(outcome(r2), CHANGED, cause);
    const before = occ(h, [M(11, 59), M(12), M(15)]);
    const entries = logKinds(h).length;
    const again = await endLeg(h, first);
    assert.deepEqual(outcome(again), CHANGED, cause);
    assert.equal(seqOf(again), seqOf(r1), `${cause}: the recorded reply has the stamp of its entry`);
    assert.deepEqual(occ(h, [M(11, 59), M(12), M(15)]), before, `${cause}: occupancy does not change`);
    assert.deepEqual(before, [[M(11, 59), 4, 4], [M(12), 0, 0], [M(15), 0, 0]]);
    assert.equal(logKinds(h).length, entries, `${cause}: no entry`);
  }
});

test('C02 6 reduce_parts, each cause: an applied lower change id sent again after a higher one gets its recorded CHANGED and changes nothing', async () => {
  for (const cause of ['DECREASE', 'POL07'] as const) {
    const h = await withR();
    const applies = cause === 'POL07' ? OTHER_LINK_PAIR : undefined;
    const first = reduceCmd(h, { change: 100n, cause, parts: [['p1', [{ from: M(10, 1), rateMbps: 3 }]]], ...(applies ? { applies } : {}) });
    const r1 = await reduce(h, first);
    assert.deepEqual(outcome(r1), CHANGED, cause);
    assert.deepEqual(outcome(await reduce(h, reduceCmd(h, { change: 101n, cause, parts: [['p1', [{ from: M(10, 1), rateMbps: 1 }]]], ...(applies ? { applies } : {}) }))), CHANGED);
    const entries = logKinds(h).length;
    const again = await reduce(h, first);
    assert.deepEqual(outcome(again), CHANGED, cause);
    assert.equal(seqOf(again), seqOf(r1));
    assert.deepEqual(occ(h, [M(10), M(10, 1), M(17, 59), M(18)]), [[M(10), 4, 4], [M(10, 1), 1, 1], [M(17, 59), 1, 1], [M(18), 0, 0]], `${cause}: the rate stays 1 Mbps`);
    assert.equal(logKinds(h).length, entries, `${cause}: no entry`);
  }
});

test('C02 6 end_leg and reduce_parts, each cause: a lower change id that the link never applied gets STALE_CHANGE(lastApplied), and occupancy does not change', async () => {
  const cases: Array<[string, (h: Harness, change: bigint) => Promise<LegChangeReply>]> = [
    ...END_CAUSES.map((cause): [string, (h: Harness, change: bigint) => Promise<LegChangeReply>] => [`end_leg ${cause}`,
      (h, change) => endLeg(h, endLegCmd(h, { change, from: M(11), cause, ...(cause === 'POL07' ? { applies: OTHER_LINK_PAIR } : {}) }))]),
    ...(['DECREASE', 'POL07'] as const).map((cause): [string, (h: Harness, change: bigint) => Promise<LegChangeReply>] => [`reduce_parts ${cause}`,
      (h, change) => reduce(h, reduceCmd(h, { change, cause, parts: [['p1', [{ from: M(11), rateMbps: 0 }]]], ...(cause === 'POL07' ? { applies: OTHER_LINK_PAIR } : {}) }))]),
  ];
  for (const [name, send] of cases) {
    const h = await withR();
    assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 100n, from: M(15), cause: 'SHORTEN' }))), CHANGED);
    const before = occ(h, [M(10, 30), M(11), M(14, 59), M(15)]);
    const entries = logKinds(h).length;
    const r = await send(h, 99n);
    assert.deepEqual(outcome(r), stale(100n), name);
    assert.equal(seqOf(r), h.rt.log(utf8(h.link)).at(-1)?.seq, `${name}: STALE_CHANGE has the link stamp of the applied head`);
    assert.deepEqual(occ(h, [M(10, 30), M(11), M(14, 59), M(15)]), before, `${name}: no effect`);
    assert.deepEqual(before, [[M(10, 30), 4, 4], [M(11), 4, 4], [M(14, 59), 4, 4], [M(15), 0, 0]]);
    assert.equal(logKinds(h).length, entries, `${name}: no entry`);
    assert.equal(h.owner.alerts.length, 0, `${name}: the link does not alert a STALE_CHANGE`);
  }
});

test('C02 6 reduce_parts: absolute pieces are clipped to the window of the part', async () => {
  const h = await withR();
  // Pieces from 08:00 (before the window) to 19:00 (after it): only [09:00, 18:00) of p1 changes.
  const r = await reduce(h, reduceCmd(h, { change: 100n, parts: [['p1', [
    { from: M(8), rateMbps: 3 }, { from: M(12), rateMbps: 2 }, { from: M(19), rateMbps: 1 },
  ]]] }));
  assert.deepEqual(outcome(r), CHANGED);
  assert.deepEqual(occ(h, [M(8, 59), M(9), M(11, 59), M(12), M(17, 59), M(18), M(19)]),
    [[M(8, 59), 0, 0], [M(9), 3, 3], [M(11, 59), 3, 3], [M(12), 2, 2], [M(17, 59), 2, 2], [M(18), 0, 0], [M(19), 0, 0]]);
  const part = h.owner.stateOf(h.link)?.partsInOrder().find((p) => p.part === 'p1');
  assert.deepEqual(part?.pieces, [{ from: M(9), rateMbps: 3 }, { from: M(12), rateMbps: 2 }]);
});

test('should set the rate with reduce_parts (C02: never a decrement): the same pieces twice under two change ids leave the same rate', async () => {
  const h = await withR();
  for (const change of [100n, 101n]) {
    assert.deepEqual(outcome(await reduce(h, reduceCmd(h, { change, parts: [['p1', [{ from: M(10, 1), rateMbps: 2 }]]] }))), CHANGED);
  }
  assert.deepEqual(occ(h, [M(10), M(10, 1), M(17, 59)]), [[M(10), 4, 4], [M(10, 1), 2, 2], [M(17, 59), 2, 2]]);
});

test('should end the reduced rate with an end_leg after a reduce_parts, and change only the minutes left with a reduce_parts after an end_leg', async () => {
  const h = await withR();
  assert.deepEqual(outcome(await reduce(h, reduceCmd(h, { change: 100n, parts: [['p1', [{ from: M(11), rateMbps: 1 }]]] }))), CHANGED);
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 101n, from: M(14), cause: 'SHORTEN' }))), CHANGED);
  assert.deepEqual(outcome(await reduce(h, reduceCmd(h, { change: 102n, parts: [['p1', [{ from: M(10, 30), rateMbps: 2 }, { from: M(11), rateMbps: 1 }]]] }))), CHANGED);
  assert.deepEqual(occ(h, [M(10, 29), M(10, 30), M(10, 59), M(11), M(13, 59), M(14), M(17, 59)]),
    [[M(10, 29), 4, 4], [M(10, 30), 2, 2], [M(10, 59), 2, 2], [M(11), 1, 1], [M(13, 59), 1, 1], [M(14), 0, 0], [M(17, 59), 0, 0]]);
  assert.deepEqual(h.owner.stateOf(h.link)?.partsInOrder()[0]?.pieces, [{ from: M(9), rateMbps: 4 }, { from: M(10, 30), rateMbps: 2 }, { from: M(11), rateMbps: 1 }]);
});

test('should answer MISMATCH to a change id of a partition that does not own the leg (C02 rule 4; the owner by DI-37), and change nothing', async () => {
  const h = await withR();
  const entries = logKinds(h).length;
  assert.deepEqual(await endLeg(h, endLegCmd(h, { change: 100n, from: M(10, 1), account: 'other' })), { code: 'MISMATCH' });
  assert.deepEqual(await reduce(h, reduceCmd(h, { change: 100n, parts: [['p1', [{ from: M(10, 1), rateMbps: 0 }]]], account: 'other' })), { code: 'MISMATCH' });
  assert.equal(logKinds(h).length, entries);
  assert.deepEqual(occ(h, [M(10, 1)]), [[M(10, 1), 4, 4]]);
  assert.deepEqual(h.owner.alerts.map((a) => a.kind), ['MISMATCH', 'MISMATCH']);
});

test('should answer MISMATCH to an applied change id with another body (C02 "Idempotency"), write nothing, and keep the recorded change', async () => {
  const h = await withR();
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 100n, from: M(12), cause: 'SHORTEN' }))), CHANGED);
  const entries = logKinds(h).length;
  assert.deepEqual(await endLeg(h, endLegCmd(h, { change: 100n, from: M(11), cause: 'SHORTEN' })), { code: 'MISMATCH' });
  assert.deepEqual(await reduce(h, reduceCmd(h, { change: 100n, parts: [['p1', [{ from: M(11), rateMbps: 0 }]]] })), { code: 'MISMATCH' });
  assert.equal(logKinds(h).length, entries, 'no entry');
  assert.deepEqual(occ(h, [M(11, 59), M(12)]), [[M(11, 59), 4, 4], [M(12), 0, 0]]);
  assert.deepEqual(h.owner.alerts.map((a) => a.kind), ['MISMATCH', 'MISMATCH']);
});

test('C02 joint an account-owner takeover between two changes of one leg: the change sent again by the new holder with a new sender epoch gets its recorded CHANGED (a duplicate, not a MISMATCH)', async () => {
  const h = await withR();
  const cmd = endLegCmd(h, { change: 100n, from: M(12), cause: 'SHORTEN' });
  const r1 = await endLeg(h, cmd, 1n);
  const r2 = await endLeg(h, cmd, 2n);
  assert.deepEqual([outcome(r2), seqOf(r2)], [CHANGED, seqOf(r1)]);
  assert.equal(logKinds(h).filter((k) => k === ENTRY.EndLeg).length, 1);
});

test('should answer UNKNOWN_RESERVATION to a leg change for a (reservation, leg) with no part, and write nothing', async () => {
  const h = await withR();
  const entries = logKinds(h).length;
  assert.deepEqual(await endLeg(h, endLegCmd(h, { change: 100n, from: M(12), reservation: 'R-unknown' })), { code: 'UNKNOWN_RESERVATION' });
  assert.deepEqual(await reduce(h, reduceCmd(h, { change: 100n, parts: [['p1', [{ from: M(12), rateMbps: 0 }]]], leg: 'leg-9' })), { code: 'UNKNOWN_RESERVATION' });
  assert.equal(logKinds(h).length, entries);
  assert.deepEqual(h.owner.alerts.map((a) => a.kind), ['UNKNOWN_RESERVATION', 'UNKNOWN_RESERVATION']);
});

test('should answer UNKNOWN_PART to a reduce_parts that names a part not on the leg, and change no part', async () => {
  const h = await withR();
  const r = await reduce(h, reduceCmd(h, { change: 100n, parts: [['p1', [{ from: M(12), rateMbps: 0 }]], ['p-none', [{ from: M(12), rateMbps: 0 }]]] }));
  assert.deepEqual(r, { code: 'UNKNOWN_PART' });
  assert.deepEqual(occ(h, [M(12)]), [[M(12), 4, 4]]);
  assert.deepEqual(h.owner.alerts.map((a) => a.kind), ['UNKNOWN_PART']);
  // Not applied: the same change id with a correct body is still applied later.
  assert.deepEqual(outcome(await reduce(h, reduceCmd(h, { change: 100n, parts: [['p1', [{ from: M(12), rateMbps: 0 }]]] }))), CHANGED);
});

test('should refuse INVALID(pieces) when a reduce_parts raises a rate at one minute, and change nothing (DI-33)', async () => {
  const h = await withR();
  assert.deepEqual(outcome(await reduce(h, reduceCmd(h, { change: 100n, parts: [['p1', [{ from: M(14), rateMbps: 2 }]]] }))), CHANGED);
  const entries = logKinds(h).length;
  const r = await reduce(h, reduceCmd(h, { change: 101n, parts: [['p1', [{ from: M(13), rateMbps: 1 }, { from: M(17), rateMbps: 3 }]]] }));
  assert.deepEqual(r, { code: 'INVALID', field: 'pieces' });
  assert.equal(logKinds(h).length, entries);
  assert.deepEqual(occ(h, [M(13), M(14), M(17)]), [[M(13), 4, 4], [M(14), 2, 2], [M(17), 2, 2]]);
  // A piece equal to the present rate is not a raise.
  assert.deepEqual(outcome(await reduce(h, reduceCmd(h, { change: 102n, parts: [['p1', [{ from: M(13), rateMbps: 4 }, { from: M(14), rateMbps: 2 }]]] }))), CHANGED);
});

test('should refuse INVALID(pieces) and INVALID(fromMinute) for malformed minutes and pieces, and write nothing (DI-32)', async () => {
  const h = await withR();
  const entries = logKinds(h).length;
  const bad: Piece[][] = [[], [{ from: M(12) + 0.5, rateMbps: 1 }], [{ from: M(12), rateMbps: -1 }], [{ from: M(12), rateMbps: 1.5 }],
    [{ from: M(12), rateMbps: 1 }, { from: M(12), rateMbps: 0 }], [{ from: M(13), rateMbps: 1 }, { from: M(12), rateMbps: 0 }]];
  for (const pieces of bad) {
    assert.deepEqual(await reduce(h, reduceCmd(h, { change: 100n, parts: [['p1', pieces]] })), { code: 'INVALID', field: 'pieces' }, JSON.stringify(pieces));
  }
  assert.deepEqual(await reduce(h, reduceCmd(h, { change: 100n, parts: [['p1', [{ from: M(12), rateMbps: 1 }]], ['p1', [{ from: M(13), rateMbps: 0 }]]] })),
    { code: 'INVALID', field: 'pieces' }, 'a part named twice');
  assert.deepEqual(await reduce(h, reduceCmd(h, { change: 100n, parts: [] })), { code: 'INVALID', field: 'pieces' }, 'no part');
  assert.deepEqual(await endLeg(h, endLegCmd(h, { change: 100n, from: M(12) + 0.5 })), { code: 'INVALID', field: 'fromMinute' });
  assert.equal(logKinds(h).length, entries);
  assert.deepEqual(occ(h, [M(12), M(13)]), [[M(12), 4, 4], [M(13), 4, 4]]);
});

// ---------------- C02 provider test 7: the convert backstop ----------------

test('C02 7 a convert whose createdBy is below the change id of an applied end_leg is clipped at that end, returns clippedAt and alerts CONVERT_AFTER_END', async () => {
  const h = await withR();
  // p3 [12:00, 20:00) is held (E5 at 105), but a defect sends its convert after the end_leg at 110.
  const p3 = partCmds(h, { rate: 3, window: { start: M(12), end: M(20) }, part: 'p3', createdBy: 105n, kind: 'change' });
  assert.equal(resultOf(await h.stub.hold(p3.hold)), 'HELD');
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 110n, from: M(15), cause: 'SHORTEN' }))), CHANGED);
  const r = await h.stub.convert(p3.convert);
  assert.deepEqual(outcome(r), { result: 'CONVERTED', part: 'p3', clippedAt: M(15) });
  assert.deepEqual(h.owner.alerts.map((a) => a.kind), ['CONVERT_AFTER_END']);
  assert.deepEqual(occ(h, [M(11, 59), M(12), M(14, 59), M(15), M(19, 59)]),
    [[M(11, 59), 4, 4], [M(12), 7, 7], [M(14, 59), 7, 7], [M(15), 0, 0], [M(19, 59), 0, 0]]);
  // A repeat gets CONVERTED with the same clippedAt (C02 "Idempotency").
  const again = await h.stub.convert(p3.convert);
  assert.deepEqual([outcome(again), seqOf(again)], [{ result: 'CONVERTED', part: 'p3', clippedAt: M(15) }, seqOf(r)]);
  assert.deepEqual(outcome(await h.stub.hold(p3.hold)), { result: 'CONVERTED', part: 'p3' });
});

test('C02 7 a convert whose createdBy is above the change id of every applied end_leg is not clipped', async () => {
  const h = await withR();
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 100n, from: M(12), cause: 'SHORTEN' }))), CHANGED);
  const p3 = partCmds(h, { rate: 4, window: { start: M(12), end: M(20) }, part: 'p3', createdBy: 105n, kind: 'change' });
  assert.equal(resultOf(await h.stub.hold(p3.hold)), 'HELD');
  const r: ConvertReply = await h.stub.convert(p3.convert);
  assert.deepEqual(outcome(r), { result: 'CONVERTED', part: 'p3' });
  assert.equal(h.owner.alerts.length, 0);
  assert.deepEqual(occ(h, [M(11, 59), M(12), M(19, 59), M(20)]), [[M(11, 59), 4, 4], [M(12), 4, 4], [M(19, 59), 4, 4], [M(20), 0, 0]]);
});

test('C02 7 the clip takes the earliest end of the applied end_legs above createdBy, and a clip at or before the start leaves the part empty', async () => {
  const h = await withR();
  const p3 = partCmds(h, { rate: 3, window: { start: M(12), end: M(20) }, part: 'p3', createdBy: 105n, kind: 'change' });
  assert.equal(resultOf(await h.stub.hold(p3.hold)), 'HELD');
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 100n, from: M(11), cause: 'SHORTEN' }))), CHANGED);
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 110n, from: M(17), cause: 'SHORTEN' }))), CHANGED);
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 120n, from: M(16), cause: 'SHORTEN' }))), CHANGED);
  assert.deepEqual(outcome(await h.stub.convert(p3.convert)), { result: 'CONVERTED', part: 'p3', clippedAt: M(16) });
  assert.deepEqual(occ(h, [M(12), M(15, 59), M(16)]), [[M(12), 3, 3], [M(15, 59), 3, 3], [M(16), 0, 0]]);

  const p4 = partCmds(h, { rate: 2, window: { start: M(18), end: M(19) }, part: 'p4', createdBy: 106n, kind: 'change' });
  assert.equal(resultOf(await h.stub.hold(p4.hold)), 'HELD');
  assert.deepEqual(outcome(await h.stub.convert(p4.convert)), { result: 'CONVERTED', part: 'p4', clippedAt: M(16) });
  assert.deepEqual(occ(h, [M(18), M(18, 59)]), [[M(18), 0, 0], [M(18, 59), 0, 0]], 'the part never holds capacity');
});

test('C02 7 a clipped convert of an open-ended hold removes the hold from occ_all after the clip minute', async () => {
  const h = await withR();
  const p3 = partCmds(h, { rate: 3, window: { start: M(12), end: null }, part: 'p3', createdBy: 105n, kind: 'change' });
  assert.equal(resultOf(await h.stub.hold(p3.hold)), 'HELD');
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 110n, from: M(15), cause: 'SHORTEN' }))), CHANGED);
  assert.deepEqual(occ(h, [M(15), M(1000 * 60)]), [[M(15), 0, 3], [M(1000 * 60), 0, 3]], 'the hold is in occ_all before the convert');
  assert.deepEqual(outcome(await h.stub.convert(p3.convert)), { result: 'CONVERTED', part: 'p3', clippedAt: M(15) });
  assert.deepEqual(occ(h, [M(14, 59), M(15), M(1000 * 60)]), [[M(14, 59), 7, 7], [M(15), 0, 0], [M(1000 * 60), 0, 0]]);
});

// ---------------- C02 provider test 8: applies ----------------

test('C02 8 cause POL07 without applies gets INVALID(applies), and nothing changes', async () => {
  const h = await withR();
  const entries = logKinds(h).length;
  assert.deepEqual(await endLeg(h, endLegCmd(h, { change: 100n, from: M(12), cause: 'POL07' })), { code: 'INVALID', field: 'applies' });
  assert.deepEqual(await reduce(h, reduceCmd(h, { change: 100n, cause: 'POL07', parts: [['p1', [{ from: M(12), rateMbps: 1 }]]] })), { code: 'INVALID', field: 'applies' });
  assert.equal(logKinds(h).length, entries);
  assert.deepEqual(occ(h, [M(12)]), [[M(12), 4, 4]]);
  assert.deepEqual(h.owner.alerts.map((a) => a.kind), ['INVALID', 'INVALID']);
});

test('C02 8 applies with another cause gets INVALID(applies), and nothing changes', async () => {
  const h = await withR();
  const entries = logKinds(h).length;
  for (const cause of ['CANCEL', 'SHORTEN', 'RELEASE', 'TERMINATE', 'MOVE'] as const) {
    assert.deepEqual(await endLeg(h, endLegCmd(h, { change: 100n, from: M(12), cause, applies: OTHER_LINK_PAIR })), { code: 'INVALID', field: 'applies' }, cause);
  }
  assert.deepEqual(await reduce(h, reduceCmd(h, { change: 100n, cause: 'DECREASE', applies: OTHER_LINK_PAIR, parts: [['p1', [{ from: M(12), rateMbps: 1 }]]] })),
    { code: 'INVALID', field: 'applies' });
  assert.deepEqual(await endLeg(h, endLegCmd(h, { change: 100n, from: M(12), cause: 'CANCEL', applies: [] })), { code: 'INVALID', field: 'applies' }, 'an empty list is present');
  assert.equal(logKinds(h).length, entries);
  assert.deepEqual(occ(h, [M(12)]), [[M(12), 4, 4]]);
});

test('should answer UNKNOWN_REDUCTION to a POL07 change that names a reduction of this link, which the link does not have', async () => {
  const h = await withR();
  const entries = logKinds(h).length;
  const r = await endLeg(h, endLegCmd(h, { change: 100n, from: M(12), cause: 'POL07', applies: [...OTHER_LINK_PAIR, { link: h.link, reduction: 3n }] }));
  assert.deepEqual(r, { code: 'UNKNOWN_REDUCTION' });
  assert.equal(logKinds(h).length, entries, 'no entry');
  assert.deepEqual(occ(h, [M(12)]), [[M(12), 4, 4]]);
  assert.deepEqual(h.owner.alerts.map((a) => a.kind), ['UNKNOWN_REDUCTION']);
});

// ---------------- check order (DI-35) and the leg owner (DI-37) ----------------

test('should apply the DI-35 check order when a command breaks two checks', async () => {
  const h = await withR();
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 100n, from: M(15), cause: 'SHORTEN' }))), CHANGED);
  const entries = logKinds(h).length;
  const raise: [string, Piece[]] = ['p1', [{ from: M(11), rateMbps: 5 }]];
  const none: [string, Piece[]] = ['p-none', [{ from: M(11), rateMbps: 0 }]];
  const cases: Array<[string, () => Promise<LegChangeReply>, unknown]> = [
    ['unknown leg before rule 4', () => endLeg(h, endLegCmd(h, { change: 99n, from: M(12), reservation: 'R-unknown', account: 'other' })), { code: 'UNKNOWN_RESERVATION' }],
    ['rule 1 (another body) before INVALID(applies)', () => endLeg(h, endLegCmd(h, { change: 100n, from: M(15), cause: 'POL07' })), { code: 'MISMATCH' }],
    ['rule 4 before rule 3', () => endLeg(h, endLegCmd(h, { change: 99n, from: M(12), account: 'other' })), { code: 'MISMATCH' }],
    ['rule 4 before INVALID(applies)', () => endLeg(h, endLegCmd(h, { change: 101n, from: M(12), cause: 'POL07', account: 'other' })), { code: 'MISMATCH' }],
    ['INVALID(applies) before rule 3', () => endLeg(h, endLegCmd(h, { change: 99n, from: M(12), cause: 'POL07' })), { code: 'INVALID', field: 'applies' }],
    ['INVALID(applies) before malformed pieces', () => reduce(h, reduceCmd(h, { change: 101n, cause: 'POL07', parts: [['p1', []]] })), { code: 'INVALID', field: 'applies' }],
    ['malformed pieces before rule 3', () => reduce(h, reduceCmd(h, { change: 99n, parts: [['p1', []]] })), { code: 'INVALID', field: 'pieces' }],
    ['malformed minute before rule 3', () => endLeg(h, endLegCmd(h, { change: 99n, from: M(12) + 0.5 })), { code: 'INVALID', field: 'fromMinute' }],
    ['rule 3 before UNKNOWN_PART', () => reduce(h, reduceCmd(h, { change: 99n, parts: [none] })), stale(100n)],
    ['rule 3 before a raise', () => reduce(h, reduceCmd(h, { change: 99n, parts: [raise] })), stale(100n)],
    ['UNKNOWN_PART before a raise', () => reduce(h, reduceCmd(h, { change: 101n, parts: [raise, none] })), { code: 'UNKNOWN_PART' }],
    ['a raise before UNKNOWN_REDUCTION', () => reduce(h, reduceCmd(h, { change: 101n, cause: 'POL07', applies: [{ link: h.link, reduction: 3n }], parts: [raise] })), { code: 'INVALID', field: 'pieces' }],
  ];
  for (const [name, send, want] of cases) assert.deepEqual(outcome(await send()), want, name);
  assert.equal(logKinds(h).length, entries, 'no entry');
  assert.deepEqual(occ(h, [M(11), M(14, 59), M(15)]), [[M(11), 4, 4], [M(14, 59), 4, 4], [M(15), 0, 0]]);
});

test('should keep the owner of the first part when a later part of the leg comes from a hold of another account (DI-37)', async () => {
  const h = await withR();
  await confirm(h, { rate: 2, window: { start: M(12), end: M(14) }, part: 'p2', createdBy: 70n, kind: 'change', account: 'other' });
  assert.deepEqual(await endLeg(h, endLegCmd(h, { change: 100n, from: M(12), account: 'other' })), { code: 'MISMATCH' });
  assert.deepEqual(await reduce(h, reduceCmd(h, { change: 100n, parts: [['p2', [{ from: M(12), rateMbps: 0 }]]], account: 'other' })), { code: 'MISMATCH' });
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 101n, from: M(12) }))), CHANGED);
  assert.deepEqual(occ(h, [M(11, 59), M(12), M(13, 59)]), [[M(11, 59), 4, 4], [M(12), 0, 0], [M(13, 59), 0, 0]]);
});

// ---------------- late changes and the scan ----------------

test('should apply a change that arrives after its effective minute as decided, from that minute, and alert LATE_CHANGE', async () => {
  const h = await withR();
  const cmd = endLegCmd(h, { change: 100n, from: M(10, 1), cause: 'CANCEL' });
  h.rt.advance(90_000);   // 10:02:00: the minute 10:01 is past
  assert.deepEqual(outcome(await endLeg(h, cmd)), CHANGED);
  assert.deepEqual(occ(h, [M(10), M(10, 1), M(10, 2)]), [[M(10), 4, 4], [M(10, 1), 0, 0], [M(10, 2), 0, 0]]);
  assert.deepEqual(h.owner.alerts.map((a) => a.kind), ['LATE_CHANGE']);
});

test('should not alert LATE_CHANGE for a change that arrives before its effective minute', async () => {
  const h = await withR();
  h.rt.advance(29_999);   // 10:00:59.999
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 100n, from: M(10, 1) }))), CHANGED);
  assert.deepEqual(outcome(await reduce(h, reduceCmd(h, { change: 101n, parts: [['p1', [{ from: M(10, 1), rateMbps: 0 }]]] }))), CHANGED);
  assert.equal(h.owner.alerts.length, 0);
  h.rt.advance(1);        // 10:01:00.000: the minute 10:01 has started
  assert.deepEqual(outcome(await reduce(h, reduceCmd(h, { change: 102n, parts: [['p1', [{ from: M(10, 1), rateMbps: 0 }]]] }))), CHANGED);
  assert.deepEqual(h.owner.alerts.map((a) => a.kind), ['LATE_CHANGE']);
});

test('should alert LATE_CHANGE when the least first from of a reduce_parts with two parts has started (DI-34)', async () => {
  const h = await withR();
  await confirm(h, { rate: 2, window: { start: M(10, 1), end: M(18) }, part: 'p2', createdBy: 105n, kind: 'change' });
  toNow(h);
  h.rt.advance(30_000);   // 10:01:00.000: the minute 10:01 has started, 12:00 has not
  const r = await reduce(h, reduceCmd(h, { change: 110n, parts: [['p2', [{ from: M(12), rateMbps: 1 }]], ['p1', [{ from: M(10, 1), rateMbps: 3 }]]] }));
  assert.deepEqual(outcome(r), CHANGED);
  assert.deepEqual(h.owner.alerts.map((a) => a.kind), ['LATE_CHANGE']);
  assert.deepEqual(occ(h, [M(10), M(10, 1), M(12)]), [[M(10), 4, 4], [M(10, 1), 5, 5], [M(12), 4, 4]]);
});

test('should give the capacity that an end_leg frees to the oldest waiter that it fits, in the end_leg entry (the scan over the freed range)', async () => {
  const h = await withR();
  const a = h.stub.holdCmd({ rate: 6, window: { start: M(13), end: M(14) }, account: 'a' });
  assert.equal(resultOf(await h.stub.hold(a)), 'HELD');
  const older = h.stub.holdCmd({ rate: 2, window: { start: M(13), end: M(14) }, account: 'w1', wait: true });
  const younger = { ...h.stub.holdCmd({ rate: 2, window: { start: M(13), end: M(14) }, account: 'w2', wait: true }), requestAge: older.requestAge };
  const outside = h.stub.holdCmd({ rate: 2, window: { start: M(17), end: M(18) }, account: 'w3', wait: true });
  const b = h.stub.holdCmd({ rate: 6, window: { start: M(17), end: M(18) }, account: 'b' });
  assert.equal(resultOf(await h.stub.hold(b)), 'HELD');
  for (const w of [older, younger, outside]) assert.equal(resultOf(await h.stub.hold(w)), 'WAITING');
  // R ends from 13:00: [13:00, 18:00) has 4 Mbps more room, so both waiters on [13:00, 14:00) fit (6 + 2 + 2 = 10), and so does
  // the waiter on [17:00, 18:00) (6 + 2 = 8).
  const end = await endLeg(h, endLegCmd(h, { change: 100n, from: M(13), cause: 'SHORTEN' }));
  assert.deepEqual(outcome(end), CHANGED);
  const granted = h.pushed.filter((n) => n.id.kind === 'GRANTED');
  assert.deepEqual(granted.map((n) => (n.body as { linkSeq: bigint }).linkSeq), [seqOf(end), seqOf(end), seqOf(end)], 'the grants are in the end_leg entry');
  assert.deepEqual(outcome(await h.stub.hold(older)), { result: 'HELD', attempt: 1 });
  assert.deepEqual(outcome(await h.stub.hold(younger)), { result: 'HELD', attempt: 1 });
  assert.deepEqual(outcome(await h.stub.hold(outside)), { result: 'HELD', attempt: 1 });
  assert.deepEqual(occ(h, [M(12, 59), M(13), M(17)]), [[M(12, 59), 4, 4], [M(13), 0, 10], [M(17), 0, 8]]);
});

test('should scan only the waiters that overlap the freed range of an end_leg', async () => {
  const h = await withR();
  const a = h.stub.holdCmd({ rate: 6, window: { start: M(10, 30), end: M(11) }, account: 'a' });

test('should count only the waiters that overlap the freed range of an end_leg in the scan budget (no Tick entry)', async () => {
  const h = await withR('L1', { ...DEFAULT_POLICY, scanSteps: 1 });
  const a = h.stub.holdCmd({ rate: 6, window: { start: M(10, 30), end: M(11) }, account: 'a' });
  assert.equal(resultOf(await h.stub.hold(a)), 'HELD');
  for (const account of ['w1', 'w2']) {
    assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 2, window: { start: M(10, 30), end: M(11) }, account, wait: true }))), 'WAITING');
  }
  // The end frees [11:00, 18:00). With a budget of 1 step, a scan that examined the two waiters on [10:30, 11:00)
  // would continue in a Tick entry.
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 100n, from: M(11), cause: 'SHORTEN' }))), CHANGED);
  assert.deepEqual(logKinds(h).slice(-1), [ENTRY.EndLeg]);
  assert.ok(!logKinds(h).includes(ENTRY.Tick));
  assert.deepEqual(h.pushed, []);
});
  assert.equal(resultOf(await h.stub.hold(a)), 'HELD');
  const w = h.stub.holdCmd({ rate: 2, window: { start: M(10, 30), end: M(11) }, account: 'w', wait: true });
  assert.deepEqual(outcome(await h.stub.hold(w)), { result: 'WAITING', attempt: 1, aheadDeadline: a.deadline });
  // The end frees [11:00, 18:00): the waiter on [10:30, 11:00) is not examined and still waits.
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 100n, from: M(11), cause: 'SHORTEN' }))), CHANGED);
  assert.deepEqual(h.pushed, []);
  assert.deepEqual(outcome(await h.stub.hold(w)), { result: 'WAITING', attempt: 1, aheadDeadline: a.deadline });
});

test('should give the capacity that a reduce_parts frees to a waiter, in the reduce_parts entry', async () => {
  const h = await withR();
  const a = h.stub.holdCmd({ rate: 6, window: { start: M(12), end: M(13) }, account: 'a' });
  assert.equal(resultOf(await h.stub.hold(a)), 'HELD');
  const w = h.stub.holdCmd({ rate: 2, window: { start: M(12), end: M(13) }, account: 'w', wait: true });
  assert.deepEqual(outcome(await h.stub.hold(w)), { result: 'WAITING', attempt: 1, aheadDeadline: a.deadline });
  const r = await reduce(h, reduceCmd(h, { change: 100n, parts: [['p1', [{ from: M(11), rateMbps: 2 }]]] }));
  assert.deepEqual(outcome(r), CHANGED);
  const granted = h.pushed.filter((n) => n.id.kind === 'GRANTED');
  assert.deepEqual(granted.map((n) => (n.body as { linkSeq: bigint }).linkSeq), [seqOf(r)]);
  assert.deepEqual(occ(h, [M(12)]), [[M(12), 2, 10]]);
});

test('should rebuild leg changes, clips and recorded change replies by replay after a takeover, with no outcome difference', async () => {
  const h = await withR();
  assert.deepEqual(outcome(await reduce(h, reduceCmd(h, { change: 100n, parts: [['p1', [{ from: M(11), rateMbps: 2 }]]] }))), CHANGED);
  const p3 = partCmds(h, { rate: 3, window: { start: M(12), end: M(20) }, part: 'p3', createdBy: 105n, kind: 'change' });
  assert.equal(resultOf(await h.stub.hold(p3.hold)), 'HELD');
  const end = endLegCmd(h, { change: 110n, from: M(15), cause: 'SHORTEN' });
  const r1 = await endLeg(h, end);
  assert.deepEqual(outcome(await h.stub.convert(p3.convert)), { result: 'CONVERTED', part: 'p3', clippedAt: M(15) });
  const before = occ(h, [M(10, 59), M(11), M(12), M(14, 59), M(15), M(19)]);
  await h.rt.takeover(h.rt.route('link', utf8(h.link)).slot);
  const again = await endLeg(h, end);
  assert.deepEqual([outcome(again), seqOf(again)], [CHANGED, seqOf(r1)]);
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 109n, from: M(14) }))), stale(110n));
  assert.deepEqual(outcome(await h.stub.convert(p3.convert)), { result: 'CONVERTED', part: 'p3', clippedAt: M(15) });
  assert.deepEqual(occ(h, [M(10, 59), M(11), M(12), M(14, 59), M(15), M(19)]), before);
  assert.deepEqual(before, [[M(10, 59), 4, 4], [M(11), 2, 2], [M(12), 5, 5], [M(14, 59), 5, 5], [M(15), 0, 0], [M(19), 0, 0]]);
  assert.ok(!h.owner.alerts.some((a) => a.kind === 'OUTCOME_MISMATCH_ON_REPLAY'));
});

test('should write one EndLeg entry and one ReduceParts entry with the command, the outcome and the sender fence', async () => {
  const h = await withR();
  const e = endLegCmd(h, { change: 100n, from: M(15), cause: 'SHORTEN' });
  const r = reduceCmd(h, { change: 101n, parts: [['p1', [{ from: M(11), rateMbps: 2 }]]] });
  await endLeg(h, e);
  await reduce(h, r);
  const log = h.rt.log(utf8(h.link)).slice(-2);
  assert.deepEqual(log.map((x) => x.entry.kind), [ENTRY.EndLeg, ENTRY.ReduceParts]);
  assert.deepEqual(log.map((x) => (x.entry.payload as { op: string; outcome: unknown }).op), ['end_leg', 'reduce_parts']);
  assert.deepEqual(log.map((x) => (x.entry.payload as { outcome: unknown }).outcome), [CHANGED, CHANGED]);
  assert.deepEqual(log.map((x) => Buffer.from(x.entry.identity).toString()),
    [`end_leg:R|leg-1|${Buffer.from(ACCT).toString('hex')}:100`, `reduce_parts:R|leg-1|${Buffer.from(ACCT).toString('hex')}:101`]);
  assert.ok(log.every((x) => x.entry.senderFence !== undefined));
});

// ---------------- C02 joint traces against the stub (exit criterion 2) ----------------

test('C02 joint shorten, then extend: L holds p3 [12:00, 20:00), also when a new account-owner holder sends both commands again', async () => {
  for (const takeover of [false, true]) {
    const h = await withR();
    const shorten = endLegCmd(h, { change: 100n, from: M(12), cause: 'SHORTEN' });
    const ext = partCmds(h, { rate: 4, window: { start: M(12), end: M(20) }, part: 'p3', createdBy: 105n, kind: 'change' });
    assert.deepEqual(outcome(await endLeg(h, shorten)), CHANGED);
    assert.equal(resultOf(await h.stub.hold(ext.hold)), 'HELD');
    assert.deepEqual(outcome(await h.stub.convert(ext.convert)), { result: 'CONVERTED', part: 'p3' });
    if (takeover) {
      // The new holder (sender epoch 2) sends the pending commands again in the order of their deciding entries.
      assert.deepEqual(outcome(await endLeg(h, shorten, 2n)), CHANGED);
      const env = h.stub.envelope(ACCT);
      env.sender.epoch = 2n;
      assert.deepEqual(outcome(await h.stub.convert(ext.convert, env)), { result: 'CONVERTED', part: 'p3' });
    }
    assert.deepEqual(occ(h, [M(11, 59), M(12), M(19, 59), M(20)]), [[M(11, 59), 4, 4], [M(12), 4, 4], [M(19, 59), 4, 4], [M(20), 0, 0]], `takeover ${takeover}`);
    assert.equal(h.owner.alerts.length, 0, `takeover ${takeover}: no CONVERT_AFTER_END`);
  }
});

test('C02 joint P2-S94 row 2 with a late convert: L ends p3 with the shorten', async () => {
  const h = await withR();
  // The extension's p3 [18:00, 20:00) (E5 at 105) is held; its convert is answered MOVING, and the queued
  // shorten (E11 at 110) waits for CONVERTED.
  const ext = partCmds(h, { rate: 4, window: { start: M(18), end: M(20) }, part: 'p3', createdBy: 105n, kind: 'change' });
  assert.equal(resultOf(await h.stub.hold(ext.hold)), 'HELD');
  h.rt.scriptAppend(RESULTS.Moving());
  assert.equal(resultOf(await h.stub.convert(ext.convert)), 'MOVING');
  assert.deepEqual(outcome(await h.stub.convert(ext.convert)), { result: 'CONVERTED', part: 'p3' });
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 110n, from: M(12), cause: 'SHORTEN' }))), CHANGED);
  assert.deepEqual(occ(h, [M(11, 59), M(12), M(18), M(19, 59)]), [[M(11, 59), 4, 4], [M(12), 0, 0], [M(18), 0, 0], [M(19, 59), 0, 0]]);
  assert.equal(h.owner.alerts.length, 0);
});

test('C02 joint confirm, then cancel, with convert answered MOVING: L ends p1 at 10:01 (P2-S43)', async () => {
  const h = await at0830();
  toNow(h);
  const r4 = partCmds(h, { rate: 4, window: { start: M(10, 1), end: M(18) }, part: 'p1', createdBy: 200n, reservation: 'R4' });
  assert.equal(resultOf(await h.stub.hold(r4.hold)), 'HELD');
  h.rt.scriptAppend(RESULTS.Moving());
  assert.equal(resultOf(await h.stub.convert(r4.convert)), 'MOVING');
  assert.deepEqual(outcome(await h.stub.convert(r4.convert)), { result: 'CONVERTED', part: 'p1' });
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 201n, from: M(10, 1), cause: 'CANCEL', reservation: 'R4' }))), CHANGED);
  assert.deepEqual(occ(h, [M(10, 1), M(17, 59)]), [[M(10, 1), 0, 0], [M(17, 59), 0, 0]]);
});

/** Each append result that refuses the batch after decide ran, and the refusal that the sender gets (C01 §3.2). */
const NOT_COMMITTED: Array<[string, (h: Harness) => void]> = [
  ['MOVING', (h) => h.rt.scriptAppend(decidedThen(h, RESULTS.Moving()))],
  ['MOVED', (h) => h.rt.scriptAppend(decidedThen(h, RESULTS.Moved(3, 1)))],
  ['STALE_EPOCH', (h) => h.rt.scriptAppend(decidedThen(h, RESULTS.StaleEpoch()))],
  ['STOPPED', (h) => h.rt.scriptAppend(decidedThen(h, RESULTS.Stopped()))],
  ['OVERLOADED', (h) => h.rt.scriptAppend(decidedThen(h, RESULTS.Overloaded(50)))],
  // Retry each time the owner proposes the batch (1 + 3 retries): not known to be committed.
  ['UNAVAILABLE', (h) => h.rt.scriptAppend(...[1, 2, 3, 4].map(() => decidedThen(h, RESULTS.Retry())))],
];

test('C02 joint shorten, then cut on one leg, with the first call answered MOVING (and each other refusal of the append): the end_leg sent again ends the leg at 12:00, with one EndLeg entry', async () => {
  for (const [want, script] of NOT_COMMITTED) {
    const h = await withR();
    const shorten = endLegCmd(h, { change: 100n, from: M(12), cause: 'SHORTEN' });
    script(h);
    assert.equal(resultOf(await endLeg(h, shorten)), want);
    await h.owner.idle();
    assert.deepEqual(occ(h, [M(11, 59), M(12)]), [[M(11, 59), 4, 4], [M(12), 4, 4]], `${want}: nothing applied`);
    assert.ok(!logKinds(h).includes(ENTRY.EndLeg), `${want}: no entry`);
    assert.deepEqual(outcome(await endLeg(h, shorten)), CHANGED, want);
    assert.deepEqual(occ(h, [M(11, 59), M(12), M(17, 59)]), [[M(11, 59), 4, 4], [M(12), 0, 0], [M(17, 59), 0, 0]], `${want}: the leg ends at 12:00`);
    assert.equal(logKinds(h).filter((k) => k === ENTRY.EndLeg).length, 1, `${want}: one EndLeg entry`);
    // The cut (another link's POL07 reduction) is applied after the shorten, and changes nothing after 12:00.
    const cut = reduceCmd(h, { change: 101n, cause: 'POL07', applies: OTHER_LINK_PAIR, parts: [['p1', [{ from: M(11), rateMbps: 2 }]]] });
    assert.deepEqual(outcome(await reduce(h, cut)), CHANGED, want);
    assert.deepEqual(occ(h, [M(10, 59), M(11), M(11, 59), M(12)]), [[M(10, 59), 4, 4], [M(11), 2, 2], [M(11, 59), 2, 2], [M(12), 0, 0]], want);
  }
});

test('C02 joint a reduce_parts answered MOVING (and each other refusal of the append), sent again, frees the capacity with one ReduceParts entry', async () => {
  for (const [want, script] of NOT_COMMITTED) {
    const h = await withR();
    const dec = reduceCmd(h, { change: 100n, parts: [['p1', [{ from: M(10, 1), rateMbps: 1 }]]] });
    script(h);
    assert.equal(resultOf(await reduce(h, dec)), want);
    await h.owner.idle();
    assert.deepEqual(occ(h, [M(10, 1)]), [[M(10, 1), 4, 4]], `${want}: nothing applied`);
    assert.deepEqual(h.owner.stateOf(h.link)?.partsInOrder()[0]?.pieces, undefined, `${want}: the part is as it was`);
    assert.deepEqual(outcome(await reduce(h, dec)), CHANGED, want);
    assert.deepEqual(occ(h, [M(10), M(10, 1), M(17, 59)]), [[M(10), 4, 4], [M(10, 1), 1, 1], [M(17, 59), 1, 1]], want);
    assert.equal(logKinds(h).filter((k) => k === ENTRY.ReduceParts).length, 1, `${want}: one ReduceParts entry`);
  }
});

test('C02 joint an end_leg answered MOVING leaves no end: a later convert with createdBy below its change id is not clipped', async () => {
  for (const [want, script] of NOT_COMMITTED) {
    const h = await withR();
    const p3 = partCmds(h, { rate: 3, window: { start: M(12), end: M(20) }, part: 'p3', createdBy: 105n, kind: 'change' });
    assert.equal(resultOf(await h.stub.hold(p3.hold)), 'HELD');
    const end = endLegCmd(h, { change: 110n, from: M(15), cause: 'SHORTEN' });
    script(h);
    assert.equal(resultOf(await endLeg(h, end)), want);
    await h.owner.idle();
    assert.deepEqual(outcome(await h.stub.convert(p3.convert)), { result: 'CONVERTED', part: 'p3' }, `${want}: no clippedAt`);
    assert.ok(!h.owner.alerts.some((a) => a.kind === 'CONVERT_AFTER_END'), want);
    assert.deepEqual(outcome(await endLeg(h, end)), CHANGED, want);
    assert.deepEqual(occ(h, [M(11, 59), M(12), M(14, 59), M(15), M(19, 59)]),
      [[M(11, 59), 4, 4], [M(12), 7, 7], [M(14, 59), 7, 7], [M(15), 0, 0], [M(19, 59), 0, 0]], want);
  }
});

test('C02 joint a decrease and an end on one leg, in both orders, give the same leg (P2-S48)', async () => {
  const results: unknown[] = [];
  for (const order of ['decrease-first', 'end-first'] as const) {
    const h = await withR();
    const dec = (change: bigint) => reduceCmd(h, { change, parts: [['p1', [{ from: M(10, 1), rateMbps: 1 }]]] });
    const end = (change: bigint) => endLegCmd(h, { change, from: M(12), cause: 'SHORTEN' });
    if (order === 'decrease-first') {
      assert.deepEqual(outcome(await reduce(h, dec(100n))), CHANGED);
      assert.deepEqual(outcome(await endLeg(h, end(101n))), CHANGED);
    } else {
      assert.deepEqual(outcome(await endLeg(h, end(100n))), CHANGED);
      assert.deepEqual(outcome(await reduce(h, dec(101n))), CHANGED);
    }
    results.push(occ(h, [M(10), M(10, 1), M(11, 59), M(12), M(17, 59)]));
  }
  assert.deepEqual(results[0], [[M(10), 4, 4], [M(10, 1), 1, 1], [M(11, 59), 1, 1], [M(12), 0, 0], [M(17, 59), 0, 0]]);
  assert.deepEqual(results[1], results[0]);
});

// ---------------- link parts of the P2 scenarios (S-LINK plan §8, I6) ----------------

/** The free capacity at minute t: what a new booking can hold beside held capacity. */
function freeAt(h: Harness, t: number): number {
  return C - (h.owner.stateOf(h.link)?.occAll.value(t) ?? NaN);
}

test('P2-S43 link part: a cancellation ends every part of the leg from 10:01, and the capacity is free from then on L1 and L2', async () => {
  for (const link of ['L1', 'L2']) {
    const h = await withR(link);
    assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 100n, from: M(10, 1), cause: 'CANCEL' }))), CHANGED);
    assert.deepEqual([freeAt(h, M(10)), freeAt(h, M(10, 1)), freeAt(h, M(17, 59))], [6, 10, 10], link);
    const b = await h.stub.book({ rate: 10, window: { start: M(10, 1), end: M(18) }, account: 'other' });
    assert.equal(resultOf(b.convert), 'CONVERTED', link);
  }
});

test('P2-S44 link part: a shortening to 12:00 ends the leg at 12:00, and the capacity is free from 12:00', async () => {
  const h = await withR();
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 100n, from: M(12), cause: 'SHORTEN' }))), CHANGED);
  assert.deepEqual([freeAt(h, M(11, 59)), freeAt(h, M(12)), freeAt(h, M(17, 59))], [6, 10, 10]);
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 7, window: { start: M(11, 59), end: M(12, 1) }, account: 'x' }))), 'REFUSED:"NO_FIT"');
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 10, window: { start: M(12), end: M(18) }, account: 'x' }))), 'HELD');
});

test('P2-S45 link part: an extension is a hold of kind change for the added period only, and becomes a new part with its own age', async () => {
  const h = await withR('L2');
  await confirm(h, { rate: 3, window: { start: M(10, 1), end: M(18) }, part: 'o1', createdBy: 60n, reservation: 'O1', account: 'o' });
  await confirm(h, { rate: 6, window: { start: M(18), end: M(20) }, part: 'o2', createdBy: 61n, reservation: 'O2', account: 'o' });
  const ext = partCmds(h, { rate: 4, window: { start: M(18), end: M(20) }, part: 'p2', createdBy: 105n, kind: 'change' });
  assert.equal(resultOf(await h.stub.hold(ext.hold)), 'HELD', '4 + 6 = 10 on [18:00, 20:00)');
  assert.deepEqual(outcome(await h.stub.convert(ext.convert)), { result: 'CONVERTED', part: 'p2' });
  const parts = h.owner.stateOf(h.link)?.partsInOrder().filter((p) => p.reservation === 'R') ?? [];
  assert.deepEqual(parts.map((p) => [p.part, p.window, p.rateMbps]), [['p1', { start: M(9), end: M(18) }, 4], ['p2', { start: M(18), end: M(20) }, 4]]);
  assert.equal(parts[1]?.age, ext.convert.decisionTime, 'the new part has its own age');
  assert.notEqual(parts[0]?.age, parts[1]?.age);
});

test('P2-S46 link part: a rejected extension leaves the parts of R as they were', async () => {
  const h = await withR('L2');
  await confirm(h, { rate: 8, window: { start: M(18), end: M(20) }, part: 'o1', createdBy: 60n, reservation: 'O1', account: 'o' });
  const ext = partCmds(h, { rate: 4, window: { start: M(18), end: M(20) }, part: 'p2', createdBy: 105n, kind: 'change' });
  assert.equal(resultOf(await h.stub.hold(ext.hold)), 'REFUSED:"NO_FIT"');
  const parts = h.owner.stateOf(h.link)?.partsInOrder().filter((p) => p.reservation === 'R') ?? [];
  assert.deepEqual(parts.map((p) => [p.part, p.window, p.rateMbps, p.pieces]), [['p1', { start: M(9), end: M(18) }, 4, undefined]]);
  assert.deepEqual([freeAt(h, M(9)), freeAt(h, M(17, 59)), freeAt(h, M(18))], [6, 6, 2]);
});

test('P2-S47 link part: an increase is a hold of the difference from 10:01 to the end, and R is 8 Mbps from 10:01 and 4 Mbps before', async () => {
  const h = await withR();
  await confirm(h, { rate: 2, window: { start: M(10, 1), end: M(18) }, part: 'o1', createdBy: 60n, reservation: 'O1', account: 'o' });
  const inc = partCmds(h, { rate: 4, window: { start: M(10, 1), end: M(18) }, part: 'p2', createdBy: 105n, kind: 'change' });
  assert.equal(resultOf(await h.stub.hold(inc.hold)), 'HELD');
  assert.deepEqual(outcome(await h.stub.convert(inc.convert)), { result: 'CONVERTED', part: 'p2' });
  const st = h.owner.stateOf(h.link);
  const r = (t: number): number => (st?.occFirm.value(t) ?? NaN) - (t >= M(10, 1) && t < M(18) ? 2 : 0);
  assert.deepEqual([r(M(10)), r(M(10, 1)), r(M(17, 59))], [4, 8, 8]);
});

test('P2-S74 link part: a rejected increase leaves the parts of R as they were', async () => {
  const h = await withR();
  await confirm(h, { rate: 4, window: { start: M(10, 1), end: M(18) }, part: 'o1', createdBy: 60n, reservation: 'O1', account: 'o' });
  const inc = partCmds(h, { rate: 4, window: { start: M(10, 1), end: M(18) }, part: 'p2', createdBy: 105n, kind: 'change' });
  assert.equal(resultOf(await h.stub.hold(inc.hold)), 'REFUSED:"NO_FIT"');
  const parts = h.owner.stateOf(h.link)?.partsInOrder().filter((p) => p.reservation === 'R') ?? [];
  assert.deepEqual(parts.map((p) => [p.part, p.window, p.rateMbps]), [['p1', { start: M(9), end: M(18) }, 4]]);
});

test('P2-S48 link part: reduce_parts cause DECREASE on the named part makes R 1 Mbps from 10:01, and frees 3 Mbps from 10:01', async () => {
  const h = await withR();
  assert.deepEqual(outcome(await reduce(h, reduceCmd(h, { change: 100n, parts: [['p1', [{ from: M(10, 1), rateMbps: 1 }]]] }))), CHANGED);
  assert.deepEqual([freeAt(h, M(10)), freeAt(h, M(10, 1)), freeAt(h, M(17, 59))], [6, 9, 9]);
});

test('P2-S48 link part: a decrease names its parts newest first; only the named parts change (last in, first out is the account owner\'s)', async () => {
  const h = await withR();
  await confirm(h, { rate: 4, window: { start: M(10, 1), end: M(18) }, part: 'p2', createdBy: 105n, kind: 'change' });
  // R is 8 Mbps from 10:01; a decrease to 3 Mbps removes p2 (the newest) and 1 Mbps of p1.
  const r = await reduce(h, reduceCmd(h, { change: 110n, parts: [['p2', [{ from: M(10, 2), rateMbps: 0 }]], ['p1', [{ from: M(10, 2), rateMbps: 3 }]]] }));
  assert.deepEqual(outcome(r), CHANGED);
  assert.deepEqual([C - freeAt(h, M(10)), C - freeAt(h, M(10, 1)), C - freeAt(h, M(10, 2)), C - freeAt(h, M(17, 59))], [4, 8, 3, 3]);
});

test('P2-S79 link part: changes of one leg apply one at a time in change-id order; each acts on the leg as the change before it left it', async () => {
  const h = await withR();
  const changes: Array<() => Promise<LegChangeReply>> = [
    () => reduce(h, reduceCmd(h, { change: 100n, parts: [['p1', [{ from: M(11), rateMbps: 3 }]]] })),
    () => reduce(h, reduceCmd(h, { change: 101n, parts: [['p1', [{ from: M(12), rateMbps: 2 }]]] })),
    () => endLeg(h, endLegCmd(h, { change: 102n, from: M(16), cause: 'SHORTEN' })),
  ];
  for (const c of changes) assert.deepEqual(outcome(await c()), CHANGED);
  assert.deepEqual([M(10, 59), M(11), M(12), M(15, 59), M(16)].map((t) => C - freeAt(h, t)), [4, 3, 2, 2, 0]);
});

test('P2-S80 link part: when R ends, a pending extension hold is released by its account owner and holds nothing; no part comes after the end', async () => {
  const h = await withR();
  const ext = partCmds(h, { rate: 4, window: { start: M(18), end: M(20) }, part: 'p2', createdBy: 105n, kind: 'change' });
  assert.equal(resultOf(await h.stub.hold(ext.hold)), 'HELD');
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 110n, from: M(10, 1), cause: 'TERMINATE' }))), CHANGED);
  assert.equal(resultOf(await h.stub.release(h.stub.releaseCmd(ext.hold.request, ext.hold.deadline, 'FAILED'))), 'RELEASED');
  assert.deepEqual([M(10, 1), M(18), M(19, 59)].map((t) => C - freeAt(h, t)), [0, 0, 0]);
  assert.deepEqual(outcome(await h.stub.convert(ext.convert)), { code: 'TOMBSTONED' }, 'no capacity is confirmed for R after it ended');
});

test('P2-S81 link part: a cancellation is applied at once while an extension waits, and the waiting extension then holds nothing', async () => {
  const h = await withR('L2');
  const flight = h.stub.holdCmd({ rate: 8, window: { start: M(18), end: M(20) }, account: 'f' });
  assert.equal(resultOf(await h.stub.hold(flight)), 'HELD');
  const ext = partCmds(h, { rate: 4, window: { start: M(18), end: M(20) }, part: 'p2', createdBy: 105n, kind: 'change' });
  const waitHold = { ...ext.hold, wait: true };
  assert.deepEqual(outcome(await h.stub.hold(waitHold)), { result: 'WAITING', attempt: 1, aheadDeadline: flight.deadline });
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 110n, from: M(10, 1), cause: 'CANCEL' }))), CHANGED);
  assert.equal(resultOf(await h.stub.release(h.stub.releaseCmd(waitHold.request, waitHold.deadline, 'FAILED'))), 'RELEASED');
  assert.deepEqual(h.owner.stateOf(h.link)?.waitersInOrder(), []);
  assert.deepEqual([M(10, 1), M(18)].map((t) => C - freeAt(h, t)), [0, 8]);
});

test('P2-S84 link part: a renewal is an extension hold for [18:00, 20:00) only; a shortening to 10:01 or 10:00 ends the leg from 10:01; open-ended is an extension from 18:00', async () => {
  const h = await withR();
  const renew = partCmds(h, { rate: 4, window: { start: M(18), end: M(20) }, part: 'p2', createdBy: 105n, kind: 'change' });
  await confirm(h, { rate: 6, window: { start: M(10, 1), end: M(18) }, part: 'o1', createdBy: 60n, reservation: 'O1', account: 'o' });
  assert.equal(resultOf(await h.stub.hold(renew.hold)), 'HELD', 'decided against [18:00, 20:00) only: [10:01, 18:00) is full');
  // "Shortens R to end at 10:01" and "to end at 10:00" both reach the link as end_leg from 10:01 (the next boundary).
  const short = await withR();
  assert.deepEqual(outcome(await endLeg(short, endLegCmd(short, { change: 100n, from: M(10, 1), cause: 'SHORTEN' }))), CHANGED);
  assert.deepEqual([M(10), M(10, 1)].map((t) => C - freeAt(short, t)), [4, 0]);
  const g = await withR();
  const open = partCmds(g, { rate: 4, window: { start: M(18), end: null }, part: 'p2', createdBy: 105n, kind: 'change' });
  assert.equal(resultOf(await g.stub.hold(open.hold)), 'HELD');
  assert.deepEqual(outcome(await g.stub.convert(open.convert)), { result: 'CONVERTED', part: 'p2' });
  assert.deepEqual([M(17, 59), M(18), M(1000 * 60)].map((t) => C - freeAt(g, t)), [4, 4, 4]);
});

test('P2-S85 link part: an open-ended leg given an end at 14:00 ends there; cancelled before it starts, it holds nothing from 10:01', async () => {
  for (const [from, want] of [[M(14), [4, 4, 0, 0]], [M(10, 1), [0, 0, 0, 0]]] as const) {
    const h = await at0830();
    await confirm(h, { rate: 4, window: { start: M(12), end: null }, part: 'p1', createdBy: 50n, reservation: 'R3' });
    toNow(h);
    assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 100n, from, cause: from === M(14) ? 'SHORTEN' : 'CANCEL', reservation: 'R3' }))), CHANGED);
    assert.deepEqual([M(12), M(13, 59), M(14), M(100_000_000)].map((t) => C - freeAt(h, t)), want, `from ${from}`);
  }
});

test('P2-S94 link part: a shortening to the next minute boundary is an end_leg from 10:01, while an extension hold of R is in flight', async () => {
  const h = await withR();
  const ext = partCmds(h, { rate: 4, window: { start: M(18), end: M(20) }, part: 'p2', createdBy: 105n, kind: 'change' });
  assert.equal(resultOf(await h.stub.hold(ext.hold)), 'HELD');
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 110n, from: M(10, 1), cause: 'SHORTEN' }))), CHANGED);
  assert.equal(resultOf(await h.stub.release(h.stub.releaseCmd(ext.hold.request, ext.hold.deadline, 'FAILED'))), 'RELEASED');
  assert.deepEqual([M(10), M(10, 1), M(18)].map((t) => C - freeAt(h, t)), [4, 0, 0]);
});

test('P2-S119 link part: a cancellation 1 s after the confirmation frees the 4 Mbps from 10:01 on L1 and L2, in either order of the links', async () => {
  for (const [link, moving] of [['L1', true], ['L2', false]] as const) {
    const h = await at0830(link);
    toNow(h);
    const r4 = partCmds(h, { rate: 4, window: { start: M(10, 1), end: M(18) }, part: 'p1', createdBy: 200n, reservation: 'R4' });
    assert.equal(resultOf(await h.stub.hold(r4.hold)), 'HELD');
    if (moving) {
      h.rt.scriptAppend(RESULTS.Moving());
      assert.equal(resultOf(await h.stub.convert(r4.convert)), 'MOVING');
    }
    assert.deepEqual(outcome(await h.stub.convert(r4.convert)), { result: 'CONVERTED', part: 'p1' });
    h.rt.advance(1_000);
    assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 201n, from: M(10, 1), cause: 'CANCEL', reservation: 'R4' }))), CHANGED);
    assert.deepEqual([M(10, 1), M(17, 59)].map((t) => freeAt(h, t)), [10, 10], link);
  }
});

test('P2-S119 link part: a decrease 1 s after an increase is confirmed: the added part never holds capacity, and R is 4 Mbps from 10:01', async () => {
  const h = await withR();
  const inc = partCmds(h, { rate: 4, window: { start: M(10, 1), end: M(18) }, part: 'p2', createdBy: 105n, kind: 'change' });
  assert.equal(resultOf(await h.stub.hold(inc.hold)), 'HELD');
  assert.deepEqual(outcome(await h.stub.convert(inc.convert)), { result: 'CONVERTED', part: 'p2' });
  h.rt.advance(1_000);
  assert.deepEqual(outcome(await reduce(h, reduceCmd(h, { change: 106n, parts: [['p2', [{ from: M(10, 1), rateMbps: 0 }]]] }))), CHANGED);
  assert.deepEqual([M(10), M(10, 1), M(17, 59)].map((t) => C - freeAt(h, t)), [4, 4, 4]);
});

// ---------------- merge with S-LINK I5: a leg change and the yield claims ----------------

/** A hold command with a set request age (the HLC of `ms`), so the test fixes the priority order. */
function agedAt(cmd: HoldCmd, ms: number): HoldCmd {
  return { ...cmd, requestAge: `${BigInt(ms) * 1_000_000n}.0000000000` as HoldCmd['requestAge'] };
}

test('should not grant the capacity that an end_leg frees to a waiter younger than a live yield claim over it, and grant it after the yield (RFC-001 §4.3, §4.5)', async () => {
  const h = await withR();
  const t0 = Number(h.rt.now().ts.split('.')[0]) / 1e6;
  const W2 = { start: M(12), end: M(13) };
  const o = agedAt(h.stub.holdCmd({ rate: 6, window: W2, account: 'o', wait: true, deadlineInMs: 25_000 }), t0 - 9);
  const y = agedAt(h.stub.holdCmd({ rate: 6, window: W2, account: 'y' }), t0 - 5);
  const z = agedAt(h.stub.holdCmd({ rate: 4, window: W2, account: 'z', wait: true, deadlineInMs: 25_000 }), t0 - 1);
  const query = async (c: HoldCmd): Promise<Record<string, unknown>> =>
    outcome(await h.owner.query(h.stub.envelope(c.request.partition), { link: h.link, receiverPartition: h.link, request: c.request }));
  assert.deepEqual(outcome(await h.stub.hold(y)), { result: 'HELD', attempt: 1 });
  assert.equal(resultOf(await h.stub.hold(o)), 'WAITING');
  // Y (younger, 6) carries the mark: R's 4 and Y's 6 fill the link, and without Y, O fits (4 + 6 = 10). The mark raises O's claim.
  const m = await h.owner.markWaiting(h.stub.envelope(y.request.partition), { link: h.link, receiverPartition: h.link, request: y.request, waiting: true, position: 1n });
  assert.deepEqual(outcome(m), { result: 'APPLIED' });
  const claim = seqOf(m);
  assert.equal(resultOf(await h.stub.hold(z)), 'WAITING');
  // R ends from 12:00: 4 Mbps are free on [12:00, 13:00). O (6) still does not fit; Z (4) fits, but it is younger than O
  // and inside O's live claim, so the scan of the end_leg entry does not grant it.
  assert.deepEqual(outcome(await endLeg(h, endLegCmd(h, { change: 100n, from: M(12), cause: 'SHORTEN' }))), CHANGED);
  assert.deepEqual(h.pushed.filter((n) => n.id.kind === 'GRANTED'), []);
  assert.equal((await query(z))['state'], 'WAITING');
  assert.deepEqual(await query(y), { state: 'HELD', attempt: 1, openYieldClaims: [{ claim, olderRequest: o.request }] }, 'the leg change ends no claim');
  // Y yields: O is granted (6), then Z fits beside it (6 + 4 = 10), in the entry of the yield; Y waits at attempt 2.
  const acc = await h.owner.yieldAnswer(h.stub.envelope(y.request.partition), {
    link: h.link, receiverPartition: h.link, request: y.request, attempt: 1, claim, answer: 'yield_accept',
  });
  assert.deepEqual(outcome(acc), { result: 'ACCEPTED', newWaiterAttempt: 2 });
  assert.deepEqual(await query(o), { state: 'HELD', attempt: 1 });
  assert.deepEqual(await query(z), { state: 'HELD', attempt: 1 });
  assert.equal((await query(y))['state'], 'WAITING');
  assert.equal(h.owner.stateOf(h.link)?.occAll.peak(W2.start, W2.end), C);
});
