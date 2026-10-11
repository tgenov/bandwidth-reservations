# X1. Security, tenancy and audit (cross-cutting)

## Why a cross-cutting requirement set

Every problem (P1–P4) has principals acting on accounts' capacity and money. Stating
authentication, isolation and audit once, here, gives each requirement one owner and
stops P1–P4 from re-stating it differently. P1–P4 inherit every need below. It is numbered
X1, not P5, because the company profile's ranked list already uses "Problem 5" and
"Problem 6" for provisioning and SLA enforcement, and the policy register cites Problem 6.

## Context

Share holds buyer funds and sells scarce, pre-booked capacity to "anyone", AI agents
included, through an API. Buyers act through people and agent keys (POL-25); suppliers see
their links and settlements; Share's operators act on accounts under roles; payment
providers call in with notifications; Share calls buyers back by webhook (POL-04).

## Who is affected

| Who | How |
|---|---|
| Buyers and agent operators | Their reservations, requests and money must be reachable only by them; an agent key must not exceed what its account allows. |
| Suppliers | See their own links' schedules and settlements, and nobody else's. |
| Share operators | Act on other accounts only under a role, and are accountable for it. |
| Finance, compliance and audit | Need to know who did what to money or capacity, and when, for the retention period (POL-06, POL-19, POL-24). |
| Share | A breach of isolation or a forged payment is a direct financial and reputational loss. |

## The problem

An account's reservations, booking requests, wallet and statements are reachable over a
public API. Idempotency keys are chosen by clients, so two accounts can choose the same
key. Anything that can reach the payment notification endpoint can claim a payment was
made. A buyer receiving a webhook must be able to tell it came from Share. Operators need
to act on any account, which is exactly the power that must be controlled and recorded.

## Needs

Scenarios in [`02-specs/X1-security-and-tenancy.feature`](../02-specs/X1-security-and-tenancy.feature)
cite the need they serve with a tag `@need-X1-Nn`.

| ID | Need | Success measure |
|---|---|---|
| X1-N1 | **Every operation is performed by an authenticated principal.** An unauthenticated request changes nothing and reveals nothing. | Zero operations performed without an authenticated principal. |
| X1-N2 | **Accounts are isolated.** A principal sees and changes only its own account's reservations, booking requests, wallet, headroom and statements; a supplier sees only its own links' schedules and its own settlements. A request for another account's data reveals nothing, not even whether it exists. | Zero cross-account reads or changes. |
| X1-N3 | **Agent keys act only within their account and their scope** (POL-25). A key acts for one account; an account can revoke a key, after which it is refused; every operation records the key that performed it. | Zero operations by a key outside its account or after its revocation. |
| X1-N4 | **Idempotency keys are scoped to the account.** The same key used by two accounts gives two independent requests, and one account cannot learn anything about another's request by using its key. | Zero cross-account collisions or disclosures through idempotency keys. |
| X1-N5 | **Only authentic payment notifications move money.** A notification not proven authentic by its provider's method moves no money and is recorded for investigation. | Zero money movements from unproven notifications. |
| X1-N6 | **Buyers can verify Share's webhooks** (POL-04). Every webhook Share sends can be verified by the buyer as coming from Share and as unaltered. | Every webhook verifiable. |
| X1-N7 | **Operator power is controlled.** An operator action on an account's reservations, prices or money requires a role that permits it, and is recorded with the operator and the reason. Price corrections are operator actions. | Zero operator actions without a permitting role; every one recorded with its reason. |
| X1-N8 | **Every change to money or capacity is attributable** (POL-19). Each such change records the principal and the time; the audit record itself cannot be altered or removed and is kept for the retention period. | Every change traceable to a principal; zero altered audit records. |

## Constraints and assumptions

| Constraint or assumption | Status |
|---|---|
| Agent keys, per-key spending and in-flight limits and rate limits are in scope now. | *Decided* (POL-25) |
| Webhooks to buyers are signed and retried for `webhook_retry`. | *Decided* (POL-04) |
| Every reservation change is recorded with who and when, kept 7 years. | *Decided* (POL-19, POL-06) |
| Buyer funds are held through a licensed payment partner; KYB for credit-limit accounts. | *Decided* (POL-24) |
| Rejections never disclose other buyers. | *Decided* (POL-10), owned by P1 |

## Out of scope

- The list of operator roles and what each may do: a later decision (with D-24 / POL-24 on
  the regulatory side). The need here is that roles exist and are enforced.
- The authentication mechanism (keys, OAuth, mutual TLS) and each payment provider's
  authenticity scheme: interface contracts.
- Buyer KYC and supplier KYB processes (POL-24).
- Abuse limits on agent keys (spending, capacity in flight, request rate): enforced at
  admission and owned by [P2](P2-route-reservation.md) and [P4](P4-wallet-and-settlement.md).

## Open questions

1. **What a supplier may see of buyers.** POL-10 forbids disclosing buyers to other buyers.
   May a supplier see which account holds a reservation on its link (for provisioning), or
   only the reservation?
2. **Roles.** Which operator roles exist, and which actions does each permit?
