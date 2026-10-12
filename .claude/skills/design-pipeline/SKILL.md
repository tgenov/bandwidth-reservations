---
name: design-pipeline
description: Orchestrate the design pipeline in this repo (discovery → requirements → RFC-000 → slice RFCs → contracts → delivery plans → conformance) with the local purpose-built agents and tools. Use when advancing any checkpoint, batching issues into a requirements version, rebasing slices, or running reviews on docs/.
---

# Design pipeline: orchestrator playbook

The process, checkpoints (C0–C6) and dependency graph are in
`docs/process/pipeline.md`; slices are in `docs/process/slices.json`. Read those two
files once per session, not per step.

## Agents (in `.claude/agents/`) and when to use them
| Agent | Checkpoint | Use for |
|---|---|---|
| `req-amender` | C1 | apply a batch of decisions/issues → requirements vN+1 |
| `req-reviewer` | C1 | adversarial gate over a scope of slices |
| `rfc-author` | C2, C3 | write / rebase / revise / errata one RFC |
| `rfc-reviewer` | C2–C5 | adversarial review: rfc, joint, contract, plan (+ focus) |
| `fix-verifier` | C2–C5 | confirm a revision fixes a named review |
| `contract-author` | C4 | freeze one contract |
| `plan-author` | C5 | plan one slice |

Never use a generic agent for these jobs. The agent files carry the rules, read scopes,
conventions and output formats, so briefs stay short. Never paste conventions into a
brief; never ask an agent to write a checker.

## Brief templates (one paragraph each)
- `req-amender`: "Requirements vN → vN+1. Decisions (binding): <id>: <rule>; … . Issues
  to decide yourself: <ids and RFC files>. Record: docs/reviews/<NN>-…md."
- `req-reviewer`: "Gate C1 for <slices> at WORKTREE (target tag requirements-vN). Prior
  records: <files>."
- `rfc-author`: "<mode> <slice|RFC-000> against requirements-vN and RFC-000 rev R.
  Impact: `impact.py diff <old> <new>` IDs: <ids>. Review/records: <files>. Decisions
  (binding): <…>."
- `rfc-reviewer`: "<mode> review of <slice(s)> (focus <x>) against requirements-vN, RFC-000
  rev R."
- `fix-verifier`: "Verify <artefact> rev n against review <file>."

## Loop for every checkpoint
1. Pin: commit, tag the authority (`requirements-vN`, RFC-000 revision in Status).
2. Run `python3 tools/check_specs.py` and `python3 tools/impact.py coverage` yourself
   before dispatching; fix trivial mechanical issues directly.
3. Dispatch independent slices in parallel (they never share files). Joint slices
   (`S-ACCT` + `S-MONEY`) go to one reviewer in joint mode.
4. Collect reports. For every issue and "decision taken": accept, override or decide.
   Business decisions are yours — never escalate a policy question to the user; record
   the trade-off. Escalate only genuinely external facts or the user's own history.
5. Batch upstream changes: one `req-amender` + one `rfc-author` (RFC-000 errata) in
   parallel. Tag `requirements-vN+1`. Run `impact.py diff vN vN+1`; rebase only listed
   slices, passing the listed IDs.
6. Converge: a round with no Blocker → `fix-verifier`, not another full review. If the
   verifier's defects are precise local edits, apply them yourself.
7. Close: set Status "Accepted, revision n", tag (`rfc-<slice>-accepted`,
   `contract-<id>-vN`, `plan-<slice>-accepted`), commit with the session's attribution
   lines.

## Housekeeping
- Commit after every agent batch; agents never commit. Commit signing may fail if
  1Password is locked — retry once, then tell the user; never bypass signing.
- If an agent stops on a usage limit, resume it with SendMessage ("resume where you
  stopped, same brief") rather than starting a new one.
- Keep user updates short: verdict, what was decided, what runs next.
