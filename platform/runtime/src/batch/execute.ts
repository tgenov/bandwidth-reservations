import { AbandonSignal, AmbiguousCommitError, StaleEpochSignal, isRetryable } from '../errors.ts';
import type { BatchTxn, OwnerStore } from '../store/types.ts';
import { TierTimeout } from '../store/tiers.ts';
import { runAttempt, type AttemptEnv, type AttemptPlan, type PendingCall } from './attempt.ts';

export type BatchOutcome =
  | { kind: 'answered'; plan: AttemptPlan }
  | { kind: 'retry'; restarts: number; freshAttempts: number }
  | { kind: 'staleEpoch' }
  | { kind: 'ambiguous'; plan: AttemptPlan; reason: string }
  | { kind: 'failed'; error: Error };

export interface ExecuteOptions {
  batchRetries: number;
  abandonBeforeCommitMs: number;
  commitBackstopMs: number;
  /** The monotonic clock of the abandon budget, in ms (default `performance.now`; engineering.md §5: a test steps it). */
  nowMs?: () => number;
}

async function quietly(p: Promise<void>): Promise<void> {
  try { await p; } catch { /* the connection is discarded */ }
}

/** Race COMMIT against the backstop: an expired backstop is Ambiguous, never an abort (C01 §3.2, M1). */
async function commitWithBackstop(tx: BatchTxn, backstopMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const backstop = new Promise<never>((_, reject) => {
    // The server-side SET LOCAL statement_timeout normally answers first; this guards a silent connection.
    timer = setTimeout(() => reject(new AmbiguousCommitError(`COMMIT backstop ${backstopMs} ms expired`)), backstopMs + 250);
  });
  try {
    await Promise.race([tx.commit(backstopMs), backstop]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The client-side retry protocol of RFC-006 §4.3 (C01 §3.2, R47-12): restarts by ROLLBACK TO SAVEPOINT
 * cockroach_restart (keeping intents) up to batchRetries, then one fresh transaction; then Retry.
 * Every attempt re-reads everything and re-runs every decide.
 */
export async function executeBatch(store: OwnerStore, env: AttemptEnv, calls: PendingCall[], o: ExecuteOptions): Promise<BatchOutcome> {
  const abandonMs = Math.min(o.abandonBeforeCommitMs, ...calls.map((c) => c.opts.abandonBeforeCommitMs ?? o.abandonBeforeCommitMs));
  const nowMs = o.nowMs ?? (() => performance.now());
  let restarts = 0;
  let freshAttempts = 0;
  let tx: BatchTxn;
  try {
    tx = await store.beginBatch();
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e : new Error(String(e)) };
  }
  for (;;) {
    const started = nowMs();
    let plan: AttemptPlan | undefined;
    try {
      plan = await runAttempt(tx, env, calls);
      if (!plan.anyCommit) {
        await quietly(tx.rollback());
        tx.close(false);
        return { kind: 'answered', plan };
      }
      await tx.write(env.decl.kind, plan.writes);
      if (nowMs() - started > abandonMs) throw new AbandonSignal();
      try {
        await commitWithBackstop(tx, o.commitBackstopMs);
      } catch (e) {
        if (isRetryable(e)) throw e;              // RELEASE answered 40001: not committed
        tx.close(true);
        return { kind: 'ambiguous', plan, reason: e instanceof Error ? e.message : String(e) };
      }
      tx.close(false);
      return { kind: 'answered', plan };
    } catch (e) {
      if (e instanceof TierTimeout) {
        // RFC-006 §4.7: the tier did not answer the epoch read in time; the batch is abandoned and starts again
        // on the next tier. The connection may hang, so it is discarded without a ROLLBACK.
        tx.close(true);
        if (freshAttempts >= 1) return { kind: 'retry', restarts, freshAttempts };
        freshAttempts += 1;
        try {
          tx = await store.beginBatch();
        } catch (be) {
          return { kind: 'failed', error: be instanceof Error ? be : new Error(String(be)) };
        }
        continue;
      }
      if (e instanceof StaleEpochSignal) {
        await quietly(tx.rollback());
        tx.close(false);
        return { kind: 'staleEpoch' };
      }
      const abandon = e instanceof AbandonSignal;
      if (!isRetryable(e) && !abandon) {
        await quietly(tx.rollback());
        tx.close(true);
        return { kind: 'failed', error: e instanceof Error ? e : new Error(String(e)) };
      }
      if (!abandon && freshAttempts === 0 && restarts < o.batchRetries) {
        restarts += 1;
        try {
          await tx.restart();
          continue;
        } catch (re) {
          if (!isRetryable(re)) {
            tx.close(true);
            return { kind: 'failed', error: re instanceof Error ? re : new Error(String(re)) };
          }
        }
      }
      await quietly(tx.rollback());
      tx.close(false);
      if (freshAttempts >= 1) return { kind: 'retry', restarts, freshAttempts };
      freshAttempts += 1;
      try {
        tx = await store.beginBatch();
      } catch (be) {
        return { kind: 'failed', error: be instanceof Error ? be : new Error(String(be)) };
      }
    }
  }
}
