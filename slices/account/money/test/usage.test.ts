/**
 * MONEY-I3 settlement and ledger of usage batches, amendments, corrections, fees and cost lines (RFC-004 §B2,
 * §B3; C06 "Charge-line batches", "Settlement mapping", §7 … §9): the mapping rows (CT-L1), the late POL-07 cut
 * (CT-L2), size (CT-L3), whole batches (CT-L4), dedup (CT-L5), order and totals (CT-L6), the feed (CT-L7), abandon
 * postings (CT-L10), the CT-R fixtures (CT-C1) and the worked examples of §B2.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeJson, utf8 } from '@share/owner-runtime';
import {
  LEDGER_ENTRY, TOPIC, ledgerPartitionOfBuyer, ledgerRows, recordOf,
  type ChargeLine, type LedgerAnswer, type LineAck, type MovementPosted, type PostCall, type PostLine, type PostMovementRequest, type PostingAck, type StoredMovement,
} from '../src/index.ts';
import {
  CatalogueCorrectionsDouble, MINUTE_0, chargeLine, ctrUsageBatches, moneyWorld, reservationBatch, reservationLine, usageBatch, usageRef,
  type MoneyWorld,
} from '../testing/index.ts';
import { R1_V2, R31, R4, balancesOf, lastEntries, movementsOf, nextId, original, resAmend, resRef, usage, usageWorld } from './support-usage.ts';

const M1 = '2026-10-12T09:01:00Z';
const pk = (account: string): Uint8Array => utf8(ledgerPartitionOfBuyer(account));
const stored = (w: MoneyWorld, account: string): StoredMovement[] =>
  w.rt.log(pk(account)).filter((e) => e.entry.kind === LEDGER_ENTRY.movement).map((e) => (e.entry.payload as { movement: StoredMovement }).movement);
const outcomes = (acks: LineAck[]): Array<[string, string]> => acks.map((a) => [a.outcome, a.outcome === 'excluded' ? a.reason : String(a.duplicate)]);
const usageLine = (account: string, route: string, prior: bigint, next: bigint, over: Partial<ChargeLine> = {}, seq = 0, minute = MINUTE_0): ChargeLine =>
  chargeLine(account, usageRef(account, route, minute, seq), 'usage', prior, next, { route, weightsVersion: route === 'R1' ? 'w1' : route === 'R2' ? 'w2' : `w${route.slice(1).toLowerCase()}`, ...over });
const P = { supplier: 'P', partnerLink: 'LP' };
const feeLine = (account: string, reservation: string, feeId: string, amount: bigint, over: Partial<ChargeLine> = {}): ChargeLine =>
  chargeLine(account, { kind: 'fee', reservation, feeId }, 'fee', 0n, amount, { reservation, payee: P, feeId, ...over });
const excess = (account: string, prior: bigint, next: bigint, seq: number, over: Partial<ChargeLine> = {}): ChargeLine =>
  chargeLine(account, { kind: 'carried_excess', account, product: 'best-effort', route: 'R1', minute: MINUTE_0, seq }, 'carried_excess', prior, next,
    { product: 'best-effort', reason: seq === 0 ? 'original' : 'superseding_record', ...over });
const dearer = (account: string, r: string, prior: bigint, next: bigint, seq: number, over: Partial<ChargeLine> = {}): ChargeLine =>
  chargeLine(account, { kind: 'dearer_path', reservation: r, minute: MINUTE_0, seq }, 'dearer_path', prior, next,
    { reservation: r, route: 'RP', weightsVersion: 'wp', ...over });
const LATE_CUT = { link: 'L2', reduction: 'red-1', extensionChunk: 2 };

// ---------------- C06 CT-L1: each row of the mapping table ----------------

test('C06 CT-L1 each row of the settlement mapping table posts the movement that it names', async () => {
  type Case = [string, (w: MoneyWorld) => Promise<void>, () => ChargeLine, string];
  const own = async (w: MoneyWorld): Promise<void> => {
    await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 10_000n)]);
    await usage(w, 'b1', [usageLine('b1', 'R1', 10_000n, 9_000n, { reason: 'price_correction', cause: { kind: 'share' } }, 1)]);
  };
  const res1500 = async (w: MoneyWorld): Promise<void> => { await original(w, 'b1', 'r-1', 1_500n); };
  const ownRes = async (w: MoneyWorld): Promise<void> => {
    await res1500(w);
    await usage(w, 'b1', [resAmend('b1', 'r-1', 1, 1_500n, 1_200n, { reason: 'price_correction', cause: { kind: 'share' } })]);
  };
  const none = async (): Promise<void> => {};
  const cases: Case[] = [
    ['usage, 0, original', none, () => usageLine('b1', 'R1', 0n, 100n), 'M5'],
    ['usage, 0, late original from a quarantine attribution (CT-R13)', none, () => usageLine('b1', 'R1', 0n, 100n, { triggerRef: 'qa-1' }), 'M5'],
    ['fee, payer account', none, () => feeLine('b1', 'r-1', 'f-1', 500_000n), 'M10'],
    ['share_borne_fee, payer share', none, () => chargeLine('b1', { kind: 'fee', reservation: 'r-1', feeId: 'f-2' }, 'share_borne_fee', 0n, 70n, { payee: P }), 'M11'],
    ['carried_excess, 0', none, () => excess('b1', 0n, 10_000n, 0), 'M12'],
    ['dearer_path, 0', none, () => dearer('b1', 'r-9', 0n, 4n, 0), 'M13'],
    ['reservation, late_pol07_cut, normal mode', res1500, () => resAmend('b1', 'r-1', 1, 1_500n, 900n, { reason: 'late_pol07_cut', lateCut: LATE_CUT }), 'M6'],
    ['reservation, late_pol07_cut, own mode', ownRes, () => resAmend('b1', 'r-1', 2, 1_200n, 600n, { reason: 'late_pol07_cut', lateCut: LATE_CUT }), 'M7'],
    ['reservation, price_correction down, cause share', res1500, () => resAmend('b1', 'r-1', 1, 1_500n, 1_000n, { reason: 'price_correction', cause: { kind: 'share' } }), 'M8'],
    ['reservation, price_correction down, cause other', res1500, () => resAmend('b1', 'r-1', 1, 1_500n, 1_000n, { reason: 'price_correction', cause: { kind: 'other' } }), 'M8'],
    ['reservation, price_correction down, cause supplier', res1500, () => resAmend('b1', 'r-1', 1, 1_500n, 1_000n, { reason: 'price_correction', cause: { kind: 'supplier', supplier: 'A' } }), 'M9'],
    ['reservation, re_rate up', res1500, () => resAmend('b1', 'r-1', 1, 1_500n, 1_600n, { reason: 're_rate' }), 'M6'],
    ['reservation, re_rate down, cause share', res1500, () => resAmend('b1', 'r-1', 1, 1_500n, 1_400n, { reason: 're_rate', cause: { kind: 'share' } }), 'M8'],
    ['usage, late_traffic up, normal mode', async (w) => { await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]); },
      () => usageLine('b1', 'R1', 100n, 150n, {}, 1), 'M6'],
    ...(['quarantine_attribution', 'corrected_record', 'price_correction', 'superseding_record', 're_rate'] as const).map((reason, i): Case =>
      [`usage, ${reason} up, normal mode`, async (w) => { await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]); },
        () => usageLine('b1', 'R1', 100n, 150n, { reason, triggerRef: `t-${i}` }, 1), 'M6']),
    ['usage, late_traffic up, own mode', own, () => usageLine('b1', 'R1', 9_000n, 9_500n, {}, 2), 'M7'],
    ['usage, attribution_reversed down, cause share', async (w) => { await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]); },
      () => usageLine('b1', 'R1', 100n, 0n, { reason: 'attribution_reversed', cause: { kind: 'share' } }, 1), 'M8'],
    ['usage, superseding_record down, cause supplier', async (w) => { await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]); },
      () => usageLine('b1', 'R1', 100n, 50n, { reason: 'superseding_record', cause: { kind: 'supplier', supplier: 'B' } }, 1), 'M9'],
    ['usage, re_rate down, cause share', async (w) => { await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]); },
      () => usageLine('b1', 'R1', 100n, 90n, { reason: 're_rate', cause: { kind: 'share' } }, 1), 'M8'],
    ['carried_excess, amendment', async (w) => { await usage(w, 'b1', [excess('b1', 0n, 10_000n, 0)]); },
      () => excess('b1', 10_000n, 12_000n, 1, { reason: 'corrected_record' }), 'M23'],
    ['usage, 0, abandon', none, () => usageLine('b1', 'R1', 0n, 100n, { payer: 'share', abandon: { actionId: 'a-1' }, triggerRef: 'a-1' }), 'M12'],
    ['usage, 1, abandon up', async (w) => { await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]); },
      () => usageLine('b1', 'R1', 100n, 150n, { payer: 'share', abandon: { actionId: 'a-2' } }, 1), 'M12'],
    ['usage, 1, abandon down', async (w) => { await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]); },
      () => usageLine('b1', 'R1', 100n, 80n, { reason: 'price_correction', cause: { kind: 'share' }, payer: 'share', abandon: { actionId: 'a-3' } }, 1), 'M8'],
    ['fee, abandon', none, () => feeLine('b1', 'r-1', 'f-3', 900n, { payer: 'share', abandon: { actionId: 'a-4' } }), 'M11'],
  ];
  for (const [name, setup, make, kind] of cases) {
    const w = await usageWorld();
    await setup(w);
    const acks = await usage(w, 'b1', [make()]);
    assert.deepEqual(outcomes(acks), [['posted', 'false']], name);
    assert.deepEqual(movementsOf(w).at(-1)!.kinds, [kind], name);
  }
});

test('C06 CT-L1 an invalid combination in a usage batch refuses the batch whole: invalid for the line, batch_refused for the others, an alert, nothing posted', async () => {
  const bad: Array<[string, ChargeLine]> = [
    ['a reservation amendment with reason late_traffic', resAmend('b1', 'r-1', 1, 1_500n, 1_600n, { reason: 'late_traffic' })],
    ['an upward price_correction of a reservation line', resAmend('b1', 'r-1', 1, 1_500n, 1_600n, { reason: 'price_correction', cause: { kind: 'share' } })],
    ['a late_pol07_cut with a cause', resAmend('b1', 'r-1', 1, 1_500n, 900n, { reason: 'late_pol07_cut', lateCut: LATE_CUT, cause: { kind: 'share' } })],
    ['a late_pol07_cut upward', resAmend('b1', 'r-1', 1, 1_500n, 1_600n, { reason: 'late_pol07_cut', lateCut: LATE_CUT })],
    ['a late_pol07_cut with no lateCut', resAmend('b1', 'r-1', 1, 1_500n, 900n, { reason: 'late_pol07_cut' })],
    ['a downward usage amendment with no cause', usageLine('b1', 'R1', 100n, 50n, { reason: 'price_correction' }, 1)],
    ['a fee with no payee', chargeLine('b1', { kind: 'fee', reservation: 'r-1', feeId: 'f-1' }, 'fee', 0n, 10n)],
    ['a fee with a route', feeLine('b1', 'r-1', 'f-1', 10n, { route: 'R1', weightsVersion: 'w1' })],
    ['a seq 0 line with reason late_traffic', usageLine('b1', 'R1', 0n, 100n, { reason: 'late_traffic' })],
    ['a reason that is not in the enum', usageLine('b1', 'R1', 0n, 100n, { reason: 'goodwill' as ChargeLine['reason'] })],
    ['a reservation original in a usage batch', reservationLine('b1', 'r-5', MINUTE_0, 100n)],
    ['a usage line of another account', usageLine('b2', 'R1', 0n, 100n)],
    ['an abandon posting with payer account', usageLine('b1', 'R1', 0n, 100n, { abandon: { actionId: 'a-1' } })],
  ];
  for (const [name, line] of bad) {
    const w = await usageWorld();
    await original(w, 'b1', 'r-1', 1_500n);
    const good = usageLine('b1', 'R2', 0n, 7n);
    const acks = await usage(w, 'b1', [good, line]);
    assert.deepEqual(outcomes(acks), [['excluded', 'batch_refused'], ['excluded', 'invalid']], name);
    assert.ok(w.settlement.alerts.some((a) => a.code === 'LINE_INVALID'), name);
    assert.equal(movementsOf(w).length, 1, `${name}: nothing posted`);
  }
});

test('C06 CT-L1 each other invalid row of the mapping table refuses the usage batch whole after a posted line: invalid for the line, batch_refused for the others, nothing moves', async () => {
  const post100 = async (w: MoneyWorld): Promise<void> => { await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]); };
  const res1500 = async (w: MoneyWorld): Promise<void> => { await original(w, 'b1', 'r-1', 1_500n); };
  const excess10k = async (w: MoneyWorld): Promise<void> => { await usage(w, 'b1', [excess('b1', 0n, 10_000n, 0)]); };
  const none = async (): Promise<void> => {};
  const noRoute = (drop: 'route' | 'weightsVersion'): ChargeLine => {
    const l = usageLine('b1', 'R1', 0n, 100n);
    delete l[drop];
    return l;
  };
  const cases: Array<[string, (w: MoneyWorld) => Promise<void>, () => ChargeLine]> = [
    ['a negative newTotal', post100, () => usageLine('b1', 'R1', 100n, -50n, { reason: 'price_correction', cause: { kind: 'share' } }, 1)],
    ['a negative priorTotal', post100, () => usageLine('b1', 'R1', -10n, 100n, {}, 1)],
    ['a usage line with a reservation SourceRef', none, () => chargeLine('b1', resRef('r-7'), 'usage', 0n, 100n)],
    ['reason original on a cost-line amendment', excess10k, () => excess('b1', 10_000n, 12_000n, 1, { reason: 'original' })],
    ['a Share-borne fee with payer account', none, () => chargeLine('b1', { kind: 'fee', reservation: 'r-1', feeId: 'f-2' }, 'share_borne_fee', 0n, 70n, { payee: P, payer: 'account' })],
    ['a payee on a usage line', none, () => usageLine('b1', 'R1', 0n, 100n, { payee: P })],
    ['a usage line with no route', none, () => noRoute('route')],
    ['a usage line with no weights version', none, () => noRoute('weightsVersion')],
    ['a cost line with payer account', none, () => excess('b1', 0n, 10_000n, 0, { payer: 'account' })],
    ['a usage original with payer share and no abandon', none, () => usageLine('b1', 'R1', 0n, 100n, { payer: 'share' })],
    ['a cost-line amendment with amount 0', excess10k, () => excess('b1', 10_000n, 10_000n, 1)],
    ['a downward reservation re_rate with cause supplier', res1500, () => resAmend('b1', 'r-1', 1, 1_500n, 1_400n, { reason: 're_rate', cause: { kind: 'supplier', supplier: 'A' } })],
  ];
  for (const [name, setup, make] of cases) {
    const w = await usageWorld();
    await setup(w);
    const before = balancesOf(w);
    const posted = movementsOf(w).length;
    const acks = await usage(w, 'b1', [usageLine('b1', 'R2', 0n, 7n), make()]);
    assert.deepEqual(outcomes(acks), [['excluded', 'batch_refused'], ['excluded', 'invalid']], name);
    assert.deepEqual(w.settlement.alerts.map((a) => a.code), ['LINE_INVALID'], name);
    assert.equal(movementsOf(w).length, posted, `${name}: nothing posted`);
    assert.deepEqual(balancesOf(w), before, `${name}: no balance changed`);
  }
});

test('C06 CT-L1 two sequences of one line key in one usage batch refuse the batch whole', async () => {
  const w = await usageWorld();
  await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]);
  const acks = await usage(w, 'b1', [usageLine('b1', 'R1', 100n, 150n, {}, 1), usageLine('b1', 'R1', 150n, 170n, {}, 2)]);
  assert.deepEqual(outcomes(acks), [['excluded', 'batch_refused'], ['excluded', 'invalid']]);
  assert.equal(w.balances().get('B:b1'), -100n);
});

/** A usage world whose posting port keeps a copy of each call, to take settlement's port lines. */
async function capturingWorld(): Promise<{ w: MoneyWorld; calls: PostCall[] }> {
  const calls: PostCall[] = [];
  const w = await moneyWorld({ port: (l) => ({ post: async (c: PostCall) => { calls.push(structuredClone(c)); return l.post(c); } }) });
  for (const x of [R31, R4, R1_V2]) w.weights.apply(x);
  return { w, calls };
}

