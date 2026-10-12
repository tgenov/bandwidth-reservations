# 65. Requirements amendments after C4 (requirements v1.10 → v1.11)

Date: 2026-10-13. Baseline: `requirements-v1.10` ([review 35](35-requirements-amendments-before-c4.md)).
Result: `requirements-v1.11` (not tagged or committed by the amender).

Sources:
- The "Requirements issues" sections of reviews 36 to 63 (reviews 36, 37, 38, 39, 40, 41,
  42, 43, 44, 45, 46, 48 and 54 raise items; reviews 47, 55, 57 and 58 raise none new;
  the fix verifications 49 to 53, 56 and 59 to 63 only carry them).
- The requirements items that the frozen contracts list as owed: C02 "Scenarios relied on"
  and "Errata owed" (RQ-42-1, RQ-42-2, RQ-54-1); C03 Status (RQ-39-1); C04 "Consumer
  obligations" (review 43 RQ-1, RQ-2); C05 "Consumer obligations" (RQ-45-1); C06 "Upstream
  issues" (RQ-44-1); C07 "Errata owed" (RQ-37-1 to RQ-37-3); C08 "Consumer obligations"
  (RQ46-1); C09 "Open issues" (RQ-36-1 to RQ-36-3, RQ-48-1, R36-31); C10 errata list
  (RQ-40-1 to RQ-40-5); C11 "Settled" and review tables (RQ41-1 to RQ41-3); C12 "Settled"
  (review 38 RQ-1, RQ-2). C01 owes nothing to the requirements (its N1 is an RFC-006
  erratum).

Rules applied, as the brief binds them: (1) where a frozen contract settled the behaviour,
the requirements now match the contract; (2) otherwise the amendment that the raising
review proposed is accepted; (3) a business choice left open is decided by the amender
(listed below). Review 38 and review 43 both number their items RQ-1 and RQ-2; this record
names them "review 38 RQ-n" and "review 43 RQ-n".

## Decision table

27 items: 25 amended, 2 needing no change. No item is left undecided.

