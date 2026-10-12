# C13. Link registry: link records, registry commands and the registry feed

| | |
|---|---|
| Contract ID | C13 (`link-registry`) |
| Version | 1 |
| Status | **Frozen.** Raised after C4 by the S-SEC and S-RATE plans (blocker B-3) and by the S-LINK plan (BL-2, P-3). There is no open mismatch. Each conflict between sources is settled in favour of the frozen contracts (see "Settled"). Errata owed are listed under "Errata owed" |
| Provider | RFC-001 (link registry, §10; the link schedule owner sends the retirement report) |
| Consumers | **Link schedule owner** (RFC-001): `Registry` entries, the closing envelope, the registry version for check 6. **Placement** (RFC-006): the slot of a registered Share link and its `Init` entry. **Catalogue** (RFC-003): the route-leg check. **Attribution stage A** (RFC-003): the supplier of a quarantined part's link. **Edge and console** (RFC-005): the coarse supplier check on supply commands, the operator envelopes and target summaries of `register_link` and `retire_link`. **History** (RFC-006): link records as known at T. RFC-002 (account owner) is **not** a consumer (settled S2). RFC-004 may read the feed. No obligation is put on it |
| Transport | **Synchronous command**: gRPC service `LinkRegistry` to the owner-lease holder of the link's registry partition, with C01's `CommandEnvelope` as metadata (registry commands, `get_link`, target summaries). **Kafka event**: topic `link_registry.links.v1` from the registry outbox (direct publish and C01 relay). **Notification** (C01 §3.5): the retirement report from the link schedule owner to the registry. No database read crosses an owner boundary |
| Pinned to | `requirements-v1.11`. RFC-000 revision 4.5 (§8 rows "Link supply commands" and "Catalogue"; "Revision 4.5 errata": C03 M1, C06-M14, AI-55-1). RFC-001 revision 6 (§5, §7.3, §10, §11, §11.1, T-19, T-22, CI-R1-1, CI-R1-3, R1-19). RFC-002 revision 6 (§2.2 E7, §3.2 check 1 and the retiring-link paragraph, §5.1, rejected alternative "Checking a retiring link at intake"). RFC-003 revision 6 (§4.4, §6, §6.1). RFC-005 revision 6 (§3.4, §7.2, contracts consumed). RFC-006 revision 7 (placement, history, through C01). Frozen contracts: **C01** v1 (§2.2 owner declaration, §2.5 wire format and producer ACL, §3.5, §3.6 and M7 closure, §3.10 probe designation, §4, §5), **C02** v1.0.0 (settled M-2), **C03** v2.4 (settled M1, R39-07), **C06** v1 (C06-M14, `route` and `probe_designation` entities), **C08** v1.2 (§E envelope, action catalogue, §F `operator_check`, §G target summary), **C11** v1 (`ObservationPointFact`, S-1) |

## Purpose

The link registry is the reference data for each link. It records the link's identity,
its kind (Share or partner), its supplier, its two termination points, its capacity at
registration, and its lifecycle status (`active`, `closing`, `retired`). Each change gets
a new **registry version** for that link.

This contract fixes:

- the link record and the registry feed, keyed by `(link_id, version)`;
- the registry commands `register_link` and `retire_link`, with the C08 operator envelope;
- the retirement in two steps: `closing`, then `retired` after an empty report from the
  link schedule owner;
- `get_link`, and the target summary for a `link` target;
- the registry version as the `target_version` of every operator envelope on a link.

This contract does **not** carry these items. Each has its own frozen contract:

| Item | Where it is |
|---|---|
| Capacity in force, sellable and physical (`K_s`, `K_p`), outages, reductions, increases | C03 schedule feed `link.schedule.v1` |
| Answers of a link to `hold`, `offer_hold`, `release` (`UNKNOWN_LINK`, `LINK_CLOSING`, `LINK_RETIRED`) | C02 (settled M-2) |
| Routes and their ordered legs | C06 `catalogue.v1`, entity `route` |
| Probe designation of a link, supplier or exporter | C06 `catalogue.v1`, entity `probe_designation` (C01 §3.10) |
| Observation point → link mapping | C11 Part III, `ObservationPointFact` (provisioning) |
| Link validity rules (window, rate) | Policy-register parameters under `policyVersion` (AI-55-1). Not a registry field |

