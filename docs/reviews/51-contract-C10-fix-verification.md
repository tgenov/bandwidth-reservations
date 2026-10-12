# Review 51. Fix verification of C10 `booking-api` (1.0.0-draft.3) against review 40

| | |
|---|---|
| Under verification | [C10 Booking API](../04-delivery/contracts/C10-booking-api.md), version 1.0.0-draft.3, its "Review 40 resolution" table, "Errata required of other documents" and "Settled" (M2 narrowed) |
| Review record | [Review 40](40-contract-C10-review.md): R40-01 … R40-26, decisions D1 … D8 |
| Authority | `requirements-v1.10`; RFC-000 rev. 4.4; RFC-002 rev. 5 (§2.5 re-slotting, partition moves with generations); RFC-005 rev. 5 (§5.2, §13, A11 logging rule); RFC-004 rev. 5 |
| Scope | Only the passages each finding names, plus the authority they rely on. The RFC-005 permission-matrix rows for `quote` and offer answers are owed as errata after freeze (AI-40-2) and are not counted as a C10 defect |
| Tools | `python3 tools/impact.py coverage S-ACCT`: primary 117, uncited 0, dangling 0 |

## Verdict

**ACCEPT WITH CHANGES.** 26 of 26 fixes are present. 22 hold as written. Four defects
remain: two in the D3/D1 quote token (V51-01, V51-02), one schema slip (V51-03) and one
missing erratum (V51-04). **Each fix is a local edit of a few lines.** The orchestrator may
apply them directly, without another round.

## Per finding

| ID | Present | Result | Notes |
|---|---|---|---|
| R40-01 | Yes | **Defect** (V51-01, V51-02) | The token, no log write, the narrowed replay, key retirement no earlier than `valid_until`, `ack_budget` relief and CT-P21 are all present. Takeover within the slot holds. Re-slotting does not hold (V51-01), and the request is not bound to the quoted candidate (V51-02) |
| R40-02 | Yes | Verified | There are four families, keyed (account, family, key). Header table, endpoints "Family" column, Idempotency table, `status` and `withdraw` read only the booking-and-change family. CT-P23, CT-C01. The quote family's other-principal row after an owner change reveals nothing |
| R40-03 | Yes | Verified (see V51-02) | Check 4 gives `quote_required` with `requote`, recorded and nothing held. It applies to book, extend and increase. "Shown" has one meaning, and the resubmission goes under a new key (the `quote_id` is outside the fingerprint, which is consistent). CT-P20, CT-C08. The rule holds only once V51-02 binds the cited quote to the request |
| R40-04 | Yes | Verified | `fees: ShownFee[]` is present. The rule for which fee one event makes due is stated, with at most one fee per reservation and leg. CT-P16 includes a leg with both fees |
| R40-05 | Yes | Verified | Header table, the "Malformed or invalid" row and the withdraw endpoint row agree. CT-P24 |
| R40-06 | Yes | Verified | A pre-emptive withdrawal is an E1′ `failed withdrawn` with no fingerprint and `request_kind: "preemptive_withdrawal"`. A later submission by the same principal gets it, and another principal gets `409`. It is rate-counted. The 404 row says "never for withdraw", and `context_ttl` 60 s is well inside the 24 h retention. CT-P25, CT-C09. The RFC-002 §7.1/§8.2 erratum is listed |
| R40-07 | Yes | Verified | Check 1 comes first, with `unknown_route` (including a probe link named by a non-probe principal) and `product_not_on_route`. Book returns `404` only for `quote_id`. The quote candidate gets `422`. CT-P26 |
| R40-08 | Yes | Verified | The intake makes no existence check, and there is no `404` in the endpoint row or the errors. CT-P31 covers the later refusal at the owner |
| R40-09 | Yes | **Defect** (V51-04) | AI-40-1 … AI-40-4 and RQ-40-1 … RQ-40-5 are all listed. Every AI-40-3 sub-item in review 40 is present, and the freeze is conditional on the RFC-005 matrix rows. One erratum created by the R40-20 fix is missing |
| R40-10 | Yes | Verified | `blocking_partner_link` is present. P2-S18, P2-S31 and P2-S34 are cited. CT-P12 |
| R40-11 | Yes | Verified | `valid_until` is binding and gives `terms_changed` with `requote`. It is never later than the next price version known to the cache. CT-P20 row |
| R40-12 | Yes | Verified | The order is route, validity, rules, terms, `admit`. Checks 4 and 5 are re-evaluated at `ts`. CT-P22 |
| R40-13 | Yes | Verified | `Quote.effect` |
| R40-14 | Yes | Verified | `headroom_after?` is conditional on RQ-40-4 and AI-40-4 |
| R40-15 | Yes | Verified | `NotAccepted.limit` with the four values. CT-P09, CT-C05 |
| R40-16 | Yes | Verified | The top-level field is authoritative, and `CounterOffer` no longer has the field |
| R40-17 | Yes | Verified | `cut_kept` appears in `accepted` and `final`, and in CT-P19 |
| R40-18 | Yes | Verified | `422 {error:"invalid", rule}`: nothing recorded, the key is not consumed. CT-P28 |
| R40-19 | Yes | Verified | Offer reads count toward `key_poll_limit`, and `429 poll_limited` is in the endpoint row and CT-P09 |
| R40-20 | Yes | Verified (erratum in V51-04) | Syntax rule, no personal data, keyed digest. CT-P29, CT-C11 |
| R40-21 | Yes | Verified | `withdraw` and `request_idempotency_key` are dropped |
| R40-22 | Yes | Verified | Note ≤ 4096 bytes, the endpoint gives `400`, `mgmt_rate_limit` 5/s per principal (matches RFC-005 §13), and the note is inert |
| R40-23 | Yes | Verified | The "Malformed or invalid" table is present |
| R40-24 | Yes | Verified | `key_expires_at`, the status `404` reading, CT-C10 |
| R40-25 | Yes | Verified | The 403 row is made and recorded at the owner. The RFC-005 §2.3/§4.1 erratum is listed. CT-P26 |
| R40-26 | Yes | **Defect** (V51-03) | All the listed tests are added (CT-P14 P2-S85, CT-P18 X1-S05, CT-P27, CT-P28, CT-P29, CT-P30, CT-P06 withdraw `409`) and the IDs are in order. Quote p99 (est.) and the shared limit are stated. The new 401 row text names a type that does not exist |

