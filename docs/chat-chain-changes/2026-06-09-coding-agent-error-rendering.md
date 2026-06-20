---
date: 2026-06-09
pr: 1440
feature: Coding Agent error rendering
impact: Coding Agent run failures now render nested error details and Windows process stderr instead of opaque object strings.
---

Coding Agent run failures now render readable nested error messages instead of
`[object Object]`. Hidden Claude Code and Codex runs also include the child
process stderr tail on non-zero exits, so Windows command launch failures expose
the underlying `cmd.exe` message in chat.
