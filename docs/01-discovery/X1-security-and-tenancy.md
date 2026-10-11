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
their links and settlements, and record changes to their links' capacity (POL-07);
Share's operators act on accounts under roles; payment providers call in with
notifications; Share calls buyers back by webhook (POL-04).

## Who is affected

| Who | How |
|---|---|
| Buyers and agent operators | Their reservations, requests and money must be reachable only by them; an agent key must not exceed what its account allows, nor change what it is allowed. |
| Suppliers | See their own links' schedules and settlements, and nobody else's; only they change their links' capacity. |
| Share operators | Act on other accounts only under a role, for the reasons policy allows, and are accountable for it. |
| Finance, compliance and audit | Need to know who did what to money, capacity, links or keys, and when, for the retention period (POL-06, POL-19, POL-24). |
| Share | A breach of isolation, a forged payment or a forged capacity change is a direct financial and reputational loss. |

## The problem

An account's reservations, booking requests, wallet and statements are reachable over a
public API. Idempotency keys are chosen by clients, so two accounts, or two agents of one
account, can choose the same key. Anything that can reach the payment notification
endpoint can claim a payment was made. A buyer receiving a webhook must be able to tell it
came from Share, and a webhook must never reach another account. An agent key that could
raise its own limits or issue new keys would make every limit meaningless. Anyone who
could change a link's capacity could take away other buyers' guarantees. Operators need to
act on any account, which is exactly the power that must be controlled and recorded.

## Needs

Scenarios in [`02-specs/X1-security-and-tenancy.feature`](../02-specs/X1-security-and-tenancy.feature)
cite the need they serve with a tag `@need-X1-Nn`.

| ID | Need | Success measure |
|---|---|---|
| X1-N1 | **Every operation is performed by an authenticated principal.** An unauthenticated request changes nothing and reveals nothing. | Zero operations performed without an authenticated principal. |
| X1-N2 | **Accounts are isolated.** A principal sees and changes only its own account's reservations, booking requests, wallet, headroom, agent keys and statements; a supplier sees only its own links' schedules and its own settlements, and of the reservations on its links only their rate, window, endpoints and an opaque per-reservation reference, never the buyer's account identity unless the buyer consents (an account administrator's consent, per named supplier, withdrawable for the future) or a legal order requires it (a compliance disclosure, approved by a second compliance operator) (POL-33); a webhook goes only to an endpoint its own account registered and carries nothing about another account. A request for another account's data reveals nothing, not even whether it exists. | Zero cross-account reads, changes or webhooks; zero buyer identities shown to a supplier without consent or a legal order. |
| X1-N3 | **Agent keys act only within their account and their scope** (POL-25). A key acts for one account; once its account revokes it, every new booking or status submission with it is not accepted, and any other request refused, within 60 s and its requests not yet decided fail ("key revoked", POL-04); every operation records the key that performed it. | Zero operations by a key outside its account, or more than 60 s after its revocation. |
| X1-N4 | **Idempotency keys are scoped to the account** (POL-29). The same key used by two accounts gives two independent requests; a reuse by another principal of the same account is not accepted; neither another account nor another principal can learn anything about a request through its key. | Zero cross-account or cross-principal collisions or disclosures through idempotency keys. |
| X1-N5 | **Only authentic payment notifications move money.** A notification not proven authentic by its provider's method moves no money and is recorded for investigation. | Zero money movements from unproven notifications. |
| X1-N6 | **Buyers can verify Share's webhooks** (POL-04). Every webhook Share sends can be verified by the buyer as coming from Share and as unaltered. | Every webhook verifiable. |
| X1-N7 | **Operator power is controlled** (POL-32, POL-30, POL-23, POL-17, POL-08). Every operator action belongs to exactly one role (POL-32): support reads, and acts on an account only at its documented request; network operations records outages and restorations and terminates for network abuse; finance corrects prices, attributes quarantined traffic, sets or removes credit limits (on accounts that passed know-your-business checks) and resolves money escalations (payouts, orphan reversals); compliance terminates for fraud or a sanctions or legal order, and discloses a buyer's identity to a supplier under a legal order, each only with a second compliance operator's approval. Each action needs that role and a reason the policy allows, and is recorded with the operator (and approver), the role and the reason. On Share's own decision, an operator may end a reservation only by termination for a POL-30 reason. A support operator acting at the account's documented request makes the account's own change (POL-08), with the account's fees and charges. Write-offs are automatic, not operator actions. | Zero operator actions outside their role or the allowed reasons; zero fraud or legal-order terminations, and zero identity disclosures under a legal order, without a second compliance approval; every action recorded with its reason. |
| X1-N8 | **Every change to money, capacity, links or keys is attributable** (POL-19). Each such change records the principal and the time; the audit record itself cannot be altered or removed and is kept for the retention period. | Every change traceable to a principal; zero altered audit records. |
| X1-N9 | **Only an account administrator manages keys and limits** (POL-25). Only an account administrator can issue, change or revoke agent keys and set or raise their limits; an agent key cannot change any key's limits, issue keys, revoke keys or give consent to identify the account to a supplier (POL-33); an account has at most `account_max_keys` keys. | Zero key or limit changes, and zero supplier consents, made by an agent key; zero accounts above `account_max_keys`. |
| X1-N10 | **Only the link's supplier changes what it sells** (POL-07). Only the link's own supplier may book maintenance on it or announce a permanent reduction; only the supplier, or an operator in the network operations role (POL-32), may record an unplanned outage or its restoration. Anyone else is refused as if the link did not exist. | Zero capacity changes or maintenance bookings by anyone else. |

