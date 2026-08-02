---
date: 2026-08-03
pr: 2226
commit: exact committed HEAD recorded by Git after this fragment is staged
feature: Group Chat Bridge/UI independent review blockers
impact: Makes relay cancellation chain-scoped, preserves strict same-target FIFO through retry backoff, binds context estimation and chat to the same isolated worker and managed MCP capability, and clears stale activity/approval UI state across disconnect, reconnect, polling, and terminal access denial.
---

- Stopping one relay chain durably fences and interrupts only that chain’s active runtime, leaving concurrent chains for the same participant intact.
- Durable claim ordering considers the oldest pending same-target job before availability, so a newer ready job cannot overtake an older backed-off job.
- Group Chat context estimates and chat runs carry the same worker key and required managed MCP capability.
- Reconnect and polling reconciliation fail closed for transient activity, and terminal approval denial removes stale approval cards.
