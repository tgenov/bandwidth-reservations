# RFC-002. Account owner and booking coordination: one decision log per account, request-scoped holds, and partner adapters that stand in for a schedule owner

| | |
|---|---|
| Status | **Accepted, revision 6.** Accepted on 2026-10-13 after the post-C4 errata pass: it conforms to the frozen contracts C01 … C12 and requirements-v1.11, with coverage clean; no separate fix verification (orchestrator decision, to start C5 and C6). Revision 6 rebases revision 5 on `requirements-v1.11` ([record 35](../reviews/35-requirements-amendments-before-c4.md), [record 65](../reviews/65-requirements-amendments-after-c4.md)) and on [RFC-000](RFC-000-architecture.md) revision 4.5 (its RFC-002 rows of "Revision 4.4 errata" and "Revision 4.5 errata"). It applies every erratum, consumer obligation and settled item that names RFC-002 in the frozen contracts [C01](../04-delivery/contracts/C01-platform.md) … [C12](../04-delivery/contracts/C12-partner-port.md), at their current versions. The frozen contracts govern every interface detail. Where this RFC and a frozen contract differ, the contract applies and this RFC is in error. See "Revision 6 resolution" at the end. Revision 5 was **accepted at C3** jointly with RFC-004 on [fix verification 31](../reviews/31-rfc-002-004-fix-verification.md) (K-1, K-3, JI-9 applied). Revision 5 resolves RFC-002's side of the joint items JI-1 … JI-7 of [review 26](../reviews/26-rfc-001-review.md) (decisions D4, D5 in force, with D3's minute-piece cut targets) against RFC-001 revision 4, rebases on `requirements-v1.9` ([record 28](../reviews/28-requirements-amendments-from-c3-round-2.md)) and on [RFC-000](RFC-000-architecture.md) revision 4.3 ("Revision 4.3 errata", RFC-002 row: AI-26-1 … AI-26-3, AI-27-1, AI-27-2, AI4-11, B-AI-11, B-AI-12), and matches RFC-006 revision 4's runtime (slot map, events and notifications, fences); see "Revision 5 resolution" at the end. Revision 4 applies the findings of the joint [review 18](../reviews/18-rfc-002-004-joint-review.md) that RFC-002 owns or shares (J-01 … J-08, J-10, J-12 … J-15, J-17 … J-19; decisions D-1 … D-6), and rebases on `requirements-v1.8` ([record 22](../reviews/22-requirements-amendments-from-c3-reviews.md)) and on [RFC-000](RFC-000-architecture.md) revision 4.2 ("Revision 4.2 errata"); see "Revision 4 resolution" at the end. Revision 3 rebased revision 2 on `requirements-v1.7` and RFC-000 revision 4.1; revision 2 rebased revision 1 on `requirements-v1.6` and RFC-000 revision 4 (the distributed SQL substrate). To be reviewed and approved **together with RFC-004 Part A** (the funds-and-standing module of the same account owner, RFC-000 §7); §2.4 is the interface both must accept |
| Satisfies | P2-S01 … P2-S122 (all 122 P2 scenarios; the traceability table at the end maps each to its section). Also the booking side of P1-S07, P1-S08, P1-S11, P1-S12, P1-S14, P1-S77, P1-S34, P1-S41, P1-S42, P1-S54, P1-S62, P1-S63, P1-S78, P1-S70, P1-S73, P1-S84 and of the equivalent-path scenarios P1-S31 … P1-S61 (reservation-level offers, moves, revocations); the account-owner side of P4-S20, P4-S23, P4-S66, P4-S97, P4-S101, P4-S108 (the price-change entries), P4-S114 (the resume amount passed through), X1-S05 … X1-S09, X1-S36 (the termination entry), X2-S03, X2-S05, X2-S06, X2-S15, X2-S21, X2-S27 (probe accounts are ordinary accounts here); the "fee shown, who ended" input of P3-S11, P3-S43, P3-S44, P3-S60, P3-S63, P3-S74 |
| Policies | POL-01, POL-02, POL-03, POL-04, POL-05, POL-06, POL-07, POL-08, POL-09, POL-10, POL-14, POL-15, POL-16, POL-18, POL-23, POL-25, POL-26, POL-27, POL-28, POL-29, POL-30, POL-31, POL-32, POL-33 |
| Prior decisions | History log D13, D14, D16, D17, D21, D22 (carried forward or rejected in Competition) |
| Builds on | **Revision 6:** the requirements at tag `requirements-v1.11` (v1.10 decides B-RQ-11, record 35; v1.11 adds P2-S118 … P2-S122 and changes P2-S09, P2-S91, P4-S114 and X1-S36, record 65); [RFC-000](RFC-000-architecture.md) revision 4.5; and the frozen contracts C01 v1, C02 v1.0.0, C03 v2.4, C04 v2.3.1, C05 v1, C06 v1, C07 v1.2, C08 v1.2, C09 v1.1, C10 v1.0.0, C11 v1.0.0 and C12 v1, which are the authority for every interface this RFC provides or consumes (RFC-000 revision 4.5). **Revision 5:** the requirements at tag `requirements-v1.9` (v1.9 changes POL-06, POL-07, POL-32 and P1-N8 as record 28 states, none of which changes an entry kind or port here; v1.6 decides this RFC's B-RQ-1 … B-RQ-8, [review 11](../reviews/11-requirements-amendments-from-detailed-rfcs.md); v1.7 decides B-RQ-9, [review 12](../reviews/12-requirements-amendments-from-rfc-revision-2.md); v1.8 decides B-RQ-10 and review 18's Q-1 … Q-3, [record 22](../reviews/22-requirements-amendments-from-c3-reviews.md)) and [RFC-000](RFC-000-architecture.md) revision 4.3 (4.2 resolves B-AI-7 … B-AI-10 and review 18's A-1 … A-4; 4.3 resolves B-AI-11, B-AI-12 and adopts AI-26-1 … AI-26-3): its principles A1 … A11, the account owner and partner adapters of §2, the protocols of §3 and §4, the substrate of §5.5 (CockroachDB at 2 + 2 + 1, NestJS owners with epoch-fenced owner leases, insert-only log tables, commit timestamps, closed timestamps and changefeeds, Kafka through a transactional outbox, status readers per Kenyan facility) and the contracts of §8, which resolve B-AI-1 … B-AI-6 |
| Supersedes | Revision 1 (written on RFC-000 revision 3.2's custom Raft platform and `requirements-v1.5`); the pre-baseline draft "Route reservation: a saga over held capacity" (both kept in git history) |

**Revision 6 in one paragraph.** The design stands. Revision 6 makes this RFC agree with
the frozen contracts C01 … C12 and with `requirements-v1.11`. The changes are these. A
**quote** gives a stateless token with the shown terms, and a request over a fee-bearing
partner leg must cite one, or it is rejected `quote_required` or `terms_changed` (POL-08,
P2-S121; C10; §3.2, §3.4). A **withdrawal** names the key of its request, and a
withdrawal of an unused key is recorded as a pre-emptive withdrawal (POL-29, P2-S122;
§7.1). A hold on a **link that is being retired** ends the request "link unavailable", with
no counter-offer (POL-07, P2-S120; C02 M-2; §5.1). A holder that **starts to wait** answers
each yield claim of the link (POL-02, P2-S118; C02; §5.3). The owner keeps **one
outstanding command per (reservation, leg)**, in the order of the deciding entries, also
after a takeover, so a cancellation just after a confirmation frees every leg from
`nb(ts)` (P2-S119; C02 C4-3; §9.8). A `cut_target` carries a **revision**, and every
revision above the highest recorded writes one E11 and one `cut` event (C02, C03, C04;
§9.7). The outcome feed's **markers** carry `prevReportPosition` and `pendingAnswered`, so
every request answered `pending`, a change included, gets its webhook (P2-S09; C04; §8.3).
A **withheld termination** marks every event it causes (X1-S36; C04; §9.4). The partner
port has **`change`** for a shorten or a decrease, and `partner_leg_affected` carries the
**delivered** figures (P2-S91; C12; §9.4, §10). `iam_fresh` is **applied and gap-free**
(C05 S-2, C08). The owner handles C01's runtime results and hooks (`Stopped`,
`Ambiguous`, `onMovedOut`, `onAdopt`, splitting slots; §2.5, §12.1).

**Revision 5 in one paragraph.** The design stands; the link-facing contracts are
reconciled with RFC-001 revision 4 and review 26. The account owner **never numbers an
attempt**: it records the attempt `HELD`, `WAITING`, `GRANTED` and `DISPLACED` carry, a
grant keeping the waiter's attempt, and sends it back on `convert`, `yield_accept` and
`displacement_accept` (JI-1, JI-2; §4.3, §5). A POL-07 **cut target is a step function of
the minute**, covering the parts the link accounted for; targets are composed by `min` per
minute, oldest Mbps kept first, and every leg receives each part's resulting rate as
**absolute minute pieces** naming the (link, reduction) pairs applied (AI-26-2, AI-26-3,
JI-5; §9.7). An **equivalent-path move is final only once every new leg is booked**, and
only then are `offer_accept` and the old legs' `end_leg` sent; a failed partner booking at
acceptance leaves the reservation on its path, cut only by the target (D4, JI-3, P1-S61,
P1-S52; §9.6). A target for **offer parts binds only the move** (D5, JI-4). Commands to and
from the owner follow RFC-006 revision 4's runtime: slots from placement's map with its
version, `Moved` and `Moving` answers, (generation, epoch) on every command, feed events
apart from point-to-point notifications (§2.5); readers fence moved partitions and lapsed
renewals (AI-27-1, AI-27-2; §8.2).

**Revision 4 in one paragraph.** The design stands; what changes is where the two modules
of the account owner meet, where time enters, and the substrate's sizing. Funds verdicts
and every time-dependent figure of a batch are evaluated **inside the batch transaction at
its commit timestamp**, the projected state only ordering submissions (J-03; §2.1, §2.5). A
queued change is funded for the worst case of the changes ahead of it, the excess released
at its decision (J-01, D-1; §9.2). Every part records the key that added it, so key
spending follows the parts a key booked or added (POL-25 as amended in v1.8, P2-S117; J-02,
D-2; §9.1). Causes whose effective minute is known in advance (a move, a price change) are
recorded before that minute; POL-07 cuts arrive as per-link **target rates**, composed by
`min` (J-07, D-3, RFC-000 AI-17-3; §9.4). The registry gains F11 (one per account and price
version, with its E11 in the same entry) and F7's five variants; F5 and F6 arrive on the **invoice-status feed** and the **credit-limit command**,
gated on the ledger position they were computed from (J-04, J-05, J-13; §2.3, §7.3). The
owner pulls identity **catch-up** and confirms only within 45 s of identity freshness
(RFC-000 AI-R5-4; §5.6). A Share reduction leaves queued changes queued (J-15), a partner
confirm is sent only on the projected standing (J-12, D-6), and a marker read that meets a
lock defers one confirm, not the batch (J-14). Sizing moves to about 16,384 account slots
with the batching wait `W_a` in the latency budget (J-08, J-19; §14). The slot map is now
placement's (RFC-000 B-AI-10), and the link hold carries `wait`, kind, receipt minute and
policy version, the link deciding `wait = false` itself (AI-17-1).

**Revision 3 in one paragraph.** The design of revision 2 stands. Four rules of
`requirements-v1.7` are applied. Whether a displaced request **had begun committing** is
now judged exactly by whether its confirm transaction (E5) sees the reduction's
displacement marker (POL-07, P1-S78; B-RQ-9 decided): the revision-2 exception for a
request whose partner confirm was journaled before the marker is dropped, so such a
request is decided against the reduced capacity and its partner bookings are cancelled at
Share's cost if it ends (§5.1, §5.6, §12.2 C18 and C19; B-AI-9 asks RFC-000 to drop the same
exception). Checks at a link are in the order the `hold` commands **reach its schedule
owner** (POL-05, P1-S14, P1-S77; §5.1). Every account slot holds at least one probe
account (POL-06, X2-S27; §2.5, §14). A termination notice is withheld only by a flag in the
termination's own envelope, recorded in its E11 (POL-30, X1-S36; §9.4).

**Revision 2 in one paragraph.** The logic of revision 1 stands: one conditional deciding
entry per request in the account log, request-scoped holds with tombstones, the "releases
durable" gate, waiting and yields, partner adapters with journals and waiter queues. What
changes is what it runs on and four rules from `requirements-v1.6`. The account log is an
insert-only table in the database, appended by the NestJS instance holding the account
slot's **owner lease** in one batch transaction at a time, each conditional on the lease's
**epoch** and the partition's head row; an entry's timestamp is its **commit timestamp**,
and the confirm fence is checked against it (§2.5). Status replicas answer by RFC-000
§4.6's rule, now with RQ-13's "pending or the decided outcome, never contrary" (§8.2).
The v1.6 rules applied: checks of concurrent requests in arrival order (P2-S112); a
displaced request that **had begun committing** may complete and becomes affected
(P1-S63); change-request sameness (P2-S113); a decrease forbidden by a partner's shown
terms is rejected (P2-S115); the last-`ack_budget` unavailability exception (P2-S114);
`retry_after` as the latest remaining deadline (P2-S116). The entry kind E10 is retired
(§5.7) and the crash points are re-checked on the substrate (§12.2).

Terms are used in the sense of the [glossary](../02-specs/glossary.md); "reserved rate" is
capacity and "traffic" is bytes. Every latency, rate, size and count in this RFC is an
**estimate** (marked "est.") to be replaced by the R1 spike's measurements (RFC-000 R1),
unless it is a requirement's own figure or a policy default.

## Need

RFC-000 decided the shape: every booking request of an account is decided by that
account's **account owner**, a single-writer state machine over an insert-only log table
whose every commit is durable in two regions (RFC-000 §5.5); every Share link's capacity is decided by its **link schedule owner**; every partner
link is represented by a **partner adapter** that stands in for a schedule owner for
Share's own position there. RFC-000 left to this RFC the parts that make that shape
buildable (RFC-000 §7, "The RFC split"):

1. **The account owner's state machine**: the exact log entry kinds, which module of the
   account owner (booking, or funds and standing) owns each piece of state and each entry,
   the in-process interface between the two modules, and the state machine of a request
   and of a reservation.
2. **The booking workflow** that runs in the owner: intake and idempotency (P2-N6,
   POL-29), holds, waiting and yields (P2-N4, POL-02, POL-05), the decision entry (P2-N1,
   P2-N8, POL-04), the confirm fence and expiry (P2-N3, POL-26), releases and the
   "releases durable" record (RQ-6, RQ-8), withdrawal, revocation and suspension of
   undecided requests, and recovery from every crash point (P2-N5, POL-03).
3. **Reporting**: the edge's synchronous answer, the status replica rule, the outcome feed
   and webhooks (P2-N2, POL-04).
4. **Reservations and their changes** as one unit (P2-N9, POL-08), and the reservation-level
   side of revocations, equivalent-path offers and moves, release after grace and
   termination (P1-N8, POL-07, POL-16, POL-30).
5. **Partner adapters**: their log and call journal, the partner port, answer
   classification, fences, Share's waiter queue at each partner link, yields of Share's own
   partner holds, and reconciliation (P2-N7, POL-26, POL-28).
6. **The contention guarantee on every path** (POL-02): waiting, `wait = false`, short
   deadlines, crossings and cycles, and partner refusals caused by Share.

The hard parts, which every section below has to keep true at once:

- **One decision point per request** (POL-04, A7) that suspension, key revocation,
  withdrawal and the deadline are all judged against, while a partner leg, which cannot
  prepare in Share's sense, must be confirmed *before* that decision (P2-N7) and a
  confirmation must be decided before `D` (POL-26).
- **No hold ends except on the account owner's word** (A9), yet capacity is free by the
  deadline, or within `release_grace` when the decision record or a link's schedule owner
  is unavailable (POL-26), and no non-confirmed outcome is reported while a Share-link
  release it needs is not durable (RQ-6, RQ-8).
- **The process deciding can die at any point** (C12), on the Share side, at a link owner,
  at a partner adapter, or at the partner, without a route ever ending part-booked
  (P2-N1, P2-N5) and without a reported outcome ever changing (P2-S10, P2-S108).
- **Contention must not make every waiting competitor lose** across Share links and
  partner links alike, without a global component (POL-02, RFC-000 §2 "Merges and
  splits").
- **The design load is ×50** (POL-06): 25,000 booking requests/s, an account at
  `account_rate_limit` (200/s), status polls sized at 100,000/s.

## Approach

### 1. Scope, boundaries and notation

#### 1.1 What this RFC specifies, and what it relies on

| Specified here | Relied on (owner) |
|---|---|
| The account owner's log, entry kinds, apply rules, its tables and batch transactions on the substrate, takeover and recovery queries (§2, §12) | The substrate conventions (RFC-006, RFC-000 §5.5): the database at 2 + 2 + 1, owner leases and epochs, epoch-conditional batch transactions, commit timestamps, closed timestamps and changefeeds, the transactional outbox and Kafka topics, status readers, read leases and report positions, placement and region-wide failover, the **account slot map** (RFC-006 placement, RFC-000 B-AI-10), `ε` (the database's maximum clock offset, 100 ms) and the configured `δ_x` with the monitored quantities (AI-1); payload encryption, pseudonymous principals, the identity status push and catch-up, the operator check and read grants (RFC-005, A11) |
| The booking module: requests, reservations, change queues, the workflow (§3 … §9) | The funds-and-standing module: hold sizing, headroom, key headroom, capacity in flight, rate limits, standing transitions, resume amount (RFC-004 Part A), called through §2.4 |
| The status replica rule, the edge's answer gate, the request outcome feed, the reservation lifecycle feed, the booking API's semantics (§8, §13) | Authentication, principals, key scope, webhook signing (RFC-005); delivery of webhooks and notices (RFC-006 notifier) |
| The outcome and expiry port, the reservation command port, the partner port, the partner reconciliation feed (§13) | The link hold port, link waiting port, link availability query and link schedule feed (RFC-001) |
| Partner adapters (§10) | Partner terms and classification inputs in the catalogue (RFC-003; link registry RFC-001); equivalent paths from routing (out of scope) |

**Contracts govern the interfaces** (revision 6; RFC-000 revision 4.5). The frozen
contracts C01 … C12 give the wire form and the exact semantics of every interface in §13.
This RFC gives the logic of the owner and of the adapters behind them. Where the text below
and a frozen contract differ, the contract applies. The contracts that bind this RFC are:
C01 (runtime, `CommandEnvelope`, `RoutingRefusal`, report markers, hooks), C02 (link hold,
waiting, outcome and expiry ports, `cut_target`), C03 (link schedule feed), C04 (request
outcome feed, reservation lifecycle feed, `terminate`), C05 (the funds-and-standing
module, joint with RFC-004 Part A), C06 (usage-applied acknowledgement, catalogue), C07
(invoice-status feed, credit-limit command), C08 (identity push and catch-up, envelopes,
target summaries, read grants), C10 (booking API), C12 (partner port, driver interface,
reconciliation feed). C09 and C11 do not name this RFC.

#### 1.2 Which module owns what

The account owner is **one writer process per account** with two modules (RFC-000 §2). The
modules never write each other's state; both write only through log entries of the one
log, applied by the one owner in one serial order.

| State | Module | Notes |
|---|---|---|
| Booking requests: idempotency key, fingerprint, principal, kind (book or change), legs and their kinds, window, rate, product, `wait`, `D`, `request_age`, commit fence `D_c`, locked prices and partner terms shown, waiting marks, yielded legs, withdrawal, the deciding entry and its reason, the "releases durable" record | Booking (RFC-002) | §2.2, §4 |
| The idempotency index (account, key) → request, for `idempotency_retention` | Booking | §3.3 |
| Reservations as route-level units: legs, parts (each with rate, effective minutes, locked price, age, the request that added it and the **principal and key that added it**, J-02), the reservation's price steps (price changes recorded ahead of their effective minute), the POL-07 cut targets in force per (link, reduction), each as minute pieces with the parts it covers (§9.7), offer-scoped targets kept against their offer until the move (D5, §9.6), each part's current rate per leg as last sent, partner terms shown at booking (minimum term, cancellation fee, whether the leg's rate can be decreased, whether the booked window ends inside a minimum term and the fee then shown), lifecycle and end cause, partner-leg affected status, equivalent-path offers and move holds | Booking | §9 |
| Per-reservation change queue | Booking | §9.2 |
| The slot's identity-freshness watermark `iam_fresh` (RFC-004 JR-11, AI4-11; C05 S-2, C08 S-M6) | Booking, **owner memory**, per account slot, by the definition of §1.3 (applied and gap-free). An event-free closure marker writes no entry. After any acquisition it is **unset (stale)** until a catch-up or snapshot entry commits, or until every identity-push partition has reported | §1.3, §5.6 |
| Workflow progress per leg (held, waiting, refused, confirm sent, …), with the **attempt the link last reported** for each Share leg (§4.3; never numbered by the owner) | Booking, **owner memory only**; rebuilt on takeover by querying participants, whose own logs are durable (§12.1) | Not in the log, by design (Competition) |
| Funds holds and credit holds (per request and per reservation), capacity in flight per key and account, key spending per `key_spend_period` (over the parts each key booked or added), key status and KYB status as applied (F4; identity and access stays their writer; booking reads revocation from it, AI4-3), the identity-freshness inputs each F4 brings (resolved or read timestamps; the slot-level watermark `iam_fresh` is booking's, below), headroom inputs as applied feed positions (ledger position, rating position, the invoice-status events waiting for their ledger position), credit limit, open invoices, standing, its cause, grace start, resume amount, low-balance warning state | Funds and standing (RFC-004 Part A) | §2.3 |
| Booking-rate counters per key and account | Funds and standing (rule); kept in **owner memory**, rebuilt by a new owner from the last second's intakes; for one second after an owner change a key or account can be admitted up to twice its limit (RFC-000 §2, B-AI-4) | Not in the log: a submission over a limit "creates nothing" (D5) |

#### 1.3 Notation and parameters

| Symbol | Meaning | Value |
|---|---|---|
| owner | The NestJS instance holding the account slot's **owner lease**, which alone appends to the account's log ("leader" in revision 1); its **epoch** is the term of RFC-000 A2 | RFC-000 §5.2 |
| `ts` | An entry's **commit timestamp**: its batch transaction's commit timestamp in the database's hybrid-logical clock, read inside the transaction | RFC-000 §4.3 |
| `D` | The request's deadline: intake `ts` + the requested deadline (or `route_deadline_default`) | POL-26 |
| `request_age` | The intake entry's `ts`; ties broken by request identity (account partition, sequence) | POL-02 (`priority_rule = request_age`) |
| `D_c` | Commit fence, written in E1 and carried by every hold: `D − commit_margin` with a partner leg, `D − τ` without; the request may not begin committing after it ("`F`" in revision 1) | POL-26, RFC-000 §4.3 |
| `τ` | Confirm fence offset: a confirm entry is appended only if its `ts` is before `D − τ`; `τ = max(ack_budget, ε + δ_x_cfg)` | about 420 ms, cap about 450 ms; about 335 ms if deadline entries ride the second lane (est., RFC-000 §4.3 rev. 4.2) |
| `ε` | Clock bound: the database's configured maximum clock offset | 100 ms (RFC-000 coordinator decision) |
| `δ_x` | Time for the expiry's wait for its slot's lane (`W_a`), its commit, the release notice, the release's wait (`W_l`) and its commit at a link; configured at p99.9 as `δ_x_cfg` (AI-1, AI6-3) | about 105 ms steady, 300 ms worst degraded (p99); `δ_x_cfg` about 320 ms (est., RFC-000 §4.3 rev. 4.2) |
| `W_a` | Batching wait at the account slot's lane: the remainder of the batch in flight that an entry may wait for (RFC-000 §3 rev. 4.2) | 20 ms p99 steady, 65 to 70 ms after a region loss; 5 ms steady with the second lane (est.) |
| `iam_fresh` | The slot's **identity-freshness watermark**, kept by the booking module per account slot in owner memory (RFC-004 JR-11; C05 S-2, C08 S-M6 and S-G1): `iam_fresh = max(min over the identity-push partitions that feed the slot of R_applied(p), the read timestamp of the last catch-up or snapshot whose entry has committed)`. `R_applied(p)` is the latest resolved timestamp of partition p, from the closure markers on the identity push's closure topic (C01 `onResolved`), up to which every event of p is applied, with no gap below it. A marker does not advance `R_applied(p)` while an earlier event of p is not applied. A catch-up whose F4 has not committed does not advance it. An event-free marker writes no entry. After any acquisition `iam_fresh` is **unset (stale)** until a catch-up or snapshot entry commits, or until every partition has reported. The gate compares microseconds with the HLC as `t × 10³ ≤ wallNanos` | — |
| `iam_fresh_max` | A confirm commits only if its `ts` ≤ `iam_fresh` + `iam_fresh_max` (RFC-000 AI-R5-4) | 45 s |
| `σ_p` | Partner-skew budget of partner link p: `ε` plus the adapter's commit-to-send bound `h_s` plus the measured bound on the partner's clock offset; part of `commit_margin` | design parameter per partner, default 250 ms (est.) |
| `T_x` | Expiry time by the owner's clock: `D − ε − δ_x` | — |
| `release_grace` | Bound on releases and late-known confirmations when a record or a schedule owner is unavailable | 1 min (POL-26) |
| `nb(t)` | The **next minute boundary after** `t`: the least minute boundary strictly greater than `t` (so `nb(09:31:00.000)` = 09:32). Every "next boundary after `ts`" in this RFC, and the earliest `move_at` the link accepts for a decision at `ts`, is `nb(ts)` (JI-7) | — |
| `read_lease` | A status replica's read lease; it ends inside the granting owner's lease, and a new owner reports nothing until `read_lease` + `ε` after its acquisition (RFC-000 AI-R6-2) | about 400 ms (est., RFC-000 §4.6) |

Every entry's `ts` is its commit timestamp, so it is exact for the entry as committed and
replayed identically. Entries committed in one batch transaction share its `ts` and are
ordered by sequence. Timestamps are monotone within a partition across owner changes,
because each batch transaction reads its predecessor's head row (RFC-000 §4.3), and they
are within `ε` of true time. **Every figure that depends on time is computed at that `ts`,
inside the transaction** (J-03): the funds verdicts and outcomes (`admit`, `apply`), `D`,
`D_c`, `request_age`, the key spending period and fee-term ends they read, and every check
against `D − τ`, `D` (E8, §6.5), an F7 instant, `iam_fresh` + `iam_fresh_max`, and an E11's
effective minute. A transaction pushed to a later timestamp re-evaluates all of them and
retries (§2.5). The owner's own clock only schedules: when to propose an expiry, whether a
confirm is still worth proposing (A8), and the rate limits (§3.1).

### 2. The account owner's log

#### 2.1 Entries, apply and conditional effects

- **Envelope.** Every entry is a row of the account log table (§2.5) carrying (account
  partition, sequence), the owner's epoch, `ts`, its kind, the audit fields of RFC-005
  (pseudonymous principal; for an operator, role, reason and approver; A11), and an
  encrypted payload of one or more **records**, each owned by one module: booking records
  (`B:` below) and funds records (`F:`). An entry is applied by applying its records in the
  order written.
- **Effects are computed at the commit timestamp and logged** (revision 4, J-03; RFC-004 A
  §A10 "Time"). The owner composes each submission **provisionally** against its projected
  state (everything it has committed, plus the batch in flight), which fixes only the
  serial order and what is worth proposing. The figures are fixed inside the batch
  transaction: having read its commit timestamp `ts`, the transaction evaluates, entry by
  entry in sequence order, the intake rules, `admit`, `apply`, `D = ts + deadline`, `D_c`,
  the deciding checks and the endings a funds outcome requires (§2.5 step 3), and writes the
  results into the entries: verdicts, amounts, the requests a suspension ends. Each entry is
  evaluated on the state its predecessors in the batch leave, so the serial order is the
  composition order. A provisional verdict that differs at `ts` (an intake pushed across
  00:00 UTC into a new key spending period, across a fee-term end, or past a posting) is
  replaced: an E1 may become E1′ and the reverse; nothing was sent on the provisional one.
  Booking records are applied as written; the funds module's outcomes are re-computed from
  the recorded inputs and rules version by every replay of the log (a new owner's rebuild,
  a standby tailing it, history's rebuild) at the recorded `ts` and compared (RFC-004 A
  §A4), so a replay never differs from the commit. Every figure a buyer was shown can be
  rebuilt exactly (P4-N16, P4-S72, A0-21).
- **Deciding records are conditional.** A record that decides a request (*confirm*,
  *expire*, *end*, *withdraw*) is composed only if the request is undecided in the
  projected state. The database enforces it again: each deciding record also inserts the
  request's **decision row**, whose primary key is the request, so a second deciding record
  for one request cannot commit (RFC-000 §5.5). A batch that meets that key (only a bug can
  compose one) aborts as a whole; the owner reloads and recomposes it without the losing
  record. The first deciding record in log order is therefore the only one (A7).
- **One owner, projected state, one batch in flight per partition.** The owner keeps a
  projected copy of the state that includes the batch transaction in flight, so two
  concurrent submissions with one key, a yield request and a grant, or a suspension and a
  confirm are ordered the moment they are composed; the projection of an in-flight batch is
  replaced by its committed result when it commits. Nothing is sent to a participant, and no answer given, on the
  strength of an entry that has not committed (§2.2 states, per kind, what is sent after
  commit). If the batch fails or its result is ambiguous, the owner reloads its state from
  the log before deciding again (RFC-000 §5.2) and recomposes, against the reloaded state,
  every entry that did not commit; submissions waiting on the failed batch are processed
  again.

#### 2.2 Booking entry kinds

| # | Entry | Booking records | Funds records it also carries (computed by §2.4) | Deciding? | Sent to participants only after commit |
|---|---|---|---|---|---|
| E1 | **Intake** | Request record: id = (account partition, sequence), idempotency key, fingerprint (§3.1, §9.2), principal and key, kind (`book` or `change` with reservation id and change kind), legs (link, kind: Share, partner with holds, partner without holds), window, rate, product, `wait`, `D`, `request_age` (= `ts`), `D_c`, the receipt minute for window rules (POL-09) and the link-rules policy version, locked prices with the catalogue price version and position they were read at (J-17) and any announced price change shown, the partner terms shown (minimum term, cancellation fee, whether a decrease is allowed, each shown fee's kind (plain, or minimum-term with the term's end), and a due-at-window-end flag when the booked window ends inside a minimum term, with the fee then shown, POL-08 as amended in v1.8), and the `quote_id` the request cites, if any (§3.4; the locked terms then equal the quote's); for a key not yet applied by F4, the identity-signed key record as its exact signed bytes (`provisionalKey`, C05 S-1); for a change, the changes ahead of it in the queue (§9.2) | `admit`'s inputs and verdict, with `checked` (the headroom and key headroom the checks used, C05 m13): funds hold or credit hold for the request (for a queued change, sized for the worst case of the changes ahead, J-01); capacity in flight +rate on key and account | No, unless the request is refused at intake (E1′) | Holds (§5.1) |
| E1′ | **Intake, decided** | As E1 plus the outcome: *invalid* (with the rule, C10's reason code); *rejected* (insufficient funds with the two amounts; a limit with its name; account suspended with the resume amount itemised, POL-16; more than one partner without holds; a change to part of a route; a decrease over a partner leg whose shown terms do not allow one, stating that the reservation may be cancelled instead, B-RQ-8; `quote_required` or `terms_changed`, with the current terms and a fresh `quote_id` as `requote`, §3.4); or *failed* "withdrawn" for a **pre-emptive withdrawal** (`request_kind` `preemptive_withdrawal`: the key and the principal, no fingerprint, §7.1) | For a refusal by `admit`: its inputs, the refusal reason, the amounts and `checked`, so a replay recomputes it (J-13); otherwise none. Nothing held | Yes; "releases durable" is implied (no hold was sent) | Nothing; the outcome is reportable at once |
| E2 | **Waiting mark** | Request, and per waiting leg the deadline of the request ahead (from the waiting notice; the latest among several blockers), or "ahead resolved" | — | No | Waiting hints to every participant where the request holds (§5.2) |
| E3 | **Yield or displacement accepted** | Request, leg, the attempt the participant's yield request or `DISPLACED` carries (the attempt given up), the **claim** the yield request names (C02; the link sets it), the participant's yield request or displacement notice; the leg is marked yielded (it becomes a waiter at the request's age) | — | No | `yield_accept` or `displacement_accept` to that participant (§5.3, §5.2) |
| E4 | **Withdraw** | Request, principal; if undecided: outcome failed, "withdrawn" | Release of the funds hold; capacity in flight −rate | Yes, if undecided | Request-scoped releases; partner cancellations at Share's cost (§7.1) |
| E5 | **Confirm** | Request; for each leg the hold attempt confirmed or the partner booking reference; `ts` (appended only if its commit timestamp is before `D − τ`, with the `τ` used, and at most `iam_fresh_max` after `iam_fresh`, with the `iam_fresh` used, §2.5); the check results (standing, key, withdrawal); for `book`, the new reservation record; for a change, the new part with the principal and key that added it | Bind: the funds hold becomes the reservation's coverage hold (or grows it, for a change, releasing any excess of a worst-case hold, J-01); capacity in flight −rate | Yes, if undecided and in time | Conversions (§5.7); partner outcome notices |
| E6 | **Expire** | Request; reason: "deadline passed", "deadline passed while waiting" with `retry_after`, or "interrupted by an internal failure" (§6.2) | Release of the funds hold; capacity in flight −rate | Yes, if undecided | Request-scoped releases; partner releases or cancellations (§6) |
| E7 | **End** | Request; outcome and reason: rejected for no fit (blocking link, counter-offer, or, for `wait = false`, the link's `IN_FLIGHT` refusal with `retry_after` and the counter-offer); rejected by a partner's definite refusal (partner link); rejected, "link unavailable", naming the link, with **no counter-offer**, when a Share link answers `UNKNOWN_LINK`, `LINK_CLOSING` or `LINK_RETIRED` to the hold (a link being retired, POL-07, POL-10, C02 M-2, P2-S120); failed: partner fault (leg); failed: "reservation ended" (a change whose reservation ended); failed: "reservation changed by Share" (a change in progress whose legs a move removed, §9.4); and the suspension and key-revocation endings when carried by a funds entry (§7.2) | Release of the funds hold; capacity in flight −rate | Yes, if undecided | Request-scoped releases; partner cancellations at Share's cost |
| E8 | **Releases durable** | A batch of (request, the Share legs whose release acknowledgement is in hand); complete for a request when every Share leg of its intake is acknowledged. For an expired request it is committed only with a `ts` at or after `D` (§6.5) | — | No (it gates reporting, A10) | Nothing |
| E9 | **Takeover** | New epoch, holder identity; the first entry of each epoch in the partition (§2.5) | — | No | Resume queries (§12.1) |
| E10 | *Retired in revision 2* | Not used; the number is not reused. Conversions still pending are found by recovery query instead (§5.7, §2.5) | — | — | — |
| E11 | **Reservation change** | Reservation; cause (the change request, or a Share cause: a POL-07 cut target per (link, reduction) **and target revision** with its minute pieces and covered parts, or the note that it is not applied and why (§9.7), a move to an equivalent path with its catalogue route ID and shown price, made only once the move is final (§9.6), release after grace under POL-16, termination under POL-30 with its envelope and identity, a price change under POL-27 recorded at its announcement, or the **window end**, written by a timer in the first batch with `ts` at or after the window end, §9.1); effective minute, **never before `nb(ts)`** except a POL-07 cut at its `T_eff`, a revocation (a cut to 0, `r = 0`) included, with `ended(revoked)` in the same E11 when every part is 0 to the end, and the window-end E11, effective at the window end (C04 M-06, C05 S-5; §9.4, RFC-000 §4.5); the parts removed or added, and each changed part's rate per leg as minute pieces (§9.7); the new end, rate or price step; for an ending change, the changes it fails ("reservation ended"); each shown fee that becomes due, with its `fee_id` (`"<reservation>/<path>/<leg index>"`, C04 MM-2) and who pays it (§9.5); for a cause reached late, `delay_min` (alerted) | Hold resize or release (POL-15); a fee now due (RFC-004 A's fee-incurred state, J-09) | Decides its change request if it is one (§9); the E11 that decides or fails a change is a **reporting entry** for that change (C04 M-01) | Leg changes (`end_leg`, `reduce_parts`, each with change id, cause, decision time and, for cause POL-07, the (link, reduction) pairs applied; for a final move, `offer_accept(offer, move_at)` to the new path's Share legs and `end_leg` from `move_at` to the old ones) to every Share leg concerned, each in its leg's queue (§9.8); partner `change` or `cancel` with `changeSeq` = this E11's sequence (§9.3, §10); the reply to the `cut_target` (§9.7) |
| E12 | **Leg changes durable** | As E8, for an E11: every Share leg has answered its leg change (a reply in the "answered" group of §9.8, `STALE_CHANGE` included) | — | No (it gates reporting of changes that free capacity, §9.3; for such a change, E12 is its reporting entry, C04 M-01) | Nothing |
| E13 | **Offer** | Equivalent-path offer (§9.6): *prepared* (the path chosen, with an offer id, and the offer parts with their original ages), *made* (every offer hold acknowledged; `offer_window` end), *accepted* (the holder's answer and requested move minute; with a partner leg, the partner booking started), *final* (every new leg booked; written with the move's E11 in the same entry), *declined*, *lapsed*, *failed* (the partner booking at acceptance failed: as declined); an **offer-scoped cut target** received for its parts (D5, §9.7) | — | No | After *prepared*: `offer_hold` on every Share leg of the path, idempotent by offer; after *made*: the notice to the holder; after *accepted* with a partner leg: the partner booking through its adapter; after *final*: `offer_accept` and the old legs' `end_leg` (the E11's); after *declined*, *lapsed* or *failed*: `offer_release`; each with the decision time |
| E14 | **Partner leg affected** | Reservation, partner leg, partner link, from minute, `delivered` (`{rate, window}` the partner has, or `null` when it has none), the event identity; idempotent by (reservation, leg, partner link): a later event with less delivered capacity replaces the record, an equal one is a duplicate, one with more is ignored and alerted (C12 m12, D5) | — | No | Notice through the notifier (POL-07, POL-28) |
| E15 | **Operator command refused** (audit only) | The command's identity (`"<account>/<action_id>"`), the envelope's audit fields, the refusal (`REFUSED(check)`, `NOT_ACTIVE`, `REFUSED(not_after)`, or a recorded credit-limit refusal) and its `ts`; **no state change** (C04 D-5, C07 op 2) | — (for a credit limit, the funds module's F5 records the refusal instead, §7.3) | No | The recorded answer |
| E16 | **Residue recorded** | A partner booking that the adapter found later (a late answer, a query, or reconciliation) for a tombstoned request or a failed offer, and cancelled at Share's cost: request or (reservation, offer), partner link, booking reference, `found_by` (`late_answer` or `reconciliation`) (C04 m-11) | — | No | Nothing; the outbox carries the `pol28_residue` event |

There is no entry for a capacity hold acknowledgement, a grant to a waiter, or a partner
confirm being sent. Those facts are durable in the participant's own log, and a new owner
learns them by query (§12.1). The workflow's entries per request are therefore the two
RFC-000 §6 counts (intake, deciding entry), plus waiting marks when contended, a yield
acceptance only in a crossing or cycle, and an E8 for a request ended after its holds were
taken. Each is a row in a batch transaction; a single-link booking costs two transactions
at the account owner, each preceded by up to one batching wait `W_a`, as RFC-000 §3
revision 4.2 budgets.

#### 2.3 Funds-and-standing entry kinds (owned by RFC-004 Part A)

RFC-004 Part A defines these kinds, their payloads and apply rules (its §A4); this RFC
registers them in the account log's closed registry beside E1 … E16. Each is appended by
the owner from a feed event or a timer, and its recorded **outcomes** can require booking
records, which the booking module writes **in the same entry** (§2.4 rule 5).

| Kind (RFC-004 A) | What it applies | Booking records its outcomes can require |
|---|---|---|
| F1 Ledger applied | Ledger balance and posted-through minutes through a ledger position | A suspension: ending records for every undecided request **that adds** of the account (a booking, an extension, an increase: rejected, "account suspended", the resume amount itemised); undecided reductions continue (POL-08, P2-S69, P2-S77; J-13) |
| F2 Usage applied | Unposted usage through a rating position, applied only once F1 has reached its ledger position X (AI3-3) | As F1 |
| F3 Exposure parameters | Inputs of the lateness bound | As F1 |
| F4 Identity status | An actual key or identity status change (key revocation, key limits, KYB status) from the identity status push (Kafka), a **catch-up** answer or a **snapshot** answer (C08 §B, S-G1), applied within 60 s; deduplicated by (identity partition, sequence) plus key version (C05 M3, which replaces revision 5's `id_ts` skip rule); written only for such a change, never for a closure marker or an answer without events; an applied key absent from a snapshot is revoked as applied (C08 m8) (D6, AI4-2, AI4-3, AI-R5-4, AI4-11; RFC-004; C05, C08) | A revocation: ending records (failed, "key revoked") for the key's undecided requests; its reservations are untouched (P2-S72) |
| F5 Credit limit | Credit limit set or removed: from the **credit-limit command** (finance envelope, C07 op 2; also a recorded refusal of it, §7.3), or *credit limit removed* on the invoice-status feed, applied only once F1 has reached the ledger position the event carries (KYB status travels in F4; RFC-000 A-1). A `CreditLimitRemoved` is superseded by an F5 *set* committed after its `decided_at` (C07 R37-03). The F5 audit records the approver when there is one (POL-32, C07 v1.2) | As F1 |
| F6 Invoice status | Invoice **overdue**, **paid** or **written off**, from the invoice-status feed, each applied only once F1 has reached the ledger position it carries (RFC-000 A-1; J-05, J-06) | As F1 |
| F7 Funds tick | Five variants (RFC-004 JR-9): fee term ended; grace ended; enforcement check; **price effective** (a recorded price step reaching its minute: the hold re-priced, P4-S101); **exposure step**; each committed only with `ts` at or after its instant, deferred otherwise (J-10, J-13) | Grace ended with `release_due`: E11 records, **in the F7 entry itself**, ending every listed reservation, cause "released" (POL-16), buyer pays a shown fee (P4-S23; JR-2); price effective with a suspension: the endings of §7.2 |
| F8 Enforcement acknowledgement | Network operations' acknowledgement of a standing change | None |
| F9 Probe designation | The account is a probe account (POL-06), as **placement's account slot map** designates it, recording the designating slot-map version (C01 M11, C07 S1; the catalogue does not designate accounts, C06-M14) | None |
| F10 Rules version | The funds rules version in force from this position | None |
| F11 Price notice | A price change announced for the account's open-ended reservations on a route, `price_notice` ahead (POL-27): price version, route, new price, effective minute, catalogue reference; **one per (account, price version)**, idempotent by it (J-04, RFC-004 JR-4) | **In the same entry**, one E11 cause "price change" per (account, price version), listing every affected open-ended reservation and recording their price step (§9.4) |

#### 2.4 The in-process interface between booking and funds

RFC-004 Part A provides the funds-and-standing module as a library linked into the
account owner, with no I/O, no clock and no randomness (its §A10). The booking module calls
it only at the owner: provisionally while composing (to order and to decide what to
propose), and **decisively inside the batch transaction at its commit timestamp**, on the
state the entry's predecessors leave (§2.1, J-03); the entry records the module's inputs and
outcomes as evaluated at `ts`; every replay of the log re-runs the module on the
recorded inputs with the recorded rules version (F10) and compares (RFC-004 A §A4).
**C05 v1 is the authority for this interface** (its "The module interface", "Calls of the
module" and its clarifications C-1 … C-6): the names below are C05's (`rateCheck`,
`admit`, `apply`, `due`, `answer`, `standing`), and this RFC changes nothing in it
(revision 6 keeps the joint interface with RFC-004 as C05 v1 states it). The calls, and
where this RFC makes them:

| Call (RFC-004 A §A10) | Booking passes | Booking uses the result | Where |
|---|---|---|---|
| `rateCheck(soft, nowMs, who)` | The submitting key or user as `PrincipalCtx`, with `provisionalKey` (C08's `SignedKeyRecord` as its exact signed bytes) for a key not yet applied by F4 (C05 S-1); `nowMs` is the owner's clock (J-13) | `NotAccepted{retry_after}` → not accepted, nothing logged; `NotAccepted{revoked}` for a key revoked as applied by F4 → not accepted, as an unauthenticated submission (JR-1) | §3.1, before anything else; polls never reach it |
| `admit(S, ctx, ask)` | `Ask`: request id, principal and key (with `provisionalKey` as above), kind (`New`, `Increase`, `Extend`), the reservation's schedule after (and before, for a change) with its locked prices and price steps per Mbps-minute and each part's current rate as minute pieces (§9.1, §9.7), the shown partner fee terms, the rate in flight (once, whatever the number of legs); the change's interval (for an extension, `[old end, new end)`; for an increase, `[next boundary, end)` and the added Mbps) with its **adding key**; for a change with changes ahead in its queue, **`ahead`**: those changes in order (C05 `QueuedChange`), each with its kind, `newRate` (the reservation rate requested), `addedMbps` and `interval` from its own `Ask.change`, adding key, and for an Increase its `lockedPrice` and `priceVersion` (C05 C-3, S-6), from which the module sizes the hold for the worst case (§9.2; J-01, D-1; RFC-004 JR-5, JR-6) | `Admit{hold, hold_kind, mbps, checked}` → E1 with it as the funds payload; `Refuse{reason, checked}` → E1′ rejected with that reason and amounts (C05 m13). Called in the owner's serial order of intakes (arrival order), each call counting the holds and capacity in flight of every request then undecided, the earlier entries of the same batch included (POL-25, B-RQ-1, P2-S112); decisive only inside the batch transaction, with `ctx.ts` its commit timestamp (J-03) | §3.2, §9.3 |
| `standing(S)` | — | Must be active for a request that adds something to be confirmed; checked before a partner confirm is sent, **on the projected state** (D-6, J-12, §5.5), and in E5 at `ts` | §5.5, §5.6 |
| (none: the watermark is booking's) | — | `iam_fresh` per slot, in owner memory, by §1.3's definition (applied and gap-free, C05 S-2, C08 S-M6); unset after any acquisition until a catch-up or snapshot entry commits or every partition has reported; E5 commits only if `ts` ≤ `iam_fresh` + `iam_fresh_max`, never while it is unset (RFC-000 AI-R5-4, RFC-005 C3, RFC-004 JR-11) | §2.5, §5.6 |
| `apply(S, ctx, Intake{…})`, `apply(S, ctx, Decided{Confirmed{reservation, schedule} \| NotConfirmed})`, `apply(S, ctx, ReservationChanged{reservation, schedule, effectiveMinute, end?{cause, fee_due}, fee_due?})` (`effectiveMinute` required, C05 C-1; `fee_due` carries its payer, C04 m-09) (`fee_due?` for a shorten whose new end falls inside a partner's minimum term, POL-08 as amended in v1.8), `apply(S, ctx, PriceTookEffect{reservation, price version, effective minute})` (recorded at the announcement, effective minute in the future, §9.4) | The booking entry's own content, as an `Input`; every `schedule` lists the parts with the **principal and key that added each** (J-02) and each part's current rate as minute pieces after the POL-07 targets in force (§9.7; review 31 K-3) | The outcomes (hold changes, the release of a worst-case hold's excess at a change's decision, any standing transition) recorded in that entry | E1, E4 … E7, E11 |
| `apply(S, ctx, F1 … F11)` | — (the owner builds the funds entry from the feed, command or timer) | Outcomes `standing` (to suspended), `release_due`, and a key revoked as applied (F4) → booking records in the same entry (§2.3) | §7.2, §7.3, §9.4 |
| `due(S)` | — | Instants for the five F7 ticks (fee term end, grace end, enforcement check, price effective, exposure step); the owner arms them with the booking timers (§6.1) and commits each only with `ts` at or after its instant | §6.1 |
| `answer(S, ctx, principal)` | Account or key | The itemised headroom at a stated position; its insufficient-funds amounts are those `admit` returned; a resume amount itemised as written-off amount, each overdue invoice and the headroom still needed, and the headroom after it as an explanation, not as an item (POL-16 as amended in v1.11, P4-S114; C10's `resume`, RFC-004 A, D-5). The booking module passes the quote through unchanged | Rejection texts; status replicas serve the headroom query (RFC-004 A §A9; C05 "Headroom and balance query") |

What the booking module provides to the funds module, and nothing else: the `Ask` and
`Input` values above, built from the request and reservation records (rate, parts and
their schedule with the principal and key that added each part, locked prices and price
steps, the partner fee and minimum term shown at booking, whether the booked window ends
inside a minimum term, the end cause and who pays a shown fee under POL-08, §9.5), and the
queue ahead of a change.

Rules both modules keep:

1. **One entry, both effects.** An intake records the request and its funds hold in one
   entry, before any capacity hold is sent (POL-25, A0-03). A deciding entry records the
   outcome and the funds release or binding in one entry. A request is never decided with
   its funds not, or the reverse.
2. **No I/O in the funds module.** Its inputs arrive only as entries; the booking module
   never computes an amount.
3. **Order inside an entry.** For a booking entry, the booking record first, then the funds
   payload; for a funds entry, the funds payload first, then the booking records its
   outcomes require. Apply follows the written order.
4. **Determinism.** Only the owner calls `admit`, `rateCheck` and `standing` to decide;
   what they return is logged, as evaluated at the entry's `ts`. A rules change takes
   effect at an F10 boundary and never alters a logged figure (P4-N16).
5. **Who ends what.** Only the booking module ends a request or a reservation. A funds
   outcome that requires an ending (suspension, a key revoked as applied by F4,
   `release_due`) is turned into booking records in the **same entry**, so the funds event
   and the endings it causes have one log position: the decision point of each request it
   ends (POL-04). The entry is one row of one batch transaction, so it commits or does not;
   there is no state with the cause and not its endings.

**Alignment items with RFC-004 Part A, resolved in revision 2** as RFC-000 revision 4
directs:

| # | Item | Resolution |
|---|---|---|
| JR-1 | Key revocation as applied | RFC-000 rev. 4 (AI4-3): key status as applied is a funds kind (F4), identity and access stays its writer, and the booking module reads revocation from it. The interface stays as agreed: the read is through `rateCheck` (`NotAccepted{revoked}` at intake, §3.1) and through F4's `apply` outcome (the key's undecided requests, ended in the same entry, §7.2). If RFC-004 A prefers a plain read of `S` for the same fact, booking uses it at the same two points and nothing else changes |
| JR-2 | Release after grace | Kept: the release records are written in the F7 entry itself (rule 5); RFC-000 §8 names release after grace "internal to the account owner, rule from RFC-004". RFC-004 A reads "appends" so |
| JR-3 | Rate counts after an owner change | RFC-000 rev. 4 (B-AI-4) adopts owner-memory counters with the bound "up to twice the limit for one second after an owner change" (§1.2, §3.1) |
| JR-4 | Price changes (POL-27) for open-ended reservations | Revised in revision 4 (J-04, J-07, D-3; RFC-004 JR-4): on the catalogue's announcement the owner appends **one entry per (account, price version)**: F11 (the notice) with, in the same entry, **one** E11 cause "price change" listing every affected open-ended reservation of the account and recording their price step with its **future** effective minute, carrying `PriceTookEffect` per reservation. The step applies to every part from that minute, parts added after the announcement included (RQ3-5, §9.4); F7 *price effective* re-prices the hold at that minute. One row per account, not per reservation, keeps a product-wide change to about one entry per account (RFC-004 R4-A6) |

**Interface points RFC-004 Part A must match** (all inside the agreed calls and kinds;
revision 4 adds 8 … 15):

1. `admit` is called once per intake in the account log's serial order and counts the
   holds and capacity in flight of every request then undecided, the earlier entries of its
   batch included; it is decisive inside the batch transaction at `ts`; nothing is
   re-checked at the decision; a refusal caused by a hold later released stands (POL-25,
   P2-S70, P2-S112, P4-S66).
2. `rateCheck` returns `NotAccepted{revoked}` for a key revoked as applied by F4; F4's
   `apply` outcome names the revoked key, and booking writes the endings in the F4 entry.
3. F7's `release_due` outcome is answered by E11 records in the same F7 entry.
4. `ReservationChanged` carries `fee_due` for a shorten whose new end falls inside a
   partner's minimum term (P3-S63 rows 1 and 2), never for a shorten under a plain
   cancellation fee (P3-S63 row 3), as well as for an ending; booking names the payer
   (§9.5). A fee that becomes due is recorded once, so the fee part of the hold stops then
   (J-09).
5. `PriceTookEffect{reservation, price version, effective minute}`, one per affected
   reservation, is carried by the single price-change E11 of its (account, price version),
   written in the F11 entry at the announcement, with the effective minute at least
   `price_notice` later; it re-prices every part from the effective minute, parts added
   later included (RQ3-5); the hold's growth and any suspension happen at F7 *price
   effective* (RFC-004 A; RQ4-8, P4-S101, P4-S108). F11's outcome is the notice.
6. There are no followers on the substrate: RFC-004 A §A4's "followers re-compute and
   compare" is read as every replay of the log (a new owner's rebuild, a standby, history).
7. Every entry is committed in a batch transaction of one or more entries sharing one
   commit timestamp (§2.5); the module's apply must not assume distinct timestamps per
   entry, only distinct sequences.
8. **Queued changes** (J-01, D-1; RFC-004 JR-5, JR-6): for a change with changes ahead,
   `admit` sizes the hold from `ahead` for the worst case, and `apply(Decided{Confirmed})` at its E5 sets the hold from the
   reservation as actually left (`R(after) − R(before)` at that position) and releases the
   excess of `h_q` in the same entry; the failed-roll-forward path is kept only for posting
   drift between intake and decision.
9. **Key spending per part** (J-02, D-2, POL-25 as amended in v1.8, P2-S117): a key's
   spending counts the posted charges and the holds of the parts it booked or added, never
   another principal's; booking supplies the principal and key on every part.
10. **Time** (J-03): `ctx.ts` is the commit timestamp of the batch transaction; `admit` and
    `apply` are called inside it, in sequence order, and a pushed transaction re-evaluates.
11. **Registry** (J-04, J-13; RFC-004 JR-4, JR-9): F7 has five variants (fee term ended,
    grace ended, enforcement check, price effective, exposure step); F11 is registered, one
    per (account, price version), with its E11 in the same entry; F6 has three variants (overdue, paid, written
    off); F5 comes from the credit-limit command or the invoice-status feed.
12. **Position gate** (J-05, RFC-000 A-1): an F5 or F6 from the invoice-status feed is
    composed only once the applied ledger position has reached the position it carries,
    as F2 is gated on X; booking holds the event until then.
13. **F7 instants** (J-10): booking commits an F7 only with `ts` at or after its instant,
    deferring it otherwise, as for E8 ≥ `D`.
14. **Identity freshness** (AI-R5-4; RFC-004 JR-11, AI4-11; C05 S-2, C08 S-M6, S-G1):
    F4 applies push events, catch-up answers and snapshot answers alike, writing an F4
    only for an actual status change, deduplicated by (identity partition, sequence) plus
    key version; the slot-level watermark `iam_fresh` is booking's, in owner memory, by
    §1.3's applied, gap-free definition, and unset after any acquisition until a catch-up
    or snapshot entry commits or every partition has reported.
15. **E1′ funds payload** (J-13): a refusal by `admit` records its inputs, reason and
    amounts.

#### 2.5 The account log on the substrate

RFC-000 §5.5 maps the logical design onto CockroachDB, NestJS and Kafka. For the account
owner it is concrete as follows.

**Tables** (all in the account database, 2 + 2 + 1, leaseholders preferred in R1, plus one
non-voting replica per Kenyan facility for the status readers; RFC-000 §5.1):

| Table | Primary key | Written by | Content |
|---|---|---|---|
| `account_log` | (account, sequence) | Insert only | Every entry of §2.2 and §2.3: kind, epoch, `ts`, pseudonymous audit fields, encrypted payload (RFC-005, AI5-3) |
| `account_head` | (account) | Updated by each batch | Last sequence and last `ts`; the predecessor every batch reads (contiguous sequence, monotone `ts`) |
| `request` | (account, request) | Projection, in the same transaction | Undecided, decided, reported-gate state; partial indexes on *undecided*, *releases pending* (decided not confirmed without a complete E8), *conversions pending* (confirmed, `D` + `release_grace` not yet passed) and *leg changes pending* (E11 without E12) |
| `decision` | (account, request) | Insert only, by the deciding record | One row per decided request; the database backstop for A7 (§2.1) |
| `idempotency` | (account, idempotency key) | Projection | Request, fingerprint digest, principal, expiry; removed by row-level TTL after `idempotency_retention` (§3.3) |
| `reservation`, `change_queue` | (account, reservation [, position]) | Projection | Reservation records and their queues (§9) |
| `funds_*` | RFC-004 A | Projection, by the funds module | Funds and standing state (§2.3) |
| `outbox` | (account, sequence, feed) | Insert only, in the same transaction | Feed rows: request outcome feed, reservation lifecycle feed (offer events included; there is no separate notices feed, C04 MM-7), usage-applied acknowledgement, standing feed (§8.3, §13) |

Projection rows are derived from the log and rebuilt from it (A4); no role may update or
delete a log, decision or outbox row. **Every projection key starts with the account**
(`request`, `decision`, `idempotency`, `reservation`, `change_queue`, `funds_*`), never with
a slot, so a partition move writes no projection row (C01 R47-01). A partition is rebuilt
from its head row, its projections and its log since the last projection checkpoint, by
(partition, sequence), whatever slots wrote those rows (C01 §3.1).

**Batch transactions.** The owner commits **per account slot** (RFC-000 §3 rev. 4.2,
AI3-11, AI-17-5): one batch transaction in flight per slot's **lane**, carrying the pending
entries of every account partition of the slot; entries composed while one is in flight
form the next, so an entry waits at most the remainder of one commit (`W_a`, about 20 ms at
p99 steady at the occupancy target, est.). If the spike shows the account step's p99 above
50 ms at the design load, RFC-006 turns on a **second lane** per slot, carrying only
partitions not in the batch in flight (RFC-000 R19, R23); nothing below depends on which
lane carries a batch. There is therefore at most one transaction in flight per partition,
and each partition keeps its own contiguous sequence, per-stream sequences and head row
(keyed by partition, RFC-000 AI-R6-3). For E-ordering this means: an account's serial order
is still its own sequence, and nothing orders entries of two accounts against each other;
the entries of one batch, of every account in it, share one commit timestamp `ts`, so every
figure and check below is evaluated per entry at that `ts`; a busy account delays its
slot-mates by at most one commit of batching wait; and when one entry's check fails, only
that entry is dropped or deferred. Each transaction:

1. reads the slot's owner-lease epoch and, for each partition it appends to, its head row
   and generation, and aborts unless they are the owner's own;
2. reads its own commit timestamp, which fixes `ts` for every entry in it;
3. evaluates the entries in sequence order, each on the state its predecessors leave
   (§2.1, J-03): intake validation, `admit` and E1 or E1′, `D` and `D_c`; every `apply` and
   the endings a funds outcome requires; and the checks: each confirm against
   `ts < D − τ` and `ts ≤ iam_fresh + iam_fresh_max` (RFC-000 AI-R5-4), each completing E8
   of an expired request against `ts ≥ D`, each F7 against `ts` ≥ its instant (J-10), each
   E11 against its effective minute ≥ `nb(ts)` (except a POL-07
   cut at its `T_eff`, §9.4; a cause reached late takes the next boundary and records the
   delay, J-07), and, for each confirm, one point read per Share leg of the link's
   displacement marker (`link_displacement(link, request)`, RFC-001 §11.1; a read of the
   link owner's rows, never a write, RFC-000 A1, AI-R1-11). **Each marker read runs under a
   savepoint with a short lock timeout** (10 ms, est.): if it meets an intent of a link
   owner's in-flight reduction and times out, the transaction rolls back to the savepoint
   and defers only that confirm to the next batch (J-14). If a check fails, or a marker row is
   present for the leg **with any attempt** (§5.6; C02 "Link displacement read"; whatever
   the request's phase, POL-07 as amended in v1.7), that entry is dropped or deferred and the later entries of the batch
   are re-evaluated without it (a confirm dropped for the fence is followed by the expiry,
   §6; one dropped for a marker is handled as displaced, §5.1; one dropped for freshness
   waits for catch-up, §5.6);
4. inserts the entries, their projection rows and their outbox rows, and updates the head
   rows;
5. commits.

A transaction the database pushes to a later timestamp restarts and re-evaluates from (2)
(RFC-000 §4.3). Owner sessions run with an idle-in-transaction timeout below the owner-lease margin, and
the runtime abandons any batch not at `COMMIT` within that margin. **`COMMIT` is never
aborted blind** (C01 M1, RFC-000 revision 4.5): a 15 s backstop ends it as `Ambiguous`,
and the runtime resolves every `Ambiguous` batch by a present-time read of `owner_slot` and
the batch's head rows, by `batch_id`. **The owner decides nothing further in that slot
until the resolution is complete**; then it reloads as in §2.1 and recomposes what did not
commit. The in-transaction evaluation is in memory, about 0.1 ms per entry (est.).
Nothing is sent to a participant, and no edge answer given, before commit.
`ConditionFailed('lockTimeout')` on a displacement read defers only that confirm (C01
§3.2; below). **Report-position marker-only transactions do not take the lane**: they write only
the slot's marker row and read the epoch, beside a batch (§8.3, RFC-000 §3).

**Lease, slot and takeover.** Accounts map to account slots (about 16,384, est., RFC-000 §3
rev. 4.2, so each lane is about 0.11 occupied at the design load); a slot is the unit of the
owner lease, renewed per process, not per slot (RFC-000 §5.2). An owner stops composing,
granting read leases and sending commands at its lease's expiry less `ε` by its own clock,
and gives up its leases if its host clock leaves 50 ms of the database's (RFC-000 R4). A
successor takes the lease only after its expiry by the database's clock, revoking the
expired holder's session and incrementing the epoch (RFC-000 AI-R6-1), so its first read of
any partition in the slot sees every entry the old owner will ever commit; its takeover
reads run at high priority and push a pending batch of the deposed holder, whose commit
then fails (AI-17-4). **At once it asks identity for a snapshot** of the slot's
accounts (`catch_up` with no `since`, C08 S-G1, V56-7) and applies the answer as F4
entries for the accounts whose status changed (RFC-005 C3, AI-R5-4). The snapshot is not a
precondition for other work, but no E5 commits until `iam_fresh` is set (§1.3); a
running holder uses `since = iam_fresh`. Its
first entry in each partition it acts on is E9, written in that partition's first batch of
the new epoch; partitions found by the recovery queries below get it at once, others when
they next have an entry. E9's `ts` is the takeover time that §6.2's "interrupted" reason
compares with `D`. **A lapsed renewal or a re-home is an acquisition for reporting**
(RFC-000 AI-27-1): an owner whose session lapsed and is renewed without revocation, or
that re-homes its slots under a new session, resolves every in-flight batch of every slot
of the session (outcome known, or by batch identity as for an ambiguous commit), grants no
read lease and reports nothing below the renewal's (or re-home's) commit timestamp. A partition moved to another slot carries an incremented **generation**
in every row, header and command (RFC-000 AI-R6-3).

**Initial report position after any acquisition** (C01 §3.1, AI-33-2). After an expiry or a
handoff it is the timestamp of the new holder's present-time catch-up read; after a resume
or a re-home it is `T_res`. The owner grants no read lease with `P_grant` below it. After an
acquisition commit (not a resume) it writes no marker and reports nothing until
`read_lease` + `ε` after it learned of the commit (§8.2 uses this in the P2-S111 argument).

**Runtime hooks and results** (C01 §10.3, C4-7). The owner implements C01's hooks for the
account kind:

| Hook or result | What the owner does |
|---|---|
| `onAcquire(slot, reason)` | The takeover of §12.1: recovery queries, E9, re-sends, identity catch-up and snapshot, the reporting wait above |
| `onMovedOut(account)` | Cancels the partition's timers (`D`, `T_x`, `offer_window`, the window-end timers, `due(S)`, the position gates of §7.3) and stops deciding for it. A command for it then gets `MOVED(slot, generation)` |
| `onAdopt(account, g)` | Runs the recovery queries below for the partition, writes E9 in its first batch, re-arms its timers from state, re-sends its pending commands in each leg's order (§9.8), pulls identity catch-up if `iam_fresh` is stale, and reports nothing for the partition until `read_lease` + `ε` after `adopt` |
| `Stopped` (integrity stop of the partition) | Decides nothing for the partition; answers every submission, command and status read for it "temporarily unavailable" (C10 `503`, C01 `STOPPED`); keeps its timers; a request whose deadline passes meanwhile is handled by §6.4 once the stop ends |
| `Ambiguous` | As above: nothing decided in the slot until the present-time resolution completes |
| `ConditionFailed(which)` | That call wrote nothing; for `'lockTimeout'` the confirm goes to the next batch; otherwise the owner reloads (§2.1) |
| `Retry` | The batch is composed again, with the same identities |

**The account slot map and probe accounts** (POL-06 and X2-S27 as amended in v1.8; RFC-000
B-AI-10). The account → slot mapping, overrides included (an account at the limit given a
slot of its own, RB-4), is **placement's account slot map** (RFC-006 §7.1, §12.7):
`slotOf(account) → { slot, mapVersion, headDecides }` from the placement feed's cache (a
point query on a miss; C01 §3.8). The owner, the edge and the probes route only through the
runtime's `route`, which reads it; none keeps a mapping of its own. With `headDecides`
true (the account is in the upper half of a splitting slot `s`), the sender sends to `s`
and then follows the last `MOVED` it got for that account, or retries on `MOVING`. Every
command routed to the owner carries C01's `CommandEnvelope` (routed slot, generation,
epoch, map version, sender sequence), and the owner answers with C01's `RoutingRefusal`:
`STALE_EPOCH` for a stale epoch, `NOT_OWNER`, `MOVED(slot, generation)` for an account its
current map version places in another slot (and adopted there), `MOVING` (retry, about
100 ms, est.) between a partition's `moved` and its `adopt`, `STOPPED` for a stopped
partition, `OVERLOADED` or `UNAVAILABLE`. Each refreshes the sender's cache or makes it
back off, and the sender re-sends with the **same identity**, so a command applied before
the move is answered with its result (§3.1). The owner itself routes to link owners and
adapters the same way. `STALE_SENDER(recorded)` from a receiver (C01 D4): a recorded
generation equal to the owner's own with a higher epoch means the owner is deposed for that
slot (as `STALE_EPOCH`); a higher recorded generation means the partition has moved and the
new writer has superseded the command, so the owner **drops the command and keeps the
slot**, and alerts `STALE_SENDER_UNMOVED` only if it has not applied `moved` for that
partition; any other case is a defect, alerted, and the command is dropped.

**Splitting slots** (C01 §3.8, R47-02, R47-05, V59-2). While slot `s` is splitting into `s`
and `s + n`, both owners **defer to the head row**: `s` answers `MOVED(s + n)` for an
account whose head names `s + n` and is adopted, and `MOVING` while it is not; `s + n`
serves an account whose head names it and is adopted, answers `MOVING` for one whose head
names it unadopted, and answers `MOVED(s)` otherwise. **A new upper-half account is created
only in `s + n`**, with an implicit `rowAbsent(head)` condition; `s` answers a creation
with no head row `MOVED(s + n)`. Once no batch of `s` started before it applied the
splitting version is in flight or unresolved, the owner of `s` calls `ackSplitting(v,
upperHalf)` with its upper-half accounts; after a takeover of `s` it answers placement's
`listPartitions` only after it has applied v and resolved its in-flight batches.
A **re-slotting** is a partition move (RFC-006 §4.5): the old slot's owner appends
`moved(to slot, g + 1)` and answers `Moved` from then on; the new slot's owner appends
`adopt(g + 1)` only after the old slot's report position has passed `moved`, continues the
partition's sequences, runs the recovery queries below for that partition, and reports
nothing for it until `read_lease` + `ε` after `adopt` (RFC-000 AI-27-2, §8.2). Placement
provisions **one probe account per account slot** and refuses a re-slotting that would
leave a slot without one; each slot is probed at least 3 times a minute from at least two
locations (X2-S27). A probe account is an ordinary account to the booking workflow (same
intake, holds, decision and reporting paths, F9 designation for the funds module), so a
probe that succeeds shows that its slot's owner, lanes, log partitions and status readers
served it. **The designation comes only from placement's slot map** (C01 M11, C06-M14,
CC-1): F9 applies it with the designating slot-map version; the catalogue does not
designate accounts, and the lifecycle feed's `account_is_probe` is a copy of the applied
designation (§13.1). At about 16,384 slots that is about 820 probe bookings a second per serving
region, about 1,640 in all (est.), each with its status read, on the designated probe links;
§14 counts them.

**Recovery queries** (on taking a slot; one indexed query per kind over the slot's
partitions, then §12.1 per request):

| Query | Over | Finds |
|---|---|---|
| Undecided requests | `request`, partial index *undecided* | Requests to resume or expire (§12.1 step 5) |
| Releases pending | partial index *releases pending* | Ending entries without a complete E8: re-send request-scoped releases (step 3) |
| Conversions pending | partial index *conversions pending* | Confirmed requests whose `D` + `release_grace` has not passed: re-send `convert` (step 4) |
| Leg changes pending | partial index *leg changes pending* | E11 without E12: re-send leg changes (step 4) |
| Open offers | `reservation`, offers prepared or made and not answered | Re-send offer holds; re-arm `offer_window` (step 4) |
| Timers | `request.D`, `funds_*` via `due(S)`, open offers, accepted moves | Re-arm the timer wheel (§6.1) |
| Held invoice-status events | `funds_*`: events received but not yet applied, waiting for their ledger position | Re-arm the position gate (§7.3) |
| Identity freshness | — | Ask for the snapshot at once (C08 S-G1: a new holder calls `catch_up` with no `since`); the snapshot is not a precondition, but no E5 commits until `iam_fresh` is set (§1.3) |

The owner then loads its in-memory state for the slot (the projection rows, which equal a
replay of the log) and starts deciding; it starts **reporting** only `read_lease` + `ε`
(about 500 ms) after its acquisition commit, so every read lease its predecessor granted has
ended (RFC-000 AI-R6-2, §8).

**Feeds.** Outbound feeds are outbox rows committed with their facts: the owner publishes
them to Kafka after commit, and a changefeed relays the same rows as the guaranteed path;
each feed stream has its own contiguous per-partition sequence, kept in the head row, and
consumers drop the duplicates by the event identity (partition, stream, `stream_seq`) with
the writer's (generation, epoch) (C01 M5, C06-M10; RFC-000 §4.4, AI-17-2). Report markers
are written only by the runtime, with the `slot` header (C01 M6). Inbound feeds (ledger positions, unposted usage,
identity status, invoice status, enforcement acknowledgements, catalogue prices and price
announcements) are consumed from Kafka and applied as F1 … F11 entries (catalogue prices
also feed the owner's price cache, §3.2); the feed position each applies is recorded in the
entry, so a new owner resumes each consumer from its last applied position and a
redelivered event is a no-op. **Events, notifications and commands** (RFC-006 §5.5, §12.2, §12.5). The owner publishes
only through the runtime's `append(partition, entries, projections, events,
notifications)`: **events** are feed rows by stream (request outcome, reservation
lifecycle, usage-applied, standing), given their `stream_seq` by the runtime and published
after `Committed`. **`yield_accept`, `displacement_accept`, the answer to
`expire_if_undecided` and the reply to `cut_target` are synchronous gRPC commands or
replies, sent only after `Committed`; they are not outbox notifications** (C02 erratum
(b)). `expire_if_undecided` and `offer_outcome_if_lapsed` arrive as gRPC commands (C02).
Notifications it receives (`WAITING_NOTICE`, `GRANTED`, `YIELD_REQUEST`, `DISPLACED`,
`WAITER_REFUSED`) arrive through `onNotification`, deduplicated by identity with no order and **no high-water rule**: one
whose identity is new is applied however late. Where the effect is an entry (E2, E3, E7)
the identity is recorded in that entry; where the effect is owner memory only (a leg held
or granted at an attempt) it is idempotent by construction, and a new owner re-learns it by
`query` (§12.1). **Commands** (`hold`, `convert`, `release`, leg changes, offer commands,
partner commands, `mark_waiting`) are gRPC calls sent after the entry that decides them
commits, each carrying the sending partition's (generation, epoch) from the runtime's
`epoch()` and `generation(partition)`, and the routing slot, generation, epoch and map
version of the receiver; a receiver refuses one below the highest (generation, epoch) it
has recorded for the partition (RFC-000 §5.2, AI-R6-3). Commands the owner receives are
checked with `admitCommand` likewise. Any closure marker on the owner's feeds is C01's
**closure emitter**'s, on a closure topic that only the emitter writes, with data
high-water offsets (C01 R47-06; RFC-000 AI-27-3); the owner emits none of its own. The
owner reads the closure markers of the identity push and of the catalogue through
`onResolved` on their closure topics: they advance `iam_fresh` (§1.3) and the price
cache's freshness (§3.2) (C01 M7).

### 3. Intake and idempotency (POL-29, POL-25)

#### 3.1 From the edge to the owner

1. The edge authenticates, applies its advisory counters and forwards the submission once,
   by gRPC, to the account owner (the holder of its slot's owner lease, routed through placement's slot map with
   `headDecides` and C01's `CommandEnvelope`; `STALE_EPOCH`, `MOVED` or `MOVING` re-routes
   it with the same identity, §2.5, RFC-000 §5.2; `STOPPED` and an exhausted re-route give
   the buyer `503 temporarily_unavailable`, C10 M9). A body that cannot be parsed as a
   request, or that has no idempotency key, is not accepted at the edge (`400
   NotAccepted{malformed}`, nothing recorded; C10 M7). Status polls go to status replicas
   (§8.2), never to the owner.
2. The owner refuses a submission whose principal context names a tenant other than the
   partition's account, or a key that is neither in its applied key list (F4) nor carried by
   an identity-signed key record naming the account. A key record is used **only while the
   key is absent from applied state**; its limits then govern that request provisionally,
   and E1 or E1′ records it as its exact signed bytes. A record whose `status` is `revoked`,
   or whose tenant is not the account, is refused as unauthenticated (RFC-005 §4.3, C1, C3;
   C05 S-1, C08). It then calls `rateCheck` with its own clock as
   `now`. A key revoked as applied in the log (F4) gives
   `NotAccepted{revoked}`: not accepted, as an unauthenticated submission (X1-S06; the edge
   refuses it too within 31 s; JR-1). Over `key_rate_limit` or `account_rate_limit` (a
   sliding second), the submission is **not accepted** with `retry_after`; nothing is
   logged, the key is not consumed (P2-S41). Retries count, polls do not (P2-S68). The
   counts are owner memory; a new owner rebuilds the last second from its intake entries,
   so for one second after an owner change a key or account can be admitted up to twice its
   limit (the retries its predecessor answered from state are not in the log; RFC-000 §2,
   B-AI-4).
3. The owner looks the key up in the idempotency index of its **projected** state, in the
   **booking-and-change family** (C10 D2; quotes, offer answers and documented requests have
   their own namespaces, §3.3). This lookup comes before every check that can create a
   request:
   - **New key**: go to 4.
   - **Same principal, same fingerprint** (for a booking: route legs in order, window,
     rate, product, `wait`; for a change: reservation, kind of change, new end or new rate,
     `wait`, §9.2; the deadline and the cited `quote_id` are not part of either, P2-S63,
     P2-S113, POL-29): the submission is that request; the answer is its current status
     under the reporting rules of §8.1 (pending, or its reported outcome) (P2-S24, P2-S25,
     P2-S27). No entry.
   - **Same principal, a pre-emptive withdrawal recorded under the key** (§7.1): the
     submission is answered with that record, failed "withdrawn", whatever its body, and
     creates nothing (POL-29, P2-S122). No entry.
   - **Same principal, different fingerprint**, or **a different principal of the
     account**: not accepted, as a key reuse; the answer contains nothing of the first
     request (P2-S26, P2-S64, P2-S113). No entry.
4. Validation (§3.2), then `admit`, provisionally, then the owner composes the intake into
   the next batch, whose transaction fixes it as E1 or E1′ at its commit timestamp (§2.1,
   §2.5 step 3; J-03). Intakes are composed one at a time in the order the owner receives
   them, which is the account's **arrival order** for POL-25, and the transaction evaluates
   them in that order: each `admit` counts the holds of every request then undecided,
   including those committed by the batch before and those earlier in its own batch, and
   nothing is re-checked later, so a request refused because of a concurrent request's hold
   stays refused even if that request then fails (P2-S70, P2-S112; B-RQ-1). The key is in
   the projected index from composition on, so a second identical submission arriving
   before the commit joins the same request (P2-S24).
5. The answer is sent by the rule of §8.1: final if reported in time, otherwise `pending`
   once E1 has committed. If E1 cannot commit in time (its batch fails, or the owner is
   losing its lease), no answer is given within `ack_budget`; that is unavailability, counted against
   the 99.99% target, and the client retries with the same key. `pending` is never sent for
   an intake that is not durable (A3).

#### 3.2 Validation and refusals at intake

Checks, in C10's order (AI-40-3, R40-12), all made by the owner before proposing; each
failure is an E1′ with the outcome named and C10's reason code (so a retry with the key
returns the same outcome even after the selling horizon has rolled). The terms check and
`admit` are evaluated again by the batch transaction at its `ts` (J-03): a batch pushed to
a later timestamp can turn an intake into `terms_changed`, or the reverse.

| Check | Outcome | Scenarios |
|---|---|---|
| 1. Route and product: every `link_id` known, the legs form a catalogue route, no duplicate or empty leg, no probe link named by a non-probe principal (nothing about probe designation revealed); the product sold on the route. A probe key that names a non-probe link or reservation is refused and recorded here, at the owner (C10 R40-25) | invalid, `unknown_route` or `product_not_on_route` (C10 D6) | P2-S01, X2-S27 |
| 2. Window and rate validity, per leg, by the link registry's rules (P1-S19, P1-S20; POL-09, POL-31), "now" being the minute boundary at or before the request's receipt by the owner, recorded in E1 (POL-09, P1-S74); extension beyond the horizon | invalid | P1-S19, P2-S84 |
| 2 (cont.). Deadline within `route_deadline_min` … `route_deadline_max`, plus `commit_margin` with a partner leg; with a partner leg, also `D − commit_margin − σ_p` after the intake's `ts`, so that a confirm can be sent (C12 F11 as amended by V7; every listed partner has `σ_p ≤ σ_p_max`, so an 11 s deadline is never rejected) | invalid, `invalid_deadline` | P2-S12, P2-S86 |
| 3. Rules: at most one partner leg without holds, using the adapters' POL-26 classification cached by `termsVersion` (§10.2; refused as unavailable only if no version is cached, C12 m5) | rejected, "a route may include at most one leg without holds" | P2-S34, P2-S36, P2-S102 |
| 3 (cont.). A change to part of a route | rejected, "a route is changed or cancelled as one unit" | P2-S49 |
| 3 (cont.). A decrease over a partner leg whose terms shown at booking (recorded in the reservation) do not allow one. **A shorten is never rejected for partner reasons** (POL-08 "any time"; C12 S1, D1) | rejected, stating that the partner's terms shown at booking do not allow it and that the reservation may be cancelled instead; the reservation is unchanged (POL-08, B-RQ-8) | P2-S115 |
| 4. **Terms shown** (POL-08 as amended in v1.11; C10 M2, D1): for a booking, an extension or an increase, the owner reads the terms it will lock. If they include any partner-leg fee and the request cites no quote; or if the cited quote is not for this request, is past `valid_until`, does not verify, or its shown terms are not equal to the terms to lock (§3.4) | rejected, `quote_required` or `terms_changed`, stating the current terms with a fresh `quote_id` (`requote`); nothing held. A cancel, a shorten and a decrease need no quote | P2-S121, P2-S50 |
| 5. `admit` (standing for a request that adds, key and account in-flight limits, funds or credit hold, key headroom, in RFC-004 A §A5.1's order), in arrival order | rejected with the reason and amounts the module returns | P2-S38 … P2-S40, P2-S42, P2-S54, P2-S66, P2-S70, P2-S92, P2-S98, P2-S112 |

Every rejection at intake for a rule (more than one leg without holds, a change to part of
a route, a decrease the partner's terms forbid) is *rejected* in the glossary's sense, and
states the rule (B-RQ-3).

The price per Mbps-minute for the route and every partner leg's shown terms are read from
the catalogue's cache at the owner before `admit` and locked in E1 (POL-27, POL-08); the
same figures are those shown to the buyer, with whether each partner leg's rate can be
decreased (P2-S50), whether the booked window ends inside a partner leg's minimum term and
the fee then due (shown on the offer before booking, POL-08 as amended in v1.8, P3-S74),
and, for an open-ended booking, any price change already announced for the route with its
effective minute, which the reservation then carries as a price step (§9.4). For an API
client, "shown before booking" means present in a quote that the request cites (POL-08;
§3.4). Share never charges a fee that was not in a quote the request cited; a request
whose locked terms carry no partner-leg fee needs no quote, and a cited quote is still
checked.

A link that is **being retired** is not checked here: the owner has no link-registry
input for it. The link's answer to the hold decides it (§5.1, C02 M-2), at once and before
any confirm, so P2-S120's request is rejected "link unavailable" with nothing held.

**Price freshness** (J-17). E1 records the catalogue price version and the cache's
position. The catalogue publishes each price version at least one minute before its
effective minute (B-AI-11), and the cache follows the catalogue feed's resolved timestamp;
the transaction composes an intake only if that resolved timestamp is within 60 s of its
`ts`, so the cache holds every version in force at `ts`. Otherwise the submission is not
accepted (no entry; the client retries with the key) and the owner alerts: unavailability,
counted against the 99.99% target, rather than a stale locked price.

#### 3.3 The idempotency index

- Keyed by (account, idempotency key) in the **booking-and-change family**; value: request
  id (or the pre-emptive withdrawal, §7.1), fingerprint digest (of a booking's or a
  change's sameness fields, POL-29; none for a pre-emptive withdrawal), principal, and
  expiry = intake `ts` + `idempotency_retention` (24 h). Quotes, offer answers and
  documented requests use their own families and never meet these keys (C10 D2; offer
  answers in §9.6; documented requests are RFC-005's). It is the `idempotency` projection table (§2.5), written
  in the intake's batch transaction; the owner keeps the keys of the last
  `idempotency_retention` in memory with a filter, backed by the table; status readers read
  it by follower read.
- Rows are removed by row-level TTL only after their expiry; a key then identifies a new
  request (P2-S65). Scoping by account is structural: the key's primary key starts with the
  account, so two accounts using one key never meet (X1-S08, X1-S09).
- A request's record (outcome, reason, counter-offer) is kept in the `request` table for
  status reads as long as its key, then removed by the same TTL; the log rows themselves are
  sealed into history's segments and truncated from the database only after sealing (RFC-000
  §5.5).

#### 3.4 Quotes (POL-08, P2-S121; C10 M2, D1, D3)

A **quote** is not a booking request. It writes nothing to the account log, holds no
capacity and no funds, and does not count toward capacity in flight or headroom. It is
outside `ack_budget`. It counts as a submission toward `key_rate_limit` and
`account_rate_limit` (C10 AI-40-2).

- **Operation.** `quote(candidate)` for a candidate booking or change. The owner makes C10's
  checks 1 and 2 (route, product, validity; a failure answers `422`, nothing recorded) and
  reads, from the same catalogue cache and under the same freshness rule as intake (§3.2),
  the terms it would lock now: the price per Mbps-minute and the price version, any
  announced price change for an open-ended candidate, and for every partner leg whether a
  decrease and a shorten are allowed, whether it holds, and every fee with its kind,
  amount, term end and `due_at_window_end`. For a change candidate it also gives the
  effective minute and the fees the change would make due, with the payer. It gives no fit,
  funds or limit verdict.
- **The token.** `quote_id` is a MAC under a **per-account-slot quote key**, over (account,
  candidate digest, the shown terms themselves, `valid_until`, key version). It carries
  the shown terms, so `book` and `change` verify it and compare the terms without any state.
  `valid_until` is the quote's time plus `quote_validity` (5 min, est.; a design parameter),
  and never later than the next price version's or partner-terms version's effective
  minute that the cache knows. A partner-terms version takes effect at its
  `effectiveFrom`, at least 1 min after it is recorded, as a price version does (B-RQ-12,
  B-AI-15), so the cache, fresh within 60 s, always holds the terms in force at `ts`.
- **Check at intake** (§3.2 check 4, evaluated at the batch's `ts`). The request is
  rejected `terms_changed`, with `requote`, if the quoted candidate is not this request
  (for a booking: the same legs, product, window and rate; for a change: the same
  reservation, kind and new end or new rate), if `ts` is past `valid_until`, if the shown
  terms are not equal to the terms to lock (the same set of partner legs and, on each, the
  same `decrease_allowed`, `shorten_allowed`, `holds` and fees; the same price, price
  version and announced price change), or if a token naming the caller's account does not
  verify under the slot's current or retained key versions (it is then treated as past
  `valid_until`). A token naming another account, or not parseable, gets `404` and nothing
  is recorded (C10). Since `quote_id` is not a fingerprint field, the buyer resubmits
  under a **new key**.
- **Idempotency of quotes.** Quotes have their own key namespace (C10 D2). A repeat of a
  quote key while the owner holds the first answer in memory returns it; otherwise the
  owner issues an equal quote again.
- **Custody and rotation of the quote key** (C10 AI-40-3). The owner of a slot gets the
  slot's quote key versions from RFC-005's key release, as for its column keys; every
  owner-lease holder of the slot has them, and the edge never has them. A new version is
  made every 24 h (est.); a version is retired no earlier than the latest `valid_until`
  issued under it, so a takeover or a re-home keeps every quote valid. A re-slotted account
  gets the new slot's keys; a quote issued before the move does not verify and is answered
  `terms_changed` with `requote`, which shows only the caller's own current terms.
- **Sizing** (est.; §14). One in-memory cache read and one MAC per quote, about 0.05 ms of
  owner CPU, no lane write; p99 under 50 ms within the region. At the worst case of one
  quote per booking and change (about 30,000/s) that is about 1.5 CPU cores system-wide.

### 4. The request state machine

#### 4.1 Durable states

A request's durable state is a function of its entries. "Reported" is not an entry: it is
the moment the entries that make the outcome final are at or below the report position
(§8).

| State | Entered by | Left by | Holds and funds |
|---|---|---|---|
| **Undecided** (sub-flags: waiting, legs yielded) | E1 | E5, E6, E7, E4 or a funds entry's ending record | Funds hold from E1; capacity holds as acknowledged by participants |
| **Decided invalid / rejected at intake** | E1′ | — (final) | None ever taken |
| **Confirmed** | E5 (`ts < D − τ`, request undecided) | — (final; the reservation then has its own lifecycle, §9.1) | Funds hold bound to the reservation; holds converted |
| **Decided not confirmed, releases pending** | E4, E6, E7, or an ending record (suspension, revocation) | E8 completing it | Funds released in the deciding entry; capacity holds being released |
| **Decided not confirmed, releases durable** | E8 (or the deciding entry itself, when every acknowledgement was already in hand: a refusal that recorded a tombstone, or nothing sent) | — (final) | Nothing on any Share leg |

```mermaid
stateDiagram-v2
    [*] --> Undecided: E1 intake (+ funds hold)
    [*] --> DecidedAtIntake: E1' invalid or rejected
    Undecided --> Undecided: E2 waiting mark / E3 yield accepted
    Undecided --> Confirmed: E5 confirm (ts < D - tau, checks pass)
    Undecided --> ReleasesPending: E4 withdraw / E6 expire / E7 end / suspension or revocation record
    ReleasesPending --> ReleasesDurable: E8 every Share leg acknowledged
    Undecided --> ReleasesDurable: ending entry with every acknowledgement in hand
    Confirmed --> [*]: reported at the report position
    ReleasesDurable --> [*]: reported at the report position
    DecidedAtIntake --> [*]: reported at the report position
```

#### 4.2 Workflow phases in the owner

The owner drives each undecided request through phases kept in memory, derived from the
durable state and the participants' answers:

| Phase | Meaning | Allowed next | Yields? |
|---|---|---|---|
| **Holding** | Hold commands sent; some answers outstanding | Waiting, Ready, ending | No yield requests arrive for legs not yet held |
| **Waiting** | At least one leg is a registered waiter (Share link) or a contention waiter (partner adapter); none refused definitively | Holding (grant), Ready, ending | Yes: a yield request for any held leg is accepted (E3) |
| **Ready** | Every Share leg and every partner-with-holds leg is held; funds held | Committing (partner route) or Deciding (no partner leg); ending | No: refused |
| **Committing** | The first partner confirm or final booking has been sent (journaled by the adapter, §10.4) | Deciding (all partners confirmed), Waiting (a Share leg displaced that still fits on committed capacity, §5.1; partner bookings kept, and when the leg is granted again before its `D_c` the request goes straight to Deciding), ending (any partner refusal, unknown past `D − τ`, a displaced leg that no longer fits, or a Share-side event) | No |
| **Deciding** | E5 composed (its batch transaction in flight) | Confirmed, or, if the batch fails or the fence check drops the confirm, back to Ready or to the expiry | No |

A request is "waiting" for POL-02 exactly in the Waiting phase. Ready, Committing and
Deciding are "not waiting": such a holder is never pre-empted.

#### 4.3 Per-leg progress

**Attempts are the link's** (RFC-001 §4.3; RFC-000 AI-26-1; review 26 JI-1, JI-2). An
attempt numbers a request's current claim on one link. The link sets it to 1 at the first
hold or waiter registration and changes it **only** when the claim is given up while the
request goes on: an accepted yield or an accepted displacement registers the request as a
waiter at the next attempt. **A grant keeps the waiter's attempt.** The account owner never
numbers an attempt: it records, per Share leg, the attempt carried by the last of `HELD`,
`WAITING`, `GRANTED`, `DISPLACED`, `WAITER_REFUSED`, the acknowledgement of `yield_accept` or
`displacement_accept` (which names the new waiter attempt) and `query`'s answer, and it
sends that attempt back on `convert`, `yield_accept`, `yield_refuse` and
`displacement_accept`. A message for an attempt lower than the one recorded is stale and
changes nothing; one for the recorded attempt or a higher one is applied (no high-water
rule across kinds, §2.5).

| Share leg state (attempt as recorded) | From the link | Next |
|---|---|---|
| requested (no attempt yet) | — | held (a), waiting (a), refused (no fit, `IN_FLIGHT`, past `D`, tombstoned, invalid) |
| held (a) | `HELD(a)` once durable, or `GRANTED(a)` | yielded (E3, gives up a), displaced (`DISPLACED(a)`), converted (after E5, `convert` with a), released (after an outcome) |
| waiting (a) | `WAITING(a, ahead deadline)`; `WAITING_NOTICE(a, …)` | held (a) by `GRANTED(a)`: **the same attempt**; refused (`WAITER_REFUSED(a)`) |
| yielded / displacement accepted (gave up a) | Hold released by acceptance; waiter registration kept at the request's age at attempt a′ > a, as the acknowledgement or the next message names it | held (a′) by `GRANTED(a′)`, refused |
| converted / released | Acknowledged once durable | — |

So a hold granted at attempt n and then displaced is displaced **at n**, its marker carries
n, and the confirm transaction sees it (P1-S78 row 2 after a grant). The link deletes a
marker in the entry that ends its attempt, so a present marker is always for the link's
current attempt (C02); a marker whose attempt differs from the recorded one still stops E5,
and the owner alerts and sends `query` for the leg; and a `convert` after a grant carries n, the hold's attempt,
which the link accepts (P1-S11, P2-S16).

Partner leg states are in §10.3.

### 5. The workflow

#### 5.1 Taking holds

After E1 commits, the owner sends, **in parallel**:

- to each Share leg's link owner, `hold(request, account, leg, kind, rate, window, D,
  D_c, request_age, wait, receipt minute, policy version)` on the link hold port, with the
  sender's (generation, epoch) and the link's routing fields (RFC-001 §11.1; RFC-000
  AI-17-1); it carries **no attempt**: the link assigns it and answers `HELD(attempt)`,
  `WAITING(attempt, ahead deadline)` or `REFUSED(reason, counter-offer?, retry_after?)`; `kind` is `booking`, or `change` with
  its reservation; the receipt minute and the link-rules policy version are those recorded
  in E1, against which the link re-checks validity; with `wait = false` the link itself
  refuses a request blocked only by capacity in flight, with a tombstone and no waiter;
- to each partner-with-holds leg's adapter, `hold(stamp, request, leg, reservation?, rate,
  window, expiresAt = D, requestAge, commitFence = D_c, wait, opaqueRef)` on the partner
  port (C12 §2.1; `reservation` set for an addition; the stamp carries the partition's
  (generation, epoch) and map version). With `wait = false` the adapter itself refuses a
  request blocked only by Share's own position, `REFUSED(IN_FLIGHT, retryAfter)`, with a
  tombstone and no waiter (C12 m6), as a link does.

Every command to a link carries C01's `CommandEnvelope` and the C02 body's
`receiverPartition`; in a coalesced call each item has its own envelope, and the reply is
per item (C02 review 42 M2, review 54 m3).

A partner leg **without holds** is not touched now (§5.5).

**Order at a link** (POL-05 as amended in v1.7; P1-S14, P1-S77). The account owner imposes
no order on checks at a link: a link checks requests in the order their `hold` commands
**reach its schedule owner**, a re-sent command (same request and leg; the hold is idempotent by request) taking the
place of its first applied copy. Within one account, holds are sent in the account's serial
order, so they usually reach the link in it, but nothing depends on that: the account's
own arrival order binds only its funds, key-headroom and capacity-in-flight checks (§3.1
step 4, POL-25). Requests of two accounts may therefore be checked at a link in the reverse
of the order their accounts received them (P1-S77); each is then answered by the link's
outcome (held, waiting with `retry_after`, refused) as below.

Answers and what the owner does:

| Answer | Action |
|---|---|
| held (`HELD(a)`) | Leg held at attempt a, recorded. If every Share and partner-with-holds leg is held, the request is Ready |
| waiting (Share link: blocked only by capacity in flight, `wait = true`; partner adapter: refused while Share's own position overlaps, `wait = true`), with the deadline of the request ahead | E2 waiting mark, then waiting hints (§5.2) |
| refused `IN_FLIGHT` (`REFUSED(IN_FLIGHT, retry_after)`: Share link or partner adapter, `wait = false`, blocked only by capacity in flight or Share's own position; the refusal records a tombstone and counts as that leg's release acknowledgement, RFC-000 AI-17-1, C12 m6) | E7 rejected at once, with `retry_after` = the latest remaining deadline among the requests in flight that block it (the link's, and on several legs the latest of theirs, B-RQ-4) and the counter-offer computed beside the capacity in flight (§5.8; P2-S18, P2-S59) |
| refused, no fit on committed capacity (Share link: `REFUSED(NO_FIT)` to the hold, or `WAITER_REFUSED(a, NO_FIT)` to a waiter; the refusal records a tombstone and counts as that leg's release acknowledgement) | E7 rejected, naming the link, with the route counter-offer computed beside committed and held capacity (§5.8) (P2-S02, P2-S17) |
| refused definitively by the partner, with no Share position overlapping (§10.5) | E7 rejected, naming the partner link (P2-S31) |
| refused `UNKNOWN_LINK`, `LINK_CLOSING` or `LINK_RETIRED` (the link is unknown, or an operator in commercial has started to retire it; the link records **no tombstone**, C02 M-2) | E7 rejected at once, "link unavailable", **naming the link**, with **no counter-offer** (POL-07, POL-10 as amended in v1.11; P2-S120); request-scoped releases to every leg; the funds hold released in the E7. To a `release`, these answers count as that leg's acknowledgement. The same holds for an extension or an increase, which leaves the reservation unchanged |
| partner transient refusal | The adapter retries within the request's commit fence; nothing changes at the account owner (P2-S30) |
| partner fault: transient or unknown results persisting to the leg's fence, or an answer the driver cannot classify (§10.2) | E7 failed, partner fault, naming the leg (P2-S62) |
| displaced (`DISPLACED(a, reduction, record time, fits?, counter-offer)`, a being the attempt the marker carries, which equals the recorded attempt for a current hold, and may be a granted one: a capacity reduction recorded at the link means the held leg no longer fits beside committed capacity and older holds; RFC-001 §5.1) | Whether the request **had begun committing** when the reduction was recorded is judged exactly by whether its E5 transaction sees the reduction's displacement marker (POL-07 as amended in v1.7, P1-S78; B-RQ-9). The notice is sent only after the marker commits, so any E5 transaction begun after the notice arrives sees it. In the owner's serial order: **E5 committed** (Decided): E5 did not see the marker, so the request had begun committing; nothing to do, the `convert` already sent answers the notice and the link flags the reservation affected and alerts network operations (P1-S63). **E5 in flight** (Deciding): the owner waits for its batch's result; committed is the case above; dropped for the marker is the next case; an ambiguous result is re-read as in §2.1 (C10, C19). **No E5 committed or in flight** (Holding, Waiting, Ready, and Committing, even with partner confirms already sent or answered): the request had not begun committing and is decided against the reduced capacity: if the leg does not fit on committed capacity, E7 rejected for no fit with the counter-offer (P1-S41, P1-S78), and every partner booking already made for it is cancelled at Share's cost (§5.5 step 6, POL-28); if it still fits, E3 displacement accepted, `displacement_accept(request, a)` sent, and the leg becomes a waiter at the attempt the link names (P1-S42 for what follows), any partner booking kept until the request's outcome. A Committing request sends no further partner confirm once the notice is applied |
| no answer, or a C01 `RoutingRefusal` `UNAVAILABLE`, `NOT_OWNER`, `STALE_EPOCH`, `MOVED`, `MOVING`, `STOPPED` or `OVERLOADED` (link or adapter owner lease, partition moving or stopped) | Re-send with the same identity (idempotent) with backoff, re-routed through the refreshed placement cache, until an answer or the expiry (§6) (RFC-000 §5.2, C01) |
| `STALE_SENDER(recorded)` | By C01 D4 (§2.5): an equal generation with a higher epoch means this owner is deposed for the slot (§12.2 S1); a higher generation means the partition has moved: the command is dropped and the slot kept |
| `MISMATCH` (same identity, different content) | A protocol defect: alerted; the request is handled as if the leg answered nothing until the expiry |

Answers and notifications from a link owner are **state messages** (RFC-000 AI-17-2,
RFC-001 §11.1): each names (request, attempt, kind) and is applied idempotently by that
identity, whenever it arrives; there is no high-water rule across identities (a `GRANTED`
lost on gRPC and relayed later through Kafka is still applied), and within one identity
(only `WAITING_NOTICE` is re-sent with new content) the one reflecting the highest link
sequence wins. A message for an attempt below the recorded one is stale (§4.3). The owner
**reconciles** every request it has in the Holding or Waiting phase by `query(request)` to
each such leg every 5 s (est.), which returns the request's state, attempt and latest
blocker deadline there, so a lost grant, waiting notice or `DISPLACED` is found without a
re-notification.

Hold commands are retried with the same identity (request, leg); the link's request
record deduplicates them for the life of the request plus 24 h (RFC-001 §4.4, RFC-000
§4.4). A hold is never sent before E1 commits, so no capacity is
ever held without its funds hold (P2-S92, P2-S33).

#### 5.2 Waiting

- **The mark.** On the first waiting answer, and whenever a waiting notice changes the
  deadline of the request ahead or reports it resolved, the owner proposes E2. The mark
  carries, per waiting leg, the latest deadline among that leg's blockers, which is what an
  expiry needs for its reason and `retry_after` (§6.2, P2-S116).
- **Hints.** After E2 commits, the owner sends `mark_waiting(request, waiting, position)`
  (on the link waiting port and the partner port, §13) to every participant where the
  request holds a leg, `position` being the account-log sequence it reflects, so a
  participant applies only a hint newer than the last it applied; on leaving Waiting it
  sends "not waiting". Hints only tell a link owner or adapter which younger holders are
  worth asking to yield; correctness rests on the acceptance check of §5.3, so a stale hint
  costs at most one refused yield request.
- **Grants.** When capacity is released on a link, the link owner grants it to its waiters
  by the priority rule and notifies the account owner, `GRANTED(request, a)`. The grant
  **keeps the waiter's attempt** a (RFC-001 §4.3, RFC-000 AI-26-1): the owner marks the leg
  held at the attempt the message carries, which is the attempt it recorded for the waiter;
  it never numbers one itself (JI-1). The grant needs no entry: it is durable at the link,
  and a new owner learns it by `query`.
- **A waiter that no longer fits** (the request ahead was confirmed, or the link's capacity
  fell, P1-S42) is refused by the link with a tombstone, `WAITER_REFUSED(request, a,
  NO_FIT, counter-offer)`; the owner appends E7 rejected for
  no fit with the counter-offer (P2-S52).

#### 5.3 Yields: crossings and cycles

A link owner (or a partner adapter, §10.5) whose waiter O is blocked by the hold of a
**younger** request Y that it believes waiting asks Y's account owner to yield the leg:
`YIELD_REQUEST(Y, a, claim, O)`. **The link sets the claim** (the link-log sequence of the
entry that raised it; C02 review 42 M1, review 54 M3). Y's owner answers each claim, in its
serial order:

1. If Y is in the Waiting phase (some leg still waiting, none refused, not withdrawn, not
   decided): propose E3 *yield accepted*, which records the claim, mark the leg yielded in
   the projected state at once (so no confirm can be proposed on the strength of that
   leg), and after E3 commits send `yield_accept(Y, a, claim)` with the attempt a and the
   claim the yield request named. The participant
   releases that attempt's hold and registers Y as a waiter at the next attempt, at Y's own
   `request_age`, so Y keeps its place (P2-S97); the acknowledgement names the new attempt,
   which the owner records (§4.3). A yield request for an attempt below the recorded one
   is stale: the owner answers it `yield_refuse(Y, a, claim)`. The link answers a reply
   for a stale attempt or an ended claim with `STALE_ATTEMPT`, and the owner records
   nothing more for it (C02).
2. Otherwise (Holding with no waiting leg, Ready, Committing, Deciding, decided): refuse
   that claim, `yield_refuse(Y, a, claim)`. A refusal ends only the claim it names. A
   holder that is not waiting is never pre-empted (P2-S58).

**A holder that starts to wait later yields** (POL-02 as amended in v1.11, P2-S118; C02
D3). The link re-sends an unanswered yield request with the same claim. When it records a
refusal, it raises a **new claim at once** if Y's waiting mark is set and an older waiter is
still blocked by that attempt; and when a waiting hint for Y arrives with no claim open for
that holder attempt and that older waiter, it raises a new claim then. So in P2-S118: B
holds L2 and is not waiting, and refuses A's claim. B then waits for L3; its E2 commits and
its hint `mark_waiting(B, waiting)` reaches L2; L2 raises a new claim; B is now in the
Waiting phase and accepts it (E3, `yield_accept`); L2 grants B's 8 Mbps to A; A is held on
every leg and is confirmed before either deadline. B waits at L2 at its own age, pending,
within its deadline. The end of a hold attempt (an accepted yield or displacement,
`convert`, `release`) ends every claim on it.

The acceptance carries Y's partition (generation, epoch), and §5.2 of RFC-000 makes the
participant ignore a command from an older pair than it has applied for Y's partition. Why
every cycle breaks without being detected is shown in §11.

#### 5.4 Committing a request without a partner leg

When Ready and the owner's clock is before `D − τ`, the owner checks `standing(S)` is active
and the request is not withdrawn on the projected state, then composes E5 into the next
batch, whose transaction makes the checks of §5.6 at its `ts`. "Begin committing"
for such a request is starting that batch transaction, whose commit timestamp the
transaction checks against `D − τ` (§2.5), so it is never later than `D − τ` ≤
`D − ack_budget` (POL-26, P2-S110). If the clock is at or past `D − τ`, nothing is composed;
if the commit timestamp would be, the confirm is dropped; either way the expiry follows
(§6).

#### 5.5 Committing a request with partner legs

When Ready:

1. **Share's checks** on the **projected** state, which includes the batch in flight, in
   the serial order, with no log entry (A0R-14; revision 4, J-12, D-6): `standing(S)` active
   and the key not revoked, both on the projected state; not withdrawn; undecided; identity
   freshness leaving the partner window (the owner's clock + `commit_margin` ≤ `iam_fresh` +
   `iam_fresh_max`, so the E5 that follows can pass the freshness check, §5.6); and the
   owner's clock before `D_c − σ_p − h` (h: one hop to the adapter, est. 5 ms). If standing
   or the key fails on the projected state only (a suspending or revoking entry in flight),
   no confirm is sent and the checks are re-run once that batch resolves: its commit ends
   the request (§7.2), its failure lets the confirm go. If freshness fails, the confirm waits
   for catch-up (pulled after 20 s of silence) while the fence allows. If the request is
   decided or its fence has passed, it ends (E7 or the expiry) and every partner hold is
   released.
2. **Partner without holds, if any (at most one, POL-28)**: send `book_final` to its
   adapter. It is booked last: after every other leg is held, after the funds hold and after
   Share's checks (P2-S33). Its answer:
   - booked → step 3;
   - refused definitively → E7 rejected naming the link (or waiting, if Share's own position
     overlaps there, §10.5, P2-S96);
   - unknown → the adapter reconciles at once (§10.6); a booking found later for a request
     that has ended is cancelled at Share's cost (P2-S35).
3. **Partners with holds**: send `confirm` to each, in parallel. If the remaining time to
   `D_c − σ_p` is below the partner's expected answer time (from its terms) when step 2
   starts, steps 2 and 3 are sent together instead, accepting that a refusal at the partner
   without holds then leaves the held partners' confirmations to cancel at Share's cost.
4. **Each adapter journals the send in its own log before calling the partner** (J2 or
   J3 intent, whose commit timestamp is the recorded send time, §10.4). The first journaled
   send is the request's "begin committing" time; the adapter journals it only before
   `D_c − σ_p` and sends only within `h_s` of the journal's commit, so the call leaves
   before `D_c` in true time (P2-S109, P2-S55).
5. **When every partner leg has confirmed**: re-run the checks and compose E5 if the clock
   is before `D − τ`. The partner confirm therefore has at least `commit_margin − τ` (about
   9.6 s, est.) for its answer (RFC-000 §4.3 rev. 4.2).
6. **If any partner leg refuses, answers unknown and is still unknown at `D − τ`, or a
   Share-side event ends the request** (suspension, revocation, withdrawal, expiry): the
   deciding entry is the ending one, and every partner booking already made for the request
   is cancelled at once at Share's cost (POL-28, RQ-2; P2-S105, P2-S57). Share never
   confirms a leg the partner has not confirmed (P2-S29, P2-S03).

Two partners with holds of different lengths are handled alike: each hold expires at `D`
(set by Share), each is confirmed before E5, and any one confirmed for a request that is not
confirmed is cancelled (P2-S37).

#### 5.6 The decision entry

E5 is the single POL-04 decision point of a confirmed request. It is composed only if these
hold, in this order, at its place in the serial order, evaluated by the batch transaction at
its `ts` (§2.1, §2.5 step 3), the database enforcing the first and third again: the request
is undecided (its decision row is new); `ts < D − τ` with the recorded `τ`, `ts` being the
batch's commit timestamp; **`ts` ≤ `iam_fresh` + `iam_fresh_max`** (45 s), with the
`iam_fresh` recorded; an unset watermark fails the check (RFC-000 AI-R5-4, RFC-005 C3: a revocation committed at identity before
`ts − 45 s` is therefore already applied, so a revoked key's request is never confirmed
past X1-S06's bound; a stale slot confirms nothing and pulls catch-up); **no displacement
marker** for the held attempt at any Share leg, read in the same serialisable transaction
(one point read per leg under a savepoint with a short lock timeout, about 1 to 2 ms, est.;
a timeout defers this E5 to the next batch, J-14; RFC-000 §8 link displacement read,
AI-R1-11). There is **no exception** for a request whose partner confirm
or final booking was journaled before the marker (POL-07 as amended in v1.7: a confirmation
that sees the displacement record is decided against the reduced capacity, P1-S78;
B-RQ-9). **A marker present for the leg, with any attempt** (C02 erratum (c)), means the
reduction committed before this confirm: no E5 is written and the request is handled as
`DISPLACED` with no E5 (§5.1). The link deletes a marker in the entry that ends its
attempt, so the marker is for the current hold; if its attempt is not the one recorded for
the leg (the attempt `HELD` or `GRANTED` carried; a grant keeps the waiter's attempt,
§4.3), the owner also alerts and sends `query` for the leg. Absent, and E5
commits: the request had begun committing before any reduction that displaces it later,
and the link flags the reservation affected on `convert` (P1-S63); no withdrawal applied; the account is active (`standing(S)`, recorded in the entry; a
key revoked earlier in the log has already ended the request, §7.2); every Share leg is held at a
recorded attempt that has not been yielded; every partner leg has a recorded partner booking.
If any check fails, no E5 is written and the owner composes the ending entry with the
corresponding reason. A suspension, revocation or withdrawal **after** E5 in the log changes
nothing (P2-S103), even while a status read still shows `pending`.

#### 5.7 After the decision

- **Confirmed.** The owner sends `convert(request, attempt, reservation, part, T_dec)` to
  every Share leg, the attempt being the one recorded for the leg (the hold's, which a
  grant does not change; RFC-000 AI-26-1, RFC-001 §4.4: another attempt is refused
  `MISMATCH`), `T_dec` the decision timestamp, and `createdBy` the E5's position (asynchronous,
  idempotent; the hold keeps counting until converted, RFC-000 §4.2). **Each `convert`
  goes in its leg's queue at the position of its E5** (§9.8; C02 C4-3, erratum (f)), so a
  cancellation decided just after it waits for `CONVERTED`. To every partner adapter it
  sends `outcome_confirmed(request, leg, attempt, reservation, part, decision time)`, by
  which the booking joins the leg's booking set (C12 F3). Acknowledgements are collected
  in memory and retried until in hand. No entry records
  them (E10 is retired): a new owner re-sends `convert` for every confirmed request whose
  `D` + `release_grace` has not passed (the *conversions pending* query, §2.5), and a link
  that has seen no outcome by `D` asks for it and is answered "confirmed" (§6.3), so a
  conversion lost with its owner is still made. This saves one transaction per confirmed
  request, which on the substrate is not shared with other accounts.
- **Not confirmed.** The owner sends a **request-scoped release** (no attempt number) to
  every Share leg **in the intake**, not only those it believes held, and to every partner
  adapter (which releases the partner hold, or cancels a partner booking at Share's cost).
  Each link owner records a tombstone in the release entry and acknowledges once durable.
  The owner batches acknowledgements into E8, in the partition's next batch transaction; when every
  acknowledgement is already in hand at the deciding entry (a single-leg refusal, or nothing
  sent), the deciding entry records it itself (RFC-000 §4.3). The partner release does not
  gate the report; the partner hold lapses at `D` in any case (P2-S14, P2-S101).
- **Reporting** follows §8: the outcome is reported once E5, or the deciding entry and its
  complete E8, are at the report position.

#### 5.8 Counter-offers (P2-N11, POL-10)

On a rejection for no fit, and on a `wait = false` rejection, the owner computes the route
counter-offer before proposing E7, so the counter-offer is part of the recorded outcome. A
rejection "link unavailable" (a link being retired, §5.1) has **no counter-offer**, names
the link and makes no availability query (POL-10 as amended in v1.11, P2-S120):

1. It calls the **link availability query** (RFC-001) on every Share leg for the window
   and, forward from the requested start, the free-capacity profile up to the selling
   horizon, beside committed capacity **and** the capacity held for requests in flight, for
   every rejection (a `wait = false` rejection and a rejection for no fit alike): what the
   buyer can have now, without waiting (POL-10 as amended in v1.6, RQ-R1-9; P1-S73).
2. **Largest rate** that fits the window on every leg = min over legs of (capacity − peak
   over the window).
3. **Earliest window** of the requested length, starting at or after the requested start,
   that fits the requested rate on every leg: a sweep over the minute boundaries where any
   leg's profile changes, keeping the earliest start whose window fits on all legs, within
   the horizon.
4. **Blocking link**: the first leg in route order that refused (P2-S73).
5. **`retry_after`** (a `wait = false` rejection): the latest remaining deadline among the
   requests in flight that block it, on one link or several legs, from the waiting answers
   (POL-05, B-RQ-4; P2-S18, P1-S70).

Partner legs' availability is not computable; the counter-offer covers the Share legs and
says so. Nothing about other buyers is disclosed (POL-10). The queries add one parallel
round trip (est. 5 to 10 ms) to a rejection.

### 6. Deadlines, the fence and expiry

#### 6.1 The timers

For each undecided request the owner keeps, in a timer wheel:

| Time (owner clock) | Effect |
|---|---|
| `D_c − σ_p − h` | No partner confirm or final booking is sent from now on (the adapter refuses them past `D_c − σ_p` anyway) |
| `D − τ` | No E5 is composed from now on; an E5 whose batch would commit with `ts ≥ D − τ` is dropped (§2.5) |
| `T_x = D − ε − δ_x` | Compose E6 *expire if undecided* |
| `D` | The earliest commit timestamp for the E8 that completes an expired request (§6.5) |

For each reservation it also keeps a **window-end timer** (§9.1) and, for each open offer,
the `offer_window` timer (§9.6). `onMovedOut` cancels a partition's timers and `onAdopt` or
a takeover re-arms them from state (§2.5).

`τ`, `ε` and `δ_x` are the configured values (RFC-006, RFC-000 §4.3: `ε` = 100 ms, `δ_x`
per topology state at p99.9), read at the moment of use; the confirm guard is checked
against the commit timestamp and so fails safe whatever the owner's clock (RFC-000 R4).
Since `τ ≥ ε + δ_x`, under one owner every appended confirm precedes the expiry in the log,
and the expiry has `δ_x` to make every Share-link release durable by `D` (P2-S93). RFC-006
counts every release durable after `D`; the owner classifies each one whose expiry did
not commit by `T_x` plus its commit budget, so that a late release caused by the decision
record's unavailability (§6.4) is alerted as such rather than counted as a P2-S93 breach.

#### 6.2 The expiry entry, its reason and `retry_after`

E6 is conditional (*if undecided*). Its reason is that of the first row that applies:

| Condition at the expiry | Reason | `retry_after` |
|---|---|---|
| A takeover entry (E9) follows the request's last progress, and its `ts` is at or after `D` (the booking process did not restart before the deadline) | "interrupted by an internal failure" (P2-S23) | — |
| The request is in the Waiting phase (from memory; after a takeover, from the last E2 and the resume queries) | "deadline passed while waiting" | The latest remaining deadline, at this moment, among the requests ahead on all its waiting legs (from E2, which records per leg the latest deadline among that leg's blockers), 0 for each that has had its outcome (POL-02 as amended, B-RQ-4; P2-S61, P2-S95, P2-S116) |
| Otherwise | "deadline passed" (P2-S13, P2-S55, P2-S110) | — |

The first row refines RFC-000 §4.3's wording ("could not be resumed in time") so that a
request resumed before `D` but after its commit fence fails with "deadline passed", as
P2-S110 requires, while one whose process stayed down past `D` is "interrupted" (P2-S23;
B-AI-5).

#### 6.3 Expiry requests from participants

A link owner or partner adapter that has seen no outcome for a hold it keeps by `D` (by its
clock) sends `expire_if_undecided(request)` on the outcome and expiry port as a gRPC
command, again every 1 s while the condition holds, keeps the hold, and raises an alert
(C02; C12 `ExpireIfUndecidedMsg`). The owner writes E6 at most once for each request. The owner proposes E6 if the request is undecided; in either case it
answers **with the committed outcome**: confirmed with its decision timestamp (the link
converts) or not confirmed (the link releases and acknowledges) (RFC-000 §4.3). The answer is
sent only after the entry deciding it is committed: `convert` (confirmed, with `T_dec`) or
`release` to a link; to an adapter, `confirmed` is applied as `outcome_confirmed` for each
listed leg and `not_confirmed` as `release` (C12 §3.4).

**`offer_outcome_if_lapsed(offer)`** (C02 M-1). A link that still has an offer hold after
`lapse_at` keeps the offer parts and sends this command, again every 1 s, identity (link,
offer, "lapse"). The owner answers when the offer is decided: `offer_accept` again for a
Final offer, `offer_release` again otherwise. An offer that lapses without an answer is
Lapsed by the owner's own `offer_window` timer (§9.6).

#### 6.4 When the decision record is unavailable at the deadline

The decision record is **unavailable** when no instance holds the account slot's owner
lease, or the account's ranges have no leaseholder (a range-lease move after a node loss)
or no quorum (RFC-000 §4.3). Under v1.6 it counts as **unavailable at the deadline** if it
is unavailable at `D` **or at any time in the last `ack_budget` before it** (POL-26, B-RQ-6;
P2-S114): an owner that can commit again at `D − 20 ms` cannot make the releases durable
by `D`, and need not.

In either case no participant can learn the outcome in time, so every Share-link hold is
kept (safe) and the participants alert at `D` (P2-S104, P2-S53). The owner, once it can
commit (the same owner after a range-lease move, or a new one after its E9), appends E6 for
every undecided request past `T_x` (reason by §6.2), and releases follow within
`release_grace` after `D` (P2-S101, P2-S104, P2-S114, P1-S54); a lease or range move takes
seconds (est.), well inside it. The owner raises the operational alert itself for each such
request (its E6 committed after `T_x` plus its commit budget, §6.1), with the request and
its legs (P2-S114). The partner hold lapsed at `D` by itself. A confirm transaction that
committed with a `ts` before `D − τ` while its owner was failing (the database resolves an
in-flight transaction when the next reader meets it) is found by the new owner's recovery
read and kept: the request is confirmed by a decision in time that becomes known after `D`,
at most `release_grace` after it, and status reads report `pending` or `confirmed`
meanwhile, never failed (P2-S106 as amended, RQ-5, RQ-13).

#### 6.5 Expiry outcomes are reported no earlier than `D`

E6 is committed about `ε + δ_x` (est. 205 to 400 ms) before `D`. So that "failed as of its
deadline" is never reported before the deadline, the E8 that completes an expired request
is committed only with a `ts` at or after `D` (§2.5): the owner composes it once its clock
reaches `D`, and the transaction re-checks its commit timestamp. The releases themselves
are durable by `D`; only the report waits, by at most one batch transaction plus the
report delay (est. 40 ms steady at p99).

### 7. Withdrawal, revocation and suspension of undecided requests, and the inputs that suspend

#### 7.1 Withdrawal (POL-08)

`withdraw(idempotency key)` **names the key of the request it withdraws** and has no key of
its own, so every retry is the same withdrawal (POL-29 as amended in v1.11, P2-S122; C10
M5). It is in the booking-and-change family and counts toward `key_rate_limit` and
`account_rate_limit` like any submission. The owner looks the key up first (§3.1 step 3).
A key used by another principal of the account gets `409 key_reuse_other_principal`, which
reveals nothing (C10 M4). For a key of this principal's request, the owner proposes E4,
conditional. RFC-000 §3 describes a withdrawing mark followed by "the next deciding entry
(normally at once)"; this RFC writes both in one conditional entry, which has the same
order and one write fewer:

- undecided → failed, "withdrawn"; funds released; request-scoped releases; any partner
  booking already confirmed or final is cancelled at once at Share's cost (P2-S56, P2-S57,
  P2-S105); the buyer is not charged;
- already decided → no-op; the answer is the decided outcome (P2-S103).

**A withdrawal of a key that no request uses** (C10 D4, R40-06; P2-S122 row 2). The owner
records a **pre-emptive withdrawal**: an E1′ under (account, booking-and-change family,
key) with the principal, outcome failed "withdrawn", no fingerprint and `request_kind`
`preemptive_withdrawal`; nothing is held. The answer is that status. A later submission
under the key from the same principal, within `idempotency_retention`, is answered with it,
whatever its body, and creates nothing (§3.1 step 3); from another principal it gets `409
key_reuse_other_principal`. So a withdrawal that overtakes its booking still stops it, and
a withdrawal never answers "no such request". The cost is one E1′ for each early
withdrawal, removed by the index's TTL.

The answer to the withdrawal is the request's status by §8.1, so a retry of a withdrawal
reports the same outcome (P2-S122 row 1). A withdrawal of a change request withdraws only
that change.

#### 7.2 Key revocation and suspension

These arrive as funds entries (§2.3): a key revocation as F4, from the identity status push
or a catch-up answer (RFC-005 C3, applied by the funds module, read by booking; AI4-3,
AI-R5-4), a suspension as the outcome of F1, F2, F3, F5, F6 or F7 (*price effective*, P4-S101;
*exposure step*). In the **same entry**, the booking module writes an ending record
for every undecided request concerned: key revoked → failed, "key revoked", for the key's
undecided requests (P2-S72, X1-S06); suspended → rejected, "account suspended" with the
resume amount itemised (POL-16 as amended in v1.8), for every undecided request **that
adds**: a booking, an extension, an increase (P2-S69). Undecided reductions and queued
reductions are unaffected and continue (POL-08, P2-S77; J-13). Each ending is that request's decision point; releases, partner cancellations and
reporting follow §5.7. Confirmed reservations are unaffected (P2-S72); a request whose E5 is
earlier in the log stays confirmed (P2-S103).

#### 7.3 Invoice status and the credit limit (RFC-000 A-1; J-05, J-06)

Two inputs change standing without a ledger movement of their own; both are applied in the
account log, so their effects have one position like every other (POL-04).

- **Invoice-status feed** (RFC-004 receivables → account owner, Kafka, keyed by account):
  *overdue* (invoice, unpaid amount), *paid* (invoice), *written off* (invoice, amount) and
  *credit limit removed*, each carrying the **buyer partition's ledger position** `P_e`
  receivables had applied, and its own event identity (partition, stream, `stream_seq`) (C07 F4). The owner applies
  events in stream order. An event whose `P_e` is above the account's applied ledger
  position (the last F1's) is **held**, in memory and in the `funds_*` held-events row so a
  new owner finds it, and composed as F6 (or F5 for *credit limit removed*) in the batch
  that follows the F1 reaching `P_e`; an event at or below it is composed at once. So a
  write-off's F6 never precedes the F1 that carries its `W`, and `OD`, `W` and `CL` change
  in log order with the movements they were computed from (the trace of review 18 J-05). A
  standing transition it causes ends undecided additions in the same entry (§7.2).
- **Credit-limit command** (operator console → account owner, gRPC; C07 op 2 is the
  authority; semantics RFC-004 A): `set_credit_limit` or `remove_credit_limit`, the amount,
  `reason_code` and `action_id` all in the signed C08 envelope, idempotent by
  (`action_id`, account). **A set-scoped action** arrives as one envelope per member account
  under one `action_id`, each with a `member` field outside the signed digest. The owner
  evaluates in C07's order; the first step that decides gives the answer (C07 R37-01,
  v1.2):
  1. **Authenticity**: C08 §E checks 1 and 2 (check 2 only under identity's returned key),
     and check 4 for an `approver` that is present (same role, another person). A failure
     is `refused{unauthorised, check}` and is **not recorded**. For a set-scoped action,
     `member` ≠ this account is `refused{out_of_scope}`, not recorded.
  2. **Deduplication** by (`action_id`, account): if the log has an F5 (applied or refused)
     for `action_id`, the answer is that of the **first** F5, before any check that can
     change with time. A different digest, or a different requester or approver, is
     `refused{conflict}`, recorded.
  3. **Freshness**: checks 3 (identity's operator check, C15, for each signer), 5 (`ts` ≤
     `not_after − ε`, with `not_after` at most 72 h + `ε` after the owner's `ts`, C08 D5)
     and, for a one-account target, 6 (`target_version`). A failure is `refused{unauthorised,
     check}`, recorded; an unreachable operator check is `UNAVAILABLE`, not an answer. Then
     **four eyes** (POL-32 as amended in v1.11, X1-S49; C07 v1.2, C08 v1.2): a `set` whose
     new limit is above `credit_limit_four_eyes_above` (10,000 USD, strict) **and** higher
     than the limit in force (`CL`, 0 if none) needs an approver; without one it is
     `refused{unauthorised, four_eyes_required}`, **not recorded**. A decrease, a removal,
     or a set at or below the threshold needs one operator. The threshold is the one in
     force at `not_after − approval_expiry`.
  4. **Scope**, set-scoped only (C07 S1, C08 S-M1): the envelope applies to `member` iff it
     is this account **and** the applied F9 marks it a designated probe account. The signed
     slot-map version v is **not** checked; it is recorded in the F5's audit, beside the
     designating version that F9 records. A failure is `refused{out_of_scope}`, recorded,
     before KYB.
  5. **Validity**: `refused{invalid}`, recorded.
  6. **KYB** (`set` only): if `iam_fresh` is unset, or `ts > iam_fresh + 45 s`, nothing is
     appended and the answer is **`temporarily_unavailable{identity_stale}`**, never final;
     the console retries under the same `action_id` (C05 S-3, C07 D49-5). Otherwise a set
     while the applied KYB status is not passed is `refused{kyb_not_vetted}` (P4-S82),
     recorded; else F5 is applied, recording `iamFreshUsed` and the approver.

  The answer is sent after the entry commits. A `CreditLimitRemoved` on the
  invoice-status feed is superseded by an F5 *set* committed after its `decided_at` (C07
  R37-03). The invoice-status events carry as `ledger_pos` the position of the account's
  last applied movement (C07 R37-04), which is the position the gate above compares.

### 8. Reporting: the edge's answer, status replicas, the outcome feed and webhooks

An outcome is **reported** by any of four channels, and every channel obeys one gate
(A10, RFC-000 §4.6): a confirmed outcome once its E5 is at or below the report position; a
non-confirmed outcome once its deciding entry **and** its completing E8 are; an outcome at
intake (E1′) once E1′ is; **a change** once the E11 that decides or fails it is, and, for a
change that frees capacity, once its E12 is too (C04 M-01). Every booking request, a change
included, gets an outcome event. The **report position** is the owner's, per account slot: the
highest commit timestamp P such that every entry of the slot at or below P is committed
**and** every status reader holding a read lease has acknowledged applying it (the owner
pushes each committed batch to the leased readers; about 10 ms steady, est.). A read lease
is granted or renewed only if it ends, by the owner's clock, before the owner's own lease
does, and a handing-off owner stops granting at the handoff; a new owner reports nothing
until `read_lease` + `ε` (about 500 ms) after its acquisition commit, so every read lease its
predecessor granted has ended (RFC-000 §4.6, AI-R6-2). Its first report position covers every
entry it read on taking the slot, and it grants a read lease only to a reader that has
applied through it (§8.2, the basis of RQ-13's "never pending again").

#### 8.1 The edge's synchronous answer

The owner keeps the forwarded submission open until the earlier of:

- the outcome is reportable (gate above): the answer is final (P2-S07);
- `ack_budget` less the edge's own share (est. 20 ms) after the edge received it, provided
  E1 has committed: the answer is `pending` (P2-S08, P1-S34).

`pending` is not a report and is not delayed by the report gate (RFC-000 §3), but it is
only ever sent for a committed intake (§3.1). **The owner decides a final answer or
`pending` once and atomically for each request** (C04 B-01): if it sends `pending` before
the request's outcome entry is formed, it sets C01's `EntryInput.pendingAnswered` to the
request id on that entry, and the outcome event carries `answered_pending = true`; the
first marker that covers the event then lists the request in `pendingAnswered` (§8.3). The same rule answers a retry with the key, a
withdrawal and a change submission. A single-link booking with no capacity in flight is
reportable within about 176 ms at p99 from R1, 186 ms from R2 and 196 ms as the R2 probe
measures it, batching waits `W_a` and `W_l` included (est., RFC-000 §3 rev. 4.2; about 146,
156 and 166 ms with the second account lane), so it gets its final answer (P2-S07, X2-S15),
with the thin margin RFC-000 R23 tracks (RB-16); a route gets `pending` within about 65 ms
(est.) and its outcome by its deadline (X2-S06).

#### 8.2 The status replica rule

Status reads (polls, and retries answered by replicas) are served by **status readers**
(RFC-000 §4.6, AI-4): one NestJS status-reader instance per Kenyan facility, four in all.
For every account slot each holds (a) the batches the owner has pushed to it since its read
lease began, and (b) **bounded-staleness follower reads** of the `request`, `decision` and
`idempotency` tables through the database replicas in its own facility (the Kenyan voting
replicas other than the leaseholder's, and one non-voting replica per Kenyan facility), for
anything older. A read lease lasts at most `read_lease`, timed from the reader's own
request and treated as expired `ε` early. A reader answers a status read for request q by
RFC-000 §4.6's rule:

1. **A committed outcome** it has applied (pushed, or found by follower read), with, for a
   non-confirmed one, its completing E8: that outcome, however stale the reader is
   (P2-S10).
2. **Live read lease**: otherwise, if it holds a live read lease **and has not applied the
   partition's `moved` entry** (RFC-000 AI-27-2), `pending` (P2-S99,
   P2-S03, P2-S107: an ending entry whose E8 is incomplete reads `pending`). The lease
   guarantees it has applied every reported position.
3. **No owner holds the lease**: otherwise, if a consistent read of the owner-lease row
   shows that no instance holds the slot's owner lease, it reads q's rows at the present
   timestamp, which sees every committed entry, and answers as in rule 1 if it finds a
   committed outcome, otherwise `pending`. While the account's ranges are moving their range
   lease, the read waits for the new leaseholder (seconds, est.) rather than answer.
4. **Otherwise** (an owner holds the lease but this reader has no read lease, the reader
   has applied the partition's `moved` entry, or the database cannot be reached): refuse
   with a retry; the client's retry reaches another reader, or, after a re-slotting, the
   new slot's readers once they serve it (from reads at or after its `adopt`, and with
   reports only `read_lease` + `ε` after `adopt`, RFC-000 AI-27-2).

**Why it meets POL-04 as amended in v1.6** (RQ-13, B-RQ-7; P2-S111, P2-S106, P2-S108):

- *Never a contrary outcome.* A reader answers an outcome only from a committed deciding
  entry, and a request has at most one (its decision row, §2.1); a non-confirmed one only
  with its complete E8. While the record is unavailable it therefore answers `pending` or
  the decided outcome, never another, and never "failed" for a confirmation decided in time
  (P2-S106).
- *Never `pending` after a report.* A reported outcome was applied by every leased reader
  before it was reported (rule 1 answers it); rule 2 answers only under a live lease; rule
  3 reads at the present timestamp and finds it (P2-S108, RQ-10).
- *Once any read has answered the decided outcome, every later read does* (P2-S111's
  second Then). An unreported outcome is answered only by rule 1 or rule 3, from a committed
  row. Rule 3 runs only when no owner lease is held, so every read lease has ended (each lies
  within the owner lease, and readers expire theirs `ε` early); the next owner's first read
  of the slot sees the row, its first report position covers it, and it grants no read lease
  before a reader has applied it, so every later rule-1 or rule-2 answer is the outcome. A
  rule-1 answer from a reader that saw the row before the outage is covered the same way,
  since the row is committed.
- *Owner changes that are not takeovers* (RFC-000 AI-27-1, AI-27-2). A lapsed renewal or a
  re-home resolves every in-flight batch and grants no read lease, and reports nothing,
  below its commit timestamp, so the argument above holds for it as for an acquisition by
  expiry. A re-slotted partition's old readers stop answering `pending` from the moment they
  apply `moved` (rule 4); `adopt` commits only after the old slot's report position has
  passed `moved`, so every outcome reported by the old slot is committed below `adopt`, and
  the new slot's readers, reading at or after `adopt`, find it (rule 1); the new slot
  reports nothing for the partition until `read_lease` + `ε` after `adopt`, by when every
  old read lease covering it has ended.
- *Bounded.* The record is available again once an owner holds the lease and the ranges
  have leaseholders: seconds (est.), within admission's 1 min RTO before the deadline and
  within `release_grace` at it (RQ-12; P2-S111's last Then).

**On the substrate** (C01 §3.4, R47-17). A reader serves pushed batches from memory and
older rows by `leasedRead` point reads, each its own statement, at or after the
partition's `adoptTs`; `isMovedOut(partition)` true means rule 4; rule 3 is
`replicaRule3Check(slot, key)`. The **initial report position after any acquisition**
(§2.5; the catch-up or resolution read, with no `P_grant` below it) is what makes the
third property hold across every kind of acquisition, a resume and a re-home included
(AI-33-2).

Four additions this RFC makes to the rule:

- **Unknown key.** A reader answers "no such request" (`404`) only after a consistent read
  at the present timestamp (served by the leaseholder) shows the `idempotency` row absent,
  so an intake that committed before the read began, whose `pending` was just sent, is
  never reported missing by a lagging reader. It costs one Nairobi round trip from R2 (est.
  10 ms). A pre-emptive withdrawal (§7.1) is an `idempotency` row, so its key reads
  "withdrawn".
- **Principal context.** A reader re-checks the principal context of every read (tenant,
  and that the key was used by this principal) and answers `NOT_FOUND`, or `409
  key_reuse_other_principal` for a key of another principal of the account, which reveals
  nothing (C05 m5, C10 M4).
- **Headroom reads** are served the same way, at a recorded position (RFC-004 A §A9).
- **Operator reads** (a support operator reading an account's requests and reservations,
  POL-32, X1-S27) carry a **read grant** (RFC-005 §7.6, C4): the reader verifies it by the
  C4 rules and identity's operator check (C15, once per grant, then every 60 s), answers
  only within the grant's one target account, and appends the read to audit (RFC-005 C5)
  before answering; a grant that fails any check, an expired grant or a read outside the
  target is refused and the refusal recorded (C08 §H, C-08). Buyer principals never reach
  this path.

The poll limit (`key_poll_limit`, P2-S67) is enforced exactly by the edge's key-sharded
poll counters (RFC-000 §2, AI4-6), not by the readers; for one window after a shard moves
a key can be answered up to twice its limit.

#### 8.3 The request outcome feed and webhooks

- **Events.** One event per reported outcome, derived from the log: request id, account,
  idempotency key, pseudonymous principal, outcome, reason, decision timestamp (`ts` of the
  deciding entry), for a rejection the counter-offer, the blocking link and the amounts, for
  a confirmation the reservation id. For an expiry the stated time is `D`.
- **Outbox and identity.** The event is an outbox row written in the transaction of the
  entry that makes it reportable (E5, E1′, the ending entry that already records its
  releases, the completing E8, or for a change its deciding E11 or its E12). Its identity
  is (account partition, stream, `stream_seq`) with the writer's (generation, epoch) (C01
  M5), the same on the owner's direct publish and on the changefeed relay, so every
  duplicate is dropped by the consumer (RFC-000 §4.4, §5.5, AI-17-2). The topic is keyed by account
  slot; order is per account partition within it.
- **Event content** (C04 v2.3.1 is the authority). Each event also carries
  `answered_pending` (§8.1) and `withheld_by` (the `action_id` of a withheld termination
  whose entry caused it, §9.4; else null).
- **Report-position markers** (C01 `ReportMarker` as C04 extends it; C01 M6, C04 MM-10,
  MM-11, N-02, N-12). Committed is not yet reported, so the runtime also writes **markers**
  into the same topic, with the `slot` header: (slot, generation 0 in the gate, epoch,
  `reportPosition`), header `report_through`, and C04's `prevReportPosition` (the previous
  marker's position **in the same slot's chain**, from `owner_slot.report_through`; null
  for the first), `pendingAnswered` (the ids of the newly covered requests that were
  answered `pending`) and `chunk`. A marker is carried in the next batch transaction of any
  partition of the slot, or in a marker-only transaction when none comes within 20 ms
  (est.) of the report position passing an unmarked event; a marker-only transaction
  writes only the slot's marker row and reads the epoch, so it runs beside the lane's
  batch, not in it (RFC-000 §3 rev. 4.2). **After an acquisition** (not an `adopt`), the
  first marker lists every covered event above the predecessor's last `report_through` in
  the same slot. A list above 5,000 ids (est.) is split into chunks with the same
  `reportPosition`. Every consumer treats an event as reported only at or below a marker
  of its slot (RFC-000 §4.6); the monotone drop of markers applies only to that gate.
- **Consumers.** The notifier (signed webhooks retried for `webhook_retry`): it sends the
  outcome of **every booking request answered `pending`, a change included**, if and only
  if `answered_pending` is true or the first covering marker lists the request in
  `pendingAnswered`; if that marker cannot be obtained after `gap_timeout`, it sends the
  webhook (POL-04, P2-S09 as amended in v1.11; C04 MM-10, N-01). It sends nothing for an
  event with `withheld_by` set (§9.4). The buyer is *told* once the notice is recorded and
  its first delivery attempted, or, for a notice carried with others in one delivery, once
  that delivery is first attempted (POL-04 as amended in v1.8, P1-S75). Also alerting, and
  the operator console's view of failed requests with reason and leg (P2-S51).

### 9. Reservations and their changes (POL-08)

#### 9.1 The reservation record and its lifecycle

A reservation is created by its booking's E5: id, account, the key or user that booked it,
route legs in order (with each partner leg's booking reference and shown terms), and a list
of **parts**, each with rate, effective window, locked price, age (the `request_age` of the
admission that added it), the admission's request id, and **the principal and key that
added it** (the booking's for the first part; the extension's or increase's for each later
one; revision 4, J-02, D-2). Each part has its **own rate** (as booked, less any decrease) and, at
each minute, a **current rate**: its own rate after the POL-07 cut targets in force that
cover it, composed by `min` per minute, oldest Mbps kept first (§9.7). The reservation's
rate at a minute is the sum of its parts' current rates then. The price of a part at
a minute is its locked price, replaced from each **price step** of the reservation (§9.4)
whose effective minute has been reached, whenever the part was added (RQ3-5).

**Key spending follows the parts** (POL-25 as amended in v1.8, P2-N8; P2-S117). The funds
module counts toward a key's spending the posted charges and holds of the parts that key
added, never another principal's (RFC-004 A, interface point 9). With P2-S117's figures:
key K books an open-ended reservation whose part holds 0.288000 USD, and an administrator
then increases it, adding a part holding 0.144000 USD: K's spending is 0.288000 USD, not
0.432000; the reverse (the administrator books, K increases) gives K 0.144000 USD. A part's
key never changes: a move keeps each part's key with its age (§9.4).

| State | Entered by | Left by |
|---|---|---|
| **Active** | E5 of its booking | E11 that ends it |
| **Active, change in progress** | Head of its change queue admitted as a request | That request's outcome |
| **Active, offer open** | E13 offer made (POL-07) | E13 accepted, declined, lapsed |
| **Ended** (cause: cancelled, cancelled after a cut, revoked, released, terminated, or "ended at its window's end") | E11 with an ending cause, or the **window-end E11** (below) | — |

```mermaid
stateDiagram-v2
    [*] --> Active: E5 confirm of the booking
    Active --> Changing: change at the head of the queue admitted (E1 kind=change)
    Changing --> Active: its outcome (E5 adds a part, or E4/E6/E7)
    Active --> Active: E11 decrease / shorten (not ending) / cut target (POL-07) / move / price step
    Active --> OfferOpen: E13 offer made
    OfferOpen --> Active: E13 accepted with E11 move (future minute) / declined / lapsed
    Active --> Ended: E11 cancel / revoke / release / terminate, or window end
    Changing --> Ended: E11 ending; the pending change fails "reservation ended"
    OfferOpen --> Ended: E11 ending
    Ended --> [*]
```

**The window end** (C04 MM-5, M-07, D-4). The owner arms a timer at each reservation's
window end. In the first batch with `ts` at or after the window end it writes an E11, cause
"window end", effective at the window end, naming any minimum-term fee due (§9.5); the same
entry fails every pending change with "reservation ended" (P2-S80). **While an addition
whose added part starts at the window end is undecided** (a renewal or an extension
admitted before it, P2-S84), that E11 is not written: if the addition is confirmed, nothing
ends and the timer is re-armed at the new end; if not, the E11 is written then, effective at
the old window end. This E11 is one of the three allowed early-effective entries (§9.4).

The **reservation lifecycle feed** (§13; C04) carries every transition with its effective
minute, so rating accrues exactly what was sold (P3-N1) and history can answer "as known at
T" (P1-S33 is RFC-001's for a link; the route-level history is this feed's).

#### 9.2 The change queue

Each reservation has one FIFO **change queue** in the booking module's state:

- A change submission is a booking request (it carries an idempotency key, a deadline and a
  `wait` setting). Its fingerprint under POL-29 as amended in v1.6 is the reservation, the
  kind of change (cancel, shorten, extend, increase, decrease), the new end or new rate,
  and `wait`, from the same principal; the deadline is not part of it (B-RQ-5). A resend
  with the same key and fingerprint is the same change and is applied once; one that
  differs in any of these (another end, another kind, another reservation) is not
  accepted, as a reuse of the key, and the first change is unaffected (P2-S113). A
  withdrawal names the request's own key, so its retries are the same withdrawal (§7.1).
  It is validated at intake (§3.2); a change to part of a route is rejected (P2-S49), a
  decrease the partner's shown terms forbid is rejected (P2-S115), an extension past the
  horizon is invalid (P2-S84).
- **Ending changes are never queued**: a cancellation, or a shortening whose new end is at
  or before the next minute boundary (including an end already past), is decided at once by
  one E11 that ends the reservation from the next minute boundary and, in the same entry,
  ends every queued change and the change in progress with failed, "reservation ended"
  (their holds released, funds released) (P2-S43, P2-S81, P2-S94 first row, P2-S84).
  **Just after a confirmation** (P2-S119): a cancellation or a decrease at 10:00:31 of a
  reservation or increase confirmed at 10:00:30 takes effect from 10:01 on every leg, in
  whatever order the links learn of the two. The E11's `end_leg` or `reduce_parts` waits in
  each leg's queue behind the `convert` of the E5 (§9.8), so no link applies the end before
  the part exists; the part never accrues, because its effective minute and the end are
  both 10:01; and the change is reported only after E12, when every leg has applied it.
- **Every other change** (extension, renewal, making open-ended, rate increase, rate
  decrease, a shortening that does not end it) is appended to the queue in arrival order (the
  order of its E1 in the log) and processed only when it reaches the head; each is decided
  against the reservation as the change before it left it (P2-S79, P2-S94 second row). Its
  legs, holds and added part are those of the reservation when it reaches the head.
- **Funding a queued addition** (revision 4, J-01, D-1). An extension or increase is
  admitted at its intake (POL-25: funds before capacity, in arrival order), but what it adds
  depends on the changes ahead, which may each be confirmed or not. Its E1 therefore records
  `ahead` (the queued changes in front of it, each with its adding key) and its own interval
  and adding key; the funds module sizes the hold on the **envelope**: per minute, the
  largest rate the change could add over every outcome of the changes ahead, taking each
  ahead change as confirmed or not independently (RFC-004 JR-5, JR-6). For an increase of Δ Mbps the envelope is Δ from the next
  boundary to the latest end any outcome leaves; for an extension to `E` it is, from the
  earliest end any outcome leaves to `E`, the largest rate any outcome leaves. `admit` sizes
  the hold on it (interface point 8). At the change's E5 the added part is fixed
  from the reservation as actually left, the funds module binds `R(after) − R(before)` and
  releases the rest of the hold in the same entry. Examples: an extension queued behind an
  increase is held at the increased rate, and released down to the old rate if the
  increase fails (review 18's trace, P2-S70, P4-S66); an extension to 20:00 queued behind a
  shorten to 14:00 is held for [14:00, 20:00) and keeps [18:00, 20:00)'s worth if the
  shorten fails. So no queued addition is ever suspended into, or refused at its head, for
  funds it was admitted with (POL-16 "never by surprise"). The cost is funds tied up for at
  most the change's deadline (60 s), which POL-25 already accepts.
- A suspended account may cancel, shorten or decrease, not extend or increase: the funds
  module's `admit` refuses additions when suspended (rejected, with the resume amount),
  reductions are not checked and are allowed while suspended (RFC-004 A §A5.1; P2-S77,
  P2-S78).

#### 9.3 Each kind of change

| Change | Admission | Entries | At the legs |
|---|---|---|---|
| Cancel; shorten to or before the next boundary (P2-S43, P2-S84) | None (not checked; allowed while suspended) | One E11 (ending), then E12 | `end_leg` at the next boundary on every Share leg; to each partner leg `cancel(reservation, leg, cancelId, changeSeq, reason = buyer_cancel, costBearer = payer_per_terms, or share after a POL-07 cut, effectiveMinute = nb(ts))` (C12 V5); the shown fee charged to the payer of POL-08 |
| Shorten to a later end (P2-S44) | None; **never rejected for partner reasons** (C12 S1, D1) | E11 when at the head, then E12 | `end_leg` at the new end; a new end inside a partner's minimum term incurs its shown minimum-term fee, paid as for a cancellation, recorded as `fee_due` (§9.5); a plain cancellation fee (no minimum term) is never due on such a shorten (POL-08, P3-S63 row 3). Partner leg: with `supportsAmend`, `change(changeSeq, cause = buyer, shorten newEnd)`, which amends the booking that straddles `newEnd` and cancels those wholly after it; without it, `cancel(reason = shortened, effectiveMinute = newEnd, costBearer = payer_per_terms)`, deferred to `newEnd`, and any plain fee the partner charges for it is Share's cost line (POL-23; C12 S1) |
| Decrease (P2-S48) | None; rejected at intake over a partner leg whose shown terms forbid a decrease (P2-S115) | E11 when at the head (Mbps removed last in, first out, from `nb(ts)`, counted on the parts' current rates: the newest part with a current rate above 0 first, §9.7), then E12 | `reduce_parts` on every Share leg with each changed part's rate from `nb(ts)` (§9.7's absolute form, cause decrease); to the partner leg `change(changeSeq, cause = buyer, decrease)` in the same absolute form, newest part first, through the driver's amend (a shown term that allows a decrease implies `supportsAmend`, C12 S1) |
| Extend, renew, make open-ended (P2-S45, P2-S46, P2-S84) | A new admission of the difference: `admit` for the added part's coverage; a quote cited if the terms carry a partner-leg fee (§3.4) | E1 (kind change), holds for `[old end, new end)` at the reservation's rate on every leg, then E5 adding a part, or an ending entry leaving the reservation as it was | Hold, then convert with the new part's id; a partner leg gets its own `hold` then `confirm` (or `book_final`) with `reservation` set, as a request of its own, a separate partner booking in the leg's booking set (C12 S1, F3; §10) |
| Increase (P2-S47, P2-S74) | As extension, for `[next boundary, end)` at the difference in rate | As extension | As extension |

- The added part is priced at the price in force when the change is made, and from any
  recorded price step on (RQ3-5); existing parts keep theirs (POL-27); the funds hold grows
  by the added coverage (P2-S75, P2-S76 are the funds module's refusals), counted to the key
  that added the part (§9.1).
- A change that adds is a request in its own right: it waits, yields, commits and expires
  exactly as a booking, with its own deadline and age (P1-S46: each added part has its own
  age). A rejected or failed addition leaves the reservation unchanged (P2-S46, P2-S74,
  P2-S83).
- **Changes that free capacity are reported once their leg changes are durable** (E12),
  as non-confirmed outcomes are (RQ-6 applied to changes), so a buyer who reads the
  cancellation finds the capacity free from the stated minute on every Share leg (P2-S43,
  P2-S48).
- **A cancellation over a partner leg takes effect for the buyer whatever the partner
  answers** (P2-S82): E11 ends the reservation and its charges at the next boundary; the
  adapter keeps cancelling until the partner confirms and reconciles its record.

#### 9.4 Share-initiated ends and changes

These come through the **reservation command port** (§13), the catalogue feed, or a funds
effect. Each is one E11 (or E13), decided at once in the account owner's order. Effect on
the change queue (revision 4, J-15; POL-08: changes are decided against the reservation as
left):

- an E11 that **ends** the reservation fails the change in progress and every queued
  change with "reservation ended", in the same entry (P2-S80);
- a **cut** (POL-07) or a **price step** fails nothing: the change in progress continues
  (its holds are on legs the reservation keeps) and queued changes stay queued, each
  decided at the head against the reservation as then left (an increase, for example, is
  then sized and checked on the reduced rate);
- a **move** fails only a change in progress whose holds are on legs the move removes
  ("reservation changed by Share", its holds and funds released as for any non-confirmed
  outcome, §5.7); queued changes stay queued and take the new path's legs at the head.

**When the entry is written** (revision 4, J-07, D-3; RFC-000 §4.5, AI-17-3). A cause whose
effective minute is known in advance (a move at its chosen minute once final, a price step)
is recorded **when it becomes known**, with that future effective minute; the lifecycle feed's
effective-time closure (§13.1) then holds, since no entry carries an effective minute
before its `ts`. If the owner reaches such a cause late (it was unavailable, or a move became final after
its chosen minute), it uses `nb(ts)`, records the delay (`delay_min`) in the E11 and
alerts. There are **three allowed early-effective exceptions** (C04 M-06, RFC-000 revision
4.5 AI-43-2): a POL-07 cut, which the link decides at or after `T_eff` and which is
effective at `T_eff` (rating holds the reservation's closure while the reduction is open,
RFC-000 §4.5 (2), RFC-003); `ended(revoked)` written in such a cut's E11; and the window-end
E11, effective at the window end (§9.1).

| Cause | Source | What the account owner does |
|---|---|---|
| Revocation or reduction (POL-07): a **cut target** | RFC-001 through the reservation command port: `cut_target(link, reduction, reservation, revision, parts, [(from, r)…] \| none, offer?)` (C02; RFC-000 §8 rev. 4.5): the reservation's rate on the link after the link's per-part cuts, as minute pieces from `T_eff` (each piece from its minute until the next; r = 0 from a minute revokes from it), `none` for no cut; `parts` the parts that rate accounts for; `offer` when the cut is of an open offer's parts on the link (D5). One per (link, reduction, reservation) and revision, a later lower revision possible (JI-5) | §9.7: E11 cause "cut" naming (link, reduction) and the revision, effective `T_eff`, recording the pieces; composed with every other target in force by `min` per minute, oldest Mbps kept first; each changed part's rate sent to **every** leg as absolute minute pieces naming the (link, reduction) pairs applied; a target from a link the reservation left by `T_eff` is recorded and not applied; an offer-scoped target is kept against the offer and applied only if the move becomes final (§9.6); the answer tells the link whether and by which change it was applied. A `none` target removes nothing; its E11 is still written, so the lifecycle feed carries it and rating can close the reservation's minutes past `T_eff` (RFC-000 §4.5 (2)). Holder told, and told it may cancel without fee if its rate was cut (POL-08); Share pays any shown fee (P2-S05) |
| Equivalent-path offer and move (POL-07, RQ-4) | The reduction's affected set on the link schedule feed (`REDUCTION_AFFECTED`: a newly affected holder is offered a path at once, RFC-001 §5.4); equivalent paths from routing, each a **catalogue route with split weights** (all-Share paths first; RFC-002 is the source's only consumer, AI-R1-5, AI-19-2); a candidate that is not a catalogue route with split weights at the catalogue's current version is **refused** (not offered, alerted), and the next candidate is tried | §9.6: E13 *prepared*, `offer_hold` with the offer parts and their original ages on every new Share leg, E13 *made* once every offer hold is acknowledged, then the offer to the holder (P1-S31, P1-S55, P1-S58, P1-S59). **Accept**: E13 *accepted*; on an all-Share path the move is final at once; with a partner leg it is final only once the partner leg is booked (D4, P1-S60). **Only when final**: E13 *final* and, in the same entry, E11 move (catalogue route ID and shown price, `move_at` ≥ `nb(ts)`, each part keeping its age and key, P1-S35, P1-S53, P1-S71), then `offer_accept(offer, move_at)` on the new Share legs and `end_leg` from `move_at`, cause move, on the old ones. **Partner booking fails**: E13 *failed*, as declined: `offer_release` at once, the old legs untouched (the cut target then removes only the affected Mbps, P1-S52's decline row), any other path offered (P1-S61). **Decline or lapse**: `offer_release` at once (P1-S57). Every offer command carries the decision time (AI-R1-7) |
| Release after grace (POL-16) | F7 funds tick, grace ended, with `release_due` (§2.3) | In the F7 entry, one E11 per listed reservation, cause "released", effective `nb(ts)`, every pending change failed; the fees POL-08 makes due for a cancellation at that minute (the plain fee, and a minimum-term fee only if the minute is before `term_end`), paid by the buyer (P4-S23, P4-S97; C04 N-06). `delay_min` = `nb(ts)` − `nb(grace_end)` in whole minutes, alerted when above 0 (C04 MM-4, m-01). `ended(released)` is the only release notice (C04 MM-9) |
| Termination (POL-30) | `terminate` on the reservation command port (C04 "Reservation command port: `terminate`"): the operator console's envelope (role, reason, approver; for a legal-order termination by compliance, optionally `withhold_notice` with the order's reference, approved with the termination, X1-S36), with identity `"<account>/<action_id>"` | The owner evaluates inside the batch transaction at `ts`, in C04's order: (0) the identity must equal the one computed from the envelope, else `REFUSED(digest)`, nothing recorded; (1) **identity lookup before any check**: a recorded identity gets its recorded answer if the RFC-005 digest is equal, else `REFUSED(digest)`; (2) RFC-005 §7.4 checks 1 to 5 (digest, action type, role and reason code allowed, X1-S16; assertions; identity's operator check C15; four eyes for compliance; `ts` ≤ `not_after − ε`); a check that has no result because identity does not answer gives `UNAVAILABLE` and records nothing (C04 N-10); (3) existence and activity: `REFUSED(unknown_reservation)` or `NOT_ACTIVE`, never before step 2 passes; (4) check 6: `target_version` equals the `Seq` of the reservation's last entry that changed its parts, rates, window or legs (its confirming E5, an addition's E5, or such an E11; not a cut E11 that changes nothing, a price step, E13 or E14; C04 N-04). Every refusal and `NOT_ACTIVE` is recorded in an **E15** (audit only), so a retry gets the same answer; a retry after `not_after` gets the recorded answer, or a recorded `REFUSED(not_after)` (C04 N-08). **On success**: one E11, cause "terminated", effective `nb(ts)`, recording the audit fields, the identity, `withhold_notice` and the order reference; in the same entry every pending and queued change fails "reservation ended" (P2-S80) and an Accepted offer fails; the fees POL-08 makes due for a cancellation at that minute are due, paid by the buyer (C04 N-06); the answer `TERMINATED`. **The notice**: `notice = "withheld"` only for the compliance termination action, by the compliance role with a compliance approver, reason `legal_order`, `order_ref` present and `withhold_notice` set. Then **every event that entry causes carries `withheld_by` = its `action_id`**: `ended`, `offer_failed`, `pol28_residue`, and the outcome events of the requests it fails, even when a later E8 or E12 writes them; the notifier sends no notice and no webhook for any of them, and a status read by the holder still gives the true state (POL-30 as amended in v1.11, X1-S36 row 2; C04 M-04, MM-8). Any other envelope with `withhold_notice` still terminates, with `notice = "withhold_refused"`, and the holder is told within `affected_notice_time` (X1-S36 row 1). The port has no withhold command: a later request to withhold is refused at the console (RFC-005), and the holder is told (X1-S36 row 3) |
| Partner leg affected (POL-28) | `partner_leg_affected(reservation, leg, partner link, delivered, event identity)` from the adapter on the **reservation command port** (C12 m12, D5): the partner lacks the booking (`delivered = null`), or has it only in part (PARTNER_SHORT: the partner's `{rate, window}`) | E14 with `delivered`, idempotent by (reservation, leg, partner link), less delivered capacity replacing the record; the **missing part** (what the reservation has on the leg, less what was delivered: for P2-S91 row 3, 1 Mbps for [10:00, 11:00) and 4 Mbps for [11:00, 12:00)) is treated as affected by an unplanned outage on that leg (POL-07, POL-28 as amended in v1.11); holder told; the lifecycle event `partner_leg_affected` carries `delivered`, so rating charges only what was delivered (P2-S91) |
| Price change (POL-27) | Catalogue: a new price for an open-ended reservation's route, announced `price_notice` before it takes effect; the catalogue's price-change event (Kafka) names the route, price version and effective minute | **At the announcement** (revision 4, J-04, J-07, D-3; RFC-004 JR-4), **one entry per (account, price version)**: F11 (the notice: new price, the hold each reservation will need and, if headroom would not cover it, the top-up that would, P4-S108) and, in the same entry, **one** E11 cause "price change" listing every affected open-ended reservation of the account and recording their **price step** (version, effective minute), carrying `PriceTookEffect` per reservation; idempotent by (account, price version), so a redelivered event is a no-op. A product-wide change therefore writes about one entry per account, not per reservation (RFC-004 R4-A6). The step re-prices **every part** from that minute, parts added after the announcement included (RQ3-5, P3-S64); at the effective minute the funds module's F7 *price effective* grows the hold, and suspends the account as for a failed roll-forward if headroom cannot cover it (P4-S101). An open-ended booking made after the announcement shows the announced change and records the step in its E1 and E5 (§3.2). Fixed-end reservations keep their locked prices |

#### 9.5 Fees shown and who ended

Every E11 records its cause and, under POL-08 as amended in v1.8, whether a shown fee
becomes due and who pays it. A **plain cancellation fee** is due only on a cancellation
(including a shorten to or before the next boundary, which is one); a **minimum-term fee**
is due on a cancellation inside the term, on a shorten whose new end falls inside it
(P3-S63), and when the reservation ends at its booked window's end, as last changed, inside
the term (the fee shown on the offer before booking, P3-S74; the reservation record carries
it from E1 and E5 as the fee's kind and its due-at-window-end flag, and the lifecycle feed's
end event, cause "ended at its window's end", names it). The buyer pays on its
own cancellation or shorten, on a booked window ending inside the term, on release after
grace and on termination; Share pays on revocation, on a cancellation after a POL-07 cut,
for a fee not shown, and on any partner booking left without Share's confirmation. A fee is
due at most once per reservation and leg: an extension past the term avoids the window-end
fee, and a shorten into the term is charged instead of it, never twice. The entry that makes
a fee due records it, so the funds module stops holding the fee part from then (RFC-004 A,
J-09). The reservation lifecycle feed carries cause, fee and payer, so rating charges a shown
fee once, as its own line, and only if shown (P3-S11, P3-S43, P3-S44, P3-S60, P3-S63,
P3-S74 are RFC-003's). If a partner nonetheless charges Share for a shorten its shown terms
do not make a fee, Share bears it as a cost line (POL-23).

**Rules from C04** (MM-2, M-03, N-05 … N-07) and C12 (S1, V5):

- **Fee identity.** `fee_id = "<reservation>/<path>/<leg index>"`, `path` `0` for the
  booked path and the offer id after a move. A leg has **at most one shown fee**, and a
  minimum term is charged as its cancellation fee.
- **Termination and release.** These make due only the fees that POL-08 makes due for a
  cancellation at their effective minute: the plain fee, and a minimum-term fee only if
  that minute is before `term_end`.
- **Cancel after a cut.** A buyer cancel before a later `ended(revoked)` is allowed. It
  writes `ended(cancelled_after_cut)`, paid by Share; the later revocation writes a second
  `ended`, and accrual stops at the least effective minute.
- **A move.** The move's E11 records the old partner leg's fees due at `move_at`, paid by
  Share, and the lifecycle event `moved` carries them.
- **A shorten without amend.** A shorten to a later end over a partner leg without
  `supportsAmend` is a partner cancel deferred to the new end; the buyer pays only a
  minimum-term fee shown at booking that the new end falls inside, and Share bears any
  plain fee the partner charges for it, as a cost line (C12 S1, V5).
- **Payer.** Every fee due carries its payer, so the funds module never drains a buyer's
  hold for a fee Share pays (C04 m-09).

**POL-28 residue.** A partner booking cancelled at Share's cost because its request was
withdrawn, expired or failed, or because its offer failed, is published on the same feed as
a `pol28_residue` event (RFC-000 §8, AI3-4): from the deciding entry (E4, E6, E7, or the E13
*failed*) with `found_by: "decision"`, or from an **E16** when the adapter finds the booking
later, with `found_by` `late_answer` or `reconciliation` (C04 m-11). The adapter alone
cancels a residue (C12 F6).

#### 9.6 Equivalent-path offers and moves (POL-07 steps 3 to 7; D4, D5, JI-3, JI-4, JI-7)

An offer is the account owner's: it chooses the path, takes the offer holds, asks the
holder, books any partner leg at acceptance, and decides the move. The links hold, accept
and release the offer parts on its word (RFC-001 §5.6).

| State (E13) | Entered by | Sent after commit | Next |
|---|---|---|---|
| **Prepared** | `REDUCTION_AFFECTED` names the reservation (or a failed or released offer leaves it affected) and routing gives a candidate that is a catalogue route with split weights | `offer_hold(offer, reservation, account, offer parts, from, lapse_at, decision time)` on every Share leg of the path that is **not** already a leg of the reservation; the offer parts are the reservation's parts `[(part, current rate at from, original age, end)]` (§9.7), so the offer is for the whole reservation at its rate (POL-07 step 3) | Made; or Refused (an offer hold `REFUSED(NO_FIT \| IN_FLIGHT \| TOMBSTONED)`, or `UNKNOWN_LINK`, `LINK_CLOSING` or `LINK_RETIRED` for a link being retired, which an offer never uses, POL-07 as amended in v1.11, C02 M-2: `offer_release` to **every** leg that got `offer_hold`, held or not, next candidate) |
| **Made** | Every offer hold acknowledged | The lifecycle event `offer_made`, from which the notifier tells the holder: route, shown price (the lower of the original and the path's), `offer_window` end, and, with a partner leg, that it is confirmed only at acceptance (P1-S59) | Accepted, Declined, Lapsed |
| **Accepted** | The holder's acceptance (requested move minute `m_req`: the notice end `T_eff` of the reduction that caused the offer, or an earlier boundary it chose) | With a partner leg: the partner booking (below). Nothing to any Share link | Final, Failed |
| **Final** | All-Share path: in the acceptance's own entry. Partner leg: the partner's booking confirmed | **In the same entry**, E11 move, `move_at = max(m_req, nb(ts))` (a later minute than `m_req` recorded as a delay and the holder told); then `offer_accept(offer, move_at)` to every new Share leg, `end_leg(reservation, leg, change, from move_at, cause move)` to every old Share leg the new path does not keep, and the partner cancellation of any old partner leg per its shown terms at Share's cost | — (an earlier boundary chosen later: a further E11, `offer_move_at(offer, T)` and `end_leg` from `T`, `T ≥ nb(ts)`) |
| **Failed** | The partner booking at acceptance refused, faulted, or not confirmed by its deadline; or the reservation ended while Accepted | `offer_release(offer)` at once on every Share leg that got `offer_hold`; partner hold released, or a partner booking made cancelled at Share's cost (POL-28 residue, §9.5); the holder told; any other equivalent path still available offered as a new offer (P1-S61) | — |
| **Declined**, **Lapsed** | The holder's answer; `offer_window` passing (a timer, §6.1) | `offer_release(offer)` at once to every Share leg that got `offer_hold` (P1-S57; C02 review 42 M4) | — |

Each E13 state writes its lifecycle event: `offer_made`, `offer_accepted`,
`offer_declined`, `offer_lapsed`, `offer_failed` (C04 MM-7); there is no separate notices
feed. **The holder answers through the booking API** (C10 M3, D8): offer read, accept,
decline and move-earlier, in the **offer-answer family**, idempotent by key with the
fingerprint (offer, answer, `move_from`), outside `ack_budget`, counted as submissions for
the rate limits (reads toward `key_poll_limit`); any principal of the account that may
change the reservation may answer (probe keys only for probe reservations). Accept needs
the offer Made and not past `lapses_at`; `move_from` must be a minute boundary not after
the notice end, else `422`. An answer to an offer in a terminal state has no effect and
returns its status.

```mermaid
stateDiagram-v2
    [*] --> Prepared: affected (REDUCTION_AFFECTED), candidate path
    Prepared --> Made: every offer_hold acknowledged
    Prepared --> [*]: an offer_hold refused: offer_release, next candidate
    Made --> Accepted: holder accepts (m_req)
    Made --> Declined: holder declines
    Made --> Lapsed: offer_window ends
    Accepted --> Final: all-Share path, same entry
    Accepted --> Final: partner leg booked (E13 final + E11 move)
    Accepted --> Failed: partner booking fails, or reservation ended
    Final --> [*]: offer_accept on new legs, end_leg on old legs from move_at
    Failed --> [*]: offer_release; next path offered
    Declined --> [*]: offer_release
    Lapsed --> [*]: offer_release
```

**The move is final only once every new leg is booked** (review 26 D4, JI-3). The Share legs
of the path are already firm (the offer holds count as committed, P1-S55, P1-S56); a partner
leg is booked at acceptance. Until the move is final the old legs are not touched, so a
failed partner booking leaves the reservation exactly where it was: the reduction's cut
target then removes only the affected Mbps, as for a declined offer (P1-S61; with P1-S52's
partial cut, B keeps 2 Mbps on the link). No link command ever has to undo an `end_leg`.

**The partner booking at acceptance** goes through the partner port as a request of its
own, identified by (reservation, offer) (partner keys §10.7): `request_age` the
reservation's oldest part's age (Share's waiter queue at the partner, §10.5), `D` = the
acceptance's `ts` + `move_deadline` (a design parameter, default 60 s = `route_deadline_max`,
est.), `D_c = D − commit_margin`; a partner with holds is held then confirmed (§5.5 steps 3
and 4: journaled before the call, only before `D_c − σ_p`), a partner without holds booked
final. No funds hold is taken: the buyer pays no more than the original price (POL-07 step
4). Confirmed → Final; refused, partner fault or past its fence → Failed; a booking found
later for a Failed offer is cancelled at Share's cost (§10.4). While Accepted, the holder
may still cancel the reservation (the E11 ending it moves the offer to Failed, a partner
booking already made being cancelled at Share's cost) or choose an earlier move minute
(recorded in E13 and used at Final).

**`move_at` and the link's check** (JI-7). The account owner never decides a move before
`nb(ts)` of the entry that makes it final, and every offer command carries that decision
time. Interface point for RFC-001: the link checks `move_at ≥ nb(decision time)` (and for
`offer_move_at`, `nb(decision time) ≤ T < move_at`) against the carried decision time, not
its own apply time, and applies an `offer_accept` or `offer_move_at` that reaches it after
`move_at` (it was failing over) as decided, as §4.5 of RFC-001 does for leg changes: the net
occupancy of the offer parts is unchanged by an acceptance, so nothing is sold twice, and
known-at history dates it by its decision time.

**Cuts and the move** (D5, JI-4). A cut target for an **offer's parts** on a path link M
(an offer-scoped target, §9.7) binds only the move: it is recorded in E13 against the
offer and the holder is told what the path will carry from M's `T_eff`; on Final it is
applied in the move's E11 to the moved parts from `max(T_eff, move_at)`, naming (M,
reduction); on Declined, Lapsed or Failed it is dropped (the link's `offer_release` ends
the offer parts and their cut). A cut target from a link the reservation **left by its
`T_eff`** (a Final move with `move_at ≤ T_eff`) is recorded and not applied (§9.7). A move
that becomes Final **after** a reduction's `T_eff` on the old link (an offer made in the last
`offer_window` of the notice, or accepted after the notice ended) finds that reduction's
target already applied: the targets applied before the move keep binding the parts they
cover, so the reservation moves at its current rate, and the move's E11 also sends the new
Share legs `reduce_parts` bringing the offer parts down to those rates from `move_at`,
naming the binding (link, reduction) pairs (a plain change on links that did not decide
them). **Each such `reduce_parts` goes only after the `ACCEPTED` reply to that leg's
`offer_accept`**, in the leg's queue (§9.8; C02 review 42 M3). This is POL-07 step 6 as
amended in `requirements-v1.10` (B-RQ-11 decided, P1-S84): a move final after the cut
carries the reservation at its cut rate, and Share-leg capacity held beyond it is released
at the move. **The holder is told at acceptance**: once the reduction's cut applies to the
move, every offer status answer, `accepted` or `final`, carries `cut_kept` (the rate the
cut left, and that an increase may be booked on the path as a new admission, POL-08; C10
M6). A move final by the notice's end moves at the full rate.

**An offer-scoped target that arrives after the offer is Final**, with the link on the new
path, is not kept for the offer: it is applied as a **normal cut** from `max(T_eff,
move_at)`, with an E11 cause "cut" and the lifecycle event `cut`, for any `move_at` (C02
V52-2, review 54 M5; C04 N-03). On an offer not yet Final it is kept (`KEPT_FOR_OFFER`,
event `offer_cut_kept`); on an offer that ended without a move to the link it is answered
`NOT_APPLIED(ended)` and writes no lifecycle event.

#### 9.7 Cut targets: recording, composition and leg changes (POL-07; AI-26-2, AI-26-3; D3, D5, JI-4, JI-5)

**Input** (C02 "Reservation command port: `cut_target`" is the authority).
`cut_target(link, reduction, reservation, revision, parts, pieces | none, offer?)`, where
`pieces = [(from_1, r_1), …]` with `from_1 = T_eff`, each `r_i` the Mbps the reservation keeps
on that link over `[from_i, from_{i+1})` (the last to the reservation's end), `parts` the
parts of the reservation the link's rate accounts for (those it held at its deciding
entry), and `offer` present when the parts are an open offer's on the link. Carried with
C01's `CommandEnvelope` (the link's generation and epoch) and the reservation's account
partition. The **covered parts** (B-AI-13, resolved in RFC-000 revision 4.4) keep a part
converted at the link after its deciding entry, admitted against the reduced capacity and
so never needing a cut, from being capped by a rate that did not count it.

**Revisions** (C02 C4-2, R39-01, V52-1; C03 rule 3; C04 MM-3). The revision increases for
each key (link, reduction, reservation) and can only lower the target. **Revision 1 sets
the covered parts**; a revision of 2 or more has the same parts less the ended parts, and
never adds one; a revision that adds a part is answered `MISMATCH`, alerted, and counts as
the recorded answer for `REDUCTION_FINAL` (C02 review 54 M4, m7). The reply echoes the
revision and carries `recordedRevision`.

**Recording** (one E11 cause "cut" per revision above the highest recorded, effective
`T_eff`):

| Case | E11 records | Reply to the link (the synchronous reply to `cut_target`, given once the E11 or E13 commits; C02 C4-1) |
|---|---|---|
| First revision for the key, the reservation on the link at `T_eff` | The pieces, parts and revision; the composition below; the leg changes it sends | `APPLIED(change ids)`, or `APPLIED(none)` when it changes no part's rate (a `none` target, or one the other targets already bound) |
| A repeat of a recorded (key, revision) | Nothing (no entry, no `cut`) | The recorded reply again |
| A lower revision that was never recorded | Nothing (no entry, no `cut`); it never supersedes | The highest recorded revision's reply, echoing its own revision |
| A revision above the highest recorded (RFC-001's `REDUCTION_SET_EXTENDED`, JI-5) | Always one E11 and one lifecycle `cut`, also with the same content (`part_rates: []`); the recorded pieces become the per-minute `min` of the old and new; a new piece **above** the recorded one at any minute is ignored there and alerted (a final step never cuts less than it decided) | As for a first revision |
| The reservation ended at or before `T_eff` | The target, "not applied: ended" | `NOT_APPLIED(ended)`: the link withdraws its decided removal (RFC-001 R26-01 (i)) |
| The reservation **left the link by `T_eff`** (a Final move with `move_at ≤ T_eff` and the link not on the new path) | The target, "not applied: left the link" | `NOT_APPLIED(left_link)` |
| Offer-scoped (`offer` set), the offer not yet Final | Recorded in E13 against the offer (§9.6), lifecycle event `offer_cut_kept`; the holder told | `KEPT_FOR_OFFER(offer)`; later the move's leg changes name (link, reduction), or `offer_release` ends it |
| Offer-scoped, the offer **Final** with this link on the new path, any `move_at` | E11 cause "cut", binding the moved parts from `max(T_eff, move_at)`; lifecycle event `cut` (C02 V52-2, review 54 M5; C04 N-03) | `APPLIED(change ids \| none)` |
| Offer-scoped, the offer ended without a move to this link | Nothing; no lifecycle event | `NOT_APPLIED(ended)` |
| Unknown reservation | Nothing | `NOT_APPLIED(unknown)`, alerted |

A reservation that ends after `T_eff` is cut for `[T_eff, end)`; one moved after `T_eff`
keeps the cut (§9.6).

**Composition** (deterministic function of the set of targets in force, so independent of
the order they arrive in; review 26 D3, RFC-000 AI-26-2). The targets in force are the
applied ones; each binds only its covered parts.

```
compose(reservation):
  K = targets in force: (cap_k(t) from pieces, ∞ before T_eff_k; covered parts P_k)
  B = sorted union of every piece start, every T_eff_k, every part's start and end
  for each interval [b_i, b_{i+1}) of B:
      used_k = 0 for every k
      for each part p in force at b_i, oldest first (age, then part id):
          room = min over k with p ∈ P_k of (cap_k(b_i) − used_k)   (∞ if none)
          cur_p = max(0, min(own_p, room))
          for each k with p ∈ P_k: used_k += cur_p
  return, per part, cur_p as minute pieces (adjacent equal pieces merged)
```

- *Exact for one target*: when one link's target covers every part, the sum of `cur_p` at
  each minute is the link's rate there, minute by minute; nothing more is removed than the
  link decided (P1-N8: "never beyond what the reduced capacity requires", review 26 R26-04).
  Which part carries a removed Mbps follows newest-first per minute (POL-07 step 2).
- *Min per minute* across links and reductions (RQ-17-1: capacity in force is the least of
  every level; a route has one rate on every leg).
- *Monotone*: adding a target, or lowering one, never raises any `cur_p`, so the leg changes
  only ever lower occupancy and no link has to give capacity back.
- *Decreases and additions*: a buyer's decrease lowers own rates last in, first out,
  counted on current rates (the newest part with a current rate above 0 first, §9.3); a part
  added after a target (an increase admitted against the reduced capacity) is not covered
  by it and not capped by it.
- *Cost*: `O(|B| × parts × targets)` per reservation, typically a few pieces, a few parts
  and one target: microseconds, in the batch transaction (est.).

**Leg changes** (RFC-000 AI-26-3; interface point B-AI-13). For every part whose
current-rate pieces changed, from the earliest changed minute `m0` (`T_eff` of the target,
or `nb(ts)` for a decrease), the E11 sends to **every** Share leg of the reservation's path
at those minutes, the link that sent the target included:

- `reduce_parts(reservation, leg, change id, cause, [(part, [(from, rate)…])], decision
  time, applies)`: each named part's **rate** on the leg as absolute minute pieces from
  `m0`, superseding, from `m0` on, any rate earlier sent for it; `cause` POL-07 (or
  decrease); `applies` = every (link, reduction) whose target the composition includes at
  those minutes. The link withdraws its decided-but-unapplied removal for each of its own
  (link, reduction) pairs named, and sets the parts' rates; a pair of another link is a
  plain change for it.
- `end_leg(reservation, leg, change id, from m, cause POL07, applies)` when every part's
  current rate is 0 from a minute `m` to the reservation's end: a revocation is a cut to 0,
  with the one cause `POL07` (C02 M-3); the same E11 writes the lifecycle event
  `ended(revoked)` (C04 MM-12). `applies` names every applied (link, reduction), and is
  present only for cause `POL07` (C02 C4-4).
- **A partner leg.** A cut on a Share leg also sends `change(changeSeq, cause = cut)` to a
  partner leg of the route whose driver has `supportsAmend`, which lowers Share's cost;
  without it nothing is sent and Share keeps paying for the partner capacity (POL-07,
  POL-23; C12 m8).
- **Ordering and idempotency.** The change id is the E11's (account partition, sequence).
  Each leg command goes in its leg's queue (§9.8): one outstanding command per
  (reservation, leg), in the order of the deciding entries. The link keeps the reply of
  every change id it applied; a repeat gets its recorded reply; only a lower id that the
  link never applied gets `STALE_CHANGE`, which counts as answered (C02 C4-3). Because the
  rates are absolute, a lost, repeated or reordered command never leaves a leg at a rate
  the composition did not give. E12 records every leg's answer; a cut is not a buyer's
  request, so E12 gates nothing reportable, and the link keeps counting its decided
  removal until the matching change arrives, so a slow leg change never oversells.

**Feeds.** The E11's lifecycle event `cut` carries (link, reduction), **`target_revision`**,
the target as minute pieces or `none`, whether it was applied (and why not), and the
resulting part rates as minute pieces (C04 MM-3; C03 M2), so rating can close the
reservation's minutes past `T_eff` once it holds `REDUCTION_FINAL` and the `cut` of the
highest revision decided before it (RFC-000 §4.5 (2)). A `cut` that covers minutes already
closed is amended late by rating with reason "late POL-07 cut" (C04 V61-6; RFC-003).

**Sizing** (est.). A deep reduction on the hottest link (RFC-001 §9: up to about 10 M parts)
may cut about 1 M reservations; RFC-001 decides them in steps over about a minute, so about
17,000 cut E11s a second spread over the 16,384 account slots (about one per slot a second,
well inside the lane), and about 25,000 leg commands a second (about 1.5 Share legs per
reservation), some 17,000 of them to the reduced link. The owner coalesces leg commands per
destination link and owner process into one gRPC call of up to 500 commands (est.), each
keeping its own change id, and paces them by the link's acknowledgements, so the link
applies them at its own batch rate (minutes for the whole set, est.); nothing waits on
them but E12 (Risk RB-21).

#### 9.8 Leg-command sequencing (C02 C4-3, review 42 D1, review 54 D1 and D2, V61-1; P2-S119)

**One outstanding command per (reservation, leg).** For each Share leg of a reservation
the owner keeps a FIFO queue of the commands `convert`, `offer_accept`, `offer_move_at`,
`end_leg` and `reduce_parts`, ordered by the sequence of their **deciding entries**: a
`convert` at the position of its E5 (`createdBy`), an `offer_accept` at that of its E13
*final*, and `end_leg`, `reduce_parts` and `offer_move_at` at their change id (the E11's
sequence). Only the head of a queue is in flight. In one gRPC call (up to 500 commands,
est., §9.7 sizing) the owner never puts two commands for one leg.

**Replies** (C02 "Leg-command replies"). Each reply is in one of two groups:

| Reply | Group | What the owner does |
|---|---|---|
| `CONVERTED`, `ACCEPTED`, `CHANGED`, `MOVED` | Answered | Records it; counts it for E12 (a leg change); sends the next command of the leg |
| `STALE_CHANGE` | Answered | Counts it for E12; does not send it again; logs it without a page if a takeover of the partition occurred since its first send, else alerts it as a protocol defect |
| `UNKNOWN_RESERVATION`, `UNKNOWN_PART`, `UNKNOWN_REDUCTION`, `UNKNOWN_OFFER`, `NO_HOLD`, `TOMBSTONED`, `INVALID`, `INVALID(applies)`, `MISMATCH` | Answered | Alerts it as a protocol defect with the leg and the change id; counts it for E12; does not send it again |
| `UNKNOWN_LINK`, `LINK_RETIRED` | Answered | Alerts it as a violation (a link is retired only when nothing is on it); counts it for E12 |
| C01 `RoutingRefusal` `STALE_EPOCH`, `NOT_OWNER`, `MOVED`, `MOVING`, `STOPPED`, `OVERLOADED`, `UNAVAILABLE`, or no reply | Retry | Refreshes the placement cache if necessary and sends the same command again with the same identity |
| `STALE_SENDER(recorded)` | Neither | By C01 D4 (§2.5): deposed, so it stops serving the slot and the new holder sends again; or, with a higher recorded generation, the command is dropped |

So no queue stalls. **After a takeover or an `adopt`**, the new holder rebuilds each leg's
queue from its log (the *conversions pending* and *leg changes pending* queries, a pending
`offer_accept`) and sends the pending commands again **in the same order**, the sequence
of their deciding entries (V61-1).

**Why it is needed** (C02's traces). A leg command names only the parts it creates or
changes, from its own first minute, so a higher change id does not contain what a lower
one set; an overtaken command would be lost. With the queue: a cancel just after a confirm
(P2-S43, P2-S119) makes `end_leg(from nb(ts))` wait for `CONVERTED`, so the link ends the
new part at the stated minute on every leg, whatever the order in which the links learn of
the two; an extension then a shorten (P2-S44, P2-S94 row 2) ends the extension's part too;
a shorten then an extension (E11 at sequence 100, E5 at 105) leaves the new part held,
because the link clips a `convert` only when an applied `end_leg` has a change id above its
`createdBy` (and alerts `CONVERT_AFTER_END`); an increase then a decrease (P2-S119 row 2)
leaves the added Mbps free from `nb(ts)` on every leg.

**Cost** (est.). One round trip per command per leg in series, about 5 to 10 ms within the
region; a reservation has few commands per leg, so the wait is only between two decisions
on the same reservation within milliseconds of each other. A deep reduction's fan-out
(§9.7) queues one cut per reservation, so the series costs nothing there.

### 10. Partner adapters

#### 10.1 State and log

One adapter **per partner link**, a single-writer state machine whose log is the partner
link's partition of the insert-only adapter log table (2 + 2 + 1), appended by the NestJS
instance holding the adapter slot's owner lease in epoch-conditional batch transactions,
exactly as §2.5 for the account log (RFC-000 §5.2, §5.5), with a per-partner **driver**
that speaks the partner's API. Its state, all in its log:

| State | Content |
|---|---|
| Classification | From the catalogue's partner terms and an onboarding test (C12 §3.2, F11, D6): *with holds* only if all of these hold: holds last at least `route_deadline_max` + `commit_margin` (70 s); the partner accepts an absolute expiry set by Share; `expiryGranularityMs + partnerClockBoundMs + transitMs ≤ commit_margin − τ − 1 s`; `σ_p ≤ σ_p_max` (500 ms, est.); otherwise *without holds* (POL-26, P2-S36, P2-S102). `σ_p ≤ σ_p_max` is a **listing condition** for every partner (V7). `decreaseAllowed` is the commercial term, the source of record; onboarding fails if it allows a decrease that the driver cannot amend (m13). Versioned by `termsVersion`, with `effectiveFrom`; a change applies to new requests only |
| Per request (outstanding) | Request id (or, for a partner booking at an offer's acceptance, (reservation, offer), §9.6), account partition, leg window and rate, `D`, `request_age`, `D_c`, `wait`, attempt, partner keys, status (§10.3), the partner's booking reference, and the time each confirm or final booking was sent |
| Sender high-water (C12 F7, D3) | The highest account-owner (generation, epoch) **per account partition**, updated by every accepted command and by J7 |
| Booking sets (C12 F3) | Per (reservation, leg): {(part, partner booking reference, window, rate)}; the original booking and each addition are separate partner bookings, joined on `outcome_confirmed` |
| Scheduled cancels (C12 F4) | Per partner booking reference, one J5 with its effective minute and its timer, re-armed on takeover and on `adopt` |
| Waiter queue | Share requests refused because of Share's own position, by `priority_rule`, each with its `D`, `D_c`, the blocking requests and their windows |
| Tombstones | One per request released, refused or cancelled, kept until `D` + `release_grace` (as a link owner's, A9) |
| Call journal | Every partner call: intent (operation, partner key, account-owner epoch, send time) before the call, and result after it |
| Reconciliation | Per-call reconciliation results; daily runs and their mismatches |

Journal entry kinds:

| Entry | Written | Notes |
|---|---|---|
| J1 hold intent / result | Before / after the partner hold call | Result: held (with the partner's expiry, which must equal `D`), definite refusal, transient, unknown |
| J2 confirm intent / result | Before / after the confirm call | The intent's commit timestamp is the recorded send time, the request's "begin committing" time (POL-26); the call is made only after the intent commits (§10.4) |
| J3 final booking intent / result | Before / after the final booking (partner without holds) | As J2 |
| J4 release intent / result | On a not-confirmed outcome for a held leg, or an accepted yield | |
| J5 cancel intent / result | A partner booking for a request left without Share's confirmation (Share's cost), or a reservation's cancellation (fee per terms) | Retried until the partner confirms (P2-S82) |
| J6 query intent / result | Reconciliation of an unknown result, by the same partner key (P2-S90) | |
| J7 resume query | A new account owner asks for the request's journal; records its partition's (generation, epoch) | After J7, the adapter refuses any confirm, final booking or yield acceptance carrying a lower pair |
| J8 outcome notice | Share-confirmed, or not confirmed (with the tombstone) | |
| J9 waiter registered / removed; yield requested / accepted | Share's own waiter queue at the partner (§10.5) | |
| J10 reconciliation run | Daily, per partner link | Mismatches feed the partner reconciliation feed |
| J11 amend intent / result | Before / after the driver's `amend` (a shorten or a decrease through `change`) | Retried with the same key until the partner confirms; `NOT_ALLOWED` is terminal: `CHANGE_FAULT`, alerted, Share bears the difference (C12 F5) |

#### 10.2 The driver and answer classification

Each driver implements C12 §2.2: the operations hold with expiry, confirm, book final,
release, cancel (with `effectiveAt` only if `supportsFutureCancel`), **amend** (only if
`supportsAmend`), query by partner key and **`queryRef`** by booking reference, and the
daily `listDay`; its capabilities are `supportsAmend`, `supportsFutureCancel`,
`cancelLeadMs`, `maxKeyBytes` and `callTimeoutMs`. A driver cannot drop amend while a live
reservation's shown term allows a decrease (C12 S1). It classifies every answer into one of
four classes:

| Class | Examples | Adapter action |
|---|---|---|
| held / confirmed / booked | Success | Journal the result; notify the account owner |
| definite refusal | "does not fit", "unknown hold" on a confirm | Journal; for a hold, decide contention or rejection (§10.5); for a confirm, not confirmed |
| transient | "busy", rate limited, 5xx before the work | Retry with the same partner key, exponential backoff with jitter, until the leg's fence (`D_c − σ_p` for a confirm or final booking; `D_c` for a hold); never ends the request before then (P2-S30); still failing at the fence, it is reported as a partner fault |
| unknown | Timeout, connection lost after sending | Query at once by the same key (J6) and follow the partner's answer (P2-S90) |

A partner call is never retried with a new key: retries are idempotent at the partner
(P2 C7), so partner retries never book twice (P2-S28).

#### 10.3 The partner leg state machine

| State | On | Next |
|---|---|---|
| none | hold command from the account owner (epoch e) | hold-sent (J1 intent) |
| hold-sent | held, expiry `D` | held |
| hold-sent | definite refusal, Share position overlapping | waiting (J9), account owner told "waiting" |
| hold-sent | definite refusal, no Share position overlapping | refused (tombstone), account owner told "rejected" |
| hold-sent | unknown | querying → held or refused |
| held | confirm command, adapter clock before `D_c − σ_p`, epoch ≥ highest, not tombstoned | confirm-sent (J2 intent, send time) |
| held | yield accepted | releasing → waiting |
| held | not-confirmed outcome | releasing (J4) → released (tombstone) |
| confirm-sent | confirmed | partner-booked |
| confirm-sent | unknown | querying → partner-booked or not |
| confirm-sent | definite refusal ("unknown hold": the partner's clock passed `D`) | not booked; account owner told |
| partner-booked | Share-confirmed outcome | confirmed (the reservation's leg) |
| partner-booked | not-confirmed outcome, or found for a tombstoned request | cancelling (J5, Share's cost) → cancelled |
| none / held | final booking command (partner without holds), clock before `D_c − σ_p` | final-sent (J3) → partner-booked, refused or waiting |
| confirmed | `change` (shorten or decrease, with `supportsAmend`) | amending (J11) → confirmed (`CHANGED`), or `CHANGE_FAULT` on `NOT_ALLOWED` |
| confirmed | `cancel` | cancel_scheduled (J5 scheduled until `effectiveMinute − cancelLeadMs`, or at once for a booking that starts at or after it) → cancelling → cancelled (`CANCELLED`) |

```mermaid
stateDiagram-v2
    [*] --> HoldSent: hold (expires_at = D)
    HoldSent --> Held: held
    HoldSent --> Waiting: refused while Share's own position overlaps
    HoldSent --> Refused: refused, no Share position overlapping
    Waiting --> HoldSent: re-ask, in priority order
    Held --> Waiting: yield accepted (hold released at the partner)
    Held --> ConfirmSent: confirm before D_c - sigma_p (send time journaled)
    [*] --> FinalSent: book final (partner without holds), before D_c - sigma_p
    ConfirmSent --> PartnerBooked: confirmed (after a query if unknown)
    FinalSent --> PartnerBooked: booked
    FinalSent --> Waiting: refused while Share's own position overlaps
    ConfirmSent --> NotBooked: refused or hold lapsed
    PartnerBooked --> Confirmed: Share-confirmed (outcome_confirmed)
    Confirmed --> Amending: change (amend)
    Amending --> Confirmed: amended, or CHANGE_FAULT
    Confirmed --> CancelScheduled: cancel (J5 scheduled)
    CancelScheduled --> Cancelling: effectiveMinute - cancelLeadMs
    Cancelling --> Cancelled: partner confirms
    PartnerBooked --> Cancelled: not confirmed: cancel at Share's cost
    Held --> Released: not confirmed: release (and lapse at D)
    Refused --> [*]
    Released --> [*]
    Cancelled --> [*]
    NotBooked --> [*]
```

#### 10.4 Fences, epochs and tombstones (RFC-000 V-03)

The adapter refuses, journals as refused and never sends:

- a confirm or final booking whose J2 or J3 intent would commit with a `ts` at or past
  `D_c − σ_p` (checked against the commit timestamp inside the transaction, as the confirm
  fence is, §2.5), or whose send would leave more than `h_s` (est. 20 ms) after that commit
  by the adapter's clock (it is then journaled as not sent). Since `ts` is within `ε` of
  true time and `σ_p ≥ ε + h_s`, the call leaves before `D_c` in true time: "begin
  committing" is never late (P2-S55, P2-S109);
- any command carrying an account-owner (generation, epoch) lower than the highest
  recorded **for its account partition** (`STALE_SENDER`, journaled), **except `release`**,
  which only removes and is always applied (C12 F7, D3; J7 stays as a per-request barrier;
  RFC-000 AI-R6-3);
- any hold, confirm or final booking for a tombstoned request, or a hold past `D`.

**A late send** (C12 F12). If a confirm or final booking would leave later than `h_s` after
its intent's commit, nothing is sent, the intent is journaled as not sent, and a **fresh
J2 or J3 intent** with the same partner key is written while its `ts` is still before
`D_c − σ_p`; the request's "begin committing" time is the `ts` of the intent actually sent.
Late sends are counted and alerted on rate.

**An intent with no result at a takeover** (C12 F10). The new adapter owner resolves it
before it reports anything: J1, query by key; J2, first release the hold at the partner
(J4), so a confirm still in flight fails there, then query, and report `NOT_BOOKED` only
after the release is answered and the query shows no booking; J3, and a cancel with no
recorded booking, query at once and again at `max(D, takeover + callTimeoutMs) +
release_grace` (est.), only the second `absent` being final, a booking found after that
being a residue cancelled at Share's cost; J4, J5 and J11, re-sent with the same key.

**Order of reservation-leg operations** (C12 F5). The adapter applies `change` and `cancel`
for one (reservation, leg) strictly in `changeSeq` order (the E11's sequence): change n + 1
is not sent until change n is confirmed or superseded; a later change, being absolute,
supersedes the outstanding parts of an earlier one (`CHANGED{superseded}`); a `cancel`
supersedes an outstanding amend with a lower `changeSeq` only for bookings whose remaining
effect lies at or after its effective minute; a cancel for a reference already scheduled
with a later effective minute moves it earlier, never later (C12 V1).

A command from the account owner sent by a deposed owner, or by the old slot of a moved
partition, carries its old (generation, epoch) and is refused here, as at a link owner (RFC-000 §5.2). A partner booking the adapter finds for a
tombstoned request, by a late answer, a query or reconciliation, is cancelled at once at
Share's cost (POL-28). **Partner clock skew** is budgeted inside `commit_margin`: the call
reaches a partner whose clock is off by at most `σ_p − ε − h_s` when the partner's own
clock reads no later than `D − commit_margin`, so about `commit_margin` before the
partner's hold expires; Share's E5 must then commit before `D − τ`, which leaves the partner
at least `commit_margin − τ` (about 9.6 s, est.) to answer. A confirm the partner
nonetheless answers "unknown" or "hold lapsed" after its own `D` is reconciled by query; if
the partner booked it, it is a partner booking for a request that is not confirmed and is
cancelled at Share's cost (R17).

#### 10.5 Share's waiter queue at a partner link, and yields

- **Contention or rejection.** On a definite refusal of request W's hold (or final booking),
  the adapter checks its own state for another Share request with a hold, or a partner
  booking for a request not yet decided, overlapping W's window. If there is one, W is
  **waiting**: registered in the waiter queue by `priority_rule`, with those requests as its
  blockers, and its account owner is told "waiting" with the latest deadline among the
  blockers (P2-S89, P2-S96). Otherwise W is rejected naming the partner link (P2-S31).
- **Yields of Share's own partner holds.** If waiter W is older than a blocker Y whose
  partner hold the adapter believes waiting (by Y's hint), the adapter asks Y's account
  owner to yield; on acceptance it releases Y's hold at the partner, waits for the partner's
  answer to the release, and registers Y as a waiter at its own age with a new attempt,
  answering `WAITING(newAttempt, …)`. A partner booking (a confirmed held leg, or a
  final-only booking) is never yielded: its request is committing. The yield request
  (`YieldRequestMsg`) has **no claim** in C12, and `yield_answer` is keyed by (request, leg,
  attempt) with the answer compared, so a holder that refused cannot accept later for the
  same attempt (CI-B-2): it keeps its partner hold until its own outcome.
- **Re-asks, strictly in priority order.** When a blocker resolves (its outcome notice
  arrives, and, if not confirmed, Share's cancellation or release at the partner is
  answered), the adapter re-asks the partner for its waiters in priority order: a waiter's
  re-ask may start once no older waiter **with an overlapping window** has a re-ask
  outstanding, so re-asks are serialised per pair of conflicting windows, not along a chain
  of overlapping windows (A0R-08). It skips a waiter past its fence (`D_c − σ_p` by its clock,
  less the hold time it would need) or already ended by its account owner, because a re-ask
  is a hold that would block the next waiter (P2-S95). A re-ask refused again while a Share
  blocker still overlaps keeps the waiter; refused with none left, it is rejected.

#### 10.6 Unknown results and reconciliation (POL-28)

- **Per call, at once.** Any unknown result is queried by its partner key immediately and
  the record follows the partner's answer (P2-S90). A confirm still unknown at the account
  owner's `D − τ` means the request is not confirmed; the adapter keeps querying, and a
  booking found later is cancelled at Share's cost.
- **Daily** (C12 §3.5). For each partner link, the run for day D starts at 00:15 UTC on
  D + 1 (est.) and commits every mismatch and `RUN_COMPLETED` by 12:00 UTC on D + 1
  (P2-S32); the console alerts at 12:00 if `RUN_COMPLETED` is missing. "Day D" covers the
  bookings whose window meets D and those created, changed or cancelled during it, compared
  with the journal **as of listing time**. A reference in a non-terminal state
  (`hold_sent`, `confirm_sent`, `final_sent`, `querying`, `partner_booked` undecided,
  `amending`, `cancelling`) is published `DEFERRED` and re-checked once its work resolves; a
  scheduled cancel not yet sent is compared as `confirmed` before its effective minute.
  Each mismatch alerts operations and is published on the partner reconciliation feed,
  identified by (partner link, reference) across days: **PARTNER_ONLY**, a partner booking
  with no Share reservation behind it (or one of a tombstoned request), is cancelled at
  Share's cost (POL-23), one action per reference; **SHARE_ONLY**, a Share booking the
  partner lacks, goes to the account owner as `partner_leg_affected` with `delivered =
  null`; **PARTNER_SHORT**, the partner has a lower rate or a shorter window, goes as
  `partner_leg_affected` with the partner's figures; **PARTNER_EXCESS**, the partner has more
  than the leg's intended state, re-drives the outstanding amend or cancel, or sends a fresh
  one, at Share's cost. The account owner writes E14 and its holder is told (P2-S91, §9.4).
  Share's record and the partner's then match (P2-S28).

#### 10.7 Partner keys and references

- Partner key = SHA-256, in lowercase hex, of the **canonical JSON** of a key object (C12
  §5.3, with its test vectors): for hold, confirm, book final and release, (request, leg,
  operation, attempt), a confirm using the attempt of the hold it confirms and a release
  that of the hold it releases; for cancel, (booking reference, `cancelId`); for amend,
  (booking reference, `changeId`). Kept with the partner booking record for 7 years
  (RFC-000 §4.4).
- The partner sees only an opaque reservation reference, never the buyer's identity
  (POL-33).

### 11. The contention guarantee, path by path (POL-02, POL-05)

**The claim.** Among waiting requests (`wait` = true) whose `D_c` outlasts the outcome of the
requests ahead of them, contention alone never makes every competitor lose, on Share links
and on partner links where Share's own position causes the refusal; no set of two or more
waiting requests stays blocked on each other's holds; a holder that is not waiting is never
pre-empted; every excluded path leaves nothing held and gives a reason.

**Why it holds.** Holds are locks taken before the decision and kept until it (strict
two-phase locking, RFC-000 §4.1); the priority rule is the conflict policy.

1. *A non-waiting holder always resolves.* A request in Ready, Committing or Deciding needs
   nothing more from anyone; it is decided (confirmed or not) by its deadline (§6), and its
   holds are then converted or released. It is never asked to give anything up.
2. *The oldest waiting request is blocked only by requests that resolve.* Let O be the
   oldest request in the Waiting phase among those contending for some capacity. Every hold
   blocking O belongs either to a non-waiting holder (which resolves by 1) or to a younger
   waiting request Y. The participant where O waits asks Y to yield (§5.3, §10.5), and Y's
   account owner accepts, because Y is waiting. A non-waiting holder that later starts to
   wait becomes such a Y: the link raises a new claim when its waiting hint arrives, or at
   once when it records a refusal while Y's mark is set (C02 D3), so no refusal given
   while Y was not waiting can leave O blocked (P2-S118). No hold blocking O can belong to an older
   waiting request, since O is the oldest.
3. *Released capacity goes to the oldest waiter.* A link owner grants released capacity to
   its waiters by `priority_rule`, and an adapter re-asks in priority order (§10.5), so a
   yielding request cannot take back what it yielded ahead of O, and keeps its own place
   (P2-S97).
4. *Cycles break without detection.* In a cycle of waits every member holds something and
   waits for something, so every member is waiting; by 2 the oldest member's blocker yields.
   This holds for any length (P2-S19, P2-S87) and across Share links and partner links, since
   both apply the same rule.
5. *So the oldest waiting request is confirmed or rejected on committed capacity before
   its fence*, unless its fence passes first, which is the excluded case. Hence among the
   covered requests at least one wins while the capacity remains.

| Path | What happens | Inside the guarantee? | Scenarios |
|---|---|---|---|
| Contended, `wait` default, single link or route | Waits at the link (E2); granted when the holder ahead releases; rejected for no fit only on committed capacity | Yes, if `D_c` outlasts the outcome ahead | P2-S15, P2-S16, P2-S17, P2-S20, P2-S52, P1-S07, P1-S11 |
| A holder that is not waiting meets an older request | The holder keeps its hold; the older one waits | Yes | P2-S58 |
| That holder then starts to wait while the older request still waits for its capacity | Its waiting hint makes the link raise a new yield claim (or a refusal recorded while its mark is set does); it is now waiting, so it accepts, yields and waits at its own age; the older request is confirmed | Yes | P2-S118 |
| `wait = false` | Rejected at once with `retry_after` (the latest remaining deadline among the requests in flight that block it) and the counter-offer beside capacity in flight; no hold kept | Excluded; told why | P2-S18, P2-S59, P1-S12 |
| Deadline shorter than the outcome ahead | Fails at `D` "deadline passed while waiting", `retry_after` from the waiting mark | Excluded; nothing held | P2-S61 |
| Partner route whose `D_c` passes before the outcome ahead | Skipped by the link owner (with B-AI-3) and the adapter; fails at `D` "deadline passed while waiting", `retry_after` 0 if the request ahead has had its outcome | Excluded | P2-S95 |
| Crossing (two requests) | The younger, waiting, yields its conflicting hold and waits; the older is confirmed; the younger then rejected, or confirmed if the older ends without confirmation | Yes | P2-S19, P2-S60, P2-S97 |
| Cycle of three or more | Every younger waiting member holding what an older one needs yields; the oldest is confirmed; then the next oldest if it fails | Yes | P2-S87, P2-S88 |
| Partner refusal while another Share request holds there | The refused request waits in the adapter's queue; re-asked in priority order when the hold resolves | Yes | P2-S89 |
| Partner refusal while another Share request has booked there, undecided (final-only or a confirmed held leg) | Waits until that request's outcome and, if not confirmed, Share's cancellation; then re-asked | Yes | P2-S96 |
| Cross-domain cycle (O holds L1 and waits at P; Y holds at P and waits for L1) | The adapter sees O older than Y, Y waiting: Y yields its partner hold | Yes | P2-S89 with §10.5 |
| A partner refusal not caused by Share, a partner fault, a deadline after a fault | Rejected or failed; nothing held; reason given | Excluded (failure, not contention) | P2-S31, P2-S62 |
| Funds | No capacity hold before the funds hold, so a request that cannot fund never blocks one that can | — | P2-S92 |
| The priority rule changed | Only waiting requests are ordered by it; an uncontended request's outcome is the same | — | P2-S21 |

### 12. Crash points and recovery (POL-03)

#### 12.1 The account owner's takeover

1. A new owner takes the account slot's owner lease, which it can do only after the old
   lease has expired by the database's clock (so every read lease it granted has expired
   too), incrementing the epoch (§2.5, RFC-000 §5.2). Its first read of each partition sees
   every entry the old owner will ever commit; a batch the old owner left in flight is
   resolved, committed or aborted, by that read.
2. It runs the recovery queries of §2.5 and loads its in-memory state for the slot from the
   projection rows: requests, reservations, change queues, the idempotency keys of the
   retention period, the funds state, held invoice-status events, and its timers. It asks
   identity for a snapshot of the slot at once (C08 S-G1); no E5 commits until `iam_fresh`
   is set (§1.3). It writes E9 in each partition the queries name, in that partition's
   first batch of the new epoch. The same steps run for one partition on `onAdopt` (§2.5).
3. For every request **decided not confirmed without a complete E8**: re-send
   request-scoped releases to every Share leg of the intake, and releases or cancellations
   to every partner adapter; acknowledgements return at once where the tombstone already
   exists.
4. For every **confirmed request whose `D` + `release_grace` has not passed**, and every
   **E11 without its E12**: rebuild each leg's queue and re-send its pending commands in
   the sequence of their deciding entries (§9.8; C02 V61-1): conversions (with the
   recorded attempt, learned again by `query` where memory was lost), a pending
   `offer_accept`, and leg changes (idempotent by change id, absolute rates, §9.7). A
   `STALE_CHANGE` for a command a deposed holder had sent is expected and logged without a
   page. Offers (§9.6): *prepared* or *made*, re-send offer holds and re-arm
   `offer_window`; *accepted* with a partner leg, `resume_query` the partner booking
   (identity (reservation, offer)) and continue to Final or Failed; *failed*, *declined* or
   *lapsed* without every `offer_release` acknowledged, re-send them.
5. For every **undecided request**:
   - if past `T_x`: compose E6 with the reason of §6.2;
   - otherwise **resume**: send `query(request)` to every Share leg and
     `resume_query(request, generation, epoch)` (J7) to every partner adapter. The answers
     give each leg's state and the attempt to record (held at attempt n, waiting with the deadline ahead, refused, tombstoned,
     displaced), whether a partner confirm or final booking was sent and when, and its
     result. The request then re-enters the phase they imply and continues (§5). A confirm
     already sent is never re-sent under the new epoch if the adapter is past `D_c − σ_p`;
     the adapter finishes it and reports the result to the new epoch.
6. Re-send waiting hints and accepted yields and displacements (every E3 of an undecided
   request; the participant drops a duplicate).
7. Start reporting (§8) once `read_lease` + `ε` has passed since its acquisition commit
   (RFC-000 AI-R6-2): push to the status readers, grant read leases to readers that have
   applied through the first report position (never below the initial report position of
   §2.5), write markers; the first marker after an acquisition lists every covered event
   above the predecessor's last `report_through` in the slot (§8.3). Outbound feed rows need
   no re-emission: the changefeed relays every committed outbox row (§2.5). Inbound
   consumers resume from the positions recorded in the last F entries.

A request that can still finish by its deadline less its margin reaches its outcome as if
there had been no crash (P2-S22); one that cannot fails as of its deadline, releases
everything and says why (P2-S23), with Share-link holds gone within `release_grace` after
`D` and partner holds lapsed at `D`. An owner-lease takeover takes seconds (est.: the
lease's remaining time plus, after a node loss, a range-lease move in parallel), within
admission's 1 min RTO (RFC-000 §5.4).

#### 12.2 Every crash point, rechecked on the substrate

"In flight" means the batch transaction was sent and its result not received; it is then
committed or aborted as a whole, decided by the database, and the next reader learns
which (RFC-000 §5.5). Rows C1 … EG1 are revision 1's crash points restated; S1 … S8 are the
substrate's own; S9 … S14 are revision 4's; S15 … S19 are revision 5's; S20 … S26 are
revision 6's.

| # | Crash or fault, and when | Durable at that moment | Recovery | Outcome |
|---|---|---|---|---|
| C1 | Account owner, before E1 commits (or with its batch in flight) | E1 if its batch committed, else nothing | No answer was sent (§3.1); the client retries with the key; the next owner finds E1 if it committed | One request on retry |
| C2 | After E1 commits, before holds are sent or before `pending` is answered | E1 (and the funds hold) | Resume (§12.1 step 5): holds sent; a retry gets `pending` | As if no crash |
| C3 | After some holds were sent, before their acknowledgements | E1; holds at the links | `query` finds them with their attempts (a re-sent `hold` is idempotent by request) | As if no crash |
| C4 | While waiting (E2 committed) | E1, E2; waiter registrations at the links | Query; a grant notified to the dead owner is learned by query or re-notified | As if no crash |
| C5 | A yield or displacement received, E3 in flight | E1, E2; E3 if its batch committed | If committed, step 6 re-sends the acceptance; if not, the participant re-sends its request and the new owner decides again | Accepted once, or refused if no longer waiting |
| C6 | E3 committed, acceptance not yet delivered | E3 | Re-sent (step 6); the participant releases once | As if no crash |
| C7 | Ready, before any partner confirm is sent | E1; holds | `resume_query` (J7) shows nothing sent; checks re-run; confirm sent if before `D_c − σ_p` | As if no crash, or expiry |
| C8 | A partner confirm sent (J2 intent committed), answer not received | E1; J2 at the adapter | `resume_query` returns "sent at t, outstanding"; the adapter delivers the result to the new epoch; a re-send under a lower epoch is refused | Confirmed if the partner confirms and E5 commits in time; otherwise not confirmed and the partner booking cancelled at Share's cost |
| C9 | Every partner confirmed, E5 not yet composed | E1; partner bookings journaled | Resume: E5 if before `D − τ` and checks pass; else ending entry and cancellations | As if no crash, or failed with partner bookings cancelled at Share's cost (P2-S105) |
| C10 | E5 in flight | E5 if its batch committed (its `ts` was checked before `D − τ` in the transaction) | Resolved by the new owner's first read: committed → confirmed, possibly known after `D` within `release_grace` (P2-S106); aborted → re-composed if before `D − τ`, else E6 | One outcome; a confirmation only if its commit timestamp is before `D − τ` |
| C11 | E5 committed, conversions not sent or partly acknowledged | E5 | Step 4 re-sends (the request is in *conversions pending*); holds keep counting until converted; a link with no outcome by `D` asks and is answered "confirmed" (§6.3) | Confirmed |
| C12 | E5 committed, not yet at the report position | E5 | Readers with a live old read lease answer `pending`; once the lease has expired, rule 3 may answer `confirmed`; the new owner reports after taking the lease (§8.2) | Confirmed; reads report `pending` or `confirmed`, never `pending` again once `confirmed` was read (P2-S111 as amended) |
| C13 | Ending entry committed, releases not sent | Ending entry | Step 3 re-sends releases | Not confirmed, reported once E8 completes |
| C14 | Releases acknowledged, E8 not committed | Ending entry; tombstones at the links | Step 3: re-sent releases are acknowledged at once; E8 committed (at or after `D` for an expiry) | As if no crash |
| C15 | Owner down across `T_x` and `D`, or unable to commit in the last `ack_budget` before `D` | Whatever was committed | Participants keep holds and alert at `D`; once an owner can commit, E9 (if a takeover) then E6 ("interrupted" by §6.2 if E9's `ts` ≥ `D`); releases within `release_grace` after `D`; the owner alerts; partner holds lapsed at `D` | Failed as of `D` (P2-S23, P2-S101, P2-S104, P2-S114) |
| C16 | A withdrawal, change or cancellation received, its entry in flight or not composed | Its entry if committed | No answer was sent; the client retries with the key and gets the committed result or a new entry | One change |
| C17 | A change at the head of the queue in progress | Its E1; holds | As a booking request (C2 … C14); the queue is rebuilt from the projection rows | As if no crash |
| C18 | `DISPLACED` arrives for an undecided request (any phase, partner confirms possibly sent), then the owner fails | E1 (E2, E3 if committed); the notice and marker in the link's log; partner journals | The link re-sends the notice; the new owner resolves any E5 in flight (C10), then applies §5.1's rule: E5 committed → nothing; otherwise decided against the reduced capacity, and any partner booking of a request so ended is cancelled at Share's cost (§12.1 step 5) | Confirmed and affected (P1-S63) only if E5 committed without seeing the marker; otherwise rejected or waiting, with its releases and partner cancellations (P1-S78) |
| C19 | A reduction commits at a link while E5 for a request holding there is in flight | The reduction and its displacement marker; E5 if its batch committed | Serialisable isolation orders the two: E5 either read the marker (the reduction is earlier) and was dropped, the request then decided against the reduced capacity whatever its partner legs (§5.1, P1-S78), or committed first (it had begun committing before the record); a reduction meeting a confirm that already read its key is pushed later and re-decided at the link (RFC-001 §5.1); an ambiguous E5 is resolved as in C10 and re-composed with a fresh read | Displaced and decided against the reduced capacity, or confirmed and affected (P1-S63), never confirmed unseen after the record |
| L1 | A link owner's lease moves while a hold command is outstanding | Hold, if it was committed there | The account owner re-sends with the same identity until an answer or `T_x` | Held, or the request expires |
| L2 | A link owner's lease moves while a release is outstanding | Ending entry | E8 waits; the outcome is reported within `release_grace` of the decision (P2-S107, P1-S62) | Not confirmed, reported late, never wrongly |
| L3 | A link owner's lease is moving at `D` | E6 | Release durable once the link has an owner again, within `release_grace` after `D` (POL-26) | Failed as of `D` |
| L4 | A grant notification is lost, or relayed late after a later message | The grant at the link | Re-notified, relayed through Kafka, or learned by the owner's periodic `query`; applied whenever it arrives (no high-water rule), at the waiter's attempt | Granted at the recorded attempt; `convert` carries it (JI-1, JI-2) |
| A1 | Adapter owner's lease moves with a J1 or J2 intent committed and no result | The intent | The new adapter owner queries the partner by the same key (J6) and journals the result | As if no crash |
| A2 | Adapter down at `D` | Partner hold with expiry `D` | The hold lapses at the partner by itself (P2-S101); the adapter releases and reconciles on return | Nothing held at the partner after `D` |
| A3 | Adapter down while a cancellation at Share's cost is due | The outcome notice, or a tombstone | J5 resumed on return, retried until the partner confirms; reconciled | Cancelled, at Share's cost |
| A4 | Adapter owner dies between J2's commit and the call | J2 intent | The new adapter owner queries by the key (J6); the partner has nothing; past `h_s` it journals "not sent" and never sends (§10.4) | As a refusal at the fence, or as if no crash if before it |
| PF1 | Partner fails before doing the work | J intent | Transient: retried with the same key; or definite | As the partner's answer |
| PF2 | Partner does the work and the answer is lost | J intent; the partner's record | Unknown → query by the key; the record follows the partner (P2-S90) | Booked once (P2-S28) |
| PF3 | Partner is slow | J intent | The deadline bounds it (§6); a late booking for a tombstoned request is cancelled at Share's cost | No partial route (P2-S04) |
| EG1 | Edge crashes with an answer in flight | Whatever the owner committed | The client retries with the key | Same request and outcome |
| S1 | A deposed owner is paused past its lease, then resumes | Whatever it committed before | Its batch fails the epoch condition; it reloads, finds the lease gone and stops; its commands carry the old epoch and are refused by link owners and adapters (RFC-000 §5.2) | No second writer; nothing it says after deposition takes effect |
| S2 | A batch's commit result is ambiguous (connection lost at commit, or the 15 s `COMMIT` backstop, C01 M1) | The batch, or not | The runtime resolves it by a present-time read of `owner_slot` and the batch's head rows by `batch_id`; the owner decides nothing further in the slot until then; it then reloads from the log (§2.1) and recomposes what did not commit; waiting submissions processed again | As if the batch had simply committed or failed |
| S3 | A batch is pushed to a later timestamp (contention, closed timestamp) | Nothing new | The transaction restarts and re-evaluates every entry at the new `ts` (§2.1, §2.5): a confirm now at or past `D − τ`, an expiry E8 before `D` or an F7 before its instant is dropped or deferred; an intake whose verdict changes at the new `ts` (a key spending period starting at 00:00 UTC, a fee-term end, a posting) becomes E1′ or E1 accordingly; `D` and `D_c` are recomputed | The fence holds; the request expires instead; every recorded figure is the one a replay computes (P4-S72) |
| S4 | A database node is lost; the account's ranges move their leases | Everything committed | Batches wait seconds (est.) for the new leaseholder; requests near their fence may expire; status rule 3 waits (§8.2) | Bounded by admission's 1 min RTO; releases within `release_grace` if this spans `D` (P2-S114) |
| S5 | Owner dies between commit and its direct Kafka publish | The batch and its outbox rows | The changefeed relays the rows; the notifier delivers only at or below a marker (§8.3) | Nothing lost, nothing published that did not commit |
| S6 | An owner host's clock leaves 50 ms of the database's | Whatever was committed | It gives up its owner leases; a standby takes them (RFC-000 R4); the fence never depended on its clock | As a takeover (C rows) |
| S7 | A status reader dies or is cut off | — (soft state) | Its read lease lapses; the owner stops waiting for it after the lease; clients retry another reader; on restart it catches up by follower reads before taking a lease | A slow reader delays a report by at most its lease |
| S8 | Kafka or the changefeed lags | Every fact (in the database) | Outbound feeds lag, never lose. Inbound F1 … F6 apply late. Revocations: the owner pulls identity catch-up after 20 s of silence, and confirms nothing beyond `iam_fresh` + 45 s (S9). Unposted usage (F2): while it lags, `U` is stale and headroom can be overstated beyond the lateness bound; POL-14 as amended in v1.8 adds admission's 60 s recovery time to the bound (Q-1), and RFC-006 alarms when the F2 apply lag exceeds `attribution_lag_max` (J-18). F5 and F6 wait for their ledger position (§7.3) | No booking decision depends on Kafka; ledger, identity and invoice inputs are applied late, never wrongly; usage exposure may be understated for a lag beyond the bound, alarmed and reported as a breach (POL-14) |
| S9 | The identity push is silent and identity is unreachable | Whatever was committed | `iam_fresh` stops advancing; catch-up is pulled every 5 s; from `iam_fresh` + 45 s no E5 of the slot passes §5.6's check, and requests wait or expire; RFC-006 alarms at 30 s of staleness (RFC-005 RK-17) | No revoked key's request confirmed past X1-S06's 60 s; confirmations resume once catch-up answers |
| S10 | E5's marker read meets the intent of a link owner's in-flight reduction (a link owner paused or dead mid-transaction) | The other entries of the batch | The read times out under its savepoint; only that E5 is deferred to the next batch, the batch commits; the reduction's transaction resolves (committed or aborted by its own timeouts, AI-17-4) and the deferred E5 reads the marker's final state (J-14) | One confirm delayed by one batch, or displaced; the slot never stalls |
| S11 | An invoice-status event arrives before the F1 that reaches its ledger position (a write-off before its `W`), then the owner fails | The F1s committed; the held event in `funds_*` if its row committed, else in Kafka from the last applied position | The new owner re-arms the gate from the held rows and resumes the consumer; the event is composed after the F1 reaching its position (§7.3) | Standing never resumed or suspended ahead of the movements behind it (review 18 J-05 trace) |
| S12 | The owner is down across a known-in-advance effective minute (a move, a price step) | The E13 acceptance or the catalogue event (in Kafka) | Normally nothing: the E11 was written when the cause became known (§9.4). If the cause itself reached the owner late, the E11 takes the next boundary after `ts`, records the delay and alerts (J-07) | No lifecycle entry effective before its `ts`; rating's closure holds (RFC-000 §4.5) |
| S13 | A cut target arrives at or after `T_eff` (the link stepped its reduction late), possibly after the owner's failover | The link's `ReductionStep` and its target in the link's log | The link re-sends `cut_target` from its state until it records the reply (C02 C4-1); E11 idempotent by (link, reduction, reservation, revision), effective `T_eff`; rating holds the reservation's closure at `T_eff` until this E11 is on the lifecycle feed (RFC-000 §4.5 (2), R25) | The buyer is never charged for revoked capacity (POL-07) |
| S14 | A suspending entry is in flight when a route is Ready to send its partner confirm | The suspending batch, or not | No confirm is sent on the projected state; if the batch commits the request ends with it (§7.2) and no partner booking exists to cancel; if it fails, the confirm goes (§5.5, J-12) | No avoidable partner cancellation at Share's cost |
| S15 | A cut target arrives for a reservation the holder cancelled after the link's deciding step, or that left the link by `T_eff`, or for an offer released since | The ending E11 or the move; the target in the link's log | E11 "not applied" with the reason; the answer `NOT_APPLIED(ended \| left_link)` lets the link withdraw its decided removal (§9.7) | No cut on a reservation that is not there; the link's committed rate not left understated (review 26 R26-01) |
| S16 | Two cut targets for one reservation arrive in either order (two links, or two reductions with different `T_eff`), or a lower re-target for one key (JI-5); the owner fails between them | Each committed E11 | Each E11 recomposes from the set in force and sends absolute rates from its earliest changed minute; the link applies a `reduce_parts` only if newer than the last applied | The same part rates whatever the order; never more removed than the least target needs (T15) |
| S17 | The owner fails while an offer is Accepted and its partner booking is outstanding | E13 *accepted*; the adapter's J1 to J3 | `resume_query` for (reservation, offer); the booking continues to Final (E13 *final* with E11 move, then `offer_accept` and `end_leg`) or Failed (`offer_release`, any partner booking cancelled at Share's cost) | The old legs never ended unless the move is final (D4, P1-S61) |
| S18 | E13 *final* and E11 move committed, `offer_accept` or the old legs' `end_leg` not yet sent or acknowledged | E13, E11 | Leg changes pending: re-sent (idempotent by offer and change id); the link applies a late `offer_accept` as decided (JI-7) | The move takes effect at `move_at` on every leg |
| S19 | `DISPLACED` for a hold that was granted (attempt kept) arrives while E5 is in flight | The marker with the granted attempt | E5's marker read finds the marker (any attempt stops E5, C02), so E5 is dropped (C19), and the request is decided against the reduced capacity | P1-S78 row 2 after a grant holds (JI-1) |
| S20 | A partition is integrity-stopped (C01 `Stopped`) while requests are undecided | Whatever was committed | Nothing is decided for the partition; submissions and reads get "temporarily unavailable"; links and adapters keep holds and alert at `D`; once resumed, the owner continues as after C15 | Failed as of `D` for requests whose deadline passed, releases within `release_grace` after the resume (§6.4); nothing decided while stopped |
| S21 | A cancellation commits just after a confirm, and the owner fails before the `convert` is answered (P2-S119) | E5 and the ending E11 | The new holder rebuilds the leg queue and sends `convert` (position of E5) then `end_leg` (the E11's id), in that order (§9.8); a deposed holder's earlier `end_leg` that overtook it gets `STALE_CHANGE` only if never applied, else its recorded reply | The capacity is free from `nb(ts)` on every leg, whatever the order the links learn of the two; the change reported after E12 |
| S22 | A withdrawal of an unused key and the booking with that key race at the owner (P2-S122) | The first of the two entries to commit | The owner composes them in its serial order on projected state: withdrawal first gives a pre-emptive E1′, and the booking is answered "withdrawn"; booking first gives E1 then E4 | The booking never holds anything after the withdrawal is recorded; both answers report one outcome |
| S23 | A quote is issued, then the slot changes owner (takeover, re-home) or the account is re-slotted before the booking | The quote key versions (RFC-005 key release); nothing in the log | A takeover or re-home keeps the key versions, so the token verifies; after a re-slot the token does not verify and the booking is rejected `terms_changed` with `requote` | No unshown fee is charged; the buyer quotes again and books under a new key |
| S24 | The owner fails between an E11 and its partner `change` or `cancel` | The E11 | The adapter applies reservation-leg operations in `changeSeq` order; the new holder re-sends with the same `changeId` or `cancelId`; the recorded result is returned | One change at the partner; never cancel-and-rebook |
| S25 | A slot is splitting while an upper-half account is created or acted on | The head rows | The owner of `s` answers `MOVED(s + n)` for a creation with no head row; `s + n` creates it with `rowAbsent(head)`; an unadopted head gets `MOVING` (§2.5) | One home for each account; no account created twice |
| S26 | An adapter finds a partner booking late for a tombstoned request or a failed offer | The adapter's journal and its J5 cancel | The adapter cancels it at Share's cost; the account owner records E16 when it is told (CI-B-1: C12 has no message for it yet; meanwhile the reconciliation feed and the alert carry it) | Share pays; the buyer is never charged |

### 13. Contracts this RFC provides and consumes

From RFC-000 revision 4.5, **the frozen contracts C01 … C12 are the authority for every
interface detail**: the wire forms, the fields, the errors, the idempotency keys and the
ordering. The rows below summarise them and name what the owner and the adapters do
behind them. Where a row and its contract differ, the contract applies. Synchronous
commands are gRPC between NestJS services, routed by slot with C01's `CommandEnvelope` and
answered with C01's `RoutingRefusal` where routing fails; asynchronous feeds are Kafka
topics fed by the transactional outbox (§2.5), with event identity (partition, stream,
`stream_seq`) and closure markers from C01's emitter.

#### 13.1 Provided

| Contract | Operations and messages | Delivery and idempotency | Guarantees |
|---|---|---|---|
| **Booking API** (**C10** v1.0.0; to buyers through RFC-005's edge) | `quote` (§3.4); `book`; `change` with `kind` cancel, shorten, extend, renew, make open-ended, increase, decrease (cancel is a change kind, C10 M1); `withdraw` naming the request's own key (§7.1); `status`; offer read, accept, decline, move-earlier (§9.6). `book` and `change` may cite `quote_id`. Answers carry `blocking_partner_link` for a definite partner refusal, `key_expires_at`, `fees[]` per leg, `cut_kept` on an offer status after the cut (C10 M6), and `requote` with `quote_required` or `terms_changed` | Synchronous; one answer within `ack_budget` (final, `pending`, or not accepted) for book, change, withdraw and status; quote and offer answers outside `ack_budget`. **Four idempotency families** (C10 D2): booking and change (account, key; a pre-emptive withdrawal recorded in it, D4), quote, offer answer (fingerprint (offer, answer, `move_from`)), documented request (RFC-005's). `400` malformed, nothing recorded (C10 M7); `409` for key reuse; `503 temporarily_unavailable` with `Retry-After` for `Stopped`, an exhausted re-route, a stale price cache or a reader under rule 4 (C10 M9) | One outcome per request, fixed at its deciding entry; reported only by the gate of §8; a reported outcome never changes (P2-S10); while the decision record is unavailable a status read gives `pending` or the decided outcome, never another (RQ-13); rejections carry the counter-offer and amounts (POL-10), none for a link being retired, the resume amount itemised with the headroom after it (POL-16), or the rule (B-RQ-3); a request is never charged a fee that was not in a quote it cited (POL-08); nothing of another principal's or account's request is revealed |
| **Outcome and expiry port** (**C02** to link owners; **C12** binding to partner adapters) | Outcome: `convert(request, attempt, reservation, part, T_dec, createdBy)` in the leg's queue (§9.8) or request-scoped `release(request, D, reason, decision time)`; to an adapter `outcome_confirmed` (with `partId`) or `release`; the answer to `expire_if_undecided` (the committed outcome); `yield_accept` or `yield_refuse(request, attempt, claim)`; `displacement_accept(request, attempt)`; the answer to `offer_outcome_if_lapsed` (`offer_accept` or `offer_release` again). (`mark_waiting` goes on the link waiting port and the partner port) | Synchronous gRPC commands and replies, sent only after the deciding entry commits (not outbox notifications, C02 erratum (b)); each with the C01 envelope; retried until answered; idempotent by (link, request, attempt, kind), with the claim for yield answers; a participant refuses one below the (generation, epoch) it has recorded for the partition (`STALE_SENDER`); a release carries no attempt | A participant releases only on a committed non-confirmed outcome, an accepted yield or an accepted displacement (A9); a request confirmed after `DISPLACED` (it had begun committing) stays confirmed and the link flags it affected and alerts (P1-S63); `mark_waiting` is advisory everywhere |
| **Reservation command port** (from RFC-001, the operator console, the partner adapters; release after grace internal) | `cut_target(link, reduction, reservation, revision, parts, pieces \| none, offer?)` (**C02**, §9.7); `terminate` (**C04**, §9.4); `partner_leg_affected(reservation, leg, partner link, delivered, event identity)` (**C12** m12, §9.4); offers and moves (§9.6) go through the link hold port's offer commands; release after grace (internal, in the F7 entry, JR-2) | `cut_target`: answered by its **synchronous reply** once its E11 or E13 commits, `APPLIED(change ids \| none)`, `NOT_APPLIED(ended \| left_link \| unknown)`, `KEPT_FOR_OFFER(offer)` or `MISMATCH`, echoing the revision with `recordedRevision`; the link sends it again from its state until it records the reply (C02 C4-1, C4-2). `terminate`: identity `"<account>/<action_id>"`, idempotent by (account partition, `action_id`), looked up before the checks; refusals and `NOT_ACTIVE` recorded in E15; per-call deadline 2 s (est.) (C04 M-05, D-5, N-08 … N-10). `partner_leg_affected`: idempotent by (reservation, leg, partner link) | Applied in the account owner's order; cut targets composed by `min` per minute, oldest Mbps kept first, each binding its covered parts; one E11 and one `cut` per revision above the highest recorded; a target from a link left by `T_eff` not applied; offer-scoped targets bind only the move, and one on a Final offer with the link on the new path is a normal cut from `max(T_eff, move_at)`; each changed part's rate sent to every leg as absolute minute pieces naming the (link, reduction) pairs applied; a cut or a price step fails no change, a move fails only a change in progress on removed legs, an ending fails every pending change (P2-S80, J-15); the route is changed as one unit on every leg |
| **Request outcome feed**, with report-position markers (**C04**; to the notifier, alerting, the operator console) | One event per reported outcome, **every booking request, changes included**, with `answered_pending` and `withheld_by` (§8.3); C01 `ReportMarker` (slot, generation 0, epoch, `reportPosition`, header `report_through`) extended with `prevReportPosition`, `pendingAnswered` and `chunk` | Kafka, at least once, ordered per account partition (topic keyed by slot), identity (partition, stream, `stream_seq`); markers written only by the runtime | Every consumer treats an event as reported only at or below a marker; the first marker covering a request answered `pending` lists it; after an acquisition the first marker lists every covered event above the predecessor's `report_through`; same identity on both publish paths and across owner changes |
| **Reservation lifecycle feed** (**C04**; to rating RFC-003, the catalogue's locked-price read model, history RFC-006, the notifier, reporting) | `confirmed`, `part_added`, `rate_decreased`, `cut` (with `target_revision`), `shortened`, `moved` (route ID, shown price, minute, the old partner leg's fees due paid by Share), `price_step`, `ended` (cause among cancelled, `cancelled_after_cut`, revoked, released, terminated, `window_end`; minute; fees due with `fee_id` and payer; `delay_min`), `partner_leg_affected` (with `delivered`), `leg_changes_durable` (E12), `offer_made`, `offer_accepted`, `offer_declined`, `offer_lapsed`, `offer_failed`, `offer_cut_kept`, `pol28_residue` (`found_by`); every event carries `account_is_probe`, a copy of the slot map's designation (C04 MM-1, CC-1), and `withheld_by` | Kafka, at least once, ordered per account partition by the stream's own sequence, identity (partition, stream, `stream_seq`) with (generation, epoch); a row is written with its entry (C04's entry-to-event table); the change event with the E11, `leg_changes_durable` with the E12 (C04 MM-6) | **Effective-time closure** from C01's emitter: every event takes effect at or after `floor_min(ts)` except the three allowed early-effective events (`cut`, `ended(revoked)` in a cut's E11, `ended(window_end)`, C04 M-06); `part_rates` are absolute; fees shown, due and who pays are present for every end (P3-N12) |
| **Usage-applied acknowledgement** (**C06** is its canonical definition, C05 refers to it; to rating, RFC-003) | Through which rating position the owner has applied unposted usage, with `appliedTs` (the F2 entry's commit timestamp) and `entry` (that F2 entry's C05 `LogPosition`) (C06-M1) | Kafka, at least once, per account partition, from the F2 entry's outbox row; topic retained at least 7 days; beyond that, `usage_applied_since(accountPartition, afterStreamSeq)` served by the **status readers**, rebuilt from the log by `emits`, off the write path (C05 S-4) | Rating recovers a gap by replay, then by the query; it never reads the owner's tables |
| **Standing feed** and **standing and headroom queries** (**C05**; semantics RFC-004) | Standing changes with per-account sequence; the headroom and balance query and the standing query on the status replicas | Kafka, from the outbox of the entry that changes standing; queries at a recorded position | As RFC-004 A and C05 |
| **Partner port** (**C12** §2.1; account owner → adapter, uniform for every partner) | `classify`; `hold` and `book_final` (with `wait` and `reservation` for an addition); `confirm(attempt)`; `release` (request-scoped); `outcome_confirmed` (with `partId`); `cancel(reservation, leg, cancelId, changeSeq, reason, costBearer, effectiveMinute)` (reservation-scoped, **no residue reasons**, C12 F6); **`change(reservation, leg, changeId, changeSeq, cause, shorten \| decrease)`**, never additions (additions are requests of their own through `hold`, `confirm` or `book_final`, C12 S1); `mark_waiting`; `yield_answer`; `resume_query`. Results as `PartnerResultMsg` state messages | Each command with the owner stamp (generation, epoch, map version); idempotent by C12 §5.1's keys with §5.2's sameness (the stamp never compared); `STALE_SENDER` per account partition, `release` always applied | §10.4's refusals are journaled and never sent; any partner booking found for a tombstoned request is cancelled at once at Share's cost, by the adapter alone; partner holds always expire at `D`; `change` and `cancel` applied in `changeSeq` order per (reservation, leg) |
| **Partner reconciliation feed** (**C12** §2.3; to the operator console and the notifier) | `MISMATCH` (PARTNER_ONLY, SHARE_ONLY, PARTNER_SHORT, PARTNER_EXCESS, with the action), `DEFERRED`, `RUN_COMPLETED` | Kafka, at least once; identity `MISMATCH` (partner link, reference) across days, `DEFERRED` (partner link, day, reference), `RUN_COMPLETED` (partner link, day) | Every mismatch and `RUN_COMPLETED` by 12:00 UTC on D + 1 (P2-S32); SHARE_ONLY and PARTNER_SHORT reach the account owner as `partner_leg_affected` on the reservation command port, not by this feed |
| **History semantics: requests and reservations as known at T** (storage RFC-006) | A request's entries and a reservation's E5, E11, E13, E14 with their `ts` | — | "As known at T" = the entries with `ts ≤ T` in the account log (A4) |
| **Target summary** (**C08** §G; to the operator console's signing client) | `target_summary(account or reservation)` → a summary signed by the owner: the account's standing and reservations, or the reservation's legs, parts, end and `target_version` (the `Seq` of its last entry that changed parts, rates, window or legs) | Synchronous, accepted only from the console's workload under `console_session`, **purpose-bound** (mandatory `action_id` and `action_type`; a target kind that does not match the action is refused `target_kind_mismatch`), counted against `operator_read_limit` (audit's `read_limit` refusal answered `refused read_limit`), and **appended to audit before the answer** (C08 S-G3, D3) | The version the owner checks again when it applies the envelope (§9.4) |
| **Credit-limit command** (**C07** op 2, v1.2; receiver; semantics RFC-004 A) | `set_credit_limit` or `remove_credit_limit` in the signed C08 envelope (amount, `reason_code`, `action_id`, approver when present); a set-scoped action as one envelope per member account, `member` outside the signed digest | Synchronous, per-call deadline 5 s (C07 S4); idempotent by (`action_id`, account), deduplicated before any check that can change with time; answered after the F5 entry commits | §7.3's order: authenticity, deduplication, freshness and four eyes, scope (applied F9 only; the version v not checked), validity, KYB with `temporarily_unavailable{identity_stale}` |

#### 13.2 Consumed

| Contract (owner) | What this RFC relies on |
|---|---|
| **C01** platform (RFC-006) | The runtime API: `append` with `decide(ctx)`, its results (`Committed`, `ConditionFailed(which)`, `Retry`, `Ambiguous`), `AppendOptions`; the `displacementRead` condition keyed (link, request) with a 10 ms lock timeout; `EntryInput.pendingAnswered`; `leaseValid`, `epoch`, `generation`, `admitCommand`; the hooks `onAcquire`, `onMovedOut`, `onAdopt`, `onNotification`, `onResolved`, `onReportable`; `Stopped`; `slotOf` with `headDecides`, `route`, `ackSplitting`, `listPartitions`; `CommandEnvelope` and `RoutingRefusal`; `ReportMarker`; the status readers' `leasedRead`, `isMovedOut`, `replicaRule3Check`; the 15 s `COMMIT` backstop ending as `Ambiguous` (M1); the initial report position after any acquisition; closure markers from the emitter; event identity (partition, stream, `stream_seq`); probe accounts from placement's slot map (M11); the database topology, owner leases, session revocation, generations, per-stream sequences, marker-only transactions outside the lane, the second lane as fallback, `ε`, `δ_x_cfg` and the `τ` cap (§2.5) |
| **C02** link hold port (RFC-001) | `hold(request, account, leg, kind, rate, window, D, D_c, request_age, wait, receipt minute, policy version)` with no attempt, answered `HELD(attempt)`, `WAITING(attempt, ahead deadline)` or a refusal (`NO_FIT`, `IN_FLIGHT`, `DEADLINE_PASSED`, `TOMBSTONED`, `INVALID(rule)`, and with **no tombstone** `UNKNOWN_LINK`, `LINK_CLOSING`, `LINK_RETIRED`, M-2), the link deciding `wait = false` itself; `convert(…, createdBy)`, `MISMATCH` for another attempt, clipped by the link only when an applied `end_leg` has a change id above `createdBy` (`CONVERT_AFTER_END`); request-scoped `release`; `end_leg` and `reduce_parts` in §9.7's absolute form, `applies` only for cause `POL07`; `offer_hold`, `offer_accept`, `offer_move_at` (with a change id), `offer_release` (recorded also for an offer the link has not seen); `query(request)` → state, attempt, latest blocker deadline, recorded refusal, displacement, open yield claims, tombstone expiry. **For each (reservation, leg) one outstanding command among `convert`, `offer_accept`, `offer_move_at`, `end_leg` and `reduce_parts`**, in deciding-entry order; the link keeps the reply of every applied change id; `STALE_CHANGE` only for a lower id never applied, counted as answered; the leg-command replies table (§9.8). Invariants: a release ends every hold, waiter registration, grant, marker and yield claim of the request; a tombstone until `D` + `release_grace` refuses later holds and grants; no hold or grant past `D`; a waiter past `D_c` is skipped when granting; `convert` is accepted for a held leg after `DISPLACED`, the leg then flagged affected (P1-S63); a link is retired only when it has no holds, offer holds or parts |
| Link hold-order (RFC-001; POL-05 as amended in v1.7) | Checks at a link in the order `hold` commands reach its schedule owner, a re-sent copy counted at its first applied arrival (P1-S14, P1-S77) |
| **C02** link waiting port (RFC-001) | Notifications `WAITING_NOTICE(request, attempt, latest blocker deadline)` (the copy with the highest `linkSeq` wins), `GRANTED(request, attempt)` at the waiter's attempt, `YIELD_REQUEST(request, attempt, claim, older request)` (re-sent with the same claim; a new claim on a waiting hint with none open, or at once on a recorded refusal while the mark is set), `DISPLACED(request, attempt, reduction, record time, fits?, counter-offer)`, `WAITER_REFUSED(request, attempt, NO_FIT, counter-offer)`; identity (link, request, attempt, kind), with the claim for `YIELD_REQUEST`; at least once (gRPC push, the runtime's relay through `onNotification`), applied whenever new, with no high-water rule; commands `mark_waiting(request, waiting, account-log position)`, `yield_accept` / `yield_refuse(request, attempt, claim)`, `displacement_accept(request, attempt)`, whose reply names `newWaiterAttempt`; a stale attempt or claim answered `STALE_ATTEMPT`; the owner reconciles every Holding or Waiting request by `query` on a timer (RFC-000 AI-17-2) |
| **C02** link displacement read (RFC-001) | A single-key point read of `link_displacement` by (`link_id`, `request_part`, `request_seq`), no slot column, inside E5's serialisable batch transaction under a savepoint with a 10 ms lock timeout: a **present row, with any attempt**, means no E5 and the leg is handled as `DISPLACED` (an attempt other than the recorded one also alerted and queried); absent means none before the confirm's `ts`; a timeout defers only that E5. Read-only: the link owner is the only writer and deletes a marker in the entry that ends its attempt; this RFC's role has `SELECT` on this table only |
| Link availability query (C02, RFC-001) | Peak and free-capacity profile over a window and forward to the horizon, beside committed and held capacity (POL-10 as amended) |
| **C03** link schedule feed (RFC-001, Kafka) | `AFFECTED_CHANGED`, `OFFER_AFFECTED`, `REDUCTION_AFFECTED` (diffs of the cut-set rows, chunked at 1,000; a newly affected holder is offered a path, CT-2.1), `REDUCTION_EFFECTIVE`, `REDUCTION_SET_EXTENDED`, `CUT_DECIDED` (one per (reduction, reservation, revision)), `REDUCTION_FINAL`, `CAPACITY_CHANGED`, `LEG_CONFIRMED`, `LEG_CHANGED`, each with the link's `feed_seq`, and the per-destination closure markers. Cut targets themselves arrive on the reservation command port; this RFC puts the revision on the lifecycle `cut` (C03 M2) |
| **C05** funds-and-standing module (RFC-004 Part A; joint) | §2.4, as C05 v1 states it, including the interface points listed there |
| **C08** identity push, catch-up and snapshot (RFC-005) | Key revocations, limit changes and KYB status, keyed by account; closure markers on the push's closure topic; `catch_up(account slot, since)`, answered with events and a read timestamp, or with a current-state **snapshot** and its position when `since` is absent or older than retention (S-G1); applied as F4, deduplicated by (identity partition, sequence) plus key version; `iam_fresh` by §1.3; every event applied within 60 s while Kafka or identity is reachable; the owner confirms only within 45 s of `iam_fresh` (AI4-3, AI-R5-4, X1-S06) |
| **C08** envelopes, operator check, read grants, policy feed (RFC-005) | Authenticated pseudonymous principal on every submission, with the tenant and key checks of RFC-005 §4.3 and the provisional key record (§3.1); the operator envelope verified in §E's order, check 2 only under identity's returned key, an expired or misrouted envelope refused before `operator_check`, `not_after` at most 72 h + `ε` ahead, a target outside the partition `out_of_scope`, a repeated refused `action_id` answered with the recorded refusal, deduplication before checks 3 … 6; identity's `operator_check` (C15) at apply time for terminations and credit-limit commands; read grants on the status readers' operator reads with the audit append before the answer; the policy feed and the key-certification stream (§N); owner-side encryption of every application column (AI5-3); no personal data in any entry or feed (A11) |
| Standing enforcement acknowledgement (C05; network operations) | Applied as F8, idempotent by (account, `stdSeq`) (C05 C-6) |
| **C06** unposted-usage feed (RFC-003) and ledger movement feed (RFC-004) | Applied as F2 and F1 by the funds module, F2 only once the applied ledger position has reached its X (AI3-3). F1 from the **by-buyer view** (each movement whose home is the buyer); KP from the per-line `amount` and `postedTotal`; dedup by (view key, `EventId`) (C06) |
| **C07** invoice-status feed (RFC-004 receivables) | Per account: invoice overdue, paid, written off, credit limit removed, each with `ledger_pos` (the position of the account's last applied movement) and identity (partition, stream, `stream_seq`); applied as F6 (F5 for the credit limit) only once the applied ledger position has reached it (§7.3); a wrong-partition or unknown-type event held and alerted (C07 S4) |
| **C06** catalogue (RFC-003; link registry RFC-001) | Route price per Mbps-minute in force, by price version, **each version published at least 1 min before its effective minute**, freshness from the catalogue's closure markers (B-AI-11, §3.2); price-change announcements for open-ended reservations with route, version and effective minute, `price_notice` ahead; partner terms (minimum term, cancellation fee, whether a decrease is allowed, hold length, accepts expiry set by Share) by `termsVersion`. **Not consumed from the catalogue**: link validity rules (not in v1: the link decides validity, and intake records only the `policyVersion` it sends on the hold, RFC-000 AI-55-1) and probe designations (from placement's slot map, C06-M14) |
| **C01** account slot map and routing (RFC-006 placement) | `slotOf(account) → { slot, mapVersion, headDecides }`, `route(…)`; one probe account per slot, provisioned by placement, which designates it (F9 with the designating version); re-slotting and splitting as partition moves (§2.5) |
| **C12** equivalent-path source (routing, out of scope) | Candidate equivalent paths for a reservation, all-Share first, each a catalogue route with split weights registered before it is offered (RFC-000 AI-19-2, RFC-003); a candidate that is not, or that uses a link being retired, is refused and alerted (§9.4, §9.6); RFC-002 is its only consumer (AI-R1-5) |
| **C12** partner driver interface (adapter → driver) | §10.2 |
| Operational alert feed (C01 `<kind>.alert.v1`, RFC-006) | Alerts this RFC raises, with episodes and `cleared`: a request undecided at `D` (participants, and the account owner at takeover, with how long it has been pending, P2-S53); decision record unavailable at `D` or in the last `ack_budget` before it (P2-S104, P2-S106, P2-S114); a partner result unknown past `D − τ`; a cancellation at Share's cost outstanding; every reconciliation mismatch; identity freshness older than 30 s; a catalogue cache older than 60 s; an E11 written after its known effective minute (`delay_min` > 0); an F2 apply lag beyond `attribution_lag_max` (J-18); a cut re-target above the recorded one, a cut target for an unknown reservation or adding a part, a link `MISMATCH`; an unexplained `STALE_CHANGE`; a leg-command reply in the defect group (§9.8); `STALE_SENDER_UNMOVED`; late partner sends (C12 F12) |

### 14. Sizing at ×50 (POL-06; estimates)

Assumptions beyond POL-06's: 70% of route requests have a partner leg (C14), about 50
partner links with the hottest taking 25% of partner traffic, 100,000 active buyer accounts
(RFC-000 §6), 5% of requests contended enough to wait, changes at 10% of the booking rate,
probes at 3 a minute per account slot per serving region (X2-S27). Revision 4 recomputes the
transaction counts with slot batching and the funds entries the account owner also writes
(J-08).

| Quantity | Estimate | Note |
|---|---|---|
| Booking requests | 25,000/s: 20,000 single-link, 5,000 routes, 3,500 with a partner leg; plus probes, about 1,640/s over both serving regions (16,384 slots × 3 a minute × 2 regions, est.) | POL-06 mix; probes book only designated probe links |
| Account-log entries | Booking: intake 25,000/s + deciding 25,000/s + waiting marks about 1,250/s + yields (crossings, ≪ 1%) + E8 for requests ended after their holds (about 1,500/s) + changes about 5,000/s ≈ 58,000/s (E10 retired, §5.7). Funds (RFC-004 A §A11): F2 up to about 50,000/s, F1 about 2,700/s, F4 … F11 under 500/s. Probes about 3,800/s. Total about 112,000 entries/s system-wide (est.; RFC-000 §3 rev. 4.2 uses about 110,000) | About 400 B each: about 45 MB/s of new log; × 9 replicas of the account tables (5 voters, 4 non-voting). Coalescing F2 to the `attribution_lag_max` budget would remove most of 50,000/s (RFC-004 A; RFC-000 §3) |
| Account-log transactions | One lane per slot: at about 6.8 entries/s per slot and a lane about 0.11 occupied, most entries ride a transaction of their own: about 105,000 batch transactions/s (est.), plus report-position marker-only transactions, bounded by the outcome rate, up to about 20,000/s (est.), outside the lane (§8.3). Revision 3's "about 55,000/s" omitted the funds entries and was not reachable with one batch in flight per slot at 1,024 slots (review 18 J-08) | Each a two-region commit, about 30 ms p99 steady (RFC-000 §3); database capacity is RFC-006's (RFC-000 §6) |
| Account slots | About **16,384 slots** (est., RFC-000 §3 rev. 4.2: the occupancy target of about 0.15 per lane), the unit of the owner lease, renewed per process; about 6 accounts and 6.8 entries/s per slot on average; `W_a` about 20 ms p99 steady; one probe account per slot (placement, X2-S27) | Slots spread over the owner processes in the leader region (RFC-000 §3, AI-3); read-lease heartbeats per process; at 64 processes (est.) about 256 slots each. The second lane per slot is the fallback if the spike's account step exceeds 50 ms p99 (RFC-000 R23) |
| Hottest account | `account_rate_limit` 200/s → at most about 450 booking entries/s plus its F2; given a slot of its own (RB-4), one batch in flight, about 14 entries per batch at 30 ms commits | Its own entries fill its lane: + up to 10 ms per entry over `W_a` (RFC-000 §3), its wait only |
| Requests in flight | Single-link about 0.1 s × 20,000 = 2,000; routes about 2 s × 5,000 = 10,000; waiters up to their `D` | Tens of thousands of timer entries system-wide |
| Idempotency index | 25,000/s × 24 h ≈ 2.2 × 10⁹ rows system-wide, about 100 B each with index overhead ≈ 220 GB per replica; the hottest account 17 M keys | Row-level TTL; the owner keeps an in-memory filter per slot |
| Request records for status reads | About 2.2 × 10⁹ × 200 B ≈ 430 GB per replica, 24 h | Removed by TTL after `idempotency_retention`; log rows sealed to history (RFC-006) |
| Active reservations | About 63 M (RFC-000 §6) × 650 B (parts now carry their principal and key) ≈ 41 GB in owner memory system-wide, about 2.5 MB per slot, about 640 MB per owner process at 64 processes (est.) | Projection rows in the database besides |
| Status polls | Sized at 100,000/s (RFC-000 §6), over the four status readers, about 25,000/s each (est.) | Recent requests from the pushed batches in memory; older ones by follower reads on the facility's replicas |
| Outcome feed | 25,000 events/s plus markers; webhooks up to about 10,000/s (pending routes and contended requests, changes answered `pending` included, P2-S09); a marker's `pendingAnswered` list at most 5,000 ids per chunk (est.) | Notifier sized by RFC-006 (RFC-000 R10); sizing unchanged by C04 (est.) |
| Quotes (C10 AI-40-3) | Worst case one quote per booking and change: about 30,000/s system-wide, about 1.8/s per slot (est.); each about 0.05 ms of owner CPU (a cache read and one HMAC-SHA-256), **no lane write**, so about 1.5 CPU cores system-wide, about 0.025 core per owner process at 64 processes (est.) | Counted toward the booking rate limits, so an agent that quotes before every booking halves its own booking throughput at the limit; p99 under 50 ms within the region |
| Pre-emptive withdrawals | Rare (a withdrawal that overtakes its booking), well under 1% of withdrawals (est.); one E1′ each, removed by the index TTL | Inside the intake budget |
| Leg-command queues | One outstanding command per (reservation, leg): about 25,000 converts/s plus about 5,000 leg changes/s system-wide, almost always with an empty queue ahead; a second command for the same leg waits one round trip, about 5 to 10 ms (est.) | Only decisions on one reservation within milliseconds of each other wait (§9.8) |
| Partner calls | Hottest partner link about 875 requests/s → about 1,750 calls/s (hold and confirm) | Partner API capacity is a risk (RB-1) |
| Adapter log | About 5 journal entries per request → about 4,400 entries/s on the hottest partner link, about 130 per batch at 30 ms commits | The same order as the hottest Share link (RFC-000 §6); batching wait as R19 |
| Partner holds and tombstones | About 1,750 outstanding holds; about 260 releases/s × 120 s ≈ 31,500 tombstones on the hottest partner link | A few MB |
| Takeover and freshness | A takeover pulls one catch-up per slot (about 6 accounts' events, est. well under 1 KB normally); a region-wide failover staggers about 16,384 slot acquisitions by owner class (RFC-000 §3), so identity answers about 16,384 small consistent reads within the 1 min RTO; steady-state pulls only on a silent push | Identity's catch-up index by (account slot, commit timestamp), RFC-005 C3 |
| A deep reduction's cut targets | About 1 M targets over about a minute on the hottest link (est., RFC-001 §9): about 17,000 cut E11s/s over all slots (about one per slot a second), about 25,000 leg commands/s, about 17,000/s to the reduced link, coalesced up to 500 per call and paced by its acknowledgements; composition microseconds per reservation | §9.7; nothing reportable waits on the leg changes; Risk RB-21 |
| Offers and moves | At most one open offer per affected reservation; offer holds and partner bookings at acceptance on the scale of the affected set, spread over `offer_window` (est. well under 100/s system-wide) | §9.6 |
| Worst-case funding of queued changes | At 5,000 changes/s with about 10% queued behind another (est.), the extra hold is the envelope over the ahead change, held at most the change's deadline (≤ 60 s) | Released at the decision (J-01) |
| Latency | Single-link final answer about 176 ms p99 from R1, 186 ms from R2, 196 ms as the R2 probe measures it (146, 156, 166 ms with the second lane); the hottest link + 10 ms; route `pending` about 65 ms (160 ms after a region loss); route report about 115 ms after its ending entry (305 ms after a region loss); single-link after a region loss about 425 to 455 ms (RFC-000 R13); `+5` to 10 ms for a rejection's counter-offer queries | RFC-000 §3 rev. 4.2 budgets with `W_a` and `W_l`, est.; thin X2-S15 margin (RB-16) |

### 15. Design-level acceptance tests

Each test cites the scenarios it serves; RFC-006 runs them in the R1 spike environment.

| # | Test | Scenarios |
|---|---|---|
| T1 | A model (TLA+ or equivalent) of one account owner, two link owners and one adapter on the owner-lease protocol (epoch-conditional batches, lease expiry and takeover, ambiguous commits, a deposed owner resuming), with message loss and reordering, checking: no partial route; no E5 whose commit timestamp is at or past `D − τ`; no hold released before a committed non-confirmed outcome, an accepted yield or an accepted displacement; no non-confirmed outcome reported before its E8; a reported outcome never changes; every request decided by `D` while its record is available | P2-S04, P2-S05, P2-S10, P2-S14, P2-S93, P2-S99, P2-S103 … P2-S111, P2-S114 |
| T2 | Deterministic simulation of crossings and cycles of 2 … 6 requests over Share and partner links with random arrival, checking the oldest is confirmed before any deadline, no waiting set stays blocked, and `retry_after` is the latest remaining deadline ahead | P2-S15, P2-S16, P2-S19, P2-S60, P2-S87, P2-S88, P2-S89, P2-S96, P2-S97, P2-S116 |
| T3 | Fault injection on every crash point of §12.2 (S1 … S14 included: paused owner, ambiguous commit, pushed timestamp, range-lease move, lost publish, clock drift, reader loss, Kafka lag, silent identity push, a marker read meeting a pending reduction, an invoice event ahead of its ledger position, an owner down across a known effective minute, a late cut target, a suspension in flight at a partner confirm), each checked for its stated outcome; and a batch **pushed across 00:00 UTC** and across a fee-term end, checking that every recorded verdict equals a replay at the committed `ts` (J-03) | P2-S22, P2-S23, P2-S25, P2-S101, P2-S104, P2-S114, P4-S66 |
| T4 | A fake partner with failures, timeouts after the work, slowness and clock skew up to `σ_p`, checking reconciliation equality and no double booking | P2-S28, P2-S30, P2-S90, P2-S91, P2-S105 |
| T5 | Concurrent submissions with one key, different principals, different fingerprints (bookings and changes), and after retention | P2-S24, P2-S26, P2-S27, P2-S63 … P2-S65, P2-S113 |
| T6 | Concurrent changes to one reservation, with cancellations racing them; a decrease over a partner leg that forbids one; an extension queued behind an increase and behind a shorten, each ahead change confirmed or failed, checking the hold at intake covers the envelope, the excess is released at the decision and no queued addition suspends the account (J-01); a cut target and a move arriving with changes queued, checking only a change in progress on removed legs fails (J-15) | P2-S79, P2-S81, P2-S94, P2-S115, P2-S70, P4-S66 |
| T7 | Status readers under owner-lease failover, range-lease moves and reader lag, checking the replica rule and RQ-13's three properties (§8.2) | P2-S99, P2-S106, P2-S108, P2-S111 |
| T8 | Load at 25,000 requests/s plus probes and funds entries (about 112,000 entries/s), 200/s on one account, 100,000 polls/s, with about 16,384 account slots, measuring `W_a`, the account step's p99 (exit criterion 50 ms, RFC-000 R23) and latency per §14, with and without the second lane | X2-S03, X2-S05, X2-S15, X2-S06 |
| T9 | Concurrent requests of one account and key under random funds, limits and `wait = false` contention, checking every outcome against the arrival-order sequence of checks; key K books and another key or an administrator increases, and the reverse, checking each key's spending counts only the parts it added (J-02) | P2-S70, P2-S71, P2-S112, P4-S66, P2-S117 |
| T10 | Capacity reductions racing requests in every phase (Committing with partner confirms sent, answered and unknown included), checking §5.1's displacement rule: a request is confirmed after the reduction only if its E5 committed without seeing the marker, and then flagged affected and alerted; every other is decided against the reduced capacity with its partner bookings cancelled if it ends | P1-S41, P1-S42, P1-S63, P1-S78 |
| T11 | Holds of two accounts' requests delivered to one link in the reverse of their accounts' receipt order, with `wait = false`, and re-sent copies, checking every outcome against the link's order of first applied arrival | P1-S14, P1-S77 |
| T12 | A termination with and without `withhold_notice`, from compliance and from another role, and a later withhold request, checking the E11's record and whether the holder is told; a withheld termination that fails a pending change and an Accepted offer, checking that every event it causes, the later outcome events included, carries `withheld_by` and that no notice or webhook is sent while a status read gives the true state; `terminate` retried after a lost answer, after `not_after`, and with an identity that does not match the envelope | X1-S36, X1-S16 |
| T13 | Identity push blocked, identity reachable and unreachable, with a key revoked at `t0`: the revocation applied by catch-up within 60 s; with both unreachable, no E5 of the slot after `iam_fresh` + 45 s; a takeover pulls catch-up before its first decision | X1-S06, P2-S72, P2-S103 |
| T14 | Invoice-status events (overdue, paid, written off, credit limit removed) delivered before, with and after the F1 reaching their ledger position, across owner failover, checking standing changes only in ledger order; credit-limit commands with valid, expired, cancelled and wrong-role envelopes | P2-S42, P2-S69, P4-S82 |
| T15 | Moves and price changes whose cause arrives early, on time and after an owner outage spanning the effective minute; cut targets as minute pieces from two links and two reductions with different `T_eff`, delivered in every order, repeated, lowered (JI-5) and `none`, on reservations with parts of different windows, an increase added after the link's decision, a cancellation before the target, a move off the link before `T_eff`; checking the `min` per minute composition (equal to the link's rate per minute for one target), the absolute leg rates whatever the delivery order of `reduce_parts`, the `NOT_APPLIED` answers, and that no lifecycle entry is effective before its `ts` except a cut at `T_eff` | P1-S31, P1-S47, P1-S65, P1-S71, P4-S101, P4-S108 |
| T16 | Equivalent-path offers end to end: all-Share and partner paths; acceptance with the partner booking confirmed, refused, faulted and outstanding across an owner failover; an earlier move minute; an offer-scoped target from a reduction on the path then accepted, declined and lapsed; a move final after `T_eff`; `offer_accept` reaching a failing-over link after `move_at`; checking the old legs are ended only once the move is final, that a failed partner booking leaves only the affected Mbps removed (P1-S52 decline row), and that the next path is offered | P1-S35, P1-S52, P1-S53, P1-S57, P1-S60, P1-S61, P1-S64 |
| T17 | Attempts: a waiter granted then displaced, yielded then re-granted, and a `GRANTED` relayed after a later `query`; checking the recorded attempt equals the link's, `convert` after a grant is accepted, and a marker of any attempt drops E5 | P1-S11, P1-S78, P2-S16, P2-S97 |
| T18 | Quotes: a fee-bearing partner route booked citing a valid quote, citing none, citing an expired one, citing one whose fee changed at the catalogue, citing another account's token, and citing one issued before a re-slot; a batch pushed across a price version's effective minute; checking `quote_required`, `terms_changed` with `requote`, `404`, nothing held, and that no fee outside a cited quote is ever charged | P2-S121, P2-S50 |
| T19 | Withdrawals: a withdrawal of a pending key sent twice; a withdrawal of an unused key followed by a booking with it from the same principal and from another; a withdrawal and its booking racing at the owner; checking one outcome "withdrawn", nothing held, and `409` for another principal | P2-S122, P2-S56 |
| T20 | A booking and an extension over a link an operator has started to retire, with other legs held; and an equivalent-path candidate using it; checking "link unavailable" naming the link, no counter-offer, every leg released, the funds hold released, and no offer made on that path | P2-S120 |
| T21 | P2-S118's three-link case, with B's refusal and B's waiting hint in each order at L2, and across an owner failover; checking that B yields once it waits and A is confirmed before either deadline | P2-S118, P2-S19, P2-S87 |
| T22 | P2-S119: a confirm and then a cancel (and an increase then a decrease) one second apart, with `convert` answered `MOVING` or lost, the links learning of the two in each order, and a takeover between them; checking the capacity is free from `nb(ts)` on every leg, the part never accrues, and the change is reported only after E12 | P2-S119, P2-S43, P2-S48 |
| T23 | Outcome webhooks: a booking and a change answered `pending`, then decided; across an acquisition (the first marker lists every covered event) and an `adopt` (it does not); with a marker list above 5,000 ids; checking one webhook for each, also for the change, and none for a request answered finally | P2-S09, P2-S10 |
| T24 | Cut revisions: revisions 1, 2 (same content as 1) and 3 of one key, a redelivered revision 2, and a never-recorded revision 1 after 3; an offer-scoped target on a Final offer with `move_at` before and after `T_eff`; checking three `cut` events, the recorded and echoed replies, and a normal cut from `max(T_eff, move_at)` | P1-S84, P1-S52, P1-S61 |
| T25 | Partner reconciliation: SHARE_ONLY, PARTNER_SHORT (P2-S91 row 3's figures) and a later shorter PARTNER_SHORT, PARTNER_ONLY for a tombstoned request; checking one E14 replaced by less delivered capacity, the missing part treated as an outage, the holder told, and no buyer charge | P2-S91, P2-S32 |
| T26 | Credit limits: C07 v1.2's test K2d (four eyes above 10,000 USD and above the limit in force, decreases and removals with one operator, set-scoped members), a retry after the limit in force changed, and `iam_fresh` stale at the KYB step | X1-S49, P4-S82 |

## Benefits

Figures marked "est." are estimates from RFC-000 §3 and §6 and §14 above, to be replaced by
the R1 spike's measurements.

| Target or policy | How this design meets it |
|---|---|
| All or nothing, partners included (P2-N1, P2-N7) | One conditional decision entry per request in an insert-only log whose every commit is two-region durable, its decision row unique per request; every partner leg confirmed before it; every partner booking left without it cancelled at Share's cost; every crash point of §12.2 ends confirmed on every leg or holding nothing |
| One decision point (POL-04) | The first deciding record in the account log; suspension, revocation, withdrawal and expiry are all records in the same order (§5.6, §7) |
| `ack_budget` (POL-04, X2-N3) | Two two-region transactions at the account owner and one at the link on the single-link path, each with its batching wait: about 176 ms p99 from R1, 186 ms from R2, 196 ms as the R2 probe measures it (est., RFC-000 §3 rev. 4.2; 146 to 166 ms with the second account lane); `pending` for a route in about 65 ms (est.); no step of the workflow leaves the owner's region (RFC-000 §2) |
| Deadline (POL-26) | Confirm fence `D − τ` (about 420 ms before `D`, capped at about 450 ms, est.), checked against the commit timestamp; expiry at `D − ε − δ_x` with `δ_x` (batching waits included) to make releases durable by `D`; the last-`ack_budget` exception alerted (P2-S114); partner holds expire at `D`; adapters journal partner commits only before `D_c − σ_p`; partner confirms keep about 9.6 s (est.) of `commit_margin` |
| Capacity free once reported (RQ-6, RQ-8) | Request-scoped releases with tombstones; E8 gates every report; expiry outcomes reported no earlier than `D`; changes that free capacity gated by E12 |
| Contention (POL-02) | Waiters ordered by age at every link and adapter; yields accepted only from waiting holders, so every cycle breaks; partner refusals caused by Share's own holds and undecided bookings are queued and re-asked in priority order (§11) |
| Recovery (POL-03) | Nothing to rebuild beyond the log: the takeover runs indexed recovery queries, queries participants, whose logs are durable, and resumes every request (§12.1); admission's RTO of 1 min is the lease wait plus any range-lease move, seconds (est.) |
| Status reads (POL-04 as amended, RQ-13) | `pending` or the decided outcome while the record is unavailable, never another, never `pending` once the outcome was read or reported (§8.2) |
| Arrival-order checks (POL-25, POL-05 as amended) | Intakes composed one at a time in the owner's serial order and evaluated in it inside the batch transaction at its commit timestamp, each `admit` counting the holds then in place; nothing re-checked later (§3.1, P2-S112); every recorded figure equals a replay at that timestamp (J-03) |
| Agent spending caps (POL-25 as amended in v1.8) | Each part records the key that added it, so a key's spending is exactly the parts it booked or added; no key can spend through another's reservation (§9.1, P2-S117) |
| No suspension by surprise (POL-16) | A queued addition is funded at intake for the worst case of the changes ahead; a partner confirm is never sent into a suspension in flight; F5 and F6 apply in ledger order (§9.2, §5.5, §7.3) |
| Revocation within 60 s without Kafka (X1-N3) | Catch-up pulled after 20 s of silence; no confirm beyond 45 s of identity freshness (§5.6) |
| Retries (POL-29) | Dedupe in the intake entry's serial order, on projected state, so even simultaneous duplicates join one request; zero duplicate bookings by construction; a withdrawal is the same on every retry and stops a booking that it overtakes (§7.1) |
| Fees shown (POL-08 as amended in v1.11) | A stateless quote token carries the shown terms; a fee-bearing request must cite one, and is rejected with the current terms if they changed, so no buyer or agent is charged a fee it was not shown, and Share never absorbs one (§3.4) |
| Changes just after a confirmation (P2-S119) | One outstanding command per (reservation, leg), in deciding-entry order, also after a takeover: a cancellation is applied after the conversion on every leg, so the capacity is free from the stated minute whatever the order the links learn of them (§9.8) |
| Webhooks for every pending request (P2-S09) | `answered_pending` on the event and `pendingAnswered` on the first covering marker, so a change answered `pending` gets its webhook as a booking does, and a request answered finally gets none (§8.3) |
| Write cost | About 2.3 account-log entries per request on average (est., §14), and two transactions for a single-link booking (E10 retired), against 3 to 4 in RFC-000 revision 2 (a committing mark) and 2 + 1 per leg if every hold acknowledgement were logged (Competition) |
| Loss of supply (POL-07, P1-N8) | Cut targets composed by `min` per minute, exact for one link's decision, so no reservation loses more than the reduced capacity requires; a move is final only once every new leg is booked, so a failed partner booking never costs the holder more than a decline; attempts recorded as the link reports them, so a displaced granted hold is never confirmed unseen (§4.3, §9.6, §9.7) |
| Policy changes without mechanism changes | `priority_rule`, deadlines, `commit_margin`, `release_grace`, limits and partner terms are data read at the owner; the funds rules are a separate module behind §2.4 |

## Competition

| Alternative | Why it loses |
|---|---|
| **Saga with compensation, wound-wait and pinned holds** (the pre-baseline draft; history D13, D17, D21, D22) | Wound-wait lets an older request pre-empt any younger unpinned hold, which POL-02 forbids for a holder that is not waiting; its single coordinator process was a single point of failure; recovery failed in-flight sagas rather than resuming them (POL-03); holds expired by TTL, so a hold could lapse under a decision in flight. Kept: the commit point (D21), now the decision entry; holds that count against capacity (D14); waiting by default (D16) |
| **Partner legs first, in a fixed order** (D22) | Needed only because the partner ignored Share's priorities. With Share's own waiter queue and yields at each adapter (§10.5) the order is unnecessary, and taking every hold in parallel saves a partner round trip before Share's legs are held |
| **A durable workflow engine (Temporal, Cadence) as the coordinator** | Its history is a second log and a second writer beside the account log, giving each request two decision points again (RFC-000 A0-02); each activity costs a scheduling round trip on the 200 ms path; its persistence is not two-region-acknowledged by construction |
| **Logging every hold acknowledgement and partner send in the account log** | Makes takeover a pure replay, but adds one two-region write per leg per request (at 25,000/s, about 30,000 more entries/s, est.) and duplicates facts the link owners and adapters already hold durably; querying them on takeover costs one round trip per leg, only after a failure |
| **A separate withdrawing mark and deciding entry** (RFC-000 §3 as described) | Two writes where one conditional entry gives the same order (§7.1) |
| **Explicit deadlock detection** (a wait-for graph across links) | Needs a global view of holds and waits across link owners and accounts, a component RFC-000 rejects (§2, "Merges and splits"); POL-02's yield rule breaks every cycle locally, at the cost of some yields outside cycles (RB-3) |
| **Hold leases at the link** (holds expire by TTL unless renewed) | A lease can lapse under a confirmation in flight: a partly booked route or an oversell (A9). Expiry is a decision in the account log instead (RFC-000 A0-01) |
| **Re-checking headroom at the decision** | Would let a request that held funds at intake be rejected later for funds, and breaks POL-25's "funds before capacity" ordering argument; the hold taken at intake is bound instead (§2.4) |
| **Answering `pending` before the intake is durable** | A buyer told `pending` could lose the request in a failover and poll for ever; under A3 nothing is acknowledged before two-region durability |
| **Stateless invalid answers** (not recording invalid requests) | The selling horizon rolls, so a retry of an invalid request could later be accepted and booked, changing a reported outcome (P2-S10) |
| **Optimistic concurrency on reservations** (reject a change whose version is stale) | POL-08 requires changes applied one at a time in arrival order, each against the reservation as the previous left it; rejecting a concurrent change is not that |
| **Polling a busy partner** (the draft's 5 to 20 ms loop) | Costs partner calls and is first come, first served at the partner; re-asking on the resolution of Share's own blocking position, in priority order, is both cheaper and fair (POL-02) |
| **Sending partner confirms and the final-only booking always in parallel** | Faster by one partner round trip, but every refusal at the partner without holds then costs cancellations of confirmed held legs at Share's cost; used only when time to the fence is short (§5.5) |
| **Strict report-position knowledge** (a report only once a durable record of the report position itself is committed) | Would let replica rule 3 answer `pending` for every unreported outcome during a failover, as v1.5's P2-S111 read, at one more two-region commit on every report (about 30 ms steady, 70 to 75 ms degraded, est.). Not needed: v1.6 allows the decided outcome (RQ-13, B-RQ-7) |
| **Keeping E10 ("conversions done")** (revision 1) | On the substrate it is one more transaction per confirmed request for an idle account (about 25,000/s), only to bound what a new owner re-sends; the *conversions pending* query bounded by `D` + `release_grace`, and the link's own expiry request at `D`, give the same safety (§5.7) |
| **The database's serialisable transactions as the account's admission control** (many writers, conflicts retried) | Replaces the single writer with contention: concurrent requests of one account would conflict on its funds rows and retry, losing arrival order (POL-25), and every retry costs a two-region round trip. The database is the substrate under one writer, not the arbiter (RFC-000 Competition) |
| **Report-position markers per account** | One more transaction per outcome on an idle account; markers per slot in the next batch of any of its partitions cost about a sixth of that (§8.3, §14) |
| **Completing a displaced request whose partner confirm was journaled before the marker** (revision 2; RFC-000 rev. 4.1 §3) | Saves a partner cancellation at Share's cost when a reduction lands between a route's first partner confirm and its E5 (about 0.1 to 2 s per route, est.), but v1.7 decides that a confirmation seeing the displacement record is decided against the reduced capacity (POL-07, P1-S78). It also needed a second notion of "begun" (the adapter's journal time) compared across two owners' timestamps; the visibility rule is one read in one transaction. Cost of the rule: one partner cancellation per such race, at most one per reduction per displaced route (POL-28 bounded) |
| **Try-confirm-cancel with partners as the commit protocol** | This is what the design does for partners with holds; it cannot be the whole protocol, because Share's own legs and funds need a single decision point that partners cannot share |
| **Computing funds verdicts at composition, on the projected state** (revision 3) | Saves nothing measurable (the evaluation is in memory either way) but a batch pushed across 00:00 UTC, a fee-term end or a posting commits figures computed for another instant, which a replay at the commit timestamp then contradicts (review 18 J-03); RFC-004's in-transaction rule makes the log self-consistent |
| **Re-admitting a queued change at the head of its queue** instead of worst-case funding at intake (J-01) | Funds would be exact, but an agent would get no definite funding answer at intake, and a change could be refused for funds minutes later; POL-25 orders funds before capacity at intake. Worst-case holds tie up funds for at most 60 s (D-1) |
| **Attributing key spending per reservation** (revision 3) | One field fewer per part, but a key can spend without limit by increasing another key's reservation, which breaks POL-25's cap (J-02, P2-S117) |
| **Failing queued changes on any Share reduction or move** (revision 3) | Simpler, but POL-08 fails pending changes only when the reservation ends; buyers would have to resubmit changes a cut never touched (J-15) |
| **Coalescing applied unposted usage (F2) instead of more slots** (J-08 option c) | Would roughly halve the account entries; it is RFC-004's lever and compatible with this design, but more slots alone meet the budget and keep F2's freshness (RFC-000 §3) |
| **A second in-flight batch per account slot from the start** (J-08 option b) | Cuts `W_a` to about 5 ms but adds runtime sequence assignment and complexity; kept as the fallback the spike decides (RFC-000 R23) |
| **Waiting for the whole batch on a pending displacement intent** (revision 3) | Stalls every account of the slot for up to a link owner's lease when that owner dies mid-reduction; a savepoint with a lock timeout defers one confirm instead (J-14) |
| **Identity calling the account owner to force freshness** | A new identity → account owner path; the owner's own pull and 45 s gate fail safe without it (RFC-005 Competition) |
| **Per-part cut targets** (RFC-001's AI-R1-13) | Exact too, but a message per part and a second composition rule; RFC-000 rev. 4.3 chose minute pieces (AI-26-2), which compose by `min` per minute with the parts they cover (§9.7) |
| **Decrement leg changes for cuts** (revision 4: "reduce part p by x from T") | Two targets with different `T_eff` arriving out of order would stack decrements from the earlier minute on, over-cutting the later minutes, and no command can give back; absolute rates per part, ordered by change id, cost the same and are safe under any order (§9.7) |
| **Ending the old legs at acceptance** (revision 4) | Saves nothing, and a failed partner booking then leaves the reservation ended on its old link with no command to undo it (review 26 JI-3, P1-S61); ending them only once the move is final costs at most the partner booking's seconds (§9.6) |
| **The account owner numbering attempts** (revision 4: a grant as n + 1) | The link's attempt is the one its marker carries; an owner-side count disagrees after a grant, so a displaced granted hold would be confirmed unseen (review 26 JI-1, P1-S78) and every `convert` after a grant refused (JI-2) |
| **Restoring the full rate when a move becomes final after a cut** | Would need the cut Mbps back on legs the new path shares with the old one, a new admission that can fail half-way through a move; the reservation moves at its current rate instead, and the holder may book an increase (§9.6, B-RQ-11, decided in v1.10) |
| **Quotes as log entries** (a stateful quote record per quote) | Exact replay of every quote, but one more two-region write per quote, at up to about 30,000/s, for something that holds nothing; a MAC token with the shown terms gives the same safety rule (the terms compared at intake) with no write (C10 D3) |
| **A quote for every booking** | Simple for clients, but one more call on every route, also on routes with no fee; POL-08 asks for a quote only where a partner-leg fee is in the terms (review 65 decision 8) |
| **Checking a retiring link at intake from a link-registry input** | Would reject at E1′ with no funds hold taken, but adds a new consumed feed to the account owner and a second source of truth for link state; the link's own answer to the hold (C02 M-2) rejects at once, before any confirm, and releases the funds hold in the same E7 |
| **Leg commands in parallel, with the link reordering by change id** | One fewer round trip when two decisions on one reservation come within milliseconds, but a command names only the parts it changes, so an overtaken `convert` or `end_leg` is lost for ever (C02's P2-S43 trace); the per-leg queue costs one round trip only in that rare case (§9.8) |

## Risks and open issues

| # | Risk or issue | Mitigation or next step |
|---|---|---|
| RB-1 | **Partner API capacity at ×50.** The hottest partner link may need about 1,750 calls/s (est.), more than many operators' APIs allow. | Measure per partner at onboarding; the adapter rate-limits per partner and treats overload as transient (retried within the fence); commercial negotiation (POL-28). Batch APIs where partners offer them |
| RB-2 | **Partner clock skew and short deadlines.** With `σ_p` = 250 ms (est., now including `ε` = 100 ms and the commit-to-send bound), a route at the minimum 11 s deadline has about 750 ms from intake to its commit fence to get every hold; a slow partner hold call makes such routes fail with "deadline passed". | Measure `σ_p` and partner hold latency per partner; publish them in the catalogue's partner terms; RFC-006 alarms if `σ_p` exceeds its budget |
| RB-3 | **Yield churn.** Every waiting younger holder yields to an older waiter, even outside a cycle (the cost POL-02 accepts); on a hot link this adds yield entries, releases and re-grants. | The link asks only waiting holders whose release would let the older waiter fit (RFC-001); measured in T2 and on the hottest link |
| RB-4 | **Large accounts.** At 200/s for 24 h an account keeps about 17 M idempotency keys and request records (est.), and may hold many reservations. | Row-level TTL on the index and request rows (§3.3); an account at the limit gets a slot of its own; reservations can be sub-partitioned under the account's log without a second writer (RFC-000 R6) |
| RB-5 | **Co-dependency with RFC-004 Part A.** §2.4 is the interface; a change on either side changes both. | Approved together (RFC-000 §7); T1 models both modules' records |
| RB-6 | *(Closed in revision 6.)* Dependencies on RFC-001 interface points beyond RFC-000 §8 revision 4.3 (B-AI-13, JI-7). | Settled: RFC-000 revision 4.4 adopted B-AI-13, and the frozen C02 v1 states every one of them (covered parts, the offer flag, revisions, the replies, the absolute piece form, the per-leg order, `move_at` against the decision time, `newWaiterAttempt`) |
| RB-7 | **Partner unknown past the deadline.** A confirm whose result is still unknown at `D − τ` leaves a possible partner booking that Share pays to cancel. | Query at once (P2-S90); daily reconciliation; alerts; the cost is bounded by POL-28 |
| RB-8 | **Priority across accounts relies on clocks.** `request_age` is the intake entry's commit timestamp at different account owners, so "oldest wins" is exact only to within `ε` (100 ms) across accounts. Safety does not depend on it; ties and near-ties are resolved by request identity, deterministically. | `ε` monitored (RFC-006); the R1 spike measures it |
| RB-9 | *(Closed in revision 2.)* Poll limits per region. | RFC-000 rev. 4 moves `key_poll_limit` to the edge's key-sharded counters, exact except for one window after a shard move (AI4-6, §8.2) |
| RB-10 | **Counter-offer cost.** A rejection queries every Share leg's profile to the horizon (12 months at minute resolution) and sweeps them; for long or open-ended windows the sweep is large. | RFC-001's profile is run-length encoded (change points only); the sweep is over change points; bounded by `ack_budget` and "as far as computable" (POL-10) |
| RB-11 | **Complexity.** The account owner is a large state machine with two modules and many entry kinds. | T1 model checking before build; the entry catalogue of §2.2 is closed (no other kinds); every entry's apply is pure |
| RB-12 | **A confirm near its fence lost to a slow commit.** The fence is checked against the commit timestamp, so a batch committing slowly (a busy partition, a range-lease move, a pushed timestamp) drops a confirm that would have been in time by the owner's clock; the request then expires. | Safe by construction; the owner composes no confirm within one p99.9 commit of `D − τ` only if measurement shows this loses many; counted as "deadline passed" in RFC-006's metrics |
| RB-13 | **Inbound feeds on Kafka.** Key revocations (F4) reach the account owner through Kafka; a Kafka outage would delay ending a revoked key's undecided requests. | Revision 4: the owner pulls identity catch-up after 20 s of silence and confirms nothing beyond 45 s of identity freshness (RFC-005 C3, RFC-000 AI-R5-4), so X1-S06 holds without Kafka; RFC-006 alarms on feed lag |
| RB-14 | **Status reads during a range-lease move** wait for the new leaseholder under rule 3 (seconds, est.), and a reader without a lease refuses meanwhile. | Within P2-S111's 1 min bound; the R1 spike measures range-lease takeover (RFC-000 "Not resolved here") |
| RB-15 | **Partner cancellations on displaced routes.** Under v1.7 a route displaced after its partner confirms were sent but before its E5 is decided against the reduced capacity; if it then ends, Share pays to cancel its partner bookings. | Rare (a reduction meeting a route inside its commit window); counted as POL-28 residue events (§9.5) and in T10; a Committing request stops sending further partner confirms once the notice is applied (§5.1) |
| RB-16 | **Thin X2-S15 margin** (RFC-000 R23): about 196 ms at p99 as the R2 probe measures a single-link booking, with `W_a` included; drift, a facility lost in R2 or a path cut take it over 200 ms while they last. | Spike exit criterion: the account step's p99, batching wait included, at most 50 ms at the design load; otherwise the second lane is turned on before go-live (about 166 ms); T8 measures |
| RB-17 | **The 45 s confirm gate** stops every confirmation in a slot when both Kafka and identity are unreachable from it. | That combination already stops edges authenticating within 31 s; alarmed at 30 s of staleness; catch-up pulled every 5 s (RFC-005 RK-17) |
| RB-18 | **In-transaction evaluation lengthens batches** (about 0.1 ms per entry, est.) and a pushed transaction re-evaluates its whole batch, so contention on a slot's rows can churn. | Batches are small at 16,384 slots (about one entry each); pushes are rare off the hot rows; measured in T3 and T8 |
| RB-19 | **Catalogue freshness gate**: if the catalogue feed's resolved timestamp lags 60 s, intakes are not accepted (unavailability) rather than locking a stale price. | Depends on B-AI-11 (versions published ≥ 1 min ahead); RFC-006 alarms on catalogue lag; the cache is fed by Kafka in both Kenyan regions |
| RB-20 | **Probe load and noise at 16,384 slots**: about 1,640 probe bookings/s over both regions, and a minute is unavailable when one slot's measured probes all fail (POL-06 as amended in v1.8). | Probe accounts are ordinary accounts on designated probe links; placement provisions them; RFC-000 R24's lever (fewer slots and the second lane) if probe noise spends more than a tenth of the budget |

| RB-21 | **Fan-out of a deep reduction**: about 1 M cut targets on the hottest link give about 17,000 leg commands a second back to that link for about a minute (est.), beside its ordinary load. | Coalesced per destination and paced by acknowledgements; the link counts its decided removal until matched, so the lag never oversells and nothing reportable waits; T8 adds a reduction to half on the hottest link at design load |
| RB-22 | *(Closed in revision 6.)* A move final after a cut keeps the cut. | Decided in `requirements-v1.10` (POL-07 step 6, P1-S84; record 35); the holder is told at acceptance by `cut_kept` (C10 M6) |
| RB-23 | **Quote key custody.** The quote token depends on every owner-lease holder of a slot having the slot's quote key versions, and on their retirement only after the latest `valid_until`; a lost or early-retired version turns valid quotes into `terms_changed`. | Fails safe (the buyer gets the current terms and quotes again); key release by RFC-005 (B-AI-14); T18 covers re-slotting and rotation |
| RB-24 | **Leg-command queues serialise decisions on one reservation.** An agent that confirms and then changes a reservation within milliseconds waits one round trip per leg for the second command; a slow or failing-over link delays the queue of every reservation on it. | Only E12 and the report of a change that frees capacity wait; the link's own capacity is never oversold meanwhile (it counts the decided state); measured in T22 and T8 |
| RB-25 | **Late partner residues** are not recorded by the account owner (CI-B-1): C12 has no message that tells the owner of a booking the adapter found late and cancelled at Share's cost. | The reconciliation feed, the console and the alert carry it; the lifecycle feed's `pol28_residue` with `found_by` `late_answer` or `reconciliation` waits for the C12 amendment |

## Requirements issues

**Resolved in `requirements-v1.6`** ([review 11](../reviews/11-requirements-amendments-from-detailed-rfcs.md)).
Each issue revision 1 raised against `requirements-v1.5`, and where revision 2 applies the
decision:

| # | Issue (revision 1) | Decision in v1.6 | Applied in |
|---|---|---|---|
| B-RQ-1 | "Some one-at-a-time order" cannot cover a request refused for funds held by a concurrent request that later fails | Coordinator: funds, key-headroom, capacity-in-flight and link checks run one at a time in arrival order, each counting the holds then in place; outcomes need only match that sequence (POL-25, POL-05; P2-S70, P1-S14, P4-S66 amended, **P2-S112**) | §2.4 (interface point 1), §3.1 step 4, §3.2; T9 |
| B-RQ-2 | A pending request that no longer fits after an outage, already being decided | Coordinator, with RQ-R1-1: a request that **had begun committing** when the reduction was recorded may complete; its reservation is affected like any other and network operations is alerted; every other request is decided against the reduced capacity (POL-07; P1-S41 amended, **P1-S63**). The "within `status_staleness`" bound was not adopted | §5.1 (displaced row), §13.1, §13.2; T10; see B-RQ-9 |
| B-RQ-3 | Rule-based refusals called "rejected" | *Rejected* includes a request a booking rule of POL-08 or POL-28 does not allow; the rejection states the rule (glossary *Outcome*) | §3.2 |
| B-RQ-4 | `retry_after` with several blockers | The latest of their remaining deadlines, 0 for each already decided (POL-05, POL-02, POL-10; **P2-S116**, P1-S70) | §5.1, §5.8 step 5, §6.2; T2 |
| B-RQ-5 | Sameness of a change request | Same reservation, kind of change, new end or new rate, and `wait`, from the same principal (POL-29; **P2-S113**) | §3.1 step 3, §9.2; T5 |
| B-RQ-6 | A record available again just before the deadline | "Unavailable at the deadline" includes any time in the last `ack_budget` before it; releases within `release_grace`, alerted (POL-26; **P2-S114**) | §6.1, §6.4, §12.2 (C15, S4); T1, T3 |
| B-RQ-7 (with RFC-000 RQ-13) | During a failover a replica cannot tell a reported outcome from an unreported committed one | Coordinator: while the record is unavailable a status read of an unreported outcome may report `pending` or the decided outcome, never another, and never `pending` once reported or once the decided outcome was read (POL-04; P2-S111 retitled, P2-S106) | §8.2 (the three properties), §12.2 (C12); T7 |
| B-RQ-8 | A decrease over a partner leg whose terms do not allow one | Rejected, stating the rule; the buyer may cancel instead. Revision 1's proposal (Share keeps paying the partner) not adopted (POL-08; **P2-S115**, P2-S50 amended) | §2.2 (E1′, E1 terms shown), §3.2, §9.2, §9.3; T6 |

Also applied from v1.6, though raised by other RFCs: RQ-R1-8 (window "now", §3.2), RQ-R1-9
(counter-offers beside held capacity, §5.8), RQ-R1-11 (a moved part keeps its age, §9.4),
RQ3-4 (a shortening into a minimum term pays the shown fee, §9.3, §9.5), RQ3-5 (a price
change re-prices every part, §9.4), RQ-E ("told", §8.3).

**Resolved in `requirements-v1.7`** ([review 12](../reviews/12-requirements-amendments-from-rfc-revision-2.md)).

| # | Issue (revision 2) | Decision in v1.7 | Applied in |
|---|---|---|---|
| B-RQ-9 | "Had begun committing when the reduction was recorded" cannot be judged at the instant of the record | Coordinator: judged exactly, with no window, by whether the reduction's displacement record is visible to the transaction confirming the request; one that sees it is decided against the reduced capacity (POL-07 *When it is judged*; P1-N1; **P1-S78**; glossary *Affected reservation*). Revision 2's bounded-window reading was not adopted | §2.5 step (3), §4.2, §5.1 (displaced row), §5.6, §12.2 (C18, C19), §13.2; T10; RB-15 |

Also applied from v1.7, though raised by other RFCs: RQ-R1-14 (checks at a link in the order
requests reach its schedule owner; P1-S14, **P1-S77**; §5.1, §13.2, T11), RQ6-2 (every
account slot probed each minute; X2-S27; §2.5, §13.1, §14), RQ5-12 (withholding a
termination notice only within the termination; X1-S36; §9.4, §13.1, T12). The other v1.7
amendments touching this RFC's policies (POL-15 top-up order, POL-23 superseding records,
POL-32 erasure by compliance, POL-07 rises in capacity at the first boundary at or after
their record) change rules owned by RFC-004 Part A, RFC-003, RFC-005 and RFC-001; this RFC
consumes their results unchanged (no entry kind, port or check of this RFC depends on them).

**Resolved in `requirements-v1.8`** ([record 22](../reviews/22-requirements-amendments-from-c3-reviews.md)).

| # | Issue | Decision in v1.8 | Applied in |
|---|---|---|---|
| B-RQ-10 (= review 18 Q-4) | Two senses of "begun committing" in POL-07 and POL-26 | Coordinator: POL-07's "had begun committing" is judged only by whether the confirming transaction sees the displacement record ("judged as below"); POL-26's sense governs only the commit fence; a partner route whose confirmation sees the record is decided against the reduced capacity, its partner booking cancelled at Share's cost if it fails (POL-07, POL-26; P1-N1; P1-S63, P1-S78; glossary *Affected reservation*) | Unchanged from revision 3's reading: §5.1, §5.6, §12.2 (C18, C19), RB-15 |
| Review 18 Q-2 (raised from J-02) | POL-25's "the key's reservations" when another principal adds to one | Key spending counts the charges and holds of the parts the key booked or added (POL-25, P2-N8, **P2-S117**; glossary *Key spending*) | §9.1, §2.4 (interface point 9), T9 |
| Review 18 Q-1 (raised from J-18) | The lateness bound omitted admission's recovery time | POL-14's bound adds admission's 60 s (430 s at the defaults); a record counted later than `attribution_lag_max` is still a breach | §12.2 S8, §13.2 (alert) |
| Review 18 Q-3 (raised from J-20) | "Resume amount" versus "overdue amount plus the resume amount" | The resume amount is the least top-up that resumes, quoted itemised (POL-16, P4-S114) | §2.2 (E1′), §2.4 (`answer`), §7.2 |

Also applied from v1.8, though raised by other RFCs: RQ-19-1 and RQ-19-2 (a shorten to a
later end pays only a minimum-term fee its new end falls inside; a booked window ending
inside a minimum term pays the fee shown on the offer; P3-N12, P3-S63, P3-S74; §3.2, §9.3,
§9.5, §13.1), RQ-R6-1 and the amender's decision 1 (each account slot probed at least 3
times a minute from two locations; X2-S27; §2.5, §14), RQ-R6-2 (one delivery may carry many
notices; POL-04, P1-N8; §8.3), RQ-17-1 (capacity in force as the least of the announced
capacity and every open outage; P1-N1, P1-N8: the link's rule, which this RFC meets by
`min`-composed cut targets, §9.4). The other v1.8 amendments touching this RFC's policies
(POL-06 disaster evidence, POL-23 dearer-path and supplier-error rules, POL-32 account
recovery and workforce administration) change rules owned by RFC-006, RFC-003 and RFC-005;
no entry kind, port or check of this RFC depends on them.

**New in revision 4.** None (business points decided in the text: worst-case funding of
queued changes, §9.2; an open-ended booking after a price announcement carrying the
announced step, §3.2; a partner charge for a shorten its shown terms do not make a fee
borne by Share, §9.5; unavailability rather than a stale locked price, §3.2).

**Applied from `requirements-v1.9`** ([record 28](../reviews/28-requirements-amendments-from-c3-round-2.md)).
The amended P1-N8 and POL-07 (maintenance outside the committed rate, never a reason to
cut a reservation, itself cut at a reduction's effect; from a notice's end the committed
rate counts each reservation at the rate the reduction leaves it) are the link's rules
(RFC-001); this RFC meets the reservation side unchanged: it applies only the cut targets
the link sends, exactly (§9.7, "never beyond what the reduced capacity requires"), and a
maintenance cut is told to the supplier by RFC-001 and the notifier, not through the
account owner. POL-06's `slot_probe_limit` (1 s) changes RFC-006's measure, not the probe
accounts (§2.5). POL-32's held recovery rights are RFC-005's; the account owner takes
principals and rights from RFC-005 as before, so a held right is not presented to it. No
entry kind, port or check changes.

**Resolved in `requirements-v1.10`** ([record 35](../reviews/35-requirements-amendments-before-c4.md)).

| # | Issue (revision 5) | Decision in v1.10 | Applied in |
|---|---|---|---|
| B-RQ-11 | A move that becomes final after the reduction's cut | Coordinator: POL-07 step 6, "A move final after the cut": the move carries the reservation at its cut rate; the holder is told at acceptance and may book an increase on the new path as a new admission (POL-08); Share-leg capacity held beyond the cut rate is released at the move; a move final by the notice's end moves at the full rate (P1-N8, **P1-S84**; glossary *Equivalent path*). Revision 5's reading is the decision | §9.6 (`cut_kept` at acceptance, `reduce_parts` after `ACCEPTED`), §9.7, §13.1; T16, T24; RB-22 closed |

The other v1.10 amendments (POL-06's failing slot-minute and probing fault, X2-S30, X2-S33;
POL-22 and POL-32 on payout destinations, X1-S46, P4-S118; POL-23's late POL-07 cut,
P4-S117) change rules owned by RFC-006, RFC-005 and RFC-004; no entry kind, port or check of
this RFC depends on them.

**Applied from `requirements-v1.11`** ([record 65](../reviews/65-requirements-amendments-after-c4.md)).
Each v1.11 amendment matches a frozen contract that this revision applies.

| Record 65 item | Policy, scenario | Where applied |
|---|---|---|
| 13 (RQ-40-3) | POL-29: a withdrawal names its request's key, is the same on every retry, and a withdrawal of an unused key makes a later request with it fail "withdrawn"; a cited quote is not part of sameness; **P2-S122** | §3.1 step 3, §3.3, §7.1, §8.2; T19 |
| 15 (RQ-40-5), 11 (RQ-40-1) | POL-08 "Shown terms": shown means in a quote the request cites; a fee-bearing booking, extension or increase must cite one; a request whose quote expired or whose terms changed is rejected with the current terms; glossary *Quote*, *Outcome*; **P2-S121** | §2.2 (E1, E1′), §3.2 check 4, §3.4, §13.1; T18; B-RQ-12 |
| 12 (RQ-40-2) | Glossary: *Not accepted* covers a body that cannot be parsed as a request; *invalid* breaks a validity rule | §3.1 step 1, §3.2 (C10 M7) |
| 19 (RQ-42-1) | POL-07, POL-10: a link being retired sells nothing more; "link unavailable", naming the link, no counter-offer; no offer uses it; **P2-S120** | §2.2 (E7), §5.1, §5.8, §9.6; T20 |
| 20 (RQ-42-2) | POL-02: a holder that kept its capacity while not waiting yields once it starts to wait; **P2-S118** | §5.3, §11; T21 |
| 26 (RQ-54-1) | A cancellation or a decrease just after a confirmation frees the capacity on every leg from the next minute boundary; **P2-S119** | §5.7, §9.2, §9.8, §12.2 S21; T22 |
| 22 (review 43 RQ-2) | P2-S09: every request answered pending, a change included, gets its webhook | §8, §8.1, §8.3; T23 |
| 21 (review 43 RQ-1) | POL-30: a withheld termination notice covers every notice and webhook the termination causes; status reads stay true; glossary *Told*; X1-S36 row 2 | §9.4 (termination row), §13.1; T12 |
| 9 (review 38 RQ-2) | POL-28: a reservation the partner has only in part is affected on that leg for the missing part; P2-S91 row 3 | §2.2 (E14), §9.4, §10.6; T25 |
| 14 (RQ-40-4) | POL-16: the resume quote states the headroom after it, as an explanation, not an item; P4-S114 | §2.4 (`answer`), passed through (RFC-004's figures) |
| 6 (RQ-37-2) | POL-32: a credit limit above `credit_limit_four_eyes_above` needs a second finance operator; X1-S49 | §7.3, §13.1; T26 |

The other v1.11 amendments (POL-14's cap and window, POL-19, POL-21, POL-24, the
enforcement-time convention, P3-S76 … P3-S78, P4-S119, P4-S120, X1-S11, X1-S24, X1-S47,
X1-S48) change rules owned by RFC-003, RFC-004, RFC-005 and RFC-006; this RFC consumes
their results unchanged.

**New in revision 6.**

| # | Issue | Policy or scenario | Reading adopted meanwhile | Proposed amendment |
|---|---|---|---|---|
| B-RQ-12 | **When a recorded partner term is in force.** P2-S121 row 4 records a fee of 3.000000 USD at 09:00:30 and expects a booking at 09:01 citing Q1 to be rejected with the new fee. The owner reads terms from a catalogue cache that may lag up to 60 s (§3.2), so a term in force from the instant it is recorded cannot be seen at intake 30 s later with certainty. Nothing in POL-08 or POL-32 says when a partner term recorded by commercial takes effect | POL-08 "Shown terms"; P2-S121 row 4 | **Business decision:** a partner-terms version takes effect at its `effectiveFrom`, at least 1 min after it is recorded (as price versions, B-AI-11), and a quote's `valid_until` is never later than a known next version. So in row 4 a fee recorded at 09:00:30 is in force from 09:01:30; a booking at 09:01 citing Q1 is decided on Q1's terms (2.000000 USD, which the buyer was shown), and one at 09:02 citing Q1 is rejected with the 3.000000 USD fee. Trade-off: one minute of delay for a commercial change, against a buyer never charged a fee not shown and an intake that never waits for the catalogue | POL-08: add "A change of a partner's terms takes effect at a stated time at least one minute after it is recorded; a quote is valid at most until then." P2-S121 row 4: "after an operator in commercial recorded a fee of 3.000000 USD for P at 08:59:30, effective from 09:00:30" (or the booking at 09:01:31) |

## Architecture issues

**Resolved in RFC-000 revision 4** (its "Revision 4 resolution").

| # | Issue (revision 1) | Resolution | Applied in |
|---|---|---|---|
| B-AI-1 | No link hold port command for a confirmed leg | `end_leg` and `reduce_parts` with change id and decision time; `convert` carries reservation and part (AI-R1-1) | §2.2 (E11), §9.3, §9.4, §13.2 |
| B-AI-2 | No notice for a held request that no longer fits | `DISPLACED` on the waiting port; `displacement_accept` or the release on the outcome and expiry port; an already decided confirmation stays confirmed, affected and alerted (AI-R1-3, AI-R1-4) | §5.1, §13.1, §13.2 |
| B-AI-3 | The hold lacked the commit fence | The hold carries `D_c`; granting skips waiters past it (AI-R1-9) | §1.3, §5.1, §11, §13.2 |
| B-AI-4 | Booking-rate counters cannot be log entries | Owner memory, rebuilt from the last second's intakes; up to twice the limit for one second after an owner change | §1.2, §3.1 |
| B-AI-5 | The "interrupted" reason | Erratum adopted: "interrupted" only for a takeover at or after `D` | §6.2 |
| B-AI-6 | "Found" in replica rule 3 | Committed in the database, read at the present timestamp; the decided outcome allowed by RQ-13 | §8.2 |

**Resolved in RFC-000 revision 4.1** (its "Revision 4.1 errata").

| # | Issue (revision 2) | Resolution | Applied in |
|---|---|---|---|
| B-AI-7 | The capacity-reduction path ended a displaced request rejected even if it had begun committing | Erratum: ended rejected only if it has not begun committing; one that had begun goes on to its outcome, which answers `DISPLACED` (RFC-000 §3, §8). Its "partner confirm journaled" example of begun is overtaken by v1.7 (B-AI-9) | §5.1, §13.2 |
| B-AI-8 | Report-position markers need a batch to ride in | Markers per account slot, carried by any batch in the slot or a marker-only transaction within about 20 ms (est.); outcome topic keyed by slot (RFC-000 §4.6, §6, §8) | §8.3, §13.1, §14 |

**Resolved in RFC-000 revision 4.2** (its "Revision 4.2 errata"), with review 18's architecture issues.

| # | Issue | Resolution | Applied in |
|---|---|---|---|
| B-AI-9 (= review 18 A-4) | RFC-000 kept the partner-confirm exception the requirements removed | AI-17-6: begun only if the confirm transaction committed without seeing the marker; a partner booking of a displaced request is cancelled at Share's cost | §5.1, §5.6, §13.1 (outcome and expiry port) |
| B-AI-10 | One probe account, but every slot must be probed | One probe account per account slot; placement (RFC-006) owns the account slot map, which this RFC reads and keeps no copy of | §2.5, §13.1 (slot-map row removed), §13.2 |
| Review 18 A-1 (from J-05) | No invoice-status feed or credit-limit command | Invoice-status feed with ledger positions, applied once the applied ledger position reaches them; credit-limit command under a finance envelope | §2.3 (F5, F6), §7.3, §13.1, §13.2 |
| Review 18 A-2 (from J-08) | Batching waits missing from the budget | `W_a` and `W_l` budgeted; about 16,384 account slots; marker-only transactions outside the lane; the second lane as fallback | §1.3, §2.5, §8.1, §14, Benefits, RB-16 |
| Review 18 A-3 (from J-07) | Timer-driven E11s broke the closure | Causes known in advance recorded before their minute; cuts effective at `T_eff` under the open-reduction closure rule | §2.2 (E11), §2.5 step 3, §9.4, §13.1 |

**Resolved in RFC-000 revision 4.3** (its "Revision 4.3 errata").

| # | Issue | Resolution | Applied in |
|---|---|---|---|
| B-AI-11 (revision 4) | No freshness rule for the catalogue's prices | Price versions published at least 1 min ahead with resolved timestamps; consumers locking prices gate on freshness within 60 s | §3.2, §13.2 (catalogue), RB-19 |
| B-AI-12 (revision 4) | Probe frequency in RFC-000 trailed v1.8 | 3 a minute from two locations, about 820 a second per region | §2.5, §14 |
| AI-26-1 (review 26 JI-1, JI-2) | `convert` without the attempt; grants numbered by the owner | `convert` with the attempt; `HELD`, `GRANTED`, `DISPLACED` carry the attempt the owner records, a grant keeping it | §4.3, §5.1, §5.2, §5.6, §5.7, §13.2 |
| AI-26-2 (review 26 R26-04, D3) | Single-rate targets over-cut | Minute-piece targets composed by `min` per minute | §9.4, §9.7, §13.1 |
| AI-26-3 (review 26 R26-01) | POL-07 leg changes could not be matched to their cut | `reduce_parts`/`end_leg` carry (link, reduction) for cause POL-07 | §9.7, §13.2 |
| AI-27-1, AI-27-2 (review 27) | Lapsed renewals and moved partitions not fenced for readers | Acquisitions for reporting; readers answer a moved partition by rule 4; `adopt` after the old report position passes `moved` | §2.5, §8.2 |
| AI4-11 (RFC-004 rev. 4) | Identity freshness in F4 | Slot watermark in owner memory; F4 only for status changes | Already in revision 4: §1.3, §2.3, §2.4 |

**Resolved in RFC-000 revisions 4.4 and 4.5** (their "Revision 4.4 errata" and "Revision 4.5
errata", RFC-002 rows), with the frozen contracts.

| # | Issue | Resolution | Applied in |
|---|---|---|---|
| B-AI-13 (revision 5) | The cut-target and POL-07 leg-change signatures were not enough to apply targets exactly and safely | RFC-000 revision 4.4 adopted it as raised (covered parts, the offer flag, `APPLIED`/`NOT_APPLIED`/`KEPT_FOR_OFFER`, absolute pieces for every `reduce_parts`, change-id order); C02 v1 states it, with the revision (C4-2) and the reply in place of `cut_target_answer` (C4-1) | §9.7, §9.8, §13; RB-6 closed |
| C4-1 … C4-4 (RFC-000 4.4) | Cut answer form, target revision, stale leg changes, `end_leg` pairs | Settled by C02 C4-1 … C4-4 | §2.5, §9.7, §9.8, §13 |
| C4-7, AI-33-1 (RFC-000 4.4) | `Stopped`, `headDecides` routing, the splitting slot | Settled by C01 §10.3 | §2.5, §3.1, §12.2 S20, S25 |
| AI-33-2 (RFC-000 4.4) | The initial report position after any acquisition, cited in the P2-S111 argument | Settled by C01 §3.1 | §2.5, §8.2, §12.1 |
| RFC-000 4.5, RFC-002 row | One outstanding command per (reservation, leg), takeover included, `STALE_CHANGE` answered; revisions and the Final-offer cut; markers with `prevReportPosition`, `pendingAnswered` and chunks; the three early-effective exceptions; `terminate` by (account partition, `action_id`); `iam_fresh` applied and gap-free with the snapshot; `usage_applied_since`; the booking API's quote, offer answers, four families and pre-emptive withdrawal; the partner port's `change`, binding, confirm fence and `partner_leg_affected`; no link validity rules and probe accounts from the slot map | Interface points of RFC-000 4.5 | Every row of the "Revision 6 resolution" table |
| AI-40-3, AR-3 (routed to RFC-002 by RFC-000 4.5) | C10's RFC-002 errata (check order, pre-emptive withdrawal, the quote operation and its key, quote sizing); C12's adapter errata (high-water, takeover rule, `changeSeq` order, reconciliation deferral, late sends) | Applied here | §3.2, §3.4, §7.1, §8.2, §10.4, §10.6, §13.1, §14 |

**New in revision 6** (RFC-000 is not changed here):

| # | Issue | RFC-000 reference | What this RFC assumes | Proposed resolution |
|---|---|---|---|---|
| B-AI-14 | **Custody of the quote key.** C10 D3 makes the quote token a MAC under a per-account-slot key held by every owner-lease holder of the slot, never the edge, and gives RFC-002 its custody and rotation (AI-40-3). The owner has no key material of its own: keys reach owners only by RFC-005's key release | §8 (column encryption, key release) | The slot's quote key versions are released by RFC-005 to the holder of the slot's owner lease, as its column keys are; a new version every 24 h (est.), a version retired no earlier than the latest `valid_until` under it (§3.4) | Add to §8's key-release row: "per-account-slot quote keys, released to the slot's owner-lease holders only; RFC-005 to add the key-release entry" |
| B-AI-15 | **Lead time of partner terms.** B-AI-11 makes price versions take effect at least 1 min after they are published, so a 60 s fresh cache holds every version in force. Partner terms (fees, minimum terms, `decreaseAllowed`) have no such rule, and the quote check (§3.4) compares them at `ts` | §8 (catalogue) | Partner-terms versions carry `effectiveFrom` at least 1 min after their record, as price versions (B-RQ-12's decision) | Extend the catalogue row's B-AI-11 rule to partner-terms versions (RFC-003 publishes them; C12's `Classification.effectiveFrom` already exists) |

## Contract issues

The frozen contracts bind this RFC. These are real defects found while applying them. This
RFC does not edit a contract; each issue states the reading adopted meanwhile.

| # | Contracts | Defect | Reading adopted meanwhile | Proposed amendment |
|---|---|---|---|---|
| CI-B-1 | C04 (m-11, PL-9, consumer obligation "§10.4, §10.6"), C12 (§2.1 `PartnerResult`, F6, S1) | C04 requires the **account owner** to record a partner booking found later for a tombstoned request or a failed offer, cancelled at Share's cost, in an entry that emits `pol28_residue` with `found_by` `late_answer` or `reconciliation`. C12 makes the adapter the only component that cancels a residue, has no `PartnerResult` kind that tells the owner of it, and names the console and the notifier as the only consumers of the reconciliation feed. So the owner can never write that entry | The adapter cancels the residue at Share's cost (C12); operations learns of it from the reconciliation feed and the alert; the account owner writes **E16** only when told, so the late `pol28_residue` events are missing until C12 is amended (§9.5, §12.2 S26, RB-25). Rating then has no Share-cost line for a late residue; finance sees it in reconciliation | C12: add `PartnerResult { kind: 'RESIDUE_CANCELLED'; partnerBookingRef; foundBy: 'late_answer' \| 'reconciliation' }`, request-scoped identity (request or (reservation, offer), operation `release`), sent by the adapter after its J5 cancel; the account owner writes E16 from it |
| CI-B-2 | C02 (yield claims, D2, D3), C12 (§2.1 `YieldRequestMsg`, §5.1 `yield_answer` key, §5.2 sameness) | P2-S118 on a **partner** leg: a holder Y that refused a yield for attempt a and then starts to wait must accept a new yield request for the same attempt. C12 keys `yield_answer` by (request, leg, operation, attempt) and compares the answer, so the second answer (accept after refuse) is a `MISMATCH`, and the adapter's re-ask after Y's hint cannot succeed. C02 solves the same case for links with a claim | On a partner leg, a holder that refused a yield keeps its partner hold until its own outcome; the older waiter is re-asked in priority order when Y resolves (§10.5). P2-S118's case on Share links is fully met (§5.3); on partner links the guarantee holds only after Y's outcome, within Y's deadline. The adapter asks a holder to yield only when it believes it waiting (C12 §3.4), which keeps the case rare | C12: add `claim` to `YieldRequestMsg`, to the `yield_answer` identity and to sameness, with C02's rules (a refusal ends only its claim; a new claim on a waiting hint with none open) |

## Revision 6 resolution

What changed from revision 5, and why. The sources are `requirements-v1.10` and
`requirements-v1.11` (records 35 and 65), RFC-000 revision 4.5 (its RFC-002 rows of the
4.4 and 4.5 errata), and every erratum, consumer obligation and settled item that names
RFC-002 in the frozen contracts C01 … C12. The joint interface with RFC-004 Part A is
unchanged: it is C05 v1 as stated.

| Finding or issue | Source | Change | Sections |
|---|---|---|---|
| Contracts govern the interfaces | RFC-000 4.5 | Header, §1.1 and §13 state that C01 … C12 are the authority; §13 rewritten as a summary of them | Header, §1.1, §13 |
| P2-S118 (POL-02, RQ-42-2) | v1.11; C02 review 42 M1, review 54 M3, m1, D2, D3 | Yield claims: E3 records the claim, answers name it, a refusal ends only its claim, a holder that starts to wait accepts the new claim | §2.2 (E3), §5.3, §11, §13; T21 |
| P2-S119 (RQ-54-1) | v1.11; C02 C4-3, review 42 D1, review 54 D1, D2, V61-1 | One outstanding command per (reservation, leg) in deciding-entry order, takeover included; `convert` with `createdBy` in the sequence; the reply groups; `STALE_CHANGE` answered | §5.7, §9.2, §9.7, §9.8 (new), §12.1 step 4, §12.2 S21; T22 |
| P2-S120 (POL-07, POL-10, RQ-42-1) | v1.11; C02 M-2 | `UNKNOWN_LINK`, `LINK_CLOSING`, `LINK_RETIRED` end the request "link unavailable", naming the link, no counter-offer; an offer never uses such a link | §2.2 (E7), §3.2, §5.1, §5.8, §9.6; T20 |
| P2-S121 (POL-08, RQ-40-1, RQ-40-5) | v1.11; C10 M2, D1, D3, AI-40-3 | The quote operation, its stateless token, its key custody and rotation, the terms check at `ts`, `quote_required` and `terms_changed` with `requote`; quote sizing | §2.2 (E1, E1′), §3.2 check 4, §3.4 (new), §13.1, §14; T18; B-RQ-12, B-AI-14, B-AI-15 |
| P2-S122 (POL-29, RQ-40-3) | v1.11; C10 M5, D4 | A withdrawal names its request's key; a pre-emptive withdrawal of an unused key; never "no such request" | §2.2 (E1′), §3.1, §3.3, §7.1, §8.2, §12.2 S22; T19 |
| P2-S09 changed (review 43 RQ-2) | v1.11; C04 M-01, B-01, MM-10 | Every change gets an outcome event; the E11 and E12 are reporting entries; `answered_pending` and `pendingAnswered`; the notifier's rule | §2.2 (E11, E12), §8, §8.1, §8.3; T23 |
| P2-S91 changed (review 38 RQ-2) | v1.11; C12 m12, D5, V6 (a) | `partner_leg_affected` on the reservation command port with `delivered`; E14's replacement rule; the missing part an outage | §2.2 (E14), §9.4, §10.6, §13; T25 |
| X1-S36 row 2 (review 43 RQ-1) | v1.11; C04 M-04, MM-8, D-3 | Every event a withheld termination causes carries `withheld_by`; no notice or webhook; status reads true | §8.3, §9.4, §13.1; T12 |
| P4-S114 changed (RQ-40-4) | v1.11; C10 AI-40-4 | The resume quote's headroom after it, passed through | §2.4 (`answer`) |
| POL-32 four eyes (RQ-37-2) | v1.11; C07 v1.2 E-v1.11-1, C08 v1.2 | Approver verified with the envelope; four eyes decided against `CL` at apply, after deduplication, not recorded; the approver in F5 | §2.3 (F5), §7.3, §13.1; T26 |
| B-RQ-11 resolved | v1.10, record 35 | Moved to the resolved table; `cut_kept` at acceptance (C10 M6); P1-S84 cited; RB-22 closed | §9.6, Requirements issues, Risks, Traceability |
| P1-S84 cited | C02 V61-2, review 54 m8 (errata owed); C04 m-10 | Cited in §9.6, §9.7 and the traceability; the move's `reduce_parts` stated, only after `ACCEPTED` (C02 review 42 M3) | §9.6, §9.7, Traceability; T24 |
| `Stopped`, `Moving`, `MOVED(slot, generation)`, canonical refusals | C01 §10.3, M4, C4-7; RFC-000 4.4 | Routing refusals and `Stopped` handled on every path; `503` to buyers | §2.5, §3.1, §5.1, §9.8, §12.2 S20 |
| Routing by `headDecides`, splitting slots, `ackSplitting`, `listPartitions`, creation in `s + n` | C01 §3.8, R47-02, R47-05, R47-29, V59-2; AI-33-1 | Stated | §2.5, §12.2 S25 |
| `onMovedOut`, `onAdopt` | C01 §10.3, C4-7 | Hook table; timers cancelled and re-armed; re-sends in leg order | §2.5, §6.1, §12.1 |
| Initial report position after any acquisition | C01 §3.1, AI-33-2 | Stated and used in the P2-S111 argument | §2.5, §8.2, §12.1 |
| Status readers on the substrate | C01 R47-17 | `leasedRead`, `isMovedOut`, `replicaRule3Check` | §8.2 |
| `pendingAnswered`, marker chain, acquisition list, chunks | C01 V59-1, N-02, N-12; C04 B-01, MM-10, MM-11 | Stated | §8.1, §8.3, §12.1, §13.1 |
| Markers only by the runtime; dedup by (partition, stream, `stream_seq`) | C01 M5, M6, R47-22; C06-M10; C07 F4 | Stated | §2.5, §7.3, §8.3, §13 |
| `iam_fresh` from closure markers, applied and gap-free; price-cache freshness from the catalogue's | C01 M7, R47-10; C05 S-2; C08 S-M6, S-G1, V56-7 | §1.3 definition; the snapshot asked at once; not a precondition | §1.2, §1.3, §2.4, §2.5, §12.1, §13.2 |
| `STALE_SENDER` per D4 | C01 R47-09 | Deposed only for an equal generation and a higher epoch; else the command dropped and the slot kept | §2.5, §5.1, §9.8 |
| Probe accounts from placement's slot map | C01 M11; C06-M14 (D7); C04 MM-1, CC-1; C07 S1 | F9 from the slot map with the designating version; `account_is_probe` a copy; not from the catalogue | §2.3 (F9), §2.5, §13.1, §13.2 |
| `Ambiguous` and the `COMMIT` backstop | C01 M1; RFC-000 4.5 | Nothing decided in the slot until the present-time resolution completes | §2.5, §12.2 S2 |
| Projection keys led by the account | C01 R47-01 | Stated | §2.5 |
| `cut_target` answer is the reply; the link re-sends | C02 C4-1 | Stated; not a notification | §2.5, §9.7, §12.2 S13, §13.1 |
| Target revision; repeat, lower, higher rules; covered parts across revisions; `MISMATCH` | C02 C4-2, R39-01, V52-1, review 54 M4, m7; C03 rule 3; C04 MM-3, M-02 | Recording table rewritten; one E11 and one `cut` per higher revision | §2.2 (E11), §9.4, §9.7, §13.1; T24 |
| Revision on the lifecycle `cut` | C03 M2; C04 MM-3 | `target_revision` on `cut` | §9.7, §13.1 |
| Offer-scoped target on a Final offer | C02 V52-2, review 54 M5; C04 N-03; C03 R39-03 (b) | A normal cut from `max(T_eff, move_at)`; `offer_cut_kept` before Final; nothing after an offer ended without a move | §9.6, §9.7 |
| One cause `POL07`; `applies` only for it | C02 M-3, C4-4 | "revoke" removed | §9.7 |
| Leg-command replies table | C02 review 54 M1 | §9.8 | §9.8 |
| Synchronous commands are not outbox notifications; `expire_if_undecided` as a gRPC command | C02 erratum (b) | Stated | §2.5, §6.3 |
| A present marker of any attempt stops E5 | C02 erratum (c) | §2.5 step 3, §4.3, §5.6, §13.2 rewritten | §2.5, §4.3, §5.6, §12.2 S19, §13.2 |
| `offer_outcome_if_lapsed` | C02 M-1 | Answered with `offer_accept` or `offer_release` again | §6.3, §13.1 |
| `offer_release` to every leg that got `offer_hold` | C02 review 42 M4, review 54 m4 | Stated | §9.6 |
| Routing to an account partition; per-item envelopes | C02 review 42 M2, review 54 m3 | Stated | §5.1 |
| Displacement table key without a slot | C02 review 42 M7 | Stated | §13.2 |
| Reporting entries E11 and E12 for changes | C04 M-01 | Stated | §2.2, §8 |
| `fee_id`; the move's old partner-leg fees paid by Share | C04 MM-2, M-03 | Stated | §2.2 (E11), §9.5, §13.1 |
| `account_is_probe` on lifecycle events | C04 MM-1, CC-1 | Stated | §13.1 |
| Window-end E11, deferred while an addition at the window end is undecided | C04 MM-5, M-07, D-4 | §9.1 | §2.2 (E11), §6.1, §9.1, §9.4 |
| Change event with E11; `leg_changes_durable` with E12 | C04 MM-6 | Stated | §13.1 |
| `offer_*`, `offer_cut_kept`; no separate notices feed | C04 MM-7 | Stated | §2.5, §9.6, §13.1 |
| `terminate`: identity, lookup first, check order, audit-only refusals, `target_version` | C04 M-05, m-12, m-15, D-5, N-04, N-08 … N-10 | Termination row rewritten; E15 added | §2.2 (E15), §9.4, §13.1 |
| `pol28_residue` for a late-found booking | C04 m-11 | E16 added; channel missing in C12 | §2.2 (E16), §9.5, §12.2 S26; CI-B-1 |
| Release after grace `delay_min`; only `ended(released)` notifies | C04 MM-4, MM-9, m-01 | Stated | §9.4 |
| At most one shown fee per leg; termination and release fees; `cancelled_after_cut` | C04 N-05, N-06, N-07 | §9.5 | §9.5, §9.4 |
| Three early-effective exceptions; revocation a cut to 0 | C04 M-06, MM-12; C05 S-5 | Stated | §2.2 (E11), §9.4, §9.7, §13.1 |
| `provisionalKey` (signed bytes) and `checked` in E1/E1′; a revoked or wrong-tenant record refused | C05 S-1, m13 | Stated | §2.2, §2.4, §3.1 |
| `QueuedChange` fields; `ReservationChanged.effectiveMinute` | C05 S-6, C-1, C-3 | §2.4 table | §2.4 |
| Credit-limit order with deduplication first; `temporarily_unavailable{identity_stale}`; no version-v membership; supersession; `ledger_pos` per account | C05 S-3, S-7; C07 S1, R37-01, R37-03, R37-04, D49-5; C08 S-M1 | §7.3 rewritten | §2.3 (F5), §7.3, §13.1 |
| Status readers re-check the principal context; `NOT_FOUND` | C05 m5; C10 M4 | Stated | §8.2 |
| Usage-applied in C06's form; `usage_applied_since` on the status readers; retention ≥ 7 days | C05 S-4; C06-M1 | Stated | §13.1 |
| F1 from the by-buyer view; KP from `amount` and `postedTotal`; dedup by (view key, `EventId`) | C06 RFC-002 obligations | Stated | §13.2 |
| No link validity rules from the catalogue | C06 (AI-55-1); RFC-000 4.5 | Stated | §13.2 |
| F9 records the designating slot-map version | C07 S1, R37-13 | Stated | §2.3 |
| F4: snapshot; dedup by (partition, sequence) plus key version; absent key revoked | C05 M3; C08 S-G1, m8 | Stated | §2.3 (F4), §2.4 point 14 |
| Target summaries: console session, purpose-bound, audit before the answer | C08 S-G3, D3, V56-4 | Stated | §13.1 |
| Envelope check order and key source | C08 R46-01, R46-13, R46-17, D5 | Stated | §7.3, §13.2 |
| Booking API: check order (`unknown_route`, `product_not_on_route`), malformed bodies, four families, offer answers, cancel as a change kind, `Stopped`, `blocking_partner_link`, `key_expires_at`, `fees[]` | C10 AI-40-3, M1 … M9, D2, D6, R40-12, R40-25 | §3.1, §3.2, §9.6, §13.1 | §3.1, §3.2, §9.6, §13.1 |
| Partner port: `change` for shorten and decrease; additions as requests of their own; shorten never rejected; decrease through amend | C12 S1, D1, V4, V5 | §3.2, §9.3 | §3.2, §9.3, §13.1 |
| Intake deadline rule F11 | C12 F11, V7 | §3.2 check 2 | §3.2 |
| `outcome_confirmed` with `partId`; `cancel` reservation-scoped, no residue reasons | C12 S1 (§13.1), F3, F6 | Stated | §5.7, §13.1 |
| J11; booking sets, scheduled cancels, high-water as adapter state | C12 S1 (§10.1), F3, F4, F7 | §10.1 | §10.1 |
| Driver `amend`, `queryRef`, future-dated `cancel`, capabilities | C12 S1 (§10.2) | §10.2 | §10.2 |
| `amending` and `cancel_scheduled` transitions | C12 S1 (§10.3) | §10.3 table and diagram | §10.3 |
| High-water per partition (release exempt); takeover rule F10; `changeSeq` order F5; late sends F12; reconciliation deferral F13 | C12 AR-3 (F5, F7, F10, F12, F13) | §10.4, §10.6 | §10.4, §10.6 |
| Partner keys for amend and cancel; canonical JSON | C12 §5.3, m3 | §10.7 | §10.7 |
| Reconciliation feed identity and kinds; consumers console and notifier | C12 V6 (b), F13, F14 | §10.6, §13.1 | §10.6, §13.1 |
| A cut sends `change(cause = cut)` to a partner leg with amend | C12 V6 (c), m8 | §9.7 | §9.7 |
| Classification conditions; `σ_p` listing condition | C12 F11, D6, V7, m13 | §10.1 | §10.1 |
| Partner `hold` with `wait`; `REFUSED(IN_FLIGHT)` from the adapter | C12 m6 | §5.1 | §5.1 |
| Late partner residue cannot reach the owner | C04 m-11 vs C12 | Raised | CI-B-1, RB-25 |
| P2-S118 on partner legs | C02 vs C12 yield keys | Raised | CI-B-2, §10.5 |
| P2-S121 row 4 and the time partner terms take effect | v1.11 | Raised; business decision taken | B-RQ-12, B-AI-15, §3.4 |
| Quote key custody | C10 D3, AI-40-3 | Raised | B-AI-14, RB-23 |
| B-AI-13 resolved | RFC-000 4.4 | Moved to the resolved table; RB-6 closed | Architecture issues, Risks |
| Tests | — | T12, T17 updated; T18 … T26 added | §15 |
| Traceability | `requirements-v1.11` | P2-S118 … P2-S122, P1-S84, P4-S114 added; P2-S09, P2-S91, X1-S36 updated; header "P2-S01 … P2-S122" | Header, Traceability |

## Revision 5 resolution

What changed from revision 4, and why. Joint items JI-1 … JI-7 are review 26's (RFC-001
revision 4 against RFC-002 revision 4); JI-6 is RFC-006's.

| Finding or issue | Change | Sections |
|---|---|---|
| JI-1 (Major); RFC-000 AI-26-1 | The owner records the attempt `HELD`, `WAITING`, `GRANTED`, `DISPLACED`, `WAITER_REFUSED` and the yield and displacement acknowledgements carry, never numbering one; a grant keeps the waiter's attempt; the marker check compares the marker's attempt with the recorded one | §1.2, §4.3, §5.1, §5.2, §5.3, §5.6, §12.2 (L4, S19), §13.2; T17 |
| JI-2 (Major); AI-26-1 | `convert(request, attempt, reservation, part, T_dec)` with the recorded attempt, re-sent on takeover with the attempt learned by `query`; `hold` carries no attempt | §5.1, §5.7, §12.1, §13.2 |
| JI-3 (Major); review 26 D4 | The move is final only once every new leg is booked; only then `offer_accept` and the old legs' `end_leg`; a failed partner booking is a decline with the old legs untouched; offer state machine | §2.2 (E11, E13), §9.4, §9.6, §12.1, §12.2 (S17, S18); T16 |
| JI-4; review 26 D5 | Offer-scoped targets kept against the offer, applied only on a final move, dropped otherwise; `offer` flag asked of RFC-001 | §9.6, §9.7, B-AI-13 |
| JI-5 | A later target for the same key taken as the per-minute `min` with the recorded one; a higher piece ignored and alerted | §9.7, §12.2 (S16), §13.1 |
| JI-7 | `nb(ts)` defined; `move_at ≥ nb(ts)` of the final entry; the link to check against the carried decision time and apply a late acceptance as decided (interface point) | §1.3, §9.6 |
| Review 26 D3; RFC-000 AI-26-2 | Cut targets as minute pieces with covered parts; composition by `min` per minute, oldest Mbps kept first; exact for one link | §1.2, §9.1, §9.4, §9.7, §13.1; T15 |
| RFC-000 AI-26-3; review 26 R26-01 | POL-07 `reduce_parts`/`end_leg` name the (link, reduction) pairs applied; absolute part rates ordered by change id; `NOT_APPLIED` answers so the link withdraws decided removals for ended or departed reservations | §9.7, §12.2 (S15), §13.2, B-AI-13 |
| Review 26 R26-16 | The link's moving mark is not relied on: a target from a link left by `T_eff` is not applied here | §9.7 |
| RFC-000 4.3: AI-27-1, AI-27-2 | Lapsed renewal and re-home as acquisitions for reporting; replica rules 2 and 4 for moved partitions; re-slotting as partition moves | §2.5, §8.2 |
| RFC-000 4.3: AI6-6 | No `COMMIT` timeout; batches not at `COMMIT` abandoned within the lease margin | §2.5 |
| RFC-000 4.3: AI-27-3; RFC-003 rev. 5 | Closure markers are the relay's per-destination minima; the lifecycle `cut` event carries (link, reduction), the pieces or `none`, and the resulting part rates | §2.5, §9.7, §13.1 |
| RFC-000 4.3: B-AI-11, B-AI-12, AI4-11 | Resolved; moved to the resolved table | Architecture issues |
| RFC-006 rev. 4 | Slot map via `slotOf` with map version; `StaleEpoch`, `Moved`, `Moving`, `STALE_SENDER` handled by re-routing with the same identity; events and notifications through `append`, notifications via `onNotification`; (generation, epoch) on every command, partner port included | §2.5, §3.1, §5.1, §10.1, §10.4, §13.1, §13.2 |
| RFC-004 rev. 5, RFC-005 rev. 5 | F4 never for a heartbeat or catch-up without events, `id_ts` only for dedup; set-scoped credit-limit actions: one envelope per member, `member` outside the signed digest, checked against the own account and F9, `out_of_scope` and `kyb_not_vetted` refusals, once per (`action_id`, account) | §2.3, §7.3, §13.1 |
| `requirements-v1.9` (P1-N08, POL-06, POL-07, POL-32) | Reviewed: no mechanism change here | Requirements issues |
| Review 31 K-1 | Set-scoped credit-limit membership checked against the signed set at slot-map version v (C9) with the envelope, `out_of_scope` before `kyb_not_vetted` | §7.3, §13.1 |
| Review 31 K-3 | `admit` and `apply` schedules carry each part's current rate as minute pieces | §2.4 |
| Review 31 JI-9 | `cut_target` parameter order aligned with RFC-001 rev. 5: (link, reduction, reservation, parts, pieces \| none, offer?) | §9.4, §9.7, §13.1, B-AI-13 |
| New issues | B-RQ-11 (move after a cut), B-AI-13 (target and leg-change signatures) | Requirements issues, Architecture issues, RB-6, RB-21, RB-22 |

## Revision 4 resolution

What changed from revision 3, and why. Review 18's findings owned by RFC-004 alone (J-06's
rules, J-09's state, J-11, J-16, J-20) are RFC-004's; this RFC supplies only the inputs named.

| Finding or issue | Change | Sections |
|---|---|---|
| J-01 (Major), D-1 | A queued addition records `ahead` and its interval; funded for the worst case of the changes ahead; the excess released at its E5; a change's legs taken at the head | §2.2 (E1, E5), §2.4 (`admit`, point 8), §9.2; T6 |
| J-02 (Major), D-2; v1.8 POL-25, P2-S117 | Every part records the principal and key that added it; key spending counts the parts a key added | §1.2, §2.4 (point 9), §9.1, §13.1 (lifecycle feed); T9 |
| J-03 (Major) | Funds verdicts, `D`, `D_c` and every time check evaluated inside the batch transaction at `ts`; the projected state only orders; a push re-evaluates the batch (RFC-004 JR-7) | §1.3, §2.1, §2.4, §2.5 step 3, §3.1 step 4, §12.2 S3; T3 |
| J-04 (Major); RFC-004 JR-4 | F11 registered, one per (account, price version), with one price-change E11 in the same entry | §2.3, §2.4 (JR-4, point 5), §9.4; T15 |
| J-05 (Major); RFC-000 A-1 | Invoice-status feed consumed with the ledger-position gate; credit-limit command accepted with envelope verification | §2.3, §7.3, §12.2 S11, §13.1, §13.2; T14 |
| J-06 (Major, RFC-004's) | F6 *written off* registered and gated with the rest | §2.3, §7.3 |
| J-07 (Major), D-3; RFC-000 A-3, AI-17-3 | Moves and price steps recorded when known, with future effective minutes; late causes take the next boundary and alert; cuts as target rates effective `T_eff`, composed by `min` | §2.2 (E11), §2.5 step 3, §9.4, §12.2 S12, S13, §13.1; T15 |
| J-08 (Major), J-19; RFC-000 A-2, AI-17-5 | About 16,384 slots, `W_a` budgeted, transactions recounted with funds entries, marker-only transactions outside the lane, the second lane as fallback; latency claims restated (176 / 186 / 196 ms) | §1.3, §2.5, §8.1, §8.3, §14, Benefits, RB-16; T8 |
| J-09 (Minor, RFC-004's) | E11 records when a shown fee becomes due | §2.2 (E11), §9.5 |
| J-10 (Minor); RFC-004 JR-9 | F7 committed only at or after its instant; five F7 variants registered | §2.3, §2.4, §2.5 step 3 |
| J-12 (Minor), D-6; RFC-004 JR-10 | Standing and key status checked on the projected state before a partner confirm; re-checked when the batch resolves | §2.4, §5.5 step 1, §12.2 S14 |
| J-13 (Minor) | Three-variant (now five-variant) F7; `rate_check(…, now, …)`; E1′ records `admit`'s inputs and verdict; a suspension ends only undecided additions | §2.2, §2.3, §2.4, §7.2 |
| J-14 (Minor) | Marker reads under a savepoint with a lock timeout; a timeout defers one E5 | §2.5 step 3, §5.6, §12.2 S10; Competition |
| J-15 (Minor) | A cut or price step fails no change; a move fails only a change in progress on removed legs; queued changes stay queued | §9.4; T6 |
| J-17 (Minor) | E1 records the catalogue price version and position; intakes composed only while the cache is fresh; raised as B-AI-11 | §2.2, §3.2, RB-19 |
| J-18 (Minor); v1.8 Q-1 | S8 states the F2 lag gap; alert on F2 apply lag | §12.2 S8, §13.2 |
| D-5; v1.8 Q-3 | Resume amount itemised in rejections | §2.2 (E1′), §2.4, §7.2, §13.1 |
| B-RQ-10 resolved in v1.8 | Moved to the resolved table; reading unchanged | Requirements issues |
| RFC-000 4.2: AI-17-1 | Hold carries kind, `wait`, receipt minute, policy version; `wait = false` decided at the link (`IN_FLIGHT` refusal with tombstone) | §5.1, §13.2 |
| RFC-000 4.2: AI-17-2 | Link notifications as state messages deduplicated by identity; reconcile `query` on a timer; per-stream sequences on feeds | §2.5 (feeds), §5.1, §8.3, §13.2 |
| RFC-000 4.2: AI-R5-4 (RFC-005 C3); RFC-004 JR-11 | Catch-up pulled on takeover and after 20 s of silence; E5 only within 45 s of the slot's identity-freshness watermark, kept by booking | §1.2, §1.3, §2.5, §5.5, §5.6, §12.2 S9; T13; RB-13, RB-17 |
| AI4-11 (coordinator's binding decision) | `iam_fresh` advances in owner memory on every push heartbeat's resolved timestamp and every catch-up's read timestamp, event or not; F4 (with `id_ts`) written only for actual status changes, none for an event-free heartbeat; unset (stale) after a takeover until the first heartbeat or catch-up | §1.2, §1.3, §2.3 (F4), §2.4 (watermark row, point 14), §5.6 |
| RFC-000 4.2: AI-R5-1 (RFC-005) | Operator check for envelopes; read grants and audit append on status readers' operator reads; target summaries served | §7.3, §8.2, §9.4, §13.1, §13.2 |
| RFC-000 4.2: AI-R6-1 … AI-R6-3, AI-17-4 | Session revocation on acquisition; reporting only after `read_lease` + `ε`; generations in rows and commands; session timeouts and high-priority takeover reads | §1.3, §2.5, §8, §12.1, §13.1, §13.2 |
| RFC-000 4.2: B-AI-10 | Slot map read from placement; RFC-002's slot-map contract removed | §2.5, §13.1, §13.2 |
| RFC-000 4.2: AI-19-2; RFC-003 rev. 4 | Moves carry the catalogue route ID and shown price; offered paths that are not catalogue routes with split weights refused; shown fees carry their kind and a due-at-window-end flag; end cause "ended at its window's end" | §2.2, §9.1, §9.4, §9.5, §13.1, §13.2 |
| v1.8: RQ-19-1, RQ-19-2 (P3-S63, P3-S74) | Fee rules: plain fee only on a cancellation; minimum-term fee on a shorten into the term or a booked window ending inside it, shown on the offer | §3.2, §9.3, §9.5, §13.1 |
| v1.8: RQ-R6-1, decision 1 (X2-S27); RQ-R6-2 | Probes at 3 a minute per slot from two locations, sized; told on a shared delivery's first attempt | §2.5, §8.3, §14 |
| `τ`, `δ_x`, partner window per RFC-000 §4.3 rev. 4.2 | `τ` about 420 ms (cap 450), `δ_x` 105 to 300 ms, partner window about 9.6 s | §1.3, §5.5, §6.5, §10.4, Benefits |
| New issues | B-AI-11 (catalogue price lead time), B-AI-12 (probe frequency in RFC-000) | Architecture issues |
| P2-S117, P3-S74, P4-S101, P4-S108 | Traceability rows added; header updated | Traceability |

## Revision 3 resolution

What changed from revision 2, and why.

| Finding or issue | Change | Sections |
|---|---|---|
| B-RQ-9, decided in v1.7 (review 12): begun committing judged by visibility of the displacement record | The partner-confirm exception removed; begun only if E5 committed without seeing the marker; a displaced route with partner confirms sent is decided against the reduced capacity, its partner bookings cancelled at Share's cost if it ends; Committing may go back to Waiting; marker checked per held attempt | §2.5, §4.2, §5.1, §5.6, §12.2 (C18, C19), §13.2; T10; RB-15; Competition |
| RQ-R1-14 in v1.7: checks in the order requests reach the link's schedule owner (P1-S14 retitled, P1-S77) | Order at a link stated: first applied arrival of `hold`, no cross-account order imposed; hold-order consumed contract | §5.1, §13.2; T11 |
| RQ6-2 in v1.7: every account slot probed each minute (X2-S27) | Slot map with `slot_of`, published to RFC-006; at least one probe account per slot, kept across re-slotting; sizing | §2.5, §13.1, §13.2, §14 |
| RQ5-12 in v1.7: withholding decided with the termination (X1-S36) | `withhold_notice` only in the termination envelope, recorded in E11 and carried on the lifecycle feed; refused from other roles while the termination takes effect; no later withhold command | §9.4, §13.1; T12 |
| B-AI-7, B-AI-8 resolved in RFC-000 rev. 4.1 | Moved to the resolved table; RB-6 updated | Architecture issues, Risks |
| Conflict between RFC-000 rev. 4.1 and v1.7 on the partner-confirm exception | Raised as B-AI-9; the requirements' reading adopted | Architecture issues |
| "The designated probe account" vs one per slot | Raised as B-AI-10 | Architecture issues |
| POL-07's two senses of "begun committing" | Raised as B-RQ-10; the *When it is judged* rule adopted for POL-07, POL-26's for the fence | Requirements issues |
| v1.7 amendments with no effect here (POL-15 top-up order, POL-23 superseding records, POL-32 erasure, rises in capacity from the first boundary at or after their record, P1-S40 and P1-N8 retitled) | Reviewed; no change: their owners are RFC-004 Part A, RFC-003, RFC-005 and RFC-001 | Requirements issues |
| P1-S14, P1-S63 traceability; P1-S77, P1-S78, X1-S36, X2-S27 added | Traceability rows | Traceability |

## Revision 2 resolution

What changed from revision 1, and why.

| Change | Cause | Sections |
|---|---|---|
| Substrate mapping: tables, epoch-conditional batch transactions, commit timestamps and the fence checked against them, the decision row, lease takeover and recovery queries, outbox feeds; "leader" → owner, "term" → epoch, "log index" → sequence | RFC-000 rev. 4 (RK10, §5.5) | §1.3, §2.1, §2.5, §12, §13 |
| `τ` about 260 ms, `ε` 100 ms, `δ_x` configured at p99.9, `read_lease` about 400 ms; latency figures re-derived (115 / 125 ms single-link, 45 ms `pending`) | RFC-000 rev. 4 coordinator decision (1), AI-1 | §1.3, §5.5, §6, §8.1, §10.4, §14, Benefits |
| Commit fence renamed `D_c` and set to `D − τ` without a partner leg | RFC-000 §4.3, AI-R1-9 | §1.3 and throughout |
| Status readers per Kenyan facility with follower reads; rule 3 on the owner-lease row; RQ-13's three properties; poll limit moved to the edge | RFC-000 rev. 4 (AI-4, B-AI-6, AI4-6), v1.6 (RQ-13) | §8.2, RB-9, RB-14 |
| Report-position markers per slot | Raised as B-AI-8 | §8.3 |
| E10 retired; conversions re-sent from a recovery query | Substrate cost | §2.2, §5.7, §12.1 |
| Displaced requests decided by "had begun committing" | v1.6 (B-RQ-2, RQ-R1-1); B-AI-7, B-RQ-9 | §5.1, §13 |
| Arrival-order checks stated; `admit` order an interface point | v1.6 (B-RQ-1) | §2.4, §3.1, §3.2 |
| Change sameness, decreases forbidden by partner terms, last-`ack_budget` exception, `retry_after` | v1.6 (B-RQ-5, B-RQ-8, B-RQ-6, B-RQ-4) | §3, §6, §9 |
| Counter-offers beside held capacity; window "now"; minimum-term fee on a shortening; price change on every part; offer-hold commands; POL-28 residue events; effective-time closure; usage-applied acknowledgement | v1.6 (RQ-R1-8, RQ-R1-9, RQ3-4, RQ3-5), RFC-000 §8 rev. 4 (AI-R1-2, AI3-2, AI3-3, AI3-4) | §3.2, §5.8, §9.3 … §9.5, §13 |
| JR-1 … JR-4 resolved; interface points for RFC-004 Part A listed | RFC-000 rev. 4 (AI4-3, B-AI-4) | §2.4 |
| Crash points rechecked; C18, A4 and S1 … S8 added | Substrate | §12.2, T3 |
| Tests T9, T10 added; T1 models the owner-lease protocol | v1.6, substrate | §15 |

## Traceability

Every P2 scenario, and every scenario of another spec with a part allocated to the
account owner's booking module or to partner adapters (RFC-000 §7), mapped to the
section that satisfies it. "RFC-004 A" marks rules the funds-and-standing module supplies
through §2.4; "RFC-001" and others mark the primary owner where this RFC supplies only the
booking side.

| Scenario | Title | Satisfied by |
|---|---|---|
| P2-S01 | A route whose every leg fits is confirmed on every leg | §5.1, §5.6, §5.7 |
| P2-S02 | A route with a leg that does not fit is rejected, naming that leg, and holds nothing | §5.1, §5.7, §5.8 |
| P2-S03 | Confirmed is never reported before every leg, the partner's included, is secured | §5.5, §8.2 |
| P2-S04 | Whatever fails, a route never ends booked on some legs only | §5.5, §12.2 |
| P2-S05 | A confirmed route ends only at its account's request or by Share's decision under the supply-loss, suspension and termination policies | §9.1, §9.4 |
| P2-S06 | Every booking request gets a response within ack_budget | §3.1, §8.1 |
| P2-S07 | A request whose outcome is known within ack_budget gets its final outcome | §8.1 |
| P2-S08 | A request whose outcome is not yet known is pending, and the outcome can be polled with its idempotency key | §8.1, §8.2 |
| P2-S09 | A buyer who registered a webhook is sent the outcome of each request answered pending, a change included | §8, §8.1 (`answered_pending`), §8.3 (markers with `pendingAnswered`; the notifier's rule); T23 |
| P2-S10 | An outcome never changes once reported | §8, §8.2 |
| P2-S11 | A request without a deadline gets the default deadline | §1.3, §3.2 |
| P2-S12 | A deadline outside its bounds is invalid | §3.2 |
| P2-S13 | A request whose partner never answers has failed by its deadline and holds nothing | §6.1, §6.2, §5.7 |
| P2-S14 | Capacity held for a request that is not confirmed is free on Share links once the outcome is reported, and at a partner by the deadline | §5.7, §8 |
| P2-S15 | Competing requests that wait do not all lose | §11 |
| P2-S16 | Under the request_age rule, the oldest waiting request gets capacity that is released | §5.2, §4.3, §11 |
| P2-S17 | A request that waits is rejected for no fit only if it does not fit on committed capacity | §5.1, §5.2, §11 |
| P2-S18 | A request that asks not to wait is rejected at once with retry_after when capacity it needs is in flight | §5.1, §5.8 (steps 1, 5), §11 |
| P2-S19 | In a crossing, the older request keeps its holds and the younger releases its conflicting holds and waits | §5.3, §11 |
| P2-S20 | A contended request waits, pending, and is confirmed if the capacity in flight is released within its deadline | §5.2, §11 |
| P2-S21 | Changing the priority rule does not change the outcome of uncontended requests | §11 |
| P2-S22 | An interrupted request that can still finish within its deadline is resumed | §12.1 |
| P2-S23 | An interrupted request that cannot finish within its deadline fails, releases everything and says why | §6.2, §12.1, §12.2 (C15) |
| P2-S24 | The same request sent twice at once is booked once | §3.1 |
| P2-S25 | A retry after the outcome returns the original outcome, even after a restart | §3.1, §3.3, §12.1 |
| P2-S26 | A different request under a key already used is not accepted | §3.1 |
| P2-S27 | A retry while the request is pending returns its current status | §3.1 |
| P2-S28 | Retried partner calls never book the partner twice | §10.2, §10.6 |
| P2-S29 | Share never confirms a leg the partner has not confirmed | §5.5, §5.6 |
| P2-S30 | A transient partner refusal does not end the request before its deadline | §10.2 |
| P2-S31 | A definite partner refusal rejects the route, naming the partner link, when no other Share request holds capacity there | §5.1, §10.5 |
| P2-S32 | Every partner is fully reconciled daily, and each mismatch alerts operations | §10.6 |
| P2-S33 | A partner without holds is booked only after every other leg and the funds are secured | §5.1, §5.5 |
| P2-S34 | A route with two legs on partners without holds is rejected before anything is held | §3.2 |
| P2-S35 | A failure after the partner without holds was booked cancels it at Share's cost | §5.5, §10.4 |
| P2-S36 | A partner whose holds are too short counts as a partner without holds | §3.2, §10.1 |
| P2-S37 | A route over two partners with holds of different lengths is all or nothing | §5.5 |
| P2-S38 | A booking the account cannot fund is rejected, stating the payment needed | §2.4, §3.2 (amounts: RFC-004 A) |
| P2-S39 | A booking beyond an agent key's spending limit is rejected; key spending is counted over the period | §2.4 (key spending rule: RFC-004 A) |
| P2-S40 | A booking beyond a limit on capacity in flight is rejected | §2.4, §3.2 (in-flight rule: RFC-004 A) |
| P2-S41 | Booking requests above a rate limit are not accepted, and the key may be used again | §3.1 |
| P2-S42 | A suspended account cannot book, and is told the amount that would resume it | §2.4, §3.2 (resume amount: RFC-004 A) |
| P2-S43 | A cancellation takes effect at the next minute boundary on every leg | §9.2, §9.3 |
| P2-S44 | Shortening cancels the remaining part | §9.3 |
| P2-S45 | An extension is decided against capacity for the added period only | §9.3 |
| P2-S46 | A rejected extension leaves the reservation as it was | §9.3 |
| P2-S47 | A rate increase is decided against capacity for the difference only, from the next minute boundary to the end | §9.3 |
| P2-S48 | A rate decrease takes effect at the next minute boundary | §9.3 |
| P2-S49 | A change to part of a route is rejected | §3.2, §9.2 |
| P2-S50 | A partner leg's minimum term and cancellation fee are shown at booking | §2.2 (E1: terms shown, decrease allowed), §3.2, §9.5 |
| P2-S51 | A failed request is visible to operations with its reason | §8.3 |
| P2-S52 | A waiting request whose capacity is then confirmed to the request ahead of it is rejected with a counter-offer | §5.2 |
| P2-S53 | A request still pending at its deadline raises an operational alert | §6.3, §13.2 |
| P2-S54 | A new account can have capacity in flight up to account_inflight_floor | §2.4 (in-flight floor: RFC-004 A) |
| P2-S55 | A request with a partner leg does not begin committing later than its deadline less commit_margin | §5.5, §6.2, §10.4 |
| P2-S56 | A buyer may withdraw a pending request | §7.1 |
| P2-S57 | Withdrawing a request after its partner leg without holds was booked cancels that leg at Share's cost | §7.1, §5.5 |
| P2-S58 | A request already holding capacity is not pre-empted by an older one | §5.3, §11 |
| P2-S59 | A request that asked not to wait is outside the contention guarantee | §5.1, §11 |
| P2-S60 | The younger request of a crossing is confirmed if the older then ends without confirmation | §11 |
| P2-S61 | A request whose deadline is shorter than the outcome it waits on is outside the contention guarantee | §6.2, §11 |
| P2-S62 | Losses caused by failures leave nothing held and tell each buyer why | §5.1, §11 |
| P2-S63 | A retry that differs only in its deadline is the same request | §3.1 |
| P2-S64 | A key reused by another principal of the same account is not accepted, and learns nothing | §3.1 |
| P2-S65 | After idempotency_retention a key identifies a new request | §3.3 |
| P2-S66 | Capacity in flight is counted once per request, at its reserved rate, whatever the number of legs | §2.4 (in-flight count: RFC-004 A) |
| P2-S67 | Status polls above key_poll_limit are not accepted | §8.2 (enforced at the edge, RFC-000 §2) |
| P2-S68 | Status polls do not count toward booking rate limits; retries do | §3.1 |
| P2-S69 | A request not yet decided when its account is suspended is not confirmed | §7.2 |
| P2-S70 | Concurrent bookings by one account are funded as if their funds checks were made one at a time, in the order received | §2.4 (interface point 1), §3.1 step 4, §3.2 (rules: RFC-004 A) |
| P2-S71 | Concurrent bookings by one agent key never together exceed its limits | §2.4 (key limits: RFC-004 A) |
| P2-S72 | Revoking an agent key fails its pending requests and leaves its reservations with the account | §7.2 |
| P2-S73 | A route counter-offer fits every leg, not only the blocking one | §5.8 |
| P2-S74 | A rejected rate increase leaves the reservation as it was | §9.3 |
| P2-S75 | An extension the account cannot fund is rejected, stating the payment needed, and the reservation is unchanged | §9.3, §2.4 |
| P2-S76 | A change beyond the agent key's headroom is rejected and the reservation is unchanged | §9.3, §2.4 |
| P2-S77 | A suspended account can still reduce what it has | §9.2 |
| P2-S78 | A suspended account cannot add to a reservation | §9.2 |
| P2-S79 | Concurrent changes to one reservation are applied one at a time, in arrival order | §9.2 |
| P2-S80 | A change still pending when its reservation is ended by Share is not confirmed | §9.4 |
| P2-S81 | A cancellation is never delayed by a pending change, which then fails | §9.2 |
| P2-S82 | A cancellation over a partner leg takes effect for the buyer whatever the partner answers | §9.3, §10.1 (J5) |
| P2-S83 | An extension or increase over a partner leg is confirmed on every leg or leaves the reservation unchanged | §9.3 |
| P2-S84 | Renewals, short shortenings and extensions past the horizon follow the change rules | §3.2, §9.2, §9.3 |
| P2-S85 | An open-ended reservation can be given an end, or cancelled before it starts | §9.3 |
| P2-S86 | A deadline at the edge of its bounds is valid | §3.2 |
| P2-S87 | A cycle of three waiting requests is broken, and the oldest is confirmed before any deadline | §11 |
| P2-S88 | In a broken cycle, the next oldest is confirmed if the oldest then ends without confirmation | §11 |
| P2-S89 | A partner refusal while Share's own request holds overlapping capacity at that partner is contention: the refused request waits and asks again | §10.5, §11 |
| P2-S90 | A partner call whose result is unknown is reconciled for that booking at once | §10.6 |
| P2-S91 | A mismatch found in reconciliation is resolved without charging the buyer for it | §2.2 (E14 with `delivered`), §9.4 (the missing part an outage), §10.6 (PARTNER_ONLY, SHARE_ONLY, PARTNER_SHORT); T25 |
| P2-S92 | A request holds no capacity until its funds hold is taken | §5.1, §11 |
| P2-S93 | Share releases every hold of a request at its deadline, a partner hold included | §6.1 |
| P2-S94 | A shortening to the next minute boundary is a cancellation; any other shortening waits its turn | §9.2 |
| P2-S95 | A waiter with a partner leg whose deadline, less commit_margin, has passed when the request ahead fails is outside the contention guarantee | §6.2, §10.5, §11 |
| P2-S96 | A partner refusal caused by Share's own booking for an undecided request is contention: the refused request waits and asks again | §10.5, §11 |
| P2-S97 | A request that yields in a crossing keeps its place among waiters | §5.3, §11 |
| P2-S98 | The account's limit on capacity in flight grows with its largest confirmed reservation | §2.4 (in-flight limit: RFC-004 A) |
| P2-S99 | A status read never contradicts the decided outcome, and reflects it within status_staleness | §8.2 |
| P2-S100 | Share sets a partner hold to expire at the request's deadline | §5.1, §10.3 |
| P2-S101 | Capacity held at a partner lapses at the deadline even when Share is unavailable then | §6.4, §12.2 (A2) |
| P2-S102 | A partner that does not accept a hold expiry set by Share counts as a partner without holds | §3.2, §10.1 |
| P2-S103 | An event after a request's decision does not change its outcome, even while its status still reads pending | §5.6, §7 |
| P2-S104 | A request whose decision record is unavailable at its deadline is never confirmed, and its Share-link holds are released within release_grace | §6.4, §12.2 (C15) |
| P2-S105 | A partner booking left without Share's confirmation is cancelled at once, at Share's cost, whatever the partner | §5.5, §7.1 |
| P2-S106 | A confirmation decided in time may become known after the deadline, within release_grace, if the decision record was unavailable | §6.4, §8.2 (never contrary), §12.2 (C10) |
| P2-S107 | An outcome other than confirmed is reported once its Share-link releases are durable, within release_grace while a link's schedule owner is failing over | §5.7, §8.2, §12.2 (L2) |
| P2-S108 | A reported outcome is reported by every later status read, even while the decision record is unavailable at the deadline | §8.2 |
| P2-S109 | A request with a partner leg that begins committing by its deadline less commit_margin is confirmed by a decision before its deadline | §5.5, §10.4 |
| P2-S110 | A request without a partner leg does not begin committing later than its deadline less ack_budget | §5.4, §6.2 |
| P2-S111 | While a request's decision record fails over before its deadline, a status read of an outcome not yet reported reads pending or the decided outcome, never a wrong outcome | §8.2 (the three properties), §12.2 (C12, S4) |
| P2-S112 | Two concurrent requests may both be refused where checking one after the other's outcome would have confirmed one | §3.1 step 4, §2.4 (interface point 1), §5.1 (`wait = false`) |
| P2-S113 | A change sent again under the same key is the same change only if its reservation, kind, new end or rate and wait setting match | §3.1 step 3, §9.2 |
| P2-S114 | A decision record unavailable within ack_budget before the deadline counts as unavailable at the deadline | §6.4, §6.1, §12.2 (C15, S4) |
| P2-S115 | A decrease over a partner leg whose shown terms do not allow one is rejected, stating the rule | §3.2, §9.2, §9.3 |
| P2-S116 | A waiter blocked on several legs is given the latest of the remaining deadlines ahead of it when its own deadline passes | §5.2, §6.2 |
| P2-S117 | Key spending counts only the parts the key booked or added | §9.1 (the key on every part), §2.4 (interface point 9; the spending rule: RFC-004 A); T9 |
| P2-S118 | A younger holder that kept its capacity while it was not waiting yields once it starts to wait | §5.3 (yield claims; a new claim on the waiting hint), §11 (path table); T21 (partner legs: CI-B-2) |
| P2-S119 | A cancellation or a decrease made just after a confirmation frees the capacity on every leg from the next minute boundary | §5.7 (`convert` in the leg's queue), §9.2, §9.8 (leg-command sequencing), §12.2 S21; T22 |
| P2-S120 | A booking or an extension over a link that is being retired is rejected at once, naming the link, with no counter-offer | §2.2 (E7), §5.1 (`LINK_CLOSING` row), §5.8, §9.6 (no offer on it); T20 |
| P2-S121 | A booking over a partner leg with a fee is decided on the terms of the quote it cites, and is never charged a fee it was not shown | §2.2 (E1, E1′), §3.2 check 4, §3.4 (quotes), §13.1; T18; B-RQ-12 (row 4) |
| P2-S122 | A withdrawal names its request's key, is the same withdrawal on every retry, and can come before its request | §3.1 step 3, §3.3, §7.1 (pre-emptive withdrawal), §12.2 S22; T19 |
| P1-S07 | Capacity held for a pending request is not sold; the next booking waits | §5.2, §11 (RFC-001: the hold) |
| P1-S08 | Capacity of a request ended without confirmation is free again at once | §5.7, §8 (RFC-001: the release) |
| P1-S11 | A single-link booking blocked by capacity in flight waits | §5.2, §4.3 (`convert` with the granted attempt), §11; T17 (RFC-001) |
| P1-S12 | A single-link booking with wait = false is rejected at once with retry_after | §5.1, §5.8 (RFC-001: the profile) |
| P1-S14 | Concurrent decisions are those of checking the bookings one at a time in the order they reach the link's schedule owner | §5.1 (order at a link), §13.2 (RFC-001: the link's order) |
| P1-S77 | Requests from different accounts are checked in the order they reach the link's schedule owner, not the order their accounts received them | §5.1 (order at a link), §5.8 step 5 (`retry_after`); T11 (RFC-001: the check) |
| P1-S34 | A single-link booking still waiting after ack_budget is answered pending | §8.1 |
| P1-S41 | A pending request that has not begun committing and no longer fits the reduced capacity is rejected, not confirmed | §5.1 (displaced, not begun) (RFC-001: `DISPLACED`) |
| P1-S42 | A waiting request is decided against the reduced capacity | §5.2 (RFC-001) |
| P1-S46 | Each added part of a reservation has its own age | §9.1, §9.3, §9.4 |
| P1-S47 | Only just enough Mbps are taken from the newest part | §9.4, §9.7 (exact composition) (RFC-001: which Mbps) |
| P1-S31, S32, S35, S36, S43, S44, S45, S52, S53, S55 … S61 | Permanent reduction: offers, firm move holds, moves, revocations | §9.4, §9.6 (offers and moves; a move final only once every new leg is booked: S52, S60, S61), §9.7 (cut targets); T15, T16 (RFC-001: link side, move holds) |
| P1-S54 | A request failed at its deadline while its decision record is unavailable frees its capacity within release_grace | §6.4 |
| P1-S62 | A request ended while the link's schedule owner fails over frees its capacity once reported | §5.7, §12.2 (L2) |
| P1-S63 | A confirmation already being decided when an outage is recorded may complete, and its reservation is then affected | §5.1 (displaced row, E5 committed), §5.6, §12.2 (C18, C19) (RFC-001: the flag and the alert) |
| P1-S84 | A move that becomes final after the reduction's cut carries the reservation at its cut rate | §9.6 (`cut_kept` at acceptance, `reduce_parts` after `ACCEPTED`), §9.7 (offer-scoped target on a Final offer), §9.8; T16, T24 (RFC-001: the link side) |
| P1-S78 | Whether a confirmation had begun committing when a reduction was recorded is judged by whether it sees the reduction's displacement record | §2.5 step (3), §4.3 (the granted attempt), §5.1 (displaced row), §5.6, §12.2 (C19, S19); T10, T17 (RFC-001: the marker) |
| P1-S70 | A booking that asks not to wait, blocked by several requests in flight, gets the latest of their remaining deadlines as retry_after | §5.8 step 5 (RFC-001: the waiting answer) |
| P1-S71 | A reservation moved to an equivalent path keeps its original age there | §9.4 (move) (RFC-001: `offer_move_at`) |
| P1-S73 | A rejection for no fit offers what fits beside the capacity held for requests in flight too | §5.8 step 1 (RFC-001: the profile) |
| P1-S74 | The selling horizon is measured in calendar months, in UTC, from the minute the request was received in | §3.2 (receipt minute in E1) (RFC-001: the rule) |
| P3-S11, S43, S44, S60, S63, S74 | Partner cancellation fees: shown at booking, who pays, charged once; a shorten to a later end pays only a minimum-term fee its new end falls inside; a booked window ending inside a minimum term pays the fee shown on the offer | §3.2, §9.3, §9.5, §13.1 (RFC-003: the charge) |
| P4-S20 | A suspended account's reservations keep their capacity during the grace | §9.4 (nothing ends before grace expired; RFC-004 A) |
| P4-S23 | At the end of the grace the reservations are released and the buyer told | §9.4 (RFC-004 A: the timer) |
| P4-S66 | Holds for concurrent bookings never together exceed what headroom allowed | §2.4 (interface point 1), §3.1 step 4 (RFC-004 A) |
| P4-S97 | At release, a shown cancellation fee is charged against what is left of the hold | §9.4, §9.5 (RFC-004) |
| P4-S101 | A price change whose larger hold the headroom cannot cover still takes effect, and the account is suspended as for a failed roll-forward | §9.4 (price step recorded at the announcement), §7.2 (endings) (RFC-004 A: F7 *price effective*, the suspension) |
| P4-S108 | A price notice that the account's headroom would not cover states the top-up that would | §2.3 (F11), §9.4 (one entry per account and price version) (RFC-004 A: the notice's figures) |
| P4-S114 | The resume amount is the least top-up that resumes the account, itemised, with the headroom after it | §2.4 (`answer`; passed through in rejections, C10 `resume`) (RFC-004 A: the figures) |
| X1-S05 | An agent key acts only for the account that issued it | §3.1 (RFC-005: scope) |
| X1-S06 | A revoked agent key is refused within 60 s | §7.2 (RFC-005: the edge) |
| X1-S07 | An operation by an agent key records the key | §2.1 (audit fields; RFC-005) |
| X1-S08, X1-S09 | Idempotency keys scoped to the account; reveal nothing | §3.1, §3.3 (RFC-005) |
| X2-S03 | Admission sustains the design load | §14 (RFC-006) |
| X2-S05, X2-S15 | A single-link booking answered within ack_budget; final when no capacity in flight | §8.1, §14 (RFC-006) |
| X2-S06 | A route booking acknowledged within ack_budget, outcome by its deadline | §6, §8.1 (RFC-006) |
| X2-S21 | Funds holds and headroom checks held to admission's targets | §1.2, §2.4 (one account owner; RFC-006) |
| X1-S36 | A termination notice is withheld only by compliance, under a legal order that forbids it, as part of the termination and approved with it | §9.4 (termination row: `withheld_by` on every event the termination causes, true status reads), §8.3, §13.1; T12 (RFC-005: roles and approval; RFC-006: the notifier) |
| X2-S27 | Enough probe accounts are designated that every account slot of admission and the wallet is probed | §2.5 (probe accounts are ordinary accounts; the slot map is placement's), §13.2, §14 (RFC-006: the slot map, the probe accounts, 3 probes a minute from two locations, the measure) |
