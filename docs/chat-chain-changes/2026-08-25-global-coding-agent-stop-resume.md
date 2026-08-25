---
date: 2026-08-25
pr: 2735
feature: Global Coding Agent stop and resume continuity
impact: Stopping a global Claude, Codex, or Pi run and then continuing the same Studio chat now resumes its stored native agent session instead of starting a context-free thread.
---

Global Coding Agent sessions use the CLI's own provider and model configuration,
so continuation compatibility is determined by the stored agent type and global
mode. Scoped sessions continue to require matching provider, model, and API
protocol before their native session is resumed.
