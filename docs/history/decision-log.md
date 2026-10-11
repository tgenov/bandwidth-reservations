# Decision log: bandwidth reservation admission

How the design in this repo was reached, in the order the decisions were made.

The design came out of a mock Postgres interview. The requirements in D1–D4 are the
mock interviewer's assumptions about a bandwidth marketplace, not confirmed facts about
any real system. "Raised by" records who made each move: **Todor** (candidate) or
**Claude** (interviewer / reviewer).

## Assumed requirements

| Requirement     | Value                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Unit sold       | Partial capacity on a link (e.g. 2 Gbps of 10 Gbps) for a time window                                                              |
| Time resolution | Minute; windows may be open-ended until cancelled                                                                                  |
| Admission API   | Synchronous confirm/reject, p99 ≤ 200 ms                                                                                           |
| Load            | ~500 requests/s globally, heavily skewed to a few hot links                                                                        |
| Overselling     | Never                                                                                                                              |
| Ordering        | No strict first-come-first-served; confirmed reservations are never revoked; rejections carry a correct reason; no request starves |

---

## D1. Time is discrete

- **Raised by:** Todor asked whether timeslots are discrete or continuous.
- **Answer:** windows start and end at any minute.
- **Decision:** treat time as a discrete domain of minutes. Todor's observation: "minute
  granularity — that's discrete already."
- **Consequence:** unreserved time can be given concrete, addressable positions. Every
  later structure depends on this.

## D2. Ask for the latency budget before designing

- **Raised by:** Todor asked whether there is a budget for acknowledging the reservation.
- **Answer:** synchronous, p99 ≤ 200 ms, skewed load (see the requirements table).
- **Consequence:** admission is request-reply, not fire-and-forget, because the buyer
  needs a confirmed or rejected answer. Hot links become the main performance risk.

## D3. Pessimistic concurrency control

- **Raised by:** Todor: "Since over-selling is not an option this leans on pessimistic
  locking."
- **Refinement (Claude):** no overselling is a correctness requirement that optimistic
  concurrency or `SERIALIZABLE` with retries would also meet. The real reason for
  pessimistic locking is **contention**: on a hot link, optimistic transactions keep
  conflicting and retrying, which wrecks the tail latency.
- **Decision:** pessimistic locking, justified by contention.

## D4. Ordering is not a requirement

- **Raised by:** Todor asked whether first-come-first-served is guaranteed, or whether
  non-determinism is acceptable.
- **Answer:** no strict FCFS (see the requirements table).
- **Correction (Claude):** the query planner doesn't decide which transaction gets a lock
  first. The real ordering problem happens before the database: load balancers, app
  instances and connection pools all reorder requests.
- **Consequence:** a per-link sequencer is not _required_ for ordering. It stays available
  as a throughput option (D9).

## D5. Lock the link row as a schedule mutex

- **Raised by:** Todor, who proposed locking the link and the time range, then locking the
  link ID together with its joined reservations.
- **Refinement (Claude):**
  - Locking the parent row is enough, as long as **every** writer locks it first:
    admissions, cancellations and capacity changes.
  - Locking the joined reservations adds cost without adding safety.
  - Locking the parent also handles phantoms: a new reservation can't appear without the
    link lock.
- **Decision:** `SELECT … FROM links WHERE id = $1 FOR UPDATE` as the baseline.
- **Accepted cost:** all admissions on a link run one at a time. This was measured in D12.

## D6. The check must use peak concurrent usage

Three candidate checks were considered.

| Candidate                                     | Raised by | Problem                                                                                                    |
| --------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| Find a gap between existing reservations      | Todor     | Assumes each reservation takes the whole link; partial reservations overlap legitimately                   |
| Sum every reservation overlapping the window  | Todor     | Gives an upper bound, not the peak: safe, but rejects requests that fit, and gives wrong rejection reasons |
| Peak total usage at any instant in the window | Claude    | Correct                                                                                                    |

- **Counter-example for summing:** C = 10, A = 8 [14:00, 14:30), B = 8 [15:00, 16:00).
  A request for 2 over [14:00, 16:00) sums to 18 and is rejected, but the peak is 8, so it
  fits.
- **Decision:** admit when `peak usage over [s, e) + b ≤ C`. Intervals are half-open; this
  rules out `BETWEEN`, which includes both ends.

