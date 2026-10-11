# Company profile: Share (share.inc)

Background for the problems this repo works on. Compiled 2026-10-10 from public job listings,
Share's website and trade press. Items marked **Inferred** are interpretation, not stated
fact. The website figures are Share's own claims and have not been verified independently.

## Company

| | |
|---|---|
| Name | Share. Website [share.inc](https://www.share.inc/); LinkedIn page: shareinternet |
| Positioning | "Carrier-neutral, open-access network and bandwidth marketplace" |
| Founded | 2024 |
| Size | 11–50 people |
| Founder | Luis Munoz Aycart |
| Structure | Headquartered in New York City, with a US parent company and an operating company in Kenya |
| Funding | "Venture-backed"; no amount found |

Sources: [Remote Rocketship company page](https://www.remoterocketship.com/company/share-inc/),
[Wellfound: Network Developer](https://wellfound.com/jobs/4779456-network-developer).

## Network footprint (claimed on the website)

- **Live:** Nairobi, Mombasa.
- **Next:** Johannesburg, Marseille, Kampala, Djibouti, Kigali.
- **Later:** Barcelona, Lagos, Virginia, Kinshasa, Maputo.
- **Scale:** 12,000+ km of fibre, 16 infrastructure providers, 10 data centres, 7 subsea cables,
  45 TB of traffic a day, and more than 10 million people covered.
- **Partners and exchanges named:** providers iColo and WorkOnline; peering at the KIXP and LINX
  internet exchanges.

## Product

- **For buyers:** no commits and no upfront payment; a wallet that tracks usage; standardised
  pricing; SLA-backed service. The API sells "the path, the performance, how long they need it",
  paid per use.
- **For suppliers:** central billing, automated payouts, onboarding APIs. No public API
  documentation was found.
- **Products:** IP transit, CDN traffic, metro and long-haul fibre, colocation, local peering.
- **Customers named in the spec:** builders, AI agents and enterprises.

## Engineering signals from job listings

| Role | Signals |
|---|---|
| Founding Engineer (this spec, `share.txt`) | Platform architecture for a system roughly 50× the previous scale. TypeScript/NestJS, PostgreSQL, Kafka or RabbitMQ. AI-augmented workflow. |
| Founding Engineer (earlier listing, UK remote, 28 July) | Owns payments: collections, revenue splitting, treasury. Also the billing engine (subscription lifecycle, renewals) and partner business/operations system sync. Asks for M-Pesa, Stripe or Adyen, webhooks, idempotency, reconciliation. Same stack. ([listing](https://www.remoterocketship.com/company/share-inc/jobs/founding-engineer-united-kingdom-remote/)) |
| Network Developer | BGP, RPKI, Segment Routing, MPLS. White-box Edgecore switches running IP Infusion OcNOS. Nautobot as the network's source of truth. Config templates, gNMI telemetry, sFlow. |
| Platform Engineer | Multi-region Kubernetes on Google Cloud, plus VMs in their own data centres. 99.99% availability target. "Trading depends on low latency." ([listing](https://wellfound.com/jobs/4718968-platform-engineer)) |
| Senior Systems Engineer | FreeRADIUS, provisioning, BNG integration (retail ISP subscriber management). |

**Inferred:**
- The current spec is probably a newer version of the July listing, shifting the focus from
  payments to platform architecture.
- The "50×" rebuild most likely means expanding from one Kenyan market to several countries and
  continents.

## Domain history: why bandwidth exchanges failed around 2000

Enron Bandwidth Exchange, Band-X and RateXchange all collapsed. Contributing causes:

- too few buyers;
- no standard contract: two rival master agreements arose because the sides couldn't agree on
  damages for failing to deliver;
- too few points where networks physically connect;
- oversupply, which made prices predictable and left no reason to hedge;
- counterparties with poor credit;
- **most of all, selling capacity that couldn't be physically delivered.**

Platforms that later succeeded own the physical delivery network and sell provisioned
connections through an API, not traded contracts: Megaport, PacketFabric, Console Connect
(Epsilon) and Equinix Fabric. Share follows this model, with its own PoPs and switches, standard
SLAs, and settlement through the wallet.

Sources: [Capacity: The fall and rise of bandwidth trading](https://capacityglobal.com/news/the-fall-and-rise-of-bandwidth-trading/),
[Capacity: Trading places](https://www.capacitymedia.com/article/29ot47zfua7b7uos7rm68/feature/trading-places),
[BRIE working paper 152](https://brie.berkeley.edu/sites/default/files/wp152.pdf).

**Implication:** never overselling and measuring whether the SLA was actually delivered are core
to Share's business, not just engineering details.

## Likely technical problems for the rebuild (ranked)

| # | Problem | Evidence | Why it's hard | Requirements in this repo |
|---|---|---|---|---|
| 1 | Capacity admission without overselling | Spec: path, performance, duration; "trading depends on low latency" | Partial capacity that changes over time; hot routes; tight latency | [P1](P1-link-admission.md) |
| 2 | Reserving a whole path across several providers' links, all or nothing | Spec: "the path, the performance" | Routing under latency and bandwidth limits; atomic reservation across links owned by different providers | [P2](P2-route-reservation.md) |
| 3 | Usage metering and pay-per-use billing | No commits, wallet; 45 TB/day today, ×50 | sFlow/gNMI telemetry arrives late, duplicated or out of order, but bills must be exact and reproducible | [P3](P3-rating-and-metering.md), re-scoped by POL-01: reservations are priced per Mbps-minute; metering bills best-effort traffic and burst and supplies SLA evidence |
| 4 | Payments, revenue splitting, reconciliation | Earlier listing | Asynchronous M-Pesa webhooks that can repeat; double-entry ledger; several currencies; idempotency | [P4](P4-wallet-and-settlement.md), with funds holds (POL-15) and payouts (POL-22); treasury out of scope |
| 5 | Provisioning as a long-running workflow | Nautobot, OcNOS, partner APIs | Steps fail partway; compensation; keeping what was sold consistent with what's configured | Later |
| 6 | SLA enforcement | SLA-backed service; failure to deliver killed the 2000-era exchanges | Measuring delivered performance per service; automatic credits | Later (builds on #3); P3 keeps the evidence |
| 7 | Supplier integration layer | Partner business/operations system sync | Different APIs and reliability per partner; outbox/inbox; retries | Fold into #4 |
| 8 | AI agents as API clients | Spec: "AI agents" as buyers | Many fast, repetitive calls: idempotency keys, quotes that expire, spending limits | Limits in [P2](P2-route-reservation.md) and [P4](P4-wallet-and-settlement.md) (POL-25); key scoping in [X1](X1-security-and-tenancy.md); quotes out of scope |
