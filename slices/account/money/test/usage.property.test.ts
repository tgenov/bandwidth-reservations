/**
 * Money invariants of MONEY-I3 over random input, against oracles that share no code with the provider
 * (engineering.md §2; RFC-004 §B13): order independence of late traffic (P4-S38, P4-S39), per-line dedup after
 * crashes and re-composed batches (P4-S57), cost-line amendments (P4-S115, P4-S116), batch kinds and whole usage
 * batches (P3-S61, X2-S13), and the sum to zero of every movement and of the ledger (P4-S28). Seeded: a failure
 * names its seed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8 } from '@share/owner-runtime';
import {
  LEDGER_ENTRY, ledgerPartitionOfBuyer, type ChargeLine, type ChargeLineBatch, type LineAck, type StoredMovement,
} from '../src/index.ts';
import { chargeLine, reservationBatch, reservationLine, usageBatch, usageRef, weightsFixture, type MoneyWorld } from '../testing/index.ts';
import { int, rng, seedNote, seeds } from './support.ts';
import { refSplit, usageWorld } from './support-usage.ts';

const W = weightsFixture();
const ROUTES: Array<[string, string]> = [['R1', 'w1'], ['R2', 'w2'], ['RP', 'wp']];
const ACCOUNTS = ['b1', 'b2', 'b3'];
const minute = (m: number): string => new Date(Date.UTC(2026, 9, 12, 9, m)).toISOString().replace('.000Z', 'Z');
const accountOf = (name: string): string => (name === 'commission' ? 'SH:commission' : `S:${name}:earn`);

function allMovements(w: MoneyWorld): StoredMovement[] {
  const parts = new Set(ACCOUNTS.map((a) => ledgerPartitionOfBuyer(a)));
  return [...parts].flatMap((p) => w.rt.log(utf8(p)).filter((e) => e.entry.kind === LEDGER_ENTRY.movement)
    .map((e) => (e.entry.payload as { movement: StoredMovement }).movement));
}

/** P4-S28: every line of every movement sums to zero, every entry is non-zero USD, the ledger sums to zero, and balances replay the log. */
function assertZeroSum(w: MoneyWorld, seed: number): void {
  const replay = new Map<string, bigint>();
  for (const mv of allMovements(w)) for (const l of mv.lines) {
    assert.equal(l.entries.reduce((a, e) => a + BigInt(e.amount), 0n), 0n, `${seedNote(seed)}: ${mv.movementId} has a line that does not sum to zero`);
    assert.ok(l.entries.every((e) => e.currency === 'USD' && e.amount !== '0'), seedNote(seed));
    for (const e of l.entries) replay.set(e.ledgerAccount, (replay.get(e.ledgerAccount) ?? 0n) + BigInt(e.amount));
  }
  const balances = w.balances();
  assert.equal([...balances.values()].reduce((a, b) => a + b, 0n), 0n, `${seedNote(seed)}: the ledger does not sum to zero`);
  for (const k of new Set([...replay.keys(), ...balances.keys()])) {
    assert.equal(balances.get(k) ?? 0n, replay.get(k) ?? 0n, `${seedNote(seed)}: ${k} differs from the replay of the log`);
  }
}

const nonZero = (m: Map<string, bigint>): Record<string, string> =>
  Object.fromEntries([...m].filter(([, v]) => v !== 0n).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v.toString()]));

interface Key { account: string; route: string; wv: string; minute: string; totals: bigint[] }

