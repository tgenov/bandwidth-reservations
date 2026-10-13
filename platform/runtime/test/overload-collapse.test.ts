/**
 * Goodput under overload of the real runtime core (lane, batching, executeBatch) over the in-memory store.
 * The database time of a batch grows with its size; a stepped clock carries it, so no test waits on real time.
 * C01 §3.2 and §7 (abandonBeforeCommitMs), R47-12, RFC-006 §4.7.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppendResult, EntryInput, OwnerDeclaration, OwnerHooks } from '../src/index.ts';
import { CockroachOwnerRuntime, ManualLoad, MemoryPublisher, utf8 } from '../src/index.ts';
import type { BatchTxn, BatchWrites } from '../src/store/types.ts';
import { MemoryStore } from '../testing/index.ts';

const DECL: OwnerDeclaration = {
  kind: 'canary', slotCount: 1,
  entryKinds: [{ kind: 1, name: 'incremented', schemaVersions: [1], retention: 'ops' }],
  projections: [],
  streams: [],
};

const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'internal_service', kind: 'service', tenant: 'share' },
  decided_at: 'commit', policy_version: 1 } as const;
const entry = (id: string): EntryInput => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id } });

const HOOKS: OwnerHooks = {
  async onAcquire() {}, onRelease() {}, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {},
};

/** Database time of one transaction: a fixed cost plus a cost per log row, charged at the write statement. */
const BASE_MS = 50;
const PER_ROW_MS = 2;
const PARTITIONS = 64;

/** The stepped clock of the simulation, in ms. */
class SimClock {
  ms = 0;
  readonly now = (): number => this.ms;
}

/**
 * The in-memory store with database time: each `write` steps the clock by BASE_MS + PER_ROW_MS × rows, then
 * calls `onTime` so that the calls that arrive in that interval join the lane's queue.
 */
class SlowStore extends MemoryStore {
  readonly batchRows: number[] = [];
  writes = 0;
  wastedWrites = 0;
  onTime: () => void = () => {};
  private readonly clock: SimClock;

  constructor(clock: SimClock) {
    super();
    this.clock = clock;
  }

  override async beginBatch(): Promise<BatchTxn> {
    const tx = await super.beginBatch();
    let wrote = false;
    const write = tx.write.bind(tx);
    const commit = tx.commit.bind(tx);
    const rollback = tx.rollback.bind(tx);
    tx.write = async (kind: string, w: BatchWrites): Promise<void> => {
      await write(kind, w);
      wrote = true;
      this.writes += 1;
      this.batchRows.push(w.log.length);
      this.clock.ms += BASE_MS + PER_ROW_MS * w.log.length;
      this.onTime();
    };
    tx.commit = async (backstopMs: number): Promise<void> => { wrote = false; await commit(backstopMs); };
    tx.rollback = async (): Promise<void> => {
      if (wrote) this.wastedWrites += 1;
      wrote = false;
      await rollback();
    };
    return tx;
  }
}

interface Phase { untilMs: number; ratePerS: number }

interface LoadReport {
  offeredPerS: number; committedPerS: number; windowMs: [number, number];
  calls: number; committed: number; retries: number; overloaded: number; wastedWrites: number; writes: number;
  meanBatchRows: number; maxBatchRows: number;
}

/**
 * Open-loop load at fixed rates over one slot. A caller re-sends a call at once after `Retry`, and after
 * `retryAfterMs` after `Overloaded`. No call is re-sent after the last phase ends. Goodput is measured over
 * the last `windowMs` of the last phase, by the clock time of each commit.
 */
