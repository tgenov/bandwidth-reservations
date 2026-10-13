/**
 * S-PLAT-I3 work item 9: placement's integrity stop (C01 §2.6, §3.2, §5, CP-6; RFC-006 §7.1, §14.3). The service
 * runs on the memory store; the PgIntegrityStopStore SQL shape runs on a scripted pg client double.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HlcTs, SlotMapVersion, SlotNo } from '../src/api.ts';
import { hex, utf8 } from '../src/bytes.ts';
import { home, slotOfPartition } from '../src/home.ts';
import { hlc } from '../src/hlc.ts';
import { MemoryStore } from '../src/store/memory.ts';
import {
  FenceSlotMissingError, IntegrityStopError, IntegrityStopService, MemoryIntegrityStopStore, placementSlotLocator,
  type HeadInspector, type IntegrityStopErrorCode, type PartitionMoveRow, type ResumeRequest, type StopRequest,
} from '../src/placement/integrity-stop.ts';
import { PgIntegrityStopStore, type PgPoolLike } from '../src/placement/pg-integrity-stop.ts';
import { steppedClock } from './support.ts';

const T = { timeout: 10_000 };
const KIND = 'hlink';
const N = 4;
const AUDIT = { workload: 'audit' };
const START = 1_800_000_000_000;
/** The commit timestamp of the first transaction of a fresh store on the stepped clock at `START`. */
const TS0 = hlc(`${BigInt(START) * 1_000_000n}.0000000000`);

/** A head inspector double: the head now, and the head as of each timestamp. */
class Heads implements HeadInspector {
  present: Uint8Array | undefined = utf8('head-1');
  readonly at = new Map<string, Uint8Array | undefined>();
  readonly calls: string[] = [];
  async headChainAt(kind: string, partition: Uint8Array, at: HlcTs | 'present'): Promise<Uint8Array | undefined> {
    this.calls.push(`${kind}|${hex(partition)}|${at}`);
    if (at === 'present') return this.present;
    if (!this.at.has(at)) throw new Error(`Heads double: no head set for ${at}`);
    return this.at.get(at);
  }
}

function setup(o: { map?: SlotMapVersion; slotCounts?: Record<string, number> } = {}) {
  const clock = steppedClock(START);
  const store = new MemoryStore({ wallMs: clock.now });
  store.seedSlots(KIND, N);
  store.seedSlots('account', 8);
  const stops = new MemoryIntegrityStopStore(store);
  const heads = new Heads();
  const locator = placementSlotLocator({ slotCounts: o.slotCounts ?? { [KIND]: N, account: 4 }, ...(o.map ? { accountMap: () => o.map } : {}) });
  const svc = new IntegrityStopService({ store: stops, locator, heads });
  const versions = (kind = KIND, n = N): bigint[] => Array.from({ length: n }, (_, s) => store.slotRow(kind, s)?.stopsVersion ?? -1n);
  return { clock, store, stops, heads, svc, versions };
}

const P = utf8('link-7');
const PSLOT = slotOfPartition(P, N);
const REF = utf8('det-1');
const stopReq = (over: Partial<StopRequest> = {}): StopRequest => ({ kind: KIND, partition: P, detectionRef: REF, ...over });
const resumeReq = (over: Partial<ResumeRequest> = {}): ResumeRequest => ({ kind: KIND, partition: P, detectionRef: REF, checkpoint: utf8('cp-1'), ...over });
const bumped = (slots: SlotNo[], n = N): bigint[] => Array.from({ length: n }, (_, s) => (slots.includes(s) ? 1n : 0n));
const move = (fromSlot: SlotNo, toSlot: SlotNo, generation: number, state: PartitionMoveRow['state']): PartitionMoveRow => ({ fromSlot, toSlot, generation, state });

async function codeOf(p: Promise<unknown>): Promise<IntegrityStopErrorCode | 'NO_ERROR'> {
  try { await p; } catch (e) { if (e instanceof IntegrityStopError) return e.code; throw e; }
  return 'NO_ERROR';
}

/** An account whose home sits in the upper half of slot `s` during a doubling from `n` (h mod 2n = s + n). */
function upperHalfAccount(s: number, n: number): Uint8Array {
  for (let i = 0; i < 10_000; i++) {
    const a = utf8(`acct-${i}`);
    if (home(a) % (2 * n) === s + n) return a;
  }
  throw new Error('no upper-half account in 10 000 tries');
}
function splittingMap(s: number, n: number): SlotMapVersion {
  return { version: 2n, slotCount: 2 * n, previousCount: n, splitState: { [s]: 'splitting' }, overrides: [], probeAccounts: [], publishedAt: hlc('1') };
}

