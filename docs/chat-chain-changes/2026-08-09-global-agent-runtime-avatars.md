---
date: 2026-08-09
pr: 2442
feature: Accurate Global Agent runtime avatars
impact: Global Agent sessions show their actual Hermes or Ekko runtime, while MCU device pages omit the inactive battery row.
---

The session list and empty chat state now resolve the Agent logo from the
persisted `agent` and `codingAgentId` metadata. Ekko Global Agent sessions show
the Ekko logo; Hermes sessions and older Global Agent sessions without Ekko
metadata show the Hermes logo.

The ESP32-C3 v1 and v2 device pages no longer render the hard-coded
`电量 / 未启用` status row. Existing battery measurement and reporting behavior
is unchanged.
