# C02. Link hold: the link schedule owner ↔ account owner contract

| | |
|---|---|
| Contract ID | C02 |
| Name | link-hold |
| Version | 1.0.0 |
| Status | **Frozen.** Frozen at C4 on fix verification 61; errata owed listed below. [Fix verification 61](../../reviews/61-contracts-C02-C03-C04-fix-verification.md) accepted C02 with changes, and this version applies its C02 items V61-1, V61-2, V61-4 and V61-5 (see "Fix verification 61 resolution"). Earlier rounds: [review 54](../../reviews/54-contract-C02-review.md) rejected draft.2, [review 42](../../reviews/42-contract-C02-review.md) rejected draft.1, and [review 52](../../reviews/52-contract-C03-fix-verification.md) gave V52-1 and V52-2. All their fixes stay applied. C02 uses the same revision rule as C03 v2.3 and C04 v2.2. No mismatch is open (see "Settled"). C02 freezes with RFC errata owed: RFC-001 and RFC-002 must cite P1-S84 (orchestrator) |
| Provider | RFC-001 (link schedule owner): the link hold port, the link waiting port, the link availability query and the link displacement read. RFC-002 (account owner): the outcome and expiry port and the reservation command port's `cut_target` |
| Consumers | RFC-002 (account owner) consumes the RFC-001 ports. RFC-001 (link schedule owner) consumes the RFC-002 ports. Not part of C02: the partner-adapter side of the outcome and expiry port, and the other operations of the reservation command port (offer, terminate, release after grace) |
| Transport | **HTTP**: gRPC over HTTP/2 carries the synchronous commands between NestJS owners. The commands go by slot through the placement cache, and each carries C01's `CommandEnvelope` as gRPC metadata. **Kafka event**: the C01 runtime relays the link's waiting-port notifications from the link outbox and delivers them through `onNotification`; this is their guaranteed path. **Database read** (RFC-000 A1, §5.5): the account owner reads `link_displacement` inside its serialisable confirm transaction |
| Pinned to | `requirements-v1.10`. RFC-000 revision 4.4: the §8 rows (link hold port, link waiting port, outcome and expiry port, link availability query, link displacement read, reservation command port `cut_target`) and the "Revision 4.4 errata" C4-1 to C4-4 and C4-7. RFC-001 revision 5: §2, §4.1 to §4.5, §5.1, §5.4, §5.6, §7.1, §11. RFC-002 revision 5: §2.2, §2.5, §4.3, §5.1 to §5.7, §6.3, §9.6, §9.7, §12, §13. [C01](C01-platform.md) version 1 (`CommandEnvelope`, `RoutingRefusal`, `admitCommand`, move hooks, `Moving`, `Stopped`). Cross-checked against [C03](C03-link-schedule.md) v2.4 (frozen) and [C04](C04-reservation-feeds.md) v2.3 (frozen) |
| Binding decisions applied | C4-1. C4-2 with review 39 R39-01 and review 52 V52-1. C4-3, as amended by review 42 D1 and review 54 D1 and D2. C4-4. C02's M-1, M-2 and M-3, and the C4-1 delivery reading. Every fix of review 42 (D1 to D6) and of review 54 (D1 to D5). Review 52's V52-2. The C02 items of fix verification 61 (V61-1, V61-2, V61-4, V61-5) |

## Purpose

A route booking needs capacity on every Share link of its path. Each link's schedule
belongs to that link's schedule owner (RFC-001). The request, the reservation and every
decision about them belong to the account owner (RFC-002). C02 is everything that passes
between these two owners:

1. **Taking and ending capacity for a request.** The account owner holds capacity at a
   link. It converts the hold when the request is confirmed, and releases the hold when
   the request ends in any other way. The link reports waiting, grants, yields and
   displacements. The account owner reads the link's displacement markers inside its
   confirm transaction.
2. **Changing confirmed legs.** The account owner tells the link to end a leg
   (`end_leg`) or to set its part rates (`reduce_parts`). It also drives equivalent-path
   offers (`offer_*`).
3. **Applying a permanent reduction (POL-07).** The link sends a `cut_target` for each
   reservation that it cuts. The account owner composes the targets, answers in the
   reply, and applies the targets through leg changes.
4. **Advisory availability**, which the account owner uses to build route counter-offers.

C02 never moves the right to write. The link owner is the only writer of link state,
including the displacement markers. The account owner is the only writer of requests,
reservations and offers (RFC-000 A1).

## Schema

### Conventions and units

| Quantity | Type | Unit and encoding |
|---|---|---|
| Minute | `Minute` | Integer **minute index**: minutes since 1970-01-01T00:00Z (RFC-001 §2). A JSON number, always a safe integer |
| Window | `Window` | Half-open `[start, end)` in minutes. `end: null` means open-ended |
| Rate | `Mbps` | Integer **Mbps** (10⁶ bit/s), ≥ 0. The rate of a hold is ≥ `rate_min` |
| Commit or decision timestamp | `Hlc` | C01's `HlcTs`: the database's hybrid-logical commit timestamp, as a **decimal string** `"<wall ns>.<logical 10 digits>"`. Used for `ts`, `T_dec`, `request_age`, decision times and the record time of a reduction. Compare it as a decimal. Do not compare it as a float |
| Deadline | `EpochMs` | Integer **milliseconds** since the Unix epoch (`D`, `D_c`, ahead deadlines, `lapse_at`) |
| Duration | `DurationMs` | Integer **milliseconds** (`retry_after`) |
| Sequence, generation, epoch | `bigint` / `number` | As C01: `Seq` and `Epoch` are int64 (a decimal string in JSON); `Generation` is int32 |
| Partition key | `PartitionKey` | C01's partition key bytes, as base64url in JSON |

```ts
// ---------- From C01 (imported, not redefined) ----------
import type { CommandEnvelope, RoutingRefusal, PartitionKey, Seq, Epoch, Generation, HlcTs } from 'C01';
// CommandEnvelope = { routedTo: { kind, slot, generation, epoch, mapVersion? },
//                     sender: { kind, partition, generation, epoch, seq? }, identity }  (gRPC metadata)

// ---------- Identities ----------
type LinkId = string;                       // catalogue link_id (RFC-001 §10)
type AccountPartition = PartitionKey;       // account partition, routed by C01 slotOf()
type Hlc = HlcTs;
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
type Attempt = number;          // integer ≥ 1; only the link sets it (RFC-001 §4.3)
type ClaimSeq = Seq;            // link-log sequence of the entry that raised a yield request

interface Window { start: Minute; end: Minute | null }   // [start, end)
interface Fence { generation: Generation; epoch: Epoch } // RFC-000 §5.2, AI-R6-3
/** A step function: rateMbps from `from` until the `from` of the next piece (the last piece is open). */
interface Piece { from: Minute; rateMbps: Mbps }
interface ReductionRef { link: LinkId; reduction: ReductionSeq }

// ---------- C02 command body header ----------
/** Every C02 command body starts with these fields. The C01 CommandEnvelope travels as gRPC metadata.
 *  "Same identity, different content" compares the body only (review 42 m4). */
interface C02Body {
  link: LinkId;                 // the link that the command concerns
  receiverPartition: string;    // the account partition (base64url) for a command to the account owner;
                                // the link id for a command to the link (review 42 M2)
}
/** Every reply and every message from the link carries the link's fence and log position. */
interface LinkStamp { linkFence: Fence; linkSeq: Seq }

/** Errors that any C02 command can return, in addition to C01's RoutingRefusal. */
type C02Error =
  | { code: 'MISMATCH' }        // same identity, different body: no change, alerted
  | { code: 'UNKNOWN_LINK' }    // see Settled M-2
  | { code: 'LINK_CLOSING' }    // hold and offer_hold only
  | { code: 'LINK_RETIRED' };
type Refusal = RoutingRefusal | C02Error;

/** Coalesced calls (review 54 m3). Each item has its own C01 envelope and gets its own reply.
 *  Up to 500 items for each call (est.). A routing refusal applies to its item only. */
interface Batch<Cmd> { items: { env: CommandEnvelope; cmd: Cmd }[] }
interface BatchReply<Reply> { replies: (Reply | RoutingRefusal)[] }   // in item order
```

### Link hold port (RFC-001 → RFC-002; synchronous)

