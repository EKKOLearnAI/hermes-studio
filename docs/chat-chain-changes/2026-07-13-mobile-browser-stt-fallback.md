---
date: 2026-07-13
pr: pending
feature: Mobile browser STT compatibility and fallback
impact: Realtime voice uses restart-based browser recognition on mobile-compatible settings and falls back to the currently active configured backend STT only for browser network failures.
---

Realtime voice now supplies a valid document or device language when no speech
language is configured and uses short recognition sessions that restart while
the user is still listening. If browser recognition reports a network error,
the audio captured for that turn is sent to the currently active OpenAI,
custom, or Doubao STT connection when that connection has a stored secret.

The fallback provider is never hard-coded and inactive saved providers are not
selected implicitly. When the active provider is browser-only or its backend
configuration is incomplete, realtime voice stops and displays an explicit
error instead of uploading audio or silently changing providers.
