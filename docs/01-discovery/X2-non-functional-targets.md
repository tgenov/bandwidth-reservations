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
| Network operations | Enforce suspensions at the edge within their part of the enforcement target. |
| Platform engineering | Sizes and operates the system against these numbers. |

## Needs

Scenarios in [`02-specs/X2-non-functional.feature`](../02-specs/X2-non-functional.feature)
cite the need they serve with a tag `@need-X2-Nn`. Every value is a POL-06 default unless
stated otherwise.

| ID | Need | Success measure (POL-06 default) | Measured by |
|---|---|---|---|
| X2-N1 | **Availability per capability.** | Every target per region: admission API 99.99% per calendar month; usage ingestion 99.99% (it may lag but must not lose an accepted record); wallet, payouts and reporting 99.9%. Rating and posting has no availability target of its own; it is judged by charge timeliness (X2-N3). Planned maintenance is not excluded; the loss of a whole region is a declared disaster, outside the measurement (it has its own RTO and RPO). | Synthetic probes from at least two locations outside the region, at least every 10 s (at least 12 a minute), each asking for its capability's operation and succeeding only with a correct answer within that operation's per-probe limit (POL-06): admission, a single-link booking answer, 200 ms; usage ingestion, a flow record acknowledged as accepted, 1 s; wallet, a balance and headroom answer, 200 ms (it gates admission); payouts, a payout's status, 1 s; reporting and statements, one day's statement, 2 s. A minute is available if at least 90% of its probes succeed. Availability is the share of available minutes in the calendar month (POL-06). |
| X2-N2 | **Design load.** | Admission: 25,000 requests/s overall, 2,500/s on the hottest link; 80% single-link and 20% routes; 70% of requests fit. Metering: ×50 of 45 TB/day, about 2.25 PB/day, as flow records at an assumed 100 KB each, about 260,000 records/s average and 600,000/s peak. Payment notifications: 1,000/s peak. All provisional, to be replaced by measurements before production. | A load test at the design profile, sustained for at least one hour, with every latency and timeliness target met throughout. |
| X2-N3 | **Latency per operation.** | Single-link booking: p99 ≤ 200 ms to an answer, final or pending; a final answer when no capacity is in flight on the link. Route booking: p99 ≤ 200 ms (`ack_budget`, POL-04) to acknowledgement; final outcome by the request's deadline (POL-26). Top-up to credited balance: p99 ≤ 10 s from the provider's notification. Suspension decision to enforcement: ≤ 60 s, of which `standing_notice_time` (10 s) to deliver the standing change to network operations and the rest network operations' enforcement. Charge timeliness: a minute's reservation charge posted within 2 min of the minute's end, and usage-priced charges for records that arrive within `max_lateness` within `max_lateness` + 2 min, for at least 99.99% of a calendar month's minutes; every such charge posted within its target plus the 5-minute RTO of rating and posting (7 min, or `max_lateness` + 7 min) (POL-06). Probe limits for availability: as in X2-N1. | Measured at the system boundary under the design load, from the request's arrival to the response (or, for top-ups, enforcement and charges, from the triggering event or the minute's end to the observable effect: the credited headroom, the standing delivered, the block at the edge, the charge posted to the ledger). |
| X2-N4 | **No loss of recorded facts.** | RPO 0 for confirmed reservations, ledger movements, payment events and accepted usage records on loss of a node, a zone or a region; a fact is acknowledged only once it is durable in two regions. | A failure-injection test per failure scope: anything acknowledged before the failure is present after recovery. |
| X2-N5 | **Recovery time (RTO).** | On loss of a node or zone, the loss is transparent: admission and usage ingestion answer correctly again within 1 min; rating and posting, and the wallet, within 5 min ("billing" is split into ingestion and rating and posting); payouts within 15 min; reporting and statements within 30 min. The payouts and reporting RTOs lie within their 99.9% monthly availability budget (about 43 min). On loss of a region (a declared disaster): 1 h for every capability. | A failure-injection test, from the failure to the capability answering correctly again. |
| X2-N6 | **Retention.** | Ledger, payment events, reservation history and raw usage kept and retrievable for 7 years. | Retrieval of records at the edge of the retention period. |

## Constraints and assumptions

| Item | Status |
|---|---|
| All targets above. | *Decided* (POL-06) |
| 45 TB of traffic a day today; ×50 for the rebuild. | *Confirmed* (Share's claim; job listing) |
| 500 admission requests/s today. | *Assumed* (the basis of POL-06's 25,000/s) |
| 100 KB of traffic per flow record, 1,000 payment notifications/s peak, the admission mix. | *Decided* as provisional (POL-06), to be replaced by measurement |
| Seven-year retention needs legal confirmation per market. | *Decided* (POL-06, POL-24), pending legal confirmation |

## Out of scope

- How the targets are met (regions, replication, partitioning): the RFCs.
- Provisioning latency on the network (Problem 5 in the company profile).

## Open questions

Answered by POL-06 and removed: the failure scope for RPO and RTO; charge
timeliness; per-region scope; regional loss of acknowledged money; how RTOs fit the
availability budget (node and zone loss transparent, region loss a declared
disaster); provisional record and notification load and the admission mix; the
definition of an available minute and the split of the enforcement target; the
operation and per-probe limit of each capability, and how billing recovery and charge
timeliness fit together.

1. **Measured load.** The flow-record size, notification rate and admission mix are
   provisional (POL-06). They are to be measured from exporters and providers before
   production, and the targets re-run.
2. **Webhook load.** No target is set for buyer webhooks sent per second.