test('C06 CT-L1 the ledger refuses a usage request with two sequences of one line key whole, also when settlement did not refuse it first', async () => {
  const src = await capturingWorld();
  await usage(src.w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]);
  await usage(src.w, 'b1', [usageLine('b1', 'R1', 100n, 150n, {}, 1)]);
  await usage(src.w, 'b1', [usageLine('b1', 'R1', 150n, 170n, {}, 2)]);
  const [seq1, seq2] = [src.calls[1]!.request.lines[0]!, src.calls[2]!.request.lines[0]!];
  const w = await usageWorld();
  await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]);
  const before = balancesOf(w);
  const id = nextId();
  const a = await w.post('b1', { movementRef: id, cause: 'c', currency: 'USD', batch: { id, kind: 'usage', lineCount: 2 }, lines: [seq1, seq2] });
  assert.deepEqual(a.result === 'refused_batch' ? a.lines.map((l) => [l.lineRef, l.problem]) : a, [[usageRef('b1', 'R1', MINUTE_0, 2), 'invalid']]);
  assert.deepEqual(balancesOf(w), before);
  assert.equal(movementsOf(w).length, 1);
});

test('C06 CT-L6 a usage line whose split mode or explicit shares are not the template\'s is refused whole on the port; the template\'s shares post', async () => {
  const src = await capturingWorld();
  await usage(src.w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]);
  await usage(src.w, 'b1', [usageLine('b1', 'R1', 100n, 90n, { reason: 'price_correction', cause: { kind: 'share' } }, 1)]);
  const m8 = src.calls[1]!.request.lines[0]!;
  assert.deepEqual([m8.kind, m8.split], ['M8', { route: 'R1', weightsVersion: 'w1', mode: 'own' }]);
  const shares = [{ party: 'A', amount: '30' }, { party: 'B', amount: '33' }, { party: 'C', amount: '22' }, { party: 'commission', amount: '15' }];
  const w = await usageWorld();
  await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]);
  const send = async (split: NonNullable<PostLine['split']>) => {
    const id = nextId();
    return w.post('b1', { movementRef: id, cause: 'c', currency: 'USD', batch: { id, kind: 'usage', lineCount: 1 }, lines: [{ ...m8, split }] });
  };
  const problems = (a: LedgerAnswer): unknown => (a.result === 'refused_batch' ? a.lines.map((l) => [l.lineRef, l.problem, l.ledgerPostedTotal, l.ledgerLastSeq]) : a);
  const refused = [[usageRef('b1', 'R1', MINUTE_0, 1), 'invalid', '100', 0]];
  assert.deepEqual(problems(await send({ route: 'R1', weightsVersion: 'w1', mode: 'normal' })), refused, 'mode normal');
  assert.deepEqual(problems(await send({ route: 'R1', weightsVersion: 'w1', mode: 'own', explicitShares: shares.map((x, i) => (i === 0 ? { ...x, amount: '31' } : x)) })), refused, 'A + 1');
  assert.equal(w.balances().get('B:b1'), -100n);
  const ok = await send({ route: 'R1', weightsVersion: 'w1', mode: 'own', explicitShares: shares });
  assert.equal(ok.result, 'committed');
  assert.deepEqual(lastEntries(w), [['B:b1 10', 'SH:corrections -10']]);
});

