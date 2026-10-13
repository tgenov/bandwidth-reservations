import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ConfigError, parseConfig } from '../src/config.ts';

function problemsOf(env: Record<string, string>): string[] {
  try {
    parseConfig(env, 'host-a');
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  assert.fail('expected a ConfigError');
}

describe('config', () => {
  it('should give the design defaults when nothing is set', () => {
    const c = parseConfig({}, 'host-a');
    assert.deepEqual(c, {
      mode: 'run', flavour: 'crdb', url: 'postgresql://root@localhost:26257/substrate_bench?sslmode=disable',
      topology: 'unlabelled', label: 'unlabelled', processId: 'host-a',
      slots: 1024, slotFirst: 0, slotCount: 1024, partitionsPerSlot: 64, ratePerS: 6656,
      durationS: 120, warmupS: 30, drainS: 15,
      entriesPerCall: 1, maxBatchEntries: 2000, maxBatchBytes: 4_194_304,
      logBytes: 200, outboxBytes: 200, projectionBytes: 100,
      stmtMode: 'per-row', timingRead: true, markerEvery: 0,
      batchRetries: 5, abandonBeforeCommitMs: 2000, commitBackstopMs: 15_000, statementTimeoutMs: 2000, idleInTransactionMs: 1000,
      poolSize: 1024, seed: 1, dbMetrics: true, out: null, inputs: [],
    });
  });

  it('should read every setting from the environment', () => {
    const c = parseConfig({
      SUBSTRATE_MODE: 'setup', SUBSTRATE_FLAVOUR: 'yugabyte', SUBSTRATE_URL: 'postgresql://u@db:5433/x',
      SUBSTRATE_TOPOLOGY: '2+2+1 gcp', SUBSTRATE_LABEL: 'M2-steady', SUBSTRATE_PROCESS: 'vm-3',
      SUBSTRATE_SLOTS: '4096', SUBSTRATE_SLOT_FIRST: '1024', SUBSTRATE_SLOT_COUNT: '1024', SUBSTRATE_PARTITIONS_PER_SLOT: '8',
      SUBSTRATE_RATE: '7000.5', SUBSTRATE_DURATION_S: '300', SUBSTRATE_WARMUP_S: '60', SUBSTRATE_DRAIN_S: '5',
      SUBSTRATE_ENTRIES_PER_CALL: '2', SUBSTRATE_MAX_BATCH_ENTRIES: '100', SUBSTRATE_MAX_BATCH_BYTES: '65536',
      SUBSTRATE_LOG_BYTES: '300', SUBSTRATE_OUTBOX_BYTES: '400', SUBSTRATE_PROJECTION_BYTES: '50',
      SUBSTRATE_STMT_MODE: 'multi-row', SUBSTRATE_TIMING_READ: '0', SUBSTRATE_MARKER_EVERY: '10',
      SUBSTRATE_BATCH_RETRIES: '3', SUBSTRATE_ABANDON_MS: '250', SUBSTRATE_COMMIT_BACKSTOP_MS: '9000',
      SUBSTRATE_STATEMENT_TIMEOUT_MS: '1500', SUBSTRATE_IDLE_IN_TXN_MS: '800', SUBSTRATE_POOL_SIZE: '64',
      SUBSTRATE_SEED: '9', SUBSTRATE_DB_METRICS: '0', SUBSTRATE_OUT: 'r.json',
    }, 'host-a');
    assert.deepEqual(c, {
      mode: 'setup', flavour: 'yugabyte', url: 'postgresql://u@db:5433/x',
      topology: '2+2+1 gcp', label: 'M2-steady', processId: 'vm-3',
      slots: 4096, slotFirst: 1024, slotCount: 1024, partitionsPerSlot: 8, ratePerS: 7000.5,
      durationS: 300, warmupS: 60, drainS: 5,
      entriesPerCall: 2, maxBatchEntries: 100, maxBatchBytes: 65_536,
      logBytes: 300, outboxBytes: 400, projectionBytes: 50,
      stmtMode: 'multi-row', timingRead: false, markerEvery: 10,
      batchRetries: 3, abandonBeforeCommitMs: 250, commitBackstopMs: 9000, statementTimeoutMs: 1500, idleInTransactionMs: 800,
      poolSize: 64, seed: 9, dbMetrics: false, out: 'r.json', inputs: [],
    });
  });

  it('should default the slot count, rate and pool to the rest of the slots after the first one', () => {
    const c = parseConfig({ SUBSTRATE_SLOTS: '2048', SUBSTRATE_SLOT_FIRST: '2000' }, 'h');
    assert.equal(c.slotCount, 48);
    assert.equal(c.ratePerS, 312);
    assert.equal(c.poolSize, 48);
  });

  it('should default the YugabyteDB URL and turn off the CockroachDB metrics for YugabyteDB', () => {
    const c = parseConfig({ SUBSTRATE_FLAVOUR: 'yugabyte' }, 'h');
    assert.equal(c.url, 'postgresql://yugabyte@localhost:5433/substrate_bench');
    assert.equal(c.dbMetrics, false);
  });

  it('should refuse CockroachDB metrics on YugabyteDB', () => {
    assert.deepEqual(problemsOf({ SUBSTRATE_FLAVOUR: 'yugabyte', SUBSTRATE_DB_METRICS: '1' }),
      ['SUBSTRATE_DB_METRICS=1 needs SUBSTRATE_FLAVOUR=crdb (it reads crdb_internal.kv_node_status)']);
  });

  it('should list every bad value at once', () => {
    assert.deepEqual(problemsOf({
      SUBSTRATE_MODE: 'go', SUBSTRATE_FLAVOUR: 'postgres', SUBSTRATE_SLOTS: '1000', SUBSTRATE_RATE: '-1',
      SUBSTRATE_STMT_MODE: 'batched', SUBSTRATE_TIMING_READ: 'yes', SUBSTRATE_PARTITIONS_PER_SLOT: '1.5',
    }), [
      'SUBSTRATE_MODE must be one of setup, run, merge (got go)',
      'SUBSTRATE_FLAVOUR must be one of crdb, yugabyte (got postgres)',
      'SUBSTRATE_STMT_MODE must be one of per-row, multi-row (got batched)',
      'SUBSTRATE_TIMING_READ must be 0 or 1 (got yes)',
      'SUBSTRATE_PARTITIONS_PER_SLOT must be a positive integer (got 1.5)',
      'SUBSTRATE_RATE must be a positive number (got -1)',
      'SUBSTRATE_SLOTS must be a power of two from 1 to 1048576 (got 1000)',
    ]);
  });

  it('should refuse a slot range outside the slots', () => {
    assert.deepEqual(problemsOf({ SUBSTRATE_SLOTS: '64', SUBSTRATE_SLOT_FIRST: '60', SUBSTRATE_SLOT_COUNT: '8' }),
      ['SUBSTRATE_SLOT_FIRST + SUBSTRATE_SLOT_COUNT must be at most SUBSTRATE_SLOTS (60 + 8 > 64)']);
  });

  it('should refuse a warm-up that is not shorter than the duration', () => {
    assert.deepEqual(problemsOf({ SUBSTRATE_DURATION_S: '30', SUBSTRATE_WARMUP_S: '30' }),
      ['SUBSTRATE_WARMUP_S must be less than SUBSTRATE_DURATION_S (30 >= 30)']);
  });

  it('should accept a zero warm-up, drain and marker interval', () => {
    const c = parseConfig({ SUBSTRATE_WARMUP_S: '0', SUBSTRATE_DRAIN_S: '0', SUBSTRATE_MARKER_EVERY: '0' }, 'h');
    assert.equal(c.warmupS, 0);
    assert.equal(c.drainS, 0);
  });

  it('should need input files in merge mode and read them as a list', () => {
    assert.deepEqual(problemsOf({ SUBSTRATE_MODE: 'merge' }), ['SUBSTRATE_INPUTS must name at least one result file in merge mode']);
    const c = parseConfig({ SUBSTRATE_MODE: 'merge', SUBSTRATE_INPUTS: 'a.json, b.json' }, 'h');
    assert.deepEqual(c.inputs, ['a.json', 'b.json']);
  });
});
