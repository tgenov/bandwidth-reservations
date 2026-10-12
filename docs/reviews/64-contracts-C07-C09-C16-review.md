# 64. Joint contract review: payout-destination query (C16) in C07 v1 and C09 v1

| | |
|---|---|
| Mode | Contract, joint |
| Scope | The payout-destination query (RFC-000 §8 "Payout destination", RFC-005 C16) only, as the two frozen contracts state it |
| Under review | [C07 receivables-and-payouts v1](../04-delivery/contracts/C07-receivables-and-payouts.md), operation 5, its tests P6, P7, K5, its "Settled" S2, S3, S4, F6, its errata owed. [C09 personal-data-store v1](../04-delivery/contracts/C09-personal-data-store.md): `put` and `get` of `payout_destination_details`, restore step 7, timeouts, test 26, open issues (R36-31) |
| Authority | `requirements-v1.10` (P4-N12, P4-S118, X1-N9, X1-S46, POL-22, POL-32); RFC-000 rev. 4.4 §8 payout-destination and personal-data-store rows, errata C4-5, C4-6; RFC-004 rev. 5 §B7, §B12 C16 row; RFC-005 rev. 5 C16 |
| Tools | `tools/impact.py coverage`: S-MONEY uncited P4-S117, P4-S118; S-SEC uncited X1-S46 |
| Errata form | Each erratum is one line, for a v1.1 clarification. No erratum changes a wire type |

## Verdict

**CONSISTENT WITH ERRATA.**

The two contracts agree on the main points:

- Both contracts use the same item. C07 keys the details by (`destination_ref`, version).
  C09 keys them by subject = supplier, item = `"<destination_ref>/<version>"`.
  `PayoutDestinationVersion` carries `supplier`, so identity can make the C09 key.
- Both contracts say that identity reads the details with `get`, purpose
  `payout_destination`, for the request only. Payouts never calls the store.
- C07 resolves the version from identity's version history ("greatest `c ≤ at`"), not by
  `AS OF SYSTEM TIME`. C09 does not disagree.
- `temporarily_unavailable` from the store makes the run wait for that supplier, in
  both contracts.
- The recovery hold: C07 refuses the change. This agrees with `requirements-v1.10`
  X1-S46 and POL-32. C09 is silent.
- The next-run rule: C07 says that a change at `c` applies to runs with `T_w ≥ c`. This
  agrees with P4-S118 rows 1 to 3 and with POL-22.

But one path that C09 promises is not in C07. When the store answers `not_found` for the
version in force at the cut (an item lost in a restore), C09 says "C16 answers not found,
RFC-004 escalates to finance". C07 defines `version_gone` only "on a resend". The
`PayoutDestinationAt` form has no rule for this case (R64-01). Also, no contract says how
identity mints a new destination version. A natural implementation can block every later
change of the destination after one crash (R64-02). Both are Major. Apply the errata
before code. No finding is a Blocker. All other findings are Minor.

R36-31 is now closed:

- (a) X1-S46 "refused": C07 S2 settles it, and it agrees with the requirements. The
  RFC-000 erratum is owed and listed in C07.
- (b) P4-S118 row 3 against RFC-004 §B7.1 "a re-instruction reuses": C07 F6 settles it,
  and the RFC-004 §B7.1 erratum is owed and listed.

C09's "Open issues" paragraph must record this closure (R64-09).

## Findings

