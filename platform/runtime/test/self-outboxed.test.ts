/**
 * S-PLAT-I2 work item 3: a self-outboxed kind (RFC-006 §3.5; C01 §2.2, §2.3, R47-19) with three streams, as
 * RFC-003's `ingest_log`. No outbox; the stream index is written in the batch; the relay reads the log
 * changefeed and derives events by the emit functions; gap fill reads the log through the stream index.
 * Exit criterion (4): CP-8 and CP-9 (the clauses of I1) on this kind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EmitFunctions, EntryInput, FeedEvent, HlcTs, OwnerDeclaration, OwnerHooks } from '../src/index.ts';
import {
  ClosureEmitter, CockroachOwnerRuntime, DevSealer, FeedConsumerRuntime, LogDerivedGapFill, ManualLoad, MemoryPublisher, OutboxRelay,
  compareHlc, decodeClosure, feedEventDigest, hex, hlc, parseCdcLogMessage, utf8,
} from '../src/index.ts';
import { MemoryBus, MemoryChangefeed, MemoryStore, memoryFeedSeqReader, memoryStreamIndex } from '../testing/index.ts';

const DECL: OwnerDeclaration = {
  kind: 'ingx', slotCount: 4, selfOutboxed: true,
  entryKinds: [{ kind: 1, name: 'row', schemaVersions: [1], retention: '7y' }],
  projections: [],
  streams: [
    { name: 'handoff', topic: 'ingx.handoff.v1', key: 'partition', emitFn: { version: 1 }, closure: 'resolved', consumers: ['attr'] },
    { name: 'drop_alert', topic: 'ingx.alert.v1', key: 'partition', emitFn: { version: 1 }, closure: 'none', consumers: [] },
    { name: 'drop_report', topic: 'ingx.alert.v1', key: 'partition', emitFn: { version: 2 }, closure: 'none', consumers: [] },
  ],
};
type Row = { type: 'batch' | 'drop' | 'report'; id: string };
const asRow = (p: unknown): Row => p as Row;
const EMIT: EmitFunctions = {
  handoff: { 1: (e) => (asRow(e.payload).type === 'batch' ? [{ batch: asRow(e.payload).id, seq: e.seq.toString() }] : []) },
  drop_alert: { 1: (e) => (asRow(e.payload).type === 'drop' ? [{ dropped: asRow(e.payload).id }] : []) },
  // Version 1 of drop_report is kept (7 years, C01 §2.2); the declaration uses version 2.
  drop_report: { 1: () => [{ old: true }], 2: (e) => (asRow(e.payload).type === 'report' ? [{ report: asRow(e.payload).id }] : []) },
};
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const STREAM_OF = { batch: 'handoff', drop: 'drop_alert', report: 'drop_report' } as const;
/** An entry whose declared event is the one its emit function derives (seq is the entry's log seq). */
function entry(type: Row['type'], id: string, seq: number): EntryInput {
  const event = type === 'batch' ? { batch: id, seq: String(seq) } : type === 'drop' ? { dropped: id } : { report: id };
  return { kind: 1, schemaV: 1, identity: utf8(`${type}-${id}`), audit: AUDIT, payload: { type, id }, emits: [{ stream: STREAM_OF[type], event }] };
}
const FAST = { sessionTimings: { sessionTtlMs: 300, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 280, maxLoopDelayMs: 20 } };
const hooks = (): OwnerHooks => ({ async onAcquire() {}, onRelease() {}, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {} });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, ms = 3_000, what = f.toString()): Promise<void> {
  const end = Date.now() + ms;
  while (!(await f())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(10); }
}

async function producer(bus: MemoryBus, cdcPartitions = 2) {
  const store = new MemoryStore();
  store.seedSlots(DECL.kind, 4);
  store.seedSlots(`closure_${DECL.kind}`, 1);
  const feed = new MemoryChangefeed(store, bus, DECL.kind, cdcPartitions, 'log');
  await bus.ensureTopic('ingx.handoff.v1', 4);
  await bus.ensureTopic('ingx.alert.v1', 2);
  const publisher = new MemoryPublisher();
  const sealer = new DevSealer();
  const rt = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], publisher, sealer, load: new ManualLoad(), emitFns: EMIT, testing: FAST });
  await rt.start(hooks());
  const derive = { declaration: DECL, sealer, emitFns: EMIT };
  return { store, feed, rt, publisher, derive };
}

