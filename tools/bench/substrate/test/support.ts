import type { Clock } from '../src/clock.ts';

/** Lets every pending promise callback run. */
export const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

/** A clock that moves only when the test moves it. */
export class ManualClock implements Clock {
  private t: number;
  private waiters: Array<{ at: number; resolve: () => void }> = [];

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  sleepUntil(at: number): Promise<void> {
    if (at <= this.t) return Promise.resolve();
    return new Promise((resolve) => { this.waiters.push({ at, resolve }); });
  }

  /** Sets the time without waking a sleeper (time passes inside an awaited call). */
  set(t: number): void {
    this.t = t;
  }

  /** Sets the time, wakes every sleeper that is due and lets the woken code run. */
  async advanceTo(t: number): Promise<void> {
    this.t = t;
    const due = this.waiters.filter((w) => w.at <= t);
    this.waiters = this.waiters.filter((w) => w.at > t);
    for (const w of due) w.resolve();
    await flush();
    await flush();
  }
}

/** A promise that the test resolves or rejects by hand. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A database error with a SQLSTATE, as `pg` gives it. */
export function dbError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export const CRDB_RESTART = 'restart transaction: TransactionRetryWithProtoRefreshError: TransactionRetryError: retry txn (RETRY_SERIALIZABLE - failed preemptive refresh): "sql txn"';
export const CRDB_ABORT = 'restart transaction: TransactionRetryWithProtoRefreshError: TransactionAbortedError(ABORT_REASON_PUSHER_ABORTED): "sql txn"';
