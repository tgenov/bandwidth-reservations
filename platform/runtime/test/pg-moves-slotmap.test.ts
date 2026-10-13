/**
 * Review 76 TR-10: the SQL shape of `PgStore.pendingMovesFrom`, `PgStore.readReportThrough` (C01 §3.3) and of every
 * `PgSlotMapStore` method (C01 §2.3, §5; RFC-006 §7.1) on scripted pg client doubles. No database.
 */
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import type { SlotMapVersion } from '../src/api.ts';
import { encodeJson } from '../src/bytes.ts';
import { ceilMicrosLiteral, hlc } from '../src/hlc.ts';
import { PgSlotMapStore, SLOT_MAP_EXTRA_TABLES, type SlotMapPgClient, type SlotMapPgPool } from '../src/placement/pg-slot-map-store.ts';
import { SlotMapError, type DoublingState, type ProbeAccountRow, type RequestRow, type SplitAckRow } from '../src/placement/slot-map-service.ts';
import { PgStore } from '../src/store/pg.ts';

type Row = Record<string, unknown>;
type Call = [sql: string, params: unknown[] | undefined];

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const buf = (b: Uint8Array): Buffer => Buffer.from(b);
const sha256 = (b: Uint8Array): Buffer => createHash('sha256').update(b).digest();
const sqlError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const A = new Uint8Array([0x0a, 0x01]);
const B = new Uint8Array([0x0b, 0x02]);
const C = new Uint8Array([0x0c, 0x03]);
const D = new Uint8Array([0x0d, 0x04]);
const T1 = '1800000000000000000.0000000001';
const T2 = '1800000000000000005.0000000000';

/** A pg client and pool double: each data statement takes the next scripted reply; BEGIN, COMMIT, ROLLBACK answer [] unless scripted to fail. */
class Script {
  readonly calls: Call[] = [];
  readonly releases: Array<Error | undefined> = [];
  connects = 0;
  private readonly replies: Array<Row[] | Error>;
  private readonly control: Map<string, Error[]>;

  constructor(replies: Array<Row[] | Error>, control: Record<string, Error[]> = {}) {
    this.replies = [...replies];
    this.control = new Map(Object.entries(control));
  }

  answer(sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push([norm(sql), params]);
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      const e = this.control.get(sql)?.shift();
      return e ? Promise.reject(e) : Promise.resolve({ rows: [], rowCount: 0 });
    }
    const r = this.replies.shift();
    if (r === undefined) return Promise.reject(new Error(`Script double: no reply for ${norm(sql)}`));
    return r instanceof Error ? Promise.reject(r) : Promise.resolve({ rows: r, rowCount: r.length });
  }

  get remaining(): number { return this.replies.length; }

  pool(): SlotMapPgPool & { on(): void } {
    const client: SlotMapPgClient = {
      query: (sql, params) => this.answer(sql, params),
      release: (e) => { this.releases.push(e); },
    };
    return {
      connect: () => { this.connects += 1; return Promise.resolve(client); },
      on: () => { /* no idle errors */ },
    };
  }

  sqls(): string[] { return this.calls.map(([s]) => s); }
}

const slotMap = (s: Script, maxAttempts?: number): PgSlotMapStore =>
  new PgSlotMapStore({ pool: s.pool(), ...(maxAttempts !== undefined ? { maxAttempts } : {}) });
const pgStore = (s: Script): PgStore => new PgStore({ connectionString: 'postgresql://unused', pools: [s.pool() as unknown as pg.Pool] });

const SELECT_VERSIONS = 'SELECT version, slot_count, split_state, overrides_digest, probe_delta, published_at::STRING AS published_at FROM placement_account_slot_map ORDER BY version';
const SELECT_OVERRIDES = 'SELECT account, version, slot, reason FROM placement_slot_override ORDER BY version, account';
const SELECT_PREV = 'SELECT slot_count, split_state, overrides_digest, probe_delta, published_at::STRING AS published_at FROM placement_account_slot_map WHERE version = $1';
const INSERT_VERSION = 'INSERT INTO placement_account_slot_map (version, slot_count, split_state, overrides_digest, probe_delta, published_at) VALUES ($1, $2, $3, $4, $5, $6::DECIMAL)';
const SELECT_LAST = 'SELECT DISTINCT ON (account) account, slot, reason FROM placement_slot_override WHERE version < $1 ORDER BY account, version DESC';
const INSERT_OVERRIDE = 'INSERT INTO placement_slot_override (account, version, slot, reason, operator) VALUES ($1, $2, $3, $4, NULL)';

