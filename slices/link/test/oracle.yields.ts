/**
 * The per-minute oracle with yields (S-LINK I5, RFC-001 §4.3, POL-02), written apart from the link's code. It
 * extends `MinuteOracle` (one cell per minute) with:
 * - the waiting mark of each request, applied only above the last applied position (`mark_waiting`);
 * - `request_yields(w)`: the younger holders with the mark that cover a conflict minute of w are asked only if their
 *   capacity and the free capacity let w fit at every minute; one claim for each raising entry, numbered by the
 *   entry's sequence; one request on a holder attempt for each entry (S-LINK I5 DI-21);
 * - the claim check of the scan: a waiter younger than an older waiter with a live claim on one of its minutes is
 *   not granted;
 * - `yield_accept` (the holder waits at attempt + 1 with the same command, every other claim on the old attempt ends,
 *   then the scan) and `yield_refuse` (its claim ends; a new claim at once if the mark is set);
 * - the end of claims when the waiter ends and when the holder attempt ends.
 *
 * The scan has no step budget. A property run that uses this oracle has no `Tick` entry, so the claims that the
 * scan raises have the sequence of the command's entry.
 */
import type { HlcTs } from '@share/owner-runtime';
import type { HoldCmd, LinkCommand, Outcome } from '../src/index.ts';
import { requestKey, wallNs } from '../src/index.ts';
import { MinuteOracle, oraclePriority, type OracleRequest, type OracleWaiter } from './support.ts';

interface OracleClaim { seq: bigint; waiter: string; minutes: Set<number> }
interface OracleYield { holder: string; attempt: number; claim: bigint; waiter: string }

export class YieldOracle extends MinuteOracle {
  private readonly marks = new Map<string, { waiting: boolean; position: bigint }>();
  private readonly answers = new Map<string, Outcome>();
  private claims: OracleClaim[] = [];
  private yields: OracleYield[] = [];

  /** The open yield requests (holder key, attempt, claim, waiter key), for the checks of a run. */
  openYields(): OracleYield[] {
    return [...this.yields];
  }

  protected override other(cmd: LinkCommand, ts: HlcTs): Outcome {
    const key = requestKey(cmd.body.request);
    const rec = this.req.get(key);
    if (cmd.op === 'mark_waiting') {
      const b = cmd.body;
      if (!rec || (rec.state !== 'HELD' && rec.state !== 'WAITING')) return { result: 'IGNORED_OLDER' };
      const m = this.marks.get(key);
      if (m && b.position <= m.position) return { result: 'IGNORED_OLDER' };
      this.marks.set(key, { waiting: b.waiting, position: b.position });
      if (b.waiting && rec.state === 'HELD') {
        const holder = rec.cmd as HoldCmd;
        for (const x of [...this.waiters]) {
          if (oraclePriority(x.b, holder) >= 0) continue;
          if (this.yields.some((y) => y.holder === key && y.attempt === attemptOf(rec) && y.waiter === x.key)) continue;
          this.requestYields(x, ts, key);
        }
      }
      return { result: 'APPLIED' };
    }
    if (cmd.op !== 'yield') throw new Error(`YieldOracle: unexpected ${cmd.op}`);
    const b = cmd.body;
    const answerKey = `${key}|${b.attempt}|${b.claim}|${b.answer}`;
    const done = this.answers.get(answerKey);
    if (done) return done;
    const y = this.yields.find((v) => v.holder === key && v.attempt === b.attempt && v.claim === b.claim);
    if (!rec || rec.state !== 'HELD' || attemptOf(rec) !== b.attempt || !y) return { result: 'STALE_ATTEMPT' };
    if (b.answer === 'yield_refuse') {
      this.endClaim(y.claim, y.waiter);
      const o: Outcome = { result: 'REFUSED_RECORDED' };
      this.answers.set(answerKey, o);
      const x = this.waiters.find((w) => w.key === y.waiter);
      if (this.marks.get(key)?.waiting === true && x) this.requestYields(x, ts, key);
      return o;
    }
    const hold = rec.cmd as HoldCmd;
    this.addTo(this.all, hold.window, -hold.rateMbps);
    for (const v of this.yields.filter((v) => v.holder === key && v.attempt === b.attempt)) {
      if (v.claim !== y.claim || v.waiter !== y.waiter) this.endClaim(v.claim, v.waiter);
    }
    this.yields = this.yields.filter((v) => v !== y);
    const attempt = b.attempt + 1;
    rec.state = 'WAITING';
    rec.attempt = attempt;
    const ahead = Math.max(this.latestBlocker(hold.window, hold.rateMbps), 0);
    rec.holdOutcome = { result: 'WAITING', attempt, aheadDeadline: ahead };
    this.waiters.push({ key, b: hold, ahead, attempt });
    this.waiters.sort((p, q) => oraclePriority(p.b, q.b));
    const o: Outcome = { result: 'ACCEPTED', newWaiterAttempt: attempt };
    this.answers.set(answerKey, o);
    this.scan(hold.window, ts);
    return o;
  }

