/** SQLSTATE 40001: a retryable serialisation failure (client-side retry protocol, RFC-006 §4.3). */
export function isRetryable(e: unknown): boolean {
  return sqlState(e) === '40001';
}

/** SQLSTATE 55P03: lock_timeout hit (the displacement read, C01 §3.2). */
export function isLockTimeout(e: unknown): boolean {
  return sqlState(e) === '55P03';
}

export function sqlState(e: unknown): string | undefined {
  if (e !== null && typeof e === 'object' && 'code' in e) {
    const c = (e as { code: unknown }).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

/** COMMIT was sent and its answer is unknown: 40003, a lost connection, or the 15 s backstop (C01 §3.2, M1). */
export class AmbiguousCommitError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AmbiguousCommitError';
    this.cause = cause;
  }
}

/** The fence read found another epoch or session: the slot is lost (C01 §3.2 StaleEpoch). */
export class StaleEpochSignal extends Error {
  readonly slot: number;
  constructor(slot: number) {
    super(`slot ${slot}: epoch fence failed`);
    this.slot = slot;
    this.name = 'StaleEpochSignal';
  }
}

/** The batch was not at COMMIT within abandonBeforeCommitMs of BEGIN (C01 §7): ROLLBACK, re-propose. */
export class AbandonSignal extends Error {
  constructor() {
    super('abandoned before COMMIT');
    this.name = 'AbandonSignal';
  }
}

/** A retryable error built by tests and the memory store. */
export function retryableError(message = 'restart transaction'): Error & { code: string } {
  return Object.assign(new Error(message), { code: '40001' });
}
