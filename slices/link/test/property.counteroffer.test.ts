/**
 * T-04 on the apply state machine (exit criterion 1): counter-offers against the per-minute oracle, on a dense
 * schedule with many overcommitted runs, open-ended requests, a schedule full for ever, several blockers, the
 * step bound, the batch budget and the per-batch cache. Each batch is decided at one `ts`. Some batches are
 * rolled back and decided again (a restart). At the end, the log is replayed on a new state with a new batch
 * at each new ts, and gives the recorded outcomes. The owner's own replay is tested in `counteroffer.test.ts`
 * ("T-04 a replay after a takeover …").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeJson, hex, type HlcTs } from '@share/owner-runtime';
import { DEFAULT_POLICY, LinkState, requestKey, type HoldCmd, type LinkCommand, type LinkPolicy, type Outcome } from '../src/index.ts';
import { int, M, MinuteOracle, rng } from './support.ts';

const DOMAIN = 600;
const CAPACITY = 10;
const BASE = M(0);
const T0 = Date.UTC(2026, 2, 2, 0, 0);

interface Logged { cmd: LinkCommand; ts: HlcTs; seq: bigint; outcome: Outcome }

const tsAt = (ms: number, logical: number): HlcTs => `${BigInt(ms) * 1_000_000n}.${String(logical).padStart(10, '0')}` as HlcTs;

function holdBody(r: () => number, seq: bigint, nowMs: number): HoldCmd {
  const start = BASE + 10 * int(r, 0, DOMAIN / 10 - 13);
  const end = r() < 0.12 ? null : start + 10 * int(r, 1, 12);
  // Long deadlines: no record leaves memory in a run (this test has no link_request rows to read).
  const deadline = nowMs + int(r, 600_000, 900_000);
  const account = new Uint8Array([int(r, 1, 9)]);
  return {
    link: 'P', receiverPartition: 'P', request: { partition: account, seq }, account, leg: 'l', holdKind: { kind: 'booking' },
    rateMbps: int(r, 1, 7), window: { start, end }, deadline, commitFence: deadline - 420, requestAge: tsAt(nowMs, 0),
    wait: r() < 0.1, receiptMinute: Math.floor(nowMs / 60_000), policyVersion: 1n,
  };
}

/** Decide a batch; on a restart, roll it back and decide it again at the same ts. */
function decideBatch(st: LinkState, cmds: LinkCommand[], ts: HlcTs, seq0: bigint): Array<{ outcome: Outcome; seq?: bigint }> {
  st.beginBatch(ts);
  let seq = seq0;
  const out: Array<{ outcome: Outcome; seq?: bigint }> = [];
  for (const c of cmds) {
    const d = st.decide(c, ts, seq + 1n);
    if (d.entry) { seq += 1n; st.advance(seq, ts); out.push({ outcome: d.outcome, seq }); } else out.push({ outcome: d.outcome });
  }
  return out;
}

