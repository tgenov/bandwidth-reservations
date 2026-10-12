# 50. Fix verification: C12 partner port, version 1.1, against review 38

Date: 2026-10-12. Mode: fix verification. Focus: concurrency and money.
Under review: `docs/04-delivery/contracts/C12-partner-port.md` version 1.1, using its "Review 38
resolution" table. Review record: [38](38-contract-C12-review.md) (F1–F14, m1–m16, D1–D6,
RQ-1, RQ-2, AR-1–AR-3).
Authority: `requirements-v1.10` (POL-08, P2-S50, P2-S86, P2-S109, P2-S115), RFC-000 revision 4.4
(§5.2, §8, V-03), and RFC-002 revision 5 (§3.2 decrease row, §5.5 step 3, §9.3 change table,
E14, §13.1 feeds).

Tools: `tools/check_specs.py`: no problems (473 scenarios). `tools/impact.py coverage C12`:
there is no C12 slice (`KeyError`), as review 38 also found. Every P1/P2 ID in C12 §9 exists at
v1.10 (checked by `rg`). The three §5.3 key test vectors reproduce (`shasum -a 256`).

## Verdict

**ACCEPT WITH CHANGES.** All 30 findings are present, and each is applied at the place the
resolution table names. S1 now matches POL-08 on the main point: a shorten is always accepted,
and only a decrease can be forbidden by the partner's terms. Seven defects remain. Three come
from fixes interacting with each other (F4 × F5, F4 × F6, F4 × F13). Two are gaps between S1 and
POL-08 / RFC-002. One is missing errata. One is a conflict between F11's intake rule and P2-S86.
**Each one is a precise local edit of a few lines.** The orchestrator may apply them directly,
without another review round.

## Per finding

| ID | Status | Note |
|---|---|---|
| F1 (D1) | Verified, with V4 and V5 | Shorten is always accepted (§3.2 intake row, §3.3, S1, test 10.2.8). It is never rejected for partner reasons. Without amend, it becomes a cancel deferred to `newEnd`. |
| F2 | Defect V6 | Items (a)–(g) from review 38 are all listed, J11 has been added, and the `amending` / `cancel_scheduled` statuses exist. However, the errata that the fixes themselves create (F14/D5, m8, m11, m12) are missing. |
| F3 | Verified | Booking set (§3.3). `partId` and `reservationId` on `outcome_confirmed`. Result lists. Test 10.1.12. |
| F4 | Verified, with V1–V3 | `effectiveMinute` is required. The scheduled J5 is re-armed on takeover and `adopt`. `supportsFutureCancel` and `cancelLeadMs` added. Test 10.1.13. |
| F5 | Defect V2 | `changeSeq` ordering, supersession and `NOT_ALLOWED` → `CHANGE_FAULT` are present. "A cancel supersedes every outstanding amend" was written for an immediate cancel, and is now wrong for a deferred one. |
| F6 (D2) | Defect V1 | Residue reasons are removed, the adapter alone cancels a residue, and test 10.2.4 is fixed. The "one J5 per ref" rule swallows a later cancel that has an earlier effective minute. |
| F7 (D3) | Verified | High-water kept per account partition, `release` exempt, J7 kept (§3.1 rule 1, test 10.1.3). Matches RFC-000 §5.2. |
| F8 | Verified | §5.2 sameness table. `stamp` and `decisionTime` are excluded. Test 10.1.6. |
| F9 | Verified | `ResultIdentity` is a union. §4 uses it. |
| F10 | Verified | The §3.1 takeover rule: J2 releases before `NOT_BOOKED`; J3 and a cancel with no recorded booking get a second query. Test 10.1.15. |
| F11 (D6) | Defect V7 | The listing conditions are correct: 10 − 0.42 − 1 = 8.58 s ✓. P2-S109: 30 − 10 − 0.5 = 19.5 s > 19 s ✓. The added intake rule, however, makes P2-S86's 11 s deadline invalid at most partners. |
| F12 | Verified | `NOT_SENT_LATE` is no longer a result. A fresh intent is written with the same key. `h_s` is measured at p99.9. Test 10.1.2. |
| F13 (D4) | Defect V3 | Comparison against the journal at listing time, a once-per-ref action, and `DEFERRED` are all present. But `cancel_scheduled` is deferred, which hides shortfalls for days. |
| F14 (D5) | Verified, with V3 and V6 | PARTNER_SHORT and PARTNER_EXCESS added. `partner_leg_affected` carries the delivered figures. Test 10.2.6. |
| m1–m16 | Verified | All are present at the places named. m3: vectors checked. m15: 8.58 s and 9.58 s checked. m8 and m11/m12: the contract text is right, but the errata are missing (V6). |
| RQ-1 | Verified | Closed by D1. No requirements change is needed. |
| RQ-2 | Verified as open | Recorded as open with the requirements owner. C12 already behaves as the amendment would. |
| AR-1–AR-3 | Verified | Listed in the S1 obligations table. |

