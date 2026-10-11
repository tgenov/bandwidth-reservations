# Requirements amendments from the architecture review

| | |
|---|---|
| Resolves | The requirements issues RI-1 to RI-5 raised by [RFC-000](../03-rfcs/RFC-000-architecture.md) ("Requirements issues") |
| Decisions applied | RI-1 to RI-5, as decided by the coordinator. Each is written into its register entry as the current rule and has its own "Architecture review: RI-n …" row in the register's Amendments table |
| Files changed | `02-specs/policy-register.md`; `02-specs/P2-route-reservation.feature`, `P3-rating-and-metering.feature`, `P4-wallet-and-settlement.feature`, `X2-non-functional.feature`; `01-discovery/P2-route-reservation.md`, `P3-rating-and-metering.md`, `X1-security-and-tenancy.md`, `X2-non-functional-targets.md`; `02-specs/glossary.md`; `02-specs/conformance.md` (regenerated); `README.md`; this record |
| Not read | Code, `history/` |
| Date | 2026-10-11 |

## Outcome

All five issues are integrated as current rules, and the mechanical checks pass with no
problems. The baseline now has **374 scenarios**: P1 53, P2 103, P3 62, P4 104, X1 30 and X2 22.
Nine scenarios are new. No ID was renumbered, reused or removed. The new IDs continue each
file's numbering: **P2-S99 to P2-S103**, **P3-S61 and P3-S62**, and **X2-S21 and X2-S22**.
Two new parameters are added: `status_staleness` (POL-04, 1 s) and `attribution_lag_max`
(POL-14, 10 s).

## Changes by issue

### RI-1. Partner holds expire at the deadline (POL-26, POL-28, P2-N3)

| Where | Change |
|---|---|
| POL-26 | A partner counts as offering holds only if both of these are true: its holds can last at least `route_deadline_max` + `commit_margin`, and it accepts an absolute hold expiry set by Share when the hold is taken. Otherwise it is a partner without holds. Share sets every partner hold to expire at the request's deadline, so the hold lapses then even if Share is unavailable. Share still releases every hold at the deadline as well. The Why gains the trade-off |
| POL-28 | The first bullet now covers partners whose holds do not meet POL-26 (too short, or no expiry that Share can set). The provenance line cites RI-1 |
| Summary | The POL-26 and POL-28 lines are updated |
| P2-N3 | The need now states that Share sets the partner hold's expiry to the deadline, and says which partner counts as one without holds. The measure, "no capacity held … after its deadline on any leg, even across an outage", is unchanged and can now be met |
| P2 C8, C20 | C8 adds the POL-26 test for offering holds. C20 states that a partner hold lapses at the expiry Share set |
| Glossary | "Partner without holds" adds the expiry condition. Under "Capacity hold", a partner hold lapses at the expiry that Share set to the deadline |
| P2-S93 | Changed. The Given "P's hold would last 120 s if left to expire" can no longer happen, so it is removed. The title is now "Share releases every hold of a request at its deadline, a partner hold included" |
| New | **P2-S100** `@need-P2-N3 @need-P2-N7 @POL-26`: Share sets a partner hold to expire at the request's deadline |
| New | **P2-S101** `@need-P2-N3 @need-P2-N7 @POL-26`: capacity held at a partner lapses at the deadline even when Share is unavailable then |
| New | **P2-S102** `@need-P2-N7 @POL-26 @POL-28`: a partner whose holds are long enough, but which does not accept an expiry set by Share, counts as a partner without holds. It is a sibling of P2-S36 |

### RI-2. Unposted usage counts accepted records; attribution lag is bounded (POL-14, POL-18, POL-06, P3-N10)

