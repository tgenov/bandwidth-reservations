# Review 18. Joint money and concurrency review of RFC-002 and RFC-004 (revision 3)

| | |
|---|---|
| Under review | [RFC-002](../03-rfcs/RFC-002-booking-coordination.md) Draft rev. 3 (slice S-ACCT) and [RFC-004](../03-rfcs/RFC-004-wallet-and-settlement.md) Draft rev. 3 (slice S-MONEY); they share the account owner (RFC-002 §2.4 and RFC-004 §A10 are the joint interface) |
| Mode, focus | Joint; money and concurrency |
| Authority | `requirements-v1.7`: [policy register](../02-specs/policy-register.md) (POL-04, POL-07, POL-08, POL-15, POL-16, POL-18, POL-21, POL-24, POL-25, POL-26, POL-27, POL-28, POL-30), [glossary](../02-specs/glossary.md), P2, P4 and X2 features; [RFC-000](../03-rfcs/RFC-000-architecture.md) rev. 4.1 (§3 latency budget, §4.3, §5.5, §8) |
| Tools | `impact.py coverage S-ACCT`: primary 116, uncited 0, dangling 0. `impact.py coverage S-MONEY`: primary 113, uncited 0, dangling 0. `check_specs.py`: no problems |

## Verdict

- **RFC-002: ACCEPT WITH CHANGES.**
- **RFC-004: ACCEPT WITH CHANGES.**

There are no Blockers, 8 Majors and 12 Minors (20 findings).

**Worked examples.** Every worked example recomputes correctly. That covers:

- P4-S08 to S13, S59 to S64, S96, S15 and S16 (370 s, 46,250, 48,250, 663,750), S22, S24,
  S55, S68, S70, S92, S93, S94, S97, S101, S105, S108, S111 and S112.
- P2-S38 (88,000 and 1,088,000), P2-S75 (460 and 1,000,460), P2-S39.
- The Webster tables (P4-S35, S36, S73, S102), M9 for P4-S42 (12,000,000 and 28,000,000),
  P4-S06, S103 and S50.
- The P4-S90, S106 and S109 invariant rows.

**Sizing.** RFC-002 §14's per-request, storage and partner figures recompute, and so do
RFC-004 §A11 and §B10.

**What holds.** One decision point per request, conditional deciding records with the
decision row, "no send before commit", and funds written in the same entry as the booking
record all hold under every crash point traced. The crash points traced were: an ambiguous
commit, a deposed owner, a takeover with E5 in flight, `DISPLACED` racing E5, and a
suspension racing a partner confirm.

**What breaks.** The defects are where the two modules meet and where time or a second
feed comes in:

- Funds for queued changes are sized against a stale schedule (J-01).
- Key spending can be escaped through another key's reservation (J-02).
- `admit` and the entry contents are fixed outside the commit timestamp (J-03).
- RFC-002 has no path for F11 price notices (J-04).
- Receivables' invoice events have no contract and no order against the ledger feed (J-05).
- A written-off invoice is never removed from the overdue set (J-06).
- E11 entries with a future effective minute are committed after that minute (J-07).
- Slot batching wait is missing from the latency budget at design load (J-08).

## Scenario traces (hardest paths)

