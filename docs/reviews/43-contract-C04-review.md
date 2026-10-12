# Review 43. Adversarial review of contract C04 (reservation feeds and the operator side of the reservation command port)

| | |
|---|---|
| Under review | [C04](../04-delivery/contracts/C04-reservation-feeds.md), version 1 (draft). Mode: contract. Focus: money and concurrency |
| Authority | Requirements at `requirements-v1.10` (POL-04, POL-07, POL-08, POL-16, POL-28, POL-30; P1-S84, P2-S06 … S10, P2-S43, P2-S80, P2-S84, P3-S08, P3-S09, P3-S42, P3-S45, P3-S63, P3-S74, P4-S23, P4-S97, P4-S117, X1-S16, X1-S17, X1-S36). RFC-000 revision 4.4 (§8 rows "Request outcome feed", "Reservation lifecycle feed", "Reservation command port"; "Revision 4.4 errata" C4-1 … C4-7) |
| Contract sections read | RFC-002 rev. 5 (§2.2, §8, §9.1 … §9.7, §13.1). RFC-003 rev. 5 + erratum 5.1 (§5.2, §5.4, §7). RFC-004 rev. 5 + erratum 5.1 (§A4 F7, §A7, JR-2, §B3.4). RFC-005 rev. 5 (§7.2, §7.4). RFC-006 rev. 6 (§5.3 … §5.5, §15, §16). Neighbouring drafts, contract sections only: C01 (§2.1, §3.5, §3.6, §3.8, §4, §5), C02 (`cut_target`), C03 (closure rules), C05 (in-process booking/funds types), C10 (`pending` answer) |
| Settled list | MM-1 … MM-12 and the per-call deadline are treated as binding. Findings about them concern how they are applied, or show that a mechanism cannot meet the decision's own intent (B-01 against MM-10, M-06 against MM-12, M-07 against MM-5) |
| Tools | `python3 tools/check_specs.py`: no problems (473 scenarios). `python3 tools/impact.py coverage`: no contract slice; it reports P1-S84 uncited by RFC-001 (S-LINK) and P4-S117, P4-S118 uncited by RFC-004 (S-MONEY). C04 relies on P1-S84 and P4-S117 (see m-10). Every scenario ID that C04 cites exists (checked with `rg`) |

## Verdict

**REJECT** (revise and re-review). The review finds 1 Blocker, 7 Majors and 15 Minors.

Most of the contract is sound:

- the `reported` gate as C01 defines it;
- absolute `part_rates`;
- the cut composition being independent of arrival order;
- resolved-marker closure over the relay path.

The Blocker is MM-10's mechanism. A flag that is fixed in the reporting entry cannot record
a `pending` answer the owner sends after that entry commits. With the margins in RFC-002
§8.1, that happens routinely at p99. Every fix needed is local to this contract, plus the
errata listed below.

### Traces run

1. **Single-link booking at the tail (P2-S07 / P2-S09).**
   - Under RFC-002 §8.1 the owner holds the submission until `ack_budget` − 20 ms, which
     is 180 ms with C10's 200 ms.
   - E5 commits at about 150 ms with `answered_pending = false`, because no `pending` has
     been sent yet.
   - A status reader acknowledges late, so the report position passes E5 only at 185 ms.
     At 180 ms the owner sends `pending`.
   - The outcome is reported at 185 ms with `answered_pending = false`, so the notifier
     sends no webhook.
   - The buyer was answered `pending` and is never sent the outcome. **This fails P2-S09
     (B-01).** RFC-002 §8.1 puts the p99 from R2 at 186 to 196 ms, so this path is not
     rare.
2. **Same booking, owner crash after E5 commits but before the report.**
   - The predecessor sends `pending` at 180 ms, then dies.
   - The new owner's first marker covers E5. The flag is already committed as `false`,
     and C04's takeover rule ("a request it reports takes `true`") applies only to
     entries the new owner writes.
   - No webhook is sent (B-01).
