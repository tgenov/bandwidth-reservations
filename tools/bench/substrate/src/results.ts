/**
 * Measurement and results. The window is [startMs, endMs): warm-up before it and drain after it are not counted.
 * A call counts when its intended time is in the window; a batch counts when it started in the window. Latency of
 * a call is measured from its intended time, so a slow database or a late generator shows in it.
 */
import type { SubstrateConfig } from './config.ts';
import { Histogram, type HistogramJson } from './histogram.ts';
import type { BatchDone, Call } from './lane.ts';

export interface Counters {
  offered: number;
  committedCalls: number;
  committedBatches: number;
  /** Calls answered `Retry` after the restarts and the fresh attempt (C01 R47-12). */
  retryCalls: number;
  ambiguousBatches: number;
  staleEpochBatches: number;
  failedBatches: number;
  /** Calls in the window with no answer at the end of the drain. */
  unanswered: number;
  restarts: Record<string, number>;
  aborts: Record<string, number>;
  abandons: number;
  freshAttempts: number;
  /** Every statement sent, transaction control included. */
  statements: number;
  /** Data statements only (RFC-006 §19.2 counts these). */
  dataStatements: number;
  errors: Record<string, number>;
}

export const HISTOGRAMS = ['txnUs', 'commitUs', 'entryUs', 'batchWaitUs', 'connectUs', 'callsPerBatch', 'partitionsPerBatch'] as const;
export type HistogramName = (typeof HISTOGRAMS)[number];

export interface TimelineSecond {
  second: number;
  committedCalls: number;
  notCommittedBatches: number;
  maxTxnUs: number;
}

export interface RecorderData {
  counters: Counters;
  histograms: Record<HistogramName, Histogram>;
  timeline: TimelineSecond[];
}

const emptyCounters = (): Counters => ({
  offered: 0, committedCalls: 0, committedBatches: 0, retryCalls: 0, ambiguousBatches: 0, staleEpochBatches: 0, failedBatches: 0,
  unanswered: 0, restarts: {}, aborts: {}, abandons: 0, freshAttempts: 0, statements: 0, dataStatements: 0, errors: {},
});

const bump = (m: Record<string, number>, k: string, n = 1): void => { m[k] = (m[k] ?? 0) + n; };
const usOf = (ms: number): number => Math.max(0, Math.round(ms * 1000));

/** Collects counters, histograms and the per-second timeline of one process. */
export class Recorder {
  private readonly w: { runStartMs: number; startMs: number; endMs: number };
  private readonly c = emptyCounters();
  private readonly h = Object.fromEntries(HISTOGRAMS.map((n) => [n, new Histogram()])) as Record<HistogramName, Histogram>;
  private readonly t: TimelineSecond[] = [];

  constructor(w: { runStartMs: number; startMs: number; endMs: number }) {
    this.w = w;
  }

  private inWindow(ms: number): boolean {
    return ms >= this.w.startMs && ms < this.w.endMs;
  }

  arrival(intendedMs: number): void {
    if (this.inWindow(intendedMs)) this.c.offered += 1;
  }

  /** One finished batch and the statements its attempts sent. */
  batch(d: BatchDone, statements: { all: number; data: number }): void {
    const r = d.report;
    const committed = r.outcome.kind === 'committed';
    const txnUs = usOf(r.endMs - r.beganMs);
    const sec = Math.max(0, Math.floor((r.endMs - this.w.runStartMs) / 1000));
    while (this.t.length <= sec) this.t.push({ second: this.t.length, committedCalls: 0, notCommittedBatches: 0, maxTxnUs: 0 });
    const slot = this.t[sec] as TimelineSecond;
    if (committed) slot.committedCalls += d.calls.length;
    else slot.notCommittedBatches += 1;
    slot.maxTxnUs = Math.max(slot.maxTxnUs, txnUs);

    for (const call of d.calls) {
      if (!this.inWindow(call.intendedMs)) continue;
      this.h.batchWaitUs.record(usOf(d.startMs - call.intendedMs));
      if (committed) {
        this.c.committedCalls += 1;
        this.h.entryUs.record(usOf(r.endMs - call.intendedMs));
      } else if (r.outcome.kind === 'retry') {
        this.c.retryCalls += 1;
      }
    }
    if (!this.inWindow(d.startMs)) return;
    this.c.statements += statements.all;
    this.c.dataStatements += statements.data;
    for (const x of r.restarts) bump(this.c.restarts, x);
    for (const x of r.aborts) bump(this.c.aborts, x);
    this.c.abandons += r.abandons;
    this.c.freshAttempts += r.freshAttempts;
    this.h.connectUs.record(usOf(r.beganMs - d.startMs));
    this.h.callsPerBatch.record(d.calls.length);
    this.h.partitionsPerBatch.record(new Set(d.calls.map((x) => x.partition)).size);
    switch (r.outcome.kind) {
      case 'committed':
        this.c.committedBatches += 1;
        this.h.txnUs.record(txnUs);
        this.h.commitUs.record(usOf(r.endMs - r.commitStartMs));
        break;
      case 'retry':
        break;
      case 'ambiguous':
        this.c.ambiguousBatches += 1;
        bump(this.c.errors, `ambiguous_${r.outcome.reason}`);
        break;
      case 'staleEpoch':
        this.c.staleEpochBatches += 1;
        break;
      case 'failed':
        this.c.failedBatches += 1;
        bump(this.c.errors, r.outcome.code);
        break;
    }
  }

