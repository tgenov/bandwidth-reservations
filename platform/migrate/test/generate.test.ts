import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OwnerDeclaration } from '@share/owner-runtime';
import { homeKey, reverseBits20, slotOfPartition, utf8 } from '@share/owner-runtime';
import { expectedPrivileges, grantMigration, kindMigration, platformMigration, splitSlots } from '../src/index.ts';

const decl: OwnerDeclaration = {
  kind: 'canary', slotCount: 8,
  entryKinds: [{ kind: 1, name: 'incremented', schemaVersions: [1], retention: 'ops' }],
  projections: [
    { name: 'request', ddl: 'partition BYTES NOT NULL, request STRING NOT NULL, at TIMESTAMPTZ NOT NULL, PRIMARY KEY (partition, request)',
      clearColumns: ['partition', 'request', 'at'], rowTtl: { column: 'at', after: '24 hours' } },
  ],
  streams: [{ name: 'counter', topic: 'canary.counter.v1', key: 'partition', emitFn: { version: 1 }, closure: 'none', consumers: [] }],
};

test('should generate the platform tables (owner_session sharded, owner_slot with stops_version/report_through/marker_seq, 64 timing shards) when migrating the platform', () => {
  const sql = platformMigration().statements.join('\n');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS owner_session[\s\S]*shard < 64[\s\S]*PRIMARY KEY \(shard, session_id\)/);
  for (const c of ['stops_version INT8 NOT NULL DEFAULT 0', 'report_through DECIMAL NULL', 'marker_seq INT8 NOT NULL DEFAULT 0']) {
    assert.ok(sql.includes(c), c);
  }
  assert.equal((sql.match(/'\{\}'::JSONB/g) ?? []).length, 64);
  assert.match(sql, /placement_integrity_stops/);
});

test('should generate the kind tables (log with partition index, head with adopted and batch_id, outbox with 26 h TTL and 25 h GC) when migrating a kind', () => {
  const m = kindMigration(decl);
  const sql = m.statements.join('\n');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canary_log[\s\S]*PRIMARY KEY \(slot, partition, seq\)[\s\S]*canary_log_by_partition \(partition, seq\)/);
  assert.match(sql, /canary_head[\s\S]*adopted BOOL NOT NULL DEFAULT true[\s\S]*batch_id BYTES NOT NULL[\s\S]*PRIMARY KEY \(home_key, partition\)/);
  assert.match(sql, /ttl_expire_after = '26 hours', ttl_disable_changefeed_replication = true/);
  assert.match(sql, /gc\.ttlseconds = 90000/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canary_request[\s\S]*ttl_expiration_expression = '\(at \+ INTERVAL ''24 hours''\)'/);
  assert.match(sql, /generate_series\(0, 7\)[\s\S]*ON CONFLICT \(kind, slot\) DO NOTHING/);
  assert.ok(m.statements.every((s) => /IF NOT EXISTS|ON CONFLICT|SPLIT AT|CONFIGURE ZONE/.test(s)), 'idempotent statements only');
});

test('should refuse a slot-led projection key (R47-01) when generating a kind', () => {
  const bad = { ...decl, projections: [{ name: 'x', ddl: 'slot INT4, partition BYTES, PRIMARY KEY (slot, partition)', clearColumns: [] }] };
  assert.throws(() => kindMigration(bad), /begins with slot/);
});

