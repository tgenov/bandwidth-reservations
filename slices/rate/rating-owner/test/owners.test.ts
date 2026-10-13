import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESULTS, RuntimeDouble, feedEvent } from '@share/owner-runtime/testing';
import { decodeJson, encodeJson, utf8, validateDeclaration } from '@share/owner-runtime';
import { MemoryAlerts, sourceRefDigest, type ChargeLineBatch, type PartBatch, type PostingAck } from '@share/rate-common';
import { ingestDeclaration } from '@share/ingestion';
import {
  CatalogueOwner, CatalogueReplica, RatingOwner, StageBOwner, attrADeclaration, attrBDeclaration, catalogueDeclaration,
  leadTimeRefusal, ratingDeclaration, spread, ATTR_B_ENTRY, TOPIC_POSTING_ACKS, type StageBInput,
} from '../src/index.ts';
import { LedgerDouble } from '../testing/index.ts';
import { CATALOGUE, DEPLOY_AT, FLOW_1GB, MINUTE_1230, chargeBatches, readyWorld, runPastClosure } from './fixture.ts';

const noSleep = async (): Promise<void> => {};

test('POL-13 spread: a record inside one minute is one part; a record across a boundary is split exactly, half-open', () => {
  assert.deepEqual(spread(FLOW_1GB.startMs, FLOW_1GB.endMs, 1_000_000_000n),
    [{ minuteMs: MINUTE_1230, bytes: { num: '40000000000000', den: '40000' }, bindTimeMs: FLOW_1GB.startMs }]);
  const s = Date.parse('2026-10-12T11:59:30Z');
  const parts = spread(s, s + 60_000, 1_000_000_000n);
  assert.deepEqual(parts.map((p) => [p.minuteMs - s + 30_000, p.bytes]), [
    [0, { num: '30000000000000', den: '60000' }], [60_000, { num: '30000000000000', den: '60000' }]]);
  // A flow ending exactly at a minute boundary has no part in that minute.
  assert.equal(spread(MINUTE_1230, MINUTE_1230 + 60_000, 10n).length, 1);
  // e = s: all bytes in floor_min(s).
  assert.deepEqual(spread(MINUTE_1230 + 5, MINUTE_1230 + 5, 7n), [{ minuteMs: MINUTE_1230, bytes: { num: '7', den: '1' }, bindTimeMs: MINUTE_1230 + 5 }]);
});

test('C06 lead times (CT-R2 subset): a usage_price with less lead than price_notice never gets to the feed', async () => {
  const rt = new RuntimeDouble({ declaration: catalogueDeclaration, startMs: DEPLOY_AT });
  const cat = new CatalogueOwner(rt, { sleep: noSleep });
  const r = await cat.write({ entityType: 'price_version', product: 'p1', route: 'r1', priceKind: 'usage_price', priceVersion: 'pv-short',
    price: '1', effectiveFrom: '2026-09-15T00:00:00Z' }, 'deploy');
  assert.deepEqual(r, { ok: false, reason: 'usage_price lead is less than price_notice' });
  assert.equal(rt.published.length, 0);
  assert.equal(leadTimeRefusal({ entityType: 'split_weights', route: 'r1', weightsVersion: 'w', effectiveFrom: '2026-09-01T00:00:00Z',
    legs: [{ link: 'L1', supplier: 's1', weight: 1 }], commissionWeight: 1 }, DEPLOY_AT), 'effectiveFrom is less than 1 min after announcedAt');
  for (const e of CATALOGUE) assert.ok((await cat.write(e, 'deploy')).ok);
  assert.equal(rt.published.length, CATALOGUE.length);
});