  /** Calls still queued at the end. */
  unanswered(calls: readonly Call[]): void {
    for (const c of calls) if (this.inWindow(c.intendedMs)) this.c.unanswered += 1;
  }

  get data(): RecorderData {
    return { counters: this.c, histograms: this.h, timeline: this.t };
  }
}

/** The generator process: its CPU in the window and its own event-loop delay (a late loop delays arrivals). */
export interface ClientStats {
  processId: string;
  cpuUs: number;
  rssMB: number;
  loopDelayP99Us: number;
  loopDelayP999Us: number;
  loopDelayMaxUs: number;
}

/** Cluster-wide CockroachDB figures over the window (crdb_internal.kv_node_status, every node). */
export interface DbStats {
  processId: string;
  /** sys.cpu.user.ns + sys.cpu.sys.ns over every node. */
  cpuNs: number;
  nodes: number;
  /** Deltas of the selected metrics, summed over the nodes. */
  metrics: Record<string, number>;
}

export interface RunResult {
  schema: 'substrate-bench/1';
  label: string;
  topology: string;
  flavour: string;
  dbVersion: string;
  startedAt: string;
  windowS: number;
  processIds: string[];
  configs: SubstrateConfig[];
  counters: Counters;
  histograms: Record<HistogramName, HistogramJson>;
  timeline: TimelineSecond[];
  clients: ClientStats[];
  db: DbStats | null;
  warnings: string[];
}

/** The result of one process. */
export function buildResult(o: { config: SubstrateConfig; startedAt: string; dbVersion: string; data: RecorderData; client: ClientStats; db: DbStats | null }): RunResult {
  const c = o.config;
  return {
    schema: 'substrate-bench/1', label: c.label, topology: c.topology, flavour: c.flavour, dbVersion: o.dbVersion, startedAt: o.startedAt,
    windowS: c.durationS - c.warmupS, processIds: [c.processId], configs: [c], counters: structuredClone(o.data.counters),
    histograms: Object.fromEntries(HISTOGRAMS.map((n) => [n, o.data.histograms[n].toJSON()])) as Record<HistogramName, HistogramJson>,
    timeline: structuredClone(o.data.timeline), clients: [o.client], db: o.db, warnings: [],
  };
}

/** A merge of results that cannot be compared. */
export class MergeError extends Error {
  readonly field: 'topology' | 'flavour' | 'label' | 'empty';
  constructor(field: MergeError['field'], message: string) {
    super(message);
    this.name = 'MergeError';
    this.field = field;
  }
}

const sumRecords = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
};

