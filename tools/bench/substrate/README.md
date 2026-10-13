# Substrate bench (spike S-PLAT-SP1 (a))

This tool is a synthetic load generator. It sends the slot batch transaction of RFC-006 §4.3 to
CockroachDB or YugabyteDB. It measures what the transaction costs before more slices are built.

RFC-000 ("What the substrate costs") and RFC-006 §19.2 give estimates only: about 5 ms more per commit,
about 1,000 statements per vCPU-second, 36 nodes of 96 vCPU per facility. Spike SP1 (a) in
`docs/04-delivery/plan/S-PLAT.md` §4 measures them. RFC-006 §22.1 gives the exit criteria.

## 1. What the generator does

- It drives N slots. Each slot has one queue and at most one batch transaction in flight
  (RFC-006 §4.3; C01 §3.2). When a slot is free, it takes all queued calls into one batch.
- Calls arrive by an open-loop Poisson process at a fixed offered rate. The generator does not wait
  for an answer before it sends the next call. Each latency starts at the intended arrival time.
  Thus a slow database or a late generator shows in the latency (no coordinated omission).
- Each batch runs the client-side retry protocol of `platform/runtime/src/batch/execute.ts`.
- The generator writes no Kafka records and starts no changefeed.

### 1.1 The transaction shape

| Step | Statement | Source |
|---|---|---|
| 1 | `BEGIN` (serialisable); `SAVEPOINT cockroach_restart` | RFC-006 §4.3; `store/pg.ts` `beginBatch` |
| 2 | Fence: `SELECT epoch, stops_version, report_through, marker_seq FROM owner_slot` | §4.3; `store/pg.ts` `readFence`. A changed epoch gives `StaleEpoch` |
| 3 | `SELECT … FROM platform_timing WHERE shard = slot mod 64` (`SUBSTRATE_TIMING_READ=1`) | `batch/attempt.ts` line 123; RFC-006 §6.4 |
| 4 | Head rows: `SELECT … FROM account_head WHERE home_key = ANY(…) AND partition = ANY(…)` | §4.3; `store/pg.ts` `selectHeads` |
| 5 | Condition rows: one `rowAbsent` row of `account_requests` for each call | §4.3 "each call's condition rows"; `store/pg.ts` `readRows` |
| 6 | `SELECT cluster_logical_timestamp()` (the batch `ts`) | §4.3; `store/pg.ts` `readTs` |
| 7 | `INSERT INTO account_log` for each entry, with `seq` and `chain` for each partition | §4.3; `store/pg.ts` `write` |
| 8 | `INSERT INTO account_outbox` for each call (and the marker row when one is due) | §4.3, §4.6 |
| 9 | `UPSERT INTO account_head` for each partition, with the `batch_id` | §4.3; C01 R47-14 |
| 10 | `UPSERT INTO account_requests` (projection rows, multi-row) | §4.3 |
| 11 | `UPDATE owner_slot SET report_through, marker_seq` (only with `SUBSTRATE_MARKER_EVERY`) | §4.6; C01 V59-6 |
| 12 | `SET LOCAL statement_timeout = '15000ms'`; `RELEASE SAVEPOINT cockroach_restart`; `COMMIT` | C01 §7, M1 |

Retry protocol (C01 §3.2, §7, R47-12):

- A 40001 restarts the same transaction (`ROLLBACK TO SAVEPOINT cockroach_restart`). This keeps the
  intents. The generator does this up to 5 times. Then it starts the batch once in a new transaction.
  If that also fails, the calls get `Retry`.
- The generator counts restarts and aborts apart (§22.1, R33-17). An abort is a
  `TransactionAbortedError` or a deadlock. The generator records the reason of each.
- A failed `COMMIT` that is not a 40001 is `Ambiguous`. The generator does not retry it.
- An attempt that is not at `COMMIT` 2,000 ms after its start is abandoned and starts again.
- Statement timeout 2 s and idle-in-transaction timeout 1 s are session settings (C01 §7).

