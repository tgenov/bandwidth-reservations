# C11. Metering ingress: flow-record ingestion, metering hand-off, attribution keys

| | |
|---|---|
| Contract ID | **C11** (`metering-ingress`) |
| Version | 1.0.0-draft.1 |
| Status | **Draft**, for contract review. Mismatches M-1 and M-2 are settled by the orchestrator (see [Settled](#settled)); RFC-003 and RFC-006 errata follow |
| Provider (owner) | RFC-003 rating and metering, at revision 5 with erratum 5.1: **metering ingestion** (part I and part II producer), **attribution stage A** (part II consumer; part III consumer; part IV producer), **attribution stage B** (part IV consumer) |
| Producers into it | **Exporters** (external: suppliers' exporters and Share's own, including the designated probe exporters), part I. **Provisioning** (external, Problem 5, out of scope), part III |
| Consumers | Exporters (acknowledgements, part I); attribution stage A (parts II and III); attribution stage B (part IV) |
| Transport | Part I: **HTTP**, an HTTP/2 gRPC bidirectional stream over mutually authenticated TLS to the ingestion edge of either serving region. Part II: **Kafka event**, relayed from the self-outboxed `ingest_log` with the owner's direct publish as the fast path. Part III: **Kafka event**, published by provisioning. Part IV: **Kafka event**, from stage A's transactional outbox |
| Depends on | **C08** (exporter credentials: the exporter ID and owner a session's certificate names, and its revocation); RFC-005 C12 (`digest_key`, `put_payload`, `withdraw_payload`; consumed by ingestion, not part of this wire contract); RFC-006 substrate conventions (self-outboxed log, per-destination resolved markers, owner runtime) |
| Pinned to | `requirements-v1.10`; RFC-000 revision 4.4 (§2 metering components, §4.4 record identity, §8 rows "Flow-record ingestion protocol", "Metering hand-off", "Attribution keys from provisioning"); RFC-003 revision 5 + erratum 5.1 (§3.1 to §3.7, §4.1 to §4.3, §7, §8); RFC-005 revision 5 (§2.1 exporter row, §8.4, §10, C12) |

## Purpose

Every byte Share bills on usage enters through this contract. It fixes three seams and
one internal hop:

- **Part I, the flow-record ingestion protocol** (RFC-000 §8 row 1; RFC-003 §3.1): what an
  exporter sends, what ingestion acknowledges, and when. Every received record gets exactly
  one durable outcome (accepted, duplicate, rejected with reason) before its batch is
  acknowledged, and an acknowledged batch never needs resending.
- **Part II, the metering hand-off** (RFC-000 §8 row 2; RFC-003 §3.4, §7): accepted record
  batches, corrections and superseding versions, per exporter in order, from ingestion to
  attribution stage A, with per-destination resolved markers.
- **Part III, attribution keys from provisioning** (RFC-000 §8 row 3; RFC-003 §4.1),
  including the **observation point → link mapping** (AI3-8): the binding feed stage A
  binds records against.
- **Part IV, attributed part batches, stage A → stage B** (RFC-003 §4.2 step 5, §4.3; RFC-003
  §7 "Attributed parts", internal). Not an RFC-000 §8 row; specified here because the
  brief names the stage A → stage B hop as part of the hand-off and both stages build
  against it independently. See [Scope note](#scope-note).

Out of scope: the drop alert and drop report (RFC-003 §7, alert feed), the stage A
watermark heartbeat to rating (RFC-003 §4.2), the quarantine and breach report feeds, the
evidence query, and the personal-data store calls (RFC-005 C12).

## Units and representations

| Quantity | Unit and representation |
|---|---|
| Flow times | Integer **milliseconds** since the Unix epoch (UTC), field names ending `Ms`. Relative IPFIX/NetFlow times are made absolute by ingestion from the message's system init time (RFC-003 §3.2) |
| Export time | Integer **seconds** since the epoch, as in the IPFIX/NetFlow header (`exportTimeS`) |
| Commit timestamps | The database's hybrid-logical timestamp as a decimal string `"<wall ns>.<logical>"` (`commitTs`), the same form as resolved markers; `acceptedAtMs` is its wall part in ms |
| Minutes | UTC minute starts, half-open `[m, m + 60 000 ms)`, carried as epoch ms of the minute start (`minuteMs`) |
| Volume | **Bytes**, unsigned 64-bit in IPFIX; in JSON a decimal string (`"2000000000"`). A part's bytes are an **exact fraction** `{ num, den }`, decimal strings, `num` signed, `den` > 0, not necessarily reduced |
| Packets | Decimal string, optional |
| Durations and timeouts | Milliseconds unless the name says seconds |
| Sizes | Bytes; 1 KB = 1 024 B, 1 MB = 1 048 576 B for wire limits |
| Identifiers | Pseudonymous strings: `ExporterId` (from C08), `AccountId`, `ProductId`, `RouteId` (catalogue route), `ReservationId` (RFC-002), `LinkId` (RFC-001 link registry), `SupplierId` |
| Rate | Not carried by this contract |
| Money | Not carried by this contract |

Every JSON field is required unless marked `?`. Consumers ignore unknown fields
(see [Versioning](#versioning-and-compatibility-rules)).

## Schema

### Common types

```ts
type ExporterId = string;        // issued with the exporter credential (C08)
type AccountId = string; type ProductId = string; type RouteId = string;
type ReservationId = string; type LinkId = string; type SupplierId = string;
type U64 = string;               // decimal, 0 .. 2^64-1
type I64 = string;               // decimal, signed
type HlcTs = string;             // "<wall ns>.<logical>"
type EpochMs = number;           // integer ms since epoch, UTC
type ExactBytes = { num: I64; den: U64 };

/** Owner of an exporter, as the C08 credential names it. A superseding record's
 *  downward amendment is borne by this owner (RFC-003 §3.3). */
type ExporterOwner = { kind: "supplier"; supplierId: SupplierId } | { kind: "share" };

type Direction = "ingress" | "egress";   // IPFIX flowDirection 0 / 1

/** Service tag, "as configured" per binding (RFC-003 §4.1). Absent members are absent
 *  in the record; equality is member-wise, absent equals absent only. */
type ServiceTag = {
  vlan?: { outer: number; inner?: number };   // 802.1Q, or 802.1ad pair
  mplsLabel?: number;                          // top label, 20 bits
  vrf?: string;                                // VRF name or id, as configured
};

/** Observation point: where a count is taken (RFC-003 §4.1). */
type ObservationPoint = {
  exporterId: ExporterId;
  observationDomain: number;   // IPFIX observation domain / NetFlow v9 source ID, uint32
  ifIndex: number;             // interface index, uint32
  direction: Direction;
};

/** Record identity (RFC-003 §3.2), refining RFC-000 §4.4's (exporter, epoch, sequence). */
type RecordIdentity = {
  exporterId: ExporterId;
  observationDomain: number;
  epoch: number;               // ingestion's epoch number for this (exporter, domain)
  extSeq: U64;                 // k * 2^32 + q + i
};

/** Raw reference of a received record (RFC-003 §3.3): the batch entry it was logged in. */
type RawRef = { exporterId: ExporterId; logSeq: U64; index: number };

/** Identity of a correction or a superseding version (RFC-003 §3.3). */
type DerivedIdentity =
  | { kind: "record"; id: RecordIdentity }
  | { kind: "correction"; exporterId: ExporterId; rawRef: RawRef }
  | { kind: "version"; original: RecordIdentity; v: number };

/** The decoded contents of a record in the Share metering template. */
type RecordFields = {
  observationDomain: number;
  ifIndex: number;
  direction: Direction;
  serviceTag: ServiceTag;
  flowStartMs: EpochMs;
  flowEndMs: EpochMs;
  bytes: I64;                  // I64 so a negative count can be reported and rejected
  packets?: U64;
};
```

### Part I. Flow-record ingestion protocol (exporter ↔ ingestion edge)

**Session.** gRPC service `share.metering.v1.Ingest`, method
`Session(stream ExporterFrame) returns (stream EdgeFrame)`, over HTTP/2 with mutual TLS
to the ingestion edge of R1 or R2. The client certificate is the exporter credential of
**C08**; it names one `ExporterId` and its owner. Every frame on the stream is accounted to
that exporter. Protobuf on the wire; the TypeScript below is normative for field names,
types and units (a `.proto` is generated from it, field numbers frozen with this version).

```ts
// ---------- exporter -> edge ----------
type ExporterFrame =
  | { hello: Hello }
  | { batch: Batch }
  | { creditAck: { batchNo: U64 } };       // optional; diagnostics only

type Hello = {
  protocolVersion: 1;
  exportFormat: "ipfix" | "netflow-v9";
  softwareId?: string;                     // exporter/relay software, diagnostics
};

/** Up to maxBatchBytes (1 MB, est.) of items. batchNo is sender-chosen and is used only
 *  to correlate the acknowledgement; it carries no identity. */
type Batch = { batchNo: U64; items: BatchItem[] };

type BatchItem =
  | { exportMessage: Uint8Array }          // one IPFIX message or NetFlow v9 packet, VERBATIM, header included
  | { correction: Correction }
  | { supersession: Supersession };

/** Corrects a REJECTED record of this exporter (RFC-003 §3.3, P3-S30). */
type Correction = {
  correctsRawRef: RawRef;                  // as returned in the rejection's acknowledgement
  record: RecordFields;
};

/** Supersedes an ACCEPTED record of this exporter (RFC-003 §3.3, P3-S66, P3-S72). */
type Supersession = {
  original: OriginalRef;
  v: number;                               // >= 1, increasing per original
  record: RecordFields;                    // may differ from the original only in measured fields
};

/** How an exporter names an accepted original. Either Share's identity (when the
 *  exporter holds it, e.g. from the acknowledgement or evidence) or the exporter-side
 *  coordinates, which ingestion resolves to the identity by RFC-003 §3.2. */
type OriginalRef =
  | { identity: RecordIdentity }
  | { coordinates: {
        observationDomain: number;
        systemInitTimeMs: EpochMs;         // as in the original message
        exportTimeS: number;               // of the original message
        sequenceNumber: number;            // uint32: the record's own number, q + i mod 2^32
      } };

// ---------- edge -> exporter ----------
type EdgeFrame =
  | { welcome: Welcome }
  | { credit: Credit }
  | { ack: BatchAck }
  | { notice: SessionNotice };

type Welcome = {
  protocolVersion: 1;
  exporterId: ExporterId;                  // from the C08 certificate
  owner: ExporterOwner;                    // from the C08 credential
  sessionId: string;
  region: "R1" | "R2";
  maxBatchBytes: number;                   // 1 048 576 (est.)
  ingestRetryTimeoutMs: number;            // 2000 (est.)
  serverTimeMs: EpochMs;                   // informative
};

/** Credit-based flow control. Credit is cumulative grants of whole batches and bytes;
 *  an exporter without credit buffers. The edge never drops a batch it took credit for. */
type Credit = { batches: number; bytes: number };

type BatchAck = {
  batchNo: U64;
  committedAt: { commitTs: HlcTs; acceptedAtMs: EpochMs };
  items: ItemAck[];                        // one per BatchItem, same order
};

type ItemAck =
  | { message: MessageAck }
  | { correction: DerivedAck }
  | { supersession: DerivedAck };

type MessageAck = {
  accepted: number;                        // records accepted
  duplicates: number;                      // records already accepted earlier
  rejected: RejectedRecord[];              // each rejected record with its reason
  templateRefusals: TemplateRefusal[];     // template records refused for the session
};

type RejectedRecord = {
  index: number;                           // position of the data record in the message, or -1 for a whole unparseable message/remainder
  rawRef: RawRef;                          // what a Correction names
  identity?: RecordIdentity;               // when the header gave one
  reason: RejectReason;
};

type RejectReason =
  | "no exporter" | "no template" | "no sequence number" | "no epoch"
  | "negative byte count" | "end time before its start time" | "missing flow times"
  | "flow time in the future" | "unparseable";

type TemplateRefusal = { templateId: number; observationDomain: number; reason: string };

type DerivedAck = {
  outcome: "accepted" | "duplicate" | "refused";
  identity: DerivedIdentity;
  reason?: DerivedRefusal | RejectReason;  // present iff refused
};

type DerivedRefusal =
  | "not this exporter's record"
  | "no such rejected record"              // correction only (contract completion, see Semantics)
  | "no such accepted record"              // supersession only
  | "outside dispute_window"
  | "version out of order"
  | "changes an attribution key"
  | "outside the original's minutes";

type SessionNotice = {
  kind: "credential-revoked" | "draining" | "protocol-error";
  detail?: string;                         // never payload content
};
```

**The Share metering template** (the glossary's *record template*). A template is
accepted for the session only if every field it declares is in this list; any other
field (an address, a port, a subscriber identifier, any enterprise element not listed) makes
the whole template refused, reported in `templateRefusals`.

| Field | IPFIX element (id) | NetFlow v9 field | Role |
|---|---|---|---|
| Flow start | `flowStartMilliseconds` (152) or `flowStartSysUpTime` (22) | `FIRST_SWITCHED` (22) | Measured |
| Flow end | `flowEndMilliseconds` (153) or `flowEndSysUpTime` (21) | `LAST_SWITCHED` (21) | Measured |
| Octets | `octetDeltaCount` (1) | `IN_BYTES` (1) | Measured, required |
| Packets | `packetDeltaCount` (2) | `IN_PKTS` (2) | Measured, optional |
| Observation point | `ingressInterface` (10) or `egressInterface` (14) | `INPUT_SNMP` (10) / `OUTPUT_SNMP` (14) | Attribution key |
| Direction | `flowDirection` (61) | `DIRECTION` (61) | Attribution key |
| VLAN | `vlanId` (58), `dot1qVlanId` (243), `dot1qCustomerVlanId` (245) | `SRC_VLAN` (58) | Attribution key (service tag) |
| MPLS | `mplsTopLabelStackSection` (70) | `MPLS_LABEL_1` (70) | Attribution key (service tag) |
| VRF | `ingressVRFID` (234) or `VRFname` (236) | `INGRESS_VRFID` (234) | Attribution key (service tag) |
| System init time | `systemInitTimeMilliseconds` (160), options record | header `unix_secs × 1000 − sysUpTime` | Epoch (RFC-003 §3.2) |

The observation domain (IPFIX header Observation Domain ID; NetFlow v9 Source ID) is an
attribution key and part of the identity.

### Part II. Metering hand-off (ingestion → attribution stage A)

**Topic** `metering.handoff.v1`. **Key** `exporterId` (an exporter's events are on one
Kafka partition, in order). **Retention** 3 days (RFC-006 §5.6). Values are encrypted
by the owner's column-encryption library (RFC-005 C13); the schema below is the
plaintext. **No event carries any part of a non-conforming payload.**

```ts
type HandoffEvent = {
  schemaVersion: 1;
  exporterId: ExporterId;
  handoffSeq: U64;              // contiguous per exporter over the hand-off stream (1, 2, 3 ...)
  logSeq: U64;                  // the ingest_log entry's sequence in the exporter partition
  writer: { generation: number; ownerEpoch: number };  // diagnostics; dedupe is by handoffSeq
  commitTs: HlcTs;              // the entry's commit timestamp = acceptance time
  acceptedAtMs: EpochMs;
  owner: ExporterOwner;         // the exporter's owner at the session
  body: BatchBody | CorrectionBody | SupersessionBody | IdentityConflictBody;  // IdentityConflictBody: settled S-2
};

type BatchBody = {
  kind: "batch";
  session: { sessionId: string; region: "R1" | "R2" };
  accepted: AcceptedRecord[];          // the only records stage A applies
  duplicates: { identity: RecordIdentity; digest64: string }[];   // hex, 64-bit content digest
  rejected: {
    rawRef: RawRef;
    identity?: RecordIdentity;
    reason: RejectReason;
    nonConforming?: {                  // only for "no template" and "unparseable"
      keyedDigest: string;             // hex HMAC-SHA-256 under the exporter's digest key
      digestKeyVersion: number;
      recordId: string;                // the put_payload record_id
      keep: { outcome: "kept"; bucket: string }
          | { outcome: "dropped: cap"; payloadBytes: number }
          | { outcome: "dropped: not taken in time" }
          | { outcome: "dropped: unanswered, withdrawal pending" };
    };
  }[];
};

type AcceptedRecord = {
  identity: RecordIdentity;
  rawRef: RawRef;
  fields: RecordFields;                // decoded by ingestion with the session's template; times absolute
  exportTimeS: number;
};

type CorrectionBody = {
  kind: "correction";
  outcome: "accepted" | "duplicate" | "refused";
  correctsRawRef: RawRef;
  identity: DerivedIdentity;           // original's identity if it had one, else correction identity
  fields: RecordFields;
  reason?: DerivedRefusal | RejectReason;
};

type SupersessionBody = {
  kind: "supersession";
  outcome: "accepted" | "duplicate" | "refused";
  original: { identity: RecordIdentity; rawRef: RawRef };
  v: number;
  identity: DerivedIdentity;           // { kind: "version", original, v }
  fields: RecordFields;
  reason?: DerivedRefusal | RejectReason;
};

/** Settled S-2: identity-conflict rows are on the hand-off. */
type IdentityConflictBody = {
  kind: "identity-conflict";
  identity: RecordIdentity;
  originalDigest64: string;
  conflictingDigest64: string;
  conflicting: { rawRef: RawRef; fields: RecordFields };   // kept in full, to be quarantined "identity conflict"
};

/** Per Kafka partition, from the closure emitter (RFC-000 §8 substrate, AI6-11). */
type HandoffResolved = {
  schemaVersion: 1;
  kind: "resolved";
  resolvedTs: HlcTs;   // no hand-off row committed at or below this follows on this partition
};
```

### Part III. Attribution keys from provisioning (provisioning → stage A)

**Topic** `provisioning.bindings.v1`. **Key** `exporterId` (every fact concerns one
observation point, which belongs to one exporter). Retention: compacted is **not**
allowed (facts are never deleted); time retention at least 7 days, with stage A's
`attr_a_log` keeping every consumed fact for 7 years (RFC-003 §4.1).

```ts
type ProvisioningEvent = {
  schemaVersion: 1;
  exporterId: ExporterId;
  bindingSeq: U64;            // contiguous per exporter: the binding position
  recordedAtMs: EpochMs;      // transaction time (bitemporal)
  fact: ObservationPointFact | BindingFact | CorrectionFact | Heartbeat;
};

/** Observation point -> link mapping (AI3-8). A mapping is ended or changed by a later
 *  fact for the same observation point with a later validFromMs. */
type ObservationPointFact = {
  kind: "observation-point";
  op: ObservationPoint;
  linkId: LinkId | null;      // null: the point is no longer on any Share link from validFromMs
  validFromMs: EpochMs;
};

type BindingFact = {
  kind: "binding";
  factId: string;             // unique, provisioning-assigned
  bindingId: string;          // stable across versions of one binding
  key: { op: ObservationPoint; serviceTag: ServiceTag };
  validFromMs: EpochMs;
  validToMs: EpochMs | null;  // half-open [from, to); a binding is ended by a later fact with validToMs set
  accountId: AccountId;
  productId: ProductId;
  routeId: RouteId;           // catalogue route ID
  reservationId: ReservationId | null;   // null: attachment without a reservation, or best-effort
  egress: boolean;            // this op is where traffic on this binding, in op.direction, leaves the route
};

/** A fact found wrong, superseded as of recordedAtMs (never a delete). */
type CorrectionFact = {
  kind: "correction";
  supersedesFactId: string;
  replacement: BindingFact | ObservationPointFact | null;   // null: retracted
};

/** Completeness assertion: every fact valid at any time <= coversThroughMs for this
 *  exporter's observation points has a bindingSeq <= this event's. */
type Heartbeat = { kind: "heartbeat"; coversThroughMs: EpochMs };
```

**Domain assignments (settled S-1).** Topic `provisioning.domains.v1`, key
`observationDomain`, read in full by **every** stage A instance (small: about 4 × 10⁴
facts, est.). It tells stage A, for a record of exporter X on domain d, whether
provisioning assigns d to X, to another exporter, or to none.

```ts
type DomainAssignmentEvent = {
  schemaVersion: 1;
  observationDomain: number;
  domainSeq: U64;             // contiguous per observationDomain
  recordedAtMs: EpochMs;
  exporterId: ExporterId;
  assigned: boolean;          // false ends the assignment from validFromMs
  validFromMs: EpochMs;
};
```

Provisioning publishes a domain assignment no later than the first
`ObservationPointFact` naming (exporter, domain), and in the same order relative to it as
a binding is to traffic (before the network reports on the domain).

### Part IV. Attributed part batches (stage A → stage B; RFC-003 internal)

**Topic** `attribution.parts.v1`. **Key** `accountId` (the rating slot map's routing).
Written as stage A outbox rows in the same transaction as the `processed` entry.

```ts
type PartBatch = {
  schemaVersion: 1;
  feedId: { stageAPartition: ExporterId; ownerEpoch: number; logSeq: U64; accountId: AccountId };
  destSeq: U64;               // contiguous per (stageAPartition, accountId)
  bindingPosition: U64;       // the bindingSeq stage A used
  commitTs: HlcTs;            // of the processed entry
  parts: Part[];
  attachmentFacts?: { productId: ProductId; live: boolean; validFromMs: EpochMs }[];  // for stage B's attachment set
};

type Part = {
  recordIdentity: RecordIdentity | DerivedIdentity;
  acceptedAtMs: EpochMs;
  lastMinuteEndMs: EpochMs;   // end of the last minute the record was active in (lateness)
  minuteMs: EpochMs;
  bytes: ExactBytes;          // signed: negated parts for supersession and reversal
  class: "reservation" | "attachment" | "best-effort";
  accountId: AccountId;
  productId: ProductId;
  routeId: RouteId;
  reservationId: ReservationId | null;
  op: ObservationPoint;
  linkId: LinkId;
  reason?: "superseding record" | "quarantine attribution" | "attribution reversed";
  cause?: ExporterOwner;      // for "superseding record": the exporter's owner; for "attribution reversed": { kind: "share" }
  sourceRef?: string;         // finance attribution's source reference (POL-29)
  reversedSourceRef?: string; // for "attribution reversed": the attribution's reference
};
```

## Semantics per operation and message

### Part I

**Session open.** The edge accepts the TLS session only with a valid, unrevoked C08
exporter certificate; otherwise nothing is created (RFC-003 §3.1). After `Hello` the edge
sends `Welcome` (exporter ID and owner from C08) and an initial `Credit`. The edge checks
the certificate serial against its replica **on every frame** (RFC-005 §2.1); on
revocation it sends `notice{credential-revoked}` and closes the stream within 31 s of the
revocation (X1-S41, owned by C08). Batches already committed stand; an unacknowledged
batch of a revoked exporter is never accepted afterwards.

**Templates are session-scoped.** A template is usable only on the session that accepted
it. On every new session (including a reconnect to the other region) the exporter **must
send its template sets before any data set or retransmission** that uses them (IPFIX
RFC 7011 §8 practice). A template-only message advances no sequence number and creates no
record identity.

**Batch.** Preconditions: credit available; size ≤ `maxBatchBytes`. Each export message is
validated record by record (RFC-003 §3.3). Outcomes per record, all recorded in the same
`batch` entry before the acknowledgement:

| Outcome | Condition |
|---|---|
| Accepted | Valid; identity not in the exporter's range set. Identity added; flows to part II |
| Duplicate | Valid; identity already accepted. Counted in `duplicates`; a compact duplicate (identity, acceptance time, 64-bit digest) kept; nothing flows on |
| Rejected | One `RejectReason`. `no exporter`: only when the header carries no observation domain / source ID (settled S-1); any domain present is accounted to the session's exporter, and stage A judges whether it is that exporter's. `no template`: a data set whose template was not accepted on this session or was refused. `no epoch`: no usable system init time. `flow time in the future`: end > owner clock + `future_skew_max`. Kept with its reason; identity not added; nothing charged |

A rejected record never delays the records after it (P3-S29). A zero-byte record is
accepted. **Non-conforming payloads** (`no template`, `unparseable`): the log, the
acknowledgement and the hand-off hold only the identity (or raw reference), keyed digest
with key version, reason, `record_id` and keep outcome, never the payload; the payload is
put to the personal-data store under RFC-005 C12, and keeping it is not required
(P3-S71, P3-S75). The message is logged with the non-conforming sets cut out.

**Acknowledgement.** `BatchAck` is sent only after the transaction holding the batch has
committed, durable in two regions (X2-S14). An acknowledged batch never needs resending;
all three outcomes are durable. A rejected record's `rawRef` is returned so the exporter
can correct it. **There is no negative acknowledgement**: a batch is either acknowledged
after commit or not acknowledged at all.

**No acknowledgement while a digest key is unavailable** (RFC-003 §3.3 step 1, review 29
W-1). If a batch holds a non-conforming payload, and ingestion has no digest-key version
cached for the exporter and `digest_key(exporter)` fails, the batch is **neither committed
nor acknowledged**; the exporter's later batches on that partition queue behind it and are
not acknowledged either; other exporters are unaffected. The exporter keeps retransmitting
verbatim after `ingestRetryTimeoutMs`; ingestion alerts the wait and resumes at the first
successful fetch. With a version cached, a key-service outage changes nothing.

**Batches holding a non-conforming payload** are acknowledged after every put is answered
or `pd_put_timeout` (500 ms, est.) has passed, whichever is first; an unanswered put is
then withdrawn (RFC-003 §3.3 step 5) off the acknowledgement path.

**Correction** (`Correction`). Accepted only on a session of the exporter that produced
the rejected record: `correctsRawRef.exporterId` must equal the session's exporter, else
`refused` "not this exporter's record", recorded as a refused attempt. The corrected record
is validated like any record. Its identity is the rejected record's identity if it had one,
else `{kind:"correction", exporterId, rawRef}`. A correction for a raw reference already
corrected, or whose identity is already accepted, is a `duplicate`: charged once however
often sent (P3-S30). A raw reference naming no rejected record of the partition is
`refused` "no such rejected record" (contract completion; RFC-003 does not name the
reason).

**Supersession** (`Supersession`). Validated like any record, then every check against the
**original**, never an earlier version (RFC-003 §3.3):

| Check | Outcome on failure |
|---|---|
| Original is this exporter's | `refused` "not this exporter's record" |
| Original accepted in this partition (an `OriginalRef.coordinates` is resolved by §3.2's epoch and wrap rules) | `refused` "no such accepted record" |
| Commit timestamp before the original's last minute end + `dispute_window` | `refused` "outside dispute_window"; the original stands (P3-S66) |
| `v` above every accepted version of the original | Same `(original, v)` with the same digest: `duplicate`; otherwise `refused` "version out of order" |
| Every non-measured field equal to the original's (domain, interface, direction, every service-tag member) | `refused` "changes an attribution key" (P3-S72) |
| `floor_min(start') ≥ floor_min(start)` and the version's last minute end ≤ the original's | `refused` "outside the original's minutes" (P3-S72) |

Accepted: identity `{kind:"version", original, v}`; the original stays in the range set and
is never altered (P3-S31); the latest accepted version replaces the previous one for
charging, the downward effect borne by the exporter's `owner` (P3-S66). A refused version
changes nothing and is recorded with its reason.

**Probe.** The usage-ingestion probe sends one record from a designated probe exporter and
succeeds on its `BatchAck` with `accepted = 1` within 1 s (X2-S18). Probe records are
handled on the same path; stage A classes them probe (X2-S20).

### Part II

Ingestion's `ingest_log` is self-outboxed (RFC-006 §3.5): each `batch`, `correction`,
`supersession` and `identity-conflict` (S-2) row yields exactly one `HandoffEvent`,
derived by a versioned emit function from the row alone. The owner publishes directly
after commit (fast path); the changefeed relay publishes the same event (guaranteed
path). A truncator delete is never an event.

Stage A, for each exporter it owns:

- applies events in `handoffSeq` order; a `handoffSeq` at or below the last applied is a
  duplicate and is dropped; a gap **waits** (never skips);
- applies only `accepted` records, `accepted` corrections and `accepted` supersessions
  and identity conflicts (S-2); duplicates and rejections are informative;
- takes the acceptance time of every record from `commitTs` / `acceptedAtMs`;
- advances its watermark only from `HandoffResolved` markers on the partitions it reads,
  never from raw changefeed timestamps (RFC-003 §4.2, AI-27-3).

### Part III

Provisioning publishes facts it never deletes; a binding is ended, and a mapping changed,
by a new fact. Stage A, per exporter, applies events in `bindingSeq` order (gap waits;
at-or-below last applied dropped) and writes every consumed fact to `attr_a_log`.

- **Bind** (RFC-003 §4.2 step 3): for a part in minute `m` of a record active from `s`, the
  latest version of each `bindingId` with `bindingSeq` ≤ the current binding position whose
  key equals (observation point incl. direction, service tag) and whose `[validFromMs,
  validToMs)` contains `max(s, m)`. Zero matches: pending-binding hold. Two or more:
  unattributable "ambiguous binding", alerted as a provisioning error.
- **Domain check** (settled S-1, before binding): for an accepted record of exporter X on
  domain d at time t, using the domain assignments in force at t:
  - d assigned to X: bind as below;
  - d assigned only to other exporters: every part is **quarantined** with reason
    **"domain not of exporter"** (no pending hold), keeping the record as evidence, with
    its link and supplier where an observation-point fact of X names one, otherwise the
    exporter's owner;
  - d assigned to no exporter: the parts follow the no-binding path (pending hold, then
    quarantined "no binding").
  A finance attribution of such entries follows RFC-003 §4.4 like any quarantine entry.
- **Observation point → link**: the `ObservationPointFact` in force at the part's time gives
  its `linkId`, hence (through RFC-001's registry) the supplier for quarantine reports.
- **Egress**: per (route, direction) exactly one egress binding; stage A alerts otherwise.
  When the route's last leg is an unmetered partner link, provisioning sets egress on the
  hand-off point to that partner (P3-S67).
- **Heartbeat**: a part with no binding is held until the exporter's `coversThroughMs` ≥
  the part's time + `binding_grace` (5 min, est.), then quarantined "no binding" (P3-S26).
- **Precondition on the producer**: a binding is published **before** the network carries
  traffic on it (RFC-003 R3-4). A late binding is not an error of this contract's form,
  but its traffic is quarantined, recoverable only by finance attribution.

### Part IV

Stage A emits, per `processed` entry and destination account, at most one `PartBatch`,
deterministic in the records and the binding position. Stage B appends each batch in a
slot batch transaction unless `destSeq` ≤ its producer watermark for that
`stageAPartition` (dropped); a gap waits. Negated parts carry `reason` and `cause` as in
RFC-003 §4.2 and §4.4. Non-egress, probe and quarantined parts are never sent.

## Delivery and ordering

| Part | Guarantee | Partition key | Ordering scope |
|---|---|---|---|
| I | At least once from the exporter (retransmit until acknowledged, verbatim, either region); **exactly-once effect** per record identity via the range set (P3-S14, P3-S16) | Session (one exporter) | None required across batches: records may arrive in any order (P3-S15). Within a batch, items are logged in order |
| II | At least once (two publish paths, redelivery); exactly-once effect at stage A by `handoffSeq` | `exporterId` | Total per exporter by `handoffSeq` (contiguous) |
| III | At least once; exactly-once effect by `bindingSeq` | `exporterId` | Total per exporter by `bindingSeq` (contiguous) |
| III (domains) | At least once; exactly-once effect by `domainSeq` | `observationDomain` | Total per domain by `domainSeq` (contiguous) |
| IV | At least once (outbox publish and relay); exactly-once effect at stage B by `destSeq` | `accountId` | Total per (stage A partition, account) by `destSeq` (contiguous) |

## Idempotency

| Item | Key | Duplicate (same content) | Same key, different content |
|---|---|---|---|
| Record | `RecordIdentity` | Acknowledged as `duplicates`; nothing flows on; no amendment | A protocol violation: detected asynchronously by the 64-bit digest check, recorded as `identity-conflict`, quarantined "identity conflict", alerted; never treated as the original (RFC-003 §3.5) |
| Correction | Rejected record's raw reference, or its identity | `duplicate`; charged once | Second correction of the same raw reference is also `duplicate` (first wins) |
| Supersession | `(original identity, v)` | `duplicate` | `refused` "version out of order" |
| `batchNo` | None (correlation only) | — | Reusing a `batchNo` is allowed; acknowledgements are matched in order of the stream |
| Non-conforming payload put | `record_id` = (exporter, identity or raw reference, keyed digest) | Store answers with the first put's bucket | Different payloads always differ in `record_id` (digest-bound) |
| Hand-off event | (`exporterId`, `handoffSeq`) | Dropped | Impossible by construction (one row, one deterministic emit function); if seen, stage A stops the partition and alerts |
| Provisioning event | (`exporterId`, `bindingSeq`); domain events (`observationDomain`, `domainSeq`) | Dropped | Producer violation: stage A stops the exporter's binding consumption and alerts |
| Part batch | (`stageAPartition`, `accountId`, `destSeq`) | Dropped | Impossible by construction (outbox row); if seen, stage B alerts |
| Finance attribution / reversal (parts' `sourceRef`) | Source reference (POL-29) | First result | Refused (RFC-003 §4.4); not this contract's command, only carried |

## Ownership

| Data | Writer | Readers |
|---|---|---|
| Session, frames, acknowledgements | Exporter (frames), ingestion edge (acks) | The two ends |
| `ingest_log`, range sets, epoch table, wrap anchors | Metering ingestion only, single writer per exporter partition, insert-only (no update/delete grant, P3-S31) | History (sealing, evidence query, RFC-006); the relay |
| `metering.handoff.v1` | Ingestion (direct publish) and the relay for `ingest_log` | Attribution stage A only |
| `provisioning.bindings.v1` | Provisioning only | Attribution stage A only (stage A's `attr_a_log` keeps the history) |
| `provisioning.domains.v1` | Provisioning only | Every attribution stage A instance |
| `attribution.parts.v1` | Stage A (outbox) | Stage B only |
| Exporter credential (ID, owner, serial status) | Identity and access via C08 (issued by the supplier administrator, or network operations for Share's exporters) | Edge; ingestion's credential cache |
| Non-conforming payloads | Personal-data store (RFC-005 C12) | Never this contract's topics or tables |

Ingestion reads nothing but its own tables and the exporter credential cache: no
provisioning, catalogue, reservation or rating state (RFC-003 §3.6).

## Timeouts and deadlines

| Name | Value | Meaning |
|---|---|---|
| `ingest_retry_timeout` | 2 000 ms (est.) | Exporter resends an unacknowledged batch verbatim, to either region |
| Acknowledgement latency | ≈ 85 ms p99 steady, ≈ 200 ms after a region loss (est.); + ≤ 500 ms with a non-conforming payload | Commit-to-ack path (RFC-003 §3.6) |
| Probe limit | 1 000 ms | X2-S18 |
| `pd_put_timeout`; `keep_by` | 500 ms (est.); put issue time + 500 ms − ε, ε = 100 ms | Non-conforming payload put bound |
| Digest-key wait | Unbounded, alerted | Batch not acknowledged until the key service answers |
| `epoch_jitter`, `wrap_slack`, `future_skew_max` | 2 s, 10 min, 5 min (est.) | RFC-003 §3.2, §3.3 |
| Takeover of ingestion, stage A or stage B | ≈ 5 s p99 (est.), 3 s owner lease | Exporters resend after 2 s; nothing acknowledged is lost (X2-S02, X2-S09, X2-S12) |
| Acceptance → stage B committed | ≈ 0.3 s p99 (est.) | Inside `attribution_lag_max` 10 s (X2-S22, P3-S61, P3-S62) |
| `binding_grace` | 5 min (est.) | Pending-binding hold before quarantine |
| Provisioning heartbeat | At least every 5 s per exporter with observation points (est., contract value) | A stale heartbeat (> 60 s) is alerted by stage A |
| `dispute_window` | 30 days from the end of the original's last minute | Supersession deadline (POL-17) |

## Versioning and compatibility rules

- **Part I**: `protocolVersion` in `Hello`/`Welcome`. Minor changes (new optional fields,
  new `RejectReason` or `DerivedRefusal` values, new optional template elements that hold
  no personal data) keep version 1; exporters must treat an unknown reason as a rejection.
  Removing or re-typing a field, or changing identity or acknowledgement semantics, is a new
  `protocolVersion`, served beside the old for at least 12 months. Identity computation
  (RFC-003 §3.2) can **never** change for already-received records: a verbatim resend years
  later must map to the same identity.
- **Parts II to IV**: `schemaVersion` in every event. Additive fields only within a
  version; consumers ignore unknown fields and unknown `body.kind` values **only after
  alerting** (an unknown kind on part II or III stops the partition, since skipping could
  lose traffic or bindings). A breaking change publishes a new topic `*.v2` alongside `*.v1`
  until every consumer has moved; emit functions are versioned (RFC-006 §3.5), and a
  re-derivation from `ingest_log` under a new emit function yields the same `handoffSeq`.
- The template list may grow only by elements that cannot identify a person (RFC-000 A11);
  adding one requires a contract review.

## Scenarios relied on

P3-S14, P3-S15, P3-S16, P3-S17, P3-S18, P3-S19, P3-S26, P3-S28, P3-S29, P3-S30, P3-S31,
P3-S38, P3-S39, P3-S49, P3-S50, P3-S51, P3-S61, P3-S62, P3-S66, P3-S67, P3-S68, P3-S71,
P3-S72, P3-S73, P3-S75; X2-S02, X2-S04, X2-S09, X2-S10, X2-S12, X2-S14, X2-S18, X2-S20,
X2-S22; X1-S41 and X1-S45 through C08 (credential revocation, held administrator). All at
`requirements-v1.10`.

## Conformance tests

**Ingestion (provider) runs:**

1. *Ack after durability*: block the second region's replica; no `BatchAck` is sent until
   two-region durability; then exactly one (X2-S14).
2. *Outcomes*: a batch with one record per `RejectReason`, valid records after each; every
   rejection acknowledged with `rawRef` and reason, the valid ones accepted (P3-S28, P3-S29).
3. *Duplicates and identity*: resend a batch verbatim to the other region; all `duplicates`.
   Restart (new init time) and resend sequence 7: accepted (P3-S50). A 32-bit wrap, then a
   verbatim pre-wrap redelivery a simulated year later: duplicate (P3-S14).
4. *Templates*: a template declaring `sourceIPv4Address` is refused in `templateRefusals`;
   its data sets rejected `no template`; scan every topic, table, log and trace for marker
   addresses: none (P3-S71). A reconnect that retransmits without re-declaring templates
   gets `no template`; with templates first, accepted.
5. *Digest key unavailable*: no cached version and `digest_key` failing; a batch with a
   non-conforming payload and a later conforming batch of the same exporter get **no ack**;
   another exporter's batches are acknowledged; after the key returns, the retransmission is
   acknowledged with the keyed digest and key version.
6. *Store slow*: non-conforming batch acknowledged within 1 s with `dropped: not taken in
   time` or `unanswered, withdrawal pending`; conforming batches and the probe unaffected
   (P3-S75, X2-S18).
7. *Corrections*: a correction sent three times by its own exporter: accepted, duplicate,
   duplicate; from another exporter: refused "not this exporter's record" (P3-S30).
8. *Supersessions*: the P3-S72 table rows plus version 2 moving outside the original's
   minutes after a narrowing version 1; `OriginalRef.coordinates` and `.identity` resolve to
   the same original; after `dispute_window`: refused (P3-S66).
9. *Hand-off*: drop the direct publish; the relay alone delivers every event with
   contiguous `handoffSeq`; with both paths, each event is delivered at least once and
   identical; no event holds payload bytes.
10. *Revocation* (with C08): revoke a credential mid-stream; `credential-revoked` and close
    within 31 s; no batch from it is accepted afterwards (X1-S41).

**Exporter (or relay) runs, against the reference edge simulator:**

11. Keeps every message until acknowledged; resends **byte-identical** after 2 s to either
    region; buffers without credit; never resends an acknowledged batch.
12. Declares templates at the start of every session; uses only template-list elements.
13. Corrects only by the returned `rawRef`; supersedes with increasing `v`, measured fields
    only.

**Attribution stage A (consumer of II and III) runs:**

14. Gap in `handoffSeq` or `bindingSeq` waits; duplicates dropped; out-of-order delivery
    from two publish paths applied once (P3-S15, P3-S17).
15. Watermark advances only on `HandoffResolved`; a stalled changefeed partition holds it.
16. Binding: P3-S49 (egress only), P3-S67 (hand-off to unmetered partner), no binding →
    held, quarantined after `binding_grace` + heartbeat (P3-S26); two bindings → ambiguous,
    alerted; a record on a domain provisioning assigns to another exporter → quarantined
    "domain not of exporter" at once, and on an unassigned domain → held, then "no binding"
    (S-1); a `CorrectionFact` changes later decisions only, recorded positions reproduce
    earlier ones (P3-N9).
17. Supersession dispositions P3-S73: quarantined original's version quarantined in place.

**Provisioning (producer of III) runs, against the published validator:**

18. Contiguous `bindingSeq` per exporter and `domainSeq` per domain; a domain assigned
    before the first observation-point fact naming it; heartbeats at least every 5 s; no fact deleted;
    exactly one egress per (route, direction); binding published before traffic in a
    staging soak.

**Attribution stage B (consumer of IV) runs:**

19. `destSeq` at or below the producer watermark dropped; gap waits; negated parts with
    `reason` and `cause` applied; a takeover reloads watermarks and applies nothing twice.

## Settled

The orchestrator settled both mismatches of the first draft (binding decisions). The
RFC errata named are to be applied to the RFCs; this contract already states the settled
reading.

| # | Point | Decision | Errata |
|---|---|---|---|
| **S-1** (was M-1) | Where ingestion learns which observation domains belong to an exporter: RFC-003 §3.3 rejects `no exporter` for a domain "not registered to the session's exporter", but ingestion reads no provisioning (RFC-003 §3.6) and the C08 credential names no domains (RFC-005 §2.1) | Ingestion answers `no exporter` **only when the header carries no observation domain**. Stage A quarantines traffic on a domain no provisioning fact names ("no binding", after the pending hold) **and** traffic on a domain provisioning assigns to a different exporter than the session's, with reason **"domain not of exporter"**, so the evidence is kept. C08 carries no provisioning data. This contract adds the domain-assignment feed (`provisioning.domains.v1`) stage A needs for the check | RFC-003 §3.3 (reason `no exporter` narrowed; new quarantine reason in §4.2/§4.4) |
| **S-2** (was M-2) | Identity conflicts were not on the hand-off: RFC-003 §3.5 quarantines them in stage A, but the hand-off stream named only `batch`, `correction` and `supersession` rows | The hand-off carries `identity-conflict` rows (`IdentityConflictBody`); stage A spreads the conflicting record and quarantines it "identity conflict" | RFC-003 §3.4, §7; RFC-006 §3.5 (the `ingest_log` hand-off stream declaration) |

### Scope note

The brief named the metering hand-off as "stage A → stage B". RFC-000 §8 and RFC-003 §7
define the **metering hand-off** as ingestion → attribution stage A (accepted record
batches by exporter); stage A → stage B is RFC-003-internal ("Attributed parts",
§4.2–§4.3). This contract follows the RFCs for part II and specifies stage A → stage B
separately as part IV. Accepted by the orchestrator.

### Contract completions (accepted by the orchestrator)

- `BatchAck` returns each rejected record's `rawRef` (RFC-003 §3.1 says corrections name
  it but does not say how the exporter learns it).
- `OriginalRef.coordinates` lets an exporter name an accepted original without Share's
  epoch number (RFC-003 §3.1 says "the original's identity", which the exporter cannot
  compute alone).
- Correction refusal "no such rejected record".
- Templates are session-scoped and must be re-declared on each session before
  retransmission (RFC-003 §3.1 "a template the session accepted").
- `RecordFields.bytes` is signed in Share frames so that P3-S28's "negative byte count" is
  reportable; IPFIX `octetDeltaCount` is unsigned and cannot carry one.
- Provisioning heartbeat cadence 5 s and staleness alert 60 s (est.).