test('P4-S38 B13: Order independence: late traffic delivered in any order, partly repeated and partly after the minute was charged, gives the same balances as delivery in order', async () => {
  for (const seed of seeds(15, 301)) {
    const r = rng(seed);
    // Each usage line key gets a final total; out of order, the total arrives as an original and late-traffic amendments.
    const keys: Key[] = [];
    for (let i = 0; i < int(r, 3, 8); i++) {
      const [route, wv] = ROUTES[int(r, 0, ROUTES.length - 1)]!;
      const steps = int(r, 1, 4);
      const totals: bigint[] = [];
      let t = 0n;
      for (let s = 0; s < steps; s++) { t += BigInt(int(r, 1, 3_000)); totals.push(t); }
      keys.push({ account: ACCOUNTS[int(r, 0, ACCOUNTS.length - 1)]!, route, wv, minute: minute(i), totals });
    }
    const line = (k: Key, seq: number, inOrder: boolean): ChargeLine => {
      const next = inOrder ? k.totals.at(-1)! : k.totals[seq]!;
      const prior = inOrder || seq === 0 ? 0n : k.totals[seq - 1]!;
      return chargeLine(k.account, usageRef(k.account, k.route, k.minute, seq), 'usage', prior, next, { route: k.route, weightsVersion: k.wv });
    };
    // The oracle: each buyer is debited the final totals; each party holds split(final total) of each line.
    const want = new Map<string, bigint>();
    for (const k of keys) {
      const T = k.totals.at(-1)!;
      want.set(`B:${k.account}`, (want.get(`B:${k.account}`) ?? 0n) - T);
      for (const [p, s] of refSplit(T, W.find(k.route, k.wv)!)) want.set(accountOf(p), (want.get(accountOf(p)) ?? 0n) + s);
    }

    const inOrder = await usageWorld();
    let n = 0;
    for (const a of ACCOUNTS) {
      const lines = keys.filter((k) => k.account === a).map((k) => line(k, 0, true));
      if (lines.length > 0) await inOrder.settle(usageBatch(`rating-1:0:${seed}-in-${n++}:0`, a, lines));
    }
    assert.deepEqual(nonZero(inOrder.balances()), nonZero(want), `${seedNote(seed)}: delivery in order`);

    const shuffled = await usageWorld();
    const next = new Map<Key, number>(keys.map((k) => [k, 0]));
    const sent: ChargeLineBatch[] = [];
    while ([...next].some(([k, s]) => s < k.totals.length)) {
      const a = ACCOUNTS[int(r, 0, ACCOUNTS.length - 1)]!;
      // One sequence for each line key in a batch; k + 1 only after k is posted (C06 D2).
      const due = keys.filter((k) => k.account === a && next.get(k)! < k.totals.length && r() < 0.6);
      if (due.length > 0) {
        const lines = due.map((k) => line(k, next.get(k)!, false));
        if (r() < 0.3 && sent.length > 0) lines.push(...structuredClone(sent[int(r, 0, sent.length - 1)]!.lines).filter((l) => l.account === a && !lines.some((x) => JSON.stringify(x.sourceRef.kind === 'usage' && x.sourceRef.minute) === JSON.stringify(l.sourceRef.kind === 'usage' && l.sourceRef.minute))));
        const b = usageBatch(`rating-1:0:${seed}-out-${n++}:0`, a, lines);
        const acks = await shuffled.settle(b);
        assert.ok(acks.every((x) => x.outcome === 'posted'), `${seedNote(seed)}: ${JSON.stringify(acks.filter((x) => x.outcome !== 'posted'))}`);
        for (const k of due) next.set(k, next.get(k)! + 1);
        sent.push(b);
      }
      if (r() < 0.2 && sent.length > 0) await shuffled.settle(structuredClone(sent[int(r, 0, sent.length - 1)]!));
    }
    assert.deepEqual(nonZero(shuffled.balances()), nonZero(inOrder.balances()), `${seedNote(seed)}: out of order differs from in order`);
    assertZeroSum(shuffled, seed);
    // P4-S39: a late-traffic amendment debits the buyer and never debits a party.
    for (const mv of allMovements(shuffled)) for (const l of mv.lines) {
      if (l.outcome !== 'posted' || l.reason !== 'late_traffic') continue;
      assert.ok(l.entries.every((e) => (e.ledgerAccount.startsWith('B:') ? BigInt(e.amount) < 0n : BigInt(e.amount) > 0n)), `${seedNote(seed)}: P4-S39 ${JSON.stringify(l.entries)}`);
    }
  }
});

