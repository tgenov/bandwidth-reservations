# Verification of RFC-000 revision 3 against review 2

| | |
|---|---|
| Under review | [RFC-000](../03-rfcs/RFC-000-architecture.md), revision 3 |
| Checked against | [Review 2](08-rfc-000-review-2.md) (A0R-01 … A0R-14, R2-D1 … R2-D7); requirements tag `requirements-v1.4` (policy register POL-02, POL-04, POL-06, POL-24, POL-26, POL-28, POL-29; glossary; P2 and X2 features, P1 and P4 by search); pending amendment RQ-12 treated as accepted |
| Scope | A focused check of the fixes, not a full review. Not read: code, the pre-baseline RFC-001 … RFC-004 drafts, `history/` |
| Date | 2026-10-12 |

## Verdict

**ACCEPT WITH CHANGES.** Every fix is present, and the safety core holds under the crash
points traced below. That core is the `D − τ` fence, first-in-log wins, request-scoped
releases with tombstones, the "releases durable" entry, payments keyed by transaction
reference, and monotone posting time. I found seven concrete defects, V-01 … V-07, and
one editorial item, V-08. Two are about reporting:

- V-01: replica rule 2 can answer `pending` after an outcome has been reported elsewhere.
- V-02: the edge's synchronous final answer bypasses the report position.

Both break POL-04's "a reported outcome stays reported" (P2-S10, P2-S108).

V-03 comes from dropping the committing mark. The partner adapter is not fenced against
a late partner confirm. None of the defects is a Blocker. Each has a local fix.

## Status per finding

| Finding | Status | Note |
|---|---|---|
| A0R-01 | **Verified** | `τ = max(ack_budget, ε + δ_x)`. The guard is at `D − τ`, which is stricter than POL-26 v1.4 ("timestamped before its deadline"). "Begin committing" is the confirm entry without a partner leg (≤ `D − τ` ≤ `D − ack_budget`, P2-S110) and the journaled partner confirm with one (≤ `D − commit_margin`, P2-S109) |
| A0R-02 | **Verified, with defects V-02 and V-06** | The "releases durable" entry, its gating of reports, re-sending on takeover and its batching are all present and correct against POL-04 and RQ-8. Remaining: the synchronous answer, and the worst-case `δ_x` figure |
| A0R-03 | **Verified for Share links; defect V-03 at partner adapters** | No hold can be stranded on a Share link (trace C4) |
| A0R-04 | **Verified, with defects V-04 and V-05** | P4-S01 … S04, S57 and S100 hold. Remaining: the partition scope, and binding on a malformed first event |
| A0R-05 | **Verified** | Go-live fibre condition, cut rows and measured leader region are all present. The figures are consistent |
| A0R-06 | **Defects V-01 and V-02** | The four-step rule and the report position are present. Rule 3 is correct, but rule 2 and the edge path break "reported stays reported" |
| A0R-07 | **Verified** | Rebased. RQ-5 … RQ-11 are under Resolved. V-08 is editorial |
| A0R-08 | **Verified** | The adapter skips waiters past their fence or already ended. Re-asks are serialised per conflicting pair. R17 covers partner clocks |
| A0R-09 | **Verified** | Home by causing buyer, otherwise by supplier, otherwise by hashed Share sub-partition. A buyer's balance is still exact in one partition (A0-11 not regressed) |
| A0R-10 | **Verified** | `max(leader clock, previous posting time, last closed T + 1 µs)` is read from the log. Closures are committed entries, so a new leader always has the last one. Per-line deduplication is present |
| A0R-11 | **Verified** | 2.2×10¹⁴ lines, 22 PB at 100 B, about 2.2 PB columnar per copy. The arithmetic checks |
| A0R-12 | **Defect V-07** | 2 + 2 is sound as a target configuration. The way to reach it is unspecified, and one reading of it is unsafe |
| A0R-13 | **Verified** | Assigned to RFC-006 with the trigger, staggered elections and the timing. Tested in the R1 spike |
| A0R-14 | **Defect V-03** | Dropping the mark is right for the decision. Recovery now relies on the adapter's journal, which nothing fences |

