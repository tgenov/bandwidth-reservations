# 28. Requirements amendments from C3 round 2 (requirements v1.8 → v1.9)

Sources: [review 26](26-rfc-001-review.md) (RQ-26-1, RQ-26-2, decisions D1, D2),
[review 27](27-rfc-006-review.md) (RQ-R6-3),
[RFC-005](../03-rfcs/RFC-005-security-and-tenancy.md) revision 4 (RQ-R5-8, decision D-10,
with the W-1 erasure pass-on addition), [RFC-003](../03-rfcs/RFC-003-rating-and-metering.md)
revision 4 (RQ3-17). Coordinator decisions are binding; points they left open are listed
under "Decisions taken by the amender".

## Issues, changes and trade-offs

| Issue | Decision | Change | Trade-off | Files / IDs |
|---|---|---|---|---|
| RQ-26-1 | Maintenance never makes a reservation affected and is never a reason to reduce or revoke one; at a permanent reduction's effect, maintenance that no longer fits beside the reservations within the announced capacity is cut to fit, its supplier told | POL-07 *Planned maintenance*: two new bullets (outside the committed rate; cut to fit at a reduction's effect); *Why* and *Rejected* extended; Summary line. Glossary *Committed rate* (maintenance never in it, kept as excluded), *Affected reservation*, *Planned maintenance booking*. P1-N8 need and measure. New P1-S81 (reduction to 9 / to 8 with 2 Mbps maintenance after the notice: no reservation cut, maintenance cut to 1 Mbps / cancelled) and P1-S83 (maintenance in an outage flags nothing) | The supplier bears its own works; a buyer's guarantee never shrinks for a temporary booking; a reduction to zero can finish. The supplier rebooks what it still needs | policy-register.md POL-07; glossary.md; 01-discovery/P1-link-admission.md P1-N8; P1-S81, P1-S83 |
| RQ-26-2 | From the end of a permanent reduction's notice, the committed rate counts each reservation at the rate the reduction leaves it | POL-07 *Capacity in force*: new bullet; *Why*, *Rejected*, Summary. Glossary *Committed rate*, *Affected reservation*. P1-N8 need. New P1-S82 (reduction to 6, outage to 9 open across the notice's end, nothing affected) | No false outage notices or credits for a cut that was already due | policy-register.md POL-07; glossary.md; P1-N8; P1-S82 |
| RQ-R6-3 | For the slot rule only, a probe fails if it got no correct answer within 1 s; 200 ms stays for the 90% rule and the latency targets | POL-06 *An available minute*: slot-rule probe limit; new parameter `slot_probe_limit` = 1 s; *Why* (figures below); new *Rejected*; Summary. Glossary *Available minute*. X2-N1. X2-S30: first row reworded to the new limit, new row (3 probes answered in 400 ms → available) | A stuck slot is still caught in its first minute; tail latency stays governed by the p99 targets instead of consuming the availability budget | policy-register.md POL-06; glossary.md; 01-discovery/X2-non-functional-targets.md X2-N1; X2-S30 |
| RQ-R5-8 | Adopt RFC-005 D-10 into POL-32's recovery hold | POL-32 *Account recovery*: the new administrator is *held*; no supplier credentials (exporters' included) in the hold; a right it grants is held likewise and removed on cancellation; users added in the hold remain, listed in the cancellation notice; an erasure request it passes on is held, opened when the recovery is final, refused (subject told) on cancellation, its request time unchanged; *Why*, new *Rejected*, Summary. POL-19 *Who asks*: cross-reference. Glossary *Account recovery*. X1-N9 need and measure. New X1-S44 (outline: held grant, cancellation removes it, added user remains, held erasure opened / refused) and X1-S45 (held supplier administrator cannot issue an exporter credential) | The hold cannot be escaped through a second user or used to silence the owner by erasure or to create billable traffic; cost: an erasure passed on in the hold waits up to a day of its `erasure_max` | policy-register.md POL-32, POL-19; glossary.md; 01-discovery/X1-security-and-tenancy.md X1-N9; X1-S44, X1-S45 |
| RQ3-17 | P3-S71 restricts where a non-conforming payload may be kept; it does not require keeping every one; caps and the store timeout may drop one; identity, keyed digest and reason always kept | POL-19 *A record payload that does not conform*: "always hold its identity, its keyed digest and the reason, and nothing more"; payload "if kept" only in the erasable store; dropped beyond the design's caps or when the store does not take it in time, each drop counted and reported; *Why*, *Rejected*, Summary. Glossary *Record template*. P3-N7. P3-S71 steps reworded (title unchanged). New P3-S75 (outline: over the cap / store not in time → not kept, identity, keyed digest, reason kept, counted) | A misconfigured exporter cannot flood the erasable store or stall ingestion; a dispute about a dropped payload rests on its digest alone | policy-register.md POL-19; glossary.md; 01-discovery/P3-rating-and-metering.md P3-N7; P3-S71, P3-S75 |

Register: Amendments table has five new rows (2026-10-12, "C3 round 2: …"); the
provenance lines of POL-06, POL-07, POL-19 and POL-32 and the register's introduction cite
this round.

## Decisions taken by the amender

1. **Order and size of a maintenance cut (RQ-26-1).** Newest maintenance booking first;
   each reduced in rate by the largest excess it meets at any minute of its window from the
   notice's end (its rate stays uniform, as a reservation part's does), cancelled if that is
   its whole rate. Mirrors the reservation rule, so one algorithm serves both.
