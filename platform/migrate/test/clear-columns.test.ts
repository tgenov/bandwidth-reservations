/**
 * C01 CP-13 schema-lint clause: "no clear column outside the declared set" (C01 §2.3, §3.12; RFC-005 §5.4, RK-8:
 * "schema lint at build"). The clear columns of a kind are the C01 §2.3 columns of its generated tables (log,
 * head, outbox, stream index) and each projection's declared `clearColumns`. A sealed column (C13 ciphertext)
 * is BYTES. Any other column is a clear column outside the declared set, and the lint refuses it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OwnerDeclaration } from '@share/owner-runtime';
import { ClearColumnError, assertClearColumns, kindMigration, lintClearColumns, migrateKinds } from '../src/index.ts';

const T = { timeout: 10_000 };

const relayed: OwnerDeclaration = {
  kind: 'canary', slotCount: 8,
  entryKinds: [{ kind: 1, name: 'incremented', schemaVersions: [1], retention: 'ops' }],
  projections: [
    { name: 'request', ddl: 'partition BYTES NOT NULL, request STRING NOT NULL, at TIMESTAMPTZ NOT NULL, record BYTES NOT NULL, PRIMARY KEY (partition, request)',
      clearColumns: ['partition', 'request', 'at'], rowTtl: { column: 'at', after: '24 hours' } },
  ],
  streams: [{ name: 'counter', topic: 'canary.counter.v1', key: 'partition', emitFn: { version: 1 }, closure: 'none', consumers: [] }],
};
const selfOutboxed: OwnerDeclaration = {
  kind: 'ingx', slotCount: 4, selfOutboxed: true,
  entryKinds: [{ kind: 1, name: 'row', schemaVersions: [1], retention: '7y' }],
  projections: [],
  streams: [{ name: 'handoff', topic: 'ingx.handoff.v1', key: 'partition', emitFn: { version: 1 }, closure: 'resolved', consumers: ['attr'] }],
};

const stmts = (d: OwnerDeclaration): string[] => kindMigration(d).statements;
/** The generated statements with one column definition added after `anchor` in the CREATE TABLE of `table`. */
function withColumn(d: OwnerDeclaration, table: string, anchor: string, column: string): string[] {
  let hits = 0;
  const out = stmts(d).map((s) => {
    if (!s.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`)) return s;
    hits++;
    return s.replace(anchor, `${anchor} ${column},`);
  });
  assert.equal(hits, 1, `one CREATE TABLE of ${table}`);
  return out;
}

test('C01 CP-13 no clear column outside the declared set: the generated schema of a relayed and a self-outboxed kind passes the lint', () => {
  assert.deepEqual(lintClearColumns(relayed, stmts(relayed)), []);
  assert.deepEqual(lintClearColumns(selfOutboxed, stmts(selfOutboxed)), []);
  assert.doesNotThrow(() => assertClearColumns(relayed, stmts(relayed)));
});

test('C01 CP-13 no clear column outside the declared set: the lint refuses an undeclared clear column in the log', () => {
  const s = withColumn(relayed, 'canary_log', 'seq INT8 NOT NULL,', 'note STRING NULL');
  assert.deepEqual(lintClearColumns(relayed, s), [{ table: 'canary_log', column: 'note', type: 'STRING', reason: 'UNDECLARED_COLUMN' }]);
});

test('C01 CP-13 no clear column outside the declared set: the lint refuses an undeclared column added to the log by ALTER TABLE', () => {
  const s = [...stmts(relayed), 'ALTER TABLE canary_log ADD COLUMN IF NOT EXISTS tenant_name STRING NULL'];
  assert.deepEqual(lintClearColumns(relayed, s), [{ table: 'canary_log', column: 'tenant_name', type: 'STRING', reason: 'UNDECLARED_COLUMN' }]);
});

test('C01 CP-13 no clear column outside the declared set: the lint refuses a sealed log column (payload) that is not BYTES', () => {
  const s = stmts(relayed).map((x) => (x.startsWith('CREATE TABLE IF NOT EXISTS canary_log (') ? x.replace('payload BYTES NOT NULL', 'payload STRING NOT NULL') : x));
  assert.deepEqual(lintClearColumns(relayed, s), [{ table: 'canary_log', column: 'payload', type: 'STRING', reason: 'SEALED_NOT_BYTES' }]);
});

test('C01 CP-13 no clear column outside the declared set: the lint refuses an undeclared clear column in the head', () => {
  const s = withColumn(relayed, 'canary_head', 'seq INT8 NOT NULL,', 'holder_host STRING NULL');
  assert.deepEqual(lintClearColumns(relayed, s), [{ table: 'canary_head', column: 'holder_host', type: 'STRING', reason: 'UNDECLARED_COLUMN' }]);
});

test('C01 CP-13 no clear column outside the declared set: the lint refuses an undeclared clear column in the outbox', () => {
  const s = withColumn(relayed, 'canary_outbox', 'headers BYTES NOT NULL,', 'subject STRING NULL');
  assert.deepEqual(lintClearColumns(relayed, s), [{ table: 'canary_outbox', column: 'subject', type: 'STRING', reason: 'UNDECLARED_COLUMN' }]);
});

test('C01 CP-13 no clear column outside the declared set: the lint refuses an undeclared clear column in the stream index of a self-outboxed kind', () => {
  const s = withColumn(selfOutboxed, 'ingx_stream_index', 'seq INT8 NOT NULL,', 'source_ip INET NULL');
  assert.deepEqual(lintClearColumns(selfOutboxed, s), [{ table: 'ingx_stream_index', column: 'source_ip', type: 'INET', reason: 'UNDECLARED_COLUMN' }]);
});

test('C01 CP-13 no clear column outside the declared set: the lint refuses a projection column that is neither in clearColumns nor BYTES', () => {
  const d: OwnerDeclaration = { ...relayed, projections: [{ ...relayed.projections[0]!, clearColumns: ['partition', 'at'] }] };
  assert.deepEqual(lintClearColumns(d, stmts(d)), [{ table: 'canary_request', column: 'request', type: 'STRING', reason: 'UNDECLARED_COLUMN' }]);
});

test('C01 CP-13 no clear column outside the declared set: the lint refuses every column of a table the declaration does not produce', () => {
  const s = [...stmts(relayed), 'CREATE TABLE IF NOT EXISTS canary_extra (\n  partition BYTES NOT NULL, label STRING,\n  PRIMARY KEY (partition)\n)'];
  assert.deepEqual(lintClearColumns(relayed, s), [
    { table: 'canary_extra', column: 'partition', type: 'BYTES', reason: 'UNDECLARED_TABLE' },
    { table: 'canary_extra', column: 'label', type: 'STRING', reason: 'UNDECLARED_TABLE' },
  ]);
});

test('C01 CP-13 no clear column outside the declared set: assertClearColumns throws CLEAR_COLUMN_UNDECLARED with the violations', () => {
  const s = withColumn(relayed, 'canary_head', 'seq INT8 NOT NULL,', 'holder_host STRING NULL');
  assert.throws(() => assertClearColumns(relayed, s), (e: unknown) => {
    assert.ok(e instanceof ClearColumnError);
    assert.equal(e.code, 'CLEAR_COLUMN_UNDECLARED');
    assert.deepEqual(e.violations, [{ table: 'canary_head', column: 'holder_host', type: 'STRING', reason: 'UNDECLARED_COLUMN' }]);
    return true;
  });
});

test('C01 CP-13 no clear column outside the declared set: migrateKinds refuses the declaration before it connects to the database', T, async () => {
  const d: OwnerDeclaration = { ...relayed, projections: [{ ...relayed.projections[0]!, clearColumns: ['partition', 'at'] }] };
  // Port 1 on loopback: nothing listens. The lint must refuse before any connection is tried.
  await assert.rejects(migrateKinds('postgresql://root@127.0.0.1:1/defaultdb?sslmode=disable&connect_timeout=1', [d], { presplit: false }),
    (e: unknown) => {
      assert.ok(e instanceof ClearColumnError, String(e));
      assert.equal(e.code, 'CLEAR_COLUMN_UNDECLARED');
      assert.deepEqual(e.violations, [{ table: 'canary_request', column: 'request', type: 'STRING', reason: 'UNDECLARED_COLUMN' }]);
      return true;
    });
});
