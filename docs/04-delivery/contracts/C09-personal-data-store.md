# C09. Personal-data store

| | |
|---|---|
| Contract ID | C09 |
| Version | 1.0-draft |
| Status | **Draft**, for contract review. The orchestrator settled every mismatch and gap (S-M1 … S-M4, S-G1 … S-G3, "Settled" below); RFC-005 and RFC-006 take them as errata after freeze ("Consumer obligations") |
| Provider | Identity and access (RFC-005 revision 5, §3.7, §10, C12; the key service for `digest_key`) |
| Consumers | Metering ingestion (RFC-003 revision 5 + erratum 5.1: `put_payload`, `withdraw_payload`, `digest_key`); the evidence query (RFC-003: `digest_key`); identity and access itself (`put`, `get`, `erase`; `get` purpose "payout destination" on behalf of payouts, RFC-004 revision 5 via C16); notifier (`get`, contact details at send time); operator console (`put` of case notes, `get` with a read grant); reporting (`get`, display names at view time); RFC-006 revision 6 backup pruner and restore tooling (store events feed) |
| Transport | Store operations and `digest_key`: synchronous query and command (gRPC over mTLS, caller allowlist by workload identity, RFC-005 §4.4). Store events feed: Kafka event, published from identity's transactional outbox (RFC-000 §8 personal-data store row, A1) |
| Pinned to | `requirements-v1.10`; RFC-000 revision 4.4 (§8 personal-data store row, A11, §5.3); RFC-005 revision 5 (§3.7, §4.4, §7.6, §10, §13, §14, §15 DT-15, DT-21, DT-24, DT-30, C12, C16); RFC-003 revision 5 with erratum 5.1 (§3.3, §3.4, §7, §8); RFC-004 revision 5 with erratum 5.1 (§B7.1, §B8, contract table); RFC-006 revision 6 (§3.2, §14.4, DT-25, RK27) |

## Purpose

RFC-000 A11: personal data never enters a log. This store is the only place personal data
lives: users', operators' and contacts' names and contact details, login identifiers,
display names, KYB documents, case notes, legal-order documents, payout-destination
details, and the payloads of non-conforming flow-record data sets. Every item is encrypted
per data subject (or, for a payload, under layered account, bucket and day-expiry keys)
so that erasure is key destruction (crypto-shredding) and no log is ever rewritten. The
operations are kept apart, each with its own callers: **put**, **put_payload**,
**withdraw_payload**, **get**, **erase**, **expire**; plus the **store events feed** that
lets backups and restores honour every destruction, and **digest_key**, which makes the
digest ingestion keeps of a non-conforming payload a keyed one.

Erasure-request intake (`record_erasure_request`, pass-on, compliance channels,
`open_requests`) is part of RFC-005 C12 but is not in this contract: it is identity's own
command surface and has its own contract. `erase` here is only the store operation identity
calls once a request is executing.

## Schema

Units: sizes in **bytes** (KB = 1,024 bytes as RFC-005 states caps in KB), rates per
second, durations in **ms** unless named in days or hours, timestamps as **epoch
microseconds UTC** (`bigint`, a decimal string in JSON) unless named an hour or a day.
Every identifier is pseudonymous (A11). Field names are the wire names; protobuf messages
mirror these types one to one.

