# C09. Personal-data store

| | |
|---|---|
| Contract ID | C09 |
| Version | 1.0-draft.2 |
| Status | **Draft**, for contract re-review. Revision draft.2 answers [review 36](../../reviews/36-contract-C09-review.md) (REJECT: R36-01 … R36-31), every proposed fix accepted by the orchestrator ("Review 36 resolution"). The earlier settled points stay ("Settled"). RFC-000, RFC-003, RFC-005 and RFC-006 take the changes as errata after freeze ("Consumer obligations") |
| Provider | Identity and access (RFC-005 revision 5, §3.7, §10, C12; the key service for `digest_key`) |
| Consumers | Metering ingestion (RFC-003 revision 5 + erratum 5.1: `put_payload`, `withdraw_payload`, `digest_key`); the evidence query (RFC-003: `digest_key`); identity and access itself (`put`, `get`, `lookup_login`, `erase`, `store_outbox_head`; `get` purpose "payout destination" on behalf of payouts, RFC-004 revision 5 via C16); onboarding through identity (`put` of KYB documents); notifier (`get`, contact details at send time); operator console (`put` of case notes, `get` with a read grant); reporting (`get`, display names at view time); RFC-006 revision 6 backup pruner and restore tooling (store events feed, `reapply`) |
| Transport | Store operations, `digest_key` and `store_outbox_head`: synchronous query and command (gRPC over mTLS, caller allowlist by workload identity, RFC-005 §4.4). Store events feed: Kafka event, published from identity's transactional outbox (RFC-000 §8 personal-data store row, A1) |
| Pinned to | `requirements-v1.10`; RFC-000 revision 4.4 (§8 personal-data store, payout destination and read grant rows, A11, §5.3); RFC-005 revision 5 (§3.7, §4.4, §7.5, §7.6, §10, §13, §14, §15 DT-15, DT-21, DT-24, DT-30, C4, C12, C13, C15, C16); RFC-003 revision 5 with erratum 5.1 (§1.2, §3.3, §3.4, §7, §8); RFC-004 revision 5 with erratum 5.1 (§B7.1, §B8, contract table); RFC-006 revision 6 (§3.2, §14.4, DT-25, RK27) |

## Purpose

RFC-000 A11: personal data never enters a log. This store is the only place personal data
lives: users', operators' and contacts' names and contact details, login identifiers,
display names, KYB documents, case notes, legal-order and erasure-request documents,
payout-destination details, and the payloads of non-conforming flow-record data sets.
Every item is encrypted per data subject (a payload under layered account, bucket and
day-expiry keys), so erasure is key destruction (crypto-shredding) and no log is ever
rewritten. The operations are kept apart, each with its own callers and, for `put` and
`get`, its own item kinds: **put**, **put_payload**, **withdraw_payload**, **get**,
**lookup_login**, **erase**, **expire**; the **store events feed** and the restore-only
**reapply** that let backups and restores honour every destruction; and **digest_key**,
which makes the digest ingestion keeps of a non-conforming payload a keyed one.

Erasure-request intake (`record_erasure_request`, pass-on, compliance channels,
`open_requests`) is part of RFC-005 C12 but not of this contract: it is identity's own
command surface. `erase` here is only the store operation identity calls once a request is
executing.

## Schema

**Units.** Sizes in **bytes**: KiB = 1,024 B and MiB = 1,048,576 B for the rate caps
(RFC-005 writes them "KB" and "MB"); **TB = 10¹² B** for storage. Rates per second, in a
**fixed one-second window** aligned to the UTC second. Durations in **ms** unless named in
hours or days. Timestamps are **epoch microseconds UTC** (`bigint`, a decimal string in
JSON) unless named an hour or a day. Every identifier is pseudonymous (A11). Field names
are the wire names; protobuf messages mirror these types one to one.

