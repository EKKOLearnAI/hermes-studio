---
date: 2026-07-20
pr: pending
feature: Clean Ekko context compression
impact: Context summaries use a fresh tool-free, skill-free, memory-free Ekko Agent first and immediately fall back to the existing Hermes compression run when that call fails.
---

The Ekko summarizer is limited to one non-streaming model step with model
retries disabled. It resolves the selected compression model from the source
profile without reusing the global Ekko runtime, MCP registry, skills, memory,
or session context. The Hermes fallback preserves the existing temporary
compression session and dedicated worker-key behavior.
