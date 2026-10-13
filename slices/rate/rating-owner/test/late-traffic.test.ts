import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hlc, hlcFromWallMs, hlcToWallMs, utf8 } from '@share/owner-runtime';
import { checkChargeLineBatch, type ChargeLine, type ObservationPoint, type Part, type SourceRef, type UnpostedUsageFigure } from '@share/rate-common';
import { RATING_ENTRY, TOPIC_UNPOSTED, type FixtureEntity } from '../src/index.ts';
import { buildWorld, type World } from '../testing/index.ts';
import { DEPLOY_AT, chargeBatches } from './fixture.ts';

const at = (hms: string): number => Date.parse(`2026-10-12T${hms}Z`);
const GB = 1_000_000_000n;

/**
 * The I4 fixture: best-effort product "be" of account a1 on route r1 (VLAN 100). usage_price 10,000 micro-USD per GB
 * until 12:20 and 13,000 from 12:20 (pico-USD per GB, C06 Conventions). Split weights w-r1: s1 7, commission 3.
 */
const CATALOGUE_I4: FixtureEntity[] = [
  { entityType: 'product', productId: 'be', kind: 'best_effort', permitsBurst: false },
  { entityType: 'route', routeId: 'r1', legs: ['L1'] },
  { entityType: 'price_version', product: 'be', route: 'r1', priceKind: 'usage_price', priceVersion: 'pv-r1-10000',
    price: '10000000000', effectiveFrom: '2026-10-02T00:00:00Z' },
  { entityType: 'price_version', product: 'be', route: 'r1', priceKind: 'usage_price', priceVersion: 'pv-r1-13000',
    price: '13000000000', effectiveFrom: '2026-10-12T12:20:00Z' },
  { entityType: 'split_weights', route: 'r1', weightsVersion: 'w-r1', effectiveFrom: '2026-09-01T00:02:00Z',
    legs: [{ link: 'L1', supplier: 's1', weight: 7 }], commissionWeight: 3 },
];

const OP: ObservationPoint = { exporterId: 'e1', observationDomain: 7, ifIndex: 3, direction: 'egress' };

/** A world with the I4 catalogue, the binding of a1 on r1 from 11:00, and the clock at `startAt`. */
async function lateWorld(startAt: number, handoffPartitions = 1): Promise<World> {
  const w = buildWorld({ startMs: DEPLOY_AT, handoffPartitions });
  await w.deploy(CATALOGUE_I4);
  const from = at('11:00:00');
  await w.bus.jump(from - w.bus.nowMs);
  await w.provisioning.observationPoint(OP, 'L1', from);
  await w.provisioning.binding({ op: OP, serviceTag: { vlan: { outer: 100 } }, accountId: 'a1', productId: 'be', routeId: 'r1',
    validFromMs: from, bindingId: 'b-r1' });
  await w.bus.jump(startAt - w.bus.nowMs);
  await w.provisioning.heartbeat('e1');
  await w.bus.settle();
  return w;
}

interface Flow { start: string; end: string; bytes: bigint }

/** The exporter e1 and one session. */
function exporter(w: World) {
  return { exp: new w.ReferenceExporter(OP.observationDomain, at('10:00:00')), s: w.session('e1', 's1') };
}

/** Send the flows in one export message at the current time; each record must be accepted. */
async function send(w: World, x: ReturnType<typeof exporter>, flows: Flow[]): Promise<void> {
  const item = x.exp.exportItem(flows.map((f) => ({ startMs: at(f.start), endMs: at(f.end), bytes: f.bytes, ifIndex: OP.ifIndex, vlan: 100 })),
    Math.floor(w.bus.nowMs / 1000));
  await x.exp.send(x.s, x.exp.batch([item]));
  await w.bus.settle();
  assert.equal(x.exp.acks[x.exp.acks.length - 1]?.items[0]?.message.accepted, flows.length);
}

/** Run the clock to `untilMs` in 1 s steps, with provisioning heartbeats. */
async function runTo(w: World, untilMs: number): Promise<void> {
  await w.bus.advance(untilMs - w.bus.nowMs, 1_000, async () => {
    if (w.bus.nowMs % 5_000 === 0) await w.provisioning.heartbeat('e1');
  });
}

type Line = ChargeLine & { emittedAt: string };

function lines(w: World): Line[] {
  return chargeBatches(w).flatMap((b) => b.lines.map((l) => ({ ...l, emittedAt: b.emittedAt })));
}

