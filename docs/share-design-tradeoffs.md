# Share marketplace: policy-derived design trade-offs

This is a work-sample analysis, not a statement of Share's current product policy.
The prototype can demonstrate mechanisms, failure modes, and local consequences. It
cannot legitimately decide commercial risk, customer promises, supplier terms, or
regulatory posture on the company's behalf.

The policy identifiers below refer to the candidate repository's
[`policy register`](../bandwidth-reservations/docs/02-specs/policy-register.md). Its
decisions are explicitly provisional and require business ratification.

## The decision chain

```text
Company philosophy → risk allocation → explicit policy → observable outcome
→ mechanism, tests, controls, and operational ownership
```

Engineering should not select a risk allocation accidentally because it is the easiest
algorithm. Its role is to expose the consequences, preserve the chosen invariant, and
make a policy breach observable.

## Proposed invariants

These are candidate product promises, not implementation conveniences:

- An accepted reservation must not oversell capacity.
- A money movement must be balanced, reproducible, and idempotent.
- A request must reach one durable outcome; status must not contradict it.
- Capacity reported as free must already be durably released.

The trade-offs below choose who bears cost or risk while preserving those promises.

| Trade-off | Provisional policy | Observable consequence | Risk allocation and rationale | Business decision still required |
| --- | --- | --- | --- | --- |
| **Guaranteed capacity versus byte usage** | **POL-01:** charge guaranteed products per Mbps-minute; charge per GB only for best-effort, burst, or out-of-reservation use. | Buyers pay for idle reserved capacity; metering does not decide guaranteed-product revenue. | Share and suppliers avoid bearing the cost of capacity a buyer blocks but does not use. Pure byte pricing makes hoarding cheap; a minimum term weakens the short-duration proposition. | Product, commercial, supplier partners, and finance must decide what “pay for what you use” means and validate willingness to pay. |
| **Neutral access versus revenue optimisation** | **POL-02 / POL-05:** request age has priority; a request waits by default when a temporary hold is the blocker. | Some buyers receive `pending`; value or customer tier does not buy queue priority. | A carrier-neutral market gives up some immediate revenue and throughput optimisation to avoid a market rule that can be gamed or perceived as discriminatory. | Product, commercial, and legal must choose the fairness promise and whether any differentiated service is compatible with it. |
| **Fast acknowledgement versus final answer** | **POL-04 / POL-26:** answer within the acknowledgement budget; return `pending` when a partner route cannot yet be final. | API users must handle polling/webhooks; scarce capacity and funds remain in flight until deadline or decision. | The buyer receives a quick honest answer instead of a false synchronous guarantee. Short deadlines lower conversion; long deadlines increase inventory and credit exposure. | Product, DX, operations, and partner management must set the latency and completion promises from actual buyer and partner behavior. |
| **Simple ownership versus hot-link throughput** | **POL-05:** one schedule owner per link. | Admission for a hot link serializes; ownership and recovery are easier to audit. | Share accepts a per-link throughput boundary to make “never oversell” simple. Finer locks or optimistic retries can raise throughput but shift risk to deadlocks, retries, fencing, and recovery. | Engineering/SRE must quantify demand and decide the topology and cost needed for the promised latency at peak. |
| **Open-ended convenience versus long-term supply risk** | **POL-09:** rolling 12-month sales horizon; open-ended reservations remain guaranteed as it rolls. | Buyers can keep capacity without repeatedly rebooking; Share carries continuing capacity, price, and credit exposure. | A fixed expiry protects planning but breaks the buyer promise. An unlimited horizon makes supplier commitments and forecasting unsafe. | Product, network planning, commercial, treasury, and supplier contracts must define the commitment Share is willing to make. |
| **Supply guarantee versus marketplace cost** | **POL-07 / POL-08:** do not silently revoke sold capacity; stop new sales on loss of supply and offer/settle remedies under defined rules. | Share may pay more for an equivalent path or bear cancellation and SLA-credit cost. | Buyers are protected from a reservation becoming an option. Putting all change risk on suppliers may reduce participation; putting it on buyers undermines the guarantee. | Commercial, legal, finance, supplier operations, and product must agree contractual remedies and financial limits. |
| **Conversion versus credit loss** | **POL-14–POL-16:** hold bounded coverage for standard accounts and offer vetted accounts credit limits. | Strict holds create payment friction; credit limits create bounded but real bad-debt exposure. | Metering and enforcement are delayed, so zero exposure is impossible without a stronger prepaid policy. | Finance, risk, product, and payments operations must set loss appetite, underwriting, grace periods, and suspension behavior. |
| **Supplier fairness versus monotonic correction behavior** | **POL-11 / POL-12:** micros are indivisible. The later policy register chooses Webster; the POC uses D'Hondt after rejecting largest remainder. | The selected rounding method determines which suppliers gain or lose a micro-unit at particular totals and which corrections appear in the append-only ledger. | Largest remainder is unsuitable if the business rejects the Alabama paradox. D'Hondt prevents a supplier losing allocation as the total rises but favors larger weights. Webster is generally less biased toward larger weights, but its correction consequences must be accepted as policy, not called a technical defect. | Finance, commercial, legal, and suppliers must publish the fairness objective, test representative splits, and make policy and implementation agree before money moves. |
| **Supplier liquidity versus correction finality** | **POL-22 / POL-23:** pay weekly after confirmation; net specified later corrections against future earnings. | Faster payouts improve supplier cash flow but can create supplier debt or force Share to absorb corrections. | Immediate irreversibility puts all measurement and supply-change risk on Share; long dispute windows withhold supplier liquidity. | Finance, legal, and supplier operations must set payout timing, reserves, dispute windows, and recovery rights. |
| **Marketplace breadth versus booking certainty** | **POL-28:** prefer partners with expiring holds; book a partner without usable holds last and limit such legs. | More potential supply comes with slower completion, reconciliation, orphan-booking, and cancellation cost. | Excluding weak integrations limits liquidity; treating them as fully atomic creates a promise the system cannot keep. | Partner strategy, operations, finance, and product must define integration tiers and which products each can support. |
| **Availability promise versus launch and operating cost** | **POL-06:** high availability, RPO 0, explicit recovery objectives, and diverse-path assumptions. | More regions, replication, probes, failover exercises, and operating cost are required. | A weaker target may be tolerable for reporting but not for inventory or funds. A percentage target without a funded topology is not a product promise. | Founders, SRE, finance, and network operations must fund the topology and define permissible degradation by capability. |
| **Auditability versus privacy** | **POL-19 / POL-33:** keep bitemporal operational history; pseudonymise principals; separate erasable personal data; constrain supplier visibility. | More schemas, access controls, retention jobs, and compliance operations. | Retaining everything improves dispute handling but conflicts with erasure; aggressive deletion weakens audit evidence. | Legal/privacy, compliance, security, support, and product must define jurisdictions, controller roles, retention, and disclosure rules. |

## What the POC can settle

The POC can rule out a mechanism against a chosen policy: for example, unlocked
admission oversells under concurrency, and largest-remainder allocation has the Alabama
paradox. It can measure local latency and test idempotency, recovery, and ledger
invariants.

It cannot determine whether buyers accept pending bookings, suppliers accept a rounding
or recovery rule, Share can fund credit losses, a partner can contractually provide a
hold, or the company will pay for a given availability topology. Those require an
explicit policy owner, evidence, a provisional parameter, and a ratification condition.
