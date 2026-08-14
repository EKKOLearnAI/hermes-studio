---
date: 2026-08-13
pr: pending
feature: Pi Coding Agent integration
impact: Hermes Studio can manage and run Pi in RPC mode with scoped provider routing and four lazy Studio MCP servers through pi-mcp-adapter.
---

# Pi Coding Agent integration

- Adds Pi as a managed Coding Agent backed by `@earendil-works/pi-coding-agent` RPC mode.
- Installs and pins `pi-mcp-adapter@2.24.0` in the Hermes Web UI managed home.
- Generates per-run Pi `settings.json`, `models.json`, `mcp.json`, `APPEND_SYSTEM.md`, and session storage.
- Exposes the four Hermes Studio MCP stdio servers lazily through the adapter proxy instead of registering every server tool in Pi's system prompt.
- Uses the existing short-lived scoped provider proxy and model-run token flow.
- Streams strict LF-framed Pi JSONL events into the existing canonical chat event pipeline and completes on `agent_settled`.

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
- Studio RPC chat accepts non-interactive extension notifications (`notify`, status, widget, and title updates).
- Interactive RPC requests such as confirmation, input, and selection are fail-closed: confirmations are rejected and other requests are cancelled. A future Web UI protocol may add explicit two-way rendering; this release does not silently approve extension actions.
