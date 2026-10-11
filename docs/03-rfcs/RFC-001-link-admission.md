# RFC-001. Link admission with an impulse segment tree and a link-row lock

| | |
|---|---|
| Status | Implemented (prototype) |
| Problem | [P1. Capacity admission on one link without overselling](../01-discovery/P1-link-admission.md) |
| Spec | [`P1-link-admission.feature`](../02-specs/P1-link-admission.feature) |
| Satisfies | P1-S01, P1-S02, P1-S03, P1-S04, P1-S05, P1-S06, P1-S07, P1-S08, P1-S10, P1-S11, P1-S12, P1-S13, P1-S14, P1-S15. Designed for but not asserted: P1-S09 (latency budget; measured within it). Not yet: P1-S16 (cancellation). |
| Decisions | D1, D2, D3, D4, D5, D6, D7, D8, D9, D10, D11, D12, D30 (horizon fix and the single-owner open item) |
| Code | `src/tree.ts`, `src/sql.ts`, `schema.sql`; tests in `test/tree.test.ts`, `test/sql.test.ts`, `test/concurrency.test.ts` |

## Need

A buyer asks for `b` Mbps on a link of capacity `C` over a window `[s, e)`, or from `s`
with no end. The system must answer confirm or reject synchronously (p99 ≤ 200 ms) under
about 500 requests/s skewed to a few hot links, must never oversell, must give a correct
reason when it rejects, and must treat malformed windows as errors (P1, success measures).

Three things make this harder than it looks:

- Reservations are partial and overlap, so "is there a free gap?" is the wrong question,
  and so is "do the overlapping reservations sum to more than the capacity?" The right
  question is the **peak** total usage at any instant in the window (D6).
- Bookings can be a year long or open-ended. Anything that costs one unit of work or
  storage per minute of the booking (about 525,600 for a year) does not fit the budget
  (D7).
- Concurrent requests on a hot link contend for the same capacity. The check and the
  write must be atomic per link, and the mechanism must not collapse into retry storms
  under contention (D3).

## Approach

The design was built algorithm first and persistence second (D8): first a data structure
whose read and write cost meets the budget, proved in memory against a brute-force
oracle, then ported to Postgres.

### 1. Time and windows

- Time is a discrete domain of minutes (D1). The in-memory structure covers a fixed
  horizon `[0, n)`; minute `t` is an index.
- Windows are half-open, `[s, e)` (D6). A booking ending at `t` and another starting at
  `t` do not overlap. SQL must therefore use `<` and `>`, never `BETWEEN`.
- `e = null` means open-ended. For admission it is checked against the rest of the
  horizon, `[s, n)`.

### 2. The model: pulses and impulses

A reservation of `b` over `[s, e)` is a rectangular pulse:

    usage_r(t) = b · [H(t − s) − H(t − e)]        H = unit step

Usage on the link is the superposition of every accepted pulse. Differentiate: each
pulse becomes two impulses, `+b` at `s` and `−b` at `e`. An open-ended reservation is a
single `+b` impulse at `s`. With the impulse array `delta`, usage is its running total:

    usage(t) = delta[0] + delta[1] + … + delta[t]

The admission rule is (D6):

    admit  ⇔  max over t ∈ [s, e) of usage(t)  +  b  ≤  C

A maximum is not linear, so frequency-domain methods do not help; the derivative
representation does (D11). It has two consequences that shape everything below:

- **A booking is two point updates**, whatever its length. Nothing is written per minute.
- **The stored facts map one-to-one onto impulses**, so the database can compute usage
  from the facts directly with a running sum.

### 3. In memory: segment tree over the impulses (`src/tree.ts`)

A segment tree over `delta[0..n)`, padded to the next power of two, stored as two flat
`Float64Array`s. Each node covers a range of minutes and stores:

| Field | Meaning |
|---|---|
| `sum` | Total of the impulses in the node's range |
| `maxpref` | Largest prefix sum of the impulses in the node's range, i.e. the highest usage reached inside the range relative to the usage just before it |

