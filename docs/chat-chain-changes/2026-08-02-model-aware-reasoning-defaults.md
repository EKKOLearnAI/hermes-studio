---
date: 2026-08-02
pr: pending
feature: Model-aware Agent Bridge reasoning defaults
impact: Fresh Studio agents now inherit Hermes per-model reasoning overrides before the global reasoning effort.
---

Explicit per-run reasoning effort remains the highest-priority override and is
restored to the model-aware constructor default after the run.
