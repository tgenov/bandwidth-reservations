# RFC-004. Wallet, ledger and supplier revenue split

| | |
|---|---|
| **Status** | Implemented (prototype) in `billing/`. Not built: payout execution (treasury), currencies and FX, webhook authentication, provider reconciliation. See [Implementation status](#implementation-status). |
| **Satisfies** | P4-S01 to P4-S26 ([spec](../02-specs/P4-wallet-and-settlement.feature)). S04, S05, S06 and S26 are proposed here and not built. S02, S12, S16, S22 and S25 are built but not yet verified by a test. |
| **Decisions** | D15, D19, D20, D23, D24, D25, D27, D29 ([log](../history/decision-log.md)) |
| **Depends on** | [RFC-003](RFC-003-usage-metering.md): decides when a (reservation, minute) is charged, computes its total, picks the rate and split weights by usage time, holds the minute lock, and owns the exposure bound and suspend/resume |

## Need

Buyers prepay into a wallet through payment providers whose webhooks repeat, arrive out
of order and arrive late. Each per-minute usage charge produced by metering (RFC-003) has
to be drawn from that wallet and divided among every supplier on the route plus the
marketplace's commission, and suppliers have to be paid what they are owed.

Charges are revised after they are posted: late usage raises a minute's total, and price
corrections can lower it. The business requires that late billing be no different from
regular billing when splitting payouts. That rules out a separate correction path and
any rounding rule under which a bigger total can give a supplier less.

Finance needs books that balance at every instant and a history nobody can edit, so that
any balance can be explained from its entries. See
[P4](../01-discovery/P4-wallet-and-settlement.md).

## Approach

### Components

All in the NestJS service `billing/`, one process with an HTTP and a Kafka transport
(`billing/src/main.ts`).

| Component | File | Role |
|---|---|---|
| `WebhookController` | `src/wallet/webhook.controller.ts` | `POST /webhooks/payments`, `GET /wallets/:customerId` |
| `WalletRpcController` | `src/wallet/wallet-rpc.controller.ts` | `@MessagePattern('wallet.balance')` request-reply. Also hosts RFC-003's `billing.admission-check` reply, which is a known defect: it fails on every request ([C25](../04-delivery/contracts.md#c25-billingadmission-check-request-reply)) |
| `WalletService` | `src/wallet/wallet.service.ts` | Idempotent top-up posting; balance reply |
| `LedgerService` | `src/ledger/ledger.service.ts` | The only writer of `journals` and `entries`; balances; payout run |
| `split` | `src/domain/split.ts` | D'Hondt apportionment of an integer amount |
| `RatingService.rateMinute` | `src/rating/rating.service.ts` | The single posting path for charges and corrections (described below; its triggering is RFC-003) |

### Money

- Amounts are integer **micros**, 10⁻⁶ of the currency unit, held as `bigint` in
  TypeScript and `bigint` in Postgres. No floating point anywhere.
- Amounts cross JSON as decimal strings (`amountMicros`, `balanceMicros`) so values above
  2⁵³ survive.
- One currency is implied. Nothing in the schema records which (see Risks).

### Accounts

There is no accounts table. An account is a text key on each entry; its balance is the
sum of its entries. Signs are from the marketplace's point of view: positive means the
marketplace holds or owes that money.

| Account | Example | Positive balance means | Created by |
|---|---|---|---|
| `wallet:<customerId>` | `wallet:c1` | Prepaid funds the buyer has left | First entry for the customer |
| `supplier:<id>` | `supplier:A` | Owed to the supplier and not yet paid out | `rate_splits.account` |
| `revenue:share` | | The marketplace's earned commission | `rate_splits.account` |
| `clearing` | | Contra account for the outside world (payment providers and banks); negative after top-ups, positive after payouts | Top-ups and payouts |

Movements:

| Journal `kind` | Entries | Posted by |
|---|---|---|
| `topup` (completed) | `wallet:c +X`, `clearing −X` | `WalletService.applyPaymentEvent` |
| `topup` (reversed) | `wallet:c −X`, `clearing +X` | `WalletService.applyPaymentEvent` |
| `charge` | `wallet:c −T`, each party `+share_i`, Σ share_i = T | `rateMinute`, first posting for a (reservation, minute) |
| `correction` | the difference between the new target and what is already posted for that (reservation, minute) | `rateMinute`, every later posting |
| `payout` | `supplier:s −B`, `clearing +B` | `LedgerService.payoutRun` |

### Tables (`billing/schema.sql`)

```sql
journals (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('charge','correction','topup','payout')),
  reservation_id  text,          -- charge and correction only
  minute          timestamptz,   -- charge and correction only
  reference       text,          -- topup: '<provider_txn_id>:<type>'; payout: the account
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
)  -- index (reservation_id, minute)

entries (
  journal_id  bigint NOT NULL REFERENCES journals,
  account     text   NOT NULL,
  amount      bigint NOT NULL CHECK (amount <> 0),   -- signed micros
  PRIMARY KEY (journal_id, account)                  -- one line per account per journal
)  -- index (account)

payment_events (
  provider_txn_id  text NOT NULL,
  type             text NOT NULL CHECK (type IN ('completed','reversed')),
  customer_id      text NOT NULL,
  amount_micros    bigint NOT NULL CHECK (amount_micros > 0),
  occurred_at      timestamptz NOT NULL,
  PRIMARY KEY (provider_txn_id, type)                -- the webhook idempotency key
)
```

`rate_splits (rate_id, account, weight integer CHECK (weight > 0))` holds the split
weights per rate. Choosing the rate row for a minute is RFC-003's job.

### Enforcement in the database

The database, not the application, is the last line of defence for the two ledger
invariants.

1. **Every journal balances.** `check_journal_balanced()` sums all entries of
   `NEW.journal_id` and raises `journal % does not balance` if the sum is not zero. It is
   attached as

   ```sql
   CREATE CONSTRAINT TRIGGER journal_balanced
     AFTER INSERT ON entries DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION check_journal_balanced();
   ```

   Deferred to `COMMIT`, because entries are inserted one row at a time and only the
   finished set has to balance. A failing check aborts the whole transaction, including
   whatever else it wrote (the `payment_events` row, the `minute_charges` row).
2. **Append-only.** `forbid_mutation()` raises `<table> is append-only`. It runs
   `BEFORE UPDATE OR DELETE ... FOR EACH ROW` on `entries` and `journals` (and on
   `flow_records`, which belongs to RFC-003). A correction is always a new journal.

Since every journal balances, the whole ledger sums to zero, and every account's balance
is fully explained by its entries.

### `LedgerService` API

```ts
type JournalKind = 'charge' | 'correction' | 'topup' | 'payout';
interface JournalInput {
  kind: JournalKind;
  reservationId?: string;
  minute?: Date;
  reference?: string;
  amounts: Map<string, bigint>;   // signed, per account
}

post(c: PoolClient, j: JournalInput): Promise<bigint | null>
balance(account: string, c?: PoolClient): Promise<bigint>
balances(): Promise<Map<string, bigint>>
payoutRun(): Promise<Map<string, bigint>>
```

- `post` runs inside the caller's transaction, so the journal commits or rolls back with
  the business fact that caused it. It drops zero amounts; if nothing is left it writes
  nothing and returns `null`. If the remaining amounts do not sum to zero it throws before
  writing. Otherwise it inserts one `journals` row and all `entries` rows in a single
  `INSERT ... SELECT FROM unnest(...)`, and returns the journal ID. The deferred trigger
  re-checks at `COMMIT`, so a bug in `post` cannot persist unbalanced books.
- `balance` is `SELECT COALESCE(SUM(amount), 0) FROM entries WHERE account = $1`.
- `payoutRun` takes `pg_advisory_xact_lock(hashtext('payout-run'))` so only one run is
  active, reads every `supplier:%` account with a positive sum, and for each posts a
  `payout` journal moving that balance to `clearing`. Accounts at or below zero are
  skipped, so a clawed-back supplier's debt is netted against later earnings. Charges may
  keep posting during a run; anything committed after the read is paid next time.

### One posting path for every charge

A charge and a late correction are the same operation: bring the ledger for one
(reservation, minute) to its target. RFC-003 calls this, holding the minute's lock, both
when a minute is first rated and whenever a later record or a price correction changes it.

```
rateMinute(c, reservationId, minute):
  total   := the minute's charge in micros, computed from its TOTAL usage   -- RFC-003
  parties := the split weights of the rate in force at the minute         -- RFC-003
  target  := split(total, parties)            -- Map account -> share
  target[wallet(customer)] := -total
  posted  := SUM(entries.amount) GROUP BY account
             over journals WHERE reservation_id = $1 AND minute = $2
  delta   := for every account in target or posted: target[a] - posted[a]  (missing = 0)
  ledger.post(c, { kind: posted is empty ? 'charge' : 'correction',
                   reservationId, minute, amounts: delta })
```

Properties:

- **The minute's total is split, never the increment.** Each account converges to its
  share of the final total, whatever order and grouping the records arrived in.
- `delta` sums to zero because both `target` and `posted` do.
- If the parties or weights change between postings (a corrected rate version), accounts
  that left the split are reversed and new ones credited, by the same subtraction.
- With a house-monotone split, a rise in the total produces a correction whose supplier
  and commission lines are all ≥ 0 and whose wallet line is < 0. Only a lowered total (a
  price correction) produces negative supplier lines, which is a clawback.
- An empty `delta` posts nothing.

Worked example, weights a 31, b 76, c 70:

| | a | b | c | wallet |
|---|---|---|---|---|
| Charge, total 31: split(31) | 5 | 14 | 12 | −31 |
| Late usage, total 32: split(32) | 5 | 14 | 13 | −32 |
| Correction posted = split(32) − split(31) | 0 (no line) | 0 (no line) | +1 | −1 |

### The split: D'Hondt with a fixed tie-break

`split(amount: bigint, parties: { account: string; weight: number }[]): Map<string, bigint>`

Inputs: `amount ≥ 0` (a negative amount throws: amounts are totals, and differences are
taken after splitting); integer weights with a positive total `W`.

1. Sort parties by `account` in ascending JavaScript string order (UTF-16 code units).
   Index `i` below is the position in this order.
2. Initial shares: `s_i = floor(amount × w_i / W)`. This is a valid intermediate state
   of the sequential D'Hondt process, so it can be taken as the starting point.
3. Remaining units: `r = amount − Σ s_i`, with `0 ≤ r ≤ n − 1`.
4. Repeat `r` times: give one unit to the party with the smallest next jump point
   `(s_i + 1) / w_i`, which is the party with the highest D'Hondt quotient
   `w_i / (s_i + 1)`. Compare without division: `i` beats the current best `b` when
   `(s_i + 1) × w_b < (s_b + 1) × w_i`. Scanning from `i = 0` and replacing only on a
   strict improvement means **a tie goes to the party whose account name sorts first**.
5. Return `s_i` keyed by account.

Guarantees, all tested (P4-S17 to P4-S21):

- **Exact:** `Σ s_i = amount`.
- **House-monotone:** `split(A + 1)_i ≥ split(A)_i` for every party. This is the property
  largest remainder lacks.
- **Close to proportional:** `|s_i − amount × w_i / W| < n`. D'Hondt does not guarantee
  the quota (staying within one unit of the exact proportion); that is the price of
  monotonicity.
- **Deterministic:** same amount and weights, same shares.

Cost is `O(n log n + n × r) = O(n²)` per call, with `n` parties on a route (four in the
tests).

### Top-ups by payment webhook

`POST /webhooks/payments` with body

```json
{ "providerTxnId": "MP1", "type": "completed", "customerId": "c1",
  "amountMicros": "5000000", "occurredAt": "2026-01-01T12:00:00Z" }
```

1. **Validation.** The global `ValidationPipe` (`transform`, `whitelist`) applies
   `PaymentEventDto`: non-empty strings for `providerTxnId` and `customerId`; `type` in
   `completed | reversed`; `amountMicros` matching `^[0-9]+$` (`IsNumberString` with
   `no_symbols`); `occurredAt` a valid date. Failures return **400** before any database
   work.
2. **Idempotency key: `(provider_txn_id, type)`.** In one transaction:
   `INSERT INTO payment_events ... ON CONFLICT DO NOTHING`. Zero rows inserted means the
   event was already applied: return `{ "result": "duplicate" }`. Otherwise post a
   `topup` journal with `reference = '<provider_txn_id>:<type>'`, `wallet:<customer>`
   `±amount` and `clearing ∓amount` (minus for `reversed`). The event row and the journal
   commit together, so a crash cannot record one without the other.
   - The key includes `type` so a reversal is a separate event from the completion it
     reverses, under the same provider transaction ID.
   - The two journals commute, so a reversal that overtakes its completion leaves the
     same final balance.
3. **Response.** **200** with `{ "result": "applied" | "duplicate" }` for every
   well-formed event, duplicates included, so the provider stops retrying.
4. **After commit,** `ExposureService.check(customerId)` re-evaluates suspension (RFC-003).
   Emitting `customer.resume` from a top-up is current behaviour; whether service resumes
   automatically is business policy (D27).

**To build** (not in the prototype):

- **Authentication** (P4-S06): verify the provider's signature or source before
  validation; return 401 on failure.
- **Content mismatch on redelivery** (P4-S05): on conflict, compare `customer_id`,
  `amount_micros` and `occurred_at` with the stored row; if they differ, record the
  mismatch for reconciliation instead of answering `duplicate`. The same rule was applied
  to client idempotency keys in route reservation (D23).
- **Zero amount** (P4-S04): reject `amountMicros = "0"` in the DTO. Today it passes
  validation, fails the `amount_micros > 0` check and returns 500, which a provider will
  retry indefinitely.

### Wallet balance

Two read paths return the same body from `WalletService.standing(customerId)`:

| Path | Request | Reply |
|---|---|---|
| HTTP | `GET /wallets/:customerId` | `{ customerId, balanceMicros, exposureMicros, availableMicros }` |
| Kafka request-reply | `@MessagePattern('wallet.balance')`, payload `{ "customerId": "c1" }` validated by `CustomerQueryDto` | Same body, sent by Nest on `wallet.balance.reply` |

`balanceMicros` is `LedgerService.balance('wallet:<customerId>')`, a read of committed
entries. `exposureMicros` and `availableMicros` come from the exposure bound (RFC-003).
Request-reply suits callers that cannot proceed without the answer; the caller must
subscribe to the reply topic before sending.

### Implementation status

| Part | Status |
|---|---|
| `journals`, `entries`, balance trigger, append-only triggers | Built, tested (S09–S11); update/delete of `entries` and delete of `journals` built, not tested (S12) |
| `LedgerService.post`, `balance`, `balances` | Built |
| One posting path for charges and corrections | Built, tested (S13–S15); the correction's exact lines are not inspected by any test (S16) |
| D'Hondt `split` | Built, tested (S17–S21); tie-break untested (S22) |
| Webhook top-up with idempotency | Built, tested (S01, S03); reversal-first order untested (S02) |
| Balance over HTTP and Kafka RPC | Built, tested (S07, S08) |
| `billing.admission-check` over Kafka (RFC-003, hosted here) | Built, **defective**: every request fails ([C25](../04-delivery/contracts.md#c25-billingadmission-check-request-reply), fix pending in increment I5) |
| `payoutRun` (ledger side only) and clawback netting | Built, tested (S23, S24) |
| Webhook amount format (no decimals, signs or exponents) | Built (`IsNumberString` with `no_symbols`), not tested (S25) |
| Webhook authentication, mismatch detection, zero-amount rejection | Not built (S04–S06) |
| Money moved to suppliers (treasury, payout instructions) | Not built |
| Currencies and FX | Not built (S26) |
| Reconciliation with provider settlement reports | Not built |

## Benefits

Measured on the prototype (D29; local Docker, Postgres 17, Redpanda 24.2):

- **Order does not matter.** Over 3 seeds × 200 flow records, shuffled, with 30%
  delivered twice and the watermark advancing while records arrive, every account balance
  and every minute's total equal those from in-order delivery. More than 20 corrections
  per seed were posted, and in every one the wallet line was negative and every other
  line positive: late usage never took money back from a supplier.
- **The books balance.** Every journal, and the whole ledger, sums to zero after every
  test that posts money. The database refuses an unbalanced journal at `COMMIT` and an
  update to a journal.
- **Payments apply once.** Three provider events each delivered three times in shuffled
  order produce exactly three applied journals and the right balance.
- **Clawback is recovered.** After a price correction, a supplier paid 30,000 micros and
  owed 15,000 has a balance of −15,000, is skipped by the next payout run, and is paid
  15,000 once it earns another 30,000.
- **End to end.** 3,000 flow records with about 20% duplicates through Kafka produce
  exactly the expected total charge and a balanced ledger; the wallet balance
  answers over Kafka request-reply.
- **The tests catch the two design mistakes this RFC exists to avoid.** As recorded in
  D29, swapping in largest-remainder rounding, or splitting each correction amount on its
  own, makes the tests fail.

Not measured: ledger throughput on its own. Ingestion runs at about 800 records/s with one
transaction per record (RFC-003); the ledger's share of that cost is unknown.

## Competition

| Alternative | Why it lost |
|---|---|
| **Largest remainder (Hamilton)** | Stays within one unit of each exact proportion, but suffers the Alabama paradox. With weights a 31, b 76, c 70, it splits 31 as a 6, b 13, c 12 and 32 as a 5, b 14, c 13: one more micro of usage takes a micro from a. Because each minute is re-split from its new total, ordinary late usage would claw money back from a supplier who may already be paid. This was the method first specified, and it was replaced once the test showed the paradox (D24). |
| **Floor of each proportion, remainder to the first (or largest) party** | Sums exactly and is simple, but it is not monotone either: when several other parties' floors step up at once, the remainder party's share drops. With weights 31, 76, 70 and the remainder to a, 2 micros split 2 / 0 / 0 and 3 micros split 1 / 1 / 1. It also hands one party up to n − 1 micros every minute, a systematic bias. |
| **Other divisor methods (Sainte-Laguë / Webster)** | Also house-monotone, so equally correct for late usage, and less biased towards large weights than D'Hondt. Not a loser on correctness. D'Hondt was chosen; the bias it introduces is at most n − 1 micros per charge (see Risks). Switching is a change to `split` only. |
| **Split each correction amount on its own** | Makes balances depend on how usage was chunked and in what order it arrived. With two parties of equal weight, a 1-micro charge goes to the first party on the tie, and a 1-micro late correction goes to the same party again: 2 / 0 instead of split(2) = 1 / 1. Rejected after the order-independence test caught it (D25). |
| **Single-entry balance columns** (`wallets.balance`, `suppliers.balance` updated in place) | No conservation check: a lost or doubled update leaves the system silently wrong. No history to explain a balance, so corrections cannot be audited, and concurrent updates need row locks on hot accounts. |
| **Balance checked by the application only** | A bug in one code path persists unbalanced books. The deferred trigger costs one aggregate per inserted row and makes that impossible to commit. |
| **Immediate (per-row) balance check** | Cannot work: a journal's entries are inserted one row at a time, so every intermediate state is unbalanced. Hence the deferred constraint trigger. |
| **Debit and credit columns instead of signed amounts** | Equivalent in power; signed amounts make "every journal sums to zero" a single `SUM`. |
| **Webhook idempotency by provider transaction ID alone** | A reversal shares the transaction ID of the payment it reverses and would be dropped as a duplicate. |
| **Idempotency in a cache with a TTL** | A redelivery after the TTL credits the wallet twice. Providers can redeliver late. The key lives in Postgres, in the same transaction as the journal. |
| **Separate posting code for corrections** | Contradicts the requirement that late billing is split like regular billing, and doubles the surface for rounding and pricing bugs. One `rateMinute` serves both. |
| **Floating-point or decimal-string money in the application** | Floats lose exactness; decimal libraries are slower and still need a rounding rule at the split. Integer micros make rounding explicit and happen in two places only: the charge (RFC-003) and the split. |

## Risks and open issues

1. **Payouts are bookkeeping only.** `payoutRun` posts `supplier → clearing`; no money
   leaves. Treasury needs payout instructions to banks or mobile money with their own
   idempotency keys, a payout schedule and minimum, handling of failed payouts (a
   reversal journal), and a limit on how long a supplier's clawback debt may stay open.
2. **One implicit currency.** Neither `entries` nor accounts carry a currency, and
   "micros" is relative to an unnamed unit. Several currencies are a stated requirement.
   A likely design: a currency per account (in the account key or an accounts table),
   a trigger requiring each journal to balance per currency, and FX as its own journal
   through per-currency FX accounts at a recorded rate. Open: who bears FX risk between
   charge and payout, and which currency suppliers are paid in. Conversion from micros to
   each provider's unit (M-Pesa: whole shillings) is also undefined.
3. **Webhooks are not authenticated.** Anyone who can reach `POST /webhooks/payments` can
   credit a wallet. This must be closed before any real use (P4-S06).
4. **Redelivery with different contents is accepted silently** as a duplicate (P4-S05),
   and a zero amount returns 500 (P4-S04).
5. **No reconciliation.** `clearing` is a single account for every provider and bank, so
   it cannot be matched to a provider's settlement report. Split it per provider, then
   reconcile daily. A reversal that never had a completion, or whose amount differs from
   its completion, debits the wallet today without being flagged.
6. **Gaps in database enforcement.**
   - Row triggers do not fire on `TRUNCATE`; `entries` and `journals` can be truncated.
     Add `BEFORE TRUNCATE` statement triggers.
   - A journal with no entries passes (the balance trigger fires on entry insert only).
   - Entries can be appended to an old journal in a later transaction, as long as the
     total still balances.
   - `payment_events` is not append-only. Deleting a row would let a redelivered webhook
     credit the wallet again.
   - The table owner can disable triggers. Run the service as a role that does not own
     the tables, with `INSERT` and `SELECT` only.
7. **Balances are computed by summing entries.** Cost grows with each account's history;
   a busy wallet gains a journal per reservation per minute. At scale this needs period
   closes with carried-forward balances, or a balance table maintained in the same
   transaction and checked against the entries.
8. **D'Hondt favours larger weights.** The at most n − 1 leftover micros of each charge
   tend to go to the largest-weight party, and ties go to the account that sorts first,
   which today is `revenue:share` ahead of every `supplier:*`. The bias is under n micros
   per (reservation, minute) charge, but it is systematic. If suppliers object, Webster
   is the drop-in alternative. The tie rule should be written into supplier contracts
   either way.
9. **Price corrections still claw back.** By design: when a total falls, supplier lines go
   negative. Late usage never does this; price corrections do (D20).
10. **Resume after top-up is policy.** The prototype emits `customer.resume` as soon as a
    top-up restores headroom. Whether that is automatic is a business decision (D15,
    D27), owned with the exposure bound in RFC-003. The check also runs after the top-up
    commits, so a crash between the two leaves a suspended customer suspended until the
    next check.
11. **Commission is a single account.** `revenue:share` takes one weight per rate; tax,
    fees or per-region revenue accounts are not modelled.
