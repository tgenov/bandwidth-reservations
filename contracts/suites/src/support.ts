/**
 * Common parts of the contract suites: subject life cycle, the pending entry of a provider that does not
 * exist yet, and small helpers that need no runtime code.
 */
import { test } from 'node:test';

/** A subject is the real provider or a double. The suite closes it after each test. */
export interface Closable {
  close(): Promise<void>;
}

/** A part of a contract that a real provider does not provide yet. `pending` names the plan increment that provides it. */
export interface Pending {
  pending: string;
}

/** True if the value is a pending marker. */
export function isPending(x: unknown): x is Pending {
  return typeof x === 'object' && x !== null && 'pending' in x && typeof (x as { pending: unknown }).pending === 'string';
}

/** A factory of a fresh subject for each test. */
export type SubjectFactory<S> = () => Promise<S>;

/**
 * Register one test against a fresh subject. The subject is always closed, also when the test fails.
 * The title is `<contract> <test id> [<name>] <behaviour>`.
 */
export function subjectTest<S extends Closable>(
  contract: string, id: string, name: string, behaviour: string, make: SubjectFactory<S>, body: (s: S) => Promise<void>,
): void {
  test(`${contract} ${id} [${name}] ${behaviour}`, { timeout: 30_000 }, async () => {
    const s = await make();
    try {
      await body(s);
    } finally {
      await s.close();
    }
  });
}

/**
 * Register the explicit entry for a provider (or a part of it) that does not exist yet. It is a `todo`
 * test, so it shows in every run and is never a silent skip.
 */
export function pendingProvider(contract: string, name: string, increment: string, what: string): void {
  test(`${contract} [${name}] PENDING real provider (${increment}): ${what}`, { todo: `the real provider comes in ${increment}` }, () => {});
}

/** UTF-8 bytes of a string. */
export function bytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf8'));
}

/** Compare two HLC timestamps `"<wall ns>.<logical>"` as decimals (C01 §2.1). */
export function compareTs(a: string, b: string): -1 | 0 | 1 {
  const [aw = '0', al = ''] = a.split('.');
  const [bw = '0', bl = ''] = b.split('.');
  const x = BigInt(aw) * 10n ** 10n + BigInt(al.padEnd(10, '0').slice(0, 10) || '0');
  const y = BigInt(bw) * 10n ** 10n + BigInt(bl.padEnd(10, '0').slice(0, 10) || '0');
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The wall-clock milliseconds of an HLC timestamp. */
export function wallMs(ts: string): number {
  return Number(BigInt(ts.split('.')[0] ?? '0') / 1_000_000n);
}

/** An HLC timestamp at a wall-clock millisecond, logical 0. */
export function tsAtMs(ms: number): string {
  return `${BigInt(Math.floor(ms)) * 1_000_000n}.0000000000`;
}