Keys (RFC-006 §3.7). A slot's partitions have homes `slot + j × slots`. The head key is the 20-bit
reversal of the home, so the heads of one slot are in one key range. Log and outbox keys start with the
slot. Setup pre-splits each table as `platform/migrate/src/generate.ts` does.

### 1.2 Differences from the real runtime

- The partition keys are synthetic. The generator writes the head key directly; it does not hash.
- `decide`, sealing (C13) and the real `chain` formula (C08) are not used. The `chain` is SHA-256 of the
  previous chain, the `seq` and the payload. The client CPU is thus near the runtime's, but not equal.
- No `firstStatement`, no displacement read, no second lane, no `exclusive` call, no stops re-read.
- No marker-only transactions (§4.6, about 30,000 a second at the design load, 3 statements).
- No session renewals, no standby polls, no relay, no changefeed. RFC-006 §19.2 counts these apart.
- `Ambiguous` is counted but not resolved. A real slot runs the resolution steps first.
- On YugabyteDB: no restart keeps the intents, so each retry is a new transaction; `ts` is the
  transaction timestamp, not an HLC; the outbox has no row TTL. Each of these is in `src/sql.ts`
  `DIALECTS`, the one switch between the two databases.

## 2. Which RFC-006 §22.1 rows this tool covers

| §22.1 row | Coverage | How |
|---|---|---|
| Per-transaction database cost at about 1.1 partitions per batch | **Yes** | `db cpu µs/txn` and `data statements/vCPU-s` from `crdb_internal.kv_node_status` (every node) over the window. The summary compares with 1,000 ± 25 % |
| Two-region commit p50, p99, p99.9 of the batch transaction, in every topology state | **Yes**, one state for each run | `txn ms` (first `BEGIN` to `COMMIT` answer) and `commit ms` (the `RELEASE` + `COMMIT` round trips). You set the topology state by hand (§5, M6) |
| Client-side retry protocol: restarts counted apart from aborts | **Partly** | Counts and reasons. It does not prove that a restart keeps the intents. That is SP3 |
| Transactions pushed by the closed timestamp (below 0.01 %) | **Partly** | This shape reads `cluster_logical_timestamp()`, so each push becomes a 40001 restart (RFC-006 §3.4). Slots do not share rows, so restarts per transaction are an upper limit of pushes. The `txn.*` and `kv.closed_timestamp*` metric deltas are in the result |
| Account step p99, batching wait included, at the design load (≤ 50 ms) | **Partly** | `entry ms` (arrival to `COMMIT` answer) and `batch wait ms` on the synthetic shape. The real account owner is SP1 (b) and (c) |
| Active SQL connections per node after a facility loss (about 420) | **Partly** | Run more processes or a larger `SUBSTRATE_POOL_SIZE` (M7). Read the connections per node in the DB Console |
| Range-lease failover (node kill) p99 ≤ 6 s; killing the leaseholder of an `owner_slot` shard | **Partly** | The per-second `timeline` shows the stall. One kill gives one sample, not a p99 |
| Account-owner process at 1,640 transactions a second; Node.js pauses | **No** | SP1 (b) on the I1 runtime. The generator reports its own event-loop delay only, to show that the generator is not the limit |
| RTT matrix; RTT to R3; zone configurations as applied; single-link booking; probes; `δ_x`; clock offsets; product features; renewal; takeover; Kafka; changefeed CPU and lag; closure lag; region-wide failover; automatic 2 + 2; hot-link move; attribution; Kafka partition load | **No** | SP2, SP3, SP4 and later increments. The runbook checks the zone configurations only as a precondition |

## 3. Settings

All settings are environment variables. `npm run bench:substrate` reads them.