// ---------------- Stop ----------------

test('C01 CP-6 StopAck only after the fence transaction commits: a failed commit gives no ack and no stop row', T, async () => {
  const { stops, store, svc, versions } = setup();
  stops.failNextCommit = true;
  await assert.rejects(svc.stop(AUDIT, stopReq()), (e: unknown) => e instanceof Error && !(e instanceof IntegrityStopError));
  assert.equal(store.stops.size, 0);
  assert.equal(stops.rows.size, 0);
  assert.deepEqual(versions(), [0n, 0n, 0n, 0n]);
  assert.equal(stops.commits, 0);
});

test('C01 CP-6 a Stop increments stops_version of the one holding slot and records the open stop', T, async () => {
  const { store, stops, svc, versions } = setup();
  const ack = await svc.stop(AUDIT, stopReq());
  assert.deepEqual(ack, { state: 'STOPPED', enforcedAt: TS0, fencedSlots: [PSLOT] });
  assert.deepEqual(versions(), bumped([PSLOT]));
  assert.deepEqual(store.stops.get(`${KIND}|${hex(P)}`), REF);
  assert.equal(stops.commits, 1);
  const row = [...stops.rows.values()][0];
  assert.deepEqual(row, {
    kind: KIND, partition: P, detectionRef: REF, state: 'stopped', at: TS0, checkpoint: null, fencedSlots: [PSLOT],
    resumedAt: null, resumeFencedSlots: null, incidentDecisionRef: null,
  });
});

test('C01 CP-6 enforced_at is the commit timestamp of the Stop transaction', T, async () => {
  const { clock, svc, stops } = setup();
  clock.step(5);
  const ack = await svc.stop(AUDIT, stopReq());
  const expected = hlc(`${BigInt(START + 5) * 1_000_000n}.0000000000`);
  assert.equal(ack.enforcedAt, expected);
  assert.equal([...stops.rows.values()][0]?.at, expected);
});

test('C01 CP-6 a Stop during a move fences both slots while the move row is not done', T, async () => {
  for (const state of ['prewarm', 'moved', 'adopted'] as const) {
    const { stops, svc, versions } = setup();
    stops.moves.set(`${KIND}|${hex(P)}`, [move(1, 3, 2, state)]);
    const ack = await svc.stop(AUDIT, stopReq());
    assert.deepEqual(ack.fencedSlots, [1, 3], state);
    assert.deepEqual(versions(), [0n, 1n, 0n, 1n], state);
  }
});

test('C01 CP-6 a Stop fences only the to slot when the latest move of the partition is done', T, async () => {
  const { stops, svc, versions } = setup();
  stops.moves.set(`${KIND}|${hex(P)}`, [move(0, 1, 1, 'done'), move(1, 2, 3, 'done'), move(2, 3, 2, 'done')]);
  const ack = await svc.stop(AUDIT, stopReq());
  assert.deepEqual(ack.fencedSlots, [2]);
  assert.deepEqual(versions(), [0n, 0n, 1n, 0n]);
});

test('C01 CP-6 an account of a splitting slot with headDecides is fenced in both s and s + n', T, async () => {
  const s = 1;
  const acct = upperHalfAccount(s, 4);
  const { svc, versions } = setup({ map: splittingMap(s, 4) });
  const ack = await svc.stop(AUDIT, stopReq({ kind: 'account', partition: acct }));
  assert.deepEqual(ack.fencedSlots, [s, s + 4]);
  assert.deepEqual(versions('account', 8), bumped([s, s + 4], 8));
});

test('should fence only s when an account of a splitting slot is in the lower half', T, async () => {
  const s = 1;
  let acct: Uint8Array | undefined;
  for (let i = 0; acct === undefined; i++) { const a = utf8(`acct-${i}`); if (home(a) % 8 === s) acct = a; }
  const { svc, versions } = setup({ map: splittingMap(s, 4) });
  const ack = await svc.stop(AUDIT, stopReq({ kind: 'account', partition: acct }));
  assert.deepEqual(ack.fencedSlots, [s]);
  assert.deepEqual(versions('account', 8), bumped([s], 8));
});