```ts
// ---------- common ----------
type EpochMicros = bigint;            // UTC, microseconds since 1970-01-01T00:00Z
type UtcHour = string;                // "2026-10-12T14:00Z": start of a UTC hour
type UtcDay = string;                 // "2026-10-12": a UTC receipt day
type ExporterId = string;             // pseudonymous exporter ID (the session's)
type SupplierId = string;             // exporter's owner as its credential names it, or "share"
type AccountId = string;
type SubjectId = string;              // principal_id or contact/subject_id; never a name
type ItemId = string;                 // item identifier within a subject
type RequestRef = string;             // erasure request identifier (identity)
type Generation = number;             // KEK_PD generation g (weekly)

type Unavailable = { kind: "temporarily_unavailable" };   // retry; nothing implied
type Refused = { kind: "refused"; check: "caller_not_allowed" | "purpose_not_allowed"
                 | "read_grant_invalid" | "target_out_of_grant" | "read_limit" };

// ---------- record identity of a payload (RFC-003 §3.3 step 2) ----------
type RecordId = {
  exporter: ExporterId;
  ref:
    | { kind: "identity"; exporter_epoch: string; sequence: string }   // §3.2 record identity
    | { kind: "raw"; partition: string; log_seq: string; index: number };
  digest: { key_version: number; hmac_sha256: string };   // hex, 64 chars; keyed digest of the payload bytes
};

type PayloadBucket = { exporter: ExporterId; hour: UtcHour };   // UTC hour of received_at

// ---------- put (subject items) ----------
type PutRequest = {
  subject: SubjectId;
  item: ItemId;
  kind: "name" | "contact" | "login_identifier" | "display_name" | "kyb_document"
      | "case_note" | "legal_order_document" | "erasure_request_document"
      | "payout_destination_details";
  tags?: SubjectId[];                 // case notes: the subjects they concern
  content: Uint8Array;                // plaintext over mTLS; sealed by the store
};
type PutAnswer = { kind: "stored"; commit: EpochMicros } | Unavailable | Refused;

// ---------- put_payload ----------
type PutPayloadRequest = {
  record_id: RecordId;
  exporter: ExporterId;               // = record_id.exporter
  supplier: SupplierId;
  account?: AccountId;                // RFC-003 never sends it (rejected records are unattributed)
  received_at: EpochMicros;           // edge receipt of the batch
  keep_by: EpochMicros;               // latest time the payload may be kept
  payload: Uint8Array;                // ≤ 65,536 bytes to be keepable
};
type PutPayloadAnswer =
  | { kind: "kept"; bucket: PayloadBucket }          // durable in two regions
  | { kind: "not_kept"; reason: "cap"; cap: CapName } // nothing kept anywhere
  | { kind: "not_kept"; reason: "late" }             // nothing kept; also any tombstoned record_id
  | Unavailable | Refused;
type CapName =
  | "per_exporter_count"   // payload_put_limit      10 /s per exporter
  | "per_exporter_bytes"   // payload_bytes_limit    262,144 B/s per exporter
  | "global_count"         // payload_put_global     1,000 /s
  | "global_bytes"         // payload_bytes_global   4,194,304 B/s
  | "payload_size"         // payload_max_bytes      65,536 B per payload
  | "storage";             // 90% of the 40 TB per-copy allotment = 36 TB live payload bytes per copy (S-M1)

// ---------- withdraw_payload ----------
type WithdrawPayloadRequest = { record_id: RecordId };
type WithdrawPayloadAnswer =
  | { kind: "withdrawn"; was: "kept" | "absent" }    // only after payload_withdrawn is committed
  | Unavailable | Refused;

// ---------- get ----------
type GetPurpose =                     // S-G2: closed vocabulary, allowlisted per caller
  | "login"                           // identity
  | "administrator_command"           // identity
  | "payout_destination"              // identity, for payouts via C16
  | "notice_delivery"                 // notifier, at send time
  | "statement_display"               // reporting, at view time
  | "support_view"                    // console, read grant
  | "case_note"                       // console, read grant
  | "flow_record_dispute";            // console, read grant (RFC-003 §3.3 "Reading one")
type ReadGrant = {                    // RFC-005 §7.6, C4
  grant_id: string; operator: string; role: string; read_type: string;
  target: { kind: "subject"; subject: SubjectId } | { kind: "payload"; record_id: RecordId };
  reason: string; not_after: EpochMicros;
  webauthn: { authenticator_data: string; client_data_json: string; signature: string; credential_id: string };
};
type GetRequest =
  | { target: { kind: "item"; subject: SubjectId; item: ItemId }; purpose: GetPurpose; read_grant?: ReadGrant }
  | { target: { kind: "payload"; record_id: RecordId }; purpose: "flow_record_dispute"; read_grant: ReadGrant };
type GetAnswer =
  | { kind: "found"; content: Uint8Array }           // hold in memory for the request only
  | { kind: "not_found" }                            // never existed, erased, expired, withdrawn: indistinguishable
  | Unavailable | Refused;

// ---------- erase ----------
type ErasureScope = {
  subjects: SubjectId[];                             // subject keys, items, blind-index rows, tagged case notes
  account_payload_keys: AccountId[];                 // a user of account a -> a's account payload key
  bucket_keys:                                       // payload bucket keys to destroy
    | { kind: "none" }
    | { kind: "supplier"; supplier: SupplierId }     // every bucket key of the supplier's exporters
    | { kind: "exporters_period"; exporters: ExporterId[]; from: EpochMicros; to: EpochMicros }; // every hour meeting [from, to)
};
type EraseRequest = { request_ref: RequestRef; scope: ErasureScope };
type EraseAnswer =
  | { kind: "erased"; store_commit: EpochMicros; bucket_hours_destroyed: { exporter: ExporterId; hours: UtcHour[] }[] }
  | Unavailable | Refused;

// ---------- digest_key (key service) ----------
type DigestKeyRequest = { exporter: ExporterId; version?: number };   // version: optional, S-G3
type DigestKeyAnswer =
  | { kind: "key"; version: number; wrapped_key: Uint8Array }  // HMAC-SHA-256, 256-bit, wrapped to the caller's workload identity
  | { kind: "not_found" }
  | Unavailable | Refused;

// ---------- store events feed (Kafka) ----------
type StoreEvent = {
  event_id: { partition: string; sequence: string };  // identity outbox position (RFC-000 §4.4)
  store: "pds";                                       // Kafka key
  committed_at: EpochMicros;                          // identity's commit of the event
} & (
  | { type: "payload_withdrawn"; record_id: RecordId }
  | { type: "expiry_destroyed"; day: UtcDay;                           // S-M2
      attestations: { hsm_cluster: string; signed_attestation: string }[] }
  | { type: "generation_destroyed"; generation: Generation;
      attestations: { hsm_cluster: string; signed_attestation: string }[] }
  | { type: "erasure_executed"; request_ref: RequestRef; scope: ErasureScope; store_commit: EpochMicros }
);
```