/** The record identities in `reasonDetails.records` of a line (none for an original). */
function recordsOf(l: ChargeLine): unknown[] {
  const parsed: unknown = JSON.parse(l.reasonDetails?.['records'] ?? '[]');
  assert.ok(Array.isArray(parsed));
  return parsed;
}

const seqOf = (r: SourceRef): number => ('seq' in r ? r.seq : -1);

/** Each emitted line as [minute, seq, reason, amount, newTotal, priorTotal]. */
function summary(w: World): Array<[string, number, string, string, string, string]> {
  return lines(w).map((l) => [(l.minute ?? '').slice(11, 16), seqOf(l.sourceRef), l.reason, l.amount, l.newTotal, l.priorTotal]);
}

interface AmendmentEntryLine { product: string; route: string; minute: string; seq: number; amount: string; newTotal: string;
  priorTotal: string; reason: string; records: string[]; elaS: string; elaR: string }

function amendmentEntries(w: World): AmendmentEntryLine[] {
  return w.rts.rating.log(utf8('a1')).filter((e) => e.entry.kind === RATING_ENTRY.amendment)
    .flatMap((e) => (e.entry.payload as { lines: AmendmentEntryLine[] }).lines);
}

const lineKey = (minute: string): string => `be|r1|${at(minute)}`;

const usageRef = (minute: string, seq: number): SourceRef =>
  ({ kind: 'usage', account: 'a1', product: 'be', route: 'r1', minute: `2026-10-12T${minute}:00Z`, seq });

/** The C11 derived identity of the IPFIX record of exporter e1 with extended sequence `extSeq`, as JSON with sorted keys. */
const recordId = (extSeq: string): string =>
  `{"id":{"epoch":1,"exporterId":"e1","extSeq":"${extSeq}","format":"ipfix","observationDomain":7},"kind":"record"}`;

/** The figures (C06 §3) that name the usage batch `batchId`, in order. */
function figuresNaming(w: World, batchId: string): UnpostedUsageFigure[] {
  return w.bus.eventsOn<UnpostedUsageFigure>(TOPIC_UNPOSTED).filter((f) => f.inFlightUsageBatch === batchId);
}

test('P3-S32 a minute charged 10,000 for 1 GB gets a late 1 GB: an amendment of 10,000 with the reason late traffic on the new total 20,000, and the original stays 10,000', async () => {
  const w = await lateWorld(at('12:06:30'));
  const x = exporter(w);
  await send(w, x, [{ start: '12:05:10', end: '12:05:50', bytes: GB }]);
  await runTo(w, at('12:11:00'));
  assert.deepEqual(summary(w), [['12:05', 0, 'original', '10000', '10000', '0']]);

  await send(w, x, [{ start: '12:05:20', end: '12:05:40', bytes: GB }]);
  await runTo(w, at('12:13:00'));
  assert.deepEqual(summary(w), [
    ['12:05', 0, 'original', '10000', '10000', '0'],
    ['12:05', 1, 'late_traffic', '10000', '20000', '10000'],
  ]);
  const amendment = lines(w)[1] as Line;
  assert.equal(amendment.weightsVersion, 'w-r1');
  assert.equal(amendment.payer, 'account');
  assert.equal(amendment.cause, undefined);
  assert.equal(amendment.reasonDetails?.['priceVersion'], 'pv-r1-10000');
  assert.deepEqual(recordsOf(amendment).map((r) => JSON.stringify(r)), [recordId('1')]);
  for (const b of chargeBatches(w)) assert.deepEqual(checkChargeLineBatch(b), []);

  // Settlement posts the amendment as M6: the buyer pays the difference, each party gets split(20,000) − split(10,000).
  assert.deepEqual(w.ledger.movements.map((m) => m.lines.map((l) => [l.kind, l.reason, l.postedTotal, l.entries])), [
    [['M5', 'original', '10000', [{ ledgerAccount: 'B:a1', amount: '-10000' }, { ledgerAccount: 'S:s1:earn', amount: '7000' },
      { ledgerAccount: 'SH:commission', amount: '3000' }]]],
    [['M6', 'late_traffic', '20000', [{ ledgerAccount: 'B:a1', amount: '-10000' }, { ledgerAccount: 'S:s1:earn', amount: '7000' },
      { ledgerAccount: 'SH:commission', amount: '3000' }]]],
  ]);
  assert.equal(w.ledger.postedTotal(usageRef('12:05', 0)), 10_000n, 'the original is not changed');
  assert.equal(w.ledger.postedTotal(usageRef('12:05', 1)), 20_000n);
  const line = w.rating.stateOf('a1')?.lines[lineKey('12:05:00')];
  assert.deepEqual([line?.emitted, line?.posted, line?.ela.S], ['20000', '20000', 2n * GB]);
  // The amendment entry fixes the line before it is emitted (RFC-003 §5.1, §5.8).
  assert.deepEqual(amendmentEntries(w).map((e) => [e.minute, e.seq, e.reason, e.amount, e.newTotal, e.priorTotal, e.elaS, e.elaR]),
    [['2026-10-12T12:05:00Z', 1, 'late_traffic', '10000', '20000', '10000', '2000000000', '{}']]);
  assert.equal(w.accountOwner.unposted('a1', 'be'), 0n);
  // A line inside amendment_hot_window is in memory: no read of the line row.
  assert.equal(w.rts.rating.appends.some((a) => a.call.reads !== undefined), false);
  assert.deepEqual(w.alerts.alerts, []);
});

