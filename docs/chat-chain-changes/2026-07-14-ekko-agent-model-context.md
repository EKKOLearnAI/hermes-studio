---
date: 2026-07-14
pr: 2071
feature: Ekko Agent provider and model context
impact: Ekko Agent system prompts now identify the provider and model used by the current run.
---

The Ekko Agent runtime resolves the active provider from the per-run model client
and the active model from run-level model settings, then includes both values in
the system prompt's `Runtime Context` section alongside workspace paths.