The store's tables are identity's private schema (`pds` database, RFC-005 §3.7); no other
service has a SQL role on it, so no DDL is part of this contract.

## Semantics per operation

### put(subject, item)

- **Callers**: identity (users, contacts, legal-order and erasure-request documents, payout
  destination details keyed by (`destination_ref`, version), C16); onboarding through
  identity (KYB documents); console (case notes).
- **Effect**: seals `content` under the subject's key (created on first put), AES-256-GCM,
  subject and item identifiers as associated data.
- **Answer** `stored` only once durable in two regions.
- **Errors**: `temporarily_unavailable` (nothing implied; retry with the same arguments);
  `refused(caller_not_allowed)`.

### put_payload(record_id, exporter, supplier, account?, received_at, keep_by, payload)

- **Caller**: metering ingestion only; only for non-conforming data sets (rejected
  `no template` or `unparseable`).
- **Preconditions (caller)**: the keyed digest in `record_id` is computed with a cached
  `digest_key` version; `keep_by` = issue time on the caller's clock + `pd_put_timeout` − ε
  (RFC-003: 500 ms − 100 ms = issue + 400 ms).
- **Outcomes** (exactly one):
  - `kept(bucket)`: the item is committed, durable in two regions, in bucket
    (exporter, UTC hour of `received_at`), its key wrapped under the account payload key (if
    `account`), the bucket key, and the expiry key of `received_at`'s UTC day. For a
    `record_id` already kept, the answer names **the first put's bucket**, whatever this
    call's `received_at`; nothing is written.
  - `not_kept(cap)`: keeping it would exceed a cap (count or bytes, per exporter or
    overall; the payload larger than 65,536 bytes; or the storage cap, 36 TB of live payload bytes per copy, S-M1). Nothing is kept
    anywhere. Caps are on payloads **kept**: a repeat of a kept `record_id`, a refusal and a
    late answer consume none.
  - `not_kept(late)`: the store's transaction reads `cluster_logical_timestamp()` and
    commits only if it is ≤ `keep_by` − ε (ε = `max_offset`, 100 ms); otherwise it aborts,
    is not retried past `keep_by`, and nothing is kept. **No item is ever kept by a commit
    after `keep_by` − ε.** A `record_id` carrying a withdrawal tombstone always answers
    `not_kept(late)`.
- A `record_id` answered `not_kept(cap)` or `not_kept(late)` without a tombstone is not
  remembered: a later put of it (a resend) is decided afresh and may be kept.
- **Errors**: `temporarily_unavailable`; `refused(caller_not_allowed)`. A transport error
  or no answer by `keep_by` + ε is **unanswered**: the caller must withdraw (next).

### withdraw_payload(record_id)

- **Caller**: metering ingestion only, for every put without an answer by `keep_by` + ε
  (recorded "dropped: unanswered, withdrawal pending"), retried with backoff until answered,
  and re-driven by a new lease holder from its log.