test('should use the slot count of the kind when the account map has no version yet', T, async () => {
  const acct = utf8('acct-x');
  const { svc } = setup({ slotCounts: { [KIND]: N, account: 4 } });
  const ack = await svc.stop(AUDIT, stopReq({ kind: 'account', partition: acct }));
  assert.deepEqual(ack.fencedSlots, [slotOfPartition(acct, 4)]);
});

test('should throw a RangeError and write nothing when the kind has no slot count', T, async () => {
  const { svc, stops, store } = setup();
  await assert.rejects(svc.stop(AUDIT, stopReq({ kind: 'nokind' })), RangeError);
  assert.equal(stops.rows.size, 0);
  assert.equal(store.stops.size, 0);
});

test('should throw FenceSlotMissingError and write nothing when a fenced slot has no owner_slot row', T, async () => {
  const { svc, stops, store, versions } = setup();
  stops.moves.set(`${KIND}|${hex(P)}`, [move(1, 9, 1, 'moved')]);
  await assert.rejects(svc.stop(AUDIT, stopReq()), (e: unknown) => e instanceof FenceSlotMissingError && e.slot === 9 && e.kind === KIND);
  assert.equal(stops.rows.size, 0);
  assert.equal(store.stops.size, 0);
  assert.deepEqual(versions(), [0n, 0n, 0n, 0n]);
});

test('should give the same StopAck and no second bump when the same Stop comes again', T, async () => {
  const { clock, svc, versions, stops } = setup();
  const first = await svc.stop(AUDIT, stopReq());
  clock.step(1_000);
  stops.moves.set(`${KIND}|${hex(P)}`, [move(0, 3, 1, 'moved')]);
  const again = await svc.stop(AUDIT, stopReq({ detectionRef: utf8('det-1') }));
  assert.deepEqual(again, first);
  assert.deepEqual(versions(), bumped([PSLOT]));
  assert.equal(stops.commits, 1);
});

test('should refuse with CONFLICT and write nothing when the same detection_ref names another partition', T, async () => {
  const { svc, versions, store } = setup();
  await svc.stop(AUDIT, stopReq());
  const other = utf8('link-8');
  assert.equal(await codeOf(svc.stop(AUDIT, stopReq({ partition: other }))), 'CONFLICT');
  assert.equal(await codeOf(svc.stop(AUDIT, stopReq({ kind: 'account' }))), 'CONFLICT');
  assert.deepEqual(versions(), bumped([PSLOT]));
  assert.equal(store.stops.has(`${KIND}|${hex(other)}`), false);
  assert.equal(store.stops.has(`account|${hex(P)}`), false);
});

test('should keep both open stops when two detection refs stop the same partition', T, async () => {
  const { svc, store, stops, versions } = setup();
  await svc.stop(AUDIT, stopReq());
  await svc.stop(AUDIT, stopReq({ detectionRef: utf8('det-2') }));
  assert.equal(stops.rows.size, 2);
  assert.deepEqual(versions(), bumped([PSLOT]).map((v) => v * 2n));
  await svc.resume(AUDIT, resumeReq({ incidentDecisionRef: utf8('inc') }));
  assert.deepEqual(store.stops.get(`${KIND}|${hex(P)}`), utf8('det-2'), 'the other stop stays open');
});

test('should refuse with PERMISSION_DENIED and write nothing when the caller is not the audit workload', T, async () => {
  const { svc, stops, store, versions } = setup();
  assert.equal(await codeOf(svc.stop({ workload: 'rating' }, stopReq())), 'PERMISSION_DENIED');
  assert.equal(await codeOf(svc.stop({ workload: '' }, stopReq())), 'PERMISSION_DENIED');
  assert.equal(stops.rows.size, 0);
  assert.equal(store.stops.size, 0);
  assert.deepEqual(versions(), [0n, 0n, 0n, 0n]);
  await svc.stop(AUDIT, stopReq());
  assert.equal(await codeOf(svc.resume({ workload: 'restore' }, resumeReq({ incidentDecisionRef: utf8('i') }))), 'PERMISSION_DENIED');
  assert.equal([...stops.rows.values()][0]?.state, 'stopped');
  assert.deepEqual(versions(), bumped([PSLOT]));
});