test('should post a late original at seq 0 when a line closed at 0 gets late traffic (P3-S32 row 2 conflicts with C06 m5)', async () => {
  const w = await lateWorld(at('12:06:30'));
  const x = exporter(w);
  await send(w, x, [{ start: '12:05:10', end: '12:05:50', bytes: 75_000n }]);
  await runTo(w, at('12:11:00'));
  const closed = w.rts.rating.log(utf8('a1')).filter((e) => e.entry.kind === RATING_ENTRY.usageClosed)
    .flatMap((e) => (e.entry.payload as { lines: Array<{ amount: string }> }).lines.map((l) => l.amount));
  assert.deepEqual(closed, ['0']);
  assert.deepEqual(summary(w), [], 'a line of 0 micro-USD is not sent');

  await send(w, x, [{ start: '12:05:20', end: '12:05:40', bytes: 75_000n }]);
  await runTo(w, at('12:13:00'));
  assert.deepEqual(amendmentEntries(w).map((e) => [e.seq, e.reason, e.amount, e.newTotal, e.priorTotal]), [[0, 'late_traffic', '1', '1', '0']]);
  // The ledger has no posting of the line key, so the line goes as its late original (seq 0, reason original, the trigger
  // in triggerRef and reasonDetails, C06 m5). P3-S32 row 2 and RFC-003 §5.7 want an amendment of 1 on an original of 0:
  // C06 permits no such output (design issue (I4) 1, contracts/suites/ISSUES.md CS-10).
  assert.deepEqual(summary(w), [['12:05', 0, 'original', '1', '1', '0']]);
  const l = lines(w)[0] as Line;
  assert.equal(l.reasonDetails?.['trigger'], 'late_traffic');
  assert.equal(l.triggerRef, recordId('1'));
  assert.deepEqual(recordsOf(l).map((r) => JSON.stringify(r)), [recordId('1')]);
  // What is actually posted: the original of the line key is 1 (M5), and there is no amendment.
  assert.deepEqual(w.ledger.movements.map((m) => m.lines.map((y) => [y.kind, y.reason, y.amount, y.postedTotal, y.triggerRef])),
    [[['M5', 'original', '-1', '1', recordId('1')]]]);
  assert.equal(w.ledger.postedTotal(usageRef('12:05', 0)), 1n, 'the posted original is 1, not 0');
  assert.equal(w.ledger.postedTotal(usageRef('12:05', 1)), undefined, 'no amendment is posted');
  // The late original is acknowledged posted: the line is posted and no batch stays in flight.
  const line = w.rating.stateOf('a1')?.lines[lineKey('12:05:00')];
  assert.deepEqual([line?.emitted, line?.posted, line?.seq], ['1', '1', 0]);
  assert.equal(w.rating.stateOf('a1')?.inFlight, undefined);
  assert.deepEqual(w.alerts.alerts, []);
});

