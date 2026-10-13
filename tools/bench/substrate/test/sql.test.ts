import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Call } from '../src/lane.ts';
import { planWrites } from '../src/plan.ts';
import { DIALECTS, presplitStatements, readStatements, seedStatements, splitSql, writeStatements } from '../src/sql.ts';

const FILLER = new Uint8Array(512);
const call = (partition: number, requestSeq: number): Call => ({ intendedMs: 0, partition, entries: 1, bytes: 100, requestSeq: BigInt(requestSeq) });
const plan = (calls: Call[], marker: { markerSeq: bigint } | null = null): ReturnType<typeof planWrites> => planWrites({
  slot: 1, slots: 64, epoch: 2n, ts: '10', batchId: new Uint8Array(16), calls, heads: new Map(), filler: FILLER,
  sizes: { logBytes: 200, outboxBytes: 200, projectionBytes: 100 }, marker,
});
const reads = (flavour: 'crdb' | 'yugabyte', timingRead: boolean, n = 1): ReturnType<typeof readStatements> =>
  readStatements(DIALECTS[flavour], { slot: 1, slots: 64, timingRead, calls: Array.from({ length: n }, (_, i) => call(i, i)) });

describe('dialects: the one switch for CockroachDB-only statements', () => {
  it('should open, restart and commit by the CockroachDB client-side retry protocol (RFC-006 §4.3)', () => {
    const d = DIALECTS.crdb;
    assert.deepEqual(d.begin, ['BEGIN', 'SAVEPOINT cockroach_restart']);
    assert.equal(d.restart, 'ROLLBACK TO SAVEPOINT cockroach_restart');
    assert.deepEqual(d.commit(15_000), ["SET LOCAL statement_timeout = '15000ms'", 'RELEASE SAVEPOINT cockroach_restart', 'COMMIT']);
    assert.equal(d.restartMode, 'savepoint');
  });

  it('should open a serialisable transaction without a restart savepoint on YugabyteDB', () => {
    const d = DIALECTS.yugabyte;
    assert.deepEqual(d.begin, ['BEGIN ISOLATION LEVEL SERIALIZABLE']);
    assert.equal(d.restart, null);
    assert.deepEqual(d.commit(15_000), ["SET LOCAL statement_timeout = '15000ms'", 'COMMIT']);
    assert.equal(d.restartMode, 'fresh');
  });

  it('should read ts by cluster_logical_timestamp on CockroachDB only', () => {
    assert.equal(reads('crdb', true).ts.text, 'SELECT cluster_logical_timestamp()::STRING AS ts');
    assert.equal(reads('yugabyte', true).ts.text, 'SELECT ((extract(epoch FROM transaction_timestamp()) * 1000000000)::DECIMAL)::TEXT AS ts');
  });

  it('should write the head row by UPSERT on CockroachDB and by INSERT … ON CONFLICT on YugabyteDB', () => {
    const p = plan([call(0, 1)]);
    const crdb = writeStatements(DIALECTS.crdb, p, 1, 'per-row').find((s) => s.text.includes('account_head'));
    assert.equal(crdb?.text, 'UPSERT INTO account_head (home_key, partition, slot, generation, adopted, seq, ts, epoch, streams, chain, batch_id) VALUES ($1, $2, $3, $4, $5, $6, $7::DECIMAL, $8, $9, $10, $11)');
    const yb = writeStatements(DIALECTS.yugabyte, p, 1, 'per-row').find((s) => s.text.includes('account_head'));
    assert.equal(yb?.text, 'INSERT INTO account_head (home_key, partition, slot, generation, adopted, seq, ts, epoch, streams, chain, batch_id) VALUES ($1, $2, $3, $4, $5, $6, $7::DECIMAL, $8, $9, $10, $11)'
      + ' ON CONFLICT (home_key, partition) DO UPDATE SET slot = EXCLUDED.slot, generation = EXCLUDED.generation, adopted = EXCLUDED.adopted, seq = EXCLUDED.seq, ts = EXCLUDED.ts, epoch = EXCLUDED.epoch, streams = EXCLUDED.streams, chain = EXCLUDED.chain, batch_id = EXCLUDED.batch_id');
  });

  it('should cast byte arrays to the type each database names', () => {
    assert.match(reads('crdb', true).heads.text, /::BYTES\[\]/);
    assert.match(reads('yugabyte', true).heads.text, /::BYTEA\[\]/);
  });

  it('should pre-split by slot on CockroachDB only (RFC-006 §3.6; platform/migrate/src/generate.ts)', () => {
    assert.deepEqual(presplitStatements(DIALECTS.crdb, 4), [
      'ALTER TABLE account_log SPLIT AT VALUES (1), (2), (3)',
      'ALTER TABLE account_outbox SPLIT AT VALUES (1), (2), (3)',
      'ALTER TABLE account_head SPLIT AT VALUES (262144), (524288), (786432)',
      "ALTER TABLE owner_slot SPLIT AT VALUES ('account', 0)",
    ]);
    assert.deepEqual(presplitStatements(DIALECTS.yugabyte, 4), []);
  });
});