## Schema

### Common types

```ts
/** Opaque link identity. 128-bit random, 32 lowercase hex (C08 Id128).
 *  The console's signing client makes it for a new registration. Never reused. */
type LinkId = string;
type SupplierId = string;               // C08 SupplierId; the supplier tenant of the link
type TerminationPointId = string;       // opaque site and port reference; no personal data
/** Registry version: decimal string of an int64 >= 1. Per link. It is the stream_seq of the
 *  link's `links` stream (C01 §2.1 StreamSeq). Version 1 is the registration. "0" means
 *  "not registered" and appears only as the target_version of register_link. */
type RegistryVersion = string;
type HlcTs = string;                    // C01 HlcTs
/** Rate. Unit: whole Mbps (10^6 bit/s), integer. */
type Mbps = number;

type LinkKind = "share" | "partner";
type LinkStatus = "active" | "closing" | "retired";
```

### Link record

```ts
interface LinkRecord {
  linkId: LinkId;
  version: RegistryVersion;             // the version of the last change
  kind: LinkKind;                       // immutable
  supplier: SupplierId;                 // immutable (settled S11)
  endpoints: [TerminationPointId, TerminationPointId];   // immutable; the two must differ
  initialCapacityMbps: Mbps | null;     // share: integer >= 1, becomes C_ref (RFC-001 §3.1); partner: null
  status: LinkStatus;
  registeredAt: HlcTs;                  // commit timestamp of version 1
  statusSince: HlcTs;                   // commit timestamp of the last status change
}
```

### Registry feed (`link_registry.links.v1`)

```ts
type RegistryChange =
  | "registered"     // version 1; status active
  | "closing"        // retirement started; also each repeat of retire_link while closing
  | "reopened"       // closing -> active (retire_link with flags.withdraw = true)
  | "retired";       // closing -> retired, after an empty RetirementReport

interface LinkRegistryEvent {
  type: "LinkRegistryEvent";
  schemaVersion: 1;
  change: RegistryChange;
  record: LinkRecord;                   // the full record AFTER the change; record.version = this event's version
  /** "closing" only: the operator envelope of retire_link (C08 OperatorEnvelope), for the
   *  link schedule owner, which is a receiver of retire_link (C08 action catalogue). */
  envelope?: OperatorEnvelope;
  /** "retired" only: the empty report that allowed the retirement. */
  report?: RetirementReport;
  audit: {                              // X1-N8; pseudonymous only (A11)
    principal: string;                  // C08 PrincipalId of the requester
    role: "commercial";
    reasonCode: string;                 // from the action's closed list (C08 §E)
    actionId: string;                   // C08 ActionId
  };
  committedAt: HlcTs;                   // = the entry's commit timestamp
}
```

Wire format (C01 §2.5): key = the link's partition (`linkId` bytes). Headers carry
`partition`, `stream = "links"`, `stream_seq = record.version`, `generation`, `epoch`,
`ts`, `kind = "LinkRegistryEvent"`, `schema_v = "1"` and `key_id`. The value is sealed under
the topic's feed key. Closure: `'none'` (settled S7).

### Registry commands (gRPC `LinkRegistry`)