## D7. Slot ledger considered, rejected for long bookings

- **Proposed by Claude:** one row per (link, time slot) holding the reserved total.
  - Reservations lock their slot rows in time order, which prevents deadlocks.
  - A `CHECK (reserved <= capacity)` constraint enforces no overselling.
- **Challenge (Todor):** "10,800 rows in 200 ms is peanuts. The challenge is that if you
  book for a year, that's 700k rows." (It's ~525k at minute resolution; the point stands.)
- **Alternatives considered:**
  - a two-tier model: slots for the near term, a step function of commitments for the
    long term;
  - a hierarchical segment tree of slot rows. This one moves all contention to the upper
    levels of the tree.
- **Status:** superseded by D8.

## D8. Algorithm first, persistence second

- **Raised by:** Todor asked: "Does this really need to execute in SQL? … Postgres is an
  unnecessary constraint here."
- **Decision (Todor):**
  1. Model the time domain as a data structure whose read and write complexity meets the
     budget.
  2. Prove it in memory.
  3. Only then solve persistence by porting it.
- **Why:** keeping the algorithm, concurrency and persistence as separate problems stops
  the storage engine's constraints from shaping the algorithm.

## D9. Candidate structures

N = minutes in the horizon, m = reservations on the link, k = segments touched.

| Structure                               | Admit                                          | Space | Note                                                |
| --------------------------------------- | ---------------------------------------------- | ----- | --------------------------------------------------- |
| Per-minute array                        | O(L), where L is the request length in minutes | O(N)  | Used as the test oracle                             |
| Reservation list + sweep                | O(m log m)                                     | O(m)  | Cheapest to write, slowest to read                  |
| Change-point map                        | O(log m + k)                                   | O(m)  | Ports best to SQL: locks only overlapping segments  |
| Segment tree with range-add / range-max | O(log N)                                       | O(N)  | Fastest in memory, but every write updates the root |

**Porting insight (Claude):** the best structure in memory is the worst one to port. In
memory, one thread owns the tree, so updating the root on every write costs nothing. In
SQL, the root becomes a row every transaction locks, which rebuilds the link mutex from D5.
There are two ways to port: persist the facts and keep the tree in memory (a single owner
per link, with fencing), or use the change-point map as the SQL structure.

## D10. Record facts first

- **Raised by:** Todor proposed recording facts first: `(link_id, start_time,
end_time (NULL = open-ended), requested_capacity)`.
- **Clarification:** "requested" makes this a request, which is a **command** that can be
  rejected. A reservation is an **event**: it has already happened.
- **Decision:** the facts table stores accepted reservations only. Requests and rejections
  belong in a separate log, so that rejected requests can never consume capacity.
- **Proposed by Claude, deferred:**
  - make the facts immutable and record cancellations as new facts;
  - store `recorded_at` alongside the reservation period;
  - use `tstzrange` instead of a nullable end;
  - add a per-link `seq` that doubles as a fencing token;
  - store supply as facts too.
- **Implemented:** `reservations(link_id, start_time, end_time NULL, reserved_mbps,
recorded_at)`.

## D11. Reservations as superposed pulses

- **Raised by:** Todor: "Mathematically we can model overlapping reservations as amplitudes… if we model
  start_end, N… and compute the additive interference patterns."
- **Formalised:**
  - A reservation is a rectangular pulse, `b·[H(t − s) − H(t − e)]`, and usage is the
    superposition of all pulses.
  - The derivative of each pulse is a pair of impulses: `+b` at `s` and `−b` at `e`.
    Usage is the running total (prefix sum) of the impulses.
  - The admit check asks for a maximum, which is not linear, so frequency-domain methods
    don't help. The derivative representation does.
- **Decision:** a segment tree over the impulse array, with nodes
  `{sum, maxpref = max(l.maxpref, l.sum + r.maxpref)}`. This gives:
  - Booking is two **point** updates, not a range update, so no lazy propagation.
  - The check is O(log N) whatever the booking length.
  - An open-ended booking is a single `+b` impulse, which removes the horizon problem from
    D7.
  - The facts map one-to-one onto impulses, so SQL computes usage directly with
    `SUM(delta) OVER (ORDER BY t)`.

## D12. Built and checked against Postgres

