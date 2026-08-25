---
date: 2026-08-23
pr: 2708
feature: Revert GLM-5.3 reasoning effort compatibility
impact: Studio restores the reasoning-effort and session-selection behavior from before PR #2706 while those GLM-5.3 changes are withdrawn.
---

This rollback removes the GLM-5.3-specific normalization across Studio chat,
coding-agent adapters, and the Agent Bridge.