```ts
type HoldKind = { kind: 'booking' } | { kind: 'change'; reservation: ReservationId };

interface HoldCmd extends C02Body {
  request: RequestId; account: AccountPartition; leg: LegId; holdKind: HoldKind;
  rateMbps: Mbps; window: Window;
  deadline: EpochMs;            // D
  commitFence: EpochMs;         // D_c; the link uses it as given and never calculates it again
  requestAge: Hlc;              // priority key: E1 commit timestamp; ties by request id
  wait: boolean;
  receiptMinute: Minute;        // m0; the link checks validity against it (RFC-001 §2)
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
  // for a repeat of a request that a hold first recorded, the later state of the request:
  | { result: 'RELEASED' } | { result: 'CONVERTED'; part: PartId }
) | Refusal;

interface ConvertCmd extends C02Body {
  request: RequestId; attempt: Attempt; reservation: ReservationId; leg: LegId; part: PartId;
  createdBy: ChangeId;          // the (account partition, sequence) of the E5 that created the part (V61-1)
  decisionTime: Hlc;            // T_dec, the E5 commit timestamp
}
type ConvertReply = (LinkStamp & {
  result: 'CONVERTED'; part: PartId;
  clippedAt?: Minute;           // set only when an applied end_leg of the leg has a change id above createdBy (CONVERT_AFTER_END)
}) | { code: 'NO_HOLD' } | { code: 'TOMBSTONED' } | Refusal;   // MISMATCH: another attempt

interface ReleaseCmd extends C02Body {
  request: RequestId; deadline: EpochMs;        // D: sets the end of the tombstone (D + release_grace)
  reason: 'WITHDRAWN' | 'EXPIRED' | 'REJECTED' | 'FAILED' | 'ENDED';
  decisionTime: Hlc;            // the commit timestamp of the deciding entry
}                               // no attempt: request-scoped
type ReleaseReply = (LinkStamp & { result: 'RELEASED'; tombstoneUntil: EpochMs }) | Refusal;

interface QueryCmd extends C02Body { request: RequestId }
type QueryReply = (LinkStamp & {
  state: 'UNSEEN' | 'HELD' | 'WAITING' | 'DISPLACED' | 'REFUSED' | 'RELEASED' | 'CONVERTED';
  attempt?: Attempt; aheadDeadline?: EpochMs;
  refusal?: { reason: RefusalReason; counterOffer?: CounterOffer; retryAfterMs?: DurationMs };
  displacedBy?: ReductionRef & { recordTime: Hlc };
  openYieldClaims?: { claim: ClaimSeq; olderRequest: RequestId }[];
  tombstoneUntil?: EpochMs;
}) | Refusal;

/** M-3: one policy cause, POL07 (a revocation is a cut to 0). Other endings keep their own causes. */
type LegChangeCause = 'CANCEL' | 'SHORTEN' | 'DECREASE' | 'RELEASE' | 'TERMINATE' | 'MOVE' | 'POL07';
interface EndLegCmd extends C02Body {
  reservation: ReservationId; leg: LegId; changeId: ChangeId;
  fromMinute: Minute;           // effective minute: every part of the leg ends from this minute
  cause: Exclude<LegChangeCause, 'DECREASE'>;
  applies?: ReductionRef[];     // present only if cause = 'POL07': every applied (link, reduction) (C4-4)
  decisionTime: Hlc;
}
interface ReducePartsCmd extends C02Body {
  reservation: ReservationId; leg: LegId; changeId: ChangeId;
  cause: 'DECREASE' | 'POL07';
  parts: { part: PartId; pieces: Piece[] }[];   // absolute rates, newest part first, every cause
  applies?: ReductionRef[];     // present only if cause = 'POL07'
  decisionTime: Hlc;
}
type LegChangeReply = (LinkStamp & (
  | { result: 'CHANGED' }
  | { result: 'STALE_CHANGE'; lastApplied: ChangeId }   // a lower change id that the link never applied: no effect
)) | { code: 'UNKNOWN_RESERVATION' } | { code: 'UNKNOWN_PART' } | { code: 'UNKNOWN_REDUCTION' }
   | { code: 'INVALID'; field: 'applies' }              // applies missing with POL07, or present with another cause
   | Refusal;

interface OfferPart { part: PartId; rateMbps: Mbps; originalAge: Hlc; end: Minute | null }
interface OfferHoldCmd extends C02Body {
  offer: OfferId; reservation: ReservationId; account: AccountPartition;
  parts: OfferPart[]; fromMinute: Minute; lapseAt: EpochMs; decisionTime: Hlc;
}
type OfferHoldReply = (LinkStamp & (
  | { result: 'HELD' }
  | { result: 'REFUSED'; reason: 'NO_FIT' | 'IN_FLIGHT'; retryAfterMs?: DurationMs }
  | { result: 'REFUSED'; reason: 'TOMBSTONED' }         // offer_release is recorded, or ts ≥ lapse_at
)) | Refusal;
interface OfferAcceptCmd extends C02Body { offer: OfferId; leg: LegId; moveAt: Minute; decisionTime: Hlc }
interface OfferMoveAtCmd extends C02Body {
  offer: OfferId; leg: LegId; changeId: ChangeId;       // in the per-leg sequence (review 54 B1)
  moveAt: Minute; decisionTime: Hlc;                    // T
}
interface OfferReleaseCmd extends C02Body {
  offer: OfferId; lapseAt: EpochMs;                     // sets the end of the tombstone, also for an offer not seen
  reason: 'DECLINED' | 'LAPSED' | 'FAILED' | 'REFUSED_ELSEWHERE' | 'ENDED'; decisionTime: Hlc;
}
type OfferReply = (LinkStamp & ({ result: 'ACCEPTED' } | { result: 'MOVED' }
                 | { result: 'RELEASED'; tombstoneUntil: EpochMs }))
  | { code: 'UNKNOWN_OFFER' } | { code: 'TOMBSTONED' } | { code: 'INVALID' } | Refusal;
```

### Link waiting port (RFC-001 → RFC-002 notifications; RFC-002 → RFC-001 commands)

```ts
/** Point-to-point state message, link → account owner.
 *  Identity: (link, request, attempt, kind). For YIELD_REQUEST: (link, request, attempt, kind, claim). */
type WaitingNotification = LinkStamp & { link: LinkId; request: RequestId; attempt: Attempt } & (
  | { kind: 'WAITING_NOTICE'; aheadDeadline: EpochMs }       // latest remaining deadline among this link's blockers
  | { kind: 'GRANTED' }                                      // held now, at the waiter's attempt
  | { kind: 'YIELD_REQUEST'; claim: ClaimSeq; olderRequest: RequestId }   // one or more open claims for each holder attempt
  | { kind: 'DISPLACED'; reduction: ReductionSeq; recordTime: Hlc;       // holds only
      fitsOnCommitted: boolean; counterOffer: CounterOffer }
  | { kind: 'WAITER_REFUSED'; reason: 'NO_FIT'; counterOffer: CounterOffer }   // tombstoned
);

interface MarkWaitingCmd extends C02Body {
  request: RequestId; waiting: boolean;
  position: Seq;                // account-log sequence of the E2 (or leaving entry) that it reflects
}
type MarkWaitingReply = (LinkStamp & { result: 'APPLIED' | 'IGNORED_OLDER' }) | Refusal;
```

### Outcome and expiry port (RFC-002 → RFC-001)

The outcome notices to a link are the `convert` and `release` commands of the link hold
port (above). The other operations:

```ts
interface YieldAnswerCmd extends C02Body {
  request: RequestId; attempt: Attempt;   // the attempt that the YIELD_REQUEST named
  claim: ClaimSeq;                        // the claim that the YIELD_REQUEST named
  answer: 'yield_accept' | 'yield_refuse';
}
interface DisplacementAcceptCmd extends C02Body {
  request: RequestId; attempt: Attempt;   // the attempt that DISPLACED named
}
type AcceptReply = (LinkStamp & (
  | { result: 'ACCEPTED'; newWaiterAttempt: Attempt }   // the account owner records this attempt
  | { result: 'REFUSED_RECORDED' }                      // yield_refuse: that claim ends
  | { result: 'STALE_ATTEMPT' }                         // no change; the account owner queries the leg
)) | Refusal;

/** Link → account owner. The link sends it when its ts passes D and a hold or waiter is still present.
 *  Identity: (link, request, 'expire'). The link sends it again every 1 s until the outcome arrives. */
interface ExpireIfUndecidedCmd extends C02Body { request: RequestId; deadline: EpochMs }
type ExpireIfUndecidedReply = { result: 'RECEIVED' } | Refusal;
// The answer is the outcome. When the deciding entry (E5, or E4/E6/E7) has committed,
// the account owner sends ConvertCmd or ReleaseCmd (again, if necessary).

/** Settled M-1: link → account owner, for an offer hold after lapse_at.
 *  Identity: (link, offer, 'lapse'). The link sends it again every 1 s. */
interface OfferOutcomeIfLapsedCmd extends C02Body { offer: OfferId; lapseAt: EpochMs }
type OfferOutcomeIfLapsedReply = { result: 'RECEIVED' } | Refusal;
// The answer is OfferAcceptCmd (Final) or OfferReleaseCmd (declined, lapsed, failed). The account owner
// sends it again when the offer is decided. It sends nothing while the offer is Accepted and its partner booking is open.
```

### Reservation command port: `cut_target` (RFC-001 → RFC-002; synchronous)

```ts
interface CutTargetCmd extends C02Body {
  // receiverPartition = the reservation's account partition
  account: AccountPartition;    // recorded by the link from the hold and convert of the reservation
  reduction: ReductionSeq;
  reservation: ReservationId;
  revision: number;             // integer ≥ 1; increases for each (link, reduction, reservation) (C4-2)
  tEff: Minute;                 // T_eff, the end of the reduction's notice
  parts: PartId[];              // covered parts. Revision 1 sets them. A later revision has the same parts,
                                // less any part that has ended. It never adds a part (review 54 D4)
  pieces: Piece[] | null;       // null = none (no cut). Otherwise pieces[0].from = tEff, strictly increasing.
                                // Each rateMbps is the reservation's rate on this link; 0 revokes from that minute
  offer?: OfferId;              // set when the cut parts are an open offer's parts on this link
  decidedAt: Hlc;               // commit timestamp of the link's deciding ReductionStep
}
type CutAnswer = {
  revision: number;             // echoes the revision of the command
  recordedRevision: number;     // the highest revision recorded for the key; it governs the cap
  decisionTime: Hlc | null;     // the E11/E13 commit timestamp; null only for 'unknown'
} & (
  | { answer: 'APPLIED'; changeIds: ChangeId[] }        // [] = APPLIED(none)
  | { answer: 'NOT_APPLIED'; reason: 'ended' | 'left_link' | 'unknown' }
  | { answer: 'KEPT_FOR_OFFER'; offer: OfferId }
);
type CutTargetReply = CutAnswer | Refusal;
// Batched form (review 42 m6, review 54 m3): Batch<CutTargetCmd> → BatchReply<CutTargetReply>,
// up to 500 targets for one destination account slot. Each item has its own envelope (own routedTo.generation).
```

There is no separate `cut_target_answer` command (C4-1).

### Link availability query (RFC-001 → RFC-002; synchronous read)

```ts
interface AvailabilityQuery extends C02Body { window: Window; rateMbps: Mbps }
type AvailabilityReply = (LinkStamp & { asOfSeq: Seq; offer: CounterOffer }) | Refusal;

interface FitRangesQuery extends C02Body { rateMbps: Mbps; from: Minute; until: Minute; k: number }
type FitRangesReply = (LinkStamp & {
  asOfSeq: Seq;
  ranges: Window[];             // up to k maximal ranges in [from, until) where occ_all + rate ≤ C_ref
  continueFrom: Minute | null;  // null: the search went to `until`
}) | Refusal;
```

### Link displacement read (database read, RFC-000 A1)

The link owner owns and writes this table. The account owner's role has `SELECT` on this
table and on no other RFC-001 table (RFC-001 §7.1).

**The primary key is exactly (`link_id`, `request_part`, `request_seq`). There is no slot
column.** This table is a projection that its owner defines. RFC-006 §5.5's slot-first
prefix applies only to log and outbox tables. Thus the account owner can always do a
single-key point read and does not need to know the link's slot. When the slot of the link
changes, the rows do not move and nobody writes them again (review 42 M7).

```sql
CREATE TABLE link_displacement (
  link_id          STRING   NOT NULL,   -- the link (partition)
  request_part     BYTES    NOT NULL,   -- RequestId.partition (C01 PartitionKey)
  request_seq      INT8     NOT NULL,   -- RequestId.seq
  attempt          INT4     NOT NULL CHECK (attempt >= 1),  -- the displaced attempt
  reduction_seq    INT8     NOT NULL,   -- link-log sequence of the displacing entry
  record_hlc       DECIMAL  NOT NULL,   -- commit timestamp (HLC) of that entry
  PRIMARY KEY (link_id, request_part, request_seq)
);
-- Grants: link owner role INSERT, SELECT, DELETE (declared deletable projection);
--         account owner role SELECT only. No role has UPDATE.

-- The account owner's read, one for each Share leg, inside E5's serialisable batch transaction,
-- under a savepoint with lock_timeout = 10 ms (J-14). Its plan must be a single-key lookup:
SELECT attempt, reduction_seq, record_hlc
  FROM link_displacement
 WHERE link_id = $1 AND request_part = $2 AND request_seq = $3;
```

