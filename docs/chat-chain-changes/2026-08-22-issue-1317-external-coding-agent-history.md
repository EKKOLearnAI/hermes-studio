---
date: 2026-08-22
feature: External Claude CLI and Codex CLI history in Hermes History and Chat
impact: JSONL history is imported into the Web UI session store without writing back to native CLI files. Imported sessions retain their native session id and workspace so the existing coding-agent resume path can continue them from Chat.
---

# External Coding-Agent History

- PR/commit: `codex/close-1317` / Issue #1317
- Compatibility: legacy `coding_agent` sessions remain visible and continueable; external imports use `claude` or `codex` source labels for History filtering.