- **Implementation:** TypeScript with `pg`, Postgres 17 in Docker. The SQL path locks the
  link row (D5) and computes the peak from the facts with the window-function query (D11).
- **Three-way random test:** the tree, the SQL path and a per-minute array oracle agree on
  every decision (8 seeds × 150 requests).
- **Boundary checks:** deliberately introduced off-by-one errors were caught in both the
  tree and the SQL.

| Run (50 concurrent clients, one hot link) | Peak / capacity          | p50     | p99      |
| ----------------------------------------- | ------------------------ | ------- | -------- |
| SQL with the link lock                    | 100 / 100                | 24.6 ms | 115.5 ms |
| SQL without the lock                      | **373 / 100** (oversold) | —       | —        |
| In-memory tree, one-year minute domain    | —                        | 1.2 µs  | 3.1 µs   |

- **Isolation finding:** the check is correct only under `READ COMMITTED`. Under
  `REPEATABLE READ`, the snapshot is taken when the first statement starts, which is before
  the transaction waits for the lock. After the lock is acquired, the check reads stale
  reservations and oversells.

## D13. Multi-link paths: saga with compensation, not global atomicity

- **Context:** a route such as Nairobi → Mombasa → Djibouti → Marseille is a chain of links
  owned by different providers. Some of those links may be managed in partner systems that
  can't take part in our transactions.
- **Raised by:** Todor: "Compensation… it's an eventually consistent system. If this requires
  global consistency I wouldn't budget 200 ms for it. Even a minute seems reasonable!"
- **Decision:**
  - Reserve the links one at a time as a saga; if any step fails, compensate by releasing
    the links already reserved.
  - A whole route gets its own latency promise of up to about a minute. The 200 ms promise
    applies only to a single link.
- **Why:** global atomicity across systems we don't own would need distributed locking or
  two-phase commit with partners, which isn't available and doesn't fit the latency budget.
  Setting up the connection on the network takes minutes anyway (Problem 5 in
  `company-profile.md`).
- **Still to decide:**
  - whether holds count against capacity while the saga runs;
  - how failed compensation is retried, and an expiry on each hold as a backstop;
  - the order in which links are reserved;
  - the request states the customer sees, and idempotency keys for clients.

## D14. Holds count against capacity; contending requests wait instead of being rejected

- **Context:** route R1's saga holds capacity on a link, and request R2 needs the same
  capacity.
- **Raised by:** Todor. If R2 is rejected because of R1's hold and R1 then fails, R2 was
  rejected for nothing. Answering asynchronously lets R2 be served when R1's hold is
  released.
- **Decision:** holds count against capacity, so no link is sold twice. A request that only
  conflicts with _held_ capacity waits for those holds to resolve; it is not rejected.
- **Mechanism (Claude):** two trees per link, one counting confirmed reservations and one
  counting confirmed plus held. Each request then has three outcomes:

  | Check                                            | Outcome                                  |
  | ------------------------------------------------ | ---------------------------------------- |
  | Fits with confirmed and held capacity counted    | Admit                                    |
  | Doesn't fit with only confirmed capacity counted | Reject, with an accurate reason          |
  | Fits only if some holds are released             | Wait, then re-check when a hold resolves |

- **Bounds:**
  - A request waits at most until the hold expires (about a minute, D13).
  - Waiting requests are processed in arrival order on each link, so none starves (D4).
- **Still to decide:** what happens when a single-link request, promised 200 ms, runs into
  a hold.

## D15. Separate the mechanism from the policy

- **Raised by:** Todor: "None of these are technical questions. They are business
  policy… What are we optimizing for?"
- **Context:** D14 left open what a single-link request (promised 200 ms) should do when it
  runs into a route's hold. Waiting, answering "pending" or rejecting with "retry after"
  are each a business choice.
- **Decision:**
  - The system implements the **mechanism**: the three outcomes from D14, computed
    deterministically.
  - What happens in the "fits only if holds are released" case is a **policy** the business
    can configure and change without changing the mechanism.
- **Candidate objectives** (to be ranked by the business, not by engineering):
  - **Never oversell:** a fixed constraint every policy must respect, not an objective to
    trade off.
  - **Sell as much capacity as possible:** favours waiting over rejecting.
  - **Fast, definite answers for buyers:** favours rejecting with a retry-after time.
  - **Value of the request:** favours priority rules, such as a route's hold beating a
    single-link request.
