/**
 * S-LINK I4 open-ended reservations and the rolling horizon (exit criterion 1: T-06; P1-S21, P1-S22, P1-S23).
 * Background: capacity 10 Mbps, a confirmed open-ended reservation of 6 Mbps from now + 1 h. The stub's
 * clock starts at 09:00 on 2 March 2026, so H is 09:00 on 2 March 2027.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hlcToWallMs } from '@share/owner-runtime';
import { harness, M, oracleHorizon, resultOf } from './support.ts';

const NOW = M(9);
const H = Date.UTC(2027, 2, 2, 9) / 60_000;
const DAY_MS = 86_400_000;

async function withOpenEnded(): Promise<Awaited<ReturnType<typeof harness>>> {
  const h = await harness();
  const b = await h.stub.book({ rate: 6, window: { start: NOW + 60, end: null } });
  assert.equal(resultOf(b.convert), 'CONVERTED');
  return h;
}

test('P1-S21 an open-ended reservation takes its rate at every minute up to the horizon', async () => {
  const h = await withOpenEnded();
  const r = await h.stub.book({ rate: 5, window: { start: H - 30, end: H } });
  assert.equal(resultOf(r.hold), 'REFUSED:"NO_FIT"');
  assert.equal(resultOf((await h.stub.book({ rate: 4, window: { start: H - 30, end: H } })).convert), 'CONVERTED', 'the 4 Mbps left fit');
});

test('P1-S22 minutes that become sellable are taken by the open-ended reservation before any new sale', async () => {
  const h = await withOpenEnded();
  h.rt.advance(DAY_MS);
  const m0 = Math.floor(hlcToWallMs(h.rt.now().ts) / 60_000);
  const newH = Date.UTC(2027, 2, 3, 9) / 60_000;
  assert.equal(m0, NOW + 24 * 60);
  const r = await h.stub.book({ rate: 5, window: { start: newH - 60, end: newH } });
  assert.equal(resultOf(r.hold), 'REFUSED:"NO_FIT"');
  assert.equal(resultOf((await h.stub.book({ rate: 4, window: { start: newH - 60, end: newH } })).convert), 'CONVERTED');
});

test('P1-S23 a booking that ends where an open-ended reservation starts gets the whole link', async () => {
  const h = await withOpenEnded();
  assert.equal(resultOf((await h.stub.book({ rate: 10, window: { start: NOW, end: NOW + 60 } })).convert), 'CONVERTED');
});

test('T-06 as ts advances by days and months, no new sale takes an open-ended reservation\'s minutes', async () => {
  const h = await withOpenEnded();
  const steps = [DAY_MS, 3 * DAY_MS, 31 * DAY_MS, 30 * DAY_MS, 92 * DAY_MS, 200 * DAY_MS, 400 * DAY_MS];
  for (const step of steps) {
    h.rt.advance(step);
    const m0 = Math.floor(hlcToWallMs(h.rt.now().ts) / 60_000);
    const hz = oracleHorizon(m0, 12);
    for (const w of [{ start: hz - 60, end: hz }, { start: m0, end: m0 + 1 }, { start: hz - 1, end: null }, { start: m0, end: hz }]) {
      assert.equal(resultOf((await h.stub.book({ rate: 5, window: w })).hold), 'REFUSED:"NO_FIT"', `after ${step} ms: [${w.start}, ${w.end})`);
    }
    assert.equal(resultOf((await h.stub.hold(h.stub.holdCmd({ rate: 2, window: { start: hz - 60, end: hz } })))), 'HELD', 'the 4 Mbps left are sold');
    assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 3, window: { start: hz - 60, end: hz } }))), 'REFUSED:"IN_FLIGHT"');
    assert.ok((h.owner.stateOf(h.link)?.occAll.peak(m0, null) ?? Infinity) <= 10);
  }
});
