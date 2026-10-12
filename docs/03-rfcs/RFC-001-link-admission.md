# RFC-001. Link schedule and admission

| | |
|---|---|
| Status | Draft |
| Satisfies | P1-S01, P1-S02, P1-S03, P1-S04, P1-S05, P1-S06, P1-S07, P1-S08, P1-S09, P1-S10, P1-S11, P1-S12, P1-S13, P1-S14, P1-S15, P1-S16, P1-S17, P1-S18, P1-S19, P1-S20, P1-S21, P1-S22, P1-S23, P1-S24, P1-S25, P1-S26, P1-S27, P1-S28, P1-S29, P1-S30, P1-S31, P1-S32, P1-S33, P1-S34, P1-S35, P1-S36, P1-S37, P1-S38, P1-S39, P1-S40, P1-S41, P1-S42, P1-S43, P1-S44, P1-S45, P1-S46, P1-S47, P1-S48, P1-S49, P1-S50, P1-S51, P1-S52, P1-S53, P1-S54, P1-S55, P1-S56, P1-S57, P1-S58, P1-S59, P1-S60, P1-S61, P1-S62 (every P1 scenario, 62). Link-side part only, the primary RFC being another (§13): P2-S02, S13, S14, S15, S16, S17, S18, S19, S20, S21, S43, S44, S45, S46, S47, S48, S52, S55, S56, S58, S59, S60, S61, S62, S73, S74, S79, S80, S81, S84, S85, S87, S88, S92, S93, S94, S95, S97, S101, S104, S106, S107, S110 (RFC-002); X1-S22, X1-S23 (RFC-005); X2-S03, X2-S05, X2-S06, X2-S15, X2-S23 (RFC-006) |
| Policies | POL-02, POL-04, POL-05, POL-06, POL-07, POL-08, POL-09, POL-10, POL-16, POL-19, POL-25, POL-26, POL-29, POL-30, POL-31, POL-32, POL-33 |
| Prior decisions | History log D1, D5, D6, D7, D9, D10, D11, D12, D14, D15, D17, D30 (carried forward or rejected in Competition) |
| Builds on | The requirements at tag `requirements-v1.5`; [RFC-000](RFC-000-architecture.md) revision 3.2 (tag `rfc-000-accepted`), whose components, ownership, principles A1 … A10, contracts (§8) and allocation (§7) bind this RFC |
| Supersedes | The pre-baseline draft of this RFC (an impulse segment tree in memory, and a Postgres link-row lock as the authority) |

Terms are used in the sense of the [glossary](../02-specs/glossary.md): "reserved rate" is
capacity, "traffic" is bytes, and neither is called "usage". This RFC adds one internal
term, **occupancy** (§3.1), for the per-minute sum the schedule checks; it is never shown
to a buyer. Every latency, volume and size marked **est.** is an estimate, to be replaced
by the measurement of RFC-000's spike (R1), unless it is a requirement's own figure.

## Need

RFC-000 makes the **link schedule owner** the single writer of everything a Share link
has sold, holds or can carry (A1, POL-05), the leader of one two-region consensus log per
link (A2, A3), and allocates P1-N1 … P1-N9 to it, with parts of P2-N3, P2-N4, P2-N9,
P2-N11, X1-N10, X2-N2 and X2-N3. It also gives this RFC the **link registry**, the link
part of the catalogue. What that owner must do, and why it is hard:

1. **Decide every capacity question on one link exactly** (P1-N1, P1-N2). A request fits
   if, at every minute of its window, the committed rate plus the capacity held for other
   requests plus its rate is within the capacity in force. Reservations are partial and
   overlap; windows last a minute, a year, or have no end (P1-N6); the check must cost the
   same whatever the length (X2-S05), and must say, on a rejection, the largest rate that
   fits and the earliest window that does (P1-N4, POL-10).
2. **Do it at the hottest link's rate** (POL-06: 2,500 requests/s, ×50 of today's load),
   inside the link's share of `ack_budget` (about 27 ms of RFC-000's 105 ms single-link
   p99, est.), with every decision durable in two regions before it is answered (X2-N4).
3. **Hold, wait and yield under one priority rule** (P1-N3, POL-02, POL-05). Capacity held
   for a pending request counts against the link and is free once its non-confirmed
   outcome is reported; a request blocked only by capacity in flight waits within its
   deadline (or, with `wait = false`, is rejected at once with `retry_after`); the oldest
   waiter gets released capacity; a younger holder that is itself waiting yields; a holder
   that is not waiting is never pre-empted. Only the request's account owner may end a
   hold (A9), and a release is request-scoped and tombstoned (A0R-03).
4. **Take capacity changes without ever revoking silently** (P1-N8, POL-07): unplanned
   outages that reduce what is sold and flag every reservation at exactly the overcommitted
   minutes; maintenance on free capacity only; permanent reductions with notice, newest
   Mbps first, and firm equivalent-path offers whose capacity is held and counted as
   committed (RQ-4).
5. **Record only facts, and explain any past decision** (P1-N7, P1-N9, POL-19): the
   schedule as known at any past time, for 7 years.
6. **Survive crashes and failovers** with no fact lost, no second writer, and releases
   durable within `release_grace` while the link fails over (P1-S62, P2-S107).

## Approach

### 1. Scope, placement and principles

- **One partition per Share link**, a five-voter group placed 2 + 2 + 1 (RFC-000 §5.1); the
  hottest links each have a group to themselves. The link schedule owner **is** the leader
  of that group (RFC-000 §5.2). Partner links have no schedule here: their partner adapter
  stands in for Share's position (RFC-002).
- The owner is a **deterministic state machine over the link's log** (§7). Every decision
  (hold, refusal, waiter registration, grant, conversion, release, capacity change) is the
  effect of applying one log entry. Followers apply the same entries and hold the same
  state in memory, so a failover rebuilds nothing (§8).
- This RFC follows RFC-000's principles literally: one writer (A1); facts appended,
  current state derived (A4); only the account owner ends a request's holds, and a release
  for an outcome is request-scoped with a tombstone (A9); deadlines are data, clocks drive
  liveness only (A8). Where this RFC needs something RFC-000's contracts do not name, it
  says so under Architecture issues.