test('should accept the configured audit workload when auditWorkload is set', T, async () => {
  const { store, heads } = setup();
  const svc = new IntegrityStopService({ store: new MemoryIntegrityStopStore(store), locator: placementSlotLocator({ slotCounts: { [KIND]: N } }), heads, auditWorkload: 'audit-eu' });
  assert.equal(await codeOf(svc.stop(AUDIT, stopReq())), 'PERMISSION_DENIED');
  assert.equal((await svc.stop({ workload: 'audit-eu' }, stopReq())).state, 'STOPPED');
});

// ---------------- Resume ----------------

test('C01 CP-6 resume refused with NOT_STOPPED when no stop is open for the detection_ref', T, async () => {
  const { svc, versions, stops } = setup();
  assert.equal(await codeOf(svc.resume(AUDIT, resumeReq({ incidentDecisionRef: utf8('i') }))), 'NOT_STOPPED');
  assert.deepEqual(versions(), [0n, 0n, 0n, 0n]);
  assert.equal(stops.commits, 0);
});

test('C01 CP-6 resume refused on head mismatch without an incident decision; nothing is written', T, async () => {
  const { svc, heads, store, stops, versions } = setup();
  const ack = await svc.stop(AUDIT, stopReq());
  heads.at.set(ack.enforcedAt, utf8('head-0'));
  heads.present = utf8('head-restored-wrong');
  assert.equal(await codeOf(svc.resume(AUDIT, resumeReq())), 'HEAD_MISMATCH');
  assert.deepEqual(heads.calls, [`${KIND}|${hex(P)}|${ack.enforcedAt}`, `${KIND}|${hex(P)}|present`]);
  assert.deepEqual(store.stops.get(`${KIND}|${hex(P)}`), REF);
  assert.equal([...stops.rows.values()][0]?.state, 'stopped');
  assert.deepEqual(versions(), bumped([PSLOT]));
  heads.present = undefined;
  assert.equal(await codeOf(svc.resume(AUDIT, resumeReq())), 'HEAD_MISMATCH', 'a head that is gone is a mismatch');
});

test('C01 CP-6 resume accepted on head mismatch with an incident decision', T, async () => {
  const { svc, heads, store } = setup();
  const ack = await svc.stop(AUDIT, stopReq());
  heads.at.set(ack.enforcedAt, utf8('head-0'));
  heads.present = utf8('head-restored-wrong');
  const r = await svc.resume(AUDIT, resumeReq({ incidentDecisionRef: utf8('inc-1') }));
  assert.equal(r.state, 'RESUMED');
  assert.equal(store.stops.has(`${KIND}|${hex(P)}`), false);
});

test('C01 CP-6 a Resume with the first-seen head clears the stop and increments stops_version again', T, async () => {
  const { clock, svc, heads, store, stops, versions } = setup();
  const ack = await svc.stop(AUDIT, stopReq());
  heads.at.set(ack.enforcedAt, utf8('head-1'));
  clock.step(7);
  const r = await svc.resume(AUDIT, resumeReq());
  const at = hlc(`${BigInt(START + 7) * 1_000_000n}.0000000000`);
  assert.deepEqual(r, { state: 'RESUMED', enforcedAt: at, fencedSlots: [PSLOT] });
  assert.equal(store.stops.has(`${KIND}|${hex(P)}`), false);
  assert.deepEqual(versions(), bumped([PSLOT]).map((v) => v * 2n));
  assert.deepEqual([...stops.rows.values()][0], {
    kind: KIND, partition: P, detectionRef: REF, state: 'resumed', at: ack.enforcedAt, checkpoint: utf8('cp-1'), fencedSlots: [PSLOT],
    resumedAt: at, resumeFencedSlots: [PSLOT], incidentDecisionRef: null,
  });
});

test('should fence both slots on Resume when a move of the partition started after the Stop', T, async () => {
  const { svc, heads, stops, versions } = setup();
  const ack = await svc.stop(AUDIT, stopReq());
  heads.at.set(ack.enforcedAt, utf8('head-1'));
  const to = (PSLOT + 1) % N;
  stops.moves.set(`${KIND}|${hex(P)}`, [move(PSLOT, to, 1, 'moved')]);
  const r = await svc.resume(AUDIT, resumeReq());
  assert.deepEqual(r.fencedSlots, [PSLOT, to].sort((a, b) => a - b));
  assert.deepEqual(versions(), Array.from({ length: N }, (_, s) => (s === PSLOT ? 2n : s === to ? 1n : 0n)));
});

