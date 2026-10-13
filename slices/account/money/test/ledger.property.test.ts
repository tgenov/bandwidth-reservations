/**
 * Money invariants of the ledger and settlement over random input, against simple oracles (engineering.md §2):
 * every movement and the whole ledger sum to zero (P4-S28), a line is posted at most once whatever is sent
 * again, and the balances equal a replay of the movement log. Seeded: a failure names its seed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8 } from '@share/owner-runtime';
import {
  LEDGER_ENTRY, TOPIC, ledgerPartitionOfBuyer, sourceRefDigest, type ChargeLineBatch, type MovementPosted, type SourceRef,
  type StoredMovement,
} from '../src/index.ts';
import { moneyWorld, reservationBatch, reservationLine, type MoneyWorld } from '../testing/index.ts';
import { int, rng, seedNote, seeds } from './support.ts';

const ACCOUNTS = ['b1', 'b2', 'b3', 'b4', 'b5'];
const ROUTES: Array<[string, string]> = [['R1', 'w1'], ['R2', 'w2'], ['R3', 'w3']];

function minute(m: number): string {
  return new Date(Date.UTC(2026, 9, 12, 9, m)).toISOString().replace('.000Z', 'Z');
}

function allMovements(w: MoneyWorld): StoredMovement[] {
  const parts = new Set(ACCOUNTS.map((a) => ledgerPartitionOfBuyer(a)));
  return [...parts].flatMap((p) => w.rt.log(utf8(p)).filter((e) => e.entry.kind === LEDGER_ENTRY.movement)
    .map((e) => (e.entry.payload as { movement: StoredMovement }).movement));
}

test('P4-S28 every money movement sums to zero and the ledger in USD sums to zero, for random reservation batches, redeliveries, conflicts and top-ups', async () => {
  for (const seed of seeds(25)) {
    const r = rng(seed);
    const w = await moneyWorld();
    const sent: ChargeLineBatch[] = [];
    let batchNo = 0;
    let offset = 0n;
    for (let step = 0; step < 40; step++) {
      const roll = r();
      if (roll < 0.15 && sent.length > 0) {
        // Send an earlier batch again, unchanged or with one line changed (a conflict).
        const again = structuredClone(sent[int(r, 0, sent.length - 1)]!);
        if (r() < 0.4) {
          const l = again.lines[0]!;
          const v = (BigInt(l.amount) + 1n).toString();
          again.lines[0] = { ...l, amount: v, newTotal: v };
        }
        await w.settle(again, { partition: 0, offset: offset++ });
      } else if (roll < 0.25) {
        const account = ACCOUNTS[int(r, 0, ACCOUNTS.length - 1)]!;
        const x = BigInt(int(r, 1, 50_000_000));
        await w.post(account, {
          movementRef: `prov:txn-${seed}-${step}:completed`, cause: 'payment notification', currency: 'USD',
          lines: [{ kind: 'M1', entries: [{ ledgerAccount: 'X:partner:prov', amount: (-x).toString() }, { ledgerAccount: `B:${account}`, amount: x.toString() }] }],
        }, 'payments');
      } else {
        const account = ACCOUNTS[int(r, 0, ACCOUNTS.length - 1)]!;
        const m = minute(int(r, 0, 5));
        const lines = Array.from({ length: int(r, 1, 6) }, () => {
          const [route, wv] = ROUTES[int(r, 0, ROUTES.length - 1)]!;
          const amount = r() < 0.1 ? 0n : BigInt(int(r, 1, 2_000_000_000)) * BigInt(int(r, 1, 3));
          return reservationLine(account, `r-${account}-${int(r, 1, 8)}`, m, amount, { route, weightsVersion: wv });
        });
        batchNo += 1;
        const b = reservationBatch(`rating-1:0:${seed}-${batchNo}:0`, account, m, lines);
        sent.push(b);
        await w.settle(b, { partition: 0, offset: offset++ });
      }
    }
    const movements = allMovements(w);
    for (const mv of movements) {
      for (const l of mv.lines) {
        assert.equal(l.entries.reduce((a, e) => a + BigInt(e.amount), 0n), 0n, `${seedNote(seed)}: ${mv.movementId} has a line that does not sum to zero`);
        assert.ok(l.entries.every((e) => e.currency === 'USD' && e.amount !== '0'), seedNote(seed));
      }
    }
    const replay = new Map<string, bigint>();
    for (const mv of movements) for (const l of mv.lines) for (const e of l.entries) replay.set(e.ledgerAccount, (replay.get(e.ledgerAccount) ?? 0n) + BigInt(e.amount));
    const balances = w.balances();
    assert.equal([...balances.values()].reduce((a, b) => a + b, 0n), 0n, `${seedNote(seed)}: the ledger does not sum to zero`);
    for (const k of new Set([...replay.keys(), ...balances.keys()])) {
      assert.equal(balances.get(k) ?? 0n, replay.get(k) ?? 0n, `${seedNote(seed)}: ${k} differs from the replay of the log`);
    }
    const posted = new Map<string, number>();
    for (const mv of movements) for (const l of mv.lines) {
      if (l.outcome === 'posted' && typeof l.lineRef === 'object') posted.set(sourceRefDigest(l.lineRef as SourceRef), (posted.get(sourceRefDigest(l.lineRef as SourceRef)) ?? 0) + 1);
    }
    assert.ok([...posted.values()].every((n) => n === 1), `${seedNote(seed)}: a line is posted twice`);
    const ids = w.events<MovementPosted>(TOPIC.movements).map((e) => JSON.stringify(e.event.eventId));
    assert.equal(new Set(ids).size, movements.length, `${seedNote(seed)}: one event for each movement`);
  }
});

test('C06 CT-L5 a line key is charged once, at the amount of its first accepted send, for random batches, resends, changed lines and top-ups', async () => {
  for (const seed of seeds(25, 101)) {
    const r = rng(seed);
    const w = await moneyWorld();
    const sent: ChargeLineBatch[] = [];
    // The oracle: a batch whose id made a movement posts nothing again; in a new batch the first valid line of a
    // key (amount > 0, first in the batch) is charged only if the key was never charged before.
    const committed = new Set<string>();
    const charged = new Map<string, bigint>();
    const topUps = new Map<string, bigint>();
    const chargedOf = new Map<string, bigint>();
    const model = (b: ChargeLineBatch): void => {
      if (committed.has(b.batch.id)) return;
      const inBatch = new Set<string>();
      const valid = b.lines.filter((l) => {
        if (BigInt(l.amount) <= 0n) return false;
        const k = sourceRefDigest(l.sourceRef);
        if (inBatch.has(k)) return false;
        inBatch.add(k);
        return true;
      });
      if (valid.length === 0) return;
      committed.add(b.batch.id);
      for (const l of valid) {
        const k = sourceRefDigest(l.sourceRef);
        if (charged.has(k)) continue;
        charged.set(k, BigInt(l.amount));
        chargedOf.set(b.batch.account, (chargedOf.get(b.batch.account) ?? 0n) + BigInt(l.amount));
      }
    };
    let batchNo = 0;
    let offset = 0n;
    for (let step = 0; step < 40; step++) {
      const roll = r();
      if (roll < 0.3 && sent.length > 0) {
        const again = structuredClone(sent[int(r, 0, sent.length - 1)]!);
        if (r() < 0.5) {
          const i = int(r, 0, again.lines.length - 1);
          const l = again.lines[i]!;
          const v = (BigInt(l.amount) + BigInt(int(r, 1, 1000))).toString();
          again.lines[i] = { ...l, amount: v, newTotal: v };
        }
        if (r() < 0.5) again.batch.id = `${again.batch.id}-resent-${step}`;
        model(again);
        await w.settle(again, { partition: 0, offset: offset++ });
      } else if (roll < 0.4) {
        const account = ACCOUNTS[int(r, 0, ACCOUNTS.length - 1)]!;
        const x = BigInt(int(r, 1, 50_000_000));
        topUps.set(account, (topUps.get(account) ?? 0n) + x);
        await w.post(account, {
          movementRef: `prov:txn-${seed}-${step}:completed`, cause: 'payment notification', currency: 'USD',
          lines: [{ kind: 'M1', entries: [{ ledgerAccount: 'X:partner:prov', amount: (-x).toString() }, { ledgerAccount: `B:${account}`, amount: x.toString() }] }],
        }, 'payments');
      } else {
        const account = ACCOUNTS[int(r, 0, ACCOUNTS.length - 1)]!;
        const m = minute(int(r, 0, 3));
        const lines = Array.from({ length: int(r, 1, 6) }, () => {
          const [route, wv] = ROUTES[int(r, 0, ROUTES.length - 1)]!;
          const amount = r() < 0.1 ? 0n : BigInt(int(r, 1, 2_000_000_000));
          return reservationLine(account, `r-${account}-${int(r, 1, 4)}`, m, amount, { route, weightsVersion: wv });
        });
        batchNo += 1;
        const b = reservationBatch(`rating-1:0:${seed}-${batchNo}:0`, account, m, lines);
        sent.push(b);
        model(b);
        await w.settle(b, { partition: 0, offset: offset++ });
      }
    }
    const balances = w.balances();
    for (const a of ACCOUNTS) {
      const want = (topUps.get(a) ?? 0n) - (chargedOf.get(a) ?? 0n);
      assert.equal(balances.get(`B:${a}`) ?? 0n, want, `${seedNote(seed)}: B:${a} is not its top-ups less the first accepted amount of each line key`);
    }
    const credited = [...balances].filter(([k]) => k.startsWith('S:') || k === 'SH:commission').reduce((s, [, v]) => s + v, 0n);
    const total = [...charged.values()].reduce((s, v) => s + v, 0n);
    assert.equal(credited, total, `${seedNote(seed)}: the parties are not credited exactly the charged amounts`);
    const postedByKey = new Map<string, bigint>();
    for (const mv of allMovements(w)) for (const l of mv.lines) {
      if (l.outcome !== 'posted' || typeof l.lineRef !== 'object') continue;
      const k = sourceRefDigest(l.lineRef as SourceRef);
      assert.ok(!postedByKey.has(k), `${seedNote(seed)}: a line key is posted twice`);
      postedByKey.set(k, -BigInt(l.entries.find((e) => e.ledgerAccount.startsWith('B:'))?.amount ?? '0'));
    }
    assert.deepEqual(postedByKey, charged, `${seedNote(seed)}: the posted line keys and amounts differ from the oracle`);
  }
});
