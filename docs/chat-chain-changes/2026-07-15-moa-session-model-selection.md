---
date: 2026-07-15
pr: pending
feature: MoA session model selection
impact: Hermes chat creation and live session model switching can select profile-scoped MoA presets through the native virtual provider, while Coding Agents remain limited to supported providers and context compression follows the preset aggregator window.
---

Enabled MoA presets are exposed as `provider: moa` models without introducing new session fields. The configured global MoA default preset is offered first, and context-length lookup resolves the selected preset to its aggregator so chat context indicators, snapshot recovery, and compression thresholds use the acting model's window. The chat input hides its per-session reasoning-effort control while MoA is active because the virtual runtime does not apply that override to the preset's reference or aggregator calls.
