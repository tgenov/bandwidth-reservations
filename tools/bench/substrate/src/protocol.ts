/**
 * The client-side retry protocol of one slot batch, as platform/runtime/src/batch/execute.ts runs it
 * (RFC-006 §4.3 `Retry`; C01 §3.2, §7, R47-12): a 40001 restarts the same transaction by
 * ROLLBACK TO SAVEPOINT cockroach_restart, up to `batchRetries` times; then the batch starts once in a fresh
 * transaction; if that fails too, the answer is `retry`. An attempt that is not at COMMIT within
 * `abandonBeforeCommitMs` of its start is rolled back and starts afresh. A failed COMMIT that is not a 40001 is
 * `ambiguous`, never retried blind (M1). YugabyteDB has no restart that keeps intents, so in `fresh` mode each
 * retry is a new transaction, with the same budget.
 */
import type { Clock } from './clock.ts';
import type { Flavour } from './config.ts';
import { classifyFailure } from './retry.ts';

/** One open transaction (BEGIN done; SAVEPOINT cockroach_restart done in savepoint mode). */
export interface TxnPort {
  /** Every read and write of one attempt: fence, timing, heads, condition rows, ts, inserts, upserts. */
  attempt(): Promise<void>;
  /** SET LOCAL statement_timeout = backstop; RELEASE SAVEPOINT (CockroachDB); COMMIT. */
  commit(): Promise<void>;
  /** ROLLBACK TO SAVEPOINT cockroach_restart. */
  restart(): Promise<void>;
  rollback(): Promise<void>;
  /** Gives the connection back; `broken` discards it. */
  close(broken: boolean): void;
}

/** Opens a transaction (BEGIN). */
export interface TxnSource {
  open(): Promise<TxnPort>;
}

/** The fence read found another epoch: the slot is lost (C01 §3.2 `StaleEpoch`). */
export class StaleEpoch extends Error {
  readonly slot: number;
  constructor(slot: number) {
    super(`slot ${slot}: epoch fence failed`);
    this.name = 'StaleEpoch';
    this.slot = slot;
  }
}

class Abandon extends Error {}

export type ProtocolOutcome =
  | { kind: 'committed' }
  | { kind: 'retry' }
  | { kind: 'staleEpoch' }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'failed'; code: string };

/** What happened to one batch, with the times the recorder needs (clock ms). */
export interface ProtocolReport {
  outcome: ProtocolOutcome;
  /** Reasons of the 40001 restarts, in order. */
  restarts: string[];
  /** Reasons of the aborts, in order. */
  aborts: string[];
  freshAttempts: number;
  abandons: number;
  /** When the first BEGIN was sent (after the pool gave a connection). */
  beganMs: number;
  /** When the last COMMIT sequence started (equal to endMs when none started). */
  commitStartMs: number;
  endMs: number;
}

export interface ProtocolOptions {
  flavour: Flavour;
  restartMode: 'savepoint' | 'fresh';
  batchRetries: number;
  abandonBeforeCommitMs: number;
  clock: Clock;
}

async function quietly(p: Promise<void>): Promise<void> {
  try { await p; } catch { /* the connection is given back or discarded next */ }
}

/** Runs one batch to an outcome. Never throws. */
export async function runProtocol(src: TxnSource, o: ProtocolOptions): Promise<ProtocolReport> {
  const restarts: string[] = [];
  const aborts: string[] = [];
  let freshAttempts = 0;
  let abandons = 0;
  let retriesUsed = 0;
  const beganMs = o.clock.now();
  let commitStartMs: number | undefined;
  const end = (outcome: ProtocolOutcome): ProtocolReport => {
    const endMs = o.clock.now();
    return { outcome, restarts, aborts, freshAttempts, abandons, beganMs, commitStartMs: commitStartMs ?? endMs, endMs };
  };
  const openTx = async (): Promise<TxnPort | ProtocolReport> => {
    try {
      return await src.open();
    } catch (e) {
      const c = classifyFailure(e, o.flavour, 'statement');
      return end({ kind: 'failed', code: c.kind === 'other' ? c.code : c.kind });
    }
  };

  let opened = await openTx();
  if (!('attempt' in opened)) return opened;
  let tx: TxnPort = opened;
  for (;;) {
    const started = o.clock.now();
    try {
      await tx.attempt();
      if (o.clock.now() - started > o.abandonBeforeCommitMs) throw new Abandon();
      commitStartMs = o.clock.now();
      try {
        await tx.commit();
      } catch (e) {
        const c = classifyFailure(e, o.flavour, 'commit');
        if (c.kind === 'restart' || c.kind === 'abort') throw e;       // RELEASE answered 40001: not committed
        tx.close(true);
        return end({ kind: 'ambiguous', reason: c.kind === 'ambiguous' ? c.reason : c.kind === 'other' ? c.code : c.kind });
      }
      tx.close(false);
      return end({ kind: 'committed' });
    } catch (e) {
      if (e instanceof StaleEpoch) {
        await quietly(tx.rollback());
        tx.close(false);
        return end({ kind: 'staleEpoch' });
      }
      const abandon = e instanceof Abandon;
      if (abandon) {
        abandons += 1;
      } else {
        const c = classifyFailure(e, o.flavour, 'statement');
        if (c.kind === 'restart') restarts.push(c.reason);
        else if (c.kind === 'abort') aborts.push(c.reason);
        else {
          await quietly(tx.rollback());
          tx.close(true);
          return end({ kind: 'failed', code: c.kind === 'other' ? c.code : c.kind === 'statementTimeout' ? '57014' : c.reason });
        }
      }
      if (!abandon && freshAttempts === 0 && retriesUsed < o.batchRetries) {
        retriesUsed += 1;
        if (o.restartMode === 'savepoint') {
          try {
            await tx.restart();
            continue;
          } catch (re) {
            const c = classifyFailure(re, o.flavour, 'statement');
            if (c.kind !== 'restart' && c.kind !== 'abort') {
              tx.close(true);
              return end({ kind: 'failed', code: c.kind === 'other' ? c.code : c.kind });
            }
          }
        } else {
          await quietly(tx.rollback());
          tx.close(false);
          opened = await openTx();
          if (!('attempt' in opened)) return opened;
          tx = opened;
          continue;
        }
      }
      await quietly(tx.rollback());
      tx.close(false);
      if (freshAttempts >= 1) return end({ kind: 'retry' });
      freshAttempts += 1;
      opened = await openTx();
      if (!('attempt' in opened)) return opened;
      tx = opened;
    }
  }
}