function version3(): SlotMapVersion {
  return {
    version: 3n, slotCount: 4, previousCount: 2, splitState: { 0: 'split', 1: 'splitting' },
    overrides: [
      { account: A, slot: 0, reason: 'probe_pin' },
      { account: B, slot: 1, reason: 'reslot' },
      { account: C, slot: 3, reason: 'reslot' },
      { account: D, slot: 2, reason: 'reslot' },
    ],
    probeAccounts: [{ slot: 0, account: A }],
    publishedAt: hlc(T2),
  };
}

function storedRow(v: SlotMapVersion): Row {
  return {
    slot_count: v.slotCount,
    split_state: buf(encodeJson({ previousCount: v.previousCount, splitState: v.splitState })),
    overrides_digest: sha256(encodeJson(v.overrides)),
    probe_delta: buf(encodeJson(v.probeAccounts)),
    published_at: v.publishedAt,
  };
}

test('should select the unadopted heads whose last log row this slot wrote when pendingMovesFrom reads the moves out of a slot', async () => {
  const s = new Script([[
    { partition: buf(A), slot: 5, ts: T1 },
    { partition: buf(B), slot: 6, ts: T2 },
  ]]);
  const out = await pgStore(s).pendingMovesFrom('hlink', 2);
  assert.deepEqual(s.calls, [[
    'SELECT h.partition, h.slot, h.ts::STRING AS ts FROM hlink_head AS h JOIN hlink_log AS l ON l.partition = h.partition AND l.seq = h.seq '
      + 'WHERE NOT h.adopted AND h.slot <> $1 AND l.slot = $1',
    [2],
  ]]);
  assert.deepEqual(out, [
    { partition: buf(A), to: 5, ts: hlc(T1) },
    { partition: buf(B), to: 6, ts: hlc(T2) },
  ]);
  assert.deepEqual(s.releases, [undefined]);
});

test('should return no move when pendingMovesFrom finds no row', async () => {
  const s = new Script([[]]);
  assert.deepEqual(await pgStore(s).pendingMovesFrom('hlink', 0), []);
  assert.equal(s.calls.length, 1);
});

test('should read report_through as of a bounded-staleness timestamp at or above minTs when readReportThrough reads a slot', async () => {
  const minTs = hlc('1800000000000000001.0000000000');
  assert.equal(ceilMicrosLiteral(minTs), '2027-01-15 08:00:00.000001+00:00');
  const s = new Script([[{ rt: T2 }]]);
  const out = await pgStore(s).readReportThrough('hlink', 3, minTs);
  assert.deepEqual(s.calls, [[
    "SELECT report_through::STRING AS rt FROM owner_slot AS OF SYSTEM TIME with_min_timestamp('2027-01-15 08:00:00.000001+00:00'::TIMESTAMPTZ) "
      + 'WHERE kind = $1 AND slot = $2',
    ['hlink', 3],
  ]]);
  assert.equal(out, hlc(T2));
});

test('should return null when readReportThrough reads a NULL report_through', async () => {
  const s = new Script([[{ rt: null }]]);
  assert.equal(await pgStore(s).readReportThrough('hlink', 3, hlc(T1)), null);
});

test('should return null when readReportThrough finds no owner_slot row', async () => {
  const s = new Script([[]]);
  assert.equal(await pgStore(s).readReportThrough('hlink', 3, hlc(T1)), null);
});

test('should create the three extra tables in one transaction when ensure runs', async () => {
  const s = new Script([[], [], []]);
  await slotMap(s).ensure();
  assert.deepEqual(s.sqls(), ['BEGIN', ...SLOT_MAP_EXTRA_TABLES.map(norm), 'COMMIT']);
  assert.equal(SLOT_MAP_EXTRA_TABLES.length, 3);
  assert.deepEqual(s.releases, [undefined]);
  assert.equal(s.connects, 1);
});

