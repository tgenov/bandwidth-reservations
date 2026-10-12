# Requirements amendments from the C3 reviews of the revision 3 RFCs (v1.7 → v1.8)

| | |
|---|---|
| Resolves | Requirements issues of [review 16](16-rfc-005-review.md) (`RQ-R5-1` to `RQ-R5-7`, current readings in RFC-005), [review 17](17-rfc-001-review.md) (`RQ-17-1`, `RQ-17-2`), [review 18](18-rfc-002-004-joint-review.md) (`Q-1` to `Q-4`), [review 19](19-rfc-003-review.md) (`RQ-19-1` to `RQ-19-5`), [review 20](20-rfc-006-review.md) (`RQ-R6-1`, `RQ-R6-2`), and the RFC issue tables: RFC-002 `B-RQ-10` (= Q-4), RFC-003 `RQ3-16`, RFC-004 `RQ4-13`, RFC-006 `RQ6-4`, `RQ6-5` |
| Decisions applied | Coordinator decisions (binding) for all 29 issues, plus the coordinator's later refinement of RQ-R6-1 (from RFC-000 rev 4.2 risk R24); points they left open were decided by the amender (last section but two) |
| Files changed | `02-specs/policy-register.md`; all six `.feature` files; all six problem statements in `01-discovery/` (not `company-profile.md`); `02-specs/glossary.md`; `02-specs/conformance.md` (regenerated); this record |
| Not read | Code, `history/` |
| Not edited | `03-rfcs/`, `04-delivery/`. Note: `03-rfcs/RFC-000-architecture.md` shows as modified in this worktree; that change is not from this work |
| Date | 2026-10-12 |

## Outcome

The baseline now has **462 scenarios** (was 448): P1 80, P2 117, P3 74, P4 116, X1 43,
X2 32. No ID was renumbered, reused or removed. The 14 new IDs continue each file's
numbering, each inside the Rule it belongs to:

- **P1-S79**, **P1-S80**;
- **P2-S117**;
- **P3-S74**;
- **P4-S114**, **P4-S115**, **P4-S116**;
- **X1-S40**, **X1-S41**, **X1-S42**, **X1-S43**;
- **X2-S30**, **X2-S31**, **X2-S32**.

Retitled: P3-S63 (now an outline with a `terms` column and a third row) and X1-S15 (now an
outline, two rows). Amended in place without a new title: P1-S63, P1-S78, P3-S37, P3-S71,
P4-S15, P4-S16, P4-S111, X2-S27, X2-S29. The X1 Rule "An agent key acts only for its
account, until it is revoked" is now "An agent key acts only for its account, and every
credential stops working within 60 s of its revocation".

Needs: still 67, none new. Amended: P1-N1, P1-N8, P2-N8, P3-N7, P3-N10, P3-N12, P4-N5,
P4-N11, X1-N3, X1-N7, X1-N8, X1-N9, X1-N11, X2-N1. Register entries changed: POL-04,
POL-06, POL-07, POL-08, POL-14, POL-16, POL-19, POL-23, POL-25, POL-26, POL-32 (18 new
rows in the Amendments table, Summary and provenance lines updated). New parameter:
**`recovery_hold`** (POL-32, 24 h); there are now 51. No new policy entry.

Glossary: new terms *Account recovery* and *Capacity in force* (with *announced
capacity*); defined inside existing entries: *erasure request* and *documented erasure
request* (*Personal data*), *measured failing minute* (*Declared region disaster*);
amended: the *Time of day* convention, *Account administrator*, *Operator*, *Told*,
*Affected reservation*, *Available minute*, *Account slot*, *Declared region disaster*,
*Audit record*, *Record template*, *Usage exposure*, *Cancellation fee*, *Key spending*,
*Resume amount*.

## Decisions by issue

"Where" lists the register entry first, then needs (N), scenarios (S, new in bold) and
glossary (G).