test('C06 CT-L1 in a reservation batch an abandoned original posts as M12 beside the originals; an amendment is excluded invalid', async () => {
  const w = await usageWorld();
  const b = reservationBatch(nextId(), 'b1', MINUTE_0, [
    reservationLine('b1', 'r-1', MINUTE_0, 1_500n),
    reservationLine('b1', 'r-2', MINUTE_0, 1_500n, { payer: 'share', abandon: { actionId: 'act-2' }, triggerRef: 'act-2' }),
    { ...reservationLine('b1', 'r-3', MINUTE_0, 100n), sourceRef: resRef('r-3', MINUTE_0, 1), priorTotal: '50', amount: '50', reason: 're_rate' },
  ]);
  const acks = await w.settle(b);
  assert.deepEqual(outcomes(acks), [['excluded', 'invalid'], ['posted', 'false'], ['posted', 'false']]);
  assert.deepEqual(movementsOf(w).at(-1)!.kinds, ['M4', 'M12']);
  assert.deepEqual(lastEntries(w), [
    ['B:b1 -1500', 'S:A:earn 450', 'S:B:earn 500', 'S:C:earn 325', 'SH:commission 225'],
    ['S:A:earn 450', 'S:B:earn 500', 'S:C:earn 325', 'SH:costs -1275'],
  ]);
});

// ---------------- C06 CT-L2: late POL-07 cut (P4-S117) ----------------

test('C06 CT-L2 a late POL-07 cut of 1,500 to 900 posts M6: B:b1 +600, A −180, B −200, C −130, commission −90; no corrections entry, no fault debt, no own mode', async () => {
  const w = await usageWorld();
  await original(w, 'b1', 'r-1', 1_500n);
  const acks = await usage(w, 'b1', [resAmend('b1', 'r-1', 1, 1_500n, 900n, { reason: 'late_pol07_cut', lateCut: LATE_CUT })]);
  assert.deepEqual(outcomes(acks), [['posted', 'false']]);
  assert.deepEqual(lastEntries(w), [['B:b1 600', 'S:A:earn -180', 'S:B:earn -200', 'S:C:earn -130', 'SH:commission -90']]);
  const line = movementsOf(w).at(-1)!.lines[0]!;
  assert.deepEqual([line.kind, line.amount, line.postedTotal, line.reason, line.lateCut, line.cause, line.split],
    ['M6', '-600', '900', 'late_pol07_cut', LATE_CUT, undefined, { route: 'R1', weightsVersion: 'w1', mode: 'normal' }]);
  assert.deepEqual(balancesOf(w), { 'B:b1': '-900', 'S:A:earn': '270', 'S:B:earn': '300', 'S:C:earn': '195', 'SH:commission': '135' });
});

