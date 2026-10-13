/**
 * The caller actions of C01 §3.2 for each AppendResult, shared by the five S-RATE owner kinds.
 *
 * The same AppendCall object goes to each retry, so every retry has the same identities.
 * Only `Committed` is a success. A result that C01 v1 does not define is a `Retry` and an
 * alert (C01 §8).
 */
import type { AppendCall, AppendOptions, AppendResult, OwnerRuntime } from '@share/owner-runtime';
import type { AlertSink } from './alerts.ts';

export type Committed = Extract<AppendResult, { r: 'Committed' }>;

export type AppendOutcome =
  | { ok: true; result: Committed }
  /** The call wrote nothing. `which` is the condition label, or 'decide' when decide returned null. */
  | { ok: false; why: 'conditionFailed'; which: string }
  /** An integrity stop is open: decide nothing, answer "temporarily unavailable". */
  | { ok: false; why: 'stopped' }
  /** StaleEpoch or Moved: this process does not serve the partition now. */
  | { ok: false; why: 'notOwner'; result: AppendResult }
  /** Retry, Ambiguous, Moving, Overloaded or an unknown result, after all attempts. Not known to be committed. */
  | { ok: false; why: 'notKnownCommitted'; last: AppendResult };

export interface AppendPolicy {
  owner: string;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  alerts?: AlertSink;
}

export const realSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

const KNOWN = new Set(['Committed', 'ConditionFailed', 'Retry', 'StaleEpoch', 'Moved', 'Moving', 'Stopped', 'Ambiguous', 'Overloaded']);

export async function appendWithPolicy(rt: OwnerRuntime, call: AppendCall, opts: AppendOptions | undefined,
  policy: AppendPolicy): Promise<AppendOutcome> {
  const attempts = policy.attempts ?? 5;
  const sleep = policy.sleep ?? realSleep;
  let last: AppendResult = { r: 'Retry' };
  for (let i = 0; i < attempts; i++) {
    const r = await rt.append(call, opts);
    last = r;
    if (!KNOWN.has(r.r)) {
      // C01 §8: an unknown result is a Retry, and an alert.
      policy.alerts?.raise({ owner: policy.owner, kind: 'UNKNOWN_APPEND_RESULT', detail: String((r as { r: unknown }).r) });
      await sleep(20 * (i + 1));
      continue;
    }
    switch (r.r) {
      case 'Committed': return { ok: true, result: r };
      case 'ConditionFailed': return { ok: false, why: 'conditionFailed', which: r.which };
      case 'Stopped': return { ok: false, why: 'stopped' };
      case 'StaleEpoch': case 'Moved': return { ok: false, why: 'notOwner', result: r };
      case 'Moving': await sleep(20 * (i + 1)); continue;
      case 'Overloaded': await sleep(r.retryAfterMs); continue;
      case 'Retry': case 'Ambiguous': await sleep(20 * (i + 1)); continue;
    }
  }
  return { ok: false, why: 'notKnownCommitted', last };
}
