/**
 * Counter-offers and the availability query (RFC-001 §4.2; POL-10; C02 "Link availability query").
 *
 * Every function here reads `occ_all` only: every counter-offer is beside committed and held capacity
 * (P1-S73). The results contain only rates and windows, never an account, a reservation or traffic (P1-S17).
 *
 * Cost. A search counts its steps. A step is one jump over an overcommitted run (`earliest`), one
 * `last_above` (an open-ended request) or one fit range (`fitRanges`). The limits are step counts from the
 * policy, never a time, so a replay on another machine gets the same answer (RFC-001 §7.4, R1-12).
 */
import type { CounterOffer, FitRanges, Minute, Window } from './c02.ts';
import type { OccupancyTree } from './occupancy.ts';

/** The earliest-window part of a counter-offer. */
export type Earliest = CounterOffer['earliest'];

/** The result of a bounded search and the steps that it used. */
export interface Counted<T> { value: T; steps: number }

/**
 * The largest rate that fits over `w` beside committed and held capacity: max(0, C_ref − peak(occ_all, w)).
 * A value below `rate_min` is 0, which means none (P1-S38). It can be above the requested rate (P1-S39).
 */
export function largestRate(occAll: OccupancyTree, cRef: number, w: Window, rateMin: number): number {
  const free = cRef - occAll.peak(w.start, w.end);
  return free < rateMin ? 0 : free;
}

/**
 * The earliest window of the requested length that fits `b`, from the requested start `s`, within the
 * horizon `h` (RFC-001 §4.2 `earliest`). `length` null is an open-ended request. The search does at most
 * `limit` steps. When the steps are spent, the answer is "not found before t", where t is where it stopped.
 */
export function earliest(occAll: OccupancyTree, cRef: number, s: Minute, length: number | null, b: number, h: Minute,
  limit: number): Counted<Earliest> {
  const theta = cRef - b;
  if (limit < 1) return { value: { notFoundBefore: s }, steps: 0 };
  if (length === null) {
    // [t, ∞) with t after the last minute above θ. "For ever" above θ: none (P1-S38, R1-25).
    const last = occAll.lastAbove(theta);
    if (last === 'forever') return { value: { none: true }, steps: 1 };
    const t = last === null || last + 1 < s ? s : last + 1;
    return { value: t < h ? { window: { start: t, end: null } } : { none: true }, steps: 1 };
  }
  let t = s;
  let steps = 0;
  let valueAtT: number | undefined;
  while (steps < limit) {
    steps += 1;
    if (t + length > h) return { value: { none: true }, steps };
    const x = occAll.firstAbove(t, theta, valueAtT);
    if (x === null || x >= t + length) return { value: { window: { start: t, end: t + length } }, steps };
    const next = occAll.firstAtOrBelow(x, theta, occAll.foundValue);
    // Overcommitted for ever after x.
    if (next === null) return { value: { none: true }, steps };
    t = next;
    valueAtT = occAll.foundValue;
  }
  return { value: { notFoundBefore: t }, steps };
}

/**
 * Up to `k` maximal ranges in [from, until) where occ_all + b ≤ C_ref, and where to continue
 * (C02 `fit_ranges`). One step for each range found. At most `limit` steps.
 */
export function fitRanges(occAll: OccupancyTree, cRef: number, b: number, from: Minute, until: Minute, k: number,
  limit: number): FitRanges {
  const theta = cRef - b;
  const ranges: Window[] = [];
  let t = from;
  let steps = 0;
  for (;;) {
    if (t >= until) return { ranges, continueFrom: null };
    if (ranges.length >= k || steps >= limit) return { ranges, continueFrom: t };
    steps += 1;
    const x = occAll.firstAtOrBelow(t, theta);
    if (x === null || x >= until) return { ranges, continueFrom: null };
    const y = occAll.firstAbove(x, theta);
    const end = y === null || y >= until ? until : y;
    ranges.push({ start: x, end });
    t = end;
  }
}

/**
 * The selling horizon H of a request received at minute `m0` (RFC-001 §2, POL-09): the same time of day on
 * the same UTC calendar date `months` later, or on the last day of that month if it has no such date.
 * The calculation uses calendar fields only; it reads no clock.
 */
export function horizonMinute(m0: Minute, months: number): Minute {
  const d = new Date(m0 * 60_000);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), lastDay);
  return Date.UTC(y, mo, day, d.getUTCHours(), d.getUTCMinutes()) / 60_000;
}

/**
 * The per-batch budget and cache of counter-offers (RFC-001 §4.2). A batch has `batchSteps` steps for all
 * its refusals; each refusal has at most `perRequest` of them. A result is reused for the same question
 * (start, length, rate, horizon) only while `occ_all` is unchanged, that is, while its change counter is
 * the same. A reused result uses no step.
 */
export class CounterOfferBatch {
  private remaining: number;
  private readonly perRequest: number;
  private readonly cache = new Map<string, { counter: number; value: Earliest }>();

  constructor(perRequest: number, batchSteps: number) {
    this.perRequest = perRequest;
    this.remaining = batchSteps;
  }

  /** The steps that the batch has left. */
  get stepsLeft(): number {
    return this.remaining;
  }

  /** The counter-offer of a refused request for `b` over `w`, received at `m0`. */
  offer(occAll: OccupancyTree, cRef: number, rateMin: number, w: Window, b: number, h: Minute): CounterOffer {
    const largestRateMbps = largestRate(occAll, cRef, w, rateMin);
    const length = w.end === null ? null : w.end - w.start;
    const key = `${w.start}|${length}|${b}|${h}`;
    const hit = this.cache.get(key);
    if (hit && hit.counter === occAll.changeCounter) return { largestRateMbps, earliest: hit.value };
    const limit = Math.min(this.perRequest, this.remaining);
    const r = earliest(occAll, cRef, w.start, length, b, h, limit);
    this.remaining -= r.steps;
    this.cache.set(key, { counter: occAll.changeCounter, value: r.value });
    return { largestRateMbps, earliest: r.value };
  }
}
