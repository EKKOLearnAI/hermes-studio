---
date: 2026-08-08
feature: issue-2401-single-guidance-injection
impact: Bridge runs now send the Studio guidance block once instead of twice, removing about 3,000 duplicated characters from the system message of every request.
pr: 2416
---

# Issue #2401

The chat-run socket composes `getSystemPrompt()` and passes the result to `handleBridgeRun` as `instructions`; `handleBridgeRun` then prepended the same guidance again, so the MCP usage rules and the output-format rules reached the bridge twice, byte for byte, and were persisted that way into `system_prompts`. `handleBridgeRun` has a single caller and that caller always composes, so the inner composition could only ever duplicate. It now composes solely when a caller passes no instructions at all, which keeps that entry point self-sufficient if it ever gains a second caller. No other behaviour changes: callers that pass instructions get exactly what they passed, and the guidance text itself is untouched.
