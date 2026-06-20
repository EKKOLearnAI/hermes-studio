---
date: 2026-06-15
pr: pending
feature: Hermes MCP OpenAPI relay
impact: Model-run auth now writes profile-scoped temporary tokens for the bundled MCP server, and chat/coding-agent runs rely on OpenAPI-guided Hermes API calls instead of embedding bearer tokens in prompts.
---

Bridge, group-chat, and coding-agent runs continue to receive Hermes MCP
guidance, but model-run authentication is now stored in the Web UI profile token
file for the bundled MCP server to read. This avoids placing transient bearer
tokens in model instructions while preserving profile-scoped Hermes API access
for MCP tool calls.
