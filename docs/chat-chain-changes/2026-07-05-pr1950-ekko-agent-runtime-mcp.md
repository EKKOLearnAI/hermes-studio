---
date: 2026-07-05
pr: 1950
feature: Ekko Agent runtime context and MCP tools
impact: Ekko-agent chat runs now use the shared in-memory runtime, carry full request context estimates, and pass managed MCP tools into model requests.
---

Ekko-agent runs now go through a global server-side agent runtime while keeping
session state isolated by session id. The run-chat path resolves the current
profile's managed Hermes Studio MCP servers and passes them into Ekko tool
context, and the Ekko runtime discovers those MCP tools before each model
request.

The chat stream now emits context token estimates for the full model request,
including system prompt, message history, and tool definitions.
