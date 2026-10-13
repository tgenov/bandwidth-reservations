/**
 * The I1 property run (exit criterion 1: T-01 part, T-02, T-03). Clients of the recorded stub send random
 * hold, convert and release commands at the same time. Then the run checks:
 * - every decision, in the order of decision, equals the per-minute oracle applied in that order, with the
 *   counter-offer of each refusal (T-04: the oracle's own budget and cache, a new batch at each new ts);
 * - the log holds exactly the decisions that wrote an entry, in log order;
 * - after each entry, occ_all ≤ C_ref at every minute, computed again from the log rows alone (P1-N1);
 * - one request gets one decision: at most one Hold and one Convert entry for each request, and each
 *   repeat gets the recorded state (so a wait = false refusal stays refused after its blocker goes);
 * - S-LINK I4: invalid requests are mixed in (V1 … V6, and an unapplied policy version). Each gets the
 *   oracle's INVALID(rule) and a tombstone, or UNAVAILABLE with no entry. A hold with `wait = true` that breaks
 *   a rule is refused INVALID(rule) and does not wait (check (4) before check (8), RFC-001 §4.1).
 *
 * With `waitShare` > 0 (S-LINK I3 exit criterion 4), that share of the holds has `wait = true`. The oracle then
 * also gives the waiting-port notices (grants, waiter refusals, waiting notices), and the run checks that the
 * notices in the log are the oracle's, in order, and that each grant keeps occ_all ≤ C_ref.
 * Some holds then reuse the request_age of the client's last hold, so equal ages tie by request sequence.
 *
 * With `yieldShare` > 0 (S-LINK I5), that share of the steps sends `mark_waiting` (positions in order, some stale) or
 * answers an open `YIELD_REQUEST` (accept or refuse, some with a stale attempt), and 30 % of the holds get an older
 * request_age, so younger holders block older waiters. The oracle is then `YieldOracle`. The run also checks from the
 * log rows alone that each yield request goes to a holder that carries the mark, for an older request that waits,
 * with the claim of its entry, and that an accepted yield moves the pulse out of occ_all (P1-N1, P2-S58).
 */
import assert from 'node:assert/strict';
import { encodeJson, hex, hlcToWallMs, type HlcTs } from '@share/owner-runtime';
import type {
  DecidedRecord, HoldCmd, LinkCommand, LinkPolicy, LoggedEntry, LoggedPayload, MarkWaitingCmd, Outcome, RequestId, WaitingNotice, YieldAnswerCmd,
} from '../src/index.ts';
import { DEFAULT_POLICY, requestKey } from '../src/index.ts';
import { YieldOracle } from './oracle.yields.ts';
import { AccountStub, int, MinuteOracle, noticeForm, oraclePriority, oracleHorizon, resultOf, rng } from './support.ts';

export interface PropertyTarget {
  stub: AccountStub;
  decided: DecidedRecord[];
  capacity: number;
  /** The base minute of the windows. */
  base: number;
  readLog: () => Promise<LoggedEntry[]>;
  /** Moves the clock of a double forward. Undefined on a runtime with a real clock. */
  advance?: (ms: number) => void;
  /** The policy that the link was registered with (the counter-offer budgets). Default: DEFAULT_POLICY. */
  policy?: LinkPolicy;
  /** The share of the holds with `wait = true` (I3). Default 0: every hold has `wait = false`. */
  waitShare?: number;
  /** The share of the steps that send `mark_waiting` or a yield answer (I5). Default 0: none. */
  yieldShare?: number;
  /** The minutes after `base` in which the windows start (I5: a small spread gives more contention). Default 2,680. */
  spread?: number;
  /** The YIELD_REQUESTs that the link sent so far (I5; needed when `yieldShare` > 0). */
  yieldRequests?: () => Array<{ request: RequestId; attempt: number; claim: bigint }>;
}

export interface PropertyResult { counts: Record<string, number>; entries: number }

const DOMAIN = 2_880;   // two days of minutes

/**
 * Make the hold break one rule (S-LINK I4 exit criterion 4): V1 … V6 against its receipt minute and the
 * horizon of 12 months, or (kind 7) carry a policy version that the link has not applied (UNAVAILABLE).
 */