- Mechanism and policy are separate (D15, the register's preamble): `priority_rule`,
  `selling_horizon`, `rate_min`, `release_grace`, `maintenance_notice`, `revocation_notice`,
  `affected_notice_time` are parameters read from `Policy` entries in the log (§7.1), never
  constants in the structure.

### 2. Time and validity

**Minutes.** Time in the schedule is an integer **minute index** `m`, minutes since
1970-01-01T00:00Z (D1). A window `[s, e)` is a pair of minute indexes, half-open, or
`[s, ∞)` for an open-ended window. Back-to-back windows do not overlap (P1-S04).

**State-machine time.** Every log entry carries a leader timestamp `ts`, made monotone
across leader changes as `max(leader clock, ts of the previous entry)` (as RFC-000 §4.5 does
for posting time). The apply step reads `ts`, never a clock, so every replica reaches the
same state. `now_m = floor_minute(ts)`.

**Validity (P1-N5, POL-09, POL-31).** The same rules are evaluated by the account owner
at intake (RFC-002), which is where an invalid request is reported, and again by the link
owner on every hold as a defence. Both evaluate them **relative to the request's intake
timestamp `T_in`** (its `request_age`, carried in every hold, RFC-000 §4.3) and with the
policy version recorded at intake, so the two never disagree because a hold reached the
link a few milliseconds later. With `m0 = floor_minute(T_in)` and
`H = m0 + selling_horizon` (calendar months in UTC, clamped to the month's last day):

| # | Rule | Fails, for example (P1-S19) |
|---|---|---|
| V1 | The rate is a whole number of Mbps, at least `rate_min` | 0, −1, 1.5 |
| V2 | `s` is a minute boundary; `e` is a minute boundary or open | now + 1 h 30 s |
| V3 | `e > s` | empty, backwards |
| V4 | `s ≥ m0` | now − 1 min |
| V5 | `s < H` | H; H + 5 min open-ended |
| V6 | `e ≤ H` for a window that has an end | H − 10 min to H + 10 min |

`[now, now + 1 h)`, `[H − 10 min, H)` and `[H − 1 min, ∞)` are valid (P1-S20). A rate
above the link's capacity is valid and is a capacity answer (P1-S39). The deadline's own
bounds are RFC-002's (P2-S12).

### 3. Schedule state and structures

#### 3.1 The occupancy model

A reservation leg of rate `b` over `[s, e)` is a rectangular pulse, and the schedule is
the superposition of pulses (D11). Its derivative is two **impulses**, `+b` at `s` and `−b`
at `e`; an open-ended pulse is the single impulse `+b` at `s`. The value at minute `t` is
the running sum of impulses up to and including `t`. A booking is therefore two point
updates whatever its length (X2-S05), and an open-ended booking occupies every later
minute, including minutes that later enter the horizon (P1-S21, P1-S22).

Capacity changes are pulses of the same shape against a fixed **reference capacity**
`C_ref`, the link's capacity at registration (§10): a reduction by `Δ` over a range is a
pulse `+Δ`, an open-ended reduction (an outage until its restoration, a permanent
reduction) is the impulse `+Δ`, a restoration or increase is the matching `−Δ`. Every
check is then "occupancy plus the request's rate is at most `C_ref`". The link keeps three
occupancies, each a sum of pulses:

| Occupancy | Pulses it contains | Used for |
|---|---|---|
| `occ_firm(t)` | Confirmed leg parts; Share's offer holds (counted as committed, POL-07, RQ-4); maintenance bookings; **sellable** capacity reductions (outages from their record, permanent reductions from their announcement) | "Does it fit on committed capacity?" (no-fit rejections, P1-S37) |
| `occ_all(t)` | `occ_firm` plus every capacity hold | "Does it fit beside every hold?" (holds and confirmations, P1-S05) |
| `occ_phys(t)` | Confirmed parts and offer holds; maintenance; **physical** reductions (outages from their record, permanent reductions from their effective time `T_eff`); minus cuts already decided but not yet applied (§5.4) | Which minutes are overcommitted on the network (affected flags, §5.6) |

The two capacity notions differ only for a permanent reduction during its notice: new
sales stop at once at the reduced capacity (P1-S43), while the link still carries its old
capacity, so nothing is affected before `T_eff` (P1-S44). The committed rate at a minute
(glossary) is the confirmed parts plus the offer holds.

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
rolling the horizon costs nothing (Competition). All arithmetic is in integer Mbps
(int64), never floating point. A scalar `carry` holds the sum of impulses folded away by
compaction (§7.4).

**Queries** (each `O(log m)` with `m` the number of keys, at most the number of distinct
minutes from compaction to the horizon, about 530,000, est.):

- `prefix(t)` = `carry` + the sum of keys `< t`.
- `value(t)` = `prefix(t + 1)`.
- `peak(s, e)` for `e` finite or `∞`: with `P = prefix(s)` and `Q` the aggregate over keys
  in `[s, e)`: `P + Q.maxpref` if there is a key at `s`, otherwise `P + max(0, Q.maxpref)`
  (the value at `s` is then `P`). An open-ended window queries `[s, ∞)` directly: no
  bound is needed.
- `first_above(t, θ)`: the least minute `x ≥ t` with `value(x) > θ`, by descending on
  `maxpref` with the running offset; `first_at_or_below(t, θ)` likewise on `minpref`;
  `last_above(θ)` descends preferring right children. Each `O(log m)`.
- `conflicts(s, e, θ)`: the maximal minute ranges in `[s, e)` with value `> θ`, by
  alternating the two descents: `O(k log m)` for `k` ranges.

**Updates.** `add(s, e, b)` is two point updates, `+b` at `s` and, if `e` is finite, `−b`
at `e`; a key whose value becomes 0 is deleted. `O(log m)`.

**Versions.** Nodes carry a generation number and are copied on write only if a reader
has pinned an older generation, otherwise mutated in place. The apply thread therefore
pays nothing while no reader exists, and a projection, a counter-offer or a snapshot can
read the exact state at a log position while the apply thread continues (§7.3, §7.4).

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
| Occupancy trees | `occ_firm`, `occ_all`, `occ_phys` (§3.2) | — |
| Leg parts | Per confirmed part: reservation, part id, leg, account, rate, window, **age** (the decision timestamp of the admission that added it, ties by request identity), cause flags (reduced under POL-07) | By reservation; interval index by window; age order |
| Capacity holds | Per request: attempt, account, kind (booking, change), rate, window, `D`, commit fence `D_c` (§4.1), `request_age`, waiting mark, displacement mark | By request; interval index; priority order |
| Waiters | Per request: attempt, rate, window, `D`, `D_c`, `request_age`, account | Priority order (`priority_rule`, ties by request identity, RFC-000 §4.5); interval index |
| Outstanding yield and displacement requests | (request, attempt) → the request they were raised for | — |
| Tombstones | Per request or offer: expiry `D + release_grace` | Map; heap by expiry |
| Offer holds | Per offer: reservation, account, rate, window, lapse time, state (open, accepted with move minute) | By offer; interval index |
| Capacity history | Every capacity fact: outages (amount, attribution, principal, reason, record and restoration), maintenance bookings, permanent reductions (amount, announcement, `T_eff`, cut cursor) | By kind and time |
| Maintenance bookings | Per booking: rate, window, supplier principal | — |
| Projection checkpoints | The log position through which each projection's output has been emitted (§7.3) | — |

#### 3.4 Invariants

- **I1. No oversell** (P1-N1). Every pulse that adds to `occ_all` (a hold, a grant, an
  offer hold, a maintenance booking) is added only if `occ_all + b ≤ C_ref` at every
  minute of its window after the addition. Every other entry removes occupancy, moves a
  pulse from hold to committed without changing `occ_all` (conversion, §4.4), or adds a
  capacity reduction. Hence at any position, a minute with `occ_all > C_ref` exists only
  where a reduction was recorded after the pulses that now exceed it, and the excess is
  made of those earlier pulses (§5.1).
- **I2. Fit is decided on the right occupancy.** A hold is granted only on `occ_all` (plus
  the needs of older waiters, §4.3); a no-fit refusal only on `occ_firm` (P1-S37,
  P2-S17).
- **I3. Holds outlive no outcome.** A hold, waiter or grant is removed only by a release,
  an accepted yield or an accepted displacement from the request's account owner (A9), or
  by its conversion. Any hold or grant for a tombstoned request, or at `ts ≥ D_c`, is
  refused (RFC-000 §8 port invariants; `D_c < D`).
- **I4. Facts only** (P1-N7). The committed occupancy is exactly the confirmed parts, the
  offer holds and the supply facts; a request's pulses are in `occ_all` only while it is
  held.
- **I5. Determinism.** The state after entry `p` is a function of the entries up to `p`
  and the algorithm version recorded in the log (§7.2).

### 4. Admission

#### 4.1 The hold decision

A hold command carries the request identity, account, leg, kind (`booking`, or `change`
for an extension or increase, which is a new admission of the difference, POL-08), rate
`b`, window `W`, deadline `D`, **commit fence `D_c`** (`D − commit_margin` with a partner
leg, `D − ack_budget` otherwise; POL-26, RFC-000 §4.3), `request_age`, intake timestamp,
`wait` and policy version. Applied at entry time `ts`:

```
hold(r, b, W, D, D_c, age, wait):
  if r has a hold, waiter, refusal or conversion here: return its recorded state   # idempotent
  if r is tombstoned:            refuse(r, TOMBSTONED)
  if ts ≥ D_c:                   refuse(r, DEADLINE_PASSED)        # covers ts ≥ D
  if not valid(r):               refuse(r, INVALID(rule))          # §2; intake should have caught it
  if peak(occ_firm, W) + b > C_ref:
                                 refuse(r, NO_FIT, counter_offer(occ_all, W, b))     # P1-S37
  S := pulses of older waiters overlapping W with ts < their D_c   # their needs, §4.3
  if peak(occ_all ⊕ S, W) + b ≤ C_ref:
      add pulse (W, b) to occ_all; record hold(r, attempt 1)        # HELD
  else if not wait:
      refuse(r, IN_FLIGHT, retry_after = max over blockers (D_x) − ts,
             counter_offer(occ_all, W, b))                          # P1-S12, POL-05
  else:
      register waiter(r, attempt 1); answer WAITING(ahead = max over blockers (D_x))
      request_yields(r)                                             # §4.3

refuse(r, reason, …): tombstone r until D + release_grace; record the refusal
```

- The order of the tests is the requirement's: no fit on committed capacity is a
  rejection whatever is held (P1-S37, P2-S17); fitting only without capacity in flight is
  waiting or, with `wait = false`, an immediate rejection (P1-S07, P1-S12, POL-05).
- **Blockers** are the holds of other requests, and the older waiters in `S`, that overlap
  a conflict range `conflicts(W, C_ref − b)` of `occ_all ⊕ S`. `retry_after` is the
  remaining deadline of the latest of them: by then every one is confirmed or released.
  With one blocker this is the requirement's "that request's remaining deadline"
  (P1-S12: 20 s).
- A **refusal records a tombstone**, so it doubles as this link's release acknowledgement
  (RFC-000 §4.3): a rejected request never needs a further entry here.
- Refusing at `D_c` rather than `D` is stricter than RFC-000's port invariant and always
  safe (a request that cannot hold cannot confirm), because a request cannot begin
  committing after `D_c` in any case (POL-26).
- The answer is sent once the entry is committed in two regions (RFC-000 §3). A
  repeated hold for the same request returns the recorded state, never a second hold
  (A6).

#### 4.2 Counter-offers and availability

**Largest rate** over `W`: `max(0, C_ref − peak(occ_all, W))`. It may exceed the requested
rate (P1-S39: 10 Mbps for an 11 Mbps request). A value below `rate_min` is reported as
0 Mbps, meaning none (P1-S38).

**Earliest window** of the requested length `L`, starting at or after `s`, within the
horizon, fitting `b` (POL-10), with `θ = C_ref − b`:

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
`t = max(s, last_above(occ_all, θ) + 1)` if `t < H`, otherwise none.
`counteroffer_steps` (design constant, 4,096; about 2 ms at worst, est.) bounds the work;
reaching it is reported as "no window found before T", which POL-10 allows ("as far as
can be computed within the budget"). Checked against P1-S16 (`[12:00, 13:00)`), P1-S12
(`[11:00, 12:00)`) and P1-S38 (none, because the open-ended 2 Mbps leaves 8 Mbps
for ever).

Counter-offers are computed **beside committed and held capacity** (`occ_all`), the
capacity that can actually be had now, for every rejection: a `wait = false` rejection as
POL-02 requires, and a no-fit rejection or a waiter refused for no fit likewise
(Requirements issues, RQ-R1-9). They identify no other account, reservation or traffic:
only rates and windows (P1-S17).

They are computed by the leader after applying the refusal, on the tree version at that
entry (§3.2), off the apply thread, while the entry replicates; the result is a function
of that version, so a retried command receives the same counter-offer from any later
leader.

**Availability for routes** (RFC-002 builds the route counter-offer, P2-N11, P2-S73).
`availability(W, b)` returns the largest rate and the earliest window as above;
`fit_ranges(b, from, until, k)` returns up to `k` maximal ranges in `[from, until)` where
`occ_all + b ≤ C_ref`, and where to continue. RFC-002 takes the minimum of the legs'
largest rates (same window) and intersects the legs' fit ranges, asking for further
chunks until it finds a common range of length `L` or reaches the horizon. Both queries
are reads of the leader's latest applied version: advisory, not decisions, and not log
entries.

#### 4.3 Waiting, priority and yields

**Priority.** Waiters are ordered by `priority_rule`; with `request_age` (POL-02) that is
the intake timestamp, ties by request identity (RFC-000 §4.5). The rule is a comparator
selected by a `Policy` entry; it is consulted only between requests that conflict, so it
cannot change the outcome of an uncontended request (P2-S21).

**Older waiters' needs are protected.** Neither a new hold (§4.1) nor a grant may take
capacity that an older, still-eligible waiter needs: each is decided beside `S`, the
pulses of the older waiters overlapping its window. A waiter's need is capacity in flight
(it is a request not yet decided, glossary), so a younger request blocked by it waits. This
is what makes "the oldest waiting request gets capacity that is released" hold (P2-S16,
P2-S97); a younger request whose window does not conflict with an older waiter's need is
not delayed.

**The waiter scan.** Whenever an entry removes occupancy from `occ_all` over a range `R`
(a release, an accepted yield or displacement, a leg change, a restoration, a released
offer hold, a cancelled maintenance booking) or adds to `occ_firm` over `R` (a conversion,
a reduction), the apply runs:

```
scan(R):
  for w in waiters overlapping R, in priority order:
    if ts ≥ w.D_c: continue                          # cannot commit; its owner expires it
    if peak(occ_firm, w.W) + w.b > C_ref:
        refuse_waiter(w, NO_FIT, counter_offer)       # P1-S42, P2-S52; tombstone
        continue
    S_w := pulses of older waiters overlapping w.W with ts < their D_c
    if peak(occ_all ⊕ S_w, w.W) + w.b ≤ C_ref:
        grant(w): add pulse to occ_all; w becomes a hold (same attempt)   # P1-S11, P2-S20
    else:
        request_yields(w)
```

A grant is notified to the account owner as "capacity granted" (the RFC-000 "capacity
released to a waiter" notification). If the request has meanwhile ended, the account
owner's request-scoped release ends the grant (A9).

**Yields** (POL-02; RFC-000 §3, A9). `request_yields(w)` sends a yield request to the
account owner of every holder `h` that overlaps `w`'s conflict ranges, is **younger** than
`w` and carries the **waiting mark**, at most one outstanding per (request, attempt). The
mark is set and cleared by `mark_waiting` commands from the account owner, which "tells
every link owner where it holds capacity" when its request starts or stops waiting
(RFC-000 §3); a `mark_waiting` that sets the mark also raises yield requests for the
older waiters it blocks. The account owner accepts only if the request is still waiting,
in its own serial order; on `yield_accept(r, attempt)` the link, in one entry, removes
that attempt's pulse, registers `r` as a waiter (attempt + 1, same age and window, so it
keeps its place, P2-S97) and scans. A refusal or a stale attempt changes nothing. A holder
without the mark is never asked (P2-S58). Every younger waiting holder yields, so
crossings and longer cycles break without being detected (P2-S19, P2-S87, P2-S88), and a
request blocked by an older holder that is not waiting waits for that holder's outcome,
which comes by its deadline.

**What a waiter gets back.** A waiter refused for no fit is rejected with a counter-offer
(P2-S52, P1-S42). A waiter whose deadline passes is ended by its account owner,
"deadline passed while waiting", with the `retry_after` taken from the waiting notice
(RFC-000 §4.3, P2-S61, P2-S95). The waiting notice is re-sent when the latest blocker's
deadline changes.

#### 4.4 Conversion, release, tombstones and expiry

- **Convert** (on a confirmed outcome; asynchronous, idempotent by request): carries the
  reservation, part identity and the **decision timestamp** `T_dec`. The hold's pulse is
  added to `occ_firm` and `occ_phys`; `occ_all` is unchanged, so confirming never counts the
  capacity twice (P1-S09); the part is recorded with age `T_dec`; the hold is removed; the
  waiters overlapping it are scanned for no-fit refusals (P2-S52). A convert for a request
  with no hold here is a protocol violation (the account owner confirms only with every
  leg held): it is refused, `NO_HOLD`, and alerted.
- **Release** (request-scoped, on a non-confirmed outcome, A9): carries `D`. In one entry
  it removes every hold, waiter registration and grant of the request, whatever the
  attempt, cancels its outstanding yield and displacement requests, records a **tombstone**
  until `D + release_grace` and scans. It is acknowledged once durable; that
  acknowledgement is what the account owner's "releases durable" entry collects (RFC-000
  §4.3, A10). A release for a request this link has never seen still records the
  tombstone, so a hold command still in flight is refused when it arrives (A0R-03). The
  capacity is free for others from this entry; the outcome is reported only after it
  (P1-S08, P1-S18, P2-S14).
- **Tombstones** are removed lazily by any entry with `ts > D + release_grace`. From then
  on `ts ≥ D_c` refuses any late hold or grant for the request on its own (I3). At the
  hottest link they number about 90,000, a few MB (§9).
- **Expiry requests** (liveness only, A8). When the leader's clock passes `D` for a request
  that still has a hold or waiter here, the leader sends the account owner an "expire if
  undecided" request (RFC-002's outcome and expiry port), keeps the hold and raises an
  alert (RFC-000 §3, deadline path). It retries every second. The answer carries the
  committed outcome, confirmed with `T_dec` (convert) or not (release). If no answer
  arrives, the hold is still kept: releasing without an outcome could release under a
  confirmation (POL-26's reasoning); the decision record's takeover and expiry bring the
  release within `release_grace` (P1-S54, P2-S104), and a confirmation decided in time and
  known late converts the hold (P2-S106). Expiry requests are messages, not entries; their
  identity is (link, request, "expire").

#### 4.5 Changes to confirmed legs

The account owner owns the route-level reservation and its change queue (RFC-002, POL-08);
the link applies the effect on its leg. Each change carries its identity, the effective
minute and the account owner's decision time (for known-at, §6):

| Command | Effect on the link | Used for |
|---|---|---|
| `end_leg(reservation, from T)` | Every part of the reservation: pulse `−b` over `[max(s, T), e)` in `occ_firm`, `occ_all`, `occ_phys` | Cancellation and shortening at the next minute boundary (P2-S43, P2-S44, P2-S84, P2-S85), revocation (P1-S32, P1-S36), release after suspension (POL-16), termination (POL-30), a move off the link (P1-S35, P1-S53) |
| `reduce_parts(reservation, [(part, Mbps)], from T)` | Each named part reduced by its amount from `T` | Rate decrease, which RFC-002 applies last in, first out and names part by part (P2-S48); a POL-07 reduction (P1-S47) |

An extension or increase is a new admission of the difference through §4.1 under the
change request's own identity, which becomes a new part with its own age on conversion
(P2-S45, P2-S47, P1-S46). A rejected extension or increase leaves the existing parts
untouched (P2-S46, P2-S74). The link does not choose which parts a decrease removes: the
command names them, so the account owner's last-in-first-out rule has one implementation.
Every change runs the waiter scan over the freed range.

### 5. Capacity changes

All supply commands are authorised by identity and access (RFC-005) and checked again here
against the registry: maintenance and permanent reductions only from the link's supplier;
outages and restorations from the supplier or a network operations operator (POL-07,
POL-32). Anyone else gets "not found", as if the link did not exist (X1-S22); a network
operations operator attempting a commercial change gets "refused" (X1-S23). Every supply
entry carries the principal, role and reason (X1-N8).

#### 5.1 Displacement of pending requests

From the moment a reduction is recorded, new sales and requests still pending or waiting
are decided against the reduced capacity (P1-N8). New sales are, by construction (the
reduction is in `occ_firm` and `occ_all`). For the holds and waiters already present, the
entry that adds the reduction also, in the same apply:

```
displace(R):                                   # R: range where capacity fell
  T := occ_all minus the pulses of every hold overlapping R
  for h in those holds, in priority order:     # older holds keep capacity first
    if peak(T, h.W) + h.b ≤ C_ref: T += h      # still fits beside committed and older holds
    else: mark h displaced; notify its account owner:
            DISPLACED(h, fits_on_committed = peak(occ_firm, h.W) + h.b ≤ C_ref, counter_offer)
  scan(R)                                      # waiters with no fit are refused (P1-S42)
```

A displaced hold **keeps counting** in `occ_all` until its account owner answers (A9); the
link cannot end it. If the request has not decided, the account owner ends it *rejected*
for no fit with the counter-offer (P1-S41) and releases it, or, if it still fits on
committed capacity and is not committing, accepts the displacement, after which the link
turns the hold into a waiter (attempt + 1), as for a yield. A partner route that has sent
its partner confirm but not decided is ended the same way, the partner booking being
cancelled at Share's cost (POL-28, RFC-000 §3).

**The residual race.** If the account owner's deciding confirm entry is appended while the
displacement notice is in flight (one hop and one commit, about 5 to 30 ms, est.), the
conversion arrives for a displaced hold. The decision is final, so the link records the
part; if `T_dec` is not before the reduction's record, the confirmation was made after the
reduction and exceeds it. The part is flagged affected like every reservation at those
minutes, and an alert `CONFIRMED_AFTER_REDUCTION` is raised. This contradicts the letter
of P1-N1 for a window of milliseconds per reduction; Requirements issues RQ-R1-1 and
Architecture issues AI-R1-4 state the options.

#### 5.2 Unplanned outage and restoration

- `record_outage(to_capacity, attribution, reason)` from the supplier or network
  operations: `Δ = current physical capacity − to_capacity` (it must be positive; a value
  at or above the current capacity is invalid). The impulse `+Δ` is added at
  `floor_minute(ts)` (open-ended) to `occ_firm`, `occ_all` and `occ_phys`: from its record
  until its restoration, for every window sold (P1-S24, P1-S49), then §5.1 (P1-S41, P1-S42).
  Confirmed reservations are untouched (P1-S25).
- Works carried out on sold capacity after a rejected maintenance booking are recorded the
  same way, with `attribution = supplier` for SLA purposes (Problem 6, P1-S51).
- `record_restoration(outage, to_capacity?)`: the impulse `−Δ` (or the part restored) at
  the **next minute boundary** after the record. Capacity is sellable again from it
  (P1-S27); the waiter scan runs. Flags end there (P1-S40; Requirements issues RQ-R1-2 on the
  minute in which a restoration falls).
- Overlapping outages are separate facts with their own `Δ`; a restoration names the
  outage or outages it ends.

#### 5.3 Planned maintenance

`book_maintenance(rate m, window W)` from the link's supplier:

1. The window follows §2's rules, relative to the command's `ts`.
2. The UTC calendar date of `W`'s start minus today's UTC date is at least
   `maintenance_notice` (14 calendar days); otherwise rejected stating the notice required
   (P1-S30).
3. If `peak(occ_firm, W) + m > C_ref`: rejected stating that the supplier may wait for
   capacity to free or announce a permanent reduction with `revocation_notice` (P1-S29).
4. If it fits on `occ_firm` but not beside holds and older waiters (`occ_all ⊕ S`):
   rejected with `retry_after` (holds clear within `route_deadline_max` +
   `release_grace`; Requirements issues RQ-R1-5).
5. Otherwise confirmed (P1-S28): the pulse is added to all three occupancies. It is
   supplier occupancy, not a reservation: it never accrues and is excluded from rating and
   settlement (POL-07); the schedule feed labels it so.

Because maintenance is admitted only on free capacity, it can never make a reservation
affected. Cancelling a maintenance booking (the supplier's own) removes the pulse and scans
waiters (RQ-R1-5).

#### 5.4 Permanent reduction

`announce_reduction(new_capacity)` from the link's supplier, at `ts`:

- `Δ = current sellable capacity − new_capacity` (positive). `T_eff` is the first minute
  boundary at or after `ts + revocation_notice`. In the announcing entry: `+Δ` at
  `floor_minute(ts)` (open-ended) in `occ_firm` and `occ_all`, so new sales stop at once
  at the reduced capacity (P1-S43); `+Δ` at `T_eff` (open-ended) in `occ_phys`, so the
  link still carries its capacity until the notice ends (P1-S44); then §5.1.
- **Affected parts, newest first** (POL-07 step 2). The excess at a minute `t ≥ T_eff` is
  `occ_phys(t) − C_ref`. The affected parts are computed by the greedy below, over parts
  in **age order, newest first** (each added part with its own age, P1-S46):

  ```
  for p in parts overlapping [T_eff, ∞), newest first, while max excess over [T_eff, ∞) > 0:
      W' := p.window ∩ [T_eff, ∞)
      cut := min(p.b, peak(excess, W'))           # just enough Mbps, uniform over the part
      if cut > 0: record (p, cut); subtract the pulse (W', cut) from the excess
  ```

  A part is reduced only as far as needed and revoked if the cut reaches its whole rate
  (P1-S31, P1-S32, P1-S46, P1-S47). Because a part's rate is uniform over its window
  (POL-08), the cut is the largest excess it meets (Requirements issues RQ-R1-4).
- **At the announcement, the greedy is a projection** (§7.3): it is computed off the apply
  thread on the version after the announcing entry, and again whenever committed capacity
  changes at or after `T_eff` before the notice ends (a cancellation, or a conversion of
  a hold taken before the announcement), and its result is emitted to RFC-002 as
  "affected by permanent reduction" with each part's cut. RFC-002 makes the equivalent-path
  offers and tells the holder (P1-S31, P1-S58, P1-S59). An earlier offer stays open
  even if a later recomputation no longer needs the part (Requirements issues RQ-R1-3).
- **At `T_eff` the cut is decided in the log.** When the leader's clock passes `T_eff` it
  proposes `ReductionStep` entries. Each processes, deterministically, the next
  `reduction_step_parts` (design constant, 1,000) parts in newest-first order from the
  reduction's cursor, using the greedy against the state at that entry, and records each
  cut by adding the pulse `−cut` over `[T_eff, p.e)` to `occ_phys` as a decided-but-not-
  yet-applied removal. Each cut is sent to the account owner as *revoke* (whole part) or
  *reduce* (part of it), effective `T_eff`, through RFC-002's reservation command port; a
  holder whose reservation is reduced may then cancel without a fee (P1-S47, POL-08).
  Stepping stops, with a final entry, once the excess is 0. Each step costs about 2 ms of
  apply (est.); a link with a million parts takes about a minute of interleaved steps
  (§9).
- **Only decreases can happen in the notice.** After the announcement, new sales fit the
  reduced capacity, so the excess at `t ≥ T_eff` can only rise through holds taken before
  the announcement (at most `route_deadline_max` + `release_grace` after it) and can
  otherwise only fall. So the final cut at `T_eff` never takes more than the parts the
  announcement-time projection could have named, and never more than the reduced capacity
  requires at `T_eff` (P1-N8 success measure).
- The account owner's `reduce_parts` or `end_leg` then removes the part's pulse everywhere
  and withdraws the pending removal in `occ_phys`, a net change of zero there. A moved or
  cancelled part needs no cut: the recomputation at `T_eff` sees it gone (P1-S35, P1-S52).

#### 5.5 Firm offer holds and moves

An equivalent-path offer is firm on its Share legs (POL-07, RQ-4): Share holds the full
rate on every Share leg of the path from the offer to the reservation's end while the
offer is open, counted as committed for new sales, with no funds hold (D4). On each such
link M:

| Command (from RFC-002) | Effect |
|---|---|
| `offer_hold(offer, reservation, account, b, [now, end), lapse_at)` | Decided like a hold with `wait = false` (§4.1), beside held capacity and older waiters. If it fits, the pulse is added to **all three** occupancies (it is committed). If not, refused, `NO_FIT` or `IN_FLIGHT` with `retry_after`, and RFC-002 offers another path or retries |
| `offer_accept(offer, parts, move_at)` | The reservation's parts on M are recorded with window `[move_at, end)`; the offer hold shrinks to `[now, move_at)`. Net occupancy is unchanged, so nothing can be sold in between (P1-S35, P1-S57, P1-S60) |
| `offer_move_at(offer, T)` | Moves `move_at` earlier to the minute boundary `T` the holder chose; net unchanged (P1-S53) |
| `offer_release(offer)` | On a decline, a lapse, or a failed partner booking at acceptance: the pulse is removed at once from all three, tombstoned until `lapse_at + release_grace`, and the waiter scan runs (P1-S57, P1-S61) |

A request that fits only without the offer's capacity is rejected for no fit, not left
waiting (P1-S56), because the offer hold is in `occ_firm`. A partner leg is never held
(P1-S59): RFC-002 books it only at acceptance. The parts recorded on acceptance carry the
ages RFC-002 assigns (Requirements issues RQ-R1-11). As a backstop, if an offer hold
outlives `lapse_at`, the leader asks RFC-002 for the offer's outcome, as for an expiry
(§4.4).

#### 5.6 Affected flags and notices

**Outage flags** (POL-07). For each outage, the overcommitted ranges are
`conflicts(occ_phys, [from, ∞), C_ref)` intersected with the outage's range (from its
record to its restoration, or open). **Every** part overlapping such a range is affected at
exactly the minutes of the intersection, none before another (P1-S25); a range that
reaches the last key extends open-ended, because no positive impulse lies beyond the
horizon (§3.1). An outage that leaves capacity at or above what is committed has no such
range and affects nothing (P1-S48). Offer holds count in the committed rate but are not
reservations and are not flagged (Requirements issues RQ-R1-6). Flags are recomputed over
the changed range whenever committed capacity changes inside an open outage, so they stay
exact (P1-N8 success measure).

Flags are a **projection** (§7.3), not log entries: a deterministic function of the log
that the leader computes off the apply thread and emits on the link schedule feed as
`AFFECTED_CHANGED` events, each with the reservation, the minute ranges, the cause and a
**notice due time**:

- a reservation active at the outage's record: due at the record (P1-S26);
- one that starts during the outage: due at its start (P1-S50);
- on restoration: due at the restoration, for every holder already told (P1-S40).

When `ts` passes a due time the leader emits the notice event for the holder and for
network operations; the notifier (RFC-006) delivers within `affected_notice_time` (60 s).
The link's budget for its part is 10 s at p99 (est.: projection plus feed lag), leaving
50 s for delivery. RFC-002 consumes the same events to mark route-level reservations
affected.

### 6. Known-at history

Every schedule fact has a **valid time** (the minutes it covers) and a **known time** (when
Share knew it, POL-19, P1-N9):

| Fact | Valid time | Known from |
|---|---|---|
| Leg part | Its window | `T_dec`, the account owner's decision timestamp carried by the conversion (RFC-000 A0-15), not the time the link applied it |
| Leg change (end, reduction, move) | From its effective minute | The account owner's decision time for the change, carried by the command |
| Capacity hold, waiter, offer hold | Its window | Its entry's `ts`, until its release, conversion or refusal |
| Capacity fact | Its range | Its entry's `ts` |

`schedule_as_known_at(link, T)` returns every part known at `T` with the changes known at
`T` applied, the capacity profile known at `T` and, optionally, the holds then present.
`schedule_as_recorded_at(link, T)` returns the state of the log at the last position with
`ts ≤ T`; the two differ only by conversions and changes decided before `T` but applied
after it (milliseconds, or up to `release_grace` during a failover). P1-S33: R known from
09:00 for `[10:00, 12:00)`; its cancellation known from 09:30:20 with effect from 09:31;
so at 08:45 nothing, at 09:15 R confirmed, at 09:45 R cancelled from 09:31.

History (RFC-006) archives the link's sealed log segments for 7 years in two-region object
storage and builds the bitemporal index from them; the semantics above are the contract
(RFC-000 §8, "History query"). Because every fact and change carries its known time and
the apply is deterministic, the index can be rebuilt from the segments alone, and any
decision can be explained by replaying the link's log to that position (P1-N9).

### 7. Replicated log and state machine

#### 7.1 Entries

Every entry carries its term, index and `ts`, its command identity, its sender (component,
partition, term) and, for supply and operator commands, the audit fields (principal,
role, reason; X1-N8). The results of an entry (held, refused, waiting, granted,
displaced) are not stored in it: they are computed by applying it and emitted on the feed
with the entry's position.

| Entry | From | Apply |
|---|---|---|
| `Init(registry record, policy)` | Placement, on registration (§10) | Sets `C_ref`, supplier, kind, probe flag, policy |
| `Takeover(term)` | A new leader, first | Nothing but the term; timers are rebuilt from state (§8) |
| `Policy(version, parameters)` | Configuration deployment | Parameters and algorithm version from this position |
| `Registry(version, change)` | Registry feed | Probe flag, status |
| `Tick` | Leader, once a second if no other entry | Advances `ts` (tombstone removal, due notices, `T_eff`) |
| `Hold`, `Convert`, `Release` | Account owner | §4.1, §4.4 |
| `MarkWaiting`, `YieldAccept`, `YieldRefuse`, `DisplaceAccept` | Account owner | §4.3, §5.1 |
| `EndLeg`, `ReduceParts` | Account owner | §4.5 |
| `OfferHold`, `OfferAccept`, `OfferMoveAt`, `OfferRelease` | Account owner | §5.5 |
| `Outage`, `Restoration` | Supplier or network operations | §5.2 |
| `Maintenance`, `MaintenanceCancel` | Supplier | §5.3 |
| `ReductionAnnounce`, `ReductionStep` | Supplier; leader at `T_eff` | §5.4 |
| `Compact(through)` | Leader, daily | §7.4 |
| `Moved(epoch)` | Placement | Final entry before a partition move; every later command refused (RFC-000 §5.2) |

Queries (`query`, `availability`, `fit_ranges`, history) are not entries.

#### 7.2 Apply rules and determinism

- Integer arithmetic only; every iteration in a stable order (priority order, age order,
  minute order, request identity); no clock, random number or unordered map iteration in
  the apply.
- The algorithm version (the counter-offer step bound, the greedy, the priority
  comparator) is fixed by the `Policy` entry in force, so a new leader running newer code
  applies old entries as they were applied (I5).
- Each replica computes a digest of its state at snapshot positions; a mismatch fences the
  divergent replica and alerts (RFC-006).
- Per-entry apply cost is bounded: a hold or release is a few tree operations (2 to 10 µs,
  est.); the costly cases are bounded by design: waiter scans by the waiters overlapping
  the changed range, displacement by the holds overlapping it (about 190 at the hottest
  link, §9), reduction steps by `reduction_step_parts`.

#### 7.3 Projections

Outage flags and their notice due times (§5.6), the announcement-time affected parts of a
permanent reduction (§5.4) and counter-offers (§4.2) are **deterministic functions of the
state at a log position**. The leader computes them on a pinned tree version, off the
apply thread, and emits their outputs with identity (link, causing position, kind,
subject), so any leader computes, and any consumer deduplicates, the same events. Each
projection records the position through which its output has been emitted; a new leader
resumes from the last checkpoint and re-emits at most what was emitted since (§8).
RFC-000 §2 lists affected flags as link-owned state; they are, as derived state of the
link's log (A4), not as entries of it (Architecture issues AI-R1-6).

#### 7.4 Snapshots and compaction

- **Snapshots** are taken every 10 min (or 3 M entries) from a pinned version without
  pausing the apply, and stored in two-region object storage (RFC-006). They serve only a
  replaced or lagging voter; failover uses voters that already hold the state (§8).
- **Compaction.** A daily `Compact(through = now_m − 1 day)` folds keys below `through`
  into `carry` and drops parts, holds, offer holds and tombstones wholly in the past from
  memory; they remain in the log and in history. Nothing admission reads is lost: every
  window starts at or after the current minute (§2, V4).
- **Retention.** Sealed log segments go to history for 7 years (POL-19, X2-N6); only the
  live tail stays on the five voters (RFC-000 §5.3).

### 8. Crash and failover behaviour

| Event | Behaviour | Effect |
|---|---|---|
| Leader process or node lost | A follower already holding the applied state wins the election (seconds; RFC-006), commits `Takeover(term)` before anything else, and rebuilds its timers from state: expiry requests for holds past `D`, `ReductionStep` for reductions past `T_eff`, offer-lapse backstops, due notices. Projections resume from their checkpoints | No fact lost (RPO 0); decisions and replies resume within admission's 1 min RTO, designed for under 15 s (est.) |
| A reply lost in flight | The account owner retries with the same identity; the new leader returns the recorded state (held, waiting, refused with the same counter-offer, released, converted) | Exactly one effect per command (A6) |
| A command routed to a deposed leader or with a stale epoch | Refused, `NOT_LEADER` or `STALE_EPOCH`; the sender re-routes. A deposed leader stops deciding before its lease ends (RFC-000 §5.2) | Never two writers |
| The link fails over while a request ends | The release cannot become durable until the new leader applies it; the account owner re-sends releases for every ending entry without "releases durable"; the outcome is reported once it is durable, within `release_grace` (P1-S62, P2-S107). Nobody can book the link meanwhile | Capacity free from the report |
| The account owner is unavailable at a hold's `D` | The link keeps the hold, asks for expiry, retries and alerts; the takeover and expiry entries at the account owner bring the outcome within `release_grace` (P1-S54, P2-S104, P2-S106) | Never released under a confirmation |
| Hold, convert and release reordered or duplicated | Release before hold: the tombstone refuses the hold. Duplicate hold or convert: recorded state returned. Convert without hold: refused and alerted. Stale yield or displacement acceptance: no effect (attempt mismatch) | Port invariants (RFC-000 §8) |
| The link loses quorum (its region isolated, RFC-000 §5.1) | No entry commits; holds and releases wait; the account owner answers `pending`; placement moves the leader region-wide | Counts against admission's availability |
| Declared region disaster | Groups reconfigured to 2 + 2 (RFC-006); each link commit about 65 to 70 ms (est.) | Latency targets suspended (POL-06); nothing lost |
| A replica's state diverges | Digest mismatch at a snapshot position: the replica is fenced and rebuilt from snapshot and log | No wrong decision is ever committed by it, since only the leader decides |
| Hot link rebalanced to another group | `Moved(epoch)` in the old group; the new group starts from the snapshot at that position; commands with the old epoch are refused | One writer throughout |

### 9. Sizing for the hottest link at ×50

POL-06's design load is ×50 of today's; the hottest link takes 2,500 requests/s of it.
The mix is POL-06's (80% single-link, 20% routes, 70% fit); the rest are estimates.

| Quantity | Estimate | Basis |
|---|---|---|
| Hold entries | 2,500/s | POL-06 |
| Conversions | about 1,750/s | 70% fit |
| Refusals | about 750/s, one entry each (the hold entry itself) | 30% |
| Releases after a hold | about 200/s | Route requests failing elsewhere, withdrawals, deadlines (est. 10% of holds) |
| Waiting marks, yields, grants, displacements | about 250/s | Est. 5% of requests contended (below) |
| **Entries** | **about 5,000/s**, sized for 20,000/s | Matches RFC-000 §6 ("at least 5,000") |
| Group commit | every 5 ms, about 25 entries of about 200 B (est.) | RFC-000 §6 |
| Apply CPU | 2 to 10 µs an entry, so at most about 5% of one core; **ceiling about 100,000 entries/s on one core** (est.), 20× the design point | §7.2; the decision is in memory, the commit is the latency |
| Replication | about 1 MB/s to each of four followers | 5,000 × 200 B |
| Log volume | about 86 GB a day for the hottest link, sealed to history | 7 years in two-region object storage (RFC-006) |
| Occupancy trees | at most about 530,000 keys each (minutes from compaction to the horizon), three trees, about 60 MB (est.) | §3.2 |
| Confirmed parts | sized for 10 M parts, about 1 GB with indexes (est.) | At any one minute a 100 Gbps link can carry at most 100,000 parts of 1 Mbps; 10 M needs heavily fragmented future bookings |
| Holds in flight | about 190 at once | A hold lives about 75 ms from its commit to its conversion (RFC-000 §6) |
| Tombstones | about 90,000, a few MB | 750 releases and refusals a second × (60 s + 60 s) (RFC-000 §6) |
| Waiters | at most about 10,000 (est.) | Contended share × deadline |
| Version copies while readers pin | about 50 MB/s of copied nodes, retained a few seconds | §3.2 |
| Snapshot | about 1 to 2 GB at worst, restored in about 5 s plus a tail of up to 10 min (about 15 s of replay), est. | Only for a replaced voter |
| Link step in the single-link budget | about 27 ms at p99: one two-region commit (about 25 ms) plus µs of apply, plus up to 2 ms for a counter-offer computed while the entry replicates | RFC-000 §3 latency table |

**Share answered `pending` because of capacity in flight** (RFC-000 A0-19). A request
waits only if it fits on committed capacity but not beside the holds in flight, that is,
only when the link's free capacity at some minute of its window lies between its rate and
its rate plus the held Mbps there. About 190 holds are in flight, each for about 75 ms.
Under a flash crowd on one window, capacity fills within the first few requests and every
later one is a no-fit rejection, decided at once; the waiting phase lasts only while the
last free Mbps are held. The share is therefore estimated at **1 to 5% of requests on the
hottest link** (est.), and well below 1% on links that are not near full. The R1 spike
measures it by replaying the design mix against the state machine (Risks, R1-3).

**Throughput is not split.** A link has one writer (POL-05), so its ceiling is one apply
thread's. At about 100,000 entries/s (est.) against the design's 5,000, a link would have to
be 20 times hotter than the design load before it became the bottleneck; RFC-000 R5 keeps
it as a measured risk.

### 10. Link registry (the link part of the catalogue)

The catalogue is RFC-003's component; its link part is specified here (RFC-000 §7). It is
the reference data the link owner and every other owner validates links against.

| Field | Meaning |
|---|---|
| `link_id` | Immutable identity |
| `kind` | Share link (schedule kept here) or partner link (kept by the partner, served by a partner adapter, RFC-002) |
| `supplier` | The supplier account whose link it is: the only principal that may book maintenance on it or change what it sells (POL-07, X1-N10) |
| `endpoints` | The two endpoints the link joins, for routing and for what a supplier sees (POL-33) |
| `initial_capacity` | For a Share link, its capacity at registration, which becomes `C_ref`. Current capacity lives in the schedule owner's capacity history, never here |
| `probe` | Whether it is a designated probe link (POL-06; RFC-006's probe designation) |
| `status` | `active`, or `retired` (no part, hold or offer hold remains) |
| `version`, audit fields | Every change with its principal, role and reason (X1-N8) |

- **Writer.** The catalogue's link-registry partition, one per link, on a two-region log
  (A3); RFC-003 fixes the catalogue's deployment. Commands come only through the operator
  console under RFC-005's authorisation (Requirements issues RQ-R1-7: no requirement says
  who registers or retires a link).
- **Registering** a Share link makes placement create its partition, whose first entry is
  `Init` with the record. **Retiring** is accepted only once the schedule owner reports
  that no part, hold or offer hold remains from now on (normally after a permanent
  reduction to zero has taken effect).
- **Feed and query.** Every change is published on the registry feed (ordered per link, at
  least once, idempotent by `(link_id, version)`) and served by `get_link`. Consumers: the
  link schedule owner (`Registry` entries), RFC-002 (route validation: the link exists,
  is active, its kind), RFC-003 (rating), RFC-004 (the supplier to settle with), RFC-005
  (the supplier check of X1-N10), RFC-006 (probe designation).

### 11. Contracts

Semantics only; RFC-000 §8 names them, and the delivery phase fixes schemas and wire
formats. Every command carries `link_id`, the partition epoch it was routed with and its
identity. Common errors: `NOT_LEADER` (with a hint) and `STALE_EPOCH` (re-route);
`UNAVAILABLE` (no quorum; retry within the request's deadline); `UNKNOWN_LINK`;
`LINK_RETIRED`; `MISMATCH` (same identity, different content: nothing changes, alerted).
Commands are answered once their entry is durable in two regions. Commands for one link
are applied in one total order, the link log's; there is no order across links.

#### 11.1 Provided

**Link hold port** (synchronous commands; consumer RFC-002's account owner).

| Operation | Input | Output | Errors | Idempotency |
|---|---|---|---|---|
| `hold` | request, account, leg, kind (`booking`, `change` with its reservation), rate, window, `D`, `D_c`, `request_age` (intake timestamp), `wait`, policy version | `HELD(attempt)`; `WAITING(attempt, ahead_deadline)`; `REFUSED(reason, counter_offer?, retry_after?)` with reason `NO_FIT`, `IN_FLIGHT` (`wait = false`), `DEADLINE_PASSED`, `TOMBSTONED`, `INVALID(rule)`. A refusal records a tombstone and **is** the release acknowledgement | common | By request: a repeat returns the request's current state here (held, waiting, refused, released, converted) |
| `convert` | request, reservation, part, `T_dec` | `CONVERTED(part)` | `NO_HOLD`, `TOMBSTONED` (both protocol violations, alerted) | By request |
| `release` | request, `D`, reason, decision time | `RELEASED`, sent once durable: the acknowledgement "releases durable" collects. Ends every hold, waiter registration and grant of the request, whatever the attempt, and tombstones it until `D + release_grace`, also for a request not seen | common | By request; a repeat is acknowledged again |
| `query` | request | Its state here and its tombstone expiry | common | Read |
| `end_leg` | reservation, change, effective minute, cause (cancel, shorten, revoke, release, terminate, move), decision time | `CHANGED` | `UNKNOWN_RESERVATION` (violation) | By change |
| `reduce_parts` | reservation, change, `[(part, Mbps)]`, effective minute, cause (decrease, POL-07), decision time | `CHANGED` | `UNKNOWN_PART` (violation) | By change |
| `offer_hold` | offer, reservation, account, rate, `[from, end)`, `lapse_at` | `HELD`; `REFUSED(NO_FIT \| IN_FLIGHT, retry_after?)` | common | By offer |
| `offer_accept` | offer, parts with their ages, `move_at`, decision time | `ACCEPTED` | `UNKNOWN_OFFER`, `TOMBSTONED` | By offer |
| `offer_move_at` | offer, earlier minute boundary, decision time | `MOVED` | `UNKNOWN_OFFER`, `INVALID` (not earlier, not a boundary) | By (offer, minute) |
| `offer_release` | offer, reason | `RELEASED` once durable; tombstone until `lapse_at + release_grace` | common | By offer |

Port invariants (RFC-000 §8, A0R-03), all enforced in the apply: a release ends every hold,
waiter registration and grant of the request, whatever the attempt; a tombstone kept until
`D + release_grace` refuses any later hold or grant for it; no hold or grant is made at or
after `D_c`, hence never past `D`; a refusal records a tombstone and counts as the release
acknowledgement; only a release, an accepted yield or an accepted displacement ends a hold
other than by its conversion.

**Link waiting port** (notifications to the account owner, and one command from it).
Notifications are asynchronous, at least once, ordered per link, each identified by (link,
term, position, index) for idempotent consumption.

| Message | Direction | Content and meaning |
|---|---|---|
| `WAITING_NOTICE` | Link → account owner | (request, attempt, deadline of the request ahead); re-sent when that deadline changes. Registration as a waiter is the `WAITING` answer to `hold` |
| `GRANTED` | Link → account owner | (request, attempt): capacity released to the waiter is now held for it |
| `YIELD_REQUEST` | Link → account owner | (younger request, attempt, older request it blocks); at most one outstanding per (request, attempt) |
| `DISPLACED` | Link → account owner | (request, attempt, fits on committed capacity or not, counter-offer): a capacity reduction means the hold no longer fits (§5.1) |
| `WAITER_REFUSED` | Link → account owner | (request, `NO_FIT`, counter-offer); tombstoned |
| `mark_waiting` | Account owner → link | (request, waiting or not, the account-log position it reflects); applied only if newer than the last applied for the request |

**Link availability query** (synchronous read; consumer RFC-002): `availability(window,
rate)` → largest rate, earliest window (or none, or "not found before T"), as-of
position; `fit_ranges(rate, from, until, k)` → up to `k` ranges and where to continue
(§4.2). Advisory, from the leader's latest applied version; no idempotency needed.

**Link supply commands** (synchronous; from the supplier API through RFC-005's edge, and
from the operator console).

| Operation | Who | Output | Refusals |
|---|---|---|---|
| `record_outage(key, to_capacity, attribution, reason)` | Supplier or network operations | `RECORDED(outage, effective from minute, Δ)` | `INVALID` (not below the current capacity) |
| `record_restoration(key, outage, to_capacity?)` | Supplier or network operations | `RECORDED(effective from minute)` | `UNKNOWN_OUTAGE` |
| `book_maintenance(key, rate, window)` | Supplier | `CONFIRMED(maintenance)`; `REJECTED(NEEDS_COMMITTED)` stating wait or announce a permanent reduction; `REJECTED(NOTICE_TOO_SHORT, maintenance_notice)`; `REJECTED(IN_FLIGHT, retry_after)` | `INVALID` |
| `cancel_maintenance(maintenance)` | Supplier | `CANCELLED` | `UNKNOWN_MAINTENANCE` |
| `announce_reduction(key, new_capacity)` | Supplier | `RECORDED(reduction, T_eff)` | `INVALID` (not below the sellable capacity) |

An unauthorised principal is answered `UNKNOWN_LINK` whatever the operation (X1-S22); a
network operations operator attempting maintenance or a permanent reduction is answered
`FORBIDDEN_ROLE` (X1-S23). Idempotency: by (link, principal's account, key), for the life
of the link, since each is a fact. Results that follow (affected flags, cuts) are on the
feed.

**Link schedule feed** (asynchronous; consumers RFC-002, RFC-003, RFC-006). Ordered per
link, at least once, each event identified by (link, term, position, index) or, for
projections, by (link, causing position, kind, subject).

| Event | Content | Consumers |
|---|---|---|
| `LEG_CONFIRMED`, `LEG_CHANGED` | Reservation, parts, rates, windows, effective minute, cause, known time | RFC-006 (history); RFC-003 if it reconciles legs with the reservation lifecycle feed |
| `CAPACITY_CHANGED` | Kind (outage, restoration, maintenance, maintenance cancelled, reduction announced, reduction effective), amounts, ranges, attribution, principal | RFC-006 (history, notifier, alerting); RFC-003 (maintenance accrues nothing) |
| `AFFECTED_CHANGED` | Reservation, part, minute ranges (open-ended allowed), cause, notice due time; and the notice events when due | RFC-002 (route-level affected), RFC-006 (notifier: holder and network operations) |
| `REDUCTION_AFFECTED` | Reduction, `T_eff`, `[(reservation, part, cut Mbps)]`, as-of position | RFC-002 (equivalent-path offers) |
| `HOLD_EVENT` | Held, waiting, granted, refused, released, converted, displaced | RFC-006 (history, alerting) |
| `ALERT` | `CONFIRMED_AFTER_REDUCTION`, `NO_HOLD`, `UNDECIDED_PAST_DEADLINE`, digest mismatch | RFC-006 (alerting) |

Probe-link facts carry the probe flag so consumers that rate, settle or report exclude
them (POL-06).

**Catalogue link registry** (§10): `register_link`, `set_probe`, `retire_link`
(commands through the operator console, idempotent by key); `get_link` (query); the
registry feed (by `(link_id, version)`). Consumers: RFC-001, RFC-002, RFC-003, RFC-004,
RFC-005, RFC-006.

**History query semantics** (storage RFC-006): `schedule_as_known_at(link, T)` and
`schedule_as_recorded_at(link, T)` as defined in §6; each result names the log positions
it reflects.

#### 11.2 Consumed

| Contract (owner) | What this RFC needs from it |
|---|---|
| Outcome and expiry port (RFC-002) | Outcome notices, which arrive as `convert` or `release`; the answer to "expire if undecided" with the committed outcome (confirmed with `T_dec`, or not); `yield_accept` and `yield_refuse` by (request, attempt); `displacement_accept` by (request, attempt) (AI-R1-3) |
| Reservation command port (RFC-002) | `revoke_or_reduce(reservation, link, reduction, [(part, cut)], effective T_eff)`, idempotent by (link, reduction, reservation); RFC-002 then changes every leg, this link's included, through `end_leg` or `reduce_parts` |
| Principal and authorisation context, operator action envelope, audit record (RFC-005) | The authenticated principal and role on supply and registry commands; the supplier check of X1-N10 (repeated here against the registry) |
| Replicated log, placement, fencing, closed positions, clock bound `ε`, region-wide failover, 2 + 2 reconfiguration, snapshot storage, operational alert feed (RFC-006) | The platform the state machine runs on (§7, §8) |
| Catalogue probe designation (RFC-006) | The probe flag on links |
| Equivalent-path source (routing) | Not consumed here: RFC-002 chooses paths and sends `offer_hold` (AI-R1-5) |

### 12. Design-level acceptance tests

| # | Test | Scenarios |
|---|---|---|
| T-01 | **Oracle.** Random schedules, holds, conversions, releases, leg changes and capacity changes over a year's minutes; every decision equals a per-minute array oracle's (D9), and the three occupancies equal sums recomputed from the facts | P1-S01 … S06, S37, S39 |
| T-02 | **Invariant I1** checked after every entry from the facts alone; the only minutes above `C_ref` are explained by later reductions | P1-S05, S13 |
| T-03 | **Serial equivalence.** Concurrent random load through the log; the applied order is a witness order in which deciding one at a time gives the same outcomes | P1-S13, S14 |
| T-04 | **Counter-offers** against the oracle, including open-ended requests, a schedule full for ever, and the step bound | P1-S12, S15, S16, S38, S39, P2-S18 |
| T-05 | **Validity** rules V1 … V6 at the edges, with the hold reaching the link one minute boundary later than intake | P1-S19, S20 |
| T-06 | **Open-ended and horizon roll**: advance `ts` by days and months; no new sale takes an open-ended reservation's minutes | P1-S21, S22, S23 |
| T-07 | **Holds and waiters**: hold, wait, grant, `wait = false` with `retry_after`, waiter refused when the request ahead converts | P1-S07 … S12, S34, P2-S16, S20, S52 |
| T-08 | **Priority and yields**: crossings, three-cycles, a younger request blocked by an older waiter's need, a holder without the waiting mark not asked, commit fence skipping | P2-S15, S19, S58, S60, S87, S88, S95, S97 |
| T-09 | **Port invariants**: release before hold, duplicate commands, stale attempts, convert without hold, hold at `D_c` | P1-S08, S18, P2-S14 |
| T-10 | **Failover**: kill the leader at every entry kind; replies retried; releases durable within `release_grace`; expiry requests resent | P1-S54, S62, P2-S104, S106, S107 |
| T-11 | **Outages**: flags at exactly the overcommitted minutes, all alike, open-ended; due times; restoration; recomputation on cancellation inside an outage | P1-S24 … S27, S40, S48 … S51 |
| T-12 | **Displacement**, including the race of a confirm with a displacement notice in flight (the alert fires and the part is flagged) | P1-S41, S42 |
| T-13 | **Maintenance**: notice by calendar date, free capacity only, holds | P1-S28 … S30 |
| T-14 | **Permanent reductions**: newest part first, own ages, just enough Mbps, cut at `T_eff` in steps, recomputation when committed capacity falls during the notice | P1-S31, S32, S35, S36, S43 … S47, S52 |
| T-15 | **Offer holds**: counted as committed, no waiting on them, accept, earlier move, decline, lapse, failed partner leg | P1-S53, S55 … S61 |
| T-16 | **Known-at**: rebuild `schedule_as_known_at` from sealed segments and compare with the state at each position | P1-S33 |
| T-17 | **Determinism**: replay the same log on two builds; digests equal at every snapshot | All (I5) |
| T-18 | **Load**: the design mix at 2,500 requests/s on one link for one hour, on the five-voter topology; p99 of the link step, apply CPU, share answered `pending` | X2-S03, S05, S15 |
| T-19 | **Supply authorisation**: every principal and role against every supply command | X1-S22, S23 |

### 13. Traceability

**P1 scenarios** (all primary in this RFC).

| Scenario | Approach |
|---|---|
| P1-S01 | §3.1, §3.2 (peak query and example), §4.1 |
| P1-S02 | §3.2 (peak, not sum), §4.1 |
| P1-S03 | §3.2, §4.1 |
| P1-S04 | §2 (half-open windows), §3.1 |
| P1-S05 | §3.4 I1, §4.1 (decided on `occ_all`), §5.1 |
| P1-S06 | §3.2 (`O(log m)` whatever the length), §4.1 |
| P1-S07 | §4.1 (waiting), §4.3 |
| P1-S08 | §4.4 (release, tombstone, free before the report) |
| P1-S09 | §4.4 (conversion leaves `occ_all` unchanged) |
| P1-S10 | §1, §3.1 (one schedule for single-link and route legs) |
| P1-S11 | §4.3 (scan and grant) |
| P1-S12 | §4.1 (`IN_FLIGHT`, `retry_after`), §4.2 (counter-offer beside held capacity) |
| P1-S13 | §3.4 I1, §7 (one writer, one order) |
| P1-S14 | §7 (serial order of the log); RFC-000 §4.1 across links |
| P1-S15 | §4.2 (largest rate) |
| P1-S16 | §4.2 (earliest window) |
| P1-S17 | §4.2 (rates and windows only) |
| P1-S18 | §4.4 (release, tombstone); invalid and insufficient funds never reach the link (§2; RFC-002, POL-25) |
| P1-S19 | §2 (V1 … V6) |
| P1-S20 | §2 |
| P1-S21 | §3.1 (open-ended impulse) |
| P1-S22 | §3.1, §3.2 (no horizon in the structure) |
| P1-S23 | §2, §3.1 |
| P1-S24 | §5.2 |
| P1-S25 | §5.6 (all alike) |
| P1-S26 | §5.6 (due at the record) |
| P1-S27 | §5.2 (restoration), §4.3 |
| P1-S28 | §5.3 |
| P1-S29 | §5.3 (step 3) |
| P1-S30 | §5.3 (step 2) |
| P1-S31 | §5.4 (newest first, projection to RFC-002 for the offer) |
| P1-S32 | §5.4 (cut at `T_eff`, revoke) |
| P1-S33 | §6 |
| P1-S34 | §4.1 (`WAITING` answered at once; the account owner answers `pending`, RFC-002) |
| P1-S35 | §5.5 (`offer_accept`), §4.5 (`end_leg` at the move) |
| P1-S36 | §5.4 (cut at `T_eff` on decline) |
| P1-S37 | §4.1 (no fit only on `occ_firm`), §3.4 I2 |
| P1-S38 | §4.2 |
| P1-S39 | §2 (a capacity answer), §4.2 |
| P1-S40 | §5.2, §5.6 (restoration notices) |
| P1-S41 | §5.1 (displacement) |
| P1-S42 | §5.1, §4.3 (waiter refused for no fit) |
| P1-S43 | §5.4 (sellable reduction from the announcement) |
| P1-S44 | §5.4 (`occ_phys` from `T_eff`) |
| P1-S45 | §5.4 (cut at `T_eff`); lapse is RFC-002's |
| P1-S46 | §3.3 (part ages), §5.4 |
| P1-S47 | §5.4 (just enough Mbps; reduce; fee-free cancel via RFC-002) |
| P1-S48 | §5.6 |
| P1-S49 | §5.2 (open-ended reduction) |
| P1-S50 | §5.6 (flag ranges; due at start) |
| P1-S51 | §5.2 (attribution), §5.3 |
| P1-S52 | §5.4 (partial cut), §5.5 (whole reservation moves) |
| P1-S53 | §5.5 (`offer_move_at`) |
| P1-S54 | §4.4 (expiry requests, hold kept), §8 |
| P1-S55 | §5.5 |
| P1-S56 | §5.5 (offer hold in `occ_firm`) |
| P1-S57 | §5.5 |
| P1-S58 | §5.4 (projection to RFC-002, which orders paths) |
| P1-S59 | §5.5 (no partner hold) |
| P1-S60 | §5.5 |
| P1-S61 | §5.5 (`offer_release`) |
| P1-S62 | §4.4, §8 |

**Scenarios of needs allocated jointly** (RFC-000 §7: "also RFC-001"). The primary RFC
satisfies each; this RFC provides the link-side part named. Scenarios of these needs with
no link-side behaviour are listed as such.

| Need (primary) | Scenarios with a link-side part | Link-side part | No link-side part |
|---|---|---|---|
| P2-N3 (RFC-002) | P2-S13, S14, S55, S56, S93, S101, S104, S106, S107, S110 | §4.1 (`D_c` refusal), §4.4 (request-scoped release, tombstones, expiry requests, hold kept while the decision record is unavailable), §8 | P2-S11, S12, S53, S57, S86, S100, S103, S105, S109 (deadline values, partner holds and fees, decision entries) |
| P2-N4 (RFC-002) | P2-S15, S16, S17, S18, S19, S20, S21, S52, S58, S59, S60, S61, S62, S87, S88, S92, S95, S97 | §4.1, §4.3 (priority, older waiters' needs, scan, yields, commit fence) | P2-S89, S96 (partner adapters) |
| P2-N9 (RFC-002) | P2-S43, S44, S45, S46, S47, S48, S74, S79, S80, S81, S84, S85, S94 | §4.5 (leg changes; extensions and increases as new admissions), §4.4 (a pending change released when its reservation ends) | P2-S49, S50, S75, S76, S77, S78, S82, S83 (change rules, funds, partners) |
| P2-N11 (RFC-002) | P2-S02, S73 | §4.1 (refusal names this link by being its answer), §4.2 (`availability`, `fit_ranges`) | P2-S31 (partner) |
| X1-N10 (RFC-005) | X1-S22, X1-S23 | §5 (supplier and role check against the registry), §11.1 (supply refusals) | — |
| X2-N2 (RFC-006) | X2-S03 | §9 | X2-S04 (metering) |
| X2-N3 (RFC-006) | X2-S05, S06, S15, S23 | §3.2 (`O(log m)`), §9 (link step), §8 (disaster) | X2-S07, S08, S13, S17, S19, S22 |

**Coverage.** P1: 62 of 62 scenarios designed for here. Jointly allocated needs: 77
scenarios, 50 with a link-side part provided here (43 of P2, 2 of X1, 5 of X2) and 27
without one; every one of the 77 is satisfied by the primary RFC named.

## Benefits

| Target or policy | How this design meets it |
|---|---|
| Never oversold (P1-N1, POL-05) | One writer per link (the log's leader), and invariant I1 checked on every addition; holds count against the link until the account owner ends them (A9). Exceptions are only reductions recorded after the pulses they exceed, plus the residual race of §5.1, which is detected and alerted |
| Requests that fit are confirmed (P1-N2) | The check is the peak, not a sum or a gap (D6); no fit is decided only on committed capacity |
| Cost independent of booking length (X2-S05) | Two point updates and `O(log m)` queries, `m` at most about 530,000 keys (est.); open-ended bookings need no horizon at all |
| Hottest link at ×50 (POL-06, X2-S03) | About 5,000 entries/s against an apply ceiling of about 100,000/s on one core (est.), so 20× margin; the latency is the two-region commit (about 25 ms p99, est.), not the decision. The pre-baseline draft's link-row lock measured p99 115.5 ms with 50 clients on one link, without any two-region commit (D12) |
| One schedule, one priority rule (P1-N3, POL-02) | Single-link and route legs, waiters and yields all in one log; older waiters' needs protected; yields only from waiting holders |
| Rejections actionable and discreet (P1-N4, POL-10) | Largest rate and earliest window from the same tree, computed off the apply thread in µs to 2 ms (est.); no identities |
| Holds outlive no outcome, and late commands recreate none (POL-26, A0R-03) | Request-scoped releases, tombstones until `D + release_grace`, refusal at `D_c` |
| Loss of supply never revokes silently (P1-N8, POL-07) | Sellable and physical capacity kept apart; flags exact, all alike, recomputed when committed capacity changes; newest-first cuts decided at `T_eff`, never before and never more than needed; firm offer holds counted as committed |
| Known-at history (P1-N9, POL-19) | Every fact carries its known time; the log replays to any position; the index is rebuilt from sealed segments |
| Failover (X2-N5) | Followers hold the state; nothing is rebuilt; designed for under 15 s (est.), inside `release_grace` (1 min) |
| Policy changes without mechanism changes | Every parameter and the priority comparator come from `Policy` entries |

## Competition

| Alternative | Why it loses (or where it wins) |
|---|---|
| **Pre-baseline RFC-001: dense impulse segment tree in memory, Postgres link-row lock as the authority** (D5, D11, D12) | Its model **wins and is kept**: pulses and impulses, the `sum`/`maxpref` monoid, facts only (D10), the horizon checks (D30). Its authority loses: one transaction per decision behind the link-row lock, measured p99 115.5 ms at 50 clients without a two-region commit, about one decision per transaction time; correctness depended on the isolation level (`REPEATABLE READ` oversold, D12); the lock queue cannot express POL-02. RFC-000 already replaced it with the replicated log |
| **Dense ring segment tree over a minute array** (the prototype's in-memory structure, D11) | Faster by a constant (1.2 µs p50 measured, D12) and simpler per node. But it fixes the horizon in the structure (the D30 bug was a window past it), needs rebasing as the horizon rolls, and costs about 32 MB per occupancy per link whatever the link's activity, so about 100 MB for every cold link. The sparse B+tree has the same monoid and costs only its change points. Kept as an option for a hot link if the R1 spike shows the B+tree too slow (R1-4) |
| **Slot ledger: one row or cell per minute** (D7) | A year-long booking touches about 525,600 cells (X2-S05 fails) |
| **Change-point map without aggregates** (D9) | `O(log m + k)` per query for `k` change points in the window, and a long or open-ended window sees almost all of them |
| **Range-add, range-max segment tree with lazy propagation** (D9) | Same bounds; a booking is a range update instead of two point updates. No gain |
| **One occupancy plus a hold list, checked by summing overlapping holds** | Summing holds is an upper bound, not a peak, so it would put requests to wait (or reject them with `retry_after`) that fit. Two trees (D14) and a third for physical capacity cost about 40 MB on the hottest link |
| **Holds that expire at the link by a lease** (D13's "expiry on each hold as a backstop") | A link could release a hold under a confirmation still being replicated: an oversell or a partly booked route. Forbidden by A9 and POL-26; the link asks for expiry instead |
| **Wound-wait or priority tickets** (D17, the pre-baseline RFC-002) | The older request pre-empts any younger holder; POL-02 forbids pre-empting a holder that is not waiting |
| **Strict first-come-first-served per link** (head of line) | Satisfies POL-02 but makes every younger request wait behind an older one even when their windows do not conflict. Protecting only the overlapping older waiters' needs gives the same priority with no such delay |
| **First fit among waiters, ignoring priority** | A stream of small younger requests could starve an older large one; breaks POL-02 |
| **Re-validating every hold at the decision** (the account owner asks each link "still valid?" just before its confirm entry) | Closes the reduction race of §5.1 completely, but adds one hop and one link commit to every booking (about +30 ms at p99, est., so about 135 ms single-link in steady state) for an event that needs a capacity reduction during a request's last milliseconds. Kept as the fallback if RQ-R1-1 is decided against the amendment |
| **Recording projections as log entries** (affected flags, announcement-time affected sets) | Makes history self-describing, but an outage on a busy link can flag 100,000 parts (est.): a long apply on the hottest link, inside the 200 ms path. The flags are a pure function of the log, so they are recomputable; only the cuts, which change state, are entries (`ReductionStep`) |
| **Computing a permanent reduction's cut in one entry** | A reduction to zero on a link with a million parts would stall the apply for seconds. Bounded steps keep every entry about 2 ms (est.) |
| **Holding the schedule in a SQL database with an in-memory owner** (the pre-baseline draft's open option) | The replicated log is that database: two-region durable, fenced by term, with no second write path |
| **Partitioning a hot link's schedule by time range** (two owners per link) | A window spans ranges, so every long booking would need a cross-partition commit, and POL-05 forbids two writers of one schedule |

## Risks and open issues

| # | Risk or issue | Mitigation or next step |
|---|---|---|
| R1-1 | **Reduction race** (§5.1): a confirmation decided while the displacement notice is in flight exceeds a reduction recorded a few milliseconds earlier | Detected and alerted (`CONFIRMED_AFTER_REDUCTION`), the part flagged affected; RQ-R1-1 asks the business to accept it; re-validation (Competition) is the fallback |
| R1-2 | **Waiter scans under heavy contention**: cost grows with the waiters overlapping a changed range and their older overlapping waiters | Interval indexes bound the candidates; the R1 spike measures the worst flash crowd; if needed, a scan budget per entry with the remainder continued by a `Tick` |
| R1-3 | **The share answered `pending`** on the hottest link is an estimate (1 to 5%, §9) | Measured in the spike (T-18) |
| R1-4 | **B+tree constants** on the hottest link | Measured; fall back to the dense ring tree (Competition) for links above a change-point threshold, with the same monoid |
| R1-5 | **Projection lag** against `affected_notice_time` (10 s budget here, 50 s to the notifier) after a failover | Projection checkpoints; the failover target under 15 s (est.); alert on lag |
| R1-6 | **Determinism across releases** of the code | Algorithm versions in `Policy` entries; replay test (T-17); digests |
| R1-7 | **A single link is the irreducible serial point** (RFC-000 R5) | 20× margin estimated (§9); measured skew (P1 open question 1) |
| R1-8 | **Large permanent reductions** take about a minute of steps on a link with a million parts (est.) | The cuts are effective-dated at `T_eff`; rating posts within 2 min; steps interleave with admissions |
| R1-9 | **Version copies** cost memory while projections run (about 50 MB/s retained for seconds, est.) | Short pins; projections on a follower if the leader's memory is tight (they are deterministic) |

## Requirements issues

None of these changes the requirements; each is raised for decision, with this RFC's
working interpretation.

| # | Issue | Working interpretation and proposal |
|---|---|---|
| RQ-R1-1 | **Capacity reductions racing a decision.** P1-N1 counts a confirmation against the capacity in force when it is made, and P1-N8 decides pending requests against a reduction from its record (P1-S41). Under RFC-000 the link records the reduction and the account owner decides, in two logs; a confirm entry appended while the link's displacement notice is in flight (milliseconds) exceeds the reduction | Proposal: amend P1-N1 and POL-07: "a request whose capacity was held before a reduction was recorded and whose decision was already under way may be confirmed; it is then affected like a reservation confirmed before the reduction, and operations is alerted". The alternative, re-validating every hold at the decision, costs about 30 ms on every booking (Competition) |
| RQ-R1-2 | **The minute of a restoration.** P1-S40 ends flags "from the minute of the restoration"; for a record at 10:30:20 that minute was still reduced for 20 s | Flags end, and capacity is sellable again, from the next minute boundary after the record; an outage takes effect from the minute in which it is recorded |
| RQ-R1-3 | **The affected set of a permanent reduction when the schedule changes during the notice.** POL-07 defines "just enough, newest first" once; reservations may end, and holds taken before the announcement may convert, during the notice | Offers follow the set as it is recomputed; an offer already made stays open; the cut is decided at `T_eff` against the schedule then, and is never larger than the reduced capacity requires |
| RQ-R1-4 | **"Just enough Mbps" when a part's window meets different excesses at different minutes** | A part's rate is uniform (POL-08), so its cut is the largest excess it meets after the newer parts' cuts |
| RQ-R1-5 | **Maintenance blocked only by capacity holds**, and **cancelling a maintenance booking**: POL-07 says "free capacity only" and says nothing of either | Maintenance must fit beside committed and held capacity; blocked only by holds it is rejected with `retry_after`; the supplier may cancel its own maintenance booking |
| RQ-R1-6 | **An outage on a link carrying an offer hold** for an equivalent path | The offer hold counts in the committed rate but is not a reservation and is not flagged; RFC-002 decides whether the offer stays firm |
| RQ-R1-7 | **Who registers and retires a link, and who records a permanent capacity increase.** POL-32 has no role for it and X1-N10 covers only reductions and outages | Registration and retirement through the operator console under a role to be named in POL-32; an increase as a supplier supply command |
| RQ-R1-8 | **`selling_horizon` "12 months"**, and "now" for the window rules | Calendar months in UTC; both from the request's intake timestamp (§2) |
| RQ-R1-9 | **The capacity a no-fit rejection's counter-offer is computed beside.** POL-10 and POL-02 say "beside the capacity in flight" only for `wait = false` | Every counter-offer is computed beside committed and held capacity, the capacity that can be had now |
| RQ-R1-10 | **`retry_after` with several requests in flight blocking.** POL-05 speaks of "the in-flight request's remaining deadline" | The latest remaining deadline among the blockers |
| RQ-R1-11 | **The ages of a moved reservation's parts on its new path**, which decide whose Mbps a later reduction there takes first (POL-07 step 2) | RFC-002 assigns them; the default proposed is the parts' original ages |
| RQ-R1-12 | **Telling holders when a flag shrinks** because other reservations ended during an outage: POL-07 requires notices at the record, at a reservation's start and on restoration only | The feed carries the change; whether the holder is told is RFC-002's and RFC-006's choice |

## Architecture issues

| # | Issue | Resolution in this RFC; RFC-000 unchanged |
|---|---|---|
| AI-R1-1 | **The link hold port has no operation for changing a confirmed leg.** RFC-000 §8 lists hold, convert, release and query; cancellations, shortenings, decreases (P2-N9), revocations, releases after suspension, terminations and moves all change legs on the link | Added to the link hold port: `end_leg` and `reduce_parts` (§4.5, §11.1), consumer RFC-002 |
| AI-R1-2 | **Offer (move) holds have no link-side operation.** §8 puts "offer and move to an equivalent path with its move hold" in RFC-002's reservation command port, but the hold is on the link | Added to the link hold port: `offer_hold`, `offer_accept`, `offer_move_at`, `offer_release` (§5.5) |
| AI-R1-3 | **The waiting mark and displacement are in no contract.** §3 says the account owner "tells every link owner where it holds capacity" when its request waits; a capacity reduction needs the link to tell the account owner that a hold no longer fits, and the account owner to accept | `mark_waiting` and `DISPLACED` in the link waiting port; `displacement_accept` expected in RFC-002's outcome and expiry port beside yield acceptance |
| AI-R1-4 | **A9 and the decision at the account owner leave a reduction race** (§5.1, RQ-R1-1). It is architectural: the link cannot refuse a conversion, and the account owner cannot see the link's reductions in its own order | Narrowed to one notice transit by displacement; detected and alerted; closed only by re-validation at the decision or by the requirement amendment |
| AI-R1-5 | **The equivalent-path source lists RFC-001 as a consumer** (§8). The link needs no path; it receives offer holds | Not consumed here |
| AI-R1-6 | **Affected flags as owned state** (§2) | Kept as derived state of the link's log (a deterministic projection, A4), not as log entries; the cuts that change state are entries |
| AI-R1-7 | **Known time of leg changes.** §8 says the conversion carries the decision timestamp; known-at history (P1-N9) needs the same for every leg change and release | Every `end_leg`, `reduce_parts`, offer command and `release` carries the account owner's decision time (§6, §11.1) |
| AI-R1-8 | **The release carries no deadline** in §8, but the tombstone it leaves lives until `D + release_grace` | `release` carries `D` (§11.1) |
| AI-R1-9 | **The hold needs the commit fence** to skip waiters that can no longer commit (as partner adapters do, A0R-08) | `hold` carries `D_c` (§4.1) |
