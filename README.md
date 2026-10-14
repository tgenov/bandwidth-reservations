# bandwidth-reservations

## Experiment hypothesis

Can one engineer, using an appropriately constrained agent harness, independently
specify, architect, implement and validate a complex distributed system without
becoming the bottleneck for local decisions?

This repository explores that question through a design and a partial build of a
bandwidth marketplace: customers reserve capacity on links that partners supply,
and the system meters usage, rates it and settles the money. The company model is
"Share".

## Evidence so far

- **A traceable design.** The [design documents](docs/README.md) connect discovery,
  executable requirements, architecture, slice RFCs, frozen contracts and delivery
  plans. The design is the authority against which the code is assessed.
- **A constrained decision process.** The [design pipeline](docs/process/pipeline.md)
  defines authority boundaries, review gates and escalation through recorded issues.
  Agents can make provisional local decisions within those constraints.
- **Implementation and validation artifacts.** The repository contains slice
  implementations, unit and contract tests, integration tests, and
  [adversarial reviews and fix verifications](docs/reviews/). The
  [conformance matrix](docs/02-specs/conformance.md) records scenario-level test
  evidence and gaps; `npm run progress` reports the current delivery state.

These artifacts provide evidence of the process and partial implementation. They
do not yet establish the full hypothesis, including whether one engineer can
remain outside the bottleneck for local decisions through complete delivery and
external validation.

## Limitations and remaining uncertainty

- **The business requirements are hypotheses.** They were derived from a mock
  interview and public materials, not confirmed by Share. Internal consistency is
  not proof of product correctness.
- **The implementation is partial.** The documented
  [conformance matrix](docs/02-specs/conformance.md) identifies uncovered scenarios,
  and the project does not have hosted CI. The complete suite was run locally once.
- **Independent agents are not independent evidence.** Adversarial review reduces
  anchoring, but multiple agents can still share the same misconceptions. External
  domain validation remains necessary.

## Artifact counts

```text
$ scc --exclude-dir .claude,node_modules   # scc 4.1.0, main at c186423, 2026-10-14
───────────────────────────────────────────────────────────────────────────────
Language            Files       Lines    Blanks  Comments       Code Complexity
───────────────────────────────────────────────────────────────────────────────
TypeScript            349      62,496     5,516     6,044     50,936     11,846
Markdown              146      58,158     7,038         0     51,120          0
JSON                   43       1,854         0         0      1,854          0
SQL                     7         378        47        55        276          0
Gherkin Specif…         6       4,673       751        70      3,852      1,105
Python                  6       1,451       119       140      1,192        502
JavaScript              2         220        18        20        182        101
Plain Text              2          49         0         0         49          0
YAML                    2         120         5        16         99          0
BASH                    1          52         3         6         43         18
Shell                   1          25         3         4         18          2
───────────────────────────────────────────────────────────────────────────────
Total                 565     129,476    13,500     6,355    109,621     13,574
───────────────────────────────────────────────────────────────────────────────
Estimated Cost to Develop (organic) $3,745,674
Estimated Schedule Effort (organic) 22.72 months
Estimated People Required (organic) 14.65
───────────────────────────────────────────────────────────────────────────────
Processed 10,555,913 bytes, 10.556 megabytes (SI)
───────────────────────────────────────────────────────────────────────────────
```

