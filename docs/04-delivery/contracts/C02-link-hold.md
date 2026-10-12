# C02. Link hold: the link schedule owner ↔ account owner contract

| | |
|---|---|
| Contract ID | C02 |
| Name | link-hold |
| Version | 1.0.0-draft.2 |
| Status | **Draft**, revised for re-review by [review 42](../../reviews/42-contract-C02-review.md) (REJECT of draft.1: B1, M1 to M7, m1 to m12, all applied; see "Review 42 resolution"). No mismatch is open. C4-1 to C4-4, C4-7, M-1 to M-3 and review 42's D1 to D6 are settled by binding orchestrator decisions (see "Settled"). Review 39's R39-01 (cut-target revision handling) is also applied |
| Provider | RFC-001 (link schedule owner) for the link hold port, the link waiting port, the link availability query and the link displacement read. RFC-002 (account owner) for the outcome and expiry port and the reservation command port's `cut_target` |
| Consumers | RFC-002 (account owner) consumes the RFC-001 ports. RFC-001 (link schedule owner) consumes the RFC-002 ports. Not part of C02: the partner-adapter side of the outcome and expiry port, and the reservation command port's other operations (offer, terminate, release after grace) |
| Transport | **HTTP**: gRPC over HTTP/2 for synchronous commands between NestJS owners, routed by slot through the placement cache (C01). **Kafka event**: the guaranteed relay path for the link's waiting-port notifications. The C01 runtime publishes them from the link outbox and delivers them through `onNotification`. **Database read** (RFC-000 A1, §5.5): the link displacement read of `link_displacement` inside the account owner's serialisable confirm transaction |
| Pinned to | `requirements-v1.10`. RFC-000 revision 4.4: the §8 rows (link hold port, link waiting port, outcome and expiry port, link availability query, link displacement read, reservation command port `cut_target`) and the "Revision 4.4 errata" C4-1 to C4-4 and C4-7. RFC-001 revision 5: §2, §4.1 to §4.5, §5.1, §5.4, §5.6, §7.1, §11. RFC-002 revision 5: §2.2, §2.5, §4.3, §5.1 to §5.7, §6.3, §9.6, §9.7, §12, §13. Runtime results, move hooks and `admitCommand`: C01 (platform runtime, RFC-006 revision 6 §12) |
| Binding decisions applied | C4-1, C4-2, C4-3 (as amended by review 42 D1), C4-4. C02's M-1, M-2, M-3 and the C4-1 delivery reading. Review 42's D1 to D6 and every fix it proposes. Review 39's R39-01 |

## Purpose

A route booking needs capacity on every Share link of its path. Each link's schedule
belongs to that link's schedule owner (RFC-001). The request, the reservation and every
decision about them belong to the account owner (RFC-002). C02 is everything that passes
between these two owners:

1. **Taking and ending capacity for a request.** The account owner holds capacity at a
   link, converts the hold when the request is confirmed, and releases it when the
   request ends any other way. The link reports waiting, grants, yields and
   displacements. The account owner reads the link's displacement markers inside its
   confirm transaction.
2. **Changing confirmed legs.** The account owner tells the link to end a leg or set its
   part rates (`end_leg`, `reduce_parts`), and drives equivalent-path offers (`offer_*`).
3. **Applying a permanent reduction (POL-07).** The link sends a `cut_target` for each
   reservation it cuts. The account owner composes the targets, answers in the reply, and
   applies them through leg changes.
4. **Advisory availability**, used to build route counter-offers.

C02 never moves the right to write. The link owner is the only writer of link state,
including the displacement markers. The account owner is the only writer of requests,
reservations and offers (RFC-000 A1).

## Schema

### Conventions and units

| Quantity | Type | Unit and encoding |
|---|---|---|
| Minute | `Minute` | Integer **minute index**: minutes since 1970-01-01T00:00Z (RFC-001 §2). A JSON number, always a safe integer |
| Window | `Window` | Half-open `[start, end)` in minutes. `end: null` means open-ended |
| Rate | `Mbps` | Integer **Mbps** (10⁶ bit/s), ≥ 0. A rate in a hold is ≥ `rate_min` |
| Commit or decision timestamp | `Hlc` | The database's hybrid-logical commit timestamp, as a **decimal string** `"<wall ns>.<logical 10 digits>"` (CockroachDB `cluster_logical_timestamp()`). Used for `ts`, `T_dec`, `request_age`, decision times and the reduction's record time. Compare as decimals, never as floats |
| Deadline | `EpochMs` | Integer **milliseconds** since the Unix epoch (`D`, `D_c`, ahead deadlines, `lapse_at`) |
| Duration | `DurationMs` | Integer **milliseconds** (`retry_after`) |
| Sequence, generation, epoch | `bigint` | A decimal string in JSON, `int64` in protobuf |

```ts
// ---------- Identities ----------
type LinkId = string;                       // catalogue link_id (RFC-001 §10)
type AccountPartition = string;             // account partition key, routed by C01 slotOf()
type Seq = bigint;
type Hlc = string;                          // "1791800000123456789.0000000002"
type EpochMs = number;
type DurationMs = number;
type Minute = number;
type Mbps = number;

/** (account partition, sequence) of an entry in the account log (RFC-002 §2.2). */
interface LogRef { partition: AccountPartition; seq: Seq }

type RequestId = LogRef;        // the request's E1 (intake)
type ChangeId = LogRef;         // the deciding E11 (or E13 final + E11 move) entry
type OfferId = LogRef;          // the offer's E13 "prepared" entry
type ReservationId = string;    // opaque, globally unique, assigned at E5 by the account owner
type LegId = string;            // opaque, unique within the reservation (assigned by the account owner)
type PartId = string;           // opaque, unique within the reservation (assigned by the account owner)
type ReductionSeq = Seq;        // link-log sequence of the ReductionAnnounce entry; unique per link
type Attempt = number;          // integer ≥ 1, numbered by the link only (RFC-001 §4.3)
type ClaimSeq = Seq;            // link-log sequence of the entry that raised a yield request (review 42 M1)

interface Window { start: Minute; end: Minute | null }   // [start, end)
interface Fence { generation: Seq; epoch: Seq }           // RFC-000 §5.2, AI-R6-3
/** A step function: rateMbps from `from` until the next piece's `from` (the last is open). */
interface Piece { from: Minute; rateMbps: Mbps }
interface ReductionRef { link: LinkId; reduction: ReductionSeq }

// ---------- Envelopes ----------
/** Carried by every synchronous command, in both directions (RFC-001 §11, RFC-002 §2.5,
 *  RFC-006 §12.7). When C01 publishes its common CommandEnvelope (AI-42-3), C02 imports it;
 *  the fields below must be a subset of it. */
interface CommandEnvelope {
  link: LinkId;                 // the link the command concerns
  receiverPartition: string;    // the account partition (commands to the account owner) or the link id (commands to the link)
  routedSlot: number;           // slot it was routed to (C01 route())
  routedGeneration: Seq;        // the receiver partition's generation it was routed with
  routedSlotEpoch: Seq;         // slot epoch it was routed with
  mapVersion: Seq;              // placement map version used
  senderPartition: string;      // account partition, or the link id for link-sent commands
  senderFence: Fence;           // sender partition's (generation, epoch)
  senderSeq: Seq;               // sequence of the sender's entry that decided the command (RFC-002 §13.1)
  senderIdentity: string;       // service identity (mTLS principal, RFC-005)
}
/** Every reply and every message from the link carries the link's fence and log position. */
interface LinkStamp { linkFence: Fence; linkSeq: Seq }

/** Errors any synchronous command may return, from either provider. */
type CommonError =
  | { error: 'NOT_OWNER'; holderHint?: string }       // re-route
  | { error: 'STALE_EPOCH' }                          // re-route
  | { error: 'STALE_SENDER' }                         // sender deposed: stop serving the partition
  | { error: 'UNAVAILABLE' }                          // not known to be committed: retry with the same identity
  | { error: 'MISMATCH' }                             // same identity, different content: nothing changed, alerted
  | { error: 'UNKNOWN_LINK' }                         // see Settled M-2 and review 42 M5
  | { error: 'LINK_CLOSING' }                         // hold and offer_hold only
  | { error: 'LINK_RETIRED' };
// Runtime results `Moving`, `Stopped`, `Moved(slot, generation)` are C01's; see "Timeouts and deadlines".
```

### Link hold port (RFC-001 → RFC-002; synchronous)