function run(seed: number, policy: LinkPolicy): { log: Logged[]; counts: Record<string, number> } {
  const r = rng(seed);
  const st = new LinkState();
  st.init({ link: 'P', capacityMbps: CAPACITY, policy });
  st.commit();
  const oracle = new MinuteOracle(BASE, DOMAIN, CAPACITY, policy);
  const held: HoldCmd[] = [];
  const log: Logged[] = [];
  const counts: Record<string, number> = {};
  let seq = 1n;
  let reqSeq = 0n;
  let nowMs = T0;
  for (let b = 0; b < 150; b++) {
    nowMs += int(r, 0, 1_500);
    const ts = tsAt(nowMs, b + 1);
    const cmds: LinkCommand[] = [];
    for (let i = int(r, 1, 14); i > 0; i--) {
      const p = r();
      const pick = held.length > 0 ? held[int(r, 0, held.length - 1)] as HoldCmd : undefined;
      if (p < 0.12 && pick) cmds.push({ op: 'release', body: { link: 'P', receiverPartition: 'P', request: pick.request, deadline: pick.deadline, reason: 'REJECTED', decisionTime: ts } });
      else if (p < 0.27 && pick) {
        cmds.push({ op: 'convert', body: { link: 'P', receiverPartition: 'P', request: pick.request, attempt: 1, reservation: `r${pick.request.seq}`, leg: 'l', part: 'p', createdBy: pick.request, decisionTime: ts } });
      } else {
        reqSeq += 1n;
        const h = holdBody(r, reqSeq, nowMs);
        held.push(h);
        cmds.push({ op: 'hold', body: h });
      }
    }
    // A restart: decide, roll back, and decide again. The second run must give the same outcomes.
    if (r() < 0.15) {
      const first = decideBatch(st, cmds, ts, seq);
      st.rollback();
      const second = decideBatch(st, cmds, ts, seq);
      assert.equal(hex(encodeJson(second)), hex(encodeJson(first)), `seed ${seed} batch ${b}: a restart decides the same`);
    }
    st.rollback();
    const decided = decideBatch(st, cmds, ts, seq);
    st.commit();
    cmds.forEach((c, i) => {
      const d = decided[i] as { outcome: Outcome; seq?: bigint };
      const want = oracle.apply(c, ts);
      assert.equal(hex(encodeJson(d.outcome)), hex(encodeJson(want)),
        `seed ${seed}, batch ${b}, command ${i} (${c.op} ${requestKey(c.body.request)}): link ${JSON.stringify(d.outcome)} oracle ${JSON.stringify(want)}`);
      if (d.seq !== undefined) { seq = d.seq; log.push({ cmd: c, ts, seq: d.seq, outcome: d.outcome }); }
      const offer = (d.outcome as { counterOffer?: { earliest: object } }).counterOffer;
      if (offer) for (const k of Object.keys(offer.earliest)) counts[k] = (counts[k] ?? 0) + 1;
    });
    // P1-N1 with counter-offers: occ_all never goes above C_ref.
    assert.ok(st.occAll.peak(BASE, null) <= CAPACITY, `seed ${seed} batch ${b}: occ_all ≤ C_ref`);
  }
  return { log, counts };
}

/** Replay the log on a new state: a new batch at each new ts. */
function replay(log: Logged[], policy: LinkPolicy): Outcome[] {
  const st = new LinkState();
  st.init({ link: 'P', capacityMbps: CAPACITY, policy });
  let batchTs: HlcTs | undefined;
  return log.map((e) => {
    if (e.ts !== batchTs) { st.beginBatch(e.ts); batchTs = e.ts; }
    const d = st.decide(e.cmd, e.ts, e.seq);
    st.advance(e.seq, e.ts);
    return d.outcome;
  });
}

const POLICIES: Array<[string, LinkPolicy]> = [
  ['default budgets', DEFAULT_POLICY],
  ['3 steps per refusal, 8 per batch', { ...DEFAULT_POLICY, counterofferSteps: 3, counterofferBatchSteps: 8 }],
  ['1 step per refusal, 2 per batch', { ...DEFAULT_POLICY, counterofferSteps: 1, counterofferBatchSteps: 2 }],
];

for (const [name, policy] of POLICIES) {
  test(`T-04 counter-offers equal the per-minute oracle on a dense schedule with ${name} (seeds 1 to 12)`, () => {
    const counts: Record<string, number> = {};
    for (let seed = 1; seed <= 12; seed++) {
      const res = run(seed, policy);
      for (const [k, v] of Object.entries(res.counts)) counts[k] = (counts[k] ?? 0) + v;
    }
    assert.ok((counts['window'] ?? 0) > 0 && (counts['none'] ?? 0) > 0, `windows and none occur: ${JSON.stringify(counts)}`);
    if (policy !== DEFAULT_POLICY) assert.ok((counts['notFoundBefore'] ?? 0) > 0, `the budget is reached: ${JSON.stringify(counts)}`);
  });
}

test('T-04 a replay of the log decides as the live batches when the batch budget binds', () => {
  const policy = { ...DEFAULT_POLICY, counterofferSteps: 3, counterofferBatchSteps: 8 };
  for (const seed of [41, 42]) {
    const { log } = run(seed, policy);
    assert.equal(hex(encodeJson(replay(log, policy))), hex(encodeJson(log.map((e) => e.outcome))), `seed ${seed}: the replay gives the recorded outcomes`);
  }
});