## Semantics

### Common rules for every synchronous command

- **Routing and fencing (C01 §3.8).** A command goes to the owner-lease holder of the
  receiver's slot. The receiver calls C01's `admitCommand` for the sender, with the
  sender's fence. It answers with C01's `RoutingRefusal` when necessary:
  - `STALE_SENDER(recorded)` if the sender's fence is below the highest fence recorded
    for the sender's partition.
  - `NOT_OWNER` or `STALE_EPOCH` if it does not hold the lease at the routed epoch.
  - `MOVED(slot, generation)` or `MOVING` if `routedTo.generation` is not the current
    generation of `receiverPartition`.
  - `STOPPED` or `OVERLOADED` as C01 defines.
- **Answered once durable.** The receiver sends a reply only after the batch transaction
  that records the effect has committed (durable in two regions). `UNAVAILABLE` means
  that the effect is **not known to be committed**. The sender must send the command
  again with the same identity. The identities make this safe.
- **Order at a link.** The link applies the commands for one link in the single total
  order of the link log. This is the order in which the commands get to the owner-lease
  holder. A command sent again takes the position of its first applied copy. There is no
  order across links. The receipt time at the account has no effect on the order (POL-05;
  P1-S14, P1-S77).
- **Digest.** "Same identity, different content" compares the command body only. It
  does not compare the C01 envelope. Thus a command that a new holder sends again, with a
  new fence or new routing fields, is a duplicate. It is not a `MISMATCH`.
- **`MISMATCH`.** No change occurs and the receiver alerts. The sender treats it as a
  protocol defect. For leg commands, see "Leg-command replies".

### Link hold port

| Operation | Preconditions | Outcomes | Errors |
|---|---|---|---|
| `hold` | The account owner sends it only after E1 commits, so a funds hold exists (P2-S92). It sends no attempt | The link does these checks in this order (RFC-001 §4.1). (1) A request record that a release made (a tombstone): `REFUSED(TOMBSTONED)`, with no digest check. (2) A request record that a hold made: the recorded state (held, waiting, refused, `RELEASED`, `CONVERTED`), or `MISMATCH` if the body digest is different. (3) `ts ≥ D_c`: `REFUSED(DEADLINE_PASSED)`. (4) Not valid for `m0` and the policy version: `REFUSED(INVALID(rule))`. (5) No fit on `occ_firm`: `REFUSED(NO_FIT, counterOffer)`. (6) Fit on `occ_all`: `HELD(1)`. (7) Otherwise, if `wait = false`: `REFUSED(IN_FLIGHT, retryAfterMs = the remaining deadline of the latest blocker, counterOffer)`, with no waiter and no yields. (8) Otherwise: `WAITING(1, aheadDeadline)`, and yield requests. **Each refusal records a tombstone until `D + release_grace`. Each refusal is also the release acknowledgement of this leg** | `Refusal`. For `UNKNOWN_LINK`, `LINK_CLOSING` and `LINK_RETIRED`, the link records **no tombstone**. The account owner then rejects the request with `LINK_UNAVAILABLE(link)` and no counter-offer, and releases every leg (settled M-2) |
| `convert` | The account owner sends it after E5 commits. In the per-leg sequence, it has the position of the E5 that created the part (`createdBy`) (see "Leg-command sequencing"). `attempt` is the attempt recorded for the leg. A grant keeps the waiter's attempt | `CONVERTED(part)`: the hold becomes a committed part with age `T_dec`, and the link removes its marker. If the hold has a displacement mark, the link flags the part or adds it to the affected set, writes the notice immediately, and alerts `CONFIRMED_AFTER_REDUCTION` (P1-S63). **Backstop (review 54 D1, V61-1):** the link clips the new part only when an applied `end_leg` of the leg has a change id above `createdBy`. It clips the part to the end of that `end_leg`, sets `clippedAt`, and alerts `CONVERT_AFTER_END`. An applied `end_leg` with a change id below `createdBy` does not clip the part | `NO_HOLD`, `TOMBSTONED`: violations, alerted. `MISMATCH`: another attempt. `UNKNOWN_LINK` or `LINK_RETIRED`: a violation, because RFC-001 retires a link only when it has no holds, offer holds or parts. Alerted, and counted as answered (review 42 M5) |
| `release` | A committed outcome that is not "confirmed". The account owner sends it to **every** Share leg of the intake, held or not | `RELEASED` when durable. In one entry, the link ends every hold, waiter registration, grant, displacement marker, yield claim and open yield or displacement request of the request, for all attempts. It records a tombstone until `D + release_grace` and scans the waiters. It does the same for a request that it has not seen | `Refusal`. **`UNKNOWN_LINK` or `LINK_RETIRED` in reply to `release` is the release acknowledgement of that leg** for E8 (review 42 M5) |
| `query` | — | A read. It writes no entry. It returns the state of the request at the link, its attempt, the latest blocker deadline, the recorded refusal, any displacement, the open yield claims and the tombstone expiry | `Refusal` |
| `end_leg` | A committed E11 (or an E13 *final* with its E11 move). `fromMinute` is never before `nb(ts)` of that entry. The exception is a POL-07 cut, which is effective at `T_eff`. The account owner sends a change that it knows in advance with a future date. **It is in the per-leg sequence** | `CHANGED` when durable: every part of the leg ends from `fromMinute` (the pulse `−b` over `[max(s, from), e)`). For cause `POL07`, the link records `applies`. For each of its own reductions in `applies`, the link compares the covered parts with the cap from `T_eff`. If they are above the cap, it alerts `CUT_TARGET_UNMET`. If the change arrives after `fromMinute`, the link applies it as decided, from `fromMinute` (late change, alerted) | See "Leg-command replies" |
| `reduce_parts` | As `end_leg`. The account owner names the parts: a decrease removes the newest parts first (last in, first out), and POL-07 rates come from the §9.7 composition | `CHANGED`: the link **sets** the rate of each named part to the pieces from the first `from`, clipped to the current window of the part. It never decrements a rate. Otherwise as `end_leg` | See "Leg-command replies" |
| `offer_hold` | E13 *prepared*. The account owner sends it only to path links that are not already legs of the reservation | (0) `ts ≥ lapse_at`: `REFUSED(TOMBSTONED)` (review 54 m4). (1) A recorded `offer_release` for the offer: `REFUSED(TOMBSTONED)`, before any fit check. (2) Otherwise the link decides as for `wait = false`, on the combined step function of the parts. `HELD`: each offer part becomes a pulse over `[from, end)` in `occ_firm`, `occ_all` and `occ_commit`, with its original age. Or `REFUSED(NO_FIT \| IN_FLIGHT, retryAfterMs?)` | `Refusal`. For `UNKNOWN_LINK`, `LINK_CLOSING` and `LINK_RETIRED`, the link records no tombstone and the offer is Refused (M-2) |
| `offer_accept` | E13 *final*: every leg of the new path is booked (D4). On a new leg, it has the position of its E13 *final* in the per-leg sequence. The move's `reduce_parts` and any `offer_move_at` come after its `ACCEPTED` | `ACCEPTED`: from `moveAt`, the offer parts and any cut cap on the offer become the reservation's parts on this link, with their original ages. If it arrives late, the link applies it as decided | See "Leg-command replies". `INVALID` unless `moveAt ≥ nb(decisionTime)` |
| `offer_move_at` | A further E11 for an earlier minute that the holder chose. **It is in the per-leg sequence of the new leg**, after `offer_accept` (review 54 B1) | `MOVED`: the parts start at `moveAt`. If it arrives late, the link applies it as decided | See "Leg-command replies". `INVALID` unless `nb(decisionTime) ≤ moveAt < current move_at` and `moveAt` is a minute boundary |
| `offer_release` | E13 *declined*, *lapsed* or *failed*, or the link refused a sibling offer hold. The account owner sends it **to every Share leg to which it sent `offer_hold`, held or not** (review 42 M4) | `RELEASED`: the link removes the offer parts and any cut cap on them from all three occupancies immediately. It records a tombstone until `lapse_at + release_grace`, also for an offer that it has not seen, and scans the waiters | `Refusal`. `UNKNOWN_LINK` or `LINK_RETIRED` counts as acknowledged (review 42 M5) |

**Port invariants** (A0R-03). The link enforces them in its apply step:
- A release ends everything that the request has at the link.
- Until the tombstone expires, the link refuses every later hold or grant for the
  request, and every later `offer_hold` for the offer.
- The link makes no hold or grant at or after `D_c`. It skips a waiter after `D_c`.
- A refusal is a release acknowledgement.
- Only these end a hold: conversion, release, an accepted yield, an accepted
  displacement.
- The link accepts `convert` for a held leg after `DISPLACED`. It then flags the leg as
  affected.
- RFC-001 retires a link only when the link has no holds, offer holds or parts.
- The entry that ends a hold attempt (an accepted yield or displacement, `convert`,
  `release`) also ends every yield claim on that attempt and stops its re-sends (review
  54 m1).

**`nb(t)`** is the first minute boundary strictly after `t`.

### Leg-command replies (review 54 M1)

This table applies to `convert`, `offer_accept`, `offer_move_at`, `end_leg` and
`reduce_parts`. Each reply is in one of two groups. **Retry**: send the same command
again with the same identity. **Answered**: the command leaves the queue of its leg, and
the next command of the leg can go. Thus a leg queue never stalls.

| Reply | Group | Account owner action |
|---|---|---|
| `CHANGED`, `CONVERTED`, `ACCEPTED`, `MOVED` | Answered | Record it. Count it for E12 (for a leg change) |
| `RoutingRefusal` `STALE_EPOCH`, `NOT_OWNER`, `MOVED`, `MOVING`, `STOPPED`, `OVERLOADED`, `UNAVAILABLE`; no reply | Retry | Refresh the placement cache if necessary, and send again |
| `RoutingRefusal` `STALE_SENDER` | Neither | This holder is deposed. It stops serving the partition. The new holder sends the command again (see "Leg-command sequencing") |
| `STALE_CHANGE` | Answered | Count it for E12. Do not send it again. Alert only if it is unexplained (see below) |
| `UNKNOWN_RESERVATION`, `UNKNOWN_PART`, `UNKNOWN_REDUCTION`, `UNKNOWN_OFFER`, `NO_HOLD`, `TOMBSTONED`, `INVALID`, `INVALID(applies)`, `MISMATCH` | Answered | Alert it as a protocol defect, with the leg and the change id. Count the change for E12. Do not send it again. Under the per-leg sequence, a correct pair of owners never gives these replies |
| `UNKNOWN_LINK`, `LINK_RETIRED` | Answered | Alert it as a violation. Count the change for E12 |

