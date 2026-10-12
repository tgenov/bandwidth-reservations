# C07. Receivables and payouts

| | |
|---|---|
| Contract ID | C07 |
| Name | receivables-and-payouts |
| Version | 2 (draft) |
| Status | **Draft**, for contract fix verification. Revised per [review 37](../../reviews/37-contract-C07-review.md) (REJECT: R37-01 … R37-30), every proposed fix and decision D-37-1 … D-37-6 applied by the orchestrator's binding decision; see "Review 37 resolution". Every mismatch is settled (see "Settled"); none is open. Errata owed by the source RFCs and by other contracts are listed under "Errata owed" |
| Provider | RFC-004 (receivables, payments, payouts, reconciliation; Part A semantics of the credit-limit command). RFC-005 (identity and access) for operation 5, the payout-destination query (RFC-000 §8 lists it as C16 of RFC-005) |
| Consumers | RFC-002 (account owner: applies the invoice-status feed and the credit-limit command). RFC-005 (operator console: sends the credit-limit command; edge payment ingress and the authenticity verifier, RFC-005 C7, in front of operations 3 and 4). RFC-004 payouts (reads operation 5). External: payment providers, payout providers, the payment partner, banks |
| Transport | Op 1: Kafka event (receivables' outbox and changefeed relay, [C01](C01-platform.md) §3.5). Op 2: HTTP (gRPC), synchronous command. Op 3, op 4: HTTP, external API (inbound notifications and reports; outbound instructions). Op 5: HTTP (gRPC), synchronous query. No cross-owner database read |
| Pinned to | `requirements-v1.10`; RFC-000 revision 4.4 (§8 rows: invoice-status feed, credit-limit command, payment notification ingress, payout instruction and transfer confirmation and partner reports, payout destination; errata 4.4 points C4-5, C4-6, C4-7); RFC-004 revision 5 with erratum 5.1 (§A3, §A4 F5/F6/F9 and the gate, §B1.3, §B4, §B5, §B6, §B7, §B9, §B12); RFC-002 revision 5 (§2.3 F5/F6/F9, §7.3, §13.1); RFC-005 revision 5 (§7.3, §7.4, C7, C16); RFC-006 revision 6 (`probe_account_set`, `probeSetSummary` rows only) |
| Depends on | [C01](C01-platform.md) (owner runtime: `Moved`, `Moving`, `Stopped`, moves, feed consumption, `probeAccountSet(v)`, `probeSetSummary(v)`). [C08](C08-identity-and-access.md) §E (operator envelope and its checks; the numbering is restated in op 2 so this contract reads on its own). RFC-005 C7 (authenticity verifier). [C05](C05-funds-and-standing.md) (F5, F6, F9 as funds entries) |

## Purpose

The money edges of S-MONEY that cross an owner boundary:

1. **Invoice-status feed**: receivables tells the buyer's account owner that an invoice
   became overdue, was paid, was written off, or that a write-off removed the credit
   limit, each gated on the account's ledger position it was decided from (A-1, J-05).
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
type Micros = string;         // integer micro-USD (10^-6 USD) as a decimal string, e.g. "120000000"
type ProviderAmount = string; // decimal string in the provider currency's MAJOR unit, with at most
                              // the configured exponent's fraction digits, e.g. "15540" (KES, exponent 0
                              // at the payout provider of P4-S50), "12.34" (USD, exponent 2)
type Currency = string;       // ISO 4217, e.g. "USD", "KES"
type ShownRate = {            // a rate exactly as shown to the buyer or supplier (R37-17)
  value: string;              // exact decimal string
  direction: "USD_PER_UNIT"   // USD per 1 unit of `currency` (top-up quotes, P4-S06: 0.0077123)
           | "UNITS_PER_USD"; // units of `currency` per 1 USD (payouts, P4-S50: 129.5)
  currency: Currency;
};

// Time
type Timestamp = string;      // ISO 8601 UTC with microseconds, e.g. "2026-10-12T00:00:00.000000Z"
type CommitTs = string;       // database commit timestamp (HLC), decimal "<wall_ns>.<logical>",
                              // e.g. "1791763200000000000.0000000000"; compared numerically

// Identities (pseudonymous; never personal data, RFC-000 A11)
type AccountId = string;
type SupplierId = string;
type InvoiceId = string;
type ActionId = string;       // operator action identifier from the C08 envelope
type InstructionRef = string; // "po:<supplier>:<run>:<n>", (supplier, run, n), unique 7 years

// Positions
type LedgerPos = { ledger_partition: string; seq: string };  // (partition, sequence) of the ledger
                                                             // partition log, RFC-004 §B1.3; seq integer string
type FeedPos = { partition: string; stream: string; stream_seq: string }; // C01 §3.5 feed identity
type AccountLogPos = { account: AccountId; seq: string };    // the account owner's log position
```

Durations below are stated with their unit (ms, s, h, days).

## Operation 1. Invoice-status feed (receivables → account owner)

### Schema

Topic `money.receivables.invoice-status.v1` (name per C01 conventions), key = `account`,
value JSON:

```ts
type InvoiceStatusEvent = {
  schema: "invoice-status/1";
  account: AccountId;
  pos: FeedPos;             // identity: partition = the account (receivables is partitioned by
                            // account, RFC-004 §B5), stream = "invoice-status", stream_seq contiguous
  epoch: string;            // producer epoch; informational (C01: stream_seq continues across epochs)
  ledger_pos: LedgerPos;    // the (partition, seq) of the LAST MOVEMENT OF THIS ACCOUNT that receivables
                            // had applied when it decided the event; seq "0" if none (R37-04)
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
| `InvoiceOverdue` | Invoice unpaid at `due_date` = issue + `invoice_terms` (30 days) | F6 *overdue* | Adds the invoice to `OD`; standing cause `invoice` (P4-S18 row 5) |
| `InvoicePaid` | Paid in full by an invoice payment (M2) or by a top-up's allocation (M1); `ledger_pos` is that movement's position | F6 *paid* | Removes it from `OD`; standing re-evaluated |
| `InvoiceWrittenOff` | 90 days after `due_date`, unpaid, once receivables has applied the M19 from the ledger feed; `ledger_pos` is the M19's | F6 *written off* | Removes it from `OD` (a no-op if the M19's F1 already did, D-4) |
| `CreditLimitRemoved` | With every `InvoiceWrittenOff`, same `ledger_pos` and `decided_at` | F5 *removed: invoice written off* | `CL` removed; the account books prepaid until finance sets a limit again — **unless superseded** (below) |

- **Ledger-position gate** (the defining rule of this feed). `ledger_pos` is the position
  of the last movement **of this account** that receivables had applied, so it is
  directly comparable with the account owner's applied ledger position (the position of
  the last movement its F1s applied, all in the account's one buyer ledger partition). The
  owner composes an event only once its applied position has reached `ledger_pos.seq`.
  Until then the event is **held**, in memory and in the owner's `funds_*` held-events
  row, never dropped; it is composed in the batch after the F1 that reaches it. An event
  at or below the applied position (including `seq "0"`) is composed at once. So an idle
  account's `InvoiceOverdue` is composed on arrival (R37-04).
- **A late removal never undoes a later set** (R37-03, D-37-5). A `CreditLimitRemoved` is
  composed as F5 *removed: invoice written off* recorded as **superseded**, changing
  nothing, when the `CL` in force was set by an F5 *set* whose commit timestamp is above
  the event's `decided_at`. Commit timestamps of one cluster order an operator's set made
  after seeing the write-off above receivables' deciding entry. The paired
  `InvoiceWrittenOff` is applied as usual.
- Events are applied in `stream_seq` order per account (C01 §3.5: later ones buffered, lower
  ones dropped, a gap filled after `gap_timeout` 5 s from receivables' outbox or history).
- An event whose `ledger_pos.ledger_partition` is not the account's buyer partition is
  held and alerted, never applied (contract choice; the RFCs never produce it).
- An unknown `event.type` or `schema` is held and alerted, never skipped, since skipping
  would break per-account order.
- **Moves** (C01 §3.3, R37-12). The held-events row is part of the account's partition
  state and moves with the account. After `onMovedOut(account)` the old slot composes
  nothing for it and cancels its position gates. The new holder's `onAdopt` re-arms the
  gates from the held rows, and its `subscribe` resumes the account's stream from the
  checkpointed `(partition, stream, stream_seq)`, filling any gap from receivables' outbox
  or history. An event delivered to the old slot's consumer after the move is not
  composed there.
- No error is returned to the producer; the feed is one-way.

### Delivery and ordering

At least once. Published by receivables after commit (direct publish and the changefeed
relay, C01 §3.5); both may deliver the same event. Partition key `account`, so ordering is
per account; no ordering across accounts. Between this feed and the credit-limit command
the order of record is the account log, with the supersession rule above. The consumer
checkpoints `(partition, stream, stream_seq)` in the entry that applies (or holds) the
event; Kafka offsets are restart hints only (C01 §3.5; RFC-002 §12.2 S11).

### Idempotency

Key `(partition, stream, stream_seq)`. The account's receivables partition is the account
itself and never changes; re-partitioning receivables would be a new major version
(R37-22). An event with `stream_seq ≤` the checkpoint (`rcv_pos`) is a duplicate and
changes nothing. Same key with different content cannot arise from a single-writer log; if
seen it is dropped and alerted.

## Operation 2. Credit-limit command (operator console → account owner)

### Schema

gRPC `FundsCommand.ApplyCreditLimit`, routed to the account's owner by `slotOf(account)`
with `headDecides` (C01):

```ts
type CreditLimitCommand = {
  envelope: OperatorEnvelope;   // C08 §E. action.action_type is "set_credit_limit" or
                                // "remove_credit_limit"; action.amounts.amount_micro_usd is the
                                // limit for a set (the only source of the amount: it is signed);
                                // action.reason_code is the F5 reason; for a set-scoped action
                                // action.target = { kind: "set", set: "designated probe accounts at
                                // slot-map version v" }, target_version = String(v), and `member`
                                // (outside the digest) names this copy's account
  account: AccountId;           // the owner's partition; must equal envelope.member when set-scoped
};

type CreditLimitAnswer =                      // an answer: recorded, never changes on retry
  | { outcome: "applied"; action_id: ActionId; account: AccountId;
      position: AccountLogPos;                // the F5 entry
      standing: { state: "active" | "suspended";
                  causes: Array<"headroom" | "invoice" | "written_off">;
                  std_seq: string } }
  | { outcome: "refused"; action_id: ActionId; account: AccountId;
      reason: "unauthorised" | "out_of_scope" | "conflict" | "invalid" | "kyb_not_vetted";
      check?: EnvelopeCheck;                  // C08 §E code, with "unauthorised" and "out_of_scope"
      position?: AccountLogPos }              // the F5 recording the refusal, when recorded
  | { outcome: "temporarily_unavailable"; action_id: ActionId; account: AccountId;
      reason: "identity_stale" };             // NOT recorded: nothing appended; console retries
                                              // under the same action_id (C05 review 45 M5)

type CreditLimitTransport =                   // not answers: the console retries (R37-12, C01 §3.2)
  | { r: "Moved"; slot: number; generation: string }  // re-route to the slot, same envelope
  | { r: "Moving" }                                   // retry after ≥ 20 ms, backoff
  | { r: "Stopped" }                                  // integrity stop: retry after the resume push
  | { r: "UNAVAILABLE" };                             // incl. operator check unreachable; retry
```

Mapping to C08's `EnvelopeAnswer`: `applied` = `applied`; `refused{unauthorised, check}` and
`refused{out_of_scope}` = `refused{check}`; `refused{conflict}` = `refused{digest_or_type}`
under a recorded `action_id` (C08 idempotency row); `refused{kyb_not_vetted | invalid}` =
`refused_by_rule{rule}`; `temporarily_unavailable{identity_stale}` and the transport results
= `temporarily_unavailable`.

### Semantics

The C08 §E checks, numbered as there: (1) digest recomputed, action type accepted, role
the catalogue's, reason code allowed; (2) WebAuthn assertions verify; (3) identity's
operator check (C15) at apply time: role held now, credential active, assertions unused
under another identifier, digest not cancelled; (4) four eyes where the catalogue
requires it (not for credit limits); (5) own transaction timestamp ≤ `not_after − ε`;
(6) `target_version` current, or, for a set-scoped action, the scope rule below.

The owner evaluates, in this order; the first step that decides gives the answer
(R37-01):

1. **Authenticity**: checks 1 and 2. Fails → `refused{unauthorised, check}`, **not
   recorded** (an unauthenticated message writes nothing).
2. **Deduplication** by (`action_id`, account): if this account's log has an F5 (applied or
   refused) for `action_id`, answer **the recorded answer**, before any check that can
   change with time (3, 5, 6, scope, KYB). If the recomputed digest differs from the
   recorded one → `refused{conflict}`, recorded. So a retry after a lost answer gets
   `applied` with the original position even if the target version moved, `not_after`
   passed, the operator's role was withdrawn, or F9 changed.
3. **Freshness**: checks 3, 5 and, for a single-account target, 6. Fails →
   `refused{unauthorised, check}`, recorded. An unreachable operator check is
   `UNAVAILABLE`, not an answer.
4. **Scope, set-scoped only** (check 6 for a set descriptor; settled S1): the envelope
   applies to `member` iff `member` equals this account **and** the owner's applied F9
   marks it a designated probe account (`excluded` on). The signed slot-map version v is
   **not** a membership check; it is recorded in the applied F5's audit, beside the
   slot-map version that designated the account (which F9 records). Fails →
   `refused{out_of_scope}`, recorded, checked **before** KYB.
5. **Validity**: the action type is `set_credit_limit` with an `amount_micro_usd` that is a
   non-negative integer, or `remove_credit_limit` with none → else `refused{invalid}`,
   recorded.
6. **KYB** (`set` only): if the account owner's identity freshness (`iam_fresh`, RFC-002's
   slot-level watermark, C05) is stale, the applied KYB status cannot be trusted →
   `temporarily_unavailable{identity_stale}`: **nothing is appended** and the console
   retries under the same `action_id` (step 2 finds nothing recorded, so the retry is
   evaluated afresh). Otherwise, applied KYB status (F4) not passed →
   `refused{kyb_not_vetted}`, recorded, no change (P4-S82). `remove` is not subject to KYB
   or to the freshness condition.
