---
date: 2026-08-21
pr: 2648
feature: Runtime-authoritative approval response lifecycle
impact: Direct and group chat approval cards now show submitting, retryable failure, or expired states and close only after the matching runtime approval is confirmed.
---

Bridge and Socket.IO approval resolution events now preserve `resolved`, expiry,
staleness, and error details end to end. Duplicate clicks are blocked while a
response is pending, mismatched approval IDs cannot close another card, and an
expired approval explicitly states that its command will not execute.

Closes #2558.
