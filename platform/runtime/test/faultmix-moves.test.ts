/**
 * S-PLAT-I3 exit 1 and exit 2 at the unit level: C01 CP-1, CP-7, CP-7a, CP-8 again with moves and stops in the seeded fault
 * mix, CP-9 gap fill across a move, and DT-08 with moves. The C01 core on the in-memory store and bus.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppendResult, EntryInput, FeedEvent, HlcTs, OwnerDeclaration, OwnerHooks, PartitionKey, ReportMarker, SlotNo } from '../src/index.ts';
import {
  ClosureEmitter, CockroachOwnerRuntime, DevSealer, FeedConsumerRuntime, ManualLoad, MemoryMoveStore, MemoryPublisher, MoveCoordinator, MoveError,
  OutboxRelay, PLATFORM_ENTRY, compareHlc, decodeClosure, hex, hlc, slotOfPartition, utf8, type MoveHolders,
} from '../src/index.ts';
import { MemoryBus, MemoryChangefeed, MemoryGapFill, MemoryStore, memoryFeedSeqReader } from '../testing/index.ts';
import { Closers, rng, until } from './support.ts';

const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const FAST = { sessionTtlMs: 300, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 280, maxLoopDelayMs: 20 };
const closers = new Closers();
const T = { timeout: 60_000 };
afterEach(() => closers.closeAll());
const hooks = (): OwnerHooks => ({ async onAcquire() {}, onRelease() {}, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {} });

/** Runtimes of one kind on one store, with the inboxes of the move protocol, and placement's coordinator. */
function cluster(decl: OwnerDeclaration, store: MemoryStore, o: { publisher?: () => MemoryPublisher; testing?: Record<string, unknown> } = {}) {
  const bySlot = new Map<SlotNo, CockroachOwnerRuntime>();
  const make = async (slots: SlotNo[]): Promise<CockroachOwnerRuntime> => {
    const rt = new CockroachOwnerRuntime({ declaration: decl, store, slots, load: new ManualLoad(), ...(o.publisher ? { publisher: o.publisher() } : {}),
      moves: { peer: (_k, s) => bySlot.get(s)?.moveInbox() },
      testing: { sessionTimings: FAST, commitBackstopMs: 1_000, postAcquisitionWaitMs: 10, adoptReportWaitMs: 10, ...o.testing } });
    closers.add(() => rt.stop());
    await rt.start(hooks());
    await until(() => slots.every((s) => rt.heldSlots().includes(s)), 5_000, `slots ${slots.join(',')} held`);
    for (const s of slots) bySlot.set(s, rt);
    return rt;
  };
  const holders: MoveHolders = {
    prepare: (m) => (bySlot.get(m.to) as CockroachOwnerRuntime).prepareAdopt(m),
    moveOut: (m) => (bySlot.get(m.from) as CockroachOwnerRuntime).moveOut(m.partition, m.to, m.generation),
    adopt: (m) => (bySlot.get(m.to) as CockroachOwnerRuntime).adopt(m.partition),
  };
  const moves = new MemoryMoveStore();
  return { bySlot, make, coordinator: new MoveCoordinator({ store: moves, holders }), moves };
}

/** `p`, or a failure that names `what` when it does not settle in `ms` (a broken fence fails here, not at the test timeout). */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error(`not within ${ms} ms: ${what}`)), ms); });
  try { return await Promise.race([p, late]); } finally { clearTimeout(timer); }
}

type LogRow = MemoryStore['log'][number];
function rowsOf(store: MemoryStore, p: PartitionKey): LogRow[] {
  return store.log.filter((l) => hex(l.partition) === hex(p)).sort((a, b) => (a.seq < b.seq ? -1 : 1));
}

/**
 * The single-writer invariants of one partition's log (CP-1, DT-08): seq contiguous from 1, ts strictly increasing, the
 * generation never goes back and all rows of one generation come from one slot, and B writes nothing before its adopt.
 */
