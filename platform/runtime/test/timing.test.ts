/**
 * Unit tests of placement's timing part (RFC-006 §6.4, §6.5; plan S-PLAT-I2 work item 6): tauFor, the
 * δ_x window, alarms A-T1 … A-T5 and their episodes, the OperationalAlert mapping, the timing probe and the
 * refusals of writeTimingVersion. The database part is in test/integration/timing.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HlcTs } from '../src/api.ts';
import { hlcFromWallMs } from '../src/hlc.ts';
import {
  TIMING, TimingAlarms, TimingProbe, TimingVersionRefused, tauFor, toOperationalAlert, writeTimingVersion,
  type TimingAlert, type TimingVersion,
} from '../src/placement/timing.ts';

/** A wall time at the start of a UTC minute. */
const T0 = 1_700_000_040_000;
const SEC = 1_000;
const MIN = 60_000;

/** A stepped wall clock that starts at T0. */
function clock(): { now: () => number; set: (ms: number) => void } {
  let t = T0;
  return { now: () => t, set: (ms) => { t = T0 + ms; } };
}

const V1: TimingVersion = { epsilonMs: 100, deltaXMs: 320, tauMs: 420, secondLane: {} };
/** A version with room under the cap, so that A-T2 raises τ without A-T3. */
const ROOM: TimingVersion = { epsilonMs: 50, deltaXMs: 300, tauMs: 350, secondLane: {} };

const alarmsOf = (r: { alerts: TimingAlert[] }): string[] => r.alerts.map((a) => a.alarm);

/** Records one sample of `ms` every 10 s from `fromMs` to `toMs` (inclusive), evaluating after each. */
function feed(al: TimingAlarms, c: ReturnType<typeof clock>, v: TimingVersion, ms: number, fromMs: number, toMs: number):
  Array<ReturnType<TimingAlarms['evaluate']>> {
  const out: Array<ReturnType<TimingAlarms['evaluate']>> = [];
  for (let t = fromMs; t <= toMs; t += 10 * SEC) {
    c.set(t);
    al.recordDeltaX(ms);
    out.push(al.evaluate(v));
  }
  return out;
}

// ---------- tauFor ----------

test('should give epsilon plus delta x when it is above the ack budget', () => {
  assert.equal(TIMING.ackBudgetMs, 200);
  assert.equal(tauFor(100, 320), 420);
});

test('should give the ack budget when epsilon plus delta x is below it', () => {
  assert.equal(tauFor(50, 100), 200);
  assert.equal(tauFor(50, 100, 180), 180);
  assert.equal(tauFor(100, 100), 200);
});

// ---------- δ_x window ----------

test('should give the p99.9 of the samples in the window', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  for (let i = 1; i <= 1000; i++) al.recordDeltaX(i);
  assert.deepEqual(al.measuredDeltaX(), { ms: 999, state: 'steady' });
  al.recordDeltaX(5000);
  // 1001 samples: rank ceil(0.999 × 1001) = 1000.
  assert.deepEqual(al.measuredDeltaX(), { ms: 1000, state: 'steady' });
});

test('should give no measurement when the window is empty', () => {
  const al = new TimingAlarms({ wallMs: clock().now });
  assert.equal(al.measuredDeltaX(), undefined);
});

test('should drop a sample from the window when it is 5 minutes old', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  al.recordDeltaX(300);
  c.set(1 * SEC);
  al.recordDeltaX(100);
  c.set(5 * MIN - 1);
  assert.deepEqual(al.measuredDeltaX(), { ms: 300, state: 'steady' });
  c.set(5 * MIN);
  assert.deepEqual(al.measuredDeltaX(), { ms: 100, state: 'steady' });
  c.set(5 * MIN + 1 * SEC);
  assert.equal(al.measuredDeltaX(), undefined);
});

test('should give the maximum over topology states when states differ', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  al.recordDeltaX(100, 'steady');
  al.recordDeltaX(250, 'r1Lost');
  al.recordDeltaX(120, 'r2Lost');
  assert.deepEqual(al.measuredDeltaX(), { ms: 250, state: 'r1Lost' });
});