```ts
/** register_link. C08 CanonicalAction with:
 *    action_type = "register_link", target = { kind: "link", link_id }, target_version = "0",
 *    scope = RegisterLinkScope (inside the digest). */
interface RegisterLinkScope {
  kind: LinkKind;
  supplier: SupplierId;
  endpoints: [TerminationPointId, TerminationPointId];
  initialCapacityMbps: Mbps | null;     // share: integer >= 1; partner: null
}

/** retire_link. C08 CanonicalAction with:
 *    action_type = "retire_link", target = { kind: "link", link_id },
 *    target_version = the record's current version,
 *    flags = { withdraw?: true }        // withdraw: closing -> active (settled S8) */

rpc RegisterLink(OperatorEnvelope) returns (EnvelopeAnswer);   // C08 §E types
rpc RetireLink(OperatorEnvelope)   returns (EnvelopeAnswer);

/** Refusal rules of this contract, as EnvelopeAnswer { kind: "refused_by_rule"; rule }: */
type RegistryRule =
  | "link_id_taken"          // register_link: the link_id has a record (another action_id)
  | "invalid_registration"   // scope fails a check of "Semantics, register_link"
  | "not_active"             // retire_link (no withdraw) on a retired link
  | "not_closing"            // retire_link with withdraw on a link that is not closing
  | "partner_link_retirement_not_in_v1"  // settled S10
  | "action_id_reused";      // same action_id, different envelope digest; alerted

rpc GetLink(GetLinkRequest) returns (GetLinkAnswer);
interface GetLinkRequest { linkId: LinkId }
type GetLinkAnswer =
  | { kind: "found"; record: LinkRecord }
  | { kind: "not_found" }
  | { kind: "unavailable" };            // retry; C01 routing refusals map here

/** C08 §G target summary for target { kind: "link" } at the registry. */
interface RegistryLinkSummaryBody {
  record: LinkRecord;
  lastReport?: RetirementReport;        // the last report for the current version, if any
}
// SignedTargetSummary.target_version = record.version. An unknown link_id answers { kind: "not_found" }.
```

### Retirement report (notification, link schedule owner → registry)

```ts
/** C01 notification. Identity "<linkId b64>:<registryVersion>:RETIREMENT_REPORT". */
interface RetirementReport {
  type: "RETIREMENT_REPORT";
  linkId: LinkId;
  registryVersion: RegistryVersion;     // the "closing" version that the link owner applied
  empty: boolean;                       // true: nothing reserved, held, offered or booked as maintenance from `position` on
  position: { seq: string; ts: HlcTs }; // link log position after the Registry(closing) entry
  counts: {                             // from `position` on; all 0 when empty = true
    confirmedParts: number; holds: number; offerHolds: number; maintenanceBookings: number;
  };
  envelopeRefused?: string;             // C08 EnvelopeCheck, when the link owner refused the closing envelope
}
```

## Semantics

### register_link

1. The registry looks up `action_id` first. A recorded answer is returned and no check runs
   again. The same `action_id` with another digest gets `action_id_reused`.
2. The registry runs C08 §E checks in C08's order. It calls `operator_check` at apply.
   Only role `commercial` is accepted (C08 action catalogue; X1-S13, X1-S23). A failed
   check gets `refused { check }` and is recorded by `audit_append`.
3. Check 6: `target_version` must be `"0"` and the `link_id` must have no record.
   A record with another `action_id` gets `link_id_taken`.
4. The scope must agree with these rules, else `invalid_registration`:
   - the two endpoints are different;
   - `share`: `initialCapacityMbps` is an integer ≥ 1;
   - `partner`: `initialCapacityMbps` is `null`.
5. The registry writes version 1, status `active`, and emits `registered`. Answer:
   `applied`, with the log position.

The registry does not check the supplier's onboarding state. That is RFC-005's job.

### retire_link (start, repeat, withdraw)

| Current status | `flags.withdraw` | Result |
|---|---|---|
| `active` | absent | New version, status `closing`, event `closing` with the envelope |
| `closing` | absent | New version, status stays `closing`, event `closing` with the new envelope. The link owner reports again |
| `closing` | `true` | New version, status `active`, event `reopened` |
| `active` or `retired` | `true` | `not_closing` |
| `retired` | absent | `not_active` |
| any, `kind = partner` | any | `partner_link_retirement_not_in_v1` |