function checkPartition(rows: LogRow[], what: string): void {
  rows.forEach((r, i) => assert.equal(r.seq, BigInt(i + 1), `${what}: seq contiguous at ${i}`));
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1] as LogRow; const b = rows[i] as LogRow;
    assert.equal(compareHlc(a.ts, b.ts), -1, `${what}: ts strictly increasing at seq ${b.seq}`);
    assert.ok(b.generation >= a.generation, `${what}: generation never goes back at seq ${b.seq}`);
  }
  const slotOfGen = new Map<number, SlotNo>();
  for (const r of rows) {
    const s = slotOfGen.get(r.generation);
    if (s === undefined) slotOfGen.set(r.generation, r.slot);
    else assert.equal(r.slot, s, `${what}: generation ${r.generation} has one writing slot`);
    if (r.generation > 0 && rows.find((x) => x.generation === r.generation)?.kind !== PLATFORM_ENTRY.adopt) {
      assert.fail(`${what}: the first row of generation ${r.generation} is not adopt`);
    }
  }
}

// ---------------- CP-1 and DT-08 with moves and stops in the seeded fault mix ----------------

const MIX: OwnerDeclaration = { kind: 'fmix', slotCount: 4, entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }], projections: [], streams: [] };

test('C01 CP-1 with moves and stops in the fault mix: across seeded load, lost COMMIT answers, stops, resumes, moves and a takeover of a target slot, every partition has one writer per generation, seq contiguous, ts strictly increasing, and nothing commits while stopped (DT-08 with moves)', T, async () => {
  let staleSent = 0;
  for (const seed of [7, 1984, 31337]) {
    const rnd = rng(seed);
    const store = new MemoryStore();
    store.seedSlots(MIX.kind, 6);
    const c = cluster(MIX, store);
    await c.make([0, 1, 2, 3]);
    let b = await c.make([4]);
    await c.make([5]);
    const ps = Array.from({ length: 6 }, (_, i) => utf8(`p${seed}-${i}`));
    const where = new Map(ps.map((p) => [hex(p), slotOfPartition(p, 4)]));
    const stopped = new Map<string, { at: HlcTs }>();
    const intervals: Array<{ p: string; from: HlcTs; to: HlcTs | null }> = [];
    const committed = new Map<string, number>();
    const closedBefore: Array<{ id: string; closed: HlcTs }> = [];
    let tookOver = false;
    // The holders that moved a partition out: a call sent to them must never commit (one writer per generation).
    const formerHolders = new Map<string, CockroachOwnerRuntime[]>();
    const stale: Array<{ id: string; r: AppendResult['r'] }> = [];
    for (let i = 0; i < 90; i++) {
      // Every draw at the top of the iteration: the draw sequence does not depend on the outcomes.
      const [pick, x, op, toDraw, staleDraw] = [rnd(), rnd(), rnd(), rnd(), rnd()];
      const p = ps[Math.floor(pick * ps.length)] as PartitionKey;
      const k = hex(p);
      if (x < 0.06) store.faults.commits.push('ambiguousCommitted');
      else if (x < 0.12) store.faults.commits.push('ambiguousNotCommitted');
      if (op < 0.08 && !stopped.has(k)) {
        const at = store.stopPartition(MIX.kind, [0, 1, 2, 3, 4, 5], p, utf8(`det-${i}`));
        stopped.set(k, { at });
        intervals.push({ p: k, from: at, to: null });
      } else if (op < 0.14 && stopped.has(k)) {
        const to = store.resumePartition(MIX.kind, [0, 1, 2, 3, 4, 5], p);
        stopped.delete(k);
        const open = intervals.find((v) => v.p === k && v.to === null);
        if (open) open.to = to;
      } else if (op < 0.2 && !stopped.has(k) && (where.get(k) ?? 0) < 4) {
        store.faults.commits.splice(0);                // a move step answered Ambiguous is not part of this mix
        const to = toDraw < 0.5 ? 4 : 5;
        const from = where.get(k) as SlotNo;
        const source = c.bySlot.get(from) as CockroachOwnerRuntime;
        try {
          await c.coordinator.move({ kind: MIX.kind, partition: p, from, to });
          where.set(k, to);
          formerHolders.set(k, [...(formerHolders.get(k) ?? []), source]);
        } catch (e) { if (!(e instanceof MoveError)) throw e; }
      } else if (staleDraw < 0.3 && (formerHolders.get(k) ?? []).length > 0) {
        const former = (formerHolders.get(k) ?? [])[0] as CockroachOwnerRuntime;
        const id = `stale${seed}-${i}`;
        const r = await former.append({ partition: p, entries: [{ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id } }] }, { slot: slotOfPartition(p, 4) });
        stale.push({ id, r: r.r });
        assert.ok(['Moving', 'Moved', 'Stopped', 'Ambiguous', 'Retry'].includes(r.r), `seed ${seed} op ${i}: a former holder answered ${r.r}`);
      } else {
        const rt = c.bySlot.get(where.get(k) as SlotNo) as CockroachOwnerRuntime;
        const id = `s${seed}-${i}`;
        const closed = await rt.closedTimestamp();
        const r: AppendResult = await rt.append({ partition: p, entries: [{ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id } }] });
        if (r.r === 'Committed') { committed.set(id, 1); closedBefore.push({ id, closed }); }
        assert.ok(['Committed', 'Ambiguous', 'Stopped', 'Moving', 'Retry', 'StaleEpoch'].includes(r.r), `seed ${seed} op ${i}: ${r.r}`);
        if (r.r === 'Stopped') assert.ok(stopped.has(k), `seed ${seed} op ${i}: Stopped only while a stop is open`);
      }
      if (!tookOver && i === 60) {
        // A pause past session_ttl of the holder of slot 4: another process takes the slot (V59-7 and catch-up).
        tookOver = true;
        store.faults.commits.splice(0);
        b.pauseRenewalsForTest();
        b = await c.make([4]);
      }
    }
    store.faults.commits.splice(0);
    for (const p of ps) {
      const rows = rowsOf(store, p);
      checkPartition(rows, `seed ${seed} ${hex(p)}`);
      for (const v of intervals.filter((iv) => iv.p === hex(p))) {
        for (const r of rows) {
          const inside = compareHlc(r.ts, v.from) > 0 && (v.to === null || compareHlc(r.ts, v.to) < 0);
          assert.equal(inside, false, `seed ${seed}: ${hex(p)} seq ${r.seq} committed at ${r.ts} inside the stop from ${v.from}`);
        }
      }
    }
    const ids = store.log.map((l) => Buffer.from(l.identity).toString());
    for (const { id, r } of stale) assert.equal(ids.includes(id), false, `seed ${seed}: ${id} sent to a former holder (${r}) never commits`);
    staleSent += stale.length;
    for (const id of committed.keys()) assert.equal(ids.filter((x) => x === id).length, 1, `seed ${seed}: ${id} committed exactly once`);
    for (const { id, closed } of closedBefore) {
      const row = store.log.find((l) => Buffer.from(l.identity).toString() === id) as LogRow;
      assert.equal(compareHlc(row.ts, closed), 1, `seed ${seed}: ${id} commits above the closed timestamp read before it (DT-08)`);
    }
    assert.ok(store.log.some((l) => l.kind === PLATFORM_ENTRY.adopt), `seed ${seed}: the mix moved at least one partition`);
    await closers.closeAll();
  }
  assert.ok(staleSent > 0, 'the mix sent at least one call to a former holder');
});

