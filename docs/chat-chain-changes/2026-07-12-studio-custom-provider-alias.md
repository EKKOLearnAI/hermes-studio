---
date: 2026-07-12
pr: 2054
commit: 7d0740d0
feature: Studio custom-provider model selection
impact: Prevents a custom provider alias from triggering a redundant client rebuild that drops configured default headers and causes WAF 403 responses.
---

# Studio custom-provider alias client rebuild

Hermes Studio sends the visible provider selector (for example `custom:liuzheng`) on chat runs, while Hermes Agent normalizes the active runtime provider to `custom`.

The bridge previously stored only the normalized provider in the session. On the next request, `custom:liuzheng != custom` was treated as a runtime change, so the bridge called `AIAgent.switch_model()` even when the model, endpoint, and transport were unchanged.

Affected Hermes runtimes reconstruct `_client_kwargs` during `switch_model()` without reapplying `model.default_headers`. The subsequent request therefore reverted to the OpenAI SDK User-Agent and could be rejected by WAF-sensitive custom endpoints.

The bridge now:

- preserves the requested provider selector in session metadata;
- compares the resolved runtime model/provider/base URL/API mode before rebuilding;
- skips `switch_model()` when the effective runtime is unchanged.

A regression test covers the `custom:liuzheng` → normalized `custom` alias case.
