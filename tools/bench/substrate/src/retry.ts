import { sqlState } from '../../../../platform/runtime/src/errors.ts';
import type { Flavour } from './config.ts';

/**
 * The class of a failed statement:
 * - `restart`: a retryable 40001 that CockroachDB's client-side protocol retries in the same transaction, keeping
 *   its intents (RFC-006 §4.3 `Retry`).
 * - `abort`: a 40001 that replaced the transaction (CockroachDB `TransactionAbortedError`, every YugabyteDB 40001)
 *   or a deadlock. Its intents are lost. §22.1 counts aborts apart from restarts (R33-17).
 * - `ambiguous`: COMMIT was sent and its answer is unknown (C01 §3.2, M1).
 * - `statementTimeout`: the 2 s statement timeout before COMMIT (C01 §7).
 * - `other`: any other error, by SQLSTATE or `connection`.
 */
export type FailureClass =
  | { kind: 'restart'; reason: string }
  | { kind: 'abort'; reason: string }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'statementTimeout' }
  | { kind: 'other'; code: string };

const CRDB_ABORT = /TransactionAbortedError\((ABORT_REASON_[A-Z_]+)\)/;
const CRDB_RESTART = /(RETRY_[A-Z_]+|ReadWithinUncertaintyIntervalError|WriteTooOldError)/;
const YB_REASONS: Array<[RegExp, string]> = [
  [/Restart read required/i, 'read_restart'],
  [/conflicts with (higher|lower) priority transaction/i, 'conflict'],
  [/could not serialize access/i, 'serialization'],
  [/Transaction aborted|expired or aborted/i, 'aborted'],
];

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Classifies an error of a statement before COMMIT (`statement`) or of RELEASE / COMMIT (`commit`). */
export function classifyFailure(e: unknown, flavour: Flavour, phase: 'statement' | 'commit'): FailureClass {
  const code = sqlState(e);
  const msg = messageOf(e);
  if (code === '40001') {
    if (flavour === 'yugabyte') return { kind: 'abort', reason: YB_REASONS.find(([re]) => re.test(msg))?.[1] ?? 'unknown' };
    const aborted = CRDB_ABORT.exec(msg);
    if (aborted?.[1] !== undefined) return { kind: 'abort', reason: aborted[1] };
    return { kind: 'restart', reason: CRDB_RESTART.exec(msg)?.[1] ?? 'unknown' };
  }
  if (code === '40P01') return { kind: 'abort', reason: 'deadlock' };
  if (phase === 'commit') {
    // As platform/runtime/src/store/pg.ts `ambiguous()`: 40003, the 15 s backstop (57014), a lost connection.
    if (code === undefined) return { kind: 'ambiguous', reason: 'connection' };
    if (code === '40003' || code === '57014' || code.startsWith('08')) return { kind: 'ambiguous', reason: code };
    return { kind: 'other', code };
  }
  if (code === '57014') return { kind: 'statementTimeout' };
  return { kind: 'other', code: code ?? 'connection' };
}
