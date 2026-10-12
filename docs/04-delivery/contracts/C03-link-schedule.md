# C03. Link schedule: supply commands and the link schedule feed

| | |
|---|---|
| Contract ID | C03 (`link-schedule`) |
| Version | 1 (draft for `contract-C03-v1`) |
| Status | **Draft**, for contract review. No open mismatches: M1 and M2 were settled by the orchestrator (see "Settled"). Errata owed: RFC-001 (settled M1), RFC-002 and RFC-003 (M2) |
| Provider | RFC-001 (link schedule owner) |
| Consumers | Supply commands: callers are the supplier API (supplier principals through RFC-005's edge) and the operator console (network-operations envelope, RFC-005 §7.4). Schedule feed: RFC-002 (account owner), RFC-003 (rating), RFC-006 (history, notifier, alerting) |
| Transport | Supply commands: synchronous command, gRPC to the owner-lease holder of the link's slot (RFC-000 §8). Schedule feed: Kafka event from the link outbox (`link_outbox`) through the changefeed relay, topic `link.schedule.v1`; `CLOSED` markers produced by the closure emitter of C01 |
| Pinned to | `requirements-v1.10`; RFC-000 rev. 4.4 (§8 rows "Link supply commands" and "Link schedule feed"; errata C4-2, C4-7); RFC-001 rev. 5 (§2, §3.1, §5, §7.1, §7.2, §7.5, §8, §11); RFC-002 rev. 5 (§9.4, §9.6, §9.7, §13.2); RFC-003 rev. 5 with erratum 5.1 (§5.1, §5.2, §5.6, §5.7, §7); RFC-005 rev. 5 (§3.4, §7.4, C11, the caller allowlist); RFC-006 rev. 6 (§5.3 to §5.5, §12.5), through C01 |

## Purpose

This contract carries two things. First, the commands by which a link's supply changes:
an unplanned outage and its restoration, booking and cancelling maintenance, announcing a
permanent reduction, and recording a permanent increase. Second, the link's schedule
feed. The feed is a projection of the link log: capacity history, affected flags, each
permanent reduction's projected and frozen affected set, its cut decisions and its final
step, and the per-link closed time.

The feed is the single source from which:

- RFC-002 marks reservations affected at route level and opens equivalent-path offers;
- RFC-003 marks reservation lines affected and holds closure across a permanent
  reduction;
- RFC-006 keeps history, sends affected notices, and alerts.

Cut targets themselves are **not** in this contract. They are the reservation command
port (`cut_target` / `cut_target_answer`, RFC-000 §8, its own contract). `CUT_DECIDED`
here is the feed copy of the same decision.

Closure-marker production, `feed_seq` reads, partition moves, and the runtime results
`Moving` and `Stopped` are defined by **C01, the platform contract** (RFC-000 §8
"Substrate conventions", RFC-006 rev. 6). This contract only states what they mean for
this link feed.

## Schema

### Common types

```ts
/** Minute index: whole minutes since 1970-01-01T00:00Z (RFC-001 §2). Unit: minutes. */
type UtcMinute = number;            // integer
/** Database HLC commit timestamp, "<wall nanoseconds>.<logical>" in decimal (RFC-001 §2). */
type HlcTimestamp = string;
/** Reserved or capacity rate. Unit: whole Mbps, >= 0 (POL-31). */
type Mbps = number;                 // integer
type LinkId = string;               // catalogue link registry id, opaque
type ReservationId = string;
type LegId = string;
type PartId = string;
type OfferId = string;
/** Identity of a supply fact: the link-log sequence of the entry that recorded it, decimal.
 *  Unique per link; ReductionId, OutageId, MaintenanceId and IncreaseId are all of this form. */
type FactId = string;
type ReductionId = FactId;
type PseudonymousPrincipal = string; // RFC-005; never personal data
type ReasonRef = string;             // RFC-005 reason code reference; no free text

/** Half-open minute range [from, to); to = null means open-ended. */
interface MinuteRange { from: UtcMinute; to: UtcMinute | null }

/** Step function: each piece holds from its `from` until the next piece's `from`;
 *  the last piece holds until `until` (null: open-ended). Strictly increasing `from`. */
interface Pieces { pieces: { from: UtcMinute; mbps: Mbps }[]; until: UtcMinute | null }
```

### Supply commands (gRPC `LinkSupply` service)

```ts
/** Every supply command carries this envelope (RFC-001 §11). */
interface SupplyCommandHeader {
  link_id: LinkId;
  key: string;                       // idempotency key, 1..128 printable ASCII; on the console
                                     // path it MUST equal envelope.action_id (settled M1)
  routed_epoch: number;              // slot epoch the caller routed with (C01 placement)
  sender: { component: 'edge' | 'console'; partition: string; generation: number; epoch: number };
  principal: {                       // RFC-005 principal context
    principal_id: PseudonymousPrincipal;
    tenant: string;                  // supplier tenant, or 'share-operations' for operators
    role: 'supplier_user' | 'supplier_admin' | 'supplier_key' | 'network_operations';
    probe: boolean;
  };
  reason_ref?: ReasonRef;            // required on the console path (carried in the envelope too)
  envelope?: OperatorEnvelope;       // RFC-005 §7.4; present iff sender.component = 'console'
}

type OperatorEnvelope = unknown;     // schema owned by RFC-005's operator envelope contract;
                                     // target = link_id, target_version = registry version (settled M1)

type SupplyRequest =
  | { op: 'record_outage';       h: SupplyCommandHeader; to_capacity: Mbps;
      attribution: 'supplier' | 'unattributed' }
  | { op: 'record_restoration';  h: SupplyCommandHeader; outage: FactId; to_capacity?: Mbps }
  | { op: 'book_maintenance';    h: SupplyCommandHeader; rate: Mbps;
      window: { from: UtcMinute; to: UtcMinute } }          // closed window, both boundaries
  | { op: 'cancel_maintenance';  h: SupplyCommandHeader; maintenance: FactId }
  | { op: 'announce_reduction';  h: SupplyCommandHeader; new_capacity: Mbps }
  | { op: 'record_increase';     h: SupplyCommandHeader; new_capacity: Mbps };

type SupplyResult =
  | { result: 'RECORDED_OUTAGE'; outage: FactId; level: Mbps; effective_from: UtcMinute;
      capacity_in_force_from_then: Mbps }
  | { result: 'RECORDED_RESTORATION'; effective_from: UtcMinute; capacity_in_force_from_then: Mbps }
  | { result: 'CONFIRMED_MAINTENANCE'; maintenance: FactId }
  | { result: 'REJECTED_MAINTENANCE';
      reason: 'NEEDS_COMMITTED'                            // wait, or announce a reduction
            | 'NOTICE_TOO_SHORT'                           // with maintenance_notice_days
            | 'IN_FLIGHT';                                 // with retry_after_ms
      maintenance_notice_days?: number;                    // unit: calendar days (14)
      retry_after_ms?: number }                            // unit: ms (POL-05)
  | { result: 'CANCELLED_MAINTENANCE'; free_from: UtcMinute }
  | { result: 'RECORDED_REDUCTION'; reduction: ReductionId; t_eff: UtcMinute }
  | { result: 'RECORDED_INCREASE'; increase: FactId; announced_from: UtcMinute;
      capacity_in_force_from_then: Mbps };

type SupplyError =
  | 'INVALID'                // with rule: see Semantics
  | 'UNKNOWN_OUTAGE' | 'UNKNOWN_MAINTENANCE'
  | 'UNKNOWN_LINK'           // also the answer to any unauthorised principal (X1-S22)
  | 'FORBIDDEN_ROLE'         // network operations attempting a supplier-only op (X1-S23)
  | 'ENVELOPE_REFUSED'       // with the failed RFC-005 §7.4 check number (settled M1)
  | 'LINK_CLOSING'           // book_maintenance only
  | 'LINK_RETIRED'
  | 'MISMATCH'               // same key, different content
  | 'NOT_OWNER' | 'STALE_EPOCH' | 'STALE_SENDER'
  | 'UNAVAILABLE';           // includes runtime Moving (retry) and Stopped (C01; C4-7)

interface SupplyErrorReply {
  error: SupplyError;
  rule?: string;             // for INVALID: e.g. 'not_below_announced', 'not_whole_mbps'
  check?: 1 | 2 | 3 | 4 | 5 | 6;   // for ENVELOPE_REFUSED
  owner_hint?: { slot: string; epoch: number };   // for NOT_OWNER
  retry_after_ms?: number;   // for UNAVAILABLE (Moving: about 100 ms)
}
```

### Schedule feed (`link.schedule.v1`)

Kafka record: **key** = `link_id`. **Headers** (C01, RFC-006 §5.4): `partition` (= link_id),
`stream` = `schedule`, `stream_seq` (= `feed_seq`; absent on `CLOSED`), `generation`,
`epoch`, `ts`, `kind`, `schema_v`, `key_id`; `resolved` on `CLOSED`. The **value** is
ciphertext under RFC-005's feed key. The types below are the plaintext.

```ts
interface FeedEventBase {
  link_id: LinkId;
  feed_seq: number;          // contiguous per link from 1, across owner changes and moves
  log_seq: string;           // causing link-log sequence
  generation: number; epoch: number;
  ts: HlcTimestamp;          // commit timestamp of the batch that wrote the event
  probe: boolean;            // link is a probe link (POL-06): exclude from rating, settlement, reports
}

type ScheduleEvent =
  | LegConfirmed | LegChanged | CapacityChanged | AffectedChanged | AffectedNotice
  | OfferAffected | ReductionAffected | ReductionEffective | ReductionSetExtended
  | CutDecided | ReductionFinal | LinkAlert;

interface PartRate { part: PartId; rate: Mbps; window: MinuteRange; age: HlcTimestamp }

interface LegConfirmed extends FeedEventBase {
  kind: 'LEG_CONFIRMED'; reservation: ReservationId; leg: LegId; parts: PartRate[];
  effective_from: UtcMinute; known_at: HlcTimestamp }

interface LegChanged extends FeedEventBase {
  kind: 'LEG_CHANGED'; reservation: ReservationId; leg: LegId; change_id: string;
  cause: 'cancel' | 'shorten' | 'revoke' | 'release' | 'terminate' | 'move' | 'decrease' | 'POL-07';
  applies?: { link: LinkId; reduction: ReductionId }[];        // cause POL-07
  parts: { part: PartId; rate: Pieces }[];                     // absolute, after the change
  effective_from: UtcMinute;                                   // may be < floor_minute(ts): late change
  late: boolean; known_at: HlcTimestamp }

interface CapacityChanged extends FeedEventBase {
  kind: 'CAPACITY_CHANGED';
  change:
    | { type: 'outage'; outage: FactId; level: Mbps; attribution: 'supplier' | 'unattributed' }
    | { type: 'restoration'; outage: FactId; level_after: Mbps | null /* null: ended */ }
    | { type: 'maintenance'; maintenance: FactId; rate: Mbps; window: MinuteRange }
    | { type: 'maintenance_cancelled'; maintenance: FactId; freed: MinuteRange }
    | { type: 'maintenance_cut'; maintenance: FactId; reduction: ReductionId; t_eff: UtcMinute;
        new_rate: Mbps /* 0: cancelled from t_eff */; capacity_freed_from: UtcMinute;
        supplier_notice_due: HlcTimestamp }
    | { type: 'reduction_announced'; reduction: ReductionId; level: Mbps; t_eff: UtcMinute }
    | { type: 'increase'; increase: FactId; level: Mbps };
  effective_from: UtcMinute;                 // boundary the change takes effect from
  sellable_capacity: Pieces;                 // K_s from effective_from
  physical_capacity: Pieces;                 // K_p from effective_from
  principal: PseudonymousPrincipal; role: string; reason_ref?: ReasonRef }

interface AffectedChanged extends FeedEventBase {
  kind: 'AFFECTED_CHANGED'; reservation: ReservationId; leg: LegId; part: PartId;
  ranges: MinuteRange[];                     // full current set for (reservation, part); [] = no longer affected
  causes: FactId[];                          // binding outages; or the reduction for a confirm across it
  cause_kind: 'outage' | 'confirmed_after_reduction' | 'restoration' | 'late_change';
  notice_due: HlcTimestamp }

interface AffectedNotice extends FeedEventBase {
  kind: 'AFFECTED_NOTICE'; reservation: ReservationId; leg: LegId; part: PartId;
  of_feed_seq: number; recipients: ('holder' | 'network_operations')[] }

interface OfferAffected extends FeedEventBase {
  kind: 'OFFER_AFFECTED'; offer: OfferId; reservation: ReservationId;
  ranges: MinuteRange[]; notice_due: HlcTimestamp }

interface ReductionAffected extends FeedEventBase {
  kind: 'REDUCTION_AFFECTED'; reduction: ReductionId; t_eff: UtcMinute;
  as_of_log_seq: string; chunk: number; of: number;           // chunks of one projection output
  changed: { reservation: ReservationId; part: PartId; offer?: OfferId; cut: Mbps /* 0: no longer cut */ }[] }

interface ReductionEffective extends FeedEventBase {
  kind: 'REDUCTION_EFFECTIVE'; reduction: ReductionId; t_eff: UtcMinute; level: Mbps /* L_R */;
  q: string; cut_set_size: number; digest: string;
  extension: number;                         // 0: the frozen set; k >= 1: k-th late extension
  chunk: number; of: number;                 // 1-based; `of` fixed within (reduction, extension); >= 1
  reservations: ReservationId[] }            // <= 1,000; A_R members only (no offer-only reservations)

interface ReductionSetExtended extends FeedEventBase {
  kind: 'REDUCTION_SET_EXTENDED'; reduction: ReductionId; t_eff: UtcMinute; extension: number }

interface CutDecided extends FeedEventBase {
  kind: 'CUT_DECIDED'; reduction: ReductionId; t_eff: UtcMinute; reservation: ReservationId;
  revision: number;                          // 1; 2+ for a lower target after REDUCTION_SET_EXTENDED (C4-2)
  parts: PartId[];                           // covered parts
  target: Pieces | 'none';                   // from t_eff; identical to the cut_target command's
  offer?: OfferId }                          // offer-scoped: binds only the move; reservation not in A_R

interface ReductionFinal extends FeedEventBase {
  kind: 'REDUCTION_FINAL'; reduction: ReductionId; t_eff: UtcMinute;
  targets_sent: number;                      // offer-scoped included; revisions counted once per key
  maintenance_cuts: number }

interface LinkAlert extends FeedEventBase {
  kind: 'ALERT';
  alert: 'CONFIRMED_AFTER_REDUCTION' | 'NO_HOLD' | 'UNDECIDED_PAST_DEADLINE' | 'CUT_TARGET_UNMET'
       | 'CUT_NOT_APPLIED' | 'REDUCTION_DEFERRED' | 'OUTCOME_MISMATCH_ON_REPLAY' | 'COLD_REBUILD'
       | 'BATCH_RETRIES';
  detail: Record<string, string | number> }  // e.g. reduction, record ts, T_dec

/** Closure marker, produced by C01's closure emitter, not by the link outbox. */
interface Closed {
  kind: 'CLOSED'; link_id: LinkId;
  t: HlcTimestamp;           // = R_min: no event of this link with ts <= t follows
  feed_seq: number;          // last feed_seq committed at or below t (0 if none yet)
  heartbeat: boolean }       // true when emitted only by the 10 s heartbeat or a new emitter holder
```

## Semantics

### Supply commands

Shared by all six commands (RFC-001 §5, §11.1; RFC-005 §3.4, C11):

- **Authority.** A principal of the link's supplier may call any of them. Network
  operations, only through the console with a verified envelope, may call only
  `record_outage` and `record_restoration`.
  - Any other principal, and any principal on a link it cannot see, gets `UNKNOWN_LINK`.
    The answer and its timing are identical to those for a link that does not exist
    (X1-S22).
  - Network operations calling any other command gets `FORBIDDEN_ROLE`, and nothing
    changes (X1-S23). The console refuses first; the link's refusal is the defence in
    depth.
- **Record contents.** Every recorded fact carries the pseudonymous principal, the role
  and the reason reference (X1-S14). Free text stays in RFC-005's envelope and case note.
- **When an answer is sent.** The command is answered once its batch has committed,
  durable in two regions (X2-S14). Commands for one link are applied in the order they
  reach the owner.
- **Rises in capacity.** Every rise in sellable capacity (restoration, cancellation,
  increase, maintenance cut) takes effect from `ceil_minute(ts)` (P1-S76).

| Operation | Preconditions | Outcome | Errors |
|---|---|---|---|
| `record_outage` | `to_capacity` is a whole number of Mbps with `0 ≤ to_capacity < A_p(now)` | Records an open-ended outage at that level from `floor_minute(ts)`. The capacity in force becomes the least of the announced capacity and every open outage's level. Holds that no longer fit get `DISPLACED`; waiters with no fit are refused; confirmed reservations are untouched and are flagged where overcommitted (P1-S24, S25, S41, S42, S48, S49, S63, S83). `attribution = supplier` for works done on sold capacity (P1-S51) | `INVALID` |
| `record_restoration` | The outage is open. If `to_capacity` is given, it must be above the outage's level; a value at or above `A_p` ends the outage | The outage ends (or rises to `to_capacity`) from `ceil_minute(ts)`; flags end or shrink there; the waiter scan runs (P1-S27, S40, S76, S79, S80) | `UNKNOWN_OUTAGE`, `INVALID` |
| `book_maintenance` | The window follows RFC-001 §2. The window's UTC start date is at least `maintenance_notice` (14 calendar days) after today's UTC date | `CONFIRMED` if it fits beside committed and held capacity. Maintenance stays outside the committed rate and never accrues (P1-S28, P3-S47). Otherwise `REJECTED`: `NOTICE_TOO_SHORT` (P1-S30), `NEEDS_COMMITTED` (P1-S29), or `IN_FLIGHT` with `retry_after_ms` and no queueing (P1-S66) | `INVALID`, `LINK_CLOSING` |
| `cancel_maintenance` | The booking is the caller supplier's own | Frees `[max(s, ceil_minute(ts)), e)` (P1-S67, S76) | `UNKNOWN_MAINTENANCE` |
| `announce_reduction` | `new_capacity` is a whole number of Mbps below `A_now`, whatever any outage | Returns `T_eff = ceil_minute(ts + revocation_notice)` (30 days). Sales stop at the new level from `floor_minute(ts)`; `A_p` holds until `T_eff`. Runs as its own transaction (displacement, P1-S43, S44). Starts the reduction lifecycle on the feed (below) | `INVALID` |
| `record_increase` | `new_capacity` is a whole number of Mbps above `A_now` | Announced capacity from `ceil_minute(ts)`. During an outage, the capacity in force stays at the outage level (P1-S69, S80). During a notice, it raises `L_R` and the affected set is recomputed | `INVALID` |

### Feed: per event

| Event | Emitted when | Consumer obligations |
|---|---|---|
| `LEG_CONFIRMED`, `LEG_CHANGED` | A conversion, or a leg change applied. A change that reaches the link after its effective minute carries `late = true` and its earlier `effective_from` | RFC-006 history. A consumer applies a late change from `effective_from` |
| `CAPACITY_CHANGED` | Every supply fact, and every maintenance trim at a reduction's `T_eff` (`maintenance_cut`, with `supplier_notice_due` = the deciding entry's `ts`; P1-S81) | RFC-006: history, plus the notifier tells the supplier of a maintenance cut within `affected_notice_time`. RFC-002 and RFC-003: **`reduction_announced` opens reduction `R`** for the closure rules below. RFC-003 never rates maintenance |
| `AFFECTED_CHANGED` | The flag projection changes a part's affected ranges (P1-S25, S40, S50, S63, S72, S79, S82). Carries the **complete** current range set for the part | RFC-002 marks the route affected. RFC-003 annotates the reservation line, with no amount (P3-S10). RFC-006 schedules the notice |
| `AFFECTED_NOTICE` | `ts` has passed a `notice_due` | RFC-006's notifier tells the holder and network operations within `affected_notice_time`, 60 s (P1-S26, S75). The link's own budget is 10 s at p99 |
| `OFFER_AFFECTED` | An outage overcommits an open offer's path (P1-S68) | RFC-002 tells the offer's holder |
| `REDUCTION_AFFECTED` | Each committed output of the reduction projection during the notice, as a **diff** of the cut-set rows (a cut of 0 removes a row), chunked at 1,000 rows | RFC-002 offers a newly affected holder an equivalent path at once, and keeps an offer once made (P1-S31, S52, S58, S59, S64) |
| `REDUCTION_EFFECTIVE` | The first entry at or after `T_eff` (extension 0), then the steps after it; and later, extension chunks (extension ≥ 1) | See *Closure across a reduction*. An empty `A_R` is still published, as chunk 1 of 1 with no reservations |
| `REDUCTION_SET_EXTENDED` | The final check found the excess still positive (a projection defect). Always published **before** that extension's chunks and its revision-2+ `CUT_DECIDED` events | RFC-003 runs the late-cut amendment rule (below). RFC-006 alerts |
| `CUT_DECIDED` | Exactly when the matching `cut_target` command is written to the outbox: once per (reduction, reservation, revision). Offer-scoped targets are included, with `offer` set | RFC-003 uses it **only as a check** (below). RFC-006 records it in history. RFC-002 ignores it and acts on the command |
| `REDUCTION_FINAL` | Every reservation of `A_R` (and every extension) has its target, and every maintenance booking has its trim | Releases the holds (below) |
| `ALERT` | As listed | RFC-006 alerting |