## Crash-point traces

| # | Trace | Result |
|---|---|---|
| C1 | **Fence against expiry, one leader.** A confirm is accepted only if stamped `< D − τ`. Expiry is appended at `D − ε − δ_x`, which is at or after `D − τ`. Under one leader's monotone clock the confirm precedes the expiry in the log | Safe |
| C2 | **Fence across leader change.** The old leader's uncommitted expiry is lost. The new leader's clock may be `ε` slow, and it stamps a confirm `< D − τ` at true time up to `D − τ + ε`, which is before `D`. No release was sent, because the expiry never committed. The reverse case, a committed expiry followed by a late confirm, is decided by first-in-log | Safe; POL-26 met (stamped before `D`) |
| C3 | **Expiry under a slow clock.** Appended at `D − ε − δ_x` by a clock `ε` behind, so at true time `D − δ_x`. Commit, notice and link commit are durable by `D` at p99 (P2-S93) | Met, with the margin in V-06 |
| C4 | **Hold and release cross.** (a) A release arrives before a late hold: the tombstone refuses the hold. (b) The hold arrives first: the request-scoped release ends it. (c) A re-grant after a yield (attempt n + 1) that the account owner has not heard of: it is ended by the request-scoped release. (d) A hold arriving after the tombstone expires is past `D` + `release_grace`, so the past-`D` rule refuses it, even with skew `ε` ≪ 60 s. (e) A leg the account owner never sent a hold to still acknowledges the release, because acknowledgements are counted per intake leg | No Share-link hold is stranded |
| C5 | **Account leader fails after a non-confirmed ending entry, before "releases durable".** The new leader re-sends the releases, and the link owners re-acknowledge idempotently. Until then the outcome reads `pending`, which RQ-12 allows during the account partition's failover | Safe |
| C6 | **Link owner fails over at the decision.** The report waits for the release, at most `release_grace` (POL-04, P2-S107). Rule 2 answers `pending` meanwhile | Conformant |
| C7 | **Withdrawal after the partner confirm** (P2-S105, P2-S57). The account owner's checks, made from its applied state, pass. The withdrawal is applied, then the partner confirms. The deciding entry ends the request "withdrawn", and the booking is cancelled at Share's cost | Conformant without the mark |
| C8 | **Account leader fails with a partner confirm in flight.** The new leader queries the adapter's journal, which shows none. It expires the request and releases it at the adapter. The old leader's delayed confirm then reaches the adapter. The adapter's tombstone covers only holds and grants, so the confirm is journaled and sent, possibly after `D − commit_margin` | **Defect V-03**: a partner booking with no request behind it, found only at daily reconciliation (POL-28 says "at once"), and a "begin committing" time past the fence (POL-26) |
| C9 | **Status after a report.** Replica Y reports "rejected" (or a webhook does). Replica X is still fresh by its closed position (≤ 1 s − ε old) but has not applied the entry, so rule 2 makes it answer `pending` | **Defect V-01** (POL-04, P2-S10) |
| C10 | **Synchronous answer, then an account outage.** The edge answers "confirmed" when entry 2 commits. The leader dies before a majority learns the commit index. Rule 3 queries a majority, finds a lower committed position, and answers `pending` | **Defect V-02** (RQ-10, P2-S108) |
| C11 | **Payment redelivery naming another account** (T12 of review 2). Same (provider, reference), same partition: the binding is found, nothing moves, and the mismatch is reported (P4-S04). A reversal before its payment matches in the same partition (P4-S02, S03) | Safe; but see V-05 |
| C12 | **2 + 2 under a declaration while R2 is only isolated.** The change commits through the old majority (A1, A2, C1). R2's two voters cannot form a majority of either configuration | Safe **only with joint consensus or single-voter steps** (V-07) |
| C13 | **Closed position across leader change** (ledger). The closure is a committed entry, and the new leader's next posting time is at least T + 1 µs | Safe |

