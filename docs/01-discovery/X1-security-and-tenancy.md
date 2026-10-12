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
| X1-N2 | **Accounts are isolated.** A principal sees and changes only its own account's reservations, booking requests, wallet, headroom, agent keys and statements; a supplier sees only its own links' schedules and its own settlements, and of the reservations on its links only their rate, window, endpoints (their termination points on its own link) and an opaque per-reservation reference, never the buyer's account identity unless the buyer consents (an account administrator's consent, per named supplier, withdrawable for the future: from the withdrawal nothing new is disclosed, though references already seen cannot be unlinked) or a legal order requires it (a compliance disclosure, approved by a second compliance operator, for the order's scope, by default the buyer's reservations on that supplier's links, and until the order's end date or compliance ends it) (POL-33); a supplier's statement shows a usage-priced share by an opaque charge-line reference, never by the buyer's account (POL-33); a webhook goes only to an endpoint its own account registered and carries nothing about another account. A request for another account's data reveals nothing, not even whether it exists. | Zero cross-account reads, changes or webhooks; zero buyer identities shown to a supplier without consent or a legal order. |
| X1-N3 | **Agent keys act only within their account and their scope, and every credential stops working within 60 s of its revocation** (POL-25). A key acts for one account; once its account revokes it, every new booking or status submission with it is not accepted, and any other request refused, within 60 s and its requests not yet decided fail ("key revoked", POL-04); every operation records the key that performed it. The same 60 s bound applies to every credential: an agent key, a user's session (when the user is removed, loses a right the session relied on, or the session is ended) and a certificate or other credential of a supplier or an exporter, once revoked. | Zero operations by a key outside its account; zero operations accepted with any credential more than 60 s after its revocation. |
| X1-N4 | **Idempotency keys are scoped to the account** (POL-29). The same key used by two accounts gives two independent requests; a reuse by another principal of the same account is not accepted; neither another account nor another principal can learn anything about a request through its key. | Zero cross-account or cross-principal collisions or disclosures through idempotency keys. |
| X1-N5 | **Only authentic payment notifications move money.** A notification not proven authentic by its provider's method moves no money and is recorded for investigation. | Zero money movements from unproven notifications. |
| X1-N6 | **Buyers and suppliers can verify Share's webhooks** (POL-04). Every webhook Share sends, to a buyer or to a supplier, can be verified by its receiver as coming from Share and as unaltered. | Every webhook verifiable by its receiver. |
| X1-N7 | **Operator power is controlled** (POL-32, POL-30, POL-23, POL-17, POL-08). Every operator action, and every read it needs, belongs to exactly one role (POL-32): support reads, and acts on an account only at its documented request (made through the marketplace by an authenticated principal of the account who may make that change, and recorded); network operations records outages and restorations, terminates for network abuse, and declares a region disaster and its end with a second network operations approval; commercial sets prices and split weights, each with a second commercial approval, records partner terms, and registers and retires links; finance corrects prices, attributes quarantined traffic and reverses a mistaken attribution, sets or removes credit limits (on accounts that passed know-your-business checks; a limit above `credit_limit_four_eyes_above` only with a second finance approval), sets `usage_rate_cap`, and resolves money escalations (payouts, orphan reversals); compliance terminates for fraud or a sanctions or legal order, discloses a buyer's identity to a supplier under a legal order, and withholds a termination notice a legal order forbids (only as part of that termination, approved with it; a later request to withhold is refused; the holder is then told nothing the termination causes, but its status reads still give the true state, POL-30), each only with a second compliance operator's approval, erases a data subject's personal data on its recorded erasure request (one operator), and opens an erasure with no request only on a documented legal requirement, with a second compliance operator's approval, and reads the audit trail. An action awaiting a second approval changes nothing, lapses after `approval_expiry`, may be cancelled by its requester, and is refused at approval if its preconditions no longer hold. Each action needs that role and a reason the policy allows, and is recorded with the operator (and approver), the role and the reason; every operator read is recorded too. On Share's own decision, an operator may end a reservation only by termination for a POL-30 reason. A support operator acting at the account's documented request makes the account's own change (POL-08), with the account's fees and charges. Write-offs are automatic, not operator actions. | Zero operator actions outside their role or the allowed reasons; zero actions that need a second approval taking effect without it, after `approval_expiry`, or on changed preconditions; every action and read recorded with its reason. |
| X1-N8 | **Every change to money, capacity, links or keys is attributable** (POL-19). Each such change records the principal and the time, and so does every grant or removal of an operator role or an administrator right, every consent given or withdrawn, every change of a price, weight, partner term or other policy setting, and every webhook endpoint registered or changed; the audit record itself cannot be altered or removed through the system, an alteration made below it (with administrative or physical access to storage) is detected and recorded and accepted by no reader, and the record is kept for the retention period. | Every change traceable to a principal; zero audit records altered through the system; every alteration below it detected; zero altered records accepted by any reader. |
| X1-N9 | **Only an account administrator manages keys, limits, users and endpoints** (POL-25, POL-32). Only an account administrator can issue, change or revoke agent keys and set or raise their limits, add or remove the account's users, grant or remove their administrator right (an account always keeping one), and register, change or remove the account's webhook endpoints; likewise only a supplier administrator manages its supplier's users, administrator rights, credentials, payout destination and endpoints (POL-22); an agent key cannot change any key's limits, issue keys, revoke keys, manage users or endpoints or give consent to identify the account to a supplier (POL-33); an account has at most `account_max_keys` keys. An account or supplier none of whose administrators can act is recovered only by onboarding, which re-verifies the business and grants the administrator right to a user it names, every user being told; for `recovery_hold` an objection by an administrator who held the right before cancels the recovery, and the new administrator is held: it cannot remove users or administrator rights, issue keys or a supplier's credentials (exporters' included), change a supplier's payout destination, register or change endpoints or give consent; a right it grants is held likewise and removed on a cancellation, and an erasure request it passes on is held until the recovery is final, refused on a cancellation (POL-32, POL-19). | Zero key, limit, user, administrator-right or endpoint changes, and zero supplier consents, made by anyone but an administrator of the account; zero accounts above `account_max_keys`; zero administrator rights granted outside onboarding's recovery; zero recoveries completed over an objection made within `recovery_hold`; zero keys, credentials, payout-destination changes, endpoints or consents issued or made, and zero erasures executed, on the act of a held administrator during the hold; zero rights granted in a cancelled recovery's hold surviving it. |
| X1-N10 | **Only the link's supplier changes what it sells** (POL-07). Only the link's own supplier may book or cancel maintenance on it, announce a permanent reduction or record a permanent increase; only the supplier, or an operator in the network operations role (POL-32), may record an unplanned outage or its restoration; only an operator in commercial registers or retires a link. Anyone else is refused as if the link did not exist. | Zero capacity changes or maintenance bookings by anyone else. |
| X1-N11 | **Personal data can be erased without breaking the audit** (POL-19, POL-24). Logs, audit records, history and financial records identify every principal by a stable pseudonymous identifier and never hold personal data; personal data is held apart, and when it must be erased it is erased so that it cannot be recovered, while every financial and audit record keeps its pseudonymous identifier, unaltered, for the retention period. Erasure is executed only on a recorded erasure request: a user's for its own data, through an administrator of its account or by a documented request it makes itself; an operator's for its own data, through workforce administration; a documented erasure request by or for a person who is not a Share user, naming the exporters and period concerned, verified by compliance; or, with no request, a documented legal requirement approved by a second compliance operator and recorded as a request with its legal reference. It is executed by one operator in compliance and recorded, and complete in every copy (the live store, every backup and every escrowed copy) within `erasure_max` of the request's record (POL-19, POL-32). A record that holds the data of more than one person is erased whole; a supplier's payout destination details are erased only once every payout to them is confirmed or has failed finally and is reconciled, `erasure_max` running from then; a user's or an account's request covers the payloads received before it is executed; the written request and evidence of a person who is not a user are read only by compliance and erased `erasure_evidence_retention` after the request is executed or refused (POL-19). | Zero personal data in logs, audit, history or financial records; every erased person's data unrecoverable from every copy within `erasure_max` of the request; zero erasures by anyone but compliance, or without a recorded erasure request; zero audit or financial records altered or made irreproducible by an erasure. |