```ts
// ---------- common ----------
type EpochMicros = bigint;            // UTC, microseconds since 1970-01-01T00:00Z
type UtcHour = string;                // "2026-10-12T14:00Z": start of a UTC hour
type UtcDay = string;                 // "2026-10-12": a UTC day
type ExporterId = string;             // pseudonymous exporter ID (the session's)
type SupplierId = string;             // exporter's owner as its credential names it, or "share"
type AccountId = string;
type SubjectId = string;              // principal_id, contact subject_id, supplier ID, or a store-minted note ID; never a name
type ItemId = string;                 // item identifier within a subject
type RequestRef = string;             // erasure request identifier (identity)
type Generation = number;             // KEK_PD generation g (weekly)
type EventId = { partition: string; sequence: string };   // identity outbox position (RFC-000 §4.4)

type RequestMeta = { capabilities: string[] };            // on every request; [] today (see Versioning)

type Unavailable = { kind: "temporarily_unavailable" };   // see each operation for what the caller must assume
type RefusalCheck =
  | "caller_not_allowed"        // workload identity not on the operation's allowlist
  | "kind_not_allowed"          // put: caller may not write this kind (R36-01)
  | "kind_mismatch"             // put: item exists with another kind (R36-01)
  | "item_exists"               // put: write-once item exists with other content (R36-01)
  | "version_conflict"          // put: same version, other content (R36-02)
  | "stale"                     // put: expected_version not current, or version not above it (R36-02)
  | "subject_erased"            // put: subject or a tag is tombstoned (R36-04)
  | "purpose_not_allowed"       // get: purpose not allowed for the caller (S-G2)
  | "kind_not_for_purpose"      // get: item kind not readable under the purpose (R36-03)
  | "read_grant_invalid"        // get: grant fails C4 / C15, or read_type ≠ purpose, or role not allowed
  | "target_out_of_grant"       // get: target is not the grant's one target
  | "read_limit"                // get, lookup_login: rate limit (R36-03, R36-30)
  | "exporter_mismatch"         // put_payload: exporter ≠ record_id.exporter
  | "scope_conflict"            // erase: other scope under a committed request_ref
  | "envelope_invalid"          // erase: operator check of the compliance envelope failed (R36-20)
  | "not_restoring";            // reapply: store not fenced for a restore (R36-06)
type Refused = { kind: "refused"; check: RefusalCheck };

// ---------- item kinds (R36-01, R36-03) ----------
type MutableKind = "name" | "contact" | "login_identifier" | "display_name";
type WriteOnceKind = "kyb_document" | "case_note" | "legal_order_document"
                   | "erasure_request_document" | "payout_destination_details";
type ItemKind = MutableKind | WriteOnceKind;

// ---------- record identity of a payload (RFC-003 §3.3 step 2) ----------
type RecordId = {
  exporter: ExporterId;
  ref:
    | { kind: "identity"; exporter_epoch: string; sequence: string }   // RFC-003 §3.2 record identity
    | { kind: "raw"; partition: string; log_seq: string; index: number };
  digest: { key_version: number; hmac_sha256: string };   // hex, 64 chars; keyed digest of the payload bytes
};
type PayloadBucket = { exporter: ExporterId; hour: UtcHour };   // UTC hour of received_at

// ---------- put (subject items) ----------
type PutRequest = RequestMeta & (
  | { kind: MutableKind;                       // identity only
      subject: SubjectId; item: ItemId;
      version: string;                         // identity's log sequence of the change; strictly increasing per item
      expected_version: string | null;         // the version the change replaces; null for the first
      content: Uint8Array }
  | { kind: Exclude<WriteOnceKind, "case_note">;   // identity; kyb_document via onboarding-through-identity
      subject: SubjectId;                      // payout_destination_details: the supplier ID (R36-25)
      item: ItemId;                            // payout_destination_details: "<destination_ref>/<version>"
      content: Uint8Array }
  | { kind: "case_note";                       // console only; the store mints the note ID (R36-01 d)
      tags: SubjectId[];                       // the subjects the note concerns (≥ 1)
      client_ref: string;                      // console's idempotency key for this note
      content: Uint8Array }
);
type PutAnswer =
  | { kind: "stored"; subject: SubjectId; item: ItemId; version: string | null; commit: EpochMicros }
  | Unavailable | Refused;

// ---------- put_payload ----------
type PutPayloadRequest = RequestMeta & {
  record_id: RecordId;
  exporter: ExporterId;               // = record_id.exporter, else refused(exporter_mismatch)
  supplier: SupplierId;
  account?: AccountId;                // RFC-003 never sends it (rejected records are unattributed)
  received_at: EpochMicros;           // edge receipt of the batch (validated, R36-11)
  keep_by: EpochMicros;               // latest time the payload may be kept (validated, R36-11)
  payload: Uint8Array;                // ≤ 65,536 B to be keepable
};
type PutPayloadAnswer =               // cap, late, erased: only when known not committed (R36-05)
  | { kind: "kept"; bucket: PayloadBucket }           // durable in two regions
  | { kind: "not_kept"; reason: "cap"; cap: CapName }
  | { kind: "not_kept"; reason: "late" }              // also tombstoned record_id and failed validation
  | { kind: "not_kept"; reason: "erased" }            // received_at in an erased range (R36-09)
  | Unavailable | Refused;
type CapName =
  | "per_exporter_count"   // payload_put_limit      10 /s per exporter
  | "per_exporter_bytes"   // payload_bytes_limit    262,144 B/s per exporter
  | "global_count"         // payload_put_global     1,000 /s, split over instances (R36-08)
  | "global_bytes"         // payload_bytes_global   4,194,304 B/s, split over instances
  | "payload_size"         // payload_max_bytes      65,536 B per payload
  | "storage";             // live payload bytes ≥ 36 × 10¹² B per copy (S-M1; backstop, R36-07)

// ---------- withdraw_payload ----------
type WithdrawPayloadRequest = RequestMeta & { record_id: RecordId; received_at: EpochMicros };  // R36-14
type WithdrawPayloadAnswer =
  | { kind: "withdrawn"; was: "kept" | "absent" }     // only after payload_withdrawn is committed
  | Unavailable | Refused;

// ---------- get ----------
type GetPurpose =                     // S-G2: closed vocabulary, allowlisted per caller
  | "login" | "administrator_command" | "payout_destination"          // identity
  | "notice_delivery"                                                  // notifier
  | "statement_display"                                                // reporting
  | "support_view" | "case_note" | "flow_record_dispute";             // console, with a read grant
type ConsolePurpose = "support_view" | "case_note" | "flow_record_dispute";
type OperatorRole = "support" | "finance" | "compliance";             // roles that may read the store (RFC-005 §7.1)
type ReasonCode = string;             // a code from POL-32's enumerated reason list; never free text (R36-19)
type ReadGrant = {                    // RFC-005 §7.6, C4
  grant_id: string; operator: string; role: OperatorRole;
  read_type: ConsolePurpose;          // must equal the get's purpose (R36-03)
  target: { kind: "subject"; subject: SubjectId } | { kind: "payload"; record_id: RecordId };
  reason: ReasonCode; not_after: EpochMicros;
  webauthn: { authenticator_data: string; client_data_json: string; signature: string; credential_id: string };
};
type GetRequest = RequestMeta & (     // caller-specific variants (R36-16)
  | { caller: "identity"; purpose: "login" | "administrator_command" | "payout_destination";
      subject: SubjectId; item: ItemId }
  | { caller: "notifier"; purpose: "notice_delivery"; subject: SubjectId; item: ItemId }
  | { caller: "reporting"; purpose: "statement_display"; subject: SubjectId; item: ItemId }
  | { caller: "console"; purpose: "support_view" | "case_note"; subject: SubjectId; item: ItemId;
      read_grant: ReadGrant }
  | { caller: "console"; purpose: "flow_record_dispute"; record_id: RecordId; read_grant: ReadGrant }
);
type GetAnswer =
  | { kind: "found"; content: Uint8Array; version: string | null }   // highest version; hold in memory for the request only
  | { kind: "not_found" }             // never existed, erased, expired, withdrawn, lost in a restore: indistinguishable
  | Unavailable | Refused;

// ---------- lookup_login (identity only, R36-30) ----------
type LookupLoginRequest = RequestMeta & { normalised_identifier: string };   // plaintext over mTLS, never logged
type LookupLoginAnswer = { kind: "principal"; principal_id: SubjectId } | { kind: "not_found" } | Unavailable | Refused;

// ---------- erase ----------
type ErasureScope = {
  subjects: SubjectId[];                             // subject keys, items, blind-index rows, case notes tagged only with them
  account_payload_keys: AccountId[];                 // a user of account a -> a's account payload key
  bucket_keys:
    | { kind: "none" }
    | { kind: "supplier"; supplier: SupplierId }     // every bucket key of the supplier's exporters, existing at execution
    | { kind: "exporters_period"; exporters: ExporterId[]; from: EpochMicros; to: EpochMicros }; // every hour meeting [from, to)
};
type DestroyedKeys = {                                // concrete, so a restore re-applies exactly these (R36-27)
  subjects: SubjectId[];
  account_payload_keys: { account: AccountId; key_version: number }[];
  bucket_keys: { exporter: ExporterId; hour: UtcHour; key_version: number }[];
  erased_ranges: { exporter: ExporterId; from: EpochMicros; to: EpochMicros }[];   // R36-09
};
type EraseRequest = RequestMeta & {
  request_ref: RequestRef; scope: ErasureScope;
  envelope: { action_id: string; digest: string };   // the compliance envelope identity applied (R36-20)
};
type EraseAnswer =
  | { kind: "erased"; store_commit: EpochMicros; destroyed: DestroyedKeys }
  | Unavailable | Refused;

// ---------- digest_key (key service) ----------
type DigestKeyRequest = RequestMeta & { exporter: ExporterId; version?: number };   // S-G3
type DigestKeyAnswer =
  | { kind: "key"; version: number; wrapped_key: Uint8Array }  // HMAC-SHA-256, 256-bit, wrapped to the caller's workload identity
  | { kind: "not_found" }                                       // unregistered exporter, or a version never issued (R36-12)
  | Unavailable | Refused;

// ---------- store events feed (Kafka) ----------
type Attestations = {
  present: { hsm_cluster: string; signed_attestation: string }[];
  decommissioned: { hsm_cluster: string; decommissioning_record: string }[];   // R36-23
};
type StoreEvent = {
  event_id: EventId;
  store: "pds";                                       // Kafka key
  committed_at: EpochMicros;                          // identity's commit of the event
} & (
  | { type: "payload_withdrawn"; record_id: RecordId; day: UtcDay; was: "kept" | "absent" }
  | { type: "expiry_destroyed"; day: UtcDay; attestations: Attestations }        // S-M2
  | { type: "generation_destroyed"; generation: Generation; attestations: Attestations }
  | { type: "erasure_executed"; request_ref: RequestRef; scope: ErasureScope;
      destroyed: DestroyedKeys; store_commit: EpochMicros }
);

// ---------- restore (RFC-006 restore tooling only, R36-06) ----------
type StoreOutboxHeadRequest = RequestMeta;            // to identity
type StoreOutboxHeadAnswer = { kind: "head"; head: EventId; read_at: EpochMicros } | Unavailable | Refused;
type ReapplyRequest = RequestMeta & { restore_id: string; events: StoreEvent[] };   // in feed order
type ReapplyAnswer = { kind: "applied"; through: EventId } | Unavailable | Refused;
```