test('P4-S57 B13: Per-line dedup: batches re-composed after injected settlement crashes post every line once; a changed line is excluded and reported, and moves nothing', async () => {
  for (const seed of seeds(15, 401)) {
    const r = rng(seed);
    const w = await usageWorld();
    // The oracle: the content accepted first for each SourceRef; each line is posted once at that content.
    const accepted = new Map<string, ChargeLine>();
    const pool: ChargeLine[] = [];
    let n = 0;
    let offset = 0n;
    let conflicts = 0;
    for (let step = 0; step < 30; step++) {
      const a = ACCOUNTS[int(r, 0, ACCOUNTS.length - 1)]!;
      const lines: ChargeLine[] = [];
      const used = new Set<string>();
      for (let i = 0; i < int(r, 1, 4); i++) {
        const old = pool.filter((l) => l.account === a);
        let l: ChargeLine;
        if (r() < 0.4 && old.length > 0) {
          l = structuredClone(old[int(r, 0, old.length - 1)]!);
          if (r() < 0.25) { const v = (BigInt(l.amount) + 1n).toString(); l = { ...l, amount: v, newTotal: v }; }
        } else {
          const [route, wv] = ROUTES[int(r, 0, ROUTES.length - 1)]!;
          l = chargeLine(a, usageRef(a, route, minute(int(r, 0, 20))), 'usage', 0n, BigInt(int(r, 1, 5_000)), { route, weightsVersion: wv });
        }
        const k = JSON.stringify(l.sourceRef);
        if (used.has(k)) continue;
        used.add(k);
        lines.push(l);
      }
      const b = usageBatch(`rating-1:0:${seed}-${n++}:0`, a, lines);
      const changed = lines.some((l) => { const f = accepted.get(JSON.stringify(l.sourceRef)); return f !== undefined && f.amount !== l.amount; });
      const src = { partition: 0, offset: offset++ };
      if (r() < 0.2) {
        // A crash before the answer: the batch is read again by a restarted instance, sometimes re-composed under a new id.
        w.settlement.receive(src, b);
        w.restartSettlement();
        const again = r() < 0.5 ? b : { ...b, batch: { ...b.batch, id: `${b.batch.id}-r` } };
        await w.settle(structuredClone(again), src);
      } else {
        await w.settle(b, src);
      }
      const acks: LineAck[] = w.acksFor(b.batch.id).concat(w.acksFor(`${b.batch.id}-r`));
      if (changed) {
        conflicts += 1;
        assert.ok(acks.some((x) => x.outcome === 'excluded' && x.reason === 'content_conflict'), `${seedNote(seed)}: a changed line is excluded content_conflict`);
        assert.ok(acks.every((x) => x.outcome === 'excluded'), `${seedNote(seed)}: a usage batch with a conflict posts nothing`);
      } else {
        for (const l of lines) { const k = JSON.stringify(l.sourceRef); if (!accepted.has(k)) accepted.set(k, l); pool.push(l); }
      }
    }
    const want = new Map<string, bigint>();
    for (const l of accepted.values()) {
      const T = BigInt(l.newTotal);
      want.set(`B:${l.account}`, (want.get(`B:${l.account}`) ?? 0n) - T);
      for (const [p, s] of refSplit(T, W.find(l.route!, l.weightsVersion!)!)) want.set(accountOf(p), (want.get(accountOf(p)) ?? 0n) + s);
    }
    assert.deepEqual(nonZero(w.balances()), nonZero(want), `${seedNote(seed)}: balances differ from the first accepted content of each line`);
    assert.equal(w.ledger.alerts.filter((x) => x.code === 'INTEGRITY_LINE_CONFLICT').length >= conflicts, true, `${seedNote(seed)}: each conflict is reported`);
    assertZeroSum(w, seed);
  }
});