## Defects

| # | Finding | Defect | Fix |
|---|---|---|---|
| V-01 | A0R-06 | **Rule 2 lets a fresh but lagging replica answer `pending` after the outcome was reported** by another replica, the outcome feed, a webhook or the edge (C9). This contradicts POL-04 ("every later status read reports it") and P2-S10. The report position only guarantees that a majority of *voters* knows the entry; it says nothing about status replicas | Give status replicas **read leases** from the leader, renewed on heartbeats and lasting at most `status_staleness` − ε. The leader advances the report position to P only once a majority of voters knows P is committed **and** every replica with a live lease has acknowledged applying through P, or its lease has expired. Rule 2 becomes "holds a live read lease → `pending`". A replica without one goes to rule 3 or 4. In steady state the cost is about one RTT to the farthest serving replica (about 10 ms, est.). A slow replica delays a report by at most its lease |
| V-02 | A0R-06, A0R-02 | **The edge's synchronous final answer is a report, but it is not gated by the report position.** A10 says a confirmation "is reported once its deciding entry is committed", §3 single-link answers at commit, and §4.6 lists only replicas, the feed and the notifier. C10 then gives `pending` after a reported outcome. Also, §4.6 puts the report-position delay at "one heartbeat, about one 10 ms round trip". With a region lost, the majority includes R3, so it is about 65 to 70 ms | The edge answers final only once the deciding entry (and "releases durable" for a non-confirmed outcome) is at the report position, as amended by V-01. Restate A10 to match. Restate the delay as one majority round trip: about 10 ms steady, about 65 to 70 ms with a region lost (est.). Add it to the latency table and to Benefits: single-link from R1 about 105 ms; from R2 about 115 ms; with drift about 135 ms; R2 lost about 280 ms; R1 lost about 300 ms (targets suspended); rejection likewise. The route row "about 60 ms" becomes about 70 ms |
| V-03 | A0R-14, A0R-03 | **Partner adapters are not fenced against a late confirm or final booking** (C8). (a) The tombstone at the adapter refuses only "any hold or grant", not a confirm or a final booking. (b) Nothing makes the adapter refuse a confirm once its own clock is past `D − commit_margin`, yet the journaled send time is defined as the request's "begin committing" time (POL-26). (c) A new account leader's journal query is not a fence: a confirm from the deposed leader that arrives after the query is still sent. With the mark gone, the journal is the only record that recovery reads, so it must be complete once queried | The adapter refuses (journals as refused, never sends) a confirm or final booking: for a tombstoned request; when its clock is past `D − commit_margin` less the partner-skew budget (R17); or when the command carries an account-owner term lower than the highest the adapter has recorded for the request. The new leader's resume query is an adapter log entry that records its term. Any partner booking the adapter nonetheless finds for a tombstoned request is cancelled at once at Share's cost (POL-28). Add these to the partner port invariants (§8) beside the link hold port's |
| V-04 | A0R-04 | **The partition key is applied to state that has no transaction reference, and transfer confirmations have two owners.** §2 partitions the whole "payments, receivables and reconciliation" component by (provider, transaction reference), including invoices, write-offs, top-up conversions and reconciliation runs. Invoices and write-offs are per account (overdue and paid feeds go to the account owner), and runs are per day. §4.4 puts transfer confirmations and failures in the payments partition, while §2 makes payouts their owner, which gives them two writers (A1). P4-S87 and P4-S95 need the payout state to judge them | Partition only payment events, their reference bindings and pending orphan reversals by (provider, transaction reference). Partition invoices, invoice payments as applied to invoices, and write-offs by account, fed idempotently by the payment's reference. Partition reconciliation runs by day. Transfer confirmations and failures go to payouts, routed by the instruction reference (internal and unique, with the provider reference recorded), and are deduplicated there. Remove them from the §4.4 payment-events row |
| V-05 | A0R-04 | **The first authenticated event binds the reference, even if malformed.** An authenticated notification rejected as malformed (P4-S05: zero amount, sub-unit amount, unknown type) would fix the binding and contents. The correct notification that follows would then "differ" and move nothing (the P4-S04 path), so the top-up is lost | Bind on the first authenticated **and well-formed** event. Malformed events are recorded and rejected without creating a binding |
| V-06 | A0R-02 | **The worst case of `ε + δ_x` is understated.** With R1 lost, leaders in R2, both commits are about 70 ms, so `δ_x` ≈ 70 + 10 + 70 = 150 ms and `ε + δ_x` ≈ 190 ms, not 185 ms. The 65 + 10 + 70 sum mixes two failure states. The margin to `τ` = 200 ms is 10 ms at p99 (est.) | State 150 ms and 190 ms in §4.3. Have RFC-006 alarm on the monitored invariant before that margin is used up. The fence already moves earlier automatically |
| V-07 | A0R-12 | **The 2 + 2 change is "through the log's own membership change", which is unspecified.** A one-step switch from {A1, A2, B1, B2, C1} to {A1, A2, C1, C2} has disjoint majorities: {B1, B2, C1} in the old configuration and {A1, A2, C2} in the new. That is unsafe if the declared-lost region is only isolated (C12) | Specify joint consensus (the transition needs a majority of both configurations), or single-voter steps: add C2 as a learner until caught up, promote it (majority 4 of 6), then remove B1 and then B2. Reverse the same way on restoration. State that while the change is in flight all three survivors are needed, so it should be made immediately after the declaration, with the placement log first |
| V-08 | A0R-07, RQ-12 | Editorial. §4.2's status-lag row omits the account partition failing over before the deadline (RQ-12, bounded by the 1 min RTO). RQ-12 still sits under "New", and the v1.4 scenarios the fixes implement (P2-S107 … S110) are not cited | Add the RQ-12 case to §4.2. Move RQ-12 to Resolved once it is tagged. Cite P2-S107 in §4.3 (RQ-8), P2-S108 in §4.6, and P2-S109 and S110 in the fence bullet |

