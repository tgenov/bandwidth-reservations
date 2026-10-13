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
  slotQueueMax: 10_000,           // slot_queue_max: memory backstop, then Overloaded as in rule 5a (est.; RFC-006 §12.10)
  overloadedRetryAfterMs: 100,    // retryAfterMs of event-loop shedding (RFC-006 §4.7 rule 1)
} as const;

/**
 * Overload control for a slow database (RFC-006 §4.7 rule 5, erratum 7.1, AI6-12; §12.10). Every value is an
 * estimate (est.) that the §22.1 "Overload recovery" runs set.
 */
export const OVERLOAD = {
  overloadTargetMs: 500,          // overload_target (est.): above batch_time_budget
  overloadIntervalMs: 1_000,      // overload_interval (est.)
  retryFloorMs: 250,              // retry_floor (est.)
  retryAfterMaxMs: 5_000,         // the cap of D and of retryAfterMs (est.; review 78 D-78-5)
  retryDrainNoEstimateMs: 500,    // D before the lane has an estimate (est.)
  shedAnswerBurst: 500,           // shed_answer_burst: Overloaded answers per slot at once per tick (est.)
  shedTickMs: 100,                // the process tick that delivers the deferred answers
  ownerDefectFactor: 10,          // owner ignores retryAfterMs: shed answers above 10 × admitted over 10 s (est.)
  ownerDefectWindowMs: 10_000,
  batchTimeBudgetMs: 400,         // batch_time_budget: the per-entry part only (est.)
  fitWindowSamples: 32,           // fit window: the lane's last 32 samples (est.)
  fitWindowMaxAgeMs: 60_000,      // none older than 60 s (est.)
  cHatFloorMs: 0.001,             // the floor of the fitted slope
  fitSpreadFactor: 2,             // a least-squares fit needs two sizes at least 2 times apart
  fitMinSamples: 3,
  bigSampleEntries: 16,           // the no-spread estimate, the regime reset and the latest-batch bound use n ≥ 16
  regimeResetFactor: 2,           // regime reset and latest-batch bound at a factor of 2 (est.)
  probeAfterTakes: 8,             // probe after 8 capped takes in a row (est.)
  probeExtraEntries: 16,          // probe size max(n_cap + 16, 1.5 · n_cap)
  probeFactor: 1.5,
  lowBudgetDivisor: 5,            // a batch with a lower abandonBeforeCommitMs is sized with one fifth of it
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
