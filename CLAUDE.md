# Bandwidth reservations

Read these before you change anything:

- `docs/process/STATUS.md`: where the work stands and what is next.
- `docs/process/pipeline.md`: the design pipeline. The design is the authority; code conforms.
- `docs/process/engineering.md`: the engineering standard for code and tests. **Follow it
  for every change in `platform/` and `slices/`.**
- `docs/04-delivery/contracts/`: the frozen contracts C01 … C13. Slices meet only through them.
- `docs/04-delivery/plan/`: the delivery plan for each slice and the build order.
- `docs/bugtraq/`: defects in third-party code, with their workarounds and removal conditions.
- `docs/04-delivery/evaluations/`: technology evaluations and decisions (E-001: Kafka client).

Rules that are easy to miss:

- Test first. A scenario test name starts with its scenario ID (for example `P1-S05 …`).
  A contract test name starts with its contract test ID (for example `C01 CP-2a …`).
- A slice never imports another slice's `src/`. Use a double that follows the frozen contract.
- Integration tests always close their resources and have a timeout.
- Run tests through the npm scripts (`npm run check`, `npm run test:<slice>`), not the runner directly.

## Commands

| Command | What it does |
|---|---|
| `npm run check` | Boundaries, lint, all type checks, all unit tests, all contract suites. Run before every commit (the pre-commit hook runs it for the staged workspaces). |
| `npm run ci` | The local CI: `check`, spec check, dev cell up if needed, integration tests with `REQUIRE_DEV_CELL=1`, conformance. No hosted CI. |
| `npm run test:<slice>` / `typecheck:<slice>` | One slice: `platform`, `link`, `sec`, `account`, `rate`, `contracts`. |
| `npm run test:integration` | Integration tests on the dev cell (`npm run dev:up` / `dev:down`). |
| `npm run measure` | Wall-clock measurements (opt-in, machine-dependent). |
| `npm run bench:bus` | FeedBus client bench on the dev cell (E-001 §10). `BUS_CLIENT=platformatic\|kafkajs`, `BUS_MODE=idle` for idle CPU. |
| `npm run mutation:<link\|rate\|account>` | Stryker mutation testing on the money and capacity modules (slow). |
| `npm run lint` / `lint:fix` | ESLint. |
| `npm run specs` / `specs:regen` | Requirements check (`check_specs.py`); `regen` regenerates `conformance.md` rows. |
| `npm run coverage` | Each slice RFC cites all its scenarios (`impact.py coverage`). |
| `npm run impact -- diff <tagA> <tagB>` | Which scenarios, policies and slices changed between two requirements tags. |
| `npm run conformance` / `conformance:write` | Scenarios with a passing named test, per slice; `write` updates `conformance.md`. |
| `npm run plan` / `plan:write` | Delivery plan progress: done per slice, ready increments, waves left, critical path; `write` regenerates `docs/04-delivery/plan/graph.md`. Mark delivered increments in `docs/04-delivery/plan/done.txt`. |
| `npm run progress` / `progress:write` | `plan` and `conformance` together (the progress report); `write` updates both documents. |
| `npm run check:boundaries` | No slice imports another slice; contracts import only the platform. |
