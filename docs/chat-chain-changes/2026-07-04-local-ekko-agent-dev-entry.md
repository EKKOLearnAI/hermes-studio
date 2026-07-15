---
date: 2026-07-04
pr: pending
feature: Ekko Agent dev entry and runtime request handling
impact: Ekko Agent remains development-only in the new-chat selector, streams model output when providers support it, uses inferred provider protocol unless an explicit protocol is passed, retries protocol fallback only for protocol-shaped HTTP errors, emits reasoning deltas when providers return thinking content, reports tool durations, paces tool calls, stops after repeated tool failures, honors frontend abort requests, and retries each model loop step up to three times before failing the run.
---

Development builds now expose the Ekko Agent option in the new-chat selector so
local testing can exercise the dedicated Ekko Agent runtime path. Production
builds continue to hide the selector entry and keep existing Hermes, workflow,
Group Chat, Claude Code, and Codex behavior unchanged.

Ekko Agent no longer shows the scoped protocol picker in the frontend. Existing
explicit protocol values are still honored when sent to the server, but a
protocol-shaped provider error can fall back once to the URL/provider-inferred
protocol. Ekko Agent also retries each model request in the agent loop up to
three times before failing the run.

Provider reasoning/thinking content is normalized into Ekko Agent model
responses and emitted through the existing `reasoning.delta` chat event, so the
client can display it with the same reasoning UI used by the existing chat
chain.

Tool execution now has a default delay between tool results and the next
runtime action, plus a consecutive-failure guard. The terminal tool also
normalizes simple shell-like command strings into command plus args so accidental
`command: "ls skills"` style calls do not immediately become `ENOENT` loops.

Frontend stop requests now abort the Ekko Agent session controller, propagate the
signal through runtime model requests and tools, and terminate terminal commands
that are still running.

Model text deltas are forwarded through the existing `message.delta` event when
the provider supports streaming. Tool completion and failure events include
runtime duration so the client can show elapsed tool time.