test('C06 CT-L2 a late POL-07 cut of 1,200 to 600 in own mode posts M7 −split(600): B:b1 +600, A −180, B −200, C −130, commission −90', async () => {
  const w = await usageWorld();
  await original(w, 'b1', 'r-1', 1_500n);
  await usage(w, 'b1', [resAmend('b1', 'r-1', 1, 1_500n, 1_200n, { reason: 'price_correction', cause: { kind: 'share' } })]);
  const acks = await usage(w, 'b1', [resAmend('b1', 'r-1', 2, 1_200n, 600n, { reason: 'late_pol07_cut', lateCut: LATE_CUT })]);
  assert.deepEqual(outcomes(acks), [['posted', 'false']]);
  assert.deepEqual(lastEntries(w), [['B:b1 600', 'S:A:earn -180', 'S:B:earn -200', 'S:C:earn -130', 'SH:commission -90']]);
  const line = movementsOf(w).at(-1)!.lines[0]!;
  assert.deepEqual([line.kind, line.split?.mode], ['M7', 'own']);
  assert.deepEqual(balancesOf(w), { 'B:b1': '-600', 'S:A:earn': '270', 'S:B:earn': '300', 'S:C:earn': '195', 'SH:commission': '135', 'SH:corrections': '-300' });
});

// ---------------- C06 CT-L3: size ----------------

test('C06 CT-L3 a usage batch of 5,001 lines posts nothing: settlement acknowledges each line batch_over_limit directly and alerts', async () => {
  const w = await usageWorld();
  const lines = Array.from({ length: 5_001 }, (_, i) => usageLine('b1', 'R1', 0n, 10n, {}, 0, new Date(Date.UTC(2026, 9, 12, 9, 0) + i * 60_000).toISOString().replace('.000Z', 'Z')));
  const acks = await usage(w, 'b1', lines);
  assert.equal(acks.length, 5_001);
  assert.ok(acks.every((a) => a.outcome === 'excluded' && a.reason === 'batch_over_limit'));
  assert.deepEqual(w.settlement.alerts.map((a) => a.code), ['BATCH_OVER_LIMIT']);
  assert.equal(w.rt.appends.length, 0, 'nothing reached the ledger');
});

// ---------------- C06 CT-L4: whole ----------------

test('C06 CT-L4 (1) an amendment sent again in a new usage batch is a duplicate: the batch commits whole and the amendment moves nothing again', async () => {
  const w = await usageWorld();
  await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]);
  const amend = usageLine('b1', 'R1', 100n, 150n, {}, 1);
  const first = await usage(w, 'b1', [amend]);
  const acks = await usage(w, 'b1', [amend, usageLine('b1', 'R2', 0n, 7n)]);
  assert.deepEqual(acks[0], { ...first[0], duplicate: true });
  assert.deepEqual(outcomes(acks), [['posted', 'true'], ['posted', 'false']]);
  assert.deepEqual(movementsOf(w).at(-1)!.batch, { id: movementsOf(w).at(-1)!.movementRef, kind: 'usage', whole: true });
  assert.equal(w.balances().get('B:b1'), -157n);
});

test('C06 CT-L4 (2) a line with the same SourceRef and other content refuses the usage batch whole: content_conflict with the ledger fields, batch_refused, an integrity alert', async () => {
  const w = await usageWorld();
  const first = await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]);
  const posted = first[0] as Extract<LineAck, { outcome: 'posted' }>;
  const acks = await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 120n), usageLine('b1', 'R2', 0n, 7n)]);
  assert.deepEqual(acks, [
    { sourceRef: usageRef('b1', 'R1', MINUTE_0), outcome: 'excluded', reason: 'content_conflict', conflictOf: posted.movementId,
      ledgerPostedTotal: '100', ledgerLastSeq: 0, ledgerPosition: posted.position },
    { sourceRef: usageRef('b1', 'R2', MINUTE_0), outcome: 'excluded', reason: 'batch_refused' },
  ]);
  assert.deepEqual(w.ledger.alerts.map((a) => a.code), ['INTEGRITY_LINE_CONFLICT']);
  assert.deepEqual(w.settlement.alerts.map((a) => a.code), ['BATCH_REFUSED']);
  assert.equal(w.balances().get('B:b1'), -100n, 'the refused batch moved nothing');
});

test('C06 CT-L4 (3) a line whose entries are not its template refuses the usage batch whole on the port, and the refusal is the recorded answer', async () => {
  const w = await usageWorld();
  const good: PostLine = { kind: 'M5', lineRef: usageRef('b1', 'R2', MINUTE_0), lineKind: 'usage', payer: 'account', reason: 'original',
    amendmentSeq: 0, priorTotal: '0', newTotal: '7', split: { route: 'R2', weightsVersion: 'w2', mode: 'normal' },
    entries: [{ ledgerAccount: 'B:b1', amount: '-7' }, { ledgerAccount: 'S:A:earn', amount: '3' }, { ledgerAccount: 'S:D:earn', amount: '2' }, { ledgerAccount: 'SH:commission', amount: '2' }] };
  const bad: PostLine = { ...good, lineRef: usageRef('b1', 'R2', M1), entries: [{ ledgerAccount: 'B:b1', amount: '-7' }, { ledgerAccount: 'S:A:earn', amount: '7' }] };
  const req: PostMovementRequest = { movementRef: 'u-tpl', cause: 'charge-line batch u-tpl', currency: 'USD', batch: { id: 'u-tpl', kind: 'usage', lineCount: 2 }, lines: [good, bad] };
  const a = await w.post('b1', req);
  assert.deepEqual(a, { result: 'refused_batch', lines: [{ lineRef: usageRef('b1', 'R2', M1), problem: 'invalid' }] });
  assert.deepEqual(await w.post('b1', structuredClone(req)), a, 'the recorded answer');
  assert.equal(recordOf<{ committed: boolean }>(w.rt.row(ledgerRows.movementRef(pk('b1'), 'u-tpl')))?.committed, false);
  assert.deepEqual(w.rt.log(pk('b1')), [], 'a refused usage batch takes no sequence of the partition log (CS-7)');
  assert.equal(w.balances().size, 0);
  const fixed = await w.post('b1', { ...req, movementRef: 'u-tpl-2', batch: { id: 'u-tpl-2', kind: 'usage', lineCount: 1 }, lines: [good] });
  assert.deepEqual(fixed.result === 'committed' ? [fixed.position.sequence, fixed.whole] : fixed, ['1', true]);
});

test('C06 CT-L4 (4) a usage request with lines.length ≠ lineCount is refused invalid; settlement copies rating\'s lineCount, so a dropped line is refused', async () => {
  const w = await usageWorld();
  const b = usageBatch(nextId(), 'b1', [usageLine('b1', 'R1', 0n, 100n)], 2);
  const acks = await w.settle(b);
  assert.deepEqual(acks, [], 'a movement-level refusal is not acknowledged; the batch is held');
  assert.deepEqual(w.settlement.alerts.map((a) => [a.code, a.detail]), [['MOVEMENT_REFUSED', 'invalid: lines.length 1 ≠ batch.lineCount 2']]);
  assert.equal(w.settlement.isHeld('b1'), true);
  assert.equal(w.balances().size, 0);
});

// ---------------- C06 CT-L5: dedup ----------------

test('C06 CT-L5 a usage batch sent again three times returns the recorded answer and posts each line once', async () => {
  const w = await usageWorld();
  const b = usageBatch(nextId(), 'b1', [usageLine('b1', 'R1', 0n, 100n), feeLine('b1', 'r-1', 'f-1', 50n)]);
  for (let i = 0; i < 3; i++) await w.settle(structuredClone(b));
  assert.equal(stored(w, 'b1').length, 1);
  assert.deepEqual(balancesOf(w), { 'B:b1': '-150', 'S:A:earn': '30', 'S:B:earn': '33', 'S:C:earn': '22', 'S:P:earn': '50', 'SH:commission': '15' });
  assert.deepEqual(w.ledger.alerts, []);
});

