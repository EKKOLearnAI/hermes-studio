---
date: 2026-07-04
pr: 1931
commit: b22c37e3
feature: Studio agent bridge default headers
impact: Hermes Studio bridge workers now merge `model.default_headers` into OpenAI client creation so custom OpenAI-compatible providers can override SDK headers such as `User-Agent` during chat runs.
---
