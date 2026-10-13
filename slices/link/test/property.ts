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
 * With `legShare` > 0 (S-LINK I6 exit criterion 3), that share of the steps changes the confirmed legs of the client:
 * `end_leg` and `reduce_parts` (with change-id gaps, repeats, stale ids, changed bodies, `applies` errors, unknown
 * parts and reservations, rates that rise), and extensions of kind `change` whose `convert` sometimes comes after a
 * later `end_leg` (the clip). The oracle decides each of them too. The P1-N1 check from the log rows follows the parts,
 * and asserts that no leg change raises a rate. With `state`, the link's `occ_firm` and `occ_all` at the end equal the
 * oracle's at every minute.
 */
import assert from 'node:assert/strict';
import { encodeJson, hex, hlcToWallMs, utf8, type HlcTs } from '@share/owner-runtime';
import type {
  ConvertCmd, DecidedRecord, EndLegCmd, HoldCmd, LinkCommand, LinkPolicy, LinkState, LoggedEntry, LoggedPayload, MarkWaitingCmd, Outcome, Piece,
  ReducePartsCmd, RequestId, WaitingNotice, YieldAnswerCmd,
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
  /** Moves the stepped clock of the run forward: the clock of the runtime double, or the stepped clock of the runtime core. */
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
  /** The share of the steps that change confirmed legs (I6). Default 0: no leg change. */
  legShare?: number;
  /** The link state at the end of the run (I6): its occupancy must equal the oracle's at every minute. */
  state?: () => LinkState | undefined;
}

/** The confirmed reservations of one client, and the leg commands that it sent (I6). */
interface LegClient {
  account: string;
  res: Array<{ reservation: string; leg: string; parts: string[]; start: number; end: number | null }>;
  sent: Array<{ op: 'end_leg'; cmd: EndLegCmd } | { op: 'reduce_parts'; cmd: ReducePartsCmd }>;
  /** The client's change-id counter. It goes up in steps of 1 … 3, so lower ids that were never applied exist. */
  chg: bigint;
}

const END_CAUSES: Array<EndLegCmd['cause']> = ['CANCEL', 'SHORTEN', 'RELEASE', 'TERMINATE', 'MOVE', 'POL07'];

