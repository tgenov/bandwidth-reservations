/**
 * Exit criterion 7 of S-LINK I1 (the link part of X2-S05): the apply cost of one `hold` does not depend on
 * the window length. p99 ≤ 40 µs (est.; SP1 sets the figure) for windows of 1 min, 1 day, 12 months and
 * open-ended, with 530,000 keys in each tree. The figure is the apply in `LinkState.decide`, on one core.
 * Set LINK_MEASURE_STRICT=0 to report the numbers without the bound (for a slow CI machine).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8 } from '@share/owner-runtime';
import type { HlcTs } from '@share/owner-runtime';
import { LinkState, type HoldCmd } from '../src/index.ts';
import { int, M, rng } from './support.ts';

const KEYS = 530_000;
const SAMPLES = 4_000;
const BOUND_US = 40;

test('measurement: hold apply p99 is independent of the window length at 530,000 keys', () => {
  const st = new LinkState();
  st.init({ link: 'hot', capacityMbps: 1_000_000_000, policy: { version: '1', releaseGraceMs: 60_000, requestRecordTtlMs: 86_400_000, rateMinMbps: 1 } });
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
