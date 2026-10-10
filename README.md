# bandwidth-reservations

Admission control for partial-capacity bandwidth reservations on a link, built
algorithm-first and then ported to Postgres. Interview-prep sized.

## Design

**Facts.** `reservations` stores only accepted reservations:
`(link_id, start_time, end_time NULL = open-ended, reserved_mbps)`, half-open
`[start, end)`. Requests and rejections belong in a separate log; they must
never consume capacity.

**Impulses.** A reservation is a rectangular pulse `b·[H(t−s) − H(t−e)]`.
Usage is the superposition of pulses. Differentiate and each reservation is two
impulses, `+b` at `s` and `−b` at `e`; open-ended is only `+b`. Usage is the
prefix sum of the impulses.

**Admission** asks: is `max over t ∈ [s, e) of usage(t) + b ≤ capacity`?

**In memory** (`src/tree.ts`): a segment tree over the impulse array, each node
holding `{sum, maxpref}`:

    sum     = l.sum + r.sum
    maxpref = max(l.maxpref, l.sum + r.maxpref)

`peak(s, e) = prefix(0..s−1) + maxpref(delta[s..e−1])`. Check and booking are
both O(log N), independent of duration: a year-long booking is two point
updates, with no lazy propagation. Rejections name the conflicting sub-ranges in
O(k log N).

**In Postgres** (`src/sql.ts`): one READ COMMITTED transaction:

1. `SELECT … FROM links WHERE id = $1 FOR UPDATE`: the link row is the mutex
   for its schedule, and every writer must take it first.
2. Compute the peak over `[s, e)` from the facts with a running
   `SUM(delta) OVER (ORDER BY t)` over the impulses of overlapping facts only.
   The peak is the usage at `s` or at a change point inside `(s, e)`.
3. Insert if it fits.

READ COMMITTED matters: statements after the lock take a fresh snapshot and see
the previous holder's insert. Under REPEATABLE READ the snapshot is taken at the
locking `SELECT`, so the check would read stale facts.

## Results (local, Docker, 50 concurrent clients on one hot link)

| | p50 | p99 | peak / capacity |
|---|---|---|---|
| SQL, link lock | ~25 ms | ~115 ms | 100 / 100 |
| SQL, no lock (`admitUnsafe`) | — | — | ~370–390 / 100: oversold |
| In-memory tree, one-year minute domain | ~1 µs | ~3 µs | — |

The tests check tree, SQL and a brute-force per-minute array against each other
on random seeded sequences, and every decision agrees.

## Problem 2: routes across several links (D13-D17)

A route is a chain of links, possibly owned by different providers. One of them
(`src/partner.ts`) is a simulated partner system: it can't join our
transactions, ignores our priority tickets, and fails, times out or is slow at
random (seeded).

- **Holds** (`src/links.ts`, D14). Each link has two trees: confirmed only, and
  confirmed plus held. A request is held if it fits, rejected with the exact
  conflicting minutes if it misses even on confirmed capacity, and otherwise
  waits on our side (D16).
- **Saga** (`src/routes.ts`, D13). The partner leg is held first, then our links,
  busiest first. At the commit point, our holds are pinned and `committing` is
  recorded. The partner is then confirmed with retries on the same key, and
  every leg is written as a fact in one transaction. A failure before the
  commit point releases every hold; hold expiry is the backstop.
- **Priority tickets** (D17). Each ticket is the saga's start time, ties broken
  by id. An older request revokes ("wounds") younger, unpinned holds in its way;
  a younger request waits. A wounded saga restarts and keeps its ticket.
- **Idempotency.** The same key returns the same saga's result. Reusing a key
  for a different request is an error.
- **Recovery** (`recover`). It rebuilds the link books from the facts and the
  saga log. A saga caught in `holding` fails, and its holds expire. A saga
  caught in `committing` rolls forward.

Measured (local, 60 concurrent routes over 6 links, partner 10% errors and 10%
timeouts; numbers vary between runs because timing affects interleaving):

| | Result |
|---|---|
| Oversold (in memory, sampled every 1 ms; and from the facts) | never |
| Rejected while the capacity was actually free (D16) | never |
| Sagas finishing with a definite answer | 60 of 60, per seed |
| Saga latency | p50 35-80 ms, p99 120-160 ms |
| Restarts per saga | at most 4-7 |
| Crossed sagas, with tickets | resolved in about 20 ms by one wound |
| Crossed sagas, without tickets | deadlocked until the 1,000 ms hold expiry |

Checking the tests catch real mistakes: switching "wait" to "reject with retry"
fails the D16 check, and turning off tickets makes the crossed-saga test wait
out the hold expiry.

## Problems 3 and 4: metering, billing and the wallet ledger (D18-D20)

