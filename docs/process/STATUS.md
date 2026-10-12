# Pipeline status (resume point)

Checkpoint updated 2026-10-13 (C4 complete). Read this, `pipeline.md` and `slices.json`, then follow
**Next steps**. Use the `design-pipeline` skill and the agents in `.claude/agents/`.

## Where things stand

| Item | State |
|---|---|
| Branch / worktree | `docs-restructure` in `~/Code/bandwidth-reservations-docs`. `main` is fast-forwarded to it after each batch. |
| Requirements | **`requirements-v1.10`** (tag): 473 scenarios. Records: `docs/reviews/22-…` (v1.8), `28-…` (v1.9), `35-…` (v1.10). |
| C2 RFC-000 | **Accepted, revision 4.4.** |
| C3 slice RFCs | All accepted. RFC-001 rev 5, RFC-002 rev 5, RFC-003 rev 5 (+ erratum 5.1), RFC-004 rev 5 (+ erratum 5.1), RFC-005 rev 5, RFC-006 rev 6. All are pinned to v1.9. |
| C4 contracts | **Done.** C01 … C12 are frozen in `docs/04-delivery/contracts/`, with tags `contract-C01-v1` … `contract-C12-v1`. Reviews 36 … 63. |
| Next review number | **64** |

The old `docs/04-delivery/contracts.md` and `plan.md` are marked superseded.

### Open after C4 (do these before C5)

1. **Consistency check C09 against C07** on the payout-destination query (C16): the "not found" case after a restore, and the R36-31 conflicts.
2. **Upstream batch.** Contract reviews 37 … 63 raised requirements issues (RQ-…) and architecture issues (AI-…, A-…). Earlier items are also open: RQ4-14 is done in v1.10, while RQ-1/RQ-2 (C12), RQ-40-1…5, RQ-41-x, RQ-44-1, RQ-46-1, RQ-48-1, RQ-57-x and others are not. Decide each item. Then run one `req-amender` (→ v1.11) and one `rfc-author` (RFC-000 errata → rev 4.5) in parallel.
3. **RFC errata pass.** Run one `rfc-author` per slice, in parallel. Each one rebases the slice onto v1.10 (or v1.11) and RFC-000 4.5, and applies the "Errata owed" / "Consumer obligations" lists of every frozen contract that names that RFC. Today, coverage shows P1-S84, P4-S117, P4-S118, X1-S46 and X2-S33 as uncited. After the pass, run `fix-verifier` per slice, then set Status "Accepted, revision n+1".
4. **Plain-language pass.** Rewrite the frozen contracts in ASD-STE100 Simplified Technical English. Do not change their meaning. Most text is from before the style rule.
5. **C5.** Run `plan-author` per slice, then `rfc-reviewer` in plan mode.

### Orchestrator decisions in force (beyond the reviews)

- The unposted-usage publish interval is 2 s. The lateness bound includes the admission RTO (430 s).
- The per-slot unavailability rule counts measured slot-minutes only, with `slot_probe_limit` = 1 s.
- Placement's slot map is the only source of probe designation.
- `iam_fresh` is a slot-level watermark in owner memory. It counts only applied, gap-free resolved timestamps.
- A shown minimum-term fee is paid by the buyer. Maintenance never makes a buyer affected.
- C4-1 … C4-7 (cut-target delivery and revisions, leg-change ordering, payout destination).
- Each (reservation, leg) has one outstanding leg command, in the order of its deciding entry.
- A cut-target revision rule is shared by C02, C03 and C04. These contracts also share the "ended part" definition.
- A quote is a stateless owner-signed token. A fee-bearing partner route needs a quote.
- `abandon` of a parked line is Share-paid.

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