test('P4-S116 B13: Cost-line amendments: no supplier\'s holding of a cost line ever falls except by its own fault, and Share never pays a party twice for the same total', async () => {
  const suppliers = ['A', 'B', 'C'];
  for (const seed of seeds(20, 501)) {
    const r = rng(seed);
    const w = await usageWorld();
    const weights = W.find('R1', 'w1')!;
    let total = BigInt(int(r, 1, 20_000));
    const ref = (seq: number) => ({ kind: 'carried_excess' as const, account: 'b1', product: 'best-effort', route: 'R1', minute: minute(0), seq });
    await w.settle(usageBatch(`rating-1:0:${seed}-0:0`, 'b1', [chargeLine('b1', ref(0), 'carried_excess', 0n, total, { product: 'best-effort' })]));
    // The oracle (RFC-004 §B2 M23): paid_i rises to split(T)_i when that is higher; it falls only for cause supplier i.
    const paid = new Map(suppliers.map((s) => [s, refSplit(total, weights).get(s)!]));
    const highest = new Map(paid);
    for (let seq = 1; seq <= 12; seq++) {
      let next = BigInt(int(r, 0, 20_000));
      if (next === total) next += 1n;
      const roll = r();
      const cause = roll < 0.3 ? { kind: 'share' as const } : roll < 0.45 ? { kind: 'other' as const }
        : { kind: 'supplier' as const, supplier: suppliers[int(r, 0, 2)]! };
      const before = new Map(suppliers.map((s) => [s, w.balances().get(`S:${s}:earn`) ?? 0n]));
      const acks = await w.settle(usageBatch(`rating-1:0:${seed}-${seq}:0`, 'b1', [chargeLine('b1', ref(seq), 'carried_excess', total, next,
        { product: 'best-effort', reason: next > total ? 'corrected_record' : 'superseding_record', cause })]));
      assert.deepEqual(acks.map((a) => a.outcome), ['posted'], `${seedNote(seed)}: seq ${seq}`);
      const target = refSplit(next, weights);
      for (const s of suppliers) {
        const t = target.get(s)!;
        if (t > paid.get(s)!) paid.set(s, t);
        else if (t < paid.get(s)! && cause.kind === 'supplier' && cause.supplier === s) paid.set(s, t);
        highest.set(s, t > highest.get(s)! ? t : highest.get(s)!);
        const earn = w.balances().get(`S:${s}:earn`) ?? 0n;
        assert.ok(earn >= before.get(s)!, `${seedNote(seed)}: ${s}'s earnings fell at seq ${seq}`);
        const holding = earn + (w.balances().get(`S:${s}:debt`) ?? 0n);
        assert.ok(holding <= highest.get(s)!, `${seedNote(seed)}: ${s} holds more than the split of any total: paid twice`);
      }
      total = next;
    }
    const b = w.balances();
    for (const s of suppliers) {
      assert.equal((b.get(`S:${s}:earn`) ?? 0n) + (b.get(`S:${s}:debt`) ?? 0n), paid.get(s)!, `${seedNote(seed)}: ${s} holds other than the oracle`);
      if (b.has(`S:${s}:debt`)) assert.ok(b.get(`S:${s}:debt`)! <= 0n, seedNote(seed));
    }
    assert.equal(b.get('SH:costs') ?? 0n, -[...paid.values()].reduce((x, y) => x + y, 0n), `${seedNote(seed)}: Share's costs are not the sum held`);
    assert.equal(b.get('B:b1') ?? 0n, 0n, `${seedNote(seed)}: a cost line never touches the buyer`);
    assertZeroSum(w, seed);
  }
});

