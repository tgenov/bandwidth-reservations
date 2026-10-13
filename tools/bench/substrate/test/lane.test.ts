import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SlotLane, type BatchDone, type Call } from '../src/lane.ts';
import type { ProtocolReport } from '../src/protocol.ts';
import { ManualClock, deferred, flush } from './support.ts';

const call = (intendedMs: number, partition = 0, entries = 1, bytes = 100): Call => ({ intendedMs, partition, entries, bytes, requestSeq: BigInt(intendedMs) });

const report = (at: number, outcome: ProtocolReport['outcome'] = { kind: 'committed' }): ProtocolReport =>
  ({ outcome, restarts: [], aborts: [], freshAttempts: 0, abandons: 0, beganMs: at, commitStartMs: at, endMs: at });

/** A lane whose batches finish only when the test says so. */
function harness(o: { maxEntries?: number; maxBytes?: number } = {}): {
  clock: ManualClock; lane: SlotLane; runs: Call[][]; done: BatchDone[]; finish: (outcome?: ProtocolReport['outcome']) => Promise<void>;
} {
  const clock = new ManualClock(0);
  const runs: Call[][] = [];
  const done: BatchDone[] = [];
  const pending: Array<ReturnType<typeof deferred<ProtocolReport>>> = [];
  const lane = new SlotLane({
    slot: 3, clock, maxEntries: o.maxEntries ?? 2_000, maxBytes: o.maxBytes ?? 4_194_304,
    run: (calls) => { runs.push(calls); const d = deferred<ProtocolReport>(); pending.push(d); return d.promise; },
    onBatch: (d) => { done.push(d); },
  });
  const finish = async (outcome?: ProtocolReport['outcome']): Promise<void> => {
    const d = pending.shift();
    if (!d) throw new Error('no batch in flight');
    d.resolve(report(clock.now(), outcome));
    await flush();
  };
  return { clock, lane, runs, done, finish };
}

describe('slot lane (RFC-006 §4.3: one batch transaction in flight per slot)', () => {
  it('should start a batch at once on an idle lane', async () => {
    const h = harness();
    h.clock.set(5);
    h.lane.enqueue(call(5));
    await flush();
    assert.deepEqual(h.runs.map((r) => r.map((c) => c.intendedMs)), [[5]]);
    assert.equal(h.lane.inFlight, true);
  });

  it('should keep one batch in flight and carry every call that arrived meanwhile in the next batch', async () => {
    const h = harness();
    h.lane.enqueue(call(0));
    await flush();
    h.clock.set(10); h.lane.enqueue(call(10, 1));
    h.clock.set(12); h.lane.enqueue(call(12, 2));
    await flush();
    assert.equal(h.runs.length, 1);
    assert.equal(h.lane.queued, 2);
    h.clock.set(30);
    await h.finish();
    assert.deepEqual(h.runs.map((r) => r.map((c) => c.intendedMs)), [[0], [10, 12]]);
    assert.deepEqual(h.done.map((d) => [d.startMs, d.calls.length]), [[0, 1]]);
    h.clock.set(55);
    await h.finish();
    assert.deepEqual(h.done.map((d) => [d.startMs, d.calls.length]), [[0, 1], [30, 2]]);
    assert.equal(h.lane.inFlight, false);
  });

  it('should split the queue at the entry limit', async () => {
    const h = harness({ maxEntries: 2 });
    h.lane.enqueue(call(0));
    await flush();
    for (const t of [1, 2, 3]) h.lane.enqueue(call(t));
    await h.finish();
    await h.finish();
    assert.deepEqual(h.runs.map((r) => r.map((c) => c.intendedMs)), [[0], [1, 2], [3]]);
  });

  it('should resolve idle only when the queue is empty and no batch is in flight', async () => {
    const h = harness();
    let idle = false;
    h.lane.enqueue(call(0));
    h.lane.enqueue(call(1));
    void h.lane.idle().then(() => { idle = true; });
    await h.finish();
    assert.equal(idle, false);
    await h.finish();
    assert.equal(idle, true);
  });

  it('should stop taking batches after a stale epoch and keep the queued calls unanswered', async () => {
    const h = harness();
    h.lane.enqueue(call(0));
    await flush();
    h.lane.enqueue(call(1));
    await h.finish({ kind: 'staleEpoch' });
    assert.equal(h.runs.length, 1);
    assert.equal(h.lane.stopped, true);
    assert.equal(h.lane.queued, 1);
    h.lane.enqueue(call(2));
    await flush();
    assert.equal(h.runs.length, 1);
    assert.equal(h.lane.queued, 2);
    await h.lane.idle();
  });

  it('should go on after a batch that ends in retry or failure', async () => {
    const h = harness();
    h.lane.enqueue(call(0));
    await flush();
    h.lane.enqueue(call(1));
    await h.finish({ kind: 'retry' });
    assert.equal(h.runs.length, 2);
    await h.finish({ kind: 'failed', code: '23505' });
    assert.deepEqual(h.done.map((d) => d.report.outcome.kind), ['retry', 'failed']);
  });

  it('should report a batch whose runner throws as failed and go on', async () => {
    const clock = new ManualClock(0);
    const done: BatchDone[] = [];
    let n = 0;
    const lane = new SlotLane({
      slot: 0, clock, maxEntries: 10, maxBytes: 1_000,
      run: async () => { n += 1; if (n === 1) throw new Error('bug'); return report(0); },
      onBatch: (d) => { done.push(d); },
    });
    lane.enqueue(call(0));
    lane.enqueue(call(1));
    await lane.idle();
    assert.deepEqual(done.map((d) => d.report.outcome), [{ kind: 'failed', code: 'runner' }, { kind: 'committed' }]);
  });
});
