# Review 39. Contract review of C03 link-schedule (version 1 draft)

| | |
|---|---|
| Under review | [C03](../04-delivery/contracts/C03-link-schedule.md), version 1 (draft for `contract-C03-v1`), with its "Settled" list (M1, M2) and "Readings adopted" |
| Mode, focus | Contract (schema, semantics, both sides). Focus: concurrency and money |
| Authority | Requirements at tag `requirements-v1.10` (P1 S24 … S84, P3-S10/S47/S58, P4-S117, X1-S14/S22/S23, X2-S13/S14; POL-04, POL-05, POL-07, POL-23, POL-32); [RFC-000](../03-rfcs/RFC-000-architecture.md) revision 4.4: §8 rows "Link supply commands", "Link schedule feed", "Substrate conventions"; revision 4.4 errata C4-1 … C4-7 and the "Must match" table |
| Contract sections read | Provider RFC-001 rev. 5: §5.4 (reduction lifecycle), §5.7 (flags and notice table), §7.5, §9, §11 (all). Consumers: RFC-002 rev. 5 §9.4, §9.6, §9.7, §13.2; RFC-003 rev. 5 + erratum 5.1 §5.6, §5.7, §7; RFC-005 rev. 5 §3.4, §7.4, C11. Neighbouring contract: C04 (`cut` event, hold release, idempotency rows) |
| Tools | `python3 tools/impact.py coverage`: S-LINK primary 84, **uncited 1 (P1-S84)**; S-MONEY **uncited 2 (P4-S117, P4-S118)**; dangling 0. `python3 tools/check_specs.py`: no problems (473 scenarios). Every scenario ID C03 cites exists at `requirements-v1.10` |

## Verdict

**ACCEPT WITH CHANGES.** I found 1 Blocker, 6 Majors and 14 Minors (21 findings). The
Blocker can be fixed inside C03 and C04, with one-line errata to RFC-002 and RFC-003, so
a fix verification is enough. Do not tag `contract-C03-v1` before R39-01 … R39-07 are
applied.

- **R39-01 (Blocker).** `hold_2` can stay up for good. Under M2, the hold is released only
  by a lifecycle `cut` at the highest `CUT_DECIDED` revision. C03 allows a revision-2
  target that is *equal* at every minute, and C04 writes no event for "a repeat with the
  same content". A stale revision 1 delivered after revision 2 also "supersedes" in C04.
  Either path stops the reservation's charges from `T_eff` permanently.
- The other Majors are as follows:
  - REDUCTION_FINAL is recorded before the targets are answered, so an extension can
    follow it (R39-02).
  - An offer accepted in the last seconds before `T_eff` escapes both the holds and the
    amendment rule (R39-03).
  - `of` on `REDUCTION_EFFECTIVE` is not computable within one bounded entry (R39-04).
  - Two events claim the affected notice (R39-05).
  - The notice budget on the hottest link has no arithmetic (R39-06).
  - The console path does not say whether deduplication comes before or after the
    envelope checks (R39-07).

**The settled decisions are applied consistently.** M1 appears in the header comment, the
`ENVELOPE_REFUSED(check)` error, the idempotency table and PT-3. M2 appears in rule 3,
CT-3.3 and the Settled text, and matches C04 (`Cut.target_revision`, CR-2, MM-3). **The
errata list is incomplete** (R39-08). RFC-001 also owes errata for M1 and M2 and for the
runtime hooks that C03 depends on.

## Findings