- **Effect**: deletes the item if a put committed it; writes a **withdrawal tombstone** for
  `record_id`, kept until the receipt day's expiry; commits `payload_withdrawn(record_id)`
  to identity's outbox.
- **Answer** `withdrawn(was kept | was absent)` **only after** `payload_withdrawn` is
  committed. A crash before that leaves the call unanswered; the retry re-drives it.
- After the answer, the payload is kept nowhere (P3-S75); before it, at most in this store,
  under its day's expiry key and every covering erasure.
- **Errors**: `temporarily_unavailable`; `refused(caller_not_allowed)`.

### get(target, purpose[, read grant])

- **Callers and purposes**: identity (`login`, `administrator_command`,
  `payout_destination`); notifier (`notice_delivery`); reporting (`statement_display`);
  console only with a read grant (`support_view`, `case_note`, `flow_record_dispute`). A
  purpose not allowed for the caller is `refused(purpose_not_allowed)`.
- **Read grant** (console): verified by the C4 rules and the operator check (C15); the
  target must be the grant's one target; `operator_read_limit` enforced. The store
  **appends the read to audit before answering** (reader, purpose, subject or `record_id`,
  grant; never the data).
- Every other `get` is appended to audit likewise (reader, purpose, subject).
- **Answer** `found(content)` or `not_found`: never existed, erased, expired and withdrawn
  are byte-identical answers.
- **Reader obligation**: content held in memory for the request only; never written to a
  table, topic, cache outliving the request, log or trace (A11).
- **Payout destination** (RFC-004 via C16): identity gets the item keyed by
  (`destination_ref`, version) with purpose `payout_destination`; payouts never call the
  store and never log the details.

### erase(request_ref, scope)

- **Caller**: identity only, between its `erasure_executing` and `erasure_executed`
  entries, on a compliance envelope citing a recorded request for the same subject (and, for
  a non-user request, carrying its verification). The store refuses any other caller; it
  does not itself check the request (identity does, in its own state).
- **Effect**, one transaction: delete the subjects' wrapped keys, their items, blind-index
  rows and tagged case notes; delete the named account payload keys (a new key serves later
  payloads) and bucket keys (a bucket still filling gets a new key version); append the
  erasure to audit; commit `erasure_executed(request_ref, scope, store_commit)` to
  identity's outbox. Batched across transactions if the bucket set is larger than one
  transaction allows, `erased` answered after the last.
- **Answer** `erased(store_commit, bucket_hours_destroyed)`; from `store_commit` every `get`
  in scope is `not_found`. Every copy unreadable within 24 days of the request's record,
  inside `erasure_max` (30 days), by generation destruction (RFC-005 §3.7 bound).
- `bucket_hours_destroyed` lets identity tell the supplier's administrators the exporter and
  hours erased, never by whom.

### expire (store-internal, by schedule)

- No caller. The expiry is fixed at `put_payload`: the expiry key `X_d` of the UTC receipt
  day d, held only in the Kenyan HSMs, never escrowed or backed up, is destroyed by HSM
  quorum at d's start + `dispute_window` (30 days) + 7 days, attested. From then the
  payload is unrecoverable in every copy, backups and escrow included: at most
  `dispute_window` + 7 days, at least `dispute_window` + 6 days, after receipt.
- Withdrawal tombstones of day d are removed at the same time.
- Identity commits the attestation entry that publishes `expiry_destroyed(d, attestations)`
  on the store events feed; day d counts as expired only once that entry is committed (as
  for `generation_destroyed`; S-M2).

### Store events feed

- `payload_withdrawn(record_id)`: committed before `withdraw_payload` answers.
- `expiry_destroyed(day, attestations)`: committed with the expiry key's attestation entry;
  the day counts as expired only once it is committed (S-M2).
- `generation_destroyed(g, attestations)`: committed with the attestation entry; generation
  g counts as destroyed only once it is committed.
- `erasure_executed(request_ref, scope, store_commit)`: committed in `erase`'s transaction.
- Identifiers only, never personal data. Consumers: RFC-006's backup pruner (deletes within
  24 h every backup object tagged with a destroyed generation; also deletes at 7 days of
  age regardless) and restore tooling (re-applies every erasure, expiry and withdrawal **from
  the feed** since the backup, before the restored store serves; for `expiry_destroyed(d)`
  it deletes the items and tombstones of receipt day d; no expiry is derived by date
  computation; S-M2).