/** One leg-change step of a client (I6). Returns the reply. */
async function legStep(t: PropertyTarget, r: () => number, lc: LegClient): Promise<unknown> {
  const stub = t.stub;
  const next = (gap: number): bigint => { lc.chg += BigInt(gap); return lc.chg; };
  const id = (seq: bigint, account = lc.account) => ({ partition: utf8(account), seq });
  const inDomain = (m: number): number => Math.min(Math.max(m, t.base), t.base + DOMAIN - 1);
  const x = r();
  if (lc.res.length === 0 || x < 0.03) {
    return stub.endLeg({
      link: stub.link, receiverPartition: stub.link, reservation: `none-${lc.account}`, leg: 'leg-1', changeId: id(next(1)),
      fromMinute: t.base + int(r, 0, DOMAIN - 1), cause: 'CANCEL', decisionTime: stub.rt.now().ts,
    });
  }
  const R = lc.res[int(r, 0, lc.res.length - 1)] as LegClient['res'][number];
  const span = (R.end ?? R.start + 300) - R.start;
  const near = (): number => inDomain(R.start + int(r, -20, span + 20));
  const base = { link: stub.link, receiverPartition: stub.link, reservation: R.reservation, leg: R.leg, decisionTime: stub.rt.now().ts };
  if (x < 0.33) {
    const cause = END_CAUSES[int(r, 0, END_CAUSES.length - 1)] as EndLegCmd['cause'];
    const y = r();
    let applies: EndLegCmd['applies'] = cause === 'POL07' ? [{ link: 'L9', reduction: 1n }] : undefined;
    if (y < 0.04) applies = cause === 'POL07' ? undefined : [{ link: 'L9', reduction: 1n }];
    else if (y < 0.06) applies = [{ link: stub.link, reduction: 2n }];
    const account = r() < 0.04 ? `${lc.account}-other` : lc.account;
    const cmd: EndLegCmd = {
      ...base, changeId: id(next(int(r, 1, 3)), account), fromMinute: r() < 0.02 ? near() + 0.5 : near(), cause,
      ...(applies ? { applies } : {}),
    };
    lc.sent.push({ op: 'end_leg', cmd });
    return stub.endLeg(cmd);
  }
  if (x < 0.66) {
    const names = R.parts.filter(() => r() < 0.7);
    if (names.length === 0) names.push(R.parts[int(r, 0, R.parts.length - 1)] as string);
    if (r() < 0.04) names.push(`unknown-${lc.account}`);
    const parts = names.map((part) => {
      const froms = [...new Set(Array.from({ length: int(r, 1, 3) }, near))].sort((a, b) => a - b);
      const pieces: Piece[] = froms.map((from) => ({ from, rateMbps: int(r, 0, 6) }));
      if (r() < 0.02) (pieces[0] as Piece).rateMbps = 1.5;
      return { part, pieces };
    });
    const cause = r() < 0.2 ? 'POL07' as const : 'DECREASE' as const;
    const cmd: ReducePartsCmd = { ...base, changeId: id(next(int(r, 1, 3))), cause, parts, ...(cause === 'POL07' ? { applies: [{ link: 'L9', reduction: 1n }] } : {}) };
    lc.sent.push({ op: 'reduce_parts', cmd });
    return stub.reduceParts(cmd);
  }
  if (x < 0.78 && lc.sent.length > 0) {
    const old = lc.sent[int(r, 0, lc.sent.length - 1)] as LegClient['sent'][number];
    if (old.op === 'end_leg') return stub.endLeg(r() < 0.2 ? { ...old.cmd, fromMinute: old.cmd.fromMinute + 1 } : old.cmd);
    return stub.reduceParts(r() < 0.2 ? { ...old.cmd, cause: old.cmd.cause === 'POL07' ? 'DECREASE' : 'POL07' } : old.cmd);
  }
  if (x < 0.86) {
    const cmd: EndLegCmd = { ...base, changeId: id(lc.chg - BigInt(int(r, 1, 2))), fromMinute: near(), cause: 'SHORTEN' };
    return stub.endLeg(cmd);
  }
  // An extension or an increase of R: a hold of kind change, then its convert as a new part with its own age.
  const start = inDomain(R.start + int(r, 0, span + 60));
  const hold: HoldCmd = {
    ...stub.holdCmd({ rate: int(r, 1, 4), window: { start, end: r() < 0.05 ? null : Math.min(start + int(r, 1, 120), t.base + DOMAIN - 1) }, account: lc.account, leg: R.leg }),
    holdKind: { kind: 'change', reservation: R.reservation },
  };
  if (hold.window.end !== null && hold.window.end <= start) hold.window = { start, end: start + 1 };
  const held = await stub.hold(hold);
  if (!(typeof held === 'object' && held !== null && 'result' in held && held.result === 'HELD')) return held;
  const createdBy = next(1);
  // A defect: the convert comes after a later end_leg of the leg, which clips it (C02 V61-1).
  if (r() < 0.3) {
    const end: EndLegCmd = { ...base, changeId: id(next(1)), fromMinute: inDomain(start + int(r, -10, 60)), cause: 'SHORTEN' };
    lc.sent.push({ op: 'end_leg', cmd: end });
    await stub.endLeg(end);
  }
  const part = `x-${requestKey(hold.request)}`;
  const conv: ConvertCmd = { ...stub.convertCmd(hold, 1, part), reservation: R.reservation, createdBy: id(createdBy) };
  const reply = await stub.convert(conv);
  if (typeof reply === 'object' && reply !== null && 'result' in reply && reply.result === 'CONVERTED') R.parts.push(part);
  return reply;
}

export interface PropertyResult { counts: Record<string, number>; entries: number }

const DOMAIN = 2_880;   // two days of minutes