test('should split at every slot below 257 slots and every 64 above, with head splits at reversed slot starts, when generating split points', () => {
  assert.deepEqual(splitSlots(8), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(splitSlots(4096).length, 63);
  // Every partition of slot s has a home_key in [reverse(s), next boundary).
  const starts = [0, ...splitSlots(8)].map(reverseBits20).sort((a, b) => a - b);
  for (let i = 0; i < 200; i++) {
    const p = utf8(`p${i}`);
    const s = slotOfPartition(p, 8);
    const lo = reverseBits20(s);
    const hi = starts.find((x) => x > lo) ?? 1 << 20;
    const k = homeKey(p);
    assert.ok(k >= lo && k < hi, `partition ${i}`);
  }
});

test('should grant (C01 §2.3) owner, read roles, gap-fill view and placement stops function, with RLS only when asked, when generating grants', async () => {
  const { grantMigration, expectedPrivileges } = await import('../src/index.ts');
  const link: OwnerDeclaration = {
    kind: 'link', slotCount: 4, entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: '7y' }],
    projections: [
      { name: 'displacement', ddl: 'link_id STRING, request BYTES, PRIMARY KEY (link_id, request)', clearColumns: [], deletable: true, readableBy: [{ role: 'account', contractRef: 'C02' }] },
      { name: 'cut', ddl: 'partition BYTES, PRIMARY KEY (partition)', clearColumns: [] },
    ],
    streams: [{ name: 'schedule', topic: 'link.schedule.v1', key: 'partition', emitFn: { version: 1 }, closure: 'closedPerLink', consumers: ['account'] }],
  };
  const p = expectedPrivileges([link]);
  assert.deepEqual([...(p.get('link')?.get('link_log') ?? [])].sort(), ['INSERT', 'SELECT']);
  assert.ok(p.get('link')?.get('link_displacement')?.has('DELETE'));
  assert.ok(!p.get('link')?.get('link_cut')?.has('DELETE'), 'DELETE only on deletable projections');
  assert.ok(p.get('account')?.get('link_displacement')?.has('SELECT'), 'the cross-owner read RFC-000 §8 names');
  assert.ok(p.get('closure_emitter')?.get('link_head')?.has('SELECT'));
  assert.ok(p.get('gapfill_account_link')?.get('link_outbox_gapfill_account')?.has('SELECT'));
  assert.ok(!p.get('placement'), 'placement has no table privilege on owner_slot');
  const sql = grantMigration([link]).statements.join('\n');
  assert.match(sql, /CREATE OR REPLACE VIEW link_outbox_gapfill_account[\s\S]*WHERE topic IN \('link.schedule.v1'\)/);
  assert.match(sql, /placement_set_stops_version[\s\S]*SECURITY DEFINER/);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION placement_set_stops_version\(STRING, INT4\) FROM public/);
  assert.doesNotMatch(sql, /ROW LEVEL SECURITY/);
  assert.match(grantMigration([link], { rowLevelSecurity: true }).statements.join('\n'), /CREATE POLICY owner_slot_write_link ON owner_slot FOR ALL TO link USING \(kind = 'link'\)/);
  assert.match(kindMigration(link).statements.join('\n'), /'closure_link', 0/);
});

test('should generate no outbox, a 25 h GC on the log, the stream index and a gap-fill view over the index and the log when the kind is self-outboxed (S-PLAT-I2 item 3)', () => {
  const ingest: OwnerDeclaration = {
    kind: 'ingx', slotCount: 4, selfOutboxed: true,
    entryKinds: [{ kind: 1, name: 'row', schemaVersions: [1], retention: '7y' }],
    projections: [],
    streams: [
      { name: 'handoff', topic: 'ingx.handoff.v1', key: 'partition', emitFn: { version: 1 }, closure: 'resolved', consumers: ['attr'] },
      { name: 'drop_alert', topic: 'ingx.alert.v1', key: 'partition', emitFn: { version: 1 }, closure: 'none', consumers: [] },
    ],
  };
  const sql = kindMigration(ingest).statements.join('\n');
  assert.doesNotMatch(sql, /ingx_outbox/, 'no outbox table, TTL or split');
  assert.match(sql, /ALTER TABLE ingx_log CONFIGURE ZONE USING gc.ttlseconds = 90000/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ingx_stream_index[\s\S]*PRIMARY KEY \(partition, stream, stream_seq\)/);
  const p = expectedPrivileges([ingest]);
  assert.equal(p.get('ingx')?.get('ingx_outbox'), undefined, 'no outbox grant');
  assert.deepEqual([...(p.get('ingx')?.get('ingx_stream_index') ?? [])].sort(), ['INSERT', 'SELECT']);
  assert.ok(p.get('standby_ingx')?.get('ingx_stream_index')?.has('SELECT'));
  assert.equal(p.get('standby_ingx')?.get('ingx_outbox'), undefined);
  assert.ok(p.get('gapfill_attr_ingx')?.get('ingx_log_gapfill_attr')?.has('SELECT'));
  assert.equal(p.get('gapfill_attr_ingx')?.get('ingx_outbox_gapfill_attr'), undefined);
  const g = grantMigration([ingest]).statements.join('\n');
  assert.match(g, /CREATE OR REPLACE VIEW ingx_log_gapfill_attr[\s\S]*FROM ingx_stream_index AS si JOIN ingx_log AS l[\s\S]*WHERE si.stream IN \('handoff'\)/);
  assert.doesNotMatch(g, /ingx_outbox/);
});