Leaf for minute `t`: `sum = maxpref = delta[t]`. The identity (empty range) is
`{sum: 0, maxpref: −∞}`. Combine a left child `l` and right child `r`:

    sum     = l.sum + r.sum
    maxpref = max(l.maxpref, l.sum + r.maxpref)

**Peak over a window.** For `t ∈ [s, e)`, `usage(t) = prefix(0..s−1) + (delta[s] + … + delta[t])`,
so:

    peak(s, e) = range(0, s).sum  +  range(s, e).maxpref

Both are O(log N) range queries, independent of `e − s`.

**Operations.**

| Operation | Implementation | Cost |
|---|---|---|
| `addImpulse(t, v)` | Update leaf `t`, recompute `sum` and `maxpref` up to the root. Impulses at `t ≥ n` are dropped; they cannot affect usage inside the horizon. | O(log N) |
| `add(s, e, b)` | `addImpulse(s, +b)`; if `e ≠ null`, `addImpulse(e, −b)`. A negative `b` removes a pulse. | O(log N) |
| `peak(s, e)` | Formula above | O(log N) |
| `usageAt(t)` | `range(0, t + 1).sum` | O(log N) |
| `conflicts(s, e, limit)` | Depth-first walk carrying `offset` (usage just before the node). Prune a node when it lies outside `[s, e)` or `offset + maxpref ≤ limit`; when descending right, add the left child's `sum` to `offset`. Collect leaf minutes, merge adjacent ones into half-open ranges. | O(k log N) for k conflicting minutes |
| `admit(s, e, b, C)` | `checkWindow`; `end = e ?? n`; if `peak(s, end) + b > C` return `{ok: false, peak, conflicts: conflicts(s, end, C − b)}`; else `add(s, e, b)` and return `{ok: true}`. | O(log N) to admit, O(k log N) to explain a rejection |

Because a booking is two point updates rather than a range update, no lazy propagation is
needed (D11). The tree is single-threaded: one owner per link applies admissions one at a
time, so the root being updated on every write costs nothing in memory (D9).

### 4. Horizon checks (D30)

`checkWindow(s, e, n)` runs before every admission and throws `RangeError` unless:

- `s` is an integer with `0 ≤ s < n`; and
- `e = null`, or `e` is an integer with `s < e ≤ n`.

A window that fails is a caller error, not a capacity rejection, and must be refused at
the API edge. Without the check, a request with `s ≥ n` produced `range(s, n).maxpref =
−∞`, so the peak was −∞ and the request was admitted; its impulses were then dropped as
beyond the horizon, so the booking was neither checked nor stored. Ending exactly at `n`,
or starting open-ended at `n − 1`, is valid.

### 5. Persistence in Postgres (`schema.sql`, `src/sql.ts`)

**Facts only (D10).** The `reservations` table records accepted reservations, which are
events that have happened. Requests are commands that can be rejected; they and their
rejections belong in a separate log, so a rejected request can never consume capacity.

```sql
CREATE TABLE links (
  id             bigint PRIMARY KEY,
  capacity_mbps  integer NOT NULL CHECK (capacity_mbps > 0)
);

CREATE TABLE reservations (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  link_id        bigint NOT NULL REFERENCES links,
  start_time     timestamptz NOT NULL,
  end_time       timestamptz,                       -- NULL = open-ended
  reserved_mbps  integer NOT NULL CHECK (reserved_mbps > 0),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time IS NULL OR end_time > start_time) -- half-open [start, end)
);

CREATE INDEX reservations_link_start ON reservations (link_id, start_time);
```

**Admission transaction**, under `READ COMMITTED`. The code issues a plain `BEGIN`, so it runs
at `READ COMMITTED` only because that is the Postgres default; the level is not pinned (see
Risks, "Isolation level is load-bearing"):

