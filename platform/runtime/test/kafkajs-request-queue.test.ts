/** kafkajs 2.2.4 RequestQueue: the pending-request check is a delay, never an epoch time made negative. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pendingCheckDelayMs } from '../src/index.ts';

const require = createRequire(import.meta.url);
const RequestQueue = require('kafkajs/src/network/requestQueue/index.js') as new (o: Record<string, unknown>) => {
  pending: unknown[];
  throttledUntil: number;
  throttleCheckTimeoutId: NodeJS.Timeout | null;
  scheduleCheckPendingRequests(): void;
  destroy(): void;
};

const NOW_MS = 1_791_878_186_248;
const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function queue(): InstanceType<typeof RequestQueue> {
  return new RequestQueue({ maxInFlightRequests: null, requestTimeout: 30_000, enforceRequestTimeout: false, clientId: 'test', broker: 'b:9092', logger: silentLogger });
}

test('should schedule no pending-request check when nothing is pending and the queue was never throttled', () => {
  const q = queue();
  try {
    q.scheduleCheckPendingRequests();
    assert.equal(q.throttleCheckTimeoutId, null);
  } finally {
    q.destroy();
  }
});

test('should need no pending-request check when nothing is pending', () => {
  assert.equal(pendingCheckDelayMs({ throttledUntilMs: -1, nowMs: NOW_MS, pending: 0 }), undefined);
  assert.equal(pendingCheckDelayMs({ throttledUntilMs: NOW_MS + 500, nowMs: NOW_MS, pending: 0 }), undefined);
});

test('should check again after the poll interval when requests are pending and the throttle has ended', () => {
  assert.equal(pendingCheckDelayMs({ throttledUntilMs: -1, nowMs: NOW_MS, pending: 1 }), 10);
  assert.equal(pendingCheckDelayMs({ throttledUntilMs: NOW_MS, nowMs: NOW_MS, pending: 3 }), 10);
});

test('should check again when the throttle ends when requests are pending under a throttle', () => {
  assert.equal(pendingCheckDelayMs({ throttledUntilMs: NOW_MS + 750, nowMs: NOW_MS, pending: 2 }), 750);
});
