import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESULTS } from '@share/owner-runtime/testing';
import { utf8 } from '@share/owner-runtime';
import { canonicalSourceRefBytes, checkChargeLineBatch, type ChargeLine, type ObservationPoint } from '@share/rate-common';
import { RATING_ENTRY, flowTooLong, type FixtureEntity } from '../src/index.ts';
import { buildWorld, type World } from '../testing/index.ts';
import { DEPLOY_AT, chargeBatches } from './fixture.ts';

const at = (hms: string): number => Date.parse(`2026-10-12T${hms}Z`);

/**
 * The I3 fixture: best-effort product "be" of account a1 on routes r1 and r2.
 * usage_price on r1: 10,000 micro-USD per GB until 12:20, 13,000 from 12:20; on r2: 13,000.
 * Product "be2" of a1 on r1 (VLAN 300): 13,000; on r2 (VLAN 400): no usage_price. A reservation_price of "be" on r1
 * that usage lines never use.
 * Prices are in pico-USD per GB (C06 Conventions).
 */
const CATALOGUE_I3: FixtureEntity[] = [
  { entityType: 'product', productId: 'be', kind: 'best_effort', permitsBurst: false },
  { entityType: 'product', productId: 'be2', kind: 'best_effort', permitsBurst: false },
  { entityType: 'route', routeId: 'r1', legs: ['L1'] },
  { entityType: 'route', routeId: 'r2', legs: ['L2'] },
  { entityType: 'price_version', product: 'be', route: 'r1', priceKind: 'usage_price', priceVersion: 'pv-r1-10000',
    price: '10000000000', effectiveFrom: '2026-10-02T00:00:00Z' },
  { entityType: 'price_version', product: 'be', route: 'r1', priceKind: 'usage_price', priceVersion: 'pv-r1-13000',
    price: '13000000000', effectiveFrom: '2026-10-12T12:20:00Z' },
  // Another product and a reservation_price on r1, both effective later than be's usage_price (TR-1).
  { entityType: 'price_version', product: 'be2', route: 'r1', priceKind: 'usage_price', priceVersion: 'pv-be2-r1-13000',
    price: '13000000000', effectiveFrom: '2026-10-05T00:00:00Z' },
  { entityType: 'price_version', product: 'be', route: 'r1', priceKind: 'reservation_price', priceVersion: 'rp-be-r1',
    price: '1500000', effectiveFrom: '2026-10-08T00:00:00Z' },
  { entityType: 'price_version', product: 'be', route: 'r2', priceKind: 'usage_price', priceVersion: 'pv-r2-13000',
    price: '13000000000', effectiveFrom: '2026-10-02T00:00:00Z' },
  { entityType: 'split_weights', route: 'r1', weightsVersion: 'w-r1', effectiveFrom: '2026-09-01T00:02:00Z',
    legs: [{ link: 'L1', supplier: 's1', weight: 7 }], commissionWeight: 3 },
  { entityType: 'split_weights', route: 'r2', weightsVersion: 'w-r2', effectiveFrom: '2026-09-01T00:02:00Z',
    legs: [{ link: 'L2', supplier: 's2', weight: 3 }], commissionWeight: 1 },
];

const OP: ObservationPoint = { exporterId: 'e1', observationDomain: 7, ifIndex: 3, direction: 'egress' };
const VLAN = { r1: 100, r2: 200, 'be2 r1': 300, 'be2 r2': 400 } as const;
const GB = 1_000_000_000n;

interface Flow { start: string; end: string; bytes: bigint; route?: keyof typeof VLAN }

/** A world with the I3 catalogue, bindings of a1 on r1 (VLAN 100) and r2 (VLAN 200), and the clock at `sendAt`. */
async function i3World(sendAt: number, relay: 'off' | 'both' = 'off'): Promise<World> {
  const w = buildWorld({ startMs: DEPLOY_AT, relay });
  await w.deploy(CATALOGUE_I3);
  const from = at('11:00:00');
  await w.bus.jump(from - w.bus.nowMs);
  await w.provisioning.observationPoint(OP, 'L1', from);
  for (const route of ['r1', 'r2'] as const) {
    await w.provisioning.binding({ op: OP, serviceTag: { vlan: { outer: VLAN[route] } }, accountId: 'a1', productId: 'be',
      routeId: route, validFromMs: from, bindingId: `b-${route}` });
  }
  await w.provisioning.binding({ op: OP, serviceTag: { vlan: { outer: VLAN['be2 r1'] } }, accountId: 'a1', productId: 'be2',
    routeId: 'r1', validFromMs: from, bindingId: 'b-be2-r1' });
  await w.provisioning.binding({ op: OP, serviceTag: { vlan: { outer: VLAN['be2 r2'] } }, accountId: 'a1', productId: 'be2',
    routeId: 'r2', validFromMs: from, bindingId: 'b-be2-r2' });
  await w.bus.jump(sendAt - w.bus.nowMs);
  await w.provisioning.heartbeat('e1');
  await w.bus.settle();
  return w;
}

