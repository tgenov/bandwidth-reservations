# BT-001: kafkajs 2.2.4 negative timeout causes a 1 ms timer loop

| Field | Value |
|---|---|
| Component | `kafkajs` 2.2.4 (the latest release, 2023-02-27), `src/network/requestQueue/index.js` |
| Found | 2026-10-13, in the integration tests of `platform/runtime` |
| Environment | Node.js 24 (pinned in `.nvmrc`) and Node.js 26.10.0 |
| Severity | Medium: CPU waste on every open connection, and a warning on each connection |
| Local state | Workaround retired: runtime moved to `@platformatic/kafka` (E-001), 2026-10-13. `billing/` (prior art, not a workspace) still uses kafkajs 2.2.4 and still has the defect |
| Upstream state | Reported, not fixed. Fix PRs are open but not merged. The upstream has had no commit since 2024-05-16 |

## Upstream reports

The defect is already reported, so this repository did not open a new issue.

| Reference | Kind | State | What it covers |
|---|---|---|---|
| [tulios/kafkajs#1751](https://github.com/tulios/kafkajs/issues/1751) | Issue, 2025-05-16 | Open | `TimeoutNegativeWarning` on Node.js 24 |
| [tulios/kafkajs#1556](https://github.com/tulios/kafkajs/issues/1556) | Issue, 2023-03-20 | Open | CPU usage increase in 2.2.4. Same root cause |
| [tulios/kafkajs#1667](https://github.com/tulios/kafkajs/pull/1667) | PR, 2024-02-27 | Open | Schedules no check when no request is pending |
| [tulios/kafkajs#1755](https://github.com/tulios/kafkajs/pull/1755) | PR, 2025-06-18 | Open | Prevents the negative delay |
| [tulios/kafkajs#1768](https://github.com/tulios/kafkajs/pull/1768) | PR, 2025-12-26 | Open | Prevents the negative delay |

## Defect

`RequestQueue.scheduleCheckPendingRequests` calculates the delay as follows:

```js
let scheduleAt = this.throttledUntil - Date.now()
if (!this.throttleCheckTimeoutId) {
  if (this.pending.length > 0) {
    scheduleAt = scheduleAt > 0 ? scheduleAt : CHECK_PENDING_REQUESTS_INTERVAL
  }
  this.throttleCheckTimeoutId = setTimeout(() => {
    this.throttleCheckTimeoutId = null
    this.checkPendingRequests()
  }, scheduleAt)
}
```

1. `throttledUntil` is `-1` when the broker has never throttled the client. The delay is
   then `-1 - Date.now()`, a negative number with the size of the epoch time.
2. When no request is pending, the code does not correct the delay. It gives the negative
   delay to `setTimeout`.
3. Node.js changes a negative delay to 1 ms and emits `TimeoutNegativeWarning`.
4. `checkPendingRequests` calls `scheduleCheckPendingRequests` again. Thus each idle
   connection runs a timer every 1 ms for as long as it stays open.

## How to reproduce

1. Open a kafkajs 2.2.4 client connection on Node.js 24 or later.
2. Run with `node --trace-warnings`.
3. Result: `TimeoutNegativeWarning: -17… is a negative number. Timeout duration was set to 1.`
   The process shows constant CPU use while the connection is idle.

The test `should schedule no pending-request check when nothing is pending and the queue
was never throttled` in `platform/runtime/test/kafkajs-request-queue.test.ts` failed
against the unpatched library. That test was removed with the workaround.

## Local workaround (retired)

Commit `66ab6b6` added the workaround. It was removed on 2026-10-13, when the runtime changed
to `@platformatic/kafka` ([E-001](../04-delivery/evaluations/E-001-kafka-client.md)).

`platform/runtime/src/feed/kafkajs-request-queue.ts` replaced
`RequestQueue.prototype.scheduleCheckPendingRequests` when the runtime loaded. The new
method did these steps:

- schedules no check when no request is pending;
- uses the remaining throttle time when it is more than 0;
- else uses the kafkajs poll interval (10 ms).

The pure function `pendingCheckDelayMs` held this rule, and unit tests covered it.

## Removal condition

The second condition below became true on 2026-10-13 (E-001). The patch and its test are
removed from `platform/runtime`. `billing/` does not have the patch. It keeps kafkajs and the
defect until it is retired (E-001 §11).

Remove the patch and its test when one of these is true:

- A kafkajs release fixes #1751 and #1556, and the test above passes without the patch.
- This repository changes to a different Kafka client. The upstream is not maintained.
  [`@confluentinc/kafka-javascript`](https://github.com/confluentinc/confluent-kafka-javascript)
  is a candidate. It has a kafkajs-compatible API.

The patch replaces an internal kafkajs method. If the `kafkajs` version changes, do the
check again, because the internal method can change.