| Where | Change |
|---|---|
| POL-18 | Unposted usage is usage-priced traffic in records **accepted by usage ingestion** and not yet posted. A record counts in it within `attribution_lag_max` of its acceptance, and until it is posted. The Why is restated |
| POL-14 | New parameter `attribution_lag_max` = 10 s: the time from a record's acceptance to its effect on headroom. The lateness bound is `usage_rate_cap` × (`max_lateness` + `attribution_lag_max` + 60 s) × the highest `usage_price`, and it covers all traffic carried but not yet counted. A record counted later than `attribution_lag_max` is reported as a breach, as a record later than `max_lateness` is. A worked default is added (250 s, 3.125 GB at 100 Mbps) |
| POL-06 | New timeliness row "Latency, accepted record to headroom". It is met when at least 99.99% of a month's minutes have every accepted record counted within `attribution_lag_max`. Minutes affected by a declared region disaster are left out, and records counted later are reported as breaches. The Why is extended |
| Summary | The POL-14 and POL-18 lines are updated |
| P3-N10 | The need and the measure now cover the accepted-record definition, the new formula and the attribution-lag breach report. The P3 constraint row and the X2-ownership note are updated |
| X2-N3 | The new target is added, and the "Measured by" column now names the accepted record counted in headroom |
| Glossary | "Usage exposure" gives the new definition and formula. The new term "Attribution lag" is added |
| P3-S37 | Recomputed (below). "received" becomes "accepted by usage ingestion" |
| P4-S15, P4-S16 | Recomputed (below), to stay consistent with P3-S37 at the defaults |
| X2-S04 | Now refers to the timeliness targets of X2-S13 **and X2-S22** |
| New | **P3-S61** `@need-P3-N10 @POL-14 @POL-18`: an accepted record counts in unposted usage from within `attribution_lag_max` of its acceptance until it is posted |
| New | **P3-S62** `@need-P3-N10 @POL-14`: a record counted later than `attribution_lag_max` is reported as a breach and still charged |
| New | **X2-S22** `@need-X2-N3 @POL-06 @POL-14 @POL-18`: the X2 timeliness target for attribution lag |

### RI-3. One decision per request; status reads lag it by at most 1 s (POL-04, P2-N8)

| Where | Change |
|---|---|
| POL-04 | New rules. **One decision per request**: each outcome is decided at one point. Whether a request was still pending at a suspension, a key revocation, a withdrawal or its deadline is judged against that point. **Status reads**: a status read may lag the decision by at most `status_staleness`, and it never reports an outcome contrary to the decision. New parameter `status_staleness` = 1 s. The Why is extended |
| POL-25 | Under Revocation, "pending requests" now reads "(those not yet decided, POL-04)" |
| Summary | The POL-04 line is updated |
| P2-N2 | The need and the measure now include the status-read rule |
| P2-N8 | "Still pending when suspended" now reads "not yet decided when suspended". A request decided before the suspension keeps its outcome. Revoking a key fails only the requests that are not yet decided |
| P2 C20 | Adds the one-decision and status-staleness rule |
| X1-N3 | Revocation fails the requests that are not yet decided (POL-04) |
| Glossary | "Outcome" states that each request is decided at one point. A new "Status read" term is added. Under "Agent key", revocation fails the requests that are not yet decided |
| P2-S69 | Retitled "A request not yet decided when its account is suspended is not confirmed". The behaviour is unchanged |
| New | **P2-S99** `@need-P2-N2 @POL-04`: a status read never contradicts the decided outcome, and reflects it within `status_staleness` |
| New | **P2-S103** `@need-P2-N8 @need-P2-N3 @need-P2-N2 @POL-04 @POL-16 @POL-25 @POL-08`. A suspension, a key revocation or a withdrawal that comes after a request is decided does not change its outcome, even while a status read still shows it pending. It is an outline with one row per event |

### RI-4. Funds holds for bookings are held to admission's targets (POL-06, X2)

| Where | Change |
|---|---|
| POL-06 | New bullet. The funds hold (or credit hold) and the headroom check that a booking or change needs are part of the admission capability, with 99.99% availability and an RTO of 1 min on node or zone loss, whatever the wallet's own targets. The wallet's targets apply to its other operations. The Why is extended |
| Summary | The POL-06 line is updated |
| X2-N1, X2-N5 | Both state the rule |
| New | **X2-S21** `@need-X2-N1 @need-X2-N5 @POL-06 @POL-15 @POL-18`. The funds holds and headroom checks that bookings need meet admission's 99.99% and 1 min, not the wallet's 99.9% and 5 min |