7. **Apply**: F5 *set* sets `CL` and credit-limit mode, relabels holds, evaluates standing
   (a lower limit can suspend, RFC-004 §A7); F5 *removed by operator* removes `CL`.
   → `applied{position, standing}`.

Every recorded answer is sent only after its entry commits; the console records every
answer. The F5 carries the envelope's fields in its audit column (C08 §E).

**Set-scoped action** (probe accounts; R37-11, R37-27). The console fans out **only** to
`probeAccountSet(v)` (C01), where v is the map version the action names, and v **may be the
pending, unpublished map version** whose new slots await their probe accounts' limits
(a doubling to `2n`: placement provisions and pins the new probe accounts, the finance
action covers `probeAccountSet(v_pending)`, every member answers `applied`, then placement
publishes v). `probeSetSummary(v)` is served for that pending v and shown at approval. One
signed action, one amount, one reason, one envelope per member under the one `action_id`,
each naming its `member`; the owner applies it once per (`action_id`, account). The action's
outcome is the console's list of per-member answers; the console resumes a crashed fan-out
from that record. **A refused member is not retried under that action**: it is covered by a
new set-scoped action signed after the cause is fixed (RFC-005 review 30 Y-1; RFC-004
review 31 K-2). **Audit check**: audit recomputes the digest of `probeAccountSet(v)` for each
set-scoped action and flags any member whose applied F5 names an account outside it (the
owners no longer check v, so this is the control on a compromised console; RFC-005 DT-32b).

