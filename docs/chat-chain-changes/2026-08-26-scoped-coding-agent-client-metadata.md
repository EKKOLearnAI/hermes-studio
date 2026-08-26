---
date: 2026-08-26
pr: 2736
feature: Scoped coding-agent client metadata forwarding
impact: Scoped Claude Code and Codex sessions can explicitly opt in to forwarding a strict allowlist of genuine client metadata while Hermes retains Provider API-key authentication.
---

# Scoped coding-agent client metadata forwarding

The Provider default and scoped-session override control whether a Claude Code
or Codex proxy route retains its permitted inbound client metadata. The feature
is disabled by default. Claude Code forwarding applies only to
`anthropic_messages`; Codex forwarding applies only to `codex_responses`.

Only the documented identity allowlists are forwarded. Local route credentials,
Provider-independent client secrets, cookies, host and connection headers, and
arbitrary headers never leave Hermes. Codex and Pi targets use separate proxy
route keys and tokens, so a shared Provider/model/session configuration cannot
cause Pi traffic to inherit Codex metadata.
