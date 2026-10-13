/**
 * Property test of the hot standby's memory feed (RFC-006 §4.4; engineering.md §2: an invariant that protects
 * capacity has a property test). Oracle: the set of committed rows. A seeded model of the holder runs two lanes of
 * one slot, Ambiguous commits and their resolution, and pushes with the holder's `prevTs` and `advances` rules.
 * The pushes are lost, reordered and delayed at random; the follower-read tail reads below the closed timestamp.
 *
 * After every step: per partition the applied rows are seq 1, 2, 3, … each once, in order, and every committed row
 * with ts ≤ `completeThrough` is applied. After the holder dies and the takeover catch-up reads the rows above
 * `completeThrough` at the present: every committed row is applied exactly once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HlcTs } from '../src/index.ts';
import { StandbyTail, compareHlc, hex, hlc, utf8, type StandbyPush, type TailRow } from '../src/index.ts';
import type { LogRowWrite } from '../src/store/types.ts';
import { rng } from './support.ts';

const ts = (n: number): HlcTs => hlc(`${n}.0000000000`);
const PARTS = ['P0', 'P1', 'P2', 'P3'];

function row(p: string, seq: bigint): LogRowWrite {
  const b = new Uint8Array();
  return { slot: 0, partition: utf8(p), seq, generation: 0, epoch: 1n, kind: 1, schemaV: 1, identity: utf8(`${p}${seq}`), emits: b, audit: b,
    retention: 1, keyId: b, payload: b, chain: b };
}

interface Batch { parts: string[]; rows: LogRowWrite[]; ts: number | undefined }

/** Runs one seeded history; returns the violation found, or undefined. */
function run(seed: number, steps: number): string | undefined {
  const rnd = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const appliedOrder = new Map<string, bigint[]>();
  const t = new StandbyTail((rows) => {
    for (const r of rows) {
      const k = Buffer.from(r.partition).toString();
      appliedOrder.set(k, [...(appliedOrder.get(k) ?? []), r.seq]);
    }
  });
  const committed: TailRow[] = [];
  const lanes: Array<Batch | undefined> = [undefined, undefined];
  const unresolved: Array<Batch & { ts: number }> = [];
  const nextSeq = new Map<string, bigint>(PARTS.map((p) => [p, 1n]));
  const network: StandbyPush[] = [];
  let clock = 0;
  let pushedThrough = 0;
  let closed = 0;
  t.tail([0], [], ts(0));

  const push = (b: Batch & { ts: number }, advances: boolean): void => {
    network.push({ kind: 'k', slot: 0, epoch: 1n, ts: ts(b.ts), prevTs: ts(pushedThrough), advances, rows: b.rows });
    pushedThrough = Math.max(pushedThrough, b.ts);
  };
  const busy = (): boolean => lanes.some((l) => l !== undefined);
  const check = (when: string): string | undefined => {
    for (const [p, seqs] of appliedOrder) {
      const want = seqs.map((_, i) => BigInt(i + 1));
      if (seqs.join(',') !== want.join(',')) return `seed ${seed} ${when}: ${p} applied seqs ${seqs.join(',')}`;
    }
    const c = t.completeThrough(0);
    for (const r of committed) {
      const k = Buffer.from(r.partition).toString();
      if (c !== undefined && compareHlc(r.ts, c) <= 0 && t.appliedSeq(r.partition) < r.seq) {
        return `seed ${seed} ${when}: ${k} seq ${r.seq} at ${r.ts} is not applied, but complete is ${c}`;
      }
    }
    return undefined;
  };

  for (let i = 0; i < steps; i++) {
    const x = rnd();
    let step: string;
    if (x < 0.2) {
      // Start a batch on an idle lane. The second lane starts only while the first is busy; nothing starts while
      // an Ambiguous batch is unresolved (C01 §3.2); a partition is never in both lanes' batches.
      const L = lanes[0] === undefined ? 0 : 1;
      step = `start lane ${L}`;
      if (lanes[L] === undefined && unresolved.length === 0) {
        const other = lanes[1 - L]?.parts ?? [];
        const free = PARTS.filter((p) => !other.includes(p));
        const parts = [...new Set([pick(free), pick(free)])];
        const rows = parts.map((p) => { const s = nextSeq.get(p) ?? 1n; nextSeq.set(p, s + 1n); return row(p, s); });
        lanes[L] = { parts, rows, ts: undefined };
      }
    } else if (x < 0.3) {
      // A batch reads its ts (its transaction timestamp), not in start order across lanes.
      const L = pick([0, 1]);
      step = `readTs lane ${L}`;
      const b = lanes[L];
      if (b && b.ts === undefined) b.ts = ++clock;
    } else if (x < 0.45) {
      const L = pick([0, 1]);
      step = `commit lane ${L}`;
      const b = lanes[L];
      if (b && b.ts !== undefined) {
        const done = { ...b, ts: b.ts };
        lanes[L] = undefined;
        for (const r of done.rows) committed.push({ ...r, ts: ts(done.ts) });
        if (rnd() < 0.2) unresolved.push(done);                       // Ambiguous: committed, its answer lost
        else push(done, lanes[1 - L] === undefined && unresolved.length === 0);
      }
    } else if (x < 0.5) {
      step = 'resolve';
      const b = unresolved.shift();
      if (b) push(b, !busy() && unresolved.length === 0);
    } else if (x < 0.75) {
      step = 'deliver';
      if (network.length > 0) {
        const [p] = network.splice(Math.floor(rnd() * network.length), 1);
        if (p && rnd() >= 0.2) t.push(p);                             // 20 % of pushes are lost
      }
    } else {
      // The follower-read tail at a closed timestamp below every batch still in flight.
      step = 'tail';
      const inFlight = lanes.flatMap((l) => (l?.ts !== undefined ? [l.ts] : []));
      const maxClosed = Math.min(clock, ...inFlight.map((v) => v - 1));
      if (maxClosed > closed) closed += Math.floor(rnd() * (maxClosed - closed + 1));
      const after = t.completeThrough(0);
      const rows = committed.filter((r) => compareHlc(r.ts, ts(closed)) <= 0 && (after === undefined || compareHlc(r.ts, after) > 0))
        .sort((a, b) => compareHlc(a.ts, b.ts) || hex(a.partition).localeCompare(hex(b.partition)) || (a.seq < b.seq ? -1 : 1));
      t.tail([0], rows, ts(closed));
    }
    const bad = check(`step ${i} (${step})`);
    if (bad) return bad;
  }
  // The holder dies; its in-flight batches end uncommitted; the takeover catch-up reads at the present.
  const after = t.completeThrough(0);
  const rows = committed.filter((r) => after === undefined || compareHlc(r.ts, after) > 0)
    .sort((a, b) => compareHlc(a.ts, b.ts) || hex(a.partition).localeCompare(hex(b.partition)) || (a.seq < b.seq ? -1 : 1));
  t.tail([0], rows, ts(clock + 1), true);
  const bad = check('after the catch-up');
  if (bad) return bad;
  for (const p of PARTS) {
    const want = committed.filter((r) => Buffer.from(r.partition).toString() === p).length;
    const got = (appliedOrder.get(p) ?? []).length;
    if (got !== want) return `seed ${seed}: ${p} has ${got} rows applied, ${want} committed`;
  }
  return undefined;
}

test('should apply every row once in seq order and never move complete past an unapplied row, for seeded push loss, reorder, advances false, Ambiguous batches and tail reads', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const bad = run(seed, 300);
    assert.equal(bad, undefined, bad);
  }
});
