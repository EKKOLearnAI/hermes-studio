---
date: 2026-08-13
pr: 2528
feature: Pi Coding Agent integration
impact: Hermes Studio can manage and run Pi in RPC mode with scoped provider routing and four lazy Studio MCP servers through pi-mcp-adapter.
---

# Pi Coding Agent integration

- Adds Pi as a managed Coding Agent backed by `@earendil-works/pi-coding-agent` RPC mode.
- Installs and pins `pi-mcp-adapter@2.24.0` in the Hermes Web UI managed home.
- Generates per-run Pi `settings.json`, `models.json`, `mcp.json`, `APPEND_SYSTEM.md`, and session storage.
- Exposes the four Hermes Studio MCP stdio servers lazily through the adapter proxy instead of registering every server tool in Pi's system prompt.
- Uses the existing short-lived scoped provider proxy and model-run token flow.
- Streams strict LF-framed Pi JSONL text and thinking deltas into the existing
  canonical chat event pipeline and completes on `agent_settled`.

## Runtime lifecycle

- Studio-managed Pi RPC processes are turn-scoped. After `agent_settled`, Studio closes the child process before publishing the terminal run event and releasing queued work.
- Pi conversation state remains in its isolated session directory and the next turn restores the same native session id, while provider files and proxy routing are prepared again from current configuration.
- Provider credential, base URL, and API-mode changes invalidate matching Coding Agent runtimes without interrupting active turns. Idle runtimes close immediately; active Claude/Codex runtimes close after their current terminal event, and Pi closes after every turn.
- Failed provider updates do not invalidate runtimes, and successful API-key replace/clear operations use the provider editor's actual changed-field names.
- Pi `text_delta` events publish `message.delta` immediately instead of waiting
  for `agent_settled`; the final assistant message is used only to reconcile a
  missing suffix before completion.
- Pi `thinking_delta` events publish `reasoning.delta` immediately. Studio's
  `none` reasoning effort is translated to Pi's `off`, and explicit non-off
  choices opt custom models into Pi thinking when model metadata is unavailable.
- Custom models without catalog metadata remain reasoning- and image-capable at
  the Studio boundary; the upstream Provider remains authoritative if a mode is
  actually unsupported.

## Server service boundaries

- Coding Agent server code lives under `services/coding-agents/`.
- `index.ts` is the shared install/config/launch facade.
- Managed lifecycle and canonical event mapping live under `runtime/`.
- Provider transport and protocol adapters live under `shared/`.
- Scoped Coding Agent Provider policy also lives under `shared/`; callers outside
  the package import that boundary instead of defining a parallel allowlist.
- Claude Code, Codex, and Pi implementation details live under
  `claude-code/`, `codex/`, and `pi/` respectively.
- Ordinary chat, group chat, and workflows continue to enter through the same
  chat-run service. Group chat consumes live text/reasoning deltas; workflows
  wait for the same terminal run event.
- Coding Agent realtime events resolve the chat-run server through a stable
  service registry, so moving agent internals cannot silently disconnect
  `message.delta`, `reasoning.delta`, or terminal events from the Web UI.

## Product boundaries

### Launch mode and provider selection

- Pi is scoped-only. The Global option is hidden in Coding Agents and ordinary chat creation.
- Provider filtering, validation, and launch preparation all use the same effective scoped mode.
- Pi uses the same scoped-provider allowlist as the other managed Coding Agents.

### Configuration inheritance

- Stable user configuration lives at the Pi home level and remains credential-free.
- User-defined MCP servers and non-reserved adapter settings are inherited into each runtime.
- Hermes Studio owns and overrides the four managed Studio MCP entries and their lazy/proxy behavior.
- Provider/model credentials, proxy targets, and native session data are isolated under each runtime directory.
- `proxy-target.json` stores the upstream API key with AES-256-GCM encryption. The separate 32-byte key is stored with mode `0600` under the managed Coding Agent home. This protects against accidental file disclosure, backups, and diagnostics that expose only the runtime JSON; it does not protect against an attacker who can read the whole Hermes Studio home or control the server process.
- Legacy plaintext `proxy-target.json` files are migrated to encrypted form when restored.

### Workflow Skills and Memory

- Workflow Skills for Pi are resolved from `~/.agents/skills`.
- Codex-only system skills under `~/.codex/skills/.system` are not exposed to Pi.
- Completed Pi runs export memory through `nmem threads save --from pi` using the isolated Pi config and session directories.

### Interactive extension UI

- Native Pi terminal/TUI sessions retain Pi's full interactive extension UI.
- Studio RPC chat ignores non-interactive extension notifications (`notify`, status, widget, title, and editor-text updates); they are not rendered or persisted.
- Confirmation requests use Studio approvals with explicit `once` and `deny` choices. There is no synthetic session-wide grant.
- Selection, input, and editor requests use Studio clarifications. Selection values must match the options supplied by Pi, and editor prefill is preserved in the response field.
- Unknown interactive methods fail closed by returning a cancelled response. Timed-out and closed requests are removed from pending interaction state.