```ts
type HoldKind = { kind: 'booking' } | { kind: 'change'; reservation: ReservationId };

interface HoldCmd extends CommandEnvelope {
  request: RequestId; account: AccountPartition; leg: LegId; holdKind: HoldKind;
  rateMbps: Mbps; window: Window;
  deadline: EpochMs;            // D
  commitFence: EpochMs;         // D_c, taken as given, never recomputed by the link
  requestAge: Hlc;              // priority key: E1 commit timestamp; ties by request id
  wait: boolean;
  receiptMinute: Minute;        // m0, validity judged against it (RFC-001 §2)
  policyVersion: Seq;           // link-rules policy version recorded at intake
}
interface CounterOffer {
  largestRateMbps: Mbps;        // 0 means none (below rate_min)
  earliest: { window: Window } | { none: true } | { notFoundBefore: Minute };
}
type RefusalReason = 'NO_FIT' | 'IN_FLIGHT' | 'DEADLINE_PASSED' | 'TOMBSTONED'
                   | { invalid: 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' };
type HoldReply = LinkStamp & (
  | { result: 'HELD'; attempt: Attempt }
  | { result: 'WAITING'; attempt: Attempt; aheadDeadline: EpochMs }
  | { result: 'REFUSED'; reason: RefusalReason; counterOffer?: CounterOffer; retryAfterMs?: DurationMs }
  // on a repeat of a request first seen by a hold, the request's later recorded state:
  | { result: 'RELEASED' } | { result: 'CONVERTED'; part: PartId }
) | CommonError;

interface ConvertCmd extends CommandEnvelope {
  request: RequestId; attempt: Attempt; reservation: ReservationId; part: PartId;
  decisionTime: Hlc;            // T_dec, the E5 commit timestamp
}
type ConvertReply = (LinkStamp & { result: 'CONVERTED'; part: PartId })
  | { error: 'NO_HOLD' } | { error: 'TOMBSTONED' } | CommonError;   // MISMATCH: another attempt

interface ReleaseCmd extends CommandEnvelope {
  request: RequestId; deadline: EpochMs;        // D: bounds the tombstone (D + release_grace)
  reason: 'WITHDRAWN' | 'EXPIRED' | 'REJECTED' | 'FAILED' | 'ENDED';
  decisionTime: Hlc;            // the deciding entry's commit timestamp
}                               // no attempt: request-scoped
type ReleaseReply = (LinkStamp & { result: 'RELEASED'; tombstoneUntil: EpochMs }) | CommonError;

interface QueryCmd extends CommandEnvelope { request: RequestId }
type QueryReply = (LinkStamp & {
  state: 'UNSEEN' | 'HELD' | 'WAITING' | 'DISPLACED' | 'REFUSED' | 'RELEASED' | 'CONVERTED';
  attempt?: Attempt; aheadDeadline?: EpochMs;
  refusal?: { reason: RefusalReason; counterOffer?: CounterOffer; retryAfterMs?: DurationMs };
  displacedBy?: ReductionRef & { recordTime: Hlc };
  openYieldClaims?: { claim: ClaimSeq; olderRequest: RequestId }[];
  tombstoneUntil?: EpochMs;
}) | CommonError;

/** M-3: one policy cause, POL07 (a revocation is a cut to 0). Other endings keep their own causes. */
type LegChangeCause = 'CANCEL' | 'SHORTEN' | 'DECREASE' | 'RELEASE' | 'TERMINATE' | 'MOVE' | 'POL07';
interface EndLegCmd extends CommandEnvelope {
  reservation: ReservationId; leg: LegId; changeId: ChangeId;
  fromMinute: Minute;           // effective minute: every part of the leg ends from here
  cause: Exclude<LegChangeCause, 'DECREASE'>;
  applies?: ReductionRef[];     // present iff cause = 'POL07': every applied (link, reduction) (C4-4)
  decisionTime: Hlc;
}
interface ReducePartsCmd extends CommandEnvelope {
  reservation: ReservationId; leg: LegId; changeId: ChangeId;
  cause: 'DECREASE' | 'POL07';
  parts: { part: PartId; pieces: Piece[] }[];   // absolute rates, newest part first, every cause
  applies?: ReductionRef[];     // present iff cause = 'POL07'
  decisionTime: Hlc;
}
type LegChangeReply = (LinkStamp & (
  | { result: 'CHANGED' }
  | { result: 'STALE_CHANGE'; lastApplied: ChangeId }   // no effect; reachable only by a defect (review 42 D1)
)) | { error: 'UNKNOWN_RESERVATION' } | { error: 'UNKNOWN_PART' } | { error: 'UNKNOWN_REDUCTION' }
   | { error: 'INVALID'; field: 'applies' }             // applies missing with POL07, or present with another cause
   | CommonError;

interface OfferPart { part: PartId; rateMbps: Mbps; originalAge: Hlc; end: Minute | null }
interface OfferHoldCmd extends CommandEnvelope {
  offer: OfferId; reservation: ReservationId; account: AccountPartition;
  parts: OfferPart[]; fromMinute: Minute; lapseAt: EpochMs; decisionTime: Hlc;
}
type OfferHoldReply = (LinkStamp & (
  | { result: 'HELD' }
  | { result: 'REFUSED'; reason: 'NO_FIT' | 'IN_FLIGHT'; retryAfterMs?: DurationMs }
  | { result: 'REFUSED'; reason: 'TOMBSTONED' }         // offer_release already recorded (review 42 M4)
)) | CommonError;
interface OfferAcceptCmd extends CommandEnvelope { offer: OfferId; moveAt: Minute; decisionTime: Hlc }
interface OfferMoveAtCmd extends CommandEnvelope { offer: OfferId; moveAt: Minute; decisionTime: Hlc } // T
interface OfferReleaseCmd extends CommandEnvelope {
  offer: OfferId; lapseAt: EpochMs;                     // bounds the tombstone, also for an offer not seen
  reason: 'DECLINED' | 'LAPSED' | 'FAILED' | 'REFUSED_ELSEWHERE' | 'ENDED'; decisionTime: Hlc;
}
type OfferReply = (LinkStamp & ({ result: 'ACCEPTED' } | { result: 'MOVED' }
                 | { result: 'RELEASED'; tombstoneUntil: EpochMs }))
  | { error: 'UNKNOWN_OFFER' } | { error: 'TOMBSTONED' } | { error: 'INVALID' } | CommonError;
```

### Link waiting port (RFC-001 → RFC-002 notifications; RFC-002 → RFC-001 commands)

```ts
/** Point-to-point state message, link → account owner.
 *  Identity: (link, request, attempt, kind), and for YIELD_REQUEST (link, request, attempt, kind, claim). */
type WaitingNotification = LinkStamp & { link: LinkId; request: RequestId; attempt: Attempt } & (
  | { kind: 'WAITING_NOTICE'; aheadDeadline: EpochMs }       // latest remaining deadline among this link's blockers
  | { kind: 'GRANTED' }                                      // held now, at the waiter's attempt
  | { kind: 'YIELD_REQUEST'; claim: ClaimSeq; olderRequest: RequestId }   // one outstanding per (request, attempt, claim)
  | { kind: 'DISPLACED'; reduction: ReductionSeq; recordTime: Hlc;       // holds only (m12)
      fitsOnCommitted: boolean; counterOffer: CounterOffer }
  | { kind: 'WAITER_REFUSED'; reason: 'NO_FIT'; counterOffer: CounterOffer }   // tombstoned
);

interface MarkWaitingCmd extends CommandEnvelope {
  request: RequestId; waiting: boolean;
  position: Seq;                // account-log sequence of the E2 (or leaving entry) it reflects
}
type MarkWaitingReply = (LinkStamp & { result: 'APPLIED' | 'IGNORED_OLDER' }) | CommonError;
```

### Outcome and expiry port (RFC-002 → RFC-001)

The outcome notices to a link are the link hold port's `convert` and `release` (above).
The remaining operations:

```ts
interface YieldAnswerCmd extends CommandEnvelope {
  request: RequestId; attempt: Attempt;   // the attempt the YIELD_REQUEST named
  claim: ClaimSeq;                        // the claim the YIELD_REQUEST named (review 42 M1)
  answer: 'yield_accept' | 'yield_refuse';
}
interface DisplacementAcceptCmd extends CommandEnvelope {
  request: RequestId; attempt: Attempt;   // the attempt DISPLACED named
}
type AcceptReply = (LinkStamp & (
  | { result: 'ACCEPTED'; newWaiterAttempt: Attempt }   // the account owner records this attempt
  | { result: 'REFUSED_RECORDED' }                      // yield_refuse: exactly that claim ends
  | { result: 'STALE_ATTEMPT' }                         // nothing changed; the account owner queries the leg (m3)
)) | CommonError;

/** Link → account owner, sent when the link's ts passes D with a hold or waiter still present.
 *  Identity: (link, request, 'expire'). Re-sent every 1 s until the outcome arrives. */
interface ExpireIfUndecidedCmd extends CommandEnvelope { request: RequestId; deadline: EpochMs }
type ExpireIfUndecidedReply = { result: 'RECEIVED' } | CommonError;
// The answer is the outcome itself: once the deciding entry (E5, or E4/E6/E7) has committed,
// the account owner (re-)sends ConvertCmd or ReleaseCmd.

/** Settled M-1: link → account owner, an offer hold past lapse_at.
 *  Identity: (link, offer, 'lapse'). Re-sent every 1 s. */
interface OfferOutcomeIfLapsedCmd extends CommandEnvelope { offer: OfferId; lapseAt: EpochMs }
type OfferOutcomeIfLapsedReply = { result: 'RECEIVED' } | CommonError;
// The answer is OfferAcceptCmd (Final) or OfferReleaseCmd (declined, lapsed, failed), re-sent
// once the offer is decided. Nothing is sent while the offer is Accepted and its partner booking is open.
```

### Reservation command port: `cut_target` (RFC-001 → RFC-002; synchronous)

