# Contract suite issues

The contract suites test only what the frozen contracts state. When a contract does not state a
behaviour clearly, the suites do not test it, and the point is recorded here. Each item needs a
decision by the contract owner (an erratum or a new contract version). Until then, a provider and
a double can differ on the point, and both pass.

| Id | Contract | Point that is not clear | Real provider today | Double today |
|---|---|---|---|---|
| CS-1 | C01 §3.2, §2.4 | When `displacementRead` meets its lock timeout, the condition fails "as `'lockTimeout'`" in `conditionResults`. The contract does not say what `ConditionFailed.which` is: the condition label, or the literal `'lockTimeout'`. The account owner must tell a lock timeout (move the E5 to the next batch) from a displacement (no E5) | `which: 'lockTimeout'` | Cannot give a lock timeout |
| CS-2 | C01 §3.1, §2.4 | "Rebuilding a partition" reads the partition's log rows, but `OwnerRuntime` (§2.4) has no operation for it. The link owner uses `readLog(partition, fromSeq)`, which only `CockroachOwnerRuntime` and the runtime double have. The contract does not say if `readLog` is part of the runtime interface | `readLog` on `CockroachOwnerRuntime` | `readLog` on `RuntimeDouble` (added for the C01 suite) |
| CS-3 | C02 "Link hold port", `convert` | `convert` for a request whose hold was refused, or was released, can answer `NO_HOLD` or `TOMBSTONED`. The contract lists both as violations, but does not say which one applies to which state | `TOMBSTONED` | `NO_HOLD` |
| CS-4 | C02 "Idempotency", `release` | "The latest `D` sets the end of the tombstone." It is not clear if "latest" means the largest `D` or the `D` of the most recent `release` | The largest `D` | The `D` of the most recent `release` |
| CS-5 | C02 "Conventions", `LinkStamp` | `linkSeq` is the link's log position. The contract does not say which position a reply to a duplicate carries: the position of the entry that recorded the state, or the present position | The recorded entry's position | A new, higher value |
| CS-6 | C06 §7, §8 | `ledgerLastSeq` on `prior_total_mismatch` when the ledger has posted nothing for the line key. The rating rule "next amendment sequence = `ledgerLastSeq` + 1" suggests −1, but the contract does not state it | No real ledger (MONEY-I2) | −1 |

## Known provider gaps (not contract issues)

These are behaviours that the contract states, but that the real provider of the present increment
does not have yet. The suites do not test them until the increment that provides them.

| Contract | Behaviour | Provider | Increment |
|---|---|---|---|
| C02 `hold` check (5) | `REFUSED(NO_FIT)` carries a `counterOffer` | Real link owner | S-LINK I2 |
| C02 `hold` check (8) | `WAITING(1, aheadDeadline)` for `wait = true` | Real link owner (answers `UNAVAILABLE`); the account link double throws | S-LINK I3 |
| C08 §B | `catch_up` with and without `since` | Real identity owner | S-SEC-I2 (registered PENDING entry) |
| C06 §7, §8 | Posting port and posting acknowledgement | Real ledger | MONEY-I2 (registered PENDING entry) |