## Constraints and assumptions

| Constraint or assumption | Status |
|---|---|
| Agent keys, per-key spending and in-flight limits and rate limits are in scope now; only an account administrator manages keys; revocation within 60 s; at most `account_max_keys` (100) keys per account. | *Decided* (POL-25) |
| Idempotency keys are per account; a reuse by another principal is not accepted; retention 24 h for bookings. | *Decided* (POL-29) |
| Share ends a reservation outside POL-07 and POL-16 only for fraud, a sanctions or legal order, or network abuse, recorded with reason and operator. | *Decided* (POL-30) |
| Only a link's supplier books maintenance or announces a permanent reduction; network operations may record outages and restorations. | *Decided* (POL-07) |
| Webhooks to buyers are signed and retried for `webhook_retry`. | *Decided* (POL-04) |
| Every reservation change is recorded with who and when, kept 7 years; principals are recorded by pseudonymous identifiers and personal data is held apart and erasable. Kenya's Data Protection Act 2019 gives data subjects rights of erasure; legal confirms the rules per market. | *Decided* (POL-19, POL-06, POL-24) |
| Erasure is complete in every copy, backups and escrow included, within `erasure_max` (30 days) of the data subject's request. Legal confirms the bound per market. | *Assumed* (POL-19, POL-24) |
| Buyer funds are held through a licensed payment partner; KYB for credit-limit accounts. | *Decided* (POL-24) |
| Operator roles: support, network operations, commercial, finance, compliance; each action and the reads it needs belong to one role; four eyes on fraud and legal-order terminations, on disclosing a buyer's identity to a supplier under a legal order and on withholding a termination notice (compliance), on prices and split weights (commercial) and on region-disaster declarations (network operations), lapsing after `approval_expiry` (72 h); finance sets credit limits and `usage_rate_cap` and resolves money escalations; account administrators, supplier administrators, suppliers and exporters own the remaining actions. | *Decided* (POL-32) |
| A supplier sees a reservation's rate, window, endpoints and an opaque reference, not the buyer's identity unless the buyer consents or a legal order requires it. Consent is given by an account administrator, per named supplier, and recorded; it can be withdrawn, taking effect for future views; an agent key cannot give it. Disclosure under a legal order is a compliance action approved by a second compliance operator, recorded with the order. | *Decided* (POL-33, POL-32, POL-25) |
| Rejections never disclose other buyers. | *Decided* (POL-10), owned by P1 |

## Out of scope

- How operators are vetted and assigned to roles, and the regulatory side of roles
  (POL-24). The roles themselves are POL-32, and every grant or removal of a role is
  attributable (X1-N8).
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
