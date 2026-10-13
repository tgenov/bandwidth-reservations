#!/usr/bin/env bash
# Local CI (`npm run ci`). This repository has no hosted CI: run this before a merge to `integration`.
# Steps, fail fast: check, spec check, integration tests on the dev cell (REQUIRE_DEV_CELL=1), conformance.
# It starts the dev cell when it is not reachable, and leaves it running (stop it with `npm run dev:down`).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

done_steps=()
step() {
  local name="$1"; shift
  printf '\n== ci: %s\n' "$name"
  local t0=$SECONDS
  if ! "$@"; then
    printf '\nci: FAILED at "%s". Passed before it: %s\n' "$name" "${done_steps[*]:-none}" >&2
    exit 1
  fi
  done_steps+=("$name ($((SECONDS - t0))s)")
}

reachable() { (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null; }
dev_cell() {
  if reachable localhost 26257 && reachable localhost 9092; then echo "dev cell is up"; return 0; fi
  echo "dev cell not reachable: starting it (npm run dev:up)"
  npm run -s dev:up
}

step "npm run check" npm run -s check
step "check_specs" python3 tools/check_specs.py
step "dev cell" dev_cell
step "integration (REQUIRE_DEV_CELL=1)" env REQUIRE_DEV_CELL=1 npm run -s test:integration
step "conformance" python3 tools/conformance.py

printf '\nci: PASSED\n'
for s in "${done_steps[@]}"; do printf '  ok  %s\n' "$s"; done