const P = utf8('exporter-1');

test('should write no outbox row and one stream index row per event, and direct publish the derived event, when the kind is self-outboxed', async () => {
  const bus = new MemoryBus();
  const { store, rt, publisher } = await producer(bus);
  const r = await rt.append({ partition: P, entries: [entry('batch', 'b1', 1), entry('drop', 'd1', 2), entry('report', 'r1', 3)] });
  assert.equal(r.r, 'Committed');
  assert.equal(store.outbox.length, 0, 'no outbox row');
  assert.deepEqual(store.streamIndex.map((x) => [x.stream, x.streamSeq, x.seq]), [['handoff', 1n, 1n], ['drop_alert', 1n, 2n], ['drop_report', 1n, 3n]]);
  assert.deepEqual(publisher.sent.map((m) => [m.topic, m.headers['stream'], m.headers['stream_seq']]),
    [['ingx.handoff.v1', 'handoff', '1'], ['ingx.alert.v1', 'drop_alert', '1'], ['ingx.alert.v1', 'drop_report', '1']]);
  await rt.stop();
});

test('should answer the call with an error and write nothing when an entry declares an event its emit function does not derive', async () => {
  const bus = new MemoryBus();
  const { store, rt } = await producer(bus);
  const wrong: EntryInput = { ...entry('batch', 'b1', 1), emits: [{ stream: 'handoff', event: { batch: 'other', seq: '1' } }] };
  await assert.rejects(rt.append({ partition: P, entries: [wrong] }), /not what emit function version 1 derives/);
  const missing: EntryInput = { ...entry('drop', 'd1', 1), emits: [] };
  await assert.rejects(rt.append({ partition: P, entries: [missing] }), /declares no event of stream drop_alert/);
  const note: EntryInput = { ...entry('drop', 'd2', 1) };
  await assert.rejects(rt.append({ partition: P, entries: [note], notifications: [{ to: { kind: 'x', partition: P }, id: { subject: P, attempt: 1, kind: 'n' }, body: {} }] }),
    /no outbox for notifications/);
  assert.equal(store.log.length, 0);
  assert.equal(store.streamIndex.length, 0);
  // A later correct call still commits at seq 1: nothing of the refused calls was written.
  const ok = await rt.append({ partition: P, entries: [entry('batch', 'b1', 1)] });
  assert.equal(ok.r === 'Committed' && ok.seqFrom, 1n);
  await rt.stop();
});

test('should refuse to construct a self-outboxed runtime when a stream has no emit function of its declared version', () => {
  const store = new MemoryStore();
  const noV2: EmitFunctions = { ...EMIT, drop_report: { 1: () => [] } };
  assert.throws(() => new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0], load: new ManualLoad(), emitFns: noV2 }),
    /stream drop_report: no emit function version 2/);
  assert.throws(() => new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0], load: new ManualLoad() }), /stream handoff: no emit function version 1/);
  assert.throws(() => new CockroachOwnerRuntime({ declaration: { ...DECL, statusReaders: true }, store, slots: [0], load: new ManualLoad(), emitFns: EMIT }),
    /no report markers/);
});

