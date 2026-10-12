# Review 53. Fix verification of C05 funds and standing (v0.2) against review 45

| | |
|---|---|
| Under review | [C05](../04-delivery/contracts/C05-funds-and-standing.md) v0.2 draft (working copy), its "Review 45 resolution" table, Settled S-1 … S-8 and Consumer obligations |
| Review record | [Review 45](45-contract-C05-review.md): M1 … M6, m1 … m15, D-1 … D-6, RQ-45-1, AI-45-1, AI-45-2 |
| Authority | `requirements-v1.10`; RFC-000 rev. 4.4; RFC-004 rev. 5 + erratum 5.1; RFC-002 rev. 5; RFC-005 rev. 5. Neighbour contracts (contract sections only): [C06](../04-delivery/contracts/C06-usage-and-charges.md) §4 `UsageApplied`, `RatingPosition`; [C07](../04-delivery/contracts/C07-receivables-and-payouts.md) Operation 2 (schema, order, S1, obligations to C05); [C08](../04-delivery/contracts/C08-identity-and-access.md) `SignedKeyRecord`, §B push and catch-up (schema and semantics) |
| Tools | `python3 tools/check_specs.py`: no problems (473 scenarios). `python3 tools/impact.py coverage S-MONEY`: primary 118, uncited 2 (P4-S117, P4-S118), dangling 0. This is unchanged from review 45, as expected: the RFC-004 traceability gap is listed as an obligation, and C05 now cites P4-S117 itself |

## Verification

### Per finding

| ID | Result | Notes |
|---|---|---|
| M1 (D-1) | Verified | `QueuedChange.lockedPrice` and `priceVersion` exist for an Increase, taken from that change's E1. In the `admit` row, ρ⁺ prices each part, committed or ahead, at max(locked, recorded step in force at m). S-6 and the RFC-004 §A5.2 obligation are present. Re-trace: 2 µ reservation, catalogue at 3 µ, I1 +50 Mbps ahead of E2. ρ⁺ = 100 × 2 + 50 × 3 = 350 µ/min, so `x` covers E2 whichever way I1 resolves. P4 now includes this case |
| M2 (D-6) | Verified; see V53-3 and V53-4 | `R_applied(p)` is applied and gap-free, and a gap-buffered event holds it below that event. A catch-up or snapshot counts only once its entry commits, or at once if it carried no change. After acquisition the watermark is set only by the catch-up or by every partition. Re-trace (revocation in a gap buffer, markers arriving): `R_applied(p)` stops below the revocation, `iamFresh` stops, and E5 fails after 45 s. The holder pulls at 20 s, and the catch-up applies the revocation. H4 covers this, S-2 is amended, and obligations go to RFC-000, RFC-002, RFC-004 and RFC-005. C08 §B still states the old wording, and no obligation row is raised against it (V53-3) |
| M3 | Verified | `completeThrough` and the `id_ts` skip are deleted. F4 is deduped by (identity partition, sequence), with the per-key highest version winning and `revoked` terminal. Re-trace (a revocation with a lower commit timestamp arriving after a later event): its (partition, sequence) is not yet applied, and its version is above the applied one, so it is applied. P13 covers this. C08 dedupes by `source` with highest version per key, which is consistent |
| M4 (D-4) | Verified | `ProvisionalKeyRecord` = the signed bytes plus the parsed C08 `SignedKeyRecord`, which has `tenant`, `status`, `limits`, `version` and `probe`. The record is refused if revoked or if its tenant ≠ the account. It is used only while the key is absent from applied state. That is stricter than C08 §A ("ignored if applied as revoked or lower version"), but compatible with it. `revokedKeys` includes keys revoked "from absent". H6 covers this |
| M5 (D-2) | **Defect (V53-1)** | Scope = `member` plus applied F9, with v and `designatedAtMapVersion` recorded only, matches C07 S1. The stale answer is C07's `temporarily_unavailable` (C07 already carries it, `reason: "identity_stale"`). **The check order is not C07's**, although the F5 row, S-3 and the resolution all say it is |
| M6 (D-5) | Verified | C06 owns the wire form. The topic is `account.usage-applied.v1`, and the body is C06 `UsageApplied` (`appliedThrough`, `appliedTs`, `inFlightUsageBatch`, `eventId`). Dedupe is (account, `appliedThrough`). `RatingPosition` matches C06's. `usage_applied_since` returns C06 events keyed by `eventId.streamSeq`. The `entry` field is **owed by C06** (it is in the parallel revision and listed under obligations), so it is not a C05 defect |
| m1 (D-3) | Verified; see V53-2 | Checks are for suspensions only, at 60 s (`ENFORCEMENT_ACK_MISSING`, unless a later transition) and at 120 s (`LATE_ENFORCEMENT`). The F8 raises `LATE_ENFORCEMENT` once, if `enforcedAt` is past the target. An on-time ack delivered late is not late. Re-traces (a), (b), (c) and (d) of m1 are clean. P12 and Q3 cover them |
| m2 | Verified | The ms ↔ HLC rules are stated. The F7 `Deferred` test and the `due` instants use them. P11 and P12 test the boundaries (on time at exactly the target, late at + 1 ms) |
| m3 | Verified | Recomputed below |
| m4 | Verified | `position.ts` is the commit timestamp at `position.log`, and `evaluatedAt` is the read timestamp. `answer` reads applied state, and only `A` and the `KP_k` period use `evaluatedAt`. Q4 covers this |
| m5 | Verified | `NOT_FOUND` for another tenant or a supplier. The replica re-checks the C1 context. `PERMISSION_DENIED` is removed |
| m6 | Verified | `iamFreshUsed` is required on `set`, and `designatedAtMapVersion` is added |
| m7 | Verified; see V53-3 | The rows for RFC-000 §8, RFC-004 (F4, §B12, rev. 5 item 1), RFC-005 C3 and §7.4, C06 and C07 are present. A C08 row is missing |
| m8 | Verified | The F4 `snapshot` source is added. An applied key absent from the snapshot is revoked as applied, with `KEY_ABSENT_FROM_SNAPSHOT`. This fails closed. C08 does not state the absent-key semantics: see V53-3 |
| m9 | Verified | The wording is fixed. The rebuild uses `emits`, from live rows or sealed segments. Sizing recomputed: 25,000–50,000 × 604,800 = 1.51–3.02 × 10¹⁰ events; × 200 B = 3.0–6.0 TB; × 3 = 9–18 TB. `inputs` is gone, and owner publish is marked est. |
| m10 | Verified | The query is served by the status readers, off the write path. The finding is recorded, and the query is kept per S-4 |
| m11 | Verified | S-5, with an RFC-002 E11 erratum |
| m12 | Verified | P4-S117 is cited (F1 row and scenario list). The RFC-004 traceability gap is listed. The tool output is as expected |
| m13 | Verified | `Checked` is on both `Verdict` variants and recorded in E1/E1′. P15 covers it |
| m14 | Verified as written; **Defect (V53-2)** | An unknown, future or superseded `stdSeq` is recorded with `ENFORCEMENT_ACK_UNEXPECTED`, and there is no effect. But "superseded" catches a normal race and raises a false alert |
| m15 | Verified | H4 covers a lagging partition, a gap-buffered revocation, an uncommitted catch-up, and `adopt` and re-home |
| RQ-45-1, AI-45-1, AI-45-2 | Verified | Listed under Consumer obligations (Requirements; RFC-000 §8) |