### Closure across a reduction (the binding rules)

The rules below are RFC-001 §11.1 rules (1) and (2), as RFC-003 §5.6 and erratum 5.1
consume them, with C4-2 applied.

1. **`CLOSED(t, feed_seq)`** means every event of the link with `ts ≤ t` is published,
   up to and including that `feed_seq`. A consumer counts `t` as the link's closed time
   only once it has applied every event up to that `feed_seq`. `t` advances regardless of
   reductions; the holds are applied by the consumer, not by the emitter.
2. **`hold_1(R) = T_eff`** applies to **every** reservation on the link. It starts at
   `CAPACITY_CHANGED(reduction_announced, R)` and lasts until the consumer holds every
   chunk `1..of` of `REDUCTION_EFFECTIVE(R, extension 0)`.
3. **`hold_2(R) = T_eff`** applies to each reservation listed in those chunks; it is
   **membership from `REDUCTION_EFFECTIVE` chunks only**. It is released for a reservation
   when both of the following hold:
   - `REDUCTION_FINAL(R)` is held; and
   - the reservation's lifecycle **cut** event for (link, R) is applied (C04: an applied
     target, `none`, or "not applied" with its reason), and **its target revision equals
     the highest `CUT_DECIDED` revision for (link, R, reservation) the consumer has seen
     before `REDUCTION_FINAL(R)`** in `feed_seq` order (settled M2). The lifecycle cut
     event carries that revision (C04). A lifecycle cut of a lower revision keeps the hold.