### Link waiting port

- **Notifications** (`WAITING_NOTICE`, `GRANTED`, `YIELD_REQUEST`, `DISPLACED`,
  `WAITER_REFUSED`) are idempotent **state messages**:
  - **Identity** is (link, request, attempt, kind). For `YIELD_REQUEST`, the identity
    also includes the `claim`.
  - The receiver applies each identity that it has not applied, however late. There is
    **no high-water rule** across identities.
  - Within one identity, only `WAITING_NOTICE` changes content. The copy with the highest
    `linkSeq` wins.
  - A message whose attempt is below the attempt recorded for the leg is stale. It
    changes nothing.
  - The account owner records the attempt in `HELD`, `WAITING`, `GRANTED`, `DISPLACED`,
    `WAITER_REFUSED`, in the `ACCEPTED` replies and in the `query` reply. **The account
    owner never sets an attempt number.**
- **Precedence within one attempt.** `GRANTED`, `DISPLACED` and `WAITER_REFUSED` end the
  waiting state of their attempt. A later `WAITING_NOTICE` for the same attempt updates
  the blocker deadline only if the leg is still recorded as waiting. It never changes a
  held leg back to waiting: no E2, and no `mark_waiting(true)`.
- **`GRANTED`**: the link now holds the released capacity for the waiter, at the
  waiter's attempt.
- **`DISPLACED`** is for **holds only**. A waiter that does not fit gets `WAITER_REFUSED`
  from the scan. The link sends `DISPLACED` only after the reduction and its markers have
  committed. The link keeps the hold, and counts it, until the account owner answers with
  `displacement_accept`, `release`, or `convert` (`convert` only if E5 committed and did not
  see the marker). The account owner follows RFC-002 §5.1:
  - If E5 has committed, the `convert` answers the notice.
  - If E5 is in flight, the account owner waits for the result.
  - Otherwise the account owner decides against the reduced capacity.
    - If the leg does not fit on committed capacity (`fitsOnCommitted = false`), it writes
      E7 *rejected* and sends `release`.
    - If the leg fits, it writes E3 and sends `displacement_accept`.
- **`YIELD_REQUEST`** (review 42 M1, review 54 M3). Each yield request carries a `claim`.
  The link sets the claim: it is the link-log sequence of the entry that raised the
  request.
  - The link sends an unanswered request again with the **same** claim.
  - The link raises a request with a **new** claim when a waiting hint for the holder
    arrives and no claim is open for that holder attempt and that older waiter.
  - **When the link records a refusal, it immediately raises a new claim if both of these
    are true:**
    - the holder's waiting mark is set;
    - an older waiter is still blocked by that holder attempt.
  - This rule closes the order "mark first, then refusal". It stops in these two cases:
    - while the account owner is Waiting, it accepts;
    - while it is not Waiting, its position-ordered `mark_waiting(false)` clears the mark.
  - The account owner answers each claim. It accepts only while the request is in the
    Waiting phase, in its serial order: E3 (which records the claim), then `yield_accept`.
    Otherwise it sends `yield_refuse`.
  - A refusal ends only the claim that it names. A request with a new claim is a new
    identity, so the account owner never drops it as a duplicate.
- **`mark_waiting`** is advisory. The link applies it only if `position` is above the
  last position applied for the request. Otherwise it answers `IGNORED_OLDER`. When the
  mark is set, the link checks the older waiters for yields again. The link never asks a
  holder without the mark to yield (P2-S58).
- **Reconciliation.** Every 5 s (est.), the account owner sends `query` for each request
  that it has in Holding or Waiting. Thus it finds a lost notification without another
  notification.

### Outcome and expiry port

- **`yield_accept` and `displacement_accept`.** In one entry, the link:
  - removes the pulse (and the marker) of that attempt;
  - registers the request as a waiter at attempt + 1, with the same age and window;
  - ends every other claim on the old attempt;
  - scans the waiters.

  The reply names `newWaiterAttempt`. A stale attempt or claim gets `STALE_ATTEMPT` and
  changes nothing. The account owner then sends `query` for the leg and records the
  reply. `yield_refuse` ends only the claim that it names.
- **`expire_if_undecided`.** The link sends it when its `ts` passes `D` and a hold or
  waiter is still present. The link keeps the hold, alerts, and sends the request again
  every 1 s. If the request is undecided, the account owner writes E6. In all cases,
  when the deciding entry has committed, the account owner sends the committed outcome:
  `convert` (confirmed, with `T_dec`) or `release`. The link never releases without an
  outcome.
- **`offer_outcome_if_lapsed`** (settled M-1). The link sends it when an offer hold is
  still present after `lapse_at`. The link keeps the offer parts. When the offer is
  decided, the account owner sends `offer_accept` or `offer_release` again.

### Reservation command port: `cut_target`

- **When.** The link sends a target when the last part of a reservation in the cut set is
  decided. Each reservation of the affected set `A_R` gets exactly one target, `none`
  included. Each reservation that is cut only in offer parts (offer-scoped) also gets one.
  After `REDUCTION_SET_EXTENDED`, a second target can follow for the same key, with a
  higher `revision`.
- **Covered parts (review 54 M4, D4).** Revision 1 of a key sets the covered parts. A
  revision ≥ 2 has the same `parts`. It can omit a part that has ended since revision 1.
  It never adds a part. A part converted after `T_eff` is never covered (RFC-000 §8). The
  link sends a revision ≥ 2 only when the target is strictly lower at one or more minutes,
  or when it omits ended parts. If a revision ≥ 2 adds a part, the account owner answers
  `MISMATCH` and alerts.
- **Ended part (V61-5).** A part is ended from minute m when its applied end, after every applied end_leg, reduce_parts to 0 or window end, is at or before m. A later revision that drops an ended part never raises the rate of any part. A later revision may drop a part only if the part is ended from the minute of that revision's first piece. The recorded target keeps binding the dropped part up to its end.
- **Routing (review 42 M2).** `receiverPartition` and `account` are the account partition
  of the reservation. The link records it from the `hold` and `convert` of the
  reservation. The account owner admits the command for that partition, and answers
  `MOVED` for an account that has moved to another slot.
- **The answer is the reply (C4-1).** For a revision above the highest recorded revision,
  the account owner sends the reply only after its E11 has committed (or its E13, for an
  offer-scoped target that it keeps). The reply comes from RFC-002 §9.7's case table,
  completed here:

  | Case | Account owner records | Reply |
  |---|---|---|
  | A repeat of a recorded (key, revision) | Nothing | Its recorded reply |
  | A lower revision that was never recorded | Nothing | The reply of the highest recorded revision, echoing its own revision |
  | Same (key, revision), different body; or a revision ≥ 2 that adds a covered part | Nothing | `MISMATCH`, alerted |
  | A revision above the highest recorded (the first revision included). The reservation is on the link at `T_eff` | An E11 cause *cut*: the pieces, the covered parts and the composition. The leg changes go after the commit. **Each revision above the highest recorded writes its E11**, `APPLIED(none)` included | `APPLIED(changeIds)`, or `APPLIED([])` when no rate of a part changes |
  | The reservation ended at or before `T_eff` | An E11 "not applied: ended" | `NOT_APPLIED(ended)` |
  | The reservation left the link by `T_eff` (a Final move with `move_at ≤ T_eff`, and the link is not on the new path) | An E11 "not applied: left the link" | `NOT_APPLIED(left_link)` |
  | `offer` set, and the offer is not yet Final | E13: the target is kept against the offer, and the holder is told | `KEPT_FOR_OFFER(offer)` |
  | `offer` set, offer Final with this link on the new path, `move_at ≤ T_eff` | E11 cause *cut* | `APPLIED` |
  | `offer` set, offer Final with this link on the new path, `move_at > T_eff` (review 54 D5) | E11 cause *cut*, which binds the moved parts from `max(T_eff, move_at)` | `APPLIED` |
  | `offer` set, and the offer ended without a move to this link (Declined, Lapsed, Failed, or Final to another path) | E13 records it | `NOT_APPLIED(ended)`. On the link, the cap went with `offer_release` |
  | Unknown reservation | Nothing | `NOT_APPLIED(unknown)`, alerted, with `decisionTime: null` |

  The two "offer Final" rows together cover every `move_at`: an offer-scoped target on an
  offer that is Final with this link on the new path is a normal cut.
- **Composition** (RFC-002 §9.7). The account owner composes the targets in force (the
  applied targets only) by `min` **for each minute**:
  - Each target binds only its covered parts.
  - The oldest Mbps stay first.
  - The changed rate of each part goes to **every** Share leg as absolute pieces. It goes
    through `reduce_parts`, or through `end_leg` when every rate is 0 to the end. Each
    change names every applied (link, reduction) in `applies` and obeys "Leg-command
    sequencing".
  - The result does not depend on the arrival order.
  - A move that becomes Final after a cut keeps the cut rate (P1-S84). The move's E11
    sends `reduce_parts` to each new leg from `move_at` and names the binding pairs. On
    each new leg, that change goes only after the leg's `offer_accept` gets `ACCEPTED`.
- **What the link does with the reply** (RFC-001 §5.4). The link appends a `CutAnswer`
  entry when it receives the reply:
  - `APPLIED`: the cap stays as a record.
  - `KEPT_FOR_OFFER`: the cap moves with `offer_accept`, or it goes with `offer_release`.
  - `NOT_APPLIED(ended | left_link)`: the link withdraws the cap after it applies the
    leg's `end_leg`.
  - `NOT_APPLIED(unknown)`: the link withdraws the cap immediately and alerts
    `CUT_NOT_APPLIED`.
  - The reply with the highest `recordedRevision` governs the cap.
  - `MISMATCH`: the link records it as the reply, alerts, and **stops** sending that key
    and revision. The `MISMATCH` counts as the recorded answer for `REDUCTION_FINAL`
    (C03). The reservation's `hold_2` at rating then waits for an operator decision.
    C03's R39-20 alarm reports it (review 54 m7).