test('should refuse a delta x sample when it is negative or not finite', () => {
  const al = new TimingAlarms({ wallMs: clock().now });
  assert.throws(() => al.recordDeltaX(-1), RangeError);
  assert.throws(() => al.recordDeltaX(Number.NaN), RangeError);
  assert.equal(al.measuredDeltaX(), undefined);
});

// ---------- A-T1 ----------

test('should not raise A-T1 when the condition holds for 4 min 59 s', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  // ε 100 + 300 = 400 > τ 420 − 30 = 390; δ_x_meas 300 ≤ δ_x_cfg 320, so A-T2 stays quiet.
  const rs = feed(al, c, V1, 300, 0, 4 * MIN + 50 * SEC);
  c.set(5 * MIN - 1 * SEC);
  rs.push(al.evaluate(V1));
  for (const r of rs) { assert.deepEqual(r.alerts, []); assert.equal(r.newVersion, undefined); }
});

test('should raise A-T1 as a warning with no new version when the condition holds for 5 min', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  feed(al, c, V1, 300, 0, 4 * MIN + 50 * SEC);
  c.set(5 * MIN);
  const r = al.evaluate(V1);
  assert.deepEqual(r.alerts, [{ alarm: 'A-T1', severity: 'warning',
    detail: { epsilonMs: 100, deltaXMeasMs: 300, tauMs: 420, marginMs: 30, state: 'steady' } }]);
  assert.equal(r.newVersion, undefined);
});

test('should not raise A-T1 when epsilon plus delta x equals tau minus 30 ms', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  const rs = feed(al, c, V1, 290, 0, 6 * MIN);
  for (const r of rs) assert.deepEqual(r.alerts, []);
});

test('should restart the A-T1 period when the condition dips', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  assert.deepEqual(feed(al, c, V1, 300, 0, 3 * MIN).flatMap(alarmsOf), []);
  // At 8:00 every sample of 0:00 … 3:00 has left the window: the condition is false once.
  c.set(8 * MIN);
  assert.deepEqual(al.evaluate(V1).alerts, []);
  // High again from 8:10; 5 min of it ends at 13:10.
  assert.deepEqual(feed(al, c, V1, 300, 8 * MIN + 10 * SEC, 13 * MIN).flatMap(alarmsOf), []);
  c.set(13 * MIN + 10 * SEC);
  al.recordDeltaX(300);
  assert.deepEqual(alarmsOf(al.evaluate(V1)), ['A-T1']);
});

// ---------- A-T2 ----------

test('should not raise A-T2 when delta x is above the configured value for less than 1 min', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  const rs = feed(al, c, ROOM, 333, 0, 50 * SEC);
  c.set(MIN - 1);
  rs.push(al.evaluate(ROOM));
  for (const r of rs) { assert.deepEqual(r.alerts, []); assert.equal(r.newVersion, undefined); }
});

test('should raise A-T2 and round the new delta x up to 10 ms when meas is 333 for 1 min', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  feed(al, c, ROOM, 333, 0, 50 * SEC);
  c.set(MIN);
  const r = al.evaluate(ROOM);
  assert.deepEqual(r.alerts, [{ alarm: 'A-T2', severity: 'page',
    detail: { deltaXMeasMs: 333, deltaXCfgMs: 300, newDeltaXCfgMs: 360, newTauMs: 410, state: 'steady' } }]);
  assert.deepEqual(r.newVersion, { epsilonMs: 50, deltaXMs: 360, tauMs: 410, secondLane: {} });
});

test('should raise delta x to meas plus 20 ms when that is a multiple of 10 ms', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  feed(al, c, ROOM, 340, 0, MIN);
  const r = al.evaluate(ROOM);
  assert.deepEqual(r.newVersion, { epsilonMs: 50, deltaXMs: 360, tauMs: 410, secondLane: {} });
});

test('should raise delta x to 370 ms when meas is 341 ms', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  feed(al, c, ROOM, 341, 0, MIN);
  assert.deepEqual(al.evaluate(ROOM).newVersion, { epsilonMs: 50, deltaXMs: 370, tauMs: 420, secondLane: {} });
});