Checks 1 to 5 are as for `register_link`. Check 6 at the registry: `target_version` must
equal the current version, else `refused { check: "target_version" }`.

### Retirement at the link schedule owner

1. The link owner applies each `closing` event as a `Registry(version, closing)` entry
   (RFC-001 §7.3). From that entry, the link sells nothing new: `hold` and `offer_hold`
   get `LINK_CLOSING`, `book_maintenance` gets `LINK_CLOSING`, and the link grants no
   waiter (C02 M-2, C03, RFC-001 §10).
2. The link owner verifies the event's envelope as a receiver (C08). For check 6 it uses
   the version it applied before this entry, which is `version − 1`. It calls
   `operator_check` at apply.
3. If the envelope check fails, the link owner still applies `closing` (to stop new sales
   is always safe). It records the refusal by `audit_append` and raises the alert
   `REGISTRY_ENVELOPE_REFUSED`. It sends a report with `empty = false` and
   `envelopeRefused` set.
4. If the check passes, the link owner computes the report from a position after the entry
   and sends it.
5. The registry applies a report only when `registryVersion` equals the current version and
   the status is `closing`:
   - `empty = true` and no `envelopeRefused`: new version, status `retired`, event
     `retired` with the report;
   - otherwise: the registry records the report, with no new version and no event. The
     commercial operator may send `retire_link` again later, or withdraw.
6. A report for another version, or for a status other than `closing`, is recorded and
   has no effect.
7. After `retired`, the link owner answers every command `LINK_RETIRED` (C02, C03).

### Registry version as `target_version`

For every operator envelope with target `{ kind: "link" }`, `target_version` is the
registry version (C03 M1; RFC-000 4.5; settled S1).

| Receiver | Its version | Check 6 |
|---|---|---|
| Registry (`register_link`, `retire_link`) | Current record version (`"0"` if none) | Not equal: `refused { check: "target_version" }` |
| Link schedule owner (`record_outage`, `record_restoration`) | Last registry version it applied | Above: `UNAVAILABLE` (the feed lags; retry). Below: `ENVELOPE_REFUSED(6)` (C03 M1, R39-07) |
| Link schedule owner (`retire_link` inside a `closing` event) | Version applied before the entry | As in "Retirement", step 2 |

The target summary of each receiver gives its own version. The console signs the version
of the receiver that will apply the action.

### Consumer semantics

| Consumer | What it uses | Rule |
|---|---|---|
| Link schedule owner | `closing`, `reopened`, `retired`; the version | One `Registry(version, change)` entry per event, in version order. Status and applied version come only from these entries |
| Placement (RFC-006) | `registered` with `kind = share` | Assigns a slot. The link's first entry is `Init(record, policy)` (RFC-001 §7.3). A partner link gets no slot |
| Catalogue (RFC-003 §6.1) | `get_link` | A `route` write is refused when a leg is `not_found` or `retired`. The route entry records `(linkId, version)` of each leg it checked. `closing` is accepted (the operator may reopen) |
| Attribution stage A (RFC-003 §4.4) | `registered` (supplier) | The supplier of a quarantine entry's link is `record.supplier`. It never changes. With no record in its projection, stage A calls `get_link`. `not_found` is treated as "no link": the entry goes to the exporter's owner (C11 S-1) |
| Edge (RFC-005 §3.4) | `registered` (supplier) | Coarse check of a supply command: a link whose supplier is not the principal's tenant gets "not found", with the same response-time floor as the link owner's `UNKNOWN_LINK` (C03 PT-1). An unknown link is sent on to the link owner. The link owner stays the authority |
| History (RFC-006) | Every event | Answers "link record as known at T" through C01 §2.8 |

A link with status `closing` or `retired` is not checked at the account owner's intake.
The link's answer to the hold decides it (C02 M-2; RFC-002 §3.2). The account owner then
rejects with `LINK_UNAVAILABLE(link)`, naming the link, with no counter-offer (P2-S120).