```ts
interface CutTarget {
  account: AccountPartition;    // the reservation's account partition, recorded by the link from hold/convert (M2)
  reduction: ReductionSeq;
  reservation: ReservationId;
  revision: number;             // integer ≥ 1, increasing per (link, reduction, reservation) (C4-2)
  tEff: Minute;                 // the reduction's notice end T_eff
  parts: PartId[];              // covered parts: the reservation's parts on this link at the deciding entry
  pieces: Piece[] | null;       // null = none (no cut). Otherwise pieces[0].from = tEff, strictly increasing;
                                // each rateMbps is the reservation's rate on this link; 0 revokes from that minute
  offer?: OfferId;              // set when the cut parts are an open offer's parts on this link
  decidedAt: Hlc;               // commit timestamp of the link's deciding ReductionStep
}
/** One target per call, or a batch of up to 500 for one destination account slot (m6).
 *  receiverPartition is the account partition; in a batch, each target's own `account` routes it. */
interface CutTargetCmd extends CommandEnvelope, CutTarget {}
interface CutTargetBatchCmd extends CommandEnvelope { targets: CutTarget[] }   // ≤ 500 (est.)

type CutAnswer = {
  revision: number;             // echoes the command's revision
  recordedRevision: number;     // the highest revision recorded for the key; governs the cap (R39-01)
  decisionTime: Hlc | null;     // the E11/E13 commit timestamp; null only for 'unknown'
} & (
  | { answer: 'APPLIED'; changeIds: ChangeId[] }        // [] = APPLIED(none)
  | { answer: 'NOT_APPLIED'; reason: 'ended' | 'left_link' | 'unknown' }
  | { answer: 'KEPT_FOR_OFFER'; offer: OfferId }
);
type CutTargetReply = CutAnswer | CommonError;
type CutTargetBatchReply = { replies: CutTargetReply[] } | CommonError;   // in the batch's order
```

There is no separate `cut_target_answer` command (C4-1).

### Link availability query (RFC-001 → RFC-002; synchronous read)

```ts
interface AvailabilityQuery extends CommandEnvelope { window: Window; rateMbps: Mbps }
type AvailabilityReply = (LinkStamp & { asOfSeq: Seq; offer: CounterOffer }) | CommonError;

interface FitRangesQuery extends CommandEnvelope { rateMbps: Mbps; from: Minute; until: Minute; k: number }
type FitRangesReply = (LinkStamp & {
  asOfSeq: Seq;
  ranges: Window[];             // up to k maximal ranges in [from, until) where occ_all + rate ≤ C_ref
  continueFrom: Minute | null;  // null: searched to `until`
}) | CommonError;
```

### Link displacement read (database read, RFC-000 A1)

This table is owned and written by the link owner. The account owner's role has `SELECT`
on it and on nothing else of RFC-001's (RFC-001 §7.1).

**The primary key is exactly (`link_id`, `request_part`, `request_seq`). There is no slot
column.** The table is an owner-defined projection: RFC-006 §5.5's slot-first prefix
applies to log and outbox tables only. So the account owner can always make a single-key
point read, without knowing the link's slot. Rows are not moved or rewritten when the
link's slot changes (review 42 M7).

```sql
CREATE TABLE link_displacement (
  link_id          STRING   NOT NULL,   -- the link (partition)
  request_part     STRING   NOT NULL,   -- RequestId.partition
  request_seq      INT8     NOT NULL,   -- RequestId.seq
  attempt          INT4     NOT NULL CHECK (attempt >= 1),  -- the displaced attempt
  reduction_seq    INT8     NOT NULL,   -- link-log sequence of the displacing entry
  record_hlc       DECIMAL  NOT NULL,   -- that entry's commit timestamp (HLC)
  PRIMARY KEY (link_id, request_part, request_seq)
);
-- Grants: link owner role INSERT, SELECT, DELETE (declared deletable projection);
--         account owner role SELECT only. No UPDATE by any role.

-- The account owner's read, once per Share leg, inside E5's serialisable batch transaction,
-- under a savepoint with lock_timeout = 10 ms (J-14). Its plan must be a single-key lookup:
SELECT attempt, reduction_seq, record_hlc
  FROM link_displacement
 WHERE link_id = $1 AND request_part = $2 AND request_seq = $3;
```

## Semantics

### Common rules for every synchronous command

- **Routing and fencing.** A command goes to the owner-lease holder of the receiver's
  slot. The receiver calls C01's `admitCommand(receiverPartition, senderFence, …)`, and
  answers as follows:
  - `STALE_SENDER` if `senderFence` is below the highest it has recorded for the sender's
    partition.
  - `NOT_OWNER` or `STALE_EPOCH` if it does not hold the lease at the routed epoch.
  - C01's `Moved(slot, generation)` if `routedGeneration` is not the receiver partition's
    current generation (the partition was re-slotted).
- **Answered once durable.** A reply is sent only after the batch transaction recording
  its effect has committed (durable in two regions). `UNAVAILABLE` means the effect is
  **not known to be committed** (for example, after a runtime `Ambiguous` result). The
  sender retries with the same identity, and safety rests on those identities.
- **Order at a link.** Commands for one link are applied in the link log's single total
  order. That is the order in which they reach the owner-lease holder; a retried command
  takes the place of its first applied copy. There is no order across links, and none by
  the time an account received a request (POL-05; P1-S14, P1-S77).
- **Digest.** "Same identity, different content" compares the **command body only**,
  never the `CommandEnvelope`. So a command re-sent by a new holder, with a new fence,
  routing fields or `senderSeq`, is a duplicate and not a `MISMATCH` (m4).
- **`MISMATCH`.** Nothing changes and the receiver alerts. The sender treats it as a
  protocol defect. For a request, that means treating the leg as if it had not answered
  until the expiry.

### Link hold port

| Operation | Preconditions | Outcomes | Errors |
|---|---|---|---|
| `hold` | Sent only after E1 commits, so a funds hold exists (P2-S92). No attempt is sent | The link checks, in this order (RFC-001 §4.1). (1) A request record made by a release (a tombstone): `REFUSED(TOMBSTONED)`, with no digest check. (2) A request record made by a hold: its recorded state (held, waiting, refused, `RELEASED`, `CONVERTED`), or `MISMATCH` if the body digest differs. (3) `ts ≥ D_c`: `REFUSED(DEADLINE_PASSED)`. (4) Invalid against `m0` and the policy version: `REFUSED(INVALID(rule))`. (5) No fit on `occ_firm`: `REFUSED(NO_FIT, counterOffer)`. (6) Fits on `occ_all`: `HELD(1)`. (7) Otherwise, with `wait = false`: `REFUSED(IN_FLIGHT, retryAfterMs = latest blocker's remaining deadline, counterOffer)`, with no waiter and no yields. (8) Otherwise: `WAITING(1, aheadDeadline)`, plus yield requests. **Every refusal records a tombstone until `D + release_grace` and counts as this leg's release acknowledgement** | Common errors. `UNKNOWN_LINK`, `LINK_CLOSING` and `LINK_RETIRED` record **no tombstone**. On any of them, the account owner rejects the request with `LINK_UNAVAILABLE(link)` and no counter-offer, and releases every leg (settled M-2) |
| `convert` | The account owner sends it after E5 commits. `attempt` is the attempt it recorded for the leg; a grant keeps the waiter's attempt | `CONVERTED(part)`: the hold becomes a committed part with age `T_dec`, and its marker is removed. If the hold carries a displacement mark, the part is flagged or added to the affected set, the notice is written at once, and `CONFIRMED_AFTER_REDUCTION` is alerted (P1-S63) | `NO_HOLD`, `TOMBSTONED` (violations, alerted). `MISMATCH` (another attempt). `UNKNOWN_LINK` or `LINK_RETIRED`: a violation, because a link is retired only with no holds, offer holds or parts. It is alerted and counted as answered (M5) |
| `release` | A committed outcome other than confirmed. Sent to **every** Share leg of the intake, held or not | `RELEASED` once durable. In one entry, it ends every hold, waiter registration, grant, displacement marker, yield claim and outstanding yield or displacement request of the request, whatever the attempt. It records a tombstone until `D + release_grace` and scans waiters. It does the same for a request the link has never seen | Common errors. **`UNKNOWN_LINK` or `LINK_RETIRED` in answer to `release` counts as that leg's release acknowledgement** for E8: nothing can be held on such a link (M5) |
| `query` | — | A read, with no entry. Returns the request's state at the link, its attempt, the latest blocker deadline, the refusal recorded, any displacement, its open yield claims and the tombstone expiry | Common errors |
| `end_leg` | A committed E11 (or an E13 *final* with its E11 move). `fromMinute` is never before `nb(ts)` of that entry, except for a POL-07 cut, which is effective at `T_eff`. A change known in advance is sent dated in the future. **At most one leg change is outstanding per (reservation, leg)** (see "Leg-change sequencing") | `CHANGED` once durable: every part of the leg ends from `fromMinute`, that is, the pulse `−b` over `[max(s, from), e)`. For cause `POL07`, the link records `applies`. For each of its own reductions named, it checks the covered parts against the cap from `T_eff` and alerts `CUT_TARGET_UNMET` if they exceed it. A change that arrives after `fromMinute` is applied as decided, from `fromMinute` (late change, alerted) | `UNKNOWN_RESERVATION`, `UNKNOWN_REDUCTION`: violations, alerted, except on a new leg before `offer_accept` (M3). `INVALID(applies)`. `STALE_CHANGE` (a defect, alerted). `UNKNOWN_LINK` or `LINK_RETIRED`: a violation, alerted and counted as answered |
| `reduce_parts` | As `end_leg`. The account owner names the parts: a decrease goes last in, first out, and POL-07 rates come from the §9.7 composition | `CHANGED`: each named part's rate is **set absolutely** to the pieces from their first `from`, clipped to the part's current window. It never decrements. Otherwise as `end_leg` | `UNKNOWN_PART`, `UNKNOWN_RESERVATION` (see M3), `UNKNOWN_REDUCTION`, `INVALID(applies)`, `STALE_CHANGE`. Otherwise as `end_leg` |
| `offer_hold` | E13 *prepared*. Sent only to path links that are not already legs of the reservation | (1) A recorded `offer_release` for the offer: `REFUSED(TOMBSTONED)`, checked before any fit check (M4). (2) Otherwise, decided like `wait = false` on the parts' combined step function. `HELD`: each offer part becomes a pulse over `[from, end)` in `occ_firm`, `occ_all` and `occ_commit`, with its original age. Or `REFUSED(NO_FIT \| IN_FLIGHT, retryAfterMs?)` | Common errors. `UNKNOWN_LINK`, `LINK_CLOSING`, `LINK_RETIRED`: no tombstone; the offer is Refused (M-2) |
| `offer_accept` | E13 *final*: every leg of the new path is booked (D4). On a new leg it is that leg's **first change**, and the move's `reduce_parts` waits for its `ACCEPTED` (M3) | `ACCEPTED`: from `moveAt`, the offer parts, and any cut cap on the offer, become the reservation's parts on this link with their original ages. A late arrival is applied as decided | `UNKNOWN_OFFER`, `TOMBSTONED`. `INVALID` unless `moveAt ≥ nb(decisionTime)` |
| `offer_move_at` | A further E11 for an earlier minute the holder chose | `MOVED`: the parts start at `moveAt`. A late arrival is applied as decided | `UNKNOWN_OFFER`. `INVALID` unless `nb(decisionTime) ≤ moveAt < current move_at` and `moveAt` is a minute boundary |
| `offer_release` | E13 *declined*, *lapsed* or *failed*, or a sibling offer hold was refused. **Sent to every Share leg to which `offer_hold` was sent, held or not** (M4) | `RELEASED`: the offer parts and any cut cap on them are removed from all three occupancies at once. The link records a tombstone until `lapse_at + release_grace`, also for an offer it has not seen, and scans waiters | Common errors. `UNKNOWN_LINK` or `LINK_RETIRED` counts as acknowledged (M5) |

