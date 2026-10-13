# bandwidth-reservations

A design and a partial build of a bandwidth marketplace: customers reserve
capacity on links that partners supply, and the system meters usage, rates it
and settles the money. The company model is "Share". The requirements come from
a mock interview and public information. They are assumptions, not facts about
a real system.

The design is the authority, and the code conforms to it. The design documents
are in [`docs/`](docs/README.md).

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
