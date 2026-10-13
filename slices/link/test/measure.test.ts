/**
 * Exit criterion 7 of S-LINK I1 (the link part of X2-S05): the apply cost of one `hold` does not depend on
 * the window length. p99 ≤ 40 µs (est.; SP1 sets the figure) for windows of 1 min, 1 day, 12 months and
 * open-ended, with 530,000 keys in each tree. The figure is the apply in `LinkState.decide`, on one core.
 * It runs only with LINK_MEASURE=1 (`npm run measure`), because a wall-clock bound fails on a loaded machine.
 * Set LINK_MEASURE_STRICT=0 to report the numbers without the bound.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8 } from '@share/owner-runtime';
import type { HlcTs } from '@share/owner-runtime';
import { DEFAULT_POLICY, LinkState, type HoldCmd } from '../src/index.ts';
import { int, M, rng } from './support.ts';

const KEYS = 530_000;
const SAMPLES = 4_000;
const BOUND_US = 40;

const enabled = process.env['LINK_MEASURE'] === '1';

/**
 * Exit criterion 4 of S-LINK I2: one refusal at the 512-step bound ≤ 1 ms, and one batch at the 4,096-step
 * budget ≤ 5 ms (est.), at 530,000 keys. The schedule is overcommitted at every third minute, so a one-hour
 * window never fits and each step jumps over one run. The figure includes the whole `hold` apply.
 */
test('measurement: a refusal at the 512-step bound and a batch at the 4,096-step budget at 530,000 keys',
  { skip: enabled ? false : 'set LINK_MEASURE=1 (npm run measure)' }, () => {
  const st = new LinkState();
  st.init({ link: 'hot', capacityMbps: 10, policy: DEFAULT_POLICY });
  const base = M(0);
  for (let i = 0; st.occAll.size < KEYS; i++) st.occAll.add(base + 3 * i, base + 3 * i + 1, 10);
  st.commit();
  const ts = `${BigInt(Date.UTC(2026, 2, 2, 9)) * 1_000_000n}.0000000000` as HlcTs;
  let seq = 1n;
  const refusal = (start: number): HoldCmd => {
    seq += 1n;
    return {
      link: 'hot', receiverPartition: 'hot', request: { partition: utf8('acct'), seq }, account: utf8('acct'), leg: 'l',
      holdKind: { kind: 'booking' }, rateMbps: 1, window: { start, end: start + 60 },
      deadline: Date.UTC(2026, 2, 2, 10), commitFence: Date.UTC(2026, 2, 2, 10) - 420, requestAge: ts, wait: false,
      receiptMinute: base, policyVersion: 1n,
    };
  };
  const one: number[] = [];
  const batch: number[] = [];
  for (let i = 0; i < 600; i++) {
    st.beginBatch(ts);
    const start = base + 3 * (i % 1_000);
    const t0 = process.hrtime.bigint();
    const d = st.decide({ op: 'hold', body: refusal(start) }, ts, seq);
    const t1 = process.hrtime.bigint();
    assert.deepEqual((d.outcome as { counterOffer?: unknown }).counterOffer, { largestRateMbps: 0, earliest: { notFoundBefore: start + 1 + 3 * 511 } });
    assert.equal(st.counterofferStepsLeft, 4_096 - 512);
    st.rollback();
    if (i >= 100) one.push(Number(t1 - t0) / 1_000);
  }
  for (let i = 0; i < 300; i++) {
    st.beginBatch(ts);
    const t0 = process.hrtime.bigint();
    for (let k = 0; k < 8; k++) st.decide({ op: 'hold', body: refusal(base + 3 * (k * 2_000 + i)) }, ts, seq);
    const t1 = process.hrtime.bigint();
    assert.equal(st.counterofferStepsLeft, 0);
    st.rollback();
    if (i >= 50) batch.push(Number(t1 - t0) / 1_000);
  }
  const p99 = (xs: number[]): number => xs.sort((a, b) => a - b)[Math.floor(xs.length * 0.99)] as number;
  const report = { refusalP99Us: p99(one), batchP99Us: p99(batch) };
  console.log(`# counter-offer cost at ${st.occAll.size} keys (µs): ${JSON.stringify(report)}`);
  if (process.env['LINK_MEASURE_STRICT'] !== '0') {
    assert.ok(report.refusalP99Us <= 1_000, `refusal p99 ${report.refusalP99Us.toFixed(0)} µs > 1 ms`);
    assert.ok(report.batchP99Us <= 5_000, `batch p99 ${report.batchP99Us.toFixed(0)} µs > 5 ms`);
  }
});