| Variable | Default | Meaning |
|---|---|---|
| `SUBSTRATE_MODE` | `run` | `setup`, `run` or `merge` |
| `SUBSTRATE_FLAVOUR` | `crdb` | `crdb` or `yugabyte` |
| `SUBSTRATE_URL` | local CockroachDB, database `substrate_bench` | Connection string. Setup creates the database |
| `SUBSTRATE_TOPOLOGY` | `unlabelled` | Free text: the cluster layout. Merge refuses mixed values |
| `SUBSTRATE_LABEL` | the topology | Free text: the matrix row, for example `M1-steady` |
| `SUBSTRATE_PROCESS` | host name | The name of this generator process |
| `SUBSTRATE_SLOTS` | 1024 | Slots of the kind (a power of two) |
| `SUBSTRATE_SLOT_FIRST`, `SUBSTRATE_SLOT_COUNT` | 0, all | The slots of this process. Processes must not share slots |
| `SUBSTRATE_PARTITIONS_PER_SLOT` | 64 | Partitions (accounts) of each slot |
| `SUBSTRATE_RATE` | 6.5 × slot count | Offered calls a second of this process |
| `SUBSTRATE_DURATION_S`, `SUBSTRATE_WARMUP_S`, `SUBSTRATE_DRAIN_S` | 120, 30, 15 | Run length, warm-up (not measured), drain after the end |
| `SUBSTRATE_ENTRIES_PER_CALL` | 1 | Log entries of each call |
| `SUBSTRATE_MAX_BATCH_ENTRIES`, `SUBSTRATE_MAX_BATCH_BYTES` | 2000, 4194304 | Batch size limits (§4.3) |
| `SUBSTRATE_LOG_BYTES`, `SUBSTRATE_OUTBOX_BYTES`, `SUBSTRATE_PROJECTION_BYTES` | 200, 200, 100 | Row payload sizes. The payload is random, so it does not compress |
| `SUBSTRATE_STMT_MODE` | `per-row` | `per-row` as the runtime sends today, or `multi-row` (one statement for each table) |
| `SUBSTRATE_TIMING_READ` | 1 | 1 reads `platform_timing` in each batch, as the runtime does |
| `SUBSTRATE_MARKER_EVERY` | 0 | Every Nth batch of a slot carries a report marker. 0: never |
| `SUBSTRATE_BATCH_RETRIES`, `SUBSTRATE_ABANDON_MS`, `SUBSTRATE_COMMIT_BACKSTOP_MS` | 5, 2000, 15000 | C01 §7 |
| `SUBSTRATE_STATEMENT_TIMEOUT_MS`, `SUBSTRATE_IDLE_IN_TXN_MS` | 2000, 1000 | C01 §7 |
| `SUBSTRATE_POOL_SIZE` | slot count | Connections of this process |
| `SUBSTRATE_SEED` | 1 | Seed of the arrivals and the payload |
| `SUBSTRATE_DB_METRICS` | 1 on `crdb` | Read the cluster metrics before and after the window. Set it on **one** process only |
| `SUBSTRATE_OUT` | none | Also write the result JSON to this file |
| `SUBSTRATE_INPUTS` | none | Merge mode: result files, separated by commas |

The offered rate sets the occupancy of each slot. RFC-006 §19.2 expects about 1.1 calls per batch at
the design load. Start with a rate of 7 × slot count. Then read `per batch … partitions` in the summary
and adjust the rate until it is between 1.05 and 1.15.

## 4. Output

A run writes one JSON line on stdout and a text summary on stderr. The JSON has:

- `configs`, `processIds`, `topology`, `label`, `flavour`, `dbVersion`, `startedAt`, `windowS`;
- `counters`: offered and committed calls, outcomes, restarts and aborts by reason, statements;
- `histograms` (log-linear, mergeable): `txnUs`, `commitUs`, `entryUs`, `batchWaitUs`, `connectUs`,
  `callsPerBatch`, `partitionsPerBatch`;
- `timeline`: committed calls and the longest transaction for each second of the run;
- `clients`: client CPU, memory and event-loop delay of each process;
- `db`: cluster CPU and metric deltas over the window (CockroachDB only).

The summary says `SATURATED` when more than 0.1 % of the offered calls have no answer at the end.
Do not use the latency of a saturated run as a result. Use it only to find the limit.

To merge the files of processes that ran together:

```sh
SUBSTRATE_MODE=merge SUBSTRATE_INPUTS=a.json,b.json SUBSTRATE_OUT=merged.json npm run -s bench:substrate
```

## 5. Runbook