**Amount bound** (R37-29, RQ-37-2): no bound in this contract. Until POL-32 decides one, the
console warns above `credit_limit_warn_above` (configuration, default 10,000 USD).

### Delivery and ordering

Synchronous, request-reply. The console retries each envelope with the same `action_id`
on any transport result, `temporarily_unavailable` or call timeout until it gets a
recorded answer (exactly-once effect by step 2). No ordering across accounts; per account, an F5 applies in log order, after the
F4 that passed KYB if it is to succeed.

### Idempotency

Key (`action_id`, account). Duplicate → the recorded answer, before freshness checks.
Same key, different digest → `refused{conflict}`, recorded. Retention: the account log
(7 years for money identities, P4-S100). A money-moving `action_id` is the source
reference (POL-29, P4-S99): the same `action_id` signed by another principal fails at
step 2 as `conflict`.

## Operation 3. Payment notification ingress (payment providers → payments)

### Schema

`POST /v1/payments/notifications/{provider}` at the edge (RFC-005 C7), body as the
provider sends it. The edge verifies it (C7 `verify(provider, request)`), normalises it
and routes it by (provider, `provider_txn_ref`) to the payments partition's owner:

```ts
type PaymentNotification = {
  provider: string;                 // provider id = the provider principal for POL-29; references
                                    // are a per-provider namespace (R37-14)
  provider_txn_ref: string;
  kind: "completed_topup" | "completed_invoice_payment"
      | "completed_supplier_debt_payment" | "reversed";
  account_ref: string;              // buyer AccountId; SupplierId for a supplier-debt payment
  amount: ProviderAmount;           // > 0, a whole number of the currency's minor unit, where the
                                    // exponent is Share's configuration per (provider, currency),
                                    // never taken from the message (R37-16)
  currency: Currency;
  quote_ref?: string;               // top-up FX quote (RFC-004 §B4.3)
  invoice_ref?: InvoiceId;          // invoice payment
  occurred_at: Timestamp;           // provider's time, inside the signed message
  received_at: Timestamp;           // set by the edge on receipt
};

type IngressAnswer =   // HTTP response body
  | { result: "accepted"; state: "bound" | "pending_reversal" | "reversed" | "unattributed" } // 200
  | { result: "duplicate" }                                                    // 200
  | { result: "mismatch_recorded" }                                            // 200
  | { result: "malformed"; reason: string }                                    // 422, permanent
  | { result: "not_authentic" }                                                // 401
  | { result: "retry" };                                                       // 503 + Retry-After (s)
```

### Semantics (RFC-004 §B4.1, §B4.2, §B4.3; D-37-1, D-37-2, D-37-3)

Each provider transaction (provider, `provider_txn_ref`) has at most one **completed**
event and at most one **reversal** applied.

| Case | Answer | Effect |
|---|---|---|
| Not proven authentic | `not_authentic` | Nothing moves; recorded in the provider's investigation stream; no binding (X1-S10) |
| Malformed (unknown kind, amount ≤ 0 or not a whole minor unit, no provider or account reference) | `malformed` | Recorded without a binding; nothing moves (P4-S05) |
| First well-formed completed event, `account_ref` known | `accepted{bound}` | Binding (provider, txn ref) → (account, kind, amount, currency, conversion); movement M1/M2/M20 via the outbox |
| First completed event, `account_ref` names no account or supplier (R37-09 (c), D-37-3) | `accepted{unattributed}` | Binding recorded; nothing moves; put on finance's **suspense queue** and alerted; resolved by finance (M22 if money must move) |
| `invoice_ref` names an invoice not of `account_ref` (R37-09 (a)) | As the event otherwise | Treated as no invoice named (RFC-004 §B5: oldest open invoice of `account_ref`); recorded |
| `quote_ref` not issued to `account_ref` in `currency` (R37-09 (b)) | As the event otherwise | Quote ignored: the partner's rate at receipt |
| First event is `reversed` | `accepted{pending_reversal}` | Bound from it (account, currency, reversal amount); held 72 h for its completion, then payment and reversal posted in order, or escalated, never applied alone (P4-S02, P4-S03). The completion must match account and currency and have amount ≥ the reversal's, else `mismatch_recorded` |
| Reversal of a bound payment, same currency, amount ≤ bound amount, first reversal | `accepted{reversed}` | M3 debits, at the **bound conversion**, exactly the micros credited for a full reversal, `floor_µ(µ_bound × reversed / bound_amount)` for a partial one (D-37-1); may suspend (P4-S51) |
| A second reversal, or one above the bound amount or in another currency | `mismatch_recorded` | Nothing moves; reported to reconciliation (D-37-1, RQ-37-1) |
| Same contents again (completed or reversal) | `duplicate` | Nothing (P4-S01, P4-S57, P4-S100) |
| Completed event with different account, amount, currency or **completed kind** than the binding | `mismatch_recorded` | Nothing moves; reported to reconciliation (P4-S04) |
| Not yet committed (owner unavailable, `Moving`, `Stopped`, failover) | `retry` | Nothing durable; the provider redelivers |

**Conversion** (RFC-004 §B4.3): USD exact (`µ = amount × 10⁶`). Other currency: the quote's
shown rate if `quote_ref` is valid for the account and currency and the provider-signed
`occurred_at` ≤ the quote's expiry (`fx_quote_validity`, 15 min), provided `received_at` ≤
expiry + 24 h (D-37-2), `µ = ceil(amount × rate × 10⁶)` exactly; otherwise the partner's
rate in force at receipt. The rate, its source and the original amount are recorded on the
binding and the movement; a reversal uses the binding's conversion.

