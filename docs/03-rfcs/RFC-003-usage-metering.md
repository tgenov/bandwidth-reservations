# RFC-003. Metering and rating pay-per-use traffic

| | |
|---|---|
| **Status** | Implemented (prototype), in `billing/`. Known defects, fixes pending: see [Risks and open issues](#risks-and-open-issues), items 13 and 14 |
| **Satisfies** | [P3 spec](../02-specs/P3-usage-metering.feature): P3-S01 – P3-S27. Verified by tests: S01, S02, S04, S06, S08, S10, S11, S12, S14, S15, S17 – S21, S23, S26. Designed for but not yet tested: S03, S05, S07, S09, S13, S16, S22, S24, S25, S27. S22 is a known defect in code (see [admission-check defect](#modules-and-transport)) |
| **Decisions** | [D10](../history/decision-log.md#d10-record-facts-first), [D12](../history/decision-log.md#d12-built-and-checked-against-postgres), [D15](../history/decision-log.md#d15-separate-the-mechanism-from-the-policy), [D18](../history/decision-log.md#d18-metering-facts-raw-flow-records-from-a-source-assumed-reliable), [D19](../history/decision-log.md#d19-late-usage-correct-the-wallet-with-appended-entries-bound-the-exposure), [D20](../history/decision-log.md#d20-revenue-split-one-double-entry-path-for-every-charge) (price by usage time), [D25](../history/decision-log.md#d25-split-the-minutes-total-never-the-correction-amount), [D26](../history/decision-log.md#d26-billing-a-minute-takes-a-lock), [D27](../history/decision-log.md#d27-corrections-to-d19s-exposure-bound), [D28](../history/decision-log.md#d28-usage-belongs-to-the-minute-in-which-the-flow-ended), [D29](../history/decision-log.md#d29-results-of-the-problems-34-prototype-nestjs-kafka-via-redpanda) |
| **Problem** | [P3](../01-discovery/P3-usage-metering.md) |
| **Depends on** | [RFC-004](RFC-004-wallet-and-settlement.md) for the ledger, the wallet balance and the split function |

## Need

Share bills pay-per-use traffic against a prepaid wallet with no commits. Usage arrives as
flow records some time after the traffic, possibly more than once and in any order. The
bill has to be exact, independent of delivery order, reproducible from the raw data, and
never rewritten after the fact. Because usage is always reported late, real-time prepaid
billing is impossible: a customer can always owe more than has been charged. The business
needs that amount bounded and visible, and needs the choice between "cut off at zero" and
"allow a negative balance" to be a setting, not a code change (D15, D19).

## Approach

### Boundary with RFC-004

| This RFC (P3) owns | RFC-004 (P4) owns |
|---|---|
| `flow_records`, `minute_charges` | `journals`, `entries`, `payment_events` |
| Reading `rates` to price a minute; re-rating after a price correction | The split function (`domain/split.ts`, D'Hondt) and `rate_splits` weights |
| Computing each minute's **target** (customer debit and split) and posting the difference from what is already posted | `LedgerService.post`: one balanced, append-only journal; the balance triggers |
| Exposure, the suspend/resume decision, `suspensions`, the admission rule `canAdmit` | Wallet balances, top-ups from payment webhooks, payouts, clawback netting |
| `flow-records` consumption; `customer.suspend` / `customer.resume` emission | `wallet.balance` request-reply, `POST /webhooks/payments`, `GET /wallets/:id` |

Rating calls into P4 through two interfaces only: `split(total, parties)` and
`LedgerService.post(client, journal)` inside rating's own transaction. Exposure reads the
wallet balance through `LedgerService.balance`. Wallet top-ups call back into
`ExposureService.check` so that a top-up can lift a suspension.

### Data model (`billing/schema.sql`)

Money is integer micros (10⁻⁶ of the currency unit) held as `bigint`; there are no floats.

| Table | Role | Key | Mutability |
|---|---|---|---|
| `reservations(id, customer_id, route_id, reserved_mbps)` | The rate cap that bounds exposure. Intended as a billing-side copy of what P1/P2 admitted | `id` | **No writer today.** Nothing on the reservation side populates it; only billing's test harness inserts rows. The feed is proposed as `booking.confirmed` ([C28](../04-delivery/contracts.md#c28-bookingconfirmed-reservations-to-billing), increment [I8](../04-delivery/plan.md#i8-reservations-meet-billing)) |
| `rates(id, route_id, effective_from, version, price_micros_per_gb)` | Effective-dated prices. A later `effective_from` is a price change; a higher `version` at the same `effective_from` corrects a wrong price | `UNIQUE (route_id, effective_from, version)` | Append only by convention |
| `flow_records(exporter_id, sequence, reservation_id, bytes, event_time, received_at)` | Raw metering facts. `event_time` is the router's flow **end** time; `received_at` is arrival | `PRIMARY KEY (exporter_id, sequence)`; index on `(reservation_id, event_time)` | Append only: trigger `flow_records_append_only` rejects `UPDATE` and `DELETE` |
| `minute_charges(reservation_id, minute, rated_at)` | One row per (reservation, minute) once that minute has been charged. A "rated" marker and lock target; it holds **no amounts** | `PRIMARY KEY (reservation_id, minute)` | Insert once |
| `suspensions(customer_id, reason, suspended_at)` | At most one active suspension per customer, so each transition is emitted **at most** once (see Exposure) | `customer_id` | Inserted on suspend, deleted on resume, in autocommit |

Amounts live only in P4's ledger. Each journal posted by rating carries `kind` (`charge`
for the first posting of a minute, `correction` for every later one), `reservation_id` and
`minute`, so the ledger can be summed per (reservation, minute).

### Modules and transport

One NestJS hybrid process (`main.ts`): HTTP and a Kafka microservice share one DI container.

| Module | Contents | Role in P3 |
|---|---|---|
| `MeteringModule` | `MeteringController` | Consumes `flow-records` with `@EventPattern` |
| `RatingModule` | `RatingService`, `RatesService` | Ingest, minute lock, rating, re-rating, price lookup |
| `ExposureModule` | `ExposureService`, `BILLING_EVENTS` publisher | Exposure, suspend/resume, admission rule; producer-only `ClientKafka` |
| `LedgerModule`, `WalletModule` | P4 | Ledger posting and balances; `WalletRpcController` hosts the `billing.admission-check` reply, which delegates to `ExposureService.canAdmit` (defective over Kafka; see below) |

Kafka consumption (`main.ts`):

- Consumer group `KAFKA_GROUP_ID` (Nest appends `-server`), `subscribe.fromBeginning:
  true`: a new group starts at the oldest record, because skipping records is lost revenue
  and re-reading is harmless.
- `connectMicroservice(..., { inheritAppConfig: true })`, so the global
  `ValidationPipe({ transform: true, whitelist: true })` validates Kafka payloads too.
- The handler is fire-and-forget: the router expects no answer. Nest awaits the handler
  before kafkajs commits the offset, so a crash mid-handler means redelivery. That is safe
  because ingest is idempotent.
- Producers should key messages by exporter so that one exporter's records stay on one
  partition (the end-to-end test does this; ordering is not relied on for correctness).

Message on `flow-records` (`FlowRecordDto`):

| Field | Type | Validation |
|---|---|---|
| `exporterId` | string | non-empty |
| `sequence` | integer | ≥ 0 |
| `reservationId` | string | non-empty |
| `bytes` | integer | ≥ 0 |
| `eventTime` | ISO 8601 string, converted to `Date` | valid date |

Unknown fields are stripped (`whitelist: true`), not rejected.

Events and replies emitted:

| Topic | Pattern | Payload | When |
|---|---|---|---|
| `customer.suspend` | `emit`, fire-and-forget, null key | `{ customerId, available }` (micros as a string) | Available headroom falls to ≤ 0 and no suspension is active |
| `customer.resume` | `emit`, fire-and-forget, null key | `{ customerId, available }` | Headroom is > 0 and a suspension was active |
| `billing.admission-check` → `.reply` | `@MessagePattern`, request-reply | request `{ customerId, routeId, reservedMbps }`; reply `{ allowed, availableMicros }` | Intended for the reservation side to ask before admitting. **Known defect: fails on every request** (below). Nothing calls it today |

Services emit through the `EventPublisher` port (`BILLING_EVENTS`), not `ClientKafka`
directly, so tests replace it with an in-memory publisher.

**Known defect: `billing.admission-check` fails on every Kafka request.** In
`AdmissionQueryDto` (`billing/src/wallet/payment-event.dto.ts`), `reservedMbps` carries
only `@Type(() => Number)`, a class-transformer decorator, and no class-validator
decorator. The global pipe's `whitelist: true` strips every property without a validator,
so the handler receives `{ customerId, routeId }` and `canAdmit` throws on
`BigInt(undefined)`. Every request gets an error reply. `canAdmit` itself is correct and
tested in-process (P3-S21); the Kafka path (P3-S22) is untested and broken. The fix
(`@IsInt() @Min(1)` and a Kafka test) is pending in
[C25](../04-delivery/contracts.md#c25-billingadmission-check-request-reply), increment [I5](../04-delivery/plan.md#i5-billing-edge-hardening).

### Ingest (`RatingService.ingest`), one transaction per record

`READ COMMITTED` (D12, D26): the lock-then-read step relies on each statement taking a
fresh snapshot. `Db.tx` issues a plain `BEGIN`, so this is the Postgres default, not a
level the code sets.

1. `minute = floor(event_time to the minute)`. Usage belongs to the minute in which the
   flow **ended** (D28). Minutes are half-open, `[m, m + 1 min)`.
2. `INSERT INTO flow_records … ON CONFLICT DO NOTHING`. Zero rows inserted means a
   duplicate: return `duplicate` and do nothing else (D18).
3. Take the minute lock: `pg_advisory_xact_lock(hashtextextended(reservation_id || '|' ||
   minute, 0))`. The lock is held until the transaction ends.
4. `SELECT 1 FROM minute_charges WHERE (reservation_id, minute)`. If not charged yet,
   return `pending`: the record waits for the minute to be rated.
5. Otherwise the minute is already charged, so re-rate it now (below) and return
   `corrected`. After commit, run the exposure check for the reservation's customer.

The lock must be taken **before** step 4 (D26). Without it, a rater could sum the minute
while this insert is still uncommitted, mark the minute charged, and this record would
never be charged. The forced-interleaving test showed exactly that: 1 GB unbilled.

### Rating a minute

**Closing minutes, `rateUpTo(watermark)`.** Select every (reservation, minute) that has
records, has fully passed the watermark (`minute + 1 min ≤ watermark`) and has no
`minute_charges` row. For each, in its own transaction: take the minute lock, `INSERT INTO
minute_charges … ON CONFLICT DO NOTHING`; if that inserted nothing, another rater got there
first, so skip; otherwise rate the minute. After the loop, run the exposure check once per
touched reservation.

**`rateMinute(reservation, minute)`**, always under the minute lock:

1. `bytes = SUM(flow_records.bytes)` for the reservation with `event_time` in
   `[minute, minute + 1 min)`.
2. `rate = RatesService.rateAt(route, minute)`: the row with the latest `effective_from ≤
   minute`, and among those the highest `version`. The price is taken **as of the minute,
   not of arrival** (D20), so a late record is priced as if it had arrived on time.
3. `total = round_half_up(bytes × price_micros_per_gb / 10⁹)`, computed once from the
   minute's total bytes.
4. `target = split(total, rate.parties)` (P4), plus `wallet:<customer> = −total`.
5. `posted` = the sum per account of all entries already posted for this (reservation,
   minute).
6. Post one journal of `target − posted` per account, with `kind = charge` if nothing was
   posted before, else `correction`. Zero lines are dropped; if every line is zero no
   journal is written.

Because the target is recomputed from the **total** and only the difference is posted,
every account ends at `split(total)` whatever order the records arrived in, and earlier
charges are never edited (D19, D25). With duplicates removed by ID, late records can only
add bytes, so corrections from late usage only ever debit the wallet more (D19).

**Re-rating, `rerate(route, from, to)`.** After a price correction (a new `version` at an
existing `effective_from`), every charged minute of that route in `[from, to)` is re-rated
under its lock by the same `rateMinute`, posting a correction for the difference. This is
how overcharges are corrected; the effect on already-paid suppliers is RFC-004's clawback.
Nothing calls `rerate` automatically: a caller must invoke it after entering a corrected
price. **Defect:** unlike `ingest` and `rateUpTo`, `rerate` does not run the exposure
check after posting its corrections, so a correction that changes a customer's headroom
does not suspend or resume them until the next check. The fix is in [I5](../04-delivery/plan.md#i5-billing-edge-hardening).

### Exposure (`ExposureService`)

A reservation caps the customer's rate, so the most a customer can owe beyond what has been
charged is bounded (D19):

`exposure(reservation) = price_now × reserved_rate × (metering_lag + enforcement_lag)`

computed as `chargeMicros(reserved_mbps × 10⁶ × lag_s / 8 bytes, price)`. A customer's
exposure is the sum over their reservations.

**Corrected lag (D27).** Metering lag is not just transport delay. It must cover every delay
before usage is charged: the one-minute billing bucket, the wait for the watermark to pass
the minute, and transport. Otherwise the bound is too low. Configuration (`billing.config.ts`):

| Setting | Default | Meaning |
|---|---|---|
| `METERING_LAG_SECONDS` | 180 | Bucket + watermark grace + transport |
| `ENFORCEMENT_LAG_SECONDS` | 60 | From the suspend event to traffic actually stopping |
| `EXPOSURE_POLICY` | `reserve` | `reserve` or `credit_limit` |
| `CREDIT_LIMIT_MICROS` | 0 | Used by `credit_limit` |

Example: 2,000 Mbps × 240 s = 60 GB; at 10,000 micros per GB that is 600,000 micros.

**Policy (D15, D19).** The mechanism is fixed; the risk choice is configuration:

| Policy | Available headroom | Meaning |
|---|---|---|
| `reserve` (terminate at zero) | `balance − exposure` | Suspend while the wallet still covers the worst case, so the balance never ends below zero. In effect sets aside the exposure, which may conflict with "no upfront payment" |
| `credit_limit` (leeway) | `balance + limit` | Suspend at `−limit`; the worst-case loss per customer is about `limit + exposure` |

**`check(customer)`** runs after every newly rated minute (`rateUpTo`), after every
correction from late usage (`ingest`), and after every top-up (from P4). It does **not**
run after corrections posted by `rerate` (a defect; see above). If `available ≤ 0`, insert
into `suspensions … ON CONFLICT DO NOTHING`; if a row was inserted, emit
`customer.suspend`. Otherwise delete the suspension; if one was deleted, emit
`customer.resume`. Usage during the lag window is still charged after suspension.

Delivery of these events is weaker than the `suspensions` table suggests (see
[C26](../04-delivery/contracts.md#c26-customersuspend-and-customerresume-events)):

- **At most once.** The `suspensions` row is written in autocommit, before the emit. If
  the process dies or the broker rejects the send in between, the row records the
  transition and every later `check` returns `unchanged`: the event is lost for good.
- **Unordered.** Events are emitted with a null key, on two separate topics, with no
  version or timestamp, so a consumer cannot order a suspend against a resume for the
  same customer.
- **No per-customer lock.** `check` runs outside any transaction and takes no lock, so
  two concurrent checks for one customer can read different standings and emit
  interleaved transitions.

An outbox written in the same transaction as the `suspensions` change, with a
per-customer lock in `check`, is proposed in [I5](../04-delivery/plan.md#i5-billing-edge-hardening) (producer side) and
[C30](../04-delivery/contracts.md#c30-enforcement-of-suspend-and-resume) (consumer side).

**`canAdmit(customer, route, reserved_mbps)`** applies the same rule with the new
reservation's exposure added, and allows it only if `available > 0`.

Whether a `customer.resume` event actually restores traffic is a business policy (D27):
billing emits the event; the consumer decides.

## Benefits

Measured on the prototype (local Docker: Postgres 17, Redpanda 24.2), from D29:

- **Order doesn't matter:** duplicated, shuffled and late records produce the same final
  ledger as delivery in order (3 random seeds; 200 records each, 30% delivered twice, more
  than 20 corrections per run).
- **The books balance:** every journal and the whole ledger sum to zero; database triggers
  enforce this, and that the ledger and the facts are append-only.
- **Pricing:** late records are priced at the rate in force at their usage time.
- **End to end through Kafka:** 3,000 records with about 20% duplicates produce one charge
  per minute and a balanced ledger. (The test checks that exactly 3,000 records are stored
  and that the total charged equals the sum of per-minute charges; it does not count
  journals.)
- **Throughput:** about 800 records a second, **with one transaction per record**. This is
  sequential and unbatched; batching is the obvious next step. The throughput test logs the
  rate but asserts nothing about it. A run on 2026-10-11 logged 780 records/s for direct
  ingestion and 526 deliveries/s through Kafka; the Kafka figure includes consumer start-up
  and the test's 100 ms polling, so it is a lower bound.
- **The tests catch deliberate mistakes:** pricing by arrival time, splitting each
  correction separately, removing the minute lock, and largest-remainder rounding.

Structural benefits:

- Every charge can be recomputed from `flow_records` and `rates` (D10, D18).
- No past charge is ever modified; each amendment is a separate `correction` journal tied to
  its (reservation, minute).
- Each customer's worst-case debt beyond charges is a number the business can read and tune.

## Competition

| Alternative | Why it lost |
|---|---|
| **Sampled export (sFlow, sampled NetFlow)** instead of 1:1 | Sampling gives an estimate, not a bill a customer can check. 1:1 export costs router CPU (D18); that cost is accepted, and how routers produce the data is out of scope |
| **Cumulative interface counters (gNMI)** | Tolerate loss and duplicates by design, but they are per port, not per flow or reservation, and reset when a router reboots. Not needed once the source is assumed reliable (D18) |
| **Editing a charge when late usage arrives** | Rewrites a bill already shown or paid out; loses the history of why it changed. Corrections are appended instead (D19) |
| **Pricing by arrival (processing) time** | A late record would be priced differently from an on-time one, so the bill would depend on delivery timing. Pricing is by usage time (D20); a test catches the mistake (D29) |
| **Posting each late record's own amount as the correction** | Rounding per correction makes balances depend on arrival order. The minute's total is recomputed and the difference posted (D25) |
| **Assigning a flow to the minute it started, or spreading it across the minutes it was active** | The log records only the decision to use the end minute (D28): it is the time the record carries and the time it can first be known. Spreading a long flow is left open; assigning to the start minute was not separately evaluated |
| **Rating without a minute lock** | A record inserted while its minute is being rated is never charged (D26); a test showed 1 GB unbilled |
| **`REPEATABLE READ` or stricter isolation** | The snapshot would predate the lock wait, so the "is it rated?" check reads stale data. The design is correct only under `READ COMMITTED` (D12, D26) |
| **Real-time prepaid deduction** | Impossible: usage is known only after the fact (D19). The exposure bound replaces it |
| **Terminate at zero vs credit limit** | Not an engineering choice. Both are implemented; the business picks (D15, D19) |

## Risks and open issues

1. **Ingestion throughput.** One transaction per record caps the prototype at about 800
   records/s. Share reports 45 TB/day, about 520 MB/s, or about 4.2 Gbps on average. At 800
   records/s the prototype keeps up only if the average record carries at least about
   650 KB today, or about 33 MB at 50 times the scale (about 26 GB/s). Unsampled flow
   records are typically far smaller than that (*Inferred*), so ingestion must be batched:
   one multi-row `INSERT … ON CONFLICT DO NOTHING RETURNING` per Kafka batch, with minute
   locks taken in sorted order to avoid deadlocks. Partitioning `flow_records` by time,
   and possibly aggregating per (reservation, minute) before Postgres, are the next steps.
2. **Rating scans.** `rateUpTo` filters on `date_trunc('minute', event_time)` with a
   `NOT EXISTS` against `minute_charges`; there is no index on that expression, and the
   scan grows with the table. At ×50 it needs an index or a per-minute work queue.
3. **Nothing drives the watermark.** `rateUpTo(watermark)` is called only by tests. A
   production scheduler must choose the watermark, typically `now − grace`, and the grace
   must be included in `METERING_LAG_SECONDS` (D27).
4. **Auto-resume after top-up is policy (D27).** Billing emits `customer.resume`; whether
   enforcement restores traffic automatically is undecided.
5. **Price increases in the exposure window (D27).** Exposure uses today's price, so a
   price rise during the window is not covered.
6. **Price changes inside a minute.** A minute is priced at the rate in force at its start,
   so a change at 12:20:30 applies from 12:21. Prices should change only on minute
   boundaries, or this should be accepted explicitly (P3-S09).
7. **Long flows (D28).** All of a long flow's bytes land in its end minute. That can exceed
   what the reserved rate allows in one minute, and makes per-minute exposure lumpy.
8. **Malformed and unknown records (P3-S24, P3-S25).** The `ValidationPipe` rejects a
   malformed payload before `ingest` runs, so nothing is stored. A record for an unknown
   reservation fails the foreign key inside `ingest`. In both cases the handler fails.
   From reading Nest 11.2 and kafkajs 2.2 (*not tested*): the error is logged and
   propagates to kafkajs, the offset is not committed, and the same message is retried, so
   one bad record can stall its partition. A dead-letter topic (catch, publish the raw
   record and the reason, then return) is needed.
9. **Sequence wrap and exporter restarts.** NetFlow v9 and IPFIX sequence numbers are
   32-bit and may restart with the exporter. Over the life of the system,
   `(exporter_id, sequence)` can repeat, and a genuine new record would be dropped as a
   duplicate. The key needs an epoch, for example the exporter's boot time or observation
   domain plus export time.
10. **Exposure counts every reservation.** `reservations` has no end time, so ended
    reservations keep adding exposure. Exposure should cover active reservations only.
11. **Exposure is checked only when billing changes.** A customer who sends nothing new is
    not re-checked when a price changes.
12. **Untested scenarios.** S03, S05, S07, S09, S13, S16, S22, S24, S25 and S27 are designed
    for but have no test yet. S22 is also broken in code (the admission-check defect
    above).
13. **Known defects, fixes pending ([I5](../04-delivery/plan.md#i5-billing-edge-hardening)).** `billing.admission-check` fails on every
    request; `rerate` skips the exposure check; suspend/resume events are at most once,
    unordered and unlocked.
14. **Nothing populates billing's `reservations`.** Until `booking.confirmed` (C28, I8)
    exists, billing knows only reservations inserted by hand or by tests.