// ---------------- CP-7 and CP-7a with moves, a stop and a takeover ----------------

const REP: OwnerDeclaration = {
  kind: 'frep', slotCount: 4,
  entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops', reportWanted: true }], projections: [], streams: [],
};
const repEntry = (id: string): EntryInput => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id } });

/** CP-7a: per slot, the markers make one chain with no gap and no overlap; prev is null only for the slot's first. */
function checkChains(markers: ReportMarker[], what: string): Map<SlotNo, ReportMarker[]> {
  const bySlot = new Map<SlotNo, ReportMarker[]>();
  for (const m of markers) if (m.chunk.part === 0) bySlot.set(m.slot, [...(bySlot.get(m.slot) ?? []), m]);
  for (const [slot, list] of bySlot) {
    list.sort((a, b) => compareHlc(a.reportPosition, b.reportPosition));
    list.forEach((m, i) => {
      const prev = i === 0 ? null : (list[i - 1] as ReportMarker).reportPosition;
      assert.equal(m.prevReportPosition, prev, `${what}: slot ${slot} marker ${i} chains to the previous marker of the same slot`);
    });
  }
  return bySlot;
}

test('C01 CP-7a with moves, a stop and a takeover: per slot the markers chain with no gap and no overlap; the adopt does not change the target slot\'s chain; the successor chains to its predecessor', T, async () => {
  const store = new MemoryStore();
  store.seedSlots(REP.kind, 5);
  const c = cluster(REP, store);
  const a = await c.make([0, 1, 2, 3]);
  const b = await c.make([4]);
  const X = utf8('rep-x'); const Y = utf8('rep-y');
  const SX = slotOfPartition(X, 4);
  const lastMarker = async (rt: CockroachOwnerRuntime, slot: SlotNo, ts: HlcTs): Promise<void> => {
    await until(() => rt.markersWritten.some((m) => m.slot === slot && compareHlc(m.reportPosition, ts) >= 0), 5_000, `marker of slot ${slot} at ${ts}`);
  };
  for (let i = 0; i < 3; i++) {
    const r = await a.append({ partition: X, entries: [repEntry(`x${i}`)] });
    assert.equal(r.r, 'Committed');
    await lastMarker(a, SX, (r as Extract<AppendResult, { r: 'Committed' }>).ts);
  }
  await within(c.coordinator.move({ kind: REP.kind, partition: X, from: SX, to: 4 }), 3_000,
    'the move: A\'s marker for moved (report_through ≥ ts(moved)) reaches B and B adopts');
  const rb = await b.append({ partition: X, entries: [repEntry('b1')] });
  assert.equal(rb.r, 'Committed');
  await lastMarker(b, 4, (rb as Extract<AppendResult, { r: 'Committed' }>).ts);
  const SY = slotOfPartition(Y, 4);
  store.stopPartition(REP.kind, SY, Y, utf8('det'));
  assert.equal((await a.append({ partition: Y, entries: [repEntry('y0')] })).r, 'Stopped');
  store.resumePartition(REP.kind, SY, Y);
  const ry = await a.append({ partition: Y, entries: [repEntry('y1')] });
  assert.equal(ry.r, 'Committed');
  // A takeover of A's slots: the successor's first marker chains to A's last marker of each slot.
  a.pauseRenewalsForTest();
  const a2 = await c.make([0, 1, 2, 3]);
  const r2 = await a2.append({ partition: Y, entries: [repEntry('y2')] });
  assert.equal(r2.r, 'Committed');
  await lastMarker(a2, SY, (r2 as Extract<AppendResult, { r: 'Committed' }>).ts);
  const chains = checkChains([...a.markersWritten, ...b.markersWritten, ...a2.markersWritten], 'CP-7a');
  assert.equal((chains.get(4) ?? [])[0]?.prevReportPosition, null, 'the adopt does not give slot 4 a predecessor');
  const succ = a2.markersWritten.find((m) => m.slot === SY);
  const pred = a.markersWritten.filter((m) => m.slot === SY).at(-1);
  assert.ok(succ && pred);
  assert.equal(succ.prevReportPosition, pred.reportPosition, 'the successor chains to its predecessor\'s last marker');
});

