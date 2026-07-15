---
date: 2026-06-15
pr: pending
feature: MCP model-run authentication
impact: Bridge and coding-agent runs now add a one-hour user JWT to run instructions for MCP/Web UI calls, scoped Claude/Codex launches include the bundled Hermes MCP server, Codex receives Hermes media/file instructions per run instead of through AGENTS.md, and LAN MCP device endpoints require super admin JWT authorization instead of accepting the long-lived server .token.
---

Authenticated bridge runs include the current Hermes profile and a short-lived
model-run token in run instructions so MCP tools can pass them as arguments.
Scoped Claude Code and Codex launches include the bundled Hermes MCP server in
their generated config, and coding-agent inputs receive the same per-run
Hermes system prompt plus per-run profile/token prompt before being sent to
the agent. Claude Code receives the Hermes media/file prompt on every run via
`--append-system-prompt`. Codex receives the Hermes media/file prompt and the
dynamic profile/token prompt through the `developer_instructions` config on
each run, so the user prompt stays as the user's original input. Web UI no
longer writes managed Codex `AGENTS.md` prompt blocks. Authenticated Codex
runs also receive Codex-specific developer instructions that Hermes LAN
discovery is exposed as MCP tools rather than MCP resources/templates, naming
`mcp__hermes-studio-devices__hermes_studio_lan_devices_scan` and
`mcp__hermes-studio-devices__hermes_studio_lan_devices_list` as the tools to call with the
current `profile` and `token`. Managed Claude Code
`CLAUDE.md` blocks preserve existing user content and replace only the marked
Hermes Web UI prompt block. This keeps media, image, video, file, and
absolute-path response formatting consistent without storing the injected prompt
as the Web UI user message.
LAN device MCP routes no longer accept the server `.token` fallback, the bundled
MCP tools no longer read `.token` for LAN tool calls, and those routes are
protected by super-admin authorization.
