/**
 * Time helpers of RFC-003 §2. All times are UTC epoch milliseconds.
 * Minute m is the half-open interval [m, m + 60 s).
 */

export const MINUTE_MS = 60_000;

/** The start of the minute that contains t. */
export function floorMin(t: number): number {
  return Math.floor(t / MINUTE_MS) * MINUTE_MS;
}

/** The first minute boundary at or after t. */
export function ceilMin(t: number): number {
  return Math.ceil(t / MINUTE_MS) * MINUTE_MS;
}

/** The end of the last minute in which the record was active (RFC-003 §2). */
export function lastMinuteEnd(startMs: number, endMs: number): number {
  return endMs > startMs ? ceilMin(endMs) : floorMin(startMs) + MINUTE_MS;
}

/** C06 `Minute`: "YYYY-MM-DDTHH:MM:00Z". */
export function minuteIso(minuteMs: number): string {
  if (minuteMs % MINUTE_MS !== 0) throw new Error(`${minuteMs} is not a minute start`);
  return new Date(minuteMs).toISOString().slice(0, 16) + ':00Z';
}

const MINUTE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;

export function isMinute(s: string): boolean {
  return MINUTE_RE.test(s) && !Number.isNaN(Date.parse(s));
}

export function parseMinute(s: string): number {
  if (!isMinute(s)) throw new Error(`not a C06 Minute: ${s}`);
  return Date.parse(s);
}
