# E-001: Node.js Kafka client for the owner runtime

| Field | Value |
|---|---|
| Status | **Decided 2026-10-13: `@platformatic/kafka`** (§11) |
| Date | 2026-10-13 |
| Scope | `platform/runtime` (`FeedBus`, `KafkaBus`, publisher). `billing/` is out of scope (§7) |
| Trigger | [BT-001](../../bugtraq/BT-001-kafkajs-negative-timeout.md): a kafkajs 2.2.4 defect that the runtime must patch |
| Decision | `@platformatic/kafka`. Fallback: `@confluentinc/kafka-javascript` |

## 1. Problem

The runtime uses kafkajs 2.2.4. kafkajs is not maintained:

- The last release was on 2023-02-27, and the last commit on 2024-05-16.
- Issues [#1603](https://github.com/tulios/kafkajs/issues/1603) ("Looking for maintainers") and
  [#1753](https://github.com/tulios/kafkajs/issues/1753) ("KafkaJS status") are open.
- The fix PRs for BT-001 are not merged.

The runtime also loads a kafkajs internal file (`murmur2.js`), so `MemoryBus` can put records on
the same partitions as Kafka. Any kafkajs change can break both the BT-001 patch and `MemoryBus`.

## 2. Requirements

These come from the `FeedBus` interface (`platform/runtime/src/feed/bus.ts`) and C01 §2.5, §3.5,
§3.6, §3.8.

| ID | Requirement | Need |
|---|---|---|
| R1 | Admin: create topics (also compacted), grow partitions, partition count, wait for leaders | Now |
| R2 | End offsets per partition, committed offsets per group | Now |
| R3 | Produce with acks=all and binary headers | Now |
| R4 | Keyed records go to the partition of the Java murmur2 default partitioner. `MemoryBus` must compute the same partition | Now |
| R5 | Consumer groups with manual commit. Records of one partition are processed one at a time, in offset order, and each is awaited | Now |
| R6 | Clean close of all clients | Now |
| R7 | TypeScript strict and ESM. Node 24 (`.nvmrc`). Developer machines run Node 26 | Now |
| R8 | Idempotent producer and transactions (exactly-once) for the money paths | Later |
| R9 | TLS and SASL | Production |

## 3. Candidates

| Candidate | Version | Kind | Backing | Result of desk study |
|---|---|---|---|---|
| kafkajs | 2.2.4 | Pure JS | Volunteers, inactive | Baseline |
| `@confluentinc/kafka-javascript` | 1.11.0 (librdkafka 2.16.0) | Native (librdkafka, nan addon) | Confluent Inc. | Spike |
| `@platformatic/kafka` | 2.14.0 | Pure TypeScript, ESM | Platformatic Inc. | Spike |
| `node-rdkafka` | 3.6.1 | Native, built at install | Community (Blizzard) | Rejected: 3 commits in 12 months, no types, no prebuilt binaries |
| `kafka-crab-js`, `kafka-ts` | — | Rust/napi, pure TS | Individuals | Rejected: too few users (153 and 1,300 downloads per week) |

Desk data (2026-10-13, from `gh api` and `npm view`):

| | kafkajs | Confluent | Platformatic |
|---|---|---|---|
| Latest release | 2023-02-27 | 2026-10-07 | 2026-10-07 |
| Commits in last 12 months | 0 | 85 | 100 or more |
| Downloads per week | 3.69M | 925k | 481k |
| Open issues | 419 | 113 | 11 |
| License | MIT | MIT | Apache-2.0 |
| Prebuilt binaries | Not applicable | Node 18–24 only. No Node 26 | Not applicable |
| Default partitioner | Java murmur2 | `murmur2_random` (Java-compatible) in the kafkajs-compatible API. Native API default is `consistent_random` (CRC32) | Own murmur2 variant, **not** Java-compatible. Option `compatibilityPartitioner` gives Java murmur2 |
| Idempotence, transactions | Experimental | Yes (librdkafka) | Yes |
| NestJS `Transport.KAFKA` | Yes (the only client Nest supports) | No | No |

## 4. Method

Each spike ran in its own git worktree. It replaced the kafkajs implementation of `KafkaBus`
and the publisher, kept the `FeedBus` contract, and then ran:

1. `npm run check`, two times.
2. `REQUIRE_DEV_CELL=1 npm run test:platform:integration`, three or four times.
3. A partitioner parity test: 1,000 seeded keys and several partition counts (1 to 100). The
   oracle is the kafkajs Java port. The Confluent spike also ran the test against the live
   broker.
4. The benchmark `tools/bench/bus-bench.ts`:
   - Throughput mode:
     - produce 20,000 keyed 200-byte records with acks=all, in batches of 100, to a new
       6-partition topic;
     - then consume them with one group member, with awaited per-record processing and a
       commit every 100 records.
   - Idle mode: a connected producer and consumer on an idle topic for 30 s, measuring CPU time.

The spikes ran at the same time on one broker. The orchestrator then ran the benchmark again
on a broker with no other load:

- Throughput: five rounds. Each round ran kafkajs, then Platformatic, then Confluent, one
  after the other.
- Idle: three rounds, in the same order.

The figures in §5 come from this second run. The raw output is in
[E-001-bench-raw.jsonl.txt](E-001-bench-raw.jsonl.txt).

Environment:

| Item | Value |
|---|---|
| Machine | Apple M2, 8 cores, 16 GB, macOS 27.0 |
| Node | v26.10.0 (no version manager installed, so not the `.nvmrc` version 24) |
| Broker | `apache/kafka:3.9.0`, KRaft, 1 broker, in the dev cell (OrbStack) |
| Database | `cockroachdb/cockroach:v24.3.5`, 3 nodes |
| kafkajs | 2.2.4, with the BT-001 patch |

Spike settings that can change the results:

- Platformatic: idempotent producer, `maxInflights: 1`.
- Confluent: kafkajs-compatible API, `linger.ms=0`, `partitioner=murmur2_random`.
- No other setting was tuned.

## 5. Results

### 5.1 Function

| | Confluent | Platformatic |
|---|---|---|
| `npm run check` | Pass (2 of 2) | Pass (2 of 2) |
| Platform integration tests | Pass: 18 of 18 in 3 runs, 20 of 20 in 1 run (2 new tests) | Pass: 17 of 17 in 3 runs |
| Warnings in test output | None | None |
| Partitioner parity, unit test | Pass | Pass. The test also shows that the default partitioner disagrees for counts 3, 6, 7, 12 and 100 |
| Partitioner parity, live broker | Pass. When the partitioner was set to `consistent_random`, the test failed, so it catches a wrong setting | 0 of 140,000 consumed records on the wrong partition |
| Code changed | About 120 lines of runtime code | About 200 lines (`kafka-bus.ts`) |
| Install | 529 s: built from source, because there is no Node 26 binary. Hundreds of linker warnings. Needs Xcode CLT and Python | 5.2 s, 16 packages, no audit findings |

### 5.2 Performance (no other load on the broker)

Median of 5 runs. Idle CPU is the median of 3 runs. The range is in brackets.

| Metric | kafkajs (patched) | Platformatic | Confluent |
|---|---|---|---|
| Produce, records/s | 23,142 (16,872–48,718) | 13,418 (9,809–14,565) | **35,153** (4,804–36,726) |
| Produce batch p50, ms | 1.92 | 1.55 | 1.56 |
| Produce batch p99, ms | 25.6 (22.2–86.4) | 25.6 (18.0–61.8) | **20.4** (12.3–154.9) |
| Consume after group join, records/s | 42,441 | **65,711** (12,840–98,592) | 50,018 |
| Consume including group join, records/s | 5,653 | 5,833 | 5,389 |
| Group join, s | 3.1 | 3.1 | 3.3 |
| Process CPU for one run, ms | 920 | 1,264 | **772** |
| RSS at end, MiB | **82** | 160 | 107 |
| Idle CPU in 30 s, ms | 90 (73–105) | **58** (53–64) | 65 (61–66) |

Observations:

1. The group join (about 3 s, the broker's rebalance delay) controls the end-to-end consume
   rate. The three clients are equal on this metric.
2. Platformatic produces about 40% fewer records per second than kafkajs. The cause can be the
   spike settings (idempotent producer, one request in flight) and not the library. This was
   not isolated.
3. Confluent has the best produce rate and p99, but one run of five was slow (4,804 records/s,
   p99 155 ms).
4. The p99 problem that the spike reported for Platformatic (67 ms) came from the shared broker.
   With no other load, its p99 is the same as kafkajs.
5. kafkajs uses the most idle CPU even with the BT-001 patch.
6. All three clients are well above the needs of the POC. Performance does not decide this
   choice.

### 5.3 Behaviour that differs from kafkajs

| | Confluent | Platformatic |
|---|---|---|
| `onRecord` throws | Seeks back and delivers the record again at once. **No backoff**: a record that always fails loops | Restarts from the committed offset after a fixed 300 ms |
| Partition number out of range | Error | The client silently uses the number modulo the partition count. The spike adds a guard that refuses it |
| Grow partitions | Needs a second, native `AdminClient`. The kafkajs-compatible admin has no `createPartitions` | Supported |
| Wait for leaders | Not supported. Our `waitForTopicLeaders` does it, with the librdkafka error names added | Not supported. Our `waitForTopicLeaders` does it |
| Long processing | `rebalanceTimeout` becomes `max.poll.interval.ms` (default 300 s). A longer `onRecord` leaves the group | Same as kafkajs |
| Errors | librdkafka error names | Unknown topic is a `UserError` with no protocol code, so code must match the text |
| Types | Bundled. CJS only | Native ESM. Some loose types: the partitioner `.d.ts` has 2 arguments but the code passes 3; `value` is optional in the type but required at run time |

Both clients: a running subscription does not see new partitions within 30 s. kafkajs has the
same gap, so this is not a regression.

## 6. Risks

| Candidate | Risk | Mitigation |
|---|---|---|
| kafkajs | No maintenance. BT-001 stays. Experimental exactly-once | Replace |
| Confluent | Native nan addon: every Node major version needs a new binary. No Node 26 binary today | Pin Node 24 everywhere, or accept the source build |
| Confluent | Open bugs: consumer stops with no error ([#476](https://github.com/confluentinc/confluent-kafka-javascript/issues/476)), `eachBatch` swallows fatal errors ([#497](https://github.com/confluentinc/confluent-kafka-javascript/issues/497)), duplicates after seek ([#417](https://github.com/confluentinc/confluent-kafka-javascript/issues/417)), segfault in `describeGroups` ([#531](https://github.com/confluentinc/confluent-kafka-javascript/issues/531)) | Watchdog for a stopped consumer. Backoff in the adapter |
| Platformatic | Young library. Recent open issues: fenced leader epoch ([#438](https://github.com/platformatic/kafka/issues/438)), forgotten brokers ([#449](https://github.com/platformatic/kafka/issues/449)), unbounded close ([#454](https://github.com/platformatic/kafka/issues/454)) | Pin the exact version. All use goes through one adapter, so a change to Confluent is about 120 lines |
| Platformatic | The default partitioner is not Java-compatible. A new producer that forgets `compatibilityPartitioner` puts records on wrong partitions with no error | Only `KafkaBus` and the publisher produce. The partition guard and the parity property test stay in the suite |

## 7. NestJS and `billing/`

- `@nestjs/microservices` (12.1.3) supports only kafkajs for `Transport.KAFKA`. Issue
  [nestjs/nest#13223](https://github.com/nestjs/nest/issues/13223) ("KafkaJs seems not
  maintained anymore") is open.
- The NestJS maintainer posted example code for a `@platformatic/kafka` transport in that issue.
  It has no request-reply (`@MessagePattern`) support.
- The community package `nestjs-kafka-transport` 0.3.0 (first published 2026-09-28, one
  author) is built on Platformatic. It is too new to use.
- There is no NestJS transport for the Confluent client.

Only `billing/` uses the NestJS Kafka transport (`@EventPattern`, `@MessagePattern`,
`ClientKafka`). `billing/` is prior art. It is not an npm workspace, and the plans do not extend
it (S-RATE plan §3, S-ACCT+S-MONEY plan §4). The owners use NestJS only as the application shell,
and they reach Kafka only through `FeedBus` and the runtime publisher. Thus the NestJS limit does
not affect the owners. `billing/` stays on kafkajs, and it keeps the BT-001 timer loop until it is
retired.

Proposed rule: no owner uses `@nestjs/microservices` for Kafka. All Kafka traffic goes through
`FeedBus` and the runtime publisher.

## 8. CockroachDB changefeed partitioning

By default, CockroachDB changefeeds hash keys with FNV-1a, not murmur2. Murmur2 needs the
option `partition_alg='murmur2'` and two cluster settings, and it is not available in the dev
cell version (24.3).

This does not affect the feeds:

- The changefeed writes only to the topic `cdc.<kind>`.
- The relay reads `cdc.<kind>` and produces each row again through `FeedBus`, keyed by
  `msg_key` (`platform/runtime/src/relay/relay.ts`). Thus every feed record gets its partition
  from murmur2.
- On `cdc.<kind>`, the relay needs only two properties. Each key always goes to the same
  partition, and each partition gives its own resolved timestamps. FNV-1a gives both.

## 9. Recommendation

Use `@platformatic/kafka` for `platform/runtime`. The reasons:

1. Pure TypeScript and ESM: no native toolchain, and it works on Node 24 and Node 26 now.
2. The lowest idle CPU, and the best consume rate after the group join.
3. It exports `murmur2`, so `MemoryBus` does not load a file from inside a library.
4. Active vendor maintenance. It is the client that the NestJS ecosystem points to.
5. The risk of a young library is contained. All use goes through one adapter, and Confluent
   is a tested fallback.

Confluent is the safer choice for a production fleet pinned to Node 24, because librdkafka is
mature and it has the best produce rate. It is not chosen now because of the native build, the
tie to Node versions, the second admin client and the open bugs that stop a consumer.

Conditions:

- Set `compatibilityPartitioner` on every producer. Keep the partition guard and the parity
  property test.
- Pin the exact version.
- Add the Confluent spike's integration test `kafka-bus.test.ts` (partition growth, commits).
- Before the money paths: measure produce again with idempotence off and more than one
  request in flight. Then decide the producer settings for R8.

When the decision is made: remove the BT-001 patch and its test, close BT-001, make kafkajs a
dev dependency (it stays the oracle of the parity test), and add the §7 rule to
`engineering.md`.

## 10. How to reproduce

The benchmark script is `tools/bench/bus-bench.ts`. `platformatic` is the runtime's `KafkaBus`
(`platform/runtime/src/feed/kafka-bus.ts`). `kafkajs` is the old adapter, kept as a baseline in
`tools/bench/kafkajs-bus.ts`. The Confluent adapter is not merged.

```
npm run dev:up
npm run bench:bus
BUS_CLIENT=platformatic|kafkajs node tools/bench/bus-bench.ts
BUS_CLIENT=… BUS_MODE=idle node tools/bench/bus-bench.ts
```

Run the clients one after the other. Make sure no other process uses the broker. The script
deletes its topic at the end.

The kafkajs baseline does not have the BT-001 patch, because the patch was removed with
kafkajs. Thus its idle CPU is much higher than the "kafkajs (patched)" value in §5.2. In one
run on 2026-10-13 it used 700 ms of CPU in 30 s idle (Platformatic: 44 ms).

## 11. Decision

Decided on 2026-10-13 by the project owner: the runtime changes to `@platformatic/kafka`, with
the conditions of §9.

The rationale is §9:

- There is no native toolchain, and it supports Node 24 and Node 26 now.
- It has active vendor maintenance.
- It has the lowest idle CPU.
- It exports `murmur2`.
- The risk of a young library is contained: all use goes through one adapter, and Confluent
  is a tested fallback.

The rejected options and why:

| Option | Reason it was rejected |
|---|---|
| Stay on kafkajs | Not maintained. It needs a patch to its internals (BT-001), and its exactly-once support is experimental |
| Confluent | A native addon tied to Node versions, with no Node 26 binary. It needs a second admin client, and it has open bugs that stop a consumer with no error. It stays the fallback |
| `node-rdkafka` and the small clients | Low activity or too few users |

Consequences:

1. Remove the BT-001 patch and its test. Close BT-001 for the runtime. `billing/` keeps
   kafkajs and the defect until it is retired.
2. kafkajs becomes a dev dependency of `platform/runtime`, used only as the parity-test oracle
   and as the benchmark baseline.
3. New rule in `engineering.md`: no owner uses `@nestjs/microservices` for Kafka. All Kafka
   traffic goes through `FeedBus` and the runtime publisher. Every producer sets the
   Java-compatible partitioner.
4. Open item before the money paths: measure the producer settings for R8 (idempotence,
   requests in flight).
