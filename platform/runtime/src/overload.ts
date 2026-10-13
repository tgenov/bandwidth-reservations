/**
 * Overload control for a slow database (RFC-006 §4.7 rule 5, erratum 7.1, AI6-12): admission control on the
 * standing queue (5a, per slot) and the batch cap on the per-entry part (5b, per lane). The runtime applies them in
 * `append`, at each take and at each batch end; rule 5c (after an abandon) is in the runtime's batch step.
 * `tools/overload_model.py` is the executable form of the same rules.
 */
import { OVERLOAD, PARAMS } from './params.ts';

/** A uniform random value in [0, 1). The runtime takes it as an option, so a test gives a seeded generator. */
export type Random = () => number;

/** The parameters of rule 5 (RFC-006 §12.10). */
export type OverloadParams = { -readonly [K in keyof typeof OVERLOAD]: number };

interface Sample { n: number; d: number; at: number }

/**
 * Rule 5b: the per-lane model of a batch's duration, `d` ≈ `F̂` + `ĉ` · `n`, fitted from the lane's recent batches,
 * and the per-entry cap `n_cap` = min(hard cap, max(1, ⌊budget / `ĉ`⌋)). The fixed cost is never capped.
 */
export class LaneCostModel {
  private samples: Sample[] = [];
  private f: number | undefined;
  private c: number | undefined;
  /** The time of the latest sample or censored sample: the estimate ends 60 s after it (R77-17). */
  private lastAt: number | undefined;
  /** Takes in a row that the cap bound (the probe's counter). */
  private boundRun = 0;
  /** Regime resets of this lane (RFC-006 §4.7 rule 5b; monitoring). */
  regimeResets = 0;
  /** Probe takes of this lane (monitoring). */
  probeTakes = 0;
  private readonly p: OverloadParams;
  private readonly hardCap: number;

  constructor(p: OverloadParams = OVERLOAD, hardCap: number = PARAMS.slotBatchMaxEntries) {
    this.p = p;
    this.hardCap = hardCap;
  }

  /** `F̂` in ms, or undefined with no estimate. */
  fHatMs(nowMs: number): number | undefined {
    this.age(nowMs);
    return this.f;
  }

  /** `ĉ` in ms per entry, or undefined with no estimate. */
  cHatMs(nowMs: number): number | undefined {
    this.age(nowMs);
    return this.c;
  }

  /** The samples in the fit window. */
  sampleCount(nowMs: number): number {
    this.age(nowMs);
    return this.samples.length;
  }

  /**
   * A completed batch of `n` entries that took `dMs` from BEGIN to the COMMIT answer. A sample of at least 16
   * entries above 2 times the prediction is a regime reset: the older samples go, and the window restarts from it.
   */
  observe(n: number, dMs: number, nowMs: number): void {
    this.age(nowMs);
    const p = this.p;
    if (n >= p.bigSampleEntries && this.c !== undefined && this.f !== undefined
      && dMs > p.regimeResetFactor * (this.f + this.c * n)) {
      this.samples = [];
      this.regimeResets += 1;
    }
    this.samples.push({ n, d: dMs, at: nowMs });
    if (this.samples.length > p.fitWindowSamples) this.samples.shift();
    this.lastAt = nowMs;
    this.fit();
  }

  /**
   * An abandon at the default budget `abandonMs` with no per-tier timeout: a censored sample and a regime reset.
   * The per-entry part took at least `abandonMs` − `F̂`, so `ĉ` = max(`ĉ`, (`abandonMs` − `F̂`) / `n`); with no
   * `F̂` (no batch of the lane completed), `F̂` = 0 and `ĉ` = `abandonMs` / `n`.
   */
  censored(n: number, abandonMs: number, nowMs: number): void {
    this.age(nowMs);
    this.samples = [];
    this.regimeResets += 1;
    if (this.f !== undefined) {
      this.c = Math.max(this.c ?? 0, (abandonMs - this.f) / n);
    } else {
      this.f = 0;
      this.c = abandonMs / n;
    }
    this.lastAt = nowMs;
  }