async function runLoad(phases: Phase[], windowMs: number): Promise<LoadReport> {
  const clock = new SimClock();
  const store = new SlowStore(clock);
  store.seedSlots(DECL.kind, DECL.slotCount);
  const rt = new CockroachOwnerRuntime({
    declaration: DECL, store, slots: [0], publisher: new MemoryPublisher(), load: new ManualLoad(),
    testing: { batchNowMs: clock.now },
  });
  await rt.start(HOOKS);
  const endMs = phases[phases.length - 1]?.untilMs ?? 0;
  const windowFrom = endMs - windowMs;

  const arrivals: Array<{ at: number; id: number }> = [];
  let calls = 0;
  let from = 0;
  for (const p of phases) {
    const gap = 1_000 / p.ratePerS;
    for (let t = from; t < p.untilMs; t += gap) arrivals.push({ at: t, id: calls++ });
    from = p.untilMs;
  }
  const offeredInWindow = arrivals.filter((a) => a.at >= windowFrom).length;

  const resends: Array<{ at: number; id: number }> = [];
  let next = 0;
  let inRuntime = 0;
  let committed = 0;
  let retries = 0;
  let overloaded = 0;
  let idle: (() => void) | undefined;

  const answer = (id: number, r: AppendResult): void => {
    inRuntime -= 1;
    if (r.r === 'Committed') {
      if (clock.ms >= windowFrom && clock.ms <= endMs) committed += 1;
    } else if (r.r === 'Retry' || r.r === 'Overloaded') {
      if (r.r === 'Retry') retries += 1; else overloaded += 1;
      const at = clock.ms + (r.r === 'Overloaded' ? r.retryAfterMs : 0);
      if (at < endMs) resends.push({ at, id });
    } else {
      throw new Error(`unexpected append result ${r.r}`);
    }
    if (inRuntime === 0) idle?.();
  };
  const send = (id: number): void => {
    inRuntime += 1;
    rt.append({ partition: utf8(`p-${id % PARTITIONS}`), entries: [entry(`c-${id}`)] }).then((r) => answer(id, r), (e: unknown) => { throw e; });
  };
  const deliver = (): void => {
    const upTo = Math.min(clock.ms, endMs);
    while (next < arrivals.length && (arrivals[next]?.at ?? Infinity) <= upTo) send(arrivals[next++]?.id ?? -1);
    resends.sort((a, b) => a.at - b.at);
    while (resends.length > 0 && (resends[0]?.at ?? Infinity) <= upTo) send(resends.shift()?.id ?? -1);
  };
  store.onTime = deliver;

  try {
    for (;;) {
      deliver();
      if (inRuntime > 0) {
        await new Promise<void>((r) => { idle = r; });
        idle = undefined;
        continue;
      }
      const due = Math.min(arrivals[next]?.at ?? Infinity, ...resends.map((r) => r.at));
      if (due === Infinity || due >= endMs) break;
      clock.ms = Math.max(clock.ms, due);
    }
  } finally {
    await rt.stop();
  }
  const rows = store.batchRows;
  return {
    offeredPerS: (offeredInWindow * 1_000) / windowMs,
    committedPerS: (committed * 1_000) / windowMs,
    windowMs: [windowFrom, endMs],
    calls, committed, retries, overloaded,
    wastedWrites: store.wastedWrites, writes: store.writes,
    meanBatchRows: Math.round(rows.reduce((a, b) => a + b, 0) / Math.max(1, rows.length)),
    maxBatchRows: Math.max(0, ...rows),
  };
}

const describe = (r: LoadReport): string =>
  `offered ${r.offeredPerS}/s, committed ${r.committedPerS}/s in [${r.windowMs[0]} ms, ${r.windowMs[1]} ms]; ` +
  `abandoned (wasted) transactions ${r.wastedWrites} of ${r.writes}; Retry answers ${r.retries}; Overloaded ${r.overloaded}; ` +
  `mean batch ${r.meanBatchRows} rows, max ${r.maxBatchRows} rows; calls ${r.calls}`;

test('should commit the offered rate when the offered rate stays below capacity', { timeout: 60_000 }, async () => {
  const r = await runLoad([{ untilMs: 20_000, ratePerS: 200 }], 10_000);
  assert.equal(r.offeredPerS, 200, describe(r));
  assert.ok(r.committedPerS >= 199, describe(r));
  assert.equal(r.wastedWrites, 0, describe(r));
  assert.equal(r.retries, 0, describe(r));
  assert.equal(r.overloaded, 0, describe(r));
});

test('should commit the offered rate again after a burst above capacity when the database time grows with the batch size', {
  timeout: 120_000,
  todo: 'open defect: metastable overload collapse (abandon before COMMIT, fresh attempt without backoff, Retry without retryAfterMs); fix after the design change',
}, async () => {
  const r = await runLoad([{ untilMs: 3_000, ratePerS: 1_000 }, { untilMs: 33_000, ratePerS: 200 }], 10_000);
  assert.equal(r.offeredPerS, 200, describe(r));
  assert.ok(r.committedPerS >= 190, `goodput collapsed: ${describe(r)}`);
});
