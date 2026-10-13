# Substrate bench: dev cell baseline (2026-10-13)

## Setup

- Cell: the dev cell (`platform/dev/docker-compose.yml`). 3 CockroachDB nodes, v24.3.5, one region (`r1a`, `r1b`, `r1c`), `--max-offset=100ms`. One Kafka broker.
- Host: MacBook Air M2, 8 cores, 16 GB. Docker (OrbStack) has 8 CPUs and 12 GB. The generator runs on the same host.
- Generator: commit `38ac174`. 64 slots, 64 partitions for each slot, one entry for each call, per-row statements, timing read on.
- Each run: 10 s warm-up, then 45 s. The window is 35 s.
- The host was shared. Other sessions ran. One other session recreated the cell during the first M0 attempt, so that attempt is not recorded. During the runs, Kafka used up to 70 % CPU. The bench does not use Kafka.

## Results

| Run | Offered calls/s | Committed calls/s | txn/s | Commit p50 / p99 / p99.9 ms | Batch wait p50 / p99 ms | Failed | File |
|---|---|---|---|---|---|---|---|
| M2 50 | 50.9 | 50.9 | 50.7 | 7.3 / 101 / 198 | 0.7 / 264 | 0 | `m2-50.json` |
| M2 100 | 101.1 | 101.1 | 100.5 | 9.3 / 105 / 159 | 0.6 / 123 | 0 | `m2-100.json` |
| M2 150 (seed 2) | 152.5 | 152.5 | 131.2 | 37.6 / 311 / 745 | 1.5 / 754 | 0 | `m2r-150.json` |
| M2 200 (seed 2) | 199.9 | 198.5 | 108.0 | 68.6 / 440 / 643 | 181 / 4,129 | 0 | `m2r-200.json` |
| M2 200 (seed 1) | 202.6 | 22.9 | 1.7 | 162 / 582 / 582 | 4,882 / 15,270 | 4 | `m2-200.json` |
| M2 300 | 302.8 | 14.1 | 3.3 | 224 / 1,008 / 1,286 | 4,129 / 20,972 | 12 | `m2-300.json` |
| M0 416 | 417.3 | 347.8 | 71.0 | 119 / 363 / 453 | 485 / 8,978 | 28 | `m0.json` |

## Findings

1. **The cell holds about 150 calls/s with no queue.** At 200 calls/s it is at the limit: batching starts (1.8 calls for each transaction) and the batch wait p99 is 4 s.
2. **Commit latency with no load:** p50 7 to 9 ms, p99 about 100 ms. This is the one-region floor on this host. It does not include the RTT between regions.
3. **One node takes most of the load.** At 150 and 200 calls/s, `crdb1` used 345 % to 367 % CPU. `crdb2` and `crdb3` used 88 % to 158 %. The leaseholders are on `crdb1`.
4. **Congestion collapse at the same rate.** Two runs at 200 calls/s gave different results. With seed 2, the cell committed 198 calls/s. With seed 1, it committed 23 calls/s: 434 attempts were abandoned at the 2 s limit, then started again as fresh transactions. The work that was abandoned added load, and the cell did not recover in the window. The bench copies the retry and abandon rules of `platform/runtime/src/batch/execute.ts`. Thus the owner runtime can possibly have the same metastable failure under overload. This was seen one time, on a shared host. Do it again on a quiet host before you make a decision.
5. **Do not use the cost figures.** `db cpu µs/txn` and `data statements/vCPU-s` (162 to 361, compared with 1,000) are not valid. All nodes, the generator and other workloads use the same CPUs.

## Not measured

- Latency between regions, 2 + 2 + 1 placement, topology states (M6): these need the emulated cell or cloud VMs.
- Cost for each vCPU (R24): this needs dedicated hosts.
- YugabyteDB (SP3).
