import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESULTS, RuntimeDouble, feedEvent } from '@share/owner-runtime/testing';
import { decodeJson, encodeJson, hlc, utf8, validateDeclaration } from '@share/owner-runtime';
import {
  MemoryAlerts, sourceRefDigest, type CatalogueEntity, type CatalogueEvent, type ChargeLineBatch, type Part, type PartBatch, type PostingAck,
} from '@share/rate-common';
import { ingestDeclaration } from '@share/ingestion';
import {
  CatalogueOwner, CatalogueReplica, RatingOwner, StageBOwner, attrADeclaration, attrBDeclaration, catalogueDeclaration,
  leadTimeRefusal, ratingDeclaration, spread, ATTR_B_ENTRY, TOPIC_POSTING_ACKS, type StageBInput,
} from '../src/index.ts';
import { LedgerDouble } from '../testing/index.ts';
import { CATALOGUE, DEPLOY_AT, FLOW_1GB, MINUTE_1230, chargeBatches, readyWorld, runPastClosure } from './fixture.ts';

const noSleep = async (): Promise<void> => {};

test('should keep a record in one part inside one minute, and split it exactly and half-open when it crosses a boundary (POL-13 spread)', () => {
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

test('C06 CT-L4, CT-L5, CT-L6 subset on the settlement double (C06 §8 provider): duplicate line, conflict, lineCount, recorded answer', async () => {
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

test('should raise no alert when the walking skeleton runs', async () => {
  const w = await readyWorld();
  const exp = new w.ReferenceExporter(7, MINUTE_1230 - 3_600_000);
  await exp.send(w.session('e1', 's1'), exp.batch([exp.exportItem([FLOW_1GB], 1_760_270_000)]));
  await runPastClosure(w);
  assert.deepEqual((w.alerts as MemoryAlerts).alerts, []);
});

const at = (hms: string): number => Date.parse(`2026-10-12T${hms}Z`);

test('should bind each part at the later of the record start and the minute start when a record crosses minutes', () => {
  assert.deepEqual(spread(at('12:05:30'), at('12:07:00'), 3_000_000_000n).map((p) => p.bindTimeMs), [at('12:05:30'), at('12:06:00')]);
});

function priceEvent(seq: number, body: Omit<Extract<CatalogueEntity, { entityType: 'price_version' }>, 'entityType' | 'announcedAt'>): CatalogueEvent {
  return { type: 'CatalogueEvent', schemaVersion: 1,
    eventId: { partition: `price:${seq}`, stream: 'catalogue', streamSeq: '1', generation: 0, epoch: 1 },
    entityVersion: '1', committedAt: '1.0000000000', principal: 'deploy',
    body: { entityType: 'price_version', announcedAt: '1.0000000000', ...body } };
}

test('should give the usage_price of the asked product and kind when the route has other products and a reservation_price', () => {
  const r = new CatalogueReplica();
  r.applyEvent(priceEvent(1, { product: 'be', route: 'r1', priceKind: 'usage_price', priceVersion: 'pv-r1-10000', price: '10000000000', effectiveFrom: '2026-10-02T00:00:00Z' }));
  r.applyEvent(priceEvent(2, { product: 'be2', route: 'r1', priceKind: 'usage_price', priceVersion: 'pv-be2-r1-13000', price: '13000000000', effectiveFrom: '2026-10-05T00:00:00Z' }));
  r.applyEvent(priceEvent(3, { product: 'be', route: 'r1', priceKind: 'reservation_price', priceVersion: 'rp-r1', price: '1500000', effectiveFrom: '2026-10-08T00:00:00Z' }));
  assert.deepEqual(r.usagePriceAt('be', 'r1', at('12:05:00')), { price: 10_000_000_000n, priceVersion: 'pv-r1-10000' });
  assert.deepEqual(r.usagePriceAt('be2', 'r1', at('12:05:00')), { price: 13_000_000_000n, priceVersion: 'pv-be2-r1-13000' });
  assert.equal(r.usagePriceAt('be', 'r2', at('12:05:00')), undefined);
  assert.equal(r.usagePriceAt('be2', 'r1', Date.parse('2026-10-04T23:59:00Z')), undefined);
});

test('should alert and apply nothing when a part batch holds a part whose bytes are not an integer over a positive integer', async () => {
  for (const [num, den] of [['1', '0'], ['1', '-7'], ['1.5', '2'], ['x1', '2'], ['1', '2x'], ['1x', '2'], ['1', 'x2']]) {
    const rrt = new RuntimeDouble({ declaration: ratingDeclaration, startMs: DEPLOY_AT });
    const alerts = new MemoryAlerts();
    const rating = new RatingOwner(rrt, { catalogue: new CatalogueReplica(), homeLedgerPartition: LedgerDouble.home, alerts, sleep: noSleep });
    const part: Part = { recordIdentity: { kind: 'record', id: { format: 'ipfix', exporterId: 'e1', observationDomain: 7, epoch: 0, extSeq: '1' } },
      bindingPosition: '1', acceptedAtMs: at('12:06:00'), lastMinuteEndMs: at('12:06:00'), minuteMs: at('12:05:00'),
      bytes: { num: num as string, den: den as string }, class: 'best-effort', accountId: 'a1', productId: 'be', routeId: 'r1', reservationId: null,
      op: { exporterId: 'e1', observationDomain: 7, ifIndex: 3, direction: 'egress' }, linkId: 'L1' };
    await rating.applyParts({ account: 'a1', attrBSeq: '1', parts: [part], bindingFacts: [] });
    assert.deepEqual(alerts.alerts.map((a) => [a.owner, a.kind, a.detail]), [['rating', 'INVALID_PART', `attr_b 1: bytes ${num}/${den}`]], `${num}/${den}`);
    assert.equal(rating.stateOf('a1')?.attrBSeq ?? '0', '0');
    assert.deepEqual(rating.stateOf('a1')?.lines ?? {}, {});
    assert.equal(rrt.log(utf8('a1')).length, 0);
  }
});

function weightsEvent(seq: number, route: string, weightsVersion: string, effectiveFrom: string): CatalogueEvent {
  return { type: 'CatalogueEvent', schemaVersion: 1,
    eventId: { partition: `weights:${seq}`, stream: 'catalogue', streamSeq: '1', generation: 0, epoch: 1 },
    entityVersion: '1', committedAt: '1.0000000000', principal: 'deploy',
    body: { entityType: 'split_weights', route, weightsVersion, effectiveFrom, announcedAt: '1.0000000000',
      legs: [{ link: 'L1', supplier: 's1', weight: 1 }], commissionWeight: 1 } };
}

test('should take the latest effectiveFrom at or before the minute when price and weight versions arrive out of order', () => {
  const r = new CatalogueReplica();
  r.applyEvent(priceEvent(1, { product: 'be', route: 'r1', priceKind: 'usage_price', priceVersion: 'pv-late', price: '13000000000', effectiveFrom: '2026-10-12T12:20:00Z' }));
  r.applyEvent(priceEvent(2, { product: 'be', route: 'r1', priceKind: 'usage_price', priceVersion: 'pv-early', price: '10000000000', effectiveFrom: '2026-10-02T00:00:00Z' }));
  r.applyEvent(priceEvent(3, { product: 'be', route: 'r1', priceKind: 'usage_price', priceVersion: 'pv-mid', price: '11000000000', effectiveFrom: '2026-10-05T00:00:00Z' }));
  assert.equal(r.usagePriceAt('be', 'r1', at('12:19:00'))?.priceVersion, 'pv-mid');
  assert.equal(r.usagePriceAt('be', 'r1', at('12:20:00'))?.priceVersion, 'pv-late');
  r.applyEvent(weightsEvent(4, 'r1', 'w-late', '2026-10-12T12:20:00Z'));
  r.applyEvent(weightsEvent(5, 'r1', 'w-early', '2026-10-02T00:00:00Z'));
  r.applyEvent(weightsEvent(6, 'r1', 'w-mid', '2026-10-05T00:00:00Z'));
  r.applyEvent(weightsEvent(7, 'r2', 'w-r2', '2026-10-01T00:00:00Z'));
  assert.equal(r.weightsAt('r1', at('12:19:00'))?.weightsVersion, 'w-mid');
  assert.equal(r.weightsAt('r1', at('12:20:00'))?.weightsVersion, 'w-late');
  assert.equal(r.weightsAt('r1', Date.parse('2026-10-01T23:59:00Z')), undefined);
  assert.equal(r.weightsAt('r2', at('12:19:00'))?.weightsVersion, 'w-r2');
  assert.equal(r.weightsVersion('w-r2')?.route, 'r2');
  assert.equal(r.weightsVersion('w-none'), undefined);
});

test('should keep the latest resolved timestamp and the product kinds when the replica applies the feed', () => {
  const r = new CatalogueReplica();
  assert.deepEqual(r.position(), { resolvedTs: '0.0000000000' });
  r.onResolved(hlc('2000.0000000000'));
  r.onResolved(hlc('1000.0000000000'));
  assert.deepEqual(r.position(), { resolvedTs: '2000.0000000000' });
  r.onResolved(hlc('3000.0000000000'));
  assert.deepEqual(r.position(), { resolvedTs: '3000.0000000000' });
  assert.equal(r.productKind('be'), undefined);
  r.applyEvent({ type: 'CatalogueEvent', schemaVersion: 1,
    eventId: { partition: 'product:be', stream: 'catalogue', streamSeq: '1', generation: 0, epoch: 1 },
    entityVersion: '1', committedAt: '1.0000000000', principal: 'deploy',
    body: { entityType: 'product', productId: 'be', kind: 'best_effort', permitsBurst: false } });
  assert.equal(r.productKind('be'), 'best_effort');
});