4. **`CUT_DECIDED` never adds a reservation to `hold_2`.** An offer-scoped `CUT_DECIDED`
   (`offer` set) concerns a reservation outside `A_R`: it holds nothing (RFC-001 review 32
   V-3; RFC-003 erratum 5.1). Its rate changes only through a move recorded on the
   lifecycle feed.
5. **Late extension.** An extension chunk re-imposes `hold_2` on the reservations it adds,
   from their current closure. Minutes from `T_eff` that are already closed at the uncut
   rate are amended down once the extension's cut is applied in the lifecycle (reason
   "late POL-07 cut", with (link, reduction) and the extension number; P4-S117, POL-23).
6. **Per-reservation closure**:
   `closure(r) = min(lifecycle closed time, CLOSED(t) of each Share link of r, hold_1, hold_2)`.

## Delivery and ordering

- **Supply commands.** Each call has one answer. A lost reply is retried with the same
  key and gets the recorded outcome (exactly-once effect).
- **Delivery of events.**
  - **At least once.** The direct publish after commit, plus the changefeed relay as the
    guaranteed path. Duplicates are expected.
  - **Effect.** The effect is exactly once when consumers deduplicate by
    (`link_id`, `feed_seq`).
- **Kafka partitioning.**
  - **Partition key.** The key is `link_id`, so every event and every `CLOSED` marker of
    a link is on one Kafka partition.
  - **Partition count.** The count is a power of two and never decreases (C01).