**Port invariants** (A0R-03, enforced by the link in its apply step):
- A release ends everything the request has at the link.
- A tombstone refuses any later hold or grant for the request, or any later
  `offer_hold` for the offer, until it expires.
- No hold or grant is made at or after `D_c`, and a waiter past `D_c` is skipped.
- A refusal counts as a release acknowledgement.
- A hold ends in one of four ways only: conversion, release, an accepted yield, or an
  accepted displacement.
- `convert` is accepted for a held leg after `DISPLACED`. The leg is then flagged
  affected.
- RFC-001 retires a link only when it has no holds, offer holds or parts.

**`nb(t)`** is the first minute boundary strictly after `t`.

### Link waiting port

- **Notifications** (`WAITING_NOTICE`, `GRANTED`, `YIELD_REQUEST`, `DISPLACED`,
  `WAITER_REFUSED`) are idempotent **state messages**:
  - **Identity** is (link, request, attempt, kind). For `YIELD_REQUEST` it also includes
    the `claim`.
  - The receiver applies any identity it has not applied, however late. There is **no
    high-water rule** across identities.
  - Within one identity, only `WAITING_NOTICE` changes content, and the copy with the
    highest `linkSeq` wins.
  - A message whose attempt is below the attempt the account owner recorded for the leg
    is stale and changes nothing.
  - The account owner records the attempt carried by `HELD`, `WAITING`, `GRANTED`,
    `DISPLACED`, `WAITER_REFUSED`, the `ACCEPTED` replies and `query`. **It never numbers
    an attempt itself.**
- **Precedence within one attempt (m2).** `GRANTED`, `DISPLACED` and `WAITER_REFUSED` end
  that attempt's waiting state. A `WAITING_NOTICE` for the same attempt that arrives
  later updates the blocker deadline only if the leg is still recorded as waiting. It
  never brings a held leg back to waiting: no E2, no `mark_waiting(true)`.
- **`GRANTED`**: capacity released to a waiter is now held for it, at the waiter's
  attempt.
- **`DISPLACED`** is sent for **holds only**. A waiter that no longer fits gets
  `WAITER_REFUSED` from the scan instead (m12). `DISPLACED` is sent only after the
  reduction and its markers have committed. The link keeps the hold, still counted, until
  the account owner answers with `displacement_accept`, `release`, or (if E5 committed
  without seeing the marker) `convert`. The account owner follows RFC-002 §5.1:
  - If E5 has committed, the `convert` answers the notice.
  - If E5 is in flight, it waits for the result.
  - Otherwise it decides against the reduced capacity. If the leg no longer fits on
    committed capacity (`fitsOnCommitted = false`), it writes E7 *rejected* and sends
    `release`. If the leg still fits, it writes E3 and sends `displacement_accept`.
- **`YIELD_REQUEST`** (review 42 M1). Each yield request carries a link-assigned `claim`:
  the link-log sequence of the entry that raised it.
  - The link re-sends an unanswered request with the **same** claim. It asks again with a
    **new** claim after a refusal, when a waiting hint for the holder arrives, and when
    another older waiter needs the same holder attempt.
  - The account owner answers each claim. It accepts only while the request is in the
    Waiting phase, in its serial order: E3, then `yield_accept`. Otherwise it sends
    `yield_refuse`.
  - A refusal ends exactly the claim it names. A re-ask with a new claim is a new
    identity, so it is never swallowed as a duplicate.
- **`mark_waiting`** is advisory. The link applies it only if `position` is above the
  last one applied for the request; otherwise it answers `IGNORED_OLDER`. Setting the mark
  re-evaluates older waiters for yields. A holder without the mark is never asked to
  yield (P2-S58).
- **Reconciliation.** Every 5 s (est.), the account owner sends `query` for each request
  it has in Holding or Waiting. A lost notification is found this way, without
  re-notification.

### Outcome and expiry port

- **`yield_accept` and `displacement_accept`.** In one entry, the link removes that
  attempt's pulse (and marker) and registers the request as a waiter at attempt + 1, with
  the same age and window. It then scans waiters. The reply names `newWaiterAttempt`.
  A stale attempt or claim gets `STALE_ATTEMPT` and changes nothing; the account owner
  then sends `query` for the leg and records what it returns (m3). `yield_refuse` ends
  exactly the claim it names.
- **`expire_if_undecided`.** The link sends it when its `ts` passes `D` with a hold or
  waiter still present. It keeps the hold, alerts, and re-sends every 1 s. The account
  owner writes E6 if the request is undecided. In either case, once the deciding entry
  has committed, it sends the committed outcome: `convert` (confirmed, with `T_dec`) or
  `release`. The link never releases without an outcome.
- **`offer_outcome_if_lapsed`** (settled M-1). The link sends it when an offer hold
  outlives `lapse_at`, and keeps the offer parts. Once the offer is decided, the account
  owner answers by re-sending `offer_accept` or `offer_release`.

### Reservation command port: `cut_target`

- **When.** The link sends a target once a reservation's last part in the cut set has been
  decided. Every reservation of the affected set `A_R` gets exactly one target, `none`
  included, and so does every reservation cut only in offer parts (offer-scoped). After
  `REDUCTION_SET_EXTENDED`, a second target may follow for the same key, with a higher
  `revision`. The link sends a revision ≥ 2 only when the target is strictly lower at some
  minute, or its covered parts changed (R39-01 (c)).
- **Routing (M2).** The command's `receiverPartition` and each target's `account` are the
  reservation's account partition. The link records it from the reservation's `hold` and
  `convert`. The account owner admits the command with `admitCommand(account, …)` and
  answers `Moved` for a re-slotted account.
- **The answer is the reply (C4-1).** For a new revision, the account owner replies only
  after its E11 has committed, or its E13 for an offer-scoped target. The reply follows
  RFC-002 §9.7's case table, completed here:

  | Case | Account owner records | Reply |
  |---|---|---|
  | **Revision at or below the highest recorded for the key** (a repeat, or a stale lower revision) | **Nothing** | **The recorded reply** of the highest recorded revision, echoing the requested `revision` and carrying `recordedRevision` (R39-01) |
  | Same (key, revision), different content | Nothing | `MISMATCH`, alerted |
  | First revision for the key, or a **higher** revision; the reservation is on the link at `T_eff` | An E11 cause *cut*: the pieces, the covered parts and the composition. Leg changes are sent after the commit. **A higher revision always writes its E11**, even when the composition is unchanged | `APPLIED(changeIds)`, or `APPLIED([])` when no part's rate changes |
  | The reservation ended at or before `T_eff` | An E11 "not applied: ended" | `NOT_APPLIED(ended)` |
  | The reservation left the link by `T_eff` (a Final move with `move_at ≤ T_eff`, the link not on the new path) | An E11 "not applied: left the link" | `NOT_APPLIED(left_link)` |
  | `offer` set, offer not yet Final | E13: the target is kept against the offer, and the holder is told | `KEPT_FOR_OFFER(offer)` |
  | `offer` set, offer Final to this link | Applied as a normal cut, composed in or after the move's E11 (RFC-002 §9.6) | `APPLIED(changeIds)` |
  | `offer` set, offer ended without moving to this link (Declined, Lapsed, Failed, or Final to another path) (m8) | E13 notes it | `NOT_APPLIED(ended)`. On the link, the cap has already gone with `offer_release` |
  | Unknown reservation | Nothing | `NOT_APPLIED(unknown)`, alerted, with `decisionTime: null` |

