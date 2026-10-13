/**
 * S-PLAT-I2 work item 2: the gRPC transport of the standby push (RFC-006 §4.4: "over gRPC … without waiting for an
 * acknowledgement"). One client stream per (holder process, standby process). Server and client run in this
 * process on loopback (127.0.0.1); no external service.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { HlcTs, OpenedLogRow, OwnerDeclaration, OwnerHooks, SlotNo } from '../src/index.ts';
import {
  CockroachOwnerRuntime, GrpcStandbyChannel, GrpcStandbyServer, ManualLoad, StandbyCodecError, decodeStandbyPush,
  encodeStandbyPush, hex, hlc, utf8, type StandbyChannel, type StandbyPush,
} from '../src/index.ts';
import type { LogRowWrite } from '../src/store/types.ts';
import { MemoryStore } from '../testing/index.ts';

const TIMEOUT = { timeout: 15_000 };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 5_000, what = f.toString()): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(5); }
}

const ts = (n: number): HlcTs => hlc(`${n}.0000000003`);
function row(p: string, seq: bigint, over: Partial<LogRowWrite> = {}): LogRowWrite {
  return {
    slot: 3, partition: utf8(p), seq, generation: 7, epoch: 12n, kind: 2, schemaV: 4, identity: utf8(`${p}-${seq}`),
    emits: new Uint8Array([1, 2]), audit: utf8('audit'), retention: 1, keyId: new Uint8Array([9]), payload: utf8(`pl-${p}-${seq}`),
    chain: new Uint8Array(32).fill(0xab), ...over,
  };
}
function push(n: number, rows: LogRowWrite[] = [row('A', BigInt(n))]): StandbyPush {
  return { kind: 'hlink', slot: 3, epoch: 12n, ts: ts(1_000 + n), prevTs: ts(999 + n), advances: true, rows };
}

/** A standby channel double: records every push it receives. */
function recorder(): StandbyChannel & { got: StandbyPush[] } {
  const got: StandbyPush[] = [];
  return { got, push: (p) => { got.push(p); } };
}

async function serve(channel: StandbyChannel, address = '127.0.0.1:0'): Promise<{ server: GrpcStandbyServer; port: number }> {
  const server = new GrpcStandbyServer({ channel });
  const port = await server.listen(address);
  closers.push(() => server.close());
  return { server, port };
}
function connect(port: number, maxQueued?: number): GrpcStandbyChannel {
  const ch = new GrpcStandbyChannel({ address: `127.0.0.1:${port}`, ...(maxQueued === undefined ? {} : { maxQueued }) });
  closers.push(() => ch.close());
  return ch;
}

// ---------------- the wire codec ----------------

test('should give back the same push, field for field, when a push is encoded and decoded', TIMEOUT, () => {
  const big = (1n << 64n) - 1n;
  const p: StandbyPush = {
    kind: 'hlink-ü', slot: 4_294_967_295, epoch: big, ts: hlc('1760000000123456789.0000000042'), prevTs: hlc('1760000000000000000.0000000000'),
    advances: false,
    rows: [row('A', 1n), row('B', big, { generation: 0, epoch: 0n, kind: 0, schemaV: 0, retention: 0, emits: new Uint8Array(), keyId: new Uint8Array(), payload: new Uint8Array() })],
  };
  const back = decodeStandbyPush(encodeStandbyPush(p));
  assert.deepEqual(back, p);
  assert.deepEqual(decodeStandbyPush(encodeStandbyPush({ ...p, rows: [] })), { ...p, rows: [] });
});

test('should skip a field it does not know when a push from a newer holder is decoded', TIMEOUT, () => {
  const p = push(1);
  const known = encodeStandbyPush(p);
  // field 15, wire type 2 (length-delimited), 3 bytes; field 16, wire type 0 (varint) 300.
  const extra = new Uint8Array([0x7a, 3, 1, 2, 3, 0x80, 0x01, 0xac, 0x02]);
  const both = new Uint8Array(known.byteLength + extra.byteLength);
  both.set(known, 0); both.set(extra, known.byteLength);
  assert.deepEqual(decodeStandbyPush(both), p);
});

