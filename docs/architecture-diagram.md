# Architecture diagram

Source: RFC-000 revision 4.5 §2 (components) and §8 (contracts), and the frozen contracts
C01 … C13 in [`04-delivery/contracts/`](04-delivery/contracts/). Each edge label names the
contract that governs that interface. Colours show the slice that owns each component.

## 1. Components and their contracts

```mermaid
flowchart LR
  %% ---------- external parties ----------
  subgraph EXT["External parties"]
    direction TB
    BUY["Buyers and AI agents"]
    EXP["Suppliers' flow exporters"]
    PRT["Partner networks"]
    PAY["Payment and payout providers"]
    PROV["Provisioning"]
    RTG["Routing<br/>(equivalent paths)"]
    OPS["Share operators"]
  end

  %% ---------- edge ----------
  subgraph EDGE["Edge (S-SEC)"]
    GW["Edge gateway<br/>auth, principal, rate limits"]
    BAPI["Booking API"]
    CON["Operator console<br/>and approvals"]
  end

  %% ---------- booking and admission ----------
  subgraph ACCT["Booking and admission (S-ACCT + S-MONEY Part A)"]
    AO["Account owner<br/>booking, decision point"]
    FUN["Funds and standing<br/>(in-process module)"]
    PAD["Partner adapters"]
  end

  %% ---------- links ----------
  subgraph LINK["Link capacity (S-LINK)"]
    LSO["Link schedule owner"]
    REG["Link registry"]
  end

  %% ---------- metering and rating ----------
  subgraph RATE["Metering and rating (S-RATE)"]
    ING["Metering ingestion"]
    ATT["Attribution and quarantine<br/>(stage A, stage B)"]
    RAT["Rating"]
    CAT["Catalogue<br/>prices, routes, weights"]
  end

  %% ---------- money ----------
  subgraph MONEY["Money (S-MONEY Part B)"]
    SET["Settlement"]
    LED["Ledger"]
    REC["Payments, receivables<br/>and reconciliation"]
    POUT["Payouts"]
    RPT["Reporting and statements"]
  end

  %% ---------- security ----------
  subgraph SEC["Identity and audit (S-SEC)"]
    IAM["Identity and access<br/>keys, roles, consent"]
    AUD["Audit"]
    PDS["Personal-data store"]
  end

  %% ---------- platform services ----------
  subgraph PLAT["Platform services (S-PLAT)"]
    NOT["Notifier<br/>webhooks, notices"]
    PRB["Probes"]
    STR["Status replicas"]
    HIS["History"]
  end

  %% ===== external → edge =====
  BUY -- "HTTPS (C10)" --> GW
  GW --> BAPI
  BAPI -- "book, change, quote, status (C10)" --> AO
  BAPI -- "status reads (C01)" --> STR
  OPS --> CON
  EXP -- "flow records, gRPC mTLS (C11)" --> ING
  PROV -- "attribution bindings (C11)" --> ATT
  RTG -- "catalogue routes (C12)" --> AO
  PRB -- "probe bookings as probe accounts" --> GW

  %% ===== booking and links =====
  AO --- FUN
  AO -- "hold, convert, release, offers (C02)" --> LSO
  LSO -- "grants, displacement, cut targets (C02)" --> AO
  AO -- "hold, confirm, cancel, amend (C12)" --> PAD
  PAD -- "partner APIs" --> PRT
  CON -- "supply commands (C03)" --> LSO
  CON -- "register, retire (C13)" --> REG
  REG -- "registry feed (C13)" --> LSO
  REG -- "registry feed (C13)" --> RAT
  LSO -- "schedule feed, CLOSED markers (C03)" --> RAT
  LSO -- "schedule feed (C03)" --> AO

  %% ===== reservation feeds =====
  AO -- "outcome and lifecycle feeds (C04)" --> RAT
  AO -- "outcome feed (C04)" --> NOT
  AO -- "lifecycle feed (C04)" --> RPT

  %% ===== metering and rating =====
  ING -- "hand-off (C11)" --> ATT
  ATT --> RAT
  CAT -- "catalogue.v1 (C06)" --> RAT
  CAT -- "prices, terms (C06)" --> AO
  RAT -- "unposted usage (C06)" --> AO
  AO -- "usage applied (C06)" --> RAT
  RAT -- "charge lines (C06)" --> SET

  %% ===== money =====
  SET -- "posting port (C06)" --> LED
  LED -- "movement feed (C06)" --> AO
  LED -- "movement feed (C06)" --> RPT
  PAY -- "payment notifications (C07)" --> REC
  REC --> LED
  REC -- "invoice status (C07)" --> AO
  CON -- "credit limits, four eyes (C07)" --> AO
  POUT --> LED
  POUT -- "payout instructions (C07)" --> PAY
  POUT -- "payout destination query (C07/C16)" --> IAM

  %% ===== identity, audit, personal data =====
  IAM -- "identity push, catch-up (C08)" --> GW
  IAM -- "identity push, catch-up (C08)" --> AO
  IAM -- "identity push (C08)" --> LSO
  CON -- "operator envelope, operator check (C08)" --> IAM
  AO -- "audit append (C08)" --> AUD
  LSO -- "audit append (C08)" --> AUD
  LED -- "audit append (C08)" --> AUD
  IAM -- "put, get, erase (C09)" --> PDS
  ING -- "put_payload, withdraw (C09)" --> PDS
  NOT -- "signed webhooks (C08)" --> BUY

  %% ===== history =====
  AO -.-> HIS
  LSO -.-> HIS
  LED -.-> HIS

  classDef ext fill:#eeeeee,stroke:#888,color:#222
  classDef sec fill:#fde2e2,stroke:#c0392b,color:#222
  classDef acct fill:#e3f0fb,stroke:#2e86c1,color:#222
  classDef link fill:#e6f5e6,stroke:#27ae60,color:#222
  classDef rate fill:#fff3d6,stroke:#d68910,color:#222
  classDef money fill:#efe3fb,stroke:#8e44ad,color:#222
  classDef plat fill:#e8eaed,stroke:#5d6d7e,color:#222
  class BUY,EXP,PRT,PAY,PROV,RTG,OPS ext
  class GW,BAPI,CON,IAM,AUD,PDS sec
  class AO,FUN,PAD acct
  class LSO,REG link
  class ING,ATT,RAT,CAT rate
  class SET,LED,REC,POUT,RPT money
  class NOT,PRB,STR,HIS plat
```