| ID | Severity | Location | Finding | Proposed change |
|---|---|---|---|---|
| R39-01 | **Blocker** | Semantics, Closure rule 3; Idempotency row `CUT_DECIDED`; PT-6 ("lower or equal at every minute"); C04 "Cut" and idempotency row `cut` | **Trace A (equal revision).** A projection defect leads to `REDUCTION_SET_EXTENDED(1)`. The extension re-targets reservation X, which already holds revision 1. C03 permits the new target to be "lower or equal at every minute", so its revision 2 can carry the same pieces and parts as revision 1. RFC-002 §9.7 and C04 treat it as "a repeat of a target with the same content": no entry and no `cut` event. Rating has seen `CUT_DECIDED` revision 2 before `REDUCTION_FINAL`, and it holds only a `cut` with `target_revision` 1. `hold_2` is never released, and X's lines from `T_eff` are never emitted. That breaks X2-S13 and leaves the buyer's charges and the suppliers' earnings stranded. **Trace B (stale revision).** The gRPC push of revision 1 fails while the push of revision 2 succeeds. RFC-002 records revision 2 and emits `cut(rev 2)`. The Kafka relay then delivers revision 1. Its content differs, so it is not a repeat. C04 "writes one event for each target received", with `target_revision` 1, and that event "supersedes the earlier event for that key". If rating keeps the latest `cut`, which is what "supersedes" says, its revision 1 never equals 2. C03's "the reservation's lifecycle cut event … its target revision equals …" does not say *which* `cut` counts | (a) **Rule 3, within M2's wording:** "the **highest** `target_revision` among the `cut` events applied for (link, R, reservation) equals the highest `CUT_DECIDED` revision seen before `REDUCTION_FINAL(R)`". (b) **C04 / RFC-002 §9.7 erratum:** "repeat" means the same (key, revision). A revision at or below the highest recorded revision is answered with its recorded answer and writes no event. A **new, higher revision always writes a `cut` event**, also when the composed target is unchanged (`applied: none`). (c) **Provider:** a revision ≥ 2 is sent only when the target is strictly lower at some minute or its covered parts changed, and PT-6 asserts this. (d) Extend CT-3.3 with the equal-content case and the case where revision 1 arrives after revision 2 |
| R39-02 | Major | Delivery and ordering, "Order within a reduction" (6: `REDUCTION_FINAL` last); M2 ("seen before `REDUCTION_FINAL`"); rule 5; RFC-001 §5.4 "Cut-target answers" and "Final" | RFC-001 records the reduction **final** when "every reservation of `A_R` has its target", which means the target has been *sent*. Answers arrive later. `NOT_APPLIED(unknown)` withdraws the cap at once, and "if the excess reappears … the final check's extension" runs. That extension, with its revision-2 targets for existing members, then comes **after** `REDUCTION_FINAL`. Then: (i) C03's order is broken. (ii) M2's "highest revision seen before `REDUCTION_FINAL`" misses the new revision, so `hold_2` has already been released at the revision-1 rate. (iii) Rule 5 amends only reservations the extension **adds**, so an existing member's minutes, already closed at its revision-1 rate, are never amended down. The buyer is overcharged, against P4-S117 and P3-S58 | **Erratum to RFC-001 §5.4:** record `REDUCTION_FINAL` only once every target of `R` has a recorded `CutAnswer` and any extension caused by a withdrawn cap has been decided. This costs nothing in closure, because `hold_2` waits for the lifecycle `cut` anyway. C03 then states the invariant "no `REDUCTION_SET_EXTENDED`, `REDUCTION_EFFECTIVE` or `CUT_DECIDED` of `R` follows `REDUCTION_FINAL(R)`", and PT-6 tests it, with a `NOT_APPLIED(unknown)` injected |
| R39-03 | Major | Rule 4 (offer-scoped cuts hold nothing); rule 5; RFC-001 §5.4 (`A_R` excludes offer-only reservations, frozen from rows "as written through `q`"); RFC-002 §9.7 recording table | **Trace.** Reservation B has an open offer whose path includes link M, and M has a reduction R in its notice. B's holder accepts at `T_eff − 2 s`, and the move is Final with `move_at ≤ T_eff`. `offer_accept` turns the offer parts into B's own parts on M from `move_at`. The projection run that would rewrite B's cut-set rows as leg rows takes about 5 s on the hottest link (RFC-001 §9). `ReductionEffective` freezes `C_q` with B still recorded as **offer-only**, so B is not in `A_R`: no `hold_2`, and hold_1 lifts without it. B's target goes out offer-scoped after `T_eff`. RFC-002 §9.7 has no row for "offer-scoped, offer already Final". B's minutes from `T_eff` close at the full rate, and no amendment rule covers them, because rule 5 is extension-only. The buyer is overcharged (P3-S58), and RFC-001's premise "a move is recorded … before `move_at`, so it needs no closure hold" fails | (a) **RFC-001:** at the `ReductionEffective` entry, classify a reservation as offer-only from the **state at the entry** (its offer not accepted), not from stale rows. (b) **RFC-002 §9.7:** an offer-scoped target for an offer already Final with `move_at ≤ T_eff` is applied as a normal cut and emits a lifecycle `cut`. (c) **C03 rule 5, generalised as P4-S117 words it:** *any* lifecycle `cut` applied after some of its minutes closed amends them down ("late POL-07 cut"), whether or not it came from an extension. Add CT-3.7 for this |
| R39-04 | Major | `ReductionEffective.of` ("fixed within (reduction, extension)"); rule 2 ("every chunk `1..of`"); PT-4 | `of` has to be on the first chunk, which is written by the `ReductionEffective` entry. That entry records only `|C_q|` (parts) and the digest. The number of distinct `A_R` members, with offer-only reservations excluded, needs a full pass over `C_q`: about 500,000 rows on the hottest link (RFC-001 §9, est.), inside one entry. That contradicts "decided in bounded steps", and nothing records the count for replay or takeover (PT-4: "chunks identical") | Replace `of` with `last: boolean` on the final chunk of each (reduction, extension). It is enough, because consumers apply strictly in `feed_seq` order, so holding the last chunk means holding them all. Otherwise, require the projection output to carry the member count as of `q`, recorded in the `ReductionEffective` entry |
| R39-05 | Major | Feed per-event table: `AFFECTED_CHANGED` ("RFC-006 schedules the notice") versus `AFFECTED_NOTICE` ("RFC-006's notifier tells …") | Two triggers for one notice. If the notifier acts on both, holders get duplicate notices. If each side assumes the other, P1-S26 and P1-S50 are missed. P1-S40's restoration notice goes "to every holder already told", which needs one record of who was told | Make `AFFECTED_NOTICE` the **only** trigger. RFC-006 uses `AFFECTED_CHANGED` for history and alerting only. State in CT-6.1 that `AFFECTED_CHANGED` alone sends no notice. (Alternative, not required: drop `AFFECTED_NOTICE` and let the notifier schedule from `notice_due`. That removes the link's notice timers, see R39-08.) |
| R39-06 | Major | Timeouts, "The link's part of an affected notice: 10 s at p99"; P1-S26 | No arithmetic backs the figure. An outage on the hottest link touches up to about 100,000 parts active at the record (RFC-001 §9, est.). Each part needs an `AFFECTED_CHANGED` and an `AFFECTED_NOTICE`: about 200,000 outbox rows of about 300 B, about 60 MB (est.). The link's tail range is sized at 2 to 3 MB/s steady. An open-ended outage also flags future parts, up to 10 M (about 3 GB, est.), whose notices fall due later but are written by the same projection. Nothing orders the due-now rows first. In addition: "10 s at p99" plus "50 s" spends all of the 60 s at p99 with no tail margin; the figure is RFC-001's estimate but is unmarked here; and a cold takeover (up to 60 s) alone exceeds the budget | Order the flag projection's output by notice due time, due-now first. Consider one notice per reservation rather than per part. State the 10 s as an (est.) budget with the hottest-link outage worked through. Add a provider conformance test: an outage at 0 on a link with 100,000 active parts, every `AFFECTED_NOTICE` for them published within 10 s. Raise RQ-39-1 for the failover window |
| R39-07 | Major | Supply commands on the console path; Idempotency row (key = `action_id`); RFC-005 §7.4 checks 3, 5 and 6 | C03 does not say whether the idempotency lookup comes before or after the envelope checks. Suppose an outage is recorded, the reply is lost, and the console retries or re-submits the same signed envelope after the operator's role was revoked (check 3) or the registry version moved (check 6). If the checks run first, the console records **`ENVELOPE_REFUSED`** for an outage that **is** recorded. That is a contradictory reported outcome, the same defect as review 37's R37-01 | State it: the lookup by (link, `share-operations`, `action_id`) comes first, and a recorded outcome is returned without re-running checks 3 to 6. Check 6: if `target_version` is above the owner's applied registry version, answer `UNAVAILABLE` (retry, the registry feed is lagging). Only a version below it is refused. Add both cases to PT-3 |
| R39-08 | Minor | Status ("Errata owed"); Settled M1, M2 | The errata list is incomplete. **RFC-001** also owes: (i) for M1, idempotency "by (link, principal's **account**, key)" changes to the tenant; (ii) for M2, §11.1 rule (2) and the `REDUCTION_FINAL` row release the hold at `REDUCTION_FINAL` alone, but C03 rule 3 also needs the lifecycle `cut` at the highest revision; (iii) RFC-000 4.4 C4-7: `onAdopt`/`onMovedOut`, `Moving`, `Stopped`. C03 depends on the re-armed timers for the `T_eff` Tick and the `notice_due` entries, and PT-4 moves a link mid-reduction; (iv) `REDUCTION_SET_EXTENDED` becomes a feed event, not only an `ALERT` value. **RFC-003:** erratum 5.1 says "extension chunk", C03 says "extension number". Plus R39-01 (b) for C04 and RFC-002, and R39-02 / R39-03 (a) for RFC-001 | Complete the list in the Status row |
| R39-09 | Minor | `book_maintenance.window` ("closed window, both boundaries") | "Closed window" can be read as inclusive `[from, to]`. Everywhere else ranges are half-open `[from, to)` (P1-S28, P1-S67: `[10:00, 12:00)`). That leaves an off-by-one minute in the fit check and in the maintenance trim | "Half-open `[from, to)`, both bounds required" |
| R39-10 | Minor | Supply command preconditions (`A_now`, `A_p`, `L_R`, `K_s`, `K_p`) | The symbols are used but not defined in the contract. During an open notice, "below `A_now`" for a second `announce_reduction`, and "above `A_now`" for `record_increase`, depend on RFC-001 §3.1's definition ("the latest-recorded permanent fact") | Add a short symbol table that cites RFC-001 §3.1, with the worked case "a reduction to 6 is pending, then an increase to 8" |
| R39-11 | Minor | `cancel_maintenance` | No answer is defined for a booking already trimmed or cancelled by a reduction (`maintenance_cut`, `new_rate` 0), or for one whose window has ended | Cancelling a fully cut booking returns `CANCELLED_MAINTENANCE` with nothing freed, or a named refusal. A partly cut booking frees what remains. State which |
| R39-12 | Minor | CT-3.1 ("chunks out of their arrival order") | Consumers apply strictly in `feed_seq` order, so chunks cannot be applied out of order. As written, the test is either meaningless or tests a forbidden behaviour | Test a gap between two chunks and a duplicate chunk: `hold_1` stays until the gap is filled |
| R39-13 | Minor | Idempotency row "Feed event, same key different content: keeps the first copy and alerts" | C04, also on C01, "stops the partition and raises a page". The two feeds disagree on an integrity defect | Align on C01's rule (stop and page) |
| R39-14 | Minor | Versioning ("a new result or error value … tolerate as `UNAVAILABLE`-like") | A new **result** value means success. Treated as `UNAVAILABLE`, it makes the caller report "temporarily unavailable" for a recorded fact, and the supplier may then record it again under a new key (a second outage) | No new result values within v1. Only new error values may be read as `UNAVAILABLE` |
| R39-15 | Minor | Timeouts | Estimates are unmarked: "about 5 s (warm), up to 60 s (cold)", the 250 ms abandonment, and the 10 s notice budget are all (est.) in RFC-001. The 60 s retry budget equals the worst cold rebuild (60 s), so at worst the caller gives up just as the owner returns | Mark them (est.). Note that a cold rebuild at the limit can make a supply command report "temporarily unavailable" while the retried command is later recorded. The key makes a manual retry safe, so say so |
| R39-16 | Minor | `SupplyCommandHeader.sender` (`partition`, `generation`, `epoch` for `edge`/`console`) | The edge is stateless and has no partition generation or epoch, so `STALE_SENDER` has no defined meaning for it | Define the edge's and console's sender identity (for example a fixed partition with generation 0, never stale), or omit the field on this service |
| R39-17 | Minor | `CAPACITY_CHANGED` (`principal`, `role: string`) | For a system-decided `maintenance_cut`, the principal and role are undefined. `role` is an untyped string here but an enum in the header | Use the announcing principal of `R` with role `system:reduction`, or make it optional for `maintenance_cut`. Type `role` as the header's union |
| R39-18 | Minor | `OFFER_AFFECTED` | It is not stated whether `ranges` is the full current set and how an offer stops being affected (after a restoration), unlike `AFFECTED_CHANGED` | "Full current set per offer; `ranges: []` = no longer affected" |
| R39-19 | Minor | Pinned to / Transport ("through C01"); PT-5 ("C01's DT-38") | C01 is not in `docs/04-delivery/contracts/`. C03 depends on it for the markers, `Moving`/`Stopped`, partition moves and Kafka partition-count growth, which re-maps `link_id` → partition. `contracts.md` still lists a legacy "C03 SQL admission", so the ID collides | Freeze C03 together with or after C01, or pin RFC-006 rev. 6 §12 sections directly. Update the index |
| R39-20 | Minor | Traceability; `hold_2` liveness | P1-S84 is listed as "relied on" but has no C03 semantics row (the move's `reduce_parts` reaches the new link as `LEG_CHANGED`), and RFC-001 does not cite it (tool: uncited in S-LINK). Separately, no alarm covers a `hold_2` that never lifts (R39-01-class defects) | Add the P1-S84 row. Add a consumer obligation: alert when a reservation's `hold_2` outlives `REDUCTION_FINAL` by more than 1 h (est.) |
| R39-21 | Minor | Over-engineering: `LEG_CONFIRMED`/`LEG_CHANGED` on the feed | Their only obligated consumer is RFC-006 history. On the hottest link they are about 1,575+ events/s (RFC-001 §9: conversions), encrypted, which RFC-002 and RFC-003 must decrypt and skip. History already reads hold events from the log changefeed | Optional: let history read leg entries from the log changefeed, as it does hold events, and keep the feed for supply, flags and reductions. If kept, state why (late-change semantics) |

**Arithmetic re-checked.** P1-S81: `M` = 8 + 2 − 9 = 1, so the booking is cut to 1 Mbps; at
8, `M` = 2, so it is cancelled. Both are correct. P3-S58: 4 × 2 = 8 and 2 × 2 = 4 micro-USD,
correct. P4-S117 (relied on): 100 × 15 = 1,500, then 60 × 15 = 900, a credit of 600. The
split of 900 is 270 / 300 / 195 / 135, and the falls are 180 / 200 / 130 / 90, summing to 600.
All correct. Notice chain: 10 + 50 = 60 s, correct but at p99 only (R39-06). Kafka sizes:
1,000 reservation IDs is about 40 KB, and 1,000 `REDUCTION_AFFECTED` rows is about 120 KB
(est.). Both are well under 1 MB.

**NABC.** Not applicable to a contract. Competition and benefits are the RFCs'.

## Decisions taken

- **D39-1.** Read M2 "equals the highest" as the **highest applied** `target_revision`
  (R39-01 (a)). This keeps the orchestrator's decision and closes the stale-arrival path.
- **D39-2.** `REDUCTION_FINAL` follows every recorded answer (R39-02). That delays it by
  RFC-002's round trip (seconds). It costs closure nothing and removes extensions after
  `REDUCTION_FINAL`.
- **D39-3.** The affected notice is triggered by `AFFECTED_NOTICE` only (R39-05). It is
  already RFC-001's "notice events when due", so it needs the fewest changes to accepted
  RFCs.
- **D39-4.** Supply-command idempotency is per **tenant**, not per principal. A supplier's
  tools share one key space, and console actions use `action_id` under
  `share-operations`.
- **D39-5.** A supplier may restore an outage that network operations recorded, and the
  reverse. Each fact records its principal and role (X1-S14). That serves buyers' capacity
  fastest, and the audit trail shows who did what.
- **D39-6.** No new success results within `LinkSupply` v1 (R39-14).

## Requirements issues

- **RQ-39-1 (POL-07 `affected_notice_time`, P1-S26, P1-S75).** POL-04/POL-26 suspend
  release timeliness for `release_grace` while a link's schedule owner fails over. The
  affected notice has no such clause, although a cold rebuild (up to 60 s, est.) alone
  exceeds it. Proposed: "within `affected_notice_time`, or within `affected_notice_time` +
  `release_grace` while the link's schedule owner is failing over". The alternative is to
  require a warm standby for every link with sold capacity.

## Architecture issues

- **AI-39-1 (RFC-000 §8 rev. 4.4, C4-2 reading).** "RFC-002's … idempotency by key
  unchanged" conflicts with a release rule keyed on revision (R39-01). Proposed amendment:
  "`cut_target` idempotent by (link, reduction, reservation, **revision**); a revision at
  or below the highest recorded is answered with its recorded answer and writes nothing; a
  higher revision always writes a lifecycle `cut` carrying it; RFC-002's per-minute `min`
  unchanged".
- **AI-39-2 (RFC-000 §4.5 (2), reduction final step).** State that a reduction's final
  step follows every cut-target answer, so that no extension follows it (R39-02).
