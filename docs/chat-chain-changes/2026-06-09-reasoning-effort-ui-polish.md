---
date: 2026-06-09
pr: TBD
commit: pending
feature: Per-session reasoning effort selector UI polish
impact: Keeps the existing per-session reasoning effort override for Hermes CLI chats, hides the selector for Coding Agent sessions, and prevents Coding Agent run payloads from carrying the unsupported reasoning_effort override.
---

This change adds focused ChatInput coverage for selecting a reasoning effort
option and for hiding the selector in Coding Agent sessions. It also keeps the
Coding Agent run payload explicit by omitting reasoning_effort until those
runners support the setting.
