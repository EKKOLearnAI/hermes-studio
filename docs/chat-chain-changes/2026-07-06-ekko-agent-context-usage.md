---
date: 2026-07-06
pr: pending
commit: pending
feature: Ekko Agent context usage and tool history
impact: Ekko-agent runs no longer publish per-step request context estimates as formal usage updates, and follow-up turns now include paired tool results in model history.
---

Ekko-agent runtime `context.estimated` events remain available as estimate-only
chat events for debugging and future UI detail surfaces, but they no longer
overwrite the session's formal `contextTokens` through `usage.updated`.

The final run completion path now applies the latest context estimate to session
state and emits the single official `usage.updated` event, matching the steadier
Hermes Agent Bridge context-meter behavior.

Ekko-agent history projection now restores assistant tool-call messages together
with matching `tool_call_id` result rows. Orphan tool rows are still skipped so
providers do not receive invalid unpaired tool results, but follow-up turns can
see browser/file/search results produced earlier in the conversation.