test('should rebuild the overrides of each version from the newest row at or below it when versions reads the map', async () => {
  const v1Overrides = [{ account: new Uint8Array(A), slot: 0, reason: 'probe_pin' as const }];
  const v2Overrides = [
    { account: new Uint8Array(A), slot: 2, reason: 'reslot' as const },
    { account: new Uint8Array(B), slot: 1, reason: 'dedicated' as const },
  ];
  const s = new Script([
    [
      { version: '1', slot_count: 2, split_state: buf(encodeJson({ splitState: {} })), overrides_digest: sha256(encodeJson(v1Overrides)),
        probe_delta: buf(encodeJson([{ slot: 0, account: A }])), published_at: T1 },
      { version: '2', slot_count: 4, split_state: buf(encodeJson({ previousCount: 2, splitState: { 0: 'splitting' } })),
        overrides_digest: sha256(encodeJson(v2Overrides)), probe_delta: buf(encodeJson([])), published_at: T2 },
    ],
    [
      { account: buf(A), version: '1', slot: 0, reason: 'probe_pin' },
      { account: buf(B), version: '2', slot: 1, reason: 'dedicated' },
      { account: buf(A), version: '2', slot: 2, reason: 'reslot' },
    ],
  ]);
  const out = await slotMap(s).versions();
  assert.deepEqual(s.calls, [['BEGIN', undefined], [SELECT_VERSIONS, undefined], [SELECT_OVERRIDES, undefined], ['COMMIT', undefined]]);
  assert.deepEqual(out, [
    { version: 1n, slotCount: 2, splitState: {}, overrides: v1Overrides, probeAccounts: [{ slot: 0, account: new Uint8Array(A) }], publishedAt: hlc(T1) },
    { version: 2n, slotCount: 4, previousCount: 2, splitState: { 0: 'splitting' }, overrides: v2Overrides, probeAccounts: [], publishedAt: hlc(T2) },
  ]);
  assert.equal('previousCount' in (out[0] as SlotMapVersion), false);
});

test('should refuse with VERSION_CONFLICT and roll back when the override rows of a version do not match its digest', async () => {
  const s = new Script([
    [{ version: '1', slot_count: 2, split_state: buf(encodeJson({ splitState: {} })), overrides_digest: sha256(encodeJson([])),
      probe_delta: buf(encodeJson([])), published_at: T1 }],
    [{ account: buf(A), version: '1', slot: 0, reason: 'probe_pin' }],
  ]);
  await assert.rejects(slotMap(s).versions(), (e: unknown) => e instanceof SlotMapError && e.code === 'VERSION_CONFLICT');
  assert.deepEqual(s.sqls(), ['BEGIN', SELECT_VERSIONS, SELECT_OVERRIDES, 'ROLLBACK']);
  assert.deepEqual(s.releases, [undefined]);
});

test('should throw a TypeError when versions reads an unknown override reason', async () => {
  const s = new Script([
    [{ version: '1', slot_count: 2, split_state: buf(encodeJson({ splitState: {} })), overrides_digest: sha256(encodeJson([])),
      probe_delta: buf(encodeJson([])), published_at: T1 }],
    [{ account: buf(A), version: '1', slot: 0, reason: 'manual' }],
  ]);
  await assert.rejects(slotMap(s).versions(), { name: 'TypeError', message: 'unknown override reason manual' });
  assert.deepEqual(s.sqls(), ['BEGIN', SELECT_VERSIONS, SELECT_OVERRIDES, 'ROLLBACK']);
});

test('should insert the version and only the new or changed overrides when insertVersion writes a new version', async () => {
  const v = version3();
  const s = new Script([
    [],
    [],
    [
      { account: buf(A), slot: 0, reason: 'probe_pin' },
      { account: buf(C), slot: 3, reason: 'dedicated' },
      { account: buf(D), slot: 1, reason: 'reslot' },
    ],
    [], [], [],
  ]);
  await slotMap(s).insertVersion(v);
  assert.deepEqual(s.calls, [
    ['BEGIN', undefined],
    [SELECT_PREV, ['3']],
    [INSERT_VERSION, ['3', 4, buf(encodeJson({ previousCount: 2, splitState: { 0: 'split', 1: 'splitting' } })),
      sha256(encodeJson(v.overrides)), buf(encodeJson([{ slot: 0, account: A }])), hlc(T2)]],
    [SELECT_LAST, ['3']],
    [INSERT_OVERRIDE, [buf(B), '3', 1, 'reslot']],
    [INSERT_OVERRIDE, [buf(C), '3', 3, 'reslot']],
    [INSERT_OVERRIDE, [buf(D), '3', 2, 'reslot']],
    ['COMMIT', undefined],
  ]);
  assert.equal(s.remaining, 0);
});

