import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseConfig } from '../src/config.ts';
import type { BatchDone, Call } from '../src/lane.ts';
import type { ProtocolReport } from '../src/protocol.ts';
import { MergeError, Recorder, buildResult, formatSummary, mergeResults, summarise, type ClientStats, type DbStats, type RunResult } from '../src/results.ts';

const call = (intendedMs: number, partition = 0): Call => ({ intendedMs, partition, entries: 1, bytes: 100, requestSeq: 0n });

function done(calls: Call[], startMs: number, r: Partial<ProtocolReport> = {}): BatchDone {
  return {
    calls, startMs,
    report: { outcome: { kind: 'committed' }, restarts: [], aborts: [], freshAttempts: 0, abandons: 0, beganMs: startMs, commitStartMs: startMs, endMs: startMs, ...r },
  };
}

const STATS = { all: 12, data: 9 };
const CLIENT: ClientStats = { processId: 'p1', cpuUs: 50_000, rssMB: 80, loopDelayP99Us: 2_000, loopDelayP999Us: 4_000, loopDelayMaxUs: 9_000 };

function result(o: { recorder: Recorder; processId?: string; topology?: string; db?: DbStats | null; client?: ClientStats }): RunResult {
  const config = parseConfig({ SUBSTRATE_TOPOLOGY: o.topology ?? 'lab', SUBSTRATE_PROCESS: o.processId ?? 'p1', SUBSTRATE_DURATION_S: '11', SUBSTRATE_WARMUP_S: '1' }, 'h');
  return buildResult({ config, startedAt: '2026-10-13T00:00:00.000Z', dbVersion: 'CockroachDB CCL v25.2.0', data: o.recorder.data, client: o.client ?? CLIENT, db: o.db ?? null });
}

