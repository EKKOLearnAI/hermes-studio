---
date: 2026-07-14
pr: 2073
feature: Hermes API mode ownership
impact: Workflow Hermes runs use the API mode resolved by their provider profile, while coding-agent workflow nodes keep their explicit protocol selection.
---

Workflow execution no longer forwards node `apiMode` values through the Hermes
Agent Bridge. The TypeScript and Python bridge protocol stays provider/profile
driven, and reasoning-effort parse failures retain the existing fallback to the
profile default.