function codeOf(f: () => unknown): string {
  try { f(); } catch (e) { if (e instanceof StandbyCodecError) return e.code; throw e; }
  return 'NO_ERROR';
}

test('should refuse with TRUNCATED when the bytes of a push end inside a field', TIMEOUT, () => {
  const b = encodeStandbyPush(push(1));
  assert.equal(codeOf(() => decodeStandbyPush(b.subarray(0, b.byteLength - 1))), 'TRUNCATED');
  assert.equal(codeOf(() => decodeStandbyPush(new Uint8Array([0x18, 0x80]))), 'TRUNCATED', 'a varint without its last byte');
});

test('should refuse with MALFORMED when a field has the wrong wire type, a varint is too long, a number is out of range, the text is not UTF-8 or a group is sent', TIMEOUT, () => {
  assert.equal(codeOf(() => decodeStandbyPush(new Uint8Array([0x08, 0x01]))), 'MALFORMED', 'kind (field 1) as a varint');
  assert.equal(codeOf(() => decodeStandbyPush(new Uint8Array([0x18, ...new Array<number>(10).fill(0xff), 0x01]))), 'MALFORMED', 'an 11-byte varint');
  assert.equal(codeOf(() => decodeStandbyPush(new Uint8Array([0x10, 0x80, 0x80, 0x80, 0x80, 0x10]))), 'MALFORMED', 'slot 2^32 does not fit uint32');
  assert.equal(codeOf(() => decodeStandbyPush(new Uint8Array([0x0a, 0x01, 0xff]))), 'MALFORMED', 'kind is not UTF-8');
  assert.equal(codeOf(() => decodeStandbyPush(new Uint8Array([0x7b]))), 'MALFORMED', 'field 15 with wire type 3 (start group)');
});

test('should refuse with BAD_TS when ts or prevTs is not an HLC timestamp', TIMEOUT, () => {
  const p = push(1);
  assert.equal(codeOf(() => decodeStandbyPush(encodeStandbyPush({ ...p, ts: 'x.1' as HlcTs }))), 'BAD_TS');
  assert.equal(codeOf(() => decodeStandbyPush(encodeStandbyPush({ ...p, prevTs: '' as HlcTs }))), 'BAD_TS');
});

// ---------------- the transport ----------------

test('should give every push to the standby channel in the order the holder pushed it when holder and standby are connected', TIMEOUT, async () => {
  const rec = recorder();
  const { port } = await serve(rec);
  const ch = connect(port);
  const sent = Array.from({ length: 50 }, (_, i) => push(i + 1, [row('A', BigInt(i + 1)), row('B', BigInt(i + 1))]));
  for (const p of sent) ch.push(p);
  await until(() => rec.got.length === 50);
  assert.deepEqual(rec.got, sent);
  assert.equal(ch.stats.sent, 50);
  assert.equal(ch.stats.dropped, 0);
  assert.equal(ch.stats.streams, 1, 'one stream per (holder, standby) pair');
});

test('should return at once and drop the pushes above the queue limit when the standby does not take them as fast as the holder pushes', TIMEOUT, async () => {
  const rec = recorder();
  const { port } = await serve(rec);
  const ch = connect(port, 8);
  const sent = Array.from({ length: 20 }, (_, i) => push(i + 1));
  for (const p of sent) ch.push(p);
  assert.equal(ch.stats.sent, 8);
  assert.equal(ch.stats.dropped, 12);
  await until(() => rec.got.length === 8);
  assert.deepEqual(rec.got, sent.slice(0, 8), 'the first 8 arrive, in order; the follower-read tail covers the rest');
  await sleep(50);
  assert.equal(rec.got.length, 8, 'no dropped push arrives later');
});

test('should not throw when the standby is down, and should push again on a new stream when the standby comes back', TIMEOUT, async () => {
  const first = recorder();
  const { server, port } = await serve(first);
  const ch = connect(port);
  ch.push(push(1));
  await until(() => first.got.length === 1);
  await server.close();
  await until(() => ch.stats.streamsFailed === 1);
  for (let i = 2; i <= 5; i++) assert.doesNotThrow(() => ch.push(push(i)));
  const second = recorder();
  await serve(second, `127.0.0.1:${port}`);
  let n = 6;
  await until(() => { ch.push(push(n++)); return second.got.length > 0; }, 10_000);
  assert.ok(ch.stats.streams >= 2, `streams ${ch.stats.streams}`);
  const seqs = second.got.map((p) => p.rows[0]?.seq ?? 0n);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'what arrives arrives in push order');
  assert.ok((seqs[0] ?? 0n) >= 6n, 'no push of the broken stream is delivered twice or late');
});