1. `BEGIN`.
2. `SELECT capacity_mbps FROM links WHERE id = $1 FOR UPDATE`. The link row is the mutex
   for the link's schedule (D5). It is sufficient on its own provided **every** writer to
   that link's schedule takes it first: admissions, cancellations and capacity changes.
   Locking the parent also rules out phantoms, because no reservation can be inserted
   without the lock. Locking the overlapping reservation rows as well adds cost and no
   safety.
3. Compute the peak over `[s, e)` with `PEAK_SQL` (below).
4. If `peak + b > capacity`: `ROLLBACK` and return `{ok: false, peak}`.
5. Otherwise `INSERT` the fact and `COMMIT`.

**Why `READ COMMITTED` and not `REPEATABLE READ` (D12).** Under `READ COMMITTED` each
statement takes a fresh snapshot, so the peak query in step 3, which runs after the lock
in step 2 has been granted, sees the reservation the previous lock holder just
committed. Under `REPEATABLE READ` the snapshot is taken when the first statement starts,
which is before the transaction waits for the lock. Once the lock is granted, the check
reads stale reservations and oversells. Because the link row itself is never modified,
Postgres raises no serialisation error to warn of this. The isolation level is part of
the correctness argument and must be pinned by the code, not left to a default. Today it
is left to the default; pinning it is a proposed change to
[C03](../04-delivery/contracts.md#c03-sql-admission), with a regression test in
[I4](../04-delivery/plan.md#i4-close-the-unverified-scenarios-with-tests).

**No idempotency.** `admit` takes no request key. A caller that retries after a lost
response, or after a timeout on a request that actually committed, books the reservation
a second time. This is a known gap: the single-link API
([C10](../04-delivery/contracts.md#c10-single-link-reservation-api), increment
[I9](../04-delivery/plan.md#i9-buyer-facing-api)) adds an idempotency key.

**The peak query.** Only facts that overlap the window contribute. Their impulses are
summed per change point, and a window function gives the running usage:

```sql
WITH overlapping AS (
  SELECT start_time, end_time, reserved_mbps
    FROM reservations
   WHERE link_id = $1
     AND ($3::timestamptz IS NULL OR start_time < $3)   -- starts before the window ends
     AND (end_time IS NULL OR end_time > $2)            -- ends after the window starts
), impulses AS (
  SELECT start_time AS t, reserved_mbps AS delta FROM overlapping
  UNION ALL
  SELECT end_time, -reserved_mbps FROM overlapping WHERE end_time IS NOT NULL
), points AS (
  SELECT t, SUM(delta) AS delta FROM impulses GROUP BY t
), running AS (
  SELECT t, SUM(delta) OVER (ORDER BY t) AS usage FROM points
)
SELECT GREATEST(
  COALESCE((SELECT usage FROM running WHERE t <= $2 ORDER BY t DESC LIMIT 1), 0),
  COALESCE((SELECT MAX(usage) FROM running
             WHERE t > $2 AND ($3::timestamptz IS NULL OR t < $3)), 0)
)::int AS peak
```

`$2` is `s`, `$3` is `e` or `NULL` for open-ended. Why it is correct:

- Every overlapping fact that starts at or before `s` is still active at `s` (its end is
  after `s`), so the running total at the last change point at or before `s` is the true
  usage at `s`. Facts that ended before `s`, or exactly at `s`, are not overlapping and
  contribute nothing: half-open intervals.
- Usage only changes at change points, so the peak over `[s, e)` is the larger of the
  usage at `s` and the usage at each change point strictly inside `(s, e)`.
- With `$3 = NULL` the window runs to the end of time, which is the open-ended case.

The same running-sum construction over **all** of a link's facts gives the invariant check
`maxUsage(link) ≤ capacity`, computed from the facts alone; the tests use it to detect
overselling.

**Two ports, one model (D9).** The best structure in memory is the worst one to persist
as is: in SQL the tree's root would be a row every transaction locks, which rebuilds the
link mutex with more rows. The prototype therefore keeps the tree in memory and, for the
SQL path, persists only the facts and recomputes the peak from them. The alternative port,
a single in-memory owner per link with Postgres as the fact log, is described under Risks.

### 6. Rejection reasons

| Path | A rejection returns |
|---|---|
| In memory | `peak` (highest usage already reserved in the window) and `conflicts`: every merged half-open sub-range where `usage > C − b` |
| Postgres | `peak` only |

## Benefits

Measured on the prototype (TypeScript with `pg`, Postgres 17 in Docker), as recorded in
D12:

| Run (50 concurrent clients, one hot link) | Peak / capacity | p50 | p99 |
|---|---|---|---|
| SQL with the link lock | 100 / 100 | 24.6 ms | 115.5 ms |
| SQL without the lock | **373 / 100** (oversold) | — | — |
| In-memory tree, one-year minute domain | — | 1.2 µs | 3.1 µs |

- **Never oversold.** With the link lock, 50 concurrent clients on one hot link filled it
  exactly to capacity and no further. The same load without the lock oversold it almost
  fourfold, which shows the lock is what provides the guarantee.
- **Within the latency budget.** p99 115.5 ms against a 200 ms budget on the SQL path under
  hot-link contention; microseconds in memory.
- **Correct decisions.** The tree, the SQL path and a per-minute array oracle agree on
  every decision (8 seeds × 150 requests). Deliberately introduced off-by-one errors were
  caught in both the tree and the SQL.
- **Cost independent of booking length.** A year-long or open-ended booking is one or two
  point updates in the tree and one row in the facts table, against about 525,600 slot
  rows for a year in a slot ledger.
- **Accepts what fits.** Using the peak rather than the sum of overlaps admits requests the
  sum would wrongly reject (the A/B example in D6), so suppliers sell more.
- **Precise reasons.** The in-memory path names every conflicting sub-range in
  O(k log N), so a buyer can pick a different window.
- **Auditable.** Decisions can be recomputed from the facts alone.

## Competition

| Alternative | Where considered | Why it lost |
|---|---|---|
| Find a free gap between existing reservations | D6 | Assumes each reservation takes the whole link. Partial reservations overlap legitimately, so it rejects requests that fit. |
| Sum every reservation overlapping the window (e.g. `SUM … WHERE … BETWEEN`) | D6 | An upper bound, not the peak: safe, but rejects requests that fit (C = 10, A = 8 [14:00, 14:30), B = 8 [15:00, 16:00): a request for 2 over [14:00, 16:00) sums to 18 but the peak is 8) and gives wrong reasons. `BETWEEN` is also inclusive at both ends, which breaks half-open intervals. |
| Slot ledger: one row per (link, minute) with `CHECK (reserved <= capacity)`, slots locked in time order | D7 | Deadlock-free and enforces the invariant in the database, but a year-long booking touches about 525,600 rows. Fine for short windows, not for long or open-ended ones. |
| Two-tier: slots for the near term, a step function of commitments for the long term | D7 | Two structures and a boundary between them to keep consistent. Superseded by the impulse model, which handles every length uniformly. |
| Hierarchical segment tree of slot rows in SQL | D7 | Moves all contention to the upper levels of the tree, every writer locks the root rows. |
| Per-minute array | D9 | O(L) per admission for a request of L minutes and O(N) space. Kept as the test oracle. |
| Reservation list plus sweep | D9 | Cheapest to write, O(m log m) to read. Too slow on busy links. |
| Change-point map / table | D9, Open question 1 | O(log m + k) and ports best to SQL, because it locks only the segments a window overlaps rather than the whole link. Not built; it is the next candidate if the link mutex becomes the bottleneck (see Risks). |
| Segment tree with range-add / range-max (lazy propagation) | D9, D11 | Same O(log N) but a booking is a range update needing lazy propagation. The impulse tree makes it two point updates instead. |
| Frequency-domain treatment of superposed pulses | D11 | The admission check is a maximum, which is not linear, so transforms do not help. |
| Optimistic concurrency, or `SERIALIZABLE` with retries | D3 | Also prevents overselling, but on a hot link transactions keep conflicting and retrying, which wrecks the tail latency. Pessimistic locking wins on contention, not on correctness. |
| Locking the link and the overlapping reservation rows | D5 | Adds cost without adding safety, given every writer locks the link row first. |
| `REPEATABLE READ` with the same lock | D12 | Oversells: the snapshot predates the lock wait, so the check reads stale reservations. |
| A per-link sequencer for request ordering | D4 | Strict ordering is not required, and requests are already reordered before the database. Kept only as a throughput option. |
| Storing requests (`requested_capacity`) as the facts | D10 | A request is a command that can be rejected; storing it as a fact risks rejected requests consuming capacity. Facts are accepted reservations only. |

## Risks and open issues

| Risk or issue | Detail | Mitigation or next step |
|---|---|---|
| **Hot-link mutex** | Every admission on a link runs one at a time behind the link row (D5). The p99 of 115 ms is mostly lock queueing, and per-link throughput is about one over the transaction time. A hotter link, or a slower transaction, breaks the 200 ms budget. | Measure a persisted change-point table that locks only overlapping segments (Open question 1). Alternatively the single in-memory owner per link (next row). |
| **Single owner per link, with fencing** | The P1 SQL path locks the link row; the P2 route coordinator writes facts under its own in-memory books. The two write facts under different locks, so they cannot both write to the same link today (D30). Moving the tree into a per-link owner process with Postgres as the fact log has the same requirement. | Exactly one writer per link, with a fencing check on every fact write: a per-link `seq` (D10) or lease epoch that a stale owner cannot pass. Required before the two paths coexist. |
| **Peak query cost** | `PEAK_SQL` scans every fact overlapping the window: O(m) per admission. Long-lived and open-ended facts overlap almost every window. | A persisted change-point table, O(log m + k). |
| **Deferred fact-model items** | Proposed in D10 and deferred (Open question 3): immutable facts with cancellations recorded as new facts; `recorded_at` alongside the reservation period for bitemporal queries (`recorded_at` exists, but nothing queries it); `tstzrange` instead of a nullable end; a per-link `seq` that doubles as the fencing token; supply recorded as facts too. | Decide before cancellation and capacity changes are built, since both change the fact model. |
| **Cancellation not implemented** | P1-S16 is unverified. The tree can remove a pulse (`add` with negative `b`) but there is no cancellation operation or test, and the SQL path has none. Any cancellation must take the link lock (D5). | Build as an appended cancellation fact (D10), taking the link lock. |
| **Capacity is fixed** | `links.capacity_mbps` is constant. A capacity change must take the link lock, and its interaction with "confirmed reservations are never revoked" is undecided. | Model supply as facts with the same shape and the opposite sign (D10). |
| **The two paths differ at the edges** | The horizon check (D30) exists only in the tree; the SQL path accepts any window with `end > start`, with open-ended meaning "forever" rather than "to the horizon". Only the tree names conflicting sub-ranges (P1-S12); the SQL path returns the peak alone. | Validate windows once at the API edge for both paths. Compute sub-ranges in SQL from the same running sum if the SQL path is kept. |
| **Isolation level is load-bearing** | The `REPEATABLE READ` oversell (D12) was found by experiment and is not covered by an automated test. The code does not set the level: `admit` issues a plain `BEGIN` and relies on the Postgres default. A pool, ORM or `default_transaction_isolation` setting that chose a stricter level would silently break correctness. | Set `READ COMMITTED` explicitly on the transaction and add a regression test (C03, I4). |
| **No idempotency on the SQL path** | `admit` has no request key, so a retried request books twice. | An idempotency key at the single-link API (C10, I9). |
| **Latency budget not asserted** | P1-S09: the concurrency test prints p50 and p99 but asserts no bound, so a regression would pass the suite. | Assert p99 against the budget, with headroom for test machines. |
| **Starvation** | No strict FCFS is required (D4), but no request may starve. Waiters on the link row are queued by Postgres's lock manager; this is not tested. | Measure the wait distribution under sustained hot-link load. |