test('P3-S61 B13: Batch kinds and Usage batches whole: a usage batch with a conflict, a sequence gap, an invalid line or too many lines posts nothing; a reservation batch posts every good line; a duplicate never refuses a batch', async () => {
  for (const seed of seeds(15, 601)) {
    const r = rng(seed);
    const w = await usageWorld();
    const posted = new Map<string, bigint>();
    const want = new Map<string, bigint>();
    const credit = (account: string, route: string, wv: string, amount: bigint): void => {
      want.set(`B:${account}`, (want.get(`B:${account}`) ?? 0n) - amount);
      for (const [p, s] of refSplit(amount, W.find(route, wv)!)) want.set(accountOf(p), (want.get(accountOf(p)) ?? 0n) + s);
    };
    let n = 0;
    let m = 0;
    for (let step = 0; step < 25; step++) {
      const a = ACCOUNTS[int(r, 0, ACCOUNTS.length - 1)]!;
      const [route, wv] = ROUTES[int(r, 0, ROUTES.length - 1)]!;
      if (r() < 0.35) {
        const mn = minute(100 + m++);
        const good = Array.from({ length: int(r, 1, 4) }, (_, i) => reservationLine(a, `r-${seed}-${step}-${i}`, mn, BigInt(int(r, 1, 5_000)), { route, weightsVersion: wv }));
        const bad = r() < 0.5 ? [reservationLine(a, `r-${seed}-${step}-x`, mn, 10n, { reason: 'late_traffic', route, weightsVersion: wv })] : [];
        const acks = await w.settle(reservationBatch(`rating-1:0:${seed}-${n++}:0`, a, mn, [...good, ...bad]));
        assert.equal(acks.filter((x) => x.outcome === 'posted').length, good.length, `${seedNote(seed)}: a reservation batch posts every good line`);
        for (const l of good) credit(a, route, wv, BigInt(l.amount));
        continue;
      }
      const fresh = Array.from({ length: int(r, 1, 4) }, () => chargeLine(a, usageRef(a, route, minute(int(r, 0, 1_000))), 'usage', 0n, BigInt(int(r, 1, 5_000)), { route, weightsVersion: wv }))
        .filter((l, i, all) => !posted.has(JSON.stringify(l.sourceRef)) && all.findIndex((x) => JSON.stringify(x.sourceRef) === JSON.stringify(l.sourceRef)) === i);
      const old = [...posted.keys()].map((k) => JSON.parse(k) as Extract<ChargeLine['sourceRef'], { kind: 'usage' }>).filter((k) => k.account === a && k.route === route);
      const lines = [...fresh];
      const dup = old.length > 0 && r() < 0.4 ? old[int(r, 0, old.length - 1)]! : undefined;
      if (dup) lines.push(chargeLine(a, dup, 'usage', 0n, posted.get(JSON.stringify(dup))!, { route, weightsVersion: wv }));
      const defect = int(r, 0, 4);
      if (defect === 1 && dup) lines[lines.length - 1] = chargeLine(a, dup, 'usage', 0n, posted.get(JSON.stringify(dup))! + 1n, { route, weightsVersion: wv });
      if (defect === 2) lines.push(chargeLine(a, usageRef(a, route, minute(5_000 + step), 2), 'usage', 0n, 5n, { route, weightsVersion: wv }));
      if (defect === 3) lines.push(chargeLine(a, usageRef(a, route, minute(6_000 + step)), 'usage', 0n, 5n, { route, weightsVersion: wv, reason: 'late_traffic' }));
      if (defect === 4 && r() < 0.3) {
        lines.push(...Array.from({ length: 5_001 - lines.length }, (_, i) => chargeLine(a, usageRef(a, route, minute(10_000 + i)), 'usage', 0n, 1n, { route, weightsVersion: wv })));
      }
      if (lines.length === 0) continue;
      const defective = (defect === 1 && dup !== undefined) || defect === 2 || defect === 3 || lines.length > 5_000;
      const acks = await w.settle(usageBatch(`rating-1:0:${seed}-${n++}:0`, a, lines));
      assert.equal(acks.length, lines.length, `${seedNote(seed)}: each line is answered once`);
      if (defective) {
        assert.ok(acks.every((x) => x.outcome === 'excluded'), `${seedNote(seed)}: a usage batch with a defect is never partly posted`);
      } else {
        assert.ok(acks.every((x) => x.outcome === 'posted'), `${seedNote(seed)}: a usage batch with duplicates only posts whole: ${JSON.stringify(acks)}`);
        for (const l of fresh) { posted.set(JSON.stringify(l.sourceRef), BigInt(l.amount)); credit(a, route, wv, BigInt(l.amount)); }
      }
    }
    assert.deepEqual(nonZero(w.balances()), nonZero(want), `${seedNote(seed)}: balances differ from the good lines`);
    assertZeroSum(w, seed);
  }
});
