---
date: 2026-08-02
pr: 2325
feature: Model-aware Agent Bridge reasoning defaults
impact: Fresh and successfully model-switched Studio agents now inherit Hermes per-model reasoning overrides before the global reasoning effort.
---

Explicit per-run reasoning effort remains the highest-priority override and is
restored to the current model-aware default after the run.
