---
date: 2026-06-13
pr: 1528
feature: Claude and Gemini OAuth providers
impact: Chat model resolution maps the new Claude OAuth provider to the Hermes Agent Anthropic runtime provider, while scoped coding-agent launches continue to require API-key providers.
---

Claude OAuth is exposed as a separate `claude-oauth` provider for Web UI selection and stored credentials. Bridge chat runs normalize it to `anthropic` so existing Hermes Agent provider handling remains compatible.

