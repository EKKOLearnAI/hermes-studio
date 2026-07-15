---
date: 2026-06-13
pr: 1528
feature: Claude and Gemini OAuth providers
impact: Chat model resolution maps the new Claude OAuth provider to the Hermes Agent Anthropic runtime provider, while scoped coding-agent launches continue to require API-key providers.
superseded_by: 2026-07-13-remove-gemini-oauth.md
---

Claude OAuth is exposed as a separate `claude-oauth` provider for Web UI selection and stored credentials. Bridge chat runs normalize it to `anthropic` so existing Hermes Agent provider handling remains compatible.

The Gemini OAuth portion of this historical change was removed on 2026-07-13
after Hermes Agent removed the corresponding inference provider. Claude OAuth
remains supported.