### RI-5. "Per region" means each serving region (POL-06)

| Where | Change |
|---|---|
| POL-06 | Every target applies per **serving region**: each region whose edge answers buyers, suppliers, exporters or payment providers. A region that only keeps copies of state has no targets of its own. The availability table header and the probe-provisioning wording are updated |
| Summary | The POL-06 line is updated |
| X2-N1 | Now reads "per serving region", with the definition. The X2 open-questions note is updated |
| Glossary | New term "Serving region" |
| X2-S01 | "in each region" becomes "in each serving region". No new scenario is needed, because this is a definition |

### Other changes

| Where | Change |
|---|---|
| Register header | It now names the architecture review (`RI-n`) as a source of decisions |
| Register Amendments | Five rows were added, one per issue, each starting "Architecture review: RI-n …" |
| `README.md` | The paragraph that said the RFCs predate the baseline now says this: RFC-000 is written against the baseline; the RFC-001 … RFC-004 drafts are superseded and being rewritten on it; the delivery documents are still pending revision. The RFC header convention is now "Status, Satisfies, Policies, Prior decisions (history log D-nn, optional)", and the text explains each field |
| `conformance.md` | The matrix was regenerated: 9 rows added, 2 titles updated (P2-S69, P2-S93) and none removed, so every existing Design, Tests and Status cell is kept. The header now cites this record |

## Arithmetic recomputed

- **Lateness bound at the defaults:**
  - 180 s + 10 s + 60 s = 250 s.
  - 100 Mbps × 250 s = 25,000 Mb = 3,125 MB = 3.125 GB.
  - At 10,000 micro-USD per GB, that is 31,250 micro-USD. Before this change it was 240 s, 3 GB and 30,000 micro-USD.
- **P3-S37:** unposted usage is 0.2 GB × 10,000 = 2,000 micro-USD, and the usage exposure is 2,000 + 31,250 = 33,250 micro-USD.
- **P4-S15 and P4-S16:**
  - The lateness bound is 0.031250 USD and the usage exposure is 0.002000 + 0.031250 = 0.033250 USD.
  - The headline is 1.000000 − 0.288000 − 0.033250 = 0.678750 USD. Before this change it was 0.680000.
- **X2-S21:** the figures are the POL-06 values: admission 99.99% and 1 min, wallet 99.9% and 5 min.

No other scenario used the lateness bound's value. P2-S93 and P2-S101 use a 30 s deadline, which is within POL-26's bounds.

## Mechanical checks

The checks were run with the official Cucumber parser (`@cucumber/gherkin`, installed in a
scratch directory) and a script over the parsed documents, the register, the glossary, the
problem statements and the conformance matrix. The same script was run first on the
committed baseline (365 scenarios), which gave no problems, so the comparison shows only
the effect of these amendments.

| Check | Result |
|---|---|
| Every `.feature` parses as Gherkin (one Feature; Backgrounds only in Rules) | 6 of 6 |
| Every scenario has a `When` and a `Then`; no step text starts with punctuation | Pass |
| Every Outline placeholder has its column; at most one unused column, and it is the last; no plain Scenario with Examples | Pass |
| Scenario IDs: exactly one per scenario, unique, prefixed by its file | 374 IDs, 374 unique |
| Every `@need-` tag names a need in a Needs table; every need cited | 66 needs, all cited, no dangling tag |
| Every `@POL-nn` exists in the register (33 entries) | Pass |
| Every `POL-nn` named in a scenario's title, steps, Examples or Rule Background is tagged | Pass |
| Glossary-term rule on a scenario's own steps and Examples | Pass |
| Every backticked identifier in the specs, problem statements and glossary is a register parameter or a register-defined value | Pass (45 parameters, including `status_staleness` and `attribution_lag_max`) |
| Register: no round markers inside entries; every `POL-nn` reference exists | Pass |
| Conformance: one row per scenario, in file order, none orphaned | 374 rows |

## Not changed

- RFC-000 is not edited. Its "Requirements issues" table can now point to these
  amendments when it is revised.
- No new policy entry was needed. Every rule fits an existing entry.