| Issue | Decision applied | Trade-off | Where |
|---|---|---|---|
| RQ4-13 | P4-S111 says it as P4-S105 does: the Given states the ledger balance (−0.500000 USD, I2 unpaid, no other charges), and the remaining 0.500000 USD "raises its ledger balance to 0.500000 USD" | Wording only; a ledger can satisfy it | S: P4-S111 |
| B-RQ-10 (= Q-4) | POL-07's "had begun committing" is judged only by whether the confirming transaction sees the displacement record; the "(…, POL-26)" parenthesis is replaced by "(…, judged as below)". POL-26's sense governs only the commit fence, stated in POL-26. A partner route whose confirmation sees the record is decided against the reduced capacity; if it fails, its partner booking is cancelled at Share's cost (POL-28) | One exact test per question; a few partner bookings cancelled at Share's cost | POL-07, POL-26; N: P1-N1; S: P1-S63 (Given restated in POL-07 terms), P1-S78 (row cites POL-07); G *Affected reservation* |
| RQ6-4 | Only a measured failing minute (at least 12 probes from at least two locations, under 90% succeeding) is probe evidence; a minute lacking probes is not evidence | A probe-estate fault can never justify a declaration | POL-06; N: X2-N1; S: X2-S29 (Given restated), **X2-S32**; G *Declared region disaster* |
| RQ6-5 | A declared disaster counts from the earlier of the recorded loss and the start of an unbroken run of at least `disaster_probe_minutes` measured failing minutes leading up to it | The same failure counts the same whether a loss is recorded or not; more minutes against Share, never fewer | POL-06; N: X2-N1; S: **X2-S31**; G *Declared region disaster* |
| RQ-R6-1 | A minute of admission or the wallet is unavailable also when every probe of any one account slot failed in it | Spends 99.99% error budget on partial outages; treats every buyer alike | POL-06; N: X2-N1; S: X2-S27, **X2-S30**; G *Available minute*, *Account slot* |
| RQ-R6-1 refinement (RFC-000 rev 4.2, R24) | The per-slot rule counts only **measured failing slot-minutes**: a minute is unavailable for that reason only when one slot had at least 3 probes from at least 2 locations in it and all failed; slot-minutes with fewer probes are not evidence (same principle as RQ6-4) | Probe noise across ~16,384 slots does not become lost availability, while a dead slot is still caught | POL-06; N: X2-N1; S: **X2-S30** (rows: 3 of 3 failing → unavailable; 2 of 3 → available; only 2 probes, both failing → available); G *Available minute*, *Account slot* |
| RQ-R6-2 | One delivery may carry many notices; a notice carried in a delivery has its first delivery attempted when that delivery is first attempted | A mass event stays within its notice time without one call per notice | POL-04; N: P1-N8; G *Told* |
| RQ-17-1 | Every capacity change states a level. An outage records the capacity the link carries while it lasts; capacity in force at a minute = min(announced capacity, capacity of every outage open then); a permanent reduction removes reservations only to fit the announced capacity, never because of an outage; a permanent increase during an outage raises the announced capacity only; a reduction may be announced during an outage, judged against the announced capacity | Overlapping changes compose in any order without oversell or an unplanned permanent cut; an increase the link cannot yet carry is not sold | POL-07 (new *Capacity in force when changes overlap*); N: P1-N1, P1-N8; S: **P1-S79** (outage open at the notice's end removes nothing beyond the need), **P1-S80** (increase during an outage); G **Capacity in force**, *Affected reservation* |
| RQ-17-2 | A time stated to the second in a scenario is exact; "recorded at" is the record's commit timestamp | None; removes an ambiguity in P1-S76 | G *Time of day* convention |
| Q-1 | The lateness bound adds admission's 60 s recovery time: 430 s at the defaults (was 370 s) | About 7,500 micro-USD more exposure at P3-S37's figures; P4-S19 holds through an owner failover | POL-14; N: P3-N10; S: P3-S37, P4-S15, P4-S16; G *Usage exposure* |
| Q-2 | Key spending counts the charges and holds of the parts the key booked or added (a reservation it booked, an extension or increase it made); another principal's part never counts toward the key | Each key pays for what it chose; an administrator's increase never spends an agent's limit | POL-25; N: P2-N8; S: **P2-S117**; G *Key spending* |
| Q-3 | The resume amount is the least single top-up after which the account resumes, applied in POL-15's order, quoted itemised (written-off amount, each overdue invoice, headroom still needed) | One figure to pay, each part explained | POL-16; N: P4-N5; S: **P4-S114**; G *Resume amount* |
| RQ-19-1 | A shorten to a later end incurs a shown fee only if its new end falls inside a partner leg's minimum term; a plain cancellation fee only on a cancellation (a shorten to or before the next boundary is one) | Buyers (agents included) shortening are not surprised; the partner's commitment ends only on a cancellation | POL-08; N: P3-N12; S: P3-S63 (new row: plain fee, shorten to 10 days, no fee); G *Cancellation fee* |
| RQ-19-2 | The buyer pays the shown minimum-term fee when the window it booked ends inside a partner leg's minimum term; the offer shows the fee before booking. Overrides review 19 D-19-2's interim Share-borne line | The buyer who chose the window pays a cost it was shown; Share bears nothing it did not cause | POL-08; N: P3-N12; S: **P3-S74**; G *Cancellation fee* |
| RQ-19-3 | The dearer-path difference is against the buyer's charge for the minute as booked, before any correction of the buyer's price; such a correction amends only the buyer's charge | Suppliers are paid the path's value once | POL-23, POL-07 step 4; N: P4-N11; S: **P4-S115** |
| RQ-19-4 | A cost Share has paid a supplier is final, except that supplier's own reduction when its exporter erred | The party whose device erred bears it | POL-23; N: P4-N11; S: **P4-S116** |
| RQ-19-5 | The bound's price is the highest `usage_price` on any route in force over the bound's span: the window less the enforcement target before now, to the enforcement target after now | Exposure is never understated after a decrease; at most the past span at the old price, once per change | POL-14; N: P3-N10; G *Usage exposure* |
| RQ3-16, RQ-R5-1, RQ-R5-6 | A user asks erasure of its own data only (through an administrator or by its own documented request); an operator through workforce administration; a person who is not a Share user, or someone acting for it, by a documented erasure request naming the exporters and period, verified by compliance | Every data subject has a channel; nobody erases another's data by asking; compliance verifies what cannot authenticate | POL-19, POL-32 (compliance row, new *Workforce administration* principal row); N: X1-N7, X1-N11; S: **X1-S42**; G *Personal data*, *Operator* |
| RQ-R5-2 | Non-conforming payloads expire from every copy, backups and escrow included, by `dispute_window` + 7 days; an erasure request covering them applies earlier | No copy outlives the deadline | POL-19; N: P3-N7; S: P3-S71; G *Record template* |
| RQ-R5-3 | Compliance opens an erasure with no request only on a documented legal requirement, approved by a second compliance operator, recorded as a request with its legal reference; `erasure_max` runs from that record | A court order can be obeyed; no irreversible erasure on one person's judgment | POL-19, POL-32 (four eyes); N: X1-N7, X1-N11; S: **X1-S43**; G *Personal data*, *Operator* |
| RQ-R5-4 | Account recovery is an onboarding action: re-verification, then `recovery_hold` (24 h) in which an existing administrator's objection cancels it and the new administrator cannot remove users or rights | The usual takeover path is guarded; a day before full administration | POL-32 (new *Onboarding* principal row, *Account recovery* bullet, `recovery_hold`); N: X1-N9; S: **X1-S40**; G **Account recovery**, *Account administrator* |
| RQ-R5-5 | X1-N3's 60 s revocation bound covers every credential: agent keys, user sessions, supplier and exporter certificates and credentials | Every credential is bounded alike | N: X1-N3; S: **X1-S41**, Rule retitled |
| RQ-R5-7 | X1-S15: refused through the system; below it, with administrative or physical access, detected, recorded and accepted by no reader | States what can be guaranteed against physical access | N: X1-N8; S: X1-S15 (outline, retitled); G *Audit record* |

## Decisions taken by the amender

Points the binding decisions left open, decided for the best balance of buyers (agents
included), suppliers, Share's risk and operability:

1. **Each account slot is probed at least 3 times a minute, from at least two
   locations** (POL-06, X2-S27; was "at least one probe account each, every minute").
   Under the refined RQ-R6-1 a slot-minute is evidence only with at least 3 probes from
   two locations; with fewer, a dead slot would never be caught, which the coordinator's
   trade-off requires. Cost: about 3 probes a minute per slot, about 820 probes/s at
   16,384 slots, roughly 3% of the 25,000/s admission design throughput. (A first version
   of this record chose 2 probes per slot; superseded by the refinement.)
2. **A minute not probed as required is not available** (POL-06). RQ6-4 says such a
   minute is not evidence; the amender states explicitly that it still counts against
   Share (the RFC-006 reading), so a probe fault never improves the figure. It also
   breaks a run of evidence, and a minute unavailable only through RQ-R6-1's slot rule is
   not evidence either (the evidence rule is the 90% rule, as decided). A slot with fewer
   than 3 probes in a minute is not a probing shortfall of the capability: it makes the
   slot rule silent for that slot-minute, nothing more.
3. **"Leads up to" the loss** (RQ6-5): the run's last minute is the minute in which the
   loss was recorded or the one before it.
4. **Breach reporting under Q-1.** A record counted later than `attribution_lag_max` is
   still reported as a breach, even when the added recovery time covers it (POL-14), so
   every owner failover that delays counting stays visible.
5. **The RQ-19-5 span** is defined from the bound's own terms: the window less the
   enforcement target looks back (370 s at the new defaults; it was 310 s under RFC-003's
   D-19-6 before Q-1), the enforcement target looks ahead (60 s).
6. **Which erasure covers a payload** (RQ-R5-2): a request naming its exporter and a
   period including its receipt, or the request of any user of the exporter's supplier or
   of the account its traffic is attributed to (RFC-005's D-4). A payload cannot be
   matched to a person, so every request that could concern it erases it; the loss is
   dispute evidence in a case that is the supplier's misconfiguration.
7. **Non-user requests** (RQ3-16): written, naming the person, the exporters and the
   period, with evidence of identity or authority; one compliance operator verifies and
   executes; an unverifiable request is refused, recorded and its sender told; the
   `erasure_max` clock starts when the request is recorded, so verification time counts.
   "Someone acting for that person" includes a buyer's or supplier's administrator.
8. **Account recovery** (RQ-R5-4): onboarding is named as a non-operator principal
   (Share's KYB process), keeping POL-32's one-role-per-operator-action rule intact. It
   applies to supplier accounts too. Only an administrator who held the right before the
   recovery may object, as decided (not every user). During the hold the new
   administrator also cannot issue agent keys, register or change webhook endpoints, or
   give consent, matching RFC-005 §3.8: a takeover must not be able to spend or redirect
   outcomes before the real owner can object. Its other administrator actions are allowed.
9. **Credentials under RQ-R5-5**: a session is revoked when its user is removed, loses a
   right the session relied on, or ends it; the bound is a need (X1-N3), with no new
   policy entry.
10. **RQ-19-2 timing**: the fee is incurred when the reservation ends at its window's end
    as last changed, so an extension past the term avoids it and a shorten into the term
    is charged under RQ-19-1 instead (never twice).
11. **RQ-19-4 scope**: "a cost Share has paid" covers carried excess, an equivalent-path
    difference and fees Share bears; when the supplier's exporter erred, that supplier
    owes only its own share of the reduction and the others keep theirs (POL-23's
    existing correction rule).
12. **"Added" under Q-2** means an extension or increase made by the key to any
    reservation of the account.
13. **Q-3 headroom remainder** is computed after the written-off repayment and invoice
    payments, which (for invoices) raise the ledger balance.
14. **RQ-R6-2** needs no new scenario: P1-S75 already tests "told"; the rule is stated in
    POL-04, P1-N8 and the glossary.
15. **X1-S15** became a Scenario Outline (two rows) rather than gaining a second scenario,
    since both rows answer the same attempt.

## Arithmetic recomputed (old → new)

| Where | Arithmetic |
|---|---|
| POL-14 bound | 180 + 60 + 60 + 10 + 60 + 60 = **430 s** (was 370 s); 100 Mbps × 430 s = 43,000 Mb = **5.375 GB** (was 4.625 GB) |
| Q-1 trade-off | 60 s × 100 Mbps = 0.75 GB × 10,000 micro-USD/GB = 7,500 micro-USD |
| RQ-19-5 span | Look-back 430 − 60 = **370 s** (D-19-6: 310 s at the old bound); look-ahead 60 s |
| P3-S37 | Lateness bound 5.375 × 10,000 = **53,750** micro-USD (was 46,250); usage exposure 2,000 + 53,750 = **55,750** (was 48,250) |
| P4-S15, P4-S16 | Lateness bound **0.053750** USD (was 0.046250); exposure 0.002000 + 0.053750 = **0.055750** (was 0.048250); headroom 1.000000 − 0.288000 − 0.055750 = **0.656250** USD (was 0.663750) |
| P4-S111 | Balance −0.500000 + 0.500000 (I2 paid) + 0.500000 = **+0.500000** USD; 2.000000 − 1.000000 − 0.500000 = 0.500000 (wording only, no figure changed) |
| P4-S114 row 1 | Invoice 1.000000; after it, headroom 0.000000 + 5.000000 − 0.288000 = 4.712000 ≥ 1.000000, so **1.000000** USD |
| P4-S114 row 2 | 1.000000 (written off) + 0.500000 (I2) + 1.000000 (headroom 0 → `low_balance_warning` 1 USD, no reservations) = **2.500000** USD; so P4-S111's 2.000000 leaves it suspended (headroom 0.500000) |
| P4-S115 | Corrected buyer charge 3 × 1.0 = 3.0 → **3** micro-USD; difference stays 8 − 4 = **4** (the old literal reading gave 8 − 3 = 5) |
| P4-S116 | 0.5 GB × 10,000 = 5,000 micro-USD; A's Webster share at weight 3000 of 10,000 = 1,500; A owes 3,000 − 1,500 = **1,500** |
| P1-S79 | Committed 4 + 4 = 8; reduction to 6 removes 2 of B; during the outage 6 > 5 (affected); after restoration 6 ≤ 6 (not affected) |
| P1-S80 | In force min(15, 6) = 6; 6 + 1 > 6 (rejected); after restoration 15 − 6 = 9 free |
| P2-S117 | K: 0.288000 (not 0.432000); administrator's reservation increased by K: 0.144000 |
| X2-S30 | 99% ≥ 90% in every row; slot 17: 3 of 3 failed from two locations → unavailable; 2 of 3 → available; 2 probes only → not measured → available; 11 probes from one location → short of 12 and two locations → unavailable |
| Probe cost (amender 1) | 16,384 slots × 3 probes/min = 49,152/min ≈ 819/s ≈ 3.3% of 25,000/s |
| X2-S31 | 10:00–10:05 = 6 minutes ≥ 5 → from 10:00; 10:03–10:05 = 3 < 5 → from 10:06 |
| X2-S32 | 3 / 12 = 25% < 90% (evidence); 8 probes, or one location, breaks the 5-minute run → refused |

No other scenario carries a figure that depends on a changed value: P4-S19 states no
amount, and P2-S42 and P4-S22 already itemise their resume amounts as Q-3 requires.

## Check outputs

`python3 tools/check_specs.py` before:

```
{'scenarios': 448, 'per': {'P1': 78, 'P2': 116, 'P3': 73, 'P4': 113, 'X1': 39, 'X2': 29}, 'needs': 67, 'pols': 33, 'params': 50}
NO PROBLEMS
```

`python3 tools/check_specs.py --regen`:

```
regen: added ['P1-S79', 'P1-S80', 'P2-S117', 'P3-S74', 'P4-S115', 'P4-S116', 'P4-S114', 'X1-S41', 'X1-S40', 'X1-S42', 'X1-S43', 'X2-S30', 'X2-S31', 'X2-S32'] retitled ['P3-S63', 'X1-S15'] removed []
```

After:

```
{'scenarios': 462, 'per': {'P1': 80, 'P2': 117, 'P3': 74, 'P4': 116, 'X1': 43, 'X2': 32}, 'needs': 67, 'pols': 33, 'params': 51}
NO PROBLEMS
```

No line was added to `tools/check_specs.allow`. Every existing Design, Tests and Status
cell in `conformance.md` was kept.

`python3 tools/impact.py diff HEAD WORKTREE` (summary):

```
scenarios: +14 ~11 -0; policies changed: 11; needs changed: 14
  added: P1-S79 P1-S80 P2-S117 P3-S74 P4-S114 P4-S115 P4-S116 X1-S40 X1-S41 X1-S42 X1-S43 X2-S30 X2-S31 X2-S32
  changed: P1-S63 P1-S78 P3-S37 P3-S63 P3-S71 P4-S111 P4-S15 P4-S16 X1-S15 X2-S27 X2-S29
  policies: POL-04 POL-06 POL-07 POL-08 POL-14 POL-16 POL-19 POL-23 POL-25 POL-26 POL-32
  needs: P1-N01 P1-N08 P2-N08 P3-N07 P3-N10 P3-N12 P4-N05 P4-N11 X1-N03 X1-N07 X1-N08 X1-N09 X1-N11 X2-N01
impacted slices: S-LINK (RFC-001), S-ACCT (RFC-002), S-RATE (RFC-003), S-MONEY (RFC-004),
  S-SEC (RFC-005), S-PLAT (RFC-006), ARCHITECTURE (RFC-000)
```