- **Open:** the ranking itself, which is a question for the business. The prototype needs a
  default.

## D16. Guarantee: competing requests never all lose

- **Raised by:** Todor: "Reject with retry doesn't guarantee the client retries…
  opportunity lost. You WANT to ensure that if two people are competing for the same link
  at least one of them walks away with a reservation!"
- **Guarantee:** when requests compete for the same capacity, at least one of them ends up
  with a reservation, as long as the capacity remains.
- **Consequences:**
  - "Reject with retry after" is ruled out as the default. If the rejected client doesn't
    retry and the hold is then released, the capacity goes unsold.
  - Default policy for D15: a server-side **pending order**. A request that conflicts only
    with holds waits on our side.
    - The client gets "pending" within 200 ms.
    - When the hold resolves, the request is re-checked automatically.
    - The client learns the result through a webhook, or by polling with its idempotency
      key.
- **Still to check:** whether two _route_ sagas can each hold a link the other needs, wait
  on each other, and both time out. That would break the guarantee.

## D17. Deadlocks between route sagas: priority tickets based on start time

- **Context:** route R1 holds link X and waits for Y while R2 holds Y and waits for X. Both
  holds expire, nobody wins, and the D16 guarantee breaks.
- **Options:**
  - All sagas reserve links in one global order (e.g. by link ID).
  - Priority by age: in a collision the older saga wins and the younger releases and
    restarts.
- **Raised by:** Todor: "Roll the dice… another policy decision". In other words, either
  design is acceptable, so pick one and don't debate it further. Claude picked.
- **Decision:** priority by age.
  - Each saga is given a ticket, its start time, when it begins.
  - In a collision, the lower ticket wins. The loser releases its holds and restarts,
    keeping its original ticket.
- **Why this one:**
  - Every collision has exactly one winner, without the sagas needing to coordinate, so
    D16 holds.
  - A restarting saga keeps its ticket, so every request eventually becomes the oldest and
    wins. That satisfies D4's no-starvation requirement.
  - Links can be reserved in any order, which keeps D13's "reserve the link most likely to
    fail first".

## D18. Metering facts: raw flow records from a source assumed reliable

- **Raised by:** Todor: the facts are the raw billing data, i.e. NetFlow records. Exports
  can be 1:1 (unsampled) at some cost in router CPU.
- **Scope:** how the routers produce the data is out of scope. Assume a reliable source:
  - nothing is lost, and exports are 1:1;
  - every record has a unique ID (exporter plus sequence number, as in NetFlow v9 / IPFIX);
  - delivery is at-least-once, e.g. through Kafka.
- **Decision:**
  - Store raw flow records as immutable facts, deduplicated by ID.
  - Charges are derived from the facts and can always be recomputed (D10).
- **Considered:** cumulative interface counters (gNMI). They tolerate loss and duplicates
  by design, but they're only per port and reset when a router reboots. They're not needed
  once the source is assumed reliable.
- **What remains:** records arriving late, after the minute they belong to has already been
  charged.

## D19. Late usage: correct the wallet with appended entries; bound the exposure

- **Raised by:** Todor:
  - "You can't do real-time prepaid billing."
  - Late records amend the wallet, whether the original charge was too high or too low.
  - Whether to terminate at a zero balance or allow a negative one is a risk call.
- **Decision:**
  - Charges are never edited. Each correction is a new entry appended after the original,
    so the wallet is a history of entries.
  - With duplicates removed by ID (D18), late records can only reveal an _undercharge_.
    Overcharges come from other causes, such as pricing errors, and get correcting credits.
- **Refinement (Claude):** the reservation caps the customer's usage rate, so the most a
  customer can owe beyond what has been charged is a known quantity:

  `max exposure = price × reserved_rate × (metering lag + enforcement lag)`
  - **Metering lag:** how late records can arrive.
  - **Enforcement lag:** how long it takes to actually cut the customer's traffic.

- **Policy (D15), owned by the business:**
  - **Terminate at 0 with no risk:** set aside `max exposure` in the wallet when the
    reservation is admitted. This might conflict with Share's advertised "no upfront
    payments".
  - **Allow a negative balance:** a credit limit chosen by the business, with a known
    worst-case loss per customer.

