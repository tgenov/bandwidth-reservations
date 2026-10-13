/**
 * S-LINK I6 exit criterion 3: the I1 property run with leg changes. 50 clients of the recorded stub send holds,
 * conversions, releases and, in 30 % of the steps, `end_leg`, `reduce_parts` and extensions of kind `change` on their
 * confirmed legs. Every decision equals the per-minute oracle (`MinuteOracle`, with its own leg changes), the P1-N1
 * check from the log rows holds after each entry, no leg change raises a rate, and the link's `occ_firm` and `occ_all`
 * at the end equal the oracle's at every minute. With waiters (I3), the scans over the freed ranges give the
 * oracle's notices. A second run uses the real C01 runtime core (in-memory store).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CockroachOwnerRuntime, hlcToWallMs, ManualLoad, MemoryPublisher, utf8 } from '@share/owner-runtime';
import { MemoryStore } from '@share/owner-runtime/testing';
import { declaration, DEFAULT_POLICY, LinkOwner, runtimeLogReader, type DecidedRecord } from '../src/index.ts';
import { propertyRun } from './property.ts';
import { AccountStub, harness, M, steppedClock } from './support.ts';

const LEG_OUTCOMES = [
  'leg:CHANGED', 'leg:STALE_CHANGE', 'leg:MISMATCH', 'leg:UNKNOWN_RESERVATION', 'leg:UNKNOWN_PART', 'leg:UNKNOWN_REDUCTION', 'leg:INVALID',
];

test('should keep P1-N1 and the oracle with leg changes when 50 clients send 6 seeds × 2,000 commands, 30 % of them leg changes, on the runtime double', async () => {
  const total: Record<string, number> = {};
  let clipped = 0;
  for (const seed of [61, 62, 63, 64, 65, 66]) {
    const h = await harness({ link: `legs-${seed}`, capacity: 10 });
    const res = await propertyRun({
      stub: h.stub, decided: h.decided, capacity: 10, base: M(0), legShare: 0.3, waitShare: seed % 2 === 0 ? 0.3 : 0,
      readLog: async () => h.rt.log(utf8(h.link)).map((e) => ({ seq: e.seq, ts: e.ts, epoch: e.epoch, kind: e.entry.kind, payload: e.entry.payload })),
      advance: (ms) => h.rt.advance(ms),
      state: () => h.owner.stateOf(h.link),
    }, seed, 2_000, 50);
    for (const [k, v] of Object.entries(res.counts)) total[k] = (total[k] ?? 0) + v;
    clipped += h.decided.filter((d) => (d.outcome as { clippedAt?: number }).clippedAt !== undefined).length;
  }
  for (const k of [...LEG_OUTCOMES, 'CONVERTED', 'notice:GRANTED']) assert.ok((total[k] ?? 0) > 0, `${k} occurs (${JSON.stringify(total)})`);
  assert.ok(clipped > 0, 'some converts are clipped by a later end_leg');
});

test('should keep P1-N1 and the oracle with leg changes when the counter-offer budgets bind (4 seeds × 1,500 commands)', async () => {
  const policy = { ...DEFAULT_POLICY, counterofferSteps: 2, counterofferBatchSteps: 5, scanSteps: 1 };
  const total: Record<string, number> = {};
  for (const seed of [71, 72, 73, 74]) {
    const h = await harness({ link: `legs-tight-${seed}`, capacity: 10, policy });
    const res = await propertyRun({
      stub: h.stub, decided: h.decided, capacity: 10, base: M(0), policy, legShare: 0.3, waitShare: 0.3,
      readLog: async () => h.rt.log(utf8(h.link)).map((e) => ({ seq: e.seq, ts: e.ts, epoch: e.epoch, kind: e.entry.kind, payload: e.entry.payload })),
      advance: (ms) => h.rt.advance(ms),
      state: () => h.owner.stateOf(h.link),
    }, seed, 1_500, 50);
    for (const [k, v] of Object.entries(res.counts)) total[k] = (total[k] ?? 0) + v;
  }
  for (const k of ['leg:CHANGED', 'leg:STALE_CHANGE', 'notice:GRANTED', 'tick']) assert.ok((total[k] ?? 0) > 0, `${k} occurs (${JSON.stringify(total)})`);
});

test('should keep P1-N1 and the oracle with leg changes on the real C01 runtime core (in-memory store), 2 seeds × 1,000 commands', async () => {
  const clock = steppedClock();
  const store = new MemoryStore({ wallMs: clock.now });
  store.seedSlots('link', declaration.slotCount);
  const rt = new CockroachOwnerRuntime({ declaration, store, publisher: new MemoryPublisher(), load: new ManualLoad(), wallMs: clock.now,
    slots: Array.from({ length: declaration.slotCount }, (_, i) => i) });
  const decided: DecidedRecord[] = [];
  const readLog = runtimeLogReader(rt);
  const owner = new LinkOwner(rt, { readLog, onDecided: (d) => decided.push(d) });
  await rt.start(owner);
  try {
    for (const seed of [81, 82]) {
      const link = `core-legs-${seed}`;
      decided.length = 0;
      await owner.register(link, 10);
      const stub = new AccountStub(rt, owner, link);
      // The runtime core runs on the stepped clock (S-LINK I5 TR-1): the windows start at its present minute (V4).
      const base = Math.floor(hlcToWallMs(rt.now().ts) / 60_000);
      await propertyRun({
        stub, decided, capacity: 10, base, legShare: 0.3, waitShare: 0.2, readLog: () => readLog(utf8(link), 0n), state: () => owner.stateOf(link),
        advance: (ms) => clock.advance(Math.floor(ms / 100)),
      }, seed, 1_000, 50);
    }
    assert.ok(clock.stepped() > 0, 'the run moves the stepped clock');
  } finally {
    await rt.stop();
  }
});
