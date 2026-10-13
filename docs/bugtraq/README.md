# BUGTRAQ: defects in third-party code

This register records defects in libraries and tools that this repository uses. Each
record gives the defect, the upstream report, the local workaround and the removal
condition. Remove a workaround only when its removal condition is true.

| ID | Component | Summary | Upstream | Local state |
|---|---|---|---|---|
| [BT-001](BT-001-kafkajs-negative-timeout.md) | kafkajs 2.2.4 | Negative `setTimeout` delay causes a 1 ms timer loop on each idle connection | [tulios/kafkajs#1751](https://github.com/tulios/kafkajs/issues/1751), [#1556](https://github.com/tulios/kafkajs/issues/1556) | Workaround retired: runtime moved to `@platformatic/kafka` (E-001), 2026-10-13. `billing/` still has the defect |
