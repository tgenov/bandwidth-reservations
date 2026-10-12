# Review 49. Fix verification of C07 receivables-and-payouts (version 2 draft)

| | |
|---|---|
| Under review | [C07](../04-delivery/contracts/C07-receivables-and-payouts.md), version 2 (draft), against [review 37](37-contract-C07-review.md) (R37-01 … R37-30, D-37-1 … D-37-6) and the added `temporarily_unavailable{identity_stale}` answer ([review 45](45-contract-C05-review.md) M5) |
| Mode | Fix verification. Only the passages named by the contract's "Review 37 resolution" table, plus the authority passages they rely on |
| Authority | `requirements-v1.10` (P4-S86, P4-S99 read at the tag); RFC-000 rev. 4.4; RFC-004 rev. 5 + erratum 5.1 (§B4.2, §B7.2); RFC-002 rev. 5; RFC-005 rev. 5 (§7.4 check 6, C4); [C08](../04-delivery/contracts/C08-identity-and-access.md) §E (`OperatorEnvelope`, digest, `EnvelopeAnswer`, idempotency row) |
| Tools | `python3 tools/impact.py coverage S-MONEY`: primary 118, uncited 2 (P4-S117, P4-S118), dangling 0. Expected: the citation is the RFC-004 traceability erratum listed under "Errata owed", which is not yet applied |

## Verification

### Re-traces