test('should emit no amendment and no charge line when a late record does not change the floor of the line, and use the next sequence for the next change', async () => {
  const w = await lateWorld(at('12:06:30'));
  const x = exporter(w);
  await send(w, x, [{ start: '12:05:10', end: '12:05:50', bytes: GB }]);
  await runTo(w, at('12:11:00'));
  // 50,000 bytes at 10,000 micro-USD per GB is 0.5 micro-USD: ⌊10,000.5⌋ = 10,000 = E.
  await send(w, x, [{ start: '12:05:20', end: '12:05:40', bytes: 50_000n }]);
  await runTo(w, at('12:13:00'));
  assert.deepEqual(summary(w), [['12:05', 0, 'original', '10000', '10000', '0']]);
  assert.deepEqual(amendmentEntries(w), []);
  assert.equal(w.ledger.movements.length, 1);
  assert.equal(w.rating.stateOf('a1')?.inFlight, undefined, 'no usage batch stays in flight');
  assert.equal(w.rating.stateOf('a1')?.lines[lineKey('12:05:00')]?.late, undefined);
  assert.deepEqual(w.alerts.alerts, []);

  // ⌊20,000.5⌋ − 10,000: the sequence 1 was not used by the unchanged floor.
  await send(w, x, [{ start: '12:05:20', end: '12:05:40', bytes: GB }]);
  await runTo(w, at('12:15:00'));
  assert.deepEqual(summary(w), [['12:05', 0, 'original', '10000', '10000', '0'], ['12:05', 1, 'late_traffic', '10000', '20000', '10000']]);
  assert.deepEqual(recordsOf(lines(w)[1] as Line).map((r) => JSON.stringify(r)), [recordId('2')]);
  assert.equal(w.ledger.postedTotal(usageRef('12:05', 1)), 20_000n);
  assert.deepEqual(w.alerts.alerts, []);
});

test('should emit nothing and keep no batch in flight when a line closed at 0 gets a late record that leaves its floor at 0', async () => {
  const w = await lateWorld(at('12:06:30'));
  const x = exporter(w);
  await send(w, x, [{ start: '12:05:10', end: '12:05:50', bytes: 75_000n }]);
  await runTo(w, at('12:11:00'));
  // ⌊0.75 + 0.0001⌋ = 0 = E.
  await send(w, x, [{ start: '12:05:20', end: '12:05:40', bytes: 10n }]);
  await runTo(w, at('12:14:00'));
  assert.deepEqual(summary(w), []);
  assert.deepEqual(amendmentEntries(w), []);
  assert.equal(w.ledger.movements.length, 0);
  assert.equal(w.rating.stateOf('a1')?.inFlight, undefined);
  assert.deepEqual(w.alerts.alerts, []);
});

test('P3-S20 a late 1 GB for the minute starting 12:05, after 12:05 and 12:25 were charged, is charged 10,000 at the price in force in 12:05, not 13,000', async () => {
  const w = await lateWorld(at('12:06:30'));
  const x = exporter(w);
  await send(w, x, [{ start: '12:05:10', end: '12:05:50', bytes: GB }]);
  await runTo(w, at('12:26:00'));
  await send(w, x, [{ start: '12:25:10', end: '12:25:50', bytes: GB }]);
  await runTo(w, at('12:31:00'));
  assert.deepEqual(summary(w), [['12:05', 0, 'original', '10000', '10000', '0'], ['12:25', 0, 'original', '13000', '13000', '0']]);

  await send(w, x, [{ start: '12:05:00', end: '12:06:00', bytes: GB }]);
  await runTo(w, at('12:33:00'));
  assert.deepEqual(summary(w).slice(2), [['12:05', 1, 'late_traffic', '10000', '20000', '10000']]);
  assert.equal(lines(w)[2]?.reasonDetails?.['priceVersion'], 'pv-r1-10000');
  assert.equal(w.ledger.postedTotal(usageRef('12:25', 0)), 13_000n);
  assert.equal(w.ledger.postedTotal(usageRef('12:25', 1)), undefined, 'the late record does not touch 12:25');
});

test('should emit a late original, seq 0 with the reason original and the late records as its trigger, when a record arrives for a closed minute of the account that had no line', async () => {
  const w = await lateWorld(at('12:08:30'));
  const x = exporter(w);
  await send(w, x, [{ start: '12:08:10', end: '12:08:50', bytes: GB }]);
  await runTo(w, at('12:14:00'));
  await send(w, x, [{ start: '12:07:10', end: '12:07:50', bytes: GB }]);
  await runTo(w, at('12:16:00'));
  assert.deepEqual(summary(w), [['12:08', 0, 'original', '10000', '10000', '0'], ['12:07', 0, 'original', '10000', '10000', '0']]);
  const late = lines(w)[1] as Line;
  assert.equal(late.reasonDetails?.['trigger'], 'late_traffic');
  assert.equal(late.weightsVersion, 'w-r1');
  assert.equal(late.triggerRef, recordId('1'));
  assert.deepEqual(amendmentEntries(w).map((e) => [e.minute, e.seq, e.reason, e.amount]), [['2026-10-12T12:07:00Z', 0, 'late_traffic', '10000']]);
  assert.deepEqual(w.ledger.movements.map((m) => m.lines.map((l) => l.kind)), [['M5'], ['M5']]);
});

