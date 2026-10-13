import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESULTS, RuntimeDouble } from '@share/owner-runtime/testing';
import { hlcToWallMs, utf8, validateDeclaration, type HlcTs } from '@share/owner-runtime';
import { MemoryAlerts, type HandoffEvent } from '@share/rate-common';
import {
  INGEST_ENTRY, IngestOwner, decodeItem, emitHandoff, ingestDeclaration, recordFields, type BatchEntryPayload,
  type IngestSession,
} from '../src/index.ts';
import { ReferenceExporter, exporterPrincipal } from '../testing/index.ts';

const T0 = Date.parse('2026-10-12T12:31:00Z');
const noSleep = async (): Promise<void> => {};

function setup() {
  const rt = new RuntimeDouble({ declaration: ingestDeclaration, startMs: T0 });
  const alerts = new MemoryAlerts();
  const owner = new IngestOwner(rt, { alerts, sleep: noSleep });
  rt.attach(owner);
  const opened = owner.openSession({ principal: exporterPrincipal({ supplier: 's1' }), exporterId: 'e1' });
  if ('refused' in opened) throw new Error('session refused');
  const session: IngestSession = opened;
  session.onHello({ protocolVersion: 1, exportFormat: 'ipfix' }, T0);
  const exp = new ReferenceExporter(7, T0 - 3_600_000);
  return { rt, owner, session, exp, alerts };
}

const flow = { startMs: Date.parse('2026-10-12T12:30:10Z'), endMs: Date.parse('2026-10-12T12:30:50Z'), bytes: 1_000_000_000n, ifIndex: 3, vlan: 100 };

test('should decode the reference exporter item from its own context only when the IPFIX codec decodes', () => {
  const exp = new ReferenceExporter(7, 1_000);
  const item = exp.exportItem([flow], 1_760_000_000);
  const d = decodeItem(item.message, item.context);
  assert.ok(d.ok);
  assert.deepEqual(d.item.initTimesMs, [1_000]);
  assert.equal(d.item.records.length, 1);
  const f = recordFields(d.item.records[0] as never, 1_000);
  assert.ok(f.ok);
  assert.equal(f.fields.bytes, 1_000_000_000n);
  assert.equal(f.fields.direction, 'egress');
  assert.deepEqual(f.fields.serviceTag, { vlan: { outer: 100 } });
  // Without the context there is no template: the data set has no usable template.
  const bare = decodeItem(item.message, new Uint8Array());
  assert.ok(bare.ok);
  assert.equal(bare.item.noTemplateSets.length, 1);
});

test('C11 session open: a network_operations certificate, or one with no exporter, is refused', () => {
  const rt = new RuntimeDouble({ declaration: ingestDeclaration, startMs: T0 });
  const owner = new IngestOwner(rt);
  assert.ok('refused' in owner.openSession({ principal: exporterPrincipal({ kind: 'network_operations' }), exporterId: 'e1' }));
  assert.ok('refused' in owner.openSession({ principal: exporterPrincipal({}) }));
  assert.equal(rt.appends.length, 0);
});

test('C11 test 1 (double): no BatchAck before Committed; Retry and Ambiguous are retried with the same identity', async () => {
  const { rt, session, exp } = setup();
  rt.scriptAppend(RESULTS.Retry(), RESULTS.Ambiguous(), RESULTS.Moving());
  const frames = await exp.send(session, exp.batch([exp.exportItem([flow], 1_760_270_000)]));
  assert.equal(rt.appends.length, 4);
  const ids = rt.appends.map((a) => a.call);
  assert.ok(ids.every((c) => c === ids[0]), 'one AppendCall object, so the same identities');
  assert.equal(frames.filter((f) => 'ack' in f).length, 1);
  assert.equal(rt.appends[3]?.result.r, 'Committed');
  assert.equal(exp.unacked.size, 0);
});

test('C11 test 1 (double): Stopped, StaleEpoch and exhausted retries give no acknowledgement', async () => {
  const { rt, session, exp } = setup();
  const b = exp.batch([exp.exportItem([flow], 1_760_270_000)]);
  rt.scriptAppend(RESULTS.Stopped());
  assert.deepEqual(await exp.send(session, b), [{ notice: { kind: 'waiting', detail: 'temporarily unavailable' } }]);
  rt.scriptAppend(RESULTS.StaleEpoch());
  assert.deepEqual(await exp.send(session, b), [{ notice: { kind: 'draining' } }]);
  rt.scriptAppend(RESULTS.Retry(), RESULTS.Retry(), RESULTS.Retry(), RESULTS.Retry(), RESULTS.Retry());
  assert.deepEqual(await exp.send(session, b), []);
  assert.equal(exp.acks.length, 0);
  assert.equal(rt.published.length, 0, 'nothing is published before Committed');
  await exp.resendUnacked(session);
  assert.equal(exp.acks.length, 1);
  assert.equal(exp.acks[0]?.items[0]?.message.accepted, 1);
});

test('C01 CC-1 (ingest): an unknown AppendResult is a Retry and an alert', async () => {
  const { rt, session, exp, alerts } = setup();
  rt.scriptAppend(RESULTS.Unknown());
  await exp.send(session, exp.batch([exp.exportItem([flow], 1_760_270_000)]));
  assert.equal(alerts.of('UNKNOWN_APPEND_RESULT').length, 1);
  assert.equal(exp.acks.length, 1);
});