test('C01 CP-9 self-outboxed: the relay derives byte-identical copies of the direct publish from the log; duplicates are dropped; three streams each in stream_seq order', async () => {
  const bus = new MemoryBus();
  const { feed, rt, publisher, derive } = await producer(bus);
  const relay = new OutboxRelay({ bus, kind: DECL.kind, derive });
  await relay.start();
  for (let i = 0; i < 3; i++) {
    const r = await rt.append({ partition: P, entries: [entry('batch', `b${i}`, 3 * i + 1), entry('drop', `d${i}`, 3 * i + 2), entry('report', `r${i}`, 3 * i + 3)] });
    assert.equal(r.r, 'Committed');
  }
  await feed.writeDelete();
  await feed.resolve();
  await until(() => relay.stats.rows === 9 && relay.stats.progress >= 2);
  assert.equal(relay.stats.deletesDropped, 1, 'a truncator delete is not an event');
  // Every relay record equals the direct-published record of the same (partition, stream, stream_seq), byte for byte.
  const relayed = [...bus.records('ingx.handoff.v1'), ...bus.records('ingx.alert.v1')];
  assert.equal(relayed.length, 9);
  for (const r of relayed) {
    const stream = Buffer.from(r.headers['stream'] ?? []).toString();
    const seq = Buffer.from(r.headers['stream_seq'] ?? []).toString();
    const direct = publisher.sent.find((m) => m.headers['stream'] === stream && m.headers['stream_seq'] === seq);
    assert.ok(direct, `direct copy of ${stream}/${seq}`);
    assert.equal(hex(r.value ?? new Uint8Array()), hex(direct.value), `${stream}/${seq} payload byte-identical`);
    assert.equal(hex(r.key ?? new Uint8Array()), hex(direct.key));
    for (const k of ['ts', 'epoch', 'generation', 'kind', 'schema_v', 'key_id']) {
      assert.equal(Buffer.from(r.headers[k] ?? []).toString(), String(direct.headers[k]), `header ${k}`);
    }
  }
  // A consumer gets each event once, in stream_seq order, with the direct copies arriving again as duplicates.
  const got: FeedEvent[] = [];
  const c = new FeedConsumerRuntime({ bus, groupId: 'attr', sealer: new DevSealer(), gapTimeoutMs: 10_000, retryMs: 20 });
  c.subscribe('ingx.alert.v1', { positions: [] }, 'committed', async (e) => { got.push(e); });
  await c.ready();
  await bus.produce('ingx.alert.v1', publisher.sent.filter((m) => m.topic === 'ingx.alert.v1')
    .map((m) => ({ key: m.key, value: m.value, headers: m.headers as Record<string, string | Uint8Array> })));
  await until(() => got.length >= 6);
  await sleep(30);
  assert.equal(got.length, 6, 'duplicates across the direct and relay paths are dropped');
  for (const s of ['drop_alert', 'drop_report']) assert.deepEqual(got.filter((e) => e.headers.stream === s).map((e) => e.headers.stream_seq), ['1', '2', '3']);
  await c.stop(); await relay.stop(); await rt.stop();
});

test('C01 CP-9 self-outboxed: a gap is filled through the stream index after gap_timeout; a forged copy loses to the event derived from the log (D3)', async () => {
  const bus = new MemoryBus();
  await bus.ensureTopic('ingx.handoff.v1', 4);
  const { store, rt, publisher, derive } = await producer(bus, 1);
  const gf = new LogDerivedGapFill(memoryStreamIndex(store), [derive]);
  const got: FeedEvent[] = [];
  const alerts: unknown[] = [];
  const c = new FeedConsumerRuntime({ bus, groupId: 'attr', sealer: new DevSealer(), gapFill: gf, gapTimeoutMs: 60, retryMs: 20, alert: (a) => alerts.push(a) });
  c.subscribe('ingx.handoff.v1', { positions: [] }, 'committed', async (e) => { got.push(e); });
  await c.ready();
  for (let i = 0; i < 4; i++) assert.equal((await rt.append({ partition: P, entries: [entry('batch', `g${i}`, i + 1)] })).r, 'Committed');
  const copy = (seq: string, value?: Uint8Array) => publisher.sent.filter((m) => m.headers['stream_seq'] === seq && m.topic === 'ingx.handoff.v1')
    .map((m) => ({ key: m.key, value: value ?? m.value, headers: m.headers as Record<string, string | Uint8Array> }));
  // Only seq 4 reaches the bus, and seq 2 arrives forged: seq 1–3 come from the log through the stream index.
  await bus.produce('ingx.handoff.v1', [...copy('2', utf8('forged')), ...copy('4')]);
  await sleep(20);
  assert.equal(got.length, 0, 'waits for the gap');
  await until(() => got.length === 4);
  assert.deepEqual(got.map((e) => e.headers.stream_seq), ['1', '2', '3', '4']);
  assert.ok(gf.reads >= 1);
  assert.equal(feedEventDigest(got[1] as FeedEvent), feedEventDigest(copy('2')[0]?.value as Uint8Array), 'the database copy of seq 2 is applied, not the forged one');
  assert.equal(alerts.length, 1, 'FEED_CONTENT_CONFLICT for the forged copy');
  await c.stop(); await rt.stop();
});

