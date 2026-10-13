/**
 * S-PLAT-I2 work items 5 and 6 in the runtime: `tsBefore` bounds come from the `platform_timing` version read
 * in the batch (DT-10 at the unit level), placement's timing loop raises alarms and writes versions, and
 * `putCheckpoint` / `getCheckpoint` go to the region's checkpoint store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OperationalAlert, OwnerDeclaration, OwnerHooks, TimingVersion } from '../src/index.ts';
import {
  CheckpointError, CheckpointStore, CockroachOwnerRuntime, DevSealer, ManualLoad, MemoryObjectStore, TimingAlarms, TimingController,
  busAlertSink, decodeJson, hlcAddMs, hlcFromWallMs, utf8,
} from '../src/index.ts';
import { MemoryBus, MemoryStore } from '../testing/index.ts';

const DECL: OwnerDeclaration = { kind: 'acct', slotCount: 4, entryKinds: [{ kind: 1, name: 'confirm', schemaVersions: [1], retention: '7y' }], projections: [], streams: [] };
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const FAST = { sessionTtlMs: 300, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 280, maxLoopDelayMs: 20 };
const hooks = (): OwnerHooks => ({ async onAcquire() {}, onRelease() {}, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {} });

test('DT-10 raising δ_x_cfg writes a new platform_timing version; a confirm whose ts is at or after D − τ under the new version is refused', async () => {
  const W = 1_800_000_000_000;
  const store = new MemoryStore({ wallMs: () => W });            // every batch ts is at W (logical ticks only)
  store.seedSlots(DECL.kind, 4);
  const rt = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], load: new ManualLoad(), testing: { sessionTimings: FAST } });
  await rt.start(hooks());
  const D = hlcFromWallMs(W + 430);                               // the request's deadline
  const confirm = (id: string) => rt.append({
    partition: utf8('acct-1'),
    conditions: [{ kind: 'tsBefore', bound: (t) => hlcAddMs(D, -t.tauMs), label: 'ts < D − τ' }],
    entries: [{ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id } }],
  });
  // Version 1: δ_x_cfg 320, τ 420: D − τ = W + 10 ms, the batch ts is W ⇒ confirmed.
  assert.equal((await confirm('c1')).r, 'Committed');
  // Placement raises δ_x_cfg to 350 (A-T2): τ = 100 + 350 = 450, D − τ = W − 20 ms ⇒ the same confirm is refused.
  store.timing = { version: 2n, epsilonMs: 100, deltaXMs: 350, tauMs: 450 };
  assert.deepEqual(await confirm('c2'), { r: 'ConditionFailed', which: 'ts < D − τ' });
  assert.equal(store.log.length, 1, 'the refused confirm wrote nothing');
  assert.equal(rt.timing().version, 2n, 'the runtime saw the version read in the batch');
  await rt.stop();
});

test('should raise each alarm episode on the alert stream and write the fast-attack version when δ_x_meas stays above δ_x_cfg for 1 min', async () => {
  let now = 1_800_000_000_000;
  const alarms = new TimingAlarms({ wallMs: () => now });
  let current: TimingVersion = { epsilonMs: 100, deltaXMs: 320, tauMs: 420, secondLane: {} };
  const versions: TimingVersion[] = [];
  const bus = new MemoryBus();
  await bus.ensureTopic('placement.alert.v1', 1);
  const raised: OperationalAlert[] = [];
  const sink = busAlertSink(bus);
  const c = new TimingController({
    alarms, wallMs: () => now, current: async () => current,
    write: async (v) => { versions.push(v); current = v; return BigInt(versions.length + 1); },
    raise: async (a) => { raised.push(a); await sink(a); },
  });
  for (let s = 0; s <= 60; s += 5) {
    for (let i = 0; i < 100; i++) alarms.recordDeltaX(325);
    await c.evaluateOnce();
    now += 5_000;
  }
  // δ_x_meas 325 > 320 for 1 min: δ_x_cfg = ceil10(325 + 20) = 350, τ = 100 + 350 = 450 (at the cap, not above).
  assert.deepEqual(versions, [{ epsilonMs: 100, deltaXMs: 350, tauMs: 450, secondLane: {} }]);
  const kinds = raised.map((a) => a.alertKind);
  assert.equal(kinds.filter((k) => k === 'A-T2').length, 1, 'one episode of the page');
  assert.equal(kinds.filter((k) => k === 'A-T3').length, 0);
  const recs = bus.records('placement.alert.v1');
  assert.equal(recs.length, raised.length);
  const first = decodeJson(recs[0]?.value as Uint8Array) as OperationalAlert;
  assert.equal(first.op, 'raised');
  assert.equal(first.alertId.episode.seq, 1n);
  assert.deepEqual(c.written, [2n]);
});

test('should seal and write a checkpoint to the region\'s store and read it back verified when the runtime has a checkpoint store', async () => {
  const store = new MemoryStore();
  store.seedSlots(DECL.kind, 4);
  const objects = new MemoryObjectStore();
  const checkpoints = new CheckpointStore({ region: 'r1', objects, sealer: new DevSealer() });
  const rt = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0], load: new ManualLoad(), checkpoints, testing: { sessionTimings: FAST } });
  await rt.start(hooks());
  const state = utf8('hot link state at seq 40');
  const { reference, digest } = await rt.putCheckpoint('acct', utf8('L1'), 40n, state);
  assert.match(reference, /^ckpt:r1:acct:/);
  assert.equal(digest.byteLength, 32);
  assert.deepEqual(await rt.getCheckpoint(reference), state);
  await assert.rejects(rt.putCheckpoint('acct', utf8('L1'), 40n, utf8('other bytes')), (e: unknown) => e instanceof CheckpointError && e.code === 'DIGEST_MISMATCH');
  const none = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [], load: new ManualLoad() });
  await assert.rejects(none.getCheckpoint(reference), /needs OwnerRuntimeOptions.checkpoints/);
  await rt.stop();
});