function breakRule(cmd: HoldCmd, kind: number, r: () => number): void {
  const m0 = cmd.receiptMinute;
  const h = oracleHorizon(m0, 12);
  switch (kind) {
    case 0: cmd.rateMbps = 0; break;
    case 1: cmd.rateMbps = 2.5; break;
    case 2: cmd.window = { start: cmd.window.start + 0.5, end: cmd.window.end }; break;
    case 3: cmd.window = { start: cmd.window.start, end: cmd.window.start - int(r, 0, 5) }; break;
    case 4: cmd.window = { start: m0 - int(r, 1, 600), end: m0 + 10 }; break;
    case 5: cmd.window = { start: h + int(r, 0, 60), end: null }; break;
    case 6: cmd.window = { start: h - 10, end: h + int(r, 1, 60) }; break;
    default: cmd.policyVersion = 9n;
  }
}

export async function propertyRun(t: PropertyTarget, seed: number, commands: number, clients: number): Promise<PropertyResult> {
  let sent = 0;
  const counts: Record<string, number> = {};
  /** I5: the yield requests answered so far (by the stub's position in the list); most answers go to new ones. */
  const answered = new Set<number>();
  const runClient = async (c: number): Promise<void> => {
    const r = rng(seed * 7919 + c);
    const account = `acct-${c}`;
    const mine: HoldCmd[] = [];
    const pick = (): HoldCmd | undefined => mine.length === 0 ? undefined : mine[int(r, 0, mine.length - 1)];
    const ys = t.yieldShare ?? 0;
    const positions = new Map<string, bigint>();
    /** I5: the holds that this client got HELD; most marks go to them. */
    const holding: HoldCmd[] = [];
    /** I5: a mark of one of this client's requests, or an answer to an open yield request. */
    const yieldStep = async (): Promise<unknown> => {
      const open = t.yieldRequests?.() ?? [];
      const link = t.stub.link;
      if (r() < 0.6 || open.length === 0) {
        const h = (holding.length > 0 && r() < 0.8 ? holding[int(r, 0, holding.length - 1)] : pick())
          ?? t.stub.holdCmd({ rate: 1, window: { start: t.base, end: t.base + 1 }, account });
        const k = requestKey(h.request);
        const last = positions.get(k) ?? 0n;
        const position = r() < 0.1 ? last : last + 1n;
        positions.set(k, position > last ? position : last);
        const m: MarkWaitingCmd = { link, receiverPartition: link, request: h.request, waiting: r() < 0.9, position };
        return t.stub.owner.markWaiting(t.stub.envelope(h.account), m);
      }
      const fresh = open.map((_, i) => i).filter((i) => !answered.has(i));
      const i = fresh.length > 0 && r() < 0.85 ? fresh[int(r, 0, fresh.length - 1)] as number : int(r, 0, open.length - 1);
      answered.add(i);
      const n = open[i] as { request: RequestId; attempt: number; claim: bigint };
      const y: YieldAnswerCmd = {
        link, receiverPartition: link, request: n.request, attempt: r() < 0.05 ? n.attempt + 1 : n.attempt, claim: n.claim,
        answer: r() < 0.6 ? 'yield_accept' : 'yield_refuse',
      };
      return t.stub.owner.yieldAnswer(t.stub.envelope(n.request.partition), y);
    };
    while (sent < commands) {
      sent += 1;
      if (ys > 0 && r() < ys) {
        const k = resultOf(await yieldStep());
        counts[k] = (counts[k] ?? 0) + 1;
        continue;
      }
      const p = r();
      let reply: unknown;
      if (p < 0.42 || mine.length === 0) {
        const start = t.base + int(r, 0, t.spread ?? DOMAIN - 200);
        const end = r() < 0.08 ? null : start + int(r, 1, 180);
        const wait = (t.waitShare ?? 0) > 0 && r() < (t.waitShare ?? 0);
        let cmd = t.stub.holdCmd({ rate: int(r, 1, 6), window: { start, end }, account, deadlineInMs: int(r, 300, 30_000), wait });
        // I3: some holds take the request_age of the client's last hold, so the request-sequence tie of the order occurs.
        const last = mine.at(-1);
        if ((t.waitShare ?? 0) > 0 && last && r() < 0.3) cmd = { ...cmd, requestAge: last.requestAge };
        // I5: an older request_age, so a younger holder can block an older waiter.
        if (ys > 0 && r() < 0.5) {
          const older = hlcToWallMs(t.stub.rt.now().ts) - int(r, 1, 5_000);
          cmd = { ...cmd, requestAge: `${BigInt(older) * 1_000_000n}.0000000000` as HlcTs };
        }
        // I4: 10 % of the holds break a rule (with wait = true too: they must be refused INVALID, not wait).
        if (r() < 0.1) breakRule(cmd, int(r, 0, 7), r);
        mine.push(cmd);
        reply = await t.stub.hold(cmd);
        if (ys > 0 && resultOf(reply) === 'HELD') holding.push(cmd);
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
  const oracle = (t.yieldShare ?? 0) > 0 ? new YieldOracle(t.base, DOMAIN, t.capacity, t.policy) : new MinuteOracle(t.base, DOMAIN, t.capacity, t.policy);
  const cmds = t.decided.filter((d) => 'op' in d.command);
  for (const [i, d] of cmds.entries()) {
    const want = oracle.apply(d.command as LinkCommand, d.ts, d.seq);
    assert.equal(hex(encodeJson(d.outcome)), hex(encodeJson(want)),
      `seed ${seed}, decision ${i} (${(d.command as LinkCommand).op}): link ${JSON.stringify(d.outcome)} oracle ${JSON.stringify(want)}`);
  }

  // (2) The log holds exactly the decisions that wrote an entry, in log order. Tick entries continue a scan.
  const log = await t.readLog();
  const cmdEntries = log.filter((e) => { const op = (e.payload as LoggedPayload).op; return op !== 'init' && op !== 'takeover' && op !== 'tick' && op !== 'policy'; });
  const withSeq = cmds.filter((d) => d.seq !== undefined);
  assert.deepEqual(cmdEntries.map((e) => e.seq), withSeq.map((d) => d.seq as bigint), `seed ${seed}: log sequences`);
  for (const [i, e] of cmdEntries.entries()) {
    assert.equal(hex(encodeJson((e.payload as { outcome: Outcome }).outcome)), hex(encodeJson((withSeq[i] as DecidedRecord).outcome)));
  }

  // (1b) The waiting-port notices in the log are the oracle's, in order (I3).
  const logged: WaitingNotice[] = log.flatMap((e) => ('notices' in (e.payload as object) ? (e.payload as { notices?: WaitingNotice[] }).notices ?? [] : []));
  assert.equal(hex(encodeJson(logged.map(noticeForm))), hex(encodeJson(oracle.notices)),
    `seed ${seed}: notices: link ${logged.length}, oracle ${oracle.notices.length}`);
  for (const n of logged) counts[`notice:${n.kind}`] = (counts[`notice:${n.kind}`] ?? 0) + 1;
  counts['tick'] = log.filter((e) => (e.payload as LoggedPayload).op === 'tick').length;

  // (3) P1-N1 from the log rows alone, after each entry; (4) one decision for each request.
  const all = new Int32Array(DOMAIN);
  const held = new Map<string, { s: number; e: number; b: number }>();
  const waiting = new Map<string, { s: number; e: number; b: number }>();
  const holdEntries = new Set<string>();
  const convertEntries = new Set<string>();
  /** I5: the hold command and the applied waiting mark of each request, from the log rows. */
  const holdCmds = new Map<string, HoldCmd>();
  const marked = new Map<string, boolean>();
  const hold = (span: { s: number; e: number; b: number }, seq: bigint): void => {
    for (let m = span.s; m < span.e; m++) {
      all[m] = (all[m] as number) + span.b;
      assert.ok((all[m] as number) <= t.capacity, `seed ${seed}: occ_all ${all[m]} > C_ref at minute ${m} after seq ${seq}`);
    }
  };
  for (const e of log) {
    const p = e.payload as LoggedPayload;
    if (p.op === 'init' || p.op === 'takeover' || p.op === 'policy') continue;
    if (p.op !== 'tick') {
      const key = requestKey(p.body.request);
      // (5) An invalid request is refused INVALID(rule) and its entry records a tombstone until D + release_grace (S-LINK I4).
      const reason = (p.outcome as { reason?: unknown }).reason;
      if (p.op === 'hold' && typeof reason === 'object' && reason !== null && 'invalid' in reason) {
        assert.equal(p.record?.tombstoneUntil, (p.body as HoldCmd).deadline + (t.policy ?? DEFAULT_POLICY).releaseGraceMs, `seed ${seed}: tombstone of ${key}`);
      }
      if (p.op === 'hold') {
        assert.ok(!holdEntries.has(key), `seed ${seed}: two hold entries for ${key}`);
        holdEntries.add(key);
        holdCmds.set(key, p.body as HoldCmd);
        const result = (p.outcome as { result?: string }).result;
        const b = p.body as HoldCmd;
        const span = { s: b.window.start - t.base, e: (b.window.end ?? t.base + DOMAIN) - t.base, b: b.rateMbps };
        if (result === 'HELD') {
          held.set(key, span);
          hold(span, e.seq);
        } else if (result === 'WAITING') {
          waiting.set(key, span);
        }
      } else if (p.op === 'convert') {
        assert.ok(!convertEntries.has(key), `seed ${seed}: two convert entries for ${key}`);
        convertEntries.add(key);
        held.delete(key);
      } else if (p.op === 'mark_waiting') {
        assert.equal((p.outcome as { result?: string }).result, 'APPLIED', `seed ${seed}: a mark entry is APPLIED`);
        marked.set(key, (p.body as MarkWaitingCmd).waiting);
      } else if (p.op === 'yield') {
        // An accepted yield moves the holder's pulse out of occ_all; it waits again (RFC-001 §4.3).
        if ((p.outcome as { result?: string }).result === 'ACCEPTED') {
          const span = held.get(key);
          assert.ok(span, `seed ${seed}: an accepted yield of ${key}, which holds nothing (seq ${e.seq})`);
          for (let m = span.s; m < span.e; m++) all[m] = (all[m] as number) - span.b;
          held.delete(key);
          waiting.set(key, span);
        }
      } else {
        const span = held.get(key);
        if (span) {
          for (let m = span.s; m < span.e; m++) all[m] = (all[m] as number) - span.b;
          held.delete(key);
        }
        waiting.delete(key);
      }
    }
    // A grant moves a waiter's pulse into occ_all in the entry that frees the capacity.
    for (const n of p.notices ?? []) {
      const key = requestKey(n.request);
      if (n.kind === 'YIELD_REQUEST') {
        // P2-S58: only a holder with the mark is asked, for an older request that waits, with the claim of this entry.
        const older = requestKey(n.olderRequest);
        assert.ok(held.has(key) && marked.get(key) === true, `seed ${seed}: a yield request to ${key}, which does not hold with the mark (seq ${e.seq})`);
        assert.ok(waiting.has(older), `seed ${seed}: a yield request for ${older}, which does not wait (seq ${e.seq})`);
        assert.ok(oraclePriority(holdCmds.get(older) as HoldCmd, holdCmds.get(key) as HoldCmd) < 0, `seed ${seed}: the holder ${key} is not younger (seq ${e.seq})`);
        assert.equal(n.claim, e.seq, `seed ${seed}: the claim is the sequence of its entry`);
        continue;
      }
      const span = waiting.get(key);
      assert.ok(span, `seed ${seed}: a notice ${n.kind} for ${key}, which does not wait (seq ${e.seq})`);
      if (n.kind === 'GRANTED') {
        waiting.delete(key);
        held.set(key, span);
        hold(span, e.seq);
      } else if (n.kind === 'WAITER_REFUSED') {
        waiting.delete(key);
      }
    }
  }
  return { counts, entries: log.length };
}
