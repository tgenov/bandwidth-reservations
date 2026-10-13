/**
 * Order independence (RFC-003 §9; S-RATE-I4 exit criterion 2). This is the port of the prior seeded test
 * "duplicates, shuffling and late records give the same ledger as in-order delivery" (plan §3), with C11
 * identities, spread records, floor rounding and totals read from the C06 charge-line feed and the ledger.
 *
 * One random record set goes through the whole slice twice: once in order of when the traffic happened, each
 * record on time; and once shuffled, with 30% of the records sent again and 20% sent after their last minute
 * closed. The posted total of every line must be equal in both runs and equal to an independent exact-rational
 * reference. Seeds are fixed; `RATE_ORDER_SEED=<n>` runs one seed again. A failure message names the seed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkChargeLineBatch, type ChargeLine, type ExportItem, type ObservationPoint } from '@share/rate-common';
import type { FixtureEntity } from '../src/index.ts';
import { buildWorld, type World } from '../testing/index.ts';
import { DEPLOY_AT, chargeBatches } from './fixture.ts';

const at = (hms: string): number => Date.parse(`2026-10-12T${hms}Z`);
const OP: ObservationPoint = { exporterId: 'e1', observationDomain: 7, ifIndex: 3, direction: 'egress' };
const PRICE_BEFORE_1220 = 10_000_000_000n;
const PRICE_FROM_1220 = 13_000_000_000n;

const CATALOGUE: FixtureEntity[] = [
  { entityType: 'product', productId: 'be', kind: 'best_effort', permitsBurst: false },
  { entityType: 'route', routeId: 'r1', legs: ['L1'] },
  { entityType: 'price_version', product: 'be', route: 'r1', priceKind: 'usage_price', priceVersion: 'pv-r1-10000',
    price: PRICE_BEFORE_1220.toString(), effectiveFrom: '2026-10-02T00:00:00Z' },
  { entityType: 'price_version', product: 'be', route: 'r1', priceKind: 'usage_price', priceVersion: 'pv-r1-13000',
    price: PRICE_FROM_1220.toString(), effectiveFrom: '2026-10-12T12:20:00Z' },
  { entityType: 'split_weights', route: 'r1', weightsVersion: 'w-r1', effectiveFrom: '2026-09-01T00:02:00Z',
    legs: [{ link: 'L1', supplier: 's1', weight: 7 }], commissionWeight: 3 },
];

// ---------- the reference: exact rationals ----------

interface Q { n: bigint; d: bigint }

function refGcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b > 0n) [a, b] = [b, a % b];
  return a;
}

const q = (n: bigint, d: bigint): Q => { const g = refGcd(n, d) || 1n; return { n: n / g, d: d / g }; };
const qAdd = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);

/** ⌊a / b⌋ for a ≥ 0, b > 0. */
const refFloor = (a: bigint, b: bigint): bigint => (a - (a % b)) / b;

/** The reference line totals: each record spread over its minutes (POL-13), summed exactly, priced at its minute, floored once. */
function referenceTotals(records: Rec[]): Map<number, bigint> {
  const x = new Map<number, Q>();
  for (const r of records) {
    if (r.e === r.s) { x.set(r.s - (r.s % 60_000), qAdd(x.get(r.s - (r.s % 60_000)) ?? { n: 0n, d: 1n }, q(r.bytes, 1n))); continue; }
    for (let m = r.s - (r.s % 60_000); m < r.e; m += 60_000) {
      const overlap = BigInt(Math.min(r.e, m + 60_000) - Math.max(r.s, m));
      x.set(m, qAdd(x.get(m) ?? { n: 0n, d: 1n }, q(r.bytes * overlap, BigInt(r.e - r.s))));
    }
  }
  const out = new Map<number, bigint>();
  for (const [m, v] of x) {
    const price = m < at('12:20:00') ? PRICE_BEFORE_1220 : PRICE_FROM_1220;
    out.set(m, refFloor(price * v.n, v.d * 10n ** 15n));
  }
  return out;
}

// ---------- a seeded generator ----------

/** xorshift128+ on bigint. The same seed gives the same sequence. */
class Rng {
  private s0: bigint;
  private s1: bigint;
  constructor(seed: number) {
    const mask = (1n << 64n) - 1n;
    this.s0 = (BigInt(seed) * 0x9E3779B97F4A7C15n + 1n) & mask;
    this.s1 = (this.s0 * 0xBF58476D1CE4E5B9n + 7n) & mask;
    for (let i = 0; i < 8; i++) this.next();
  }
  next(): bigint {
    const mask = (1n << 64n) - 1n;
    let x = this.s0;
    const y = this.s1;
    this.s0 = y;
    x ^= (x << 23n) & mask;
    this.s1 = x ^ y ^ (x >> 17n) ^ (y >> 26n);
    return (this.s1 + y) & mask;
  }
  int(n: number): number {
    return Number(this.next() % BigInt(n));
  }
}

