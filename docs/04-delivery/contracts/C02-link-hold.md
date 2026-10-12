# C02. Link hold: the link schedule owner ↔ account owner contract

| | |
|---|---|
| Contract ID | C02 |
| Name | link-hold |
| Version | 1.0.0-draft.1 |
| Status | **Draft**, for contract review. No mismatch is open: C4-1 to C4-4, C4-7 and M-1 to M-3 are settled by binding orchestrator decisions (see "Settled") |
| Provider | RFC-001 (link schedule owner) for the link hold port, link waiting port, link availability query and link displacement read. RFC-002 (account owner) for the outcome and expiry port and the reservation command port's `cut_target` |
| Consumers | RFC-002 (account owner) of the RFC-001 ports. RFC-001 (link schedule owner) of the RFC-002 ports. The partner-adapter side of the outcome and expiry port, and the reservation command port's other operations (offer, terminate, release after grace), are not part of C02 |
| Transport | **HTTP**: gRPC over HTTP/2 for synchronous commands between NestJS owners, routed by slot through the placement cache (C01). **Kafka event**: the guaranteed relay path for point-to-point notifications (waiting-port notifications), which the C01 runtime publishes from the sender's outbox and delivers through `onNotification`. **Database read** (RFC-000 A1, §5.5): the link displacement read of `link_displacement` inside the account owner's serialisable confirm transaction |
| Pinned to | `requirements-v1.10`; RFC-000 revision 4.4 (§8 rows: link hold port, link waiting port, outcome and expiry port, link availability query, link displacement read, reservation command port `cut_target`; "Revision 4.4 errata" C4-1 to C4-4, C4-7); RFC-001 revision 5 (§2, §4.1 to §4.5, §5.1, §5.4, §5.6, §7.1, §11); RFC-002 revision 5 (§2.2, §2.5, §4.3, §5.1 to §5.7, §6.3, §9.6, §9.7, §12, §13). Runtime results and move hooks: C01 (platform runtime, RFC-006 revision 6 §12) |
| Binding decisions applied | C4-1, C4-2, C4-3, C4-4; C02 M-1, M-2, M-3 and the C4-1 delivery reading (orchestrator) |

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
   part rates (`end_leg`, `reduce_parts`), and handles equivalent-path offers
   (`offer_*`).
3. **Applying a permanent reduction (POL-07).** The link sends a `cut_target` for each
   reservation it cuts. The account owner composes the targets, answers in the reply, and
   applies them through leg changes.
4. **Advisory availability** for building route counter-offers.

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
| Commit / decision timestamp | `Hlc` | The database's hybrid-logical commit timestamp, as a **decimal string** `"<wall ns>.<logical 10 digits>"` (CockroachDB `cluster_logical_timestamp()`). Used for `ts`, `T_dec`, `request_age`, decision times and the reduction's record time. Compare as decimals, never as floats |
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

interface Window { start: Minute; end: Minute | null }   // [start, end)
interface Fence { generation: Seq; epoch: Seq }           // RFC-000 §5.2, AI-R6-3
/** A step function: rateMbps from `from` until the next piece's `from` (the last is open). */
interface Piece { from: Minute; rateMbps: Mbps }
interface ReductionRef { link: LinkId; reduction: ReductionSeq }

// ---------- Envelopes ----------
/** Carried by every synchronous command, in both directions (RFC-001 §11, RFC-002 §2.5). */
interface CommandEnvelope {
  link: LinkId;                 // the link the command concerns
  routedSlot: number;           // slot it was routed to (C01 route())
  routedSlotEpoch: Seq;         // slot epoch it was routed with
  mapVersion: Seq;              // placement map version used
  senderPartition: string;      // account partition, or the link id for link-sent commands
  senderFence: Fence;           // sender partition's (generation, epoch)
  senderIdentity: string;       // service identity (mTLS principal, RFC-005)
}
/** Every reply and every message from the link carries the link's fence and log position. */
interface LinkStamp { linkFence: Fence; linkSeq: Seq }

/** Errors any synchronous command may return, from either provider. */
type CommonError =
  | { error: 'NOT_OWNER'; holderHint?: string }       // re-route
  | { error: 'STALE_EPOCH' }                          // re-route
  | { error: 'STALE_SENDER' }                         // sender deposed: stop serving the partition
  | { error: 'UNAVAILABLE' }                          // nothing committed; retry within the deadline
  | { error: 'MISMATCH' }                             // same identity, different content: nothing changed, alerted
  | { error: 'UNKNOWN_LINK' }
  | { error: 'LINK_CLOSING' }                         // hold and offer_hold only; see Settled M-2
  | { error: 'LINK_RETIRED' };                        // see Settled M-2
// Runtime results `Moving`, `Stopped`, `Moved` are C01's; see "Timeouts and deadlines".
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
  // on a repeat, also the request's later recorded state:
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
  attempt?: Attempt; aheadDeadline?: EpochMs; refusal?: { reason: RefusalReason; counterOffer?: CounterOffer; retryAfterMs?: DurationMs };
  displacedBy?: ReductionRef & { recordTime: Hlc };
  tombstoneUntil?: EpochMs;
}) | CommonError;