| # | Item | Source | Decision | Trade-off |
|---|---|---|---|---|
| 1 | RQ-36-1 | Review 36, 48; C09 Open issues | Rule 3. POL-19: the written request of a non-user and its evidence of identity or authority are kept in the erasable store, read only by compliance, and erased `erasure_evidence_retention` (new, 12 months) after the request is executed or refused, then gone from every copy within `erasure_max`; the pseudonymous record of the request stays 7 years | Share can prove a disputed erasure for a year; identity documents do not stay for the 7-year audit |
| 2 | RQ-36-2 | Review 36, 48; C09 Open issues | Rule 2 (review's proposal). POL-19: payout destination details are personal data; a covering request erases a destination's details once every payout to it is confirmed or has failed finally and is reconciled, `erasure_max` running from then; no payout until a new destination; the amount stays payable | Share can prove where money went; a sole trader's account details then go, at a delay of days |
| 3 | RQ-36-3 | Review 36, 48; C09 Open issues (contract covers up to execution + 1 h) | Rule 1 with rule 2. POL-19: a user's or an account's request covers payloads received before it is executed; only a request that names exporters and a period covers later payloads. C09's 1 h margin covers more and conforms | A request has a clear end; a person who expects more payloads names a period |
| 4 | RQ-48-1 | Review 48; C09 D-48-1 | Rule 1. POL-19: a record that holds the data of more than one person is erased whole when one of them is erased | The asking person is protected; the other person's data in that record is lost, so support writes one note per person |
| 5 | RQ-37-1 | Review 37; C07 D-37-1 | Rule 1. POL-21: one reversal per payment, at most what it credited, at the payment's own conversion; a partial reversal takes credited micros × reversed / paid, rounded down; a second reversal, one above the amount paid or one in another currency moves no money and goes to reconciliation and a finance operator | No gain or loss from a rate change; the rounding micro goes to the buyer; an unusual reversal waits for a person |
| 6 | RQ-37-2 | Review 37; C07 (no bound "until POL-32 decides one") | Rule 2 (review's proposal), threshold by rule 3. POL-32: a credit limit above `credit_limit_four_eyes_above` (new, 10,000 USD) needs a second finance operator; lower limits, decreases and removals need one | Large unsecured credit needs two people; routine small limits stay quick. C07's console warning at 10,000 USD stays compatible |
| 7 | RQ-37-3 | Review 37; C07 R37-28 (`provider_pnr_alert_usd`) | Rule 1. POL-24: an operational alert to finance when one provider's payments posted and not yet received exceed `provider_unreceived_alert` (new, 10,000 USD per provider, settable per provider as a policy setting); never a gate | Finance sees a growing exposure early; no buyer is stopped |
| 8 | Review 38 RQ-1 | Review 38, 50; C12 S1 as amended by D1 | No change. D1 keeps "shorten any time"; v1.10 already matches | — |
| 9 | Review 38 RQ-2 | Review 38, 50; C12 D5 | Rule 1. POL-28: a reservation that the partner has only in part is affected on that leg for the missing part, its holder told; P2-S91 new row | The buyer keeps the part that exists; only the missing part counts as an outage |
| 10 | RQ-39-1 | Review 39; C03 Status, PT-9 note | Rule 2. POL-07: a notice timed by `affected_notice_time` is due within `affected_notice_time` + `release_grace` while the link's schedule owner fails over; new P1-S85 | At most one more minute, rarely, instead of a warm standby for every sold link |
| 11 | RQ-40-1 | Review 40; C10 M2, D1 | Rule 1. Glossary *Outcome*: "rejected" also covers shown terms no longer in force and a fee-bearing request with no quote, the rejection stating the current terms. POL-08 "Shown terms" | Buyers and agents never pay a fee they did not accept |
| 12 | RQ-40-2 | Review 40; C10 M7 | Rule 1. Glossary: *Not accepted* adds "not parseable as a request (no idempotency key, or no well-formed body)"; *invalid* becomes "breaks a validity rule: window, rate, deadline, selling horizon or route" | One boundary between "not accepted" and "invalid" that a client can test |
| 13 | RQ-40-3 | Review 40; C10 M5, D4 | Rule 1. POL-29: a withdrawal names its request's key; every retry is the same withdrawal; a withdrawal of an unused key makes a later request with it, within `idempotency_retention`, fail "withdrawn"; a cited quote is not part of sameness. New Why and Rejected; new P2-S122 | An agent can stop a booking with certainty, for one record per early withdrawal |
| 14 | RQ-40-4 | Review 40; C10 R40-14 (`headroom_after`, conditional) | Rule 2, first option (confirm). POL-16: the quote also states the headroom after the resume amount, as an explanation, not an item; P4-S114 reworded with an `after` column | An agent can check the amount before it pays |
| 15 | RQ-40-5 | Review 40; C10 D1, D3 | Rule 1. POL-08: shown means in a quote the request cites; a booking, extension or increase with a partner-leg fee must cite one; a request whose quote has expired or whose terms changed is rejected with the current terms; Share never charges a fee not in a cited quote; glossary *Quote*; new P2-S121 | One more call on fee-bearing partner routes only; no unshown fee for the buyer and no absorbed fee for Share |
| 16 | RQ41-1 | Review 41, 57; C11 S-1, test 2 | Rule 1. P3-S28: rows "no exporter" and "no sequence number" (unreachable for authenticated IPFIX and NetFlow v9) replaced by C11's "missing flow times" and "missing attribution key"; new P3-S77: a record from an observation domain not registered to its exporter is kept, quarantined "domain not of exporter", charged only if finance attributes it | Every row is reachable and testable; the domain case keeps its evidence |
| 17 | RQ41-2 | Review 41, 57; C11 D41-1, D57-3, V62-03 | Rule 1. POL-23: a correction of a rejected record is charged only before `dispute_window` from the earlier of its last minute's end and its first receipt (first receipt alone with no usable times); later, refused and recorded; corrected times not after the first receipt beyond the design's clock tolerance; new P3-S78 | Buyers' charges are fixed after 30 days; suppliers keep 30 days to fix a rejection they were told of at once |
| 18 | RQ41-3 | Review 41; C11 identity per format | Rule 2. Glossary *Exporter*, POL-23, P3-N3: identity = exporter, observation domain, the exporter's counter epoch and the position in the export stream | Holds for IPFIX and NetFlow v9 alike |
| 19 | RQ-42-1 | Review 42, 54; C02 M-2 | Rule 1 with rule 2. POL-07, POL-10: from the start of a link's retirement nothing new is sold on it; a booking, extension or increase over it is rejected at once, "link unavailable", naming the link, no counter-offer, everything held released; no equivalent-path offer uses it. Glossary *Outcome*, *Link*; new P2-S120 | An agent can route around the link at once; no counter-offer on a link with no future |
| 20 | RQ-42-2 | Review 42, 54 (M3); C02 yield claims | Rule 2. POL-02: a holder that kept its capacity while not waiting yields once it starts to wait, if the older request still waits; new P2-S118 | The older request wins whatever the order of events, at the cost of one more yield request |
| 21 | Review 43 RQ-1 | Review 43, 58; C04 M-04 | Rule 1. POL-30: a withheld termination notice covers every notice and webhook the termination causes (the termination, requests and offers it ends); status reads still give the true state. Glossary *Told*; X1-S36 row 2 | The order is obeyed, and Share never gives a buyer a false answer |
| 22 | Review 43 RQ-2 | Review 43, 58; C04 M-01 | Rule 1. P2-S09 reworded: every request answered pending, a change included, gets its outcome by webhook (the glossary's *Booking request* already includes changes) | One rule for agents, whatever kind of request they sent |
| 23 | RQ-44-1 | Review 44, 55; C06 D3, M7 | Rule 1. POL-14 "Which cap and which window": the highest `usage_rate_cap` and the longest window in force over the bound's span; a cap change takes effect at a minute boundary at least 60 s after its record; new P3-S76. C06 keeps a decreased cap 60 s more for edge staleness, which conforms | Exposure is never understated after a cap decrease, for at most one span at the old cap |
| 24 | RQ-45-1 | Review 45, 53; C05 | Rule 2. Glossary convention *Enforcement time*: the time network operations records that a block applies, on a clock the design keeps within a stated bound of the decision clock; targets compare the two recorded times | Lateness is decided from records, never from a clock read |
| 25 | RQ46-1 | Review 46, 56; C08 | Rule 2. X1-S11 and X1-S24 become outlines with a supplier example (maintenance-cut notice); X1-N6 covers suppliers; rule renamed "Every receiver can verify every webhook Share sends" | Suppliers get the same proof as buyers; no new mechanism |
| 26 | RQ-54-1 | Review 54; C02 Scenarios relied on | Rule 2. New P2-S119: a cancellation or decrease made just after a confirmation frees the capacity on every leg from the next minute boundary, whatever the order in which the links learn of them | Makes C02's B1 case testable from the requirements |
| 27 | R36-31 (X1-S46 against RFC-000 "held") | C09 Open issues; C07 S2 | No change. C07 S2 settles "refused during the hold", which X1-S46 and P4-S118 already state | — |

## Changes by file

- `docs/02-specs/policy-register.md`: POL-02, POL-07, POL-08, POL-10, POL-14, POL-16,
  POL-19, POL-21, POL-23, POL-24, POL-28, POL-29, POL-30, POL-32 (Decision, Parameters,
  Why, Rejected, provenance line of each); Summary lines of the same 14 entries; the
  introduction's provenance paragraph; 17 rows in the Amendments table. New parameters:
  `erasure_evidence_retention` (POL-19), `provider_unreceived_alert` (POL-24),
  `credit_limit_four_eyes_above` (POL-32). POL-29 and POL-30 gain the missing Why or
  Rejected sections; POL-08 and POL-14 gain a Rejected section.
- `docs/02-specs/glossary.md`: Outcome, Not accepted, Told, Withdrawal, Link, Exporter,
  Reversal, Credit limit, Resume amount; new term *Quote*; new convention row
  *Enforcement time*.
- `docs/02-specs/P1-link-admission.feature`: new P1-S85.
- `docs/02-specs/P2-route-reservation.feature`: new P2-S118 to P2-S122; changed P2-S09
  (retitled), P2-S91 (new row).
- `docs/02-specs/P3-rating-and-metering.feature`: new P3-S76, P3-S77, P3-S78; changed
  P3-S28 (rows).
- `docs/02-specs/P4-wallet-and-settlement.feature`: new P4-S119, P4-S120; changed P4-S114
  (retitled, `after` column).
- `docs/02-specs/X1-security-and-tenancy.feature`: new X1-S47, X1-S48, X1-S49; changed
  X1-S11 (outline, retitled; Rule renamed), X1-S12 (credit-limit row), X1-S24 (outline),
  X1-S36 (row 2).
- `docs/02-specs/conformance.md`: regenerated (14 rows added, 4 retitled, none removed;
  every existing Design, Tests and Status cell kept).
- `docs/01-discovery/`: P1-N8 (need and measure); P2-N4, P2-N6, P2-N7, P2-N9, P2-N11
  (P2-N11 measure too); P3-N3, P3-N7, P3-N10; P4-N5, P4-N13, P4-N14; X1-N6 (need and
  measure), X1-N7, X1-N11.

## Decisions taken by the amender

1. **`erasure_evidence_retention` = 12 months** (POL-19), counted from execution or
   refusal, for executed and refused requests alike; legal confirms it per market. The
   evidence is compliance-only (matches C09 D-48-2). Balance: a year covers the usual time
   to complain to a data protection authority; identity documents never stay 7 years.
2. **Payout destination details: erasure waits for reconciliation** (POL-19). The
   condition is "every payout instructed to the destination confirmed or finally failed,
   and matched by the reconciliation"; `erasure_max` runs from then. When the current
   destination is erased, no payout is instructed until a supplier administrator sets a
   new one, and the amount stays payable (matches C07's `no_destination` carry-forward).
3. **RQ-36-3 boundary is "received before it is executed"** (POL-19). C09 covers up to
   execution + 1 h, which erases more and so conforms.
4. **`credit_limit_four_eyes_above` = 10,000 USD** (POL-32), the figure review 37 and C07's
   console warning use; "above" is strict (10,000 USD itself needs one operator);
   decreases and removals need one operator; the probe accounts' limits follow the same
   rule. Downstream: C07 and C08 must add the four-eyes path for this action (an erratum
   owed by the design, not a contract conflict, since C07 left the bound to POL-32).
5. **`provider_unreceived_alert` = 10,000 USD for each provider**, changed per provider only
   as a policy setting (no operator role writes policy parameters, C06 D6); checked by the
   daily reconciliation; the alert goes to finance. C07's `provider_pnr_alert_usd` is this
   parameter.
6. **The failover allowance (RQ-39-1) covers every POL-07 notice** timed by
   `affected_notice_time` (outage, restoration, change of affected minutes, offered path
   affected, maintenance cut), not POL-30's termination notice, which the account owner
   gives.
7. **Retirement stops sales, not exits** (POL-07). Only a booking, an extension or an
   increase over a link being retired is rejected; a cancel, shorten or decrease is still
   allowed; an equivalent-path offer never uses such a link.
8. **Quote scope** (POL-08). A quote is needed only for a booking, extension or increase
   whose terms carry a partner-leg fee (C10 D1); cancel, shorten and decrease need none.
   A quote states whether each partner leg can be decreased, not shortened, since POL-08
   lets a buyer shorten any time (C12 D1). The quote's validity period is the design's.
9. **An early withdrawal lasts `idempotency_retention`** (POL-29), the life of the key.
10. **Headroom after the resume amount is explanatory** (POL-16), so the resume amount and
    its items are unchanged and C10's `headroom_after` applies.
11. **P3-S28 rows** take C11's display strings "missing flow times" and "missing
    attribution key"; the domain case moves to its own scenario (P3-S77) because its
    outcome is quarantine, not a plain rejection.
12. **Corrected times after the first receipt** are refused only beyond "the clock
    tolerance that the design states" (C11 `future_skew_max`), so the requirement does not
    refuse what C11 accepts.
13. **Partial reversal rounding is down** (POL-21, POL-11), in the buyer's favour, as C07's
    `floor_µ` does.

## Arithmetic recomputed

All amounts in micro-USD unless stated.

- **P3-S76** (new): bound = cap × 430 s × 10,000 micro-USD per GB. 100 Mbps × 430 s =
  43,000 Mb = 5.375 GB → 53,750 (as P3-S37). 50 Mbps → 2.6875 GB → 26,875. 200 Mbps →
  10.75 GB → 107,500. Cap recorded 10:00:30; effect 10:02:00 (first minute boundary ≥
  10:01:30). Span = [now − 370 s, now + 60 s]: at 10:05:00 it is [09:58:50, 10:06:00]
  (old cap 100 Mbps in it); at 10:10:00 it is [10:03:50, 10:11:00] (only 50 Mbps; also
  past C06's 60 s staleness margin, which ends 10:09:10 after the bound's own 10:08:10);
  at 10:00:45 it ends 10:01:45 (before the increase); at 10:01:30 it ends 10:02:30 (after).
- **P3-S78** (new): last minute ends 12:06 on day D; first receipt 12:07 on day D;
  deadline = min(12:06, 12:07) + 30 days = 12:06 on day D + 30. 12:05 on D + 30 is
  accepted; 12:06 on D + 30 is refused.
- **P4-S119** (new; P4-S06 row 2): credited 9.516979 USD = 9,516,979 micro-USD for
  1,234 KES. Full reversal: 9,516,979. Half (617 KES): 9,516,979 × 617 / 1,234 =
  4,758,489.5 → 4,758,489 (4.758489 USD).
- **P4-S114** (changed): headroom after. Row 1: credit limit 5.000000 − credit hold
  0.288000 + balance 0.000000 after the invoice is paid = 4.712000 USD (as P4-S93). Row 2:
  2.500000 pays 1.000000 written off and 0.500000 for I2, leaving a balance of 1.000000;
  no credit limit, no holds, no exposure → 1.000000 USD = `low_balance_warning`. Amounts
  and items unchanged.
- **P4-S120** (new): 9,000.000000 USD < 10,000 USD → no alert; 12,000.000000 USD >
  10,000 USD → alert.
- **P2-S91** (new row): reservation 4 Mbps for [10:00, 12:00); partner has 3 Mbps for
  [10:00, 11:00); missing part = 1 Mbps for [10:00, 11:00) + 4 Mbps for [11:00, 12:00).
- **X1-S49** (new): 10,000.000000 USD is not above 10,000 USD (one operator);
  15,000.000000 USD is above (four eyes).
- No existing figure depends on a value changed here.

## New scenario IDs

P1-S85; P2-S118, P2-S119, P2-S120, P2-S121, P2-S122; P3-S76, P3-S77, P3-S78; P4-S119,
P4-S120; X1-S47, X1-S48, X1-S49. Changed: P2-S09, P2-S91, P3-S28, P4-S114, X1-S11, X1-S12,
X1-S24, X1-S36. None renumbered, reused or removed.

## Checks

`python3 tools/check_specs.py` before:

```
{'scenarios': 473, 'per': {'P1': 84, 'P2': 117, 'P3': 75, 'P4': 118, 'X1': 46, 'X2': 33}, 'needs': 67, 'pols': 33, 'params': 52}
NO PROBLEMS
```

`python3 tools/check_specs.py --regen`:
`regen: added ['P1-S85', 'P2-S118', 'P2-S122', 'P2-S121', 'P2-S120', 'P2-S119', 'P3-S77', 'P3-S78', 'P3-S76', 'P4-S119', 'P4-S120', 'X1-S49', 'X1-S47', 'X1-S48'] retitled ['P2-S09', 'P4-S114', 'X1-S11'] removed []`
(a second regen retitled P2-S120 after its title was made precise).

`python3 tools/check_specs.py` after:

```
{'scenarios': 487, 'per': {'P1': 85, 'P2': 122, 'P3': 78, 'P4': 120, 'X1': 49, 'X2': 33}, 'needs': 67, 'pols': 33, 'params': 55}
NO PROBLEMS
```

No line added to `tools/check_specs.allow`.

`python3 tools/impact.py diff HEAD WORKTREE`:

```
scenarios: +14 ~8 -0; policies changed: 14; needs changed: 15
  added: P1-S85 P2-S118 P2-S119 P2-S120 P2-S121 P2-S122 P3-S76 P3-S77 P3-S78 P4-S119 P4-S120 X1-S47 X1-S48 X1-S49
  changed: P2-S09 P2-S91 P3-S28 P4-S114 X1-S11 X1-S12 X1-S24 X1-S36
  policies: POL-02 POL-07 POL-08 POL-10 POL-14 POL-16 POL-19 POL-21 POL-23 POL-24 POL-28 POL-29 POL-30 POL-32
  needs: P1-N08 P2-N04 P2-N06 P2-N07 P2-N09 P2-N11 P3-N03 P3-N07 P3-N10 P4-N05 P4-N13 P4-N14 X1-N06 X1-N07 X1-N11
impacted slices:
  S-LINK (RFC-001-link-admission.md): ids P1-N08 P1-S85 P2-N04 P2-N09 P2-N11 X1-N07 X1-N11 X1-S36; policies POL-02 POL-07 POL-08 POL-10 POL-16 POL-19 POL-29 POL-30 POL-32
  S-ACCT (RFC-002-booking-coordination.md): ids P1-N08 P2-N04 P2-N06 P2-N07 P2-N09 P2-N11 P2-S09 P2-S118 P2-S119 P2-S120 P2-S121 P2-S122 P2-S91 P4-S114 X1-S36; policies POL-02 POL-07 POL-08 POL-10 POL-14 POL-16 POL-23 POL-28 POL-29 POL-30 POL-32
  S-RATE (RFC-003-rating-and-metering.md): ids P3-N03 P3-N07 P3-N10 P3-S28 P3-S76 P3-S77 P3-S78 X1-N07 X1-N11 X1-S12; policies POL-07 POL-08 POL-14 POL-16 POL-19 POL-21 POL-23 POL-24 POL-28 POL-29 POL-30 POL-32
  S-MONEY (RFC-004-wallet-and-settlement.md): ids P3-N10 P4-N05 P4-N13 P4-N14 P4-S114 P4-S119 P4-S120 X1-S12; policies POL-07 POL-08 POL-10 POL-14 POL-16 POL-19 POL-21 POL-23 POL-24 POL-28 POL-29 POL-30 POL-32
  S-SEC (RFC-005-security-and-tenancy.md): ids P2-N07 P2-S09 P3-N03 X1-N06 X1-N07 X1-N11 X1-S11 X1-S12 X1-S24 X1-S36 X1-S47 X1-S48 X1-S49; policies POL-07 POL-08 POL-10 POL-14 POL-16 POL-19 POL-21 POL-23 POL-24 POL-28 POL-29 POL-30 POL-32
  S-PLAT (RFC-006-availability-and-operations.md): ids P1-N08 P2-S09 P3-N03 P3-N07 X1-N11 X1-S11 X1-S24; policies POL-07 POL-14 POL-16 POL-19 POL-24 POL-29 POL-32
  ARCHITECTURE (RFC-000): cites P1-N08 P2-N04 P2-N06 P2-N07 P2-N09 P2-N11 P3-N03 P3-N07 P3-N10 P4-N05 P4-N13 P4-N14 POL-02 POL-07 POL-08 POL-10 POL-14 POL-16 POL-19 POL-21 POL-23 POL-24 POL-28 POL-29 POL-30 POL-32 X1-N06 X1-N07 X1-N11
```

Note: the worktree also holds an edit to `docs/03-rfcs/RFC-000-architecture.md` that the
amender did not make (another session's work); it is outside this amendment.
