---
date: 2026-08-02
pr: pending
feature: MCU Global Agent Ekko runtime
impact: MCU voice turns use Ekko Agent while retaining Global Agent session classification and deterministic device sessions.
---

Both MCU chat entry paths dispatch `/chat-run` requests through the
`ekko-agent` runtime. They use `source=coding_agent` for runtime selection and
`session_source=global_agent` for session persistence and filtering. Stale
Hermes metadata is normalized when an existing MCU session next runs.

Existing deterministic MCU sessions keep their history and workspace. On the
first Ekko turn, stale Hermes or coding-agent metadata is migrated to
`agent=ekko-agent` while the stored source remains `global_agent`. MCU relay,
STT/TTS, interruption, session clear, and background-response delivery retain
their existing behavior.

MCU tool events now carry status metadata only: event type, interaction ID,
tool name, and a generic failure marker when needed. Tool arguments, result
previews, and error details stay on the server and are never forwarded to the
device. This prevents large Ekko tool results from exceeding the firmware's
WebSocket frame limit. Tool boundaries also reset the MCU speech accumulator
so an Ekko final response delivered only by `run.completed.output` is still
synthesized and played. No firmware changes are required.

MCU turns also attach voice-specific system instructions to Ekko. User-facing
responses must be brief, natural spoken plain text without Markdown. Work that
can safely run asynchronously should use Ekko's `delegate_task` tool in
background mode so the parent can acknowledge quickly instead of making the
user wait. The same instructions are retained for autonomous continuation runs
that deliver completed background results.
