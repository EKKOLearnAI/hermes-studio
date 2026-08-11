---
date: 2026-08-10
pr: pending
feature: Safe queued-message insertion for Hermes, Ekko, and Global Agent
impact: Users can promote a queued message with an explicit arrow and stop the active Hermes or Ekko turn at a runtime-owned safe boundary; queue order and insertion phase stay authoritative across multiple pages and Global Agent transport.
---

Ordinary sends retain the existing FIFO behavior. The first insertion click for
an active run is generation- and run-ID-fenced, while rapid additional clicks
reuse the pending request. The selected queue item is promoted server-side and
starts as a normal user turn after the old run terminalizes. Explicit hard stop
still cancels immediately, and Claude Code and Codex remain unchanged.
Empty `run.completed` and Bridge-shaped `run.failed` terminal payloads are
suppressed as provider errors only when the server explicitly tags them as
`interrupted` with `stop_reason=queue_insertion`; ordinary empty model
completions and untagged failures continue to surface the existing errors.
