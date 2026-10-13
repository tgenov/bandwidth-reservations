/**
 * S-LINK I4 property tests (exit criterion 1):
 * - T-05: validity V1 … V6 against an independent oracle, over receipt minutes at calendar edges (month ends,
 *   29 February, year ends), horizons of several calendar months and windows at the edges of m0 and H;
 * - T-06: the horizon rolls by days and months while open-ended reservations hold; every decision equals the
 *   per-minute oracle, so no new sale takes an open-ended reservation's minutes (P1-N1, P1-N6).
 * A failing seed is in the message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeJson, hex, hlcToWallMs, type HlcTs } from '@share/owner-runtime';
import { DEFAULT_POLICY, LinkState, type HoldCmd, type LinkCommand, type LinkPolicy, type Window } from '../src/index.ts';
import { harness, int, M, MinuteOracle, oracleHorizon, oracleInvalid, resultOf, rng } from './support.ts';

const tsAt = (ms: number): HlcTs => `${BigInt(ms) * 1_000_000n}.0000000000` as HlcTs;

/** A receipt time at a calendar edge: month ends, 28 and 29 February, 1st of a month, or any day. */
function edgeReceipt(r: () => number): number {
  const y = int(r, 2025, 2032);
  const mo = int(r, 0, 11);
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const day = [1, 28, 29, 30, 31, last, int(r, 1, 31)][int(r, 0, 6)] as number;
  return Date.UTC(y, mo, Math.min(day, last), int(r, 0, 23), int(r, 0, 59), int(r, 0, 59), int(r, 0, 999));
}

test('T-05 validity V1 … V6 equals the oracle at calendar edges for 8 seeds × 4,000 holds', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const r = rng(seed);
    const months = [1, 2, 6, 11, 12, 13, 24][int(r, 0, 6)] as number;
    const policy: LinkPolicy = { ...DEFAULT_POLICY, rateMinMbps: int(r, 1, 3), sellingHorizonMonths: months };
    const st = new LinkState();
    st.init({ link: 'v', capacityMbps: 10, policy });
    st.commit();
    const counts: Record<string, number> = {};
    for (let i = 0; i < 4_000; i++) {
      const receivedMs = edgeReceipt(r);
      const m0 = Math.floor(receivedMs / 60_000);
      const h = oracleHorizon(m0, months);
      const frac = (): number => (r() < 0.05 ? 0.5 : 0);
      const start = (r() < 0.5 ? m0 + int(r, -3, 3) : h + int(r, -3, 3)) + frac();
      const endPick = r();
      const end = endPick < 0.15 ? null : endPick < 0.6 ? start + int(r, -2, 5) + frac() : h + int(r, -3, 3) + frac();
      const rate = [-1, 0, 0.5, 1, 1.5, 2, 3, 5, 11][int(r, 0, 8)] as number;
      const linkMs = receivedMs + int(r, 0, 90_000);   // the hold reaches the link up to 90 s after receipt
      const cmd: HoldCmd = {
        link: 'v', receiverPartition: 'v', request: { partition: new Uint8Array([1]), seq: BigInt(i + 1) }, account: new Uint8Array([1]),
        leg: 'l', holdKind: { kind: 'booking' }, rateMbps: rate, window: { start, end }, deadline: linkMs + 20_000,
        commitFence: linkMs + 19_580, requestAge: tsAt(receivedMs), wait: false, receiptMinute: m0, policyVersion: 1n,
      };
      st.beginBatch(tsAt(linkMs));
      const d = st.decide({ op: 'hold', body: cmd }, tsAt(linkMs), 2n);
      st.rollback();
      const want = oracleInvalid(cmd, policy);
      const got = resultOf(d.outcome);
      const msg = `seed ${seed}, case ${i}: m0 ${new Date(m0 * 60_000).toISOString()} H ${new Date(h * 60_000).toISOString()} rate ${rate} [${start}, ${end}) got ${got}`;
      if (want) assert.equal(got, `REFUSED:{"invalid":"${want}"}`, msg);
      else assert.equal(got, rate > 10 ? 'REFUSED:"NO_FIT"' : 'HELD', msg);   // the state is empty for each case (rollback)
      counts[want ?? 'valid'] = (counts[want ?? 'valid'] ?? 0) + 1;
    }
    for (const k of ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'valid']) assert.ok((counts[k] ?? 0) > 0, `seed ${seed}: ${k} occurs (${JSON.stringify(counts)})`);
  }
});

