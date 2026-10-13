/**
 * C01 provider suite against the real runtime core (CockroachOwnerRuntime on the in-memory store) and
 * against the runtime double that slices use in their unit tests.
 */
import { C01_SUITE_DECLARATION, c01MoveEvents, runC01ProviderSuite, type C01Subject } from '@share/contract-suites';
import type { OwnerHooks, SlotNo } from '../src/index.ts';
import { CockroachOwnerRuntime, ManualLoad, MemoryPublisher, hex, slotOfPartition } from '../src/index.ts';
import { DoubleWorld, MemoryStore, RuntimeDouble } from '../testing/index.ts';

const DECL = C01_SUITE_DECLARATION;
const FAST = { sessionTimings: { sessionTtlMs: 300, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 280, maxLoopDelayMs: 20 },
  commitBackstopMs: 60, postAcquisitionWaitMs: 10 };

const TARGET: SlotNo = 4;

/** Hooks that record onReportable for each slot, and the move hooks in `events`. */
function reportableHooks(events: string[] = []): { hooks: OwnerHooks; reportable(slot: SlotNo): Promise<void> } {
  const done = new Set<SlotNo>();
  const waiting = new Map<SlotNo, Array<() => void>>();
  const hooks: OwnerHooks = {
    async onAcquire() {}, onRelease() {}, async onNotification() {}, ...c01MoveEvents(events),
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
  store.seedSlots(DECL.kind, DECL.slotCount + 1);
  let target: CockroachOwnerRuntime | undefined;
  const rt = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], publisher: new MemoryPublisher(),
    load: new ManualLoad(), testing: FAST, moves: { peer: (_k, slot) => (slot === TARGET ? target?.moveInbox() : undefined) } });
  const events: string[] = [];
  const r = reportableHooks(events);
  await rt.start(r.hooks);
  // Slot B of the move protocol: a dedicated slot above the slot count, held by a second process.
  const b = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [TARGET], publisher: new MemoryPublisher(), load: new ManualLoad(),
    testing: { ...FAST, adoptReportWaitMs: 10 } });
  target = b;
  const bEvents: string[] = [];
  await b.start(reportableHooks(bEvents).hooks);
  if (!b.heldSlots().includes(TARGET)) throw new Error('the target runtime did not take its slot at start');
  return {
    runtime: rt,
    slotOf: (p) => slotOfPartition(p, DECL.slotCount),
    reportable: r.reportable,
    readLog: (p, from) => rt.readLog(p, from),
    putDisplacementMarker: (link, request, attempt) => { store.displacement.set(`${hex(link)}|${hex(request)}`, { attempt }); },
    restartNext: (n) => { store.faults.commits = Array<'retry'>(n).fill('retry'); },
    events,
    moves: {
      target: { runtime: b, slot: TARGET, events: bEvents },
      moveOut: async (p) => {
        const from = rt.slotFor(p);
        await b.prepareAdopt({ partition: p, from, to: TARGET, generation: rt.generation(p) + 1 });
        const res = await rt.moveOut(p, TARGET, rt.generation(p) + 1);
        if (res.r !== 'Committed') throw new Error(`moved: ${res.r}`);
      },
      adopt: async (p) => { const res = await b.adopt(p); if (res.r !== 'Committed') throw new Error(`adopt: ${res.r}`); },
    },
    stops: {
      stop: async (p, ref) => { store.stopPartition(DECL.kind, rt.slotFor(p), p, ref); },
      resume: async (p) => { store.resumePartition(DECL.kind, rt.slotFor(p), p); },
    },
    close: async () => { await b.stop(); await rt.stop(); },
  };
});

runC01ProviderSuite('runtime double', async (): Promise<C01Subject> => {
  const world = new DoubleWorld();
  const rt = new RuntimeDouble({ declaration: DECL, world });
  const events: string[] = [];
  const r = reportableHooks(events);
  await rt.start(r.hooks);
  const b = new RuntimeDouble({ declaration: DECL, world, slots: [TARGET] });
  const bEvents: string[] = [];
  await b.start(reportableHooks(bEvents).hooks);
  return {
    runtime: rt,
    slotOf: (p) => slotOfPartition(p, DECL.slotCount),
    reportable: r.reportable,
    readLog: (p, from) => rt.readLog(p, from),
    putDisplacementMarker: (link, request, attempt) => rt.putDisplacementMarker(link, request, attempt),
    restartNext: (n) => { rt.scriptRestarts(n); },
    events,
    moves: {
      target: { runtime: b, slot: TARGET, events: bEvents },
      moveOut: async (p) => {
        b.prepareAdopt({ partition: p, from: slotOfPartition(p, DECL.slotCount), to: TARGET, generation: rt.generation(p) + 1 });
        rt.moveOut(p, TARGET);
      },
      adopt: async (p) => { await b.adopt(p); },
    },
    stops: { stop: async (p, ref) => { rt.stop(p, ref); }, resume: async (p) => { rt.resume(p); } },
    close: async () => {},
  };
});