test('C01 CP-7 with a move: A\'s readers apply moved before A\'s report position passes it; B\'s readers learn the adopt before B reports X', T, async () => {
  const store = new MemoryStore();
  store.seedSlots(REP.kind, 5);
  const c = cluster(REP, store, { testing: { adoptReportWaitMs: 200 } });
  const a = await c.make([0, 1, 2, 3]);
  const b = await c.make([4]);
  const X = utf8('rep-x7');
  const SX = slotOfPartition(X, 4);
  const seen: Array<{ who: string; p: HlcTs | undefined; ts: HlcTs }> = [];
  a.attachReader('ra', { apply: async (_s, t) => t, movedOut: (_s, _p, ts) => { seen.push({ who: 'A', p: a.reportPosition(SX), ts }); } });
  b.attachReader('rb', { apply: async (_s, t) => t, adopted: (_s, _p, ts) => { seen.push({ who: 'B', p: b.reportPosition(4), ts }); } });
  const x0 = await a.append({ partition: X, entries: [repEntry('x0')] });
  assert.equal(x0.r, 'Committed');
  await until(() => { const p = a.reportPosition(SX); return p !== undefined && compareHlc(p, (x0 as Extract<AppendResult, { r: 'Committed' }>).ts) >= 0; }, 5_000, 'A reports x0');
  await until(() => b.reportPosition(4) !== undefined, 5_000, 'B is reportable');
  await within(c.coordinator.move({ kind: REP.kind, partition: X, from: SX, to: 4 }), 3_000,
    'the move: A\'s marker for moved (report_through ≥ ts(moved)) reaches B and B adopts');
  assert.deepEqual(seen.map((s) => s.who), ['A', 'B']);
  for (const s of seen) {
    assert.ok(s.p !== undefined, `${s.who}: the slot is reportable when the reader learns ${s.ts}`);
    assert.equal(compareHlc(s.p, s.ts), -1, `${s.who}: the reader learns ${s.ts} before P passes it (P ${s.p})`);
  }
  const rb = await b.append({ partition: X, entries: [repEntry('b1')] });
  assert.equal(rb.r, 'Committed');
  await until(() => { const p = b.reportPosition(4); return p !== undefined && compareHlc(p, (rb as Extract<AppendResult, { r: 'Committed' }>).ts) >= 0; }, 5_000, 'B reports b1');
});