test('measurement: hold apply p99 is independent of the window length at 530,000 keys',
  { skip: enabled ? false : 'set LINK_MEASURE=1 (npm run measure)' }, () => {
  const st = new LinkState();
  st.init({ link: 'hot', capacityMbps: 1_000_000_000, policy: DEFAULT_POLICY });
  const r = rng(42);
  const base = M(0);
  const span = 365 * 24 * 60;
  // Random pulses until each tree has 530,000 keys. They are spread over three years, so that most
  // minutes stay free of a key and the loop ends soon.
  while (st.occAll.size < KEYS) {
    const s = base + int(r, 0, 3 * span);
    const e = s + int(r, 1, 5_000);
    const b = int(r, 1, 50);
    st.occAll.add(s, e, b);
    st.occFirm.add(s, e, b);
  }
  st.commit();
  const ts = `${BigInt(Date.UTC(2026, 2, 2, 9)) * 1_000_000n}.0000000000` as HlcTs;
  const windows: Record<string, (s: number) => { start: number; end: number | null }> = {
    '1 min': (s) => ({ start: s, end: s + 1 }),
    '1 day': (s) => ({ start: s, end: s + 1_440 }),
    '12 months': (s) => ({ start: s, end: s + span - 1 }),
    'open-ended': (s) => ({ start: s, end: null }),
  };
  // The four windows are measured in turn, so that a GC pause or a slow phase falls on all of them alike.
  const names = Object.keys(windows);
  const us: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
  let seq = 1n;
  for (let i = 0; i < SAMPLES + 500; i++) {
    for (const name of names) {
      seq += 1n;
      const cmd: HoldCmd = {
        link: 'hot', receiverPartition: 'hot', request: { partition: utf8('acct'), seq }, account: utf8('acct'), leg: 'l',
        holdKind: { kind: 'booking' }, rateMbps: 1, window: (windows[name] as (s: number) => HoldCmd['window'])(base + int(r, 0, 1_000)),
        deadline: Date.UTC(2026, 2, 2, 10), commitFence: Date.UTC(2026, 2, 2, 10) - 420, requestAge: ts, wait: false,
        receiptMinute: base, policyVersion: 1n,
      };
      const t0 = process.hrtime.bigint();
      const d = st.decide({ op: 'hold', body: cmd }, ts, seq);
      const t1 = process.hrtime.bigint();
      st.rollback();
      assert.equal((d.outcome as { result: string }).result, 'HELD');
      if (i >= 500) (us[name] as number[]).push(Number(t1 - t0) / 1_000);
    }
  }
  const report: Record<string, { p50: number; p99: number }> = {};
  for (const name of names) {
    const xs = (us[name] as number[]).sort((a, b) => a - b);
    report[name] = { p50: xs[Math.floor(xs.length * 0.5)] as number, p99: xs[Math.floor(xs.length * 0.99)] as number };
  }
  console.log(`# hold apply at ${st.occAll.size} keys (µs): ${JSON.stringify(report)}`);
  if (process.env['LINK_MEASURE_STRICT'] !== '0') {
    for (const [name, v] of Object.entries(report)) assert.ok(v.p99 <= BOUND_US, `${name}: p99 ${v.p99.toFixed(1)} µs > ${BOUND_US} µs`);
  }
});

