# Delivery plans: cross-slice build order

Each slice plan is the authority for its own increments. This page gives only the order
across slices. A slice depends on another slice only through a frozen contract
(`../contracts/C01` … `C13`).

| Plan | Increments | Scenarios placed |
|---|---|---|
| [S-PLAT](S-PLAT.md) | I1 … I9, 4 spikes | 33 / 33 (X2) |
| [S-LINK](S-LINK.md) | I1 … I16, 5 spikes | 85 / 85 (P1) |
| [S-SEC](S-SEC.md) | I1 … I18, 4 spikes | 49 / 49 (X1) |
| [S-RATE](S-RATE.md) | I1 … I20, 3 spikes | 78 / 78 (P3) |
| [S-ACCT + S-MONEY](S-ACCT-S-MONEY.md) | AM/ACCT/MONEY-I1 … I29, 4 spikes | 242 / 242 (P2, P4) |

## Order

1. **S-PLAT I1a** (now): the C01 types and the runtime double
   (`@share/owner-runtime`, `@share/owner-runtime/testing`). When these exist, every
   slice can start its I1 on the double.
2. **Walking skeletons, in parallel, on the runtime double:**
   - S-LINK I1: hold, convert and release on one link through C02. A property test proves
     that a link is never oversold (P1-N1).
   - S-SEC I1: agent key at the edge, principal context, identity push, one audit append.
   - AM-I1: book one single-link route through C10, admit with C05 funds, hold and
     convert through C02, report the outcome.
   - S-RATE I1: one flow record in, rated, posted as a charge line through C06.
3. **S-PLAT I1b**: relay, closure emitter, status readers, markers, consumer runtime.
   Each slice then runs its I1 exit tests again on the real runtime (dev cell).
4. **Money path early**: MONEY-I2, MONEY-I3, AM-I5, AM-I6 (ledger, posting port, movement
   feed, usage-applied). S-RATE posts real charge lines after these.
5. After that, each slice follows its own plan. S-PLAT I2 and I3 (second lane, moves,
   splitting) come before load work. S-PLAT I9 is the go-live gate for all slices.

## Open items that do not block the start

- Contract errata batch (small clarifications, no interface removed): see the issue list
  in the latest `docs/process/STATUS.md` (CI-…).
- Requirements: B-RQ-12 (P2-S121 row 4 is pending; the 1-minute partner-terms lead time
  is kept), RQ4-16, RQ4-17.
- Missing owners: the quote key for the account owner (B-AI-14), the equivalent-path
  source (C12 §2.4), and the encryption library contract (S-PLAT B1).
- External: the real sites, partner sandboxes, payment and payout providers.