type LegChangeCause = 'CANCEL' | 'SHORTEN' | 'DECREASE' | 'RELEASE' | 'TERMINATE' | 'MOVE' | 'POL07';
interface EndLegCmd extends CommandEnvelope {
  reservation: ReservationId; leg: LegId; changeId: ChangeId;
  fromMinute: Minute;           // effective minute: every part of the leg ends from here
  cause: Exclude<LegChangeCause, 'DECREASE'>;
  applies?: ReductionRef[];     // required iff cause = 'POL07': every applied (link, reduction) (C4-4)
  decisionTime: Hlc;
}
interface ReducePartsCmd extends CommandEnvelope {
  reservation: ReservationId; leg: LegId; changeId: ChangeId;
  cause: 'DECREASE' | 'POL07';
  parts: { part: PartId; pieces: Piece[] }[];   // absolute rates, newest part first, every cause
  applies?: ReductionRef[];     // required iff cause = 'POL07'
  decisionTime: Hlc;
}
type LegChangeReply = (LinkStamp & (
  | { result: 'CHANGED' }
  | { result: 'STALE_CHANGE'; lastApplied: ChangeId }   // acknowledged, no effect (C4-3)
)) | { error: 'UNKNOWN_RESERVATION' } | { error: 'UNKNOWN_PART' } | { error: 'UNKNOWN_REDUCTION' }
   | CommonError;

interface OfferPart { part: PartId; rateMbps: Mbps; originalAge: Hlc; end: Minute | null }
interface OfferHoldCmd extends CommandEnvelope {
  offer: OfferId; reservation: ReservationId; account: AccountPartition;
  parts: OfferPart[]; fromMinute: Minute; lapseAt: EpochMs; decisionTime: Hlc;
}
type OfferHoldReply = (LinkStamp & (
  | { result: 'HELD' }
  | { result: 'REFUSED'; reason: 'NO_FIT' | 'IN_FLIGHT'; retryAfterMs?: DurationMs }
)) | CommonError;
interface OfferAcceptCmd extends CommandEnvelope { offer: OfferId; moveAt: Minute; decisionTime: Hlc }
interface OfferMoveAtCmd extends CommandEnvelope { offer: OfferId; moveAt: Minute; decisionTime: Hlc } // T
interface OfferReleaseCmd extends CommandEnvelope {
  offer: OfferId; reason: 'DECLINED' | 'LAPSED' | 'FAILED' | 'REFUSED_ELSEWHERE' | 'ENDED'; decisionTime: Hlc;
}
type OfferReply = (LinkStamp & ({ result: 'ACCEPTED' } | { result: 'MOVED' }
                 | { result: 'RELEASED'; tombstoneUntil: EpochMs }))
  | { error: 'UNKNOWN_OFFER' } | { error: 'TOMBSTONED' } | { error: 'INVALID' } | CommonError;