3. **Cancel answered `pending`.**
   - The cancel is decided by an E11 and reported only when its E12 commits (RFC-002
     §9.3; E12 "gates reporting of changes that free capacity").
   - C04's list of reporting entries (E5, E1′, E4/E6/E7, E8) and PO-1 ("nowhere else")
     contain neither E11 nor E12.
   - No outcome event is written, so there is no webhook, and alerting and the console do
     not see the failed changes that the ending E11 caused (M-01).
4. **Late-extension cut (P4-S117) with a second revision.**
   - The link sends revision 2, whose content per minute equals what the owner has
     recorded.
   - C02 writes an E11 "for a new revision". C04 says "a repeat of a target with the same
     content emits nothing".
   - If C04's rule is followed, no `cut` carries revision 2. Rating's `hold_2` then waits
     forever for a `cut` at the highest `CUT_DECIDED` revision, and the reservation's
     minutes never close or settle (M-02).
5. **Move onto a path after a partner-leg booking.**
   - The old partner leg is cancelled at Share's cost (RFC-002 §9.6, Final row), but
     `moved` carries no `fees_due`.
   - The new path's partner leg has index 1, as the old one did, so both fees have
     `fee_id` `"r/1"`. Rating's "charged at most once per `fee_id`" then drops the second
     fee (M-03).
6. **Compliance legal-order termination with `withhold_notice`, and the reservation has
   an Accepted offer and a queued extension.**
   - The ending E11 moves the offer to Failed, and `offer_failed` is a holder notice.
   - The E11 fails the extension with "reservation ended", and its outcome webhook goes to
     the holder.
   - The holder is therefore told, against X1-S36 row 2 (M-04).
7. **`terminate` reply lost (`Ambiguous` resolved committed, or a connection drop).**
   - The console re-sends with the same `action_id`.
   - C04 defines no C01 command identity. On the retry, check 6 (`target_version`) fails
     because the E11 changed the reservation, or the owner answers `NOT_ACTIVE`.
   - The console records "refused" or "not active" for a termination that took effect
     (M-05).
8. **Revocation by a late-extension cut.**
   - `ended(revoked)` is written in the cut's E11 with `effective` = `T_eff`, which is
     before `floor_min(ts)`.
   - PL-6 and the closure "Guarantee" bullet allow only `cut` and `ended(window_end)` to
     do that, so a conforming provider fails PL-6 (M-06).
9. **Renewal at 17:59:30 of a reservation ending at 18:00, with a partner leg answering
   at 18:00:20.**
   - MM-5's timer E11 (cause window end) commits in the first batch at or after 18:00.
   - Under the ending-E11 rule (P2-S80) it fails the in-progress renewal "reservation
     ended", although the renewal was admitted in time and its holds and funds were
     taken (M-07).
10. **Release after grace with the owner unavailable for 50 s at `grace_end`.**
    - F7 commits at `grace_end` + 50 s or later, and the release takes effect at
      `nb(ts)`.
    - About 1 minute is accrued beyond the grace, partly or wholly past the frozen hold
      window.
    - MM-4 says this is never alerted, and its "at most 1 extra minute" bound is false in
      this case (m-01).
11. **Revision 1 relayed after revision 2.**
    - C02 records the lower revision after the higher one, leaves the `min` unchanged and
      writes an E11, so a `cut` with `target_revision = 1` follows the revision-2 event.
    - Rating still holds the revision-2 event and releases correctly. C04's text ("a
      higher `target_revision` … supersedes") is wrong about order, though (folded into
      M-02).
12. **Termination raced by a cut E11 or a price step.** Serialised by the owner. The
    envelope's `target_version` check refuses a stale one. That is safe, but see m-15.

## Findings

