import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  canonicalSourceRefBytes, checkChargeLineBatch, checkFigure, sourceRefDigest,
  type UnpostedUsageFigure,
} from '@share/rate-common';
import { RATING_ENTRY, TOPIC_UNPOSTED } from '../src/index.ts';
import { hlcToWallMs } from '@share/owner-runtime';
import { FLOW_1GB, MINUTE_1230, chargeBatches, readyWorld, runPastClosure } from './fixture.ts';
import type { World } from '../testing/index.ts';

async function sendFlow(w: World, region: 'R1' | 'R2' = 'R1') {
  const exp = new w.ReferenceExporter(7, MINUTE_1230 - 3_600_000);
  const s = w.session('e1', 's1', region);
  const item = exp.exportItem([FLOW_1GB], Math.floor(w.bus.nowMs / 1000));
  await exp.send(s, exp.batch([item]));
  await w.bus.settle();
  return { exp, item, s };
}

function u(w: World): bigint {
  return w.accountOwner.unposted('a1', 'p1');
}

test('P3-S25: 1 GB of attachment-class traffic at 12:30 outside any reservation is charged 10,000 micro-USD and counts in U until posted', async () => {
  const w = await readyWorld();
  await sendFlow(w);
  await w.bus.advance(3_000); // the 2 s figure interval
  // Counted in usage exposure (POL-18) before the minute closes: V(L) includes open minutes.
  assert.equal(u(w), 10_000n);
  assert.equal(chargeBatches(w).length, 0);

  await runPastClosure(w, MINUTE_1230 + 5 * 60_000 + 14_000);
  assert.equal(chargeBatches(w).length, 0, 'the usage minute is not closed before m + 60 + 60 + 180 + 15 s');
  assert.equal(u(w), 10_000n);
  await runPastClosure(w);

  const batches = chargeBatches(w);
  assert.equal(batches.length, 1);
  const b = batches[0];
  assert.ok(b);
  assert.equal(b.batch.kind, 'usage');
  assert.equal(b.batch.gated, true);
  assert.equal(b.batch.lineCount, 1);
  assert.deepEqual(b.lines, [{
    sourceRef: { kind: 'usage', account: 'a1', product: 'p1', route: 'r1', minute: '2026-10-12T12:30:00Z', seq: 0 },
    lineKind: 'usage', account: 'a1', product: 'p1', route: 'r1', weightsVersion: 'w1', minute: '2026-10-12T12:30:00Z',
    payer: 'account', amount: '10000', newTotal: '10000', priorTotal: '0', reason: 'original',
    reasonDetails: { priceVersion: 'pv1' }, priceCatalogue: b.lines[0]?.priceCatalogue,
  }]);
  // Settlement posted it as one M5 movement.
  assert.equal(w.ledger.movements.length, 1);
  assert.equal(w.ledger.movements[0]?.lines[0]?.kind, 'M5');
  assert.equal(w.ledger.movements[0]?.lines[0]?.amount, '-10000');
  assert.deepEqual(w.ledger.movements[0]?.lines[0]?.entries, [
    { ledgerAccount: 'B:a1', amount: '-10000' }, { ledgerAccount: 'S:s1:earn', amount: '7000' }, { ledgerAccount: 'SH:commission', amount: '3000' },
  ]);
  // After the posted acknowledgement the figure counts 0 (exit criterion 1).
  assert.equal(u(w), 0n);
  const line = w.rating.stateOf('a1')?.lines['p1|r1|' + MINUTE_1230];
  assert.equal(line?.posted, '10000');
  assert.equal(line?.emitted, '10000');
  assert.equal(w.rating.stateOf('a1')?.inFlight, undefined);
  // The figures went 10,000 → (names the batch, 10,000 with Δ_b 10,000) → 0.
  const figs = w.bus.eventsOn<UnpostedUsageFigure>(TOPIC_UNPOSTED);
  const named = figs.find((f) => f.inFlightUsageBatch === b.batch.id);
  assert.deepEqual(named?.products, [{ product: 'p1', unpostedUsage: '10000', usageReduction: '10000' }]);
  assert.deepEqual(figs[figs.length - 1]?.products, [{ product: 'p1', unpostedUsage: '0' }]);
  assert.equal(figs[figs.length - 1]?.ledgerPositionX.sequence, '1');
  assert.deepEqual(w.alerts.alerts, []);
});

test('should not charge twice when a record is resent verbatim (to the other region, and after the line is posted): one line of 10,000', async () => {
  const w = await readyWorld();
  const { exp, item } = await sendFlow(w);
  // The ack is "lost": the exporter resends the same item to the other region.
  const s2 = w.session('e1', 's1', 'R2');
  await exp.send(s2, exp.batch([item]));
  await w.bus.settle();
  assert.equal(exp.acks[1]?.items[0]?.message.duplicates, 1);
  await runPastClosure(w);
  await exp.send(s2, exp.batch([item]));
  await runPastClosure(w, MINUTE_1230 + 8 * 60_000);
  const lines = chargeBatches(w).flatMap((b) => b.lines);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.amount, '10000');
  assert.equal(w.ledger.movements.length, 1);
  assert.equal(u(w), 0n);
});

