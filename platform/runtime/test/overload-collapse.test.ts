/**
 * DT-50 "Overload recovery" (RFC-006 §22.3 at commit 8462109; §4.7 rule 5, §22.1, AI6-12): goodput under overload
 * of the real runtime core (lane, batching, executeBatch) over the in-memory store with a deterministic database
 * time `F` + `c` · `n` and §22.1's caller model. Each case is one deterministic run with a fixed seed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, type SimPhase, type SimRun } from './support.ts';

/** Capacity of the DT-50 (1) database with rule 5b (`C` about 444/s) and the backlog bound at 200 calls/s (0.5 s · λ). */
const C = 444;
const BOUND = 100;

const linear = (f: number, c: number) => (rows: number): number => f + c * rows;

function perSecond(r: SimRun): number[] {
  const out = new Array<number>(Math.ceil(r.endMs / 1_000)).fill(0);
  for (const c of r.commits) {
    const s = Math.floor(c.at / 1_000);
    if (s < out.length) out[s] = (out[s] ?? 0) + c.calls;
  }
  return out;
}

/** §22.1 backlog `B`(t): calls first sent by t less calls committed by t (no caller gives up in these runs). */
function backlog(r: SimRun, t: number): number {
  return r.firstSends.filter((x) => x <= t).length - r.commits.filter((c) => c.at <= t).reduce((a, c) => a + c.calls, 0);
}

/** `t_e`: the first instant from `fromMs` at which `B` ≤ the bound (B falls only at commits). */
function drainEnd(r: SimRun, fromMs: number): number | undefined {
  for (const t of [fromMs, ...r.commits.map((c) => c.at).filter((t) => t >= fromMs)]) if (backlog(r, t) <= BOUND) return t;
  return undefined;
}

/** The largest deficit after `te`: calls first sent after `te` less calls committed after `te`, at any instant. */
function maxDeficit(r: SimRun, te: number): number {
  const ev = [
    ...r.firstSends.filter((x) => x > te).map((at) => ({ at, d: 1, o: 0 })),
    ...r.commits.filter((c) => c.at > te).map((c) => ({ at: c.at, d: -c.calls, o: 1 })),
  ].sort((a, b) => a.at - b.at || a.o - b.o);
  let sum = 0;
  let max = 0;
  for (const e of ev) { sum += e.d; max = Math.max(max, sum); }
  return max;
}

function committedIn(r: SimRun, from: number, to: number): number {
  return r.commits.filter((c) => c.at >= from && c.at < to).reduce((a, c) => a + c.calls, 0);
}

function offeredIn(r: SimRun, from: number, to: number): number {
  return r.firstSends.filter((x) => x >= from && x < to).length;
}

const abandonsAt = (r: SimRun): number[] => r.writes.filter((w) => w.abandoned).map((w) => w.startMs + w.ms);

function describe(r: SimRun, te?: number): string {
  const s = r.stats;
  return `per second ${JSON.stringify(perSecond(r))}; t_e ${te ?? 'none'} ms; deficit after t_e ${te === undefined ? '-' : maxDeficit(r, te)}; ` +
    `state changes ${s.stateChanges} (last at ${s.lastChangeMs ?? '-'} ms); abandons at ${JSON.stringify(abandonsAt(r))}; ` +
    `fresh attempts ${JSON.stringify(r.freshAttempts.map((f) => f.calls))}; Retry ${r.retries}; Overloaded ${r.overloaded}; ` +
    `gave up ${r.gaveUp}; regime resets ${s.lanes[0]?.regimeResets}; seed 1`;
}

const BURST: SimPhase[] = [{ untilMs: 3_000, ratePerS: 1_000 }, { untilMs: 33_000, ratePerS: 200 }];
const STEADY: SimPhase[] = [{ untilMs: 33_000, ratePerS: 200 }];

test('should commit the offered rate when the offered rate stays below capacity', { timeout: 60_000 }, async () => {
  const r = await simulate({ phases: [{ untilMs: 20_000, ratePerS: 200 }], dbMs: linear(50, 2) });
  const g = perSecond(r);
  for (let s = 1; s < 20; s++) assert.ok((g[s] ?? 0) >= 190, `second ${s}: ${describe(r)}`);
  assert.equal(abandonsAt(r).length, 0, describe(r));
  assert.equal(r.retries, 0, describe(r));
  assert.equal(r.overloaded, 0, describe(r));
  assert.equal(r.stats.stateChanges, 0, describe(r));
});

test('DT-50 (1) should drain a burst at 5 times the rate and commit 200/s in every second from 12 s', { timeout: 120_000 }, async () => {
  const r = await simulate({ phases: BURST, dbMs: linear(50, 2) });
  const g = perSecond(r);
  const td = ((1_000 - C) * 3) / (C - 200);
  const te = drainEnd(r, 3_000);
  assert.ok(te !== undefined && te <= 3_000 + 1.5 * td * 1_000 + 5_000, `drain deadline ${3 + 1.5 * td + 5} s: ${describe(r, te)}`);
  for (let s = 1; s < 33; s++) assert.notEqual(g[s], 0, `zero goodput in second ${s}: ${describe(r, te)}`);
  assert.ok(maxDeficit(r, te) <= BOUND, `deficit: ${describe(r, te)}`);
  assert.deepEqual(abandonsAt(r).filter((t) => t > te), [], describe(r, te));
  assert.ok(committedIn(r, te, 33_000) >= 0.95 * 200 * (33_000 - te) / 1_000, `mean goodput after t_e: ${describe(r, te)}`);
  for (let s = 12; s < 33; s++) assert.ok((g[s] ?? 0) >= 190, `second ${s}: ${describe(r, te)}`);
  assert.ok(r.stats.stateChanges <= 2, describe(r, te));
  assert.ok((r.stats.lastChangeMs ?? 0) <= te, `a state change after t_e: ${describe(r, te)}`);
});