### Arithmetic (recomputed)

| Figure | Recomputation | Result |
|---|---|---|
| `LB` integer formula | Mbps × ms = 10³ bit = 1.25 × 10⁻⁷ GB; × pico-USD/GB ÷ 10⁶ (pico → µ) gives a divisor of 8 × 10¹² | ✓ |
| P3-S37 / P7 / P14 | Λ = 180 + 60 + 60 + 10 + 60 + 60 = 430 s = 430,000 ms; 100 × 430,000 × 10¹⁰ = 4.3 × 10¹⁷; ÷ 8 × 10¹² = 53,750 µ; span `[ts − 370 s, ts + 60 s]` | ✓ |
| M1 trace (P4) | 100 × 2 + 50 × 3 = 350 µ/min (v0.1 could only derive 300) | ✓ |
| Enforcement instants | `ceil(since.wallNanos / 10⁶) + 60,000` and `+ 120,000` ms; on time when `enforcedAt` equals the target, late at + 1 ms (`>`) | ✓ |
| Topic sizing (m9) | See m9 | ✓ |
| Earlier figures (P2-S38, J-01, P4-S22, P4-S114, P2-S117, P4-S55/S68/S13) | Unchanged from v0.1, which review 45 verified | ✓ |

### Defects

| # | Finding | Location | Failure | Fix |
|---|---|---|---|---|
| V53-1 | M5 | F5 apply rule (Funds entries table); S-3; resolution row M5 | C05 orders the checks envelope → scope → dedupe → `iamFresh` gate → validity → KYB. C07 Operation 2, which is binding for this wire command (R37-01, S1), orders them as follows: (1) authenticity, C08 checks 1–2; (2) **dedupe**; (3) operator freshness, checks 3, 5, and 6 for a single target; (4) scope; (5) validity; (6) KYB, with the `iam_fresh` stale answer **inside the KYB step**. Three answers diverge. (a) A retry of an applied set-scoped action after F9 changed gets `out_of_scope` in C05 but the recorded `applied` in C07. (b) A retry after `not_after` passed, or after the operator's role was withdrawn, is refused under C05's "envelope first" but answered with the recorded outcome in C07. (c) An invalid `set` on a stale slot gets `temporarily_unavailable` in C05 but a recorded `refused{invalid}` in C07. Separately, C07's obligation row to C05 (R37-03) asks for the F5 supersession rule (a `CreditLimitRemoved` is superseded by an F5 `set` committed after its `decided_at`), and C05 does not carry it | In the F5 row, S-3 and the resolution row, restate the order as C07's: authenticity (checks 1–2) → dedupe by (`actionId`, account) → operator freshness (checks 3, 5, 6) → scope (set-scoped) → validity → KYB, where the KYB step for `set` first applies the `iamFresh` gate (`temporarily_unavailable`, nothing appended). Add one sentence to the F5 `removed_invoice_written_off` rule: "recorded as superseded, with no change, if an F5 `set` committed after the event's `decided_at` (C07 R37-03)". Comment on F9 that `mapVersion` is the designating slot-map version |
| V53-2 | m14 / D-3 | F8 row; Idempotency F8 row; `Alert` `ENFORCEMENT_ACK_UNEXPECTED` comment; P12 | Take a suspend (n), then a quick top-up and resume (n+1), where network operations had already blocked n and acks it. The ack for n is routinely consumed **after** n+1 has committed, because the ack is asynchronous. Under "superseded by a later transition → `ENFORCEMENT_ACK_UNEXPECTED`", operations is alerted on a normal sequence. That contradicts D-3's intent, which is that an earlier suspension under a fast suspend → resume is not reported | Split the case. An ack for a **recorded** `stdSeq` lower than the current one is recorded with no alert and no late check (D-3: a later transition has committed). `ENFORCEMENT_ACK_UNEXPECTED` is only for an unknown or future `stdSeq`. Adjust P12's last case to match |
| V53-3 | M2, m7, m8 | Consumer obligations | C08 §B, a neighbour contract, still states the superseded watermark. Its wording is "advanced by every resolved marker …", "**unset after any takeover until the first marker or catch-up**" and "sets `iam_fresh` to `read_timestamp`" (no commit condition). Its consumer test C-02 says "after takeover no confirm before the first marker or catch-up". C08's snapshot rule does not state C05's absent-key revocation. With no row, C08's tests and text stay contradictory to S-2 | Add an obligation row for C08: "§B freshness watermark and C-02: S-2's applied, gap-free `R_applied(p)`; after acquisition set only by a **committed** catch-up or once every partition has reported; catch-up and snapshot count once their entry commits. §B snapshot (S-G1): an applied key absent from the snapshot is revoked as applied (m8)" |
| V53-4 | M2, m2 | Units ("Converting between ms and HLC") | C08's identity timestamps (`committed_at`, `resolved`, `read_timestamp`, snapshot `position`) are `EpochMicros`. C05 types F4 `commitTs` and the snapshot `position` as `HlcTimestamp`, and compares `ctx.ts` with `iamFresh + 45 s`. Only the ms conversion is given, so the µs → HLC mapping, and the boundary of the E5 and F5 freshness gate, are unstated (the same ambiguity m2 fixed for ms) | Add one bullet under Units: "an identity instant in µs is compared through its wall time: `µs × 10³ ≤ ts.wallNanos`. `iamFresh` is held as wall nanoseconds (µs × 10³), and the gate is `ctx.ts.wallNanos ≤ iamFresh + 45 × 10⁹`. F4 `commitTs` and `position` carry C08's µs value as `wallNanos = µs × 10³`, `logical = 0`" |

Observations (no change required): C05's in-process `LedgerPosition` (`ledgerPartition: string`, `sequence`) differs in shape from C06's wire `LedgerPosition` (`partition: number`, `seq`). This was not raised by review 45. It only needs a decode note if the orchestrator wants the two to match.

## Verdict

**ACCEPT WITH CHANGES.** 19 of the 21 findings, and every decision except the C07 order part of D-2, hold. The arithmetic re-traces correctly. There are four defects: V53-1 (the F5 check order is not C07's, and the C07 supersession rule is missing), V53-2 (a false `ENFORCEMENT_ACK_UNEXPECTED` for a superseded but legitimate ack), V53-3 (no C08 obligation row), and V53-4 (no µs ↔ HLC rule for identity timestamps). Each is a precise local edit of a few lines in the cited rows, so the orchestrator may apply them directly instead of running another round.