- **P4-S86 (R37-02)**, recomputed. Run 1 instructs lot L = 120.000000, and it fails as
  final. No M15 was posted, so in run 2 `N` = 120.000000. L is FailedFinal, so it is
  excluded from `F` (RFC-004 §B7.2: "instructed and not FailedFinal"), which gives `F` = 0
  and `pay` = 120. Then `FF` = {L} (120 ≤ 120), `new` = 0, `lots` = {L} and
  Σ = 120 ≥ 50, so the run sends one instruction of `K` = 120.00 USD under a new
  reference. This matches P4-S86 at the tag ("the 120.00 USD is included in a new payout
  instruction with a new reference"). It also matches C07's P4b and RFC-004 §B7.4. In
  every case Σ lots = `pay`, so the minimum test equals RFC-004's `pay ≥ payout_minimum`.
  RFC-004 never defines `round_down`, so dropping it changes nothing: `K = floor_minor`
  and the residue carry the rounding.
- **P4c (R37-07)**: 120 × 129.53 = 15,543.60, so `K′` = 15,543 and
  `P′` = floor_µ(15,543 / 129.53) = 119.995367, which leaves a residue of 0.004633. The
  figures are correct.
- **R37-01 lost answer**: apply, lose the answer, move `target_version`, pass `not_after`
  and revoke the role. Step 2 answers the recorded `applied` before checks 3, 5 and 6
  run. The fix holds (K2b).
- **C05 M5 (identity_stale)**: (a) membership at v is dropped. (b) The answer is a union
  member that is "not recorded" and that the console retries. It maps to C08
  `temporarily_unavailable`. (c) A repeat while identity is stale is answered by step 2
  before step 6. `remove` is exempt. K2c covers it. The fix holds.

### Findings

| Finding | Result | Note |
|---|---|---|
| R37-01 | **Defect** (D49-1, D49-2, D49-4) | Order is correct. Step 2's lookup is underspecified (below) |
| R37-02 | Verified | Re-traced above |
| R37-03 | Verified | Supersession rule, D-37-5, K1b |
| R37-04 | Verified | `ledger_pos` per account; P1b |
| R37-05 | **Defect** (D49-3) | Delivery-table key contradicts the 4b rows |
| R37-06 | Verified | Retention ≥ 8 days, `first_sent_at`, status query or escalation |
| R37-07 | Verified | Re-traced above |
| R37-08 | Verified | Bound conversion, one reversal, class key, P2b. A same-content second reversal answers `duplicate`, which D-37-1 accepts (nothing moves either way) |
| R37-09 | Verified | Rows (a)–(c), D-37-3, P2 |
| R37-10 | Verified | Seven kinds, `direction`, per-kind `reference`, `funds_held_usd` required |
| R37-11 | Verified | Pending v, `probeSetSummary(v)`, K4b, errata RFC-006 and C01 |
| R37-12 | Verified | Op 2 transport union, op 1 moves, `retry` on ops 3 and 4b, K1 and K4 |
| R37-13 | **Defect** (D49-5) | Three erratum rows are incomplete |
| R37-14 | Verified in the contract. Erratum missing (D49-5) | |
| R37-15 … R37-24 | Verified | |
| R37-25 | **Defect** (D49-1) | P4-S99 is cited, but the claim in "Idempotency" ("fails at step 2 as `conflict`") is false as specified |
| R37-26 … R37-30 | Verified | |
| C05 review 45 M5 | Verified in the contract. Errata missing (D49-5) | |
| Earlier fixes (Settled S1–S4, F1–F6) | Not broken | S1 now names the console rule and the audit check |

### Defects

- **D49-1 (R37-01, R37-25; P4-S99, C08 idempotency row).** The C08 digest is
  `SHA-256(action ‖ role ‖ not_after)`. It does not cover the signer. Another operator
  who signs the same action under the same `action_id` therefore produces the same
  digest, and step 2 answers the recorded `applied`. P4-S99 says "refused, as a reuse …
  by another principal", and C08 says "a different principal is refused". **Fix**: in op 2
  step 2 add "or if the recorded F5's requester `principal_id` differs → `refused{conflict}`,
  recorded". In "Idempotency", change "fails at step 2 as `conflict`" to "is refused at
  step 2 (`conflict`): digest or requester principal differs".
- **D49-2 (R37-01).** A `conflict` is recorded as an F5 under the same `action_id`. The
  log then holds two F5s for that id, and "answer the recorded answer" does not say which
  one. **Fix**: in step 2, write "the answer of the **first** F5 recorded for `action_id`.
  A recorded `conflict` refusal never becomes the action's answer".
- **D49-3 (R37-05).** The op 4 delivery table keys transfer reports by (`instruction_ref`,
  `provider_ref`) and says "same key, different content → Escalated". A non-final failure
  followed by a confirmation under the same `provider_ref` would then be escalated and
  M15 never posted. The 4b rows require M15, and their duplicate row uses
  (`instruction_ref`, `provider_ref`, outcome). **Fix**: in that table row, set the key
  to (`instruction_ref`, `provider_ref`, `outcome`, `final`). Change "Same key, different
  content" to "Escalated (amount/currency differences, per 4b)", and add "a different
  outcome under the same `provider_ref` follows the 4b rows".
- **D49-4 (C05 M5 order; R37-01).** Step 2 deduplicates by (`action_id`, receiving
  account). The digest excludes `member`, so a set-scoped envelope whose `member` ≠ the
  receiving account can match that account's recorded F5. It is then answered `applied`
  for the wrong member instead of `out_of_scope`. **Fix**: add to step 1: "for a
  set-scoped action, `member` ≠ `account` → `refused{out_of_scope}`, not recorded".
- **D49-5 (R37-13 completeness).** "Errata owed" is missing three things:
  - (a) RFC-005 **C4**: review 37 R37-01 names "RFC-005 §7.4 check 6 **and C4**". Add C4
    to the RFC-005 R37-01 row.
  - (b) RFC-004 §B4.2 still says "a different provider principal is refused". Add "drop it;
    references are a per-provider namespace (R37-14)" to the RFC-004 §B4 row.
  - (c) C05 M5: add a row with `temporarily_unavailable{identity_stale}` for a stale
    `iam_fresh` on a KYB-gated set. It is not recorded and never final, and the console
    retries under the same `action_id`. Owed by RFC-004 §A4 F5 and §B12 credit-limit row,
    RFC-002 §7.3, and RFC-005 §7.3/§7.4 console fan-out (C05 review 45 M5, m7).

### Verdict

**ACCEPT WITH CHANGES.** Every review 37 finding and the M5 addition are present. Both
Blockers re-trace correctly, and P4-S86 now gives 120.00 USD. The five defects above are
each a precise local edit of one to three lines in op 2 steps 1–2, op 2 Idempotency, the
op 4 delivery table and "Errata owed". The orchestrator may apply them directly, without
another review round.