  /** `n_cap` for a batch whose per-entry part may take `budgetMs`; the hard cap with no estimate. */
  nCap(nowMs: number, budgetMs: number = this.p.batchTimeBudgetMs): number {
    this.age(nowMs);
    if (this.c === undefined) return this.hardCap;
    return Math.min(this.hardCap, Math.max(1, Math.floor(budgetMs / this.c)));
  }

  /**
   * The cap of the next take: `n_cap`, or the probe after 8 capped takes in a row: max(`n_cap` + 16, 1.5 · `n_cap`),
   * at most the hard cap, so that the fit sees two sizes.
   */
  takeCap(nowMs: number): number {
    const n = this.nCap(nowMs);
    if (n < this.hardCap && this.boundRun >= this.p.probeAfterTakes) {
      this.boundRun = 0;
      this.probeTakes += 1;
      return Math.min(this.hardCap, Math.max(n + this.p.probeExtraEntries, Math.floor(n * this.p.probeFactor)));
    }
    return n;
  }

  /** After each take: `capBound` when the cap left calls in the queue. */
  noteTake(capBound: boolean): void {
    this.boundRun = capBound ? this.boundRun + 1 : 0;
  }

  /** The time to drain `q` queued entries (5a): `q` · `ĉ` + ⌈`q` / `n_cap`⌉ · `F̂`; undefined with no estimate. */
  expectedDrainMs(q: number, nowMs: number): number | undefined {
    const c = this.cHatMs(nowMs);
    if (c === undefined) return undefined;
    const cap = this.nCap(nowMs);
    return q * c + Math.ceil(q / cap) * (this.f ?? 0);
  }

  /** The window keeps no sample older than 60 s; with none left by age, there is no estimate (R77-17). */
  private age(nowMs: number): void {
    if (this.lastAt !== undefined && nowMs - this.lastAt > this.p.fitWindowMaxAgeMs) {
      this.samples = []; this.f = undefined; this.c = undefined; this.lastAt = undefined; this.boundRun = 0;
      return;
    }
    const from = nowMs - this.p.fitWindowMaxAgeMs;
    while (this.samples.length > 0 && (this.samples[0] as Sample).at < from) this.samples.shift();
  }

  /** RFC-006 §4.7 rule 5b "Fit" and "Latest-batch bound". */
  private fit(): void {
    const p = this.p;
    const s = this.samples;
    const latest = s[s.length - 1];
    if (!latest) return;
    const ns = s.map((x) => x.n);
    const ds = s.map((x) => x.d);
    let fh: number;
    let raw: number;
    if (s.length >= p.fitMinSamples && Math.max(...ns) >= p.fitSpreadFactor * Math.min(...ns)) {
      const mn = mean(ns);
      const md = mean(ds);
      let v = 0;
      let cov = 0;
      for (const x of s) { v += (x.n - mn) ** 2; cov += (x.n - mn) * (x.d - md); }
      raw = cov / v;
      const ch = Math.max(raw, p.cHatFloorMs);
      fh = Math.min(Math.max(md - ch * mn, 0), Math.min(...ds));
    } else {
      // No spread: F̂ stays as last fitted (the smallest d if never fitted); ĉ from the samples of at least 16 entries.
      fh = this.f ?? Math.min(...ds);
      const big = s.filter((x) => x.n >= p.bigSampleEntries);
      if (big.length === 0) return;
      raw = (mean(big.map((x) => x.d)) - fh) / mean(big.map((x) => x.n));
    }
    let ch = Math.max(raw, p.cHatFloorMs);
    const bound = (latest.d - fh) / latest.n;
    if (raw <= p.cHatFloorMs || (latest.n >= p.bigSampleEntries && bound > p.regimeResetFactor * ch)) ch = Math.max(ch, bound);
    this.f = fh;
    this.c = ch;
  }
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Rule 5a "Expected sojourn": the drain time of the queued entries from the lane's estimate; with no estimate, the
 * age of the oldest queued call, 0 when the queue is empty (review 78 D-78-4).
 */
export function expectedSojournMs(drainMs: number | undefined, oldestEnqueuedAtMs: number | undefined, nowMs: number): number {
  if (drainMs !== undefined) return drainMs;
  return oldestEnqueuedAtMs === undefined ? 0 : nowMs - oldestEnqueuedAtMs;
}

/** The two states of rule 5a. */
export type AdmissionState = 'admitting' | 'overloaded';

/**
 * Rule 5a, per slot: entry on the minimum queue sojourn above `overload_target` for `overload_interval`; release on
 * the expected sojourn at or below the target; `retryAfterMs` with full jitter; at most `shed_answer_burst`
 * answers at once per tick.
 */
export class SlotAdmission {
  state: AdmissionState = 'admitting';
  /** The monotonic time of the last entry, while overloaded (the §16 "slot overloaded" alarm). */
  overloadedSinceMs: number | undefined;
  /** Entries plus releases (the §16 alarm, §22.1 criterion (3), DT-50). */
  stateChanges = 0;
  /** The monotonic time of the latest entry or release (§22.1 criterion (3): none after the drain). */
  lastChangeMs: number | undefined;
  /** `Overloaded` answers delivered at once, and deferred to the next tick (the "owner ignores retryAfterMs" alarm). */
  shedAtOnce = 0;
  shedDeferred = 0;
  /** Calls queued (admitted): the base of the owner-defect alarm. */
  admitted = 0;
  /** The latest sojourn sample (monitoring). */
  lastSojournMs = 0;
  private runStart: number | undefined;
  /** Calls shed in this episode (`k`). */
  private shedInEpisode = 0;
  private tick: number | undefined;
  private answersInTick = 0;
  private readonly p: OverloadParams;
  private readonly random: Random;