## Delivery and ordering

| Item | Delivery | Ordering scope | Partition key |
|---|---|---|---|
| Registry commands | Synchronous. Answered after the batch commits (C01) | Per link, the registry log order | Link partition |
| Feed events | At least once (C01 §3.5: direct, relay, republish) | Per link by `version` (= `stream_seq`). No order across links | `linkId` |
| Retirement report | At least once (C01 notification). No order | — | Registry partition of the link |
| `get_link` | Synchronous query. Reads the holder's committed state | — | — |

Consumers order by `stream_seq` and fill gaps from the registry outbox through their
`gapfill_<consumer>_link_registry` role (C01 §3.5). The feed carries no closure markers
(settled S7). A consumer does not wait for a registry position before it answers.

## Idempotency

| Operation | Key | Duplicate | Same key, different content |
|---|---|---|---|
| `register_link`, `retire_link` | (link, `action_id`) at the registry. Looked up before checks 3 to 6 | The recorded `EnvelopeAnswer`. No check runs again | `refused_by_rule { action_id_reused }`, alerted. Nothing changes |
| Feed event | (`linkId`, `version`) = (partition, stream, `stream_seq`) | Dropped | The database copy wins; the stream blocks at that version; `FEED_CONTENT_CONFLICT` (C01 D3) |
| Retirement report | (`linkId`, `registryVersion`) | Dropped | The first is kept; alerted (C01 §5) |
| `Registry` entry at the link owner | (`linkId`, `version`) | The recorded outcome | Impossible (the feed rule above) |
| `link_id` | — | — | Never reused. A link that ends is retired and a new registration takes a new `link_id` |

## Ownership

| Data | Sole writer | May read |
|---|---|---|
| Link records, registry log, topic `link_registry.links.v1` | Link registry, owner kind `link_registry` (settled S7). Producer ACL: `link_registry-holder`, `link_registry-relay` only (C01 §2.5) | The consumers in the header, by the feed or `get_link` |
| Retirement report | Link schedule owner | Link registry |
| Status in force at the link (`active`, `closing`, `retired`) | Link schedule owner, from `Registry` entries | Through C02 and C03 answers only |
| `get_link` | Served by the registry | Workload principals of the consumers in the header. Not suppliers or buyers. Supplier views go through RFC-005 |

The feed and the log hold pseudonymous identifiers only. Free text stays in the RFC-005
envelope and case note (A11).

## Timeouts and deadlines

| Item | Value |
|---|---|
| Registry command deadline at the console | 5 s (est.). On `temporarily_unavailable` or a lost answer, send the same envelope again |
| `get_link` deadline | 1 s (est.). `unavailable`: retry with backoff |
| Feed gap timeout | 5 s, then gap fill (C01 `gap_timeout`) |
| Consumer lag alert | `LINK_REGISTRY_LAG` when a consumer is more than 60 s behind the topic end (est.) |
| Envelope expiry | `not_after`, 72 h (C08) |
| Waiter on a link that becomes `closing` | Ends at its own deadline, at most 60 s (C02; settled S2) |
| Retention | Registry entries and events: 7 years (C01 `'7y'`) |

## Versioning and compatibility

- A frozen version of this contract is tagged `contract-C13-vN`.
- Topic `link_registry.links.v1`. To add an optional field is a minor change. A consumer
  ignores a field that it does not know.
- To add a `RegistryChange` value, a `LinkStatus` value or a `RegistryRule` value, or to
  change a field's meaning, is a major change. It needs a new contract version and a new
  topic version. Both topics are published until each consumer has moved.
- `kind`, `supplier` and `endpoints` are immutable in every version.
- `schemaVersion` and `schema_v` change together. Decoders are kept 7 years.
- A consumer that gets an unknown `change` stops that link's stream and alerts.

## Scenarios relied on (`requirements-v1.11`)

