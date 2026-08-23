---
date: 2026-08-23
pr: 2706
feature: GLM-5.3 reasoning effort compatibility
impact: Main chats and delegated subagents map reasoning to GLM-5.3's low/high/max contract without stale session refreshes restoring medium.
---

The Agent Bridge also emits the mapped top-level `reasoning_effort` override
for OpenAI-compatible custom and Volcengine routes, while preserving the
existing reasoning behavior of other models.
