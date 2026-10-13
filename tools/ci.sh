#!/usr/bin/env bash
# Local CI (`npm run ci`). This repository has no hosted CI: run this before a merge to `integration`.
# Steps, fail fast: check, spec check, conformance. It does not start the dev cell and does not run integration
# tests: local testing is contract and double based only. Run integration tests by hand (`npm run test:integration`).
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

step "npm run check" npm run -s check
step "check_specs" python3 tools/check_specs.py
step "conformance" python3 tools/conformance.py

printf '\nci: PASSED\n'
for s in "${done_steps[@]}"; do printf '  ok  %s\n' "$s"; done