test('should write nothing when insertVersion finds the version with the same content', async () => {
  const v = version3();
  const s = new Script([[storedRow(v)]]);
  await slotMap(s).insertVersion(v);
  assert.deepEqual(s.calls, [['BEGIN', undefined], [SELECT_PREV, ['3']], ['COMMIT', undefined]]);
});

test('should refuse with VERSION_CONFLICT and write nothing when insertVersion finds the version with other content', async () => {
  const v = version3();
  const others: Array<[string, Row]> = [
    ['slot_count', { slot_count: 8 }],
    ['split_state', { split_state: buf(encodeJson({ previousCount: 2, splitState: { 0: 'split' } })) }],
    ['overrides_digest', { overrides_digest: sha256(encodeJson([])) }],
    ['probe_delta', { probe_delta: buf(encodeJson([])) }],
    ['published_at', { published_at: T1 }],
  ];
  for (const [column, change] of others) {
    const s = new Script([[{ ...storedRow(v), ...change }]]);
    await assert.rejects(slotMap(s).insertVersion(v), (e: unknown) => e instanceof SlotMapError && e.code === 'VERSION_CONFLICT', column);
    assert.deepEqual(s.sqls(), ['BEGIN', SELECT_PREV, 'ROLLBACK'], column);
  }
});

test('should decode each probe account row when probeAccounts reads the table', async () => {
  const s = new Script([[
    { slot: 0, account: buf(A), designated_in: '1', limit_state: 'applied' },
    { slot: 1, account: buf(B), designated_in: '4', limit_state: 'pending' },
  ]]);
  const out = await slotMap(s).probeAccounts();
  assert.deepEqual(s.calls, [
    ['BEGIN', undefined], ['SELECT slot, account, designated_in, limit_state FROM placement_probe_accounts ORDER BY slot', undefined], ['COMMIT', undefined],
  ]);
  assert.deepEqual(out, [
    { slot: 0, account: new Uint8Array(A), designatedIn: 1n, limitState: 'applied' },
    { slot: 1, account: new Uint8Array(B), designatedIn: 4n, limitState: 'pending' },
  ] satisfies ProbeAccountRow[]);
});

test('should throw a TypeError when probeAccounts reads an unknown limit_state', async () => {
  const s = new Script([[{ slot: 0, account: buf(A), designated_in: '1', limit_state: 'frozen' }]]);
  await assert.rejects(slotMap(s).probeAccounts(), { name: 'TypeError', message: 'unknown limit_state frozen' });
});

test('should upsert the probe account with its params in column order when putProbeAccount writes a row', async () => {
  const s = new Script([[]]);
  await slotMap(s).putProbeAccount({ slot: 2, account: C, designatedIn: 5n, limitState: 'pending' });
  assert.deepEqual(s.calls, [
    ['BEGIN', undefined],
    ['UPSERT INTO placement_probe_accounts (slot, account, designated_in, limit_state) VALUES ($1, $2, $3, $4)', [2, buf(C), '5', 'pending']],
    ['COMMIT', undefined],
  ]);
});

const SELECT_ACK = 'SELECT a.epoch, a.acked_at::STRING AS acked_at, p.upper_half FROM placement_split_acks a '
  + 'JOIN placement_split_ack_partitions p ON p.slot = a.slot AND p.map_version = a.map_version WHERE a.slot = $1 AND a.map_version = $2';

test('should return the ack with its upper half when splitAck finds the row', async () => {
  const s = new Script([[{ epoch: '7', acked_at: T1, upper_half: buf(encodeJson([A, B])) }]]);
  const out = await slotMap(s).splitAck(2, 3n);
  assert.deepEqual(s.calls, [['BEGIN', undefined], [SELECT_ACK, [2, '3']], ['COMMIT', undefined]]);
  assert.deepEqual(out, { slot: 2, mapVersion: 3n, epoch: 7n, ackedAt: hlc(T1), upperHalf: [new Uint8Array(A), new Uint8Array(B)] } satisfies SplitAckRow);
});

