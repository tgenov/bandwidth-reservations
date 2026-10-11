# P3. Metering and rating pay-per-use traffic

## Context

Share sells bandwidth on a route for as long as the buyer needs it, with no commits and no
upfront payment. The buyer funds a wallet, and the wallet is charged for the traffic the
buyer actually sends. Reserving capacity (P1, P2) decides what a buyer *may* send; this
problem is about measuring what they *did* send and turning it into charges.

Usage is reported by the network as flow records: one record per flow, saying how many
bytes passed and when the flow ended. Records reach billing over a message bus some time
after the traffic happened, and the bus may deliver the same record more than once.
Turning charges into balanced ledger entries, splitting them between suppliers and taking
payments is P4.

The business position, stated plainly:

- **Real-time prepaid billing is not possible.** Usage is known only after the fact, so a
  customer can always have used more than the wallet has been charged for.
- **Late usage amends the bill in either direction.** A charge already made can turn out to
  be too low (usage reported late) or too high (a wrong price), and the bill must be put
  right afterwards.
- **Whether to cut a customer off at a zero balance, or let the balance go negative up to
  some limit, is a risk and policy decision for the business,** not an engineering one.

## Who is affected

| Who | How |
|---|---|
| Buyers (builders, AI agents, enterprises) | Pay only for what they use; need a bill they can check and that does not change for unexplained reasons; need warning before they are cut off |
| Suppliers on the route | Are paid from these charges; under-metering is lost revenue for them |
| Share finance and risk | Carry the loss when usage outruns a wallet; need to know the worst case per customer |
| Network operations | Act on suspend and resume decisions; are the source of the usage data |
| Support | Explain to a buyer why a past minute's charge changed |

## The problem

1. **Records arrive more than once.** Delivery is at least once, so the same flow record can
   arrive two or more times. Counting it twice overcharges the buyer.
2. **Records arrive late and out of order.** A record may arrive after the minute it belongs
   to has already been charged, or after records for later minutes. The final bill must not
   depend on arrival order.
3. **A flow must belong to exactly one billing minute.** Billing is per minute, so each
   record's bytes have to be assigned to one minute, the same one every time.
4. **Prices change over time.** A record that arrives after a price change must still be
   priced as it would have been had it arrived on time. Prices that were set wrongly also
   need correcting after the fact.
5. **Past charges cannot be rewritten.** A bill that has been shown to a buyer, or paid out
   to a supplier, must stay as it was; changes have to be visible as separate amendments.
6. **Charging a minute races with records arriving for it.** If a record for a minute
   arrives while that minute is being charged, it must end up in the bill: neither lost nor
   counted twice.
7. **The wallet can be overrun.** Because usage is reported late, a buyer can keep sending
   traffic after their wallet is effectively empty, and it takes further time to cut their
   traffic. The business needs a known bound on how much can be owed beyond what has been
   charged, and a rule for when to suspend.
8. **Volume.** Share reports about 45 TB of traffic a day today, and the rebuild targets
   roughly 50 times the current scale. Every unit of that traffic has to be metered.

## Constraints and assumptions

| Item | Status |
|---|---|
| The source is reliable: no record is lost and export is 1:1 (unsampled) | *Assumed* |
| Every record has a unique ID, the exporter plus a sequence number, as in NetFlow v9 / IPFIX | *Assumed* |
| Delivery to billing is at least once, through Kafka | *Assumed* |
| How routers produce the records is out of scope | *Assumed* |
| A record carries the bytes of one flow and the time the flow ended | *Assumed* |
| Billing resolution is one minute | *Assumed* (follows the minute resolution of reservations) |
| A reservation caps the buyer's rate, so usage per second is bounded by the reserved rate | *Inferred* (from P1: capacity is sold as a rate) |
| No commits, no upfront payment; a wallet tracks usage | *Confirmed* (Share's public product description) |
| 45 TB of traffic a day | *Confirmed* as Share's own claim; not independently verified |
| Rebuild for about 50× the current scale | *Confirmed* in the job listing; what it measures is *Inferred* |
| Money must be exact: no floating point, reproducible from the raw data | *Assumed* |
| The billing stack is TypeScript/NestJS, PostgreSQL and Kafka | *Confirmed* (job listing) |

## Success measures

- Delivering the same set of records duplicated, shuffled or late produces exactly the same
  charges as delivering each once, in order.
- Every charge can be recomputed from the stored raw records and the price history.
- No record is ever lost or counted twice, including while its minute is being charged.
- A late record is priced at the price in force when the traffic happened.
- No past charge is ever modified; every amendment is a separate, visible entry.
- For every customer, the most they can owe beyond what has been charged is a number the
  business can see, and suspension happens before that number is exceeded under the chosen
  policy.
- Ingestion keeps up with the traffic volume at the target scale, with headroom.

## Out of scope

- Producing the flow records on routers, sampling and router CPU cost.
- The wallet itself, the double-entry ledger, splitting charges between suppliers and
  Share, payment webhooks, payouts and clawback (P4).
- How prices and split ratios are set (pricing policy).
- Actually cutting a customer's traffic on the network: billing decides and announces;
  network enforcement acts.
- Measuring delivered performance against SLAs (Problem 6 in the company profile).

## Open questions

1. **Terminate at zero, or allow a negative balance?** Setting aside the worst-case amount
   in the wallet removes the risk but may conflict with "no upfront payment". A credit limit
   keeps the promise but accepts a known loss per customer. Which, and for which customers?
2. **When a suspended customer tops up, is their traffic resumed automatically?**
3. **How late can a record be?** The bound on what a customer can owe depends on it, and so
   does how long a minute is held open before it is charged.
4. **What happens to a price increase during the window in which usage is not yet
   charged?** A bound computed at today's price does not cover it.
5. **Long flows:** should a flow that lasted many minutes be charged to the minute it ended,
   or spread across the minutes it was active?
6. **Sequence numbers:** NetFlow and IPFIX sequence numbers are finite counters that wrap
   and may restart when an exporter restarts. Is the "unique ID" assumption safe over the
   life of the system?
7. **What should happen to a record that cannot be read or does not match a known
   reservation?**
8. **What does "50× the current scale" mean in records per second?** It depends on the
   average size of a flow record, which is not known.
