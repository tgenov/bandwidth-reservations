# Review 62. Fix verification of C11 `metering-ingress` (1.0.0-draft.3)

| | |
|---|---|
| Under review | [C11 Metering ingress](../04-delivery/contracts/C11-metering-ingress.md), version 1.0.0-draft.3, against the "Review 57 resolution" table |
| Follows | [Review 57](57-contract-C11-review.md) (REJECT; F57-01 Blocker … F57-20; D57-1 … D57-6) |
| Authority | `requirements-v1.10`; RFC-000 rev. 4.4; RFC-003 rev. 5 + erratum 5.1 (§3.4 digest cache, §3.5); RFC-005 rev. 5; RFC-006 rev. 6; C09 1.0-draft.3 (`RecordId`, `digest_key`) |
| Mode, focus | Fix verification only (no re-review). Focus: money and security |
| Tools | `python3 tools/impact.py coverage C11`: not a registered slice (`KeyError: 'C11'`), as in review 57 |
| Orchestrator condition | The unkeyed 64-bit message digest in the 24 h context check memo is accepted only if memo rows expire at 24 h and are excluded from backups |

## Verification

### Per finding

| Finding | Verdict | Re-trace and notes |
|---|---|---|
| F57-01 (Blocker) | **Verified**, one wording defect (V62-01) | Re-traced: B_old ends 12:00, B_new (a2) starts 12:00, both published by 11:59 (`binding_lead`); stage A 3 min behind. Any heartbeat before the end fact has `coversThroughMs` ≤ its `recordedAtMs` + 60 s, and the heartbeat obligation forbids a cover ≥ 12:00 before the end fact, so parts with `t_b` ≥ 12:00 wait and later bind to a2. Applies to bound and unbound parts ("Bind only at a covered position"); producer precondition, test 18 and AI-57-1 erratum present. Defect: the `Heartbeat` invariant still says "recorded with a **valid time** ≤ `coversThroughMs`", which is unsatisfiable (or misread) for an end or change version whose `validFromMs` is in the past (V62-01) |
| F57-02 | **Verified** | Lowest-numbered epoch within 2 s; epochs never removed or moved. Re-trace: M at +1.9 s in E0, E1 opens at +2.1 s, resend of M is within 2 s of both and takes E0: duplicate. A message that opened an epoch maps to the same one on resend (no lower epoch can appear). Coordinates use the same rule; sizing re-estimated (est.); test 4(d); AI-57-2 |
| F57-03 (D57-6) | **Verified** for positioned keys; **Defect** for digest keys (V62-02) | Re-trace of the 1.98 s resend: both acks return the same positioned `RejectKey`; the second correction is `duplicate` at step 2; charged once. Digest-kind key (headerless message) is an HMAC under the exporter's **current** digest-key version; C09 rotates yearly, so a resend across a rotation gives a second key and a second accepted correction |
| F57-04 | **Verified** | Both orders traced. Correction first: I added to the range set (IPFIX) or removed from the exception set (v9) in the same transaction; resend is a duplicate, compared with the correction's digest, informative not a conflict. Resend first (now valid): accepted; the correction then hits step 8 `duplicate`. Charged once; test 10 |
| F57-05 (D57-3) | **Defect** (V62-03) | Steps 4 and 5 now anchor to the rejected record, not the correction's times. Two holes remain, each letting the exporter move the horizon again: (a) "the rejected item's receipt" is ambiguous because a resend re-rejects the same `RejectKey` in a **new** `batch` entry with a later receipt; resending the bad message daily extends the deadline and the step 5 bound indefinitely. (b) A record rejected "flow time in the future" with a far-future end (router clock jump to +1 year) gets a deadline of +1 year + 30 days |
| F57-06 (D57-5) | **Verified**, one defect (V62-04) | Format fixed per exporter ID; `Hello` refused with `protocol-error`; test 5. Defect: only the edge checks, at `Hello`, against "the partition's recorded format", but the contract says neither where the edge reads it nor that the owner re-checks. Two first sessions (R1 `netflow-v9`, R2 `ipfix`) before either format is committed, or an edge reading a lagging replica, still mix packet and record sequences in one range set |
| F57-07 | Verified | Options-template rule, single init-time value, cut of other fields; test 4(f) |
| F57-08 | Verified | Context table by SHA-256, cut context, `LoggedContext`, overhead (est.); test 4(g) |
| F57-09 | **Verified as design; Defect against the orchestrator's condition** (V62-05) | Re-trace: relay rebuilds context, resend inside 24 h has the same message bytes, memo key hits, the first epoch is taken, alert raised; test 4(e). The memo is stated as "24 h", "beside the digest cache" and "on the owner's local disk", but the contract does **not** state that rows expire (are deleted) at 24 h, nor that the memo is excluded from backups. Nor does it state takeover behaviour (local disk: a new owner starts empty, so a context swap coinciding with a takeover is not detected) |
| F57-10 | Verified | `PartitionHeartbeatEvent`, position (partition, `partitionSeq`); test 18 |
| F57-11 | Verified | One head batch per waiting partition; edge answers `notice{waiting}`; test 9; AI-57-3 |
| F57-12 (D57-4) | Verified | T4 scope by observation point and `egressGroup`; held parts in unposted usage, not charged; resolution and `dispute_window` drop; test 25 |
| F57-13 | Verified (see V62-01 for the remaining wording) | Corrections excepted |
| F57-14 | Verified | Forwarded to old (`retracted`) and new account; valid-time liveness; key (exporterId, bindingId); test 24 |
| F57-15 | Verified | Same transaction; 10⁶ safeguard |
| F57-16 (D57-2) | Verified | Case stated; relay obligation; tests 6, 15 |
| F57-17 | Verified, cosmetic defect (V62-07) | Wording present; a stray `**` follows "(F57-17). A resend … by identity**", breaking the bold |
| F57-18 | Verified | Errata listed in "Further errata from review 57" |
| F57-19 | **Verified for "no epoch"; Defect for remainders** (V62-06) | "No epoch": permanent corrected-key index, epoch-null key computable from the message alone; test 10. The heading states the general rule ("a rejection is fixed only by a `Correction`"), but the mechanism covers only "no epoch". A remainder rejected "no template" (key `record = −1`, `byteOffset` o) and corrected, then resent with a rebuilt context that now holds the template: the memo keeps the epoch, the records now decode, each has its own positioned key (not the remainder's), is not in the range set, and is **accepted**: charged twice |
| F57-20 | Verified | Correction step 2 and supersession check idempotency before every other check; idempotency table consistent; test 10 at the window boundary |

### `RecordId` against C09 1.0-draft.3

Field-for-field match: `ref.identity = { observation_domain, exporter_epoch, sequence,
index? }` (index for NetFlow v9 only), `ref.raw = { partition, log_seq, index }`, `digest =
{ key_version, hmac_sha256 }`. C09 test 23 matches C11's mapping. Defect (V62-08): C11
still calls the joint fix open or pending (header Status, line 7; `RecordId` comment, line
151; Settled "C09 (joint fix)"), and the mapping does not say that the numeric epoch and
sequence are carried as C09's decimal strings.

### Earlier fixes

No earlier fix in the "Review 41 resolution" table is broken. F41-05 (`RawRef`) is kept as
evidence only, consistent with D57-6. F41-07 is now fully covered apart from V62-03.

### Defects

| ID | Location | Failure | Fix |
|---|---|---|---|
| V62-01 | Part III `Heartbeat` comment | "Every fact RECORDED with a valid time ≤ `coversThroughMs`" cannot hold for an end or change version (its `validFromMs` is in the past), so the producer validator (test 22) either always fails or is written to a weaker reading that lets a stale binding charge the previous tenant | Replace with: "Every fact that takes effect (starts, ends or changes a binding or an observation point, as in 'Preconditions on the producer') at a time ≤ `coversThroughMs` has a `bindingSeq` ≤ this event's" |
| V62-02 | Common types `RejectKey.digest` | Key under the current digest-key version changes at the yearly rotation; a resend across it gives a second key; both corrections accepted; double charge | "`keyedDigest`: HMAC-SHA-256 of the message under **version 1** of the exporter's digest key (C09 `digest_key(exporter, 1)`, S-G3), never the current version" |
| V62-03 | Part I Correction steps 4 and 5; `DerivedRefusal` comment | (a) Receipt ambiguous across re-rejections; (b) a far-future rejected end extends the deadline | Define the receipt as "the commit timestamp of the **first** `batch` entry that rejected this `RejectKey`". Step 4 deadline = min(last minute end, that receipt) + `dispute_window`. Add to test 10: a resend a day later does not move the deadline; a record rejected with an end +1 year is refused at receipt + `dispute_window` |
| V62-04 | Part I "Export format per exporter" | Edge-only check at `Hello` can be raced or read stale; sequences mix | Add: "The format is recorded in the transaction of the first committed `batch` entry. The owner checks `BatchBody.format` against it on every batch and refuses a mismatched batch unacknowledged with `notice{protocol-error, "export format"}`" |
| V62-05 | Part I "Context check memo" | Orchestrator's condition not stated; takeover behaviour unstated | Add: "Memo rows are deleted 24 h after they are written. The memo is soft state like the digest cache (RFC-003 §3.4): never replicated, never in a backup or snapshot, and never logged. A new owner starts with an empty memo; detection then resumes for messages it receives (accepted gap, defence in depth)" |
| V62-06 | Part I "A rejection is fixed only by a `Correction`"; Batch outcome "Accepted" | Corrected remainder re-decoded on a resend is charged again | Add: "A record of a later copy that lies inside a corrected remainder (same exporter, domain, `messageSeq`, `exportTimeS` and set, at or after the remainder's `byteOffset`), or inside a corrected whole message, is a duplicate, whatever its context." Add the case to test 10 |
| V62-07 | Part I Session open, after "(F57-17). A" | Stray `**` | Remove the `**` after "deduplicated by identity" (or bold the whole sentence) |
| V62-08 | Header Status; `RecordId` comment; Settled C09 joint-fix sentence; Depends on | Joint fix shown as open though C09 1.0-draft.3 made it | Say "made in C09 1.0-draft.3"; pin C09 1.0-draft.3 in Depends on; note `exporter_epoch` and `sequence` are decimal strings |

## Verdict

**ACCEPT WITH CHANGES.** The Blocker F57-01 holds (V62-01 is wording only). Defects
V62-02, V62-03 and V62-06 are money defects (double charge or a horizon the exporter
controls). V62-05 fails the orchestrator's memo condition. Every defect is a precise local
edit of a few lines, so the orchestrator may apply them directly instead of another round.
V62-03 narrows D57-3's wording ("or receipt" becomes the earliest receipt, capped below
the last minute end) to keep its stated balance. The orchestrator should confirm this
when applying it.