| ID | Severity | Location | Finding | Proposed change |
|---|---|---|---|---|
| R64-01 | Major | C07 op 5 "Payouts' use" table and test P6; C09 `get` "Payout destination", restore step 7, test 26 | **The store's `not_found` on the at-cut form has no defined answer.** Example: a store restore loses item `ref/v2`. Identity's history still says that v2 is in force at `T_w`. `PayoutDestinationAt` then has three possible answers, and C07 does not select one. `version_gone`: C07 defines the payouts action only "on a resend". `no_destination`: payouts carries the amount forward and escalates only after 4 runs. This contradicts C09 ("RFC-004 escalates to finance"), and it tells the administrators "no destination", which is false. `UNAVAILABLE`: the run waits for ever. No new version can make v2 readable, because a re-entered version has `c > T_w`. C09 test 26 says only "not found", with no reason. | Use `NOT_FOUND{version_gone}` on both forms. On the at-cut form, payouts creates no lot. The amount carries forward. Payouts escalates to finance at once. Identity tells every supplier administrator to enter the destination again. This is an ordinary change, and it applies from the next run with `T_w ≥ c` (D-64-1). Errata E1, E2, E3 |
| R64-02 | Major | C07 op 5 (version is a `string`; C16 command outside the contract); C09 "Write-once kinds", "Order of commit and put" | **Version minting can block destination changes.** The C16 command puts the details first, at item `ref/version`, and then commits the version. For mutable kinds, C09's version is identity's log sequence. That number exists only at commit, so it cannot exist before the put. The contracts do not say how identity mints the version for a destination. Suppose identity uses "current version + 1". Command A puts `ref/3` and then stops before its commit. Command B (another idempotency key, other details) mints `ref/3` again and gets `refused(item_exists)`. Every later command does the same. The supplier cannot change its destination, and the only result is an alert. Two concurrent commands also collide. | Identity mints the version so that it is unique to the command. For example, derive it from (supplier, command idempotency key). Identity never reuses a version after a put whose commit failed. The commit timestamp `c` orders the versions, not the version string (D-64-2). Errata E4, E5 |
| R64-03 | Minor | C07 op 5 "Version in force at `at`" and its precondition; C09 silent | **The history read must be serializable and fresh at `at`.** "Log and projection" lets identity answer from a projection that is late, or from a read whose timestamp is below `at`. This is possible when identity's gateway clock is behind the cut by up to `max_offset`, or when the cut and identity's database are not the same cluster. Then a version with `c ≤ at` can commit after the answer. The run pays K1, but the notice to the administrators said "applies from this run" (P4-S118 row 1). A call days later answers v2, which breaks "same request, same answer". | Identity answers from the history rows that the change's own transaction wrote. It reads in a transaction whose read timestamp is above `at`, and it waits until that is true. Erratum E6 |
| R64-04 | Minor | C07 S4 and "Timeouts" (op 5 per-call deadline 2 s); C09 "Timeouts" (`get` for C16: "No deadline") | The words disagree. C07 sets a 2 s per-call deadline that payouts retries. C09 says "no deadline". The intended meaning is no overall deadline for the run, but a reader can apply it to each call. | Errata E7 (C09) and E8 (C07) |
| R64-05 | Minor | C07 op 5 errors; C09 `get` refusals | **C07 does not map C09's refusals.** `refused(read_limit)` (identity 5,000/s, shared with logins and administrator commands) can occur during the weekly run burst, and C07 has no answer for it. `refused(purpose_not_allowed \| kind_not_for_purpose)` is a defect, and C07 has no answer for it either. | `read_limit` → `UNAVAILABLE` (the run waits and retries with backoff). Any other refusal → `INTERNAL`, alerted, and the run waits for that supplier. Erratum E9 |
| R64-06 | Minor | C07 op 5 "Delivery and idempotency" ("until a store item is erased after its retention"); C09 (no retention delete for write-once items) | **C07 states a retention erasure that C09 does not provide.** C09 has `erase` only for an erasure request with a compliance envelope. It has `expire` only for items with an expiry fixed at put, and a destination put has none. So no operation erases a destination item "after its retention". Also, C07 does not name the restore loss of C09 restore step 7 as a cause of `version_gone`. | Errata E10 (C07). C09 adds a line that v1 keeps destination items until a covering erasure (RQ-36-2) and has no retention erase, E11 |
| R64-07 | Minor | C07 op 5 "Recovery hold"; C09 "Order of commit and put" | **The order of the checks against the put is not stated.** If identity checks authorisation or the hold after the put, a refused change leaves the attacker's bank details in the store, write-once. No version refers to them, and no operation can remove them (R64-06). A recovery that is cancelled between the put and the commit has the same problem. | Identity checks authorisation and the hold before the put. It checks them again in the commit transaction. A refused change puts nothing. An item with no committed version is never read. Errata E12, E13 |
| R64-08 | Minor | C09 `get` "breadth alert"; C07 op 5 | The weekly run reads the destination of every supplier in a short time. The first run, and any growth in suppliers, can make identity's distinct subjects in one hour more than 3× the trailing seven-day maximum. This gives a false breadth alert each week, and the team learns to ignore it. | Count the breadth alert for each (reader, purpose). For `payout_destination`, set its bound as the number of suppliers due in the run. Erratum E14 |
| R64-09 | Minor | C09 "Open issues" closing paragraph (R36-31) | The paragraph still says "carried to the C16 review". C07 S2 and F6 settled both conflicts. | Erratum E15 |
| R64-10 | Minor | C07 op 5 "Version in force" ("keyed by (`destination_ref`, version)"); C09 `put` ("`<destination_ref>/<version>`") | The key forms disagree. C07 does not name the subject (supplier). C09 joins the two parts with `/`, but no contract stops `destination_ref` or `version` from containing `/`. | Errata E16 (C07) and E17 (C09) |
| R64-11 | Minor | C07 op 5 `PayoutDestinationVersion.instruction_ref`; C09 `get` audit | Identity cannot verify `instruction_ref`. C09's audit row (reader, purpose, subject) has no field for it. So the field has no defined use. | Identity records `instruction_ref` with its own audit of the C16 read. The store audit is unchanged. Erratum E18 |
| R64-12 | Minor | C09 restore step 6 and step 7 | **Identity finds a lost destination only when it reads it**, at the next run's cut. By then a re-entered version cannot apply until the run after. So the supplier waits one more week. Identity already gets the restore's AS OF time. | At step 6, identity lists the destination versions in force, or committed, after the AS OF time. It gets each one. For each `not_found`, it asks the administrators to enter the destination again at once, before the next cut. Erratum E19 |
| R64-13 | Minor | Traceability (`impact.py`) | X1-S46 is uncited in S-SEC, and P4-S118 is uncited in S-MONEY. C07 owes the P4-S118 citation from RFC-004 (R37-13). C07's RFC-005 erratum row does not include the X1-S46 citation. | Architecture issue A-64-2 |

