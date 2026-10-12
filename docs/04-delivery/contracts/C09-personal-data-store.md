# C09. Personal-data store

| | |
|---|---|
| Contract ID | C09 |
| Version | 1.1 |
| Status | **Frozen.** Frozen at C4 on fix verification 60; errata owed listed below ("Consumer obligations"). v1.1: errata from review 64 (clarifications; no interface removed); see "Review 64 errata". [Fix verification 60](../../reviews/60-contract-C09-fix-verification.md) gave ACCEPT WITH CHANGES. Version 1 applies its V60-1 … V60-6 as proposed ("Fix verification 60 resolution"). Draft.3 answered [review 48](../../reviews/48-contract-C09-review.md), and draft.2 answered [review 36](../../reviews/36-contract-C09-review.md). Draft.3 also made the joint change from C11 draft.2 (`RecordId` gets the observation domain and the NetFlow v9 record index, C11 F41-15). The earlier settled points stay ("Settled") |
| Provider | Identity and access (RFC-005 revision 5, §3.7, §10, C12; the key service for `digest_key`) |
| Consumers | Metering ingestion (RFC-003 revision 5 + erratum 5.1, through C11: `put_payload`, `withdraw_payload`, `digest_key`); the evidence query (RFC-003: `digest_key`); identity and access itself (`put`, `tag_note`, `get`, `lookup_login`, `erase`, `store_outbox_head`; `get` purpose "payout destination" for payouts, RFC-004 revision 5 through C16; KYB documents for onboarding); notifier (`get`, contact details at send time); operator console (`put` of case notes and request and order documents, `get` with a read grant); reporting (`get`, display names at view time); RFC-006 revision 6 backup pruner and restore tooling (store events feed, `reapply`) |
| Transport | Store operations, `digest_key` and `store_outbox_head`: synchronous query and command (gRPC over mTLS, caller allowlist by workload identity, RFC-005 §4.4). Store events feed: Kafka event, published from one partition of identity's transactional outbox (RFC-000 §8 personal-data store row, A1) |
| Pinned to | `requirements-v1.10`; RFC-000 revision 4.4 (§8 personal-data store, payout destination, operator check and read grant rows, A11, §5.3); RFC-005 revision 5 (§3.1, §3.7, §4.4, §7.2, §7.5, §7.6, §10, §13, §14, §15 DT-15, DT-21, DT-24, DT-30, C4, C12, C13, C15, C16); RFC-003 revision 5 with erratum 5.1 (§1.2, §3.3, §3.4, §7, §8); RFC-004 revision 5 with erratum 5.1 (§B7.1, §B8, contract table); RFC-006 revision 6 (§3.2, §14.4, DT-25, RK27); C11 1.0.0-draft.2 (`RecordId` mapping) |

## Purpose

RFC-000 A11: personal data never enters a log. This store is the only place personal data
lives: users', operators' and contacts' names and contact details, login identifiers,
display names, KYB documents, case notes, legal-order and erasure-request documents,
payout-destination details, and the payloads of non-conforming flow-record data sets.
Every item is encrypted per data subject (a payload under nested bucket, day-expiry and,
reserved, account keys), so erasure is key destruction (crypto-shredding) and no log is
ever rewritten. The operations are kept apart, each with its own callers and, for `put`
and `get`, its own item kinds: **put**, **tag_note**, **put_payload**,
**withdraw_payload**, **get**, **lookup_login**, **erase**, **expire**; the **store events
feed** and the restore-only **reapply** that let backups and restores honour every
destruction; and **digest_key**, which makes the digest ingestion keeps of a
non-conforming payload a keyed one.

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

**Caller.** The store gets the caller from the mTLS workload identity. No request body
names the caller (R48-17).

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
type KeySerial = string;              // store-wide, strictly increasing serial of payload keys (R48-06)
type EventId = { partition: "pds"; sequence: string };   // the one store-events outbox partition, dense sequence (R48-12)

type RequestMeta = { capabilities: string[] };            // on every request; [] today (see Versioning)

type Unavailable = { kind: "temporarily_unavailable" };   // see each operation for what the caller must assume
type RefusalCheck =
  | "caller_not_allowed"        // workload identity not on the operation's allowlist
  | "invalid_request"           // malformed input: unknown kind, empty tags on a case note, bad digest length (R48-17)
  | "kind_not_allowed"          // put: caller may not write this kind (R36-01)
  | "kind_mismatch"             // put: item exists with another kind (R36-01)
  | "item_exists"               // put: write-once item exists with other content (R36-01)
  | "version_conflict"          // put: same version, other content (R36-02)
  | "stale"                     // put: expected_version not current, or version not above it; answer carries current_version (R48-04)
  | "subject_erased"            // put, tag_note: subject or a tag is tombstoned (R36-04)
  | "purpose_not_allowed"       // get: purpose not allowed for the caller (S-G2)
  | "kind_not_for_purpose"      // get: item kind not readable under the purpose (R36-03)
  | "read_grant_invalid"        // get: grant fails C4 / C15, or read_type ≠ purpose, or role not allowed
  | "target_out_of_grant"       // get: target is not the grant's one target
  | "read_limit"                // get, lookup_login: rate limit (R36-03, R36-30)
  | "exporter_mismatch"         // put_payload: exporter ≠ record_id.exporter
  | "scope_conflict"            // erase: other scope under a committed request_ref
  | "envelope_invalid"          // erase: envelope does not verify, or does not sign this request_ref and scope (R48-05)
  | "not_restoring";            // reapply: store not fenced for a restore (R36-06)
type Refused = { kind: "refused"; check: RefusalCheck;
                 current_version?: string };              // only with check "stale" (R48-04); a log sequence, no data

// ---------- item kinds (R36-01, R36-03, R48-07) ----------
type MutableKind = "name" | "contact" | "login_identifier" | "display_name";
type NoteKind = "case_note" | "erasure_request_document" | "legal_order_document";   // console, store-minted ID
type WriteOnceKind = NoteKind | "kyb_document" | "payout_destination_details";
type ItemKind = MutableKind | WriteOnceKind;

// ---------- record identity of a payload (RFC-003 §3.3 step 2; C11 F41-15) ----------
type RecordId = {
  exporter: ExporterId;
  ref:
    | { kind: "identity";                          // RFC-003 §3.2 record identity, per C11 RecordIdentity
        observation_domain: number;                // IPFIX Observation Domain ID / NetFlow v9 Source ID, uint32
        exporter_epoch: string;                    // ingestion's epoch number per (exporter, domain)
        sequence: string;                          // IPFIX: extended sequence of the record; NetFlow v9: extended packet sequence
        index?: number }                           // NetFlow v9 only: the record index in the packet; absent for IPFIX
    | { kind: "raw";
        partition: string;                         // = exporter
        log_seq: string;                           // the batch entry's log sequence
        index: number };                           // the payload's ordinal among the entry's non-conforming payloads
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
  | { kind: "kyb_document" | "payout_destination_details";   // identity only (KYB for onboarding, R48-17)
      subject: SubjectId;                      // payout_destination_details: the supplier ID (R36-25)
      item: ItemId;                            // payout_destination_details: "<destination_ref>/<version>"
      content: Uint8Array }
  | { kind: NoteKind;                          // console only; the store mints the note ID (R36-01 d, R48-07)
      tags: SubjectId[];                       // case_note: ≥ 1; request and order documents: ≥ 0
      client_ref: string;                      // console's idempotency key for this note
      content: Uint8Array }
);
type PutAnswer =
  | { kind: "stored"; subject: SubjectId; item: ItemId; version: string | null; commit: EpochMicros }
  | Unavailable | Refused;

// ---------- tag_note (identity only, R48-07) ----------
type TagNoteRequest = RequestMeta & { note_id: SubjectId; subject: SubjectId; request_ref: RequestRef };
type TagNoteAnswer = { kind: "tagged" } | Unavailable | Refused;

// ---------- put_payload ----------
type PutPayloadRequest = RequestMeta & {
  record_id: RecordId;
  exporter: ExporterId;               // = record_id.exporter, else refused(exporter_mismatch)
  supplier: SupplierId;
  account?: AccountId;                // reserved: RFC-003 never sends it (R48-23)
  received_at: EpochMicros;           // edge receipt of the batch (validated, R36-11)
  keep_by: EpochMicros;               // latest time the payload may be kept (validated, R36-11)
  payload: Uint8Array;                // ≤ 65,536 B to be keepable
};
type PutPayloadAnswer =               // cap, late, erased: only when known not committed (R36-05)
  | { kind: "kept"; bucket: PayloadBucket }           // durable in two regions
  | { kind: "not_kept"; reason: "cap"; cap: CapName }
  | { kind: "not_kept"; reason: "late" }              // also tombstoned record_id and failed validation
  | { kind: "not_kept"; reason: "erased" }            // received_at in an erased range (R36-09, R48-21)
  | Unavailable | Refused;
