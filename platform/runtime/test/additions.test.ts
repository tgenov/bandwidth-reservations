/**
 * Additive runtime work asked by the slice teams (S-SEC, S-LINK, S-RATE), one test per item, on the
 * in-memory store and the runtime double.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditFields, EntryInput, OwnerDeclaration, OwnerHooks, SlotNo } from '../src/index.ts';
import {
  CockroachOwnerRuntime, ManualLoad, MemoryPublisher, NotClosed, chainGenesis, chainNext, encodeJson, hex, hlcParts, homeKey,
  producerAcls, slotOfPartition, utf8, validateDeclaration,
} from '../src/index.ts';
import { MemoryStore, RuntimeDouble, StatusReaderDouble } from '../testing/index.ts';

const AUDIT: AuditFields = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'internal_service', tenant: { kind: 'none' } },
  decided_at: 'commit', policy_version: 1, received_at: 1_700_000_000_000_000n };
const DECL: OwnerDeclaration = {
  kind: 'sec', slotCount: 4, slotPositions: true,
  entryKinds: [{ kind: 1, name: 'e', schemaVersions: [1], retention: '7y' }],
  projections: [{ name: 'mark', ddl: 'partition BYTES NOT NULL, id STRING NOT NULL, PRIMARY KEY (partition, id)', clearColumns: ['partition', 'id'] }],
  streams: [
    { name: 'byacct', topic: 'attribution.parts.v1', key: { field: 'account' }, emitFn: { version: 1 }, closure: 'none', consumers: [] },
  ],
  messages: [{ name: 'watermark', topic: 'ingestion.handoff.v1', consumers: ['rating'] }],
  selfOutboxed: true,
};
const entry = (id: string, extra: Partial<EntryInput> = {}): EntryInput => ({ kind: 1, schemaV: 1, identity: utf8(id), audit: AUDIT, payload: { id }, ...extra });
const FAST = { sessionTtlMs: 300, sessionRenewMs: 40, renewRetryMs: 20, holderViewMs: 280, maxLoopDelayMs: 20 };
const hooks = (): OwnerHooks => ({ async onAcquire() {}, onRelease() {}, onReportable() {}, onMovedOut() {}, async onAdopt() {}, async onNotification() {} });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot(store = new MemoryStore(), publisher = new MemoryPublisher()) {
  store.seedSlots('sec', 4);
  const rt = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [0, 1, 2, 3], publisher, load: new ManualLoad(), testing: { sessionTimings: FAST } });
  await rt.start(hooks());
  return { rt, store, publisher };
}
const P = utf8('part-1');

test('S-RATE 1-3: selfOutboxed, a contract topic named exactly, and a field key are accepted; bad topics are not', () => {
  assert.deepEqual(validateDeclaration(DECL), []);
  const bad = { ...DECL, streams: [{ ...DECL.streams[0], topic: 'Not A Topic' }] } as OwnerDeclaration;
  assert.ok(validateDeclaration(bad).some((e) => /contract topic/.test(e)));
  assert.ok(validateDeclaration({ ...DECL, streams: [{ ...DECL.streams[0], topic: 'catalogue.v1' }] } as OwnerDeclaration).length === 0);
});

test('S-SEC 1, 7; S-RATE 1, 3: readLog opens rows (payload, audit with C08 Tenant and EpochMicros, sender fence); stream index; field key', async () => {
  const { rt, store, publisher } = await boot();
  const fence = { kind: 'acct', partition: utf8('A1'), generation: 0, epoch: 5n };
  assert.equal((await rt.append({ partition: P, entries: [entry('a', { senderFence: fence, emits: [{ stream: 'byacct', event: { account: 'acct-9', n: 1 } }] }), entry('b')] })).r, 'Committed');
  const rows = await rt.readLog(P);
  assert.deepEqual(rows.map((r) => r.seq), [1n, 2n]);
  assert.deepEqual(rows[0]?.payload, { id: 'a' });
  assert.deepEqual((rows[0]?.audit as AuditFields).principal.tenant, { kind: 'none' });
  assert.equal((rows[0]?.audit as AuditFields).received_at, 1_700_000_000_000_000n);
  assert.equal(rows[0]?.senderFence?.epoch, 5n);
  assert.equal(rows[1]?.senderFence, undefined);
  let chain = chainGenesis('sec', P);
  for (const l of store.log) chain = chainNext(chain, { kindName: 'sec', partition: P, seq: l.seq, slot: l.slot, generation: l.generation, epoch: l.epoch,
    entryKind: l.kind, schemaV: l.schemaV, identity: l.identity, emits: l.emits, retention: l.retention, keyId: l.keyId, audit: l.audit, payload: l.payload });
  assert.equal(hex(rows[1]?.chain ?? new Uint8Array()), hex(chain));
  assert.deepEqual(rows[0]?.emits, [['byacct', 1n]]);
  assert.deepEqual(store.streamIndex.map((x) => [x.stream, x.streamSeq, x.seq]), [['byacct', 1n, 1n]]);
  assert.equal(Buffer.from(publisher.sent[0]?.key ?? []).toString(), 'acct-9', 'keyed by the declared field');
  await rt.stop();
});

test('S-SEC 2, 3: listPartitions(slot); a takeover rebuilds the admitCommand high-water from the log (R47-24)', async () => {
  const store = new MemoryStore();
  const a = await boot(store);
  const slot = slotOfPartition(P, 4);
  const fence = { kind: 'acct', partition: utf8('A1'), generation: 0, epoch: 5n };
  assert.equal((await a.rt.append({ partition: P, entries: [entry('f', { senderFence: fence })] })).r, 'Committed');
  assert.deepEqual((await a.rt.listPartitions(slot)).map(hex), [hex(P)]);
  a.rt.pauseRenewalsForTest();
  const b = new CockroachOwnerRuntime({ declaration: DECL, store, slots: [slot], load: new ManualLoad(), testing: { sessionTimings: FAST } });
  let admitted: unknown;
  await b.start({ ...hooks(), async onAcquire() { admitted = b.admitCommand({ kind: 'acct', partition: utf8('A1') }, { generation: 0, epoch: 4n }); } });
  for (let i = 0; i < 100 && !b.heldSlots().includes(slot); i++) await sleep(10);
  assert.deepEqual(admitted, { admit: false, recorded: { generation: 0, epoch: 5n } }, 'the rebuilt mark is ready in onAcquire');
  await a.rt.stop().catch(() => {}); await b.stop();
});

test('S-SEC 6: a slot-wide commit sequence (C08 §C position): ctx.slotPosition and Committed.slotPositions, contiguous across batches', async () => {
  const { rt } = await boot();
  const seen: bigint[] = [];
  const P2 = utf8('part-2');
  const same = [P, P2].filter((p) => slotOfPartition(p, 4) === slotOfPartition(P, 4));
  const r1 = await rt.append({ partition: P, decide: (ctx) => { seen.push(ctx.slotPosition as bigint); return { entries: [entry('x'), entry('y')] }; } });
  const r2 = await rt.append({ partition: same[same.length - 1] as Uint8Array, entries: [entry('z')] });
  assert.ok(r1.r === 'Committed' && r2.r === 'Committed');
  if (r1.r === 'Committed' && r2.r === 'Committed') {
    assert.deepEqual(r1.slotPositions, [1n, 2n]);
    assert.deepEqual(r2.slotPositions, [3n, 3n]);
  }
  assert.deepEqual(seen, [1n]);
  await rt.stop();
});

test('S-SEC 4, 5: hlcParts exported; MemoryStore consistentRead returns rows of projections and heads', async () => {
  assert.deepEqual(hlcParts('12.0000000003' as never), { wallNs: 12n, logical: 3n });
  const { rt } = await boot();
  await rt.append({ partition: P, entries: [entry('m')], projections: [{ table: 'sec_mark', op: 'upsert', key: { partition: P, id: 'k' }, row: { } }] });
  const rows = await rt.consistentRead((tx) => tx.query('SELECT * FROM sec_mark WHERE partition = $1 AND id = $2', [P, 'k']), 'present');
  assert.equal(rows.length, 1);
  const heads = await rt.consistentRead((tx) => tx.query('SELECT * FROM sec_head WHERE home_key = $1', [homeKey(P)]), 'present');
  assert.equal(String(heads[0]?.['seq']), '1');
  await rt.stop();
});

test('S-RATE 4: publishMessage sends a declared non-log message on its topic (same producer ACL); undeclared ones are refused', async () => {
  const { rt, publisher } = await boot();
  await rt.publishMessage('watermark', P, encodeJson({ through: '10' }));
  assert.equal(publisher.sent.at(-1)?.topic, 'ingestion.handoff.v1');
  await assert.rejects(rt.publishMessage('nope', P, new Uint8Array()), /not declared/);
  assert.deepEqual(producerAcls([DECL]).find((a) => a.topic === 'ingestion.handoff.v1')?.producers, ['sec-holder', 'sec-relay']);
  await rt.stop();
});

test('double (S-SEC 5, S-RATE 5, priority list): start calls onAcquire + onReportable; chain; route by target count; groups; displacement; status reader', async () => {
  const account: OwnerDeclaration = { kind: 'account', slotCount: 8, entryKinds: [], projections: [], streams: [] };
  const link: OwnerDeclaration = { kind: 'link', slotCount: 2, entryKinds: [], projections: [], streams: [] };
  const g = RuntimeDouble.group([account, link], { slots: [0, 1] });
  const acc = g['account'] as RuntimeDouble;
  const lnk = g['link'] as RuntimeDouble;
  const acquired: SlotNo[] = [];
  const reportable: SlotNo[] = [];
  await acc.start({ ...hooks(), async onAcquire(s) { acquired.push(s); }, onReportable(s) { reportable.push(s); } });
  assert.deepEqual(acquired, [0, 1]);
  assert.deepEqual(reportable, [0, 1]);
  const x = utf8('x');
  assert.equal(acc.route('link', x).slot, slotOfPartition(x, 2), "the target kind's slot count");
  assert.equal(lnk.route('account', x).slot, slotOfPartition(x, 8));
  // Shared clock and rows.
  lnk.advance(5_000);
  assert.equal(acc.now().ts, lnk.now().ts);
  // Chain and report position.
  const p = [...Array(50).keys()].map((i) => utf8(`p${i}`)).find((q) => slotOfPartition(q, 8) < 2) as Uint8Array;
  const c = await acc.append({ partition: p, entries: [entry('c1')] });
  assert.equal(c.r, 'Committed');
  assert.notEqual(hex(acc.headOf(p).chain), hex(new Uint8Array(32)));
  assert.equal(hex(acc.headOf(p).chain), hex(acc.log(p)[0]?.chain ?? new Uint8Array()));
  assert.equal(c.r === 'Committed' ? acc.reportPosition(slotOfPartition(p, 8)) : undefined, c.r === 'Committed' ? c.ts : undefined);
  // Displacement markers: any attempt fails.
  acc.putDisplacementMarker(utf8('L'), utf8('r'), 1);
  const d = await acc.append({ partition: p, conditions: [{ kind: 'displacementRead', link: utf8('L'), request: utf8('r'), attempt: 2, lockTimeoutMs: 10, label: 'disp' }], entries: [entry('c2')] });
  assert.deepEqual(d, { r: 'ConditionFailed', which: 'disp', displacement: { attempt: 1, row: { attempt: 1 } } });
  // consistentRead of the double's rows; status reader double.
  acc.putRow({ table: 'account_req', key: { partition: p, id: 'q' } }, { state: 'held' });
  assert.equal((await acc.consistentRead((tx) => tx.query('SELECT * FROM account_req WHERE id = $1', ['q']), 'present')).length, 1);
  const sr = new StatusReaderDouble(acc);
  const s = slotOfPartition(p, 8);
  assert.equal(sr.readLease(s).valid, true);
  assert.deepEqual(await sr.leasedRead(p, [{ table: 'account_req', key: { partition: p, id: 'q' } }]), [{ state: 'held' }]);
  sr.setLease(s, false);
  await assert.rejects(sr.leasedRead(p, []), NotClosed);
  assert.equal((await sr.replicaRule3Check(s, utf8('q'))).holderLive, true);
});
