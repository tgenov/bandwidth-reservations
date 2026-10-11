# X2. Non-functional targets (cross-cutting)

## Why a cross-cutting requirement set

Availability, load, latency, durability, recovery and retention apply across P1–P4, and
each target has to be measured the same way wherever it applies. Stating them once, here,
from POL-06, gives each target one owner and one measurement method. It is numbered X2 for
the same reason as [X1](X1-security-and-tenancy.md).

## Context

The job listing describes a rebuild for "roughly 50x the scale" at "global scale"; the
Platform Engineer listing sets a 99.99% availability target (see the
[company profile](company-profile.md)). POL-06 turns these into targets. Without them, a
design cannot size partitions, replicas or regions, and nothing can be accepted.

## Who is affected

| Who | How |
|---|---|
| Buyers and AI agents | Need answers fast enough to call synchronously, and a service that is up. |
| Suppliers | Lose sales while admission is down. |
| Finance and compliance | Cannot lose a confirmed reservation, a money movement, a payment event or an accepted record; must keep records 7 years. |
| Platform engineering | Sizes and operates the system against these numbers. |

## Needs

Scenarios in [`02-specs/X2-non-functional.feature`](../02-specs/X2-non-functional.feature)
cite the need they serve with a tag `@need-X2-Nn`. Every value is a POL-06 default unless
stated otherwise.

| ID | Need | Success measure (POL-06 default) | Measured by |
|---|---|---|---|
| X2-N1 | **Availability per capability.** | Every target per region: admission API 99.99% per calendar month; usage ingestion 99.99% (it may lag but must not lose an accepted record); wallet, payouts and reporting 99.9%. | The share of minutes in the month in which the capability answers correctly from outside the system, per region. |
| X2-N2 | **Design load.** | Admission: 25,000 requests/s overall, 2,500/s on the hottest link. Metered traffic: ×50 of 45 TB/day, about 2.25 PB/day. | A load test at the design profile, sustained for at least one hour, with every latency target met. |
| X2-N3 | **Latency per operation.** | Single-link booking: p99 ≤ 200 ms to a final answer, whatever the booking length. Route booking: p99 ≤ 200 ms (`ack_budget`, POL-04) to acknowledgement; final outcome within the request's deadline (POL-26). Top-up to credited balance: p99 ≤ 10 s from the provider's notification. Suspension decision to enforcement: ≤ 60 s. Charge timeliness: a minute's reservation charge posted within 2 min of the minute's end; usage-priced charges within `max_lateness` + 2 min. | Measured at the system boundary under the design load, from the request's arrival to the response (or, for top-ups, enforcement and charges, from the triggering event or the minute's end to the observable effect). |
| X2-N4 | **No loss of recorded facts.** | RPO 0 for confirmed reservations, ledger movements, payment events and accepted usage records on loss of a node or a zone; RPO ≤ 1 min on loss of a region. | A failure-injection test per failure scope: anything acknowledged before the failure (or, for a region, more than 1 min before it) is present after recovery. |
| X2-N5 | **Recovery time (RTO).** | On loss of a node or zone: admission back within 5 min, billing and wallet within 15 min. On loss of a region: 1 h. | A failure-injection test, from the failure to the capability answering correctly again. |
| X2-N6 | **Retention.** | Ledger, payment events, reservation history and raw usage kept and retrievable for 7 years. | Retrieval of records at the edge of the retention period. |

## Constraints and assumptions

| Item | Status |
|---|---|
| All targets above. | *Decided* (POL-06) |
| 45 TB of traffic a day today; ×50 for the rebuild. | *Confirmed* (Share's claim; job listing) |
| 500 admission requests/s today. | *Assumed* (the basis of POL-06's 25,000/s) |
| Seven-year retention needs legal confirmation per market. | *Decided* (POL-06, POL-24), pending legal confirmation |

## Out of scope

- How the targets are met (regions, replication, partitioning): the RFCs.
- Provisioning latency on the network (Problem 5 in the company profile).

## Open questions

Answered by the amended POL-06 and removed: the failure scope for RPO and RTO; charge
timeliness; per-region scope (every target is per region).

1. **Flow-record rate.** POL-06 leaves the record rate "to be sized from exporter data"
   (P3 open question 2).
2. **Webhook and notification load.** No target for payment notifications per second, or
   for buyer webhooks sent per second.
3. **Regional RPO for money.** On loss of a region POL-06 allows up to 1 min of acknowledged
   facts to be lost. That includes posted money movements and payment notifications already
   acknowledged to the provider, which will not be redelivered. Is that intended for money as
   well as reservations, and how is the gap reconciled (POL-24)?
