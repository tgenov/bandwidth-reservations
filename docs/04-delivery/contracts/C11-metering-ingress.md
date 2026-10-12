# C11. Metering ingress: flow-record ingestion, metering hand-off, attribution keys

| | |
|---|---|
| Contract ID | **C11** (`metering-ingress`) |
| Version | 1.0.0-draft.3 (revised per [review 41](../../reviews/41-contract-C11-review.md) and [review 57](../../reviews/57-contract-C11-review.md); see [Review 41 resolution](#review-41-resolution) and [Review 57 resolution](#review-57-resolution)) |
| Status | **Draft**, for contract re-review after review 57. Mismatches M-1 and M-2 are settled by the orchestrator, S-1 as amended after review 41 (see [Settled](#settled)). The RFC errata listed there follow. One joint fix with C09 is open (`RecordId` gains the observation domain and the NetFlow v9 record index; F41-15) |
| Provider (owner) | RFC-003 rating and metering, at revision 5 with erratum 5.1: **metering ingestion** (part I; part II producer), **attribution stage A** (part II and part III consumer; part IV producer), **attribution stage B** (part IV consumer) |
| Producers into it | **Exporters** (external: suppliers' exporters and Share's own, the designated probe exporters included), part I. **Provisioning** (external, Problem 5, out of scope), part III |
| Consumers | Exporters (acknowledgements, part I); attribution stage A (parts II and III); attribution stage B (part IV) |
| Transport | Part I: **HTTP**, an HTTP/2 gRPC bidirectional stream over mutually authenticated TLS to the ingestion edge of either serving region. Part II: **Kafka event**, relayed from the self-outboxed `ingest_log`, the owner's direct publish being the fast path. Part III: **Kafka event**, published by provisioning. Part IV: **Kafka event**, from stage A's transactional outbox. Kafka framing per **C01** §2.5 |
| Depends on | **C08** (exporter credential: the `device_cert` record, its revocation, and the principal context (C08 §A) the edge forwards). **C09** (`put_payload`, `withdraw_payload`, `digest_key` and the `RecordId` type; ingestion consumes them, outside this wire contract). **C01** (Kafka wire format, self-outboxed log, resolved markers, owner runtime). RFC section numbers are given for provenance only |
| Pinned to | `requirements-v1.10`; RFC-000 revision 4.4 (§2 metering components, §4.4 record identity, the §8 rows "Flow-record ingestion protocol", "Metering hand-off" and "Attribution keys from provisioning"); RFC-003 revision 5 + erratum 5.1 (§3.1 to §3.7, §4.1 to §4.5, §5.9, §7, §8); RFC-005 revision 5 (§2.1 exporter row, §8.4, §10); RFC-006 revision 6 (§3.5, §5.2, §5.4) |

## Purpose

Every byte Share bills on usage enters through this contract. It fixes three seams and
one internal hop:

- **Part I, the flow-record ingestion protocol** (RFC-000 §8 row 1; RFC-003 §3.1): what an
  exporter sends, what ingestion acknowledges, and when. Every received record gets exactly
  one durable outcome (accepted, duplicate, rejected with reason) before its batch is
  acknowledged. An acknowledged batch never needs resending. A record's identity is a
  function of the resent bytes and the exporter's stable identity only.
- **Part II, the metering hand-off** (RFC-000 §8 row 2; RFC-003 §3.4, §7): accepted record
  batches, corrections, superseding versions and identity conflicts, per exporter in order,
  from ingestion to attribution stage A, with per-destination resolved markers.
- **Part III, attribution keys from provisioning** (RFC-000 §8 row 3; RFC-003 §4.1): the
  binding feed stage A binds records against, including the **observation point → link
  mapping** (AI3-8), from which stage A also derives which observation domains are the
  exporter's (S-1).
- **Part IV, attributed part batches and forwarded binding facts, stage A → stage B**
  (RFC-003 §4.2 step 5, §4.3; RFC-003 §7 "Attributed parts", internal). This is not an
  RFC-000 §8 row. See the [Scope note](#scope-note).

Out of scope: the drop alert and drop report (RFC-003 §7, alert feed), the stage A
watermark heartbeat to rating (RFC-003 §4.2), the quarantine and breach report feeds, the
evidence query, and the personal-data store and key service calls themselves (C09).

## Units and representations

| Quantity | Unit and representation |
|---|---|
| Flow times | Integer **milliseconds** since the Unix epoch (UTC), field names ending `Ms`. Relative IPFIX and NetFlow times are made absolute by ingestion from the init time in the item's own context (part I, F41-01) |
| Export time | Integer **seconds** since the epoch, as in the IPFIX or NetFlow header (`exportTimeS`) |
| Commit timestamps | The database's hybrid-logical timestamp as a decimal string `"<wall ns>.<logical>"` (`HlcTs`), the form of C01's headers and resolved markers; `acceptedAtMs` is its wall part in ms |
| Minutes | UTC minute starts, half-open `[m, m + 60 000 ms)`, carried as the epoch ms of the minute start (`minuteMs`) |
| Volume | **Bytes**: unsigned 64-bit in IPFIX and NetFlow; a decimal string in schema types (`"2000000000"`). A part's bytes are an **exact fraction** `{ num, den }` of decimal strings, `num` signed, `den` > 0, not necessarily reduced |
| Packets | Decimal string, optional |
| Durations and timeouts | Milliseconds unless the name says seconds |
| Sizes | Bytes; 1 KB = 1 024 B and 1 MB = 1 048 576 B for wire limits |
| Identifiers | Pseudonymous strings: `ExporterId` (C08 `device_cert.exporter`), `AccountId`, `ProductId`, `RouteId` (catalogue route), `ReservationId` (RFC-002), `LinkId` (RFC-001 link registry), `SupplierId`, `CertSerial` (C08) |
| Rate, money | Not carried by this contract |

Every field is required unless marked `?`.

## Schema

All wire messages are **protobuf**. The `.proto` files are generated from the TypeScript
below, which is normative for field names, types and units; field numbers are frozen with
this version. Kafka values are the protobuf message, sealed under the topic's feed key,
with C01 §2.5's clear headers (F41-29).

### Common types

```ts
type ExporterId = string; type AccountId = string; type ProductId = string;
type RouteId = string; type ReservationId = string; type LinkId = string;
type SupplierId = string; type CertSerial = string;
type U64 = string;               // decimal, 0 .. 2^64-1
type I64 = string;               // decimal, signed
type HlcTs = string;             // "<wall ns>.<logical>"
type EpochMs = number;           // integer ms since epoch, UTC
type ExactBytes = { num: I64; den: U64 };

/** Owner of an exporter, from the C08 principal context of the session (F41-24):
 *  device_cert.tenant {kind:"supplier"} -> supplier; {kind:"none"} -> share.
 *  A probe certificate's tenant is the designated probe supplier. A superseding
 *  record's downward amendment is borne by this owner (RFC-003 §3.3). */
type ExporterOwner = { kind: "supplier"; supplierId: SupplierId } | { kind: "share" };

type Direction = "ingress" | "egress";
type ExportFormat = "ipfix" | "netflow-v9";

/** Service tag, "as configured" per binding (RFC-003 §4.1). Equality is member-wise;
 *  an absent member equals only an absent member. */
type ServiceTag = {
  vlan?: { outer: number; inner?: number };   // 802.1Q, or 802.1ad pair
  mplsLabel?: number;                          // top label, 20 bits
  vrf?: string;                                // VRF id or name, as configured
};

/** Observation point: where a count is taken (RFC-003 §4.1). The observation domain is
 *  exporter-local (RFC 7011 §3.1), so it is meaningful only with exporterId. */
type ObservationPoint = {
  exporterId: ExporterId;
  observationDomain: number;   // IPFIX Observation Domain ID / NetFlow v9 Source ID, uint32
  ifIndex: number;             // uint32
  direction: Direction;
};

/** Record identity (RFC-003 §3.2, per format; F41-02). The epoch is ingestion's
 *  number for the init time found in the item's context, per (exporter, domain). */
type RecordIdentity =
  | { format: "ipfix"; exporterId: ExporterId; observationDomain: number;
      epoch: number; extSeq: U64 }                 // k*2^32 + q + i
  | { format: "netflow-v9"; exporterId: ExporterId; observationDomain: number;
      epoch: number; packetExtSeq: U64; index: number };   // k*2^32 + q, record index i

/** Raw reference of a received record (F41-05): the batch entry, the message's position
 *  in the entry, and the record's position in the message; record = -1 is the whole
 *  message or an unparseable remainder. */
type RawRef = { exporterId: ExporterId; logSeq: U64; message: number; record: number };

/** Stable reject key (F57-03, D57-6). It is a function of the received item only, so a
 *  resend of the same item gives the same key. Corrections are deduplicated by it.
 *  RawRef is for evidence only. */
type RejectKey =
  | { kind: "positioned";
      exporterId: ExporterId;
      observationDomain: number;         // from the parsed header
      epoch: number | null;              // null when the item had no usable init time ("no epoch")
      messageSeq: U64;                   // k*2^32 + q when epoch is known; q when epoch is null
      exportTimeS: number;               // of the message
      set: number;                       // position of the set in the message
      record: number;                        // position of the record in the set; -1 = remainder from byteOffset
      byteOffset: number }               // offset of the record or remainder in the message
  | { kind: "digest";                    // the message header did not parse
      exporterId: ExporterId;
      keyedDigest: string };             // hex HMAC-SHA-256 of the message under the exporter's digest key

/** Every identity this contract carries. */
type DerivedIdentity =
  | { kind: "record"; id: RecordIdentity }
  | { kind: "correction"; rejectKey: RejectKey; sub: number }   // sub = position in Correction.records
  | { kind: "version"; original: DerivedIdentity; v: number }   // original of kind record or correction
  | { kind: "conflict"; identity: RecordIdentity; conflictingRawRef: RawRef };   // F41-10

/** Decoded contents of a record in the Share metering template. */
type RecordFields = {
  observationDomain: number;
  ifIndex: number;
  direction: Direction;
  serviceTag: ServiceTag;
  flowStartMs: EpochMs;
  flowEndMs: EpochMs;
  bytes: I64;                  // signed only so that a negative count in a Share frame can be rejected
  packets?: U64;
};

/** C09's RecordId, carried verbatim (F41-15). Joint fix pending in C09: the identity ref
 *  gains observation_domain and, for NetFlow v9, index. Mapping from C11:
 *    exporter            = exporterId
 *    ref identity        = { exporter_epoch: epoch, sequence: extSeq | packetExtSeq,
 *                            observation_domain, index? }
 *    ref raw             = { partition: exporterId, log_seq: logSeq,
 *                            index: the payload's ordinal among the entry's non-conforming payloads }
 *    digest              = { key_version, hmac_sha256 }  */
type RecordId = C09.RecordId;
```

### Part I. Flow-record ingestion protocol (exporter ↔ ingestion edge)

gRPC service `share.metering.v1.Ingest`, method
`Session(stream ExporterFrame) returns (stream EdgeFrame)`, HTTP/2 over mutual TLS to the
ingestion edge of R1 or R2. The client certificate is a **C08 `device_cert`**.

```ts
// ---------- exporter -> edge ----------
type ExporterFrame = { hello: Hello } | { batch: Batch };

type Hello = {
  protocolVersion: 1;
  exportFormat: ExportFormat;  // fixed per exporter ID (D57-5); a different value is refused
  softwareId?: string;         // ≤ 64 printable ASCII characters; diagnostics only, never logged with records
};

/** At most maxBatchBytes; batchNo is sender-chosen, correlation only. */
type Batch = { batchNo: U64; items: BatchItem[] };

type BatchItem =
  | { exportMessage: ExportItem }
  | { correction: Correction }
  | { supersession: Supersession };

/** Self-describing export item (F41-01). `message` is one IPFIX message or NetFlow v9
 *  packet, VERBATIM, header included. `context` is the exact template sets, options
 *  template sets and options records (the IPFIX init time, IE 160) in force when the
 *  message was FIRST exported, as IPFIX or v9 messages concatenated, kept by the
 *  exporter with the message and resent byte-identical with it. */
type ExportItem = { message: Uint8Array; context: Uint8Array };

/** Corrects a REJECTED record (or a whole unparseable message or remainder) of this
 *  exporter (RFC-003 §3.3, P3-S30; D41-4). */
type Correction = {
  corrects: RejectKey;         // as returned in the rejection's acknowledgement (F57-03)
  records: RecordFields[];     // exactly 1 for a single record; 1 or more for a remainder or a whole message
};

/** Supersedes an ACCEPTED record or accepted correction of this exporter
 *  (RFC-003 §3.3, P3-S66, P3-S72; F41-06). */
type Supersession = {
  original: OriginalRef;
  v: number;                   // ≥ 1, increasing per original
  record: RecordFields;        // may differ from the original only in measured fields
};

/** How an exporter names an original: Share's identity (from an acknowledgement, the
 *  hand-off or evidence) or the exporter-side coordinates, which ingestion resolves by
 *  RFC-003 §3.2 using the MESSAGE's sequence number (F41-17). */
type OriginalRef =
  | { identity: DerivedIdentity }            // kind "record" or "correction"
  | { coordinates: {
        observationDomain: number;
        systemInitTimeMs: EpochMs;           // from the original's context (IPFIX) or header (v9)
        exportTimeS: number;                 // of the original message
        messageSequence: number;             // uint32 header sequence q of the original message
        recordIndex: number;                 // i, the record's position in that message
      } };

// ---------- edge -> exporter ----------
type EdgeFrame = { welcome: Welcome } | { credit: Credit } | { ack: BatchAck } | { notice: SessionNotice };

type Welcome = {
  protocolVersion: 1;
  exporterId: ExporterId;      // device_cert.exporter
  owner: ExporterOwner;
  certSerial: CertSerial;
  sessionId: string;
  region: "R1" | "R2";
  maxBatchBytes: number;       // 1 048 576 (est.)
  ingestRetryTimeoutMs: number;// 2 000 (est.)
  serverTimeMs: EpochMs;       // informative
};

/** Credit (D41-5): the window of UNACKNOWLEDGED batches and bytes on this session.
 *  Each frame states the window size now; it is not cumulative. */
type Credit = { windowBatches: number; windowBytes: number };   // 4 batches, 4 MB (est.)

type BatchAck = {
  batchNo: U64;
  committedAt: { commitTs: HlcTs; acceptedAtMs: EpochMs };
  items: ItemAck[];            // one per BatchItem, same order
};

type ItemAck =
  | { message: MessageAck }
  | { correction: { outcome: "accepted" | "duplicate" | "refused";
                    identities: DerivedIdentity[]; reason?: DerivedRefusal | RejectReason } }
  | { supersession: { outcome: "accepted" | "duplicate" | "refused";
                      identity: DerivedIdentity; reason?: DerivedRefusal | RejectReason } };

type MessageAck = {
  accepted: number;
  duplicates: number;
  acceptedIdentities: RecordIdentity[];      // identities of the accepted records, in message order (usable in OriginalRef.identity)
  rejected: RejectedRecord[];
  templateRefusals: TemplateRefusal[];
};

type RejectedRecord = {
  rejectKey: RejectKey;        // what a Correction names (stable across resends)
  rawRef: RawRef;              // evidence only
  identity?: RecordIdentity;
  reason: RejectReason;
};

/** Reasons and the display string each is recorded and reported with (F41-16). */
type RejectReason =
  | "no exporter"              // "no exporter": header without an observation domain; unreachable for well-formed IPFIX/v9 headers (S-1)
  | "no template"              // "does not conform to the record template" (P3-S71)
  | "no sequence number"       // "no sequence number": unreachable for IPFIX/v9 (RQ41-1)
  | "no epoch"                 // "no epoch": the item's context has no usable init time (IPFIX)
  | "negative byte count"      // "a negative byte count": Share frames only
  | "end time before its start time"  // "an end time before its start time"
  | "missing flow times"       // "missing flow times"
  | "flow time in the future"  // "flow time in the future"
  | "missing attribution key"  // "missing attribution key" (F41-09)
  | "missing byte count"       // "missing byte count" (F41-09)
  | "unparseable";             // "unparseable"

type TemplateRefusal = { templateId: number; observationDomain: number; reason: string };

type DerivedRefusal =
  | "not this exporter's record"
  | "no such rejected record"            // correction
  | "no such accepted record"            // supersession
  | "outside dispute_window"             // supersession, and correction (D41-1)
  | "version out of order"
  | "changes an attribution key"
  | "outside the original's minutes"
  | "outside the original's receipt";    // correction: a flow end after the rejected item's receipt + future_skew_max (F57-05)

type SessionNotice = {
  kind: "credential-revoked" | "draining" | "protocol-error" | "waiting";
  detail?: "digest key" | string;        // never payload content
};
```

**The Share metering template** (the glossary's *record template*). A template, in the
context or in the message, is accepted only if every field it declares is in this list.
Any other field (an address, a port, a subscriber identifier, any enterprise element not
listed) makes the whole template refused, reported in `templateRefusals`.

| Field | IPFIX element (id) | NetFlow v9 field (type) | Role and normative rule (F41-09) |
|---|---|---|---|
| Flow start | `flowStartMilliseconds` (152) or `flowStartSysUpTime` (22) | `FIRST_SWITCHED` (22) | Measured. Neither present: "missing flow times" |
| Flow end | `flowEndMilliseconds` (153) or `flowEndSysUpTime` (21) | `LAST_SWITCHED` (21) | Measured |
| Octets | `octetDeltaCount` (1) or `postOctetDeltaCount` (23) | `IN_BYTES` (1) or `OUT_BYTES` (23) | Measured. A template declaring **both** is refused ("ambiguous byte count"). A record without one: "missing byte count" |
| Packets | `packetDeltaCount` (2) or `postPacketDeltaCount` (24) | `IN_PKTS` (2) or `OUT_PKTS` (24) | Measured, optional; both declared: refused |
| Interface | `ingressInterface` (10), `egressInterface` (14) | `INPUT_SNMP` (10), `OUTPUT_SNMP` (14) | Attribution key. `ifIndex` = 10 when the direction is ingress, 14 when egress; the one needed absent: "missing attribution key" |
| Direction | `flowDirection` (61) | `DIRECTION` (61) | Attribution key. `direction` = 61 when present (0 ingress, 1 egress); else ingress when only 10 is present, egress when only 14 is present; else "missing attribution key". **When 10 and 14 are both present and 61 is absent, the record is rejected "missing attribution key".** This is the usual case for routers. A relay that re-encodes must add `flowDirection` (F57-16, D57-2) |
| VLAN | `vlanId` (58), `dot1qVlanId` (243), `dot1qCustomerVlanId` (245) | `SRC_VLAN` (58) | Attribution key (service tag) |
| MPLS | `mplsTopLabelStackSection` (70) | `MPLS_LABEL_1` (70) | Attribution key (service tag) |
| VRF | `ingressVRFID` (234) or `VRFname` (236) | `INGRESS_VRFID` (234) | Attribution key (service tag) |
| System init time | `systemInitTimeMilliseconds` (160) in an options record of the **context**, under the options-template rule below | From the packet header: `unix_secs × 1000 − sysUpTime` | Epoch (RFC-003 §3.2), chosen by the epoch rule of part I Semantics. IPFIX: no applicable init time in the context: "no epoch" |

The observation domain (IPFIX header Observation Domain ID; NetFlow v9 Source ID) is an
attribution key and part of the identity.

**Options templates** (F57-07). The template-list rule above applies to data templates
only. For options templates and options records, these rules apply:

- An options template is **applicable for the epoch** when its scope is
  `observationDomainId` (149) with the message's observation domain, or
  `exportingProcessId` (144), and it contains `systemInitTimeMilliseconds` (160).
- Ingestion reads IE 160 from the options records of applicable templates. Ingestion
  ignores all other options fields. Ingestion does not log them: it cuts them out of the
  logged context (see "Context logging").
- An options template that is not applicable is ignored. It is not a template refusal.
- A context must give **exactly one** init-time value for the message's domain. Equal
  values in more than one record count as one value. Zero values, or two or more different
  values, give "no epoch".
- A relay can send a minimal options template (scope 149 or 144, and IE 160). This is
  recommended.

### Part II. Metering hand-off (ingestion → attribution stage A)

**Topic** `ingestion.handoff.v1` (C01 §2.5 naming; RFC-006 §5.4's name, F41-14). **Key**:
the producing partition, `exporterId`. **Headers** (C01 §2.5): `partition` = exporterId,
`stream` = `"handoff"`, **`stream_seq` = `handoffSeq`**, **`ts` = `commitTs`**,
`generation`, `epoch`, `kind` = `body.kind`, `schema_v` = `"1"`. **Retention** 3 days
(RFC-006 §5.2). **No event carries any part of a non-conforming payload.**

```ts
type HandoffEvent = {
  schemaVersion: 1;
  exporterId: ExporterId;
  handoffSeq: U64;             // contiguous per exporter over the hand-off stream; = header stream_seq
  logSeq: U64;                 // the ingest_log entry's sequence in the exporter partition
  commitTs: HlcTs;             // = header ts; the acceptance time
  acceptedAtMs: EpochMs;
  owner: ExporterOwner;
  certSerial: CertSerial;      // the session's certificate (F41-24)
  body: BatchBody | CorrectionBody | SupersessionBody | IdentityConflictBody;
};

type BatchBody = {
  kind: "batch";
  session: { sessionId: string; region: "R1" | "R2"; certSerial: CertSerial };
  format: ExportFormat;
  contexts: LoggedContext[];           // F57-08
  accepted: AcceptedRecord[];          // the only records of the batch stage A applies
  duplicates: { identity: RecordIdentity; digest64: string }[];   // hex 64-bit content digest
  rejected: {
    rawRef: RawRef;
    identity?: RecordIdentity;
    reason: RejectReason;
    nonConforming?: {                  // only for "no template" and "unparseable"
      recordId: RecordId;              // C09 type (keyed digest and key version inside)
      keep:
        | { outcome: "kept"; bucket: { exporter: ExporterId; hour: string } }
        | { outcome: "dropped: cap"; cap: C09.CapName; payloadBytes: number }
        | { outcome: "dropped: not taken in time" }               // C09 not_kept(late)
        | { outcome: "dropped: erased" }                          // C09 not_kept(erased)
        | { outcome: "dropped: unanswered, withdrawal pending"; answer?: "unavailable" | "refused" | "none" };
    };
  }[];
};

type AcceptedRecord = {
  identity: RecordIdentity;
  rawRef: RawRef;
  fields: RecordFields;                // decoded from (context, message) only; times absolute
  exportTimeS: number;
};

type CorrectionBody = {
  kind: "correction";
  outcome: "accepted" | "duplicate" | "refused";
  corrects: RejectKey;                 // the stable key (F57-03)
  correctedRawRef: RawRef;             // evidence: the rejected item's raw reference
  records: { identity: DerivedIdentity; fields: RecordFields }[];
  reason?: DerivedRefusal | RejectReason;
};

type SupersessionBody = {
  kind: "supersession";
  outcome: "accepted" | "duplicate" | "refused";
  original: { identity: DerivedIdentity; rawRef: RawRef };   // kind record or correction (F41-06)
  v: number;
  identity: DerivedIdentity;           // { kind: "version", original, v }
  fields: RecordFields;
  reason?: DerivedRefusal | RejectReason;
};

/** S-2: an identity conflict is on the hand-off, with its own identity (F41-10). */
type IdentityConflictBody = {
  kind: "identity-conflict";
  identity: DerivedIdentity;           // { kind: "conflict", identity, conflictingRawRef }
  originalDigest64: string;
  conflictingDigest64: string;
  conflicting: { rawRef: RawRef; fields: RecordFields };
};

/** BatchBody.contexts (F57-08): the contexts the batch's items used, each logged once per
 *  partition. An item refers to its context by contextHash. */
type LoggedContext = {
  contextHash: string;                 // hex SHA-256 of the context bytes as received
  firstLoggedIn?: U64;                 // logSeq of the entry that holds the context; absent here when this entry holds it
  context?: Uint8Array;                // the CUT context (see "Context logging"), present only in the first entry
};
```

Closure markers on this topic are C01's `ResolvedMarker` in its header form (`resolved`
header, `kind` = `"resolved"`), published per destination partition by the closure
emitter (F41-23).

### Part III. Attribution keys from provisioning (provisioning → stage A)

**Topic** `provisioning.bindings.v1`. **Key** `exporterId` (every fact concerns observation
points of one exporter). **Never compacted**; time retention ≥ 7 days. **Producer ACL**
(F41-13): only provisioning's workload identity (C08 `internal_service`, mTLS) may
produce to `provisioning.*`; only attribution stage A may consume it. Headers per C01
§2.5, `stream` = `"bindings"`, `stream_seq` = `bindingSeq`.

```ts
type ProvisioningEvent = {
  schemaVersion: 1;
  exporterId: ExporterId;      // = key; every op.exporterId in the fact must equal it
  bindingSeq: U64;             // contiguous per exporter: THE binding position
  recordedAtMs: EpochMs;       // transaction time (bitemporal)
  fact: ObservationPointFact | BindingFact | CorrectionFact | Heartbeat;
};

/** Feed-wide heartbeat (F57-10). Provisioning sends it on EVERY Kafka partition of the
 *  topic, with an explicit partition number. It covers every exporter that hashes to the
 *  partition and has no fact yet. */
type PartitionHeartbeatEvent = {
  schemaVersion: 1;
  kind: "partition-heartbeat";
  partition: number;            // the Kafka partition the event is on
  partitionSeq: U64;            // contiguous per Kafka partition
  recordedAtMs: EpochMs;
  coversThroughMs: EpochMs;     // same meaning and same lead limit as Heartbeat
};

/** Observation point -> link mapping (AI3-8). Also registers op.observationDomain as a
 *  domain of op.exporterId while in force (S-1 as amended). */
type ObservationPointFact = {
  kind: "observation-point";
  factId: string;              // F41-20
  op: ObservationPoint;
  linkId: LinkId | null;       // null: on no Share link (the domain is still the exporter's)
  validFromMs: EpochMs;
  validToMs: EpochMs | null;   // half-open
};

type BindingFact = {
  kind: "binding";
  factId: string;
  bindingId: string;           // stable across versions of one binding; unique per exporter (F57-14)
  key: { op: ObservationPoint; serviceTag: ServiceTag };
  validFromMs: EpochMs;
  validToMs: EpochMs | null;   // half-open; the binding ends at validToMs. A later version or a CorrectionFact can change it
  accountId: AccountId;
  productId: ProductId;
  routeId: RouteId;
  reservationId: ReservationId | null;   // null: attachment without a reservation, or best-effort
  egress: boolean;             // this op is where traffic on this binding, in op.direction, leaves the route
  egressGroup?: string;        // F57-12: egress points that carry disjoint parts of one flow (LAG members) share a group; the group counts as ONE egress point
};

/** A fact found wrong, superseded as of recordedAtMs (never a delete). */
type CorrectionFact = {
  kind: "correction";
  supersedesFactId: string;
  replacement: BindingFact | ObservationPointFact | null;   // null: retracted
};

/** Completeness assertion, NOT a fact (F41-21, F57-13). Every fact RECORDED with a valid
 *  time <= coversThroughMs for this exporter's observation points has a bindingSeq <=
 *  this event's. CorrectionFacts are the exception: they change later decisions only
 *  (P3-N9). The heartbeat advances the position. It is never written to attr_a_log.
 *  Coverage ahead is allowed (F57-01, D57-1): coversThroughMs <= recordedAtMs +
 *  binding_lead (60 s, est.). */
type Heartbeat = { kind: "heartbeat"; coversThroughMs: EpochMs };
```

**Persistence and position** (F41-03, F57-10). Stage A writes every consumed fact (not
heartbeats) to `attr_a_log` and keeps the history 7 years (RFC-003 §4.1). A new or
rebuilt stage A instance restores its binding state from `attr_a_log` and resumes the
topic from the recorded `bindingSeq`, so topic retention never limits its state. Stage A
alerts when its consumer lag on this topic exceeds 1 day, well inside the 7-day retention.
Every `processed` entry and every part records the binding position used. For an
exporter with no fact, the position is (partition, `partitionSeq`).

**Tenancy invariants** (F41-13), obligations on provisioning, checked by consumers:

| # | Invariant | Checked by | On violation |
|---|---|---|---|
| T1 | Every `op.exporterId` in a fact equals the event's `exporterId` (key) | Stage A | Fact refused (not applied), recorded, provisioning alerted; stage A stops the exporter's binding consumption |
| T2 | `reservationId` belongs to `accountId`, and the reservation's route and product equal the binding's `routeId` and `productId` | Rating, for each reservation-class part, against the reservation lifecycle feed (C04) | The part's line is held, provisioning and finance alerted; the part is **never charged to another account**; released when a corrected binding re-attributes it or finance decides |
| T3 | A probe account is bound only at probe observation points (probe exporters, or links of the probe supplier), and no other account is bound at them (POL-06) | Stage A, from the catalogue's probe designations | Parts held as unattributable (pending hold, then quarantine), alerted |
| T4 | At any valid time, at most one egress **observation point** (or one `egressGroup`) per (accountId, productId, routeId, reservationId, direction). More than one binding at one point is allowed (F41-12, F57-12) | Stage B, from forwarded binding facts (part IV) | See "T4 hold and resolution" below (D57-4) |

**T4 hold and resolution** (F57-12, D57-4). A T4 violation exists when two or more egress
points (each not in one `egressGroup`) are valid for one (account, product, route,
reservation, direction) at the same time.

1. While the violation exists, stage B appends the parts of the affected bindings marked
   **held (T4)** and alerts provisioning. Rating counts held parts in the account's
   unposted usage (RFC-003 §5.9), so headroom sees them. Rating emits no charge line for
   them.
2. A later fact resolves the violation when it leaves one egress point. Then:
   - parts of a binding that a `CorrectionFact` retracted, or ended before the part's
     minute, are **dropped** (never charged);
   - parts of the surviving binding are released and charged.
3. If a part is still held at its minute's end + `dispute_window`, stage B drops it, and
   finance is alerted.

Held and dropped parts leave unposted usage when they are released or dropped.

### Part IV. Attributed part batches (stage A → stage B; RFC-003 internal)

**Topic** `attribution.parts.v1`. **Key** `accountId`, an exception to C01 §2.5's
"producing partition" rule for stage B locality (errata, F41-14). Written as stage A
outbox rows in the same transaction as the `processed` entry. Headers per C01 §2.5;
`stream_seq` is not used (the per-destination `destSeq` is the sequence).

```ts
type PartBatch = {
  schemaVersion: 1;
  feedId: { stageAPartition: ExporterId; ownerEpoch: number; logSeq: U64; accountId: AccountId };
  destSeq: U64;                // contiguous per (stageAPartition, accountId)
  commitTs: HlcTs;             // of the processed entry
  parts: Part[];
  bindingFacts: ForwardedBinding[];   // every binding fact of this account consumed in the entry (may be the only content)
};

/** Per-binding forwarding (F41-11, F41-12, F57-14). Stage B keys bindings by
 *  (exporterId, bindingId). A product is in the attachment set for a minute when at least
 *  one of its bindings is valid in that minute (valid time, not stage B's clock). Stage B
 *  checks T4. A CorrectionFact that moves a binding to another account is forwarded to
 *  the old account (retracted: true) and to the new account. */
type ForwardedBinding = {
  exporterId: ExporterId;
  bindingSeq: U64;
  bindingId: string;
  retracted: boolean;          // a CorrectionFact with replacement null
  productId: ProductId; routeId: RouteId; reservationId: ReservationId | null;
  direction: Direction; egress: boolean; egressGroup?: string;
  op: ObservationPoint;
  validFromMs: EpochMs; validToMs: EpochMs | null;
};

type Part = {
  recordIdentity: DerivedIdentity;     // F41-18
  bindingPosition: U64;        // per part (F41-22): β for negated parts of a superseded version
  acceptedAtMs: EpochMs;
  lastMinuteEndMs: EpochMs;    // end of the last minute the record was active in (lateness)
  minuteMs: EpochMs;
  bytes: ExactBytes;           // signed: negated parts for supersession and reversal
  class: "reservation" | "attachment" | "best-effort";
  accountId: AccountId;
  productId: ProductId;
  routeId: RouteId;
  reservationId: ReservationId | null;
  op: ObservationPoint;
  linkId: LinkId | null;       // null: no observation-point -> link mapping (D41-6)
  reason?: "superseding record" | "quarantine attribution" | "attribution reversed";
  cause?: ExporterOwner;       // "superseding record": the exporter's owner; "attribution reversed": share
  sourceRef?: string;          // finance attribution's source reference (POL-29)
  reversedSourceRef?: string;  // "attribution reversed": the attribution's reference
};
```

## Semantics per operation and message

### Part I

**Session open** (F41-24). The edge accepts the TLS session only with a valid, active C08
`device_cert` whose `principal_kind` is `exporter` or `probe` **and** whose `exporter` is
set; a `network_operations` certificate, or one with no exporter, is refused and nothing is
created.

**Export format per exporter** (F57-06, D57-5). The partition records the export format of
the first session of the exporter ID. A `Hello` with a different `exportFormat` is refused
with `notice{protocol-error, "export format"}`, and the stream closes. To change the
format, the supplier administrator (or network operations) gets a new exporter ID through
C08. Thus one range set never holds both packet and record sequences.

The edge forwards the C08 principal context (C08 §A) with every batch; the owner is
mapped from its tenant as in `ExporterOwner`. After `Hello` the edge sends `Welcome` and a
`Credit`. The edge checks the certificate serial against its replica on every frame; on
revocation it sends `notice{credential-revoked}` and closes the stream within 31 s
(X1-S41, owned by C08). **The edge accepts no batch that it receives after it applied the
revocation. It applies the revocation at most 31 s after it (inside X1-S41's 60 s)**
(F57-17). A
resend under another valid certificate of the same exporter ID (a rotation) is accepted
or deduplicated by identity** (F41-25). The certificate serial is recorded in every
`batch`, `correction` and `supersession` entry, for audit.

**Identity and decoding come from the item alone** (F41-01). For each `ExportItem`,
ingestion decodes the message using only the templates and options found in `context`,
then in `message` itself, in that order; templates declared on earlier items or sessions
are a cache and are **never** used to decode or identify a retransmission. The epoch is
taken from the init time in `context` (IPFIX) or the packet header (NetFlow v9). The
identity is then a function of (`exporterId` from the certificate, `context`, `message`):

- **IPFIX**: `(exporter, domain, epoch, k × 2³² + q + i)`, q the message's sequence number,
  i the record's position among the message's data records, k by RFC-003 §3.2's wrap
  rules applied to q and the export time.
- **NetFlow v9** (F41-02, D41-3): the header sequence counts packets (RFC 3954 §5.1), so the
  identity is `(exporter, domain, epoch, packetExtSeq = k × 2³² + q, index i)`. The range
  set is kept over **packet** sequences: a packet is retransmitted whole and verbatim. A
  packet is added when its batch commits; each of its records rejected with an identity
  is kept in the partition's **rejected-record exception set** `(packetExtSeq, i)`. A
  record is a duplicate when its packet is in the range set and `(packetExtSeq, i)` is not
  in the exception set; otherwise it is validated (and, once accepted, removed from the
  exception set).

A message whose context has no applicable init time (IPFIX) is rejected "no epoch"; a
data set whose template is neither in the context nor in the message, or was refused, is
rejected "no template". The exporter keeps each message with the context in force when it
first exported it and resends both byte-identical.

**Epoch rule** (F57-02). The derived init time drifts. NetFlow v9 derives it from
`unix_secs` (NTP-steered) and `sysUpTime` (free-running). Some IPFIX exporters recompute
IE 160. Thus two epochs can have init times less than 2 × `epoch_jitter` apart. The rule
is:

1. A message takes the **lowest-numbered** epoch of its (exporter, domain) whose init time
   is within `epoch_jitter` (2 s) of the message's init time.
2. If there is no such epoch, the message opens a new epoch with the next number.
3. Ingestion never removes an epoch and never changes the init time of an epoch.

Thus a later epoch cannot capture a message that an earlier epoch already holds. The same
rule resolves `OriginalRef.coordinates.systemInitTimeMs`.

**Epoch sizing with drift** (est.). With a drift of 20 to 50 ppm, a domain can open about
one epoch a day. This is about 2,555 epochs per domain in 7 years, not 50 (RFC-003 §3.5).
With 4 × 10⁴ domains this is about 10⁸ epoch sets. At 32 B minimum per set, this is more
than 3.2 GB of range sets in all, about 25 MB per slot (128 slots), against RFC-003 §3.5's
640 MB and 5 MB. An old epoch set is closed and compacts to a few intervals. The owner
keeps in memory only the sets of epochs with an acceptance in the last 24 h. It reads
older sets from the database (one read per message, as in RFC-003 §3.5's safeguard). The
RFC-003 §3.5 sizing erratum is listed in Settled (AI-57-2).

**Context logging** (F57-08). Evidence (P3-S39), a re-derivation under a new emit
function and a recomputation (P3-N9) must decode from the context. Thus ingestion logs
the context:

- Ingestion cuts the context before it logs it. It keeps the data templates and the
  refused templates' declarations (field IDs only). It keeps the applicable options
  templates and, from their records, the scope and IE 160 only. It cuts all other options
  fields and every record under a refused template. A cut part is logged as its keyed
  digest and the reason only, as for a non-conforming set.
- Ingestion logs each cut context **once per partition**, keyed by the SHA-256 of the
  context as received, in a context table written in the same transaction as the `batch`
  entry. The `batch` entry refers to it by hash (`BatchBody.contexts`).
- Overhead (est.): on the wire a context is about 200 to 250 B for an item of about
  1,400 B, which is 15 to 18% more ingest bytes. In the log the context table is small:
  an exporter has few distinct contexts (a new one per template change or reboot), so
  logged bytes increase by less than 0.1% (est.).

**Context check memo** (F57-09). A relay can lose its stored contexts and rebuild them
from the router's current options. Then a resend has a different init time. To find this,
the owner keeps a **24 h memo**, beside the digest cache:

- Key: (exporter, domain, `exportTimeS`, q, 64-bit content digest of `message`).
- Value: the epoch the message took, or "no epoch".
- A message whose key is in the memo with another epoch takes the epoch in the memo. Its
  records are then duplicates, or are validated in that epoch. The owner alerts a
  **context violation** to network operations.
- The digest is the 64-bit content digest of RFC-003 §3.5, not a keyed digest, so a
  conforming batch never waits for the key service.
- Size (est.): about 30,000 messages/s at peak × about 40 B is about 100 GB a day in all,
  less than 1 GB per slot, on the owner's local disk.

**A rejection is fixed only by a `Correction`** (F57-19). A record rejected "no epoch" has
a positioned reject key with `epoch: null`. If a correction of that key is accepted,
ingestion treats a later copy of the record, in any context, as a duplicate. Ingestion
checks this from the corrected-key index, which is permanent. The memo is not needed for
this check.

**Batch** (preconditions: credit; size ≤ `maxBatchBytes`). Each record is validated
(RFC-003 §3.3) with exactly one outcome, recorded in the same `batch` entry before the
acknowledgement:

| Outcome | Condition |
|---|---|
| Accepted | Valid; identity not already accepted (and, for a record with a positioned reject key, no accepted correction of that key). Identity added; flows to part II |
| Duplicate | Valid; identity already accepted. Counted; a compact duplicate (identity, acceptance time, 64-bit digest) kept; nothing flows on |
| Rejected | One `RejectReason` (display strings in the type). `no exporter` only when the header carries no observation domain (S-1); every domain present is accounted to the session's exporter, and stage A judges whether it is that exporter's. `flow time in the future`: end > owner clock + `future_skew_max`. Kept with its reason; identity not added; nothing charged |

A rejected record never delays those after it (P3-S29). A zero-byte record is accepted.
**Non-conforming payloads** (`no template`, `unparseable`): the log, the acknowledgement and
the hand-off hold only the `RecordId` (identity or raw reference, keyed digest and key
version), the reason and the keep outcome, never the payload. The payload is put to the
store by C09 `put_payload`; keeping it is not required (P3-S71, P3-S75). C09 answers map
to keep outcomes as follows (F41-15): `kept` → "kept" with the bucket; `not_kept(cap)` →
"dropped: cap" with the cap name; `not_kept(late)` → "dropped: not taken in time";
`not_kept(erased)` → "dropped: erased"; `temporarily_unavailable`, `refused`, or no answer
by `keep_by` + ε → "dropped: unanswered, withdrawal pending", then `withdraw_payload`
until answered (a `refused` is also alerted as a defect). The message is logged with the
non-conforming sets cut out.

**Acknowledgement.** `BatchAck` only after the transaction holding the batch has
committed, durable in two regions (X2-S14). An acknowledged batch never needs resending;
all outcomes are durable. Each rejected record's `rejectKey` and `rawRef` are returned. **There is no
negative acknowledgement.** A batch is acknowledged only after commit; **an
unacknowledged batch is the exporter's to resend** (F41-08).

**Flow control** (D41-5). Credit is a window of unacknowledged batches and bytes on the
session. A batch's credit returns at its `BatchAck`, or `ingestRetryTimeoutMs` after it was
sent if it is not acknowledged by then; at that moment the edge **forgets** the batch, and
the exporter's resend consumes fresh credit. So an exporter can always retransmit, and the
edge holds at most one window per session. A batch committed after the edge forgot it is
deduplicated when resent. The window is 4 batches and 4 MB (est.). With 10⁴ sessions this
is at most about 40 GB of edge memory over both regions (est.).

**No acknowledgement while a digest key is unavailable** (RFC-003 §3.3 step 1, review 29
W-1). If a batch holds a non-conforming payload, and ingestion has no digest-key version
cached for the exporter and C09 `digest_key` fails, the batch is neither committed nor
acknowledged; the exporter's later batches queue behind it in the partition and are not
acknowledged either; other exporters are unaffected. The edge sends
`notice{waiting, "digest key"}`; the exporter keeps resending after
`ingestRetryTimeoutMs`; ingestion alerts and resumes at the first successful fetch.

**Bound on the pending queue** (F57-11). During the wait the owner keeps **one** pending
batch for the partition: the head batch. The owner drops all later batches of the
partition, and all copies of the head batch, without an acknowledgement. This is safe,
because an unacknowledged batch is the exporter's to resend. The edge answers each new
batch of a waiting partition at once with `notice{waiting, "digest key"}` and does not
forward it. Thus the memory for a waiting partition is at most one batch (1 MB).

**Exporter buffering** (F41-27). An exporter (or relay) keeps every unacknowledged message
with its context, and buffers new ones, for at least **1 h at its peak export rate**
(est.), so a digest-key wait, a region loss or a takeover never loses traffic.

**Batches holding a non-conforming payload** are acknowledged once every put is answered
or `pd_put_timeout` (500 ms, est.) has passed.

**Correction** (`Correction`; P3-S30, D41-1, D41-4, D57-3, D57-6). Ingestion does these
steps in this order:

1. `corrects.exporterId` must be the session's exporter. If not, the answer is `refused`
   "not this exporter's record", and ingestion records a refused attempt.
2. **Idempotency first** (F57-20). If a correction of the same reject key is already
   accepted, the answer is `duplicate` (first accepted wins). Ingestion does this check
   before all other checks. Thus a retry after the deadline gets `duplicate`, not
   `refused`.
3. `corrects` must name a rejection of the partition. If not, the answer is `refused` "no
   such rejected record". `records` has exactly one element for a single record, and one
   or more for a remainder or a whole message.
4. **Deadline from the original** (F57-05, D57-3). The commit timestamp must be before the
   rejected record's last minute end + `dispute_window`. If the rejected record had no
   usable times, use the commit timestamp of its `batch` entry (its receipt) instead of
   the last minute end. If not, the answer is `refused` "outside dispute_window".
5. Each corrected record must have `flowEndMs` ≤ the rejected item's receipt +
   `future_skew_max`. If not, the answer is `refused` "outside the original's receipt".
6. **Domain** (F41-26, F57-19). When the rejected item's header parsed, each record's
   `observationDomain` must equal the header's domain. If not, the answer is `refused`
   "changes an attribution key".
7. Ingestion validates each record like any record. A failure refuses the whole
   correction with that reason.
8. If a single record keeps an identity I that is already accepted, the answer is
   `duplicate`.

**Only an accepted correction marks the reject key corrected.** A refused correction
does not, so the exporter can send a new one.

Identities: a single record that had an identity I keeps it (`{kind:"record"}`).
Otherwise each record i gets `{kind:"correction", rejectKey, sub: i}`. The whole correction
is charged once, however often it is sent.

**An accepted correction marks its identity accepted** (F57-04). In the same transaction:

- IPFIX: ingestion adds I to the range set.
- NetFlow v9: ingestion removes (packetExtSeq, i) from the exception set.

Thus a later copy of the original message gives a duplicate. The duplicate content check
compares that copy with the **correction's** digest. A difference is expected (the
correction changed the fields). Ingestion records it as an informative duplicate, not as
an identity conflict.

**Exception set** (F57-15). Ingestion writes the v9 exception-set rows in the same
transaction as the `batch` entry, as for the range-set chunks. A set of more than 10⁶
entries for one exporter is alerted, and the owner keeps only recent chunks in memory
(the RFC-003 §3.5 safeguard).

**Supersession** (`Supersession`). **Idempotency first** (F57-20): if `(original, v)` is
already accepted with the same digest, the answer is `duplicate` before all other checks.
Then ingestion validates the record like any record. Then it does each check against the
**original** (a record or an accepted correction, F41-06), never against an earlier
version:

| Check | Outcome on failure |
|---|---|
| Original is this exporter's | `refused` "not this exporter's record" |
| Original accepted in this partition (coordinates resolved with `messageSequence` by §3.2, then `recordIndex`) | `refused` "no such accepted record" |
| Commit timestamp before the original's last minute end + `dispute_window` | `refused` "outside dispute_window"; the original stands (P3-S66) |
| `v` above every accepted version of the original | `refused` "version out of order" (a same-digest repeat was already answered `duplicate`) |
| Every non-measured field equal to the original's (domain, interface, direction, every service-tag member) | `refused` "changes an attribution key" (P3-S72) |
| `floor_min(start') ≥ floor_min(start)` and the version's last minute end ≤ the original's | `refused` "outside the original's minutes" (P3-S72) |

Accepted: identity `{kind:"version", original, v}`; the original is never altered (P3-S31);
the latest accepted version replaces the previous one for charging, the downward effect
borne by the exporter's `owner` (P3-S66). A refused version changes nothing and is
recorded.

**Probe.** The usage-ingestion probe sends one record from a designated probe exporter and
succeeds on its `BatchAck` with `accepted = 1` within 1 s (X2-S18); stage A classes it
probe (X2-S20).

### Part II

`ingest_log` is self-outboxed (RFC-006 §3.5): each `batch`, `correction`, `supersession`
and `identity-conflict` (S-2) row yields exactly one `HandoffEvent`, derived by a versioned
emit function from the row alone; the owner's direct publish is the fast path and the
changefeed relay the guaranteed one. A truncator delete is never an event.

Stage A, per exporter:

- applies events in `handoffSeq` order; at or below the last applied: dropped; a gap
  **waits**;
- applies `accepted` records, `accepted` corrections, `accepted` supersessions and identity
  conflicts (S-2); duplicates and rejections are informative;
- for an identity conflict, spreads the conflicting record and quarantines its parts
  "identity conflict" under the **conflict identity** (F41-10). Supersession disposition
  lookups (RFC-003 §4.2) consider only quarantine entries of kind `record` or
  `correction`, so a conflict never changes the original's disposition. A finance
  attribution of a conflict entry sends parts carrying the conflict identity;
- takes the acceptance time from `commitTs`;
- advances its watermark only from resolved markers (RFC-003 §4.2, AI-27-3).

### Part III

Stage A, per exporter, applies events in `bindingSeq` order (gap waits; at or below the
last applied dropped), checks T1 and T3, and writes every fact to `attr_a_log`.

- **Resolution** (F41-20): for an observation point and a valid time t, the
  `ObservationPointFact` in force is the one with the highest `bindingSeq` (after
  corrections) whose `[validFromMs, validToMs)` contains t. For a binding, the latest
  version of each `bindingId` at or below the position. A `CorrectionFact` replaces or
  retracts the fact it names from its `bindingSeq` on; positions recorded earlier reproduce
  earlier decisions (P3-N9).
- **Bind only at a covered position** (F57-01, D57-1). Let the bind time of a part be
  `t_b = max(s, m)`. Stage A binds **every** part, bound or not, only at a binding
  position whose coverage is at or after `t_b`. The coverage of an exporter is the
  `coversThroughMs` of its last applied `Heartbeat`, or of its partition's last
  `PartitionHeartbeatEvent` when the exporter has no fact yet. If the coverage is before
  `t_b`, the part waits. This is the same wait as the hold below. Thus a binding that is
  ended or moved before `t_b` cannot charge the previous tenant when stage A lags on the
  feed. Stage A records the position it used in the part.
- **Bind** (RFC-003 §4.2 step 3): for a part in minute m of a record active from s, the
  binding whose key equals (observation point including direction, service tag) and whose
  interval contains `max(s, m)`. Two or more: unattributable "ambiguous binding", alerted.
- **No binding: hold, whatever the domain** (S-1 as amended, D41-2). The part is held until
  the exporter's coverage (above) ≥ the part's time + `binding_grace` (5 min, est.). If a
  binding arrives meanwhile, it is attributed. At the end of the hold it is quarantined
  with the reason taken from the covered state:
  - **"domain not of exporter"** when no `ObservationPointFact` of this exporter in force at
    t names the record's observation domain (the domain is not registered to the
    exporter);
  - **"no binding"** otherwise.

  The quarantine entry keeps the record as evidence, with its link and supplier when an
  observation-point fact names one, else reported to the exporter's owner (P3-S26). A
  finance attribution follows RFC-003 §4.4.
- **Observation point → link**: the fact in force gives `linkId`; none, or `null`, gives a
  bound part `linkId: null`, still attributed, and provisioning is alerted (D41-6).
- **Egress** (F41-12): provisioning sets `egress`; when a route's last leg is an unmetered
  partner link, egress is the hand-off point to it (P3-S67). Uniqueness T4 is checked in
  stage B.
- **Exporter with no facts** (F57-10). Provisioning sends a `PartitionHeartbeatEvent` on
  every Kafka partition of the topic at least every 5 s. Stage A applies it to every
  exporter of the partition that has no fact, and records (partition, `partitionSeq`) as
  that exporter's position. Thus the parts of an exporter that has a C08 credential but no
  provisioning are held for `binding_grace`, then quarantined "domain not of exporter"
  and reported (P3-S26).
- **Preconditions on the producer** (D57-1). Provisioning publishes each fact that takes
  effect at time t (a start, an end or a change of a binding or an observation point) at
  or before t − `binding_lead` (60 s, est.). This extends RFC-003 R3-4 to ends and changes.
  A heartbeat asserts coverage at most `binding_lead` ahead: `coversThroughMs` ≤
  `recordedAtMs` + `binding_lead`. Provisioning sends heartbeats at least every 5 s per
  exporter with facts (about 2,000 events/s, est.). With these, stage A in steady state
  binds without waiting, and the acceptance → stage B path stays at about 0.3 s.

### Part IV

Stage A emits, per `processed` entry and destination account, at most one `PartBatch`,
deterministic in the records and the binding positions, including every binding fact of
the account it consumed in that entry. Stage B appends each batch unless `destSeq` is at
or below its producer watermark for that `stageAPartition` (dropped); a gap waits. Stage B
keeps the attachment set from `ForwardedBinding`s, keyed by (exporterId, bindingId). A
product is attached for a minute when at least one of its bindings is valid in that minute
(valid time, not stage B's clock). A binding ends at its `validToMs`, or as a later version
or a `CorrectionFact` changes it. Stage B checks T4 (F57-14).
Negated parts carry `reason` and `cause` (RFC-003 §4.2, §4.4). Non-egress, probe and
quarantined parts are never sent.

## Delivery and ordering

| Part | Guarantee | Partition key | Ordering scope |
|---|---|---|---|
| I | At least once from the exporter (resend until acknowledged, byte-identical with its context, to either region); **exactly-once effect** per record identity (P3-S14, P3-S16) | Session (one exporter) | None across batches (P3-S15); within a batch, items are logged in order |
| II | At least once (two publish paths); exactly-once effect at stage A by `handoffSeq` | `exporterId` | Total per exporter by `handoffSeq` (contiguous) |
| III | At least once; exactly-once effect by `bindingSeq` | `exporterId` | Total per exporter by `bindingSeq` (contiguous) |
| IV | At least once (outbox publish and relay); exactly-once effect at stage B by `destSeq` | `accountId` | Total per (stage A partition, account) by `destSeq` (contiguous) |

## Idempotency

| Item | Key | Duplicate (same content) | Same key, different content |
|---|---|---|---|
| Record | `RecordIdentity` (per format) | Acknowledged as duplicate; nothing flows on; no amendment | Protocol violation: found by the asynchronous 64-bit digest check, recorded as `identity-conflict` with a **conflict identity**, quarantined, alerted; never treated as the original (RFC-003 §3.5) |
| Correction | `RejectKey` (stable across resends; F57-03, D57-6), and a single record's identity | `duplicate`, checked before every other check (F57-20); charged once | Also `duplicate` once accepted (first wins); a refused correction does not take the key |
| Supersession | `(original, v)` | `duplicate`, checked first (F57-20) | `refused` "version out of order" |
| `batchNo` | None (correlation only) | — | — |
| Non-conforming payload | C09 `RecordId` (digest-bound) | C09 answers as the first put | Different payloads always differ in `RecordId` |
| Hand-off event | (`exporterId`, `handoffSeq`) | Dropped | "Same content" means equal on the fields of the event's `schemaVersion` (F41-23); events differing only in fields of a later schema version are the same. A real difference stops the partition and alerts |
| Provisioning event | (`exporterId`, `bindingSeq`) | Dropped | Producer violation: stage A stops the exporter's binding consumption and alerts |
| Part batch | (`stageAPartition`, `accountId`, `destSeq`) | Dropped | As for the hand-off event, on `schemaVersion` fields; otherwise stage B alerts |
| Finance attribution or reversal (`sourceRef`) | Source reference (POL-29) | First result | Refused (RFC-003 §4.4); only carried here |

## Ownership

| Data | Writer | Readers |
|---|---|---|
| Session frames and acknowledgements | Exporter (frames), ingestion edge (acks) | The two ends |
| `ingest_log`, range sets, exception sets, epoch table, wrap anchors | Metering ingestion only, single writer per exporter partition, insert-only (P3-S31) | History (sealing, evidence query); the relay |
| `ingestion.handoff.v1` | Ingestion (direct publish) and the relay for `ingest_log` | Attribution stage A only |
| `provisioning.bindings.v1` | **Provisioning's workload identity only** (Kafka ACL, mTLS; F41-13) | Attribution stage A only; its `attr_a_log` keeps the history |
| `attribution.parts.v1` | Stage A (outbox) | Stage B only |
| Exporter credential (`device_cert`) | Identity and access, via C08 (issued by the supplier administrator, or network operations for Share's exporters) | The ingestion edge (C08 §C edge stream); ingestion receives the principal context from the edge, not from C08 directly |
| Non-conforming payloads | Personal-data store (C09) | Never this contract's topics or tables |

Ingestion reads nothing but its own tables and the principal context the edge forwards: no
provisioning, catalogue, reservation or rating state (RFC-003 §3.6).

## Timeouts and deadlines

| Name | Value | Meaning |
|---|---|---|
| `ingest_retry_timeout` | 2 000 ms (est.) | Exporter resends an unacknowledged batch; its credit returns and the edge forgets it |
| Acknowledgement latency | ≈ 85 ms p99 steady, ≈ 200 ms after a region loss (est.); + ≤ 500 ms with a non-conforming payload | RFC-003 §3.6 |
| Probe limit | 1 000 ms | X2-S18 |
| `pd_put_timeout`; `keep_by` | 500 ms (est.); put issue + 500 ms − ε, ε = 100 ms | Non-conforming payload put |
| Digest-key wait | Unbounded, alerted, `notice{waiting}` | Covered by the exporter's 1 h buffer (est.). The owner keeps one pending batch per waiting partition (F57-11) |
| Credit window | 4 batches, 4 MB per session (est.) | About 40 GB of edge memory for 10⁴ sessions (est.) |
| Context check memo | 24 h | F57-09 |
| Exporter buffer | ≥ 1 h at peak export rate (est.) | F41-27 |
| `epoch_jitter`, `wrap_slack`, `future_skew_max` | 2 s, 10 min, 5 min (est.) | RFC-003 §3.2, §3.3 |
| Takeover of ingestion, stage A or stage B | ≈ 5 s p99 (est.), 3 s owner lease | Nothing acknowledged is lost (X2-S02, X2-S09, X2-S12) |
| Acceptance → stage B committed | ≈ 0.3 s p99 (est.) | Inside `attribution_lag_max`, 10 s (X2-S22, P3-S61, P3-S62) |
| `binding_grace` | 5 min (est.) | Hold before quarantine, whatever the domain state |
| Provisioning heartbeat | ≥ every 5 s per exporter with facts (≈ 2,000/s, est.), and per Kafka partition for exporters with no facts | Staleness > 60 s alerted by stage A |
| `binding_lead` | 60 s (est.) | Each fact is published at least this long before it takes effect; a heartbeat covers at most this far ahead (D57-1) |
| Stage A lag on the binding feed | Alert > 1 day | Retention ≥ 7 days |
| `dispute_window` | 30 days from the end of the original's last minute (or from its receipt when it had no usable times) | Supersession and correction deadline (POL-17, D41-1, D57-3); T4 hold limit (D57-4) |

## Versioning and compatibility rules

- **Part I**: `protocolVersion` in `Hello` and `Welcome`. Minor changes (optional fields, new
  `RejectReason` or `DerivedRefusal` values, new template elements that hold no personal
  data) keep version 1; exporters treat an unknown reason as a rejection. Removing or
  re-typing a field, or changing identity or acknowledgement semantics, is a new
  `protocolVersion`, served beside the old one for at least 12 months. **Identity
  computation can never change for records already received**: a byte-identical resend
  (message and context) years later maps to the same identity.
- **Parts II and III**: `schemaVersion` in every event and `schema_v` in the header.
  Additive fields only within a version; consumers ignore unknown fields. **An unknown
  `body.kind` or `fact.kind` stops the partition and alerts**, since skipping could lose
  traffic or bindings (F41-29).
- **Part IV**: additive as above; an unknown field or kind is **ignored and alerted**.
- A breaking change publishes `*.v2` beside `*.v1` until every consumer has moved; emit
  functions are versioned (RFC-006 §3.5), and a re-derivation from `ingest_log` under a new
  emit function keeps `handoffSeq`.
- The template list may grow only by elements that cannot identify a person (RFC-000 A11),
  after a contract review.

## Scenarios relied on

P3-S14, P3-S15, P3-S16, P3-S17, P3-S18, P3-S19, P3-S25, P3-S26, P3-S27, P3-S28, P3-S29,
P3-S30, P3-S31, P3-S36, P3-S38, P3-S39, P3-S49, P3-S50, P3-S51, P3-S53, P3-S61, P3-S62,
P3-S65, P3-S66, P3-S67, P3-S68, P3-S71, P3-S72, P3-S73, P3-S75; X2-S02, X2-S04, X2-S09,
X2-S10, X2-S12, X2-S14, X2-S18, X2-S20, X2-S22; X1-S41 and X1-S45 through C08. All at
`requirements-v1.10`.

## Conformance tests

**Ingestion (provider) runs:**

1. *Ack after durability*: block the second region's replica; no `BatchAck` until
   two-region durability; then exactly one (X2-S14).
2. *Outcomes* (F41-16): a batch with one record per reachable `RejectReason`, valid records
   after each; each rejection acknowledged with `rejectKey`, `rawRef` and its display string, valid
   records accepted (P3-S28, P3-S29). P3-S28's rows map as follows: "no exporter" → a record
   on a domain not registered to the exporter, kept and quarantined "domain not of
   exporter" by stage A, not charged (S-1); "no sequence number" → unreachable for IPFIX
   and v9, noted (RQ41-1); "a negative byte count" → a correction carrying `bytes: "-1"`;
   "an end time before its start time" → as stated.
3. *Identity*: verbatim redelivery to the other region: all duplicates. Restart (new init
   time) and sequence 7: accepted (P3-S50). A wrap, then a pre-wrap redelivery a simulated
   year later: duplicate (P3-S14).
4. *Identity from the item alone* (F41-01): (a) commit M, lose the ack, reboot the exporter
   (new init time), reconnect to the other region, declare new templates and options, then
   resend M with its original context: all duplicates. (b) The same with no options record
   on the new session: still duplicates (no "no epoch"). (c) A template ID redefined with a
   different field order on a new session does not change a resent message's decode.
   (d) Epoch drift (F57-02): commit M in epoch E0 at init time +1.9 s; let drift open E1 at
   +2.1 s; resend M: duplicate, in E0. The same for `OriginalRef.coordinates`.
   (e) Context swap (F57-09): resend M with a rebuilt context that maps to another epoch,
   inside 24 h: duplicate, in the first epoch, and a context-violation alert.
   (f) Vendor options template (F57-07): an options template with scope 149, IE 160,
   `exporterIPv4Address` (130) and `samplingInterval`: the epoch is found, the records are
   accepted, and the logged context holds no 130 value. A context with two different init
   times for the domain: "no epoch".
   (g) Context logging (F57-08): the context is in the context table once per partition;
   evidence and a re-derivation decode the message from it.
5. *NetFlow v9* (F41-02): consecutive packets of 20 records each: all accepted, none
   duplicate, no identity conflict; one packet resent: all 20 duplicates; a packet with a
   future-time record, resent after the clock passes it: only that record accepted.
   *Format switch* (F57-06): a `Hello` with `ipfix` for an exporter ID recorded as
   `netflow-v9` is refused with `protocol-error`.
6. *Templates*: a template declaring `sourceIPv4Address` refused; its data sets rejected
   "does not conform to the record template"; scan every topic, table, log and trace for
   marker addresses: none (P3-S71). A template with both 1 and 23: refused. Direction and
   interface rules of F41-09, each branch, including "missing attribution key" and "missing
   byte count", and the branch with 10 and 14 present and no 61: "missing attribution key"
   (F57-16).
7. *Digest key unavailable*: a batch with a non-conforming payload and a later conforming
   batch of the same exporter get no ack and a `notice{waiting}`; another exporter's
   batches are acknowledged; after the key returns the resend is acknowledged with the
   `RecordId`.
8. *Store slow or refusing*: acknowledged within 1 s with "dropped: not taken in time" or
   "unanswered, withdrawal pending"; a C09 `refused` and `temporarily_unavailable` each map
   to "unanswered, withdrawal pending" and are withdrawn; conforming batches and the probe
   unaffected (P3-S75, X2-S18).
9. *Flow control* (D41-5): a batch stuck in the digest-key wait: its credit returns after
   2 s, the exporter resends with fresh credit, the edge holds at most one window. The
   exporter resends its whole window for 1 h: the owner holds at most one batch for the
   partition, and the edge answers new batches at once with `notice{waiting}` (F57-11).
10. *Corrections*: three sends by the own exporter: accepted, duplicate, duplicate; another
    exporter's: refused (P3-S30). Two rejected records at the same position of two messages
    of one batch: each corrected and charged. An unparseable remainder corrected with 3
    records: each charged once. A refused correction ("negative byte count") then a valid
    one: accepted. A correction after `dispute_window`: refused "outside dispute_window"
    (D41-1). A domain different from the header's: refused.
    *Stable key* (F57-03): one unparseable remainder acknowledged twice (a resend at 1.98 s
    after commit), both acks corrected: charged once.
    *Correction marks the identity* (F57-04): a record rejected "flow time in the future" is
    corrected; then the original message, resent after the time is valid, gives a
    duplicate (IPFIX and v9), and no identity conflict.
    *Deadline from the original* (F57-05): a correction sent one year after the rejection,
    with today's flow times: refused "outside dispute_window". A correction record with
    `flowEndMs` after the rejected item's receipt + 5 min: refused "outside the original's
    receipt".
    *Idempotency first* (F57-20): a correction and a supersession accepted 1 s before the
    deadline, acks lost, resent 1 s after it: both `duplicate`.
    *"No epoch" fixed only by a correction* (F57-19): a record rejected "no epoch" and
    corrected, then the message resent with a correct context: duplicate.
11. *Supersessions*: the P3-S72 rows; version 2 moving outside the original's minutes after a
    narrowing version 1; `coordinates` (across a wrap) and `identity` resolve to the same
    original; after `dispute_window`: refused (P3-S66); a supersession of an accepted
    correction with lower bytes: accepted, amended downward (F41-06).
12. *Hand-off*: drop the direct publish; the relay alone delivers every event with
    contiguous `handoffSeq` = header `stream_seq`; with both paths, identical events; no
    payload bytes; an identity conflict appears as an event with a conflict identity.
13. *Credentials* (with C08): a `network_operations` certificate and one without an exporter
    are refused at session open; a revoked certificate's session closed within 31 s; a
    batch unacknowledged at revocation, resent under the exporter's new certificate, is
    accepted (X1-S41, F41-25); the serial is in the entry.

**Exporter (or relay) runs, against the reference edge simulator:**

14. Keeps every message with its first-export context until acknowledged; resends both
    byte-identical after 2 s, to either region; never resends an acknowledged batch;
    honours the credit window; buffers ≥ 1 h at peak while the edge sends
    `notice{waiting}`.
15. Uses only template-list elements; adds `flowDirection` when it re-encodes (D57-2);
    corrects only by the returned `rejectKey`; supersedes with increasing `v`, measured
    fields only; keeps one export format per exporter ID.

**Attribution stage A (consumer of II and III) runs:**

16. Gaps in `handoffSeq` or `bindingSeq` wait; duplicates dropped; delivery from two paths
    applied once (P3-S15, P3-S17).
17. Watermark advances only on resolved markers; a stalled changefeed partition holds it.
18. Binding: P3-S49, P3-S67; no binding → held, quarantined "no binding" after
    `binding_grace` + heartbeat (P3-S26); a domain no observation-point fact of the exporter
    names → held, then "domain not of exporter"; the observation-point fact arriving during
    the hold → attributed; two bindings → ambiguous, alerted; a `CorrectionFact` changes
    later decisions only, recorded positions reproduce earlier ones (P3-N9, P3-S36).
    *Stale binding* (F57-01): a binding of account a1 ends at 12:00 and one of a2 starts at
    12:00 on the same key; stage A lags 3 min on the binding feed; no part of 12:00 to
    12:03 goes to a1, and all go to a2 once the feed covers them.
    *Exporter with no facts* (F57-10): its parts are held for `binding_grace`, then
    quarantined "domain not of exporter", under the partition heartbeat.
19. *Rebuild after retention*: start a stage A instance with an empty cache 8 days after the
    facts were published: state restored from `attr_a_log`, decisions unchanged.
20. Supersession dispositions P3-S73; an identity conflict on a bound original, then a
    supersession of the original: the original's parts are negated and replaced as bound,
    not as quarantined (F41-10).
21. Tenancy: a fact whose `op.exporterId` differs from the key is refused (T1); a probe
    account bound at a non-probe point is held (T3); a bound part with no link mapping is
    attributed with `linkId: null` and alerted (D41-6).

**Provisioning (producer of III) runs, against the published validator:**

22. Contiguous `bindingSeq` per exporter and `partitionSeq` per partition; heartbeats at
    least every 5 s, never more than `binding_lead` ahead; each fact published at least
    `binding_lead` before it takes effect; no fact deleted;
    T1 to T4 hold; produce from another workload identity is refused by the ACL; bindings
    published before traffic in a staging soak.

**Attribution stage B (consumer of IV) and rating run:**

23. `destSeq` at or below the watermark dropped; gap waits; negated parts applied; a
    takeover applies nothing twice.
24. Attachment set: two exporters bind one product for one account; one binding ends; the
    product stays attached (F41-11). A `CorrectionFact` moves a binding from a1 to a2: both
    stage Bs receive it, and a1's attachment set no longer has the product (F57-14).
25. T4: two egress points for one (account, product, route, reservation, direction) on two
    exporters: the parts held, counted in unposted usage, not charged, provisioning
    alerted. A `CorrectionFact` retracts one: its parts dropped, the survivor's charged
    once (P3-S49, D57-4). Two bindings at one egress point with different service tags,
    and two LAG members in one `egressGroup`: no violation. A violation unresolved at
    `dispute_window`: parts dropped, finance alerted.
26. T2 (rating): a reservation-class part whose reservation belongs to another account:
    the line is held, alerts raised, no account charged.

## Settled

Binding orchestrator decisions. The RFC errata named are to be applied to the RFCs; this
contract already states the settled reading.

| # | Point | Decision | Errata |
|---|---|---|---|
| **S-1** (was M-1; **amended after review 41**, F41-04) | Where ingestion learns which observation domains belong to an exporter. RFC-003 §3.3 rejects `no exporter` for a domain "not registered to the session's exporter", but ingestion reads no provisioning (RFC-003 §3.6) and the C08 credential names no domains | Ingestion answers `no exporter` **only when the header carries no observation domain**. Domain IDs are exporter-local, so stage A derives "domain d is exporter X's" from **X's own `ObservationPointFact`s on the binding feed** (part III), under its recorded position and heartbeat; **no separate domain topic** (`provisioning.domains.v1` dropped). A part with no binding is held, whatever the domain state, until the feed covers its time + `binding_grace` (D41-2), then quarantined **"domain not of exporter"** when no fact of X names d, else **"no binding"**, keeping the evidence. C08 carries no provisioning data | **RFC-003** §3.3 (`no exporter` narrowed); §4.1 (observation-point facts register an exporter's domains; heartbeat and position; binding feed persisted, never compacted; tenancy invariants and producer ACL, F41-13); §4.2 (the hold for every unbound part, the reason chosen at its end, per-part binding position); §4.4 (quarantine reason "domain not of exporter"; entries with no link reported to the exporter's owner); §7 consumed row "Attribution keys" and provided row "Quarantine report feed"; §9 tests. **RFC-005** §2.1 exporter row and §8.4: "records are accounted to the certificate's exporter; a record on a domain not registered to it is quarantined 'domain not of exporter' by attribution, never attributed to another exporter's points" (AI-41-4). **RFC-000** §8 row 3 (observation-point facts register domains). **RFC-006** §5.4 and **C01** §2.5: `attribution.parts.v1` keyed by account as an exception to the producing-partition rule (AI-41-5) |
| **S-2** (was M-2) | Identity conflicts were not on the hand-off: RFC-003 §3.5 quarantines them in stage A, but the hand-off stream named only `batch`, `correction` and `supersession` rows | The hand-off carries `identity-conflict` rows (`IdentityConflictBody`) with a **conflict identity** (F41-10); stage A spreads the conflicting record and quarantines it "identity conflict" under that identity; supersession disposition lookups ignore conflict entries | **RFC-003** §3.4 and §7 (hand-off rows); §3.5 (the conflict identity); §4.2 (stage A applies identity-conflict events; disposition lookups by kind record or correction). **RFC-006** §3.5 (the `ingest_log` hand-off stream declaration). **RFC-000** §8 row 2 ("accepted record batches" also carries identity conflicts) |

Further errata from review 41, beyond S-1 and S-2: **RFC-003** §3.1 and §3.2, the item's
context and identity from (context, message) only (AI-41-1); §3.2 and §3.5, NetFlow v9
packet-level identity and range set with the rejected-record exception set (AI-41-2);
§3.3, the correction deadline (D41-1), raw references by message and record, multi-record
corrections of a remainder (D41-4), supersession of a correction (F41-06); §3.1, credit as a
window of unacknowledged batches (D41-5); §4.1 and §4.3, egress uniqueness scoped per
(account, product, route, reservation, direction) and checked in stage B (AI-41-3), per-binding
forwarding for the attachment set (F41-11). **RFC-006** §5.4: none for the hand-off name
(C11 now uses RFC-006's `ingestion.handoff.v1`). **C09** (joint fix): `RecordId`'s identity
ref gains `observation_domain` and, for NetFlow v9, `index` (F41-15).

Further errata from review 57: **RFC-003** §4.1 and §4.2: stage A binds every part only at
a position whose heartbeat covers the part's bind time; heartbeats may assert coverage up
to `binding_lead` ahead; R3-4 extends to ends and changes of bindings; the feed-wide
partition heartbeat for exporters with no facts (AI-57-1, F57-01, F57-10). §3.2: the epoch
rule (the lowest-numbered epoch within `epoch_jitter`); §3.5: the epoch sizing with drift
(AI-57-2, F57-02). §3.3: the stable reject key and corrections deduplicated by it
(AI-57-4, F57-03); an accepted correction marks its identity in the range set or the
exception set (F57-04); the deadline from the original record and the receipt bound
(F57-05, D57-3); idempotency checked first (F57-20); a rejection fixed only by a correction
(F57-19); one pending head batch per waiting partition (AI-57-3, F57-11). §3.1: the
template row now says "refused for the item", not "for the session"; the export format is
fixed per exporter ID (D57-5); the options-template rule (F57-07). §3.4 and §3.7: the
context table and the cut context (F57-08); the 24 h context check memo (F57-09). §3.6:
ingestion reads the principal context that the edge forwards, not an exporter credential
cache (F41-24, F57-18). §4.1 and §4.3: the T4 scope by egress point and `egressGroup`, the
T4 hold and its resolution (D57-4); §5.9: held parts count in unposted usage (F57-12);
forwarding to old and new account, liveness by valid time (F57-14). **RFC-005** §8.4: no
change beyond AI-41-4.

### Scope note

The original brief named the metering hand-off "stage A → stage B". RFC-000 §8 and RFC-003
§7 define it as ingestion → attribution stage A; stage A → stage B is RFC-003-internal. This
contract follows the RFCs for part II and specifies stage A → stage B as part IV.
Accepted by the orchestrator.

### Contract completions (accepted by the orchestrator; revised after reviews 41 and 57)

- `BatchAck` returns each rejected record's stable `rejectKey` (F57-03) and its `rawRef`
  (exporter, entry, message, record) for evidence.
- `OriginalRef.coordinates` names an original by the message's sequence and the record
  index, without Share's epoch number.
- Correction refusal "no such rejected record".
- Templates are no longer session-scoped for decoding: each item carries its own context
  (F41-01 replaces the earlier "re-declare templates per session" rule).
- `RecordFields.bytes` is signed in Share frames, so P3-S28's "a negative byte count" is
  reportable.
- Provisioning heartbeat cadence 5 s (≈ 2,000 events/s, est.) and staleness alert 60 s.
- Correction refusal "outside the original's receipt" (F57-05).
- Credit window 4 batches and 4 MB (est.).

## Review 41 resolution

All fixes proposed by [review 41](../../reviews/41-contract-C11-review.md) are applied, with
its decisions D41-1 … D41-6, as the orchestrator directed.

| Finding | Resolution | Where |
|---|---|---|
| F41-01 (Blocker) | `ExportItem { message, context }`: the first-export templates and options travel with the message, byte-identical; identity and decode only from (exporter ID, context, message); session templates are a cache only; "no epoch" when the context lacks an init time; tests 4 and 14 | Part I schema, template table, Semantics "Identity and decoding come from the item alone", Versioning |
| F41-02 (Blocker) | NetFlow v9 kept (D41-3) with packet-level identity `(packetExtSeq, index)`, range set over packets, rejected-record exception set; coordinates by message sequence and index; test 5 | `RecordIdentity`, Part I Semantics, `OriginalRef` |
| F41-03 (Blocker) | Resolved by dropping the domain topic (F41-04). The binding feed is never compacted, retained ≥ 7 days, every fact written to `attr_a_log` and rebuilt from it, position (`bindingSeq`) and completeness heartbeat stated, the position recorded per `processed` entry and per part; lag alert; test 19 | Part III "Persistence and position", Timeouts |
| F41-04 | S-1 amended: domain registration from the exporter's own observation-point facts; `provisioning.domains.v1` removed; reasons as in S-1 | Settled S-1, Part III Semantics |
| F41-05 (D41-4) | `RawRef { exporterId, logSeq, message, record }`, `record = −1` for a whole message or remainder; `Correction.records[]`; identity `{kind:"correction", rawRef, sub}` | Common types, Part I |
| F41-06 | `OriginalRef.identity: DerivedIdentity`; supersession of an accepted correction with the same checks | Part I schema and Semantics, `SupersessionBody` |
| F41-07 (D41-1) | Correction refused "outside dispute_window" after the corrected record's last minute end + `dispute_window` | Part I Correction step 3, test 10 |
| F41-08 (D41-5) | Credit as a window of unacknowledged batches; returns at ack or after `ingestRetryTimeoutMs`, the edge then forgets the batch; "never drops" sentence replaced; `notice{waiting, "digest key"}`; test 9 | `Credit`, Part I Semantics "Flow control" |
| F41-09 | Normative direction and interface rules; `postOctetDeltaCount`/`OUT_BYTES` (23) and `postPacketDeltaCount`/`OUT_PKTS` (24) added as measured fields, both-declared templates refused; reasons "missing attribution key" and "missing byte count" | Template table, `RejectReason` |
| F41-10 | `DerivedIdentity` kind `conflict`; disposition lookups ignore it | Common types, Part II, S-2 |
| F41-11 | Per-binding `ForwardedBinding`s; attachment set = products with at least one live binding; test 24 | Part IV |
| F41-12 | Egress uniqueness T4 per (account, product, route, reservation, direction), checked in stage B with hold and alert; test 25 | Part III invariants, Part IV Semantics |
| F41-13 | Producer ACL on `provisioning.*`; invariants T1 to T4; rating checks T2 against the lifecycle feed, holds and alerts, never charges another account; tests 21, 22, 26 | Part III, Ownership |
| F41-14 | Errata completed for S-1, S-2 and the rest | Settled |
| F41-15 | C09 `RecordId` carried verbatim with the mapping; C09 answers mapped to keep outcomes (`erased` added; `temporarily_unavailable` and `refused` → withdrawal pending); "RFC-005 C12" now cited as C09; joint C09 fix listed | Common types, Part II, Part I Semantics, header |
| F41-16 | Display string per reason; test 2 maps P3-S28's rows | `RejectReason`, test 2 |
| F41-17 | Coordinates carry `messageSequence` and `recordIndex` | `OriginalRef` |
| F41-18 | `Part.recordIdentity: DerivedIdentity` | Part IV |
| F41-19 (D41-6) | `linkId: LinkId \| null`; attributed and alerted | Part IV, Part III Semantics |
| F41-20 | `factId` and `validToMs` on `ObservationPointFact`; resolution by highest `bindingSeq` whose interval contains the time | Part III |
| F41-21 | Heartbeats are not facts and are not written to `attr_a_log`; 2,000/s marked (est.) | Part III, Timeouts |
| F41-22 | `bindingPosition` per part | Part IV |
| F41-23 | "Same content" = equal on the `schemaVersion` fields; header `stream_seq` = `handoffSeq`, `ts` = `commitTs`; resolved markers in C01's header form | Part II, Idempotency |
| F41-24 | Only `exporter` and `probe` certificates with an exporter; owner from the C08 principal context with the tenant mapping; `certSerial` in entries and `BatchBody.session`; ingestion is not a C08 consumer | Part I Semantics, `ExporterOwner`, Ownership |
| F41-25 | Revocation is of the certificate; a resend under the same exporter's new certificate is accepted or deduplicated | Part I Semantics, test 13 |
| F41-26 | Domain must equal the rejected identity's; only an accepted correction marks the raw reference | Part I Correction steps 4 and 6 |
| F41-27 | Exporter buffer ≥ 1 h at peak (est.); test 14 | Part I Semantics, Timeouts |
| F41-28 | P3-S25, P3-S27, P3-S36, P3-S53, P3-S65 added | Scenarios relied on |
| F41-29 | II and III stop and alert on an unknown kind, IV ignores and alerts; protobuf, sealed per C01 §2.5; `softwareId` bounded to 64 printable ASCII characters, diagnostics only | Versioning, Schema intro, `Hello` |
| RQ41-1 … RQ41-3 | Requirements issues, not C11's to amend: passed to the requirements owner. C11 already reads P3-S28 per test 2 and identity per format | — |
| AI-41-1 … AI-41-6 | Carried into the errata of Settled (AI-41-5's naming half resolved in C11 by adopting `ingestion.handoff.v1`; AI-41-6 settled by the orchestrator as S-1's amendment) | Settled |

## Review 57 resolution

All fixes that [review 57](../../reviews/57-contract-C11-review.md) proposes are applied,
with its decisions D57-1 … D57-6, as the orchestrator directed. New text uses ASD-STE100
Simplified Technical English.

| Finding | Resolution | Where |
|---|---|---|
| F57-01 (Blocker) | Stage A binds every part only at a position whose heartbeat covers the part's bind time `max(s, m)`; otherwise the part waits. Heartbeats can cover up to `binding_lead` (60 s, est.) ahead, and provisioning publishes each fact at least `binding_lead` before it takes effect (D57-1). RFC-003 §4.2 erratum (AI-57-1). Test 18 "Stale binding" | Part III `Heartbeat`, Semantics "Bind only at a covered position", "Preconditions on the producer"; Timeouts; Settled |
| F57-02 | Epoch rule: the lowest-numbered epoch within `epoch_jitter`; epochs never removed; the same rule for coordinates. Epoch sizing with drift added (about 2,555 epochs per domain in 7 years, about 10⁸ sets, more than 3.2 GB, about 25 MB per slot, est.). Test 4(d) | Part I "Epoch rule", "Epoch sizing with drift"; Settled |
| F57-03 (D57-6) | Stable `RejectKey`, from the item only (positioned key, or keyed digest for a headerless message); corrections name and are deduplicated by it; `RawRef` is evidence only. Test 10 "Stable key" | Common types, `Correction`, `RejectedRecord`, `CorrectionBody`, Idempotency |
| F57-04 | An accepted correction adds its identity to the IPFIX range set, or removes it from the v9 exception set, in the same transaction; the content check against the correction's digest gives an informative duplicate, not a conflict. Test 10 | Part I "An accepted correction marks its identity accepted" |
| F57-05 (D57-3) | Deadline from the rejected record's last minute end (or its receipt) + `dispute_window`; new refusal "outside the original's receipt" for a flow end after receipt + `future_skew_max`. Test 10 | Part I Correction steps 4 and 5; `DerivedRefusal`; Timeouts |
| F57-06 (D57-5) | Export format fixed per exporter ID; a different `Hello` format is refused with `protocol-error`; a change of format is a new exporter ID through C08. Test 5 | `Hello`, Part I "Export format per exporter" |
| F57-07 | Options-template rule: applicable when scope is 149 (the message's domain) or 144 and IE 160 is present; other options fields ignored and not logged; exactly one init-time value per context, else "no epoch"; a minimal options template recommended for relays. Test 4(f) | Part I "Options templates", template table |
| F57-08 | Cut context logged once per partition in a context table, by SHA-256, in the batch transaction; `BatchBody.contexts`; overhead stated (15 to 18% on the wire, less than 0.1% in the log, est.). Test 4(g) | Part I "Context logging"; `LoggedContext` |
| F57-09 | 24 h context check memo (exporter, domain, `exportTimeS`, q, 64-bit content digest) → epoch; a mismatch takes the first epoch and is alerted. The memo uses the unkeyed 64-bit content digest of RFC-003 §3.5, so a conforming batch never waits for the key service. Size about 100 GB a day in all, less than 1 GB per slot (est.). Test 4(e) | Part I "Context check memo"; Timeouts |
| F57-10 | `PartitionHeartbeatEvent` on every Kafka partition covers exporters with no facts; its position is recorded. Test 18 "Exporter with no facts" | Part III schema and Semantics; Persistence |
| F57-11 | One pending head batch per waiting partition; later batches and copies dropped unacknowledged; the edge answers new batches at once with `notice{waiting}`. Credit window values given. RFC-003 §3.3 erratum (AI-57-3). Test 9 | Part I "Bound on the pending queue", "Flow control"; Timeouts |
| F57-12 (D57-4) | T4 scoped by egress observation point, with `egressGroup` for parallel points; held parts count in unposted usage and are not charged; on resolution the retracted or ended binding's parts are dropped and the survivor's charged; unresolved at `dispute_window`, dropped and finance alerted. Test 25 | Part III T4 row, "T4 hold and resolution"; `BindingFact.egressGroup` |
| F57-13 | Heartbeat counts facts recorded with a valid time ≤ coverage, corrections excepted | `Heartbeat` |
| F57-14 | Corrections that move a binding are forwarded to the old and new account; liveness by valid time at the part's minute; bindings keyed by (exporterId, bindingId); `bindingId` unique per exporter. Test 24 | `ForwardedBinding`, `BindingFact`, Part IV Semantics |
| F57-15 | Exception-set rows in the batch transaction; the 10⁶ safeguard and alert | Part I "Exception set" |
| F57-16 (D57-2) | The case "10 and 14 present, 61 absent" is a rejection, stated; relays add `flowDirection`. Tests 6 and 15 | Template table |
| F57-17 | Revocation wording: no batch received after the edge applied the revocation (at most 31 s) | Part I Session open |
| F57-18 | Missing errata added (RFC-003 §3.6, §3.1 template row, §4.2, §3.2 and the rest) | Settled, "Further errata from review 57" |
| F57-19 | Domain equals the header's whenever the header parsed; a rejection is fixed only by a correction; a corrected "no epoch" key makes later copies duplicates. Test 10 | Part I Correction step 6, "A rejection is fixed only by a `Correction`" |
| F57-20 | Idempotency is checked first for corrections and supersessions. Test 10 | Part I Correction step 2, Supersession; Idempotency |
| RQ41-2 | Still with the requirements owner; needed to back D41-1 and D57-3 | — |
| AI-57-1 … AI-57-4 | Carried into "Further errata from review 57" | Settled |