- **Revisions (C4-2, R39-01, V52-1).** A repeat of a recorded (key, revision) is answered
  with its recorded reply. A lower revision that was never recorded is answered with the
  highest recorded revision's reply, echoing its own revision. Neither writes an entry or
  a `cut`, and neither ever supersedes. Each revision above the highest recorded writes
  one E11 and one `cut`, `APPLIED(none)` included. A revision may only lower the target.
  If a piece of a higher revision is above the recorded target at a minute, the account
  owner ignores that minute and alerts. The covered parts follow the rule above.
- **Deposed sender.** The account owner answers `STALE_SENDER` when the link's fence is
  below the highest fence recorded for that link (a deposed link owner).
- **Not a runtime notification.** The link does not write `cut_target` as a C01
  `notifications` row, so the changefeed never relays a copy. The link's re-send timer
  reads the unanswered targets from link state: a decided target that has no `CutAnswer`
  at its revision.

### Link availability query

`availability(window, rate)` returns two values, both beside committed **and held**
capacity (`occ_all`):
- the largest rate that fits over `window`;
- the earliest window of the requested length that fits `rate` within the horizon.

`fit_ranges(rate, from, until, k)` returns up to `k` maximal fit ranges, and where to
continue.

Both are reads of the latest committed generation of the owner:
- They are advisory. They are not decisions and not log entries.
- `asOfSeq` names the generation that they read.
- Their cost has a limit in steps (`counteroffer_steps`), not in time.
- They show nothing about other accounts, reservations or traffic (P1-S17).

The account owner takes the minimum of the largest rates of the legs, and the
intersection of their fit ranges (P2-S73).

### Link displacement read

| Result | Meaning | Account owner must |
|---|---|---|
| Row present, with any `attempt` | A reduction committed at a lower timestamp displaced the hold. The request **had not begun committing** (POL-07, P1-S78). The link deletes a marker in the entry that ends its attempt, so a present row is always for the current hold attempt of the link | Not write E5 in this transaction. Handle the leg as `DISPLACED` (RFC-002 §5.1), also if a partner confirm was already sent. If `attempt` is not the recorded attempt, also alert and send `query` for the leg |
| Absent | No reduction displaced the hold below the timestamp of this transaction | Confirm. A later displacement is ordered after the confirm, and the link applies RFC-001 §4.4's affected-on-convert exception |
| Lock timeout (10 ms) on an intent | A capacity-lowering transaction is in flight | Roll back the savepoint. Move **only this E5** to the next batch (J-14) |

**Why the order is exact.** Both transactions touch the marker key, so the serialisable
order of the database decides. The link:
- writes markers only in the displacing entry's own transaction, placeholder intents
  first;
- deletes a marker in the entry that ends the displaced attempt;
- never writes over a marker, and never moves one.

## Delivery and ordering

| Flow | Delivery | Effect | Ordering scope |
|---|---|---|---|
| Account owner → link commands (`hold`, `convert`, `release`, leg changes, `offer_*`, `mark_waiting`, `yield_*`, `displacement_accept`) | At least once. The account owner sends each command again, with the same identity, until it gets an answer. It routes again through the placement cache (RFC-002 §5.1, §12.1 step 4) | Exactly once, by the identities below | The total order of the link log for each link. **For each (reservation, leg): one outstanding leg command at a time, in the sequence of "Leg-command sequencing".** For each request: `mark_waiting` by `position`. No order across links |
| Link → account owner notifications | At least once: a gRPC push after commit, and the C01 runtime's Kafka relay from the link outbox as the guaranteed path. The relay key is the destination account partition | Exactly once for each identity | **None**: applied whenever new, with no high-water rule, subject to the precedence within an attempt |
| `expire_if_undecided`, `offer_outcome_if_lapsed` | At least once: sent again every 1 s while the condition is true | Idempotent: E6 at most once for each request | None |
| `cut_target` | At least once. **The link sends it again until it records the reply** (C4-1), also after a takeover (C01 `onAdopt` re-arms the timer from link state). Not relayed through Kafka | Exactly once for each (link, reduction, reservation, revision). Only a revision above the highest recorded one has an effect | None necessary. The `min` for each minute and the revision rule make the result independent of order |
| Link displacement read | A read inside the confirm transaction | — | The serialisable order of the database |
| Availability queries | Best effort; can be sent again freely | No effect | — |

### Leg-command sequencing (review 42 B1; review 54 B1, M2, D1, D2; amends C4-3)

**The sequence for each (reservation, leg) (V61-1).** The account owner sends the
commands of a leg in the order of the sequence of their deciding entries:
- A `convert` has the position of the E5 that created the part (`createdBy`). This is
  the part of the booking, or a part that a change adds later.
- An `offer_accept` on a new leg has the position of its E13 *final*.
- `end_leg`, `reduce_parts` and `offer_move_at` have the position of their change id.

Additional rules:
- The account owner keeps **one outstanding command** for each leg. It sends the next
  command only when the previous one is **answered** (see "Leg-command replies").
- The change ids always increase. Each is the deciding entry's (account partition,
  sequence).
- One gRPC call can carry commands for different legs (up to 500, each with its own
  envelope). It never carries two commands for one leg.

**After a takeover.** The new holder rebuilds the queue of each leg from its log. It
sends the pending commands again in the same order: the sequence of their deciding
entries. Pending commands are the `convert`s that are still pending (RFC-002 §5.7,
"conversions pending"), a pending `offer_accept`, and the E11s that have no E12. The
one-outstanding rule applies.

**The link rule (review 54 D2).** For each (reservation, leg), the link keeps the
recorded reply of **every** change id that it applied. A leg has few changes, and the
life of the leg sets a limit on them. The link checks in this order:
1. A change id that the link already applied gets its recorded reply. If the body is
   different, it gets `MISMATCH`.
2. A change id above the highest applied id: the link applies it.
3. A lower change id that the link never applied gets `STALE_CHANGE` and has **no
   effect**.
4. A change id from a partition that is not the owner of the reservation gets
   `MISMATCH`.

**`STALE_CHANGE` alerts.** After rule 1, a re-send by a new holder of an applied change
gets its recorded reply. It does not get `STALE_CHANGE`. `STALE_CHANGE` is still possible
after an account-owner takeover: a deposed holder can have sent a change that a re-send
now overtakes. **The account owner does not page on a `STALE_CHANGE` for a command that a
holder sent again after a takeover since its first send.** It logs it as expected. It
alerts `STALE_CHANGE` as a protocol defect only when it is unexplained, that is, when no
takeover of the partition occurred between the first send and the reply. In both cases,
the account owner counts the change as answered for E12 and does not send it again.

**Why the rule is necessary.** A leg command names only the parts that it creates or
changes, from its own first minute. So a higher change id does not contain the state that
a lower one set, and an overtaken command is lost for ever. These traces fail without the
rule and pass with it:

- **P2-S43 (confirm, then cancel immediately; common for AI agents).**
  1. E5 commits.
  2. `convert(p1)` to L gets `MOVING`.
  3. The cancel's E11 makes `end_leg(from 10:01)`.
  - Without the rule: `end_leg` gets to L first and gets `UNKNOWN_RESERVATION`. `convert`
    then creates p1 for its full window, but the buyer is told that the capacity is free
    from 10:01.
  - With the rule: `end_leg` waits for `CONVERTED`. L ends p1 at 10:01. If a defect sends
    `convert` late anyway, the applied `end_leg` has a change id above `createdBy`, so
    the link clips p1 at the applied end and alerts `CONVERT_AFTER_END`.
- **P2-S44 and P2-S94 row 2 (an extension, then a shorten).** The extension's `convert`
  for p3 `[18:00, 20:00)` is late, and the queued shorten's `end_leg(from 12:00)` waits
  for it. L ends p1, p2 and p3 at 12:00. Without the rule, p3 stays held after the
  reservation is reported ended (for ever, for "make open-ended", P2-S46).
- **Shorten, then extend (V61-1).** E11 seq 100 shortens R to 12:00, and
  `end_leg(L, from 12:00)` gets `CHANGED`. E5 seq 105 extends R to 20:00 and adds p3
  `[12:00, 20:00)`. `convert(p3)` follows, because 105 is above 100. The applied
  `end_leg` has a change id below `createdBy`, so the link does not clip p3. L holds p3
  on `[12:00, 20:00)`. After a takeover with both commands pending, the new holder sends
  `end_leg` (100) first and `convert(p3)` (105) second, so the result is the same.
- **P2-S43 / P2-S44 (cancel or shorten, then a cut; review 42 B1).** E11a (seq 100)
  sends `end_leg(from 12:00)` and gets `MOVING`. E11b (seq 101) is a cut from another
  link. E11b waits for E11a's answer. L ends the leg at 12:00, then applies E11b, which
  changes nothing after 12:00.
- **P2-S48 (an increase, then a decrease; a decrease and a cut in each order).** The
  decrease's `reduce_parts(p3: …)` waits for the `CONVERTED` of p3, so it never gets
  `UNKNOWN_PART`. A decrease and a cut each apply to the state that the other left.
  "From 10:01 its capacity … is available to other buyers" is true on L as reported.
- **`offer_move_at` on a new leg.** It waits for `ACCEPTED`. So the new leg starts at the
  earlier minute `T`, at the same minute as the old leg's `end_leg`. The new path has no
  gap.

## Idempotency

| Operation | Key | Duplicate | Same key, different body | Retention |
|---|---|---|---|---|
| `hold` | (link, request) | The recorded state (held, waiting, refused with its counter-offer, released, converted) | `MISMATCH`, alerted | The life of the request + 24 h (`link_request` row, TTL 24 h after `D`). A request record that a release made answers `TOMBSTONED` before any digest check |
| `convert` | (link, request) | `CONVERTED` again, with the same `clippedAt` | Another attempt: `MISMATCH` | As `hold` |
| `release` | (link, request) | Acknowledged again | Not applicable (the latest `D` sets the end of the tombstone) | As `hold` |
| `end_leg`, `reduce_parts`, `offer_move_at` | (link, change id) | The recorded reply of that change id | `MISMATCH` | The life of the leg on the link. The link keeps the reply of every applied change id for each (reservation, leg) |
| `offer_hold`, `offer_accept`, `offer_release` | (link, offer), for each command kind | The recorded reply. The link records `offer_release` also for an offer that it has not seen | `MISMATCH` | Until `lapse_at + release_grace`, then the offer record |
| `mark_waiting` | (link, request, position) | `IGNORED_OLDER` or `APPLIED` | Not applicable | As `hold` |
| `yield_accept`, `yield_refuse` | (link, request, attempt, **claim**, kind) | The recorded reply, with the same `newWaiterAttempt`. E3 records the claim, so a new holder sends the same identity again | Not applicable | As `hold` |
| `displacement_accept` | (link, request, attempt, kind) | The recorded reply, with the same `newWaiterAttempt` | Not applicable | As `hold` |
| Waiting-port notifications | (link, request, attempt, kind), and the **claim** for `YIELD_REQUEST` | Dropped. For `WAITING_NOTICE`, the copy with the highest `linkSeq` wins | Not applicable | Account owner: while the request is undecided, and in E2, E3 or E7 where an entry records it |
| `expire_if_undecided` | (link, request, "expire") | Answered again with the outcome | Not applicable | Until the outcome is applied |
| `offer_outcome_if_lapsed` | (link, offer, "lapse") | Answered again | Not applicable | Until the outcome is applied |
| `cut_target` | (link, reduction, reservation, **revision**) | A recorded revision gets its recorded reply. A lower revision that was never recorded gets the reply of the highest recorded revision. Neither writes anything | `MISMATCH`, alerted; the link stops sending it | The life of the reservation |