## Internal consistency and regressions

- **Diagrams.** In the route sequence, the checks are made without a log entry, the
  partner confirm is journaled with its send time, and entry 2 is guarded at `D − τ`;
  this matches §4.3. In the deadline sequence, the fence note comes before the expiry
  note (`D − τ` ≤ `D − ε − δ_x`), with request-scoped release, tombstone and
  "releases durable"; this matches §4.3. The topology diagram has the four diverse
  paths, matching §5.1.
- **Latency tables.** Single-link 10 + 5 + 27 + 27 + 25 ≈ 95 ms. R2 lost:
  3 × 65 + 20 = 215 ms. R1 lost: 3 × 70 + 20 = 230 ms. Time to `pending`: about 45 ms,
  and about 90 ms degraded. The quorum table is consistent with 2 + 2 + 1 and with the
  RTT matrix. The only changes needed are those in V-02 and V-06.
- **Allocation.** 9 + 11 + 13 + 17 + 10 + 6 = 66 rows. They match the need tags in the
  v1.4 features exactly, and each need has one primary RFC.
- **Sizing.** Two account entries per request without the mark. Tombstones about
  750/s × 120 s ≈ 90,000 on the hottest link. Payments by reference spread evenly.
  All consistent.
- **A0-01 … A0-21.** I found no regression. A0-09's order (checks, then partner confirm,
  then decision) is kept without the mark; only its recovery needs V-03. A0-11's exact
  buyer balance still holds under A0R-09's homing. A0-06 is superseded by A0R-06, subject
  to V-01 and V-02. The other first-round fixes are unchanged in revision 3.
