/**
 * kafkajs 2.2.4 (the latest release) RequestQueue.scheduleCheckPendingRequests computes
 * `throttledUntil - Date.now()` with `throttledUntil = -1` when the broker never throttled, and passes
 * that negative epoch time to setTimeout when nothing is pending. Node clamps it to 1 ms
 * (TimeoutNegativeWarning), and each firing schedules the next: a 1 ms timer loop on every open
 * connection. This replaces the method with one that schedules a check only for pending requests,
 * after a non-negative delay. Upstream: tulios/kafkajs#1751 and #1556. Removal condition:
 * docs/bugtraq/BT-001-kafkajs-negative-timeout.md.
 */
import { createRequire } from 'node:module';
import { systemClock } from '../clock.ts';

/** kafkajs CHECK_PENDING_REQUESTS_INTERVAL. */
const CHECK_PENDING_REQUESTS_INTERVAL_MS = 10;

/** The delay before the next pending-request check, or undefined when no check is needed. */
export function pendingCheckDelayMs(o: { throttledUntilMs: number; nowMs: number; pending: number }): number | undefined {
  if (o.pending === 0) return undefined;
  const remaining = o.throttledUntilMs - o.nowMs;
  return remaining > 0 ? remaining : CHECK_PENDING_REQUESTS_INTERVAL_MS;
}

interface RequestQueueLike {
  pending: unknown[];
  throttledUntil: number;
  throttleCheckTimeoutId: NodeJS.Timeout | null;
  checkPendingRequests(): void;
  scheduleCheckPendingRequests(): void;
}

const require = createRequire(import.meta.url);
const RequestQueue = require('kafkajs/src/network/requestQueue/index.js') as { prototype: RequestQueueLike };

RequestQueue.prototype.scheduleCheckPendingRequests = function scheduleCheckPendingRequests(this: RequestQueueLike): void {
  if (this.throttleCheckTimeoutId) return;
  // kafkajs keeps throttledUntil on the system clock.
  const delay = pendingCheckDelayMs({ throttledUntilMs: this.throttledUntil, nowMs: systemClock(), pending: this.pending.length });
  if (delay === undefined) return;
  this.throttleCheckTimeoutId = setTimeout(() => {
    this.throttleCheckTimeoutId = null;
    this.checkPendingRequests();
  }, delay);
};
