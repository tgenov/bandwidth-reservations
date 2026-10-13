/**
 * S-LINK I1 scenario tests (exit criterion 2): each scenario of the plan's I1 row, and each link part of
 * another slice's scenario that §8 puts in I1, as a recorded trace at the C02 boundary. The account
 * owner is the recorded stub. Capacity 10 Mbps, "it is 09:00" (P1 backgrounds).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hlcToWallMs } from '@share/owner-runtime';
import type { HoldReply } from '../src/index.ts';
import { harness, M, resultOf } from './support.ts';

const H = (hh: number, mm = 0) => M(hh, mm);

/** A confirmed reservation: hold then convert, both answered. */
async function confirmed(h: Awaited<ReturnType<typeof harness>>, rate: number, start: number, end: number | null): Promise<void> {
  const b = await h.stub.book({ rate, window: { start, end } });
  assert.equal(resultOf(b.hold), 'HELD');
  assert.equal(resultOf(b.convert), 'CONVERTED');
}

test('P1-S01 a booking is confirmed exactly when the peak leaves room for it', async () => {
  for (const [rate, outcome] of [[3, 'CONVERTED'], [4, 'REFUSED:"NO_FIT"']] as const) {
    const h = await harness();
    await confirmed(h, 7, H(10), H(11));
    const b = await h.stub.book({ rate, window: { start: H(10, 30), end: H(11, 30) } });
    assert.equal(b.convert ? resultOf(b.convert) : resultOf(b.hold), outcome);
  }
});

test('P1-S02 reservations that never coexist do not add up', async () => {
  const h = await harness();
  await confirmed(h, 8, H(14), H(14, 30));
  await confirmed(h, 8, H(15), H(16));
  const b = await h.stub.book({ rate: 2, window: { start: H(14), end: H(16) } });
  assert.equal(resultOf(b.convert), 'CONVERTED');
});

test('P1-S03 a booking needs room, not a completely free gap', async () => {
  const h = await harness();
  await confirmed(h, 5, H(9), H(20));
  const b = await h.stub.book({ rate: 5, window: { start: H(10), end: H(11) } });
  assert.equal(resultOf(b.convert), 'CONVERTED');
});

test('P1-S04 back-to-back bookings each get the whole link', async () => {
  for (const [s, e] of [[H(11), H(12)], [H(9), H(10)]] as const) {
    const h = await harness();
    await confirmed(h, 10, H(10), H(11));
    const b = await h.stub.book({ rate: 10, window: { start: s, end: e } });
    assert.equal(resultOf(b.convert), 'CONVERTED');
  }
});

test('P1-S05 a booking is confirmed only if it fits beside every hold when it is held', async () => {
  const h = await harness();
  await confirmed(h, 4, H(10), H(11));
  const other = h.stub.holdCmd({ rate: 3, window: { start: H(10), end: H(11) } });
  assert.equal(resultOf(await h.stub.hold(other)), 'HELD');
  // committed 4 + held 3 + 3 = 10: fits; one more Mbps does not fit beside the hold.
  const fits = await h.stub.book({ rate: 3, window: { start: H(10, 30), end: H(10, 45) } });
  assert.equal(resultOf(fits.convert), 'CONVERTED');
  const blocked = await h.stub.book({ rate: 1, window: { start: H(10), end: H(11) } });
  assert.equal(resultOf(blocked.hold), 'REFUSED:"IN_FLIGHT"');
  const st = h.owner.stateOf(h.link);
  assert.ok(st && st.occAll.peak(H(0), null) <= 10);
});

test('P1-S37 a booking is rejected for no fit only if it does not fit beside what is committed', async () => {
  const h = await harness();
  await confirmed(h, 4, H(10), H(11));
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 6, window: { start: H(10), end: H(11) } }))), 'HELD');
  // 4 committed + 6 held: 5 Mbps fits committed capacity, so the refusal is IN_FLIGHT, not NO_FIT.
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) } }))), 'REFUSED:"IN_FLIGHT"');
  // 7 Mbps does not fit beside the 4 committed: NO_FIT.
  assert.equal(resultOf(await h.stub.hold(h.stub.holdCmd({ rate: 7, window: { start: H(10), end: H(11) } }))), 'REFUSED:"NO_FIT"');
});

test('P1-S06 a year-long booking is checked at every minute of its window', async () => {
  const h = await harness();
  const year = 365 * 24 * 60;
  await confirmed(h, 4, H(9), H(9) + year);
  const sixthMonth = H(9) + 5 * 30 * 24 * 60 + 600;
  await confirmed(h, 6, sixthMonth, sixthMonth + 60);
  const b = await h.stub.book({ rate: 1, window: { start: H(9) + 10, end: H(9) + year - 10 } });
  assert.equal(resultOf(b.hold), 'REFUSED:"NO_FIT"');
});