2. **When the supplier is told of a maintenance cut.** Within `affected_notice_time` of the
   cut (at the notice's end). The supplier announced the reduction itself and knows its own
   bookings; no separate projection notice during the notice.
3. **`slot_probe_limit` is a named POL-06 parameter** (default 1 s) rather than a bare
   figure, so it can be tuned without a mechanism change; it applies to every capability
   under the slot rule (admission and the wallet).
4. **`erasure_max` for a held erasure pass-on runs from the moment it was passed on**
   (RFC-005's `requested_at` unchanged); the hold consumes at most 24 h of the 30 days.
5. **Rights granted in the hold become ordinary rights when the recovery is final**; a held
   administrator cannot remove the rights it granted (it cannot remove rights at all in the
   hold).
6. **Payload caps stay design parameters** ("the caps the design states", RFC-005 RD-1:
   10/s per exporter, 1,000/s overall), not POL parameters; the policy fixes only that
   drops happen beyond them, are never kept elsewhere, and are counted and reported to
   network operations.
7. **Extra scenarios beyond those proposed:** P1-S83 (maintenance in an outage, the outage
   half of RQ-26-1), X1-S45 (the exporter-credential half of RQ-R5-8), P3-S75 (the drop
   half of RQ3-17), and a new X2-S30 row (the looser slot limit).

## Arithmetic recomputed

- RQ-R6-3 (POL-06 *Why*): slot-minute failure probability with ≥ 3 probes all slow is
  p³; per month 16,384 slots × 43,200 min × p³. p = 0.001 → 1.6384 × 10⁻⁵ × 43,200 ≈
  0.71 min; p = 0.002 → 8 × 10⁻⁹ × 16,384 × 43,200 ≈ 5.66 min, above the 4.32 min budget
  (0.01% of 43,200). Stated as "about 0.7 of the 4.32 minutes" and "0.2% the whole budget".
- P1-S81: capacity 10, A 4 + B 4 = 8 committed, maintenance 2 (booked when 8 + 2 ≤ 10).
  Reduction to 9: room 9 − 8 = 1 → maintenance cut 2 → 1 Mbps; to 8: room 0 → cancelled.
  No reservation cut (8 ≤ 9, 8 ≤ 8). Maintenance on D + 31, after the notice ends
  (D + 30 09:00).
- P1-S82: before the notice's end, in force min(10, 9) = 9 ≥ 8 committed; after it, B cut
  4 → 2 (excess 8 − 6), committed 6, in force min(6, 9) = 6 ≥ 6. Nothing affected.
- P1-S83: committed 8 (maintenance 2 excluded) ≤ 9 in force. Not affected.
- X2-S30 new row: 400 ms > 200 ms per-probe limit, < 1 s `slot_probe_limit` → not a failing
  slot-minute; 99% ≥ 90% → available.
- No money figure changed.

## New scenario IDs

P1-S81, P1-S82 (Rule "A permanent reduction …"), P1-S83 (Rule "Planned maintenance …"),
P3-S75 (after P3-S71), X1-S44, X1-S45 (after X1-S40). Changed: P3-S71 (steps), X2-S30
(Examples). None renumbered or removed.

## Checks

`python3 tools/check_specs.py` before:

```
{'scenarios': 462, 'per': {'P1': 80, 'P2': 117, 'P3': 74, 'P4': 116, 'X1': 43, 'X2': 32}, 'needs': 67, 'pols': 33, 'params': 51}
NO PROBLEMS
```

`--regen`: added P1-S83, P1-S81, P1-S82, P3-S75, X1-S44, X1-S45; retitled none; removed none.

After:

```
{'scenarios': 468, 'per': {'P1': 83, 'P2': 117, 'P3': 75, 'P4': 116, 'X1': 45, 'X2': 32}, 'needs': 67, 'pols': 33, 'params': 52}
NO PROBLEMS
```

No line added to `tools/check_specs.allow`.

`python3 tools/impact.py diff HEAD WORKTREE`:

```
scenarios: +6 ~2 -0; policies changed: 4; needs changed: 4
  added: P1-S81 P1-S82 P1-S83 P3-S75 X1-S44 X1-S45
  changed: P3-S71 X2-S30
  policies: POL-06 POL-07 POL-19 POL-32
  needs: P1-N08 P3-N07 X1-N09 X2-N01
impacted slices:
  S-LINK (RFC-001-link-admission.md): ids P1-N08 P1-S81 P1-S82 P1-S83; policies POL-06 POL-07 POL-19 POL-32
  S-ACCT (RFC-002-booking-coordination.md): ids P1-N08; policies POL-06 POL-07 POL-32
  S-RATE (RFC-003-rating-and-metering.md): ids P3-N07 P3-S71 P3-S75 X2-N01; policies POL-06 POL-07 POL-19 POL-32
  S-MONEY (RFC-004-wallet-and-settlement.md): ids -; policies POL-06 POL-07 POL-19 POL-32
  S-SEC (RFC-005-security-and-tenancy.md): ids P3-S71 X1-N09 X1-S44 X1-S45 X2-N01; policies POL-06 POL-07 POL-19 POL-32
  S-PLAT (RFC-006-availability-and-operations.md): ids P1-N08 P3-N07 P3-S71 X2-N01 X2-S30; policies POL-06 POL-07 POL-19 POL-32
  ARCHITECTURE (RFC-000): cites P1-N08 P3-N07 POL-06 POL-07 POL-19 POL-32 X1-N09 X2-N01
```

Not committed or tagged.