| Trace | Result |
|---|---|
| R1 (`wait = false`, blocked) and R2 concurrent, headroom 0.3 (P2-S112) | Holds. `admit` is serial on the projected state; R2 is refused against R1's hold; R1's E7 releases its hold; nothing is rechecked |
| Suspension F1 composed in the same batch as E5 for one of the account's requests | Holds. Projected state orders them. E5 first: it is confirmed and the later F1 changes nothing (P2-S103). F1 first: E5 is not composed and the F1 entry carries the ending record |
| Partner route: partner confirm sent from the applied state while a suspending F1 is in the batch in flight | Safe, but Share pays a cancellation that could have been avoided (J-12) |
| Ambiguous commit of a batch carrying an F1 suspension and its endings | Holds. One row per entry; reload and recompose (§2.1) |
| Extension queued behind an increase on the same reservation, both funded at intake | **Fails P2-S70 and P4-S66.** The extension's `h_q` is computed at the pre-increase rate. At its E5 the shortfall is treated as a failed roll-forward, so the account is suspended instead of the change being refused (J-01) |
| Key K2 (limit 1 USD) repeatedly increases K1's reservation | **Fails POL-25.** The added parts' holds are counted to K1, so K2's spending never accumulates (J-02) |
| Intake whose batch is pushed across 00:00 UTC (key spending period) or across a fee-term end | **Replay mismatch.** The verdict was computed on the projected state, but the entry's `ts` is the pushed commit timestamp. RFC-004 recomputes at `ts` and alerts, and the P4-S72 rebuild differs (J-03) |
| Invoice I1 written off (M19, F5), I2 overdue, top-up 2.0 (P4-S111); write-off then top-up 11.0 (P4-S94 e1) | **Unspecified, and fails as written.** F6 has no *written off* variant, so I1 stays in `OD`. `RA` then counts it twice, receivables applies `x − r` to I1 first, and e1 never clears the `invoice` cause (J-06) |
| F5 *limit removed* or F6 arrives before the F1 that carries M19's `W` | **Transient wrong resume.** `OD` is empty, `W` is still 0 and the old `CL` still counts, so the account resumes, admits additions, and is suspended again at the F1 (J-05) |
| Revocation due at 10:00, account owner failing over 09:59:50 to 10:00:40 | **Overcharge.** E11 commits about 10:00:40 with effective minute 10:00 < `ts`, which breaks the lifecycle feed's closure. Rating may already have closed 10:00 at the full rate (J-07) |
| Single-link booking at 25,000 requests/s, 1,024 slots | **Budget miss.** About 108 entries/s per slot, so a batch is almost always in flight. Two account-owner entries add up to about 60 ms p99, about 175 ms from R1 and about 205 ms on the hottest link, above X2-S15's final answer within 200 ms (J-08) |

## Findings