| ID | Severity | Location | Finding | Proposed change |
|---|---|---|---|---|
| B-01 | **Blocker** | `OutcomeEvent.answered_pending`; Semantics "`answered_pending`"; PO-5; MM-10 | The flag is fixed in the reporting entry's transaction. The owner decides between a final answer and `pending` later, when the report position passes the entry or the sync deadline fires (RFC-002 §8.1). An entry committed with `false` can still be followed by `pending`, because reporting waits for leased readers and the marker. This happens at p99: about 186 to 196 ms to reportable against a 180 ms owner deadline. The takeover rule does not help when the predecessor committed `false` and then sent `pending`. Result: a buyer answered `pending` gets no webhook (P2-S09). The claim "an extra webhook, never a missing one" is false | Keep the event flag (MM-10's intent and sizing): `true` when `pending` was sent before the entry was formed. Add to `ReportMarker` a field `pending_answered: RequestId[]`, listing the outcome events that this marker covers for the first time and whose submission the owner answered `pending`. The owner sends the final answer only once the report position passes, and it writes the marker afterwards. When it writes the first marker covering q, it therefore knows whether `pending` was sent for q. After any acquisition or `adopt`, the new holder's first marker lists every covered event above the predecessor's last `report_through`, which errs towards an extra webhook. Notifier rule: send a webhook iff `answered_pending` is true or the first covering marker lists the request. This adds no latency, because the gate already buffers until that marker. Amend PO-5 and CN-1, and the RFC-002 §8.3 and RFC-006 §5.3/§15 errata |
| M-01 | Major | Semantics, outcome feed, "One event per reported outcome"; PO-1 | Change requests are decided by an E11 (cancel, a shorten to or before the next boundary, a decrease, a shorten that does not end) and, when they free capacity, reported only at E12 (RFC-002 §2.2, §9.3). Queued and in-progress changes failed by an ending E11 ("reservation ended") are also decided in that E11. None of these entries can write an outcome event under C04, and PO-1 forbids it. Result: no outcome event, webhook, alert or console row for those requests | Reporting entries are E5, E1′, the ending entry (E4, E6, E7, **or the E11 that decides or fails a change**) if it already records every release, otherwise the completing E8, and **E12** for a change whose leg changes free capacity. Amend PO-1. Add an RFC-002 §8 erratum (§8.3 and the §8 gate sentence) |
| M-02 | Major | `Cut.target_revision`; Semantics "Cut"; Idempotency row `cut` | (a) C04 skips a `cut` for "a repeat with the same content", and its semantic key is (link, reduction, reservation). C02 keys the command by (link, reduction, reservation, **revision**) and writes an E11 for every new revision. If revision n is not emitted, `hold_2` (released only at the highest `CUT_DECIDED` revision, C03 M2) never releases, so rating's closure and settlement for that reservation stall with no timeout. (b) C02 records a lower revision that arrives after a higher one, so a later event can carry a *lower* revision. "Supersedes … with a higher `target_revision`" misstates the order | Exactly one `cut` per (link, reduction, reservation, revision) received, whatever its content (`part_rates: []` when nothing changes). Nothing is emitted only for the same (key, revision) and the same content. Same (key, revision) with different content: no event, alerted (C02 `MISMATCH`). Supersession is by `stream_seq`, not by revision. `target_revision` is the revision of the command applied. Amend PL-3, CR-2 and the Idempotency row |
| M-03 | Major | `Moved`; `FeeId`; MM-2; CR-4 | (a) When a move becomes Final, any old partner leg is cancelled "per its shown terms at Share's cost" (RFC-002 §9.6). `moved` has no `fees_due`, so no Share-borne fee line is ever produced and the payment to the partner is unrecorded (POL-23). (b) `fee_id = "<reservation>/<leg index>"` repeats across paths: new path leg 1 = old path leg 1. A fee due on the new path after one on the old path is dropped as a duplicate, which is lost revenue or an unrecouped partner fee | Add `fees_due: FeeDue[]` to `Moved` (old-path fees falling due at `move_at`, payer `share`). Change MM-2's ID to `"<reservation>/<path>/<leg index>"`, where `<path>` is `0` for the booked path and the offer ID after a move. Add PL-5 and CR-4 cases. Add the RFC-002 §9.5/§9.6 and RFC-003 §5.4 errata |
| M-04 | Major | MM-8; Semantics "Holder notices"; CN-2 | Suppression covers only the `ended` event. The same E11 can produce other holder-visible pushes: `offer_failed` (and `pol28_residue`) for an Accepted offer, and outcome webhooks with reason `reservation_ended` for each `failed_changes` request. With `withheld`, these tell the holder, against X1-S36 row 2 | Every lifecycle notice and outcome webhook whose source entry is a termination E11 with `notice = "withheld"` is suppressed. Mark them with `withheld_by: action_id` in the event. A buyer's poll still answers truthfully, because a read is not a notice. Extend CN-2. See RQ-1 |
| M-05 | Major | `TerminateRequest`; Idempotency row `terminate`; Runtime results | (a) C04 defines no C01 `CommandEnvelope.identity` for `terminate`, and `RoutingHeader` is not a C01 type (C01 uses `CommandEnvelope.routedTo`). (b) REFUSED writes nothing (PC-2), so it cannot be "answered again". (c) The claim that a different envelope under a used `action_id` "fails `operator_check`" is false: RFC-005 check 3 refuses only assertions consumed under *another* `action_id`. (d) `Ambiguous` and `NOT_OWNER` are missing. Result: a retry after a lost reply is answered `NOT_ACTIVE` or `REFUSED(target_version)` for a termination that took effect, so the console and audit hold contradictory outcomes | Identity = (account partition, `action_id`), recorded with the E11, and also with a refusal (D-5). On receipt, look up the identity **before** the checks: same digest gives the recorded answer; a different digest gives `REFUSED(digest)`. Use C01's `CommandEnvelope` and `RoutingRefusal`. Map `Ambiguous` and "not known to be committed" to a console retry with the same `action_id`. Amend PC-2, PC-3 and CC-1 |
| M-06 | Major | Semantics "Effective minutes"; closure "Guarantee"; PL-6; MM-12; RFC-003 erratum row | MM-12 makes `ended(revoked)` effective at the first all-zero minute, which can be `T_eff` < `floor_min(ts)`. That is a third exception, which the closure guarantee, PL-6 and the RFC-003 §5.2/§7 erratum do not list. A conforming provider fails PL-6, and rating's late-end checks misfire on it | List the exceptions as: `cut` and `ended(revoked)` written in the same E11 (closure held by `hold_2`, and amended late per CR-3), and `ended(window_end)`. Amend PL-6, the guarantee bullet and the RFC-003 erratum |
| M-07 | Major | MM-5; RFC-002 erratum row MM-5 | The timer E11 (cause window end) "in the first batch with `ts` ≥ window end" is an ending E11, so it fails a change in progress (P2-S80). A renewal or extension admitted before the window end (P2-S84) whose E5 lands after it, which is possible within the change's 60 s deadline, is failed although its holds and funds were taken. This is a regression introduced by MM-5 | While an addition whose added part starts at the window end is undecided, defer the window-end E11 to that change's outcome. If the change is confirmed, nothing ends. If not, write `ended(window_end)` with `effective` = the old window end, which is already an allowed exception (D-4). Add a PL test |
| m-01 | Minor | MM-4; Timeouts "Late-E11 alarm"; RFC-004 erratum row | "At most 1 extra minute" holds only if F7 commits within the minute of `grace_end`. With the owner unavailable (RTO 1 min, longer in a region event) the release takes effect minutes late, accrues beyond the frozen hold (negative balance at Share's risk), and is never alerted | Keep `nb(ts)`. Set `delay_min = nb(ts) − ceil_min(grace_end)` and alert when it is > 0. State the bound as "the minute containing `grace_end`" |
| m-02 | Minor | `ReportMarker`; `EventHeader` | Disagrees with C01: C01 has `reportPosition`, `generation: 0` (literal), header `report_through`, `Epoch`/`StreamSeq` as int64 (`bigint`, decimal strings in headers), and `partition: Uint8Array`. C04 has `report_position`, `generation: number`, `number` types and `partition: AccountId` | Use C01's types and names verbatim |
| m-03 | Minor | Idempotency row "Feed event", same key and different content | C04 says "stop the partition and page". C01 §5 says "security alert, keep the first" | Pick one in C01 and reference it. For rating, stopping is safer; state that explicitly |
| m-04 | Minor | `LifecycleResolved`; closure "Guarantee" | Direct-publish and takeover-republish copies of rows with `ts ≤ resolved` can arrive after the marker (a delayed producer). They are duplicates, but the literal text calls them impossible | "No row with a **new** (partition, stream, `stream_seq`) and `ts ≤ resolved` follows; duplicates may" |
| m-05 | Minor | `account_is_probe`; MM-1 | An F9 change between two events of a reservation is invisible until the next event. RFC-003 §7 also takes probe designation from the catalogue (§6.1), so there are two sources that can disagree | Name one source of truth: the catalogue designation, with the feed flag as a cross-check that is alerted on mismatch. Otherwise emit an event per reservation on an F9 change |
| m-06 | Minor | Versioning | Rating must stop on any unknown `kind`, so a new kind that is "compatible because rating may ignore it" cannot exist | Every new lifecycle `kind` goes to `.v2`, or add a header `rating_ignorable: true` that rating trusts |
| m-07 | Minor | "Move after a cut"; PL-4 | Targets are decided "at or after `T_eff`" over about a minute. A move made Final after `T_eff` but before its target arrives carries the full rate, and the later `cut` lowers the moved parts (composition per part). PL-4 as written fails that legitimate order | "carries the cut rates of the targets recorded before the move's entry; a later target emits `cut` lowering them". Test both orders |
| m-08 | Minor | `Cut.applied.change_ids` | `"none"` here against `[]` in C02. `ChangeId` is defined as the E11's ID, but an array implies several | Use `ChangeId[]`, with `[]` meaning none. Say whether the IDs are the E11's (one) or per-leg |
| m-09 | Minor | Consumer obligations | C05's in-process `Notice.ReleasedAfterGrace` is a second release notice, against MM-9. C05's `EndCause` (`moved`, `shortened_to_end`, no `cancelled_after_cut`) and `feeDue` without a payer disagree with C04. The funds module could drain a buyer's hold for a Share-paid fee (revoked, or cancelled after a cut) | Add RFC-004 and C05 obligations: drop the funds release notice, or make the notifier not deliver it; align `EndCause`; carry the payer with `feeDue` |
| m-10 | Minor | "Scenarios relied on"; errata list | Missing from the list: P3-S08 (MM-12), P3-S09 (MM-4), P2-S06 (B-01), P2-S84 (M-07), P1-S31. The tool reports P1-S84 uncited in RFC-001 and P4-S117 uncited in RFC-004, yet C04 rests on both | Add the citations. Add RFC-001 and RFC-004 traceability errata to the obligations table |
| m-11 | Minor | Entry → events table, `pol28_residue` | A partner booking found later by reconciliation for a failed or withdrawn request or offer (RFC-002 §10.4, §10.6) is cancelled at Share's cost by an entry that is not in the table | Add the reconciliation entry as a writer of `pol28_residue` |
| m-12 | Minor | `TerminateAnswer` | The order of `NOT_ACTIVE` against envelope checks is unstated. An invalid envelope on an ended reservation could reveal state | Run checks 1 to 5 first, then the existence and active checks, then check 6 |
| m-13 | Minor | `OfferNotice.cut_kept.rate` | A single rate is lossy when the cut is minute pieces (parts with different windows) | `cut_kept: { pieces: Pieces; may_book_increase: true }` |
| m-14 | Minor | "Effective minutes" first bullet; CR-1 | `part_added` does not start at or after `nb(ts)`. It starts at the change's interval start (`[old end, …)`, or the next boundary after intake, P3-S45), which can be `floor_min(ts)`. That is closure-safe only because the deadline is at most 60 s. CR-1 does not say where a part's accrual starts | State "`part.window.start` ≥ `floor_min(ts)`, guaranteed by `route_deadline_max` ≤ 60 s", test it in PL-6, and add part accrual from `part.window.start` to CR-1 |
| m-15 | Minor | `OperatorEnvelope.target_version` | Which entries bump the reservation's change sequence is undefined (price step, E13, E14, cut). One product-wide price step would invalidate every pending compliance termination (approval up to 72 h) | Define it as the sequence of the last E11 that changed the reservation's parts, window or legs. State that E13 and E14 do not bump it |

Estimates check: the 20 ms marker, the 2 s per-call deadline, the 2 to 3 s closure lag and
the 1 s first webhook attempt are all marked (est.) and match RFC-002 §8.3 and RFC-006
§5.3/§15. `affected_notice_time` (60 s), `webhook_retry` (24 h) and the 25 h outbox
retention match the register and RFC-006. There are no money worked examples in C04, and
the units (micro-USD strings, pico-USD per Mbps-minute) match RFC-003 §2.

Over-engineering: none material. `leg_changes_durable`, `offer_cut_kept` and the window-end
E11 each serve a named consumer need. B-01's fix reuses the marker the gate already waits
for, rather than adding a write before `pending`.

## Decisions taken

| # | Decision | Balance |
|---|---|---|
| D-1 (B-01) | The webhook is due iff the outcome event says `answered_pending` or the first covering marker lists the request in `pending_answered`. After a holder change, the first marker lists everything above the predecessor's last `report_through` | Buyers and AI agents never miss an outcome they were promised. The extra webhooks are bounded to takeover windows. RFC-006's sizing is unchanged |
| D-2 (M-03) | `fee_id = "<reservation>/<path>/<leg index>"`, where `path` is `0` for the booked path and the offer ID after a move. `moved` carries the old path's fees due, paid by Share | Partners are paid exactly, and Share's cost is recorded under POL-23 |
| D-3 (M-04) | A withheld termination suppresses every pushed notice and webhook caused by its entry. Buyer-initiated reads stay truthful | It meets the legal order. A read is not a notice, and making status reads lie would break P2-S10 |
| D-4 (M-07) | The window-end E11 waits for an in-progress addition that starts at the window end | Buyers, especially agents renewing near the end, keep a renewal admitted in time. There is no closure cost, because `ended(window_end)` is already an exception |
| D-5 (M-05) | The owner records refusals of operator commands as an audit-only entry (no state change), keyed by (partition, `action_id`) | Replays are stable, and a compromised console's probing leaves a record in the owner's own log. Refusals are rare, so the cost is negligible |
| D-6 (m-01) | Release stays at `nb(ts)`, and a release later than the `grace_end` minute is alerted with `delay_min` | Operability: an owner outage at `grace_end` becomes visible, and the normal case stays unalerted |

## Requirements issues

| ID | Issue | Proposed amendment |
|---|---|---|
| RQ-1 | X1-S36 row 2 says "the holder is not told" but does not say whether "told" covers outcome webhooks for requests the termination failed, offer notices, and the holder's own status reads | Add to the glossary under *Told*, or to POL-30: a withheld termination suppresses every notice and webhook it causes; status reads made by the holder still report the true state |
| RQ-2 | P2-S09 says "a booking of theirs was answered pending". It does not say whether change requests (cancel, shorten, decrease, extension) answered `pending` get the webhook, which M-01 assumes they do | State that P2-S09 applies to every booking request, changes included (RFC-002 §9.2 already calls a change submission a booking request) |

## Architecture issues

| ID | Issue | Proposed amendment (RFC-000 §8) |
|---|---|---|
| AI-43-1 | The "Request outcome feed" row and §4.6 assume that whether the buyer was answered `pending` is known when the reporting entry is written. It is not (B-01) | Row: "markers (slot, epoch, report position, **the requests newly covered that were answered `pending`**)", and the notifier sends a webhook for an outcome answered `pending` per the event or its first covering marker |
| AI-43-2 | The lifecycle row says "every entry's effective minute is at or after its `ts` … except a cut". MM-5 and MM-12 add `ended(window_end)` and `ended(revoked)` | List all three exceptions in the row and in §4.5 (2) |
| AI-43-3 | The reservation command port row gives `terminate` no idempotency identity | "terminate, idempotent by (account partition, `action_id`); refusals recorded" |

## Errata completeness (Settled → Consumer obligations)

The listed errata cover MM-1 … MM-12. Missing:

- RFC-002 §8 and §8.3 for M-01 and B-01.
- RFC-002 §9.5 and §9.6 for M-03.
- RFC-003 §5.2 and §7 for the `ended(revoked)` exception (M-06).
- RFC-006 §5.4, where the marker header is named `report_through`, against C04's `report_position` (m-02).
- RFC-004 Part A and C05 for the duplicate release notice and the payer of a fee due (m-09).
- RFC-001 and RFC-004 traceability for P1-S84 and P4-S117 (m-10).
- RFC-005: none needed, but C04's statement about its check 3 must be corrected (M-05).
