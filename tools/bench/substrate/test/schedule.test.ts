import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ArrivalSchedule, driveArrivals, poissonGaps, seededRng, takeBatch } from '../src/schedule.ts';
import { ManualClock, flush } from './support.ts';

const item = (id: number, entries = 1, bytes = 100): { id: number; entries: number; bytes: number } => ({ id, entries, bytes });

describe('seeded generator and arrival gaps', () => {
  it('should give the same sequence for the same seed and another for another seed', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    const c = seededRng(43);
    const xa = Array.from({ length: 5 }, a);
    assert.deepEqual(Array.from({ length: 5 }, b), xa);
    assert.notDeepEqual(Array.from({ length: 5 }, c), xa);
    for (const x of xa) assert.ok(x >= 0 && x < 1);
  });

  it('should give exponential gaps with a mean of 1000 / rate ms', () => {
    const gap = poissonGaps(seededRng(11), 250);
    let sum = 0;
    const n = 200_000;
    for (let i = 0; i < n; i++) sum += gap();
    const mean = sum / n;
    assert.ok(Math.abs(mean - 4) < 0.04, `seed 11: mean gap ${mean} ms, expected 4 ms ± 1%`);
  });

  it('should refuse a rate that is not positive', () => {
    assert.throws(() => poissonGaps(seededRng(1), 0), RangeError);
  });
});

describe('open-loop arrivals', () => {
  it('should deliver each arrival with its intended time, also when the loop wakes late', async () => {
    const clock = new ManualClock(0);
    const got: Array<{ intended: number; at: number }> = [];
    const done = driveArrivals({
      schedule: new ArrivalSchedule(0, () => 10), clock, endMs: 100,
      onArrival: (intended) => { got.push({ intended, at: clock.now() }); },
    });
    await flush();
    assert.equal(got.length, 0);
    await clock.advanceTo(55);          // the loop wakes 45 ms late
    assert.deepEqual(got, [10, 20, 30, 40, 50].map((intended) => ({ intended, at: 55 })));
    await clock.advanceTo(60);
    assert.deepEqual(got.at(-1), { intended: 60, at: 60 });
    await clock.advanceTo(500);
    assert.equal(await done, 9);
    assert.deepEqual(got.map((g) => g.intended), [10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });

  it('should deliver no arrival at or after the end time', async () => {
    const clock = new ManualClock(0);
    const got: number[] = [];
    const done = driveArrivals({ schedule: new ArrivalSchedule(0, () => 25), clock, endMs: 75, onArrival: (t) => { got.push(t); } });
    await clock.advanceTo(1_000);
    assert.equal(await done, 2);
    assert.deepEqual(got, [25, 50]);
  });
});

describe('takeBatch', () => {
  it('should take every queued call when the queue is within the limits', () => {
    const q = [item(1), item(2), item(3)];
    assert.deepEqual(takeBatch(q, 10, 1_000).map((x) => x.id), [1, 2, 3]);
    assert.deepEqual(q, []);
  });

  it('should stop at the entry limit and keep the rest in order', () => {
    const q = [item(1, 2), item(2, 2), item(3, 2)];
    assert.deepEqual(takeBatch(q, 4, 1_000).map((x) => x.id), [1, 2]);
    assert.deepEqual(q.map((x) => x.id), [3]);
  });

  it('should stop at the byte limit', () => {
    const q = [item(1, 1, 400), item(2, 1, 400), item(3, 1, 400)];
    assert.deepEqual(takeBatch(q, 10, 1_000).map((x) => x.id), [1, 2]);
    assert.deepEqual(q.map((x) => x.id), [3]);
  });

  it('should take the first call alone when it is larger than a limit', () => {
    const q = [item(1, 5, 5_000), item(2)];
    assert.deepEqual(takeBatch(q, 4, 1_000).map((x) => x.id), [1]);
    assert.deepEqual(q.map((x) => x.id), [2]);
  });

  it('should take nothing from an empty queue', () => {
    assert.deepEqual(takeBatch([], 4, 1_000), []);
  });
});