test('should return undefined when splitAck finds no row', async () => {
  const s = new Script([[]]);
  assert.equal(await slotMap(s).splitAck(2, 3n), undefined);
  assert.deepEqual(s.calls, [['BEGIN', undefined], [SELECT_ACK, [2, '3']], ['COMMIT', undefined]]);
});

test('should upsert the ack and its upper half in one transaction when putSplitAck writes an ack', async () => {
  const s = new Script([[], []]);
  await slotMap(s).putSplitAck({ slot: 2, mapVersion: 3n, epoch: 7n, ackedAt: hlc(T1), upperHalf: [A, B] });
  assert.deepEqual(s.calls, [
    ['BEGIN', undefined],
    ['UPSERT INTO placement_split_acks (slot, map_version, epoch, acked_at) VALUES ($1, $2, $3, $4::DECIMAL)', [2, '3', '7', hlc(T1)]],
    ['UPSERT INTO placement_split_ack_partitions (slot, map_version, epoch, upper_half) VALUES ($1, $2, $3, $4)', [2, '3', '7', buf(encodeJson([A, B]))]],
    ['COMMIT', undefined],
  ]);
});

const SELECT_REQUEST = 'SELECT op, digest, answer FROM placement_slot_map_requests WHERE request_id = $1';

test('should return the recorded request when request finds the row', async () => {
  const id = new Uint8Array([0x52, 0x01]);
  const s = new Script([[{ op: 'double', digest: buf(B), answer: buf(C) }]]);
  const out = await slotMap(s).request(id);
  assert.deepEqual(s.calls, [['BEGIN', undefined], [SELECT_REQUEST, [buf(id)]], ['COMMIT', undefined]]);
  assert.deepEqual(out, { requestId: id, op: 'double', digest: new Uint8Array(B), answer: new Uint8Array(C) } satisfies RequestRow);
});

test('should return undefined when request finds no row', async () => {
  const s = new Script([[]]);
  assert.equal(await slotMap(s).request(new Uint8Array([0x52, 0x02])), undefined);
});

test('should throw a TypeError when request reads an unknown op', async () => {
  const s = new Script([[{ op: 'merge', digest: buf(B), answer: buf(C) }]]);
  await assert.rejects(slotMap(s).request(new Uint8Array([0x52, 0x03])), { name: 'TypeError', message: 'unknown request op merge' });
});

test('should insert the request and keep the first one when putRequest records a request', async () => {
  const id = new Uint8Array([0x52, 0x04]);
  const s = new Script([[]]);
  await slotMap(s).putRequest({ requestId: id, op: 'reslot', digest: B, answer: C });
  assert.deepEqual(s.calls, [
    ['BEGIN', undefined],
    ['INSERT INTO placement_slot_map_requests (request_id, op, digest, answer) VALUES ($1, $2, $3, $4) ON CONFLICT (request_id) DO NOTHING',
      [buf(id), 'reslot', buf(B), buf(C)]],
    ['COMMIT', undefined],
  ]);
});

const DOUBLING: DoublingState = {
  requestId: 'req-1', fromCount: 2, toCount: 4, phase: 'split', overrideVersion: 3n, newProbes: ['0c03'], f9Done: [],
  slots: [{ slot: 0, state: 'splitting', splittingVersion: 4n, moved: ['0a01'], needsListing: false }],
};

test('should decode the doubling state when doubling finds the row', async () => {
  const s = new Script([[{ state: buf(encodeJson(DOUBLING)) }]]);
  const out = await slotMap(s).doubling();
  assert.deepEqual(s.calls, [['BEGIN', undefined], ['SELECT state FROM placement_slot_map_doubling WHERE singleton = 1', undefined], ['COMMIT', undefined]]);
  assert.deepEqual(out, DOUBLING);
});

test('should return undefined when doubling finds no row', async () => {
  const s = new Script([[]]);
  assert.equal(await slotMap(s).doubling(), undefined);
});

