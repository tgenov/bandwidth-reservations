/**
 * Substrate bench, spike S-PLAT-SP1 (a) (docs/04-delivery/plan/S-PLAT.md §4; RFC-006 §22.1): a synthetic
 * open-loop load generator for the slot batch transaction of RFC-006 §4.3 on CockroachDB or YugabyteDB.
 * `npm run bench:substrate` runs it. Settings are SUBSTRATE_* environment variables (README.md).
 *
 *   SUBSTRATE_MODE=setup  create the database, the tables (schema.<flavour>.sql), the splits and the seed rows
 *   SUBSTRATE_MODE=run    take the slots, offer Poisson arrivals for SUBSTRATE_DURATION_S, measure after the warm-up
 *   SUBSTRATE_MODE=merge  merge the result files of processes that ran together (SUBSTRATE_INPUTS)
 *
 * A run prints the result as one JSON line on stdout and a text summary on stderr; SUBSTRATE_OUT also writes the
 * JSON to a file.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import pg from 'pg';
import { systemClock } from '../../../platform/runtime/src/clock.ts';
import { monotonicClock } from './src/clock.ts';
import { ConfigError, parseConfig, type SubstrateConfig } from './src/config.ts';
import { SlotLane, type Call } from './src/lane.ts';
import { PgTxnSource, type StatementCount } from './src/pg-txn.ts';
import { runProtocol } from './src/protocol.ts';
import { Recorder, buildResult, formatSummary, mergeResults, summarise, type DbStats, type RunResult } from './src/results.ts';
import { ArrivalSchedule, driveArrivals, poissonGaps, seededRng } from './src/schedule.ts';
import { DIALECTS, presplitStatements, seedStatements, splitSql } from './src/sql.ts';

const HERE = import.meta.dirname;
/** The CockroachDB metrics read before and after the window, summed over every node (prefix match). */
const DB_METRIC_PREFIXES = [
  'sys.cpu.user.ns', 'sys.cpu.sys.ns', 'txn.', 'sql.txn.', 'sql.select.count', 'sql.insert.count', 'sql.update.count',
  'sql.misc.count', 'sql.query.count', 'sql.restart_savepoint', 'kv.closed_timestamp', 'requests.slow', 'txnwaitqueue.',
  'intentresolver.', 'txnrecovery.', 'kv.transaction.',
];

function poolFor(cfg: SubstrateConfig, max: number): pg.Pool {
  // C01 §7: statement timeout 2 s (COMMIT excepted), idle-in-transaction 1 s, in the startup message (as store/pg.ts).
  const pool = new pg.Pool({
    connectionString: cfg.url, max, idleTimeoutMillis: 0,
    options: `-c statement_timeout=${cfg.statementTimeoutMs} -c idle_in_transaction_session_timeout=${cfg.idleInTransactionMs}`,
  });
  pool.on('error', () => { /* an idle client died; the pool replaces it */ });
  return pool;
}

async function setup(cfg: SubstrateConfig): Promise<Record<string, unknown>> {
  const url = new URL(cfg.url);
  const name = url.pathname.replace(/^\//, '');
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`database name must match [a-z_][a-z0-9_]* (got ${name})`);
  url.pathname = cfg.flavour === 'crdb' ? '/defaultdb' : '/yugabyte';
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    const found = await admin.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1', [name]);
    if (found.rowCount === 0) await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const d = DIALECTS[cfg.flavour];
  const client = new pg.Client({ connectionString: cfg.url });
  await client.connect();
  let n = 0;
  try {
    for (const s of splitSql(readFileSync(path.join(HERE, `schema.${cfg.flavour}.sql`), 'utf8'))) { await client.query(s); n += 1; }
    for (const s of presplitStatements(d, cfg.slots)) { await client.query(s); n += 1; }
    for (const s of seedStatements(cfg)) { await client.query(s.text, s.values); n += 1; }
  } finally {
    await client.end();
  }
  return { mode: 'setup', flavour: cfg.flavour, database: name, statements: n, slots: cfg.slots, seededSlots: [cfg.slotFirst, cfg.slotFirst + cfg.slotCount] };
}