test('C01 CC-1 (catalogue, stage B, rating): no state change and no event before Committed; Stopped decides nothing', async () => {
  // Catalogue.
  const crt = new RuntimeDouble({ declaration: catalogueDeclaration, startMs: DEPLOY_AT });
  const cat = new CatalogueOwner(crt, { sleep: noSleep });
  crt.scriptAppend(RESULTS.Stopped());
  assert.deepEqual(await cat.write(CATALOGUE[0] as never, 'd'), { ok: false, reason: 'stopped' });
  crt.scriptAppend(RESULTS.Ambiguous(), RESULTS.Unknown());
  assert.equal((await cat.write(CATALOGUE[0] as never, 'd')).ok, true);
  assert.equal(crt.published.length, 1);
  // Stage B: a Stopped append does not reach rating; the batch is applied after the stop is lifted.
  const brt = new RuntimeDouble({ declaration: attrBDeclaration, startMs: DEPLOY_AT });
  const got: StageBInput[] = [];
  const sb = new StageBOwner(brt, { rating: { applyParts: async (i) => { got.push(i); } }, sleep: noSleep });
  brt.attach(sb);
  const pb: PartBatch = { schemaVersion: 1, feedId: { stageAPartition: 'e1', ownerEpoch: 1, logSeq: '1', accountId: 'a1' },
    destSeq: '1', commitTs: '1.0000000000', parts: [], bindingFacts: [] };
  const fe = feedEvent({ partition: utf8('e1'), stream: 'parts', streamSeq: 1n, event: pb });
  brt.scriptAppend(RESULTS.Stopped());
  await brt.deliver('attribution.parts.v1', fe);
  await sb.idle();
  assert.equal(got.length, 0);
  await brt.deliver('attribution.parts.v1', fe);
  await sb.idle();
  assert.equal(got.length, 1);
  // Rating: a StaleEpoch on the inputs entry leaves the state unchanged.
  const rrt = new RuntimeDouble({ declaration: ratingDeclaration, startMs: DEPLOY_AT });
  const rating = new RatingOwner(rrt, { catalogue: new CatalogueReplica(), homeLedgerPartition: LedgerDouble.home, sleep: noSleep });
  rrt.scriptAppend(RESULTS.StaleEpoch());
  await rating.applyParts({ account: 'a1', attrBSeq: '1', parts: [], bindingFacts: [] });
  assert.equal(rating.stateOf('a1')?.attrBSeq ?? '0', '0');
  await rating.applyParts({ account: 'a1', attrBSeq: '1', parts: [], bindingFacts: [] });
  assert.equal(rating.stateOf('a1')?.attrBSeq, '1');
});

test('C01 CC-6 (stage B): part batches replayed twice and out of order are appended once each, in destSeq order, with the event digest', async () => {
  const brt = new RuntimeDouble({ declaration: attrBDeclaration, startMs: DEPLOY_AT });
  const got: string[] = [];
  const sb = new StageBOwner(brt, { rating: { applyParts: async (i) => { got.push(i.attrBSeq); } }, sleep: noSleep });
  const mk = (destSeq: number) => feedEvent({ partition: utf8('e1'), stream: 'parts', streamSeq: BigInt(destSeq), event: {
    schemaVersion: 1, feedId: { stageAPartition: 'e1', ownerEpoch: 1, logSeq: String(destSeq), accountId: 'a1' },
    destSeq: String(destSeq), commitTs: '1.0000000000', parts: [], bindingFacts: [] } satisfies PartBatch });
  for (const n of [3, 1, 3, 2, 1, 2]) await brt.deliver('attribution.parts.v1', mk(n));
  await sb.idle();
  const log = brt.log(utf8('a1'));
  assert.deepEqual(log.map((e) => (e.entry.payload as { applied: { destSeq: string } }).applied.destSeq), ['1', '2', '3']);
  assert.ok(log.every((e) => e.entry.kind === ATTR_B_ENTRY.parts && typeof (e.entry.payload as { applied: { digest: string } }).applied.digest === 'string'));
  assert.deepEqual(got, ['1', '2', '3']);
});

