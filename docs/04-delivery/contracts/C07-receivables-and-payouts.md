# C07. Receivables and payouts

| | |
|---|---|
| Contract ID | C07 |
| Name | receivables-and-payouts |
| Version | 1 (draft) |
| Status | **Draft**, for contract review. Every mismatch is settled by the orchestrator's binding decisions (see "Settled"); none is open |
| Provider | RFC-004 (receivables, payments, payouts, reconciliation; Part A semantics of the credit-limit command). RFC-005 (identity and access) for operation 5, the payout-destination query (RFC-000 §8 lists it as C16 of RFC-005) |
| Consumers | RFC-002 (account owner: applies the invoice-status feed and the credit-limit command). RFC-005 (operator console: sends the credit-limit command; edge payment ingress and the authenticity verifier, RFC-005 C7, in front of operations 3 and 4). RFC-004 payouts (reads operation 5). External: payment providers, payout providers, the payment partner |
| Transport | Op 1: Kafka event (receivables' outbox and changefeed relay). Op 2: HTTP (gRPC), synchronous command. Op 3, op 4: HTTP, external API (inbound notifications and reports; outbound instructions). Op 5: HTTP (gRPC), synchronous query. No cross-owner database read |
| Pinned to | `requirements-v1.10`; RFC-000 revision 4.4 (§8 rows: invoice-status feed, credit-limit command, payment notification ingress, payout instruction and transfer confirmation and partner reports, payout destination; errata 4.4 points C4-5, C4-6); RFC-004 revision 5 with erratum 5.1 (§A3, §A4 F5/F6 and the gate, §B4, §B5, §B6, §B7, §B9, §B12); RFC-002 revision 5 (§2.3 F5/F6, §7.3, §13.1); RFC-005 revision 5 (§7.4, C7, C16) |
| Depends on | **C08** (operator envelope and its verification, RFC-005 §7.4; op 2 references it and does not restate it). RFC-005 C7 (authenticity verifier). RFC-006 rev. 6 `probe_account_set(v)` and `probeSetSummary(v)` (shown at approval; not part of this contract) |

## Purpose

The money edges of S-MONEY that cross an owner boundary:

1. **Invoice-status feed**: receivables tells the buyer's account owner that an invoice
   became overdue, was paid, was written off, or that a write-off removed the credit
   limit, each gated on the buyer ledger position it was decided from (A-1, J-05).
2. **Credit-limit command**: a finance operator sets or removes an account's credit
   limit, including the set-scoped action over designated probe accounts.
3. **Payment notification ingress**: providers notify completed top-ups, invoice
   payments, supplier-debt payments and reversals.
4. **Payouts and partner reports**: payout instructions to payout providers, their
   transfer confirmations and failures, and the payment partner's, providers' and banks'
   reports for daily reconciliation.
5. **Payout destination query**: payouts reads the supplier's destination in force at a
   payout run's cut from identity.

## Common types and units

```ts
// Money
type Micros = string;        // integer micro-USD (10^-6 USD) as a decimal string, e.g. "120000000"
type ProviderAmount = string; // decimal string in the provider currency's MAJOR unit, at most
                              // `minor_exponent` fraction digits, e.g. "15540" (KES), "12.34" (USD)
type Currency = string;       // ISO 4217, e.g. "USD", "KES"
type Rate = string;           // exact decimal string, provider-currency units per 1 USD, e.g. "129.5"

// Time
type Timestamp = string;      // ISO 8601 UTC with microseconds, e.g. "2026-10-12T00:00:00.000000Z"
type CommitTs = string;       // database commit timestamp (HLC), decimal "<wall_ns>.<logical>",
                              // e.g. "1791763200000000000.0000000000"; compared numerically

// Identities (pseudonymous; never personal data, RFC-000 A11)
type AccountId = string;
type SupplierId = string;
type InvoiceId = string;
type ActionId = string;       // operator action identifier from the C08 envelope

// Positions
type LedgerPos = { ledger_partition: string; seq: string };  // (partition, sequence) of the ledger
                                                             // partition log, RFC-004 §B1.3; seq integer string
type RcvPos = { rcv_partition: string; epoch: string; seq: string }; // receivables log position
type AccountLogPos = { account: AccountId; seq: string };    // the account owner's log position
```

Durations below are stated with their unit (ms, s, h, days).

## Operation 1. Invoice-status feed (receivables → account owner)

### Schema

Topic `money.receivables.invoice-status.v1` (name per RFC-006 substrate conventions),
key = `account`, value JSON:

```ts
type InvoiceStatusEvent = {
  schema: "invoice-status/1";
  account: AccountId;
  pos: RcvPos;              // identity of the event: (rcv_partition, epoch, seq)
  ledger_pos: LedgerPos;    // the buyer partition's ledger position receivables had applied
                            // when it decided the event
  decided_at: CommitTs;     // commit timestamp of receivables' deciding entry
  event:
    | { type: "InvoiceOverdue"; invoice: InvoiceId; unpaid: Micros; due_date: Timestamp }
    | { type: "InvoicePaid"; invoice: InvoiceId }
    | { type: "InvoiceWrittenOff"; invoice: InvoiceId; amount: Micros }
    | { type: "CreditLimitRemoved"; reason: "invoice_written_off"; invoice: InvoiceId };
};
```

### Semantics

| Event | Emitted when (RFC-004 §B5) | Applied by the account owner as | Effect (RFC-004 §A4, §A7) |
|---|---|---|---|
| `InvoiceOverdue` | Invoice unpaid at `due_date` = issue + `invoice_terms` (30 days) | F6 *overdue* | Adds the invoice to `OD`; standing cause `invoice` |
| `InvoicePaid` | Paid in full by an invoice payment (M2) or by a top-up's allocation (M1); `ledger_pos` is that movement's position | F6 *paid* | Removes it from `OD`; standing re-evaluated |
| `InvoiceWrittenOff` | 90 days after `due_date`, unpaid, once receivables has applied the M19 from the ledger feed; `ledger_pos` is the M19's | F6 *written off* | Removes it from `OD` (a no-op if the M19's F1 already did, D-4) |
| `CreditLimitRemoved` | With every `InvoiceWrittenOff`, same `ledger_pos` | F5 *removed: invoice written off* | `CL` removed; account books prepaid until finance sets a limit again |