/** Send the flows in one export message at the current time, then run on until every line is closed and posted. */
async function charge(flows: Flow[], sendAt: number, relay: 'off' | 'both' = 'off', beforeSend?: (w: World) => void): Promise<World> {
  const w = await i3World(sendAt, relay);
  beforeSend?.(w);
  const exp = new w.ReferenceExporter(OP.observationDomain, at('10:00:00'));
  const s = w.session('e1', 's1');
  const item = exp.exportItem(flows.map((f) => ({ startMs: at(f.start), endMs: at(f.end), bytes: f.bytes, ifIndex: OP.ifIndex,
    vlan: VLAN[f.route ?? 'r1'] })), Math.floor(w.bus.nowMs / 1000));
  await exp.send(s, exp.batch([item]));
  await w.bus.settle();
  assert.equal(exp.acks[0]?.items[0]?.message.accepted, flows.length);
  await w.bus.advance(8 * 60_000, 1_000, async () => {
    if (w.bus.nowMs % 5_000 === 0) await w.provisioning.heartbeat('e1');
  });
  return w;
}

/** The FLOW_TOO_LONG detail for the first record of exporter e1: exporter, record identity and active milliseconds. */
const LONG_FLOW_DETAIL = 'e1 {"epoch":1,"exporterId":"e1","extSeq":"0","format":"ipfix","observationDomain":7} 180000 ms';

/** Every emitted charge line as "route minute" → amount. */
function charged(w: World): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of chargeBatches(w).flatMap((b) => b.lines)) out[`${l.route} ${(l.minute ?? '').slice(11, 16)}`] = l.amount;
  return out;
}

const P3_S18: Array<[string, string, string]> = [
  ['12:05:10', '12:05:50', '12:05'],
  ['12:05:30', '12:06:00', '12:05'],
  ['12:06:00', '12:06:20', '12:06'],
  ['12:05:10', '12:05:10', '12:05'],
];

for (const [start, end, minute] of P3_S18) {
  test(`P3-S18 a record of a flow active from ${start} to ${end} is charged in the minute starting ${minute}; minutes are half-open`, async () => {
    const w = await charge([{ start, end, bytes: GB }], at('12:07:00'));
    assert.deepEqual(charged(w), { [`r1 ${minute}`]: '10000' });
    assert.equal(w.accountOwner.unposted('a1', 'be'), 0n);
    assert.deepEqual(w.alerts.alerts, []);
  });
}

test('P3-S19 a 3 GB record of a flow active from 12:05:00 to 12:08:00 is charged 1 GB in each of the minutes 12:05, 12:06 and 12:07', async () => {
  const w = await charge([{ start: '12:05:00', end: '12:08:00', bytes: 3n * GB }], at('12:08:30'));
  assert.deepEqual(charged(w), { 'r1 12:05': '10000', 'r1 12:06': '10000', 'r1 12:07': '10000' });
  // 180 s is longer than flow_active_timeout + 60 s: the record is still spread, and its exporter is alerted (RFC-003 §4.2 step 2).
  assert.deepEqual(w.alerts.alerts.map((a) => [a.owner, a.kind, a.detail]),
    [['attr_a', 'FLOW_TOO_LONG', LONG_FLOW_DETAIL]]);
});

test('should alert FLOW_TOO_LONG once when the first append of the stage A entry is refused and the hand-off comes again on the relay', async () => {
  const w = await charge([{ start: '12:05:00', end: '12:08:00', bytes: 3n * GB }], at('12:08:30'), 'both',
    (x) => { x.rts.attrA.scriptAppend(RESULTS.Stopped()); });
  assert.deepEqual(charged(w), { 'r1 12:05': '10000', 'r1 12:06': '10000', 'r1 12:07': '10000' });
  assert.deepEqual(w.alerts.alerts.filter((a) => a.kind === 'FLOW_TOO_LONG').map((a) => a.detail),
    [LONG_FLOW_DETAIL]);
});

test('P3-S19 a 3 GB record of a flow active from 12:05:30 to 12:07:00 is charged 1 GB in the minute 12:05 and 2 GB in the minute 12:06', async () => {
  const w = await charge([{ start: '12:05:30', end: '12:07:00', bytes: 3n * GB }], at('12:07:30'));
  assert.deepEqual(charged(w), { 'r1 12:05': '10000', 'r1 12:06': '20000' });
  assert.deepEqual(w.alerts.alerts, []);
});