type CapName =
  | "per_exporter_count"   // payload_put_limit      10 /s per exporter
  | "per_exporter_bytes"   // payload_bytes_limit    262,144 B/s per exporter
  | "global_count"         // payload_put_global     1,000 /s, shared over instances (R36-08, R48-16)
  | "global_bytes"         // payload_bytes_global   4,194,304 B/s, shared over instances
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
type ReasonCode = string;             // a code from the action catalogue's reason list (RFC-005 §7.2, §3.1); never free text (R48-18)
type ReadGrant = {                    // RFC-005 §7.6, C4
  grant_id: string; operator: string; role: OperatorRole;
  read_type: ConsolePurpose;          // must equal the get's purpose (R36-03)
  target: { kind: "subject"; subject: SubjectId } | { kind: "payload"; record_id: RecordId };
  reason: ReasonCode; not_after: EpochMicros;
  webauthn: { authenticator_data: string; client_data_json: string; signature: string; credential_id: string };
};
type GetRequest = RequestMeta & (     // variants by purpose; the caller is the workload identity (R48-17)
  | { purpose: "login" | "administrator_command" | "payout_destination" | "notice_delivery" | "statement_display";
      subject: SubjectId; item: ItemId }
  | { purpose: "support_view" | "case_note"; subject: SubjectId; item: ItemId; read_grant: ReadGrant }
  | { purpose: "flow_record_dispute"; record_id: RecordId; read_grant: ReadGrant }
);
type GetAnswer =
  | { kind: "found"; content: Uint8Array; version: string | null }   // highest version; hold in memory for the request only
  | { kind: "not_found" }             // never existed, erased, expired, withdrawn, lost in a restore: indistinguishable
  | Unavailable | Refused;

// ---------- lookup_login (identity only, R36-30) ----------
type LookupLoginRequest = RequestMeta & { normalised_identifier: string };   // plaintext over mTLS, never logged
type LookupLoginAnswer =
  | { kind: "principal"; principal_id: SubjectId; version: string }   // version of the matched login_identifier item (V60-5)
  | { kind: "not_found" } | Unavailable | Refused;

// ---------- erase ----------
type ErasureScope = {
  subjects: SubjectId[];                             // subject keys, items, blind-index rows, every note tagged with them
  account_payload_keys: AccountId[];                 // reserved (R48-23): a user of account a -> a's account payload key
  bucket_keys:
    | { kind: "none" }
    | { kind: "supplier"; supplier: SupplierId }     // every bucket key of the supplier's exporters, existing at the first batch
    | { kind: "exporters_period"; exporters: ExporterId[]; from: EpochMicros; to: EpochMicros }; // every hour meeting [from, to)
};
type DestroyedKeys = {                                // concrete, so a restore re-applies exactly these (R36-27)
  subjects: SubjectId[];
  notes: SubjectId[];                                 // every note ID deleted because a tag was erased (R48-01)
  account_payload_keys: { account: AccountId; through_serial: KeySerial }[];
  bucket_key_ranges: {                                // range encoding (R48-06): every bucket key of the exporter
    exporter: ExporterId;                             // for every hour in [from_hour, to_hour],
    from_hour: UtcHour; to_hour: UtcHour;             // with a key serial ≤ through_serial
    through_serial: KeySerial }[];
  erased_ranges: { exporter: ExporterId; from: EpochMicros; to: EpochMicros }[];   // R36-09, R48-21
};
type EraseEnvelope = {                                // the compliance envelope identity applied (R48-05)
  action_type: "erase_personal_data";
  action_id: string;
  request_ref: RequestRef;                            // signed; must equal EraseRequest.request_ref
  scope: ErasureScope;                                // signed; must equal EraseRequest.scope
  verification_ref?: string;                          // non-user request: the note ID of the request's erasure_request_document (the evidence the verification cites) (V60-6)
  not_after: EpochMicros;
  assertions: { operator: string; credential_id: string; counter: number;
                authenticator_data: string; client_data_json: string; signature: string }[];
};
type EraseRequest = RequestMeta & { request_ref: RequestRef; scope: ErasureScope; envelope: EraseEnvelope };
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
  | { type: "erasure_executed";                       // one or more parts per request (R48-06)
      request_ref: RequestRef; part: number; of: number;      // part 1 … of
      scope?: ErasureScope;                           // in part 1 only
      destroyed: DestroyedKeys;                       // this part's share
      store_commit?: EpochMicros }                    // in the last part only
);
// Every encoded StoreEvent is ≤ 524,288 B (512 KiB). Topic max.message.bytes = 1,048,576.