test('should never lower tau when A-T2 raises delta x', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  // τ 440 is above ε + the new δ_x (50 + 340 = 390): it stays 440.
  const high: TimingVersion = { epsilonMs: 50, deltaXMs: 300, tauMs: 440, secondLane: { account: { account: true } } };
  feed(al, c, high, 315, 0, MIN);
  const r = al.evaluate(high);
  assert.deepEqual(r.newVersion, { epsilonMs: 50, deltaXMs: 340, tauMs: 440, secondLane: { account: { account: true } } });
});

test('should not raise A-T2 when delta x equals the configured value', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  const rs = feed(al, c, ROOM, 300, 0, 3 * MIN);
  for (const r of rs) { assert.equal(alarmsOf(r).includes('A-T2'), false); assert.equal(r.newVersion, undefined); }
});

test('should give the new version again on the next evaluate when the caller did not apply it', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  feed(al, c, ROOM, 333, 0, MIN);
  c.set(MIN + 10 * SEC);
  const r = al.evaluate(ROOM);
  assert.deepEqual(r.alerts, []);
  assert.deepEqual(r.newVersion, { epsilonMs: 50, deltaXMs: 360, tauMs: 410, secondLane: {} });
});

test('should end the A-T2 episode when the new version is applied', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  feed(al, c, ROOM, 333, 0, MIN);
  const applied: TimingVersion = { epsilonMs: 50, deltaXMs: 360, tauMs: 410, secondLane: {} };
  const rs = feed(al, c, applied, 333, MIN + 10 * SEC, 3 * MIN);
  for (const r of rs) { assert.deepEqual(r.alerts, []); assert.equal(r.newVersion, undefined); }
});

// ---------- A-T3 ----------

test('should raise A-T3 and turn on the deadline lane for account and link when A-T2 would take tau above the cap', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  // δ_x_cfg would be 360, τ = 100 + 360 = 460 > 450.
  feed(al, c, V1, 340, 0, 50 * SEC);
  c.set(MIN);
  const r = al.evaluate(V1);
  assert.deepEqual(r.alerts, [{ alarm: 'A-T3', severity: 'page',
    detail: { deltaXMeasMs: 340, deltaXCfgMs: 320, wouldBeTauMs: 460, tauCapMs: 450, state: 'steady' } }]);
  assert.deepEqual(r.newVersion, { epsilonMs: 100, deltaXMs: 320, tauMs: 420,
    secondLane: { account: { deadline: true }, link: { deadline: true } } });
});

test('should keep other lane settings when A-T3 turns on the deadline lane', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  const v: TimingVersion = { ...V1, secondLane: { account: { account: true }, identity: { deadline: true } } };
  feed(al, c, v, 340, 0, MIN);
  assert.deepEqual(al.evaluate(v).newVersion?.secondLane,
    { account: { account: true, deadline: true }, link: { deadline: true }, identity: { deadline: true } });
});

test('should give no new version when the deadline lane is already on and tau is at the cap', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  const v: TimingVersion = { ...V1, secondLane: { account: { deadline: true }, link: { deadline: true } } };
  const rs = feed(al, c, v, 340, 0, 2 * MIN);
  assert.deepEqual(rs.flatMap(alarmsOf), ['A-T3']);
  for (const r of rs) assert.equal(r.newVersion, undefined);
});

// ---------- A-T4 ----------

test('should raise one A-T4 page per minute with the count of late releases', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  c.set(5 * SEC); al.recordLateRelease('aa01');
  c.set(20 * SEC); al.recordLateRelease('aa02');
  c.set(59 * SEC); al.recordLateRelease('aa03');
  assert.deepEqual(al.evaluate(V1).alerts, []);
  c.set(MIN + 1 * SEC); al.recordLateRelease('bb01');
  const minute0 = new Date(T0 - (T0 % MIN)).toISOString();
  assert.deepEqual(al.evaluate(V1).alerts, [{ alarm: 'A-T4', severity: 'page', detail: { minute: minute0, count: 3 } }]);
  c.set(MIN + 30 * SEC);
  assert.deepEqual(al.evaluate(V1).alerts, []);
  c.set(2 * MIN);
  const minute1 = new Date(T0 - (T0 % MIN) + MIN).toISOString();
  assert.deepEqual(al.evaluate(V1).alerts, [{ alarm: 'A-T4', severity: 'page', detail: { minute: minute1, count: 1 } }]);
  c.set(3 * MIN);
  assert.deepEqual(al.evaluate(V1).alerts, []);
});

