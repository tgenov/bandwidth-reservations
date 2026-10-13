# Bandwidth reservations

Read these before you change anything:

- `docs/process/STATUS.md`: where the work stands and what is next.
- `docs/process/pipeline.md`: the design pipeline. The design is the authority; code conforms.
- `docs/process/engineering.md`: the engineering standard for code and tests. **Follow it
  for every change in `platform/` and `slices/`.**
- `docs/04-delivery/contracts/`: the frozen contracts C01 … C13. Slices meet only through them.
- `docs/04-delivery/plan/`: the delivery plan for each slice and the build order.

Rules that are easy to miss:

- Test first. A scenario test name starts with its scenario ID (for example `P1-S05 …`).
  A contract test name starts with its contract test ID (for example `C01 CP-2a …`).
- A slice never imports another slice's `src/`. Use a double that follows the frozen contract.
- Integration tests always close their resources and have a timeout.
- Run tests through the npm scripts (`npm run check`, `npm run test:<slice>`), not the runner directly.
- Measure progress with `python3 tools/conformance.py`.