| Scenario | What C13 gives |
|---|---|
| P2-S120 | `closing` reaches the link owner, which answers `LINK_CLOSING` with no tombstone |
| X1-S31 | Commercial registers a link with its capacity, and retires an empty link, with the audit fields |
| X1-S13 | Network operations is refused `register_link` |
| X1-S23 | Network operations is refused "register a new link for s1" |
| X1-S22 | Link → supplier for the edge's coarse check; the link owner stays the authority |
| X1-S04 | Another supplier's link answers as one that does not exist |
| P3-S26 | Quarantined traffic is reported to the supplier of the link it crossed |

## Conformance tests

### Provider (RFC-001: registry, and the link owner's report)

| ID | Test |
|---|---|
| PT-1 | `register_link` by commercial: version 1, `registered`, full record, audit fields. A repeat with the same `action_id` gets the same answer and no second event |
| PT-2 | Roles: network operations, finance, support and compliance get `refused { check }`; nothing changes; the attempt is recorded (X1-S13, X1-S23) |
| PT-3 | `link_id_taken`; `invalid_registration` for equal endpoints, capacity 0, a fractional capacity, a partner link with a capacity; `action_id_reused` |
| PT-4 | Check 6 at the registry: a stale `target_version` on `retire_link` is refused; `"0"` on a registered link is refused |
| PT-5 | Retirement: `closing` → report `empty = true` → `retired`. With a confirmed part, a hold, an offer hold or a maintenance booking: report `empty = false`, no `retired`. Repeat `retire_link` gives a new version and a new report. Withdraw gives `reopened`, and the link sells again |
| PT-6 | A report for an older version, or after `reopened`, has no effect |
| PT-7 | The link owner applies `closing` when the closing envelope's check fails, alerts, and reports `empty = false` with `envelopeRefused` |
| PT-8 | Partner link: `retire_link` gets `partner_link_retirement_not_in_v1` |
| PT-9 | Feed: one event per version, contiguous from 1; the direct and relay copies are byte-identical; only the two producer principals can write the topic |
| PT-10 | Target summaries: the registry's `target_version` is the record version; the link owner's is its applied registry version (CI-R1-1) |

### Consumers

| ID | Side | Test |
|---|---|---|
| CT-1 | Link schedule owner | Events in version order become `Registry` entries. A duplicate is dropped. A gap is filled. Check 6 on `record_outage`: above the applied version `UNAVAILABLE`, below `ENVELOPE_REFUSED(6)` |
| CT-2 | Link schedule owner | From `Registry(closing)`: `hold`, `offer_hold`, `book_maintenance` get `LINK_CLOSING`, no tombstone, no grant to a waiter (RFC-001 T-22) |
| CT-3 | Placement | A `registered` Share link gets a slot and `Init`. A partner link gets none. A duplicate event makes no second slot |
| CT-4 | Catalogue | A route with an unknown or retired leg is refused. A `closing` leg is accepted. The route entry records each leg's `(linkId, version)` |
| CT-5 | Attribution stage A | A quarantine entry gets the link's supplier from the projection, or from `get_link`. `not_found` goes to the exporter's owner (P3-S26) |
| CT-6 | Edge | A supply command from another supplier's principal on a known link gets "not found" with the same latency distribution as an unknown link (two-sample test, p > 0.05; X1-S22) |
| CT-7 | Every consumer | An unknown `change` stops that link's stream and alerts. A content conflict follows C01 D3 |

## Settled

Each point below is a conflict or a gap between sources. It is settled in favour of the
frozen contracts. Each one is final for C13 v1.

