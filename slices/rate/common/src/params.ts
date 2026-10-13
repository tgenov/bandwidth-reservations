/** Parameters of RFC-003 §8 that I1 uses. Values in milliseconds. "est." values are design estimates. */
export const RATE_PARAMS = {
  /** POL-13. */
  flowActiveTimeoutMs: 60_000,
  /** POL-14. */
  maxLatenessMs: 180_000,
  /** est. */
  usageCloseMarginMs: 15_000,
  /** The usage close bound: flow_active_timeout + max_lateness + 45 s after the end of the minute (est.). */
  usageCloseBoundMs: 45_000,
  /** est. */
  exposurePublishIntervalMs: 2_000,
  /** est. */
  epochJitterMs: 2_000,
  /** est. */
  futureSkewMaxMs: 5 * 60_000,
  /** est. */
  bindingGraceMs: 5 * 60_000,
  /** POL-27. */
  priceNoticeMs: 30 * 24 * 3_600_000,
  /** est. */
  ingestRetryTimeoutMs: 2_000,
  maxBatchBytes: 1_048_576,
  creditWindowBatches: 4,
  creditWindowBytes: 4 * 1_048_576,
} as const;