| ID | Severity | Location | Finding | Proposed change |
|---|---|---|---|---|
| J-01 | Major | RFC-002 §9.2, §9.3; RFC-004 §A5.2, §A5.3 | **A queued change's funds are checked against the schedule at intake, not as the changes ahead will leave it.** `admit` runs at the change's E1, on arrival. `Ask.schedule_before` is the current schedule, but POL-08 decides the change "against the reservation as left by the previous one". Examples: extend-after-increase (the extension is held at the old rate) and extend-after-shorten (the extension adds [14:00, 20:00) but is held for [18:00, 20:00)). At E5, §A5.3 turns the shortfall into a "failed roll-forward" and **suspends** the account while the confirmation stands. This breaks P2-S70, P4-S66, Invariant A-2 and POL-16's "never by surprise" | RFC-004 §A5.2: for a change with changes ahead in the queue, evaluate `x` against the schedule those changes would produce if confirmed, per minute the larger of "all ahead confirmed" and "none confirmed". At E5, release `h_q − (R(after) − R(before))` if positive. Keep the failed-roll-forward path only for posting drift (minutes). RFC-002 §9.2: state that `Ask` carries the projected schedule. Add the case to T6 and to RFC-004's A-1 simulation |
| J-02 | Major | RFC-004 §A2 (`key_r`), §A3 (`KS_k`); RFC-002 §9.1 (parts) | **Key spending is attributed per reservation, not per part.** `KS_k` sums `H_r` and the posted charges of the reservations "of k" (the booking key). An increase or extension by K2 is checked against `kh_K2` at intake, but once confirmed its hold and charges count to K1. So K2's spending never accumulates, and K2 can keep adding while K1 is pushed below zero without acting. This breaks POL-25 ("never exceeds … a key's headroom"; cumulative over the period) and P2-S71 | Record the key on every part (RFC-002 §9.1 already records the admission's request id; add its key). Define `KS_k` over parts added by k: posted charges of those parts in the period, plus their share of `H_r`, apportioned by part coverage with a stated rounding. Add a worked example (K1 books, K2 increases) and a T9 case |
| J-03 | Major | RFC-002 §2.5 batch step (2)–(3), §3.1 step 4; RFC-004 §A10 "Time" | **The two RFCs disagree on when funds outcomes are computed.** RFC-002 composes E1 with `admit` on the projected state before the transaction. Its in-transaction rechecks are only the fence, E8 ≥ `D` and the markers. RFC-004 says `admit` and `apply` are evaluated inside the transaction **at the commit timestamp**, and a pushed transaction re-evaluates. Verdicts depend on `ts`: the key spending period (UTC day), the fee-term end, `m_now` in `A` and the `D` written in E1. A verdict computed at composition and committed at a different `ts` fails RFC-004's replay comparison (alert) and the P4-S72 rebuild | Adopt RFC-004's rule in RFC-002 §2.5. The transaction first reads its commit timestamp. Then, in sequence order, the owner evaluates `rate_check`-free intake validation, `admit`, `apply`, `D = ts + deadline` and `D_c` for every entry of the slot's batch. The projected state used before then is provisional (it only orders submissions). On a push the whole batch is re-evaluated, and an E1 may become E1′. State this in §2.1 and §3.1 step 4, and add a push across 00:00 UTC to T3 |
| J-04 | Major | RFC-002 §2.3 (registry), §2.4, §9.4 price-change row; RFC-004 §A4 F11, JR-4 | **RFC-002's closed entry registry has no F11 (price notice).** RFC-002 only arms a timer for the effective minute. RFC-004 JR-4 says "RFC-002 must register F11 and append it when the catalogue announces a change". Without it, P4-S108 (the notice with the hold and the top-up quote, `price_notice` ahead) has no producer. RB-11 declares the catalogue closed | RFC-002 §2.3: add F11 (and RFC-004's third F7 variant, J-13). §9.4: on the catalogue's price-change announcement, append F11 for each affected open-ended reservation, idempotent by (reservation, price version). Add P4-S108 to the traceability table |
| J-05 | Major | RFC-002 §13.2 (consumed); RFC-004 §A4 F5, F6, §B5, §B12; RFC-000 §3 (table, "payments → account owner") and §8 | **F5 and F6 inputs have no contract and no order against F1.** (a) No §8, RFC-002 §13.2 or RFC-004 §B12 row covers receivables → account owner (invoice overdue, paid, written off; credit limit removed). There is also no row for the console's credit-limit command to the account owner. RFC-000 §3 still names payments as the source. (b) These events reach the owner on a different feed from the ledger's F1. They are therefore unordered against the movements they were computed from: an F6 or F5 after a write-off can arrive before the F1 that carries `W` (trace above). P4-S65's ordering argument covers F1 only | Add the contracts: receivables invoice-status feed (RFC-004 → RFC-002) and the credit-limit command (console → account owner, finance envelope). Each F5 and F6 carries the buyer partition's ledger position receivables had applied. The owner applies it only once its F1 has reached that position, as F2 is gated on X (AI3-3). Raise as an architecture issue (A-1) |
| J-06 | Major | RFC-004 §A4 F6, §A3 `RA`, §B5 (invoice write-off, top-up allocation, `I` in `N`) | **A written-off invoice is never removed.** F6 is only *overdue* or *paid*. On an invoice write-off, receivables sends M19 and F5 but nothing removes the invoice from `OD`, and §B5 does not say it stops being "overdue" for top-up allocation or "invoiced and unpaid" in `I`. As specified, P4-S94 (e1, top-up 11.0) stays suspended on the `invoice` cause with `RA` = 10 + max(0, 10, …). P4-S111 applies `x − r` to I1 (the oldest) before I2. `N` is understated by the written-off amount. The worked examples assume the removal; the mechanism is missing | Add F6 *written off* (invoice, amount, position): it removes the invoice from `OD`. In §B5, a written-off invoice is closed. It is not overdue and takes no top-up allocation, and its remainder leaves `I` because it moved into `W`. Order it with J-05's position gate so `W` and `OD` change together |
| J-07 | Major | RFC-002 §9.4 (revocation or reduction "at the effective minute", move "at the notice end", price change "timer at the effective minute"), §13.1 lifecycle feed closure | **E11 for a cause known in advance is appended at or after its effective minute.** So `ts > effective minute`, which contradicts §13.1's "every entry's effective minute is at or after its `ts`" (AI3-2). In normal operation the gap is milliseconds. During an owner outage it can exceed the feed's resolved timestamp, so rating has closed minutes at the old rate or price. The buyer then pays for revoked capacity (POL-07, POL-08), or Share under-charges a price change | Append these E11s when the cause is known, with a future effective minute: on "revocation due" (the notice end is known `revocation_notice` ahead), on the offer's move time, and on the price-change event (at F11 time). If the owner reaches one late, use the next boundary after `ts` and record the delay. Never write an effective minute before `ts`. State the invariant as checked in the batch (step 3) |
| J-08 | Major | RFC-002 §8.1, §14 (transactions, latency), Benefits; RFC-000 §3 ("a slot whose partitions are idle pays nothing") | **Slot batching wait is missing from the ordinary path, and the transaction count contradicts AI3-11.** Per slot: 58,000 booking entries/s plus F2 up to 50,000/s plus F1 about 2,700/s, over 1,024 slots, is about 108 entries/s (est.). Arrivals are 9 ms apart against 15/30 ms commits, so a batch is in flight on most arrivals (about 95%). Entries 1 and 2 each wait up to one commit: +up to 60 ms p99 (summed like RFC-000). That gives about 175 ms from R1, about 185 ms from R2, about 195 ms measured with probe overhead and about 205 ms on the hottest link, so X2-S15's final answer breaks. §14's "about one transaction per entry: 55,000/s" is impossible at one batch in flight per slot (at most about 34,000 to 68,000/s), and §14 omits F1 and F2 entries | Recompute §14 with slot batching and funds entries. Then choose one of: (a) many more slots, about 16,384 (est.: about 7 entries/s per slot, so a batch is in flight on about 20% of arrivals). Owner leases are per slot, so check lease-renewal cost. (b) A second in-flight batch per slot (RFC-000 R19's lever). (c) Coalesce F2 to the `attribution_lag_max` budget (R4-A3). Update the Benefits latency claim and raise the RFC-000 §3 wording as A-2 |
| J-09 | Minor | RFC-004 §A2, §A3 (fee part), §A6 (shorten into minimum term) | **No "fee incurred" state.** After a shorten into the minimum term posts M10, `R_r = max(C_r, fee part)` still includes `fee_r` until `fee_end_r`, so the fee is held again (overhold; POL-15 holds the fee only "while it could still be charged"). The ledger's (reservation, fee) dedup is what stops a second charge, not the design | Add `fee_charged_r`, set by the E11 that makes the fee due. The fee part is 0 once it is set. RFC-002 §9.5 records it in E11 |
| J-10 | Minor | RFC-004 §A10 `due(S)`, §A8; RFC-002 §6.1 | **F7 instants are fired by the owner's clock but not checked against `ts`.** An F7 *enforcement check* committed with `ts < since + 60 s` reports late enforcement falsely. A *grace ended* tick can commit a little before `grace_end` | F7's apply requires `ctx.ts ≥` its instant; otherwise the entry is deferred, as for E8 ≥ `D` (§2.5 step 3) |
| J-11 | Minor | RFC-004 §A3 (probe accounts), §A6; X2-S24 | **Probe holds rely on state changes "without an entry".** `p_r` "advances with the clock, no entry is needed", but `H_r` changes only by `apply`, and Draining closes only when lines are posted, which never happens for probes. So per-minute probe bookings would pile up Draining holds until the credit limit is used up, and probes then fail falsely. Also, F5 is refused unless `kyb` is passed, and nothing provisions KYB for 1,024 probe accounts | Specify that for `excluded` accounts every `apply` re-evaluates `H_r` at `ctx.ts` and closes Draining at `end_r`. RFC-006 provisions probe accounts with KYB passed (via F4) before F5 |
| J-12 | Minor | RFC-002 §5.5 step 1, §2.4 (`standing` "from the applied state") | A partner confirm is sent on the **applied** standing. A suspending entry already in the projected state then ends the request, and Share pays the partner cancellation (POL-28) | Check `standing` and key status on the **projected** state (conservative): do not send if suspended there; re-check after the batch resolves |
| J-13 | Minor | RFC-002 §2.3, §2.4; RFC-004 §A4, §A10 | Joint wording drift: (a) RFC-002 lists F7 as "fee term ended; grace ended" and misses *enforcement check*. (b) `rate_check(soft, ts, …)` in RFC-002 versus `now` (owner clock) in RFC-004; `ts` reads as a commit timestamp. (c) E1′'s funds column says "None" in RFC-002, but RFC-004 records the refusal reason and amounts (needed for replay). (d) Suspension endings: RFC-002 §2.3 says "every undecided request and every undecided addition", while §7.2 and RFC-004 §A10 say additions only, with reductions unaffected | Align: list all three F7 variants; name the parameter `now`; E1′ carries `admit`'s inputs and verdict; end only undecided additions (queued reductions continue, POL-08, P2-S77) |
| J-14 | Minor | RFC-002 §2.5 step (3), §5.6; RFC-000 §8 displacement read | E5's serialisable point read of `link_displacement` can meet an intent from a link owner's in-flight reduction. The **whole slot's batch** then waits for that transaction. If the link owner died, the wait lasts until its record expires (seconds), stalling every account in the slot | Run the marker reads with a short lock timeout. On timeout, defer only that E5 to the next batch and keep the rest of the batch |
| J-15 | Minor | RFC-002 §9.4 (first paragraph) | A Share reduction or move fails the change in progress and every queued change with "reservation changed by Share". POL-08 fails pending changes only when the reservation **ends** (P2-S80); for other changes it requires them to be decided against the reservation as left | For a reduction, leave queued changes queued; they are decided at the head against the reduced schedule. Fail only a change in progress whose holds are on legs the move removes |
| J-16 | Minor | RFC-004 §B2 M2, §B5 "Invoice payment" | M2 repays `W` first (`r`), but §B5 applies the invoice payment to the named invoice without subtracting `r`. Receivables would mark the invoice paid with money the ledger sent to `SH:repayments` | §B5: apply `x − r` to the named invoice (as for M1). Show it on the buyer statement |
| J-17 | Minor | RFC-002 §3.2 (prices "from the catalogue's cache") | A locked price comes from a cache. A new price in force from minute M that has not yet reached the cache is missed, so the intake locks the old price (POL-27: the price "in force when added") | Record the catalogue position used in E1, and refuse to compose (retry) if the cache has not caught up to the published schedule. Alternatively, the catalogue publishes price versions at least one minute ahead of their effective minute |
| J-18 | Minor | RFC-004 §A7 (P4-S19 argument), §A11; RFC-002 §12.2 S4, S8 | The exposure argument assumes F2 is applied within `attribution_lag_max`. An owner takeover (up to the 1 min RTO), Kafka lag, or F2 deferred while F1 lags behind X all leave `U` stale. Headroom is then overstated beyond `LB`, and RFC-002 S8's "late, never wrongly" is not true for F2 | State the gap. RFC-006 alarms when the F2 apply lag exceeds `attribution_lag_max`. Raise as requirements issue Q-1 |
| J-19 | Minor | RFC-002 Benefits, §8.1 | The Benefits row "about 115 ms p99" and §8.1's "final answer" claim inherit J-08's omission | Restate the figures after J-08 |
| J-20 | Minor | RFC-004 §A3 `RA` versus POL-16 | `RA` folds `ΣOD` and `W` into one "resume amount" (the least top-up that resumes). POL-16 calls the resume amount the headroom part and quotes "the overdue amount plus the resume amount". This is right for buyers but is a different term | Itemise the notice and the rejection: `W`, `ΣOD`, the headroom part, and their combined `RA`. See D-5 |

## Decisions taken

These are business decisions that the requirements leave open.

| # | Decision | Why (buyers incl. agents, suppliers, Share risk, operability) |
|---|---|---|
| D-1 | A queued addition is funded at intake for the worst case of the changes ahead (J-01); any excess is released at its decision | Agents get a definite answer at intake and are never suspended by their own queue. The funds are tied up for up to 60 s, which POL-25 already accepts |
| D-2 | Key spending follows the key that added each part (J-02); charges of a part are that key's, whoever booked the reservation | This keeps the agent spending cap a hard cap, which is the purpose of POL-25. It costs one key field per part |
| D-3 | E11 for revocation, move and price change is committed in advance with a future effective minute (J-07) | Buyers are never charged for revoked capacity, and no amendment path is needed in rating |
| D-4 | A written-off invoice is closed: it leaves `OD` and `I` and takes no allocation (J-06) | It matches POL-21 (the debt becomes `W`, repaid first) and P4-S94 and P4-S111. It avoids collecting the same debt twice |
| D-5 | Keep RFC-004's `RA` (the least top-up that resumes), and itemise it (J-20) | An agent needs one number to pay. The itemisation keeps POL-16's wording true |
| D-6 | Check standing on the projected state before a partner confirm (J-12) | Share avoids partner fees for confirms that are sure to fail. A false "suspended" only delays one batch |

## Requirements issues

| # | Issue | Proposed amendment |
|---|---|---|
| Q-1 | POL-14 and POL-18's lateness bound omits the time the account owner can be unable to apply unposted usage (up to admission's 1 min RTO), so P4-S19 cannot hold during an owner failover (J-18) | Either add "plus admission's RTO" to the bound (60 s more of `usage_rate_cap`, about 7,500 µ at P3-S37's figures, est.), or state P4-S19 as holding outside declared admission outages, which are alerted |
| Q-2 | POL-25 "the key's reservations" is ambiguous when another principal adds to a reservation (J-02) | "Charges and holds of the parts the key booked or added" |
| Q-3 | POL-16's "resume amount" versus "overdue amount plus the resume amount" (J-20) | Define the quoted resume amount as the least top-up that resumes the account, itemised |
| Q-4 | B-RQ-10 (RFC-002) | Agreed as proposed by RFC-002 |

## Architecture issues

| # | Issue | Proposed amendment to RFC-000 |
|---|---|---|
| A-1 | §3's feed table names "payments → account owner (invoice overdue, invoices paid)". §8 has no receivables → account owner row and no credit-limit command (J-05) | Add to §8: "Invoice-status feed (overdue, paid, written off; credit limit removed), each carrying the buyer partition's ledger position, applied only once the applied ledger position has reached it", owner RFC-004, consumer RFC-002. Add the credit-limit command (console → account owner). Fix §3 |
| A-2 | §3 says a slot "whose partitions are idle pays nothing". At design load, account slots of about 100 accounts are never idle, so the single-link budget understates the p99 by up to about 60 ms (J-08) | Add account-slot batching wait to the single-link budget, or set a slot count or pipelining rule so the wait applies only to hot slots |
| A-3 | AI3-2's closure assumes every lifecycle entry's effective minute is at or after its `ts`; RFC-002's timer-driven E11s violate it (J-07) | State in §8 that causes with a known future effective minute are recorded before that minute |
| A-4 | B-AI-9 (RFC-002): §3 and §5.5 keep the partner-confirm exception | Agreed; apply the erratum as RFC-002 proposes |
