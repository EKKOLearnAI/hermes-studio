---
date: 2026-08-10
pr: pending
feature: Configurable Group Chat compression timeout
impact: Group Chat rolling summaries retain their five-minute Ekko model budget by default and deployments can safely override it without changing Agent turn limits.
---

The production `GroupRoomSummaryService` now reads
`HERMES_GROUP_CHAT_COMPRESSION_TIMEOUT_MS` for its isolated Ekko summary model
request. The default remains 300000ms, matching the existing behavior. Values
below 5000ms, above 1800000ms, or otherwise invalid fall back to the default so
misconfiguration cannot create immediate failures or unbounded summary runs.

This setting controls only Group Chat rolling-summary compression. It does not
add or change an absolute deadline for Hermes, Ekko, Codex, or Claude Agent
turns, and it is separate from Agent Bridge per-request timeouts.