test('should upsert the singleton row when putDoubling writes the state', async () => {
  const s = new Script([[]]);
  await slotMap(s).putDoubling(DOUBLING);
  assert.deepEqual(s.calls, [
    ['BEGIN', undefined],
    ['UPSERT INTO placement_slot_map_doubling (singleton, state) VALUES (1, $1)', [buf(encodeJson(DOUBLING))]],
    ['COMMIT', undefined],
  ]);
});

test('should run the transaction again from BEGIN when a statement fails with SQLSTATE 40001', async () => {
  const s = new Script([sqlError('40001', 'restart transaction'), [{ state: buf(encodeJson(DOUBLING)) }]]);
  const out = await slotMap(s).doubling();
  assert.deepEqual(out, DOUBLING);
  assert.deepEqual(s.sqls(), ['BEGIN', 'SELECT state FROM placement_slot_map_doubling WHERE singleton = 1', 'ROLLBACK',
    'BEGIN', 'SELECT state FROM placement_slot_map_doubling WHERE singleton = 1', 'COMMIT']);
  assert.equal(s.connects, 1);
  assert.deepEqual(s.releases, [undefined]);
});

test('should run the transaction again from BEGIN when COMMIT fails with SQLSTATE 40001', async () => {
  const s = new Script([[], []], { COMMIT: [sqlError('40001', 'restart transaction')] });
  await slotMap(s).putDoubling(DOUBLING);
  const upsert = 'UPSERT INTO placement_slot_map_doubling (singleton, state) VALUES (1, $1)';
  assert.deepEqual(s.sqls(), ['BEGIN', upsert, 'COMMIT', 'ROLLBACK', 'BEGIN', upsert, 'COMMIT']);
  assert.deepEqual(s.releases, [undefined]);
});

test('should stop after maxAttempts and throw the 40001 error when every attempt fails with SQLSTATE 40001', async () => {
  const e1 = sqlError('40001', 'restart 1');
  const e2 = sqlError('40001', 'restart 2');
  const s = new Script([e1, e2, []]);
  await assert.rejects(slotMap(s, 2).doubling(), (e: unknown) => e === e2);
  assert.deepEqual(s.sqls(), ['BEGIN', 'SELECT state FROM placement_slot_map_doubling WHERE singleton = 1', 'ROLLBACK',
    'BEGIN', 'SELECT state FROM placement_slot_map_doubling WHERE singleton = 1', 'ROLLBACK']);
  assert.equal(s.remaining, 1);
  assert.deepEqual(s.releases, [undefined]);
});

test('should make ten attempts when maxAttempts is not given', async () => {
  const s = new Script(Array.from({ length: 11 }, (_, i) => sqlError('40001', `restart ${i}`)));
  await assert.rejects(slotMap(s).doubling(), { code: '40001', message: 'restart 9' });
  assert.equal(s.sqls().filter((x) => x === 'BEGIN').length, 10);
  assert.equal(s.remaining, 1);
});

test('should roll back and throw at once without a retry when a statement fails with another SQLSTATE', async () => {
  const dup = sqlError('23505', 'duplicate key');
  const s = new Script([dup, []]);
  await assert.rejects(slotMap(s).putRequest({ requestId: A, op: 'reslot', digest: B, answer: C }), (e: unknown) => e === dup);
  assert.deepEqual(s.sqls().filter((x) => x === 'BEGIN' || x === 'COMMIT' || x === 'ROLLBACK'), ['BEGIN', 'ROLLBACK']);
  assert.equal(s.remaining, 1);
  assert.deepEqual(s.releases, [undefined]);
});

test('should discard the client and throw the first error without a retry when ROLLBACK fails', async () => {
  const restart = sqlError('40001', 'restart transaction');
  const lost = sqlError('08006', 'connection lost');
  const s = new Script([restart, []], { ROLLBACK: [lost] });
  await assert.rejects(slotMap(s).doubling(), (e: unknown) => e === restart);
  assert.deepEqual(s.sqls(), ['BEGIN', 'SELECT state FROM placement_slot_map_doubling WHERE singleton = 1', 'ROLLBACK']);
  assert.equal(s.remaining, 1);
  assert.deepEqual(s.releases, [lost]);
});