test('P3-S17 records that arrive while the minute starting 12:05 is being charged are each in its original or in an amendment, exactly once', async () => {
  const w = await lateWorld(at('12:06:30'));
  const x = exporter(w);
  await send(w, x, [{ start: '12:05:10', end: '12:05:50', bytes: GB }]);
  // Four records a second from 12:10:05 to 12:10:25; the closing entry comes at 12:10:15 (m + 60 + 60 + 180 + 15 s).
  let sent = 1;
  await w.bus.advance(at('12:10:05') - w.bus.nowMs, 1_000);
  await w.bus.advance(at('12:10:26') - w.bus.nowMs, 1_000, async () => {
    if (w.bus.nowMs % 5_000 === 0) await w.provisioning.heartbeat('e1');
    await send(w, x, Array.from({ length: 4 }, () => ({ start: '12:05:10', end: '12:05:50', bytes: GB })));
    sent += 4;
  });
  await runTo(w, at('12:14:00'));
  const log = w.rts.rating.log(utf8('a1'));
  const closing = log.find((e) => e.entry.kind === RATING_ENTRY.usageClosed);
  assert.ok(closing);
  const partsBefore = log.filter((e) => e.entry.kind === RATING_ENTRY.inputs && e.seq < closing.seq)
    .reduce((n, e) => n + ((e.entry.payload as { parts?: number }).parts ?? 0), 0);
  const partsAll = log.filter((e) => e.entry.kind === RATING_ENTRY.inputs)
    .reduce((n, e) => n + ((e.entry.payload as { parts?: number }).parts ?? 0), 0);
  assert.equal(partsAll, sent, 'each record reaches rating once');
  assert.ok(partsBefore > 1 && partsBefore < sent, `the closing entry falls among the records (${partsBefore} of ${sent})`);
  const closed = (closing.entry.payload as { lines: Array<{ amount: string; elaS: string }> }).lines;
  assert.deepEqual(closed, [{ ...closed[0], amount: String(10_000 * partsBefore), elaS: String(BigInt(partsBefore) * GB) }]);
  const all = lines(w);
  assert.equal(all[0]?.amount, String(10_000 * partsBefore), 'the original holds what rating applied before the closing entry');
  assert.deepEqual(all.slice(1).map((l) => [l.reason, l.amount]), [['late_traffic', String(10_000 * (sent - partsBefore))]]);
  assert.equal(all.reduce((n, l) => n + BigInt(l.amount), 0n), BigInt(10_000 * sent));
  assert.equal(w.ledger.postedTotal(usageRef('12:05', 1)), BigInt(10_000 * sent));
  // C06 §3: while the original's batch is in flight, Δ_b is the original's amount, also after late parts raised C.
  const named = figuresNaming(w, chargeBatches(w)[0]?.batch.id ?? '');
  assert.ok(named.some((f) => BigInt(f.products[0]?.unpostedUsage ?? '0') > BigInt(10_000 * partsBefore)), 'a figure names the batch after late parts');
  for (const f of named) assert.equal(f.products[0]?.usageReduction, String(10_000 * partsBefore), JSON.stringify(f.products));
});

test('P3-S35 a minute with an original and two amendments: the charge-line feed has each with its reason and emission time, and the ledger each with its posting time', async () => {
  const w = await lateWorld(at('12:06:30'));
  const x = exporter(w);
  await send(w, x, [{ start: '12:05:10', end: '12:05:50', bytes: GB }]);
  await runTo(w, at('12:11:00'));
  // Two late records within amendment_interval (60 s) give one amendment; a third, later, gives the next.
  await send(w, x, [{ start: '12:05:20', end: '12:05:30', bytes: GB }]);
  await runTo(w, at('12:11:30'));
  await send(w, x, [{ start: '12:05:30', end: '12:05:40', bytes: GB }]);
  await runTo(w, at('12:12:10'));
  await send(w, x, [{ start: '12:05:40', end: '12:05:50', bytes: GB }]);
  await runTo(w, at('12:15:00'));
  assert.deepEqual(summary(w), [
    ['12:05', 0, 'original', '10000', '10000', '0'],
    ['12:05', 1, 'late_traffic', '20000', '30000', '10000'],
    ['12:05', 2, 'late_traffic', '10000', '40000', '30000'],
  ]);
  const emitted = lines(w).map((l) => hlcToWallMs(hlc(l.emittedAt)));
  assert.ok((emitted[1] ?? 0) >= at('12:12:00'), 'the first amendment waits amendment_interval after its first late record');
  const formedAt = w.rts.rating.log(utf8('a1')).filter((e) => e.entry.kind === RATING_ENTRY.amendment).map((e) => hlcToWallMs(e.ts));
  assert.equal(formedAt[0], at('12:12:00'), 'formed exactly amendment_interval (60 s) after the first late record (12:11:00)');
  assert.ok((emitted[2] ?? 0) - (emitted[1] ?? 0) >= 60_000, 'at most one amendment of the line in amendment_interval');
  assert.deepEqual(lines(w).map((l) => recordsOf(l).length), [0, 2, 1]);
  // The ledger double gives the CT-L7 fixture: each movement with its posting time, line reason and total.
  const posted = w.ledger.movements.map((m) => [m.lines[0]?.reason, m.lines[0]?.postedTotal, hlcToWallMs(hlc(m.position.commitTs))] as const);
  assert.deepEqual(posted.map(([r, t]) => [r, t]), [['original', '10000'], ['late_traffic', '30000'], ['late_traffic', '40000']]);
  for (let i = 0; i < 3; i++) assert.ok((posted[i]?.[2] ?? 0) >= (emitted[i] ?? Infinity), 'each is posted after it is emitted');
  assert.ok((posted[1]?.[2] ?? 0) < (posted[2]?.[2] ?? 0));
});