- **Ordering.**
  - **Scope.** Ordering is per link, by `feed_seq`. There is no order across links.
  - **Contiguity.** `feed_seq` is contiguous from 1 per link across owner changes and
    partition moves (C01 move hooks; the head row is keyed by link).
  - **Gaps.** A consumer applies only the next expected `feed_seq`. It buffers anything
    later and treats a gap as a missing event. It fills gaps from the outbox (25 h) or
    from history (C01 replay).
- **Marker placement.** Every event with `ts ≤ t` precedes `CLOSED(t, ·)` on the
  partition, because the relay flushes before reporting progress (C01). A direct-push
  duplicate may arrive after the marker; the consumer drops it by `feed_seq`.
- **`CLOSED` emission.** Markers are emitted:
  - for links whose `feed_seq` changed;
  - as a heartbeat for every link every `closed_heartbeat` (10 s);
  - once for every link by a new emitter holder.

  Markers are idempotent and never go back: a consumer ignores one whose `t` is at or
  below its last.
- **Order within a reduction**, by `feed_seq`:
  1. `CAPACITY_CHANGED(reduction_announced)`;
  2. `REDUCTION_AFFECTED*`;
  3. `REDUCTION_EFFECTIVE` chunks of extension 0, interleaved with `CUT_DECIDED` revision
     1. Chunks are published no later than the cut decisions for their members;
  4. for each extension k: `REDUCTION_SET_EXTENDED(k)`, its chunks, then its
     `CUT_DECIDED` events (revision ≥ 2 for reservations already targeted);
  5. `CAPACITY_CHANGED(maintenance_cut)*`;
  6. `REDUCTION_FINAL`.