### 5.1 Check on the dev cell

The dev cell is one region, so it gives no two-region figures. Use it to check the setup only.

1. Start the dev cell: `npm run dev:up`.
2. Make the tables:
   `SUBSTRATE_MODE=setup SUBSTRATE_SLOTS=64 npm run -s bench:substrate`.
3. Do a short run:
   `SUBSTRATE_SLOTS=64 SUBSTRATE_DURATION_S=40 SUBSTRATE_WARMUP_S=10 SUBSTRATE_LABEL=M0-smoke npm run -s bench:substrate > m0.json`.
4. Make sure that the summary shows no failed batch and no stale epoch.

### 5.2 Provision a 2 + 2 + 1 cluster in three cloud regions

This is an outline. It uses no product of one cloud vendor.

1. Select three cloud regions. Use the RTT matrix of RFC-000 §3 as the target:
   - R1 and R2: two regions near each other. Each has two zones. A zone is one facility.
   - R3: one region farther away. It has one zone (two zones for the non-voters of §5.4 step 4).
2. Measure the RTT between all zones (for example with `ping` for 5 minutes). Record the matrix.
3. Make the database VMs. Use the same machine type for all of them, with local NVMe disks.
   - Minimum: 5 VMs, one in each of `r1a`, `r1b`, `r2a`, `r2b`, `r3a`.
   - For the non-voters: 2 VMs in each Kenyan zone and 2 in R3 (10 VMs).
   - Record the vCPU count of each VM. The cost figures need it.
4. Make the generator VMs in R1, one in each of `r1a` and `r1b`. The owners run in R1 (RFC-006 §3.3).
   Use enough vCPU to keep the generator below 50 % CPU.
5. Synchronise the clocks of all VMs with `chrony` and the time service of the cloud.
   Make sure that the offset is below 5 ms.
6. Open the SQL port (26257) and the HTTP port (8080) on the private network only.
   The cluster has a short life, but do not open it to the internet.
7. Install the same CockroachDB release on each database VM. Record the version.
8. Start each node with its locality and the clock bound of RFC-006 §3.6:
   `cockroach start --locality=region=r1,zone=r1a --max-offset=100ms --join=<all nodes> …`.
   Use `region=r1|r2|r3` and `zone=r1a|r1b|r2a|r2b|r3a`.
9. Initialise the cluster (`cockroach init`).

### 5.3 Apply the schema and the placement

1. On a generator VM, set `SUBSTRATE_URL` to a node in R1.
2. Make the tables and the seed rows. Seed the slots of every process:
   `SUBSTRATE_MODE=setup SUBSTRATE_SLOTS=1024 npm run -s bench:substrate`.
3. Apply the placement and the cluster settings:
   `cockroach sql --url "$SUBSTRATE_URL" -f tools/bench/substrate/placement.crdb.sql`.
4. Optional, with 10 VMs or more: apply `placement-nonvoters.crdb.sql` also.
5. Wait until the replication is complete. The DB Console must show no under-replicated range.
6. Check the placement:
   - `SHOW ZONE CONFIGURATIONS;` must show the values of the placement files.
   - `SHOW RANGES FROM TABLE account_head WITH DETAILS;` must show the leaseholders in R1.
   Do not start a run until both checks pass.

### 5.4 Run the matrix

Each row is a run of 600 s with 120 s of warm-up, unless the row says something different.
Do each row 3 times. Use a different `SUBSTRATE_SEED` each time.
Set `SUBSTRATE_TOPOLOGY` to the same text for all rows on one cluster.
With two generator processes, give each one half of the slots and half of the rate:

```sh
# On the r1a generator
SUBSTRATE_SLOT_FIRST=0   SUBSTRATE_SLOT_COUNT=512 SUBSTRATE_RATE=3584 SUBSTRATE_DB_METRICS=1 SUBSTRATE_PROCESS=g-r1a \
SUBSTRATE_SLOTS=1024 SUBSTRATE_LABEL=M1-steady SUBSTRATE_TOPOLOGY="2+2+1 <cloud> <regions>" \
SUBSTRATE_DURATION_S=600 SUBSTRATE_WARMUP_S=120 SUBSTRATE_OUT=M1-steady-g-r1a.json npm run -s bench:substrate
# On the r1b generator: the same, with SUBSTRATE_SLOT_FIRST=512, SUBSTRATE_DB_METRICS=0, SUBSTRATE_PROCESS=g-r1b
```

