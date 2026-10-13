/**
 * C01 provider suite against the real runtime core (CockroachOwnerRuntime on the in-memory store) and
 * against the runtime double that slices use in their unit tests.
 */
import { C01_SUITE_DECLARATION, runC01ProviderSuite, type C01Subject } from '@share/contract-suites';
import type { OwnerHooks, SlotNo } from '../src/index.ts';
import { CockroachOwnerRuntime, ManualLoad, MemoryPublisher, hex, slotOfPartition } from '../src/index.ts';
import { MemoryStore, RuntimeDouble } from '../testing/index.ts';

const DECL = C01_SUITE_DECLARATION;
const FAST = { sessionTimings: { sessionTtlMs: 300, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 280, maxLoopDelayMs: 20 },
  commitBackstopMs: 60, postAcquisitionWaitMs: 10 };

/** Hooks that record onReportable for each slot. */
function reportableHooks(): { hooks: OwnerHooks; reportable(slot: SlotNo): Promise<void> } {
  const done = new Set<SlotNo>();
  const waiting = new Map<SlotNo, Array<() => void>>();
  const hooks: OwnerHooks = {
    async onAcquire() {}, onRelease() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {},
    onReportable(slot) {
      done.add(slot);
      for (const w of waiting.get(slot) ?? []) w();
      waiting.delete(slot);
    },
  };
  const reportable = (slot: SlotNo): Promise<void> => done.has(slot)
    ? Promise.resolve()
    : new Promise((resolve) => waiting.set(slot, [...(waiting.get(slot) ?? []), resolve]));
  return { hooks, reportable };
}

runC01ProviderSuite('real runtime', async (): Promise<C01Subject> => {
  const store = new MemoryStore();
  store.seedSlots(DECL.kind, DECL.slotCount);
  const rt = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], publisher: new MemoryPublisher(),
    load: new ManualLoad(), testing: FAST });
  const r = reportableHooks();
  await rt.start(r.hooks);
  return {
    runtime: rt,
    slotOf: (p) => slotOfPartition(p, DECL.slotCount),
    reportable: r.reportable,
    readLog: (p, from) => rt.readLog(p, from),
    putDisplacementMarker: (link, request, attempt) => { store.displacement.set(`${hex(link)}|${hex(request)}`, { attempt }); },
    restartNext: (n) => { store.faults.commits = Array<'retry'>(n).fill('retry'); },
    close: () => rt.stop(),
  };
});

runC01ProviderSuite('runtime double', async (): Promise<C01Subject> => {
  const rt = new RuntimeDouble({ declaration: DECL });
  const r = reportableHooks();
  await rt.start(r.hooks);
  return {
    runtime: rt,
    slotOf: (p) => slotOfPartition(p, DECL.slotCount),
    reportable: r.reportable,
    readLog: (p, from) => rt.readLog(p, from),
    putDisplacementMarker: (link, request, attempt) => rt.putDisplacementMarker(link, request, attempt),
    restartNext: (n) => { rt.scriptRestarts(n); },
    close: async () => {},
  };
});
