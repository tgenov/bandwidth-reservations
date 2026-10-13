/**
 * The rate of a confirmed leg part as a step function (RFC-001 §3.3 "Leg parts", §4.5), S-LINK I6.
 *
 * A part has a window [s, e) and a rate. A `reduce_parts` sets the rate as absolute minute pieces from the first
 * `from`, clipped to the part's current window (C02 "reduce_parts"). An `end_leg` ends the part from its minute.
 * These functions are pure. `LinkState` applies their result to the occupancy trees.
 */
import type { Piece, Window } from './c02.ts';

/** The pieces of a part's rate, from its window start. A part that no `reduce_parts` changed has one piece. */
export function piecesOf(p: { rateMbps: number; window: Window; pieces?: Piece[] }): Piece[] {
  return p.pieces ?? [{ from: p.window.start, rateMbps: p.rateMbps }];
}

/** A run of constant rate inside a window: [s, e) at rate b (b > 0 only). */
export interface Segment { s: number; e: number | null; b: number }

/** The runs of positive rate of `pieces` inside window `w`. */
export function segments(pieces: Piece[], w: Window): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i] as Piece;
    const next = pieces[i + 1]?.from ?? null;
    const s = Math.max(p.from, w.start);
    const e = minEnd(next, w.end);
    if (p.rateMbps > 0 && (e === null || s < e)) out.push({ s, e, b: p.rateMbps });
  }
  return out;
}

/** The rate at minute t (0 outside the window). */
export function rateAt(pieces: Piece[], w: Window, t: number): number {
  if (t < w.start || (w.end !== null && t >= w.end)) return 0;
  let r = 0;
  for (const p of pieces) {
    if (p.from > t) break;
    r = p.rateMbps;
  }
  return r;
}

/**
 * True if every piece has a whole minute and a whole rate ≥ 0, and the minutes strictly increase. An empty list
 * is not well formed (C02 `Piece`; S-LINK I6 design issue DI-32).
 */
export function wellFormedPieces(pieces: Piece[]): boolean {
  if (!Array.isArray(pieces) || pieces.length === 0) return false;
  let last = -Infinity;
  for (const p of pieces) {
    if (!Number.isSafeInteger(p.from) || !Number.isSafeInteger(p.rateMbps) || p.rateMbps < 0 || p.from <= last) return false;
    last = p.from;
  }
  return true;
}

/**
 * The rate after `reduce_parts` sets `next` (C02: "sets the rate of each named part to the pieces from the first
 * `from`, clipped to the current window of the part"). Before the first `from` the rate does not change. The
 * result starts at the window start and has no two adjacent pieces with the same rate.
 */
export function setPieces(old: Piece[], w: Window, next: Piece[]): Piece[] {
  const first = (next[0] as Piece).from;
  const out: Piece[] = old.filter((p) => p.from < first && p.from < (w.end ?? Infinity));
  for (const p of next) {
    if (w.end !== null && p.from >= w.end) break;
    const from = Math.max(p.from, w.start);
    if (out.length > 0 && (out[out.length - 1] as Piece).from >= from) out.pop();
    out.push({ from, rateMbps: p.rateMbps });
  }
  if (out.length === 0) return old;
  const merged: Piece[] = [];
  for (const p of out) {
    const last = merged[merged.length - 1];
    if (last && last.rateMbps === p.rateMbps) continue;
    merged.push(p);
  }
  return merged;
}

/** True if `next` is above `old` at one or more minutes of the window (S-LINK I6 design issue DI-33). */
export function raises(old: Piece[], next: Piece[], w: Window): boolean {
  const points = new Set<number>([w.start]);
  for (const p of [...old, ...next]) if (p.from >= w.start && (w.end === null || p.from < w.end)) points.add(p.from);
  for (const t of points) if (rateAt(next, w, t) > rateAt(old, w, t)) return true;
  return false;
}

/** The window after an `end_leg` from minute `t`: every minute from `max(s, t)` ends. */
export function endFrom(w: Window, t: number): Window {
  const end = Math.max(w.start, t);
  return w.end !== null && end >= w.end ? w : { start: w.start, end };
}

function minEnd(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}