test('C06 CT-L5 a fee posted before and sent again with another payee is a conflict: the usage batch is refused whole and the fee is not paid twice', async () => {
  const w = await usageWorld();
  await usage(w, 'b1', [feeLine('b1', 'r-1', 'f-1', 500n)]);
  const acks = await usage(w, 'b1', [feeLine('b1', 'r-1', 'f-1', 500n, { payee: { supplier: 'Q', partnerLink: 'LQ' } })]);
  assert.deepEqual(outcomes(acks), [['excluded', 'content_conflict']]);
  assert.deepEqual(balancesOf(w), { 'B:b1': '-500', 'S:P:earn': '500' });
});

// ---------------- C06 CT-L6: order and totals ----------------

test('C06 CT-L6 an amendment past the next sequence, a wrong priorTotal, entries off the template and a weights version that is not the original\'s each refuse the usage batch whole', async () => {
  const w = await usageWorld();
  await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]);
  const cases: Array<[ChargeLine, string, Record<string, unknown>]> = [
    [usageLine('b1', 'R1', 100n, 150n, {}, 2), 'out_of_sequence', { ledgerPostedTotal: '100', ledgerLastSeq: 0 }],
    [usageLine('b1', 'R1', 90n, 150n, {}, 1), 'prior_total_mismatch', { ledgerPostedTotal: '100', ledgerLastSeq: 0 }],
    [usageLine('b1', 'R1', 100n, 150n, { weightsVersion: 'w1b' }, 1), 'invalid', { ledgerPostedTotal: '100', ledgerLastSeq: 0 }],
  ];
  for (const [line, problem, fields] of cases) {
    const acks = await usage(w, 'b1', [line, usageLine('b1', 'R2', 0n, 7n)]);
    const a = acks[0] as Extract<LineAck, { outcome: 'excluded' }>;
    assert.deepEqual([a.reason, a.ledgerPostedTotal, a.ledgerLastSeq, acks[1]!.outcome === 'excluded' && acks[1]!.reason],
      [problem, fields['ledgerPostedTotal'], fields['ledgerLastSeq'], 'batch_refused'], problem);
  }
  const port = async (lines: PostLine[]) => w.post('b1', { movementRef: nextId(), cause: 'c', currency: 'USD', batch: { id: 'x', kind: 'usage', lineCount: lines.length }, lines });
  const amend: PostLine = { kind: 'M6', lineRef: usageRef('b1', 'R1', M1, 1), lineKind: 'usage', payer: 'account', reason: 'late_traffic', amendmentSeq: 1,
    priorTotal: '0', newTotal: '5', split: { route: 'R1', weightsVersion: 'w1', mode: 'normal' }, entries: [{ ledgerAccount: 'B:b1', amount: '-5' }, { ledgerAccount: 'S:B:earn', amount: '5' }] };
  const r = await port([amend]);
  assert.deepEqual(r, { result: 'refused', reason: 'invalid', detail: 'a charge-line movement carries one batch, with movementRef = batch id' }, 'movementRef ≠ batch id is a movement-level refusal');
  const id = nextId();
  const r2 = await w.post('b1', { movementRef: id, cause: 'c', currency: 'USD', batch: { id, kind: 'usage', lineCount: 1 }, lines: [amend] });
  assert.deepEqual(r2, { result: 'refused_batch', lines: [{ lineRef: usageRef('b1', 'R1', M1, 1), problem: 'out_of_sequence' }] }, 'an amendment whose predecessor is not posted');
  assert.equal(w.balances().get('B:b1'), -100n);
});

// ---------------- C06 CT-L7: the feed ----------------

test('C06 CT-L7 a usage movement shows its batch and the per-line amount, postedTotal, reason, cause, triggerRef, lateCut and payee; the views follow their filters', async () => {
  const w = await usageWorld();
  await original(w, 'b1', 'r-1', 1_500n);
  await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]);
  await usage(w, 'b1', [
    resAmend('b1', 'r-1', 1, 1_500n, 900n, { reason: 'late_pol07_cut', lateCut: LATE_CUT, triggerRef: 'cut-1' }),
    usageLine('b1', 'R1', 100n, 80n, { reason: 'price_correction', cause: { kind: 'supplier', supplier: 'A' }, triggerRef: 'C7' }, 1),
    feeLine('b1', 'r-1', 'f-1', 500n),
  ]);
  const mv = movementsOf(w).at(-1)!;
  assert.deepEqual(mv.kinds, ['M6', 'M9', 'M10']);
  assert.deepEqual(mv.lines.map((l) => [l.kind, l.outcome, l.nil, l.amount, l.postedTotal, l.reason, l.cause, l.triggerRef, l.lateCut, l.payee, l.split]), [
    ['M6', 'posted', false, '-600', '900', 'late_pol07_cut', undefined, 'cut-1', LATE_CUT, undefined, { route: 'R1', weightsVersion: 'w1', mode: 'normal' }],
    ['M9', 'posted', false, '-20', '80', 'price_correction', { kind: 'supplier', supplier: 'A' }, 'C7', undefined, undefined,
      { route: 'R1', weightsVersion: 'w1', mode: 'own', shares: [{ party: 'A', amount: '24' }, { party: 'B', amount: '33' }, { party: 'C', amount: '22' }, { party: 'commission', amount: '15' }] }],
    ['M10', 'posted', false, '500', '500', 'original', undefined, undefined, undefined, P, undefined],
  ]);
  assert.deepEqual([mv.batch, mv.feesPosted, mv.postedThrough], [{ id: mv.movementRef, kind: 'usage', whole: true }, [{ reservation: 'r-1', feeId: 'f-1' }], undefined]);
  const view = (topic: string) => w.events<MovementPosted & { view_key: string }>(topic).filter((e) => e.event.movementId === mv.movementId).map((e) => e.event.view_key);
  assert.deepEqual(view(TOPIC.byBuyer), ['b1']);
  assert.deepEqual(view(TOPIC.bySupplier), ['A', 'B', 'C', 'P']);
  assert.deepEqual(view(TOPIC.byExternal), []);
});

test('C06 CT-L7 a usage batch that holds only cost lines is in the by-buyer view of its causing buyer, whose balance it does not touch', async () => {
  const w = await usageWorld();
  await usage(w, 'b1', [excess('b1', 0n, 10_000n, 0)]);
  const [e] = w.events<MovementPosted & { view_key: string }>(TOPIC.byBuyer);
  assert.deepEqual([e!.event.view_key, e!.event.home, e!.event.buyer], ['b1', { account: 'b1' }, { account: 'b1', balanceAfter: '0', writtenOffOwedAfter: '0' }]);
  const [ack] = w.events<PostingAck>(TOPIC.postingAcks);
  assert.equal(ack!.event.account, 'b1');
});

// ---------------- C06 CT-L10: abandon postings ----------------

