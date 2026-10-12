# Pipeline status (resume point)

Checkpoint updated 2026-10-12 (step 4 of the C3 round). Read this, `pipeline.md` and `slices.json`, then follow
**Next steps**. Use the `design-pipeline` skill and the agents in `.claude/agents/`.

## Where things stand

| Item | State |
|---|---|
| Branch / worktree | `docs-restructure` in `~/Code/bandwidth-reservations-docs` (not merged to `main`) |
| Requirements | **`requirements-v1.8`** (tag): 462 scenarios (P1 80, P2 117, P3 74, P4 116, X1 43, X2 32), 67 needs, 33 policies, 51 parameters. Record: `docs/reviews/22-…` |
| C1 Requirements | Done (v1.8) |
| C2 RFC-000 | **Accepted, revision 4.2** (errata from reviews 16–20; batching waits budgeted, τ ≈ 420 ms cap ≈ 450 ms; ~16,384 account / 4,096 link slots; risks R23 thin X2-S15 margin, R24 probe noise, R25) |
| Next review number | **23** (22 is used) |

### Slices (C3 = RFC accepted)

| Slice | RFC | Last review | Verdict | Step 4 action |
|---|---|---|---|---|
| S-LINK | RFC-001 | 17 | REJECT (1 Blocker) | revise → rev 4, then **full re-review** |
| S-ACCT + S-MONEY | RFC-002, RFC-004 | 18 (joint) | ACCEPT WITH CHANGES | revise → rev 4, then `fix-verifier` |
| S-RATE | RFC-003 | 19 | ACCEPT WITH CHANGES | revise → rev 4, then `fix-verifier` |
| S-SEC | RFC-005 | 16 → fix-verify 21 (fixed in rev 3.1) | ACCEPT WITH CHANGES, defects fixed | rebase → rev 4 on v1.8, then `fix-verifier` |
| S-PLAT | RFC-006 | 20 | REJECT (3 Blockers) | revise → rev 4, then **full re-review** |

Orchestrator decisions in this round (binding): unposted-usage publish interval 2 s;
lateness bound includes admission RTO (430 s); per-slot unavailability counts only
measured slot-minutes (≥3 probes, ≥2 locations, all failed); placement owns the slot map.

## Next steps

1. **Step 4 in flight:** 6 × `rfc-author` revising every slice to rev 4 on v1.8 + RFC-000
   rev 4.2. When done: coverage clean for every slice; commit.
2. `fix-verifier` for S-ACCT+S-MONEY (vs 18), S-RATE (vs 19), S-SEC (vs 16/21 + v1.8);
   full `rfc-reviewer` for S-LINK and S-PLAT (focus sre). Reviews numbered from 23.
3. Batch any new upstream issues (→ v1.9 / RFC-000 4.3) only if they block; else carry.
4. Close C3 per slice: Status "Accepted, revision n", tag `rfc-<slice>-accepted`.
5. **C4**: `contract-author` per RFC-000 §8 contract once provider and consumers are at
   C3; `rfc-reviewer` mode contract. **C5**: `plan-author` per slice; `rfc-reviewer` mode
   plan. **C6**: implement per plan.

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
