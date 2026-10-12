# 35. Requirements amendments before C4 (requirements v1.9 → v1.10)

Date: 2026-10-12. Baseline: `requirements-v1.9` ([review 28](28-requirements-amendments-from-c3-round-2.md)).
Result: `requirements-v1.10` (not tagged or committed by the amender).

Sources:
- [RFC-004](../03-rfcs/RFC-004-wallet-and-settlement.md) RQ4-14 (payout destination during
  an account recovery) and erratum 5.1 (settlement accepts a downward "late POL-07 cut"
  amendment), giving RQ4-15.
- [RFC-005](../03-rfcs/RFC-005-security-and-tenancy.md) RQ4-14 binding interim reading, C16.
- [RFC-002](../03-rfcs/RFC-002-booking-coordination.md) B-RQ-11 (a move that becomes final
  after the reduction's cut), §9.6.
- [RFC-003](../03-rfcs/RFC-003-rating-and-metering.md) erratum 5.1, §5.6–5.7 (late extension
  minutes already rated at the uncut rate are amended down, reason "late POL-07 cut").
- [X2-S30](../02-specs/X2-non-functional.feature) and POL-06's slot rule.

All four decisions were given by the coordinator and are binding.

## Decisions applied

### RQ4-14: payout destination during an account recovery

| | |
|---|---|
| Decision | Changing a supplier's payout destination is a supplier administrator action, held during POL-32's `recovery_hold` (refused to a held administrator, like an exporter credential). In POL-22, a change applies from the next payout run, and every supplier administrator is told of each change. |
| Change | POL-32: payout destination added to the Supplier administrator principal's actions and to what a held administrator cannot do; Why and Rejected extended; Summary line. POL-22: new "Payout destination" bullet (one destination per supplier; a change applies from the next run, a run already started paying every one of its payouts to the destination it started with; every supplier administrator told, with when and from which run); Why extended; new Rejected section. |
| Trade-off | A takeover through recovery cannot redirect a payout POL-22 makes final on confirmation; a legitimate change waits up to a day (hold) plus up to a week (next run). |
| Files / IDs | `policy-register.md` (POL-22, POL-32, Summary, Amendments); `X1-security-and-tenancy.md` X1-N9 (need and measure); `P4-wallet-and-settlement.md` P4-N12 (need and measure); `glossary.md` (Payout: **payout destination**); `X1-security-and-tenancy.feature` new **X1-S46**; `P4-wallet-and-settlement.feature` new **P4-S118**. |

### RQ4-15: a late POL-07 cut is a named exception to final earnings

| | |
|---|---|
| Decision | P4-N11 gains a named exception: a downward reservation-line amendment for minutes a permanent reduction cut after they were rated ("late POL-07 cut") lowers every party to its split of the corrected total, recovering from later payouts if already paid. |
| Change | POL-23: first bullet names the exception; new "A late POL-07 cut" bullet (lines amended to the cut rate, buyer credited, every party incl. Share's commission lowered to the split of the new total less shares posted (POL-12), no party's share rises; not a correction; made however late; a paid supplier owes the difference, netted, POL-22); Why extended; new Rejected section. POL-22: supplier debt also arises from earnings a late POL-07 cut took back after payout, shown as an earnings reduction with reason "late POL-07 cut". POL-07: new "Charged at the cut rate" paragraph pointing to POL-23. Summary lines of POL-07, POL-22, POL-23. |
| Trade-off | The buyer is never charged for capacity not delivered; suppliers give back only rate they did not supply (the cut applies to the whole route), possibly after payout. |
| Files / IDs | `policy-register.md` (POL-07, POL-22, POL-23); `P4-wallet-and-settlement.md` P4-N11 (need and measure); `glossary.md` (Amendment, Supplier debt); `P4-wallet-and-settlement.feature` Rule renamed "Supplier earnings are final, except for the supplier's own errors and a late POL-07 cut", new **P4-S117**. |

### B-RQ-11: a move final after the cut keeps the cut

| | |
|---|---|
| Decision | POL-07 step 6: a move to an equivalent path that becomes final after a reduction's cut carries the reservation at its cut rate (the move never restores Mbps the cut removed). |
| Change | POL-07 step 6: new "A move final after the cut" paragraph (the holder told at acceptance, may book an increase on the new path as a new admission, POL-08; Share-leg capacity held beyond the cut rate released at the move; a move final by the notice's end moves at the full rate); Why, Rejected, Summary. |
| Trade-off | No re-admission of the cut Mbps half-way through a move (which could fail); the holder loses nothing it still had and may buy the Mbps back. |
| Files / IDs | `policy-register.md` (POL-07); `P1-link-admission.md` P1-N8; `glossary.md` (Equivalent path); `P1-link-admission.feature` new **P1-S84** (Rule "A permanent reduction keeps the capacity …"). |

### X2-S30 / POL-06 slot rule

| | |
|---|---|
| Decision | A slot-minute with at least one probe, every one of which got no correct answer within `slot_probe_limit`, makes the minute unavailable even with fewer than 3 probes; a slot with no probe in a minute is a probing fault, alerted, and does not by itself make the minute unavailable (the capability rule, at least 12 probes from at least two locations, still applies). |
| Change | POL-06: "measured failing slot-minute" replaced by **failing slot-minute** (at least one probe, all failed, however few); new **probing fault** (slot probed short, alerted to network operations, not by itself unavailability); disaster-evidence bullet follows the rename; Why rewritten for the new trade-off; two Rejected alternatives added; Summary line. |
| Trade-off | A stuck slot cannot hide behind a short probe count, while random probe loss across ~16,384 slots does not consume the availability budget. |
| Files / IDs | `policy-register.md` (POL-06); `X2-non-functional-targets.md` X2-N1 (measure); `glossary.md` (Available minute, Account slot); `X2-non-functional.feature` X2-S30 retitled, Given reworded ("is to be probed"), row "only 2 probes, both failing" now **unavailable**, new zero-probe row (**available**); new **X2-S33** (probing fault alerted). |

## Decisions taken by the amender

1. **Probing fault covers any short slot, not only zero probes** (POL-06). A slot with 1–2
   probes, or probed from one location, is also a probing fault, alerted to network
   operations; it is unavailable only if every probe it got failed. Network operations is
   the alert's recipient (it owns probing and disaster evidence). Balance: one rule for a
   short slot; Share's operability gains an alert for a degrading probe estate.
2. **When a payout run "starts"** (POL-22): a change applies to runs that start after it;
   a run already started pays every one of its payouts to the destination it started with;
   an amount re-paid after a final failure goes, in a later run, to that run's
   destination (P4-S118 row 3). Matches RFC-004/RFC-005's "run's cut timestamp" reading.
3. **What administrators are told** (POL-22): each change, with when it was made and the
   run it applies from, to every supplier administrator of the supplier (including the one
   who made it).
4. **Late POL-07 cut has no time bound and is shown as an earnings reduction** (POL-23,
   POL-22): it is made however late the cut is found (the buyer must never pay for
   undelivered capacity); a supplier already paid owes the difference as a supplier debt,
   netted and invoiced after 90 days like any other, shown with reason "late POL-07 cut"
   (unlike a duplicate payout, it is an earnings reduction and counts in the deviation
   report as any split amendment does). No party bears another's reduction (it is not a
   correction).
5. **Move final after the cut** (POL-07): Share-leg capacity held for the offer beyond the
   cut rate is released at the move; the moved reservation is priced as any move (lower
   of original and path price) at its cut rate.
6. **RQ4-14 scenarios split by owner**: the held refusal is X1-S46 (security), the
   next-run and notice rule P4-S118 (payouts).

## Arithmetic recomputed

- **P4-S117** (new; weights A 3000, B 3333, C 2167, Share 1500, as P4-S56): 100 Mbps ×
  15 micro-USD = 1,500 micro-USD; Webster split 450 / 500 (499.95) / 325 (325.05) / 225 =
  1,500. Cut to 60 Mbps: 900 micro-USD; split 270 / 300 (299.97) / 195 (195.03) / 135 =
  900. Buyer credited 1,500 − 900 = 600; parties −180 / −200 / −130 / −90, sum −600. A's
  180 netted after its 450 was paid out.
- **P4-S118** (new): 120.000000 USD owed → 120.00 USD payout (POL-22 defaults, as P4-S43).
- **P1-S84** (new; Background A 4, B 4 on 10 Mbps): reduction to 6 Mbps affects 2 Mbps of
  B; notice ends D + 30 (`revocation_notice` 30 days); offer made D + 27, open to D + 34
  (`offer_window` 7 days); acceptance D + 29 → full 4 Mbps; D + 32 → 2 Mbps, 2 Mbps of
  the held 4 released.
- **X2-S30**: row "only 2 probes, both failing": available → unavailable. New row (no
  probe in slot 17): available. Other rows unchanged (99% overall ≥ 90%; 11 probes from
  one location still unavailable by the capability rule).
- POL-06 Why: probe load unchanged (3 probes/slot/min × 16,384 slots ≈ 820/s).

## New scenario IDs

P1-S84, P4-S117, P4-S118, X1-S46, X2-S33. Changed: X2-S30. None renumbered or reused.

## Checks

`python3 tools/check_specs.py` before:

```
{'scenarios': 468, 'per': {'P1': 83, 'P2': 117, 'P3': 75, 'P4': 116, 'X1': 45, 'X2': 32}, 'needs': 67, 'pols': 33, 'params': 52}
NO PROBLEMS
```

`python3 tools/check_specs.py --regen`:
`regen: added ['P1-S84', 'P4-S117', 'P4-S118', 'X1-S46', 'X2-S33'] retitled ['X2-S30'] removed []`

`python3 tools/check_specs.py` after:

```
{'scenarios': 473, 'per': {'P1': 84, 'P2': 117, 'P3': 75, 'P4': 118, 'X1': 46, 'X2': 33}, 'needs': 67, 'pols': 33, 'params': 52}
NO PROBLEMS
```

No line added to `tools/check_specs.allow`.

`python3 tools/impact.py diff HEAD WORKTREE`:

```
scenarios: +5 ~1 -0; policies changed: 5; needs changed: 5
  added: P1-S84 P4-S117 P4-S118 X1-S46 X2-S33
  changed: X2-S30
  policies: POL-06 POL-07 POL-22 POL-23 POL-32
  needs: P1-N08 P4-N11 P4-N12 X1-N09 X2-N01
impacted slices:
  S-LINK (RFC-001-link-admission.md): ids P1-N08 P1-S84; policies POL-06 POL-07 POL-32
  S-ACCT (RFC-002-booking-coordination.md): ids P1-N08; policies POL-06 POL-07 POL-23 POL-32
  S-RATE (RFC-003-rating-and-metering.md): ids X2-N01; policies POL-06 POL-07 POL-22 POL-23 POL-32
  S-MONEY (RFC-004-wallet-and-settlement.md): ids P4-N11 P4-N12 P4-S117 P4-S118; policies POL-06 POL-07 POL-22 POL-23 POL-32
  S-SEC (RFC-005-security-and-tenancy.md): ids X1-N09 X1-S46 X2-N01; policies POL-06 POL-07 POL-22 POL-23 POL-32
  S-PLAT (RFC-006-availability-and-operations.md): ids P1-N08 X2-N01 X2-S30 X2-S33; policies POL-06 POL-07 POL-32
  ARCHITECTURE (RFC-000): cites P1-N08 P4-N11 P4-N12 POL-06 POL-07 POL-22 POL-23 POL-32 X1-N09 X2-N01
```

Note: the worktree also shows an uncommitted change to `docs/03-rfcs/RFC-000-architecture.md`
that the amender did not make (outside this record's scope).