async function dbSnapshot(pool: pg.Pool): Promise<{ nodes: number; metrics: Record<string, number> }> {
  const r = await pool.query('SELECT node_id, metrics FROM crdb_internal.kv_node_status');
  const metrics: Record<string, number> = {};
  for (const row of r.rows as Array<{ metrics: Record<string, unknown> | string }>) {
    const m = typeof row.metrics === 'string' ? (JSON.parse(row.metrics) as Record<string, unknown>) : row.metrics;
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === 'number' && DB_METRIC_PREFIXES.some((p) => k.startsWith(p))) metrics[k] = (metrics[k] ?? 0) + v;
    }
  }
  return { nodes: r.rowCount ?? 0, metrics };
}

function dbDelta(processId: string, a: { nodes: number; metrics: Record<string, number> }, b: { nodes: number; metrics: Record<string, number> }): DbStats {
  const metrics: Record<string, number> = {};
  for (const [k, v] of Object.entries(b.metrics)) {
    const dv = v - (a.metrics[k] ?? 0);
    if (dv !== 0) metrics[k] = dv;
  }
  return { processId, cpuNs: (metrics['sys.cpu.user.ns'] ?? 0) + (metrics['sys.cpu.sys.ns'] ?? 0), nodes: b.nodes, metrics };
}

