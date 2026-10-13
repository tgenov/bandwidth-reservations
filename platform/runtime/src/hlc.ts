import type { HlcTs } from './api.ts';

const LOGICAL_DIGITS = 10;

/** Normalise a CockroachDB DECIMAL HLC ("<wall ns>.<logical>") to the 10-digit logical form (C01 §2.1). */
export function hlc(value: string | bigint): HlcTs {
  const s = typeof value === 'bigint' ? value.toString() : value.trim();
  const [wall = '0', logical = ''] = s.split('.');
  if (!/^\d+$/.test(wall) || !/^\d*$/.test(logical)) throw new Error(`not an HLC timestamp: ${s}`);
  return `${BigInt(wall).toString()}.${logical.padEnd(LOGICAL_DIGITS, '0').slice(0, LOGICAL_DIGITS)}` as HlcTs;
}

export function hlcParts(t: HlcTs): { wallNs: bigint; logical: bigint } {
  const [wall = '0', logical = '0'] = t.split('.');
  return { wallNs: BigInt(wall), logical: BigInt(logical || '0') };
}

export function compareHlc(a: HlcTs, b: HlcTs): -1 | 0 | 1 {
  const x = hlcParts(a); const y = hlcParts(b);
  if (x.wallNs !== y.wallNs) return x.wallNs < y.wallNs ? -1 : 1;
  if (x.logical !== y.logical) return x.logical < y.logical ? -1 : 1;
  return 0;
}

export function hlcFromWallMs(ms: number): HlcTs {
  return hlc(BigInt(Math.floor(ms)) * 1_000_000n);
}

export function hlcToWallMs(t: HlcTs): number {
  return Number(hlcParts(t).wallNs / 1_000_000n);
}

export function hlcAddMs(t: HlcTs, ms: number): HlcTs {
  return hlc(hlcParts(t).wallNs + BigInt(Math.round(ms * 1_000_000)));
}

/** The HLC timestamp just below `t` (one logical tick, or the wall time below). */
export function hlcBefore(t: HlcTs): HlcTs {
  const [wall = '0', logical = '0'] = t.split('.');
  const l = BigInt(logical);
  return l > 0n ? hlc(`${wall}.${(l - 1n).toString().padStart(10, '0')}`) : hlc(`${BigInt(wall) - 1n}.9999999999`);
}

/** ceil to a microsecond, as a TIMESTAMPTZ literal (with_min_timestamp takes a TIMESTAMPTZ). */
export function ceilMicrosLiteral(t: HlcTs): string {
  const { wallNs, logical } = hlcParts(t);
  let us = wallNs / 1000n;
  if (wallNs % 1000n !== 0n || logical > 0n) us += 1n;
  const ms = Number(us / 1000n);
  const frac = (us % 1_000_000n).toString().padStart(6, '0');
  const iso = new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  return `${iso}.${frac}+00:00`;
}