- **Composition** (RFC-002 §9.7). The account owner composes the targets in force, which
  are the applied ones only, by `min` **per minute**:
  - Each target binds only its covered parts.
  - The oldest Mbps are kept first.
  - Every changed part's rate goes to **every** Share leg as absolute pieces, through
    `reduce_parts`, or through `end_leg` when every rate is 0 to the end. Each change
    names every applied (link, reduction) in `applies`, and follows "Leg-change
    sequencing".
  - The result does not depend on arrival order.
  - A move that becomes Final after a cut carries the cut rate (P1-S84). The move's E11
    sends `reduce_parts` to each new leg from `move_at`, naming the binding pairs. On
    each new leg, that change is sent only after the leg's `offer_accept` is answered
    `ACCEPTED` (M3).
- **What the link does with the reply** (RFC-001 §5.4). It appends a `CutAnswer` entry when
  it receives the reply, then acts on the answer:
  - `APPLIED`: the cap stays as a record.
  - `KEPT_FOR_OFFER`: the cap moves with `offer_accept`, or goes with `offer_release`.
  - `NOT_APPLIED(ended | left_link)`: the cap is withdrawn once the leg's `end_leg` has
    been applied there.
  - `NOT_APPLIED(unknown)`: the cap is withdrawn at once, and `CUT_NOT_APPLIED` is
    alerted.
  - The reply with the highest `recordedRevision` governs the cap.
  - `MISMATCH`: the link records it as the reply, alerts, and **stops re-sending** that
    key and revision (m3).
- **Revisions (C4-2, R39-01).** Each revision of a key may only lower the target, minute by
  minute. The account owner applies only a revision **higher** than the highest it has
  recorded. If a higher revision has a piece above the recorded target at some minute,
  that minute is ignored and alerted. A revision at or below the recorded one writes
  nothing and gets the recorded reply.
- **Deposed sender.** The account owner answers `STALE_SENDER` when the link's fence is
  below the highest it has recorded for that link (a deposed link owner).
- **Not a runtime notification (m5).** `cut_target` is not written as a C01
  `notifications` row, so the changefeed never relays a copy. The link's re-send timer
  reads the unanswered targets from link state: a decided target with no `CutAnswer` at
  its revision.

### Link availability query

`availability(window, rate)` returns two things, both computed beside committed **and
held** capacity (`occ_all`): the largest rate that fits over `window`, and the earliest
window of the requested length that fits `rate` within the horizon.
`fit_ranges(rate, from, until, k)` returns up to `k` maximal fit ranges and where to
continue.

Both are reads of the owner's latest committed generation:
- They are advisory: not decisions, and not log entries.
- `asOfSeq` names the generation they were read from.
- Their cost is bounded in steps (`counteroffer_steps`), never in time.
- They disclose nothing about other accounts, reservations or traffic (P1-S17).

The account owner takes the minimum of the legs' largest rates and intersects their fit
ranges (P2-S73).

### Link displacement read

| Result | Meaning | Account owner must |
|---|---|---|
| Row present, whatever its `attempt` | A reduction committed at a lower timestamp displaced the hold, so the request **had not begun committing** (POL-07, P1-S78). A marker is deleted in the entry that ends its attempt, so a present row is always for the link's current hold attempt | Not write E5 in this transaction. Handle the leg as `DISPLACED` (RFC-002 §5.1), even if a partner confirm was already sent. If `attempt` differs from the recorded attempt, also alert and `query` the leg (m1) |
| Absent | No reduction displaced the hold below this transaction's timestamp | Confirm. A later displacement is ordered after the confirm, and the link applies RFC-001 §4.4's affected-on-convert exception |
| Lock timeout (10 ms) on an intent | A capacity-lowering transaction is in flight | Roll back the savepoint and defer **only this E5** to the next batch (J-14) |

**Why the order is exact.** Both transactions touch the marker key, so the database's
serialisable order decides between them. The link:
- writes markers only in the displacing entry's own transaction, placeholder intents
  first;
- deletes a marker in the entry that ends the displaced attempt;
- never overwrites a marker, and never moves one.

## Delivery and ordering

| Flow | Delivery | Effect | Ordering scope |
|---|---|---|---|
| Account owner → link commands (`hold`, `convert`, `release`, leg changes, `offer_*`, `mark_waiting`, `yield_*`, `displacement_accept`) | At least once: re-sent with the same identity until answered, and re-routed through the placement cache (RFC-002 §5.1, §12.1 step 4) | Exactly once, by the identities below | The link log's total order per link. **Per (reservation, leg): one outstanding leg change at a time, in increasing change-id order**, with `offer_accept` as a new leg's first change. Per request: `mark_waiting` by `position`. Nothing across links |
| Link → account owner notifications | At least once: a gRPC push after commit, and the C01 runtime's Kafka relay from the link outbox as the guaranteed path. The relay is keyed by the destination account partition | Exactly once per identity | **None**: applied whenever new, with no high-water rule, subject to the per-attempt precedence (m2) |
| `expire_if_undecided`, `offer_outcome_if_lapsed` | At least once: re-sent every 1 s while the condition holds | Idempotent: E6 at most once per request | None |
| `cut_target` | At least once: **re-sent by the link until it records the reply** (C4-1), including after a takeover (C01 `onAdopt` re-arms the timer from link state). Not relayed through Kafka | Exactly once per (link, reduction, reservation, revision). Only a higher revision is applied (R39-01) | None needed: the per-minute `min` and the revision rule make the result order-independent |
| Link displacement read | A read inside the confirm transaction | — | The database's serialisable order |
| Availability queries | Best effort; retried freely | No effect | — |

### Leg-change sequencing (review 42 B1, D1; amends C4-3's effect)

**Sending rule.** For each (reservation, leg), the account owner keeps **at most one leg
change (`end_leg` or `reduce_parts`) outstanding**. It sends the next change for that leg,
which has a higher change id, only after the previous one is answered: `CHANGED`, a
counted-as-answered error, or `STALE_CHANGE`.
- Change ids stay increasing: each is the deciding entry's (account partition, sequence).
- Several changes may be queued per leg, one behind the other.
- Coalescing into one gRPC call (up to 500 commands) stays allowed **across** legs, never
  for two changes of one leg.
- On a new leg of a move, `offer_accept` is the leg's first change, and the move's
  `reduce_parts` follows only after `ACCEPTED`.
- **After a takeover**, the new holder re-sends the E11s without an E12 **per leg, in
  change-id order**, with the same one-outstanding rule.

**Link rule (unchanged).** For each (reservation, leg), the link keeps the highest change
id it has applied:
- A higher id is applied.
- An equal id gets the recorded reply, or `MISMATCH` if the body differs.
- A lower id gets `STALE_CHANGE` and has **no effect**.
- A change id from a partition other than the reservation's owner gets `MISMATCH`.

**`STALE_CHANGE` now signals a defect.** Under the sending rule, a lower id can reach the
link only after its successor has been applied, and the successor is sent only after the
lower one was answered. So a correct sender never meets `STALE_CHANGE`. If it does, it:
- alerts `STALE_CHANGE` as a protocol defect, naming the leg and both ids;
- counts the change as answered for E12, so the leg's queue is not stuck;
- does not retry.

The alert is how the operator finds the occupancy the lost change would have freed.

**Why the rule is needed** (traces from review 42 B1). A leg change names only the parts
it changes, from its own first minute. So a higher change id does not contain the state
set by a lower one, and an overtaken change would be lost for good:
- **P2-S43 / P2-S44 (cancel or shorten, then a cut).** R is open-ended on L, with parts p1
  and p2. E11a (seq 100) sends `end_leg(from 12:00)` and meets `Moving`. E11b (seq 101),
  a cut target from another link, sets `reduce_parts(p1: [(T_eff, 2)])`.
  - Without the rule, E11b could reach L first, and E11a's re-send would get
    `STALE_CHANGE`. L would keep p1 at 2 Mbps and p2 at its full rate after 12:00, for
    ever, while the buyer is told the capacity is free.
  - With the rule, E11b is not sent until E11a is answered. L ends the leg at 12:00, then
    applies E11b, which changes nothing after 12:00.
- **P2-S48 (a decrease, then a cut, or a cut, then a decrease).** The same holds. The
  decrease's LIFO parts are set before the cut's covered parts, or the reverse, each on
  the state the other left. "From 10:01 its capacity … is available to other buyers"
  holds on L as reported. `CUT_TARGET_UNMET` is checked on the cut's own change.

## Idempotency