  protected override registered(x: OracleWaiter, ts: HlcTs): void {
    this.requestYields(x, ts);
  }

  protected override blocked(x: OracleWaiter, ts: HlcTs): void {
    this.requestYields(x, ts);
  }

  protected override claimBlocks(x: OracleWaiter): boolean {
    const [s, e] = this.span(x.b.window);
    return this.claims.some((c) => {
      if (c.waiter === x.key) return false;
      const o = this.waiters.find((w) => w.key === c.waiter);
      if (!o || oraclePriority(o.b, x.b) >= 0) return false;
      for (let t = s; t < e; t++) if (c.minutes.has(t)) return true;
      return false;
    });
  }

  protected override waiterEnded(key: string): void {
    for (const c of this.claims.filter((v) => v.waiter === key)) this.endClaim(c.seq, c.waiter);
  }

  protected override holderEnded(key: string, attempt: number): void {
    for (const v of this.yields.filter((y) => y.holder === key && y.attempt === attempt)) this.endClaim(v.claim, v.waiter);
  }

  private endClaim(seq: bigint, waiter: string): void {
    this.claims = this.claims.filter((c) => !(c.seq === seq && c.waiter === waiter));
    this.yields = this.yields.filter((y) => !(y.claim === seq && y.waiter === waiter));
  }

  /** `request_yields(x)`, minute by minute. With `must`, nothing is raised unless that holder is asked. */
  private requestYields(x: OracleWaiter, ts: HlcTs, must?: string): void {
    if (wallNs(ts) >= BigInt(x.b.commitFence) * 1_000_000n) return;
    const seq = this.seq;
    if (seq === undefined) throw new Error('YieldOracle: a claim needs the sequence of the entry');
    const [s, e] = this.span(x.b.window);
    const rate = x.b.rateMbps;
    const conflict = new Set<number>();
    for (let t = s; t < e; t++) if ((this.all[t] as number) + rate > this.capacity) conflict.add(t);
    const holders: Array<[string, OracleRequest]> = [...this.req.entries()].filter(([k, r]) => {
      if (k === x.key || r.state !== 'HELD' || this.marks.get(k)?.waiting !== true) return false;
      if (oraclePriority(r.cmd as HoldCmd, x.b) <= 0) return false;
      const [hs, he] = this.span(r.window as HoldCmd['window']);
      for (let t = hs; t < he; t++) if (conflict.has(t)) return true;
      return false;
    });
    holders.sort(([, p], [, q]) => oraclePriority(p.cmd as HoldCmd, q.cmd as HoldCmd));
    if (holders.length === 0 || (must !== undefined && !holders.some(([k]) => k === must))) return;
    for (let t = s; t < e; t++) {
      let freed = 0;
      for (const [, r] of holders) {
        const [hs, he] = this.span(r.window as HoldCmd['window']);
        if (t >= hs && t < he) freed += r.rate as number;
      }
      if ((this.all[t] as number) - freed + rate > this.capacity) return;
    }
    let raised = false;
    for (const [k, r] of holders) {
      const attempt = attemptOf(r);
      if (this.yields.some((y) => y.holder === k && y.attempt === attempt && (y.waiter === x.key || y.claim === seq))) continue;
      this.yields.push({ holder: k, attempt, claim: seq, waiter: x.key });
      this.notices.push({ request: k, kind: 'YIELD_REQUEST', attempt, claim: seq, olderRequest: x.key });
      raised = true;
    }
    if (raised) this.claims.push({ seq, waiter: x.key, minutes: conflict });
  }
}

function attemptOf(r: OracleRequest): number {
  return r.attempt ?? 1;
}