**S1 against POL-08.** Shorten: "Any time" ✓. Decrease forbidden "over a partner leg whose
terms shown at booking do not allow a decrease" ✓, with V4 (which terms are read). A shorten to a
later end pays only a minimum-term fee ✓. A shorten to or before the next boundary *is a
cancellation*, and the buyer pays the plain fee: not stated (V5). "Never cancel-and-rebook" ✓.

## Defects

| ID | Location | Failure | Fix |
|---|---|---|---|
| V1 | §3.3 `cancel` row ("One J5 per `partnerBookingRef`"); §5.1 `cancel` | F4 × F6. Suppose a revocation is scheduled for `T_eff` + 2 days, or a shorten without amend is scheduled for `newEnd`. The buyer then cancels (`effectiveMinute = nb(ts)`), or shortens a second time to an earlier end. The new cancel "returns that J5's result", so the partner booking runs on until the *later* minute. Share pays the partner for minutes nobody bought, and reconciliation defers the ref (`cancel_scheduled`), so nothing catches it. | Add: "A cancel for a ref whose J5 is still scheduled, with an earlier `effectiveMinute`, moves that J5's effective minute earlier and re-arms its timer. It is never moved later. Its result lists both `cancelId`s." Add to test 10.1.13: revocation at `T_eff` + 2 d, then a buyer cancel; the driver is called at `nb(ts) − cancelLeadMs`. |
| V2 | §3.3 "Ordering", third bullet; §3.5 PARTNER_EXCESS | F4 × F5. A deferred cancel (a revocation days ahead) "supersedes every outstanding amend". A decrease still retrying is then dropped, and the partner keeps the higher rate until the cancel at Share's cost. PARTNER_EXCESS compares against the "last confirmed state". A superseded amend was never confirmed, so reconciliation finds no difference and the cost is silent. | Change the bullet to: "a `cancel` supersedes an outstanding amend only for bookings whose remaining effect lies at or after the cancel's `effectiveMinute`. Other amends continue." In §3.5, compare PARTNER_EXCESS against the leg's **intended** state: the latest change not answered `CHANGE_FAULT`. |
| V3 | §3.5 "Deferred, never actioned" (`cancel_scheduled`) | F4 × F13. A scheduled cancel can wait for days, and nothing is in flight at the partner during that time. Deferring the ref means a partner that drops or reduces the booking in the meantime raises no SHARE_ONLY or PARTNER_SHORT. The buyer keeps paying for capacity that is not delivered (POL-23). | Remove `cancel_scheduled` from the deferred list: "A ref with a scheduled cancel whose driver call has not been sent is compared as `confirmed` for the minutes before its `effectiveMinute`. It is deferred only once `cancelling`." |
| V4 | §3.2 intake row ("`decreaseAllowed = false`"); S1 Decrease bullet; §8 Drivers bullet | POL-08 and RFC-002 §3.2 (the decrease row) say the check uses the terms **shown at booking, recorded in the reservation**. C12 reads `decreaseAllowed` from the classification cache, which holds the *current* terms ("Intake uses the cache"). If the terms change after booking, a decrease is wrongly rejected or wrongly allowed. Also, m13's deployment block compares the driver only with the current term. A driver that drops amend can therefore strand a live reservation whose shown terms allowed a decrease. | Intake row: "…whose terms shown at booking, as recorded on the reservation (RFC-002 E1), do not allow one". Mirror this in S1. §8: "A driver change removing `supportsAmend` is blocked while any live reservation on the link has a shown term allowing a decrease." |
| V5 | §3.3 `change` (shorten) row "Otherwise (D1)"; S1 Shorten bullet | POL-08 Shorten: "a shorten to or before the next minute boundary is [a cancellation]", and the plain fee is then the payer's (RFC-002 §9.3, the row "Cancel; shorten to or before the next boundary"). C12 says, without condition, that "Share bears any plain cancellation fee". That contradicts POL-08 for this case, and the two documents disagree on who pays. | Scope D1's fee sentence to "a shorten to a later end (after `nb(ts)`)". Add: "A shorten to or before `nb(ts)` is a cancellation: `cancel(reason = 'buyer_cancel', effectiveMinute = nb(ts), costBearer = 'payer_per_terms')`, and the buyer pays the plain fee shown (POL-08)." The same sentence in S1. |
| V6 | S1 "Consumer obligations" table | Errata that the fixes need are not listed. **(a)** RFC-002 E14: add `delivered {rate, window} \| null`, and the replacement rule (less capacity replaces the record). §9's input row ("Partner leg affected … Partner reconciliation feed") becomes `partner_leg_affected` on the reservation command port in §13 (m12, D5). **(b)** RFC-002 §13.1 reconciliation feed: identity across days, (partner link, ref) (F13). Add the kinds PARTNER_SHORT, PARTNER_EXCESS, DEFERRED and RUN_COMPLETED. **(c)** RFC-002 §9.7: a cut sends `change(cause = 'cut')` to a partner leg with amend (m8); at present it covers Share legs only. **(d)** RFC-003: rating charges a partner leg marked affected only for the delivered figures (D5); and Share's cost line for the plain fee on a shorten without amend (D1). **(e)** RFC-006: the console alert at 12:00 UTC on D + 1 when `RUN_COMPLETED` is missing (m11), and the new event kinds for the console and notifier. | Add rows (a)–(e) to the obligations table, and mention them in the F2 resolution row. |
| V7 | §3.2 owner intake row ("`D − commit_margin − σ_p` earlier than the intake `ts + expectedAnswerMs`"); §10.2 test 2 | P2-S86 requires an 11 s deadline with a partner leg to be "not invalid". With D = 11 s, `D_c − σ_p` = 1 s − σ_p. The rule therefore rejects the request at any partner with `expectedAnswerMs` > 1 s − σ_p, for example 750 ms at the default σ_p. RFC-002 §5.5 step 3 uses `expectedAnswerMs` only to send steps 2 and 3 together, never to reject. `σ_p_max` binds only `with_holds` partners, so a `without_holds` partner can still have σ_p ≥ 1 s. | Intake rule: reject only when `D − commit_margin − σ_p ≤` intake `ts` (no confirm could ever be sent). Make `σ_p ≤ σ_p_max` a listing condition for **every** partner (a partner without holds that fails it is not listed). Keep `expectedAnswerMs` as RFC-002 §5.5 step 3's trigger for parallel send. Test 10.2.2: "an 11 s deadline is accepted at every listed partner". |

Arithmetic rechecked: `commit_margin − τ − 1 s` = 8.58 s ✓; `commit_margin − τ` = 9.58 s ✓;
P2-S109 at σ_p_max: 19.5 s > 19 s ✓; P2-S86 at σ_p_max: `D_c − σ_p` = 0.5 s > 0, which is
valid under V7's rule ✓.