### digest_key(exporter[, version])

- **Callers**: metering ingestion's and the evidence query's workload identities only;
  every release audited.
- **Answer**: the current version (or the version asked, S-G3) and the HMAC-SHA-256 key,
  wrapped to the caller's workload identity. Versions rotate yearly; every version is
  served for the retention period (7 years).
- **Caller obligations**: cache in memory only; fetch for every exporter of a slot at lease
  acquisition; keep the cached version through a rotation until the new one is fetched;
  with no version cached and the fetch failing, neither commit nor acknowledge the batch
  holding the non-conforming payload (RFC-003 §3.3 step 1).

## Delivery and ordering

| Operation | Delivery | Ordering |
|---|---|---|
| `put`, `put_payload`, `withdraw_payload`, `erase` | Caller retries until answered (at-least-once request); **exactly-once effect** by the idempotency keys below | None across calls. A `withdraw_payload` committed before a retried `put_payload` of the same `record_id` makes the put answer `not_kept(late)`; a put committed before the withdrawal is deleted by it |
| `get`, `digest_key` | Request-reply; no effect but the audit append | — |
| Store events feed | At-least-once from identity's transactional outbox (an event exists iff its act committed); consumers deduplicate by `event_id` | Kafka key `store` = `"pds"`: one partition, total order in commit order |

## Idempotency

| Operation | Key | Duplicate | Same key, different content |
|---|---|---|---|
| `put` | (subject, item, content digest) | Answered `stored`, no new write | A different content under the same (subject, item) is a new version of the item (the key includes the digest) |
| `put_payload` | `record_id` | Kept: `kept(first bucket)`. Tombstoned: `not_kept(late)`. Not kept and not tombstoned: decided afresh | `record_id` contains the keyed digest, so a different payload has a different `record_id`. Same `record_id` with different bytes (a defect, since `record_id` contains the keyed digest) is answered as the first put, nothing written, **and the store raises an integrity alert** (identifiers only: `record_id`, exporter, caller; never bytes) (S-G1). The store compares against the kept item inside its own boundary |
| `withdraw_payload` | `record_id` | `withdrawn` with the same `was` as the first answer; the event is not committed twice | — |
| `erase` | `request_ref` | `erased` with the first `store_commit`; deleting absent rows is a no-op; one `erasure_executed` per `request_ref` | A different scope under a committed `request_ref` is `refused`; identity never re-scopes a request |
| Store events | `event_id` | Consumers apply once | — |

## Ownership

- **Writes**: identity and access only (the `pds` database, its own zone configuration, 5
  voters, no non-voters; `gc.ttlseconds` ≤ `pd_gc_ttl` = 1 h; **no changefeed, ever**;
  no other SQL role). Every write enters through the operations above.
- **Reads**: only through `get`, by the callers listed; no SQL read by anyone else.
- **Keys**: `KEK_PD` generations, index keys and day expiry keys in the Kenyan HSMs only;
  subject, account payload and bucket keys only wrapped in the store's key table; nothing
  escrowed (RFC-005 D-2).
- **Backups**: RFC-006 runs `backup_pds` to Ceph in R1 and R2 only, daily full plus hourly
  incrementals, no revision history, backup-key encrypted, tagged with every `KEK_PD`
  generation they contain, kept `pd_backup_retention` = 7 days, no key inside.
- **Store events feed topic**: written only by identity's relay; read only by RFC-006's
  pruner and restore tooling (ACL by workload identity).
- **Counts of payloads not kept**: the authoritative count and report to network
  operations is ingestion's, derived from its `ingest_log` (`drop-alert`, `drop-count`);
  the store's own per-exporter-and-minute counts of cap, late and withdrawn go to
  monitoring for reconciliation only.

## Timeouts and deadlines