**Notified before settled** (R37-28, RQ-37-3): payments credits on notification as RFC-004
§B4.2 says; reconciliation raises an operational alert (never a gate) when a provider's
posted-not-received total exceeds `provider_pnr_alert_usd` (configuration per provider).

### Delivery and ordering

At least once from the provider; any order (a reversal may precede its payment).
Exactly-once effect by the binding. Every 2xx and 4xx answer is given only after the
event's transaction commits in two regions (X2-S14); a provider is never told `accepted`
for an uncommitted event. Top-up credited within 10 s (X2-S07).

### Idempotency

Key (provider, `provider_txn_ref`, class), class ∈ {completed, reversed}; binding by
(provider, `provider_txn_ref`), kept 7 years. Duplicate → `duplicate`; same key, different
content → `mismatch_recorded`.

## Operation 4. Payout instruction, transfer confirmation, partner reports

### 4a. Payout instruction (payouts → payout provider)

**Composition of a run's instruction** for a supplier (RFC-004 §B7.2 as corrected, R37-02):

```
N, F, pay = N − F                         as RFC-004 §B7.2 (F excludes FailedFinal lots, so pay contains them)
FF   = FailedFinal lots not escalated, oldest first, while their running total ≤ pay
new  = pay − Σ FF                          (a new lot only if new > 0)
lots = FF ∪ {new}                          instructed only if Σ lots ≥ payout_minimum (50 USD)
```

A FailedFinal lot that does not fit under `pay` (debts posted since) stays payable for a
later run. **P4-S86 recomputed**: run 1 instructs lot L = 120.000000, final failure; run 2:
`N` = 120, `F` = 0, `pay` = 120, `FF` = {L}, `new` = 0 → **one instruction of 120.00 USD,
lot L only**.

`POST {provider_base}/payouts` with header `Idempotency-Key: <instruction_ref>`:

```ts
type PayoutInstruction = {
  instruction_ref: InstructionRef; // the provider's idempotency key
  amount: ProviderAmount;          // K = floor_minor(Σ lots.usd × ρ), RFC-004 §B7.5
  currency: Currency;
  destination: DestinationDetails; // from op 5; transient, never logged or stored by payouts
};
// Recorded by payouts with the instruction (not sent):
type InstructionRecord = {
  instruction_ref: InstructionRef; supplier: SupplierId; run: string; n: number;
  lots: Array<{ lot_id: string; usd: Micros }>;  // each lot's usd fixed when the lot was created (R37-07)
  rate: ShownRate;                               // ρ, direction UNITS_PER_USD
  amount: ProviderAmount;                        // K
  usd_debited: Micros;                           // P = floor_µ(K / ρ)
  residue: Micros;                               // Σ lots.usd − P, stays payable to the supplier
  destination_ref: string; destination_version: string;
  first_sent_at: Timestamp; provider_idempotency_retention_days: number;
};
```

**Lots and residue** (R37-07). A lot's USD amount is fixed when the lot is created and never
changes; a lot re-paid in a later run is re-instructed at that run's rate. The confirmation's
M15 debits **`P` in total**, apportioned over the instruction's lots (`floor_µ(P × lot.usd /
Σ lots.usd)` each, the remainder to the oldest lot); `Σ lots.usd − P` is never debited, so it
stays in the supplier's payable as residue, carried in USD (POL-11, POL-20; P4-S47, P4-S50).
Example: lot 120.000000 at ρ′ = 129.53 → `K′` = 15,543 KES, `P′` = 119.995367, residue
0.004633 USD.

The synchronous HTTP response is a transport receipt only; outcomes arrive as 4b.
**Resends** (R37-06, D-37-6): on a transport timeout or 5xx, payouts resends the **same**
instruction (same reference, same `destination_ref` and version, details re-read by op 5's
second form) **only within the provider's certified idempotency retention**, counted from
`first_sent_at`. Certification requires a retention ≥ `payout_confirmation_timeout` + 1 day
(8 days), recorded per provider. Past it, payouts never resends: it resolves the
instruction's state by the provider's status query by `instruction_ref` where one exists,
and otherwise escalates (the P4-S88 path).

### 4b. Transfer confirmation or failure (payout provider → payouts)

`POST /v1/payouts/reports/{provider}` at the edge, verified by C7, routed by
`instruction_ref` to the supplier's payouts partition:

```ts
type TransferReport = {
  provider: string;
  instruction_ref: InstructionRef;
  provider_ref: string;                 // the provider's execution reference
  outcome: "confirmed" | "failed";
  final?: boolean;                      // required iff outcome = "failed" (R37-30)
  amount?: ProviderAmount; currency?: Currency;
  occurred_at: Timestamp;
};
// Answer: 200 {result: "recorded" | "duplicate" | "escalated"}; 401 not_authentic;
// 403 principal_refused; 503 retry.
```

| Case | Effect (RFC-004 §B7.1, §B7.3) |
|---|---|
| First confirmation of an instruction's lots | M15 (paid, debiting `P` as 4a) |
| Confirmation with a **new** `provider_ref` for an instruction already confirmed (the provider executed it twice, R37-05) | M16 "duplicate payout" debt per lot (the execution's `P`, apportioned); escalated |
| Confirmation of a lot already paid under another instruction | M16 "duplicate payout"; escalated (P4-S95) |
| Confirmation after a final failure | Escalated; M15 or M16 posted; lot in no new payout while open (P4-S87) |
| Non-final failure | Nothing; instruction stays in flight |
| Final failure | Lots payable again: re-paid in a later run under a new reference, to that run's destination (P4-S86, P4-S118 row 3) |
| `failed{final}` after a confirmation (a bank return, R37-15 (c)) | Recorded; escalated to finance; no automatic movement; reconciliation sees the difference |
| `amount`/`currency` differ from the instructed `K` (R37-15 (b)) | Posted per the rows above; escalated; reconciliation sees the difference |
| Report from a provider other than the instruction's (R37-15 (a)) | `principal_refused`; recorded |
| Unknown `instruction_ref` | Escalated to finance |
| Same (`instruction_ref`, `provider_ref`, outcome) again | `duplicate`, no effect (P4-S79) |
| No answer in `payout_confirmation_timeout` (7 days) | Escalated, never re-instructed (P4-S88) |

`Moving` or `Stopped` at the payouts partition answers `retry` (503); a payout run waits for
a stopped partition (C01 §10.3).

### 4c. Partner reports (payment partner, providers, banks → reconciliation)

`POST /v1/reconciliation/reports/{source}`, verified by C7:

```ts
type PartnerReport =
  | { kind: "partner_statement"; funds_held_usd: Micros /* required: funds at end of D */ } & ReportBase
  | { kind: "provider_settlement" } & ReportBase
  | { kind: "bank_statement" } & ReportBase;

