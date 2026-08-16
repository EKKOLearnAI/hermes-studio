---
date: 2026-08-15
pr: 2566
feature: CLI-style slash commands for Coding Agent sessions
impact: Studio chat now accepts /context, /compact, /usage, and /status for Codex, Claude Code, and Pi sessions, bridges native compaction, and passes context/auto-compact settings plus lazy MCP tool loading into Studio-launched CLIs.
---

# CLI-style slash commands for Coding Agent sessions

- Adds `/compact` and `/context` to Hermes bridge sessions; `/compact` is an alias of the existing ChatContextCompressor-backed `/compress` path.
- Intercepts `/context`, `/compact`, `/usage`, and `/status` in Coding Agent sessions before input reaches the underlying CLI.
- Claude Code `/compact` runs the native non-interactive compaction command through the existing print runner and streams the resulting summary back to chat.
- Codex `/compact` starts the local `codex app-server` over stdio and sends the native `thread/compact/start` JSON-RPC request.
- Pi `/compact`, `/context`, `/usage`, and `/status` use Pi's native RPC `compact`, `get_session_stats`, and `get_state` commands. Native compaction failures are reported directly because Studio does not own Coding Agent context and cannot safely compact it as a fallback.
- Studio-launched Claude Code now receives `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, and `ENABLE_TOOL_SEARCH` so compaction happens before the 20MB proxy body limit and MCP tool schemas load on demand.
- Studio-launched Codex writes `[features] tool_search = true` to its scoped config when the installed CLI version supports it, and only writes the now-removed `tool_search_always_defer_mcp_tools` flag on versions that still recognize it, so MCP tools defer when the bundled CLI supports tool search.