## Ownership

| State | Writer | Readers |
|---|---|---|
| Link log, occupancy, holds, waiters, yield claims, tombstones, request records, caps, `CutAnswer` entries, `link_displacement` markers, the account partition recorded for each reservation, the recorded replies for each leg | Link schedule owner (RFC-001) only | The account owner reads `link_displacement` **only**, by SQL `SELECT` in its confirm transaction. It gets all other data only through the replies of this contract, `query` and the availability query |
| Requests, attempts as recorded, E1 to E14 (E3 with the claim), reservations and the current rates of their parts, offers, cut-target records and composition, the queues of leg commands | Account owner (RFC-002) only | The link, only through the commands and replies of this contract |
| Attempt numbers and claim sequences | The link sets them. The account owner records and echoes them | Both |
| Change ids, offer ids, part ids, reservation ids | The account owner sets them | Both |
| Reduction ids (`ReductionSeq`), revisions, covered parts | The link sets them | Both |

## Timeouts and deadlines

| Item | Value | Owner and effect |
|---|---|---|
| `D`, `D_c` | For each request: `D_c = D − commit_margin` with a partner leg, `D − τ` otherwise (`τ` about 420 ms, cap near 450 ms) | No hold or grant at or after `D_c`. The senders send commands again only within the deadline of the request |
| `release_grace` | 1 min (POL-04, POL-26) | Tombstones stay until `D + release_grace`. Each Share-link hold of an unconfirmed request is gone within `release_grace` after `D` (P2-S104, P2-S114) |
| `ack_budget` | 200 ms p99 | The limit for the edge's answer. Not a C02 timeout |
| Expiry request re-send | 1 s | Link, from `ts ≥ D` while it keeps the hold |
| Waiting reconciliation | `query` every 5 s (est.) | Account owner, for each request in Holding or Waiting |
| Displacement read lock timeout | 10 ms (est.), under a savepoint | Account owner. At a timeout, only that E5 moves to the next batch (J-14) |
| Capacity-lowering transaction | The link stops it if it is not at `COMMIT` within 250 ms (est.), and proposes it again | Link (RFC-001 §5.1) |
| `cut_target` re-send | Until the link records the reply, with backoff (est. 1 s) | Link |
| `cut_target` batches and flow control | Up to 500 targets for each call, for each destination account slot. Up to 64 calls in flight for each destination slot (both est.). A deep reduction sends about 17,000 targets/s for about one minute (RFC-002 §9.7, est.) | Link. After a takeover, `onAdopt` re-arms the unanswered targets under the same limit |
| Leg-command and outcome re-sends | Until answered (see "Leg-command replies"), with backoff | Account owner (RFC-002 §5.7, §12.1). One outstanding command for each (reservation, leg). Up to 500 commands for each call, across legs |
| `offer_window`, `move_deadline` | Policy and design parameters (RFC-002 §9.6) | Account owner. The link never releases an offer hold on its own |

**Runtime results and hooks (C01; C02 does not redefine them).**
- `MOVED` and `MOVING`: refresh the placement cache and send again with the same
  identity.
- `STOPPED`: nothing commits. The sender sends again within the deadline.
- On C01 `onAdopt` of a link partition, the new holder re-arms these:
  - the expiry requests for holds after `D`;
  - the lapse backstops;
  - the unanswered `cut_target` re-sends;
  - the open `YIELD_REQUEST`s, with their claims.
- On C01 `onAdopt` of an account partition, the new holder:
  - re-arms the reconciliation timers;
  - rebuilds the leg queues and sends again in the takeover order of "Leg-command
    sequencing".
- `onMovedOut` cancels those timers.

## Versioning and compatibility

- **Package `c02.v1`.** The protobuf services are generated from the types above:
  - `LinkHoldPort`;
  - `LinkWaitingPort`;
  - `OutcomeExpiryPort`;
  - `ReservationCommandPort.CutTarget` (single and batch);
  - `LinkAvailability`.

  The field names map one to one. The C01 `CommandEnvelope` is gRPC metadata, imported
  from C01 (closes AI-42-3).
- **Additive changes** are a minor version:
  - new optional fields;
  - new reply variants that the receiver can treat as a protocol defect ("Answered",
    alerted).

  Receivers ignore unknown optional fields. In v1, no side makes a new field required.
- **Breaking changes** need `c02.v2`, served side by side. Examples:
  - a changed identity or idempotency key;
  - a changed unit;
  - a removed field;
  - a new required field;
  - a new error that the sender must act on;
  - a change to the leg-command sequence;
  - a change to the change-id, covered-part or revision rules.

  Senders move to v2 only after every receiver serves it.
- **The displacement table.** Its versions follow the link owner's migrations. The link
  owner only adds columns. While v1 is served, the primary key and the three read
  columns do not change.
- **Coordination.** These changes are C4-level decisions, and RFC-001 and RFC-002 then
  change together:
  - the `cut_target` reply set;
  - the `STALE_CHANGE` semantics;
  - the per-leg sequence.

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
  after the cut keeps the cut rate). C02 freezes with RFC errata owed:
  RFC-001 and RFC-002 cite P1-S84 (orchestrator; V61-2).
- **Not yet covered by a scenario.** These are proposed to requirements:
  - `LINK_UNAVAILABLE(link)` (RQ-42-1);
  - a second yield request to a holder that refused while it was not waiting
    (RQ-42-2);
  - a cancellation or decrease immediately after a confirmation, with a late `convert`
    (RQ-54-1).

## Conformance tests

**Provider side: the link owner (RFC-001)**, against a recorded account-owner stub.

1. **`hold` decision table.** One case for each check of RFC-001 §4.1:
   - a record made by a release gets `TOMBSTONED` with no digest check;
   - a held, then released request returns `RELEASED`;
   - `ts ≥ D_c`;
   - V1 to V6 against `m0`, with P1-S74's calendar cases;
   - `NO_FIT`, `IN_FLIGHT` and `WAITING` (P1-S12, P1-S70, P1-S73).

   A query after each refusal shows a tombstone.
2. **Arrival order (P1-S77).** The holds of two accounts arrive in the reverse of their
   receipt order. The link's verdicts follow the arrival order. A hold sent again gets
   its first verdict.
3. **Idempotency.**
   - For each operation, a duplicate gets the recorded reply.
   - The same identity with a changed body gets `MISMATCH`, and nothing changes.
   - The same body with a changed envelope is a duplicate.
   - When the record in memory is gone, `link_request` answers a repeat.
4. **Attempts.**
   - A grant keeps the attempt.
   - `yield_accept` and `displacement_accept` reply with attempt + 1.
   - `convert` with another attempt gets `MISMATCH`.
   - A stale attempt or claim gets `STALE_ATTEMPT`.
   - The end of a hold attempt closes every claim on it, and its re-sends stop.
5. **Yield claims (review 42 M1, review 54 M3).**
   - **Refusal, then mark:** claim c1 is refused, the mark is set, a new claim c2 is
     accepted, and the cycle breaks (P2-S19, P2-S87).
   - **Mark, then refusal:** the mark arrives while c1 is open, then `yield_refuse(c1)`
     arrives. The link raises c2 immediately, c2 is accepted, and the cycle breaks.
   - `yield_refuse(c1)` ends only c1.
6. **Change ids (review 54 D2).** For `end_leg`, `reduce_parts` and `offer_move_at`, for
   each cause:
   - an applied lower id, sent again after a higher one, gets its recorded `CHANGED`;
   - a lower id that the link never applied gets `STALE_CHANGE`, and occupancy does not
     change;
   - absolute pieces are clipped to the window of the part.
7. **`convert` backstop (review 54 D1, V61-1).**
   - A `convert` whose `createdBy` is below the change id of an applied `end_leg` on the
     leg clips the new part at that end. It returns `clippedAt` and alerts
     `CONVERT_AFTER_END`.
   - A `convert` whose `createdBy` is above the change id of every applied `end_leg` is
     not clipped.
8. **`applies` (C4-4).**
   - Cause `POL07` without `applies` gets `INVALID(applies)`.
   - `applies` with another cause gets `INVALID(applies)`.
   - A pair that names an unknown own reduction gets `UNKNOWN_REDUCTION`.
   - Covered parts above the cap raise `CUT_TARGET_UNMET`.
9. **`cut_target` sender (C4-1, C4-2, R39-01, review 54 D4).**
   - Each reservation of `A_R` gets one target, with the `none` and offer-scoped targets.
     Each target has the account partition of the reservation.
   - The link sends each target again from link state until it records a reply, also
     across a takeover. A target is never a runtime notification row.
   - A revision ≥ 2 has the covered parts of revision 1, less ended parts. It goes only
     when it is strictly lower at one or more minutes, or when it omits ended parts.
   - Each reply variant moves the cap as "Semantics" states. The highest
     `recordedRevision` governs.
   - `MISMATCH` stops the re-sends and counts for `REDUCTION_FINAL`.
   - A batch has 500 targets or fewer. Up to 64 calls are in flight for each destination
     slot.
10. **Displacement markers.**
    - The capacity-lowering transaction writes its intents first.
    - No marker is written over.
    - Convert, release and accepted displacement delete the marker.
    - The plan of the point read is a single-key lookup.
    - A link move does not touch the rows.
    - The database orders the concurrent-confirm race (T-12) exactly.
11. **Offers.**
    - The combined step-function check.
    - The `INVALID` limits of `offer_accept` and `offer_move_at`.
    - A late `offer_accept` is applied as decided.
    - `offer_release` removes the parts and their cap.
    - Release before hold makes a later `offer_hold` get `TOMBSTONED`.
    - An `offer_hold` at `ts ≥ lapse_at` gets `TOMBSTONED`.
    - The link sends the lapse backstop and keeps the parts.
12. **Expiry.** The link keeps a hold after `D`, sends `expire_if_undecided` every 1 s,
    and converts or releases on the answer.