test('should give the same StopAck and no second bump when the same Resume comes again', T, async () => {
  const { clock, svc, heads, versions, stops } = setup();
  const ack = await svc.stop(AUDIT, stopReq());
  heads.at.set(ack.enforcedAt, utf8('head-1'));
  const first = await svc.resume(AUDIT, resumeReq());
  clock.step(100);
  heads.present = utf8('changed-later');
  const again = await svc.resume(AUDIT, resumeReq());
  assert.deepEqual(again, first);
  assert.deepEqual(versions(), bumped([PSLOT]).map((v) => v * 2n));
  assert.equal(stops.commits, 2);
});

test('should refuse with CONFLICT when a resumed stop is resumed again with another checkpoint or incident decision', T, async () => {
  const { svc, heads } = setup();
  const ack = await svc.stop(AUDIT, stopReq());
  heads.at.set(ack.enforcedAt, utf8('head-1'));
  await svc.resume(AUDIT, resumeReq());
  assert.equal(await codeOf(svc.resume(AUDIT, resumeReq({ checkpoint: utf8('cp-2') }))), 'CONFLICT');
  assert.equal(await codeOf(svc.resume(AUDIT, resumeReq({ incidentDecisionRef: utf8('inc') }))), 'CONFLICT');
});

test('should refuse a Resume with CONFLICT when the detection_ref names another partition', T, async () => {
  const { svc } = setup();
  await svc.stop(AUDIT, stopReq());
  assert.equal(await codeOf(svc.resume(AUDIT, resumeReq({ partition: utf8('link-8'), incidentDecisionRef: utf8('i') }))), 'CONFLICT');
});

test('should give the original StopAck when a Stop comes again after the Resume', T, async () => {
  const { svc, heads, versions } = setup();
  const ack = await svc.stop(AUDIT, stopReq());
  heads.at.set(ack.enforcedAt, utf8('head-1'));
  await svc.resume(AUDIT, resumeReq());
  assert.deepEqual(await svc.stop(AUDIT, stopReq()), ack);
  assert.deepEqual(versions(), bumped([PSLOT]).map((v) => v * 2n));
});

test('C01 CP-6 a failed Resume commit leaves the stop open and stops_version unchanged', T, async () => {
  const { svc, heads, store, stops, versions } = setup();
  const ack = await svc.stop(AUDIT, stopReq());
  heads.at.set(ack.enforcedAt, utf8('head-1'));
  stops.failNextCommit = true;
  await assert.rejects(svc.resume(AUDIT, resumeReq()));
  assert.deepEqual(store.stops.get(`${KIND}|${hex(P)}`), REF);
  assert.equal([...stops.rows.values()][0]?.state, 'stopped');
  assert.deepEqual(versions(), bumped([PSLOT]));
});

// ---------------- PgIntegrityStopStore: SQL shape ----------------

type Answer = { rows: Array<Record<string, unknown>> };
interface Scripted { pool: PgPoolLike; sql: string[]; params: unknown[][]; releases: Array<Error | undefined>; connects: number }

/** A pg pool double: answers each statement with `answer`; a statement it has no answer for throws. */
function scripted(answer: (sql: string, params: unknown[]) => Answer | Error): Scripted {
  const d: Scripted = { pool: undefined as never, sql: [], params: [], releases: [], connects: 0 };
  const client = {
    async query(sql: string, params: unknown[] = []): Promise<Answer> {
      d.sql.push(sql.replace(/\s+/g, ' ').trim());
      d.params.push(params);
      const a = answer(sql, params);
      if (a instanceof Error) throw a;
      return a;
    },
    release(e?: Error): void { d.releases.push(e); },
  };
  d.pool = { connect: async () => { d.connects += 1; return client; } };
  return d;
}

const CRDB_TS = '1800000000000000000.0000000002';
function cell(o: { stops?: Array<Record<string, unknown>>; moves?: Array<Record<string, unknown>>; failAt?: RegExp; fail?: Error } = {}) {
  return scripted((sql) => {
    if (o.failAt?.test(sql)) return o.fail ?? new Error('statement failed');
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return { rows: [] };
    if (/FROM placement_integrity_stops/.test(sql)) return { rows: o.stops ?? [] };
    if (/FROM placement_partition_moves/.test(sql)) return { rows: o.moves ?? [] };
    if (/cluster_logical_timestamp/.test(sql)) return { rows: [{ ts: CRDB_TS }] };
    if (/INSERT INTO placement_integrity_stops|UPDATE placement_integrity_stops/.test(sql)) return { rows: [] };
    if (/placement_set_stops_version/.test(sql)) return { rows: [{ v: '1' }] };
    return new Error(`scripted pg: no answer for ${sql}`);
  });
}
const pgService = (d: Scripted, heads: HeadInspector = new Heads()): IntegrityStopService =>
  new IntegrityStopService({ store: new PgIntegrityStopStore({ pool: d.pool }), locator: placementSlotLocator({ slotCounts: { [KIND]: N } }), heads });