type ReportBase = {
  source: string; report_id: string; version: number;
  day: string;                          // D, "YYYY-MM-DD" UTC
  transactions: PartnerTxn[];
};

type PartnerTxn = {
  kind: "topup" | "invoice_payment" | "supplier_debt_payment" | "reversal"
      | "payout" | "own_deposit" | "own_withdrawal";
  direction: "credit" | "debit";        // into or out of Share's safeguarded funds
  usd: Micros; time: Timestamp;
  // reference, per kind (R37-10), matched by (party, reference, kind), RFC-004 §B6.3:
  provider?: string;                    // topup, invoice_payment, supplier_debt_payment, reversal, payout
  reference: string;                    // payments kinds: provider_txn_ref (→ M1, M2, M20, M3);
                                        // payout: instruction_ref (→ M15/M16);
                                        // own_deposit/own_withdrawal: partner transaction ref (→ M21)
  provider_ref?: string;                // payout: the provider's execution reference
};
// Answer: 200 {result: "recorded" | "duplicate"}; 401; 409 conflict; 503 retry.
```

A new `version` produces a new version of the run for D (RFC-004 §B6.4). The same
(`source`, `report_id`, `version`) with different content is refused `409 conflict` and
alerted (contract choice, S4).

### Delivery and idempotency (op 4)

| Message | Delivery | Key | Duplicate | Same key, different content |
|---|---|---|---|---|
| Instruction | At least once to the provider, within its idempotency retention; exactly-once effect at the provider by `Idempotency-Key` | `instruction_ref` | Provider returns the original | Never sent (generated once) |
| Run | Once per (supplier, week) | (supplier, week) | Finds the run, pays nothing again (P4-S46) | — |
| Transfer report | At least once, any order | (`instruction_ref`, `provider_ref`) | No effect | Escalated |
| Partner report | At least once | (`source`, `report_id`, `version`) | `duplicate` | `409 conflict`, alerted |

## Operation 5. Payout destination query (identity → payouts; RFC-005 C16)

### Schema

```ts
// gRPC IdentityPayouts; callable only by payouts' service principal (R37-20)
PayoutDestinationAt(req: { supplier: SupplierId; at: CommitTs })   // at = the run's cut T_w
  → { destination_ref: string; version: string; details: DestinationDetails }
PayoutDestinationVersion(req: { supplier: SupplierId; instruction_ref: InstructionRef;
                                destination_ref: string; version: string })
  → { details: DestinationDetails }
// Errors: NOT_FOUND{reason: "unknown_supplier" | "no_destination" | "version_gone"};
//         UNAVAILABLE ("temporarily unavailable": store unavailable, identity Moving or Stopped,
//                      or a call deadline exceeded); PERMISSION_DENIED (caller, or destination_ref
//                      not of `supplier`)

type DestinationDetails =        // personal data; every field marked (share.sensitive) so gRPC
                                 // logging and tracing interceptors redact it; never stored by payouts
  | { kind: "bank"; account_name: string; account_number: string; bank_code: string; country: string }
  | { kind: "mobile_money"; network: string; msisdn: string; country: string };