| Operation | Key | On a duplicate | Same key, different body | Retention |
|---|---|---|---|---|
| `hold` | (link, request) | The recorded state (held, waiting, refused with its counter-offer, released, converted) | `MISMATCH`, alerted | The life of the request + 24 h (`link_request` row, TTL 24 h after `D`). A request record made by a release answers `TOMBSTONED` before any digest check |
| `convert` | (link, request) | `CONVERTED` again | Another attempt: `MISMATCH` | As `hold` |
| `release` | (link, request) | Acknowledged again | Not applicable (the latest `D` bounds the tombstone) | As `hold` |
| `end_leg`, `reduce_parts` | (link, change id) | The recorded reply | `MISMATCH` | The leg's life on the link. The highest applied id is kept per (reservation, leg) |
| `offer_hold`, `offer_accept`, `offer_release` | (link, offer), per command kind | The recorded reply. `offer_release` is recorded even for an offer not seen | `MISMATCH` | Until `lapse_at + release_grace`, then the offer record |
| `offer_move_at` | (link, offer, minute) | `MOVED` again | Not applicable | As the offer |
| `mark_waiting` | (link, request, position) | `IGNORED_OLDER` or `APPLIED` | Not applicable | As `hold` |
| `yield_accept`, `yield_refuse` | (link, request, attempt, **claim**, kind) | The recorded reply, naming the same `newWaiterAttempt` | Not applicable | As `hold` |
| `displacement_accept` | (link, request, attempt, kind) | The recorded reply, naming the same `newWaiterAttempt` | Not applicable | As `hold` |
| Waiting-port notifications | (link, request, attempt, kind), plus the **claim** for `YIELD_REQUEST` | Dropped. For `WAITING_NOTICE`, the copy with the highest `linkSeq` wins | Not applicable | Account owner: while the request is undecided, and in E2, E3 or E7 where an entry records it |
| `expire_if_undecided` | (link, request, "expire") | Answered again with the outcome | Not applicable | Until the outcome is applied |
| `offer_outcome_if_lapsed` | (link, offer, "lapse") | Answered again | Not applicable | Until the outcome is applied |
| `cut_target` | (link, reduction, reservation, **revision**) | A revision at or below the highest recorded gets the recorded reply and writes nothing (R39-01) | `MISMATCH`, alerted; the link stops re-sending | The life of the reservation |

## Ownership

| State | Writer | Readers |
|---|---|---|
| Link log, occupancy, holds, waiters, yield claims, tombstones, request records, caps, `CutAnswer` entries, `link_displacement` markers, the account partition recorded per reservation | Link schedule owner (RFC-001) only | The account owner reads `link_displacement` **only**, by SQL `SELECT` in its confirm transaction. It sees everything else only through this contract's replies, `query` and the availability query |
| Requests, attempts as recorded, E1 to E14, reservations and their parts' current rates, offers, cut-target records and composition, per-leg change queues | Account owner (RFC-002) only | The link, only through this contract's commands and replies |
| Attempt numbers and claim sequences | Assigned by the link. The account owner records and echoes them | Both |
| Change ids, offer ids, part ids, reservation ids | Assigned by the account owner | Both |
| Reduction ids (`ReductionSeq`), revisions | Assigned by the link | Both |

## Timeouts and deadlines

| Item | Value | Owner and effect |
|---|---|---|
| `D`, `D_c` | Per request: `D_c = D − commit_margin` with a partner leg, `D − τ` otherwise (`τ` about 420 ms, capped near 450 ms) | No hold or grant at or after `D_c`. Senders retry commands only within the request's deadline |
| `release_grace` | 1 min (POL-04, POL-26) | Tombstones live until `D + release_grace`. Every Share-link hold of an unconfirmed request is gone within `release_grace` after `D` (P2-S104, P2-S114) |
| `ack_budget` | 200 ms p99 | The edge's answer bound. Not a C02 timeout |
| Expiry request re-send | 1 s | Link, from `ts ≥ D` while the hold is kept |
| Waiting reconciliation | `query` every 5 s (est.) | Account owner, for each request in Holding or Waiting |
| Displacement read lock timeout | 10 ms (est.), under a savepoint | Account owner. On a timeout, only that E5 is deferred (J-14) |
| Capacity-lowering transaction | Abandoned if not at `COMMIT` within 250 ms (est.), then re-proposed | Link (RFC-001 §5.1) |
| `cut_target` re-send | Until the reply is recorded, with backoff (est. 1 s) | Link |
| `cut_target` batching and flow control (m6) | Up to 500 targets per call per destination account slot. At most 64 calls in flight per destination slot (both est.). A deep reduction sends about 17,000 targets/s for about a minute (RFC-002 §9.7, est.) | Link. After a takeover, `onAdopt` re-arms the unanswered targets under the same cap |
| Leg-change and outcome re-sends | Until answered, with backoff | Account owner (RFC-002 §5.7, §12.1). One outstanding change per (reservation, leg); up to 500 commands per call across legs |
| Move's `reduce_parts` on a new leg (M3) | Sent only after that leg's `offer_accept` is answered `ACCEPTED` | Account owner. If it still meets `UNKNOWN_RESERVATION` or `UNKNOWN_PART`: while that leg's `offer_accept` is unanswered, it waits and re-sends after `ACCEPTED`. Otherwise it alerts, stops, and counts the change as answered. So it is re-sent at most once after `ACCEPTED` |
| `offer_window`, `move_deadline` | Policy and design parameters (RFC-002 §9.6) | Account owner. The link never releases an offer hold on its own |

**Runtime results and hooks (C01; not redefined here).**
- `Moving` and `Moved`: refresh the placement cache and re-send with the same identity.
- `Stopped`: nothing commits. The sender treats it as `UNAVAILABLE` and retries within
  the deadline.
- On C01 `onAdopt` of a link partition, the new holder re-arms:
  - expiry requests for holds past `D`;
  - lapse backstops;
  - unanswered `cut_target` re-sends;
  - outstanding `YIELD_REQUEST`s, keeping their claims.
- On C01 `onAdopt` of an account partition, the new holder:
  - re-arms the reconciliation timers;
  - re-sends per RFC-002 §12.1, with leg changes per leg in change-id order.
- `onMovedOut` cancels those timers.

## Versioning and compatibility

- **Package `c02.v1`.** The protobuf services `LinkHoldPort`, `LinkWaitingPort`,
  `OutcomeExpiryPort`, `ReservationCommandPort.CutTarget` (single and batch) and
  `LinkAvailability` are generated from the types above. Field names map one to one.
  - `CommandEnvelope` becomes an import from C01 once C01 defines it (AI-42-3), without a
    wire change as long as C01's fields include these.
- **Additive changes** are a minor version:
  - new optional fields;
  - new reply variants that the receiver may treat as a protocol violation (alerted, as
    for `MISMATCH`).

  Receivers ignore unknown optional fields. Neither side may make a new field required
  within v1.
- **Breaking changes** need `c02.v2`, served side by side. They include:
  - a changed identity or idempotency key;
  - a changed unit;
  - a removed field;
  - a new required field;
  - a new error that the sender must act on;
  - a change to the leg-change sequencing, change-id or revision rules.

  Senders move to v2 only after every receiver serves it.
- **The displacement table.** It is versioned with the link owner's migrations. Columns
  are only added, and the primary key and the three read columns never change while v1 is
  served.
- **Coordination.** Any change to the `cut_target` reply set, to `STALE_CHANGE` semantics,
  or to the one-outstanding rule is a C4-level decision. RFC-001 and RFC-002 then change
  together.

## Scenarios relied on (`requirements-v1.10`)

- **Hold, order, wait and refuse.** P1-S05, P1-S07, P1-S08, P1-S09, P1-S10, P1-S11,
  P1-S12, P1-S13, P1-S14, P1-S77, P1-S70, P1-S34, P1-S15, P1-S16, P1-S17, P1-S37, P1-S38,
  P1-S39, P1-S73, P1-S18, P1-S19, P1-S20, P1-S74, P1-S22. P2-S02, P2-S15, P2-S16, P2-S17,
  P2-S18, P2-S20, P2-S21, P2-S52, P2-S59, P2-S61, P2-S73, P2-S92, P2-S95, P2-S112,
  P2-S116.
- **Yields.** P2-S19, P2-S58, P2-S60, P2-S87, P2-S88, P2-S97.
- **Release, expiry and tombstones.** P1-S54, P1-S62, P2-S14, P2-S93, P2-S104, P2-S106,
  P2-S107, P2-S110, P2-S114, P2-S22.
- **Displacement.** P1-S24, P1-S41, P1-S42, P1-S63, P1-S78.
- **Leg changes.** P1-S46, P1-S72. P2-S43, P2-S44, P2-S45, P2-S46, P2-S47, P2-S48,
  P2-S74, P2-S79, P2-S80, P2-S81, P2-S84, P2-S85, P2-S94.
- **POL-07 cuts and moves.** P1-S31, P1-S32, P1-S35, P1-S36, P1-S43, P1-S44, P1-S45,
  P1-S47, P1-S52, P1-S53, P1-S55, P1-S56, P1-S57, P1-S59, P1-S60, P1-S61, P1-S64, P1-S65,
  P1-S68, P1-S71, P1-S79, P1-S82, **P1-S84** (new in v1.10: a move that becomes final
  after the cut carries the cut rate). No RFC cites P1-S84 yet (erratum, M6 (g)).
- **Not covered by a scenario yet** (review 42 RQ-42-1, RQ-42-2, proposed to
  requirements):
  - `LINK_UNAVAILABLE(link)`;
  - a yield re-asked of a holder that refused while it was not waiting.

## Conformance tests

**Provider side: the link owner (RFC-001)**, run against a recorded account-owner stub.

