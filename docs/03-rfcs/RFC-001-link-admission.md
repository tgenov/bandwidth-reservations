# RFC-001. Link schedule and admission

| | |
|---|---|
| Status | Draft, revision 4 |
| Satisfies | P1-S01 … P1-S80 (every P1 scenario, 80). Link-side part only, the primary RFC being another (§13): P2-S02, S13, S14, S15, S16, S17, S18, S19, S20, S21, S43, S44, S45, S46, S47, S48, S52, S55, S56, S58, S59, S60, S61, S62, S73, S74, S79, S80, S81, S84, S85, S87, S88, S92, S93, S94, S95, S97, S101, S104, S106, S107, S110, S114, S116 (RFC-002); X1-S22, X1-S23 (RFC-005); X2-S03, X2-S05, X2-S06, X2-S15, X2-S23 (RFC-006). Also the link-side rows of P2-S112, X1-S13 and X1-S31, whose needs are not allocated to this RFC (§13) |
| Policies | POL-02, POL-04, POL-05, POL-06, POL-07, POL-08, POL-09, POL-10, POL-16, POL-19, POL-25, POL-26, POL-29, POL-30, POL-31, POL-32, POL-33 |
| Prior decisions | History log D1, D5, D6, D7, D9, D10, D11, D12, D14, D15, D17, D30 (carried forward or rejected in Competition); review 17's decisions D1 … D5 (accepted by the coordinator; D1 and D3 are in `requirements-v1.8`, D2 and D4 in RFC-000 revision 4.2) |
| Builds on | The requirements at tag `requirements-v1.8`, which decide this RFC's Requirements issues RQ-R1-1 … RQ-R1-12 ([review 11](../reviews/11-requirements-amendments-from-detailed-rfcs.md)), RQ-R1-13, RQ-R1-14 with RFC-002's B-RQ-9 ([review 12](../reviews/12-requirements-amendments-from-rfc-revision-2.md)), and review 17's RQ-17-1, RQ-17-2 with RFC-002's B-RQ-10 ([review 22](../reviews/22-requirements-amendments-from-c3-reviews.md)); [RFC-000](RFC-000-architecture.md) revision 4.2, whose components, ownership, principles A1 … A11, substrate (§5.5), contracts (§8) and allocation (§7) bind this RFC, whose "Revision 4 resolution" resolves AI-R1-1 … AI-R1-9, whose "Revision 4.1 errata" resolve AI-R1-10 … AI-R1-12 and whose "Revision 4.2 errata" resolve review 17's AI-17-1 … AI-17-6 |
| Revision | **Revision 4** (this): revised per [review 17](../reviews/17-rfc-001-review.md) (REJECT: R1-01 … R1-25) and rebased on `requirements-v1.8` and RFC-000 revision 4.2: capacity kept as **levels** (announced capacity and outage levels, capacity in force their minimum, §3.1); reductions decided against the announced capacity at `T_eff`, as **per-link cut targets** with the affected set fixed at `T_eff` (§5.4); capacity-lowering entries in a batch of their own with marker intents first (§5.1); `wait` decided at the link from the hold's new inputs (§4.1); attempts change only on a yield or an accepted displacement (§4.3); per-link `feed_seq` and state-message notifications (§7.1, §11.1); standbys fed by push and follower reads (§7.6); `W_l` in the latency figures (§9); see "Revision 4 resolution" at the end. Revision 3: rebased on `requirements-v1.7` and RFC-000 revision 4.1 (displacement read, per-slot batches, session plus slot leases, insert-only log tables). Revision 2: rebased on RFC-000 revision 4 (CockroachDB, NestJS owners, Kafka) and `requirements-v1.6`; see "Revision 2 changes". Revision 1: the first draft, on RFC-000 revision 3.2 and `requirements-v1.5` |
| Supersedes | The pre-baseline draft of this RFC (an impulse segment tree in memory, and a Postgres link-row lock as the authority) |

Terms are used in the sense of the [glossary](../02-specs/glossary.md): "reserved rate" is
capacity, "traffic" is bytes, and neither is called "usage". This RFC adds one internal
term, **occupancy** (§3.1), for the per-minute sum the schedule checks; it is never shown
to a buyer. Every latency, volume and size marked **est.** is an estimate, to be replaced
by the measurement of RFC-000's spike (R1), unless it is a requirement's own figure.

## Need

RFC-000 makes the **link schedule owner** the single writer of everything a Share link
has sold, holds or can carry (A1, POL-05), allocates P1-N1 … P1-N9 to it, with parts of
P2-N3, P2-N4, P2-N9, P2-N11, X1-N10, X2-N2 and X2-N3, and runs it, in revision 4, as the
**TypeScript/NestJS service instance holding the owner lease** of the link's slot, whose
log is an insert-only table in the two-region database (RFC-000 §5.2, §5.5). It also gives
this RFC the **link registry**, the link part of the catalogue. What that owner must do,
and why it is hard:

1. **Decide every capacity question on one link exactly** (P1-N1, P1-N2). A request fits
   if, at every minute of its window, the committed rate plus the capacity held for other
   requests plus its rate is within the capacity in force. Reservations are partial and
   overlap; windows last a minute, a year, or have no end (P1-N6); the check must cost the
   same whatever the length (X2-S05), and must say, on a rejection, the largest rate that
   fits and the earliest window that does, both beside the capacity held (P1-N4, POL-10).
   Concurrent requests are checked one at a time in the order they reach the link's
   schedule owner, each counting the capacity then held (POL-05, P1-S14, P1-S77): not the
   order their accounts received them, which no single component sees.
2. **Do it at the hottest link's rate** (POL-06: 2,500 requests/s, ×50 of today's load),
   inside the link's share of `ack_budget`: one two-region transaction, about 30 ms at
   p99, plus the link slot's batching wait `W_l` (about 20 ms on a shared link slot, 30 ms
   on the hottest link's dedicated slot, RFC-000 §3 revision 4.2), with
   every decision durable in two regions before it is answered (X2-N4), from one
   single-threaded TypeScript process.
3. **Hold, wait and yield under one priority rule** (P1-N3, POL-02, POL-05). Capacity held
   for a pending request counts against the link and is free once its non-confirmed
   outcome is reported; a request blocked only by capacity in flight waits within its
   deadline (or, with `wait = false`, is rejected at once with `retry_after`, the latest
   remaining deadline of the requests blocking it); released capacity goes to the oldest
   waiter it fits; a younger holder that is itself waiting yields; a holder that is not
   waiting is never pre-empted. Only the request's account owner may end a hold (A9), and
   a release is request-scoped and tombstoned (A0R-03).
4. **Take capacity changes without ever revoking silently** (P1-N8, POL-07): every change
   states a **level**, and the capacity in force at a minute is the lowest of the announced
   capacity and every open outage's level, whatever order the changes come in (POL-07
   *Capacity in force when changes overlap*, `requirements-v1.8`); unplanned
   outages that reduce what is sold from the minute they are recorded in, and flag every
   reservation at exactly the overcommitted minutes; every rise in sellable capacity
   (restorations, permanent increases, cancelled maintenance) effective from the first
   minute boundary at or after its record (P1-S76); maintenance only beside
   committed and held capacity; permanent reductions with notice, newest Mbps first, each
   part cut by the largest excess it meets over the **announced** capacity, never further
   because of an outage open at the notice's end (P1-S79); firm equivalent-path offers
   whose capacity is held and counted as committed. A request whose confirming transaction
   does not see the reduction's **displacement record** had begun committing, in POL-07's
   only sense of it, may complete, and is then affected and alerted; one whose confirming
   transaction sees it is decided against the reduced capacity (POL-07 as amended by B-RQ-9
   and B-RQ-10, P1-S63, P1-S78).
5. **Record only facts, and explain any past decision** (P1-N7, P1-N9, POL-19): the
   schedule as known at any past time, for 7 years.
6. **Survive crashes and owner changes** with no fact lost and no second writer: a new
   lease holder rebuilds the schedule in memory quickly enough that releases are durable
   within `release_grace` while the link fails over (P1-S62, P2-S107) and admission keeps
   its 1 min RTO.

## Approach

### 1. Scope, placement and principles

- **One partition per Share link**, hashed into a **slot**, the unit of owner leasing and
  moving (RFC-000 §5.2). The hottest links each have a slot, an owner instance and
  database ranges to themselves; every other Share link shares one of about **4,096 link
  slots**, sized so each slot's batch lane is about 0.15 occupied at the design load
  (RFC-000 revision 4.2, AI-17-5, est.). The link schedule owner **is** the NestJS instance
  that holds the slot's owner lease; its lease **epoch** is the term, and the link's
  **generation**, incremented by each move of the link to another slot, orders its writers
  with the epoch: every log row, head row, outbox header and outbound command carries
  (generation, epoch) (RFC-000 §5.2, AI-R6-3). Partner links have no schedule here: their
  partner adapter stands in for Share's position (RFC-002).
- The link's **log** is its rows in an insert-only log table (§7.1), appended by the
  slot's batch transactions, one in flight per slot and each carrying every link of the
  slot with entries pending, conditional on the slot's epoch (§7.2; RFC-000 revision 4.1,
  AI3-11). The owner is a **deterministic state
  machine over that log**: every decision (hold, refusal, waiter registration, grant,
  conversion, release, capacity change) is the effect of applying one log entry at its
  commit timestamp, and the entry records the outcome it had. The owner's memory is a
  cache of the log (RFC-000 §5.2): **hot standbys** tail the log and apply the same
  entries, so a new lease holder rebuilds nothing but the last seconds of the log (§8).
- This RFC follows RFC-000's principles literally: one writer (A1); facts appended,
  current state derived (A4); only the account owner ends a request's holds, and a release
  for an outcome is request-scoped with a tombstone (A9); deadlines are data, clocks drive
  liveness only (A8); pseudonymous principals in every row and topic, payloads encrypted
  (A11, RFC-005). Where this RFC needs something RFC-000's contracts do not name, it says
  so under Architecture issues.