| # | Point | Sources in conflict | Settled reading |
|---|---|---|---|
| S1 | `target_version` of a `link` target | C08 consumer obligations (RFC-001 row): "the link log's last sequence". C03 settled M1, RFC-000 4.5 and RFC-001 CI-R1-1: the registry version | **Registry version** at every receiver. C08 erratum owed |
| S2 | Waiters on a link that becomes `closing` | RFC-001 §10 and R1-19: "RFC-002 learns of `closing` from the registry feed". RFC-002 rev. 6 §3.2 and its rejected alternative: the account owner has no registry input. Frozen C02 has no `WAITER_REFUSED(LINK_CLOSING)` | The account owner is **not** a C13 consumer. The link grants no waiter after `closing`. The waiter ends at its own deadline (at most 60 s). An additive C02 change (CI-R1-3) is outside C13. RFC-001 erratum owed |
| S3 | Probe flag of a link | RFC-001 §10: `probe` field and `set_probe` on the registry. C01 §3.10 and C06 (`probe_designation`, C06-M14): the catalogue holds link probe designations | **Not in C13.** The authority is `catalogue.v1` `probe_designation { link }`. The link owner and other consumers read it there. RFC-001 erratum owed (drop `probe` and `set_probe` from §10, §7.3, §11) |
| S4 | Observation point → link mapping | Task brief: "as RFC-001 publishes it". RFC-000 AI3-8 and C11 S-1: provisioning's `ObservationPointFact` | **Not in C13.** C11 holds it |
| S5 | Sellable and physical capacity | Task brief: "capacity class". RFC-001 §3.1 and C03: schedule quantities | **Not in C13.** C13 holds `kind` and `initialCapacityMbps` (`C_ref`) only. C03 holds `K_s`, `K_p` |
| S6 | Routes | Task brief lists routes for RFC-002. C06 `route` entity | **Not in C13.** Routes are C06. The catalogue checks legs with `get_link` |
| S7 | Owner kind, topic, closure | RFC-001 §10: "the catalogue's link-registry partition". C06-M14 (D7): only the catalogue writes `catalogue.v1`. C01 M7: six closure streams, the registry not one | Owner kind **`link_registry`** (deployed with RFC-003's catalogue), topic `link_registry.links.v1`, its own producer ACL, `closure: 'none'` |
| S8 | Reopen a `closing` link | RFC-001 §10: the operator "may reopen". C08 action catalogue: no reopen action | `retire_link` with `flags.withdraw = true`. No change to C08's catalogue |
| S9 | Target of `register_link` | C08 `Target { kind: "link" }` needs a `link_id` before the link exists | The signing client makes a new `Id128` `link_id`. The summary answers `not_found`. `target_version = "0"` |
| S10 | Retirement of a partner link | RFC-001 §10 defines retirement only through the link schedule owner's report. No RFC defines a report for a partner link | Refused `partner_link_retirement_not_in_v1` |
| S11 | Change of supplier, kind or endpoints | No RFC defines one | Immutable. Retire and register a new `link_id` |
| S12 | Transport of the retirement report | RFC-001 §10: "the owner then reports". No transport given | C01 notification, identity (`linkId`, `registryVersion`, `RETIREMENT_REPORT`) |

## Errata owed

| Document | Erratum |
|---|---|
| RFC-001 | §10, §7.3, §11: drop `probe` and `set_probe` (S3); "RFC-002 learns of `closing` from the registry feed" becomes "the waiter ends at its deadline" (S2); reopen by `withdraw` (S8); report as a C01 notification (S12); owner kind `link_registry` (S7); check 6 for the closing envelope uses `version − 1`; partner retirement refused (S10) |
| RFC-003 | §6.1: route legs checked by `get_link`, version recorded; §4.4: supplier from C13 |
| RFC-005 | §3.4: edge cache from C13 with the response-time floor; console signs the receiver's registry version |
| RFC-006 | Placement consumes `registered`; owner declaration for `link_registry` with consumers `link`, `placement`, `catalogue`, `attr_a`, `history`, and the RFC-005 edge as a subscriber |
| C08 | Consumer obligations, RFC-001 row: `target_version` = registry version (S1); `register_link` with `target_version "0"` (S9) |
| RFC-000 | §8: add a row "Link registry feed and commands" that points to C13 |