test('should drop every push after the channel is closed and give no push to the standby', TIMEOUT, async () => {
  const rec = recorder();
  const { port } = await serve(rec);
  const ch = connect(port);
  ch.push(push(1));
  await until(() => rec.got.length === 1);
  await ch.close();
  ch.push(push(2));
  assert.equal(ch.stats.dropped, 1);
  await sleep(50);
  assert.equal(rec.got.length, 1);
});

test('should keep the stream open and give the next pushes when the standby channel throws on one push', TIMEOUT, async () => {
  const got: bigint[] = [];
  const errors: string[] = [];
  const server = new GrpcStandbyServer({
    channel: { push: (p) => { const s = p.rows[0]?.seq ?? 0n; if (s === 2n) throw new Error('apply failed'); got.push(s); } },
    log: (msg) => errors.push(msg),
  });
  const port = await server.listen('127.0.0.1:0');
  closers.push(() => server.close());
  const ch = connect(port);
  for (let i = 1; i <= 3; i++) ch.push(push(i));
  await until(() => got.length === 2);
  assert.deepEqual(got, [1n, 3n]);
  assert.deepEqual(errors, ['standby push apply failed']);
  assert.equal(ch.stats.streams, 1);
  assert.equal(ch.stats.streamsFailed, 0);
});

// ---------------- the runtime over gRPC ----------------

const DECL: OwnerDeclaration = {
  kind: 'hlink', slotCount: 4,
  entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: 'ops' }],
  projections: [], streams: [],
};
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const entry = (id: string) => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id } });
const FAST = { sessionTtlMs: 300, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 280, maxLoopDelayMs: 20 };
function hooks(): OwnerHooks {
  return { async onAcquire() {}, onRelease() {}, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {} };
}

test('should keep the hot standby current from gRPC pushes alone and let it take over with no catch-up row when the holder dies', TIMEOUT, async () => {
  const store = new MemoryStore();
  store.followerLagRows = 1_000_000;
  store.seedSlots(DECL.kind, 4);
  const holder = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], load: new ManualLoad(), testing: { sessionTimings: FAST } });
  closers.push(() => holder.stop());
  await holder.start(hooks());
  const mem = new Map<string, string[]>();
  const apply = (rows: OpenedLogRow[]) => { for (const r of rows) mem.set(hex(r.partition), [...(mem.get(hex(r.partition)) ?? []), (r.payload as { id: string }).id]); };
  const standby = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], load: new ManualLoad(),
    standby: { apply, pollMs: 20 }, testing: { sessionTimings: FAST, postAcquisitionWaitMs: 10 } });
  closers.push(() => standby.stop());
  await standby.start(hooks());
  const { port } = await serve(standby.standbyChannel());
  holder.attachStandby('s1', connect(port));
  const parts = ['L1', 'L2', 'L3'].map(utf8);
  for (let i = 0; i < 4; i++) for (const p of parts) assert.equal((await holder.append({ partition: p, entries: [entry(`${hex(p)}-${i}`)] })).r, 'Committed');
  await until(() => standby.standbyStats()?.pushedRows === 12);
  for (const p of parts) assert.deepEqual(mem.get(hex(p)), Array.from({ length: 4 }, (_, i) => `${hex(p)}-${i}`));
  assert.equal(standby.standbyStats()?.tailRows, 0);
  assert.deepEqual(standby.heldSlots(), []);
  holder.pauseRenewalsForTest();
  await until(() => standby.heldSlots().length === 4, 3_000);
  assert.equal(standby.standbyStats()?.catchUpRows, 0, 'no reload from the log beyond the last pushed batch');
  const acquired: SlotNo[] = standby.heldSlots();
  assert.deepEqual([...acquired].sort(), [0, 1, 2, 3]);
});