A NestJS service in `billing/`, with its own package. It turns raw flow records
into per-minute charges and posts them to a double-entry ledger that splits each
charge between the route's suppliers and Share.

- **Facts (D18):** `flow_records` holds raw records, unique by
  `(exporter_id, sequence)` and append-only. Kafka delivers at least once;
  `INSERT … ON CONFLICT DO NOTHING` removes duplicates.
- **Rating (D19):** a minute is charged once the watermark passes it. A record
  that arrives for an already-charged minute triggers a *correction*: a new
  journal for the difference, never an edit. Each minute's target is computed
  from its **total** bytes and split once, so every account ends at the same
  value whatever order the records arrived in.
- **Price by event time (D20):** rates are effective-dated, and a higher
  `version` at the same time corrects a wrong price. Late records use the rate
  of the minute they belong to.
- **Ledger (D20):** every charge, correction, top-up and payout is one journal
  whose signed entries sum to zero. A deferred constraint trigger checks this at
  `COMMIT`, and other triggers make the ledger and the facts append-only. Money
  is integer micros held as `bigint`.
- **Split rounding:** D'Hondt, not largest remainder. Largest remainder suffers
  the Alabama paradox: a larger total can *lower* one party's share, so ordinary
  late usage would claw money back from a supplier. D'Hondt never lowers a
  share when the total rises.
- **Clawback:** a price correction re-rates past minutes. A supplier already paid
  can go negative; the payout run skips negative balances and nets them against
  later earnings.
- **Exposure (D19):** `price × reserved rate × (metering lag + enforcement lag)`.
  Under the `reserve` policy, available = balance − exposure. Under
  `credit_limit`, available = balance + limit. At or below zero, a
  `customer.suspend` event is emitted once; a top-up that restores headroom
  emits `customer.resume`.
- **Payments:** webhooks are idempotent by `(provider transaction id, type)`. A
  reversal that overtakes its completion posts first; the result is the same.

### Transports

| Entry point | Pattern | Why |
|---|---|---|
| `flow-records` topic, `@EventPattern` | Fire-and-forget, at-least-once | The router needs no answer; ingestion is idempotent |
| `wallet.balance`, `billing.admission-check` topics, `@MessagePattern` | Request-reply (Nest replies on `<topic>.reply`) | The caller can't continue without the answer |
| `customer.suspend` / `customer.resume`, `ClientKafka.emit` | Fire-and-forget | Enforcement acts on it; billing doesn't wait |
| `POST /webhooks/payments`, `GET /wallets/:id` | HTTP | The payment provider calls us |

### Results (local Docker: Postgres 17, Redpanda 24.2)

- **23 tests pass.** They cover:
  - shuffled, duplicated and late delivery give the same ledger as in-order
    delivery (3 seeds × 200 records);
  - every journal balances and the ledger sums to zero;
  - a late record is priced at its own minute's rate after a price change;
  - clawback netted at the next payout;
  - webhooks applied exactly once;
  - both exposure policies;
  - Kafka end to end: 3,000 records plus about 20% duplicates in, one charge per
    minute out, a request-reply round trip and a suspend event out.
- **Ingest throughput:** about 700–860 records/s directly and about 800/s through
  Kafka. This is sequential, one transaction per record; batching is the
  obvious next step.
- **The tests catch deliberate mistakes:**

  | Deliberate mistake | Caught by |
  |---|---|
  | Pricing by arrival time instead of event time | The event-time test |
  | Splitting each correction separately instead of the minute's total | The order-independence test |
  | Removing the minute lock in ingestion | The forced-interleaving test: one GB went uncharged |
  | Largest remainder instead of D'Hondt | The Alabama-paradox test |

### Run

    docker compose up -d --wait      # postgres on 55432, redpanda on 59092
    docker compose exec postgres psql -U postgres -c 'CREATE DATABASE billing'
    cd billing && npm install && npm test

## Known limitations

- **One mutex per link.** All bookings on a hot link wait in one queue, so
  throughput is about 1 / transaction time per link. Options: lock time slots
  or change-point segments in key order (contention only where windows
  overlap), or a single in-memory owner per link (the tree) with Postgres as
  the fact log, fenced by a per-link sequence or lease epoch.
- **The peak query scans facts overlapping the window:** O(m) per admit. A
  persisted change-point table would make it O(log m + k).
- **Multi-link paths.** A path touches several links. In Postgres that is one
  transaction locking links in id order. With per-link in-memory owners it
  needs holds then confirmation (saga or two-phase commit).
- Fixed capacity per link. Supply changes would be facts with the same shape
  and the opposite sign.

## Run

    docker compose up -d --wait   # postgres:17 on localhost:55432
    npm install
    npm test