/**
 * Exit criterion 5 of S-LINK I3 (the link part of X2-S05 "final or pending"): one scan of 1,024 waiters ≤ 1 ms,
 * and a flash crowd of 7,500 waiters that one release frees completes in the release entry and 7 `Tick`
 * continuations (8 scan parts) in ≤ 8 ms (est.). The figure is the apply in `LinkState`, on one core.
 */
test('measurement: a scan of 1,024 waiters and a flash crowd of 7,500 waiters in 8 scan parts',
  { skip: enabled ? false : 'set LINK_MEASURE=1 (npm run measure)' }, () => {
  const ts = `${BigInt(Date.UTC(2026, 2, 2, 9)) * 1_000_000n}.0000000000` as HlcTs;
  const W = { start: M(10), end: M(11) };
  const cmd = (seq: bigint, rate: number, wait: boolean, deadline: number): HoldCmd => ({
    link: 'hot', receiverPartition: 'hot', request: { partition: utf8('acct'), seq }, account: utf8('acct'), leg: 'l',
    holdKind: { kind: 'booking' }, rateMbps: rate, window: W, deadline, commitFence: deadline - 420, requestAge: ts, wait,
    receiptMinute: M(9), policyVersion: 1n,
  });
  const crowd = (n: number): { st: LinkState; blocker: HoldCmd } => {
    const st = new LinkState();
    st.init({ link: 'hot', capacityMbps: 10, policy: DEFAULT_POLICY });
    st.beginBatch(ts);
    const blocker = cmd(1n, 10, false, Date.UTC(2026, 2, 2, 9, 0, 10));
    st.decide({ op: 'hold', body: blocker }, ts, 1n);
    for (let i = 0; i < n; i++) st.decide({ op: 'hold', body: cmd(BigInt(i + 2), 1, true, Date.UTC(2026, 2, 2, 9, 0, 20)) }, ts, BigInt(i + 2));
    st.commit();
    return { st, blocker };
  };
  const release = (blocker: HoldCmd) => ({ op: 'release' as const, body: {
    link: 'hot', receiverPartition: 'hot', request: blocker.request, deadline: blocker.deadline, reason: 'REJECTED' as const, decisionTime: ts,
  } });
  const run = (n: number, samples: number): { us: number[]; parts: number } => {
    const { st, blocker } = crowd(n);
    const us: number[] = [];
    let parts = 0;
    for (let i = 0; i < samples + 20; i++) {
      st.beginBatch(ts);
      let seq = 1_000_000n;
      const t0 = process.hrtime.bigint();
      st.decide(release(blocker), ts, seq);
      parts = 1;
      while (st.scanPending) { seq += 1n; st.tick(ts, seq); parts += 1; }
      const t1 = process.hrtime.bigint();
      st.rollback();
      if (i >= 20) us.push(Number(t1 - t0) / 1_000);
    }
    return { us, parts };
  };
  const p99 = (xs: number[]): number => xs.sort((a, b) => a - b)[Math.floor(xs.length * 0.99)] as number;
  const scan = run(1_024, 300);
  const flash = run(7_500, 100);
  assert.equal(scan.parts, 1);
  assert.equal(flash.parts, 8);
  const report = { scan1024P99Us: p99(scan.us), flash7500P99Us: p99(flash.us) };
  console.log(`# waiter scan cost (µs): ${JSON.stringify(report)}`);
  if (process.env['LINK_MEASURE_STRICT'] !== '0') {
    assert.ok(report.scan1024P99Us <= 1_000, `scan of 1,024 waiters p99 ${report.scan1024P99Us.toFixed(0)} µs > 1 ms`);
    assert.ok(report.flash7500P99Us <= 8_000, `flash crowd p99 ${report.flash7500P99Us.toFixed(0)} µs > 8 ms`);
  }
});
