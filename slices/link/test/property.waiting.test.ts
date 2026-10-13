/**
 * Exit criterion 4 of S-LINK I3: the I1 property run with `wait = true` and waiters, against the per-minute
 * oracle extended with POL-05 waiting (`MinuteOracle`). Half of the holds wait. The run checks every decision,
 * every waiting-port notice in order (grants, waiter refusals, waiting notices), and P1-N1 after each grant from
 * the log rows alone (`propertyRun`). A second run binds the scan budget, so `Tick` continuations occur. A third
 * run uses the real C01 runtime core (CockroachOwnerRuntime) on its in-memory store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CockroachOwnerRuntime, hlcToWallMs, ManualLoad, MemoryPublisher, utf8 } from '@share/owner-runtime';
import { MemoryStore } from '@share/owner-runtime/testing';
import { declaration, DEFAULT_POLICY, LinkOwner, runtimeLogReader, type DecidedRecord, type LinkPolicy } from '../src/index.ts';
import { propertyRun } from './property.ts';
import { AccountStub, harness, M } from './support.ts';

async function onDouble(seeds: number[], policy: LinkPolicy, commands: number): Promise<Record<string, number>> {
  const total: Record<string, number> = {};
  for (const seed of seeds) {
    const h = await harness({ link: `wait-${seed}`, capacity: 10, policy });
    const res = await propertyRun({
      stub: h.stub, decided: h.decided, capacity: 10, base: M(0), policy, waitShare: 0.5,
      readLog: async () => h.rt.log(utf8(h.link)).map((e) => ({ seq: e.seq, ts: e.ts, epoch: e.epoch, kind: e.entry.kind, payload: e.entry.payload })),
      advance: (ms) => h.rt.advance(ms),
    }, seed, commands, 50);
    for (const [k, v] of Object.entries(res.counts)) total[k] = (total[k] ?? 0) + v;
    assert.equal(h.owner.alerts.filter((a) => a.kind === 'OUTCOME_MISMATCH_ON_REPLAY').length, 0);
  }
  return total;
}

test('T-07 the P1-N1 properties and the POL-05 waiting oracle hold when 50 clients send 6 seeds × 1,500 commands, half of the holds with wait = true', async () => {
  const total = await onDouble([41, 42, 43, 44, 45, 46], DEFAULT_POLICY, 1_500);
  for (const k of ['HELD', 'WAITING', 'CONVERTED', 'RELEASED', 'REFUSED:"NO_FIT"', 'REFUSED:"IN_FLIGHT"', 'NO_HOLD',
    'notice:GRANTED', 'notice:WAITER_REFUSED', 'notice:WAITING_NOTICE']) {
    assert.ok((total[k] ?? 0) > 0, `${k} occurs (${JSON.stringify(total)})`);
  }
});

test('T-07 the waiting oracle holds when the scan budget binds (scan_steps 1): Tick continuations give the same grants and notices', async () => {
  const total = await onDouble([51, 52, 53], { ...DEFAULT_POLICY, scanSteps: 1 }, 1_500);
  assert.ok((total['tick'] ?? 0) > 0, `Tick continuations occur (${JSON.stringify(total)})`);
  assert.ok((total['notice:GRANTED'] ?? 0) > 0);
});

test('should keep the P1-N1 properties and the waiting oracle on the real C01 runtime core (in-memory store) with wait = true', async () => {
  const store = new MemoryStore();
  store.seedSlots('link', declaration.slotCount);
  const publisher = new MemoryPublisher();
  const rt = new CockroachOwnerRuntime({ declaration, store, publisher, load: new ManualLoad(),
    slots: Array.from({ length: declaration.slotCount }, (_, i) => i) });
  const decided: DecidedRecord[] = [];
  const readLog = runtimeLogReader(rt);
  const owner = new LinkOwner(rt, { readLog, onDecided: (d) => decided.push(d) });
  await rt.start(owner);
  try {
    const link = 'core-wait-61';
    const policy = { ...DEFAULT_POLICY, scanSteps: 2 };
    await owner.register(link, 10, policy);
    const stub = new AccountStub(rt, owner, link);
    // The runtime core has a real clock: the windows start at its present minute, so that they are valid (V4, S-LINK I4).
    const base = Math.floor(hlcToWallMs(rt.now().ts) / 60_000);
    const res = await propertyRun({ stub, decided, capacity: 10, base, policy, waitShare: 0.5, readLog: () => readLog(utf8(link), 0n) }, 61, 1_000, 50);
    const notices = Object.entries(res.counts).filter(([k]) => k.startsWith('notice:')).reduce((n, [, v]) => n + v, 0);
    assert.ok(notices > 0, `notices occur (${JSON.stringify(res.counts)})`);
    const sent = publisher.sent.filter((m) => m.topic === 'link.notifications.v1');
    assert.equal(sent.length, notices, 'the runtime publishes one notification row for each notice');
  } finally {
    await rt.stop();
  }
});