// ---------------- CP-8 and CP-9 with moves and stops ----------------

const FEED: OwnerDeclaration = {
  kind: 'link', slotCount: 4,
  entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }], projections: [],
  streams: [{ name: 'schedule', topic: 'link.schedule.v1', key: 'partition', emitFn: { version: 1 }, closure: 'closedPerLink', consumers: ['account'] }],
};
const feedEntry = (id: string): EntryInput => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id }, emits: [{ stream: 'schedule', event: { id } }] });

test('C01 CP-8 with moves and stops: markers never precede a row at or below them, R_min never goes back, and CLOSED(feed_seq) of a moved link continues the stream after the move', T, async () => {
  const bus = new MemoryBus();
  const store = new MemoryStore();
  store.seedSlots('link', 5);
  store.seedSlots('closure_link', 1);
  const feed = new MemoryChangefeed(store, bus, 'link', 2);
  await bus.ensureTopic('link.schedule.v1', 4);
  const c = cluster(FEED, store);
  const a = await c.make([0, 1, 2, 3]);
  const b = await c.make([4]);
  const relay = new OutboxRelay({ bus, kind: 'link' });
  await relay.start();
  closers.add(() => relay.stop());
  const emitter = new ClosureEmitter({ bus, declaration: FEED, store, feedSeqs: memoryFeedSeqReader(store), pollMs: 10, heartbeatMs: 60_000, sessionTimings: FAST });
  await emitter.start();
  closers.add(() => emitter.stop());
  const rMins: HlcTs[] = [];
  const X = utf8('L-moved'); const Y = utf8('L-stopped');
  const SX = slotOfPartition(X, 4); const SY = slotOfPartition(Y, 4);
  for (let i = 0; i < 2; i++) { await a.append({ partition: X, entries: [feedEntry(`x${i}`)] }); await a.append({ partition: Y, entries: [feedEntry(`y${i}`)] }); }
  const R1 = await feed.resolve();
  await until(() => emitter.rMin() === R1, 5_000, 'R1');
  rMins.push(R1 as HlcTs);
  store.stopPartition('link', SY, Y, utf8('det'));
  assert.equal((await a.append({ partition: Y, entries: [feedEntry('y-stopped')] })).r, 'Stopped');
  await c.coordinator.move({ kind: 'link', partition: X, from: SX, to: 4 });
  for (let i = 2; i < 4; i++) assert.equal((await b.append({ partition: X, entries: [feedEntry(`x${i}`)] })).r, 'Committed');
  const R2 = await feed.resolve();
  await until(() => emitter.rMin() === R2, 5_000, 'R2');
  rMins.push(R2 as HlcTs);
  assert.equal(compareHlc(rMins[0] as HlcTs, rMins[1] as HlcTs), -1, 'R_min never goes back');
  for (const m of emitter.emitted) {
    const data = m.topic.replace(/\.closure$/, '');
    for (const r of bus.records(data, m.partition)) {
      const ts = hlc(Buffer.from(r.headers['ts'] ?? []).toString());
      if (compareHlc(ts, m.resolved) <= 0) assert.ok(r.offset < m.dataHighWater, `${data}/${m.partition}@${r.offset} ts ≤ ${m.resolved} is below ${m.dataHighWater}`);
    }
  }
  const closed = bus.records('link.schedule.v1.closure').map((r) => decodeClosure(r.value as Uint8Array))
    .flatMap((x) => (x.type === 'closed' && hex(x.m.link) === hex(X) ? [x.m.feedSeq] : []));
  assert.equal(closed.at(-1), 4n, 'CLOSED of the moved link names its last stream_seq, written in B');
  const ySeqs = store.outbox.filter((o) => hex(o.partition) === hex(Y)).map((o) => o.streamSeq);
  assert.deepEqual(ySeqs, [1n, 2n], 'nothing of the stopped link reached the outbox');
});