// ---------- restore (RFC-006 restore tooling only, R36-06, R48-13) ----------
type StoreOutboxHeadRequest = RequestMeta;            // to identity
type StoreOutboxHeadAnswer = { kind: "head"; head: EventId; read_at: EpochMicros } | Unavailable | Refused;
type ReapplyRequest = RequestMeta & {
  restore_id: string;
  from_as_of: EpochMicros;                            // the backup's AS OF time
  through: EventId;                                   // the outbox head read after the fence
};                                                    // the store reads the feed itself (D-48-4)
type ReapplyAnswer = { kind: "applied"; through: EventId } | Unavailable | Refused;
```

The store's tables are identity's private schema (`pds` database, RFC-005 §3.7); no other
service has a SQL role on it, so no DDL is part of this contract.

## Semantics per operation

### put

- **Callers and kinds** (R36-01 a, R48-07, R48-17). Anything else is
  `refused(kind_not_allowed)`:

  | Caller (workload identity) | Kinds it may write |
  |---|---|
  | Identity | `name`, `contact`, `login_identifier`, `display_name`, `kyb_document` (identity puts it for onboarding's command; onboarding has no workload identity on the store), `payout_destination_details` |
  | Console | `case_note`, `erasure_request_document`, `legal_order_document` |

- **Kind fixed at first put** (R36-01 b): an item's kind never changes; a put of another
  kind is `refused(kind_mismatch)`.
- **Mutable kinds** (`name`, `contact`, `login_identifier`, `display_name`; identity only,
  each change from identity's own command): versioned by **item identifier** (subject,
  item) with `version` = identity's log sequence of the change (RFC-000 §8 "idempotent by
  item identifier", R36-02). Each version, once written, is never overwritten. The put
  commits only if `expected_version` equals the item's current version (null for a new
  item) and `version` is higher. `get` returns the highest version.
- **Order of commit and put** (R48-19). Identity commits the change in its log first. Then
  identity puts the new version. The lease holder re-drives every change entry that has no
  `stored` record. Until the put commits, `get` gives the previous version. (C16 is
  different: it puts the details first, then commits the new version. A write-once item has
  no previous version. Identity puts the details only after it has checked authorisation and
  the recovery hold; an item with no committed version is never read (E13).)
- **Stale answer and re-base** (R48-04, D-48-5). `refused(stale)` gives `current_version`.
  After a restore, the store can have an older version than identity. Identity then sends
  the put again with `expected_version` = `current_version` and its new `version`. The
  restore gives its AS OF time to identity (step 6 of "Restore"). Identity finds each item
  with a version after that time. It records an alert for each item and re-bases it at the
  next change. The user enters again a change that the restore lost.
- **Content below the projected version** (V60-5). Identity does not act on content whose
  `found.version` is below its own projected version for the item. It holds the notice and
  asks the user to enter the change again. For `lookup_login`, identity compares the
  answer's `version` with its projected version of the `login_identifier`. If the matched
  version is superseded, identity refuses the login and asks the user to enter the change
  again.
- **Write-once kinds** (`kyb_document`, `payout_destination_details` and the note kinds):
  an item is written once. A second put with the same content answers `stored`; with
  other content it is `refused(item_exists)` and alerted (R36-01 c). A new payout
  destination version is a new item `"<destination_ref>/<version>"`, minted by identity's
  C16 command only, unique for each command and never reused, so that a put left by a
  failed commit never makes a later change `refused(item_exists)` (E5, D-64-2).
- **Note kinds** (R36-01 d, R36-25, R48-07, D-48-2). The store mints the note ID. The
  subject is the note ID, and the item is `"note"`. The store tags the note with `tags`.
  The put is idempotent by (console, `client_ref`). A `case_note` must have one or more
  tags. An `erasure_request_document` or a `legal_order_document` can have zero tags,
  because identity mints the request's `subject_id` later. When identity records the
  request, it calls `tag_note` (next).
- **Payout destination details** (R36-25): subject = the supplier's ID (whether a covering
  erasure reaches them is RQ-36-2). `destination_ref` and `version` are identity-minted and
  contain no `/` (E17). v1 has no retention erase for these items; they stay until a
  covering erasure (RQ-36-2) (E11).
- **Erased subjects** (R36-04): a put whose subject, or any of whose `tags`, carries a
  subject tombstone is `refused(subject_erased)`. Put and erase serialise on the subject's
  key row (serialisable transactions), so no put commits after an erase of its subject.
- **Effect**: seals `content` under the subject's key (created on the first put of a
  subject that has no tombstone), AES-256-GCM, subject, item and version as associated
  data. **Answer** `stored` only once durable in two regions.
- **Errors**: `temporarily_unavailable` (outcome unknown; retry with the same arguments,
  which is idempotent); `refused(invalid_request)` for malformed input; the refusals
  above; `refused(caller_not_allowed)`.

### tag_note(note_id, subject, request_ref)

- **Caller**: identity only (R48-07). Identity calls it when it records an erasure request
  whose evidence is a note.
- **Effect**: the store adds `subject` to the note's tags and records `request_ref`. A
  tombstoned `subject` gives `refused(subject_erased)`.
- **Idempotency**: by (`note_id`, `subject`). A repeat gives `tagged`.

### put_payload(record_id, exporter, supplier, account?, received_at, keep_by, payload)

- **Caller**: metering ingestion only; only for non-conforming data sets (rejected
  `no template` or `unparseable`). C11 gives the mapping from its record identity to
  `RecordId`: the identity ref holds the observation domain, the epoch and the sequence,
  and for NetFlow v9 also the record index.
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
- **Key row read** (R48-09). Each `put_payload` and each `get` of a payload reads the
  bucket key row (exists, serial) in its transaction. The memory cache holds only the
  unwrapped key. Thus a key deletion has effect at its commit. Cache invalidation is
  hygiene only. An erase does not wait for it.
- **Outcomes** (exactly one):
  - `kept(bucket)`: committed, durable in two regions, in bucket (exporter, UTC hour of
    `received_at`). For a `record_id` already kept, the answer names **the first put's
    bucket**, whatever this call's `received_at`; nothing is written.
  - `not_kept(cap)`: a cap refused it (below). Nothing is kept anywhere.
  - `not_kept(erased)`: `received_at` falls in an erased range of the exporter (R36-09,
    D-36-3, R48-21). Nothing is kept.
  - `not_kept(late)`: the transaction reads `cluster_logical_timestamp()` and commits only
    if it is ≤ `keep_by` − ε (ε = `max_offset`, 100 ms); otherwise it aborts, is not retried
    past `keep_by`, and nothing is kept. **No item is ever kept by a commit timestamp after
    `keep_by` − ε.** Also the answer for a tombstoned `record_id` and for failed validation.
- **Key layers are nested** (R48-08). The store keeps:
  - the item key only as Wrap(bucket key, Wrap(account key, item key)). The inner wrap is
    there only if `account` is given (reserved, R48-23);
  - the bucket key only as Wrap(`KEK_PD,g`, Wrap(`X_d`, bucket key)), with d the UTC day of
    the bucket hour. The store makes the inner wrap once for each bucket hour (R36-18);
  - a generation rewrap changes only the outer `KEK_PD` layer.

  Thus there is no other path to the item key. When `X_d` is destroyed, no bucket key of
  day d unwraps. When an account key is deleted, its item keys do not unwrap.
- **Known outcomes only** (R36-05): the store answers `not_kept(cap)`, `not_kept(late)` or
  `not_kept(erased)` **only when its transaction is known not to have committed**. After an
  ambiguous commit result it answers `temporarily_unavailable`, or nothing.
- **The caller** treats `temporarily_unavailable`, `refused` of any kind and a transport
  error exactly as **unanswered**: it records "dropped: unanswered, withdrawal pending" and
  withdraws. It may re-send the same put only while its clock is before `keep_by` + ε.
- A `record_id` answered `not_kept` without a tombstone is not remembered: a later put of it
  (a resend, with its own `received_at`) is decided afresh.
- **Caps** (S-M3, R36-08, R48-16, D-36-5): an **admission limiter** of token buckets held in
  memory by each store instance, with a fixed one-second window aligned to the UTC second
  and a capacity of one window's allowance (no carry-over):
  - puts are routed to instances by exporter (consistent hashing), so each exporter's
    bucket (10 puts and 262,144 B per second) lives on one instance. An instance refuses
    (`temporarily_unavailable`) a put for an exporter that it does not own in its current
    routing view;
  - the global budget (1,000 puts and 4,194,304 B per second) is shared over the N serving
    instances (N = 8, est.). Each instance starts each window with 1/N. Each second, an
    instance lends its unused share of the last window to the instances that refused puts.
    The lender gives this share **out of its next window's allowance**: it starts that window
    with 1/N minus what it lent (V60-1). Thus, in each window, the sum of all allowances is
    the global cap, and the global caps are never exceeded. The unused budget is at most one
    window's lending delay, not (N − 1)/N;
  - tokens are taken at admission, after the repeat and tombstone checks (so a repeat of a
    kept `record_id` and a tombstoned one consume none), and refunded on a known non-commit;
  - there is no counter row in any transaction, so no single hot row;
  - **overshoot bound**: during a membership change, two instances can admit one exporter
    until both routing views agree. The bound is the exporter's caps × (membership
    propagation time + 1 s), with propagation 2 s or less (est.). The global caps do not
    overshoot;
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
- **Purpose → kinds** (R36-03, D-36-1, D-48-2). Anything else is
  `refused(kind_not_for_purpose)`:

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
  `refused(read_grant_invalid)`; the target must be the grant's one target, a note
  matching a grant whose target is any of its tagged subjects (R36-25), else
  `refused(target_out_of_grant)`; `operator_read_limit` enforced. The store **appends the
  read to audit before answering**: reader, purpose, subject or `record_id`, `grant_id`,
  operator, role; never the data and never reason text (R36-19).
- Every other `get` is appended to audit likewise (reader, purpose, subject).
- **Rate limits for every reader** (R36-03, R48-15; est., about 2.5 × the estimated peak, to
  be replaced by measured load): identity 5,000/s, notifier 1,000/s, reporting 500/s,
  console `operator_read_limit` per operator. Above them `refused(read_limit)`. A **breadth
  alert** fires when a (reader, purpose)'s distinct subjects in an hour exceed 3× its
  trailing seven-day hourly maximum (est.; T-29 extended); for `payout_destination`, the
  bound is the number of suppliers due in the run (E14, D-64-4).
- **HSM unwrap budget** (R48-15): one unwrap for each subject read and one for each bucket
  hour for each instance. The budget is 5,000 unwraps/s for each Kenyan HSM cluster (est.;
  RFC-005 §3.7 gives about 10⁴/s for each cluster). Above it, `get` gives
  `temporarily_unavailable`.
- **Answer** `found(content, version)` or `not_found`: never existed, erased, expired,
  withdrawn and lost in a restore are byte-identical answers.
- **Reader obligation**: content held in memory for the request only; never written to a
  table, topic, cache outliving the request, log or trace (A11).
- **Payout destination** (RFC-004 via C16): identity gets item
  `"<destination_ref>/<version>"` of the supplier with purpose `payout_destination`;
  payouts never call the store and never log the details. `not_found` (an item lost in a
  restore, R36-24) is mapped by C16 to `NOT_FOUND{version_gone}` on both forms (C07 op 5):
  payouts escalates to finance at once; identity alerts and asks every supplier
  administrator to enter the destination again (E3, D-64-1).

### lookup_login(normalised_identifier)

- **Caller**: identity only (R36-30). The store computes the blind index (HMAC-SHA-256
  under the current generation's index key, RFC-005 §3.7) and answers the `principal_id` or
  `not_found`, with the same latency distribution for both. Audited (identifier never
  recorded, only the outcome and the caller).
- **During a generation change** (R48-15): the store looks up under the current index key
  and under the previous one. It stops the second lookup when the recompute of the index
  is complete.
- **Rate limits** (R48-15): the edge limits login attempts for each source address
  (`preauth_rate_limit`, RFC-005 §5.3). The store limit is a backstop only: 5,000/s (est.).
  Above it, `refused(read_limit)`.

### erase(request_ref, scope, envelope)

- **Caller**: identity only, between its `erasure_executing` and `erasure_executed`
  entries, on a compliance envelope citing a recorded request for the same subject (and, for
  a non-user request, carrying its verification). Identity checks the request in its own
  state.
- **Envelope check** (R36-20, R48-05). At the first call for a `request_ref`, the store:
  1. makes sure that `envelope.request_ref` and `envelope.scope` are equal to the request's
     `request_ref` and `scope`;
  2. calculates the digest again from the signed fields (`action_type`, `action_id`,
     `request_ref`, `scope`, `verification_ref`, `not_after`);
  3. verifies the assertions by the C4 rules and the C15 operator check, with role
     compliance (X1-S13: support cannot erase);
  4. records a passing check (the result and the operator) with the `request_ref`.

  If one step fails, the answer is `refused(envelope_invalid)`. The store audits the
  failure and records nothing with the `request_ref` (V60-4). Thus a later call with a
  valid envelope gets a new check. A duplicate or a re-drive of a `request_ref` with a
  passing check gets its answer from that record. The store does not check the envelope
  again. Thus a re-drive after `not_after` or `approval_expiry` completes.
  **Residual**: identity serves C15. Thus this check stops a defective identity, but not a
  compromised identity.
- **Effect**:
  - delete the subjects' wrapped keys, their items and blind-index rows; delete **every
    note tagged with any erased subject**, also when other tags are live (R48-01, D-48-1;
    RFC-005 §7.5); write a **subject tombstone** for each subject (pseudonymous ID only,
    kept for the retention period, 7 years) (R36-04);
  - delete the named account payload keys (reserved) and bucket keys (a bucket still
    filling gets a new key with a higher serial);
  - write **erased ranges** (R36-09, D-36-3, R48-21). For an `exporters_period` scope:
    one range for each exporter, [`from`, `to`). For a `supplier` scope (and a reserved
    account scope): one range for each exporter of the set, [the earliest bucket hour in
    the set, `store_commit` + 1 h). A put with `received_at` in a range gets
    `not_kept(erased)`. The store keeps a range until its end + 1 h + `max_offset`
    (R48-23); after that, validation refuses such a `received_at`. A `supplier` scope does
    not cover payloads received after `store_commit` + 1 h (RQ-36-3);
  - append the erasure to audit; write `erasure_executed` to identity's outbox, in parts
    (below), naming the concrete keys destroyed (R36-27);
  - delete the payload rows whose keys were destroyed, by the sweep (see "expire").
- **Batching** (R36-15, R48-10): if the key set is larger than one transaction allows, the
  **first** batch fixes and stores the set under `request_ref`. The first batch also writes
  the subject tombstones and the erased ranges. Each batch commits its part and its
  progress. A re-drive resumes from the stored progress.
- **Event parts** (R48-06). The store encodes bucket keys as ranges (exporter, `from_hour`,
  `to_hour`, `through_serial`); this is nearly always one range for each exporter. The store
  writes the parts of `erasure_executed` with their batches. No encoded part is larger
  than 512 KiB. Part 1 holds the scope. The last part holds `store_commit`, the commit of
  the last batch. Consumers use an erasure only when they have all parts 1 … `of`.
  Consumers deduplicate parts by (`request_ref`, `part`), not only by `event_id`, because a
  re-drive after a restore can publish a part again with a new `event_id` (V60-2).
- **Answer** `erased(store_commit, destroyed)`. Items in a batch are `not_found` from that
  batch's commit, every item in scope from `store_commit`. Identity tells the supplier's
  administrators the exporter and hours destroyed **only for an `exporters_period` scope**,
  never by whom (R36-26, D-36-2).
- **Bound** (R36-10, D-36-4): with e the execution (`store_commit`) and r the request's
  record, every copy is unreadable by e + 14 days (generation h destroyed at `s_h+1` + 7
  days). If e ≤ r + 9 days, that is within r + 23 days. **If e > r + 9 days, identity
  starts a new `KEK_PD` generation at once** (RFC-005 §10's on-compromise procedure). Then
  every copy is unreadable by the rotation start + 7 days. The orchestrator accepts the
  bound min(r + 23, e + 14) days, and e + 7 days after a forced rotation.
- **Forced rotation mechanics** (R48-11):
  - the HSM usage end of a generation KEK is set when it is made. After a forced rotation,
    identity schedules the HSM quorum destruction of h at the new `s_h+1` + 7 days. It
    does not wait for the original usage end;
  - one forced rotation covers every erasure committed before its start. Identity starts no
    second rotation for those erasures;
  - for a forced rotation, e is the rotation start. Thus the execution deadline for a late
    request is r + 23 days − 1 h (est.).

### expire (store-internal, by schedule)

- No caller. The expiry is fixed at `put_payload`: the expiry key `X_d` of the UTC receipt
  day d, held only in the Kenyan HSMs, never escrowed or backed up, is destroyed by HSM
  quorum at d's start + `dispute_window` (30 days) + 7 days, attested. From then the
  payload is unrecoverable in every copy, backups and escrow included: at most
  `dispute_window` + 7 days, at least `dispute_window` + 6 days, after receipt.
- Identity commits the attestation entry that publishes `expiry_destroyed(d,
  attestations)`; day d counts as expired only once it is committed (S-M2).
- **Row sweep** (R36-07, R48-14). A sweep runs each day and after each restore. It deletes:
  - every payload row and withdrawal tombstone of a day whose `expiry_destroyed` is
    committed;
  - every payload row whose bucket key row or account key row is absent;
  - every erased range past its end + 1 h + `max_offset`.

  The sweep looks at the state, not at events. Thus it also deletes rows that a restore
  brought back.
- **A permanently lost HSM cluster** (R36-23): once it is declared decommissioned (four-eyes
  security officers, attested), `expiry_destroyed` and `generation_destroyed` are emitted
  with the attestations present plus the decommissioning record.
- **A decommissioned cluster that comes back** (R48-22): the security officers destroy its
  keys before it serves. Identity appends the attestation to audit. **Residual**: until
  then, a recovered or seized cluster holds the keys. The protection is the HSM tamper
  response (FIPS 140-3 level 3) and the usage-end dates.

### Store events feed

- **One partition** (R48-12). Identity writes every store event to one outbox partition,
  `"pds"`, with a dense sequence. This includes the store's withdrawals and erasures and
  identity's attestation entries. Thus the feed has a total order, and `store_outbox_head`
  is one `EventId`.
- `payload_withdrawn(record_id, day, was)`: committed in the withdrawal's transaction,
  before `withdraw_payload` answers.
- `expiry_destroyed(day, attestations)`: committed with the expiry key's attestation entry
  (S-M2).
- `generation_destroyed(g, attestations)`: committed with the attestation entry; g counts
  as destroyed only once it is committed.
- `erasure_executed(request_ref, part, of, scope?, destroyed, store_commit?)`: one part in
  each batch of `erase`, the last part in the last batch (R48-06).
- **Size** (R48-06): each encoded event is 512 KiB or less. The topic's
  `max.message.bytes` is 1,048,576.
- Identifiers only, never personal data. Consumers: RFC-006's backup pruner (deletes within
  24 h every backup object tagged with a destroyed generation; at 7 days of age
  regardless), RFC-006's restore tooling, and the store itself during `reapply` (R48-13).
- **Retention** (R36-06): `cleanup.policy=delete`, never compaction, retention ≥ 14 days
  (est.: 7 days of backups plus 7 days of margin).

### Restore (RFC-006 restore tooling; R36-06, R36-24, R48-03, R48-13)

1. Choose a backup. Do not use a backup whose oldest contained generation reaches its
   usage end during the expected time of the restore.
2. **Set the fence before the restore starts.** The fence is a control row in identity's
   own tables, outside `pds` (V60-3). Store instances read it. While it is set, they serve
   only `reapply` and the rewrap (step 3). They give `temporarily_unavailable` to every
   other operation, and `reapply` is `refused(not_restoring)` when the row is not set. Then
   restore the backup.
3. Rewrap every key under the current `KEK_PD` generation at once.
4. Call identity's `store_outbox_head()` after the fence is set. Wait until the relay has
   published through that head.
5. Call `reapply(restore_id, from_as_of, through)`, with `from_as_of` the backup's AS OF
   time. The store reads the feed itself (D-48-4), from the first event with
   `committed_at` ≥ `from_as_of` − `max_offset`, through `through`, in feed order. The
   tooling cannot give events. `reapply` is `refused(not_restoring)` on a store that is not
   fenced. It writes no event and is idempotent by `event_id` (a reapply ledger in the
   restored store). For each event, `reapply` deletes what the act deleted, and **writes
   the state that the act wrote** (R48-03):
   - `erasure_executed`: `reapply` applies **each part as it reads it** (V60-2). It deletes
     the keys, items, blind-index rows, notes and key ranges that the part lists. From part
     1, it **writes** the subject tombstones, the erased ranges and the `request_ref`
     record. It marks the record "envelope checked", because an event exists only if the
     check passed (the operator is in audit). The record holds the progress through the last
     part read, and `store_commit` when it reads the last part. A re-drive of `erase`
     resumes from that record, with no envelope check again. It gives numbers to new parts
     after the last published part. When the record has all parts, a re-driven `erase` gets
     the original answer and the store writes no event;
   - `payload_withdrawn`: delete the item; **write** the withdrawal tombstone with `was`
     and `day`. Then a re-driven withdrawal gets the original `was` and the store writes no
     second event;
   - `expiry_destroyed`: delete day d's payload rows and tombstones;
   - `generation_destroyed`: nothing in the store (the pruner uses it).

   No expiry is derived by date computation (S-M2).
6. Run the row sweep. Give the restore's AS OF time to identity, for the re-base of
   mutable items (R48-04). Identity gets each payout-destination version in force at, or
   committed after, the AS OF time; for each `not_found` it asks every supplier
   administrator to enter the destination again at once (E19). Remove the fence.
7. Items put after the backup and not put again are lost: `get` answers `not_found`.
   Identity alerts and asks for re-entry (payout destinations: see "get").

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
| `put`, `tag_note`, `put_payload`, `withdraw_payload`, `erase`, `reapply` | Caller retries until answered (at-least-once request); **exactly-once effect** by the idempotency keys below | Per subject: put, `tag_note` and erase serialise on the subject's key row. Per `record_id`: a withdrawal committed before a retried put makes the put answer `not_kept(late)`; a put committed before the withdrawal is deleted by it. Otherwise none across calls |
| `get`, `lookup_login`, `digest_key`, `store_outbox_head` | Request-reply; no effect but the audit append (and `digest_key`'s first-version creation) | — |
| Store events feed | At-least-once from identity's transactional outbox (an event exists iff its act committed); consumers deduplicate by `event_id` | One outbox partition and Kafka key `"pds"`: one Kafka partition, total order in commit order (R48-12) |

## Idempotency

| Operation | Key | Duplicate | Same key, different content |
|---|---|---|---|
| `put`, mutable kind | (subject, item, `version`) | Same version, same content: `stored`, no write | Same version, other content: `refused(version_conflict)`. `expected_version` not the current version, or `version` not above it: `refused(stale)` with `current_version` (a delayed retry after a later change, or a store restored to an older version; R48-04) |
| `put`, `kyb_document`, `payout_destination_details` | (subject, item) | Same content: `stored`, no write | `refused(item_exists)`, alerted |
| `put`, note kinds | (console, `client_ref`) | `stored` with the note ID first minted | `refused(item_exists)`, alerted |
| `tag_note` | (`note_id`, `subject`) | `tagged`, no write | — |
| `put_payload` | `record_id` | Kept: `kept(first bucket)`. Tombstoned: `not_kept(late)`. Not kept and not tombstoned: decided afresh | `record_id` contains the keyed digest, so different bytes mean a defect: answered as the first put, nothing written, and an **integrity alert** (identifiers only) (S-G1). The comparison value is **HMAC-SHA-256 of the plaintext under the item's bucket key** (R48-02, D-48-3). The store compares only while the bucket key is unwrapped in memory (the open hour). Otherwise it gives the first bucket, with no comparison and no alert. There is no HSM call. No stored value from the plaintext stays readable after the bucket key is destroyed |
| `withdraw_payload` | `record_id` | `withdrawn` with the tombstone's `was`; no second event | — |
| `erase` | `request_ref` | `erased` with the first `store_commit` and `destroyed`, from the `request_ref` record, with no envelope check again. A re-drive after a restore resumes from the record that `reapply` wrote, and numbers new parts after the last published part (V60-2). Consumers deduplicate parts by (`request_ref`, `part`) (R48-03, R48-05) | `refused(scope_conflict)`; identity never re-scopes a request |
| `reapply` | `event_id` | Skipped | — |
| `digest_key` first version | exporter | The same version 1 | — |
| Store events | `event_id` | Consumers apply once | — |

## Ownership

- **Writes**: identity and access only (the `pds` database, its own zone configuration, 5
  voters, no non-voters; `gc.ttlseconds` ≤ `pd_gc_ttl` = 1 h; **no changefeed, ever**;
  no other SQL role). Every write enters through the operations above. RFC-006's restore
  tooling starts `reapply` only on a fenced store. The store itself reads the feed for it.
- **Reads**: only through `get` and `lookup_login`, by the callers and purposes listed; no
  SQL read by anyone else.
- **Keys**: `KEK_PD` generations, index keys and day expiry keys in the Kenyan HSMs only;
  subject, account payload and bucket keys only wrapped in the store's key table, nested as
  `put_payload` states. **No escrow** for `KEK_PD`, index, expiry, subject, account or
  bucket keys (RFC-005 D-2). **Digest keys are different**: RFC-005 §10 escrows them with
  the log KEKs, because the digest is evidence for the retention period (R48-18). The
  store keeps unwrapped bucket keys of open hours in instance memory until the hour closes.
  Every use reads the key row first (R48-09). The store does not keep subject keys after a
  request.
- **Load** (est., R36-18): `put_payload` ≤ 1,000/s by the caps (about 26/s at planning,
  RFC-006 §14.4); `put` about 50/s; `get` about 2,000/s peak (logins and notices); HSM
  unwraps: one per subject read, one per bucket-hour per instance for payloads.
- **Backups**: RFC-006 runs `backup_pds` to Ceph in R1 and R2 only, daily full plus hourly
  incrementals, no revision history, backup-key encrypted, tagged with every `KEK_PD`
  generation they contain, kept `pd_backup_retention` = 7 days, no key inside.
- **Store events feed topic**: written only by identity's relay. Read only by RFC-006's
  pruner and restore tooling, and by the store's `reapply` reader (ACL by workload
  identity).
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
| `get` for C16 | No overall deadline; per-call deadline 2 s (C07 S4), retried (E7); `temporarily_unavailable` makes the payout run wait for that supplier | Identity, payouts |
| `get` for notifier, reporting, console | Caller's request deadline; on unavailability show identifiers or wait (RFC-005 §14) | Callers |
| `erase` execution (R36-10, R48-11) | **Deadline r + 10 days; page at r + 7 days; forced generation rotation for any e > r + 9 days, one rotation for all erasures before its start; incident at r + 14 days.** For a late request the deadline is r + 23 days − 1 h (est.). **Breach path**: an execution after that cannot meet `erasure_max` even with a forced rotation; identity records it as an `erasure_max` breach, pages compliance and platform on-call, executes at once with a forced rotation, and the breach is reported to compliance with the request. A re-drive after `not_after` is not refused (R48-05) | Identity |
| Row sweep | Each day and after each restore (R48-14) | Store |
| Expiry | d's start + `dispute_window` + 7 days | Store (HSM schedule) |
| Generations | New every 7 days (and at once for a late erasure); each destroyed at `s_g+1` + 7 days, also after a forced rotation; alarm if one older than 14 days exists | Store |
| Backup pruning | 7 days of age; within 24 h of a contained generation's `generation_destroyed`; daily conformance check | RFC-006 |
| Feed retention | ≥ 14 days, delete policy; `max.message.bytes` 1,048,576; events ≤ 512 KiB | RFC-006 (Kafka), identity (relay) |
| Restore | Fenced from before the restore until every event through the outbox head read after fencing is re-applied and the sweep has run | RFC-006 |
| `digest_key` | No deadline; without a cached version the exporter partition waits (batch unacknowledged, alerted) | Ingestion |
| Read grant | `not_after` = signing + `read_grant_ttl` (1 h); operator check cache 60 s | Store as reader |

## Versioning and compatibility

- Additive changes only within a major version: a new optional request field, a new answer
  variant offered only to a caller that lists its capability in `capabilities` (none is
  defined today), a new `GetPurpose`, `CapName`, kind or event type. Consumers ignore
  unknown event types and unknown fields; a caller receiving an unknown `not_kept` reason
  treats it as not kept (nothing kept, counted as `cap`).
- `not_kept(erased)` is new in draft.2. Until RFC-003's erratum records it as its own drop
  reason, ingestion records it as "dropped: cap" by the rule above (R36-09). C11 draft.2
  already gives it as "dropped: erased".
- Draft.3 changed `RecordId` (observation domain, NetFlow v9 index), `erasure_executed`
  (parts, ranges, notes) and `EraseRequest.envelope` before the freeze. Version 1 is the
  baseline for the rules in this section.
- Never changed within a major version: idempotency keys, the `keep_by` − ε rule, "known
  outcomes only", the ordering "answer after event committed", the Kafka key, the meaning of
  `not_found`, the purpose → kinds table (narrowing only by a new major version).
- `put_payload` without `keep_by` (RFC-005 revision 4 form) is not accepted.
- A cap value, a rate limit or the storage allotment is a design parameter (RFC-005 §13,
  RFC-006 §14.4), changed by configuration, not by contract version.

## Scenarios relied on

P3-S71, P3-S75 (payloads); X1-S34, X1-S37, X1-S39, X1-S42, X1-S43, X1-S12 (erasure row),
X1-S13 (support cannot erase; the envelope check relies on it) (erasure, no personal data
elsewhere); X1-S27, X1-S31 (operator reads with a grant); P4-S118, X1-S46 (payout
destination details through identity, C16); all at `requirements-v1.10`.

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
   second are refused; the global caps are never exceeded across instances; with 13
   full-rate exporters on one instance and seven idle instances, lending gives the busy
   instance the unused share within one window (R48-16); in the window after lending, a
   burst on the lenders keeps the total ≤ 1,000 puts and ≤ 4,194,304 B (V60-1); in the next
   second the allowance
   is restored; a payload of 65,537 B is refused; with measured live payload bytes set at
   36 × 10¹² B, a put is `not_kept(cap: storage)`; a repeat of a kept `record_id` consumes
   no token; during an injected membership change an exporter's admissions stay in the
   stated overshoot bound, and an instance refuses an exporter it does not own (R36-08,
   R48-16).
4. A repeated kept `record_id` with a `received_at` in a later hour answers the first
   bucket; the same `record_id` with different bytes in the open hour answers the first
   bucket, writes nothing, makes no HSM call and raises one integrity alert carrying no
   payload byte; in a closed hour, or after the bucket key is destroyed, a repeat answers
   the first bucket with no alert. After the bucket key is destroyed, no stored value from
   the plaintext is readable with a key that is not destroyed, in the live store or in a
   backup (S-G1, R36-17, R48-02).
5. Validation: `received_at` 1 s in the future, 2 h in the past, on a day whose expiry key
   is destroyed, and `keep_by` beyond commit + `pd_put_timeout` each answer `not_kept(late)`
   with an integrity alert and keep nothing (R36-11).
6. At a day key's destruction, `expiry_destroyed(d)` is in the outbox only after its
   attestation entry commits; day d's payloads answer `not_found`; the sweep deletes their
   rows, also rows that a restore brought back; with one HSM cluster declared
   decommissioned, the event carries its decommissioning record (S-M2, R36-07, R36-23,
   R48-14).
7. `put` allowlist: the console putting `kyb_document`, `payout_destination_details` or a
   mutable kind is `refused(kind_not_allowed)`; a put of another kind on an existing item is
   `refused(kind_mismatch)`; overwriting each write-once kind (a
   `payout_destination_details` item above all) is `refused(item_exists)` and alerted; a
   console note gets a store-minted ID, and a retry with the same `client_ref` the same ID;
   a `case_note` with no tags is `refused(invalid_request)`; an `erasure_request_document`
   with no tags is stored, and `tag_note` by identity adds the request's `subject_id`
   (R36-01, R48-07, R48-17).
8. Mutable versions: A (v1) → B (v2) → A (v3) leaves A current; a delayed retry of v1 after
   v2 is `refused(stale)` with `current_version` v2; v2 with other content is
   `refused(version_conflict)`; `get` returns the highest version. With identity's change
   committed and the put not done, `get` gives the previous version until the re-drive
   (R36-02, R48-19).
9. Purpose → kinds: every (caller, purpose, kind) cell outside the table is refused, in
   particular notifier and reporting reading `kyb_document`, a note kind or
   `payout_destination_details`, and a support grant reading an `erasure_request_document`
   or a `legal_order_document`; a compliance grant reads them; a grant whose `read_type`
   differs from the purpose is refused; a reader past its rate is `refused(read_limit)`; the
   breadth alert fires on a scan of many subjects (R36-03, R48-07).
10. Erase racing put of the same subject, and a note put tagged with it, at every
    interleaving: no item of the subject is readable after `store_commit`; every later put
    and `tag_note` is `refused(subject_erased)`. A note tagged [u1, u2] is `not_found` after
    u1's erasure, also under a grant that targets u2, and its ID is in `destroyed.notes`
    (R36-04, R48-01).
11. `get` of an erased subject, an expired payload, a withdrawn payload and a never-existing
    item: byte-identical `not_found` (DT-15, DT-21); `lookup_login` answers `principal` and
    `not_found` with the same latency distribution (two-sample test, p > 0.05), and finds a
    principal during an index recompute (R36-30, R48-15).
12. A console `get` without a read grant, with an expired grant, or outside the grant's
    target is refused; with one, the audit append exists before the answer and holds the
    `grant_id`, not reason text (DT-24, R36-19).
13. Payload erasure by supplier and by exporters and period: payloads in scope unreadable
    at `store_commit` and their rows deleted by the sweep; a payload of the same exporter in
    an hour outside the period stays readable (DT-21); with a period ending after
    execution, a payload received in it after execution is `not_kept(erased)` and one
    received after the period is kept (R36-09); a put in the period between the first and
    the last batch is `not_kept(erased)` (R48-10); after a supplier-scope erasure, a resend
    of a batch received before it is `not_kept(erased)` (R48-21); `erase` repeated with the
    same `request_ref` is a no-op with no new event; a batched erase crashed after its
    first batch resumes and emits each part once (R36-15). Envelope (R48-05): an erase
    whose scope or `request_ref` differs from the signed ones is
    `refused(envelope_invalid)`; an envelope signed by a support operator is refused
    (X1-S13); a re-drive after `not_after` completes; a failed check records nothing, and a
    later call for the same `request_ref` with a valid envelope succeeds (V60-4).
14. Late execution: an erasure committed at r + 12 days forces a new generation at once;
    the HSM destroys h at the new `s_h+1` + 7 days; every copy is unreadable by the
    rotation start + 7 days; two late erasures before one rotation start cause one rotation
    (R36-10, R48-11).
15. A restored store backup taken before an erasure, after its generation's destruction,
    cannot unwrap the key; a payload in a restored backup is unreadable after its day's
    expiry key is destroyed (DT-15, DT-21).
16. Nesting (R48-08): after `X_d` is destroyed, with the current `KEK_PD` available, no
    bucket key of day d unwraps. When a consumer sends `account` (reserved; not tested
    until a consumer does, R48-23): after the account key is deleted, with the bucket key
    present, the item key does not unwrap.
17. Every operation from a workload identity not on its allowlist is refused (§4.4).
18. Event schema: every feed message validates against `StoreEvent` and contains no field
    outside it (no personal data; DT-14 marker scan). An erasure of a supplier with 100
    exporters is published in parts of 512 KiB or less and re-applied (R48-06).

**Metering ingestion (RFC-003)**

19. With the store delayed beyond 500 ms, the batch commits within the acknowledgement bound
    with "dropped: unanswered, withdrawal pending", then sends `withdraw_payload` (with
    `received_at`) until answered and records `withdrawn`; after a takeover the new holder
    re-sends it.
20. Each answer maps to its keep outcome (`kept` with the store's bucket, `dropped: cap`,
    `dropped: not taken in time`, `dropped: erased` per C11); `temporarily_unavailable`,
    every `refused` and a transport error are recorded "dropped: unanswered, withdrawal
    pending" and withdrawn (R36-05); an unknown `not_kept` reason is handled as `cap`; all
    are counted in `drop-count`.
21. A `kept` answer to a re-send followed by the withdrawal of the earlier put: the log's
    later entry (`withdrawn`) is authoritative, and the evidence path accepts `not_found`
    (R36-28).
22. With no digest key version cached and `digest_key` unavailable, the batch with a
    non-conforming payload is neither committed nor acknowledged; other exporters proceed. A
    new registered exporter's first fetch gets version 1; `not_found` is alerted as a
    configuration error (R36-12).
23. `RecordId` from C11: an IPFIX identity carries the observation domain and no index; a
    NetFlow v9 identity carries the observation domain and the record index; two NetFlow v9
    records of one packet get two different `record_id` values.
24. No log row, topic or trace holds a payload byte (DT-14 marker scan).

**Identity for payouts (C16), notifier, reporting, console**

25. Each reads with its own purpose and kinds only; a stub store recording reads shows no
    other purpose used and no content persisted after the request (marker scan).
26. Payout run with the store answering `temporarily_unavailable`: the run waits for that
    supplier and retries; the instruction carries `destination_ref` and version only; with
    the store answering `not_found`, C16 answers `NOT_FOUND{version_gone}` on both forms
    (C07 op 5): payouts escalates to finance at once; identity alerts and asks every
    supplier administrator to enter the destination again (R36-24, E3, D-64-1).

**RFC-006 pruner and restore tooling**

27. Feeding `generation_destroyed(g)`: every backup object tagged with g is deleted within
    24 h; the daily check pages on any left (RFC-006 DT-25).
28. Duplicate delivery of any event changes nothing a second time.
29. Restore (S-M2, R36-06, R36-24, R48-03, R48-04, R48-13):
    - the fence is set before the restore starts and is outside `pds`; no instance serves
      between the restore and the end of `reapply`;
    - `reapply` reads the feed itself from `from_as_of` − `max_offset` through the head
      read after the fence; an erasure committed but not yet relayed when the restore
      starts is re-applied; the restore emits no feed event; `reapply` on a store that is
      not fenced is refused;
    - after the restore: a put to an erased subject is `refused(subject_erased)`; a put in
      an erased period is `not_kept(erased)`; a re-driven erase and a re-driven withdrawal
      get the original answer with no new event;
    - a `supplier` erasure re-applied deletes only the listed key ranges up to
      `through_serial`, not later keys;
    - a change of a mutable item after the restore succeeds after one re-base on
      `current_version`;
    - after a restore that loses a change of `contact` or `login_identifier`, identity
      sends no notice to the old address, refuses a login matched on the superseded
      identifier, and asks for re-entry (V60-5);
    - a restore across an erase that is mid-batch, re-driven after `not_after`, completes
      with no envelope check again and no duplicate part number (V60-2);
    - only the control row fences: while it is set, the rewrap and `reapply` run, and every
      other operation gives `temporarily_unavailable` (V60-3);
    - a restore with the feed withheld does not remove the fence; a backup whose oldest
      generation ends during the restore is not used; the restored keys are rewrapped at
      once.
30. The feed topic's configuration is `cleanup.policy=delete`, retention ≥ 14 days and
    `max.message.bytes` 1,048,576.

## Settled

Orchestrator decisions, binding; this draft specifies each.

| # | Point | Decision |
|---|---|---|
| S-M1 | **Storage cap** (RFC-006 §14.4, RK27 asked for it; RFC-005 RD-1, C12 and RFC-000 4.4 §8 named only count, byte and size caps) | Accepted: a sixth cap, `storage`, at 90% of the 40 TB per-copy allotment (36 × 10¹² B of live payload bytes per copy), on `put_payload` only, never on `put`; answered `not_kept(cap)` with `cap: "storage"`. A backstop since R36-07 |
| S-M2 | **Expiry on restore** (RFC-006 and RFC-000 §8 re-apply expiry "from the feed"; the feed had no expiry event) | A new feed event `expiry_destroyed(day, attestations)`, emitted only after identity commits its attestation entry, like `generation_destroyed`; restore tooling re-applies expiry from the feed (through `reapply`, R36-06), never by date computation |
| S-M3 | **Caps in RFC-006 §14.4** (count caps only) | RFC-005's full set: 10/s and 256 KiB/s per exporter, 1,000/s and 4 MiB/s overall, 64 KiB a payload (plus S-M1), enforced as R36-08 and R48-16 state |
| S-M4 | **Withdrawal trigger label** (RFC-005 §3.7 "not kept: store unavailable" vs RFC-003 §3.3) | RFC-003's label: "dropped: unanswered, withdrawal pending" |
| S-G1 | **Same `record_id`, different bytes** | Answered as the first put; if the bytes differ, the store also raises an integrity alert (identifiers only); compared under the bucket key while it is in memory (R48-02, D-48-3) |
| S-G2 | **`get` purpose vocabulary** | The `GetPurpose` enum with its per-caller allowlist, bound to kinds and grants by R36-03 |
| S-G3 | **`digest_key` by version** | Optional `version` argument accepted |
| Bound | **Erasure bound** (review 48) | min(r + 23, e + 14) days, and e + 7 days after a forced rotation |

## Review 64 errata

[Review 64](../../reviews/64-contracts-C07-C09-C16-review.md) is the joint review of C07, C09 and C16. Version 1.1 applies its C09 errata as that review gives them. They are clarifications. No interface is removed.

| Erratum | Finding | Change in C09 |
|---|---|---|
| E3 | R64-01, D-64-1 | `get` "Payout destination" and test 26: a lost version is mapped by C16 to `NOT_FOUND{version_gone}` on both forms, not to "not found". Payouts escalates to finance at once. Identity asks every supplier administrator to enter the destination again |
| E5 | R64-02, D-64-2 | "Write-once kinds": the C16 version is unique for each command and never reused |
| E7 | R64-04 | "Timeouts", `get` for C16: no overall deadline; per-call deadline 2 s (C07 S4), retried |
| E11 | R64-06 | "Payout destination details": v1 has no retention erase for these items |
| E13 | R64-07 | "Order of commit and put": identity checks authorisation and the recovery hold before the put; an item with no committed version is never read |
| E14 | R64-08, D-64-4 | `get` breadth alert: counted for each (reader, purpose); for `payout_destination`, the bound is the number of suppliers due in the run |
| E15 | R64-09 | "Open issues": the closing paragraph now says that C07 v1 closes R36-31 |
| E17 | R64-10 | "Payout destination details": `destination_ref` and `version` contain no `/` |
| E19 | R64-12 | Restore step 6: identity gets each payout-destination version in force at, or committed after, the AS OF time, and asks for re-entry at once for each `not_found` |

## Fix verification 60 resolution

The orchestrator applies V60-1 … V60-6 as the verification proposes.

| Finding | Change |
|---|---|
| V60-1 lending exceeds the global cap | A lender gives its share out of its next window's allowance. In each window, the sum of allowances is the global cap. Test 3 |
| V60-2 restore across a mid-batch erase | `reapply` applies each part as it reads it and writes the `request_ref` record marked "envelope checked", with the progress. The re-drive resumes from it and numbers new parts after the last published part. Consumers deduplicate parts by (`request_ref`, `part`). Test 29 |
| V60-3 fence by stopped instances | Only the control row outside `pds` fences. While it is set, instances serve only `reapply` and the rewrap. Test 29 |
| V60-4 failed check recorded | The store records only a passing check. It audits a failed check and records nothing. Test 13 |
| V60-5 old content served after a restore | Identity ignores content below its projected version. `lookup_login` returns the matched version, and identity refuses a login on a superseded identifier. Test 29 |
| V60-6 stale comment, missing erratum | `verification_ref` names the `erasure_request_document`. RFC-006 erratum: give the AS OF time to identity before the fence is removed |

## Review 48 resolution

The orchestrator accepts every proposed fix (binding), with the decisions D-48-1 …
D-48-5.

| Finding | Change |
|---|---|
| R48-01 (Blocker) note survives an erasure | `erase` deletes every note tagged with any erased subject (D-48-1, RFC-005 §7.5). `DestroyedKeys.notes` lists them, and `reapply` deletes exactly those. Tests 10, 29 |
| R48-02 plain SHA-256 survives erasure | The S-G1 comparison value is HMAC-SHA-256 under the bucket key. The store compares only while the bucket key is in memory (D-48-3). Test 4 |
| R48-03 `reapply` deletes only | `reapply` also writes subject tombstones, erased ranges, the `request_ref` record and withdrawal tombstones. A re-driven erase or withdrawal gets the original answer and writes no second event. Test 29 |
| R48-04 versions dead-end after a restore | `refused(stale)` gives `current_version`. Identity re-bases. The restore gives its AS OF time to identity. The user enters a lost change again (D-48-5). Tests 8, 29 |
| R48-05 envelope check not implementable | The envelope carries its signed fields and assertions. The store makes sure that they sign this `request_ref` and scope. It checks once, at the first call, and records the result. Re-drives use the record, also after `not_after`. Residual stated. Test 13 |
| R48-06 event too large | Bucket keys as ranges with `through_serial`. `erasure_executed` in parts of 512 KiB or less, written with the batches. Topic `max.message.bytes` stated. Test 18 |
| R48-07 request and order documents | The console puts `erasure_request_document` and `legal_order_document` (store-minted ID, write-once, `client_ref`, zero or more tags). Identity tags them with `tag_note`. Only compliance reads them (D-48-2). AI-48-2. Tests 7, 9 |
| R48-08 nesting of key layers | The nesting is stated: item key in Wrap(bucket, Wrap(account, item)); bucket key in Wrap(`KEK_PD,g`, Wrap(`X_d`, bucket)). A rewrap changes only the outer layer. Test 16 |
| R48-09 cache invalidation | Each `get` and `put_payload` reads the key row in its transaction. Invalidation is hygiene only |
| R48-10 ranges written late | Tombstones and erased ranges are written in the first batch. Test 13 |
| R48-11 forced rotation mechanics | Destruction is scheduled at the new `s_h+1` + 7 days. One rotation covers all erasures before its start. e is the rotation start, so the late deadline is r + 23 days − 1 h. Test 14 |
| R48-12 one outbox partition | All store events go to one partition `"pds"`, with a dense sequence |
| R48-13 fence and tooling trust | The fence is outside `pds` and is set before the restore. `reapply(restore_id, from_as_of, through)`: the store reads the feed itself (D-48-4). Feed ACL changed |
| R48-14 event-driven deletion | A state-based row sweep runs each day and after each restore. Test 6 |
| R48-15 limits at peak | Limits are about 2.5 × peak (est.). Login is limited at the edge for each source, with a store backstop. HSM unwrap budget stated. Lookup also uses the previous index key during a recompute. Test 11 |
| R48-16 wrong imbalance and overshoot claims | Unused global share is lent each second. The overshoot bound includes membership propagation. An instance refuses exporters that it does not own. Test 3 |
| R48-17 caller field, malformed input, onboarding, X1-S13 | The caller comes from the workload identity. `invalid_request` added. The onboarding row is merged into identity's. X1-S13 cited |
| R48-18 reason source, escrow | Reason codes from RFC-005 §7.2. "No escrow" is limited to the store's keys. Digest keys are escrowed (RFC-005 §10) |
| R48-19 commit and put order | Identity commits, then puts. The lease holder re-drives. `get` gives the previous version meanwhile. Test 8 |
| R48-20 erratum lists incomplete | AI-36-1 and the RFC-006 list are extended (Consumer obligations) |
| R48-21 resend after a supplier-scope erasure | Supplier and account scopes also write erased ranges to `store_commit` + 1 h. Test 13 |
| R48-22 decommissioned cluster comes back | It is destroyed before it serves, and the attestation goes to audit. Residual stated |
| R48-23 unused account layer, long ranges | The account layer is marked reserved and is tested only when a consumer sends `account`. Erased ranges are kept until their end + 1 h + `max_offset` |
| R48-24 missing tests | Tests 4, 6, 8, 10, 13, 14, 16, 18 and 29 added or extended |
| C11 F41-15 (joint change) | `RecordId.ref` identity gets `observation_domain`, and `index` for NetFlow v9. The raw ref fields are defined as in C11. Test 23 |

## Review 36 resolution

Every proposed fix accepted (orchestrator, binding), with the decisions D-36-1 … D-36-5.
Review 48 changes some of these resolutions; the "Review 48 resolution" table gives those
changes.

| Finding | Change |
|---|---|
| R36-01 (Blocker) put writes any kind | Per-caller kind allowlist; kind fixed at first put; write-once kinds (`payout_destination_details` versions are new items minted only by identity's C16 command; mutable kinds such as `login_identifier` change only by new versions from identity's own commands, never overwritten); store-minted note IDs; new refusals; test 7 |
| R36-02 put versioning | Versioned by item identifier (RFC-000 §8) with `version` and an `expected_version` precondition; stale retry `refused(stale)`; `version_conflict`; `get` returns the highest version; AI-36-1; test 8 |
| R36-03 purpose not bound to kind or grant | Purpose → kinds table (D-36-1); `read_type` an enum equal to the purpose; grant roles per kind; rate limits for every reader and a breadth alert; test 9 |
| R36-04 put resurrects an erased subject | Subject tombstone on erase; puts to a tombstoned subject or tag refused; put and erase serialise on the key row; test 10 |
| R36-05 ambiguous put outcome | Store answers cap, late or erased only when known not committed; caller treats unavailable, refused and transport error as unanswered and withdraws; re-send only before `keep_by` + ε; tests 1, 20 |
| R36-06 restore not implementable | Restore procedure with fence, outbox head, cutoff and `reapply`; feed retention ≥ 14 days with delete policy; tests 29, 30 |
| R36-07 rows never deleted | Row deletion; live payload bytes defined and measured; storage cap a backstop with the arithmetic; tests 6, 13 |
| R36-08 infeasible caps | Per-instance in-memory token buckets, fixed one-second window, exporter routing, shared global budget, no hot row (D-36-5); test 3 |
| R36-09 later payloads in an erased period | Erased ranges; `not_kept(erased)` (D-36-3); counted as `cap` until RFC-003's erratum; test 13 |
| R36-10 bound only if executed by day 10 | Deadline r + 10 days, page at r + 7; forced generation rotation for e > r + 9 days; incident at r + 14; breach path stated (D-36-4, AI-36-2); test 14 |
| R36-11 unvalidated `received_at`, `keep_by` | Store validates both against its commit timestamp; `not_kept(late)` with an integrity alert; test 5 |
| R36-12 `digest_key` `not_found` undefined | Version 1 created atomically on first request for a registered exporter; `not_found` only for an unregistered exporter or unissued version; test 22 |
| R36-13 RFC-000 §8 left out | RFC-000 §8 erratum (AI-36-1) in "Consumer obligations" |
| R36-14 withdrawal atomicity and day | One transaction with the tombstone (holding `was`) and the outbox row; `received_at` on the request; the event carries day and `was`; test 2 |
| R36-15 batched erase | Key set fixed at the first batch; progress stored; test 13 |
| R36-16 schema lags semantics | `RefusalCheck` completed; `GetRequest` variants; `capabilities` on every request |
| R36-17 S-G1 comparison cost | No HSM call (mechanism replaced by R48-02); test 4 |
| R36-18 HSM per item, no load figures | Bucket key wrapped under `X_d` once per bucket-hour (nesting stated by R48-08); load estimates |
| R36-19 free-text reason | `reason` a reason code; audit records `grant_id`, not reason text; `role`, `read_type` enums; test 12 |
| R36-20 erase without envelope evidence | Envelope check (made implementable by R48-05); test 13 |
| R36-21 test 2 promise | Test 2 checks the outbox commit before the answer, the feed eventually |
| R36-22 TB undefined | TB = 10¹² B; KiB and MiB for the rate caps; arithmetic 1.34 × 10¹³ B |
| R36-23 lost HSM cluster | Events with attestations present plus a decommissioning record; test 6 |
| R36-24 restore rewrap and lost items | Rewrap at once; backup choice; lost items `not_found`; tests 26, 29 |
| R36-25 addressing | Note subject = store-minted note ID; payout details subject = supplier ID (RQ-36-2) |
| R36-26 supplier-scope notice | Notice only for `exporters_period` scopes (D-36-2) |
| R36-27 scope re-applied too broadly | `erasure_executed` carries `destroyed`; `reapply` deletes exactly those; test 29 |
| R36-28 kept then withdrawn | The later of kept and withdrawn in ingestion's log is authoritative; test 21 |
| R36-29 caller clock | Precondition: ingestion host clock within `max_offset` |
| R36-30 login lookup | `lookup_login`, identity only, audited without the identifier, equal latency; test 11 |
| R36-31 C16 conflicts | Carried to the C16 review; closed by C07 v1 S2 and F6 (review 64 E15) |

## Consumer obligations

This contract is frozen. Each RFC below owes these errata. Until each erratum is applied,
this contract records the agreed reading where it differs from the RFC.

- **RFC-000 §8** (AI-36-1 with AI-48-1, R36-13, R48-20): personal-data store row:
  - put idempotent by (subject, item, version), with write-once kinds and per-caller kinds
    (R36-01, R36-02, R48-07); `refused(stale)` with `current_version` (R48-04); `tag_note`;
  - the storage cap (S-M1); `not_kept(erased)` and erased ranges (R36-09, R48-21);
  - the `GetPurpose` table with purpose → kinds, the `case_note` purpose included (S-G2,
    R36-03);
  - the feed: one outbox partition for store events (R48-12); `payload_withdrawn(record_id,
    day, was)`; `expiry_destroyed` (S-M2); `erasure_executed` in parts with `destroyed`
    as ranges and notes (R36-27, R48-06);
  - `received_at` on `withdraw_payload` (R36-14); the erase `envelope` (R48-05);
  - "payloads not kept are counted from ingestion's log and reported hourly to network
    operations; the store's own counts reconcile only" (replacing "counted per exporter and
    minute and reported");
  - the restore-only `reapply(restore_id, from_as_of, through)` and `store_outbox_head` for
    RFC-006 (R36-06, R48-13); `lookup_login`;
  - `RecordId` with the observation domain and the NetFlow v9 index (C11 F41-15).
- **RFC-005**: S-M1, S-M2, S-M4, S-G1 … S-G3; R36-01 … R36-05, R36-07 … R36-12, R36-14 …
  R36-20, R36-22 … R36-25, R36-27, R36-30; AI-36-2 in §3.7 and §13 (a forced generation
  for any erasure committed after r + 9 days, `erasure_incident` 14 days, the bound
  min(r + 23, e + 14) days, e + 7 after a forced rotation, the supplier notice only for
  `exporters_period` scopes); and AI-48-2 in §3.7, §7.5 and C12: the document kinds and
  `tag_note` (R48-07), the erase envelope with its signed fields and assertions, checked once
  for each `request_ref`, only a passing check recorded (R48-05, V60-4); identity ignores
  content below its projected version, and `lookup_login` returns the version (V60-5); cap
  lending out of the lender's next window (V60-1); the comparison under the bucket key (R48-02), the
  nesting of key layers (R48-08), the forced-rotation mechanics (R48-11), deletion of every
  note tagged with an erased subject (unchanged in RFC-005; C09 follows it, R48-01), the
  key row read and sweep (R48-09, R48-14), the decommissioned cluster (R48-22), the rate
  limits and unwrap budget (R48-15), the cap lending (R48-16).
- **RFC-006** (with AI-48-3): S-M1, S-M2, S-M3; R36-06 and R48-03, R48-13 (restore
  procedure: fence outside `pds` set before the restore, `reapply` reading the feed
  itself and writing state, cutoff, feed retention ≥ 14 days); R48-06 (topic
  `max.message.bytes` 1,048,576); R36-07 and R48-14 (the state-based sweep, also after a
  restore, makes the 40 TB allotment a backstop); R36-24 (rewrap at once, backup
  choice); R48-20 (§14.4 wording: the bucket key, not each item key, is wrapped under the
  receipt day's expiry key); R48-04 with V60-6 (the restore's AS OF time given to identity
  before the fence is removed); V60-2 and V60-3 (`reapply` applies each part and writes
  the "envelope checked" record; the fence is only the control row).
- **RFC-003**: S-M4 (already its label); R36-05 (every non-answer withdrawn), R36-09
  (`not_kept(erased)` as a drop reason), R36-12 (`not_found` as a configuration error),
  R36-14 (`received_at` on `withdraw_payload`), R36-28 (the later log entry
  authoritative), R36-29 (clock precondition); S-G3 (the evidence query calls `digest_key`
  with the recorded version); the `RecordId` mapping of C11 (observation domain, NetFlow v9
  index); an unknown `CapName` or `not_kept` reason handled as `cap`.
- **RFC-004**: none beyond C16's mapping of `not_found` (R36-24), already its "not found"
  path.

## Open issues

These issues did not stop the freeze. They go to the requirements owners and
the architecture owners.

- **RQ-36-1**: how long the store keeps a non-user's identity evidence after the request is
  executed or refused. The evidence is now an `erasure_request_document` (R48-07).
- **RQ-36-2**: whether a sole trader's payout destination details are erased on a covering
  request, or kept while any payout under the version may be reconciled.
- **RQ-36-3**: whether a user-of-supplier request covers payloads received after execution.
  This contract covers payloads received up to `store_commit` + 1 h (RFC-005's reading,
  R48-21). Only an `exporters_period` scope stops later payloads (D-36-3).
- **RQ-48-1**: POL-19 does not say what happens to a record that holds the personal data of
  two persons when one person asks for erasure. This contract erases the full record
  (D-48-1).
- **AI-36-1, AI-36-2, AI-48-1, AI-48-2, AI-48-3**: under "Consumer obligations".

R36-31 is closed by C07 v1: S2 (refused during the hold, as X1-S46) and F6 (a lot paid again in a later run goes to that run's destination, as P4-S118 row 3); the errata owed by RFC-000 and RFC-004 are listed in C07.