const SELECT_STOPS = 'SELECT kind, partition, detection_ref, state, at::STRING AS at, checkpoint, fenced_slots, resumed_at::STRING AS resumed_at, resume_fenced_slots, incident_decision_ref FROM placement_integrity_stops WHERE detection_ref = $1';
const SELECT_MOVES = 'SELECT from_slot, to_slot, generation, state FROM placement_partition_moves WHERE kind = $1 AND partition = $2';
const SELECT_TS = 'SELECT cluster_logical_timestamp()::STRING AS ts';
const INSERT_STOP = "INSERT INTO placement_integrity_stops (kind, partition, detection_ref, state, checkpoint, at, fenced_slots) VALUES ($1, $2, $3, 'stopped', NULL, $4::DECIMAL, $5::INT4[])";
const UPDATE_RESUME = "UPDATE placement_integrity_stops SET state = 'resumed', checkpoint = $4, resumed_at = $5::DECIMAL, resume_fenced_slots = $6::INT4[], incident_decision_ref = $7 WHERE kind = $1 AND partition = $2 AND detection_ref = $3";
const BUMP = 'SELECT placement_set_stops_version($1, $2) AS v';

test('C01 CP-6 the pg Stop is one transaction: stop row, the stops function on each fenced slot, then COMMIT', T, async () => {
  const d = cell({ moves: [{ from_slot: 1, to_slot: 3, generation: 2, state: 'moved' }] });
  const ack = await pgService(d).stop(AUDIT, stopReq());
  assert.deepEqual(ack, { state: 'STOPPED', enforcedAt: hlc(CRDB_TS), fencedSlots: [1, 3] });
  assert.deepEqual(d.sql, ['BEGIN', SELECT_STOPS, SELECT_MOVES, SELECT_TS, INSERT_STOP, BUMP, BUMP, 'COMMIT']);
  assert.deepEqual(d.params[4], [KIND, Buffer.from(P), Buffer.from(REF), hlc(CRDB_TS), [1, 3]]);
  assert.deepEqual(d.params[5], [KIND, 1]);
  assert.deepEqual(d.params[6], [KIND, 3]);
  assert.equal(d.connects, 1);
  assert.deepEqual(d.releases, [undefined]);
});

test('C01 CP-6 the pg Stop gives no ack and rolls back when COMMIT fails', T, async () => {
  const d = cell({ failAt: /^COMMIT/, fail: Object.assign(new Error('boom'), { code: 'XX000' }) });
  await assert.rejects(pgService(d).stop(AUDIT, stopReq()), (e: unknown) => (e as { code?: string }).code === 'XX000');
  assert.deepEqual(d.sql, ['BEGIN', SELECT_STOPS, SELECT_MOVES, SELECT_TS, INSERT_STOP, BUMP, 'COMMIT', 'ROLLBACK']);
});

test('should roll back and write nothing more when the stops function fails in the pg Stop', T, async () => {
  const d = cell({ failAt: /placement_set_stops_version/ });
  await assert.rejects(pgService(d).stop(AUDIT, stopReq()));
  assert.deepEqual(d.sql, ['BEGIN', SELECT_STOPS, SELECT_MOVES, SELECT_TS, INSERT_STOP, BUMP, 'ROLLBACK']);
  assert.deepEqual(d.releases, [undefined]);
});

test('should throw FenceSlotMissingError and roll back when the stops function returns no row version', T, async () => {
  const d = scripted((sql) => (/placement_set_stops_version/.test(sql) ? { rows: [{ v: null }] }
    : /cluster_logical/.test(sql) ? { rows: [{ ts: CRDB_TS }] } : { rows: [] }));
  await assert.rejects(pgService(d).stop(AUDIT, stopReq()), (e: unknown) => e instanceof FenceSlotMissingError && e.slot === PSLOT);
  assert.equal(d.sql.at(-1), 'ROLLBACK');
});

