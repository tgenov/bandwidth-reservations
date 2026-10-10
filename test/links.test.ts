import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkBook, type Ticket } from '../src/links.ts';

const DAY = 24 * 60;

function book(opts: { clock?: () => number } = {}) {
  return new LinkBook(1, 10, DAY, opts);
}

const req = (key: string, sagaId: number, s: number, e: number | null, mbps: number) => ({
  key, sagaId, ticket: [sagaId, sagaId] as Ticket, s, e, mbps,
});

test('hold counts against total, confirm moves it to confirmed, release after confirm is a no-op', () => {
  const b = book();
  assert.equal(b.tryHold(req('a', 1, 0, 60, 4), 1000).kind, 'held');
  assert.equal(b.total.peak(0, 60), 4);
  assert.equal(b.confirmed.peak(0, 60), 0);
  b.confirm('a');
  assert.equal(b.confirmed.peak(0, 60), 4);
  assert.equal(b.total.peak(0, 60), 4);
  b.release('a');
  assert.equal(b.total.peak(0, 60), 4, 'a confirmed reservation is never released by a stray release');
});

test('three outcomes: hold, wait (fits only if holds release), reject (misses on confirmed)', () => {
  const b = book();
  assert.equal(b.tryHold(req('c', 1, 0, 60, 6), 1000).kind, 'held');
  b.confirm('c'); // confirmed 6
  assert.equal(b.tryHold(req('h', 2, 0, 60, 3), 1000).kind, 'held'); // saga 2 holds 3

  // Saga 3 is younger than saga 2: it fits on confirmed (6 + 3) but not with the hold.
  assert.deepEqual(b.tryHold(req('w', 3, 30, 90, 3), 1000), { kind: 'wait', blockers: [2] });
  // Does not fit even on confirmed: definitive, with the exact conflicting minutes.
  assert.deepEqual(b.tryHold(req('r', 3, 30, 90, 5), 1000), { kind: 'reject', peak: 6, conflicts: [[30, 60]] });
  // Fits outright.
  assert.equal(b.tryHold(req('ok', 3, 0, 60, 1), 1000).kind, 'held');
  assert.equal(b.peakUsage(), 10);
});

test('touching windows do not conflict: [0, 60) and [60, 120)', () => {
  const b = book();
  assert.equal(b.tryHold(req('a', 1, 0, 60, 10), 1000).kind, 'held');
  assert.equal(b.tryHold(req('b', 2, 60, 120, 10), 1000).kind, 'held');
});

test('tryHold and release are idempotent by key', () => {
  const b = book();
  assert.equal(b.tryHold(req('a', 1, 0, 60, 6), 1000).kind, 'held');
  assert.equal(b.tryHold(req('a', 1, 0, 60, 6), 1000).kind, 'held');
  assert.equal(b.total.peak(0, 60), 6, 'a retried hold is not counted twice');
  b.release('a');
  b.release('a');
  assert.equal(b.total.peak(0, 60), 0);
});

test('unpinned holds expire and wake waiters; pinned holds do not expire', async () => {
  let now = 0;
  const b = book({ clock: () => now });
  b.tryHold(req('a', 1, 0, 60, 10), 100);
  b.tryHold(req('p', 1, 60, 120, 10), 100);
  b.pin('p');
  const woke = b.changed();
  now = 100;
  assert.equal(b.tryHold(req('x', 2, 0, 60, 10), 100).kind, 'held', 'expired capacity is free again');
  await woke;
  assert.equal(b.tryHold(req('y', 2, 60, 120, 1), 100).kind, 'wait', 'pinned hold still counts');
});

test('wound-wait: an older request wounds younger unpinned holds; a younger one waits', () => {
  const b = book();
  const wounded: number[] = [];
  b.onWound = (id) => wounded.push(id);

  b.tryHold(req('young', 5, 0, 60, 8), 1000);
  // Saga 2 is older than saga 5: it revokes saga 5's hold and takes the capacity.
  assert.equal(b.tryHold(req('old', 2, 0, 60, 8), 1000).kind, 'held');
  assert.deepEqual(wounded, [5]);
  assert.equal(b.has('young'), false);

  // Saga 7 is younger than saga 2: it waits, and wounds nobody.
  assert.equal(b.tryHold(req('younger', 7, 0, 60, 8), 1000).kind, 'wait');
  assert.deepEqual(wounded, [5]);

  // A pinned hold (commit decision made) is never wounded, even by an older saga.
  b.pin('old');
  assert.equal(b.tryHold(req('oldest', 1, 0, 60, 8), 1000).kind, 'wait');
  assert.deepEqual(wounded, [5]);
});