test('C06 CT-L10 an abandon posting of a usage line, a fee and a reservation original posts by its mapping row: B unchanged, the key recorded, a repeat a duplicate', async () => {
  const w = await usageWorld();
  const u = usageLine('b1', 'R1', 0n, 10_000n, { payer: 'share', abandon: { actionId: 'act-1' }, triggerRef: 'act-1' });
  const f = feeLine('b1', 'r-1', 'f-1', 500n, { payer: 'share', abandon: { actionId: 'act-3' }, triggerRef: 'act-3' });
  await usage(w, 'b1', [u, f]);
  assert.deepEqual(lastEntries(w), [
    ['S:A:earn 3000', 'S:B:earn 3333', 'S:C:earn 2167', 'SH:costs -8500'],
    ['SH:costs -500', 'S:P:earn 500'],
  ]);
  const mv = movementsOf(w).at(-1)!;
  assert.deepEqual(mv.lines.map((l) => [l.kind, l.amount, l.postedTotal, l.abandon]), [['M12', '0', '10000', { actionId: 'act-1' }], ['M11', '0', '500', { actionId: 'act-3' }]]);
  assert.deepEqual(mv.feesPosted, [{ reservation: 'r-1', feeId: 'f-1' }]);
  await w.settle(reservationBatch(nextId(), 'b1', M1, [reservationLine('b1', 'r-8', M1, 1_500n, { payer: 'share', abandon: { actionId: 'act-2' }, triggerRef: 'act-2' })]));
  assert.deepEqual(movementsOf(w).at(-1)!.postedThrough, [{ reservation: 'r-8', minute: M1 }]);
  assert.equal(w.balances().get('B:b1') ?? 0n, 0n, 'the buyer is not charged');
  const again = await usage(w, 'b1', [u, f]);
  assert.deepEqual(outcomes(again), [['posted', 'true'], ['posted', 'true']]);
  assert.deepEqual(balancesOf(w), { 'S:A:earn': '3450', 'S:B:earn': '3833', 'S:C:earn': '2492', 'S:P:earn': '500', 'SH:costs': '-10275' });
});

test('C06 CT-L10 an abandon-up posting pays the suppliers only the increase split(150) − split(100): A 15, B 17, C 11 from Share\'s costs; no commission; B not charged again', async () => {
  const w = await usageWorld();
  await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 100n)]);
  const acks = await usage(w, 'b1', [usageLine('b1', 'R1', 100n, 150n, { payer: 'share', abandon: { actionId: 'a-2' }, triggerRef: 'a-2' }, 1)]);
  assert.deepEqual(outcomes(acks), [['posted', 'false']]);
  assert.deepEqual(lastEntries(w), [['S:A:earn 15', 'S:B:earn 17', 'S:C:earn 11', 'SH:costs -43']]);
  assert.deepEqual(balancesOf(w), { 'B:b1': '-100', 'S:A:earn': '45', 'S:B:earn': '50', 'S:C:earn': '33', 'SH:commission': '15', 'SH:costs': '-43' });
});

// ---------------- C06 CT-C1: the CT-R usage fixtures ----------------

test('C06 CT-C1 settlement consumes the CT-R usage fixtures (CT-R6, CT-R9, CT-R10, CT-R12, CT-R13) and the posted amounts equal the golden ledger, also when each batch comes three times', async () => {
  const { batches, golden } = ctrUsageBatches();
  const once = await usageWorld();
  for (const b of batches) assert.ok((await once.settle(structuredClone(b))).every((a) => a.outcome === 'posted'), b.batch.id);
  assert.deepEqual(balancesOf(once), golden);
  const thrice = await usageWorld();
  for (const b of batches) for (let i = 0; i < 3; i++) await thrice.settle(structuredClone(b));
  assert.deepEqual(balancesOf(thrice), golden);
  assert.deepEqual(movementsOf(thrice).map((m) => m.kinds), [['M4'], ['M5', 'M6', 'M10', 'M12', 'M13'], ['M6', 'M8', 'M23'], ['M8', 'M11', 'M12'], ['M12']]);
});

// ---------------- worked examples of RFC-004 §B2 ----------------

test('P4-S41 a correction of 40.000000 USD with the cause Share credits the buyer 40.000000 USD, borne by Share in full; no supplier changes', async () => {
  const w = await usageWorld();
  await original(w, 'b1', 'r-1', 100_000_000n);
  await usage(w, 'b1', [resAmend('b1', 'r-1', 1, 100_000_000n, 60_000_000n, { reason: 'price_correction', cause: { kind: 'share' }, triggerRef: 'C1' })]);
  assert.deepEqual(lastEntries(w), [['B:b1 40000000', 'SH:corrections -40000000']]);
  assert.deepEqual(balancesOf(w), { 'B:b1': '-60000000', 'S:A:earn': '30000000', 'S:B:earn': '33330000', 'S:C:earn': '21670000', 'SH:commission': '15000000', 'SH:corrections': '-40000000' });
});

test('P4-S84 a correction with the cause other is borne by Share, as for a Share error; no supplier changes', async () => {
  const w = await usageWorld();
  await original(w, 'b1', 'r-1', 1_500n);
  await usage(w, 'b1', [resAmend('b1', 'r-1', 1, 1_500n, 1_000n, { reason: 'price_correction', cause: { kind: 'other' } })]);
  assert.deepEqual(lastEntries(w), [['B:b1 500', 'SH:corrections -500']]);
  assert.deepEqual(balancesOf(w), { 'B:b1': '-1000', 'S:A:earn': '450', 'S:B:earn': '500', 'S:C:earn': '325', 'SH:commission': '225', 'SH:corrections': '-500' });
});

test('P4-S42 a correction caused by supplier A from 100.000000 to 60.000000 USD makes A owe 12.000000 USD; Share bears B\'s, C\'s and the commission\'s 28.000000 USD', async () => {
  const w = await usageWorld();
  await original(w, 'b1', 'r-1', 100_000_000n);
  await usage(w, 'b1', [resAmend('b1', 'r-1', 1, 100_000_000n, 60_000_000n, { reason: 'price_correction', cause: { kind: 'supplier', supplier: 'A' } })]);
  assert.deepEqual(lastEntries(w), [['B:b1 40000000', 'S:A:debt -12000000', 'SH:corrections -28000000']]);
  assert.deepEqual(balancesOf(w), { 'B:b1': '-60000000', 'S:A:debt': '-12000000', 'S:A:earn': '30000000', 'S:B:earn': '33330000', 'S:C:earn': '21670000',
    'SH:commission': '15000000', 'SH:corrections': '-28000000' });
});

test('P4-S42 a correction caused by supplier a that lands below a\'s split in own mode gives a no credit: B:b1 +1, Share bears 1 (R31: 8 → 7 → 27 → 26)', async () => {
  const w = await usageWorld();
  await usage(w, 'b1', [usageLine('b1', 'R31', 0n, 8n)]);
  await usage(w, 'b1', [usageLine('b1', 'R31', 8n, 7n, { reason: 'price_correction', cause: { kind: 'share' } }, 1)]);
  await usage(w, 'b1', [usageLine('b1', 'R31', 7n, 27n, {}, 2)]);
  assert.deepEqual(lastEntries(w), [['B:b1 -20', 'S:a:earn 3', 'S:b:earn 9', 'SH:commission 8']]);
  await usage(w, 'b1', [usageLine('b1', 'R31', 27n, 26n, { reason: 'price_correction', cause: { kind: 'supplier', supplier: 'a' } }, 3)]);
  assert.deepEqual(lastEntries(w), [['B:b1 1', 'SH:corrections -1']]);
  assert.deepEqual(movementsOf(w).at(-1)!.kinds, ['M9']);
  assert.deepEqual(balancesOf(w), { 'B:b1': '-26', 'S:a:earn': '4', 'S:b:earn': '13', 'SH:commission': '11', 'SH:corrections': '-2' });
});

test('P4-S56 excess carried of 10,000 micro-USD on R1 pays A, B and C 3,000, 3,333 and 2,167 from Share\'s costs; no commission share; b1 not debited', async () => {
  const w = await usageWorld();
  await usage(w, 'b1', [excess('b1', 0n, 10_000n, 0)]);
  assert.deepEqual(lastEntries(w), [['S:A:earn 3000', 'S:B:earn 3333', 'S:C:earn 2167', 'SH:costs -8500']]);
  assert.deepEqual(balancesOf(w), { 'S:A:earn': '3000', 'S:B:earn': '3333', 'S:C:earn': '2167', 'SH:costs': '-8500' });
});