- Mechanism and policy are separate (D15, the register's preamble): `priority_rule`,
  `selling_horizon`, `rate_min`, `release_grace`, `maintenance_notice`, `revocation_notice`,
  `affected_notice_time` are parameters, and the step budgets `counteroffer_steps`,
  `counteroffer_batch_steps`, `scan_steps` and `reduction_step_parts` are algorithm
  constants, all read from `Policy` entries in the log (§7.3), never constants in the
  structure.

### 2. Time and validity

**Minutes.** Time in the schedule is an integer **minute index** `m`, minutes since
1970-01-01T00:00Z (D1). A window `[s, e)` is a pair of minute indexes, half-open, or
`[s, ∞)` for an open-ended window. Back-to-back windows do not overlap (P1-S04).
`floor_minute(t)` is the minute boundary at or before `t`; `ceil_minute(t)` the first
minute boundary at or after `t`.

**State-machine time.** Every entry's timestamp `ts` is the **commit timestamp of the
batch transaction** that appended it, in the database's hybrid-logical clock (RFC-000
§4.3, §5.5): the owner reads it inside the transaction before deciding, so the decision is
made at exactly the time it is recorded at (§7.2). All entries of one batch share `ts` and
are ordered by sequence. `ts` is monotone within the link's log across owner changes and
within `ε` (the database's `max_offset`, 100 ms) of true time. The apply step reads `ts`,
never a clock, so every replay reaches the same state. `now_m = floor_minute(ts)`.

**Validity (P1-N5, POL-09, POL-31).** The same rules are evaluated by the account owner
at intake (RFC-002), which is where an invalid request is reported, and again by the link
owner on every hold as a defence. Both evaluate them **relative to the request's receipt
minute `m0`**, the minute boundary at or before the receipt time recorded at intake,
carried in every hold as its own input (RFC-000 §8 revision 4.2, AI-17-1), and with the
policy version recorded at intake, also carried. `m0` is not derived from `request_age`
(the intake entry's commit timestamp, the priority key of §4.3): a request received at
hh:mm:59.98 whose intake commits after the boundary is valid from hh:mm, at intake and here
alike. As POL-09 decides (RQ-R1-8), "now" is `m0`, and the horizon `H` is the same time of
day on the same UTC calendar date `selling_horizon` (12 calendar months) after `m0`, or on
the last day of that month if it has no such date:

| # | Rule | Fails, for example (P1-S19, P1-S74) |
|---|---|---|
| V1 | The rate is a whole number of Mbps, at least `rate_min` | 0, −1, 1.5 |
| V2 | `s` is a minute boundary; `e` is a minute boundary or open | now + 1 h 30 s |
| V3 | `e > s` | empty, backwards |
| V4 | `s ≥ m0` | now − 1 min |
| V5 | `s < H` | H; H + 5 min open-ended |
| V6 | `e ≤ H` for a window that has an end | H − 10 min to H + 10 min; received 10:00:20 on 31 March 2026, ending 10:01 on 31 March 2027 |

`[now, now + 1 h)`, `[H − 10 min, H)` and `[H − 1 min, ∞)` are valid (P1-S20); so are a
window received at 10:00:20 on 31 March 2026 ending at 10:00 on 31 March 2027, and one
received at 10:00:20 on 29 February 2028 ending at 10:00 on 28 February 2029 (P1-S74). A
rate above the link's capacity is valid and is a capacity answer (P1-S39). The deadline's
own bounds are RFC-002's (P2-S12).

### 3. Schedule state and structures

#### 3.1 Capacity levels and the occupancy model

A reservation leg of rate `b` over `[s, e)` is a rectangular pulse, and the schedule is
the superposition of pulses (D11). Its derivative is two **impulses**, `+b` at `s` and `−b`
at `e`; an open-ended pulse is the single impulse `+b` at `s`. The value at minute `t` is
the running sum of impulses up to and including `t`. A booking is therefore two point
updates whatever its length (X2-S05), and an open-ended booking occupies every later
minute, including minutes that later enter the horizon (P1-S21, P1-S22).

**Capacity is kept as levels, never as deltas** (POL-07 *Capacity in force when changes
overlap*, `requirements-v1.8`, RQ-17-1 decided; review 17 D1, R1-01). Revision 3 stored
every capacity change as a delta from a "current" capacity that already included open
outages, and the deltas did not compose: overlapping facts oversold silently, cut
permanently because of an outage, or refused valid supplier commands (review 17, R1-01
(a) … (d)). Every fact now records the level it states, in a small **capacity profile**:

| Fact | Level it states | Sellable effect from | Physical effect from |
|---|---|---|---|
| Registration (`Init`) | `C0`, the registered capacity | registration | registration |
| Permanent reduction (`announce_reduction`) | `c`, the new announced capacity | `floor_minute(ts)` | `T_eff` (§5.4) |
| Permanent increase (`record_increase`) | `c`, the new announced capacity | `b = ceil_minute(ts)` | `b` |
| Unplanned outage (`record_outage`) | `L`, the capacity the link carries while it lasts | `floor_minute(ts)` | `floor_minute(ts)` |
| Restoration (`record_restoration`), whole or to a level | the outage ends, or its level rises to `L'` | `b = ceil_minute(ts)` | `b` |

From the profile the owner derives, as step functions of the minute `t`:

- **Announced sellable capacity `A_s(t)`**: the level of the latest-recorded permanent
  fact (registration, reduction, increase) whose sellable effect is at or before `t`.
- **Announced physical capacity `A_p(t)`**: start from `C0` and apply the permanent facts
  in record order: a reduction to `c` sets `A_p(t) = c` for `t ≥ T_eff`; an increase to `c`
  sets `A_p(t) = max(A_p(t), c)` for `t ≥ b`. An increase *raises* (POL-07): during a
  reduction's notice the link still carries its old capacity, so an increase to a level
  between the reduced and the old capacity raises only what the link carries after
  `T_eff`.
- **Announced capacity `A_now`**: the level of the latest-recorded permanent fact. A
  reduction must state a level below it and an increase a level above it, **whatever an
  open outage's level** (POL-07: a reduction "judged against the announced capacity").
- **Capacity in force**, the glossary's term: sellable `K_s(t) = min(A_s(t), L_i(t) for
  every outage i open at t)` and physical `K_p(t) = min(A_p(t), L_i(t) …)`. New sales are
  decided against `K_s`; which reservations an outage affects, against `K_p` (§5.7); a
  permanent reduction's cut, against the announced capacity alone (§5.4).

`K_s` and `K_p` differ only during a reduction's notice: new sales stop at once at the
reduced capacity (P1-S43), while the link still carries its old capacity, so nothing is
affected before `T_eff` (P1-S44). Outages and increases act on both alike.

**Occupancies against a fixed reference.** Every occupancy is a sum of pulses compared
with a fixed **reference capacity** `C_ref = C0` (§10). Capacity enters the sales
occupancies as the **deficit** `C_ref − K_s(t)`, itself a sum of pulses (negative where an
increase lifts capacity above `C_ref`, which the signed arithmetic allows), so every sales
check stays "occupancy plus the request's rate is at most `C_ref`". The link keeps three
occupancies:

| Occupancy | Pulses it contains | Used for |
|---|---|---|
| `occ_firm(t)` | Confirmed leg parts; Share's offer parts (counted as committed, POL-07); maintenance bookings; the sellable deficit `C_ref − K_s(t)` | "Does it fit on committed capacity?" (no-fit rejections, P1-S37) |
| `occ_all(t)` | `occ_firm` plus every capacity hold | "Does it fit beside every hold?" (holds, grants, offer holds, maintenance, P1-S05) |
| `occ_commit(t)` | Confirmed parts, offer parts and maintenance, **without any capacity term**, minus cuts already decided but not yet applied (§5.4) | The committed rate: outage flags against `K_p` (§5.7) and a reduction's excess against its announced level (§5.4) |

The committed rate at a minute (glossary) is the confirmed parts plus the offer parts.
`K_p` is in no tree: it has a handful of pieces, and the flag projection evaluates
`occ_commit` against each piece (§5.7).

**Profile differencing.** Every capacity fact, and every activation of a pending one,
computes `K_s` before and after over the range it touches (both piecewise constant, with
about as many pieces as there are facts overlapping the range, in practice one to a few)
and adds the **difference** to `occ_firm` and `occ_all` as impulses at the piece
boundaries: `O(k log m)` for `k` pieces. So the trees and every query of §3.2 are the
same as in revision 3; only the impulses they receive are now exact for any order of
facts. The profile is a function of the log, recomputed identically by every replica.

Review 17's four cases, on P1's background (capacity 10; A and B 4 Mbps each, open-ended),
and the two `requirements-v1.8` scenarios:

| Case | Revision 3 (deltas) | Revision 4 (levels) |
|---|---|---|
| (a) Outage to 6 open; reduction to 4; outage restored before `T_eff` | Δ = 6 − 4 = 2: B never cut; 8 Mbps on 4, unflagged | Announced 4 at `T_eff`; excess 8 − 4 = 4: B revoked, A kept (§5.4) |
| (b) Outage to 6 open; reduction to 8 | Refused `INVALID` | Accepted: 8 < `A_now` = 10; `K_s` stays 6 until the restoration, then 8 |
| (c) Reduction to 6; outage to 9 open at `T_eff` | B cut by 3 | B cut by 2, the announced need; the outage flags nothing (6 ≤ 9) |
| (d) Outage to 6; increase to 15 | Sellable 15 while the link carries 6 | `K_s = min(15, 6) = 6` until the restoration, then 15 |
| P1-S79: reduction to 6 on day D; outage to 5 from D + 29, open at `T_eff` | — | B cut by 2 at `T_eff`; `occ_commit` 6 > `K_p` 5: A and B flagged while the outage lasts (from its record, at 8 > 5); after the restoration 6 ≤ 6, none |
| P1-S80: 6 committed; outage to 6; increase to 15 at 09:30:20; restoration at 09:40:00 | — | From 09:31 `K_s = min(15, 6) = 6`: 1 Mbps more is refused; from 09:40 `K_s = 15`: 9 Mbps for `[10:00, 11:00)` fit (15 − 6) |

**Effective boundaries** (POL-07 *Every rise in sellable capacity*; RQ-R1-13 decided in
`requirements-v1.7`; the glossary's *Time of day*, `requirements-v1.8`, RQ-17-2 decided:
"recorded at" is the record's commit timestamp, exactly, review 17 D3). One rule for every
change that **raises** capacity (a restoration, whole or partial, a permanent increase, a
cancelled maintenance booking): it is recorded at once and takes effect from
`b = ceil_minute(ts)`, the first minute boundary at or after its record. Until an entry
with `ts ≥ b`, decisions see the old capacity; from then they see the new one at every
minute `≥ b` (P1-S27, P1-S40, P1-S67, P1-S69, P1-S80). The owner keeps these as **pending
capacity effects** in a heap by `b`, outside the profile's active facts. The apply of
every entry starts by activating, in `b` order then log order, each pending effect with
`b ≤ ts` (profile differencing, then the waiter scan over its range); the recording entry
itself, once it has recorded the change, does the same, so a change recorded exactly on a
boundary (`ts = b`, whatever the hybrid-logical clock's logical part) takes effect in its
own entry, and every later command of the same batch and every later batch sees it
(P1-S76: recorded at 09:31:00, a 2 Mbps booking held from 09:31 is confirmed, in all three
rows). If no entry comes, the owner proposes a `Tick` at `b` (§7.3), so the waiter scan
runs on time. A change that **lowers** capacity is active at once: an outage from
`floor_minute(ts)` (the start of the minute it is recorded in), a permanent reduction's
sellable part from `floor_minute(ts)`. On a boundary both rules give the boundary itself.
Because `A_s` takes the latest-recorded fact in effect, an increase pending at `b` and a
reduction recorded after it in the same minute leave the reduction's level in force from
`b`: the later record wins.

#### 3.2 The occupancy tree

Each occupancy is an **augmented B+tree keyed by minute index** (fanout 32), holding only
minutes that carry a non-zero impulse; impulses at the same minute are summed into one
key. Every node stores, for the impulse sequence in its subtree:

| Field | Combine (left `l`, right `r`) |
|---|---|
| `sum` | `l.sum + r.sum` |
| `maxpref` (largest non-empty prefix sum) | `max(l.maxpref, l.sum + r.maxpref)` |
| `minpref` (smallest non-empty prefix sum) | `min(l.minpref, l.sum + r.minpref)` |

The empty sequence is `{0, −∞, +∞}`. This is the pre-baseline draft's monoid (D11), moved
from a dense array over a fixed horizon to a sparse ordered map, which removes the horizon
from the structure: keys are absolute minutes, the tree grows only with change points, and
rolling the horizon costs nothing (Competition). A scalar `carry` holds the sum of impulses
folded away by compaction (§7.6).

**In TypeScript.** The trees live in **typed-array arenas** (one `Float64Array` per field,
nodes addressed by index), outside the V8 heap the garbage collector scans, so a large
schedule causes no collection pauses (R1-10). Every value is an integer number of Mbps;
`Float64` represents integers exactly below 2^53, and no sum here exceeds about 10^12 (10 M
parts of at most 100,000 Mbps), so the arithmetic is exact integer arithmetic. No division,
rounding or `Math` function is used in the apply.

**Queries** (each `O(log m)` with `m` the number of keys, at most the number of distinct
minutes from compaction to the horizon, about 530,000, est.; four levels at fanout 32):

- `prefix(t)` = `carry` + the sum of keys `< t`.
- `value(t)` = `prefix(t + 1)`.
- `peak(s, e)` for `e` finite or `∞`: with `P = prefix(s)` and `Q` the aggregate over keys
  in `[s, e)`: `P + Q.maxpref` if there is a key at `s`, otherwise `P + max(0, Q.maxpref)`
  (the value at `s` is then `P`). An open-ended window queries `[s, ∞)` directly: no
  bound is needed.
- `first_above(t, θ)`: the least minute `x ≥ t` with `value(x) > θ`, by descending on
  `maxpref` with the running offset; `first_at_or_below(t, θ)` likewise on `minpref`;
  `last_above(θ)` descends preferring right children and returns the last minute whose
  value is above `θ`, or **"for ever"** if the value after the last key (the total sum,
  which holds for every later minute) is above `θ`. Each `O(log m)`.
- `conflicts(s, e, θ)`: the maximal minute ranges in `[s, e)` with value `> θ`, by
  alternating the two descents: `O(k log m)` for `k` ranges.

**Updates.** `add(s, e, b)` is two point updates, `+b` at `s` and, if `e` is finite, `−b`
at `e`; a key whose value becomes 0 is deleted. `O(log m)`.

**Generations.** Nodes carry a generation number and are copied on write only if an older
generation is pinned, otherwise mutated in place. Two things pin: a **batch in flight**,
whose speculative generation is discarded if its transaction does not commit (§7.2), and
a projection slice reading the state at a log position (§7.5). Each tree also keeps a
**change counter**, incremented by every update, which keys the counter-offer cache
(§4.2). (These tree generations are internal copies; they are unrelated to the link's
placement **generation** of §1.) The apply therefore pays
nothing extra while nothing is pinned, and a failed batch is undone by dropping its
generation, not by reloading.

Example (P1-S01): capacity 10, a confirmed 7 Mbps for `[10:00, 11:00)` gives keys
`{10:00: +7, 11:00: −7}`. A request for 3 Mbps over `[10:30, 11:30)`: `P = 7`, no key at
10:30, `Q` over `[10:30, 11:30)` is the single impulse `−7`, `maxpref = −7`, so the peak is
`7 + max(0, −7) = 7`, and `7 + 3 ≤ 10`: it fits. For 4 Mbps, `7 + 4 > 10`: no fit.

#### 3.3 Per-link state

All of it is the link owner's own (RFC-000 §2), derived by applying its log:

| State | Content | Index |
|---|---|---|
| Registry view | `C_ref`, supplier account, kind, probe flag, status, registry version (§10) | — |
| Policy | Parameter values and algorithm version in force, by log position | — |
| Capacity profile | Registration level, permanent facts (level, record `ts`, sellable and physical effect), outages (level, range, attribution, principal, reason reference, restorations) as levels (§3.1); derived `A_s`, `A_p`, `A_now`, `K_s`, `K_p` | By kind and effect minute |
| Occupancy trees | `occ_firm`, `occ_all`, `occ_commit` (§3.1, §3.2) | — |
| Leg parts | Per confirmed part: reservation, part id, leg, account, rate, window, **age** (the decision timestamp of the admission that added it, or the original age it keeps after a move, POL-07 step 6; ties by request identity), cause flags (reduced under POL-07) | By reservation; interval index by window; age order |
| Capacity holds | Per request: attempt, account, kind (booking, change), rate, window, `D`, commit fence `D_c` (§4.1), `request_age`, receipt minute, policy version, a digest of the command (for `MISMATCH`), waiting mark, displacement mark with the reduction that set it | By request; interval index; priority order |
| Waiters | Per request: attempt, rate, window, `D`, `D_c`, `request_age`, account, latest blocker deadline notified, yield claim (§4.3) | Priority order (`priority_rule`, ties by request identity, RFC-000 §4.5); interval index |
| Outstanding yield and displacement requests | (request, attempt) → the request or reduction they were raised for | — |
| Request records | Per request seen, until `D + release_grace`: its recorded state (held, waiting, refused with reason and counter-offer, converted, released) and the log sequence that recorded it; after that, the `link_request` row (§7.1) for 24 h | Map; heap by expiry |
| Tombstones | Per request or offer: expiry `D + release_grace` (offers: `lapse_at + release_grace`) | Map; heap by expiry |
| Offer holds | Per offer: reservation, account, its **offer parts** (part, rate, original age, window), lapse time, state (open, accepted with move minute) | By offer; interval index |
| Moving marks | Per reservation with an accepted move off this link: the move minute (§5.6) | By reservation |
| Sender fences | Per sending partition (account, offer's account): the highest (generation, epoch) applied (RFC-000 §5.2) | Map |
| Capacity history | Every capacity fact as recorded (the profile's facts, maintenance bookings and cancellations), and per permanent reduction: announcement, `T_eff`, announced level at `T_eff`, the adopted affected set, cut cursor, state (notice, effective, final) | By kind and time |
| Pending capacity effects | Restorations, increases and maintenance cancellations not yet at their boundary (§3.1) | Heap by boundary |
| Timers | Due notices, `T_eff`, offer lapses, deadlines for expiry requests, effective boundaries, request-record expiry | Heap by time |
| Stream counters | `feed_seq` of the schedule feed (in the head row, §7.1) | — |
| Projection checkpoints | The log position through which each projection's output has been written (§7.5) | — |

State lives in typed-array arenas where it is large (trees, parts, their indexes) and in
ordinary maps where it is small (holds, waiters, tombstones, offers). Every map is
iterated only in a stated order (§7.4).

#### 3.4 Invariants

- **I1. No oversell** (P1-N1). Every pulse that adds to `occ_all` (a hold, a grant, an
  offer hold, a maintenance booking) is added only if `occ_all + b ≤ C_ref` at every
  minute of its window after the addition, that is, if it fits the capacity in force
  `K_s` beside committed and held capacity. Every other entry removes occupancy, moves a
  pulse from hold to committed without changing `occ_all` (conversion, §4.4), or lowers
  `K_s` (an outage or a reduction). Hence at any position, a minute with
  `occ_all > C_ref` exists only where capacity was lowered after the pulses that now exceed
  it, and the excess is made of those earlier pulses (§5.1). Of those, the conversions of
  holds the reduction displaced are the POL-07 exception (requests whose confirming
  transaction did not see the displacement record, so had begun committing, B-RQ-9,
  B-RQ-10), each flagged affected and alerted.
- **I2. Fit is decided on the right occupancy.** A hold, grant or maintenance booking is
  granted only on `occ_all`; a no-fit refusal only on `occ_firm` (P1-S37, P2-S17).
- **I3. Holds outlive no outcome.** A hold or a grant is removed only by a release, an
  accepted yield or an accepted displacement from the request's account owner (A9), or by
  its conversion. A **waiter** (which holds nothing) may also be refused by the link
  itself, for no fit (§4.3, §5.1), as RFC-000 §3 allows. Any hold or grant for a
  tombstoned request, or at `ts ≥ D_c`, is refused (RFC-000 §8 port invariants;
  `D_c < D`).
- **I4. Facts only** (P1-N7). The committed occupancy is exactly the confirmed parts, the
  offer parts and the maintenance bookings, less the decided cuts; capacity is exactly the
  recorded levels; a request's pulses are in `occ_all` only while it is held.
- **I5. Determinism.** The state after entry `p`, and the outcome recorded in it, are a
  function of the entries up to `p` (with their commit timestamps) and the algorithm
  version recorded in the log (§7.4).
- **I6. Levels compose** (POL-07, v1.8). At every position, `K_s` and `K_p` equal the
  minimum of the announced capacity and the open outages' levels recomputed from the facts
  alone, whatever order they were recorded in; a reduction's cut is the greedy against
  `A_p(T_eff)` alone (T-21).

### 4. Admission

#### 4.1 The hold decision

A hold command carries the request identity, account, leg, kind (`booking`, or `change`
for an extension or increase, which is a new admission of the difference, POL-08), rate
`b`, window `W`, deadline `D`, **commit fence `D_c`** (`D − commit_margin` with a partner
leg, `D − τ` otherwise; `τ = max(ack_budget, ε + δ_x_cfg)`, about 420 ms with a cap of
about 450 ms, `δ_x_cfg` configured at p99.9 with the batching waits included; POL-26,
RFC-000 §4.3 revision 4.2, AI-17-5), `request_age` (the priority key, §4.3), and, since
RFC-000 revision 4.2 (AI-17-1, review 17 D2), **`wait`**, the **receipt minute** `m0` and
the **policy version** recorded at intake. The link takes `D_c` as given and never
recomputes it, so a change of `τ` needs no change here. Every command also carries the
sender's (generation, epoch) (§1). Applied in log order at the batch's commit timestamp
`ts`:

```
hold(r, b, W, D, D_c, age, m0, wait, policy):
  if r has a request record here (§3.3, §7.1):
      if the command's digest differs:  return MISMATCH (alerted; nothing changes)
      return its recorded state                                      # idempotent, 24 h
  if (generation, epoch) < sender fence: return STALE_SENDER        # RFC-000 §5.2
  if r is tombstoned:            refuse(r, TOMBSTONED)
  if ts ≥ D_c:                   refuse(r, DEADLINE_PASSED)        # covers ts ≥ D
  if not valid(r, m0, policy):   refuse(r, INVALID(rule))          # §2; intake should have caught it
  if peak(occ_firm, W) + b > C_ref:
                                 refuse(r, NO_FIT, counter_offer(occ_all, W, b))     # P1-S37, P1-S73
  if peak(occ_all, W) + b ≤ C_ref:
      add pulse (W, b) to occ_all; record hold(r, attempt 1)        # HELD
  else if not wait:                                                 # decided here (D2)
      refuse(r, IN_FLIGHT, retry_after = max over blockers (D_x) − ts,
             counter_offer(occ_all, W, b))                          # P1-S12, P1-S70, P2-S112
  else:
      register waiter(r, attempt 1); answer WAITING(ahead = max over blockers (D_x))
      request_yields(r)                                             # §4.3

refuse(r, reason, …): tombstone r until D + release_grace; record the refusal
```

**`wait = false` is decided at the link** (review 17 D2, RFC-000 AI-17-1). Revision 3
received no `wait` from RFC-002, so a `wait = false` request blocked by holds was
registered as a waiter, asked younger waiting holders to yield on behalf of a request about
to be rejected, and needed a further release, hop and commit (about 35 ms, est.) before
its rejection could be reported. Now the refusal is decided in the hold's own entry: no
waiter is registered, no yield is asked, the counter-offer is the one recorded in the
refusal, and the refusal's tombstone is the release acknowledgement, so the account
owner reports the rejection at once (P1-S12's "at once", P2-S112).

- **One at a time in the order they reach the schedule owner** (POL-05 as amended by
  RQ-R1-14 in `requirements-v1.7`, P1-S14, P1-S77, B-RQ-1). "The order received" is the
  order in which hold commands reach the owner-lease holder of the link's slot, which is
  the order of the link's log: each batch takes the commands that arrived while the
  previous batch committed, in arrival order at the owner process, and applies them one
  after another, each against the state its predecessors left, counting every hold then in
  place. The order in which the accounts' owners received the requests plays no part:
  two requests received by different accounts in one order may reach the link, and be
  checked, in the other (P1-S77: Y reaches the owner first, holds the last 2 Mbps, and X,
  received first by its account, is refused `IN_FLIGHT` with `retry_after` = Y's remaining
  deadline). A command refused `NOT_OWNER` or `STALE_EPOCH` and re-sent reaches the owner
  when the lease holder receives it; a retried command returns the state its first
  application recorded, so its place is that first application. The log records the order,
  so it is checkable afterwards (T-03). A `wait = false` request refused because of a hold
  later released stays refused. The check counts committed and **held**
  capacity only: it does not reserve capacity for older waiters, which receive released
  capacity through the scan (§4.3). (Revision 1 also counted older waiters' needs; v1.6's
  arrival-order rule removes that, Competition.)
- The order of the tests is the requirement's: no fit on committed capacity is a
  rejection whatever is held (P1-S37, P2-S17); fitting only without capacity in flight is
  waiting or, with `wait = false`, an immediate rejection (P1-S07, P1-S12, POL-05).
- **Blockers** are the holds of other requests that overlap a conflict range
  `conflicts(occ_all, W, C_ref − b)`. `retry_after` is the remaining deadline of the
  latest of them: by then every one is confirmed or released (POL-05, RQ-R1-10 decided;
  P1-S70: 25 s of 10 s and 25 s; P1-S12: 20 s with one blocker). Offer holds are
  committed, so a request blocked by one is a no-fit refusal, never a blocker (P1-S56).
- A **refusal records a tombstone**, so it doubles as this link's release acknowledgement
  (RFC-000 §4.3): a rejected request never needs a further entry here.
- Refusing at `D_c` rather than `D` is stricter than RFC-000's port invariant ("no hold
  past `D`") and always safe (a request that cannot hold cannot confirm), because a
  request cannot begin committing after `D_c` in any case (POL-26).
- The answer is sent once the batch transaction has committed, so the entry is durable in
  two regions (RFC-000 §3). A repeated hold for the same request returns the recorded
  state, never a second hold (A6).

#### 4.2 Counter-offers and availability

Every counter-offer is computed **beside committed and held capacity** (`occ_all`), the
capacity that can be had now, for every rejection: a `wait = false` rejection, a no-fit
rejection and a waiter refused for no fit alike (POL-10 as amended, RQ-R1-9 decided;
P1-S73). They identify no other account, reservation or traffic: only rates and windows
(P1-S17).

**Largest rate** over `W`: `max(0, C_ref − peak(occ_all, W))`. It may exceed the requested
rate (P1-S39: 10 Mbps for an 11 Mbps request). A value below `rate_min` is reported as
0 Mbps, meaning none (P1-S38). P1-S73: `10 − 8 − 1 = 1` Mbps.

**Earliest window** of the requested length `L`, starting at or after `s`, within the
request's horizon `H` (§2), fitting `b` (POL-10), with `θ = C_ref − b`:

```
earliest(s, L, b):                      # finite L
  t := s
  repeat at most counteroffer_steps times:
    if t + L > H: return NONE
    x := first_above(occ_all, t, θ)
    if x is none or x ≥ t + L: return [t, t + L)
    t := first_at_or_below(occ_all, x, θ)
    if t is none: return NONE           # overcommitted for ever after x
  return NOT_FOUND_BEFORE(t)
```

Each step jumps over one overcommitted run, so the cost is `O(r log m)` for the `r` runs
crossed. For an open-ended request the answer is `[t, ∞)` with
`t = max(s, last_above(occ_all, θ) + 1)` if `t < H`, otherwise none; if `last_above`
returns "for ever" (the schedule is overcommitted at every later minute), the answer is
none (P1-S38). Checked against P1-S16
(`[12:00, 13:00)`), P1-S73 (`[12:00, 13:00)`), P1-S12 (`[11:00, 12:00)`) and P1-S38 (none,
because the open-ended 2 Mbps leaves 8 Mbps for ever).

**Where they are computed.** A counter-offer is part of the refusal's recorded outcome:
the owner computes it while applying the batch, before the transaction commits, and the
refusal entry stores it, so a retried command receives the same counter-offer from any
later lease holder without recomputation. Two bounds keep it off the latency budget, both
**counted in steps, never in time**, so every replay reaches the same outcome (review 17,
R1-12; §7.4): `counteroffer_steps` (512 jumps per refusal, about 1 ms at worst in V8,
est.; a handful in practice) and `counteroffer_batch_steps` (4,096 jumps per link per
batch, about 5 ms at worst, est.), both algorithm constants fixed by the `Policy` entry in
force. Within a batch the result for a given (window start, length, rate) is cached and
reused (a flash crowd asks the same question), **keyed also by `occ_all`'s change counter**
(§3.2), so a cached answer is reused only while `occ_all` is unchanged and is always the
one computed beside the capacity then held (POL-10). Once the batch's steps are spent,
later refusals in that batch report "no window found before `t`", `t` being where the
search stopped. POL-10 allows both ("as far as can be computed within the budget"). The
largest rate is always exact (`O(log m)`).

**Availability for routes** (RFC-002 builds the route counter-offer, P2-N11, P2-S73).
`availability(W, b)` returns the largest rate and the earliest window as above;
`fit_ranges(b, from, until, k)` returns up to `k` maximal ranges in `[from, until)` where
`occ_all + b ≤ C_ref`, and where to continue. RFC-002 takes the minimum of the legs'
largest rates (same window) and intersects the legs' fit ranges, asking for further
chunks until it finds a common range of length `L` or reaches the horizon. Both queries
are reads of the owner's latest committed generation, served between batches: advisory,
not decisions, and not log entries.

#### 4.3 Waiting, priority and yields

**Priority.** Waiters are ordered by `priority_rule`; with `request_age` (POL-02) that is
the receipt timestamp recorded at intake, ties by request identity (RFC-000 §4.5). The rule
is a comparator selected by a `Policy` entry; it is consulted only between requests that
conflict, so it cannot change the outcome of an uncontended request (P2-S21).

**Attempts** (review 17, R1-09; RFC-000 §8). A request's **attempt** numbers its
current claim on this link. It is 1 at the first hold or waiter registration and changes
**only** when the claim is given up while the request goes on: an accepted yield or an
accepted displacement removes the attempt's pulse and registers the request as a waiter
at attempt + 1. A grant **keeps** the waiter's attempt. `HELD`, `WAITING`, `GRANTED` and
`DISPLACED` each carry the attempt the account owner must record; `convert`,
`yield_accept`, `yield_refuse` and `displacement_accept` carry it back, and a `convert`
for another attempt than the hold's is refused `MISMATCH` and alerted. A displacement
marker carries the attempt it was written for (§5.1), so the account owner's confirm
compares the marker's attempt with the one it recorded from the same messages.

**The waiter scan.** Whenever an entry removes occupancy from `occ_all` over a range `R`
(a release, an accepted yield or displacement, a leg change, a restoration or increase at
its boundary, a released offer hold, a cancelled maintenance booking at its boundary) or
adds to `occ_firm` over `R` (a conversion, a capacity decrease), the apply runs, in the
same entry:

```
scan(R):
  for w in waiters overlapping R, in priority order, at most scan_steps of them:
    if ts ≥ w.D_c: continue                          # cannot commit; its owner expires it
    if peak(occ_firm, w.W) + w.b > C_ref:
        refuse_waiter(w, NO_FIT, counter_offer)       # P1-S42, P2-S52; tombstone
        continue
    if w is younger than a waiter O with a live yield claim overlapping w.W:
        continue                                      # capacity yielded for O is not re-granted
    if peak(occ_all, w.W) + w.b ≤ C_ref:
        grant(w): add pulse to occ_all; w becomes a hold (same attempt)   # P1-S11, P2-S20
    else:
        request_yields(w); re-send the waiting notice if its latest blocker changed
  if waiters overlapping R remain unexamined: mark R scan-pending; propose a Tick
```

Because the scan runs in the entry that frees the capacity, in priority order, and each
grant updates `occ_all` before the next waiter is checked, released capacity goes to the
oldest waiter it fits before any later command is applied (P2-S16, P2-S97). A younger
waiter that fits where an older one still does not is granted, except inside a live yield
claim (below): that is the one-at-a-time check of POL-05 applied to the waiters in
priority order.

**Scan budget** (review 17, R1-14). A scan examines at most `scan_steps` waiters (1,024,
an algorithm constant, about 1 ms at worst in V8, est.). The waiters overlapping a range
are few (typically tens on the hottest link, §9), so the budget binds only in a pathological
flash crowd. If it binds, the range is **scan-pending**: the next entry, a `Tick` proposed
at once, continues the scan from where it stopped, and meanwhile a hold overlapping a
scan-pending range that fits on committed capacity is registered as a waiter rather than
held (with `wait = false`, refused `IN_FLIGHT`), so it takes its place in priority order
behind the waiters already waiting instead of taking released capacity ahead of them
(POL-02). Every step is counted, never timed, so
replays agree (§7.4).

A grant is notified to the account owner as `GRANTED(request, attempt)` (RFC-000
"capacity released"). If the request has meanwhile ended, the account owner's
request-scoped release ends the grant (A9).

**Yields** (POL-02; RFC-000 §3, A9). `request_yields(w)` considers every holder `h` that
overlaps `w`'s conflict ranges, is **younger** than `w` and carries the **waiting mark**.
It raises yield requests only if those holders' capacity together with the free capacity
would let `w` fit, `peak(occ_all − Σ h, w.W) + w.b ≤ C_ref` (computed on a speculative
generation, `O(|h| log m)`); otherwise `w` waits for the outcomes of the holders that are
not waiting, which come by their deadlines, and nobody yields in vain (review 17, R1-05).
When it raises them, at most one outstanding per (holder, attempt), `w` takes a **yield
claim** over its conflict ranges. The claim ends when `w` is granted, refused or released,
or when any of its yield requests is refused (the holder stopped waiting), after which a
later scan re-evaluates `w` from the start. While the claim is live, the scan grants no
waiter younger than `w` inside the claimed ranges, so a younger waiter that has just
yielded is not re-granted the capacity it gave up while `w` is still blocked (the loop of
review 17, R1-05: O needs 6, Y holds 3, 1 is free; Y's 3 and the free 1 do not let O fit,
so Y is not asked; had they sufficed, Y's re-registration as a waiter would not regain
them). A new **hold** command is still checked one at a time against held capacity
(POL-05): a claim reserves nothing against arrivals.

The waiting mark is set and cleared by `mark_waiting` commands from the account owner,
which tells every link owner where it holds capacity when its request starts or stops
waiting (RFC-000 §3, §8); a `mark_waiting` that sets the mark also re-evaluates the older
waiters it blocks for yields, under the same sufficiency rule. The account owner accepts
only if the request is still waiting, in its own serial order; on
`yield_accept(r, attempt)` the link, in one entry, removes that attempt's pulse, registers
`r` as a waiter (attempt + 1, same age and window, so it keeps its place, P2-S97) and
scans. A refusal or a stale attempt changes nothing but the claim. A holder without the
mark is never asked (P2-S58). Every younger waiting holder whose capacity is needed
yields, so crossings and longer cycles break without being detected (P2-S19, P2-S87,
P2-S88), and a request blocked by an older holder that is not waiting waits for that
holder's outcome, which comes by its deadline.

**What a waiter gets back.** A waiter refused for no fit is rejected with a counter-offer
(P2-S52, P1-S42). A waiter whose deadline passes is ended by its account owner,
"deadline passed while waiting", with the `retry_after` taken from the waiting notices:
each link's notice carries the latest remaining deadline among that link's blockers and is
re-sent when it changes, and the account owner takes the latest over its legs, counting
zero for a blocker that already has its outcome (POL-02 as amended; RFC-000 §4.3; P2-S61,
P2-S95, P2-S116).

#### 4.4 Conversion, release, tombstones and expiry

- **Convert** (on a confirmed outcome; asynchronous, idempotent by request): carries the
  reservation, part identity, the hold's **attempt** (§4.3; `MISMATCH` if it is not the
  hold's) and the **decision timestamp** `T_dec` (RFC-000 §8). The
  hold's pulse is added to `occ_firm` and `occ_commit`; `occ_all` is unchanged, so confirming
  never counts the capacity twice (P1-S09); the part is recorded with age `T_dec`; the hold
  and its displacement marker, if it has one, are removed; the waiters overlapping it are
  scanned for no-fit refusals (P2-S52). If the hold carries a **displacement mark** (a
  reduction displaced it, §5.1), the account owner's confirming transaction did not see
  the marker, so the request had begun committing (POL-07, B-RQ-9, B-RQ-10; P1-S78's first row):
  the part is flagged or added to the reduction's affected set like any other, its notice
  due at `max(T_dec, the reduction's ts)`, which is already past when the convert is
  applied, so the notice is written at once (P1-S63: within `affected_notice_time` of the
  confirmation), and `CONFIRMED_AFTER_REDUCTION` is raised with the reduction and both
  timestamps. Because the marker was not seen, `T_dec` is below the reduction's commit
  timestamp in the database's order, though the link applies the convert after the
  reduction entry; the link's condition is the mark, not a comparison of timestamps. A convert for a request with no hold here
  is a protocol violation (the account owner confirms only with every leg held): it is
  refused, `NO_HOLD`, and alerted.
- **Release** (request-scoped, on a non-confirmed outcome, A9): carries `D` (RFC-000 §8,
  AI-R1-8). In one entry it removes every hold, waiter registration and grant of the
  request, whatever the attempt, and any displacement marker, cancels its outstanding
  yield and displacement requests, records a **tombstone** until `D + release_grace` and
  scans. It is acknowledged once its batch has committed; that acknowledgement is what the
  account owner's "releases durable" entry collects (RFC-000 §4.3, A10). A release for a
  request this link has never seen still records the tombstone, so a hold command still in
  flight is refused when it arrives (A0R-03). The capacity is free for others from this
  entry; the outcome is reported only after it (P1-S08, P1-S18, P2-S14).
- **Tombstones** are dropped from memory by the first entry with `ts > D + release_grace`;
  no entry is needed. From then on `ts ≥ D_c` refuses any late hold or grant for the
  request on its own (I3). At the hottest link they number at most about 114,000, about
  6 MB (§9).
- **Request records** (review 17, R1-18; RFC-000 §4.4: internal command identities kept
  for the life of the request plus 24 h). The recorded state of every request seen is
  kept in memory with its tombstone, and the entry that records its **final** state here
  (its refusal, conversion or release) also writes one `link_request` row (§7.1) naming
  that entry's log sequence, kept 24 h past `D`; by `D + release_grace`, when the memory
  record goes, every request's state here is final. A repeated command arriving after the memory record has gone is answered from
  that row and the log row it names: the same refusal and counter-offer, or the
  conversion or release, never `DEADLINE_PASSED` for a request already decided. The rows
  are keyed by request, so they spread over the table's ranges instead of joining the
  log's tail.
- **Expiry requests** (liveness only, A8). When the owner's clock passes `D` for a request
  that still has a hold or waiter here, the owner sends the account owner an "expire if
  undecided" request (RFC-002's outcome and expiry port), keeps the hold and raises an
  alert (RFC-000 §3, deadline path). It retries every second. The answer carries the
  committed outcome, confirmed with `T_dec` (convert) or not (release). If no answer
  arrives, the hold is still kept: releasing without an outcome could release under a
  confirmation (POL-26's reasoning); the decision record's takeover and expiry bring the
  release within `release_grace` (P1-S54, P2-S104), including when the record was
  unavailable at any time in the last `ack_budget` before `D` (P2-S114), and a
  confirmation decided in time and known late converts the hold (P2-S106). Expiry requests
  are messages, not entries; their identity is (link, request, "expire").

#### 4.5 Changes to confirmed legs

The account owner owns the route-level reservation and its change queue (RFC-002, POL-08);
the link applies the effect on its leg. Each change carries its **change id**, the
reservation and leg, the effective minute and the account owner's **decision time** (for
known-at, §6); each is acknowledged once durable and idempotent by change id (RFC-000 §8):

| Command | Effect on the link | Used for |
|---|---|---|
| `end_leg(reservation, leg, change, from T)` | Every part of the reservation's leg: pulse `−b` over `[max(s, T), e)` in `occ_firm`, `occ_all`, `occ_commit` | Cancellation and shortening at the next minute boundary (P2-S43, P2-S44, P2-S84, P2-S85, P1-S72), revocation (P1-S32, P1-S36), release after suspension (POL-16), termination (POL-30), a move off the link (P1-S35, P1-S53) |
| `reduce_parts(reservation, leg, change, [(part, Mbps)], from T)` | Each named part reduced by its amount from `T`; the parts are listed newest first | Rate decrease, which RFC-002 applies last in, first out and names part by part (P2-S48); a POL-07 cut target applied by RFC-002 (P1-S47, P1-S65, §5.4) |

An extension or increase is a new admission of the difference through §4.1 under the
change request's own identity, which becomes a new part with its own age on conversion
(P2-S45, P2-S47, P1-S46). A rejected extension or increase leaves the existing parts
untouched (P2-S46, P2-S74). The link does not choose which parts a decrease removes: the
command names them, so the account owner's last-in-first-out rule has one implementation.
Every change runs the waiter scan over the freed range, and, inside an open outage or a
reduction's notice, triggers the flag or affected-set recomputation (§5.4, §5.7). A change
whose effective minute is known in advance (a move at its offer's move minute, a
shortening) is sent and recorded **when it becomes known, dated in the future** (RFC-000
§4.5 revision 4.2, A-3), so the link applies it before its minute and every decision in
between already sees it (a moved reservation is never cut on the link it leaves, §5.6). The
effective minute is the account owner's, recorded in its own log before that minute; a
change that reaches the link after `T` (this link was failing over) is applied as decided,
from `T`, which for sales frees only minutes already past, and known-at history dates it by
its decision time (§6).

### 5. Capacity changes

**Who may act** (POL-07 and POL-32 as amended, RQ-R1-7 decided). All supply and registry
commands are authorised by identity and access (RFC-005) and checked again here against
the registry:

| Action | Principal or role | Contract |
|---|---|---|
| Book or cancel maintenance, announce a permanent reduction, record a permanent increase | The link's supplier (its users) | Link supply commands (§11.1) |
| Record an unplanned outage or its restoration | The link's supplier, or an operator in network operations | Link supply commands |
| Register a link for its supplier, with its capacity; retire it | An operator in commercial | Catalogue link registry (§10) |
| Read the link's schedule | Network operations for a link it records an outage on (a preparatory read, recorded); the supplier as POL-33 allows | Link schedule query (RFC-005 views) |

Anyone else gets "not found", as if the link did not exist (X1-S22, including another
supplier's principal recording an increase or cancelling maintenance). A network
operations operator attempting maintenance, a permanent reduction, an increase or a link
registration gets "refused", and nothing changes (X1-S23, X1-S13). Every supply and
registry entry carries the pseudonymous principal, role and a reason code with RFC-005's
reason reference (X1-N8, A11). Free text an operator or supplier writes stays with RFC-005
(the operator action envelope), never in the link log, so the link's log, feeds and
history hold no personal data and an erasure (POL-19 as amended, X1-N11, `erasure_max`)
never has to touch them.

#### 5.1 Displacement of pending requests

From the moment a reduction (an outage, or a permanent reduction's sellable part) is
recorded at the link, new sales are decided against the reduced capacity in force, by
construction: the lower `K_s` is in `occ_firm` and `occ_all` from its entry (P1-S24,
P1-S63's last line). A fact that leaves `K_s` unchanged (a reduction announced during a
deeper outage, an outage above the capacity in force) displaces nothing. For the holds and
waiters already present where `K_s` fell, the entry also, in the same apply:

```
displace(R):                                   # R: range where capacity fell
  T := occ_all minus the pulses of every hold overlapping R
  for h in those holds, in priority order:     # POL-02: older holds keep their capacity first
    if peak(T, h.W) + h.b ≤ C_ref: T += h      # still fits beside committed and older holds
    else: mark h displaced (reduction, ts); write its displacement marker (§7.1);
          notify its account owner:
            DISPLACED(h, fits_on_committed = peak(occ_firm, h.W) + h.b ≤ C_ref, counter_offer)
  scan(R)                                      # waiters with no fit are refused (P1-S42)
```

A displaced hold **keeps counting** in `occ_all` until its account owner answers (A9); the
link cannot end it. Whether the request had begun committing when the reduction was
recorded is judged **exactly, by whether the reduction's displacement record is visible to
the transaction confirming the request** (POL-07 *When it is judged*, as amended by B-RQ-9
in `requirements-v1.7`; P1-S78). The displacement record is the set of **displacement
markers** the reduction's own batch transaction writes, one row per displaced hold
(`link_displacement`, §7.1), and the account owner's serialisable confirm transaction reads
the marker of each of the request's Share legs, a point read per leg (RFC-000 revision 4.1:
A1 amended, §8 *Link displacement read*, AI-R1-11; RFC-002 performs the read). The
account owner applies the answer in its own order (RFC-002):

| The confirm transaction | Meaning (POL-07, B-RQ-9) | Account owner's answer | Link |
|---|---|---|---|
| Sees the marker (the reduction committed at a lower timestamp) | Had not begun committing: decided against the reduced capacity | No confirm. If it no longer fits on committed capacity: ended *rejected* for no fit with the counter-offer, then the request-scoped release (P1-S41, P1-S78's second row). If it still fits on committed capacity: `displacement_accept` | Release: hold, marker and mark removed, tombstone, scan. `displacement_accept`: in one entry the hold's pulse and marker are removed, the request registered as a waiter (attempt + 1, same age), and the scan runs, as for a yield |
| Does not see the marker (the confirm is ordered before the reduction) | Had begun committing: may complete by its deadline | `convert` once decided confirmed (or the release if it ends otherwise, B-AI-7) | §4.4: part recorded, flagged or in the affected set, notice written at once, `CONFIRMED_AFTER_REDUCTION` (P1-S63, P1-S78's first row) |
| Has not run yet when `DISPLACED` arrives | Undecided: the request has not begun committing | As in the first row; a confirm proposed later reads the marker and so cannot complete | As in the first row |

**Why the order is exact.** Both transactions touch the marker key: the reduction writes
it, the confirm reads it, each serialisable. If the reduction commits first, every confirm
at a later timestamp sees the marker (a read meeting the reduction's uncommitted write
waits for it to resolve). If the confirm reads first, the database's timestamp cache
pushes the reduction's write above the read, so the reduction's transaction fails with a
retry error and is re-decided at its new timestamp (§7.2 step 5); the confirm is then
ordered before the reduction. The account owner's confirm (RFC-002's E5) also runs at a
fixed timestamp, so a confirm that is pushed **retries** (it does not refresh) and, if the
marker appeared meanwhile, sees it (review 17, R1-21; RFC-006 §3.7 is to say the same:
the reduction is pushed only when the confirm read first, and is then re-decided, never
lost). So "had begun committing at the
record" is a fact the records decide, with no window, at the cost the coordinator accepted:
a request whose confirm is ordered before the reduction but whose convert reaches the link
after it completes and is affected (a few more affected, credited, alerted confirmations
while the notice is in transit).

**A capacity-lowering entry travels in a transaction of its own, marker intents first**
(review 17, R1-03). In revision 3 the reduction rode the slot's ordinary batch: its
timestamp was fixed at the batch's start and its markers written only after the whole
batch was decided (about 10 ms later), and every confirm of a soon-to-be-displaced hold
that read its marker key in that window pushed the batch, which on the hottest link (about
190 holds in flight, each confirmed within about 75 ms) made a retry likely with a few
displaced holds and near certain in a flash crowd, while admission kept selling at the old
capacity. Now an entry that lowers `K_s` (`Outage`, `ReductionAnnounce`, a partial
restoration never lowers) is never batched with other entries: the slot's lane carries it
alone, as one transaction, which:

1. as its **first statement**, upserts a placeholder marker for **every hold overlapping
   the lowered range** (a superset of those it may displace, at most the holds in flight,
   about 190 on the hottest link), reading `ts` in the same statement, so the intents are
   laid within one in-region round trip of the timestamp being fixed;
2. decides the entry (§3.1, then `displace`) at `ts`, and deletes, in the same
   transaction, the placeholders of the holds that still fit;
3. inserts its log, head and outbox rows and commits, conditional on the slot's epoch.

A confirm whose read arrives after step 1 meets an intent and waits for the commit (about
one commit), then sees the marker or its absence: it never pushes. Only a confirm reading
inside the round trip of step 1 can push, and the retry keeps the transaction's intents
(the client-side retry protocol restarts the transaction at a higher timestamp holding its
locks), so the second attempt is pushed by nothing (est.; T-12 measures it on the hottest
link's design load, and Risk R1-1 holds the fallback). The cost is one extra commit on the
slot's lane per capacity decrease, a supply event, rare by nature; a retry re-decides only
the decrease itself, never 150 other entries. A confirm that waits on the intent is RFC-002's
to bound with a short lock timeout (its J-14).

**Marker lifecycle.** A marker is written (upserted, so a second reduction displacing the
same hold replaces it with the later reduction) in the displacing entry, and deleted in the
entry that ends the displaced attempt: its conversion, its release, or the accepted
displacement. The deletion is a write by the link owner at a timestamp above any confirm
that could still read it, since the confirm precedes the convert and the release. Rows are
written only when a reduction displaces a hold, so the read is of an absent key on almost
every confirm. A marker carries the attempt it was written for; a waiter granted again
after an accepted displacement has no marker, and its confirm reads none.

**Costs.** One in-region point read per Share leg per confirm, about 1 to 2 ms (est.), no
extra commit (RFC-000 §3 latency table). A capacity decrease costs one transaction of its
own on the slot's lane and, rarely, one retry of that transaction alone.

#### 5.2 Unplanned outage and restoration

- `record_outage(to_capacity L, attribution, reason)` from the supplier or network
  operations records an outage **to the level `L`**, the capacity the link carries while
  it lasts (POL-07 as amended in `requirements-v1.8`, review 17 D1), open-ended from
  `floor_minute(ts)`, the start of the minute it is recorded in, until its restoration,
  for every window sold (P1-S24, P1-S49, RQ-R1-2 decided). `L` must be a whole number of
  Mbps, at least 0 and below the announced physical capacity now, `A_p(now_m)`; an outage
  at or above it reduces nothing and is refused `INVALID`. An outage need not be below
  another open outage: each is a separate fact, restored separately, and the capacity in
  force is the minimum (§3.1). Profile differencing lowers `K_s` and `K_p` where `L` is
  below them (an outage during a reduction's notice can lower `K_p`, what the link
  carries, without lowering `K_s`), then §5.1 runs where `K_s` fell (P1-S41, P1-S42,
  P1-S63). Confirmed reservations are untouched (P1-S25).
- Works carried out on sold capacity after a rejected maintenance booking are recorded the
  same way, with `attribution = supplier` for SLA purposes (Problem 6, P1-S51).
- `record_restoration(outage, to_capacity L'?)`: the outage ends, or, with `L'`, its level
  rises to `L'` (which must be above its current level and below `A_p`; a restoration at
  or above `A_p` ends it), from `b = ceil_minute(ts)`, the first minute boundary at or
  after the record, as a pending effect (§3.1). The capacity in force rises to what the
  remaining facts give, and flags end or shrink, from `b` (P1-S27; P1-S40: a record at
  10:30:20 leaves A and B affected for `[10:30, 10:31)`; P1-S76's first row: a record at
  09:31:00 frees 2 Mbps from 09:31 and ends the flags there, with no minute flagged after
  the record; P1-S80: a restoration at 09:40:00 makes the 15 Mbps increase recorded during
  the outage sellable from 09:40); the waiter scan runs at `b`.
- What the restoration frees is decided by the levels, not by an amount: a restoration
  under a permanent increase recorded meanwhile frees up to the new announced capacity
  (P1-S80), and one after a reduction's `T_eff` frees only up to the reduced announced
  capacity (P1-S79's last line).

#### 5.3 Planned maintenance

`book_maintenance(rate m, window W)` from the link's supplier:

1. The window follows §2's rules, relative to the command's `ts`.
2. The UTC calendar date of `W`'s start minus today's UTC date is at least
   `maintenance_notice` (14 calendar days); otherwise rejected stating the notice required
   (P1-S30).
3. If `peak(occ_firm, W) + m > C_ref`: rejected stating that the supplier may wait for
   capacity to free or announce a permanent reduction with `revocation_notice` (P1-S29).
4. If it fits on `occ_firm` but not beside holds (`occ_all`): rejected at once with the
   `retry_after` of POL-05, the latest remaining deadline of the holds blocking it, and
   not queued (POL-07 as amended, RQ-R1-5 decided; P1-S66: 20 s). It takes none of the
   held capacity.
5. Otherwise confirmed (P1-S28): the pulse is added to all three occupancies. It is
   supplier occupancy, not a reservation: it never accrues and is excluded from rating and
   settlement (POL-07); the schedule feed labels it so.

Because maintenance is admitted only on free capacity, it can never make a reservation
affected. `cancel_maintenance(maintenance)`, the supplier's own (RQ-R1-5 decided), removes
the pulse over `[max(s, b), e)` from all three occupancies, `b = ceil_minute(ts)`, as a
pending effect, so maintenance already under way keeps its past minutes (history, flags)
and frees only its future ones (review 17, R1-16), and the waiter scan runs then (P1-S67: cancelled at 09:00:30, a booking from 09:01 is confirmed;
P1-S76's third row: cancelled at 09:31:00, free from 09:31). This is POL-07's one rule for
every rise in sellable capacity (§3.1; RQ-R1-13, resolved by `requirements-v1.7`).

#### 5.4 Permanent reduction

`announce_reduction(new_capacity c)` from the link's supplier, at `ts`:

- **A level, judged against the announced capacity** (POL-07 as amended in
  `requirements-v1.8`, review 17 D1). `c` must be a whole number of Mbps, at least 0 and
  below `A_now`, whatever any open outage's level (an announcement to 8 during an outage
  to 6 is valid, review 17 R1-01 (b)). `T_eff` is the first minute boundary at or after
  `ts + revocation_notice`. In the announcing entry (a transaction of its own, §5.1) the
  fact is added to the profile: `A_s = c` from `floor_minute(ts)`, so new sales stop at once
  at the reduced capacity wherever no deeper outage already holds `K_s` lower (P1-S43);
  `A_p = c` from `T_eff`, so the link still carries its capacity until the notice ends
  (P1-S44); then §5.1 where `K_s` fell.
- **The reduction's level `L_R`** is the announced physical capacity at its notice's end,
  `A_p(T_eff)`, taking every permanent fact recorded so far (an increase recorded during
  the notice raises it, §3.1; a later reduction, with a later `T_eff`, does not lower it:
  its own notice protects it). Outages never enter `L_R` (POL-07: "a permanent reduction
  removes reservations only to fit the announced capacity, never because of an outage").
- **Affected parts, newest first** (POL-07 step 2). The excess at a minute `t ≥ T_eff` is
  `occ_commit(t) − L_R`: committed rate (confirmed parts, offer parts, maintenance) less
  cuts already decided, against the announced level alone. The affected parts are
  computed by the greedy below, over parts in **age order, newest first** (each added part
  with its own age, P1-S46; a moved part or an offer part with its original age, P1-S71,
  review 17 R1-20):

  ```
  for p in parts overlapping [T_eff, ∞), newest first, while max excess over [T_eff, ∞) > 0:
      W' := p.window ∩ [T_eff, ∞)
      cut := min(p.b, peak(excess, W'))           # the largest excess it meets
      if cut > 0: record (p, cut); subtract the pulse (W', cut) from the excess
  ```

  A part is reduced only as far as needed and revoked if the cut reaches its whole rate
  (P1-S31, P1-S32, P1-S46, P1-S47). A part's rate is uniform over its window (POL-08), so
  the cut is the largest excess it meets after the newer parts' cuts, as POL-07 decides
  (RQ-R1-4; P1-S65: excess 1 Mbps outside E's window and 3 Mbps within it, so B is cut by
  3 Mbps, to 1 Mbps, and A and E are untouched). P1-S79: `L_R` = 6, `occ_commit` = 8, so B
  is cut by 2, whatever the outage to 5 open at `T_eff`; that outage then flags A and B
  (6 > 5, §5.7) and removes nothing.
- **The affected set follows the schedule during the notice** (POL-07 step 2, RQ-R1-3
  decided). The greedy is a projection (§7.5): computed on the generation after the
  announcing entry, and again whenever the schedule changes at or after `T_eff` during the
  notice: a reservation ends or is decreased, a hold taken before the announcement converts
  (a request that had begun committing, §5.1), the supplier records an increase. Each
  result is emitted to RFC-002 as `REDUCTION_AFFECTED` with each part's cut. RFC-002 offers
  a newly affected holder an equivalent path at once and keeps an offer once made open for
  its `offer_window`, even if a later recomputation no longer needs the part (P1-S31,
  P1-S58, P1-S59, P1-S64).
- **Only decreases can happen after the projection settles.** After the announcement, new
  sales (parts, offer holds, maintenance) fit `K_s ≤ A_s ≤ L_R` at every `t ≥ T_eff`, so they
  never meet an excess minute; the excess can rise only through holds taken before the
  announcement that convert, at most `route_deadline_max + release_grace` (2 min) after it,
  long before `T_eff` (`revocation_notice` is 30 days). Every later change (an end, a
  decrease, an earlier reduction's cut, an increase) only lowers the excess, and a lower
  excess gives every part a cut no larger (the greedy's cuts are monotone in the excess:
  each part's cut depends only on the positive part of the residual excess, which a lower
  excess never raises), so the parts cut at `T_eff` are a subset of those the last
  projection cut, each by no more (P1-N8; P1-S64: when A ends, B fits and nothing of it is
  removed, whether its holder declines or accepts).
- **At `T_eff` the affected set is fixed** (RFC-000 §4.5 revision 4.2, AI-17-3, review 17
  D5). The first entry with `ts ≥ T_eff` (a `Tick` is proposed at `T_eff`) is
  `ReductionEffective(R, q, n)`: it adopts, as its **affected set** `A_R`, the reservations
  owning the parts `C_q` the projection cut as of log position `q`, the latest projection
  output written (§7.5), and records `q` and `|C_q|`. The parts `C_q` themselves travel as the
  input of the steps below, so a replay needs no projection. The entry is deferred (re-proposed
  1 s later, alerted after 5 min) while any hold taken before the announcement is still
  held here, which cannot happen at the default parameters. `A_R` is published on the
  schedule feed as `REDUCTION_EFFECTIVE(R, T_eff, q, chunk i of n, reservations)`, at most
  1,000 reservations per event, by this entry and the steps that follow it; until the last
  chunk is out, the link's **closed time** (§11.1) does not pass `T_eff`, so a consumer
  never closes `T_eff` for a reservation on this link before it knows `A_R`.
- **The cut is decided in bounded steps, effective at `T_eff`.** `ReductionStep(R, parts)`
  entries follow, each carrying as input the next `reduction_step_parts` (500) parts of
  `C_q` in newest-first order and deciding each one's cut by the greedy against the state
  at that entry: so the decision costs `O(|C_q| log m)`, bounded by the affected set, not
  by the link (review 17, R1-06, R1-8). Each cut is recorded by adding `−cut` over
  `[T_eff, p.e)` to `occ_commit` as a decided-but-not-yet-applied removal. When the last
  part of `C_q` is decided, the final step checks `max excess over [T_eff, ∞)`: if it is
  above 0 (only a projection defect could leave it so), the steps continue the full greedy
  over the remaining parts newest-first, publish the reservations they cut as a late
  extension of `A_R`, and raise `REDUCTION_SET_EXTENDED`, so the link is never left above
  `L_R` (I6).
- **Cut targets** (review 17 D4, R1-06; RFC-000 §8 reservation command port, as RFC-002
  revision 4 consumes it). For each reservation of `A_R`, once its last part in `C_q` is
  decided, the link sends RFC-002 exactly one
  `cut_target(link, reduction, reservation, T_eff, r | none)`: `r` is the rate the
  reservation may keep on this link from `T_eff` (0 revokes it), `none` means **no cut**;
  every reservation of `A_R` gets one, `none` included, so rating can close its minutes
  from `T_eff` (RFC-003). It is idempotent by (link, reduction, reservation), an outbox row
  of the deciding entry, pushed by gRPC and relayed through Kafka as the guaranteed path
  (§7.2). RFC-002 composes every target of a reservation by `min` across links and
  reductions, a route having one rate, and changes every leg through `end_leg` or
  `reduce_parts`, newest part first. `r` is the reservation's rate on this link after the
  greedy's per-part cuts, taken as the **lowest** over `[T_eff, ∞)`. That is exact whenever
  the reservation's rate after the cuts is uniform from `T_eff`, which covers every
  reservation whose parts span the same window and every increase part (cut first, being
  newest, and reaching the reservation's end). For a reservation whose newest part is an
  extension with a later window, cut while its older part is not, a single rate over-cuts
  the older part's minutes: the link never oversells, but it may remove more than POL-07
  needs there. That case is raised as Architecture issue AI-R1-13 (a target per part), and
  the link alerts `CUT_TARGET_INEXACT` with the Mbps over-cut whenever it occurs (est.
  rare: an extension sold before the announcement and newer than every other part on the
  excess minutes). The decided-but-unapplied removal kept in `occ_commit` is what the target
  implies (the reservation's rate above `r` from `T_eff`), so it equals what RFC-002 then
  applies. When every reservation of `A_R` has its target, the last step records
  the reduction **final** and publishes `REDUCTION_FINAL(R)`; until then consumers hold
  `T_eff` open for the reservations of `A_R` (RFC-000 §4.5). Cut targets are effective at
  `T_eff` though decided minutes after it on a link with a million parts (Risk R1-8): that
  is the closure hold of D5, accepted.
- **No cut on a moved reservation** (review 17, R1-07). A reservation whose move off this
  link has been accepted (§5.6) has its `end_leg` from the move minute recorded here before
  that minute, at or before `T_eff`, so its parts do not overlap `[T_eff, ∞)` and the greedy
  never reaches them; the link also keeps a **moving mark** for it and decides no cut for a
  marked reservation (its target is `none`). A cut target RFC-002 receives for a link the
  reservation has left by `T_eff` changes nothing (RFC-002's rule).
- A holder whose reservation is reduced may then cancel without a fee (P1-S47, POL-08). The
  account owner's `reduce_parts` or `end_leg` then removes the part's pulse everywhere and
  withdraws the pending removal in `occ_commit`, a net change of zero there. A cancelled
  part needs no cut: the projection and the steps see it gone (P1-S35, P1-S52).
- Notices: RFC-002 tells affected holders from `REDUCTION_AFFECTED` and `cut_target`; the
  link's own feed events are the facts, its notices are flags (§5.7).

#### 5.5 Permanent increase

`record_increase(new_capacity c)` from the link's supplier (POL-07 *Permanent increase*,
RQ-R1-7 decided): `c` must be a whole number of Mbps above `A_now`, the announced capacity
(otherwise `INVALID`), whatever any open outage's level. It is a level: from
`b = ceil_minute(ts)`, as a pending effect (§3.1), `A_s = c` and `A_p = max(A_p, c)`. New
sales are decided against the larger capacity in force from `b`, and the waiter scan runs
then. It changes no reservation and flags none (P1-S69: recorded at 09:30:20, a 5 Mbps
booking is confirmed from 09:31; P1-S76's second row: recorded at 09:31:00, a 2 Mbps
booking is confirmed from 09:31).

**During an open outage it raises the announced capacity only** (POL-07 as amended in
`requirements-v1.8`, review 17 D1; P1-S80). The capacity in force stays the outage's level
until the restoration, so the link sells nothing it cannot carry (P1-S80: 6 committed,
outage to 6, increase to 15 at 09:30:20, so from 09:31 a further 1 Mbps is still rejected;
the restoration at 09:40:00 makes 9 Mbps free from 09:40). Revision 3 raised the capacity
the outage was measured from, which sold Mbps the link did not carry (review 17, R1-01
(d)). **During a reduction's notice** it raises `L_R` if `c` is above the reduced level,
and triggers the affected-set recomputation (§5.4).

#### 5.6 Firm offer holds and moves

An equivalent-path offer is firm on its Share legs (POL-07 step 3): Share holds the full
rate on every Share leg of the path from the offer to the reservation's end while the
offer is open, counted as committed for new sales, with no funds hold (D4). One meaning
for each command, shared with RFC-002 (review 17, R1-07). On each such link M (commands
from RFC-002, each with its decision time, RFC-000 §8):

| Command | Effect |
|---|---|
| `offer_hold(offer, reservation, account, [(part, rate, original age, end)], from, lapse_at)` | Decided like a hold with `wait = false` (§4.1), beside held capacity, for the sum of the parts. If it fits, each **offer part** is added as a pulse over `[from, part end)` to **all three** occupancies (it is committed). If not, refused, `NO_FIT` or `IN_FLIGHT` with `retry_after`, and RFC-002 offers another path or retries. The offer parts carry the reservation's original ages, so a reduction on M meets them in POL-07 step 6's order (review 17, R1-20) |
| `offer_accept(offer, move_at)` | Sent on the holder's acceptance, before `move_at` (A-3). The offer parts on `[move_at, end)` become the reservation's parts on M, each with its **original age** (POL-07 step 6, RQ-R1-11 decided; P1-S71); the offer parts shrink to `[from, move_at)`. Net occupancy is unchanged, so nothing can be sold in between (P1-S35, P1-S57, P1-S60) |
| `offer_move_at(offer, T)` | Moves `move_at` earlier to the minute boundary `T` the holder chose: the parts start at `T`; net unchanged (P1-S53). Refused `INVALID` unless `ceil_minute(ts) ≤ T < move_at`, so no part moves retroactively (review 17, R1-17) |
| `offer_release(offer)` | On a decline, a lapse, or a failed partner booking at acceptance: the offer parts are removed at once from all three, tombstoned until `lapse_at + release_grace`, and the waiter scan runs (P1-S57, P1-S61) |

**The link the reservation leaves** (review 17, R1-07). On acceptance RFC-002 sends that
link, at once, `end_leg(reservation, leg, change, from move_at, cause move)`, dated in the
future (§4.5), and on an earlier `offer_move_at` a further `end_leg` from the earlier
minute. The old link records a **moving mark** for the reservation, so its reduction
projection and its `T_eff` steps exclude the reservation (its parts end at or before
`T_eff`), and no cut target ever cuts it (§5.4): a moved reservation is never revoked on
the link it left (P1-S35, P1-S52's accept row).

A request that fits only without the offer's capacity is rejected for no fit, not left
waiting (P1-S56), because the offer parts are in `occ_firm`. A partner leg is never held
(P1-S59): RFC-002 books it only at acceptance. As a backstop, if an offer hold outlives
`lapse_at`, the owner asks RFC-002 for the offer's outcome, as for an expiry (§4.4).

**A reduction on M while the offer is open.** The offer parts take part in M's greedy with
their original ages; a cut that reaches them is a cut target for the offered reservation
on M from M's `T_eff`, like any other (§5.4). RFC-002 composes it with the reservation's
other targets when the move takes effect and tells the holder; the offer stays open
(POL-07: an offer once made stays open).

**An outage on M while the offer is open** (POL-07 as amended, RQ-R1-6 decided; P1-S68).
The offer hold counts in the committed rate, so the reservations on M are flagged where it
helps overcommit, but the offer hold itself is not a reservation and is not flagged; the
offer stays open and firm. The flag projection emits `OFFER_AFFECTED` (offer, minute ranges
from when) with a notice due at the outage's record, from which RFC-002 tells the holder
within `affected_notice_time`. If the offer is accepted while the outage lasts, the moved
parts start at `move_at` and the projection flags them from there like any other part.

#### 5.7 Affected flags and notices

**Outage flags** (POL-07; the glossary's *Affected reservation*, judged against the
capacity in force, `requirements-v1.8`). For each outage, the overcommitted ranges are,
for each piece `[a, z)` of `K_p` with level `k` inside the outage's range (from the start
of the minute of its record to the boundary its restoration takes effect at, or open),
`conflicts(occ_commit, [a, z), k)`: the minutes where the committed rate exceeds the
capacity in force. Outages open at the same minute flag it once, naming each as a cause.
**Every** part overlapping such a range is affected at exactly the minutes of the
intersection, none before another (P1-S25); a range that reaches the last key extends
open-ended, because no positive impulse lies beyond the horizon (§3.1). An outage that
leaves capacity at or above what is committed has no such range and affects nothing
(P1-S48). Offer holds count in the committed rate but are not flagged (§5.6). Flags are
recomputed over the changed range whenever committed or physical capacity changes inside
an open outage (a conversion, an end or decrease, a decided cut, an increase, another
outage or a partial restoration), so they stay exact (P1-N8
success measure; P1-S72: B cancelled at 09:30:20 ends at 09:31, and from 09:31 A's 4 Mbps
fit the 6 Mbps left, so A is no longer affected from 09:31).

Flags are a **projection** (§7.5), not log entries: a deterministic function of the log
that the owner computes off the batch path and writes as projection rows and outbox rows,
emitted on the link schedule feed as `AFFECTED_CHANGED` events, each with the reservation,
the minute ranges, the cause and a **notice due time** (POL-07 as amended):

| Event | Notice due at | Scenarios |
|---|---|---|
| A reservation active at the outage's record | The record | P1-S26 |
| A reservation that starts during the outage | Its start | P1-S50 |
| A confirmation completed across a reduction (a displaced hold converted, §5.1) | `max(T_dec, the reduction's ts)`, already past when the convert is applied, so written at once | P1-S63, P1-S78 |
| A reservation's affected minutes change during the outage (another ends or is decreased, an increase, a reduction's cut at `T_eff`) | The change's known time (its decision time; for a cut, `T_eff`) | P1-S72, P1-S79, RQ-R1-12 decided |
| Restoration | The restoration's record, for every holder already told | P1-S40 |
| An open offer whose held path is affected (`OFFER_AFFECTED`) | The record | P1-S68 |

When `ts` passes a due time the owner writes the notice event for the holder and for
network operations; the notifier (RFC-006) **tells** them within `affected_notice_time`
(60 s), which POL-04 now defines as the notice recorded in the account's list of notices
and its first delivery to the account's webhook endpoints attempted, then retried for
`webhook_retry` (RQ-E decided; P1-S75: an endpoint that is down does not make the notice
late). One delivery may carry many notices, each first attempted when the delivery is
(POL-04 as amended in `requirements-v1.8`): an outage touching thousands of reservations
of one account is grouped by the notifier, not here; the link emits one notice event per
reservation and leaves batching to it. The link's budget for its part is 10 s at p99 (est.: projection, outbox publish and
Kafka), leaving 50 s for the notifier. RFC-002 consumes the same events to mark
route-level reservations affected.

### 6. Known-at history

Every schedule fact has a **valid time** (the minutes it covers) and a **known time** (when
Share knew it, POL-19, P1-N9):

| Fact | Valid time | Known from |
|---|---|---|
| Leg part | Its window | `T_dec`, the account owner's decision timestamp carried by the conversion (RFC-000 §8), not the time the link applied it |
| Leg change (end, reduction, move) | From its effective minute | The account owner's decision time for the change, carried by the command (RFC-000 §8, AI-R1-7) |
| Capacity hold, waiter, offer hold | Its window | Its entry's `ts`, until its release, conversion or refusal |
| Capacity fact (a level) | Its range (from its effective boundary, §3.1) | Its entry's `ts` |
| Cut target | From `T_eff` | The deciding `ReductionStep`'s `ts` |

`schedule_as_known_at(link, T)` returns every part known at `T` with the changes known at
`T` applied, the capacity profile known at `T` and, optionally, the holds then present.
`schedule_as_recorded_at(link, T)` returns the state of the log through the last entry
with commit timestamp `≤ T`; the two differ only by conversions and changes decided before
`T` but applied after it (milliseconds, or up to `release_grace` during a failover).
P1-S33: R known from 09:00 for `[10:00, 12:00)`; its cancellation known from 09:30:20 with
effect from 09:31; so at 08:45 nothing, at 09:15 R confirmed, at 09:45 R cancelled from
09:31.

History (RFC-006) reads the link log table through its changefeed, seals columnar
segments to two-region object storage for 7 years, verifies them, and only then lets the
live tail be truncated from the database; it builds the bitemporal index from the
segments (RFC-000 §5.5, §8 "History query"). Because every fact and change carries its
known time, every entry its commit timestamp, and the apply is deterministic, the index can
be rebuilt from the segments alone, and any decision can be explained by replaying the
link's log to that position (P1-N9).

### 7. Log, state machine and the substrate

#### 7.1 Tables

Schema conventions, the owner-lease table and the outbox relay are RFC-006's (RFC-000 §8
"Substrate conventions"); this is what the link schedule owner keeps. Every row is keyed
first by `link_id`, so a hot link's rows split into ranges of their own.

| Table | Key | Rows | Written |
|---|---|---|---|
| `link_log` | (link, sequence) | One per entry: kind, generation, epoch, commit timestamp, command identity, sender (component, partition, epoch, sequence), audit fields (pseudonymous principal, role, reason reference), and the **encrypted payload**: the command and its recorded outcome (§7.3) | Insert only, by the owner-lease holder; no application role may update or delete; only RFC-006's truncation role deletes, and only below audit's verified sealed-through watermark (RFC-000 §5.5, revision 4.1, AI5-8) |
| `link_head` | link (the partition, not the slot, so a move needs no delete) | Last sequence, its commit timestamp, the (generation, epoch) of the last batch, and the schedule feed's **`feed_seq`**, its own contiguous counter (RFC-000 §4.4 revision 4.2, AI-17-2) | Updated by every slot batch that carries entries of the link |
| `link_outbox` | (link, sequence, index) | **Schedule-feed events**, each with its `feed_seq` (contiguous per link: a consumer that sees a gap knows an event is missing); **point-to-point messages** (waiting-port notifications, `cut_target` commands, expiry requests), each identified by (request or reservation, attempt, kind) and carrying the link's (generation, epoch) and the log sequence it reflects | Insert only, in the same transaction as the entry that caused it |
| `link_request` | (link, request) | The log sequence of the request's final record here (§4.4) | Written by that entry; expired 24 h after `D` by the database's row-level TTL. Keys are request identities, spread over the table's ranges |
| `link_displacement` | (link, request) | Displacement marker: attempt, reduction sequence, the reduction's commit timestamp (§5.1). Together these rows are POL-07's **displacement record** | Upserted by the displacing entry, in the reduction's own transaction; deleted by the entry that ends the displaced attempt (convert, release, accepted displacement). Derived from the log. The only table of this RFC another owner may read: the account owner's role has select on it and nothing else here (RFC-000 A1 and §5.5 as amended in revision 4.1, AI-R1-11) |
| `link_projection` | (link, projection) | The sequence through which each projection's output has been written (§7.5) | Updated in the transaction that writes that output |

Outbox and projection rows, the head row, the request rows and the displacement markers
are derived from the log (A4) and could be rebuilt from it; the log rows are the facts. Payloads are encrypted by
the owner with keys held in Kenyan HSMs (RFC-005, RFC-000 AI5-3), so the R3 replica and
every Kafka node hold ciphertext; the columns the database must read (keys, kind, epoch,
timestamps) are not personal data.

#### 7.2 Batch transactions

The owner runtime has **one batch transaction in flight per slot** (RFC-000 §3 and §5.5 as
amended in revision 4.1, AI3-11). The transaction carries every link of the slot with
commands pending, each link with its own head row, its own contiguous sequence and its own
speculative generation; per-link guarantees are those of a batch per link. The hottest
links each have a slot of their own (§1), so for them a slot batch is a link batch. Commands
that arrive while a batch commits queue per link, in arrival order, for the next one (at
most `link_batch_max`, design constant 1,000 entries per link). A batch:

1. Begins a transaction; reads the slot row's epoch (the guard, RFC-000 revision 4.1,
   AI6-1) and the head row of each link it carries; reads the transaction's timestamp
   `ts`, which fixes its commit timestamp.
2. For each link, applies every queued command in order on a **speculative generation**
   of that link's state (§3.2), at `ts`, recording each outcome, computing counter-offers
   within the batch budget (§4.2), and collecting the log, outbox, marker and projection
   rows. Projection output computed since the last batch (§7.5) is added to the same
   transaction.
3. Inserts the rows, updates the head rows and commits, conditional on the slot's epoch.
4. **Committed:** every generation becomes current; synchronous commands are answered;
   outbox rows are pushed directly (gRPC to account owners for point-to-point messages,
   Kafka for feeds), the changefeed relaying them again as the guaranteed path (RFC-000
   §5.5); the committed batch is pushed to the slot's two hot standbys (§7.6). Feed
   consumers apply events in `feed_seq` order and drop duplicates by it; point-to-point
   messages are idempotent state messages, deduplicated by their identity (§11.1).
5. **Retry error** (the transaction was pushed past `ts`, or met a conflict): every
   generation of the batch is dropped and the batch is re-decided from step 1 with the
   same commands at its new timestamp; nothing was answered. Only the owner writes the
   slot's rows, and **no reader other than a successor's takeover read reads a live link's
   log tail or head row at the present timestamp** (review 17, R1-02), so a push has one of
   four causes, each counted by T-18: (a) a confirm's marker read, which only a
   capacity-lowering transaction can meet, and only inside the first statement's round trip
   (§5.1); (b) a successor's high-priority takeover read, which is meant to fail a deposed
   holder's batch (§8); (c) the database's own range operations (lease transfers, splits);
   (d) a conflict on the slot row with a lease acquisition, which deposes the holder
   anyway. Standbys read by follower reads below the closed timestamp or by bounded spans
   of already committed sequences (§7.6); history, audit and RFC-006's gap-fills likewise.
6. **Ambiguous result** (the connection failed during commit): the owner reads the head
   row of one link the batch carried at the present timestamp (the batch is atomic). If it
   holds this batch's last sequence for that link, the batch committed and step 4 follows;
   if not, step 5. If the slot's epoch has moved, the owner has been deposed (§8): it drops
   the generations, answers nothing, and redirects.
7. **Epoch mismatch:** deposed, as in 6.

**Capacity-lowering entries** (`Outage`, `ReductionAnnounce`) never share a transaction:
the lane carries each alone, marker intents first (§5.1). Owner sessions run with an
idle-in-transaction timeout and a transaction timeout below the owner-lease margin
(RFC-006's runtime conventions, RFC-000 AI-17-4), so a holder paused inside an open batch
has it aborted by the database before its lease could pass to a successor.

So no answer, notification or feed event ever describes an entry that did not commit, and
every entry is decided at exactly the timestamp it is recorded at, which the `D_c` check,
the validity rules, tombstone expiry and every effective boundary rely on. Applying a batch
of 150 entries costs a few milliseconds of the event loop (§9). On a slot shared by many
cold links, a retry re-decides all of them; their batches are small and, with cause (a)
confined to capacity-lowering transactions and (b) and (d) to takeovers, ordinary batches
retry only on range operations, so the cost is negligible (est.).

#### 7.3 Entries

Every entry carries its sequence, epoch and commit timestamp, its command identity, its
sender and, for supply, registry and operator commands, the audit fields (X1-N8). It also
records its **outcome** (held, refused with reason and counter-offer, waiting with the
deadline ahead, granted, displaced, converted, released, recorded), which any replay
recomputes and compares (§7.4).

| Entry | From | Apply |
|---|---|---|
| `Init(registry record, policy)` | Placement, on registration (§10) | Sets `C_ref`, supplier, kind, probe flag, policy |
| `Takeover(epoch)` | A new lease holder, first | Nothing but the epoch; timers are rebuilt from state (§8) |
| `Policy(version, parameters)` | Configuration deployment | Parameters and algorithm version from this position |
| `Registry(version, change)` | Registry feed | Probe flag, status (`active`, `closing`, `retired`, §10) |
| `Tick` | Owner, at the earliest due timer when no other entry comes, or at once for a scan-pending range | Advances `ts` (effective boundaries, due notices, `T_eff`, tombstone removal); continues a scan-pending scan (§4.3) |
| `Hold`, `Convert`, `Release` | Account owner | §4.1, §4.4 |
| `MarkWaiting`, `YieldAccept`, `YieldRefuse`, `DisplaceAccept` | Account owner | §4.3, §5.1 |
| `EndLeg`, `ReduceParts` | Account owner | §4.5 |
| `OfferHold`, `OfferAccept`, `OfferMoveAt`, `OfferRelease` | Account owner | §5.6 |
| `Outage`, `Restoration` | Supplier or network operations | §5.2 (an `Outage` in a transaction of its own, §5.1) |
| `Maintenance`, `MaintenanceCancel` | Supplier | §5.3 |
| `ReductionAnnounce` | Supplier | §5.4 (a transaction of its own, §5.1) |
| `ReductionEffective(R, q, n)`, `ReductionStep(R, parts)` | Owner, at `T_eff` and after | §5.4: affected set fixed and published; cuts decided per part of `C_q`, cut targets sent; the last step records the reduction final |
| `Increase` | Supplier | §5.5 |
| `Checkpoint(sequence, reference, digest)` | Owner, on a standby's report (§7.6) | Records where a checkpoint of the state through `sequence` is stored |
| `Compact(through)` | Owner, daily | §7.6 |
| `Moved(epoch)` | Placement | Final entry before the link moves to another slot; every later command refused (RFC-000 §5.2) |

Queries (`query`, `availability`, `fit_ranges`, history) are not entries. Idle links write
nothing: a `Tick` is proposed only when a timer falls due, never on a fixed beat, so a
link with no activity costs no transactions.

#### 7.4 Apply rules and determinism

- Integer-valued arithmetic only (§3.2); every iteration in a stable order (priority
  order, age order, minute order, request identity); no clock, random number, floating
  fraction or iteration of an unordered collection in the apply. JavaScript `Map`
  iteration follows insertion order, which is itself a function of the log, and
  `Array.prototype.sort` is stable; the apply nonetheless sorts by explicit keys wherever
  order matters.
- The algorithm version (the counter-offer bounds, the greedy, the priority comparator) is
  fixed by the `Policy` entry in force, so a new lease holder running newer code applies
  old entries as they were applied (I5).
- **Every replay checks itself.** A standby or a rebuilding owner recomputes each entry's
  outcome and compares it with the one recorded; a mismatch stops that replica, marks it
  ineligible for the lease and alerts (RFC-006). This replaces revision 1's digests at
  snapshot positions as the first line of defence; checkpoints still carry a state digest.
- Per-entry apply cost is bounded, and every bound is a **step count** fixed by the
  `Policy` entry, never a time, so a replay on another machine reaches the same outcome
  (review 17, R1-12, R1-14): a hold or release is a few tree operations (about 10 to 40 µs
  in V8, est.); waiter scans by `scan_steps` (1,024 waiters, the rest continued in a
  `Tick`, §4.3); displacement by the holds overlapping the lowered range (about 190 at the
  hottest link, §9); reduction steps by `reduction_step_parts` (500); counter-offers by
  `counteroffer_steps` and `counteroffer_batch_steps` (§4.2).

#### 7.5 Projections

Outage flags and their notice due times (§5.7), offer notices (§5.6) and the
announcement-time affected sets of a permanent reduction (§5.4) are **deterministic
functions of the state at a log position**. The owner computes them off the batch path, in
bounded slices on a pinned generation, in the event loop's idle time while a batch commits
(a batch is mostly waiting on the network). Each output is written as projection and
outbox rows in the **next** batch transaction, with the projection's checkpoint row moved to
the position it reflects; it is identified by (link, causing sequence, kind, subject), so
any lease holder computes, and any consumer deduplicates, the same events; schedule-feed
events take their `feed_seq` in the batch that writes them. The reduction projection's
latest output, the parts `C_q` it cut as of position `q`, is what the owner proposes as the
input of `ReductionEffective` and the `ReductionStep` entries (§5.4): the steps' decisions
depend only on that recorded input and the state, never on a replica recomputing the
projection. A new lease
holder resumes each projection from its checkpoint row and re-emits at most what was
computed but not yet written (§8). RFC-000 §2 lists affected flags as derived state of the
link's log, not entries (AI-R1-6, adopted).

If the owner's event loop is short of idle time (a hot link in a flash crowd), projection
slices are not starved: a slice of at most 2 ms runs between batches whenever a
projection's lag passes 1 s, and the R1 spike measures whether the hottest link needs the
projections moved to its standby, which applies the same log (R1-5).

#### 7.6 Standbys, checkpoints, compaction and retention

- **Hot standbys** (RFC-006 §4.4; review 17, R1-02). Every link slot has a hot standby in
  the other facility of the leader region and one in the second Kenyan region (RFC-006
  provisions them, AI-R1-12). The holder **pushes** every committed batch (entries,
  sequence range, `ts`) to both over gRPC; a standby applies a push only if it continues
  the sequence it holds. A gap is filled by reading the missing rows as a **bounded span**
  `(link, seq) ∈ [held + 1, pushed first − 1]` of rows already committed, which records
  nothing in the timestamp cache above them, and never the head row. The backstop is a
  **follower read** below the closed timestamp every `standby_poll` (250 ms), served by a
  replica in the standby's own facility. Revision 3's 100 ms consistent scan of the tail at
  the leaseholder put the tail into the timestamp cache at the present time and pushed
  about 10 to 20% of the hottest link's batches (est.); none of these reads can push a
  batch (§7.2 step 5). A standby applies each entry with the owner's code, checks its
  outcome, and so holds the owner's state about 1 to 10 ms behind (est.).
- **Checkpoints** are taken by a standby, every 10 min or 1 M entries, whichever comes
  first, from a pinned generation without pausing its apply, written to two-region object
  storage (RFC-006) and recorded by the owner in a `Checkpoint` entry with the state
  digest. They serve a new standby and the cold path of §8; the normal takeover uses a
  standby that already holds the state.
- **Compaction.** A daily `Compact(through = now_m − 1 day)` folds keys below `through`
  into `carry` and drops parts, holds, offer holds and tombstones wholly in the past from
  memory; they remain in the log and in history. Nothing admission reads is lost: a
  window starts at or after its receipt minute (V4), and a hold reaches the link within its
  deadline of receipt (at most 60 s), so every window being decided starts after
  `now_m − 2 min`, a day above `through` (review 17, R1-22).
- **Retention.** History seals the log into segments kept 7 years (POL-19, X2-N6); once
  sealed and verified, the live tail is truncated from the database by RFC-006's
  truncation job, the only holder of the delete grant, below audit's verified
  sealed-through watermark (RFC-000 §5.5, revision 4.1, AI5-8), so a link keeps only hours
  of log in the database (§9). The owner and its standbys never delete log rows. Audit's
  and history's reads of the log are follower reads or changefeed reads, never reads of the
  live tail at the present timestamp.

### 8. Crash, takeover and failover behaviour

**Takeover.** Owner leases are a session row per process, renewed, plus a slot row naming
the holder session and the epoch, changed only on acquisition and handoff (RFC-000
revision 4.1, AI6-1). A lease holder stops deciding, granting read access and sending
commands at its session's expiry less `ε` by its own clock (RFC-000 §5.2). A standby
acquires the slot row once the holder's session has expired by the database's clock,
incrementing the slot's epoch and revoking the expired session, so no renewal of it can
commit afterwards (RFC-000 AI-R6-1); it then reads the log and head rows past its applied
sequence at the present timestamp, as a **high-priority** transaction (RFC-000 AI-17-4):
an in-flight batch of the old holder is resolved by that read, and one still pending (its
holder paused inside the transaction) is pushed rather than waited for, so its commit
fails at its fixed timestamp and the epoch condition would fail it anyway; the
idle-in-transaction and transaction timeouts (§7.2) abort it besides (review 17, R1-10).
It applies what it read, commits
`Takeover(epoch)` as its first batch, rebuilds its timers from state (expiry requests for
holds past `D`, `ReductionStep` for reductions past `T_eff`, offer-lapse backstops,
effective boundaries, due notices) and resumes each projection from its checkpoint row.
Expected time: the lease expiry (RFC-006 configures it; about 5 s at p99 with a hot
standby, est., as RFC-000 AI3-9 assumes for its standbys) plus milliseconds of catch-up and
one commit. **Cold path**, with no eligible standby: load the latest checkpoint (1 to 2 GB
at worst on the hottest link, about 5 to 10 s, est.) and replay at most 1 M entries (about
10 to 20 s in V8, est.), about 30 s in all, inside admission's 1 min RTO and
`release_grace`, alerted.

| Event | Behaviour | Effect |
|---|---|---|
| Owner instance or node lost | Takeover by a standby (above) | No fact lost (RPO 0); decisions and replies resume within admission's 1 min RTO, designed for about 5 s (est.) |
| A batch in flight when the owner dies | Atomic: committed or not; the successor's first read sees every entry the old holder will ever commit (RFC-000 §5.5). Nothing uncommitted was answered | Exactly the committed decisions stand |
| A reply lost in flight | The account owner retries with the same identity; the owner returns the recorded state (held, waiting, refused with the same recorded counter-offer, released, converted), from memory or, after a takeover, from the log | Exactly one effect per command (A6) |
| A command routed to a non-holder or with a stale epoch | Refused, `NOT_OWNER` (with a hint) or `STALE_EPOCH`; the sender re-routes | Never two writers |
| A deposed owner, paused, resumes | Its batch fails the epoch condition; its outbound commands carry the old (generation, epoch) and are refused by receivers that recorded a newer one; its notifications are idempotent state messages, harmless if repeated (RFC-000 §5.2) | Never two writers |
| A deposed owner paused **inside** an open batch transaction | Its transaction is aborted by the idle-in-transaction or transaction timeout below the lease margin; the successor's high-priority catch-up read pushes it meanwhile instead of waiting behind its intents (RFC-000 AI-17-4) | Takeover stays within seconds, inside `release_grace` (P1-S54, P1-S62, P2-S107) |
| A batch is pushed, conflicts, or its commit result is ambiguous | §7.2 steps 5 and 6: re-decided, or confirmed from the head row; nothing answered before | No decision made at a timestamp other than its own |
| The link fails over while a request ends | The release cannot become durable until the new holder applies it; the account owner re-sends releases for every ending entry without "releases durable"; the outcome is reported once it is durable, within seconds and at most `release_grace` (P1-S62, P2-S107). Nobody can book the link meanwhile | Capacity free from the report |
| The account owner is unavailable at a hold's `D`, or was in the last `ack_budget` before it | The link keeps the hold, asks for expiry, retries and alerts; the account owner's takeover and expiry entries bring the outcome within `release_grace` (P1-S54, P2-S104, P2-S106, P2-S114) | Never released under a confirmation |
| Hold, convert and release reordered or duplicated | Release before hold: the tombstone refuses the hold. Duplicate hold or convert: recorded state returned. Convert without hold: refused and alerted. Stale yield or displacement acceptance: no effect (attempt mismatch) | Port invariants (RFC-000 §8) |
| A range loses its leaseholder (database node loss) | Commits stall for seconds while the database moves the range lease; the owner keeps its owner lease, whose row's range moves the same way | Counts against admission's availability |
| The leader region is isolated or lost | The owner's commits need a majority and fail; its lease expires; placement moves leaseholders and owner leases region-wide to the second preference (RFC-000 §3, §5.1), where a standby takes over | Region RTO; nothing lost |
| Declared region disaster (on a recorded loss or on probe evidence, POL-06 as amended) | Commits reach R3: about 70 to 75 ms at p99 (est.), also after the automatic 2 + 2 reconfiguration; the admission tables, link tables included, keep a standing R3 non-voter, so they tolerate a further fault within minutes (RFC-000 revision 4.1, AI6-4) | Latency targets suspended (POL-06); nothing lost |
| Kafka unavailable | Outbox rows wait in the database; the changefeed relays them later; synchronous answers are unaffected; waiting-port notifications still go by gRPC. Notices due during the outage risk `affected_notice_time` and are alerted | Feeds delayed, nothing lost |
| A replica's apply diverges (a determinism bug) | The outcome check stops it at the first diverging entry; it is excluded from the lease and alerted (§7.4) | No wrong state can take over |
| Owner host clock leaves the bound | The host gives up its leases (more than 50 ms from the database's clock, RFC-000 §4.3) | A standby takes over |
| Hot link moved to another slot | `Moved(epoch)` in the old slot; the link's generation is incremented, the new slot's holder starts from a standby or checkpoint at that position, and its head row (keyed by link) and `feed_seq` continue; commands with the old (generation, epoch) are refused | One writer throughout |

### 9. Sizing for the hottest link at ×50

POL-06's design load is ×50 of today's; the hottest link takes 2,500 requests/s of it.
The mix is POL-06's (80% single-link, 20% routes, 70% fit); the rest are estimates.

| Quantity | Estimate | Basis |
|---|---|---|
| Hold entries | 2,500/s | POL-06 |
| Holds that hold | about 1,750/s | 70% fit (POL-06 mix) |
| Refusals | about 750/s, one entry each (the hold entry itself) | 30% |
| Releases after a hold | about 175/s | Route requests failing elsewhere, withdrawals, deadlines (est. 10% of holds that hold) |
| Conversions | about 1,575/s | Holds that hold less releases (review 17, R1-13) |
| Waiting marks, yields, grants, displacements | about 250/s | Est. at most 5% of requests contended (below) |
| **Entries** | **about 4,550/s**, sized for 20,000/s | RFC-000 §6 ("at least 5,000") |
| Batches | One slot batch in flight, the hottest link's slot carrying that link only (AI3-11); 33 to 66 a second at 15 to 30 ms a commit; about 75 to 150 entries each, at most `link_batch_max` (1,000) | RFC-000 §3, §6 |
| Rows per batch | About 150 log rows of about 250 B (with the encryption envelope), about 40 outbox rows (conversions and notifications), one head row: about 50 kB | Est. |
| Write rate into the database | About 2 to 3 MB/s for the hottest link, sent to each of four other voters; sequential keys, so all of it lands on the link's tail range, which load-based splitting cannot spread, at about 50 transactions/s, well within one range (R1-11) | RFC-000 §6 ("well within one range's write rate") |
| Live tail | About 110 GB a day of log per copy for the hottest link; sealed hourly by history and truncated after verification, so a few hours (about 15 to 30 GB per copy) | §7.6, RFC-006 |
| Apply CPU in V8 | About 10 to 40 µs an entry, plus about 10 to 20 µs of serialisation, encryption and gRPC per command: about 15 to 30% of one core at the design point. **Ceiling about 20,000 entries/s on one event loop** (est.), 4× the design point; about 40,000/s with serialisation, encryption and gRPC on worker threads | §7.4; the decision is in memory, the commit is the latency |
| Occupancy trees | At most about 530,000 keys each, three trees, about 80 MB of typed arrays (est.) | §3.2 |
| Confirmed parts | Sized for 10 M parts, about 1 GB of typed arrays with indexes (est.) | At any one minute a 100 Gbps link carries at most 100,000 parts of 1 Mbps; 10 M needs heavily fragmented future bookings |
| Holds in flight | About 190 at once | A hold lives about 75 ms from its commit to its conversion (RFC-000 §6) |
| Tombstones | At most about 114,000, about 6 MB (est.); about 85,000 at the default 30 s deadline | (750 refusals + 175 releases + about 25 waiters refused) a second × (`D` ≤ 60 s + `release_grace` 60 s) |
| Request records | In memory as the tombstones. `link_request`: about 2,500 rows a second, kept about 24 h, so about 216 M rows of about 45 B, about 10 GB per copy on the hottest link, spread over the table's ranges by request key (est.) | One row per request's final record, 24 h past `D` |
| Waiters | Typically tens (25 to 125 new a second, most resolved within about 75 ms); at most about 7,500 (125/s × 60 s, every one blocked to its deadline) (est.) | Contended share × waiting time |
| Generation copies while pinned | About 50 MB/s of copied nodes while a projection slice or a batch pins, retained milliseconds to seconds | §3.2 |
| Checkpoint | About 1 to 2 GB at worst; cold rebuild about 30 s (§8) | Only without a standby |
| Displacement markers | Written only by reductions: at most the holds in flight (about 190) per reduction on the hottest link; read by every confirm of a request holding here, as absent-key point reads served by the leaseholder, about 1,750 reads/s on the hottest link's marker range (est.), none of them a write | §5.1; RFC-000 §6 |
| Probe bookings | One probe account per account slot, each slot probed at least 3 times a minute from two locations (POL-06 as amended in `requirements-v1.8`): about 16,384 × 3 a minute, about 820 bookings a second (est.), each a hold, a conversion and a cancellation here, about 2,500 entries a second spread over the designated probe links, never the hottest link: about 64 probe links keep each below 40 entries a second | RFC-006 designates probe links (§10) |
| Standbys | Two per slot, each one core and the state's memory; fed by push (about 2 to 3 MB/s over gRPC), follower reads as the backstop | §7.6 |
| Link slots | The hottest links on dedicated slots; about 4,096 shared link slots, each lane about 0.15 occupied (est.) | RFC-000 revision 4.2, AI-17-5 |
| Link step in the single-link budget | `W_l` + one two-region transaction + apply: on a shared slot 20 + 30 + under 1 ms, about 50 ms; on the hottest link's dedicated slot 30 + 30 + up to 5, about **65 ms** at p99 (est.) | RFC-000 §3 wait table: single-link about 176 ms from R1 on a shared slot; on the hottest link about 186 ms plus up to 5 ms of apply, about 191 ms from R1 and 201 ms from R2 (est.). X2-S15 counts only links with no capacity in flight, which the hottest link never is; a request on it that exceeds `ack_budget` is answered `pending` (POL-04) |
| The link's part of `δ_x` | Hop + `W_l` + release commit: 5 + 20 + 30 steady (hottest link 5 + 30 + 30); 10 + 70 + 75 with R1 lost (hottest 10 + 75 + 75) (est.) | RFC-000 §4.3 revision 4.2: `δ_x` about 105 ms steady (115 ms on the hottest link), about 300 ms worst (305 ms); `δ_x_cfg` about 320 ms, `τ` about 420 ms. Lever before the 450 ms cap: releases ride the hottest slot's second in-flight batch (R19) |
| Capacity-decrease transactions | One of its own per outage or announcement, plus at most one retry (est.) | §5.1 |

**Share answered `pending` because of capacity in flight** (RFC-000 A0-19). A request
waits only if it fits on committed capacity but not beside the holds in flight, that is,
only when the link's free capacity at some minute of its window lies between its rate and
its rate plus the held Mbps there. About 190 holds are in flight, each for about 75 ms.
Under a flash crowd on one window, capacity fills within the first few requests and every
later one is a no-fit rejection, decided at once; the waiting phase lasts only while the
last free Mbps are held. The share is therefore estimated at **1 to 5% of requests on the
hottest link** (est.), and well below 1% on links that are not near full. Dropping the
older-waiter reservation (§4.1) can only lower it. The R1 spike measures it by replaying the
design mix against the state machine (Risks, R1-3).

**Throughput is not split.** A link has one writer (POL-05), so its ceiling is one event
loop's apply and one batch pipeline's. At about 20,000 entries/s (est.) against the
design's about 4,550 (RFC-000 §6 sizes for at least 5,000), the margin is about 4×, a fifth of revision 1's estimate for a native
apply thread; RFC-000 R5 and R19 keep it as a measured risk, and R1-7 states the levers.

### 10. Link registry (the link part of the catalogue)

The catalogue is RFC-003's component; its link part is specified here (RFC-000 §7, §8). It
is the reference data the link owner and every other owner validates links against.

| Field | Meaning |
|---|---|
| `link_id` | Immutable identity |
| `kind` | Share link (schedule kept here) or partner link (kept by the partner, served by a partner adapter, RFC-002) |
| `supplier` | The supplier account whose link it is: its users are the only principals that may book or cancel maintenance on it or change what it sells (POL-07, POL-32, X1-N10) |
| `endpoints` | The link's two termination points, for routing and for what a supplier sees (POL-33) |
| `initial_capacity` | For a Share link, its capacity at registration, which becomes `C_ref`. Current capacity lives in the schedule owner's capacity history, never here |
| `probe` | Whether it is a designated probe link, owned by the designated probe supplier (POL-06; RFC-006's probe designation) |
| `status` | `active`, `closing` (no new sale, hold, offer hold or maintenance accepted), or `retired` |
| `version`, audit fields | Every change with its pseudonymous principal, role and reason (X1-N8) |

- **Writer.** The catalogue's link-registry partition, on the same substrate (an
  insert-only log table under an owner lease, RFC-003's deployment). Commands come only
  through the operator console under RFC-005's authorisation, from an operator in
  **commercial** (POL-32 as amended, RQ-R1-7 decided; X1-S31); network operations and
  every other role are refused (X1-S13, X1-S23).
- **Registering** a Share link, for its supplier and with its capacity, makes placement
  assign it a slot, whose first entry for the link is `Init` with the record.
  **Retiring** takes two steps, so no sale can land between the emptiness report and the
  retirement (review 17, R1-19): the registry first records `closing`, which reaches the
  schedule owner as a `Registry(closing)` entry after which every hold, offer hold and
  maintenance booking is refused `LINK_CLOSING`; the owner then reports, from a position
  after that entry, whether anything is reserved, held, offered or booked as maintenance
  on it from then on (POL-07; normally after a permanent reduction to zero has taken
  effect); only if nothing is does the registry record `retired`, with the report.
  Otherwise the commercial operator may reopen (`active`) or wait.
- **Feed and query.** Every change is published on the registry feed (Kafka, ordered per
  link, at least once, idempotent by `(link_id, version)`) and served by `get_link`.
  Consumers: the link schedule owner (`Registry` entries), RFC-002 (route validation: the
  link exists, is active, its kind), RFC-003 (rating), RFC-004 (the supplier to settle
  with), RFC-005 (the supplier check of X1-N10), RFC-006 (probe designation).

### 11. Contracts

Semantics only; RFC-000 §8 names them, and the delivery phase fixes schemas and wire
formats. Synchronous commands are gRPC calls to the owner-lease holder of the link's slot;
every command carries `link_id`, the slot epoch it was routed with, the sender's
partition (generation, epoch) (RFC-000 §5.2, AI-R6-3) and its identity. Every command and
message the link sends carries the link's (generation, epoch).
Common errors: `NOT_OWNER` (with a hint) and `STALE_EPOCH` (re-route); `STALE_SENDER` (the
sender's (generation, epoch) is below the highest recorded for its partition: a deposed
sender); `UNAVAILABLE` (no commit possible; retry within the request's deadline);
`UNKNOWN_LINK`; `LINK_CLOSING` (holds, offer holds and maintenance only); `LINK_RETIRED`;
`MISMATCH` (same identity, different content: nothing changes, alerted). Commands are
answered once their batch transaction has committed, durable in two regions. Commands for
one link are applied in one total order, the link log's, which is the order they reach the
owner-lease holder (POL-05 as amended, §4.1); there is no order across links, and none by
the time an account received a request.

#### 11.1 Provided

**Link hold port** (synchronous commands; consumer RFC-002's account owner; RFC-000 §8).

| Operation | Input | Output | Errors | Idempotency |
|---|---|---|---|---|
| `hold` | request, account, leg, kind (`booking`, `change` with its reservation), rate, window, `D`, `D_c`, `request_age` (the priority key), **`wait`**, **receipt minute `m0`**, **policy version** (RFC-000 §8 revision 4.2, AI-17-1) | `HELD(attempt)`; `WAITING(attempt, ahead_deadline)`; `REFUSED(reason, counter_offer?, retry_after?)` with reason `NO_FIT`, `IN_FLIGHT` (`wait = false`, decided here: no waiter, no yields), `DEADLINE_PASSED`, `TOMBSTONED`, `INVALID(rule)` (judged against `m0` and the policy version). A refusal records a tombstone and **is** the release acknowledgement | common | By request, for the life of the request plus 24 h (§4.4): a repeat returns the request's recorded state here (held, waiting, refused with its counter-offer, released, converted); different content, `MISMATCH` |
| `convert` | request, **attempt**, reservation, part, `T_dec` | `CONVERTED(part)` | `NO_HOLD`, `TOMBSTONED` (protocol violations, alerted); `MISMATCH` (another attempt than the hold's) | By request |
| `release` | request, `D`, reason, decision time | `RELEASED`, sent once durable: the acknowledgement "releases durable" collects. Ends every hold, waiter registration and grant of the request, whatever the attempt, and tombstones it until `D + release_grace`, also for a request not seen | common | By request; a repeat is acknowledged again |
| `query` | request | Its state here and its tombstone expiry | common | Read |
| `end_leg` | reservation, leg, change id, effective minute, cause (cancel, shorten, revoke, release, terminate, move), decision time | `CHANGED`, once durable | `UNKNOWN_RESERVATION` (violation) | By change id |
| `reduce_parts` | reservation, leg, change id, `[(part, Mbps)]` newest part first, effective minute, cause (decrease, POL-07), decision time | `CHANGED`, once durable | `UNKNOWN_PART` (violation) | By change id |
| `offer_hold` | offer, reservation, account, **offer parts** `[(part, rate, original age, end)]`, `from`, `lapse_at`, decision time | `HELD`; `REFUSED(NO_FIT \| IN_FLIGHT, retry_after?)` | common | By offer |
| `offer_accept` | offer, `move_at`, decision time; sent at acceptance, before `move_at` | `ACCEPTED`: the offer parts are the reservation's parts on this link from `move_at`, with their original ages | `UNKNOWN_OFFER`, `TOMBSTONED`, `INVALID` (`move_at` before `ceil_minute(ts)`) | By offer |
| `offer_move_at` | offer, earlier minute boundary `T`, decision time | `MOVED` | `UNKNOWN_OFFER`, `INVALID` (unless `ceil_minute(ts) ≤ T < move_at` and `T` a boundary) | By (offer, minute) |
| `offer_release` | offer, reason, decision time | `RELEASED` once durable; tombstone until `lapse_at + release_grace` | common | By offer |

Port invariants (RFC-000 §8, A0R-03), all enforced in the apply: a release ends every hold,
waiter registration and grant of the request, whatever the attempt; a tombstone kept until
`D + release_grace` refuses any later hold or grant for it; no hold or grant is made at or
after `D_c`, hence never past `D`, and a waiter past `D_c` is skipped when granting; a
refusal records a tombstone and counts as the release acknowledgement; only a release, an
accepted yield or an accepted displacement ends a hold other than by its conversion.

**Link waiting port** (notifications to the account owner, and one command from it;
RFC-000 §8 revision 4.2, AI-17-2; review 17, R1-08). Notifications are outbox rows, pushed
by gRPC after commit and relayed through Kafka as the guaranteed path, at least once. Each
is an **idempotent state message** identified by **(request, attempt, kind)**, carrying the
link's (generation, epoch) and the log sequence it reflects. The consumer applies a message
whose identity it has not applied, whenever it arrives, with **no high-water rule** across
identities: a `GRANTED` lost on gRPC and relayed later is still applied. Within one identity
(only `WAITING_NOTICE` is re-sent with new content) it keeps the one with the highest
sequence. The account owner reconciles every request still waiting here with `query` on a
timer, which returns the request's current state, attempt and latest blocker deadline.

| Message | Direction | Content and meaning |
|---|---|---|
| `WAITING_NOTICE` | Link → account owner | (request, attempt, latest remaining deadline among this link's blockers); re-sent when it changes. Registration as a waiter is the `WAITING` answer to `hold` |
| `GRANTED` | Link → account owner | (request, attempt): capacity released to the waiter is now held for it, **at the waiter's attempt**, which the account owner records (§4.3) |
| `YIELD_REQUEST` | Link → account owner | (younger request, attempt, older request it blocks); at most one outstanding per (request, attempt) |
| `DISPLACED` | Link → account owner | (request, attempt (the one the marker carries), reduction and its record time, fits on committed capacity or not, counter-offer): a capacity reduction means the hold no longer fits (§5.1); the link keeps it until the account owner answers with `displacement_accept`, the request-scoped release, or, for a request that had begun committing, `convert` |
| `WAITER_REFUSED` | Link → account owner | (request, attempt, `NO_FIT`, counter-offer); tombstoned |
| `mark_waiting` | Account owner → link | (request, waiting or not, the account-log position it reflects); a command, applied only if newer than the last applied for the request |
| `yield_accept`, `yield_refuse`, `displacement_accept` | Account owner → link | (request, attempt); a stale attempt changes nothing; an accepted one registers the request as a waiter at attempt + 1 (§4.3, §5.1) |

**Link displacement read** (RFC-000 §8 revision 4.1, AI-R1-11, B-RQ-9; consumer RFC-002's
confirm transaction). A point read of `link_displacement(link, request)` inside the account
owner's serialisable confirm transaction, one per Share leg, made with the select grant
RFC-000 §5.5 gives the account owner's role on that table only.

| Result | Meaning | What the consumer must do (POL-07, B-RQ-9) |
|---|---|---|
| Present (attempt, reduction, record timestamp) | A reduction committed at a lower timestamp displaced the hold: the displacement record is visible, so the request **had not begun committing** | Not confirm in this transaction; decide the request against the reduced capacity (§5.1's first row), whether or not a partner confirm was already sent (a partner residue is then cancelled at Share's cost, RFC-002); answer `DISPLACED` with the release or `displacement_accept` |
| Absent | No reduction displaced the hold below the confirm's timestamp; any later reduction is ordered after the confirm | Confirm as usual; the link treats a later-displaced hold's `convert` as §4.4's exception |

Errors: none of its own (a database read; a retry error retries the confirm transaction).
Ordering: the database's serialisable order of the two transactions (§5.1). Idempotency:
a read. The link owner is the only writer of the markers (A1).

**Link availability query** (synchronous read; consumer RFC-002): `availability(window,
rate)` → largest rate, earliest window (or none, or "not found before T"), as-of
sequence; `fit_ranges(rate, from, until, k)` → up to `k` ranges and where to continue
(§4.2). Advisory, from the owner's latest committed generation; no idempotency needed.

**Link supply commands** (synchronous; from the supplier API through RFC-005's edge, and
from the operator console). RFC-000 §8 names all six (revision 4.1, AI-R1-10). Every
rise in sellable capacity (restoration, maintenance cancellation, increase) answers with
the boundary it takes effect from, `ceil_minute` of its record (§3.1, P1-S76).

| Operation | Who | Output | Refusals |
|---|---|---|---|
| `record_outage(key, to_capacity, attribution, reason)` | Supplier or network operations | `RECORDED(outage, level, effective from minute, capacity in force from then)`; `to_capacity` is a **level**, the capacity the link carries while the outage lasts (v1.8) | `INVALID` (not a whole number of Mbps from 0 to below the announced physical capacity) |
| `record_restoration(key, outage, to_capacity?)` | Supplier or network operations | `RECORDED(effective from boundary, capacity in force from then)`; with `to_capacity`, the outage's level rises to it | `UNKNOWN_OUTAGE`; `INVALID` (`to_capacity` not above the outage's level) |
| `book_maintenance(key, rate, window)` | Supplier | `CONFIRMED(maintenance)`; `REJECTED(NEEDS_COMMITTED)` stating wait or announce a permanent reduction; `REJECTED(NOTICE_TOO_SHORT, maintenance_notice)`; `REJECTED(IN_FLIGHT, retry_after)` | `INVALID` |
| `cancel_maintenance(key, maintenance)` | Supplier | `CANCELLED(free from boundary)` | `UNKNOWN_MAINTENANCE` |
| `announce_reduction(key, new_capacity)` | Supplier | `RECORDED(reduction, T_eff)`; a level, judged against the announced capacity whatever any outage | `INVALID` (not below the announced capacity `A_now`) |
| `record_increase(key, new_capacity)` | Supplier | `RECORDED(increase, announced from boundary, capacity in force from then)`; during an outage the capacity in force stays the outage's level (P1-S80) | `INVALID` (not above the announced capacity `A_now`) |

An unauthorised principal is answered `UNKNOWN_LINK` whatever the operation (X1-S22); a
network operations operator attempting maintenance, its cancellation, a permanent reduction
or an increase is answered `FORBIDDEN_ROLE` (X1-S23). Idempotency: by (link, principal's
account, key), for the life of the link, since each is a fact. Results that follow
(affected flags, cuts) are on the feed.

**Link schedule feed** (asynchronous, Kafka from the outbox; consumers RFC-002, RFC-003,
RFC-006). One partition key per link; every event carries the link's **`feed_seq`**,
contiguous per link across owner changes and moves (RFC-000 §4.4 revision 4.2, AI-17-2), so
a consumer applies events in `feed_seq` order, drops duplicates by it and knows a gap is a
missing event; events also carry their causing log sequence, (generation, epoch) and `ts`.

**Closed time** (RFC-000 §4.5 revision 4.2, AI-17-3; as RFC-003 revision 4 consumes it).
The link's schedule feed has a per-link **closed time**: the changefeed relay's resolved
timestamp over the link's outbox rows, published per link as `CLOSED(t, feed_seq)`
markers by RFC-006's relay, meaning every event of the link with a commit timestamp at or
below `t` has been published, up to that `feed_seq`. Every event's effective minute is at
or after its own `ts` (leg changes are recorded before their minute, §4.5), with one
exception, cut targets, effective at `T_eff` and decided after it, covered by two rules a
consumer applies for each **open reduction** `R` of the link, known from its
`CAPACITY_CHANGED(reduction announced, R, T_eff)` event: (1) until it holds every chunk of
`REDUCTION_EFFECTIVE(R)`, it closes no reservation on the link past `T_eff`; (2) then, until
`REDUCTION_FINAL(R)`, it closes no reservation of `A_R` past `T_eff`. Rating takes each
reservation's closure as the least of its lifecycle closure, each of its links' closed
times, and these holds (RFC-000 §4.5).

| Event | Content | Consumers |
|---|---|---|
| `LEG_CONFIRMED`, `LEG_CHANGED` | Reservation, parts, rates, windows, ages, effective minute, cause, known time | RFC-006 (history); RFC-003 if it reconciles legs with the reservation lifecycle feed |
| `CAPACITY_CHANGED` | Kind (outage, restoration, maintenance, maintenance cancelled, reduction announced with `T_eff`, increase), the **level** stated, ranges, effective boundary, the resulting capacity in force (`K_s`, `K_p` pieces), attribution, pseudonymous principal | RFC-006 (history, notifier, alerting); RFC-003 (maintenance accrues nothing) |
| `AFFECTED_CHANGED` | Reservation, part, minute ranges (open-ended allowed), cause, notice due time; and the notice events when due | RFC-002 (route-level affected), RFC-006 (notifier: holder and network operations) |
| `OFFER_AFFECTED` | Offer, minute ranges from when, notice due time | RFC-002 (tells the offer's holder, P1-S68) |
| `REDUCTION_AFFECTED` | Reduction, `T_eff`, `[(reservation, part, cut Mbps)]`, as-of sequence: the projection during the notice (§5.4) | RFC-002 (equivalent-path offers) |
| `REDUCTION_EFFECTIVE` | Reduction, `T_eff`, `L_R`, as-of position `q`, chunk `i` of `n`, up to 1,000 reservations of the affected set `A_R` (fixed at `T_eff`); a late extension chunk only after `REDUCTION_SET_EXTENDED` | RFC-002, RFC-003 (closure held for `A_R`), RFC-006 (history) |
| `CUT_DECIDED` | Reduction, reservation, `r` or `none`, effective `T_eff`: the same decision the `cut_target` command carries | RFC-003 (closure), RFC-006 (history); RFC-002 takes the command |
| `REDUCTION_FINAL` | Reduction, `T_eff`, count of targets sent | RFC-002, RFC-003 (closure released for `A_R` once each target is applied in the lifecycle), RFC-006 |
| `CLOSED` | Closed time `t`, `feed_seq` | RFC-002, RFC-003, RFC-006 |
| `ALERT` | `CONFIRMED_AFTER_REDUCTION` (with the reduction, its record timestamp and `T_dec`), `NO_HOLD`, `UNDECIDED_PAST_DEADLINE`, `CUT_TARGET_INEXACT`, `REDUCTION_SET_EXTENDED`, `REDUCTION_DEFERRED`, outcome mismatch on replay, cold rebuild, batch retries by cause | RFC-006 (alerting) |

Hold events (held, waiting, granted, refused, released, converted, displaced) are not a
separate feed: history and alerting read them from the log through its changefeed. Probe-
link facts carry the probe flag so consumers that rate, settle or report exclude them
(POL-06).

**Catalogue link registry** (§10): `register_link` (supplier, endpoints, capacity) and
`retire_link`, commands through the operator console by commercial, idempotent by key;
`set_probe` (RFC-006's designation); `get_link` (query); the registry feed (by `(link_id,
version)`). Consumers: RFC-001, RFC-002, RFC-003, RFC-004, RFC-005, RFC-006.

**History query semantics** (storage RFC-006): `schedule_as_known_at(link, T)` and
`schedule_as_recorded_at(link, T)` as defined in §6; each result names the log sequences
it reflects.

#### 11.2 Consumed

| Contract (owner) | What this RFC needs from it |
|---|---|
| Outcome and expiry port (RFC-002) | Outcome notices, which arrive as `convert` (with the attempt) or `release`; the answer to "expire if undecided" with the committed outcome (confirmed with `T_dec`, or not); `yield_accept` and `yield_refuse` by (request, attempt); `displacement_accept` by (request, attempt); a request already confirmed stays confirmed and is flagged affected here (RFC-000 §8, v1.6). RFC-002 records the attempt `HELD`, `GRANTED` and `DISPLACED` carry, never numbering a grant itself (§4.3) |
| Reservation command port (RFC-002) | `cut_target(link, reduction, reservation, T_eff, r \| none)`, one per reservation of the affected set, `none` included, idempotent by (link, reduction, reservation); RFC-002 composes a reservation's targets by `min`, ignores a target from a link the reservation has left by `T_eff`, and changes every leg, this link's included, through `end_leg` or `reduce_parts` (§5.4). On a move's acceptance RFC-002 sends the old link `end_leg` from `move_at` at once, dated in the future (§5.6) |
| Principal and authorisation context, operator action envelope, audit record (RFC-005) | The authenticated pseudonymous principal and role on supply and registry commands; the supplier check of X1-N10 (repeated here against the registry) |
| Payload encryption (RFC-005) | Envelope encryption of every entry's payload, keys in Kenyan HSMs |
| Substrate conventions (RFC-006) | The database topology at 2 + 2 + 1 with leaseholders preferred in R1; log-table schema conventions; owner leases as session rows plus slot rows with epochs (AI6-1), acquisitions revoking the expired session (AI-R6-1), per-slot epoch-conditional batch transactions (AI3-11); per-partition generations and partition-keyed head rows (AI-R6-3); per-stream contiguous sequences (`feed_seq`, AI-17-2); idle-in-transaction and transaction timeouts below the lease margin and high-priority takeover reads (AI-17-4); about 4,096 shared link slots by the occupancy target, with `W_l` and `δ_x_cfg` including the batching waits, and the hottest slots' second in-flight batch as the lever (AI-17-5, R19); insert-only log tables with the separate truncation role (AI5-8); row-level TTL for `link_request`; the select grant on `link_displacement` for the account owner's role (AI-R1-11); the standing R3 non-voter for admission tables (AI6-4); region-wide placement of leaseholders and owner leases; the transactional outbox, changefeeds, the relay's per-link `CLOSED` markers and Kafka topics; `ε` (`max_offset`, 100 ms) and the clock discipline; a checkpoint store (RFC-006's review 20, R6-25, to define); hot standbys for link slots fed by push with follower-read backstop (RFC-006 §4.4, AI-R1-12); the client-side retry protocol keeping a transaction's intents across a restart (§5.1); the operational alert feed |
| Catalogue probe designation (RFC-006) | The probe flag on links; enough designated probe links for about 820 probe bookings a second (§9) |
| Equivalent-path source (routing) | Not consumed here: RFC-002 chooses paths and sends `offer_hold` (RFC-000 §8) |

### 12. Design-level acceptance tests

| # | Test | Scenarios |
|---|---|---|
| T-01 | **Oracle.** Random schedules, holds, conversions, releases, leg changes and capacity changes over a year's minutes; every decision equals a per-minute array oracle's (D9), and the three occupancies equal sums recomputed from the facts | P1-S01 … S06, S37, S39 |
| T-02 | **Invariant I1** checked after every entry from the facts alone; the only minutes above `C_ref` are explained by later reductions and by confirmations that completed across one, each flagged and alerted | P1-S05, S13, S63 |
| T-03 | **Arrival order.** Concurrent random load through the batch pipeline; the outcomes equal those of checking the commands one at a time in log order, each counting the holds then in place; a `wait = false` refusal stays refused after the blocking hold's release; two accounts' requests delivered to the owner in the reverse of their accounts' receipt order are checked in the owner's order | P1-S13, S14, S77, P2-S112 |
| T-04 | **Counter-offers** against the oracle, beside held capacity, including open-ended requests, a schedule full for ever (`last_above` "for ever"), several blockers, the step bound and the per-batch step budget (equal outcomes on two machines of different speed), the cache invalidated by a hold between two refusals, and a retry after takeover, and after 24 h less a minute, returning the recorded counter-offer | P1-S12, S15, S16, S38, S39, S70, S73, P2-S18 |
| T-05 | **Validity** rules V1 … V6 at the edges, calendar-month horizons in UTC including month ends and 29 February, with the hold reaching the link one minute boundary later than receipt, and a request received at hh:mm:59.98 whose intake commits after the boundary (valid from hh:mm, judged on the carried receipt minute) | P1-S19, S20, S74 |
| T-06 | **Open-ended and horizon roll**: advance `ts` by days and months; no new sale takes an open-ended reservation's minutes | P1-S21, S22, S23 |
| T-07 | **Holds and waiters**: hold, wait, grant in priority order, `wait = false` refused at the link with `retry_after` and a tombstone (no waiter, no yield request raised), waiter refused when the request ahead converts, scan budget exhausted with a scan-pending range and a new hold behind it | P1-S07 … S12, S34, P2-S16, S20, S52 |
| T-08 | **Priority and yields**: crossings, three-cycles, a holder without the waiting mark not asked, commit-fence skipping, `retry_after` across several blockers and legs; review 17's loop (O needs 6, Y holds 3, 1 free: Y not asked; with yields sufficient, Y not re-granted while O's claim is live); attempts: a grant keeps the attempt, a yield and an accepted displacement increment it, `convert` with a wrong attempt refused `MISMATCH` | P2-S15, S19, S58, S60, S87, S88, S95, S97, S116 |
| T-08b | **Notifications as state messages**: drop the gRPC push of a `GRANTED` and deliver it by the relay after a newer `WAITING_NOTICE` of another request; it is applied; duplicates by (request, attempt, kind) ignored; `query` reconcile restores a lost notice | P1-S11, P2-S16, S61, S95 |
| T-09 | **Port invariants**: release before hold, duplicate commands, stale attempts, convert without hold, hold at `D_c` | P1-S08, S18, P2-S14 |
| T-10 | **Takeover and batch failure**: kill the owner at every entry kind and at every batch step (before commit, during commit with an ambiguous result, after commit before replies); push batch timestamps; pause a deposed owner and resume it, and pause one **inside** an open batch transaction after its inserts (the successor's high-priority read pushes it, the timeouts abort it, takeover within 5 s); replies retried; releases durable within `release_grace`; expiry requests resent; hot-standby and cold-path takeover times measured | P1-S54, S62, P2-S104, S106, S107, S114 |
| T-11 | **Outages**: flags at exactly the overcommitted minutes, all alike, open-ended, from the minute of the record to the boundary of the restoration; due times; recomputation and notices when a reservation ends inside an outage; notices written within the link's 10 s budget with a webhook endpoint down | P1-S24 … S27, S40, S48 … S51, S72, S75 |
| T-12 | **Displacement**: a hold that has not begun committing is rejected or turned into a waiter; one that had begun completes, flagged and alerted; a confirm racing the reduction's transaction both ways on a real 2 + 2 + 1 cluster (reduction first: the confirm sees the marker and does not confirm; confirm first: the reduction's transaction is pushed, re-decided, and the later `convert` is flagged and alerted); **on the hottest link's design load and in a flash crowd**, the capacity-decrease transaction's retries counted (target: at most one, the restart keeping its intents) and the confirms' lock waits measured; markers deleted with the attempt they mark | P1-S41, S42, S63, S78 |
| T-13 | **Maintenance**: notice by calendar date, beside committed and held capacity, `retry_after` when only holds block it, cancellation free from the boundary | P1-S28 … S30, S66, S67 |
| T-14 | **Permanent reductions**: newest part first, own ages, the largest excess per part against `L_R`, the affected set fixed at `T_eff` from the projection and published in chunks, cuts decided in steps over `C_q` only, equal to the full greedy at `T_eff` (oracle), the final step's excess check, one `cut_target` per reservation of `A_R` (`none` included), `REDUCTION_FINAL`, the closed-time holds, recomputation when the schedule changes during the notice, a projection deliberately short (`REDUCTION_SET_EXTENDED`), `CUT_TARGET_INEXACT` on an extension part | P1-S31, S32, S35, S36, S43 … S47, S52, S64, S65 |
| T-15 | **Offer holds and moves**: counted as committed, no waiting on them, offer parts with original ages, accept, earlier move (refused if in the past), decline, lapse, failed partner leg, an outage on the offered path; the old link's `end_leg` from `move_at` recorded before it, so its `T_eff` cuts nothing of the moved reservation; a reduction on the offered link meeting the offer parts by age | P1-S53, S55 … S61, S68, S71 |
| T-16 | **Known-at**: rebuild `schedule_as_known_at` from sealed segments and compare with the state at each position | P1-S33 |
| T-17 | **Determinism**: replay the same log on two builds and on a standby; every entry's outcome equal; checkpoint digests equal | All (I5) |
| T-18 | **Load**: the design mix at 2,500 requests/s on one link for one hour on the 2 + 2 + 1 database, one NestJS owner and two standbys fed by push; p99 of the link step with `W_l`, event-loop utilisation and GC pauses, batch size, projection lag, share answered `pending`, **batch retries by cause** (§7.2 step 5: none from standbys, history or audit) | X2-S03, S05, S15 |
| T-19 | **Supply and registry authorisation**: every principal and role against every supply and registry command | X1-S13, S22, S23, S31 |
| T-20 | **Every rise in sellable capacity** (restoration, increase, maintenance cancellation): effective from the boundary at or after the record, including a record exactly on a boundary (the timestamp controlled), with the recording entry and later commands of its batch seeing it; no reservation changed by an increase, during an outage and during a reduction's notice; a maintenance cancellation under way frees only `[b, e)` |
| T-21 | **Capacity levels** (review 17, R1-01): every pair, and random sequences, of overlapping capacity facts (outages, partial restorations, reductions with their notices, increases) in every order, cross-checked after every entry against a **level oracle** that recomputes `A_s`, `A_p`, `K_s`, `K_p` and each reduction's `L_R` from the facts alone; review 17's cases (a) … (d); validity of reductions and increases against `A_now` whatever the outages | P1-S24, S27, S43, S44, S49, S69, S79, S80 |
| T-22 | **Retirement**: a sale attempted between `closing` and the report is refused `LINK_CLOSING`; retirement only on an empty report | P1-S32, X1-S31 | P1-S27, S40, S67, S69, S76 |

### 13. Traceability

**P1 scenarios** (all primary in this RFC). Rows marked * are new or changed in
`requirements-v1.6`; rows marked † are new or changed in `requirements-v1.7`; rows marked ‡
are new or changed in `requirements-v1.8`.

| Scenario | Approach |
|---|---|
| P1-S01 | §3.1, §3.2 (peak query and example), §4.1 |
| P1-S02 | §3.2 (peak, not sum), §4.1 |
| P1-S03 | §3.2, §4.1 |
| P1-S04 | §2 (half-open windows), §3.1 |
| P1-S05 * | §3.4 I1, §4.1 (decided on `occ_all`), §5.1 (the exception for a request that had begun committing) |
| P1-S06 | §3.2 (`O(log m)` whatever the length), §4.1 |
| P1-S07 | §4.1 (waiting), §4.3 |
| P1-S08 | §4.4 (release, tombstone, free before the report) |
| P1-S09 | §4.4 (conversion leaves `occ_all` unchanged) |
| P1-S10 | §1, §3.1 (one schedule for single-link and route legs) |
| P1-S11 | §4.3 (scan and grant) |
| P1-S12 | §4.1 (`IN_FLIGHT` decided at the link from the hold's `wait`, `retry_after`, tombstone as the release acknowledgement), §4.2 (counter-offer beside held capacity) |
| P1-S13 * | §3.4 I1, §7.2 (one writer, one order), §5.1 (the exception) |
| P1-S14 *† | §4.1 (one at a time in the order they reach the schedule owner, counting holds then in place), §7.2 (batch order) |
| P1-S15 | §4.2 (largest rate) |
| P1-S16 | §4.2 (earliest window) |
| P1-S17 | §4.2 (rates and windows only) |
| P1-S18 | §4.4 (release, tombstone); invalid and insufficient funds never reach the link (§2; RFC-002, POL-25) |
| P1-S19 | §2 (V1 … V6) |
| P1-S20 | §2 |
| P1-S21 | §3.1 (open-ended impulse) |
| P1-S22 | §3.1, §3.2 (no horizon in the structure) |
| P1-S23 | §2, §3.1 |
| P1-S24 | §5.2 (an outage to a level, from the minute of its record), §3.1 |
| P1-S25 | §5.7 (all alike) |
| P1-S26 | §5.7 (due at the record) |
| P1-S27 | §5.2 (restoration at its boundary), §3.1, §4.3 |
| P1-S28 | §5.3 |
| P1-S29 | §5.3 (step 3) |
| P1-S30 | §5.3 (step 2) |
| P1-S31 | §5.4 (newest first, projection to RFC-002 for the offer) |
| P1-S32 | §5.4 (cut at `T_eff`, revoke) |
| P1-S33 | §6 |
| P1-S34 | §4.1 (`WAITING` answered at once; the account owner answers `pending`, RFC-002) |
| P1-S35 | §5.6 (`offer_accept`; the old link's `end_leg` from `move_at` recorded before it, moving mark), §5.4 (no cut on a moved reservation), §4.5 |
| P1-S36 | §5.4 (cut at `T_eff` on decline) |
| P1-S37 | §4.1 (no fit only on `occ_firm`), §3.4 I2 |
| P1-S38 | §4.2 |
| P1-S39 | §2 (a capacity answer), §4.2 |
| P1-S40 *† | §3.1 (every rise from the first boundary at or after its record), §5.2 (flags end there), §5.7 (restoration notices) |
| P1-S41 * | §5.1 (displacement of a request that has not begun committing) |
| P1-S42 * | §5.1, §4.3 (waiter refused for no fit) |
| P1-S43 | §5.4 (sellable reduction from the announcement) |
| P1-S44 | §3.1 (`A_p` lowered only from `T_eff`), §5.4, §5.7 (flags against `K_p`) |
| P1-S45 | §5.4 (cut at `T_eff`); lapse is RFC-002's |
| P1-S46 | §3.3 (part ages), §5.4 |
| P1-S47 | §5.4 (just enough Mbps against `L_R`; a cut target `r`; fee-free cancel via RFC-002) |
| P1-S48 | §5.7 |
| P1-S49 | §5.2 (open-ended reduction) |
| P1-S50 | §5.7 (flag ranges; due at start) |
| P1-S51 | §5.2 (attribution), §5.3 |
| P1-S52 | §5.4 (partial cut as a cut target), §5.6 (whole reservation moves; never cut on the link it left) |
| P1-S53 | §5.6 (`offer_move_at`) |
| P1-S54 | §4.4 (expiry requests, hold kept), §8 |
| P1-S55 | §5.6 |
| P1-S56 | §5.6 (offer hold in `occ_firm`) |
| P1-S57 | §5.6 |
| P1-S58 | §5.4 (projection to RFC-002, which orders paths) |
| P1-S59 | §5.6 (no partner hold) |
| P1-S60 | §5.6 |
| P1-S61 | §5.6 (`offer_release`) |
| P1-S62 | §4.4, §8 (release durable once the lease is held again) |
| P1-S63 *‡ | §5.1 (a request whose confirm did not see the displacement record completes: POL-07's only sense of "begun committing", B-RQ-10), §4.4 (a displaced hold's conversion flagged, notice written at once, alert), §5.7 |
| P1-S64 * | §5.4 (affected set follows the schedule; offer stays open; cut never more than then required) |
| P1-S65 * | §5.4 (largest excess per part, newest first) |
| P1-S66 * | §5.3 (step 4: `retry_after`, not queued) |
| P1-S67 *† | §5.3 (cancellation), §3.1 (first boundary at or after the record) |
| P1-S68 * | §5.6 (offer hold not flagged; `OFFER_AFFECTED`), §5.7 |
| P1-S69 * | §5.5 (permanent increase, a level from its boundary), §3.1 |
| P1-S70 * | §4.1 (`retry_after` the latest blocker), §4.2 |
| P1-S71 * | §5.6 (`offer_accept` with original ages), §5.4 |
| P1-S72 * | §5.7 (recomputation and notice when affected minutes change), §4.5 |
| P1-S73 * | §4.2 (every counter-offer beside held capacity) |
| P1-S74 * | §2 (calendar-month horizon from the minute of receipt) |
| P1-S75 * | §5.7 (notice events on time; "told" completed by the notifier, RFC-006) |
| P1-S76 † | §3.1 (a rise recorded on a boundary takes effect in its own entry), §5.2 (restoration), §5.5 (increase), §5.3 (maintenance cancellation), §11.1 (supply answers) |
| P1-S77 † | §4.1 (the order of reaching the owner, not of the accounts' receipt; `IN_FLIGHT` with Y's remaining deadline), §7.2, §11 |
| P1-S78 †‡ | §5.1 (judged by the displacement record's visibility, POL-07 alone; marker intents written first in the decrease's own transaction, read in the confirm's), §4.3 (the marker's attempt), §4.4 (a displaced hold converted: flagged and alerted), §7.1 (`link_displacement`), §11.1 (link displacement read) |
| P1-S79 ‡ | §3.1 (levels; worked case), §5.4 (`L_R` the announced level at `T_eff`: B cut by 2 only, whatever the outage), §5.7 (flags against the capacity in force while the outage lasts, none after its restoration), T-21 |
| P1-S80 ‡ | §3.1 (capacity in force the minimum of the announced capacity and the outage's level), §5.5 (an increase during an outage raises the announced capacity only), §5.2 (the restoration at 09:40:00 effective from 09:40, the glossary's exact times), §11.1 (supply answers), T-21 |

**Scenarios of needs allocated jointly** (RFC-000 §7: "also RFC-001"). The primary RFC
satisfies each; this RFC provides the link-side part named. Scenarios of these needs with
no link-side behaviour are listed as such.

| Need (primary) | Scenarios with a link-side part | Link-side part | No link-side part |
|---|---|---|---|
| P2-N3 (RFC-002) | P2-S13, S14, S55, S56, S93, S101, S104, S106, S107, S110, S114 | §4.1 (`D_c` refusal), §4.4 (request-scoped release, tombstones, expiry requests, hold kept while the decision record is or recently was unavailable), §8 | P2-S11, S12, S53, S57, S86, S100, S103, S105, S109 (deadline values, partner holds and fees, decision entries) |
| P2-N4 (RFC-002) | P2-S15, S16, S17, S18, S19, S20, S21, S52, S58, S59, S60, S61, S62, S87, S88, S92, S95, S97, S116 | §4.1, §4.3 (priority, arrival order, scan, yields, commit fence, waiting notices with the latest blocker) | P2-S89, S96 (partner adapters) |
| P2-N9 (RFC-002) | P2-S43, S44, S45, S46, S47, S48, S74, S79, S80, S81, S84, S85, S94 | §4.5 (leg changes; extensions and increases as new admissions), §4.4 (a pending change released when its reservation ends) | P2-S49, S50, S75, S76, S77, S78, S82, S83, S115 (change rules, funds, partners) |
| P2-N11 (RFC-002) | P2-S02, S73 | §4.1 (refusal names this link by being its answer), §4.2 (`availability`, `fit_ranges`) | P2-S31 (partner) |
| X1-N10 (RFC-005) | X1-S22, X1-S23 | §5 (supplier and role check against the registry), §11.1 (supply refusals) | — |
| X2-N2 (RFC-006) | X2-S03 | §9 | X2-S04 (metering) |
| X2-N3 (RFC-006) | X2-S05, S06, S15, S23 | §3.2 (`O(log m)`), §9 (link step), §8 (disaster) | X2-S07, S08, S13, S17, S19, S22, S25, S26 (other operations; the disaster declaration) |

**Link-side rows of scenarios outside the allocation.** P2-S112 (P2-N8, RFC-002/RFC-004):
the `IN_FLIGHT` refusal with `retry_after` that makes R1 fail at once (§4.1). X1-S13 and
X1-S31 (X1-N7, X1-N8, RFC-005): the registry's role check, network operations refused and
commercial accepted for registering and retiring a link (§10). X1-S13's row added in
`requirements-v1.7` (support refused an erasure) and the v1.7 changes to X1-N7 (erasure by
compliance; withholding a termination notice decided with the termination) have no
link-side part: a termination reaches the link as `end_leg` with cause `terminate`
whatever is decided about its notice (§4.5), and the link holds no personal data (§5).
`requirements-v1.8`'s other changes reaching this RFC's citations have no link-side part:
P2-N8 and POL-25 (key spending counts the parts a key booked or added: RFC-002), POL-08
(minimum-term fees: RFC-002, RFC-003), POL-16 (resume amount: RFC-004), POL-19, POL-32,
X1-N7, X1-N8, X1-N11 (erasure channels, four eyes, account recovery, audit under physical
access: RFC-005; the link log stays free of personal data and insert-only, §5, §7.1), POL-26
(the commit fence is a fence only, which §4.1's `D_c` already is). POL-04's shared
deliveries are the notifier's (§5.7), and POL-06's three probes a minute per account slot
are sized in §9.

**Coverage.** P1: 80 of 80 scenarios designed for here (13 new and 6 changed in v1.6; 3
new, P1-S76 … S78, and 3 changed, P1-S14, S40, S67, in v1.7; 2 new, P1-S79, S80, and 2
changed, P1-S63, S78, in v1.8).
Jointly allocated needs: 82 scenarios, 52 with a link-side part provided here (45 of P2,
2 of X1, 5 of X2) and 30 without one; every one of the 82 is satisfied by the primary RFC
named.

## Benefits

| Target or policy | How this design meets it |
|---|---|
| Never oversold (P1-N1, POL-05) | One writer per link (the owner-lease holder, every batch conditional on its epoch), and invariant I1 checked on every addition; holds count against the link until the account owner ends them (A9). The only confirmations above a reduced capacity are those v1.6 allows, each flagged and alerted; "had begun committing" is judged exactly by whether the confirm sees the displacement markers the reduction wrote (§5.1, B-RQ-9). Capacity is kept as levels, so no order of outages, reductions and increases can make the link sell what it does not carry (§3.1, I6, T-21) |
| Requests that fit are confirmed (P1-N2) | The check is the peak, not a sum or a gap (D6); no fit is decided only on committed capacity; checks run one at a time in the order requests reach the owner, which is log order, counting the holds then in place (POL-05, P1-S77) |
| Cost independent of booking length (X2-S05) | Two point updates and `O(log m)` queries, `m` at most about 530,000 keys (est.); open-ended bookings need no horizon at all |
| Hottest link at ×50 (POL-06, X2-S03) | About 4,550 entries/s in batches of about 75 to 150 against an apply ceiling of about 20,000/s on one event loop (est.), 4× margin; the latency is the two-region transaction and the batching wait (link step about 65 ms p99 on the hottest link and about 50 ms on a shared slot, est.), not the decision; no reader pushes the batches (§7.2). The pre-baseline draft's link-row lock measured p99 115.5 ms with 50 clients on one link, without any two-region commit (D12) |
| One schedule, one priority rule (P1-N3, POL-02) | Single-link and route legs, waiters and yields all in one log; released capacity to the oldest waiter it fits, in the entry that frees it; yields only from waiting holders |
| Rejections actionable and discreet (P1-N4, POL-10) | Largest rate and earliest window from the same tree, beside held capacity, recorded with the refusal; no identities |
| Holds outlive no outcome, and late commands recreate none (POL-26, A0R-03) | Request-scoped releases, tombstones until `D + release_grace`, refusal at `D_c`, decided at the entry's own commit timestamp |
| Loss of supply never revokes silently (P1-N8, POL-07) | Capacity as levels, in force the minimum of the announced capacity and the open outages; sellable and physical announced capacity kept apart; every rise effective from the first boundary at or after its record, falls at once; flags exact against the capacity in force, all alike, recomputed and re-notified when they change; newest-first cuts by the largest excess over the announced level at `T_eff`, never before, never more than needed and never because of an outage; a moved reservation never cut; one cut target per affected reservation, so rating closes exactly; firm offer holds counted as committed and not flagged |
| Known-at history (P1-N9, POL-19) | Every fact carries its known time and commit timestamp; the log replays to any position; the index is rebuilt from sealed segments |
| Failover (X2-N5) | Hot standbys hold the state; takeover is a lease expiry plus milliseconds of catch-up, designed for about 5 s (est.), inside `release_grace` (1 min); a cold rebuild about 30 s |
| Policy changes without mechanism changes | Every parameter and the priority comparator come from `Policy` entries |

## Competition

| Alternative | Why it loses (or where it wins) |
|---|---|
| **Pre-baseline RFC-001: dense impulse segment tree in memory, Postgres link-row lock as the authority** (D5, D11, D12) | Its model **wins and is kept**: pulses and impulses, the `sum`/`maxpref` monoid, facts only (D10), the horizon checks (D30). Its authority loses: one transaction per decision behind the link-row lock, measured p99 115.5 ms at 50 clients without a two-region commit, about one decision per transaction time; correctness depended on the isolation level (`REPEATABLE READ` oversold, D12); the lock queue cannot express POL-02. Revision 4's database is used as a log under one writer, deciding in memory and committing batches, which the row lock could not do |
| **Revision 1 of this RFC: a custom Raft group per link, followers holding the state** (RFC-000 revision 3.2) | Pipelined group commits every 5 ms (no batching wait) and followers that hold the applied state, so a failover rebuilds nothing; and a native apply thread with about 20× headroom. Rejected by the coordinator's substrate decision (RFC-000 RK10, Competition): Share would build and operate consensus. Revision 2 recovers most of it with hot standbys (§7.6) and pays about 30 ms of batching wait on the hottest link and a smaller CPU margin (§9) |
| **Deciding in SQL: each hold a serialisable transaction reading the overlapping parts** | Many writers to one link's rows conflict and retry under contention, which wrecks the tail (history D3); a peak query over a year-long window reads thousands of rows; POL-02's priority cannot be expressed. The owner decides in memory and the database only orders and stores |
| **Dense ring segment tree over a minute array** (the prototype's in-memory structure, D11) | Faster by a constant (1.2 µs p50 measured, D12) and simpler per node. But it fixes the horizon in the structure (the D30 bug was a window past it), needs rebasing as the horizon rolls, and costs about 32 MB per occupancy per link whatever the link's activity, so about 100 MB for every cold link. The sparse B+tree has the same monoid and costs only its change points. Kept as an option for a hot link if the R1 spike shows the B+tree too slow (R1-4) |
| **Slot ledger: one row or cell per minute** (D7) | A year-long booking touches about 525,600 cells (X2-S05 fails) |
| **Change-point map without aggregates** (D9) | `O(log m + k)` per query for `k` change points in the window, and a long or open-ended window sees almost all of them |
| **Range-add, range-max segment tree with lazy propagation** (D9) | Same bounds; a booking is a range update instead of two point updates. No gain |
| **One occupancy plus a hold list, checked by summing overlapping holds** | Summing holds is an upper bound, not a peak, so it would put requests to wait (or reject them with `retry_after`) that fit. Two trees (D14) and a third for physical capacity cost about 80 MB on the hottest link |
| **State as ordinary JavaScript objects** | Simpler code, but 10 M parts and three large trees on the V8 heap make major collections take hundreds of milliseconds, on the hottest link's single event loop. Typed-array arenas keep the collector's heap small |
| **Protecting older waiters' needs in every check** (revision 1) | Kept a younger request from taking free capacity an older waiter would later need. `requirements-v1.6` decides that checks run one at a time in the order received, counting only the capacity then **held** (POL-05, P1-S14, B-RQ-1), which this would contradict; released capacity still goes to the oldest waiter it fits, through the scan |
| **Holds that expire at the link by a lease** (D13's "expiry on each hold as a backstop") | A link could release a hold under a confirmation still committing: an oversell or a partly booked route. Forbidden by A9 and POL-26; the link asks for expiry instead |
| **Wound-wait or priority tickets** (D17, the pre-baseline RFC-002) | The older request pre-empts any younger holder; POL-02 forbids pre-empting a holder that is not waiting |
| **Strict first-come-first-served per link** (head of line) | Makes every younger request wait behind an older one even when their windows do not conflict, contradicting POL-05's check against the capacity then held |
| **First fit among waiters, ignoring priority** | A stream of small younger requests could starve an older large one of released capacity; breaks POL-02 |
| **Re-validating every hold at the decision** (the account owner asks each link "still valid?" just before its confirm entry) | Closes the reduction interval completely, but adds one hop and one link commit to every booking (about +35 ms at p99, est.). The displacement marker read (§5.1) closes the same interval with one in-region read and no commit |
| **A bounded window for "had begun committing"** (RFC-002 revision 2's reading of B-RQ-9: a request counts as already committing if it proposed its confirm within a bounded interval after the record) | Needs no cross-owner read, but the bound is a parameter to justify and the judgement is not checkable from the records alone. `requirements-v1.7` decides the exact reading by visibility, which the marker read gives for one in-region read per leg |
| **Recording projections as log entries** (affected flags, announcement-time affected sets) | Makes history self-describing, but an outage on a busy link can flag 100,000 parts (est.): a long apply on the hottest link, inside the 200 ms path. The flags are a pure function of the log, so they are recomputable; only the cuts, which change state, are entries (`ReductionStep`) |
| **Computing a permanent reduction's cut in one entry** | A reduction to zero on a link with a million parts would stall the event loop for seconds. Bounded steps keep every entry a few milliseconds (est.) |
| **Recomputing counter-offers on a retry** | Needs the tree as it was at the refusal, which is not kept. Recording the counter-offer in the refusal entry costs a few bytes and makes every retry, across any takeover, return the same answer |
| **Capacity changes as deltas** (revision 3) | One impulse per fact, no profile. But deltas measured from a "current" capacity that includes outages do not compose: silent oversell, permanent cuts caused by outages, valid supplier commands refused (review 17, R1-01). Levels cost a small profile and a differencing step per capacity fact, which are rare |
| **Capacity as a fourth tree of levels, `min`-combined per query** | Exact without differencing, but every sales query would combine two trees per node, slowing the hot path for facts that change a few times a year. Differencing puts the cost on the capacity fact |
| **One log row per batch** (entries compressed into one row, as RFC-000 §6 does for metering) | Cuts about 150 key-value writes per batch to one on the hottest tail range, so a cheaper batch and less tail-range load (R1-11). Loses per-entry rows that history's changefeed, the outcome check and `link_request`'s pointer read directly, and one large row per batch makes a gap-fill all or nothing. Kept as the lever for the tail range if the spike shows it hot (R1-11) |
| **Standbys tailing by consistent SQL scans** (revision 3) | Simple, but a present-timestamp scan of the tail pushes the owner's fixed-timestamp batches, about 10 to 20% of the hottest link's (est., review 17, R1-02). Push plus follower reads (RFC-006 §4.4), or a rangefeed, never pushes; push is adopted, a rangefeed is the alternative if push proves lossy |
| **Floating timestamp for capacity decreases** (decide at a provisional timestamp, let the database refresh and push the commit) | Never retries, but the entry's minute could differ from its commit timestamp's (an outage dated a minute early, a notice a moment short), and the commit timestamp is not known before commit. Marker intents first keep the fixed timestamp exact (§5.1); this is the fallback if T-12 shows retries persist |
| **One cut rate per reservation in every case** (RFC-000 §8 as worded) | Simplest for RFC-002, and adopted as the interface; exact except for a reservation whose newest part has a later window than its others, where it over-cuts (alerted). A target per part (AI-R1-13) would be exact |
| **Deciding the cut at `T_eff` over every part of the link** (revision 3) | No dependence on the projection, but minutes of steps on a million-part link, all of them effective at `T_eff`. Steps over the projection's cut set, with a final excess check, bound the decision by the affected set |
| **Partitioning a hot link's schedule by time range** (two owners per link) | A window spans ranges, so every long booking would need a cross-partition commit, and POL-05 forbids two writers of one schedule |

## Risks and open issues

| # | Risk or issue | Mitigation or next step |
|---|---|---|
| R1-1 | **Confirmations across a reduction** (§5.1). The interval is closed (B-RQ-9, AI-R1-11 adopted); what remains is the accepted cost: a confirm ordered before the reduction whose `convert` arrives after it completes and is affected, and a capacity-decrease transaction pushed by a confirm's read inside its first statement's round trip is retried. That the retry keeps its intents, so a second push cannot happen, is an assumption about the database's client-side retry protocol | Each case flagged and alerted (`CONFIRMED_AFTER_REDUCTION`) and counted; T-12 measures retries on the hottest link's design load; fallback: the floating-timestamp variant (Competition), or the account owner's confirms on that link paused for one commit while a decrease is in flight |
| R1-2 | **Waiter scans under heavy contention**: cost grows with the waiters overlapping a changed range | Bounded by `scan_steps` with the remainder continued by a `Tick` and new holds behind a scan-pending range (§4.3); the R1 spike measures the worst flash crowd |
| R1-3 | **The share answered `pending`** on the hottest link is an estimate (1 to 5%, §9) | Measured in the spike (T-18) |
| R1-4 | **B+tree constants in V8** on the hottest link | Measured; fall back to the dense ring tree (Competition) for links above a change-point threshold, with the same monoid; or the trees as a native module behind the same interface |
| R1-5 | **Projection lag** against `affected_notice_time` (10 s budget here, 50 s to the notifier) on a busy event loop and after a takeover | Projection checkpoints; forced slices when lag passes 1 s; projections moved to the standby if the spike shows the owner short of idle time; alert on lag |
| R1-6 | **Determinism across releases** of the code | Algorithm versions in `Policy` entries; per-entry outcome checks on every replay; replay test (T-17) |
| R1-7 | **A single link is the irreducible serial point** (RFC-000 R5, R19), with about 4× margin in V8 (est.) | Serialisation, encryption and gRPC on worker threads (about 8×); a second in-flight batch with an application-assigned sequence (RFC-000 R19); trees as a native module; measured skew (P1 open question 1) |
| R1-8 | **Large permanent reductions** take steps after `T_eff` (about one step per batch, 500 parts each; a cut set of 100,000 parts takes about 200 steps, seconds to a minute, est.), and rating holds `T_eff` for the affected set until the final step (D5) | Steps bounded by the cut set, not the link (§5.4); rating's delay is minutes at worst and only for that set |
| R1-9 | **Generation copies** cost memory while slices or batches pin (about 50 MB/s retained for milliseconds to seconds, est.) | Short pins; slices bounded at 2 ms |
| R1-10 | **Event-loop stalls** (garbage collection, a long entry) delay every request on the link | Typed-array arenas off the scanned heap; bounded entries; GC pauses measured in T-18 and alerted |
| R1-11 | **The hottest link's tail range** takes every log insert (sequential keys) | About 50 transactions/s and 3 MB/s, within one range (est.); measured in the spike; if not, one log row per batch (Competition). Hash-prefixing the sequence is not a lever: it would break the contiguous span reads the standbys' gap-fill, the sealer and replay rely on (review 17, R1-24) |
| R1-14 | **The hottest link's single-link p99** is about 191 ms from R1 and 201 ms from R2 with the batch's apply (est.), at `ack_budget` | Not X2-S15's population (the hottest link always has capacity in flight); a late answer is `pending` (POL-04). Levers: the hottest slot's second in-flight batch (RFC-000 R19), serialisation on worker threads |
| R1-15 | **Over-cut on a single cut rate** for a reservation whose newest part has a later window (§5.4) | Alerted with the Mbps over-cut; AI-R1-13 proposes per-part targets |
| R1-16 | **`link_request` volume** on the hottest link, about 216 M rows a day (est.) | Spread by request key; row-level TTL; measured in T-18; fallback: answer post-expiry repeats from history (RFC-006) |
| R1-12 | **Cold rebuild** of the hottest link (about 30 s, est.) when no standby is eligible | Two standbys per slot (AI-R1-12); checkpoints every 10 min or 1 M entries; alerted |
| R1-13 | **Kafka or outbox lag** delays affected notices | The outbox survives in the database; the changefeed relays; lag alerted against the 10 s budget |

## Requirements issues

Revision 1 raised RQ-R1-1 … RQ-R1-12. All twelve are **resolved** by `requirements-v1.6`
([review 11](../reviews/11-requirements-amendments-from-detailed-rfcs.md), "RFC-001 Link
schedule and admission"), and applied in this revision:

| # | Issue (revision 1) | Decision in v1.6 | Applied in |
|---|---|---|---|
| RQ-R1-1 | Capacity reductions racing a decision | **Resolved** (coordinator): a request that had begun committing (POL-26) when a reduction is recorded may complete; it is then affected and network operations alerted; every request decided after the record is decided against it. POL-07, P1-N1, P1-N8; P1-S05, S13, S41, S42 amended, P1-S63 | §3.4 I1, §4.4, §5.1 (with the new AI-R1-11 for the notice interval) |
| RQ-R1-2 | The minute of a restoration | **Resolved**: an outage from the start of its minute; flags end and capacity is sellable from the first boundary at or after the restoration. P1-S40 | §3.1, §5.2, §5.7 |
| RQ-R1-3 | The affected set when the schedule changes during the notice | **Resolved**: recomputed; newly affected holders offered at once; an offer once made stays open; removal decided at the notice's end, never more than then required. P1-S64 | §5.4 |
| RQ-R1-4 | "Just enough Mbps" at different excesses | **Resolved**: the largest excess met, after newer parts' cuts. P1-S65 | §5.4 |
| RQ-R1-5 | Maintenance blocked by holds; cancelling maintenance | **Resolved**: beside committed and held capacity; rejected with `retry_after`; the supplier may cancel, free from the next boundary (read since v1.7 as the first boundary at or after the record, RQ-R1-13). P1-S66, P1-S67 | §5.3 |
| RQ-R1-6 | An outage on a link with an offer hold | **Resolved**: counts as committed, not flagged; the offer stays open and firm; its holder told. P1-S68 | §5.6, §5.7 |
| RQ-R1-7 | Who registers and retires a link; permanent increases | **Resolved**: commercial registers and retires; an increase is the supplier's, sellable from the next boundary. POL-07, POL-32; P1-S69, X1-S31 and rows of X1-S13, S22, S23 | §5, §5.5, §10, §11.1 |
| RQ-R1-8 | `selling_horizon` and "now" | **Resolved**: "now" the minute boundary at or before receipt; 12 calendar months in UTC, clamped to the month's last day. P1-S74 | §2 |
| RQ-R1-9 | The capacity a no-fit counter-offer is computed beside | **Resolved**: every counter-offer beside committed and held capacity. P1-S73 | §4.2 |
| RQ-R1-10 | `retry_after` with several blockers | **Resolved**: the latest of their remaining deadlines. P1-S70, P2-S116 | §4.1, §4.3 |
| RQ-R1-11 | Ages of a moved reservation's parts | **Resolved**: each part keeps its original age. P1-S71 | §5.6 |
| RQ-R1-12 | Telling holders when a flag shrinks | **Resolved**: holders and network operations told within `affected_notice_time` whenever affected minutes change. P1-S72 | §5.7 |

Revision 2 raised RQ-R1-13 and RQ-R1-14. Both are **resolved** by `requirements-v1.7`
([review 12](../reviews/12-requirements-amendments-from-rfc-revision-2.md)), as is RFC-002's
B-RQ-9, which this RFC's displacement markers serve, and applied in this revision:

| # | Issue (revision 2) | Decision in v1.7 | Applied in |
|---|---|---|---|
| RQ-R1-13 | "The next minute boundary" for a cancelled maintenance booking against "the first boundary at or after its record" for restorations and increases | **Resolved** (coordinator), as proposed: every rise in sellable capacity takes effect from the first minute boundary at or after its record. POL-07 *Every rise in sellable capacity*; P1-N8; P1-S76 new, P1-S40 and P1-S67 retitled | §3.1, §5.2, §5.3, §5.5, §11.1, T-20 |
| RQ-R1-14 | "In the order received" for link checks | **Resolved** (coordinator), as proposed: the order in which requests reach the link's schedule owner. POL-05; P1-N2; P1-S14 amended, P1-S77 new; glossary *Capacity hold* | §4.1, §7.2, §11, T-03 |
| B-RQ-9 (RFC-002) | When "had begun committing when the reduction was recorded" is judged | **Resolved** (coordinator): exactly, by whether the reduction's displacement record is visible to the confirming transaction. POL-07 *When it is judged*; P1-N1; P1-S78 new; glossary *Affected reservation* | §3.4 I1, §4.4, §5.1, §7.1, §11.1, T-12 |

New in revision 3: none. Two readings are recorded, neither needing an amendment:

- **What "the displacement record" is in the design.** POL-07 defines it by what it records
  ("the record, made at the link with the reduction, of the requests in flight it no
  longer fits"); here it is the set of `link_displacement` rows written in the
  reduction's own transaction (§5.1, §7.1). A hold that still fits after the reduction
  beside committed capacity and older holds is not "no longer fit", so it gets no marker,
  and its confirmation is not an exception.
- **"Confirmed after the reduction was recorded"** (P1-S63's alert). With the read, a
  confirm that did not see the record is ordered before it in the database, though its
  `convert` reaches the link after the reduction entry. The link raises the alert for
  every conversion of a hold that carries a displacement mark (§4.4), which is the set
  P1-S78's first row names.

Review 17 raised, against revision 3, RQ-17-1 and RQ-17-2. Both are **resolved** by
`requirements-v1.8` ([review 22](../reviews/22-requirements-amendments-from-c3-reviews.md)),
as is RFC-002's B-RQ-10, and applied in this revision:

| # | Issue (review 17) | Decision in v1.8 | Applied in |
|---|---|---|---|
| RQ-17-1 | How overlapping capacity facts compose; whether an outage reduces *to* a level or *by* an amount | **Resolved** (coordinator, review 17 D1): every capacity change states a level; capacity in force = min(announced capacity, every open outage's level); a reduction removes only what the announced capacity needs, never because of an outage; an increase during an outage raises the announced capacity only; a reduction may be announced during an outage. POL-07 *Capacity in force when changes overlap*; P1-N1, P1-N8; P1-S79, P1-S80 new; glossary *Capacity in force*, *Affected reservation* | §3.1, §3.4 I6, §5.1, §5.2, §5.4, §5.5, §5.7, §11.1, T-21 |
| RQ-17-2 | P1-S76's times in seconds against a sub-second rule | **Resolved** (review 17 D3): a time stated to the second in a scenario is exact; "recorded at" is the record's commit timestamp. Glossary *Time of day* | §3.1, T-20 |
| B-RQ-10 (RFC-002) | Two senses of "begun committing" | **Resolved**: POL-07's is judged only by the displacement record's visibility; POL-26's is a fence only. POL-07, POL-26; P1-S63, P1-S78 amended | Need item 4, §3.4 I1, §4.4, §13 |

New in revision 4: none. Three readings are recorded, none needing an amendment:

- **An increase during a reduction's notice** "raises" the announced capacity (POL-07): what
  the link carries is the larger of the level it carried and the increase's, so an
  increase to a level between the reduced and the old capacity raises only the post-notice
  level, and the notice period keeps the old capacity (§3.1).
- **An outage at or above the announced physical capacity** reduces nothing and is refused
  `INVALID`; an outage above another open outage is accepted as its own fact (§5.2).
- **Maintenance bookings count in a reduction's excess.** They are the supplier's own use of
  capacity it booked beside committed capacity; the supplier may cancel them during the
  notice, which lowers the cuts (§5.3, §5.4).

## Architecture issues

Revision 1 raised AI-R1-1 … AI-R1-9. All nine are **resolved** in RFC-000 revision 4
("Revision 4 resolution", RFC-001 table), and this revision follows them:

| # | Issue (revision 1) | Resolution in RFC-000 revision 4 | Here |
|---|---|---|---|
| AI-R1-1 | No operation for changing a confirmed leg | **Resolved**: `end_leg` and `reduce_parts`, with change id, effective minute, parts newest first and decision time, acknowledged once durable, idempotent by change id. §2, §3, §4.4, §8 | §4.5, §11.1 |
| AI-R1-2 | Offer holds had no link-side operation | **Resolved**: `offer_hold`, `offer_accept`, `offer_move_at`, `offer_release` in the link hold port. §2, §8 | §5.6, §11.1 |
| AI-R1-3 | The waiting mark and displacement in no contract | **Resolved**: `mark_waiting` and `DISPLACED` in the link waiting port; `displacement_accept` in the outcome and expiry port. §2, §3, §8 | §4.3, §5.1, §11.1 |
| AI-R1-4 | The reduction race between two logs | **Resolved** by the v1.6 decision: a confirmation in flight may complete and is affected and alerted; an undecided request is displaced. §3, §7, §8. The interval of one notice transit that remains is raised as AI-R1-11 | §5.1 |
| AI-R1-5 | The equivalent-path source listed RFC-001 as consumer | **Resolved**: its consumer is RFC-002 only. §8 | §11.2 |
| AI-R1-6 | Affected flags as owned state | **Resolved** (adopted): a derived projection of the link log. §2, §8 | §5.7, §7.5 |
| AI-R1-7 | Known time of leg changes | **Resolved**: every leg change, offer command and release carries the decision time. §2, §3, §8 | §6, §11.1 |
| AI-R1-8 | The release carried no deadline | **Resolved**: the release carries `D`. §2, §4.3, §8 | §4.4, §11.1 |
| AI-R1-9 | The hold needed the commit fence | **Resolved**: the hold carries `D_c`; granting skips waiters past it. §2, §3, §4.3, §8 | §4.1, §4.3 |

Revision 2 raised AI-R1-10 … AI-R1-12. All three are **resolved** in RFC-000 revision 4.1
("Revision 4.1 errata"), as proposed:

| # | Issue (revision 2) | Resolution in RFC-000 revision 4.1 | Here |
|---|---|---|---|
| AI-R1-10 | Supply commands for a permanent increase and a maintenance cancellation | **Resolved**: link supply commands gain `record_increase` and `cancel_maintenance`, same consumers; capacity history records both. §2, §8 | §5.3, §5.5, §11.1 |
| AI-R1-11 | "Had begun committing" across two logs | **Resolved**: displacement-marker rows written in the reduction's transaction, one point read per Share leg in the account owner's confirm transaction; A1 amended (an owner may read another owner's rows, never write them, only where §8 names the read; select granted only there); §8 *Link displacement read*. With B-RQ-9 (requirements) | §5.1, §7.1, §11.1, R1-1 |
| AI-R1-12 | Hot standbys for link owners | **Resolved**: two per link slot, one in the leader region's other facility, one in the second Kenyan region. §5.1, §5.4, §5.5 item 10, §8 | §7.6, §8, §11.2 |

Revision 4.1 also changed, without an issue of this RFC, the substrate this RFC runs on;
each is applied here: per-slot batch transactions (AI3-11, §1, §7.2, §9); owner leases as
session plus slot rows (AI6-1, §8); insert-only log tables with a separate truncation role
(AI5-8, §7.1, §7.6); `τ` at about 260 to 300 ms with `δ_x_cfg` at p99.9 (AI6-3, §4.1); a
standing R3 non-voter for admission tables (AI6-4, §8); Kafka named as Apache Kafka (AI6-2,
no change here).

New in revision 3: none.

Review 17 raised, against revision 3, AI-17-1 … AI-17-6. All six are **resolved** in RFC-000
revision 4.2 ("Revision 4.2 errata"), as proposed, and applied here:

| # | Issue (review 17) | Resolution in RFC-000 revision 4.2 | Here |
|---|---|---|---|
| AI-17-1 | The hold lacked `wait`, kind, receipt minute and policy version | **Resolved**: carried in the hold; `wait = false` decided at the link; validity against the receipt minute | §2, §4.1, §11.1 |
| AI-17-2 | Event identities with gaps; "ignore older" dropped late notifications | **Resolved**: per-link `feed_seq` for the schedule feed; point-to-point notifications as state messages by (request, attempt, kind), no high-water rule, `query` reconcile | §7.1, §7.2, §11.1, T-08b |
| AI-17-3 | The effective-time closure could not hold for POL-07 cuts | **Resolved**: causes with a known future minute recorded before it; affected set fixed at `T_eff`; closure held for it until the final step; a cut is a per-link target, composed by `min` | §4.5, §5.4, §5.6, §11.1 (closed time, `REDUCTION_EFFECTIVE`, `REDUCTION_FINAL`), §11.2 |
| AI-17-4 | A paused deposed owner could block the takeover read | **Resolved**: idle-in-transaction and transaction timeouts below the lease margin; high-priority takeover reads | §7.2, §8, T-10 |
| AI-17-5 | `δ_x` left out batching waits | **Resolved**: `W_a` and `W_l` budgeted; about 4,096 shared link slots; `τ` about 420 ms, cap about 450 ms | §1, §4.1, §9 |
| AI-17-6 | RFC-000 §3 kept the partner-confirm exception | **Resolved** with B-AI-9: deleted | §5.1, §11.1 (unchanged; this RFC already followed v1.7) |

New in revision 4:

| # | Issue | RFC-000 location | Proposed amendment | Reading adopted meanwhile |
|---|---|---|---|---|
| AI-R1-13 | **A single cut rate per reservation is not exact** when a reservation's parts have different windows: POL-07 cuts per part, newest first, and an extension part newer than the original may be cut while the original is not; "reservation X at most r Mbps" then either oversells after the original's end or over-cuts before it | §8 reservation command port, §4.5 | Allow the target to carry, optionally, `[(part, at most Mbps)]` per part, composed by `min` per part; `r` stays the common case (RFC-002 revision 4 consumes `r \| none`) | The link sends `r` as the lowest rate the reservation may keep over `[T_eff, ∞)`, never overselling, and alerts `CUT_TARGET_INEXACT` with the Mbps over-cut (§5.4) |
| AI-R1-14 | The hottest-link row of the single-link budget omits the batch's apply time (up to about 5 ms on the hottest link, est.), so about 191 ms from R1 and 201 ms from R2 | §3 latency variants | Add the apply time to the hottest-link row and to R23's exit criterion; it is not X2-S15's population | §9 and Risk R1-14 state it |

## Revision 2 changes

| Area | Revision 1 | Revision 2 |
|---|---|---|
| Substrate (RFC-000 rev 4) | A Raft group per link; leader = owner; followers apply and hold state; group commit every 5 ms; leader timestamp | Owner-lease holder (NestJS) of the link's slot, epoch-fenced; insert-only `link_log` with head, outbox, marker and projection rows (§7.1); one batch transaction in flight, decided at its commit timestamp on a speculative generation (§7.2); hot standbys and checkpoints (§7.6); typed-array state in V8 (§3.2); sizing redone (§9); takeover and failure table redone (§8) |
| Contracts (RFC-000 §8 rev 4) | Added by this RFC as issues | `end_leg` and `reduce_parts` with leg, change id and parts newest first; offer commands with decision time; `mark_waiting`, `DISPLACED` answered by `displacement_accept`, release or `convert`; holds with `D_c = D − τ` (about 260 ms) without a partner leg; release with `D`; feeds on Kafka from the outbox; errors `NOT_OWNER`, `STALE_EPOCH` (§11) |
| Arrival order (POL-05, P1-S14) | Checks also counted older waiters' needs | Checks count committed and held capacity only, in log order; released capacity to the oldest waiter it fits through the scan (§4.1, §4.3) |
| Reductions (POL-07, RQ-R1-1) | Race detected and alerted; amendment proposed | v1.6 rule applied: displacement for requests that have not begun committing, completion with flag and alert for those that had; displacement markers proposed for the notice interval (§5.1) |
| Other v1.6 decisions | Working interpretations | Applied as rules: restoration, increase and maintenance cancellation from the next boundary (§3.1); maintenance with `retry_after` (§5.3); permanent increase (§5.5); largest excess per part and recomputed affected sets (§5.4); offer holds under outages, original ages on a move (§5.6); notices on every change of affected minutes, and "told" (§5.7); counter-offers beside held capacity, `retry_after` the latest blocker (§4.1, §4.2); calendar-month horizon from receipt (§2); commercial registers and retires links (§5, §10) |
| Coverage | 62 P1 scenarios; 77 jointly allocated | 75 P1 scenarios (P1-S63 … S75 added; S05, S13, S14, S40, S41, S42 changed); 82 jointly allocated, 52 with a link-side part (§13) |

## Revision 3 resolution

| Finding or issue (record) | Change in revision 3 |
|---|---|
| RQ-R1-13, resolved by `requirements-v1.7` ([review 12](../reviews/12-requirements-amendments-from-rfc-revision-2.md)) | One effective-boundary rule for every rise, applied in the recording entry when it is recorded on a boundary (§3.1); §5.2, §5.3, §5.5 cite P1-S76; supply answers state the boundary (§11.1); T-20 widened; working interpretation removed |
| RQ-R1-14, resolved by `requirements-v1.7` (review 12) | §4.1 states the order as the order requests reach the owner-lease holder, with P1-S77's worked example, re-routed and retried commands; §11 states the one total order; T-03 adds the reversed-delivery case |
| B-RQ-9, resolved by `requirements-v1.7` (review 12) | §5.1 rewritten: judged by the marker's visibility, a decision table of the three cases, why the order is exact, the marker lifecycle and costs; §4.4 alerts on converting a displaced hold, notice written at once; §3.4 I1 and Need item 4 restated; §11.1 gives the read's semantics and what the consumer must do; T-12 covers both orders; Competition adds the bounded-window reading |
| AI-R1-10, AI-R1-11, AI-R1-12, resolved by RFC-000 revision 4.1 ("Revision 4.1 errata") | "Proposed" removed from §11.1; the select grant and `link_displacement` row semantics in §7.1; the notice-interval fallback removed from §5.1 and R1-1; Architecture issues table records the resolutions |
| RFC-000 revision 4.1: AI3-11, AI6-1, AI5-8, AI6-3, AI6-4 | Per-slot batch transactions (§1, §7.2, §9); session and slot lease rows (§8); truncation role (§7.1, §7.6); `τ` range (§4.1); R3 non-voter (§8); substrate conventions consumed (§11.2) |
| `requirements-v1.7` POL-06 (probes per account slot, disaster on probe evidence) | Probe-booking load row (§9); disaster row names both grounds (§8) |
| `requirements-v1.7` POL-19, POL-32, X1-N7, X1-N11 (erasure by compliance within `erasure_max`) | Free-text reasons stay with RFC-005, never in the link log (§5); X1-S13's new row recorded as having no link-side part (§13) |
| `requirements-v1.7` POL-30, X1-S36 (withholding decided with the termination) | No link-side change; recorded in §13 |
| Coverage | P1-S76 … S78 added to Satisfies and §13; P1-S14, S40, S67 re-cited; 78 of 78 P1 scenarios |

## Revision 4 resolution

Every finding of [review 17](../reviews/17-rfc-001-review.md), its decisions D1 … D5
(accepted by the coordinator), and the rebase on `requirements-v1.8` and RFC-000 revision
4.2:

| Finding or issue (record) | Change in revision 4 |
|---|---|
| R1-01 Blocker: capacity deltas do not compose (D1; RQ-17-1 resolved by v1.8, review 22) | Capacity kept as levels in a profile; `A_s`, `A_p`, `A_now`, `K_s`, `K_p`; sales deficit added to the trees by profile differencing; `occ_phys` replaced by `occ_commit` (no capacity term), flags against `K_p` pieces, the greedy against `L_R = A_p(T_eff)`; validity against `A_now`; review 17's cases (a) … (d), P1-S79, P1-S80 worked (§3.1, §3.4 I6, §5.2, §5.4, §5.5, §5.7, §11.1); T-21 level oracle |
| R1-02 Major: standby tail pushes batches | Standbys fed by push, gap-filled by bounded spans, follower-read backstop (RFC-006 §4.4); the rule that no reader but a takeover reads the live tail or head at the present timestamp; step 5 lists every push cause; T-18 counts retries by cause (§7.2, §7.6) |
| R1-03 Major: reduction batch pushed repeatedly | Capacity-lowering entries in a transaction of their own, placeholder marker intents in the first statement, retry keeping its intents; T-12 on the hottest load; floating-timestamp fallback in Competition and R1-1 (§5.1) |
| R1-04 Major: hold inputs (D2; AI-17-1 resolved by RFC-000 4.2) | Hold carries `wait`, kind, receipt minute `m0`, policy version; `wait = false` refused at the link; `m0` separate from `request_age` (§2, §4.1, §11.1, T-05, T-07) |
| R1-05 Major: yield loop | Yields raised only if sufficient; yield claims stop re-granting younger waiters inside the claim (§4.3, T-08) |
| R1-06 Major: revocation contract and closure (D4, D5; AI-17-3 resolved) | Affected set fixed at `T_eff` from the projection's cut set, published in chunks; steps over that set with a final excess check; one `cut_target(link, reduction, reservation, T_eff, r \| none)` per reservation of the set, `none` included (RFC-002 revision 4's form); `REDUCTION_FINAL`; per-link closed time and the two closure holds (RFC-003 revision 4's form); AI-R1-13 for the per-part case (§5.4, §11.1, §11.2, T-14) |
| R1-07 Major: moves | One meaning per offer command; offer parts with original ages at `offer_hold`; old link's `end_leg` from `move_at` sent at acceptance, dated in the future; moving mark; RFC-002 ignores a target from a link left by `T_eff` (§4.5, §5.4, §5.6, §11.1, T-15) |
| R1-08 Major: event identities (AI-17-2 resolved) | Per-link `feed_seq` in the head row; notifications as state messages by (request, attempt, kind), no high-water rule, `query` reconcile (§7.1, §7.2, §11.1, T-08b) |
| R1-09 Major: attempt numbering | Attempt changes only on an accepted yield or displacement; `GRANTED` and `DISPLACED` carry it; `convert` carries it, `MISMATCH` otherwise (§4.3, §4.4, §11.1, T-08) |
| R1-10 Major: paused deposed owner (AI-17-4 resolved) | Session timeouts; high-priority takeover read; session revocation on acquisition (§7.2, §8, T-10) |
| R1-11 Major: `δ_x` without batching wait (AI-17-5 resolved) | `W_l` in the link step and in the link's part of `δ_x`, figures from RFC-000 4.2; `τ` about 420 ms; the hottest slot's second batch as the lever (§4.1, §9) |
| R1-12 Minor: time budget breaks determinism | Counter-offer budgets in steps (`counteroffer_steps`, `counteroffer_batch_steps`); cache keyed by `occ_all`'s change counter (§4.2, §7.4, T-04) |
| R1-13 Minor: sizing | Conversions = holds that hold − releases; entries about 4,550/s; tombstones at most about 114,000; waiters re-derived; latency 65 ms link step, about 191 ms single-link on the hottest link (§9, Benefits, R1-14, AI-R1-14) |
| R1-14 Minor: scan bound | `scan_steps` with a `Tick` continuation and scan-pending ranges (§4.3, §7.4, R1-2) |
| R1-15 Minor: I3 | Reworded: holds and grants; waiters may be refused by the link (§3.4) |
| R1-16 Minor: maintenance cancellation | Pulse removed over `[max(s, b), e)` (§5.3, T-20) |
| R1-17 Minor: `offer_move_at` in the past | `INVALID` unless `ceil_minute(ts) ≤ T < move_at` (§5.6, §11.1) |
| R1-18 Minor: refusal record kept 24 h | Request records in memory to `D + release_grace`, then `link_request` rows for 24 h; `MISMATCH` check in `hold` (§4.1, §4.4, §7.1) |
| R1-19 Minor: retirement fence | `closing` then report then `retired` (§10, §7.3, T-22) |
| R1-20 Minor: offer hold in a reduction | Offer parts with original ages take part in the greedy; their cut is a cut target on the offered reservation (§5.4, §5.6) |
| R1-21 Minor: race mechanics | E5 retries, not refreshes; RFC-006 §3.7 to align (§5.1; interface point) |
| R1-22 Minor: compaction claim | Restated: windows decided start after `now_m − 2 min` (§7.6) |
| R1-23 Minor: missing alternatives | One log row per batch; push or rangefeed standbys (adopted); also deltas, a level tree, floating timestamp, single cut rate, full-link cut (Competition) |
| R1-24 Minor: hash-prefix lever | Dropped, with its cost stated (R1-11) |
| R1-25 Minor: `last_above` | Returns "for ever", giving "none" (§3.2, §4.2) |
| RQ-17-2 (D3; resolved by v1.8) | "Recorded at" is the commit timestamp, exact; T-20 controls it (§3.1) |
| AI-17-6 (resolved with B-AI-9) | No change: this RFC already had no partner exception |
| `requirements-v1.8`: POL-07, P1-N1, P1-N8, P1-S79, P1-S80, glossary *Capacity in force* | Levels throughout (above); P1-S79, P1-S80 in Satisfies, §13, T-21 |
| `requirements-v1.8`: B-RQ-10, POL-26, P1-S63, P1-S78 amended | "Begun committing" in POL-07's sense only (Need, I1, §4.4, §13) |
| `requirements-v1.8`: POL-04 shared deliveries; POL-06 three probes a minute per slot | Notifier batches notices (§5.7); probe load about 820 bookings/s on probe links (§9, §11.2) |
| `requirements-v1.8`: P2-N8, POL-08, POL-16, POL-19, POL-25, POL-32, X1-N7, X1-N8, X1-N11 | No link-side change, recorded (§13) |
| RFC-000 4.2: AI-R6-1, AI-R6-3, 4,096 shared link slots | Session revocation (§8); generations in rows, headers and commands, `STALE_SENDER` (§1, §7.1, §11); slot count (§1, §9) |
| Coordinator interface updates (RFC-002 revision 4, RFC-003 revision 4) | `cut_target(…, r \| none)` one per reservation of the affected set; hold inputs and `REFUSED(IN_FLIGHT)` with tombstone; per-link closed time, affected set and final step on the schedule feed (§5.4, §11.1) |
| Coverage | P1: 80 of 80; `impact.py coverage S-LINK`: 0 uncited, 0 dangling |
