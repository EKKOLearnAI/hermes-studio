---
date: 2026-07-11
pr: pending
feature: Unified local session usage recording
impact: Hermes Bridge, Coding Agent, Ekko Agent, Group Chat, and context-engine runs persist per-run token usage through one normalized session_usage recorder without changing the usage dashboard data source.
---

Provider-reported usage is preferred. Scoped Coding Agents record one exact row per model call observed by the local proxy, including provider-reported cache usage, and skip the Claude/Codex turn aggregate to avoid double counting. Global Coding Agents only persist complete CLI-reported usage and do not estimate missing token fields.

All stored token buckets are mutually exclusive. OpenAI Chat and Responses input totals have cache reads/writes subtracted before persistence, while Anthropic input and cache buckets are kept as reported because that API already separates them.

Ekko Agent normalizes its runtime so every successful model API response emits exactly one `model.usage` event. The Web UI persists those events as `model_call` rows, including available cache and reasoning tokens, and does not persist the turn-level aggregate or local fallback estimate.

Hermes Bridge registers an internal observer on Hermes Agent's existing `post_api_request` hook. Every successful API response with complete provider usage becomes one replay-safe `model.usage` event and one `model_call` row. Terminal run totals and local token estimates are not persisted, so tool loops and resumed bridge runs do not double count model calls.

The usage dashboard treats the local ledger as authoritative per session. It aggregates all matching `session_usage` rows, then adds only Hermes `state.db` sessions whose IDs do not exist in the local ledger. This preserves Hermes-only usage without double counting sessions. Model and agent breakdowns use the same merged data; unmatched `state.db` rows, including Group Chat and Context Engine `api_server` sessions, are attributed to Hermes Agent, while Coding Agent usage is split into Claude Code and Codex. Deleting chat or workflow history does not delete ledger rows, so historical usage remains stable.