test('should emit amendment k + 1 of a line in its own usage batch only when amendment k is acknowledged posted', async () => {
  const w = await lateWorld(at('12:06:30'));
  const x = exporter(w);
  await send(w, x, [{ start: '12:05:10', end: '12:05:50', bytes: GB }]);
  await runTo(w, at('12:11:00'));
  await send(w, x, [{ start: '12:05:20', end: '12:05:30', bytes: GB }]);
  w.accountOwner.holdAcks = true;
  await runTo(w, at('12:12:30'));
  await send(w, x, [{ start: '12:05:30', end: '12:05:40', bytes: GB }]);
  await runTo(w, at('12:16:00'));
  assert.deepEqual(summary(w), [['12:05', 0, 'original', '10000', '10000', '0']], 'amendment 1 waits for its figure to be applied');
  assert.deepEqual(amendmentEntries(w).map((e) => e.seq), [1], 'no amendment 2 while amendment 1 is not posted');
  await w.accountOwner.releaseAcks();
  await runTo(w, at('12:19:00'));
  assert.deepEqual(summary(w), [
    ['12:05', 0, 'original', '10000', '10000', '0'],
    ['12:05', 1, 'late_traffic', '10000', '20000', '10000'],
    ['12:05', 2, 'late_traffic', '10000', '30000', '20000'],
  ]);
  assert.deepEqual(chargeBatches(w).map((b) => b.lines.length), [1, 1, 1]);
  // C06 §3: the figure that names amendment 1's batch after the third record: U = 30,000 − 10,000, Δ_b = its amount 10,000.
  const named = figuresNaming(w, chargeBatches(w)[1]?.batch.id ?? '');
  assert.deepEqual(named[named.length - 1]?.products, [{ product: 'be', unpostedUsage: '20000', usageReduction: '10000' }]);
  for (const f of named) assert.equal(f.products[0]?.usageReduction, '10000');
});

test('should close the usage lines at the bound + 45 s when a stage A partition stalls, and make the records after the close amendments (R3-6)', async () => {
  const w = await lateWorld(at('12:06:30'), 2);
  const x = exporter(w);
  await send(w, x, [{ start: '12:05:10', end: '12:05:50', bytes: GB }]);
  const base = at('12:10:00');
  await runTo(w, base + 30_000);
  assert.deepEqual(summary(w), []);
  // The close timer is armed again at the hard bound when the margin passes with the watermark stalled.
  assert.deepEqual(w.rts.rating.timersOf(utf8('a1')).filter((t) => t.key === 'close'), [{ key: 'close', atTs: hlcFromWallMs(base + 45_000) }]);
  await runTo(w, base + 50_000);
  const closing = w.rts.rating.log(utf8('a1')).find((e) => e.entry.kind === RATING_ENTRY.usageClosed);
  const closedAt = closing ? hlcToWallMs(closing.ts) : 0;
  assert.ok(closedAt >= base + 45_000 && closedAt < base + 46_000, 'closed at the hard bound');
  await send(w, x, [{ start: '12:05:20', end: '12:05:40', bytes: GB }]);
  await runTo(w, at('12:13:00'));
  assert.deepEqual(summary(w), [['12:05', 0, 'original', '10000', '10000', '0'], ['12:05', 1, 'late_traffic', '10000', '20000', '10000']]);
});