interface Rec { id: number; s: number; e: number; bytes: bigint }
interface Send { atMs: number; rec: number; order: number }

const SEEDS = process.env['RATE_ORDER_SEED'] ? [Number(process.env['RATE_ORDER_SEED'])] : [1, 2, 3, 20261013];
const RECORDS = 24;
const FIRST = at('12:16:00');
const END = at('12:42:00');

/**
 * Records active in [12:16, 12:23), at most flow_active_timeout long, some with e = s; bytes up to 2^32. One record in
 * four has bytes in [1, 200,000), charged below 2 micro-USD: lines closed at 0, their late originals, and late records
 * that do not change the floor of a line (review 73 TR-10).
 */
function records(rng: Rng): Rec[] {
  return Array.from({ length: RECORDS }, (_, id) => {
    const s = FIRST + rng.int(6 * 60_000);
    const len = rng.int(8) === 0 ? 0 : 1 + rng.int(60_000);
    const bytes = rng.int(4) === 0 ? 1n + BigInt(rng.int(199_999)) : 1n + (rng.next() & 0xFFFFFFFFn);
    return { id, s, e: s + len, bytes };
  });
}

const sec = (ms: number): number => Math.ceil(ms / 1_000) * 1_000;
const lastMinute = (r: Rec): number => (r.e === r.s ? r.s : r.e - 1) - ((r.e === r.s ? r.s : r.e - 1) % 60_000);

/** In order: each record once, 1 s after its end, in order of its end. */
function inOrderSends(recs: Rec[]): Send[] {
  return [...recs].sort((a, b) => a.e - b.e || a.id - b.id).map((r, order) => ({ atMs: sec(r.e + 1_000), rec: r.id, order }));
}

/**
 * Shuffled: 80% on time at a random time 1 … 150 s after the end (before the close of its first minute, as no record
 * is longer than 60 s); 20% after the close of its last minute (m + 315 s), 320 … 600 s after that minute's start;
 * 30% sent again 1 … 400 s after the first send. Records due in the same second go in a random order.
 */
function chaosSends(recs: Rec[], rng: Rng): { sends: Send[]; late: number[] } {
  const sends: Send[] = [];
  const late: number[] = [];
  for (const r of recs) {
    const isLate = rng.int(10) < 2;
    if (isLate) late.push(r.id);
    const first = isLate ? lastMinute(r) + 320_000 + rng.int(280_000) : r.e + 1_000 + rng.int(149_000);
    sends.push({ atMs: sec(first), rec: r.id, order: rng.int(1_000_000) });
    if (rng.int(10) < 3) sends.push({ atMs: sec(first) + 1_000 + rng.int(400) * 1_000, rec: r.id, order: rng.int(1_000_000) });
  }
  return { sends: sends.sort((a, b) => a.atMs - b.atMs || a.order - b.order), late };
}

/** Run one delivery through a fresh world; return its charge lines and the ledger's posted total of each line. */
async function deliver(recs: Rec[], sends: Send[]): Promise<{ lines: ChargeLine[]; totals: Map<number, bigint>; w: World }> {
  const w = buildWorld({ startMs: DEPLOY_AT });
  await w.deploy(CATALOGUE);
  await w.bus.jump(at('11:00:00') - w.bus.nowMs);
  await w.provisioning.observationPoint(OP, 'L1', at('11:00:00'));
  await w.provisioning.binding({ op: OP, serviceTag: { vlan: { outer: 100 } }, accountId: 'a1', productId: 'be', routeId: 'r1',
    validFromMs: at('11:00:00'), bindingId: 'b-r1' });
  await w.bus.jump(FIRST - w.bus.nowMs);
  const exp = new w.ReferenceExporter(OP.observationDomain, at('10:00:00'));
  const items = new Map<number, ExportItem>();
  let next = 0;
  let session = w.session('e1', 's1');
  await w.bus.advance(END - w.bus.nowMs, 1_000, async () => {
    if (w.bus.nowMs % 5_000 === 0) await w.provisioning.heartbeat('e1');
    if (w.bus.nowMs % 600_000 === 0) session = w.session('e1', 's1');
    while (next < sends.length && (sends[next] as Send).atMs <= w.bus.nowMs) {
      const r = recs[(sends[next] as Send).rec] as Rec;
      const item = items.get(r.id) ?? exp.exportItem([{ startMs: r.s, endMs: r.e, bytes: r.bytes, ifIndex: OP.ifIndex, vlan: 100 }],
        Math.floor(w.bus.nowMs / 1_000));
      items.set(r.id, item);
      await exp.send(session, exp.batch([item]));
      next += 1;
    }
  });
  assert.equal(next, sends.length, 'every send was made');
  const totals = new Map<number, bigint>();
  const lastSeq = new Map<number, number>();
  for (const m of w.ledger.movements) {
    for (const l of m.lines) {
      const ref = l.lineRef;
      if (ref.kind !== 'usage') continue;
      const minute = Date.parse(ref.minute);
      if (ref.seq >= (lastSeq.get(minute) ?? -1)) { lastSeq.set(minute, ref.seq); totals.set(minute, BigInt(l.postedTotal)); }
    }
  }
  return { lines: chargeBatches(w).flatMap((b) => b.lines), totals, w };
}