test('P3-S51 a 3 GB record active from 12:05:20 to 12:06:30 is charged 17,142 (exactly 120,000/7) in 12:05 and 12,857 (exactly 90,000/7) in 12:06', async () => {
  const w = await charge([{ start: '12:05:20', end: '12:06:30', bytes: 3n * GB }], at('12:07:00'));
  assert.deepEqual(charged(w), { 'r1 12:05': '17142', 'r1 12:06': '12857' });
  // The line keeps the exact bytes: 3 GB × 40/70 = 12,000,000,000/7 (S = 1,714,285,714, r_7 = 2).
  const line = w.rating.stateOf('a1')?.lines[`be|r1|${at('12:05:00')}`];
  assert.deepEqual(line?.ela, { S: 1_714_285_714n, r: { 7: 2n } });
  // The saved accumulator: the usage-closed entry and the line projection hold the same exact bytes.
  const closed = w.rts.rating.log(utf8('a1')).map((e) => e.entry)
    .filter((e) => e.kind === RATING_ENTRY.usageClosed).map((e) => e.payload as { minute: string; lines: unknown[] });
  assert.deepEqual(closed.find((e) => e.minute === '2026-10-12T12:05:00Z')?.lines,
    [{ product: 'be', route: 'r1', amount: '17142', elaS: '1714285714', elaR: '{"7":"2"}' }]);
  assert.deepEqual(closed.find((e) => e.minute === '2026-10-12T12:06:00Z')?.lines,
    [{ product: 'be', route: 'r1', amount: '12857', elaS: '1285714285', elaR: '{"7":"5"}' }]);
  const row = w.rts.rating.row({ table: 'rating_usage_line', key: { partition: utf8('a1'), product: 'be', route: 'r1', minute: at('12:05:00') } }) as
    { line: { ela: unknown; emitted: string; posted: string } } | undefined;
  assert.deepEqual(row?.line.ela, { S: '1714285714', r: { 7: '2' } });
  assert.equal(row?.line.posted, '17142');
});

test('should give one line for each product when two products of the account carry traffic on one route in one minute', async () => {
  const w = await charge([
    { start: '12:05:10', end: '12:05:50', bytes: GB, route: 'be2 r1' },
    { start: '12:05:10', end: '12:05:50', bytes: GB, route: 'r1' },
  ], at('12:06:30'));
  assert.deepEqual(chargeBatches(w).flatMap((b) => b.lines).map((l) => [l.product, l.route, l.amount, l.reasonDetails?.priceVersion]),
    [['be', 'r1', '10000', 'pv-r1-10000'], ['be2', 'r1', '13000', 'pv-be2-r1-13000']]);
  assert.equal(w.accountOwner.unposted('a1', 'be'), 0n);
  assert.equal(w.accountOwner.unposted('a1', 'be2'), 0n);
});

const P3_S21: Array<[bigint, string]> = [[1_000_000_000n, '10000'], [150_000n, '1'], [99_999n, '0']];

for (const [bytes, amount] of P3_S21) {
  test(`P3-S21 ${bytes} bytes in the minute starting 12:05 are charged ${amount} micro-USD, computed exactly and rounded down once`, async () => {
    const w = await charge([{ start: '12:05:10', end: '12:05:50', bytes }], at('12:06:30'));
    const line = w.rating.stateOf('a1')?.lines[`be|r1|${at('12:05:00')}`];
    assert.equal(line?.closed, true);
    assert.equal(line?.emitted, amount);
    // A line of 0 micro-USD is closed with total 0 and is not sent to settlement.
    assert.deepEqual(charged(w), amount === '0' ? {} : { 'r1 12:05': amount });
    assert.equal(w.accountOwner.unposted('a1', 'be'), 0n);
  });
}

test('P3-S48 150,000 bytes on r1 and 150,000 bytes on r2 in 12:05 give two lines, 1 (exactly 1.5) and 1 (exactly 1.95), each split by its own route', async () => {
  const w = await charge([
    { start: '12:05:10', end: '12:05:50', bytes: 150_000n, route: 'r2' },
    { start: '12:05:10', end: '12:05:50', bytes: 150_000n, route: 'r1' },
  ], at('12:06:30'));
  assert.deepEqual(charged(w), { 'r1 12:05': '1', 'r2 12:05': '1' });
  const lines = chargeBatches(w).flatMap((b) => b.lines);
  assert.deepEqual(lines.map((l) => [l.route, l.weightsVersion, l.reasonDetails]),
    [['r1', 'w-r1', { priceVersion: 'pv-r1-10000' }], ['r2', 'w-r2', { priceVersion: 'pv-r2-13000' }]]);
  const entries = w.ledger.movements.flatMap((m) => m.lines.map((l) => l.entries));
  // The Webster split of RFC-004 §B3.2 (review 73 TR-4): split(1) by 7 : 3 and by 3 : 1 gives the one unit to the supplier.
  assert.deepEqual(entries, [
    [{ ledgerAccount: 'B:a1', amount: '-1' }, { ledgerAccount: 'S:s1:earn', amount: '1' }],
    [{ ledgerAccount: 'B:a1', amount: '-1' }, { ledgerAccount: 'S:s2:earn', amount: '1' }],
  ]);
  assert.deepEqual(w.settlement.requests.flatMap((r) => r.lines.map((l) => [l.split?.route, l.split?.weightsVersion])), [['r1', 'w-r1'], ['r2', 'w-r2']]);
});

