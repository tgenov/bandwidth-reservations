/** C01 §7 timeouts and deadlines (defaults). Tests may shorten the session timings only. */
export const PARAMS = {
  epsilonMs: 100,                 // ε = max_offset
  sessionTtlMs: 3_000,
  sessionRenewMs: 500,
  renewRetryMs: 100,
  holderViewMs: 2_900,            // session_ttl − ε (C01 §3.1)
  maxLoopDelayMs: 200,            // leaseValid margin (R47-23)
  tierTimeoutMs: 400,
  idleInTransactionMs: 1_000,
  statementTimeoutMs: 2_000,
  abandonBeforeCommitMs: 2_000,
  commitBackstopMs: 15_000,
  batchRetries: 5,
  displacementLockTimeoutMs: 10,
  slotBatchMaxEntries: 2_000,
  slotBatchMaxBytes: 4_000_000,
  homeSpaceBits: 20,
  sessionShards: 64,
  timingShards: 64,
  loopDelayShedP99Ms: 50,         // RFC-006 §4.7 rule (1)
  maxQueuedCallsPerSlot: 10_000,  // admission control (est.)
  overloadedRetryAfterMs: 100,
} as const;

export type SessionTimings = {
  sessionTtlMs: number; sessionRenewMs: number; renewRetryMs: number; holderViewMs: number; maxLoopDelayMs: number;
};

export const DEFAULT_SESSION_TIMINGS: SessionTimings = {
  sessionTtlMs: PARAMS.sessionTtlMs,
  sessionRenewMs: PARAMS.sessionRenewMs,
  renewRetryMs: PARAMS.renewRetryMs,
  holderViewMs: PARAMS.holderViewMs,
  maxLoopDelayMs: PARAMS.maxLoopDelayMs,
};
