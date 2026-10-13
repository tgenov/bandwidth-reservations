/** Unit conversions between the runtime's HLC strings, C05 timestamps, C10 instants and C04 minutes. */
import type { HlcTs } from '@share/owner-runtime';
import type { HlcTimestamp } from './contracts/c05.ts';

const NS_PER_MS = 1_000_000n;
const NS_PER_MIN = 60_000_000_000n;

/** The `hlcParts` helper of the runtime is not exported from its root, so this file parses the string. */
export function parts(ts: HlcTs): { wallNs: bigint; logical: bigint } {
  const [wall = '0', logical = '0'] = ts.split('.');
  return { wallNs: BigInt(wall), logical: BigInt(logical || '0') };
}

export function toC05(ts: HlcTs): HlcTimestamp {
  const p = parts(ts);
  return { wallNanos: p.wallNs, logical: Number(p.logical) };
}

export function fromC05(t: HlcTimestamp): HlcTs {
  return `${t.wallNanos}.${String(t.logical).padStart(10, '0')}` as HlcTs;
}

/** Wall time of a timestamp in whole ms, rounded down. */
export function wallMs(ts: HlcTs): number {
  return Number(parts(ts).wallNs / NS_PER_MS);
}

/** The HLC value with wall time `ns` and logical 0. */
export function hlcAtNs(ns: bigint): HlcTs {
  return `${ns}.0000000000` as HlcTs;
}

export function hlcAtMs(ms: number): HlcTs {
  return hlcAtNs(BigInt(ms) * NS_PER_MS);
}

/** floor(ts.wallNanos / 60 × 10⁹): the minute of a timestamp (C05 "Converting between ms and HLC"). */
export function minuteOfTs(ts: HlcTs): bigint {
  return parts(ts).wallNs / NS_PER_MIN;
}

/** C10 instant: ISO 8601 UTC with ms precision. */
export function isoMs(ms: number): string {
  return new Date(ms).toISOString();
}

/** C10 minute field: ISO 8601 UTC on a minute boundary, ms precision. */
export function isoMinuteC10(m: bigint): string {
  return new Date(Number(m) * 60_000).toISOString();
}

/** C04 UtcMinute: "2026-10-12T09:31:00Z". */
export function isoMinuteC04(m: bigint): string {
  return `${new Date(Number(m) * 60_000).toISOString().slice(0, 16)}:00Z`;
}

/** A C10 minute string to a minute index, or undefined when it is not on a minute boundary. */
export function minuteOfC10(iso: string): bigint | undefined {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms % 60_000 !== 0) return undefined;
  return BigInt(ms / 60_000);
}

/** The same instant n calendar months later (UTC), for the rolling selling horizon (POL-09). */
export function addUtcMonths(ms: number, n: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(),
    d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** pico-USD per Mbps-minute as C10's exact decimal string of µ per Mbps-minute. */
export function picoToMicroDecimal(pico: bigint): string {
  const whole = pico / 1_000_000n;
  const frac = pico % 1_000_000n;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(6, '0').replace(/0+$/, '')}`;
}
