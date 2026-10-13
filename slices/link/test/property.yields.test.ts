/**
 * S-LINK I5 property runs (T-08 with random traffic): the I1 property run with waiters (I3), invalid holds (I4), and
 * now waiting marks and yield answers, against the per-minute oracle with yields (`YieldOracle`). The run checks every
 * decision and every notice in order, P1-N1 after each entry from the log rows alone (an accepted yield moves the
 * pulse out of occ_all), and that each yield request goes to a younger holder with the mark, for an older waiter
 * (P2-S58). After each seed, a new owner rebuilds the link by replay with no outcome or notice difference (I5 of
 * RFC-001 §3.4). A second run uses the real C01 runtime core (CockroachOwnerRuntime) on its in-memory store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CockroachOwnerRuntime, hlcToWallMs, ManualLoad, MemoryPublisher, utf8, type NotificationOut } from '@share/owner-runtime';
import { MemoryStore } from '@share/owner-runtime/testing';
import {
  declaration, DEFAULT_POLICY, LINK_KIND, LinkOwner, runtimeLogReader, type DecidedRecord, type RequestId, type WaitingNotification,
} from '../src/index.ts';
import { propertyRun } from './property.ts';
import { AccountStub, doubleLogReader, harness, M, steppedClock } from './support.ts';

function yieldRequestsOf(pushed: NotificationOut[]): () => Array<{ request: RequestId; attempt: number; claim: bigint }> {
  return () => pushed.map((n) => n.body as WaitingNotification)
    .filter((b): b is Extract<WaitingNotification, { kind: 'YIELD_REQUEST' }> => b.kind === 'YIELD_REQUEST')
    .map((b) => ({ request: b.request, attempt: b.attempt, claim: b.claim }));
}

test('T-08 the P1-N1 properties, the waiting oracle and the yield oracle hold when 50 clients send 6 seeds × 1,500 commands with marks and yield answers; a replay gives the same outcomes and notices', async () => {
  const total: Record<string, number> = {};
  for (const seed of [71, 72, 73, 74, 75, 76]) {
    const h = await harness({ link: `yield-${seed}`, capacity: 10 });
    const res = await propertyRun({
      stub: h.stub, decided: h.decided, capacity: 10, base: M(9), spread: 600, waitShare: 0.5, yieldShare: 0.25,
      yieldRequests: yieldRequestsOf(h.pushed),
      readLog: async () => h.rt.log(utf8(h.link)).map((e) => ({ seq: e.seq, ts: e.ts, epoch: e.epoch, kind: e.entry.kind, payload: e.entry.payload })),
      advance: (ms) => h.rt.advance(ms),
    }, seed, 1_500, 50);
    for (const [k, v] of Object.entries(res.counts)) total[k] = (total[k] ?? 0) + v;
    assert.equal(res.counts['tick'] ?? 0, 0, 'no Tick entry: the oracle numbers the claims of a scan by the command entry');
    await h.owner.idle();
    const slot = h.rt.route(LINK_KIND, utf8(h.link)).slot;
    h.rt.release(slot, 'taken');
    const owner2 = new LinkOwner(h.rt, { readLog: doubleLogReader(h.rt), links: [h.link] });
    h.rt.attach(owner2);
    await h.rt.acquire(slot);
    assert.deepEqual(owner2.alerts, [], `seed ${seed}: the replay of every entry gives the recorded outcome and notices`);
    assert.deepEqual(owner2.stateOf(h.link)?.openYieldRequests(), h.owner.stateOf(h.link)?.openYieldRequests());
  }
  for (const k of ['HELD', 'WAITING', 'CONVERTED', 'RELEASED', 'APPLIED', 'IGNORED_OLDER', 'ACCEPTED', 'REFUSED_RECORDED', 'STALE_ATTEMPT',
    'notice:YIELD_REQUEST', 'notice:GRANTED', 'notice:WAITER_REFUSED', 'notice:WAITING_NOTICE']) {
    assert.ok((total[k] ?? 0) > 0, `${k} occurs (${JSON.stringify(total)})`);
  }
});

test('should keep the P1-N1 properties and the yield oracle when 50 clients send marks and yield answers on the real C01 runtime core (in-memory store)', async () => {
  const clock = steppedClock();
  const store = new MemoryStore({ wallMs: clock.now });
  store.seedSlots('link', declaration.slotCount);
  const publisher = new MemoryPublisher();
  const rt = new CockroachOwnerRuntime({ declaration, store, publisher, load: new ManualLoad(), wallMs: clock.now,
    slots: Array.from({ length: declaration.slotCount }, (_, i) => i) });
  const decided: DecidedRecord[] = [];
  const pushed: NotificationOut[] = [];
  const readLog = runtimeLogReader(rt);
  // The stepped clock moves less than the re-send interval, so no re-send of a yield request changes the run.
  const owner = new LinkOwner(rt, { readLog, onDecided: (d) => decided.push(d), onNotify: (n) => pushed.push(n), yieldResendMs: 60_000 });
  await rt.start(owner);
  try {
    const link = 'core-yield-81';
    await owner.register(link, 10, DEFAULT_POLICY);
    const stub = new AccountStub(rt, owner, link);
    // The runtime core runs on the stepped clock: the windows start at its present minute (V4, S-LINK I4).
    const base = Math.floor(hlcToWallMs(rt.now().ts) / 60_000);
    const res = await propertyRun({
      stub, decided, capacity: 10, base, waitShare: 0.5, yieldShare: 0.25, yieldRequests: yieldRequestsOf(pushed),
      readLog: () => readLog(utf8(link), 0n), advance: (ms) => clock.advance(Math.floor(ms / 100)),
    }, 81, 1_000, 50);
    for (const k of ['notice:YIELD_REQUEST', 'ACCEPTED', 'STALE_ATTEMPT']) {
      assert.ok((res.counts[k] ?? 0) > 0, `seed 81: ${k} occurs (${JSON.stringify(res.counts)})`);
    }
    assert.ok(clock.stepped() > 0, 'seed 81: the run moves the stepped clock');
  } finally {
    await rt.stop();
  }
});