test('should read a line closed more than amendment_hot_window (1 h) ago back from its last entry when a late record amends it', async () => {
  const w = await lateWorld(at('12:06:30'));
  const x = exporter(w);
  await send(w, x, [{ start: '12:05:10', end: '12:05:50', bytes: 3n * GB / 7n }]);
  await runTo(w, at('12:11:00'));
  assert.deepEqual(summary(w), [['12:05', 0, 'original', '4285', '4285', '0']]);
  // M5 by the Webster split of 7 : 3 (RFC-004 §B3.2): split(4,285) = 3,000 / 1,285 (a floor split gives 2,999 / 1,286).
  assert.deepEqual(w.ledger.movements[0]?.lines[0]?.entries, [{ ledgerAccount: 'B:a1', amount: '-4285' },
    { ledgerAccount: 'S:s1:earn', amount: '3000' }, { ledgerAccount: 'SH:commission', amount: '1285' }]);
  const closing = w.rts.rating.log(utf8('a1')).find((e) => e.entry.kind === RATING_ENTRY.usageClosed);
  assert.deepEqual((closing?.entry.payload as { lines: Array<{ elaS: string }> }).lines.map((l) => l.elaS), ['428571428']);
  await w.bus.jump(at('13:20:00') - w.bus.nowMs);
  await w.provisioning.heartbeat('e1');
  await w.bus.settle();
  await send(w, x, [{ start: '12:05:20', end: '12:05:40', bytes: GB }]);
  await runTo(w, at('13:22:00'));
  const row = { table: 'rating_usage_line', key: { partition: utf8('a1'), product: 'be', route: 'r1', minute: at('12:05:00') } };
  assert.deepEqual(w.rts.rating.appends.filter((a) => a.call.reads !== undefined).map((a) => a.call.reads), [[row]]);
  // E = 4,285 and X = 428,571,428 + 1,000,000,000 bytes come from the saved line: ⌊14,285.71428⌋ − 4,285 = 10,000.
  assert.deepEqual(summary(w).slice(1), [['12:05', 1, 'late_traffic', '10000', '14285', '4285']]);
  // M6: split(14,285) − split(4,285) = 10,000 / 4,285 − 3,000 / 1,285.
  assert.deepEqual(w.ledger.movements[1]?.lines[0]?.entries, [{ ledgerAccount: 'B:a1', amount: '-10000' },
    { ledgerAccount: 'S:s1:earn', amount: '7000' }, { ledgerAccount: 'SH:commission', amount: '3000' }]);
  assert.equal(w.rating.stateOf('a1')?.lines[lineKey('12:05:00')]?.ela.S, 1_428_571_428n);
  assert.deepEqual(w.alerts.alerts, []);
});

test('should alert LATE_TRAFFIC_DOWNWARD and emit nothing when a late part would lower a closed line', async () => {
  const w = await lateWorld(at('12:06:30'));
  const x = exporter(w);
  await send(w, x, [{ start: '12:05:10', end: '12:05:50', bytes: GB }]);
  await runTo(w, at('12:11:00'));
  const part: Part = {
    recordIdentity: { kind: 'record', id: { format: 'ipfix', exporterId: 'e1', observationDomain: 7, epoch: 1, extSeq: '99' } },
    bindingPosition: '1', acceptedAtMs: w.bus.nowMs, lastMinuteEndMs: at('12:06:00'), minuteMs: at('12:05:00'),
    bytes: { num: '-500000000', den: '1' }, class: 'best-effort', accountId: 'a1', productId: 'be', routeId: 'r1',
    reservationId: null, op: OP, linkId: 'L1',
  };
  await w.rating.applyParts({ account: 'a1', attrBSeq: '1000', parts: [part], bindingFacts: [] });
  await runTo(w, at('12:14:00'));
  assert.deepEqual(w.alerts.of('LATE_TRAFFIC_DOWNWARD').map((a) => [a.owner, a.detail]), [['rating', lineKey('12:05:00')]]);
  assert.deepEqual(summary(w), [['12:05', 0, 'original', '10000', '10000', '0']]);
  assert.deepEqual(amendmentEntries(w), []);
  assert.equal(w.ledger.movements.length, 1);
  // The negative part stays in the line's ELA (design issue (I4) 4): 1 GB − 0.5 GB.
  assert.equal(w.rating.stateOf('a1')?.lines[lineKey('12:05:00')]?.ela.S, 500_000_000n);
});