test('should give duplicates when a record is resent verbatim, also after the memory is lost (takeover)', async () => {
  const { rt, owner, session, exp } = setup();
  const item = exp.exportItem([flow], 1_760_270_000);
  await exp.send(session, exp.batch([item]));
  await exp.send(session, exp.batch([item]));
  assert.equal(exp.acks[1]?.items[0]?.message.duplicates, 1);
  assert.equal(exp.acks[1]?.items[0]?.message.accepted, 0);
  // The holder loses the slot and a new holder starts with no memory: the range chunk row decides.
  const slot = rt.route('ingest', utf8('e1')).slot;
  rt.release(slot);
  await rt.acquire(slot);
  assert.equal(owner.exporters().includes('e1'), false);
  const again = owner.openSession({ principal: exporterPrincipal({ supplier: 's1', region: 'R2' }), exporterId: 'e1' });
  assert.ok(!('refused' in again));
  again.onHello({ protocolVersion: 1, exportFormat: 'ipfix' }, T0);
  await exp.send(again, exp.batch([item]));
  assert.equal(exp.acks[2]?.items[0]?.message.duplicates, 1);
  const accepted = rt.log(utf8('e1')).filter((e) => e.entry.kind === INGEST_ENTRY.batch)
    .flatMap((e) => (e.entry.payload as BatchEntryPayload).accepted);
  assert.equal(accepted.length, 1, 'the record is accepted once');
});

test('C11 test 12 (first clause): the relay derivation of each ingest_log row equals the direct publish; handoffSeq = stream_seq, contiguous', async () => {
  const { rt, session, exp } = setup();
  for (let i = 0; i < 3; i++) await exp.send(session, exp.batch([exp.exportItem([{ ...flow, bytes: BigInt(1000 + i) }], 1_760_270_000 + i)]));
  const direct = rt.published.filter((p) => p.topic === 'ingestion.handoff.v1');
  const rows = rt.log(utf8('e1')).filter((e) => e.entry.kind === INGEST_ENTRY.batch);
  const relayed: HandoffEvent[] = rows.map((r) => emitHandoff(r.entry.payload as BatchEntryPayload,
    { logSeq: r.seq, ts: r.ts, handoffSeq: r.streamSeqs[0]?.streamSeq ?? 0n }));
  assert.deepEqual(relayed, direct.map((d) => d.event));
  assert.deepEqual(direct.map((d) => d.streamSeq), [1n, 2n, 3n]);
  assert.deepEqual(relayed.map((e) => e.handoffSeq), ['1', '2', '3']);
  for (const e of relayed) assert.equal(e.acceptedAtMs, hlcToWallMs(e.commitTs as HlcTs));
  // The context is logged once per partition: in the first entry, then by reference.
  assert.ok(relayed[0]?.body.kind === 'batch' && relayed[0].body.contexts[0]?.context !== undefined);
  assert.ok(relayed[1]?.body.kind === 'batch' && relayed[1].body.contexts[0]?.firstLoggedIn === rows[0]?.seq.toString());
});

test('should reject a record with a positioned reject key, and accept the next record, when its end is before its start', async () => {
  const { session, exp } = setup();
  const bad = { ...flow, startMs: flow.endMs, endMs: flow.startMs };
  await exp.send(session, exp.batch([exp.exportItem([bad, flow], 1_760_270_000)]));
  const m = exp.acks[0]?.items[0]?.message;
  assert.equal(m?.accepted, 1);
  assert.equal(m?.rejected.length, 1);
  assert.equal(m?.rejected[0]?.reason, 'end time before its start time');
  assert.equal(m?.rejected[0]?.rejectKey.kind, 'positioned');
  assert.equal(m?.acceptedIdentities[0]?.format === 'ipfix' && m.acceptedIdentities[0].extSeq, '1');
});

test('should not commit and not acknowledge a batch when its payload is outside the I1 subset', async () => {
  const { rt, session, exp } = setup();
  const item = exp.exportItem([flow], 1_760_270_000);
  const frames = await exp.send(session, exp.batch([{ message: item.message, context: new Uint8Array() }]));
  assert.equal(rt.appends.length, 0);
  assert.equal(frames.some((f) => 'ack' in f), false);
});

test('C01 CC-8 (ingest): the declaration matches RFC-003 §3.4 and the runtime validator accepts it', () => {
  // S-PLAT I1b: selfOutboxed kinds and contract topic names are supported; no validation errors remain.
  assert.deepEqual(validateDeclaration(ingestDeclaration), []);
  assert.deepEqual(ingestDeclaration.entryKinds.map((e) => e.name), ['batch', 'drop-alert', 'withdrawn', 'drop-count',
    'epoch-opened', 'wrap-opened', 'correction', 'supersession', 'identity-conflict', 'checkpoint']);
  assert.ok(ingestDeclaration.entryKinds.filter((e) => e.name !== 'checkpoint').every((e) => e.retention === '7y'));
  assert.equal(ingestDeclaration.selfOutboxed, true);
  const h = ingestDeclaration.streams.find((s) => s.name === 'handoff');
  assert.equal(h?.closure, 'resolved');
  assert.deepEqual(h?.consumers, ['attr_a']);
  assert.ok(ingestDeclaration.projections.every((p) => /PRIMARY KEY \(partition/.test(p.ddl)), 'keys led by partition');
  assert.ok(ingestDeclaration.projections.every((p) => p.deletable !== true), 'insert-only state');
});