test('C11 test 12 / I1 exit criterion 2: with the direct publish of ingest_log and of the stage A outbox stopped, the relay alone gives the same line', async () => {
  const direct = await readyWorld('off');
  await sendFlow(direct);
  await runPastClosure(direct);
  const relayOnly = await readyWorld('only');
  await sendFlow(relayOnly);
  await runPastClosure(relayOnly);
  const strip = (w: World) => chargeBatches(w).flatMap((b) => b.lines).map(({ priceCatalogue: _p, ...rest }) => rest);
  assert.equal(strip(relayOnly).length, 1);
  assert.deepEqual(strip(relayOnly), strip(direct));
  assert.ok(relayOnly.bus.deliveries.some((d) => d.topic === 'ingestion.handoff.v1' && d.path === 'relay'));
  assert.ok(!relayOnly.bus.deliveries.some((d) => d.topic === 'ingestion.handoff.v1' && d.path === 'direct'));
});

test('C01 CC-6 / C11 test 16: both publish paths (every hand-off and part batch delivered twice) give the same single line', async () => {
  const w = await readyWorld('both');
  await sendFlow(w);
  await runPastClosure(w);
  assert.ok(w.bus.deliveries.filter((d) => d.topic === 'attribution.parts.v1').length >= 2);
  const lines = chargeBatches(w).flatMap((b) => b.lines);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.amount, '10000');
  assert.equal(u(w), 0n);
});

test('C06 CT-R1: every emitted figure and charge-line batch agrees with the C06 schema; canonical SourceRef vector', async () => {
  const w = await readyWorld();
  await sendFlow(w);
  await runPastClosure(w);
  for (const f of w.bus.eventsOn<UnpostedUsageFigure>(TOPIC_UNPOSTED)) assert.deepEqual(checkFigure(f), [], JSON.stringify(f));
  for (const b of chargeBatches(w)) assert.deepEqual(checkChargeLineBatch(b), []);
  assert.deepEqual(w.settlement.schemaErrors, []);
  // Fixed vector: kind tag first, fields in schema order, u32 big-endian length prefix, UTF-8, SHA-256.
  const ref = { kind: 'usage' as const, account: 'a1', product: 'p1', route: 'r1', minute: '2026-10-12T12:30:00Z', seq: 0 };
  assert.equal(Buffer.from(canonicalSourceRefBytes(ref)).toString('hex'),
    '00000005' + Buffer.from('usage').toString('hex') + '00000002' + Buffer.from('a1').toString('hex')
    + '00000002' + Buffer.from('p1').toString('hex') + '00000002' + Buffer.from('r1').toString('hex')
    + '00000014' + Buffer.from('2026-10-12T12:30:00Z').toString('hex') + '00000001' + Buffer.from('0').toString('hex'));
  assert.equal(sourceRefDigest(ref), createHash('sha256').update(canonicalSourceRefBytes(ref)).digest('hex'));
  assert.notEqual(sourceRefDigest(ref), sourceRefDigest({ ...ref, seq: 1 }));
});

test('C06 CT-R4 (first clause): while UsageApplied is held back, rating emits no gated usage batch; on release it emits one', async () => {
  const w = await readyWorld();
  await sendFlow(w);
  w.accountOwner.holdAcks = true;
  await runPastClosure(w);
  assert.equal(chargeBatches(w).length, 0);
  assert.ok(w.rating.stateOf('a1')?.inFlight?.namedAt, 'a figure names the batch');
  await w.accountOwner.releaseAcks();
  await w.bus.settle();
  await w.bus.advance(5_000);
  assert.equal(chargeBatches(w).length, 1);
  assert.equal(u(w), 0n);
});

test('C06 CT-R4 (second clause): an older UsageApplied, sent again, does not lower the gate', async () => {
  const w = await readyWorld();
  await sendFlow(w);
  await w.bus.advance(3_000);
  const early = w.accountOwner.applied[0];
  assert.ok(early);
  w.accountOwner.holdAcks = true;
  await runPastClosure(w);
  await w.accountOwner.redeliver(early);
  await w.bus.settle();
  assert.equal(chargeBatches(w).length, 0);
});

function closedAtMs(w: World): number | undefined {
  const e = w.rts.rating.log(Buffer.from('a1')).find((x) => x.entry.kind === RATING_ENTRY.usageClosed);
  return e ? hlcToWallMs(e.ts) : undefined;
}

test('should close the usage minute at m + 60 + 60 + 180 + 15 s once the stage A watermark is there, and hold it only to the + 45 s bound when a stage A partition stalls (RFC-003 §5.6)', async () => {
  const w = await readyWorld();
  await sendFlow(w);
  await runPastClosure(w);
  const base = MINUTE_1230 + 300_000;
  assert.ok((closedAtMs(w) ?? 0) >= base + 15_000 && (closedAtMs(w) ?? 0) < base + 16_000, 'closed by the watermark at + 15 s');
  // Two hand-off destination partitions; the second never reports a watermark.
  const stalled = await readyWorld('off', 2);
  await sendFlow(stalled);
  await runPastClosure(stalled, base + 44_000);
  assert.equal(closedAtMs(stalled), undefined);
  assert.equal(chargeBatches(stalled).length, 0);
  await runPastClosure(stalled, base + 60_000);
  assert.ok((closedAtMs(stalled) ?? 0) >= base + 45_000 && (closedAtMs(stalled) ?? 0) < base + 46_000, 'closed at the hard bound');
  assert.equal(chargeBatches(stalled)[0]?.lines[0]?.amount, '10000');
});