async function run(cfg: SubstrateConfig): Promise<RunResult> {
  const clock = monotonicClock;
  const d = DIALECTS[cfg.flavour];
  const pool = poolFor(cfg, cfg.poolSize);
  const startedAtMs = systemClock();
  const dbVersion = String((await pool.query('SELECT version() AS v')).rows[0]?.['v']);

  // Take the slots: a new epoch for each, as an acquisition does (C01 §3.1). The fence compares with it.
  const session = randomUUID();
  const taken = await pool.query(
    `UPDATE owner_slot SET session_id = $1, epoch = epoch + 1, acquired_at = now()
      WHERE kind = 'account' AND slot >= $2 AND slot < $3 RETURNING slot, epoch, marker_seq`,
    [session, cfg.slotFirst, cfg.slotFirst + cfg.slotCount]);
  if (taken.rowCount !== cfg.slotCount) throw new Error(`took ${taken.rowCount} of ${cfg.slotCount} slots: run SUBSTRATE_MODE=setup first`);
  const epochs = new Map<number, bigint>();
  const markerSeqs = new Map<number, bigint>();
  for (const r of taken.rows as Array<Record<string, unknown>>) {
    epochs.set(Number(r['slot']), BigInt(String(r['epoch'])));
    markerSeqs.set(Number(r['slot']), BigInt(String(r['marker_seq'])));
  }

  const rng = seededRng(cfg.seed * 1_000_003 + cfg.slotFirst);
  const filler = new Uint8Array(Math.max(cfg.logBytes, cfg.outboxBytes, cfg.projectionBytes)).map(() => Math.floor(rng() * 256));
  const t0 = clock.now();
  const windowStart = t0 + cfg.warmupS * 1000;
  const windowEnd = t0 + cfg.durationS * 1000;
  const recorder = new Recorder({ runStartMs: t0, startMs: windowStart, endMs: windowEnd });
  const counts = new Map<Call[], StatementCount>();
  const inFlight = new Set<Call[]>();
  const batchNo = new Map<number, number>();
  let batchSeq = 0n;

  const lanes = new Map<number, SlotLane>();
  for (let slot = cfg.slotFirst; slot < cfg.slotFirst + cfg.slotCount; slot++) {
    lanes.set(slot, new SlotLane({
      slot, clock, maxEntries: cfg.maxBatchEntries, maxBytes: cfg.maxBatchBytes,
      run: async (calls) => {
        const k = (batchNo.get(slot) ?? 0) + 1;
        batchNo.set(slot, k);
        let markerSeq: bigint | null = null;
        if (cfg.markerEvery > 0 && k % cfg.markerEvery === 0) {
          markerSeq = (markerSeqs.get(slot) ?? 0n) + 1n;
          markerSeqs.set(slot, markerSeq);
        }
        batchSeq += 1n;
        const batchId = Buffer.alloc(16);
        batchId.write(session.replaceAll('-', '').slice(0, 16), 0, 'hex');
        batchId.writeBigUInt64BE(batchSeq, 8);
        const src = new PgTxnSource(pool, d, cfg, { slot, epoch: epochs.get(slot) ?? 0n, calls, filler, batchId: new Uint8Array(batchId), markerSeq });
        inFlight.add(calls);
        try {
          return await runProtocol(src, {
            flavour: cfg.flavour, restartMode: d.restartMode, batchRetries: cfg.batchRetries,
            abandonBeforeCommitMs: cfg.abandonBeforeCommitMs, clock,
          });
        } finally {
          counts.set(calls, src.count);
          inFlight.delete(calls);
        }
      },
      onBatch: (done) => {
        recorder.batch(done, counts.get(done.calls) ?? { all: 0, data: 0 });
        counts.delete(done.calls);
      },
    }));
  }

  // The window: client CPU, the generator's event-loop delay and the cluster metrics from its start to its end.
  const loop = monitorEventLoopDelay({ resolution: 10 });
  let cpu0 = process.cpuUsage();
  let cpuUs = 0;
  let db0: Awaited<ReturnType<typeof dbSnapshot>> | null = null;
  let db: DbStats | null = null;
  const windowTask = (async () => {
    await clock.sleepUntil(windowStart);
    cpu0 = process.cpuUsage();
    loop.enable();
    if (cfg.dbMetrics) db0 = await dbSnapshot(pool);
    await clock.sleepUntil(windowEnd);
    const c = process.cpuUsage(cpu0);
    cpuUs = c.user + c.system;
    loop.disable();
    if (cfg.dbMetrics && db0) db = dbDelta(cfg.processId, db0, await dbSnapshot(pool));
  })();

  let requestSeq = BigInt(startedAtMs) * 1_000_000n;
  await driveArrivals({
    schedule: new ArrivalSchedule(t0, poissonGaps(rng, cfg.ratePerS)), clock, endMs: windowEnd,
    onArrival: (intendedMs) => {
      recorder.arrival(intendedMs);
      const slot = cfg.slotFirst + Math.floor(rng() * cfg.slotCount);
      requestSeq += 1n;
      const call: Call = {
        intendedMs, partition: Math.floor(rng() * cfg.partitionsPerSlot), entries: cfg.entriesPerCall,
        bytes: cfg.entriesPerCall * cfg.logBytes + cfg.outboxBytes + cfg.projectionBytes, requestSeq,
      };
      lanes.get(slot)?.enqueue(call);
    },
  });
  await windowTask;
  await Promise.race([Promise.all([...lanes.values()].map((l) => l.idle())), clock.sleepUntil(clock.now() + cfg.drainS * 1000)]);
  for (const l of lanes.values()) recorder.unanswered(l.pending());
  for (const calls of inFlight) recorder.unanswered(calls);

  const delays = { p99: loop.percentile(99) / 1000, p999: loop.percentile(99.9) / 1000, max: loop.max / 1000 };
  return buildResult({
    config: cfg, startedAt: new Date(startedAtMs).toISOString(), dbVersion, data: recorder.data, db,
    client: {
      processId: cfg.processId, cpuUs, rssMB: Math.round(process.memoryUsage().rss / 1048576),
      loopDelayP99Us: Math.round(delays.p99), loopDelayP999Us: Math.round(delays.p999), loopDelayMaxUs: Math.round(Number.isFinite(delays.max) ? delays.max : 0),
    },
  });
}

function emit(cfg: SubstrateConfig, r: RunResult): void {
  const json = JSON.stringify(r);
  if (cfg.out) writeFileSync(cfg.out, `${json}\n`);
  process.stderr.write(`${formatSummary(summarise(r))}\n`);
  process.stdout.write(`${json}\n`);
}

let cfg: SubstrateConfig;
try {
  cfg = parseConfig(process.env, hostname());
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
  throw e;
}
if (cfg.mode === 'setup') {
  process.stdout.write(`${JSON.stringify(await setup(cfg))}\n`);
} else if (cfg.mode === 'merge') {
  emit(cfg, mergeResults(cfg.inputs.map((f) => JSON.parse(readFileSync(f, 'utf8')) as RunResult)));
} else {
  emit(cfg, await run(cfg));
}
process.exit(0);