test('P4-S74 each usage charge line is split only among the parties of its own route', async () => {
  const w = await usageWorld();
  await usage(w, 'a1', [usageLine('a1', 'R1', 0n, 1_500n), usageLine('a1', 'R2', 0n, 7n)]);
  assert.deepEqual(lastEntries(w), [
    ['B:a1 -1500', 'S:A:earn 450', 'S:B:earn 500', 'S:C:earn 325', 'SH:commission 225'],
    ['B:a1 -7', 'S:A:earn 3', 'S:D:earn 2', 'SH:commission 2'],
  ]);
});

test('P4-S75 an amendment from 31 to 32 among weights 31, 76 and 70 gives a, b and c 0, 1 and 0, leaving them at 6, 14 and 12', async () => {
  const w = await usageWorld();
  await usage(w, 'b1', [usageLine('b1', 'R31', 0n, 31n)]);
  assert.deepEqual(lastEntries(w), [['B:b1 -31', 'S:a:earn 6', 'S:b:earn 13', 'SH:commission 12']]);
  await usage(w, 'b1', [usageLine('b1', 'R31', 31n, 32n, {}, 1)]);
  assert.deepEqual(lastEntries(w), [['B:b1 -1', 'S:b:earn 1']]);
  assert.deepEqual(balancesOf(w), { 'B:b1': '-32', 'S:a:earn': '6', 'S:b:earn': '14', 'SH:commission': '12' });
});

test('P4-S85 after a correction borne by Share, a later amendment of 1 is split on its own: s receives 1 and the commission 0; no amount falls', async () => {
  const w = await usageWorld();
  await usage(w, 'b1', [usageLine('b1', 'R4', 0n, 4n)]);
  await usage(w, 'b1', [usageLine('b1', 'R4', 4n, 2n, { reason: 'price_correction', cause: { kind: 'share' } }, 1)]);
  assert.deepEqual(lastEntries(w), [['B:b1 2', 'SH:corrections -2']]);
  await usage(w, 'b1', [usageLine('b1', 'R4', 2n, 3n, {}, 2)]);
  assert.deepEqual(lastEntries(w), [['B:b1 -1', 'S:s:earn 1']]);
  assert.deepEqual(movementsOf(w).at(-1)!.kinds, ['M7']);
  assert.deepEqual(balancesOf(w), { 'B:b1': '-3', 'S:s:earn': '4', 'SH:commission': '1', 'SH:corrections': '-2' });
});

test('P4-S89 a cancellation fee of 0.500000 USD charged to b1 goes wholly to partner P', async () => {
  const w = await usageWorld();
  await usage(w, 'b1', [feeLine('b1', 'r-1', 'f-1', 500_000n)]);
  assert.deepEqual(lastEntries(w), [['B:b1 -500000', 'S:P:earn 500000']]);
  assert.deepEqual(balancesOf(w), { 'B:b1': '-500000', 'S:P:earn': '500000' });
});

test('P4-S77 every cost Share bears is paid from Share\'s own account to the supplier concerned, with its reason, and the buyer\'s charges are unchanged', async () => {
  const w = await usageWorld();
  const shareFee = (ref: ChargeLine['sourceRef'], amount: bigint, why: string): ChargeLine =>
    chargeLine('b1', ref, 'share_borne_fee', 0n, amount, { payee: P, reasonDetails: { cost: why } });
  await usage(w, 'b1', [
    shareFee({ kind: 'residue_fee', request: 'q-1', partnerLink: 'LP', feeId: 'f-r' }, 100n, 'POL-28 partner booking left without confirmation'),
    dearer('b1', 'r-9', 0n, 4n, 0),
    shareFee({ kind: 'fee', reservation: 'r-2', feeId: 'f-2' }, 200n, 'fee not shown at booking'),
    shareFee({ kind: 'fee', reservation: 'r-3', feeId: 'f-3' }, 300n, 'fee on revocation'),
    shareFee({ kind: 'fee', reservation: 'r-4', feeId: 'f-4' }, 400n, 'fee on a cancellation after a cut'),
  ]);
  assert.deepEqual(movementsOf(w).at(-1)!.kinds, ['M11', 'M13']);
  assert.deepEqual(lastEntries(w), [
    ['SH:costs -100', 'S:P:earn 100'], ['S:E:earn 2', 'S:F:earn 1', 'SH:costs -3'],
    ['SH:costs -200', 'S:P:earn 200'], ['SH:costs -300', 'S:P:earn 300'], ['SH:costs -400', 'S:P:earn 400'],
  ]);
  assert.equal(w.balances().get('B:b1') ?? 0n, 0n);
  assert.deepEqual(w.events<MovementPosted & { view_key: string }>(TOPIC.bySupplier).map((e) => e.event.view_key), ['E', 'F', 'P']);
});

test('P4-S110 a dearer path: the buyer is charged 4 on the path route, and Share bears the path\'s difference of 4, split among the path\'s parties with no commission share', async () => {
  const w = await usageWorld();
  await original(w, 'b1', 'r-110', 4n, { route: 'RP', weightsVersion: 'wp' });
  await usage(w, 'b1', [dearer('b1', 'r-110', 0n, 4n, 0)]);
  assert.deepEqual(lastEntries(w), [['S:E:earn 2', 'S:F:earn 1', 'SH:costs -3']]);
  assert.deepEqual(balancesOf(w), { 'B:b1': '-4', 'S:E:earn': '4', 'S:F:earn': '2', 'SH:commission': '1', 'SH:costs': '-3' });
});

test('P4-S115 a later correction of the buyer\'s price to 3 amends only the buyer\'s line; the difference Share bore stays; no supplier of the path is paid again', async () => {
  const w = await usageWorld();
  await original(w, 'b1', 'r-110', 4n, { route: 'RP', weightsVersion: 'wp' });
  await usage(w, 'b1', [dearer('b1', 'r-110', 0n, 4n, 0)]);
  const before = balancesOf(w);
  await usage(w, 'b1', [resAmend('b1', 'r-110', 1, 4n, 3n, { route: 'RP', weightsVersion: 'wp', reason: 'price_correction', cause: { kind: 'share' } })]);
  assert.deepEqual(lastEntries(w), [['B:b1 1', 'SH:corrections -1']]);
  const after = balancesOf(w);
  assert.deepEqual([after['S:E:earn'], after['S:F:earn'], after['SH:costs'], after['B:b1']], [before['S:E:earn'], before['S:F:earn'], before['SH:costs'], '-3']);
});

test('P4-S116 a cost Share paid is final: a superseding record by Share\'s exporter is a nil line; by supplier A\'s exporter A owes its own reduction of 1,500', async () => {
  for (const [cause, entries, nil, expected] of [
    [{ kind: 'share' as const }, [[]], true, { 'S:A:earn': '3000', 'S:B:earn': '3333', 'S:C:earn': '2167', 'SH:costs': '-8500' }],
    [{ kind: 'supplier' as const, supplier: 'A' }, [['S:A:debt -1500', 'SH:costs 1500']], false,
      { 'S:A:debt': '-1500', 'S:A:earn': '3000', 'S:B:earn': '3333', 'S:C:earn': '2167', 'SH:costs': '-7000' }],
  ] as const) {
    const w = await usageWorld();
    await usage(w, 'b1', [excess('b1', 0n, 10_000n, 0)]);
    await usage(w, 'b1', [excess('b1', 10_000n, 5_000n, 1, { cause })]);
    assert.deepEqual(lastEntries(w), entries);
    const l = movementsOf(w).at(-1)!.lines[0]!;
    assert.deepEqual([l.kind, l.nil, l.postedTotal, l.split?.mode], ['M23', nil, '5000', 'own']);
    assert.deepEqual(balancesOf(w), expected);
  }
});