for (const outcome of ['REJECTED', 'FAILED'] as const) {
  test(`P1-S08 capacity held for a request that ends ${outcome.toLowerCase()} is free again at once`, async () => {
    const h = await harness();
    const pending = h.stub.holdCmd({ rate: 6, window: { start: H(10), end: H(11) } });
    assert.equal(resultOf(await h.stub.hold(pending)), 'HELD');
    assert.equal(resultOf(await h.stub.release(h.stub.releaseCmd(pending.request, pending.deadline, outcome))), 'RELEASED');
    const b = await h.stub.book({ rate: 10, window: { start: H(10), end: H(11) } });
    assert.equal(resultOf(b.convert), 'CONVERTED');
  });
}

test('P1-S09 confirming a pending request does not count its capacity twice', async () => {
  const h = await harness();
  const pending = h.stub.holdCmd({ rate: 6, window: { start: H(10), end: H(11) } });
  await h.stub.hold(pending);
  assert.equal(resultOf(await h.stub.convert(h.stub.convertCmd(pending))), 'CONVERTED');
  const b = await h.stub.book({ rate: 4, window: { start: H(10), end: H(11) } });
  assert.equal(resultOf(b.convert), 'CONVERTED');
  assert.equal(h.owner.stateOf(h.link)?.occAll.peak(H(10), H(11)), 10);
  assert.equal(h.owner.stateOf(h.link)?.occFirm.peak(H(10), H(11)), 10);
});

test('P1-S10 a single-link booking is decided against capacity confirmed for routes', async () => {
  const h = await harness();
  const leg = h.stub.holdCmd({ rate: 6, window: { start: H(10), end: H(11) }, account: 'route-acct', leg: 'route-leg-2' });
  await h.stub.hold(leg);
  await h.stub.convert(h.stub.convertCmd(leg));
  const b = await h.stub.book({ rate: 5, window: { start: H(10), end: H(11) } });
  assert.equal(resultOf(b.hold), 'REFUSED:"NO_FIT"');
});

test('P1-S13 concurrent bookings never oversell the link', async () => {
  const h = await harness();
  const cmds = Array.from({ length: 40 }, (_, i) => h.stub.holdCmd({ rate: 1 + (i % 4), window: { start: H(10, i % 30), end: H(11, i % 20) }, account: `b${i}` }));
  const replies = await Promise.all(cmds.map((c) => h.stub.hold(c)));
  await Promise.all(cmds.map((c, i) => resultOf(replies[i]) === 'HELD' ? h.stub.convert(h.stub.convertCmd(c)) : undefined));
  // The confirmed rates at each minute, from the replies alone.
  for (let t = H(10); t < H(11, 30); t++) {
    let sum = 0;
    cmds.forEach((c, i) => { if (resultOf(replies[i]) === 'HELD' && c.window.start <= t && (c.window.end === null || t < c.window.end)) sum += c.rateMbps; });
    assert.ok(sum <= 10, `minute ${t}: ${sum} Mbps`);
  }
  assert.ok(h.rt.appends.length < cmds.length, 'concurrent commands share batches');
});

test('P1-S14 decisions are those of one-at-a-time checks in arrival order; a wait = false refusal stays refused', async () => {
  const h = await harness();
  const a = h.stub.holdCmd({ rate: 6, window: { start: H(10), end: H(11) }, account: 'a' });
  const b = h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) }, account: 'b' });
  const c = h.stub.holdCmd({ rate: 4, window: { start: H(10), end: H(11) }, account: 'c' });
  const [ra, rb, rc] = await Promise.all([h.stub.hold(a), h.stub.hold(b), h.stub.hold(c)]);
  assert.deepEqual([resultOf(ra), resultOf(rb), resultOf(rc)], ['HELD', 'REFUSED:"IN_FLIGHT"', 'HELD']);
  // The log has them in arrival order.
  assert.deepEqual(h.decided.slice(-3).map((d) => 'body' in d.command ? d.command.body.request.seq : 0n), [a.request.seq, b.request.seq, c.request.seq]);
  await h.stub.release(h.stub.releaseCmd(a.request, a.deadline));
  assert.equal(resultOf(await h.stub.hold(b)), 'REFUSED:"IN_FLIGHT"', 'b stays refused after its blocker is released');
});