## 2. The platform every owner runs on (C01)

Each owner kind in diagram 1 (account, link schedule, link registry, ingestion,
attribution, rating, catalogue, ledger, settlement, identity, audit) runs on the owner
runtime. No owner reads another owner's tables. Owners meet only through the contracts.

```mermaid
flowchart TB
  subgraph OWN["Owner processes (NestJS, one per owner kind)"]
    RT["Owner runtime @share/owner-runtime<br/>slots, leases, batch transaction with decide(ctx)"]
  end

  subgraph DB["CockroachDB (2 + 2 + 1 regions)"]
    TBL["Per-kind log, head, projection, outbox<br/>owner_session, owner_slot"]
  end

  subgraph BUS["Kafka"]
    TOP["Feed topics, notification topics,<br/>closure topics, alert topics"]
  end

  PLC["Placement<br/>slot map, moves, splitting, integrity stops"]
  REL["Outbox relay<br/>(changefeed per outbox)"]
  CLO["Closure emitter<br/>CLOSED and resolved markers"]
  STR2["Status replicas<br/>read leases, report markers"]
  CRT["Consumer runtime<br/>ordered, gap fill, dedupe"]
  ALR["Alert service"]
  HIS2["History, backups, restore"]
  HSM["Key service / HSM<br/>sealer, signing keys"]

  RT -- "one batch transaction per slot" --> TBL
  RT -- "direct publish after commit" --> TOP
  TBL -- "changefeed" --> REL
  REL --> TOP
  CLO -- "R_min over partitions" --> TOP
  PLC -- "placement.slot_map.v1" --> TOP
  PLC -- "slot leases, stops_version" --> TBL
  TOP --> CRT
  CRT --> RT
  STR2 -- "follower reads" --> TBL
  RT -- "report position" --> STR2
  TOP --> ALR
  TBL --> HIS2
  RT -- "seal, chain" --> HSM
```

## Contract index

| Contract | Interface |
|---|---|
| C01 | Platform: owner runtime, slot map, history, probes, alerts, column encryption |
| C02 | Link hold port: hold, convert, release, waiting, offers, cut targets |
| C03 | Link supply commands and schedule feed |
| C04 | Reservation outcome and lifecycle feeds |
| C05 | Funds and standing (in-process, inside the account owner) |
| C06 | Catalogue, usage, charge lines, posting, movements |
| C07 | Receivables, credit limits, payments, payouts, payout destination |
| C08 | Identity and access: principal context, push, operator check, audit, webhooks |
| C09 | Personal-data store |
| C10 | Booking API |
| C11 | Metering ingress |
| C12 | Partner port and equivalent paths |
| C13 | Link registry |
