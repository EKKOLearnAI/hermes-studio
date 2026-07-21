---
date: 2026-07-21
pr: 2158
feature: Claude encrypted-thinking SSE retry
impact: Custom Anthropic-compatible Coding Agent providers now recover when an invalid encrypted-thinking continuation is reported inside a successful HTTP SSE response.
---

The Claude Code proxy inspects only the SSE prelude before any business event is
delivered. A matching encrypted-content error cancels that stream and retries once
with historical opaque thinking removed from the outgoing request; normal response
events, tool history, and the request's top-level thinking configuration are preserved.