1. **`hold` decision table.** One case per check of RFC-001 §4.1:
   - a record made by a release is refused `TOMBSTONED` with no digest check, while a
     held-then-released request returns `RELEASED`;
   - `ts ≥ D_c`;
   - V1 to V6 against `m0`, including P1-S74's calendar cases;
   - `NO_FIT` versus `IN_FLIGHT` versus `WAITING` (P1-S12, P1-S70, P1-S73).

   Every refusal is re-queried and shows a tombstone.
2. **Arrival order** (P1-S77). Holds from two accounts arrive in the reverse of their
   receipt order, and the link's verdicts follow arrival. A re-sent hold returns its
   first verdict.
3. **Idempotency.**
   - For every operation, a duplicate returns the recorded reply.
   - The same identity with a changed body returns `MISMATCH` and changes nothing.
   - The same body with a changed envelope (new fence, routing fields, `senderSeq`) is a
     duplicate.
   - After the in-memory record is dropped, a repeat is answered from `link_request`.
4. **Attempts.**
   - A grant keeps the attempt.
   - `yield_accept` and `displacement_accept` reply attempt + 1.
   - `convert` with another attempt returns `MISMATCH`.
   - A stale attempt or claim returns `STALE_ATTEMPT`.
5. **Yield claims (M1).**
   1. The link raises a yield request with claim c1, and the holder refuses.
   2. The holder's mark is set.
   3. The link re-asks with a new claim c2, which is accepted.

   The cycle breaks (P2-S19, P2-S87). `yield_refuse(c1)` ends only c1.
6. **Change-id order.** For `end_leg` and `reduce_parts` of each cause:
   - a lower id after a higher one returns `STALE_CHANGE`, with occupancy unchanged;
   - absolute pieces are clipped to the part's window.
7. **`applies` (C4-4, m7).** For `end_leg` and `reduce_parts`:
   - cause `POL07` without `applies` returns `INVALID(applies)`, and nothing is applied;
   - `applies` with another cause returns `INVALID(applies)`;
   - a pair naming an unknown own reduction returns `UNKNOWN_REDUCTION`;
   - covered parts above the cap raise `CUT_TARGET_UNMET`.
8. **`cut_target` sender (C4-1, C4-2, R39-01, m5, m6).**
   - One target per reservation of `A_R`, including `none` and offer-scoped targets. Each
     carries the reservation's account partition.
   - Each target is re-sent from link state until a reply is recorded, including across a
     takeover, and is never a runtime notification row.
   - A revision ≥ 2 is sent only if the target is strictly lower at some minute, or its
     covered parts changed.
   - Each reply variant moves the cap as Semantics states. The highest `recordedRevision`
     governs.
   - `MISMATCH` stops the re-sends.
   - Batches hold at most 500 targets, with at most 64 calls in flight per destination
     slot.
9. **Displacement markers (M7).**
   - The capacity-lowering transaction lays its intents first.
   - A marker is never overwritten.
   - A marker is deleted by convert, release or accepted displacement.
   - The point read's plan is a single-key lookup on (`link_id`, `request_part`,
     `request_seq`).
   - A link move leaves the rows untouched.
   - The concurrent-confirm race (T-12) is ordered exactly by the database.
10. **Offers (M4).**
    - The combined step-function check.
    - `INVALID` boundaries for `offer_accept` and `offer_move_at` against
      `nb(decisionTime)`.
    - A late `offer_accept` is applied as decided.
    - `offer_release` removes the parts and their cap.
    - Release before hold: a later `offer_hold` is refused `TOMBSTONED`.
    - The lapse backstop is sent, and the parts are kept.
11. **Expiry.** A hold past `D` is kept, `expire_if_undecided` is re-sent every 1 s, and
    the link converts or releases on the answer.
12. **Notifications.**
    - A `GRANTED` lost on push and relayed late is still applied downstream.
    - Identity is stable across relay and push.
    - `DISPLACED` is never sent for a waiter.

**Consumer side: the account owner (RFC-002)**, run against a recorded link stub.

1. **Attempts.** It records the attempt from every message kind, never numbers one, and
   drops stale attempts. On `STALE_ATTEMPT`, it queries the leg.
2. **No high-water rule.**
   - A late `GRANTED` is applied.
   - Duplicate notifications are no-ops.
   - `query` reconciliation finds a dropped `DISPLACED`.
   - A `WAITING_NOTICE(a)` that arrives after `GRANTED(a)` causes no E2 and no
     `mark_waiting(true)` (m2).
   - A yield re-ask with a new claim is answered (M1).
3. **Leg-change sequencing (B1).**
   - Two E11s for one leg are never in flight together, including across a takeover.
   - Different legs are coalesced.
   - A `STALE_CHANGE` is alerted as a defect, counted as answered, and not retried.
4. **`cut_target` reply (C4-1, C4-2, R39-01).**
   - For a new revision, the reply is sent only after the E11 or E13 commits.
   - Every row of the case table is covered, including the offer Final-here and
     offer-ended rows.
   - A repeat of the same revision, or revision 1 arriving after revision 2, gets the
     recorded reply and writes nothing.
   - A higher revision with equal content still writes its E11 (`APPLIED([])`).
   - A piece above the recorded target is ignored and alerted.
   - A link fence below the recorded one gets `STALE_SENDER`.
   - A target for a re-slotted account gets `Moved`.
5. **Composition.**
   - Two links and two reductions, in either arrival order, give the same part rates
     (S16, T15).
   - Only covered parts are bound.
   - An offer-scoped target is applied only at Final.
   - A move made Final after a cut sends `reduce_parts` at the cut rate, after
     `ACCEPTED` (P1-S84, M3).
   - Every leg change names every applied pair.
6. **Displacement read.**
   - A present row, whatever its attempt, means no E5. An attempt that does not match is
     alerted and the leg is queried.
   - A 10 ms lock timeout defers only that E5.
   - A row present after a partner confirm was sent still blocks E5 (P1-S78).
7. **Release fan-out.**
   - Every Share leg of the intake gets `release`, whether held or not.
   - A `REFUSED` or `WAITER_REFUSED` counts as that leg's release acknowledgement for E8.
   - `UNKNOWN_LINK` or `LINK_RETIRED` in answer to `release` counts as acknowledged, so
     E8 completes (M5).
8. **Unavailable link (M-2).**
   - `UNKNOWN_LINK`, `LINK_CLOSING` or `LINK_RETIRED` on `hold` produces E7 *rejected*
     `LINK_UNAVAILABLE(link)` with no counter-offer, then `release` to every leg.
   - On `offer_hold`, the offer is Refused.
9. **Offers (M4, M-1).**
   - `offer_release` goes to every leg that was sent `offer_hold`, including one whose
     reply was lost.
   - `offer_outcome_if_lapsed` is answered by re-sending `offer_accept` or
     `offer_release` once the offer is decided, and by nothing while the offer is open.
10. **Expiry answer.** On `expire_if_undecided`, E6 is written only if the request is
    undecided. The answer is `convert` or `release`, sent after the commit.

**Joint tests.** A replay of recorded traces through both real owners covers:
- P1-S78, rows 1 to 3.
- P2-S19 and P2-S87 (crossing and cycle), including a refuse-then-re-ask.
- P1-S52 with accept, decline and a failed partner leg.
- P1-S84 row 2, with `reduce_parts` delivered before `offer_accept` (M3).
- **Shorten then cut on one leg, with the first call answered `Moving`: the link ends the
  leg at 12:00** (B1, P2-S43/S44).
- A decrease and a cut on one leg, in both orders (P2-S48).
- P2-S104, with the decision record unavailable at `D`.

## Settled

No mismatch is open. Each point below is settled by a binding orchestrator decision and
applied in this contract. The errata bring the RFCs into line; no RFC is edited by this
contract.