test('should keep an unposted closed line in memory and in U after amendment_hot_window when its original was excluded', async () => {
  const w = await lateWorld(at('12:06:30'));
  const x = exporter(w);
  w.settlement.scriptAcks((b) => b.lines.map((l) => ({ sourceRef: l.sourceRef, outcome: 'excluded' as const, reason: 'batch_refused' as const })));
  await send(w, x, [{ start: '12:05:10', end: '12:05:50', bytes: GB }]);
  await runTo(w, at('12:11:00'));
  assert.deepEqual(w.alerts.of('LINE_EXCLUDED_NOT_IN_I1').length, 1);
  assert.equal(w.ledger.movements.length, 0);
  await w.bus.jump(at('13:20:00') - w.bus.nowMs);
  await w.provisioning.heartbeat('e1');
  await w.bus.settle();
  // A part of another, open minute; 50,000 bytes are charged 0, so U is the excluded line's 10,000 only.
  await send(w, x, [{ start: '13:19:10', end: '13:19:50', bytes: 50_000n }]);
  await runTo(w, at('13:19:58'));
  const line = w.rating.stateOf('a1')?.lines[lineKey('12:05:00')];
  assert.deepEqual([line?.closed, line?.emitted, line?.posted], [true, '10000', '0']);
  assert.ok(w.rating.stateOf('a1')?.lines[`be|r1|${at('13:19:00')}`], 'the part of 13:19 was applied');
  assert.equal(w.accountOwner.unposted('a1', 'be'), 10_000n);
});

/** The I4 catalogue with split weights only from 12:08: the minute starting 12:07 has a price but no weights. */
const CATALOGUE_NO_WEIGHTS_1207: FixtureEntity[] = CATALOGUE_I4.map((e) => (e.entityType === 'split_weights'
  ? { ...e, effectiveFrom: '2026-10-12T12:08:00Z' } : e));

test('should alert NO_PRICE_OR_WEIGHTS once and emit nothing when a late original has no split weights for its minute', async () => {
  const w = buildWorld({ startMs: DEPLOY_AT });
  await w.deploy(CATALOGUE_NO_WEIGHTS_1207);
  const from = at('11:00:00');
  await w.bus.jump(from - w.bus.nowMs);
  await w.provisioning.observationPoint(OP, 'L1', from);
  await w.provisioning.binding({ op: OP, serviceTag: { vlan: { outer: 100 } }, accountId: 'a1', productId: 'be', routeId: 'r1',
    validFromMs: from, bindingId: 'b-r1' });
  await w.bus.jump(at('12:08:30') - w.bus.nowMs);
  await w.provisioning.heartbeat('e1');
  await w.bus.settle();
  const x = exporter(w);
  await send(w, x, [{ start: '12:08:10', end: '12:08:50', bytes: GB }]);
  await runTo(w, at('12:14:00'));
  assert.deepEqual(summary(w), [['12:08', 0, 'original', '10000', '10000', '0']]);
  await send(w, x, [{ start: '12:07:10', end: '12:07:50', bytes: GB }]);
  await runTo(w, at('12:18:00'));
  assert.deepEqual(w.alerts.of('NO_PRICE_OR_WEIGHTS').map((a) => [a.owner, a.detail]), [['rating', lineKey('12:07:00')]]);
  assert.deepEqual(summary(w), [['12:08', 0, 'original', '10000', '10000', '0']], 'no line of 12:07');
  assert.equal(w.rts.rating.log(utf8('a1')).filter((e) => e.entry.kind === RATING_ENTRY.amendment).length, 1, 'no amendment entry on each timer tick');
  assert.equal(w.rating.stateOf('a1')?.inFlight, undefined);
  assert.deepEqual(w.rts.rating.timersOf(utf8('a1')).filter((t) => t.key === 'amend'), [], 'a held line arms no amendment timer');
  assert.deepEqual(w.ledger.movements.map((m) => m.lines.map((l) => l.kind)), [['M5']]);
  // A second late record tries the held line again: still no weights, and no second alert.
  await send(w, x, [{ start: '12:07:20', end: '12:07:40', bytes: GB }]);
  await runTo(w, at('12:21:00'));
  assert.equal(w.alerts.of('NO_PRICE_OR_WEIGHTS').length, 1);
  assert.deepEqual(w.rating.stateOf('a1')?.lines[lineKey('12:07:00')]?.late?.records.length, 2);
  assert.equal(w.rts.rating.log(utf8('a1')).filter((e) => e.entry.kind === RATING_ENTRY.amendment).length, 2, 'one held try for each late record');
  assert.equal(summary(w).length, 1);
});
