---
date: 2026-06-08
pr: TBD
commit: pending
feature: Per-session reasoning effort override (brain button in chat input toolbar)
impact: Lets the user pick an `agent.reasoning_effort` value per chat session from the UI without editing `config.yaml`. The override is forwarded end-to-end (StartRunRequest → Socket.IO `run` event → `handleBridgeRun` → `bridge.chat()` options → Python bridge `start_chat`/`_run_chat` → `session.agent.reasoning_config`) and restored after each run via `try/finally`, so it never leaks across sessions or turns and does not invalidate the prompt cache.
---

A new `reasoning_effort?: string` field flows through every layer of the chat run chain:

- **Client:**
  - `StartRunRequest` (`packages/client/src/api/hermes/chat.ts`) gains a `reasoning_effort` field.
  - `Session` (`packages/client/src/stores/hermes/chat.ts`) gains an optional `reasoningEffort` property; the store exposes `setSessionReasoningEffort(sessionId, effort)` which persists the choice in `localStorage` keyed by `hermes:reasoning_effort:<sessionId>` and rehydrates it on the next session list refresh via a Pinia `watch`.
  - `sendMessage()` reads `activeSession.reasoningEffort` and forwards it on the `runPayload`.
  - `ChatInput.vue` adds a brain icon between the paperclip and the auto-play switch, opening an `NPopselect` dropdown with the seven supported effort levels (`'' | none | minimal | low | medium | high | xhigh`). All labels are i18n keys under `chat.reasoningEffort.*` in every locale.

- **Server:**
  - `socket.on('run', ...)` (`packages/server/src/services/hermes/run-chat/index.ts`) accepts `reasoning_effort` on the payload and passes it through `handleBridgeRun`.
  - `handleBridgeRun` (`packages/server/src/services/hermes/run-chat/handle-bridge-run.ts`) forwards the value to `bridge.chat(...)` only when non-empty.
  - `AgentBridgeChatOptions` (`packages/server/src/services/hermes/agent-bridge/client.ts`) exposes the new option; the `chat()` method conditionally adds it to the IPC body.
  - `hermes_bridge.py` reads the field on the `chat` action, threads it through `start_chat` and `_run_chat`, and — immediately before `session.agent.run_conversation(...)` — saves the existing `reasoning_config`, parses the override via `parse_reasoning_effort`, mutates the live `AIAgent`, and restores the original value in a `finally` block.

The override is per-run by construction: each turn snapshots and restores `reasoning_config`, so changing the dropdown mid-session affects the *next* turn only and does not require recreating the `AIAgent` (preserving prompt caches and tool registrations). Empty/unrecognized values fall through to the existing `agent.reasoning_effort` config default.