| Row | What to change | What it answers | §22.1 row |
|---|---|---|---|
| M1 steady | 1,024 slots; rate for 1.05 to 1.15 partitions per batch | Cost per transaction; statements per vCPU-second; commit p50, p99, p99.9; restarts and aborts | Cost; commit latency; pushes |
| M2 rate sweep | Rate × 0.5, 1, 1.5, 2, 3 of M1 | The rate where latency or cost rises; the cost at a higher occupancy | Cost |
| M3 statement mode | M1 with `SUBSTRATE_STMT_MODE=multi-row` | How much fewer statements save | Cost (lever) |
| M4 slot count | The M1 rate on 256, 1,024 and 4,096 slots | The trade-off of R24: fuller batches against more transactions (RFC-006 §19.2) | Cost; account step |
| M5 hot slot | `SUBSTRATE_SLOT_COUNT=1`, rate from 20 to 200 a second | Commit time of an always-busy lane (§4.3: about 30 ms) | Commit latency at the hottest-link rate |
| M6 topology states | M1 in each state: (a) steady; (b) the nodes of `r1a` stopped; (c) R1 isolated, leases in R2, generators in R2; (d) the R1–R2 path with added delay | Commit latency for each state | Commit latency in every topology state |
| M7 connections | Processes or `SUBSTRATE_POOL_SIZE` until about 420 active connections for each node | p99 commit with many connections | Active connections per node |
| M8 markers | M1 with `SUBSTRATE_MARKER_EVERY=8` | Cost of the `owner_slot` marker update in the batch | Cost |
| M9 node kill | M1; stop one R1 node 300 s after the start | The stall in the `timeline`; the time until the commits come back | Range-lease failover (one sample) |
| M10 non-voters | M1 after `placement-nonvoters.crdb.sql` | The replication cost of the non-voters | Cost |

Merge the files of each run (§4). Then read the summary.

### 5.5 YugabyteDB (SP3 comparison)

1. Make a YugabyteDB cluster on the same VMs: 5 tablet servers, placement `cloud.r1.r1a` … `cloud.r3.r3a`,
   replication factor 5, one replica in each zone, preferred leaders in `r1a` and `r1b`
   (`yb-admin modify_placement_info` and `set_preferred_zones`).
2. Set `SUBSTRATE_FLAVOUR=yugabyte` and `SUBSTRATE_URL` to a YSQL endpoint in R1. Run setup.
3. Run M1, M2 and M6. The generator reads no cluster metrics on YugabyteDB. Read the CPU of the tablet
   servers from the monitoring of the VMs over the same window.

### 5.6 Remove the cluster

Stop the generators. Copy the result files. Then delete all VMs, disks and network rules.

## 6. Where to record the results

1. Put the result files in `docs/04-delivery/evaluations/SP1a/<date>-<topology>/`. Keep each process file
   and the merged file. Add the RTT matrix, the VM types and vCPU counts, and the database version.
2. Write an evaluation record `docs/04-delivery/evaluations/E-00n-substrate-cost.md`. Use the layout of
   E-001. Give one table with a line for each matrix row: commit p50, p99, p99.9; cost per transaction;
   statements per vCPU-second; restarts and aborts for each transaction; partitions per batch.
3. State the decisions of S-PLAT-SP1 in the record: account slot count, slots per process, the second
   account lane, and database nodes per facility. If the cost is outside 1,000 ± 25 % statements per
   vCPU-second, raise a requirements issue against RFC-006 §19.2 (RK28).

## 7. Development

- Unit tests: `npm run test:bench`. Type check: `npm run typecheck:bench`.
- The tests control the time with a manual clock and use seeded generators (engineering.md §5).
- `src/sql.ts` holds every statement that is different between the two databases.