test('C01 CP-9 across a move: a gap is filled within gap_timeout from the outbox by partition, across the slots the partition lived in; stream_seq and the generation header continue', T, async () => {
  const bus = new MemoryBus();
  await bus.ensureTopic('link.schedule.v1', 4);
  const store = new MemoryStore();
  store.seedSlots('link', 5);
  const publishers: MemoryPublisher[] = [];
  const c = cluster(FEED, store, { publisher: () => { const p = new MemoryPublisher(); publishers.push(p); return p; } });
  const a = await c.make([0, 1, 2, 3]);
  const b = await c.make([4]);
  const X = utf8('L-gap');
  const SX = slotOfPartition(X, 4);
  const got: FeedEvent[] = [];
  const consumer = new FeedConsumerRuntime({ bus, groupId: 'acct', sealer: new DevSealer(), gapFill: new MemoryGapFill({ link: store }), gapTimeoutMs: 80 });
  closers.add(() => consumer.stop());
  consumer.subscribe('link.schedule.v1', { positions: [] }, 'committed', async (e) => { got.push(e); });
  await consumer.ready();
  for (let i = 0; i < 2; i++) assert.equal((await a.append({ partition: X, entries: [feedEntry(`a${i}`)] })).r, 'Committed');
  await c.coordinator.move({ kind: 'link', partition: X, from: SX, to: 4 });
  for (let i = 0; i < 2; i++) assert.equal((await b.append({ partition: X, entries: [feedEntry(`b${i}`)] })).r, 'Committed');
  // Only B's last direct publish reaches the bus: seq 1 to 3 (two of them written in A) are a gap.
  const four = (publishers[1] as MemoryPublisher).sent.filter((m) => m.headers['stream_seq'] === '4');
  assert.equal(four.length, 1);
  await bus.produce('link.schedule.v1', four.map((m) => ({ key: m.key, value: m.value, headers: m.headers as Record<string, string | Uint8Array> })));
  await until(() => got.length === 4, 5_000, 'gap filled');
  assert.deepEqual(got.map((e) => [e.headers.stream_seq, e.headers.generation]), [['1', '0'], ['2', '0'], ['3', '1'], ['4', '1']]);
  const slots = store.outbox.filter((o) => hex(o.partition) === hex(X)).map((o) => o.slot);
  assert.deepEqual(slots, [SX, SX, 4, 4], 'the rows stay where they were written; nothing is re-keyed');
});