| # | Point | Settled form | Errata |
|---|---|---|---|
| C4-1 | How a cut target is answered and delivered | The answer is the synchronous reply to `cut_target`: `APPLIED(change ids \| none)`, `NOT_APPLIED(ended \| left_link \| unknown)` or `KEPT_FOR_OFFER(offer)`, given once E11 or E13 commits. There is no `cut_target_answer`. The link **re-sends `cut_target` from link state until it records the reply**, including after a takeover. It is not a runtime notification. A re-send is idempotent by (link, reduction, reservation, revision) | RFC-000 §8 (drop `cut_target_answer` from the link hold port row). RFC-001 §5.4, §7.1 (`link_outbox` no longer carries `cut_target`), §11 (`CutAnswer` recorded from the reply; drop the `cut_target_answer` row; re-send replaces the Kafka relay). RFC-002 §2.5, §9.7 (the answer is the reply, not a notification) |
| C4-2 and R39-01 | Target revision | `cut_target` carries `revision`, which increases per key and may only lower the target. The reply echoes it and carries `recordedRevision`. A revision at or below the highest recorded gets the recorded reply and writes nothing. Only a higher revision is applied, and it always writes its E11. The link sends a revision ≥ 2 only when the target is strictly lower at some minute, or its covered parts changed | RFC-000 §8 (reservation command port row: idempotent by key **and revision**). RFC-002 §9.7, §13.1 ("repeat" means the same (key, revision); a higher revision always writes its E11). RFC-001 §5.4 (when a revision ≥ 2 is sent) |
| C4-3, as amended by review 42 D1 | Leg-change order | The account owner keeps **at most one leg change outstanding per (reservation, leg)** and sends the next, higher change id only after the previous one is answered; after a takeover, it re-sends per leg in change-id order. On a new leg, `offer_accept` counts as the first change. The link still refuses a lower id with `STALE_CHANGE` and no effect, but that is now reachable only by a defect: alerted, counted as answered, not retried | RFC-000 §8 (link hold port row: replace "so a lost, repeated or reordered change never leaves a leg at a rate the composition did not give" with the one-outstanding rule, AI-42-1). RFC-002 §9.7 ("Ordering and idempotency"), §12.1 step 4, §13.2 (`end_leg` too) |
| C4-4 | `end_leg` POL-07 pairs | `applies` names every applied (link, reduction). It is present if and only if the cause is `POL07`; otherwise the link answers `INVALID(applies)` | RFC-001 §11.1 `end_leg` row |
| C4-7 | Runtime hooks and results | Taken from C01 and referenced under Timeouts | RFC-001 and RFC-002, per RFC-000 4.4 |
| M-1 | Lapse backstop for an offer hold | `offer_outcome_if_lapsed(offer)` on the outcome and expiry port, identity (link, offer, "lapse"). The account owner answers by re-sending `offer_accept` or `offer_release` once the offer is decided. The link keeps the offer parts until then | RFC-002 §13.1 (outcome and expiry port). **RFC-001 §5.6 and §11.1**: the link sends it (new row) |
| M-2, with review 42 M5 | `UNKNOWN_LINK`, `LINK_CLOSING`, `LINK_RETIRED` | On `hold` and `offer_hold`, the link records **no tombstone**. The account owner rejects the request with **`LINK_UNAVAILABLE(link)`** and no counter-offer, and sends the request-scoped `release` to every leg; for an offer, the offer is Refused. `UNKNOWN_LINK` or `LINK_RETIRED` in answer to `release` or `offer_release` counts as that leg's acknowledgement. RFC-001 retires a link only with no holds, offer holds or parts, so `convert` and leg changes meeting it are violations: alerted and counted as answered | RFC-002 §5.1 (answer table), §2.2 (E7 reason `LINK_UNAVAILABLE`), §13.2 (errors, E8 acknowledgement). **RFC-001 §11** (no tombstone on these errors; retirement precondition; answers to `release`). Requirements RQ-42-1 |
| M-3 | The cause for a POL-07 revocation | One cause, `POL07`, with the applied (link, reduction) pairs required: a revocation is a cut to 0. Endings outside the policy (cancel, shorten, end of window, release after grace, operator termination, move) keep their own causes | RFC-001 §11.1 (`end_leg` causes: drop `revoke`). **RFC-002 §9.7** (drop "(RFC-001's "revoke")") |
| Review 42 M1 (D2) | Yield claims | A link-assigned `claim` in `YIELD_REQUEST`, in `yield_accept`/`yield_refuse`, and in both identities. A refusal ends exactly that claim, and a re-ask uses a new claim | RFC-001 §4.3, §11.1 (waiting port rows). RFC-002 §5.3, §13.2. Requirements RQ-42-2 |
| Review 42 M2 | Routing of commands to an account partition | The envelope carries `receiverPartition`, `routedGeneration` and `senderSeq`. `cut_target` carries the reservation's account partition, which the link records from `hold` and `convert`. Receivers call `admitCommand(receiverPartition, …)` and answer `Moved` on a generation mismatch | RFC-001 §11 (common command fields; record the account per reservation). RFC-002 §2.5, §13.1. C01 or RFC-006 §12.7: one shared `CommandEnvelope` (AI-42-3) |
| Review 42 M3 (D3) | The move's `reduce_parts` on a new leg | Sent only after that leg's `offer_accept` is `ACCEPTED`. An `UNKNOWN_RESERVATION` or `UNKNOWN_PART` reply is re-sent once after `ACCEPTED`; otherwise it is alerted and the change stops | RFC-002 §9.6 (Final row, B-RQ-11 paragraph), §12 (S18) |
| Review 42 M4 (D4) | Stranded offer holds | `offer_release` goes to every leg that was sent `offer_hold`, and is recorded even for an offer not seen. `offer_hold` is refused `TOMBSTONED` after a release | RFC-002 §9.6 ("Prepared" and "Failed" rows). RFC-001 §5.6, §11.1 (`offer_hold` reply, `offer_release` for an unseen offer) |
| Review 42 M6 | The errata list | This table, completed with: (a) **RFC-000 §8**, a C4 freeze note (revision 4.5): the link hold port, link waiting port and reservation command port rows defer to C02 v1, dropping `cut_target_answer`, adding the revision, using the one-outstanding wording, and limiting `DISPLACED` to holds (AI-42-2); (b) RFC-002 §2.5: `yield_accept`, `displacement_accept`, the expiry answer and the cut answer are synchronous commands or replies, not outbox notifications, and `expire_if_undecided` arrives as a gRPC command, not through `onNotification`; (c) RFC-002 §13.2: a marker is never replaced, so drop "a later displacement of a re-granted attempt replaces it"; (d) to (f) the M-1, M-2 and M-3 rows above; (g) **P1-S84** is cited in RFC-001 (§5.6, §13 traceability) and RFC-002 (§9.6, §9.7, traceability), with the move's `reduce_parts` stated in RFC-002 §9.6; (h) the B1, M3 and M4 rows above (RFC-002 §9.6, §9.7, §12.1) | As listed |
| Review 42 M7 | Displacement table key | The primary key is exactly (`link_id`, `request_part`, `request_seq`), with no slot column. Rows are never moved or rewritten by a link move | RFC-001 §7.1 (state the key; projections are exempt from the slot-first prefix). RFC-006 §5.5 (the convention applies to log and outbox tables only) |

## Review 42 resolution

| Finding | Severity | Resolution in draft.2 |
|---|---|---|
| B1 | Blocker | Applied as D1. "Leg-change sequencing" adds the one-outstanding rule per (reservation, leg), the takeover re-send order, and `STALE_CHANGE` as an alerted defect. The P2-S43/S44/S48 traces are stated. Consumer test 3 and two joint tests added. Settled C4-3 amended. Errata: RFC-000 §8 (AI-42-1), RFC-002 §9.7, §12.1, §13.2 |
| M1 | Major | Applied as D2. `ClaimSeq` added to `YIELD_REQUEST`, `YieldAnswerCmd`, both identities and `query`. Provider test 5 and consumer test 2 added |
| M2 | Major | Applied. The envelope gains `receiverPartition`, `routedGeneration` and `senderSeq`, and the routing rules call `admitCommand(receiverPartition, …)` and answer `Moved`. `cut_target` gains `account`. Consumer test 4 adds the `Moved` case |
| M3 | Major | Applied as D3. The move's `reduce_parts` follows `ACCEPTED`, with bounded handling of `UNKNOWN_*` (a timeout row). Joint test added |
| M4 | Major | Applied as D4. `offer_release` goes to every leg sent `offer_hold` and is recorded for an unseen offer. `OfferHoldReply` gains `REFUSED(TOMBSTONED)`. Tests added |
| M5 | Major | Applied as D5. `UNKNOWN_LINK` or `LINK_RETIRED` in answer to `release` or `offer_release` counts as acknowledged. The retirement precondition is stated. Consumer test 7 extended |
| M6 | Major | Applied. The Settled table's Errata column is completed with (a) to (h) and a row of its own |
| M7 | Major | Applied. The slot-prefix sentence is removed, and the key and no-move rule are stated. Provider test 9 extended |
| m1 | Minor | Applied. A present row blocks E5 whatever its attempt; a mismatching attempt is alerted and the leg queried |
| m2 | Minor | Applied. Per-attempt precedence added to the waiting port |
| m3 | Minor | Applied. `STALE_ATTEMPT` leads to a `query`. A `cut_target` `MISMATCH` is recorded and its re-sends stop |
| m4 | Minor | Applied. The digest covers the body only. The tombstone check uses RFC-001's wording |
| m5 | Minor | Applied. `cut_target` is not a runtime notification; it is re-sent from link state |
| m6 | Minor | Applied as D6. `CutTargetBatchCmd` takes up to 500 targets, with at most 64 calls in flight per destination slot (est.) |
| m7 | Minor | Applied. `INVALID(applies)` added to `LegChangeReply`. The gRPC `INVALID_ARGUMENT` wording is removed |
| m8 | Minor | Applied. Case-table rows added for an offer that is Final here, and for one that ended without moving here |
| m9 | Minor | Applied. `UNAVAILABLE` means "not known to be committed; retry with the same identity" |
| m10 | Minor | Applied. P1-S10, P1-S34 and P1-S22 listed. P1-S84 traceability is an erratum (M6 (g)) |
| m11 | Minor | Applied. `senderSeq` added to the envelope |
| m12 | Minor | Applied. `DISPLACED` is for holds only, and a waiter gets `WAITER_REFUSED`. RFC-000 §8 erratum, M6 (a) |
| RQ-42-1, RQ-42-2 | Requirements | Proposed for the requirements, not decided here. Noted under Scenarios |
| AI-42-1 to AI-42-3 | Architecture | Carried as errata in the Settled table (RFC-000 §8 freeze note, shared envelope in C01) |
| R39-01 (review 39) | Blocker (C03) | Applied to C02's side. A revision at or below the recorded one gets the recorded reply and writes nothing; only a higher revision is applied, and it always writes its E11; `recordedRevision` is in the reply; the provider rule for sending a revision ≥ 2 is stated |