13. **Notifications.**
    - A `GRANTED` lost on the push and relayed late still gets applied.
    - The identity is the same on the relay and on the push.
    - `DISPLACED` is never sent for a waiter.

**Consumer side: the account owner (RFC-002)**, against a recorded link stub.

1. **Attempts.**
   - The account owner records the attempt from each message kind.
   - It never sets an attempt number.
   - It drops stale attempts.
   - On `STALE_ATTEMPT`, it queries the leg.
2. **No high-water rule.**
   - A late `GRANTED` gets applied.
   - Duplicate notifications have no effect.
   - `query` finds a dropped `DISPLACED`.
   - A `WAITING_NOTICE(a)` after `GRANTED(a)` causes no E2.
   - A yield request with a new claim gets an answer, and E3 records the claim.
3. **Leg-command sequencing (review 42 B1, review 54 B1).**
   - The account owner sends the commands of (R, L) in the sequence of their deciding
     entries: a `convert` at the position of its E5, and leg changes at their change id.
     It sends no later command while an earlier one is unanswered.
   - After a takeover, the pending commands go again in the same order.
   - Two leg commands for one leg are never in flight together.
   - `offer_move_at` waits for `ACCEPTED`.
   - Different legs are coalesced.
4. **Leg-command replies (review 54 M1).**
   - Each error variant in the reply table moves the queue on, or causes a retry, as the
     table states.
   - No variant stalls a queue.
   - A `STALE_CHANGE` after a takeover is logged and causes no page.
   - An unexplained `STALE_CHANGE` is alerted.
5. **`cut_target` reply (C4-1, C4-2, R39-01, V52-1, V52-2, review 54 D4 and D5).**
   - For a revision above the highest recorded, the reply goes only after the E11 or E13
     commits.
   - Each row of the case table is covered, including both "offer Final" rows.
   - A repeat gets its recorded reply.
   - Revision 1 after revision 2 gets the reply of revision 2, echoing revision 1.
   - Neither of these writes an entry.
   - A higher revision with equal content still writes its E11 (`APPLIED([])`).
   - A revision ≥ 2 that adds a part gets `MISMATCH`.
   - A piece above the recorded target is ignored and alerted.
   - A link fence below the recorded fence gets `STALE_SENDER`.
   - A target for an account that moved gets `MOVED`.
   - A batch item for a moved account gets its own `RoutingRefusal`, and the other items
     get their replies.
6. **Composition.**
   - Two links and two reductions give the same part rates in either arrival order (S16,
     T15).
   - A target binds only covered parts.
   - An offer-scoped target applies only at Final.
   - A move that becomes Final after a cut sends `reduce_parts` at the cut rate, after
     `ACCEPTED` (P1-S84).
   - Each leg change names every applied pair.
7. **Displacement read.**
   - A present row, with any attempt, means no E5.
   - An attempt that does not match the recorded attempt causes an alert and a `query`.
   - A 10 ms lock timeout moves only that E5.
   - A present row after a partner confirm still stops E5 (P1-S78).
8. **Release fan-out.**
   - Each Share leg of the intake gets `release`.
   - A `REFUSED` or `WAITER_REFUSED` is the release acknowledgement for E8.
   - `UNKNOWN_LINK` or `LINK_RETIRED` in reply to `release` completes E8.
9. **Unavailable link (M-2).**
   - `UNKNOWN_LINK`, `LINK_CLOSING` or `LINK_RETIRED` on `hold` gives E7 *rejected*
     `LINK_UNAVAILABLE(link)`, with no counter-offer.
   - Then every leg gets `release`.
   - On `offer_hold`, the offer is Refused.
10. **Offers.**
    - `offer_release` goes to each leg that got `offer_hold`, also when the reply was
      lost.
    - `offer_outcome_if_lapsed` gets `offer_accept` or `offer_release` when the offer is
      decided, and nothing while the offer is open.
11. **Expiry answer.**
    - On `expire_if_undecided`, E6 is written only if the request is undecided.
    - The answer is `convert` or `release`, sent after the commit.

**Joint tests.** The replay of recorded traces through both real owners covers:
- P1-S78, rows 1 to 3.
- P2-S19 and P2-S87 (crossing and cycle), with both the order "refuse, then mark" and the
  order "mark, then refuse".
- P1-S52 with accept, decline and a failed partner leg.
- P1-S84 row 2, with `reduce_parts` delivered before `offer_accept`.
- One case for each "offer Final" row of the case table (`move_at ≤ T_eff` and
  `move_at > T_eff`).
- Shorten, then cut on one leg, with the first call answered `MOVING`. The link ends the
  leg at 12:00.
- **Confirm, then cancel, with `convert` answered `MOVING`. L ends p1 at 10:01** (review
  54 B1, P2-S43).
- **P2-S94 row 2 with a late `convert`**: L ends p3 with the shorten.
- **Shorten, then extend (V61-1): L holds p3 `[12:00, 20:00)`.** The test also runs
  with an account-owner takeover while both commands are pending.
- A decrease and a cut on one leg, in both orders (P2-S48).
- An account-owner takeover between two changes of one leg. The change sent again gets
  its recorded `CHANGED`, and no page occurs.
- P2-S104, with the decision record unavailable at `D`.

## Settled

No mismatch is open. A binding orchestrator decision settles each point below, and C02
applies it. The errata make the RFCs agree with C02. C02 does not edit an RFC.

| # | Point | Settled form | Errata |
|---|---|---|---|
| C4-1 | How a cut target is answered and delivered | The answer is the synchronous reply to `cut_target`: `APPLIED(change ids \| none)`, `NOT_APPLIED(ended \| left_link \| unknown)` or `KEPT_FOR_OFFER(offer)`, given after E11 or E13 commits. There is no `cut_target_answer`. **The link sends `cut_target` again, from link state, until it records the reply**, also after a takeover. A target is not a runtime notification. A re-send is idempotent by (link, reduction, reservation, revision) | RFC-000 §8 (remove `cut_target_answer` from the link hold port row). RFC-001 §5.4, §7.1 (`link_outbox` does not carry `cut_target`), §11 (`CutAnswer` recorded from the reply; remove the `cut_target_answer` row; the re-send replaces the Kafka relay). RFC-002 §2.5, §9.7 (the answer is the reply, not a notification) |
| C4-2, R39-01 and V52-1 | Target revision | `cut_target` carries `revision`. It increases for each key and can only lower the target. The reply echoes it and carries `recordedRevision`. A repeat of a recorded (key, revision) is answered with its recorded reply. A lower revision that was never recorded is answered with the highest recorded revision's reply, echoing its own revision. Neither writes an entry or a `cut`, and neither ever supersedes. Each revision above the highest recorded writes one E11 and one `cut`, `APPLIED(none)` included | RFC-000 §8 (reservation command port row: idempotent by key **and revision**). RFC-002 §9.7, §13.1. RFC-001 §5.4 (when a revision ≥ 2 is sent). Same text as C03 v2.3 rule 3 and C04 v2.2 "Cut" |
| Review 54 M4 (D4) | Covered parts across revisions | Revision 1 sets the covered parts. A revision ≥ 2 has the same parts, less ended parts, and never adds one. A revision ≥ 2 goes only when it is strictly lower at one or more minutes, or when it omits ended parts. A revision that adds a part gets `MISMATCH`, alerted | RFC-001 §5.4. RFC-002 §9.7. C03 erratum (R39-01 (c), PT-6): applied in C03 v2.3. The definition of an ended part (V61-5) is the same in C02, C03 and C04 |
| C4-3, amended by review 42 D1 and review 54 D1 and D2 | Order of leg commands | For each (reservation, leg), the account owner keeps **one outstanding command**. The commands go in the sequence of their deciding entries: a `convert` at the position of its E5 (`createdBy`), an `offer_accept` at that of its E13 *final*, and `end_leg`, `reduce_parts` and `offer_move_at` at their change id. After a takeover, the pending commands go again in the same order (V61-1). The link keeps the reply of every applied change id. An applied id gets its recorded reply. Only a lower id that the link never applied gets `STALE_CHANGE`. That reply counts as answered. It is logged without a page after a takeover, and alerted only when unexplained. The link clips a `convert` only when an applied `end_leg` has a change id above `createdBy`, and alerts `CONVERT_AFTER_END` | RFC-000 §8 (link hold port row, AI-42-1 as AI-54-1 extends it: "for each (reservation, leg), the account owner keeps one outstanding command among `convert`, `offer_accept`, `offer_move_at`, `end_leg` and `reduce_parts`, in the creation and change-id order of that leg"). RFC-001 §4.4 (the clip), §11.1 (the reply for each change id, `offer_move_at` with a change id). RFC-002 §5.7 (`convert` in the per-leg sequence), §9.2, §9.7, §12.1 step 4, §13.2 |
| Review 54 M1 | Leg-command replies | The table "Leg-command replies": retry only for routing refusals and `UNAVAILABLE`. Every other error is answered, alerted as a defect, and counted for E12 | RFC-002 §9.7, §13.2 |
| C4-4 | `end_leg` POL-07 pairs | `applies` names every applied (link, reduction). It is present only if the cause is `POL07`. Otherwise the link answers `INVALID(applies)` | RFC-001 §11.1 `end_leg` row |
| C4-7 | Runtime hooks and results | From C01. C02 imports C01's `CommandEnvelope` and `RoutingRefusal` | RFC-001 and RFC-002, as RFC-000 4.4 states |
| M-1 | Lapse backstop for an offer hold | `offer_outcome_if_lapsed(offer)` on the outcome and expiry port, with identity (link, offer, "lapse"). The account owner answers with `offer_accept` or `offer_release` again when the offer is decided. The link keeps the offer parts until then | RFC-002 §13.1. RFC-001 §5.6 and §11.1 (the link sends it; new row) |
| M-2, with review 42 M5 | `UNKNOWN_LINK`, `LINK_CLOSING`, `LINK_RETIRED` | On `hold` and `offer_hold`, the link records **no tombstone**. The account owner rejects the request with **`LINK_UNAVAILABLE(link)`** and no counter-offer, and releases every leg. For an offer, the offer is Refused. `UNKNOWN_LINK` or `LINK_RETIRED` in reply to `release` or `offer_release` is the acknowledgement of that leg. RFC-001 retires a link only when it has no holds, offer holds or parts | RFC-002 §5.1, §2.2 (E7 reason), §13.2. RFC-001 §11. Requirements RQ-42-1 |
| M-3 | Cause of a POL-07 revocation | One cause, `POL07`, with the applied (link, reduction) pairs required: a revocation is a cut to 0. Endings outside the policy (cancel, shorten, end of window, release after grace, operator termination, move) keep their own causes | RFC-001 §11.1 (remove `revoke`). RFC-002 §9.7 (remove "(RFC-001's "revoke")") |
| Review 42 M1, review 54 M3 and m1 (D2, D3) | Yield claims | Every yield request carries a `claim` that the link sets. The claim is part of `YIELD_REQUEST`, of `yield_accept` and `yield_refuse`, and of both identities. A refusal ends only that claim. When the link records a refusal, it raises a new claim immediately if the holder's mark is set and an older waiter is still blocked by that attempt. The end of a hold attempt ends every claim on it | RFC-001 §4.3, §11.1 (replace "at most one outstanding per (request, attempt)"). RFC-002 §2.2 (E3 records the claim), §5.3, §13.2. Requirements RQ-42-2 |
| Review 42 M2, review 54 m3 | Routing to an account partition | C02 imports C01's `CommandEnvelope`, which carries the routed generation and the sender sequence. The C02 body carries `receiverPartition`. `cut_target` carries the account partition of the reservation. In a batch, each item has its own envelope, and the reply is per item (`RoutingRefusal` for each item) | RFC-001 §11, RFC-002 §2.5, §13.1 |
| Review 42 M3 (D3) | The move's `reduce_parts` on a new leg | It goes only after `ACCEPTED` of the leg's `offer_accept` (per-leg sequence) | RFC-002 §9.6, §12 (S18) |
| Review 42 M4, review 54 m4 (D4 of review 42) | Offer holds that nobody releases | `offer_release` goes to every leg that got `offer_hold`. The link records it also for an offer that it has not seen. `offer_hold` gets `TOMBSTONED` after a release, or at `ts ≥ lapse_at` | RFC-002 §9.6. RFC-001 §5.6, §11.1 |
| V52-2, review 54 M5 (D5) | Offer-scoped target, offer Final with this link on the new path | Two rows of the case table. "`offer` set, offer Final with this link on the new path, `move_at ≤ T_eff`: E11 cause *cut*, `APPLIED`" (V52-2 text, with V61-4). "`move_at > T_eff`: E11 cause *cut*, which binds the moved parts from `max(T_eff, move_at)`, `APPLIED`". Together: a normal cut for any `move_at` | RFC-002 §9.6, §9.7. C04 erratum (lines 342, 487, 537, PL-3) and C03 V52-2 restatement: applied in C04 v2.2 and C03 v2.3. RFC-000 C4 freeze note (AI-54-2) |
| Review 54 m7 | `cut_target` `MISMATCH` and `REDUCTION_FINAL` | The `MISMATCH` counts as the recorded answer for `REDUCTION_FINAL`. Rating's `hold_2` for the reservation waits for an operator decision, and C03's R39-20 alarm reports it | C03 (state it under `REDUCTION_FINAL`) |
| Review 42 M6, review 54 m5 | Errata list | This table, and these additional errata: (a) RFC-000 §8 C4 freeze note (revision 4.5): the rows of the link hold port, the link waiting port and the reservation command port refer to C02 v1 (AI-42-2, AI-54-1, AI-54-2). (b) RFC-002 §2.5: `yield_accept`, `displacement_accept`, the expiry answer and the cut answer are synchronous commands or replies, not outbox notifications. `expire_if_undecided` arrives as a gRPC command. (c) RFC-002 §13.2: remove "a later displacement of a re-granted attempt replaces it" and "a marker for an earlier attempt is ignored". A present marker of any attempt stops E5. (d) RFC-001 §11.1 `YIELD_REQUEST`: remove "one outstanding per (request, attempt)". (e) RFC-002 §2.2 E3 records the claim. (f) RFC-002 §5.7: `convert` is in the per-leg sequence. (g) **P1-S84**: RFC-001 (§5.6, §13) and RFC-002 (§9.6, §9.7, traceability) cite it, and RFC-002 §9.6 states the move's `reduce_parts`. C02 freezes with this erratum owed (V61-2) | As listed |
| Review 42 M7 | Key of the displacement table | The primary key is exactly (`link_id`, `request_part`, `request_seq`), with no slot column. A link move does not move or write the rows | RFC-001 §7.1. RFC-006 §5.5 (the slot-first convention applies only to log and outbox tables) |

