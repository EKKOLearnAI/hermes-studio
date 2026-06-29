---
date: 2026-06-29
pr: 1839
feature: Chat context usage cache-read accounting
impact: Chat context usage now includes cache-read tokens from session summaries when no explicit context token total is available.
---

The chat input context meter displays at least `input + cache_read + output`, while still honoring larger explicit `contextTokens` values, so prompt-cached sessions do not under-report visible context usage.