## Idempotency

| Item | Key | Duplicate (same content) | Same key, different content |
|---|---|---|---|
| Supply command | (link, principal's tenant, `key`); on the console path `key = action_id` (settled M1). Kept for the life of the link | The recorded outcome is returned; nothing changes | `MISMATCH`, alerted; nothing changes |
| Feed event | (`link_id`, `feed_seq`) | Dropped | Cannot happen by construction (the outbox is insert-only). A consumer keeps the first copy and alerts |
| Projection events | (link, causing log sequence, kind, subject) | Any lease holder recomputes the same event; consumers deduplicate by `feed_seq` | — |
| `CUT_DECIDED` (logical) | (link, reduction, reservation, revision) | Same as the feed event | A higher revision is lower or equal at every minute. RFC-002 composes `min` per minute on the command |
| `CLOSED` | (`link_id`, `t`) | Ignored at or below the last applied `t` | — |

## Ownership

- **Writer.** The link schedule owner (RFC-001) is the only writer of the link log,
  `link_head` and `link_outbox`, and so of every event except `CLOSED`.
- **`CLOSED` markers.** These are written only by C01's closure emitter. It reads
  `feed_seq` from `link_head` as of `t`.
- **Supply command callers.**
  - The edge, with a supplier principal.
  - The console, relaying a network-operations envelope.

  RFC-005's caller allowlist admits no other caller.
- **Feed readers.** RFC-002, RFC-003 and RFC-006 read the feed through the topic ACL. Any
  other reader needs a new contract version.
- **Data.** Payloads are ciphertext; the feed holds no personal data, only pseudonymous
  principals (A11).

## Timeouts and deadlines

- **Supply command client deadline.** 5 s per attempt (contract default, est.). On
  `UNAVAILABLE` or a deadline exceeded, retry with the same key, with backoff, for up to
  `release_grace` (60 s), then report "temporarily unavailable" to the supplier or
  operator.
  - A capacity-lowering command runs in its own transaction. If it has not reached
    `COMMIT` within 250 ms, the owner abandons it and proposes it again. The caller sees
    only latency.
  - During a takeover, expect about 5 s (warm) and up to 60 s (cold).
- **Operator envelope.** The command is refused (`ENVELOPE_REFUSED`, check 5) unless the
  owner's `ts ≤ not_after − ε`.
- **Feed latency targets.**
  - The link's part of an affected notice: 10 s at p99 from the due time to the feed.
    The notifier has the remaining 50 s of `affected_notice_time` (60 s).
  - `CLOSED` lag: about 2 to 3 s behind now (est.). The closure-lag alarm is at 10 s (C01).
- **Reduction steps.** `REDUCTION_EFFECTIVE` is deferred by 1 s retries, alerted
  `REDUCTION_DEFERRED` after 5 min.
  - Steps decide `reduction_step_parts` (500) parts each.
  - On the hottest link, `REDUCTION_FINAL` can come minutes after `T_eff`; the closure
    holds absorb this (RFC-001 Risk R1-8).

## Versioning and compatibility

- **Topic name.** The topic is `link.schedule.v1`; payloads carry `schema_v` in the
  header. Schemas are registered and decodable for 7 years (C01).
- **Compatible changes (minor).** New optional fields, new `ALERT` values, new
  `CAPACITY_CHANGED.change.type` values, and new event kinds. Consumers must ignore
  unknown fields, and must treat an unknown `kind` as a no-op **that still consumes its
  `feed_seq`**.
- **Breaking changes.** A breaking change is any of: a changed meaning, a removed field,
  a changed unit, a changed key, or a change to `feed_seq` or `CLOSED` semantics. It
  needs a new topic `link.schedule.v2`, with the provider dual-publishing until every
  consumer has moved, and a new contract version.
- **Supply gRPC service.** Additive fields only within `v1`; a new result or error value
  is a minor version that callers must tolerate as `UNAVAILABLE`-like.

## Scenarios relied on

- **P1**: S24, S25, S26, S27, S28, S29, S30, S31, S32, S35, S36, S40, S41, S42, S43,
  S44, S46, S47, S48, S49, S50, S51, S52, S55, S56, S57, S58, S59, S61, S63, S64, S65,
  S66, S67, S68, S69, S71, S72, S75, S76, S78, S79, S80, S81, S82, S83, S84.
- **P3**: S10 (affected marks), S47 (maintenance never accrues), S58 (accrual at the cut
  rate from `T_eff`).
- **P4**: S117 (late POL-07 cut, through the extension rule).
- **X1**: S13, S14, S22, S23.
- **X2**: S13 (charge timeliness rests on `CLOSED`), S14 (acknowledged only once durable).

## Conformance tests

**Provider (RFC-001 and C01's emitter):**

1. **PT-1 Authority.**
   - Another supplier's principal, or a buyer, gets `UNKNOWN_LINK` on each of the six
     commands, with the same latency distribution as a non-existent link (X1-S22).
   - Network operations gets `FORBIDDEN_ROLE` on maintenance, reduction and increase.
     Its outage and restoration are recorded with the principal and reason (X1-S23,
     X1-S14).
2. **PT-2 Levels and boundaries.** The P1-S76, P1-S79, P1-S80 and P1-S81 tables replayed
   through the commands give `capacity_in_force_from_then` and the `CAPACITY_CHANGED`
   pieces exactly. Every rise takes effect at `ceil_minute(ts)`.
3. **PT-3 Idempotency.** Repeating a command with the same key returns the identical
   result; the same key with other content returns `MISMATCH`. On the console path, two
   envelopes with the same `action_id` record once.
4. **PT-4 `feed_seq`.** Kill the owner and move the link to another slot in the middle
   of a reduction: `feed_seq` stays contiguous with no reuse, and the
   `REDUCTION_EFFECTIVE` digest and chunks are identical.
5. **PT-5 `CLOSED`.** This is C01's DT-38 on this topic. No event with `ts ≤ t` follows
   `CLOSED(t, s)` on the partition, and `s` is the last `feed_seq` at or below `t`. An
   idle link gets a heartbeat within 10 s. A new emitter holder marks every link once.
6. **PT-6 Reduction order.** For a generated reduction with an injected projection
   defect:
   - the order of events matches §Delivery;
   - every `A_R` member appears in exactly one chunk;
   - offer-only reservations appear in no chunk but do get `CUT_DECIDED` with `offer`;
   - a revision-2 `CUT_DECIDED` is lower or equal at every minute;
   - `REDUCTION_SET_EXTENDED` precedes its chunks;
   - `REDUCTION_FINAL.targets_sent` equals the number of distinct (reservation) keys
     targeted.
7. **PT-7 Equality of `CUT_DECIDED` and `cut_target`.** For every key and revision, the
   feed event's parts, pieces and offer equal the command's.
8. **PT-8 Empty affected set.** A reduction that cuts nothing publishes chunk 1 of 1
   with no reservations, then `REDUCTION_FINAL`.

**Consumers:**

1. **CT-2.1 (RFC-002).** A `REDUCTION_AFFECTED` diff that adds a part opens one offer; a
   later diff with cut 0 leaves the open offer open (P1-S64). `AFFECTED_CHANGED` with
   `ranges: []` clears the route-level flag.
2. **CT-3.1 (RFC-003) holds.**
   - Feed `reduction_announced`, then chunks out of their arrival order. No reservation
     on the link closes past `T_eff` until the last chunk is applied.
   - `A_R` members stay held until `REDUCTION_FINAL` **and** their lifecycle cut are both
     applied.
   - A non-member closes once `hold_1` lifts.
3. **CT-3.2 (RFC-003) offer-scoped.** An offer-scoped `CUT_DECIDED` never delays closure.
4. **CT-3.3 (RFC-003) revision.** Deliver `CUT_DECIDED` revisions 1 and 2, the lifecycle
   cut for revision 1, then `REDUCTION_FINAL`, with the revision-2 lifecycle cut late.
   Closure does not pass `T_eff` until the lifecycle cut with revision 2 is applied
   (settled M2).
5. **CT-3.4 (RFC-003) late extension.**
   - Reservations added by extension 1 after their minutes closed are amended down,
     reason "late POL-07 cut", with (link, reduction, extension).
   - Minutes not yet closed are emitted as originals at the cut rate (P4-S117).
6. **CT-3.5 (RFC-003) gaps.** With a `feed_seq` gap, `CLOSED(t, s)` beyond the gap does
   not advance closure until the gap is filled.
7. **CT-3.6 (RFC-003) maintenance.** `CAPACITY_CHANGED(maintenance*)` produces no line
   (P3-S47).
8. **CT-6.1 (RFC-006).**
   - `AFFECTED_NOTICE` is delivered within 50 s of its feed publish, with the endpoint
     down (P1-S75).
   - `maintenance_cut` tells the supplier.
9. **CT-all.** An unknown `kind` with the next `feed_seq` is consumed as a no-op, and
   the next event is applied.

## Readings adopted (within the bindings; not mismatches)

- `REDUCTION_SET_EXTENDED` is its own feed event. RFC-001 lists it among `ALERT` kinds;
  RFC-003 and the RFC-000 §8 brief order extension chunks after it. Both are on this feed
  under `feed_seq`, so the meaning is unchanged. The alert is also raised on the
  operational alert feed.
- `REDUCTION_AFFECTED` is a diff of the cut-set rows, chunked at 1,000. RFC-001 writes
  "only the rows that changed"; a full set is infeasible on the hottest link.
- An empty `A_R` publishes chunk 1 of 1, so that `hold_1` can lift.
- `CLOSED` `t` is never held back by a reduction. RFC-001 §5.4's "closed time does not
  pass `T_eff`" is read as the consumer-side `hold_1`, as rule (1) of RFC-001 §11.1
  states.
- Outage `attribution` is enumerated `supplier | unattributed`; further values are
  additive.
- `AFFECTED_CHANGED` carries `leg` beside `part`, for RFC-003's (reservation, leg,
  minute) marks.
- `REDUCTION_FINAL.targets_sent` counts (reservation) keys once, whatever their
  revisions. RFC-001 says only "count of targets sent (offer-scoped ones included)".
- `AFFECTED_NOTICE` is the "notice events when due" of RFC-001's `AFFECTED_CHANGED` row,
  given its own kind.

## Settled (orchestrator decisions; formerly mismatches)

**M1. Operator envelope on supply commands** (RFC-001 vs RFC-005 §7.4). Settled as
adopted:

- The envelope's target is `link_id`, and `target_version` is the link's registry version
  (the `(link_id, version)` of the registry feed), checked against the owner's applied
  registry.
- A failed envelope check is refused `ENVELOPE_REFUSED(check)`.
- On the console path the idempotency key is `action_id`, with tenant `share-operations`.

**Obligation:** RFC-001 takes this as an erratum (its §11.1 names neither
`target_version` nor `ENVELOPE_REFUSED`).

**M2. `hold_2` release under a revision-2 target** (RFC-001 vs RFC-003 §5.6 and erratum
5.1). Settled:

- The lifecycle cut event (contract C04) carries the target revision.
- RFC-003 releases `hold_2` for a reservation only once `REDUCTION_FINAL(R)` is in **and**
  the applied lifecycle cut's revision equals the highest `CUT_DECIDED` revision for
  (link, reduction, reservation) seen before `REDUCTION_FINAL` (Semantics, rule 3).
- `hold_2` membership still comes only from `REDUCTION_EFFECTIVE` chunks.
- Offer-scoped cuts still hold nothing.

**Obligation:** RFC-002 (revision on the lifecycle cut event) and RFC-003 (release rule)
take this as errata.

The readings listed under "Readings adopted" are accepted.
