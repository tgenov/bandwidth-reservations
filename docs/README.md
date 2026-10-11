# Design documents

The design work in this repo, organised by phase. Each phase builds on the previous one:
a problem statement says what hurts and for whom, a spec says what the system must do, an
RFC proposes a design that satisfies the spec, and the delivery plan breaks the designs
into deliverable pieces with explicit contracts between them.

The requirements come from a mock interview and from public information about Share
(see [the company profile](01-discovery/company-profile.md)). They are assumptions about a
bandwidth marketplace, not confirmed facts about any real system.

| Phase | Folder | Format |
|---|---|---|
| 1. Discovery | [`01-discovery/`](01-discovery/) | Problem statements |
| 2. Specification | [`02-specs/`](02-specs/) | Gherkin `.feature` files: user stories, scenarios, system behaviour |
| 3. Design | [`03-rfcs/`](03-rfcs/) | RFCs using NABC (Need, Approach, Benefits, Competition) |
| 4. Delivery | [`04-delivery/`](04-delivery/) | Decomposition, interfaces and contracts between systems |

The original, chronological record of how each decision was reached is kept in
[`history/decision-log.md`](history/decision-log.md). The documents above cite its
entries (D1–D30) as provenance; they do not depend on it.

## The problems

| ID | Problem | Statement | Spec | RFC |
|---|---|---|---|---|
| P1 | Capacity admission on one link without overselling | [P1](01-discovery/P1-link-admission.md) | [P1](02-specs/P1-link-admission.feature) | [RFC-001](03-rfcs/RFC-001-link-admission.md) |
| P2 | Reserving a route across several providers' links, all or nothing | [P2](01-discovery/P2-route-reservation.md) | [P2](02-specs/P2-route-reservation.feature) | [RFC-002](03-rfcs/RFC-002-route-reservation.md) |
| P3 | Metering and rating pay-per-use traffic | [P3](01-discovery/P3-usage-metering.md) | [P3](02-specs/P3-usage-metering.feature) | [RFC-003](03-rfcs/RFC-003-usage-metering.md) |
| P4 | Wallet, ledger and supplier revenue split | [P4](01-discovery/P4-wallet-and-settlement.md) | [P4](02-specs/P4-wallet-and-settlement.feature) | [RFC-004](03-rfcs/RFC-004-wallet-and-settlement.md) |

Delivery: [plan and decomposition](04-delivery/plan.md) · [interfaces and contracts](04-delivery/contracts.md)

## Conventions

**Problem statements** (`01-discovery/Pn-*.md`) — sections in this order:
Context · Who is affected · The problem · Constraints and assumptions (each marked
*Assumed*, *Confirmed* or *Inferred*) · Success measures · Out of scope · Open questions.
No solutions.

**Specs** (`02-specs/Pn-*.feature`) — one Gherkin file per problem. Each `Feature` opens
with a user story (`As a … I want … so that …`). Scenarios have stable IDs as tags
(`@P1-S01`). Every scenario is also tagged with how it is verified:
`@verified` plus a `# Verified by: <test file> › "<test name>"` comment, or
`@unverified` when no test exercises it yet. A test inside a `describe` block is named
as `"<describe> › <test>"`, the way the test runner reports it; a parameterised test is
named by its template (`seed %i: …`) or by each rendered name. Each file holds exactly
one `Feature` (Gherkin allows only one), optionally grouped into `Rule`s. Specs describe
observable behaviour, not implementation.

**RFCs** (`03-rfcs/RFC-00n-*.md`) — header table (Status, Satisfies, Decisions), then
**Need** · **Approach** (the design, with the detail needed to build it) ·
**Benefits** (quantified where measured) · **Competition** (alternatives considered and
why they lost) · Risks and open issues. "Satisfies" lists the spec scenario IDs.
"Decisions" lists the decision-log entries the RFC draws on.

**Delivery** (`04-delivery/`) — the plan decomposes the RFCs into components and
increments, each tied to the scenarios it delivers; `contracts.md` defines every
interface between components: HTTP endpoints, Kafka topics and message schemas,
database tables that cross a component boundary, and the in-process interfaces between
modules, with ownership, delivery semantics and idempotency for each.