describe('Recorder', () => {
  it('should count only arrivals and calls intended inside the measurement window', () => {
    const r = new Recorder({ runStartMs: 0, startMs: 1_000, endMs: 11_000 });
    for (const t of [999, 1_000, 10_999, 11_000]) r.arrival(t);
    r.batch(done([call(999), call(1_000)], 1_000, { endMs: 1_010 }), STATS);
    const d = r.data;
    assert.equal(d.counters.offered, 2);
    assert.equal(d.counters.committedCalls, 1);
    assert.equal(d.histograms.entryUs.count, 1);
  });

  it('should count batch statistics only for batches started inside the window', () => {
    const r = new Recorder({ runStartMs: 0, startMs: 1_000, endMs: 11_000 });
    r.batch(done([call(990)], 990, { endMs: 1_020 }), STATS);
    r.batch(done([call(11_000)], 11_000, { endMs: 11_020 }), STATS);
    r.batch(done([call(1_500)], 1_500, { endMs: 1_520 }), STATS);
    const d = r.data;
    assert.equal(d.counters.committedBatches, 1);
    assert.equal(d.counters.statements, 12);
    assert.equal(d.counters.dataStatements, 9);
    assert.equal(d.histograms.txnUs.count, 1);
  });

  it('should measure batch wait and entry latency from the intended time, not from the send', () => {
    const r = new Recorder({ runStartMs: 0, startMs: 0, endMs: 10_000 });
    r.batch(done([call(1_000), call(1_030)], 1_040, { beganMs: 1_042, commitStartMs: 1_060, endMs: 1_070 }), STATS);
    const h = r.data.histograms;
    assert.deepEqual([h.batchWaitUs.min, h.batchWaitUs.max], [10_000, 40_000]);
    assert.deepEqual([h.entryUs.min, h.entryUs.max], [40_000, 70_000]);
    assert.deepEqual([h.connectUs.max, h.txnUs.max, h.commitUs.max], [2_000, 28_000, 10_000]);
    assert.deepEqual([h.callsPerBatch.max, h.partitionsPerBatch.max], [2, 1]);
  });

  it('should count distinct partitions per batch', () => {
    const r = new Recorder({ runStartMs: 0, startMs: 0, endMs: 10_000 });
    r.batch(done([call(0, 1), call(0, 2), call(0, 1)], 0), STATS);
    assert.equal(r.data.histograms.partitionsPerBatch.max, 2);
  });

  it('should count restarts and aborts by reason and keep them apart', () => {
    const r = new Recorder({ runStartMs: 0, startMs: 0, endMs: 10_000 });
    r.batch(done([call(0)], 0, { restarts: ['RETRY_SERIALIZABLE', 'RETRY_SERIALIZABLE', 'WriteTooOldError'], aborts: ['ABORT_REASON_PUSHER_ABORTED'], abandons: 1, freshAttempts: 1 }), STATS);
    const c = r.data.counters;
    assert.deepEqual(c.restarts, { RETRY_SERIALIZABLE: 2, WriteTooOldError: 1 });
    assert.deepEqual(c.aborts, { ABORT_REASON_PUSHER_ABORTED: 1 });
    assert.deepEqual([c.abandons, c.freshAttempts], [1, 1]);
  });

  it('should count each outcome that is not a commit, and record no entry latency for it', () => {
    const r = new Recorder({ runStartMs: 0, startMs: 0, endMs: 10_000 });
    r.batch(done([call(0), call(1)], 0, { outcome: { kind: 'retry' } }), STATS);
    r.batch(done([call(2)], 2, { outcome: { kind: 'ambiguous', reason: '40003' } }), STATS);
    r.batch(done([call(3)], 3, { outcome: { kind: 'staleEpoch' } }), STATS);
    r.batch(done([call(4)], 4, { outcome: { kind: 'failed', code: '23505' } }), STATS);
    const d = r.data;
    assert.deepEqual([d.counters.retryCalls, d.counters.ambiguousBatches, d.counters.staleEpochBatches, d.counters.failedBatches, d.counters.committedCalls],
      [2, 1, 1, 1, 0]);
    assert.deepEqual(d.counters.errors, { '23505': 1, ambiguous_40003: 1 });
    assert.equal(d.histograms.entryUs.count, 0);
  });

  it('should count unanswered calls in the window only', () => {
    const r = new Recorder({ runStartMs: 0, startMs: 1_000, endMs: 11_000 });
    r.unanswered([call(500), call(2_000), call(3_000)]);
    assert.equal(r.data.counters.unanswered, 2);
  });

  it('should keep a per-second timeline of commits by end time over the whole run', () => {
    const r = new Recorder({ runStartMs: 100, startMs: 1_100, endMs: 11_100 });
    r.batch(done([call(150), call(160)], 200, { beganMs: 200, endMs: 300 }), STATS);
    r.batch(done([call(1_100)], 2_000, { beganMs: 2_000, endMs: 2_150 }), STATS);
    r.batch(done([call(1_100)], 2_000, { beganMs: 2_000, endMs: 2_120, outcome: { kind: 'retry' } }), STATS);
    assert.deepEqual(r.data.timeline, [
      { second: 0, committedCalls: 2, notCommittedBatches: 0, maxTxnUs: 100_000 },
      { second: 1, committedCalls: 0, notCommittedBatches: 0, maxTxnUs: 0 },
      { second: 2, committedCalls: 1, notCommittedBatches: 1, maxTxnUs: 150_000 },
    ]);
  });
});