/** Merges the results of processes that ran together against one cluster. */
export function mergeResults(rs: RunResult[]): RunResult {
  const first = rs[0];
  if (!first) throw new MergeError('empty', 'nothing to merge');
  for (const r of rs) {
    for (const f of ['topology', 'flavour', 'label'] as const) {
      if (r[f] !== first[f]) throw new MergeError(f, `cannot merge results of different ${f}: ${first[f]} and ${r[f]}`);
    }
  }
  const counters = rs.slice(1).reduce<Counters>((acc, r) => {
    const c = r.counters;
    return {
      offered: acc.offered + c.offered, committedCalls: acc.committedCalls + c.committedCalls, committedBatches: acc.committedBatches + c.committedBatches,
      retryCalls: acc.retryCalls + c.retryCalls, ambiguousBatches: acc.ambiguousBatches + c.ambiguousBatches,
      staleEpochBatches: acc.staleEpochBatches + c.staleEpochBatches, failedBatches: acc.failedBatches + c.failedBatches,
      unanswered: acc.unanswered + c.unanswered, restarts: sumRecords(acc.restarts, c.restarts), aborts: sumRecords(acc.aborts, c.aborts),
      abandons: acc.abandons + c.abandons, freshAttempts: acc.freshAttempts + c.freshAttempts, statements: acc.statements + c.statements,
      dataStatements: acc.dataStatements + c.dataStatements, errors: sumRecords(acc.errors, c.errors),
    };
  }, structuredClone(first.counters));
  const histograms = Object.fromEntries(HISTOGRAMS.map((n) => {
    const h = Histogram.fromJSON(first.histograms[n]);
    for (const r of rs.slice(1)) h.merge(Histogram.fromJSON(r.histograms[n]));
    return [n, h.toJSON()];
  })) as Record<HistogramName, HistogramJson>;
  const timeline: TimelineSecond[] = [];
  for (const r of rs) {
    for (const s of r.timeline) {
      while (timeline.length <= s.second) timeline.push({ second: timeline.length, committedCalls: 0, notCommittedBatches: 0, maxTxnUs: 0 });
      const t = timeline[s.second] as TimelineSecond;
      t.committedCalls += s.committedCalls;
      t.notCommittedBatches += s.notCommittedBatches;
      t.maxTxnUs = Math.max(t.maxTxnUs, s.maxTxnUs);
    }
  }
  const dbs = rs.map((r) => r.db).filter((d): d is DbStats => d !== null);
  const warnings = rs.flatMap((r) => r.warnings);
  if (dbs.length > 1) {
    warnings.push(`database metrics came from more than one process (${dbs.map((d) => d.processId).join(', ')}); kept ${dbs[0]?.processId} only, because each reads the whole cluster`);
  }
  return {
    ...first, windowS: Math.max(...rs.map((r) => r.windowS)), startedAt: rs.map((r) => r.startedAt).sort()[0] ?? first.startedAt,
    processIds: rs.flatMap((r) => r.processIds), configs: rs.flatMap((r) => r.configs), counters, histograms, timeline,
    clients: rs.flatMap((r) => r.clients), db: dbs[0] ?? null, warnings,
  };
}

export interface LatencyMs { p50: number; p99: number; p999: number; max: number; count: number }

/** RFC-006 §19.2: about 1,000 statements per vCPU-second (est.); §22.1 accepts ± 25 %. */
export const STATEMENTS_PER_VCPU_S_ESTIMATE = 1_000;
const SATURATED_SHARE = 0.001;

export interface Summary {
  label: string;
  topology: string;
  flavour: string;
  dbVersion: string;
  processes: number;
  windowS: number;
  offeredPerS: number;
  committedCallsPerS: number;
  committedTxnPerS: number;
  meanCallsPerBatch: number;
  meanPartitionsPerBatch: number;
  latencyMs: { txn: LatencyMs; commit: LatencyMs; entry: LatencyMs; batchWait: LatencyMs; connect: LatencyMs };
  restarts: number;
  aborts: number;
  restartsPerTxn: number;
  abortsPerTxn: number;
  retryCalls: number;
  ambiguousBatches: number;
  staleEpochBatches: number;
  failedBatches: number;
  unanswered: number;
  saturated: boolean;
  statementsPerTxn: number;
  dataStatementsPerTxn: number;
  clientCpuUsPerTxn: number;
  clientLoopDelayMaxP999Ms: number;
  db: { cpuUsPerTxn: number; dataStatementsPerVcpuS: number; estimate: number; withinEstimate: boolean; nodes: number; metrics: Record<string, number> } | null;
  warnings: string[];
}

const ms = (us: number): number => us / 1000;
function latency(j: HistogramJson): LatencyMs {
  const h = Histogram.fromJSON(j);
  return { p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), p999: ms(h.percentile(99.9)), max: ms(h.max), count: h.count };
}
const total = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);
const per = (a: number, b: number): number => (b === 0 ? 0 : a / b);