## Errata owed

C02 is frozen. These errata are owed by other documents. They do not change C02.

| Owed by | Erratum | Source |
|---|---|---|
| RFC-001, RFC-002 | Cite P1-S84 (RFC-001 §5.6, §13; RFC-002 §9.6, §9.7, traceability). RFC-002 §9.6 states the move's `reduce_parts` | V61-2, review 54 m8 |
| RFC-000 §8 | C4 freeze note (revision 4.5): the rows of the link hold port, the link waiting port and the reservation command port refer to C02 v1 | AI-42-1, AI-42-2, AI-54-1, AI-54-2 |
| RFC-001 | The items in the "Errata" column of the Settled table, and the `convert` clip rule with `createdBy` (§4.4, §11.1) | Settled table, V61-1 |
| RFC-002 | The items in the "Errata" column of the Settled table, and the sequence of leg commands by deciding entry, takeover included (§5.7, §9.7, §12.1 step 4) | Settled table, V61-1 |
| RFC-006, C01 | The slot-first convention applies only to log and outbox tables (§5.5) | Review 42 M7 |
| Requirements | RQ-42-1, RQ-42-2, RQ-54-1 | Reviews 42, 54 |

## Fix verification 61 resolution

| Item | Severity | Resolution in 1.0.0 |
|---|---|---|
| V61-1 | Major | Applied. Every leg command goes in the sequence of its deciding entry, takeover re-sends included. `ConvertCmd` has `createdBy`. The link clips a `convert` only when an applied `end_leg` has a higher change id. Joint test "shorten, then extend: L holds p3 `[12:00, 20:00)`", also across a takeover. Provider test 7 and consumer test 3 changed |
| V61-2 | Minor | Applied. The freeze gate is replaced by "freezes with RFC errata owed". C03 v2.3 and C04 v2.2 are pinned. The C03 and C04 errata in the Settled table are marked as applied |
| V61-4 | Minor | Applied. The row "offer Final, `move_at ≤ T_eff`" has "with this link on the new path" |
| V61-5 | Minor | Applied. The definition of an ended part is added word for word under "Covered parts" |
| V61-3, V61-6 | Minor | C03 and C04 items. Not in C02 |

## Review 54 resolution

| Finding | Severity | Resolution in draft.3 |
|---|---|---|
| B1 | Blocker | Applied as D1. **Changes:** `convert` and `offer_move_at` join the per-leg sequence, and `offer_move_at` gets a change id. The takeover order sent pending `convert`s first (superseded in 1.0.0 by V61-1: order by deciding entry). The link clips a late `convert` and alerts `CONVERT_AFTER_END` (`clippedAt`). The P2-S43, P2-S44/S94 and P2-S48 traces are stated. **Tests:** consumer 3, provider 7, and joint tests for "confirm, then cancel" and P2-S94 row 2. **Errata:** RFC-002 §5.7, §9.7, §12.1, RFC-000 AI-54-1 |
| M1 | Major | Applied. The "Leg-command replies" table puts every reply in "retry" or "answered", so no queue stalls. The unreachable branch of the M3 timeout row is removed. **Test:** consumer 4 |
| M2 | Major | Applied as D2. The link keeps the reply of every applied change id, and an applied id gets its recorded reply. `STALE_CHANGE` is only for a lower id that the link never applied. As the orchestrator decided, the account owner does not page on a `STALE_CHANGE` after a takeover; it alerts only when no takeover explains it. **Tests:** provider 6, consumer 4, and a joint takeover test |
| M3 | Major | Applied as D3. A refusal recorded while the mark is set raises a new claim immediately. **Tests:** provider 5 and the joint P2-S19/P2-S87 test cover the order "mark, then refusal" |
| M4 | Major | Applied as D4. Revision 1 sets the covered parts. A later revision only omits ended parts, and adding a part gets `MISMATCH`. The rule for sending a revision ≥ 2 matches. **Errata:** C03 R39-01 (c), PT-6 |
| M5 | Major | Applied as D5, with V52-2's exact row. A second row covers `move_at > T_eff`, from `max(T_eff, move_at)`. **Errata:** C04, AI-54-2 |
| m1 | Minor | Applied. The end of a hold attempt ends every claim on it. The schema comment is corrected |
| m2 | Minor | Applied. E3 records the claim (erratum RFC-002 §2.2) |
| m3 | Minor | Applied. `Batch` items each have their own C01 envelope, and `BatchReply` has a reply or a `RoutingRefusal` for each item. This applies to cut targets and to coalesced leg commands |
| m4 | Minor | Applied. `offer_hold` check (0): `ts ≥ lapse_at` gives `REFUSED(TOMBSTONED)` |
| m5 | Minor | Applied. Errata (c) to (f) are added to the Settled table |
| m6 | Minor | Applied. The "Revisions" bullet and the case table use V52-1's exact text |
| m7 | Minor | Applied. `MISMATCH` counts for `REDUCTION_FINAL`, and `hold_2` waits for an operator decision (C03 R39-20) |
| m8 | Minor | Applied as a freeze gate in draft.3. Superseded by V61-2: C02 freezes with RFC errata owed |
| RQ-54-1 | Requirements | Proposed, not decided here. Listed under Scenarios |
| AI-54-1, AI-54-2 | Architecture | Carried as errata in the Settled table |
| V52-1, V52-2 (review 52) | C03 fix verification | Applied with their exact text: the "Revisions" bullet, the case table, and the row "offer Final, `move_at ≤ T_eff`" |

## Review 42 resolution (draft.2, kept for the record)

| Finding | Severity | Resolution |
|---|---|---|
| B1 | Blocker | One outstanding leg change for each (reservation, leg); the order of re-sends after a takeover. Draft.3 extends this to `convert` and `offer_move_at` (review 54 B1) |
| M1 | Major | Link-set `claim` in yield identities. Draft.3 adds the re-ask after a refusal (review 54 M3) |
| M2 | Major | Receiver partition, routed generation and sender sequence. Draft.3 imports them from C01 |
| M3 | Major | The move's `reduce_parts` goes after `ACCEPTED` |
| M4 | Major | `offer_release` to every leg that got `offer_hold`; `offer_hold` can get `TOMBSTONED` |
| M5 | Major | `UNKNOWN_LINK` or `LINK_RETIRED` on `release` is the acknowledgement |
| M6 | Major | Errata list (completed again in draft.3) |
| M7 | Major | Displacement key without a slot column |
| m1 to m12 | Minor | Applied in draft.2. Their text is kept |
| R39-01 | Blocker (C03) | Applied. Draft.3 uses V52-1's exact text |