test('P4-S30 a correction is a new movement that refers to the movement it corrects; the original is unchanged', async () => {
  const w = await usageWorld();
  await original(w, 'b1', 'r-1', 1_500n);
  const before = structuredClone(w.rt.log(pk('b1')));
  await usage(w, 'b1', [resAmend('b1', 'r-1', 1, 1_500n, 1_000n, { reason: 'price_correction', cause: { kind: 'share' }, triggerRef: 'C1' })]);
  const [orig, corr] = stored(w, 'b1');
  assert.deepEqual(w.rt.log(pk('b1')).slice(0, before.length), before);
  assert.deepEqual([corr!.lines[0]!.lineRef, corr!.lines[0]!.corrects, corr!.lines[0]!.triggerRef], [resRef('r-1', MINUTE_0, 1), orig!.movementId, 'C1']);
  assert.notEqual(corr!.movementId, orig!.movementId);
});

test('P4-S99 a correction source reference "C1" reused by another operator is refused by the catalogue and moves no money; a replay of C1 on the line is a conflict; the first is unaffected', async () => {
  const w = await usageWorld();
  const catalogue = new CatalogueCorrectionsDouble();
  await original(w, 'b1', 'r-1', 1_500n);
  const correction = { target: 'r-1', minute: MINUTE_0, correctedPrice: '10', cause: 'share' };
  assert.deepEqual(catalogue.submit('C1', 'op-1', correction), { accepted: true });
  await usage(w, 'b1', [resAmend('b1', 'r-1', 1, 1_500n, 1_000n, { reason: 'price_correction', cause: { kind: 'share' }, triggerRef: 'C1' })]);
  const first = balancesOf(w);
  assert.deepEqual(catalogue.submit('C1', 'op-2', correction), { refused: 'source_ref_reused' });
  assert.deepEqual(catalogue.submit('C1', 'op-1', { ...correction, correctedPrice: '5' }), { refused: 'source_ref_reused' });
  const replay = await usage(w, 'b1', [resAmend('b1', 'r-1', 2, 1_000n, 500n, { reason: 'price_correction', cause: { kind: 'share' }, triggerRef: 'C1' })]);
  const a = replay[0] as Extract<LineAck, { outcome: 'excluded' }>;
  assert.deepEqual([a.reason, a.conflictOf, a.ledgerPostedTotal, a.ledgerLastSeq], ['content_conflict', stored(w, 'b1')[1]!.movementId, '1000', 1]);
  assert.ok(w.ledger.alerts.some((x) => x.code === 'INTEGRITY_LINE_CONFLICT'));
  assert.deepEqual(balancesOf(w), first, 'no money moved for the second C1');
  assert.deepEqual(balancesOf(w), { 'B:b1': '-1000', 'S:A:earn': '450', 'S:B:earn': '500', 'S:C:earn': '325', 'SH:commission': '225', 'SH:corrections': '-500' });
});

test('should hold a usage batch with no split weights for a line, and post it when the weights arrive', async () => {
  const w = await usageWorld();
  const acks = await usage(w, 'b1', [usageLine('b1', 'R9', 0n, 100n, { weightsVersion: 'w9' })]);
  assert.deepEqual(acks, []);
  assert.deepEqual(w.settlement.alerts.map((a) => a.code), ['WEIGHTS_UNKNOWN']);
  w.weights.apply({ ...R1_V2, route: 'R9', weightsVersion: 'w9' });
  w.scheduler.advance(30_000);
  await w.settlement.idle();
  assert.equal(w.balances().get('B:b1'), -100n);
});

test('should post a usage line amended in normal mode at the split weights of its MONEY-I2 original, whose record has no stored shares', async () => {
  const w = await usageWorld();
  await original(w, 'b1', 'r-1', 1_500n);
  const key = [...(w.rt.world.tableRows.get('ledger_line')?.values() ?? [])][0]!;
  const rec = recordOf<Record<string, unknown>>(key.row)!;
  delete rec['shares'];
  w.rt.putRow({ table: 'ledger_line', key: key.key }, { ...(key.row as object), record: encodeJson(rec) });
  await usage(w, 'b1', [resAmend('b1', 'r-1', 1, 1_500n, 1_000n, { reason: 'price_correction', cause: { kind: 'supplier', supplier: 'A' } })]);
  assert.deepEqual(lastEntries(w), [['B:b1 500', 'S:A:debt -150', 'SH:corrections -350']]);
});

test('should refuse a usage batch\'s movement invalid when the caller names a home account other than the buyer it touches', async () => {
  const w = await usageWorld();
  const req: PostMovementRequest = { movementRef: 'u-home', cause: 'c', currency: 'USD', batch: { id: 'u-home', kind: 'usage', lineCount: 1 },
    lines: [{ kind: 'M10', lineRef: { kind: 'fee', reservation: 'r', feeId: 'f' }, lineKind: 'fee', payer: 'account', payee: P, reason: 'original', amendmentSeq: 0,
      priorTotal: '0', newTotal: '5', entries: [{ ledgerAccount: 'B:b1', amount: '-5' }, { ledgerAccount: 'S:P:earn', amount: '5' }] }] };
  const a = await w.ledger.post({ partition: ledgerPartitionOfBuyer('b1'), principal: 'settlement', request: req, account: 'b2' });
  assert.deepEqual(a.result === 'refused' ? [a.reason, a.detail] : a, ['invalid', 'the movement touches B:b1, but its home is B:b2']);
  const noHome = await w.ledger.post({ partition: ledgerPartitionOfBuyer('b1'), principal: 'settlement',
    request: { ...req, lines: [{ ...req.lines[0]!, kind: 'M11', lineKind: 'share_borne_fee', payer: 'share', entries: [{ ledgerAccount: 'SH:costs', amount: '-5' }, { ledgerAccount: 'S:P:earn', amount: '5' }] }] } });
  assert.deepEqual(noHome.result === 'refused' ? [noHome.reason, noHome.detail] : noHome, ['invalid', 'a movement touches 0 buyers; it must touch one']);
  assert.equal(w.balances().size, 0);
});

test('P4-S39 a late-traffic amendment debits the buyer and never debits a party, in normal mode (M6) and in own mode (M7)', async () => {
  const w = await usageWorld();
  await usage(w, 'b1', [usageLine('b1', 'R1', 0n, 10_001n)]);
  await usage(w, 'b1', [usageLine('b1', 'R1', 10_001n, 10_002n, {}, 1)]);
  assert.deepEqual(movementsOf(w).at(-1)!.kinds, ['M6']);
  assert.ok(lastEntries(w)[0]!.every((e) => (e.startsWith('B:') ? e.includes(' -') : !e.includes(' -'))), String(lastEntries(w)));
  await usage(w, 'b1', [usageLine('b1', 'R1', 10_002n, 9_000n, { reason: 'price_correction', cause: { kind: 'share' } }, 2)]);
  await usage(w, 'b1', [usageLine('b1', 'R1', 9_000n, 9_500n, {}, 3)]);
  assert.deepEqual(movementsOf(w).at(-1)!.kinds, ['M7']);
  assert.deepEqual(lastEntries(w), [['B:b1 -500', 'S:A:earn 150', 'S:B:earn 167', 'S:C:earn 108', 'SH:commission 75']]);
});