describe('setup statements', () => {
  it('should split a schema file at a semicolon that ends a line and drop comment lines', () => {
    assert.deepEqual(splitSql('-- head\nCREATE TABLE a (\n  x INT -- inline; kept\n);\n\nALTER TABLE a CONFIGURE ZONE USING gc.ttlseconds = 1;\n-- end\n'), [
      'CREATE TABLE a (\n  x INT -- inline; kept\n)',
      'ALTER TABLE a CONFIGURE ZONE USING gc.ttlseconds = 1',
    ]);
  });

  for (const flavour of ['crdb', 'yugabyte'] as const) {
    it(`should define in schema.${flavour}.sql every table and column the batch statements write`, () => {
      const stmts = splitSql(readFileSync(path.join(import.meta.dirname, '..', `schema.${flavour}.sql`), 'utf8'));
      const create = (table: string): string => {
        const s = stmts.find((x) => x.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`));
        if (!s) assert.fail(`schema.${flavour}.sql has no table ${table}`);
        return s;
      };
      const w = writeStatements(DIALECTS[flavour], plan([call(0, 1)], { markerSeq: 1n }), 1, 'per-row');
      for (const s of w.filter((x) => x.text.includes(' INTO '))) {
        const m = /INTO (\w+) \(([^)]*)\)/.exec(s.text);
        const table = create(m?.[1] ?? '');
        for (const col of (m?.[2] ?? '').split(', ')) assert.match(table, new RegExp(`\\n  (.*, )?${col} `), `${m?.[1]}.${col}`);
      }
      for (const col of ['epoch', 'stops_version', 'report_through', 'marker_seq', 'session_id', 'acquired_at']) assert.match(create('owner_slot'), new RegExp(`[ (]${col} `));
      for (const col of ['version', 'epsilon_ms', 'delta_x_ms', 'tau_ms', 'second_lane']) assert.match(create('platform_timing'), new RegExp(`[ (]${col} `));
    });
  }

  it('should seed every slot, 64 timing shards and one head per partition of the slot range, 200 heads a statement', () => {
    const s = seedStatements({ slots: 1_024, slotFirst: 8, slotCount: 4, partitionsPerSlot: 64 });
    assert.equal(s.length, 2 + 2);
    assert.deepEqual(s[0]?.values, [1_023]);
    assert.equal(s[2]?.values.length, 200 * 11);
    assert.equal(s[3]?.values.length, 56 * 11);
    assert.ok(s[3]?.text.endsWith('ON CONFLICT (home_key, partition) DO NOTHING'));
  });
});

describe('statement shape of one batch (RFC-006 §4.3, §19.2)', () => {
  it('should read the fence, timing, heads, condition rows and ts in that order (platform/runtime/src/batch/attempt.ts)', () => {
    const r = reads('crdb', true, 2);
    assert.equal(r.fence.text, "SELECT epoch, stops_version, report_through::TEXT AS report_through, marker_seq FROM owner_slot WHERE kind = 'account' AND slot = $1");
    assert.deepEqual(r.fence.values, [1]);
    assert.equal(r.timing?.text, 'SELECT version, epsilon_ms, delta_x_ms, tau_ms FROM platform_timing WHERE shard = $1');
    assert.deepEqual(r.timing?.values, [1]);
    assert.equal(r.heads.values.length, 2);
    assert.equal(r.conditions.text, 'SELECT partition, request_id FROM account_requests WHERE (partition, request_id) IN (($1, $2), ($3, $4))');
    assert.equal(reads('crdb', false).timing, null);
  });

  it('should make 8 data statements for one call without the timing read and 9 with it', () => {
    const w = writeStatements(DIALECTS.crdb, plan([call(0, 1)]), 1, 'per-row');
    assert.equal(w.length, 4);
    const count = (timingRead: boolean): number => {
      const r = reads('crdb', timingRead);
      return [r.fence, r.timing, r.heads, r.conditions, r.ts].filter((s) => s !== null).length + w.length;
    };
    assert.equal(count(false), 8);
    assert.equal(count(true), 9);
  });

  it('should write one statement per log, outbox and head row in per-row mode, as the runtime does (store/pg.ts write)', () => {
    const w = writeStatements(DIALECTS.crdb, plan([call(0, 1), call(1, 2), call(0, 3)]), 1, 'per-row');
    assert.deepEqual(w.map((s) => s.text.split(' ').slice(0, 3).join(' ')), [
      'INSERT INTO account_log', 'INSERT INTO account_log', 'INSERT INTO account_log',
      'INSERT INTO account_outbox', 'INSERT INTO account_outbox', 'INSERT INTO account_outbox',
      'UPSERT INTO account_head', 'UPSERT INTO account_head',
      'UPSERT INTO account_requests',
    ]);
  });

  it('should write one multi-row statement per table in multi-row mode with numbered placeholders', () => {
    const w = writeStatements(DIALECTS.crdb, plan([call(0, 1), call(1, 2)]), 1, 'multi-row');
    assert.equal(w.length, 4);
    const log = w[0];
    assert.ok(log?.text.startsWith('INSERT INTO account_log'));
    assert.equal(log?.values.length, 30);
    assert.ok(log?.text.includes('$30)'));
    assert.ok(!log?.text.includes('$31'));
  });

  it('should add the marker update of owner_slot when the batch carries a marker', () => {
    const w = writeStatements(DIALECTS.crdb, plan([call(0, 1)], { markerSeq: 4n }), 1, 'per-row');
    assert.equal(w.at(-1)?.text, "UPDATE owner_slot SET report_through = $1::DECIMAL, marker_seq = $2 WHERE kind = 'account' AND slot = $3");
    assert.deepEqual(w.at(-1)?.values, ['10', '4', 1]);
    assert.equal(w.filter((s) => s.text.startsWith('INSERT INTO account_outbox')).length, 2);
  });
});
