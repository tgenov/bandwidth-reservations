# Pipeline status (resume point)

Checkpoint updated 2026-10-12 (C3 round 2, step 4). Read this, `pipeline.md` and `slices.json`, then follow
**Next steps**. Use the `design-pipeline` skill and the agents in `.claude/agents/`.

## Where things stand

| Item | State |
|---|---|
| Branch / worktree | `docs-restructure` in `~/Code/bandwidth-reservations-docs` (not merged to `main`) |
| Requirements | **`requirements-v1.9`** (tag): 468 scenarios, 67 needs, 33 policies. Records: `docs/reviews/22-…` (v1.8), `28-…` (v1.9) |
| C1 Requirements | Done (v1.9) |
| C2 RFC-000 | **Accepted, revision 4.3** (errata from reviews 16–27 and slice rev 3/4 issues). Risks R23 (thin X2-S15 margin), R24, R25 |
| Next review number | **29** (28 is used) |

### Slices (C3 = RFC accepted)

| Slice | RFC | Reviews | State | Round-2 step 4 action (in flight) |
|---|---|---|---|---|
| S-LINK | RFC-001 | 17 REJECT → 26 ACCEPT WITH CHANGES | rev 4 | revise → rev 5 per 26; then `fix-verifier` |
| S-ACCT + S-MONEY | RFC-002, RFC-004 | 18 → fix-verify 23 (RFC-002 ACCEPT; RFC-004 V-1..5 applied) | rev 4 | RFC-002 → rev 5 (JI-1..7 from 26, RFC-001/006 interfaces); RFC-004 → rev 5 rebase; then joint `fix-verifier` |
| S-RATE | RFC-003 | 19 → 24 | **C3 at rev 4** (tag `rfc-s-rate-accepted`) | reopened: rebase → rev 5 on v1.9 / 4.3; then `fix-verifier` |
| S-SEC | RFC-005 | 16 → 21 → 25 | **C3 at rev 4** (tag `rfc-s-sec-accepted`) | reopened: rebase → rev 5; then `fix-verifier` |
| S-PLAT | RFC-006 | 20 REJECT → 27 REJECT (3 Blockers) | rev 4 | revise → rev 5 per 27; then **full re-review** (focus sre) |

Orchestrator decisions (binding, beyond the reviewers'): unposted-usage publish 2 s;
lateness bound includes admission RTO (430 s); per-slot unavailability counts measured
slot-minutes (≥3 probes, ≥2 locations, all failed within `slot_probe_limit` 1 s);
placement owns the slot map; identity freshness is a slot-level in-memory watermark;
buyer pays a shown minimum-term fee; maintenance never affects buyers.

## Next steps

1. **In flight:** 6 × `rfc-author` to rev 5 (above). When done: coverage clean; commit.
2. `fix-verifier`: S-LINK (vs 26), S-ACCT+S-MONEY joint (vs 23 + 26 JI items), S-RATE, S-SEC.
   Full `rfc-reviewer` (focus sre) for S-PLAT. Numbers from 29.
3. Apply small residual defects; set "Accepted, revision n"; tag (for re-accepted slices,
   use `rfc-<slice>-accepted-r5`).
4. Batch further upstream issues only if blocking.
5. **C4**: `contract-author` per RFC-000 §8 contract once provider and consumers are at
   C3; `rfc-reviewer` mode contract. **C5**: `plan-author` per slice. **C6**: implement.

## Standing decisions to remember

- Design is authoritative; code conforms. Reviewers never read code or `docs/history/`.
- Business decisions are made by the orchestrator/agents with a recorded trade-off, never
  escalated to the user.
- Pricing: pay per reservation (POL-01). Topology: R1 Nairobi, R2 Mombasa (Share's own
  DCs), R3 GCP Johannesburg. Substrate: CockroachDB, NestJS owners with epoch-fenced
  leases, Kafka via outbox; `max_offset` 100 ms; τ ≈ 260–300 ms.
- Commits end with the session's Co-Authored-By / Claude-Session lines. If commit signing
  (1Password) fails, retry once, then ask the user to unlock; never bypass signing.

## Outside this repo (résumé work in `~/Code/rxresume`, waiting on the user)

- Add the "bandwidth-reservations" Selected Technical Work entry to
  `todor-genov-cv-share-founding-engineer.md` and `data/todor-genov-share.json`.
- Publish `bandwidth-reservations` as a public GitHub repo under `tgenov` (needs approval).
- Optionally add "programming language semantics" to the CS line.
- Create a private Reactive Resume copy (`./rx duplicate …`), back up, push, render PDF
  (needs approval).
- Remove merged worktrees `bandwidth-reservations-p2` and `-p34`; merge `docs-restructure`
  to `main` when the design reaches C3.