```

### Semantics

- **Version in force at `at`** (settled S3): identity resolves it from the destination's
  **version history** in its own log and projection, each version with its commit
  timestamp `c`: the version with the greatest `c ≤ at`. It is **not** a consistent
  (`AS OF SYSTEM TIME`) read at `at`, so a call hours or days after the cut answers the
  same version. Details are a personal-data-store item keyed by (`destination_ref`,
  version), read by identity (`get`, purpose "payout destination") for this request only.
- **When a change applies** (settled S2; POL-22, P4-S118; R37-21): **a payout run starts at
  its cut `T_w`**. A change committed at `c` applies to runs with `T_w ≥ c`. A run already
  started (`T_w < c`) keeps the destination it resolved for every one of its instructions,
  including resends. Identity's notice names "the run it applies from" as the first `T_w ≥
  c` of the weekly payout calendar `payout_schedule` (POL-22 `payout_frequency`), which
  payouts (RFC-004) owns and publishes as configuration.
- **Re-instruction**: a resend of the same instruction (same `instruction_ref`) uses the
  recorded (`destination_ref`, version) through `PayoutDestinationVersion`. A lot paid
  again after a final failure is a **new** instruction in a later run, resolved at that
  run's cut, so it goes to that run's destination (P4-S118 row 3; F6).
- **Recovery hold** (settled S2; X1-S46): a destination change by a supplier administrator
  held in a recovery is **refused** by identity ("refused during recovery hold"), the
  destination unchanged and the attempt recorded; no version is created, so this query
  never sees it. After the hold ends without objection the administrator's change is an
  ordinary change and applies from the next run. The change command and the notice to
  every supplier administrator are identity's (RFC-005 §3.2, C16 command), not part of this
  contract.
- **Authorisation** (R37-20): only payouts' service principal may call either form;
  `PayoutDestinationVersion` carries `supplier` and `instruction_ref`, and identity checks
  that `destination_ref` belongs to `supplier`, else `PERMISSION_DENIED`.
- **Payouts' use** (RFC-004 §B7.1; R37-19, D-37-4):

  | Answer | Payouts does |
  |---|---|
  | Destination | Records `destination_ref` and version on the instruction, never the details |
  | `UNAVAILABLE` | The run waits for that supplier and retries |
  | `NOT_FOUND{no_destination}` | No lot is created and the amount carries forward; every supplier administrator is told at each run; escalated to finance only after 4 consecutive runs |
  | `NOT_FOUND{unknown_supplier}` | Escalated to finance; nothing instructed |
  | `NOT_FOUND{version_gone}` on a resend | The resend is not sent; the instruction is escalated; the destination is never re-resolved for it |

- Payouts is a reader of the store only through identity; it never calls the store.
- Precondition: `at` is a past commit timestamp (a cut is taken below the closed
  timestamp). Identity, the single writer of the history, answers from its own state.

### Delivery and idempotency

Read-only; any number of retries; same request, same answer (until a store item is
erased after its retention, then `NOT_FOUND{version_gone}`). Each version's store item is
kept while any instruction may reference it (until the supplier's last payout under it is
final and reconciled, then as long as payout records need it).

## Ownership

| Data | Writer | Readers |
|---|---|---|
| Invoice-status topic | Receivables (RFC-004), outbox and relay only | Account owner (RFC-002) |
| `rcv_pos`, held invoice-status events, F5, F6 | Account owner (RFC-002) | Account owner; status replicas |
| Credit-limit command | Operator console (RFC-005) sends; account owner appends F5 | Console records per-member answers; audit (set-scoped check) |
| Bindings, investigation stream, suspense queue, payment event log | Payments partition (RFC-004) | Reconciliation, finance, reporting (via feeds) |
| Runs, lots, instructions, confirmations, escalations, debt register, `payout_schedule` | Payouts partition (RFC-004) | Reconciliation, reporting (via feeds); identity (`payout_schedule` only) |
| Partner reports, runs for D | Reconciliation partition (RFC-004) | Finance, reporting |
| Destination versions | Identity (RFC-005) | Payouts, through op 5 only |
| Destination details | Personal-data store, via identity | Identity, for the request only |

## Timeouts and deadlines

| Where | Value | Behaviour |
|---|---|---|
| Op 1 gate | Unbounded | Held until the account's ledger position is reached; within X2-S07's 10 s end to end in the normal path (RFC-004 §A7) |
| Op 1 gap | `gap_timeout` 5 s (C01) | Gap filled from receivables' outbox or history |
| Op 2 call | Per-call deadline 5 s (contract choice; about 100 ms est.) | Console retries with the same `action_id`; a retry after `not_after − ε` still gets the recorded answer (step 2) |
| Op 2 set-scoped fan-out | About 16,384 members, 200 in parallel, each about 100 ms plus one C15 operator check per member: under 10 s (est.), plus any `Moved`/`Moving` retries | Resumed from the console's record |
| Op 3 | Answer only after commit; top-up credited within 10 s of the notification (X2-S07) | `retry` (503) with Retry-After in seconds when not committed |
| Op 3 quote | `fx_quote_validity` 15 min by `occurred_at`; `received_at` ≤ expiry + 24 h | Else the partner's rate |
| Op 3 orphan reversal | 72 h | Escalated, never applied alone |
| Op 4a resend | Provider's certified idempotency retention, ≥ 8 days | Past it: status query or escalation, never a resend |
| Op 4a/4b | `payout_confirmation_timeout` 7 days | Escalated, never re-instructed |
| Op 4c | Inputs by about 06:00 UTC on D + 1 (assumed, RFC-004 R4-B3); incomplete run at 12:00 UTC on D + 1 | Alert to finance (P4-S81); `settlement_lag_max` 7 days for `Pnr` items |
| Op 5 call | Per-call deadline 2 s (contract choice) | Treated as `UNAVAILABLE`: the run waits and retries |
| Op 5 no destination | 4 runs | Then escalated |

## Versioning and compatibility

- Contract version 2; JSON events carry `schema` (`invoice-status/1`); gRPC packages are
  versioned `v1`; HTTP paths `/v1/`.
- Compatible changes: adding optional fields; consumers ignore unknown fields.
- **Coordinated minor version, consumer first** (R37-23): adding an event `type`, a refusal
  `reason`, a `kind` or an error. For op 1 and op 2 an unknown value is held, not
  skipped, so the consumer ships support first and the producer emits it only after; the
  minor version is recorded here.
- Removing or renaming a field, changing a unit, a key, an ordering scope or the
  receivables partitioning is a new major version on a new topic or path, run side by side
  until the old is drained.
- External provider formats are adapted at the edge into the types above; a provider
  format change never changes this contract.

## Scenarios relied on

`requirements-v1.10`:

- Op 1: P4-S14, P4-S18 (row 5), P4-S83, P4-S93, P4-S94, P4-S105, P4-S111, P4-S114;
  P2-S42, P2-S69 (RFC-002 T14).
- Op 2: P4-S82, P4-S99, X1-S12, X2-S24, X2-S27.
- Op 3: P4-S01, P4-S02, P4-S03, P4-S04, P4-S05, P4-S06, P4-S07, P4-S51, P4-S57, P4-S58,
  P4-S100, P4-S103, X1-S10, X2-S07, X2-S14.
- Op 4: P4-S43 … P4-S50, P4-S67, P4-S78, P4-S79, P4-S86, P4-S87, P4-S88, P4-S95, P4-S117
  (debt netting); P4-S54, P4-S80, P4-S81, P4-S90, P4-S91, P4-S104, P4-S106, P4-S109,
  P4-S113.
- Op 5: P4-S118, X1-S46.

## Conformance tests

**Provider side (receivables, payments, payouts, reconciliation; identity for op 5).**

| # | Test | Op |
|---|---|---|
| P1 | Every write-off emits `InvoiceWrittenOff` and `CreditLimitRemoved` with the M19's `ledger_pos` and one `decided_at`; every `InvoicePaid` from a top-up carries the M1's position; per-account `stream_seq` contiguous across owner failover and moves; relay and direct duplicates share `pos` | 1 |
| P1b | `ledger_pos` is the account's own last applied movement, never a partition position: an idle account's `InvoiceOverdue` is composed by the account owner within 10 s | 1 |
| P2 | Notification matrix: authentic/unproven × well-formed/malformed × first/repeat/different content × reversal-first × unknown account (`unattributed`, suspense, alert) × another account's `invoice_ref` or `quote_ref`; answers and effects as the op 3 table; no 2xx/4xx before commit (kill before commit → `retry`) | 3 |
| P2b | Reversals: full KES reversal debits exactly the bound µ; partial debits `floor_µ(µ_bound × part / amount)`; second reversal, over-amount, other currency, other completed kind → `mismatch_recorded`; quote judged by `occurred_at` after a 503 within 24 h | 3 |
| P3 | Every permutation and triplication of a notification set gives the same bindings and postings (RFC-004 §B13) | 3 |
| P4 | Instructions: one per lot per run; resend after timeout uses the same `instruction_ref` and destination version and stops at the provider's retention; injected provider behaviours (duplicate with a new `provider_ref`, false final failure, late, none, bank return) never instruct a lot twice and raise M16 for a second execution | 4 |
| P4b | Final failure, then the next run → one instruction of 120.00 USD with lot L only (P4-S86) | 4 |
| P4c | A lot of 120.000000 re-instructed at ρ′ = 129.53: `K′` 15,543 KES, M15 debits 119.995367, residue 0.004633 stays payable | 4 |
| P5 | Partner report same (source, id, version) twice → `duplicate`; changed content → `409`; new version → new run version; every `PartnerTxn.kind` matches its movement kind | 4 |
| P6 | Destination history: versions at c1 < c2; `at` in [c1, c2) → v1, `at = c2` → v2; the same call repeated days later answers the same; `PayoutDestinationVersion` returns the recorded details only for the owning supplier and payouts' principal; unknown supplier, no destination, erased version → the three `NOT_FOUND` reasons; store down → `UNAVAILABLE`; no details in any log or trace | 5 |
| P7 | X1-S46: a held administrator's change is refused, no version created, op 5 unchanged; after the hold, the change applies from the next run | 5 |

**Consumer side.**

| # | Test | Op |
|---|---|---|
| K1 | Account owner: invoice-status events delivered before, with and after the F1 reaching their `ledger_pos`, across owner failover and an account move (held rows moved, gates re-armed in `onAdopt`, nothing composed by the old slot); standing changes only in ledger order; duplicates (both publish paths) change nothing; unknown type is held and alerted (RFC-002 T14, RFC-004 §B13 gate test) | 1 |
| K1b | Finance sets a limit after receivables decided a write-off but before the account owner applied its M19: the later `CreditLimitRemoved` is recorded superseded and the limit stays | 1 |
| K2 | Account owner: credit-limit commands with valid, expired, cancelled and wrong-role envelopes (C08); `set` without KYB → `kyb_not_vetted`; repeat → first answer; another digest under the same `action_id` → `conflict`; `remove` without KYB applies | 2 |
| K2b | Apply, lose the answer, bump `target_version`, let `not_after` pass, revoke the operator's role, retry → `applied` with the original position | 2 |
| K2c | `set` with `iam_fresh` stale (after a takeover, before the first identity heartbeat or catch-up) → `temporarily_unavailable{identity_stale}`, no F5 appended; the console retries under the same `action_id` and, once fresh, gets `applied` or `kyb_not_vetted`; `remove` while stale applies | 2 |
| K3 | Set-scoped: `member` ≠ receiving account, or applied F9 not designated → `out_of_scope` even without KYB (order); a probe account designated at a slot-map version later than the envelope's v is accepted (v not checked), and the applied F5 records v and the designating version; member without KYB → `kyb_not_vetted`, not retried under the action; two deliveries to one member apply once | 2 |
| K4 | Console: crash mid-fan-out resumes from its record; every member answered exactly once in the action's outcome; `Moved` re-routes, `Moving` and `Stopped` retried, never recorded as answers | 2 |
| K4b | Doubling to `2n`: the action over the pending version's `probeAccountSet(v)` → every new probe account `applied` → the slots are published; the audit check flags an injected member outside the set | 2 |
| K5 | Payouts against an op 5 stub: change committed before the cut → new destination; after the cut → old for this run, new for the next; final failure then re-pay in the next run → that run's destination (P4-S118 rows 1–3); `UNAVAILABLE` → run waits for that supplier; `no_destination` → carried forward, escalated at the 4th run; `unknown_supplier` → escalated; `version_gone` on resend → escalated, not re-resolved | 5, 4 |
| K6 | Payment and payout providers (partner certification): redeliver until a 2xx/4xx; honour `Idempotency-Key` on instructions for at least 8 days; treat `422` as final | 3, 4 |

## Settled

Every point where the sides' RFCs differed, with the orchestrator's binding decision. None
is open.

| # | Point | Sides | Decision (binding) |
|---|---|---|---|
| S1 | **Set-scoped membership "at slot-map version v"** | RFC-004 rev. 5 §A4 F5, §B12 and RFC-002 rev. 5 §7.3 (after review 31 K-1): `out_of_scope` unless the account is also "a member of the signed set at slot-map version v". RFC-005 rev. 5 §7.4 check 6 (review 30 Y-1): membership is the owner's applied F9 only; v shown and signed, not checked | RFC-005's: the envelope applies to `member` iff `member` is the receiving account and its applied F9 marks it a designated probe account. v is recorded with the applied action for audit, not checked: checking membership at v deadlocks new-slot publication. F9 records the slot-map version that designated the account. The console fans out only to `probeAccountSet(v)`, v possibly pending, and audit checks applied members against it (R37-11, R37-27) |
| S2 | **Destination change under a recovery hold** (C4-5) | RFC-000 rev. 4.4: "held with it". RFC-005 rev. 5 C16, RFC-004 rev. 5 RQ4-14, `requirements-v1.10` X1-S46 and POL-32: refused, the attempt recorded | Refused during the hold; any change applies from the next payout run (a run starts at its cut); a run already started keeps its destination |
| S3 | **How the destination at the cut is read** (C4-6) | RFC-004 rev. 5 §B12: "a consistent read at `at`". RFC-005 rev. 5 C16: from identity's version history, never `AS OF SYSTEM TIME` | RFC-005's |
| S4 | Contract choices: per-call deadlines (op 2: 5 s; op 5: 2 s), `409 conflict` on a changed partner report of the same version, hold-and-alert for wrong-partition or unknown-type invoice-status events, topic and path names | RFCs silent | Accepted as written |

### Differences of form (accepted as proposed)

| # | Point | Reconciliation |
|---|---|---|
| F1 | RFC-004 §B12 `set_credit_limit(account, amount, reason, action_id)`; RFC-002 §7.3 `set_credit_limit(account, amount)` | `reason`, `action_id` and, since version 2, the amount travel in the signed C08 envelope (`reason_code`, `action_id`, `amounts.amount_micro_usd`) |
| F2 | Refusals: RFC-004 `kyb_not_vetted \| out_of_scope \| unauthorised \| invalid`; RFC-002 and RFC-005 "the failed envelope check" | `unauthorised` and `out_of_scope` carry the C08 check code; mapping to C08's `EnvelopeAnswer` stated in op 2 |
| F3 | RFC-004 §B9 refuses a repeated `action_id` with different content "as a conflict"; §B12's list has no such reason | `conflict` added (C08's `digest_or_type` under a recorded `action_id`) |
| F4 | Event identity: RFC-004 (receivables partition, epoch, sequence); RFC-002 "(partition, stream sequence)" | Since version 2, C01 §3.5's (partition, stream, `stream_seq`), the partition being the account; `epoch` informational (R37-22) |
| F5 | `InvoiceOverdue.due_date` in RFC-004, absent from RFC-002's list | Carried; the account owner may ignore it |
| F6 | RFC-004 §B7.1 "a re-instruction reuses them" (destination) | A re-instruction is a resend of the same instruction; a lot paid again in a later run goes to that run's destination (POL-22, P4-S118 row 3) |

## Errata owed

None of these documents is edited here; each owner applies its erratum when this contract
is frozen.

| Owner | Erratum | From |
|---|---|---|
| RFC-004 | §A3 and Revision 5 item 3, §A4 F5 apply rule, §B12 credit-limit row: drop "and a member of the signed set at slot-map version v (C9)" | S1, R37-13 |
| RFC-004 | §A4 F9 payload: records the designating slot-map version | S1, R37-13 |
| RFC-004 | §A4 F5 apply rule: a `CreditLimitRemoved` is superseded by an F5 *set* committed after its `decided_at` | R37-03, D-37-5 |
| RFC-004 | §B5 and §B12 invoice-status row: `ledger_pos` is the position of the account's last applied movement | R37-04 |
| RFC-004 | §B12 credit-limit row and §B9: a repeat answers the recorded outcome before any freshness check | R37-01 |
| RFC-004 | §B4.1, §B4.2, §B4.3, §B9: reversals one per transaction at the bound conversion; other completed kind is a mismatch; unattributed payments to the suspense queue; another account's `invoice_ref`/`quote_ref` ignored; quote validity by `occurred_at` | R37-08, R37-09, R37-18, D-37-1 … D-37-3 |
| RFC-004 | §B6: partner transaction kinds and per-kind references; per-provider `Pnr` exposure alert | R37-10, R37-28 |
| RFC-004 | §B7.1: "re-instruction" means a resend of the same instruction; resends bounded by the provider's idempotency retention; transfer reports keyed by (`instruction_ref`, `provider_ref`); `no_destination` carried forward, escalated after 4 runs | F6, R37-05, R37-06, R37-19 |
| RFC-004 | §B7.2: "instruct the FailedFinal lots plus a new lot of `pay − Σ FailedFinal`", not "`round_down(pay)` plus every FailedFinal lot"; publishes `payout_schedule` | R37-02, R37-21 |
| RFC-004 | §B7.5: M15 debits `P` in total, apportioned over lots; `Σ lots − P` stays payable | R37-07 |
| RFC-004 | §B12 consumed C16 row: drop "a consistent read at `at`" | S3 |
| RFC-004 | Traceability: cite P4-S117 (§B3.4, §B7.6 debt netting) and P4-S118 (§B7.1, op 5); Status line "P4-S01 … P4-S118 (118 scenarios)" | R37-13 |
| RFC-004 | Moves and stops on payments, payouts, receivables, reconciliation (C01 §10.3 rows) | R37-12 |
| RFC-002 | §7.3 and §13.1 credit-limit row: drop "a member of the signed set at slot-map version v"; check order with deduplication before freshness; the supersession rule; `ledger_pos` per account | S1, R37-01, R37-03, R37-04 |
| RFC-002 | §2.3 F9 payload: the designating slot-map version (also C01 §10.3) | S1, R37-13 |
| RFC-005 | §7.4 check 6: "has not applied this `action_id`" is not a refusal; a repeat answers the recorded outcome after checks 1–2 and before checks 3–6 | R37-01 |
| RFC-005 | §7.3: the console fans out only to `probeAccountSet(v)`, v possibly the pending version; DT-32b: audit compares applied set-scoped F5s with the signed set's digest; console warning above `credit_limit_warn_above` | R37-11, R37-27, R37-29 |
| RFC-005 | C16: refused, not held, under a recovery hold (as rev. 5 already says); `PayoutDestinationVersion` with `supplier` and `instruction_ref`, payouts' principal only, ownership check; sensitive-field redaction; the three `NOT_FOUND` reasons; the notice's run from `payout_schedule` | S2, R37-19, R37-20, R37-21 |
| RFC-006 | Probe designation (F9 source) carries the designating slot-map version; `probeAccountSet(v)` and `probeSetSummary(v)` served for the pending, unpublished version | S1, R37-11 |
| RFC-000 | §8 payout-destination row, revision 4.4 errata C4-5 row ("§8 reading meanwhile: held"), interface-points RFC-005 row ("held, not refused") and the Revision 4.4 requirements paragraph (1): "refused during the recovery hold, the attempt recorded; a change after the hold applies from the next run"; close C4-5 as settled | S2, AI-37-1 |
| RFC-000 | §8 operator envelope and credit-limit rows, §4.4: a repeat of a recorded `action_id` with the same digest answers the recorded outcome before the operator check, `not_after` and target-version checks | R37-01, AI-37-2 |
| RFC-000 | §8 invoice-status row: the ledger position is that of the account's last applied movement | R37-04, AI-37-3 |
| C08 | §E check 6 and the envelope idempotency row: deduplication before checks 3–6 | R37-01 |
| C05 | F5 row: drop "and it is a member of the signed set at `mapVersion`"; F5 supersession rule; F9 records the designating version | S1, R37-03 |
| C01 | §3.8: `probeAccountSet(v)`/`probeSetSummary(v)` for a pending version, if it allows only published versions | R37-11 |
| Requirements | RQ-37-1 (POL-21: one reversal, at most the credited amount, at the payment's rate), RQ-37-2 (POL-32: credit-limit bound or four eyes), RQ-37-3 (POL-24: per-provider unreceived-credit alert) | R37-08, R37-29, R37-28 |

## Review 37 resolution

| Finding | Change in version 2 |
|---|---|
| R37-01 (Blocker) | Op 2 check order: authenticity (1–2), then deduplication by (`action_id`, account) answering the recorded outcome, then freshness (3, 5, 6), scope, validity, KYB; K2b; errata RFC-005 §7.4, C08 §E, RFC-000 (AI-37-2) |
| R37-02 (Blocker) | Op 4a composition: FailedFinal lots plus a new lot of `pay − Σ FF`; `K` from Σ lots; P4-S86 recomputed to 120 USD; P4b; erratum RFC-004 §B7.2 |
| R37-03 | Op 1 supersession rule by `decided_at` (D-37-5); K1b |
| R37-04 | `ledger_pos` = the account's last applied movement; P1b; AI-37-3 |
| R37-05 | Transfer reports keyed by (`instruction_ref`, `provider_ref`); a new `provider_ref` after a confirmation raises M16 |
| R37-06 | Resends bounded by the provider's certified idempotency retention (≥ 8 days, D-37-6); then status query or escalation |
| R37-07 | Lot amount fixed at creation; M15 debits `P` apportioned; residue stays payable; P4c |
| R37-08 | Reversal rows, bound conversion, one per transaction, class-based key (D-37-1); P2b; RQ-37-1 |
| R37-09 | Cross-account `invoice_ref`/`quote_ref` ignored; unknown account → `accepted{unattributed}`, suspense queue, alert (D-37-3) |
| R37-10 | `PartnerTxn.kind` (seven kinds) with `direction`, per-kind `reference` (payout: `instruction_ref` + `provider_ref`); `funds_held_usd` required on `partner_statement` |
| R37-11 | Console fans out to `probeAccountSet(v)`, v possibly pending; `probeSetSummary(v)` served for it; K4b |
| R37-12 | Op 2 transport results `Moved`/`Moving`/`Stopped`/`UNAVAILABLE`; op 1 moves (held rows, gates, resume from checkpoint); `retry` on payments and payouts partitions; K1, K4 |
| R37-13 | "Errata owed" table complete, incl. RFC-004 traceability for P4-S117/P4-S118 and its status line |
| R37-14 | Op 3 `principal_refused` dropped; references are a per-provider namespace |
| R37-15 | Op 4b rows for another provider, amount/currency difference, final failure after confirmation |
| R37-16 | Minor-unit exponent from Share's configuration per (provider, currency); KES example corrected |
| R37-17 | `ShownRate` with `direction` |
| R37-18 | Quote validity by `occurred_at`, received within expiry + 24 h (D-37-2) |
| R37-19 | `NOT_FOUND` reasons; `no_destination` carried forward, escalated after 4 runs (D-37-4); `version_gone` on resend escalated |
| R37-20 | Op 5 caller restriction, ownership check, `(share.sensitive)` redaction |
| R37-21 | A run starts at its cut; `payout_schedule` named as the calendar source |
| R37-22 | Feed identity per C01 (partition = account, stream, `stream_seq`); partitioning fixed, else a major version |
| R37-23 | "Coordinated minor version, consumer first" |
| R37-24 | "(assumed, RFC-004 R4-B3)"; fan-out estimate includes one C15 call per member and move retries |
| R37-25 | Scenarios added: X1-S12, P4-S99, P4-S51, P4-S67, P4-S91, P4-S113; P4-S18 cited for row 5 only |
| R37-26 | C08 check numbering restated in op 2 |
| R37-27 | Console fans out only to `probeAccountSet(v)`; audit check against the signed digest; RFC-005 DT-32b |
| R37-28 | Per-provider `Pnr` exposure alert `provider_pnr_alert_usd`; RQ-37-3 |
| R37-29 | Console warning above `credit_limit_warn_above`; RQ-37-2 |
| R37-30 | `final?` required iff `failed` |
| C05 review 45 M5 (orchestrator, binding) | Op 2 answer `temporarily_unavailable{identity_stale}` when `iam_fresh` is stale for a KYB-gated set: nothing appended, console retries under the same `action_id`; mapping to C08; K2c |