test('DT-50 (2) should commit at least 285 a second under a fixed cost of 450 ms, with no state change and no abandon', { timeout: 120_000 }, async () => {
  const on = await simulate({ phases: [{ untilMs: 33_000, ratePerS: 300 }], dbMs: linear(450, 0.2) });
  const off = await simulate({ phases: [{ untilMs: 33_000, ratePerS: 300 }], dbMs: linear(450, 0.2), rules: false });
  const g = perSecond(on);
  const gOff = perSecond(off);
  for (let s = 2; s < 33; s++) assert.ok((g[s] ?? 0) >= 285, `second ${s}: ${describe(on)}`);
  assert.equal(on.stats.stateChanges, 0, describe(on));
  assert.equal(abandonsAt(on).length, 0, describe(on));
  assert.equal(on.overloaded, 0, describe(on));
  assert.equal(on.stats.lanes[0]?.nCap, 2_000, 'the fixed cost never shrinks the batch');
  const sum = (xs: number[]): number => xs.slice(2).reduce((a, b) => a + b, 0);
  assert.ok(sum(g) >= sum(gOff), `rules on ${sum(g)} < rules off ${sum(gOff)}: ${describe(on)}; off ${JSON.stringify(gOff)}`);
  assert.ok(Math.min(...g.slice(2)) >= Math.min(...gOff.slice(2)), `per-second minimum below rules off: ${JSON.stringify(gOff)}`);
});

test('DT-50 (3) should make one fresh attempt with the first n_cap calls after each abandon in a lease wait and recover after it', { timeout: 120_000 }, async () => {
  const wait = (rows: number, start: number): number => 50 + 2 * rows + (start >= 10_000 && start < 19_000 ? 19_000 - start : 0);
  const r = await simulate({ phases: STEADY, dbMs: wait });
  const writes = r.writes.filter((w) => w.ids.length > 0);
  const abandoned = abandonsAt(r);
  assert.ok(abandoned.length > 0, `no abandon: ${describe(r)}`);
  let fresh = 0;
  const retryExpected = new Set<string>();
  for (let i = 0; i < writes.length; i++) {
    const w = writes[i];
    if (!w?.abandoned) continue;
    const f = writes[i + 1];
    assert.ok(f, describe(r));
    assert.deepEqual(f.ids, w.ids.slice(0, f.ids.length), `fresh attempt ${fresh} is not a prefix of the abandoned batch`);
    assert.equal(f.ids.length, r.freshAttempts[fresh]?.calls, describe(r));
    const rest = w.ids.slice(f.ids.length);
    const after = writes[i + 2];
    if (rest.length > 0 && after) assert.deepEqual(after.ids.slice(0, rest.length), rest.slice(0, after.ids.length), 'the other calls are taken next, in their order');
    if (f.abandoned) for (const id of f.ids) retryExpected.add(id);
    fresh += 1;
    i += 1;
  }
  assert.equal(fresh, r.freshAttempts.length, describe(r));
  assert.deepEqual([...r.retryIds].sort(), [...retryExpected].sort(), 'Retry only for the calls of an abandoned fresh attempt');
  assert.deepEqual(abandoned.filter((t) => t > 19_000), [], describe(r));
  const e = offeredIn(r, 10_000, 23_000) - committedIn(r, 10_000, 23_000);
  const td = e / (C - 200);
  const te = drainEnd(r, 23_000);
  assert.ok(te !== undefined && te <= 23_000 + 1.5 * td * 1_000 + 5_000, `E ${e}, T_d ${td.toFixed(1)} s: ${describe(r, te)}`);
  assert.ok(maxDeficit(r, te) <= BOUND, `deficit: ${describe(r, te)}`);
  const g = perSecond(r);
  for (let s = 22; s < 33; s++) assert.ok((g[s] ?? 0) >= 190, `second ${s}: ${describe(r, te)}`);
});

test('DT-50 (3a) should reset the regime at the first slow batch and abandon nothing when the cost per entry is 30 times larger', { timeout: 120_000 }, async () => {
  const slow = (rows: number, start: number): number => 50 + (start >= 10_000 && start < 20_000 ? 60 : 2) * rows;
  const r = await simulate({ phases: STEADY, dbMs: slow });
  assert.ok((r.stats.lanes[0]?.regimeResets ?? 0) >= 1, describe(r));
  const firstSlow = r.writes.findIndex((w) => w.startMs >= 10_000 && w.ids.length > 0);
  assert.deepEqual(r.writes.slice(firstSlow + 1).filter((w) => w.ids.length >= 2_000).map((w) => w.startMs), [], 'a batch at the hard cap after the reset');
  assert.deepEqual(abandonsAt(r), [], describe(r));
  const e = offeredIn(r, 10_000, 24_000) - committedIn(r, 10_000, 24_000);
  const td = e / (C - 200);
  const te = drainEnd(r, 24_000);
  assert.ok(te !== undefined && te <= 24_000 + 1.5 * td * 1_000 + 5_000, `E ${e}, T_d ${td.toFixed(1)} s: ${describe(r, te)}`);
  assert.ok(maxDeficit(r, te) <= BOUND, `deficit: ${describe(r, te)}`);
  const g = perSecond(r);
  for (let s = 22; s < 33; s++) assert.ok((g[s] ?? 0) >= 190, `second ${s}: ${describe(r, te)}`);
});
