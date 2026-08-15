---
date: 2026-08-15
pr: 2475
feature: CLI-style slash commands for Coding Agent sessions
impact: Studio chat now accepts /context, /compact, /usage, and /status for Codex and Claude Code sessions, bridges native compaction, and passes context/auto-compact settings plus lazy MCP tool loading into Studio-launched CLIs.
---

# CLI-style slash commands for Coding Agent sessions

- Adds `/compact` and `/context` to Hermes bridge sessions; `/compact` is an alias of the existing ChatContextCompressor-backed `/compress` path.
- Intercepts `/context`, `/compact`, `/usage`, and `/status` in Coding Agent sessions before input reaches the underlying CLI.
- Claude Code `/compact` runs the native non-interactive compaction command through the existing print runner and streams the resulting summary back to chat.
- Codex `/compact` starts the local `codex app-server` over stdio and sends the native `thread/compact/start` JSON-RPC request; if the native path is unavailable, Studio falls back to its own `ChatContextCompressor`.
- Studio-launched Claude Code now receives `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, and `ENABLE_TOOL_SEARCH` so compaction happens before the 20MB proxy body limit and MCP tool schemas load on demand.
- Studio-launched Codex now writes `[features] tool_search = true` and `tool_search_always_defer_mcp_tools = true` to its scoped config so MCP tools defer when the bundled CLI supports tool search.