## Errata (one line each, v1.1 clarifications)

| # | Contract | Section | Erratum |
|---|---|---|---|
| E1 | C07 | Op 5 errors, "Payouts' use" table | Add the row: "`NOT_FOUND{version_gone}` on `PayoutDestinationAt` (the version in force at `at` exists in identity's history, but the store answers `not_found`, for example lost in a restore): no lot is created, the amount carries forward, escalated to finance at once; identity tells every supplier administrator to enter the destination again (an ordinary change, applied from the first run with `T_w ≥ c`)." |
| E2 | C07 | Test P6 | Replace "erased version → the three `NOT_FOUND` reasons" with "erased or restore-lost version → `version_gone` on both forms; payouts escalates at once on the at-cut form (no lot) and on a resend (not sent)." |
| E3 | C09 | `get` "Payout destination" and test 26 | Replace "is mapped by C16 to 'not found': RFC-004 escalates to finance" with "is mapped by C16 to `NOT_FOUND{version_gone}` on both forms (C07 op 5): payouts escalates to finance at once; identity alerts and asks every supplier administrator to enter the destination again." |
| E4 | C07 | Op 5 "Version in force at `at`" | Add: "A `version` is minted by identity uniquely for each change command (never reused, even after a put whose commit failed); versions are ordered by their commit timestamp `c`, not by the version string." |
| E5 | C09 | "Write-once kinds" | Replace "minted by identity's C16 command only" with "minted by identity's C16 command only, unique for each command and never reused, so that a put left by a failed commit never makes a later change `refused(item_exists)`." |
| E6 | C07 | Op 5 precondition | Replace "Identity, the single writer of the history, answers from its own state" with "Identity answers from the history rows that each change's own transaction wrote, in a serializable read whose timestamp is above `at` (it waits until that is true), never from a projection that is updated later." |
| E7 | C09 | "Timeouts" row "`get` for C16" | Replace "No deadline" with "No overall deadline; per-call deadline 2 s (C07 S4), retried." |
| E8 | C07 | "Timeouts" row "Op 5 call" | Add: "The run has no overall deadline for a supplier that is waiting (C09)." |
| E9 | C07 | Op 5 errors | Add: "The store's `refused(read_limit)` and the HSM budget answer → `UNAVAILABLE`; any other store refusal → `INTERNAL`, alerted, and the run waits for that supplier." |
| E10 | C07 | Op 5 "Delivery and idempotency" | Replace "until a store item is erased after its retention" with "until the item is erased by a covering erasure (C09, RQ-36-2) or lost in a restore (C09 restore step 7)." |
| E11 | C09 | "Payout destination details" (R36-25) | Add: "v1 has no retention erase for these items; they stay until a covering erasure (RQ-36-2)." |
| E12 | C07 | Op 5 "Recovery hold" | Add: "Identity checks authorisation and the hold before the details are put, and again in the commit transaction; a refused change puts nothing." |
| E13 | C09 | "Order of commit and put" (C16 sentence) | Add: "Identity puts the details only after it has checked authorisation and the recovery hold; an item with no committed version is never read." |
| E14 | C09 | `get` "breadth alert" | Replace "a reader's distinct subjects" with "a (reader, purpose)'s distinct subjects; for `payout_destination`, the bound is the number of suppliers due in the run." |
| E15 | C09 | "Open issues", closing paragraph | Replace the paragraph with: "R36-31 is closed by C07 v1: S2 (refused during the hold, as X1-S46) and F6 (a lot paid again in a later run goes to that run's destination, as P4-S118 row 3); the errata owed by RFC-000 and RFC-004 are listed in C07." |
| E16 | C07 | Op 5 "Version in force at `at`" | Replace "keyed by (`destination_ref`, version)" with "keyed by subject = `supplier`, item = `"<destination_ref>/<version>"` (C09)." |
| E17 | C09 | `put` "Payout destination details" | Add: "`destination_ref` and `version` are identity-minted and contain no `/`." |
| E18 | C07 | Op 5 "Authorisation" | Add: "Identity records `instruction_ref` with its own audit of the read; it does not verify it." |
| E19 | C09 | Restore step 6 | Add: "Identity gets each payout-destination version in force at, or committed after, the AS OF time; for each `not_found` it asks every supplier administrator to enter the destination again at once." |