test('C01 CP-8 self-outboxed: R_min over every cdc partition of the log changefeed; a partition with no progress holds it back; markers never precede their rows', async () => {
  const bus = new MemoryBus();
  const { store, feed, rt, derive } = await producer(bus, 2);
  const relay = new OutboxRelay({ bus, kind: DECL.kind, derive });
  await relay.start();
  const emitter = new ClosureEmitter({ bus, declaration: DECL, store, feedSeqs: memoryFeedSeqReader(store), pollMs: 10, heartbeatMs: 60_000, sessionTimings: FAST.sessionTimings });
  await emitter.start();
  const exporters = ['E1', 'E2', 'E3'].map(utf8);
  for (const e of exporters) for (let i = 0; i < 2; i++) await rt.append({ partition: e, entries: [entry('batch', `${hex(e)}-${i}`, i + 1)] });
  await feed.resolve(undefined, [0]);
  await until(() => relay.stats.progress >= 1);
  await sleep(60);
  assert.equal(emitter.rMin(), undefined, 'cdc partition 1 has no progress');
  const R1 = await feed.resolve();
  await until(() => emitter.rMin() === R1);
  bus.addPartitions(`cdc.${DECL.kind}`, 3);
  await rt.append({ partition: exporters[0] as Uint8Array, entries: [entry('batch', 'late', 3)] });
  await feed.resolve(undefined, [0, 1]);
  await sleep(80);
  assert.equal(emitter.rMin(), R1, 'held back by the new partition, never moved back');
  const R2 = await feed.resolve();
  await until(() => emitter.rMin() === R2);
  assert.equal(compareHlc(R2 as HlcTs, R1 as HlcTs), 1);
  assert.ok(emitter.emitted.length > 0);
  for (const m of emitter.emitted) {
    for (const r of bus.records('ingx.handoff.v1', m.partition)) {
      const ts = hlc(Buffer.from(r.headers['ts'] ?? []).toString());
      if (compareHlc(ts, m.resolved) <= 0) assert.ok(r.offset < m.dataHighWater, `row at ${r.offset} with ts ≤ ${m.resolved} is below ${m.dataHighWater}`);
    }
  }
  const markers = bus.records('ingx.handoff.v1.closure').map((r) => decodeClosure(r.value as Uint8Array));
  assert.equal(new Set(markers.filter((x) => x.type === 'resolved' && x.m.resolved === R2).map((x) => x.m.destinationPartition)).size, 4);
  assert.equal(bus.records('ingx.alert.v1.closure').length, 0, 'no closure on streams declared closure none');
  await emitter.stop(); await relay.stop(); await rt.stop();
});

test('should parse a log changefeed row exactly (DECIMAL ts digits and INT8 kept) when the relay reads a self-outboxed kind', () => {
  const m = parseCdcLogMessage(utf8('{"after": {"slot": 2, "partition": "\\\\x0102", "seq": 9007199254740993, "generation": 0, "epoch": 3, "kind": 1, "schema_v": 1, "ts": 1791871402988494933.0000000001, "identity": "\\\\x01", "emits": "\\\\x5b5d", "audit": "\\\\x02", "retention": 0, "key_id": "\\\\x03", "payload": "\\\\x04", "chain": "\\\\x05"}, "updated": "1"}'));
  assert.equal(m?.type, 'log');
  if (m?.type === 'log') {
    assert.equal(m.row.seq, 9007199254740993n);
    assert.equal(m.row.ts, '1791871402988494933.0000000001');
    assert.equal(hex(m.row.partition), '0102');
    assert.equal(hex(m.row.chain), '05');
  }
  assert.deepEqual(parseCdcLogMessage(null), { type: 'delete' });
  assert.deepEqual(parseCdcLogMessage(utf8('{"after": null}')), { type: 'delete' });
  assert.deepEqual(parseCdcLogMessage(utf8('{"resolved": "12.0000000000"}')), { type: 'resolved', resolved: '12.0000000000' });
});