The store's tables are identity's private schema (`pds` database, RFC-005 §3.7); no other
service has a SQL role on it, so no DDL is part of this contract.

## Semantics per operation

### put

- **Callers and kinds** (R36-01 a). Anything else is `refused(kind_not_allowed)`:

  | Caller (workload identity) | Kinds it may write |
  |---|---|
  | Identity | `name`, `contact`, `login_identifier`, `display_name`, `legal_order_document`, `erasure_request_document`, `payout_destination_details` |
  | Onboarding, through identity | `kyb_document` |
  | Console | `case_note` only |

- **Kind fixed at first put** (R36-01 b): an item's kind never changes; a put of another
  kind is `refused(kind_mismatch)`.
- **Mutable kinds** (`name`, `contact`, `login_identifier`, `display_name`; identity only,
  each change from identity's own command): versioned by **item identifier** (subject,
  item) with `version` = identity's log sequence of the change (RFC-000 §8 "idempotent by
  item identifier", R36-02). Each version, once written, is never overwritten. The put
  commits only if `expected_version` equals the item's current version (null for a new
  item) and `version` is higher; see "Idempotency" for duplicates. `get` returns the
  highest version.
- **Write-once kinds** (`kyb_document`, `case_note`, `legal_order_document`,
  `erasure_request_document`, `payout_destination_details`): an item is written once. A
  second put with the same content answers `stored`; with other content it is
  `refused(item_exists)` and alerted (R36-01 c). A new payout destination version is a new
  item `"<destination_ref>/<version>"`, minted by identity's C16 command only.
- **Case notes** (R36-01 d, R36-25): the store mints the note ID; subject = note ID, item =
  `"note"`; the note is tagged with `tags`; idempotent by (console, `client_ref`).
- **Payout destination details** (R36-25): subject = the supplier's ID (whether a covering
  erasure reaches them is RQ-36-2).
- **Erased subjects** (R36-04): a put whose subject, or any of whose `tags`, carries a
  subject tombstone is `refused(subject_erased)`. Put and erase serialise on the subject's
  key row (serialisable transactions), so no put commits after an erase of its subject.
- **Effect**: seals `content` under the subject's key (created on the first put of a
  subject that has no tombstone), AES-256-GCM, subject, item and version as associated
  data. **Answer** `stored` only once durable in two regions.
- **Errors**: `temporarily_unavailable` (outcome unknown; retry with the same arguments,
  which is idempotent); the refusals above; `refused(caller_not_allowed)`.

### put_payload(record_id, exporter, supplier, account?, received_at, keep_by, payload)

- **Caller**: metering ingestion only; only for non-conforming data sets (rejected
  `no template` or `unparseable`).
- **Preconditions (caller)**:
  - the keyed digest in `record_id` is computed with a cached `digest_key` version;
  - `keep_by` = issue time on the caller's clock + `pd_put_timeout` − ε (RFC-003: 500 ms −
    100 ms = issue + 400 ms);
  - the ingestion owner's host clock is within `max_offset` (100 ms) of the cluster's, under
    RFC-006's clock discipline and its offset monitoring; a host outside it must not issue
    puts (R36-29).
- **Validation** (R36-11). The store answers `not_kept(late)`, keeps nothing and raises an
  integrity alert (identifiers only) if, against its commit timestamp T: `received_at` > T +
  `max_offset`; `received_at` < T − 1 h (est.); `received_at`'s day expiry key is destroyed
  or past its usage end; or `keep_by` > T + `pd_put_timeout`.
- **Order of checks**: exporter match; validation; withdrawal tombstone (`not_kept(late)`);
  existing kept item (`kept(first bucket)`, S-G1 comparison); erased range
  (`not_kept(erased)`); caps; keep.
- **Outcomes** (exactly one):
  - `kept(bucket)`: committed, durable in two regions, in bucket (exporter, UTC hour of
    `received_at`). The item key is wrapped under the account payload key (if `account`) and
    the bucket key; the **bucket key** is wrapped under the expiry key `X_d` of
    `received_at`'s UTC day once per bucket-hour (R36-18), and under `KEK_PD,g` in the key
    table. For a `record_id` already kept, the answer names **the first put's bucket**,
    whatever this call's `received_at`; nothing is written.
  - `not_kept(cap)`: a cap refused it (below). Nothing is kept anywhere.
  - `not_kept(erased)`: `received_at` falls in an erased range of the exporter (R36-09,
    D-36-3). Nothing is kept.
  - `not_kept(late)`: the transaction reads `cluster_logical_timestamp()` and commits only
    if it is ≤ `keep_by` − ε (ε = `max_offset`, 100 ms); otherwise it aborts, is not retried
    past `keep_by`, and nothing is kept. **No item is ever kept by a commit timestamp after
    `keep_by` − ε.** Also the answer for a tombstoned `record_id` and for failed validation.
- **Known outcomes only** (R36-05): the store answers `not_kept(cap)`, `not_kept(late)` or
  `not_kept(erased)` **only when its transaction is known not to have committed**. After an
  ambiguous commit result it answers `temporarily_unavailable`, or nothing.
- **The caller** treats `temporarily_unavailable`, `refused` of any kind and a transport
  error exactly as **unanswered**: it records "dropped: unanswered, withdrawal pending" and
  withdraws. It may re-send the same put only while its clock is before `keep_by` + ε.
- A `record_id` answered `not_kept` without a tombstone is not remembered: a later put of it
  (a resend, with its own `received_at`) is decided afresh.
- **Caps** (S-M3, R36-08, D-36-5): an **admission limiter** of token buckets held in memory
  by each store instance, with a fixed one-second window aligned to the UTC second and a
  capacity of one window's allowance (no carry-over):
  - puts are routed to instances by exporter (consistent hashing), so each exporter's
    bucket (10 puts and 262,144 B per second) lives on one instance;
  - the global budget (1,000 puts and 4,194,304 B per second) is split equally over the N
    serving instances (N = 8, est.: 125 puts and 524,288 B per second each), re-split on
    membership change;
  - tokens are taken at admission, after the repeat and tombstone checks (so a repeat of a
    kept `record_id` and a tombstoned one consume none), and refunded on a known non-commit;
  - there is no counter row in any transaction, so no single hot row;
  - **overshoot bound**: during a rebalance an exporter may be admitted by two instances for
    one window (at most 2× its caps for one second); the split global budget never
    overshoots the global caps. Imbalance can refuse below the global cap (est. ≤ 1/N
    unused); POL-19 requires only the stated caps;
  - a payload over 65,536 B is always `not_kept(cap: payload_size)`.
- **Storage cap** (S-M1, R36-07): `not_kept(cap: storage)` while measured **live payload
  bytes** (the logical bytes of undeleted payload rows in one copy, measured, refreshed every
  minute, est.) are ≥ 36 × 10¹² B. Arithmetic: with expired and erased rows deleted (below),
  the byte caps bound live payload bytes to 4,194,304 B/s × 86,400 s × 37 days = 1.34 ×
  10¹³ B (13.4 TB) per copy, so this cap binds only if the byte caps or deletion fail. It
  is a backstop, alarmed when it binds.

