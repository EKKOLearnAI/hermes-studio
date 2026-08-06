---
date: 2026-08-06
pr: 2395
feature: Ekko Agent native reasoning replay
impact: Ekko Agent preserves provider-native reasoning across tool turns and selects the replay shape from the request protocol plus the OpenAI Chat provider/model dialect.
---

Reasoning text, native replay data, and token estimates now share one internal
representation. OpenAI Responses, Anthropic Messages, and Gemini Contents
replay their native reasoning items, thinking blocks, or content parts.

Within the OpenAI Chat Completions adapter, OpenRouter replays
`reasoning_details`; DeepSeek, Kimi, MiMo, Qwen, and GLM-family Chat endpoints
replay `reasoning_content`; other compatible endpoints use `reasoning` unless
the provider configuration explicitly overrides or disables the replay field.
