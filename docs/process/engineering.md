# Engineering standard: code and tests

This standard applies to all code in `platform/` and `slices/`. It adapts the practices of
a mature product repository to this repository's stack: TypeScript on Node.js (ESM,
`node --test`), CockroachDB, Kafka and frozen contracts. The design documents are the
authority. Code conforms to them (see [pipeline.md](pipeline.md)).

## 1. Test first

1. Write a failing test first. Then write the code that makes it pass. Then refactor.
   Code without a test is not finished.
2. For a bug, first write a test that shows the bug. Then fix the bug.
3. A test describes a behaviour that a scenario, a contract or an RFC states. Do not write
   tests to describe code that already exists.
4. An agent can write the code for a failing test that a person or the orchestrator wrote.
   An agent must not weaken a test, delete a test, or add a skip to make a suite pass.

## 2. Test levels

| Level | What it proves | Substrate | Where | Script |
|---|---|---|---|---|
| Unit | One module's behaviour, including every error path | In-memory store, runtime double, injected clock. No network, no database | `<pkg>/test/*.test.ts` | `test:<slice>` |
| Property | An invariant over thousands of random inputs, against a simple oracle | As for unit, with a seeded generator | `<pkg>/test/*property*.test.ts` | `test:<slice>` |
| Contract | One side of a frozen contract: provider tests (for example C01 CP-n, C06 CT-L-n) and consumer tests (CC-n, CT-C-n) | Unit substrate. The other side is a contract double | `<pkg>/test/*contract*.test.ts` or named by test ID | `test:<slice>` |
| Integration | The code on the real substrate: CockroachDB, Kafka, changefeeds | The dev cell (`npm run dev:up`) | `<pkg>/test/integration/*.test.ts` | `test:<slice>:integration` |
| End to end | A whole journey across slices (for example book → hold → convert → rate → post) | The dev cell with every owner kind | `e2e/` (when slices meet) | `test:e2e` |

Rules:

- **Test each behaviour once, at the level that owns it.** A booking API test checks the
  request, the answer and the reason code. It does not test admission again. Admission is
  tested in the account owner's tests.
- **Every invariant that protects money or capacity has a property test.** Examples:
  never oversell (P1-N1), every movement sums to zero, a resend never charges twice. A
  property test fails at once if the invariant is broken on purpose. Show this once, when
  you write the test.
- **Every frozen contract that a package provides or uses has its listed contract tests.**
  Run a provider's tests against the real provider. Run a consumer's tests against a
  double that follows the contract, never against another slice's code.
- **End-to-end tests are few.** Use them only for the critical journeys.

## 3. What to replace with a double, and what not to

| Replace with a double | Never replace |
|---|---|
| Another slice (use a double that follows the frozen contract) | The code under test |
| The owner runtime in unit tests (`@share/owner-runtime/testing`) | The owner runtime in integration tests |
| Time (inject a clock; see §5) | The database in integration tests |
| Randomness (use a seeded generator) | Kafka in integration tests |
| External parties: partners, payment providers, exporters | |

- A double is a plain object or class that the test gives to the code under test. Do not
  patch modules, do not spy on imports, and do not mock the transport.
- A method of a double that the test does not set up must throw, with a clear message.
- A slice never imports another slice's `src/`. A slice imports only the platform
  packages and its own packages.

## 4. Assertions

- Assert exact values: reason codes, `AppendResult` kinds, integer amounts in micro-USD,
  and sequence numbers. Do not check a substring of an error message.
- When a behaviour must NOT happen, assert it explicitly. For example: no append, no
  published event, no second charge line, and the funds hold unchanged.
- Every error return and every refusal code in the code has a test.
- **Mutation question.** For each test, ask: "If the code broke, would this test fail?"
  Examples of a break are a flipped condition, a removed guard, an off-by-one in a minute
  boundary, or a wrong rounding direction. If the answer is no, make the test stronger.
  When the suite is large enough, run Stryker on the money and capacity modules.

## 5. Time, randomness and concurrency

- Code never reads the wall clock directly. It uses the runtime's `now`/`timing`, or a
  clock that the caller injects. Tests use a fixed or a stepped clock.
- Random tests use a seeded generator. A failing seed is printed in the failure message,
  so the failure can be run again.
- Never use `setTimeout` or a sleep to wait for something to happen in a test. Wait for an
  event, a promise or a condition, with a timeout.
- Concurrency tests start all clients together (a barrier), then check the result against
  the oracle in decision order.

## 6. Integration tests

- Every integration test has a timeout. The npm script uses `--test-timeout` and
  `--test-force-exit`. A hang must fail fast.
- Every test closes all its runtimes, pools and Kafka clients in `afterEach`, also when the
  test fails. A runtime that stays open keeps renewing its session. This blocks the next
  tests and keeps the process alive.
- Each test run uses its own database (a unique name: prefix and time). The test creates
  it, migrates it, and drops it at the end. Old databases with the prefix that are more
  than 1 hour old are dropped at start.
- On a laptop, an integration test skips with a clear message when the dev cell is not
  reachable. In CI, `REQUIRE_DEV_CELL=1` makes an unreachable dev cell a failure, so a run
  that tested nothing cannot pass.
- To run one test, give its exact name (`--test-name-pattern '^<name>$'`).

## 7. Names and structure

- A test that proves a scenario starts with the scenario ID:
  `P1-S05 a booking is confirmed only if it fits beside every hold`.
  `tools/conformance.py` counts these names, so the ID must be exact.
- A test that proves a contract test starts with the contract test ID:
  `C01 CP-2a Ambiguous, committed: …`, `C06 CT-L4 …`.
- Other tests use `should <behaviour> when <condition>`, in lower case.
- Test files are `*.test.ts` in `test/` beside `src/`. Shared test helpers are in
  `test/support.ts` or in the package's `testing/` export.
- Build test data with small builder functions in the test file, with fixed IDs. Do not
  depend on data that the test cannot see ("mystery guest").
- Do not write comments that tell the story of a test. Make the test name clear instead.

## 8. Coverage and quality gates

- There is no global coverage percentage. Each module's important logic and every error
  path must be tested.
- The scenario gate is `tools/conformance.py`. A scenario is `met` only when a test with
  its ID passes in its owning slice.
- A failing test is fixed at once. Do not skip it, do not mark it as known, and do not
  merge with it. A flaky test is a bug and is fixed the same day.
- Before a commit, run `npm run check`: type checks and unit tests for every package. Run
  the integration tests before a merge to `integration`.

## 9. Code

- TypeScript `strict`, with `noUncheckedIndexedAccess` and `noImplicitOverride`. No `any`.
  Narrow `unknown` with a type guard, not with a cast.
- Model results and refusals as discriminated unions (for example `AppendResult`). Map
  them to transport codes in one place for each contract, not in each handler.
- Money is an integer number of micro-USD (`bigint` where the total can exceed 2^53).
  Never use floating point for money.
- Every exported function, type and class has a short doc comment. Inside a function,
  write a comment only where a contract or RFC rule is not obvious, and cite the section
  (`C01 §3.4`). Do not leave a TODO in finished code, except one that names the increment
  that will do the work (`TODO(S-PLAT-I3): moves`).
- Keep each change small. Every changed line must come from the task. Do not add an
  abstraction that no current test needs.
- Do not turn off a type check or a lint rule to make code pass.
- Write comments and documents in ASD-STE100 Simplified Technical English.

## 10. Commits

- One topic per commit. A file and its test go in the same commit.
- All tests pass at every commit.
- The message starts with the area (`S-LINK I2:`, `platform:`), then a short summary. The
  body says what changed and why. Commits are signed.