test('should run the pg transaction again when a statement fails with SQLSTATE 40001', T, async () => {
  let failed = 0;
  const d = scripted((sql) => {
    if (/INSERT INTO placement_integrity_stops/.test(sql) && failed === 0) { failed += 1; return Object.assign(new Error('restart'), { code: '40001' }); }
    return /cluster_logical/.test(sql) ? { rows: [{ ts: CRDB_TS }] } : /stops_version/.test(sql) ? { rows: [{ v: '1' }] } : { rows: [] };
  });
  const ack = await pgService(d).stop(AUDIT, stopReq());
  assert.equal(ack.enforcedAt, hlc(CRDB_TS));
  assert.deepEqual(d.sql, ['BEGIN', SELECT_STOPS, SELECT_MOVES, SELECT_TS, INSERT_STOP, 'ROLLBACK',
    'BEGIN', SELECT_STOPS, SELECT_MOVES, SELECT_TS, INSERT_STOP, BUMP, 'COMMIT']);
});

test('should give the stored StopAck with no write when the pg row of the detection_ref exists', T, async () => {
  const d = cell({ stops: [{ kind: KIND, partition: Buffer.from(P), detection_ref: Buffer.from(REF), state: 'stopped', at: CRDB_TS, checkpoint: null,
    fenced_slots: [2, 0], resumed_at: null, resume_fenced_slots: null, incident_decision_ref: null }] });
  const ack = await pgService(d).stop(AUDIT, stopReq());
  assert.deepEqual(ack, { state: 'STOPPED', enforcedAt: hlc(CRDB_TS), fencedSlots: [2, 0] });
  assert.deepEqual(d.sql, ['BEGIN', SELECT_STOPS, 'COMMIT']);
});

test('should roll back with CONFLICT when the pg row of the detection_ref names another partition', T, async () => {
  const d = cell({ stops: [{ kind: KIND, partition: Buffer.from('other'), detection_ref: Buffer.from(REF), state: 'stopped', at: CRDB_TS,
    checkpoint: null, fenced_slots: ['1'], resumed_at: null, resume_fenced_slots: null, incident_decision_ref: null }] });
  assert.equal(await codeOf(pgService(d).stop(AUDIT, stopReq())), 'CONFLICT');
  assert.deepEqual(d.sql, ['BEGIN', SELECT_STOPS, 'ROLLBACK']);
});

test('C01 CP-6 the pg Resume is one transaction: the row update, the stops function, then COMMIT', T, async () => {
  const heads = new Heads();
  heads.at.set(hlc(CRDB_TS), utf8('head-1'));
  const d = cell({ stops: [{ kind: KIND, partition: Buffer.from(P), detection_ref: Buffer.from(REF), state: 'stopped', at: CRDB_TS, checkpoint: null,
    fenced_slots: [PSLOT], resumed_at: null, resume_fenced_slots: null, incident_decision_ref: null }] });
  const r = await pgService(d, heads).resume(AUDIT, resumeReq({ incidentDecisionRef: utf8('inc') }));
  assert.deepEqual(r, { state: 'RESUMED', enforcedAt: hlc(CRDB_TS), fencedSlots: [PSLOT] });
  assert.deepEqual(d.sql, ['BEGIN', SELECT_STOPS, SELECT_MOVES, SELECT_TS, UPDATE_RESUME, BUMP, 'COMMIT']);
  assert.deepEqual(d.params[4], [KIND, Buffer.from(P), Buffer.from(REF), Buffer.from('cp-1'), hlc(CRDB_TS), [PSLOT], Buffer.from('inc')]);
});

test('should roll back with HEAD_MISMATCH and no update when the pg Resume finds another head', T, async () => {
  const heads = new Heads();
  heads.at.set(hlc(CRDB_TS), utf8('head-0'));
  const d = cell({ stops: [{ kind: KIND, partition: Buffer.from(P), detection_ref: Buffer.from(REF), state: 'stopped', at: CRDB_TS, checkpoint: null,
    fenced_slots: [PSLOT], resumed_at: null, resume_fenced_slots: null, incident_decision_ref: null }] });
  assert.equal(await codeOf(pgService(d, heads).resume(AUDIT, resumeReq())), 'HEAD_MISMATCH');
  assert.deepEqual(d.sql, ['BEGIN', SELECT_STOPS, 'ROLLBACK']);
});