```

### Link waiting port (RFC-001 → RFC-002 notifications; RFC-002 → RFC-001 commands)

```ts
/** Point-to-point state message, link → account owner. Identity: (request, attempt, kind). */
type WaitingNotification = LinkStamp & { link: LinkId; request: RequestId; attempt: Attempt } & (
  | { kind: 'WAITING_NOTICE'; aheadDeadline: EpochMs }       // latest remaining deadline among this link's blockers
  | { kind: 'GRANTED' }                                      // held now, at the waiter's attempt
  | { kind: 'YIELD_REQUEST'; olderRequest: RequestId }       // at most one outstanding per (request, attempt)
  | { kind: 'DISPLACED'; reduction: ReductionSeq; recordTime: Hlc;
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
The rest:

```ts
interface YieldAnswerCmd extends CommandEnvelope {
  request: RequestId; attempt: Attempt;   // the attempt the YIELD_REQUEST named
  answer: 'yield_accept' | 'yield_refuse';
}
interface DisplacementAcceptCmd extends CommandEnvelope {
  request: RequestId; attempt: Attempt;   // the attempt DISPLACED named
}
type AcceptReply = (LinkStamp & (
  | { result: 'ACCEPTED'; newWaiterAttempt: Attempt }   // the account owner records this attempt
  | { result: 'REFUSED_RECORDED' }                      // yield_refuse: the claim ends
  | { result: 'STALE_ATTEMPT' }                         // nothing changed
)) | CommonError;

/** Link → account owner, sent when the link's ts passes D with a hold or waiter still present.
 *  Identity: (link, request, 'expire'). Re-sent every 1 s until the outcome arrives. */
interface ExpireIfUndecidedCmd extends CommandEnvelope { request: RequestId; deadline: EpochMs }
type ExpireIfUndecidedReply = { result: 'RECEIVED' } | CommonError;
// The answer is the outcome itself: the account owner (re-)sends ConvertCmd or ReleaseCmd
// once the deciding entry (E5, or E6/E7/E4) has committed.

/** Settled M-1 (RFC-002 erratum): link → account owner, an offer hold past lapse_at.
 *  Identity: (link, offer, 'lapse'). Re-sent every 1 s. */
interface OfferOutcomeIfLapsedCmd extends CommandEnvelope { offer: OfferId; lapseAt: EpochMs }
type OfferOutcomeIfLapsedReply = { result: 'RECEIVED' } | CommonError;
// The answer is OfferAcceptCmd (final) or OfferReleaseCmd (declined, lapsed, failed),
// re-sent once decided; nothing while the offer is Accepted and its partner booking is open.
```

### Reservation command port: `cut_target` (RFC-001 → RFC-002; synchronous)

```ts
interface CutTargetCmd extends CommandEnvelope {
  // senderPartition = the link; senderFence = the link's (generation, epoch)
  reduction: ReductionSeq;
  reservation: ReservationId;
  revision: number;             // integer ≥ 1, increasing per (link, reduction, reservation) (C4-2)
  tEff: Minute;                 // the reduction's notice end T_eff
  parts: PartId[];              // covered parts: the reservation's parts on this link at the deciding entry
  pieces: Piece[] | null;       // null = none (no cut). Otherwise pieces[0].from = tEff, strictly increasing,
                                // each rateMbps the reservation's rate on this link; 0 revokes from that minute
  offer?: OfferId;              // set when the cut parts are an open offer's parts on this link
  decidedAt: Hlc;               // commit timestamp of the link's deciding ReductionStep
}
type CutTargetReply = ({ revision: number; decisionTime: Hlc | null } & (   // echoes the command's revision
  | { answer: 'APPLIED'; changeIds: ChangeId[] }      // [] = APPLIED(none)
  | { answer: 'NOT_APPLIED'; reason: 'ended' | 'left_link' | 'unknown' }
  | { answer: 'KEPT_FOR_OFFER'; offer: OfferId }
)) | CommonError;               // decisionTime: the E11/E13 commit timestamp; null only for 'unknown'
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

Owned and written by the link owner. The account owner's role has `SELECT` on this table
and on nothing else of RFC-001's (RFC-001 §7.1). The physical key prefix, (slot,
partition) with the link as partition, follows the substrate conventions (C01).

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
-- under a savepoint with lock_timeout = 10 ms (J-14):
SELECT attempt, reduction_seq, record_hlc
  FROM link_displacement
 WHERE link_id = $1 AND request_part = $2 AND request_seq = $3;
```

## Semantics

### Common rules for every synchronous command

- **Routing and fencing.** A command goes to the owner-lease holder of the receiver's
  slot. The receiver refuses `STALE_SENDER` if `senderFence` is below the highest it has
  recorded for that partition. It answers `NOT_OWNER` or `STALE_EPOCH` if it does not
  hold the lease at the routed epoch. Both owners check incoming commands with C01's
  `admitCommand`.
- **Answered once durable.** A reply is sent only after the batch transaction recording
  its effect has committed (durable in two regions). `UNAVAILABLE` means nothing was
  committed.
- **Order at a link.** Commands for one link are applied in the link log's single total
  order. That is the order in which they reach the owner-lease holder, and a retried
  command takes the place of its first applied copy. There is no order across links and
  none by account receipt time (POL-05; P1-S14, P1-S77).
- **`MISMATCH`.** Same identity with different content changes nothing and is alerted.
  The sender treats it as a protocol defect: for a request, as if the leg had not
  answered until the expiry.

### Link hold port

| Operation | Preconditions | Outcomes | Errors |
|---|---|---|---|
| `hold` | Sent only after E1 commits, so a funds hold exists (P2-S92). No attempt is sent | The link applies, in order: a release tombstone → `REFUSED(TOMBSTONED)`; an existing record → that recorded state, or `MISMATCH` if the digest differs; `ts ≥ D_c` → `REFUSED(DEADLINE_PASSED)`; invalid against `m0` and the policy version → `REFUSED(INVALID(rule))`; no fit on `occ_firm` → `REFUSED(NO_FIT, counterOffer)`; fits on `occ_all` → `HELD(1)`; otherwise, if `wait = false` → `REFUSED(IN_FLIGHT, retryAfterMs = latest blocker's remaining deadline, counterOffer)` with no waiter and no yields; otherwise → `WAITING(1, aheadDeadline)` plus yield requests (RFC-001 §4.1). **Every refusal records a tombstone until `D + release_grace` and counts as this leg's release acknowledgement** | common. `UNKNOWN_LINK`, `LINK_CLOSING` and `LINK_RETIRED` record **no tombstone**. The account owner then rejects the request with `LINK_UNAVAILABLE(link)` and no counter-offer, and releases every leg (settled M-2) |
| `convert` | The account owner sends it after E5 commits. `attempt` is the attempt it recorded for the leg. A grant keeps the waiter's attempt | `CONVERTED(part)`: the hold becomes a committed part with age `T_dec`, and its marker is removed. If the hold carries a displacement mark, the part is flagged or added to the affected set, the notice is written at once, and `CONFIRMED_AFTER_REDUCTION` is alerted (P1-S63) | `NO_HOLD`, `TOMBSTONED` (violations, alerted); `MISMATCH` (another attempt) |
| `release` | A committed outcome other than confirmed. Sent to **every** Share leg of the intake, held or not | `RELEASED` once durable. In one entry it ends every hold, waiter registration, grant, displacement marker and outstanding yield or displacement request of the request, whatever the attempt, records a tombstone until `D + release_grace`, and scans waiters. This also applies to a request the link has never seen | common |
| `query` | — | The request's state at the link, its attempt, the latest blocker deadline, the refusal it recorded, any displacement, and the tombstone expiry. A read, with no entry | common |
| `end_leg` | A committed E11 (or an E13 *final* with its E11 move). `fromMinute` is never before `nb(ts)` of that entry, except a POL-07 cut, which is effective at `T_eff`. A change known in advance is sent dated in the future | `CHANGED` once durable: every part of the leg ends from `fromMinute`, so the pulse `−b` is applied over `[max(s, from), e)`. For cause `POL07`, the link records `applies`. For each of its own reductions named, it checks the covered parts against the cap from `T_eff` and alerts `CUT_TARGET_UNMET` if they exceed it. A change that arrives after `fromMinute` is applied as decided, from `fromMinute` (late change, alerted) | `UNKNOWN_RESERVATION`, `UNKNOWN_REDUCTION` (violations, alerted); `STALE_CHANGE` (see ordering) |
| `reduce_parts` | As `end_leg`. The account owner names the parts: decreases go last in, first out, and POL-07 rates come from the §9.7 composition | `CHANGED`: each named part's rate is **set absolutely** to the pieces from their first `from`, clipped to the part's current window. It never decrements. Otherwise as `end_leg` | `UNKNOWN_PART`, `UNKNOWN_REDUCTION`; `STALE_CHANGE` |
| `offer_hold` | E13 *prepared*. Sent only to path links that are not already legs of the reservation | Decided like `wait = false` on the parts' combined step function. `HELD`: each offer part becomes a pulse over `[from, end)` in `occ_firm`, `occ_all` and `occ_commit`, with its original age. `REFUSED(NO_FIT \| IN_FLIGHT, retryAfterMs?)` | common |
| `offer_accept` | E13 *final*: every leg of the new path is booked (D4) | `ACCEPTED`: from `moveAt`, the offer parts and any cut cap on the offer become the reservation's parts on this link, with their original ages. A late arrival is applied as decided | `UNKNOWN_OFFER`, `TOMBSTONED`; `INVALID` unless `moveAt ≥ nb(decisionTime)` |
| `offer_move_at` | A further E11 for an earlier minute chosen by the holder | `MOVED`: the parts start at `moveAt`. A late arrival is applied as decided | `UNKNOWN_OFFER`; `INVALID` unless `nb(decisionTime) ≤ moveAt < current move_at` and `moveAt` is a minute boundary |
| `offer_release` | E13 *declined*, *lapsed* or *failed*, or a sibling offer hold refused | `RELEASED`: the offer parts and any cut cap on them are removed from all three occupancies at once. Tombstoned until `lapse_at + release_grace`. Waiters are scanned | common |

**Port invariants** (A0R-03, enforced by the link in its apply step):
- A release ends everything the request has at the link.
- A tombstone refuses any later hold or grant for the request until it expires.
- No hold or grant is made at or after `D_c`, and a waiter past `D_c` is skipped.
- A refusal is a release acknowledgement.
- Only a release, an accepted yield or an accepted displacement ends a hold other than its
  conversion.
- `convert` is accepted for a held leg after `DISPLACED`. The leg is then flagged as
  affected.

**`nb(t)`** is the first minute boundary strictly after `t`.

### Link waiting port

- **Notifications** (`WAITING_NOTICE`, `GRANTED`, `YIELD_REQUEST`, `DISPLACED`,
  `WAITER_REFUSED`) are idempotent **state messages**:
  - Identity is (request, attempt, kind).
  - The receiver applies any identity it has not applied, however late, with **no
    high-water rule** across identities.
  - Within one identity, only `WAITING_NOTICE` changes content. The copy with the highest
    `linkSeq` wins.
  - A message whose attempt is below the attempt the account owner recorded for the leg
    is stale and changes nothing.
  - The account owner records the attempt that `HELD`, `WAITING`, `GRANTED`, `DISPLACED`,
    `WAITER_REFUSED`, the `ACCEPTED` replies and `query` carry. **It never numbers an
    attempt itself.**
- **`GRANTED`**: capacity released to a waiter is now held for it, at the waiter's
  attempt.
- **`DISPLACED`**: sent only after the reduction and its markers have committed. The link
  keeps the hold, still counted, until the account owner answers with
  `displacement_accept`, `release`, or (if E5 committed without seeing the marker)
  `convert`. The account owner's handling follows RFC-002 §5.1:
  - E5 committed: `convert` answers it.
  - E5 in flight: await the result.
  - Otherwise, decide against the reduced capacity. If the leg no longer fits on
    committed capacity (`fitsOnCommitted = false`), write E7 *rejected* and send `release`.
    If it still fits, write E3 and send `displacement_accept`.
- **`YIELD_REQUEST`**: the link re-sends it until it is answered or the waiter's state
  changes. The account owner accepts only while the request is in the Waiting phase, in
  its serial order (E3, then `yield_accept`). Otherwise it sends `yield_refuse`.
- **`mark_waiting`**: advisory. The link applies it only if `position` is above the last
  applied for the request (`IGNORED_OLDER` otherwise). Setting the mark re-evaluates older
  waiters for yields. A holder without the mark is never asked to yield (P2-S58).
- **Reconciliation**: the account owner sends `query` every 5 s (est.) for every request
  it has in Holding or Waiting, so a lost notification is found without re-notification.

### Outcome and expiry port

- **`yield_accept` / `displacement_accept`**: in one entry, the link removes that
  attempt's pulse (and marker), registers the request as a waiter at attempt + 1 with the
  same age and window, and scans. The reply names `newWaiterAttempt`. A stale attempt
  returns `STALE_ATTEMPT` and changes nothing. `yield_refuse` ends the waiter's yield
  claim.
- **`expire_if_undecided`**: the link sends it when its `ts` passes `D` with a hold or
  waiter still present. It keeps the hold, alerts, and re-sends every 1 s. The account
  owner writes E6 if the request is undecided. In either case, once the deciding entry has
  committed, it sends the committed outcome as `convert` (confirmed, with `T_dec`) or as
  `release`. The link never releases without an outcome.
- **`offer_outcome_if_lapsed`** (settled M-1): the link sends it when an offer
  hold outlives `lapse_at`. It keeps the offer parts. The account owner answers by
  re-sending `offer_accept` or `offer_release` once the offer is decided.

### Reservation command port: `cut_target`

- **When.** The link sends a target once a reservation's last part in the cut set has been
  decided. Exactly one target goes to every reservation of the affected set `A_R`, `none`
  included, and to every reservation cut only in offer parts (offer-scoped). A second,
  lower target with a higher `revision` may follow, for the same key, after
  `REDUCTION_SET_EXTENDED`.
- **Answer = the reply (C4-1).** The account owner replies only once its E11, or its E13
  for an offer-scoped target, has committed. The reply comes from RFC-002 §9.7's case
  table:

  | Case | Account owner records | Reply |
  |---|---|---|
  | First target for the key (or a new revision), the reservation on the link at `T_eff` | E11 cause *cut*: pieces, covered parts and composition. Leg changes are sent after commit | `APPLIED(changeIds)`, or `APPLIED([])` when no part's rate changes |
  | Same (key, revision), same content | Nothing | The recorded reply again |
  | Same (key, revision), different content | Nothing | `MISMATCH`, alerted |
  | Reservation ended at or before `T_eff` | E11 "not applied: ended" | `NOT_APPLIED(ended)` |
  | Reservation left the link by `T_eff` (a Final move with `move_at ≤ T_eff`, the link not on the new path) | E11 "not applied: left the link" | `NOT_APPLIED(left_link)` |
  | `offer` set, offer not yet Final | E13: target kept against the offer; holder told | `KEPT_FOR_OFFER(offer)` |
  | Unknown reservation | Nothing | `NOT_APPLIED(unknown)`, alerted; `decisionTime: null` |

- **Composition** (RFC-002 §9.7). The account owner takes the targets in force (only
  applied ones) and composes them by `min` **per minute**:
  - Each target binds only its covered parts.
  - The oldest Mbps are kept first.
  - Every changed part's rate goes to **every** Share leg as absolute pieces, through
    `reduce_parts`, or through `end_leg` when every rate is 0 to the end. Each names every
    applied (link, reduction) in `applies`.
  - The result does not depend on arrival order.
  - A move that becomes Final after a cut carries the cut rate: the move's E11 sends
    `reduce_parts` to the new legs from `move_at`, naming the binding pairs (P1-S84).
- **The link on each reply** (RFC-001 §5.4). The link appends a `CutAnswer` entry on
  receipt:
  - `APPLIED`: the cap stays as a record.
  - `KEPT_FOR_OFFER`: the cap moves with `offer_accept` or goes with `offer_release`.
  - `NOT_APPLIED(ended | left_link)`: the cap is withdrawn once the leg's `end_leg` has
    been applied there.
  - `NOT_APPLIED(unknown)`: the cap is withdrawn at once and `CUT_NOT_APPLIED` is alerted.
  - When replies to several revisions of one key are recorded, the reply to the
    **highest** revision governs the cap.
- **Revisions (C4-2).** Each revision of a key may only lower the target, minute by
  minute. A revision whose piece is above the recorded one at some minute is ignored at
  that minute and alerted. A lower revision received after a higher one is recorded; it
  leaves the per-minute `min` unchanged, and its reply follows the case table.
- **Rejected by the account owner** with `STALE_SENDER` when the link's fence is below the
  highest recorded for that link (a deposed link owner).

### Link availability query

`availability(window, rate)` returns the largest rate over `window`, beside
committed **and held** capacity (`occ_all`), and the earliest window of the requested
length at `rate` within the horizon. `fit_ranges(rate, from, until, k)` returns up to `k`
maximal fit ranges and where to continue. Both are reads of the owner's latest committed
generation:
- Advisory, not decisions, and not log entries.
- `asOfSeq` names the generation they were read from.
- The cost of each query is bounded in steps (`counteroffer_steps`), never in time.
- Neither discloses other accounts, reservations or traffic (P1-S17).

The account owner takes the minimum of the legs' largest rates and intersects their fit
ranges (P2-S73).

### Link displacement read

| Result | Meaning | Account owner must |
|---|---|---|
| Row present and `attempt` = the attempt recorded for the leg | A reduction committed at a lower timestamp displaced the hold. The request **had not begun committing** (POL-07, P1-S78) | Not write E5 in this transaction. Handle the leg as `DISPLACED` (§5.1 of RFC-002), even if a partner confirm was already sent |
| Row present for an earlier attempt | Already answered by `displacement_accept` | Ignore it |
| Absent | No reduction displaced the hold below this transaction's timestamp | Confirm. A later displacement is ordered after the confirm, and the link applies §4.4's affected-on-convert exception |
| Lock timeout (10 ms) on an intent | A capacity-lowering transaction is in flight | Roll back the savepoint and defer **only this E5** to the next batch (J-14) |

**Why the order is exact.** Both transactions touch the marker key, so the database's
serialisable order decides it. The link writes markers only in the displacing entry's
own transaction (placeholder intents first). It deletes them in the entry that ends the
displaced attempt. It never overwrites a marker.

## Delivery and ordering

| Flow | Delivery | Effect | Ordering scope |
|---|---|---|---|
| Account owner → link commands (`hold`, `convert`, `release`, leg changes, `offer_*`, `mark_waiting`, `yield_*`, `displacement_accept`) | At least once: re-sent with the same identity until answered, re-routed through the placement cache (RFC-002 §5.1; recovery §12.1 step 4) | Exactly once, by the identities below | The link log's total order per link. Per (reservation, leg), **change-id order** (C4-3). Per request, `mark_waiting` by `position`. Nothing across links |
| Link → account owner notifications | At least once: gRPC push after commit, and the C01 runtime's Kafka relay from the link outbox as the guaranteed path. The relay is keyed by the destination account partition | Exactly once per identity (request, attempt, kind) | **None**: applied whenever new, with no high-water rule |
| `expire_if_undecided`, `offer_outcome_if_lapsed` | At least once: re-sent every 1 s while the condition holds | Idempotent: E6 at most once per request | None |
| `cut_target` | At least once: **re-sent by the link until it records the reply** (C4-1). It is an outbox row of the deciding step, re-armed by the link's new holder (C01 `onAdopt`). Under C4-1 the Kafka relay is not its delivery path | Exactly once per (link, reduction, reservation, revision). Order-independent by per-minute `min` | None needed; revisions of one key only lower |
| Link displacement read | A read inside the confirm transaction | — | The database's serialisable order |
| Availability queries | Best effort; retried freely | No effect | — |

**Change-id order (C4-3).** The change id is the deciding entry's (account partition,
sequence). For each (reservation, leg), the link keeps the highest change id it has
applied:
- A higher id is applied.
- An equal id returns the recorded reply (`MISMATCH` if the content differs).
- A **lower id** gets `STALE_CHANGE` and has **no effect**. This applies to `end_leg` and
  `reduce_parts` alike, of any cause.

The account owner counts `STALE_CHANGE` as that leg's acknowledgement in E12 and **must not
retry** the change. Because rates are absolute, a lost, repeated or reordered change never
leaves a leg at a rate the composition did not give. A change id from a partition other
than the reservation's owner is answered `MISMATCH`.

## Idempotency

| Operation | Key | Duplicate | Same key, different content | Retention |
|---|---|---|---|---|
| `hold` | (link, request) | The recorded state (held, waiting, refused with its counter-offer, released, converted) | `MISMATCH`, alerted | Life of the request + 24 h (`link_request` row, TTL 24 h after `D`). A release tombstone answers `TOMBSTONED` before any digest check |
| `convert` | (link, request) | `CONVERTED` again | Another attempt: `MISMATCH` | As `hold` |
| `release` | (link, request) | Acknowledged again | n/a (latest `D` bounds the tombstone) | As `hold` |
| `end_leg`, `reduce_parts` | (link, change id) | The recorded reply | `MISMATCH` | The leg's life on the link. The last applied id is kept per (reservation, leg) |
| `offer_hold`, `offer_accept`, `offer_release` | (link, offer) per command kind | The recorded reply | `MISMATCH` | Until `lapse_at + release_grace`, then the offer record |
| `offer_move_at` | (link, offer, minute) | `MOVED` again | n/a | As offer |
| `mark_waiting` | (link, request, position) | `IGNORED_OLDER` / `APPLIED` | n/a | As `hold` |
| `yield_accept`, `yield_refuse`, `displacement_accept` | (link, request, attempt, kind) | The recorded reply, naming the same `newWaiterAttempt` | n/a | As `hold` |
| Waiting-port notifications | (link, request, attempt, kind) | Dropped (for `WAITING_NOTICE`, highest `linkSeq` wins) | n/a | Account owner: while the request is undecided, and in E2/E3/E7 where an entry records it |
| `expire_if_undecided` | (link, request, "expire") | Re-answered with the outcome | n/a | Until outcome applied |
| `offer_outcome_if_lapsed` | (link, offer, "lapse") | Re-answered | n/a | Until outcome applied |
| `cut_target` | (link, reduction, reservation, **revision**) | The recorded reply | `MISMATCH`, alerted | Life of the reservation |

## Ownership

| State | Writer | Readers |
|---|---|---|
| Link log, occupancy, holds, waiters, tombstones, request records, caps, `CutAnswer` entries, `link_displacement` markers | Link schedule owner (RFC-001) only | The account owner reads `link_displacement` **only**, by SQL `SELECT` in its confirm transaction. Everything else through this port's replies, `query` and the availability query |
| Requests, attempts as recorded, E1 to E14, reservations and their parts' current rates, offers, cut-target records and composition | Account owner (RFC-002) only | The link, only through commands and replies of this contract |
| Attempt numbers | Assigned by the link; recorded and echoed by the account owner | Both |
| Change ids, offer ids, part ids, reservation ids | Assigned by the account owner | Both |
| Reduction ids (`ReductionSeq`), revisions | Assigned by the link | Both |

## Timeouts and deadlines

| Item | Value | Owner and effect |
|---|---|---|
| `D`, `D_c` | Per request (`D_c = D − commit_margin` with a partner leg, `D − τ` otherwise; `τ` about 420 ms, capped near 450 ms) | No hold or grant at or after `D_c`. Senders retry commands only within the request's deadline |
| `release_grace` | 1 min (POL-04/POL-26) | Tombstones live until `D + release_grace`. Every Share-link hold of an unconfirmed request is gone within `release_grace` after `D` (P2-S104, P2-S114) |
| `ack_budget` | 200 ms p99 | Edge answer bound. Not a C02 timeout |
| Expiry request re-send | 1 s | Link, from `ts ≥ D` while the hold is kept |
| Waiting reconcile | `query` every 5 s (est.) | Account owner, for each request in Holding or Waiting |
| Displacement read lock timeout | 10 ms (est.), under a savepoint | Account owner. On timeout, only that E5 is deferred (J-14) |
| Capacity-lowering transaction | Abandoned if not at `COMMIT` in 250 ms (est.), then re-proposed | Link (RFC-001 §5.1) |
| `cut_target` re-send | Until the reply is recorded, with backoff (est. 1 s) | Link |
| Leg-change and outcome re-sends | Until acknowledged, with backoff | Account owner (RFC-002 §5.7, §12.1). Leg commands may be coalesced, up to 500 per gRPC call, each keeping its own change id |
| `offer_window`, `move_deadline` | Policy and design parameters (RFC-002 §9.6) | Account owner. The link never releases an offer hold on its own |

**Runtime results and hooks (C01; not redefined here).**
- `Moving` and `Moved`: refresh the placement cache and re-send with the same identity.
- `Stopped`: nothing commits. The sender treats it as `UNAVAILABLE` and retries within
  the deadline.
- On C01 `onAdopt` of a link partition, the new holder re-arms:
  - expiry requests for holds past `D`,
  - lapse backstops,
  - unanswered `cut_target` re-sends,
  - outstanding `YIELD_REQUEST`s.
- On C01 `onAdopt` of an account partition, the new holder re-arms reconcile timers and
  re-sends per RFC-002 §12.1.
- `onMovedOut` cancels those timers.

## Versioning and compatibility

- **Package `c02.v1`.** The protobuf services `LinkHoldPort`, `LinkWaitingPort`,
  `OutcomeExpiryPort`, `ReservationCommandPort.CutTarget` and `LinkAvailability` are
  generated from the types above, and field names map one to one.
- **Additive changes** are a minor version: new optional fields, and new reply variants
  that the receiver may treat as a protocol violation (alerted, as `MISMATCH`). Receivers
  ignore unknown optional fields. Neither side may make a new field required within v1.
- **Breaking changes** need `c02.v2`, served side by side. They include:
  - a changed identity or idempotency key,
  - a changed unit,
  - a removed field,
  - a new required field,
  - a new error that the sender must act on,
  - a change to the change-id or revision ordering rule.

  Senders move to v2 only after every receiver serves it. The link displacement read's
  table is versioned with the link owner's migrations: columns are only added, and the
  four read columns are never renamed while v1 is served.
- **Coordination.** Any change to the `cut_target` reply set, or to `STALE_CHANGE`
  semantics, is a C4-level decision. RFC-001 and RFC-002 must change together.

## Scenarios relied on (`requirements-v1.10`)

- **Hold, order, wait and refuse.** P1-S05, P1-S07, P1-S08, P1-S09, P1-S11, P1-S12,
  P1-S13, P1-S14, P1-S77, P1-S70, P1-S15, P1-S16, P1-S17, P1-S37, P1-S38, P1-S39, P1-S73,
  P1-S18, P1-S19, P1-S20, P1-S74; P2-S02, P2-S15, P2-S16, P2-S17, P2-S18, P2-S20, P2-S21,
  P2-S52, P2-S59, P2-S61, P2-S73, P2-S92, P2-S95, P2-S112, P2-S116.
- **Yields.** P2-S19, P2-S58, P2-S60, P2-S87, P2-S88, P2-S97.
- **Release, expiry and tombstones.** P1-S54, P1-S62, P2-S14, P2-S93, P2-S104, P2-S106,
  P2-S107, P2-S110, P2-S114, P2-S22.
- **Displacement.** P1-S24, P1-S41, P1-S42, P1-S63, P1-S78.
- **Leg changes.** P1-S46, P1-S72; P2-S43, P2-S44, P2-S45, P2-S46, P2-S47, P2-S48,
  P2-S74, P2-S79, P2-S80, P2-S81, P2-S84, P2-S85, P2-S94.
- **POL-07 cuts and moves.** P1-S31, P1-S32, P1-S35, P1-S36, P1-S43, P1-S44, P1-S45,
  P1-S47, P1-S52, P1-S53, P1-S55, P1-S56, P1-S57, P1-S59, P1-S60, P1-S61, P1-S64, P1-S65,
  P1-S68, P1-S71, P1-S79, P1-S82, **P1-S84** (new in v1.10: a move final after the cut
  carries the cut rate).

## Conformance tests

**Provider side, link owner (RFC-001)**, run against a recorded account-owner stub:

1. **`hold` decision table.** One case per row of RFC-001 §4.1:
   - Tombstone before the digest check.
   - `ts ≥ D_c`.
   - V1 to V6 against `m0`, including P1-S74's calendar cases.
   - `NO_FIT` versus `IN_FLIGHT` versus `WAITING` (P1-S12, P1-S70, P1-S73).

   Every refusal is re-queried and shows a tombstone.
2. **Arrival-order check** (P1-S77). Two accounts' holds arrive in reverse receipt order,
   and the link's verdicts follow arrival. A re-sent hold returns its first verdict.
3. **Idempotency.** For every operation, a duplicate returns the recorded reply and the
   same identity with changed content returns `MISMATCH` with no state change. Also, after
   the in-memory record is dropped, a repeat is answered from `link_request`.
4. **Attempts.** Grant keeps the attempt. `yield_accept` and `displacement_accept` reply
   attempt + 1. `convert` with another attempt returns `MISMATCH`. A stale yield attempt
   returns `STALE_ATTEMPT`.
5. **Change-id order (C4-3).** For `end_leg` and `reduce_parts`, of each cause, a lower id
   after a higher one returns `STALE_CHANGE` with occupancy unchanged. A POL-07 cut relayed
   after a cancellation does not restore occupancy. Absolute pieces are clipped to the
   window.
6. **POL-07 `applies` (C4-4).** `end_leg` and `reduce_parts` with cause `POL07`,
   without `applies`, fail schema validation (gRPC `INVALID_ARGUMENT`, nothing applied,
   alerted). With a pair of an unknown own reduction,
   the result is `UNKNOWN_REDUCTION`. Covered parts above the cap raise
   `CUT_TARGET_UNMET`.
7. **`cut_target` sender (C4-1, C4-2).**
   - One target per reservation of `A_R`, including `none` and offer-scoped ones.
   - Re-sent until a reply is recorded, including across a takeover.
   - A second revision is never higher at any minute.
   - Each reply variant moves the cap as described under Semantics, and the
     highest-revision reply governs.
8. **Displacement markers.**
   - The capacity-lowering transaction lays its intents first.
   - A marker is never overwritten.
   - The marker is deleted by convert, release or accepted displacement.
   - The concurrent-confirm race (T-12) is ordered exactly by the database.
9. **Offers.**
   - Combined step-function check.
   - `INVALID` boundaries for `offer_accept` and `offer_move_at` against
     `nb(decisionTime)`.
   - Late `offer_accept` is applied as decided.
   - `offer_release` removes the parts and their cap.
   - The lapse backstop is sent and the parts are kept.
10. **Expiry.** A hold past `D` is kept, `expire_if_undecided` is re-sent every 1 s, and
    the link converts or releases on the answer.
11. **Notifications.** A `GRANTED` lost on push and relayed late is still applied
    downstream. Identity is stable across relay and push.

**Consumer side, account owner (RFC-002)**, run against a recorded link stub:

1. **Attempts.** Records the attempt from every message kind, never numbers one, and
   drops stale attempts.
2. **No high-water rule.** A late `GRANTED` is applied. Duplicate notifications are
   no-ops. `query` reconciliation finds a dropped `DISPLACED`.
3. **`STALE_CHANGE`.** It counts as the leg's acknowledgement in E12 and is never
   retried (C4-3).
4. **`cut_target` reply (C4-1, C4-2).**
   - The reply is sent only after the E11 or E13 commits.
   - Every case-table row is covered.
   - A repeat of the same revision returns the same reply.
   - A higher revision is composed by per-minute `min`; a piece above the recorded one is
     ignored and alerted.
   - A lower revision received after a higher one leaves the rates unchanged.
   - A link fence below the recorded one returns `STALE_SENDER`.
5. **Composition.**
   - Two links and two reductions in either arrival order yield the same part rates
     (S16, T15).
   - Covered parts only.
   - An offer-scoped target is applied only at Final.
   - A move Final after a cut sends `reduce_parts` at the cut rate (P1-S84).
   - Every leg change names every applied pair.
6. **Displacement read.**
   - Present for the recorded attempt: no E5.
   - Present for an earlier attempt: ignored.
   - A 10 ms lock timeout defers only that E5.
   - Present after a partner confirm was sent still blocks E5 (P1-S78).
7. **Release fan-out.** Every Share leg of the intake receives `release`, whether held or
   not. A `REFUSED` or `WAITER_REFUSED` counts as that leg's release acknowledgement for
   E8.
8. **Unavailable link (M-2).** `UNKNOWN_LINK`, `LINK_CLOSING` or `LINK_RETIRED` on `hold`
   produce E7 *rejected* `LINK_UNAVAILABLE(link)` with no counter-offer, followed by
   `release` to every leg. On `offer_hold`, the offer is Refused.
9. **Offer lapse backstop (M-1).** `offer_outcome_if_lapsed` is answered by re-sending
   `offer_accept` or `offer_release` once the offer is decided, and by nothing while the
   offer is still open.
10. **Expiry answer.** On `expire_if_undecided`, E6 is written only if the request is
   undecided. The answer is `convert` or `release`, sent after commit.

**Joint test.** A recorded-trace replay through both real owners covers:
- P1-S78 rows 1 to 3.
- P2-S19 and P2-S87 (crossing and cycle).
- P1-S52 with accept, decline and failed partner leg.
- P1-S84.
- P2-S104 with the decision record unavailable at `D`.

## Settled

No mismatch is open. Each point below is settled by a binding orchestrator decision and
applied in this contract. The last column lists the RFC errata that bring the RFCs into
line; no RFC is edited by this contract.

| # | Point | Settled form | Errata |
|---|---|---|---|
| C4-1 | How a cut target is answered, and how it is delivered | The synchronous reply to `cut_target`: `APPLIED(change ids \| none)`, `NOT_APPLIED(ended \| left_link \| unknown)` or `KEPT_FOR_OFFER(offer)`, given once E11/E13 commits. There is no `cut_target_answer`. The link **re-sends `cut_target` until it records the reply**, including after a takeover. A re-send is idempotent by (link, reduction, reservation, revision) | RFC-001 §5.4 and §11 (`CutAnswer` recorded from the reply; drop the `cut_target_answer` row; re-send replaces the Kafka relay as the guaranteed path). RFC-002 §2.5 and §9.7 (the answer is the reply, not a notification) |
| C4-2 | Target revision | `cut_target` carries `revision`, which increases per key and may only lower the target. The reply echoes it | RFC-002 §9.7, §13.1 |
| C4-3 | Stale leg changes | Every `end_leg` and `reduce_parts` is applied in change-id order per (reservation, leg). An older one is answered `STALE_CHANGE` with no effect and counts as the acknowledgement in E12 | RFC-002 §9.7, §13.2 |
| C4-4 | `end_leg` POL-07 pairs | `applies` names every applied (link, reduction) | RFC-001 §11.1 |
| C4-7 | Runtime hooks and results | From C01, referenced under Timeouts | RFC-001, RFC-002 per RFC-000 4.4 |
| M-1 | Lapse backstop for an offer hold | `offer_outcome_if_lapsed(offer)` on the outcome and expiry port, with identity (link, offer, "lapse"). It is answered by re-sending `offer_accept` or `offer_release` once the offer is decided. The link keeps the offer parts until then | RFC-002 erratum (§13.1 outcome and expiry port) |
| M-2 | `UNKNOWN_LINK`, `LINK_CLOSING`, `LINK_RETIRED` on `hold` and `offer_hold` | The link records **no tombstone**. The account owner rejects the request with reason **`LINK_UNAVAILABLE(link)`** and no counter-offer, and sends the request-scoped `release` to every leg. For `offer_hold`, the offer is Refused (`offer_release` to the legs that held, next candidate) | RFC-002 erratum (§5.1 answer table, §2.2 E7 reasons, §13.2 errors) |
| M-3 | `end_leg` cause for a POL-07 revocation | One cause, `POL07`, with the list of applied (link, reduction) pairs required. A revocation is a cut to 0. Endings outside POL-07 (cancel, shorten, release after grace, operator termination, move) keep their own causes | RFC-001 erratum (§11.1 `end_leg` causes: drop `revoke`) |