test('C01 CC-6 / C11 test 16 (stage A): hand-off events out of order and twice give the same parts as in order', async () => {
  const inOrder = await readyWorld();
  const exp = new inOrder.ReferenceExporter(7, MINUTE_1230 - 3_600_000);
  const s = inOrder.session('e1', 's1');
  for (let i = 0; i < 3; i++) await exp.send(s, exp.batch([exp.exportItem([{ ...FLOW_1GB, bytes: BigInt(100_000_000 * (i + 1)) }], 1_760_270_000 + i)]));
  await inOrder.bus.settle();
  const handoffs = inOrder.bus.eventsOn<unknown>('ingestion.handoff.v1');
  assert.equal(handoffs.length, 3);
  const partsOf = (w: typeof inOrder) => w.bus.eventsOn<PartBatch>('attribution.parts.v1').flatMap((b) => b.parts.map((p) => p.bytes.num));
  // A second world gets the same hand-off events reordered and repeated, straight into stage A.
  const chaos = await readyWorld();
  for (const i of [2, 0, 2, 1, 0, 1]) {
    const ev = handoffs[i] as { handoffSeq: string };
    await chaos.rts.attrA.deliver('ingestion.handoff.v1', feedEvent({ partition: utf8('e1'), stream: 'handoff',
      streamSeq: BigInt(ev.handoffSeq), event: decodeJson(encodeJson(ev)) }));
  }
  await chaos.bus.settle();
  assert.deepEqual(partsOf(chaos), partsOf(inOrder));
  // b × t / D with t = D = 40,000 ms: 0.1, 0.2 and 0.3 GB.
  assert.deepEqual(partsOf(chaos), ['4000000000000', '8000000000000', '12000000000000']);
});

test('C06 CT-C2 (rating as consumer of C06 §7): a repeated posted ack has no effect; an excluded line is not marked posted and stays in U', async () => {
  const w = await readyWorld();
  const exp = new w.ReferenceExporter(7, MINUTE_1230 - 3_600_000);
  await exp.send(w.session('e1', 's1'), exp.batch([exp.exportItem([FLOW_1GB], 1_760_270_000)]));
  w.settlement.scriptAcks((b: ChargeLineBatch) => b.lines.map((l) => ({ sourceRef: l.sourceRef, outcome: 'excluded' as const, reason: 'invalid' as const })));
  await runPastClosure(w);
  const line = w.rating.stateOf('a1')?.lines[`p1|r1|${MINUTE_1230}`];
  assert.equal(line?.posted, '0');
  assert.equal(w.alerts.of('LINE_EXCLUDED_NOT_IN_I1').length, 1);
  assert.equal(w.accountOwner.unposted('a1', 'p1'), 10_000n);
  assert.equal(w.ledger.movements.length, 0);

  // A fresh world: the posted ack is delivered three times (CT-R8-style redelivery); one posted entry.
  const v = await readyWorld();
  const exp2 = new v.ReferenceExporter(7, MINUTE_1230 - 3_600_000);
  await exp2.send(v.session('e1', 's1'), exp2.batch([exp2.exportItem([FLOW_1GB], 1_760_270_000)]));
  await runPastClosure(v);
  const acks = v.bus.eventsOn<PostingAck>(TOPIC_POSTING_ACKS);
  assert.equal(acks.length, 1);
  const before = v.rts.rating.log(utf8('a1')).length;
  for (let i = 0; i < 3; i++) await v.bus.publish(TOPIC_POSTING_ACKS, 'a1', 'posting_acks', acks[0]);
  await v.bus.settle();
  assert.equal(v.rts.rating.log(utf8('a1')).length, before);
  assert.equal(v.rating.stateOf('a1')?.lines[`p1|r1|${MINUTE_1230}`]?.posted, '10000');
});

