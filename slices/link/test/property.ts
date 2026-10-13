/**
 * The I1 property run (exit criterion 1: T-01 part, T-02, T-03). Clients of the recorded stub send random
 * hold, convert and release commands at the same time. Then the run checks:
 * - every decision, in the order of decision, equals the per-minute oracle applied in that order;
 * - the log holds exactly the decisions that wrote an entry, in log order;
 * - after each entry, occ_all ≤ C_ref at every minute, computed again from the log rows alone (P1-N1);
 * - one request gets one decision: at most one Hold and one Convert entry for each request, and each
 *   repeat gets the recorded state (so a wait = false refusal stays refused after its blocker goes).
 */
import assert from 'node:assert/strict';
import { encodeJson, hex } from '@share/owner-runtime';
import type { DecidedRecord, HoldCmd, LinkCommand, LoggedEntry, LoggedPayload, Outcome } from '../src/index.ts';
import { requestKey } from '../src/index.ts';
import { AccountStub, int, MinuteOracle, resultOf, rng } from './support.ts';

export interface PropertyTarget {
  stub: AccountStub;
  decided: DecidedRecord[];
  capacity: number;
  /** The base minute of the windows. */
  base: number;
  readLog: () => Promise<LoggedEntry[]>;
  /** Moves the clock of a double forward. Undefined on a runtime with a real clock. */
  advance?: (ms: number) => void;
}

export interface PropertyResult { counts: Record<string, number>; entries: number }

const DOMAIN = 2_880;   // two days of minutes

export async function propertyRun(t: PropertyTarget, seed: number, commands: number, clients: number): Promise<PropertyResult> {
  let sent = 0;
  const counts: Record<string, number> = {};
  const runClient = async (c: number): Promise<void> => {
    const r = rng(seed * 7919 + c);
    const account = `acct-${c}`;
    const mine: HoldCmd[] = [];
    const pick = (): HoldCmd | undefined => mine.length === 0 ? undefined : mine[int(r, 0, mine.length - 1)];
    while (sent < commands) {
      sent += 1;
      const p = r();
      let reply: unknown;
      if (p < 0.42 || mine.length === 0) {
        const start = t.base + int(r, 0, DOMAIN - 200);
        const end = r() < 0.08 ? null : start + int(r, 1, 180);
        const cmd = t.stub.holdCmd({ rate: int(r, 1, 6), window: { start, end }, account, deadlineInMs: int(r, 300, 30_000) });
        mine.push(cmd);
        reply = await t.stub.hold(cmd);
      } else if (p < 0.58) {
        const h = pick() as HoldCmd;
        reply = await t.stub.convert(t.stub.convertCmd(h, r() < 0.05 ? 2 : 1));
      } else if (p < 0.78) {
        const h = pick() as HoldCmd;
        reply = await t.stub.release(t.stub.releaseCmd(h.request, h.deadline + (r() < 0.1 ? 1_000 : 0)));
      } else if (p < 0.88) {
        const h = pick() as HoldCmd;
        reply = await t.stub.hold(r() < 0.1 ? { ...h, rateMbps: h.rateMbps + 1 } : h);
      } else if (p < 0.92) {
        const cmd = t.stub.holdCmd({ rate: 1, window: { start: t.base + 10, end: t.base + 20 }, account });
        await t.stub.release(t.stub.releaseCmd(cmd.request, cmd.deadline, 'WITHDRAWN'));
        mine.push(cmd);
        reply = await t.stub.hold(cmd);
      } else if (p < 0.95) {
        const ghost = t.stub.holdCmd({ rate: 1, window: { start: t.base, end: t.base + 1 }, account });
        reply = await t.stub.convert(t.stub.convertCmd(ghost));
      } else {
        t.advance?.(int(r, 0, 3_000));
        continue;
      }
      const k = resultOf(reply);
      counts[k] = (counts[k] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: clients }, (_, c) => runClient(c)));

  // (1) Every decision equals the per-minute oracle, in the order of decision (T-01, T-03).
  const oracle = new MinuteOracle(t.base, DOMAIN, t.capacity);
  const cmds = t.decided.filter((d) => 'op' in d.command);
  for (const [i, d] of cmds.entries()) {
    const want = oracle.apply(d.command as LinkCommand, d.ts);
    assert.equal(hex(encodeJson(d.outcome)), hex(encodeJson(want)),
      `seed ${seed}, decision ${i} (${(d.command as LinkCommand).op}): link ${JSON.stringify(d.outcome)} oracle ${JSON.stringify(want)}`);
  }

  // (2) The log holds exactly the decisions that wrote an entry, in log order.
  const log = await t.readLog();
  const cmdEntries = log.filter((e) => { const op = (e.payload as LoggedPayload).op; return op !== 'init' && op !== 'takeover'; });
  const withSeq = cmds.filter((d) => d.seq !== undefined);
  assert.deepEqual(cmdEntries.map((e) => e.seq), withSeq.map((d) => d.seq as bigint), `seed ${seed}: log sequences`);
  for (const [i, e] of cmdEntries.entries()) {
    assert.equal(hex(encodeJson((e.payload as { outcome: Outcome }).outcome)), hex(encodeJson((withSeq[i] as DecidedRecord).outcome)));
  }

  // (3) P1-N1 from the log rows alone, after each entry; (4) one decision for each request.
  const all = new Int32Array(DOMAIN);
  const held = new Map<string, { s: number; e: number; b: number }>();
  const holdEntries = new Set<string>();
  const convertEntries = new Set<string>();
  for (const e of log) {
    const p = e.payload as LoggedPayload;
    if (p.op === 'init' || p.op === 'takeover') continue;
    const key = requestKey(p.body.request);
    if (p.op === 'hold') {
      assert.ok(!holdEntries.has(key), `seed ${seed}: two hold entries for ${key}`);
      holdEntries.add(key);
      if ((p.outcome as { result?: string }).result === 'HELD') {
        const b = p.body as HoldCmd;
        const span = { s: b.window.start - t.base, e: (b.window.end ?? t.base + DOMAIN) - t.base, b: b.rateMbps };
        held.set(key, span);
        for (let m = span.s; m < span.e; m++) {
          all[m] = (all[m] as number) + span.b;
          assert.ok((all[m] as number) <= t.capacity, `seed ${seed}: occ_all ${all[m]} > C_ref at minute ${m} after seq ${e.seq}`);
        }
      }
    } else if (p.op === 'convert') {
      assert.ok(!convertEntries.has(key), `seed ${seed}: two convert entries for ${key}`);
      convertEntries.add(key);
      held.delete(key);
    } else {
      const span = held.get(key);
      if (span) {
        for (let m = span.s; m < span.e; m++) all[m] = (all[m] as number) - span.b;
        held.delete(key);
      }
    }
  }
  return { counts, entries: log.length };
}