interface Outcome { inOrder: Awaited<ReturnType<typeof deliver>>; chaos: Awaited<ReturnType<typeof deliver>>; reference: Map<number, bigint>; late: number[] }

const outcomes = new Map<number, Promise<Outcome>>();

function outcome(seed: number): Promise<Outcome> {
  let o = outcomes.get(seed);
  if (!o) {
    o = (async () => {
      const rng = new Rng(seed);
      const recs = records(rng);
      const chaos = chaosSends(recs, rng);
      return { inOrder: await deliver(recs, inOrderSends(recs)), chaos: await deliver(recs, chaos.sends), reference: referenceTotals(recs), late: chaos.late };
    })();
    outcomes.set(seed, o);
  }
  return o;
}

const asObject = (m: Map<number, bigint>): Record<string, string> =>
  Object.fromEntries([...m].filter(([, v]) => v !== 0n).sort(([a], [b]) => a - b).map(([k, v]) => [new Date(k).toISOString().slice(11, 16), v.toString()]));

for (const seed of SEEDS) {
  test(`P3-S15 seed ${seed}: in-order delivery and shuffled delivery with repeats and records after their minute was charged give the same total for every line`, { timeout: 120_000 }, async () => {
    const o = await outcome(seed);
    const ref = asObject(o.reference);
    assert.ok(o.late.length > 0, `seed ${seed}: the shuffled run has records after closure`);
    assert.deepEqual(asObject(o.inOrder.totals), ref, `seed ${seed}: in-order totals against the reference`);
    assert.deepEqual(asObject(o.chaos.totals), ref, `seed ${seed}: shuffled totals against the reference`);
    assert.ok(o.chaos.lines.some((l) => l.reason === 'late_traffic' || l.reasonDetails?.['trigger'] === 'late_traffic'),
      `seed ${seed}: the shuffled run made amendments or late originals`);
    assert.ok(o.inOrder.lines.every((l) => l.reason === 'original' && ('seq' in l.sourceRef ? l.sourceRef.seq : -1) === 0),
      `seed ${seed}: in order, every record is in an original`);
    for (const w of [o.inOrder.w, o.chaos.w]) {
      for (const b of chargeBatches(w)) assert.deepEqual(checkChargeLineBatch(b), [], `seed ${seed}: schema`);
      assert.equal(w.accountOwner.unposted('a1', 'be'), 0n, `seed ${seed}: nothing left unposted`);
      assert.deepEqual(w.alerts.alerts.filter((a) => a.kind !== 'FLOW_TOO_LONG'), [], `seed ${seed}: alerts`);
    }
  });

  test(`P3-S33 seed ${seed}: every amendment that late, repeated and out-of-order records cause increases the charge it amends`, { timeout: 120_000 }, async () => {
    const o = await outcome(seed);
    const amendments = o.chaos.lines.filter((l) => ('seq' in l.sourceRef ? l.sourceRef.seq : 0) > 0);
    for (const l of amendments) {
      assert.equal(l.reason, 'late_traffic', `seed ${seed}: ${JSON.stringify(l.sourceRef)}`);
      assert.ok(BigInt(l.amount) > 0n && BigInt(l.newTotal) > BigInt(l.priorTotal), `seed ${seed}: ${JSON.stringify(l)}`);
    }
    const lateOriginals = o.chaos.lines.filter((l) => l.reasonDetails?.['trigger'] === 'late_traffic');
    for (const l of lateOriginals) assert.ok(BigInt(l.amount) > 0n, `seed ${seed}: late original ${JSON.stringify(l)}`);
  });
}