test('P3-S52 a 1 GB record active from 12:19:30 to 12:20:30 is charged 5,000 in 12:19 at 10,000 and 6,500 in 12:20 at 13,000', async () => {
  const w = await charge([{ start: '12:19:30', end: '12:20:30', bytes: GB }], at('12:21:00'));
  assert.deepEqual(charged(w), { 'r1 12:19': '5000', 'r1 12:20': '6500' });
  assert.deepEqual(chargeBatches(w).flatMap((b) => b.lines).map((l) => l.reasonDetails),
    [{ priceVersion: 'pv-r1-10000' }, { priceVersion: 'pv-r1-13000' }]);
});

test('should give one line for each (account, product, route, minute) when several records of the account fall in the same minute', async () => {
  const w = await charge([
    { start: '12:05:10', end: '12:05:20', bytes: 100_000n },
    { start: '12:05:30', end: '12:05:40', bytes: 50_000n },
    { start: '12:05:50', end: '12:06:10', bytes: 200_000n },
  ], at('12:06:30'));
  // 12:05: 100,000 + 50,000 + 100,000 = 250,000 bytes = 2.5 → 2; 12:06: 100,000 bytes = 1.0 → 1.
  assert.deepEqual(charged(w), { 'r1 12:05': '2', 'r1 12:06': '1' });
  assert.equal(chargeBatches(w).flatMap((b) => b.lines).length, 2);
});

test('should not close or emit a minute, and should alert, when a line of the minute has no usage_price for its product and route', async () => {
  const w = await charge([
    { start: '12:05:10', end: '12:05:50', bytes: GB, route: 'be2 r2' },
    { start: '12:05:10', end: '12:05:50', bytes: GB, route: 'r1' },
  ], at('12:06:30'));
  assert.deepEqual(charged(w), {});
  const key = `be2|r2|${at('12:05:00')}`;
  const alerts = w.alerts.alerts.filter((a) => a.kind === 'NO_PRICE_OR_WEIGHTS');
  assert.ok(alerts.length > 0);
  assert.deepEqual([...new Set(alerts.map((a) => `${a.owner} ${a.detail}`))], [`rating ${key}`]);
  assert.equal(w.rating.stateOf('a1')?.lines[key]?.closed, false);
  assert.equal(w.rating.stateOf('a1')?.lines[`be|r1|${at('12:05:00')}`]?.closed, false);
  assert.equal(w.rts.rating.log(utf8('a1')).filter((e) => e.entry.kind === RATING_ENTRY.usageClosed).length, 0);
});

test('C06 CT-R1 lines on two routes agree with the C06 schema and the canonical SourceRef vectors', async () => {
  const w = await charge([
    { start: '12:05:10', end: '12:05:50', bytes: GB, route: 'r1' },
    { start: '12:05:10', end: '12:05:50', bytes: GB, route: 'r2' },
  ], at('12:06:30'));
  const batches = chargeBatches(w);
  for (const b of batches) assert.deepEqual(checkChargeLineBatch(b), []);
  assert.deepEqual(w.settlement.schemaErrors, []);
  const lines: ChargeLine[] = batches.flatMap((b) => b.lines);
  assert.deepEqual(lines.map((l) => [l.route, l.amount]), [['r1', '10000'], ['r2', '13000']]);
  const hex = (s: string): string => Buffer.from(s).toString('hex');
  const field = (s: string): string => s.length.toString(16).padStart(8, '0') + hex(s);
  for (const l of lines) {
    const route = l.route as string;
    assert.equal(Buffer.from(canonicalSourceRefBytes(l.sourceRef)).toString('hex'),
      field('usage') + field('a1') + field('be') + field(route) + field('2026-10-12T12:05:00Z') + field('0'));
  }
  assert.equal(Buffer.from(canonicalSourceRefBytes(lines[1]?.sourceRef as ChargeLine['sourceRef'])).toString('hex'),
    '00000005757361676500000002613100000002626500000002723200000014323032362d31302d31325431323a30353a30305a0000000130');
});

test('should be true for flowTooLong when the active interval is longer than flow_active_timeout + 60 s, and false at exactly that length', () => {
  const s = at('12:05:00');
  assert.equal(flowTooLong(s, s + 120_000), false);
  assert.equal(flowTooLong(s, s + 120_001), true);
  assert.equal(flowTooLong(s, s), false);
});