test('should not raise A-T4 when there is no late release', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  c.set(10 * MIN);
  assert.deepEqual(al.evaluate(V1).alerts, []);
});

// ---------- A-T5 ----------

test('should raise A-T5 when an offset is at level A', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  al.recordOffsetLevel('A', 'db-n3');
  assert.deepEqual(al.evaluate(V1).alerts, [{ alarm: 'A-T5', severity: 'page', detail: { level: 'A', source: 'db-n3' } }]);
});

test('should raise A-T5 with the worst level when sources are at levels A and D', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  al.recordOffsetLevel('A', 'db-n3');
  al.recordOffsetLevel('D', 'host-7');
  assert.deepEqual(al.evaluate(V1).alerts, [{ alarm: 'A-T5', severity: 'page', detail: { level: 'D', source: 'host-7' } }]);
});

test('should not raise A-T5 when offsets are at level W or normal', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  al.recordOffsetLevel('W', 'db-n3');
  al.recordOffsetLevel('normal', 'host-7');
  assert.deepEqual(al.evaluate(V1).alerts, []);
});

// ---------- episodes ----------

test('should raise an alarm once per episode and again after it clears and returns', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  al.recordOffsetLevel('A', 'db-n3');
  assert.deepEqual(alarmsOf(al.evaluate(V1)), ['A-T5']);
  c.set(1 * SEC);
  assert.deepEqual(alarmsOf(al.evaluate(V1)), []);
  al.recordOffsetLevel('T', 'db-n3');
  c.set(2 * SEC);
  assert.deepEqual(alarmsOf(al.evaluate(V1)), []);
  al.recordOffsetLevel('W', 'db-n3');
  c.set(3 * SEC);
  assert.deepEqual(alarmsOf(al.evaluate(V1)), []);
  al.recordOffsetLevel('A', 'db-n3');
  c.set(4 * SEC);
  assert.deepEqual(alarmsOf(al.evaluate(V1)), ['A-T5']);
});

test('should raise A-T1 once while the condition holds and again after a clear and a new 5 min period', () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  const first = feed(al, c, V1, 300, 0, 7 * MIN);
  assert.deepEqual(first.flatMap(alarmsOf), ['A-T1']);
  const low = feed(al, c, V1, 100, 7 * MIN + 10 * SEC, 12 * MIN + 10 * SEC);
  assert.deepEqual(low.flatMap(alarmsOf), []);
  const again = feed(al, c, V1, 300, 12 * MIN + 20 * SEC, 17 * MIN + 20 * SEC);
  assert.deepEqual(again.flatMap(alarmsOf), ['A-T1']);
});

// ---------- toOperationalAlert ----------

test('should map a timing alert to a raised OperationalAlert', () => {
  const partition = new Uint8Array([1, 2]);
  const raisedAt: HlcTs = hlcFromWallMs(T0);
  const a: TimingAlert = { alarm: 'A-T2', severity: 'page', detail: { deltaXMeasMs: 333 } };
  assert.deepEqual(toOperationalAlert(a, { partition, seq: 7n, raisedAt }), {
    alertId: { partition, alertKind: 'A-T2', subject: new TextEncoder().encode('A-T2'), episode: { partition, seq: 7n } },
    op: 'raised', alertKind: 'A-T2', severity: 'page', entities: [], reasonCode: 'A-T2',
    detail: { deltaXMeasMs: 333 }, raisedAt,
  });
});

// ---------- TimingProbe ----------