/** The figures RFC-006 §22.1 asks for, from a result. */
export function summarise(r: RunResult): Summary {
  const c = r.counters;
  const calls = Histogram.fromJSON(r.histograms.callsPerBatch);
  // Every batch started in the window, whatever its outcome, has one callsPerBatch sample.
  const batches = calls.count;
  const restarts = total(c.restarts);
  const aborts = total(c.aborts);
  const parts = Histogram.fromJSON(r.histograms.partitionsPerBatch);
  let db: Summary['db'] = null;
  if (r.db) {
    const perVcpuS = per(c.dataStatements, r.db.cpuNs / 1e9);
    db = {
      cpuUsPerTxn: per(r.db.cpuNs / 1000, c.committedBatches),
      dataStatementsPerVcpuS: perVcpuS,
      estimate: STATEMENTS_PER_VCPU_S_ESTIMATE,
      withinEstimate: Math.abs(perVcpuS / STATEMENTS_PER_VCPU_S_ESTIMATE - 1) <= 0.25 + 1e-9,
      nodes: r.db.nodes,
      metrics: r.db.metrics,
    };
  }
  return {
    label: r.label, topology: r.topology, flavour: r.flavour, dbVersion: r.dbVersion, processes: r.processIds.length, windowS: r.windowS,
    offeredPerS: per(c.offered, r.windowS), committedCallsPerS: per(c.committedCalls, r.windowS), committedTxnPerS: per(c.committedBatches, r.windowS),
    meanCallsPerBatch: per(calls.sum, calls.count), meanPartitionsPerBatch: per(parts.sum, parts.count),
    latencyMs: {
      txn: latency(r.histograms.txnUs), commit: latency(r.histograms.commitUs), entry: latency(r.histograms.entryUs),
      batchWait: latency(r.histograms.batchWaitUs), connect: latency(r.histograms.connectUs),
    },
    restarts, aborts, restartsPerTxn: per(restarts, batches), abortsPerTxn: per(aborts, batches),
    retryCalls: c.retryCalls, ambiguousBatches: c.ambiguousBatches, staleEpochBatches: c.staleEpochBatches, failedBatches: c.failedBatches,
    unanswered: c.unanswered, saturated: c.unanswered > SATURATED_SHARE * c.offered,
    statementsPerTxn: per(c.statements, batches), dataStatementsPerTxn: per(c.dataStatements, batches),
    clientCpuUsPerTxn: per(r.clients.reduce((a, x) => a + x.cpuUs, 0), c.committedBatches),
    clientLoopDelayMaxP999Ms: ms(Math.max(0, ...r.clients.map((x) => x.loopDelayP999Us))),
    db, warnings: r.warnings,
  };
}

const f2 = (n: number): string => n.toFixed(2);
const line = (name: string, l: LatencyMs): string => `${name.padEnd(14)} p50 ${f2(l.p50)}  p99 ${f2(l.p99)}  p99.9 ${f2(l.p999)}  max ${f2(l.max)}  n ${l.count}`;

/** A short text summary for the terminal. */
export function formatSummary(s: Summary): string {
  const out = [
    `substrate ${s.label} (${s.flavour}, ${s.topology}, ${s.processes} process${s.processes === 1 ? '' : 'es'})`,
    `database       ${s.dbVersion}`,
    `window s       ${s.windowS}   offered calls/s ${s.offeredPerS.toFixed(1)}   committed calls/s ${s.committedCallsPerS.toFixed(1)}   txn/s ${s.committedTxnPerS.toFixed(1)}`,
    `per batch      calls ${s.meanCallsPerBatch.toFixed(2)}   partitions ${s.meanPartitionsPerBatch.toFixed(2)}   statements ${s.statementsPerTxn.toFixed(1)} (data ${s.dataStatementsPerTxn.toFixed(1)})`,
    line('txn ms', s.latencyMs.txn),
    line('commit ms', s.latencyMs.commit),
    line('entry ms', s.latencyMs.entry),
    line('batch wait ms', s.latencyMs.batchWait),
    line('connect ms', s.latencyMs.connect),
    `retries        restarts ${s.restarts} (${s.restartsPerTxn.toFixed(4)}/txn)   aborts ${s.aborts} (${s.abortsPerTxn.toFixed(4)}/txn)   retry answers ${s.retryCalls}`,
    `not committed  ambiguous ${s.ambiguousBatches}   stale epoch ${s.staleEpochBatches}   failed ${s.failedBatches}   unanswered ${s.unanswered}${s.saturated ? '   SATURATED' : ''}`,
    `client         cpu µs/txn ${s.clientCpuUsPerTxn.toFixed(1)}   event-loop delay p99.9 ${f2(s.clientLoopDelayMaxP999Ms)} ms`,
  ];
  if (s.db) {
    out.push(`db cpu µs/txn ${s.db.cpuUsPerTxn.toFixed(1)}   data statements/vCPU-s ${s.db.dataStatementsPerVcpuS.toFixed(0)}   within ±25% of ${s.db.estimate}: ${s.db.withinEstimate ? 'yes' : 'no'}`);
  }
  for (const w of s.warnings) out.push(`warning        ${w}`);
  return out.join('\n');
}