- **Ledger-position gate** (the defining rule of this feed). The owner composes an event
  only once its applied ledger position (the last F1's) has reached `ledger_pos.seq` in
  `ledger_pos.ledger_partition`. Until then it is **held**, in memory and in the owner's
  `funds_*` held-events row, never dropped; it is composed in the batch after the F1 that
  reaches it. An event at or below the applied position is composed at once.
- Events are applied in arrival order per account, which is receivables' sequence order
  per account (per-account sequences are increasing, not contiguous).
- An event whose `ledger_partition` is not the account's buyer partition is held and
  alerted, never applied (contract choice; the RFCs never produce it).
- An unknown `event.type` or `schema` is held and alerted, never skipped, since skipping
  would break per-account order.
- No error is returned to the producer; the feed is one-way.

### Delivery and ordering

At least once. Published by receivables after commit from its outbox, and by the
changefeed relay as the guaranteed path (RFC-000 §5.5); both may deliver the same event.
Partition key `account`, so ordering is per account; no ordering across accounts, and
none between this feed and the credit-limit command (both land in the one account log,
whose order is the order of record). The consumer commits its Kafka offset only once the
entry (or held-event row) commits, so a held event survives an owner change (RFC-002
§12.2 S11).

### Idempotency

Key `(rcv_partition, epoch, seq)`. The owner records `rcv_pos`; an event with `seq ≤
rcv_pos.seq` is a duplicate and changes nothing. Same key with different content cannot
arise from a single-writer log; if seen it is dropped and alerted.

## Operation 2. Credit-limit command (operator console → account owner)

### Schema

gRPC `FundsCommand.ApplyCreditLimit`, routed to the account's owner by slot:

```ts
type CreditLimitCommand = {
  envelope: OperatorEnvelope;   // C08 (RFC-005 §7.4). action_type is "set_credit_limit" or
                                // "remove_credit_limit"; action_id; reason_code; target and
                                // target_version; for a set-scoped action, target is the set
                                // descriptor "designated probe accounts at slot-map version v"
                                // with target_version = v, and `member` (outside the digest)
  account: AccountId;           // the owner's partition; equals envelope.member when set-scoped
  op: { kind: "set"; amount: Micros } | { kind: "remove" };
};

type CreditLimitAnswer =
  | { outcome: "applied"; action_id: ActionId; account: AccountId;
      position: AccountLogPos;            // the F5 entry
      standing: { state: "active" | "suspended";
                  causes: Array<"headroom" | "invoice" | "written_off">;
                  std_seq: string } }
  | { outcome: "refused"; action_id: ActionId; account: AccountId;
      reason: "out_of_scope" | "kyb_not_vetted" | "unauthorised" | "invalid" | "conflict";
      failed_check?: 1 | 2 | 3 | 4 | 5 | 6;   // C08 check number, with "unauthorised"
      position?: AccountLogPos };           // the F5 recording the refusal, when recorded
```

`reason` (RFC-004 F5 "reason") is `envelope.reason_code`; `action_id` is
`envelope.action_id`. They are not repeated in the body.

### Semantics

Checks, in this order; the first that fails decides the answer:

1. **Envelope** (C08 checks 1 to 5, and check 6 for a single-account target:
   `target_version` current). Fails → `refused{unauthorised, failed_check}`.
2. **Scope, set-scoped only** (C08 check 6 for a set descriptor): the envelope applies to
   `member` iff `member` equals this account **and** the owner's applied F9 marks it a
   designated probe account (`excluded` on). The signed slot-map version v
   (`target_version`) is **not** a membership check: it is recorded with the applied
   action, beside the slot-map version that designated the account (which F9 records),
   for audit. Checking membership at v would deadlock new-slot publication, since a slot
   is published only after its probe account's limit is applied (settled S1). Fails →
   `refused{out_of_scope}`. Checked with the envelope, **before** KYB.
3. **Deduplication**: `action_id` already applied or refused in this account's log →
   the first answer, unchanged; with a different `op` or amount → `refused{conflict}`,
   recorded, no change (RFC-004 §B9).
4. **Validity**: `amount` a non-negative integer of micros → else `refused{invalid}`.
5. **KYB** (`set` only): applied KYB status (F4) not passed → `refused{kyb_not_vetted}`,
   recorded, no change (P4-S82). `remove` is not subject to KYB.
6. **Apply**: F5 *set* sets `CL` and credit-limit mode, relabels holds, evaluates
   standing (a lower limit can suspend, P4-S18); F5 *removed by operator* removes `CL`.
   → `applied{position, standing}`.

Refusals at steps 2, 3 and 5 are recorded as entries and change nothing; the console
records every answer. The answer is sent only after the entry commits.

**Set-scoped action** (probe accounts): one signed action, one amount, one reason, sent by
the console as one envelope per member account under the one `action_id`, each naming
its `member`. The owner applies it once per (`action_id`, account). The action's outcome
is the console's list of per-member answers; the console resumes a crashed fan-out from
that record. **A refused member is not retried under that action**: it is covered by a
new set-scoped action signed after the cause is fixed (RFC-005 review 30 Y-1; RFC-004
review 31 K-2).

### Delivery and ordering

Synchronous, request-reply. The console retries each envelope with the same `action_id`
until it gets an answer (exactly-once effect by the owner's deduplication). No ordering
across accounts; per account, an F5 applies in log order, after the F4 that passed KYB if
it is to succeed.

### Idempotency

Key (`action_id`, account). Duplicate → the first answer. Same key, different content →
`refused{conflict}`, recorded. Retention: the account log (7 years for money identities,
P4-S100).

## Operation 3. Payment notification ingress (payment providers → payments)

### Schema

`POST /v1/payments/notifications/{provider}` at the edge (RFC-005 C7), body as the
provider sends it. The edge verifies it (C7 `verify(provider, request)`), normalises it
and routes it by (provider, `provider_txn_ref`) to the payments partition's owner:

```ts
type PaymentNotification = {
  provider: string;                 // provider id; the provider principal for POL-29
  provider_txn_ref: string;
  kind: "completed_topup" | "completed_invoice_payment"
      | "completed_supplier_debt_payment" | "reversed";
  account_ref: AccountId | SupplierId; // buyer account; supplier for a debt payment
  amount: ProviderAmount;           // > 0, whole number of the currency's minor unit
  currency: Currency;
  minor_exponent: number;           // e.g. 2 for USD, KES
  quote_ref?: string;               // top-up FX quote (RFC-004 §B4.3)
  invoice_ref?: InvoiceId;          // invoice payment
  occurred_at: Timestamp;           // provider's time
  received_at: Timestamp;           // set by the edge on receipt
};

type IngressAnswer =   // HTTP response body
  | { result: "accepted"; state: "bound" | "pending_reversal" | "reversed" }  // 200
  | { result: "duplicate" }                                                    // 200
  | { result: "mismatch_recorded" }                                            // 200
  | { result: "malformed"; reason: string }                                    // 422, permanent
  | { result: "not_authentic" }                                                // 401
  | { result: "principal_refused" }                                            // 403
  | { result: "retry" };                                                       // 503 + Retry-After (s)
```

### Semantics (RFC-004 §B4.1, §B4.2)

| Case | Answer | Effect |
|---|---|---|
| Not proven authentic | `not_authentic` | Nothing moves; recorded in the provider's investigation stream; no binding (X1-S10) |
| Malformed (unknown kind, amount ≤ 0 or not a whole minor unit, no provider or account reference) | `malformed` | Recorded without a binding; nothing moves (P4-S05) |
| First well-formed completed event | `accepted{bound}` | Binding (provider, txn ref) → (account, kind, amount, currency, quote); movement M1/M2/M20 via the outbox |
| First event is `reversed` | `accepted{pending_reversal}` | Held 72 h for its completion; then payment and reversal posted in order, or escalated, never applied alone (P4-S02, P4-S03) |
| Same contents again | `duplicate` | Nothing (P4-S01, P4-S57, P4-S100) |
| Same reference, different account, amount or currency | `mismatch_recorded` | Nothing moves; reported to reconciliation (P4-S04) |
| Same reference, different provider principal | `principal_refused` | Nothing (POL-29) |
| Not yet committed (owner unavailable, failover) | `retry` | Nothing durable; the provider redelivers |

Conversion to micros is RFC-004 §B4.3 (USD exact; quote within `fx_quote_validity`, 15
min, rounded up; else the partner's rate at receipt).

### Delivery and ordering

At least once from the provider; any order (a reversal may precede its payment).
Exactly-once effect by the binding. Every 2xx and 4xx answer is given only after the
event's transaction commits in two regions (X2-S14); a provider is never told
`accepted` for an uncommitted event.

### Idempotency

Key (provider, `provider_txn_ref`, `kind`); binding by (provider, `provider_txn_ref`),
kept 7 years. Duplicate → `duplicate`; same key, different content → `mismatch_recorded`.

## Operation 4. Payout instruction, transfer confirmation, partner reports

### 4a. Payout instruction (payouts → payout provider)

`POST {provider_base}/payouts` with header `Idempotency-Key: <instruction_ref>`:

```ts
type PayoutInstruction = {
  instruction_ref: string;     // "(supplier, run, n)" encoded "po:<supplier>:<run>:<n>",
                               // unique 7 years; the provider's idempotency key
  amount: ProviderAmount;      // K = floor_minor(pay × rate), RFC-004 §B7.5
  currency: Currency;
  destination: DestinationDetails; // from op 5; transient, never logged or stored by payouts
};
// Recorded by payouts with the instruction (not sent): lots [{lot_id, usd: Micros}],
// usd_debited: Micros (P = floor_µ(K / rate)), rate: Rate, residue: Micros,
// destination_ref, destination_version.
```

The synchronous HTTP response is a transport receipt only; outcomes arrive as 4b. On a
transport timeout or 5xx, payouts resends the **same** instruction (same reference, same
`destination_ref` and version, details re-read by op 5's second form).

### 4b. Transfer confirmation or failure (payout provider → payouts)

`POST /v1/payouts/reports/{provider}` at the edge, verified by C7, routed by
`instruction_ref` to the supplier's payouts partition:

```ts
type TransferReport = {
  provider: string;
  instruction_ref: string;
  provider_ref: string;                 // recorded
  outcome: "confirmed" | "failed";
  final: boolean;                       // for "failed"
  amount?: ProviderAmount; currency?: Currency;
  occurred_at: Timestamp;
};
// Answer: 200 {result: "recorded" | "duplicate" | "escalated"}; 401 not_authentic;
// 403 principal_refused; 503 retry.
```

| Case | Effect (RFC-004 §B7.1, §B7.3) |
|---|---|
| First confirmation of a lot | M15 (paid) |
| Confirmation of a lot already paid | M16 "duplicate payout" debt; escalated (P4-S95) |
| Confirmation after a final failure | Escalated; M15 or M16 posted; lot in no new payout while open (P4-S87) |
| Non-final failure | Nothing; instruction stays in flight |
| Final failure | Lots payable again: paid in the next run under a new reference (P4-S86) |
| Unknown `instruction_ref` | Escalated to finance |
| Repeat | No further effect (P4-S79) |
| No answer in `payout_confirmation_timeout` (7 days) | Escalated, never re-instructed (P4-S88) |

### 4c. Partner reports (payment partner, providers, banks → reconciliation)

`POST /v1/reconciliation/reports/{source}`, verified by C7:

```ts
type PartnerReport = {
  source: string;
  report_id: string;
  version: number;
  kind: "partner_statement" | "provider_settlement" | "bank_statement";
  day: string;                          // D, "YYYY-MM-DD" UTC
  funds_held_usd?: Micros;              // partner_statement: funds at end of D
  transactions: Array<{ reference: string;
                        kind: "credit" | "debit"; // credit: top-up, invoice or debt payment; debit: payout
                        usd: Micros; time: Timestamp; provider?: string }>;
};
// Answer: 200 {result: "recorded" | "duplicate"}; 401; 409 conflict; 503 retry.
```

A new `version` produces a new version of the run for D (RFC-004 §B6.4). The same
(`source`, `report_id`, `version`) with different content is refused `409 conflict` and
alerted (contract choice; the RFCs are silent).

### Delivery and idempotency (op 4)

| Message | Delivery | Key | Duplicate | Same key, different content |
|---|---|---|---|---|
| Instruction | At least once to the provider; exactly-once effect at the provider by `Idempotency-Key` | `instruction_ref` | Provider returns the original | Never sent (generated once) |
| Run | Once per (supplier, week) | (supplier, week) | Finds the run, pays nothing again (P4-S46) | — |
| Transfer report | At least once, any order | `instruction_ref` (+ `provider_ref` recorded) | No effect | Escalated |
| Partner report | At least once | (`source`, `report_id`, `version`) | `duplicate` | `409 conflict`, alerted |

## Operation 5. Payout destination query (identity → payouts; RFC-005 C16)

### Schema

```ts
// gRPC IdentityPayouts
PayoutDestinationAt(req: { supplier: SupplierId; at: CommitTs })   // at = the run's cut T_w
  → { destination_ref: string; version: string; details: DestinationDetails }
PayoutDestinationVersion(req: { destination_ref: string; version: string })
  → { details: DestinationDetails }
// Errors: NOT_FOUND ("not found": unknown supplier, or no version in force at `at`);
//         UNAVAILABLE ("temporarily unavailable": personal-data store unavailable)

type DestinationDetails =        // personal data; never logged, never stored by payouts
  | { kind: "bank"; account_name: string; account_number: string; bank_code: string; country: string }
  | { kind: "mobile_money"; network: string; msisdn: string; country: string };
```

### Semantics

- **Version in force at `at`** (binding C4-6): identity resolves it from the destination's
  **version history** in its own log and projection, each version with its commit
  timestamp `c`: the version with the greatest `c ≤ at`. It is **not** a consistent
  (`AS OF SYSTEM TIME`) read at `at`, so a call hours or days after the cut answers the
  same version. Details are a personal-data-store item keyed by (`destination_ref`,
  version), read by identity (`get`, purpose "payout destination") for this request only.
- **When a change applies** (binding C4-5; POL-22, P4-S118): a change committed at `c`
  applies to runs whose cut `T_w ≥ c`. A run already started (its cut before `c`) keeps
  the destination it resolved for every one of its instructions, including resends.
- **Re-instruction**: a resend of the same instruction (same `instruction_ref`) uses the
  recorded (`destination_ref`, version) through `PayoutDestinationVersion`. A lot paid
  again after a final failure is a **new** instruction in a later run, resolved at that
  run's cut, so it goes to that run's destination (P4-S118 row 3).
- **Recovery hold** (binding C4-5; X1-S46): a destination change by a supplier
  administrator held in a recovery is **refused** by identity ("refused during recovery
  hold"), the destination unchanged and the attempt recorded; no version is created, so
  this query never sees it. After the hold ends without objection the administrator's
  change is an ordinary change and applies from the next run. The change command and the
  notice to every supplier administrator are identity's (RFC-005 §3.2, C16 command), not
  part of this contract.
- **Payouts' use** (RFC-004 §B7.1): records `destination_ref` and version on the
  instruction, never the details; `UNAVAILABLE` → the run waits for that supplier and
  retries; `NOT_FOUND` → the supplier's lots are escalated to finance and nothing is
  instructed.
- Payouts is a reader of the store only through identity; it never calls the store.
- Precondition: `at` is a past commit timestamp (a cut is taken below the closed
  timestamp). Identity, the single writer of the history, answers from its own state.

### Delivery and idempotency

Read-only; any number of retries; same request, same answer (until a store item is
erased after its retention, then `NOT_FOUND`). Each version's store item is kept while
any instruction may reference it (until the supplier's last payout under it is final and
reconciled, then as long as payout records need it).

## Ownership

| Data | Writer | Readers |
|---|---|---|
| Invoice-status topic | Receivables (RFC-004), outbox and relay only | Account owner (RFC-002) |
| `rcv_pos`, held invoice-status events, F5, F6 | Account owner (RFC-002) | Account owner; status replicas |
| Credit-limit command | Operator console (RFC-005) sends; account owner appends F5 | Console records per-member answers |
| Bindings, investigation stream, payment event log | Payments partition (RFC-004) | Reconciliation, reporting (via feeds) |
| Runs, lots, instructions, confirmations, escalations, debt register | Payouts partition (RFC-004) | Reconciliation, reporting (via feeds) |
| Partner reports, runs for D | Reconciliation partition (RFC-004) | Finance, reporting |
| Destination versions | Identity (RFC-005) | Payouts, through op 5 only |
| Destination details | Personal-data store, via identity | Identity, for the request only |

## Timeouts and deadlines

| Where | Value | Behaviour |
|---|---|---|
| Op 1 gate | Unbounded | Held until the ledger position is reached; within X2-S07's 10 s end to end in the normal path (RFC-004 §A7) |
| Op 2 call | Per-call deadline 5 s (contract choice; about 100 ms est.) | Console retries with the same `action_id`; refused (C08 check 5) once past `not_after − ε` (`approval_expiry` 72 h) |
| Op 2 set-scoped fan-out | About 16,384 members, 200 in parallel, under 10 s (est.) | Resumed from the console's record |
| Op 3 | Answer only after commit; top-up credited within 10 s of the notification (X2-S07) | `retry` (503) with Retry-After in seconds when not committed |
| Op 3 orphan reversal | 72 h | Escalated, never applied alone |
| Op 4a/4b | `payout_confirmation_timeout` 7 days | Escalated, never re-instructed |
| Op 4c | Inputs by about 06:00 UTC on D + 1; incomplete run at 12:00 UTC on D + 1 | Alert to finance (P4-S81); `settlement_lag_max` 7 days for `Pnr` items |
| Op 5 call | Per-call deadline 2 s (contract choice) | Deadline exceeded is treated as `UNAVAILABLE`: the run waits and retries |

## Versioning and compatibility

- Contract version 1; JSON events carry `schema` (`invoice-status/1`); gRPC packages are
  versioned `v1`; HTTP paths `/v1/`.
- Compatible changes (same major): adding optional fields; consumers ignore unknown
  fields. Adding an event `type`, a refusal `reason`, a `kind` or an error is
  **incompatible** for op 1 and op 2 (an unknown type is held, not skipped): the consumer
  ships support first, then the producer emits it, under a new minor version recorded
  here.
- Removing or renaming a field, changing a unit, or changing a key or ordering scope is
  a new major version on a new topic or path, run side by side until the old is drained.
- External provider formats are adapted at the edge into the types above; a provider
  format change never changes this contract.

## Scenarios relied on

`requirements-v1.10`:

- Op 1: P4-S14, P4-S18, P4-S83, P4-S93, P4-S94, P4-S105, P4-S111, P4-S114; P2-S42,
  P2-S69 (RFC-002 T14).
- Op 2: P4-S82, P4-S18, X2-S24, X2-S27.
- Op 3: P4-S01, P4-S02, P4-S03, P4-S04, P4-S05, P4-S06, P4-S07, P4-S57, P4-S58, P4-S100,
  P4-S103, X1-S10, X2-S07, X2-S14.
- Op 4: P4-S43 … P4-S50, P4-S78, P4-S79, P4-S86, P4-S87, P4-S88, P4-S95, P4-S117 (debt
  netting); P4-S54, P4-S80, P4-S81, P4-S90, P4-S104, P4-S106, P4-S109, P4-S113.
- Op 5: P4-S118, X1-S46.

## Conformance tests

**Provider side (receivables, payments, payouts, reconciliation; identity for op 5).**

| # | Test | Op |
|---|---|---|
| P1 | Every write-off emits `InvoiceWrittenOff` and `CreditLimitRemoved` with the M19's `ledger_pos`; every `InvoicePaid` from a top-up carries the M1's position; per-account `seq` strictly increasing across owner failover; relay and direct duplicates share `pos` | 1 |
| P2 | Notification matrix: authentic/unproven × well-formed/malformed × first/repeat/different content/different principal × reversal-first; answers and effects as the op 3 table; no 2xx/4xx before commit (kill before commit → `retry`) | 3 |
| P3 | Every permutation and triplication of a notification set gives the same bindings and postings (RFC-004 §B13) | 3 |
| P4 | Instructions: one per lot per run; resend after timeout uses the same `instruction_ref` and destination version; injected provider behaviours (duplicate, false final failure, late, none) never instruct a lot twice and raise M16 for a second execution | 4 |
| P5 | Partner report same (source, id, version) twice → `duplicate`; changed content → `409`; new version → new run version | 4 |
| P6 | Destination history: versions at c1 < c2; `at` in [c1, c2) → v1, `at = c2` → v2; the same call repeated days later answers the same; `PayoutDestinationVersion` returns the recorded details; unknown supplier → `NOT_FOUND`; store down → `UNAVAILABLE`; no details in any log | 5 |
| P7 | X1-S46: a held administrator's change is refused, no version created, op 5 unchanged; after the hold, the change applies from the next run | 5 |

**Consumer side.**

| # | Test | Op |
|---|---|---|
| K1 | Account owner: invoice-status events delivered before, with and after the F1 reaching their `ledger_pos`, across owner failover; standing changes only in ledger order; duplicates (both publish paths) change nothing; unknown type is held and alerted (RFC-002 T14, RFC-004 §B13 gate test) | 1 |
| K2 | Account owner: credit-limit commands with valid, expired, cancelled and wrong-role envelopes (C08); `set` without KYB → `kyb_not_vetted`; repeat → first answer; changed amount under same `action_id` → `conflict`; `remove` without KYB applies | 2 |
| K3 | Set-scoped: `member` ≠ receiving account, or applied F9 not designated → `out_of_scope` even without KYB (order); a probe account designated at a slot-map version later than the envelope's v is accepted (v not checked), and the applied F5 records v and the designating version; member without KYB → `kyb_not_vetted`, not retried under the action; two deliveries to one member apply once | 2 |
| K4 | Console: crash mid-fan-out resumes from its record; every member answered exactly once in the action's outcome | 2 |
| K5 | Payouts against an op 5 stub: change committed before the cut → new destination; after the cut → old for this run, new for the next; final failure then re-pay in the next run → that run's destination (P4-S118 rows 1–3); `UNAVAILABLE` → run waits for that supplier; `NOT_FOUND` → lots escalated, nothing instructed | 5, 4 |
| K6 | Payment and payout providers (partner certification): redeliver until a 2xx/4xx; honour `Idempotency-Key` on instructions; treat `422` as final | 3, 4 |

## Settled

Every point where the sides' RFCs differed, with the orchestrator's binding decision. None
is open.

| # | Point | Sides | Decision (binding) | Errata owed |
|---|---|---|---|---|
| S1 | **Set-scoped membership "at slot-map version v"** | RFC-004 rev. 5 §A4 F5, §B12 and RFC-002 rev. 5 §7.3 (after review 31 K-1): `out_of_scope` unless the account is also "a member of the signed set at slot-map version v". RFC-005 rev. 5 §7.4 check 6 (review 30 Y-1): membership is the owner's applied F9 only; v shown and signed, not checked | RFC-005's: the envelope applies to `member` iff `member` is the receiving account and its applied F9 marks it a designated probe account. v is recorded with the applied action for audit, not checked: checking membership at v deadlocks new-slot publication (a slot is published only after its probe account's limit is `applied`, RFC-000 §8, RFC-004 §A3). F9 records the slot-map version that designated the account | RFC-002 §7.3 and RFC-004 §A4 F5 and §B12: drop "and a member of the signed set at slot-map version v". RFC-006: the probe designation (F9 source) carries the designating slot-map version |
| S2 | **Destination change under a recovery hold** (C4-5) | RFC-000 rev. 4.4 §8 row: "held with it". RFC-005 rev. 5 C16, RFC-004 rev. 5 RQ4-14, `requirements-v1.10` X1-S46 and POL-32: refused, the attempt recorded | Refused during the hold; any change applies from the next payout run; a run already started keeps its destination | RFC-000 §8 payout-destination row: replace "held with it" with "refused" |
| S3 | **How the destination at the cut is read** (C4-6) | RFC-004 rev. 5 §B12: "a consistent read at `at`". RFC-005 rev. 5 C16: from identity's version history, never `AS OF SYSTEM TIME`; details by (`destination_ref`, version) | RFC-005's | RFC-004 §B12 consumed-contracts row: drop "a consistent read at `at`" |
| S4 | Contract choices: per-call deadlines (op 2: 5 s; op 5: 2 s), `409 conflict` on a changed partner report of the same version, hold-and-alert for wrong-partition or unknown-type invoice-status events, topic and path names | RFCs silent | Accepted as written | — |

### Differences of form (accepted as proposed)

| # | Point | Reconciliation |
|---|---|---|
| F1 | RFC-004 §B12 `set_credit_limit(account, amount, reason, action_id)`; RFC-002 §7.3 `set_credit_limit(account, amount)` | `reason` and `action_id` travel in the C08 envelope (`reason_code`, `action_id`) |
| F2 | Refusals: RFC-004 `kyb_not_vetted \| out_of_scope \| unauthorised \| invalid`; RFC-002 and RFC-005 "the failed envelope check" | `unauthorised` carries `failed_check` (C08 check number); `out_of_scope` is check 6 of a set-scoped envelope |
| F3 | RFC-004 §B9 refuses a repeated `action_id` with different content "as a conflict"; §B12's list has no such reason | `conflict` added |
| F4 | Event identity: RFC-004 (receivables partition, epoch, sequence); RFC-002 "(partition, stream sequence)" | `pos` carries all three; dedup by key, order by `seq` |
| F5 | `InvoiceOverdue.due_date` in RFC-004, absent from RFC-002's list | Carried; the account owner may ignore it |
| F6 | RFC-004 §B7.1 "a re-instruction reuses them" (destination) | A re-instruction is a resend of the same instruction; a lot paid again in a later run is a new instruction and goes to that run's destination (POL-22, P4-S118 row 3, `requirements-v1.10`). Erratum owed: RFC-004 §B7.1 reworded so |