Decisions D1 … D8 are applied as decided. D3's narrowing of M2 is recorded in Settled M2.
D8 is in "Who may answer".

## Defects

| ID | Severity | Location | Failure | Fix |
|---|---|---|---|---|
| V51-01 | Major | §quote "The token" ("per-account-slot quote key … survives every owner change (takeover, slot move, re-home)"); Versioning ("a token from a retired key version is `404`"); CT-P21 | **The key scope does not survive a re-slotting.** RFC-002 §2.5 (and RFC-006 §4.5) moves an account partition to another slot. The new slot's holders hold a different per-slot key, so a token issued a minute earlier fails verification and gets `404`. That answer is not an outcome and does not consume the key, so every retry under the key gets `404` again: the R40-01 loop is back, this time on re-slotting. The same happens to a token under a retired key version | In check 4 and §quote, replace "A token that fails verification … is `404`" with: "A token naming the caller's account that does not verify under the slot's current or retained key versions (issued before a re-slotting, a retired version, or altered) is treated as past `valid_until`: `rejected`, `terms_changed`, with `requote`, recorded. A token naming another account, or not parseable, is `404`." This is safe, because the requote only shows the caller's current terms. Alternative: one owner-fleet quote key held by every account-owner lease holder. Update the Versioning bullet to match, and change CT-P21's "slot move" case to "re-slotting: `terms_changed` with `requote` (or verified, under the alternative)" |
| V51-02 | Major | §book check 4 ("any term it carries differs from the terms to be locked"); §change; CT-P20 | **The cited quote is not bound to the request.** The MAC covers the candidate digest, but check 4 only compares the terms the token *carries*. Example: a quote for a single-leg, fee-free candidate carries no partner legs, so no carried term differs. Cited on a booking over a fee-bearing partner route, it passes check 4, and the buyer is charged a fee it was never quoted. D1 is defeated, and so are "never charged a fee not in a quote it cited" and POL-08. A change quote for reservation X cited on reservation Y is the same hole | Check 4: "If the cited quote's candidate is not this request (legs, window, rate, product; for a change: reservation, kind, new end or new rate), or it is past `valid_until`, or its shown terms are not **equal** to the terms to be locked (the same set of partner legs, and each leg's fields and fees): `rejected`, `terms_changed`." Add a CT-P20 row: a quote for another candidate (single-link vs partner route, and another reservation) gives `terms_changed` |
| V51-03 | Minor | Error codes, 401 row: "key revoked as applied at the owner (`NotAccepted{revoked}`, …)" | `NotAccepted.code` has no `revoked`, the row's body is `{error:"unauthenticated"}`, and the same row requires an identical body for every cause | Replace the parenthesis with "(X1-S06, X1-S41), the same `{error:"unauthenticated"}` body" |
| V51-04 | Minor | Errata required of other documents | The R40-20 fix makes the **edge** (RFC-005) log a keyed digest of each idempotency key and never the key. RFC-005 states no such logging rule, and its §5.2 booking and change rows still read "(account, idempotency key)" | Add a row: AI-40-2, RFC-005 §5.2 and edge logging (A11): "the booking and change rows are scoped (account, booking-and-change family, key); the edge logs a keyed digest of every idempotency key, never the key; keys need an alphanumeric character" |

## Checks requested by the brief

- **D3 soundness**:
  - *Takeover within the slot* holds: every owner-lease holder of the slot holds the key.
  - *Re-slotting* fails (V51-01).
  - *Replay*: a token is deliberately reusable within `valid_until`, which is safe because the terms are compared at `ts`, but only once the token is bound to the candidate (V51-02). Cross-account replay gives `404`, because the account is under the MAC.
  - *`valid_until`* is binding, capped at the next known price version, and evaluated in the transaction at `ts`.
- **D1**: correct for book, extend and increase. Reductions are exempt, and the `requote` path and the new-key rule are consistent with the fingerprint. It depends on V51-02.
- **D2**: consistent across the header table, the endpoint table, the Idempotency table, the status and withdraw sections, the tests and errata.
- **Errata list**: complete against review 40's AI-40-1 … AI-40-4 and RQ-40-1 … RQ-40-5. It is short one entry created by a fix (V51-04). The RFC-005 matrix rows are owed after freeze and are not a C10 defect.