## D20. Revenue split: one double-entry path for every charge

- **Raised by:** Todor: "I don't see late billing as any different to regular billing when
  it comes to splitting payouts."
- **Decision:** every charge, original or correction, becomes one balanced journal entry,
  produced by the same split function:
  - debit the customer wallet;
  - credit each supplier on the route;
  - credit Share's commission.
  - In every entry, debits equal credits.
- **Details that make "the same" hold (Claude):**
  - **Price by usage time.** Supplier rates and commission are looked up as of the usage
    time, not the processing time, so a late record is split exactly as it would have been
    if it had arrived on time.
  - **Clawback.** Correcting credits reverse the split. If a supplier has already been
    paid, their balance goes negative and is netted against their next payout. Late usage
    alone never causes this, because it only reveals undercharges (D19).
- **Out of scope:** how the split ratios are set, e.g. per link price or per distance. That
  is pricing policy (D15).

## D21. Sagas need a commit point (found while building)

- **Found by:** the implementation of D13. Compensation is only valid _before_ the saga
  decides to commit.
- **Failure without it:** a crash or a priority wound (D17) between confirming two links
  leaves a route partly booked.
- **Decision:**
  - A saga persists a `committing` decision. From that point its holds are **pinned**:
    they can't be wounded and don't expire.
  - Recovery after a crash **completes** committing sagas rather than undoing them.
- **Bug found:** requests waiting on a pinned hold were never woken when that hold was
  confirmed. Fixed: confirming a hold now wakes its waiters.

## D22. Correction to D17: partner links go first in a fixed order

- **Found by:** the implementation. D17 said links could be reserved in any order. That
  only holds when every participant respects priority tickets, and a partner system
  doesn't.
- **Failure:** an older saga waits on a younger saga's hold at the partner while the
  younger waits on the older's hold on one of our links. Neither can be wounded, so only
  hold expiry breaks the cycle.
- **Decision:**
  - Every saga reserves the partner link first.
  - The partner's confirmation is the saga's real commit point: our holds are pinned first,
    then the partner is confirmed, retrying with the same idempotency key.
  - The partner's hold must therefore last longer than our commit window.
  - With several partners, they need a fixed order among themselves.
- **Status:** this partly supersedes D13's "most likely to fail first", which still applies
  among our own links.

## D23. Results of the Problem 2 prototype

- **Tests:** 27 pass.
- **Correctness:**
  - never oversold, checked in memory and from the Postgres facts;
  - D16 holds: no request was rejected while its capacity was free;
  - every saga finished with a definite answer.
- **Saga latency:** p50 35–80 ms, p99 120–160 ms. This is well within the one-minute route
  promise (D13), with a partner that fails 10% of the time and times out another 10%.
- **Crossed sagas (D17):** about 20 ms with priority tickets, against a full 1,000 ms hold
  expiry without them.
- **The tests catch policy regressions:** switching "wait" to "reject with retry" fails the
  D16 test on 2 of 3 seeds.
- **Bug found:** a reused idempotency key with _different_ parameters returned the first
  request's result. Fixed: requests are now checked to match.
- **Still open:**
  - crash recovery fails sagas that are still holding instead of resuming them;
  - an older saga can wound more younger sagas than it needs to;
  - a busy partner can only be polled, so D16's server-side wait becomes a polling loop for
    that link.

## D24. Rounding the split: D'Hondt, not largest remainder (found while building)

- **Found by:** the implementation of D20. The build brief (from Claude) specified
  largest-remainder rounding.
- **Problem:** largest remainder has the _Alabama paradox_: a larger total can give one
  party a smaller share. Each minute's split is recomputed whenever late usage arrives, so
  ordinary late usage could take money back from a supplier. That contradicts D20's claim
  that late usage never causes clawback.
- **Decision:** D'Hondt rounding, which never lowers a share as the total grows.
- **Evidence:** a test built on a known instance of the paradox fails with largest
  remainder.

## D25. Split the minute's total, never the correction amount

- **Found by:** the implementation. Splitting each correction amount on its own made
  supplier balances depend on the order records arrived in.
- **Decision:** a correction is computed as the split of the minute's new total minus the
  split already posted. The final balances are then the same in whatever order records
  arrive.

## D26. Billing a minute takes a lock

