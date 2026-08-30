---
date: 2026-08-22
pr: pending
feature: Issue 1317 external CLI history and continuation
impact: Claude CLI and Codex CLI JSONL sessions now appear in Studio History and can continue through the existing global coding-agent chat route.
---

Native JSONL sessions are synchronized into the local Studio session store with
stable IDs. History sessions retain their native session IDs and workspace, so
the existing global coding-agent launcher can resume them from the Web chat
route.

Parsed JSONL files are cached by path, modification time, and size to avoid
rereading unchanged rollout files on every History request. Imported messages
intentionally include user and assistant text only; tool calls and
provider-specific reasoning are not reconstructed in this phase.