### withdraw_payload(record_id, received_at)

- **Caller**: metering ingestion only, for every put recorded "dropped: unanswered,
  withdrawal pending" (S-M4), retried with backoff until answered, and re-driven by a new
  lease holder from its log.
- **Effect, one transaction** (R36-14): delete the item if a put committed it; write a
  **withdrawal tombstone** for `record_id` holding `was` (kept or absent) and the day of
  `received_at`, kept until that day's expiry; write `payload_withdrawn(record_id, day,
  was)` to identity's outbox.
- **Answer** `withdrawn(was)` **only after** that transaction commits, so the event is
  committed before the answer. A crash before the commit leaves the call unanswered; the
  retry re-drives it. A repeat answers the tombstone's `was`.
- After the answer, the payload is kept nowhere (P3-S75); before it, at most in this store,
  under its day's expiry key and every covering erasure.
- **Ingestion's record** (R36-28): of `kept` and `withdrawn` for one `record_id`, the later
  entry in ingestion's log is authoritative; a `kept` answer to a re-send followed by the
  withdrawal of the earlier unanswered put leaves the payload withdrawn, and RFC-003's
  evidence path treats `not_found` after `withdrawn` as expected.
- **Errors**: `temporarily_unavailable` (outcome unknown; retry); `refused(caller_not_allowed)`.

### get

- **Callers and purposes** (S-G2): identity (`login`, `administrator_command`,
  `payout_destination`); notifier (`notice_delivery`); reporting (`statement_display`);
  console only with a read grant (`support_view`, `case_note`, `flow_record_dispute`).
  Otherwise `refused(purpose_not_allowed)`.
- **Purpose → kinds** (R36-03, D-36-1). Anything else is `refused(kind_not_for_purpose)`:

  | Purpose | Kinds readable | Grant roles |
  |---|---|---|
  | `login` | `login_identifier` | — |
  | `administrator_command` | `name`, `contact`, `display_name` | — |
  | `payout_destination` | `payout_destination_details` | — |
  | `notice_delivery` | `contact` (a non-user requester's reply address is put as a `contact` item of the request's `subject_id`, never read from the evidence document) | — |
  | `statement_display` | `display_name` | — |
  | `support_view` | `name`, `contact`, `display_name` | support, compliance |
  | `case_note` | `case_note` (support, compliance); `erasure_request_document`, `legal_order_document` (compliance only) | support, compliance |
  | `flow_record_dispute` | payload | finance, support |

- **Read grant** (console): verified by the C4 rules and the operator check (C15);
  `read_type` must equal the purpose and the role must be allowed for the kind, else
  `refused(read_grant_invalid)`; the target must be the grant's one target, a case note
  matching a grant whose target is any of its tagged subjects (R36-25), else
  `refused(target_out_of_grant)`; `operator_read_limit` enforced. The store **appends the
  read to audit before answering**: reader, purpose, subject or `record_id`, `grant_id`,
  operator, role; never the data and never reason text (R36-19).
- Every other `get` is appended to audit likewise (reader, purpose, subject).
- **Rate limits for every reader** (R36-03; est., to be replaced by measured load): identity
  2,000/s, notifier 500/s, reporting 200/s, console `operator_read_limit` per operator. Above
  them `refused(read_limit)`. A **breadth alert** fires when a reader's distinct subjects in
  an hour exceed 3× its trailing seven-day hourly maximum (est.; T-29 extended).
- **Answer** `found(content, version)` or `not_found`: never existed, erased, expired,
  withdrawn and lost in a restore are byte-identical answers.
- **Reader obligation**: content held in memory for the request only; never written to a
  table, topic, cache outliving the request, log or trace (A11).
- **Payout destination** (RFC-004 via C16): identity gets item
  `"<destination_ref>/<version>"` of the supplier with purpose `payout_destination`;
  payouts never call the store and never log the details. `not_found` (an item lost in a
  restore, R36-24) is mapped by C16 to "not found": RFC-004 escalates to finance, and
  identity alerts and asks the supplier to re-enter the destination.

### lookup_login(normalised_identifier)

- **Caller**: identity only (R36-30). The store computes the blind index (HMAC-SHA-256
  under the current generation's index key, RFC-005 §3.7) and answers the `principal_id` or
  `not_found`, with the same latency distribution for both. Audited (identifier never
  recorded, only the outcome and the caller); rate-limited at 200/s (est.), above it
  `refused(read_limit)`.

### erase(request_ref, scope, envelope)

- **Caller**: identity only, between its `erasure_executing` and `erasure_executed`
  entries, on a compliance envelope citing a recorded request for the same subject (and, for
  a non-user request, carrying its verification). Identity checks the request in its own
  state. The store, as defence in depth (R36-20), calls the C15 operator check on the
  envelope's `action_id` and digest (idempotent for one `action_id`), requires role
  compliance, else `refused(envelope_invalid)`, and records the operator in its audit
  append.
- **Effect**:
  - delete the subjects' wrapped keys, their items, blind-index rows, and the case notes
    tagged only with erased subjects; write a **subject tombstone** for each subject
    (pseudonymous ID only, kept for the retention period, 7 years) (R36-04);
  - delete the named account payload keys (a new key version serves later payloads) and
    bucket keys (a bucket still filling gets a new key version); for an `exporters_period`
    scope, write an **erased range** per exporter for [`from`, `to`), kept until `to` +
    `dispute_window` + 7 days, so payloads received in the period after the erasure are not
    kept (R36-09, D-36-3). A `supplier` scope covers payloads received before the erasure
    only (RFC-005's reading; RQ-36-3);
  - append the erasure to audit; write `erasure_executed(request_ref, scope, destroyed,
    store_commit)` to identity's outbox, naming the concrete key versions destroyed
    (R36-27);
  - delete the payload rows whose keys were destroyed within 24 h, by a scheduled job
    (R36-07).
- **Batching** (R36-15): if the key set is larger than one transaction allows, the first
  batch fixes and stores the set under `request_ref`; each batch commits its part and its
  progress; a re-drive resumes from the stored progress; the **last** batch writes the
  event, and `store_commit` is its commit. Items in a batch are `not_found` from that
  batch's commit, every item in scope from `store_commit`.
- **Answer** `erased(store_commit, destroyed)`. Identity tells the supplier's
  administrators the exporter and hours destroyed **only for an `exporters_period` scope**,
  never by whom (R36-26, D-36-2).
- **Bound** (R36-10, D-36-4): with e the execution (`store_commit`) and r the request's
  record, every copy is unreadable by e + 14 days (generation h destroyed at `s_h+1` + 7
  days). If e ≤ r + 9 days, that is within r + 23 days. **If e > r + 9 days, identity
  starts a new `KEK_PD` generation at once** (RFC-005 §10's on-compromise procedure), so h's
  usage end is e + 7 days and every copy is unreadable by e + 7 days. So every execution up
  to r + 23 days meets `erasure_max` (30 days). See "Timeouts and deadlines" for the
  execution deadline and the breach path.

### expire (store-internal, by schedule)

- No caller. The expiry is fixed at `put_payload`: the expiry key `X_d` of the UTC receipt
  day d, held only in the Kenyan HSMs, never escrowed or backed up, is destroyed by HSM
  quorum at d's start + `dispute_window` (30 days) + 7 days, attested. From then the
  payload is unrecoverable in every copy, backups and escrow included: at most
  `dispute_window` + 7 days, at least `dispute_window` + 6 days, after receipt.
- Identity commits the attestation entry that publishes `expiry_destroyed(d,
  attestations)`; day d counts as expired only once it is committed (S-M2). Then the store
  deletes day d's payload rows and withdrawal tombstones and the erased ranges past their
  end (R36-07).
- **A permanently lost HSM cluster** (R36-23): once it is declared decommissioned (four-eyes
  security officers, attested), `expiry_destroyed` and `generation_destroyed` are emitted
  with the attestations present plus the decommissioning record.

### Store events feed

- `payload_withdrawn(record_id, day, was)`: committed in the withdrawal's transaction,
  before `withdraw_payload` answers.
- `expiry_destroyed(day, attestations)`: committed with the expiry key's attestation entry
  (S-M2).
- `generation_destroyed(g, attestations)`: committed with the attestation entry; g counts
  as destroyed only once it is committed.
- `erasure_executed(request_ref, scope, destroyed, store_commit)`: committed in `erase`'s
  last transaction.
- Identifiers only, never personal data. Consumers: RFC-006's backup pruner (deletes within
  24 h every backup object tagged with a destroyed generation; at 7 days of age
  regardless) and restore tooling (below).
- **Retention** (R36-06): `cleanup.policy=delete`, never compaction, retention ≥ 14 days
  (est.: 7 days of backups plus 7 days of margin).

### Restore (RFC-006 restore tooling; R36-06, R36-24)

1. Choose a backup. A backup whose oldest contained generation reaches its usage end within
   the restore's expected duration is not used.
2. Restore it into the store **fenced**: no `put`, `put_payload`, `withdraw_payload`,
   `get`, `lookup_login` or `erase` is served (each answers `temporarily_unavailable`).
3. Rewrap every key under the current `KEK_PD` generation at once.
4. Call identity's `store_outbox_head()` after the fence is in place; wait until the relay
   has published through that head.
5. Call `reapply(events)` with every feed event whose `committed_at` ≥ the backup's AS OF
   time − `max_offset`, through the head, in feed order. `reapply`, for each event, deletes
   exactly what it names (`erasure_executed`: the subjects' keys, items and blind-index rows,
   with their tombstones, and the listed key versions, with the erased ranges;
   `payload_withdrawn`: the item, with its tombstone; `expiry_destroyed`: day d's payload rows
   and tombstones; `generation_destroyed`: nothing in the store, the pruner's), **emits no
   event**, and is idempotent by `event_id` (a reapply ledger in the restored store). It is
   `refused(not_restoring)` on a store that is serving. No expiry is derived by date
   computation (S-M2).
6. Unfence. Items put after the backup and not re-put are lost: `get` answers `not_found`;
   identity alerts and asks for re-entry (payout destinations: see "get").

### digest_key(exporter[, version])

- **Callers**: metering ingestion's and the evidence query's workload identities only;
  every release audited.
- **Answer**: without `version`, the current version; for an exporter the catalogue's
  registry knows that has none yet, the key service **creates version 1 atomically on the
  first request** (idempotent: concurrent first requests get the same key) (R36-12). With
  `version` (S-G3), that version. Versions rotate yearly; every version is served for the
  retention period (7 years). `not_found` only for an unregistered exporter or a version
  never issued.
- **Caller obligations**: cache in memory only; fetch for every exporter of a slot at lease
  acquisition; keep the cached version through a rotation until the new one is fetched;
  with no version cached and the fetch failing (`temporarily_unavailable` or transport
  error), neither commit nor acknowledge the batch holding the non-conforming payload
  (RFC-003 §3.3 step 1). `not_found` on the current-version form is an alerted
  configuration error, not retried in a loop.

## Delivery and ordering

| Operation | Delivery | Ordering |
|---|---|---|
| `put`, `put_payload`, `withdraw_payload`, `erase`, `reapply` | Caller retries until answered (at-least-once request); **exactly-once effect** by the idempotency keys below | Per subject: put and erase serialise on the subject's key row. Per `record_id`: a withdrawal committed before a retried put makes the put answer `not_kept(late)`; a put committed before the withdrawal is deleted by it. Otherwise none across calls |
| `get`, `lookup_login`, `digest_key`, `store_outbox_head` | Request-reply; no effect but the audit append (and `digest_key`'s first-version creation) | — |
| Store events feed | At-least-once from identity's transactional outbox (an event exists iff its act committed); consumers deduplicate by `event_id` | Kafka key `store` = `"pds"`: one partition, total order in commit order |

## Idempotency

| Operation | Key | Duplicate | Same key, different content |
|---|---|---|---|
| `put`, mutable kind | (subject, item, `version`) | Same version, same content: `stored`, no write | Same version, other content: `refused(version_conflict)`. `expected_version` not the current version, or `version` not above it: `refused(stale)` (a delayed retry after a later change) |
| `put`, write-once kind | (subject, item) | Same content: `stored`, no write | `refused(item_exists)`, alerted |
| `put`, case note | (console, `client_ref`) | `stored` with the note ID first minted | `refused(item_exists)`, alerted |
| `put_payload` | `record_id` | Kept: `kept(first bucket)`. Tombstoned: `not_kept(late)`. Not kept and not tombstoned: decided afresh | `record_id` contains the keyed digest, so different bytes mean a defect: answered as the first put, nothing written, and an **integrity alert** (identifiers only) (S-G1). The comparison is against a SHA-256 of the plaintext sealed beside the item under the store's C13 column key, with no HSM call; if the item's keys are already destroyed, the answer is the first bucket with no comparison and no alert (R36-17) |
| `withdraw_payload` | `record_id` | `withdrawn` with the tombstone's `was`; no second event | — |
| `erase` | `request_ref` | `erased` with the first `store_commit` and `destroyed`; one `erasure_executed` per `request_ref` | `refused(scope_conflict)`; identity never re-scopes a request |
| `reapply` | `event_id` | Skipped | — |
| `digest_key` first version | exporter | The same version 1 | — |
| Store events | `event_id` | Consumers apply once | — |

## Ownership

- **Writes**: identity and access only (the `pds` database, its own zone configuration, 5
  voters, no non-voters; `gc.ttlseconds` ≤ `pd_gc_ttl` = 1 h; **no changefeed, ever**;
  no other SQL role). Every write enters through the operations above; `reapply` is the
  only write RFC-006's restore tooling makes, and only to a fenced store.
- **Reads**: only through `get` and `lookup_login`, by the callers and purposes listed; no
  SQL read by anyone else.
- **Keys**: `KEK_PD` generations, index keys and day expiry keys in the Kenyan HSMs only;
  subject, account payload and bucket keys only wrapped in the store's key table; nothing
  escrowed (RFC-005 D-2). Unwrapped bucket keys of open hours are cached in instance memory
  until the hour closes, invalidated on every instance before an `erase` destroying them
  answers; subject keys are not cached beyond a request.
- **Load** (est., R36-18): `put_payload` ≤ 1,000/s by the caps (about 26/s at planning,
  RFC-006 §14.4); `put` about 50/s; `get` about 2,000/s peak (logins and notices); HSM
  unwraps: one per subject read, one per bucket-hour per instance for payloads.
- **Backups**: RFC-006 runs `backup_pds` to Ceph in R1 and R2 only, daily full plus hourly
  incrementals, no revision history, backup-key encrypted, tagged with every `KEK_PD`
  generation they contain, kept `pd_backup_retention` = 7 days, no key inside.
- **Store events feed topic**: written only by identity's relay; read only by RFC-006's
  pruner and restore tooling (ACL by workload identity).
- **Counts of payloads not kept**: the authoritative count and report to network
  operations is ingestion's, derived from its `ingest_log` (`drop-alert`, hourly
  `drop-count`); the store's own per-exporter-and-minute counts of cap, late, erased and
  withdrawn go to monitoring for reconciliation only.

## Timeouts and deadlines

| Item | Value | Owner |
|---|---|---|
| `put_payload` keep deadline | Commit only at ≤ `keep_by` − ε; ε = `max_offset` = 100 ms | Store |
| `put_payload` caller wait | `keep_by` + ε = issue + `pd_put_timeout` (500 ms, est.); then the batch commits with the put "dropped: unanswered, withdrawal pending" | Ingestion |
| `withdraw_payload` | Retried with backoff until answered; alert at 10 min pending (est.) | Ingestion |
| `get` for C16 | No deadline; `temporarily_unavailable` makes the payout run wait for that supplier | Identity, payouts |
| `get` for notifier, reporting, console | Caller's request deadline; on unavailability show identifiers or wait (RFC-005 §14) | Callers |
| `erase` execution (R36-10) | **Deadline r + 10 days; page at r + 7 days; forced generation rotation for any e > r + 9 days; incident at r + 14 days** (`erasure_incident` moved from 20). **Breach path**: an execution after r + 23 days cannot meet `erasure_max` even with a forced rotation; identity records it as an `erasure_max` breach, pages compliance and platform on-call, executes at once with a forced rotation, and the breach is reported to compliance with the request | Identity |
| Erased payload rows | Deleted within 24 h of the erasure | Store |
| Expiry | d's start + `dispute_window` + 7 days; day d's rows deleted after `expiry_destroyed(d)` commits | Store (HSM schedule) |
| Generations | New every 7 days (and at once for a late erasure); each destroyed at its usage end (`s_g+1` + 7 days); alarm if one older than 14 days exists | Store |
| Backup pruning | 7 days of age; within 24 h of a contained generation's `generation_destroyed`; daily conformance check | RFC-006 |
| Feed retention | ≥ 14 days, delete policy | RFC-006 (Kafka), identity (relay) |
| Restore | Fenced until every event through the outbox head read after fencing is re-applied | RFC-006 |
| `digest_key` | No deadline; without a cached version the exporter partition waits (batch unacknowledged, alerted) | Ingestion |
| Read grant | `not_after` = signing + `read_grant_ttl` (1 h); operator check cache 60 s | Store as reader |

## Versioning and compatibility

- Additive changes only within a major version: a new optional request field, a new answer
  variant offered only to a caller that lists its capability in `capabilities` (none is
  defined today), a new `GetPurpose`, `CapName`, kind or event type. Consumers ignore
  unknown event types and unknown fields; a caller receiving an unknown `not_kept` reason
  treats it as not kept (nothing kept, counted as `cap`).
- `not_kept(erased)` is new in this version. Until RFC-003's erratum records it as its own
  drop reason, ingestion records it as "dropped: cap" by the rule above (R36-09).
- Never changed within a major version: idempotency keys, the `keep_by` − ε rule, "known
  outcomes only", the ordering "answer after event committed", the Kafka key, the meaning of
  `not_found`, the purpose → kinds table (narrowing only by a new major version).
- `put_payload` without `keep_by` (RFC-005 revision 4 form) is not accepted.
- A cap value, a rate limit or the storage allotment is a design parameter (RFC-005 §13,
  RFC-006 §14.4), changed by configuration, not by contract version.

## Scenarios relied on

P3-S71, P3-S75 (payloads); X1-S34, X1-S37, X1-S39, X1-S42, X1-S43, X1-S12 (erasure row)
(erasure, no personal data elsewhere); X1-S27, X1-S31 (operator reads with a grant); P4-S118,
X1-S46 (payout destination details through identity, C16); all at `requirements-v1.10`.

## Conformance tests

**Provider (identity and access)**

1. `put_payload` whose transaction is held past `keep_by` − ε answers `not_kept(late)` and
   leaves no item (RFC-005 DT-30). With an injected ambiguous commit, the store answers
   `temporarily_unavailable` (never `late` or `cap`), and a following withdrawal answers
   `was kept` or `was absent` matching the actual commit (R36-05).
2. A put committed with its answer dropped, then `withdraw_payload`: `withdrawn(was kept)`;
   the `payload_withdrawn` outbox row commits in the same transaction, before the answer,
   and appears on the feed eventually (R36-21); a retried put answers `not_kept(late)`; a
   withdrawal of a never-put `record_id` answers `withdrawn(was absent)`; a repeat
   withdrawal answers the same `was` and adds no event; a crash injected inside the
   withdrawal leaves neither deletion nor event (R36-14).
3. Caps, in a fixed UTC-second window: from one exporter, puts 1 … 10 in the second are
   admitted and the 11th is `not_kept(cap: per_exporter_count)`; bytes past 262,144 in the
   second are refused; with N instances, each instance refuses past 1/N of the global caps;
   in the next second the allowance is restored; a payload of 65,537 B is refused; with
   measured live payload bytes set at 36 × 10¹² B, a put is `not_kept(cap: storage)`; a
   repeat of a kept `record_id` consumes no token; during an injected rebalance an exporter
   is admitted at most 2× its caps for one window (R36-08).
4. A repeated kept `record_id` with a `received_at` in a later hour answers the first
   bucket; the same `record_id` with different bytes answers the first bucket, writes
   nothing, makes no HSM call and raises one integrity alert carrying no payload byte; after
   the item's keys are destroyed, a repeat answers the first bucket with no alert (S-G1,
   R36-17).
5. Validation: `received_at` 1 s in the future, 2 h in the past, on a day whose expiry key
   is destroyed, and `keep_by` beyond commit + `pd_put_timeout` each answer `not_kept(late)`
   with an integrity alert and keep nothing (R36-11).
6. At a day key's destruction, `expiry_destroyed(d)` is in the outbox only after its
   attestation entry commits; day d's payloads answer `not_found` and their rows are gone
   after it; with one HSM cluster declared decommissioned, the event carries its
   decommissioning record (S-M2, R36-07, R36-23).
7. `put` allowlist: the console putting each kind other than `case_note`, onboarding
   putting anything but `kyb_document`, are `refused(kind_not_allowed)`; a put of another
   kind on an existing item is `refused(kind_mismatch)`; overwriting each write-once kind
   (a `payout_destination_details` item above all) is `refused(item_exists)` and alerted; a
   console case note gets a store-minted ID, and a retry with the same `client_ref` the same
   ID (R36-01).
8. Mutable versions: A (v1) → B (v2) → A (v3) leaves A current; a delayed retry of v1 after
   v2 is `refused(stale)`; v2 with other content is `refused(version_conflict)`; `get`
   returns the highest version (R36-02).
9. Purpose → kinds: every (caller, purpose, kind) cell outside the table is refused, in
   particular notifier and reporting reading `kyb_document`, `case_note` or
   `payout_destination_details`, and a support grant reading a `legal_order_document`; a
   grant whose `read_type` differs from the purpose is refused; a reader past its rate is
   `refused(read_limit)`; the breadth alert fires on a scan of many subjects (R36-03).
10. Erase racing put of the same subject, and a case-note put tagged with it, at every
    interleaving: no item of the subject is readable after `store_commit`; every later put
    is `refused(subject_erased)` (R36-04).
11. `get` of an erased subject, an expired payload, a withdrawn payload and a never-existing
    item: byte-identical `not_found` (DT-15, DT-21); `lookup_login` answers `principal` and
    `not_found` with the same latency distribution (two-sample test, p > 0.05) (R36-30).
12. A console `get` without a read grant, with an expired grant, or outside the grant's
    target is refused; with one, the audit append exists before the answer and holds the
    `grant_id`, not reason text (DT-24, R36-19).
13. Payload erasure by account, by supplier and by exporters and period: payloads in scope
    unreadable at `store_commit` and their rows deleted within 24 h; a payload of the same
    exporter in an hour outside the period stays readable (DT-21); with a period ending
    after execution, a payload received in it after execution is `not_kept(erased)` and one
    received after the period is kept (R36-09); `erase` repeated with the same `request_ref`
    is a no-op with one event; a batched erase crashed after its first batch resumes and
    emits one event from the last batch (R36-15); an `erase` whose envelope fails the
    operator check is refused (R36-20).
14. Late execution: an erasure committed at r + 12 days forces a new generation at once,
    and every copy is unreadable by e + 7 days (R36-10).
15. A restored store backup taken before an erasure, after its generation's destruction,
    cannot unwrap the key; a payload in a restored backup is unreadable after its day's
    expiry key is destroyed (DT-15, DT-21).
16. Every operation from a workload identity not on its allowlist is refused (§4.4).
17. Event schema: every feed message validates against `StoreEvent` and contains no field
    outside it (no personal data; DT-14 marker scan).

**Metering ingestion (RFC-003)**

18. With the store delayed beyond 500 ms, the batch commits within the acknowledgement bound
    with "dropped: unanswered, withdrawal pending", then sends `withdraw_payload` (with
    `received_at`) until answered and records `withdrawn`; after a takeover the new holder
    re-sends it.
19. Each answer maps to its keep outcome (`kept` with the store's bucket, `dropped: cap`,
    `dropped: not taken in time`); `temporarily_unavailable`, every `refused` and a transport
    error are recorded "dropped: unanswered, withdrawal pending" and withdrawn (R36-05); an
    unknown `not_kept` reason, `erased` included until RFC-003's erratum, is handled as
    `cap`; all are counted in `drop-count`.
20. A `kept` answer to a re-send followed by the withdrawal of the earlier put: the log's
    later entry (`withdrawn`) is authoritative, and the evidence path accepts `not_found`
    (R36-28).
21. With no digest key version cached and `digest_key` unavailable, the batch with a
    non-conforming payload is neither committed nor acknowledged; other exporters proceed. A
    new registered exporter's first fetch gets version 1; `not_found` is alerted as a
    configuration error (R36-12).
22. No log row, topic or trace holds a payload byte (DT-14 marker scan).

**Identity for payouts (C16), notifier, reporting, console**

23. Each reads with its own purpose and kinds only; a stub store recording reads shows no
    other purpose used and no content persisted after the request (marker scan).
24. Payout run with the store answering `temporarily_unavailable`: the run waits for that
    supplier and retries; the instruction carries `destination_ref` and version only; with
    the store answering `not_found`, C16 answers "not found" and finance is escalated
    (R36-24).

**RFC-006 pruner and restore tooling**

25. Feeding `generation_destroyed(g)`: every backup object tagged with g is deleted within
    24 h; the daily check pages on any left (RFC-006 DT-25).
26. Duplicate delivery of any event changes nothing a second time.
27. A restore re-applies, through `reapply` on a fenced store, every `erasure_executed`,
    `expiry_destroyed` and `payload_withdrawn` from the backup's AS OF − `max_offset`
    through the outbox head read after fencing; an erasure committed but not yet relayed
    when the restore starts is re-applied; the restore emits no feed event; a `supplier`
    erasure re-applied deletes only the listed key versions, not later ones (R36-27); a
    restore with the feed withheld does not unfence; `reapply` on a serving store is
    refused; a backup whose oldest generation ends during the restore is not used, and the
    restored keys are rewrapped at once (S-M2, R36-06, R36-24).
28. The feed topic's configuration is `cleanup.policy=delete` with retention ≥ 14 days.

## Settled

Orchestrator decisions, binding; this draft specifies each.

| # | Point | Decision |
|---|---|---|
| S-M1 | **Storage cap** (RFC-006 §14.4, RK27 asked for it; RFC-005 RD-1, C12 and RFC-000 4.4 §8 named only count, byte and size caps) | Accepted: a sixth cap, `storage`, at 90% of the 40 TB per-copy allotment (36 × 10¹² B of live payload bytes per copy), on `put_payload` only, never on `put`; answered `not_kept(cap)` with `cap: "storage"`. A backstop since R36-07 |
| S-M2 | **Expiry on restore** (RFC-006 and RFC-000 §8 re-apply expiry "from the feed"; the feed had no expiry event) | A new feed event `expiry_destroyed(day, attestations)`, emitted only after identity commits its attestation entry, like `generation_destroyed`; restore tooling re-applies expiry from the feed (through `reapply`, R36-06), never by date computation |
| S-M3 | **Caps in RFC-006 §14.4** (count caps only) | RFC-005's full set: 10/s and 256 KiB/s per exporter, 1,000/s and 4 MiB/s overall, 64 KiB a payload (plus S-M1), enforced as R36-08 states |
| S-M4 | **Withdrawal trigger label** (RFC-005 §3.7 "not kept: store unavailable" vs RFC-003 §3.3) | RFC-003's label: "dropped: unanswered, withdrawal pending" |
| S-G1 | **Same `record_id`, different bytes** | Answered as the first put; if the bytes differ, the store also raises an integrity alert (identifiers only); compared as R36-17 states |
| S-G2 | **`get` purpose vocabulary** | The `GetPurpose` enum with its per-caller allowlist, bound to kinds and grants by R36-03 |
| S-G3 | **`digest_key` by version** | Optional `version` argument accepted |

## Review 36 resolution

Every proposed fix accepted (orchestrator, binding), with the decisions D-36-1 … D-36-5.

| Finding | Change |
|---|---|
| R36-01 (Blocker) put writes any kind | Per-caller kind allowlist; kind fixed at first put; write-once kinds (`payout_destination_details` versions are new items minted only by identity's C16 command; mutable kinds such as `login_identifier` change only by new versions from identity's own commands, never overwritten); store-minted case-note IDs; new refusals; test 7 |
| R36-02 put versioning | Versioned by item identifier (RFC-000 §8) with `version` and an `expected_version` precondition; stale retry `refused(stale)`; `version_conflict`; `get` returns the highest version; AI-36-1; test 8 |
| R36-03 purpose not bound to kind or grant | Purpose → kinds table (D-36-1); `read_type` an enum equal to the purpose; grant roles per kind; rate limits for every reader and a breadth alert; test 9 |
| R36-04 put resurrects an erased subject | Subject tombstone on erase; puts to a tombstoned subject or tag refused; put and erase serialise on the key row; test 10 |
| R36-05 ambiguous put outcome | Store answers cap, late or erased only when known not committed; caller treats unavailable, refused and transport error as unanswered and withdraws; re-send only before `keep_by` + ε; tests 1, 19 |
| R36-06 restore not implementable | Restore procedure: fence, `store_outbox_head`, cutoff at AS OF − `max_offset` through the head, `reapply` (no events, idempotent by `event_id`); feed retention ≥ 14 days with delete policy; tests 27, 28 |
| R36-07 rows never deleted | Day d's rows deleted after `expiry_destroyed(d)`; erased rows within 24 h; live payload bytes defined and measured; storage cap a backstop with the arithmetic; test 6, 13 |
| R36-08 infeasible caps | Per-instance in-memory token buckets, fixed one-second window, exporter routing, global budget split over N = 8 instances (est.), no hot row, overshoot bound; attempts admitted (D-36-5); test 3 rewritten |
| R36-09 later payloads in an erased period | Erased ranges until `to` + `dispute_window` + 7 days; `not_kept(erased)` (D-36-3); counted as `cap` until RFC-003's erratum; test 13 |
| R36-10 bound only if executed by day 10 | Execution deadline r + 10 days, page at r + 7; forced generation rotation for e > r + 9 days; incident at r + 14; bound min(r + 23, e + 14) days, e + 7 after a forced rotation; breach path for e > r + 23 stated (D-36-4, AI-36-2); test 14 |
| R36-11 unvalidated `received_at`, `keep_by` | Store validates both against its commit timestamp; `not_kept(late)` with an integrity alert; test 5 |
| R36-12 `digest_key` `not_found` undefined | Version 1 created atomically on first request for a registered exporter; `not_found` only for an unregistered exporter or unissued version; alerted, not retried; test 21 |
| R36-13 RFC-000 §8 left out | RFC-000 §8 erratum (AI-36-1) added to "Consumer obligations" |
| R36-14 withdrawal atomicity and day | One transaction with the tombstone (holding `was`) and the outbox row; `received_at` added to the request; the event carries day and `was`; test 2 |
| R36-15 batched erase | Key set fixed at the first batch; progress stored; event and `store_commit` in the last batch; test 13 |
| R36-16 schema lags semantics | `RefusalCheck` completed; caller-specific `GetRequest` variants; `capabilities` on every request |
| R36-17 S-G1 comparison cost | SHA-256 sealed under the C13 column key, no HSM call; no comparison once keys are destroyed; test 4 |
| R36-18 HSM per item, no load figures | Bucket key wrapped under `X_d` once per bucket-hour; load estimates; key caching stated (Ownership) |
| R36-19 free-text reason | `reason` a POL-32 reason code; audit records `grant_id`, not reason text; `role`, `read_type` enums; test 12 |
| R36-20 erase without envelope evidence | `EraseRequest` carries `action_id` and digest; store runs the C15 operator check for compliance and records the operator; test 13 |
| R36-21 test 2 promise | Test 2 checks the outbox commit before the answer, the feed eventually |
| R36-22 TB undefined | Units: TB = 10¹² B; KiB and MiB for the rate caps; storage cap in bytes; arithmetic corrected to 1.34 × 10¹³ B |
| R36-23 lost HSM cluster | Events emitted with attestations present plus a four-eyes decommissioning record; `Attestations` type; test 6 |
| R36-24 restore rewrap and lost items | Rewrap at once; a backup whose oldest generation ends during the restore not used; lost items `not_found`, C16 maps to "not found", identity alerts and asks re-entry; tests 24, 27 |
| R36-25 addressing | Case note subject = store-minted note ID, readable under a grant targeting any tagged subject; payout details subject = supplier ID (RQ-36-2) |
| R36-26 supplier-scope notice | Notice only for `exporters_period` scopes (D-36-2) |
| R36-27 scope re-applied too broadly | `erasure_executed` carries `destroyed` (concrete key versions and erased ranges); `reapply` deletes exactly those; test 27 |
| R36-28 kept then withdrawn | The later of kept and withdrawn in ingestion's log is authoritative; `not_found` after `withdrawn` expected; test 20 |
| R36-29 caller clock | Precondition: ingestion host clock within `max_offset` under RFC-006's discipline |
| R36-30 login lookup | `lookup_login`, identity only, audited without the identifier, rate-limited, equal latency; test 11 |
| R36-31 C16 conflicts | Carried to the C16 review (closing note) |

## Consumer obligations

Each takes the changes as errata after this contract is frozen; until then this contract
records the agreed reading, and the RFCs are not edited.

- **RFC-000 §8** (AI-36-1, R36-13): personal-data store row: put idempotent by (subject,
  item, version) with write-once kinds and per-caller kinds (R36-01, R36-02); the storage
  cap (S-M1); `expiry_destroyed` (S-M2); the `GetPurpose` table with purpose → kinds (S-G2,
  R36-03); `not_kept(erased)` and erased ranges (R36-09); "payloads not kept are counted from
  ingestion's log and reported hourly to network operations; the store's own counts
  reconcile only" (replacing "counted per exporter and minute and reported"); the
  restore-only `reapply` and `store_outbox_head` for RFC-006 (R36-06); `lookup_login`.
- **RFC-005**: S-M1, S-M2, S-M4, S-G1 … S-G3; R36-01 … R36-05, R36-07 … R36-12, R36-14 …
  R36-20, R36-22 … R36-25, R36-27, R36-30; and AI-36-2 in §3.7 and §13: a forced
  generation for any erasure committed after r + 9 days, `erasure_incident` 14 days, the
  bound min(r + 23, e + 14) days (e + 7 after a forced rotation), and the supplier notice
  only for non-user (`exporters_period`) scopes.
- **RFC-006**: S-M1, S-M2, S-M3; R36-06 (restore procedure, `reapply`, fencing, cutoff,
  feed retention ≥ 14 days), R36-07 (deletion at expiry makes the 40 TB allotment a
  backstop), R36-24 (rewrap at once, backup choice).
- **RFC-003**: S-M4 (already its label); R36-05 (every non-answer withdrawn), R36-09
  (`not_kept(erased)` as a drop reason), R36-12 (`not_found` as a configuration error),
  R36-14 (`received_at` on `withdraw_payload`), R36-28 (the later log entry
  authoritative), R36-29 (clock precondition); S-G3 (the evidence query calls `digest_key`
  with the recorded version); an unknown `CapName` or `not_kept` reason handled as `cap`.
- **RFC-004**: none beyond C16's mapping of `not_found` (R36-24), already its "not found"
  path.

## Open issues raised by review 36

These don't block this contract's re-review. They go to the requirements and architecture
owners.

- **RQ-36-1**: how long a non-user's erasure-request evidence (a case note tagged with the
  request's `subject_id`) is kept; today the request's scope does not include it.
- **RQ-36-2**: whether a sole trader's payout destination details are erased on a covering
  request, or kept while any payout under the version may be reconciled.
- **RQ-36-3**: whether a user-of-supplier request covers payloads received after execution;
  this contract reads "received before the erasure" (RFC-005), and only an
  `exporters_period` scope blocks later payloads (D-36-3).
- **AI-36-1, AI-36-2**: under "Consumer obligations".

Outside this contract (R36-31, carried to the C16 review): RFC-000 rev. 4.4 C4-5 adopts "a
held administrator's destination change is held, then applied", but `requirements-v1.10`
X1-S46 at 11:00 says it is refused, the destination unchanged and the attempt recorded; and
RFC-004 §B7.1's "a re-instruction reuses" the destination version conflicts with P4-S118's
third example, which sends the next run's re-instruction to the new destination.