  constructor(random: Random, p: OverloadParams = OVERLOAD) {
    this.random = random;
    this.p = p;
  }

  get overloaded(): boolean {
    return this.state === 'overloaded';
  }

  /**
   * A sojourn sample at a take: the take time minus the enqueue time of the youngest call taken, 0 when the take
   * empties the queue. Returns true when the slot enters the overloaded state at this sample. While overloaded a
   * sample changes nothing (R77-16).
   */
  sample(nowMs: number, sojournMs: number): boolean {
    this.lastSojournMs = sojournMs;
    if (this.state === 'overloaded') return false;
    if (sojournMs <= this.p.overloadTargetMs) { this.runStart = undefined; return false; }
    this.runStart ??= nowMs;
    if (nowMs - this.runStart < this.p.overloadIntervalMs) return false;
    this.state = 'overloaded';
    this.overloadedSinceMs = nowMs;
    this.stateChanges += 1;
    this.lastChangeMs = nowMs;
    this.shedInEpisode = 0;
    return true;
  }

  /** At a take (not the one that entered) and at a batch end: release when the expected sojourn is at or below the target. */
  release(expectedSojournMs: number, nowMs: number): boolean {
    if (this.state !== 'overloaded' || expectedSojournMs > this.p.overloadTargetMs) return false;
    this.state = 'admitting';
    this.lastChangeMs = nowMs;
    this.overloadedSinceMs = undefined;
    this.stateChanges += 1;
    this.runStart = undefined;
    return true;
  }

  /**
   * The `retryAfterMs` of one shed call: min(5,000, 250 + uniform [0, `D`]), `D` the expected drain of the `q`
   * queued entries and the `k` calls shed so far in this episode (this one included), at most 5,000 ms; `D` = 500 ms
   * before the lane has an estimate (review 78 D-78-5).
   */
  retryAfterMs(queuedEntries: number, drainMs: (q: number) => number | undefined): number {
    this.shedInEpisode += 1;
    const p = this.p;
    const d = Math.min(p.retryAfterMaxMs, drainMs(queuedEntries + this.shedInEpisode) ?? p.retryDrainNoEstimateMs);
    return Math.min(p.retryAfterMaxMs, Math.round(p.retryFloorMs + this.random() * d));
  }

  /** True when a shed answer goes at once: at most `shed_answer_burst` in each 100 ms tick; the others wait for the next tick. */
  answerNow(nowMs: number): boolean {
    const t = Math.floor(nowMs / this.p.shedTickMs);
    if (t !== this.tick) { this.tick = t; this.answersInTick = 0; }
    if (this.answersInTick >= this.p.shedAnswerBurst) { this.shedDeferred += 1; return false; }
    this.answersInTick += 1;
    this.shedAtOnce += 1;
    return true;
  }
}
