/**
 * I1b feeds on the in-memory store and bus: the relay (re-keying, delete drop, progress), the closure
 * emitter (CP-8: R_min hold-back, never back, markers never precede their rows, partition-count increase),
 * and the consumer runtime (CP-9 without moves: duplicates, gap fill, reported gate, content conflict).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EntryInput, FeedEvent, HlcTs, OwnerDeclaration, OwnerHooks } from '../src/index.ts';
import {
  ClosureEmitter, CockroachOwnerRuntime, FeedConsumerRuntime, ManualLoad, MemoryPublisher, OutboxRelay, compareHlc, decodeClosure,
  encodeJson, feedEventDigest, hex, hlc, parseCdcMessage, partitionForKey, utf8, DevSealer,
} from '../src/index.ts';
import { MemoryBus, MemoryChangefeed, MemoryGapFill, MemoryStore, memoryFeedSeqReader } from '../testing/index.ts';

const DECL: OwnerDeclaration = {
  kind: 'link', slotCount: 4,
  entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }],
  projections: [],
  streams: [
    { name: 'schedule', topic: 'link.schedule.v1', key: 'partition', emitFn: { version: 1 }, closure: 'closedPerLink', consumers: ['account'] },
    { name: 'life', topic: 'link.life.v1', key: 'partition', emitFn: { version: 1 }, closure: 'resolved', consumers: ['account'] },
  ],
};
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const entry = (id: string, stream = 'schedule'): EntryInput => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id }, emits: [{ stream, event: { id } }] });
const FAST = { sessionTtlMs: 300, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 280, maxLoopDelayMs: 20 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hooks = (): OwnerHooks => ({ async onAcquire() {}, onRelease() {}, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {} });

async function until(f: () => boolean | Promise<boolean>, ms = 3_000, what = f.toString()): Promise<void> {
  const end = Date.now() + ms;
  while (!(await f())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(10); }
}

async function producer(bus: MemoryBus, cdcPartitions = 2, publisher = new MemoryPublisher()) {
  const store = new MemoryStore();
  store.seedSlots('link', 4);
  store.seedSlots('closure_link', 1);
  const feed = new MemoryChangefeed(store, bus, 'link', cdcPartitions);
  await bus.ensureTopic('link.schedule.v1', 4);
  await bus.ensureTopic('link.life.v1', 4);
  const rt = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], publisher, load: new ManualLoad(), testing: { sessionTimings: FAST } });
  await rt.start(hooks());
  return { store, feed, rt, publisher };
}

test('relay: parses CockroachDB JSON exactly (DECIMAL ts digits kept), re-keys rows, drops deletes, writes progress after its rows', async () => {
  const m = parseCdcMessage(utf8('{"after": {"slot": 1, "partition": "\\\\x0102", "stream": "s", "stream_seq": 9007199254740993, "n": 0, "topic": "link.schedule.v1", "msg_key": "\\\\x0102", "headers": "\\\\x7b7d", "payload": "\\\\x00", "ts": 1791871402988494933.0000000001, "generation": 0, "epoch": 3}, "updated": "1"}'));
  assert.equal(m?.type, 'row');
  if (m?.type === 'row') { assert.equal(m.row.ts, '1791871402988494933.0000000001'); assert.equal(m.row.streamSeq, 9007199254740993n); assert.equal(hex(m.row.partition), '0102'); }
  assert.deepEqual(parseCdcMessage(null), { type: 'delete' });

  const bus = new MemoryBus();
  const { feed, rt } = await producer(bus);
  const relay = new OutboxRelay({ bus, kind: 'link' });
  await relay.start();
  const P = utf8('L1');
  for (let i = 0; i < 3; i++) assert.equal((await rt.append({ partition: P, entries: [entry(`a${i}`)] })).r, 'Committed');
  await feed.writeDelete();
  const R = await feed.resolve();
  await until(() => relay.stats.progress >= 2);
  const recs = bus.records('link.schedule.v1');
  assert.equal(recs.length, 3);
  assert.ok(recs.every((r) => r.partition === partitionForKey(P, 4)), 'keyed by the producing partition');
  assert.deepEqual(recs.map((r) => Buffer.from(r.headers['stream_seq'] ?? []).toString()), ['1', '2', '3']);
  assert.ok(recs.every((r) => r.headers['outcome_id'] === undefined));
  assert.equal(hex(recs[0]?.headers['partition'] ?? new Uint8Array()), hex(P), 'partition header as raw bytes');
  assert.equal(relay.stats.deletesDropped, 1);
  const prog = bus.records('relay.progress.link');
  assert.equal(prog.length, 2);
  assert.ok(prog.every((p) => (p.value ? Buffer.from(p.value).toString().includes(String(R)) : false)));
  // Progress of a cdc partition comes after every row of that partition: rows were produced before it.
  assert.ok(bus.committedOffset('link-relay', 'cdc.link', 0) !== undefined || bus.committedOffset('link-relay', 'cdc.link', 1) !== undefined);
  await relay.stop(); await rt.stop();
});

test('CP-8: R_min over every cdc partition; a partition with no progress holds it back; never back; markers never precede their rows', async () => {
  const bus = new MemoryBus();
  const { store, feed, rt } = await producer(bus, 2);
  const relay = new OutboxRelay({ bus, kind: 'link' });
  await relay.start();
  const emitter = new ClosureEmitter({ bus, declaration: DECL, store, feedSeqs: memoryFeedSeqReader(store), pollMs: 10, heartbeatMs: 60_000, sessionTimings: FAST });
  await emitter.start();
  const links = ['L1', 'L2', 'L3'].map(utf8);
  for (const l of links) for (let i = 0; i < 2; i++) await rt.append({ partition: l, entries: [entry(`${hex(l)}-${i}`), entry(`${hex(l)}-x${i}`, 'life')] });
  // Only cdc partition 0 resolves: R_min is held back.
  await feed.resolve(undefined, [0]);
  await until(() => relay.stats.progress >= 1);
  await sleep(60);
  assert.equal(emitter.rMin(), undefined, 'cdc partition 1 has no progress');
  const R1 = await feed.resolve();
  await until(() => emitter.rMin() === R1);
  // A cdc partition added with no progress holds R_min where it is (it never goes back).
  bus.addPartitions('cdc.link', 3);
  await rt.append({ partition: links[0] as Uint8Array, entries: [entry('late')] });
  await feed.resolve(undefined, [0, 1]);
  await sleep(80);
  assert.equal(emitter.rMin(), R1, 'held back by the new partition, not moved back');
  const R2 = await feed.resolve();
  await until(() => emitter.rMin() === R2);
  assert.equal(compareHlc(R2 as HlcTs, R1 as HlcTs), 1);
  // Invariant: for every marker, every data row with ts ≤ its position lies below dataHighWater.
  for (const m of emitter.emitted) {
    const data = m.topic.replace(/\.closure$/, '');
    for (const r of bus.records(data, m.partition)) {
      const ts = hlc(Buffer.from(r.headers['ts'] ?? []).toString());
      if (compareHlc(ts, m.resolved) <= 0) assert.ok(r.offset < m.dataHighWater, `${data}/${m.partition}@${r.offset} ts ≤ ${m.resolved} is below ${m.dataHighWater}`);
    }
  }
  const closed = bus.records('link.schedule.v1.closure').map((r) => decodeClosure(r.value as Uint8Array));
  assert.ok(closed.some((c) => c.type === 'closed' && hex(c.m.link) === hex(links[0] as Uint8Array) && c.m.feedSeq === 3n), 'CLOSED(t, feed_seq) after the late row');
  assert.ok(closed.every((c) => c.type === 'closed' && c.m.emitterEpoch === emitter.emitterEpoch()));
  const resolved = bus.records('link.life.v1.closure').map((r) => decodeClosure(r.value as Uint8Array));
  assert.equal(new Set(resolved.map((c) => c.m.destinationPartition)).size, 4, 'one ResolvedMarker per destination partition');
  // A partition-count increase of the data topic: markers name the new count.
  bus.addPartitions('link.life.v1', 8);
  await rt.append({ partition: links[1] as Uint8Array, entries: [entry('grow', 'life')] });
  const R3 = await feed.resolve();
  await until(() => emitter.rMin() === R3);
  const after = bus.records('link.life.v1.closure').map((r) => decodeClosure(r.value as Uint8Array)).filter((c) => c.type === 'resolved' && c.m.resolved === R3);
  assert.equal(after.length, 8);
  assert.ok(after.every((c) => c.m.partitionCount === 8));
  await emitter.stop(); await relay.stop(); await rt.stop();
});

test('closure emitter: a new holder writes every link once; the heartbeat repeats every link', async () => {
  const bus = new MemoryBus();
  const { store, feed, rt } = await producer(bus, 1);
  const relay = new OutboxRelay({ bus, kind: 'link' });
  await relay.start();
  for (const l of ['A', 'B']) await rt.append({ partition: utf8(l), entries: [entry(l)] });
  await feed.resolve();
  const emitter = new ClosureEmitter({ bus, declaration: DECL, store, feedSeqs: memoryFeedSeqReader(store), pollMs: 10, heartbeatMs: 100, sessionTimings: FAST });
  await emitter.start();
  await until(() => emitter.emitted.filter((e) => e.link).length >= 2);
  await until(() => emitter.emitted.filter((e) => e.link).length >= 4, 2_000);   // heartbeat
  await emitter.stop(); await relay.stop(); await rt.stop();
});

// ---------------- consumer runtime ----------------

function ev(partition: string, seq: number, value = `v${seq}`, extra: Record<string, string> = {}): { key: Uint8Array; value: Uint8Array; headers: Record<string, string | Uint8Array> } {
  return {
    key: utf8(partition), value: utf8(value),
    headers: { partition: utf8(partition), stream: 's', stream_seq: String(seq), generation: '0', epoch: '1', ts: hlc(`${1_000 + seq}`), kind: '1', schema_v: '1', key_id: '00', ...extra },
  };
}

async function consumer(bus: MemoryBus, gapFill?: MemoryGapFill, gate: 'committed' | 'reported' = 'committed', from = 0n) {
  const got: FeedEvent[] = [];
  const alerts: unknown[] = [];
  const c = new FeedConsumerRuntime({ bus, groupId: 'acct', sealer: new DevSealer(), gapTimeoutMs: 50, retryMs: 20, alert: (a) => alerts.push(a), ...(gapFill ? { gapFill } : {}) });
  c.subscribe('link.schedule.v1', { positions: from > 0n ? [{ partition: utf8('L'), stream: 's', streamSeq: from }] : [] }, gate, async (e) => { got.push(e); });
  await c.ready();
  return { c, got, alerts, seqs: () => got.map((e) => Number(e.headers.stream_seq)) };
}

test('CP-9: stream_seq order with buffering; duplicates across paths dropped; lower ones dropped', async () => {
  const bus = new MemoryBus();
  await bus.ensureTopic('link.schedule.v1', 2);
  const { c, seqs } = await consumer(bus);
  await bus.produce('link.schedule.v1', [ev('L', 2), ev('L', 1), ev('L', 1), ev('L', 3), ev('L', 2), ev('L', 3)]);
  await until(() => seqs().length >= 3);
  await sleep(30);
  assert.deepEqual(seqs(), [1, 2, 3]);
  await c.stop();
});

test('CP-9: a gap is filled from the outbox after gap_timeout', async () => {
  const bus = new MemoryBus();
  const { store, rt, publisher } = await producer(bus, 1);
  const gf = new MemoryGapFill({ link: store });
  const got: number[] = [];
  const c = new FeedConsumerRuntime({ bus, groupId: 'acct', sealer: new DevSealer(), gapFill: gf, gapTimeoutMs: 80 });
  c.subscribe('link.schedule.v1', { positions: [] }, 'committed', async (e) => { got.push(Number(e.headers.stream_seq)); });
  await c.ready();
  const P = utf8('L9');
  for (let i = 0; i < 4; i++) await rt.append({ partition: P, entries: [entry(`g${i}`)] });
  // Direct publish only of seq 4: 1–3 are missing from the bus.
  const four = publisher.sent.filter((m) => m.headers['stream_seq'] === '4');
  await bus.produce('link.schedule.v1', four.map((m) => ({ key: m.key, value: m.value, headers: m.headers as Record<string, string | Uint8Array> })));
  await sleep(30);
  assert.deepEqual(got, [], 'waits for the gap');
  await until(() => got.length === 4);
  assert.deepEqual(got, [1, 2, 3, 4]);
  assert.ok(gf.reads >= 1);
  await c.stop(); await rt.stop();
});

test('CP-9: reported gate holds an outcome until a covering marker of its slot; lower markers ignored by the gate', async () => {
  const bus = new MemoryBus();
  await bus.ensureTopic('link.schedule.v1', 1);
  const { c, seqs } = await consumer(bus, undefined, 'reported');
  const marker = (pos: string, epoch = '1') => ({ key: utf8('slot'), value: utf8('m'), headers: { partition: new Uint8Array(), stream: 's', stream_seq: '1', generation: '0', epoch, ts: hlc(pos), kind: '0', schema_v: '1', key_id: '00', slot: '2', report_through: hlc(pos) } });
  await bus.produce('link.schedule.v1', [ev('L', 1, 'v1', { slot: '2' }), ev('L', 2, 'v2', { slot: '2' })]);
  await sleep(40);
  assert.deepEqual(seqs(), []);
  await bus.produce('link.schedule.v1', [marker('1001')]);
  await until(() => seqs().length === 1);
  await bus.produce('link.schedule.v1', [marker('1000')]);     // lower: ignored by the gate
  await sleep(30);
  assert.deepEqual(seqs(), [1]);
  await bus.produce('link.schedule.v1', [marker('1002')]);
  await until(() => seqs().length === 2);
  await c.stop();
});

test('CP-9 (D3): a forged copy before application ⇒ the database copy wins; FEED_CONTENT_CONFLICT; after application ⇒ compared with the database', async () => {
  const bus = new MemoryBus();
  const { store, rt, publisher } = await producer(bus, 1);
  const P = utf8('LF');
  for (let i = 0; i < 3; i++) await rt.append({ partition: P, entries: [entry(`f${i}`)] });
  const real = (seq: string) => publisher.sent.filter((m) => m.headers['stream_seq'] === seq && m.topic === 'link.schedule.v1')
    .map((m) => ({ key: m.key, value: m.value, headers: m.headers as Record<string, string | Uint8Array> }));
  const forged = (seq: string) => real(seq).map((r) => ({ ...r, value: utf8('forged') }));
  const gf = new MemoryGapFill({ link: store });
  const got: FeedEvent[] = [];
  const alerts: unknown[] = [];
  const c = new FeedConsumerRuntime({ bus, groupId: 'acct', sealer: new DevSealer(), gapFill: gf, gapTimeoutMs: 10_000, retryMs: 20, alert: (a) => alerts.push(a) });
  c.subscribe('link.schedule.v1', { positions: [] }, 'committed', async (e) => { got.push(e); });
  await c.ready();
  // Before application: seq 2 arrives forged and real while seq 1 is missing (both buffered).
  await bus.produce('link.schedule.v1', [...forged('2'), ...real('2')]);
  await sleep(30);
  assert.equal(alerts.length, 1);
  await bus.produce('link.schedule.v1', real('1'));
  await until(() => got.length === 2);
  const dbDigest = feedEventDigest(store.outbox.find((o) => o.streamSeq === 2n && hex(o.partition) === hex(P))?.payload as Uint8Array);
  assert.equal(feedEventDigest(got[1] as FeedEvent), dbDigest, 'only the database copy is applied');
  // After application, a late forged copy of an applied event: the applied copy was the database's ⇒ continue.
  await bus.produce('link.schedule.v1', forged('1'));
  await sleep(30);
  assert.equal(alerts.length, 2);
  await bus.produce('link.schedule.v1', real('3'));
  await until(() => got.length === 3);
  await c.stop();

  // A forged copy applied first (no other copy buffered), the real one arrives later ⇒ the stream stays blocked.
  const bus2 = new MemoryBus();
  await bus2.ensureTopic('link.schedule.v1', 1);
  const got2: FeedEvent[] = [];
  const c2 = new FeedConsumerRuntime({ bus: bus2, groupId: 'acct', sealer: new DevSealer(), gapFill: gf, gapTimeoutMs: 10_000, retryMs: 20 });
  c2.subscribe('link.schedule.v1', { positions: [] }, 'committed', async (e) => { got2.push(e); });
  await c2.ready();
  await bus2.produce('link.schedule.v1', [...forged('1'), ...real('1'), ...real('2')]);
  await sleep(60);
  assert.equal(got2.length, 1);
  assert.ok(c2.subscription('link.schedule.v1')?.isBlocked(P, 'schedule'), 'blocked: the applied copy is not the database copy');
  await c2.stop(); await rt.stop();
});

test('consumer offsets: committed only below the first undelivered record (restart loses nothing)', async () => {
  const bus = new MemoryBus();
  await bus.ensureTopic('link.schedule.v1', 1);
  const a = await consumer(bus);
  await bus.produce('link.schedule.v1', [ev('L', 1), ev('L', 3)]);     // 3 waits for 2 (no gap fill)
  await until(() => a.seqs().length === 1);
  await sleep(120);
  await a.c.stop();
  assert.equal(bus.committedOffset('acct.link.schedule.v1', 'link.schedule.v1', 0), 1n, 'offset of seq 3 not committed');
  await bus.produce('link.schedule.v1', [ev('L', 2)]);
  const b = await consumer(bus, undefined, 'committed', 1n);
  await until(() => b.seqs().length === 2);
  assert.deepEqual(b.seqs(), [2, 3]);
  await b.c.stop();
});

test('onResolved fires after the position passes dataHighWater and buffered rows ≤ R are delivered; onMarker keeps every marker', async () => {
  const bus = new MemoryBus();
  await bus.ensureTopic('link.schedule.v1', 1);
  await bus.ensureTopic('link.schedule.v1.closure', 1);
  const fired: Array<[number, string]> = [];
  const { c, seqs } = await consumer(bus);
  c.onResolved('link.schedule.v1', (d, R) => fired.push([d, R]));
  await c.ready();
  await bus.produce('link.schedule.v1', [ev('L', 2)]);       // ts 1002, buffered (gap)
  await bus.produce('link.schedule.v1.closure', [{ key: null, partition: 0, value: encodeJson({ type: 'resolved', m: { dataTopic: 'link.schedule.v1', partitionCount: 1, destinationPartition: 0, resolved: hlc('1005'), dataHighWater: 1n, emitterEpoch: 1n } }) }]);
  await sleep(40);
  assert.deepEqual(fired, [], 'seq 2 (ts ≤ R) is still buffered');
  await bus.produce('link.schedule.v1', [ev('L', 1)]);
  await until(() => fired.length === 1);
  assert.deepEqual(seqs(), [1, 2]);
  await c.stop();

  // onMarker: every marker, in any order, duplicates dropped by (slot, epoch, reportPosition, part).
  const sealer = new DevSealer();
  const { markerSealContext, encodeMarker } = await import('../src/index.ts');
  const bus2 = new MemoryBus();
  await bus2.ensureTopic('account.outcome.v1', 1);
  const mk = (pos: string, part: number, seq: number) => {
    const m = { slot: 3, generation: 0 as const, epoch: 2n, reportPosition: hlc(pos), prevReportPosition: null, pendingAnswered: [utf8(`q${pos}`)], chunk: { part, last: true } };
    return { key: utf8('3'), value: sealer.seal(encodeMarker(m), markerSealContext('account', 3, 'outcome', BigInt(seq), 2n)),
      headers: { partition: new Uint8Array(), stream: 'outcome', stream_seq: String(seq), generation: '0', epoch: '2', ts: hlc(pos), kind: '0', schema_v: '1', key_id: '00', slot: '3', report_through: hlc(pos) } };
  };
  const seen: string[] = [];
  const c2 = new FeedConsumerRuntime({ bus: bus2, groupId: 'notifier', sealer });
  c2.onMarker('account.outcome.v1', async (m) => { seen.push(`${m.reportPosition}:${Buffer.from(m.pendingAnswered[0] ?? []).toString()}`); });
  await c2.ready();
  await bus2.produce('account.outcome.v1', [mk('20', 0, 2), mk('10', 0, 1), mk('20', 0, 2), mk('10', 0, 1)]);
  await until(() => seen.length === 2);
  await sleep(30);
  assert.deepEqual(seen.map((s) => s.split(':')[1]), ['q20', 'q10'], 'a lower marker after a later one is still given (N-01)');
  await c2.stop();
});