describe('summarise', () => {
  function summaryWith(cpuNs: number, dataStatements: number): ReturnType<typeof summarise> {
    const r = new Recorder({ runStartMs: 0, startMs: 1_000, endMs: 11_000 });
    for (let i = 0; i < 100; i++) {
      r.arrival(1_000 + i * 100);
      r.batch(done([call(1_000 + i * 100)], 1_000 + i * 100, { endMs: 1_020 + i * 100 }), { all: 0, data: dataStatements / 100 });
    }
    return summarise(result({ recorder: r, db: { processId: 'p1', cpuNs, nodes: 5, metrics: { 'txn.restarts.serializable': 3 } } }));
  }

  it('should give throughput per second of the window and the database cost per statement', () => {
    const s = summaryWith(2e9, 2_000);
    assert.deepEqual([s.windowS, s.offeredPerS, s.committedCallsPerS, s.committedTxnPerS], [10, 10, 10, 10]);
    assert.deepEqual(s.db, { cpuUsPerTxn: 20_000, dataStatementsPerVcpuS: 1_000, estimate: 1_000, withinEstimate: true, nodes: 5, metrics: { 'txn.restarts.serializable': 3 } });
    assert.deepEqual(s.latencyMs.txn, { p50: 20, p99: 20, p999: 20, max: 20, count: 100 });
  });

  it('should judge the cost within the estimate up to 25 % from 1,000 statements per vCPU-second (RFC-006 §22.1)', () => {
    assert.equal(summaryWith(1e9, 1_250).db?.withinEstimate, true);
    assert.equal(summaryWith(1e9, 1_260).db?.withinEstimate, false);
    assert.equal(summaryWith(1e9, 750).db?.withinEstimate, true);
    assert.equal(summaryWith(1e9, 740).db?.withinEstimate, false);
  });

  it('should mark the run saturated when more than 0.1 % of offered calls are unanswered', () => {
    const r = new Recorder({ runStartMs: 0, startMs: 0, endMs: 10_000 });
    for (let i = 0; i < 2_000; i++) r.arrival(i);
    r.unanswered([call(1), call(2)]);
    assert.equal(summarise(result({ recorder: r })).saturated, false);
    r.unanswered([call(3)]);
    assert.equal(summarise(result({ recorder: r })).saturated, true);
  });

  it('should give no database block when no database metrics were read', () => {
    const r = new Recorder({ runStartMs: 0, startMs: 0, endMs: 10_000 });
    assert.equal(summarise(result({ recorder: r })).db, null);
  });

  it('should print the label, the latencies and the retry counts in the text summary', () => {
    const text = formatSummary(summaryWith(2e9, 2_000));
    assert.match(text, /^substrate lab \(crdb, lab, 1 process\)$/m);
    assert.match(text, /^txn ms\s+p50 20\.00\s+p99 20\.00\s+p99\.9 20\.00\s+max 20\.00\s+n 100$/m);
    assert.match(text, /^db cpu µs\/txn 20000\.0\s+data statements\/vCPU-s 1000\s+within ±25% of 1000: yes$/m);
  });
});

describe('mergeResults', () => {
  function one(processId: string, offered: number, db: DbStats | null): RunResult {
    const r = new Recorder({ runStartMs: 0, startMs: 0, endMs: 10_000 });
    for (let i = 0; i < offered; i++) {
      r.arrival(i);
      r.batch(done([call(i)], i, { endMs: i + 5, restarts: ['RETRY_SERIALIZABLE'] }), STATS);
    }
    return result({ recorder: r, processId, db, client: { ...CLIENT, processId } });
  }

  it('should sum counters, merge histograms and keep every process', () => {
    const m = mergeResults([one('p1', 3, null), one('p2', 4, null)]);
    assert.equal(m.counters.offered, 7);
    assert.equal(m.counters.committedCalls, 7);
    assert.deepEqual(m.counters.restarts, { RETRY_SERIALIZABLE: 7 });
    assert.equal(m.histograms.txnUs.count, 7);
    assert.deepEqual(m.processIds, ['p1', 'p2']);
    assert.equal(m.clients.length, 2);
    assert.equal(m.timeline[0]?.committedCalls, 7);
    assert.equal(summarise(m).processes, 2);
  });

  it('should keep one database block and warn when more than one process read the cluster metrics', () => {
    const db1: DbStats = { processId: 'p1', cpuNs: 1e9, nodes: 5, metrics: {} };
    const db2: DbStats = { processId: 'p2', cpuNs: 2e9, nodes: 5, metrics: {} };
    const m = mergeResults([one('p1', 1, db1), one('p2', 1, db2)]);
    assert.deepEqual(m.db, db1);
    assert.deepEqual(m.warnings, ['database metrics came from more than one process (p1, p2); kept p1 only, because each reads the whole cluster']);
  });

  it('should refuse to merge runs of different topologies', () => {
    const a = one('p1', 1, null);
    const b = { ...one('p2', 1, null), topology: 'other' };
    assert.throws(() => mergeResults([a, b]), (e: unknown) => e instanceof MergeError && e.field === 'topology');
  });
});