| Item | Value | Owner |
|---|---|---|
| `put_payload` keep deadline | Commit only at ≤ `keep_by` − ε; ε = `max_offset` = 100 ms | Store |
| `put_payload` caller wait | `keep_by` + ε = issue + `pd_put_timeout` (500 ms, est.); then the batch commits with the put "unanswered, withdrawal pending" | Ingestion |
| `withdraw_payload` | Retried with backoff until answered; alert at 10 min pending (est.) | Ingestion |
| `get` for C16 | No deadline; `temporarily_unavailable` makes the payout run wait for that supplier | Identity, payouts |
| `get` for notifier, reporting, console | Caller's request deadline; on unavailability show identifiers or wait (RFC-005 §14) | Callers |
| `erase` | No call deadline; execution target 10 days, alert at 7, incident at 20 days of the request; every copy unreadable ≤ 24 days of the request | Identity |
| Expiry | d's start + `dispute_window` + 7 days | Store (HSM schedule) |
| Generations | New every 7 days; each destroyed at its usage end (`s_g+1` + 7 days); alarm if one older than 14 days exists | Store |
| Backup pruning | 7 days of age; within 24 h of a contained generation's `generation_destroyed`; daily conformance check | RFC-006 |
| `digest_key` | No deadline; without a cached version the exporter partition waits (batch unacknowledged, alerted) | Ingestion |
| Read grant | `not_after` = signing + `read_grant_ttl` (1 h); operator check cache 60 s | Store as reader |

## Versioning and compatibility

- Additive changes only within a major version: a new optional request field, a new answer
  variant behind a capability the caller declares, a new `GetPurpose` or `CapName`, a new
  event type. Consumers ignore unknown event types and unknown fields; a caller receiving an
  unknown `not_kept` reason treats it as not kept (nothing kept, counted as `cap`).
- Never changed within a major version: idempotency keys, the `keep_by` − ε rule, the
  ordering "answer after event committed", the Kafka key, the meaning of `not_found`.
- `put_payload` without `keep_by` (RFC-005 revision 4 form) is not accepted: a caller must
  send `keep_by`.
- A cap value or the storage allotment is a design parameter (RFC-005 §13, RFC-006 §14.4),
  changed by configuration, not by contract version.

## Scenarios relied on

P3-S71, P3-S75 (payloads); X1-S34, X1-S37, X1-S39, X1-S42, X1-S43, X1-S12 (erasure row)
(erasure, no personal data elsewhere); X1-S27, X1-S31 (operator reads with a grant); P4-S118,
X1-S46 (payout destination details read through identity, C16); all at `requirements-v1.10`.

## Conformance tests

**Provider (identity and access)**

1. `put_payload` whose transaction is held past `keep_by` − ε answers `not_kept(late)` and
   leaves no item (RFC-005 DT-30).
2. A put committed with its answer dropped, then `withdraw_payload`: `withdrawn(was kept)`,
   `payload_withdrawn` present on the feed before the answer reached the caller; a retried
   put answers `not_kept(late)`; a withdrawal of a never-put `record_id` answers
   `withdrawn(was absent)`; a repeat withdrawal answers the same and adds no event (DT-30).
3. Caps: the 11th payload in one second from one exporter, the payload pushing the
   exporter past 262,144 B/s, the 1,001st overall, a payload of 65,537 bytes, and a put at
   the storage threshold of 36 TB per copy (S-M1) each answer `not_kept(cap)` with the cap named and keep
   nothing; a repeat of a kept `record_id` consumes no allowance.
4. A repeated kept `record_id` with a `received_at` in a later hour answers the first
   bucket; the same `record_id` with different bytes answers the first bucket, writes
   nothing and raises one integrity alert carrying no payload byte (S-G1).
4a. At a day key's scheduled destruction, `expiry_destroyed(d)` is on the feed only after
   its attestation entry commits, and day d's payloads answer `not_found` (S-M2).
4b. Each `GetPurpose` outside a caller's allowlist is `refused(purpose_not_allowed)`;
   `digest_key(exporter, version)` returns that version, without `version` the current
   one (S-G2, S-G3).
5. `get` of an erased subject, an expired payload, a withdrawn payload and a never-existing
   item: byte-identical `not_found` (DT-15, DT-21).
6. A console `get` without a read grant, with an expired grant, or outside the grant's
   target is refused; with one, the audit append exists before the answer (DT-24).
7. Payload erasure by account, by supplier and by exporters and period: payloads in scope
   unreadable at `store_commit`; a payload of the same exporter in an hour outside the
   period stays readable (DT-21); `erase` repeated with the same `request_ref` is a no-op
   with one event.
8. A restored store backup taken before an erasure, after its generation's destruction,
   cannot unwrap the key; a payload in a restored backup is unreadable after its day's
   expiry key is destroyed (DT-15, DT-21).
9. Every operation from a workload identity not on its allowlist is refused (§4.4).
10. Event schema: every feed message validates against `StoreEvent` and contains no field
    outside it (no personal data; DT-14 marker scan).