test('P1-S77 requests from different accounts are checked in the order they reach the link', async () => {
  const h = await harness();
  await confirmed(h, 8, H(10), H(11));
  // b1 received X first, but Y (b2) reaches the link first.
  const x = h.stub.holdCmd({ rate: 2, window: { start: H(10), end: H(11) }, account: 'b1', deadlineInMs: 30_000 });
  const y = h.stub.holdCmd({ rate: 2, window: { start: H(10), end: H(11) }, account: 'b2', deadlineInMs: 20_000 });
  const ry = await h.stub.hold(y);
  const rx = await h.stub.hold(x) as HoldReply & { retryAfterMs?: number };
  assert.equal(resultOf(ry), 'HELD');
  assert.equal(resultOf(rx), 'REFUSED:"IN_FLIGHT"');
  const now = hlcToWallMs(h.rt.now().ts);
  assert.ok(rx.retryAfterMs !== undefined && Math.abs(rx.retryAfterMs - (y.deadline - now)) <= 1, `retry_after ${rx.retryAfterMs}`);
});

// ---------- link parts of other slices' scenarios (S-LINK plan §8) ----------

test('P2-S14 link part: request-scoped release ends the hold and records a tombstone', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 6, window: { start: H(10), end: H(11) } });
  await h.stub.hold(r);
  const rel = await h.stub.release(h.stub.releaseCmd(r.request, r.deadline, 'WITHDRAWN'));
  assert.equal(resultOf(rel), 'RELEASED');
  assert.equal((rel as { tombstoneUntil: number }).tombstoneUntil, r.deadline + 60_000);
  assert.equal(h.owner.stateOf(h.link)?.occAll.peak(H(10), H(11)), 0);
  assert.equal(resultOf(await h.stub.convert(h.stub.convertCmd(r))), 'TOMBSTONED');
});

test('P2-S55 link part: D_c is taken as given; a hold at ts ≥ D_c is refused', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 1, window: { start: H(10), end: H(11) }, deadlineInMs: 1_000 });
  r.commitFence = hlcToWallMs(h.rt.now().ts) + 100;   // the link uses D_c as given, not D − τ
  h.rt.advance(150);
  assert.equal(resultOf(await h.stub.hold(r)), 'REFUSED:"DEADLINE_PASSED"');
});

test('P2-S56 link part: a release of a withdrawn request that the link has not seen is a tombstone', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 1, window: { start: H(10), end: H(11) } });
  assert.equal(resultOf(await h.stub.release(h.stub.releaseCmd(r.request, r.deadline, 'WITHDRAWN'))), 'RELEASED');
  assert.equal(resultOf(await h.stub.hold(r)), 'REFUSED:"TOMBSTONED"');
});

test('P2-S92 link part: a hold counts only from its own entry', async () => {
  const h = await harness();
  const st = () => h.owner.stateOf(h.link);
  assert.equal(st()?.occAll.peak(H(10), H(11)), 0);
  const seqBefore = st()?.appliedSeq ?? 0n;
  await h.stub.hold(h.stub.holdCmd({ rate: 6, window: { start: H(10), end: H(11) } }));
  assert.equal(st()?.occAll.peak(H(10), H(11)), 6);
  const holdEntry = h.rt.log(Buffer.from(h.link)).find((e) => e.seq === seqBefore + 1n);
  assert.equal((holdEntry?.entry.payload as { op: string }).op, 'hold');
});

test('P2-S110 link part: refusal at ts ≥ D_c, with a tombstone', async () => {
  const h = await harness();
  const r = h.stub.holdCmd({ rate: 1, window: { start: H(10), end: H(11) }, deadlineInMs: 400 });
  // D_c = D − 420 ms is already past.
  assert.equal(resultOf(await h.stub.hold(r)), 'REFUSED:"DEADLINE_PASSED"');
  assert.equal(h.owner.stateOf(h.link)?.recordState(r.request)?.tombstoneUntil, r.deadline + 60_000);
});

test('P2-S112 link part: IN_FLIGHT is decided at the link in the hold entry, with no waiter', async () => {
  const h = await harness();
  const a = h.stub.holdCmd({ rate: 6, window: { start: H(10), end: H(11) }, deadlineInMs: 20_000 });
  await h.stub.hold(a);
  const appendsBefore = h.rt.appends.length;
  const b = await h.stub.hold(h.stub.holdCmd({ rate: 5, window: { start: H(10), end: H(11) }, wait: false })) as { result: string; retryAfterMs?: number };
  assert.equal(resultOf(b), 'REFUSED:"IN_FLIGHT"');
  assert.equal(h.rt.appends.length, appendsBefore + 1, 'one entry, no further hop');
  assert.ok(b.retryAfterMs !== undefined && b.retryAfterMs > 19_000 && b.retryAfterMs <= 20_000);
  assert.equal(h.owner.stateOf(h.link)?.holdsInOrder().length, 1, 'no waiter');
});
