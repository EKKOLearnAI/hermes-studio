---
date: 2026-08-25
pr: 2728
feature: Hide global Coding Agent reasoning effort
impact: Global Coding Agent chats no longer show a per-session reasoning effort control that the runtime intentionally ignores.
---

The single-chat composer continues to expose reasoning effort for Hermes,
Ekko, and scoped Coding Agent sessions. Global Codex, Claude, and Pi sessions
inherit their native CLI configuration, so the ineffective session-level
selector is now hidden.
