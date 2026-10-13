/**
 * Exit criterion 1 of S-LINK I1 (T-01 part, T-02, T-03, P1-N1): 8 seeds × 2,000 commands from 50 concurrent
 * stub clients through the runtime double. A second run uses the real C01 runtime core
 * (CockroachOwnerRuntime) on its in-memory store. The dev-cell run is in test/integration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CockroachOwnerRuntime, hlcToWallMs, ManualLoad, MemoryPublisher, utf8 } from '@share/owner-runtime';
import { MemoryStore } from '@share/owner-runtime/testing';
import { declaration, DEFAULT_POLICY, LinkOwner, runtimeLogReader, type DecidedRecord } from '../src/index.ts';
import { propertyRun } from './property.ts';
import { AccountStub, harness, M } from './support.ts';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

test('should keep the P1-N1 properties when 50 clients send 8 seeds × 2,000 hold/convert/release commands on the runtime double', async () => {
  const total: Record<string, number> = {};
  for (const seed of SEEDS) {
    const h = await harness({ link: `prop-${seed}`, capacity: 10 });
    const res = await propertyRun({
      stub: h.stub, decided: h.decided, capacity: 10, base: M(0),
      readLog: async () => h.rt.log(utf8(h.link)).map((e) => ({ seq: e.seq, ts: e.ts, epoch: e.epoch, kind: e.entry.kind, payload: e.entry.payload })),
      advance: (ms) => h.rt.advance(ms),
    }, seed, 2_000, 50);
    for (const [k, v] of Object.entries(res.counts)) total[k] = (total[k] ?? 0) + v;
    assert.ok(h.rt.appends.length < 2_000, `seed ${seed}: commands share batches (${h.rt.appends.length} appends)`);
  }
  // The run covers every I1 outcome.
  for (const k of ['HELD', 'CONVERTED', 'RELEASED', 'REFUSED:"NO_FIT"', 'REFUSED:"IN_FLIGHT"', 'REFUSED:"DEADLINE_PASSED"',
    'REFUSED:"TOMBSTONED"', 'MISMATCH', 'NO_HOLD', 'TOMBSTONED']) {
    assert.ok((total[k] ?? 0) > 0, `outcome ${k} occurs (${JSON.stringify(total)})`);
  }
  // S-LINK I4 exit criterion 4: invalid requests are mixed in; each rule and an unapplied policy version occur.
  for (const k of ['V1', 'V2', 'V3', 'V4', 'V5', 'V6'].map((v) => `REFUSED:{"invalid":"${v}"}`).concat('UNAVAILABLE')) {
    assert.ok((total[k] ?? 0) > 0, `outcome ${k} occurs (${JSON.stringify(total)})`);
  }
});

test('T-04 counter-offers equal the oracle with the step bound and the batch budget when 50 clients send 4 seeds × 1,500 commands', async () => {
  const policy = { ...DEFAULT_POLICY, counterofferSteps: 2, counterofferBatchSteps: 5 };
  const total: Record<string, number> = {};
  let recalled = 0;
  for (const seed of [31, 32, 33, 34]) {
    const h = await harness({ link: `tight-${seed}`, capacity: 10, policy });
    const res = await propertyRun({
      stub: h.stub, decided: h.decided, capacity: 10, base: M(0), policy,
      readLog: async () => h.rt.log(utf8(h.link)).map((e) => ({ seq: e.seq, ts: e.ts, epoch: e.epoch, kind: e.entry.kind, payload: e.entry.payload })),
      advance: (ms) => h.rt.advance(ms),
    }, seed, 1_500, 50);
    for (const [k, v] of Object.entries(res.counts)) total[k] = (total[k] ?? 0) + v;
    for (const d of h.decided) {
      const offer = (d.outcome as { counterOffer?: { earliest: object } }).counterOffer;
      if (offer) for (const k of Object.keys(offer.earliest)) total[`earliest:${k}`] = (total[`earliest:${k}`] ?? 0) + 1;
    }
    recalled += h.owner.recalledRecords;
  }
  for (const k of ['earliest:window', 'earliest:none', 'earliest:notFoundBefore']) assert.ok((total[k] ?? 0) > 0, `${k} occurs (${JSON.stringify(total)})`);
  assert.ok(recalled > 0, 'some repeats are answered from link_request');
});

test('should keep the P1-N1 properties when 50 clients send 2 seeds × 1,000 commands on the real C01 runtime core (in-memory store)', async () => {
  const store = new MemoryStore();
  store.seedSlots('link', declaration.slotCount);
  const rt = new CockroachOwnerRuntime({ declaration, store, publisher: new MemoryPublisher(), load: new ManualLoad(),
    slots: Array.from({ length: declaration.slotCount }, (_, i) => i) });
  const decided: DecidedRecord[] = [];
  // The runtime's own readLog: opened payloads, sender-fence envelope unwrapped (S-PLAT I1b).
  const readLog = runtimeLogReader(rt);
  const owner = new LinkOwner(rt, { readLog, onDecided: (d) => decided.push(d) });
  await rt.start(owner);
  try {
    for (const seed of [11, 12]) {
      const link = `core-${seed}`;
      decided.length = 0;
      await owner.register(link, 10);
      const stub = new AccountStub(rt, owner, link);
      // The runtime core has a real clock: the windows start at its present minute, so that they are valid (V4).
      const base = Math.floor(hlcToWallMs(rt.now().ts) / 60_000);
      await propertyRun({ stub, decided, capacity: 10, base, readLog: () => readLog(utf8(link), 0n) }, seed, 1_000, 50);
    }
  } finally {
    await rt.stop();
  }
});
