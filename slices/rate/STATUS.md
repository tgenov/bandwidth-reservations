# S-RATE status

Plan: [docs/04-delivery/plan/S-RATE.md](../../docs/04-delivery/plan/S-RATE.md). All owners run on the C01
runtime double (`@share/owner-runtime/testing`). Other slices are contract doubles in
`rating-owner/testing/`.

| Package | Path | Contents |
|---|---|---|
| `@share/rate-common` | `common/` | C06 and C11 types, C06 CT-R1 schema checks, canonical `SourceRef`, ELA (RFC-003 §2), time helpers, append policy, feed cursor, alerts |
| `@share/ingestion` | `ingestion/` | Metering ingestion (IPFIX, one exporter, outcome "accepted"), `ingest_log` self-outboxed, hand-off events. Reference exporter in `testing/` |
| `@share/rating-owner` | `rating-owner/` | Catalogue (fixture writes, lead times), attribution stage A and stage B, rating (usage lines, figure, gated usage batches, posting acks). World, bus, account-owner and settlement doubles in `testing/` |

Run: `npm run typecheck:rate`, `npm run test:rate`, `npm run mutation:rate` (by hand; 66.9% after I1; 73.85% for `ela.ts` and `time.ts` in review 66). The `mutate` list now also has `stage-a.ts`, `catalogue/replica.ts` and `rating/owner.ts`; the score of this wider list is not recorded yet. No integration tests yet.

## Increments

| Increment | State | Scenarios met | Proof |
|---|---|---|---|
| I1 Walking skeleton | Done | P3-S25 | `rating-owner/test/walking-skeleton.test.ts`, `owners.test.ts`, `contract.c06.test.ts` |
| I2 Record identity, deduplication and outcomes | Not started | — | — |
| I3 Spread and exact usage lines | Done (uncommitted); review 66 findings TR-1 … TR-13 fixed | P3-S18, P3-S19, P3-S21, P3-S48, P3-S51, P3-S52 | `rating-owner/test/spread-and-lines.test.ts`, `rating-owner/test/ela.property.test.ts`, `rating-owner/test/owners.test.ts`, `common/test/common.test.ts` |

### I3 exit criteria

1. The six scenarios pass end to end: exporter → ingestion → stage A → stage B → rating → settlement double.
2. The ELA property test (RFC-003 §9) passes: random records (some with e = s, some longer than
   `flow_active_timeout` + 60 s, bytes up to 2^62), their spreads and negated copies, in a shuffled order,
   against an independent `bigint` rational reference. Every floor is equal at five prices. Crafted sums
   at X = N ± 1/P, with P > 10^18 the product of four primes ≤ 120,000, floor to N and N − 1. Seeds are
   fixed; `RATE_ELA_SEED=<n>` runs one seed again. A failure message names the seed.
   The test fails when `floorDiv` truncates, and when `spread` adds one byte to a part (checked once).
3. C06 CT-R1 vectors pass for lines on two routes (schema checks and the fixed canonical `SourceRef` hex).

What I3 added to I1 code: the stage A alert `FLOW_TOO_LONG` (`flowTooLong`) for a record longer than
`flow_active_timeout` + 60 s, raised only after the stage A entry commits (one alert when the hand-off
comes again). The record is still spread. Rating checks each part of a part batch (C11 Part IV: `num` a
signed integer, `den` a positive integer). A batch with a bad part is not applied, writes no entry and
raises `INVALID_PART` (review 66 TR-6). Spread, the ELA, the line formula, the price of
the line's own minute and one line for each (account, product, route, minute) were in I1 code; I3 adds
their scenario and property tests.

## Design issues (I3)

1. **C11 `ExactBytes.num` is `I64`.** Stage A sends `b × t_m / (e − s)` not reduced (C11 allows this).
   `b` is a U64 octet count and `t_m` is up to 60,000, so `num` can exceed 2^63 − 1. Real flows stay
   far below (100 Gbit/s for 120 s × 60,000 ≈ 9 × 10^16). Proposed: a C11 erratum that `num` is an
   unbounded signed decimal, or that stage A reduces the fraction and a record over the bound is rejected.
2. **RFC-003 §2 ELA size.** "`d ≤ 120,000` and `r_d` fits 32 bits" is true only for records within
   `flow_active_timeout` + 60 s. §4.2 step 2 spreads longer records too, so `d` can be larger. The code
   uses `bigint`, so nothing breaks. Proposed: RFC-003 §2 says "at most 120,000 for conforming records".
3. **Recipient of the long-record alert.** RFC-003 §4.2 says "its exporter is alerted" but names no feed
   or recipient. I3 raises `FLOW_TOO_LONG` (owner `attr_a`, exporter in the detail) on the alert sink.
   Proposed: the C01 alert feed to network operations, with the exporter and its owner.
4. **Usage line of 0 micro-USD.** RFC-003 and C06 do not say if a closed usage line with charge 0
   (P3-S21, 99,999 bytes) is emitted. The ledger refuses zero amounts (C06 "amounts are non-zero").
   Rating closes it with emitted total 0 and sends nothing. I4 must decide how a late amendment of
   such a line is numbered (an original with `seq` 0, or an amendment). Proposed: RFC-003 §5.6 says a
   line closed at 0 is not emitted, and a later non-zero total is its original (`seq` 0).

## Remaining work

- I2, I4 … I20 (plan §6). Rating still raises `LATE_TRAFFIC_NOT_IN_I1` for a part of a closed line; I4 replaces it with amendments.
- Rate integration tests on the dev cell: none yet (the plan puts the first ones with I2 and I4).