test('should record the release minus the expiry in ms when a round trip succeeds', async () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  const probe = new TimingProbe({ alarms: al, roundTrip: async () => ({ expiryTs: hlcFromWallMs(T0), releaseTs: hlcFromWallMs(T0 + 137) }) });
  await probe.runOnce();
  assert.deepEqual(al.measuredDeltaX(), { ms: 137, state: 'steady' });
  assert.equal(probe.failures, 0);
  assert.equal(probe.runs, 1);
});

test('should count a failure and record nothing when a round trip fails', async () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  const probe = new TimingProbe({ alarms: al, roundTrip: async () => { throw new Error('slot moved'); } });
  await probe.runOnce();
  await probe.runOnce();
  assert.equal(probe.failures, 2);
  assert.equal(probe.runs, 2);
  assert.equal(al.measuredDeltaX(), undefined);
});

test('should count a failure and record nothing when the release is before the expiry', async () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  const probe = new TimingProbe({ alarms: al, roundTrip: async () => ({ expiryTs: hlcFromWallMs(T0 + 5), releaseTs: hlcFromWallMs(T0) }) });
  await probe.runOnce();
  assert.equal(probe.failures, 1);
  assert.equal(al.measuredDeltaX(), undefined);
});

test('should record under the topology state of the probe when one is given', async () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  const probe = new TimingProbe({ alarms: al, state: () => 'r1Lost',
    roundTrip: async () => ({ expiryTs: hlcFromWallMs(T0), releaseTs: hlcFromWallMs(T0 + 210) }) });
  await probe.runOnce();
  assert.deepEqual(al.measuredDeltaX(), { ms: 210, state: 'r1Lost' });
});

test('should run the round trip on each tick and cancel the ticks when stop is called', async () => {
  const c = clock();
  const al = new TimingAlarms({ wallMs: c.now });
  const ticks: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const schedule = (fn: () => void, ms: number): { cancel: () => void } => {
    const t = { fn, ms, cancelled: false };
    ticks.push(t);
    return { cancel: () => { t.cancelled = true; } };
  };
  let calls = 0;
  const probe = new TimingProbe({ alarms: al, schedule, roundTrip: async () => {
    calls++;
    return { expiryTs: hlcFromWallMs(T0), releaseTs: hlcFromWallMs(T0 + 10 * calls) };
  } });
  probe.start();
  probe.start();
  assert.equal(ticks.length, 1);
  const tick = ticks[0];
  assert.ok(tick);
  assert.equal(tick.ms, 1000);
  tick.fn(); tick.fn(); tick.fn();
  await probe.idle();
  assert.equal(calls, 3);
  assert.equal(probe.runs, 3);
  assert.deepEqual(al.measuredDeltaX(), { ms: 30, state: 'steady' });
  probe.stop();
  assert.equal(tick.cancelled, true);
  probe.start(250);
  assert.equal(ticks.length, 2);
  assert.equal(ticks[1]?.ms, 250);
  probe.stop();
});

// ---------- writeTimingVersion refusals ----------

/** A pool double whose connect must not be called: a refusal touches no database. */
const NO_DB = { connect: (): Promise<never> => { throw new Error('connect must not be called for a refused version'); } };

async function refused(v: TimingVersion): Promise<string> {
  try { await writeTimingVersion(NO_DB, v); } catch (e) {
    if (e instanceof TimingVersionRefused) return e.code;
    throw e;
  }
  return 'accepted';
}

test('should refuse a timing version when tau is below epsilon plus delta x', async () => {
  assert.equal(await refused({ epsilonMs: 100, deltaXMs: 320, tauMs: 419, secondLane: {} }), 'TAU_BELOW_EPSILON_PLUS_DELTA_X');
});

test('should refuse a timing version when tau is above the cap', async () => {
  assert.equal(await refused({ epsilonMs: 100, deltaXMs: 320, tauMs: 451, secondLane: {} }), 'TAU_ABOVE_CAP');
});

test('should refuse a timing version when tau is below the ack budget', async () => {
  assert.equal(await refused({ epsilonMs: 50, deltaXMs: 100, tauMs: 199, secondLane: {} }), 'TAU_BELOW_ACK_BUDGET');
});