## Decisions taken

- **D-64-1 (R64-01)**: when the version in force at the cut is lost, payouts escalates to
  finance at once and creates no lot. It does not wait 4 runs. A loss is a fault of the
  platform, not something the supplier did or did not do. A lot with a destination that
  is not known can never be paid, and money that waits with no owner is a risk to Share.
  The supplier loses at most one run. R64-12 makes this loss less likely.
- **D-64-2 (R64-02)**: the destination version is a value that is unique to each command.
  The cost is small, and it removes a block that only an engineer can remove by hand.
- **D-64-3 (R64-05)**: a rate limit is a temporary state, so payouts waits for it and does
  not escalate.
- **D-64-4 (R64-08)**: the breadth alert is counted for each (reader, purpose), not for
  each reader. Without this, a weekly false alert teaches the team to ignore a
  security alert.

## Requirements issues

None new. `requirements-v1.10` agrees with the C07 decisions (X1-S46 refused, P4-S118
rows 1 to 3, POL-22 "a run already started"). **RQ-36-2** stays open. It matters here:
if a covering erasure reaches a sole trader's destination that is in force, then every
run answers `version_gone` and escalates. The answer to RQ-36-2 must say whether such an
erasure stops payouts or waits for the last payout to be reconciled.

## Architecture issues

- **A-64-1 (RFC-000 §8 payout-destination row)**: C07 owes RFC-000 the
  held-to-refused erratum, but no erratum covers the signature. The row still gives
  `payout_destination(destination_ref, version) → details` and two errors. **Amendment**:
  "`payout_destination(supplier, at)` and `payout_destination(supplier, instruction_ref,
  destination_ref, version)`, payouts' principal only; errors `NOT_FOUND{unknown_supplier
  | no_destination | version_gone}`, `UNAVAILABLE`, `PERMISSION_DENIED`; a lost or
  erased version is `version_gone`, escalated to finance at once."
- **A-64-2 (RFC-005 C16 traceability; RFC-004)**: RFC-005 C16 cites RQ4-14 (interim)
  but not X1-S46. RFC-004 does not cite P4-S118. **Amendment**: add the line "cite
  X1-S46 (C16 command)" to C07's RFC-005 erratum row. RFC-004's P4-S118 citation is
  already owed (R37-13).
- **A-64-3 (RFC-005 C16 command)**: "the details are put to the personal-data store first,
  then the new version is committed" does not give the order of the authorisation and
  hold checks, and does not say how identity mints the version. **Amendment**: "identity
  checks authorisation and the hold, mints a version unique to the command, puts the
  details, then commits the version and checks again in that transaction" (R64-02,
  R64-07).
