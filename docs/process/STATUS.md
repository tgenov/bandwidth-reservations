# Pipeline status (resume point)

Checkpoint written 2026-10-12. Read this, `pipeline.md` and `slices.json`, then follow
**Next steps**. Use the `design-pipeline` skill and the agents in `.claude/agents/`.

## Where things stand

| Item | State |
|---|---|
| Branch / worktree | `docs-restructure` in `~/Code/bandwidth-reservations-docs` (not merged to `main`) |
| Requirements | **`requirements-v1.7`** (tag): 448 scenarios (P1 78, P2 116, P3 73, P4 113, X1 39, X2 29), 67 needs, 33 policies, 50 parameters. `python3 tools/check_specs.py` → NO PROBLEMS |
| C1 Requirements | Done (v1.7). Last amendment record: `docs/reviews/12-…` |
| C2 RFC-000 | **Accepted, revision 4.1** (tag `rfc-000-accepted` marks rev 3.2; rev 4 = CockroachDB 2+2+1 + NestJS owners + Kafka substrate; rev 4.1 errata). No open issues |
| Next review number | **17** (16 is used) |

### Slices (C3 = RFC accepted)

| Slice | RFC | Revision | Based on | v1.7 coverage gap (`impact.py coverage`) | C3 review |
|---|---|---|---|---|---|
| S-LINK | RFC-001 | Draft rev 2 | v1.6 + RFC-000 r4 | P1-S76, P1-S77, P1-S78 | not run |
| S-ACCT | RFC-002 | Draft rev 2 (+ r4.1 errata edits) | v1.6 + RFC-000 r4.1 | none | not run (joint with S-MONEY) |
| S-RATE | RFC-003 | Draft rev 2 | v1.6 + RFC-000 r4 | P3-S71, P3-S72, P3-S73 | not run |
| S-MONEY | RFC-004 | Draft rev 2 (+ r4.1 errata edits) | v1.6 + RFC-000 r4.1 | P4-S111, P4-S112, P4-S113 | not run (joint with S-ACCT) |
| S-SEC | RFC-005 | Draft rev 2 | v1.6 + RFC-000 r4 | X1-S39 | **done**: `docs/reviews/16-rfc-005-review.md` — Not ready: 2 Blocker, 12 Major, 14 Minor; has Decisions taken, Requirements issues (RQ-R5-*), Architecture issues (AI-R5-*) |
| S-PLAT | RFC-006 | Draft rev 2 | v1.6 + RFC-000 r4 | X2-S29 | not run |

Rebase delta v1.6 → v1.7 for every slice: `python3 tools/impact.py diff requirements-v1.6 requirements-v1.7`.

C4 (contracts), C5 (plans), C6 (conformance): not started. `docs/04-delivery/` holds
pre-baseline drafts (`plan.md`, `contracts.md`) that are superseded; the C4/C5 agents
write into `docs/04-delivery/contracts/` and `docs/04-delivery/plan/`.

## Next steps

1. **Rebase to v1.7 (parallel, 6 × `rfc-author`, mode rebase).** For each slice: "rebase
   <slice> against requirements-v1.7 and RFC-000 rev 4.1. Impact: `impact.py diff
   requirements-v1.6 requirements-v1.7` (its listed IDs). Records:
   docs/reviews/12-requirements-amendments-from-rfc-revision-2.md." For **S-SEC**, combine
   with review 16: mode revise, "per docs/reviews/16-rfc-005-review.md", and set aside its
   Requirements/Architecture issues for step 3. Done when `impact.py coverage` is clean
   for every slice. Commit.
2. **C3 reviews (parallel, 4 × `rfc-reviewer`).** S-LINK (rfc); S-ACCT + S-MONEY (joint,
   focus money + concurrency); S-RATE (rfc, focus money); S-PLAT (rfc, focus sre).
   Reviews numbered from 17. S-SEC goes to `fix-verifier` against review 16 instead.
3. **Batch upstream issues** from reviews 16+ (Decisions taken, Requirements issues,
   Architecture issues): decide each; one `req-amender` (→ `requirements-v1.8`) and one
   `rfc-author` (RFC-000 errata → rev 4.2), in parallel. Commit, tag, run
   `impact.py diff requirements-v1.7 requirements-v1.8`.
4. **Revise** each slice per its review + the v1.8 impact (`rfc-author`, mode revise);
   then `fix-verifier`; apply small residual defects directly; set Status "Accepted,
   revision n"; tag `rfc-<slice>-accepted`.
5. **C4**: `contract-author` per RFC-000 §8 contract once provider and consumers are at
   C3; `rfc-reviewer` mode contract. **C5**: `plan-author` per slice; `rfc-reviewer` mode
   plan. **C6**: implement per plan (existing prototype code in `src/` and `billing/` is
   prior art only; the conformance matrix records results).

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