const DAY_MS = 86_400_000;

test('T-06 as the horizon rolls by days and months, every decision equals the oracle and no sale takes an open-ended reservation\'s minutes (4 seeds × 300 commands)', async () => {
  const base = M(9);
  const n = 20 * 31 * 24 * 60;   // 20 months of minutes: 7 months of roll and a 12-month horizon
  for (const seed of [41, 42, 43, 44]) {
    const r = rng(seed);
    const h = await harness({ link: `roll-${seed}`, capacity: 10 });
    const nowMinute = (): number => Math.floor(hlcToWallMs(h.rt.now().ts) / 60_000);
    const held: HoldCmd[] = [];
    const hold = async (rate: number, w: Window): Promise<string> => {
      const cmd = h.stub.holdCmd({ rate, window: w, account: `a${int(r, 0, 9)}`, deadlineInMs: int(r, 1_000, 30_000) });
      held.push(cmd);
      return resultOf(await h.stub.hold(cmd));
    };
    for (let k = int(r, 1, 3); k > 0; k--) {
      const b = await h.stub.book({ rate: int(r, 1, 4), window: { start: base + int(r, 0, 10 * 1_440), end: null } });
      if (b.hold && resultOf(b.hold) === 'HELD') held.push(b.cmd);
    }
    let rolled = 0;
    const counts: Record<string, number> = {};
    for (let i = 0; i < 300; i++) {
      const p = r();
      let k: string;
      if (p < 0.12 && rolled < 200 * DAY_MS) {
        const step = int(r, 1, 40) * DAY_MS;
        h.rt.advance(step);
        rolled += step;
        // A request record lives until D + 24 h (RFC-001 §4.4); the oracle keeps records for ever. Thus the
        // run sends no more commands for the requests of earlier days. Their holds and parts stay.
        held.length = 0;
        continue;
      } else if (p < 0.6) {
        const m0 = nowMinute();
        const hz = oracleHorizon(m0, 12);
        const start = r() < 0.5 ? hz - int(r, 1, 3_000) : m0 + int(r, 0, hz - m0 - 1);
        const e = r();
        const end = e < 0.12 ? null : e < 0.2 ? hz : e < 0.25 ? hz + int(r, 1, 60) : Math.min(hz, start + int(r, 1, 3_000));
        k = await hold(int(r, 1, 6), { start, end });
      } else if (p < 0.75 && held.length > 0) {
        k = resultOf(await h.stub.convert(h.stub.convertCmd(held[int(r, 0, held.length - 1)] as HoldCmd)));
      } else if (p < 0.88 && held.length > 0) {
        const c = held[int(r, 0, held.length - 1)] as HoldCmd;
        k = resultOf(await h.stub.release(h.stub.releaseCmd(c.request, c.deadline)));
      } else if (held.length > 0) {
        k = resultOf(await h.stub.hold(held[int(r, 0, held.length - 1)] as HoldCmd));
      } else continue;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const oracle = new MinuteOracle(base, n, 10);
    for (const [i, d] of h.decided.filter((x) => 'op' in x.command).entries()) {
      const want = oracle.apply(d.command as LinkCommand, d.ts);
      assert.equal(hex(encodeJson(d.outcome)), hex(encodeJson(want)),
        `seed ${seed}, decision ${i}: link ${JSON.stringify(d.outcome)} oracle ${JSON.stringify(want)}`);
    }
    assert.ok((h.owner.stateOf(h.link)?.occAll.peak(base, null) ?? Infinity) <= 10, `seed ${seed}: occ_all ≤ C_ref`);
    for (const k of ['HELD', 'CONVERTED', 'REFUSED:"NO_FIT"', 'REFUSED:{"invalid":"V6"}']) assert.ok((counts[k] ?? 0) > 0, `seed ${seed}: ${k} occurs (${JSON.stringify(counts)})`);
  }
});
