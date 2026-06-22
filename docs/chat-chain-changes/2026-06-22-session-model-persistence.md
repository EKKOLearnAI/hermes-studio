---
date: 2026-06-22
pr: pending
feature: Session-scoped model selection
impact: Model picker changes on an existing chat now persist to that session instead of overwriting the global default, non-coding chat runs send the session model/provider on every turn so bridge state cannot drift after reloads or mid-session model changes, sidebar rows show each session's model, and model switching now shows a disabled/loading state while persistence is in flight.
---
