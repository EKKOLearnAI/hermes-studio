---
date: 2026-07-13
pr: pending
feature: Ekko Agent OAuth provider presets
impact: Ekko Agent sessions can call authorized Nous, OpenAI Codex, xAI, and Qwen providers without exposing stored OAuth tokens to the browser.
---

The Ekko Agent model layer now resolves provider-specific request protocols,
default endpoints, and required identity headers for `nous`, `openai-codex`,
`xai-oauth`, and `qwen-oauth`. New-chat and session model selectors expose
those providers for Ekko Agent while keeping the existing scoped Claude Code
and Codex restrictions. The server resolves the selected profile's current
access token from `auth.json`; the browser never needs to receive it.
The xAI and ChatGPT Codex Responses presets omit unsupported session metadata;
provider string error bodies are surfaced directly for actionable failures.