**What this table shows.** [scc](https://github.com/boyter/scc) counts the lines in the
repository, by language. "Code" is the lines that are not blank and not comments.
"Complexity" counts the branches and loops in the code, which is a rough measure of how much
logic it holds.

- **The code is about 51,000 lines of TypeScript.** About 55 % is production code (the platform
  runtime, the slices, the contracts and the tools) and about 45 % is tests.
- **The design is almost as large as the code.** The Markdown is about 51,000 lines: the
  requirements, the RFCs, the frozen contracts, the delivery plans and the reviews. This repository
  is design first: the design is the authority and the code conforms to it.
- **The requirements are executable specifications.** The Gherkin files hold the scenarios
  (about 3,900 lines). Each scenario test name starts with its scenario ID.
- **The rest is small.** Python is the design-pipeline tools and the overload model, SQL is the
  bench and database schemas, and JSON is mostly package and tool configuration.
- **The cost lines are a model, not a measurement.** scc uses the basic COCOMO model
  ("organic" mode) to estimate what a conventional team would need to write this many lines:
  about $3.7 M, 23 months and 15 people. COCOMO counts every code line, so the Markdown design
  documents count as code. It does not show the real time or cost of this repository.

The first line of the table records the command, the scc version and the commit. It excludes `node_modules` and the agent
worktrees in `.claude/`. The numbers change as the code changes: run the command again to
update them.

## Architecture

- **Substrate.** CockroachDB holds the facts. Kafka carries the feeds, and
  each owner writes to Kafka through an outbox.
- **Owners.** Each partition of state has one writer, the owner. An owner holds
  a lease, and an epoch fences each write against a stale owner.
- **Slices.** Each slice delivers one part of the system. A slice never imports
  the source of a different slice. Slices meet only through the frozen
  contracts C01 … C13.

| Slice | RFC | What it does | Code |
|---|---|---|---|
| S-PLAT | RFC-006 | Platform: substrate, owner leases, clocks, failover, probes, backups | `platform/runtime`, `platform/migrate`, `platform/examples/canary` |
| S-LINK | RFC-001 | Link schedule owner: link registry, holds, outages and reductions, offers | `slices/link` |
| S-ACCT | RFC-002 | Account owner (booking), decision point, partner adapters, status reads | `slices/account/owner`, `slices/account/booking-api` |
| S-RATE | RFC-003 | Metering ingestion, attribution, quarantine, rating, catalogue | `slices/rate/*` |
| S-MONEY | RFC-004 | Funds and standing; ledger, payments, payouts, reconciliation | `slices/account/money` |
| S-SEC | RFC-005 | Identity and access, tenancy, audit, personal-data store, encryption | `slices/sec/*` |

| Path | Contents |
|---|---|
| `docs/01-discovery` | Problem statements P1–P4, X1, X2 |
| `docs/02-specs` | Gherkin specs, policy register, glossary, conformance matrix |
| `docs/03-rfcs` | RFC-000 (architecture) and RFC-001 … RFC-006 (slices) |
| `docs/04-delivery` | Frozen contracts, delivery plans, technology evaluations |
| `docs/process` | Status, the design pipeline, the engineering standard |
| `contracts/suites` | Contract test suites (`@share/contract-suites`) |
| `platform/dev` | The dev cell (Docker Compose) |
| `tools/` | Checks and reports (Python) |

For the current state of the work, run `npm run progress`. It shows the
delivered increments for each slice, the increments that are ready, the
critical path, and the scenarios that have a passing test.

## Run

### Prerequisites

- Node 24 or later (see `.nvmrc`). Node runs the TypeScript directly through
  type stripping. There is no build step.
- Python 3, for the scripts in `tools/`.
- Docker, only for the integration tests.

### Install

    npm install          # all workspaces; also sets core.hooksPath to .githooks

The pre-commit hook runs the boundary check, the linter, and the type checks
and tests of each staged workspace.

### Unit and contract tests (no Docker)

    npm run test:<slice>        # platform, link, sec, account, rate
    npm run typecheck:<slice>
    npm run test:contracts      # all contract suites

    npm run check               # boundaries, lint, all type checks, unit and contract tests
    npm run ci                  # check, spec check, conformance (local; no hosted CI)

### Integration tests (dev cell)

The dev cell has a 3-node CockroachDB cluster (v24.3.5, insecure) and one
Kafka broker (3.9.0, KRaft).

    npm run dev:up              # start the dev cell and wait until it is healthy
    npm run test:integration    # each test makes its own database
    npm run dev:down            # stop the dev cell and delete its volumes

| Service | Host port |
|---|---|
| CockroachDB node 1 (SQL, UI) | 26257, 8080 |
| CockroachDB nodes 2, 3 | 26258, 26259 |
| Kafka | 9092 |

The tests use the values below if the environment does not set them:

| Variable | Default |
|---|---|
| `DATABASE_URL` | `postgresql://root@localhost:26257/defaultdb?sslmode=disable` |
| `DATABASE_URL_2` | the same URL on port 26258 |
| `KAFKA_BROKERS` | `localhost:9092` |

If the dev cell is not available, the integration tests skip. Set
`REQUIRE_DEV_CELL=1` to make them fail.

### Other commands

| Command | What it does |
|---|---|
| `npm run progress` | Delivery plan progress and conformance |
| `npm run specs` | Requirements check |
| `npm run check:boundaries` | No slice imports a different slice |
| `npm run measure` | Wall-clock measurements (machine-dependent) |
| `npm run bench:bus` | Kafka client bench on the dev cell |
| `npm run mutation:<link\|rate\|account\|money>` | Mutation testing (slow) |

`CLAUDE.md` has the full list.

## Prototype (prior art)

The first prototype is in `src/`, `test/` and `billing/`, with its own
`docker-compose.yml`, `schema.sql` and `schema-routes.sql` at the root. It is a
single-link admission algorithm (a segment tree, then Postgres with one lock
for each link), a route saga across providers, and a NestJS billing service.
RFC-000 uses its measurements to explain why the architecture is different. No
current check uses the prototype, and the delivery plans retire or replace it.

To run it:

    docker compose up -d --wait   # postgres:17 on 55432, redpanda on 59092
    npm test                      # src/ and test/
    docker compose exec postgres psql -U postgres -c 'CREATE DATABASE billing'
    cd billing && npm install && npm test
