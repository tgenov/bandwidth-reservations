# Design documents

The design work in this repo, organised by phase. Each phase builds on the previous one:
a problem statement says what hurts and for whom and what is needed, a spec says what the
system must do, an RFC proposes a design that satisfies the spec, and the delivery plan
breaks the designs into deliverable pieces with explicit contracts between them.

**The requirements (phases 1 and 2) are authoritative.** They describe the need, not any
existing prototype. The RFCs are rewritten to satisfy them, and the code is then changed
to conform. Whether it does is recorded in the [conformance matrix](02-specs/conformance.md),
never in the requirements.

The requirements come from a mock interview and from public information about Share
(see [the company profile](01-discovery/company-profile.md)). They are assumptions about a
bandwidth marketplace, not confirmed facts about any real system. Business decisions the
requirements depend on are in the [policy register](02-specs/policy-register.md), decided
provisionally and pending ratification by the business.

| Phase | Folder | Format |
|---|---|---|
| 1. Discovery | [`01-discovery/`](01-discovery/) | Problem statements, each with a table of needs |
| 2. Specification | [`02-specs/`](02-specs/) | Gherkin `.feature` files, plus the [policy register](02-specs/policy-register.md), the [glossary](02-specs/glossary.md) and the [conformance matrix](02-specs/conformance.md) |
| 3. Design | [`03-rfcs/`](03-rfcs/) | RFCs using NABC (Need, Approach, Benefits, Competition) |
| 4. Delivery | [`04-delivery/`](04-delivery/) | Decomposition, interfaces and contracts between systems |

The original, chronological record of how earlier decisions were reached is kept in
[`history/decision-log.md`](history/decision-log.md). The requirements do not depend on it.

## The problems

| ID | Problem | Statement | Spec | RFC (pending revision) |
|---|---|---|---|---|
| P1 | Selling capacity on one link without overselling | [P1](01-discovery/P1-link-admission.md) | [P1](02-specs/P1-link-admission.feature) | [RFC-001](03-rfcs/RFC-001-link-admission.md) |
| P2 | Booking, changing and ending route reservations, all or nothing | [P2](01-discovery/P2-route-reservation.md) | [P2](02-specs/P2-route-reservation.feature) | [RFC-002](03-rfcs/RFC-002-route-reservation.md) |
| P3 | Rating reservations and metered traffic | [P3](01-discovery/P3-rating-and-metering.md) | [P3](02-specs/P3-rating-and-metering.feature) | [RFC-003](03-rfcs/RFC-003-usage-metering.md) |
| P4 | Wallet, funds holds, ledger and supplier settlement | [P4](01-discovery/P4-wallet-and-settlement.md) | [P4](02-specs/P4-wallet-and-settlement.feature) | [RFC-004](03-rfcs/RFC-004-wallet-and-settlement.md) |
| X1 | Security, tenancy and audit (cross-cutting) | [X1](01-discovery/X1-security-and-tenancy.md) | [X1](02-specs/X1-security-and-tenancy.feature) | none yet |
| X2 | Non-functional targets (cross-cutting) | [X2](01-discovery/X2-non-functional-targets.md) | [X2](02-specs/X2-non-functional.feature) | none yet |

The RFCs and the delivery documents ([plan](04-delivery/plan.md) ·
[contracts](04-delivery/contracts.md)) predate this requirements baseline and are **pending
revision** against it. Where they disagree with the requirements, the requirements win.

X1 and X2 are cross-cutting requirement sets that P1–P4 inherit. They are numbered apart
from P1–P4 because the company profile's ranked list already uses "Problem 5" and
"Problem 6" for provisioning and SLA enforcement, and the policy register cites Problem 6.

## Conventions

**Problem statements** (`01-discovery/Pn-*.md`, `Xn-*.md`). Sections in this order:
Context · Who is affected · The problem · Needs · Constraints and assumptions · Out of
scope · Open questions. No solutions. *The problem* describes what makes it hard. *Needs*
is a table of need IDs (`P1-N3`), each with the success measure that shows it is met.
Each constraint is marked:

- *Confirmed*: stated in a primary source, meaning the job listing or the business
  statement made in the mock interview. The company profile is a secondary source;
  something it reports from Share's website is marked with that provenance.
- *Decided*: set in the policy register, with the `POL-nn`.
- *Assumed*: taken as given for the design, without a source.
- *Inferred*: reasoned from other items.

Open questions list only what is genuinely open. A question answered by a policy is removed
and the policy cited.

**Specs** (`02-specs/*.feature`). One Gherkin `Feature` per file, opening with user
stories (`As a … I want … So that …`) for each stakeholder it serves, grouped into `Rule`s.
Steps are declarative and observable by a buyer, supplier, operator or finance: no internal
states, data structures, table or topic names, HTTP paths, algorithms or error strings. One
behaviour per scenario. Backgrounds are per `Rule` and apply to every scenario in it.
Where behaviour depends on a policy, the step names the parameter and the policy
(``within `ack_budget` (POL-04)``) instead of hard-coding its value; concrete values appear
only in examples, where they are the POL default unless the file says otherwise.

**Tags.** Every scenario carries:

- its stable ID, `@P1-S01` (or `@X1-S01`), unique across all specs and never reused;
- one or more `@need-P1-N3` tags naming the need it serves (**the traceability
  convention**);
- an `@POL-nn` tag for each policy it depends on.

No other tags. Verification status, test names and defect notes are **never** put in a
`.feature` file.

**Traceability** runs both ways and is checked mechanically: every `@need-` tag must name a
need in a problem statement's Needs table, and every need must be cited by at least one
scenario. Since each need carries its success measure, every success measure has a
scenario too. The [conformance matrix](02-specs/conformance.md) carries the third link,
scenario → design → test.

**Policy register** ([`02-specs/policy-register.md`](02-specs/policy-register.md)). Each
business choice the system must support, with its named parameters and default values.
Changing a policy or a parameter must not require a change of mechanism.

**Glossary** ([`02-specs/glossary.md`](02-specs/glossary.md)). Every term used in the
requirements, with the units and time notation. Terms are used only in the sense given
there. In particular, "reserved rate" (capacity) and "traffic" (bytes) are never called
"usage".

**Conformance matrix** ([`02-specs/conformance.md`](02-specs/conformance.md)). One row per
scenario: Scenario · Design (RFC section) · Tests · Status. It is filled in at the
conformance stage, after design. It also maps the previous baseline's scenario IDs to the
current ones.

**RFCs** (`03-rfcs/RFC-00n-*.md`). Header table (Status, Satisfies, Decisions), then
**Need** · **Approach** (the design, with the detail needed to build it) ·
**Benefits** (quantified where measured) · **Competition** (alternatives considered and
why they lost) · Risks and open issues. "Satisfies" lists the spec scenario IDs.
"Decisions" lists the policies (`POL-nn`) the RFC depends on. Design-level acceptance
tests (for example the mechanics of capacity holds or of a split method) belong to the RFC
that chose the mechanism, each citing the scenario it serves.

**Delivery** (`04-delivery/`). The plan decomposes the RFCs into components and increments,
each tied to the scenarios it delivers. `contracts.md` defines every interface between
components: endpoints, message schemas and topics, shared tables, and in-process
interfaces, with ownership, delivery semantics and idempotency for each. Wire formats
(number syntax, field names, status codes) belong there, not in the specs.