- **Found by:** the implementation. Without a lock, a record inserted while its minute is
  being billed is never charged; the test showed 1 GB going unbilled.
- **Decision:**
  - Ingestion takes the minute's lock before checking whether that minute is already
    billed.
  - Like D12, this is correct only under `READ COMMITTED`.

## D27. Corrections to D19's exposure bound

- **Metering lag was understated.** It must include the one-minute billing period and the
  wait before a minute is billed, not just how late records arrive in transit. Otherwise
  the bound is too low.
- **Price changes aren't covered.** The bound uses today's price, so it doesn't cover a
  price increase during the exposure window.
- **Open, a business decision (D15):** what happens when a top-up arrives after a customer
  has been suspended. The prototype emits a resume event; whether to resume automatically
  is policy.

## D28. Usage belongs to the minute in which the flow ended

- **Gap in D18:** D18 didn't say which minute a flow record's bytes belong to.
- **Decision for the prototype:** assign them to the minute the flow ended.
- **Open:** spreading a long flow across the minutes it was active.

## D29. Results of the Problems 3/4 prototype (NestJS, Kafka via Redpanda)

- **Order doesn't matter:** duplicated, shuffled and late records produce the same final
  ledger as delivery in order (3 random seeds).
- **The books balance:** every journal entry, and the whole ledger, sums to zero. Database
  triggers enforce this, and also that the ledger and facts are append-only.
- **Pricing:** late records are priced at the rate in force at their usage time (D20).
- **Clawback:** a correcting credit takes money back from an already-paid supplier, and the
  next payout nets it off.
- **Payments:** webhooks arriving twice or out of order credit the wallet exactly once.
- **End to end through Kafka:** 3,000 records with about 20% duplicates produce one charge
  per minute and a balanced ledger.
- **Throughput:** about 800 records a second, with one transaction per record. Batching is
  the obvious next step.
- **The tests catch deliberate mistakes:** pricing by arrival time, splitting each
  correction separately, removing the minute lock, and largest-remainder rounding.

## D30. Review fixes: a restart after the commit point, and the horizon

- **Found by:** Claude's review of the Problem 2 code. Both bugs were reproduced with
  tests that failed before the fix.
- **Bug 1, a restart after the commit point could book links that were never held.**
  - **Cause:** a saga's status stayed `committing` after a restart caused by the partner
    hold expiring (`unknown-hold`). A crash while re-holding then made recovery roll the
    saga forward and write facts for every link in the request, including links never held
    again: a possible oversell.
  - **Fix:**
    - `restart()` sets the status back to `holding` _before_ releasing anything.
    - Writing facts requires every link to have a hold.
    - Recovery fails any `committing` saga with missing holds, logs it loudly and releases
      the orphaned holds. It never writes partial facts.
  - **Crash points:** each one in the saga was examined. The status reset and the
    inconsistent-status case are now tested. Three are covered by reasoning only:
    - after pinning but before `committing` is written;
    - during the transaction that writes the facts;
    - after `unknown-hold` but before the status reset.
- **Bug 2, bookings beyond the horizon were accepted unchecked.**
  - **Cause:** with `s ≥ n`, the peak came out as −∞, so the request was admitted, and its
    impulses were dropped.
  - **Fix:** the window must satisfy `0 ≤ s < n`, and either `s < e ≤ n` or `e = null`.
    Anything else raises a `RangeError`: it's a caller error, not a capacity rejection.
- **Side effect found:** a priority-ticket test was flaky when two tickets fell in the same
  millisecond. The saga ID, which breaks the tie, comes from two inserts that race, so
  either saga could correctly be the older. The test now asks the saga log which one is
  older and checks that it wins.
- **Still open from the review:**
  - The Problem 1 SQL path and the Problem 2 coordinator write facts under different locks.
    One owner per link with a fencing check (D10's per-link `seq`) is needed before they
    can coexist.
  - Wounding is broader than it needs to be (D23).
- **Tests:** 32 pass.

## Open questions

1. The hot-link mutex: the p99 of 115 ms is mostly lock queueing. Next, measure the
   change-point table (D9), which locks only overlapping segments.
2. Multi-link paths: atomic in one Postgres transaction. With an in-memory owner per link,
   they need tentative holds followed by confirmation.
3. The deferred fact-model items from D10.