test('settlement double (C06 §8 provider, CT-L4, CT-L5, CT-L6 subset): duplicate line, conflict, lineCount, recorded answer', async () => {
  const w = await readyWorld();
  const exp = new w.ReferenceExporter(7, MINUTE_1230 - 3_600_000);
  await exp.send(w.session('e1', 's1'), exp.batch([exp.exportItem([FLOW_1GB], 1_760_270_000)]));
  await runPastClosure(w);
  const req = w.settlement.requests[0];
  assert.ok(req);
  // CT-L5: the same movementRef and digest returns the recorded answer.
  const again = w.ledger.post(req, 'a1');
  assert.equal(again.result, 'committed');
  assert.equal(w.ledger.movements.length, 1);
  // CT-L4 (1): the line in a new batch with the same content is a duplicate; the batch commits whole.
  const dup = w.ledger.post({ ...req, movementRef: 'other-batch', batch: { id: 'other-batch', kind: 'usage', lineCount: 1 } }, 'a1');
  assert.ok(dup.result === 'committed' && dup.lines[0]?.outcome === 'duplicate' && dup.whole === true);
  // CT-L4 (2): the same SourceRef with different content refuses the usage batch whole.
  const line = req.lines[0];
  assert.ok(line);
  const changed = { ...line, newTotal: '9999', entries: [{ ledgerAccount: 'B:a1', amount: '-9999' }, { ledgerAccount: 'SH:commission', amount: '9999' }] };
  const conflict = w.ledger.post({ ...req, movementRef: 'b3', batch: { id: 'b3', kind: 'usage', lineCount: 1 }, lines: [changed] }, 'a1');
  assert.ok(conflict.result === 'refused_batch' && conflict.lines[0]?.problem === 'conflict');
  assert.equal(w.ledger.integrityAlerts.length, 1);
  // CT-L4 (4): lines.length ≠ lineCount is refused invalid.
  assert.equal(w.ledger.post({ ...req, movementRef: 'b4', batch: { id: 'b4', kind: 'usage', lineCount: 2 } }, 'a1').result, 'refused');
  // CT-L6: a wrong priorTotal on a new reference is prior_total_mismatch.
  const ref1 = { ...(line.lineRef as { kind: 'usage'; account: string; product: string; route: string; minute: string; seq: number }), seq: 1 };
  const amend = { ...line, lineRef: ref1, amendmentSeq: 1, priorTotal: '1', newTotal: '10001',
    entries: [{ ledgerAccount: 'B:a1', amount: '-10000' }, { ledgerAccount: 'SH:commission', amount: '10000' }] };
  const mm = w.ledger.post({ ...req, movementRef: 'b5', batch: { id: 'b5', kind: 'usage', lineCount: 1 }, lines: [amend] }, 'a1');
  assert.ok(mm.result === 'refused_batch' && mm.lines[0]?.problem === 'prior_total_mismatch');
  assert.equal(w.ledger.postedTotal(line.lineRef as never), 10_000n);
  assert.equal(chargeBatches(w).length, 1);
  assert.ok(sourceRefDigest(line.lineRef as never).length === 64);
});

test('C01 CC-8: the five declarations match RFC-003 (entry kinds, retention, keys led by partition, streams, closure, consumers)', () => {
  // S-PLAT I1b: contract topic names (catalogue.v1, attribution.parts.v1) and selfOutboxed are supported.
  assert.deepEqual(validateDeclaration(catalogueDeclaration), []);
  assert.deepEqual(validateDeclaration(attrADeclaration), []);
  assert.deepEqual(validateDeclaration(attrBDeclaration), []);
  assert.deepEqual(validateDeclaration(ratingDeclaration), []);
  assert.deepEqual(validateDeclaration(ingestDeclaration), []);
  assert.equal(ingestDeclaration.selfOutboxed, true);
  for (const d of [catalogueDeclaration, attrADeclaration, attrBDeclaration, ratingDeclaration, ingestDeclaration]) {
    assert.ok(d.projections.every((p) => /PRIMARY KEY \(partition/.test(p.ddl)), `${d.kind}: keys led by partition`);
    assert.ok(d.entryKinds.every((e) => e.retention === (e.name === 'checkpoint' ? 'ops' : '7y')), `${d.kind}: retention`);
  }
  assert.deepEqual(ratingDeclaration.entryKinds.map((e) => e.name),
    ['inputs', 'accrual-closed', 'usage-closed', 'amendment', 'fee', 'emitted', 'posted', 'breach', 'checkpoint']);
  assert.equal(attrBDeclaration.slotGroupWith, 'rating');
  assert.equal(ratingDeclaration.slotGroupWith, 'attr_b');
  assert.equal(attrBDeclaration.slotCount, ratingDeclaration.slotCount);
  assert.deepEqual(ratingDeclaration.streams.map((s) => [s.topic, s.closure]), [
    ['rating.unposted-usage.v1', 'resolved'], ['rating.charge-lines.v1', 'resolved'],
    ['rating.affected-marks.v1', 'resolved'], ['rating.breach-report.v1', 'resolved']]);
  assert.equal(catalogueDeclaration.streams[0]?.closure, 'resolved');
});

test('alerts: the walking skeleton raises no alert', async () => {
  const w = await readyWorld();
  const exp = new w.ReferenceExporter(7, MINUTE_1230 - 3_600_000);
  await exp.send(w.session('e1', 's1'), exp.batch([exp.exportItem([FLOW_1GB], 1_760_270_000)]));
  await runPastClosure(w);
  assert.deepEqual((w.alerts as MemoryAlerts).alerts, []);
});
