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