## Constraints and assumptions

| Constraint or assumption | Status |
|---|---|
| Agent keys, per-key spending and in-flight limits and rate limits are in scope now; only an account administrator manages keys; revocation within 60 s; at most `account_max_keys` (100) keys per account. | *Decided* (POL-25) |
| Idempotency keys are per account; a reuse by another principal is not accepted; retention 24 h for bookings. | *Decided* (POL-29) |
| Share ends a reservation outside POL-07 and POL-16 only for fraud, a sanctions or legal order, or network abuse, recorded with reason and operator. | *Decided* (POL-30) |
| Only a link's supplier books maintenance or announces a permanent reduction; network operations may record outages and restorations. | *Decided* (POL-07) |
| Webhooks to buyers are signed and retried for `webhook_retry`. | *Decided* (POL-04) |
| Every reservation change is recorded with who and when, kept 7 years. | *Decided* (POL-19, POL-06) |
| Buyer funds are held through a licensed payment partner; KYB for credit-limit accounts. | *Decided* (POL-24) |
| Operator roles: support, network operations, finance, compliance; each action belongs to one role; four eyes (a second compliance operator's approval) on fraud and legal-order terminations and on disclosing a buyer's identity to a supplier under a legal order; finance sets credit limits and resolves money escalations. | *Decided* (POL-32) |
| A supplier sees a reservation's rate, window, endpoints and an opaque reference, not the buyer's identity unless the buyer consents or a legal order requires it. Consent is given by an account administrator, per named supplier, and recorded; it can be withdrawn, taking effect for future views; an agent key cannot give it. Disclosure under a legal order is a compliance action approved by a second compliance operator, recorded with the order. | *Decided* (POL-33, POL-32, POL-25) |
| Rejections never disclose other buyers. | *Decided* (POL-10), owned by P1 |

## Out of scope

- How operators are vetted and assigned to roles, and the regulatory side of roles
  (POL-24). The roles themselves are POL-32.
- The authentication mechanism (keys, OAuth, mutual TLS) and each payment provider's
  authenticity scheme: interface contracts.
- Buyer KYC and supplier KYB processes (POL-24).
- Abuse limits on agent keys (spending, capacity in flight, request rate): enforced at
  admission and owned by [P2](P2-route-reservation.md) and [P4](P4-wallet-and-settlement.md).

## Open questions

Answered by the policy register and removed: operator power to end a reservation (POL-30);
idempotency scope (POL-29); key management and revocation (POL-25); who may
change a link's capacity (POL-07); what a supplier may see of buyers
(POL-33); which operator roles exist and what each may do (POL-32).

None open.