test('should refuse a timing version when a value is not a whole non-negative number of ms', async () => {
  assert.equal(await refused({ epsilonMs: 100.5, deltaXMs: 300, tauMs: 420, secondLane: {} }), 'NOT_WHOLE_MS');
  assert.equal(await refused({ epsilonMs: -1, deltaXMs: 300, tauMs: 420, secondLane: {} }), 'NOT_WHOLE_MS');
});

// ---------- writeTimingVersion transaction (scripted client double) ----------

/** A pool double with one client that answers SELECT and UPDATE from a script and logs every statement. */
function scriptedPool(o: { shards: number; maxVersion: string; updated: number; rollbackFails?: boolean }) {
  const log: Array<{ sql: string; params?: unknown[] }> = [];
  const released: Array<Error | boolean | undefined> = [];
  const client = {
    async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
      log.push(params === undefined ? { sql } : { sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
      if (sql === 'ROLLBACK') { if (o.rollbackFails) throw new Error('connection lost'); return { rows: [], rowCount: 0 }; }
      if (sql.startsWith('SELECT max(version)')) return { rows: [{ v: o.maxVersion, n: String(o.shards) }], rowCount: 1 };
      if (sql.startsWith('UPDATE platform_timing')) return { rows: [], rowCount: o.updated };
      throw new Error(`unexpected statement: ${sql}`);
    },
    release(err?: Error | boolean): void { released.push(err); },
  };
  return { pool: { connect: async () => client }, log, released };
}

const verbs = (log: Array<{ sql: string }>): string[] => log.map((l) => l.sql.split(' ')[0] ?? '');

test('should set every shard to the highest version plus 1 in one transaction', async () => {
  const s = scriptedPool({ shards: 64, maxVersion: '7', updated: 64 });
  const v: TimingVersion = { epsilonMs: 100, deltaXMs: 320, tauMs: 420, secondLane: { account: { deadline: true } } };
  assert.equal(await writeTimingVersion(s.pool, v), 8n);
  assert.deepEqual(verbs(s.log), ['BEGIN', 'SELECT', 'UPDATE', 'COMMIT']);
  assert.deepEqual(s.log[2]?.params, ['8', 100, 320, 420, '{"account":{"deadline":true}}']);
  assert.deepEqual(s.released, [false]);
});

test('should accept a timing version when tau is at the cap', async () => {
  const s = scriptedPool({ shards: 64, maxVersion: '1', updated: 64 });
  assert.equal(await writeTimingVersion(s.pool, { epsilonMs: 100, deltaXMs: 320, tauMs: 450, secondLane: {} }), 2n);
  assert.deepEqual(verbs(s.log), ['BEGIN', 'SELECT', 'UPDATE', 'COMMIT']);
});

test('should refuse and roll back with no update when a shard row is missing', async () => {
  const s = scriptedPool({ shards: 63, maxVersion: '7', updated: 63 });
  await assert.rejects(writeTimingVersion(s.pool, V1), (e: unknown) => e instanceof TimingVersionRefused && e.code === 'SHARDS_MISSING');
  assert.deepEqual(verbs(s.log), ['BEGIN', 'SELECT', 'ROLLBACK']);
  assert.deepEqual(s.released, [false]);
});

test('should refuse and roll back with no commit when the update does not reach 64 shards', async () => {
  const s = scriptedPool({ shards: 64, maxVersion: '7', updated: 63 });
  await assert.rejects(writeTimingVersion(s.pool, V1), (e: unknown) => e instanceof TimingVersionRefused && e.code === 'SHARDS_MISSING');
  assert.deepEqual(verbs(s.log), ['BEGIN', 'SELECT', 'UPDATE', 'ROLLBACK']);
});

test('should discard the client when the rollback fails', async () => {
  const s = scriptedPool({ shards: 63, maxVersion: '7', updated: 63, rollbackFails: true });
  await assert.rejects(writeTimingVersion(s.pool, V1), (e: unknown) => e instanceof TimingVersionRefused && e.code === 'SHARDS_MISSING');
  assert.deepEqual(s.released, [true]);
});