/** JSON with bigints as decimal strings (a `STALE_CHANGE` names a change id, I6). */
const show = (x: unknown): string => JSON.stringify(x, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

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
    const lc: LegClient = { account, res: [], sent: [], chg: 10_000_000n };
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
      if ((t.legShare ?? 0) > 0 && r() < (t.legShare ?? 0)) {
        const k = `leg:${resultOf(await legStep(t, r, lc))}`;
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
        const conv = t.stub.convertCmd(h, r() < 0.05 ? 2 : 1);
        reply = await t.stub.convert(conv);
        // I6: a confirmed booking is a reservation whose leg the client can change.
        if (resultOf(reply) === 'CONVERTED' && !lc.res.some((x) => x.reservation === conv.reservation)) {
          lc.res.push({ reservation: conv.reservation, leg: conv.leg, parts: [conv.part], start: h.window.start, end: h.window.end });
        }
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
      `seed ${seed}, decision ${i} (${(d.command as LinkCommand).op}): link ${show(d.outcome)} oracle ${show(want)}`);
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
  // I6: the confirmed parts from the log rows: the cells of the window [s, end), and the rate at each cell from s.
  const parts = new Map<string, { s: number; end: number; rate: Int32Array }>();
  const legParts = new Map<string, string[]>();
  const setRate = (p: { s: number; end: number; rate: Int32Array }, i: number, v: number, seq: bigint): void => {
    const old = p.rate[i] as number;
    assert.ok(v <= old, `seed ${seed}: a leg change raises a rate at cell ${p.s + i} (seq ${seq})`);
    all[p.s + i] = (all[p.s + i] as number) + v - old;
    p.rate[i] = v;
  };
  const hold = (span: { s: number; e: number; b: number }, seq: bigint): void => {
    for (let m = span.s; m < span.e; m++) {
      all[m] = (all[m] as number) + span.b;
      assert.ok((all[m] as number) <= t.capacity, `seed ${seed}: occ_all ${all[m]} > C_ref at minute ${m} after seq ${seq}`);
    }
  };
  for (const e of log) {
    const p = e.payload as LoggedPayload;
    if (p.op === 'init' || p.op === 'takeover' || p.op === 'policy') continue;
    if (p.op === 'end_leg' || p.op === 'reduce_parts') {
      const b = p.body as EndLegCmd | ReducePartsCmd;
      const lk = `${b.reservation}|${b.leg}`;
      if (p.op === 'end_leg') {
        const from = (b as EndLegCmd).fromMinute - t.base;
        for (const k of legParts.get(lk) ?? []) {
          const part = parts.get(k) as { s: number; end: number; rate: Int32Array };
          for (let i = Math.max(0, from - part.s); i < part.rate.length; i++) setRate(part, i, 0, e.seq);
          part.end = Math.min(part.end, Math.max(part.s, from));
        }
      } else {
        for (const n of (b as ReducePartsCmd).parts) {
          const part = parts.get(`${lk}|${n.part}`);
          assert.ok(part, `seed ${seed}: reduce_parts applied to an unknown part ${n.part} (seq ${e.seq})`);
          part.rate.forEach((old, i) => {
            const minute = t.base + part.s + i;
            if (part.s + i >= part.end) return;   // the pieces are clipped to the window of the part
            let v = old;
            for (const x of n.pieces) if (x.from <= minute) v = x.rateMbps;
            setRate(part, i, v, e.seq);
          });
        }
      }
    } else if (p.op !== 'tick') {
      const key = requestKey((p.body as Extract<LinkCommand['body'], { request: unknown }>).request);
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
        const span = held.get(key);
        held.delete(key);
        if (span) {
          // I6: a clip ends the part at clippedAt, and frees the rest of the hold's window in occ_all.
          const c = p.body as ConvertCmd;
          const clippedAt = (p.outcome as { clippedAt?: number }).clippedAt;
          const end = clippedAt === undefined ? span.e : Math.max(span.s, Math.min(span.e, clippedAt - t.base));
          for (let m = end; m < span.e; m++) all[m] = (all[m] as number) - span.b;
          const lk = `${c.reservation}|${c.leg}`;
          parts.set(`${lk}|${c.part}`, { s: span.s, end, rate: Int32Array.from({ length: span.e - span.s }, (_, i) => (span.s + i < end ? span.b : 0)) });
          legParts.set(lk, [...(legParts.get(lk) ?? []), `${lk}|${c.part}`]);
        }
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
  // (6) I6: the link's occupancy at the end equals the oracle's at every minute of the domain and after it.
  const st = t.state?.();
  if (st) {
    for (let m = t.base; m < t.base + DOMAIN; m++) {
      const i = m - t.base;
      if (st.occFirm.value(m) !== oracle.firm[i] || st.occAll.value(m) !== oracle.all[i]) {
        assert.fail(`seed ${seed}: minute ${m}: link firm ${st.occFirm.value(m)} all ${st.occAll.value(m)}, oracle firm ${oracle.firm[i]} all ${oracle.all[i]}`);
      }
    }
    assert.equal(st.occAll.value(t.base + DOMAIN + 10_000), oracle.allAt(t.base + DOMAIN + 10_000), `seed ${seed}: occ_all after the domain`);
  }
  return { counts, entries: log.length };
}