**Metering ingestion (RFC-003)**

11. With the store delayed beyond 500 ms, the batch commits within the acknowledgement bound
    with "dropped: unanswered, withdrawal pending", then sends `withdraw_payload` until
    answered and records `withdrawn`; after a takeover the new holder re-sends it.
12. Each answer maps to its keep outcome (`kept` with the store's bucket, `dropped: cap`,
    `dropped: not taken in time`) and is counted in `drop-count`; an unknown `not_kept`
    reason is handled as `cap`.
13. With no digest key version cached and `digest_key` failing, the batch with a
    non-conforming payload is neither committed nor acknowledged; other exporters proceed.
14. No log row, topic or trace holds a payload byte (DT-14 marker scan).

**Identity for payouts (C16), notifier, reporting, console**

15. Each reads with its own purpose only; a stub store recording reads shows no other
    purpose used and no content persisted after the request (marker scan).
16. Payout run with the store answering `temporarily_unavailable`: the run waits for that
    supplier and retries; the instruction carries `destination_ref` and version only.

**RFC-006 pruner and restore tooling**

17. Feeding `generation_destroyed(g)`: every backup object tagged with g is deleted within
    24 h; the daily check pages on any left (RFC-006 DT-25).
18. Duplicate delivery of any event changes nothing a second time.
19. A restore re-applies every `erasure_executed`, `expiry_destroyed` and
    `payload_withdrawn` since the backup, from the feed alone, before the store serves; a
    restore with the feed withheld does not serve (S-M2).

## Settled

Orchestrator decisions, binding; this draft specifies each.

| # | Point | Decision |
|---|---|---|
| S-M1 | **Storage cap** (RFC-006 §14.4, RK27 asked for it; RFC-005 RD-1, C12 and RFC-000 4.4 §8 named only count, byte and size caps) | Accepted: a sixth cap, `storage`, at 90% of the 40 TB per-copy allotment (36 TB of live payload bytes per copy), on `put_payload` only, never on `put`; answered `not_kept(cap)` with `cap: "storage"` |
| S-M2 | **Expiry on restore** (RFC-006 and RFC-000 §8 re-apply expiry "from the feed"; the feed had no expiry event) | A new feed event `expiry_destroyed(day, attestations)`, emitted only after identity commits its attestation entry, like `generation_destroyed`; restore tooling re-applies expiry from the feed, never by date computation |
| S-M3 | **Caps in RFC-006 §14.4** (count caps only) | RFC-005's full set: 10/s and 256 KB/s per exporter, 1,000/s and 4 MB/s overall, 64 KB a payload (plus S-M1) |
| S-M4 | **Withdrawal trigger label** (RFC-005 §3.7 "not kept: store unavailable" vs RFC-003 §3.3) | RFC-003's label: "dropped: unanswered, withdrawal pending" |
| S-G1 | **Same `record_id`, different bytes** | Answered as the first put; if the bytes differ, the store also raises an integrity alert (identifiers only) |
| S-G2 | **`get` purpose vocabulary** | The `GetPurpose` enum with its per-caller allowlist, as specified |
| S-G3 | **`digest_key` by version** | Optional `version` argument accepted |

## Consumer obligations

- **RFC-005** takes S-M1, S-M2 (emitting `expiry_destroyed`), S-M4, S-G1, S-G2 and S-G3 as
  errata after this contract is frozen.
- **RFC-006** takes S-M1 (the cap answered by RFC-005, stated in §14.4 and RK27), S-M2
  (restore tooling re-applies expiry from `expiry_destroyed`; the pruner ignores it or
  records it) and S-M3 (§14.4's cap list) as errata after freeze.
- **RFC-003** already uses S-M4's label; it must call `digest_key` with the recorded
  `version` in the evidence query (S-G3) and treat an unknown `CapName` as `cap`.
- Until the errata land, this contract governs where it differs from those RFCs.

Outside this contract, noticed while reading (for C16, not blocking C09): RFC-000 rev. 4.4
C4-5 adopts "a held administrator's destination change is held, then applied", but
`requirements-v1.10` X1-S46 at 11:00 says "it is refused … the destination is unchanged,
and the attempt is recorded"; and RFC-004 §B7.1 "a re-instruction reuses" the destination
version while P4-S118's third example sends the next run's re-instruction to the new
destination.
